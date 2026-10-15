// Build the portable core and the scheduled host adapter of ephemeris-source (typed contracts 1.0: FlatBuffers only).
// One translation unit each: the runtime types (TimerTick, HttpRequest, HttpResponse, ModuleConfig) and, for the
// adapter, typedHostcall.hpp (sdm_piv) staged by the SDK compiler; the SDS headers inlined (IDM PLD LCC CAT NCD IRM CCT
// STF ICN SRG); the repository's JSON library and SHA-256 (internal only); the provider registry compiled in.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileModuleFromSource} from 'space-data-module-sdk/compiler';
import {readSdsHeader,publishedStandardsRoot} from '../terrain-source/sds-headers.mjs';
const root=fileURLToPath(new URL('.',import.meta.url));
// SRG (the data source registry) is newer than the published package: SPACE_DATA_STANDARDS_ROOT names the checkout.
process.env.SPACE_DATA_STANDARDS_ROOT??=publishedStandardsRoot(import.meta.url);
const codes=['IDM','PLD','LCC','CAT','NCD','IRM','CCT','STF','ICN','SRG'];
const sds=[];
for(const code of codes)sds.push((await readSdsHeader(code,import.meta.url))
  .replace(/^#include "(?:\.\.\/)?(?:[A-Z]{3}\/)?main_generated.h"\s*$/gm,'')
  .replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/,'')
  .replaceAll('FLATBUFFERS_GENERATED_MAIN_H_',`EPHEMERIS_GENERATED_${code}_H_`));
const json=await fs.readFile(path.resolve(root,'../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp'),'utf8');
const sha=await fs.readFile(path.resolve(root,'../../files/orbit-products/src/sha256.hpp'),'utf8');
const registry=JSON.stringify(JSON.parse(await fs.readFile(path.join(root,'sources.json'),'utf8')));
const own=await Promise.all(['src/discovery.hpp','src/ephemeris_source.cpp'].map((file)=>fs.readFile(path.join(root,file),'utf8')));
for (const adapter of [false,true]) {
  const target=adapter?path.join(root,'host-adapter'):root;
  const manifest=JSON.parse(await fs.readFile(path.join(target,'plugin-manifest.json'),'utf8'));
  const head=`${adapter?'#define EPHEMERIS_HOST_ADAPTER\n':''}#include "space_data_module_invoke.h"
#include <HttpRequest_generated.h>
#include <HttpResponse_generated.h>
${adapter?'#include <typedHostcall.hpp>\n':''}[[noreturn]] void ephemeris_failure(const char* message) { plugin_set_error("ephemeris-retrieval-failed",message); __builtin_trap(); }
#define JSON_THROW_USER(exception) ephemeris_failure("Invalid JSON value shape.")
`;
  const sourceCode=[head,json,sha,...sds,`const char* EPHEMERIS_REGISTRY=R"registry(${registry})registry";`,...own].join('\n');
  const outputPath=path.join(target,'dist/isomorphic/module.wasm');await fs.mkdir(path.dirname(outputPath),{recursive:true});
  let result;
  try {result=await compileModuleFromSource({manifest,sourceCode,language:'c++',outputPath,threadModel:'wasi-sequential',allowUndefinedImports:true});}
  catch(error){console.error(error.report?.errors??error.message);process.exit(1);}
  if(!result.report?.ok)throw new Error(JSON.stringify(result.report?.issues));
  const guest=path.join(target,'dist/guest-link');await fs.mkdir(guest,{recursive:true});await fs.writeFile(path.join(guest,'module-link.o'),result.guestLink.objectBytes);
  const {format,language,threadModel,symbolPrefix,methodSymbols}=result.guestLink;
  await fs.writeFile(path.join(guest,'metadata.json'),JSON.stringify({version:1,format,language,threadModel,symbolPrefix,methodSymbols},null,2)+'\n');
  console.log(`Built ${outputPath}`);
}
