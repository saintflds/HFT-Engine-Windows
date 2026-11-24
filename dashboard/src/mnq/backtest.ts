export interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number; trades: number }
export interface Settings { fast: number; slow: number; fee: number; slippage: number }
export interface Trade { side: number; entryTime: number; exitTime: number; entry: number; exit: number; gross: number; fees: number; net: number; reason: string }
export const TICK_SIZE = 0.25;
export const POINT_VALUE = 2; // CME Micro E-mini Nasdaq-100: $2 per index point.
const nyTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function sessionClock(time: number) {
  const p = nyTime.formatToParts(time);
  const part = (type: Intl.DateTimeFormatPartTypes) => p.find(x => x.type === type)!.value;
  return { date: `${part('year')}-${part('month')}-${part('day')}`, minute: Number(part('hour')) * 60 + Number(part('minute')) };
}

// Educational bar-based model. Signals use completed bars; executions use the
// next observed minute's open. No depth/queue-fill claims are made by this model.
export function backtest(bars: Bar[], settings: Settings) {
  const { fast, slow, fee, slippage } = settings;
  if (!Number.isInteger(fast) || !Number.isInteger(slow) || fast < 2 || slow <= fast || slow > 500) throw Error('EMA periods must be whole numbers: 2 ≤ fast < slow ≤ 500.');
  if (!Number.isFinite(fee) || !Number.isFinite(slippage) || fee < 0 || fee > 100 || slippage < 0 || slippage > 100) throw Error('Enter valid non-negative commissions and slippage.');
  const trades: Trade[] = [], equity: { time: number; value: number }[] = [];
  const fastLine: number[] = [], slowLine: number[] = [];
  let ef = 0, es = 0, priorDiff = 0, signal = 0, position = 0;
  let entry = 0, entryTime = 0, realized = 0, peak = 0, maxDrawdown = 0, gaps = 0, gapLiquidations = 0, segmentBars = 0;
  const slip = slippage * TICK_SIZE;
  const closePosition = (price: number, time: number, reason: string) => {
    if (!position) return;
    const exit = price - position * slip;
    const gross = position * (exit - entry) * POINT_VALUE;
    const net = gross - 2 * fee;
    trades.push({ side: position, entryTime, exitTime: time, entry, exit, gross, fees: 2 * fee, net, reason });
    realized += net; position = 0;
  };
  const recordEquity = (bar: Bar) => {
    const value = realized + (position ? position * (bar.close - entry) * POINT_VALUE - fee : 0);
    equity.push({ time: bar.time, value });
    peak = Math.max(peak, value); maxDrawdown = Math.max(maxDrawdown, peak - value);
  };
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i], prior = bars[i - 1];
    if (![bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)
      || bar.time % 60000 !== 0 || Math.min(bar.open, bar.high, bar.low, bar.close) <= 0
      || bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)) throw Error('Invalid bar.');
    if (prior && bar.time <= prior.time) throw Error('Bars must have increasing timestamps.');
    const clock = sessionClock(bar.time), minute = clock.minute, inSession = minute >= 570 && minute < 960;
    const consecutive = !prior || bar.time - prior.time === 60000;
    if (!consecutive) {
      const previousClock = sessionClock(prior.time);
      // Count only gaps that omit regular-session minutes on the same date;
      // the expected overnight break is not a missing-data gap.
      if (clock.date === previousClock.date && previousClock.minute + 1 < 960 && minute > 570) gaps++;
      if (position) {
        // A missing session close has no observed fill. Do not quietly hold
        // through the next bar's entire range or invent a prior closing fill.
        closePosition(bar.open, bar.time, 'Missing bars: next available open (modeled)');
        gapLiquidations++;
      }
      signal = 0;
      segmentBars = 0;
    }
    if (signal && inSession && consecutive && minute < 959) {
      if (position !== signal) {
        closePosition(bar.open, bar.time, 'Opposite crossover');
        position = signal; entry = bar.open + position * slip; entryTime = bar.time;
      }
    }
    signal = 0;
    ef = segmentBars ? ef + 2 / (fast + 1) * (bar.close - ef) : bar.close;
    es = segmentBars ? es + 2 / (slow + 1) * (bar.close - es) : bar.close;
    segmentBars++;
    fastLine.push(ef); slowLine.push(es);
    const diff = ef - es;
    if (segmentBars > slow * 3 && inSession && minute < 959 && consecutive) {
      if (diff > 0 && priorDiff <= 0) signal = 1;
      if (diff < 0 && priorDiff >= 0) signal = -1;
    }
    priorDiff = diff;
    // Exit at the scheduled 15:59 bar close. If data ends earlier, mark the
    // explicit end-of-data liquidation; never present it as an observed fill.
    if (position && (!inSession || minute >= 959 || i === bars.length - 1)) {
      closePosition(bar.close, bar.time + 59999, minute >= 959 && inSession ? 'Session close (modeled)' : 'End of data/session (modeled)');
      signal = 0;
    }
    recordEquity(bar);
  }
  const wins = trades.filter(t => t.net > 0), losses = trades.filter(t => t.net < 0);
  const gains = wins.reduce((s, t) => s + t.net, 0), loss = -losses.reduce((s, t) => s + t.net, 0);
  return { trades, equity, fastLine, slowLine, net: realized, gross: trades.reduce((s, t) => s + t.gross, 0), fees: trades.length * 2 * fee, maxDrawdown, winRate: trades.length ? wins.length / trades.length : 0, profitFactor: loss ? gains / loss : null, gaps, gapLiquidations, settings };
}
