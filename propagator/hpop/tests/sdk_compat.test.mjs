import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {validateArtifactWithStandards} from 'space-data-module-sdk';
import {encodePluginManifest,decodePluginManifest} from 'space-data-module-sdk/manifest';
import {inspectModule,loadModule} from 'space-data-module-sdk/host/isomorphic';
import {createBrowserModuleHarness} from 'space-data-module-sdk/testing';
import {requestFor,decodeResult,TYPE} from './lib/prwCodec.mjs';
const manifest=JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json',import.meta.url)));
const wasmPath=fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url));
const bytes=()=>fs.readFileSync(wasmPath);
function assertResponse(r){assert.equal(r.statusCode,0,r.errorMessage);assert.equal(r.outputs.length,1);assert.equal(r.outputs[0].portId,'response');assert.ok(decodeResult(r).version);}
test('canonical browser and isomorphic artifacts are identical',()=>{
 assert.deepEqual(bytes(),fs.readFileSync(new URL('../dist/browser/module.wasm',import.meta.url)));
 assert.ok(fs.existsSync(new URL('../dist/browser/module.js',import.meta.url)));
});
test('diagnostic browser factory loads same bytes and safely initializes allocation',async t=>{
 const {default:create}=await import('../dist/browser/module.js');
 const m=await create({wasmBinary:bytes(),noInitialRun:true});t.after(()=>m.__harness.destroy());
 m.__initialize();assert.equal(m._plugin_init(),0);const a=m._malloc(56),b=m._malloc(56);assert.ok(a>0&&b>0&&a!==b);m._free(a);m._free(b);
});
test('artifact passes standards-aware SDK compliance',async()=>{
 const report=await validateArtifactWithStandards({manifest,wasmPath,standardsRoot:fileURLToPath(new URL('../node_modules/spacedatastandards.org',import.meta.url))});
 assert.equal(report.ok,true,JSON.stringify(report.issues,null,2));
});
test('all method ports use the ratified canonical PRW identity',()=>{
 assert.deepEqual(manifest.methods.map(m=>m.methodId),['invoke','ingest_state','propagate_state','prepare_trajectory_segments','describe_trajectory_segments']);
 for(const m of manifest.methods)for(const p of [...m.inputPorts,...m.outputPorts])assert.deepEqual(p.acceptedTypeSets[0].allowedTypes,[TYPE]);
 assert.deepEqual(manifest.methods[0].inputPorts.map(p=>p.portId),['request','kernel','earth_orientation','space_weather']);
 assert.equal(manifest.threadModel,'wasi-sequential');assert.ok(manifest.sequentialJustification.detail.includes('ordered'));
});
test('PLG codec round-trips every declared method and port',()=>{
 const encoded=encodePluginManifest(manifest),decoded=decodePluginManifest(encoded);
 assert.deepEqual(encodePluginManifest(decoded),encoded);
 for(let i=0;i<manifest.methods.length;i++){
  assert.equal(decoded.methods[i].methodId,manifest.methods[i].methodId);
  for(const direction of ['inputPorts','outputPorts'])for(let j=0;j<manifest.methods[i][direction].length;j++){
   const original=manifest.methods[i][direction][j],actual=decoded.methods[i][direction][j];
   assert.equal(actual.portId,original.portId);
   const type=actual.acceptedTypeSets[0].allowedTypes[0];
   for(const k of ['schemaName','fileIdentifier','rootTypeName','wireFormat'])assert.equal(type[k],TYPE[k]);
  }
 }
});
test('standalone artifact has canonical exports and only WASI imports',async()=>{
 const inspected=await inspectModule(bytes());assert.equal(inspected.profile,'standalone');
 assert.deepEqual([...new Set(inspected.imports.map(i=>i.module))].sort(),['wasi_snapshot_preview1']);
 for(const name of ['_start','plugin_alloc','plugin_free','plugin_invoke_stream','plugin_get_manifest_flatbuffer','plugin_get_manifest_flatbuffer_size'])assert.ok(inspected.exports.includes(name));
});
test('embedded PLG matches authored manifest encoding',async t=>{
 const h=await createBrowserModuleHarness({wasmSource:bytes(),surface:'direct',sharedMemory:true});t.after(()=>h.destroy());
 const x=h.instance.exports;x.hpop_initialize();const ptr=x.plugin_get_manifest_flatbuffer(),n=x.plugin_get_manifest_flatbuffer_size();
 assert.deepEqual(new Uint8Array(x.memory.buffer,ptr,n).slice(),encodePluginManifest(manifest));
});
test('typed version request works through SDK browser command surface',async t=>{
 const h=await createBrowserModuleHarness({wasmSource:bytes(),surface:'command',sharedMemory:true});t.after(()=>h.destroy());assertResponse(await h.invoke(requestFor('version',{})));
});
test('typed version request works through SDK native WasmEdge surface',async t=>{
 const h=await loadModule({wasmSource:wasmPath,runtimeKind:'wasmedge',enableThreads:true});t.after(()=>h.destroy());assertResponse(await h.invoke(requestFor('version',{})));
});
