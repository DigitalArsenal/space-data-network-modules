// The SDS bindings the module's ports carry ($LFV with its $OMM, $OEM), and
// the conversions between them and the histories the tests and the study
// build. The standards' TypeScript bindings are bundled in memory with the
// standards package's own esbuild and flatbuffers (SPACE_DATA_STANDARDS_ROOT,
// else the spacedatastandards.org package).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.env.SPACE_DATA_STANDARDS_ROOT
  ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const require = createRequire(path.join(root, 'package.json'));
const esbuild = require('esbuild');
// Every generated file of a family (a draft family's main.ts may not list them all yet).
const family = (code) => fs.readdirSync(path.join(root, 'lib/ts', code)).filter((f) => f.endsWith('.ts') && f !== 'main.ts')
  .map((f) => `export * from ${JSON.stringify(path.join(root, 'lib/ts', code, f))};`).join('\n');
const bundle = await esbuild.build({ stdin: { contents: `export * as LFV from 'lfv'; export * as OEM from 'oem';
export * as flatbuffers from ${JSON.stringify(require.resolve('flatbuffers'))};`, resolveDir: root, loader: 'ts' },
  bundle: true, format: 'esm', write: false, platform: 'neutral', mainFields: ['module', 'main'], logLevel: 'silent',
  plugins: [{ name: 'families', setup(b) {
    b.onResolve({ filter: /^(lfv|oem)$/ }, (a) => ({ path: a.path, namespace: 'family' }));
    b.onLoad({ filter: /.*/, namespace: 'family' }, (a) => ({ contents: family(a.path.toUpperCase()), resolveDir: root, loader: 'ts' }));
  } }] });
const sds = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
export const { LFV, OEM, flatbuffers } = sds;

export const Role = { real: LFV.lfvRole.Real, decoy: LFV.lfvRole.Decoy };
export const roleName = (r) => (r === LFV.lfvRole.Real ? 'real' : r === LFV.lfvRole.Decoy ? 'decoy' : 'unlabelled');

// Unix seconds as ISO 8601 UTC with nanosecond digits: a unix-seconds double
// of this era comes back exactly (the module parses whole seconds plus the
// fraction).
export function isoEpoch(t) {
  let whole = Math.floor(t);
  let frac = (t - whole).toFixed(9);
  if (frac.startsWith('1')) whole += 1, frac = '0.000000000';
  return new Date(whole * 1000).toISOString().replace(/\.\d{3}Z$/, `${frac.slice(1)}Z`);
}
export function unixEpoch(iso) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):(\d{2}(?:\.\d+)?)Z?$/.exec(iso);
  return Date.parse(`${m[1]}:00Z`) / 1000 + Number(m[2]);
}

function finish(obj, id) {
  const b = new flatbuffers.Builder(1 << 16);
  b.finish(obj.pack(b), id);
  return b.asUint8Array();
}

// Histories {id, target?, role?, generator?, cls?, t, n, e, i, raan, argp, ma, bstar} -> $LFV rows with $OMM sets.
export function historiesLfv(objects) {
  const lfv = new LFV.LFVT();
  lfv.ROWS = objects.map((o) => {
    const row = new LFV.LFVRowT();
    row.SOURCE_ID = o.id;
    row.TARGET = o.target ?? null;
    row.ROLE = o.role === 'decoy' ? Role.decoy : Role.real;
    row.GENERATOR = o.generator || null;
    row.CLASS_LABEL = o.cls || null;
    row.ELEMENT_SETS = (o.t ?? []).map((t, k) => {
      const m = new LFV.OMMT();
      m.EPOCH = isoEpoch(t);
      m.MEAN_MOTION = o.n[k], m.ECCENTRICITY = o.e[k], m.INCLINATION = o.i[k];
      m.RA_OF_ASC_NODE = o.raan[k], m.ARG_OF_PERICENTER = o.argp[k], m.MEAN_ANOMALY = o.ma[k], m.BSTAR = o.bstar[k];
      return m;
    });
    return row;
  });
  return finish(lfv, '$LFV');
}

// Windows {t, samples: [[t, x, y, z, vx, vy, vz]] (m, m/s), end} per history -> one $OEM, a block per window (km, km/s).
export function windowsOem(objects) {
  const oem = new OEM.OEMT();
  const line = (s) => {
    const l = new OEM.ephemerisDataLineT();
    l.EPOCH = isoEpoch(s[0]);
    [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT] = s.slice(1).map((v) => v * 1e-3);
    return l;
  };
  oem.EPHEMERIS_DATA_BLOCK = objects.flatMap((o) => (o.windows ?? []).map((w) => {
    const b = new OEM.ephemerisDataBlockT();
    b.OBJECT = new OEM.CATT();
    b.OBJECT.OBJECT_ID = o.id;
    b.START_TIME = isoEpoch(w.t);
    b.USEABLE_START_TIME = isoEpoch(w.samples[0][0]);
    b.USEABLE_STOP_TIME = isoEpoch(w.samples[w.samples.length - 1][0]);
    b.STOP_TIME = isoEpoch(w.end ? w.end[0] : w.samples[w.samples.length - 1][0]);
    b.EPHEMERIS_DATA_LINES = [...w.samples, ...(w.end ? [w.end] : [])].map(line);
    return b;
  }));
  return finish(oem, '$OEM');
}

