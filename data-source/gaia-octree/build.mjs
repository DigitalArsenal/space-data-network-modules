// Build data-source/gaia-octree and its flow:
//   node build.mjs
// One translation unit: the SDK's typed hostcalls, the $STR/$SKT/$SKQ
// headers generated from the pinned spacedatastandards.org, the dust field of
// analysis/milky-way-model (its headers, not its pthreads bake) and src/. The
// flow (flow.mjs) is checked and compiled with the SDK's flow CLI into
// dist/flow/runtime, which a provider node signs and installs.
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileModuleFromSource, cleanupCompilation} from 'space-data-module-sdk/compiler';
import createFlatc from 'flatc-wasm/module';
import {generateSdsHeaders} from '../../scripts/lib/sds-cpp-headers.mjs';
import {gaiaFlow} from './flow.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const sdkRoot = path.dirname(path.dirname(require.resolve('space-data-module-sdk')));
const scratch = path.join(root, '.build');
await fs.mkdir(scratch, {recursive: true});
process.env.TMPDIR = scratch;
const strip = (text) => text.replace(/^#pragma once\s*$/gm, '').replace(/^#include "[^"]+"\s*$/gm, '');
const read = (rel) => fs.readFile(path.resolve(root, rel), 'utf8');
const milkyWay = ['../../foundation/frames/src/galactic.hpp', ...['model_types', 'galactic_constants', 'reid_arms', 'drimmel_dust',
  'stellar_populations', 'dust_map', 'literature_model'].map((n) => `../../analysis/milky-way-model/src/${n}.hpp`)];
const src = (...names) => names.map((n) => `src/${n}`);
await fs.rm(path.join(root, 'dist'), {recursive: true, force: true});

// One module: its manifest, its SDS families and its sources, into dist/<name>.
async function compile({name, manifestFile, schemas, files}) {
  const {header, version} = await generateSdsHeaders(schemas, import.meta.url, createFlatc);
  const sources = await Promise.all(files.map(read));
  const manifest = JSON.parse(await read(manifestFile));
  // The retrieval keeps the layout the flow compiler reads (dist/isomorphic/module.wasm, dist/guest-link, dist/plugin-manifest.json).
  const dist = path.join(root, 'dist', name === 'isomorphic' ? '' : name);
  const outputPath = path.join(root, 'dist', name, 'module.wasm');
  await fs.mkdir(path.dirname(outputPath), {recursive: true});
  const result = await compileModuleFromSource({manifest, language: 'c++', outputPath, threadModel: 'wasi-sequential',
    sourceCode: ['#include "space_data_module_invoke.h"', '#include "typedHostcall.hpp"', '#include "FlowNotice_generated.h"', '#include <cstring>', header, ...sources.map(strip)].join('\n'),
    // The space_data_module_host hostcall bridge resolves at instantiation.
    allowUndefinedImports: true});
  try {
    if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues).slice(0, 6000));
    const guest = path.join(dist, 'guest-link');
    await fs.mkdir(guest, {recursive: true});
    await fs.writeFile(path.join(guest, 'module-link.o'), result.guestLink.objectBytes);
    const {format, language, threadModel, symbolPrefix, methodSymbols} = result.guestLink;
    await fs.writeFile(path.join(guest, 'metadata.json'), JSON.stringify({version: 1, format, language, threadModel, symbolPrefix, methodSymbols}, null, 2) + '\n');
    await fs.copyFile(path.resolve(root, manifestFile), path.join(dist, 'plugin-manifest.json'));
    await fs.writeFile(path.join(dist, 'build-provenance.json'), JSON.stringify({spacedatastandards: version, schemas,
      moduleSdk: JSON.parse(await fs.readFile(path.join(sdkRoot, 'package.json'), 'utf8')).version, threadModel: 'wasi-sequential',
      wasmSha256: crypto.createHash('sha256').update(await fs.readFile(outputPath)).digest('hex')}, null, 2) + '\n');
    return version;
  } finally { await cleanupCompilation(result); }
}
// The provider node's retrieval (http, ipfs, storage_ingest; WasmEdge) and the consumer's cones (pure; browser and WasmEdge).
const version = await compile({name: 'isomorphic', manifestFile: 'plugin-manifest.json', schemas: ['STR', 'SKT'],
  files: [...milkyWay, ...src('healpix.hpp', 'astrometry.hpp', 'tap.hpp', 'rows.hpp', 'publish.hpp', 'octree.hpp', 'extinction.hpp', 'module_io.hpp', 'gaia_octree.cpp', 'retrieve.cpp')]});
await compile({name: 'cones', manifestFile: 'cones/plugin-manifest.json', schemas: ['STR', 'SKT', 'SKQ'],
  files: src('healpix.hpp', 'astrometry.hpp', 'rows.hpp', 'module_io.hpp', 'cones.cpp')});
const dist = path.join(root, 'dist');
const outputPath = path.join(dist, 'isomorphic/module.wasm');

// The flow, as a provider node installs it.
const node = (nodeId, pluginId, methodId, kind = 'transform') => ({nodeId, pluginId, methodId, kind, drainPolicy: 'single-shot'});
const edge = (fromNodeId, fromPortId, toNodeId, toPortId) => ({edgeId: [fromNodeId, fromPortId, toNodeId, toPortId].join('-'),
  fromNodeId, fromPortId, toNodeId, toPortId, backpressurePolicy: 'queue', queueDepth: 4});
const {flow, deps} = gaiaFlow({node, edge, packageDir: root});
const flowDir = path.join(dist, 'flow');
await fs.mkdir(flowDir, {recursive: true});
const flowFile = path.join(flowDir, 'gaia-octree.flow.json'), depsFile = path.join(flowDir, 'dependencies.json');
await fs.writeFile(flowFile, JSON.stringify(flow, null, 2) + '\n');
await fs.writeFile(depsFile, JSON.stringify(deps, null, 2) + '\n');
const cli = path.join(sdkRoot, 'bin/space-data-module.js');
for (const command of ['check', 'compile']) {
  const run = spawnSync(process.execPath, [cli, 'flow', command, flowFile, '--deps', depsFile, '--out', path.join(flowDir, 'runtime')], {stdio: 'inherit'});
  if (run.status !== 0) throw new Error(`flow ${command} failed (${run.status})`);
}
const artifact = JSON.parse(await fs.readFile(path.join(flowDir, 'runtime/artifact.json'), 'utf8'));
console.log(`Built ${path.relative(root, outputPath)} and ${artifact.programId} (capabilities ${artifact.capabilities?.join(', ')}) against spacedatastandards.org@${version}`);
