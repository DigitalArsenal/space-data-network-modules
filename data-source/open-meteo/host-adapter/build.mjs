import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileModuleFromSource} from 'space-data-module-sdk/compiler';
import {readSdsHeader} from '../../terrain-source/sds-headers.mjs';
const root=fileURLToPath(new URL('.',import.meta.url));
const manifest=JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json'),'utf8'));
// The SDS $WXF header (the plan record the response's CONTEXT echoes). No JSON library: nothing here is JSON.
const header=await readSdsHeader('WXF',import.meta.url);
const source=await fs.readFile(path.join(root,'src/adapter.cpp'),'utf8');
const outputPath=path.join(root,'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath),{recursive:true});
const result=await compileModuleFromSource({manifest,sourceCode:`${header}\n${source}`,language:'c++',outputPath,threadModel:'wasi-sequential',allowUndefinedImports:true});
if(!result.report?.ok)throw new Error(JSON.stringify(result.report?.issues));
const guest=path.join(root,'dist/guest-link');await fs.mkdir(guest,{recursive:true});
await fs.writeFile(path.join(guest,'module-link.o'),result.guestLink.objectBytes);
const {format,language,threadModel,symbolPrefix,methodSymbols}=result.guestLink;
await fs.writeFile(path.join(guest,'metadata.json'),JSON.stringify({version:1,format,language,threadModel,symbolPrefix,methodSymbols},null,2)+'\n');
console.log(`Built ${outputPath}`);
