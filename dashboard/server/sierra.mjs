import {dailyPerformancePlugin} from './daily-performance.mjs';
import { open, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { journalPlugin } from './journal.mjs';
import { liveStreamPlugin } from './live-stream.mjs';
import { paperExecutionPlugin } from './paper-execution.mjs';
import {liveFile as projectLiveFile} from './project-paths.mjs';

export const symbol = 'MNQZ26-CME';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataFile = path.join(process.env.SIERRA_DATA_FOLDER || path.join(root, '..', 'SierraChart', 'Data'), `${symbol}.scid`);
const liveFile = projectLiveFile;
const epochMs = 2209161600000;
const timestamp = (buffer, offset = 0) => Number(buffer.readBigInt64LE(offset) / 1000n) - epochMs;
// Matches s_IntradayRecord::IsSingleTradeWithBidAsk in Sierra's installed
// ACS_Source/IntradayRecord.h, including its two unbundled-trade sentinels.
const singleTradeOpen = new Set([0, Math.fround(-1.99900095e37), Math.fround(-1.99900197e37)]);

async function inspect(file) {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(56);
    const result = await handle.read(header, 0, 56, 0);
    if (result.bytesRead !== 56 || header.toString('ascii', 0, 4) !== 'SCID') throw Error('Not a Sierra intraday file.');
    const headerSize = header.readUInt32LE(4), recordSize = header.readUInt32LE(8);
    if (headerSize < 56 || recordSize !== 40 || header.readUInt16LE(12) !== 1) throw Error('Unsupported Sierra intraday format.');
    const info = await handle.stat();
    const count = Math.floor((info.size - headerSize) / recordSize);
    if (count < 1) throw Error('No historical records available.');
    async function timeAt(index) {
      const b = Buffer.alloc(8);
      if ((await handle.read(b, 0, 8, headerSize + index * recordSize)).bytesRead !== 8) throw Error('Historical file changed while reading. Retry.');
      return timestamp(b);
    }
    return { handle, headerSize, recordSize, count, timeAt, firstMs: await timeAt(0), lastMs: await timeAt(count - 1), modified: info.mtimeMs };
  } catch (error) { await handle.close(); throw error; }
}

export async function historyInfo(file = dataFile) {
  const source = await inspect(file);
  try { return { symbol, firstMs: source.firstMs, lastMs: source.lastMs, records: source.count }; }
  finally { await source.handle.close(); }
}

// Streams records within [startMs, stopMs] (inclusive) and aggregates them into
// one-minute bars. Each bar records the timestamp of its LAST trade (lastMs) so
// consumers can hide bars that extend beyond a given playhead. The final bar is
// partial when stopMs falls inside its minute. No record after stopMs is ever read.
async function aggregateRange(startMs, stopMs, file = dataFile) {
  const source = await inspect(file);
  try {
    let lo = 0, hi = source.count;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await source.timeAt(mid) < startMs) lo = mid + 1;
      else hi = mid;
    }
    if (lo === source.count) return { bars: [], records: 0, aggregatedRecords: 0 };
    const bars = [];
    let records = 0, aggregatedRecords = 0, previous = -Infinity;
    const stream = createReadStream(file, {
      start: source.headerSize + lo * 40,
      end: source.headerSize + source.count * 40 - 1,
      highWaterMark: 40 * 25000,
    });
    let carry = Buffer.alloc(0), done = false, recordsRead = lo;
    for await (const chunk of stream) {
      const b = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let i = 0;
      for (; i + 40 <= b.length; i += 40) {
        recordsRead++;
        const timeMs = timestamp(b, i);
        if (timeMs > stopMs) { done = true; break; }
        if (timeMs < previous) throw Error('Historical records are not in chronological order.');
        previous = timeMs;
        const trades = b.readUInt32LE(i + 24), volume = b.readUInt32LE(i + 28);
        if (!trades || !volume) continue;
        const close = b.readFloatLE(i + 20), rawOpen = b.readFloatLE(i + 8);
        if (!Number.isFinite(close) || close <= 0) throw Error('Invalid historical price.');
        const tick = trades === 1 && singleTradeOpen.has(rawOpen);
        const openPrice = tick ? close : rawOpen;
        const high = tick ? close : b.readFloatLE(i + 12);
        const low = tick ? close : b.readFloatLE(i + 16);
        if (![openPrice, high, low].every(Number.isFinite) || Math.min(openPrice, low) <= 0
          || high < Math.max(openPrice, close) || low > Math.min(openPrice, close)) throw Error('Invalid historical OHLC prices.');
        if (!tick) aggregatedRecords++;
        const minute = Math.floor(timeMs / 60000) * 60000;
        let bar = bars.at(-1);
        if (!bar || bar.time !== minute) {
          bar = { time: minute, open: openPrice, high, low, close, volume: 0, trades: 0, lastMs: 0 };
          bars.push(bar);
        }
        bar.high = Math.max(bar.high, high); bar.low = Math.min(bar.low, low);
        bar.close = close; bar.volume += volume; bar.trades += trades; bar.lastMs = timeMs; records++;
      }
      if (done) break;
      carry = b.subarray(i);
    }
    if (!done && (carry.length || recordsRead !== source.count)) throw Error('Historical file changed while reading. Retry.');
    return { bars, records, aggregatedRecords };
  } finally { await source.handle.close(); }
}

