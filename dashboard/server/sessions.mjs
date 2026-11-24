import {createReadStream} from 'node:fs';
import {realpath, stat} from 'node:fs/promises';
import path from 'node:path';

// Read the filesystem for each request. Vite's startup public-file listing can
// miss a session generated after the dev server starts, then serve index.html.
export function sessionsPlugin(directory) {
  const register = server => {
    const folder = path.resolve(directory || path.join(server.config.publicDir, 'sessions'));
    server.middlewares.use(async (req, res, next) => {
      const pathname = new URL(req.url || '/', 'http://localhost').pathname;
      if (!pathname.startsWith('/sessions/')) return next();
      const fail = (status, error) => {
        res.writeHead(status, {'Content-Type':'application/json', 'Cache-Control':'no-store'});
        res.end(JSON.stringify({error}));
      };
      if (!['GET','HEAD'].includes(req.method)) return fail(405, 'Replay files are read only.');
      let name;
      try {name = decodeURIComponent(pathname.slice('/sessions/'.length));}
      catch {return fail(400, 'Invalid replay file name.');}
      if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:hbr|json)$/.test(name))
        return fail(400, 'Invalid replay file name.');
      try {
        const root = await realpath(folder), file = await realpath(path.join(folder, name));
        if (!file.startsWith(root + path.sep)) return fail(403, 'Replay file is outside the session folder.');
        const info = await stat(file);
        if (!info.isFile()) return fail(404, 'Replay file not found.');
        res.writeHead(200, {'Content-Type':name.endsWith('.hbr')?'application/octet-stream':'application/json',
          'Content-Length':info.size, 'Cache-Control':'no-store'});
        if (req.method === 'HEAD') {res.end(); return;}
        const stream = createReadStream(file);
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
      } catch (error) {
        fail(error.code === 'ENOENT' ? 404 : 503,
          error.code === 'ENOENT' ? 'Replay file not found. Finish building the session, then retry.' : 'Replay file is temporarily unavailable.');
      }
    });
  };
  return {name:'generated-replay-files', configureServer:register, configurePreviewServer:register};
}
