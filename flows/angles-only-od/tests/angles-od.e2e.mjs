#!/usr/bin/env node
// E2E (modules-angles-only-od-real-tracks-20261104): angles-only orbit determination with no element set on any port,
// on a SIMULATED arc with real SatNOGS Optical track shapes (no SatNOGS row is read): a Sentinel-6B-like orbit (a 7714
// km, e 0.0008, i 66.04 deg) flown by propagator/ffm, seen by station 11 (dwingeloo, 52.8344 N 6.3785 E 10 m) on the
// six nights of the 2026-09-21 to 26 sessions (18:00 to 05:00 UTC), RA/Dec 1-sigma 23 arcsec every 1 s, the time tags
// late by 10 ms. Each pass is cut to field crossings of 40 to 90 s, 1 to 3 per pass, 1 to 3 passes per night; night 1
// is a single crossing.
//
// Chain, every state from a module: propagator/ffm (truth, GCRF) -> foundation/frames STATE_TRANSFORM per truth sample
// (Earth-fixed) -> analysis/access (windows per night, elevation 10 deg) -> analysis/observation-simulator (RA/Dec,
// one-way light time) -> one $TDM per crossing -> analysis/optical-astrometry initial_orbit (the arc's tracks) ->
// flows/angles-only-od plan -> flows/observation-od step (analysis/estimation fit_batch, propagator/ffm) per candidate
// -> flows/angles-only-od select, stage by stage -> the final $OCM, flown by propagator/ffm to the arc end.
// The fit's dynamics are the truth's (EGM2008 20x20 with the EOP, no other force): the error measures the method and
// the data, not a force-model difference.
// Darkness is approximated: a synthetic Sun fixed in Earth-fixed axes 20 deg below station 11's northern horizon keeps
// the station dark and the satellite mostly lit; the access windows are cut to the real nights' hours.
//
//   1. initial_orbit on night 1's single crossing answers single-crossing;
//   2. the flow converges stage by stage to one $OCM; its state flown to the arc end is within BOUND_KM of the truth;
//   3. with the revolution count forced wrong (revolutionOffsetMin = revolutionOffsetMax = 1) it returns
//      no-converged-revolution-count;
//   4. no USER_DEFINED_PARAMETERS on any $OCM; PVN SOURCE_KIND Observation.
// JS reads files, routes records between modules by port, cuts windows to clock hours and compares numbers.
//   cd flows/angles-only-od && node tests/angles-od.e2e.mjs
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as flatbuffers from 'flatbuffers';
import * as P from 'spacedatastandards.org/lib/js/PRW/main.js';
import * as F from 'spacedatastandards.org/lib/js/FRM/main.js';
import * as A from 'spacedatastandards.org/lib/js/ACW/main.js';
import { EOP } from 'spacedatastandards.org/lib/js/EOP/main.js';
import { EOO } from 'spacedatastandards.org/lib/js/EOO/main.js';
import { TDM, TDMT, TDMSegmentT, TDMObservationT } from 'spacedatastandards.org/lib/js/TDM/main.js';
import { OCM } from 'spacedatastandards.org/lib/js/OCM/main.js';
import { PVN, PVNT, pvnSourceKind, pvnLicenseClass } from 'spacedatastandards.org/lib/js/PVN/main.js';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import { encodeHttpResponse, encodeModuleConfig, decodeFlowNotice } from 'space-data-module-sdk/runtime-contracts';

const BOUND_KM = 0.15;  // the first dry run's 0.0604 km, doubled and rounded up; committed into the record's acceptance
// The answers of case 2 recorded from the dists before modules-angles-only-od-real-tracks-2-20261104 (RECORD_ANSWERS=1
// writes them); the run's own must equal them: the state at the epoch within RECORDED_M, WEIGHTED_RMS within 1e-4.
const RECORDED = new URL('fixtures/angles-od-recorded.json', import.meta.url);
const RECORDED_M = 1;
const SIGMA_ARCSEC = 23;
const STATIONS = [{ id: 'SATNOGS-OPTICAL-11', lat: 52.8344, lon: 6.3785, h: 10, tagOffsetNs: 10_000_000n, timingSigma: 0.010 }];
// Per night: the crossings (seconds) of each pass kept, the passes taken in order. Night 1: one crossing.
const CROSSINGS = [[[60]], [[50, 70], [90]], [[40], [60], [80]], [[40, 50, 60]], [[90], [45]], [[55, 65], [75]]];
const CROSSING_GAP_S = 150;  // between a pass's crossings (initial_orbit's crossings split at gaps over 120 s)
// Case 5: nights 1 and 2 with one crossing each, 60 s and 16 s (HY-2C 2026-09-23 to 24: 76 s and 16 s).
const SINGLE_CROSSINGS = [[[60]], [[16]]];
const BOUND4_KM = null;  // case 4's arc-end bound: its dry run, doubled and rounded up
const BOUND5_KM = null;  // case 5's arc-end bound: its dry run, doubled and rounded up
const NIGHTS = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26'];
const T0 = '2026-09-21T17:00:00.000000Z';
const TRUTH_ELEMENTS = [7714.0e3, 0.0008, 66.04 * Math.PI / 180, 0.6, 1.5, 0.3];  // a m, e, i, RAAN, argp, true anomaly rad  // a m, e, i, RAAN, argp, true anomaly rad
const STEP_S = 30;

