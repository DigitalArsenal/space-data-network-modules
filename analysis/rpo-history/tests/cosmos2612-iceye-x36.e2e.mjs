#!/usr/bin/env node
// E2E (rpo-history-engine-20261017): Cosmos 2612 (NORAD 68762) relative to
// ICEYE-X36 (NORAD 59103), 2026-09-28 .. 2026-10-17 12:00 UTC, from OUR GP
// archive, through the modules as a node would run them:
//
//   GP history (the SDN archive, Space-Track gp_history) -> $OMM
//   analysis/maneuver-detection detect_maneuvers, its propagator query port
//     answered by analysis/epoch-state (SGP4) -> $MNV brackets
//   analysis/gp-error-model's model (docs/model-2026-08.json: SGP4
//     predictions against later element sets, by regime and age) -> $ERM
//   analysis/rpo-history characterize, its query port answered by
//     analysis/epoch-state -> $OCM relative, $OCM geometry, $CVR realism
//
// and checks the result against independent evidence:
//   1. frames: same-orbit points 100 km of arc apart are curvilinear (0, 100,
//      0) km and rectilinear radial -s^2/2r (the RIC box's E2E case).
//   2. relative orbital elements: synthetic two-body pairs built from given
//      D'Amico ROE (this file's own Kepler solver, an independent oracle) come
//      back from the module, and the module's ROE through the analytic linear
//      map reproduce its RTN offsets, for near-circular cases.
//   3. OEL's published figures (Orbital Engineering Lab v0.28.0, Adam Cohen's
//      post of 2026-10-17, x.com/adamcohen8/status/2111477601583989226): the
//      shapes and amplitudes of R, I, C, separation, range rate and plane
//      angle, the Oct 12 orbit change, the plane angle falling from ~0.24 deg
//      toward 0, the I-R loops after Oct 13 (I about -480 -> -100 km, R about
//      -4.5 km), the conditional 24 h coast, and the amber bracket spans. The
//      reference numbers below were read off the figures (pixel positions of
//      the gridlines and spans; 25 px per day on the history figure) before
//      this file ran the modules.
//   4. the coast bands' hindcast against the next element sets (bands
//      calibrated only on what precedes each prediction): the shares inside
//      the 1- and 3-sigma bands per curvilinear axis consistent with 0.683 and
//      0.9973 at the effective sample size (distinct truth epochs).
//
// The GP element sets are Space-Track data: they are read from the archive at
// run time and never written into the repository (data license policy); the
// figures and evidence go to tests/out (ignored by git).
//
//   SDN_GP_ARCHIVE   gp_history by-creation root (/opt/data/sdn-archive/spacetrack/gp_history/by-creation)
//   RPO_E2E_OUT      evidence directory (tests/out)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.resolve(HERE, '..');
const MODULES = path.resolve(MODULE, '../..');
const ARCHIVE = process.env.SDN_GP_ARCHIVE ?? '/opt/data/sdn-archive/spacetrack/gp_history/by-creation';
const OUT = process.env.RPO_E2E_OUT ?? path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });

const standards = path.dirname(createRequire(path.join(MODULE, 'package.json')).resolve('spacedatastandards.org/package.json'));
process.env.SPACE_DATA_STANDARDS_ROOT ??= standards;
const flatbuffers = createRequire(path.join(standards, 'package.json'))('flatbuffers');
const sds = async (code) => import(pathToFileURL(path.join(standards, `lib/js/${code}/main.js`)).href);
const [OMM, OEM, MNV, OCM, CVR] = await Promise.all(['OMM', 'OEM', 'MNV', 'OCM', 'CVR'].map(sds));

const CHASER = 68762;   // COSMOS 2612, 2026-083H
const TARGET = 59103;   // ICEYE-X36, 2024-043F
const CALIBRATION_DAYS = 14;   // each object's trailing window of its own set differences, before every prediction time
const START = '2026-09-28T00:00:00Z';
const STOP = '2026-10-17T12:00:00Z';
const STEP = 60;
const HORIZON_H = 24;

const T = (iso) => Date.parse(iso) / 1000;
const iso = (s) => new Date(Math.round(s * 1000)).toISOString();
const DAY = 86400;
const results = [];
let failures = 0;
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}

