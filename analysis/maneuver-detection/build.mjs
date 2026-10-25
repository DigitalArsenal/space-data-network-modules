import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { generateSdsHeaders } from './sds-headers.mjs';

// One translation unit: the SDS headers ($OMM in, $OEM in, $MNV in and out,
// $MDE reports out, $PRW window requests out, the $ERM error model in),
// nlohmann::json without exceptions for the in-memory evidence tree and the
// config adapter, the SGP4/SDP4 base foundation/sgp4-str3 (an element
// set's un-Kozai'd mean motion places it in an error-model regime, as
// analysis/gp-error-model does), and the module's sources in dependency order.
// The module holds no propagator: trajectories come from the caller, or
// through the propagator query port. MODULE_PRODUCER, the module and its
// version, is the manifest's: the PRODUCER of every $MNV's PROVENANCE and the
// head of its ALGORITHM.
const root = fileURLToPath(new URL('.', import.meta.url));
const { header, version, families } = await generateSdsHeaders(['OMM', 'OEM', 'MNV', 'MDE', 'PRW', 'ERM'], import.meta.url);
const json = await fs.readFile(path.resolve(root, '../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp'), 'utf8');
// The SGP4/SDP4 base: its header with its two parts in place of their #include lines. Internal linkage: the flow
// compiler links this module's object with others that compile their own copy.
const sgp4Dir = path.resolve(root, '../../foundation/sgp4-str3');
let sgp4Base = await fs.readFile(path.join(sgp4Dir, 'include/sgp4_str3.h'), 'utf8');
for (const part of ['sgp4_core.inc', 'model.inc']) {
  const line = `#include "../src/${part}"`;
  if (!sgp4Base.includes(line)) throw new Error(`foundation/sgp4-str3 no longer includes ${part}`);
  const text = await fs.readFile(path.join(sgp4Dir, 'src', part), 'utf8');
  sgp4Base = sgp4Base.replace(line, () => text);
}
const sgp4 = ['#include <cmath>\n#include <cstdint>\nnamespace {', sgp4Base, '}  // namespace'];
const files = ['common.cpp', 'provenance.cpp', 'trajectory.cpp', 'queries.cpp', 'impulse.cpp', 'crossing.cpp', 'glr.cpp', 'mnv.cpp', 'compare.cpp', 'score.cpp', 'mde.cpp', 'maneuver_detection.cpp'];
const sources = await Promise.all(files.map((f) => fs.readFile(path.join(root, 'src', f), 'utf8')));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({
  manifest,
  sourceCode: ['#include "space_data_module_invoke.h"', '#include "typedHostcall.hpp"', '#define JSON_NOEXCEPTION 1', `#define MODULE_PRODUCER ${JSON.stringify(`${manifest.pluginId} ${manifest.version}`)}`, json, header, ...sgp4, ...sources].join('\n\n'),
  language: 'c++',
  outputPath,
  threadModel: 'wasi-sequential',
  // plugin.getConfig (sdm_piv::get_config) imports the sync hostcall bridge;
  // its symbols resolve at instantiation (SDK harness / Go node bridge).
  allowUndefinedImports: true,
});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
await fs.copyFile(path.join(root, 'plugin-manifest.json'), path.join(root, 'dist/plugin-manifest.json'));
// The flow compiler links this module as a node from its prefixed guest-link
// object (flows/source-products).
const guestLinkDir = path.join(root, 'dist/guest-link');
await fs.mkdir(guestLinkDir, { recursive: true });
await fs.writeFile(path.join(guestLinkDir, 'module-link.o'), result.guestLink.objectBytes);
await fs.writeFile(path.join(guestLinkDir, 'metadata.json'), `${JSON.stringify({
  version: 1, format: result.guestLink.format, language: result.guestLink.language, threadModel: result.guestLink.threadModel,
  symbolPrefix: result.guestLink.symbolPrefix, methodSymbols: result.guestLink.methodSymbols,
}, null, 2)}\n`);
await fs.writeFile(path.join(root, 'dist/build-provenance.json'), `${JSON.stringify({
  spacedatastandards: version, sdsFamilies: families, sources: files.map((f) => `src/${f}`), sgp4: 'foundation/sgp4-str3', threadModel: 'wasi-sequential',
}, null, 2)}\n`);
console.log(`Built ${outputPath} against spacedatastandards.org@${version}`);