const modules = (p) => new URL(`../../../${p}`, import.meta.url);
const here = (p) => new URL(p, import.meta.url);
const failures = [];
const check = (ok, label) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures.push(label); };
const T = (schemaName, fileIdentifier, rootTypeName) => ({ schemaName, fileIdentifier, rootTypeName, wireFormat: 'flatbuffer' });
const PRW = T('PRW.fbs', '$PRW', 'PRW'), EST = T('Estimation.fbs', '$EST', 'EstimationEnvelope'), TDM_T = T('TDM.fbs', '$TDM', 'TDM');
const OCM_T = T('OCM.fbs', '$OCM', 'OCM'), EOP_T = T('EOP.fbs', '$EOP', 'EOP'), FRM_T = T('FRM.fbs', '$FRM', 'FRM'), ACW_T = T('ACW.fbs', '$ACW', 'ACW');
const MCFG = T('ModuleConfig.fbs', 'MCFG', 'ModuleConfig'), PVN_T = T('PVN.fbs', '$PVN', 'PVN'), HRSP = T('HttpResponse.fbs', 'HRSP', 'HttpResponse');

const harness = (p, threads = false) => createStandaloneHarness('browser', modules(p), { surface: 'direct', ...(threads ? { enableThreads: true } : {}) });
const started = Date.now();
const [eopParser, frames, access, simulator, optical, estimation, ffm, step, flow] = await Promise.all([
  harness('data-source/eop-parser/dist/isomorphic/module.wasm'), harness('foundation/frames/dist/isomorphic/module.wasm'),
  harness('analysis/access/dist/isomorphic/module.wasm'), harness('analysis/observation-simulator/dist/isomorphic/module.wasm'),
  harness('analysis/optical-astrometry/dist/isomorphic/module.wasm'), harness('analysis/estimation/dist/isomorphic/module.wasm'),
  harness('propagator/ffm/dist/isomorphic/module.wasm', true), harness('flows/observation-od/dist/isomorphic/module.wasm'),
  harness('flows/angles-only-od/dist/isomorphic/module.wasm')]);
const invoke = async (h, methodId, inputs) => {
  const r = await h.invoke({ methodId, inputs });
  if (r.statusCode !== 0) return { error: `${r.errorCode ?? ''}: ${r.errorMessage ?? ''}` };
  return r;
};
const out = (r, port) => r.outputs.filter((o) => o.portId === port).map((o) => new Uint8Array(o.payload));
const must = (r, what) => { if (r.error) { console.error(`${what}: ${r.error}`); process.exit(1); } return r; };

// ---- time labels (UTC as integer nanoseconds; TT JD for the ACW records: TAI - UTC 37 s, TT - TAI 32.184 s) ----
const ns = (iso) => {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?Z?$/.exec(iso);
  if (!m) throw new Error(`epoch ${iso}`);
  const frac = BigInt(((m[7] ?? '') + '000000000').slice(0, 9));
  return BigInt(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) * 1_000_000n + frac;
};
const iso = (n) => `${new Date(Number(n / 1_000_000n)).toISOString().slice(0, 19)}.${String(n % 1_000_000_000n).padStart(9, '0')}Z`;
const jdTt = (n) => Number(n) / 86400e9 + 2440587.5 + (37 + 32.184) / 86400;

// ---- Earth orientation: IERS finals.daily rows of 2026-09-18 to 10-02 (tests/fixtures/PROVENANCE.md) ----
const eop = must(await invoke(eopParser, 'parse_finals2000a', [{ portId: 'response', typeRef: HRSP, payload: encodeHttpResponse({
  url: 'https://datacenter.iers.org/data/latestVersion/finals.daily.iau2000.txt', status: 200, error: '', headers: { 'content-type': 'text/plain' },
  body: new Uint8Array(fs.readFileSync(here('fixtures/finals-daily-20260918-20261002.txt'))), retrievedMs: Date.parse('2026-11-04T13:47:55Z') }) }]), 'parse_finals2000a');
const eopStream = out(eop, 'records')[0];
const eopRows = [];
for (const buf = Buffer.from(eopStream), at = { i: 0 }; at.i < buf.length;) {
  const n = buf.readUInt32LE(at.i);
  eopRows.push(EOP.getRootAsEOP(new flatbuffers.ByteBuffer(Uint8Array.from(buf.subarray(at.i + 4, at.i + 4 + n)))).unpack());
  at.i += 4 + n;
}
const eopFrames = eopRows.map((row) => { const b = new flatbuffers.Builder(1024); EOP.finishEOPBuffer(b, row.pack(b)); return { portId: 'earth_orientation', typeRef: EOP_T, payload: b.asUint8Array() }; });
const table = (name, fields = {}) => Object.assign(new P[`${name}T`](), fields);
const prw = (arm, value) => { const b = new flatbuffers.Builder(1 << 16); P.PRW.finishSizePrefixedPRWBuffer(b, table('PRW', { [arm]: value }).pack(b)); return b.asUint8Array().slice(); };
const earthOrientation = prw('EARTH_ORIENTATION', table('PRWEarthOrientation', { ROWS: eopRows }));

