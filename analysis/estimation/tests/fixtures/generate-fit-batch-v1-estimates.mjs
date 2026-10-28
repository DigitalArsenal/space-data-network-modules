// Writes tests/fixtures/fit-batch-v1-estimates.json from a version-1
// estimation artifact with propagator/ffm answering. The committed values
// come from analysis/estimation 0.5.0 (space-data-network-modules
// 5746b0f53, dist/isomorphic/module.wasm SHA-256 d3aa2c8a...), whose
// requests without options run the version-1 algorithm (it reproduced the
// version-1 artifact 786d0de9's bytes), with propagator/ffm 2.0.1 at that
// commit (343c4145...) answering:
//
//   git show 5746b0f53:analysis/estimation/dist/isomorphic/module.wasm > v1.wasm
//   git show 5746b0f53:analysis/estimation/plugin-manifest.json > v1-manifest.json
//   node tests/fixtures/generate-fit-batch-v1-estimates.mjs v1.wasm v1-manifest.json
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing/browser';
import { harness } from '../batch-fit-fixtures.mjs';
import { v1Cases, v1Result } from '../fit-batch-v1-cases.mjs';

const [wasmPath, manifestPath] = process.argv.slice(2);
if (!wasmPath || !manifestPath) throw new Error('usage: generate-fit-batch-v1-estimates.mjs <v1 module.wasm> <v1 plugin-manifest.json>');
const wasm = fs.readFileSync(wasmPath);
const estimator = await createBrowserModuleHarness({ wasmSource: wasm, manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')), surface: 'direct' });
const ffm = await harness('../../../propagator/ffm/');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const cases = {};
try {
  for (const entry of v1Cases()) cases[entry.id] = await v1Result(estimator, ffm, entry, { domains: false });
} finally { estimator.destroy?.(); ffm.destroy?.(); }
const out = {
  source: 'analysis/estimation 0.5.0 version-1 requests (space-data-network-modules 5746b0f53), propagator/ffm 2.0.1 answering',
  module: sha256(wasm),
  ffm: sha256(fs.readFileSync(new URL('../../../../propagator/ffm/dist/isomorphic/module.wasm', import.meta.url))),
  cases,
};
fs.writeFileSync(new URL('./fit-batch-v1-estimates.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
