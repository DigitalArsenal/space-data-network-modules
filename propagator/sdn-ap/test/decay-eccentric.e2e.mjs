#!/usr/bin/env node
// E2E (stack #594; SPEC 16.25): the decay rule reads what DRAG does to the perigee, not the Sun's and the Moon's. On an orbit at e 0.9 (apogee
// 131,000 and 140,000 km here) the mean perigee radius moves by more than a density scale height a revolution under the Sun and the Moon
// alone, rising or falling, with no decay: drag at perigee lowers the semi-major axis and the eccentricity together, so its own part of the
// perigee's rate is about 0. Two made-up sets at e 0.9, their truth the numerical propagator (FFM, named below by its SHA-256) flown from AP's
// own seeded GCRF state, EGM2008 70 x 70, the Sun and Moon, NRLMSISE-00 drag at constant weather, 120 h every 300 s:
// - mean perigee about 1,000 km, i 0.5: the truth's perigee never goes under 800 km (asserted);
// - mean perigee about 500 km, i 55: the truth's perigee RISES, more than 20 km in the first 24 h (asserted).
// Each is fitted by this build (not refused decayed-in-arc: the first form of the rule read the Sun's and the Moon's rate as decay and
// refused them), the fit converges with an RMS under 0.25 km (a fit that converges somewhere else fails), and the record it writes is
// propagated over its arc: every state answered, the perigee of the record's states following the truth's.
// The other side: a set at e 0.9 whose truth DOES re-enter inside the span is refused as decayed, at a time before the
// truth's re-entry (its end of the numerical propagator), and no state after the refusal is answered.
//   node test/decay-eccentric.e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as fb from 'flatbuffers';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import { OEM, OEMT } from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import { CATT } from 'spacedatastandards.org/lib/js/OEM/CAT.js';
import { ephemerisDataBlockT as Block } from 'spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js';
import { ephemerisDataLineT as Line } from 'spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js';
import { timingStandard } from 'spacedatastandards.org/lib/js/OEM/timingStandard.js';
import { pcfAtmosphereFamily } from 'spacedatastandards.org/lib/js/PCF/pcfAtmosphereFamily.js';
import { pcfWeatherSource } from 'spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js';
import { pcfOutputFrame } from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import { requestFor, decodeResult, encodePrw, makeTable, TYPE } from '../../ffm/tests/lib/prwCodec.mjs';
import { ffmPath, requireTruth, checkTruth } from './lib/ffm-truth.mjs';
import { jdOf, packOem, rfm } from './lib/frames.mjs';
import { wasmPath } from './lib/module.mjs';
import { seedOcm, rowsThrough, flight, spwStream, ocmOf } from './lib/ocm.mjs';
import { configuration } from './lib/pcf.mjs';
import { spwConstantText } from './lib/spw-constant.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // FFM 2.3.0 (modules 48a00fd6)
const CASES = [
  { name: 'mean perigee about 1,000 km, e 0.9, i 0.5', epoch: '2026-02-01T00:00:00.000', n: 0.433161637, e: 0.9007033, i: 0.596598, raan: 192.20718, argp: 153.97925, ma: 37.15461, floorKm: 800, rising: false },
  { name: 'mean perigee about 500 km, e 0.9, i 55 (the truth\'s perigee rises)', epoch: '2026-09-05T00:00:00.000', n: 0.481293675, e: 0.8991996, i: 55.095212, raan: 272.4614, argp: 301.26643, ma: 105.0206, floorKm: 400, rising: true },
  // the other side: perigee 110 km at e 0.9, argument of perigee 90 degrees, BTERM 0.1. When written, this test printed
  // AP refusal at 17.37 h and numerical truth re-entry at 40.48 h; these are measured outputs, not constants used by the test.
  { name: 'perigee 110 km, e 0.9, i 28.5, BTERM 0.1 (the truth re-enters)', epoch: '2026-10-29T00:00:00.000', n: 0.5253185593164899, e: 0.9, i: 28.5, raan: 40, argp: 90, ma: 0, b: 0.1, reenters: true },
];
const TRUTH_B = 0.022, DAY = 864e5, MU = 398600.4418, iso = (ms) => new Date(ms).toISOString().replace('Z', '');
const kernel = fs.readFileSync(new URL('../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp', import.meta.url));
const now = await createStandaloneHarness('browser', wasmPath, { surface: 'command' });
const ffm = await createStandaloneHarness('browser', ffmPath, { surface: 'command' });
const type = (x) => ({ schemaName: `${x}.fbs`, fileIdentifier: `$${x}`, rootTypeName: x });
// the osculating perigee height (km, spherical) of a state: a (1 - e) less the Earth's radius
const perigeeKm = (s) => {
  const r = Math.hypot(s[0], s[1], s[2]), v2 = s[3] ** 2 + s[4] ** 2 + s[5] ** 2;
  const hx = s[1] * s[5] - s[2] * s[4], hy = s[2] * s[3] - s[0] * s[5], hz = s[0] * s[4] - s[1] * s[3];
  const eps = v2 / 2 - MU / r, a = -MU / (2 * eps), e = Math.sqrt(Math.max(0, 1 + (2 * eps * (hx * hx + hy * hy + hz * hz)) / (MU * MU)));
  return a * (1 - e) - 6378.137;
};
for (const c of CASES) {
  const t0 = Date.parse(c.epoch + 'Z'), jd = jdOf(c.epoch), jd0 = jd.whole + jd.frac, mjd0 = Math.floor(jd0 - 2400000.5);
  const rows = rowsThrough(JSON.parse(spwConstantText(c.epoch.slice(0, 10), 45)));
  const B = c.b ?? TRUTH_B;
  const seed = seedOcm({ epoch: c.epoch, n: c.n, e: c.e, i: c.i, raan: c.raan, argp: c.argp, ma: c.ma, bterm: B, agom: 0, norad: 99564, msis: true, records: true, tesseral: 31, zonal: 20, rows });
  const start = await now.invoke({ methodId: 'propagate', inputs: flight([seed], { output: { EPOCHS: [c.epoch], FRAME: pcfOutputFrame.GCRF } }) });
  assert.equal(start.statusCode, 0, `${c.name}: ${start.errorCode}: ${start.errorMessage}`);
  const s0 = OEM.getRootAsOEM(new fb.ByteBuffer(start.outputs.find((v) => v.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES[0];
  const seconds = [...Array(1441)].map((_, k) => 300 * k);
  checkTruth();
  const params = { epochJD: jd0, epochTimeScale: 'UTC', targetJD: jd0 + 5.01, targetTimeScale: 'UTC', position: [s0.X, s0.Y, s0.Z], velocity: [s0.X_DOT, s0.Y_DOT, s0.Z_DOT], frame: 'GCRF',
    sampleEpochsJD: seconds.map((s) => ({ jd: jd0 + s / 86400, scale: 'UTC' })),
    forces: { gravityMode: 'EGM2008', maxDegree: 70, maxOrder: 70, thirdBody: true, srp: false, drag: true, dragModel: 'NRLMSISE00', massKg: 1000, areaM2: (B * 1000) / 2.2, cr: 1.0, cd: 2.2 },
    weather: { epochUTCJD: jd0, F107: 150, F107a: 150, Ap: 15, Kp: 3 }, integrator: { tolerance: 1e-12, minStep: 0.01, maxStep: 300 }, ephemerisSource: 'JPL_SPK' };
  const rq = requestFor('propagate', params, kernel);
  rq.inputs.push({ portId: 'earth_orientation', typeRef: TYPE, payload: encodePrw('EARTH_ORIENTATION', makeTable('PRWEarthOrientation', { ROWS: Array.from({ length: 15 }, (_, k) => makeTable('EOP', { DATE: new Date((mjd0 + k - 1 - 40587) * DAY).toISOString(), MJD: mjd0 + k - 1, XP: 0, YP: 0, DUT1: 0, LOD: 0 })) })) });
  const fr = await ffm.invoke(rq);
  if (!c.reenters) assert.equal(fr.statusCode, 0, `${c.name}: FFM ${fr.errorCode}: ${fr.errorMessage}`);
  if (c.reenters) {
    // the truth ends at its re-entry; this build refuses the record as decayed at a time before it, answers every epoch up to
    // the crossing and none after it
    assert.notEqual(fr.statusCode, 0, `${c.name}: the numerical propagator does not re-enter within the span`);
    const re = /at (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)/.exec(String(fr.errorMessage));
    assert.ok(re && /reentry/.test(String(fr.errorMessage)), `${c.name}: FFM stopped for another reason: ${fr.errorMessage}`);
    const reH = (Date.parse(re[1] + 'Z') - t0) / 3.6e6;
    const ep = Array.from({ length: 241 }, (_, k) => iso(t0 + k * 1800e3));
    const fl = await now.invoke({ methodId: 'propagate', inputs: flight([seed], { output: { EPOCHS: ep, FRAME: pcfOutputFrame.GCRF } }) });
    assert.equal(fl.statusCode, 0, `${c.name}: ${fl.errorCode}`);
    const blk = OEM.getRootAsOEM(new fb.ByteBuffer(fl.outputs.find((o) => o.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0];
    const cm = /^decayed:(\S+);/.exec(blk.COMMENT ?? '');
    assert.ok(cm, `${c.name}: not refused as decayed within the span (${blk.COMMENT})`);
    const crossH = (Date.parse(cm[1] + 'Z') - t0) / 3.6e6;
    assert.ok(crossH > 0 && crossH < reH, `${c.name}: the refusal at ${crossH.toFixed(2)} h is not before the truth's re-entry at ${reH.toFixed(2)} h`);
    const before = ep.filter((t) => Date.parse(t + 'Z') < Date.parse(cm[1] + 'Z'));
    assert.deepEqual(blk.EPHEMERIS_DATA_LINES.map((l) => Date.parse(l.EPOCH + 'Z')), before.map((t) => Date.parse(t + 'Z')), `${c.name}: every epoch before the crossing, none after it`);
    assert.equal(blk.USEABLE_STOP_TIME, cm[1], `${c.name}: usable stop names the crossing`);
    console.log(JSON.stringify({ decayEccentric: c.name, truthReentryH: +reH.toFixed(2), refusedAtH: +crossH.toFixed(2), answered: blk.EPHEMERIS_DATA_LINES.length }));
    continue;
  }
  const states = decodeResult(fr).samples;
  const truthPerigee = states.map((s) => perigeeKm([...s.position, ...s.velocity]));
  const truthMin = Math.min(...truthPerigee);
  assert.ok(truthMin > c.floorKm, `${c.name}: the truth's perigee reaches ${truthMin.toFixed(1)} km, not above ${c.floorKm}`);
  if (c.rising) assert.ok(truthPerigee[288] > truthPerigee[0] + 20, `${c.name}: the truth's perigee at 24 h ${truthPerigee[288].toFixed(1)} km, at 0 h ${truthPerigee[0].toFixed(1)} km: not rising`);
  const lines = states.map((s, k) => Object.assign(new Line(), { EPOCH: iso(t0 + seconds[k] * 1000), X: s.position[0], Y: s.position[1], Z: s.position[2], X_DOT: s.velocity[0], Y_DOT: s.velocity[1], Z_DOT: s.velocity[2] }));
  const block = Object.assign(new Block(), { OBJECT: Object.assign(new CATT(), { NORAD_CAT_ID: 99564, OBJECT_NAME: 'SYNTHETIC' }), CENTER_NAME: 'EARTH', REFERENCE_FRAME: rfm('GCRF'), TIME_SYSTEM: timingStandard.UTC,
    START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH, USEABLE_START_TIME: lines[0].EPOCH, USEABLE_STOP_TIME: lines.at(-1).EPOCH, EPHEMERIS_DATA_LINES: lines });
  const oem = packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [block] }));
  const cfg = configuration({ forces: { EPHEMERIS_SOURCE: '', HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20,
    ATMOSPHERE_MODEL: pcfAtmosphereFamily.NRLMSISE00, WEATHER_SOURCE: pcfWeatherSource.RECORDS }, fit: {} });
  const fitStart = performance.now();
  const fit = await now.invoke({ methodId: 'fit', inputs: [cfg, { portId: 'space_weather', typeRef: type('SPW'), payload: spwStream(rows) }, { portId: 'ephemeris', typeRef: type('OEM'), payload: oem }] });
  const fitMs = performance.now() - fitStart;
  assert.equal(fit.statusCode, 0, `${c.name}: the fit is refused: ${fit.errorCode}: ${String(fit.errorMessage).slice(0, 160)}`);
  const recordBytes = fit.outputs.find((v) => v.portId === 'elements').payload;
  const record = ocmOf(recordBytes), st = record.ORBIT_DETERMINATION.FIT_STATISTICS;
  assert.ok(st.CONVERGED === true && st.FIT_RMS_KM < 0.25, `${c.name}: the fit's RMS is ${st.FIT_RMS_KM} km, converged ${st.CONVERGED} (the fit reaches 0.04 to 0.11 km)`);
  // the record flown over its arc: every epoch answered, none refused as decayed
  const epochs = Array.from({ length: 241 }, (_, k) => iso(t0 + k * 1800e3));
  const fl = await now.invoke({ methodId: 'propagate', inputs: flight([recordBytes], { output: { EPOCHS: epochs, FRAME: pcfOutputFrame.GCRF } }) });
  assert.equal(fl.statusCode, 0, `${c.name}: the record is refused over its arc: ${fl.errorCode}`);
  const blk = OEM.getRootAsOEM(new fb.ByteBuffer(fl.outputs.find((o) => o.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0];
  assert.equal(blk.EPHEMERIS_DATA_LINES.length, 241, `${c.name}: ${blk.EPHEMERIS_DATA_LINES.length} of 241 epochs answered (${blk.COMMENT})`);
  // the record's perigee against the truth's at 24 h, 72 h and 120 h
  const rec = (k) => { const l = blk.EPHEMERIS_DATA_LINES[k]; return perigeeKm([l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT]); };
  const gaps = [48, 144, 240].map((k) => Math.abs(rec(k) - truthPerigee[k * 6]));
  assert.ok(gaps.every((g) => g < 25), `${c.name}: the record's perigee is off the truth's by ${gaps.map((g) => g.toFixed(1))} km at 24, 72 and 120 h`);
  console.log(JSON.stringify({ decayEccentric: c.name, truthPerigeeMinKm: +truthMin.toFixed(1), fitRmsKm: st.FIT_RMS_KM, fitMs, converged: st.CONVERGED, perigeeGapsKm: gaps.map((g) => +g.toFixed(2)) }));
}
await now.close?.();
await ffm.close?.();
console.log('decay eccentric E2E: PASS');
process.exit(0);
