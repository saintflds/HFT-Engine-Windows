import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {readFile} from 'node:fs/promises';
const load=async name=>import('data:text/javascript;base64,'+Buffer.from(ts.transpileModule(await readFile(new URL(`../src/${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText).toString('base64'));
const {Session}=await load('session'),{ReplayClock}=await load('clock');
function fixture(extra={}){
 const arrays=new Map(),add=(name,C,data)=>arrays.set(name,{data:new C(data),shape:[data.length]});
 for(const name of ['frame_t','balance','fee','events_local','events_exch','wall_ms','feed_lat_last','feed_lat_min','feed_lat_max','feed_lat_mean','feed_batches','position','num_trades','volume'])add(name,Float64Array,[0,0]);
 add('frame_t',Float64Array,[0,100e6]);
 for(const name of ['best_bid_tick','best_ask_tick','bid_tick','ask_tick'])add(name,Int32Array,[400,400]);
 for(const name of ['bid_qty','ask_qty'])add(name,Float32Array,[5,5]);
 add('order_start',Uint32Array,[0,0,0]);
 for(const name of ['o_id','o_side','o_tick','o_qty','o_leaves','o_status','o_req','o_front','o_level','o_submit_t','o_ack_t','o_trades_at_level'])add(name,Float64Array,[]);
 for(const name of ['tr_exch_t','tr_local_t','tr_tick','tr_qty','tr_side'])add(name,Float64Array,[]);
 add('e_t',Float64Array,[0,120e6,136e6]);add('e_kind',Uint8Array,[1,2,3]);
 for(const name of ['e_id','e_side','e_tick','e_qty','e_req_t','e_exch_t','e_front','e_level','e_exec_tick','e_traded_at_level'])add(name,Float64Array,[42,42,42]);
 return {arrays,meta:{t0_ns:'1000000000000000000',t_end_ns:'1000000000150000000',tick_size:.25,lot_size:1,frame_ns:100e6,levels:1,n_frames:2,models:{asset:{kind:'LinearAsset',contract_size:2}},run:{final_position:1,fills:1,balance:-200,fees:.75,mark_price:100,equity:-.75},...extra}};
}
test('terminal ACK/fill are reachable while final accounting cannot leak into an earlier frame or rewind',()=>{
 const s=new Session(fixture()),clock=new ReplayClock(s.endT);
 assert.equal(s.endT,150e6);clock.seek(Infinity);assert.equal(clock.t,150e6);assert.equal(s.eventsUpTo(clock.t),3);assert.equal(s.frameAt(clock.t),1);
 assert.deepEqual(s.accountingAt(clock.t),{terminal:true,position:1,fills:1,balance:-200,fees:.75,markPrice:100,equity:-.75});
 clock.seek(100e6);assert.equal(s.eventsUpTo(clock.t),1);assert.equal(s.accountingAt(clock.t).terminal,false);assert.equal(s.accountingAt(clock.t).position,0);assert.equal(s.accountingAt(clock.t).fills,0);assert.equal(s.accountingAt(clock.t).equity,0);
 assert.equal(s.accountingAt(150e6-1).position,0);assert.equal(s.position[1],0);assert.equal(s.numTrades[1],0);
});
test('absent or invalid terminal accounting never substitutes unverified totals',()=>{
 for(const meta of [{run:undefined},{run:{final_position:99,fills:99,balance:0,fees:0,mark_price:100,equity:0}}]){
  const s=new Session(fixture(meta));assert.equal(s.eventsUpTo(s.endT),3);assert.equal(s.accountingAt(s.endT).terminal,false);assert.equal(s.accountingAt(s.endT).position,0);
 }
});
test('invalid remote declared end cannot create an empty replay tail',()=>{
 for(const value of ['bad','-1','1000000009000000000'])assert.equal(new Session(fixture({t_end_ns:value})).endT,136e6);
});
test('market trades extend old recorded tails even when no terminal metadata exists',()=>{
 const h=fixture({t_end_ns:undefined,run:undefined});h.arrays.set('tr_local_t',{data:Float64Array.of(170e6),shape:[1]});h.arrays.set('tr_exch_t',{data:Float64Array.of(170e6),shape:[1]});h.arrays.set('tr_tick',{data:Int32Array.of(400),shape:[1]});h.arrays.set('tr_qty',{data:Float32Array.of(1),shape:[1]});h.arrays.set('tr_side',{data:Int8Array.of(1),shape:[1]});
 const s=new Session(h);assert.equal(s.endT,170e6);assert.equal(s.tradesUpTo(s.endT),1);
});
test('live sessions keep their observed frame clock and ignore backtest terminal metadata',()=>{
 const s=new Session(fixture({live:{}}));assert.equal(s.endT,100e6);assert.equal(s.eventsUpTo(s.endT),1);assert.equal(s.accountingAt(s.endT).terminal,false);assert.equal(s.accountingAt(s.endT).position,0);
});
