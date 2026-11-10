#!/usr/bin/env node
// E2E (issue 316, SPEC 18): where flight switches between the carried forecast and the theory, the jump fit reports
// there, the segments' joins, the covariance, and every refusal by name. One low-orbit record (500 km, one day carried
// of a forecast that reaches 8 minutes past each end):
// - the span is closed: at its first and last instants the record returns the forecast (within 1 cm of it), a
//   millisecond outside them the theory, bit for bit the plain fit's state there;
// - fit's COMMENT states the jump at each end, theory minus forecast, and it is the module's own flights' difference
//   there to 1 mm (the text rounds to 1e-6 km), and the velocity step, their velocities' difference to 0.002 mm/s;
// - at every join of two segments the state is continuous: over +-1 ms the position moves by the velocity times 2 ms
//   to within 0.1 mm (the segments share their end points);
// - a record carrying COVARIANCE_DATA writes the theory's covariance beside the forecast's states, the same lines as
//   the plain record's (version 1);
// - every state is labeled: propagate writes one block whose COMMENT states each run of states' source (SPEC 18.8's
//   grammar, parsed and checked against the lines), CARRIED FORECAST or THEORY, and sdnap_epochs_source_at gives the
//   store's 1 or 0 at the same times;
// - refused by name: OUTPUT with STOP_TIME alone, OUTPUT.EPOCHS or OUTPUT.FRAME on fit (configuration-refused), a
//   window the block does not reach (carry-not-covered), states 120 s apart in low orbit (carry-states-sparse; 60 s
//   passes, carried-compression); records with TRAJ_TYPE other than POLYNOMIAL_POS (carried-type-mismatch), a first
//   segment of a basis other than Chebyshev (carried-basis-unsupported) or with velocity coefficients
//   (carried-velocity-coefficients), on propagate and on load_epochs; an inner segment missing, two inner segments out
//   of order, or one overlapping its neighbors (carried-gap), of another basis or short of coefficients
//   (carried-segment-invalid) when a state first needs it (SPEC 18.5): on propagate by name, from the store as -4; the
//   out-of-order and overlapping records refused the same whichever of their times is asked first;
// - hostile inner segments, the record's bytes edited: a table offset past the buffer's end or wrapping to before its
//   start, a vtable truncated at the buffer's end, a coefficient vector whose length runs past the end. Each record
//   loads; the state in that segment is refused (carried-segment-invalid; -4 from the store); every other segment's
//   state flies as the sound record's (bit for bit on propagate, to 1e-9 km from the store).
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
  // the labels: three blocks (theory, carried, theory) on propagate; the store's codes at the same times
  const labels = carried.map((s) => (s.source ?? "").split(":")[0]);
  check(JSON.stringify(labels) === JSON.stringify(["THEORY", "CARRIED FORECAST", "CARRIED FORECAST", "THEORY"]), `propagate's labels: ${labels.join(", ")}`);
  check(plain.every((s) => s.source == null || s.source === ""), "a record without a forecast writes a label");
  {
    const { createStandaloneHarness } = await import("space-data-module-sdk/testing/isomorphic");
    const { wasmPath } = await import("./lib/module.mjs");
    const { jdOf } = await import("./lib/frames.mjs");
    const d = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
    const x = d.instance.exports, p = x.sdnap_alloc(16);
    const loaded = await d.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: rec.ocm }] });
    check(loaded.statusCode === 0, `load_epochs: ${loaded.errorCode}`);
    const codes = carried.map((s) => { const { whole, frac } = jdOf(s.epoch); x.sdnap_epochs_source_at(whole, frac, 0, 1, p); return new Int32Array(d.memory.buffer, p, 1)[0]; });
    check(JSON.stringify(codes) === "[0,1,1,0]", `the store's labels: ${codes.join(", ")}`);
  }
  // the jump fit states at each end
  const comment = ocmOf(rec.ocm).ORBIT_DETERMINATION.COMMENT;
  for (const [k, which] of [[1, "start"], [2, "stop"]]) {
    const line = comment.find((l) => l.startsWith(`carried forecast ${which}`)) ?? "";
    const m = /theory minus forecast ([\d.]+) km \(radial (-?[\d.]+), in-track (-?[\d.]+), cross-track (-?[\d.]+) km\)/.exec(line);
    check(m && Math.abs(Number(m[1]) - dist(plain[k].r, carried[k].r)) < 1.5e-6, `the ${which} jump stated (${line}) is not the flights' difference ${dist(plain[k].r, carried[k].r)} km`);
    if (m) check(Math.abs(Math.hypot(Number(m[2]), Number(m[3]), Number(m[4])) - Number(m[1])) < 3e-6, `the ${which} jump's components do not make its size: ${line}`);
    // and the velocity step (mm/s), the flights' velocity difference there (TEME)
    const mv = /, velocity ([\d.]+) mm\/s$/.exec(line);
    check(mv && Math.abs(Number(mv[1]) - dist(plain[k].v, carried[k].v) * 1e6) < 2e-3, `the ${which} velocity step stated (${line}) is not the flights' ${dist(plain[k].v, carried[k].v) * 1e6} mm/s`);
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
  check((await fitWith({ STOP_TIME: isoAt(600) })) === "configuration-refused", "OUTPUT.STOP_TIME alone on fit is not refused");
  check((await fitWith({ EPOCHS: [isoAt(0), isoAt(60)] })) === "configuration-refused", "OUTPUT.EPOCHS on fit is not refused");
  check((await fitWith({ START_TIME: isoAt(0), STOP_TIME: isoAt(600), FRAME: pcfOutputFrame.GCRF })) === "configuration-refused", "OUTPUT.FRAME on fit is not refused");
  check((await fitWith({ START_TIME: isoAt(0), STOP_TIME: isoAt(span + 3600) })) === "carry-not-covered", "a window past the block is not refused");
  const sparse = forecastOem(rec.states.filter((_, k) => k % 4 === 0), 12);
  check((await fitWith({ START_TIME: isoAt(0), STOP_TIME: isoAt(span) }, sparse)) === "carry-states-sparse", "states 120 s apart in low orbit are not refused");
}

