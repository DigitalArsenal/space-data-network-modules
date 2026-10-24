// normalize_naif_ck and write_naif_ck: NAIF CK type 3 against CSPICE.
//
// READ. The NAIF-published kernels in fixtures/interchange (MSL and InSight) are read by the module with the
// mission's own SCLK kernel and held to fixtures/interchange/naif_ck.reference.txt, which
// tests/reference/ck_reference.py wrote with CSPICE (spiceypy 8.3.0, CSPICE_N0067): the raw words of every
// segment, q2m's C-matrix against CCSDS 504.0-B-2 annex F's matrix of the CCSDS quaternion (they agree to
// 3.3e-16 on all 30 published records), and CSPICE's time for every tick.
//
// WRITE. A kernel this module writes is read back by CSPICE (ckgp, ckgpav through spiceypy) and by the module.
// The CSPICE leg runs wherever spiceypy is found (SPICEYPY_PYTHON, python3, the xval venv) and says so when it
// is not; the committed readback of the kernel below (naif_ck_written.readback.txt) is the same measurement
// taken once, with the kernel's SHA-256, so the claim is checkable without CSPICE too.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "flatbuffers";
import { AEM } from "spacedatastandards.org/lib/js/AEM/AEM.js";

import { buildAem, secondsPastJ2000, syntheticAem, toDegrees } from "./lib/ck_synthetic.mjs";
import { AEM_TYPE, NCD_TYPE, descriptorOnly, frame, harness, input, readNcd, sha256Hex, splitFrame, ncdContainerFormat } from "./lib/ncd_frames.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIX = path.join(root, "fixtures", "interchange");
const ready = fs.existsSync(path.join(root, "dist", "isomorphic", "module.wasm"));
const bytes = (name) => new Uint8Array(fs.readFileSync(path.join(FIX, name)));

const MSL_CLOCK = "MSL_76_SCLKSCET.00019.tsc";
const INSIGHT_CLOCK = "NSY_SCLKSCET.00025.tsc";
const KERNELS = [
  ["msl_surf_rover_tlm_0179_0269_v1.bc", MSL_CLOCK],
  ["msl_ra_straight_v1.bc", MSL_CLOCK],
  ["msl_hga_zero_v1.bc", MSL_CLOCK],
  ["insight_ida_enc_180505_181127_v1.bc", INSIGHT_CLOCK],
];

// --- the CSPICE reference --------------------------------------------------------------------------------
const fromBits = (hex) => Buffer.from(hex, "hex").readDoubleBE(0);
function loadReference() {
  const kernels = new Map();
  let kernel = null;
  let segment = null;
  for (const line of fs.readFileSync(path.join(FIX, "naif_ck.reference.txt"), "utf8").split("\n")) {
    const f = line.split(" ");
    if (f[0] === "KERNEL") { kernel = { name: f[1], clock: f[3], segments: [] }; kernels.set(f[1], kernel); }
    else if (f[0] === "SEGMENT") {
      const m = /^SEGMENT (\d+) \|(.*)\| instrument (-?\d+) frame (-?\d+) type 3 av (\d) records (\d+) intervals (\d+) begin (\d+) end (\d+)$/.exec(line);
      segment = { index: +m[1], name: m[2], instrument: +m[3], frame: +m[4], av: m[5] === "1", records: +m[6], intervals: +m[7], begin: +m[8], end: +m[9], rows: [] };
      kernel.segments.push(segment);
    } else if (f[0] === "RECORD") {
      const hasAv = f[f.indexOf("av") + 1] !== "-";
      const q = f.slice(f.indexOf("q") + 1, f.indexOf("q") + 5).map(fromBits);
      const av = hasAv ? f.slice(f.indexOf("av") + 1, f.indexOf("av") + 4).map(fromBits) : null;
      segment.rows.push({ interval: +f[f.indexOf("interval") + 1], ticks: fromBits(f[f.indexOf("ticks") + 1]), q, av, tt: Number(f[f.indexOf("tt") + 1]), formula: fromBits(f[f.indexOf("formula") + 1]) });
    }
  }
  return kernels;
}

