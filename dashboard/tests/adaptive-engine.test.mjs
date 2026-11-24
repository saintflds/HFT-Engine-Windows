import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {readFile,mkdtemp,appendFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {JournalStore,validateBatch} from '../server/journal.mjs';
const js=ts.transpileModule(await readFile(new URL('../src/replay-simulation.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {ReplaySimulation,modeledDelay,learningDecision}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const trade=(sequence,timeMs,side='buy',price=100,quantity=1)=>({sequence,timeMs,side,price,quantity});
const frame=(trades,extra={})=>({symbol:'MNQZ26-CME',replay:false,publishedMs:trades.at(-1)?.timeMs??1000,tickSize:.25,last:trades.at(-1)?.price??100,
  bids:[[100,4,1],[99.75,4,1],[99.5,4,1],[99,40,2],[98.5,20,2]],asks:[[100.25,2,1],[100.5,2,1],[101,2,1],[102.5,3,1],[103,3,1]],trades,...extra});
test('variable latency is bounded, repeatable, and different across requests',()=>{
  const values=Array.from({length:100},(_,i)=>modeledDelay(1000+i*7919,1));
  assert.ok(new Set(values).size>50);assert.ok(values.every(n=>n>=4&&n<=60));
  assert.deepEqual(values,Array.from({length:100},(_,i)=>modeledDelay(1000+i*7919,1)));
});
test('each order waits for its sampled delay; ack and fill response timestamps agree with their model',()=>{
  const s=new ReplaySimulation({allowLive:true});s.accept(frame([trade(1,1000)]),true);
  const o=s.snapshot().orders.find(o=>o.side==='buy');
  s.accept(frame([trade(2,o.activeMs-.1,'sell',100,100)]),true);assert.equal(s.snapshot().fillCount,0);
  s.accept(frame([trade(3,o.activeMs+.1,'sell',100,100)]),true);
  assert.equal(s.snapshot().fillCount,0,'fill report is still in flight');
  s.accept(frame([trade(4,o.activeMs+100,'buy',100.125,1)]),true);
  const snap=s.snapshot(),ack=snap.events.find(e=>e.kind===2&&e.orderId===o.id),fill=snap.fills[0];
  assert.ok(Math.abs(ack.exchangeMs-ack.requestMs-o.entryLatencyMs)<1e-6);
  assert.ok(Math.abs(ack.timeMs-ack.exchangeMs-o.responseLatencyMs)<1e-6);
  assert.ok(fill.responseMs>fill.timeMs&&fill.responseMs-fill.timeMs<=60);
  const before=s.snapshot();s.accept(frame([trade(4,o.activeMs+100,'buy',100.125,1)],{publishedMs:999999}),true);assert.deepEqual(s.snapshot(),before);
});
test('cancellations use their own request and response delays',()=>{
  const s=new ReplaySimulation({allowLive:true});s.accept(frame([trade(1,1000)]),true);
  s.accept(frame([trade(2,2100)],{bids:[[99.75,4,1]],asks:[[100.5,4,1]]}),true);
  const canceled=s.snapshot().orders.filter(o=>o.cancelMs!==null);assert.equal(canceled.length,2);
  s.accept(frame([trade(3,2200)]),true);
  for(const o of canceled){const e=s.snapshot().events.find(e=>e.kind===5&&e.orderId===o.id);assert.equal(e.requestMs,o.cancelRequestMs);assert.equal(e.exchangeMs,o.cancelMs);assert.ok(Math.abs(e.timeMs-e.exchangeMs-o.cancelResponseMs)<1e-6);}
});
test('v2 waits for warmup and aligned pressure, then records a complete fee-inclusive round trip',()=>{
  const s=new ReplaySimulation({allowLive:true,strategy:'liquidity',adaptive:true});s.accept(frame([trade(1,1000)]),true);assert.equal(s.snapshot().submits,0);
  for(let i=2;i<=40;i++)s.accept(frame([trade(i,1000+i*500)]),true);
  const pending=s.snapshot().orders.filter(o=>['pending','working'].includes(o.state));assert.ok(pending.length>0);assert.ok(pending.every(o=>o.side==='buy'));
  const entry=pending.sort((a,b)=>b.price-a.price)[0];s.accept(frame([trade(41,22000,'sell',entry.price,100)]),true);
  assert.equal(s.snapshot().position,0,'entry is not yet known');
  s.accept(frame([trade(42,22100,'buy',100,1)]),true);
  assert.equal(s.snapshot().position,1);
  const exit=s.snapshot().orders.find(o=>o.reason==='TP');assert.ok(exit);
  s.accept(frame([trade(43,23000,'buy',exit.price,100)]),true);
  s.accept(frame([trade(44,23100,'buy',exit.price,1)]),true);
  const snap=s.snapshot(),closed=snap.closedTrades[0];assert.equal(snap.position,0);assert.equal(closed.net,closed.gross-closed.fees);assert.equal(closed.fees,1.5);assert.equal(closed.entryPrice,entry.price);assert.equal(closed.reason,'TP');assert.ok(closed.mfeTicks>=12);assert.equal(snap.learning.samples,1);
});
test('learning needs 20 closed trades, tightens after losses, remains bounded and relaxes one step only',()=>{
  assert.equal(learningDecision(Array(19).fill(-3),0).level,0);
  assert.equal(learningDecision(Array(20).fill(-3),0).level,1);
  assert.equal(learningDecision(Array(20).fill(-3),2).level,2);
  assert.equal(learningDecision(Array(20).fill(2),2).level,1);
  assert.equal(learningDecision(Array(20).fill(2),0).level,0);
});
test('live learning is restored but replay and source changes cannot leak previous outcomes',()=>{
  const s=new ReplaySimulation({allowLive:true,strategy:'liquidity',adaptive:true});s.restoreLearning({outcomes:Array(25).fill(-1),riskLevel:2,reviewsSince:5});
  assert.equal(s.snapshot().learning.nextReview,15);s.accept(frame([trade(1,1000)]),true);assert.equal(s.snapshot().learning.riskLevel,2);
  s.accept(frame([trade(1,1000)],{replay:true,publishedMs:2000}),true);assert.equal(s.snapshot().learning.samples,0);assert.equal(s.snapshot().learning.riskLevel,0);
});
const batch=(runId,sequence=1,extra={})=>({schema:1,runId,sequence,symbol:'MNQZ26-CME',mode:'live',strategy:'liquidity',strategyVersion:'liquidity-flow-v2',sourceMs:2000,receivedMs:3000,
  trades:[],events:[],fills:[],closedTrades:[{id:sequence,entryMs:1000,exitMs:2000,gross:2,fees:1.5,net:.5}],adjustments:[],summary:{executionVersion:'response-aware-v1',equity:.5,fees:1.5,learning:{outcomes:[.5],riskLevel:1,nextReview:19}},...extra});
test('journal persists once, rejects gaps, survives restart/torn tail, and restores compatible live history',async()=>{
  const folder=await mkdtemp(fileURLToPath(new URL('../journal-test-',import.meta.url))),id=randomUUID();
  let store=new JournalStore(folder);await store.append(batch(id));await store.append(batch(id));
  assert.equal((await readFile(path.join(folder,id,'batches.jsonl'),'utf8')).trim().split('\n').length,1);
  await assert.rejects(()=>store.append(batch(id,3)),/gap/);
  await appendFile(path.join(folder,id,'batches.jsonl'),'{"torn":');store=new JournalStore(folder);
  await store.append(batch(id,2));assert.equal((await readFile(path.join(folder,id,'batches.jsonl'),'utf8')).trim().split('\n').length,2);
  await store.append(batch(randomUUID(),1,{mode:'replay',receivedMs:99999,summary:{equity:999,fees:1.5}}));
  const profile=await store.profile('MNQZ26-CME');assert.equal(profile.fromRun,id);assert.deepEqual(profile.outcomes,[.5]);assert.equal(profile.riskLevel,1);
});
test('journal rejects path traversal, invalid accounting, and future closed trades',()=>{
  assert.throws(()=>validateBatch(batch('../escape')),/Invalid/);
  assert.throws(()=>validateBatch(batch(randomUUID(),1,{closedTrades:[{id:1,entryMs:1,exitMs:2001,gross:2,fees:1.5,net:.5}]})),/Invalid completed/);
  assert.throws(()=>validateBatch(batch(randomUUID(),1,{closedTrades:[{id:1,entryMs:1,exitMs:2,gross:2,fees:1.5,net:100}]})),/Invalid completed/);
});

