// files/misb-klv. Every expectation comes from stated values encoded with the
// MISB ST 0601 mappings (tests/lib/ts-writer.mjs), from the H.264 fixtures'
// own structure, or from an independent footprint reference
// (tests/lib/oracle.mjs: quaternions and a closed-form geodetic conversion).
//
// Tolerances: corners stated in tags 82-89 are int32-quantized (180/2^32 ~
// 4.2e-8 deg per step), offsets in 26-33 int16 (0.15/2^16 ~ 2.3e-6 deg); the
// expectation is the quantized value itself, compared to 1e-9 deg (double
// rounding only). Ray footprints depend on quantized pose inputs; the oracle
// is fed the same quantized values, so the two must agree to 1e-7 deg
// (about 1 cm), the closed-form vs iterative geodetic difference included.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as flatbuffers from "flatbuffers";
import { NCD } from "spacedatastandards.org/lib/js/NCD/NCD.js";
import { GDI } from "spacedatastandards.org/lib/js/GDI/GDI.js";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { accessUnits, quantized, st0601, transportStream } from "./lib/ts-writer.mjs";
import { footprint } from "./lib/oracle.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const WASM = path.join(root, "dist", "isomorphic", "module.wasm");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugin-manifest.json"), "utf8"));
const built = fs.existsSync(WASM);
const fixture = (name) => new Uint8Array(fs.readFileSync(path.join(here, "fixtures", name)));
const skip = !built && "run `npm run build` first";

function descriptor(bytes, { declare = true } = {}) {
  const builder = new flatbuffers.Builder(256);
  const sha = declare ? builder.createString(createHash("sha256").update(bytes).digest("hex")) : null;
  NCD.startNCD(builder);
  if (declare) NCD.addSourceByteLength(builder, BigInt(bytes.byteLength));
  if (sha !== null) NCD.addSourceSha256(builder, sha);
  NCD.finishSizePrefixedNCDBuffer(builder, NCD.endNCD(builder));
  return builder.asUint8Array();
}

async function invoke(t, methodId, ts, options) {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(WASM), manifest, surface: "direct" });
  t.after(() => harness.destroy());
  const d = descriptor(ts, options);
  return harness.invoke({
    methodId,
    inputs: [
      { portId: "descriptor", typeRef: { schemaName: "NCD.fbs", fileIdentifier: "$NCD", rootTypeName: "NCD", wireFormat: "flatbuffer" }, payload: d },
      { portId: "stream", typeRef: { acceptsAnyFlatbuffer: true, byteLength: ts.byteLength }, payload: ts },
    ],
  });
}

const BASE = 900_000; // 10 s, in 90 kHz ticks
const baselineUnits = (base = BASE) => accessUnits(fixture("testsrc2-64x48-baseline.h264")).map((bytes, i) => ({ bytes, pts: base + 3000 * i, dts: base + 3000 * i }));

function table(bytes) {
  const v = new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const rows = v[1];
  return { epochMs: v[2], ticks: v[3], rows: Array.from({ length: rows }, (_, r) => Array.from(v.subarray(4 + r * 10, 14 + r * 10))) };
}

function boxes(bytes, from = 0, to = bytes.length) {
  const out = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = from; at + 8 <= to; ) {
    const size = view.getUint32(at);
    out.push({ type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)), at, size });
    if (size < 8) break;
    at += size;
  }
  return out;
}

const outputs = (r, port) => r.outputs.filter((o) => o.portId === port).map((o) => new Uint8Array(o.payload));

test("artifact passes SDK compliance and exports both methods", { skip }, async () => {
  const report = await validateArtifactWithStandards({ manifest, wasmPath: WASM, standardsRoot: path.join(root, "node_modules", "spacedatastandards.org") });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const inspection = await inspectModule(fs.readFileSync(WASM));
  assert.deepEqual([...new Set(inspection.imports.map((e) => e.module))], ["wasi_snapshot_preview1"]);
  for (const name of ["remux", "footprints"]) assert.ok(inspection.exports.includes(name), name);
});

