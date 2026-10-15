import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {validateArtifactWithStandards} from 'space-data-module-sdk/compliance';
import {inspectModule} from 'space-data-module-sdk/host/isomorphic';
import {createBrowserModuleHarness} from 'space-data-module-sdk/testing';
import {fileURLToPath as toPath} from 'node:url';
const STANDARDS_ROOT=process.env.SPACE_DATA_STANDARDS_ROOT??toPath(new URL('../../../../spacedatastandards.org/',import.meta.url));
const wasmPath=fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url));
test('SDK artifact compliance',async()=>{
 const report=await validateArtifactWithStandards({manifest:JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json',import.meta.url))),wasmPath,standardsRoot:STANDARDS_ROOT});assert.equal(report.ok,true,JSON.stringify(report.issues));
 const manifest=JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json',import.meta.url)));
 for(const m of manifest.methods)for(const p of [...m.inputPorts,...m.outputPorts]){assert.equal(p.acceptedTypeSets.length,1);const t=p.acceptedTypeSets[0].allowedTypes;assert.equal(t.length,1);assert.equal(t[0].acceptsAnyFlatbuffer,undefined);assert.equal(t[0].wireFormat,'flatbuffer');assert.ok(t[0].fileIdentifier&&t[0].schemaName&&t[0].rootTypeName);}
 assert.deepEqual(manifest.capabilities,[]);
});
test('pure standalone artifact: canonical exports, WASI-only imports (no hostcalls), no capabilities',async()=>{
 const report=await inspectModule(fs.readFileSync(wasmPath));assert.equal(report.profile,'standalone');assert.deepEqual([...new Set(report.imports.map(x=>x.module))],['wasi_snapshot_preview1']);
 for(const name of ['plugin_alloc','plugin_free','plugin_invoke_stream','plugin_get_manifest_flatbuffer','plugin_get_manifest_flatbuffer_size'])assert.ok(report.exports.includes(name));
});
test('same artifact loads through the SDK browser harness',async t=>{const h=await createBrowserModuleHarness({wasmSource:fs.readFileSync(wasmPath),surface:'direct'});t.after(()=>h.destroy());assert.ok(h);});
