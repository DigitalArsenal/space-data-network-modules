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
import { moduleHarness, readSets, pack, referenceStates, shiftDay, json } from './archive.mjs';
import { epochStates, propagateArcs, unixSeconds } from './hpop.mjs';

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
const seeds = (arcs) => epochStates(arcs.map((arc) => {
  const i = index.get(`${arc.norad}|${arc.epoch}`);
  if (i === undefined) throw new Error(`no element set for arc ${arc.arc}`);
  return { key: arc.arc, epoch: unixSeconds(sets.epoch[i]), values: sets.values.map((v) => v[i]) };
}));

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
  const { results, seconds } = await propagateArcs(arcs, { variants, interval, workers: Number(args.workers) });
  const errors = results.flatMap((r) => r.samples.filter((s) => s.error).map((s) => s.error));
  console.log(`HPOP ${variants.join('+')}: ${results.length} arcs, ${results.reduce((n, r) => n + r.samples.length, 0)} targets, ` +
    `${errors.length} failed, ${seconds.toFixed(0)} s`);
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
