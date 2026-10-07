// data-source/nwp-grib2-parser SDK-compat tests: the compiled wasm runs in the SDK browser harness on real NOAA GRIB2
// messages (tests/fixtures/noaa-2026100600-f024: GFS 1 deg winds and heights, GEFS 0.5 deg spread, GFS 0.5 deg cloud
// layers, GFS 0.25 deg 2 m temperature - fetched by .idx byte range, as the source node fetches them) and its records
// are unpacked through the spacedatastandards.org generated JS lib. Every record's codes must EQUAL the packing
// integers ecCodes (ECMWF's independent GRIB library; tests/fixtures/generate-expected.py) recovers - tolerance zero.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire as createModuleRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const WXF_LIB = pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/WXF/main.js"));
const flatbuffers = createModuleRequire(WXF_LIB)("flatbuffers");
const wxfLib = await import(WXF_LIB.href);

const FIXTURES = new URL("./fixtures/", import.meta.url);
const SET = new URL("./noaa-2026100600-f024/", FIXTURES);
const JOBS = JSON.parse(fs.readFileSync(new URL("jobs.json", FIXTURES), "utf8"));
const EXPECTED = JSON.parse(fs.readFileSync(new URL("expected.json", SET), "utf8"));
const INVENTORY = JSON.parse(fs.readFileSync(new URL("inventory.json", SET), "utf8"));
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const INIT_MS = Date.UTC(2026, 9, 6, 0);
const VARIABLES = { wind_east: "WindU", wind_north: "WindV", geopotential_height: "GeopotentialHeight", cloud_cover_total: "TotalCloudCover",
  cloud_cover_low: "LowCloudCover", cloud_cover_mid: "MediumCloudCover", cloud_cover_high: "HighCloudCover", air_temperature_2m: "Temperature2m" };

function job(file) {
  return { ...JOBS[file], url: INVENTORY[file].url, run: "20261006T00", lead: 24,
    provider_id: "noaa-ncep", source_name: `${JOBS[file].product}`, origin_id: "NOAA Open Data Dissemination (AWS)",
    dataset_id: new URL(INVENTORY[file].url).hostname.split(".")[0], license: "LicenseRef-NOAA-Open-Data", license_class: "OpenAttribution",
    license_url: "https://www.weather.gov/disclaimer", citation: "NOAA/NCEP via NOAA Open Data Dissemination (AWS)" };
}
function bytesInput(portId, payload) {
  return { portId, typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.byteLength }, payload };
}
const jsonInput = (portId, value) => bytesInput(portId, encoder.encode(JSON.stringify(value)));
function rawResponseFrame(body, status = 206) {
  const frame = new Uint8Array(8 + body.byteLength);
  frame.set([0x24, 0x48, 0x52, 0x42]);
  new DataView(frame.buffer).setInt32(4, status, true);
  frame.set(body, 8);
  return frame;
}
const gribBytes = (file) => new Uint8Array(fs.readFileSync(new URL(file, SET)));

