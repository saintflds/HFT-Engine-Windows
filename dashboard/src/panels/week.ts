import {el} from '../dom';
import {Panel,type RenderCtx} from './base';
import type {Session} from '../session';

type Bar={time:number;open:number;high:number;low:number;close:number;volume:number;trades?:number;lastMs?:number};

export function aggregateBars(bars:Bar[],minutes:number):Bar[]{
 const out:Bar[]=[];for(const b of bars){const time=Math.floor(b.time/(minutes*60000))*minutes*60000;let last=out.at(-1);
 if(!last||last.time!==time)out.push({...b,time});
 else{last.high=Math.max(last.high,b.high);last.low=Math.min(last.low,b.low);last.close=b.close;last.volume+=b.volume;
  last.trades=(last.trades??0)+(b.trades??0);
  const bl=b.lastMs??b.time;last.lastMs=Math.max(last.lastMs??bl,bl);}}return out;
}

/**
 * Weekly candlestick chart for the session's own contract.
 *
 * Historical replay: history is fetched ending at the SESSION END (never the
 * latest week on disk), and only bars whose last trade is at or before the
 * playhead are drawn. Rewinding removes later bars; seeking forward reveals
 * them. No future candle is ever shown, and a forming candle is only the
 * server-side partial bar built strictly from trades available up to endMs.
 *
 * Live tab: the latest available history for the matching contract, with its
 * date range and STALE state shown in the title.
 *
 * Instrument mismatch (e.g. a BTC sample replay): a clear message is shown;
 * MNQ history is never substituted.
 */
export class WeekPanel extends Panel{
 private canvas:HTMLCanvasElement;private toolbar:HTMLElement;private note:HTMLElement;
 private bars:Bar[]=[];private minutes=10;private offset=0;private count=1000;private floating=false;private lastDraw=0;private loading=false;private loadedAt=0;private error='Loading history…';private observer:ResizeObserver;
 private mode:'replay'|'live';private contract='';private lastTradeMs=0;private playheadMs:number;
 private historyEndMs=0;private dockParent:HTMLElement|null=null;private placeholder=document.createElement('div');private onWindowResize=()=>{this.clampFloating();this.draw();};
 private gen=0; // load generation: a superseded response may never overwrite the chart

 constructor(s:Session){
  super('week',10,'MNQ WEEK CHART',s);this.body.classList.add('week-body');
  this.mode=s.meta?.live?'live':'replay';
  this.contract=String(s.meta?.symbol??'');
  // Replay starts at the session start (t0); live shows the full recorded range.
  this.playheadMs=this.mode==='live'?Infinity:Number(s.t0/1000000n);
  this.toolbar=el('div','week-controls',this.body);
  const select=el('select','paper-inline-control',this.toolbar);select.setAttribute('aria-label','Week chart timeframe');
  for(const n of [1,5,10,15,30,60]){const o=el('option','',select);o.value=String(n);o.textContent=n<60?`${n}m`:'1h';}
  select.value='10';select.onchange=()=>{this.minutes=+select.value;this.offset=0;this.count=10000;this.draw();};
  const button=(text:string,fn:()=>void)=>{const b=el('button','paper-inline-control',this.toolbar);b.textContent=text;b.onclick=fn;return b;};
  button('Week',()=>{this.count=10000;this.offset=0;this.draw();});
  button('+',()=>this.zoom(.65));button('−',()=>this.zoom(1.5));
  button('Latest',()=>{this.offset=0;this.draw();});
  const move=button('Float',()=>{
   this.floating=!this.floating;move.textContent=this.floating?'Dock':'Float';
   this.el.classList.toggle('week-floating',this.floating);
   if(this.floating){
    this.dockParent=this.el.parentElement;this.placeholder.className='week-placeholder';this.placeholder.style.gridArea=this.el.style.gridArea;
    this.el.replaceWith(this.placeholder);document.body.append(this.el);
    this.el.style.width=Math.min(850,innerWidth-16)+'px';this.el.style.height=Math.min(450,innerHeight-16)+'px';
    this.el.style.left=Math.min(innerWidth*.15,innerWidth-this.el.offsetWidth-8)+'px';this.el.style.top=Math.min(innerHeight*.2,innerHeight-this.el.offsetHeight-8)+'px';this.clampFloating();
   }else{
    if(this.placeholder.isConnected)this.placeholder.replaceWith(this.el);else this.dockParent?.append(this.el);
    for(const key of ['left','top','width','height'])this.el.style.removeProperty(key);
    this.el.dispatchEvent(new CustomEvent('weekdock',{bubbles:true}));
   }
   this.draw();
  });
  button('Reload',()=>void this.load());
  this.note=el('div','week-note',this.body);
  this.canvas=el('canvas','week-canvas',this.body);
  this.canvas.setAttribute('role','img');this.canvas.setAttribute('aria-label','MNQ weekly candlestick chart');
  this.canvas.onwheel=e=>{e.preventDefault();this.zoom(e.deltaY>0?1.2:.8);};
  let drag:{x:number;offset:number}|null=null;
  this.canvas.onpointerdown=e=>{drag={x:e.clientX,offset:this.offset};this.canvas.setPointerCapture(e.pointerId);};
  this.canvas.onpointermove=e=>{if(drag){const n=Math.min(this.count,this.total());this.offset=Math.max(0,drag.offset+Math.round((e.clientX-drag.x)*n/Math.max(1,this.canvas.getBoundingClientRect().width-65*(this.canvas.getBoundingClientRect().width/this.canvas.clientWidth))));this.draw();}};
  this.canvas.onpointerup=this.canvas.onpointercancel=()=>{drag=null;};
  let windowDrag:{x:number;y:number;left:number;top:number}|null=null;
  this.titleEl.onpointerdown=e=>{if(!this.floating)return;const r=this.el.getBoundingClientRect();windowDrag={x:e.clientX,y:e.clientY,left:r.left,top:r.top};this.titleEl.setPointerCapture(e.pointerId);};
  this.titleEl.onpointermove=e=>{if(windowDrag){this.el.style.left=Math.max(0,Math.min(innerWidth-100,windowDrag.left+e.clientX-windowDrag.x))+'px';this.el.style.top=Math.max(0,Math.min(innerHeight-40,windowDrag.top+e.clientY-windowDrag.y))+'px';this.clampFloating();}};
  this.titleEl.onpointerup=this.titleEl.onpointercancel=()=>{windowDrag=null;};
  this.observer=new ResizeObserver(()=>{this.clampFloating();this.draw();});this.observer.observe(this.body);window.addEventListener('resize',this.onWindowResize);
  void this.load();
 }
 mount(parent:HTMLElement):void{this.dockParent=parent;if(this.floating){this.placeholder.style.gridArea=this.el.style.gridArea;parent.append(this.placeholder);document.body.append(this.el);}else parent.append(this.el);}
 private clampFloating(){if(!this.floating)return;let r=this.el.getBoundingClientRect();if(r.width>innerWidth-16)this.el.style.width=(innerWidth-16)+'px';if(r.height>innerHeight-16)this.el.style.height=(innerHeight-16)+'px';r=this.el.getBoundingClientRect();this.el.style.left=Math.max(8,Math.min(innerWidth-r.width-8,r.left))+'px';this.el.style.top=Math.max(8,Math.min(innerHeight-r.height-8,r.top))+'px';}
 dispose(){this.gen++;this.observer.disconnect();window.removeEventListener('resize',this.onWindowResize);if(this.floating)this.el.remove();this.placeholder.remove();}

