#!/usr/bin/env node
// Resume expensive CA evidence without rerunning identical standard/Fast work.
// Authenticate the preserved run and the evidence-only T3 adapter first.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { modulesRoot, loadCatalog, selectCatalog, sha256 } from './benchmark-catalog.mjs';
import { compareEvents } from './ca-comparison.mjs';
import { REFERENCE_INTEGRATOR } from './reference-farm.mjs';
const { values: o } = parseArgs({ options: { baseline: { type: 'string' }, reference: { type: 'string' },
  provenance: { type: 'string' }, catalog: { type: 'string' }, out: { type: 'string' } } });
for (const key of ['baseline', 'reference', 'provenance', 'catalog', 'out']) assert(o[key], `Missing --${key}`);
const read = (p) => JSON.parse(fs.readFileSync(p));
const baseline = read(o.baseline), reference = read(o.reference), provenance = read(o.provenance);
const catalog = loadCatalog(o.catalog), selected = selectCatalog(catalog.records, 2000);
const [standard, fast] = baseline.screen;
assert.deepEqual([standard.implementation, fast.implementation, reference.implementation], ['ffm', 'ffm-fast', 'ffm']);
assert.equal(reference.phase, 'phase-1-reference-T3');
assert.equal(reference.objects, 2000); assert.equal(reference.days, 1);
assert.equal(reference.catalogSha256, catalog.sha256);
assert.equal(reference.selectedIdsSha256, sha256(JSON.stringify(selected.records.map((r) => r.NORAD_CAT_ID))));
assert.deepEqual(provenance.referenceIntegrator, REFERENCE_INTEGRATOR);
assert.equal(provenance.truthSettings.integrator, 'RKF78');
assert.equal(provenance.truthSettings.relativeTolerance, REFERENCE_INTEGRATOR.tolerance);
assert.equal(provenance.truthSettings.maximumStepSeconds, REFERENCE_INTEGRATOR.maxStep);
for (const [file, hash] of Object.entries(provenance.sourceHashes))
  assert.equal(sha256(fs.readFileSync(path.join(modulesRoot, file))), hash, `Reference source changed: ${file}`);
for (const [file, hash] of Object.entries(provenance.adapterHashes))
  assert.equal(sha256(fs.readFileSync(path.join(path.dirname(o.provenance), file))), hash, `Reference adapter changed: ${file}`);
for (const [run, implementation] of [[standard, 'ffm'], [reference, 'ffm'], [fast, 'ffm-fast']])
  assert.equal(run.wasmSha256, sha256(fs.readFileSync(path.join(modulesRoot, 'propagator', implementation, 'dist/isomorphic/module.wasm'))));
assert.equal(reference.wasmSha256, provenance.standardWasmSha256);
const comparison = compareEvents(standard, fast, reference, catalog.records, modulesRoot, sha256);
const result = { ...comparison, referenceIntegrator: REFERENCE_INTEGRATOR,
  evidenceSha256: Object.fromEntries(['baseline', 'reference', 'provenance'].map((key) => [key, sha256(fs.readFileSync(o[key]))])),
  standardWasmSha256: standard.wasmSha256, fastWasmSha256: fast.wasmSha256,
  limitations: ['Synthetic weather; GP sigma is diagnostic only.', 'Standard/Fast evidence is reused only after matching inputs, artifacts and the reference adapter sources.',
    'T3 integrator settings use the same resident farm export and screen; native truth output/stop scheduling is not substituted.'] };
fs.writeFileSync(o.out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ pass: result.pass, eventSets: result.eventSets, inDomain: result.inDomain, outOfDomain: result.outOfDomain, output: o.out }));
if (!result.pass) process.exitCode = 1;
