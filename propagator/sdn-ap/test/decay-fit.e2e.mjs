#!/usr/bin/env node
// E2E (stack #564; SPEC 16.25): a fit whose trial sets meet the decay rule keeps iterating. A set that decays inside the fit's arc is
// refused (decay.e2e.mjs); the fit's finite-difference columns bump the drag term, and a bumped set may cross the rule inside the arc
// while the iterate itself does not. Such a column is differenced below the iterate; it is never a reason to end a pass as converged.
// The case: a made-up set at perigee 200 km, e 0.01, i 55, whose drag crosses the rule a few hours after a 120 h arc ends; the truth is
// FFM (named below by its SHA-256) flown from AP's own seeded GCRF state, EGM2008 70 x 70, NRLMSISE-00 drag on constant weather,
// the Sun and Moon; AP is fitted to the truth's states every 300 s over the 120 h, on this build and on 0.6.45 (git, modules
// b1a08e44, its SHA-256 checked, which does not refuse a trial and so never meets the column's refusal), and the two records compared:
// - the radiation pass runs and solves a radiation term (the record's AGOM is not 0), as 0.6.45's does;
// - the fit statistics carry the iterations of all its passes, within the same order as 0.6.45's (a pass that ended at its first
//   iteration would read a few);
// - the record's fit RMS is at most 1.10 times 0.6.45's (the column's difference below the iterate, not a copy of it, so not equal);
// - the record states CONVERGED true or, if a pass could not difference a column in either direction, CONVERGED false with the OD
//   COMMENT line that names it (a pass that tested no step is never said to be at a minimum).
//   node test/decay-fit.e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scratchTemp } from './lib/scratch.mjs';
import { createHash } from 'node:crypto';
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
import { wasmPath, packageRoot } from './lib/module.mjs';
import { seedOcm, rowsThrough, flight, spwStream, ocmOf } from './lib/ocm.mjs';
import { configuration } from './lib/pcf.mjs';
import { spwConstantText } from './lib/spw-constant.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // FFM 2.3.0 (modules 48a00fd6)
const BEFORE = { version: '0.6.45', commit: 'b1a08e44fdfa3dfee105c8a4d7a2c4c19f814215', sha256: 'edc9b14b5226337cebdf1d1932517f11eb311b5e73b7ff40d52b7b41e3feac46' };
const CASE = { name: 'perigee 200 km, e 0.01, i 55, B 0.0235', epoch: '2026-10-29T00:00:00.000', hp: 200, e: 0.01, i: 55, raan: 40, argp: 90, ma: 0, truthB: 0.0235 };
const DAY = 864e5, MU = 398600.4418, RE = 6378.137, iso = (ms) => new Date(ms).toISOString().replace('Z', '');
const kernel = fs.readFileSync(new URL('../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const beforeBytes = execFileSync('git', ['-C', packageRoot, 'show', `${BEFORE.commit}:propagator/sdn-ap/dist/isomorphic/module.wasm`], { maxBuffer: 1 << 26 });
assert.equal(sha256(beforeBytes), BEFORE.sha256, `sdn-ap ${BEFORE.version} at ${BEFORE.commit.slice(0, 9)}`);
const beforePath = path.join(scratchTemp('sdn-ap-decay-fit-'), `sdn-ap-${BEFORE.version}.wasm`);
fs.writeFileSync(beforePath, beforeBytes);
const now = await createStandaloneHarness('browser', wasmPath, { surface: 'command' });
const was = await createStandaloneHarness('browser', beforePath, { surface: 'command' });
const ffm = await createStandaloneHarness('browser', ffmPath, { surface: 'command' });
const type = (n) => ({ schemaName: `${n}.fbs`, fileIdentifier: `$${n}`, rootTypeName: n });
const c = CASE;
const t0 = Date.parse(c.epoch + 'Z'), jd = jdOf(c.epoch), jd0 = jd.whole + jd.frac, mjd0 = Math.floor(jd0 - 2400000.5);
const rows = rowsThrough(JSON.parse(spwConstantText(c.epoch.slice(0, 10), 45)));
const a = (RE + c.hp) / (1 - c.e), n = (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI);
const seed = seedOcm({ epoch: c.epoch, n, e: c.e, i: c.i, raan: c.raan, argp: c.argp, ma: c.ma, bterm: c.truthB, agom: 0, norad: 99564, msis: true, records: true, tesseral: 31, zonal: 20, rows });
const start = await now.invoke({ methodId: 'propagate', inputs: flight([seed], { output: { EPOCHS: [c.epoch], FRAME: pcfOutputFrame.GCRF } }) });
assert.equal(start.statusCode, 0, `${start.errorCode}: ${start.errorMessage}`);
const s0 = OEM.getRootAsOEM(new fb.ByteBuffer(start.outputs.find((v) => v.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES[0];
const seconds = [...Array(1441)].map((_, k) => 300 * k);
checkTruth();
const params = { epochJD: jd0, epochTimeScale: 'UTC', targetJD: jd0 + 5.01, targetTimeScale: 'UTC', position: [s0.X, s0.Y, s0.Z], velocity: [s0.X_DOT, s0.Y_DOT, s0.Z_DOT], frame: 'GCRF',
  sampleEpochsJD: seconds.map((s) => ({ jd: jd0 + s / 86400, scale: 'UTC' })),
  forces: { gravityMode: 'EGM2008', maxDegree: 70, maxOrder: 70, thirdBody: true, srp: false, drag: true, dragModel: 'NRLMSISE00', massKg: 1000, areaM2: (c.truthB * 1000) / 2.2, cr: 1.0, cd: 2.2 },
  weather: { epochUTCJD: jd0, F107: 150, F107a: 150, Ap: 15, Kp: 3 }, integrator: { tolerance: 1e-12, minStep: 0.01, maxStep: 300 }, ephemerisSource: 'JPL_SPK' };
const rq = requestFor('propagate', params, kernel);
rq.inputs.push({ portId: 'earth_orientation', typeRef: TYPE, payload: encodePrw('EARTH_ORIENTATION', makeTable('PRWEarthOrientation', { ROWS: Array.from({ length: 15 }, (_, k) => makeTable('EOP', { DATE: new Date((mjd0 + k - 1 - 40587) * DAY).toISOString(), MJD: mjd0 + k - 1, XP: 0, YP: 0, DUT1: 0, LOD: 0 })) })) });
const fr = await ffm.invoke(rq);
assert.equal(fr.statusCode, 0, `FFM ${fr.errorCode}: ${fr.errorMessage}`);
const states = decodeResult(fr).samples;
const lines = states.map((s, k) => Object.assign(new Line(), { EPOCH: iso(t0 + seconds[k] * 1000), X: s.position[0], Y: s.position[1], Z: s.position[2], X_DOT: s.velocity[0], Y_DOT: s.velocity[1], Z_DOT: s.velocity[2] }));
const block = Object.assign(new Block(), { OBJECT: Object.assign(new CATT(), { NORAD_CAT_ID: 99564, OBJECT_NAME: 'SYNTHETIC' }), CENTER_NAME: 'EARTH', REFERENCE_FRAME: rfm('GCRF'), TIME_SYSTEM: timingStandard.UTC,
  START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH, USEABLE_START_TIME: lines[0].EPOCH, USEABLE_STOP_TIME: lines.at(-1).EPOCH, EPHEMERIS_DATA_LINES: lines });
const oem = packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [block] }));
const cfg = configuration({ forces: { EPHEMERIS_SOURCE: '', HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20,
  ATMOSPHERE_MODEL: pcfAtmosphereFamily.NRLMSISE00, WEATHER_SOURCE: pcfWeatherSource.RECORDS }, fit: {} });
const fitOn = async (h) => {
  const r = await h.invoke({ methodId: 'fit', inputs: [cfg, { portId: 'space_weather', typeRef: type('SPW'), payload: spwStream(rows) }, { portId: 'ephemeris', typeRef: type('OEM'), payload: oem }] });
  assert.equal(r.statusCode, 0, `${c.name}: ${r.errorCode}: ${r.errorMessage}`);
  return ocmOf(r.outputs.find((v) => v.portId === 'elements').payload);
};
const A = await fitOn(now), B = await fitOn(was);
const sa = A.ORBIT_DETERMINATION.FIT_STATISTICS, sb = B.ORBIT_DETERMINATION.FIT_STATISTICS;
const agom = (o) => o.MEAN_ELEMENTS.AGOM;
const summary = { case: c.name, rmsKm: [sa.FIT_RMS_KM, sb.FIT_RMS_KM], iterations: [sa.ITERATIONS, sb.ITERATIONS], converged: [sa.CONVERGED, sb.CONVERGED],
  agom: [agom(A), agom(B)], bterm: [A.MEAN_ELEMENTS.BTERM, B.MEAN_ELEMENTS.BTERM], comment: (A.ORBIT_DETERMINATION.COMMENT ?? []).filter((l) => /^(fit|decays)/.test(l)) };
console.log(JSON.stringify({ decayFit: summary }));
// what a column refused as decayed used to do: the pass ended as converged at its start (no step tested), the radiation pass among
// them, so the record kept AGOM 0 and a fit RMS 1.21 times 0.6.45's (this case, flown on the first form of the rule)
assert.ok(agom(A) !== 0, `the radiation pass solves a radiation term: AGOM ${agom(A)}`);
assert.ok(sa.FIT_RMS_KM <= 1.1 * sb.FIT_RMS_KM, `the fit RMS ${sa.FIT_RMS_KM} km is at most 1.10 times 0.6.45's ${sb.FIT_RMS_KM} km`);
assert.ok(sa.ITERATIONS >= 0.9 * sb.ITERATIONS, `the passes iterate: ${sa.ITERATIONS} iterations against 0.6.45's ${sb.ITERATIONS}`);
const odLines = A.ORBIT_DETERMINATION.COMMENT ?? [];
assert.ok(sa.CONVERGED === true || odLines.some((l) => l.includes('could not be differenced')), `CONVERGED ${sa.CONVERGED}: a pass that tested no step names why`);
assert.ok(odLines.some((l) => l.startsWith('decays at ')), 'the record states where the set decays');
// the same fit on a second instance of this build: the same record to the bit (no column is read from memory a pass did not write)
const again = await createStandaloneHarness('browser', wasmPath, { surface: 'command' });
const A2 = await fitOn(again);
assert.equal(JSON.stringify(A2.MEAN_ELEMENTS), JSON.stringify(A.MEAN_ELEMENTS), 'a second instance fits the same elements');
assert.equal(JSON.stringify(A2.ORBIT_DETERMINATION.FIT_STATISTICS), JSON.stringify(sa), 'and the same statistics');
await again.close?.();
console.log('decay fit E2E: PASS');
await now.close?.();
await was.close?.();
await ffm.close?.();
process.exit(0);
