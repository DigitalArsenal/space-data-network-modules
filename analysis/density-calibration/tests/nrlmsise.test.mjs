import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { S as P, call, dayOfMjd } from './dcl.mjs';

const { flatbuffers, EOPT } = P;

// NRLMSISE-00 (atmosphere "NRLMSISE00" of evaluate and drag_work) against propagator/ffm, the module that drives the same model in its force model.
//
// With NRLMSISE-00 drag FFM's Jacobi energy C falls by the integral of -1/2 B rho |v_r|^3 (dC/dt = a . v_r), which `drag_work` evaluates with the module's
// own NRLMSISE-00. The test orbit crosses 00:00 UTC (21:00 to 03:00) over rows whose F10.7, 81-day mean and Ap all differ from day to day, so that the
// day each input is read from matters: F10.7 of the day before the epoch, the 81-day mean and Ap of the epoch's day (FFM's SpaceWeatherTable). Reading
// F10.7 from the epoch's own day instead moves the integral by far more than the tolerance, which the last assertion shows.
const here = (p) => new URL(p, import.meta.url);
const modules = (p) => new URL(`../../../${p}`, import.meta.url);
const kernelPath = modules('files/orbit-products/tests/fixtures/de440/de440-2026.bsp');
const ffmWasm = modules('propagator/ffm/dist/isomorphic/module.wasm');
const GM = 398600.4418e9;
const skip = !fs.existsSync(kernelPath) || !fs.existsSync(ffmWasm) ? 'DE440 fixture or the propagator/ffm artifact is absent' : false;

async function harnessOf(dir) {
  const wasmSource = fs.readFileSync(dir === '.' ? here('../dist/isomorphic/module.wasm') : modules(`${dir}/dist/isomorphic/module.wasm`));
  const manifest = JSON.parse(fs.readFileSync(dir === '.' ? here('../plugin-manifest.json') : modules(`${dir}/plugin-manifest.json`)));
  return createBrowserModuleHarness({ wasmSource, manifest, surface: 'direct' });
}
const isoOfMjd = (mjd) => new Date((mjd - 40587) * 86400000).toISOString().replace('Z', '');

function keplerState(a, e, iDeg, raanDeg, argpDeg, nuDeg) {
  const d = Math.PI / 180, nu = nuDeg * d, p = a * (1 - e * e), r = p / (1 + e * Math.cos(nu)), vq = Math.sqrt(GM / p);
  const pqw = [r * Math.cos(nu), r * Math.sin(nu), 0], vpqw = [-vq * Math.sin(nu), vq * (e + Math.cos(nu)), 0];
  const cO = Math.cos(raanDeg * d), sO = Math.sin(raanDeg * d), ci = Math.cos(iDeg * d), si = Math.sin(iDeg * d), cw = Math.cos(argpDeg * d), sw = Math.sin(argpDeg * d);
  const R = [[cO * cw - sO * sw * ci, -cO * sw - sO * cw * ci, sO * si], [sO * cw + cO * sw * ci, -sO * sw + cO * cw * ci, -cO * si], [sw * si, cw * si, ci]];
  const mul = (v) => R.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  return { r: mul(pqw), v: mul(vpqw) };
}

// The PRW SPW rows of the days [fromDay, toDay] (MJD): F10.7, the 81-day mean and Ap move from day to day.
const spwRows = (fromDay, toDay) => {
  const rows = [];
  for (let d = fromDay; d <= toDay; ++d) {
    const k = d - fromDay;
    rows.push({ DATE: dayOfMjd(d), F107_OBS: 110 + 9 * k, F107_ADJ: 110 + 9 * k, F107_DATA_TYPE: 0, F107_OBS_CENTER81: 125 + 3 * k, AP_AVG: 6 + 11 * k, AP1: 6, AP2: 6, AP3: 6, AP4: 6, AP5: 6, AP6: 6, AP7: 6, AP8: 6,
      KP1: 20, KP2: 20, KP3: 20, KP4: 20, KP5: 20, KP6: 20, KP7: 20, KP8: 20, KP_SUM: 160 });
  }
  return rows;
};
// The module's $SPW rows: the fields it reads, of the same days.
const jsonRows = (rows) => rows.map((r) => ({ DATE: r.DATE, F107_OBS: r.F107_OBS, F107_OBS_CENTER81: r.F107_OBS_CENTER81, AP_AVG: r.AP_AVG }));