const unpackAem = (payload) => AEM.getSizePrefixedRootAsAEM(new flatbuffers.ByteBuffer(new Uint8Array(payload))).unpack();
const ckRequest = (name, clock, extra = {}, clockExtra = {}) => ({
  methodId: "normalize_naif_ck",
  inputs: [
    input("container", NCD_TYPE, frame(bytes(name), { formatName: "naif-ck", ...extra })),
    input("sclk", NCD_TYPE, frame(bytes(clock), { formatName: "naif-sclk", ...clockExtra })),
  ],
});


test("NAIF-published CKs read to the records CSPICE reads, to the bit; time agrees with NAIF's formula to 1e-9 s and with CSPICE to 1e-6 s", { skip: !ready }, async () => {
  const h = await harness(root);
  const reference = loadReference();
  let records = 0;
  let worstTime = 0;
  let worstFormula = 0;
  for (const [name, clock] of KERNELS) {
    const r = await h.invoke(ckRequest(name, clock));
    assert.equal(r.statusCode, 0, `${name}: ${r.errorMessage}`);
    const aem = unpackAem(r.outputs.find((o) => o.portId === "attitude").payload);
    assert.equal(aem.CCSDS_AEM_VERS, "2.0");
    // The reference's records, grouped into the AEM segments the module must make: one per interval.
    const expected = [];
    for (const seg of reference.get(name).segments) {
      for (let k = 0; k < seg.intervals; k++) expected.push({ seg, rows: seg.rows.filter((row) => row.interval === k) });
    }
    assert.equal(aem.SEGMENTS.length, expected.length, `${name}: one AEM segment per interval`);
    aem.SEGMENTS.forEach((s, i) => {
      const { seg, rows } = expected[i];
      assert.equal(s.OBJECT_NAME, seg.name);
      assert.equal(s.OBJECT_ID, String(seg.instrument));
      assert.equal(s.REF_FRAME_A, seg.frame === 1 ? "J2000" : String(seg.frame));
      assert.equal(s.REF_FRAME_B, String(seg.instrument));
      assert.equal(s.ATTITUDE_DIR, "A2B");
      assert.equal(s.TIME_SYSTEM, "TT", "the MSL and InSight clocks are TT-parallel and no conversion is done");
      assert.equal(s.ATTITUDE_TYPE, seg.av ? "QUATERNION/ANGVEL" : "QUATERNION");
      assert.equal(s.ATTITUDE_DATA_LINES.length, rows.length);
      assert.equal(s.START_TIME, s.ATTITUDE_DATA_LINES[0].EPOCH);
      assert.equal(s.STOP_TIME, s.ATTITUDE_DATA_LINES[rows.length - 1].EPOCH);
      if (seg.av) assert.equal(s.ANGVEL_FRAME, "REF_FRAME_A");
      s.ATTITUDE_DATA_LINES.forEach((line, j) => {
        const row = rows[j];
        // CCSDS (Q1 Q2 Q3 QC) is NAIF (q0 q1 q2 q3) with the vector part negated: an exact sign.
        // (A zero component is the schema default and is not stored, so a negated zero reads back as +0.)
        const want = [-row.q[1], -row.q[2], -row.q[3], row.q[0]].map((x) => (x === 0 ? 0 : x));
        assert.deepEqual([line.Q1, line.Q2, line.Q3, line.QC], want, `${name} segment ${seg.index} record ${j}`);
        if (seg.av) {
          assert.deepEqual([line.ANGVEL_X, line.ANGVEL_Y, line.ANGVEL_Z], row.av.map((x) => x * toDegrees), `${name} av ${seg.index}/${j}`);
        }
        // The stamp has nine decimals, so it is the clock's time to 5e-10 s, and NAIF's formula evaluated from the
        // kernel pool is the same arithmetic the module does; CSPICE's own route adds a TDB round trip.
        const dFormula = Math.abs(secondsPastJ2000(line.EPOCH) - row.formula);
        assert.ok(dFormula < 1e-9, `${name} ${seg.index}/${j}: ${dFormula} s from NAIF's formula`);
        worstFormula = Math.max(worstFormula, dFormula);
        worstTime = Math.max(worstTime, Math.abs(secondsPastJ2000(line.EPOCH) - row.tt));
        records++;
      });
    });
    const d = readNcd(r.outputs.find((o) => o.portId === "descriptor").payload);
    assert.equal(d.PROVIDER_DEFINED_FORMAT_NAME(), "naif-ck");
    assert.equal(d.FORMAT_VERSION(), "DAF/CK");
    assert.equal(d.NATIVE_TIME_SYSTEM(), "TT");
    assert.equal(d.SOURCE_SHA256(), sha256Hex(bytes(name)));
    const segs = reference.get(name).segments;
    assert.equal(d.segmentsLength(), segs.length);
    segs.forEach((seg, i) => {
      const dsc = d.SEGMENTS(i);
      assert.equal(dsc.NAME(), seg.name);
      assert.equal(dsc.TARGET_NAIF_ID(), seg.instrument);
      assert.equal(dsc.FRAME_NAIF_ID(), seg.frame);
      assert.equal(dsc.SEGMENT_TYPE(), 3);
      assert.equal(dsc.INITIAL_ADDRESS(), BigInt(seg.begin));
      assert.equal(dsc.FINAL_ADDRESS(), BigInt(seg.end));
    });
  }
  console.log(`# ${records} NAIF-published CK records read; time vs NAIF's formula ${worstFormula.toExponential(2)} s, vs CSPICE sct2e + unitim ${worstTime.toExponential(2)} s`);
  assert.ok(records >= 30);
  assert.ok(worstTime < 1e-6, `time differs from CSPICE by ${worstTime} s`);
});

