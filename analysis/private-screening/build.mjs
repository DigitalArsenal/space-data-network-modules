import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { generateSdsHeaders } from './sds-headers.mjs';

// One translation unit: the SDS headers ($LFV with its $OMM, $OEM), the
// SGP4/SDP4 base foundation/sgp4-str3, and the module source. Settings
// come through plugin.getConfig (typedHostcall.hpp, staged by the SDK compiler).
const root = fileURLToPath(new URL('.', import.meta.url));
const sgp4Dir = path.resolve(root, '../../foundation/sgp4-str3');
const { header, version, families } = await generateSdsHeaders(['LFV', 'OEM'], import.meta.url);
// The SGP4/SDP4 base: its header with its two parts in place of their #include lines.
let sgp4 = await fs.readFile(path.join(sgp4Dir, 'include/sgp4_str3.h'), 'utf8');
for (const part of ['sgp4_core.inc', 'model.inc']) {
  const line = `#include "../src/${part}"`;
  if (!sgp4.includes(line)) throw new Error(`foundation/sgp4-str3 no longer includes ${part}`);
  const text = await fs.readFile(path.join(sgp4Dir, 'src', part), 'utf8');
  sgp4 = sgp4.replace(line, () => text);
}
const source = await fs.readFile(path.join(root, 'src/private_screening.cpp'), 'utf8');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({
  manifest,
  sourceCode: ['#include "space_data_module_invoke.h"', '#include <array>', '#include <string_view>', header, '#include "typedHostcall.hpp"',
    sgp4, source].join('\n\n'),
  language: 'c++',
  outputPath,
  threadModel: 'wasi-sequential',
  // The sync space_data_module_host hostcall bridge for plugin.getConfig; symbols resolve at instantiation.
  allowUndefinedImports: true,
});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
await fs.copyFile(path.join(root, 'plugin-manifest.json'), path.join(root, 'dist/plugin-manifest.json'));
await fs.writeFile(path.join(root, 'dist/build-provenance.json'), `${JSON.stringify({
  spacedatastandards: version, sdsFamilies: families, sgp4: 'foundation/sgp4-str3', threadModel: 'wasi-sequential',
}, null, 2)}\n`);
console.log(`Built ${outputPath} against spacedatastandards.org@${version}`);
