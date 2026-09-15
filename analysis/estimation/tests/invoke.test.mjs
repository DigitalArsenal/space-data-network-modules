import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ByteBuffer} from 'flatbuffers';
import {OCM} from 'spacedatastandards.org/lib/js/OCM/OCM.js';
import test from 'node:test';
import {createBrowserModuleHarness} from 'space-data-module-sdk/testing/browser';
import {decode} from './wire.mjs';
import {correlated,expectedState,expectedCovariance,rejected,invalid,invalidCount,wrongEpoch,smoother,smootherRows,fusion,circular} from './fixtures.mjs';
const bytes=fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url));
async function run(request){
 const harness=await createBrowserModuleHarness({wasmSource:bytes,surface:'direct'});
 try{return await harness.invoke(request);}finally{harness.destroy?.();harness.dispose?.();}
}
function result(response){
 assert.equal(response.statusCode,0,response.errorMessage);
 return decode(response.outputs.find(o=>o.portId==='result').payload).result;
}
test('WASM correlated vector matches exact Gaussian posterior and joint NIS',async()=>{
 const response=await run(correlated);
 const r=result(response);const e=r.filter_history[0];let max=0;
 const ocm=OCM.getRootAsOCM(new ByteBuffer(response.outputs.find(o=>o.portId==='ocm').payload));
 let packed=0;
 for(let row=0;row<6;++row)for(let col=0;col<=row;++col)assert.ok(Math.abs(ocm.COVARIANCE_DATA(packed++)-expectedCovariance[6*row+col])<2e-14);
 assert.equal(ocm.covarianceDataLength(),21);
 expectedState.forEach((v,i)=>{max=Math.max(max,Math.abs(e.filtered_state[i]-v));});
 expectedCovariance.forEach((v,i)=>{max=Math.max(max,Math.abs(e.filtered_covariance[i]-v));});
 max=Math.max(max,Math.abs(e.normalized_innovation_squared-2229/1400));assert.ok(max<2e-12,`${max}`);
 console.log(`PASS WASM Gaussian state/covariance/NIS max_error=${max} tolerance=2e-12`);
});
test('WASM validates observations and sample epochs; editing rejects whole vector',async()=>{
 const r=result(await run(rejected));assert.deepEqual(r.rejected_observation_indices,[0]);
 assert.deepEqual(r.filter_history[0].filtered_state,[0,0,0,0,0,0]);
 for(const request of [invalid,invalidCount,wrongEpoch])assert.notEqual((await run(request)).statusCode,0);
});
test('WASM EKF/RTS matches 50 published Hipparchus smoother epochs',async()=>{
 const r=result(await run(smoother));let xe=0,pe=0;
 assert.equal(r.filter_history.length,50);
 smootherRows.forEach((row,i)=>{const e=r.filter_history[i];
  xe=Math.max(xe,Math.abs(e.smoothed_state[0]-row[2]),Math.abs(e.smoothed_state[3]-row[3]));
  pe=Math.max(pe,Math.abs(e.smoothed_covariance[0]-row[4]),Math.abs(e.smoothed_covariance[3]-row[5]),Math.abs(e.smoothed_covariance[21]-row[6]));
 });
 // flatc's default JSON rendering prints only ~12 decimals; native references
 // use full doubles. The 2e-12 bound accommodates this TEST decoder rounding.
 assert.ok(xe<2e-12 && pe<2e-12,JSON.stringify({xe,pe}));
 console.log(`PASS WASM Hipparchus smoother state_max_error=${xe} covariance_max_error=${pe} tolerance=2e-12`);
});

test('WASM asynchronous radar and co-orbiting range fusion follows independent circular truth',async()=>{
 const r=result(await run(fusion));assert.equal(r.filter_history.length,40);
 assert.deepEqual(r.rejected_observation_indices,[]);
 const final=r.filter_history.at(-1).filtered_state;
 const error=Math.hypot(...final.slice(0,3).map((v,i)=>v-circular.truth_final[i]));
 const covariance=r.filter_history.at(-1).filtered_covariance;
 const bound=3*Math.sqrt(covariance[0]+covariance[7]+covariance[14]);
 assert.ok(error<bound,`position error ${error} m exceeds ${bound} m (3 sigma RSS)`);
 console.log(`PASS WASM asynchronous fusion position_error_m=${error} three_sigma_RSS_m=${bound}`);
});