async function createHarness(t) {
  const harness = await createBrowserModuleHarness({
    wasmSource: new Uint8Array(fs.readFileSync(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  return harness;
}
function splitStream(payload) {
  const records = [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let off = 0; off < payload.byteLength;) { const len = view.getUint32(off, true); off += 4; records.push(payload.subarray(off, off + len)); off += len; }
  return records;
}
const unpackWxf = (bytes) => wxfLib.WXF.getRootAsWXF(new flatbuffers.ByteBuffer(Uint8Array.from(bytes))).unpack();
function recordCodes(r) {
  assert.equal(r.VALUES_ENCODING, wxfLib.wxfValuesEncoding.InlineEncodedChunk);
  assert.deepEqual(r.CHUNK_CODECS, ["delta", "zigzag", "shuffle"]);
  assert.equal(r.CHUNK_DTYPE, "uint16");
  const b = Uint8Array.from(r.QUANTIZED_U8), n = b.length / 2, c = new Uint16Array(n);
  for (let i = 0; i < n; i++) c[i] = b[i] | (b[n + i] << 8);
  for (let i = 0; i < n; i++) c[i] = ((c[i] >>> 1) ^ -(c[i] & 1)) & 0xffff;
  for (let i = 1; i < n; i++) c[i] = (c[i] + c[i - 1]) & 0xffff;
  return c;
}

async function parse(harness, inputs) {
  const response = await harness.invoke({ methodId: "parse", inputs });
  const outputs = new Map(response.outputs.map((f) => [f.portId, f]));
  return { response, outputs };
}

function assertMatchesEcCodes(file, records) {
  const want = EXPECTED[file];
  const byName = new Map();
  for (const bytes of records) {
    assert.equal(decoder.decode(bytes.subarray(4, 8)), "$WXF");
    const r = unpackWxf(bytes);
    if (!byName.has(r.VARIABLE_NAME)) byName.set(r.VARIABLE_NAME, []);
    byName.get(r.VARIABLE_NAME).push(r);
  }
  assert.deepEqual([...byName.keys()].sort(), want.map((e) => e.name).sort(), `${file}: record names`);
  for (const e of want) {
    const list = byName.get(e.name);
    assert.equal(list.length, e.bands, `${e.name}: bands`);
    const all = new Uint16Array(e.nlat * e.nlon);
    let row = 0, missing = 0;
    list.forEach((r, k) => {
      const stem = e.name.replace(/_spread$/, "").replace(/_\d+hPa$/, "");
      assert.equal(r.VARIABLE, wxfLib.wxfVariable[VARIABLES[stem]], `${e.name}: variable`);
      assert.equal(r.FIELD_ID, `${JOBS[file].model_key}:20261006T00:f24:${e.name}`);
      assert.equal(r.MODEL_ID, JOBS[file].model_id);
      assert.equal(r.MODEL_CLASS, wxfLib.wxfModelClass[JOBS[file].model_class]);
      assert.equal(r.TIME_BASIS, wxfLib.wxfTimeBasis.Initialization);
      assert.equal(Number(r.INIT_TIME_MS), INIT_MS);
      assert.equal(r.LEAD_HOURS, e.lead);
      assert.equal(Number(r.VALID_TIME_MS), INIT_MS + e.lead * 3600000);
      assert.equal(r.MEMBER_KIND, JOBS[file].spread ? wxfLib.wxfMemberKind.StandardDeviation : wxfLib.wxfMemberKind.Unspecified);
      if (/hPa/.test(e.name)) { assert.equal(r.LEVEL_KIND, wxfLib.wxfLevelKind.PressureLevel); assert.equal(r.LEVEL_VALUE, Number(e.name.match(/_(\d+)hPa/)[1]) * 100); }
      if (e.name === "air_temperature_2m") { assert.equal(r.LEVEL_KIND, wxfLib.wxfLevelKind.HeightAboveGround); assert.equal(r.LEVEL_VALUE, 2); }
      if (/^cloud_cover/.test(e.name)) { assert.equal(r.LEVEL_KIND, wxfLib.wxfLevelKind.EntireAtmosphere); assert.equal(r.UNITS, "1"); }
      assert.equal(r.TEMPORAL_KIND, wxfLib.wxfTemporalKind.Instantaneous);
      assert.ok(Math.abs(r.SCALE_FACTOR - e.scale) <= Math.abs(e.scale) * 1e-15, `${e.name}: scale ${r.SCALE_FACTOR} vs ${e.scale}`);
      assert.ok(Math.abs(r.ADD_OFFSET - e.offset) <= Math.abs(e.offset) * 1e-15 + 1e-300, `${e.name}: offset ${r.ADD_OFFSET} vs ${e.offset}`);
      assert.equal(r.GRID.KIND, wxfLib.wxfGridKind.RegularLatLon);
      assert.equal(r.GRID.NLON, e.nlon);
      assert.equal(r.GRID.DLAT, e.dlat);
      assert.equal(r.GRID.DLON, e.dlon);
      assert.equal(r.GRID.LON0, e.lon0);
      assert.equal(r.GRID.LAT0, e.lat0 + row * e.dlat);
      assert.equal(r.GRID.NLAT, Math.min(e.band_rows, e.nlat - row));
      assert.equal(r.GRID.PERIODIC_LON, true);
      assert.equal(r.TILE_INDEX, k);
      assert.equal(r.TILE_COUNT, e.bands);
      assert.equal(r.SOURCE_URL, INVENTORY[file].url);
      assert.equal(r.LICENSE_CLASS, wxfLib.wxfLicenseClass.OpenAttribution);
      const c = recordCodes(r);
      assert.equal(c.length, r.GRID.NLAT * e.nlon);
      all.set(c, row * e.nlon);
      row += r.GRID.NLAT;
      missing += r.MISSING_COUNT;
    });
    assert.equal(row, e.nlat);
    assert.equal(missing, e.missing, `${e.name}: missing`);
    for (const [i, code] of Object.entries(e.samples)) assert.equal(all[Number(i)], code, `${e.name}: point ${i}`);
    assert.equal(createHash("sha256").update(Buffer.from(all.buffer)).digest("hex"), e.sha256, `${e.name}: every code equals ecCodes' packing integer`);
  }
}

test("nwp-grib2-parser artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({ manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")), wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("nwp-grib2-parser artifact is pure: canonical ABI, WASI-only imports", async () => {
  const inspection = await inspectModule(new Uint8Array(fs.readFileSync(ISOMORPHIC_WASM_PATH)));
  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort(), ["wasi_snapshot_preview1"]);
});

for (const file of Object.keys(JOBS)) {
  test(`parse: ${file} - every record's codes equal ecCodes' packing integers`, async (t) => {
    const harness = await createHarness(t);
    const { response, outputs } = await parse(harness, [jsonInput("jobs", job(file)), bytesInput("responses", rawResponseFrame(gribBytes(file)))]);
    assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
    assertMatchesEcCodes(file, splitStream(outputs.get("wxf_records").payload));
    const meta = JSON.parse(decoder.decode(outputs.get("wxf_meta").payload));
    assert.equal(meta.schema, "WXF.fbs");
    assert.equal(meta.provider_id, "noaa-ncep");
    assert.equal(meta.reconcile, "duplicates");
    assert.match(meta.batch_id, /^[0-9a-f]{64}$/);
  });
}

test("parse: all four products in one invocation are one batch, no frame dropped", async (t) => {
  const harness = await createHarness(t);
  const files = Object.keys(JOBS);
  const { response, outputs } = await parse(harness, [...files.map((f) => jsonInput("jobs", job(f))), ...files.map((f) => bytesInput("responses", rawResponseFrame(gribBytes(f))))]);
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const records = splitStream(outputs.get("wxf_records").payload);
  const total = files.reduce((n, f) => n + EXPECTED[f].reduce((m, e) => m + e.bands, 0), 0);
  assert.equal(records.length, total);
});

// The first message's section 4 (product definition) of a real file, altered in one byte - the refusals by name.
function alteredFirstMessage(file, change) {
  const b = gribBytes(file);
  const len = Number(new DataView(b.buffer).getBigUint64(8));
  const m = b.slice(0, len);
  let at = 16;
  while (at < m.length - 4) {
    const sl = new DataView(m.buffer).getUint32(at), num = m[at + 4];
    if (num === 4) { change(m, at); break; }
    at += sl;
  }
  return m;
}

test("parse refuses what it does not publish, by name", async (t) => {
  const harness = await createHarness(t);
  const file = "gfs-1p00-motion.grib2";
  const cases = [
    [alteredFirstMessage(file, (m, s4) => { m[s4 + 8] = 8; }), "statistical-field-unsupported"],   // product template 4.8
    [alteredFirstMessage(file, (m, s4) => { m[s4 + 10] = 250; }), "unsupported-field"],            // parameter number 250
    [encoder.encode("<Error><Code>NoSuchKey</Code></Error>"), "grib2-unreadable"],
  ];
  for (const [body, code] of cases) {
    const { response } = await parse(harness, [jsonInput("jobs", job(file)), bytesInput("responses", rawResponseFrame(body))]);
    assert.equal(response.errorCode, code, response.errorMessage);
    assert.equal(response.outputs.length, 0);
  }
  const mismatch = await parse(harness, [jsonInput("jobs", job(file)), jsonInput("jobs", job(file)), bytesInput("responses", rawResponseFrame(gribBytes(file)))]);
  assert.equal(mismatch.response.errorCode, "job-response-count-mismatch");
  const failed = await parse(harness, [jsonInput("jobs", job(file)), bytesInput("responses", rawResponseFrame(new Uint8Array(0), 404))]);
  assert.equal(failed.response.errorCode, "fetch-failed");
});
