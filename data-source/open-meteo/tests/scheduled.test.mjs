import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import {config,receipt,response,http,input} from './fixture.mjs';
const wasm=fs.readFileSync(new URL('../host-adapter/dist/isomorphic/module.wasm',import.meta.url));
const manifest=JSON.parse(fs.readFileSync(new URL('../host-adapter/plugin-manifest.json',import.meta.url)));
const decode=(r,p)=>JSON.parse(Buffer.from(r.outputs.find(f=>f.portId===p).payload));
const cfg=()=>({open_meteo_enabled:true,open_meteo_forecast:config,open_meteo_producer_peer_id:receipt.producer_peer_id});
async function host(t,configuration) {
  const h=await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'direct',hostcallDispatch:op=>{
    assert.equal(op,'plugin.getConfig');return configuration;
  }});t.after(()=>h.destroy());return h;
}
async function core(t) {
 const h=await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url)),manifest:JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json',import.meta.url))),surface:'direct'});t.after(()=>h.destroy());return h;
}
async function jobFor(t,h) {const configuration=decode(await prepare(h),'config');const c=await core(t);return decode(await c.invoke({methodId:'plan_forecast',inputs:[input('config',configuration)]}),'job');}
const prepare=h=>h.invoke({methodId:'prepare_scheduled',inputs:[input('tick',{})]});
test('scheduled fetch is disabled until explicitly configured and sends bounded requests',async t=> {
  const h=await host(t,{});const disabled=await prepare(h);
  assert.equal(disabled.statusCode,0,disabled.errorMessage);assert.deepEqual(disabled.outputs.map(f=>f.portId),['status']);
  const enabled=await prepare(await host(t,cfg()));assert.equal(enabled.statusCode,0,enabled.errorMessage);
  assert.deepEqual(decode(enabled,'config'),config);
  const paid=cfg();paid.open_meteo_forecast={...config,access:'customer'};
  const unsupported=await prepare(await host(t,paid));assert.notEqual(unsupported.statusCode,0);assert.equal(unsupported.outputs.length,0);
});
test('unchanged HTTP responses do not replace or republish the current batch',async t=> {
  const h=await host(t,cfg()),job=await jobFor(t,h);
  const result=await h.invoke({methodId:'receipt_scheduled',inputs:[input('job',job),input('response',http('',304))]});
  assert.equal(result.statusCode,0,result.errorMessage);assert.deepEqual(result.outputs.map(f=>f.portId),['status']);
});
