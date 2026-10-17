import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {compileModuleFromSource, cleanupCompilation} from 'space-data-module-sdk/compiler';
import createFlatc from 'flatc-wasm/module';
import {generateSdsHeaders} from '../../scripts/lib/sds-cpp-headers.mjs';
import {assertArtifactThreadModel} from '../../scripts/lib/thread-model.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const scratch = path.join(root, '.build');
await fs.mkdir(scratch, {recursive: true});
// Every generated compiler file stays in this worktree. No downloads or toolchain bootstrap.
process.env.TMPDIR = scratch;
const emsdk = path.join(root, 'deps/emsdk');
await fs.access(path.join(emsdk, 'emsdk_env.sh'));
await fs.access(path.join(emsdk, 'upstream/bin/clang++'));
// SDK's real wasi-threads lane uses the repo-local LLVM driver, never emcc -pthread.
process.env.SDN_WASI_CLANG = path.join(emsdk, 'upstream/bin/clang');
process.env.SDN_WASI_CLANGXX = path.join(emsdk, 'upstream/bin/clang++');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const {header, version} = await generateSdsHeaders(['PCE'], import.meta.url, createFlatc);
const names = ['model_types.hpp', 'galactic_constants.hpp', 'volume.hpp', 'legacy_model.hpp',
  'wire.hpp', 'module.cpp', 'reid_arms.hpp', 'drimmel_dust.hpp', 'literature_model.hpp', 'statistical_stars.hpp', 'sky_morphology.hpp', 'oracle_metrics.hpp', 'ridge_metrics.hpp', 'reid_acceptance.hpp', 'component_diagnostics.hpp', 'model_api.hpp'];
const frameSource = await fs.readFile(path.join(root, '../../foundation/frames/src/galactic.hpp'), 'utf8');
const sources = await Promise.all(names.map(async name => (await fs.readFile(path.join(root, 'src', name), 'utf8'))
  .replace(/^#pragma once\s*$/gm, '').replace(/^#include "[^"]+"\s*$/gm, '')));
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath), {recursive: true});
const result = await compileModuleFromSource({manifest,
  sourceCode: ['#include "space_data_module_invoke.h"', header, frameSource, ...sources].join('\n'),
  language: 'c++', outputPath, threadModel: 'emscripten-pthreads'});
try {
  if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
  const threading = assertArtifactThreadModel(outputPath, 'emscripten-pthreads');
  await fs.copyFile(path.join(root, 'plugin-manifest.json'), path.join(root, 'dist/plugin-manifest.json'));
  await fs.mkdir(path.join(root, 'dist/guest-link'), {recursive: true});
  await fs.writeFile(path.join(root, 'dist/guest-link/module-link.o'), result.guestLink.objectBytes);
  const {format, language, threadModel, symbolPrefix, methodSymbols} = result.guestLink;
  await fs.writeFile(path.join(root, 'dist/guest-link/metadata.json'), JSON.stringify({version: 1, format,
    language, threadModel, symbolPrefix, methodSymbols}, null, 2) + '\n');
  await fs.writeFile(path.join(root, 'dist/build-provenance.json'), JSON.stringify({
    sdk: '0.9.2', standards: version, sources: names, threadModel: 'emscripten-pthreads', threading,
    compiler: 'deps/emsdk/upstream/bin/clang++ --target=wasm32-wasip1-threads',
    emsdkRelease: (await fs.readFile(path.join(emsdk, 'upstream/.emsdk_version'), 'utf8')).trim(),
    wasmSha256: createHash('sha256').update(await fs.readFile(outputPath)).digest('hex'),
  }, null, 2) + '\n');
  console.log('Built dist/isomorphic/module.wasm — SDK validation PASS; shared memory + wasi-threads');
} finally { await cleanupCompilation(result); }
