import {mkdir,readFile,writeFile,rename,open,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {DeepStore} from './deep-store.mjs';
import {recoverJsonl,appendJsonl,sizeOf,syncJsonl} from './jsonl.mjs';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../Engine History');
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const runPattern=/^[a-f0-9-]{36}$/;
const VERSION='liquidity-flow-v2';
export function validateBatch(b) {
  if(!b||b.schema!==1||!runPattern.test(b.runId)||!Number.isSafeInteger(b.sequence)||b.sequence<1
    ||!/^MNQ[HMUZ]\d{2}-CME(?:\[M\])?$/i.test(b.symbol)||!['live','replay'].includes(b.mode)
    ||!['queue','liquidity'].includes(b.strategy)||!['liquidity-flow-v2','legacy-v1'].includes(b.strategyVersion)
    ||!finite(b.sourceMs)||!finite(b.receivedMs)||!b.summary||!finite(b.summary.equity)||!finite(b.summary.fees)) throw Error('Invalid journal batch.');
  for(const field of ['trades','events','fills','closedTrades','adjustments']) if(!Array.isArray(b[field])||b[field].length>15000)throw Error('Invalid journal records.');
  for(const t of b.closedTrades) if(!Number.isSafeInteger(t.id)||t.id<1||![t.net,t.gross,t.fees,t.entryMs,t.exitMs].every(finite)
    ||t.fees<0||Math.abs(t.gross-t.fees-t.net)>.0001||t.exitMs<t.entryMs||t.exitMs>b.sourceMs+.001)throw Error('Invalid completed trade.');
  return b;
}

export class JournalStore {
  constructor(folder=root,options={}) {this.folder=folder;this.runs=new Map();this.lock=Promise.resolve();this.maxBytes=options.maxBytes??256*1024*1024;this.openFile=options.openFile;}
  async setup() {
    await mkdir(this.folder,{recursive:true});
    await writeFile(path.join(this.folder,'READ ME.txt'),
      'HFTENGINE observed market and simulated execution history\r\n\r\nEach run has append-only batches.jsonl and summary.json. All times are UTC Unix milliseconds.\r\nBatches include received market prints, sampled depth (once per source second), order lifecycle events, fills with reasons, closed round trips, P&L, signal values and learning changes.\r\nThese are observations received by the dashboard, not a complete exchange recording. Coverage gaps are explicit.\r\nEngine results and timing are simulated. Sierra account orders are separate and are not used for learning.\r\nLearning reviews 20 completed engine round trips, including fees. Negative expectancy tightens entry flow and cooldown; sustained positive expectancy can relax one step. Position stays capped at 1; stop/target limits never expand.\r\nNew live runs load up to 100 completed trades from compatible live runs only. Replay and other strategy versions do not train live runs. Existing historical recordings are not altered.\r\nRecording requires an open Live MNQ tab. Closing the tab stops recording; pending writes may be lost on a crash. Each new tab/reset creates a separate run. Do not treat overlapping runs as independent market samples.\r\nNo automatic deletion. Runs roll over to a new linked segment at 256 MiB. Old segments are preserved.\r\n','utf8');
  }

  append(raw) {
    const batch=validateBatch(raw);
    const task=this.lock.then(()=>this.write(batch));this.lock=task.catch(()=>{});return task;
  }
  async loadRun(b) {
    let run=this.runs.get(b.runId);if(run)return run;
    await this.setup();
    const dir=path.join(this.folder,b.runId);await mkdir(dir,{recursive:true});
    const {rows,bytes}=await recoverJsonl(path.join(dir,'batches.jsonl'));
    let expected=1,identity=null;
    for(const row of rows){
      if(row.runId!==b.runId||row.sequence!==expected++)throw Error('Journal sequence corruption; history preserved for review.');
      const current=row.symbol+'|'+row.mode+'|'+row.strategy+'|'+row.strategyVersion;
      if(identity&&identity!==current)throw Error('Journal identity corruption; history preserved for review.');
      identity=current;
    }
    const last=rows.at(-1);
    run={dir,last:last?.sequence??0,identity,lastBatch:last??null,continuationOf:rows[0]?.continuationOf,continuationSequence:rows[0]?.continuationSequence,completed:rows.flatMap(row=>row.closedTrades??[]).slice(-100),bytes};
    this.runs.set(b.runId,run);return run;
  }
  async write(b) {
    let run=await this.loadRun(b);
    const file=path.join(run.dir,'batches.jsonl');
    if(await sizeOf(file)!==run.bytes){this.runs.delete(b.runId);run=await this.loadRun(b);}
    const identity=b.symbol+'|'+b.mode+'|'+b.strategy+'|'+b.strategyVersion;
    if(run.identity&&run.identity!==identity)throw Error('Run identity changed. Start a new run.');
    if(b.sequence<=run.last){
      if(b.sequence===run.last&&JSON.stringify(b)!==JSON.stringify(run.lastBatch))throw Error('Conflicting retry for a committed journal sequence.');
      await syncJsonl(file); // Also retries a previous write whose sync failed.
      if(b.sequence===run.last)await this.saveSummary(run,run.lastBatch);
      return {saved:true,sequence:run.last,duplicate:true};
    }
    if(b.sequence!==run.last+1)throw Error('Journal sequence gap; retry the missing batch.');
    const line=JSON.stringify(b)+'\n',bytes=Buffer.byteLength(line);
    if(bytes>this.maxBytes)throw Object.assign(Error('A single journal batch exceeds the segment limit; pending data retained.'),{code:'batch_too_large',status:413});
    if(run.bytes+bytes>this.maxBytes)throw Object.assign(Error('History segment full; preserving data in a new linked segment.'),{code:'run_full',status:409,runId:b.runId});
    try{await appendJsonl(file,line,this.openFile);}catch(e){this.runs.delete(b.runId);throw e;}
    run.continuationOf??=b.continuationOf;run.continuationSequence??=b.continuationSequence;
    run.last=b.sequence;run.bytes+=bytes;run.identity=identity;run.lastBatch=b;run.completed.push(...b.closedTrades);run.completed=run.completed.slice(-100);
    await this.saveSummary(run,b);
    return {saved:true,sequence:run.last,folder:run.dir};
  }
  async saveSummary(run,b) {
    const summary={schema:1,runId:b.runId,lastSequence:run.last,symbol:b.symbol,mode:b.mode,strategy:b.strategy,strategyVersion:b.strategyVersion,
      continuationOf:run.continuationOf,continuationSequence:run.continuationSequence,updatedMs:b.receivedMs,sourceMs:b.sourceMs,bytes:run.bytes,...b.summary,completed:run.completed};
    const temp=path.join(run.dir,'summary.tmp');await writeFile(temp,JSON.stringify(summary,null,2));await rename(temp,path.join(run.dir,'summary.json'));
  }
  async profile(symbol) {
    await this.setup();let candidates=[];
    for(const entry of await readdir(this.folder,{withFileTypes:true}))if(entry.isDirectory()&&runPattern.test(entry.name)){
      try {const s=JSON.parse(await readFile(path.join(this.folder,entry.name,'summary.json'),'utf8'));
        if(s.symbol===symbol&&s.mode==='live'&&s.strategy==='liquidity'&&s.strategyVersion===VERSION&&s.completed?.length&&s.executionVersion==='response-aware-v1')candidates.push(s);
      }catch{/* Incomplete run summaries do not train. */}
    }
    // One most recent compatible run avoids double-counting overlapping dashboard tabs.
    candidates.sort((a,b)=>b.updatedMs-a.updatedMs);const last=candidates[0];
    return {version:VERSION,outcomes:last?.learning?.outcomes?.filter(finite).slice(-100)??last?.completed.slice(-100).map(t=>t.net)??[],riskLevel:last?.learning?.riskLevel??0,reviewsSince:20-(last?.learning?.nextReview??20),fromRun:last?.runId??null};
  }
}
export function journalPlugin(store=new JournalStore()) {
  const deep=new DeepStore(path.join(store.folder,'Deep Learning'));
  const boot=store.setup().then(()=>deep.bootstrap(store.folder)).catch(e=>{deep.error=e.message;});
  return {name:'engine-journal', deepState: () => deep.status(), configureServer(server){server.middlewares.use(async(req,res,next)=>{
    const u=new URL(req.url||'/','http://127.0.0.1');if(u.pathname==='/api/mnq/deep'){if(req.method!=='GET'){res.statusCode=405;res.end();return;}res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(deep.status()));return;}if(u.pathname!=='/api/mnq/journal')return next();
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
    const send=(data,status=200)=>{res.statusCode=status;res.end(JSON.stringify(data));};
    try {
      if(req.method==='GET') {
        const symbol=u.searchParams.get('symbol')||'MNQZ26-CME';if(!/^MNQ[HMUZ]\d{2}-CME$/.test(symbol))return send({error:'Invalid contract.'},400);
        return send({profile:await store.profile(symbol),folder:store.folder});
      }
      if(req.method!=='POST')return send({error:'Unsupported method.'},405);
      // The origin guard keeps the 5180 launcher default; isolated test servers may set
      // HFTENGINE_DASHBOARD_ORIGIN to their own port (never used by the real launcher).
      const allowedOrigin=process.env.HFTENGINE_DASHBOARD_ORIGIN||'http://127.0.0.1:5180';
      if(req.headers.origin!==allowedOrigin)return send({error:'Use the local HFTENGINE dashboard.'},403);
      const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>2*1024*1024)return send({error:'Journal batch too large.'},413);chunks.push(chunk);}
      const batch=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // Unsupported contracts are rejected deterministically (422 + code) BEFORE append
      // and before any learning observation. The client classifies this as a permanent
      // drop (never a retry) and resumes recording when a supported MNQ feed returns.
      if(!/^MNQ[HMUZ]\d{2}-CME(?:\[M\])?$/i.test(typeof batch?.symbol==='string'?batch.symbol:''))
        return send({error:'Unsupported contract. The MNQ journal records MNQ futures only.',code:'unsupported_contract',contract:String(batch?.symbol??'')},422);
      const result=await store.append(batch);
      void boot.then(()=>deep.observe(batch));return send(result);
    }catch(e){send({error:e.message,code:e.code,runId:e.runId},e.status??500);}
  });}};
}