test("remux: a fragmented MP4 the stream's own parameter sets describe, and stated corners per frame", { skip }, async (t) => {
  const corners = [[38.95, -77.1], [38.96, -76.95], [38.82, -76.93], [38.8, -77.08]];
  const units = baselineUnits();
  const klv = units.map((u, i) => ({ pts: u.pts, bytes: st0601({ timestampUs: 1_760_000_000_000_000n + BigInt(i) * 33_333n, corners }) }));
  const r = await invoke(t, "remux", transportStream({ units, klv }));
  assert.equal(r.statusCode, 0, r.errorMessage);
  const [init] = outputs(r, "init");
  const top = boxes(init).map((b) => b.type);
  assert.deepEqual(top, ["ftyp", "moov"]);
  const text = String.fromCharCode(...init);
  for (const box of ["mvhd", "tkhd", "mdia", "avc1", "avcC", "mvex", "trex"]) assert.ok(text.includes(box), box);
  const avc1 = text.indexOf("avc1", text.indexOf("stsd"));
  const view = new DataView(init.buffer, init.byteOffset, init.byteLength);
  assert.equal(view.getUint16(avc1 + 4 + 24), 64);
  assert.equal(view.getUint16(avc1 + 4 + 26), 48);
  const media = outputs(r, "media");
  assert.ok(media.length >= 1);
  let samples = 0;
  for (const m of media) {
    assert.deepEqual(boxes(m).map((b) => b.type), ["moof", "mdat"]);
    const trun = String.fromCharCode(...m).indexOf("trun");
    samples += new DataView(m.buffer, m.byteOffset).getUint32(trun + 8);
  }
  assert.equal(samples, units.length);
  const { rows, epochMs } = table(outputs(r, "frames")[0]);
  assert.equal(rows.length, units.length);
  assert.deepEqual(rows.map((row) => row[0]), units.map((_, i) => 3000 * i));
  const expected = [3, 2, 1, 0].map((k) => corners[k]).flatMap(([lat, lon]) => [quantized.signed(lon, 4, 360), quantized.signed(lat, 4, 180)]);
  for (const row of rows) {
    assert.equal(row[1], 1);
    row.slice(2).forEach((v, j) => assert.ok(Math.abs(v - expected[j]) < 1e-9, `${j}: ${v} vs ${expected[j]}`));
  }
  assert.equal(epochMs, 1_760_000_000_000);
});

test("remux: B-frames keep presentation order; PTS rollover keeps times increasing", { skip }, async (t) => {
  const aus = accessUnits(fixture("testsrc2-64x48-bframes.h264"));
  // Decode order I0 P3 B1 B2 P5 B4 | I6 P9 B7 B8 P11 B10 (the fixture's own picture types).
  const display = [0, 3, 1, 2, 5, 4, 6, 9, 7, 8, 11, 10];
  const wrap = 2 ** 33;
  const base = wrap - 4 * 3000; // the 33-bit counter rolls over inside the stream
  const units = aus.map((bytes, k) => ({ bytes, pts: (base + 3000 * display[k]) % wrap, dts: (base + 3000 * (k - 1) + wrap) % wrap }));
  const r = await invoke(t, "remux", transportStream({ units }));
  assert.equal(r.statusCode, 0, r.errorMessage);
  const { rows } = table(outputs(r, "frames")[0]);
  // Keys are presentation times from the first decode time (one frame before the first presentation).
  assert.deepEqual(rows.map((row) => row[0]), display.slice().sort((a, b) => a - b).map((d) => 3000 * (d + 1)));
  assert.ok(rows.every((row) => row[1] === 0), "no metadata: no footprint");
});

