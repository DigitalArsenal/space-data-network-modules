#!/usr/bin/env node
// Covariance calibration gate for the GP prediction-error model.
//
//   node scripts/calibration-gate.mjs --model docs/model-2026-08.json \
//     --reference <reference-states>/reference \
//     --fit-from 2026-08-02 --fit-to 2026-08-08 --test-from 2026-08-09 --test-to 2026-08-15 \
//     [--archive DIR] [--out DIR]
//
// 1. Fit: reference-state errors in the fit window (clipped at 5 robust
//    sigma) scale each stratum's position covariance (scale_model).
// 2. Test, held out: coverage of the model and of the scaled model against
//    the reference states of the test window. Every sample counts.
// 3. calibration.json labels a stratum CALIBRATED only when the scaled model
//    passes the gate on the test window; every other stratum is UNCALIBRATED,
//    with the reason. Coverage of both models is kept, failures included.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { moduleHarness, readSets, pack, referenceStates, twoPasses, shiftDay, json } from './archive.mjs';

const { values: args } = parseArgs({ options: {
  model: { type: 'string' }, reference: { type: 'string' },
  'fit-from': { type: 'string' }, 'fit-to': { type: 'string' }, 'test-from': { type: 'string' }, 'test-to': { type: 'string' },
  archive: { type: 'string', default: '/opt/data/sdn-archive/spacetrack/gp_history/by-creation' },
  out: { type: 'string', default: process.env.SDN_GP_ERROR_MODEL_DIR ?? path.join(os.homedir(), '.cache', 'sdn-gp-error-model') },
} });
for (const k of ['model', 'reference', 'fit-from', 'fit-to', 'test-from', 'test-to']) if (!args[k]) throw new Error(`--${k} is required`);
if (Date.parse(args['fit-to']) >= Date.parse(args['test-from'])) throw new Error('the fit window must end before the test window starts');
const out = path.resolve(args.out);
fs.mkdirSync(out, { recursive: true });
const write = (name, value) => fs.writeFileSync(path.join(out, name), `${JSON.stringify(value, null, 1)}\n`);
const h = await moduleHarness();
const model = JSON.parse(fs.readFileSync(args.model));

function evidence(from, to) {
  const ref = referenceStates(path.resolve(args.reference), from, to);
  const sets = readSets(args.archive, shiftDay(from, -7), shiftDay(to, 1), (n) => ref.objects.has(n));
  const products = [...new Set([...ref.objects.values()].flatMap((s) => [...s]))].sort();
  return { ...ref, elements: pack(sets), products, window: [from, to] };
}

// ── fit ──
const fit = evidence(args['fit-from'], args['fit-to']);
const truthFit = await twoPasses(h, 'fit', [fit.elements], fit.frames);
truthFit.window = { reference: fit.window, products: fit.products, objects: [...fit.objects.keys()].sort((a, b) => a - b) };
write('truth-fit.json', truthFit);
const scaled = await h.call('scale_model', [json('model', model), json('truth', truthFit)]);
write('model-scaled.json', scaled);

// ── test, held out ──
const test = evidence(args['test-from'], args['test-to']);
async function coverage(m) {
  const acc = await h.call('accumulate', [test.elements, ...test.frames, json('model', m)]);
  return h.call('finalize', [json('accumulator', acc)]);
}
const raw = await coverage(model);
const cal = await coverage(scaled);
write('coverage-model.json', raw);
write('coverage-scaled.json', cal);

// ── labels ──
const nominal = cal.gate.nominal;
const pick = (s) => s && s.coverage && { status: s.coverage.status, n: s.coverage.n, objects: s.coverage.objects,
  inside: s.coverage.inside, meanD2: s.coverage.meanD2, pitMaxCdfGap: s.coverage.pitMaxCdfGap };
const strata = model.strata.map((m) => {
  const r = raw.strata.find((x) => x.regimeIndex === m.regimeIndex && x.ageIndex === m.ageIndex);
  const c = cal.strata.find((x) => x.regimeIndex === m.regimeIndex && x.ageIndex === m.ageIndex);
  const factors = scaled.strata.find((x) => x.regimeIndex === m.regimeIndex && x.ageIndex === m.ageIndex)?.scale?.factors ?? null;
  const row = { regime: m.regime, regimeIndex: m.regimeIndex, ageDays: m.ageDays, ageIndex: m.ageIndex, scaleFactors: factors,
    model: pick(r) ?? null, scaled: pick(c) ?? null };
  if (c?.coverage?.status === 'CALIBRATED') {
    const f = (a) => a.map((x) => x.toFixed(3)).join('/');
    row.label = 'CALIBRATED';
    row.reference = `Held-out coverage against reference states ${test.window.join('..')} (${test.products.join(', ')}; ` +
      `${c.coverage.n} samples, ${c.coverage.objects} objects): inside 1/2/3 sigma ${f(c.coverage.inside)} vs ${f(nominal)}; ` +
      `scale fitted on ${fit.window.join('..')}.`;
  } else {
    row.label = 'UNCALIBRATED';
    row.reason = !c ? 'no independent reference states in this regime and age'
      : !factors ? 'no fit-window reference states to scale this stratum'
        : `${c.coverage.status} on held-out reference states ${test.window.join('..')}`;
  }
  return row;
});
write('calibration.json', { kind: 'gp-error-model-calibration', version: 1, model: path.basename(args.model), scaledModel: 'model-scaled.json',
  fit: { window: fit.window, products: fit.products }, test: { window: test.window, products: test.products }, gate: cal.gate,
  covariance: 'position covariance of the stratum (clipped), zero mean, RTN', strata });
await h.destroy();
const count = (label) => strata.filter((s) => s.label === label).length;
console.log(`wrote ${out}: ${count('CALIBRATED')} CALIBRATED, ${count('UNCALIBRATED')} UNCALIBRATED strata`);