// ── typed records ──────────────────────────────────────────────────────────
const TYPE = {
  OMM: { schemaName: 'OMM.fbs', fileIdentifier: '$OMM', rootTypeName: 'OMM', wireFormat: 'flatbuffer' },
  OEM: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' },
  MNV: { schemaName: 'MNV.fbs', fileIdentifier: '$MNV', rootTypeName: 'MNV', wireFormat: 'flatbuffer' },
  PRW: { schemaName: 'PRW.fbs', fileIdentifier: '$PRW', rootTypeName: 'PRW', wireFormat: 'flatbuffer' },
  ERM: { schemaName: 'ERM.fbs', fileIdentifier: '$ERM', rootTypeName: 'ERM', wireFormat: 'flatbuffer' },
};
function ommRecord(row) {
  const t = new OMM.OMMT();
  const num = (k) => (row[k] === undefined || row[k] === null || row[k] === '' ? 0 : Number(row[k]));
  Object.assign(t, {
    OBJECT_NAME: row.OBJECT_NAME ?? '', OBJECT_ID: row.OBJECT_ID ?? '', NORAD_CAT_ID: num('NORAD_CAT_ID'),
    EPOCH: String(row.EPOCH), MEAN_ELEMENT_THEORY: OMM.meanElementSource.SGP4,
    MEAN_MOTION: num('MEAN_MOTION'), ECCENTRICITY: num('ECCENTRICITY'), INCLINATION: num('INCLINATION'), RA_OF_ASC_NODE: num('RA_OF_ASC_NODE'),
    ARG_OF_PERICENTER: num('ARG_OF_PERICENTER'), MEAN_ANOMALY: num('MEAN_ANOMALY'), BSTAR: num('BSTAR'),
    MEAN_MOTION_DOT: num('MEAN_MOTION_DOT'), MEAN_MOTION_DDOT: num('MEAN_MOTION_DDOT'), REV_AT_EPOCH: num('REV_AT_EPOCH'),
    ELEMENT_SET_NO: num('ELEMENT_SET_NO'), COMMENT: row.GP_ID ? `GP_ID ${row.GP_ID}` : '',
  });
  const b = new flatbuffers.Builder(512);
  OMM.OMM.finishSizePrefixedOMMBuffer(b, t.pack(b));
  return b.asUint8Array();
}
const stream = (records) => Buffer.concat(records.map((r) => Buffer.from(r)));
function* sizePrefixed(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at + 4 <= bytes.length;) {
    const len = view.getUint32(at, true);
    yield bytes.subarray(at, at + 4 + len);
    at += 4 + len;
  }
}
const ocmRecords = (bytes) => [...sizePrefixed(bytes)].map((r) => OCM.OCM.getSizePrefixedRootAsOCM(new flatbuffers.ByteBuffer(r)).unpack());

// ── modules ────────────────────────────────────────────────────────────────
async function loadModule(relative, config = {}) {
  const dir = path.join(MODULES, relative);
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(path.join(dir, 'dist/isomorphic/module.wasm')),
    manifest: JSON.parse(fs.readFileSync(path.join(dir, 'plugin-manifest.json'), 'utf8')),
    surface: 'direct', hostOptions: { config },
  });
  return {
    async invoke(methodId, inputs) {
      const r = await harness.invoke({ methodId, inputs });
      if (r.statusCode !== 0) throw new Error(`${relative} ${methodId}: ${r.errorCode ?? r.statusCode}: ${r.errorMessage}`);
      return r;
    },
    destroy: () => harness.destroy(),
  };
}
const outputsOf = (r, port) => r.outputs.filter((f) => f.portId === port).map((f) => new Uint8Array(f.payload));

// The detector's and the RPO module's propagator query port, answered by
// analysis/epoch-state (SGP4, TEME): the node a flow plugs in.
async function answered(epochState, requests, elementStream) {
  const r = await epochState.invoke('answer_propagation_requests', [
    { portId: 'requests', payload: requests, typeRef: TYPE.PRW },
    { portId: 'element_sets', payload: elementStream, typeRef: TYPE.OMM },
  ]);
  return outputsOf(r, 'propagation');
}

// ── GP history from the archive ─────────────────────────────────────────────
function gpHistory(norads, fromDay) {
  const files = fs.readdirSync(path.join(ARCHIVE, '2026')).filter((f) => f.slice(0, 10) >= fromDay && f.endsWith('.json.gz')).sort();
  const key = crypto.createHash('sha256').update(JSON.stringify([norads, files])).digest('hex').slice(0, 16);
  const cache = path.join(OUT, `gp-${key}.json`);
  if (fs.existsSync(cache)) return { rows: JSON.parse(fs.readFileSync(cache, 'utf8')), files: files.length, cached: true };
  const want = new Set(norads.map(String));
  const byId = new Map();
  for (const f of files) {
    for (const row of JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ARCHIVE, '2026', f))).toString('utf8'))) {
      if (want.has(String(row.NORAD_CAT_ID))) byId.set(row.GP_ID, row);
    }
  }
  const rows = [...byId.values()].sort((a, b) => Number(a.NORAD_CAT_ID) - Number(b.NORAD_CAT_ID) || a.EPOCH.localeCompare(b.EPOCH));
  fs.writeFileSync(cache, JSON.stringify(rows));
  return { rows, files: files.length, cached: false };
}

// ── the runs ───────────────────────────────────────────────────────────────
async function detectManeuvers(epochState, rows) {
  const detector = await loadModule('analysis/maneuver-detection');
  const elements = stream(rows.map(ommRecord));
  const base = [{ portId: 'element_sets', payload: elements, typeRef: TYPE.OMM }];
  const first = await detector.invoke('detect_maneuvers', base);
  const answers = await answered(epochState, outputsOf(first, 'propagation_requests')[0], elements);
  const second = await detector.invoke('detect_maneuvers', [...base, ...answers.map((a) => ({ portId: 'propagation', payload: a, typeRef: TYPE.OEM }))]);
  await detector.destroy();
  return outputsOf(second, 'maneuvers');
}

async function errorModel() {
  const { encode } = await import(pathToFileURL(path.join(MODULES, 'analysis/gp-error-model/scripts/erm-codec.mjs')).href);
  const file = 'docs/model-2026-08.json';
  const model = JSON.parse(fs.readFileSync(path.join(MODULES, 'analysis/gp-error-model', file), 'utf8'));
  model.id ??= `analysis/gp-error-model ${file}`;
  return { bytes: encode('model', model), id: model.id, basis: model.basis };
}

