import { readdir, stat, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { historyInfo } from './sierra.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const data = process.env.SIERRA_DATA_FOLDER || path.join(root, '..', 'SierraChart', 'Data');
let job = { running: false, session: '', log: '', error: '', startedMs: 0 };

// Keep a previous result intact when the same interval is run with new costs,
// duration or latency, including when an earlier replay is still open.
export function makeSessionName(contract, date, start, source, strategy) {
  return `${contract.replace('-CME', '').toLowerCase()}_${date.replaceAll('-', '')}_${start.replace(':', '')}_${source}_${strategy}_${randomUUID().replaceAll('-', '')}`;
}

// Candidate dates come from only the first/last native tick timestamps. Dates
// inside this span can still be weekends or contain gaps; the converter checks
// the actual selected interval. Bound the list without scanning the trade file.
export function quoteDateChoices(firstMs, lastMs, limit = 366) {
  const day = 86400000;
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs) || firstMs > lastMs) return [];
  const first = Math.floor(firstMs / day) * day, last = Math.floor(lastMs / day) * day;
  const dates = [];
  for (let time = last; time >= first && dates.length < limit; time -= day) {
    dates.push({ date: new Date(time).toISOString().slice(0, 10), firstMs: Math.max(time, firstMs), lastMs: Math.min(time + day, lastMs) });
  }
  return dates;
}

// Progress polling must not reopen every historical file on each request.
// Share in-flight scans and refresh archive metadata every 30 seconds.
export function cachedInventory(load, now = Date.now) {
  const entries = new Map();
  return async key => {
    const previous = entries.get(key);
    if (previous && previous.expires > now()) return previous.promise;
    const entry = { expires: Infinity, promise: null };
    entry.promise = Promise.resolve().then(() => load(key)).then(value => {
      entry.expires = now() + 30000;
      return value;
    }, error => {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    });
    entries.set(key, entry);
    return entry.promise;
  };
}