 /**
  * The live feed can switch contracts (or mode) on an existing session.
  * Bars, timeframe offset and the in-flight request belong to the PREVIOUS
  * contract: drop them and load the new contract's history instead of keeping
  * stale candles on screen.
  */
 updateSession(session:Session):void{
  super.updateSession(session);
  const mode: 'replay' | 'live' = session.meta?.live ? 'live' : 'replay';
  const contract = String(session.meta?.symbol ?? '');
  if (mode === this.mode && contract === this.contract) return;
  this.mode = mode; this.contract = contract;
  this.bars = []; this.lastTradeMs = 0; this.historyEndMs=0; this.offset = 0;
  this.error = 'Loading history…';
  this.gen++; // invalidate any in-flight load for the previous contract
  this.loading = false;
  this.draw();
  void this.load();
 }

 /** Bars that are fully in the past for the current playhead (never future). */
 private visibleBars(){return this.bars.filter(b=>(b.lastMs??b.time+60000)<=this.playheadMs);}
 private total(){return aggregateBars(this.visibleBars(),this.minutes).length;}
 private zoom(factor:number){const total=this.total();if(!total)return;this.count=Math.max(12,Math.min(total,Math.round(Math.min(this.count,total)*factor)));this.draw();}

 private async load(){
  if(this.loading)return;
  this.loading=true;
  const myGen=++this.gen;
  this.error='Loading history…';this.draw();
  try{
   // Replay: end at the session's own end time. Live: the latest available.
   const endMs=this.mode==='replay'
    ?Number((this.s.t0+BigInt(Math.round(this.s.endT)))/1000000n)
    :Date.now();
   const r=await fetch(`/api/mnq/week-at?symbol=${encodeURIComponent(this.contract)}&endMs=${endMs}`,{signal:AbortSignal.timeout(120000)});
   const d=await r.json();
   if(myGen!==this.gen)return; // superseded by a newer load; never apply an old contract's data
   if(!r.ok||d.available===false){
    this.bars=[];this.lastTradeMs=0;
    this.error=d.message||d.error||`No recorded weekly history for ${this.contract}.`;
   }else{
    this.historyEndMs=Number(d.windowEndMs)||0;this.bars=Array.isArray(d.bars)?d.bars:[];this.lastTradeMs=Number(d.lastTradeMs)||0;this.loadedAt=Date.now();
    this.error=this.bars.length?'':'No recorded trades in this window.';
   }
  }catch(e){if(myGen===this.gen){this.bars=[];this.lastTradeMs=0;this.error=String(e);}}
  finally{if(myGen===this.gen){this.loading=false;this.draw();}}
 }

