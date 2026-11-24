export type Candle = { time: number; open: number; high: number; low: number; close: number };
/** Aggregate observed trades only. Empty intervals stay empty; no future trades. */
export function tradeCandles(times: ArrayLike<number>, ticks: ArrayLike<number>, start: number, end: number, interval: number, origin = 0): Candle[] {
  const bars = new Map<number,Candle>();
  for(let i=0;i<times.length;i++) {
    const t=times[i], price=ticks[i];
    if(t<start || t>end || !Number.isFinite(t) || !Number.isFinite(price) || price<=0) continue;
    const time=Math.floor((t+origin)/interval)*interval-origin;
    const bar=bars.get(time);
    if(bar) { bar.high=Math.max(bar.high,price);bar.low=Math.min(bar.low,price);bar.close=price; }
    else bars.set(time,{time,open:price,high:price,low:price,close:price});
  }
  return [...bars.values()].sort((a,b)=>a.time-b.time);
}
