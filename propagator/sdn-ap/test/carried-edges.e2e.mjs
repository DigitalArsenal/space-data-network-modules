#!/usr/bin/env node
// E2E (issue 316, SPEC 18): where flight switches between the carried forecast and the theory, the jump fit reports
// there, the segments' joins, the covariance, and every refusal by name. One low-orbit record (500 km, one day carried
// of a forecast that reaches 8 minutes past each end):
// - the span is closed: at its first and last instants the record returns the forecast (within 1 cm of it), a
//   millisecond outside them the theory, bit for bit the plain fit's state there;
// - fit's COMMENT states the jump at each end, theory minus forecast, and it is the module's own flights' difference
//   there to 1 m (the text rounds to the meter's thousandth: 1e-6 km);
// - at every join of two segments the state is continuous: over +-1 ms the position moves by the velocity times 2 ms
//   to within 0.1 mm (the segments share their end points);
// - a record carrying COVARIANCE_DATA writes the theory's covariance beside the forecast's states, the same lines as
//   the plain record's (version 1);
// - refused by name: OUTPUT with START_TIME alone, OUTPUT.EPOCHS or OUTPUT.FRAME on fit (configuration-refused), a
//   window the block does not reach (carry-not-covered), states 120 s apart in low orbit (carry-states-sparse); records
//   with a gap between segments (carried-gap), TRAJ_TYPE other than POLYNOMIAL_POS (carried-type-mismatch), a basis
//   other than Chebyshev (carried-basis-unsupported), velocity coefficients (carried-velocity-coefficients), on
//   propagate and on load_epochs.
// JS only moves bytes and compares numbers the module produced.
//   node test/carried-edges.e2e.mjs
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { CLASSES, harness, carriedRecord, fly, ocmOf, dist, isoAt, forecastOem, refusal, call } from "./lib/carried.mjs";
import { T, repackOcm, flight } from "./lib/ocm.mjs";
import { configuration, XP_FORCES } from "./lib/pcf.mjs";

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const h = await harness();
const c = CLASSES.find((q) => q.name === "LEO 500 km");
const rec = await carriedRecord(h, c);
const span = rec.span;

// the span's edges
{
  const times = [-1e-3, 0, span, span + 1e-3];
  const carried = await fly(h, rec.ocm, times, pcfOutputFrame.TEME);
  const plain = await fly(h, rec.plain, times, pcfOutputFrame.TEME);
  const truth = await fly(h, rec.seed, times, pcfOutputFrame.TEME);
  for (const k of [0, 3]) check(carried[k].r.every((v, j) => Object.is(v, plain[k].r[j])) && carried[k].v.every((v, j) => Object.is(v, plain[k].v[j])),
    `${times[k]} s, outside the span: not the theory's state bit for bit`);
  for (const k of [1, 2]) {
    check(dist(carried[k].r, truth[k].r) < 1e-5, `${times[k]} s, the span's ${k === 1 ? "first" : "last"} instant: ${dist(carried[k].r, truth[k].r) * 1e6} mm from the forecast`);
    check(dist(carried[k].r, plain[k].r) > 1e-4, `${times[k]} s: the theory's state, not the forecast (they differ by under 10 cm)`);
  }
  // the jump fit states at each end
  const comment = ocmOf(rec.ocm).ORBIT_DETERMINATION.COMMENT;
  for (const [k, which] of [[1, "start"], [2, "stop"]]) {
    const line = comment.find((l) => l.startsWith(`carried forecast ${which}`)) ?? "";
    const m = /theory minus forecast ([\d.]+) km \(radial (-?[\d.]+), in-track (-?[\d.]+), cross-track (-?[\d.]+) km\)/.exec(line);
    check(m && Math.abs(Number(m[1]) - dist(plain[k].r, carried[k].r)) < 1.5e-6, `the ${which} jump stated (${line}) is not the flights' difference ${dist(plain[k].r, carried[k].r)} km`);
    if (m) check(Math.abs(Math.hypot(Number(m[2]), Number(m[3]), Number(m[4])) - Number(m[1])) < 3e-6, `the ${which} jump's components do not make its size: ${line}`);
  }
}

// the joins
{
  const segs = ocmOf(rec.ocm).POLYNOMIAL_POSITION_RECORDS;
  const epoch = Date.parse(`${isoAt(0)}Z`);
  const joins = segs.slice(0, -1).map((s) => (Date.parse(`${s.EPOCH_MID.slice(0, 19)}Z`) - epoch) / 1000 + Number(`0${s.EPOCH_MID.slice(19)}`) + s.EPOCH_HALF_SPAN);
  const times = joins.flatMap((t) => [t - 1e-3, t, t + 1e-3]);
  const got = await fly(h, rec.ocm, times, pcfOutputFrame.TEME);
  let worst = 0;
  for (let j = 0; j < joins.length; j++) {
    const [a, m, b] = got.slice(3 * j, 3 * j + 3);
    const step = [0, 1, 2].map((q) => b.r[q] - a.r[q] - m.v[q] * 2e-3);
    worst = Math.max(worst, Math.hypot(...step));
  }
  check(joins.length > 2 && worst < 1e-7, `the segments' joins: a step of ${(worst * 1e6).toFixed(4)} mm over 2 ms beyond the velocity's (${joins.length} joins)`);
  console.log(`joins: ${joins.length}, the largest step over 2 ms beyond the velocity's ${(worst * 1e6).toFixed(5)} mm`);
}

