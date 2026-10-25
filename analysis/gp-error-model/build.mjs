import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { generateSdsHeaders } from './sds-headers.mjs';
import { composeErfaTranslationUnit } from '../../foundation/frames/erfa-amalgamation.mjs';

// One translation unit: SDS headers, ERFA and the foundation/frames axis
// engine (TEME -> GCRF), the SGP4/SDP4 base foundation/sgp4-str3,
// Izzo's Lambert kernel (analysis/lambert-izzo), the SHA-256 that orbit-products
// uses for record hashes, and nlohmann::json for the methods' working values. src/erm_bridge.cpp is the wire boundary:
// every data, option and report port carries one SDS $ERM record (typed contracts 1.0), and the node config
// (plugin.getConfig, sdm_piv::get_config) carries the recipes. fit_elements.cpp (SGP4 element fitting) comes last.
const root = fileURLToPath(new URL('.', import.meta.url));
// Embed the frozen wire record verbatim, including its size prefix. Validate
// before generating headers or compiling so a missing/bad prior fails early.
const defaultModelPath = path.join(root, 'data/e14-s3-kc.erm');
const defaultModel = await fs.readFile(defaultModelPath).catch((cause) => {
  throw new Error(`Cannot embed default population model: ${defaultModelPath}`, { cause });
});
if (defaultModel.length < 12 || defaultModel.readUInt32LE(0) !== defaultModel.length - 4 ||
    !defaultModel.subarray(8, 12).equals(Buffer.from('$ERM'))) {
  throw new Error(`Default population model must be one size-prefixed $ERM record: ${defaultModelPath}`);
}
const defaultModelRows = [];
for (let at = 0; at < defaultModel.length; at += 16)
  defaultModelRows.push('  ' + Array.from(defaultModel.subarray(at, at + 16), (b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ') + ',');
const defaultModelSource = `static const unsigned char kDefaultModelErm[] = {\n${defaultModelRows.join('\n')}\n};\n` +
  'static const size_t kDefaultModelErmSize = sizeof(kDefaultModelErm);';
const framesSrc = path.resolve(root, '../../foundation/frames/src');
const sgp4Dir = path.resolve(root, '../../foundation/sgp4-str3');
const jsonHeader = path.resolve(root, '../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp');
const { header, version, families } = await generateSdsHeaders(['OMM', 'OEM', 'OCM', 'CDM', 'PRW', 'MNV', 'ERM'], import.meta.url);
const erfa = await composeErfaTranslationUnit();
const bodyModels = await fs.readFile(path.join(framesSrc, 'iau_body_models.hpp'), 'utf8');
const axisEngine = (await fs.readFile(path.join(framesSrc, 'axis_engine.hpp'), 'utf8'))
  .replace('#include "iau_body_models.hpp"', '')
  .replace(/extern "C" \{\n#include "erfa\.h"\n#include "erfam\.h"\n\}\n/, '// ERFA is amalgamated ahead of this header by build.mjs.\n');
// The SGP4/SDP4 base: its header with its two parts in place of their #include lines.
let sgp4 = await fs.readFile(path.join(sgp4Dir, 'include/sgp4_str3.h'), 'utf8');
for (const part of ['sgp4_core.inc', 'model.inc']) {
  const line = `#include "../src/${part}"`;
  if (!sgp4.includes(line)) throw new Error(`foundation/sgp4-str3 no longer includes ${part}`);
  const text = await fs.readFile(path.join(sgp4Dir, 'src', part), 'utf8');
  sgp4 = sgp4.replace(line, () => text);
}
const json = await fs.readFile(jsonHeader, 'utf8');
const sha256 = await fs.readFile(path.resolve(root, '../../files/orbit-products/src/sha256.hpp'), 'utf8');
// The module's sources in dependency order (one translation unit), and the
// Lambert kernel analysis/lambert-izzo and analysis/maneuver compile.
const bridge = await fs.readFile(path.join(root, 'src', 'erm_bridge.cpp'), 'utf8');
const sources = await Promise.all(['gp_error_model.cpp', 'common_epoch.cpp', 'state_transition.cpp', 'covariance_realism.cpp', 'source_products.cpp', 'object_covariance.cpp', 'source_covariance.cpp', 'fit_elements.cpp']
  .map(async (f) => (f === 'object_covariance.cpp' ? defaultModelSource + '\n\n' : '') + await fs.readFile(path.join(root, 'src', f), 'utf8')));
const lambert = await fs.readFile(path.resolve(root, '../lambert-izzo/include/lambert_izzo/solver.hpp'), 'utf8');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({
  manifest,
  sourceCode: ['#include "space_data_module_invoke.h"', '#include "typedHostcall.hpp"', '#define JSON_NOEXCEPTION 1', json, header, erfa.source, bodyModels, axisEngine,
    // The SGP4 base has internal linkage: the flow compiler links this module's object with others that compile their
    // own copy (analysis/epoch-state, analysis/maneuver-detection). The standard headers it includes come first,
    // outside the namespace.
    '#include <cmath>\n#include <cstdint>\nnamespace {', sgp4, '}  // namespace', lambert, sha256, bridge, ...sources].join('\n\n'),
  language: 'c++',
  outputPath,
  threadModel: 'wasi-sequential',
  // attach_covariance and attribute_maneuvers read their recipes through the sync space_data_module_host hostcall bridge
  // (plugin.getConfig, typedHostcall.hpp); its symbols resolve at instantiation.
  allowUndefinedImports: true,
});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
await fs.copyFile(path.join(root, 'plugin-manifest.json'), path.join(root, 'dist/plugin-manifest.json'));
// The flow compiler links this module as a node from its prefixed guest-link object (flows/source-products).
const guestLinkDir = path.join(root, 'dist/guest-link');
await fs.mkdir(guestLinkDir, { recursive: true });
await fs.writeFile(path.join(guestLinkDir, 'module-link.o'), result.guestLink.objectBytes);
await fs.writeFile(path.join(guestLinkDir, 'metadata.json'), `${JSON.stringify({
  version: 1, format: result.guestLink.format, language: result.guestLink.language, threadModel: result.guestLink.threadModel,
  symbolPrefix: result.guestLink.symbolPrefix, methodSymbols: result.guestLink.methodSymbols,
}, null, 2)}\n`);
await fs.writeFile(path.join(root, 'dist/build-provenance.json'), `${JSON.stringify({
  spacedatastandards: version, sdsFamilies: families, erfaSourceFiles: erfa.fileCount,
  axisEngine: 'foundation/frames/src/axis_engine.hpp', sgp4: 'foundation/sgp4-str3',
  lambert: 'analysis/lambert-izzo/include/lambert_izzo/solver.hpp',
  threadModel: 'wasi-sequential',
}, null, 2)}\n`);
console.log(`Built ${outputPath} against spacedatastandards.org@${version}`);
