// Integration test (2026-11-08): unsupported-contract journal recovery.
//
// Runs the REAL server code (journalPlugin + JournalStore + DeepStore) on an
// in-process HTTP server with a transient-failure injection, and the REAL
// client code (EngineJournal, transpiled) against it. All state goes to a
// fresh OS temp folder — never the real 'Engine History/' or training data.
//
// Covers: MNQ -> unsupported contract (M2KZ26-CME) -> MNQ, including a valid
// pending write during a temporary failure, with recovery that requires no
// reset and no reload. The unsupported batch must be rejected deterministically
// (422), never retried, and never reach the journal or training data.
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DASH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleFrom = async file => import('data:text/javascript;base64,' + Buffer.from(ts.transpileModule(await readFile(path.join(DASH, file), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64'));

const ORIGIN = 'http://journal-recovery-test-origin';
process.env.HFTENGINE_DASHBOARD_ORIGIN = ORIGIN;

const { JournalStore, journalPlugin } = await import(pathToFileURL(path.join(DASH, 'server/journal.mjs')).href);
const { ReplaySimulation } = await moduleFrom('src/replay-simulation.ts');
const { EngineJournal } = await moduleFrom('src/engine-journal.ts');

// ---- in-process server: real journal plugin + transient-failure injection ----
const STORE_DIR = await mkdtemp(path.join(tmpdir(), 'hft-journal-recovery-'));
const store = new JournalStore(STORE_DIR);
let failNext = 0;

function injectionPlugin() {
  return { name: 'journal-fail-injection-test', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      if (u.pathname === '/_test/journal-fail' && req.method === 'POST') {
        let b = ''; req.on('data', c => b += c);
        req.on('end', () => {
          failNext = Math.min(20, Math.max(0, Number(JSON.parse(b || '{}').n) || 0));
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ failNext }));
        });
        return;
      }
      if (u.pathname === '/_test/journal-fail') {
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ failNext })); return;
      }
      if (failNext > 0 && u.pathname === '/api/mnq/journal' && req.method === 'POST') {
        failNext--;
        res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Simulated transient storage failure (test injection).', code: 'transient_injected' }));
        return;
      }
      next();
    });
  } };
}

