import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {network,forward,step,train,chronologicalSplit,vector} from '../server/deep-network.mjs';
import {DeepStore} from '../server/deep-store.mjs';

test('backpropagation learns a nonlinear classification and probabilities remain normalized',()=>{
 const model=network();const examples=[{x:[1,1,0,0,0,0],y:0},{x:[-1,1,0,0,0,0],y:2},{x:[1,-1,0,0,0,0],y:2},{x:[-1,-1,0,0,0,0],y:0}];
 for(let i=0;i<4000;i++)for(const e of examples)step(model,e.x,e.y,.01);
 for(const e of examples){const p=forward(model,e.x).at(-1);assert.equal(p.indexOf(Math.max(...p)),e.y);assert.ok(p[e.y]>.9);assert.ok(Math.abs(p.reduce((a,b)=>a+b,0)-1)<1e-10);}
});
test('chronological splits purge labels crossing into the next split',()=>{
 const rows=Array.from({length:600},(_,i)=>({startMs:i*10000,endMs:(i+1)*10000}));
 const s=chronologicalSplit(rows);assert.ok(s.train.at(-1).endMs<s.validation[0].startMs);assert.ok(s.validation.at(-1).endMs<s.test[0].startMs);
});
test('test outcomes cannot change trained weights or validation checkpoint',()=>{
 const rows=Array.from({length:600},(_,i)=>({startMs:i*10000,endMs:(i+1)*10000,x:[i%2?1:-1,0,0,0,0,0],y:i%2?2:0,moveTicks:i%2?10:-10,costTicks:4}));
 const a=train(rows),other=structuredClone(rows);for(let i=510;i<600;i++)other[i].y=1;
 const b=train(other);assert.deepEqual(a.layers,b.layers);assert.deepEqual(a.validation,b.validation);assert.notDeepEqual(a.test,b.test);assert.equal(b.qualified,false);
});
test('deep history deduplicates tabs, waits for future labels and excludes replay, stale data and gaps',async()=>{
 const folder=await mkdtemp(path.join(tmpdir(),'hft-deep-')),store=new DeepStore(folder);await store.ready;
 const batch=t=>({mode:'live',symbol:'MNQZ26-CME',sourceMs:t,runId:'test',market:{fresh:true,connected:true,coverageGaps:0},trades:[{}],summary:{markPrice:100+t/10000,signal:{flow:1,depth:.5,momentumTicks:2,rangeTicks:4,spreadTicks:1,prints:100,warmed:true}}});
 for(let t=1000;t<=11000;t+=1000){await store.observe(batch(t));await store.observe({...batch(t),runId:'other-tab'});}
 assert.equal(store.rows.length,1);assert.equal(store.rows[0].startMs,1000);assert.equal(store.rows[0].endMs,11000);assert.deepEqual(store.rows[0].x,vector(batch(1000).summary.signal));
 await store.observe({...batch(12000),mode:'replay'});await store.observe({...batch(13000),market:{fresh:false,connected:true}});await store.observe(batch(40000));assert.equal(store.rows.length,1);
 const restarted=new DeepStore(folder);await restarted.ready;assert.equal(restarted.rows.length,1);assert.equal(restarted.status().model,null);assert.equal(restarted.status().status,'Collecting market examples');
 assert.equal((await readFile(path.join(folder,'examples.jsonl'),'utf8')).trim().split('\n').length,1);
});
