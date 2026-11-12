#!/usr/bin/env node
// Radiation pressure in the long-period regime above e 0.3 through the output map (SPEC 16.22), on model truth, seeded (no
// fit). AP sets with J2 alone (no tesseral term), seeded at a mean anomaly of 10 degrees on test/lib/heo-model-truth.mjs's
// epoch, flown hourly over 7 days with a Cr A/m of 0.02 m^2/kg and without; AP's arms read the module's own Sun and Moon.
// Each arm's truth is FFM (named below by its SHA-256) started from that arm's own state at the epoch, with J2 alone, DE440's
// Sun and Moon, and a cannonball of Cr 1 and A/m 0.02 m^2/kg, or none. Radiation's own error is what remains of AP's
// radiation displacement (with minus without) against FFM's, so the two arms' gravity and third-body errors cancel:
// - an eclipsing set, 30 h, e 0.31 (the integrator's step crosses the shadow's edge every revolution: the force is the
//   step window's share of light, 16.22). The test holds that its flight enters and leaves AP's cylinder (the module's Sun,
//   sdnap_bodies_probe), and flies it at 1 s from an hour before an entry to an hour after the exit, at least 3 h and so
//   across a step boundary: no position lies off its neighbors' curve (the fourth difference) by more than 1 mm (measured on
//   0.6.NN: 1.2 um over 14,401 states);
// - a TESS-like set, 13.7 days, e 0.55 (five days are under half a revolution: SPEC 4's averaged rates and first-order
//   periodic output terms missed most of it; what remains is AP's pressure constant, 4.5e-6 N/m^2 against FFM's 4.540e-6).
// The record (16.22): a set of the regime with an area-to-mass above 0 states PERTURBATIONS.SOLAR_RAD_PRESSURE's text and
// flies, and without it is refused (radiation-model-superseded). Refused radiation-model-mismatch: the text outside the
// regime by eccentricity or by period, on an SGP4XP set, with an area-to-mass of 0 or below 0, the Y0 text without an
// ECOM2_Y0 entry, the plain text with one. The Y0 text with its entry flies. The module's own fit of the eclipsing case's FFM
// arc states the text, solves an area-to-mass within 2 % of the truth's, flies, and without the text is refused.
// SDN_AP_MODEL_TRUTH_MODULE=<module.wasm> flies another build and checks nothing past the flight.
//   node test/long-period-radiation.e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OEM, OEMT} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import {CATT} from 'spacedatastandards.org/lib/js/OEM/CAT.js';
import {ephemerisDataBlockT as Block} from 'spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js';
import {ephemerisDataLineT as Line} from 'spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js';
import {timingStandard} from 'spacedatastandards.org/lib/js/OEM/timingStandard.js';
import {OCMDynamicParameterT} from 'spacedatastandards.org/lib/js/OCM/OCMDynamicParameter.js';
import {OrbitDeterminationT} from 'spacedatastandards.org/lib/js/OCM/OrbitDetermination.js';
import {prwDynamicParameter} from 'spacedatastandards.org/lib/js/OCM/prwDynamicParameter.js';
import {pcfOutputFrame} from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import {pcfWeatherSource} from 'spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js';
import {requestFor, decodeResult, encodePrw, makeTable, TYPE} from '../../ffm/tests/lib/prwCodec.mjs';
import {ffmPath, requireTruth, checkTruth} from './lib/ffm-truth.mjs';
import {jdOf, packOem, rfm} from './lib/frames.mjs';
import {wasmPath} from './lib/module.mjs';
import {configuration, prior, pcfPriorForm, pcfAtmosphereFamily} from './lib/pcf.mjs';
import {seedOcm, rowsThrough, flight, spwStream, ocmOf, repackOcm, T, LP_RADIATION_MODEL} from './lib/ocm.mjs';
import {spwFixtureRows} from './lib/spw-constant.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // FFM 2.3.0 (modules 48a00fd6)
const modulePath = process.env.SDN_AP_MODEL_TRUTH_MODULE ?? wasmPath;
const AGOM = 0.02, RE_KM = 6378.137;
const LP_Y0_RADIATION_MODEL = `${LP_RADIATION_MODEL}, AND ECOM2 Y0 (ARNOLD ET AL. 2015)`;
const CASES = [
  // measured on 0.6.NN, radiation's error at day 7: 20.0 m (0.6.34, SPEC 4's carriers: 48.3 m; with the shadow as on or
  // off at each evaluation: 108.2 m)
  {name: 'eclipsing, 30 h, e 0.31, i 30', n: 0.8, e: 0.31, i: 30, raan: 0, argp: 270, day7: 40},
  // measured on 0.6.NN: 207.7 m (0.6.34: 1,386.5 m; with AP's constant at FFM's, 2.3 m in a J2-only build)
  {name: 'TESS-like, 13.7 d, e 0.55, i 40', n: 1 / 13.7, e: 0.55, i: 40, raan: 0, argp: 120, day7: 300},
];
const epoch = '2026-10-29T00:00:00.000', t0 = Date.parse(epoch + 'Z'), DAY = 864e5, jd = jdOf(epoch);
const iso = (ms) => new Date(ms).toISOString().replace('Z', '');
const kernel = fs.readFileSync(new URL('../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp', import.meta.url));
const rows = spwFixtureRows(), rowList = rowsThrough(Array.isArray(rows) ? rows : rows.rows);
const hours = [...Array(7 * 24 + 1)].map((_, k) => k), epochs = hours.map((h) => iso(t0 + h * 36e5));
const ap = await createStandaloneHarness('browser', modulePath, {surface: 'command'});
const ffm = await createStandaloneHarness('browser', ffmPath, {surface: 'command'});
const apFly = async (seed, at = epochs, frame = pcfOutputFrame.GCRF) => {
  const r = await ap.invoke({methodId: 'propagate', inputs: flight([seed], {output: {EPOCHS: at, FRAME: frame}})});
  assert.equal(r.statusCode, 0, `${r.errorCode}: ${r.errorMessage}`);
  return OEM.getRootAsOEM(new fb.ByteBuffer(r.outputs.find((v) => v.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES.map((l) => [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT]);
};
const ffmFly = async (state, srp) => {
  checkTruth();
  const params = {epochJD: jd.whole, epochTimeScale: 'UTC', targetJD: jd.whole + 7, targetTimeScale: 'UTC', position: state.slice(0, 3), velocity: state.slice(3), frame: 'GCRF',
    sampleEpochsJD: hours.map((h) => ({jd: jd.whole + h / 24, scale: 'UTC'})),
    forces: {gravityMode: 'EGM96', maxDegree: 2, maxOrder: 0, thirdBody: true, srp, drag: false, massKg: 1000, areaM2: AGOM * 1000, cr: 1.0, cd: 2.2},
    weather: {epochUTCJD: jd.whole, F107: 150, F107a: 150, Ap: 15, Kp: 3}, integrator: {tolerance: 1e-12, minStep: 0.01, maxStep: 300}, ephemerisSource: 'JPL_SPK'};
  const req = requestFor('propagate', params, kernel);
  req.inputs.push({portId: 'earth_orientation', typeRef: TYPE, payload: encodePrw('EARTH_ORIENTATION', makeTable('PRWEarthOrientation', {ROWS: Array.from({length: 14}, (_, k) => makeTable('EOP', {DATE: iso(t0 + (k - 1) * DAY) + 'Z', MJD: jd.whole - 2400000.5 + k - 1, TAI_MINUS_UTC_SECONDS: 37}))}))});
  const r = await ffm.invoke(req);
  assert.equal(r.statusCode, 0, `FFM ${r.errorCode}: ${r.errorMessage}`);
  return decodeResult(r).samples.map((s) => [...s.position, ...s.velocity]);
};
const results = [], truths = [];
const seedOf = (c, over = {}) => seedOcm({epoch, n: c.n, e: c.e, i: c.i, raan: c.raan, argp: c.argp, ma: 10, bterm: 0, agom: AGOM, norad: 99001, records: true, tesseral: 0, zonal: 2, rows: rowList, ...over});
for (const c of CASES) {
  const apOn = await apFly(seedOf(c)), apOff = await apFly(seedOf(c, {agom: 0}));
  const fOn = await ffmFly(apOn[0], true), fOff = await ffmFly(apOff[0], false);
  truths.push(fOn);
  const days = {};
  for (const d of [1, 3, 5, 7]) {
    const k = d * 24, err = [0, 1, 2].map((j) => (apOn[k][j] - apOff[k][j]) - (fOn[k][j] - fOff[k][j]));
    days[d] = +(1000 * Math.hypot(...err)).toFixed(1);
  }
  results.push({name: c.name, radiationErrorM: days, boundDay7M: c.day7});
  console.log(JSON.stringify({longPeriodRadiation: c.name, radiationErrorM: days}));
}
// the eclipsing set in AP's shadow: its TEME states hourly against the module's own Sun (sdnap_bodies_probe mode 2, what AP's
// flights read, TEME of date) in the cylinder of radius R_E behind the Earth (16.15)
const probe = await createStandaloneHarness('browser', modulePath, {surface: 'direct', maxThreads: 1, enableBrowserWasiThreads: false});
const px = probe.instance.exports, pout = px.sdnap_alloc(64);
const sunAt = (ms) => {
  const j = jdOf(iso(ms));
  assert.equal(px.sdnap_bodies_probe(j.whole, j.frac, 2, pout), 0);
  return Array.from(new Float64Array(probe.memory.buffer, pout, 3));
};
const inShadow = (r, s) => { const d = r[0] * s[0] + r[1] * s[1] + r[2] * s[2]; return d < 0 && Math.hypot(r[0] - d * s[0], r[1] - d * s[1], r[2] - d * s[2]) < RE_KM; };
const eclipsing = CASES[0], teme = await apFly(seedOf(eclipsing), epochs, pcfOutputFrame.TEME);
const shade = teme.map((s, k) => inShadow(s, sunAt(t0 + k * 36e5)));
const entry = shade.findIndex((x, k) => k > 0 && x && !shade[k - 1]), exit = entry < 0 ? -1 : shade.findIndex((x, k) => k > entry && !x);
// the 1 s scan: an hour before the entry's hour to an hour after the exit's, at least 3 h (the step there is under 95 min)
const scanFrom = t0 + Math.max(entry - 2, 0) * 36e5, scanTo = Math.max(t0 + (exit + 1) * 36e5, scanFrom + 3 * 36e5);
const scanEpochs = Array.from({length: Math.round((scanTo - scanFrom) / 1000) + 1}, (_, k) => iso(scanFrom + k * 1000));
const scan = entry > 0 && exit > entry ? await apFly(seedOf(eclipsing), scanEpochs) : [];
let fourth = 0;
for (let k = 2; k + 2 < scan.length; k += 1) {
  const d = [0, 1, 2].map((j) => scan[k - 2][j] - 4 * scan[k - 1][j] + 6 * scan[k][j] - 4 * scan[k + 1][j] + scan[k + 2][j]);
  fourth = Math.max(fourth, 1000 * Math.hypot(...d));
}
const shadow = {hoursInShadow: shade.filter(Boolean).length, entryHour: entry, exitHour: exit, scanStates: scan.length, largestFourthDifferenceM: +fourth.toExponential(3)};
console.log(JSON.stringify({shadow}));
// the record's statement (SPEC 16.22)
const refusal = async (seed) => {
  const r = await ap.invoke({methodId: 'propagate', inputs: flight([seed], {output: {EPOCHS: [epochs[1]], FRAME: pcfOutputFrame.GCRF}})});
  return r.statusCode === 0 ? null : r.errorCode;
};
const withY0 = (seed) => repackOcm(seed, (t) => {
  t.ORBIT_DETERMINATION = Object.assign(new OrbitDeterminationT(), {OD_DYNAMIC_PARAMETERS: [Object.assign(new OCMDynamicParameterT(), {NAME: 'ECOM2_Y0', VALUE: 1e-9, UNITS: 'm/s**2', SOLVED_FOR: false, PARAMETER: prwDynamicParameter.ECOM2_Y0})]});
});
const tess = CASES[1];
const refusals = {
  stated: await refusal(seedOf(tess)),
  unstated: await refusal(seedOf(tess, {radiationModel: null})),
  outsideByEccentricity: await refusal(seedOf(tess, {e: 0.29, radiationModel: LP_RADIATION_MODEL})),
  outsideByPeriod: await refusal(seedOf(tess, {n: 1440 / 1000, radiationModel: LP_RADIATION_MODEL})),
  sgp4xp: await refusal(seedOcm({epoch, n: tess.n, e: tess.e, i: tess.i, raan: tess.raan, argp: tess.argp, ma: 10, agom: AGOM, norad: 99001, radiationModel: LP_RADIATION_MODEL})),
  noAreaToMass: await refusal(seedOf(tess, {agom: 0, radiationModel: LP_RADIATION_MODEL})),
  negativeAreaToMass: await refusal(seedOf(tess, {agom: -AGOM, radiationModel: LP_RADIATION_MODEL})),
  y0Paired: await refusal(withY0(seedOf(tess, {radiationModel: LP_Y0_RADIATION_MODEL}))),
  y0TextWithoutEntry: await refusal(seedOf(tess, {radiationModel: LP_Y0_RADIATION_MODEL})),
  entryUnderPlainText: await refusal(withY0(seedOf(tess))),
};
console.log(JSON.stringify({refusals}));
// the round trip: the module's own fit of the eclipsing case's first 72 h of FFM with radiation (hourly, GCRF; the area-to-mass
// solved, the drag term held at 0) states the text and flies; the same record without the text (as the build before this
// change wrote it) is refused by name
const fitLines = truths[0].slice(0, 73).map((s, k) => Object.assign(new Line(), {EPOCH: epochs[k], X: s[0], Y: s[1], Z: s[2], X_DOT: s[3], Y_DOT: s[4], Z_DOT: s[5]}));
const fitOem = packOem(Object.assign(new OEMT(), {EPHEMERIS_DATA_BLOCK: [Object.assign(new Block(), {OBJECT: Object.assign(new CATT(), {NORAD_CAT_ID: 99001, OBJECT_NAME: 'ECLIPSING LONG-PERIOD SET'}),
  CENTER_NAME: 'EARTH', REFERENCE_FRAME: rfm('GCRF'), TIME_SYSTEM: timingStandard.UTC, START_TIME: fitLines[0].EPOCH, STOP_TIME: fitLines.at(-1).EPOCH,
  USEABLE_START_TIME: fitLines[0].EPOCH, USEABLE_STOP_TIME: fitLines.at(-1).EPOCH, EPHEMERIS_DATA_LINES: fitLines})]}));
const fitted = await ap.invoke({methodId: 'fit', inputs: [
  configuration({forces: {EPHEMERIS_SOURCE: '', HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 0, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 2,
    ATMOSPHERE_MODEL: pcfAtmosphereFamily.JACCHIA70, WEATHER_SOURCE: pcfWeatherSource.RECORDS}, fit: {DRAG_PRIOR: prior(0, 1e-10), DRAG_PRIOR_FORM: pcfPriorForm.GAUSSIAN_SIGNED}}),
  {portId: 'space_weather', typeRef: T('SPW'), payload: spwStream(rowList)}, {portId: 'ephemeris', typeRef: T('OEM'), payload: fitOem}]});
assert.equal(fitted.statusCode, 0, `fit: ${fitted.errorCode}: ${fitted.errorMessage}`);
const record = new Uint8Array(fitted.outputs.find((v) => v.portId === 'elements').payload), stated = ocmOf(record);
const roundTrip = {agom: stated.MEAN_ELEMENTS.AGOM, text: stated.PERTURBATIONS?.SOLAR_RAD_PRESSURE ?? null, flown: await refusal(record),
  withoutTheText: await refusal(repackOcm(record, (t) => { t.PERTURBATIONS.SOLAR_RAD_PRESSURE = null; }))};
console.log(JSON.stringify({roundTrip}));
await ap.close?.();
await ffm.close?.();
await probe.close?.();
if (!process.env.SDN_AP_MODEL_TRUTH_MODULE) {
  for (const r of results) assert.ok(r.radiationErrorM[7] <= r.boundDay7M, `${r.name}: radiation's error at day 7 ${r.radiationErrorM[7]} m above ${r.boundDay7M} m`);
  assert.ok(shadow.entryHour > 0 && shadow.exitHour > shadow.entryHour, `the eclipsing set enters and leaves AP's shadow (${JSON.stringify(shadow)})`);
  assert.ok(shadow.largestFourthDifferenceM <= 0.001, `the 1 s scan across the shadow: a fourth difference of ${shadow.largestFourthDifferenceM} m, above 1 mm`);
  assert.equal(refusals.stated, null, 'a set of the regime that states the model flies');
  assert.equal(refusals.unstated, 'radiation-model-superseded', 'a set of the regime that does not state it is refused by name');
  for (const k of ['outsideByEccentricity', 'outsideByPeriod', 'sgp4xp', 'noAreaToMass', 'negativeAreaToMass', 'y0TextWithoutEntry', 'entryUnderPlainText'])
    assert.equal(refusals[k], 'radiation-model-mismatch', `${k}: radiation-model-mismatch`);
  assert.equal(refusals.y0Paired, null, 'the Y0 text with its ECOM2_Y0 entry flies');
  assert.ok(Math.abs(roundTrip.agom / AGOM - 1) <= 0.02, `the fit solves an area-to-mass within 2 % of the truth's (${roundTrip.agom})`);
  assert.equal(roundTrip.text, LP_RADIATION_MODEL, 'the fitted record states the model');
  assert.equal(roundTrip.flown, null, 'the fitted record flies');
  assert.equal(roundTrip.withoutTheText, 'radiation-model-superseded', 'the fitted record without the text is refused by name');
}
console.log('long-period radiation E2E: PASS');
process.exit(0);
