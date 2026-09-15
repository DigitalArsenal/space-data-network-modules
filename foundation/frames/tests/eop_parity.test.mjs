import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {normalizeParityFixture,runParityHarness,formatParityReport} from 'space-data-module-sdk/testing';
import {eop,invokeRequest} from './eop_harness.mjs';
test('EOP-driven frames match in real browser, native WasmEdge and container WasmEdge',{skip:process.env.SDN_RUN_EOP_PARITY!=='1'},async()=>{
 const requests=[invokeRequest(undefined,[eop()]),invokeRequest(undefined,[eop(),eop({mjd:54196,date:'2007-04-06T00:00:00Z',x:.04,y:.5,dut1:-.073})]),invokeRequest('2016-12-31T23:59:60Z',[eop({mjd:57753,date:'2016-12-31T00:00:00Z',dut1:-.4077601}),eop({mjd:57754,date:'2017-01-01T00:00:00Z',dut1:.5912821})])];
 const cases=requests.map((r,i)=>({id:['sofa-5.6','linear-table','leap-second'][i],request:{...r,inputs:r.inputs.map(({payload,...f})=>({...f,payloadBase64:Buffer.from(payload).toString('base64')}))},expect:'ok'}));
 const plan=await normalizeParityFixture({name:'frames-eop',threadCounts:[1],cases});
 const report=await runParityHarness({wasmPath:fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url)),plan,autoBuildDockerImage:false,timeoutMs:30000,log:console.log});console.log(formatParityReport(report));assert.equal(report.ok,true,formatParityReport(report));assert.equal(report.lanes.length,3);
});
