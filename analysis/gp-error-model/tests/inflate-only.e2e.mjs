// object_covariance never ships a covariance below the population prior (modules-gp-error-model-inflate-only-20261103).
//
//   node analysis/gp-error-model/tests/inflate-only.e2e.mjs [--module <wasm>] [--measure]
//
// Registered before the rule changed; the thresholds below were fixed first and are not tuned to the result.
//
// Inputs: the archived GP history (/opt/data/sdn-archive/spacetrack/gp_history), 36 daily files, 2026-08-23 through
// 2026-09-27. Objects: a fixed hash quarter of the catalog (sha256 of the NORAD ID, first byte mod 4 = 0), at most 60
// per regime (LEO-L, LEO-M, LEO-H, MEO, GEO by the archive's semimajor axis and eccentricity), Starlink and Galileo
// rows skipped by name. An object-day is one object, one set in force (up to 3 per object, from the last 6 days of the
// window) and one prediction age (0, 0.5, 1, 2, 4, 7 days). Nothing is printed but counts and NORAD IDs; no element set
// is printed or written.
//
// The prior P_pop of an object-day is the module's own answer to the same request with only the set in force as history
// (no older set). Coordinator ruling 2026-11-03: until the covariance study validates a per-object signal against truth,
// the module ships the stratum prior only, so for EVERY object-day with a covariance:
//   1. the RTN and inertial matrices equal P_pop bit for bit, status POPULATION (D = I);
//   2. the floor holds: the minimum eigenvalue of P_pop^(-1/2) P_o P_pop^(-1/2) is at least 1 - 1e-12, and so is that of the
//      2-D encounter-plane projections of the position block at crossing angles 10, 45, 90, 135 and 170 degrees (the other
//      object's velocity direction cos(a) T + sin(a) (cos(f) N + sin(f) R), f = 0, 45, 90, 135);
//   3. every label is Uncalibrated (the covariance port's report rows); the sample includes every object cut to the set in
//      force and its 4 predecessors (fewer than 8 older sets);
//   4. the report carries the object's history statistics without applying them: its evidence names the set count and, where
//      the age bin holds enough sets, the per-axis variance ratio, and says "not applied";
//   5. at least 200 objects, each of the five regimes at least 15;
//   6. the 2026-08 gate model's cells and the E14 S3-KC prior are byte-identical to the frozen files.
// --measure prints the numbers and asserts nothing; run on a module built before the change it gives the share of
// object-days where that module shipped a covariance below P_pop in some direction (0.12.0: 77.2 %).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { ARM_OF, decode, encode, ERM_TYPE } from '../scripts/erm-codec.mjs';
import { encodeOmm, ommFrame } from './products-fixtures.mjs';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const argv = process.argv.slice(2);
const measure = argv.includes('--measure');
const wasmPath = argv.includes('--module') ? path.resolve(argv[argv.indexOf('--module') + 1]) : here('../dist/isomorphic/module.wasm');
const wasm = fs.readFileSync(wasmPath);
const manifest = JSON.parse(fs.readFileSync(here('../plugin-manifest.json')));

const ARCHIVE = '/opt/data/sdn-archive/spacetrack/gp_history/by-creation/2026';
const FIRST_DAY = '2026-08-23', LAST_DAY = '2026-09-27';
const ANCHOR_DAYS = 6, ANCHORS_PER_OBJECT = 3, PER_REGIME = 60;
const AGES = [0, 0.5, 1, 2, 4, 7];
const ANGLES = [10, 45, 90, 135, 170], AZIMUTHS = [0, 45, 90, 135];
const TOLERANCE = 1e-12;
const REGIMES = ['LEO-L', 'LEO-M', 'LEO-H', 'MEO', 'GEO'];
// Frozen files: the 2026-08 gate model's cells (CA's empiricalPc path) and the E14 S3-KC prior.
const FROZEN = {
  'docs/model-2026-08.json': 'fc3d69a77ebc5e0067bce18ea54b6adb22f2219bed07fafff0deb471b49cb82d',
  'docs/model-2026-08-scaled.json': 'ba5684212fceb1cea5578286bf36dfe607426c0dccf7f57822f3fa7aca3b6046',
  'data/e14-s3-kc.erm': 'b0ae93c2a92813a1c9b5c2cf5ba786030fd2dc35218e8b167b7af72c0d07c076',
  'data/e14-s3-kc.json': 'd705ffcb16da10b9eb9af1afd830d79172723183f32e03e7935f603dadeb2072',
};

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

