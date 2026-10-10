#!/usr/bin/env node
// SDN_WASI_CLANGXX adapter for the OD HPOP module (the pattern of
// propagator/hpop/build-driver.mjs). The SDK compiles one source unit with
// -fno-exceptions; this module links propagator/hpop, estimation and the OD
// fit library, which need LLVM's standard Wasm exception ABI and two
// separate SDS header sets: each unit is compiled with its own include list
// (OD_HPOP_BUILD_CONFIG), then relinked with the SDK's glue unit.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const config=JSON.parse(fs.readFileSync(process.env.OD_HPOP_BUILD_CONFIG));
const original=process.argv.slice(2);
function run(command,args){if(process.env.OD_HPOP_DRIVER_LOG)fs.appendFileSync(process.env.OD_HPOP_DRIVER_LOG,JSON.stringify([command,...args])+'\n');const r=spawnSync(command,args,{stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);}
if(original.includes('--version')){run(config.clangxx,original);process.exit(0);}
const args=original.filter(a=>a!=='-fno-exceptions');
const compile=args.includes('-c');
const source=compile?args[args.indexOf('-c')+1]:null;
const common=['-fno-c++-static-destructors','-fwasm-exceptions','-mllvm','-wasm-use-legacy-eh=false'];
if(compile&&path.basename(source)==='module.cpp'){if(process.env.OD_HPOP_DRIVER_LOG)fs.copyFileSync(source,process.env.OD_HPOP_DRIVER_LOG+'.module.cpp');
  const output=args[args.indexOf('-o')+1];
  const base=args.filter((a,i)=>a!=='-c'&&a!=='-o'&&i!==args.indexOf('-c')+1&&i!==args.indexOf('-o')+1);
  const objectDir=`${output}.parts`;fs.mkdirSync(objectDir,{recursive:true});
  const objects=[];
  const units=[{path:source,includes:config.glueIncludes,defines:{}},...config.units];
  for(let i=0;i<units.length;i++){
    const unit=units[i],object=path.join(objectDir,`${i}-${path.basename(unit.path)}.o`);objects.push(object);
    const cUnit=unit.path.endsWith('.c');
    const flags=[...common,...Object.entries(unit.defines??{}).map(([k,v])=>`-D${k}=${JSON.stringify(v)}`),...unit.includes.map(p=>`-I${p}`)];
    run(config.clangxx,[...base.filter(a=>!cUnit||!a.startsWith('-std=')),...flags,...(cUnit?['-x','c']:[]),'-c',unit.path,'-o',object]);
  }
  run(config.linker,['-r',...objects,...config.exceptionLibraries,'-o',output]);
}else if(compile){run(config.clangxx,[...args,...common,...config.glueIncludes.map(p=>`-I${p}`)]);}
else {run(config.clangxx,[...args.map(a=>a.startsWith('-Wl,--initial-memory=')?'-Wl,--initial-memory=268435456':a),...common,...config.exceptionLibraries,'-Wl,--wrap=__wasm_call_ctors','-Wl,--strip-debug']);}
