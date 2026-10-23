// Multi-translation-unit OD build through the public SDK toolchain and codecs.
// Keep the existing, validated PIV bridge: the historical threaded batch entry
// point is a different ABI and must never overwrite this artifact.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {composeErfaTranslationUnit} from '../../foundation/frames/erfa-amalgamation.mjs';
import {resolveWasiThreadsToolchain,getFlatbuffersCppRuntimeHeaders,getInvokeCppSchemaHeaders,assertSequentialArtifact} from 'space-data-module-sdk/compiler';
import {encodePluginManifest} from 'space-data-module-sdk/manifest';
import {appendWasmCustomSection,SDS_MANIFEST_SECTION_NAME} from 'space-data-module-sdk/bundle';
import {validatePluginArtifact} from 'space-data-module-sdk/compliance';
const root=fileURLToPath(new URL('.',import.meta.url)),cpp=path.join(root,'src/cpp');
const out=path.resolve(process.argv[2]??path.join(root,'dist/isomorphic/module.unsigned.wasm'));
const manifest=JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json')));
const toolchain=resolveWasiThreadsToolchain();
if(toolchain.target!=='wasm32-wasip1-threads')throw new Error('OD requires the canonical WASI target');
const build=path.join(root,'.build-operator');await fs.mkdir(build,{recursive:true});
const eigen=process.env.SDN_OD_EIGEN_DIR;
if(!eigen)throw new Error('Set SDN_OD_EIGEN_DIR to the Eigen headers directory');
try {
 for(const [name,content] of Object.entries({...await getFlatbuffersCppRuntimeHeaders(),...await getInvokeCppSchemaHeaders()})){
  const p=path.join(build,name);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,content);
 }
 const manifestBytes=encodePluginManifest(manifest);
 await fs.writeFile(path.join(build,'plugin_manifest_bytes.h'),`#include <stdint.h>\nstatic const uint8_t od_plugin_manifest_bytes[]={${[...manifestBytes].join(',')}};\nstatic const uint32_t od_plugin_manifest_bytes_len=${manifestBytes.length};\n`);
 const sources=['meme_parser','frame_transform','oem_parser','oem_fb_reader','omm_fb_builder','obd_fb_builder','ocm_fb_builder','sgp4_fitter','plugin_runtime','plugin_entrypoints','plugin_invoke_bridge','operator_fit','operator_records','operator_mnv','noexcept_stubs'].map(x=>path.join(cpp,'src',x+'.cpp'));
 sources.push(path.join(cpp,'deps/vallado-sgp4/SGP4.cpp'));
 const modules=path.resolve(root,'../..'),ffm=path.join(modules,'propagator/ffm');
 const ffmUnits=['astrodynamics','integrators','variational','finite_burn','force_partials','coords','atmosphere_plugin','environment_models','ephemeris','force_models','atmosphere_winds','nrlmsise00','time_convert','us76','ffm_gravity'];
 sources.push(...ffmUnits.map(n=>path.join(ffm,'lib',n+'.cpp')));
 sources.push(...['prw_dynamics','resident_dynamics','kernel_store'].map(n=>path.join(ffm,'src/cpp/src',n+'.cpp')));
 sources.push(...['hwm14/hwm14.cpp','hwm14/hwm14_data.cpp','nrlmsise00/nrlmsise-00.c','nrlmsise00/nrlmsise-00_data.c'].map(n=>path.join(modules,'third_party',n)));
 const erfa=path.join(build,'erfa.cpp');await fs.writeFile(erfa,(await composeErfaTranslationUnit()).source);sources.push(erfa);
 const ffmIncludes=['lib','src','src/cpp/include','src/cpp/generated','src/cpp/generated/sds'].map(p=>'-I'+path.join(ffm,p));
 ffmIncludes.push(...['third_party/nrlmsise00','third_party/hwm14','foundation/frames/src','higherpop/third_party/erfa'].map(p=>'-I'+path.join(modules,p)));
 const executable=path.join(build,'module.wasm');
 const exports=['_start','_initialize','plugin_alloc','plugin_free','plugin_invoke_stream','plugin_get_manifest_flatbuffer','plugin_get_manifest_flatbuffer_size','fit','fit_ffm'];
 const common=[...toolchain.toolchainArgs,'-O3','-fno-c++-static-destructors','-msimd128','-mbulk-memory','-DNDEBUG','-DEIGEN_DONT_PARALLELIZE',
  '-I'+build,...ffmIncludes,'-DFFM_MODULE_ID="ffm"','-DFFM_MODULE_VERSION="operator-linked"','-DFFM_TYPED_INPUTS_ONLY=1',
  '-I'+build,'-I'+path.join(cpp,'include'),'-I'+path.join(cpp,'generated'),'-I'+path.join(cpp,'deps/vallado-sgp4'),'-I'+path.resolve(root,'../../common'),'-I'+eigen,'-I'+path.resolve(root,'../../licensing/core/src/cpp/generated/sds')];
 const run=args=>{const r=spawnSync(toolchain.clangxx,args,{encoding:'utf8',timeout:180000});if(r.status!==0)throw new Error(r.error?.message??r.stderr);};
 const objects=[];
 for(const [i,source] of sources.entries()){
  const object=path.join(build,i+'.o');objects.push(object);console.log('compile '+path.relative(modules,source));
  const c=source.endsWith('.c');
  const stamp=createHash('sha256').update(await fs.readFile(source)).update(JSON.stringify(common)).update(await fs.readFile(path.join(build,'plugin_manifest_bytes.h'))).digest('hex');
  if(await fs.readFile(object+'.sha','utf8').catch(()=>null)===stamp)continue;
  run([...common,...(c?['-x','c']:['-std=c++17',source.startsWith(ffm)?'-fno-exceptions':'-fignore-exceptions']),'-DOD_REACTOR_BUILD','-c',source,'-o',object]);await fs.writeFile(object+'.sha',stamp);
 }
 run([...common,...objects,'-mexec-model=reactor','-Wl,--initial-memory=67108864','-Wl,--max-memory=2147483648','-Wl,-z,stack-size=2097152',...exports.map(x=>'-Wl,--export='+x),'-o',executable]);
 let bytes=new Uint8Array(await fs.readFile(executable));
 bytes=appendWasmCustomSection(bytes,SDS_MANIFEST_SECTION_NAME,manifestBytes);
 assertSequentialArtifact(bytes,{source:executable});
 const report=await validatePluginArtifact({manifest,wasmBytes:bytes});
 if(!report.ok)throw new Error(JSON.stringify(report.issues,null,2));
 await fs.mkdir(path.dirname(out),{recursive:true});await fs.writeFile(out,bytes);
 console.log(JSON.stringify({output:out,sha256:createHash('sha256').update(bytes).digest('hex'),threadModel:manifest.threadModel,compiler:toolchain.describe(),bytes:bytes.length}));
} finally { /* One reusable build tree; landing cleanup owns its lifetime. */ }
