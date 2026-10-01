#!/usr/bin/env node
// Builds the GP prediction-error model from the GP history archive and
// validates it against independent reference states.
//
//   node scripts/build-model.mjs --train-from 2026-07-12 --train-to 2026-08-08 \
//     --truth /opt/data/sdn-archive/reference-states/reference \
//     --truth-from 2026-08-02 --truth-to 2026-08-16 [--archive DIR] [--out DIR]
//
// Training: element sets created in [train-from, train-to] (UTC days of the
// archive's by-creation files), all objects, consecutive-set differences.
// Truth: element sets created in [truth-from, truth-to] for the objects that
// have reference states, compared with those states (analysis/reference-states).
// Each runs twice: once for robust centre and scale per stratum, then with
// samples beyond 5 robust sigma (any position component) clipped.
// Writes model.json, truth.json and validation.json to --out (default
// ~/.cache/sdn-gp-error-model). Element sets never leave the machine; the
// outputs are aggregate statistics.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';

const { values: args } = parseArgs({ options: {
  'train-from': { type: 'string' }, 'train-to': { type: 'string' },
  truth: { type: 'string' }, 'truth-from': { type: 'string' }, 'truth-to': { type: 'string' },
  archive: { type: 'string', default: '/opt/data/sdn-archive/spacetrack/gp_history/by-creation' },
  out: { type: 'string', default: process.env.SDN_GP_ERROR_MODEL_DIR ?? path.join(os.homedir(), '.cache', 'sdn-gp-error-model') },
  'batch-sets': { type: 'string', default: '150000' }, clip: { type: 'string', default: '5' },
} });
for (const k of ['train-from', 'train-to', 'truth', 'truth-from', 'truth-to'])
  if (!args[k]) throw new Error(`--${k} is required`);
const out = path.resolve(args.out);
fs.mkdirSync(out, { recursive: true });

const sdsRoot = path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const flatbuffers = createRequire(path.join(sdsRoot, 'package.json'))('flatbuffers');
const OMM = await import(pathToFileURL(path.join(sdsRoot, 'lib/js/OMM/main.js')));
const wasm = fs.readFileSync(fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
const harness = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
const json = (portId, value) => ({ portId, payload: Buffer.from(JSON.stringify(value)), typeRef: { schemaName: 'application/json' } });
async function call(methodId, inputs) {
  const r = await harness.invoke({ methodId, inputs });
  if (r.statusCode !== 0) throw new Error(`${methodId}: ${r.errorMessage}`);
  return JSON.parse(Buffer.from(r.outputs[0].payload).toString());
}

// ── element sets from the archive, kept as columns until packed ──
const days = (from, to) => {
  const list = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) list.push(new Date(t).toISOString().slice(0, 10));
  return list;
};
const FIELDS = ['MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR'];
function readSets(from, to, keep = () => true) {
  const sets = { norad: [], epoch: [], values: FIELDS.map(() => []) };
  let files = 0;
  for (const day of days(from, to)) {
    const file = path.join(args.archive, day.slice(0, 4), `${day}.json.gz`);
    if (!fs.existsSync(file)) { console.warn(`missing ${file}`); continue; }
    ++files;
    for (const g of JSON.parse(gunzipSync(fs.readFileSync(file)))) {
      const norad = Number(g.NORAD_CAT_ID);
      if (g.MEAN_ELEMENT_THEORY !== 'SGP4' || String(g.EPHEMERIS_TYPE) !== '0' || !keep(norad)) continue;
      sets.norad.push(norad);
      sets.epoch.push(g.EPOCH);
      FIELDS.forEach((f, i) => sets.values[i].push(Number(g[f])));
    }
  }
  console.log(`${from}..${to}: ${files} files, ${sets.norad.length} SGP4 element sets`);
  return sets;
}
function pack(sets, indices) {
  const parts = [];
  for (const i of indices) {
    const t = new OMM.OMMT();
    t.EPOCH = sets.epoch[i];
    t.NORAD_CAT_ID = sets.norad[i];
    t.MEAN_ELEMENT_THEORY = OMM.meanElementSource.SGP4;
    FIELDS.forEach((f, k) => { t[f] = sets.values[k][i]; });
    const b = new flatbuffers.Builder(256);
    OMM.OMM.finishSizePrefixedOMMBuffer(b, t.pack(b));
    parts.push(Buffer.from(b.asUint8Array()));
  }
  return { portId: 'elements', payload: Buffer.concat(parts), typeRef: { schemaName: 'OMM.fbs', fileIdentifier: '$OMM', rootTypeName: 'OMM', wireFormat: 'flatbuffer' } };
}
// Whole objects per batch, about batch-sets element sets each.
function batches(sets) {
  const order = sets.norad.map((_, i) => i).sort((a, b) => sets.norad[a] - sets.norad[b]);
  const list = [];
  let current = [];
  for (let k = 0; k < order.length; ++k) {
    current.push(order[k]);
    const end = k + 1 === order.length || sets.norad[order[k + 1]] !== sets.norad[order[k]];
    if (end && current.length >= Number(args['batch-sets'])) { list.push(current); current = []; }
  }
  if (current.length) list.push(current);
  return list;
}

