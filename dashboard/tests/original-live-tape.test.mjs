import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/original-live-tape.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { ReplaySafeTape } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const trade = (sequence, timeMs) => ({ sequence, timeMs, price: 25000, quantity: 1, side: 'buy' });
const snapshot = (trades, overrides = {}) => ({ symbol: 'MNQZ26-CME', replay: true, publishedMs: 10000, trades, ...overrides });

test('backward replay seek clears future trades during the empty frame, then starts a new sequence timeline', () => {
  const tape = new ReplaySafeTape();
  tape.accept(snapshot([trade(500, 5000), trade(501, 5010)]));
  tape.accept(snapshot([], { publishedMs: 10200 }));
  assert.equal(tape.size, 0, 'the empty replay frame must immediately clear the old timeline');
  tape.accept(snapshot([trade(1, 1000)], { publishedMs: 10400 }));
  tape.accept(snapshot([trade(2, 1010)], { publishedMs: 10600 }));
  assert.deepEqual(tape.recent(10).map(t => t.sequence), [2, 1]);
});

test('backward replay timestamps clear future trades even if sequence numbers continue ascending', () => {
  const tape = new ReplaySafeTape();
  tape.accept(snapshot([trade(10, 5000)]));
  tape.accept(snapshot([trade(11, 1000)], { publishedMs: 10200 }));
  tape.accept(snapshot([trade(12, 1010)], { publishedMs: 10400 }));
  assert.deepEqual(tape.recent(10).map(t => t.sequence), [12, 11]);
});

test('empty live frames preserve retained trades and rewind detection across the gap', () => {
  const tape = new ReplaySafeTape();
  tape.accept(snapshot([trade(10, 5000)], { replay: false }));
  tape.accept(snapshot([], { replay: false, publishedMs: 10200 }));
  assert.equal(tape.size, 1);
  tape.accept(snapshot([trade(11, 5010)], { replay: false, publishedMs: 10400 }));
  assert.equal(tape.size, 2);
  tape.accept(snapshot([], { replay: false, publishedMs: 10600 }));
  tape.accept(snapshot([trade(1, 5020)], { replay: false, publishedMs: 10800 }));
  assert.deepEqual(tape.recent(10).map(t => t.sequence), [1]);
});

test('replay stop, restart, and symbol change clear the prior source even when the transition is empty', () => {
  const tape = new ReplaySafeTape();
  tape.accept(snapshot([trade(100, 5000)]));
  tape.accept(snapshot([], { replay: false, publishedMs: 10200 }));
  assert.equal(tape.size, 0);
  tape.accept(snapshot([trade(200, 100000)], { replay: false, publishedMs: 10400 }));
  tape.accept(snapshot([], { publishedMs: 10600 }));
  tape.accept(snapshot([trade(1, 1000)], { publishedMs: 10800 }));
  assert.deepEqual(tape.recent(10).map(t => t.sequence), [1]);
  tape.accept(snapshot([], { symbol: 'MNQH27-CME', replay: false, publishedMs: 11000 }));
  assert.equal(tape.size, 0);
  tape.accept(snapshot([trade(1000, 100)], { symbol: 'MNQH27-CME', replay: false, publishedMs: 11200 }));
  tape.accept(snapshot([trade(1001, 110)], { symbol: 'MNQH27-CME', replay: false, publishedMs: 11400 }));
  assert.deepEqual(tape.recent(10).map(t => t.sequence), [1001, 1000]);
});

test('overlapping snapshots deduplicate and bound retention to the newest 1000 trades', () => {
  const tape = new ReplaySafeTape();
  const trades = Array.from({ length: 1000 }, (_, i) => trade(i + 1, 1000 + i));
  tape.accept(snapshot(trades));
  tape.accept(snapshot([trades.at(-1), trade(1001, 2000)], { publishedMs: 10200 }));
  assert.equal(tape.size, 1000);
  assert.equal(tape.recent(1000).at(-1).sequence, 2);
  assert.equal(tape.recent(1)[0].sequence, 1001);
});
