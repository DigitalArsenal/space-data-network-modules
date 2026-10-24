import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { S as P, call, dayOfMjd } from './dcl.mjs';

const { flatbuffers, EOPT } = P;

// energy and drag_work against propagator/ffm, the module that integrates the
// equations of motion.
//
// The Jacobi integral C = 1/2 |v|^2 + U(r_ef) - omega . (r x v) of a static
// geopotential in axes turning with the Earth is a constant of any orbit that
// only the geopotential acts on (closed form: dC/dt = 0 when a = -grad U). FFM
// integrates exactly such an orbit when asked for gravity alone (EGM2008 to
// degree and order 36, RK78 at relative tolerance 1e-12, UT1 = UTC and no polar
// motion, the module's own assumption), so C computed by `energy` along FFM's
// samples must stay constant to the integrator's accuracy, while the Kepler
// energy 1/2 v^2 - mu/r moves by tens of kJ/kg and a wrong field degree leaves
// a visible drift. With JB2008 drag FFM's C must fall by the integral of
// -1/2 B rho |v_r|^3 (dC/dt = a . v_r), which `drag_work` evaluates with the
// module's own JB2008. The gradient is checked against finite differences of
// `energy` itself.
const here = (p) => new URL(p, import.meta.url);
const modules = (p) => new URL(`../../../${p}`, import.meta.url);
const kernelPath = modules('files/orbit-products/tests/fixtures/de440/de440-2026.bsp');
const ffmWasm = modules('propagator/ffm/dist/isomorphic/module.wasm');
const GM = 398600.4418e9;  // the central term FFM is given below
const OMEGA = 7.292115e-5; // rad/s, FFM's OMEGA_EARTH

async function harnessOf(dir) {
  const wasmSource = fs.readFileSync(dir === '.' ? here('../dist/isomorphic/module.wasm') : modules(`${dir}/dist/isomorphic/module.wasm`));
  const manifest = JSON.parse(fs.readFileSync(dir === '.' ? here('../plugin-manifest.json') : modules(`${dir}/plugin-manifest.json`)));
  return createBrowserModuleHarness({ wasmSource, manifest, surface: 'direct' });
}
const isoOfMjd = (mjd) => new Date((mjd - 40587) * 86400000).toISOString().replace('Z', '');

// A Cartesian GCRF state from Keplerian elements (a m, e, angles deg): the textbook rotation, as an independent starting state.
function keplerState(a, e, iDeg, raanDeg, argpDeg, nuDeg) {
  const d = Math.PI / 180, nu = nuDeg * d, p = a * (1 - e * e), r = p / (1 + e * Math.cos(nu)), vq = Math.sqrt(GM / p);
  const pqw = [r * Math.cos(nu), r * Math.sin(nu), 0], vpqw = [-vq * Math.sin(nu), vq * (e + Math.cos(nu)), 0];
  const cO = Math.cos(raanDeg * d), sO = Math.sin(raanDeg * d), ci = Math.cos(iDeg * d), si = Math.sin(iDeg * d), cw = Math.cos(argpDeg * d), sw = Math.sin(argpDeg * d);
  const R = [[cO * cw - sO * sw * ci, -cO * sw - sO * cw * ci, sO * si], [sO * cw + cO * sw * ci, -sO * sw + cO * cw * ci, -cO * si], [sw * si, cw * si, ci]];
  const mul = (v) => R.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  return { r: mul(pqw), v: mul(vpqw) };
}

