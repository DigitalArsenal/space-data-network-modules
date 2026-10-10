import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';
import { root, flatbuffers, ACW, RDO, EOO, RFO, wasmPath, manifest, wasm, DEG, ARCSEC, C, AU, add, sub, mul, dot, norm, jdTt, T0, ecef, enu, sample, straight, station, observer, target, model, sensor, access, request, SITE, AXES, OFFSET, FIXED } from './lib.mjs';

// Every expected value is independent of the module: a published textbook
// state (Vallado), closed-form geometry on the WGS-84 ellipsoid, the radar,
// optical and RF formulas evaluated here, or a statistical bound.
// Frames: Earth-fixed input, GCRF measurements. Units as each record states.
async function simulate(t, bytes) {
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  t.after(() => h.destroy());
  const r = await h.invoke({ methodId: 'simulate_observations', inputs: [{ portId: 'request', payload: Buffer.from(bytes), typeRef: { schemaName: 'ACW.fbs', fileIdentifier: '$ACW', rootTypeName: 'ACW', wireFormat: 'flatbuffer' } }] });
  if (r.statusCode !== 0) return { error: r.errorMessage };
  const read = (port, mod, code) => r.outputs.filter((f) => f.portId === port).map((f) => mod[code][`getRootAs${code}`](new flatbuffers.ByteBuffer(new Uint8Array(f.payload))).unpack());
  return { radar: read('radar', RDO, 'RDO'), optical: read('optical', EOO, 'EOO'), rf: read('rf', RFO, 'RFO'), result: read('result', ACW, 'ACW')[0].RESULT, raw: r.outputs };
}


test('the artifact satisfies the SDK contract', async () => {
  const report = await validateArtifactWithStandards({ wasmPath, manifest, standardsRoot: root });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
});

test('GCRF from ITRF matches Vallado Example 3-15 (IAU 2006/2000A, CIO based)', async (t) => {
  // Vallado, Fundamentals of Astrodynamics and Applications, 4th ed., Ex. 3-15:
  // 2004-04-06 07:51:28.386009 UTC, TAI-UTC 32 s, UT1-UTC -0.4399619 s,
  // xp -0.140682", yp 0.333309", dX -0.000205", dY -0.000136".
  // ITRF r = (-1033.4793830, 7901.2952754, 6380.3565958) km,
  //      v = (-3.225636520, -2.872451450, 5.531924446) km/s;
  // GCRF r = (5102.508959, 6123.011403, 6378.136925) km,
  //      v = (-4.743220156, 0.790536497, 5.533755728) km/s.
  const jd = jdTt(Date.UTC(2004, 3, 6, 7, 51, 28, 386), 32) + 0.009e-3 / 86400;
  const r = [-1033.4793830e3, 7901.2952754e3, 6380.3565958e3], v = [-3225.636520, -2872.451450, 5531.924446];
  const eop = Object.assign(new ACW.EOPT(), { MJD: 53101, UT1_MINUS_UTC_SECONDS_HP: -0.4399619,
    X_POLE_WANDER_RADIANS_HP: -0.140682 * ARCSEC, Y_POLE_WANDER_RADIANS_HP: 0.333309 * ARCSEC,
    X_CELESTIAL_POLE_OFFSET_RADIANS_HP: -0.000205 * ARCSEC, Y_CELESTIAL_POLE_OFFSET_RADIANS_HP: -0.000136 * ARCSEC });
  const centre = observer('geocentre', [sample(jd - 1 / 86400, [0, 0, 0]), sample(jd + 1 / 86400, [0, 0, 0])]);
  const sat = target('sat', [sample(jd, r, v), sample(jd + 1 / 86400, add(r, v), v)]);
  const sun = [sample(jd - 1, mul(r, AU / norm(r))), sample(jd + 1, mul(r, AU / norm(r)))];
  const out = await simulate(t, request({
    OBSERVERS: [centre], TARGETS: [sat], SUN_STATES: sun, EARTH_ORIENTATION: [eop],
    SENSORS: [sensor('eo', 'geocentre', 'OPTICAL', [model('RIGHT_ASCENSION_DECLINATION')]),
              sensor('radar', 'geocentre', 'RADAR', [model('RANGE'), model('RANGE_RATE')])],
    ACCESS: [access('eo', 'sat', [[jd, jd]]), access('radar', 'sat', [[jd, jd]])],
  }));
  assert.equal(out.error, undefined, out.error);
  const g = [5102.508959, 6123.011403, 6378.136925], gv = [-4.743220156, 0.790536497, 5.533755728];
  // From the geocentre the right ascension and declination are those of the
  // GCRF position. EOO stores them as 32-bit floats (2e-5 deg at 360 deg).
  const [o] = out.optical;
  assert.ok(Math.abs(o.RA - Math.atan2(g[1], g[0]) / DEG) < 2e-5, `RA ${o.RA}`);
  assert.ok(Math.abs(o.DECLINATION - Math.asin(g[2] / norm(g)) / DEG) < 2e-5, `Dec ${o.DECLINATION}`);
  // Range rate from the geocentre is r_hat . v in GCRF, which needs the
  // Earth-rotation term of the velocity transform. Tolerance 2e-8 km/s: the
  // printed digits (1e-6 km, 1e-9 km/s) and the 20 us resolution of one JD
  // double (0.3 mm/s of apparent Earth rotation).
  const [d] = out.radar;
  assert.ok(Math.abs(d.RANGE_RATE - dot(g, gv) / norm(g)) < 2e-8, `range rate ${d.RANGE_RATE} vs ${dot(g, gv) / norm(g)}`);
  assert.ok(Math.abs(d.RANGE - norm(g)) < 1e-5);
});

