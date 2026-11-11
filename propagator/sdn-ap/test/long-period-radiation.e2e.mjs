#!/usr/bin/env node
// Radiation pressure in the long-period regime above e 0.3 through the output map (SPEC 16.21), on model truth, seeded (no
// fit). AP sets with J2 alone (no tesseral term) and the module's own Sun and Moon, seeded at perigee on
// test/lib/heo-model-truth.mjs's epoch, flown hourly over 7 days with a Cr A/m of 0.02 m^2/kg and without. Each arm's
// truth is FFM (named below by its SHA-256) started from that arm's own state at the epoch, with J2 alone, DE440's Sun and
// Moon, and a cannonball of Cr 1 and A/m 0.02 m^2/kg, or none. Radiation's own error is what remains of AP's radiation
// displacement (with minus without) against FFM's, so the two arms' gravity and third-body errors cancel:
// - an eclipsing set, 30 h, e 0.31 (the integrator's step crosses the shadow's edge every revolution: the force is the
//   step window's share of light, 16.21);
// - a TESS-like set, 13.7 days, e 0.55 (five days are under half a revolution: SPEC 4's averaged rates and first-order
//   periodic output terms missed most of it; what remains is AP's pressure constant, 4.5e-6 N/m^2 against FFM's 4.540e-6).
// SDN_AP_MODEL_TRUTH_MODULE=<module.wasm> flies another build and checks nothing past the flight.
//   node test/long-period-radiation.e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OEM} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import {pcfOutputFrame} from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import {requestFor, decodeResult, encodePrw, makeTable, TYPE} from '../../ffm/tests/lib/prwCodec.mjs';
import {ffmPath, requireTruth, checkTruth} from './lib/ffm-truth.mjs';
import {jdOf} from './lib/frames.mjs';
import {wasmPath} from './lib/module.mjs';
import {seedOcm, rowsThrough, flight} from './lib/ocm.mjs';
import {spwFixtureRows} from './lib/spw-constant.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // FFM 2.3.0 (modules 48a00fd6)
const modulePath = process.env.SDN_AP_MODEL_TRUTH_MODULE ?? wasmPath;
const AGOM = 0.02;
const CASES = [
  // measured on 0.6.NN, radiation's error at day 7: 20.0 m (0.6.34, SPEC 4's carriers: 48.3 m; the shadow as on or off
  // at each evaluation, a scratch build: 108.2 m)
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
const apFly = async (seed) => {
  const r = await ap.invoke({methodId: 'propagate', inputs: flight([seed], {output: {EPOCHS: epochs, FRAME: pcfOutputFrame.GCRF}})});
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
const results = [];
for (const c of CASES) {
  const seedOf = (agom) => seedOcm({epoch, n: c.n, e: c.e, i: c.i, raan: c.raan, argp: c.argp, ma: 10, bterm: 0, agom, norad: 99001, records: true, tesseral: 0, zonal: 2, rows: rowList});
  const apOn = await apFly(seedOf(AGOM)), apOff = await apFly(seedOf(0));
  const fOn = await ffmFly(apOn[0], true), fOff = await ffmFly(apOff[0], false);
  const days = {};
  for (const d of [1, 3, 5, 7]) {
    const k = d * 24, err = [0, 1, 2].map((j) => (apOn[k][j] - apOff[k][j]) - (fOn[k][j] - fOff[k][j]));
    days[d] = +(1000 * Math.hypot(...err)).toFixed(1);
  }
  results.push({name: c.name, radiationErrorM: days, boundDay7M: c.day7});
  console.log(JSON.stringify({longPeriodRadiation: c.name, radiationErrorM: days}));
}
await ap.close?.();
await ffm.close?.();
if (!process.env.SDN_AP_MODEL_TRUTH_MODULE)
  for (const r of results) assert.ok(r.radiationErrorM[7] <= r.boundDay7M, `${r.name}: radiation's error at day 7 ${r.radiationErrorM[7]} m above ${r.boundDay7M} m`);
console.log('long-period radiation E2E: PASS');
process.exit(0);
