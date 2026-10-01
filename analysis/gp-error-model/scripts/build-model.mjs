#!/usr/bin/env node
// Builds the GP prediction-error model from the GP history archive and
// validates it against independent reference states.
//
//   node scripts/build-model.mjs --train-from 2026-07-12 --train-to 2026-08-08 \
//     --reference <reference-states>/reference --reference-from 2026-08-09 --reference-to 2026-08-15 \
//     [--archive DIR] [--out DIR]
//
// Training: element sets created in [train-from, train-to] (the archive's
// by-creation days), all objects, consecutive-set differences.
// Truth: reference states starting in [reference-from, reference-to], against
// the element sets of those objects created from 7 days before to 1 day after.
// Each runs twice: once for robust centre and scale per stratum, then with
// samples beyond 5 robust sigma (any position component) clipped.
// Writes model.json, truth.json and validation.json to --out (default
// ~/.cache/sdn-gp-error-model). Element sets never leave the machine; the
// outputs are aggregate statistics.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { moduleHarness, readSets, pack, batches, referenceStates, twoPasses, shiftDay } from './archive.mjs';

const { values: args } = parseArgs({ options: {
  'train-from': { type: 'string' }, 'train-to': { type: 'string' },
  reference: { type: 'string' }, 'reference-from': { type: 'string' }, 'reference-to': { type: 'string' },
  archive: { type: 'string', default: '/opt/data/sdn-archive/spacetrack/gp_history/by-creation' },
  out: { type: 'string', default: process.env.SDN_GP_ERROR_MODEL_DIR ?? path.join(os.homedir(), '.cache', 'sdn-gp-error-model') },
  'batch-sets': { type: 'string', default: '150000' }, clip: { type: 'string', default: '5' },
} });
for (const k of ['train-from', 'train-to', 'reference', 'reference-from', 'reference-to'])
  if (!args[k]) throw new Error(`--${k} is required`);
const out = path.resolve(args.out);
fs.mkdirSync(out, { recursive: true });
const h = await moduleHarness();

// ── training ──
const train = readSets(args.archive, args['train-from'], args['train-to']);
const model = await twoPasses(h, 'model', batches(train, Number(args['batch-sets'])).map((b) => pack(train, b)), [], Number(args.clip));
model.window = { creation: [args['train-from'], args['train-to']], archive: 'Space-Track GP history, by creation date' };
fs.writeFileSync(path.join(out, 'model.json'), `${JSON.stringify(model, null, 1)}\n`);

// ── truth ──
const { frames, objects } = referenceStates(path.resolve(args.reference), args['reference-from'], args['reference-to']);
const truthSets = readSets(args.archive, shiftDay(args['reference-from'], -7), shiftDay(args['reference-to'], 1), (n) => objects.has(n));
const truth = await twoPasses(h, 'truth', [pack(truthSets)], frames, Number(args.clip));
const withSets = new Set(truthSets.norad);
truth.window = { reference: [args['reference-from'], args['reference-to']], creation: [shiftDay(args['reference-from'], -7), shiftDay(args['reference-to'], 1)],
  objects: [...objects.keys()].sort((a, b) => a - b), objectsWithoutElementSets: [...objects.keys()].filter((n) => !withSets.has(n)).sort((a, b) => a - b) };
fs.writeFileSync(path.join(out, 'truth.json'), `${JSON.stringify(truth, null, 1)}\n`);

// ── validation: clipped sigma per component, truth over model ──
const sigma = (s) => (s.clipped?.covariance ? [0, 2, 5].map((i) => Math.sqrt(s.clipped.covariance[i])) : null);
const validation = { model: 'model.json', truth: 'truth.json', minimumTruthSamples: 30, strata: [] };
for (const m of model.strata) {
  const t = truth.strata.find((x) => x.regimeIndex === m.regimeIndex && x.ageIndex === m.ageIndex);
  const row = { regime: m.regime, ageDays: m.ageDays, modelN: m.n, modelSigmaKm: sigma(m), modelRobustSigmaKm: m.robustSigma.slice(0, 3) };
  if (t && t.n >= validation.minimumTruthSamples && sigma(t)) {
    Object.assign(row, { status: 'validated', truthN: t.n, truthSigmaKm: sigma(t), truthRobustSigmaKm: t.robustSigma.slice(0, 3),
      truthMeanKm: t.clipped.mean.slice(0, 3), ratio: sigma(t).map((x, i) => x / sigma(m)[i]) });
  } else {
    Object.assign(row, { status: 'unvalidated', truthN: t?.n ?? 0, reason: t ? 'fewer reference samples than the minimum' : 'no independent reference states in this regime' });
  }
  validation.strata.push(row);
}
fs.writeFileSync(path.join(out, 'validation.json'), `${JSON.stringify(validation, null, 1)}\n`);
await h.destroy();
console.log(`wrote ${out}/model.json, truth.json, validation.json`);
