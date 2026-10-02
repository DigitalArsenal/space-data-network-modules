// Shared by build-model.mjs and calibration-gate.mjs: the module harness, GP
// history reading (element sets stay on this machine), $OMM packing, object
// batches, reference states by window, and the two-pass accumulation.
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';

const sdsRoot = path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const flatbuffers = createRequire(path.join(sdsRoot, 'package.json'))('flatbuffers');
const OMM = await import(pathToFileURL(path.join(sdsRoot, 'lib/js/OMM/main.js')));

export const json = (portId, value) => ({ portId, payload: Buffer.from(JSON.stringify(value)), typeRef: { schemaName: 'application/json' } });
const oemType = { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' };

export async function moduleHarness() {
  const wasm = fs.readFileSync(fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url)));
  const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  return {
    async call(methodId, inputs) {
      const r = await h.invoke({ methodId, inputs });
      if (r.statusCode !== 0) throw new Error(`${methodId}: ${r.errorMessage}`);
      return JSON.parse(Buffer.from(r.outputs[0].payload).toString());
    },
    destroy: () => h.destroy(),
  };
}

export function days(from, to) {
  const list = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) list.push(new Date(t).toISOString().slice(0, 10));
  return list;
}
export const shiftDay = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const FIELDS = ['MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR'];
export function readSets(archive, from, to, keep = () => true) {
  const sets = { norad: [], epoch: [], values: FIELDS.map(() => []) };
  let files = 0;
  for (const day of days(from, to)) {
    const file = path.join(archive, day.slice(0, 4), `${day}.json.gz`);
    if (!fs.existsSync(file)) { console.warn(`missing ${file}`); continue; }
    ++files;
    for (const g of JSON.parse(gunzipSync(fs.readFileSync(file)))) {
      const norad = Number(g.NORAD_CAT_ID);
      if (g.MEAN_ELEMENT_THEORY !== 'SGP4' || String(g.EPHEMERIS_TYPE) !== '0' || !keep(norad, g)) continue;
      sets.norad.push(norad);
      sets.epoch.push(g.EPOCH);
      FIELDS.forEach((f, i) => sets.values[i].push(Number(g[f])));
    }
  }
  console.log(`${from}..${to}: ${files} files, ${sets.norad.length} SGP4 element sets`);
  return sets;
}

export function pack(sets, indices = sets.norad.map((_, i) => i)) {
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

// Whole objects per batch, about `size` element sets each.
export function batches(sets, size) {
  const order = sets.norad.map((_, i) => i).sort((a, b) => sets.norad[a] - sets.norad[b]);
  const list = [];
  let current = [];
  for (let k = 0; k < order.length; ++k) {
    current.push(order[k]);
    const end = k + 1 === order.length || sets.norad[order[k + 1]] !== sets.norad[order[k]];
    if (end && current.length >= size) { list.push(current); current = []; }
  }
  if (current.length) list.push(current);
  return list;
}

const productKinds = [['ilrsa.', 'ILRS'], ['nsgf.', 'ILRS NSGF'], ['IGS', 'IGS'], ['S1', 'Sentinel-1'], ['SW_', 'Swarm']];
const productKind = (dir) => {
  const kind = productKinds.find(([prefix]) => dir.startsWith(prefix));
  if (!kind) throw new Error(`unknown reference product ${dir}`);
  return kind[1];
};

// Reference states (analysis/reference-states output) whose span starts in [from, to].
export function referenceStates(dir, from, to) {
  const frames = [];
  const objects = new Map();  // norad -> product kinds
  const lo = Date.parse(`${from}T00:00:00Z`) - 3600000, hi = Date.parse(`${to}T00:00:00Z`) + 86400000;
  for (const product of fs.readdirSync(dir).sort()) {
    const index = path.join(dir, product, 'index.json');
    if (!fs.existsSync(index)) continue;
    for (const o of JSON.parse(fs.readFileSync(index)).objects) {
      const start = Date.parse(o.start);
      if (!(start >= lo && start < hi)) continue;
      frames.push({ portId: 'reference', payload: fs.readFileSync(path.join(dir, product, o.file)), typeRef: oemType });
      if (!objects.has(o.norad)) objects.set(o.norad, new Set());
      objects.get(o.norad).add(productKind(product));
    }
  }
  return { frames, objects };
}

// Accumulate over batches, finalize, clip at k robust sigma and do it again.
export async function twoPasses(h, label, packed, extra = [], k = 5) {
  let acc = null;
  for (const p of packed) acc = await h.call('accumulate', [p, ...extra, ...(acc ? [json('prior', acc)] : [])]);
  const first = await h.call('finalize', [json('accumulator', acc)]);
  const clip = { k, strata: first.strata.filter((s) => s.n > 1).map((s) => ({
    regime: s.regimeIndex, age: s.ageIndex, centre: s.median.slice(0, 3), scale: s.robustSigma.slice(0, 3).map((x) => Math.max(x, 1e-6)) })) };
  acc = null;
  for (const p of packed) acc = await h.call('accumulate', [p, ...extra, json('options', { clip }), ...(acc ? [json('prior', acc)] : [])]);
  const model = await h.call('finalize', [json('accumulator', acc)]);
  console.log(`${label}: ${model.counts.samples} samples in ${model.strata.length} strata`);
  return model;
}
