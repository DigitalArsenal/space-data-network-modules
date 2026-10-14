import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileModuleFromSource} from 'space-data-module-sdk/compiler';
const root=fileURLToPath(new URL('.',import.meta.url));
// The spacedatastandards.org checkout (SPACE_DATA_STANDARDS_ROOT wins; default the sibling checkout).
process.env.SPACE_DATA_STANDARDS_ROOT??=fileURLToPath(new URL('../../../spacedatastandards.org/',import.meta.url));
// The runtime types (TimerTick, HttpRequest, ...) are staged by the SDK compiler; the SDS standards are not, so each
// one's generated header (lib/cpp/<CODE>/main_generated.h) is inlined in place of `#include "<CODE>_generated.h"`, its
// include guard renamed (every SDS header is "main_generated.h") and its flatc version static_assert relaxed.
export async function inlineStandards(source,codes){
 for(const code of codes){
  const header=(await fs.readFile(path.join(process.env.SPACE_DATA_STANDARDS_ROOT,'lib','cpp',code,'main_generated.h'),'utf8'))
   .replaceAll('FLATBUFFERS_GENERATED_MAIN_H_',`FLATBUFFERS_GENERATED_SDS_${code}_MAIN_H_`)
   .replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/,'')
   .replace(/#include "main_generated\.h"\n/g,'');
  source=source.replace(new RegExp(`^#include "${code}_generated\\.h".*$`,'m'),()=>header);
 }
 return source;
}
export async function build(root,pieces,codes){
 const manifest=JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json'),'utf8'));
 const sourceCode=await inlineStandards(pieces.join('\n'),codes);
 const outputPath=path.join(root,'dist/isomorphic/module.wasm');
 await fs.rm(path.join(root,'dist'),{recursive:true,force:true});
 await fs.mkdir(path.dirname(outputPath),{recursive:true});
 // Single thread: one invocation's frames, nothing spawned or shared.
 const result=await compileModuleFromSource({manifest,sourceCode,language:'c++',outputPath,threadModel:'single-thread'});
 if(!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
 const guest=path.join(root,'dist/guest-link');await fs.mkdir(guest,{recursive:true});
 await fs.writeFile(path.join(guest,'module-link.o'),result.guestLink.objectBytes);
 const {format,language,threadModel,symbolPrefix,methodSymbols}=result.guestLink;
 await fs.writeFile(path.join(guest,'metadata.json'),JSON.stringify({version:1,format,language,threadModel,symbolPrefix,methodSymbols},null,2)+'\n');
 await fs.copyFile(path.join(root,'plugin-manifest.json'),path.join(root,'dist/plugin-manifest.json'));
 console.log(`PASS SDK build ${manifest.pluginId} -> dist/isomorphic/module.wasm`);
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 await build(root,[await fs.readFile(path.join(root,'src/eop_wire.hpp'),'utf8'),await fs.readFile(path.join(root,'src/module.cpp'),'utf8')],['ICN']);
}