// ---- frames ----
const system = (name, axis, epoch) => new F.RFMCoordinateSystemT(name, axis, new F.RFMOriginT(F.rfmOriginKind.CELESTIAL_BODY, 399), 399, epoch, 'UTC');
async function frm(operation, { source, target, state, representation = F.frmStateRepresentation.CARTESIAN, epoch }) {
  const r = new F.FRMFrameTransformRequestT(operation, null, null, 0, 0, null, source, target, state, representation, epoch, 'UTC', null);
  const b = new flatbuffers.Builder(2048);
  F.FRM.finishFRMBuffer(b, new F.FRMT(r, null).pack(b));
  const res = must(await invoke(frames, 'transform_frame_position', [{ portId: 'request', typeRef: FRM_T, payload: b.asUint8Array() }, ...eopFrames]), 'frames');
  const result = F.FRM.getRootAsFRM(new flatbuffers.ByteBuffer(res.outputs[0].payload)).FRAME_TRANSFORM_RESULT();
  if (result.STATUS() !== 0) { console.error(`frames: ${result.ERROR_MESSAGE()}`); process.exit(1); }
  return result.TARGET_STATE();
}
const pv = (s) => [s.POSITION().X(), s.POSITION().Y(), s.POSITION().Z(), s.VELOCITY().X(), s.VELOCITY().Y(), s.VELOCITY().Z()];
const truth0 = pv(await frm(F.frmOperationCode.STATE_REPRESENTATION_CONVERT, { source: system('ICRF', F.rfmAxisType.ICRF, T0),
  state: new F.FRMStateVectorT(F.frmStateRepresentation.KEPLERIAN, TRUTH_ELEMENTS, null, null, 'ICRF', T0, 'UTC', 3.986004415e14), epoch: T0 }));

// ---- dynamics (truth and fit): EGM2008 20x20 with the EOP, RK78 ----
const instant = (t) => table('TIMInstant', { TIME_SYSTEM: P.timingStandard.UTC, EPOCH_FORMAT: P.timEpochRepresentation.ISO8601, ISO8601: t });
const vector = (v) => table('FRMVector3', { X: v[0], Y: v[1], Z: v[2] });
const executionRequest = (state, epoch, target, samples = []) => table('PRWExecutionRequest', {
  INITIAL: table('PRWResidentState', {
    STATE: table('FRMStateVector', { REPRESENTATION: P.frmStateRepresentation.CARTESIAN, POSITION: vector(state.slice(0, 3)), VELOCITY: vector(state.slice(3)),
      COORDINATE_SYSTEM_NAME: 'GCRF', EPOCH: epoch, EPOCH_TIME_SYSTEM: 'UTC' }),
    COORDINATE_SYSTEM: table('RFMCoordinateSystem', { NAME: 'GCRF', AXIS_TYPE: P.rfmAxisType.ICRF, AXIS_REFERENCE_BODY_ID: 399,
      ORIGIN: table('RFMOrigin', { KIND: P.rfmOriginKind.CELESTIAL_BODY, CELESTIAL_BODY_ID: 399 }) }),
    CATALOG_NUMBER: 99001, OBJECT_ID: 'SIM-S6B', VALID: true }),
  TARGET_EPOCH: instant(target), SAMPLE_EPOCHS: samples.map(instant),
  INTEGRATOR: table('PCFIntegratorSettings', { ALGORITHM: P.pcfIntegratorAlgorithm.RK78, INITIAL_STEP_SECONDS: 30, MINIMUM_STEP_SECONDS: 0.001,
    MAXIMUM_STEP_SECONDS: 120, ABSOLUTE_TOLERANCES: Array(6).fill(1e-10), RELATIVE_TOLERANCE: 1e-13, MAXIMUM_STEPS: 1000000 }),
  FORCES: table('PCFForceModel', { GRAVITY_CHOICE: P.pcfGravitySelection.EGM2008, ENABLE_POINT_MASS: true, GRAVITATIONAL_PARAMETER: 3.986004415e14,
    MAXIMUM_DEGREE: 20, HAS_MAXIMUM_DEGREE: true, MAXIMUM_ORDER: 20, HAS_MAXIMUM_ORDER: true, ENABLE_THIRD_BODY: false, EPHEMERIS_SOURCE: 'Analytical', ENABLE_SRP: false, ENABLE_DRAG: false,
    INITIAL_MASS_KG: 1, AREA_M2: 1 }),
  STM_TECHNIQUE: P.prwDerivativeTechnique.ANALYTIC, DYNAMIC_PARAMETERS: [],
});
async function fly(state, epoch, samples) {
  const r = must(await invoke(ffm, 'invoke', [{ portId: 'request', typeRef: PRW, payload: prw('EXECUTION_REQUEST', executionRequest(state, epoch, samples.at(-1), samples)) },
    { portId: 'earth_orientation', typeRef: PRW, payload: earthOrientation }]), 'propagator/ffm');
  const res = P.PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(out(r, 'response')[0])).unpack().EXECUTION_RESULT;
  return res.SAMPLES.map((s) => { const x = s.STATE.STATE; return [x.POSITION.X, x.POSITION.Y, x.POSITION.Z, x.VELOCITY.X, x.VELOCITY.Y, x.VELOCITY.Z]; });
}

// ---- truth over each night, Earth-fixed ----
console.log('simulation');
const nightSpans = NIGHTS.map((d) => { const a = ns(`${d}T18:00:00Z`); return [a, a + 11n * 3600n * 1_000_000_000n]; });
const epochs = nightSpans.map(([a, b]) => { const e = []; for (let t = a; t <= b; t += BigInt(STEP_S) * 1_000_000_000n) e.push(t); return e; });
const truthGcrf = await fly(truth0, T0, epochs.flat().map(iso));
const itrf = [];
for (let k = 0; k < truthGcrf.length; ++k) {
  const t = iso(epochs.flat()[k]), s = truthGcrf[k];
  itrf.push(pv(await frm(F.frmOperationCode.STATE_TRANSFORM, { source: system('ICRF', F.rfmAxisType.ICRF, t), target: system('ITRF', F.rfmAxisType.BODY_FIXED, t),
    state: new F.FRMStateVectorT(F.frmStateRepresentation.CARTESIAN, s, new F.FRMVector3T(...s.slice(0, 3)), new F.FRMVector3T(...s.slice(3)), 'ICRF', t, 'UTC', 3.986004415e14), epoch: t })));
}
const flat = epochs.flat();
const sample = (n, x) => Object.assign(new A.ACWStateSampleT(), { JULIAN_DATE_TT: jdTt(n), POSITION_X_M: x[0], POSITION_Y_M: x[1], POSITION_Z_M: x[2],
  VELOCITY_X_MPS: x[3] ?? 0, VELOCITY_Y_MPS: x[4] ?? 0, VELOCITY_Z_MPS: x[5] ?? 0 });