test("the request selects by instrument, by segment name and by window, all in the $NCD", { skip: !ready }, async () => {
  const h = await harness(root);
  const reference = loadReference().get("msl_ra_straight_v1.bc");
  const one = await h.invoke(ckRequest("msl_ra_straight_v1.bc", MSL_CLOCK, { segments: [{ instrument: -76303 }] }));
  assert.equal(one.statusCode, 0, one.errorMessage);
  const aem = unpackAem(one.outputs.find((o) => o.portId === "attitude").payload);
  assert.equal(aem.SEGMENTS.length, 1);
  assert.equal(aem.SEGMENTS[0].OBJECT_ID, "-76303");
  const byName = await h.invoke(ckRequest("msl_ra_straight_v1.bc", MSL_CLOCK, { segments: [{ name: "MSL_RA_WRIST IN ZERO POSITION" }] }));
  assert.equal(unpackAem(byName.outputs.find((o) => o.portId === "attitude").payload).SEGMENTS[0].OBJECT_ID, "-76304");
  // The descriptor still lists every segment of the file.
  assert.equal(readNcd(one.outputs.find((o) => o.portId === "descriptor").payload).segmentsLength(), reference.segments.length);

  const rows = reference.segments[0].rows;
  const window = await h.invoke(ckRequest("msl_hga_zero_v1.bc", MSL_CLOCK, { startTime: "2013-01-01T00:00:00", stopTime: "2013-12-31T00:00:00" }));
  assert.equal(window.errorCode, "empty-selection", "the kernel's two records are in 2011 and 2020");
  assert.ok(rows.length >= 2);
  const none = await h.invoke(ckRequest("msl_ra_straight_v1.bc", MSL_CLOCK, { segments: [{ instrument: -1 }] }));
  assert.equal(none.errorCode, "empty-selection");
  const empty = await h.invoke(ckRequest("msl_ra_straight_v1.bc", MSL_CLOCK, { segments: [{}] }));
  assert.equal(empty.errorCode, "bad-selection");
});

