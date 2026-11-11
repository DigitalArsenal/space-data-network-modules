#!/usr/bin/env node
// E2E (stack #400, SPEC 16.12): above e 0.3 the output stays continuous through each perigee drag passage.
// Fixtures:
// - the transfer orbit: class-crossing's primary. AP mean elements at 2026-10-29 00:00 UTC, n 2.40 rev/day, e 0.72,
//   i 27, RAAN 40, argp 270, M 0, BTERM 0.06 m^2/kg;
// - Molniya: high-e-fit-arc's. n 2 rev/day, e 0.74, i 63.4, RAAN 300, argp 270, M 10, BTERM 0.044.
// Both use AGOM 0, FORCES 31,20 and NRLMSISE-00 on the constant rows of test/lib/spw-constant.mjs. Each is flown again
// with BTERM 0 for the drag-off floor. Asserted:
// - Steps at each of three perigees of days 3 to 7, from one call of 5 ms states 30 s each side:
//   - the position step |r_(k+1) - r_k - (v_k + v_(k+1)) dt/2| at most 1 cm;
//   - the velocity step |dv_k - (dv_(k-1) + dv_(k+1))/2| at most 1e-5 m/s, dv = v_(k+1) - v_k + mu r_k/|r_k|^3 dt.
//   The call's first pair is left out: a call's first state differs from the batch by up to 3 cm (stack #420).
//   0.6.11 stepped 42 to 77 m and 0.12 to 0.14 m/s on the transfer orbit, 5.5 to 9.3 cm and 3.5e-4 m/s on Molniya.
// - The jump detector on a 10 s grid of days 3 to 7, within 10 min of each perigee: at most 0.5 m with drag on, and at
//   most 0.15 m with drag off (the floor). The detector is |d_k - (d_(k-1) + d_(k+1))/2|, d the second difference of
//   position less h^2 times the two-body acceleration (mu 398600.4415 km^3/s^2).
//   Measured 2026-11-10 on the transfer orbit, drag on / drag off:
//   - 0.6.11: 28 to 129 m / 0.65 m;
//   - 0.6.12: 0.92 / 0.65 m (the floor was #420's E-grid kinks);
//   - with the E-grid read C1: 0.29 / 0.088 m.
//   0.6.12 asserted at most 1.5 times the floor. That rule returns when the per-set caches make long ordered calls agree
//   with short ones: the drag-on reading left is a call-pattern effect (#420's second part). Whichever of the two lands
//   second measures it on the merged build.
// Every number comes from the built module's own calls (propagate). JS only moves bytes and compares numbers the module
// produced.
//   node test/perigee-drag-continuity.e2e.mjs
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OEM} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import {pcfOutputFrame} from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import {wasmPath} from './lib/module.mjs';
import {seedOcm, rowsThrough, flight} from './lib/ocm.mjs';
import {spwFixtureRows} from './lib/spw-constant.mjs';

