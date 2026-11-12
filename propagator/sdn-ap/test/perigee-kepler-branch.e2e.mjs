#!/usr/bin/env node
// E2E (stack #550, SPEC 16.21): AP's osculating Kepler solve keeps to one branch through a perigee passage, and a Newton
// that ends within rounding of its root is solved.
// A. The branch. Where the output's corrections move the anomaly far enough that the solve leaves its series for Newton
//    (|dm / (1 - e cos Ewarm)| >= 0.004), and the mean and the osculating anomaly lie either side of 0 for the seconds of a
//    passage, Newton solves for the anomaly on the warm start's branch. Through 0.6.36 it solved for it on the other, 2 pi
//    away; each step was 2 pi / (1 - e cos E), and after its 30 steps E stood off the root. Two fixtures, the Sun and Moon
//    on, FORCES 31,20:
//    - 4:1: low orbit above the switch at the 4:1 commensurability, n 4.0025 rev/day, e 0.5, i 20, RAAN 347.2, argp 232,
//      M 57.4 (perigee 2,000 km), BTERM 0, AGOM 0, epoch 2026-04-13. Its 4:1 harmonic on the grid puts the osculating
//      anomaly 0.0059 rad from the mean at perigee. The first three perigees after day 1 (a 10 s scan).
//    - e 0.9: n 0.4919684453 rev/day, e 0.9, i 70, RAAN 359.5, argp 245.2, M 287.8 (perigee 400 km), BTERM 0.022, AGOM
//      0.012, the theory's own atmosphere, epoch 2026-08-21: the drag steps at perigee move the anomaly. Every perigee over
//      5 days (a 60 s scan).
//    Each passage at 1 s over 120 s either side. The detector is |d_k - (d_(k-1) + d_(k+1))/2|, d the second difference of
//    position less h^2 times the two-body acceleration (mu 398600.4415 km^3/s^2): half the fourth difference, so one
//    displaced state of x reads 3x and the first or last state of a displaced block 1.5x; smooth content falls as h^4.
//    Asserted: at most BOUND_A at every passage.
// B. The rounding. Off the fast path (the epoch state of a long-period set within 0.02 rad of the equator) Newton stops only at
//    |dE| < 1e-15, and with E between 4 and 2 pi it can cycle between neighboring doubles at the root for all 30 steps;
//    through 0.6.36 the sine and cosine were then left at 0 and 1, a perigee state. Fixture: n 1.2 rev/day, e 0.5, i 0.5,
//    RAAN 40, argp 270, FORCES 31,20, BTERM 0, AGOM 0, epoch 2026-04-13, its state at its epoch for N_B mean anomalies over a
//    turn. The detector is |r_k - (r_(k-1) + r_(k+1))/2| on the radius against the mean anomaly. Asserted: at most BOUND_B,
//    and at least one solve ended within rounding (sdnap_kepler_unconverged 2 above 0: the count reads this build's solves).
// C. Section 8's solve (output_j2_osc, SGP4XP's sets) keeps the warm start's branch too (from 0.6.38; through 0.6.37 it solved
//    for k.m on the other branch for the milliseconds of a passage in which the two lie either side of 0). Fixture: the 4:1
//    orbit's SGP4XP twin (no gravity terms, BTERM 0, AGOM 0.02), the first three perigees after day 1, each at 1 ms over 4 s
//    either side. The detector is each state's distance from the midpoint of its two neighbors (smooth motion reads about
//    3 um). Asserted: at most BOUND_C, and no solve of section 8 ended far from its root (sdnap_kepler_unconverged 1 is 0).
// Over A and B: no solve ended far from its root (sdnap_kepler_unconverged 0 is 0).
// Measured on 0.6.38: A 0.69, 0.35 and 0.26 mm (4:1) and 1.04, 1.26 and 1.70 mm (e 0.9); B 41 m (the smooth radius at the
// perigee's anomalies), 23 solves within rounding; C 2.96, 2.94 and 3.04 um; no solve far from its root. On 0.6.37: A and B as
// on 0.6.38; C 8.2, 10.4 and 12.7 km, 67 solves of section 8 far from their root. Through 0.6.36: A 25.4, 33.0 and 40.1 km
// (4:1) and 408,900 km and 188,000 km at two of the three e 0.9 passages; B 6,140.7 km at M 333.42 deg; no count.
// Every number comes from the built module's own calls (propagate). JS only moves bytes and compares numbers the module
// produced.
//   node test/perigee-kepler-branch.e2e.mjs
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OEM} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import {pcfOutputFrame} from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import {wasmPath} from './lib/module.mjs';
import {seedOcm, flight} from './lib/ocm.mjs';

