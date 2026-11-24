/** Live Sierra data rendered by the same nine components as the sample replay. */
import { PerformanceGrid } from './performance-grid';
import { el, esc, sp } from './dom';
import { clock } from './fmt';
import { addModeNavigation } from './original-live';
import { LiveSessionBuffer } from './live-session';
import { validateLiveFrame, type LiveFrame } from './live-frame';
import { ReplaySimulation, type SimulationSnapshot } from './replay-simulation';
import { EngineJournal } from './engine-journal';
import {DeepModel} from './deep-model';
import { validateSierraAccount, type SierraAccount } from './sierra-account';
import { SierraAccountView } from './sierra-account-view';
import type { Session } from './session';
import { Panel } from './panels/base';
import { BookPanel } from './panels/book';
import { QueuePanel } from './panels/queue';
import { LatencyPanel } from './panels/latency';
import { FillsPanel } from './panels/fills';
import { MarketPanel } from './panels/market';
import { TapePanel } from './panels/tape';
import { LogPanel } from './panels/log';
import { EnginePanel } from './panels/engine';
import {WeekPanel} from './panels/week';
import { CollectorPanel } from './panels/collector';

export async function startLiveDashboard(root: HTMLElement): Promise<void> {
  await Promise.all([document.fonts.load('16px VGA'), document.fonts.load('8px EGA8')]).catch(() => {});
  new LiveDashboard(root).start();
}

type KillStatus = { active: boolean; id: string; reason: string; ioError: string; cancellationFailures: unknown[] };
type PaperOptions = { strategy: 'queue' | 'liquidity'; levels: number };
const killUrl = '/api/mnq/kill-switch';

class LiveDashboard {
  private options: PaperOptions = { strategy: 'liquidity', levels: 3 };
  private simulation = this.emptySimulation();
  private readonly paperId = crypto.randomUUID();
  private paperRevision = 0;
  private learning = true;
  private profile: Awaited<ReturnType<EngineJournal['profile']>> | null = null;
  private killStatus: KillStatus | null = null;
  private killError = '';
  private killPending = false;
  private killRevision = 0;
  private readonly killLabel: HTMLElement;
  private readonly killButton: HTMLButtonElement;
  private readonly killReset: HTMLButtonElement;
  private readonly journal = new EngineJournal();
  private readonly deep=new DeepModel();
  private stream:EventSource|null=null;
  private queuedFrame:any=null; private processing=false;
  private followSierra=new URLSearchParams(location.search).get('account')==='sierra' && new URLSearchParams(location.search).get('panels')==='sierra';
  private receiveFrame(data:any):void{this.queuedFrame=data;if(!this.processing)void this.drain();}
  private async drain(){this.processing=true;try{while(this.queuedFrame&&!this.stopped){const data=this.queuedFrame;this.queuedFrame=null;await this.poll(data);}}finally{this.processing=false;}}
  private readonly journalLabel: HTMLElement;
  private readonly buffer = new LiveSessionBuffer();
  private readonly header: HTMLElement;
  private readonly work: HTMLElement;
  private readonly status: HTMLElement;
  private readonly keys: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private panels: Panel[] = [];
  private session: Session | null = null;
  private frame: LiveFrame | null = null;
  private sourceAge = Infinity;
  private receivedAt = 0;
  private enabled = true;
  private stopped = false;
  private failed = false;
  private message = 'Waiting for Sierra market data…';
  private focus: string | null;
  private layout: 'landscape' | 'portrait';
  private showKeys: boolean;
  private progressAt = 0;
  private readonly performance:PerformanceGrid;
  private readonly sierraMode = new URLSearchParams(location.search).get('account') === 'sierra';
  private accountView: SierraAccountView | null = null;
  private account: SierraAccount | null = null;

