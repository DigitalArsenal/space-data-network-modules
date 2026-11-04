#!/usr/bin/env node
// Builds the laser orbit-determination node, dist/isomorphic/module.wasm (browser and WasmEdge, unsigned), as ONE
// translation unit through the SDK compiler: the SDS headers of the records it reads and writes (generated with the
// object API from the spacedatastandards.org package this flow pins), analysis/estimation's wire headers (its committed
// src/generated/invoke: the $EST envelope it exchanges with fit_batch), ERFA, foundation/frames' axis engine and $EOP
// series (the one GCRF/ITRF chain in the tree), then src/laser_od.cpp.
//   SPACE_DATA_MODULE_SDK_COMPILE_CACHE=0 node build.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import createFlatc from 'flatc-wasm/module';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { loadKnownTypeCatalog } from 'space-data-module-sdk/standards';
import { generateSdsHeaders } from '../../scripts/lib/sds-cpp-headers.mjs';
import { composeErfaTranslationUnit } from '../../foundation/frames/erfa-amalgamation.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const modules = path.resolve(root, '../..');
const framesSrc = path.join(modules, 'foundation/frames/src');
const wireDir = path.join(modules, 'analysis/estimation/src/generated/invoke');

const { header, version, families } = await generateSdsHeaders(['TDM', 'GST', 'PRW', 'EOP', 'OCM', 'PVN', 'EOO'], import.meta.url, createFlatc);
const relax = (text) => text.replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/g, '');
const wire = (await Promise.all(['BaseTypes', 'Propagator', 'Estimation'].map((n) => fs.readFile(path.join(wireDir, `${n}_generated.h`), 'utf8'))))
  .map((text) => relax(text).replace(/^#include "[A-Za-z]+_generated\.h"\n/gm, ''));
const erfa = await composeErfaTranslationUnit();
const bodyModels = await fs.readFile(path.join(framesSrc, 'iau_body_models.hpp'), 'utf8');
const axisEngine = (await fs.readFile(path.join(framesSrc, 'axis_engine.hpp'), 'utf8'))
  .replace('#include "iau_body_models.hpp"', '')
  .replace(/extern "C" \{\n#include "erfa\.h"\n#include "erfam\.h"\n\}\n/, '// ERFA is amalgamated ahead of this header by build.mjs.\n');
const eopSeries = (await fs.readFile(path.join(framesSrc, 'eop_series.hpp'), 'utf8')).replace('#pragma once', '');
const own = await fs.readFile(path.join(root, 'src/laser_od.cpp'), 'utf8');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));

const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.rm(path.join(root, 'dist'), { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT;
const catalog = [...await loadKnownTypeCatalog({ standardsRoot })];
// analysis/estimation's module-local append-only schema: the $EST envelope fit_batch reads and writes.
if (!catalog.some((t) => t.fileIdentifier === '$EST'))
  catalog.push({ schemaCode: 'ESTIMATION', schemaName: 'Estimation.fbs', fileIdentifier: '$EST', rootTypeName: 'EstimationEnvelope', source: 'module-local-append-only-schema' });
const result = await compileModuleFromSource({
  manifest,
  sourceCode: ['#include "space_data_module_invoke.h"', header, ...wire, erfa.source, bodyModels, axisEngine, eopSeries, own].join('\n\n'),
  language: 'c++',
  outputPath,
  threadModel: manifest.threadModel,
  standardsRoot,
  catalog,
});
if (!result.report?.ok) throw new Error('the SDK compiler refused the node', { cause: result.report?.issues ?? result.report });
await fs.copyFile(path.join(root, 'plugin-manifest.json'), path.join(root, 'dist/plugin-manifest.json'));
const wasm = await fs.readFile(outputPath);
console.log(`Built ${path.relative(root, outputPath)} (${wasm.length} bytes) against spacedatastandards.org@${version} (${families.join(', ')}), SHA-256 ${createHash('sha256').update(wasm).digest('hex')}`);
