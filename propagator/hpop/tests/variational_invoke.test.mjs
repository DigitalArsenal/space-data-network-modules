import { decodeResult } from './lib/prwCodec.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { reference,oracleParams,request,rich,burnParams } from './variational-fixture.mjs';
const manifest=JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json',import.meta.url)));
const wasm=fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url));
const decode=decodeResult;
async function invoke(h,params,kernel=false){
  const req=request(params,kernel);
  for(const input of req.inputs)input.payload=Buffer.from(input.payloadHex,'hex');
  return h.invoke(req);
}
function relative(a,b,n=1){let error=0,total=0;for(let i=0;i<36;i++){
  const factor=(i%6<3?1:n)/(i<18?1:n);
  error+=((a[i]-b[i])*factor)**2;total+=(b[i]*factor)**2;
}return Math.sqrt(error/total);}
test('WASM STM agrees with independent published-form Kepler oracle',async t=>{
  const h=await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'command'});t.after(()=>h.destroy());
  let maximum=0;
  for(const c of reference.cases){
    const response=await invoke(h,oracleParams(c));assert.equal(response.statusCode,0,response.errorMessage);
    const out=decode(response);assert.equal(out.STM_METHOD,'ANALYTIC');
    const error=relative(out.stm,c.stm,c.mean_motion_rad_s);maximum=Math.max(maximum,error);
    assert.ok(error<=reference.relative_stm_tolerance,`${c.name} error=${error}`);
    const state=[...out.position,...out.velocity];
    for(let i=0;i<6;i++)assert.ok(Math.abs(state[i]-c.state[i])<(i<3?1e-7:1e-10),`${c.name} state[${i}]`);
  }
  console.log(`PASS WASM Kepler STM cases=${reference.cases.length} max_relative_error=${maximum} tolerance=1e-9`);
});
test('WASM covariance, cumulative samples, impulse chain and kernel force STM',async t=>{
  const h=await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'command'});t.after(()=>h.destroy());
  // Rank-one covariance provides an independent algebraic check P'=Phi P Phi^T.
  const covariance=Array(36).fill(0);covariance[0]=1e-6;
  const params={...burnParams,covariance,sampleEpochsJD:[burnParams.epochJD,burnParams.targetJD]};
  const result=await invoke(h,params);assert.equal(result.statusCode,0,result.errorMessage);const a=decode(result);
  assert.deepEqual(a.samples.at(-1).stm,a.stm);
  for(let i=0;i<6;i++)for(let j=0;j<6;j++){
    assert.equal(a.samples[0].stm[i*6+j],i===j?1:0);
    const expected=a.stm[i*6]*a.stm[j*6]*1e-6;
    assert.ok(Math.abs(a.covariance[i*6+j]-expected)<=1e-20+1e-13*Math.abs(expected));
  }
  const fd=await invoke(h,{...burnParams,STM_METHOD:'FINITE_DIFFERENCE'});assert.equal(fd.statusCode,0,fd.errorMessage);
  assert.ok(relative(a.stm,decode(fd).stm)<1e-6);
  for(const density of ['NEGLECTED','FINITE_DIFFERENCE']){
    const response=await invoke(h,{...rich,DENSITY_GRADIENT:density},true);assert.equal(response.statusCode,0,response.errorMessage);
    const out=decode(response);assert.equal(out.ephemerisSource,'JPL_SPK');assert.ok(out.stm.every(Number.isFinite));
  }
  console.log('PASS WASM covariance samples RTN-impulse DE440-drag-SRP');
});
test('WASM invalid STM controls return named errors and recover',async t=>{
  const h=await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'command'});t.after(()=>h.destroy());
  const base=oracleParams(reference.cases[0]);
  for(const change of [{STM_METHOD:'INVALID'},{DENSITY_GRADIENT:'INVALID'},
    {integrator:{method:'ABM'}},{integrator:{initialStep:0}},
    {integrator:{maxSteps:1}},{integrator:{maxSteps:-1}},{integrator:{maxSteps:0}},{covariance:[1]}]){
    const response=await invoke(h,{...base,...change});assert.notEqual(response.statusCode,0);assert.ok(response.errorCode?.length);
  }
  const success=await invoke(h,{...base,targetJD:base.epochJD});assert.equal(success.statusCode,0,success.errorMessage);
});
