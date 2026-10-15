// Opt-in public acquisition verification. HTTP is generic; discovery and raw
// validation run inside the shipped WASM. Storage/signing are isolated fixtures.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
import {nativeFixture,statusOf,tick,moduleRoot} from './harness.mjs';
const sources=JSON.parse(fs.readFileSync(path.join(moduleRoot,'sources.json'))).sources.filter(x=>!x.credentialed && (!process.env.SOURCE_IDS || process.env.SOURCE_IDS.split(",").includes(x.source_id)));
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'ephemeris-public-probe-'));const report=[];
const sha=x=>createHash('sha256').update(x).digest('hex');
try {for(const source of sources){const files=new Map(),requests=[],records=[];let result;
 const text=(x)=>new TextDecoder().decode(x);
 const handler=(op,call)=>{const p=call.params??{},raw=call.raw??{};
  if(op==='plugin.getConfig')return {ephemeris_enabled:true,ephemeris_source_id:source.source_id,ephemeris_max_resources:1,ephemeris_timeout_ms:30000};
  if(op==='storage.flatsql_query_stream')return {result:{ROWS:0n}};
  if(op==='http.request'){
   const url=text(raw.url),maxBytes=Number(p.MAX_BYTES),header=path.join(temporary,'headers');const curl=spawnSync('curl',['--silent','--show-error','--location','--max-time',String(p.TIMEOUT_MS/1000),'--max-filesize',String(maxBytes),'--dump-header',header,url],{maxBuffer:maxBytes+4096});
   if(curl.status!==0)throw Error('Public HTTP transfer failed or exceeded bounds.');
   const blocks=fs.readFileSync(header,'utf8').trim().split(/\r?\n\r?\n/),lines=blocks.at(-1).split(/\r?\n/),status=Number(lines.shift().split(' ')[1]);
   requests.push({url,status,bytes:curl.stdout.length,sha256:sha(curl.stdout)});return {result:{STATUS:status},raw:{headers:new TextEncoder().encode(lines.join('\r\n')),body:new Uint8Array(curl.stdout)}};
  }
  if(op==='ipfs.add'){const cid='bafy'+sha(raw.data);files.set(cid,Buffer.from(raw.data));return {result:{CID:cid}};}
  if(op==='storage.ingest_with_source'){records.push({schema:p.SCHEMA,bytes:raw.records.length,sha256:sha(raw.records)});return {result:{INSERTED:1n,BATCH_ID:p.BATCH_ID}};}
  if(op==='storage.write'){records.push({schema:p.SCHEMA,bytes:raw.data.length,sha256:sha(raw.data)});return {result:{CID:'fixture'+sha(raw.data)}};}
  throw Error('Unexpected test capability '+op);
 };
 try{const h=await nativeFixture(handler);const s=statusOf(h.invoke({methodId:'pull',inputs:[tick()]}));result={source_id:source.source_id,ok:true,progress:{state:s.STATE,completed:s.COMPLETED_COUNT,total:s.TOTAL_COUNT,remaining:s.REMAINING_COUNT},requests,records};}
 catch(error){result={source_id:source.source_id,ok:false,error:String(error.message),requests,records};}
 report.push(result);console.log(JSON.stringify({source_id:result.source_id,ok:result.ok,discovered:result.progress?.total,requests:requests.length,last_bytes:requests.at(-1)?.bytes,error:result.error}));
 }
}finally{fs.rmSync(temporary,{recursive:true});}
const out=path.join(moduleRoot,'tests/live-output');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,process.env.SOURCE_IDS?'anonymous-'+process.env.SOURCE_IDS+'.json':'anonymous-retrieval.json'),JSON.stringify({retrieved_at:new Date().toISOString(),scope:'Live HTTP through shipped WASM with isolated publication fixture; not evidence of live SDN publication.',sources:report},null,2)+'\n');
if(report.some(x=>!x.ok))process.exitCode=1;