const groundStation = (s) => Object.assign(new A.ACWGroundStationT(), { STATION_ID: s.id, NAME: s.id, LATITUDE_RAD: s.lat * Math.PI / 180,
  LONGITUDE_RAD: s.lon * Math.PI / 180, ALTITUDE_M: s.h, MIN_ELEVATION_RAD: 10 * Math.PI / 180, CHANNEL_CAPACITY: 1 });
const acw = (request) => { const b = new flatbuffers.Builder(1 << 22); A.ACW.finishACWBuffer(b, new A.ACWT(request, null).pack(b)); return b.asUint8Array(); };
// Access per station and night (each night's samples alone, so no run joins two nights).
const accessList = [];
let offset = 0;
for (const night of epochs) {
  const states = night.map((n, i) => sample(n, itrf[offset + i]));
  offset += night.length;
  for (const s of STATIONS) {
    const r = must(await invoke(access, 'compute_access_windows', [{ portId: 'request', typeRef: ACW_T, payload: acw(Object.assign(new A.ACWRequestT(),
      { OPERATION: 1, GROUND_STATIONS: [groundStation(s)], STATES: states, TARGET_STATION_ID: s.id, MIN_ELEVATION_OVERRIDE_RAD: 10 * Math.PI / 180, TRACE_ID: 'angles-od' })) }]), 'access');
    const result = A.ACW.getRootAsACW(new flatbuffers.ByteBuffer(r.outputs[0].payload)).unpack().RESULT;
    for (const w of result.WINDOWS) accessList.push({ station: s.id, start: w.START_JULIAN_DATE_TT, end: w.END_JULIAN_DATE_TT });
  }
}
console.log(`  truth ${flat.length} samples; ${accessList.length} access windows`);
// The synthetic Sun: 20 deg below station 11's northern horizon, fixed in Earth-fixed axes (1 au).
const la = STATIONS[0].lat * Math.PI / 180, lo = STATIONS[0].lon * Math.PI / 180, e = -20 * Math.PI / 180, AU = 1.495978707e11;
const north = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)], up = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
const sun = north.map((v, i) => (v * Math.cos(e) + up[i] * Math.sin(e)) * AU);
const model = Object.assign(new A.MEMErrorModelT(), { MODEL_ID: 'RADEC', MEASUREMENT_TYPE: A.memMeasurementType.RIGHT_ASCENSION_DECLINATION,
  NOISE_SIGMA: SIGMA_ARCSEC * Math.PI / 648000, APPLY_LIGHT_TIME: true });
const simulate = async (intervalS) => must(await invoke(simulator, 'simulate_observations', [{ portId: 'request', typeRef: ACW_T, payload: acw(Object.assign(new A.ACWRequestT(), {
  OPERATION: A.acwOperationCode.SIMULATE_OBSERVATIONS, RANDOM_SEED: 20260921n,
  GROUND_STATIONS: STATIONS.map(groundStation),
  TARGETS: [Object.assign(new A.ACWTargetT(), { TARGET_ID: 'S6B-LIKE', NORAD_CAT_ID: 99001, OBJECT_ID: 'SIM-S6B', STATES: flat.map((n, i) => sample(n, itrf[i])),
    SIGNATURE: Object.assign(new A.ACWTargetSignatureT(), { DIAMETER_M: 5, GEOMETRIC_ALBEDO: 0.2 }) })],
  SUN_STATES: [sample(flat[0], sun), sample(flat.at(-1), sun)], EARTH_ORIENTATION: eopRows,
  SENSORS: STATIONS.map((s) => Object.assign(new A.ACWSensorT(), { SENSOR_ID: s.id, HOST_ID: s.id, PHENOMENOLOGY: A.acwSensorPhenomenology.OPTICAL,
    ERROR_MODELS: [model], OBSERVATION_INTERVAL_S: intervalS, TRACK_DURATION_S: 0, MAX_SIMULTANEOUS_TRACKS: 1, LIMITING_MAGNITUDE: 0,
    MAX_HOST_SUN_ELEVATION_RAD: -12 * Math.PI / 180, FALSE_ALARM_RATE_PER_HOUR: 0 })),
  ACCESS: STATIONS.map((s) => Object.assign(new A.ACWSensorAccessT(), { SENSOR_ID: s.id, TARGET_ID: 'S6B-LIKE',
    WINDOWS: accessList.filter((w) => w.station === s.id).map((w) => Object.assign(new A.ACWAccessWindowT(), { START_JULIAN_DATE_TT: w.start, END_JULIAN_DATE_TT: w.end })) })),
})) }]), 'simulate_observations');
const sim = await simulate(1);
const eoos = out(sim, 'optical').map((b) => EOO.getRootAsEOO(new flatbuffers.ByteBuffer(b)).unpack());
const losses = {};
for (const t of A.ACW.getRootAsACW(new flatbuffers.ByteBuffer(out(sim, 'result')[0])).unpack().RESULT.TRACKS ?? [])
  for (const [k, v] of Object.entries(t)) if (/LOSS|REASON/i.test(k) && v) losses[String(v)] = (losses[String(v)] ?? 0) + 1;
