import { backtest, type Bar } from './backtest';

const app = document.querySelector<HTMLElement>('#mnq-app')!;
app.innerHTML = `
<header><div><span class="brand">HFTENGINE</span> <span class="instrument">MNQZ26 · CME</span></div><span>MICRO NASDAQ / DEC 2026</span></header>
<nav><button id="live-tab" class="active">Live market</button><button id="history-tab">Historical / backtest</button><a href="/?session=sample">Original sample replay</a></nav>
<section id="live-view">
  <div class="status-row"><strong id="live-status">WAITING FOR SIERRA</strong><span id="live-age">Connecting…</span></div>
  <p id="live-message" class="notice">Keep Sierra Chart open with the HFTENGINE Live Depth and Trades study on your MNQ chart.</p>
  <div class="metrics"><div>LAST PRICE<strong id="last">—</strong></div><div>SPREAD<strong id="spread">—</strong></div><div>BID DEPTH<strong id="bid-depth">—</strong></div><div>ASK DEPTH<strong id="ask-depth">—</strong></div></div>
  <div class="live-grid"><article><h2>ORDER BOOK <small>contracts at each price</small></h2><div class="book-grid"><div><table><thead><tr><th>Bid size</th><th>Bid price</th></tr></thead><tbody id="bids"></tbody></table></div><div><table><thead><tr><th>Ask price</th><th>Ask size</th></tr></thead><tbody id="asks"></tbody></table></div></div></article>
  <article><h2>TIME & SALES <small>New York time · recent 100 trades</small></h2><div class="scroll"><table><thead><tr><th>Time</th><th>Price</th><th>Size</th><th>At</th></tr></thead><tbody id="tape"></tbody></table></div></article></div>
  <footer>Display refresh: ~250 ms. Depth is a snapshot. This view shows observed market depth and trades only.</footer>
</section>
<section id="history-view" hidden>
  <div class="status-row"><strong>HISTORICAL MNQ</strong><span id="history-range">Reading available dates…</span></div>
  <div class="controls"><label>Date (UTC)<input id="date" type="date"></label><button id="load">Load date</button><label>Fast EMA<input id="fast" type="number" min="2" max="499" value="9"></label><label>Slow EMA<input id="slow" type="number" min="3" max="500" value="21"></label><label>Commission / side ($)<input id="fee" type="number" min="0" max="100" step="0.01" value="0.75"></label><label>Slippage / side (ticks)<input id="slip" type="number" min="0" max="100" step="1" value="1"></label><button id="run" disabled>Run backtest</button></div>
  <p class="notice">Example strategy: 9/21 EMA crossover, 1 contract, 1-minute bars, 09:30–16:00 New York. Enter or reverse at the next minute’s open. Flat at session close. Commission and slippage above are assumptions—enter your actual costs. No stop-loss or profit target.</p>
  <p id="history-message" role="status">Choose a date to load your Sierra trade history.</p>
  <article><h2>PRICE / EMA <small id="chart-description">Historical traded prices · no reconstructed depth</small></h2><canvas id="price-chart" height="260"></canvas></article>
  <div class="replay-controls"><button id="play" disabled>Play history</button><input id="seek" type="range" min="0" max="0" value="0" aria-label="Historical replay position"><span id="bar-time">—</span><label>Speed<select id="speed"><option value="1">1 bar/s</option><option value="5">5 bars/s</option><option value="20">20 bars/s</option></select></label></div>
  <div id="results" hidden><div class="metrics"><div>NET P&L<strong id="net">—</strong></div><div>CLOSED TRADES<strong id="trade-count">—</strong></div><div>WIN RATE<strong id="win-rate">—</strong></div><div>MAX DRAWDOWN*<strong id="drawdown">—</strong></div></div>
  <p id="costs"></p><article><h2>EQUITY <small>*marked at each bar close; intrabar losses can be larger</small></h2><canvas id="equity-chart" height="180"></canvas></article>
  <div class="status-row"><strong>TRADE LOG</strong><button id="export">Export trades CSV</button></div><div class="trade-log"><table><thead><tr><th>Side</th><th>Entry (NY)</th><th>Exit (NY)</th><th>Entry price</th><th>Exit price</th><th>Net $</th><th>Exit reason</th></tr></thead><tbody id="trade-log"></tbody></table></div></div>
  <footer>Bar-based educational backtest, separate from the original hftbacktest queue engine. $2/point, 0.25-point tick ($0.50). Results depend on assumptions and are not evidence of future profitability. Test untouched dates before changing rules.</footer>
</section>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const text = (id: string, value: string) => { $(id).textContent = value; };
const fmt = (n: number) => Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
const time = (n: number) => new Date(n).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
const dateTime = (n: number) => new Date(n).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
async function api(route: string) {
  const response = await fetch(`/api/mnq/${route}`, { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || data.error) throw Error(data.error || 'Request failed.');
  return data;
}
let liveMode = true;
function selectTab(live: boolean) {
  liveMode = live;
  $('live-view').hidden = !live; $('history-view').hidden = live;
  $('live-tab').classList.toggle('active', live); $('history-tab').classList.toggle('active', !live);
  history.replaceState(null, '', `?mode=${live ? 'live' : 'history'}`);
  if (!live) drawHistory();
}
$('live-tab').onclick = () => selectTab(true);
$('history-tab').onclick = () => selectTab(false);

function cells(row: HTMLTableRowElement, values: string[]) {
  for (const value of values) { const cell = row.insertCell(); cell.textContent = value; }
}
function depth(id: string, levels: number[][], bid: boolean) {
  const body = $(id); body.replaceChildren();
  const valid = levels.filter(l => l.length >= 2 && Number.isFinite(l[0]) && Number.isFinite(l[1]) && l[0] > 0 && l[1] >= 0).slice(0, 40);
  const max = Math.max(1, ...valid.map(l => l[1]));
  for (const level of valid) {
    const row = document.createElement('tr'); row.className = bid ? 'buy' : 'sell';
    cells(row, bid ? [String(level[1]), fmt(level[0])] : [fmt(level[0]), String(level[1])]);
    row.style.background = `linear-gradient(${bid ? 'to left' : 'to right'}, ${bid ? '#10433d' : '#482b36'} ${level[1] / max * 100}%, transparent 0)`;
    body.append(row);
  }
}
function clearLive() {
  for (const id of ['last', 'spread', 'bid-depth', 'ask-depth']) text(id, '—');
  for (const id of ['bids', 'asks', 'tape']) $(id).replaceChildren();
}
async function poll() {
  try {
    if (liveMode) {
      const data = await api('live');
      if (!data.available) { clearLive(); text('live-status', 'WAITING FOR SIERRA'); text('live-message', data.message); }
      else {
        const f = data.frame;
        const correct = /^MNQZ26-CME(?:\[M\])?$/i.test(f.symbol);
        const stale = data.ageMs > 3000;
        text('live-status', !correct ? 'WRONG SYMBOL' : stale ? 'CONNECTION STALE' : f.replay ? 'SIERRA REPLAY' : !f.connected ? 'SIERRA DISCONNECTED' : f.delaySeconds > 1 ? 'DELAYED FEED' : 'CONNECTED');
        text('live-age', `Study update ${(data.ageMs / 1000).toFixed(1)}s ago`);
        text('live-message', !correct ? `Study is on ${f.symbol}; attach it to MNQZ26-CME.` : stale ? 'Sierra is no longer updating this file. Displayed values have been cleared.' : f.replay ? 'These values come from Sierra replay, not a live market.' : !f.connected ? 'Connect Sierra Chart to its data feed.' : !f.bids.length || !f.asks.length ? 'Connected to the study; waiting for market depth. The market may be closed or depth unavailable.' : `Source: Sierra Chart · ${f.symbol} · reported feed delay ${Math.round(f.delaySeconds)}s. Last trade: ${f.trades.length ? dateTime(f.trades[0].timeMs) : 'none received'}.`);
        if (stale || !correct || !f.connected && !f.replay) clearLive();
        else {
          text('last', fmt(f.last));
          text('spread', f.bids.length && f.asks.length ? `${fmt(f.asks[0][0] - f.bids[0][0])} pts` : '—');
          text('bid-depth', String(f.bids.reduce((sum: number, l: number[]) => sum + l[1], 0)));
          text('ask-depth', String(f.asks.reduce((sum: number, l: number[]) => sum + l[1], 0)));
          depth('bids', f.bids, true); depth('asks', f.asks, false);
          $('tape').replaceChildren();
          for (const trade of f.trades.slice(0, 100)) {
            const row = document.createElement('tr'); row.className = trade.side === 'buy' ? 'buy' : 'sell';
            cells(row, [time(trade.timeMs), fmt(trade.price), String(trade.quantity), trade.side === 'buy' ? 'Ask' : 'Bid']); $('tape').append(row);
          }
        }
      }
    }
  } catch (e) { clearLive(); text('live-status', 'CONNECTION ERROR'); text('live-message', String(e)); }
  setTimeout(poll, 250);
}
void poll();

let bars: Bar[] = [], result: ReturnType<typeof backtest> | null = null, cursor = 0, playing = false;
const seek = $<HTMLInputElement>('seek');
function plot(id: string, lines: { values: number[]; color: string }[]) {
  const canvas = $<HTMLCanvasElement>(id), width = canvas.clientWidth || 1000, height = Number(canvas.getAttribute('height'));
  canvas.width = Math.round(width * devicePixelRatio); canvas.height = Math.round(height * devicePixelRatio); canvas.style.height = `${height}px`;
  const c = canvas.getContext('2d')!; c.scale(devicePixelRatio, devicePixelRatio); c.clearRect(0, 0, width, height);
  // Restore the logical height attribute separately from the high-DPI backing size.
  canvas.setAttribute('data-height', String(height));
  const values = lines.flatMap(l => l.values).filter(Number.isFinite); if (!values.length) return;
  let min = Math.min(...values), max = Math.max(...values); if (max === min) { min--; max++; }
  const left = 75, right = width - 16, top = 18, bottom = height - 24;
  c.font = '12px monospace';
  for (let i = 0; i <= 4; i++) { const y = top + (bottom - top) * i / 4; c.strokeStyle = '#253448'; c.beginPath(); c.moveTo(left, y); c.lineTo(right, y); c.stroke(); c.fillStyle = '#9cb0c8'; c.fillText(fmt(max - (max - min) * i / 4), 5, y + 4); }
  for (const line of lines) {
    c.strokeStyle = line.color; c.lineWidth = 1.5; c.beginPath();
    line.values.forEach((v, i) => { const x = left + i / Math.max(1, line.values.length - 1) * (right - left), y = bottom - (v - min) / (max - min) * (bottom - top); if (i) c.lineTo(x, y); else c.moveTo(x, y); }); c.stroke();
  }
}
function drawHistory() {
  if (!bars.length) return;
  const limit = cursor + 1;
  // Keep chart sizing stable through repeated high-DPI renders.
  for (const [id, height] of [['price-chart', 260], ['equity-chart', 180]] as const) $<HTMLCanvasElement>(id).setAttribute('height', String(height));
  const lines = [{ values: bars.slice(0, limit).map(b => b.close), color: '#e4edf7' }];
  if (result) { lines.push({ values: result.fastLine.slice(0, limit), color: '#5de2c0' }, { values: result.slowLine.slice(0, limit), color: '#efbc69' }); }
  plot('price-chart', lines);
  if (result) plot('equity-chart', [{ values: result.equity.slice(0, limit).map(x => x.value), color: '#5de2c0' }]);
  const b = bars[cursor]; text('bar-time', `${dateTime(b.time)} NY · Close ${fmt(b.close)} · Vol ${b.volume}`); seek.value = String(cursor);
}
async function load() {
  const button = $<HTMLButtonElement>('load'); button.disabled = true; $<HTMLButtonElement>('run').disabled = true;
  playing = false; text('play', 'Play history'); result = null; bars = []; $('results').hidden = true;
  text('history-message', 'Reading Sierra trade records and building 1-minute candles…');
  try {
    const data = await api(`history?date=${encodeURIComponent($<HTMLInputElement>('date').value)}`);
    bars = data.bars; cursor = Math.max(0, bars.length - 1); seek.max = String(cursor);
    text('history-message', `${bars.length.toLocaleString()} minute bars from ${data.records.toLocaleString()} records. ${data.aggregatedRecords ? `${data.aggregatedRecords} source records were aggregated by Sierra.` : 'Source contains individual trades.'} Times below are New York; the selected date covers 00:00–24:00 UTC.`);
    $<HTMLButtonElement>('run').disabled = bars.length < 2; $<HTMLButtonElement>('play').disabled = bars.length < 2;
    drawHistory();
  } catch (e) { text('history-message', String(e)); }
  finally { button.disabled = false; }
}
$('load').onclick = load;
$('run').onclick = () => {
  try {
    result = backtest(bars, { fast: +$<HTMLInputElement>('fast').value, slow: +$<HTMLInputElement>('slow').value, fee: +$<HTMLInputElement>('fee').value, slippage: +$<HTMLInputElement>('slip').value });
    $('results').hidden = false; text('net', `$${fmt(result.net)}`); text('trade-count', String(result.trades.length)); text('win-rate', `${(result.winRate * 100).toFixed(1)}%`); text('drawdown', `$${fmt(result.maxDrawdown)}`);
    text('costs', `Gross after slippage: $${fmt(result.gross)} · Commission: $${fmt(result.fees)} · Profit factor: ${result.profitFactor === null ? 'N/A (no losses)' : result.profitFactor.toFixed(2)} · ${result.gaps} regular-session gaps · ${result.gapLiquidations} modeled exits at the next available open after missing data. Missing closing data prevents a guaranteed session-close fill. Full-date results; replay controls only change the chart view.`);
    $('trade-log').replaceChildren();
    for (const trade of result.trades) { const row = document.createElement('tr'); cells(row, [trade.side > 0 ? 'Long' : 'Short', time(trade.entryTime), time(trade.exitTime), fmt(trade.entry), fmt(trade.exit), fmt(trade.net), trade.reason]); $('trade-log').append(row); }
    cursor = bars.length - 1; drawHistory();
  } catch (e) { text('history-message', String(e)); }
};
$('play').onclick = () => { if (cursor >= bars.length - 1) cursor = 0; playing = !playing; text('play', playing ? 'Pause history' : 'Play history'); drawHistory(); };
seek.oninput = () => { cursor = +seek.value; playing = false; text('play', 'Play history'); drawHistory(); };
setInterval(() => { if (!playing || liveMode || !bars.length) return; cursor = Math.min(bars.length - 1, cursor + +$<HTMLSelectElement>('speed').value); if (cursor === bars.length - 1) { playing = false; text('play', 'Play history'); } drawHistory(); }, 1000);
$('export').onclick = () => {
  if (!result) return;
  const rows = ['side,entry_utc,exit_utc,entry_price,exit_price,gross,fees,net,exit_reason', ...result.trades.map(t => [t.side > 0 ? 'long' : 'short', new Date(t.entryTime).toISOString(), new Date(t.exitTime).toISOString(), t.entry, t.exit, t.gross.toFixed(2), t.fees.toFixed(2), t.net.toFixed(2), t.reason].join(','))];
  const url = URL.createObjectURL(new Blob([rows.join('\r\n')], { type: 'text/csv' })); const link = document.createElement('a'); link.href = url; link.download = `MNQ-${$<HTMLInputElement>('date').value}-trades.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
window.addEventListener('resize', drawHistory);
void api('info').then(info => { const first = new Date(info.firstMs).toISOString().slice(0, 10), last = new Date(info.lastMs).toISOString().slice(0, 10); const input = $<HTMLInputElement>('date'); input.min = first; input.max = last; input.value = last; text('history-range', `Available ${first} to ${last} UTC`); }).catch(e => text('history-range', String(e)));
selectTab(new URLSearchParams(location.search).get('mode') !== 'history');
