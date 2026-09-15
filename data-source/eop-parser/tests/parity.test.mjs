import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {normalizeParityFixture,runParityHarness,formatParityReport} from 'space-data-module-sdk/testing';
import {parseRequest,wire} from './harness.mjs';
export const parityRequest=request=>({...request,inputs:request.inputs.map(({payload,...f})=>({...f,payloadBase64:Buffer.from(payload).toString('base64')}))});
test('parser bytes match in real browser, native WasmEdge and container WasmEdge',{skip:process.env.SDN_RUN_EOP_PARITY!=='1'},async()=>{
 const cases=['finals2000a','c04','paris'].flatMap(source=>[false,true].map(http=>({id:source+(http?'-http':'-raw'),request:parityRequest(parseRequest(source,undefined,http)),expect:'ok'})));
 cases.push({id:'invalid-row',request:parityRequest(parseRequest('c04',Buffer.from('2023'))),expect:'ok'});
 cases.push({id:'not-modified',request:parityRequest({methodId:'parse_c04',inputs:[wire('response',{status:304})]}),expect:'ok'});
 const plan=await normalizeParityFixture({name:'eop-parser',threadCounts:[1],cases});
 const report=await runParityHarness({wasmPath:fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url)),plan,autoBuildDockerImage:false,timeoutMs:30000,log:console.log});console.log(formatParityReport(report));assert.equal(report.ok,true,formatParityReport(report));assert.equal(report.lanes.length,3);
});