  constructor(private readonly root: HTMLElement) {
    const query = new URLSearchParams(location.search);
    const zoom = Math.max(1, Math.min(3, parseInt(query.get('zoom') ?? '') || (window.innerWidth >= 1800 ? 2 : 1)));
    root.className = `zoom-${zoom} live-dashboard`;
    this.focus = query.get('panel');
    this.layout = query.get('layout') === 'portrait' ? 'portrait' : 'landscape';
    this.showKeys = query.get('keys') !== '0';
    this.header = el('div', 'bar', root);
    const nav = addModeNavigation(root, this.sierraMode ? 'sierra-live' : 'live');
    nav.append('  │  ');
    this.toggle = el('button', 'paper-inline-control', nav);
    this.toggle.type = 'button';
    this.toggle.title = 'Orders modeled from incoming Sierra data. No broker orders.';
    this.toggle.onclick = () => { this.enabled = !this.enabled; this.reset(); };
    nav.append(' ');
    const reset = el('button', 'paper-inline-control', nav);
    reset.type = 'button'; reset.textContent = this.sierraMode ? 'Reset engine only' : 'Reset account';
    reset.title = 'Start a fresh account from the next observed update.';
    reset.onclick = () => this.reset();
    nav.append('  │  ');
    this.killButton = el('button', 'paper-inline-control', nav);
    this.killButton.type = 'button';
    this.killButton.textContent = 'Emergency stop';
    this.killButton.title = 'Block new paper orders and cancel all outstanding engine paper orders.';
    this.killButton.onclick = () => void this.changeKill('activate');
    nav.append(' ');
    this.killReset = el('button', 'paper-inline-control', nav);
    this.killReset.type = 'button';
    this.killReset.textContent = 'Authorize paper orders';
    const resetForm = el('form', '', nav);
    resetForm.hidden = true;
    resetForm.style.display = 'inline-flex';
    const token = el('input', '', resetForm);
    token.type = 'password';
    token.autocomplete = 'off';
    token.placeholder = 'Reset token';
    token.setAttribute('aria-label', 'Kill-switch reset token');
    const authorize = el('button', 'paper-inline-control', resetForm);
    authorize.type = 'submit';
    authorize.textContent = 'Confirm authorization';
    resetForm.onsubmit = event => {
      event.preventDefault();
      const value = token.value;
      token.value = '';
      resetForm.hidden = true;
      void this.changeKill('reset', value);
    };
    this.killReset.onclick = () => {
      resetForm.hidden = !resetForm.hidden;
      if (!resetForm.hidden) token.focus();
    };
    nav.append(' ');
    this.killLabel = el('span', '', nav);
    this.killLabel.setAttribute('role', 'status');
    nav.append('  │  ');
    const strategyLabel = el('label', 'live-strategy-control', nav);
    strategyLabel.append('Strategy ');
    const strategy = el('select', 'paper-inline-control', strategyLabel);
    strategy.setAttribute('aria-label', 'Strategy');
    for (const [value, text] of [['liquidity', 'Liquidity zones'], ['queue', 'Original queue maker']]) {
      const option = el('option', '', strategy); option.value = value; option.textContent = text;
    }
    nav.append('  ');
    const levelsLabel = el('label', 'live-strategy-control', nav);
    levelsLabel.append('Queues per side ');
    const levels = el('select', 'paper-inline-control', levelsLabel);
    levels.setAttribute('aria-label', 'Queues per side');
    for (const value of [1, 3, 5]) { const option = el('option', '', levels); option.value = String(value); option.textContent = String(value); }
    levels.value = '3';
    const changeStrategy = () => {
      levels.disabled = strategy.value === 'queue';
      this.reset({ strategy: strategy.value as 'queue' | 'liquidity', levels: Number(levels.value) });
    };
    strategy.onchange = levels.onchange = changeStrategy;
    strategy.title = levels.title = 'Changing strategy or queue count starts a fresh simulated account.';
    nav.append('  │  ');
    const learning=el('button','paper-inline-control',nav);learning.textContent='Learning: On';learning.setAttribute('aria-pressed','true');
    learning.title='Reviews every 20 completed engine trades. Adjusts entry filters and cooldown within fixed risk limits.';
    learning.onclick=()=>{const on=learning.getAttribute('aria-pressed')!=='true';learning.setAttribute('aria-pressed',String(on));learning.textContent=`Learning: ${on?'On':'Off'}`;this.learning=on;};
    nav.append('  ');this.journalLabel=el('span','',nav);this.journalLabel.textContent=this.journal.status;
    this.journalLabel.title='Saved in HFTENGINE / Engine History. Each tab and reset has its own run. Records received data, modeled orders, trades, P&L and learning decisions.';
    if (this.sierraMode) {
      nav.append('  ');const source=el('button','paper-inline-control',nav);source.textContent=this.followSierra?'Panels: Sierra account':'Panels: Engine model';
      source.title='Follow the orders placed in Sierra, or inspect the independent engine model.';
      source.onclick=()=>{this.followSierra=!this.followSierra;const query=new URLSearchParams(location.search);query.set('panels',this.followSierra?'sierra':'engine');history.replaceState(null,'',location.pathname+'?'+query);source.textContent=this.followSierra?'Panels: Sierra account':'Panels: Engine model';for(const p of this.panels)p.invalidate();this.render();};
      this.accountView = new SierraAccountView(root);
    }
    this.work = el('div', 'work landscape', root);
    this.work.textContent = this.message;
    this.status = el('div', 'bar status', root);
    this.keys = el('div', 'bar', root);
    this.keys.innerHTML = sp('k', 'SPACE') + ' orders on/off  ' + sp('k', '1-9') + ' panel  ' + sp('k', '0') + ' all  '
      + sp('k', 'L') + ' layout  ' + sp('k', 'R') + ' reset account  ' + sp('k', 'B') + ' ladder  ' + sp('k', 'H') + ' keys';
    this.performance=new PerformanceGrid(root,'live');
    window.addEventListener('resize', () => { for (const p of this.panels) p.invalidate(); this.render(); });
    root.addEventListener('weekdock',()=>{this.focus=null;this.layout='landscape';this.applyLayout();this.render();});
    window.addEventListener('keydown', event => this.onKey(event));
    window.addEventListener('pagehide', () => {
      this.stopped = true;
      navigator.sendBeacon('/api/mnq/paper/close?session=' + this.paperId);
    }, { once: true });
  }

