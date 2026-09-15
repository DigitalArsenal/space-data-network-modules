// Run the production FRM tests on the exact same artifact in all three hosts.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { toLoadableWasmBytes } from 'space-data-module-sdk/bundle';
const root=fileURLToPath(new URL('..',import.meta.url));
const artifact=path.join(root,'dist/isomorphic/module.wasm');
const original=await fs.readFile(artifact);
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lane08-production-'));
const wrapper=path.join(dir,'wasmedge-container');
const image=process.env.SDN_FRAME_DOCKER_IMAGE||'space-data-module-sdk/parity-wasmedge:0.16.4';
try {
  // SDK strips publication metadata into a temporary wasm. Mount only that
  // exact file, read-only; forward argv as values, with no shell expansion.
  await fs.writeFile(wrapper,`#!/usr/bin/env python3
import os,sys
wasm=next(os.path.abspath(a) for a in sys.argv[1:] if a.endswith('.wasm'))
os.execvp('docker',['docker','run','--rm','-i','--network','none','-v',wasm+':'+wasm+':ro','--entrypoint','wasmedge',${JSON.stringify(image)}]+sys.argv[1:])
`,{mode:0o755});
  for(const [name,binary] of [['browser/V8',null],['native WasmEdge',process.env.SDM_WASMEDGE_BINARY||'wasmedge'],['container WasmEdge',wrapper]]) {
    const env={...process.env};
    if(binary)env.SDN_FRAME_WASMEDGE_BINARY=binary;else delete env.SDN_FRAME_WASMEDGE_BINARY;
    const result=spawnSync(process.execPath,['--test','tests/body_fixed.test.mjs'],{cwd:root,env,encoding:'utf8'});
    process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
    assert.equal(result.status,0,`${name} failed: ${result.error??''}`);
    assert.deepEqual(await fs.readFile(artifact),original,'artifact changed between lanes');
    console.log(`PASS production ${name}: BODY_FIXED (7 bodies) and missing-EOP refusal`);
  }
  console.log(`production same-byte SHA256 ${createHash('sha256').update(toLoadableWasmBytes(original)).digest('hex')}`);
} finally {await fs.rm(dir,{recursive:true,force:true});}
