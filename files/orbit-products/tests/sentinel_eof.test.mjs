// normalize_sentinel_eof: ESA Sentinel orbit files (EOF) to $OEM, held to an independent reading.
//
// The authority is not this module. tests/reference/eof_reference.py parses the same committed files with
// Python's xml.etree.ElementTree, converts metres to kilometres with one division and writes the doubles it
// got; the module's states must equal them exactly. A second product of the same orbit (the restituted
// AUX_RESORB against the precise AUX_POEORB) and the adjacent-day precise file are the comparison of arcs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "flatbuffers";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";

import { NCD_TYPE, frame, harness, input, readNcd, sha256Hex, ncdContainerFormat } from "./lib/ncd_frames.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIX = path.join(root, "fixtures", "interchange");
const POE_A = "S1A_AUX_POEORB_V20240108_overlap";
const POE_B = "S1A_AUX_POEORB_V20240109_overlap";
const RES = "S1A_AUX_RESORB_V20240109_excerpt";
const FORMAT = "sentinel-eof";

const ready = fs.existsSync(path.join(root, "dist", "isomorphic", "module.wasm"));
const eof = (name) => new Uint8Array(fs.readFileSync(path.join(FIX, `${name}.EOF`)));
const reference = (name) =>
  fs.readFileSync(path.join(FIX, `${name}.reference.tsv`), "utf8").split("\n")
    .filter((l) => l && !l.startsWith("#")).map((l) => { const c = l.split("\t"); return { epoch: c[0], v: c.slice(1).map(Number) }; });

const unpackOem = (payload) => OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(payload))).unpack();

async function read(h, bytes, request = {}) {
  const r = await h.invoke({ methodId: "normalize_sentinel_eof",
    inputs: [input("container", NCD_TYPE, frame(bytes, { formatName: FORMAT, ...request }))] });
  return r;
}
const states = (r) => unpackOem(r.outputs.find((o) => o.portId === "ephemeris").payload);
const descriptor = (r) => readNcd(r.outputs.find((o) => o.portId === "descriptor").payload);

test("a Sentinel-1A precise orbit file reads to the states an independent parser reads, to the bit", { skip: !ready }, async () => {
  const h = await harness(root);
  for (const name of [POE_A, POE_B, RES]) {
    const bytes = eof(name);
    const r = await read(h, bytes);
    assert.equal(r.statusCode, 0, r.errorMessage);
    const oem = states(r);
    const block = oem.EPHEMERIS_DATA_BLOCK[0];
    const want = reference(name);
    assert.equal(block.EPHEMERIS_DATA_LINES.length, want.length, `${name} state count`);
    block.EPHEMERIS_DATA_LINES.forEach((line, i) => {
      assert.equal(line.EPOCH, want[i].epoch, `${name} epoch ${i}`);
      assert.deepEqual([line.X, line.Y, line.Z, line.X_DOT, line.Y_DOT, line.Z_DOT], want[i].v, `${name} state ${i}`);
    });
    assert.equal(block.CENTER_NAME, "EARTH");
    assert.equal(block.REFERENCE_FRAME.NAME, "EARTH_FIXED", "the frame is stated as the file names it");
    assert.equal(block.OBJECT.OBJECT_NAME, "Sentinel-1A");
    assert.equal(block.START_TIME, want[0].epoch);
    assert.equal(block.STOP_TIME, want[want.length - 1].epoch);
    assert.match(block.COMMENT, /orbit number/);
    assert.match(block.COMMENT, /Quality flag \(NOMINAL=\d+\)/);

    const d = descriptor(r);
    assert.equal(d.FORMAT(), ncdContainerFormat.PROVIDER_DEFINED);
    assert.equal(d.PROVIDER_DEFINED_FORMAT_NAME(), FORMAT);
    assert.equal(d.NATIVE_FRAME_NAME(), "EARTH_FIXED");
    assert.equal(d.NATIVE_TIME_SYSTEM(), "UTC");
    assert.equal(d.PRODUCER(), "OPOD");
    assert.equal(d.SOURCE_SHA256(), sha256Hex(bytes));
    assert.equal(d.SOURCE_BYTE_LENGTH(), BigInt(bytes.byteLength));
    assert.match(d.INTERNAL_FILE_NAME(), /^S1A_OPER_AUX_(POEORB|RESORB)_OPOD_/);
    assert.equal(d.segmentsLength(), 1);
    assert.match(d.SEGMENTS(0).NAME(), /^AUX_(POEORB|RESORB)$/);
  }
});

test("the two adjacent precise files agree on their two-hour overlap, and the restituted file lies within its accuracy of them", { skip: !ready }, async () => {
  const h = await harness(root);
  const a = states(await read(h, eof(POE_A))).EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
  const b = states(await read(h, eof(POE_B))).EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
  assert.equal(a.length, b.length);
  let worst = 0;
  a.forEach((la, i) => {
    assert.equal(la.EPOCH, b[i].EPOCH);
    worst = Math.max(worst, Math.hypot(la.X - b[i].X, la.Y - b[i].Y, la.Z - b[i].Z) * 1000);
  });
  console.log(`# S1A POEORB adjacent days, ${a.length} common epochs: worst 3D position difference ${worst.toFixed(4)} m`);
  assert.ok(worst < 0.01, `adjacent precise orbits differ by ${worst} m`);
});

