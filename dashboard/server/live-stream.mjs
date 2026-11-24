import { watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
// One file watcher for every dashboard. No fixed 250 ms browser polling delay.
export function liveStreamPlugin(file, observe = () => {}) {
    const clients = new Set();
    let watcher, timer, reading = false, dirty = false, last = '', publication = 0;
    async function read() {
        if (reading) {
            dirty = true;
            return;
        }
        reading = true;
        try {
            const info = await stat(file);
            if (info.size > 1000000)
                throw Error('Live frame too large');
            const raw = await readFile(file, 'utf8'), frame = JSON.parse(raw);
            if (!clients.size) return;
            if (frame.version !== 1 || !Array.isArray(frame.trades))
                throw Error('Invalid live frame');
            if (raw !== last) {
                last = raw;
                const latest = { available: true, ageMs: Math.max(0, Date.now() - info.mtimeMs), frame,
                    bridgeReadMs: Date.now(), publication: ++publication };
                observe(latest);
                for (const res of clients) {
                    if (res.writableLength > 2000000) {
                        res.destroy();
                        continue;
                    }
                    res.write(`data: ${JSON.stringify(latest)}\n\n`);
                }
            }
        }
        catch {
            // Atomic replacement can briefly race a read. Wait for the next valid snapshot.
            last = '';
            if (clients.size) observe(null);
        }
        finally {
            if (clients.size) observe();
            reading = false;
            if (dirty) {
                dirty = false;
                void read();
            }
        }
    }
    function start() {
        if (timer)
            return;
        try {
            watcher = watch(path.dirname(file), (_event, name) => { if (String(name) === path.basename(file))
                void read(); });
            watcher.on('error', () => { });
        }
        catch { }
        timer = setInterval(() => { void read(); for (const res of clients)
            res.write(': heartbeat\n\n'); }, 1000);
        timer.unref();
        void read();
    }
    return { name: 'sierra-push-feed', configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (new URL(req.url, 'http://localhost').pathname !== '/api/mnq/stream')
                    return next();
                if (req.method !== 'GET') {
                    res.writeHead(405);
                    res.end();
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
                res.flushHeaders?.();
                res.write('retry: 1000\n\n');
                clients.add(res);
                start();
                // Re-read on connection: never describe an old cached frame as fresh.
                last = '';
                void read();
                req.on('close', () => { clients.delete(res); if (!clients.size) {
                    clearInterval(timer);
                    timer = null;
                    watcher?.close();
                    watcher = null;
                    observe(null, 'idle');
                } });
            });
        } };
}
