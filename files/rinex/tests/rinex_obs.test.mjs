// read_observations: RINEX 3.02-3.05 observation files to $GNO, held to georinex.
//
// The authority is not this module. tests/reference/rinex_obs_reference.py reads the same committed excerpt of an
// IGS station's daily file (WTZR, RINEX 3.05, GPS + GLONASS + Galileo + BeiDou + IRNSS + SBAS, 20 epochs at
// 30 s) with georinex, with its indicators, and writes one line per observation. Every observation the module
// emits must be one of those lines and every line one of the module's, value, LLI and SSI to the bit.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "flatbuffers";
import { GNO } from "spacedatastandards.org/lib/js/GNO/GNO.js";

import { NCD_TYPE, frame, harness, input, readNcd, sha256Hex, ncdContainerFormat } from "../../orbit-products/tests/lib/ncd_frames.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIX = path.join(root, "fixtures");
const OBS = "WTZR00DEU_R_20250190000_01D_30S_MO.first20.rnx";
const ready = fs.existsSync(path.join(root, "dist", "isomorphic", "module.wasm"));
const bytes = new Uint8Array(fs.readFileSync(path.join(FIX, OBS)));
const text = fs.readFileSync(path.join(FIX, OBS), "latin1");

const unpack = (payload) => GNO.getSizePrefixedRootAsGNO(new flatbuffers.ByteBuffer(new Uint8Array(payload))).unpack();
const read = (h, data, request = {}) => h.invoke({ methodId: "read_observations",
  inputs: [input("container", NCD_TYPE, frame(data, { formatName: "rinex-obs", ...request }))] });
const epochs = (r) => r.outputs.filter((o) => o.portId === "observations").map((o) => unpack(o.payload));
const descriptor = (r) => readNcd(r.outputs.find((o) => o.portId === "descriptor").payload);
const flatten = (records) => {
  const lines = [];
  for (const g of records) for (const sat of g.SAT_OBS) for (const o of sat.OBSERVATIONS) {
    lines.push([g.EPOCH, sat.GNSS_SAT_ID, o.SIGNAL, o.VALUE, o.LLI, o.SSI].join("\t"));
  }
  return lines;
};
const reference = fs.readFileSync(path.join(FIX, `${OBS.replace(".rnx", "")}.reference.tsv`), "utf8").split("\n")
  .filter((l) => l && !l.startsWith("#")).map((l) => { const c = l.split("\t"); return [c[0], c[1], c[2], String(Number(c[3])), c[4], c[5]].join("\t"); });