test('topocentric azimuth, elevation and range match the closed form', async (t) => {
  const out = await simulate(t, request({
    GROUND_STATIONS: [station('site', 30, 0, 100)],
    TARGETS: [target('fixed', straight(T0, FIXED, [0, 0, 0], 600))],
    SENSORS: [sensor('radar', 'site', 'RADAR', [model('AZIMUTH_ELEVATION'), model('RANGE'), model('RANGE_RATE')])],
    ACCESS: [access('radar', 'fixed', [[T0, T0 + 60 / 86400]])],
  }));
  assert.equal(out.error, undefined, out.error);
  assert.equal(out.radar.length, 7, 'one observation every 10 s over 60 s, both ends included');
  for (const d of out.radar) {
    assert.ok(Math.abs(d.AZIMUTH - Math.atan2(3, 4) / DEG) < 1e-9, `azimuth ${d.AZIMUTH}`);
    assert.ok(Math.abs(d.ELEVATION - 45) < 1e-9, `elevation ${d.ELEVATION}`);
    assert.ok(Math.abs(d.RANGE - Math.sqrt(50) * 100) < 1e-9, `range ${d.RANGE}`);
    // A target fixed on the rotating Earth keeps its range: rate 0.
    assert.ok(Math.abs(d.RANGE_RATE) < 1e-12, `range rate ${d.RANGE_RATE}`);
    assert.deepEqual([d.SENX, d.SENY, d.SENZ].map((x) => Math.round(x * 1e6)), SITE.map((x) => Math.round(x / 1e3 * 1e6)));
    assert.equal(d.DESCRIPTOR, 'SIMULATED');
    assert.equal(d.UCT, false);
    assert.equal(d.SAT_NO, 90005);
  }
    // One JD double resolves about 20 us, so the first time tag is 03:00:00 to that.
  assert.ok(Math.abs(Date.parse(out.radar[0].OB_TIME.slice(0, 23) + 'Z') + Number(out.radar[0].OB_TIME.slice(23, 26)) / 1000 - Date.UTC(2026, 8, 1, 3)) < 0.05, out.radar[0].OB_TIME);
  assert.equal(out.result.TRACKS.length, 1);
  assert.equal(out.result.OBSERVATION_COUNT, 7);
});

