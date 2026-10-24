// evaluate_navigation: RINEX broadcast ephemerides evaluated by the ICD algorithm into $OEM.
//
// SDS has no record that can keep a broadcast ephemeris, so what leaves the module typed is what the parameters mean:
// the satellite's position and velocity. Two authorities that are not the module hold it:
//
//   * an independent evaluation: tests/reference/nav_reference.py reads the same committed file with georinex and writes
//     IS-GPS-200 table 20-IV out again (Python floats, each constellation's own constants, the absolute Toe from the
//     file's week field, the velocity a central difference), on the grid and by the message rule the module documents;
//   * the precise orbit: the CODE MGEX final SP3 of the same day (every 30 minutes of it), read by files/orbit-products. Broadcast orbits are meter-level, and the SP3 is of the center of mass where the broadcast set is of the
//     antenna phase center, so a few meters is the truth, not zero.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "flatbuffers";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";

import { NCD_TYPE, frame, harness, input, readNcd, sha256Hex, ncdContainerFormat } from "../../orbit-products/tests/lib/ncd_frames.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const products = path.join(root, "..", "orbit-products");
const FIX = path.join(root, "fixtures");
const NAV = "BRDC00IGS_R_20250190000_01D_MN.even-hours.rnx";
const ready = fs.existsSync(path.join(root, "dist", "isomorphic", "module.wasm")) && fs.existsSync(path.join(products, "dist", "isomorphic", "module.wasm"));
const bytes = new Uint8Array(fs.readFileSync(path.join(FIX, NAV)));
const text = fs.readFileSync(path.join(FIX, NAV), "latin1");

const unpack = (payload) => OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(payload))).unpack();
const evaluate = (h, data, request = {}) => h.invoke({ methodId: "evaluate_navigation",
  inputs: [input("container", NCD_TYPE, frame(data, { formatName: "rinex-nav", ...request }))] });
const blocks = (r) => unpack(r.outputs.find((o) => o.portId === "ephemeris").payload).EPHEMERIS_DATA_BLOCK;
const descriptor = (r) => readNcd(r.outputs.find((o) => o.portId === "descriptor").payload);
const comments = (d) => Array.from({ length: d.commentAreaLength() }, (_, i) => d.COMMENT_AREA(i));

const reference = fs.readFileSync(path.join(FIX, `${NAV.replace(".rnx", "")}.reference.tsv`), "utf8").split("\n")
  .filter((l) => l && !l.startsWith("#")).map((l) => { const c = l.split("\t"); return { sat: c[0], epoch: c[1], v: c.slice(2).map(Number) }; });

test("broadcast ephemerides evaluate to the independent IS-GPS-200 evaluation, position and velocity", { skip: !ready }, async () => {
  const h = await harness(root);
  const r = await evaluate(h, bytes);
  assert.equal(r.statusCode, 0, r.errorMessage);
  const got = [];
  for (const b of blocks(r)) for (const l of b.EPHEMERIS_DATA_LINES) got.push({ sat: b.OBJECT.OBJECT_NAME, epoch: l.EPOCH, v: [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT] });
  assert.equal(got.length, reference.length, "the states the module makes are the states the reference makes");
  const key = (s) => `${s.sat} ${s.epoch}`;
  const want = new Map(reference.map((s) => [key(s), s.v]));
  let worstPosition = 0;
  let worstVelocity = 0;
  for (const s of got) {
    const w = want.get(key(s));
    assert.ok(w, `${key(s)} is not in the reference`);
    worstPosition = Math.max(worstPosition, ...[0, 1, 2].map((i) => Math.abs(s.v[i] - w[i]) * 1000));
    worstVelocity = Math.max(worstVelocity, ...[3, 4, 5].map((i) => Math.abs(s.v[i] - w[i]) * 1000));
  }
  console.log(`# ${got.length} broadcast states (G, E, C) against the independent IS-GPS-200 evaluation: worst position difference ${worstPosition.toExponential(2)} m, velocity ${worstVelocity.toExponential(2)} m/s (the reference velocity is a central difference)`);
  assert.ok(worstPosition < 1e-6, `${worstPosition} m`);
  assert.ok(worstVelocity < 2e-5, `${worstVelocity} m/s`);

  // Each system on its own time and frame, as the file's.
  const byName = new Map(blocks(r).map((b) => [b.OBJECT.OBJECT_NAME, b]));
  assert.equal(byName.get("G05").TIME_SYSTEM, 1);   // timingStandard.GPS
  assert.equal(byName.get("G05").REFERENCE_FRAME.NAME, "WGS84");
  assert.equal(byName.get("E05").REFERENCE_FRAME.NAME, "GTRF");
  assert.equal(byName.get("C06").REFERENCE_FRAME.NAME, "CGCS2000");
  assert.equal(byName.get("G05").CENTER_NAME, "EARTH");
  assert.match(byName.get("G05").COMMENT, /IS-GPS-200 table 20-IV/);

  const d = descriptor(r);
  assert.equal(d.PROVIDER_DEFINED_FORMAT_NAME(), "rinex-nav");
  assert.equal(d.FORMAT_VERSION(), "3.04");
  assert.equal(d.SOURCE_SHA256(), sha256Hex(bytes));
  const notes = comments(d);
  for (const wanted of [/^Not evaluated: R: broadcasts a state vector, not a Keplerian set \(4 messages\)/, /^Not evaluated: S: /, /^Not evaluated: I: IRNSS is not evaluated \(4 messages\)/,
    /^Not evaluated: G: health word not 0/, /^Not evaluated: J: health word not 0/, /The parameters themselves are not kept: SDS has no broadcast-ephemeris record/]) {
    assert.ok(notes.some((n) => wanted.test(n)), `declared: ${wanted}`);
  }
  const systems = [];
  for (let i = 0; i < d.segmentsLength(); i++) systems.push(d.SEGMENTS(i).NAME());
  assert.deepEqual(systems.sort(), ["C", "E", "G"]);
});