  start(): void {
    this.render();
    void this.refreshKill();
    void Promise.all([this.journal.profile(),this.deep.refresh()]).then(([profile])=>{
      this.profile=profile;if(this.stopped)return;
      this.stream=new EventSource('/api/mnq/stream');
      this.stream.onmessage=event=>{try{this.receiveFrame(JSON.parse(event.data));}catch{this.failed=true;}};
      this.stream.onerror=()=>{this.failed=true;this.message='Reconnecting to Sierra updates…';this.render();};
      const refresh=window.setInterval(()=>{if(!this.stopped)void this.deep.refresh();},10000);
      const stale=window.setInterval(()=>{void this.refreshKill();this.render();},1000);
      window.addEventListener('pagehide',()=>{this.stream?.close();clearInterval(refresh);clearInterval(stale);},{once:true});
    });
  }

  private emptySimulation(): SimulationSnapshot {
    return new ReplaySimulation({ ...this.options, allowLive: true, latency: 'variable', adaptive: true }).snapshot();
  }

  private reset(options?: PaperOptions): void {
    if (options) this.options = options;
    this.paperRevision++;
    if (this.killStatus?.active || this.simulation.status === 'blocked') {
      this.render();
      return;
    }
    this.simulation = this.emptySimulation();
    this.progressAt = 0;
    if (this.session) {
      for(const p of this.panels)if(p instanceof WeekPanel)p.dispose();
      this.session = null; this.panels = []; this.work.replaceChildren();
      this.work.textContent = 'Starting a fresh account…';
    }
    this.render();
  }

  private async refreshKill(): Promise<void> {
    if (this.killPending) return;
    const revision = this.killRevision;
    try {
      const response = await fetch(killUrl, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw Error('Kill-switch status unavailable');
      const status: KillStatus = await response.json();
      if (revision === this.killRevision && !this.killPending) this.killStatus = status;
    } catch {
      if (revision === this.killRevision && !this.killPending) this.killStatus = null;
    }
    this.render();
  }

  private async changeKill(action: 'activate' | 'reset', token?: string): Promise<void> {
    if (this.killPending || (action === 'reset' && !this.killStatus?.active)) return;
    this.killRevision++;
    this.killPending = true;
    this.killError = '';
    const headers = token === undefined ? undefined : {
      Authorization: `Bearer ${token}`,
      'X-Kill-Switch-Id': this.killStatus!.id,
    };
    this.render();
    try {
      const response = await fetch(`${killUrl}/${action}`, {
        method: 'POST', headers, signal: AbortSignal.timeout(5000),
      });
      const status = await response.json();
      if (typeof status.active === 'boolean') this.killStatus = status;
      if (!response.ok) {
        this.killError = response.status === 403 ? 'Authorization rejected' : 'Kill-switch request rejected';
      }
    } catch {
      this.killStatus = null;
      this.killError = 'Kill-switch request could not be confirmed';
    } finally {
      this.killPending = false;
      this.render();
    }
  }

  private async updateSimulation(publication?: number, publishedMs?: number): Promise<boolean> {
    const revision = this.paperRevision;
    const killRevision = this.killRevision;
    const response = await fetch('/api/mnq/paper', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(3000),
      body: JSON.stringify({
        session: this.paperId, revision, ...this.options, enabled: this.enabled, learning: this.learning,
        profile: this.profile, publication, publishedMs,
      }),
    });
    if (revision !== this.paperRevision || this.stopped) return false;
    if (!response.ok) throw Error('Paper execution unavailable');
    const body = await response.json();
    if (revision !== this.paperRevision || killRevision !== this.killRevision || this.stopped) return false;
    this.simulation = body.simulation;
    return true;
  }

