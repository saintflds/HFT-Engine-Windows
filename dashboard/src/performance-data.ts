import type { Session } from './session';

export type PerformanceDay = {
  date: string;
  net: number;
  gross: number;
  fees: number;
  trades: number;
  wins: number;
  losses: number;
  firstMs: number;
  lastMs: number;
  partial: boolean;
};
export type SessionPerformance = {
  days: PerformanceDay[];
  source: string;
  basis: 'closed-trade-net' | 'marked-net' | 'unavailable';
  available: boolean;
  warning?: string;
  openQuantity: number;
  throughMs: number;
};

const DAY_MS = 86400000;
const EPS = 1e-8;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function unavailable(throughMs: number, warning: string): SessionPerformance {
  return { days: [], source: 'Recorded results', basis: 'unavailable', available: false, warning, openQuantity: 0, throughMs };
}

function finish(days: Map<string, PerformanceDay>, startMs: number, endMs: number): PerformanceDay[] {
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map(day => {
    const start = Date.parse(day.date + 'T00:00:00Z');
    return { ...day, partial: startMs > start || endMs < start + DAY_MS };
  });
}

/**
 * A recording's closed results up to the visible LOCAL response clock.
 * FIFO lots retain entry fees until their quantity closes. The closing execution
 * owns the result's UTC date; open inventory never creates a closed-trade win.
 *
 * Exact fee attribution needs an explicit fee model and an unambiguous rate.
 * When maker/taker rates differ (the bundled crypto sample), recorded account
 * equity can instead supply a separately labeled marked-change calendar.
 */
export function sessionPerformanceDays(s: Session, t: number): SessionPerformance {
  const endT = Number(s.endT);
  const limit = t === Infinity ? endT : Math.max(0, Math.min(t, endT));
  let origin: number;
  try {
    const ns = BigInt(s.t0);
    origin = Number(ns / 1000000n) + Number(ns % 1000000n) / 1000000;
  } catch { return unavailable(0, 'Recording has no valid source clock.'); }
  const throughMs = origin + limit / 1e6;
  if (![origin, limit, throughMs].every(Number.isFinite) || !finite(endT) || endT < 0
    || Math.abs(throughMs) > 8.64e15) return unavailable(0, 'Recording has no valid source clock.');
  if (s.meta.live) return unavailable(throughMs, 'Use the saved live engine history for daily results.');

  const asset = s.meta.models?.asset, fee = s.meta.models?.fee;
  const multiplier = asset?.contract_size;
  const rate = fee?.maker;
  const explicitRate = finite(rate) && finite(fee?.taker) && rate === fee.taker;
  const supportedFee = fee?.kind === 'TradingQtyFeeModel' || fee?.kind === 'TradingValueFeeModel';
  if (asset?.kind !== 'LinearAsset' || !finite(multiplier) || multiplier <= 0 || !explicitRate || !supportedFee) {
    return markedPerformance(s, origin, limit, throughMs,
      'Closed-trade fees cannot be identified from this recording; marked account changes are shown when recorded accounting is available.');
  }
  if (!finite(s.tickSize) || s.tickSize <= 0) return unavailable(throughMs, 'Recording has no valid tick size.');

  type Lot = { side: number; price: number; quantity: number; feePerUnit: number; entryMs: number };
  const lots: Lot[] = [];
  const days = new Map<string, PerformanceDay>();
  const indices: number[] = [];
  for (let i = 0; i < s.eKind.length; i++) if (s.eKind[i] === 3) {
    if (!finite(s.eT[i])) return unavailable(throughMs, 'A fill has no valid response timestamp; no daily result was inferred.');
    if (s.eT[i] <= limit) indices.push(i);
  }
  indices.sort((a, b) => s.eT[a] - s.eT[b] || a - b);

  for (const i of indices) {
    const qty = s.eQty[i], side = s.eSide[i], price = s.eExecTick[i] * s.tickSize;
    const received = s.eT[i], exchange = s.eExchT[i];
    const exitMs = origin + (finite(exchange) && exchange >= 0 && exchange <= received ? exchange : received) / 1e6;
    if (!finite(qty) || qty <= 0 || (side !== 1 && side !== -1) || !finite(price) || price <= 0 || received < 0) {
      return unavailable(throughMs, 'A visible fill has invalid quantity, side, price or time; no daily result was inferred.');
    }
    const feePerUnit = fee.kind === 'TradingQtyFeeModel' ? rate : rate * price * multiplier;
    if (!finite(feePerUnit)) return unavailable(throughMs, 'A visible fill has invalid recorded costs.');

    let remaining = qty, closed = 0, gross = 0, fees = 0, firstMs = exitMs;
    while (remaining > 0 && lots.length && lots[0].side !== side) {
      const entry = lots[0], matched = Math.min(remaining, entry.quantity);
      gross += entry.side * (price - entry.price) * matched * multiplier;
      fees += matched * (entry.feePerUnit + feePerUnit);
      closed += matched;
      firstMs = Math.min(firstMs, entry.entryMs);
      remaining -= matched; entry.quantity -= matched;
      if (entry.quantity <= 0) lots.shift();
    }
    if (closed > 0) {
      const date = utcDate(exitMs);
      let day = days.get(date);
      if (!day) {
        day = { date, net: 0, gross: 0, fees: 0, trades: 0, wins: 0, losses: 0, firstMs, lastMs: exitMs, partial: true };
        days.set(date, day);
      }
      const net = gross - fees;
      day.gross += gross; day.fees += fees; day.net += net;
      day.trades++; // closing executions, not the number of FIFO fragments
      if (net > EPS) day.wins++;
      else if (net < -EPS) day.losses++;
      day.firstMs = Math.min(day.firstMs, firstMs); day.lastMs = Math.max(day.lastMs, exitMs);
    }
    if (remaining > 0) lots.push({ side, price, quantity: remaining, feePerUnit, entryMs: exitMs });
  }
  const openQuantity = lots.reduce((sum, lot) => sum + lot.side * lot.quantity, 0);
  const warning = indices.length === 0 ? 'No engine fills at this replay position.'
    : days.size === 0 ? 'No closed engine trades at this replay position. Open inventory is excluded.'
    : Math.abs(openQuantity) > 0 ? 'Open inventory and its entry costs are excluded until it closes. Each square covers recorded activity, not a full-day backtest.'
    : 'Each square covers recorded activity, not a full-day backtest.';
  return { days: finish(days, origin, throughMs), source: 'Replay engine · FIFO closed-trade net · UTC',
    basis: 'closed-trade-net', available: true, warning, openQuantity, throughMs };
}

