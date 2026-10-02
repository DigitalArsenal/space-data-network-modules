#!/usr/bin/env node
// HPOP covariance calibration for the CA HPOP screen's product:
// analysis/epoch-state's GCRF state at each element set's epoch, propagated by
// propagator/hpop's resident force model, with P(t) = Phi P0 Phi^T + Q.
//
//   node scripts/hpop-calibration.mjs --reference <reference-states>/reference \
//     --fit-from 2026-08-02 --fit-to 2026-08-08 --test-from 2026-08-09 --test-to 2026-08-15 \
//     [--archive DIR] [--out DIR] [--workers N] [--interval 600] [--max-arcs N]
//
// --max-arcs keeps every Nth arc of each plan, about N in all (smoke runs).
//
// 1. P0 per regime: HPOP's error at the first reference epoch after each
//    element set's epoch, fit week (hpop_coverage epoch).
// 2. HPOP at each arc's targets with P0 alone and with unit process noise per
//    RTN axis; Q per regime by maximum likelihood on the fit week (fit).
// 3. Coverage of P(t) on the held-out week (test). hpop-calibration.json
//    labels a stratum CALIBRATED only when it passes there.
// Element sets stay on this machine; only aggregates are written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import * as flatbuffers from 'flatbuffers';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { MPE, meanElementSource } from 'spacedatastandards.org/lib/js/MPE/main.js';
import { OEM } from 'spacedatastandards.org/lib/js/OEM/main.js';
import { moduleHarness, readSets, pack, referenceStates, shiftDay, json } from './archive.mjs';

const { values: args } = parseArgs({ options: {
  reference: { type: 'string' },
  'fit-from': { type: 'string' }, 'fit-to': { type: 'string' }, 'test-from': { type: 'string' }, 'test-to': { type: 'string' },
  archive: { type: 'string', default: '/opt/data/sdn-archive/spacetrack/gp_history/by-creation' },
  out: { type: 'string', default: process.env.SDN_GP_ERROR_MODEL_DIR ?? path.join(os.homedir(), '.cache', 'sdn-gp-error-model') },
  workers: { type: 'string', default: String(Math.max(1, Math.min(12, os.availableParallelism() - 2))) },
  interval: { type: 'string', default: '600' },
  'max-arcs': { type: 'string' },
} });
for (const k of ['reference', 'fit-from', 'fit-to', 'test-from', 'test-to']) if (!args[k]) throw new Error(`--${k} is required`);
if (Date.parse(args['fit-to']) >= Date.parse(args['test-from'])) throw new Error('the fit window must end before the test window starts');
const modules = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const out = path.resolve(args.out);
fs.mkdirSync(out, { recursive: true });
const write = (name, value) => fs.writeFileSync(path.join(out, name), `${JSON.stringify(value, null, 1)}\n`);
const interval = Number(args.interval);
const fitWindow = [`${args['fit-from']}T00:00:00Z`, `${shiftDay(args['fit-to'], 1)}T00:00:00Z`];
const testWindow = [`${args['test-from']}T00:00:00Z`, `${shiftDay(args['test-to'], 1)}T00:00:00Z`];

const h = await moduleHarness();
const ref = referenceStates(path.resolve(args.reference), args['fit-from'], args['test-to']);
const sets = readSets(args.archive, shiftDay(args['fit-from'], -7), args['test-to'], (n) => ref.objects.has(n));
const elements = pack(sets);
const index = new Map(sets.norad.map((n, i) => [`${n}|${sets.epoch[i]}`, i]));