async function characterize(epochState, config, rows, extra = []) {
  const rpo = await loadModule('analysis/rpo-history', { rpo: config });
  const elements = stream(rows.map(ommRecord));
  const base = [{ portId: 'element_sets', payload: elements, typeRef: TYPE.OMM }, ...extra];
  const first = await rpo.invoke('characterize', base);
  const requests = outputsOf(first, 'propagation_requests')[0];
  const answers = await answered(epochState, requests, elements);
  const second = await rpo.invoke('characterize', [...base, ...answers.map((a) => ({ portId: 'propagation', payload: a, typeRef: TYPE.OEM }))]);
  await rpo.destroy();
  return {
    relative: ocmRecords(outputsOf(second, 'relative')[0] ?? new Uint8Array()),
    geometry: ocmRecords(outputsOf(second, 'geometry')[0] ?? new Uint8Array()),
    realism: (outputsOf(second, 'realism')[0] ? [...sizePrefixed(outputsOf(second, 'realism')[0])] : [])
      .map((r) => CVR.CVR.getSizePrefixedRootAsCVR(new flatbuffers.ByteBuffer(r)).unpack()),
  };
}

// The geometry records as rows {t, R, I, ...} with each record's segment kind.
function geometryRows(records) {
  const out = [];
  records.forEach((rec, segment) => {
    const udp = Object.fromEntries(rec.USER_DEFINED_PARAMETERS.map((p) => [p.PARAM_NAME, p.PARAM_VALUE]));
    const cols = udp.COLUMNS.split(',');
    const w = rec.STATE_VECTOR_SIZE, t0 = T(rec.METADATA.START_TIME), step = rec.STATE_STEP_SIZE;
    for (let i = 0; i * w < rec.STATE_DATA.length; i++) {
      const row = { t: t0 + i * step, segment, projection: udp.SEGMENT === 'PROJECTION' };
      cols.forEach((c, k) => { row[c] = rec.STATE_DATA[i * w + k]; });
      out.push(row);
    }
  });
  return out;
}
const udpOf = (rec) => Object.fromEntries(rec.USER_DEFINED_PARAMETERS.map((p) => [p.PARAM_NAME, p.PARAM_VALUE]));

// ── synthetic two-body pairs (oracle: this file's own Kepler solver) ────────
const MU = 398600.4418;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normV = (a) => Math.sqrt(dot(a, a));
// Elements (a, ex, ey, i, raan, u = w + M) -> inertial state at mean argument of latitude u + n dt.
function stateOf(el, dt = 0) {
  const e = Math.hypot(el.ex, el.ey), w = e > 0 ? Math.atan2(el.ey, el.ex) : 0;
  const n = Math.sqrt(MU / el.a ** 3);
  const M = el.u - w + n * dt;
  let E = M;
  for (let k = 0; k < 50; k++) { const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E)); E -= d; if (Math.abs(d) < 1e-15) break; }
  const nu = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(E), Math.cos(E) - e);
  const p = el.a * (1 - e * e), r = p / (1 + e * Math.cos(nu)), u = w + nu;
  const ci = Math.cos(el.i), si = Math.sin(el.i), cO = Math.cos(el.raan), sO = Math.sin(el.raan);
  const P = [cO * Math.cos(u) - sO * Math.sin(u) * ci, sO * Math.cos(u) + cO * Math.sin(u) * ci, Math.sin(u) * si];
  const Q = [-cO * Math.sin(u) - sO * Math.cos(u) * ci, -sO * Math.sin(u) + cO * Math.cos(u) * ci, Math.cos(u) * si];
  const vr = Math.sqrt(MU / p) * e * Math.sin(nu), vt = Math.sqrt(MU / p) * (1 + e * Math.cos(nu));
  return [...P.map((x) => r * x), ...P.map((x, k) => vr * x + vt * Q[k])];
}
// D'Amico ROE -> deputy elements (exact inverse of the definitions).
function deputyOf(chief, roe) {
  const dO = roe.diy / Math.sin(chief.i);
  return { a: chief.a * (1 + roe.da), ex: chief.ex + roe.dex, ey: chief.ey + roe.dey, i: chief.i + roe.dix, raan: chief.raan + dO,
    u: chief.u + roe.dl - dO * Math.cos(chief.i) };
}
function syntheticRows(name, norad, epochIso) {
  return { OBJECT_NAME: name, OBJECT_ID: `SYN-${norad}`, NORAD_CAT_ID: norad, EPOCH: epochIso, MEAN_MOTION: 15.2, ECCENTRICITY: 0.0001, INCLINATION: 97.8,
    RA_OF_ASC_NODE: 0, ARG_OF_PERICENTER: 0, MEAN_ANOMALY: 0, BSTAR: 0 };
}
// A two-object request answered from closed-form states instead of SGP4.
async function characterizeSynthetic(chiefEl, deputyEl, t0Iso, minutes) {
  const t0 = T(t0Iso);
  const rows = [syntheticRows('SYN TARGET', 90001, t0Iso.replace('Z', '')), syntheticRows('SYN CHASER', 90002, t0Iso.replace('Z', ''))];
  const rpo = await loadModule('analysis/rpo-history', { rpo: { chaser: '90002', target: '90001', start: t0Iso, stop: iso(t0 + minutes * 60), step_seconds: 60, projection_hours: 0 } });
  const elements = stream(rows.map(ommRecord));
  const first = await rpo.invoke('characterize', [{ portId: 'element_sets', payload: elements, typeRef: TYPE.OMM }]);
  const queries = OEMQueries(outputsOf(first, 'propagation_requests')[0]);
  const blocks = queries.map((q) => {
    const el = q.norad === 90001 ? chiefEl : deputyEl;
    const b = new OEM.ephemerisDataBlockT();
    b.OBJECT = Object.assign(new OEM.CATT(), { NORAD_CAT_ID: q.norad, OBJECT_ID: `SYN-${q.norad}` });
    b.CENTER_NAME = 'EARTH';
    b.TIME_SYSTEM = OEM.timingStandard.UTC;
    b.REFERENCE_FRAME = Object.assign(new OEM.RFMT(), { NAME: 'GCRF' });
    b.START_TIME = iso(q.start);
    b.STEP_SIZE = q.step;
    b.STATE_VECTOR_SIZE = 6;
    b.EPHEMERIS_DATA = [];
    for (let t = q.start; t <= q.stop + 1e-6; t += q.step) b.EPHEMERIS_DATA.push(...stateOf(el, t - t0));
    return b;
  });
  const m = new OEM.OEMT();
  m.CREATION_DATE = t0Iso;
  m.EPHEMERIS_DATA_BLOCK = blocks;
  const fb = new flatbuffers.Builder(1 << 16);
  OEM.OEM.finishOEMBuffer(fb, m.pack(fb));
  const second = await rpo.invoke('characterize', [{ portId: 'element_sets', payload: elements, typeRef: TYPE.OMM },
    { portId: 'propagation', payload: fb.asUint8Array(), typeRef: TYPE.OEM }]);
  await rpo.destroy();
  return { relative: ocmRecords(outputsOf(second, 'relative')[0]), geometry: ocmRecords(outputsOf(second, 'geometry')[0]) };
}
// The window queries of a $PRW request, read with the standards' PRW bindings.
let PRW;
function OEMQueries(bytes) {
  const prw = PRW.PRW.getRootAsPRW(new flatbuffers.ByteBuffer(bytes)).unpack();
  return prw.WINDOW_REQUEST.QUERIES.map((q) => ({ norad: q.NORAD_CAT_ID, start: T(q.START.ISO8601), stop: T(q.STOP.ISO8601), step: q.STEP_SECONDS }));
}

