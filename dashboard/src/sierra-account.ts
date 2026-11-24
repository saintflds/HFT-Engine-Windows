/** Read-only Sierra account snapshots. Never merged into the engine's simulated ledger. */
export type SierraOrder = {
  id: number; side: 'buy' | 'sell'; type: string; status: string; working: boolean;
  quantity: number; filled: number; price: number; price2: number; parentId: number;
  role: 'STOP' | 'TP' | 'ENTRY'; updatedMs: number; entryMs?:number; queueEstimate?:number|null;
};
export type SierraFill = { key: string; orderId: number; side: 'buy' | 'sell'; quantity: number; price: number; timeMs: number };
export type SierraAccount = {
  version: 1; account: string; symbol: string; simulation: boolean; chartNumber: number;
  position: { quantity: number; averagePrice: number; openPnl: number; dailyPnl: number } | null;
  orders: SierraOrder[]; fills: SierraFill[]; totalFills: number; ordersTruncated: boolean;
};
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positiveId = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const side = (v: unknown) => v === 'buy' || v === 'sell';
const symbolKey = (v: string) => v.toUpperCase().replace(/\[M\]$/, '');

export function validateSierraAccount(raw: unknown, symbol: string): SierraAccount | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as SierraAccount;
  if (a.version !== 1 || typeof a.account !== 'string' || !a.account || a.account.length > 100
    || typeof a.symbol !== 'string' || symbolKey(a.symbol) !== symbolKey(symbol)
    || typeof a.simulation !== 'boolean' || !Number.isSafeInteger(a.chartNumber)
    || !Array.isArray(a.orders) || !Array.isArray(a.fills)) return null;
  // A live trading account must never masquerade as the requested Sierra sim account.
  if (!a.simulation) return { ...a, position: null, orders: [], fills: [], totalFills: 0, ordersTruncated: false };
  const orders = a.orders.filter(o => o && positiveId(o.id) && side(o.side)
    && typeof o.type === 'string' && typeof o.status === 'string' && typeof o.working === 'boolean'
    && finite(o.quantity) && o.quantity > 0 && finite(o.filled) && o.filled >= 0 && o.filled <= o.quantity
    && finite(o.price) && o.price >= 0 && finite(o.price2) && o.price2 >= 0
    && Number.isSafeInteger(o.parentId) && o.parentId >= 0 && finite(o.updatedMs)
    && (o.entryMs === undefined || (finite(o.entryMs) && o.entryMs >= 0))
    && (o.queueEstimate == null || (Number.isSafeInteger(o.queueEstimate) && o.queueEstimate >= 0))
    && ['STOP', 'TP', 'ENTRY'].includes(o.role)).slice(0, 200);
  const seen = new Set<string>();
  const fills = a.fills.filter(f => {
    if (!f || typeof f.key !== 'string' || f.key.length > 200 || seen.has(f.key)
      || !positiveId(f.orderId) || !side(f.side) || !finite(f.quantity) || f.quantity <= 0
      || !finite(f.price) || f.price <= 0 || !finite(f.timeMs) || f.timeMs <= 0) return false;
    seen.add(f.key); return true;
  }).sort((x, y) => x.timeMs - y.timeMs).slice(-300);
  const p = a.position;
  const position = p && [p.quantity, p.averagePrice, p.openPnl, p.dailyPnl].every(finite) ? p : null;
  return { ...a, orders, fills, position, totalFills: Number.isSafeInteger(a.totalFills) ? Math.max(fills.length, a.totalFills) : fills.length,
    ordersTruncated: a.ordersTruncated === true };
}

export function sierraChartFills(account: SierraAccount | null | undefined, t0Ms: number, startNs: number, endNs: number): SierraFill[] {
  return account?.simulation ? account.fills.filter(f => {
    const t = (f.timeMs - t0Ms) * 1e6; return t >= startNs && t <= endNs;
  }) : [];
}
