import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { generateSdsHeaders } from './sds-headers.mjs';

// One translation unit: the SDS headers ($OMM, $OEM and $MNV in, $ERM in,
// $OCM and $CVR out, $PRW window requests out), the RTN / curvilinear frame
// definitions shared through foundation/frames (the RIC box's, so the series
// and the box agree), and the module's sources in dependency order. The
// module holds no propagator: trajectories come through the propagator query
// port. MODULE_PRODUCER, the module and its version, is the manifest's: the
// PRODUCER of every record's PROVENANCE.
const root = fileURLToPath(new URL('.', import.meta.url));
const { header, version, families } = await generateSdsHeaders(['OMM', 'OEM', 'MNV', 'ERM', 'OCM', 'CVR', 'PRW'], import.meta.url);
const frames = await fs.readFile(path.resolve(root, '../../foundation/frames/include/rtn_curvilinear.hpp'), 'utf8');
const files = ['common.cpp', 'provenance.cpp', 'elements.cpp', 'sets.cpp', 'error_model.cpp', 'history.cpp', 'uncertainty.cpp', 'encode.cpp', 'rpo_history.cpp'];
const sources = await Promise.all(files.map((f) => fs.readFile(path.join(root, 'src', f), 'utf8')));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({
  manifest,
  sourceCode: ['#include "space_data_module_invoke.h"', '#include "typedHostcall.hpp"', `#define MODULE_PRODUCER ${JSON.stringify(`${manifest.pluginId} ${manifest.version}`)}`,
    header, frames, ...sources].join('\n\n'),
  language: 'c++',
  outputPath,
  threadModel: 'single-thread',
  // plugin.getConfig (sdm_piv::get_config) imports the sync hostcall bridge;
  // its symbols resolve at instantiation (SDK harness / Go node bridge).
  allowUndefinedImports: true,
});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
await fs.copyFile(path.join(root, 'plugin-manifest.json'), path.join(root, 'dist/plugin-manifest.json'));
await fs.writeFile(path.join(root, 'dist/build-provenance.json'), `${JSON.stringify({
  spacedatastandards: version, sdsFamilies: families, sources: ['../../foundation/frames/include/rtn_curvilinear.hpp', ...files.map((f) => `src/${f}`)],
  threadModel: 'single-thread',
}, null, 2)}\n`);
console.log(`Built ${outputPath} against spacedatastandards.org@${version}`);
