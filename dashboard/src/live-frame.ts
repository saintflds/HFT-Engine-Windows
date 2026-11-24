import type { SimulationFrame } from './replay-simulation';

export type LiveFrame = SimulationFrame & { version: 1; connected: boolean; delaySeconds: number; chartUpdateMs?:number; bridgeIntervalMs?:number };

export function validateLiveFrame(raw: LiveFrame): LiveFrame {
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (raw.version !== 1 || typeof raw.symbol !== 'string' || !finite(raw.publishedMs)
    || typeof raw.connected !== 'boolean' || typeof raw.replay !== 'boolean' || !finite(raw.delaySeconds)
    || !finite(raw.tickSize) || raw.tickSize <= 0 || !Array.isArray(raw.bids) || !Array.isArray(raw.asks) || !Array.isArray(raw.trades)) {
    throw Error('Sierra published an invalid market data frame.');
  }
  const levels = (side: LiveFrame['bids'], sign: number) => side
    .filter(v => Array.isArray(v) && finite(v[0]) && v[0] > 0 && finite(v[1]) && v[1] > 0)
    .map(v => [v[0], v[1], finite(v[2]) ? v[2] : 0] as const)
    .sort((a, b) => sign * (a[0] - b[0])).slice(0, 500);
  return { ...raw, bids: levels(raw.bids, -1), asks: levels(raw.asks, 1),
    trades: raw.trades.filter(v => v && Number.isSafeInteger(v.sequence) && finite(v.timeMs)
      && v.timeMs > 0 && finite(v.price) && v.price > 0 && finite(v.quantity) && v.quantity > 0
      && (v.side === 'buy' || v.side === 'sell')).slice(-1000) };
}