// refusals at flight: propagate and load_epochs. A record's first and last segments (its span) are read at load; any
// other when a state first needs it (SPEC 18.5): a fault there refuses that state, by name on propagate and as
// ORBPRO_PROP_BAD_INPUT (-4) from the store, and the record's other states fly
{
  const segs = ocmOf(rec.ocm).POLYNOMIAL_POSITION_RECORDS;
  const epoch = Date.parse(`${isoAt(0)}Z`);
  const midOf = (s) => (Date.parse(`${s.EPOCH_MID.slice(0, 19)}Z`) - epoch) / 1000 + Number(`0${s.EPOCH_MID.slice(19)}`);
  const inner = midOf(segs[2]);  // inside the third segment
  const first = isoAt(60);       // inside the first
  const variants = {
    "carried-type-mismatch": [(t) => { t.TRAJ_TYPE = 0; }, first, true],
    "carried-basis-unsupported": [(t) => { t.POLYNOMIAL_POSITION_RECORDS[0].BASIS_TYPE = 1; }, first, true],
    "carried-velocity-coefficients": [(t) => { const p = t.POLYNOMIAL_POSITION_RECORDS[0]; p.HAS_VELOCITY_COEFFICIENTS = true; p.VEL_COEFF_X = p.POS_COEFF_X; p.VEL_COEFF_Y = p.POS_COEFF_Y; p.VEL_COEFF_Z = p.POS_COEFF_Z; }, first, true],
    "carried-gap": [(t) => { t.POLYNOMIAL_POSITION_RECORDS.splice(2, 1); }, isoAt(inner), false],
    "carried-gap (out of order)": [(t) => { const q = t.POLYNOMIAL_POSITION_RECORDS; [q[2], q[3]] = [q[3], q[2]]; }, isoAt(inner), false],
    "carried-gap (overlapping)": [(t) => { t.POLYNOMIAL_POSITION_RECORDS[2].EPOCH_HALF_SPAN *= 1.5; }, isoAt(inner), false],
    "carried-basis-unsupported ": [(t) => { t.POLYNOMIAL_POSITION_RECORDS[2].BASIS_TYPE = 1; }, isoAt(inner), false],
    "carried-segment-invalid": [(t) => { t.POLYNOMIAL_POSITION_RECORDS[2].POS_COEFF_Y = t.POLYNOMIAL_POSITION_RECORDS[2].POS_COEFF_Y.slice(1); }, isoAt(inner), false],
  };
  const { createStandaloneHarness } = await import("space-data-module-sdk/testing/isomorphic");
  const { wasmPath } = await import("./lib/module.mjs");
  const { jdOf } = await import("./lib/frames.mjs");
  const d = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
  const x = d.instance.exports, p = x.sdnap_alloc(64);
  for (const [name, [edit, when, atLoad]] of Object.entries(variants)) {
    const code = name.replace(/ \(.*\)$/, "").trim(), bad = repackOcm(rec.ocm, edit);
    check((await refusal(h, "propagate", flight([bad], { output: { EPOCHS: [when] } }))) === code, `propagate does not refuse ${name} at ${when}`);
    const loaded = await d.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: bad }] });
    if (atLoad) {
      check(loaded.statusCode !== 0 && loaded.errorCode === code, `load_epochs does not refuse ${name}`);
    } else {
      check(loaded.statusCode === 0, `load_epochs refuses ${name}, a fault inside the span it reads as flown`);
      const { whole, frac } = jdOf(when), t0 = jdOf(first);
      check(x.sdnap_epochs_set_at(0, 0, whole, frac, p) === -4, `the store's state at ${when} is not refused (ORBPRO_PROP_BAD_INPUT) for ${name}`);
      check(x.sdnap_epochs_set_at(0, 0, t0.whole, t0.frac, p) === 0, `the store's state at ${first}, in a sound segment, is refused for ${name}`);
      check((await refusal(h, "propagate", flight([bad], { output: { EPOCHS: [first] } }))) === null, `propagate refuses ${first}, in a sound segment, for ${name}`);
      // out of order or overlapping: the store's answers in the sound record's segments 1 to 4 the same asked forward
      // or backward, each from a fresh load (SPEC 18.5: a segment is judged against its neighbors from the bytes alone)
      if (/\(/.test(name)) {
        const times = [1, 2, 3, 4].map((k) => midOf(segs[k]));
        const ask = async (order) => {
          await d.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: bad }] });
          return Object.fromEntries(order.map((t) => { const j = jdOf(isoAt(t)); return [t, x.sdnap_epochs_set_at(0, 0, j.whole, j.frac, p)]; }));
        };
        const fwd = await ask(times), back = await ask([...times].reverse());
        check(times.every((t) => fwd[t] === back[t]) && fwd[inner] === -4, `${name}: the store's answers depend on the order asked: ${JSON.stringify(times.map((t) => [fwd[t], back[t]]))}`);
      }
    }
  }
  // the same record repacked unchanged flies
  check((await refusal(h, "propagate", flight([repackOcm(rec.ocm, () => {})], { output: { EPOCHS: [isoAt(60), isoAt(inner)] } }))) === null, "the record repacked unchanged is refused");

  // hostile inner segments (SPEC 18.5: the $OCM verifier leaves each segment's table to the segment's own verifier):
  // the record's bytes edited in place, its third segment's table offset past the buffer's end, wrapping to before its
  // start, its vtable truncated at the buffer's end, and its x coefficients' vector length running past the end. Each
  // loads; the state inside that segment is refused (carried-segment-invalid on propagate, -4 from the store); a state
  // in every other segment flies bit for bit as the sound record's
  {
    const fb = await import("flatbuffers");
    const { OCM } = await import("spacedatastandards.org/lib/js/OCM/OCM.js");
    const sound = new Uint8Array(rec.ocm);
    const where = (bytes) => {
      const bb = new fb.ByteBuffer(bytes), root = OCM.getRootAsOCM(bb);
      const o = bb.__offset(root.bb_pos, 20);  // POLYNOMIAL_POSITION_RECORDS, the OCM table's ninth field
      const vec = bb.__vector(root.bb_pos + o), elem = vec + 4 * 2, table = elem + bb.readUint32(elem);
      const xo = bb.__offset(table, 12);       // POS_COEFF_X, PPEPositionRecord's fifth field
      return { bb, elem, table, xlen: bb.__vector(table + xo) - 4 };
    };
    const hostile = {
      "table past the end": (b) => { const w = where(b); w.bb.writeUint32(w.elem, b.length - w.elem + 4096); return b; },
      "table before the start": (b) => { const w = where(b); w.bb.writeUint32(w.elem, (2 ** 32 - w.elem - 64) >>> 0); return b; },
      "vtable truncated at the end": (b) => {
        const grown = new Uint8Array(b.length + 2);
        grown.set(b);
        grown.set([0x40, 0x00], b.length);  // a vtable whose size (64) runs 62 bytes past the end
        const w = where(grown);
        w.bb.writeInt32(w.table, w.table - b.length);
        return grown;
      },
      "coefficients past the end": (b) => { const w = where(b); w.bb.writeUint32(w.xlen, 1 << 20); return b; },
    };
    const segs = ocmOf(rec.ocm).POLYNOMIAL_POSITION_RECORDS;
    const epoch = Date.parse(`${isoAt(0)}Z`);
    const mids = segs.map((s) => (Date.parse(`${s.EPOCH_MID.slice(0, 19)}Z`) - epoch) / 1000 + Number(`0${s.EPOCH_MID.slice(19)}`));
    const others = mids.filter((_, k) => k !== 2);
    const good = await fly(h, rec.ocm, others, pcfOutputFrame.TEME);
    const { createStandaloneHarness } = await import("space-data-module-sdk/testing/isomorphic");
    const { wasmPath } = await import("./lib/module.mjs");
    const { jdOf } = await import("./lib/frames.mjs");
    const d = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
    const x = d.instance.exports, p = x.sdnap_alloc(64);
    for (const [name, edit] of Object.entries(hostile)) {
      const bad = edit(new Uint8Array(sound));
      check((await refusal(h, "propagate", flight([bad], { output: { EPOCHS: [isoAt(mids[2])] } }))) === "carried-segment-invalid", `${name}: propagate does not refuse the state in that segment by name`);
      let flown = null;
      try { flown = await fly(h, bad, others, pcfOutputFrame.TEME); } catch (e) { flown = null; check(false, `${name}: propagate refuses the other segments' states: ${e.code}`); }
      if (flown) check(flown.every((s, k) => s.r.every((v, j) => Object.is(v, good[k].r[j])) && s.v.every((v, j) => Object.is(v, good[k].v[j]))), `${name}: another segment's state differs from the sound record's`);
      const loaded = await d.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: bad }] });
      check(loaded.statusCode === 0, `${name}: load_epochs refuses the record (${loaded.errorCode})`);
      if (loaded.statusCode !== 0) continue;
      const at = (t) => { const { whole, frac } = jdOf(isoAt(t)); return x.sdnap_epochs_set_at(0, 0, whole, frac, p); };
      check(at(mids[2]) === -4, `${name}: the store's state in that segment is not -4`);
      check(others.every((t, k) => at(t) === 0 && dist(Array.from(new Float64Array(d.memory.buffer, p, 3)), good[k].r) < 1e-9), `${name}: the store refuses or changes another segment's state`);
    }
  }
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.log(`CARRIED-EDGES FAIL: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("CARRIED-EDGES PASS: the span closed at both ends, the jumps fit states, continuous joins, the theory's covariance, every refusal by name");
process.exit(0);