// the covariance: the theory's, beside the forecast's states
{
  const o = ocmOf(rec.ocm);
  if (o.COVARIANCE_DATA?.length) {
    const output = { output: { START_TIME: isoAt(600), STOP_TIME: isoAt(1200), STEP_SECONDS: 300 } };
    const a = (await call(h, "propagate", flight([rec.ocm], output)))[0].payload, b = (await call(h, "propagate", flight([rec.plain], output)))[0].payload;
    const { OEM } = await import("spacedatastandards.org/lib/js/OEM/OEM.js");
    const fb = await import("flatbuffers");
    const blk = (p) => OEM.getRootAsOEM(new fb.ByteBuffer(new Uint8Array(p))).unpack().EPHEMERIS_DATA_BLOCK[0];
    const [ca, cb] = [blk(a), blk(b)];
    check(ca.COVARIANCE_MATRIX_LINES.length === 3 && JSON.stringify(ca.COVARIANCE_MATRIX_LINES) === JSON.stringify(cb.COVARIANCE_MATRIX_LINES), "the covariance beside the forecast is not the theory's");
    check(dist([ca.EPHEMERIS_DATA_LINES[1].X, ca.EPHEMERIS_DATA_LINES[1].Y, ca.EPHEMERIS_DATA_LINES[1].Z], [cb.EPHEMERIS_DATA_LINES[1].X, cb.EPHEMERIS_DATA_LINES[1].Y, cb.EPHEMERIS_DATA_LINES[1].Z]) > 1e-4,
      "the states beside the covariance are the theory's, not the forecast's");
  } else {
    failures.push("the fitted record carries no COVARIANCE_DATA: the covariance check did not run");
  }
}

// refusals at fit
{
  const fitWith = (output, oem = rec.oem) => refusal(h, "fit", [{ portId: "ephemeris", typeRef: T("OEM"), payload: oem }, configuration({ theory: "SGP4XP", forces: XP_FORCES, output })]);
  check((await fitWith({ START_TIME: isoAt(0) })) === "configuration-refused", "OUTPUT.START_TIME alone on fit is not refused");
  check((await fitWith({ EPOCHS: [isoAt(0), isoAt(60)] })) === "configuration-refused", "OUTPUT.EPOCHS on fit is not refused");
  check((await fitWith({ START_TIME: isoAt(0), STOP_TIME: isoAt(600), FRAME: pcfOutputFrame.GCRF })) === "configuration-refused", "OUTPUT.FRAME on fit is not refused");
  check((await fitWith({ START_TIME: isoAt(0), STOP_TIME: isoAt(span + 3600) })) === "carry-not-covered", "a window past the block is not refused");
  const sparse = forecastOem(rec.states.filter((_, k) => k % 2 === 0), 12);
  check((await fitWith({ START_TIME: isoAt(0), STOP_TIME: isoAt(span) }, sparse)) === "carry-states-sparse", "states 120 s apart in low orbit are not refused");
}

// refusals at flight: propagate and load_epochs
{
  const variants = {
    "carried-gap": (t) => { t.POLYNOMIAL_POSITION_RECORDS.splice(2, 1); },
    "carried-type-mismatch": (t) => { t.TRAJ_TYPE = 0; },
    "carried-basis-unsupported": (t) => { t.POLYNOMIAL_POSITION_RECORDS[0].BASIS_TYPE = 1; },
    "carried-velocity-coefficients": (t) => { const p = t.POLYNOMIAL_POSITION_RECORDS[0]; p.HAS_VELOCITY_COEFFICIENTS = true; p.VEL_COEFF_X = p.POS_COEFF_X; p.VEL_COEFF_Y = p.POS_COEFF_Y; p.VEL_COEFF_Z = p.POS_COEFF_Z; },
  };
  for (const [code, edit] of Object.entries(variants)) {
    const bad = repackOcm(rec.ocm, edit);
    check((await refusal(h, "propagate", flight([bad], { output: { EPOCHS: [isoAt(60)] } }))) === code, `propagate does not refuse ${code}`);
    check((await refusal(h, "load_epochs", [{ portId: "ocm", typeRef: T("OCM"), payload: bad }])) === code, `load_epochs does not refuse ${code}`);
  }
  // the same record repacked unchanged flies
  check((await refusal(h, "propagate", flight([repackOcm(rec.ocm, () => {})], { output: { EPOCHS: [isoAt(60)] } }))) === null, "the record repacked unchanged is refused");
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.log(`CARRIED-EDGES FAIL: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("CARRIED-EDGES PASS: the span closed at both ends, the jumps fit states, continuous joins, the theory's covariance, every refusal by name");
process.exit(0);
