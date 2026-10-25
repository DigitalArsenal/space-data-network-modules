import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {compileModuleFromSource, cleanupCompilation} from 'space-data-module-sdk/compiler';
import {generateSdsHeaders} from '../../scripts/lib/sds-cpp-headers.mjs';
import {assertArtifactThreadModel} from '../../scripts/lib/thread-model.mjs';
import {sharedEmsdkRoot} from '../../scripts/lib/emsdk-toolchain.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const modules=path.resolve(root,'../..');
const sdk=path.resolve(path.dirname(createRequire(import.meta.url).resolve('space-data-module-sdk')),'..');
// Existing repo-local toolchains only. Never bootstrap, download, or use PATH compilers.
const candidates=[path.join(root,'deps/emsdk'),path.join(modules,'deps/emsdk'),
  path.join(modules,'analysis/conjunction-assessment/deps/emsdk'),
  path.resolve(sdk,'../../main-packages/space-data-network-modules/analysis/conjunction-assessment/deps/emsdk'),
  sharedEmsdkRoot()];
let emsdk;
for (const candidate of candidates) {
  try {await fs.access(path.join(candidate,'emsdk_env.sh'));await fs.access(path.join(candidate,'upstream/bin/clang++'));emsdk=candidate;break;} catch {}
}
if (!emsdk) throw new Error('An existing repo-local deps/emsdk with upstream/bin/clang++ is required.');
process.env.SDN_WASI_CLANG=path.join(emsdk,'upstream/bin/clang');
process.env.SDN_WASI_CLANGXX=path.join(emsdk,'upstream/bin/clang++');
const scratch=path.join(root,'.build');await fs.mkdir(scratch,{recursive:true});process.env.TMPDIR=scratch;
const manifest=JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json'),'utf8'));
const sdkPackage=path.join(sdk,'package.json');
const createFlatc=createRequire(sdkPackage)('flatc-wasm/module');
const {header}=await generateSdsHeaders(['PCE'],pathToFileURL(sdkPackage),createFlatc);
const sources=await Promise.all(['reference_points.hpp','reference_points_module.cpp'].map(async name =>
  (await fs.readFile(path.join(root,'src',name),'utf8')).replace(/^#pragma once\s*$/gm,'').replace(/^#include "[^"]+"\s*$/gm,'')));
const outputPath=path.join(root,'dist/isomorphic/module.wasm');await fs.mkdir(path.dirname(outputPath),{recursive:true});
const result=await compileModuleFromSource({manifest,sourceCode:['#include "space_data_module_invoke.h"',header,...sources].join('\n'),language:'c++',outputPath,threadModel:manifest.threadModel});
try {
  if (!result.report?.ok) throw new Error((result.report?.issues??[]).map(issue=>issue.message??String(issue)).join('\n'));
  assertArtifactThreadModel(outputPath,'wasi-sequential');
  await fs.copyFile(path.join(root,'plugin-manifest.json'),path.join(root,'dist/plugin-manifest.json'));
  console.log(`Built dist/isomorphic/module.wasm (${(await fs.stat(outputPath)).size} bytes, ${result.compiler}, ${result.threadModel})`);
  console.log('SDK validation PASS; sequential pure transform; no thread spawning');
} finally {await cleanupCompilation(result);}
