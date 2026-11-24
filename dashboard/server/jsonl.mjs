import {readFile,writeFile,open,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

// A newline is the record commit boundary. Preserve incomplete bytes for audit
// before truncating them; malformed complete records fail closed.
export async function recoverJsonl(file) {
  let data;try{data=await readFile(file);}catch(e){if(e.code==='ENOENT')return {rows:[],bytes:0};throw e;}
  const committed=data.lastIndexOf(10)+1;
  const rows=data.subarray(0,committed).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
  if(committed<data.length){
    await writeFile(file+'.partial-'+randomUUID(),data.subarray(committed),{flag:'wx'});
    const h=await open(file,'r+');try{await h.truncate(committed);await h.sync();}finally{await h.close();}
  }
  return {rows,bytes:committed};
}
export async function sizeOf(file){try{return (await stat(file)).size;}catch(e){if(e.code==='ENOENT')return 0;throw e;}}
export async function syncJsonl(file){const h=await open(file,'r+');try{await h.sync();}finally{await h.close();}}
export async function appendJsonl(file,line,openFile=open){
  const h=await openFile(file,'a');try{await h.writeFile(line);await h.sync();}finally{await h.close();}
}
