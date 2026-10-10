import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import * as flatbuffers from 'flatbuffers';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import * as P from 'spacedatastandards.org/lib/js/PRW/main.js';
import { MPE, meanElementSource } from 'spacedatastandards.org/lib/js/MPE/main.js';
import { OEM } from 'spacedatastandards.org/lib/js/OEM/main.js';
import { EOPT } from 'spacedatastandards.org/lib/js/EOP/main.js';

// The decay methods against independent references:
// - Vallado's SGP4 verification set (SGP4-VER.TLE with the t = 0 rows of
//   tcppver.out, analysis/epoch-state/tests/vallado-verification.json): the
//   module's SGP4 trajectory at the element sets' epochs.
// - Hoots and Roehrich (1980), Spacetrack Report No. 3, the recovery of the
//   original (Brouwer) mean motion and semi-major axis from an element set's
//   mean motion, computed here from the published formulas with WGS-72.
// - propagator/hpop: the equations of motion integrated numerically (RK78,
//   zonal gravity to degree 4, JB2008 drag of -1/2 Cd A/m rho |v_r| v_r, its own
//   frames, geodetic conversion and DE440 Sun), started from the element
//   set's epoch state in GCRF (analysis/epoch-state): the change in orbit-
//   averaged semi-major axis over two days. HPOP is given zero Earth
//   orientation (UT1 = UTC, no polar motion), the module's own approximation.
// The estimator is then checked to invert the forward model on synthetic
// histories (a self-consistency check of the least squares, not a reference).
const here = (p) => new URL(p, import.meta.url);
const modules = (p) => new URL(`../../../${p}`, import.meta.url);
const kernelPath = modules('files/orbit-products/tests/fixtures/de440/de440-2026.bsp');

async function harnessOf(dir) {
  const wasmSource = fs.readFileSync(dir === '.' ? here('../dist/isomorphic/module.wasm') : modules(`${dir}/dist/isomorphic/module.wasm`));
  const manifest = JSON.parse(fs.readFileSync(dir === '.' ? here('../plugin-manifest.json') : modules(`${dir}/plugin-manifest.json`)));
  return createBrowserModuleHarness({ wasmSource, manifest, surface: 'direct' });
}
async function call(method, request) {
  const h = await harnessOf('.');
  try {
    const r = await h.invoke({ methodId: method, inputs: [{ portId: 'request', payload: Buffer.from(JSON.stringify(request)), typeRef: { schemaName: 'application/json' } }] });
    if (r.statusCode !== 0) throw new Error(`${r.errorCode}: ${r.errorMessage}`);
    return JSON.parse(Buffer.from(r.outputs[0].payload).toString('utf8'));
  } finally {
    await h.destroy();
  }
}
const isoOfMjd = (mjd) => new Date((mjd - 40587) * 86400000).toISOString().replace('Z', '');
const dayOfMjd = (mjd) => isoOfMjd(mjd).slice(0, 10);
// Constant synthetic drivers over [from, to] (whole days), DTC raised by add.
function rows(fromMjd, toMjd, add = 0) {
  const out = [];
  for (let d = Math.floor(fromMjd); d <= Math.ceil(toMjd); ++d)
    out.push({ DATE: dayOfMjd(d), F10: 150, F10_CENTRED_81: 145, S10: 140, S10_CENTRED_81: 138, M10: 148, M10_CENTRED_81: 146,
      Y10: 130, Y10_CENTRED_81: 128, DTC_HOURLY_K: Array(24).fill(40 + add) });
  return out;
}
// A circular-ish LEO element set: the Kozai mean motion of semi-major axis a (km).
const meanMotion = (aKm) => 86400 / (2 * Math.PI * Math.sqrt(aKm ** 3 / 398600.8));
const set = (mjd, aKm, e, inc, extra = {}) => ({ mjd, MEAN_MOTION: meanMotion(aKm), ECCENTRICITY: e, INCLINATION: inc, RA_OF_ASC_NODE: 40,
  ARG_OF_PERICENTER: 90, MEAN_ANOMALY: 0, BSTAR: 1e-5, ...extra });

