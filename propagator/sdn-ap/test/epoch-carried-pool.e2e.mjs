#!/usr/bin/env node
// Scheduling equivalence for carried forecasts and theory states: TEME km/km/s and ECEF m/m/s, UTC October 2026.
// Reference: identical records in a fresh serial instance. Zero-byte tolerance includes status and source planes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {wasmPath} from './lib/module.mjs';
import {scratchRoot} from './lib/scratch.mjs';
import {CLASSES,harness,carriedRecord} from './lib/carried.mjs';
import {T,repackOcm} from './lib/ocm.mjs';
const arg=(k,v)=>{const i=process.argv.indexOf(k);return i<0?v:process.argv[i+1]};
const root=path.join(scratchRoot,'epoch-carried-pool');fs.mkdirSync(root,{recursive:true});
const count=128,streamFile=path.join(root,'records.bin');
if(process.argv.includes('--case')){
 const threads=Number(arg('--threads',0)),label=arg('--label','case');
 const h=await createStandaloneHarness('browser',arg('--wasm',wasmPath),{surface:'direct',maxThreads:Math.max(1,threads),enableBrowserWasiThreads:threads>0});
 const x=h.instance.exports;if(threads)assert.equal(x.sdnap_threads(threads),threads);
 const r=await h.invoke({methodId:'load_epochs',inputs:[{portId:'ocm',typeRef:T('OCM'),payload:fs.readFileSync(streamFile)}]});
 assert.equal(r.statusCode,0,`${r.errorCode}: ${r.errorMessage}`);assert.equal(x.sdnap_epochs_count(),count);
 const out=x.sdnap_alloc(48*count),status=x.sdnap_alloc(4*count),source=x.sdnap_alloc(4*count),parts=[];
 for(const f of [0.25,0.75,1.25,2.25])for(const frame of [0,3]){
  assert.equal(x.sdnap_epochs_at(2461328.5,f,0,count,frame,out,status,0),0);
  assert.equal(new Int32Array(h.memory.buffer,status,count).filter(x=>x!==0).length,0);
  assert.equal(x.sdnap_epochs_source_at(2461328.5,f,0,count,source),0);
  const sources=new Int32Array(h.memory.buffer,source,count);
  assert.equal(sources.filter(x=>x===1).length,f<2?count/2:0);
  for(const [p,n] of [[out,48*count],[status,4*count],[source,4*count]])parts.push(Buffer.from(new Uint8Array(h.memory.buffer,p,n)));
 }
 const bytes=Buffer.concat(parts);fs.writeFileSync(path.join(root,label+'.bin'),bytes);
 console.log(JSON.stringify({label,threads,series:count,states:count*8,digest:createHash('sha256').update(bytes).digest('hex')}));
 process.exit(0);
}
const maker=await harness();
const c={...CLASSES.find(c=>c.name==='LEO 500 km'),days:2,ap:true};
const rec=await carriedRecord(maker,c);
const records=Array.from({length:count},(_,k)=>{
 const b=repackOcm(k%2?rec.ocm:rec.plain,t=>{t.METADATA.NORAD_CAT_ID=990000+k;});
 const p=Buffer.alloc(b.length+4);p.writeUInt32LE(b.length);Buffer.from(b).copy(p,4);return p;
});
fs.writeFileSync(streamFile,Buffer.concat(records));
function run(label,threads,file=wasmPath){
 const output=execFileSync(process.execPath,[fileURLToPath(import.meta.url),'--case','--label',label,'--threads',String(threads),'--wasm',file],{encoding:'utf8',maxBuffer:1<<20});
 console.log(output.trim());return fs.readFileSync(path.join(root,label+'.bin'));
}
const reference=run('serial',0);
for(const threads of [1,4,15])assert.deepEqual(run('threads-'+threads,threads),reference);
const baseline=arg('--baseline',null);if(baseline)assert.deepEqual(run('baseline',0,baseline),reference);
console.log('EPOCH-CARRIED-POOL PASS: 128 series, four instants, two frames, 0/1/4/15 threads, every byte equal');
process.exit(0);
