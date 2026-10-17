// Replay all 72 reference cases at three settings through authenticated
// same-version allocation builds. No response normalization or JS physics.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const ffm=fileURLToPath(new URL('../../../',import.meta.url));
const root=path.resolve(ffm,'../..');
const require=createRequire(path.join(ffm,'package.json'));
const {createBrowserModuleHarness}=await import(pathToFileURL(require.resolve('space-data-module-sdk/testing')));
const {encodePluginInvokeRequest,decodePluginInvokeResponse}=await import(pathToFileURL(require.resolve('space-data-module-sdk/invoke')));
const {REFERENCE,requestInputs}=await import(pathToFileURL(path.join(ffm,'tests/lib/orekitCases.mjs')));
const sha=b=>createHash('sha256').update(b).digest('hex');
const base=JSON.parse(fs.readFileSync(path.join(ffm,'tests/gravity-scratch-alloc/base.json')));
const before=fs.readFileSync(path.join(ffm,'tests/gravity-scratch-alloc/before-1.4.1.wasm'));
const after=fs.readFileSync(path.join(ffm,'dist/isomorphic/module.wasm'));
const git=(file)=>execFileSync('git',['show',`${base.commit}:${file}`],{cwd:root,maxBuffer:64<<20,env:{...process.env,GIT_NO_LAZY_FETCH:'1'}});
assert.equal(sha(git(base.wasm)),base.sha256);
assert.equal(sha(git(base.sources)),base.sameVersionReference.sourceSha256);
assert.equal(sha(before),base.sameVersionReference.sha256);
assert.equal(sha(after),'e8c7b4f59d54a1140380105d8463cd037260d4441f29afb74f396f9834ac06c3');
const manifest=JSON.parse(fs.readFileSync(path.join(ffm,'plugin-manifest.json')));
assert.equal(manifest.version,'1.4.1');
assert.equal(REFERENCE.cases.length,72);
const modules=await Promise.all([before,after].map(b=>WebAssembly.compile(b)));
const result={baseCommit:base.commit,originalModuleSha256:base.sha256,sourceSha256:base.sameVersionReference.sourceSha256,generatorSha256:sha(fs.readFileSync(fileURLToPath(import.meta.url))),moduleVersion:manifest.version,beforeSha256:sha(before),afterSha256:sha(after),reference:'Pinned same-version pre-allocation source build; see allocation E2E provenance',toleranceBytes:0,caseCount:72,rows:[],ok:false};
const output=process.argv[2]??fileURLToPath(new URL('./equivalence.json',import.meta.url));
try {
 for (const setting of [{id:'suite',maxStep:300},{id:'steps30',maxStep:30},{id:'finest',maxStep:10,tolerance:1e-15}]) {
  for (const c of REFERENCE.cases) {
   const bytes=encodePluginInvokeRequest({methodId:'invoke',inputs:requestInputs(c,setting)});
   const responses=[];
   for(const wasmSource of modules) {
    const h=await createBrowserModuleHarness({wasmSource,manifest,surface:'direct'});
    try {
     const raw=Buffer.from(await h.invokeRaw(bytes));
     const response=decodePluginInvokeResponse(raw);
     assert.equal(response.statusCode,0,`${c.orbit} ${c.forces}: ${response.errorMessage}`);
     assert.ok(response.outputs.length>0);
     responses.push(raw);
    } finally {await h.destroy();}
   }
   assert.ok(responses[0].equals(responses[1]),`${c.orbit} ${c.forces} ${setting.id}: raw response differs`);
   const row={id:`${c.orbit} ${c.forces}`,setting:setting.id,bytes:responses[0].length,sha256:sha(responses[0])};
   result.rows.push(row);console.log(JSON.stringify(row));
  }
 }
 result.ok=true;
} catch(error) {result.error=String(error.stack??error);process.exitCode=1;}
finally {fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({ok:result.ok,comparisons:result.rows.length,bytes:result.rows.reduce((n,r)=>n+r.bytes,0),error:result.error}));}