test('SGP4 trajectory at epoch reproduces Vallado\'s verification states; mean a follows Spacetrack Report No. 3', async () => {
  const fixture = JSON.parse(fs.readFileSync(modules('analysis/epoch-state/tests/vallado-verification.json'), 'utf8'));
  // Near-Earth sets (period under 225 min) with epochs inside drivers we supply.
  const cases = fixture.cases.filter((c) => c.MEAN_MOTION > 1440 / 225);
  assert.ok(cases.length >= 3);
  const mjds = cases.map((c) => c.epochUnix / 86400 + 40587);
  const out = await call('decay', {
    jb2008: { rows: rows(Math.min(...mjds) - 7, Math.max(...mjds) + 2) }, samples: true, stepSeconds: 60,
    objects: cases.map((c, i) => ({ id: String(c.satnum), spanDays: 0.01, sets: [{ mjd: mjds[i], MEAN_MOTION: c.MEAN_MOTION, ECCENTRICITY: c.ECCENTRICITY,
      INCLINATION: c.INCLINATION, RA_OF_ASC_NODE: c.RA_OF_ASC_NODE, ARG_OF_PERICENTER: c.ARG_OF_PERICENTER, MEAN_ANOMALY: c.MEAN_ANOMALY, BSTAR: c.BSTAR }] })),
  });
  // WGS-72: ke = 60 / sqrt(Re^3 / mu) per minute, k2 = J2 / 2.
  const ke = 60 / Math.sqrt(6378.135 ** 3 / 398600.8), k2 = 0.5 * 0.001082616;
  cases.forEach((c, i) => {
    const o = out.objects[i];
    assert.equal(o.ok, true, `${c.satnum}`);
    // tcppver.out prints 1e-8 km.
    const s = o.samples[0];
    s.temeKm.forEach((x, k) => assert.ok(Math.abs(x - c.temeR[k]) < 2e-8, `${c.satnum} r[${k}] ${x} vs ${c.temeR[k]}`));
    s.temeKmS.forEach((x, k) => assert.ok(Math.abs(x - c.temeV[k]) < 2e-9, `${c.satnum} v[${k}] ${x} vs ${c.temeV[k]}`));
    const n0 = c.MEAN_MOTION * 2 * Math.PI / 1440, e = c.ECCENTRICITY, ci = Math.cos(c.INCLINATION * Math.PI / 180);
    const shape = (3 * ci * ci - 1) / (1 - e * e) ** 1.5;
    const a1 = (ke / n0) ** (2 / 3), d1 = 1.5 * k2 / a1 ** 2 * shape;
    const a0 = a1 * (1 - d1 / 3 - d1 * d1 - 134 / 81 * d1 ** 3), d0 = 1.5 * k2 / a0 ** 2 * shape;
    const brouwer = a0 / (1 - d0) * 6378.135;
    assert.ok(Math.abs(o.sets[0].aKm - brouwer) < 1e-6, `${c.satnum}: a ${o.sets[0].aKm} vs ${brouwer} km`);
  });
});

