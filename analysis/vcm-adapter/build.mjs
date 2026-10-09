// analysis/vcm-adapter: one translation unit (generated SDS headers, the
// vendored ERFA and foundation/frames' axis engine, the module), compiled
// by the SDK on its sequential WASI lane.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource, cleanupCompilation } from 'space-data-module-sdk/compiler';
import { generateSdsHeaders, standardsRoot } from './generate-sds-headers.mjs';
import { composeErfaTranslationUnit } from '../../foundation/frames/erfa-amalgamation.mjs';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const framesSrc = path.join(packageRoot, '..', '..', 'foundation', 'frames', 'src');
const manifestPath = path.join(packageRoot, 'plugin-manifest.json');
const distRoot = path.join(packageRoot, 'dist');
const outputPath = path.join(distRoot, 'isomorphic', 'module.wasm');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const { version: sdsVersion, families, headers } = await generateSdsHeaders();
const erfa = await composeErfaTranslationUnit();
const bodyModels = await fs.readFile(path.join(framesSrc, 'iau_body_models.hpp'), 'utf8');
const axisEngine = (await fs.readFile(path.join(framesSrc, 'axis_engine.hpp'), 'utf8'))
  .replace('#include "iau_body_models.hpp"', '')
  .replace(/extern "C" \{\n#include "erfa\.h"\n#include "erfam\.h"\n\}\n/, '// ERFA declarations are amalgamated ahead of this header by build.mjs.\n');
const sourceCode = [
  ...families.map((f) => headers[f]),
  erfa.source, bodyModels, axisEngine,
  await fs.readFile(path.join(packageRoot, 'src', 'vcm_adapter_module.cpp'), 'utf8'),
].join('\n\n');
await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({ manifest, standardsRoot, sourceCode, language: 'c++', outputPath, threadModel: 'wasi-sequential' });
try {
  if (!result.report?.ok) throw new Error(`Compiled artifact failed SDK validation:\n${JSON.stringify(result.report?.issues ?? [], null, 2)}`);
  await fs.copyFile(manifestPath, path.join(distRoot, 'plugin-manifest.json'));
  await fs.writeFile(path.join(distRoot, 'build-provenance.json'), `${JSON.stringify({ spacedatastandards: sdsVersion, sdsFamilies: families, erfaSourceFiles: erfa.fileCount, axisEngine: 'foundation/frames/src/axis_engine.hpp', threadModel: result.threadModel }, null, 2)}\n`);
} finally { await cleanupCompilation(result); }
execFileSync(process.execPath, [path.join(packageRoot, '..', '..', 'scripts', 'sign-module-artifact.mjs'), outputPath], { stdio: 'inherit' });
console.log(`Built ${path.relative(packageRoot, outputPath)} against spacedatastandards.org@${sdsVersion} (${families.join(', ')})`);