test('radar SNR follows R^-4 and RCS; below the threshold nothing is detected', async (t) => {
  // SNR = 20 + 10 log10(4 / 1) - 40 log10(707.1068 / 1000) = 20 + 6.0206 + 6.0206 = 32.0412 dB.
  const expected = 20 + 10 * Math.log10(4) - 40 * Math.log10(Math.sqrt(50) * 100e3 / 1e6);
  const run = (threshold) => simulate(t, request({
    GROUND_STATIONS: [station('site', 30, 0, 100)],
    TARGETS: [target('fixed', straight(T0, FIXED, [0, 0, 0], 600), { RCS_M2: 4 })],
    SENSORS: [sensor('radar', 'site', 'RADAR', [model('RANGE')], { REFERENCE_SNR_DB: 20, REFERENCE_RANGE_M: 1e6, DETECTION_THRESHOLD_DB: threshold })],
    ACCESS: [access('radar', 'fixed', [[T0, T0 + 60 / 86400]])],
  }));
  const seen = await run(32);
  assert.ok(Math.abs(seen.radar[0].SNR - expected) < 1e-9, `SNR ${seen.radar[0].SNR} vs ${expected}`);
  assert.equal(seen.result.TRACKS[0].DETECTED_COUNT, 7);
  const lost = await run(33);
  assert.equal(lost.radar.length, 0);
  assert.equal(lost.result.TRACKS[0].SCHEDULED_COUNT, 7);
  assert.equal(lost.result.TRACKS[0].LOSS_REASON, 'SNR:7');
});

test('optical magnitude of a diffuse sphere at 90 deg phase; umbra and daylight are lost', async (t) => {
  // Target at (7000, 0, 0) km, Sun toward +y at 1 au, observer 1000 km above
  // the target on +z: the phase angle is exactly 90 deg, where
  // (pi - phi) cos(phi) + sin(phi) = 1, so
  // m = -26.90 - 2.5 log10[(2/3) p a^2 / (pi R^2) (1 au / d_sun)^2].
  const p = 0.175, a = 1.0, R = 1000e3, tgt = [7000e3, 0, 0], sunAt = [0, AU, 0];
  const dSun = norm(sub(sunAt, tgt));
  const expected = -26.90 - 2.5 * Math.log10((2 / 3) * p * a * a / (Math.PI * R * R) * (AU / dSun) ** 2);
  const lit = await simulate(t, request({
    OBSERVERS: [observer('space', straight(T0, [7000e3, 0, 1000e3], [0, 0, 0], 600))],
    TARGETS: [target('ball', straight(T0, tgt, [0, 0, 0], 600), { DIAMETER_M: 2 * a, GEOMETRIC_ALBEDO: p })],
    SUN_STATES: [sample(T0 - 1, sunAt), sample(T0 + 1, sunAt)],
    SENSORS: [sensor('eo', 'space', 'OPTICAL', [model('RIGHT_ASCENSION_DECLINATION')], { LIMITING_MAGNITUDE: 18 })],
    ACCESS: [access('eo', 'ball', [[T0, T0 + 20 / 86400]])],
  }));
  assert.equal(lit.error, undefined, lit.error);
  assert.equal(lit.optical.length, 3);
  assert.ok(Math.abs(lit.optical[0].MAG - expected) < 1e-5, `MAG ${lit.optical[0].MAG} vs ${expected} (float32)`);
  assert.ok(Math.abs(lit.optical[0].SOLAR_PHASE_ANGLE - 90) < 1e-4);
  assert.equal(lit.optical[0].DATA_MODE, EOO.DataMode.SIMULATED);
  assert.equal(lit.optical[0].UMBRA, false);

  // Behind the Earth from the Sun: (-7000, 0, 0) km with the Sun on +x is in umbra.
  const dark = await simulate(t, request({
    OBSERVERS: [observer('space', straight(T0, [-7000e3, 0, 1000e3], [0, 0, 0], 600))],
    TARGETS: [target('ball', straight(T0, [-7000e3, 0, 0], [0, 0, 0], 600), { DIAMETER_M: 2, GEOMETRIC_ALBEDO: p })],
    SUN_STATES: [sample(T0 - 1, [AU, 0, 0]), sample(T0 + 1, [AU, 0, 0])],
    SENSORS: [sensor('eo', 'space', 'OPTICAL', [model('RIGHT_ASCENSION_DECLINATION')])],
    ACCESS: [access('eo', 'ball', [[T0, T0 + 20 / 86400]])],
  }));
  assert.equal(dark.optical.length, 0);
  assert.equal(dark.result.TRACKS[0].LOSS_REASON, 'ECLIPSED:3');

  // A ground telescope with the Sun at its zenith: every observation is lost to daylight.
  const day = await simulate(t, request({
    GROUND_STATIONS: [station('site', 30, 0, 100)],
    TARGETS: [target('fixed', straight(T0, FIXED, [0, 0, 0], 600), { DIAMETER_M: 2, GEOMETRIC_ALBEDO: p })],
    SUN_STATES: [sample(T0 - 1, mul(AXES.U, AU)), sample(T0 + 1, mul(AXES.U, AU))],
    SENSORS: [sensor('eo', 'site', 'OPTICAL', [model('RIGHT_ASCENSION_DECLINATION')], { MAX_HOST_SUN_ELEVATION_RAD: -12 * DEG })],
    ACCESS: [access('eo', 'fixed', [[T0, T0 + 20 / 86400]])],
  }));
  assert.equal(day.result.TRACKS[0].LOSS_REASON, 'DAYLIGHT:3');
});

