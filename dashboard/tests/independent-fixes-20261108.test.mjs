import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,appendFile,mkdtemp,readdir,rm,open} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';
import {JournalStore} from '../server/journal.mjs';
import {DeepStore} from '../server/deep-store.mjs';
import {liveFile,engineRoot} from '../server/project-paths.mjs';
import {assertTestingServer} from '../verify-project.mjs';
const compile=async file=>import('data:text/javascript;base64,'+Buffer.from(ts.transpileModule(await readFile(new URL('../src/'+file+'.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText).toString('base64'));
const {EngineJournal}=await compile('engine-journal'),{ReplaySimulation}=await compile('replay-simulation');
const temp=async t=>{const dir=await mkdtemp(path.join(tmpdir(),'hft-fix-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};
const batch=(runId,sequence=1)=>({schema:1,runId,sequence,symbol:'MNQZ26-CME',mode:'live',strategy:'liquidity',strategyVersion:'liquidity-flow-v2',sourceMs:2000,receivedMs:3000,trades:[],events:[],fills:[],closedTrades:[],adjustments:[],summary:{equity:0,fees:0,executionVersion:'response-aware-v1'}});
const lines=async file=>(await readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
for(const failure of ['partial','sync'])test('journal retry in the same process survives '+failure+' failure exactly once',async t=>{
 const dir=await temp(t),id=randomUUID();let fail=true;
 const store=new JournalStore(dir,{openFile:async(...args)=>{const h=await open(...args);return {close:()=>h.close(),writeFile:async text=>{if(fail&&failure==='partial'){fail=false;await h.writeFile(text.slice(0,23));throw Error('injected partial write');}await h.writeFile(text);},sync:async()=>{if(fail&&failure==='sync'){fail=false;throw Error('injected sync');}await h.sync();}};}});
 await assert.rejects(()=>store.append(batch(id)),/injected/);
 await store.append(batch(id));await store.append(batch(id,2));
 const file=path.join(dir,id,'batches.jsonl');assert.deepEqual((await lines(file)).map(b=>b.sequence),[1,2]);
 const restarted=new JournalStore(dir);await restarted.append(batch(id,3));
 assert.deepEqual((await lines(file)).map(b=>b.sequence),[1,2,3]);
 if(failure==='partial')assert.ok((await readdir(path.dirname(file))).some(n=>n.includes('.partial-')));
});
test('cached run detects and preserves an externally interrupted append',async t=>{
 const dir=await temp(t),id=randomUUID(),store=new JournalStore(dir);await store.append(batch(id));
 const file=path.join(dir,id,'batches.jsonl');await appendFile(file,'{"interrupted":');
 await store.append(batch(id,2));assert.equal((await lines(file)).length,2);
 assert.ok((await readdir(path.dirname(file))).some(n=>n.includes('.partial-')));
});
test('segment cap is a structured rollover response and never deletes the old segment',async t=>{
 const dir=await temp(t),id=randomUUID(),b=batch(id),limit=Buffer.byteLength(JSON.stringify(b)+'\n')+10;
 const store=new JournalStore(dir,{maxBytes:limit});await store.append(b);
 await assert.rejects(()=>store.append(batch(id,2)),e=>e.status===409&&e.code==='run_full'&&e.runId===id);
 assert.equal((await lines(path.join(dir,id,'batches.jsonl'))).length,1);
});
for(const failure of ['partial','sync'])test('deep examples retry '+failure+' failure without losing or duplicating the next example',async t=>{
 const dir=await temp(t);let fail=true;
 const store=new DeepStore(dir,{openFile:async(...args)=>{const h=await open(...args);return {close:()=>h.close(),writeFile:async text=>{if(fail&&failure==='partial'){fail=false;await h.writeFile(text.slice(0,11));throw Error('injected');}await h.writeFile(text);},sync:async()=>{if(fail&&failure==='sync'){fail=false;throw Error('injected');}await h.sync();}};}});
 await store.ready;const row={startMs:1,endMs:11,x:[1,2],y:1};
 await assert.rejects(()=>store.appendExample(row),/injected/);await store.appendExample(row);
 await store.appendExample({...row,startMs:12,endMs:22});
 assert.equal((await lines(path.join(dir,'examples.jsonl'))).length,2);
 const again=new DeepStore(dir);await again.ready;assert.equal(again.rows.length,2);
});
test('deep startup preserves a torn tail and the first newly written example',async t=>{
 const dir=await temp(t),row={startMs:1,endMs:11,x:[1],y:1};await writeFile(path.join(dir,'examples.jsonl'),JSON.stringify(row)+'\n{"torn":');
 const store=new DeepStore(dir);await store.ready;await store.appendExample({...row,startMs:12,endMs:22});
 const again=new DeepStore(dir);await again.ready;assert.equal(again.rows.length,2);
 assert.ok((await readdir(dir)).some(n=>n.includes('.partial-')));
});
const trade=(sequence,timeMs,side='buy',price=100,quantity=1)=>({sequence,timeMs,side,price,quantity});
const frame=(trades,extra={})=>({version:1,connected:true,delaySeconds:0,symbol:'MNQZ26-CME',replay:false,publishedMs:trades.at(-1).timeMs,tickSize:.25,last:100,bids:[[100,2,1],[99,5,1]],asks:[[100.25,2,1],[101.25,5,1]],trades,...extra});
const stub=async(t,fn)=>{const old=globalThis.fetch;globalThis.fetch=fn;t.after(()=>globalThis.fetch=old);};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
test('a valid pending batch survives contract, mode and strategy changes under its original identity',async t=>{
 const posted=[];let fail=true;await stub(t,async(_,init)=>{const b=JSON.parse(init.body);posted.push(b);if(fail){fail=false;return response({error:'temporary'},500);}return response({saved:true});});
 const sim=new ReplaySimulation({allowLive:true}),j=new EngineJournal(),f=frame([trade(1,1000)]);sim.accept(f,true);await j.record(f,sim.snapshot(),1000,true);
 const old=posted[0];const next=frame([trade(2,2000)],{symbol:'MNQH27-CME',replay:true});
 await j.record(next,{...sim.snapshot(),generation:2,strategy:'liquidity',sourceTimeMs:2000},2000,true);
 assert.deepEqual(posted[1],old);assert.equal(posted[2].symbol,'MNQH27-CME');assert.notEqual(posted[2].runId,old.runId);
});
test('unrelated 422 errors retain a valid pending batch',async t=>{
 let first=true;const posts=[];await stub(t,async(_,init)=>{posts.push(init.body);if(first){first=false;return response({code:'validation',error:'other validation problem'},422);}return response({saved:true});});
 const s=new ReplaySimulation({allowLive:true}),j=new EngineJournal(),f=frame([trade(1,1000)]);s.accept(f,true);await j.record(f,s.snapshot(),1000,true);assert.match(j.status,/error/);
 assert.equal(await j.retry(),true);assert.equal(posts[0],posts[1]);
});
test('legacy unsupported pending payload can clear without discarding supported payloads',async t=>{
 await stub(t,async()=>response({code:'unsupported_contract',error:'unsupported'},422));const j=new EngineJournal();
 j.pending=JSON.stringify({symbol:'M2KZ26-CME'});assert.equal(await j.retry(),true);assert.equal(j.pending,null);
 j.pending=JSON.stringify({symbol:'MNQZ26-CME'});assert.equal(await j.retry(),false);assert.ok(j.pending);
});
test('client rollover saves the waiting batch in a stable linked segment',async t=>{
 const posts=[];await stub(t,async(_,init)=>{const b=JSON.parse(init.body);posts.push(b);return posts.length===1?response({code:'run_full',runId:b.runId,error:'full'},409):response({saved:true});});
 const s=new ReplaySimulation({allowLive:true}),j=new EngineJournal(),f=frame([trade(1,1000)]);s.accept(f,true);await j.record(f,s.snapshot(),1000,true);
 assert.equal(posts.length,2);assert.equal(posts[1].continuationOf,posts[0].runId);assert.equal(posts[1].sequence,1);
 assert.deepEqual(posts[1].trades,posts[0].trades);assert.equal(j.status,'History: recording');
});
test('local position, fills, fees, and TP remain unknown until the fill response',()=>{
 const s=new ReplaySimulation({allowLive:true,strategy:'liquidity',latency:'constant'});
 s.accept(frame([trade(1,1000)]),true);
 s.accept(frame([trade(2,1010,'sell',99,6)]),true);
 let snap=s.snapshot();assert.equal(snap.position,0);assert.equal(snap.fillCount,0);assert.equal(snap.fees,0);assert.equal(snap.orders.some(o=>o.reason==='TP'),false);
 s.accept(frame([trade(3,1019,'buy',100,1)]),true);assert.equal(s.snapshot().position,0);
 s.accept(frame([trade(4,1020,'buy',100,1)]),true);snap=s.snapshot();
 assert.equal(snap.position,1);assert.equal(snap.fills[0].timeMs,1010);assert.equal(snap.fills[0].responseMs,1020);
 assert.ok(snap.orders.filter(o=>o.reason==='TP').every(o=>o.createdMs>=1020));
 assert.ok(snap.events.every(e=>e.timeMs<=snap.sourceTimeMs));
});
test('replacement waits for cancellation receipt, not just exchange effectiveness',()=>{
 const s=new ReplaySimulation({allowLive:true,latency:'constant'});s.accept(frame([trade(1,1000)]),true);
 const moved={bids:[[99.75,2,1]],asks:[[100.5,2,1]]};
 s.accept(frame([trade(2,2000)],moved),true);assert.equal(s.snapshot().submits,2);
 s.accept(frame([trade(3,2010)],moved),true);assert.equal(s.snapshot().submits,2);assert.ok(s.snapshot().orders.every(o=>o.state==='canceling'));
 s.accept(frame([trade(4,3020)],moved),true);assert.equal(s.snapshot().submits,4);
 assert.ok(s.snapshot().events.filter(e=>e.kind===5).every(e=>e.timeMs===2020));
});
test('multiple fills in flight preserve exchange capacity and receipt-order accounting',()=>{
 const s=new ReplaySimulation({allowLive:true,latency:'constant'});
 s.accept(frame([trade(1,1000)]),true);
 s.accept(frame([trade(2,1010,'sell',100,99),trade(3,1011,'sell',99,99),trade(4,1012,'buy',100.25,99)]),true);
 assert.equal(s.snapshot().fillCount,0);
 s.accept(frame([trade(5,1030,'buy',100.125)]),true);
 const snap=s.snapshot();assert.equal(snap.fillCount,2);assert.equal(snap.position,0);assert.equal(snap.fees,1.5);assert.equal(snap.realized,.5);assert.equal(snap.equity,-1);
 assert.deepEqual(snap.fills.map(f=>f.responseMs),[1022,1020]);
});
test('executed in-flight fills survive feed interruption exactly once',()=>{
 const s=new ReplaySimulation({allowLive:true,latency:'constant'});s.accept(frame([trade(1,1000)]),true);
 s.accept(frame([trade(2,1010,'sell',100,3)]),true);s.suspend();
 s.accept(frame([trade(100,2000,'buy',100.125)]),true);
 assert.equal(s.snapshot().fillCount,1);assert.equal(s.snapshot().position,1);
 s.accept(frame([trade(101,2010,'buy',100.125)]),true);assert.equal(s.snapshot().fillCount,1);
});
test('learning never restores historical runs made under the old execution assumption',async t=>{
 const dir=await temp(t),store=new JournalStore(dir),id=randomUUID(),b=batch(id);
 b.closedTrades=[{id:1,entryMs:1000,exitMs:2000,gross:2,fees:1.5,net:.5}];delete b.summary.executionVersion;
 await store.append(b);assert.equal((await store.profile(b.symbol)).fromRun,null);
});
test('verification watches the exact live file used by the server and refuses another project',async t=>{
 assert.equal(liveFile,path.join(engineRoot,'data/sierra/latest.json'));
 await stub(t,async()=>response({root:'D:/other-project'}));
 await assert.rejects(()=>assertTestingServer('http://localhost','D:/Market Project - Testing'),/Refusing/);
});

test('deep collector retries the exact label after a sync failure on a newer frame',async t=>{
 const dir=await temp(t);let fail=true;
 const store=new DeepStore(dir,{openFile:async(...args)=>{const h=await open(...args);return {close:()=>h.close(),writeFile:text=>h.writeFile(text),sync:async()=>{if(fail){fail=false;throw Error('injected sync');}await h.sync();}};}});
 await store.ready;
 const b=at=>({...batch(randomUUID()),sourceMs:at,market:{fresh:true,connected:true,coverageGaps:0},trades:[{}],summary:{markPrice:100,signal:{warmed:true,flow:.2,depth:.2,momentumTicks:1,rangeTicks:4,spreadTicks:1,prints:30}}});
 for(const at of [1000,4000,7000,10000])await store.collect(b(at));
 await assert.rejects(()=>store.collect(b(11000)),/injected sync/);
 await store.collect(b(12000));
 const rows=await lines(path.join(dir,'examples.jsonl'));assert.equal(rows.length,1);assert.equal(rows[0].startMs,1000);assert.equal(rows[0].endMs,11000);
});

test('sparse publications deliver acknowledgements, fills and cancel responses in chronological order',()=>{
 for(let start=1000;start<3000;start+=37){
  const s=new ReplaySimulation({allowLive:true,strategy:'liquidity',latency:'variable'});
  const book={bids:[[100,1,1],[99,1,1],[98.5,1,1],[98,1,1]],asks:[[100.25,1,1],[101,1,1],[101.5,1,1],[102,1,1]]};
  s.accept(frame([trade(1,start)],book),true);
  const buy=s.snapshot().orders.filter(o=>o.side==='buy').sort((a,b)=>b.price-a.price)[0];
  s.accept(frame([trade(2,buy.activeMs+.1,'sell',buy.price,99)],book),true);
  s.accept(frame([trade(3,start+1000,'buy',100)],book),true);
  const e=s.snapshot().events;
  assert.ok(e.every((v,i)=>!i||v.timeMs>=e[i-1].timeMs),'late responses must not retroactively insert earlier account events');
  assert.ok(e.every(v=>v.timeMs<=s.snapshot().sourceTimeMs));
 }
});

test('rollover linkage survives later batches and a server restart',async t=>{
 const dir=await temp(t),old=randomUUID(),id=randomUUID(),first={...batch(id),continuationOf:old,continuationSequence:42};
 let store=new JournalStore(dir);await store.append(first);await store.append(batch(id,2));
 let summary=JSON.parse(await readFile(path.join(dir,id,'summary.json'),'utf8'));assert.equal(summary.continuationOf,old);
 store=new JournalStore(dir);await store.append(batch(id,3));
 summary=JSON.parse(await readFile(path.join(dir,id,'summary.json'),'utf8'));assert.equal(summary.continuationOf,old);assert.equal(summary.continuationSequence,42);
});