// Feature rows {target, role, cls?, x} -> $LFV (null values as NaN).
export function featuresLfv({ view, names, rows }) {
  const lfv = new LFV.LFVT();
  lfv.VIEW = view ?? null;
  lfv.FEATURE_NAMES = names;
  lfv.ROWS = rows.map((r) => {
    const row = new LFV.LFVRowT();
    row.SOURCE_ID = r.id ?? null;
    row.TARGET = r.target ?? null;
    row.ROLE = r.role === 'real' ? Role.real : r.role === 'decoy' ? Role.decoy : LFV.lfvRole.Unlabelled;
    row.GENERATOR = r.generator || null;
    row.CLASS_LABEL = r.cls || null;
    row.VALUES = r.x.map((v) => (v === null ? NaN : v));
    return row;
  });
  return finish(lfv, '$LFV');
}

export function readLfv(bytes) {
  return LFV.LFV.getRootAsLFV(new flatbuffers.ByteBuffer(bytes)).unpack();
}
// $LFV history rows back to the history shape.
export function lfvHistories(lfv) {
  return lfv.ROWS.map((r) => ({ id: r.SOURCE_ID, target: r.TARGET, role: roleName(r.ROLE), generator: r.GENERATOR ?? '',
    cls: r.CLASS_LABEL ?? '', t: r.ELEMENT_SETS.map((m) => unixEpoch(m.EPOCH)), n: r.ELEMENT_SETS.map((m) => m.MEAN_MOTION),
    e: r.ELEMENT_SETS.map((m) => m.ECCENTRICITY), i: r.ELEMENT_SETS.map((m) => m.INCLINATION),
    raan: r.ELEMENT_SETS.map((m) => m.RA_OF_ASC_NODE), argp: r.ELEMENT_SETS.map((m) => m.ARG_OF_PERICENTER),
    ma: r.ELEMENT_SETS.map((m) => m.MEAN_ANOMALY), bstar: r.ELEMENT_SETS.map((m) => m.BSTAR) }));
}

// The module's $LFV outputs in the shapes the decoy study writes.
const finiteOrNull = (v) => (Number.isFinite(v) ? v : null);
export function lfvFeatures(lfv) {
  return { view: lfv.VIEW, names: lfv.FEATURE_NAMES,
    rows: lfv.ROWS.map((r) => ({ id: r.SOURCE_ID, target: r.TARGET, role: roleName(r.ROLE), generator: r.GENERATOR ?? '', cls: r.CLASS_LABEL ?? '',
      x: r.VALUES.map(finiteOrNull) })),
    counts: { histories: lfv.SOURCE_COUNT, catalog: lfv.REFERENCE_COUNT, tooFewPoints: lfv.SKIPPED_COUNT } };
}
export function lfvReport(lfv) {
  const r = lfv.REPORT;
  const first = (list, ideal = true) => list.map((p) => ({ n: p.N, pRealFirst: p.P_REAL_FIRST, nEffective: finiteOrNull(p.N_EFFECTIVE),
    ...(ideal ? { ideal: p.IDEAL } : {}) }));
  const t = r.THRESHOLDS[0];
  const w = r.WITHIN_GROUP;
  return {
    rows: { real: r.REAL_COUNT, decoy: r.DECOY_COUNT }, excluded: r.EXCLUDED_FEATURES, relative: r.RELATIVE,
    withinTarget: w ? { targets: w.GROUP_COUNT, fewestDecoys: w.FEWEST_DECOYS, pooledDecoys: w.POOLED_DECOYS, rankHistogram: w.RANK_HISTOGRAM,
      rankKs: w.RANK_KS, first: first(w.RANK_PROBABILITIES), firstStandardized: first(w.STANDARDIZED_RANK_PROBABILITIES) } : null,
    classifier: { kind: r.CLASSIFIER.METHOD, depth: r.CLASSIFIER.DEPTH, rounds: r.CLASSIFIER.ROUNDS, learningRate: r.CLASSIFIER.LEARNING_RATE,
      bins: r.CLASSIFIER.BINS, folds: r.CLASSIFIER.FOLDS, split: r.CLASSIFIER.SPLIT },
    auc: r.AUC, balancedAccuracy: r.BALANCED_ACCURACY,
    epsilon: t ? { epsilonLowerBound95: t.EPSILON_LOWER_BOUND, threshold: t.THRESHOLD, side: t.SIDE === LFV.lfvRegionSide.Above ? 'real above' : 'decoy below',
      heldOut: { real: { in: t.REAL_IN_REGION, n: t.REAL_TOTAL }, decoy: { in: t.DECOY_IN_REGION, n: t.DECOY_TOTAL } } } : null,
    first: first(r.RANK_PROBABILITIES),
    byClass: Object.fromEntries(r.CLASS_RESULTS.map((c) => [c.CLASS_LABEL, { real: c.REAL_COUNT, auc: c.AUC, first: first(c.RANK_PROBABILITIES, false) }])),
    features: r.FEATURES.map((f) => ({ name: f.NAME, aloneAuc: finiteOrNull(f.AUC), separation: finiteOrNull(f.SEPARATION), gainShare: f.GAIN_SHARE })),
  };
}
