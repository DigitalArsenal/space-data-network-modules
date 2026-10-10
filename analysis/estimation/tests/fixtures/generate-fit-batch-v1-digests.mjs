// Writes tests/fixtures/fit-batch-v1-digests.json from a version-1
// estimation artifact. The committed digests come from the module at
// space-data-network-modules 37a0801f (analysis/estimation 0.2.0,
// dist/isomorphic/module.wasm SHA-256 786d0de9...), with propagator/hpop
// at that commit answering:
//
//   git show 37a0801f:analysis/estimation/dist/isomorphic/module.wasm > v1.wasm
//   git show 37a0801f:analysis/estimation/plugin-manifest.json > v1-manifest.json
//   node tests/fixtures/generate-fit-batch-v1-digests.mjs v1.wasm v1-manifest.json
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing/browser';
import { harness } from '../batch-fit-fixtures.mjs';
import { replayDigests, v1Cases } from '../fit-batch-v1-cases.mjs';

const [wasmPath, manifestPath] = process.argv.slice(2);
if (!wasmPath || !manifestPath) throw new Error('usage: generate-fit-batch-v1-digests.mjs <v1 module.wasm> <v1 plugin-manifest.json>');
const wasm = fs.readFileSync(wasmPath);
const estimator = await createBrowserModuleHarness({ wasmSource: wasm, manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')), surface: 'direct' });
const hpop = await harness('../../../propagator/hpop/');
const cases = {};
try {
  for (const entry of v1Cases()) cases[entry.id] = await replayDigests(estimator, hpop, entry);
} finally { estimator.destroy?.(); hpop.destroy?.(); }
const out = {
  source: 'analysis/estimation version 1 (space-data-network-modules 37a0801f), propagator/hpop answering',
  module: crypto.createHash('sha256').update(wasm).digest('hex'),
  cases,
};
fs.writeFileSync(new URL('./fit-batch-v1-digests.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote ${Object.keys(cases).length} cases, ${Object.values(cases).reduce((a, r) => a + r.length, 0)} rounds`);
