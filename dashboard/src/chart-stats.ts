/** Statistics of retained observed prints, never an estimate of missing volume. */
export function observedTradeStats(times:ArrayLike<number>,ticks:ArrayLike<number>,quantities:ArrayLike<number>,sides:ArrayLike<number>,start:number,end:number) {
  let count=0,volume=0,buy=0,sell=0,notional=0,low=Infinity,high=-Infinity;
  for(let i=0;i<times.length;i++) {
    const t=times[i],p=ticks[i],q=quantities[i];
    if(!Number.isFinite(t)||t<start||t>end||!Number.isFinite(p)||p<=0||!Number.isFinite(q)||q<=0)continue;
    count++;volume+=q;notional+=p*q;low=Math.min(low,p);high=Math.max(high,p);
    if(sides[i]===1)buy+=q;else if(sides[i]===-1)sell+=q;
  }
  return {count,volume,buy,sell,delta:buy-sell,vwapTick:volume?notional/volume:NaN,lowTick:count?low:NaN,highTick:count?high:NaN};
}