  private async poll(data:any): Promise<void> {
    try {
      if (data.error) throw Error(data.error);
      this.failed = false;
      if (!data.available || !data.frame) {
        this.account = null;
        this.sourceAge = Infinity; this.message = data.message || 'Waiting for Sierra market data…';
      } else {
        const next = validateLiveFrame(data.frame);
        this.account = this.sierraMode ? validateSierraAccount(data.frame.sierraAccount, next.symbol) : null;
        const received = Date.now();
        const currentModel=this.simulation;
        this.performance.updateLive(next.symbol,currentModel.strategy,currentModel.strategyVersion,currentModel.executionVersion);
        const previousTime = this.simulation.sourceTimeMs;
        this.sourceAge = Math.max(0, Number(data.ageMs) || 0, received - next.publishedMs);
        this.receivedAt = received;
        this.message = '';
        const historyReady=await this.journal.retry();
        if (this.stopped || this.killPending) return;
        const canProcess = this.sourceAge + Date.now() - received <= 5000 && next.connected && historyReady;
        if (!await this.updateSimulation(canProcess ? data.publication : undefined, next.publishedMs)) return;
        if (this.simulation.sourceTimeMs !== previousTime) this.progressAt = received;
        await this.journal.record(next,this.simulation,received,this.sourceAge<=5000&&next.connected);
        if (!this.session || this.frame?.publishedMs !== next.publishedMs) {
          this.session = this.buffer.accept(next, this.simulation, received);
          if (this.sierraMode) this.session.meta.live.sierraAccount = this.account;
          if (!this.panels.length) this.createPanels(this.session);
          else for (const panel of this.panels) panel.updateSession(this.session);
        }
        this.frame = next;
      }
    } catch (error) {
      this.failed = true; this.message = error instanceof Error ? error.message : String(error);
    }
    this.render();

  }

  private createPanels(session: Session): void {
    this.panels = [new BookPanel(session), new QueuePanel(session), new LatencyPanel(session), new FillsPanel(session),
      new MarketPanel(session), new TapePanel(session), new LogPanel(session), new EnginePanel(session), new CollectorPanel(session), new WeekPanel(session)];
    const book = this.panels[0] as BookPanel;
    book.mode = new URLSearchParams(location.search).get('ladder') === 'ticks' ? 'ticks' : 'levels';
    this.applyLayout();
  }

  private applyLayout(): void {
    if (this.focus && !this.panels.some(p => p.key === this.focus)) this.focus = null;
    this.work.replaceChildren();
    this.work.className = this.focus ? 'work focus' : `work ${this.layout}`;
    const visible = this.focus ? this.panels.filter(p => p.key === this.focus)
      : this.layout === 'portrait' ? this.panels.filter(p => p.key === 'book' || p.key === 'queue') : this.panels;
    for (const panel of visible) {
      panel.el.style.gridArea = !this.focus && this.layout === 'landscape' ? panel.key : 'auto';
      panel.mount(this.work); panel.invalidate();
    }
    this.keys.style.display = this.showKeys ? '' : 'none';
    const query = new URLSearchParams(location.search);
    if (this.focus) query.set('panel', this.focus); else query.delete('panel');
    query.set('layout', this.layout);
    if (this.showKeys) query.delete('keys'); else query.set('keys', '0');
    const book = this.panels[0] as BookPanel | undefined;
    if (book) query.set('ladder', book.mode);
    history.replaceState(null, '', `${location.pathname}?${query}`);
  }

