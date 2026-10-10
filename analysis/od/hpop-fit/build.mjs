// Builds dist/isomorphic/module.wasm: the OD HPOP fit (src/), the OD fit
// library (../src/cpp: parsers, frames, SGP4 fitter, OMM/OBD builders),
// estimation's batch_fit and propagator/hpop's PRW execution, read-only, in
// one wasm32-wasip1-threads artifact through the SDK compiler.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {compileModuleFromSource,cleanupCompilation} from 'space-data-module-sdk/compiler';
import {composeErfaTranslationUnit} from '../../../foundation/frames/erfa-amalgamation.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const repo=path.resolve(root,'../../..');
const hpop=path.join(repo,'propagator/hpop'),od=path.join(repo,'analysis/od/src/cpp');
const manifest=JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json'),'utf8'));
const hpopManifest=JSON.parse(await fs.readFile(path.join(hpop,'plugin-manifest.json'),'utf8'));
const emsdk=[process.env.SDN_LOCAL_EMSDK_DIR,path.join(repo,'deps/emsdk')].filter(Boolean).find(p=>fsSync.existsSync(path.join(p,'upstream/bin/clang++')));
if(!emsdk)throw new Error('Set SDN_LOCAL_EMSDK_DIR to an emsdk with LLVM standard Wasm EH archives (propagator/hpop uses the same).');
const eigen=process.env.SDN_OD_EIGEN_DIR;
if(!eigen)throw new Error('Set SDN_OD_EIGEN_DIR to the Eigen headers directory (analysis/od uses the same).');
const libDir=path.join(emsdk,'upstream/emscripten/cache/sysroot/lib/wasm32-emscripten/lto');
const exceptionLibraries=['libc++abi-ww-wasmexcept.a','libunwind-ww-wasmexcept.a'].map(n=>path.join(libDir,n));
const buildDir=path.join(root,'.sdk-build');await fs.mkdir(buildDir,{recursive:true});
const erfa=await composeErfaTranslationUnit();
const erfaUnit=path.join(buildDir,'erfa-amalgamation.cpp');await fs.writeFile(erfaUnit,erfa.source);
const hpopIncludes=[path.join(hpop,'lib'),path.join(hpop,'src'),path.join(hpop,'src/cpp/include'),path.join(hpop,'src/cpp/generated'),path.join(hpop,'src/cpp/generated/sds'),path.join(repo,'third_party/nrlmsise00'),path.join(repo,'third_party/hwm14'),path.join(repo,'foundation/frames/src'),path.join(repo,'higherpop/third_party/erfa'),path.join(repo,'analysis/estimation/src')];
const odIncludes=[path.join(od,'include'),path.join(od,'deps/vallado-sgp4'),eigen,path.join(repo,'licensing/core/src/cpp/generated/sds'),path.join(root,'src')];
const hpopDefines={HPOP_MODULE_ID:hpopManifest.pluginId,HPOP_MODULE_VERSION:hpopManifest.version};
const H=(p,extra={})=>({path:p,includes:hpopIncludes,defines:{...hpopDefines,...extra}});
const O=p=>({path:p,includes:odIncludes,defines:{EIGEN_DONT_PARALLELIZE:1}});
const units=[
  ...['astrodynamics','integrators','variational','finite_burn','force_partials','coords','atmosphere_plugin','environment_models','ephemeris','force_models','atmosphere_winds','nrlmsise00','time_convert','us76'].map(n=>H(path.join(hpop,`lib/${n}.cpp`))),
  H(path.join(repo,'third_party/hwm14/hwm14.cpp')),H(path.join(repo,'third_party/hwm14/hwm14_data.cpp')),
  H(path.join(repo,'third_party/nrlmsise00/nrlmsise-00.c')),H(path.join(repo,'third_party/nrlmsise00/nrlmsise-00_data.c')),
  H(path.join(hpop,'src/cpp/src/prw_execution.cpp')),H(erfaUnit),
  H(path.join(repo,'analysis/estimation/src/batch_fit.cpp')),H(path.join(repo,'analysis/estimation/src/estimation.cpp')),
  H(path.join(root,'src/hpop_fit.cpp')),H(path.join(root,'src/time_frames.cpp')),H(path.join(root,'src/residual_stats.cpp')),
  ...['meme_parser','oem_parser','oem_fb_reader','frame_transform','sgp4_fitter','omm_fb_builder','obd_fb_builder'].map(n=>O(path.join(od,`src/${n}.cpp`))),
  O(path.join(od,'deps/vallado-sgp4/SGP4.cpp')),
  {path:path.join(root,'src/support/errno_weak.c'),includes:[],defines:{}},
  O(path.join(root,'src/ephemeris_input.cpp')),O(path.join(root,'src/operator_fit.cpp')),O(path.join(root,'src/products.cpp')),
];
const glueIncludes=[...odIncludes,path.join(hpop,'src/cpp/include')];
const config={clangxx:path.join(emsdk,'upstream/bin/clang++'),linker:path.join(emsdk,'upstream/bin/wasm-ld'),units,glueIncludes,exceptionLibraries};
const configPath=path.join(buildDir,'compiler.json');await fs.writeFile(configPath,JSON.stringify(config,null,2));
process.env.OD_HPOP_BUILD_CONFIG=configPath;
process.env.SDN_WASI_CLANGXX=path.join(root,'build-driver.mjs');
process.env.SDN_WASI_CLANG=process.env.SDN_WASI_CLANGXX;
await fs.chmod(process.env.SDN_WASI_CLANGXX,0o755);

const outputPath=path.join(root,'dist/isomorphic/module.wasm');await fs.mkdir(path.dirname(outputPath),{recursive:true});
let result;
try{
  result=await compileModuleFromSource({manifest,sourceCode:`#include ${JSON.stringify(path.join(root,'src/module_entry.cpp'))}\n`,language:'c++',outputPath,threadModel:'wasi-sequential',stackSize:2*1024*1024});
  if(!result.report?.ok)throw new Error(JSON.stringify(result.report?.issues));
  const bytes=await fs.readFile(outputPath);
  const sdkRoot=path.resolve(path.dirname(fileURLToPath(import.meta.resolve('space-data-module-sdk/compiler'))),'../..');
  await fs.writeFile(path.join(root,'dist/plugin-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  await fs.writeFile(path.join(root,'dist/build-provenance.json'),JSON.stringify({
    sdk:JSON.parse(fsSync.readFileSync(path.join(sdkRoot,'package.json'),'utf8')).version,
    threadModel:result.threadModel,target:'wasm32-wasip1-threads',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,
    clangVersion:execFileSync(config.clangxx,['--version'],{encoding:'utf8'}).trim().split('\n')[0],
    exceptionRuntimeArchives:exceptionLibraries.map(p=>({name:path.basename(p),sha256:createHash('sha256').update(fsSync.readFileSync(p)).digest('hex')})),
    units:units.map(u=>path.relative(repo,u.path)).map(p=>p.startsWith('analysis/od/hpop-fit/.sdk-build')?'erfa-amalgamation (foundation/frames/erfa-amalgamation.mjs)':p),
    linked:{'propagator/hpop':hpopManifest.version,'analysis/estimation':JSON.parse(fsSync.readFileSync(path.join(repo,'analysis/estimation/package.json'),'utf8')).version},
  },null,2)+'\n');
  console.log(`Built ${bytes.length} bytes sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
}finally{if(result)await cleanupCompilation(result);}
