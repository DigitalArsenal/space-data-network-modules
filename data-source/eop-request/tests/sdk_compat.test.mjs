import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {validateArtifactWithStandards} from 'space-data-module-sdk/compliance';
import {inspectModule} from 'space-data-module-sdk/host/isomorphic';
import {createBrowserModuleHarness} from 'space-data-module-sdk/testing';
import {publishedStandardsRoot} from '../../terrain-source/sds-headers.mjs';
const wasmPath=fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url));
test('SDK artifact compliance',async()=>{
 const report=await validateArtifactWithStandards({manifest:JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json',import.meta.url))),wasmPath,standardsRoot:publishedStandardsRoot(import.meta.url)});assert.equal(report.ok,true,JSON.stringify(report.issues));
});
test('pure standalone artifact has canonical exports and no host capabilities',async()=>{
 const report=await inspectModule(fs.readFileSync(wasmPath));assert.equal(report.profile,'standalone');assert.deepEqual([...new Set(report.imports.map(x=>x.module))],['wasi_snapshot_preview1']);
 for(const name of ['plugin_alloc','plugin_free','plugin_invoke_stream','plugin_get_manifest_flatbuffer','plugin_get_manifest_flatbuffer_size'])assert.ok(report.exports.includes(name));
});
test('same artifact loads through the SDK browser harness',async t=>{const h=await createBrowserModuleHarness({wasmSource:fs.readFileSync(wasmPath),surface:'direct'});t.after(()=>h.destroy());assert.ok(h);});
