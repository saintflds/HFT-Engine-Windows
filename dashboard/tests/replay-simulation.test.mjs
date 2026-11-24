import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/replay-simulation.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { ReplaySimulation: SimulationBase } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
class ReplaySimulation extends SimulationBase { constructor(options={}) { super({...options,latency:'constant'}); } }
const trade = (sequence, timeMs, side = 'sell', price = 100, quantity = 1) => ({ sequence:Math.round(sequence*10), timeMs, side, price, quantity });
const frame = (trades, overrides = {}) => ({ symbol: 'MNQZ26-CME', replay: true, publishedMs: 10000,
  tickSize: 0.25, last: trades.at(-1)?.price ?? 100, bids: [[100, 2, 1]], asks: [[100.25, 2, 1]], trades, ...overrides });
const receipt=(sim,seq,time,extra={},price=100)=>sim.accept(frame([trade(seq,time,'buy',price,1)],extra),true);
const seeded = () => { const sim = new ReplaySimulation(); sim.accept(frame([trade(1, 1000)]), true); return sim; };

test('initial snapshot seeds future orders and cannot fill from historical prints or wall-clock publications', () => {
  const sim = new ReplaySimulation();
  const initial = frame([trade(1, 900, 'sell', 90, 100), trade(2, 1000, 'buy', 110, 100)]);
  sim.accept(initial, true);
  const before = sim.snapshot();
  assert.equal(before.submits, 2);
  assert.equal(before.fills.length, 0);
  assert.equal(before.position, 0);
  assert.ok(before.orders.every(o => o.activeMs === 1010 && o.state === 'pending'));
  sim.accept({ ...initial, publishedMs: 999999 }, true);
  assert.deepEqual(sim.snapshot(), before, 'a repeated source snapshot cannot advance order timers or P&L');
});

test('entry latency and opposing print volume consume queue before a one-contract fill', () => {
  const sim = seeded();
  sim.accept(frame([trade(2, 1005, 'sell', 100, 50)]), true);
  assert.equal(sim.snapshot().orders.find(o => o.side === 'buy').ahead, 2);
  sim.accept(frame([trade(3, 1010, 'sell', 100, 2)]), true);
  assert.equal(sim.snapshot().fills.length, 0);
  assert.equal(sim.snapshot().orders.find(o => o.side === 'buy').ahead, 0);
  sim.accept(frame([trade(4, 1011, 'sell', 100, 100)]), true);
  receipt(sim,sim.snapshot().timeMs===1011?4.1:2.1,sim.snapshot().timeMs+10,sim.snapshot().timeMs===2010?{bids:[[102,1,1]],asks:[[102.25,1,1]]}:{},sim.snapshot().timeMs===2010?102:100);
  const state = sim.snapshot();
  assert.equal(state.fills.length, 1);
  assert.equal(state.fills[0].qty, 1, 'observed volume cannot overfill the order');
  assert.equal(state.position, 1);
  assert.equal(state.fees, 0.75);
  assert.equal(state.equity, -0.75);
  assert.equal(state.fills[0].responseMs, 1021);
});

test('a batch uses previously submitted quotes, never its future book snapshot to fill earlier trades', () => {
  const sim = seeded();
  sim.accept(frame([trade(2, 2010, 'buy', 102, 3)], { bids: [[102, 1, 1]], asks: [[102.25, 1, 1]] }), true);
  receipt(sim,sim.snapshot().timeMs===1011?4.1:2.1,sim.snapshot().timeMs+10,sim.snapshot().timeMs===2010?{bids:[[102,1,1]],asks:[[102.25,1,1]]}:{},sim.snapshot().timeMs===2010?102:100);
  const state = sim.snapshot();
  assert.equal(state.fills.length, 1);
  assert.equal(state.fills[0].price, 100.25, 'only the old resting ask was eligible');
  assert.equal(state.position, -1);
  assert.equal(state.unrealized, -3.5);
  assert.equal(state.equity, -4.25);
});

