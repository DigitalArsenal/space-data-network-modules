#!/usr/bin/env node
// Builds the angles-only planning node, dist/isomorphic/module.wasm (browser and WasmEdge, unsigned), as one translation
// unit through the SDK compiler: the SDS headers of the records it reads and writes, then src/angles_od.cpp.
//   SPACE_DATA_MODULE_SDK_COMPILE_CACHE=0 node build.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import createFlatc from 'flatc-wasm/module';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { generateSdsHeaders } from '../../scripts/lib/sds-cpp-headers.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const { header, version, families } = await generateSdsHeaders(['TDM', 'PRW', 'OCM'], import.meta.url, createFlatc);
const own = await fs.readFile(path.join(root, 'src/angles_od.cpp'), 'utf8');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.rm(path.join(root, 'dist'), { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({
  manifest,
  sourceCode: ['#include "space_data_module_invoke.h"', '#include "FlowNotice_generated.h"', header, own].join('\n\n'),
  language: 'c++',
  outputPath,
  threadModel: manifest.threadModel,
});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues ?? result.report, null, 2));
await fs.copyFile(path.join(root, 'plugin-manifest.json'), path.join(root, 'dist/plugin-manifest.json'));
const wasm = await fs.readFile(outputPath);
await fs.writeFile(path.join(root, 'dist/build-provenance.json'), `${JSON.stringify({
  spacedatastandards: version, sdsFamilies: families, sources: ['src/angles_od.cpp'], threadModel: manifest.threadModel,
  wasmSha256: createHash('sha256').update(wasm).digest('hex'),
}, null, 2)}\n`);
console.log(`Built ${path.relative(root, outputPath)} (${wasm.length} bytes) against spacedatastandards.org@${version}`);
