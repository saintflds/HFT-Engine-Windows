import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {liveStreamPlugin} from '../server/live-stream.mjs';
test('push connection receives atomic Sierra file updates without a browser polling interval',async()=>{
 const folder=await mkdtemp(path.join(tmpdir(),'hft-stream-')),file=path.join(folder,'latest.json');
 const frame=n=>JSON.stringify({version:1,publishedMs:n,trades:[]});await writeFile(file,frame(1));
 let handler;liveStreamPlugin(file).configureServer({middlewares:{use:h=>handler=h}});
 const server=http.createServer((req,res)=>handler(req,res,()=>res.end()));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const controller=new AbortController();
 try{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/mnq/stream`,{signal:controller.signal});const reader=response.body.getReader();let text='';
 const until=async n=>{const deadline=Date.now()+3000;while(!text.includes(`"publishedMs":${n}`)){if(Date.now()>deadline)throw Error('Missing pushed frame');const r=await reader.read();text+=new TextDecoder().decode(r.value);}};
 await until(1);await writeFile(file+'.tmp',frame(2));await rename(file+'.tmp',file);await until(2);assert.ok(text.includes('data: '));
 }finally{controller.abort();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
