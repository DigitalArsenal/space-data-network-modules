import fs from 'node:fs/promises';
import {inspect} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileModuleFromSource} from 'space-data-module-sdk/compiler';
import {generateSdsHeaders} from '../../scripts/lib/sds-cpp-headers.mjs';
const root=fileURLToPath(new URL('.',import.meta.url));
const manifest=JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json'),'utf8'));
// QRP, OMM and PNV with every family they include (OMM pulls PVN, CVR, RFM, ...), generated once and inlined.
const {header}=await generateSdsHeaders(['QRP','OMM','PNV'],import.meta.url);
const sourceCode=(await fs.readFile(path.join(root,'src/module.cpp'),'utf8'))
 .replace(/^#include "sds_generated\.h".*$/m,()=>header.replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/g,''));
const outputPath=path.join(root,'dist/isomorphic/module.wasm');
await fs.rm(path.join(root,'dist'),{recursive:true,force:true});
await fs.mkdir(path.dirname(outputPath),{recursive:true});
// Single thread: one invocation's frames, nothing spawned or shared.
const result=await compileModuleFromSource({manifest,sourceCode,language:'c++',outputPath,threadModel:'wasi-sequential'});
if(!result.report?.ok) throw new Error(inspect(result.report?.issues,{depth:6}));
const guest=path.join(root,'dist/guest-link');await fs.mkdir(guest,{recursive:true});
await fs.writeFile(path.join(guest,'module-link.o'),result.guestLink.objectBytes);
const {format,language,threadModel,symbolPrefix,methodSymbols}=result.guestLink;
// The flow compiler's guest-link metadata: a flat record of strings plus the method-symbol map, written line by line.
const symbols=Object.entries(methodSymbols).map(([k,v])=>`    "${k}": "${v}"`).join(',\n');
await fs.writeFile(path.join(guest,'metadata.json'),`{\n  "version": 1,\n  "format": "${format}",\n  "language": "${language}",\n  "threadModel": "${threadModel}",\n  "symbolPrefix": "${symbolPrefix}",\n  "methodSymbols": {\n${symbols}\n  }\n}\n`);
await fs.copyFile(path.join(root,'plugin-manifest.json'),path.join(root,'dist/plugin-manifest.json'));
console.log(`PASS SDK build ${manifest.pluginId} -> dist/isomorphic/module.wasm`);
