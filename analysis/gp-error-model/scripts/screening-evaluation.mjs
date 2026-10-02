#!/usr/bin/env node
// Screening evaluation on held-out reference states (ASO catalog paper
// section 12): probabilistic, bounded-set and possibility screening scored on
// cases built from real GP prediction errors.
//
//   node scripts/screening-evaluation.mjs --model docs/model-2026-08-scaled.json \
//     --calibration docs/calibration-2026-08.json --reference <reference-states>/reference \
//     --from 2026-08-09 --to 2026-08-15 [--archive DIR] [--out DIR] [--pairs 500]
//
// Each stratum keeps its calibration label; the summary is given for the
// CALIBRATED strata and for all strata.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { moduleHarness, readSets, pack, referenceStates, shiftDay, json } from './archive.mjs';

const { values: args } = parseArgs({ options: {
  model: { type: 'string' }, calibration: { type: 'string' }, reference: { type: 'string' },
  from: { type: 'string' }, to: { type: 'string' }, pairs: { type: 'string', default: '500' },
  archive: { type: 'string', default: '/opt/data/sdn-archive/spacetrack/gp_history/by-creation' },
  out: { type: 'string', default: process.env.SDN_GP_ERROR_MODEL_DIR ?? path.join(os.homedir(), '.cache', 'sdn-gp-error-model') },
} });
for (const k of ['model', 'calibration', 'reference', 'from', 'to']) if (!args[k]) throw new Error(`--${k} is required`);
const model = JSON.parse(fs.readFileSync(args.model));
const calibration = JSON.parse(fs.readFileSync(args.calibration));
const ref = referenceStates(path.resolve(args.reference), args.from, args.to);
const sets = readSets(args.archive, shiftDay(args.from, -7), shiftDay(args.to, 1), (n) => ref.objects.has(n));
const h = await moduleHarness();
const report = await h.call('screening_evaluation', [pack(sets), ...ref.frames, json('model', model),
  json('options', { pairsPerStratum: Number(args.pairs) })]);
await h.destroy();

const label = (s) => calibration.strata.find((c) => c.regimeIndex === s.regimeIndex && c.ageIndex === s.ageIndex)?.label ?? 'UNCALIBRATED';
for (const s of report.strata) s.label = label(s);
// Case-weighted rates over a set of strata, per geometry and miss.
function summary(strata) {
  const out = {};
  for (const s of strata) for (const g of s.geometries) {
    out[g.geometry] ??= g.rows.map((r) => ({ missM: r.missM, collision: r.collision, cases: 0, pcAlertRate: 0, meanPc: 0, brier: 0,
      boundedSetAlertRate: 0, possibilityAlertRate: 0, meanPossibilityOfCollision: 0 }));
    g.rows.forEach((r, i) => {
      const o = out[g.geometry][i];
      for (const k of ['pcAlertRate', 'meanPc', 'brier', 'boundedSetAlertRate', 'possibilityAlertRate', 'meanPossibilityOfCollision']) o[k] += r[k] * r.cases;
      o.cases += r.cases;
    });
  }
  for (const rows of Object.values(out)) for (const o of rows) if (o.cases)
    for (const k of ['pcAlertRate', 'meanPc', 'brier', 'boundedSetAlertRate', 'possibilityAlertRate', 'meanPossibilityOfCollision']) o[k] /= o.cases;
  return out;
}
const result = { ...report, model: path.basename(args.model), calibration: path.basename(args.calibration),
  window: [args.from, args.to], products: [...new Set([...ref.objects.values()].flatMap((s) => [...s]))].sort(),
  summary: { calibrated: summary(report.strata.filter((s) => s.label === 'CALIBRATED')), all: summary(report.strata) },
  disclosure: 'Baselines and cases were chosen independently of the TEAG/ESPF authors\' implementations; no TEAG/ESPF code was run. ' +
    'The possibility rule implements the admissible-set framework as described in the ASO catalog paper, section 12.' };
fs.mkdirSync(args.out, { recursive: true });
const file = path.join(path.resolve(args.out), 'screening-evaluation.json');
fs.writeFileSync(file, `${JSON.stringify(result, null, 1)}\n`);
console.log(`${file}: ${report.strata.length} strata (${report.strata.filter((s) => s.label === 'CALIBRATED').length} calibrated), ` +
  `${report.counts.samples} samples`);