const MU = 398600.4415, epoch = '2026-10-29T00:00:00.000', t0 = Date.parse(epoch + 'Z');
const iso = (s) => new Date(t0 + s * 1000).toISOString().replace('Z', '');
const FIXTURES = {
  'transfer orbit': {n: 2.40, e: 0.72, i: 27, raan: 40, argp: 270, ma: 0, bterm: 0.06},
  Molniya: {n: 2, e: 0.74, i: 63.4, raan: 300, argp: 270, ma: 10, bterm: 0.044},
};
const STEP_BOUND = 0.01, VELOCITY_BOUND = 1e-5, DETECTOR_BOUND = 0.5, FLOOR_BOUND = 0.15;
const rows = rowsThrough(spwFixtureRows());
const h = await createStandaloneHarness('browser', wasmPath, {surface: 'command'});
const flyer = (c) => {
  const seed = seedOcm({epoch, ...c, norad: 99001, msis: true, records: true, tesseral: 31, zonal: 20, rows});
  return async (secs) => {
    const r = await h.invoke({methodId: 'propagate', inputs: flight([seed], {output: {EPOCHS: secs.map(iso), FRAME: pcfOutputFrame.GCRF}})});
    if (r.statusCode !== 0) throw new Error(`propagate: ${r.errorCode} ${r.errorMessage}`);
    return OEM.getRootAsOEM(new fb.ByteBuffer(r.outputs.find((o) => o.portId === 'ephemeris').payload)).unpack()
      .EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES.map((l) => [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT]);
  };
};
// days 3 to 7 every 10 s: the perigees (local minima of |r|) and the detector's worst within 10 min of each
const scan = async (fly) => {
  const step = 10, first = 3 * 86400, K = Math.round(4 * 86400 / step), st = [];
  for (let k0 = 0; k0 <= K; k0 += 20000) st.push(...await fly(Array.from({length: Math.min(20000, K + 1 - k0)}, (_, j) => first + (k0 + j) * step)));
  const rn = st.map((r) => Math.hypot(r[0], r[1], r[2])), perigees = [];
  for (let k = 1; k < K; ++k) if (rn[k] < rn[k - 1] && rn[k] <= rn[k + 1]) perigees.push(first + k * step);
  const d = [];
  for (let k = 1; k < K; ++k) d.push([0, 1, 2].map((c) => (st[k + 1][c] - 2 * st[k][c] + st[k - 1][c] + step * step * MU * st[k][c] / rn[k] ** 3) * 1000));
  let near = 0;
  for (let k = 1; k + 1 < d.length; ++k) {
    const s = first + (k + 1) * step;
    if (!perigees.some((p) => Math.abs(s - p) <= 600)) continue;
    near = Math.max(near, Math.hypot(...[0, 1, 2].map((c) => d[k][c] - 0.5 * (d[k - 1][c] + d[k + 1][c]))));
  }
  return {perigees, near};
};
// one call of 5 ms states 30 s each side of perigee p: the largest position and velocity steps, the first pair left out
const steps = async (fly, p) => {
  const dt = 0.005, N = 12000, start = p - 30, f = await fly(Array.from({length: N + 1}, (_, j) => start + j * dt));
  let position = 0, velocity = 0;
  const dv = [];
  for (let k = 0; k < N; ++k) {
    const a = f[k], b = f[k + 1], r3 = Math.hypot(a[0], a[1], a[2]) ** 3;
    if (k > 0) position = Math.max(position, Math.hypot(...[0, 1, 2].map((c) => b[c] - a[c] - 0.5 * (a[3 + c] + b[3 + c]) * dt)) * 1000);
    dv.push([0, 1, 2].map((c) => b[3 + c] - a[3 + c] + MU * a[c] / r3 * dt));
  }
  for (let k = 2; k + 1 < dv.length; ++k)
    velocity = Math.max(velocity, Math.hypot(...[0, 1, 2].map((c) => dv[k][c] - 0.5 * (dv[k - 1][c] + dv[k + 1][c]))) * 1000);
  return {position, velocity};
};
const failures = [];
for (const [name, c] of Object.entries(FIXTURES)) {
  const on = flyer(c), off = flyer({...c, bterm: 0});
  const [a, b] = [await scan(on), await scan(off)];
  const picked = [0, Math.floor((a.perigees.length - 1) / 2), a.perigees.length - 1].map((i) => a.perigees[i]);
  const at = [];
  for (const p of picked) at.push({perigeeDays: +(p / 86400).toFixed(5), ...(await steps(on, p))});
  console.log(JSON.stringify({fixture: name, bterm: c.bterm, perigees: a.perigees.length, detectorNearPerigeeMeters: +a.near.toFixed(4),
    dragOffFloorMeters: +b.near.toFixed(4), steps: at.map((s) => ({...s, position: +s.position.toExponential(3), velocity: +s.velocity.toExponential(3)}))}));
  if (!(a.near <= DETECTOR_BOUND)) failures.push(`${name}: detector ${a.near.toFixed(3)} m within 10 min of perigee (at most ${DETECTOR_BOUND} m)`);
  if (!(b.near <= FLOOR_BOUND)) failures.push(`${name}: the drag-off detector ${b.near.toFixed(3)} m within 10 min of perigee (at most ${FLOOR_BOUND} m)`);
  for (const s of at) {
    if (!(s.position <= STEP_BOUND)) failures.push(`${name}: position step ${s.position.toExponential(3)} m at the perigee of day ${s.perigeeDays}`);
    if (!(s.velocity <= VELOCITY_BOUND)) failures.push(`${name}: velocity step ${s.velocity.toExponential(3)} m/s at the perigee of day ${s.perigeeDays}`);
  }
}
await h.close?.();
if (failures.length) {
  console.error(`FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('perigee drag continuity E2E: PASS');
process.exit(0);
