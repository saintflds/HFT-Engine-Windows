import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readDay } from '../server/sierra.mjs';

const source = await readFile(new URL('../src/mnq/backtest.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { backtest } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const start = Date.parse('2026-10-23T13:00:00Z');
function candles(prices) { return prices.map((close, i) => ({ time: start + i * 60000, open: close + 0.25, high: close + 1, low: close - 1, close, volume: 10, trades: 10 })); }
const prices = Array.from({ length: 120 }, (_, i) => 20000 + Math.round(Math.sin(i / 5) * 20) / 4);
const bars = candles(prices);
const settings = { fast: 2, slow: 3, fee: 0.75, slippage: 1 };

test('fills occur on next-bar open, with correct MNQ multiplier, adverse slippage and both commissions', () => {
  const r = backtest(bars, settings);
  assert.ok(r.trades.length > 2);
  for (const trade of r.trades) {
    const index = bars.findIndex(b => b.time === trade.entryTime);
    assert.ok(index > 0);
    const prior = r.fastLine[index - 1] - r.slowLine[index - 1];
    const earlier = r.fastLine[index - 2] - r.slowLine[index - 2];
    assert.ok(trade.side > 0 ? prior > 0 && earlier <= 0 : prior < 0 && earlier >= 0);
    assert.equal(trade.entry, bars[index].open + trade.side * 0.25);
    assert.equal(trade.fees, 1.5);
    assert.equal(trade.net, trade.side * (trade.exit - trade.entry) * 2 - 1.5);
  }
  assert.equal(r.net, r.trades.reduce((sum, t) => sum + t.net, 0));
  assert.equal(r.equity.at(-1).value, r.net);
});

test('costs reduce results by the exact charged amounts', () => {
  const zero = backtest(bars, { ...settings, fee: 0, slippage: 0 });
  const paid = backtest(bars, settings);
  assert.equal(zero.trades.length, paid.trades.length);
  assert.ok(Math.abs(zero.net - paid.net - paid.trades.length * (1.5 + 1)) < 1e-8);
});

test('future prices cannot change earlier entry decisions', () => {
  const altered = bars.map((b, i) => i < 80 ? b : { ...b, open: b.open + 100, high: b.high + 100, low: b.low + 100, close: b.close + 100 });
  const a = backtest(bars, settings), b = backtest(altered, settings);
  assert.deepEqual(a.trades.filter(t => t.exitTime < bars[80].time), b.trades.filter(t => t.exitTime < bars[80].time));
});

test('flat prices give no trades; invalid settings are rejected', () => {
  assert.equal(backtest(candles(Array(120).fill(20000)), settings).trades.length, 0);
  assert.throws(() => backtest(bars, { ...settings, slow: 2 }));
  assert.throws(() => backtest(bars, { ...settings, fee: -1 }));
  assert.throws(() => backtest(bars, { ...settings, slippage: Infinity }));
  assert.equal(backtest([], settings).net, 0);
});

test('missing bars liquidate at the next observed open and restart EMA warmup', () => {
  const original = backtest(bars, settings);
  const entryTrade = original.trades[0];
  const gapIndex = bars.findIndex(b => b.time === entryTrade.entryTime) + 1;
  const gapBars = [...bars.slice(0, gapIndex), ...bars.slice(gapIndex + 5).map(b => ({ ...b, open: b.open + 500, high: b.high + 500, low: b.low + 500, close: b.close + 500 }))];
  const r = backtest(gapBars, settings), next = gapBars[gapIndex];
  const liquidation = r.trades.find(t => t.entryTime === entryTrade.entryTime);
  assert.equal(liquidation.exitTime, next.time);
  assert.equal(liquidation.exit, next.open - liquidation.side * 0.25);
  assert.equal(liquidation.reason, 'Missing bars: next available open (modeled)');
  assert.equal(r.gapLiquidations, 1);
  assert.equal(r.gaps, 1);
  assert.equal(r.fastLine[gapIndex], next.close);
  assert.equal(r.slowLine[gapIndex], next.close);
  assert.ok(r.trades.every(t => t.entryTime < next.time || t.entryTime > next.time + settings.slow * 3 * 60000));
});

test('regular-session positions close at 15:59 and do not count the overnight break as missing bars', () => {
  const fullDay = candles(Array.from({ length: 500 }, (_, i) => 20000 + Math.round(Math.sin(i / 5) * 20) / 4));
  const r = backtest(fullDay, settings);
  const sessionClose = Date.parse('2026-10-23T19:59:00Z');
  assert.ok(r.trades.some(t => t.reason === 'Session close (modeled)'));
  assert.ok(r.trades.every(t => t.entryTime >= Date.parse('2026-10-23T13:30:00Z') && t.entryTime < sessionClose));
  assert.ok(r.trades.every(t => t.exitTime <= sessionClose + 59999));
  const dayTwo = fullDay.slice(0, 100).map(b => ({ ...b, time: b.time + 3 * 86400000 }));
  const combined = backtest([...fullDay.filter(b => b.time <= sessionClose), ...dayTwo], settings);
  assert.equal(combined.gaps, 0);
  assert.equal(combined.gapLiquidations, 0);
});

test('missing session close uses next available open instead of a later close', () => {
  const first = backtest(bars, settings).trades[0];
  const entryIndex = bars.findIndex(b => b.time === first.entryTime);
  const nextDay = { ...bars[0], time: Date.parse('2026-10-26T13:30:00Z'), open: 20500, high: 20600, low: 20400, close: 20550 };
  const r = backtest([...bars.slice(0, entryIndex + 1), nextDay], settings);
  assert.equal(r.trades.at(-1).exitTime, nextDay.time);
  assert.equal(r.trades.at(-1).exit, nextDay.open - first.side * 0.25);
  assert.equal(r.gapLiquidations, 1);
});

test('regular session follows New York daylight saving time, and malformed bars are rejected', () => {
  const winterStart = Date.parse('2026-12-01T14:00:00Z');
  const winter = bars.map((b, i) => ({ ...b, time: winterStart + i * 60000 }));
  const r = backtest(winter, settings);
  assert.ok(r.trades.length);
  assert.ok(r.trades.every(t => t.entryTime >= Date.parse('2026-12-01T14:30:00Z')));
  assert.throws(() => backtest([{ ...bars[0], high: bars[0].close - 1 }], settings), /Invalid bar/);
  assert.throws(() => backtest([{ ...bars[0], time: bars[0].time + 1 }], settings), /Invalid bar/);
});

test('SCID parsing treats single-trade High/Low as quotes, handles minute boundaries and excludes another day', async () => {
  const dir = new URL('../../data/tests/', import.meta.url); await mkdir(dir, { recursive: true });
  const header = Buffer.alloc(56); header.write('SCID'); header.writeUInt32LE(56, 4); header.writeUInt32LE(40, 8); header.writeUInt16LE(1, 12);
  function record(time, price, volume) {
    const b = Buffer.alloc(40); b.writeBigInt64LE(BigInt(time + 2209161600000) * 1000n);
    b.writeFloatLE(0, 8); b.writeFloatLE(price + 50, 12); b.writeFloatLE(price - 50, 16); b.writeFloatLE(price, 20);
    b.writeUInt32LE(1, 24); b.writeUInt32LE(volume, 28); return b;
  }
  const file = new URL('fixture.scid', dir);
  await writeFile(file, Buffer.concat([header, record(start, 20000, 2), record(start + 1000, 20001, 3), record(start + 60000, 19999, 4), record(start + 86400000, 20100, 1)]));
  const day = await readDay('2026-10-23', file);
  assert.equal(day.records, 3); assert.equal(day.bars.length, 2);
  assert.deepEqual(day.bars[0], { time: start, open: 20000, high: 20001, low: 20000, close: 20001, volume: 5, trades: 2 });
  assert.equal(day.aggregatedRecords, 0);
  assert.equal((await readDay('2026-10-22', file)).bars.length, 0);
  await assert.rejects(readDay('../bad', file));
});

test('SCID reader recognizes unbundled trade flags and rejects invalid aggregated OHLC', async () => {
  const dir = new URL('../../data/tests/', import.meta.url); await mkdir(dir, { recursive: true });
  const header = Buffer.alloc(56); header.write('SCID'); header.writeUInt32LE(56, 4); header.writeUInt32LE(40, 8); header.writeUInt16LE(1, 12);
  function record(time, open, high, low, close, trades = 1) {
    const b = Buffer.alloc(40); b.writeBigInt64LE(BigInt(time + 2209161600000) * 1000n);
    b.writeFloatLE(open, 8); b.writeFloatLE(high, 12); b.writeFloatLE(low, 16); b.writeFloatLE(close, 20);
    b.writeUInt32LE(trades, 24); b.writeUInt32LE(2, 28); return b;
  }
  const file = new URL('flags.scid', dir);
  await writeFile(file, Buffer.concat([header, record(start, -1.99900095e37, 21000, 19000, 20000), record(start + 1000, -1.99900197e37, 21000, 19000, 20001)]));
  const day = await readDay('2026-10-23', file);
  assert.equal(day.bars[0].high, 20001); assert.equal(day.bars[0].low, 20000); assert.equal(day.aggregatedRecords, 0);
  await writeFile(file, Buffer.concat([header, record(start, 20000, 19900, 19800, 20010, 4)]));
  await assert.rejects(readDay('2026-10-23', file), /Invalid historical OHLC/);
});