// The element set's GCRF epoch state from analysis/epoch-state (MPE in, OEM out).
async function epochState(s) {
  const b = new flatbuffers.Builder(256);
  const id = b.createString('TEST');
  MPE.startMPE(b);
  MPE.addEntityId(b, id);
  MPE.addEpoch(b, (s.mjd - 40587) * 86400);
  MPE.addMeanMotion(b, s.MEAN_MOTION);
  MPE.addEccentricity(b, s.ECCENTRICITY);
  MPE.addInclination(b, s.INCLINATION);
  MPE.addRaOfAscNode(b, s.RA_OF_ASC_NODE);
  MPE.addArgOfPericenter(b, s.ARG_OF_PERICENTER);
  MPE.addMeanAnomaly(b, s.MEAN_ANOMALY);
  MPE.addBstar(b, s.BSTAR);
  MPE.addMeanElementTheory(b, meanElementSource.SGP4);
  MPE.finishSizePrefixedMPEBuffer(b, MPE.endMPE(b));
  const f = b.asUint8Array();
  const payload = new Uint8Array(f.length + ((8 - (f.length % 8)) % 8));
  payload.set(f);
  const h = await harnessOf('analysis/epoch-state');
  try {
    const r = await h.invoke({ methodId: 'derive', inputs: [{ portId: 'elements', payload, typeRef: { schemaName: 'MPE.fbs', fileIdentifier: '$MPE', rootTypeName: 'MPE',
      wireFormat: 'aligned-binary', requiredAlignment: 8, byteLength: payload.byteLength } }] });
    if (r.statusCode !== 0) throw new Error(r.errorMessage);
    const bytes = new Uint8Array(r.outputs.find((o) => o.portId === 'states').payload);
    const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
    const line = OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(bytes.slice(0, 4 + n))).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES[0];
    return { r: [line.X, line.Y, line.Z], v: [line.X_DOT, line.Y_DOT, line.Z_DOT] };
  } finally {
    await h.destroy();
  }
}
// HPOP over [t0, t0 + span] from a GCRF state: zonal gravity to degree 4,
// JB2008 drag with Cd A/m = B (unit area and mass), the DE440 Sun; samples every 30 s.
async function hpopTrack(epochMjd, state, spanDays, B, jbRows) {
  const table = (name, fields = {}) => Object.assign(new P[`${name}T`](), fields);
  const encode = (arm, value) => {
    const b = new flatbuffers.Builder(1 << 16);
    P.PRW.finishSizePrefixedPRWBuffer(b, table('PRW', { [arm]: value }).pack(b));
    return b.asUint8Array().slice();
  };
  const TYPE = { schemaName: 'PRW.fbs', fileIdentifier: '$PRW', rootTypeName: 'PRW', wireFormat: 'flatbuffer' };
  const instant = (mjd) => table('TIMInstant', { TIME_SYSTEM: P.timingStandard.UTC, EPOCH_FORMAT: P.timEpochRepresentation.ISO8601, ISO8601: isoOfMjd(mjd) });
  const vec = (v) => table('FRMVector3', { X: v[0] * 1000, Y: v[1] * 1000, Z: v[2] * 1000 });
  const gcrf = table('RFMCoordinateSystem', { NAME: 'GCRF', AXIS_TYPE: P.rfmAxisType.ICRF, AXIS_REFERENCE_BODY_ID: 399,
    ORIGIN: table('RFMOrigin', { KIND: P.rfmOriginKind.CELESTIAL_BODY, CELESTIAL_BODY_ID: 399 }) });
  const samples = [];
  for (let t = 0; t <= spanDays * 86400 + 1e-6; t += 30) samples.push(epochMjd + t / 86400);
  const request = table('PRWExecutionRequest', {
    INITIAL: table('PRWResidentState', { STATE: table('FRMStateVector', { REPRESENTATION: P.frmStateRepresentation.CARTESIAN, POSITION: vec(state.r), VELOCITY: vec(state.v),
      COORDINATE_SYSTEM_NAME: 'GCRF', EPOCH: isoOfMjd(epochMjd), EPOCH_TIME_SYSTEM: 'UTC' }), COORDINATE_SYSTEM: gcrf, HAS_MASS_KG: false, MASS_KG: 0 }),
    TARGET_EPOCH: instant(samples.at(-1)),
    INTEGRATOR: table('PRWIntegratorSettings', { ALGORITHM: P.prwSolverAlgorithm.RK78, INITIAL_STEP_SECONDS: 30, MINIMUM_STEP_SECONDS: 0.01, MAXIMUM_STEP_SECONDS: 60,
      ABSOLUTE_TOLERANCES: Array(6).fill(1e-9), RELATIVE_TOLERANCE: 1e-12, MAXIMUM_STEPS: 1000000 }),
    FORCES: table('PRWForceConfiguration', { GRAVITY_CHOICE: P.prwGravitySelection.SPHERICAL_HARMONICS, ENABLE_POINT_MASS: true, GRAVITATIONAL_PARAMETER: 398600.4418e9,
      ENABLE_J2: false, ENABLE_J3: false, ENABLE_J4: false, ENABLE_HIGHER_ZONALS: false, MAXIMUM_DEGREE: 4, HAS_MAXIMUM_DEGREE: true, MAXIMUM_ORDER: 0, HAS_MAXIMUM_ORDER: true,
      ENABLE_THIRD_BODY: false, THIRD_BODY_IDS: [], ENABLE_SRP: false, ENABLE_DRAG: true, INITIAL_MASS_KG: 1, AREA_M2: 1, REFLECTIVITY_COEFFICIENT: 0, DRAG_COEFFICIENT: B,
      ATMOSPHERE_MODEL: P.prwAtmosphereFamily.JB2008, EPHEMERIS_SOURCE: 'JPL_SPK', SOLID_TIDES: P.prwSolidTideModel.NONE, RELATIVITY: P.prwRelativityTerms.NONE }),
    INCLUDE_STM: false, STM_TECHNIQUE: P.prwDerivativeTechnique.ANALYTIC, DENSITY_TREATMENT: P.prwDensityTreatment.NEGLECTED, DYNAMIC_PARAMETERS: [],
    SAMPLE_EPOCHS: samples.map(instant),
  });
  const kernel = fs.readFileSync(kernelPath);
  const descriptor = table('NCD', { FORMAT: P.ncdContainerFormat.SPK_DAF, SOURCE_BYTE_LENGTH: BigInt(kernel.length),
    SOURCE_SHA256: createHash('sha256').update(kernel).digest('hex') });
  const h = await harnessOf('propagator/hpop');
  try {
    const r = await h.invoke({ methodId: 'invoke', inputs: [
      { portId: 'request', typeRef: TYPE, payload: encode('EXECUTION_REQUEST', request) },
      { portId: 'kernel', typeRef: TYPE, payload: encode('NATIVE_INPUT', table('PRWNativeInput', { DESCRIPTOR: descriptor, CONTENT: Array.from(kernel) })) },
      { portId: 'jb2008_indices', typeRef: TYPE, payload: encode('JB2008_INDICES', table('PRWJB2008IndicesTable', { ROWS: jbRows.map((x) => table('PRWJB2008Indices', x)) })) },
      { portId: 'earth_orientation', typeRef: TYPE, payload: encode('EARTH_ORIENTATION', table('PRWEarthOrientation', { ROWS: jbRows.map((x) => Object.assign(new EOPT(), {
        MJD: Math.round(Date.parse(`${x.DATE}T00:00:00Z`) / 86400000 + 40587), TAI_MINUS_UTC_SECONDS: 37 })) })) },
    ] });
    if (r.statusCode !== 0) throw new Error(`${r.errorCode}: ${r.errorMessage}`);
    const root = P.PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(new Uint8Array(r.outputs.find((o) => o.portId === 'response').payload))).unpack();
    return root.EXECUTION_RESULT.SAMPLES.map((s, i) => {
      const st = s.STATE.STATE, p = st.POSITION, v = st.VELOCITY;
      const rr = Math.hypot(p.X, p.Y, p.Z), vv = v.X ** 2 + v.Y ** 2 + v.Z ** 2;
      return { mjd: samples[i], a: 1 / (2 / rr - vv / 398600.4418e9), z: p.Z };
    });
  } finally {
    await h.destroy();
  }
}
// HPOP's drag decay rate (m/day): the osculating semi-major axis averaged
// over whole nodal periods (measured from the track's own ascending-node
// crossings, so the J2 short-period terms cancel) at the start and after
// spanDays, divided by the time between the two averages.
function hpopRate(track, spanDays, periods = 6) {
  const nodes = [];
  for (let i = 1; i < track.length; ++i)
    if (track[i - 1].z < 0 && track[i].z >= 0) nodes.push({ i, t: track[i - 1].mjd + (track[i].mjd - track[i - 1].mjd) * (-track[i - 1].z) / (track[i].z - track[i - 1].z) });
  // Time average of a between two crossings, a linear between samples.
  const mean = (k) => {
    const T0 = nodes[k].t, T1 = nodes[k + periods].t;
    let s = 0;
    for (let i = Math.max(1, nodes[k].i - 1); i <= nodes[k + periods].i; ++i) {
      const lo = Math.max(T0, track[i - 1].mjd), hi = Math.min(T1, track[i].mjd);
      if (!(hi > lo)) continue;
      const at = (t) => track[i - 1].a + (track[i].a - track[i - 1].a) * (t - track[i - 1].mjd) / (track[i].mjd - track[i - 1].mjd);
      s += (at(lo) + at(hi)) / 2 * (hi - lo);
    }
    return { a: s / (T1 - T0), t: (T0 + T1) / 2 };
  };
  const k1 = nodes.findIndex((x) => x.t >= track[0].mjd + spanDays);
  const a = mean(0), b = mean(k1);
  return (b.a - a.a) / (b.t - a.t);
}

