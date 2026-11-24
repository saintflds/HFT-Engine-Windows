import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { readDay, weekAt } from '../server/sierra.mjs';

// Deterministic SCID fixture: one record per minute 2026-10-15 00:00 -> 2026-10-23 13:29,
// plus trades straddling the chosen endMs (2026-10-23 13:30:30) on the far side,
// which a correct weekAt must never include.
const dir = new URL('../data/tests/', import.meta.url);
await mkdir(dir, { recursive: true });
const header = Buffer.alloc(56);
header.write('SCID'); header.writeUInt32LE(56, 4); header.writeUInt32LE(40, 8); header.writeUInt16LE(1, 12);
function record(time, price, volume = 5) {
  const b = Buffer.alloc(40);
  b.writeBigInt64LE(BigInt(time + 2209161600000) * 1000n);
  b.writeFloatLE(price - 25, 8);   // open
  b.writeFloatLE(price + 25, 12);  // high
  b.writeFloatLE(price - 25, 16);  // low
  b.writeFloatLE(price, 20);       // close
  b.writeUInt32LE(3, 24);          // aggregated record (not a single-trade sentinel)
  b.writeUInt32LE(volume, 28);
  return b;
}
const T = (day, h, m = 0, s = 0) =>
  Date.parse(`2026-10-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}Z`);
const records = [];
const pushDay = (day, lastH, lastM) => {
  for (let h = 0; h <= lastH; h++) {
    const maxM = h === lastH ? lastM : 59;
    for (let m = 0; m <= maxM; m++)
      records.push(record(T(String(day).padStart(2, '0'), h, m), 20000 + ((day - 15) * 24 + h) * 15 + m * 0.25));
  }
};
for (let day = 15; day <= 22; day++) pushDay(day, 23, 59); // full days
pushDay(23, 13, 29); // Oct 23 stops at 13:29; the 13:30 minute is built from the straddling trades
records.push(record(T('23', 13, 30, 20), 29000));  // inside the playhead minute, BEFORE endMs
records.push(record(T('23', 13, 30, 40), 29001));  // AFTER endMs: must be invisible
records.push(record(T('23', 13, 31, 0), 29002));   // next minute: must be invisible
records.push(record(T('24', 0, 0, 10), 29003));    // next day: must be invisible
const file = new URL('week-align-fixture-20261108.scid', dir);
await writeFile(file, Buffer.concat([header, ...records]));

const endMs = T('23', 13, 30, 30);

test('weekAt never returns future bars or trades for the endMs playhead', async () => {
  const r = await weekAt('MNQZ26-CME', endMs, file);
  assert.equal(r.available, true);
  assert.equal(r.symbol, 'MNQZ26-CME');
  assert.ok(r.bars.length > 1000);
  assert.equal(r.windowEndMs, endMs);
  assert.ok(r.windowStartMs >= endMs - 7 * 86400000);
  for (const b of r.bars) {
    assert.ok(b.time <= endMs, `bar starts after endMs: ${b.time}`);
    assert.ok(b.lastMs <= endMs, `bar trade after endMs: ${b.lastMs}`);
  }
  // The 13:30 bar is present as a PARTIAL bar (its one trade is before endMs),
  // but the 13:30:40 trade, the 13:31 bar and the next day are all excluded.
  assert.equal(r.bars.at(-1).time, T('23', 13, 30));
  assert.equal(r.bars.at(-1).lastMs, T('23', 13, 30, 20));
  assert.equal(r.lastTradeMs, T('23', 13, 30, 20));
  assert.ok(!r.bars.some(b => b.time === T('23', 13, 31)));
  assert.ok(!r.bars.some(b => b.time >= T('24', 0, 0)));
  // Seven-day lower bound: the 2026-10-15 records are outside the window.
  assert.equal(r.bars[0].time, T('16', 13, 31));
});

test('weekAt clips correctly at several playheads (no future data at any point)', async () => {
  for (const e of [T('23', 9, 0, 0), T('23', 13, 29, 45), T('23', 13, 30, 30), T('23', 13, 30, 59)]) {
    const r = await weekAt('MNQZ26-CME', e, file);
    assert.ok(r.bars.length > 0);
    assert.ok(r.bars.every(b => b.lastMs <= e), `playhead ${e}: a bar contains a later trade`);
    assert.ok(r.bars.every(b => b.time <= e), `playhead ${e}: a bar starts later`);
  }
});

test('weekAt rejects a non-matching symbol instead of substituting history', async () => {
  const r = await weekAt('BTCUSDT', endMs, file);
  assert.equal(r.available, false);
  assert.equal(r.bars, undefined);
  assert.match(r.message, /BTCUSDT/);
  assert.match(r.message, /MNQZ26-CME/);
});

test('weekAt accepts the [M] micro-suffix as the same contract', async () => {
  const a = await weekAt('MNQZ26-CME', endMs, file);
  const b = await weekAt('MNQZ26-CME[M]', endMs, file);
  assert.equal(b.available, true);
  assert.equal(b.bars.length, a.bars.length);
  assert.deepEqual(b.bars, a.bars);
});

test('weekAt validates inputs', async () => {
  await assert.rejects(weekAt('', endMs, file), /symbol is required/);
  await assert.rejects(weekAt('MNQZ26-CME', 0, file), /endMs/);
  await assert.rejects(weekAt('MNQZ26-CME', Number.NaN, file), /endMs/);
});

test('readDay keeps its exact public shape and day boundary (regression)', async () => {
  const day = await readDay('2026-10-23', file);
  // 00:00..13:29 (810 records) + the three 13:30/13:31 straddling trades = 813;
  // bars: 810 minutes + the 13:30 bar + the 13:31 bar = 812.
  assert.equal(day.records, 813);
  assert.equal(day.bars.length, 812);
  // One bar per minute; shape unchanged (no lastMs field) and day-limited.
  assert.deepEqual(day.bars[0], {
    time: T('23', 0, 0), open: 20000 + (8 * 24) * 60 * 0.25 - 25,
    high: 20000 + (8 * 24) * 60 * 0.25 + 25, low: 20000 + (8 * 24) * 60 * 0.25 - 25,
    close: 20000 + (8 * 24) * 60 * 0.25, volume: 5, trades: 3,
  });
  assert.ok(!('lastMs' in day.bars[0]));
  assert.equal(day.bars.at(-1).time, T('23', 13, 31));
  const bar1330 = day.bars.find(b => b.time === T('23', 13, 30));
  assert.equal(bar1330.close, 29001); // last trade in that minute (13:30:40)
  assert.equal(bar1330.volume, 10);
  assert.equal((await readDay('2026-10-24', file)).bars.length, 1);
  assert.equal((await readDay('2026-10-22', file)).bars.length, 1440);
});