console.log(`  ${eoos.length} RA/Dec observations; track loss notes ${JSON.stringify(losses)}`);

// ---- passes (a gap over 120 s starts a new one) cut to field crossings; one $TDM per crossing, tags late by 10 ms ----
const station = STATIONS[0];
const passesOf = (list) => {
  const passes = [];
  for (const r of list.map((o) => ({ t: ns(o.OB_TIME) + station.tagOffsetNs, ra: o.RA, dec: o.DECLINATION })).sort((a, b) => (a.t < b.t ? -1 : 1))) {
    const last = passes.at(-1);
    if (last && r.t - last.at(-1).t <= 120_000_000_000n) last.push(r);
    else passes.push([r]);
  }
  return passes;
};
const passes = passesOf(eoos);
const S = 1_000_000_000n;
const nightOf = (t) => nightSpans.findIndex(([a, b]) => t >= a && t <= b);
// The crossings of a plan (per night, per pass, the crossings' seconds), cut from `passes`.
function crossingsOf(passes, crossings) {
  const tracks = [];
  for (const [n, plan] of crossings.entries()) {
    const nightPasses = passes.filter((p) => nightOf(p[0].t) === n);
    if (nightPasses.length < plan.length) { console.error(`night ${n + 1}: ${nightPasses.length} passes, the plan needs ${plan.length}`); process.exit(1); }
    for (const [k, lengths] of plan.entries()) {
      const p = nightPasses[k], span = p.at(-1).t - p[0].t;
      const need = lengths.reduce((a, b) => a + BigInt(b) * S, 0n) + BigInt(lengths.length - 1) * BigInt(CROSSING_GAP_S) * S;
      if (need > span) { console.error(`night ${n + 1} pass ${k + 1}: ${Number(span / S)} s, the crossings need ${Number(need / S)} s`); process.exit(1); }
      let start = p[0].t + (span - need) / 2n;
      for (const len of lengths) {
        const end = start + BigInt(len) * S;
        tracks.push({ station, night: n, rows: p.filter((r) => r.t >= start && r.t <= end) });
        start = end + BigInt(CROSSING_GAP_S) * S;
      }
    }
  }
  return tracks;
}
const tracks = crossingsOf(passes, CROSSINGS);
// The site in Earth-fixed metres (WGS-84 closed form, the simulator test suite's helper).
const { ecef } = await import('../../../analysis/observation-simulator/tests/lib.mjs');
const tdmOf = (track, k) => {
  const site = ecef(track.station.lat, track.station.lon, track.station.h);
  const seg = Object.assign(new TDMSegmentT(), { TIME_SYSTEM: 'UTC', TIMETAG_REF: 'RECEIVE', ANGLE_TYPE: 'RADEC', REFERENCE_FRAME: 'GCRF',
    PARTICIPANT_1: track.station.id, PARTICIPANT_2: '99001', TRACK_ID: `sim-${k}`,
    OBSERVATIONS: track.rows.flatMap((r) => [Object.assign(new TDMObservationT(), { KEYWORD: 'ANGLE_1', EPOCH: iso(r.t), VALUE: r.ra }),
      Object.assign(new TDMObservationT(), { KEYWORD: 'ANGLE_2', EPOCH: iso(r.t), VALUE: r.dec })]) });
  const tdm = Object.assign(new TDMT(), { OBSERVER_ID: track.station.id, OBSERVER_X: site[0], OBSERVER_Y: site[1], OBSERVER_Z: site[2],
    CCSDS_TDM_VERS: '2.0', TIME_SYSTEM: 'UTC', ANGLE_TYPE: 'RADEC', TIMETAG_REF: 'RECEIVE', SEGMENTS: [seg] });
  const b = new flatbuffers.Builder(1 << 16);
  TDM.finishTDMBuffer(b, tdm.pack(b));
  return b.asUint8Array().slice();
};
const tdms = tracks.map(tdmOf);
const endOf = (list) => list.reduce((m, t) => (t.rows.at(-1).t > m ? t.rows.at(-1).t : m), 0n);
const arcEnd = endOf(tracks);
console.log(`  ${passes.length} passes; ${tracks.length} crossings of ${tracks.map((t) => `${t.rows.length}`).join(',')} rows (nights ${CROSSINGS.map((p) => p.flat().length).join(',')}); arc ${iso(tracks[0].rows[0].t)} to ${iso(arcEnd)}; ${((Date.now() - started) / 1000).toFixed(1)} s`);
const pvnBytes = (() => { const b = new flatbuffers.Builder(512); PVN.finishPVNBuffer(b, Object.assign(new PVNT(), { SOURCE_ID: 'observation-simulator',
  SOURCE_KIND: pvnSourceKind.Observation, ORIGINATOR: 'SIMULATED', LICENSE_CLASS: pvnLicenseClass.Reproducible, LINEAGE: 'analysis/observation-simulator' }).pack(b)); return b.asUint8Array().slice(); })();

