#!/usr/bin/env node
// E2E (stack #550, SPEC 16.11): the output's Kepler solve keeps to one branch through a perigee passage. Where the output's
// corrections move the anomaly far enough that the solve leaves its series for Newton (|dm| / (1 - e cos E) >= 0.004), and
// the mean and the osculating anomaly lie either side of 0 for the seconds of a passage, Newton solves on the warm start's
// branch; through 0.6.36 it solved for the anomaly on the other, 2 pi away, stepped about 4 pi each iteration and left E off
// by up to 3e-3 rad: a block of 7 to 20 s of states 43 to 87 km along the track, on the orbit's own path 5 to 10 s ahead of or
// behind where they belong, at every passage.
// Fixture: low orbit above the switch at the 4:1 commensurability (n 4.0025 rev/day, e 0.5, i 20, RAAN 347.2, argp 232,
// M 57.4; perigee 2,000 km), FORCES 31,20, BTERM 0, AGOM 0, the Sun and Moon on, epoch 2026-04-13 00:00 UTC. Its 4:1
// harmonic (|psi-dot| 0.0021 n) puts the osculating anomaly about 0.003 rad from the mean at perigee.
// The first three perigees after day 1 (a 10 s scan), each at 1 s over 120 s either side. The jump detector is
// |d_k - (d_(k-1) + d_(k+1))/2|, d the second difference of position less h^2 times the two-body acceleration
// (mu 398600.4415 km^3/s^2): a step of x in a state reads about x; smooth content falls as h^4.
// Asserted: at most BOUND_M at every passage, and no output state of the flights took the solve's bisection
// (sdnap_kepler_unconverged 0: Newton or the series solved every one). Measured on 0.6.NN: 0.69, 0.35 and 0.26 mm, 0 states
// unconverged; through 0.6.36: 25.4, 33.0 and 40.1 km at the block's first second, and 66 states of these flights whose
// Newton ended at 30 steps (a build of 0.6.36 with the count alone).
// Every number comes from the built module's own calls (propagate). JS only moves bytes and compares numbers the module
// produced.
//   node test/perigee-kepler-branch.e2e.mjs
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OEM} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import {pcfOutputFrame} from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import {wasmPath} from './lib/module.mjs';
import {seedOcm, flight} from './lib/ocm.mjs';

const MU = 398600.4415, BOUND_M = 1, epoch = '2026-04-13T00:00:00.000', t0 = Date.parse(epoch + 'Z');
const iso = (s) => new Date(t0 + s * 1000).toISOString().replace('Z', '');
const set = {n: 4.0025, e: 0.5, i: 20, raan: 347.2, argp: 232, ma: 57.4};
const h = await createStandaloneHarness('browser', wasmPath, {surface: 'direct'});
const x = h.instance.exports, counted = typeof x.sdnap_kepler_unconverged === 'function';
if (counted) x.sdnap_kepler_unconverged(1, 0);
const seed = seedOcm({epoch, ...set, bterm: 0, norad: 99550, msis: false, records: false, tesseral: 31, zonal: 20});
const fly = async (secs) => {
  const r = await h.invoke({methodId: 'propagate', inputs: flight([seed], {output: {EPOCHS: secs.map(iso), FRAME: pcfOutputFrame.GCRF}})});
  if (r.statusCode !== 0) throw new Error(`propagate: ${r.errorCode} ${r.errorMessage}`);
  return OEM.getRootAsOEM(new fb.ByteBuffer(r.outputs.find((o) => o.portId === 'ephemeris').payload)).unpack()
    .EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES.map((l) => [l.X, l.Y, l.Z]);
};
// the perigees after day 1, to 10 s
const period = 86400 / set.n, scanFrom = 86400;
const scan = await fly(Array.from({length: Math.round((3.2 * period) / 10)}, (_, j) => scanFrom + 10 * j));
const rn = scan.map((r) => Math.hypot(...r)), perigees = [];
for (let k = 1; k + 1 < rn.length && perigees.length < 3; ++k) if (rn[k] < rn[k - 1] && rn[k] <= rn[k + 1]) perigees.push(scanFrom + 10 * k);
const failures = [], rows = [];
if (perigees.length < 3) failures.push(`the scan found ${perigees.length} perigees, not 3`);
for (const perigee of perigees) {
  const s0 = perigee - 120, st = await fly(Array.from({length: 241}, (_, j) => s0 + j));
  const d = [];
  for (let q = 1; q < st.length - 1; ++q) {
    const r = st[q], r3 = Math.hypot(...r) ** 3;
    d.push([0, 1, 2].map((z) => (st[q + 1][z] - 2 * r[z] + st[q - 1][z] + MU * r[z] / r3) * 1000));
  }
  let worst = 0, at = null;
  for (let q = 1; q + 1 < d.length; ++q) {
    const x = Math.hypot(...[0, 1, 2].map((z) => d[q][z] - 0.5 * (d[q - 1][z] + d[q + 1][z])));
    if (x > worst) { worst = x; at = s0 + q + 1 - perigee; }
  }
  rows.push({perigeeH: +(perigee / 3600).toFixed(3), detectorM: +worst.toExponential(3), atSecondsFromPerigee: at});
  if (!(worst <= BOUND_M)) failures.push(`the passage at ${(perigee / 3600).toFixed(3)} h reads ${worst.toExponential(3)} m, ${at} s from perigee (at most ${BOUND_M} m)`);
}
// every state of the flights solved by Newton or the series: none took the bisection
const unconverged = counted ? x.sdnap_kepler_unconverged(0, 0) : null;
if (!counted) failures.push('the build has no sdnap_kepler_unconverged: a solve that does not converge is not counted');
else if (unconverged !== 0) failures.push(`${unconverged} output states took the bisection (Newton did not converge in 30 steps)`);
await h.close?.();
console.log(JSON.stringify({fixture: '4:1, e 0.5, perigee 2,000 km', passages: rows, unconverged}));
if (failures.length) {
  console.error(`FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Perigee Kepler branch E2E: PASS');
process.exit(0);
