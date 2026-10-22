import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {compileModuleFromSource,cleanupCompilation} from 'space-data-module-sdk/compiler';
import {generateSdsBindings,packageRoot,standardsRoot} from './generate-sds-bindings.mjs';
import {composeErfaTranslationUnit} from '../../foundation/frames/erfa-amalgamation.mjs';

const manifest=JSON.parse(await fs.readFile(path.join(packageRoot,'plugin-manifest.json'),'utf8'));
await generateSdsBindings();
await import('./generate-catalog-profile.mjs');
// Explicit provisioned toolchain, or this package's deps. No repository command
// is needed to select a compiler; outputs and caches stay in this worktree.
const candidates=[process.env.SDN_LOCAL_EMSDK_DIR,path.join(packageRoot,'deps/emsdk')].filter(Boolean);
const emsdk=candidates.find(p=>fsSync.existsSync(path.join(p,'upstream/bin/clang++')));
if(!emsdk)throw new Error('A repo-local emsdk LLVM toolchain is required; set SDN_LOCAL_EMSDK_DIR. This build never invokes emcc.');
const libDir=path.join(emsdk,'upstream/emscripten/cache/sysroot/lib/wasm32-emscripten/lto');
const exceptionLibraries=['libc++abi-ww-wasmexcept.a','libunwind-ww-wasmexcept.a'].map(n=>path.join(libDir,n));
for(const file of exceptionLibraries)if(!fsSync.existsSync(file))throw new Error(`Missing LLVM standard Wasm EH runtime archive ${file}`);
const units=['astrodynamics','integrators','variational','finite_burn','force_partials','coords','atmosphere_plugin','environment_models','ephemeris','force_models','atmosphere_winds','nrlmsise00','time_convert','us76'].map(n=>path.join(packageRoot,`lib/${n}.cpp`));
units.push(path.join(packageRoot,'lib/ffm_gravity.cpp'));
units.push(path.join(packageRoot,'../../third_party/hwm14/hwm14.cpp'),path.join(packageRoot,'../../third_party/hwm14/hwm14_data.cpp'),path.join(packageRoot,'../../third_party/nrlmsise00/nrlmsise-00.c'),path.join(packageRoot,'../../third_party/nrlmsise00/nrlmsise-00_data.c'),path.join(packageRoot,'src/ffm_plugin.cpp'),path.join(packageRoot,'src/cpp/src/prw_execution.cpp'),path.join(packageRoot,'src/cpp/src/prw_dynamics.cpp'),path.join(packageRoot,'src/cpp/src/resident_dynamics.cpp'),path.join(packageRoot,'src/cpp/src/kernel_store.cpp'));
// Earth orientation for the earth_orientation input (prw_execution.cpp): the
// vendored ERFA amalgamated exactly as foundation/frames compiles it, so both
// modules evaluate one IAU 2006/2000A chain.
const buildDir=path.join(packageRoot,'.sdk-build');await fs.mkdir(buildDir,{recursive:true});
const erfa=await composeErfaTranslationUnit();
const erfaUnit=path.join(buildDir,'erfa-amalgamation.cpp');await fs.writeFile(erfaUnit,erfa.source);
units.push(erfaUnit);
const pluginSource=await fs.readFile(path.join(packageRoot,'src/ffm_plugin.cpp'),'utf8');
const diagnosticExports=[...new Set([...pluginSource.matchAll(/^(?:int|void|double|const char\*)\s+((?:plugin_|get_)[A-Za-z0-9_]+)\s*\(/gm)].map(m=>m[1]).filter(n=>n!=='plugin_stream_invoke')),'malloc','free','ffm_initialize'];
const sdkRoot=path.resolve(path.dirname(fileURLToPath(import.meta.resolve('space-data-module-sdk/compiler'))),'../..');
const sdkVersion=JSON.parse(fsSync.readFileSync(path.join(sdkRoot,'package.json'),'utf8')).version;
// The PRW VERSION_QUERY answer is the manifest's identity: the same object the
// SDK embeds as $PLG supplies it, so there is no second version string to edit.
const defines={FFM_MODULE_ID:manifest.pluginId,FFM_MODULE_VERSION:manifest.version};
const config={clangxx:path.join(emsdk,'upstream/bin/clang++'),linker:path.join(emsdk,'upstream/bin/wasm-ld'),units,exceptionLibraries,diagnosticExports,defines,includes:[path.join(packageRoot,'lib'),path.join(packageRoot,'src'),path.join(packageRoot,'src/cpp/include'),path.join(packageRoot,'src/cpp/generated'),path.join(packageRoot,'src/cpp/generated/sds'),path.join(packageRoot,'../../third_party/nrlmsise00'),path.join(packageRoot,'../../third_party/hwm14'),path.join(packageRoot,'../../foundation/frames/src'),path.join(packageRoot,'../../higherpop/third_party/erfa')]};
const configPath=path.join(buildDir,'compiler.json');await fs.writeFile(configPath,JSON.stringify(config,null,2));
process.env.FFM_SDK_BUILD_CONFIG=configPath;
process.env.SDN_WASI_CLANGXX=path.join(packageRoot,'build-driver.mjs');
process.env.SDN_WASI_CLANG=process.env.SDN_WASI_CLANGXX;
process.env.SPACE_DATA_STANDARDS_ROOT=standardsRoot;
await fs.chmod(process.env.SDN_WASI_CLANGXX,0o755);
// Importing prepares the canonical multi-unit compiler for another physics
// module. Only the CLI builds the standalone FFM artifact.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const outputPath=path.join(packageRoot,'dist/isomorphic/module.wasm');await fs.mkdir(path.dirname(outputPath),{recursive:true});
let result;
try{
  result=await compileModuleFromSource({manifest,standardsRoot,sourceCode:`#include ${JSON.stringify(path.join(packageRoot,'src/cpp/src/prw_sdk_adapter.cpp'))}\n`,language:'c++',outputPath,threadModel:'wasi-sequential',stackSize:2*1024*1024});
  if(!result.report?.ok)throw new Error(JSON.stringify(result.report?.issues));
  const bytes=await fs.readFile(outputPath);
  await fs.mkdir(path.join(packageRoot,'dist/browser'),{recursive:true});
  await fs.writeFile(path.join(packageRoot,'dist/browser/module.wasm'),bytes);
  await fs.copyFile(path.join(packageRoot,'browser-factory.mjs'),path.join(packageRoot,'dist/browser/module.js'));
  await fs.writeFile(path.join(packageRoot,'dist/plugin-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  await fs.writeFile(path.join(packageRoot,'dist/build-provenance.json'),JSON.stringify({sdk:sdkVersion,spacedatastandards:JSON.parse(fsSync.readFileSync(path.join(packageRoot,'node_modules/spacedatastandards.org/package.json'))).version,threadModel:result.threadModel,target:'wasm32-wasip1-threads',sharedMemory:true,flags:['-msimd128'],sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,compiler:result.compiler,clangVersion:execFileSync(config.clangxx,['--version'],{encoding:'utf8'}).trim(),exceptionRuntimeArchives:exceptionLibraries.map(p=>({name:path.basename(p),flags:['-msimd128'],sha256:createHash('sha256').update(fsSync.readFileSync(p)).digest('hex')})),units:['src/cpp/src/prw_sdk_adapter.cpp',...units.map(p=>path.relative(packageRoot,p))],erfa:{sourceFiles:erfa.fileCount,root:path.relative(packageRoot,path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../higherpop/third_party/erfa'))},standardWasmExceptions:true,legacyRuntimeCompiled:false,debugInfo:'stripped',sdkAccommodation:'Public SDN_WASI_CLANGXX driver compiles multiple source units and supplies LLVM exception ABI archives and 256 MiB initial / 384 MiB maximum memory (100 objects x1 day measured 256 MiB; 1.5x headroom), idempotent constructor wrapping and per-instance static-object lifetime; SDK owns PIV, allocation, command framing, the __wasm_call_ctors direct-surface initializer, manifest embedding and validation.'},null,2)+'\n');
  console.log(`Built ${bytes.length} bytes; canonical SDK artifact validation passed.`);
}finally{if(result)await cleanupCompilation(result);}

}