// ---- the flow ----
const angles = (list) => [...list.map((p) => ({ portId: 'angles', typeRef: TDM_T, payload: p })), { portId: 'earth_orientation', typeRef: EOP_T, payload: eopStream }];
const night1 = await invoke(optical, 'initial_orbit', angles(tdms.filter((_, k) => tracks[k].night === 0)));
const initial = must(await invoke(optical, 'initial_orbit', angles(tdms)), 'initial_orbit');
const initialOcm = out(initial, 'orbit')[0];
const iod = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(initialOcm)).unpack();
{
  const [tr] = await fly(truth0, T0, [iod.STATE_EPOCHS[0]]);
  console.log(`  initial orbit at ${iod.STATE_EPOCHS[0]} (${iod.METADATA.START_TIME} to ${iod.METADATA.STOP_TIME}): middle-sight miss ${iod.ORBIT_DETERMINATION.OD_RESIDUAL_RMS.toExponential(2)} arcsec, ${iod.ORBIT_DETERMINATION.OD_ID}; |dr| ${(Math.hypot(...[0, 1, 2].map((i) => iod.STATE_DATA[i] * 1000 - tr[i])) / 1000).toFixed(3)} km`);
}
const template = prw('EXECUTION_REQUEST', executionRequest([0, 0, 0, 0, 0, 0], T0, T0));
const stepConfig = encodeModuleConfig({ angleSigmaArcsec: SIGMA_ARCSEC, minimumArcHours: 0, maximumIterations: 30,
  ...Object.fromEntries(STATIONS.map((s) => [`timeBiasSigmaS.${s.id}`, s.timingSigma])) });

async function fit(observations, execution) {
  const fixed = [...observations.map((p) => ({ portId: 'observations', typeRef: TDM_T, payload: p })), { portId: 'earth_orientation', typeRef: PRW, payload: earthOrientation },
    { portId: 'execution', typeRef: PRW, payload: execution }, { portId: 'config', typeRef: MCFG, payload: stepConfig }, { portId: 'provenance', typeRef: PVN_T, payload: pvnBytes }];
  let sent = null, result = null, samples = null, rounds = 0;
  const parts = { largest: 0, full: 0 };  // the propagations' SAMPLE_EPOCHS: the most, and how many at propagator/ffm's 10000
  for (let calls = 0; calls < 400; ++calls) {
    const r = await invoke(step, 'step', [...fixed, ...(sent ? [{ portId: 'estimation', typeRef: EST, payload: sent }] : []),
      ...(result ? [{ portId: 'result', typeRef: EST, payload: result }] : []), ...(samples ? [{ portId: 'samples', typeRef: PRW, payload: samples }] : [])]);
    if (r.error) return { error: r.error, rounds, parts };
    const [ocm] = out(r, 'ocm'), [propagation] = out(r, 'propagation'), [next] = out(r, 'estimation');
    if (ocm) return { ocm, rounds, parts };
    if (propagation) {
      const n = P.PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(propagation)).EXECUTION_REQUEST().sampleEpochsLength();
      parts.largest = Math.max(parts.largest, n);
      parts.full += n === 10000 ? 1 : 0;
      const p = await invoke(ffm, 'invoke', [{ portId: 'request', typeRef: PRW, payload: propagation }, { portId: 'earth_orientation', typeRef: PRW, payload: earthOrientation }]);
      if (p.error) return { error: `propagator/ffm ${p.error}`, rounds, parts };
      samples = out(p, 'response')[0];
      continue;
    }
    sent = next; samples = null;
    const est = await invoke(estimation, 'fit_batch', [{ portId: 'request', typeRef: EST, payload: sent }]);
    if (est.error) return { error: `analysis/estimation ${est.error}`, rounds, parts };
    result = out(est, 'result')[0];
    ++rounds;
  }
  return { error: 'the loop did not end', rounds, parts };
}
async function solve(flowConfig, answers = null, arc = { tdms, initialOcm }) {
  const common = [...arc.tdms.map((p) => ({ portId: 'observations', typeRef: TDM_T, payload: p })), { portId: 'initial', typeRef: OCM_T, payload: arc.initialOcm },
    ...(flowConfig ? [{ portId: 'config', typeRef: MCFG, payload: encodeModuleConfig(flowConfig) }] : [])];
  let stage = null;
  for (let s = 1; s <= 10; ++s) {
    const stageIn = stage ? [{ portId: 'stage', typeRef: OCM_T, payload: stage }] : [];
    const planned = await invoke(flow, 'plan', [...common, ...stageIn, { portId: 'execution', typeRef: PRW, payload: template }]);
    if (planned.error) return { error: planned.error };
    const notice = decodeFlowNotice(out(planned, 'report')[0]);
    if (notice.reason === 'complete') return { ocm: stage };
    const candidates = out(planned, 'execution'), observations = out(planned, 'observations');
    const ocms = [], kept = [];
    for (const [c, execution] of candidates.entries()) {
      const t = Date.now(), f = await fit(observations, execution);
      let note = '';
      if (f.ocm) {
        const o = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(f.ocm)).unpack();
        const [tr] = await fly(truth0, T0, [o.STATE_EPOCHS[0]]);
        note = `, WEIGHTED_RMS ${o.ORBIT_DETERMINATION.WEIGHTED_RMS.toFixed(3)}, |dr| at the epoch ${(Math.hypot(...[0, 1, 2].map((i) => o.STATE_DATA[i] * 1000 - tr[i])) / 1000).toFixed(3)} km, |dv| ${Math.hypot(...[3, 4, 5].map((i) => o.STATE_DATA[i] * 1000 - tr[i])).toFixed(3)} m/s`;
      }
      console.log(`  stage ${s} (${notice.items[0]}): candidate ${c + 1}/${candidates.length}${candidates.length > 1 ? ` (${notice.items.filter((x) => x.startsWith('candidate'))[c]})` : ''} over ${observations.length} tracks: ${f.error ?? 'converged'} after ${f.rounds} fit_batch calls, ${((Date.now() - t) / 1000).toFixed(1)} s${note}`);
      if (answers) {
        const o = f.ocm ? OCM.getRootAsOCM(new flatbuffers.ByteBuffer(f.ocm)).unpack() : null;
        answers.candidates.push({ stage: s, candidate: c + 1, tracks: observations.length, rounds: f.rounds, outcome: f.error ? f.error.split(':')[0] : 'converged',
          ...(o ? { epoch: o.STATE_EPOCHS[0], stateKm: o.STATE_DATA.slice(0, 6), weightedRms: o.ORBIT_DETERMINATION.WEIGHTED_RMS } : {}) });
      }
      if (f.ocm) { ocms.push(f.ocm); kept.push(execution); }
    }
    const chosen = await invoke(flow, 'select', [...common, ...stageIn, ...ocms.map((p) => ({ portId: 'candidates', typeRef: OCM_T, payload: p })),
      ...kept.map((p) => ({ portId: 'executions', typeRef: PRW, payload: p }))]);
    if (chosen.error) return { error: chosen.error };
    stage = out(chosen, 'selected')[0];
    if (decodeFlowNotice(out(chosen, 'report')[0]).reason === 'complete') return { ocm: stage };
  }
  return { error: 'the stages did not end' };
}

