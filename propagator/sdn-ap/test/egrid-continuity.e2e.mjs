#!/usr/bin/env node
// E2E (stack #420, SPEC 16.11): above e 0.3 the first-order tesseral families' grid in the eccentric anomaly is read
// continuously with its slope, so the output has no kinks where its nodes pass.
// Fixtures, drag off (BTERM 0), Sun and Moon on, FORCES 31,20, AGOM 0, epoch 2026-10-29 00:00 UTC:
// - the transfer orbit: class-crossing's primary, n 2.40 rev/day, e 0.72, i 27, RAAN 40, argp 270, M 0;
// - Molniya: high-e-fit-arc's, n 2 rev/day, e 0.74, i 63.4, RAAN 300, argp 270, M 10.
// For each, the first perigee after day 3 (a 10 s scan), then one call of 10 s and one of 1 s states 600 s each side of it.
// The jump detector is |d_k - (d_(k-1) + d_(k+1))/2|, d the second difference of position less h^2 times the two-body
// acceleration (mu 398600.4415 km^3/s^2).
// A kink in the output, a step in its slope, reads about h times the step; smooth content falls as h^4.
// Asserted: at most 0.08 m at 10 s and 5 mm at 1 s.
// Measured 2026-11-10, transfer orbit / Molniya:
// - through 0.6.13, the four-point Lagrange cubic in E: 0.395 / 0.229 m at 10 s and 0.031 / 0.019 m at 1 s, kinks about
//   80 s apart;
// - with the cubic Hermite: 0.032 / 0.022 m and 0.8 / 1.1 mm.
// Every number comes from the built module's own calls (propagate). JS only moves bytes and compares numbers the module
// produced.
//   node test/egrid-continuity.e2e.mjs
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OEM} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import {pcfOutputFrame} from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import {wasmPath} from './lib/module.mjs';
import {seedOcm, flight} from './lib/ocm.mjs';

const MU = 398600.4415, epoch = '2026-10-29T00:00:00.000', t0 = Date.parse(epoch + 'Z');
const iso = (s) => new Date(t0 + s * 1000).toISOString().replace('Z', '');
const FIXTURES = {
  'transfer orbit': {n: 2.40, e: 0.72, i: 27, raan: 40, argp: 270, ma: 0},
  Molniya: {n: 2, e: 0.74, i: 63.4, raan: 300, argp: 270, ma: 10},
};
const BOUND = {10: 0.08, 1: 0.005};
const h = await createStandaloneHarness('browser', wasmPath, {surface: 'command'});
const failures = [];
for (const [name, c] of Object.entries(FIXTURES)) {
  const seed = seedOcm({epoch, ...c, bterm: 0, norad: 99001, msis: false, records: false, tesseral: 31, zonal: 20});
  const fly = async (secs) => {
    const r = await h.invoke({methodId: 'propagate', inputs: flight([seed], {output: {EPOCHS: secs.map(iso), FRAME: pcfOutputFrame.GCRF}})});
    if (r.statusCode !== 0) throw new Error(`propagate: ${r.errorCode} ${r.errorMessage}`);
    return OEM.getRootAsOEM(new fb.ByteBuffer(r.outputs.find((o) => o.portId === 'ephemeris').payload)).unpack()
      .EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES.map((l) => [l.X, l.Y, l.Z]);
  };
  // the first perigee after day 3, to 10 s
  const scanFrom = 3 * 86400, scan = await fly(Array.from({length: Math.round(86400 / c.n / 10) + 2}, (_, j) => scanFrom + 10 * j));
  const rn = scan.map((r) => Math.hypot(...r));
  let k = 1;
  while (!(rn[k] < rn[k - 1] && rn[k] <= rn[k + 1])) ++k;
  const perigee = scanFrom + 10 * k;
  const out = {};
  for (const step of [10, 1]) {
    const s0 = perigee - 600, st = await fly(Array.from({length: Math.round(1200 / step) + 1}, (_, j) => s0 + j * step));
    const d = [];
    for (let q = 1; q < st.length - 1; ++q) {
      const r = st[q], r3 = Math.hypot(...r) ** 3;
      d.push([0, 1, 2].map((z) => (st[q + 1][z] - 2 * r[z] + st[q - 1][z] + step * step * MU * r[z] / r3) * 1000));
    }
    let worst = 0;
    for (let q = 1; q + 1 < d.length; ++q) worst = Math.max(worst, Math.hypot(...[0, 1, 2].map((z) => d[q][z] - 0.5 * (d[q - 1][z] + d[q + 1][z]))));
    out[`${step} s`] = +worst.toExponential(3);
    if (!(worst <= BOUND[step])) failures.push(`${name}: the ${step} s detector reads ${worst.toExponential(3)} m within 600 s of perigee (at most ${BOUND[step]} m)`);
  }
  console.log(JSON.stringify({fixture: name, perigeeDays: +(perigee / 86400).toFixed(4), detectorM: out}));
}
await h.close?.();
if (failures.length) {
  console.error(`FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('E-grid continuity E2E: PASS');
process.exit(0);