// ── 1 + 2: frames and relative orbital elements ─────────────────────────────
PRW = await sds('PRW');
{
  // Same circular orbit, chaser 100 km of arc ahead (the RIC box E2E's case).
  const a = 6778.137, chief = { a, ex: 0, ey: 0, i: 51.6 * Math.PI / 180, raan: 0.3, u: 0.2 };
  const ahead = { ...chief, u: chief.u + 100 / a };
  const r = await characterizeSynthetic(chief, ahead, '2026-01-01T00:00:00Z', 2);
  const g = geometryRows(r.geometry)[0], rel = r.relative[0].STATE_DATA;
  check('frames: same orbit 100 km ahead is curvilinear (0, 100, 0) km', Math.abs(g.R_KM) < 1e-6 && Math.abs(g.I_KM - 100) < 1e-6 && Math.abs(g.C_KM) < 1e-6,
    { R_km: g.R_KM, I_km: g.I_KM, C_km: g.C_KM });
  const sag = -(100 ** 2) / (2 * a);
  check('frames: rectilinear radial is -s^2/2r (-0.7377 km), in-track r sin(s/r)', Math.abs(rel[0] - (a * Math.cos(100 / a) - a)) < 1e-9 && Math.abs(rel[0] - sag) < 2e-4 &&
    Math.abs(rel[1] - a * Math.sin(100 / a)) < 1e-9, { x_km: rel[0], expected_km: a * Math.cos(100 / a) - a, sag_km: sag, y_km: rel[1] });
}
{
  // Near-circular chief (e = 0), ROE given as a * dalpha; the module's ROE at t0
  // against the input (round trip), and its RTN offsets against the analytic
  // linear map of its own ROE at every sample (D'Amico 2010, eq. 2.20).
  const a = 6921.0, chief = { a, ex: 0, ey: 0, i: 97.85 * Math.PI / 180, raan: 1.1, u: 0.4 };
  const table = [];
  for (const scaleM of [1, 10, 100, 1000]) {
    const s = scaleM / 1000 / a;
    const roe = { da: 0.5 * s, dl: -1.0 * s, dex: 0.7 * s, dey: -0.4 * s, dix: 0.6 * s, diy: -0.8 * s };
    const r = await characterizeSynthetic(chief, deputyOf(chief, roe), '2026-01-01T00:00:00Z', 95);
    const rows = geometryRows(r.geometry);
    const rel = r.relative[0].STATE_DATA;
    const keys = [['DA', 'da'], ['DLAMBDA', 'dl'], ['DEX', 'dex'], ['DEY', 'dey'], ['DIX', 'dix'], ['DIY', 'diy']];
    const roeMag = Math.max(...keys.map(([, k]) => Math.abs(roe[k])));
    const roundTrip = Math.max(...keys.map(([K, k]) => Math.abs(rows[0][K] - roe[k]))) / roeMag;
    let mapErr = 0, mapMag = 0;
    rows.forEach((row, i) => {
      const n = Math.sqrt(MU / a ** 3), u = chief.u + n * (row.t - rows[0].t), ac = row.A_CHIEF_KM;
      const x = ac * (row.DA - row.DEX * Math.cos(u) - row.DEY * Math.sin(u));
      const y = ac * (row.DLAMBDA + 2 * row.DEX * Math.sin(u) - 2 * row.DEY * Math.cos(u));
      const z = ac * (row.DIX * Math.sin(u) - row.DIY * Math.cos(u));
      const p = rel.slice(6 * i, 6 * i + 3);
      mapErr = Math.max(mapErr, Math.hypot(p[0] - x, p[1] - y, p[2] - z));
      mapMag = Math.max(mapMag, Math.hypot(...p));
    });
    table.push({ scale_m: scaleM, round_trip_rel: roundTrip, linear_map_rel: mapErr / mapMag });
  }
  console.log('ROE table', JSON.stringify(table));
  check('ROE: round trip of given ROE through two-body states, <= 1e-6 relative at every scale', table.every((x) => x.round_trip_rel <= 1e-6), table.map((x) => x.round_trip_rel));
  check('ROE: analytic linear map of the module ROE reproduces its RTN offsets to <= 1e-6 relative (near-circular, 1 m scale)',
    table[0].linear_map_rel <= 1e-6, table.map((x) => x.linear_map_rel));
  check('ROE: the linear-map residual is second order (relative error grows ~linearly with separation)',
    table[3].linear_map_rel / table[1].linear_map_rel > 30 && table[3].linear_map_rel / table[1].linear_map_rel < 300, table.map((x) => x.linear_map_rel));
}

