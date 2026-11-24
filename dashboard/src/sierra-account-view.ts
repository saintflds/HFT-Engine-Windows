import { el, esc } from './dom';
import type { SierraAccount } from './sierra-account';

/** Separate read-only ledger: engine reset/toggle can never reset a Sierra account. */
export class SierraAccountView {
  private details: HTMLDetailsElement;
  private summary: HTMLElement;
  private metrics: HTMLElement;
  private orders: HTMLElement;
  private fills: HTMLElement;
  constructor(root: HTMLElement) {
    this.details = el('details', 'sierra-account', root); this.details.open = true;
    this.summary = el('summary', '', this.details);
    this.metrics = el('div', 'sierra-account-metrics', this.details);
    const columns = el('div', 'sierra-account-columns', this.details);
    this.orders = el('div', '', columns); this.fills = el('div', '', columns);
    this.render(null, false);
    this.details.ontoggle = () => window.dispatchEvent(new Event('resize'));
  }
  render(a: SierraAccount | null, stale: boolean): void {
    const px = (n: number) => n > 0 ? n.toFixed(2) : '—';
    const money = (n: number) => `<span class="${n < 0 ? 'r' : 'g'}">${n.toFixed(2)}</span>`;
    const utc = (ms: number) => new Date(ms).toISOString().slice(11, 23);
    this.summary.textContent = `SIERRA ACCOUNT${a ? ` · ${a.account} · chart #${a.chartNumber}` : ''} · ${stale ? 'STALE' : !a ? 'WAITING FOR CONNECTION' : a.simulation ? 'SIM ACCOUNT · READ ONLY' : 'SIM MODE REQUIRED'}`;
    if (!a || !a.simulation) {
      this.metrics.textContent = !a ? 'Waiting for the updated HFTENGINE study to publish Sierra orders and fills.' : 'Select your simulation account and enable Trade Simulation Mode in Sierra to show its activity here.';
      this.orders.replaceChildren(); this.fills.replaceChildren(); return;
    }
    const p = a.position, working = a.orders.filter(o => o.working);
    this.metrics.innerHTML = p ? `POSITION <span class="w">${p.quantity}</span>  │  AVG <span class="w">${px(p.averagePrice)}</span>  │  OPEN P&L ${money(p.openPnl)}  │  SIERRA DAILY P&L ${money(p.dailyPnl)}  │  WORKING ${working.length}${a.ordersTruncated ? '+' : ''}` : 'Sierra position statistics are loading…';
    this.metrics.title = 'Sierra-reported values follow its chart trade-statistics and commission settings. Engine account results below remain separate.';
    this.orders.innerHTML = `<div class="c">SIERRA ORDERS · latest status${a.ordersTruncated ? ' · list capped at 200' : ''}</div>` +
      (a.orders.length ? `<table><thead><tr><th>ID</th><th>SIDE</th><th>TYPE</th><th>PRICE</th><th>LEFT</th><th>STATUS</th></tr></thead><tbody>${[...a.orders].sort((x,y)=>Number(y.working)-Number(x.working)||y.updatedMs-x.updatedMs).map(o => `<tr><td>#${o.id}</td><td class="${o.side === 'buy' ? 'bid' : 'ask'}">${o.side.toUpperCase()}</td><td class="${o.role === 'STOP' ? 'r' : o.role === 'TP' ? 'g' : 'c'}">${esc(o.role === 'ENTRY' ? o.type : o.role)}</td><td title="${esc(o.type)}${o.price2 > 0 ? ` · second price ${px(o.price2)}` : ''}">${px(o.price)}</td><td>${o.working ? o.quantity-o.filled : 0}</td><td>${esc(o.status)}</td></tr>`).join('')}</tbody></table>` : '<div class="d">No Sierra orders available for this chart/account.</div>');
    this.fills.innerHTML = `<div class="c">SIERRA EXECUTIONS · ${a.fills.length} / ${a.totalFills} loaded fills · UTC</div>` +
      (a.fills.length ? `<table><thead><tr><th>TIME</th><th>SIDE</th><th>PRICE</th><th>QTY</th><th>ORDER</th></tr></thead><tbody>${a.fills.slice().reverse().map(f=>`<tr><td title="${new Date(f.timeMs).toISOString()}">${utc(f.timeMs)}</td><td class="${f.side === 'buy' ? 'bid' : 'ask'}">${f.side.toUpperCase()}</td><td>${px(f.price)}</td><td>${f.quantity}</td><td>#${f.orderId}</td></tr>`).join('')}</tbody></table>` : '<div class="d">No Sierra fills loaded yet. Chart fill-history settings control availability.</div>');
  }
}
