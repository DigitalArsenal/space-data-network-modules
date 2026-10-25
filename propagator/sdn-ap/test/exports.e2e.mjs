#!/usr/bin/env node
// E2E (task modules-sdn-ap-element-exports-20261025): the display exports, each against its inverse, so a tool reads
// these quantities from the module and computes none itself.
// - sdnap_frame_to_uvw against sdnap_uvw_to_frame: 200 seeded states and vectors, the round trip within 1e-12 relative.
// - sdnap_osculating_elements against sdnap_insertion_state (osculating a, e, i, RAAN, argp, u in TEME): 200 seeded
//   orbits from LEO to HEO; a, e, i, RAAN and argp back within rounding, the mean anomaly 0 at u = argp (pericenter)
//   and 180 at u = argp + 180 (apocenter).
// - sdnap_mean_elements_at against the set itself: SGP4XP and SDN-AP rows of sdnap_init_elements at their epoch give
//   their own e, i, RAAN, argp and mean anomaly back; an SGP4 row and an unknown row are refused.
// - sdnap_mean_motion_of against sdnap_mean_elements_at: 200 seeded mean a (6,578 to 42,164 km), e and i; the mean
//   motion it gives, set in an SGP4XP and an SDN-AP row, returns a at the epoch within 1e-12 relative; a <= 0 and
//   e outside [0, 1) give NaN.
// JS only moves bytes and compares numbers the module produced.
//   node test/exports.e2e.mjs
import { openModule, THEORY } from "./lib/module.mjs";
import { jdOf } from "./lib/frames.mjs";

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const m = await openModule();
const x = m.x;
const mem = () => m.harness.memory.buffer;
const p = x.sdnap_alloc(256);
const f64 = (off, n) => new Float64Array(mem(), p + off, n);
let seed = 11;
const u = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const angle = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// UVW round trip
{
  let worst = 0;
  for (let k = 0; k < 200; ++k) {
    const r = [7000 * (u() - 0.5), 7000 * (u() - 0.5), 7000 * (u() - 0.5)], v = [8 * (u() - 0.5), 8 * (u() - 0.5), 8 * (u() - 0.5)];
    const uvw = [u() - 0.5, u() - 0.5, u() - 0.5];
    f64(0, 3).set(r); f64(24, 3).set(v); f64(48, 3).set(uvw);
    x.sdnap_uvw_to_frame(p, p + 24, p + 48, p + 72);
    x.sdnap_frame_to_uvw(p, p + 24, p + 72, p + 96);
    const back = Array.from(f64(96, 3)), n = Math.hypot(...uvw);
    worst = Math.max(worst, Math.hypot(back[0] - uvw[0], back[1] - uvw[1], back[2] - uvw[2]) / n);
  }
  console.log(`sdnap_frame_to_uvw against sdnap_uvw_to_frame, 200 cases: worst relative ${worst.toExponential(2)}`);
  check(worst <= 1e-12, `UVW round trip: ${worst}`);
}

// osculating elements round trip
{
  const t = jdOf("2026-10-20T12:00:00.000000");
  let worst = { a: 0, e: 0, ang: 0, m0: 0, m180: 0 };
  for (let k = 0; k < 200; ++k) {
    const a = 6700 + 40000 * u(), e = Math.min(0.9, (k % 4) * 0.25 * u()), i = 1 + 178 * u(), raan = 360 * u(), argp = 360 * u();
    for (const [du, which] of [[0, "m0"], [180, "m180"]]) {
      f64(0, 6).set([a, e, i, raan, argp, (argp + du) % 360]);
      if (x.sdnap_insertion_state(t.whole, t.frac, p, 0, p + 48) !== 0) { failures.push(`insertion state ${k}`); continue; }
      if (x.sdnap_osculating_elements(p + 48, p + 72, p + 96) !== 0) { failures.push(`osculating elements ${k}`); continue; }
      const el = Array.from(f64(96, 6));
      worst.a = Math.max(worst.a, Math.abs(el[0] - a) / a);
      worst.e = Math.max(worst.e, Math.abs(el[1] - e));
      worst.ang = Math.max(worst.ang, angle(el[2], i), angle(el[3], raan), e > 1e-6 ? angle(el[4], argp) : 0);
      worst[which] = Math.max(worst[which], e > 1e-6 ? angle(el[5], du) : 0);
    }
  }
  console.log(`sdnap_osculating_elements against sdnap_insertion_state, 200 orbits: a ${worst.a.toExponential(2)} relative, e ${worst.e.toExponential(2)}, angles ${worst.ang.toExponential(2)} deg, M at pericenter ${worst.m0.toExponential(2)} deg, at apocenter ${worst.m180.toExponential(2)} deg`);
  check(worst.a <= 1e-12 && worst.e <= 1e-10 && worst.ang <= 1e-8 && worst.m0 <= 1e-8 && worst.m180 <= 1e-8, `osculating round trip: ${JSON.stringify(worst)}`);
}

