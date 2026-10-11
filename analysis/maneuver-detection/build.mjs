import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { generateSdsHeaders } from './sds-headers.mjs';

// One translation unit: the SDS headers ($OMM in, $OEM in, $MNV in and out),
// nlohmann::json without exceptions for the control frames, and the module's
// sources in dependency order. The module holds no propagator: trajectories
// come from the caller, or through the propagator query port.
const root = fileURLToPath(new URL('.', import.meta.url));
const { header, version, families } = await generateSdsHeaders(['OMM', 'OEM', 'MNV'], import.meta.url);
const json = await fs.readFile(path.resolve(root, '../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp'), 'utf8');
const files = ['common.cpp', 'trajectory.cpp', 'queries.cpp', 'crossing.cpp', 'glr.cpp', 'mnv.cpp', 'compare.cpp', 'score.cpp', 'maneuver_detection.cpp'];
const sources = await Promise.all(files.map((f) => fs.readFile(path.join(root, 'src', f), 'utf8')));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({
  manifest,
  sourceCode: ['#include "space_data_module_invoke.h"', '#define JSON_NOEXCEPTION 1', json, header, ...sources].join('\n\n'),
  language: 'c++',
  outputPath,
  threadModel: 'single-thread',
});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
await fs.copyFile(path.join(root, 'plugin-manifest.json'), path.join(root, 'dist/plugin-manifest.json'));
await fs.writeFile(path.join(root, 'dist/build-provenance.json'), `${JSON.stringify({
  spacedatastandards: version, sdsFamilies: families, sources: files.map((f) => `src/${f}`), threadModel: 'single-thread',
}, null, 2)}\n`);
console.log(`Built ${outputPath} against spacedatastandards.org@${version}`);
