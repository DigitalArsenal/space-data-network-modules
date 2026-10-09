import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';

// Independent references:
// - Space Environment Technologies' JB2008 validation package
//   (https://sol.spacenvironment.net/JB2008/ -> jb2008validate.zip): the
//   output of SET's own Fortran (JB2008.f with JB08DRVAUTO.f) on a grid of
//   altitude, right ascension and latitude for 2023 day 91 at 00-21 UT, with
//   the Sun's right ascension and declination and every driver printed.
//   The package carries no redistribution licence, so the test reads it from
//   the local archive (SET_JB2008_VALIDATE, default below) and is skipped,
//   visibly, when it is absent.
// - JPL Horizons (DE441), observer at the Sun's centre, target the Earth:
//   the sub-observer (sub-solar) longitude and latitude and the one-way light
//   time, retrieved 2026-10-09 (API, QUANTITIES 14 and 21). Horizons reports
//   the Earth as seen one light-time earlier; the geometric sub-solar
//   longitude at the instant is its longitude less the Earth's rotation in
//   that light time (360.9856 deg/day). Its latitude is planetodetic (the
//   surface point under the Sun on the WGS84 ellipsoid); the Sun's own
//   latitude, as hpop and Orekit give JB2008, is geocentric:
//   tan(geocentric) = (1 - f)^2 tan(geodetic).
const wasm = fs.readFileSync(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
const validateZip = process.env.SET_JB2008_VALIDATE ?? '/opt/data/sdn-archive/hac/set-jb2008/20261009/jb2008validate.zip';
const haveSet = fs.existsSync(validateZip);

async function call(method, request) {
  const harness = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  try {
    const response = await harness.invoke({ methodId: method, inputs: [{ portId: 'request', payload: Buffer.from(JSON.stringify(request)), typeRef: { schemaName: 'application/json' } }] });
    if (response.statusCode !== 0) throw new Error(`${response.errorCode}: ${response.errorMessage}`);
    return JSON.parse(Buffer.from(response.outputs[0].payload).toString('utf8'));
  } finally {
    await harness.destroy();
  }
}

// One SET expected-output file: its instant, Sun, drivers and grid rows.
function setFile(hour) {
  const text = execFileSync('unzip', ['-p', validateZip, `Validation/expected output/JB2008_AUTO_OUT_2023_091_${hour}.DAT`], { encoding: 'latin1', maxBuffer: 1 << 26 });
  const lines = text.split('\n');
  const [, , , , , sunRa, sunDec] = lines[5].trim().split(/\s+/).map(Number);
  const d = lines[7].trim().split(/\s+/).map((x) => Number(x.replace(/\.$/, '')));
  const rows = [];
  for (const line of lines.slice(9)) {
    const t = line.trim().split(/\s+/);
    if (t.length !== 6) continue;
    rows.push({ z: Number(t[0]), lon: Number(t[1]), lat: Number(t[2]), tinf: Number(t[3]), rho: Number(t[5].replace('D', 'E')) });
  }
  // D1950 counts days from 1950 January 0.0 (MJD 33281).
  return { mjd: d[0] + 33281, d1950: d[0], sunRa, sunDec, inputs: d.slice(1, 10), rows };
}
// SET's driver passes JB2008 the point's right ascension, THETA(D1950) + LON,
// with THETA its Greenwich right-ascension function (JB08DRVAUTO.f, the 1970
// branch), modulo 2 pi; the test forms the same argument so the comparison is
// of JB2008.
function setTheta(t1950) {
  const ts70 = t1950 - 7305, ids70 = Math.trunc(ts70), tfrac = ts70 - ids70, twoPi = 6.28318530717958648;
  const v = (1.73213438565 + 1.720279169407e-2 * ids70 + (1.720279169407e-2 + twoPi) * tfrac + 5.0755141943e-15 * ts70 ** 2) % twoPi;
  return v < 0 ? v + twoPi : v;
}
const raw = (f, rows, inputs = f.inputs) => rows.map((r) => ({ mjd: f.mjd, sunRaRad: f.sunRa, sunDecRad: f.sunDec, lonRad: (setTheta(f.d1950) + r.lon * Math.PI / 180 + 2 * Math.PI) % (2 * Math.PI),
  latRad: r.lat * Math.PI / 180, altKm: r.z, inputs, rho: r.rho }));

test('artifact passes the SDK compliance check', async () => {
  const report = await validateArtifactWithStandards({ manifest, wasmBytes: wasm });
  assert.equal(report.ok, true, JSON.stringify(report.issues ?? report, null, 1).slice(0, 2000));
});

test('JB2008 reproduces SET\'s Fortran validation output (eight hours, 150-600 km)', { skip: !haveSet && `SET jb2008validate.zip not found at ${validateZip}` }, async () => {
  let worst = 0, n = 0;
  for (const hour of ['00', '03', '06', '09', '12', '15', '18', '21']) {
    const f = setFile(hour);
    // Every 7th grid row keeps the call small and still spans all altitudes, longitudes and latitudes.
    const rows = f.rows.filter((r, i) => i % 7 === 0 && r.z >= 150);
    const out = await call('evaluate', { raw: raw(f, rows) });
    rows.forEach((r, i) => { worst = Math.max(worst, Math.abs(out.density[i] / r.rho - 1)); ++n; });
  }
  // SET prints the densities to five significant digits but the drivers
  // only to the unit (F10 129., ...) and the Sun to 1e-4 rad; half a unit of
  // F10B moves the exospheric temperature by about 1.6 K, 0.5 % of the
  // density at 600 km. Measured: within 0.6 % everywhere.
  assert.ok(n > 60000, `${n} points`);
  assert.ok(worst < 0.01, `largest relative difference ${worst}`);
});

test('calibrate recovers a known temperature offset from SET\'s densities', { skip: !haveSet && 'SET validation package absent' }, async () => {
  // Observations: SET's Fortran densities at 03 UT (DSTDTC 85 K), 250-600 km.
  // Fitted once with the printed drivers (the control: what remains is the
  // drivers' print rounding, bounded by about 1.6 K) and once with DSTDTC
  // lowered by 37 K: the global term must rise by 37 K and the others stay.
  const f = setFile('03');
  const rows = f.rows.filter((r, i) => i % 5 === 0 && r.z >= 250);
  const fit = async (lower) => (await call('calibrate', { raw: raw(f, rows, [...f.inputs.slice(0, 8), f.inputs[8] - lower]), degree: 2, binHours: 3,
    fromMjd: f.mjd - 0.01, toMjd: f.mjd + 0.1, logSigma: 0.01, priorSigmaK: [500, 500, 500], minPoints: 10, iterations: 20, editSigma: 0 })).bins[0];
  const control = await fit(0), shifted = await fit(37);
  assert.equal(control.converged && shifted.converged, true);
  control.coefficients.forEach((c, k) => assert.ok(Math.abs(c) < 1.6, `control coefficient ${k}: ${c} K`));
  assert.ok(Math.abs(shifted.coefficients[0] - control.coefficients[0] - 37) < 0.1, `a00 ${shifted.coefficients[0]} vs control ${control.coefficients[0]}`);
  shifted.coefficients.slice(1).forEach((c, k) => assert.ok(Math.abs(c - control.coefficients[k + 1]) < 0.1, `coefficient ${k + 1}: ${c} vs ${control.coefficients[k + 1]}`));
  assert.ok(shifted.postfitRms < 3e-3, `post-fit rms ${shifted.postfitRms}`);
});

test('the Sun\'s Earth-fixed direction matches JPL Horizons\' sub-solar point', async () => {
  const horizons = [  // UT, ObsSub-LON (E), ObsSub-LAT, one-way light time (min)
    ['2023-04-01T00:00:00Z', 183.102949, 4.384412, 8.30826360],
    ['2025-01-25T06:00:00Z', 95.124623, -19.010238, 8.18809048],
    ['2026-01-19T15:00:00Z', 319.736895, -20.370751, 8.18368264],
    ['2026-06-08T21:36:00Z', 217.900318, 23.043766, 8.44163196],
  ];
  const mjd = horizons.map(([t]) => Date.parse(t) / 86400000 + 40587);
  const rows = [];
  for (let day = Math.floor(Math.min(...mjd)) - 6; day <= Math.ceil(Math.max(...mjd)) + 2; ++day) {
    rows.push({ DATE: new Date((day - 40587) * 86400000).toISOString().slice(0, 10), F10: 150, F10_CENTRED_81: 150, S10: 150, S10_CENTRED_81: 150,
      M10: 150, M10_CENTRED_81: 150, Y10: 150, Y10_CENTRED_81: 150, DTC_HOURLY_K: Array(24).fill(30) });
  }
  const out = await call('evaluate', { points: { mjd, latDeg: mjd.map(() => 0), lonDeg: mjd.map(() => 0), altKm: mjd.map(() => 400) },
    jb2008: { rows }, diagnostics: true });
  horizons.forEach(([, lon, lat, lt], i) => {
    const geometric = lon - 360.9856 * lt / 1440;
    const dLon = ((out.sunLonDeg[i] - geometric) % 360 + 540) % 360 - 180;
    assert.ok(Math.abs(dLon) < 0.02, `${horizons[i][0]} longitude off by ${dLon} deg`);
    const geocentric = Math.atan((1 - 1 / 298.257223563) ** 2 * Math.tan(lat * Math.PI / 180)) * 180 / Math.PI;
    assert.ok(Math.abs(out.sunLatDeg[i] - geocentric) < 0.003, `${horizons[i][0]} latitude off by ${out.sunLatDeg[i] - geocentric} deg`);
    // Local solar time at longitude 0 is 12 h less the Sun's longitude.
    assert.ok(Math.abs(((out.lstHours[i] - (12 - out.sunLonDeg[i] / 15)) % 24 + 36) % 24 - 12) < 1e-9);
  });
});

test('a global correction equals raising every DTC value by the same amount (hpop\'s DSTDTC input)', async () => {
  const days = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];
  const rows = (add) => days.map((DATE, k) => ({ DATE, F10: 140 + k, F10_CENTRED_81: 150, S10: 130, S10_CENTRED_81: 135, M10: 145, M10_CENTRED_81: 148,
    Y10: 120, Y10_CENTRED_81: 125, DTC_HOURLY_K: Array.from({ length: 24 }, (_, h) => 20 + 3 * h + add) }));
  const n = 50;
  const points = { mjd: Array.from({ length: n }, (_, i) => 61047 + i * 0.013), latDeg: Array.from({ length: n }, (_, i) => -80 + 3.2 * i),
    lonDeg: Array.from({ length: n }, (_, i) => -170 + 7 * i), altKm: Array.from({ length: n }, (_, i) => 300 + 8 * i) };
  const shifted = await call('evaluate', { points, jb2008: { rows: rows(40) } });
  const corrected = await call('evaluate', { points, jb2008: { rows: rows(0) }, correction: { degree: 1, segments: [{ fromMjd: 61040, toMjd: 61050, coefficients: [40, 0, 0, 0] }] } });
  corrected.density.forEach((rho, i) => assert.ok(Math.abs(rho / shifted.density[i] - 1) < 1e-12));
  assert.deepEqual(corrected.deltaT, Array(n).fill(40));
  // Outside the drivers' span (Y10 needs five days of lag) a point is refused, not guessed.
  const early = await call('evaluate', { points: { mjd: [61041.5], latDeg: [0], lonDeg: [0], altKm: [400] }, jb2008: { rows: rows(0) } });
  assert.deepEqual(early.refused, [0]);
});