test('passive RF: link-budget SNR and the Doppler-shifted frequency', async (t) => {
  // Target receding from the site along the line of sight at 1 km/s.
  // SNR = EIRP - 20 log10(4 pi R f / c) + G/T + 228.599 - 10 log10(B);
  // received f = f0 (1 - rdot / c).
  const f0 = 2.2e9, eirp = 30, gt = 20, bw = 1e6;
  const los = mul(OFFSET, 1 / norm(OFFSET)), v = mul(los, 1000);
  const out = await simulate(t, request({
    GROUND_STATIONS: [station('site', 30, 0, 100)],
    TARGETS: [target('emitter', straight(T0, FIXED, v, 600), { EMITTER_FREQUENCY_HZ: f0, EMITTER_EIRP_DBW: eirp })],
    SENSORS: [sensor('rf', 'site', 'PASSIVE_RF', [model('AZIMUTH_ELEVATION')], { RECEIVER_G_OVER_T_DB_PER_K: gt, RECEIVER_BANDWIDTH_HZ: bw, DETECTION_THRESHOLD_DB: 10 })],
    ACCESS: [access('rf', 'emitter', [[T0, T0]])],
  }));
  assert.equal(out.error, undefined, out.error);
  const [o] = out.rf;
  const R = norm(OFFSET);
  const snr = eirp - 20 * Math.log10(4 * Math.PI * R * f0 / C) + gt - 10 * Math.log10(1.380649e-23) - 10 * Math.log10(bw);
  assert.ok(Math.abs(o.SNR - snr) < 1e-9, `SNR ${o.SNR} vs ${snr}`);
  // Range rate of an Earth-fixed velocity along the line of sight is that
  // speed in any frame (the rotation term w x d is perpendicular to d).
  assert.ok(Math.abs(o.FREQUENCY - f0 * (1 - 1000 / C) / 1e6) < 1e-9, `frequency ${o.FREQUENCY}`);
  assert.equal(o.NOMINAL_FREQUENCY, f0 / 1e6);
  assert.equal(o.DETECTION_STATUS, RFO.rfDetectionStatus.DETECTED);
});

