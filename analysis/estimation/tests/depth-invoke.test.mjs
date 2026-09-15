import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {createBrowserModuleHarness} from 'space-data-module-sdk/testing/browser';
import {unpack} from './wire.mjs';
import {linear,clock,inflated,adaptiveQ,nonlinearCases} from './depth-fixtures.mjs';
test('WASM linear PV, receiver clock/pseudorange, and gated adaptive R',async()=>{
 const harness=await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url)),surface:'direct'});
 try{
  const run=async request=>{const r=await harness.invoke(request);assert.equal(r.statusCode,0,r.errorMessage);return unpack(r.outputs.find(o=>o.portId==='result').payload).result;};
  const pv=await run(linear);pv.filterHistory[0].filteredState.forEach((v,i)=>assert.ok(Math.abs(v-(i+1))<1e-14));
  const gnss=await run(clock);const e=gnss.extendedHistory[0];assert.equal(e.stateDimension,8);assert.equal(e.filteredState[6],120);assert.equal(e.filteredState[7],2);assert.ok(Math.abs(e.filteredCovariance[63]-3/103)<1e-12);
  assert.ok(Math.abs((await run(adaptiveQ)).extendedHistory[1].processNoiseScale-2.25)<1e-14);
  const r=(await run(inflated)).extendedHistory[0];assert.ok(r.accepted);assert.ok(Math.abs(r.measurementNoiseScale-(100/9-1))<1e-10);
 }finally{harness.destroy?.();harness.dispose?.();}
});
test('WASM nonlinear EKF/UKF port replay agrees with independent Orekit',async()=>{await nonlinearCases();});
