import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { generateSdsHeaders } from './sds-headers.mjs';
import { composeErfaTranslationUnit } from '../../foundation/frames/erfa-amalgamation.mjs';

// One translation unit: SDS headers, ERFA, the foundation/frames axis engine
// (the GCRF/ITRF chain) and the estimation module's measurement model, so the
// simulator and the estimator share one implementation of each.
const root = fileURLToPath(new URL('.', import.meta.url));
const framesSrc = path.resolve(root, '../../foundation/frames/src');
const estimationSrc = path.resolve(root, '../estimation/src');
const { header, version, families } = await generateSdsHeaders(['ACW', 'RDO', 'EOO', 'RFO'], import.meta.url);
if (!header.includes('SIMULATE_OBSERVATIONS')) {
  throw new Error(`spacedatastandards.org@${version} has no ACW SIMULATE_OBSERVATIONS; the simulator needs 1.229.0 or later.`);
}
const erfa = await composeErfaTranslationUnit();
const bodyModels = await fs.readFile(path.join(framesSrc, 'iau_body_models.hpp'), 'utf8');
const axisEngine = (await fs.readFile(path.join(framesSrc, 'axis_engine.hpp'), 'utf8'))
  .replace('#include "iau_body_models.hpp"', '')
  .replace(/extern "C" \{\n#include "erfa\.h"\n#include "erfam\.h"\n\}\n/, '// ERFA is amalgamated ahead of this header by build.mjs.\n');
const estimationHeader = await fs.readFile(path.join(estimationSrc, 'estimation.hpp'), 'utf8');
const estimationSource = (await fs.readFile(path.join(estimationSrc, 'estimation.cpp'), 'utf8')).replace('#include "estimation.hpp"', '');
const source = await fs.readFile(path.join(root, 'src/observation_simulator.cpp'), 'utf8');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({
  manifest,
  sourceCode: [header, erfa.source, bodyModels, axisEngine, estimationHeader, estimationSource, source].join('\n\n'),
  language: 'c++',
  outputPath,
  threadModel: 'single-thread',
});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
await fs.copyFile(path.join(root, 'plugin-manifest.json'), path.join(root, 'dist/plugin-manifest.json'));
await fs.writeFile(path.join(root, 'dist/build-provenance.json'), `${JSON.stringify({
  spacedatastandards: version, sdsFamilies: families, erfaSourceFiles: erfa.fileCount,
  axisEngine: 'foundation/frames/src/axis_engine.hpp', measurementModel: 'analysis/estimation/src/estimation.cpp',
  threadModel: 'single-thread',
}, null, 2)}\n`);
console.log(`Built ${outputPath} against spacedatastandards.org@${version}`);