test("what is not a type 3 CK on its clock is refused by name", { skip: !ready }, async () => {
  const h = await harness(root);
  const type2 = await h.invoke(ckRequest("insight_surf_nom_v2.bc", INSIGHT_CLOCK));
  assert.equal(type2.errorCode, "unsupported-ck-type");
  assert.match(type2.errorMessage, /CK type 2/);
  const wrongClock = await h.invoke(ckRequest("msl_hga_zero_v1.bc", INSIGHT_CLOCK));
  assert.equal(wrongClock.errorCode, "sclk-clock-not-in-kernel");
  assert.match(wrongClock.errorMessage, /holds 189/);
  const override = await h.invoke(ckRequest("msl_hga_zero_v1.bc", MSL_CLOCK, {}, { clock: -999 }));
  assert.equal(override.errorCode, "sclk-clock-not-in-kernel");
  const named = await h.invoke(ckRequest("msl_hga_zero_v1.bc", MSL_CLOCK, {}, { clock: -76 }));
  assert.equal(named.statusCode, 0, "the clock named in the sclk $NCD is the clock used");
  const spk = new Uint8Array(fs.readFileSync(path.join(root, "fixtures", "writer_parity_t13.bsp")));
  const notCk = await h.invoke({ methodId: "normalize_naif_ck", inputs: [
    input("container", NCD_TYPE, frame(spk, { formatName: "naif-ck" })),
    input("sclk", NCD_TYPE, frame(bytes(MSL_CLOCK), { formatName: "naif-sclk" }))] });
  assert.equal(notCk.errorCode, "not-a-ck");
  const wrongFormat = await h.invoke({ methodId: "normalize_naif_ck", inputs: [
    input("container", NCD_TYPE, frame(bytes("msl_hga_zero_v1.bc"), { formatName: "naif-sclk" })),
    input("sclk", NCD_TYPE, frame(bytes(MSL_CLOCK), { formatName: "naif-sclk" }))] });
  assert.equal(wrongFormat.errorCode, "format-mismatch");
  const garbage = await h.invoke({ methodId: "normalize_naif_ck", inputs: [
    input("container", NCD_TYPE, frame(bytes("msl_hga_zero_v1.bc"), { formatName: "naif-ck" })),
    input("sclk", NCD_TYPE, frame(new TextEncoder().encode("KPL/SCLK\nno data here\n"), { formatName: "naif-sclk" }))] });
  assert.equal(garbage.errorCode, "bad-sclk-kernel");
  const truncated = await h.invoke({ methodId: "normalize_naif_ck", inputs: [
    input("container", NCD_TYPE, frame(bytes("msl_hga_zero_v1.bc").slice(0, 3000), { formatName: "naif-ck" })),
    input("sclk", NCD_TYPE, frame(bytes(MSL_CLOCK), { formatName: "naif-sclk" }))] });
  assert.notEqual(truncated.statusCode, 0);
  assert.ok(truncated.errorCode.length > 0);
});

// --- writing -----------------------------------------------------------------------------------------------

const writeRequest = (aemBytes, clockBytes = bytes(MSL_CLOCK), descriptor = null, clockExtra = {}) => ({
  methodId: "write_naif_ck",
  inputs: [
    input("attitude", AEM_TYPE, aemBytes),
    input("sclk", NCD_TYPE, frame(clockBytes, { formatName: "naif-sclk", ...clockExtra })),
    ...(descriptor ? [input("descriptor", NCD_TYPE, descriptor)] : []),
  ],
});

function findSpiceyPython() {
  const candidates = [process.env.SPICEYPY_PYTHON, "python3", "/Users/tj/software/tools/xval/erfa-spice/bin/python"].filter(Boolean);
  for (const py of candidates) {
    const r = spawnSync(py, ["-I", "-c", "import spiceypy"], { encoding: "utf8" });
    if (r.status === 0) return py;
  }
  return null;
}