// ── the module ──
async function call(sets, requests) {
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct', hostOptions: { config: {} } });
  try {
    const elements = ommFrame('elements', Buffer.concat(sets.map((s) => encodeOmm(s))));
    const request = { portId: 'request', payload: encode(ARM_OF.object_covariance.request, { objects: requests }), typeRef: { ...ERM_TYPE } };
    const r = await h.invoke({ methodId: 'object_covariance', inputs: [elements, request] });
    if (r.statusCode !== 0) throw new Error(r.errorMessage);
    const out = {};
    for (const f of r.outputs) if (f.typeRef?.fileIdentifier === '$ERM') out[f.portId] = decode(f.payload);
    return out;
  } finally {
    h.destroy();
  }
}

// ── linear algebra of the test (symmetric matrices, row-major) ──
function jacobiEigenvalues(m, n) {
  const a = Float64Array.from(m);
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[n * i + j] ** 2;
    if (off < 1e-36) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(a[n * p + q]) < 1e-300) continue;
      const theta = (a[n * q + q] - a[n * p + p]) / (2 * a[n * p + q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const x = a[n * k + p], y = a[n * k + q]; a[n * k + p] = c * x - s * y; a[n * k + q] = s * x + c * y; }
      for (let k = 0; k < n; k++) { const x = a[n * p + k], y = a[n * q + k]; a[n * p + k] = c * x - s * y; a[n * q + k] = s * x + c * y; }
    }
  }
  return Array.from({ length: n }, (_, i) => a[n * i + i]).sort((x, y) => x - y);
}
// Eigenvalues of P^(-1/2) Q P^(-1/2): scale both by P's diagonal, Cholesky of the scaled P, W = L^-1 Q' L^-T.
function relativeEigenvalues(P, Q, n) {
  const d = Array.from({ length: n }, (_, i) => Math.sqrt(P[n * i + i]));
  const Ps = new Float64Array(n * n), Qs = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { Ps[n * i + j] = P[n * i + j] / (d[i] * d[j]); Qs[n * i + j] = Q[n * i + j] / (d[i] * d[j]); }
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = Ps[n * i + j];
    for (let k = 0; k < j; k++) s -= L[n * i + k] * L[n * j + k];
    if (i === j) { if (!(s > 0)) throw new Error('prior not positive definite'); L[n * i + i] = Math.sqrt(s); } else L[n * i + j] = s / L[n * j + j];
  }
  const X = new Float64Array(n * n); // X = L^-1 Qs
  for (let c = 0; c < n; c++) for (let i = 0; i < n; i++) {
    let s = Qs[n * i + c];
    for (let k = 0; k < i; k++) s -= L[n * i + k] * X[n * k + c];
    X[n * i + c] = s / L[n * i + i];
  }
  const W = new Float64Array(n * n); // W = X L^-T
  for (let r = 0; r < n; r++) for (let j = 0; j < n; j++) {
    let s = X[n * r + j];
    for (let k = 0; k < j; k++) s -= W[n * r + k] * L[n * j + k];
    W[n * r + j] = s / L[n * j + j];
  }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const v = (W[n * i + j] + W[n * j + i]) / 2; W[n * i + j] = W[n * j + i] = v; }
  return jacobiEigenvalues(W, n);
}
const fromLower = (a) => { const m = new Float64Array(36); for (let i = 0, k = 0; i < 6; i++) for (let j = 0; j <= i; j++, k++) m[6 * i + j] = m[6 * j + i] = a[k]; return m; };
// The position block projected on the plane normal to the relative velocity of an encounter at crossing angle `a`
// (RTN axes: this object flies along T; the other along cos(a) T + sin(a) (cos(f) N + sin(f) R)).
function projection(P6, a, f) {
  const rad = Math.PI / 180, ca = Math.cos(a * rad), sa = Math.sin(a * rad), cf = Math.cos(f * rad), sf = Math.sin(f * rad);
  const rel = [sa * sf, ca - 1, sa * cf]; // (R, T, N) components of v2 - v1
  const norm = Math.hypot(...rel);
  const w = rel.map((x) => x / norm);
  let e1 = [1, 0, 0]; // R unless it is along the relative velocity
  if (Math.abs(w[0]) > 0.9) e1 = [0, 1, 0];
  const dot = e1[0] * w[0] + e1[1] * w[1] + e1[2] * w[2];
  e1 = e1.map((x, i) => x - dot * w[i]);
  const l1 = Math.hypot(...e1); e1 = e1.map((x) => x / l1);
  const e2 = [w[1] * e1[2] - w[2] * e1[1], w[2] * e1[0] - w[0] * e1[2], w[0] * e1[1] - w[1] * e1[0]];
  const B = [e1, e2];
  const Q = new Float64Array(4);
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
    let s = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += B[r][i] * P6[6 * i + j] * B[c][j];
    Q[2 * r + c] = s;
  }
  return Q;
}

