import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {compileModuleFromSource,cleanupCompilation} from 'space-data-module-sdk/compiler';
import {generateSdsBindings,packageRoot,standardsRoot} from './generate-sds-bindings.mjs';

const manifest=JSON.parse(await fs.readFile(path.join(packageRoot,'plugin-manifest.json'),'utf8'));
await generateSdsBindings();
// Repo-local toolchain only. The common checkout's existing deps may be read
// from a private worktree; compiler outputs and caches remain in this worktree.
const common=execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{cwd:packageRoot,encoding:'utf8'}).trim();
let configuredWorktree='';try{configuredWorktree=execFileSync('git',['config','--get','core.worktree'],{cwd:packageRoot,encoding:'utf8'}).trim();}catch{}
const originalRoot=configuredWorktree?path.resolve(common,configuredWorktree):path.dirname(common);
const candidates=[process.env.SDN_LOCAL_EMSDK_DIR,path.join(packageRoot,'deps/emsdk'),path.join(originalRoot,'propagator/hpop/deps/emsdk')].filter(Boolean);
const emsdk=candidates.find(p=>fsSync.existsSync(path.join(p,'upstream/bin/clang++')));
if(!emsdk)throw new Error('A repo-local emsdk LLVM toolchain is required; set SDN_LOCAL_EMSDK_DIR. This build never invokes emcc.');
const libDir=path.join(emsdk,'upstream/emscripten/cache/sysroot/lib/wasm32-emscripten/lto');
const exceptionLibraries=['libc++abi-ww-wasmexcept.a','libunwind-ww-wasmexcept.a'].map(n=>path.join(libDir,n));
for(const file of exceptionLibraries)if(!fsSync.existsSync(file))throw new Error(`Missing LLVM standard Wasm EH runtime archive ${file}`);
const units=['astrodynamics','integrators','variational','finite_burn','force_partials','coords','atmosphere_plugin','environment_models','ephemeris','force_models','atmosphere_winds','nrlmsise00','time_convert','us76'].map(n=>path.join(packageRoot,`lib/${n}.cpp`));
units.push(path.join(packageRoot,'../../third_party/hwm14/hwm14.cpp'),path.join(packageRoot,'../../third_party/hwm14/hwm14_data.cpp'),path.join(packageRoot,'../../third_party/nrlmsise00/nrlmsise-00.c'),path.join(packageRoot,'../../third_party/nrlmsise00/nrlmsise-00_data.c'),path.join(packageRoot,'src/hpop_plugin.cpp'),path.join(packageRoot,'src/cpp/src/prw_execution.cpp'));
const pluginSource=await fs.readFile(path.join(packageRoot,'src/hpop_plugin.cpp'),'utf8');
const diagnosticExports=[...new Set([...pluginSource.matchAll(/^(?:int|void|double|const char\*)\s+((?:plugin_|get_)[A-Za-z0-9_]+)\s*\(/gm)].map(m=>m[1]).filter(n=>n!=='plugin_stream_invoke')),'malloc','free','hpop_initialize','_initialize'];
const buildDir=path.join(packageRoot,'.sdk-build');await fs.mkdir(buildDir,{recursive:true});
const initializationSource=path.join(packageRoot,'src/cpp/src/prw_initialization.cpp');
const config={initializationSource,clangxx:path.join(emsdk,'upstream/bin/clang++'),linker:path.join(emsdk,'upstream/bin/wasm-ld'),units,exceptionLibraries,diagnosticExports,includes:[path.join(packageRoot,'lib'),path.join(packageRoot,'src'),path.join(packageRoot,'src/cpp/include'),path.join(packageRoot,'src/cpp/generated'),path.join(packageRoot,'src/cpp/generated/sds'),path.join(packageRoot,'../../third_party/nrlmsise00'),path.join(packageRoot,'../../third_party/hwm14')]};
const configPath=path.join(buildDir,'compiler.json');await fs.writeFile(configPath,JSON.stringify(config,null,2));
process.env.HPOP_SDK_BUILD_CONFIG=configPath;
process.env.SDN_WASI_CLANGXX=path.join(packageRoot,'build-driver.mjs');
process.env.SDN_WASI_CLANG=process.env.SDN_WASI_CLANGXX;
process.env.SPACE_DATA_STANDARDS_ROOT=standardsRoot;
await fs.chmod(process.env.SDN_WASI_CLANGXX,0o755);
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
  await fs.writeFile(path.join(packageRoot,'dist/build-provenance.json'),JSON.stringify({sdk:'0.8.18',spacedatastandards:'1.220.0',threadModel:result.threadModel,target:'wasm32-wasip1-threads',sharedMemory:true,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,compiler:result.compiler,clangVersion:execFileSync(config.clangxx,['--version'],{encoding:'utf8'}).trim(),exceptionRuntimeArchives:exceptionLibraries.map(p=>({name:path.basename(p),sha256:createHash('sha256').update(fsSync.readFileSync(p)).digest('hex')})),units:['src/cpp/src/prw_sdk_adapter.cpp','src/cpp/src/prw_initialization.cpp',...units.map(p=>path.relative(packageRoot,p))],standardWasmExceptions:true,legacyRuntimeCompiled:false,sdkAccommodation:'Public SDN_WASI_CLANGXX driver compiles multiple source units and supplies LLVM exception ABI archives and the preexisting 256 MiB initial memory, idempotent constructor wrapping and per-instance static-object lifetime; SDK owns PIV, allocation, command framing, manifest embedding and validation.'},null,2)+'\n');
  console.log(`Built ${bytes.length} bytes; canonical SDK artifact validation passed.`);
}finally{if(result)await cleanupCompilation(result);}
