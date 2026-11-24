import {readdir,readFile,stat,realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {engineRoot} from './project-paths.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SYMBOL=/^MNQ[HMUZ]\d{2}-CME(?:\[M\])?$/i;
const DAY=86400000;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const validTime=v=>finite(v)&&v>0&&v<=8640000000000000;
const normalizedSymbol=s=>String(s).toUpperCase().replace(/\[M\]$/,'');
const version=s=>s.executionVersion??'legacy-unversioned';
const identity=s=>[normalizedSymbol(s.symbol),s.mode,s.strategy,s.strategyVersion,version(s)].join('|');
const failure=(message,status=503)=>Object.assign(Error(message),{status});
const money=v=>Math.round((v+Number.EPSILON)*100)/100;

function queryOptions(input={}) {
  const q=input instanceof URLSearchParams?Object.fromEntries(input):input;
  const symbol=q.symbol??'MNQZ26-CME';
  if(!SYMBOL.test(symbol))throw failure('Choose a supported MNQ futures contract.',400);
  const mode=q.mode??'live',strategy=q.strategy??'liquidity';
  const executionVersion=q.executionVersion??'response-aware-v1';
  const strategyVersion=q.strategyVersion??(strategy==='liquidity'?'liquidity-flow-v2':'legacy-v1');
  if(!['live','replay'].includes(mode)||!['queue','liquidity'].includes(strategy)
    ||!['response-aware-v1','legacy-unversioned'].includes(executionVersion)
    ||!['liquidity-flow-v2','legacy-v1'].includes(strategyVersion))
    throw failure('Invalid performance history selection.',400);
  if(q.runId&&!UUID.test(q.runId))throw failure('Invalid performance run.',400);
  const scope=q.scope??'run';
  if(!['run','history'].includes(scope))throw failure('Invalid daily performance scope.',400);
  if(scope==='history'&&q.runId)throw failure('Choose either all recorded periods or one saved run.',400);
  const beforeMs=q.beforeMs===undefined?Infinity:Number(q.beforeMs);
  if(beforeMs!==Infinity&&!validTime(beforeMs))throw failure('Invalid performance cutoff.',400);
  return {symbol:normalizedSymbol(symbol),mode,strategy,strategyVersion,executionVersion,scope,runId:q.runId?.toLowerCase()??null,beforeMs};
}

/** Read-only aggregation. Independent runs are alternatives, never summed.
 * Only closed-trade net after both commissions is represented; open inventory,
 * Sierra account results and hypothetical/unobserved days are excluded.
 */
export class DailyPerformanceStore {
  constructor(folder=path.join(engineRoot,'Engine History'),options={}) {
    this.folder=path.resolve(folder);
    this.cacheMs=options.cacheMs??5000;
    this.maxRuns=options.maxRuns??2000;
    this.maxSegments=options.maxSegments??32;
    this.maxFileBytes=options.maxFileBytes??258*1024*1024;
    this.maxTotalBytes=options.maxTotalBytes??512*1024*1024;
    this.cache=null;this.cacheAt=0;this.scan=null;
    this.detailCache=new Map();
  }

  async inventory() {
    if(this.cache&&Date.now()-this.cacheAt<this.cacheMs)return this.cache;
    if(this.scan)return this.scan;
    this.scan=this.readInventory().then(rows=>{this.cache=rows;this.cacheAt=Date.now();return rows;}).finally(()=>{this.scan=null;});
    return this.scan;
  }

  async readInventory() {
    let entries;
    try{entries=await readdir(this.folder,{withFileTypes:true});}
    catch(e){if(e.code==='ENOENT')return [];throw failure('Saved daily performance is temporarily unavailable.');}
    const dirs=entries.filter(e=>e.isDirectory()&&UUID.test(e.name));
    if(dirs.length>this.maxRuns)throw failure('History run limit reached; select an archived run after reviewing saved history.');
    const rows=[];
    // Bounded sequential reads avoid flooding the disk while Sierra is recording.
    for(const entry of dirs) {
      const file=path.join(this.folder,entry.name,'summary.json');
      try{
        const info=await stat(file);
        if(!info.isFile()||info.size>2*1024*1024)continue;
        const s=JSON.parse(await readFile(file,'utf8'));
        if(s.runId?.toLowerCase()!==entry.name.toLowerCase()||!SYMBOL.test(s.symbol)
          ||!['live','replay'].includes(s.mode)||!['queue','liquidity'].includes(s.strategy)
          ||!['liquidity-flow-v2','legacy-v1'].includes(s.strategyVersion)
          ||!validTime(s.sourceMs)||!validTime(s.updatedMs))continue;
        if(s.continuationOf&&!UUID.test(s.continuationOf))continue;
        rows.push({...s,runId:s.runId.toLowerCase(),continuationOf:s.continuationOf?.toLowerCase(),symbol:normalizedSymbol(s.symbol)});
      }catch(e){
        // Summary files may be in atomic replacement. A missing/partial summary
        // is not a zero-profit day and is never used as accounting evidence.
        if(['EACCES','EPERM'].includes(e.code))throw failure('Saved daily performance cannot be read.');
      }
    }
    return rows;
  }

  async records(run,all,budget=null) {
    const chain=[],seen=new Set();let current=run,totalBytes=0;
    while(current) {
      if(seen.has(current.runId)||chain.length>=this.maxSegments)throw failure('Performance history has an invalid continuation chain.');
      seen.add(current.runId);chain.push(current);
      if(!current.continuationOf)break;
      const previous=all.find(s=>s.runId===current.continuationOf);
      if(!previous||identity(previous)!==identity(run))throw failure('A linked performance segment is missing or has a different identity.');
      current=previous;
    }
    chain.reverse();
    const files=[];
    const realFolder=await realpath(this.folder);
    for(const segment of chain) {
      const file=await realpath(path.join(this.folder,segment.runId,'batches.jsonl'));
      if(!file.startsWith(realFolder+path.sep))throw failure('Performance history is outside the engine history folder.');
      const info=await stat(file);
      totalBytes+=info.size;
      if(budget){budget.bytes+=info.size;if(budget.bytes>this.maxTotalBytes)throw failure('Selected history exceeds the bounded daily-history scan; choose one saved run.');}
      if(!info.isFile()||info.size>this.maxFileBytes||totalBytes>this.maxTotalBytes)throw failure('Selected history is too large for the daily display.');
      files.push({file,size:info.size,mtime:info.mtimeMs,segment});
    }
    const key=files.map(f=>f.segment.runId+':'+f.size+':'+f.mtime).join('|');
    const cached=this.detailCache.get(key);
    if(cached)return cached;
    const records=[],tradeIds=new Map();
    let firstMs=Infinity,lastMs=0,ignoredPartialTail=false,hasCoverageGaps=false;
    for(const {file,size,segment} of files) {
      let buffer='',expected=1,previousLine=null,previousSource=0;
      const consume=line=>{
        if(!line.trim())return;
        if(Buffer.byteLength(line)>2*1024*1024)throw failure('A saved performance record is too large.');
        let b;try{b=JSON.parse(line);}catch{throw failure('Saved performance contains a malformed committed record.');}
        if(b.sequence===expected-1&&line===previousLine)return;
        if(b.runId?.toLowerCase()!==segment.runId||b.sequence!==expected||identity({...b,executionVersion:b.summary?.executionVersion})!==identity(segment)
          ||!(validTime(b.sourceMs)||(b.sourceMs===0&&previousSource===0&&Array.isArray(b.closedTrades)&&!b.closedTrades.length))||b.sourceMs<previousSource||!Array.isArray(b.closedTrades)||b.closedTrades.length>15000)
          throw failure('Saved performance has an inconsistent run, sequence or identity.');
        expected++;previousLine=line;previousSource=b.sourceMs;
        // Zero-clock startup rows carry no observed day and no completed trade.
        if(b.sourceMs>0){firstMs=Math.min(firstMs,b.sourceMs);lastMs=Math.max(lastMs,b.sourceMs);}
        if(Number(b.market?.coverageGaps)>0)hasCoverageGaps=true;
        for(const t of b.closedTrades) {
          if(!Number.isSafeInteger(t.id)||t.id<1||![t.gross,t.fees,t.net].every(finite)||t.fees<0
            ||Math.abs(t.gross-t.fees-t.net)>.0001||!validTime(t.entryMs)||!validTime(t.exitMs)||t.exitMs<t.entryMs||t.exitMs>b.sourceMs+.001)
            throw failure('Saved performance contains an invalid completed trade.');
          const previous=tradeIds.get(t.id),encoded=JSON.stringify(t);
          if(previous){if(previous!==encoded)throw failure('Completed trade identity conflicts across saved history.');continue;}
          tradeIds.set(t.id,encoded);records.push({...t,recordedMs:b.sourceMs});
        }
      };
      if(size) {
        // Read a snapshot of the file length: a concurrently appended tail must
        // not change the accounting included in this particular response.
        const stream=createReadStream(file,{encoding:'utf8',start:0,end:size-1});
        for await(const chunk of stream) {
          buffer+=chunk;
          let newline;
          while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);consume(line);}
          if(Buffer.byteLength(buffer)>2*1024*1024)throw failure('A saved performance record is too large.');
        }
        if(buffer)ignoredPartialTail=true;
      }
    }
    records.sort((a,b)=>a.exitMs-b.exitMs||a.id-b.id);
    const data={records,firstMs:Number.isFinite(firstMs)?firstMs:null,lastMs:lastMs||null,segments:chain.map(s=>s.runId),ignoredPartialTail,hasCoverageGaps};
    // The display caches at most 8 run snapshots. A changed active file gets
    // a new key; no unbounded cache grows with an open dashboard.
    this.detailCache.set(key,data);
    while(this.detailCache.size>8)this.detailCache.delete(this.detailCache.keys().next().value);
    return data;
  }

  async get(input={}) {
    const q=queryOptions(input),all=await this.inventory();
    const target=[q.symbol,q.mode,q.strategy,q.strategyVersion,q.executionVersion].join('|');
    const compatible=all.filter(s=>identity(s)===target).sort((a,b)=>b.updatedMs-a.updatedMs||a.runId.localeCompare(b.runId));
    const predecessors=new Set(compatible.map(s=>s.continuationOf).filter(Boolean));
    const choices=compatible.filter(s=>!predecessors.has(s.runId));
    if(compatible.length&&!choices.length)throw failure('Performance history has an invalid continuation chain.');
    const selected=q.runId?compatible.find(s=>s.runId===q.runId):choices[0];
    if(q.runId&&!selected)throw failure('That saved run does not match this instrument and model.',404);
    const base={schema:1,timezone:'UTC',metric:'closed-trade-net',source:'engine-journal',symbol:q.symbol,mode:q.mode,strategy:q.strategy,strategyVersion:q.strategyVersion,executionVersion:q.executionVersion,scope:q.scope,
      available:false,selectedRun:null,runCount:choices.length,runsTruncated:choices.length>80,includedRunCount:0,excludedOverlappingRuns:0,includedRuns:[],
      runs:choices.slice(0,80).map(s=>({id:s.runId,updatedMs:s.updatedMs,sourceEndMs:s.sourceMs,executionVersion:version(s)})),
      days:[],coverage:null,notice:'Completed engine round trips after commissions, assigned to the UTC exit date. Open positions and Sierra account P&L are excluded. Coverage shows recorded timestamp bounds, not proof of continuous capture.'};
    if(base.runsTruncated)base.notice+=' The run menu shows the 80 most recently updated alternatives; selected accounting is not truncated.';
    if(!selected)return base;
    let included=[],excluded=0;
    try{
      if(q.scope==='run'){
        included=[{run:selected,data:await this.records(selected,all)}];
      }else{
        const budget={bytes:0},candidates=[];
        for(const run of choices){
          const data=await this.records(run,all,budget);
          if(data.firstMs===null||data.firstMs>q.beforeMs)continue;
          // A carried position may have entered before the first saved market
          // frame. Include its accounting interval for overlap exclusion,
          // without extending the claimed observed coverage bounds.
          const start=data.records.reduce((first,t)=>Math.min(first,t.entryMs),data.firstMs);
          candidates.push({run,data,start,end:Math.min(data.lastMs,q.beforeMs)});
        }
        candidates.sort((a,b)=>a.start-b.start||a.run.runId.localeCompare(b.run.runId));
        let group=[],end=-Infinity;
        const finish=()=>{
          if(!group.length)return;
          group.sort((a,b)=>b.run.updatedMs-a.run.updatedMs||a.run.runId.localeCompare(b.run.runId));
          included.push(group[0]);excluded+=group.length-1;group=[];
        };
        for(const candidate of candidates){
          if(group.length&&candidate.start>end)finish();
          if(!group.length)end=candidate.end;else end=Math.max(end,candidate.end);
          group.push(candidate);
        }
        finish();
      }
    }catch(e){
      const error=e.status?e:failure('Selected daily performance is temporarily unavailable.');
      // Inventory metadata is already validated and inexpensive. Preserve it
      // even when detailed accounting cannot be scanned, so the user can
      // follow the error's advice and choose one smaller saved run.
      Object.assign(error,{runs:base.runs,runCount:base.runCount,runsTruncated:base.runsTruncated});
      throw error;
    }
    const intervals=included.filter(x=>x.data.firstMs!==null&&x.data.firstMs<=q.beforeMs).map(({run,data})=>({
      startMs:data.firstMs,endMs:Math.min(data.lastMs,q.beforeMs),runId:run.runId,hasCoverageGaps:data.hasCoverageGaps
    })).sort((a,b)=>a.startMs-b.startMs);
    const map=new Map();
    for(const {data} of included)for(const t of data.records){
      if(t.exitMs>q.beforeMs||t.recordedMs>q.beforeMs)continue;
      const date=new Date(t.exitMs).toISOString().slice(0,10);
      let day=map.get(date);
      if(!day){day={date,net:0,gross:0,fees:0,trades:0,wins:0,losses:0,flatTrades:0,firstMs:t.entryMs,lastMs:t.exitMs,partial:true};map.set(date,day);}
      day.gross+=t.gross;day.fees+=t.fees;day.net+=t.gross-t.fees;day.trades++;
      if(t.net>.000001)day.wins++;else if(t.net<-.000001)day.losses++;else day.flatTrades++;
      day.firstMs=Math.min(day.firstMs,t.entryMs);day.lastMs=Math.max(day.lastMs,t.exitMs);
    }
    const days=[...map.values()].sort((a,b)=>a.date.localeCompare(b.date)).map(day=>{
      if(![day.net,day.gross,day.fees].every(finite))throw failure('Saved daily totals exceed the supported accounting range.');
      const start=Date.parse(day.date+'T00:00:00Z'),end=start+DAY;
      let coveredTo=start,gaps=false;
      for(const i of intervals){
        if(i.endMs<start||i.startMs>end)continue;
        if(i.startMs>coveredTo){gaps=true;break;}
        if(i.hasCoverageGaps)gaps=true;
        coveredTo=Math.max(coveredTo,i.endMs);
      }
      return {...day,net:money(day.net),gross:money(day.gross),fees:money(day.fees),partial:gaps||coveredTo<end,
        outcome:day.net>.000001?'profit':day.net<-.000001?'loss':'flat'};
    });
    const partialTailIgnored=included.some(x=>x.data.ignoredPartialTail),hasCoverageGaps=intervals.some(i=>i.hasCoverageGaps);
    const selectedInfo=({run,data})=>({id:run.runId,segments:data.segments,updatedMs:run.updatedMs});
    return {...base,available:included.length>0,selectedRun:q.scope==='run'?selectedInfo(included[0]):null,
      includedRuns:included.map(selectedInfo),includedRunCount:included.length,excludedOverlappingRuns:excluded,days,
      coverage:{startMs:intervals[0]?.startMs??null,endMs:intervals.at(-1)?.endMs??null,intervals,boundsOnly:true,
        cutoffMs:Number.isFinite(q.beforeMs)?q.beforeMs:null,partialTailIgnored,hasCoverageGaps},
      notice:base.notice+(q.scope==='history'?' Newest whole run chain per overlapping interval group; only disjoint groups are combined.':' One saved run; overlapping alternative runs are not combined.')
        +(partialTailIgnored?' A pending incomplete append is excluded.':'')};
  }

}

export function dailyPerformancePlugin(store=new DailyPerformanceStore()) {
  const register=server=>server.middlewares.use(async(req,res,next)=>{
    const u=new URL(req.url||'/','http://127.0.0.1');
    if(u.pathname!=='/api/mnq/performance-days')return next();
    res.setHeader('Content-Type','application/json');
    res.setHeader('Cache-Control','no-store');
    const send=(data,status=200)=>{res.statusCode=status;res.end(JSON.stringify(data));};
    if(req.method!=='GET')return send({error:'Daily performance is read only.'},405);
    try{return send(await store.get(u.searchParams));}
    catch(e){return send({available:false,error:e.message,runs:e.runs??[],runCount:e.runCount??0,runsTruncated:e.runsTruncated??false},e.status??503);}
  });
  return {name:'daily-performance',configureServer:register,configurePreviewServer:register};
}
