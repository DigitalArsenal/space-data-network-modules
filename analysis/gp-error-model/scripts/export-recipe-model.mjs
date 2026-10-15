#!/usr/bin/env node
// The element-set covariance model of the catalog pipeline, in the form attach_covariance reads: orbit-accuracy-experiments
// E14's frozen S3-KC model (a 6x6 RTN covariance per orbit regime and prediction age) with, for every cell, the verdict of
// E14's held-out test window and the numbers behind it. Aggregates only: no element sets and no per-sample tables.
//
//   node scripts/export-recipe-model.mjs --model results/e14/models/s3-gp-error-model.json \
//     --calibration results/e14/models/s3-calibration.json --realism results/e14/test/s3-realism.json \
//     --selection results/e14/selection.json --commit <experiments commit> --out data/e14-s3-kc.json
//
// The inputs are files of orbit-accuracy-experiments at the commit named. Re-run when the experiments freeze a new model.
// Beside the readable JSON it writes the model as the module takes it: one $ERM MODEL record (<out without .json>.erm).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { encode } from './erm-codec.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[i + 1]]] : pairs), []));
for (const key of ['model', 'calibration', 'realism', 'selection', 'commit', 'out']) {
  if (!args[key]) throw new Error(`--${key} is required`);
}
const bytes = (file) => fs.readFileSync(file);
const sha256 = (file) => crypto.createHash('sha256').update(bytes(file)).digest('hex');
const read = (file) => JSON.parse(bytes(file).toString('utf8'));

const model = read(args.model), calibration = read(args.calibration), realism = read(args.realism), selection = read(args.selection);
if (model.kind !== 'gp-error-model' || calibration.kind !== 'gp-error-model-calibration') throw new Error('not a frozen E14 S3 model and calibration');
if (model.calibrationVersion !== calibration.calibrationVersion) throw new Error('model and calibration versions differ');
const candidate = selection.sources.S3.candidate;
if (selection.sources.S3.calibrationVersion !== model.calibrationVersion) throw new Error('selection.json names another S3 calibration version');
const test = realism.candidates?.[candidate]?.primary;
if (!test) throw new Error(`no test cells for ${candidate}`);

// Horizons are the centres of the age bins E14 scored: the test file's keys, in order.
const horizons = Object.keys(test[model.regimes[0].id]).map(Number).sort((a, b) => a - b);
if (horizons.length !== model.ageBinsDays.length) throw new Error('horizons and age bins differ in number');
const label = new Map(calibration.strata.map((s) => [`${s.regimeIndex}|${s.ageIndex}`, s]));

const cells = model.strata.map((s) => {
  const cell = test[s.regime]?.[String(horizons[s.ageIndex])];
  if (!cell) throw new Error(`no test cell for ${s.regime} at ${horizons[s.ageIndex]} d`);
  const verdict = label.get(`${s.regimeIndex}|${s.ageIndex}`);
  const calibrated = cell.decision === 'REALISTIC';
  if ((verdict.label === 'CALIBRATED') !== calibrated) throw new Error(`calibration label and test decision disagree for ${s.regime} at ${horizons[s.ageIndex]} d`);
  return {
    regimeIndex: s.regimeIndex, regime: s.regime, ageIndex: s.ageIndex, horizonDays: horizons[s.ageIndex],
    decision: cell.decision, calibration: calibrated ? 'CALIBRATED' : 'UNCALIBRATED',
    meanD2Over3: cell.meanD2Over3.estimate, coverage95: cell.coverage95.estimate, samples: cell.n, objects: cell.objects,
  };
});

const out = {
  kind: 'e14-s3-kc',
  id: model.calibrationVersion,
  calibrationVersion: model.calibrationVersion,
  candidate,
  basis: model.basis,
  // The held-out verdicts below were measured on Space-Track GP element sets (CelesTrak republishes them). A source with
  // another lineage uses this model as the pooled one and its cells are labeled uncalibrated for that source.
  measuredOn: {
    lineages: ['space-track-gp'],
    window: `${realism.span[0]}..${realism.span[1]}`,
    rule: calibration.rule,
    evidence: 'orbit-accuracy-experiments E14 test',
  },
  regimes: model.regimes,
  ageBinsDays: model.ageBinsDays,
  horizonsDays: horizons,
  strata: model.strata.map(({ regimeIndex, regime, ageIndex, n, covariance }) => ({ regimeIndex, regime, ageIndex, n, covariance })),
  cells,
  provenance: {
    repository: 'orbit-accuracy-experiments',
    commit: args.commit,
    files: Object.fromEntries(['model', 'calibration', 'realism', 'selection'].map((key) => [path.basename(args[key]), sha256(args[key])])),
  },
};
fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, `${JSON.stringify(out, null, 1)}\n`);
fs.writeFileSync(args.out.replace(/\.json$/, '') + '.erm', encode('model', out));
console.log(`wrote ${args.out}: ${out.strata.length} strata, ${cells.filter((c) => c.calibration === 'CALIBRATED').length} calibrated cells`);
