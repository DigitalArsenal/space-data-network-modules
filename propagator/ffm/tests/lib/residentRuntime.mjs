// Stateful portability hosts built only through public SDK APIs. No guest ABI
// or numerical implementation is duplicated here.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {
  createBrowserModuleHarness, createModuleHarness,
  buildWasmEdgeEmscriptenPthreadRunner, resolveWasmEdgeRunnerSourcePath,
  loadWasmEdgePin,
} from 'space-data-module-sdk/testing';
const execFile=promisify(execFileCallback);
export const packageDir=fileURLToPath(new URL('../../',import.meta.url));
export const wasmPath=path.join(packageDir,'dist/isomorphic/module.wasm');
const cache=path.join(packageDir,'.sdk-build');
let nativeRunnerPromise;
let dockerRunnerPromise;
export async function nativeRunner() {
  fs.mkdirSync(cache,{recursive:true});
  return nativeRunnerPromise??=buildWasmEdgeEmscriptenPthreadRunner({outputPath:path.join(cache,'resident-wasmedge-runner')});
}
export async function dockerRunner() {
  return dockerRunnerPromise??=(async()=>{
    fs.mkdirSync(cache,{recursive:true});
    const pin=loadWasmEdgePin();
    const source=resolveWasmEdgeRunnerSourcePath();
    const stamp=createHash('sha256').update(fs.readFileSync(source)).update(pin.dockerImage).update('POSIX200809L').digest('hex');
    const output=path.join(cache,'resident-wasmedge-runner-linux');
    const stampPath=path.join(cache,'resident-wasmedge-runner-linux.sha256');
    if(!fs.existsSync(output)||!fs.existsSync(stampPath)||fs.readFileSync(stampPath,'utf8')!==stamp) {
      const relativeSource=path.relative(packageDir,source);
      if(relativeSource.startsWith('..'))throw new Error('SDK runner source must resolve inside installed module dependencies.');
      // Build the SDK's public runner source in an ephemeral pinned container.
      // _POSIX_C_SOURCE exposes strdup in strict C11 on glibc. No SDK source edit.
      const script='apt-get update -qq && apt-get install -y -qq --no-install-recommends gcc libc6-dev >/dev/null && '+
        'gcc "$1" -std=c11 -D_POSIX_C_SOURCE=200809L -O2 -pthread -I/opt/wasmedge/include '+
        '-L/opt/wasmedge/lib64 -L/opt/wasmedge/lib -lwasmedge '+
        '-Wl,-rpath,/opt/wasmedge/lib64 -Wl,-rpath,/opt/wasmedge/lib -o .sdk-build/resident-wasmedge-runner-linux';
      await execFile('docker',['run','--rm','--entrypoint','/bin/sh','-v',`${packageDir}:/work`,'-w','/work',pin.dockerImage,'-c',script,'compile-runner',relativeSource],{maxBuffer:4*1024*1024});
      fs.writeFileSync(stampPath,stamp);
    }
    return {image:pin.dockerImage,output};
  })();
}
export async function residentHarness(runtime='browser') {
  if(runtime==='browser') return createBrowserModuleHarness({
    wasmSource:fs.readFileSync(wasmPath),manifest:JSON.parse(fs.readFileSync(path.join(packageDir,'plugin-manifest.json'))),surface:'direct',
  });
  if(runtime==='wasmedge') return createModuleHarness({runtime:{
    kind:'wasmedge',wasmPath,wasmEdgeRunnerBinary:await nativeRunner(),
  }});
  if(runtime==='docker-wasmedge') {
    const {image}=await dockerRunner();
    // Use the public SDK stream client and an init process that forwards its
    // SIGTERM teardown to the runner (Linux PID 1 ignores default SIGTERM).
    return createModuleHarness({runtime:{kind:'wasmedge',launchPlan:{command:'docker',args:[
      'run','--rm','--init','-i','--entrypoint','/work/.sdk-build/resident-wasmedge-runner-linux',
      '-v',`${packageDir}:/work`,'-w','/work',image,'dist/isomorphic/module.wasm','--serve-plugin-invoke',
    ]}}});
  }
  throw new Error(`Unsupported resident runtime ${runtime}`);
}