  private onKey(event: KeyboardEvent): void {
    if (event.ctrlKey || event.altKey || event.metaKey || (event.target instanceof HTMLElement && event.target.closest('a,button,input,select,textarea'))) return;
    const key = event.key.toLowerCase();
    if (key === ' ') { this.enabled = !this.enabled; this.reset(); }
    else if (key === 'r') this.reset();
    else if (key === 'l') this.layout = this.layout === 'landscape' ? 'portrait' : 'landscape';
    else if (key === 'h') this.showKeys = !this.showKeys;
    else if (key === 'b' && this.panels.length) {
      const book = this.panels[0] as BookPanel; book.mode = book.mode === 'levels' ? 'ticks' : 'levels';
    } else if (key === '0') this.focus = null;
    else {
      const panel = this.panels.find(p => String(p.num) === key);
      if (!panel) return;
      this.focus = this.focus === panel.key ? null : panel.key;
    }
    event.preventDefault(); this.applyLayout(); this.render();
  }

  private render(): void {
    const frame = this.frame;
    const age = this.sourceAge + Math.max(0, Date.now() - this.receivedAt);
    const stale = this.failed || age > 5000;
    this.accountView?.render(this.account, stale);
    this.journalLabel.textContent=this.journal.status;
    const state = !frame ? 'WAITING' : stale ? 'STALE' : !frame.connected ? 'DISCONNECTED'
      : frame.replay ? 'SIERRA REPLAY' : 'LIVE';
    const stateClass = stale || state === 'DISCONNECTED' ? 'r' : state === 'LIVE' ? 'g' : 'y';
    const sim = this.simulation;
    const kill = this.killStatus;
    const cancellationFailures = kill?.cancellationFailures.length ?? 0;
    this.killLabel.textContent = this.killError || (this.killPending ? 'Kill-switch request pending'
      : !kill ? 'Kill switch unavailable' : kill.ioError || (kill.active
        ? cancellationFailures ? `Emergency stop · ${cancellationFailures} cancellation failures` : 'Emergency stop active'
        : 'Paper routing authorized'));
    this.killLabel.title = kill?.reason ?? '';
    this.killLabel.className = kill?.active === false && !this.killError ? 'g' : 'r';
    this.killButton.disabled = this.killPending;
    this.killReset.disabled = this.killPending || !kill?.active;
    const supported = frame && /^MNQZ26-CME(?:\[M\])?$/i.test(frame.symbol) && frame.tickSize === .25;
    const simState = kill?.active !== false || sim.status === 'blocked' ? 'BLOCKED' : !this.enabled ? 'OFF' : !supported ? 'WAITING' : stale || !frame?.connected ? 'FROZEN'
      : sim.status === 'running' && Date.now() - this.progressAt < 3000 ? 'RUNNING' : 'WAITING FOR TRADES';
    this.header.innerHTML = sp('hi', ' HFTENGINE ') + ` ${this.sierraMode ? 'Sierra Engine' : 'Sierra Chart'}  │  ${esc(frame?.symbol ?? 'MNQZ26-CME')}  │  `
      + sp(stateClass, state) + '  │  ' + sp('y', `ENGINE ${simState}`);
    this.toggle.textContent = `${this.sierraMode ? 'Engine orders' : 'Orders'}: ${this.enabled ? 'On' : 'Off'}`;
    this.toggle.setAttribute('aria-pressed', String(this.enabled));
    this.root.classList.toggle('feed-stale', stale);
    if (this.session) {
      this.session.meta.live.historyStatus=this.journal.status;
      this.session.meta.live.deep=this.deep.state;
      this.session.meta.live.followSierra=this.followSierra;
      this.session.meta.live.chartUpdateMs=frame?.chartUpdateMs;
      this.session.meta.live.bridgeIntervalMs=frame?.bridgeIntervalMs;
      this.session.meta.live.state = simState;
      this.session.meta.live.snapshotAgeMs = age;
      this.session.meta.live.message = this.message;
      const context = { t: this.session.endT, f: this.session.nFrames - 1, playing: simState === 'RUNNING', speed: 1 };
      for (const panel of this.panels) if (panel.el.isConnected) panel.render(context);
      this.status.innerHTML = sp(stateClass, ` ${state} `) + '  │  ' + sp('v', clock(this.session.t0, context.t, true))
        + ` UTC  │  position ${sp('v', String(this.followSierra?this.account?.position?.quantity??0:sim.position))}  │  ${sp('v', String(this.followSierra?this.account?.fills.length??0:sim.fillCount))} fills`
        + `  │  snapshot ${(age / 1000).toFixed(1)}s  │  feed delay ${(frame?.delaySeconds ?? 0).toFixed(1)}s`;
    } else {
      this.work.textContent = this.message || 'Waiting for the next Sierra snapshot…';
      this.status.textContent = `${state}  │  ENGINE ${simState}  │  ${this.message}`;
    }
  }
}

