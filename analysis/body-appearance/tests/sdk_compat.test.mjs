import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {inspectModule,validateArtifactWithStandards,validateManifestWithStandards,encodePluginManifest,decodePluginManifest} from 'space-data-module-sdk';
const manifest=JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json',import.meta.url),'utf8'));
const wasmPath=fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url));
test('typed SDS manifest validates and round-trips',async()=>{
  const result=await validateManifestWithStandards(manifest);assert.equal(result.ok,true,JSON.stringify(result.issues));
  const roundtrip=decodePluginManifest(encodePluginManifest(manifest));
  assert.equal(roundtrip.pluginId,manifest.pluginId);
  assert.deepEqual(roundtrip.methods.map(m=>m.methodId),manifest.methods.map(m=>m.methodId));
  for(const method of manifest.methods)for(const port of [...method.inputPorts,...method.outputPorts])
    assert.equal(port.acceptedTypeSets[0].allowedTypes[0].fileIdentifier,'$PCE');
});
test('same isomorphic artifact has the SDK ABI and only portable imports',async()=>{
  const result=await validateArtifactWithStandards({manifest,wasmPath});assert.equal(result.ok,true,JSON.stringify(result.issues));
  const inspection=await inspectModule(fs.readFileSync(wasmPath));
  for(const symbol of ['plugin_alloc','plugin_free','plugin_invoke_stream','plugin_get_manifest_flatbuffer','plugin_get_manifest_flatbuffer_size','_start',...manifest.methods.map(m=>m.methodId)])assert.ok(inspection.exports.includes(symbol),symbol);
  assert.ok(inspection.imports.every(i=>i.module==='wasi_snapshot_preview1'),JSON.stringify(inspection.imports));
});