test('radar DOPPLER is two-way: -c DOPPLER / (2 DOPPLER_FREQUENCY) recovers the true range rate', async (t) => {
  // A target receding from the site along the line of sight at 1 km/s (true
  // range rate +1000 m/s in any frame), observed 2000 times by a 10 GHz
  // radar with a DOPPLER model of 20 Hz white noise. The echo's two-way shift
  // is -2 f rdot / c, so association's conversion rdot = -c DOPPLER /
  // (2 DOPPLER_FREQUENCY) gives 1000 m/s with noise c 20 / (2 f) = 0.30 m/s:
  // the mean within 4 standard errors (0.30 / sqrt(2000) = 0.0067 m/s) and
  // the spread within 4 standard errors (0.30 / sqrt(2 (N - 1)) = 0.0047
  // m/s). A one-way shift would read 500 m/s.
  const f = 10e9, sigma = 20;
  const los = mul(OFFSET, 1 / norm(OFFSET)), v = mul(los, 1000);
  const out = await simulate(t, request({
    GROUND_STATIONS: [station('site', 30, 0, 100)],
    TARGETS: [target('receding', straight(T0, FIXED, v, 21000, 600))],
    SENSORS: [sensor('radar', 'site', 'RADAR', [model('DOPPLER', sigma)], { TRANSMIT_FREQUENCY_HZ: f })],
    ACCESS: [access('radar', 'receding', [[T0, T0 + 19990 / 86400]])],
  }));
  assert.equal(out.error, undefined, out.error);
  assert.equal(out.radar.length, 2000);
  assert.ok(out.radar.every((d) => d.DOPPLER_FREQUENCY === f && d.DOPPLER_UNC === sigma), 'every record carries its carrier and sigma');
  const rate = out.radar.map((d) => -C * d.DOPPLER / (2 * d.DOPPLER_FREQUENCY));
  const mean = rate.reduce((s, x) => s + x, 0) / rate.length;
  const spread = Math.sqrt(rate.reduce((s, x) => s + (x - mean) ** 2, 0) / (rate.length - 1));
  const noise = C * sigma / (2 * f);
  assert.ok(Math.abs(mean - 1000) < 4 * noise / Math.sqrt(rate.length), `mean ${mean} m/s`);
  assert.ok(Math.abs(spread - noise) < 4 * noise / Math.sqrt(2 * (rate.length - 1)), `spread ${spread} m/s vs ${noise}`);
});

test('passive RF: a DOPPLER error model puts its bias and noise in FREQUENCY and its sigma in FREQUENCY_UNC', async (t) => {
  // The same receding emitter (true received f0 (1 - 1000 / c)) observed
  // 2000 times with a DOPPLER model of 20 Hz bias and 50 Hz white noise:
  // the mean error is the bias within 4 standard errors (50 / sqrt(2000) =
  // 1.1 Hz) and the spread is 50 Hz within 4 standard errors (sigma /
  // sqrt(2 (N - 1)) = 0.79 Hz).
  const f0 = 2.2e9;
  const los = mul(OFFSET, 1 / norm(OFFSET)), v = mul(los, 1000);
  const out = await simulate(t, request({
    GROUND_STATIONS: [station('site', 30, 0, 100)],
    TARGETS: [target('emitter', straight(T0, FIXED, v, 21000, 600), { EMITTER_FREQUENCY_HZ: f0, EMITTER_EIRP_DBW: 30 })],
    SENSORS: [sensor('rf', 'site', 'PASSIVE_RF', [model('DOPPLER', 50, { BIAS: 20 })], { RECEIVER_G_OVER_T_DB_PER_K: 20, RECEIVER_BANDWIDTH_HZ: 1e6, DETECTION_THRESHOLD_DB: -100 })],
    ACCESS: [access('rf', 'emitter', [[T0, T0 + 19990 / 86400]])],
  }));
  assert.equal(out.error, undefined, out.error);
  const e = out.rf.map((o) => o.FREQUENCY * 1e6 - f0 * (1 - 1000 / C));
  assert.equal(e.length, 2000);
  const mean = e.reduce((s, x) => s + x, 0) / e.length;
  const sigma = Math.sqrt(e.reduce((s, x) => s + (x - mean) ** 2, 0) / (e.length - 1));
  assert.ok(Math.abs(mean - 20) < 4 * 50 / Math.sqrt(e.length), `mean ${mean} Hz`);
  assert.ok(Math.abs(sigma - 50) < 4 * 50 / Math.sqrt(2 * (e.length - 1)), `sigma ${sigma} Hz`);
  assert.equal(out.rf[0].NOMINAL_FREQUENCY, f0 / 1e6);
  // Every record reports the model's 50 Hz sigma as FREQUENCY_UNC, in MHz as FREQUENCY.
  assert.ok(out.rf.every((o) => o.FREQUENCY_UNC === 50 / 1e6), `FREQUENCY_UNC ${out.rf[0].FREQUENCY_UNC} MHz`);
});