test('the drag decay of an element set matches HPOP\'s numerically integrated decay (circular 400 km, eccentric, with a correction)',
  { skip: !fs.existsSync(kernelPath) && `DE440 fixture absent: ${kernelPath.pathname}` }, async () => {
    const t0 = 61046.0;  // 2026-01-05 00:00 UTC
    // One day, about an element set's refresh interval in LEO: one set's SGP4
    // trajectory does not follow its own decay, the numerical one does.
    const span = 1;
    const cases = [
      { name: 'circular 400 km, 51.6 deg', B: 0.02, tolerance: 0.01, s: set(t0, 6778.137 + 2, 0.0004, 51.6) },
      { name: 'eccentric, perigee ~320 km, e 0.05', B: 0.05, tolerance: 0.02, s: set(t0, 7050, 0.05, 82.9) },
    ];
    for (const { name, B, tolerance, s } of cases) {
      const periodS = 86400 / s.MEAN_MOTION;
      const ratios = {};
      for (const add of [0, 60]) {
        const jb = rows(t0 - 8, t0 + span + 2, add);
        // The module: the set alone over the span, the correction (when given) as nodes; HPOP: DTC raised by the same amount.
        const correction = add ? { nodesMjd: [t0 - 1, t0 + span + 1], altitudeKm: [], values: [[add], [add]] } : undefined;
        const module = await call('decay', { jb2008: { rows: rows(t0 - 8, t0 + span + 2) }, stepSeconds: 30,
          objects: [{ id: name, B, spanDays: span, sets: [s] }], ...(correction ? { correction } : {}) });
        const rate = module.objects[0].segments[0].decayM / span;
        const hpop = hpopRate(await hpopTrack(t0, await epochState(s), span + 8.5 * periodS / 86400, B, jb), span);
        ratios[add] = { module: rate, hpop };
        // Measured: circular 0.996, eccentric 0.984. SGP4's analytical
        // trajectory against the numerical one, and the anomaly-dependent
        // short-period terms that nodal averages leave at e = 0.05.
        assert.ok(Math.abs(rate / hpop - 1) < tolerance, `${name}, DTC +${add} K: module ${rate.toFixed(2)} m/day vs HPOP ${hpop.toFixed(2)} m/day (ratio ${(rate / hpop).toFixed(4)})`);
      }
      // The response to the correction is the same (measured within 0.03 %).
      const response = (x) => x[60] / x[0];
      const m = response({ 0: ratios[0].module, 60: ratios[60].module }), h = response({ 0: ratios[0].hpop, 60: ratios[60].hpop });
      assert.ok(Math.abs(m / h - 1) < 0.002, `${name}: response to +60 K module ${m.toFixed(4)} vs HPOP ${h.toFixed(4)}`);
    }
  });

