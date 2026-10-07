#!/usr/bin/env node
// Public SDK SDN_WASI_CLANGXX adapter. The SDK accepts one sourceCode unit
// and hardcodes -fno-exceptions; HPOP requires separately compiled C++ units
// and LLVM's standard Wasm exception ABI for its existing physics checks.
// This driver never invokes emcc and never replaces the SDK invoke/PLG glue.
//
// Initialization: the SDK's invoke bridge owns the `__wasm_call_ctors` export
// (the direct-surface initializer of a command artifact, SDK >= 0.8.21). This
// driver adds no export of that name. --wrap routes every undefined reference
// to __wasm_call_ctors (the SDK initializer, the WASI command CRT's _start and
// hpop_initialize) into the one per-instance guard in prw_sdk_adapter.cpp.
// The final link strips DWARF (it comes from the prebuilt LLVM ABI archives).
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const config=JSON.parse(fs.readFileSync(process.env.HPOP_SDK_BUILD_CONFIG));
const original=process.argv.slice(2);
function run(command,args){const r=spawnSync(command,args,{stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);}
if(original.includes('--version')){run(config.clangxx,original);process.exit(0);}
const args=original.filter(a=>a!=='-fno-exceptions');
const compile=args.includes('-c');
const source=compile?args[args.indexOf('-c')+1]:null;
const flags=['-fno-c++-static-destructors','-fwasm-exceptions','-mllvm','-wasm-use-legacy-eh=false',...Object.entries(config.defines??{}).map(([name,value])=>`-D${name}=${JSON.stringify(value)}`),...config.includes.map(p=>`-I${p}`)];
if(compile&&path.basename(source)==='module.cpp'){
  const output=args[args.indexOf('-o')+1];
  const common=args.filter((a,i)=>a!=='-c'&&a!=='-o'&&i!==args.indexOf('-c')+1&&i!==args.indexOf('-o')+1);
  const objectDir=`${output}.parts`;fs.mkdirSync(objectDir,{recursive:true});
  const units=[source,...config.units];
  const objects=[];
  for(let i=0;i<units.length;i++){
    const unit=units[i],object=path.join(objectDir,`${i}-${path.basename(unit)}.o`);objects.push(object);
    const unitFlags=unit.endsWith('plugin_runtime.cpp')?['-O0','-fno-inline','-fno-lto']:[];
    const cUnit=unit.endsWith('.c');
    run(config.clangxx,[...common.filter(a=>!cUnit||!a.startsWith('-std=')),...flags,...unitFlags,...(cUnit?['-x','c']:[]),'-c',unit,'-o',object]);
  }
  // TLS relocations in Wasm EH require the unwind TLS symbol to be present
  // even for a relocatable link, so include LLVM's ABI archives at this step.
  run(config.linker,['-r',...objects,...config.exceptionLibraries,'-o',output]);
}else if(compile){run(config.clangxx,[...args,...flags]);}
else {run(config.clangxx,[...args.map(a=>a.startsWith('-Wl,--initial-memory=')?'-Wl,--initial-memory=268435456':a),...flags,...config.exceptionLibraries,'-Wl,--wrap=__wasm_call_ctors','-Wl,--strip-debug',...config.diagnosticExports.map(s=>`-Wl,--export=${s}`)]);}