const mws = [];
injectionPlugin().configureServer({ middlewares: { use: fn => mws.push(fn) } });
journalPlugin(store).configureServer({ middlewares: { use: fn => mws.push(fn) } });
const server = http.createServer(async (req, res) => {
  let i = 0;
  const next = async (err) => {
    if (err) { res.statusCode = 500; res.end(String(err)); return; }
    if (mws[i]) { const fn = mws[i++]; await fn(req, res, next); return; }
    res.statusCode = 404; res.end('not found');
  };
  await next();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + server.address().port;

// The client uses relative URLs (browser) and no explicit Origin header.
// Simulate the browser: resolve against the in-process server, attach the
// page origin the origin guard expects, and count M2K-batch POSTs (the client
// flush() is the only code path that posts journal batches).
const realFetch = globalThis.fetch;
let m2kPosts = 0;
globalThis.fetch = (input, init = {}) => {
  if (typeof init.body === 'string' && init.body.includes('"M2KZ26-CME"')) m2kPosts++;
  return realFetch(new URL(String(input), BASE), { ...init, headers: { Origin: ORIGIN, ...(init.headers || {}) } });
};
const direct = (p, init = {}) => realFetch(BASE + p, { ...init, headers: { Origin: ORIGIN, ...(init.headers || {}) } });

const runs = () => {
  if (!existsSync(STORE_DIR)) return [];
  return readdirSync(STORE_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^[a-f0-9-]{36}$/.test(e.name))
    .map(e => {
      const dir = path.join(STORE_DIR, e.name);
      const p = path.join(dir, 'batches.jsonl');
      const batches = existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
      return { dir, batches };
    }).sort((a, b) => a.dir.localeCompare(b.dir));
};
const scanFolder = async (dir, hits = []) => {
  let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return hits; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await scanFolder(p, hits);
    else { try { if ((await readFile(p, 'utf8')).includes('M2KZ26-CME')) hits.push(p); } catch { /* binary or absent */ } }
  }
  return hits;
};

// ---- frames + real simulation snapshots -------------------------------------
const sim = new ReplaySimulation({ allowLive: true, strategy: 'liquidity', adaptive: true });
let seq = 100, t = Date.now() - 60000, pub = 0;
function frame(symbol) {
  seq += 1; t += 250; pub += 1;
  const price = 21000 + (seq % 4) * 0.25;
  return {
    version: 1, symbol, replay: false, publishedMs: Date.now() + pub, connected: true, delaySeconds: 0, tickSize: 0.25, last: price,
    bids: [[price, 2], [price - 0.25, 3]], asks: [[price + 0.25, 2], [price + 0.5, 3]],
    trades: [{ sequence: seq, timeMs: t, price, quantity: 2, side: seq % 2 ? 'buy' : 'sell' }],
  };
}
const accept = f => { sim.accept(f, true); return sim.snapshot(); };
const setFail = async n => { const r = await direct('/_test/journal-fail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ n }) }); assert.equal(r.status, 200); };

test('server rejects an unsupported contract with 422 before journal or training data', async () => {
  const m2k = { schema: 1, runId: crypto.randomUUID(), sequence: 1, symbol: 'M2KZ26-CME', mode: 'live', strategy: 'liquidity', strategyVersion: 'liquidity-flow-v2', sourceMs: Date.now(), receivedMs: Date.now(), trades: [], events: [], fills: [], closedTrades: [], adjustments: [], summary: { equity: 0, fees: 0 } };
  const res = await direct('/api/mnq/journal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m2k) });
  assert.equal(res.status, 422);
  const d = await res.json();
  assert.equal(d.code, 'unsupported_contract');
  assert.equal(d.contract, 'M2KZ26-CME');
  assert.match(d.error, /MNQ journal records MNQ futures only/i);
  assert.equal(runs().length, 0, 'no journal run may be created for the unsupported contract');
  await new Promise(r => setTimeout(r, 200)); // let the (skipped) observe chain settle
  const hits = await scanFolder(STORE_DIR);
  assert.equal(hits.length, 0, `no file in the store folder may mention the unsupported contract: ${hits}`);
});

test('client: MNQ records, unsupported frame skipped, transient failure keeps the pending write, then recovers', async () => {
  const journal = new EngineJournal();

  // 1) MNQ frame -> saved, recording.
  const f1 = frame('MNQZ26-CME');
  await journal.record(f1, accept(f1), Date.now(), true);
  assert.equal(journal.status, 'History: recording');
  let all = runs().flatMap(r => r.batches);
  assert.equal(all.length, 1);
  assert.equal(all[0].symbol, 'MNQZ26-CME');
  assert.equal(all[0].sequence, 1);

  // 2) Unsupported M2K frame -> deterministic 422, clear message, batch dropped,
  //    sent exactly once (never retried), nothing saved.
  const f2 = frame('M2KZ26-CME');
  await journal.record(f2, accept(f2), Date.now(), true);
  assert.match(journal.status, /unsupported contract M2KZ26-CME/i, journal.status);
  assert.match(journal.status, /recording resumes/i, journal.status);
  assert.equal(runs().flatMap(r => r.batches).length, 1, 'no batch for the unsupported contract is saved');
  assert.equal(m2kPosts, 0, 'unsupported frames are never enqueued');

  // 3) Temporary failure window (2 journal POSTs): a valid MNQ write stays pending.
  await setFail(2);
  const f3 = frame('MNQZ26-CME');
  await journal.record(f3, accept(f3), Date.now(), true);
  assert.match(journal.status, /History error: Simulated transient storage failure/i, journal.status);
  assert.equal(runs().flatMap(r => r.batches).length, 1, 'the valid batch is RETAINED (pending), not lost and not discarded');

  // 4) Next frame retries into the last injected failure; the pending write is still retained.
  const f4 = frame('MNQZ26-CME');
  await journal.record(f4, accept(f4), Date.now(), true);
  assert.equal(runs().flatMap(r => r.batches).length, 1, 'still pending while the failure window lasts');
  assert.match(journal.status, /History error|recording/i, journal.status);

  // 5) Failure window over: the retained batch flushes first, then the new batch.
  //    Recovery happens across ordinary record() calls — no reset, no reload.
  const f5 = frame('MNQZ26-CME');
  await journal.record(f5, accept(f5), Date.now(), true);
  assert.equal(journal.status, 'History: recording');
  all = runs().flatMap(r => r.batches);
  assert.equal(all.length, 3, 'MNQ batch 1, the retained pending batch, and the new batch are all saved');
  const seqs = runs().map(r => r.batches.map(b => b.sequence).sort((a, b) => a - b)).sort((x, y) => x.length - y.length);
  assert.deepEqual(seqs, [[1], [1, 2]], 'sequences stay contiguous per run (no gap from the failure)');
  assert.ok(all.every(b => b.symbol === 'MNQZ26-CME'), 'only MNQ batches exist in the journal');
  assert.equal(m2kPosts, 0, 'unsupported frames remain excluded');
  const { failNext: left } = await (await direct('/_test/journal-fail')).json();
  assert.equal(left, 0, 'the failure window is fully consumed');

  // Training data isolation for the whole scenario.
  const hits = await scanFolder(STORE_DIR);
  assert.equal(hits.length, 0, `training data must not mention the unsupported contract: ${hits}`);
});

test('cleanup', async () => {
  await new Promise(r => server.close(r));
  globalThis.fetch = realFetch;
  await rm(STORE_DIR, { recursive: true, force: true });
});
