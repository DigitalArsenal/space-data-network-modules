#!/usr/bin/env node
// Source: synthetic threshold pairs sharing covariance-bank tables. UTC epoch
// JD 2461206.5; TEME km and km/s. Cache-order tolerance is zero bits: every
// comparison evaluates the same sigma set with the same nominal and selection.
// Diagnostic builds only; SDNAP_CONTINUITY_RULE is a compile-time test override.
import assert from 'node:assert/strict';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {buildSigma} from './lib/coefficient-sigma.mjs';
const file=process.env.SIGMA_WASM??buildSigma();
console.log(JSON.stringify({file}));
const labels=['eccentricity 0.02','perigee 350','perigee 600','perigee 1000','perigee 30000','zero drag'];
let differences=0,formMismatches=0,comparisons=0;
for(const cell of [0,1])for(let c=0;c<labels.length;c++){
 let reference;
 for(const threads of [1,4])for(let order=0;order<3;order++)for(const warm of [0,1]){
  const h=await createStandaloneHarness('browser',file,{surface:'direct',maxThreads:threads,enableBrowserWasiThreads:threads>1});
  const x=h.instance.exports,p=x.sdnap_alloc(4*32*8);
  if(threads>1)assert.equal(x.sdnap_threads(threads),threads);
  assert.equal(x.sdnap_test_sigma(c+6*cell,order,warm,threads>1?1:0,p),0);
  const rows=Array.from({length:threads>1?4:1},(_,i)=>Array.from(new Float64Array(h.memory.buffer,p+i*32*8,32)));
  for(const row of rows){
   assert.equal(row[0],0,labels[c]+' nominal init');assert.equal(row[1],0,labels[c]+' sigma init');
   assert(row[4]&32,labels[c]+' shared m-daily table');assert(row[4]&64,labels[c]+' shared short-period table');
   if(row[2]!==row[3])formMismatches++;
   const states=[0,1,2].flatMap(k=>row.slice(8+k*8,15+k*8));
   for(let k=0;k<3;k++)assert.equal(states[k*7],0);
   assert(states.every(Number.isFinite));reference??=states;
   comparisons++;if(!states.every((v,k)=>Object.is(v,reference[k])))differences++;
  }
  console.log(JSON.stringify({case:labels[c],cell,threads,order,warm,forms:rows[0].slice(2,4),contextBytes:rows[0][5],differences,formMismatches}));
  await h.close?.();
 }
}
console.log(JSON.stringify({comparisons,differences,formMismatches}));
assert.equal(differences,0,'sigma states depend on cache order');
assert.equal(formMismatches,0,'sigma form must equal nominal form');
process.exit(0);
