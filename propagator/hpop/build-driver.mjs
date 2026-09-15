#!/usr/bin/env node
// Public SDK SDN_WASI_CLANGXX adapter. SDK 0.8.18 accepts one sourceCode unit
// and hardcodes -fno-exceptions; HPOP requires separately compiled C++ units
// and LLVM's standard Wasm exception ABI for its existing physics checks.
// This driver never invokes emcc and never replaces the SDK invoke/PLG glue.
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
const flags=['-fno-c++-static-destructors','-fwasm-exceptions','-mllvm','-wasm-use-legacy-eh=false',...config.includes.map(p=>`-I${p}`)];
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
else {run(config.clangxx,[...args.map(a=>a.startsWith('-Wl,--initial-memory=')?'-Wl,--initial-memory=268435456':a),...flags,...config.exceptionLibraries,config.initializationSource,'-Wl,--wrap=__wasm_call_ctors',...config.diagnosticExports.map(s=>`-Wl,--export=${s}`)]);}
