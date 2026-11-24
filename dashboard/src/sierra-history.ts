import { PerformanceGrid } from './performance-grid';
import { el } from './dom';
import { addModeNavigation } from './original-live';

type SourceMode = 'quotes' | 'depth';
type DepthDate = { date: string; records: number; firstMs: number | null; lastMs: number | null; hasOverlap: boolean };
type QuoteDate = { date: string; firstMs: number; lastMs: number };
type EngineInfo = {
  symbol: string;
  symbols: string[];
  dates: DepthDate[];
  quoteDates: QuoteDate[];
  firstTradeMs: number;
  lastTradeMs: number;
  quoteDateChoicesLimited: boolean;
  defaultSource: SourceMode;
  runnerReady: boolean;
  job: { running: boolean; session: string; log: string; error: string };
};

export async function startSierraHistory(root: HTMLElement): Promise<void> {
  root.className = 'zoom-1 sierra-history';
  el('div', 'bar', root).textContent = 'HFTENGINE  │  MNQ  │  SIERRA ENGINE / HISTORICAL';
  addModeNavigation(root, 'history');
  const content = el('div', 'sierra-history-content', root);
  el('pre', '', content).textContent = 'YOUR DOWNLOADED HISTORY\nThis page reads the larger archive on your hard drive. Choose a contract, Recorded market depth, date and time below to build a replay. The MNQ 30min replay tab opens one prepared full-depth clip; it is not the entire archive. Some dates or contracts can still have missing depth.';
  el('pre', '', content).textContent = 'Run historical MNQ data through the original Rust / hftbacktest engine.\nOpen the result in the original book, queue, fills, latency and engine panels.\n\nRecorded Sierra timestamps are used for exchange and local events. Actual feed latency is unknown and modeled as zero; order latency and fees are assumptions. Queue position and fills are model estimates.';
  const state = el('p', '', content); state.textContent = 'Sierra engine is waiting for trades — checking recorded data…';
  const form = el('form', 'sierra-controls', content);
  const label = (name: string) => { const field = el('label', '', form); field.append(name); return field; };
  const contract = el('select', '', label('Contract'));
  const initialContract = el('option', '', contract); initialContract.value = 'MNQZ26-CME'; initialContract.textContent = 'MNQZ26-CME';
  const source = el('select', '', label('Data source'));
  for (const [value, text] of [['quotes', 'Quote model'], ['depth', 'Recorded market depth']]) {
    const option = el('option', '', source); option.value = value; option.textContent = text;
  }
  const date = el('select', '', label('Date (UTC)'));
  const start = el('input', '', label('Start (UTC)')); start.type = 'time'; start.value = '13:30'; start.required = true;
  const minutes = el('input', '', label('Minutes')); minutes.type = 'number'; minutes.min = '1'; minutes.max = '60'; minutes.value = '30';
  const strategy = el('select', '', label('Strategy'));
  for (const [value, text] of [['queue','Original queue market making'], ['grid','Original grid market making'], ['ema','9/21 EMA on completed 1m bars']]) {
    const option = el('option', '', strategy); option.value = value; option.textContent = text;
  }
  const fee = el('input', '', label('Fee / contract / side ($)')); fee.type = 'number'; fee.min = '0'; fee.max = '100'; fee.step = '0.01'; fee.value = '0.75';
  const latency = el('input', '', label('Latency each way (µs)')); latency.type = 'number'; latency.min = '0'; latency.max = '1000000'; latency.value = '10000';
  const run = el('button', '', form); run.type = 'submit'; run.textContent = 'Run Sierra engine'; run.disabled = true;
  const sourceExplanation = el('pre', '', content);
  const strategyExplanation = el('p', '', content);
  const explainStrategy = () => {
    const ema = strategy.value === 'ema';
    minutes.min = ema ? '22' : '1';
    if (ema && +minutes.value < 22) minutes.value = '30';
    strategyExplanation.textContent = ema
      ? 'EMA starts with 30 minutes. The first 21 completed one-minute trade bars warm up the averages; orders can begin after that when a crossover occurs. Choose at least 22 minutes. Sparse data or no crossover can still produce no trades.'
      : 'Queue and grid market making start with a 30-minute historical window and use the selected recorded or modeled quotes immediately. Change Minutes to choose a shorter or longer interval, up to 60 minutes.';
  };
  strategy.onchange = explainStrategy;
  explainStrategy();
  el('pre', '', content).textContent = 'MNQ: 0.25-point tick │ 1 contract │ $2 per point │ max position 1 contract\nDefault costs: $0.75 per contract per side and 10 ms order latency each way. Enter your own assumptions.\nThese strategies are research examples; historical results do not validate profitability.';
  const log = el('pre', 'sierra-job-log', content); log.setAttribute('role', 'status');
  const open = el('a', 'sierra-open-session', content); open.hidden = true; open.textContent = 'Open result in original HFTENGINE →';
  el('pre', '', content).textContent = 'RECORDED DEPTH OPTION\nKeep Market Depth Historical Graph on your MNQ chart while connected. For past dates, download historical depth if your feed supports it. This option requires matching native depth and individual trades.\nQuote model can use your existing individual trade file without recorded depth.';
  const lab = el('a', '', content); lab.href = '/mnq.html?mode=history'; lab.textContent = 'Optional: separate bar-based EMA test lab (trades only)';
  const selected: Record<SourceMode, string> = { quotes: '', depth: '' };
  let running = false, ready = false, sourceInitialized = false, refreshing = false, inventoryAt = 0, info: EngineInfo | null = null;

  function update(choicesChanged = false): void {
    if (!info) return;
    const mode = source.value as SourceMode;
    const choices = mode === 'quotes' ? info.quoteDates : info.dates;
    const usable = choices.filter(item => !('hasOverlap' in item) || item.hasOverlap);
    if (choicesChanged) {
      date.replaceChildren();
      for (const item of choices) {
        const option = el('option', '', date); option.value = item.date;
        if ('records' in item) {
          option.textContent = `${item.date} (${item.records.toLocaleString()} depth records${item.hasOverlap ? '' : '; no matching trades'})`;
          option.disabled = !item.hasOverlap;
        } else option.textContent = item.date;
      }
      date.value = usable.some(item => item.date === selected[mode]) ? selected[mode] : usable[0]?.date || '';
      selected[mode] = date.value;
    }
    sourceExplanation.textContent = mode === 'quotes'
      ? 'QUOTE MODEL\nUses actual Sierra bid/ask quote prices and individual trade prints. Bid and ask sizes are assumed to be 1 contract because the trade file does not contain recorded Level 2 depth. The original engine estimates orders, queues, fills and P&L from that modeled book. This is not a reconstruction of historical market depth.\nDate choices cover the stored trade-file range; weekends and gaps may have no ticks for your selected interval.'
      : 'RECORDED MARKET DEPTH\nUses Sierra native market-depth updates and matching individual trades. No depth prices or sizes are generated. A complete two-sided starting snapshot and coverage of the selected interval are required. Queue positions and strategy fills remain estimates from the original engine.';
    if (!ready) state.textContent = 'Sierra engine is waiting for setup — the original runner is not ready yet.';
    else if (running) state.textContent = 'Sierra engine is running — building your historical session…';
    else if (info.job.error) state.textContent = 'Sierra engine is waiting for trades — the previous run could not finish. See the details below.';
    else if (info.job.session) state.textContent = 'Sierra engine session is ready — open the result below.';
    else if (!usable.length) state.textContent = mode === 'quotes'
      ? 'Sierra engine is waiting for trades — no stored MNQ trade dates are available.'
      : 'Sierra engine is waiting for trades — no matching depth interval is available. Choose Quote model to use existing Sierra trade history, or record/download matching depth.';
    else state.textContent = `Sierra engine is waiting for trades — ${usable.length} ${mode === 'quotes' ? 'candidate trade' : 'depth'} dates available. Choose a date and start time, then run.`;
    const ranges = info.dates.filter(item => item.firstMs !== null).map(item => `${item.date}: depth ${new Date(item.firstMs!).toISOString()} to ${new Date(item.lastMs!).toISOString()}`);
    state.title = [...ranges, `Stored trade range: ${new Date(info.firstTradeMs).toISOString()} to ${new Date(info.lastTradeMs).toISOString()}`,
      ...(info.quoteDateChoicesLimited ? ['Quote date choices are limited to the most recent 366 calendar dates.'] : [])].join('\n');
    run.disabled = running || !ready || !usable.length;
    log.textContent = info.job.log || (running ? 'Sierra engine is running…' : '');
    if (info.job.error) log.textContent += `\n${info.job.error}`;
    open.hidden = !info.job.session || running || Boolean(info.job.error);
    if (!open.hidden) open.href = `/?session=${encodeURIComponent(info.job.session)}`;
  }

  date.onchange = () => { selected[source.value as SourceMode] = date.value; };
  source.onchange = () => update(true);
  contract.onchange = () => { selected.quotes = ''; selected.depth = ''; void refresh(); };
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const requestedContract = contract.value;
      const scan = !info || info.symbol !== requestedContract || Date.now() - inventoryAt >= 30000;
      const response = await fetch(`/api/mnq/engine/${scan ? 'info' : 'status'}?symbol=` + encodeURIComponent(requestedContract), { cache: 'no-store', signal: AbortSignal.timeout(15000) }); const data = await response.json();
      if (contract.value !== requestedContract) return;
      if (!response.ok) throw Error(data.error || 'Cannot inspect Sierra files.');
      if (scan) {
        info = data as EngineInfo; inventoryAt = Date.now();
        contract.replaceChildren(...info.symbols.map(symbol => { const option = document.createElement('option'); option.value = symbol; option.textContent = symbol; return option; }));
        contract.value = info.symbol;
      } else info!.job = data.job;
      ready = info!.runnerReady; running = info!.job.running;
      if (!sourceInitialized) { source.value = info!.defaultSource; sourceInitialized = true; }
      update(scan);
    } catch (error) { state.textContent = `Sierra engine is waiting for trades — ${String(error)}`; run.disabled = true; }
    finally { refreshing = false; }
  }
  form.onsubmit = async event => {
    event.preventDefault(); run.disabled = true; open.hidden = true;
    try {
      const response = await fetch('/api/mnq/engine/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: contract.value, source: source.value, date: date.value, start: start.value, minutes: +minutes.value, fee: +fee.value, latency: +latency.value, strategy: strategy.value }) });
      const data = await response.json(); if (!response.ok) throw Error(data.error || 'Cannot start backtest.'); await refresh();
    } catch (error) { log.textContent = String(error); run.disabled = running || !ready || !date.value; }
  };
  new PerformanceGrid(root,'history');
  await refresh(); const timer = window.setInterval(refresh, 2500);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
}