// FFM over [t0, t0 + span], samples every stepSeconds, from a GCRF state (m, m/s). forces: {degree, drag (B) | null, jbRows}.
async function ffmTrack(epochMjd, state, spanSeconds, stepSeconds, { degree = 36, B = null, jbRows }) {
  const table = (name, fields = {}) => Object.assign(new P[`${name}T`](), fields);
  const encode = (arm, value) => {
    const b = new flatbuffers.Builder(1 << 16);
    P.PRW.finishSizePrefixedPRWBuffer(b, table('PRW', { [arm]: value }).pack(b));
    return b.asUint8Array().slice();
  };
  const TYPE = { schemaName: 'PRW.fbs', fileIdentifier: '$PRW', rootTypeName: 'PRW', wireFormat: 'flatbuffer' };
  const instant = (mjd) => table('TIMInstant', { TIME_SYSTEM: P.timingStandard.UTC, EPOCH_FORMAT: P.timEpochRepresentation.ISO8601, ISO8601: isoOfMjd(mjd) });
  const vec = (v) => table('FRMVector3', { X: v[0], Y: v[1], Z: v[2] });
  const gcrf = table('RFMCoordinateSystem', { NAME: 'GCRF', AXIS_TYPE: P.rfmAxisType.ICRF, AXIS_REFERENCE_BODY_ID: 399,
    ORIGIN: table('RFMOrigin', { KIND: P.rfmOriginKind.CELESTIAL_BODY, CELESTIAL_BODY_ID: 399 }) });
  const samples = [];
  for (let t = 0; t <= spanSeconds + 1e-6; t += stepSeconds) samples.push(epochMjd + t / 86400);
  const request = table('PRWExecutionRequest', {
    INITIAL: table('PRWResidentState', { STATE: table('FRMStateVector', { REPRESENTATION: P.frmStateRepresentation.CARTESIAN, POSITION: vec(state.r), VELOCITY: vec(state.v),
      COORDINATE_SYSTEM_NAME: 'GCRF', EPOCH: isoOfMjd(epochMjd), EPOCH_TIME_SYSTEM: 'UTC' }), COORDINATE_SYSTEM: gcrf, HAS_MASS_KG: false, MASS_KG: 0 }),
    TARGET_EPOCH: instant(samples.at(-1)),
    INTEGRATOR: table('PCFIntegratorSettings', { ALGORITHM: P.pcfIntegratorAlgorithm.RK78, INITIAL_STEP_SECONDS: 10, MINIMUM_STEP_SECONDS: 0.01, MAXIMUM_STEP_SECONDS: 40,
      ABSOLUTE_TOLERANCES: Array(6).fill(1e-9), RELATIVE_TOLERANCE: 1e-12, MAXIMUM_STEPS: 1000000 }),
    FORCES: table('PCFForceModel', { GRAVITY_CHOICE: P.pcfGravitySelection.SPHERICAL_HARMONICS, ENABLE_POINT_MASS: true, GRAVITATIONAL_PARAMETER: GM,
      ENABLE_J2: false, ENABLE_J3: false, ENABLE_J4: false, ENABLE_HIGHER_ZONALS: false, MAXIMUM_DEGREE: degree, HAS_MAXIMUM_DEGREE: true, MAXIMUM_ORDER: degree, HAS_MAXIMUM_ORDER: true,
      ENABLE_THIRD_BODY: false, THIRD_BODY_IDS: [], ENABLE_SRP: false, ENABLE_DRAG: B !== null, INITIAL_MASS_KG: 1, AREA_M2: 1, REFLECTIVITY_COEFFICIENT: 0, DRAG_COEFFICIENT: B ?? 0,
      ATMOSPHERE_MODEL: P.pcfAtmosphereFamily.JB2008, EPHEMERIS_SOURCE: 'JPL_SPK', SOLID_TIDES: P.pcfSolidTideModel.NONE, RELATIVITY: P.pcfRelativityTerms.NONE }),
    INCLUDE_STM: false, STM_TECHNIQUE: P.prwDerivativeTechnique.ANALYTIC, DENSITY_TREATMENT: P.prwDensityTreatment.NEGLECTED, DYNAMIC_PARAMETERS: [],
    SAMPLE_EPOCHS: samples.map(instant),
  });
  const kernel = fs.readFileSync(kernelPath);
  const descriptor = table('NCD', { FORMAT: P.ncdContainerFormat.SPK_DAF, SOURCE_BYTE_LENGTH: BigInt(kernel.length), SOURCE_SHA256: createHash('sha256').update(kernel).digest('hex') });
  const inputs = [
    { portId: 'request', typeRef: TYPE, payload: encode('EXECUTION_REQUEST', request) },
    { portId: 'kernel', typeRef: TYPE, payload: encode('NATIVE_INPUT', table('PRWNativeInput', { DESCRIPTOR: descriptor, CONTENT: Array.from(kernel) })) },
    ...(B === null ? [] : [{ portId: 'jb2008_indices', typeRef: TYPE, payload: encode('JB2008_INDICES', table('PRWJB2008IndicesTable', { ROWS: jbRows.map((x) => table('PRWJB2008Indices', x)) })) }]),
    // Zero Earth orientation: UT1 = UTC and no polar motion, which is what `energy` assumes without dut1, xp and yp.
    { portId: 'earth_orientation', typeRef: TYPE, payload: encode('EARTH_ORIENTATION', table('PRWEarthOrientation', { ROWS: jbRows.map((x) => Object.assign(new EOPT(), {
      MJD: Math.round(Date.parse(`${x.DATE}T00:00:00Z`) / 86400000 + 40587), TAI_MINUS_UTC_SECONDS: 37 })) })) },
  ];
  const h = await harnessOf('propagator/ffm');
  try {
    const r = await h.invoke({ methodId: 'invoke', inputs });
    if (r.statusCode !== 0) throw new Error(`${r.errorCode}: ${r.errorMessage}`);
    const root = P.PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(new Uint8Array(r.outputs.find((o) => o.portId === 'response').payload))).unpack();
    return root.EXECUTION_RESULT.SAMPLES.map((s, i) => {
      const st = s.STATE.STATE, p = st.POSITION, v = st.VELOCITY;
      return { mjd: samples[i], r: [p.X, p.Y, p.Z], v: [v.X, v.Y, v.Z] };
    });
  } finally {
    await h.destroy();
  }
}
// Constant synthetic JB2008 drivers over whole days from fromMjd to toMjd.
function rows(fromMjd, toMjd) {
  const out = [];
  for (let d = Math.floor(fromMjd) - 6; d <= Math.ceil(toMjd) + 1; ++d)
    out.push({ DATE: dayOfMjd(d), F10: 150, F10_CENTRED_81: 145, S10: 140, S10_CENTRED_81: 138, M10: 148, M10_CENTRED_81: 146,
      Y10: 130, Y10_CENTRED_81: 128, DTC_HOURLY_K: Array(24).fill(40) });
  return out;
}
const skip = !fs.existsSync(kernelPath) || !fs.existsSync(ffmWasm) ? 'DE440 fixture or the propagator/ffm artifact is absent' : false;
const MJD0 = 61131.25;  // 2026-04-01 06:00 UTC (inside the DE440 fixture's 2026 span)
const start = keplerState(6378137 + 500e3, 0.001, 97.4, 120, 80, 10);

