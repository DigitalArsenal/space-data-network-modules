import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { generateSdsHeader } from '../../analysis/launch-cola/sds-header.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const {header,version}=await generateSdsHeader('LDM',import.meta.url);
if (!/add_ID\(/.test(header.slice(header.indexOf('struct LDMBuilder')))) {
  throw new Error(`spacedatastandards.org@${version} has no LDM.ID; launch notices need 1.227.0 or later.`);
}
const json=await fs.readFile(path.resolve(root,'../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp'),'utf8');
const sha=await fs.readFile(path.resolve(root,'../../files/orbit-products/src/sha256.hpp'),'utf8');
const source=await fs.readFile(path.join(root,'src/launch_schedule.cpp'),'utf8');
const manifest=JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json'),'utf8'));
const outputPath=path.join(root,'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath),{recursive:true});
const result=await compileModuleFromSource({manifest,sourceCode:`${header}\n${json}\n${sha}\n${source}`,language:'c++',outputPath,threadModel:'wasi-sequential'});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
const guest=path.join(root,'dist/guest-link');
await fs.mkdir(guest,{recursive:true});
await fs.writeFile(path.join(guest,'module-link.o'),result.guestLink.objectBytes);
const {format,language,threadModel,symbolPrefix,methodSymbols}=result.guestLink;
await fs.writeFile(path.join(guest,'metadata.json'),JSON.stringify({version:1,format,language,threadModel,symbolPrefix,methodSymbols},null,2)+'\n');
await fs.copyFile(path.join(root,'plugin-manifest.json'),path.join(root,'dist/plugin-manifest.json'));
await fs.writeFile(path.join(root,'dist/build-provenance.json'),`${JSON.stringify({spacedatastandards:version,schema:'LDM',threadModel:'wasi-sequential'},null,2)}\n`);
console.log(`Built ${outputPath} against spacedatastandards.org@${version}`);