console.log('1. a single-crossing night');
console.log(`  ${night1.error ?? 'ACCEPTED'}`);
check(night1.error?.startsWith('single-crossing'), "initial_orbit on night 1's one crossing: single-crossing");
console.log('2. the flow');
const t1 = Date.now();
const answers = { candidates: [] };
const run = await solve(null, answers);
check(!!run.ocm, `one $OCM (${run.error ?? 'emitted'}), ${((Date.now() - t1) / 1000).toFixed(1)} s`);
let line = '';
if (run.ocm) {
  const record = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(run.ocm));
  const ocm = record.unpack(), od = ocm.ORBIT_DETERMINATION;
  const x = ocm.STATE_DATA.slice(0, 6).map((v) => v * 1000);
  const [fitted] = await fly(x, ocm.STATE_EPOCHS[0], [iso(arcEnd)]);
  const [truth] = await fly(truth0, T0, [iso(arcEnd)]);
  const dr = Math.hypot(...[0, 1, 2].map((i) => fitted[i] - truth[i])) / 1000;
  console.log(`  ${od.OD_OBSERVATIONS_USED} observations, OD_RESIDUAL_RMS ${od.OD_RESIDUAL_RMS.toFixed(2)} arcsec, WEIGHTED_RMS ${od.WEIGHTED_RMS.toFixed(3)}; at the arc end ${iso(arcEnd)} |dr| ${dr.toFixed(4)} km`);
  if (BOUND_KM === null) console.log(`  DRY RUN: arc-end position error ${dr.toFixed(4)} km; no bound asserted yet`);
  else check(dr < BOUND_KM, `arc-end position error ${dr.toFixed(4)} km below ${BOUND_KM} km`);
  check(od.FIT_STATISTICS.CONVERGED === true && od.OD_OBSERVATIONS_TYPE.includes('RADEC'), 'converged; OD_OBSERVATIONS_TYPE RADEC');
  check(ocm.PROVENANCE?.SOURCE_KIND === pvnSourceKind.Observation, `PVN ${pvnSourceKind[ocm.PROVENANCE?.SOURCE_KIND]}`);
  check(record.userDefinedParametersLength() === 0 && OCM.getRootAsOCM(new flatbuffers.ByteBuffer(initialOcm)).userDefinedParametersLength() === 0, 'no USER_DEFINED_PARAMETERS');
  line = `arc-end error ${dr.toFixed(4)} km${BOUND_KM === null ? ' (dry run)' : ` below ${BOUND_KM} km`}`;
  Object.assign(answers, { epoch: ocm.STATE_EPOCHS[0], stateKm: ocm.STATE_DATA.slice(0, 6), used: od.OD_OBSERVATIONS_USED, residualRmsArcsec: od.OD_RESIDUAL_RMS,
    weightedRms: od.WEIGHTED_RMS, arcEndKm: dr });
  if (process.env.RECORD_ANSWERS) {
    const wasm = Object.fromEntries(['analysis/optical-astrometry', 'flows/angles-only-od', 'flows/observation-od', 'analysis/estimation', 'propagator/ffm']
      .map((p) => [p, createHash('sha256').update(fs.readFileSync(modules(`${p}/dist/isomorphic/module.wasm`))).digest('hex')]));
    fs.writeFileSync(RECORDED, `${JSON.stringify({ recorded: 'tests/angles-od.e2e.mjs case 2 on the dists before modules-angles-only-od-real-tracks-2-20261104', wasmSha256: wasm, ...answers }, null, 1)}\n`);
    console.log(`  RECORDED ${RECORDED.pathname}`);
  } else {
    const was = JSON.parse(fs.readFileSync(RECORDED, 'utf8'));
    const moved = Math.hypot(...[0, 1, 2].map((i) => (answers.stateKm[i] - was.stateKm[i]) * 1000));
    console.log(`  recorded: ${was.used} observations, WEIGHTED_RMS ${was.weightedRms.toFixed(6)}, arc-end ${was.arcEndKm.toFixed(4)} km; this run's state ${moved.toFixed(4)} m from the recorded at ${was.epoch}`);
    check(answers.epoch === was.epoch && moved < RECORDED_M && Math.abs(answers.weightedRms - was.weightedRms) < 1e-4 && answers.used === was.used,
      `case 2 as recorded: state within ${RECORDED_M} m (${moved.toFixed(4)} m), WEIGHTED_RMS within 1e-4, ${was.used} observations`);
  }
}
console.log('3. a wrong revolution count');
const wrong = await solve({ revolutionOffsetMin: 1, revolutionOffsetMax: 1 });
console.log(`  ${wrong.error ?? 'ACCEPTED'}`);
check(wrong.error?.startsWith('no-converged-revolution-count'), 'revolution offset forced to +1: no-converged-revolution-count');