// Synthetic histories: element sets every 8 h whose Brouwer semi-major axes
// follow the forward model under a known correction and known B, plus noise.
function brouwerToKozai(aKm, e, incDeg) {
  // Inverts Spacetrack Report No. 3's recovery of a from n (bisection on n).
  const ke = 60 / Math.sqrt(6378.135 ** 3 / 398600.8), k2 = 0.5 * 0.001082616, ci = Math.cos(incDeg * Math.PI / 180);
  const shape = (3 * ci * ci - 1) / (1 - e * e) ** 1.5;
  const aOf = (nRevDay) => {
    const n0 = nRevDay * 2 * Math.PI / 1440, a1 = (ke / n0) ** (2 / 3), d1 = 1.5 * k2 / a1 ** 2 * shape;
    const a0 = a1 * (1 - d1 / 3 - d1 * d1 - 134 / 81 * d1 ** 3), d0 = 1.5 * k2 / a0 ** 2 * shape;
    return a0 / (1 - d0) * 6378.135;
  };
  let lo = 5, hi = 17;
  for (let k = 0; k < 200; ++k) { const mid = (lo + hi) / 2; if (aOf(mid) > aKm) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
function random(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x9e3779b9) >>> 0; let z = s; z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0; z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0; return ((z ^ (z >>> 16)) >>> 0) / 4294967296; };
}
async function synthetic({ t0, days, objects, correction, noiseM, seed }) {
  const rnd = random(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const histories = objects.map((o) => ({ ...o, sets: Array.from({ length: Math.floor(days * 3) + 1 }, (_, k) => set(t0 + k / 3, o.aKm, o.e, o.inc, { MEAN_ANOMALY: (k * 97) % 360 })) }));
  // trendMPerDay: a rise drag cannot make (radiation pressure on a high, light object).
  const noise = histories.map((h) => h.sets.map((_, k) => noiseM * gauss() + (h.trendMPerDay ?? 0) * k / 3));
  // Two passes: the sets' mean motions follow the modelled decay of the trajectories they define.
  for (let pass = 0; pass < 2; ++pass) {
    const out = await call('decay', { jb2008: { rows: rows(t0 - 8, t0 + days + 2) }, stepSeconds: 120, correction,
      objects: histories.map((h) => ({ id: h.id, B: h.B, sets: h.sets })) });
    out.objects.forEach((o, i) => {
      const h = histories[i];
      h.sets = h.sets.map((s, k) => ({ ...s, MEAN_MOTION: brouwerToKozai(h.aKm + (o.sets[k].cumulativeDecayM + noise[i][k]) / 1000, s.ECCENTRICITY, s.INCLINATION) }));
    });
  }
  return histories;
}

test('calibrate_decay recovers a known correction and ballistic coefficients from synthetic histories, converges with an object whose sets rise; the level needs an anchor', async () => {
  const t0 = 61046.0, days = 8;
  // The true correction: 30 K, a one-day 90 K excursion from day 3, then 10 K.
  const nodesMjd = [], values = [];
  for (let h = 0; h <= days * 24 + 24; h += 6) {
    const t = t0 - 1 + h / 24, d = t - t0;
    nodesMjd.push(t);
    values.push([d < 3 ? 30 : d < 4 ? 90 : 10]);
  }
  const truth = { nodesMjd, altitudeKm: [], values };
  const objects = [
    { id: 'A', aKm: 6378.137 + 360, e: 0.0008, inc: 65, B: 0.012 }, { id: 'B', aKm: 6378.137 + 420, e: 0.001, inc: 82, B: 0.03 },
    { id: 'C', aKm: 6378.137 + 480, e: 0.0015, inc: 98, B: 0.02 }, { id: 'D', aKm: 6378.137 + 540, e: 0.002, inc: 51.6, B: 0.05 },
    { id: 'E', aKm: 7100, e: 0.06, inc: 74, B: 0.012 }, { id: 'F', aKm: 6378.137 + 380, e: 0.001, inc: 28, B: 0.008 },
    // Its sets rise 0.4 m a day: its B runs towards zero, and it must not keep the fit from converging.
    { id: 'G', aKm: 6378.137 + 880, e: 0.001, inc: 99, B: 0.005, trendMPerDay: 0.4 },
  ];
  const histories = await synthetic({ t0, days, objects, correction: truth, noiseM: 1, seed: 20261009 });
  const request = (anchor) => ({ jb2008: { rows: rows(t0 - 8, t0 + days + 2) }, stepSeconds: 120, iterations: 12,
    nodes: { fromMjd: t0, toMjd: t0 + days, stepHours: 6 }, priors: { randomWalkKPerSqrtDay: 60, meanLevelK: 200 }, sigmaFloorM: 0.5,
    objects: histories.map((h) => ({ id: h.id, sets: h.sets, ...(anchor && h.id === 'C' ? { lnBPrior: { mean: Math.log(h.B), sigma: 0.01 } } : {}) })) });
  const anchored = await call('calibrate_decay', request(true));
  assert.equal(anchored.fit.converged, true, JSON.stringify(anchored.fit));
  const trueAt = (t) => { const d = t - t0; return d < 3 ? 30 : d < 4 ? 90 : 10; };
  const nodes = anchored.correction.nodesMjd.map((t, j) => ({ d: t - t0, err: anchored.correction.values[j][0] - trueAt(t), sigma: anchored.correction.sigmas[j][0] }));
  // Away from the excursion's edges (a random walk smooths a step over about a day).
  const steady = nodes.filter(({ d }) => (d > 0.75 && d < 2.25) || (d > 5 && d < 7.25));
  const rms = (xs) => Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / xs.length);
  assert.ok(rms(steady.map((x) => x.err)) < 8, `steady-state correction error ${rms(steady.map((x) => x.err)).toFixed(2)} K`);
  // The formal sigmas describe the errors.
  assert.ok(rms(steady.map((x) => x.err / x.sigma)) < 2.5, `normalized error ${rms(steady.map((x) => x.err / x.sigma)).toFixed(2)}`);
  const excursion = nodes.filter(({ d }) => d >= 3.25 && d <= 3.75).map((x) => x.err + 90);
  assert.ok(Math.min(...excursion) > 60, `the 90 K excursion is seen (${excursion.map((x) => x.toFixed(1))})`);
  const trueLevel = anchored.correction.nodesMjd.reduce((a, t) => a + trueAt(t), 0) / nodes.length;
  const [level] = anchored.fit.level;
  assert.ok(Math.abs(level.meanK - trueLevel) < 3 * level.sigmaK + 1, `level ${level.meanK} +- ${level.sigmaK} vs ${trueLevel}`);
  anchored.objects.filter((o) => o.id !== 'G').forEach((o) => {
    const B = objects.find((x) => x.id === o.id).B;
    assert.ok(Math.abs(o.B / B - 1) < 0.01, `${o.id}: B ${o.B} vs ${B}`);
  });
  // Without the anchor, B and the level trade off: the level's formal sigma
  // grows and its correlation with the mean ln B approaches -1.
  const free = await call('calibrate_decay', request(false));
  assert.ok(free.fit.meanLevelSigmaK > 4 * anchored.fit.meanLevelSigmaK, `level sigma free ${free.fit.meanLevelSigmaK} vs anchored ${anchored.fit.meanLevelSigmaK}`);
  assert.ok(free.fit.levelLnBCorrelation < -0.9, `correlation ${free.fit.levelLnBCorrelation}`);
});

