import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeHttpRequest } from 'space-data-module-sdk/runtime-contracts';
import { normalizeParityFixture,runParityHarness,formatParityReport } from 'space-data-module-sdk/testing';
import { CORE, harness, httpResponse, nodeConfig, tick } from './fixture.mjs';

// parse_forecast is the pure half (no host call): the same artifact and the same HttpResponse in must give the same
// binary records in a browser and in native/container WasmEdge. plan_forecast reads node CONFIG, so its request is made
// here once and the lanes start from its response. NOTE: the artifact now IMPORTS the hostcall bridge (plan_forecast's
// plugin.getConfig), and the SDK parity runner's WasmEdge lanes provide no space_data_module_host imports, so they
// cannot instantiate it until the runner stubs that bridge.
test('the same weather artifact and binary records agree in browser and native/container WasmEdge', {skip:process.env.SDN_RUN_OPEN_METEO_PARITY!=='1'},async t=> {
  const h=await harness(t,{...CORE,config:nodeConfig()});
  const {context}=decodeHttpRequest((await h.invoke({methodId:'plan_forecast',inputs:[tick()]})).outputs[0].payload);
  const frame=httpResponse(context);
  const plan=await normalizeParityFixture({name:'open-meteo',threadCounts:[1],cases:[
    {id:'forecast-binary-records',request:{methodId:'parse_forecast',inputs:[{portId:'response',typeRef:frame.typeRef,payloadBase64:Buffer.from(frame.payload).toString('base64')}]},expect:'ok'},
  ]});
  const report=await runParityHarness({wasmPath:CORE.wasm,plan,autoBuildDockerImage:false,timeoutMs:30000,log:message=>console.log(message)});
  console.log(formatParityReport(report)); assert.equal(report.ok,true,formatParityReport(report)); assert.equal(report.lanes.length,3);
});
