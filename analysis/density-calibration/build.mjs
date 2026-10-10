import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { composeErfaTranslationUnit } from '../../foundation/frames/erfa-amalgamation.mjs';

// One translation unit: nlohmann::json for the control frames, ERFA (the
// Sun's direction and the Earth's rotation), propagator/hpop's JB2008
// (lib/jb2008.h, unchanged), propagator/sgp4's Vallado SGP4 (the element
// sets' trajectories for the decay methods; as analysis/epoch-state compiles
// it) and this module's source.
const root = fileURLToPath(new URL('.', import.meta.url));
const jsonHeader = path.resolve(root, '../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp');
const jb2008Header = path.resolve(root, '../../propagator/hpop/lib/jb2008.h');
const sgp4Src = path.resolve(root, '../../propagator/sgp4/src/cpp/src');
const erfa = await composeErfaTranslationUnit();
const json = await fs.readFile(jsonHeader, 'utf8');
const jb2008 = await fs.readFile(jb2008Header, 'utf8');
// SGP4.cpp carries Latin-1 bytes in comments and defines a `pi` macro that
// must not leak past it.
const sgp4Header = await fs.readFile(path.join(sgp4Src, 'SGP4.h'), 'latin1');
const sgp4Source = (await fs.readFile(path.join(sgp4Src, 'SGP4.cpp'), 'latin1')).replace('#include "SGP4.h"', '');
const source = await fs.readFile(path.join(root, 'src/density_calibration.cpp'), 'utf8');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({
  manifest,
  sourceCode: ['#include "space_data_module_invoke.h"', '#define JSON_NOEXCEPTION 1', json, erfa.source, jb2008, sgp4Header, sgp4Source, '#undef pi', source].join('\n\n'),
  language: 'c++',
  outputPath,
  threadModel: 'single-thread',
});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
await fs.copyFile(path.join(root, 'plugin-manifest.json'), path.join(root, 'dist/plugin-manifest.json'));
await fs.writeFile(path.join(root, 'dist/build-provenance.json'), `${JSON.stringify({
  erfaSourceFiles: erfa.fileCount, jb2008: 'propagator/hpop/lib/jb2008.h', sgp4: 'propagator/sgp4/src/cpp/src/SGP4.cpp',
  json: 'propagator/sgp4/src/cpp/include/nlohmann/json.hpp', threadModel: 'single-thread',
}, null, 2)}\n`);
console.log(`Built ${outputPath}`);
