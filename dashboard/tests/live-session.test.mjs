import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';

const compile = async name => ts.transpileModule(await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const asUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const sessionUrl = asUrl(await compile('session'));
const adapter = (await compile('live-session')).replace(/from ['"]\.\/session['"]/, `from '${sessionUrl}'`);
const { LiveSessionBuffer } = await import(asUrl(adapter));
const { validateLiveFrame } = await import(asUrl(await compile('live-frame')));
const { ReplaySimulation: SimulationBase } = await import(asUrl(await compile('replay-simulation')));
class ReplaySimulation extends SimulationBase { constructor(options={}) { super({...options,latency:'constant'}); } }
const { tradeCandles } = await import(asUrl(await compile('candles')));
const { observedTradeStats } = await import(asUrl(await compile('chart-stats')));
test('chart volume, delta and VWAP use only valid observed prints in the requested window', () => {
  const result=observedTradeStats([0,1,2,3,4,5],[90,100,102,104,106,999],[9,2,3,1,0,100],[1,1,-1,1,1,1],1,4);
  assert.equal(result.count,3);
  assert.equal(result.volume,6);
  assert.equal(result.buy,3);
  assert.equal(result.sell,3);
  assert.equal(result.delta,0);
  assert.equal(result.vwapTick,610/6);
  assert.equal(result.lowTick,100);
  assert.equal(result.highTick,104);
  assert.ok(Number.isNaN(observedTradeStats([],[],[],[],0,1).vwapTick));
});
test('trade candles retain observed OHLC, leave gaps empty and exclude future trades', () => {
  assert.deepEqual(tradeCandles([0,1,2,4,15,16,30],[100,103,98,101,102,104,999],0,16,5),[
    {time:0,open:100,high:103,low:98,close:101},
    {time:15,open:102,high:104,low:102,close:104}
  ]);
  assert.deepEqual(tradeCandles([],[],0,60,5),[]);
  assert.equal(tradeCandles([3,4],[100,101],0,4,5,2)[0].time,3);
});
const trade = (sequence, timeMs, side = 'sell', quantity = 1) => ({ sequence, timeMs, side, price: side === 'sell' ? 100 : 100.25, quantity });
const frame = (trades, overrides = {}) => ({ version: 1, connected: true, delaySeconds: 7.5,
  symbol: 'MNQZ26-CME', replay: false, publishedMs: 10000, tickSize: .25, last: 100,
  bids: [[100, 2, 1], [99.75, 4, 2]], asks: [[100.25, 2, 1], [100.5, 4, 2]], trades, ...overrides });

test('liquidity queues and strategy metadata reach the shared original panels', () => {
  const sim = new ReplaySimulation({allowLive: true, strategy: 'liquidity', levels: 3});
  const buffer = new LiveSessionBuffer();
  const data = frame([trade(1, 1000)], {
    bids: [[100, 1, 1], [99, 2, 1], [98.5, 3, 1], [98, 4, 1]],
    asks: [[100.25, 1, 1], [101, 2, 1], [101.5, 3, 1], [102, 4, 1]],
  });
  sim.accept(data, true);
  let session = buffer.accept(data, sim.snapshot(), 10050);
  assert.equal(session.meta.strategy.kind, 'liquidity');
  assert.equal(session.meta.strategy.grid_num, 3);
  assert.equal(session.oId.length, 6);
  assert.equal(session.eKind.length, 6);
  assert.equal([...session.oSide].filter(s => s === 1).length, 3);
  sim.configure({strategy: 'queue', levels: 1});
  sim.accept({...data, publishedMs: 10300}, true);
  session = buffer.accept({...data, publishedMs: 10300}, sim.snapshot(), 10350);
  assert.equal(session.nFrames, 1);
  assert.equal(session.oId.length, 2);
  assert.equal(session.meta.strategy.kind, 'queue');
});

test('live paper mode is explicit, seeds after retained trades, then fills from later volume', () => {
  const sim = new ReplaySimulation({ allowLive: true });
  sim.accept(frame([trade(1, 1000, 'sell', 100)]), true);
  assert.equal(sim.snapshot().mode, 'sampled-live-paper');
  assert.equal(sim.snapshot().fillCount, 0);
  sim.accept(frame([trade(1, 1000), trade(2, 1005, 'sell', 100)]), true);
  assert.equal(sim.snapshot().fillCount, 0, 'entry delay excludes early prints');
  sim.accept(frame([trade(2, 1005), trade(3, 1011, 'sell', 3)]), true);
  sim.accept(frame([trade(4,1021,'sell',1)]),true);
  const state = sim.snapshot();
  assert.equal(state.fillCount, 1);
  assert.equal(state.position, 1);
  assert.ok(state.events.some(e => e.kind === 2 && e.exchangeMs === 1010 && e.timeMs === 1020));
  assert.ok(state.events.some(e => e.kind === 3 && e.exchangeMs === 1011 && e.timeMs === 1021));
});

test('feed interruption discards old quotes and resumed buffered prints cannot fill them', () => {
  const sim = new ReplaySimulation({ allowLive: true });
  sim.accept(frame([trade(1, 1000)]), true);
  sim.accept(frame([trade(2, 1011, 'sell', 3)]), true);
  sim.accept(frame([trade(3,1021,'sell',1)]),true);
  const previous = sim.snapshot();
  sim.suspend();
  assert.ok(sim.snapshot().orders.every(o => o.state !== 'working' && o.state !== 'pending'));
  sim.accept(frame([trade(100, 2000, 'buy', 100)]), true);
  assert.equal(sim.snapshot().fillCount, previous.fillCount);
  assert.equal(sim.snapshot().position, previous.position);
});

test('live adapter supplies identical replay panel arrays, actual sizes and measured snapshot age', () => {
  const sim = new ReplaySimulation({ allowLive: true });
  const buffer = new LiveSessionBuffer();
  const first = frame([trade(1, 1000)]);
  sim.accept(first, true);
  buffer.accept(first, sim.snapshot(), 10025);
  const next = frame([trade(1, 1000), trade(2, 1011, 'sell', 3),trade(3,1021,'sell',1)], { publishedMs: 10300 });
  sim.accept(next, true);
  const session = buffer.accept(next, sim.snapshot(), 10340);
  assert.equal(session.nFrames, 2);
  assert.equal(session.bookAt(1).bids.get(400), 2);
  assert.equal(session.bookAt(1).asks.get(401), 2);
  assert.equal(session.feedMean[1], 40);
  assert.equal(session.position[1], 1);
  assert.equal(session.fillEvents.length, 1);
  assert.equal(session.lives.find(l => l.outcome === 'filled').frontAtAck, 2);
  assert.equal(session.meta.live.sim.fillCount, 1);
  assert.equal(session.collector.streams['book snapshots'], 2);
  assert.equal(session.collector.streams.trade, 2);
  const duplicate = buffer.accept(next, sim.snapshot(), 10400);
  assert.equal(duplicate.nFrames, 2);
  assert.equal(duplicate.collector.streams.trade, 2);
});

test('reset and source-mode changes clear the panel timeline and future fills', () => {
  const sim = new ReplaySimulation({ allowLive: true });
  const buffer = new LiveSessionBuffer();
  const first = frame([trade(1, 1000)]);
  sim.accept(first, true); buffer.accept(first, sim.snapshot(), 10025);
  const filled = frame([trade(2, 1011, 'sell', 3),trade(3,1021,'sell',1)], { publishedMs: 10300 });
  sim.accept(filled, true); buffer.accept(filled, sim.snapshot(), 10340);
  const changed = frame([trade(1, 500)], { replay: true, publishedMs: 10600 });
  sim.accept(changed, true);
  const session = buffer.accept(changed, sim.snapshot(), 10620);
  assert.equal(session.nFrames, 1);
  assert.equal(session.fillEvents.length, 0);
  assert.equal(session.meta.live.sim.position, 0);
});

test('invalid quantities are removed without generating replacement liquidity', () => {
  const clean = validateLiveFrame(frame([], { bids: [[100, Infinity, 1], [99.75, 3, 1]] }));
  assert.deepEqual(clean.bids, [[99.75, 3, 1]]);
  assert.throws(() => validateLiveFrame(frame([], { tickSize: 0 })), /invalid/);
});

test('an empty startup publication does not put later delayed trades on a backward chart axis', () => {
  const sim = new ReplaySimulation({ allowLive: true });
  const buffer = new LiveSessionBuffer();
  const empty = frame([]);
  sim.accept(empty, true); buffer.accept(empty, sim.snapshot(), 10020);
  const trading = frame([trade(1, 1000)], { publishedMs: 10300 });
  sim.accept(trading, true);
  const session = buffer.accept(trading, sim.snapshot(), 10320);
  assert.equal(session.nFrames, 1);
  assert.ok(session.frameT[0] >= 0);
  assert.equal(session.collector.streams['book snapshots'], 1);
  assert.equal(session.fillEvents.length, 0);
});