test('a node correction in evaluate applies dT(t, h) linear in time and altitude, and a constant one equals raising DTC', async () => {
  const t0 = 61046.0;
  const points = { mjd: [t0 + 0.25, t0 + 0.5, t0 + 0.75, t0 + 0.5, t0 + 0.5, t0 + 0.5], latDeg: [10, 10, 10, 10, 10, 10], lonDeg: [20, 20, 20, 20, 20, 20],
    altKm: [600, 600, 600, 300, 1000, 200] };
  const correction = { nodesMjd: [t0, t0 + 1], altitudeKm: [400, 800], values: [[10, 50], [30, 90]] };
  const out = await call('evaluate', { points, jb2008: { rows: rows(t0 - 8, t0 + 2) }, correction });
  // At 600 km the altitude weight is one half; time weights 1/4, 1/2, 3/4.
  const at = (wt, h) => { const c = Math.max(300, Math.min(900, h)); const wa = (c - 400) / 400; return (1 - wt) * ((1 - wa) * 10 + wa * 50) + wt * ((1 - wa) * 30 + wa * 90); };
  const expected = [at(0.25, 600), at(0.5, 600), at(0.75, 600), at(0.5, 300), at(0.5, 1000), at(0.5, 200)];
  out.deltaT.forEach((x, i) => assert.ok(Math.abs(x - expected[i]) < 1e-9, `point ${i}: ${x} vs ${expected[i]}`));
  const constant = await call('evaluate', { points, jb2008: { rows: rows(t0 - 8, t0 + 2) }, correction: { nodesMjd: [t0 - 1], altitudeKm: [], values: [[25]] } });
  const raised = await call('evaluate', { points, jb2008: { rows: rows(t0 - 8, t0 + 2, 25) } });
  constant.density.forEach((rho, i) => assert.ok(Math.abs(rho / raised.density[i] - 1) < 1e-12));
});