// ── 3: Cosmos 2612 / ICEYE-X36 from the archive ─────────────────────────────
const gp = gpHistory([CHASER, TARGET], '2026-09-10');
console.log(`GP history: ${gp.rows.length} element sets from ${gp.files} archive files${gp.cached ? ' (cached extract)' : ''}`);
const rowsOf = (n) => gp.rows.filter((r) => Number(r.NORAD_CAT_ID) === n);
const epochState = await loadModule('analysis/epoch-state');
const mnvChaser = await detectManeuvers(epochState, rowsOf(CHASER));
const mnvTarget = await detectManeuvers(epochState, rowsOf(TARGET));
const maneuvers = [...mnvChaser, ...mnvTarget];
const unpackMnv = (b) => MNV.MNV.getRootAsMNV(new flatbuffers.ByteBuffer(b)).unpack();
console.log('maneuvers', JSON.stringify(maneuvers.map(unpackMnv).map((m) => ({ sat: m.SAT_NO, t: m.EVENT_START_TIME, dv_mps: +(m.DELTA_VEL * 1000).toFixed(3), sets: m.SOURCED_DATA }))));
const mnvStream = stream(maneuvers.map((f) => { const b = new flatbuffers.Builder(1024); MNV.MNV.finishSizePrefixedMNVBuffer(b, unpackMnv(f).pack(b)); return b.asUint8Array(); }));
const model = await errorModel();
const run = await characterize(epochState, { chaser: String(CHASER), target: String(TARGET), start: START, stop: STOP, step_seconds: STEP, projection_hours: HORIZON_H,
  calibration_days: CALIBRATION_DAYS, settle_days: 1 },
  gp.rows, [{ portId: 'maneuvers', payload: mnvStream, typeRef: TYPE.MNV }, { portId: 'error_model', payload: model.bytes, typeRef: TYPE.ERM }]);
await epochState.destroy();

const rows = geometryRows(run.geometry);
const hist = rows.filter((r) => !r.projection), coast = rows.filter((r) => r.projection);
const summary = udpOf(run.geometry.at(-1));
console.log('summary', JSON.stringify(summary));
const inside = (a, b) => hist.filter((r) => r.t >= T(a) && r.t < T(b));
const ext = (xs, k) => xs.length ? [Math.min(...xs.map((r) => r[k])), Math.max(...xs.map((r) => r[k]))] : [NaN, NaN];
const within = (x, lo, hi) => x >= lo && x <= hi;
const mean = (xs, k) => xs.reduce((s, r) => s + r[k], 0) / xs.length;

check('typed output: relative $OCM per segment in the target RTN, geometry $OCM on the same epochs', run.relative.length === run.geometry.length &&
  run.relative.every((r) => r.TRAJ_REF_FRAME?.NAME === 'RTN' && r.CENTER_NAME === '2024-043F' && r.STATE_VECTOR_SIZE === 6) &&
  run.relative.every((r, i) => r.STATE_DATA.length / 6 === run.geometry[i].STATE_DATA.length / run.geometry[i].STATE_VECTOR_SIZE),
  { records: run.relative.length, samples: rows.length });
check('segments: a new segment at every element update, never across one', run.geometry.every((r, i) => i === 0 || udpOf(r).SEGMENT === 'PROJECTION' ||
  udpOf(r).CHASER_ELEMENT_SET_EPOCH !== udpOf(run.geometry[i - 1]).CHASER_ELEMENT_SET_EPOCH ||
  udpOf(r).TARGET_ELEMENT_SET_EPOCH !== udpOf(run.geometry[i - 1]).TARGET_ELEMENT_SET_EPOCH ||
  T(r.METADATA.START_TIME) - T(run.geometry[i - 1].METADATA.STOP_TIME) > STEP), `${run.geometry.length} records`);

