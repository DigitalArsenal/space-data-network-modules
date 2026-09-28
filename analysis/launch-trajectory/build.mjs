import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { generateSdsHeader } from './sds-header.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const {header,version}=await generateSdsHeader('LAM',import.meta.url);
if (!header.includes('struct lamInsertionOrbit ')) {
  throw new Error(`spacedatastandards.org@${version} has no LAM insertion orbit; launch trajectory needs 1.228.0 or later.`);
}
const json=await fs.readFile(path.resolve(root,'../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp'),'utf8');
const source=await fs.readFile(path.join(root,'src/launch_trajectory.cpp'),'utf8');
const manifest=JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json'),'utf8'));
const outputPath=path.join(root,'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath),{recursive:true});
const result=await compileModuleFromSource({manifest,sourceCode:`${header}\n${json}\n${source}`,language:'c++',outputPath,threadModel:'single-thread'});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
await fs.copyFile(path.join(root,'plugin-manifest.json'),path.join(root,'dist/plugin-manifest.json'));
await fs.writeFile(path.join(root,'dist/build-provenance.json'),`${JSON.stringify({spacedatastandards:version,schema:'LAM',threadModel:'single-thread'},null,2)}\n`);
console.log(`Built ${outputPath} against spacedatastandards.org@${version}`);
