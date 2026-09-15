// Sources: published SDS 1.220.0 PRW/FRM/TIM contracts; for zero elapsed
// time, x(t0)=x0 and Phi(t0,t0)=I by the definition of the transition matrix
// (Battin, An Introduction to the Mathematics and Methods of Astrodynamics,
// variational equations). SI m, m/s, kg, Earth GCRF, JD2451545 TDB.
// Zero-duration arithmetic is exact except decimal SI serialization: 1e-12
// absolute permits only binary representation roundoff, not integration error.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { TYPE, encodePrw, decodePrw, execution, makeTable } from './lib/prwCodec.mjs';
import { identityParams, invalidCases } from './prw-contract-fixture.mjs';
const wasm=fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url));
async function harness(t) {const h=await createBrowserModuleHarness({wasmSource:wasm,surface:'direct'});t.after(()=>h.destroy());return h;}
async function invoke(h,e) {return h.invoke({methodId:'invoke',inputs:[{portId:'request',typeRef:TYPE,payload:encodePrw('EXECUTION_REQUEST',e)}]});}

test('PRW SI 6/7 covariance and STM preserve nonzero cross terms at initial epoch',async t=>{
  const h=await harness(t);
  for(const n of [6,7]) {
    const e=execution({...identityParams,...(n===7?{finiteBurns:[],massKg:1000}:{})});
    // PSD outer product [2,0,0,3,0,0,(5)] [same]^T has nonzero
    // position/velocity/mass cross terms: independent fixed expected values.
    const vector=n===7?[2,0,0,3,0,0,5]:[2,0,0,3,0,0];
    const values=vector.flatMap(a=>vector.map(b=>a*b));
    e[n===7?'INITIAL_MASS_COVARIANCE':'INITIAL_COVARIANCE']=makeTable('PRWStateMatrix',{DIMENSION:n,VALUES:values});
    const response=await invoke(h,e);assert.equal(response.statusCode,0,response.errorMessage);
    const s=decodePrw(response.outputs[0].payload).EXECUTION_RESULT.FINAL_SAMPLE;
    const p=s[n===7?'MASS_COVARIANCE':'COVARIANCE'],phi=s[n===7?'MASS_STM':'STM'];
    assert.equal(p.DIMENSION,n);assert.equal(phi.DIMENSION,n);
    for(let i=0;i<n*n;i++) {assert.ok(Math.abs(p.VALUES[i]-values[i])<=1e-12);assert.equal(phi.VALUES[i],Math.floor(i/n)===i%n?1:0);}
    assert.deepEqual([s.STATE.STATE.POSITION.X,s.STATE.STATE.POSITION.Y,s.STATE.STATE.POSITION.Z],[7000000,100000,-50000]);
    assert.deepEqual([s.STATE.STATE.VELOCITY.X,s.STATE.STATE.VELOCITY.Y,s.STATE.STATE.VELOCITY.Z],[1000,7000,400]);
    if(n===7) {assert.equal(s.STATE.HAS_MASS_KG,true);assert.equal(s.STATE.MASS_KG,1000);}
  }
});

test('PRW rejects malformed, ambiguous and unsupported requests and recovers',async t=>{
  const h=await harness(t);
  for(const c of invalidCases) {
    const r={...c.request,inputs:c.request.inputs.map(({payloadHex,...i})=>({...i,payload:Buffer.from(payloadHex,'hex')}))};
    const response=await h.invoke(r);
    assert.notEqual(response.statusCode,0,c.id);assert.ok(response.errorCode,c.id);
    assert.equal(response.outputs.length,0,c.id);
  }
  const response=await invoke(h,execution(identityParams));assert.equal(response.statusCode,0,response.errorMessage);
  console.log(`PASS PRW negative controls=${invalidCases.length} same-instance recovery`);
});