test('energy is conserved along a gravity-only FFM orbit (EGM2008 36x36) and the Kepler energy is not', { skip }, async (t) => {
  const track = await ffmTrack(MJD0, start, 6 * 3600, 60, { degree: 36, jbRows: rows(MJD0, MJD0 + 1) });
  const states = track.map((s) => ({ mjd: s.mjd, r: s.r, v: s.v }));
  const out = (await call('energy', { states, degree: 36, gm: GM, omega: OMEGA })).STATES;
  assert.equal(out.REFUSED.length, 0);
  const c0 = out.ENERGY_J_KG[0];
  const drift = Math.max(...out.ENERGY_J_KG.map((c) => Math.abs(c - c0)));
  // What is left is not the integrator (relative tolerance 1e-12: ~1e-3 J/kg over 6 h) but the Earth's axis, which is not fixed in
  // GCRF: precession and nutation move the CIP by ~2e-11 rad/s, and dU/dtilt ~ 8e4 J/kg per rad at 500 km, so the Jacobi integral of a
  // field that turns uniformly about a fixed axis changes by ~0.01 J/kg an hour (the series steps by 0.0097 J/kg each hour, the
  // hour for which both chains hold the celestial-to-intermediate matrix). 0.1 J/kg over 6 h is 2e-9 of the energy and is far below
  // what a wrong field leaves (degrees 35 and 37 against FFM's 36: more than 0.5 J/kg below).
  t.diagnostic(`Jacobi energy drift over 6 h: ${drift.toFixed(4)} J/kg`);
  assert.ok(drift < 0.1, `Jacobi energy drifted by ${drift} J/kg over 6 h`);
  for (const degree of [35, 37]) {
    const off = (await call('energy', { states, degree, gm: GM, omega: OMEGA })).STATES.ENERGY_J_KG;
    const offDrift = Math.max(...off.map((c) => Math.abs(c - off[0])));
    t.diagnostic(`module degree ${degree} against FFM's 36: drift ${offDrift.toFixed(3)} J/kg`);
    assert.ok(offDrift > 0.4, `degree ${degree} against FFM's 36 drifts by only ${offDrift} J/kg`);
  }
  const kepler = states.map((s) => 0.5 * (s.v[0] ** 2 + s.v[1] ** 2 + s.v[2] ** 2) - GM / Math.hypot(...s.r));
  const keplerRange = Math.max(...kepler) - Math.min(...kepler);
  assert.ok(keplerRange > 5e3, `the Kepler energy varies by ${keplerRange} J/kg: the test orbit exercises the field`);
  // A wrong field must show: degree 2 against FFM's degree 36.
  const wrong = (await call('energy', { states, degree: 2, gm: GM, omega: OMEGA })).STATES.ENERGY_J_KG;
  const wrongDrift = Math.max(...wrong.map((c) => Math.abs(c - wrong[0])));
  assert.ok(wrongDrift > 0.5, `degree 2 against degree 36 drifts by only ${wrongDrift} J/kg`);
  // Without the rotation term omega . (r x v) the quantity is not conserved either (the orbit's angular momentum is not constant in a non-spherical field).
  const noRotation = out.ENERGY_J_KG.map((c, i) => c + out.ROTATIONAL_J_KG[i]);
  const rotationRange = Math.max(...noRotation) - Math.min(...noRotation);
  assert.ok(rotationRange > 50, `without omega . (r x v) the energy varies by ${rotationRange} J/kg`);
  // The WGS84 geodetic point must reproduce the geocentric radius (rotation preserves it): |r|^2 = ((N + h) cos(lat))^2 + ((N (1 - e^2) + h) sin(lat))^2.
  const a = 6378137, e2 = 0.00669437999014;
  states.forEach((st, i) => {
    const lat = out.LATITUDE_DEG[i] * Math.PI / 180, h = out.ALTITUDE_KM[i] * 1000, N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    const radius = Math.hypot((N + h) * Math.cos(lat), (N * (1 - e2) + h) * Math.sin(lat));
    assert.ok(Math.abs(radius - Math.hypot(...st.r)) < 1e-3, `sample ${i}: geodetic point gives radius ${radius}, state ${Math.hypot(...st.r)}`);
  });
});