function markedPerformance(s: Session, origin: number, limit: number, throughMs: number, warning: string): SessionPerformance {
  type Point = { time: number; equity: number; fees: number; fills: number; position: number };
  const points: Point[] = [];
  if (typeof s.accountingAt !== 'function') return unavailable(throughMs, warning + ' Recorded account totals are unavailable.');
  const add = (time: number) => {
    const a = s.accountingAt(time);
    if (!a || !finite(a.equity) || !finite(a.fees) || !finite(a.fills) || !finite(a.position)) return;
    points.push({ time: origin + time / 1e6, equity: a.equity, fees: a.fees, fills: a.fills, position: a.position });
  };
  for (const frame of s.frameT) if (finite(frame) && frame >= 0 && frame <= limit) add(frame);
  // Only the terminal boundary may expose verified terminal accounting.
  if (limit >= s.endT && (!s.frameT.length || s.frameT[s.frameT.length - 1] < limit)) add(limit);
  points.sort((a, b) => a.time - b.time);
  if (points.length < 2) return unavailable(throughMs, warning + ' Not enough visible recorded account totals.');
  const first = points[0], days = new Map<string, PerformanceDay>();
  let previous = first;
  for (const point of points.slice(1)) {
    const fills = Math.max(0, point.fills - previous.fills);
    const net = point.equity - previous.equity, fees = point.fees - previous.fees;
    // An inactive zero account is not a profitable/flat trading day.
    if (fills || Math.abs(net) > EPS || Math.abs(fees) > EPS || Math.abs(point.position) > EPS) {
      const date = utcDate(point.time);
      let day = days.get(date);
      if (!day) {
        day = { date, net: 0, gross: 0, fees: 0, trades: 0, wins: 0, losses: 0,
          firstMs: previous.time, lastMs: point.time, partial: true };
        days.set(date, day);
      }
      day.net += net; day.gross += net + fees; day.fees += fees; day.trades += fills; day.lastMs = point.time;
    }
    previous = point;
  }
  return { days: finish(days, first.time, throughMs), source: 'Replay account · marked net change · UTC',
    basis: 'marked-net', available: true, warning: warning + ' Change starts at the first observed frame and includes open inventory; counts are fills.',
    openQuantity: points[points.length - 1].position, throughMs };
}
