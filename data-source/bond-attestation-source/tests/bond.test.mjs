import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';
const manifest=JSON.parse(readFileSync(new URL('../plugin-manifest.json',import.meta.url)));
const wasmPath=fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url));
test('bond artifact declares the real host and direct invoke ABI',()=>{
  assert.deepEqual(manifest.runtimeTargets,['wasmedge']);
  assert.deepEqual(manifest.invokeSurfaces,['direct']);
  const module=new WebAssembly.Module(readFileSync(wasmPath));
  const names=WebAssembly.Module.exports(module).map(e=>e.name);
  for(const name of ['plugin_alloc','plugin_free','plugin_invoke_stream','plugin_get_manifest_flatbuffer','plugin_get_manifest_flatbuffer_size']) assert(names.includes(name));
});
test('bond manifest and artifact pass SDK validation',async()=>{
  const report=await validateArtifactWithStandards({manifest,wasmPath,standardsRoot:process.env.SDN_STANDARDS_ROOT});
  assert.equal(report.ok,true,JSON.stringify(report.issues));
});
test('attests through native WasmEdge and the SDN HTTP host', {skip:!process.env.SDN_BOND_TEST_ROOT},()=>{
  const result=spawnSync('go',['test','./cmd/spacedatanetwork','-run','TestBondModuleFixtures','-count=1'],{cwd:process.env.SDN_BOND_TEST_ROOT,encoding:'utf8',env:{...process.env,SDN_BOND_TEST_WASM:wasmPath}});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
