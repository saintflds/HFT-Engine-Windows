// Constructed execution-model tests, added 2026-11-07.
// These drive the paper engine with SYNTHETIC frames only: they verify the
// execution model (queue consumption, latency, cancel/fill races) in isolation.
// They are NOT evidence of profitability on recorded markets; no recorded
// tape, no P&L claim, no strategy parameters are touched here.
//
// Timing rules exercised here (all from the unchanged engine code):
//  - a quote becomes active 10 ms after creation (constant-latency mode);
//  - a cancel requested at T becomes effective at T + 10 ms (constant mode);
//  - the liquidity strategy re-quotes at most every 3000 ms of source time.
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/replay-simulation.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { ReplaySimulation: Base, modeledDelay } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
class ReplaySimulation extends Base { constructor(options = {}) { super({ ...options, latency: 'constant' }); } }
const trade = (sequence, timeMs, side = 'sell', price = 100, quantity = 1) => ({ sequence:Math.round(sequence*10), timeMs, side, price, quantity });
// Book whose only eligible zone levels are a bid at 99 (ahead 5) and an ask at
// 101.25 (ahead 5); mid = 100.125, both sit 4.5 ticks from mid (inside 3-32t).
const book = { bids: [[100, 2, 1], [99, 5, 1]], asks: [[100.25, 2, 1], [101.25, 5, 1]] };
const moved = { bids: [[98.5, 4, 1], [97.5, 6, 1]], asks: [[100.5, 4, 1], [101.5, 6, 1]] };
const frame = (trades, overrides = {}) => ({ symbol: 'MNQZ26-CME', replay: true, publishedMs: 10000,
  tickSize: 0.25, last: trades.at(-1)?.price ?? 100, bids: book.bids, asks: book.asks, trades, ...overrides });
const receipt=(sim,seq,time,extra={},price=100)=>sim.accept(frame([trade(seq,time,'buy',price,1)],extra),true);
const zones = () => { const sim = new ReplaySimulation({ strategy: 'liquidity', levels: 3 }); sim.accept(frame([trade(1, 1000)]), true); return sim; };

test('a print that reaches the quote before the modeled cancel becomes effective still fills (fill wins the race)', () => {
  const sim = zones();
  let state = sim.snapshot();
  const buy = state.orders.find(o => o.side === 'buy');
  assert.equal(buy.price, 99); assert.equal(buy.ahead, 5);
  // t=4050 (>= 3000 ms after the seed quote): book moves, engine cancels the
  // 99 bid and re-quotes; the cancel becomes effective at 4060.
  sim.accept(frame([trade(2, 4050, 'buy', 98.5, 1)], { bids: moved.bids, asks: moved.asks }), true);
  state = sim.snapshot();
  const target = state.orders.find(o => o.id === buy.id);
  assert.equal(target.cancelMs, 4060, 'cancel is pending, not yet effective');
  assert.equal(target.state, 'canceling');
  // t=4055 (before 4060): a sell print trades the 99 bid with enough volume to
  // clear its 5-contract queue. The order is still working, so it must fill.
  sim.accept(frame([trade(3, 4055, 'sell', 99, 6)], { bids: moved.bids, asks: moved.asks }), true);
  receipt(sim,3.1,4065,{bids:moved.bids,asks:moved.asks},99);
  state = sim.snapshot();
  assert.equal(state.fills.length, 1, 'fill inside the cancel window must win');
  assert.equal(state.fills[0].price, 99);
  assert.equal(state.position, 1);
  assert.equal(state.fees, 0.75);
  assert.equal(state.orders.find(o => o.id === buy.id).state, 'filled');
});

test('a print arriving after the modeled cancel becomes effective cannot fill the canceled quote', () => {
  const sim = zones();
  const buy = sim.snapshot().orders.find(o => o.side === 'buy');
  sim.accept(frame([trade(2, 4050, 'buy', 98.5, 1)], { bids: moved.bids, asks: moved.asks }), true);
  // t=4300: cancel became effective at 4060; the late sell print must not trade it.
  sim.accept(frame([trade(3, 4300, 'sell', 99, 10)], { bids: moved.bids, asks: moved.asks }), true);
  const state = sim.snapshot();
  assert.equal(state.fills.length, 0, 'canceled quote cannot fill after cancellation');
  assert.equal(state.position, 0);
  assert.equal(state.orders.find(o => o.id === buy.id).state, 'canceled');
});

test('queue depletion is exact: cumulative volume equal to ahead fills nothing; the next print fills one', () => {
  const sim = zones();
  const id = sim.snapshot().orders.find(o => o.side === 'buy').id;
  // t=1015: the quote is active (created 1000 + 10 ms entry latency);
  // 5 opposing contracts clear the 5-contract queue but leave none to fill.
  sim.accept(frame([trade(2, 1015, 'sell', 99, 5)]), true);
  let state = sim.snapshot();
  assert.equal(state.fills.length, 0, 'volume equal to the queue ahead fills nothing');
  assert.equal(state.orders.find(o => o.id === id).ahead, 0);
  sim.accept(frame([trade(3, 1020, 'sell', 99, 1)]), true);
  receipt(sim,3.1,1030,{},99);
  state = sim.snapshot();
  assert.equal(state.fills.length, 1, 'the following print fills exactly the one-contract order');
  assert.equal(state.fills[0].qty, 1);
  assert.equal(state.position, 1);
});

test('opposing prints that do not reach the quote price never consume its queue', () => {
  const sim = zones();
  const id = sim.snapshot().orders.find(o => o.side === 'buy').id;
  // A sell print at 100 trades the top of the book, not the 99 bid.
  sim.accept(frame([trade(2, 1015, 'sell', 100, 50)]), true);
  // A buy print is same-side and cannot consume the bid's queue either.
  sim.accept(frame([trade(3, 1020, 'buy', 99, 50)]), true);
  const state = sim.snapshot();
  assert.equal(state.fills.length, 0);
  assert.equal(state.orders.find(o => o.id === id).ahead, 5, 'queue ahead is untouched by non-reaching prints');
});

test('with the variable latency model, a print inside the modeled cancel delay still fills', () => {
  const sim = new Base({ strategy: 'liquidity', levels: 3, allowLive: true, latency: 'variable' });
  sim.accept(frame([trade(1, 1000)]), true);
  const buy = sim.snapshot().orders.find(o => o.side === 'buy');
  assert.equal(buy.price, 99);
  sim.accept(frame([trade(2, 4050, 'buy', 98.5, 1)], { bids: moved.bids, asks: moved.asks }), true);
  const pending = sim.snapshot().orders.find(o => o.id === buy.id);
  assert.ok(pending.cancelMs > 4050 && pending.cancelMs <= 4050 + 60, 'variable cancel delay is bounded 4-60 ms');
  const delay = pending.cancelMs - 4050;
  const printTime = 4050 + Math.max(1, Math.round(delay / 2));
  assert.ok(Math.abs(modeledDelay(4050 + Number(buy.id.slice(4)) * 7919, 4) - delay) < 1e-9, 'delay reproduces from the model');
  sim.accept(frame([trade(3, printTime, 'sell', 99, 6)], { bids: moved.bids, asks: moved.asks }), true);
  receipt(sim,3.1,Math.max(sim.snapshot().timeMs+100,4400),{bids:moved.bids,asks:moved.asks},99);
  const state = sim.snapshot();
  assert.equal(state.fills.length, 1, 'the fill lands inside the variable cancel window');
  assert.equal(state.fills[0].price, 99);
  assert.equal(state.position, 1);
  assert.equal(state.orders.find(o => o.id === buy.id).state, 'filled');
});