// mean elements of a set at its epoch
{
  const t = jdOf("2026-10-20T12:00:00.000000");
  const sets = [
    { epochWhole: t.whole, epochFrac: t.frac, meanMotion: 15.5, ecc: 0.0012, inc: 51.6, raan: 120, argp: 90, ma: 30, bterm: 0.01, agom: 0.01, norad: 1, theory: THEORY.SGP4XP },
    { epochWhole: t.whole, epochFrac: t.frac, meanMotion: 2.006, ecc: 0.7, inc: 63.4, raan: 300, argp: 270, ma: 10, bterm: 0.0, agom: 0.02, norad: 2, theory: THEORY.SDNAP },
    { epochWhole: t.whole, epochFrac: t.frac, meanMotion: 15.0, ecc: 0.001, inc: 98, raan: 10, argp: 20, ma: 200, bstar: 1e-4, norad: 3, theory: THEORY.SGP4 },
  ];
  m.init(sets);
  for (let k = 0; k < 2; ++k) {
    const st = x.sdnap_mean_elements_at(k, 0, p);
    const el = Array.from(f64(0, 6)), s = sets[k];
    const dang = Math.max(angle(el[2], s.inc), angle(el[3], s.raan), angle(el[4], s.argp), angle(el[5], s.ma));
    const later = x.sdnap_mean_elements_at(k, 1440, p + 48);
    console.log(`sdnap_mean_elements_at, ${k ? "SDN-AP" : "SGP4XP"} set at its epoch: status ${st}, a ${el[0].toFixed(3)} km, e ${el[1]} (set ${s.ecc}), angles within ${dang.toExponential(2)} deg; a day later status ${later}, a ${f64(48, 1)[0].toFixed(3)} km`);
    check(st === 0 && later === 0 && Math.abs(el[1] - s.ecc) <= 1e-12 && dang <= 1e-9 && el[0] > 6378, `mean elements of set ${k}: ${st} ${el}`);
  }
  const sgp4 = x.sdnap_mean_elements_at(2, 0, p), none = x.sdnap_mean_elements_at(9, 0, p);
  console.log(`sdnap_mean_elements_at, an SGP4 row -> ${sgp4}, an unknown row -> ${none}`);
  check(sgp4 !== 0 && none !== 0, `refusals: SGP4 ${sgp4}, unknown ${none}`);
}

// mean motion from a mean semi-major axis, round trip through the sets
{
  const t = jdOf("2026-10-20T12:00:00.000000");
  const cases = Array.from({ length: 200 }, () => {
    const a = 6578 * (42164 / 6578) ** u();
    return { a, e: Math.min(0.7 * u(), 1 - 6578 / a), inc: 180 * u() };  // perigee at 200 km or above
  });
  const sets = [];
  for (const [k, c] of cases.entries())
    for (const theory of [THEORY.SGP4XP, THEORY.SDNAP])
      sets.push({ epochWhole: t.whole, epochFrac: t.frac, meanMotion: x.sdnap_mean_motion_of(c.a, c.e, c.inc), ecc: c.e, inc: c.inc, raan: 40, argp: 70, ma: 10, norad: 100 + k, theory });
  m.init(sets);
  let worst = 0, bad = 0;
  sets.forEach((s, k) => {
    const st = x.sdnap_mean_elements_at(k, 0, p);
    const a = f64(0, 1)[0], want = cases[k >> 1].a;
    if (st !== 0) ++bad;
    else worst = Math.max(worst, Math.abs(a - want) / want);
  });
  const nan = [x.sdnap_mean_motion_of(0, 0, 0), x.sdnap_mean_motion_of(7000, 1, 0), x.sdnap_mean_motion_of(7000, -0.1, 0), x.sdnap_mean_motion_of(7000, 0, NaN)];
  console.log(`sdnap_mean_motion_of against sdnap_mean_elements_at, ${sets.length} sets (SGP4XP and SDN-AP, a 6,578..42,164 km): ${bad} refused, worst a ${worst.toExponential(2)} relative; GEO 42,164 km -> ${x.sdnap_mean_motion_of(42164, 0, 0).toFixed(8)} rev/day`);
  check(bad === 0 && worst <= 1e-12 && nan.every(Number.isNaN), `mean motion round trip: ${bad} refused, worst ${worst}, refusals ${nan}`);
}

x.sdnap_free(p);
console.log(failures.length === 0 ? "\nexports E2E: PASS" : `\nexports E2E: FAIL\n  ${failures.join("\n  ")}`);
m.destroy();
process.exit(failures.length === 0 ? 0 : 1);