const inventory = cachedInventory(async requestedSymbol => {
  const folder = path.join(data, 'MarketDepthData'); let names = [];
  try { names = await readdir(folder); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const dates = [];
  const symbols = (await readdir(data)).filter(name => /^MNQ[HMUZ]\d{2}-CME\.scid$/.test(name)).map(name => name.slice(0, -5)).sort();
  const trades = await historyInfo(path.join(data, `${requestedSymbol}.scid`));
  for (const name of names) {
    const match = /^(MNQ[HMUZ]\d{2}-CME)\.(\d{4}-\d{2}-\d{2})\.depth$/.exec(name);
    if (!match || match[1] !== requestedSymbol) continue;
    const file = path.join(folder, name), info = await stat(file);
    const records = Math.max(0, Math.floor((info.size - 64) / 24));
    let firstMs = null, lastMs = null;
    if (records) {
      const handle = await open(file, 'r');
      try {
        const b = Buffer.alloc(8); await handle.read(b, 0, 8, 64);
        firstMs = Number(b.readBigInt64LE() / 1000n) - 2209161600000;
        await handle.read(b, 0, 8, 64 + (records - 1) * 24);
        lastMs = Number(b.readBigInt64LE() / 1000n) - 2209161600000;
      } finally { await handle.close(); }
    }
    dates.push({ date: match[2], records, firstMs, lastMs, hasOverlap: records > 0 && firstMs < trades.lastMs && lastMs > trades.firstMs });
  }
  let runnerReady = false;
  try { runnerReady = (await stat(path.join(root, 'runner/target/release/hftengine-runner.exe'))).size > 0; } catch {}
  const quoteDates = quoteDateChoices(trades.firstMs, trades.lastMs);
  return { symbol: requestedSymbol, symbols, dates: dates.sort((a, b) => b.date.localeCompare(a.date)), quoteDates,
    firstTradeMs: trades.firstMs, lastTradeMs: trades.lastMs, tradeRecords: trades.records,
    quoteDateChoicesLimited: quoteDates.length === 366 && quoteDates.at(-1).firstMs > trades.firstMs,
    defaultSource: dates.some(item => item.hasOverlap) ? 'depth' : 'quotes', runnerReady };
});

export function enginePlugin() {
  return { name: 'original-mnq-engine', configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (!url.pathname.startsWith('/api/mnq/engine/')) return next();
      res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
      const send = (value, status = 200) => { res.statusCode = status; res.end(JSON.stringify(value)); };
      try {
        const requestedSymbol = url.searchParams.get('symbol') || 'MNQZ26-CME';
        if (!/^MNQ[HMUZ]\d{2}-CME$/.test(requestedSymbol)) return send({ error: 'Choose an MNQ futures contract.' }, 400);
        if (req.method === 'GET' && url.pathname.endsWith('/status')) return send({ job });
        if (req.method === 'GET' && url.pathname.endsWith('/info')) {
          return send({ ...await inventory(requestedSymbol), job });
        }
        if (url.pathname.endsWith('/run') && req.method === 'POST') {
          if (req.headers.origin !== 'http://127.0.0.1:5180') return send({ error: 'Run this from the local HFTENGINE page.' }, 403);
          if (job.running) return send({ error: 'A backtest is already running.' }, 409);
          const chunks = []; let length = 0;
          for await (const chunk of req) { length += chunk.length; if (length > 4096) return send({ error: 'Request too large.' }, 413); chunks.push(chunk); }
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const contract = String(input.symbol || 'MNQZ26-CME');
          if (!/^MNQ[HMUZ]\d{2}-CME$/.test(contract)) return send({ error: 'Choose an MNQ futures contract.' }, 400);
          const date = String(input.date || ''), start = String(input.start || '13:30');
          const minutes = Number(input.minutes), fee = Number(input.fee), latency = Number(input.latency), strategy = String(input.strategy || 'queue'), source = String(input.source || 'depth');
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !Number.isInteger(minutes) || minutes < 1 || minutes > 60 || !Number.isFinite(fee) || fee < 0 || fee > 100 || !Number.isInteger(latency) || latency < 0 || latency > 1000000 || !['queue','grid','ema'].includes(strategy) || !['quotes','depth'].includes(source)) return send({ error: 'Check source, date, time, duration, fee and latency.' }, 400);
          if (strategy === 'ema' && minutes < 22) return send({ error: 'EMA needs at least 22 minutes: the first 21 completed one-minute trade bars warm up the averages. Start with 30 minutes.' }, 400);
          if (source === 'depth') {
            const depth = await stat(path.join(data, 'MarketDepthData', `${contract}.${date}.depth`));
            if (depth.size <= 64) return send({ error: 'No recorded depth events for this date. Choose Quote model, or record/download depth in Sierra.' }, 400);
          }
          // Requests may have arrived together while their bodies/files loaded.
          if (job.running) return send({ error: 'A backtest is already running.' }, 409);
          const session = makeSessionName(contract, date, start, source, strategy);
          const args = [path.join(root, 'tools/sierra/session.py'), '--symbol', contract, '--source', source, '--data-folder', data, '--date', date, '--start', start, '--minutes', String(minutes), '--fee-per-contract', String(fee), '--latency-us', `${latency},${latency}`, '--strategy', strategy, '--name', session];
          const currentJob = { running: true, session, log: '', error: '', startedMs: Date.now() };
          job = currentJob;
          const child = spawn('python.exe', args, { cwd: root, windowsHide: true, env: process.env });
          const append = chunk => { currentJob.log = (currentJob.log + chunk.toString()).slice(-12000); };
          child.stdout.on('data', append); child.stderr.on('data', append);
          child.on('error', error => { currentJob.running = false; currentJob.error = error.message; });
          child.on('close', code => { currentJob.running = false; if (code !== 0 && !currentJob.error) currentJob.error = `Backtest exited with code ${code}. See the log.`; });
          return send({ started: true, session });
        }
        send({ error: 'Unknown operation.' }, 404);
      } catch (e) { send({ error: e.code === 'ENOENT' ? 'The requested Sierra data file is not available.' : e.message }, 400); }
    });
  } };
}
