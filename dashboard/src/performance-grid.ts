import {el} from './dom';
import type {Session} from './session';
import {sessionPerformanceDays} from './performance-data';

type Day={date:string;net:number;gross:number;fees:number;trades:number;wins:number;losses:number;firstMs:number;lastMs:number;partial:boolean};
type Coverage={startMs:number|null;endMs:number|null;intervals?:{startMs:number;endMs:number;hasCoverageGaps?:boolean}[]};
type View={symbol?:string;mode?:string;strategy?:string;executionVersion?:string;strategyVersion?:string;available:boolean;days:Day[];source?:string;basis?:string;metric?:string;warning?:string;notice?:string;throughMs?:number;coverage?:Coverage|null;selectedRun?:{id:string}|null;runs?:{id:string;sourceEndMs:number}[]};
const DAY=86400000;
const iso=(ms:number)=>new Date(ms).toISOString().slice(0,10);
const money=(v:number)=>Number.isFinite(v)?(v<0?'−':v>0?'+':'')+'$'+Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
const shortDate=(ms:number)=>Number.isFinite(ms)?iso(ms):'';
const hasDate=(date:string)=>/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date+'T00:00:00Z'));

/** One pixel cell per UTC day. Unknown days never become invented flat results. */
export class PerformanceGrid{
 readonly el:HTMLElement;
 private stats:HTMLElement;private grid:HTMLElement;private months:HTMLElement;private detail:HTMLElement;private context:HTMLElement;
 private source:HTMLSelectElement;private runs:HTMLSelectElement;private yearLabel:HTMLElement;private refreshButton:HTMLButtonElement;
 private selectedYear=new Date().getUTCFullYear();private yearTouched=false;private selectedDate='';private throughMs=Date.now();
 private view:View={available:false,days:[]};private current:View|null=null;private sessionKey='';
 private contextKey='';private symbol='MNQZ26-CME';private strategy='liquidity';private strategyVersion='liquidity-flow-v2';private executionVersion='response-aware-v1';
 private cells=new Map<string,HTMLButtonElement>();private timer:number;private controller:AbortController|null=null;private request=0;private stopped=false;
 constructor(root:HTMLElement,private readonly kind:'session'|'live'|'history'='live'){
  this.el=el('section','panel performance-days');this.el.dataset.panel='performance';
  this.el.setAttribute('aria-label','Daily profit and loss calendar');
  const title=el('div','title',this.el);el('span','n',title).textContent='11';title.append(' DAILY PERFORMANCE');
  this.stats=el('span','right performance-stats',title);
  const body=el('div','body performance-body',this.el),controls=el('div','performance-controls',body);
  this.source=el('select','performance-control performance-source',controls);this.source.setAttribute('aria-label','Daily performance source');
  for(const [value,label] of [...(kind==='session'?[['session','THIS REPLAY']]:[]),['live','LIVE ENGINE HISTORY'],['replay','REPLAY ENGINE HISTORY']]){
   const option=el('option','',this.source);option.value=value;option.textContent=label;
  }
  this.runs=el('select','performance-control performance-run',controls);this.runs.setAttribute('aria-label','Performance recording');
  this.resetRuns();
  this.context=el('span','performance-context',controls);
  const year=el('div','performance-year',controls);
  const button=(text:string,label:string,action:()=>void)=>{const b=el('button','performance-control',year);b.type='button';b.textContent=text;b.setAttribute('aria-label',label);b.onclick=action;return b;};
  button('◄','Previous performance year',()=>this.changeYear(-1));this.yearLabel=el('span','performance-year-value',year);
  button('►','Next performance year',()=>this.changeYear(1));
  this.refreshButton=button('↻','Refresh daily performance',()=>{if(this.source.value==='session'){if(this.current)this.adopt(this.current);}else void this.load();});
  const calendar=el('div','performance-calendar',body),labels=el('div','performance-weekdays',calendar);
  labels.innerHTML='<span></span><span>M</span><span></span><span>W</span><span></span><span>F</span><span></span>';
  const plot=el('div','performance-plot',calendar);this.months=el('div','performance-months',plot);
  this.grid=el('div','performance-grid',plot);this.grid.setAttribute('role','group');this.grid.setAttribute('aria-label','One cell per UTC day');
  const footer=el('div','performance-footer',body),legend=el('div','performance-legend',footer);
  for(const [state,text] of [['profit','Profit'],['loss','Loss'],['flat','Flat'],['empty','No result']]){
   const item=el('span','',legend);el('i','performance-swatch is-'+state,item);item.append(text);
  }
  const note=el('span','performance-unit',footer);note.textContent='1 CELL / UTC DAY · * PARTIAL';
  this.detail=el('div','performance-detail',body);this.detail.setAttribute('aria-live','polite');
  const status=root.querySelector(':scope > .status');if(status)root.insertBefore(this.el,status);else root.append(this.el);
  root.classList.add('has-performance');
  this.source.onchange=()=>{this.selectedDate='';this.yearTouched=false;this.resetRuns();if(this.source.value==='session'&&this.current){this.controller?.abort();this.controller=null;this.request++;this.adopt(this.current);}else void this.load();};
  this.runs.onchange=()=>{this.selectedDate='';this.yearTouched=false;void this.load();};
  this.drawCalendar();this.paint();
  this.timer=window.setInterval(()=>{if(this.source.value!=='session'&&!document.hidden)void this.load(false);},10000);
  window.addEventListener('pagehide',()=>this.dispose(),{once:true});
  if(kind!=='session')void this.load();
 }
 private resetRuns(){
  this.runs.replaceChildren();const o=el('option','',this.runs);o.value='';o.textContent='ALL RECORDED PERIODS';
  this.runs.hidden=this.source.value==='session';
 }
 private changeYear(direction:number){
  const next=this.selectedYear+direction;if(next<1970||next>9998)return;
  this.selectedYear=next;this.yearTouched=true;this.selectedDate='';this.drawCalendar();this.paint();
 }
 updateSession(session:Session,t:number):void{
  const key=String(session.t0)+'|'+Math.floor(t/1e9)+'|'+session.endT;
  if(key===this.sessionKey)return;this.sessionKey=key;
  const result=sessionPerformanceDays(session,t);
  this.symbol=String(session.meta.symbol??'');
  this.current={...result,coverage:{startMs:Number(session.t0/1000000n),endMs:result.throughMs}};
  if(this.source.value==='session')this.adopt(this.current);
 }
 updateLive(symbol:string,strategy:string,strategyVersion:string,executionVersion:string):void{
  const key=[symbol,strategy,strategyVersion,executionVersion].join('|');if(key===this.contextKey)return;
  this.contextKey=key;this.symbol=symbol;this.strategy=strategy;this.strategyVersion=strategyVersion;this.executionVersion=executionVersion;
  this.resetRuns();if(this.source.value!=='session')void this.load();
 }
 private adopt(view:View){
  this.view={...view,days:Array.isArray(view.days)?view.days.filter(d=>hasDate(d.date)&&[d.net,d.gross,d.fees,d.trades].every(Number.isFinite)):[]};
  this.throughMs=view.throughMs??view.coverage?.endMs??Date.now();
  const year=new Date(this.throughMs).getUTCFullYear();
  if(!this.yearTouched&&Number.isFinite(year)&&year!==this.selectedYear){this.selectedYear=year;this.drawCalendar();}
  this.paint();
 }
 private async load(force=true){
  if(this.stopped||this.source.value==='session')return;
  if(this.controller&&!force)return;
  this.controller?.abort();const controller=this.controller=new AbortController(),request=++this.request;
  this.refreshButton.setAttribute('aria-busy','true');
  if(force){this.view={available:false,days:[],warning:'Loading daily results…'};this.paint();}
  const querySymbol=/^MNQ[HMUZ]\d{2}-CME(?:\[M\])?$/i.test(this.symbol)?this.symbol:(this.kind==='session'?'MNQZ26-CME':this.symbol);
  const q=new URLSearchParams({symbol:querySymbol,mode:this.source.value,strategy:this.strategy,strategyVersion:this.strategyVersion,executionVersion:this.executionVersion,scope:this.runs.value?'run':'history'});
  if(this.runs.value)q.set('runId',this.runs.value);
  try{
   const response=await fetch('/api/mnq/performance-days?'+q,{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});
   const data=await response.json();if(request!==this.request||this.stopped||this.source.value==='session')return;
   const choice=this.runs.value;this.resetRuns();
   for(const run of data.runs??[]){
    const option=el('option','',this.runs);option.value=run.id;
    option.textContent=shortDate(run.sourceEndMs)+' · '+run.id.slice(0,6);
   }
   if(choice){
    if(![...this.runs.options].some(o=>o.value===choice)){const option=el('option','',this.runs);option.value=choice;option.textContent='SAVED RUN · '+choice.slice(0,6);}
    this.runs.value=choice;
   }
   if(!response.ok||data.error)throw Error(data.error||'Daily history unavailable');
   this.adopt({...data,basis:data.metric});
  }catch(error){
   if(request!==this.request||controller.signal.aborted||this.stopped)return;
   this.adopt({available:false,days:[],warning:error instanceof Error?error.message:'Daily history unavailable'});
  }finally{
   if(request===this.request){this.controller=null;this.refreshButton.removeAttribute('aria-busy');}
  }
 }
 private drawCalendar(){
  this.cells.clear();this.grid.replaceChildren();this.months.replaceChildren();this.yearLabel.textContent=String(this.selectedYear);
  const start=Date.UTC(this.selectedYear,0,1),end=Date.UTC(this.selectedYear+1,0,1),offset=new Date(start).getUTCDay();
  const slots=Math.ceil((offset+(end-start)/DAY)/7)*7,columns=slots/7;
  this.grid.style.gridTemplateColumns='repeat('+columns+',minmax(0,1fr))';
  this.months.style.gridTemplateColumns='repeat('+columns+',minmax(0,1fr))';
  for(let month=0;month<12;month++){
   const label=el('span','',this.months),column=Math.floor((offset+(Date.UTC(this.selectedYear,month,1)-start)/DAY)/7)+1;
   label.style.gridColumn=String(column)+' / span 3';label.textContent=new Date(Date.UTC(this.selectedYear,month,1)).toLocaleDateString('en-US',{month:'short',timeZone:'UTC'}).toUpperCase();
  }
  for(let i=0;i<slots;i++){
   const ms=start+(i-offset)*DAY;
   if(ms<start||ms>=end){el('span','performance-blank',this.grid);continue;}
   const date=iso(ms),cell=el('button','performance-cell is-empty',this.grid);cell.type='button';cell.dataset.date=date;cell.tabIndex=-1;
   this.cells.set(date,cell);cell.onclick=()=>{this.selectedDate=date;this.paint();};
   cell.onpointerenter=()=>this.showDay(date);cell.onfocus=()=>this.showDay(date);
   cell.onkeydown=e=>{
    const shift:Record<string,number>={ArrowLeft:-7,ArrowRight:7,ArrowUp:-1,ArrowDown:1};
    if(!(e.key in shift))return;e.preventDefault();this.cells.get(iso(ms+shift[e.key]*DAY))?.focus();
   };
  }
  this.grid.onpointerleave=()=>this.selectedDate?this.showDay(this.selectedDate):this.showSummary();
 }
 private covered(date:string):boolean{
  const start=Date.parse(date+'T00:00:00Z'),end=start+DAY,c=this.view.coverage;
  const intervals=c?.intervals??(c?.startMs!=null&&c.endMs!=null?[{startMs:c.startMs,endMs:c.endMs}]:[]);
  return intervals.some(i=>i.startMs<end&&i.endMs>=start);
 }
 private dayText(date:string):string{
  const day=this.view.days.find(d=>d.date===date),future=Date.parse(date+'T00:00:00Z')>this.throughMs;
  if(!day)return date+' UTC · '+(future?'Not reached':this.covered(date)?'No completed trades recorded; observed interval only':'No recorded result');
  const count=this.view.basis==='marked-net'?'fills':'closed executions';
  return date+' UTC · NET '+money(day.net)+' · GROSS '+money(day.gross)+' · FEES '+money(day.fees).replace(/^\+/,'')+' · '+day.trades+' '+count+(day.partial?' · partial recording':'');
 }
 private showDay(date:string){this.detail.textContent=this.dayText(date);this.detail.title=this.detail.textContent;}
 private showSummary(){
  const days=this.view.days.filter(d=>d.date.startsWith(String(this.selectedYear)));
  const period=this.source.value==='session'?'REPLAY PLAYHEAD':'SAVED ENGINE HISTORY';
  this.detail.textContent=this.view.warning||(!this.view.available?'No results available for this selection.':!days.length?'No completed results in '+this.selectedYear+'.':period+' · Net after fees · Hover / select a day for details');
  this.detail.title=this.view.notice||this.view.warning||this.view.source||'';
 }
 private paint(){
  const map=new Map(this.view.days.map(d=>[d.date,d])),visible=this.view.days.filter(d=>d.date.startsWith(String(this.selectedYear)));
  let positive=0,negative=0,total=0;
  for(const day of visible){total+=day.net;if(day.net>0)positive++;else if(day.net<0)negative++;}
  this.stats.textContent=visible.length?positive+'+ / '+negative+'− DAYS · NET '+money(total):'NO CLOSED RESULTS';
  this.stats.className='right performance-stats '+(total>0?'g':total<0?'r':'');
  this.context.textContent=this.view.basis==='marked-net'?'MARKED NET':(this.view.symbol??this.symbol)+' · NET AFTER FEES';
  this.context.title=[this.view.source,this.view.mode,this.view.strategy,this.view.executionVersion,this.view.notice].filter(Boolean).join(' · ')||'Completed trades, including entry and exit commissions';
  let first:HTMLButtonElement|null=null;
  for(const [date,cell] of this.cells){
   const day=map.get(date);cell.className='performance-cell is-'+(day?(day.net>0?'profit':day.net<0?'loss':'flat'):'empty');
   if(day?.partial)cell.classList.add('is-partial');
   if(date===this.selectedDate)cell.classList.add('is-selected');
   cell.title=this.dayText(date);cell.setAttribute('aria-label',cell.title);
   cell.tabIndex=-1;
   if(day&&!first)first=cell;
  }
  (this.cells.get(this.selectedDate)||first||this.cells.get(iso(this.throughMs))||this.cells.values().next().value)?.setAttribute('tabindex','0');
  if(this.selectedDate)this.showDay(this.selectedDate);else this.showSummary();
 }
 dispose(){this.stopped=true;clearInterval(this.timer);this.controller?.abort();this.el.remove();}
}