test("checksum: a corrupted packet is refused", { skip }, async (t) => {
  const units = baselineUnits();
  const klv = [{ pts: units[0].pts, bytes: st0601({ corners: [[1, 1], [1, 2], [0, 2], [0, 1]] }, { badChecksum: true }) }];
  const r = await invoke(t, "footprints", transportStream({ units, klv }));
  assert.notEqual(r.statusCode, 0);
  assert.match(r.errorMessage ?? r.errorCode ?? "", /ST 0601|no-st0601/);
});

test("offsets: frame centre plus corner offsets; an error value leaves its packet unlocated", { skip }, async (t) => {
  const units = baselineUnits();
  const offsets = [[0.01, -0.02], [0.012, 0.018], [-0.011, 0.02], [-0.009, -0.019]];
  const klv = [
    { pts: units[0].pts, bytes: st0601({ centerLat: 38.9, centerLon: -77.0, offsets }) },
    { pts: units[11].pts + 200_000, bytes: st0601({ centerLat: 38.9, centerLon: -77.0, offsets, rawError: { 26: true } }), after: 11 },
  ];
  const r = await invoke(t, "remux", transportStream({ units, klv }));
  assert.equal(r.statusCode, 0, r.errorMessage);
  const { rows } = table(outputs(r, "frames")[0]);
  const lat0 = quantized.signed(38.9, 4, 180);
  const lon0 = quantized.signed(-77.0, 4, 360);
  const expected = [3, 2, 1, 0].flatMap((k) => [lon0 + quantized.signed(offsets[k][1], 2, 0.15), lat0 + quantized.signed(offsets[k][0], 2, 0.15)]);
  rows[0].slice(2).forEach((v, j) => assert.ok(Math.abs(v - expected[j]) < 1e-9, `${j}`));
  // Every frame is within 1 s of the located packet.
  assert.ok(rows.every((row) => row[1] === 1));
  // The packet whose offset carries the error value (0x8000) locates nothing.
  const g = await invoke(t, "footprints", transportStream({ units, klv }));
  assert.ok(g.outputs.filter((o) => o.portId === "footprints").every((o) => o.wireFormat === "flatbuffer" && o.typeRef?.schemaName === "GDI.fbs"), "each footprint is a regular $GDI FlatBuffer");
  const notes = outputs(g, "footprints").map((bytes) => {
    const bb = new flatbuffers.ByteBuffer(bytes);
    bb.setPosition(4);
    return GDI.getRootAsGDI(bb).NOTES();
  });
  assert.deepEqual(notes, ["footprint: frame centre and corner offsets (tags 23-33)", "no footprint: the packet does not locate the frame on the ground"]);
});

for (const [name, pose] of [
  ["nadir", { lat: 38.9, lon: -77.0, h: 3000, heading: 0, pitch: 0, roll: 0, az: 0, el: -90, sroll: 0, hfov: 10, vfov: 8 }],
  ["oblique", { lat: 38.9, lon: -77.0, h: 4500, heading: 30, pitch: 2, roll: -1, az: 45, el: -30, sroll: 5, hfov: 12, vfov: 7, elevation: 120 }],
]) {
  test(`rays: a ${name} pose matches the independent footprint`, { skip }, async (t) => {
    const units = baselineUnits();
    const q = {
      lat: quantized.signed(pose.lat, 4, 180), lon: quantized.signed(pose.lon, 4, 360), h: quantized.unsigned(pose.h, 2, 19900, -900),
      heading: quantized.unsigned(pose.heading, 2, 360), pitch: quantized.signed(pose.pitch, 4, 180), roll: quantized.signed(pose.roll, 4, 180),
      az: quantized.unsigned(pose.az, 4, 360), el: quantized.signed(pose.el, 4, 360), sroll: quantized.unsigned(pose.sroll, 4, 360),
      hfov: quantized.unsigned(pose.hfov, 2, 180), vfov: quantized.unsigned(pose.vfov, 2, 180),
      elevation: pose.elevation === undefined ? 0 : quantized.unsigned(pose.elevation, 2, 19900, -900),
    };
    const packet = st0601({
      sensorLat: pose.lat, sensorLon: pose.lon, sensorAltHae: pose.h, heading: pose.heading, pitchFull: pose.pitch, rollFull: pose.roll,
      sensorAz: pose.az, sensorEl: pose.el, sensorRoll: pose.sroll, hfov: pose.hfov, vfov: pose.vfov,
      ...(pose.elevation === undefined ? {} : { centerElev: pose.elevation }),
    });
    const r = await invoke(t, "remux", transportStream({ units, klv: [{ pts: units[0].pts, bytes: packet }] }));
    assert.equal(r.statusCode, 0, r.errorMessage);
    const { rows } = table(outputs(r, "frames")[0]);
    const expected = footprint(q);
    assert.ok(expected, "the oracle's rays reach the ground");
    assert.equal(rows[0][1], 1);
    rows[0].slice(2).forEach((v, j) => assert.ok(Math.abs(v - expected[j]) < 1e-7, `${j}: ${v} vs ${expected[j]}`));
  });
}