test('the energy gradient equals finite differences of energy', async () => {
  const s = { mjd: MJD0 + 0.1, r: start.r, v: start.v };
  const g = (await call('energy', { states: [s], degree: 36, gm: GM, omega: OMEGA, gradient: true })).STATES.ENERGY_GRADIENT.slice(0, 6);
  const energyAt = async (r, v) => (await call('energy', { states: [{ mjd: s.mjd, r, v }], degree: 36, gm: GM, omega: OMEGA })).STATES.ENERGY_J_KG[0];
  for (let k = 0; k < 3; ++k) {
    const h = 2.0;  // m
    const rp = [...s.r], rm = [...s.r];
    rp[k] += h; rm[k] -= h;
    const fd = ((await energyAt(rp, s.v)) - (await energyAt(rm, s.v))) / (2 * h);
    assert.ok(Math.abs(fd - g[k]) < 1e-6 * Math.abs(g[k]) + 1e-7, `dC/dr[${k}]: gradient ${g[k]} vs finite difference ${fd}`);
  }
  for (let k = 0; k < 3; ++k) {
    const h = 0.01;  // m/s
    const vp = [...s.v], vm = [...s.v];
    vp[k] += h; vm[k] -= h;
    const fd = ((await energyAt(s.r, vp)) - (await energyAt(s.r, vm))) / (2 * h);
    assert.ok(Math.abs(fd - g[3 + k]) < 1e-7 * Math.abs(g[3 + k]) + 1e-8, `dC/dv[${k}]: gradient ${g[3 + k]} vs finite difference ${fd}`);
  }
});