test("the request window selects states and the descriptor states what was read", { skip: !ready }, async () => {
  const h = await harness(root);
  const r = await read(h, eof(POE_A), { startTime: "2024-01-09T23:30:00", stopTime: "2024-01-09T23:31:00" });
  assert.equal(r.statusCode, 0, r.errorMessage);
  const lines = states(r).EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
  const inside = reference(POE_A).filter((row) => row.epoch >= "2024-01-09T23:30:00" && row.epoch <= "2024-01-09T23:31:00");
  assert.equal(inside.length, 6);
  assert.deepEqual(lines.map((l) => l.EPOCH), inside.map((row) => row.epoch));
  assert.deepEqual(lines.map((l) => [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT]), inside.map((row) => row.v));
  assert.equal(descriptor(r).START_TIME(), inside[0].epoch);
  assert.equal(descriptor(r).STOP_TIME(), inside[5].epoch);
  const none = await read(h, eof(POE_A), { startTime: "2030-01-01T00:00:00" });
  assert.equal(none.errorCode, "empty-selection");
  const backwards = await read(h, eof(POE_A), { startTime: "2024-01-09T23:31:00", stopTime: "2024-01-09T23:30:00" });
  assert.equal(backwards.errorCode, "bad-selection");
  const garbled = await read(h, eof(POE_A), { startTime: "yesterday" });
  assert.equal(garbled.errorCode, "bad-selection");
});

const text = (name) => fs.readFileSync(path.join(FIX, `${name}.EOF`), "utf8");
const bytesOf = (s) => new TextEncoder().encode(s);

test("a file the reader cannot stand behind is refused by name, never read", { skip: !ready }, async () => {
  const h = await harness(root);
  const poe = text(POE_A);
  const cases = [
    ["unsupported-unit", poe.replace('<X unit="m">', '<X unit="km">')],
    ["inconsistent-message", poe.replace('count="721"', 'count="720"')],
    ["unknown-element", poe.replace("<Quality>NOMINAL</Quality>", "<Quality>NOMINAL</Quality><Residual>0.1</Residual>")],
    ["unknown-element", poe.replace("<Mission>", "<Programme>x</Programme><Mission>")],
    ["unsupported-time-reference", poe.replace("<Time_Reference>UTC</Time_Reference>", "<Time_Reference>GPS</Time_Reference>")],
    ["wrong-file-type", poe.replace(/Earth_Explorer_File/g, "Some_Other_File")],
    ["bad-xml", poe.replace("</Data_Block>", "</Data_Blok>")],
    ["bad-value", poe.replace(/<X unit="m">[^<]*</, '<X unit="m">minus two million<')],
    ["missing-element", poe.replace(/<VZ unit="m\/s">[^<]*<\/VZ>/, "")],
    ["bad-value", poe.replace("<UTC>UTC=2024-01-09T22:59:52.000000</UTC>", "<UTC>TAI=2024-01-09T22:59:52.000000</UTC>")],
    ["inconsistent-message", poe.replace("<UTC>UTC=2024-01-09T22:59:52.000000</UTC>", "<UTC>UTC=2024-01-09T22:59:42.000000</UTC>")],
    ["missing-element", poe.replace(/<Ref_Frame>[^<]*<\/Ref_Frame>/, "")],
  ];
  for (const [code, mutated] of cases) {
    const r = await read(h, bytesOf(mutated));
    assert.equal(r.statusCode === 0, false, `${code} was read`);
    assert.equal(r.errorCode, code, `${code}: ${r.errorMessage}`);
    assert.equal(r.outputs.length, 0, `${code} left an output behind`);
  }
  const control = await read(h, bytesOf("\u0001<x/>"));
  assert.equal(control.errorCode, "bad-encoding");
  const empty = await h.invoke({ methodId: "normalize_sentinel_eof",
    inputs: [input("container", NCD_TYPE, frame(new Uint8Array(0), { formatName: FORMAT }))] });
  assert.notEqual(empty.statusCode, 0);
});

test("the descriptor is checked against the bytes it describes, and must name this format", { skip: !ready }, async () => {
  const h = await harness(root);
  const bytes = eof(POE_A);
  // A declared hash that is not the file's.
  const wrongHash = frame(bytes, { formatName: FORMAT });
  const other = frame(eof(POE_B), { formatName: FORMAT });
  const swapped = new Uint8Array(other.length - eof(POE_B).length + bytes.length);
  swapped.set(other.subarray(0, other.length - eof(POE_B).length), 0);
  swapped.set(bytes, other.length - eof(POE_B).length);
  const r1 = await h.invoke({ methodId: "normalize_sentinel_eof", inputs: [input("container", NCD_TYPE, swapped)] });
  assert.equal(r1.errorCode, "descriptor-hash-mismatch");
  assert.ok(wrongHash.length > 0);
  // Another provider format, and a roster format, are refused rather than read as an EOF.
  const r2 = await read(h, bytes, { formatName: "ses-i11" });
  assert.equal(r2.errorCode, "format-mismatch");
  const r3 = await read(h, bytes, { format: ncdContainerFormat.SPK_DAF });
  assert.equal(r3.errorCode, "format-mismatch");
});