// Sep 28 - Sep 30 04:00: before the first orbit change (OEL: R -20..15, C +-28.5,
// separation 8100..8400, range rate -20..28 m/s, plane angle 0.22..0.245 deg, I -8700..-9000).
{
  const xs = inside('2026-09-28T00:00:00Z', '2026-09-30T04:00:00Z');
  const R = ext(xs, 'R_KM'), C = ext(xs, 'C_KM'), S = ext(xs, 'SEPARATION_KM'), RR = ext(xs, 'RANGE_RATE_KM_S').map((v) => v * 1000), P = ext(xs, 'PLANE_ANGLE_DEG'), I = ext(xs, 'I_KM');
  check('Sep 28-30: R oscillates about -20 .. +15 km', within(R[0], -25, -15) && within(R[1], 10, 20), R);
  check('Sep 28-30: C oscillates about +-28.5 km', within(-C[0], 24, 33) && within(C[1], 24, 33), C);
  check('Sep 28-30: separation 8100 .. 8400 km', within(S[0], 7700, 8500) && within(S[1], 8000, 8900), S);
  check('Sep 28-30: range rate about -20 .. +28 m/s', within(RR[0], -32, -10) && within(RR[1], 15, 38), RR);
  check('Sep 28-30: orbital-plane angle 0.22 .. 0.245 deg', within(P[0], 0.20, 0.235) && within(P[1], 0.235, 0.26), P);
  check('Sep 28-30: chaser ~8,700-9,000 km behind (wrapped I)', within(I[0], -9800, -8300) && within(I[1], -9300, -8000), I);
}
// Oct 1 - Oct 12: raised ~47 km (OEL: R 40..60, C envelope 27 -> 5, separation peaks
// ~13,900 at Oct 2.2 and Oct 9, near 0 at Oct 5.6, range rate -95..+95 m/s).
{
  const xs = inside('2026-10-01T06:00:00Z', '2026-10-11T20:00:00Z');
  const R = ext(xs, 'R_KM');
  check('Oct 1-12: R between ~40 and ~60 km (raised orbit)', within(R[0], 34, 45) && within(R[1], 55, 66), R);
  const c1 = ext(inside('2026-10-01T06:00:00Z', '2026-10-02T06:00:00Z'), 'C_KM'), c2 = ext(inside('2026-10-10T20:00:00Z', '2026-10-11T20:00:00Z'), 'C_KM');
  check('Oct 1-12: C envelope narrows from ~27 to ~5 km', within(c1[1], 20, 30) && within(c2[1], 3, 9), { oct1: c1, oct11: c2 });
  const S = ext(inside('2026-10-01T12:00:00Z', '2026-10-03T00:00:00Z'), 'SEPARATION_KM'), S2 = ext(inside('2026-10-05T00:00:00Z', '2026-10-06T06:00:00Z'), 'SEPARATION_KM');
  check('Oct 2: separation peaks near 13,900 km (half an orbit apart)', within(S[1], 13300, 14200), S);
  check('Oct 5-6: separation passes near zero (the chaser laps the target)', S2[0] < 400, S2);
  const RR = ext(xs, 'RANGE_RATE_KM_S').map((v) => v * 1000);
  check('Oct 1-12: range rate swings about -95 .. +95 m/s', within(RR[0], -110, -80) && within(RR[1], 80, 110), RR);
  const I = ext(xs, 'I_KM');
  check('Oct 1-12: in-track wraps at +-pi r0 (~ +-21,700 km)', I[0] < -21000 && I[1] > 21000, I);
}
// Plane angle: ~0.24 deg falling toward 0.
{
  const day = (d) => mean(inside(`${d}T00:00:00Z`, `${d}T23:59:59Z`), 'PLANE_ANGLE_DEG');
  const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'].map((d) => [d, day(d)]);
  check('plane angle ~0.24 deg on Sep 28', within(day('2026-09-28'), 0.22, 0.25), day('2026-09-28'));
  check('plane angle falls day by day Oct 1 -> Oct 11', days.every(([, v], i) => i === 0 || v < days[i - 1][1] + 0.003), days.map(([d, v]) => [d.slice(5), +v.toFixed(4)]));
  check('plane angle ~0.05 deg on Oct 11', within(day('2026-10-11'), 0.035, 0.065), day('2026-10-11'));
  const P = ext(inside('2026-10-13T00:00:00Z', '2026-10-17T12:00:00Z'), 'PLANE_ANGLE_DEG');
  check('plane angle ~0 after the Oct 12 orbit change (< 0.01 deg)', P[1] < 0.01, P);
}
// The Oct 12 orbit change.
const cosmosBrackets = run.relative.flatMap((r) => r.MANEUVER_DATA ?? []).filter((m) => m.MAN_COMMENT.join(' ').startsWith(`chaser NORAD:${CHASER}`))
  .map((m) => [T(m.MAN_EPOCH_START), T(m.MAN_EPOCH_START) + m.MAN_DURATION]);
const targetBrackets = run.relative.flatMap((r) => r.MANEUVER_DATA ?? []).filter((m) => m.MAN_COMMENT.join(' ').startsWith(`target NORAD:${TARGET}`))
  .map((m) => [T(m.MAN_EPOCH_START), T(m.MAN_EPOCH_START) + m.MAN_DURATION]);
