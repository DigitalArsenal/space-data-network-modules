import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { generateSdsHeaders } from './sds-headers.mjs';

// One translation unit: the SDS headers ($LFV with its $OMM, $OEM), the
// Vallado SGP4 that propagator/sgp4 compiles, and the module source. Settings
// come through plugin.getConfig (typedHostcall.hpp, staged by the SDK compiler).
const root = fileURLToPath(new URL('.', import.meta.url));
const sgp4Src = path.resolve(root, '../../propagator/sgp4/src/cpp/src');
const { header, version, families } = await generateSdsHeaders(['LFV', 'OEM'], import.meta.url);
// SGP4.cpp carries Latin-1 bytes in comments and defines a `pi` macro that must not leak.
const sgp4Header = await fs.readFile(path.join(sgp4Src, 'SGP4.h'), 'latin1');
const sgp4Source = (await fs.readFile(path.join(sgp4Src, 'SGP4.cpp'), 'latin1')).replace('#include "SGP4.h"', '');
const source = await fs.readFile(path.join(root, 'src/private_screening.cpp'), 'utf8');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({
  manifest,
  sourceCode: ['#include "space_data_module_invoke.h"', '#include <array>', '#include <string_view>', header, '#include "typedHostcall.hpp"',
    sgp4Header, sgp4Source, '#undef pi', source].join('\n\n'),
  language: 'c++',
  outputPath,
  threadModel: 'wasi-sequential',
  // The sync space_data_module_host hostcall bridge for plugin.getConfig; symbols resolve at instantiation.
  allowUndefinedImports: true,
});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
await fs.copyFile(path.join(root, 'plugin-manifest.json'), path.join(root, 'dist/plugin-manifest.json'));
await fs.writeFile(path.join(root, 'dist/build-provenance.json'), `${JSON.stringify({
  spacedatastandards: version, sdsFamilies: families, sgp4: 'propagator/sgp4/src/cpp/src/SGP4.cpp', threadModel: 'wasi-sequential',
}, null, 2)}\n`);
console.log(`Built ${outputPath} against spacedatastandards.org@${version}`);
