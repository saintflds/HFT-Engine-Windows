import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {readFile} from 'node:fs/promises';
const code=ts.transpileModule(await readFile(new URL('../src/performance-data.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {sessionPerformanceDays}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const ORIGIN=Date.parse('2026-11-08T12:00:00Z');
function session(fills=[],options={}){
 const endMs=options.endMs??Math.max(1000,...fills.map(f=>f.received??f.ms))+100;
 const meta={symbol:'MNQZ26-CME',models:{asset:{kind:'LinearAsset',contract_size:2},fee:{kind:'TradingQtyFeeModel',maker:.75,taker:.75}},...options.meta};
 return {meta,t0:BigInt(options.origin??ORIGIN)*1000000n,tickSize:.25,endT:endMs*1e6,
  eT:fills.map(f=>(f.received??f.ms)*1e6),eExchT:fills.map(f=>f.ms*1e6),eKind:fills.map(f=>f.kind??3),
  eSide:fills.map(f=>f.side),eQty:fills.map(f=>f.qty??1),eExecTick:fills.map(f=>f.price/.25),
  frameT:options.frames??[0,endMs*1e6],accountingAt:options.accountingAt};
}
const fill=(ms,side,price,qty=1,received=ms)=>({ms,side,price,qty,received});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,a+' != '+b);
test('FIFO closes after recorded entry and exit costs, including open quantity',()=>{
 const s=session([fill(100,1,100),fill(300,-1,101)]);
 const before=sessionPerformanceDays(s,200e6);assert.equal(before.days.length,0);assert.equal(before.openQuantity,1);
 const done=sessionPerformanceDays(s,s.endT),d=done.days[0];
 assert.equal(done.basis,'closed-trade-net');assert.equal(done.available,true);assert.equal(d.date,'2026-11-08');
 assert.equal(d.gross,2);assert.equal(d.fees,1.5);assert.equal(d.net,.5);assert.equal(d.trades,1);assert.equal(d.wins,1);assert.equal(d.losses,0);assert.equal(d.partial,true);
 assert.equal(done.openQuantity,0);
});
test('entry costs crossing midnight are allocated to UTC exit day',()=>{
 const s=session([fill(100,1,100),fill(2000,-1,101)],{origin:Date.parse('2026-11-08T23:59:59Z')});
 const r=sessionPerformanceDays(s,Infinity);
 assert.equal(r.days.length,1);assert.equal(r.days[0].date,'2026-11-09');assert.equal(r.days[0].fees,1.5);assert.equal(r.days[0].net,.5);
});
test('partial fills preserve FIFO entry costs and count closing executions',()=>{
 const s=session([fill(100,1,100,2),fill(200,1,101),fill(300,-1,102,2),fill(400,-1,100)]);
 const partial=sessionPerformanceDays(s,350e6);assert.equal(partial.openQuantity,1);assert.equal(partial.days[0].net,5);
 const d=sessionPerformanceDays(s,Infinity).days[0];
 assert.equal(d.gross,6);assert.equal(d.fees,4.5);assert.equal(d.net,1.5);assert.equal(d.trades,2);assert.equal(d.wins,1);assert.equal(d.losses,1);
});
test('a reversal allocates the exit fee only to closed quantity and retains new entry costs',()=>{
 const s=session([fill(100,1,100),fill(200,-1,101,2),fill(300,1,100)]);
 const midway=sessionPerformanceDays(s,250e6);assert.equal(midway.openQuantity,-1);assert.equal(midway.days[0].net,.5);
 const d=sessionPerformanceDays(s,Infinity).days[0];assert.equal(d.gross,4);assert.equal(d.fees,3);assert.equal(d.net,1);assert.equal(d.trades,2);
});
test('a fill is not available before its local response, and rewind removes future results',()=>{
 const s=session([fill(100,1,100),fill(150,-1,101,1,300)]);
 const first=sessionPerformanceDays(s,250e6);assert.equal(first.days.length,0);
 const done=sessionPerformanceDays(s,300e6);assert.equal(done.days[0].net,.5);assert.equal(done.days[0].lastMs,ORIGIN+150);
 assert.deepEqual(sessionPerformanceDays(s,250e6),first);
});
test('native calculation ignores terminal P&L metadata until visible fills close',()=>{
 const s=session([fill(100,1,100),fill(300,-1,101)],{meta:{run:{equity:999999,fees:888888}}});
 assert.equal(sessionPerformanceDays(s,200e6).days.length,0);
 assert.equal(sessionPerformanceDays(s,Infinity).days[0].net,.5);
});
test('exact same-rate value fees include price and contract multiplier',()=>{
 const s=session([fill(100,1,100),fill(300,-1,101)],{meta:{models:{asset:{kind:'LinearAsset',contract_size:2},fee:{kind:'TradingValueFeeModel',maker:.001,taker:.001}}}});
 const d=sessionPerformanceDays(s,Infinity).days[0];near(d.fees,.402);near(d.net,1.598);
});
test('explicit rebates remain negative costs rather than being discarded',()=>{
 const s=session([fill(100,1,100),fill(300,-1,100)],{meta:{models:{asset:{kind:'LinearAsset',contract_size:2},fee:{kind:'TradingQtyFeeModel',maker:-.75,taker:-.75}}}});
 const d=sessionPerformanceDays(s,Infinity).days[0];assert.equal(d.fees,-1.5);assert.equal(d.net,1.5);assert.equal(d.wins,1);
});
test('no fills or only open inventory do not invent a flat profitable day',()=>{
 const empty=sessionPerformanceDays(session(),Infinity);assert.equal(empty.available,true);assert.deepEqual(empty.days,[]);
 const open=sessionPerformanceDays(session([fill(100,1,100)]),Infinity);assert.deepEqual(open.days,[]);assert.match(open.warning,/Open inventory/);
});
test('ambiguous or missing costs remain unavailable without recorded account totals',()=>{
 for(const fee of [undefined,{kind:'unknown',maker:.75,taker:.75},{kind:'TradingQtyFeeModel',maker:.5,taker:.75}]){
  const s=session([fill(100,1,100),fill(300,-1,101)],{meta:{models:{asset:{kind:'LinearAsset',contract_size:2},fee}}});
  const r=sessionPerformanceDays(s,Infinity);assert.equal(r.available,false);assert.equal(r.basis,'unavailable');assert.equal(r.days.length,0);
 }
});
test('malformed visible fills refuse calculations instead of producing a green day',()=>{
 for(const f of [fill(100,1,0),fill(100,0,100),fill(100,1,100,-1)]){
  const r=sessionPerformanceDays(session([f,fill(300,-1,101)]),Infinity);assert.equal(r.available,false);assert.equal(r.days.length,0);
 }
});
function markedOptions(overrides={}){
 const asked=[];
 return {asked,options:{endMs:1000,frames:[0,200e6,1000e6],meta:{models:{asset:{kind:'LinearAsset',contract_size:1},fee:{kind:'TradingValueFeeModel',maker:-.00005,taker:.0007}}},
  accountingAt:t=>{asked.push(t);return t<200e6?{equity:100,fees:10,fills:1,position:0}:t<1000e6?{equity:110,fees:12,fills:3,position:1}:{equity:999,fees:15,fills:4,position:0};},...overrides}};
}
test('marked fallback uses observed account changes without inventing an opening balance',()=>{
 const {options}=markedOptions();const r=sessionPerformanceDays(session([],options),400e6),d=r.days[0];
 assert.equal(r.basis,'marked-net');assert.equal(d.net,10);assert.equal(d.fees,2);assert.equal(d.gross,12);assert.equal(d.trades,2);assert.equal(r.openQuantity,1);
 assert.match(r.warning,/first observed frame/);
});
test('marked fallback never reads future frames or terminal totals while paused',()=>{
 const {options,asked}=markedOptions();const s=session([],options);const r=sessionPerformanceDays(s,400e6);
 assert.deepEqual(asked,[0,200e6]);assert.equal(r.days[0].net,10);
 const done=sessionPerformanceDays(s,Infinity);assert.equal(done.days[0].net,899);
 assert.equal(sessionPerformanceDays(s,400e6).days[0].net,10);
});
test('missing exact accounting leaves ambiguous-cost sample unavailable',()=>{
 const {options}=markedOptions({accountingAt:()=>({equity:null,fees:null,fills:0,position:0})});
 const r=sessionPerformanceDays(session([],options),Infinity);assert.equal(r.available,false);assert.deepEqual(r.days,[]);
});
test('live snapshots request saved live history rather than leaking current snapshot into replay',()=>{
 const s=session([],{meta:{live:{sim:{closedTrades:[{exitMs:ORIGIN+100,net:1000}]}}}});
 const r=sessionPerformanceDays(s,0);assert.equal(r.available,false);assert.deepEqual(r.days,[]);assert.match(r.warning,/saved live/);
});

test('positive fractional quantities are never silently discarded by a fixed tolerance',()=>{
 const s=session([fill(100,1,100,1e-10),fill(300,-1,101,1e-10)]);
 const r=sessionPerformanceDays(s,Infinity);assert.equal(r.days.length,1);assert.equal(r.openQuantity,0);
 assert.ok(Math.abs(r.days[0].gross-2e-10)<1e-20);assert.ok(Math.abs(r.days[0].fees-1.5e-10)<1e-20);
});
test('a corrupted response timestamp refuses a calendar instead of silently dropping a fill',()=>{
 const s=session([fill(100,1,100),fill(300,-1,101)]);s.eT[0]=NaN;
 const r=sessionPerformanceDays(s,Infinity);assert.equal(r.available,false);assert.deepEqual(r.days,[]);assert.match(r.warning,/response timestamp/);
});
