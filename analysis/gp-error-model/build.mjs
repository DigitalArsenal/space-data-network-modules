import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { generateSdsHeaders } from './sds-headers.mjs';
import { composeErfaTranslationUnit } from '../../foundation/frames/erfa-amalgamation.mjs';

// One translation unit: SDS headers, ERFA and the foundation/frames axis
// engine (TEME -> GCRF), the Vallado SGP4 that propagator/sgp4 compiles, and
// nlohmann::json for the control frames.
const root = fileURLToPath(new URL('.', import.meta.url));
const framesSrc = path.resolve(root, '../../foundation/frames/src');
const sgp4Src = path.resolve(root, '../../propagator/sgp4/src/cpp/src');
const jsonHeader = path.resolve(root, '../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp');
const { header, version, families } = await generateSdsHeaders(['OMM', 'OEM'], import.meta.url);
const erfa = await composeErfaTranslationUnit();
const bodyModels = await fs.readFile(path.join(framesSrc, 'iau_body_models.hpp'), 'utf8');
const axisEngine = (await fs.readFile(path.join(framesSrc, 'axis_engine.hpp'), 'utf8'))
  .replace('#include "iau_body_models.hpp"', '')
  .replace(/extern "C" \{\n#include "erfa\.h"\n#include "erfam\.h"\n\}\n/, '// ERFA is amalgamated ahead of this header by build.mjs.\n');
// SGP4.cpp carries Latin-1 bytes in comments and defines a `pi` macro that must not leak.
const sgp4Header = await fs.readFile(path.join(sgp4Src, 'SGP4.h'), 'latin1');
const sgp4Source = (await fs.readFile(path.join(sgp4Src, 'SGP4.cpp'), 'latin1')).replace('#include "SGP4.h"', '');
const json = await fs.readFile(jsonHeader, 'utf8');
const source = await fs.readFile(path.join(root, 'src/gp_error_model.cpp'), 'utf8');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({
  manifest,
  sourceCode: ['#include "space_data_module_invoke.h"', '#define JSON_NOEXCEPTION 1', json, header, erfa.source, bodyModels, axisEngine,
    sgp4Header, sgp4Source, '#undef pi', source].join('\n\n'),
  language: 'c++',
  outputPath,
  threadModel: 'single-thread',
});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
await fs.copyFile(path.join(root, 'plugin-manifest.json'), path.join(root, 'dist/plugin-manifest.json'));
await fs.writeFile(path.join(root, 'dist/build-provenance.json'), `${JSON.stringify({
  spacedatastandards: version, sdsFamilies: families, erfaSourceFiles: erfa.fileCount,
  axisEngine: 'foundation/frames/src/axis_engine.hpp', sgp4: 'propagator/sgp4/src/cpp/src/SGP4.cpp',
  threadModel: 'single-thread',
}, null, 2)}\n`);
console.log(`Built ${outputPath} against spacedatastandards.org@${version}`);
