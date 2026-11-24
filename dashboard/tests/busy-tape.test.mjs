import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {readFile} from 'node:fs/promises';
const js=ts.transpileModule(await readFile(new URL('../src/replay-simulation.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {ReplaySimulation}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
test('busy tape retains twenty seconds of flow and completes warmup beyond 2000 prints',()=>{
 const model=new ReplaySimulation({allowLive:true,strategy:'liquidity',adaptive:true}),tape=[];
 const feed=()=>({symbol:'MNQZ26-CME',replay:false,publishedMs:tape.at(-1).timeMs,tickSize:.25,last:100,bids:[[100,4,1],[99.75,4,1],[99.5,4,1],[99,40,2],[98.5,20,2]],asks:[[100.25,2,1],[100.5,2,1],[101,2,1],[102.5,3,1],[103,3,1]],trades:tape.slice(-1000)});
 for(let frame=0;frame<300;frame++){for(let i=0;i<50;i++){const n=frame*50+i;tape.push({sequence:n+1,timeMs:1000+n*2,side:'buy',price:100,quantity:1});}model.accept(feed(),true);}
 const s=model.snapshot();assert.equal(s.signal.warmed,true);assert.ok(s.signal.prints>9000);assert.ok(s.signal.prints<=10001);assert.equal(s.signal.flow,1);assert.equal(s.signal.rangeTicks,0);assert.ok(s.submits>0);assert.equal(s.dataGaps,0);
 model.suspend();model.accept(feed(),true);assert.equal(model.snapshot().signal.warmed,false);
});
