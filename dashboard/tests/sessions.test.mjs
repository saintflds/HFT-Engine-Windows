import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {sessionsPlugin} from '../server/sessions.mjs';

test('sessions created after startup load immediately; missing files never return SPA HTML', async () => {
  const parent=fileURLToPath(new URL('../../data/tests/', import.meta.url));
  await mkdir(parent,{recursive:true});
  const folder=await mkdtemp(path.join(parent,'session-serving-'));
  const directory=path.join(folder,'public/sessions');
  await mkdir(directory,{recursive:true});
  await writeFile(path.join(folder,'index.html'),'<html>SPA fallback</html>');
  const server=await createServer({configFile:false,root:folder,publicDir:path.join(folder,'public'),
    plugins:[sessionsPlugin()],optimizeDeps:{noDiscovery:true},server:{host:'127.0.0.1',port:0,watch:{usePolling:true}}});
  try {
    await server.listen(); const url='http://127.0.0.1:'+server.httpServer.address().port;
    const missing=await fetch(url+'/sessions/new.hbr');
    assert.equal(missing.status,404); assert.match(missing.headers.get('content-type'),/json/);
    const header=Buffer.from(JSON.stringify({meta:{},arrays:[]}));
    const recording=Buffer.alloc(Math.ceil((12+header.length)/8)*8);
    recording.write('HFTREC01');recording.writeUInt32LE(header.length,8);header.copy(recording,12);
    await writeFile(path.join(directory,'new.hbr'),recording);
    const response=await fetch(url+'/sessions/new.hbr');
    assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/octet-stream/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),recording);
    const head=await fetch(url+'/sessions/new.hbr',{method:'HEAD'});
    assert.equal(Number(head.headers.get('content-length')),recording.length);assert.equal(await head.text(),'');
    await writeFile(path.join(directory,'new.sierra.json'),'{"observed":true}');
    assert.deepEqual(await (await fetch(url+'/sessions/new.sierra.json')).json(),{observed:true});
    const invalid=await fetch(url+'/sessions/..%2fsecret.hbr');assert.equal(invalid.status,400);
    assert.equal((await fetch(url+'/sessions/new.hbr',{method:'POST'})).status,405);
  } finally {
    await server.close();
    if(!path.resolve(folder).startsWith(path.resolve(parent)+path.sep))throw Error('Unexpected test folder');
    await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