// GCRF epoch states from analysis/epoch-state, the HPOP screen's seeds.
async function seeds(arcs) {
  const dir = path.join(modules, 'analysis/epoch-state');
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(path.join(dir, 'dist/isomorphic/module.wasm')),
    manifest: JSON.parse(fs.readFileSync(path.join(dir, 'plugin-manifest.json'), 'utf8')), surface: 'direct' });
  const FIELDS = ['MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR'];
  const setters = ['addMeanMotion', 'addEccentricity', 'addInclination', 'addRaOfAscNode', 'addArgOfPericenter', 'addMeanAnomaly', 'addBstar'];
  const unixSeconds = (text) => {
    const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z?$/.exec(text.trim());
    return Date.parse(`${m[1]}Z`) / 1000 + (m[2] ? Number(`0${m[2]}`) : 0);
  };
  const frames = arcs.map((arc) => {
    const i = index.get(`${arc.norad}|${arc.epoch}`);
    if (i === undefined) throw new Error(`no element set for arc ${arc.arc}`);
    const b = new flatbuffers.Builder(256);
    const id = b.createString(`ARC:${arc.arc}`);
    MPE.startMPE(b);
    MPE.addEntityId(b, id);
    MPE.addEpoch(b, unixSeconds(sets.epoch[i]));
    FIELDS.forEach((_, k) => MPE[setters[k]](b, sets.values[k][i]));
    MPE.addMeanElementTheory(b, meanElementSource.SGP4);
    MPE.finishSizePrefixedMPEBuffer(b, MPE.endMPE(b));
    return b.asUint8Array();
  });
  const sizes = frames.map((f) => f.length + ((8 - (f.length % 8)) % 8));
  const payload = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
  let at = 0;
  frames.forEach((f, i) => { payload.set(f, at); at += sizes[i]; });
  const res = await harness.invoke({ methodId: 'derive', inputs: [{ portId: 'elements', payload,
    typeRef: { schemaName: 'MPE.fbs', fileIdentifier: '$MPE', rootTypeName: 'MPE', wireFormat: 'aligned-binary', requiredAlignment: 8, byteLength: payload.byteLength } }] });
  await harness.destroy();
  if (res.statusCode !== 0) throw new Error(`epoch-state: ${res.errorCode}: ${res.errorMessage}`);
  const states = new Map();
  const bytes = res.outputs.find((f) => f.portId === 'states')?.payload ?? new Uint8Array();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let p = 0; p + 4 <= bytes.length;) {
    const n = view.getUint32(p, true);
    if (n === 0) { p += 4; continue; }
    const oem = OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(bytes.slice(p, p + 4 + n))).unpack();
    const block = oem.EPHEMERIS_DATA_BLOCK[0], line = block.EPHEMERIS_DATA_LINES[0];
    states.set(Number(/^ARC:(\d+)$/.exec(block.OBJECT.OBJECT_ID)[1]),
      { epoch: line.EPOCH, position: [line.X, line.Y, line.Z], velocity: [line.X_DOT, line.Y_DOT, line.Z_DOT] });
    p += 4 + n;
  }
  return states;
}

const thin = (plan) => {
  const n = Number(args['max-arcs'] ?? 0);
  if (n > 0 && plan.arcs.length > n) plan.arcs = plan.arcs.filter((_, i) => i % Math.ceil(plan.arcs.length / n) === 0);
  return plan;
};

// HPOP at every arc's targets, spread over worker threads.
async function propagate(plan, variants) {
  const states = await seeds(plan.arcs);
  const arcs = plan.arcs.filter((a) => states.has(a.arc)).map((a) => ({ arc: a.arc, norad: a.norad, seed: states.get(a.arc),
    covariance: a.covariance, targets: a.targets.map((t) => t.epoch) }));
  const count = Math.min(Number(args.workers), arcs.length);
  const hpop = path.join(modules, 'propagator/hpop');
  let finished = 0;
  const started = performance.now();
  const parts = await Promise.all(Array.from({ length: count }, (_, w) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./hpop-calibration-worker.mjs', import.meta.url));
    worker.on('message', (m) => {
      if (m.progress) {
        if (++finished % 100 === 0) process.stderr.write(`\r${finished}/${arcs.length} arcs, ${((performance.now() - started) / 1000).toFixed(0)} s`);
        return;
      }
      worker.terminate();
      m.error ? reject(new Error(m.error)) : resolve(m.results);
    });
    worker.on('error', reject);
    worker.postMessage({ wasmPath: path.join(hpop, 'dist/isomorphic/module.wasm'), manifestPath: path.join(hpop, 'plugin-manifest.json'),
      id: `calibration-${w}`, arcs: arcs.filter((_, i) => i % count === w), variants, interval });
  })));
  process.stderr.write('\n');
  const results = parts.flat();
  const errors = results.flatMap((r) => r.samples.filter((s) => s.error).map((s) => s.error));
  console.log(`HPOP ${variants.join('+')}: ${results.length} arcs, ${results.reduce((n, r) => n + r.samples.length, 0)} targets, ` +
    `${errors.length} failed, ${((performance.now() - started) / 1000).toFixed(0)} s`);
  return { arcs: results.map((r) => ({ arc: r.arc, samples: r.samples.map((s) => (s.error ? null : s)) })), errors: errors.slice(0, 20),
    seedsRefused: plan.arcs.length - arcs.length };
}

