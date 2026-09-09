import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Builder } from 'flatbuffers';
import { normalizeParityFixture, runParityHarness, formatParityReport } from 'space-data-module-sdk/testing';

test('one artifact produces identical output in Chromium, native WasmEdge and container WasmEdge', { skip: process.env.SDN_RUN_CATALOG_PARITY !== '1' }, async () => {
  const record = (name, id) => { const b = new Builder(); const n = b.createString(name), d=b.createString('2020-001A'); b.startObject(3); b.addFieldOffset(0,n,0); b.addFieldOffset(1,d,0); b.addFieldInt32(2,id,0); b.finishSizePrefixed(b.endObject(),'$CAT'); return new Uint8Array(b.asUint8Array()); };
  const config = { version:2, layers:['a','b'].map(id=>({id,node:`peer-${id}`,provider:id,source:'satcat',head:`snapshot-${id}`})),asOf:1000,maxAgeSeconds:100,stateSources:[],overrides:{'cospar:2020-001A':{catalogLayer:'b'}} };
  const recipe = JSON.stringify(config);
  const request = { methodId:'compose',inputs:[
    {portId:'recipe',payloadUtf8:recipe,typeRef:{wireFormat:'aligned-binary',byteLength:new TextEncoder().encode(recipe).length,requiredAlignment:1}},
    ...[record('First',1),record('Selected',1)].map(payload=>({portId:'catalogs',payload,typeRef:{schemaName:'CAT.fbs',fileIdentifier:'$CAT',rootTypeName:'CAT'}})),
  ] };
  const invalid = structuredClone(request);invalid.inputs[0].payloadUtf8='!';invalid.inputs[0].typeRef.byteLength=1;
  // A rejected recipe is a structured PIV error response; the command host
  // exits normally after writing it. sdk_compat separately asserts its status.
  const plan = await normalizeParityFixture({name:'catalog-composer',threadCounts:[1],cases:[{id:'exact-id-override',request,expect:'ok'},{id:'malformed-recipe',request:invalid,expect:'ok'}]});
  const report = await runParityHarness({wasmPath:fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url)),plan,autoBuildDockerImage:false,timeoutMs:30000,log:message=>console.log(message)});
  console.log(formatParityReport(report));
  assert.equal(report.ok,true,formatParityReport(report));
  assert.equal(report.lanes.length,3);
});