async function twoPasses(label, packed, extra = []) {
  let acc = null;
  for (const p of packed) acc = await call('accumulate', [p, ...extra, ...(acc ? [json('prior', acc)] : [])]);
  const first = await call('finalize', [json('accumulator', acc)]);
  const clip = { k: Number(args.clip), strata: first.strata.filter((s) => s.n > 1).map((s) => ({
    regime: s.regimeIndex, age: s.ageIndex, centre: s.median.slice(0, 3), scale: s.robustSigma.slice(0, 3).map((x) => Math.max(x, 1e-6)) })) };
  acc = null;
  for (const p of packed) acc = await call('accumulate', [p, ...extra, json('options', { clip }), ...(acc ? [json('prior', acc)] : [])]);
  const model = await call('finalize', [json('accumulator', acc)]);
  console.log(`${label}: ${model.counts.samples} samples in ${model.strata.length} strata`);
  return model;
}

// ── training ──
const train = readSets(args['train-from'], args['train-to']);
const trainBatches = batches(train).map((b) => pack(train, b));
const model = await twoPasses('model', trainBatches);
model.window = { creation: [args['train-from'], args['train-to']], archive: 'Space-Track GP history, by creation date' };
fs.writeFileSync(path.join(out, 'model.json'), `${JSON.stringify(model, null, 1)}\n`);

// ── truth ──
const truthDir = path.resolve(args.truth);
const reference = [];
const truthObjects = new Map();  // norad -> products
for (const product of fs.readdirSync(truthDir)) {
  const index = path.join(truthDir, product, 'index.json');
  if (!fs.existsSync(index)) continue;
  for (const o of JSON.parse(fs.readFileSync(index)).objects) {
    reference.push({ portId: 'reference', payload: fs.readFileSync(path.join(truthDir, product, o.file)), typeRef: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' } });
    if (!truthObjects.has(o.norad)) truthObjects.set(o.norad, new Set());
    truthObjects.get(o.norad).add(product.split(/[._]/)[0] === 'ilrsa' ? 'ILRS' : product.slice(0, 3));
  }
}
const truthSets = readSets(args['truth-from'], args['truth-to'], (n) => truthObjects.has(n));
const truth = await twoPasses('truth', [pack(truthSets, truthSets.norad.map((_, i) => i))], reference);
const withSets = new Set(truthSets.norad);
truth.window = { creation: [args['truth-from'], args['truth-to']], reference: truthDir, objects: [...truthObjects.keys()].sort((a, b) => a - b),
  objectsWithoutElementSets: [...truthObjects.keys()].filter((n) => !withSets.has(n)).sort((a, b) => a - b) };
fs.writeFileSync(path.join(out, 'truth.json'), `${JSON.stringify(truth, null, 1)}\n`);

// ── validation: clipped sigma per component, truth over model ──
const sigma = (s) => (s.clipped?.covariance ? [0, 2, 5].map((i) => Math.sqrt(s.clipped.covariance[i])) : null);
const validation = { model: path.join(out, 'model.json'), truth: path.join(out, 'truth.json'), minimumTruthSamples: 30, strata: [] };
for (const m of model.strata) {
  const t = truth.strata.find((x) => x.regime === m.regime && x.ageIndex === m.ageIndex);
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
await harness.destroy();
console.log(`wrote ${out}/model.json, truth.json, validation.json`);
