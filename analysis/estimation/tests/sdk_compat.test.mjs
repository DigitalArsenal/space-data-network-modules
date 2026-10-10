import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectModule, validateArtifactWithStandards, validateManifestWithStandards } from 'space-data-module-sdk';
const manifest=JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json',import.meta.url)));
const wasmPath=fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url));
test('estimation manifest passes SDK standards validation',async()=>{
 const r=await validateManifestWithStandards(manifest);assert.equal(r.ok,true,JSON.stringify(r.issues));
 assert.deepEqual(manifest.runtimeTargets,['browser','wasmedge']);
});
test('built estimation artifact passes SDK validation and exports canonical ABI',async()=>{
 const r=await validateArtifactWithStandards({manifest,wasmPath});assert.equal(r.ok,true,JSON.stringify(r.issues));
 const inspection=await inspectModule(fs.readFileSync(wasmPath));
 for(const name of ['_start','plugin_invoke_stream','plugin_alloc','plugin_free','plugin_get_manifest_flatbuffer','plugin_get_manifest_flatbuffer_size','run_estimation','fit_batch','evaluate_teag'])assert.ok(inspection.exports.includes(name),name);
 assert.equal(inspection.profile,'standalone');
});
