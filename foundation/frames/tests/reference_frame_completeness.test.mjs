// JS orchestrates only; every numerical assertion runs inside C++.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { loadModule } from 'space-data-module-sdk/host/isomorphic';
import { toLoadableWasmBytes } from 'space-data-module-sdk/bundle';
import { createHash } from 'node:crypto';
import { composeErfaTranslationUnit } from '../erfa-amalgamation.mjs';
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const read=relative=>fs.readFile(path.join(root,relative),'utf8');
async function source() {
  const [erfa,axis,body,cases,fixtureText]=await Promise.all([
    composeErfaTranslationUnit(),read('src/axis_engine.hpp'),read('src/iau_body_models.hpp'),
    read('tests/reference_frame_cases.cpp'),read('tests/body_orientation_reference.json')]);
  const fixtures=JSON.parse(fixtureText).cases.map(f=>{
    const m=f.matrix_icrf_to_fixed;
    return `{${f.body_id},${f.tdb_days_since_j2000},{{{${m.slice(0,3)}},{${m.slice(3,6)}},{${m.slice(6,9)}}}},${f.tolerance}}`;
  });
  return [erfa.source,body,axis.replace('#include "iau_body_models.hpp"','')
    .replace(/extern "C" \{\n#include "erfa.h"\n#include "erfam.h"\n\}/,''),
    cases.replace('#include "axis_engine.hpp"','').replace('#include "body_reference_cases.inc"',
      `const BodyReference bodyReferences[]={${fixtures.join(',\n')}};`)].join('\n');
}
test('published SOFA, Vallado, CSPICE and closed-form reference frames',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lane08-frames-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const cpp=await source(),cppPath=path.join(dir,'reference.cpp');
  await fs.writeFile(cppPath,cpp+'\nint main(){return lane08::frameReferenceChecks(true);}\n');
  const build=spawnSync('c++',['-std=c++17','-O1',cppPath,'-o',path.join(dir,'reference')],{encoding:'utf8'});
  assert.equal(build.status,0,build.stderr);
  const run=spawnSync(path.join(dir,'reference'),[],{encoding:'utf8'});
  console.log(run.stdout);assert.equal(run.status,0,run.stderr);
  await t.test('same SDK reference guest in browser/V8, native and container WasmEdge',
    {skip:process.env.SDN_FRAME_TRI_RUNTIME!=='1'},async()=>{
    const manifest=JSON.parse(await read('plugin-manifest.json'));
    manifest.pluginId='com.digitalarsenal.foundation.frames.reference-tests';
    manifest.methods=[{methodId:'reference_checks',displayName:'Reference checks',inputPorts:[],outputPorts:[],maxBatch:1,drainPolicy:'single-shot'}];
    const outputPath=path.join(dir,'dist/isomorphic/module.wasm');
    await fs.mkdir(path.dirname(outputPath),{recursive:true});
    await compileModuleFromSource({manifest,sourceCode:cpp+`\n#include "space_data_module_invoke.h"
      extern "C" int reference_checks(void) {
        plugin_reset_output_state();
        int failures=lane08::frameReferenceChecks(false);
        if(failures) plugin_set_error("reference-failure","Authoritative frame case exceeded tolerance");
        return failures ? 3 : 0;
      }`,language:'c++',threadModel:'single-thread',outputPath});
    const loadable=toLoadableWasmBytes(await fs.readFile(outputPath));
    const guest=path.join(dir,'guest.wasm');await fs.writeFile(guest,loadable);
    const wrapper=path.join(dir,'docker-wasmedge');
    const image=process.env.SDN_FRAME_DOCKER_IMAGE||'space-data-module-sdk/parity-wasmedge:0.16.4';
    // Use argv; mount only the test directory, read-only, without networking.
    await fs.writeFile(wrapper,`#!/usr/bin/env python3\nimport os,sys\nos.execvp('docker',['docker','run','--rm','-i','--network','none','-v',${JSON.stringify(dir+':'+dir+':ro')},'--entrypoint','wasmedge',${JSON.stringify(image)}]+sys.argv[1:])\n`,{mode:0o755});
    const lanes=[
      ['browser/V8',()=>createBrowserModuleHarness({wasmSource:loadable,surface:'direct'})],
      ['native WasmEdge',()=>loadModule({wasmSource:guest,runtimeKind:'wasmedge',enableThreads:false,wasmEdgeBinary:process.env.SDM_WASMEDGE_BINARY||'wasmedge'})],
      ['container WasmEdge',()=>loadModule({wasmSource:guest,runtimeKind:'wasmedge',enableThreads:false,wasmEdgeBinary:wrapper})],
    ];
    for(const [name,create] of lanes) {
      const harness=await create();
      try {const result=await harness.invoke({methodId:'reference_checks',inputs:[]});
        assert.equal(result.statusCode,0,`${name}: ${result.errorMessage}`);
        console.log(`PASS ${name}: authoritative frame checks`);
      }finally{await harness.destroy();}
    }
    console.log(`same-byte SHA256 ${createHash('sha256').update(loadable).digest('hex')}`);
  });
});