// Reads only the requested UTC day, seeking directly to its first record.
// For single-trade records High/Low are ask/bid quotes, NOT traded OHLC.
export async function readDay(date, file = dataFile) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error('Choose a date in YYYY-MM-DD format.');
  const start = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== date) throw Error('Invalid date.');
  const end = start + 86400000;
  const { bars, records, aggregatedRecords } = await aggregateRange(start, end - 1, file);
  // A currently forming minute cannot be used as a completed signal bar.
  const completed = bars.filter(b => b.time + 60000 <= Date.now()).map(({ lastMs, ...bar }) => bar);
  return { symbol, date, bars: completed, records, aggregatedRecords };
}

// The week chart's contract is the one this Sierra dataset records. Session
// symbols sometimes carry a [M] micro-suffix; normalize before matching.
const normSymbol = (value) => String(value ?? '').trim().replace(/\[M\]$/i, '');

// Weekly (7-day) history ending AT endMs for a matching symbol. Bars include the
// last trade time of each bar; nothing after endMs is read, so a replay can never
// see future candles. A non-matching symbol returns available:false (no substitute).
export async function weekAt(requestedSymbol, endMs, file = dataFile) {
  const requested = normSymbol(requestedSymbol);
  if (!requested) throw Error('A symbol is required.');
  if (requested !== normSymbol(symbol)) {
    return { available: false, symbol: requested, message: `No recorded weekly history for ${requested}. This Sierra dataset records ${symbol} only.` };
  }
  if (!Number.isFinite(endMs) || endMs <= 0) throw Error('endMs must be a positive number of epoch milliseconds.');
  const info = await historyInfo(file);
  const end = Math.min(endMs, info.lastMs);
  const start = Math.max(info.firstMs, end - 7 * 86400000);
  const { bars } = await aggregateRange(start, end, file);
  return {
    available: true,
    symbol,
    windowStartMs: start,
    windowEndMs: end,
    lastTradeMs: bars.length ? bars.at(-1).lastMs : 0,
    bars,
  };
}

export function sierraPlugin() {
  let busy = false;
  let weekCache=null,weekCacheAt=0,weekPending=null;
  async function week(){if(weekCache&&Date.now()-weekCacheAt<60000)return weekCache;if(weekPending)return weekPending;weekPending=(async()=>{const info=await historyInfo();const end=Math.min(Date.now(),info.lastMs);const start=end-7*86400000;const bars=[];for(let day=Math.floor(start/86400000)*86400000;day<=end;day+=86400000){const d=await readDay(new Date(day).toISOString().slice(0,10));bars.push(...d.bars.filter(b=>b.time>=start&&b.time<=end));}weekCache={symbol,firstMs:start,lastMs:end,bars};weekCacheAt=Date.now();return weekCache;})();try{return await weekPending;}finally{weekPending=null;}}
  return {
    name: 'sierra-local-data',
    configureServer(server) {
      dailyPerformancePlugin().configureServer(server);
      const journal = journalPlugin();
      const execution = paperExecutionPlugin({ deepState: journal.deepState });
      journal.configureServer(server);
      execution.configureServer(server);
      liveStreamPlugin(liveFile, execution.observe).configureServer(server);
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (!url.pathname.startsWith('/api/mnq/')) return next();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        const send = (value, status = 200) => { res.statusCode = status; res.end(JSON.stringify(value)); };
        if (req.method !== 'GET') return send({ error: 'Read-only endpoint.' }, 405);
        try {
          if (url.pathname === '/api/mnq/live') {
            let info;
            try { info = await stat(liveFile); }
            catch (error) { if (error.code === 'ENOENT') return send({ available: false, message: 'Waiting for the HFTENGINE study in Sierra Chart.' }); throw error; }
            if (info.size > 1000000) throw Error('Live data file is unexpectedly large.');
            const frame = JSON.parse(await readFile(liveFile, 'utf8'));
            if (frame.version !== 1 || !Array.isArray(frame.bids) || !Array.isArray(frame.asks) || !Array.isArray(frame.trades)) throw Error('Invalid live data format.');
            return send({ available: true, ageMs: Math.max(0, Date.now() - info.mtimeMs), frame });
          }
          if (url.pathname === '/api/mnq/week') return send(await week());
          if (url.pathname === '/api/mnq/week-at') {
            const endMs = Number(url.searchParams.get('endMs'));
            if (!Number.isFinite(endMs) || endMs <= 0) return send({ error: 'Provide symbol and endMs (epoch milliseconds).' }, 400);
            const result = await weekAt(url.searchParams.get('symbol') || '', endMs);
            if (!result.available) return send(result, 404);
            return send(result);
          }
          if (url.pathname === '/api/mnq/info') return send(await historyInfo());
          if (url.pathname === '/api/mnq/history') {
            if (busy) return send({ error: 'A historical date is loading. Try again shortly.' }, 429);
            busy = true;
            try { return send(await readDay(url.searchParams.get('date') || '')); }
            finally { busy = false; }
          }
          send({ error: 'Unknown endpoint.' }, 404);
        } catch (error) { send({ error: error.message }, 500); }
      });
    },
  };
}