test("against the CODE MGEX precise orbit of the same day the broadcast orbits agree at the meter level", { skip: !ready }, async () => {
  const hRinex = await harness(root);
  const hProducts = await harness(products);
  const sp3Bytes = new Uint8Array(fs.readFileSync(path.join(products, "fixtures", "COD0MGXFIN_20250190000_01D_05M_ORB.48ep.sp3")));
  const sp3 = await hProducts.invoke({ methodId: "read_container", inputs: [input("container", NCD_TYPE, frame(sp3Bytes, { format: ncdContainerFormat.SP3_D }))] });
  assert.equal(sp3.statusCode, 0, sp3.errorMessage);
  const precise = new Map();
  for (const b of unpack(sp3.outputs.find((o) => o.portId === "ephemeris").payload).EPHEMERIS_DATA_BLOCK) {
    const sat = b.OBJECT.OBJECT_ID;
    const lines = new Map();
    if (b.EPHEMERIS_DATA_LINES.length) for (const l of b.EPHEMERIS_DATA_LINES) lines.set(l.EPOCH.slice(0, 19), [l.X, l.Y, l.Z]);
    precise.set(sat, lines);
  }
  assert.ok(precise.size > 60, "the SP3 holds the constellations");
  const r = await evaluate(hRinex, bytes);
  const errors = {};
  const worst = [];
  for (const b of blocks(r)) {
    const sat = b.OBJECT.OBJECT_NAME;
    if (sat[0] === "C") continue; // BDT is 14 s behind the SP3's GPST labels: not on the SP3 grid
    const truth = precise.get(sat);
    if (!truth) continue;
    for (const l of b.EPHEMERIS_DATA_LINES) {
      const t = truth.get(l.EPOCH.slice(0, 19));
      if (!t) continue;
      const d = Math.hypot(l.X - t[0], l.Y - t[1], l.Z - t[2]) * 1000;
      (errors[sat[0]] ??= []).push(d);
      worst.push([d, `${sat} ${l.EPOCH.slice(11, 16)}`]);
    }
  }
  const sats = (system) => new Set(blocks(r).map((b) => b.OBJECT.OBJECT_NAME).filter((n) => n[0] === system && precise.has(n))).size;
  for (const [system, list] of Object.entries(errors)) {
    list.sort((x, y) => x - y);
    const rms = Math.sqrt(list.reduce((a, x) => a + x * x, 0) / list.length);
    const median = list[list.length >> 1];
    const p95 = list[Math.floor(list.length * 0.95)];
    console.log(`# broadcast against CODE MGEX final SP3, ${system === "G" ? "GPS" : "Galileo"}: ${list.length} states of ${sats(system)} satellites, 3D difference median ${median.toFixed(2)} m, 95th percentile ${p95.toFixed(2)} m, rms ${rms.toFixed(2)} m, max ${list[list.length - 1].toFixed(2)} m`);
    assert.ok(list.length > 300, `${system}: ${list.length} common states`);
    assert.ok(median < 3 && p95 < 6 && rms < 3 && list[list.length - 1] < 20, `${system}: not meter-level`);
  }
  worst.sort((x, y) => y[0] - x[0]);
  console.log(`# the largest: ${worst.slice(0, 4).map(([d, w]) => `${w} ${d.toFixed(1)} m`).join(", ")}`);
  assert.deepEqual(Object.keys(errors).sort(), ["E", "G"]);
});

