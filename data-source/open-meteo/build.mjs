import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { readSdsHeader } from '../terrain-source/sds-headers.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const require=createRequire(import.meta.url);
const standards=process.env.SPACE_DATA_STANDARDS_ROOT
  ? path.resolve(process.env.SPACE_DATA_STANDARDS_ROOT)
  : path.dirname(require.resolve('spacedatastandards.org/package.json'));
const schema=await fs.readFile(path.join(standards,'schema/WXF/main.fbs'),'utf8');
if (!schema.includes('TIME_BASIS: wxfTimeBasis') || !schema.includes('OpenAttribution')) {
  throw new Error('Open-Meteo requires the canonical WXF open-licence/valid-time contract. The pinned SDS release does not provide it; do not substitute a forecast initialization time or licence.');
}
process.env.SPACE_DATA_STANDARDS_ROOT=standards;
const header=await readSdsHeader('WXF',import.meta.url);
const json=await fs.readFile(path.resolve(root,'../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp'),'utf8');
const sha=await fs.readFile(path.resolve(root,'../../files/orbit-products/src/sha256.hpp'),'utf8');
const source=await fs.readFile(path.join(root,'src/open_meteo.cpp'),'utf8');
const manifest=JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json'),'utf8'));
const outputPath=path.join(root,'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath),{recursive:true});
const result=await compileModuleFromSource({manifest,sourceCode:`${header}\n${json}\n${sha}\n${source}`,language:'c++',outputPath,threadModel:'wasi-sequential'});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
console.log(`Built ${outputPath}`);

const guest=path.join(root,'dist/guest-link');
await fs.mkdir(guest,{recursive:true});
await fs.writeFile(path.join(guest,'module-link.o'),result.guestLink.objectBytes);
const {format,language,threadModel,symbolPrefix,methodSymbols}=result.guestLink;
await fs.writeFile(path.join(guest,'metadata.json'),JSON.stringify({version:1,format,language,threadModel,symbolPrefix,methodSymbols},null,2)+'\n');
