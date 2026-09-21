// Multi-translation-unit OD build through the public SDK toolchain and codecs.
// Keep the existing, validated PIV bridge: the historical threaded batch entry
// point is a different ABI and must never overwrite this artifact.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolveWasiThreadsToolchain,getFlatbuffersCppRuntimeHeaders,getInvokeCppSchemaHeaders,assertSequentialArtifact} from 'space-data-module-sdk/compiler';
import {encodePluginManifest} from 'space-data-module-sdk/manifest';
import {appendWasmCustomSection,SDS_MANIFEST_SECTION_NAME} from 'space-data-module-sdk/bundle';
import {validatePluginArtifact} from 'space-data-module-sdk/compliance';
const root=fileURLToPath(new URL('.',import.meta.url)),cpp=path.join(root,'src/cpp');
const out=path.resolve(process.argv[2]??path.join(root,'dist/isomorphic/module.unsigned.wasm'));
const manifest=JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json')));
const toolchain=resolveWasiThreadsToolchain();
if(toolchain.target!=='wasm32-wasip1-threads')throw new Error('OD requires the canonical WASI target');
const build=await fs.mkdtemp(path.join(os.tmpdir(),'sdn-od-wasi-'));
const eigen=process.env.SDN_OD_EIGEN_DIR;
if(!eigen)throw new Error('Set SDN_OD_EIGEN_DIR to the Eigen headers directory');
try {
 for(const [name,content] of Object.entries({...await getFlatbuffersCppRuntimeHeaders(),...await getInvokeCppSchemaHeaders()})){
  const p=path.join(build,name);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,content);
 }
 const manifestBytes=encodePluginManifest(manifest);
 await fs.writeFile(path.join(build,'plugin_manifest_bytes.h'),`#include <stdint.h>\nstatic const uint8_t od_plugin_manifest_bytes[]={${[...manifestBytes].join(',')}};\nstatic const uint32_t od_plugin_manifest_bytes_len=${manifestBytes.length};\n`);
 const sources=['meme_parser','frame_transform','oem_parser','oem_fb_reader','omm_fb_builder','obd_fb_builder','ocm_fb_builder','sgp4_fitter','plugin_runtime','plugin_entrypoints','plugin_invoke_bridge','noexcept_stubs'].map(x=>path.join(cpp,'src',x+'.cpp'));
 sources.push(path.join(cpp,'deps/vallado-sgp4/SGP4.cpp'));
 const executable=path.join(build,'module.wasm');
 const exports=['_start','_initialize','plugin_alloc','plugin_free','plugin_invoke_stream','plugin_get_manifest_flatbuffer','plugin_get_manifest_flatbuffer_size','fit'];
 const args=[...toolchain.toolchainArgs,'-std=c++17','-O3','-ffast-math','-mbulk-memory','-fignore-exceptions','-DNDEBUG','-DEIGEN_DONT_PARALLELIZE','-DOD_REACTOR_BUILD',
  '-I'+build,'-I'+path.join(cpp,'include'),'-I'+path.join(cpp,'generated'),'-I'+path.join(cpp,'deps/vallado-sgp4'),'-I'+eigen,'-I'+path.resolve(root,'../../licensing/core/src/cpp/generated/sds'),
  ...sources,'-mexec-model=reactor','-Wl,--initial-memory=67108864','-Wl,--max-memory=2147483648','-Wl,-z,stack-size=2097152',...exports.map(x=>'-Wl,--export='+x),'-o',executable];
 const result=spawnSync(toolchain.clangxx,args,{encoding:'utf8',timeout:180000});
 if(result.status!==0)throw new Error(result.error?.message??result.stderr);
 let bytes=new Uint8Array(await fs.readFile(executable));
 bytes=appendWasmCustomSection(bytes,SDS_MANIFEST_SECTION_NAME,manifestBytes);
 assertSequentialArtifact(bytes,{source:executable});
 const report=await validatePluginArtifact({manifest,wasmBytes:bytes});
 if(!report.ok)throw new Error(JSON.stringify(report.issues,null,2));
 await fs.mkdir(path.dirname(out),{recursive:true});await fs.writeFile(out,bytes);
 console.log(JSON.stringify({output:out,sha256:createHash('sha256').update(bytes).digest('hex'),threadModel:manifest.threadModel,compiler:toolchain.describe(),bytes:bytes.length}));
} finally {await fs.rm(build,{recursive:true,force:true});}
