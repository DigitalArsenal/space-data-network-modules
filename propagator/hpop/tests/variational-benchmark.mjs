// Local timing of the actual same-byte WASM invoke surface. JS supplies inputs
// and measures elapsed time; the physics and both STM paths execute in C++ WASM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { request } from './variational-fixture.mjs';
const wasm=fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url));
const manifest=JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json',import.meta.url)));
const h=await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'direct'});
const params={epochJD:2451545,targetJD:2451546,position:[7000,0,0],velocity:[0,7.5,1],
  forces:{gravityMode:'J2'},integrator:{method:'RKF78',initialStep:60,minStep:0.001,maxStep:60,absTolerance:1e-12,relTolerance:1e-12}};
async function measure(method,repeats){
  const input=request({...params,STM_METHOD:method});
  for(const frame of input.inputs)frame.payload=Buffer.from(frame.payloadHex,'hex');
  const start=performance.now();
  for(let i=0;i<repeats;i++){
    const response=await h.invoke(input);assert.equal(response.statusCode,0,response.errorMessage);
  }
  return (performance.now()-start)/repeats;
}
try {
  await measure('ANALYTIC',3);await measure('FINITE_DIFFERENCE',3);
  const repeats=20,a1=await measure('ANALYTIC',repeats),b=await measure('FINITE_DIFFERENCE',repeats),a2=await measure('ANALYTIC',repeats);
  console.log(`RUNTIME Node=${process.version} V8=${process.versions.v8} cpu=${os.cpus()[0].model} cores=${os.cpus().length} load1=${os.loadavg()[0]} wasm_sha256=${crypto.createHash('sha256').update(wasm).digest('hex')}`);
  console.log(`TIMING WASM 24h_LEO_J2 repeats=${repeats} analytic_before_ms=${a1} finite_difference_ms=${b} analytic_after_ms=${a2} speedup=${b/((a1+a2)/2)}`);
}finally{await h.destroy();}
