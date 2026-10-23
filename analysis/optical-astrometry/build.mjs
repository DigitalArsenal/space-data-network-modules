import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { generateSdsHeaders } from './sds-headers.mjs';
import { composeErfaTranslationUnit } from '../../foundation/frames/erfa-amalgamation.mjs';

// One translation unit: the SDS headers of the records read and written,
// ERFA, the foundation/frames axis engine and $EOP series (the one GCRF/ITRF
// chain in the tree), Izzo's Lambert solver (analysis/lambert-izzo, the
// Gooding iteration's arc), then the module's sources in dependency order.
// The options are the node config (plugin.getConfig, sdm_piv::get_config).
const root = fileURLToPath(new URL('.', import.meta.url));
const framesSrc = path.resolve(root, '../../foundation/frames/src');
const lambert = path.resolve(root, '../lambert-izzo/include/lambert_izzo/solver.hpp');
const { header, version, families } = await generateSdsHeaders(
  ['FIL', 'SKT', 'STR', 'OMM', 'OEM', 'EOP', 'ERM', 'PRW', 'SKQ', 'TDM', 'EOO', 'SKI', 'OCM'], import.meta.url);
const erfa = await composeErfaTranslationUnit();
const bodyModels = await fs.readFile(path.join(framesSrc, 'iau_body_models.hpp'), 'utf8');
const axisEngine = (await fs.readFile(path.join(framesSrc, 'axis_engine.hpp'), 'utf8'))
  .replace('#include "iau_body_models.hpp"', '')
  .replace(/extern "C" \{\n#include "erfa\.h"\n#include "erfam\.h"\n\}\n/, '// ERFA is amalgamated ahead of this header by build.mjs.\n');
const eopSeries = (await fs.readFile(path.join(framesSrc, 'eop_series.hpp'), 'utf8')).replace('#pragma once', '');
const before = ['base', 'image', 'overlay', 'detect', 'catalog', 'wcs', 'solve', 'ephem', 'locate', 'calibrate'];
const after = ['od', 'reduce', 'records', 'module'];
const read = (names) => Promise.all(names.map((n) => fs.readFile(path.join(root, 'src', `${n}.cpp`), 'utf8')));
const [own0, own1, solver] = await Promise.all([read(before), read(after), fs.readFile(lambert, 'utf8')]);
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.rm(path.join(root, 'dist'), { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({
  manifest,
  sourceCode: [
    '#include "space_data_module_invoke.h"',
    '#include "typedHostcall.hpp"',
    '#include "FlowNotice_generated.h"',
    header, erfa.source, bodyModels, axisEngine, eopSeries, ...own0, solver.replace('#pragma once', ''), ...own1,
  ].join('\n\n'),
  language: 'c++',
  outputPath,
  threadModel: 'wasi-sequential',
  // plugin.getConfig: the hostcall bridge's symbols resolve at instantiation.
  allowUndefinedImports: true,
});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
await fs.copyFile(path.join(root, 'plugin-manifest.json'), path.join(root, 'dist/plugin-manifest.json'));
const wasm = fsSync.readFileSync(outputPath);
await fs.writeFile(path.join(root, 'dist/build-provenance.json'), `${JSON.stringify({
  spacedatastandards: version, sdsFamilies: families, erfaSourceFiles: erfa.fileCount,
  axisEngine: 'foundation/frames/src/axis_engine.hpp', eopSeries: 'foundation/frames/src/eop_series.hpp',
  lambert: 'analysis/lambert-izzo/include/lambert_izzo/solver.hpp',
  sources: [...before, ...after].map((n) => `src/${n}.cpp`),
  moduleSdk: JSON.parse(fsSync.readFileSync(path.join(root, 'node_modules/space-data-module-sdk/package.json'), 'utf8')).version,
  threadModel: 'wasi-sequential', wasmSha256: crypto.createHash('sha256').update(wasm).digest('hex'),
}, null, 2)}\n`);
console.log(`Built ${path.relative(root, outputPath)} (${wasm.length} bytes) against spacedatastandards.org@${version}`);