// ── the archive ──
const regimeOf = (a, e) => {
  if (!(e < 0.25)) return null;
  const alt = a - 6378.137;
  return alt < 500 ? 'LEO-L' : alt < 800 ? 'LEO-M' : alt < 2000 ? 'LEO-H' : alt < 30000 ? 'MEO' : alt < 40000 ? 'GEO' : null;
};
const quarter = (norad) => crypto.createHash('sha256').update(String(norad)).digest()[0] % 4 === 0;
const excluded = (name) => /STARLINK|GALILEO|GSAT\d/i.test(name);
function readArchive() {
  const objects = new Map();
  for (let day = Date.parse(`${FIRST_DAY}T00:00:00Z`); day <= Date.parse(`${LAST_DAY}T00:00:00Z`); day += 86400000) {
    const file = path.join(ARCHIVE, `${new Date(day).toISOString().slice(0, 10)}.json.gz`);
    const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
    for (const r of rows) {
      if (r.MEAN_ELEMENT_THEORY !== 'SGP4' || excluded(r.OBJECT_NAME ?? '')) continue;
      const norad = Number(r.NORAD_CAT_ID);
      if (!quarter(norad)) continue;
      const regime = regimeOf(Number(r.SEMIMAJOR_AXIS), Number(r.ECCENTRICITY));
      if (!regime) continue;
      let o = objects.get(norad);
      if (!o) objects.set(norad, o = { norad, regime, sets: new Map() });
      const epoch = r.EPOCH.slice(0, 26);
      o.sets.set(epoch, { objectId: r.OBJECT_ID ?? '', norad, name: r.OBJECT_NAME, epoch, n: Number(r.MEAN_MOTION), e: Number(r.ECCENTRICITY),
        i: Number(r.INCLINATION), raan: Number(r.RA_OF_ASC_NODE), argp: Number(r.ARG_OF_PERICENTER), m: Number(r.MEAN_ANOMALY), bstar: Number(r.BSTAR) });
    }
  }
  return objects;
}
function sample(objects) {
  const lastStart = Date.parse(`${LAST_DAY}T23:59:59Z`) - ANCHOR_DAYS * 86400000;
  const picked = [];
  for (const regime of REGIMES) {
    const candidates = [...objects.values()].filter((o) => o.regime === regime)
      .map((o) => ({ ...o, sets: [...o.sets.values()].sort((a, b) => (a.epoch < b.epoch ? -1 : 1)) }))
      .filter((o) => o.sets.some((s) => Date.parse(s.epoch + 'Z') >= lastStart))
      .sort((a, b) => crypto.createHash('sha256').update('s' + a.norad).digest('hex').localeCompare(crypto.createHash('sha256').update('s' + b.norad).digest('hex')));
    picked.push(...candidates.slice(0, PER_REGIME));
  }
  return picked.map((o) => {
    const tail = o.sets.map((s, k) => ({ s, k })).filter(({ s }) => Date.parse(s.epoch + 'Z') >= lastStart);
    const step = Math.max(1, Math.floor(tail.length / ANCHORS_PER_OBJECT));
    const anchors = [];
    for (let t = tail.length - 1; t >= 0 && anchors.length < ANCHORS_PER_OBJECT; t -= step) anchors.push(tail[t].k);
    return { norad: o.norad, regime: o.regime, sets: o.sets, anchors };
  });
}

