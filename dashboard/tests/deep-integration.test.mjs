import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {readFile} from 'node:fs/promises';
const moduleFrom=async file=>import('data:text/javascript;base64,'+Buffer.from(ts.transpileModule(await readFile(new URL(file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText).toString('base64'));
const {ReplaySimulation}=await moduleFrom('../src/replay-simulation.ts');
const {DeepModel}=await moduleFrom('../src/deep-model.ts');
import {network,forward,vector} from '../server/deep-network.mjs';
const signal={flow:.5,depth:.3,momentumTicks:2,rangeTicks:6,spreadTicks:1,prints:100,warmed:true};
test('browser inference agrees with training code and rejects unqualified, expired or future models',()=>{
 const client=new DeepModel(),now=Date.now(),layers=network();
 client.state.model={version:'mnq-deep-v1',symbol:'MNQZ26-CME',qualified:true,trainedMs:now-1000,layers};
 const prediction=client.predict(signal,now),expected=forward(layers,vector(signal)).at(-1);
 assert.deepEqual([prediction.sell,prediction.flat,prediction.buy],expected);
 assert.equal(client.predict(signal,now-2000),null);
 client.state.model.qualified=false;assert.equal(client.predict(signal,now),null);
 client.state.model.qualified=true;client.state.model.trainedMs=now-8*86400000;assert.equal(client.predict(signal,now),null);
});
const frame=(i,extra={})=>({symbol:'MNQZ26-CME',replay:false,publishedMs:1000+i*500,tickSize:.25,last:100,bids:[[100,4,1],[99.75,4,1],[99.5,4,1],[99,40,2],[98.5,20,2]],asks:[[100.25,2,1],[100.5,2,1],[101,2,1],[102.5,3,1],[103,3,1]],trades:[{sequence:i,timeMs:1000+i*500,side:'buy',price:100,quantity:1}],...extra});
test('deep probability veto blocks new entries, learning-off bypasses it and replay never calls it',()=>{
 const s=new ReplaySimulation({allowLive:true,strategy:'liquidity',adaptive:true});let calls=0;
 s.setPredictor(()=>{calls++;return {buy:.1,sell:.1,flat:.8};});for(let i=1;i<=40;i++)s.accept(frame(i),true);
 assert.ok(calls>0);assert.equal(s.snapshot().submits,0);
 s.setLearning(false);for(let i=41;i<=50;i++)s.accept(frame(i),true);assert.ok(s.snapshot().submits>0);
 const replay=new ReplaySimulation({strategy:'liquidity',adaptive:true});replay.setPredictor(()=>{throw Error('Replay leaked live model');});
 for(let i=1;i<=40;i++)replay.accept(frame(i,{replay:true}),true);assert.ok(replay.snapshot().submits>0);
});
test('a bearish forecast cannot block the protective exit of an existing long',()=>{
 const s=new ReplaySimulation({allowLive:true,strategy:'liquidity',adaptive:true});s.setPredictor(()=>({buy:.9,sell:.05,flat:.05}));for(let i=1;i<=40;i++)s.accept(frame(i),true);
 s.accept(frame(41,{last:99,trades:[{sequence:41,timeMs:22000,side:'sell',price:99,quantity:100}]}),true);
 s.accept(frame(42,{trades:[{sequence:42,timeMs:22100,side:'buy',price:100,quantity:1}]}),true);assert.equal(s.snapshot().position,1);
 s.setPredictor(()=>({buy:.05,sell:.05,flat:.9}));
 s.accept(frame(43,{last:96,trades:[{sequence:43,timeMs:23000,side:'sell',price:96,quantity:100}]}),true);
 s.accept(frame(44,{last:96,trades:[{sequence:44,timeMs:24000,side:'sell',price:96,quantity:100}]}),true);
 s.accept(frame(45,{trades:[{sequence:45,timeMs:24100,side:'buy',price:96,quantity:1}]}),true);
 assert.equal(s.snapshot().position,0);assert.equal(s.snapshot().closedTrades[0].reason,'STOP');
});
