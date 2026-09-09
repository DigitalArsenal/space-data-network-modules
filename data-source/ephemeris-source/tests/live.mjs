// Opt-in public acquisition verification. HTTP is generic; discovery and raw
// validation run inside the shipped WASM. Storage/signing are isolated fixtures.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
import {nativeFixture,output,moduleRoot} from './harness.mjs';
const sources=JSON.parse(fs.readFileSync(path.join(moduleRoot,'sources.json'))).sources.filter(x=>!x.credentialed && (!process.env.SOURCE_IDS || process.env.SOURCE_IDS.split(",").includes(x.source_id)));
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'ephemeris-public-probe-'));const report=[];
const sha=x=>createHash('sha256').update(x).digest('hex');
try {for(const source of sources){const files=new Map(),requests=[],records=[];let result;
 const dispatch=(op,p)=>{
  if(op==='plugin.getConfig')return {ephemeris_enabled:true,ephemeris_source_id:source.source_id,ephemeris_max_resources:1,ephemeris_timeout_ms:30000};
  if(op==='storage.flatsql_query_stream')return {rows:0};
  if(op==='http.request'){
   const header=path.join(temporary,'headers');const raw=spawnSync('curl',['--silent','--show-error','--location','--max-time',String(p.timeout_ms/1000),'--max-filesize',String(p.max_bytes),'--dump-header',header,p.url],{maxBuffer:p.max_bytes+4096});
   if(raw.status!==0)throw Error('Public HTTP transfer failed or exceeded bounds.');
   const blocks=fs.readFileSync(header,'utf8').trim().split(/\r?\n\r?\n/),lines=blocks.at(-1).split(/\r?\n/),status=Number(lines.shift().split(' ')[1]),headers={};for(const line of lines){const at=line.indexOf(':');if(at>0)headers[line.slice(0,at).toLowerCase()]=line.slice(at+1).trim();}
   requests.push({url:p.url,status,bytes:raw.stdout.length,sha256:sha(raw.stdout)});return {status,headers,body:raw.stdout};
  }
  if(op==='ipfs.add'){const cid='bafy'+sha(p.content);files.set(cid,Buffer.from(p.content));return {Hash:cid};}
  if(op==='storage.ingest_with_source'){records.push({schema:p.schema,bytes:p.records.length,sha256:sha(p.records)});return {inserted:1,batch_id:p.batch_id};}
  if(op==='storage.write'){records.push({schema:p.schema,bytes:p.data.length,sha256:sha(p.data)});return {cid:'fixture'+sha(p.data)};}
  throw Error('Unexpected test capability '+op);
 };
 try{const h=await nativeFixture(dispatch);const r=h.invoke({methodId:'pull',inputs:[]});if(r.statusCode!==0)throw Error(r.errorMessage);result={source_id:source.source_id,ok:true,progress:output(r,'status'),requests,records};}
 catch(error){result={source_id:source.source_id,ok:false,error:String(error.message),requests,records};}
 report.push(result);console.log(JSON.stringify({source_id:result.source_id,ok:result.ok,discovered:result.progress?.total,requests:requests.length,last_bytes:requests.at(-1)?.bytes,error:result.error}));
 }
}finally{fs.rmSync(temporary,{recursive:true});}
const out=path.join(moduleRoot,'tests/live-output');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,process.env.SOURCE_IDS?'anonymous-'+process.env.SOURCE_IDS+'.json':'anonymous-retrieval.json'),JSON.stringify({retrieved_at:new Date().toISOString(),scope:'Live HTTP through shipped WASM with isolated publication fixture; not evidence of live SDN publication.',sources:report},null,2)+'\n');
if(report.some(x=>!x.ok))process.exitCode=1;