test("rays that miss the Earth leave the frame unlocated", { skip }, async (t) => {
  const units = baselineUnits();
  const packet = st0601({ sensorLat: 10, sensorLon: 20, sensorAltHae: 5000, heading: 0, sensorAz: 0, sensorEl: 5, hfov: 20, vfov: 10 });
  const r = await invoke(t, "remux", transportStream({ units, klv: [{ pts: units[0].pts, bytes: packet }] }));
  assert.equal(r.statusCode, 0, r.errorMessage);
  assert.ok(table(outputs(r, "frames")[0]).rows.every((row) => row[1] === 0));
});

test("asynchronous KLV (stream type 0x06, KLVA) in M2TS packets takes the preceding frame's time", { skip }, async (t) => {
  const units = baselineUnits();
  const corners = [[1, 1], [1, 2], [0, 2], [0, 1]];
  const klv = [{ bytes: st0601({ corners }), after: 5 }];
  const r = await invoke(t, "remux", transportStream({ units, klv, asyncKlv: true, m2ts: true }));
  assert.equal(r.statusCode, 0, r.errorMessage);
  const { rows } = table(outputs(r, "frames")[0]);
  // The packet sits at frame 5's time; frames up to 1 s away use it.
  assert.ok(rows.every((row) => row[1] === 1));
});

test("footprints: one $GDI per packet with time, sensor and the GeoJSON polygon", { skip }, async (t) => {
  const units = baselineUnits();
  const corners = [[38.95, -77.1], [38.96, -76.95], [38.82, -76.93], [38.8, -77.08]];
  const klv = [0, 1].map((i) => ({ pts: units[i].pts, bytes: st0601({ timestampUs: 1_760_000_000_000_000n + BigInt(i) * 33_333n, platform: "MQ-9", sensor: "EO Nose", corners }) }));
  const r = await invoke(t, "footprints", transportStream({ units, klv }));
  assert.equal(r.statusCode, 0, r.errorMessage);
  const records = outputs(r, "footprints").map((bytes) => {
    const bb = new flatbuffers.ByteBuffer(bytes);
    bb.setPosition(4);
    return GDI.getRootAsGDI(bb);
  });
  assert.equal(records.length, 2);
  assert.equal(records[0].IMAGE_TIME(), "2025-10-09T08:53:20.000000Z");
  assert.equal(records[1].IMAGE_TIME(), "2025-10-09T08:53:20.033333Z");
  assert.equal(records[0].ID_SENSOR(), "EO Nose");
  assert.equal(records[0].NAME(), "MQ-9");
  const geo = JSON.parse(records[0].REGION_GEO_JSON());
  assert.equal(geo.type, "Polygon");
  assert.equal(geo.coordinates[0].length, 5);
  assert.ok(Math.abs(geo.coordinates[0][0][0] - quantized.signed(-77.08, 4, 360)) < 1e-8);
  assert.ok(Math.abs(geo.coordinates[0][0][1] - quantized.signed(38.8, 4, 180)) < 1e-8);
});