test("a kernel this module writes is read back by CSPICE to 1e-12 rad and by the module", { skip: !ready }, async () => {
  const h = await harness(root);
  const segments = syntheticAem();
  const aemBytes = buildAem(segments);
  const description = descriptorOnly({ internalFileName: "SDN synthetic CK type 3", comments: ["written by the interchange test", "two segments"] });
  const w = await h.invoke(writeRequest(aemBytes, bytes(MSL_CLOCK), description));
  assert.equal(w.statusCode, 0, w.errorMessage);
  const { descriptor, body } = splitFrame(w.outputs.find((o) => o.portId === "container").payload);
  assert.equal(descriptor.SOURCE_SHA256(), sha256Hex(body));
  assert.equal(descriptor.INTERNAL_FILE_NAME(), "SDN synthetic CK type 3");
  assert.equal(descriptor.segmentsLength(), 2);
  assert.equal(Buffer.from(body.slice(0, 8)).toString("ascii").trim(), "DAF/CK");
  assert.equal(Buffer.from(body.slice(88, 96)).toString("ascii"), "LTL-IEEE");

  // The module reads its own kernel back to the record it was given (time within the tick resolution).
  const back = await h.invoke({ methodId: "normalize_naif_ck", inputs: [
    input("container", NCD_TYPE, w.outputs.find((o) => o.portId === "container").payload),
    input("sclk", NCD_TYPE, frame(bytes(MSL_CLOCK), { formatName: "naif-sclk" }))] });
  assert.equal(back.statusCode, 0, back.errorMessage);
  const aem = unpackAem(back.outputs.find((o) => o.portId === "attitude").payload);
  assert.equal(aem.SEGMENTS.length, 2);
  let worstQ = 0, worstT = 0, worstAv = 0;
  segments.forEach((s, i) => {
    const got = aem.SEGMENTS[i];
    assert.equal(got.OBJECT_NAME, s.name);
    assert.equal(got.REF_FRAME_A, s.frameA);
    assert.equal(got.REF_FRAME_B, s.frameB);
    assert.equal(got.ATTITUDE_TYPE, s.av ? "QUATERNION/ANGVEL" : "QUATERNION");
    assert.equal(got.ATTITUDE_DATA_LINES.length, s.lines.length);
    s.lines.forEach((l, j) => {
      const g = got.ATTITUDE_DATA_LINES[j];
      worstQ = Math.max(worstQ, Math.abs(g.Q1 - l.q[0]), Math.abs(g.Q2 - l.q[1]), Math.abs(g.Q3 - l.q[2]), Math.abs(g.QC - l.q[3]));
      worstT = Math.max(worstT, Math.abs(secondsPastJ2000(g.EPOCH) - secondsPastJ2000(l.epoch)));
      if (l.av) worstAv = Math.max(worstAv, Math.abs(g.ANGVEL_X - l.av[0]), Math.abs(g.ANGVEL_Y - l.av[1]), Math.abs(g.ANGVEL_Z - l.av[2]));
    });
  });
  console.log(`# module round trip: worst quaternion ${worstQ.toExponential(2)}, time ${worstT.toExponential(2)} s, rate ${worstAv.toExponential(2)} deg/s`);
  assert.ok(worstQ === 0, "the quaternion changes by a sign only, which is exact");
  assert.ok(worstT < 1e-6, `epochs move by ${worstT} s`);
  assert.ok(worstAv < 1e-12, `angular velocity moves by ${worstAv} deg/s`);

  // The kernel is deterministic: the bytes written now are the bytes whose CSPICE readback is committed.
  // (INTERCHANGE_REGENERATE=1 rewrites both from the current module; the review then reads the diff.)
  if (process.env.INTERCHANGE_REGENERATE === "1") {
    fs.writeFileSync(path.join(FIX, "naif_ck_written.bc"), body);
    const python = findSpiceyPython();
    assert.ok(python, "regenerating the readback needs spiceypy");
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ckw-"));
    try {
      const expectedPath = path.join(scratch, "expected.txt");
      const rows = [];
      segments.forEach((s, i) => s.lines.forEach((l, j) => rows.push([i, j, secondsPastJ2000(l.epoch), ...l.q, ...(l.av ?? [0, 0, 0]).map((x) => x / toDegrees)].join(" "))));
      fs.writeFileSync(expectedPath, `${rows.join("\n")}\n`);
      const lsk = process.env.NAIF_LSK ?? "/Users/tj/software/tools/xval/naif-kernels/naif0012.tls";
      const run = spawnSync(python, ["-I", path.join(root, "tests", "reference", "ck_readback.py"), path.join(FIX, "naif_ck_written.bc"), path.join(FIX, MSL_CLOCK), lsk, expectedPath], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      fs.writeFileSync(path.join(FIX, "naif_ck_written.readback.txt"), run.stdout);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  const committed = new Uint8Array(fs.readFileSync(path.join(FIX, "naif_ck_written.bc")));
  assert.equal(sha256Hex(body), sha256Hex(committed), "the written kernel differs from fixtures/interchange/naif_ck_written.bc");
  const recorded = fs.readFileSync(path.join(FIX, "naif_ck_written.readback.txt"), "utf8");
  {
    const m = /read (\d+) records of (\d+) segments: worst rotation difference ([0-9.e+-]+) rad; worst angular velocity difference ([0-9.e+-]+) rad\/s/.exec(recorded);
    assert.ok(m, recorded);
    assert.equal(Number(m[1]), 265);
    assert.ok(Number(m[3]) < 1e-12 && Number(m[4]) < 1e-12, `the committed CSPICE readback: ${recorded.trim()}`);
  }

  // CSPICE reads the kernel this module wrote.
  const python = findSpiceyPython();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ckw-"));
  try {
    const ckPath = path.join(scratch, "written.bc");
    fs.writeFileSync(ckPath, body);
    const expectedPath = path.join(scratch, "expected.txt");
    const rows = [];
    segments.forEach((s, i) => s.lines.forEach((l, j) => rows.push([i, j, secondsPastJ2000(l.epoch), ...l.q, ...(l.av ?? [0, 0, 0]).map((x) => x / toDegrees)].join(" "))));
    fs.writeFileSync(expectedPath, `${rows.join("\n")}\n`);
    const readbackScript = path.join(root, "tests", "reference", "ck_readback.py");
    if (python === null) {
      console.log(`# ${recorded.trim()} [the committed record: spiceypy was not found here to rerun it]`);
    } else {
      const lsk = process.env.NAIF_LSK ?? "/Users/tj/software/tools/xval/naif-kernels/naif0012.tls";
      const run = spawnSync(python, ["-I", readbackScript, ckPath, path.join(FIX, MSL_CLOCK), lsk, expectedPath], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      console.log(`# ${run.stdout.trim()}`);
      const m = /worst rotation difference ([0-9.e+-]+) rad; worst angular velocity difference ([0-9.e+-]+) rad\/s; worst tick difference ([0-9.e+-]+)/.exec(run.stdout);
      assert.ok(m, run.stdout);
      assert.ok(Number(m[1]) < 1e-12, `CSPICE reads a rotation ${m[1]} rad from the intended one`);
      assert.ok(Number(m[2]) < 1e-12, `CSPICE reads an angular velocity ${m[2]} rad/s from the intended one`);
      assert.ok(Number(m[3]) < 0.05, `ticks differ by ${m[3]}`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("a write the kernel cannot hold is refused by name, nothing completed on a guess", { skip: !ready }, async () => {
  const h = await harness(root);
  const base = syntheticAem().slice(0, 1);
  const cases = [
    [{ dir: "B2A" }, "unsupported-attitude-direction"],
    [{ time: "UTC" }, "time-system-mismatch"],
    [{ type: "EULER_ANGLE" }, "unsupported-attitude-type"],
    [{ angvelFrame: "REF_FRAME_B" }, "unsupported-angvel-frame"],
    [{ frameA: "NOT_A_FRAME" }, "unknown-reference-frame"],
    [{ frameB: "instrument" }, "bad-instrument-code"],
  ];
  for (const [patch, code] of cases) {
    const r = await h.invoke(writeRequest(buildAem(base, patch)));
    assert.equal(r.errorCode, code, `${JSON.stringify(patch)}: ${r.errorMessage}`);
    assert.equal(r.outputs.length, 0);
  }
  const skewed = syntheticAem().slice(0, 1);
  skewed[0].lines[3].q = [0.5, 0.5, 0.5, 0.9];
  assert.equal((await h.invoke(writeRequest(buildAem(skewed)))).errorCode, "non-unit-quaternion");
  const backwards = syntheticAem().slice(0, 1);
  backwards[0].lines[3].epoch = backwards[0].lines[1].epoch;
  assert.equal((await h.invoke(writeRequest(buildAem(backwards)))).errorCode, "inconsistent-message");
  const long = syntheticAem().slice(0, 1);
  long[0].name = "x".repeat(41);
  assert.equal((await h.invoke(writeRequest(buildAem(long)))).errorCode, "bad-record");
  const wrongClock = await h.invoke(writeRequest(buildAem(base), bytes(INSIGHT_CLOCK)));
  assert.equal(wrongClock.errorCode, "sclk-clock-not-in-kernel");
  const askedForAnother = await h.invoke(writeRequest(buildAem(base), bytes(MSL_CLOCK), descriptorOnly({ formatName: "sentinel-eof" })));
  assert.equal(askedForAnother.errorCode, "format-mismatch");
  assert.equal(ncdContainerFormat.PROVIDER_DEFINED, 255);
});