test("every observation of an IGS RINEX 3.05 file reads as georinex reads it, LLI and SSI included", { skip: !ready }, async () => {
  const h = await harness(root);
  const r = await read(h, bytes);
  assert.equal(r.statusCode, 0, r.errorMessage);
  const records = epochs(r);
  assert.equal(records.length, 20);
  const got = flatten(records);
  assert.equal(got.length, reference.length, "observation count");
  assert.deepEqual(got.slice().sort(), reference.slice().sort(), "the observations are the independent reader's, to the bit");
  const withLli = got.filter((l) => l.split("\t")[4] !== "0").length;
  assert.ok(withLli >= 100, `LLI is carried (${withLli} observations with one)`);
  console.log(`# ${got.length} observations in ${records.length} epochs, ${withLli} with a loss-of-lock indicator: identical to georinex`);

  const first = records[0];
  assert.equal(first.EPOCH, "2025-01-19T00:00:00.0000000");
  assert.equal(first.NUM_SATS, 51);
  assert.equal(first.SAT_OBS.length, 51);
  assert.equal(first.RECEIVER_ID, "1831551");
  assert.equal(first.RECEIVER_TYPE, "LEICA GR50");
  assert.equal(first.FIRMWARE_VERSION, "4.50/7.710");
  assert.equal(first.ANTENNA_ID, "10020031");
  assert.equal(first.ANTENNA_TYPE, "LEIAR25.R3      LEIT");
  assert.deepEqual([first.APPROX_X, first.APPROX_Y, first.APPROX_Z], [4075580.8863, 931853.5784, 4801567.9707]);
  assert.equal(first.INTERVAL, 30);
  assert.ok(first.ID.startsWith("WTZR:"));
  assert.ok(first.OBS_CODE_SET.includes("G C1C C2S C2W C5Q D1C D2S D2W D5Q L1C L2S L2W L5Q S1C S2S S2W S5Q"));
  const constellations = new Set(first.SAT_OBS.map((s) => s.CONSTELLATION));
  assert.equal(constellations.size, 6, "GPS, GLONASS, Galileo, BeiDou, IRNSS and SBAS are all read");
  // The fields the file does not state are not invented.
  assert.equal(first.LATITUDE + first.LONGITUDE + first.ALTITUDE + first.PDOP + first.HDOP + first.VDOP, 0);
  assert.equal(first.SAT_OBS[0].ELEVATION, 0);
  for (const sat of first.SAT_OBS) for (const o of sat.OBSERVATIONS) {
    assert.equal(o.OBS_TYPE, { C: 0, L: 1, D: 2, S: 3 }[o.SIGNAL[0]]);
  }

  const d = descriptor(r);
  assert.equal(d.FORMAT(), ncdContainerFormat.PROVIDER_DEFINED);
  assert.equal(d.PROVIDER_DEFINED_FORMAT_NAME(), "rinex-obs");
  assert.equal(d.FORMAT_VERSION(), "3.05");
  assert.equal(d.NATIVE_TIME_SYSTEM(), "GPS");
  assert.equal(d.PRODUCER(), "GR50 V4.50");
  assert.equal(d.CREATION_DATE(), "2025-01-18T23:59:45");
  assert.equal(d.START_TIME(), "2025-01-19T00:00:00.0000000");
  assert.equal(d.STOP_TIME(), "2025-01-19T00:09:30.0000000");
  assert.equal(d.SOURCE_SHA256(), sha256Hex(bytes));
  const systems = [];
  for (let i = 0; i < d.segmentsLength(); i++) systems.push(d.SEGMENTS(i).NAME());
  assert.deepEqual(systems.sort(), ["C", "E", "G", "I", "R", "S"]);
  const comments = [];
  for (let i = 0; i < d.commentAreaLength(); i++) comments.push(d.COMMENT_AREA(i));
  assert.ok(comments.some((c) => /^RINEX header records not carried by \$GNO or \$NCD:.*GLONASS SLOT \/ FRQ #.*SYS \/ PHASE SHIFT/.test(c)), "the loss is declared");
  assert.ok(comments.includes("SNR is mapped to RINEX snr flag value [1-9]"));
});

test("the request travels in the $NCD: a window of epochs and a choice of satellite systems", { skip: !ready }, async () => {
  const h = await harness(root);
  const window = await read(h, bytes, { startTime: "2025-01-19T00:02:00", stopTime: "2025-01-19T00:04:00" });
  assert.equal(window.statusCode, 0, window.errorMessage);
  assert.deepEqual(epochs(window).map((g) => g.EPOCH), [120, 150, 180, 210, 240].map((s) => `2025-01-19T00:0${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.0000000`));
  assert.equal(descriptor(window).START_TIME(), "2025-01-19T00:02:00.0000000");

  const gps = await read(h, bytes, { segments: [{ name: "G" }] });
  assert.equal(gps.statusCode, 0, gps.errorMessage);
  const onlyGps = epochs(gps);
  assert.equal(onlyGps.length, 20);
  assert.ok(onlyGps.every((g) => g.SAT_OBS.every((s) => s.GNSS_SAT_ID[0] === "G")));
  assert.equal(onlyGps[0].NUM_SATS, onlyGps[0].SAT_OBS.length);
  const wantGps = reference.filter((l) => l.split("\t")[1][0] === "G");
  assert.deepEqual(flatten(onlyGps).sort(), wantGps.sort());
  const d = descriptor(gps);
  assert.equal(d.segmentsLength(), 1);
  assert.equal(d.SEGMENTS(0).NAME(), "G");

  const two = await read(h, bytes, { segments: [{ name: "E" }, { name: "C" }] });
  assert.deepEqual([...new Set(epochs(two).flatMap((g) => g.SAT_OBS.map((s) => s.GNSS_SAT_ID[0])))].sort(), ["C", "E"]);

  assert.equal((await read(h, bytes, { startTime: "2030-01-01T00:00:00" })).errorCode, "empty-selection");
  assert.equal((await read(h, bytes, { startTime: "2025-01-19T00:04:00", stopTime: "2025-01-19T00:02:00" })).errorCode, "bad-selection");
  assert.equal((await read(h, bytes, { startTime: "noon" })).errorCode, "bad-selection");
  assert.equal((await read(h, bytes, { segments: [{ name: "GPS" }] })).errorCode, "bad-selection");
  assert.equal((await read(h, bytes, { segments: [{ name: "X" }] })).errorCode, "bad-selection");
  assert.equal((await read(h, bytes, { segments: [{ instrument: 5 }] })).errorCode, "bad-selection");
});

const enc = (s) => new TextEncoder().encode(s);
const mutate = (pattern, replacement) => {
  const out = text.replace(pattern, replacement);
  assert.notEqual(out, text, `the mutation ${pattern} changed nothing`);
  return enc(out);
};

test("a file this reader cannot stand behind is refused by name", { skip: !ready }, async () => {
  const h = await harness(root);
  const cases = [
    ["unsupported-rinex-version", mutate(/^     3\.05/, "     2.11")],
    ["unsupported-rinex-version", mutate(/^     3\.05/, "     3.01")],
    ["unsupported-rinex-version", mutate(/^     3\.05/, "     4.00")],
    ["wrong-rinex-type", mutate("OBSERVATION DATA    M (MIXED)", "METEOROLOGICAL DATA M (MIXED)")],
    ["navigation-not-in-sds", mutate("OBSERVATION DATA    M (MIXED)", "NAVIGATION DATA     M (MIXED)")],
    ["unsupported-epoch-flag", mutate("> 2025 01 19 00 01 00.0000000  0 50", "> 2025 01 19 00 01 00.0000000  1 50")],
    ["unsupported-epoch-flag", mutate("> 2025 01 19 00 01 00.0000000  0 50", "> 2025 01 19 00 01 00.0000000  4 50")],
    ["unsupported-observation-type", mutate("I    4 C5A D5A L5A S5A", "I    4 C5A D5A I5A S5A")],
    ["unsupported-observation-type", mutate("I    4 C5A D5A L5A S5A", "I    4 C5A D5A X5A S5A")],
    ["inconsistent-message", mutate("> 2025 01 19 00 01 00.0000000  0 50", "> 2025 01 19 00 01 00.0000000  0 49")],
    ["bad-satellite-record", mutate(/\nR(\d\d) /, "\nZ$1 ")],
    ["bad-value", mutate(/40902325\.228 /, "4090x325.228 ")],
    ["bad-epoch-record", mutate("> 2025 01 19 00 02 00", "> 2025 13 19 00 02 00")],
    ["bad-epoch-record", mutate("> 2025 01 19 00 02 30.0000000", ">2025 01 19 00 02 30.0000000")],
    ["bad-rinex", mutate(/END OF HEADER/, "COMMENT")],
    ["bad-satellite-record", mutate(/^C   20 [^\n]*\n[^\n]*SYS \/ # \/ OBS TYPES\n/m, "")],
  ];
  for (const [code, data] of cases) {
    const r = await read(h, data);
    assert.notEqual(r.statusCode, 0, `${code} was read`);
    assert.equal(r.errorCode, code, `${code}: ${r.errorMessage}`);
    assert.equal(r.outputs.length, 0, `${code} left an output`);
  }
  // A mixed file that names no time system is not read as GPS.
  assert.equal((await read(h, mutate(/GPS         TIME OF FIRST OBS/, "            TIME OF FIRST OBS"))).errorCode, "missing-time-system");
  // A truncated file, an empty file and one that is not ASCII.
  assert.equal((await read(h, bytes.slice(0, bytes.length - 700))).errorCode, "truncated");
  assert.equal((await read(h, enc("not rinex\n"))).errorCode, "bad-rinex");
  assert.equal((await read(h, enc(text.replace("LEICA GR50", "LEICA GR50é")))).errorCode, "bad-encoding");
});

test("navigation files are refused by name until SDS has a record for broadcast ephemerides", { skip: !ready }, async () => {
  const h = await harness(root);
  // The first records of the published IGS and BKG broadcast files: RINEX 3.05 GPS, RINEX 3.04 mixed, RINEX 4.02 (out of range).
  for (const [name, code] of [["BRDC00WRD_R_20250190000_01D_GN.head.rnx", "navigation-not-in-sds"], ["BRDC00IGS_R_20250190000_01D_MN.head.rnx", "navigation-not-in-sds"],
    ["BRD400DLR_S_20250190000_01D_MN.head.rnx", "unsupported-rinex-version"]]) {
    const r = await read(h, new Uint8Array(fs.readFileSync(path.join(FIX, name))));
    assert.equal(r.errorCode, code, `${name}: ${r.errorMessage}`);
    assert.equal(r.outputs.length, 0);
    if (code === "navigation-not-in-sds") assert.match(r.errorMessage, /\$NAV is the Naval Vessel record/);
  }
});

test("the descriptor must name this format and match the bytes", { skip: !ready }, async () => {
  const h = await harness(root);
  assert.equal((await read(h, bytes, { formatName: "rinex-nav" })).errorCode, "format-mismatch");
  assert.equal((await read(h, bytes, { format: ncdContainerFormat.SP3_D })).errorCode, "format-mismatch");
  // The wrong bytes: a different length is a length mismatch, the same length with one byte changed is a hash mismatch.
  const shorter = frame(bytes, { formatName: "rinex-obs" });
  const wrongLength = new Uint8Array(shorter.length - 1);
  wrongLength.set(shorter.subarray(0, shorter.length - 1));
  assert.equal((await h.invoke({ methodId: "read_observations", inputs: [input("container", NCD_TYPE, wrongLength)] })).errorCode, "descriptor-length-mismatch");
  const flipped = new Uint8Array(shorter);
  flipped[flipped.length - 100] ^= 1;
  assert.equal((await h.invoke({ methodId: "read_observations", inputs: [input("container", NCD_TYPE, flipped)] })).errorCode, "descriptor-hash-mismatch");
});
