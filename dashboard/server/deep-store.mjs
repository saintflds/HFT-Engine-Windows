import { mkdir, readFile, writeFile, appendFile, rename, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { vector } from './deep-network.mjs';
import {recoverJsonl,appendJsonl,sizeOf,syncJsonl} from './jsonl.mjs';
export class DeepStore {
    constructor(folder,options={}) { this.openFile=options.openFile;this.exampleBytes=0;this.needsRecovery=false;this.pendingExample=null;this.folder = folder; this.rows = []; this.pending = null; this.lastSeen = 0; this.lastStart = 0; this.gaps = 0; this.model = null; this.training = false; this.error = ''; this.lastAttempt = 0; this.chain = Promise.resolve(); this.ready = this.load(); }
    async load() {
        await mkdir(this.folder, { recursive: true });
        try {
            const recovered=await recoverJsonl(path.join(this.folder,'examples.jsonl'));
            this.rows=recovered.rows.slice(-20000);this.exampleBytes=recovered.bytes;
            this.lastStart = this.rows.at(-1)?.startMs ?? 0;
            this.lastSeen = this.rows.at(-1)?.endMs ?? 0;
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        }
        try {
            this.model = JSON.parse(await readFile(path.join(this.folder, 'model.json'), 'utf8'));
            this.lastAttempt = this.model.lastEndMs;
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                this.error = e.message;
        }
    }
    observe(b) { const task = this.chain.then(async () => { await this.ready; await this.collect(b); }); this.chain = task.catch(e => { this.error = e.message; }); return this.chain; }
    async collect(b) {
        // Retry the exact failed label before considering a newer observation.
        // In particular, a successful append followed by failed sync cannot
        // create a second label with a changed end time on the next frame.
        if(this.pendingExample){
            await this.appendExample(this.pendingExample);
            this.lastSeen=this.pendingExample.endMs;
            this.pendingExample=null;this.pending=null;
        }
        // Real observed market labels only. Replay, stale frames and coverage gaps never train.
        if (b.mode !== 'live' || b.symbol !== 'MNQZ26-CME' || !b.market?.fresh || !b.market.connected) {
            this.pending = null;
            return;
        }
        if (b.sourceMs <= this.lastSeen)
            return; // deduplicate overlapping tabs and retry batches
        const s = b.summary.signal, price = b.summary.markPrice, t = b.sourceMs;
        if (!s?.warmed || !Number.isFinite(price) || price <= 0 || !b.trades?.length)
            return;
        if (t - this.lastSeen > 5000 || b.market.coverageGaps !== this.gaps)
            this.pending = null;
        this.gaps = b.market.coverageGaps;
        if (this.pending && t >= this.pending.startMs + 10000) {
            const p = this.pending;
            if (t - p.startMs <= 12000) {
                const moveTicks = (price - p.price) / .25, costTicks = 3 + 1 + p.spreadTicks / 2;
                const row = { startMs: p.startMs, endMs: t, x: p.x, y: moveTicks > costTicks ? 2 : moveTicks < -costTicks ? 0 : 1, moveTicks, costTicks, price: p.price, endPrice: price, symbol: b.symbol, source: 'Sierra observed prints', runId: b.runId };
                this.pendingExample=row;
                await this.appendExample(row);
                this.pendingExample=null;
                this.maybeTrain();
            }
            this.pending=null;
        }
        this.lastSeen=t;
        if (!this.pending && (!this.lastStart || t >= this.lastStart + 10000)) {
            const x = vector(s);
            if (x.every(Number.isFinite)) {
                this.pending = { startMs: t, price, x, spreadTicks: s.spreadTicks };
                this.lastStart = t;
            }
        }
    }
    async appendExample(row) {
        const file=path.join(this.folder,'examples.jsonl');
        if(this.needsRecovery||await sizeOf(file)!==this.exampleBytes){
            const recovered=await recoverJsonl(file);this.rows=recovered.rows.slice(-20000);this.exampleBytes=recovered.bytes;this.needsRecovery=false;
        }
        const last=this.rows.at(-1);
        if(last&&last.startMs===row.startMs&&last.endMs===row.endMs){
            if(JSON.stringify(last)!==JSON.stringify(row))throw Error('Conflicting training-example retry.');
            await syncJsonl(file);return;
        }
        const line=JSON.stringify(row)+'\n';
        try{await appendJsonl(file,line,this.openFile);}catch(e){this.needsRecovery=true;throw e;}
        this.exampleBytes+=Buffer.byteLength(line);this.rows.push(row);this.rows=this.rows.slice(-20000);
    }
    maybeTrain() {
        if (this.training || this.rows.length < 600 || this.rows.filter(r => r.endMs > this.lastAttempt).length < 100)
            return;
        this.training = true;
        this.lastAttempt = this.rows.at(-1).endMs;
        const snapshot = this.rows.slice(-10000);
        const worker = new Worker(new URL('./deep-worker.mjs', import.meta.url), { workerData: snapshot });
        let received = false;
        worker.once('message', async (result) => {
            received = true;
            try {
                if (result.error)
                    throw Error(result.error);
                const m = { ...result.model, symbol: 'MNQZ26-CME' };
                const temp = path.join(this.folder, 'model.tmp');
                await writeFile(temp, JSON.stringify(m));
                await rename(temp, path.join(this.folder, 'model.json'));
                await writeFile(path.join(this.folder, `evaluation-${m.trainedMs}.json`), JSON.stringify({ ...m, layers: undefined }, null, 2));
                this.model = m;
                this.error = '';
            }
            catch (e) {
                this.error = e.message;
            }
            finally {
                this.training = false;
            }
        });
        worker.once('error', e => { this.error = e.message; this.training = false; });
        worker.once('exit', code => { if (!received) {
            this.error = `Training worker exited (${code})`;
            this.training = false;
        } });
    }
    async bootstrap(history) {
        await this.ready;
        if (this.rows.length)
            return;
        const files = [];
        for (const e of await readdir(history, { withFileTypes: true }))
            if (e.isDirectory() && /^[a-f0-9-]{36}$/.test(e.name))
                files.push(path.join(history, e.name, 'batches.jsonl'));
        // Bounded startup scan; chronological ordering prevents using future labels as features.
        const frames = [];
        for (const f of files.slice(-20)) {
            try {
                const lines = createInterface({ input: createReadStream(f), crlfDelay: Infinity });
                for await (const line of lines) {
                    try {
                        const b = JSON.parse(line);
                        if (b.mode === 'live' && b.summary?.signal?.warmed)
                            frames.push(b);
                        if (frames.length > 40000)
                            frames.splice(0, 10000);
                    }
                    catch { }
                }
            }
            catch { }
        }
        frames.sort((a, b) => a.sourceMs - b.sourceMs);
        for (const b of frames)
            await this.collect(b);
        this.pending = null;
        this.maybeTrain();
    }
    status() { const active = this.model?.qualified && Date.now() - this.model.trainedMs < 7 * 86400000; return { samples: this.rows.length, minimum: 600, training: this.training, error: this.error, status: this.error ? 'History error' : this.training ? 'Training' : active ? 'Qualified forecast filter' : this.model ? 'Candidate not qualified' : 'Collecting market examples', model: active ? this.model : null, evaluation: this.model ? { ...this.model, layers: undefined } : null }; }
}
