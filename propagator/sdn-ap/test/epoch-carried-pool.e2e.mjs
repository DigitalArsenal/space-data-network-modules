#!/usr/bin/env node
// Scheduling equivalence for carried forecasts and theory states: TEME km/km/s and ECEF m/m/s, UTC October 2026.
// 128 series: a fitted 500 km AP record carrying its forecast and the same fit without it, alternating, each series' mean
// anomaly moved by its index (so two series swapped between rows cannot pass). Reference: the records in a fresh serial
// instance; its digest is the one sdn-ap 0.6.57 (modules 6a807990) gives (BASE_DIGEST), so the serial path is 0.6.57's.
// 1, 4 and 15 pool threads: every byte equal to the reference (states, statuses and sources), each with threaded batches
// run (the pool's statistics). Zero-byte tolerance includes the status and source planes.
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
// the reference's digest as sdn-ap 0.6.57 (modules 6a807990, wasm 652fa229) made it; 0.6.56 (85bc764c) gives the same
const BASE_DIGEST='1f234b923bbba48a31a99b9c5ae025442c4aa2d7a8d57e12ebf47dd502778079';
if(process.argv.includes('--case')){
 const threads=Number(arg('--threads',0)),label=arg('--label','case');
 const h=await createStandaloneHarness('browser',arg('--wasm',wasmPath),{surface:'direct',maxThreads:Math.max(1,threads),enableBrowserWasiThreads:threads>0});
 const x=h.instance.exports;if(threads)assert.equal(x.sdnap_threads(threads),threads);
 const r=await h.invoke({methodId:'load_epochs',inputs:[{portId:'ocm',typeRef:T('OCM'),payload:fs.readFileSync(streamFile)}]});
 assert.equal(r.statusCode,0,`${r.errorCode}: ${r.errorMessage}`);assert.equal(x.sdnap_epochs_count(),count);
 const out=x.sdnap_alloc(48*count),status=x.sdnap_alloc(4*count),source=x.sdnap_alloc(4*count),ps=x.sdnap_alloc(112),parts=[];
 for(const f of [0.25,0.75,1.25,2.25])for(const frame of [0,3]){
  assert.equal(x.sdnap_epochs_at(2461328.5,f,0,count,frame,out,status,0),0);
  assert.equal(new Int32Array(h.memory.buffer,status,count).filter(x=>x!==0).length,0);
  assert.equal(x.sdnap_epochs_source_at(2461328.5,f,0,count,source),0);
  const sources=new Int32Array(h.memory.buffer,source,count);
  assert.equal(sources.filter(x=>x===1).length,f<2?count/2:0);
  for(const [p,n] of [[out,48*count],[status,4*count],[source,4*count]])parts.push(Buffer.from(new Uint8Array(h.memory.buffer,p,n)));
 }
 x.sdnap_pool_stats(ps);
 const batches=x.sdnap_pool_stats?new Float64Array(h.memory.buffer,ps,2)[1]:0;
 const bytes=Buffer.concat(parts);fs.writeFileSync(path.join(root,label+'.bin'),bytes);
 console.log(JSON.stringify({label,threads,series:count,states:count*8,batches,digest:createHash('sha256').update(bytes).digest('hex')}));
 process.exit(0);
}
const maker=await harness();
const c={...CLASSES.find(c=>c.name==='LEO 500 km'),days:2,ap:true};
const rec=await carriedRecord(maker,c);
const records=Array.from({length:count},(_,k)=>{
 const b=repackOcm(k%2?rec.ocm:rec.plain,t=>{t.METADATA.NORAD_CAT_ID=990000+k;t.MEAN_ELEMENTS.MEAN_ANOMALY=(t.MEAN_ELEMENTS.MEAN_ANOMALY+0.37*k)%360;});
 const p=Buffer.alloc(b.length+4);p.writeUInt32LE(b.length);Buffer.from(b).copy(p,4);return p;
});
fs.writeFileSync(streamFile,Buffer.concat(records));
function run(label,threads,file=wasmPath){
 const output=execFileSync(process.execPath,[fileURLToPath(import.meta.url),'--case','--label',label,'--threads',String(threads),'--wasm',file],{encoding:'utf8',maxBuffer:1<<20});
 console.log(output.trim());return {bytes:fs.readFileSync(path.join(root,label+'.bin')),r:JSON.parse(output.trim().split('\n').at(-1))};
}
const reference=run('serial',0);
if(process.argv.includes('--print-digest')){console.log(reference.r.digest);process.exit(0);}
assert.equal(reference.r.digest,BASE_DIGEST,`the serial reference against sdn-ap 0.6.57's (${BASE_DIGEST})`);
for(const threads of [1,4,15]){
 const t=run('threads-'+threads,threads);
 assert.ok(t.bytes.equals(reference.bytes),`${threads} pool threads`);
 assert.ok(t.r.batches>0,`${threads} pool threads: no threaded batch ran`);
}
console.log('EPOCH-CARRIED-POOL PASS: 128 distinct series, four instants, two frames, the serial reference 0.6.57\'s, 1/4/15 threads in threaded batches, every byte equal');
process.exit(0);