console.log('brackets', JSON.stringify({ cosmos: cosmosBrackets.map((b) => b.map(iso)), iceye: targetBrackets.map((b) => b.map(iso)) }));
{
  const b = cosmosBrackets.find(([s, e]) => s < T('2026-10-12T12:00:00Z') && e > T('2026-10-12T12:00:00Z'));
  check('Oct 12: a Cosmos 2612 orbit-change bracket spans Oct 12', Boolean(b), b?.map(iso));
  const before = mean(inside('2026-10-11T00:00:00Z', '2026-10-11T22:00:00Z'), 'R_KM'), after = mean(inside('2026-10-13T00:00:00Z', '2026-10-14T00:00:00Z'), 'R_KM');
  check('Oct 12: mean R drops from ~+47 km to ~0', within(before, 40, 55) && Math.abs(after) < 1.0, { before, after });
  const gap = hist.filter((r) => r.t > T('2026-10-12T02:00:00Z') && r.t < T('2026-10-12T20:00:00Z')).length;
  check('Oct 12: no sample inside the bracket (shown, not propagated through)', gap === 0, gap);
}
// After Oct 13 (OEL's I-R panel): I ~ -485 -> -430 km with R -0.45..0 (Oct 13-14),
// loops at I -215 .. -95 km with R down to ~-4.7 km (Oct 15-16), then I ~ 0, |R| < 0.8 km.
{
  const first = hist.find((r) => r.t >= T('2026-10-13T00:00:00Z'));
  check('Oct 13 00:00: chaser ~480 km behind, R ~ -0.3 km', within(first.I_KM, -520, -450) && within(first.R_KM, -0.7, 0.1), { I: first.I_KM, R: first.R_KM });
  const a = inside('2026-10-13T00:00:00Z', '2026-10-14T12:00:00Z');
  const I = ext(a, 'I_KM'), R = ext(a, 'R_KM');
  check('Oct 13-14: I drifts about -485 -> -425 km with R about -0.5 .. +0.27 km', within(I[0], -520, -460) && within(I[1], -460, -400) &&
    within(R[0], -0.75, -0.3) && within(R[1], 0.1, 0.45), { I, R });
  // OEL's green arc runs from the Oct 15 bracket's end to the start of its Oct 16 bracket, which is one element set
  // earlier than ours: Oct 15 23:54, the last set both histories hold before the Oct 16 burn. Ours goes on with the
  // Oct 16 04:40 set (in our archive; the detector puts the burn after it) to about -40 km.
  const loops = inside('2026-10-15T16:00:00Z', '2026-10-15T23:55:00Z');
  const LI = ext(loops, 'I_KM'), LR = ext(loops, 'R_KM'), LC = ext(loops, 'C_KM');
  check('Oct 15-16: I-R loops, I about -215 -> -95 km (to OEL\'s next bracket)', within(LI[0], -240, -190) && within(LI[1], -120, -75), LI);
  const more = ext(inside('2026-10-15T23:55:00Z', '2026-10-16T04:41:00Z'), 'I_KM');
  console.log('Oct 15 23:55 - Oct 16 04:40 (our extra supported arc):', JSON.stringify(more));
  check('Oct 15-16: R loops reach about -4.5 km', within(LR[0], -5.5, -3.8) && within(LR[1], -1.2, 0.2), LR);
  check('Oct 15-16: C within about +-0.33 km', within(LC[0], -0.6, -0.15) && within(LC[1], 0.15, 0.6), LC);
  const end = inside('2026-10-16T16:00:00Z', '2026-10-17T12:00:01Z');
  const EI = ext(end, 'I_KM'), ER = ext(end, 'R_KM');
  check('Oct 16-17: co-located, |I| < 15 km and |R| < 1 km', EI[0] > -15 && EI[1] < 15 && ER[0] > -1.2 && ER[1] < 1.2, { EI, ER });
  const s = ext(inside('2026-10-17T00:00:00Z', '2026-10-17T12:00:01Z'), 'SEPARATION_KM');
  check('Oct 17: separation a few km', s[1] < 15, s);
}
// Brackets against OEL's amber spans (history figure, 25 px/day from the Sep 29 gridline at x = 700.5).
{
  const px = (x) => T('2026-09-29T00:00:00Z') + (x - 700.5) / 25 * DAY;
  const amber = [[730.5, 750.5], [897.5, 917.5], [1023.5, 1049.5], [1101.5, 1117.5], [1124.5, 1140.5]].map(([a, b]) => [px(a), px(b)]);
  const overlap = (a, b) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
  const ours = [...cosmosBrackets, ...targetBrackets].filter(([s, e]) => e > T(START) && s < T(STOP));
  const perSpan = amber.map((span) => ({ span: span.map(iso), covered: ours.reduce((m, b) => Math.max(m, overlap(b, span)), 0) / (span[1] - span[0]) }));
  check('brackets: every OEL amber span overlaps one of our brackets', perSpan.every((x) => x.covered > 0.3), perSpan.map((x) => +x.covered.toFixed(2)));
  const extra = ours.filter((b) => !amber.some((span) => overlap(b, span) > 0));
  check('brackets: none of ours in the window falls outside OEL\'s spans', extra.length === 0, extra.map((b) => b.map(iso)));
}
// The conditional 24 h coast from the newest sets at Oct 17 12:00 (OEL: I -1.65 -> +0.08 km,
// R -0.04 .. +0.018 km, C +-0.13 km, 16 loops).
{
  check('coast: a conditional 24 h projection from Oct 17 12:00', coast.length > 0 && coast[0].t === T(STOP) && within(coast.at(-1).t - coast[0].t, 23.9 * 3600, 24 * 3600 + 1),
    coast.length ? [iso(coast[0].t), iso(coast.at(-1).t)] : null);
  const I = [coast[0]?.I_KM, coast.at(-1)?.I_KM], R = ext(coast, 'R_KM'), C = ext(coast, 'C_KM');
  check('coast: in-track drifts forward from ~-1.6 km toward 0', within(I[0], -3.0, -0.5) && I[1] > I[0] + 0.5, I);
  check('coast: R within about -0.04 .. +0.02 km', within(R[0], -0.1, 0) && within(R[1], 0, 0.06), R);
  check('coast: C within about +-0.13 km', within(C[1], 0.05, 0.25) && within(-C[0], 0.05, 0.25), C);
  const bands = coast.filter((r) => Number.isFinite(r.SIGMA_I_KM));
  check('coast: 1-sigma bands on every projected sample', bands.length === coast.length,
    { samples: coast.length, sigmaI_first_last_km: [bands[0]?.SIGMA_I_KM, bands.at(-1)?.SIGMA_I_KM], sigmaR_last_km: bands.at(-1)?.SIGMA_R_KM });
  const rel = run.relative.at(-1);
  check('coast: the projection record says CONDITIONAL and carries the RTN covariance with its realism',
    udpOf(rel).CONDITIONAL?.startsWith('no maneuvers after') && rel.COVARIANCE_DATA.length === 6 * coast.length && rel.COV_REALISM.length === 1,
    { conditional: udpOf(rel).CONDITIONAL, calibration: rel.COV_CALIBRATION });
}
// 4: the hindcast. Predictions that compare with the same later element sets
// are not independent, so the effective sample size is the number of distinct
// truth epochs (n_eff). Per curvilinear axis the share inside the 1-sigma band
// must be consistent with 0.6827 (the nominal share inside the 95 % Wilson
// interval of the observed share at n_eff) and within 10 points of it; the
// share outside the 3-sigma band must be consistent with 0.27 % (one-sided
// binomial p >= 0.05 at n_eff). The stricter gate of analysis/gp-error-model
// (1-sigma within 5 points, at most 1 % outside 3 sigma) is reported beside it.
{
  const f1 = summary.HINDCAST_INSIDE_1SIGMA_RIC?.split(',').map(Number) ?? [], f3 = summary.HINDCAST_INSIDE_3SIGMA_RIC?.split(',').map(Number) ?? [];
  const n = Number(summary.HINDCAST_SAMPLES), nEff = Number(summary.HINDCAST_TRUTH_EPOCHS);
  console.log('hindcast', JSON.stringify({ n, nEff, f1, f3, meanD2Over3: summary.HINDCAST_MEAN_D2_OVER_3, coverage95: summary.HINDCAST_COVERAGE_95,
    calibration: summary.CALIBRATION_AT_STOP, samples: summary.RELATIVE_SAMPLES, realism: run.realism[0]?.EVIDENCE }));
  const wilson = (p, m, z = 1.959963984540054) => {
    const d = 1 + z * z / m, c = (p + z * z / (2 * m)) / d, h = z * Math.sqrt(p * (1 - p) / m + z * z / (4 * m * m)) / d;
    return [c - h, c + h];
  };
  const binomTail = (k, m, p) => { let s = 0; for (let i = 0; i < k; i++) s += Math.exp(lgamma(m + 1) - lgamma(i + 1) - lgamma(m - i + 1) + i * Math.log(p) + (m - i) * Math.log1p(-p)); return 1 - s; };
  function lgamma(x) { const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let ser = 1.000000000190015; for (const c of g) ser += c / ++y; return -t + Math.log(2.5066282746310005 * ser / x); }
  check('hindcast: at least 100 predictions and 50 distinct truth epochs', n >= 100 && nEff >= 50, { n, nEff });
  const one = f1.map((x) => ({ share: x, wilson95: wilson(x, nEff).map((v) => +v.toFixed(3)) }));
  check('hindcast: inside the 1-sigma band consistent with 0.683 on R, I and C (Wilson 95 % at n_eff, within 10 points)',
    f1.length === 3 && one.every((x) => x.wilson95[0] <= 0.6827 && x.wilson95[1] >= 0.6827 && Math.abs(x.share - 0.6827) <= 0.10), one);
  const three = f3.map((x) => { const k = Math.round((1 - x) * nEff); return { outside: +(1 - x).toFixed(4), k_eff: k, p: +binomTail(k, nEff, 0.0027).toFixed(3) }; });
  check('hindcast: outside the 3-sigma band consistent with 0.27 % on R, I and C (binomial p >= 0.05 at n_eff)',
    f3.length === 3 && three.every((x) => x.p >= 0.05), three);
  console.log('hindcast against the gp-error-model gate (1-sigma within 5 points, <= 1 % outside 3 sigma):',
    JSON.stringify(f1.map((x, k) => ({ axis: 'RIC'[k], within5: Math.abs(x - 0.6827) <= 0.05, outsideAtMost1pct: 1 - f3[k] <= 0.01 }))));
}

// ── evidence ───────────────────────────────────────────────────────────────
fs.writeFileSync(path.join(OUT, 'evidence.json'), `${JSON.stringify({ window: [START, STOP], step_s: STEP, horizon_h: HORIZON_H, model: model.id, summary, results,
  brackets: { cosmos: cosmosBrackets.map((b) => b.map(iso)), iceye: targetBrackets.map((b) => b.map(iso)) } }, null, 2)}\n`);
const { writeFigures } = await import(pathToFileURL(path.join(HERE, 'figures.mjs')).href);
writeFigures(OUT, { hist, coast, cosmosBrackets, targetBrackets, start: T(START), stop: T(STOP) });
console.log(`\n${results.length - failures}/${results.length} checks passed; evidence in ${OUT}`);
process.exit(failures ? 1 : 0);
