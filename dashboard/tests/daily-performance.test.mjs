import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,appendFile,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {DailyPerformanceStore,dailyPerformancePlugin} from '../server/daily-performance.mjs';

const T=Date.parse('2026-11-08T12:00:00Z');
const trade=(id,exitMs=T,extra={})=>({id,entryMs:exitMs-1000,exitMs,gross:2,fees:1.5,net:.5,...extra});
const batch=(id,sequence=1,extra={})=>({schema:1,runId:id,sequence,symbol:'MNQZ26-CME',mode:'live',strategy:'liquidity',strategyVersion:'liquidity-flow-v2',sourceMs:T+sequence*10000,receivedMs:T+sequence*10000,trades:[],events:[],fills:[],closedTrades:[],adjustments:[],summary:{executionVersion:'response-aware-v1',position:0,equity:0,fees:0},...extra});
async function temporary(t) {
 const dir=await mkdtemp(path.join(tmpdir(),'hft-days-'));
 t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:3}));
 return dir;
}
async function save(dir,id,batches,extra={}) {
 await mkdir(path.join(dir,id),{recursive:true});
 const b=batches.at(-1);
 const summary={runId:id,symbol:b.symbol,mode:b.mode,strategy:b.strategy,strategyVersion:b.strategyVersion,updatedMs:b.receivedMs,sourceMs:b.sourceMs,lastSequence:b.sequence,...b.summary,...extra};
 await writeFile(path.join(dir,id,'summary.json'),JSON.stringify(summary));
 await writeFile(path.join(dir,id,'batches.jsonl'),batches.map(b=>JSON.stringify(b)+'\n').join(''));
}
test('empty history stays empty and creates no fake profit days or folders',async t=>{
 const dir=await temporary(t),missing=path.join(dir,'never-created'),store=new DailyPerformanceStore(missing);
 const d=await store.get();assert.equal(d.available,false);assert.equal(d.selectedRun,null);assert.deepEqual(d.days,[]);
 await assert.rejects(()=>readdir(missing),{code:'ENOENT'});
});
test('closed-trade daily net uses both fees and UTC exit date, with zero-net distinct from missing',async t=>{
 const dir=await temporary(t),id=randomUUID();
 const next=T+86400000,b=batch(id,1,{sourceMs:next+10000,closedTrades:[
  trade(1),trade(2,T+1,{gross:1,fees:1.5,net:-.5}),
  trade(3,next,{gross:0,fees:1.5,net:-1.5})
 ]});await save(dir,id,[b]);
 const d=await new DailyPerformanceStore(dir).get();
 assert.equal(d.selectedRun.id,id);assert.equal(d.days.length,2);assert.deepEqual(d.days.map(x=>[x.date,x.net,x.gross,x.fees,x.trades,x.outcome]),[
 ['2026-11-08',0,3,3,2,'flat'],['2026-11-09',-1.5,0,1.5,1,'loss']]);
 assert.equal(d.days[0].wins,1);assert.equal(d.days[0].losses,1);assert.equal(d.days[0].partial,true);
});
test('one latest run is selected; overlapping tabs are never added together',async t=>{
 const dir=await temporary(t),a=randomUUID(),b=randomUUID();
 await save(dir,a,[batch(a,1,{closedTrades:[trade(1)],receivedMs:T+1})]);
 await save(dir,b,[batch(b,1,{closedTrades:[trade(1)],receivedMs:T+2})]);
 const store=new DailyPerformanceStore(dir),d=await store.get();
 assert.equal(d.selectedRun.id,b);assert.equal(d.runs.length,2);assert.equal(d.days[0].net,.5);assert.equal(d.days[0].trades,1);
 assert.equal((await store.get({runId:a})).selectedRun.id,a);
});
test('replay, other contract and old execution model do not leak into new live results',async t=>{
 const dir=await temporary(t),live=randomUUID(),replay=randomUUID(),other=randomUUID(),legacy=randomUUID();
 await save(dir,live,[batch(live,1,{closedTrades:[trade(1)]})]);
 await save(dir,replay,[batch(replay,1,{mode:'replay',closedTrades:[trade(1,T,{gross:100,fees:1.5,net:98.5})]})]);
 await save(dir,other,[batch(other,1,{symbol:'MNQH27-CME',closedTrades:[trade(1)]})]);
 await save(dir,legacy,[batch(legacy,1,{summary:{equity:0,fees:0},closedTrades:[trade(1,T,{gross:9,fees:1.5,net:7.5})]})]);
 const store=new DailyPerformanceStore(dir),d=await store.get();
 assert.equal(d.runs.length,1);assert.equal(d.days[0].net,.5);
 assert.equal((await store.get({mode:'replay'})).days[0].net,98.5);
 assert.equal((await store.get({executionVersion:'legacy-unversioned'})).days[0].net,7.5);
 await assert.rejects(()=>store.get({runId:other}),e=>e.status===404);
});
test('committed retries and repeated trade IDs are deduplicated without replaying P&L',async t=>{
 const dir=await temporary(t),id=randomUUID(),one=batch(id,1,{closedTrades:[trade(1)]}),two=batch(id,2,{closedTrades:[trade(1),trade(2)]});
 await save(dir,id,[one,one,two]);
 const d=await new DailyPerformanceStore(dir).get();assert.equal(d.days[0].net,1);assert.equal(d.days[0].trades,2);
});
test('conflicting completed trade IDs fail closed rather than silently coloring a day',async t=>{
 const dir=await temporary(t),id=randomUUID();
 await save(dir,id,[batch(id,1,{closedTrades:[trade(1)]}),batch(id,2,{closedTrades:[trade(1,T,{gross:3,fees:1.5,net:1.5})]})]);
 await assert.rejects(()=>new DailyPerformanceStore(dir).get(),/conflicts/);
});
test('sequence gaps and mismatched batch identities fail closed',async t=>{
 const dir=await temporary(t),id=randomUUID();
 await save(dir,id,[batch(id),batch(id,3)]);await assert.rejects(()=>new DailyPerformanceStore(dir).get(),/sequence or identity/);
 await save(dir,id,[batch(id),batch(id,2,{symbol:'MNQH27-CME'})],{symbol:'MNQZ26-CME'});
 await assert.rejects(()=>new DailyPerformanceStore(dir).get(),/sequence or identity/);
});
test('continuation chain preserves prior daily trades and is not a second menu run',async t=>{
 const dir=await temporary(t),a=randomUUID(),b=randomUUID();
 await save(dir,a,[batch(a,1,{closedTrades:[trade(1)]})]);
 await save(dir,b,[batch(b,1,{continuationOf:a,closedTrades:[trade(2)]})],{continuationOf:a,updatedMs:T+20000});
 const d=await new DailyPerformanceStore(dir).get();
 assert.equal(d.selectedRun.id,b);assert.equal(d.runs.length,1);assert.deepEqual(d.selectedRun.segments,[a,b]);assert.equal(d.days[0].net,1);
});
test('missing or cyclic continuation segments are explicit unavailable errors',async t=>{
 const dir=await temporary(t),a=randomUUID(),b=randomUUID();
 await save(dir,a,[batch(a)],{continuationOf:b});
 await assert.rejects(()=>new DailyPerformanceStore(dir).get(),/missing/);
 await save(dir,b,[batch(b)],{continuationOf:a});
 const store=new DailyPerformanceStore(dir);
 await assert.rejects(()=>store.get({runId:a}),/continuation chain/);
});
test('partial append is ignored and preserved byte-for-byte; committed corruption is rejected',async t=>{
 const dir=await temporary(t),id=randomUUID();
 await save(dir,id,[batch(id,1,{closedTrades:[trade(1)]})]);
 const file=path.join(dir,id,'batches.jsonl');await appendFile(file,'{"partial":');
 const before=await readFile(file,'utf8'),d=await new DailyPerformanceStore(dir).get();
 assert.equal(d.days[0].net,.5);assert.equal(d.coverage.partialTailIgnored,true);assert.equal(await readFile(file,'utf8'),before);
 await appendFile(file,'\n');await assert.rejects(()=>new DailyPerformanceStore(dir).get(),/malformed committed/);
});
test('cutoff excludes later completed trades while retaining observed coverage',async t=>{
 const dir=await temporary(t),id=randomUUID();
 await save(dir,id,[batch(id,1,{sourceMs:T,closedTrades:[trade(1)]}),batch(id,2,{sourceMs:T+20000,closedTrades:[trade(2,T+10000)]})]);
 const d=await new DailyPerformanceStore(dir).get({beforeMs:T});
 assert.equal(d.days[0].trades,1);assert.equal(d.days[0].net,.5);assert.equal(d.coverage.endMs,T);assert.equal(d.coverage.cutoffMs,T);
});
test('a run with no completed trades remains observed history without invented zero-profit days',async t=>{
 const dir=await temporary(t),id=randomUUID();await save(dir,id,[batch(id)]);
 const d=await new DailyPerformanceStore(dir).get();
 assert.equal(d.available,true);assert.equal(d.selectedRun.id,id);assert.deepEqual(d.days,[]);assert.equal(d.coverage.startMs,T+10000);
});
test('invalid accounting is not used for colors or totals',async t=>{
 const dir=await temporary(t),id=randomUUID();await save(dir,id,[batch(id,1,{closedTrades:[trade(1,T,{net:999})]})]);
 await assert.rejects(()=>new DailyPerformanceStore(dir).get(),/invalid completed trade/);
});
test('query validation rejects traversal, unsupported identity and invalid cutoffs',async t=>{
 const store=new DailyPerformanceStore(await temporary(t));
 for(const q of [{runId:'../escape'},{symbol:'ESZ26-CME'},{mode:'all'},{strategy:'unknown'},{executionVersion:'unknown'},{beforeMs:'NaN'}])
  await assert.rejects(()=>store.get(q),e=>e.status===400);
});
test('scan and file bounds are explicit errors rather than silently truncated P&L',async t=>{
 const dir=await temporary(t),id=randomUUID();await save(dir,id,[batch(id)]);
 await assert.rejects(()=>new DailyPerformanceStore(dir,{maxRuns:0}).get(),/run limit/);
 await assert.rejects(()=>new DailyPerformanceStore(dir,{maxFileBytes:5}).get(),/too large/);
});
test('HTTP endpoint is read-only and reports no-store JSON with validation status',async t=>{
 const store=new DailyPerformanceStore(await temporary(t)),handlers=[];
 dailyPerformancePlugin(store).configureServer({middlewares:{use:fn=>handlers.push(fn)}});
 const server=http.createServer((req,res)=>handlers[0](req,res,()=>{res.statusCode=404;res.end();}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port;
 let r=await fetch(base+'/api/mnq/performance-days');assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal((await r.json()).available,false);
 r=await fetch(base+'/api/mnq/performance-days',{method:'POST'});assert.equal(r.status,405);
 r=await fetch(base+'/api/mnq/performance-days?symbol=../bad');assert.equal(r.status,400);
});

test('history scope accumulates independent days and exposes their disjoint observed intervals',async t=>{
 const dir=await temporary(t),a=randomUUID(),b=randomUUID();
 await save(dir,a,[batch(a,1,{sourceMs:T,closedTrades:[trade(1,T)]})]);
 await save(dir,b,[batch(b,1,{sourceMs:T+86400000,closedTrades:[trade(1,T+86400000)]})]);
 const d=await new DailyPerformanceStore(dir).get({scope:'history'});
 assert.equal(d.scope,'history');assert.equal(d.selectedRun,null);assert.equal(d.includedRunCount,2);assert.equal(d.excludedOverlappingRuns,0);
 assert.equal(d.days.length,2);assert.equal(d.coverage.intervals.length,2);assert.ok(d.days.every(day=>day.partial));
 assert.deepEqual(d.days.map(day=>day.net),[.5,.5]);
});
test('history scope excludes overlapping alternatives and selects the newest whole run',async t=>{
 const dir=await temporary(t),a=randomUUID(),b=randomUUID();
 await save(dir,a,[batch(a,1,{sourceMs:T,closedTrades:[trade(1,T)]}),batch(a,2,{sourceMs:T+1000})],{updatedMs:T+1});
 await save(dir,b,[batch(b,1,{sourceMs:T,closedTrades:[trade(1,T,{gross:8,fees:1.5,net:6.5})]}),batch(b,2,{sourceMs:T+1000})],{updatedMs:T+2});
 const d=await new DailyPerformanceStore(dir).get({scope:'history'});
 assert.equal(d.includedRunCount,1);assert.equal(d.excludedOverlappingRuns,1);assert.equal(d.includedRuns[0].id,b);assert.equal(d.days[0].net,6.5);
});
test('disjoint same-day periods add once but retain a visible coverage hole',async t=>{
 const dir=await temporary(t),a=randomUUID(),b=randomUUID();
 await save(dir,a,[batch(a,1,{sourceMs:T,closedTrades:[trade(1,T)]}),batch(a,2,{sourceMs:T+1000})]);
 await save(dir,b,[batch(b,1,{sourceMs:T+3600000,closedTrades:[trade(1,T+3600000,{gross:0,fees:1.5,net:-1.5})]})]);
 const d=await new DailyPerformanceStore(dir).get({scope:'history'});
 assert.equal(d.includedRunCount,2);assert.equal(d.days.length,1);assert.equal(d.days[0].net,-1);assert.equal(d.days[0].trades,2);
 assert.equal(d.coverage.intervals.length,2);assert.ok(d.coverage.intervals[1].startMs>d.coverage.intervals[0].endMs);assert.equal(d.days[0].partial,true);
});
test('transitively overlapping runs form one conservative alternative group',async t=>{
 const dir=await temporary(t),ids=[randomUUID(),randomUUID(),randomUUID()];
 for(let i=0;i<ids.length;i++){
  const id=ids[i],start=T+i*1000;
  await save(dir,id,[batch(id,1,{sourceMs:start,closedTrades:[trade(1,start)]}),batch(id,2,{sourceMs:start+1500})],{updatedMs:T+i});
 }
 const d=await new DailyPerformanceStore(dir).get({scope:'history'});
 assert.equal(d.includedRunCount,1);assert.equal(d.excludedOverlappingRuns,2);assert.equal(d.includedRuns[0].id,ids[2]);
});
test('history scan enforces one shared byte budget across run snapshots',async t=>{
 const dir=await temporary(t),a=randomUUID(),b=randomUUID(),one=batch(a,1,{sourceMs:T}),two=batch(b,1,{sourceMs:T+86400000});
 await save(dir,a,[one]);await save(dir,b,[two]);
 const limit=Buffer.byteLength(JSON.stringify(one)+'\n')+10;
 const store=new DailyPerformanceStore(dir,{maxTotalBytes:limit});
 await assert.rejects(()=>store.get({scope:'history'}),/bounded daily-history scan/);
 assert.equal((await store.get({runId:a})).available,true);
});
test('history bounds do not fill missing days with fake zero outcomes',async t=>{
 const dir=await temporary(t),a=randomUUID(),b=randomUUID();
 await save(dir,a,[batch(a,1,{sourceMs:T,closedTrades:[trade(1,T)]})]);
 await save(dir,b,[batch(b,1,{sourceMs:T+3*86400000,closedTrades:[trade(1,T+3*86400000)]})]);
 const d=await new DailyPerformanceStore(dir).get({scope:'history'});
 assert.deepEqual(d.days.map(day=>day.date),['2026-11-08','2026-11-11']);assert.equal(d.coverage.intervals.length,2);
});
test('cutoff does not reveal a historical close before the batch that recorded it',async t=>{
 const dir=await temporary(t),id=randomUUID();
 await save(dir,id,[batch(id,1,{sourceMs:T+20000,closedTrades:[trade(1,T)]})]);
 const d=await new DailyPerformanceStore(dir).get({beforeMs:T});
 assert.deepEqual(d.days,[]);assert.deepEqual(d.coverage.intervals,[]);
});
test('reported feed gaps keep a full-bounds day marked partial',async t=>{
 const dir=await temporary(t),id=randomUUID(),start=Date.parse('2026-11-08T00:00:00Z');
 await save(dir,id,[batch(id,1,{sourceMs:start-1000}),batch(id,2,{sourceMs:T,market:{coverageGaps:1},closedTrades:[trade(1)]}),batch(id,3,{sourceMs:start+86400000})]);
 const d=await new DailyPerformanceStore(dir).get();
 assert.equal(d.coverage.hasCoverageGaps,true);assert.equal(d.coverage.boundsOnly,true);assert.equal(d.days[0].partial,true);
});

test('empty startup rows have no observed clock and do not invent a January 1970 day',async t=>{
 const dir=await temporary(t),id=randomUUID();
 await save(dir,id,[batch(id,1,{sourceMs:0}),batch(id,2,{sourceMs:T,closedTrades:[trade(1,T)]})]);
 const d=await new DailyPerformanceStore(dir).get({scope:'history'});
 assert.equal(d.coverage.startMs,T);assert.equal(d.days.length,1);assert.equal(d.days[0].date,'2026-11-08');
});
test('a zero source clock with completed trades or after observed time is invalid',async t=>{
 const dir=await temporary(t),id=randomUUID();
 await save(dir,id,[batch(id,1,{sourceMs:0,closedTrades:[trade(1)]}),batch(id,2)]);
 await assert.rejects(()=>new DailyPerformanceStore(dir).get(),/inconsistent/);
 await save(dir,id,[batch(id,1),batch(id,2,{sourceMs:0}),batch(id,3)]);
 await assert.rejects(()=>new DailyPerformanceStore(dir).get(),/inconsistent/);
});

test('a bounded-history HTTP error retains run choices so a smaller individual run can be opened',async t=>{
 const dir=await temporary(t),a=randomUUID(),b=randomUUID(),one=batch(a,1,{sourceMs:T,closedTrades:[trade(1,T)]}),two=batch(b,1,{sourceMs:T+86400000,closedTrades:[trade(1,T+86400000)]});
 await save(dir,a,[one]);await save(dir,b,[two]);
 const store=new DailyPerformanceStore(dir,{maxTotalBytes:Buffer.byteLength(JSON.stringify(one)+'\n')+10}),handlers=[];
 dailyPerformancePlugin(store).configureServer({middlewares:{use:fn=>handlers.push(fn)}});
 const server=http.createServer((req,res)=>handlers[0](req,res,()=>{res.statusCode=404;res.end();}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port;
 const response=await fetch(base+'/api/mnq/performance-days?scope=history'),data=await response.json();
 assert.equal(response.status,503);assert.equal(data.available,false);assert.match(data.error,/choose one saved run/);
 assert.equal(data.runCount,2);assert.equal(data.runs.length,2);assert.ok(data.runs.some(run=>run.id===a));
 assert.equal(data.days,undefined,'no partial accounting is presented as a result');
 const individual=await fetch(base+'/api/mnq/performance-days?runId='+a),result=await individual.json();
 assert.equal(individual.status,200);assert.equal(result.selectedRun.id,a);assert.equal(result.days[0].net,.5);
});