test('MNQ round-trip accounting uses $2 per point and charges both sides; inventory stays bounded', () => {
  const sim = seeded();
  const prints = [trade(2, 1010, 'sell', 100, 100), trade(3, 1020, 'sell', 100, 100),
    trade(4, 1030, 'buy', 100.25, 100), trade(5, 1040, 'buy', 100.25, 100)];
  sim.accept(frame(prints), true);
  const state = sim.snapshot();
  assert.equal(state.fills.length, 2);
  assert.equal(state.buyFillQty, 1);
  assert.equal(state.sellFillQty, 1);
  assert.equal(state.position, 0);
  assert.equal(state.realized, 0.5);
  assert.equal(state.fees, 1.5);
  assert.equal(state.unrealized, 0);
  assert.equal(state.cash, -1);
  assert.equal(state.equity, state.realized + state.unrealized - state.fees);
  sim.accept(frame(prints, { publishedMs: 11000 }), true);
  assert.equal(sim.snapshot().fills.length, 2, 'overlapping polls must deduplicate executions');
});

test('rewind and empty replay transitions reset the account rather than retaining future fills', () => {
  const sim = seeded();
  sim.accept(frame([trade(2, 1010, 'sell', 100, 3)]), true);
  receipt(sim,2.1,1020);
  assert.equal(sim.snapshot().fills.length, 1);
  sim.accept(frame([]), true);
  assert.equal(sim.snapshot().fills.length, 0);
  assert.equal(sim.snapshot().position, 0);
  sim.accept(frame([trade(100, 500)]), true);
  assert.equal(sim.snapshot().sourceTimeMs, 500);
  assert.equal(sim.snapshot().fills.length, 0);
  sim.accept(frame([trade(101, 100)]), true);
  assert.equal(sim.snapshot().sourceTimeMs, 100, 'time rewind resets even when sequence increases');
  assert.equal(sim.snapshot().fees, 0);
});

test('a non-overlapping full sample discards uncertain paper orders without inventing fills', () => {
  const sim = seeded();
  const prints = Array.from({ length: 100 }, (_, i) => trade(100 + i, 2000 + i, 'sell', 100, 100));
  sim.accept(frame(prints), true);
  const state = sim.snapshot();
  assert.equal(state.dataGaps, 1);
  assert.equal(state.fills.length, 0);
  assert.equal(state.position, 0);
  assert.ok(state.orders.filter(o => o.state === 'pending').every(o => o.activeMs > 2099));
});

test('sequence skips alone do not count unexported quote updates as missing trades', () => {
  const sim = seeded();
  sim.accept(frame([trade(1, 1000), trade(9, 1010, 'sell', 100, 3)]), true);
  receipt(sim,9.1,1020);
  assert.equal(sim.snapshot().dataGaps, 0);
  assert.equal(sim.snapshot().fills.length, 1);
  assert.ok(sim.snapshot().logs.some(l => l.message.includes('non-trade')));
});

test('off and real-time mode cannot trade, and explicit reset starts a clean account', () => {
  const sim = seeded();
  sim.accept(frame([trade(2, 1010, 'sell', 100, 3)]), false);
  assert.equal(sim.snapshot().status, 'off');
  assert.equal(sim.snapshot().position, 0);
  sim.accept(frame([trade(3, 1020, 'sell', 100, 100)], { replay: false }), true);
  assert.equal(sim.snapshot().orders.length, 0);
  assert.equal(sim.snapshot().fills.length, 0);
  sim.accept(frame([trade(4, 1030)]), true);
  assert.equal(sim.snapshot().submits, 2);
  sim.reset();
  assert.equal(sim.snapshot().submits, 0);
  assert.equal(sim.snapshot().equity, 0);
});

test('another contract or tick size cannot use MNQ cash values', () => {
  for (const overrides of [{ symbol: 'NQZ26-CME' }, { symbol: 'ESZ26-CME' }, { tickSize: 1 }]) {
    const sim = seeded();
    sim.accept(frame([trade(2, 1010, 'sell', 100, 100)], overrides), true);
    assert.equal(sim.snapshot().status, 'off');
    assert.equal(sim.snapshot().fills.length, 0);
    assert.equal(sim.snapshot().equity, 0);
  }
});

const depth = { bids: [[100, 2, 1], [99.75, 3, 1], [99.5, 10, 1], [99, 15, 1], [98.5, 20, 1], [98, 12, 1]],
  asks: [[100.25, 2, 1], [100.5, 3, 1], [101, 10, 1], [101.5, 15, 1], [102, 20, 1], [102.5, 12, 1]] };
