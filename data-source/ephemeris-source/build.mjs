import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {compileModuleFromSource} from 'space-data-module-sdk/compiler';
import {readSdsHeader,publishedStandardsRoot} from '../terrain-source/sds-headers.mjs';
const root=fileURLToPath(new URL('.',import.meta.url));
const require=createRequire(import.meta.url);
const sdk=path.resolve(path.dirname(require.resolve('space-data-module-sdk')),'..');
process.env.SPACE_DATA_STANDARDS_ROOT=publishedStandardsRoot(import.meta.url);
const pieces=[`#include "space_data_module_invoke.h"
[[noreturn]] void ephemeris_failure(const char* message) { plugin_set_error("ephemeris-retrieval-failed",message); __builtin_trap(); }
#define JSON_THROW_USER(exception) ephemeris_failure("Invalid JSON value shape.")
`];
for(const code of ['NCD','IRM'])pieces.push((await readSdsHeader(code,import.meta.url)).replaceAll('FLATBUFFERS_GENERATED_MAIN_H_',`EPHEMERIS_GENERATED_${code}_H_`));
for(const file of ['../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp','../../files/orbit-products/src/sha256.hpp','../../common/sdm_hostcall_wire.hpp'])pieces.push(await fs.readFile(path.resolve(root,file),'utf8'));
pieces.push(await fs.readFile(path.join(sdk,'src/host/cpp/keyslotClient.hpp'),'utf8'));
const registry=JSON.stringify(JSON.parse(await fs.readFile(path.join(root,'sources.json'),'utf8')));
pieces.push(`const char* EPHEMERIS_REGISTRY=R"registry(${registry})registry";`);
for(const file of ['src/discovery.hpp','src/ephemeris_source.cpp'])pieces.push(await fs.readFile(path.join(root,file),'utf8'));
for (const adapter of [false,true]) {
const target=adapter?path.join(root,'host-adapter'):root;
const manifest=JSON.parse(await fs.readFile(path.join(target,'plugin-manifest.json'),'utf8'));
const outputPath=path.join(target,'dist/isomorphic/module.wasm');await fs.mkdir(path.dirname(outputPath),{recursive:true});
let result;
try {result=await compileModuleFromSource({manifest,sourceCode:(adapter?'#define EPHEMERIS_HOST_ADAPTER\n':'')+pieces.join('\n'),language:'c++',outputPath,threadModel:'wasi-sequential',allowUndefinedImports:true});}
catch(error){console.error(error.report?.errors??error.message);process.exit(1);}
if(!result.report?.ok)throw new Error(JSON.stringify(result.report?.issues));
const guest=path.join(target,'dist/guest-link');await fs.mkdir(guest,{recursive:true});await fs.writeFile(path.join(guest,'module-link.o'),result.guestLink.objectBytes);
const {format,language,threadModel,symbolPrefix,methodSymbols}=result.guestLink;
await fs.writeFile(path.join(guest,'metadata.json'),JSON.stringify({version:1,format,language,threadModel,symbolPrefix,methodSymbols},null,2)+'\n');
console.log(`Built ${outputPath}`);
}
