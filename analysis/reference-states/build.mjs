import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { generateSdsHeaders } from './sds-headers.mjs';
import { composeErfaTranslationUnit } from '../../foundation/frames/erfa-amalgamation.mjs';

// One translation unit: SDS headers, ERFA, the foundation/frames axis engine
// and its EOP table reader (the same EOP handling as the frames module), and
// nlohmann::json for the identities control frame.
const root = fileURLToPath(new URL('.', import.meta.url));
const framesSrc = path.resolve(root, '../../foundation/frames/src');
const jsonHeader = path.resolve(root, '../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp');
const { header, version, families } = await generateSdsHeaders(['OEM', 'NCD', 'EOP'], import.meta.url);
if (!header.includes('SP3_HEADER')) throw new Error(`spacedatastandards.org@${version} has no NCD SP3_HEADER.`);
const erfa = await composeErfaTranslationUnit();
const bodyModels = await fs.readFile(path.join(framesSrc, 'iau_body_models.hpp'), 'utf8');
const axisEngine = (await fs.readFile(path.join(framesSrc, 'axis_engine.hpp'), 'utf8'))
  .replace('#include "iau_body_models.hpp"', '')
  .replace(/extern "C" \{\n#include "erfa\.h"\n#include "erfam\.h"\n\}\n/, '// ERFA is amalgamated ahead of this header by build.mjs.\n');
const framesModule = await fs.readFile(path.join(framesSrc, 'frames_module.cpp'), 'utf8');
const parser = framesModule.match(/bool parse_iso_utc\([\s\S]*?\n}\n/);
if (!parser) throw new Error('foundation/frames/src/frames_module.cpp no longer defines parse_iso_utc.');
const eopTable = await fs.readFile(path.join(framesSrc, 'eop_table.hpp'), 'utf8');
const json = await fs.readFile(jsonHeader, 'utf8');
const source = await fs.readFile(path.join(root, 'src/reference_states.cpp'), 'utf8');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({
  manifest,
  sourceCode: [
    '#include "space_data_module_invoke.h"',
    '#define JSON_NOEXCEPTION 1',
    json,
    header,
    erfa.source,
    bodyModels,
    axisEngine,
    'namespace ax = ::sdn::frames;',
    `namespace {\n${parser[0]}}  // namespace`,
    eopTable,
    source,
  ].join('\n\n'),
  language: 'c++',
  outputPath,
  threadModel: 'single-thread',
});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
await fs.copyFile(path.join(root, 'plugin-manifest.json'), path.join(root, 'dist/plugin-manifest.json'));
await fs.writeFile(path.join(root, 'dist/build-provenance.json'), `${JSON.stringify({
  spacedatastandards: version, sdsFamilies: families, erfaSourceFiles: erfa.fileCount,
  axisEngine: 'foundation/frames/src/axis_engine.hpp', eopTable: 'foundation/frames/src/eop_table.hpp',
  threadModel: 'single-thread',
}, null, 2)}\n`);
console.log(`Built ${outputPath} against spacedatastandards.org@${version}`);
