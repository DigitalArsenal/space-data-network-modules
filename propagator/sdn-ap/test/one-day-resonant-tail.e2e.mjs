#!/usr/bin/env node
// E2E (stack #434, SPEC 6.1 and 16.2): the one-day class's resonant tail. Through 0.6.18 that class's rates carried the
// resonant gravity of degrees 2 to 4 only (SPEC 6.1's 27 terms), and the output table drops every term slower than 0.045 n,
// so degree 5 and up was carried nowhere. On a geostationary set each missing term is a constant along-track acceleration
// whose size and sign follow the longitude, mostly through EGM2008's (5,5), (5,3) and (5,1).
// Model truth: test/lib/heo-model-truth.mjs (FFM 2.3.0, named below by its SHA-256; DE440 Sun and Moon, no radiation
// pressure, no drag, zero EOP, RK78 1e-12 and 300 s); made-up sets at 2026-10-29 00:00 UTC; a 72 h fit; 7 days flown on a
// 1 h grid; whole-day 3D RMS. Each set is flown twice: EGM2008 20 x 20 on both sides (AP FORCES 20,20) and 4 x 4 on both
// sides (AP FORCES 4,0, where no tail is built and the class's own terms reach degree 4). The two differ only by what the
// field's degrees 5 to 20 do and by how AP carries them.
//   - geostationary: n 1.0027379 rev/day, e 0.0002, i 1.5 deg, argument of perigee 0, the node placed so the set sits
//     at longitudes 0, 30, ..., 330 deg;
//   - inclined geosynchronous: i 55 deg, e 0.003 and 0.075, argument of perigee 270, ascending node at longitudes 0, 60,
//     ..., 300 deg.
// Asserted: at every set the 20 x 20 day-7 whole-day 3D RMS within 0.5 m of the same set's 4 x 4 one. Measured 2026-11-10:
// within 0.05 m at every set; 0.6.15 (no tail) 16.9 to 136.1 m at 20 x 20 against 8.4 to 11.0 m at 4 x 4 (geostationary)
// and up to 30 m from the 4 x 4 level (inclined). What is left at 4 x 4 (7 to 8 m cross-track on geostationary sets, up to
// 26 m on inclined ones) is AP's analytic Moon, stack #446 (test/one-day-moon-floor.e2e.mjs, a known defect).
//   node test/one-day-resonant-tail.e2e.mjs
import {requireTruth} from './lib/ffm-truth.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';
import {reproduceConformance} from './lib/conformance-step.mjs';
// the bound's truth: FFM 2.3.0 (propagator/ffm/dist/isomorphic/module.wasm); another build is refused
const FFM_SHA256 = 'ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934';
requireTruth(FFM_SHA256);
const bound = 0.5;
// Greenwich mean sidereal time at the harness's epoch (IAU 1982; it only places the sets in longitude)
const jd = Date.parse('2026-10-29T00:00:00Z') / 86400000 + 2440587.5;
const gmst = (((280.46061837 + 360.98564736629 * (jd - 2451545.0)) % 360) + 360) % 360;
const sets = [
  ...Array.from({length: 12}, (_, k) => ({kind: 'geostationary', lon: 30 * k, n: 1.0027379, e: 0.0002, i: 1.5, argp: 0})),
  ...[0.003, 0.075].flatMap((e) => Array.from({length: 6}, (_, k) => ({kind: 'inclined geosynchronous', lon: 60 * k, n: 1.0027379, e, i: 55, argp: 270}))),
];
let failed = 0;
for (const s of sets) {
  const base = {n: s.n, e: s.e, i: s.i, raan: (((s.lon + gmst) % 360) + 360) % 360, argp: s.argp, ma: 0, drag: false, hourly: true, gridMinutes: 60};
  const full = await runModelTruth({...base, name: `${s.kind} ${s.lon} e ${s.e} 20x20`, field: [20, 20], forces: [20, 20]});
  const four = await runModelTruth({...base, name: `${s.kind} ${s.lon} e ${s.e} 4x4`, field: [4, 4], forces: [4, 0]});
  if (full.ffmSha256 !== FFM_SHA256 || four.ffmSha256 !== FFM_SHA256) throw new Error('the truth was not flown by the named FFM build');
  const a = full.wholeDay[7], b = four.wholeDay[7], d = a.e - b.e;
  console.log(JSON.stringify({set: s, day5Meters: {field20: +full.wholeDay[5].e.toFixed(2), field4: +four.wholeDay[5].e.toFixed(2)},
    day7Meters: {field20: +a.e.toFixed(2), field4: +b.e.toFixed(2), alongTrack20: +a.t.toFixed(2), crossTrack20: +a.n.toFixed(2)}, differenceMeters: +d.toFixed(3)}));
  if (!(Math.abs(d) <= bound)) {
    console.error(`FAIL ${s.kind} longitude ${s.lon} e ${s.e}: day-7 ${a.e.toFixed(2)} m at 20 x 20 against ${b.e.toFixed(2)} m at 4 x 4 (more than ${bound} m apart: the one-day class misses resonant gravity of degree 5 and up, #434)`);
    failed++;
  }
}
if (failed) process.exit(1);
reproduceConformance();
console.log('one-day resonant tail E2E: PASS');
process.exit(0);
