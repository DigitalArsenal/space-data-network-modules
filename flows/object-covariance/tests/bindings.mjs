import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const require=createRequire(import.meta.url);
export async function bindings(directory) {
 const sds=path.dirname(require.resolve('spacedatastandards.org/package.json'));
 const file=path.join(directory,'sds-bindings.mjs');
 const names=['OMM','OCM','ERM','QRP','DPM'];
 await build({stdin:{contents:names.map(n=>`export * as ${n} from ${JSON.stringify(path.join(sds,'lib/ts',n,'main.ts'))};`).join('\n')+"\nexport * as flatbuffers from 'flatbuffers';",resolveDir:path.dirname(require.resolve('flatbuffers/package.json')),loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:file,logLevel:'silent'});
 return import(pathToFileURL(file));
}
export function frames(bytes) {
 const out=[]; for(let at=0;at<bytes.length;) {
  if(bytes.length-at<4)throw Error('Truncated record prefix');const size=bytes.readUInt32LE(at);at+=4;
  if(!size)continue;if(size>bytes.length-at)throw Error('Truncated record');
  out.push(bytes.subarray(at-4,at+size));at+=size;
 }return out;
}
export function unpack(api,code,bytes) {const prefixed=Buffer.from(bytes).subarray(8,12).toString()==='$'+code;return api[code][code][`${prefixed?'getSizePrefixedRootAs':'getRootAs'}${code}`](new api.flatbuffers.ByteBuffer(bytes)).unpack();}
export function pack(api,code,object) {const b=new api.flatbuffers.Builder();b.finishSizePrefixed(object.pack(b),'$'+code);return Buffer.from(b.asUint8Array());}
export async function scan(api,base,schema,source) {
 const result=[];let cursor='';
 do {
  const q=new api.QRP.QRPT();Object.assign(q,{SCHEMA_NAME:schema,SOURCE_NAME:source,LIMIT:20000,CURSOR:cursor});
  const r=await fetch(base+'/api/v1/data/scan',{method:'POST',headers:{'Content-Type':'application/vnd.sdn.flatbuffers.stream'},body:pack(api,'QRP',q),signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw Error(`Scan ${schema} returned ${r.status}`);
  cursor='';for(const f of frames(Buffer.from(await r.arrayBuffer()))) {
   if(f.subarray(8,12).toString()==='$QRP')cursor=unpack(api,'QRP',f).NEXT_CURSOR||'';else result.push(f);
  }
 }while(cursor);return result;
}
