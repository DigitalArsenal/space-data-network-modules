// Exact regression against isolated states, in TEME km and km/s at UTC day one.
// No fitted truth or approximation tolerance: each finite component must match
// as a binary64 value. SDN_AP_REFERENCE_WASM selects the 0.6.60 control artifact.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {wasmPath,ensureBuilt} from './lib/module.mjs';
import {records,open,order} from './lib/wide-catalog.mjs';
ensureBuilt();
const file=process.env.SDN_AP_WIDE_WASM||wasmPath,reference=process.env.SDN_AP_REFERENCE_WASM||file;
const count=process.env.SDN_AP_WIDE_FULL==='1'?10000:3200,rs=records(count),truth=[];
const checkpoint=process.env.SDN_AP_WIDE_RESULTS;
const save=o=>{if(checkpoint)fs.writeFileSync(checkpoint,JSON.stringify(o));};
const out={count,complete:false,cases:[]};
for(const record of rs){const h=await open(reference);try{await h.load([record]);const v=h.one();assert.equal(v.rc,0);truth.push(v.state);}finally{await h.close();}}
const hash=createHash('sha256');for(const v of truth)hash.update(Buffer.from(new Float64Array(v).buffer));out.referenceDigest=hash.digest('hex');save(out);
for(const threads of [0,3,14])for(const kind of ['ascending','descending','shuffled']){
 const h=await open(file,threads,count),map=order(count,kind);
 try{
  // Keep every record byte fixed and vary only requests. Epoch-store sorting is
  // independent of insertion order, so scalar requests assert order directly.
  await h.load(rs);
  for(const k of map){const v=h.one(k);assert.equal(v.rc,0);assert.deepEqual(v.state,truth[k]);}
  for(let pass=0;pass<2;++pass){const v=h.batch();assert.equal(v.rc,0);assert.ok(v.status.every(x=>x===0));for(let k=0;k<count;k++)assert.deepEqual(Array.from({length:6},(_,z)=>v.values[z*count+k]),truth[k]);}
  const budget=h.budget();assert.equal(budget.rc,0);assert.ok(budget.out[1]<=budget.out[0]);
  const old=budget.out[0];assert.equal(h.budget(1).rc,-1);assert.equal(h.budget().out[0],old);
  out.cases.push({threads:threads+1,order:kind,answered:count,budget:budget.out,linearBytes:h.h.memory.buffer.byteLength});save(out);
 }finally{await h.close();}
}
out.complete=true;save(out);console.log(JSON.stringify(out));