test('the fall of the energy under JB2008 drag equals the drag work', { skip }, async (t) => {
  const B = 0.02;  // Cd*A/m, m^2/kg
  const jbRows = rows(MJD0, MJD0 + 1);
  const track = await ffmTrack(MJD0, start, 6 * 3600, 30, { degree: 36, B, jbRows });
  const states = track.map((s) => ({ mjd: s.mjd, r: s.r, v: s.v }));
  const energy = (await call('energy', { states, degree: 36, gm: GM, omega: OMEGA })).STATES.ENERGY_J_KG;
  const answer = await call('drag_work', { states, jb2008: { rows: jbRows }, B });
  const work = answer.STATES;
  assert.equal(work.REFUSED.length, 0);
  assert.equal(answer.BALLISTIC_COEFFICIENT_M2_KG, B);
  assert.equal(work.DRAG_WORK_J_KG.length, states.length - 1);
  const fall = energy.at(-1) - energy[0];
  const integral = work.CUMULATIVE_DRAG_WORK_J_KG.at(-1);
  // Trapezoid rule on 30 s samples of a smooth integrand (the density varies by a factor of ~2 around the orbit) and a
  // drag-only change of C: 0.3 % allows the quadrature and the first-order drag-gravity cross terms.
  t.diagnostic(`energy fell by ${fall.toFixed(3)} J/kg, drag work ${integral.toFixed(3)} J/kg, ratio ${(fall / integral).toFixed(5)}`);
  assert.ok(fall < -20, `the energy fell by ${fall} J/kg`);
  assert.ok(Math.abs(fall / integral - 1) < 0.003, `energy fell by ${fall} J/kg, drag work ${integral} J/kg (ratio ${fall / integral})`);
  // A correction that raises the exospheric temperature raises the work done by the drag.
  const warm = await call('drag_work', { states, jb2008: { rows: jbRows }, B, correction: { nodesMjd: [MJD0 - 1, MJD0 + 2], altitudeKm: [], values: [[60], [60]] } });
  const warmWork = warm.STATES.CUMULATIVE_DRAG_WORK_J_KG.at(-1);
  assert.ok(warmWork < integral * 1.05, 'a +60 K correction changes the work');
  assert.ok(Math.abs(warmWork) > Math.abs(integral), '+60 K raises the density and so the drag work');
});

test('invalid requests are refused', async () => {
  await assert.rejects(call('energy', { states: [] }), /STATES/);
  await assert.rejects(call('energy', { states: [{ mjd: 61000, r: [7e6, 0, 0], v: [0, 7.5e3, 0] }], degree: 1 }), /degree/);
  await assert.rejects(call('drag_work', { states: [{ mjd: 61000, r: [7e6, 0, 0], v: [0, 7.5e3, 0] }] }), /jb2008/);
  const out = await call('energy', { states: [{ mjd: 61000, r: [1e6, 0, 0], v: [0, 7.5e3, 0] }] });
  assert.deepEqual(out.STATES.REFUSED, [0]);
  assert.ok(Number.isNaN(out.STATES.ENERGY_J_KG[0]));
  // Defaults: degree 36, order = degree, GM 3.986004418e14, the Earth's rotation 7.292115e-5 rad/s, field EGM2008.
  assert.deepEqual([out.GRAVITY_FIELD, out.GRAVITY_DEGREE, out.GRAVITY_ORDER, out.GM_M3_S2, out.EARTH_ROTATION_RAD_S], ['EGM2008', 36, 36, 3.986004418e14, 7.292115e-5]);
  // Not a $DCL: refused.
  const h = await harnessOf('.');
  try {
    const r = await h.invoke({ methodId: 'energy', inputs: [{ portId: 'request', payload: Buffer.from('{"states":[]}'), typeRef: { schemaName: 'DCL.fbs', fileIdentifier: '$DCL', rootTypeName: 'DCL', wireFormat: 'flatbuffer' } }] });
    assert.notEqual(r.statusCode, 0);
    assert.match(r.errorMessage, /\$DCL/);
  } finally {
    await h.destroy();
  }
});
