#!/usr/bin/env node
// SDK multi-unit adapter for the frozen E13 typed energy-arc method.
// No exception runtime, resident catalog, text parsers or HWM data loader.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('.',import.meta.url)),ffm=path.resolve(root,'../../propagator/ffm');
const emsdk=process.env.SDN_LOCAL_EMSDK_DIR||path.join(ffm,'deps/emsdk');
const clang=path.join(emsdk,'upstream/bin/clang++'),linker=path.join(emsdk,'upstream/bin/wasm-ld');
const manifest=JSON.parse(fs.readFileSync(path.join(ffm,'plugin-manifest.json')));
const units=['astrodynamics','integrators','rk_engine','integrator_events','variational','finite_burn','force_partials','coords','atmosphere_plugin','environment_models','ephemeris','force_models','nrlmsise00','time_convert','us76','ffm_gravity'].map(n=>path.join(ffm,`lib/${n}.cpp`));
units.push(...['prw_execution','prw_dynamics','kernel_store'].map(n=>path.join(ffm,`src/cpp/src/${n}.cpp`)),path.join(root,'.sdk-build/erfa.cpp'),...['nrlmsise-00.c','nrlmsise-00_data.c'].map(n=>path.resolve(root,'../../third_party/nrlmsise00',n)));
const include=[path.join(ffm,'lib'),path.join(ffm,'src/cpp/include'),path.join(ffm,'src/cpp/generated'),path.join(ffm,'src/cpp/generated/sds'),path.resolve(root,'../../third_party/nrlmsise00'),path.resolve(root,'../../foundation/frames/src'),path.resolve(root,'../../higherpop/third_party/erfa')];
const flags=['-msimd128','-fno-exceptions','-fno-c++-static-destructors','-DFFM_TYPED_INPUTS_ONLY=1',`-DFFM_MODULE_ID="${manifest.pluginId}"`,`-DFFM_MODULE_VERSION="${manifest.version}"`,...include.map(p=>`-I${p}`)];
const args=process.argv.slice(2);
function run(bin,argv){const r=spawnSync(bin,argv,{stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);}
if(args.includes('--version'))run(clang,args);
else if(args.includes('-c')&&path.basename(args[args.indexOf('-c')+1])==='module.cpp'){
 const output=args[args.indexOf('-o')+1],source=args[args.indexOf('-c')+1];
 const common=args.filter((a,i)=>!['-c','-o'].includes(a)&&i!==args.indexOf('-c')+1&&i!==args.indexOf('-o')+1);
 const dir=`${output}.parts`;fs.mkdirSync(dir,{recursive:true});const objects=[];
 for(const [i,unit]of [source,...units].entries()){
  const object=path.join(dir,`${i}.o`);objects.push(object);const c=unit.endsWith('.c');
  run(clang,[...common.filter(a=>!c||!a.startsWith('-std=')),...flags,...(c?['-x','c']:[]),'-c',unit,'-o',object]);
 }
 run(linker,['-r',...objects,'-o',output]);
}else if(args.includes('-c'))run(clang,[...args,...flags]);
else run(clang,[...args.map(a=>a.startsWith('-Wl,--initial-memory=')?'-Wl,--initial-memory=268435456':a.startsWith('-Wl,--max-memory=')?'-Wl,--max-memory=402653184':a),...flags,...(args.includes('-mexec-model=reactor')?[]:['-Wl,--wrap=__wasm_call_ctors']),'-Wl,--strip-debug']);
