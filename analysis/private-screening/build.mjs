import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';

// One translation unit: nlohmann::json for the control frames, the Vallado
// SGP4 that propagator/sgp4 compiles, and the module source.
const root = fileURLToPath(new URL('.', import.meta.url));
const sgp4Src = path.resolve(root, '../../propagator/sgp4/src/cpp/src');
const jsonHeader = path.resolve(root, '../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp');
// SGP4.cpp carries Latin-1 bytes in comments and defines a `pi` macro that must not leak.
const sgp4Header = await fs.readFile(path.join(sgp4Src, 'SGP4.h'), 'latin1');
const sgp4Source = (await fs.readFile(path.join(sgp4Src, 'SGP4.cpp'), 'latin1')).replace('#include "SGP4.h"', '');
const json = await fs.readFile(jsonHeader, 'utf8');
const source = await fs.readFile(path.join(root, 'src/private_screening.cpp'), 'utf8');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({
  manifest,
  sourceCode: ['#include "space_data_module_invoke.h"', '#include <array>', '#define JSON_NOEXCEPTION 1', json, sgp4Header, sgp4Source,
    '#undef pi', source].join('\n\n'),
  language: 'c++',
  outputPath,
  threadModel: 'single-thread',
});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
await fs.copyFile(path.join(root, 'plugin-manifest.json'), path.join(root, 'dist/plugin-manifest.json'));
await fs.writeFile(path.join(root, 'dist/build-provenance.json'), `${JSON.stringify({
  sgp4: 'propagator/sgp4/src/cpp/src/SGP4.cpp', threadModel: 'single-thread',
}, null, 2)}\n`);
console.log(`Built ${outputPath}`);