// ── 1. P0 per regime, fit week ──
const plan0 = thin(await h.call('hpop_arcs', [elements, ...ref.frames, json('options', { targetAgesDays: [0] })]));
const predicted0 = await propagate(plan0, ['state']);
const model0 = await h.call('hpop_coverage', [json('plan', plan0), json('predictions', predicted0),
  json('options', { mode: 'epoch', window: fitWindow })]);

// ── 2. P0 alone and unit process noise per axis; Q fitted on the fit week ──
const plan = thin(await h.call('hpop_arcs', [elements, ...ref.frames, json('model', model0)]));
const predicted = await propagate(plan, ['a', 'u0', 'u1', 'u2']);
const model = await h.call('hpop_coverage', [json('plan', plan), json('predictions', predicted), json('model', model0),
  json('options', { mode: 'fit', window: fitWindow, discretizationSeconds: interval })]);
model.fitWindow = fitWindow;
model.product = 'analysis/epoch-state GCRF state at the element-set epoch, propagated by propagator/hpop resident ' +
  '(point mass and degree/order 20 field, RK78 60/0.01/600 s, 1e-12, analytic STM)';
write('hpop-covariance-model.json', model);

// ── 3. held-out coverage, and in-sample for comparison ──
const coverage = (window) => h.call('hpop_coverage', [json('plan', plan), json('predictions', predicted), json('model', model),
  json('options', { mode: 'test', window })]);
const test = await coverage(testWindow);
const fit = await coverage(fitWindow);
write('hpop-coverage-test.json', test);
write('hpop-coverage-fit.json', fit);
const products = [...new Set([...ref.objects.values()].flatMap((s) => [...s]))].sort();
const strata = test.strata.map((s) => {
  const c = s.coverage;
  const row = { regime: s.regime, regimeIndex: s.regimeIndex, ageDays: s.ageDays, ageIndex: s.ageIndex,
    spectralDensityM2S3: s.spectralDensityM2S3, coverage: c, coverageP0Only: s.coverageP0Only };
  if (c.status === 'CALIBRATED') {
    const f = (a) => a.map((x) => x.toFixed(3)).join('/');
    row.label = 'CALIBRATED';
    row.reference = `Held-out coverage against reference states ${testWindow.join('..')} (${products.join(', ')}; ${c.n} samples, ` +
      `${c.objects} objects): inside 1/2/3 sigma ${f(c.inside)} vs ${f(test.gate.nominal)}; P0 and Q fitted on ${fitWindow.join('..')}.`;
  } else {
    row.label = 'UNCALIBRATED';
    row.reason = `${c.status} on held-out reference states ${testWindow.join('..')}`;
  }
  return row;
});
write('hpop-calibration.json', { kind: 'hpop-covariance-calibration', version: 1, model: 'hpop-covariance-model.json',
  product: model.product, fit: { window: fitWindow }, test: { window: testWindow }, products, gate: test.gate,
  counts: { plan: plan.counts, epochPlan: plan0.counts, hpopFailures: predicted.errors.length, seedsRefused: predicted.seedsRefused, test: test.counts },
  covariance: 'HPOP P(t) = Phi P0 Phi^T + Q, position block, zero mean, GCRF', strata });
await h.destroy();
const count = (label) => strata.filter((s) => s.label === label).length;
console.log(`${out}: ${count('CALIBRATED')} CALIBRATED, ${count('UNCALIBRATED')} UNCALIBRATED`);
for (const r of model.regimes) console.log(`${r.regime}: P0 from ${r.kept}/${r.n} (${r.objects} objects), q ${JSON.stringify(r.processNoise?.spectralDensityM2S3 ?? null)}`);