// FFM with NRLMSISE-00 drag over [t0, t0 + span], samples every stepSeconds, from a GCRF state (m, m/s), zero Earth orientation (UT1 = UTC, no polar motion).
async function ffmTrack(epochMjd, state, spanSeconds, stepSeconds, { degree = 36, B, rows }) {
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
    INTEGRATOR: table('PRWIntegratorSettings', { ALGORITHM: P.prwSolverAlgorithm.RK78, INITIAL_STEP_SECONDS: 10, MINIMUM_STEP_SECONDS: 0.01, MAXIMUM_STEP_SECONDS: 40,
      ABSOLUTE_TOLERANCES: Array(6).fill(1e-9), RELATIVE_TOLERANCE: 1e-12, MAXIMUM_STEPS: 1000000 }),
    FORCES: table('PRWForceConfiguration', { GRAVITY_CHOICE: P.prwGravitySelection.SPHERICAL_HARMONICS, ENABLE_POINT_MASS: true, GRAVITATIONAL_PARAMETER: GM,
      ENABLE_J2: false, ENABLE_J3: false, ENABLE_J4: false, ENABLE_HIGHER_ZONALS: false, MAXIMUM_DEGREE: degree, HAS_MAXIMUM_DEGREE: true, MAXIMUM_ORDER: degree, HAS_MAXIMUM_ORDER: true,
      ENABLE_THIRD_BODY: false, THIRD_BODY_IDS: [], ENABLE_SRP: false, ENABLE_DRAG: true, INITIAL_MASS_KG: 1, AREA_M2: 1, REFLECTIVITY_COEFFICIENT: 0, DRAG_COEFFICIENT: B,
      ATMOSPHERE_MODEL: P.prwAtmosphereFamily.NRLMSISE00, EPHEMERIS_SOURCE: 'JPL_SPK', SOLID_TIDES: P.prwSolidTideModel.NONE, RELATIVITY: P.prwRelativityTerms.NONE }),
    INCLUDE_STM: false, STM_TECHNIQUE: P.prwDerivativeTechnique.ANALYTIC, DENSITY_TREATMENT: P.prwDensityTreatment.NEGLECTED, DYNAMIC_PARAMETERS: [],
    SAMPLE_EPOCHS: samples.map(instant),
  });
  const kernel = fs.readFileSync(kernelPath);
  const descriptor = table('NCD', { FORMAT: P.ncdContainerFormat.SPK_DAF, SOURCE_BYTE_LENGTH: BigInt(kernel.length), SOURCE_SHA256: createHash('sha256').update(kernel).digest('hex') });
  const inputs = [
    { portId: 'request', typeRef: TYPE, payload: encode('EXECUTION_REQUEST', request) },
    { portId: 'kernel', typeRef: TYPE, payload: encode('NATIVE_INPUT', table('PRWNativeInput', { DESCRIPTOR: descriptor, CONTENT: Array.from(kernel) })) },
    { portId: 'space_weather', typeRef: TYPE, payload: encode('SPACE_WEATHER', table('PRWSpaceWeatherTable', { ROWS: rows.map((x) => table('SPW', x)) })) },
    { portId: 'earth_orientation', typeRef: TYPE, payload: encode('EARTH_ORIENTATION', table('PRWEarthOrientation', { ROWS: rows.map((x) => Object.assign(new EOPT(), {
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

const MJD0 = 61131.875;  // 2026-04-01 21:00 UTC: the 6 h arc crosses 00:00 UTC
const start = keplerState(6378137 + 500e3, 0.001, 97.4, 120, 80, 10);
const rows = spwRows(Math.floor(MJD0) - 3, Math.floor(MJD0) + 3);

test('the fall of the energy under NRLMSISE-00 drag equals the drag work, across a day boundary with day-to-day space weather', { skip }, async (t) => {
  const B = 0.02;
  const track = await ffmTrack(MJD0, start, 6 * 3600, 30, { B, rows });
  const states = track.map((s) => ({ mjd: s.mjd, r: s.r, v: s.v }));
  const energy = (await call('energy', { states, degree: 36, gm: GM, omega: 7.292115e-5 })).STATES.ENERGY_J_KG;
  const work = await call('drag_work', { states, atmosphere: 'NRLMSISE00', nrlmsise00: { rows: jsonRows(rows) }, B });
  assert.equal(work.STATES.REFUSED.length, 0);
  assert.equal(work.ATMOSPHERE.MODEL, P.AtmosphericModelFamily.NRLMSIS00E);
  const fall = energy.at(-1) - energy[0];
  const integral = work.STATES.CUMULATIVE_DRAG_WORK_J_KG.at(-1);
  t.diagnostic(`energy fell by ${fall.toFixed(3)} J/kg, NRLMSISE-00 drag work ${integral.toFixed(3)} J/kg, ratio ${(fall / integral).toFixed(5)}`);
  assert.ok(fall < -20, `the energy fell by ${fall} J/kg`);
  assert.ok(Math.abs(fall / integral - 1) < 0.003, `energy fell by ${fall} J/kg, drag work ${integral} J/kg (ratio ${fall / integral})`);
  // The same arc under JB2008 would not match: the densities of the two models differ, so the test does fail on a wrong model (not only on wrong inputs).
  // The day each input is read from matters: F10.7 of the epoch's own day (instead of the day before) moves the integral by more than the tolerance.
  const sameDay = rows.map((r, i) => ({ ...jsonRows([r])[0], F107_OBS: i + 1 < rows.length ? rows[i + 1].F107_OBS : r.F107_OBS }));
  const wrongDay = await call('drag_work', { states, atmosphere: 'NRLMSISE00', nrlmsise00: { rows: sameDay }, B });
  const wrongRatio = fall / wrongDay.STATES.CUMULATIVE_DRAG_WORK_J_KG.at(-1);
  t.diagnostic(`F10.7 read from the epoch's own day: ratio ${wrongRatio.toFixed(5)}`);
  assert.ok(Math.abs(wrongRatio - 1) > 0.01, `reading F10.7 from the wrong day changes the integral by only ${(100 * (wrongRatio - 1)).toFixed(3)} %`);
});

test('evaluate: NRLMSISE-00 densities at points, with the local solar time of the model and the refusals', async () => {
  const jan1 = 61041;                       // MJD of 2026-01-01
  const rowsEval = spwRows(jan1 + 160, jan1 + 180);
  const mjd = jan1 + 171 + 29000 / 86400;   // day of year 172, 29000 s
  const points = { mjd: [mjd, mjd, mjd, mjd], latDeg: [60, 60, 60, 0], lonDeg: [-70, 110, -70, 30], altKm: [400, 400, 1200, 300] };
  const answer = await call('evaluate', { points, atmosphere: 'NRLMSISE00', nrlmsise00: { rows: jsonRows(rowsEval) } });
  assert.equal(answer.ATMOSPHERE.MODEL, P.AtmosphericModelFamily.NRLMSIS00E);
  const out = { refused: answer.POINTS.REFUSED, lstHours: answer.POINTS.LOCAL_SOLAR_TIME_H, density: answer.POINTS.DENSITY_KG_M3 };
  assert.deepEqual(out.refused, [2], 'a point above 1000 km is refused');
  // UT + longitude/15 (the package's recommended consistency relation): 29000 s = 8.0556 h
  assert.ok(Math.abs(out.lstHours[0] - ((8.0556 - 70 / 15 + 24) % 24)) < 1e-3, `lst ${out.lstHours[0]}`);
  assert.ok(Math.abs(out.lstHours[1] - ((8.0556 + 110 / 15) % 24)) < 1e-3);
  // Densities at 400 km in the thermosphere: 1e-13 to 1e-10 kg/m^3 for F10.7 ~ 140; 300 km is denser than 400 km at the same activity.
  for (const i of [0, 1]) assert.ok(out.density[i] > 1e-13 && out.density[i] < 1e-10, `density ${out.density[i]} kg/m^3 at point ${i}`);
  assert.ok(out.density[3] > out.density[0] / 3 && out.density[3] > 1e-12, 'the density at 300 km');
  assert.notEqual(out.density[0], out.density[1], 'local solar time changes the density');
  // A day without rows is refused, not guessed; the correction and derivative of JB2008 do not apply.
  const far = await call('evaluate', { points: { mjd: [mjd + 40], latDeg: [0], lonDeg: [0], altKm: [400] }, atmosphere: 'NRLMSISE00', nrlmsise00: { rows: jsonRows(rowsEval) } });
  assert.deepEqual(far.POINTS.REFUSED, [0]);
  await assert.rejects(call('evaluate', { points, atmosphere: 'NRLMSISE00', nrlmsise00: { rows: jsonRows(rowsEval) }, derivative: true }), /NRLMSISE00/);
  await assert.rejects(call('evaluate', { points, atmosphere: 'MSIS_86' }), /atmosphere/);
  await assert.rejects(call('drag_work', { states: [{ mjd, r: [7e6, 0, 0], v: [0, 7.5e3, 0] }], atmosphere: 'NRLMSISE00' }), /nrlmsise00/);
  await assert.rejects(call('calibrate', { points: { mjd: [mjd], latDeg: [0], lonDeg: [0], altKm: [400], rho: [1e-12] }, atmosphere: 'NRLMSISE00', nrlmsise00: { rows: jsonRows(rowsEval) } }), /JB2008/);
});
