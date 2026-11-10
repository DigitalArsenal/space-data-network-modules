#!/usr/bin/env node
// E2E (issue 316, SPEC 18): the carried forecast's interpolation bound per orbit class. For each class of SPEC 18 (low
// orbit at 300, 500, 830 and 1,336 km, MEO, GEO, inclined geosynchronous, a transfer orbit at e 0.72, Molniya, a
// THEMIS-like orbit at e 0.82 and a TESS-like orbit of 13.7 days), a forecast made by the module (a seeded set flown in
// GCRF at the class's step, positions only: an analytic theory's velocity is not its position's derivative) is fitted
// with OUTPUT.START_TIME to STOP_TIME over its whole span; the record is then flown at times between the states (every
// 10 s, offset from the grid) and compared with the seed flown at the same times; and the record's own states at the
// step (positions and velocities that agree) are fitted again and that record compared with the first:
// - in GCRF and in TEME, the largest position error is under 1 cm (SPEC 18's bound) on both paths, and the velocity
//   error under 1 mm/s where velocities come in (the first record, built from an analytic theory's positions to 1 mm/s
//   in velocity, is not smooth to 0.1 mm/s on the step's scale: the referee's 0.1 mm/s is carried-compression's, on
//   numerical forecasts);
// - the record is the same as the plain fit's but for POLYNOMIAL_POSITION_RECORDS, TRAJ_TYPE POLYNOMIAL_POS, TRAJ_BASIS
//   PREDICTED, the COMMENT lines on the forecast and FIT_STATISTICS.PCF_CID (its $PCF has OUTPUT): the theory set is
//   fitted as without them;
// - the frame of the carried forecast (the module's output matrix, made orthonormal) is within 1e-12 rad of the exact
//   chain (ERFA, GMST82 unrounded) over 30 days at 7-minute steps (sdnap_carried_frame_error).
// Prints the bytes per object-day and the numbers (coefficients) per object-day of each class.
// JS only moves bytes and compares numbers the module produced.
//   node test/carried-interpolation.e2e.mjs
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { wasmPath } from "./lib/module.mjs";
import { CLASSES, harness, carriedRecord, hermiteRecord, fly, ocmOf, dist } from "./lib/carried.mjs";

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const only = process.argv.slice(2);

// the frame bound
{
  const d = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
  let worst = 0;
  for (let k = 0; k < (30 * 1440) / 7; k++) {
    const f = (k * 7) / 1440;
    worst = Math.max(worst, d.instance.exports.sdnap_carried_frame_error(2461328.5 + Math.floor(f), f - Math.floor(f)));
  }
  check(worst < 1e-12, `frame: the carried matrix is ${worst} rad from the exact chain`);
  console.log(`frame: the carried matrix within ${worst.toExponential(2)} rad of the exact chain over 30 days`);
}

const h = await harness();
const rows = [];
for (const c of CLASSES) {
  if (only.length && !only.some((n) => c.name.includes(n))) continue;
  const rec = await carriedRecord(h, c);
  const carried = ocmOf(rec.ocm), plain = ocmOf(rec.plain);
  const segs = carried.POLYNOMIAL_POSITION_RECORDS;
  check(segs.length > 0 && carried.TRAJ_TYPE === 2 && carried.TRAJ_BASIS === 1, `${c.name}: no carried forecast in the record`);
  // the set fitted as without the forecast: everything but the forecast's fields and COMMENT lines
  const strip = (o) => { const t = JSON.parse(JSON.stringify(o, (k, v) => (typeof v === "bigint" ? String(v) : v)));
    delete t.POLYNOMIAL_POSITION_RECORDS; delete t.TRAJ_TYPE; delete t.TRAJ_BASIS; delete t.ORBIT_DETERMINATION.FIT_STATISTICS.PCF_CID;
    delete t.TRAJECTORY_BLOCKS; delete t.METADATA.START_TIME; delete t.METADATA.STOP_TIME;
    t.ORBIT_DETERMINATION.COMMENT = t.ORBIT_DETERMINATION.COMMENT.filter((l) => !l.startsWith("carried")); return JSON.stringify(t); };
  check(strip(carried) === strip(plain), `${c.name}: the record differs from the plain fit beyond the carried forecast`);
  // positions (the Lagrange path) against the seed; then the record's own states (velocities that agree with the
  // positions) through a second fit (the Hermite path) against the first record, velocity included
  const second = await hermiteRecord(h, c, rec.ocm, rec.span, c.step);
  const said = (o) => ocmOf(o).ORBIT_DETERMINATION.COMMENT.find((l) => l.startsWith("carried forecast:")) ?? "";
  // the theory's velocities miss their positions' derivative by 20 to 70 mm/s in low orbit and on eccentric orbits
  if (c.a < 8000 || c.e > 0.5) check(said(rec.ocm).includes("8-node Lagrange"), `${c.name}: the theory's states (velocities not their positions' derivative) were not built from positions: ${said(rec.ocm)}`);
  if (c.name === "LEO 500 km") check(said(second.ocm).includes("4-node Hermite"), `${c.name}: the record's own states were not built with their velocities: ${said(second.ocm)}`);
  const row = { name: c.name, step: c.step, days: c.days, segments: segs.length, coefficients: segs[0].NUM_COEFFICIENTS,
    bytesPerDay: Math.round((rec.ocm.length - rec.plain.length) / c.days), numbersPerDay: Math.round(segs.reduce((a, s) => a + 3 * s.NUM_COEFFICIENTS, 0) / c.days) };
  for (const [frameName, frame] of [["GCRF", pcfOutputFrame.GCRF], ["TEME", pcfOutputFrame.TEME]]) {
    const truth = await fly(h, rec.seed, rec.fine, frame);
    const got = await fly(h, rec.ocm, rec.fine, frame);
    const again = await fly(h, second.ocm, rec.fine, frame);
    // the forecast is given in TEME and both flights turn it to GCRF by the same output matrix: 1 cm in both
    const allowance = () => 1e-5;
    let worst = 0, at = 0, worst2 = 0, worstV2 = 0, over = 0;
    for (let k = 0; k < truth.length; k++) {
      const e = dist(got[k].r, truth[k].r);
      if (e > worst) { worst = e; at = truth[k].t; }
      over = Math.max(over, e / allowance(truth[k].r));
      if (truth[k].t < second.inner[0] || truth[k].t > second.inner[1]) continue;
      worst2 = Math.max(worst2, dist(again[k].r, got[k].r));
      worstV2 = Math.max(worstV2, dist(again[k].v, got[k].v));
    }
    check(over < 1, `${c.name} ${frameName}: position error ${(worst * 1e6).toFixed(3)} mm at ${at} s, over 1 cm (positions in)`);
    check(worst2 < 1e-5, `${c.name} ${frameName}: position error ${(worst2 * 1e6).toFixed(3)} mm, over 1 cm (positions and velocities in)`);
    check(worstV2 < 1e-6, `${c.name} ${frameName}: velocity error ${(worstV2 * 1e6).toFixed(4)} mm/s, over 1 mm/s (positions and velocities in)`);
    row[`${frameName}mm`] = +(worst * 1e6).toFixed(3);
    row[`${frameName}mm2`] = +(worst2 * 1e6).toFixed(3);
    row[`${frameName}mmS2`] = +(worstV2 * 1e6).toFixed(4);
  }
  rows.push(row);
}
console.table(rows);
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.log(`CARRIED-INTERPOLATION FAIL: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`CARRIED-INTERPOLATION PASS: ${rows.length} orbit classes within 1 cm in GCRF and TEME, the frame within 1e-12 rad`);
process.exit(0);
