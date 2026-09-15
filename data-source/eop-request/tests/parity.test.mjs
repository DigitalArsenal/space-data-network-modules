import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {normalizeParityFixture,runParityHarness,formatParityReport} from 'space-data-module-sdk/testing';
import {wire} from '../../eop-parser/tests/harness.mjs';
test('requests match in real browser, native WasmEdge and container WasmEdge',{skip:process.env.SDN_RUN_EOP_PARITY!=='1'},async()=>{
 const cases=['finals2000a','c04','paris'].map(methodId=>{const {payload,...f}=wire('tick',{});return {id:methodId,request:{methodId,inputs:[{...f,payloadBase64:Buffer.from(payload).toString('base64')}]},expect:'ok'};});
 const plan=await normalizeParityFixture({name:'eop-request',threadCounts:[1],cases});
 const report=await runParityHarness({wasmPath:fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url)),plan,autoBuildDockerImage:false,timeoutMs:30000,log:console.log});console.log(formatParityReport(report));assert.equal(report.ok,true,formatParityReport(report));assert.equal(report.lanes.length,3);
});
