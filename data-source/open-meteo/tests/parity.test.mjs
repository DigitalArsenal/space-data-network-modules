import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { normalizeParityFixture,runParityHarness,formatParityReport } from 'space-data-module-sdk/testing';
import { config,receipt,response,http,input } from './fixture.mjs';

test('the same weather artifact and binary records agree in browser and native/container WasmEdge', {skip:process.env.SDN_RUN_OPEN_METEO_PARITY!=='1'},async()=> {
  const wasmPath=fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url));
  const manifest=JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json',import.meta.url)));
  const host=await createBrowserModuleHarness({wasmSource:fs.readFileSync(wasmPath),manifest,surface:'direct'});
  let job;
  try {
    const result=await host.invoke({methodId:'plan_forecast',inputs:[input('config',config)]});
    assert.equal(result.statusCode,0,result.errorMessage);
    job=JSON.parse(Buffer.from(result.outputs.find(f=>f.portId==='job').payload).toString());
  } finally { await host.destroy(); }
  const wire=(port,value)=> {
    const frame=input(port,value);
    return {portId:port,typeRef:frame.typeRef,payloadBase64:Buffer.from(frame.payload).toString('base64')};
  };
  const plan=await normalizeParityFixture({name:'open-meteo',threadCounts:[1],cases:[
    {id:'request-plan',request:{methodId:'plan_forecast',inputs:[wire('config',config)]},expect:'ok'},
    {id:'forecast-binary-records',request:{methodId:'parse_forecast',inputs:[wire('job',job),wire('response',http(response())),wire('receipt',receipt)]},expect:'ok'},
  ]});
  const report=await runParityHarness({wasmPath,plan,autoBuildDockerImage:false,timeoutMs:30000,log:message=>console.log(message)});
  console.log(formatParityReport(report)); assert.equal(report.ok,true,formatParityReport(report)); assert.equal(report.lanes.length,3);
});