 render(c:RenderCtx){
  const playheadMs=this.mode==='live'
   ?Infinity
   :Number((this.s.t0+BigInt(Math.round(c.t)))/1000000n);
  // Redraw immediately on seeks/rewinds (jumps > 500 ms); throttle normal playback.
  const jumped=Math.abs(playheadMs-this.playheadMs)>500;
  if(Date.now()-this.lastDraw<250&&!jumped)return;
  this.lastDraw=Date.now();this.playheadMs=playheadMs;
  if(this.mode==='live'&&this.loadedAt&&Date.now()-this.loadedAt>60000&&!this.loading)void this.load();
  this.draw();
 }

 private stamp(ms:number){return new Date(ms).toISOString().slice(5,16).replace('T',' ');}

 private draw(){
  if(!this.canvas)return;
  const W=this.body.clientWidth,H=Math.max(40,this.body.clientHeight-this.toolbar.offsetHeight-this.note.offsetHeight-4);
  this.canvas.style.width=W+'px';this.canvas.style.height=H+'px';this.canvas.style.imageRendering='auto';
  // Size the backing store to the ON-SCREEN device pixels. The app's integer CSS
  // zoom scales the rendered box without changing clientWidth, so without this
  // ratio the browser upscales the bitmap and the candles render blurry.
  const scale=Math.max(1,(window.devicePixelRatio||1)*(this.canvas.getBoundingClientRect().width/W||1));
  this.canvas.width=Math.round(W*scale);this.canvas.height=Math.round(H*scale);
  const c=this.canvas.getContext('2d')!;c.setTransform(scale,0,0,scale,0,0);
  c.fillStyle='#000000';c.fillRect(0,0,W,H);
  const visible=this.visibleBars();
  const all=aggregateBars(visible,this.minutes);
  const n=Math.min(this.count,all.length);
  this.offset=Math.min(this.offset,Math.max(0,all.length-n));
  const end=all.length-this.offset,view=all.slice(Math.max(0,end-n),end);
  const stale=this.mode==='live'&&this.lastTradeMs>0&&Date.now()-this.lastTradeMs>120000;
  const range=this.mode==='live'&&visible.length?` · ${this.stamp(visible[0].time)} → ${this.stamp(this.lastTradeMs)} UTC`:'';
  this.setTitle(`${this.minutes}m · Sierra history${range}${stale?' · STALE':''}`);
  this.note.textContent=this.error||'Drag to pan · wheel to zoom · UTC · closed minutes';
  if(!view.length){
   c.fillStyle='#fff';c.font='14px monospace';
   const words=(this.error||'No history').split(' ');let line='',y=24;
   for(const w of words){const t=line?`${line} ${w}`:w;if(line&&c.measureText(t).width>W-16){c.fillText(line,8,y);y+=18;line=w;}else line=t;}
   if(line)c.fillText(line,8,y);
   this.canvas.setAttribute('aria-label',`MNQ weekly chart: ${this.error||'no history'}`);
   return;
  }
  let low=Math.min(...view.map(b=>b.low)),high=Math.max(...view.map(b=>b.high));
  const pad=Math.max(.5,(high-low)*.08);low-=pad;high+=pad;
  const left=6,right=W-65,top=8,bottom=H-25,dx=(right-left)/view.length;
  const y=(v:number)=>bottom-(v-low)/(high-low)*(bottom-top);
  c.font='11px monospace';
  for(let i=0;i<5;i++){const p=low+(high-low)*i/4,yy=y(p);c.strokeStyle='#3030b5';c.beginPath();c.moveTo(left,yy);c.lineTo(right,yy);c.stroke();c.fillStyle='#bbb';c.fillText(p.toFixed(2),right+3,yy);}
  view.forEach((b,i)=>{const x=left+(i+.5)*dx;c.strokeStyle=c.fillStyle=b.close>=b.open?'#40ff80':'#ff6078';c.beginPath();c.moveTo(x,y(b.high));c.lineTo(x,y(b.low));c.stroke();c.fillRect(left+i*dx,Math.min(y(b.open),y(b.close)),Math.max(1,dx-.5),Math.max(1,Math.abs(y(b.open)-y(b.close))));});
  c.fillStyle='#ddd';const stamp=(b:Bar)=>this.stamp(b.time);
  c.fillText(stamp(view[0]),left,H-7);if(W>300)c.fillText(stamp(view.at(-1)!),Math.max(left,right-106),H-7);
  const last=view.at(-1)!;
  const cutoff=Math.min(this.mode==='live'?Date.now():this.playheadMs,this.historyEndMs||Infinity);
  const partial=cutoff<last.time+this.minutes*60000?' · last bar partial':'';
  this.canvas.setAttribute('aria-label',
   `${this.minutes}-minute candles for ${this.contract}. ${view.length} bars from ${stamp(view[0])} to ${stamp(last)} UTC${partial}. `
   +(this.mode==='replay'?'Clipped to the replay playhead; no future bars.':'Recorded history; date range shown in title.'));
 }
}