const MU = 398600.4415, BOUND_A = 0.01, BOUND_B = 500, N_B = 6000, BOUND_C = 0.01;
const h = await createStandaloneHarness('browser', wasmPath, {surface: 'direct'});
const x = h.instance.exports, counted = typeof x.sdnap_kepler_unconverged === 'function';
if (counted) { x.sdnap_kepler_unconverged(1, 0); x.sdnap_kepler_unconverged(1, 2); }
const lines = async (seeds, epochs) => {
  const r = await h.invoke({methodId: 'propagate', inputs: flight(seeds, {output: {EPOCHS: epochs, FRAME: pcfOutputFrame.GCRF}})});
  if (r.statusCode !== 0) throw new Error(`propagate: ${r.errorCode} ${r.errorMessage}`);
  return OEM.getRootAsOEM(new fb.ByteBuffer(r.outputs.find((o) => o.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK
    .map((b) => b.EPHEMERIS_DATA_LINES.map((l) => [l.X, l.Y, l.Z]));
};
const failures = [], report = {};

// A
const FIXTURES = {
  '4:1': {epoch: '2026-04-13T00:00:00.000', set: {n: 4.0025, e: 0.5, i: 20, raan: 347.2, argp: 232, ma: 57.4, bterm: 0, agom: 0}, from: 86400, scanS: 10, passes: 3},
  'e 0.9': {epoch: '2026-08-21T00:00:00.000', set: {n: 0.4919684453, e: 0.9, i: 70, raan: 359.5, argp: 245.2, ma: 287.8, bterm: 0.022, agom: 0.012}, from: 0, scanS: 60, passes: 9},
};
for (const [name, c] of Object.entries(FIXTURES)) {
  const t0 = Date.parse(c.epoch + 'Z'), iso = (s) => new Date(t0 + s * 1000).toISOString().replace('Z', '');
  const seed = seedOcm({epoch: c.epoch, ...c.set, norad: 99550, msis: false, records: false, tesseral: 31, zonal: 20});
  const span = name === '4:1' ? 3.2 * 86400 / c.set.n : 5 * 86400;
  const [scan] = await lines([seed], Array.from({length: Math.round(span / c.scanS)}, (_, j) => iso(c.from + c.scanS * j)));
  const rn = scan.map((r) => Math.hypot(...r)), perigees = [];
  for (let k = 1; k + 1 < rn.length && perigees.length < c.passes; ++k) if (rn[k] < rn[k - 1] && rn[k] <= rn[k + 1]) perigees.push(c.from + c.scanS * k);
  if (perigees.length < (name === '4:1' ? 3 : 2)) failures.push(`${name}: the scan found ${perigees.length} perigees`);
  const rows = [];
  for (const perigee of perigees) {
    const s0 = Math.max(perigee - 120, 1), [st] = await lines([seed], Array.from({length: perigee + 120 - s0 + 1}, (_, j) => iso(s0 + j)));
    const d = [];
    for (let q = 1; q < st.length - 1; ++q) {
      const r = st[q], r3 = Math.hypot(...r) ** 3;
      d.push([0, 1, 2].map((z) => (st[q + 1][z] - 2 * r[z] + st[q - 1][z] + MU * r[z] / r3) * 1000));
    }
    let worst = 0, at = null;
    for (let q = 1; q + 1 < d.length; ++q) {
      const v = Math.hypot(...[0, 1, 2].map((z) => d[q][z] - 0.5 * (d[q - 1][z] + d[q + 1][z])));
      if (v > worst) { worst = v; at = s0 + q + 1 - perigee; }
    }
    rows.push({perigeeH: +(perigee / 3600).toFixed(3), detectorM: +worst.toExponential(3), atSecondsFromPerigee: at});
    if (!(worst <= BOUND_A)) failures.push(`${name}: the passage at ${(perigee / 3600).toFixed(3)} h reads ${worst.toExponential(3)} m, ${at} s from perigee (at most ${BOUND_A} m)`);
  }
  report[name] = rows;
}

// B
{
  const epoch = '2026-04-13T00:00:00.000', r = [];
  for (let k = 0; k < N_B; ++k) {
    const seed = seedOcm({epoch, n: 1.2, e: 0.5, i: 0.5, raan: 40, argp: 270, ma: (360 * k) / N_B, bterm: 0, agom: 0, norad: 99551, tesseral: 31, zonal: 20});
    const [[s]] = await lines([seed], [epoch]);
    r.push(Math.hypot(...s));
  }
  let worst = 0, at = null;
  for (let k = 0; k < N_B; ++k) {
    const v = 1000 * Math.abs(r[k] - 0.5 * (r[(k + N_B - 1) % N_B] + r[(k + 1) % N_B]));
    if (v > worst) { worst = v; at = (360 * k) / N_B; }
  }
  const rounding = counted ? x.sdnap_kepler_unconverged(0, 2) : null;
  report.epochStates = {count: N_B, detectorM: +worst.toFixed(1), atMeanAnomalyDeg: at, endedWithinRounding: rounding};
  if (!(worst <= BOUND_B)) failures.push(`epoch states: the radius detector reads ${worst.toFixed(1)} m at M ${at} deg (at most ${BOUND_B} m)`);
  if (counted && !(rounding > 0)) failures.push('epoch states: no solve ended within rounding of its root (the count reads 0)');
}

// C
{
  if (counted) x.sdnap_kepler_unconverged(1, 1);
  const epoch = '2026-04-13T00:00:00.000', t0 = Date.parse(epoch + 'Z'), iso = (ms) => new Date(t0 + ms).toISOString().replace('Z', '');
  const seed = seedOcm({epoch, n: 4.0025, e: 0.5, i: 20, raan: 347.2, argp: 232, ma: 57.4, bterm: 0, agom: 0.02, norad: 99552});
  const [scan] = await lines([seed], Array.from({length: Math.round((3.2 * 86400) / 4.0025 / 10)}, (_, j) => iso((86400 + 10 * j) * 1000)));
  const rn = scan.map((r) => Math.hypot(...r)), perigees = [];
  for (let k = 1; k + 1 < rn.length && perigees.length < 3; ++k) if (rn[k] < rn[k - 1] && rn[k] <= rn[k + 1]) perigees.push(86400 + 10 * k);
  const rows = [];
  for (const p of perigees) {
    const ms0 = (p - 4) * 1000, [st] = await lines([seed], Array.from({length: 8001}, (_, j) => iso(ms0 + j)));
    let worst = 0, at = null;
    for (let q = 1; q + 1 < st.length; ++q) {
      const v = 1000 * Math.hypot(...[0, 1, 2].map((z) => st[q][z] - 0.5 * (st[q - 1][z] + st[q + 1][z])));
      if (v > worst) { worst = v; at = q - 4000; }
    }
    rows.push({perigeeH: +(p / 3600).toFixed(3), detectorM: +worst.toExponential(3), atMsFromPerigee: at});
    if (!(worst <= BOUND_C)) failures.push(`SGP4XP: the passage at ${(p / 3600).toFixed(3)} h reads ${worst.toExponential(3)} m, ${at} ms from perigee (at most ${BOUND_C} m)`);
  }
  if (perigees.length < 3) failures.push(`SGP4XP: the scan found ${perigees.length} perigees, not 3`);
  const far8 = counted ? x.sdnap_kepler_unconverged(0, 1) : null;
  report.sgp4xp = {passages: rows, endedFarFromRoot: far8};
  if (counted && far8 !== 0) failures.push(`SGP4XP: ${far8} solves of section 8 ended far from their root`);
}

const far = counted ? x.sdnap_kepler_unconverged(0, 0) : null;
report.endedFarFromRoot = far;
if (!counted) failures.push('the build has no sdnap_kepler_unconverged: a solve that does not converge is not counted');
else if (far !== 0) failures.push(`${far} solves ended far from their root and took the bisection`);
await h.close?.();
console.log(JSON.stringify(report));
if (failures.length) {
  console.error(`FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Perigee Kepler branch E2E: PASS');
process.exit(0);
