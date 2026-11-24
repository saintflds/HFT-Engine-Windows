import { observedTradeStats } from '../chart-stats';
import { sierraChartFills, type SierraAccount } from '../sierra-account';
import { drawSierraOverlay } from '../sierra-chart-overlay';
import { tradeCandles } from '../candles';
import { el } from '../dom';
import { clock, tickDigits, lotDigits } from '../fmt';
import { EV, ST, type Session } from '../session';
import { Panel, type RenderCtx } from './base';

const C={bg:'#000000',grid:'#3535bd',text:'#ffffff',muted:'#aaaaff',up:'#55ff88',down:'#ff6677',demand:'#55ffff',supply:'#ff88ff',target:'#55ff55',stop:'#ff5555',time:'#ffff55'};
const reasonColor=(reason:string,buy:boolean)=>reason==='TP'?C.target:reason==='STOP'?C.stop:reason==='TIME'?C.time:reason==='DMD'?C.demand:reason==='SUP'?C.supply:buy?C.demand:C.supply;
const reasons:Record<string,string>={DMD:'Demand entry',SUP:'Supply entry',TP:'Profit target',STOP:'Protective stop',TIME:'Holding time limit',MM:'Queue maker',FILL:'Recorded fill'};
type Hit={x:number;y:number;w:number;h:number;text:string};
export class MarketPanel extends Panel {
  private canvas:HTMLCanvasElement;
  private toolbar:HTMLElement;
  private tip:HTMLElement;
  private expand:HTMLButtonElement;
  private hits:Hit[]=[];
  private context:RenderCtx|null=null;
  private interval=5e9;
  private levels=true;
  windowNs=60e9;
  constructor(s:Session){
    super('market',5,'MARKET',s);this.body.classList.add('market-body');
    this.toolbar=el('div','market-tools',this.body);
    const select=(label:string,values:[string,number][],change:(n:number)=>void)=>{
      const input=el('select','',this.toolbar);input.setAttribute('aria-label',label);input.title=label;
      for(const [label,value] of values){const o=el('option','',input);o.textContent=label;o.value=String(value);}
      input.onchange=()=>{change(Number(input.value));this.redraw();};
    };
    select('Candle duration',[['5s',5e9],['10s',10e9],['15s',15e9]],n=>this.interval=n);
    select('Visible history',[['1m',60e9],['2m',120e9]],n=>this.windowNs=n);
    const levels=el('button','',this.toolbar);levels.textContent='Levels';levels.title='Show current engine limit prices';levels.setAttribute('aria-pressed','true');
    levels.onclick=()=>{this.levels=!this.levels;levels.setAttribute('aria-pressed',String(this.levels));this.redraw();};
    this.expand=el('button','market-expand',this.toolbar);this.expand.textContent='Expand';this.expand.title='Expand chart / return to all panels';
    this.expand.onclick=()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'5'}));
    this.canvas=el('canvas','',this.body);this.canvas.setAttribute('role','img');
    this.tip=el('div','market-tooltip',this.body);this.tip.hidden=true;
    this.canvas.onpointermove=e=>{
      const rect=this.canvas.getBoundingClientRect(),x=(e.clientX-rect.left)*this.canvas.clientWidth/rect.width,y=(e.clientY-rect.top)*this.canvas.clientHeight/rect.height;
      const hit=this.hits.find(h=>Math.abs(h.x-x)<=h.w/2&&Math.abs(h.y-y)<=h.h/2);
      this.tip.hidden=!hit;if(hit)this.tip.textContent=hit.text;
    };
    this.canvas.onpointerleave=()=>{this.tip.hidden=true;};
    this.canvas.addEventListener('wheel',e=>{if(!this.tip.hidden&&this.tip.scrollHeight>this.tip.clientHeight){e.preventDefault();this.tip.scrollTop+=e.deltaY;}},{passive:false});
  }
  private redraw(){this.invalidate();if(this.context)this.render(this.context);}
  render(c:RenderCtx):void{
    this.context=c;const s=this.s,f=c.f,W=this.body.clientWidth,H=Math.max(1,this.body.clientHeight-this.toolbar.offsetHeight);
    if(!this.changed(`${f}|${c.t}|${W}|${H}|${this.interval}|${this.windowNs}|${this.levels}`))return;
    this.expand.textContent=W>600?'All panels':'Expand';
    this.canvas.style.width=W+'px';this.canvas.style.height=H+'px';this.canvas.style.imageRendering='auto';
    const scale=Math.max(1,(window.devicePixelRatio||1)*(this.canvas.getBoundingClientRect().width/W||1));
    this.canvas.width=Math.round(W*scale);this.canvas.height=Math.round(H*scale);
    const ctx=this.canvas.getContext('2d')!;ctx.setTransform(scale,0,0,scale,0,0);ctx.fillStyle=C.bg;ctx.fillRect(0,0,W,H);ctx.textBaseline='top';this.hits=[];
    const pxd=tickDigits(s.tickSize),qd=lotDigits(s.lotSize),price=(tick:number)=>(tick*s.tickSize).toFixed(pxd);
    const end=c.t,start=Math.max(0,end-this.windowNs),origin=Number(s.t0%BigInt(this.interval));
    const candles=tradeCandles(s.trLocalT,s.trTick,Math.max(0,Math.floor((start+origin)/this.interval)*this.interval-origin),end,this.interval,origin);
    const left=9,right=W-Math.max(60,(pxd+7)*6),top=W>600?90:40,bottom=H-(W>600?60:55);
    if(right-left<40||bottom-top<20)return;
    const x=(t:number)=>left+(t-(end-this.windowNs))/this.windowNs*(right-left);
    const fills:number[]=[];
    for(let i=s.eventsUpTo(end)-1;i>=0&&s.eT[i]>=start;i--)if(!s.meta.live?.followSierra&&s.eKind[i]===EV.FILL)fills.push(i);
    const reasonMap=new Map<number,string>();
    for(const e of s.meta.live?.sim.events??[])if(e.reason)reasonMap.set(Number(e.orderId.replace(/^SIM-/,'')),e.reason);
    const groups=new Map<string,{time:number;tick:number;side:number;reason:string;items:number[]}>();
    const dense=fills.length>Math.max(8,(right-left)/18);
    for(const i of fills.slice().reverse()){
      const reason=reasonMap.get(s.eId[i])??'FILL',key=dense?`${Math.floor((s.eT[i]+origin)/this.interval)}:${s.eSide[i]}:${reason}`:String(i),g=groups.get(key);
      if(g){const n=g.items.length;g.tick=(g.tick*n+s.eExecTick[i])/(n+1);g.time=(g.time*n+s.eT[i])/(n+1);g.items.push(i);}
      else groups.set(key,{time:s.eT[i],tick:s.eExecTick[i],side:s.eSide[i],reason,items:[i]});
    }
    const stats=observedTradeStats(s.trLocalT,s.trTick,s.trQty,s.trSide,start,end);
    const qty=(n:number)=>n.toLocaleString('en-US',{maximumFractionDigits:qd});
    const live=s.meta.live?.sim;
    const account=s.meta.live?.sierraAccount as SierraAccount|null|undefined;
    const sierraFills=sierraChartFills(account,Number(s.t0)/1e6,start,end);
    // Actual traded prices set the scale; old or distant quotes cannot flatten it.
    let low=Infinity,high=-Infinity;
    for(const b of candles){low=Math.min(low,b.low);high=Math.max(high,b.high);}
    for(const i of fills){low=Math.min(low,s.eExecTick[i]);high=Math.max(high,s.eExecTick[i]);}
    for(const fill of sierraFills){low=Math.min(low,fill.price/s.tickSize);high=Math.max(high,fill.price/s.tickSize);}
    if(!Number.isFinite(low)){low=s.bestBidTick[f]||0;high=s.bestAskTick[f]||low+1;}
    const pad=Math.max(3,(high-low)*.16);low=Math.floor(low-pad);high=Math.ceil(high+pad);
    const y=(tick:number)=>bottom-(tick-low)/(high-low)*(bottom-top),last=candles.at(-1);
    ctx.font='16px VGA, monospace';ctx.fillStyle=C.text;ctx.fillText(last?`LAST ${price(last.close)}`:'Waiting for trades',left,3);
    if(W<=600&&W>=240){ctx.fillStyle=C.muted;ctx.fillText(`${s.meta.live?.followSierra?sierraFills.length:fills.length} fills`,W-90,3);}
    if(W>600){ctx.fillStyle=C.muted;ctx.fillText(`BID ${price(s.bestBidTick[f])}   ASK ${price(s.bestAskTick[f])}   SPREAD ${s.bestAskTick[f]-s.bestBidTick[f]} ticks   POSITION ${(s.meta.live?.followSierra?account?.position?.quantity??0:s.accountingAt(c.t).position).toFixed(qd)}`,left+180,3);ctx.fillText(`${s.meta.live?.followSierra?sierraFills.length:fills.length} fills in view${dense?' · numbered markers group nearby fills':''}  |  Hover candles or markers for details`,left,20);}
    ctx.font='16px VGA, monospace';ctx.fillStyle=C.text;
    if(W>600){
      ctx.fillText(`OBSERVED VOLUME ${qty(stats.volume)}   BUY ${qty(stats.buy)}   SELL ${qty(stats.sell)}   DELTA ${stats.delta>=0?'+':''}${qty(stats.delta)}   PRINTS ${stats.count}`,left,38);
      ctx.fillText(`WINDOW HIGH ${Number.isFinite(stats.highTick)?price(stats.highTick):'-'}   LOW ${Number.isFinite(stats.lowTick)?price(stats.lowTick):'-'}   VWAP ${Number.isFinite(stats.vwapTick)?price(stats.vwapTick):'-'}   RANGE ${stats.count?stats.highTick-stats.lowTick:0} ticks`,left,55);
      ctx.fillStyle=C.muted;
      ctx.fillText(s.meta.live?.followSierra?`SIERRA ACCOUNT ${account?.account??'—'}   OPEN P&L ${account?.position?.openPnl?.toFixed(2)??'—'}   DAILY P&L ${account?.position?.dailyPnl?.toFixed(2)??'—'}`:live?`${account?'ENGINE ':''}ACCOUNT NET ${live.equity.toFixed(2)}   REALIZED ${live.realized.toFixed(2)}   OPEN ${live.unrealized.toFixed(2)}   FEES ${live.fees.toFixed(2)}   FILLS ${live.fillCount}`:'Volume and VWAP use observed prints in this view. Hover markers for every execution.',left,72);
    }else{ctx.fillStyle=C.muted;ctx.fillText(`VOL ${qty(stats.volume)}  D ${stats.delta>=0?'+':''}${qty(stats.delta)}`,left,21);}
    const step=Math.max(1,Math.ceil((high-low)/Math.max(2,Math.floor((bottom-top)/42))));ctx.font='11px Consolas, monospace';
    for(let tick=Math.ceil(low/step)*step;tick<=high;tick+=step){const yy=y(tick);ctx.strokeStyle=C.grid;ctx.lineWidth=.6;ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(right,yy);ctx.stroke();ctx.fillStyle=C.muted;ctx.fillText(price(tick),right+5,yy-5);}
    // Only current working engine prices, with names that do not cover the axis.
    const [o0,o1]=s.orderRange(f),labelYs:number[]=[];
    if(this.levels&&!s.meta.live?.followSierra)for(let i=o0;i<o1;i++)if(s.oStatus[i]===ST.NEW){
      const tick=s.oTick[i];if(tick<low||tick>high)continue;
      const buy=s.oSide[i]===1,liquidity=s.meta.strategy?.kind==='liquidity',exit=liquidity&&(buy?s.position[f]<0:s.position[f]>0);
      const modelOrder=live?.orders.find((o:{id:string})=>Number(o.id.replace(/^SIM-/,''))===s.oId[i]);
      const reason=modelOrder?.reason ?? (exit?'TP':buy?'DMD':'SUP');
      const name=reason==='STOP'?'Stop exit':reason==='TIME'?'Time exit':exit?'TP target':liquidity?(buy?'Demand':'Supply'):(buy?'Buy limit':'Sell limit'),color=reasonColor(reason,buy),yy=y(tick);
      ctx.setLineDash([4,5]);ctx.strokeStyle=color;ctx.globalAlpha=.55;ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(right,yy);ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;
      this.hits.push({x:(left+right)/2,y:yy,w:right-left,h:6,text:`${name} ${price(tick)}\nOrder #${s.oId[i]} · ${buy?'BUY':'SELL'} · ${reason}\n${s.oLeaves[i].toFixed(qd)} queued · estimated ahead ${s.oFront[i].toFixed(qd)}\nResting ${(Math.max(0,end-s.oSubmitT[i])/1e9).toFixed(2)}s · ${s.oReq[i]===4?'cancel pending':'working'}\nEngine order; not a confirmed market-wide zone.`});
      if(!labelYs.some(v=>Math.abs(v-yy)<18)){ctx.font='16px VGA, monospace';const tw=ctx.measureText(name).width,ly=Math.max(top,yy-17);ctx.fillStyle=C.bg;ctx.fillRect(left,ly,tw+6,16);ctx.fillStyle=color;ctx.fillText(name,left+2,ly);labelYs.push(yy);}
    }
    ctx.save();ctx.beginPath();ctx.rect(left,top,right-left,bottom-top);ctx.clip();
    // Adjacent observed bars touch; missing intervals retain their true time gaps.
    for(const b of candles){
      const bx=x(b.time),ex=x(Math.min(end,b.time+this.interval)),bodyWidth=Math.max(1,ex-bx),xx=(bx+ex)/2;ctx.strokeStyle=b.close>=b.open?C.up:C.down;ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(xx,y(b.high));ctx.lineTo(xx,y(b.low));ctx.stroke();ctx.fillRect(bx,Math.min(y(b.open),y(b.close)),bodyWidth,Math.max(2,Math.abs(y(b.open)-y(b.close))));ctx.strokeStyle='#000070';ctx.lineWidth=.5;ctx.strokeRect(bx,Math.min(y(b.open),y(b.close)),bodyWidth,Math.max(2,Math.abs(y(b.open)-y(b.close))));
      const detail=observedTradeStats(s.trLocalT,s.trTick,s.trQty,s.trSide,Math.max(0,b.time),Math.min(end,b.time+this.interval-1));
      this.hits.push({x:xx,y:(top+bottom)/2,w:bodyWidth+4,h:bottom-top,text:`${clock(s.t0,Math.max(0,b.time),true)} UTC · ${this.interval/1e9}s candle${b.time+this.interval>end?' · forming':''}\nOpen ${price(b.open)}    High ${price(b.high)}\nLow  ${price(b.low)}    Close ${price(b.close)}\nVolume ${qty(detail.volume)} · ${detail.count} prints\nBuy ${qty(detail.buy)} / Sell ${qty(detail.sell)} · Delta ${qty(detail.delta)}\nVWAP ${Number.isFinite(detail.vwapTick)?price(detail.vwapTick):'-'} · Range ${b.high-b.low} ticks\nObserved prints only; missing intervals remain empty.`});
    }
    ctx.restore();
    const occupied:{x:number;y:number;w:number}[]=[];
    for(const g of groups.values()){
      const xx=Math.max(left+4,Math.min(right-4,x(g.time))),yy=y(g.tick),buy=g.side===1;
      const markerColor=reasonColor(g.reason,buy);ctx.fillStyle=markerColor;ctx.beginPath();ctx.moveTo(xx,yy+(buy?-4:4));ctx.lineTo(xx-3,yy+(buy?3:-3));ctx.lineTo(xx+3,yy+(buy?3:-3));ctx.closePath();ctx.fill();ctx.strokeStyle=C.bg;ctx.lineWidth=1;ctx.stroke();
      const label=g.items.length>1?`${g.reason==='FILL'?(buy?'B':'S'):g.reason} ${g.items.length}`:g.reason==='FILL'?(buy?'B':'S'):g.reason;
      ctx.font='16px VGA, monospace';const tw=ctx.measureText(label).width,lx=Math.min(right-tw-2,xx+5),ly=Math.max(top,Math.min(bottom-16,yy+(buy?6:-20)));
      if((W>600||groups.size<=6)&&!occupied.some(p=>Math.abs(p.y-ly)<17&&lx<p.x+p.w&&lx+tw>p.x)){ctx.fillStyle=C.bg;ctx.fillRect(lx-1,ly,tw+2,16);ctx.fillStyle=markerColor;ctx.fillText(label,lx,ly);occupied.push({x:lx,y:ly,w:tw});}
      const text=`${buy?'BUY':'SELL'} · ${reasons[g.reason]??g.reason}${g.items.length>1?` · ${g.items.length} fills (marker at average price)`:''}\n`+g.items.map(i=>{const fill=live?.fills.find((v:{orderId:string;timeMs:number})=>Number(v.orderId.replace(/^SIM-/,''))===s.eId[i]&&Math.abs(v.timeMs-(Number(s.t0)/1e6+s.eExchT[i]/1e6))<1);const li=s.lifeIndexOfEvent[i],life=li>=0?s.lives[li]:null;return `${clock(s.t0,s.eT[i],true)} UTC  ${s.eQty[i].toFixed(qd)} @ ${price(s.eExecTick[i])}  #${s.eId[i]}${life?`\n  Rested ${((s.eExchT[i]-life.exchAckT)/1e9).toFixed(3)}s · ahead at ack ${life.frontAtAck.toFixed(qd)}`:''}${fill?`\n  Gross realized ${fill.realized.toFixed(2)} · fee ${fill.fee.toFixed(2)}`:''}`;}).join('\n')+(g.reason==='FILL'?'\nStrategy reason was not saved in this recording.':'');
      this.hits.unshift({x:xx,y:yy,w:18,h:20,text});
    }
    this.hits.unshift(...drawSierraOverlay(ctx,account,{t0Ms:Number(s.t0)/1e6,start,end,interval:this.interval,tickSize:s.tickSize,low,high,left,right,top,bottom,levels:this.levels,x,y}));
    ctx.font='11px Consolas, monospace';ctx.fillStyle=C.muted;
    for(let i=0;i<3;i++){const t=Math.max(0,end-this.windowNs+this.windowNs*i/2);ctx.fillText(clock(s.t0,t).slice(3,8),Math.max(left,Math.min(right-32,x(t)-16)),bottom+7);}
    ctx.font='16px VGA, monospace';
    const legend=W>600?[['Demand / buy',C.demand],['Supply / sell',C.supply],['TP profit target',C.target],['STOP protective',C.stop],['TIME exit',C.time]]:[['DMD',C.demand],['SUP',C.supply],['TP',C.target],['STOP',C.stop],['TIME',C.time]];
    let legendX=left,legendY=H-(W>600?35:31);
    for(const [label,color] of legend){const width=ctx.measureText(label).width+12;if(legendX+width>W-5){legendX=left;legendY+=17;}ctx.fillStyle=color;ctx.fillText(label,legendX,legendY);legendX+=width;}
    if(W>600){ctx.fillStyle=C.muted;ctx.fillText(account?'ENGINE: triangles / dashed lines   |   SIERRA: SC diamonds / solid lines   |   hover for details':'Color = reason   |   ▲ BUY / ▼ SELL   |   number = fill count   |   hover for details; scroll long lists',left,H-17);}
    this.canvas.setAttribute('aria-label',`${this.interval/1e9}-second candles, ${this.windowNs/1e9} seconds in view. ${fills.length} engine executions in ${groups.size} markers.${account?` ${sierraFills.length} Sierra executions; solid Sierra order levels.`:''} Hover or expand for details.`);
    this.setTitle(`${this.interval/1e9}s · ${this.windowNs/60e9}m`);
  }
}
