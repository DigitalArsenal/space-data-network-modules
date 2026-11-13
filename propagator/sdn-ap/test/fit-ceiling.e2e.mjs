#!/usr/bin/env node
// The AP fit identity reference is the fixed added-zonal-term artifact at 3a5fb74c: the added terms move the low-
// orbit fit by 7.622102 m / 8.557788 mm/s when both fits fly on this build at daily epochs over seven days; every
// bound is retained.
// E2E (stack #479, #541; SPEC 12.1, the iteration ceiling): a pass of `fit` ends when it converges, under a ceiling of
// 1,000 iterations where the fit solves no drag term (the set above the drag, or a drag term its prior holds) and 40 where it
// solves one; a record whose fit ended at its ceiling states CONVERGED false and says so in its OD COMMENT, and
// sdnap_fit_ceiling_met counts the pass. Each case's truth is FFM (named below by its SHA-256) flown from AP's own seeded
// GCRF state, EGM2008 70 x 70; AP is fitted to the truth's states every 300 s over 120 h (72 to 192 h after the seed, the
// catalog's span) on this build and on 0.6.43 (git, modules 5f55f314, its SHA-256 checked), and the two records compared:
// - above the drag (e 0.9, perigee 10,000 km, i 55; the Sun and Moon on both sides; the drag term solved under the default
//   prior, radiation held at 0): converged on both builds; MEAN_ELEMENTS, FIT_STATISTICS and the OD COMMENT field for field
//   the same (only the producer's version differs); no ceiling line; both counters 0;
// - under the drag, a drag term solved (800 km, e 0, i 55; a drag truth, NRLMSISE-00 at constant weather, B 0.005, with an
//   in-track impulse of 0.5 m/s at 96 h, inside the span, that no set follows; 176 iterations in all over its passes on
//   0.6.43): MEAN_ELEMENTS, FIT_STATISTICS and the OD COMMENT field for field 0.6.43's (a drag fit keeps 40). Four of its
//   earlier passes end at 40 and the counter reads them (which 1: 4); its last pass converges, so the record states
//   CONVERGED true and carries no ceiling line;
// - the counter: a raw fit (sdnap_fit) stopped by its caller's own ceiling of 2 iterations is counted once under "any other
//   ceiling" (which 1); at the default ceiling the same fit converges and is not counted. The counter is the instance's
//   own: after such a pass it reads 1 on the instance that ran the fit and 0 on a fresh one, so the invoked fits are run
//   and read on the direct surface (the command surface instantiates the module afresh for every invoke).
// Not covered by a committed test: the OD COMMENT's ceiling line on a fit whose last pass ends at 40. No model-truth drag fit
// tried here ends there (each converged in its last pass); the cases that do are fits of real data, which are not committed:
// nine 72 h fits of laser-ranged spheres (stack #541), and 43 of 715 synthetic catalog fits of the 0.6.38 census at
// perigees of 200 to 400 km (stack #567). One of the synthetic ones is reproduced from the experiments repository by
//   node experiments/synthetic-orbits/run.mjs --modules-commit <commit> --modules-root <modules checkout>
//     --fit forecast-span --only grid-hp200-e0.3-i70
// (on 0.6.38 its catalog fit ended at 40, 159 iterations in all); the row holds the record, whose FIT_STATISTICS and OD
// COMMENT say how it ended: on 0.6.44 the OD COMMENT holds "fit: not converged; the last pass ended at its ceiling of 40
// iterations with the cost still falling".
//   node test/fit-ceiling.e2e.mjs
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
import { wasmPath, packageRoot, openModule, elementRows, THEORY } from './lib/module.mjs';
import { seedOcm, rowsThrough, flight, spwStream, ocmOf } from './lib/ocm.mjs';
import { configuration, prior, pcfPriorForm } from './lib/pcf.mjs';
import { spwConstantText } from './lib/spw-constant.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // FFM 2.3.0 (modules 48a00fd6)
const BEFORE = { version: '0.6.48', commit: '3a5fb74c8e12f825160eea58624dbc85a2cbacc5', sha256: 'b2de5af7e03753e57aebf781c49c824552706a16c563ca60b1dbb71d1a2358c6' };
const CASES = [
  // above the drag: on 0.6.43 converged in 11 iterations, no pass at a ceiling
  { name: 'above the drag: e 0.9, perigee 10,000 km, i 55, the Sun and Moon', epoch: '2026-02-20T00:00:00.000', n: 0.1309803096, e: 0.9, i: 55, raan: 39.8, argp: 61.2, ma: 150.9,
    bodies: true, truthB: 0, burnKms: 0, met: [0, 0] },
  // under the drag, across an impulse: on 0.6.43 176 iterations in all over its passes; four earlier passes end at 40,
  // the last converges
  { name: 'under the drag: 800 km, e 0, i 55, an in-track impulse of 0.5 m/s inside the span', epoch: '2026-04-21T00:00:00.000', n: 14.2752968371, e: 0, i: 55, raan: 123, argp: 190.5, ma: 85.9,
    bodies: false, truthB: 0.005, burnKms: 0.0005, met: [0, 4] },
];
const DAY = 864e5, iso = (ms) => new Date(ms).toISOString().replace('Z', '');
const kernel = fs.readFileSync(new URL('../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const beforeBytes = execFileSync('git', ['-C', packageRoot, 'show', `${BEFORE.commit}:propagator/sdn-ap/dist/isomorphic/module.wasm`], { maxBuffer: 1 << 26 });
assert.equal(sha256(beforeBytes), BEFORE.sha256, `sdn-ap ${BEFORE.version} at ${BEFORE.commit.slice(0, 9)}`);
const beforePath = path.join(scratchTemp('sdn-ap-fit-ceiling-'), `sdn-ap-${BEFORE.version}.wasm`);
fs.writeFileSync(beforePath, beforeBytes);
// the direct surface: each invoke runs on the instance whose exports are read (the command surface instantiates the
// module afresh for every invoke, so a counter read from `now.instance` after one would be another instance's)
const now = await createStandaloneHarness('browser', wasmPath, { surface: 'direct' });
const was = await createStandaloneHarness('browser', beforePath, { surface: 'direct' });
const ffm = await createStandaloneHarness('browser', ffmPath, { surface: 'command' });
const x = now.instance?.exports;
assert.ok(x?.sdnap_fit_ceiling_met, 'this build exports sdnap_fit_ceiling_met');
const type = (n) => ({ schemaName: `${n}.fbs`, fileIdentifier: `$${n}`, rootTypeName: n });
const results = [];
for (const c of CASES) {
  const t0 = Date.parse(c.epoch + 'Z'), jd = jdOf(c.epoch), jd0 = jd.whole + jd.frac, mjd0 = Math.floor(jd0 - 2400000.5);
  const rows = rowsThrough(JSON.parse(spwConstantText(c.epoch.slice(0, 10), 45)));
  const seed = seedOcm({ epoch: c.epoch, n: c.n, e: c.e, i: c.i, raan: c.raan, argp: c.argp, ma: c.ma, bterm: c.truthB, agom: 0, norad: 99001, msis: c.truthB > 0, records: true, tesseral: 31, zonal: 20, rows });
  const start = await now.invoke({ methodId: 'propagate', inputs: flight([seed], { output: { EPOCHS: [c.epoch], FRAME: pcfOutputFrame.GCRF } }) });
  assert.equal(start.statusCode, 0, `${start.errorCode}: ${start.errorMessage}`);
  const s0 = OEM.getRootAsOEM(new fb.ByteBuffer(start.outputs.find((v) => v.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES[0];
  const seconds = [...Array(1441)].map((_, k) => 72 * 3600 + 300 * k);
  checkTruth();
  const params = { epochJD: jd0, epochTimeScale: 'UTC', targetJD: jd0 + 8, targetTimeScale: 'UTC', position: [s0.X, s0.Y, s0.Z], velocity: [s0.X_DOT, s0.Y_DOT, s0.Z_DOT], frame: 'GCRF',
    sampleEpochsJD: seconds.map((s) => ({ jd: jd0 + s / 86400, scale: 'UTC' })),
    forces: { gravityMode: 'EGM2008', maxDegree: 70, maxOrder: 70, thirdBody: c.bodies, srp: false, drag: c.truthB > 0, dragModel: 'NRLMSISE00', massKg: 1000, areaM2: (c.truthB * 1000) / 2.2, cr: 1.0, cd: 2.2 },
    weather: { epochUTCJD: jd0, F107: 150, F107a: 150, Ap: 15, Kp: 3 }, integrator: { tolerance: 1e-12, minStep: 0.01, maxStep: 300 }, ephemerisSource: 'JPL_SPK' };
  if (c.burnKms) params.maneuvers = [{ epochJD: jd0 + 4, epochTimeScale: 'UTC', deltaV: [0, c.burnKms, 0], frame: 'RTN' }];
  const rq = requestFor('propagate', params, kernel);
  rq.inputs.push({ portId: 'earth_orientation', typeRef: TYPE, payload: encodePrw('EARTH_ORIENTATION', makeTable('PRWEarthOrientation', { ROWS: Array.from({ length: 15 }, (_, k) => makeTable('EOP', { DATE: new Date((mjd0 + k - 1 - 40587) * DAY).toISOString(), MJD: mjd0 + k - 1, TAI_MINUS_UTC_SECONDS: 37 })) })) });
  const fr = await ffm.invoke(rq);
  assert.equal(fr.statusCode, 0, `FFM ${fr.errorCode}: ${fr.errorMessage}`);
  const states = decodeResult(fr).samples;
  const lines = states.map((s, k) => Object.assign(new Line(), { EPOCH: iso(t0 + seconds[k] * 1000), X: s.position[0], Y: s.position[1], Z: s.position[2], X_DOT: s.velocity[0], Y_DOT: s.velocity[1], Z_DOT: s.velocity[2] }));
  const block = Object.assign(new Block(), { OBJECT: Object.assign(new CATT(), { NORAD_CAT_ID: 99001, OBJECT_NAME: 'SYNTHETIC' }), CENTER_NAME: 'EARTH', REFERENCE_FRAME: rfm('GCRF'), TIME_SYSTEM: timingStandard.UTC,
    START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH, USEABLE_START_TIME: lines[0].EPOCH, USEABLE_STOP_TIME: lines.at(-1).EPOCH, EPHEMERIS_DATA_LINES: lines });
  const oem = packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [block] }));
  const cfg = configuration({ forces: { EPHEMERIS_SOURCE: '', HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20,
    ATMOSPHERE_MODEL: c.truthB > 0 ? pcfAtmosphereFamily.NRLMSISE00 : pcfAtmosphereFamily.JACCHIA70, WEATHER_SOURCE: pcfWeatherSource.RECORDS }, fit: { SRP_PRIOR: prior(0, 1e-10) } });
  const fitOn = async (h) => {
    const r = await h.invoke({ methodId: 'fit', inputs: [cfg, { portId: 'space_weather', typeRef: type('SPW'), payload: spwStream(rows) }, { portId: 'ephemeris', typeRef: type('OEM'), payload: oem }] });
    assert.equal(r.statusCode, 0, `${c.name}: ${r.errorCode}: ${r.errorMessage}`);
    return ocmOf(r.outputs.find((v) => v.portId === 'elements').payload);
  };
  x.sdnap_fit_ceiling_met(1, 0);
  x.sdnap_fit_ceiling_met(1, 1);
  const a = await fitOn(now);
  const met = [x.sdnap_fit_ceiling_met(0, 0), x.sdnap_fit_ceiling_met(0, 1)];
  const b = await fitOn(was);
  const sa = a.ORBIT_DETERMINATION.FIT_STATISTICS, sb = b.ORBIT_DETERMINATION.FIT_STATISTICS;
  const ca = a.ORBIT_DETERMINATION.COMMENT ?? [], cb = b.ORBIT_DETERMINATION.COMMENT ?? [];
  const row = { case: c.name, iterations: [sa.ITERATIONS, sb.ITERATIONS], converged: [sa.CONVERGED, sb.CONVERGED], ceilingMet: met, comment: ca };
  results.push(row);
  console.log(JSON.stringify({ fitCeiling: row }));
  assert.equal(JSON.stringify(a.MEAN_ELEMENTS), JSON.stringify(b.MEAN_ELEMENTS), `${c.name}: the elements field for field 0.6.48's`);
  assert.equal(JSON.stringify(sa), JSON.stringify(sb), `${c.name}: FIT_STATISTICS field for field 0.6.48's`);
  assert.equal(sa.CONVERGED, true, `${c.name}: CONVERGED ${sa.CONVERGED}`);
  assert.deepEqual(ca, cb, `${c.name}: the OD COMMENT 0.6.48's`);
  assert.ok(!ca.some((l) => l.startsWith('fit: not converged')), `${c.name}: no ceiling line`);
  assert.deepEqual(met, c.met, `${c.name}: the passes at a ceiling (at 1,000; at any other) ${JSON.stringify(c.met)}`);
}
// the counter: one pass of the raw fit (sdnap_fit) stopped by its caller's own ceiling of 2 iterations, on a start off the
// states' set, is counted once under "any other ceiling"; the same fit at the default ceiling converges and is not counted
const m = await openModule(), mx = m.x, mem = () => m.harness.memory.buffer;
const set = { epochWhole: 2461314.5, epochFrac: 0, meanMotion: 15.07, ecc: 0.001, inc: 53, raan: 10, argp: 20, ma: 30, bterm: 0, agom: 0, norad: 90401, theory: THEORY.SGP4XP };
m.init([set]);
const minutes = [...Array(25)].map((_, k) => 60 * k), positions = [];
for (const t of minutes) { const p = m.atMinutes([t]); positions.push(p.x[0], p.y[0], p.z[0]); }
const rowPtr = mx.sdnap_alloc(112), tPtr = mx.sdnap_alloc(8 * minutes.length), rPtr = mx.sdnap_alloc(8 * positions.length), optPtr = mx.sdnap_alloc(56), statsPtr = mx.sdnap_alloc(32);
const rawFit = (maxIterations) => {
  new Uint8Array(mem(), rowPtr, 112).set(elementRows([{ ...set, meanMotion: 15.0705, ma: 30.05 }]));
  new Float64Array(mem(), tPtr, minutes.length).set(minutes);
  new Float64Array(mem(), rPtr, positions.length).set(positions);
  const opt = new DataView(mem(), optPtr, 56);
  for (let k = 0; k < 56; k++) opt.setUint8(k, 0);
  opt.setInt32(4, maxIterations, true);
  mx.sdnap_fit_ceiling_met(1, 0);
  mx.sdnap_fit_ceiling_met(1, 1);
  assert.equal(mx.sdnap_fit(rowPtr, tPtr, rPtr, minutes.length, optPtr, statsPtr), 0, 'sdnap_fit');
  const [status, iterations] = new Float64Array(mem(), statsPtr, 4);
  return { status, iterations, met: [mx.sdnap_fit_ceiling_met(0, 0), mx.sdnap_fit_ceiling_met(0, 1)] };
};
const capped = rawFit(2), free = rawFit(0);
console.log(JSON.stringify({ rawFit: { capped, free } }));
assert.ok(capped.status === 1 && capped.iterations === 2, `the raw fit at a ceiling of 2: status ${capped.status}, ${capped.iterations} iterations`);
assert.deepEqual(capped.met, [0, 1], 'the pass at its caller\'s ceiling counted once, under any other ceiling');
assert.ok(free.status === 0, `the raw fit at the default ceiling converges: status ${free.status}`);
assert.deepEqual(free.met, [0, 0], 'a converged pass is not counted');
// the counter is the instance's own: after a pass at its caller's ceiling it reads non-zero on the instance that ran the
// fit and zero on a fresh one (why the invoked fits above are read on the direct surface)
rawFit(2);
const fresh = await openModule();
const here = [mx.sdnap_fit_ceiling_met(0, 0), mx.sdnap_fit_ceiling_met(0, 1)];
const there = [fresh.x.sdnap_fit_ceiling_met(0, 0), fresh.x.sdnap_fit_ceiling_met(0, 1)];
console.log(JSON.stringify({ counterInstance: { ranTheFit: here, fresh: there } }));
assert.deepEqual(here, [0, 1], 'the counter reads the pass on the instance that ran the fit');
assert.deepEqual(there, [0, 0], 'a fresh instance reads 0');
fresh.destroy();
m.destroy();
await now.close?.();
await was.close?.();
await ffm.close?.();
console.log('fit ceiling E2E: PASS');
process.exit(0);
