import type {LiveFrame} from './live-session';
import type {SimulationSnapshot} from './replay-simulation';
const supported=(symbol:unknown):boolean=>typeof symbol==='string'&&/^MNQ[HMUZ]\d{2}-CME(?:\[M\])?$/i.test(symbol);
export class EngineJournal {
  status='History: connecting';
  private runId=crypto.randomUUID();
  private identity=''; private sequence=0; private lastEvent=0; private lastFill=0; private lastClosed=0; private lastPrint=-1; private lastDepth=-Infinity; private lastAdjustment=0;
  private pending:string|null=null;
  async profile():Promise<{outcomes:number[];riskLevel:number;reviewsSince?:number}> {
    try{const r=await fetch('/api/mnq/journal?symbol=MNQZ26-CME',{cache:'no-store',signal:AbortSignal.timeout(3000)});const d=await r.json();if(!r.ok||d.error)throw Error(d.error||'History service unavailable');this.status='History: ready';return d.profile;}
    catch{this.status='History: unavailable — reconnecting';return {outcomes:[],riskLevel:0};}
  }
  private async flush():Promise<void>{
    for(let rollovers=0;this.pending;){
      const batch=JSON.parse(this.pending);
      const r=await fetch('/api/mnq/journal',{method:'POST',headers:{'Content-Type':'application/json'},body:this.pending,keepalive:this.pending.length<50000,signal:AbortSignal.timeout(3000)});
      let d:any={};try{d=await r.json();}catch{}
      if(!r.ok||d.error){
        if(r.status===422&&d.code==='unsupported_contract'&&!supported(batch.symbol)){
          this.pending=null;this.status=`History: unsupported contract ${batch.symbol} — recording resumes with a supported MNQ feed.`;return;
        }
        if(r.status===409&&d.code==='run_full'&&d.runId===batch.runId&&rollovers++<1){
          // Move the UNSAVED batch, unchanged except for run identity, to a new
          // segment. Old segments remain intact; retries keep this same new ID.
          const old=batch.runId,next=crypto.randomUUID();
          batch.runId=next;batch.sequence=1;batch.continuationOf=old;
          batch.continuationSequence=JSON.parse(this.pending).sequence;
          this.pending=JSON.stringify(batch);
          if(this.runId===old){this.runId=next;this.sequence=1;}
          continue;
        }
        throw Error(d.error||'History write failed; pending data retained');
      }
      this.pending=null;this.status='History: recording';
    }
  }
  async retry():Promise<boolean>{try{await this.flush();return true;}catch(e){this.status=`History error: ${e instanceof Error?e.message:String(e)}`;return false;}}
  async record(frame:LiveFrame,s:SimulationSnapshot,receivedMs:number,fresh:boolean):Promise<void>{
    try{
      // Always finish the previous run's valid write under its original ID.
      // A new contract/mode/strategy cannot make that record invalid.
      await this.flush();
      if(!supported(frame.symbol)){this.status=`History: unsupported contract ${frame.symbol} — recording resumes with a supported MNQ feed.`;return;}
      const mode=frame.replay?'replay':'live',identity=`${s.generation}|${frame.symbol}|${mode}|${s.strategy}|${s.strategyVersion}`;
      if(identity!==this.identity){this.identity=identity;this.runId=crypto.randomUUID();this.sequence=0;this.lastEvent=this.lastFill=this.lastClosed=this.lastAdjustment=0;this.lastPrint=-1;this.lastDepth=-Infinity;}
      const trades=frame.trades.filter(t=>t.sequence>this.lastPrint).sort((a,b)=>a.sequence-b.sequence);
      const depth=s.sourceTimeMs-this.lastDepth>=1000?{bids:frame.bids,asks:frame.asks}:null;
      const events=s.events.filter(e=>e.sequence>this.lastEvent),fills=s.fills.filter(f=>Number(f.id.slice(2))>this.lastFill),closedTrades=s.closedTrades.filter(t=>t.id>this.lastClosed),adjustments=s.learning.changes.filter(c=>c.id>this.lastAdjustment);
      if(!depth&&!trades.length&&!events.length&&!fills.length&&!closedTrades.length&&!adjustments.length)return;
      this.pending=JSON.stringify({schema:1,runId:this.runId,sequence:++this.sequence,symbol:frame.symbol,mode,strategy:s.strategy,strategyVersion:s.strategyVersion,sourceMs:s.sourceTimeMs,receivedMs,
        market:{publishedMs:frame.publishedMs,connected:frame.connected,fresh,delaySeconds:frame.delaySeconds,tickSize:frame.tickSize,last:frame.last,depth,coverageGaps:s.dataGaps,firstBatch:this.lastPrint<0},
        sierraAccount:(frame as any).sierraAccount??null,trades,events,fills,closedTrades,adjustments,summary:{equity:s.equity,realized:s.realized,unrealized:s.unrealized,fees:s.fees,position:s.position,fillCount:s.fillCount,markPrice:s.markPrice,
          executionVersion:s.executionVersion,latencyMode:s.latencyMode,targetTicks:s.targetTicks,stopTicks:s.stopTicks,cooldownMs:s.cooldownMs,levelsPerSide:s.levelsPerSide,decision:s.decision,signal:s.signal,neural:s.neural,learning:{...s.learning,changes:undefined},engineStatus:s.status}});
      if(depth)this.lastDepth=s.sourceTimeMs;
      this.lastPrint=Math.max(this.lastPrint,...trades.map(t=>t.sequence));this.lastEvent=Math.max(this.lastEvent,...events.map(e=>e.sequence));this.lastFill=Math.max(this.lastFill,...fills.map(f=>Number(f.id.slice(2))));this.lastClosed=Math.max(this.lastClosed,...closedTrades.map(t=>t.id));this.lastAdjustment=Math.max(this.lastAdjustment,...adjustments.map(c=>c.id));
      await this.flush();
    }catch(e){this.status=`History error: ${e instanceof Error?e.message:String(e)}`;}
  }
}