// The end-state error of a fitted $OCM at `end` against the truth (km).
const endError = async (ocmBytes, end) => {
  const o = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(ocmBytes)).unpack();
  const [fitted] = await fly(o.STATE_DATA.slice(0, 6).map((v) => v * 1000), o.STATE_EPOCHS[0], [iso(end)]);
  const [truth] = await fly(truth0, T0, [iso(end)]);
  return { o, km: Math.hypot(...[0, 1, 2].map((i) => fitted[i] - truth[i])) / 1000 };
};
console.log('4. the arc at 0.2 s: rounds over more than 10000 epochs in parts');
let line4 = '';
if (run.ocm) {
  const t4 = Date.now();
  const tracks4 = crossingsOf(passesOf(out(await simulate(0.2), 'optical').map((b) => EOO.getRootAsEOO(new flatbuffers.ByteBuffer(b)).unpack())), CROSSINGS);
  const rows4 = tracks4.reduce((n, t) => n + t.rows.length, 0), end4 = endOf(tracks4);
  const seed = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(run.ocm)).unpack();
  const f = await fit(tracks4.map(tdmOf), prw('EXECUTION_REQUEST', executionRequest(seed.STATE_DATA.slice(0, 6).map((v) => v * 1000), seed.STATE_EPOCHS[0], seed.STATE_EPOCHS[0])));
  console.log(`  ${tracks4.length} crossings, ${rows4} rows; ${f.error ?? 'converged'} after ${f.rounds} fit_batch calls; largest propagation ${f.parts.largest} epochs, ${f.parts.full} at 10000; ${((Date.now() - t4) / 1000).toFixed(1)} s`);
  check(!!f.ocm && rows4 >= 4000 && f.parts.full > 0 && f.parts.largest <= 10000, `${rows4} rows fitted (${f.error ?? 'converged'}), rounds in parts of at most 10000 epochs (${f.parts.full} at 10000)`);
  if (f.ocm) {
    const { o, km } = await endError(f.ocm, end4);
    const od = o.ORBIT_DETERMINATION;
    console.log(`  ${od.OD_OBSERVATIONS_USED} observations, WEIGHTED_RMS ${od.WEIGHTED_RMS.toFixed(3)}; at the arc end ${iso(end4)} |dr| ${km.toFixed(4)} km`);
    if (BOUND4_KM === null) console.log(`  DRY RUN: arc-end position error ${km.toFixed(4)} km; no bound asserted yet`);
    else check(km < BOUND4_KM && od.FIT_STATISTICS.CONVERGED === true, `arc-end position error ${km.toFixed(4)} km below ${BOUND4_KM} km`);
    line4 = `${rows4} rows in parts, arc-end ${km.toFixed(4)} km`;
  }
}
console.log('5. one crossing a night: the cross-night first guess');
let line5 = '';
{
  const tracks5 = crossingsOf(passes, SINGLE_CROSSINGS), tdms5 = tracks5.map(tdmOf), end5 = endOf(tracks5);
  const first = must(await invoke(optical, 'initial_orbit', angles(tdms5)), 'initial_orbit (case 5)');
  const initial5 = out(first, 'orbit')[0], iod5 = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(initial5)).unpack();
  const [tr] = await fly(truth0, T0, [iod5.STATE_EPOCHS[0]]);
  console.log(`  ${tracks5.length} crossings of ${tracks5.map((t) => t.rows.length).join(',')} rows; initial orbit ${iod5.ORBIT_DETERMINATION.OD_ID}, |dr| ${(Math.hypot(...[0, 1, 2].map((i) => iod5.STATE_DATA[i] * 1000 - tr[i])) / 1000).toFixed(3)} km`);
  const run5 = await solve(null, null, { tdms: tdms5, initialOcm: initial5 });
  check(!!run5.ocm, `one $OCM from the cross-night first guess (${run5.error ?? 'emitted'})`);
  if (run5.ocm) {
    const { o, km } = await endError(run5.ocm, end5);
    console.log(`  ${o.ORBIT_DETERMINATION.OD_OBSERVATIONS_USED} observations, WEIGHTED_RMS ${o.ORBIT_DETERMINATION.WEIGHTED_RMS.toFixed(3)}; at the arc end ${iso(end5)} |dr| ${km.toFixed(4)} km`);
    if (BOUND5_KM === null) console.log(`  DRY RUN: arc-end position error ${km.toFixed(4)} km; no bound asserted yet`);
    else check(km < BOUND5_KM && o.ORBIT_DETERMINATION.FIT_STATISTICS.CONVERGED === true, `arc-end position error ${km.toFixed(4)} km below ${BOUND5_KM} km`);
    line5 = `one crossing a night, arc-end ${km.toFixed(4)} km`;
  }
}

await Promise.all([eopParser, frames, access, simulator, optical, estimation, ffm, step, flow].map((h) => h.destroy?.()));
console.log(`run time ${((Date.now() - started) / 1000).toFixed(1)} s`);
if (failures.length) { console.log(`\nFAIL ${failures.length}: ${failures.join('; ')}`); process.exit(1); }
console.log(`\nPASS angles-only-od: ${line}; single-crossing named; wrong revolution count refused; ${line4}; ${line5}`);
