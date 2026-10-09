import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { generateSdsHeaders } from './sds-headers.mjs';
import { composeErfaTranslationUnit } from '../../foundation/frames/erfa-amalgamation.mjs';

// One translation unit: the SDS observation, ephemeris and EOP headers, ERFA
// and the foundation/frames axis engine with its $EOP series reader (the one
// Earth-orientation chain in the tree), nlohmann::json for the control
// frames, and the association source.
const root = fileURLToPath(new URL('.', import.meta.url));
const framesSrc = path.resolve(root, '../../foundation/frames/src');
const { header, version, families } = await generateSdsHeaders(['RDO', 'EOO', 'RFO', 'OEM', 'EOP'], import.meta.url);
const erfa = await composeErfaTranslationUnit();
const bodyModels = await fs.readFile(path.join(framesSrc, 'iau_body_models.hpp'), 'utf8');
const axisEngine = (await fs.readFile(path.join(framesSrc, 'axis_engine.hpp'), 'utf8'))
  .replace('#include "iau_body_models.hpp"', '')
  .replace(/extern "C" \{\n#include "erfa\.h"\n#include "erfam\.h"\n\}\n/, '// ERFA is amalgamated ahead of this header by build.mjs.\n');
const eopSeries = (await fs.readFile(path.join(framesSrc, 'eop_series.hpp'), 'utf8')).replace('#pragma once', '');
const json = await fs.readFile(path.resolve(root, '../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp'), 'utf8');
const sources = ['src/linear.hpp', 'src/chi_square.hpp', 'src/assignment.hpp', 'src/association.cpp'];
const own = await Promise.all(sources.map((file) => fs.readFile(path.join(root, file), 'utf8')));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.rm(path.join(root, 'dist'), { recursive: true, force: true });
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
    eopSeries,
    ...own.map((text) => text.replace(/^#include "(linear|chi_square|assignment)\.hpp"\n/gm, '')),
  ].join('\n\n'),
  language: 'c++',
  outputPath,
  threadModel: 'wasi-sequential',
});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
await fs.copyFile(path.join(root, 'plugin-manifest.json'), path.join(root, 'dist/plugin-manifest.json'));
const wasm = fsSync.readFileSync(outputPath);
await fs.writeFile(path.join(root, 'dist/build-provenance.json'), `${JSON.stringify({
  spacedatastandards: version, sdsFamilies: families, erfaSourceFiles: erfa.fileCount,
  axisEngine: 'foundation/frames/src/axis_engine.hpp', eopSeries: 'foundation/frames/src/eop_series.hpp',
  moduleSdk: JSON.parse(fsSync.readFileSync(path.join(root, 'node_modules/space-data-module-sdk/package.json'), 'utf8')).version,
  threadModel: manifest.threadModel, wasmSha256: crypto.createHash('sha256').update(wasm).digest('hex'),
}, null, 2)}\n`);
console.log(`Built ${path.relative(root, outputPath)} (${wasm.length} bytes) against spacedatastandards.org@${version}`);
