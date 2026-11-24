import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
import * as engine from '../server/engine.mjs';

const compile = async name => ts.transpileModule(await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const asUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const sessionUrl = asUrl(await compile('session'));
const { Session } = await import(sessionUrl);
const { parseHbr } = await import(asUrl(await compile('hbr')));
const { ReplaySimulation: SimulationBase } = await import(asUrl(await compile('replay-simulation')));
class ReplaySimulation extends SimulationBase { constructor(options={}) { super({...options,latency:'constant'}); } }
const { LiveSessionBuffer } = await import(asUrl((await compile('live-session')).replace(/from ['"]\.\/session['"]/, `from '${sessionUrl}'`)));
const trade = (sequence, timeMs, side = 'sell', quantity = 3) => ({ sequence, timeMs, side, price: side === 'sell' ? 100 : 100.25, quantity });
const frame = (trades, publishedMs = 10000) => ({ version: 1, connected: true, delaySeconds: 7.5,
  symbol: 'MNQZ26-CME', replay: false, publishedMs, tickSize: .25, last: 100,
  bids: [[100, 2, 1], [99.75, 4, 2]], asks: [[100.25, 2, 1], [100.5, 4, 2]], trades });

test('frame selection follows actual times across gaps, duplicate times and rolling offsets', () => {
  const lookup = (times, time) => Session.prototype.frameAt.call({ frameT: Float64Array.from(times), nFrames: times.length, frameNs: 300e6 }, time);
  assert.equal(lookup([1e9, 4e9, 10e9], 3e9), 0);
  assert.equal(lookup([120e9, 121e9, 125e9], 121e9), 1);
  assert.equal(lookup([120e9, 121e9, 125e9], 124e9), 1);
  assert.equal(lookup([1e9, 1e9, 2e9], 1e9), 1);
  assert.equal(lookup([1e9, 4e9], -1), 0);
  assert.equal(lookup([1e9, 4e9], Infinity), 1);
  assert.equal(lookup([], 0), 0);
});

test('an empty live tape preserves inventory, fees and fills and reseeds before resuming', () => {
  const sim = new ReplaySimulation({ allowLive: true });
  sim.accept(frame([trade(1, 1000)]), true);
  sim.accept(frame([trade(1, 1000), trade(2, 1011),trade(3,1021)]), true);
  const previous = sim.snapshot();
  assert.equal(previous.fillCount, 1);
  sim.accept(frame([], 10300), true);
  const empty = sim.snapshot();
  for (const key of ['position', 'fees', 'cash', 'fillCount', 'generation']) assert.equal(empty[key], previous[key], key);
  assert.ok(empty.orders.every(o => !['working', 'pending', 'canceling'].includes(o.state)));
  sim.accept(frame([trade(10, 2000, 'buy', 100)], 10600), true);
  assert.equal(sim.snapshot().fillCount, previous.fillCount, 'the resumed buffer cannot fill new quotes');
});

test('repeated historical jobs get distinct result paths', () => {
  const first = engine.makeSessionName('MNQZ26-CME', '2026-10-23', '13:30', 'depth', 'queue');
  const second = engine.makeSessionName('MNQZ26-CME', '2026-10-23', '13:30', 'depth', 'queue');
  assert.notEqual(first, second);
  assert.match(first, /^mnqz26_20261023_1330_depth_queue_[a-f0-9]{32}$/);
  assert.ok(first.length <= 80);
});

test('archive polling shares concurrent scans and refreshes after expiry', async () => {
  let now = 100, calls = 0;
  const inventory = engine.cachedInventory(async symbol => ({ symbol, scan: ++calls }), () => now);
  const first = await Promise.all([inventory('MNQZ26-CME'), inventory('MNQZ26-CME')]);
  assert.equal(calls, 1);
  assert.equal(first[0], first[1]);
  await inventory('MNQZ26-CME'); assert.equal(calls, 1);
  await inventory('MNQM26-CME'); assert.equal(calls, 2);
  now += 30001;
  await inventory('MNQZ26-CME'); assert.equal(calls, 3);
});

test('a failed archive scan can be retried instead of caching the failure', async () => {
  let calls = 0;
  const inventory = engine.cachedInventory(async () => { if (++calls === 1) throw Error('drive busy'); return 42; });
  await assert.rejects(inventory('MNQZ26-CME'), /drive busy/);
  assert.equal(await inventory('MNQZ26-CME'), 42);
});

function recording(descriptors, bytes = Buffer.alloc(8)) {
  const header = Buffer.from(JSON.stringify({ meta: {}, arrays: descriptors }));
  const start = Math.ceil((12 + header.length) / 8) * 8;
  const buffer = Buffer.alloc(start + bytes.length);
  buffer.write('HFTREC01'); buffer.writeUInt32LE(header.length, 8); header.copy(buffer, 12); bytes.copy(buffer, start);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
const descriptor = { name: 'frame_t', dtype: 'f64', shape: [1], offset: 0, length: 8 };

test('replay loader accepts valid data and rejects incomplete headers clearly', () => {
  assert.equal(parseHbr(recording([descriptor])).arrays.get('frame_t').data.length, 1);
  assert.throws(() => parseHbr(new ArrayBuffer(4)), /Incomplete replay/);
  const incomplete = recording([descriptor]); new DataView(incomplete).setUint32(8, 999999, true);
  assert.throws(() => parseHbr(incomplete), /truncated header/);
});

test('replay loader rejects mismatched shapes, duplicate arrays, unknown types and invalid ranges', () => {
  assert.throws(() => parseHbr(recording([{ ...descriptor, shape: [2] }])), /shape/);
  assert.throws(() => parseHbr(recording([descriptor, descriptor])), /duplicate/);
  assert.throws(() => parseHbr(recording([{ ...descriptor, dtype: 'unknown' }])), /unknown/);
  assert.throws(() => parseHbr(recording([{ ...descriptor, offset: -8 }])), /invalid replay array/);
  assert.throws(() => parseHbr(recording([{ ...descriptor, length: 16 }])), /replay array/);
});

test('2500 live updates keep timeline, rates, order history and position bounded', () => {
  const sim = new ReplaySimulation({ allowLive: true });
  const buffer = new LiveSessionBuffer();
  let previous = trade(1, 10000), session;
  for (let index = 0; index < 2500; index++) {
    const current = trade(index + 2, 10500 + index * 500, index % 2 ? 'buy' : 'sell', 10);
    const input = frame([previous, current], current.timeMs + 7500);
    sim.accept(input, true);
    session = buffer.accept(input, sim.snapshot(), input.publishedMs + 50);
    previous = current;
  }
  const state = sim.snapshot();
  assert.ok(session.nFrames <= 600);
  assert.ok(session.trTick.length <= 20000);
  assert.ok(state.events.length <= 12000);
  assert.ok(Object.values(session.collector.rate).every(values => values.length <= 181));
  assert.ok(Math.abs(state.position) <= 1);
  assert.ok(Number.isFinite(state.equity));
  assert.ok(state.fillCount > 100);
  assert.equal(state.dataGaps, 0);
  const first = session.frameT[0];
  assert.equal(session.frameAt(first), 0, 'a retained frame is selected using its actual timestamp');
});