test('noise: bias plus Gauss-Markov noise with the stated sigma and correlation time', async (t) => {
  // A target fixed on the Earth has a constant true range, 707106.781 m. Over
  // 2000 observations 10 s apart: the mean error is the 5 m bias within
  // 4 standard errors, the spread is 10 m within 4 standard errors (1.6 m;
  // for an AR(1) sequence se(sigma^2) = sigma^2 sqrt(2 (1 + rho^2) /
  // (N (1 - rho^2))) = 7.8 m^2, 0.39 m in sigma), and the lag-1
  // autocorrelation is exp(-10 / 60) = 0.8465 within 0.05 (4 x sqrt((1 -
  // rho^2) / N) = 0.048).
  const out = await simulate(t, request({
    GROUND_STATIONS: [station('site', 30, 0, 100)],
    TARGETS: [target('fixed', straight(T0, FIXED, [0, 0, 0], 21000, 600))],
    SENSORS: [sensor('radar', 'site', 'RADAR', [model('RANGE', 10, { BIAS: 5, CORRELATION_TIME_SECONDS: 60 })])],
    ACCESS: [access('radar', 'fixed', [[T0, T0 + 19990 / 86400]])],
  }));
  const e = out.radar.map((d) => d.RANGE * 1000 - Math.sqrt(50) * 100e3);
  assert.equal(e.length, 2000);
  const mean = e.reduce((s, x) => s + x, 0) / e.length;
  const x = e.map((v) => v - mean);
  const variance = x.reduce((s, v) => s + v * v, 0) / (x.length - 1);
  const lag1 = x.slice(1).reduce((s, v, i) => s + v * x[i], 0) / x.reduce((s, v) => s + v * v, 0);
  // Correlated samples: the mean's standard error is sigma sqrt((1 + rho) / (1 - rho) / N).
  const rho = Math.exp(-10 / 60), se = 10 * Math.sqrt((1 + rho) / (1 - rho) / e.length);
  assert.ok(Math.abs(mean - 5) < 4 * se, `mean ${mean}, 4 se = ${4 * se}`);
  assert.ok(Math.abs(Math.sqrt(variance) - 10) < 1.6, `sigma ${Math.sqrt(variance)}`);
  assert.ok(Math.abs(lag1 - rho) < 0.05, `lag-1 ${lag1} vs ${rho}`);
  assert.equal(out.radar[0].RANGE_UNC, 0.01);
});