const zones = (overrides = {}) => {
  const sim = new ReplaySimulation({ strategy: 'liquidity', levels: 3, allowLive: true });
  sim.accept(frame([trade(1, 1000)], { ...depth, ...overrides }), true);
  return sim;
};
test('execution reasons follow the submitted order through fills and protective exits', () => {
  const sim = zones();
  assert.ok(sim.snapshot().events.filter(e=>e.side==='buy').every(e=>e.reason==='DMD'));
  assert.ok(sim.snapshot().events.filter(e=>e.side==='sell').every(e=>e.reason==='SUP'));
  sim.accept(frame([trade(2,1010,'sell',99,100)],depth),true);
  receipt(sim,2.1,1020,depth,99);
  assert.equal(sim.snapshot().events.find(e=>e.kind===3).reason,'DMD');
  sim.accept(frame([trade(3,1020,'sell',90,1)],depth),true);
  sim.accept(frame([trade(4,1030,'sell',90,1)],depth),true);
  receipt(sim,4.1,1040,depth,90);
  assert.equal(sim.snapshot().events.filter(e=>e.kind===3).at(-1).reason,'STOP');
  const timed=zones();
  timed.accept(frame([trade(2,1010,'sell',99,100)],depth),true);
  timed.accept(frame([trade(3,61010,'sell',99,1)],depth),true);
  assert.equal(timed.snapshot().events.find(e=>e.market && e.kind===1).reason,'TIME');
});
test('liquidity strategy queues three observed levels per side outside the fee buffer', () => {
  const sim = zones(), state = sim.snapshot();
  assert.equal(state.orders.length, 6);
  for (const side of ['buy', 'sell']) {
    const orders = state.orders.filter(o => o.side === side);
    assert.equal(orders.length, 3);
    const observed = side === 'buy' ? depth.bids : depth.asks;
    assert.ok(orders.every(o => observed.some(l => l[0] === o.price && l[1] === o.ahead)));
  }
  const bid = Math.max(...state.orders.filter(o => o.side === 'buy').map(o => o.price));
  const ask = Math.min(...state.orders.filter(o => o.side === 'sell').map(o => o.price));
  assert.ok((ask - bid) * 2 > 2 * state.feePerContract);
  assert.equal(state.fills.length, 0);
  assert.equal(state.maxPosition, 1);
});
test('liquidity model waits when top quotes provide no eligible supply/demand depth', () => {
  const sim = zones({ bids: [[100, 1, 1]], asks: [[100.25, 1, 1]] });
  assert.equal(sim.snapshot().orders.length, 0);
  assert.match(sim.snapshot().decision, /Waiting for depth/);
});
test('explicit live simulation works without changing the default replay-only model', () => {
  const sim = zones({ replay: false });
  assert.equal(sim.snapshot().orders.length, 6);
  assert.equal(sim.snapshot().fills.length, 0);
  sim.accept(frame([trade(2, 1010)], { ...depth, replay: false }), false);
  assert.equal(sim.snapshot().status, 'off');
});
test('multiple queues consume each print once and cannot exceed the position cap', () => {
  const sparse = { bids: [[100, 1, 1], [99, 1, 1], [98.5, 1, 1], [98, 1, 1]],
    asks: [[100.25, 1, 1], [101, 1, 1], [101.5, 1, 1], [102, 1, 1]] };
  const sim = zones(sparse);
  sim.accept(frame([trade(2, 1010, 'sell', 98, 2)], sparse), true);
  receipt(sim,2.1,1020,sparse,99);
  assert.equal(sim.snapshot().fills.length, 1, 'one contract ahead plus one fill uses all two contracts');
  assert.equal(sim.snapshot().fills[0].price, 99, 'best buy price gets priority');
  assert.equal(sim.snapshot().position, 1);
  sim.accept(frame([trade(3, 1021, 'sell', 98, 500)], sparse), true);
  assert.equal(sim.snapshot().buyFillQty, 1);
});
test('protective exit waits for latency, includes adverse slippage and retains real losses', () => {
  const sparse = { bids: [[100, 1, 1], [99, 1, 1], [98.5, 1, 1], [98, 1, 1]],
    asks: [[100.25, 1, 1], [101, 1, 1], [101.5, 1, 1], [102, 1, 1]] };
  const sim = zones(sparse);
  sim.accept(frame([trade(2, 1010, 'sell', 99, 2)], sparse), true);
  sim.accept(frame([trade(3, 1020, 'sell', 95, 1)], sparse), true);
  assert.equal(sim.snapshot().position, 1);
  assert.ok(sim.snapshot().orders.some(o => o.market && o.activeMs === 1030));
  sim.accept(frame([trade(4, 1025, 'sell', 95, 1)], sparse), true);
  assert.equal(sim.snapshot().position, 1);
  sim.accept(frame([trade(5, 1030, 'sell', 95, 1)], sparse), true);
  receipt(sim,5.1,1040,sparse,95);
  const state = sim.snapshot();
  assert.equal(state.position, 0);
  assert.equal(state.fills[0].price, 94.75);
  assert.equal(state.realized, -8.5);
  assert.equal(state.fees, 1.5);
  assert.equal(state.equity, -10);
  assert.equal(state.equity, state.realized + state.unrealized - state.fees);
});
test('changing to a backwards source resets liquidity orders and sampled P&L', () => {
  const sim = zones();
  sim.accept(frame([trade(2, 1500)], depth), true);
  sim.accept(frame([trade(1, 900)], depth), true);
  assert.equal(sim.snapshot().sourceTimeMs, 900);
  assert.equal(sim.snapshot().fees, 0);
  assert.equal(sim.snapshot().orders.length, 6);
});

