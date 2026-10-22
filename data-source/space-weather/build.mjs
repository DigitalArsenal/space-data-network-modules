import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { generateSdsHeader } from '../lowell-astorb/sds-header.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const {header,version}=await generateSdsHeader('SPW',import.meta.url);
// nlohmann/json parses the UPSTREAM registry body (a foreign wire format); nothing module-to-module is JSON. The
// module-sdk runtime types and typedHostcall.hpp (plan_launches' plugin.getConfig) are staged by the SDK compiler.
const json=await fs.readFile(path.resolve(root,'../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp'),'utf8');
const sha=await fs.readFile(path.resolve(root,'../../files/orbit-products/src/sha256.hpp'),'utf8');
const source=await fs.readFile(path.join(root,'src/space_weather.cpp'),'utf8');
const manifest=JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json'),'utf8'));
const outputPath=path.join(root,'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath),{recursive:true});
// The flow compiler consumes this SDK result directly; no JSON guest-link
// sidecar is needed between the two compiler APIs.
export const compilation=await compileModuleFromSource({manifest,sourceCode:`${header}\n${json}\n${sha}\n${source}`,language:'c++',outputPath,threadModel:'wasi-sequential',allowUndefinedImports:true});
if (!compilation.report?.ok) throw new Error('Space-weather artifact validation failed', {cause:compilation.report?.issues});
await fs.copyFile(path.join(root,'plugin-manifest.json'),path.join(root,'dist/plugin-manifest.json'));
await fs.writeFile(path.join(root,'dist/build-provenance.txt'),`spacedatastandards.org=${version}\nschema=SPW\nthreadModel=wasi-sequential\n`);
console.log(`Built ${outputPath} against spacedatastandards.org@${version}`);