// ── run ──
const hash = (rel) => crypto.createHash('sha256').update(fs.readFileSync(here('../' + rel))).digest('hex');
for (const [rel, want] of Object.entries(FROZEN)) check(hash(rel) === want, `${rel} changed`);

const objects = sample(readArchive());
const stats = { objects: objects.length, objectDays: 0, noCovariance: 0, belowPrior: 0, aboveShare: 0, shortHistory: 0, shortExact: 0,
  byRegime: Object.fromEntries(REGIMES.map((r) => [r, { objects: 0, days: 0, below: 0, empirical: 0, inflated: 0, lambdas: [] }])), minEigen: Infinity, minEigenPlane: Infinity,
  lambdaMax: [], lambdaMaxInflated: [], uncalibrated: 0, empirical: 0, belowEmpirical: 0, lambdaEmpirical: [], exact: 0, carried: 0 };
const request = (id, anchor, ages) => ages.map((a) => ({ id: `${id}:${a}`, set: { norad: anchor.norad, epoch: anchor.epoch }, ageDays: a }));
const seenRegime = new Map();

for (const o of objects) {
  for (const k of o.anchors) {
    const anchor = o.sets[k];
    const requests = request(o.norad, anchor, AGES);
    const prior = await call([anchor], requests);
    // The history as the module sees it: the object's sets up to the set in force, and the same cut to 4 predecessors.
    for (const [variant, history] of [['full', o.sets.slice(0, k + 1)], ['short', o.sets.slice(Math.max(0, k - 4), k + 1)]]) {
      if (variant === 'short' && k !== o.anchors[0]) continue;
      const got = await call(history, requests);
      const older = history.length - 1;
      requests.forEach((q, i) => {
        const p = prior.covariance.objects[i], c = got.covariance.objects[i];
        const label = got.report.objects[i].rows[0];
        const where = `${o.norad} ${anchor.epoch} age ${AGES[i]} ${variant}`;
        if (!c.covarianceRtn || !p.covarianceRtn) { check(c.status === p.status, `${where}: status ${c.status} vs ${p.status}`); stats.noCovariance++; return; }
        seenRegime.set(o.norad, o.regime);
        stats.objectDays++;
        const reg = stats.byRegime[o.regime]; reg.days++;
        check(label.calibration === 'UNCALIBRATED' && got.report.objects[i].calibrated === false, `${where}: label ${label.calibration}`);
        if (label.calibration === 'UNCALIBRATED') stats.uncalibrated++;
        const exact = c.status === 'POPULATION' && c.covarianceRtn.every((x, j) => Object.is(x, p.covarianceRtn[j])) && c.covarianceInertial.every((x, j) => Object.is(x, p.covarianceInertial[j]));
        if (exact) stats.exact++;
        check(exact, `${where}: not P_pop exactly (${c.status})`);
        if (older < 8) { stats.shortHistory++; if (exact) stats.shortExact++; }
        const evidence = label.evidence ?? '';
        if (/^.*history\/1 /.test(evidence) && /not applied/.test(evidence)) stats.carried++;
        check(/history\/1 /.test(evidence) && /not applied/.test(evidence), `${where}: history statistics not carried in the report`);
        const P = fromLower(p.covarianceRtn), O = fromLower(c.covarianceRtn);
        const eig = relativeEigenvalues(P, O, 6);
        stats.minEigen = Math.min(stats.minEigen, eig[0]);
        const lambdaMax = eig[5];
        stats.lambdaMax.push(lambdaMax);
        if (lambdaMax > 1 + 1e-9) { stats.aboveShare++; stats.lambdaMaxInflated.push(lambdaMax); reg.inflated++; }
        if (c.status === 'EMPIRICAL') { stats.empirical++; reg.empirical++; stats.lambdaEmpirical.push(lambdaMax); reg.lambdas.push(lambdaMax); }
        let below = eig[0] < 1 - TOLERANCE;
        check(!below, `${where}: min eigenvalue ${eig[0]}`);
        for (const a of ANGLES) for (const f of AZIMUTHS) {
          const e2 = relativeEigenvalues(projection(P, a, f), projection(O, a, f), 2);
          stats.minEigenPlane = Math.min(stats.minEigenPlane, e2[0]);
          if (e2[0] < 1 - TOLERANCE) { below = true; check(false, `${where}: plane ${a}/${f} min eigenvalue ${e2[0]}`); }
        }
        if (below) { stats.belowPrior++; reg.below++; if (c.status === 'EMPIRICAL') stats.belowEmpirical++; }
      });
    }
  }
}
for (const o of objects) stats.byRegime[o.regime].objects += seenRegime.has(o.norad) ? 1 : 0;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const examined = stats.objectDays - stats.shortHistory;
const summary = {
  module: path.relative(process.cwd(), wasmPath), objects: seenRegime.size, objectDays: stats.objectDays, noCovariance: stats.noCovariance,
  shortHistory: stats.shortHistory, shortHistoryExact: stats.shortExact, examined,
  belowPrior: stats.belowPrior, belowPriorShare: examined ? stats.belowPrior / examined : NaN,
  exact: stats.exact, carried: stats.carried,
  empirical: stats.empirical, belowPriorEmpirical: stats.belowEmpirical, belowPriorShareEmpirical: stats.empirical ? stats.belowEmpirical / stats.empirical : NaN,
  medianLambdaMaxEmpirical: median(stats.lambdaEmpirical),
  inflated: stats.aboveShare, inflatedShare: examined ? stats.aboveShare / examined : NaN,
  medianLambdaMaxAll: median(stats.lambdaMax), medianLambdaMaxInflated: median(stats.lambdaMaxInflated),
  minEigen: stats.minEigen, minEigenPlane: stats.minEigenPlane, uncalibrated: stats.uncalibrated, byRegime: stats.byRegime,
};
for (const r of Object.values(stats.byRegime)) { r.medianLambdaMaxEmpirical = median(r.lambdas); delete r.lambdas; }
console.log(JSON.stringify(summary, null, 1));
if (measure) process.exit(0);
check(seenRegime.size >= 200, `only ${seenRegime.size} objects`);
for (const r of REGIMES) check(stats.byRegime[r].objects >= 15, `${r}: ${stats.byRegime[r].objects} objects`);
check(stats.exact === stats.objectDays, 'an object-day is not exactly P_pop');
check(stats.carried === stats.objectDays, 'history statistics missing from a report row');
check(stats.shortHistory > 0 && stats.shortExact === stats.shortHistory, 'short histories are not exactly P_pop');
check(stats.uncalibrated === stats.objectDays, 'a label is not Uncalibrated');
if (failures.length) {
  console.log(`FAIL: ${failures.length} checks`);
  for (const f of failures.slice(0, 20)) console.log(' ', f);
  process.exit(1);
}
console.log(`PASS: ${seenRegime.size} objects, ${stats.objectDays} object-days exactly P_pop (${stats.shortHistory} with fewer than 8 older sets; min eigenvalue ${stats.minEigen}, plane ${stats.minEigenPlane}), history statistics carried in every report row`);