test('earliest-deadline-first scheduling with a revisit gap and one slot', async (t) => {
  // Windows A [0, 600] s and B [100, 300] s, 120 s tracks, 60 s revisit:
  // A [0, 120]; at 120 only B is ready: B [120, 240]; at 240 only A: A
  // [240, 360]; B's window closes; A is ready again at 420: A [420, 540];
  // at 600 A's window closes, and no track starts at a window's last instant.
  const s = (sec) => T0 + sec / 86400;
  const out = await simulate(t, request({
    GROUND_STATIONS: [station('site', 30, 0, 100)],
    TARGETS: [target('A', straight(T0, FIXED, [0, 0, 0], 900)), target('BB', straight(T0, FIXED, [0, 0, 0], 900))],
    SENSORS: [sensor('radar', 'site', 'RADAR', [model('RANGE')], { TRACK_DURATION_S: 120, REVISIT_INTERVAL_S: 60, MAX_SIMULTANEOUS_TRACKS: 1 })],
    ACCESS: [access('radar', 'A', [[s(0), s(600)]]), access('radar', 'BB', [[s(100), s(300)]])],
  }));
  const tracks = out.result.TRACKS.map((k) => [k.TARGET_ID, Math.round((k.START_JULIAN_DATE_TT - T0) * 86400), Math.round((k.END_JULIAN_DATE_TT - T0) * 86400), k.SCHEDULED_COUNT]);
  assert.deepEqual(tracks, [['A', 0, 120, 13], ['BB', 120, 240, 13], ['A', 240, 360, 13], ['A', 420, 540, 13]]);
});

test('one seed reproduces the observations; another does not', async (t) => {
  const run = (seed) => simulate(t, request({
    RANDOM_SEED: seed,
    GROUND_STATIONS: [station('site', 30, 0, 100)],
    TARGETS: [target('fixed', straight(T0, FIXED, [0, 0, 0], 600))],
    SENSORS: [sensor('radar', 'site', 'RADAR', [model('RANGE', 10, { BIAS_SIGMA: 3 })])],
    ACCESS: [access('radar', 'fixed', [[T0, T0 + 60 / 86400]])],
  }));
  const [a, b, c] = await Promise.all([run(11n), run(11n), run(12n)]);
  assert.deepEqual(a.radar.map((d) => d.RANGE), b.radar.map((d) => d.RANGE));
  assert.notDeepEqual(a.radar.map((d) => d.RANGE), c.radar.map((d) => d.RANGE));
});

test('false alarms: a Poisson count at the stated rate, flagged UCT without identity', async (t) => {
  // 12 per hour over a 10 h track: 120 expected; 4 sigma = 44.
  const out = await simulate(t, request({
    GROUND_STATIONS: [station('site', 30, 0, 100)],
    TARGETS: [target('fixed', straight(T0, FIXED, [0, 0, 0], 36600, 600))],
    SENSORS: [sensor('radar', 'site', 'RADAR', [model('RANGE')], { OBSERVATION_INTERVAL_S: 600, FALSE_ALARM_RATE_PER_HOUR: 12 })],
    ACCESS: [access('radar', 'fixed', [[T0, T0 + 36000 / 86400]])],
  }));
  const ghosts = out.radar.filter((d) => d.UCT);
  assert.ok(Math.abs(ghosts.length - 120) < 44, `false alarms ${ghosts.length}`);
  assert.ok(ghosts.every((d) => !d.SAT_NO && !d.ORIG_OBJECT_ID));
  assert.equal(out.radar.length - ghosts.length, 61);
});

test('a sensor on an unknown host, or a radar DOPPLER without its carrier, is refused', async (t) => {
  const none = await simulate(t, request({
    GROUND_STATIONS: [station('site', 30, 0, 100)],
    TARGETS: [target('fixed', straight(T0, FIXED, [0, 0, 0], 600))],
    SENSORS: [sensor('radar', 'nowhere', 'RADAR', [model('RANGE')])],
  }));
  assert.match(none.error, /HOST_ID/);
  const noCarrier = await simulate(t, request({
    GROUND_STATIONS: [station('site', 30, 0, 100)],
    TARGETS: [target('fixed', straight(T0, FIXED, [0, 0, 0], 600))],
    SENSORS: [sensor('radar', 'site', 'RADAR', [model('DOPPLER', 1)])],
    ACCESS: [access('radar', 'fixed', [[T0, T0]])],
  }));
  assert.match(noCarrier.error, /TRANSMIT_FREQUENCY_HZ/);
});
