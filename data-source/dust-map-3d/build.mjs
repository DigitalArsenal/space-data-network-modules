// Build data-source/dust-map-3d through the SDK compiler lane: the $PCE header
// generated from the pinned spacedatastandards.org package, nlohmann json and
// the shared sha256. One translation unit; no downloads.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileModuleFromSource, cleanupCompilation} from 'space-data-module-sdk/compiler';
import createFlatc from 'flatc-wasm/module';
import {generateSdsHeaders} from '../../scripts/lib/sds-cpp-headers.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const scratch = path.join(root, '.build');
await fs.mkdir(scratch, {recursive: true});
process.env.TMPDIR = scratch;
const {header, version} = await generateSdsHeaders(['PCE'], import.meta.url, createFlatc);
const json = await fs.readFile(path.resolve(root, '../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp'), 'utf8');
const sha = await fs.readFile(path.resolve(root, '../../files/orbit-products/src/sha256.hpp'), 'utf8');
const strip = text => text.replace(/^#pragma once\s*$/gm, '').replace(/^#include "[^"]+"\s*$/gm, '');
const sources = await Promise.all(['healpix_fits.hpp', 'pce_rows.hpp', 'dust_map_3d.cpp'].map(name => fs.readFile(path.join(root, 'src', name), 'utf8')));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.rm(path.join(root, 'dist'), {recursive: true, force: true});
await fs.mkdir(path.dirname(outputPath), {recursive: true});
const result = await compileModuleFromSource({manifest, language: 'c++', outputPath, threadModel: 'wasi-sequential',
  sourceCode: ['#include "space_data_module_invoke.h"', header, json, sha, ...sources.map(strip)].join('\n')});
try {
  if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
  const guest = path.join(root, 'dist/guest-link');
  await fs.mkdir(guest, {recursive: true});
  await fs.writeFile(path.join(guest, 'module-link.o'), result.guestLink.objectBytes);
  const {format, language, threadModel, symbolPrefix, methodSymbols} = result.guestLink;
  await fs.writeFile(path.join(guest, 'metadata.json'), JSON.stringify({version: 1, format, language, threadModel, symbolPrefix, methodSymbols}, null, 2) + '\n');
  await fs.copyFile(path.join(root, 'plugin-manifest.json'), path.join(root, 'dist/plugin-manifest.json'));
  await fs.writeFile(path.join(root, 'dist/build-provenance.json'), `${JSON.stringify({spacedatastandards: version, schema: 'PCE', threadModel: 'wasi-sequential'}, null, 2)}\n`);
  console.log(`Built ${outputPath} against spacedatastandards.org@${version}`);
} finally { await cleanupCompilation(result); }
