import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {compileModuleFromSource,cleanupCompilation} from 'space-data-module-sdk/compiler';
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('.',import.meta.url));
const sdkRoot=path.resolve(path.dirname(require.resolve('space-data-module-sdk/compiler')),'../..');
const standardsRoot=path.dirname(require.resolve('spacedatastandards.org/package.json'));
const headers=path.join(sdkRoot,'src/generated/http/cpp');
const sourceCode=(await Promise.all([fs.readFile(path.join(headers,'HttpRequestAbi_generated.h'),'utf8'),fs.readFile(path.join(headers,'HttpResponseAbi_generated.h'),'utf8'),fs.readFile(path.join(root,'src/science_http.cpp'),'utf8')])).join('\n').replace(/#include "HttpRequestAbi_generated\.h"\s*\n/g,'');
const manifest=JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json')));
const outputPath=path.join(root,'dist/isomorphic/module.wasm');await fs.mkdir(path.dirname(outputPath),{recursive:true});
const result=await compileModuleFromSource({manifest,sourceCode,language:'c++',outputPath,standardsRoot,threadModel:'wasi-sequential'});
try {if(!result.report?.ok)throw new Error(JSON.stringify(result.report));
  const guestDir = path.join(root, 'dist/guest-link');
  await fs.mkdir(guestDir, {recursive:true});
  await fs.writeFile(path.join(guestDir,'module-link.o'), result.guestLink.objectBytes);
  await fs.writeFile(path.join(guestDir,'metadata.json'), JSON.stringify({
    version:1,format:result.guestLink.format,language:result.guestLink.language,
    threadModel:result.guestLink.threadModel,symbolPrefix:result.guestLink.symbolPrefix,
    methodSymbols:result.guestLink.methodSymbols,capabilities:manifest.capabilities
  },null,2)+'\n');
await fs.writeFile(path.join(root,'dist/plugin-manifest.json'),JSON.stringify(manifest,null,2)+'\n');}finally{await cleanupCompilation(result);}