test('liquidity orders retain submit, ack, cancellation and protective fill events for the original panels', () => {
  const sim = zones();
  assert.equal(sim.snapshot().events.filter(e => e.kind === 1).length, 6);
  sim.accept(frame([trade(2, 1010, 'sell', 99, 100)], depth), true);
  receipt(sim,2.1,1020,depth,99);
  let state = sim.snapshot();
  assert.equal(state.events.filter(e => e.kind === 2).length, 6);
  assert.equal(state.events.filter(e => e.kind === 3).length, 1);
  assert.equal(state.events.filter(e => e.kind === 4).length, 5);
  sim.accept(frame([trade(3, 1020, 'sell', 90, 1)], depth), true);
  sim.accept(frame([trade(4, 1030, 'sell', 90, 1)], depth), true);
  receipt(sim,4.1,1040,depth,90);
  state = sim.snapshot();
  const exit = state.events.find(e => e.market && e.kind === 3);
  assert.ok(exit);
  assert.equal(exit.price, 89.75);
  assert.equal(exit.exchangeMs, 1030);
  assert.equal(exit.timeMs, 1040);
  assert.ok(state.events.some(e => e.kind === 1 && e.orderId === exit.orderId));
  assert.ok(state.events.some(e => e.kind === 2 && e.orderId === exit.orderId));
});

test('liquidity short positions use an observed buy target and a symmetric adverse stop', () => {
  const sim = zones();
  sim.accept(frame([trade(2, 1010, 'buy', 103, 100)], depth), true);
  receipt(sim,2.1,1020,depth,101);
  assert.equal(sim.snapshot().position, -1);
  sim.accept(frame([trade(3, 1020, 'buy', 101, 1)], depth), true);
  sim.accept(frame([trade(4, 4020, 'buy', 101, 1)], depth), true);
  let state = sim.snapshot();
  assert.ok(state.orders.some(o => o.role === 'exit' && o.side === 'buy' && o.price <= 99 && o.state === 'pending'));
  sim.accept(frame([trade(5, 4030, 'buy', 105, 1)], depth), true);
  sim.accept(frame([trade(6, 4040, 'buy', 105, 1)], depth), true);
  receipt(sim,6.1,4050,depth,105);
  state = sim.snapshot();
  assert.equal(state.position, 0);
  assert.equal(state.fills[0].price, 105.25);
  assert.ok(state.equity < 0);
});

test('hold limit uses source time and configuration clears the account and panel generation', () => {
  const sim = zones();
  sim.accept(frame([trade(2, 1010, 'sell', 99, 100)], depth), true);
  sim.accept(frame([trade(3, 61010, 'sell', 99, 1)], depth), true);
  assert.match(sim.snapshot().decision, /60-second/);
  assert.ok(sim.snapshot().orders.some(o => o.market && o.activeMs === 61020));
  const generation = sim.snapshot().generation;
  sim.configure({strategy: 'liquidity', levels: 5});
  assert.equal(sim.snapshot().generation, generation + 1);
  assert.equal(sim.snapshot().position, 0);
  assert.equal(sim.snapshot().fees, 0);
  assert.equal(sim.snapshot().events.length, 0);
  assert.equal(sim.snapshot().levelsPerSide, 5);
});