test("the request travels in the $NCD: systems and a window", { skip: !ready }, async () => {
  const h = await harness(root);
  const galileo = await evaluate(h, bytes, { segments: [{ name: "E" }] });
  assert.equal(galileo.statusCode, 0, galileo.errorMessage);
  assert.ok(blocks(galileo).every((b) => b.OBJECT.OBJECT_NAME[0] === "E"));
  const d = descriptor(galileo);
  assert.equal(d.NATIVE_TIME_SYSTEM(), "GST");
  assert.equal(d.segmentsLength(), 1);
  const window = await evaluate(h, bytes, { segments: [{ name: "G" }], startTime: "2025-01-19T06:00:00", stopTime: "2025-01-19T07:00:00" });
  const epochs = new Set(blocks(window).flatMap((b) => b.EPHEMERIS_DATA_LINES.map((l) => l.EPOCH)));
  assert.equal(epochs.size, 13);
  assert.ok([...epochs].every((e) => e >= "2025-01-19T06:00:00" && e <= "2025-01-19T07:00:00.0000001"));
  assert.equal((await evaluate(h, bytes, { segments: [{ name: "R" }] })).errorCode, "evaluation-not-implemented");
  assert.equal((await evaluate(h, bytes, { segments: [{ name: "S" }] })).errorCode, "evaluation-not-implemented");
  assert.equal((await evaluate(h, bytes, { segments: [{ name: "Q" }] })).errorCode, "bad-selection");
  assert.equal((await evaluate(h, bytes, { startTime: "2030-01-01T00:00:00" })).errorCode, "empty-selection");
  assert.equal((await evaluate(h, bytes, { startTime: "later" })).errorCode, "bad-selection");
  assert.equal((await evaluate(h, bytes, { formatName: "rinex-obs" })).errorCode, "format-mismatch");
});

test("a navigation file this reader cannot stand behind is refused by name", { skip: !ready }, async () => {
  const h = await harness(root);
  const enc = (s) => new TextEncoder().encode(s);
  const obs = new Uint8Array(fs.readFileSync(path.join(FIX, "WTZR00DEU_R_20250190000_01D_30S_MO.first20.rnx")));
  assert.equal((await evaluate(h, obs)).errorCode, "wrong-rinex-type");
  const dlr = new Uint8Array(fs.readFileSync(path.join(FIX, "BRD400DLR_S_20250190000_01D_MN.head.rnx")));
  assert.equal((await evaluate(h, dlr)).errorCode, "unsupported-rinex-version");
  const cases = [
    ["bad-navigation-record", text.replace(/\nE02 [^\n]*\n[^\n]*\n/, (m) => `${m.split("\n").slice(0, 2).join("\n")}\n`)],  // a record cut short
    ["bad-navigation-record", text.replace("\nG03 2025", "\nX03 2025")],
    ["bad-value", text.replace(/(\nG05 [^\n]*\n)( {5}[^\n]{12})/, "$1     abcdef012345")],
    ["bad-navigation-record", text.replace("\nG05 2025 01 19 02", "\nG05 2025 13 19 02")],
    ["bad-rinex", text.replace(/END OF HEADER/, "COMMENT       ")],
    ["unsupported-rinex-version", text.replace(/^ {5}3\.04/, "     2.11")],
  ];
  for (const [code, mutated] of cases) {
    assert.notEqual(mutated, text, `${code}: the mutation changed nothing`);
    const r = await evaluate(h, enc(mutated));
    assert.equal(r.errorCode, code, `${code}: ${r.errorMessage}`);
    assert.equal(r.outputs.length, 0);
  }
  assert.equal((await evaluate(h, enc(""))).statusCode === 0, false);
});
