// data-source/imager-observation-parser SDK-compat tests: the compiled wasm runs in the SDK browser harness on real
// GOES-19 ABI mesoscale files (NOAA Open Data Dissemination, tests/fixtures/goes19-m1-2026280-0600/) and its records
// are unpacked through the spacedatastandards.org generated JS lib. Every world code at every width must EQUAL the
// independent reference producer's (Cesium_Weather tools/raw_satellite.py, numpy; tests/fixtures/
// generate-expected.py wrote them): the port is exact, so the tolerance is zero codes.

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire as createModuleRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

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

const SET = new URL("./fixtures/goes19-m1-2026280-0600/", import.meta.url);
const EXPECTED = JSON.parse(fs.readFileSync(new URL("expected.json", SET), "utf8"));
const FIELDS = Object.keys(EXPECTED).sort();
const SENSOR = "GOES-19 ABI";
const FRAME_TIME_MS = Date.UTC(2026, 9, 7, 6, 0, 0);   // 2026-280 06:00 UTC
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function job(field, { part = 0, parts = 1, widths } = {}) {
  const e = EXPECTED[field];
  const product = e.file.match(/OR_(ABI-L2-[A-Z]+M)\d/)[1];   // (the mesoscale product's folder: ABI-L2-CMIPM, ...)
  return {
    satellite: "goes-east", sensor: SENSOR, bucket: "noaa-goes19",
    key: `${product}/2026/280/06/${e.file}`,
    variable: e.variable, field, frame_time_ms: FRAME_TIME_MS, part, parts,
    ...(widths ? { widths } : {}),
    provider_id: "noaa-goes", source_name: "noaa-goes19", origin_id: "NOAA Open Data Dissemination (AWS)",
    dataset_id: "noaa-goes19", license: "LicenseRef-NOAA-Open-Data", license_class: "OpenAttribution",
    license_url: "https://www.ncei.noaa.gov/access/metadata/landing-page/bin/iso?id=gov.noaa.ncdc:C01502",
    citation: `${SENSOR} data courtesy of NOAA via NOAA Open Data Dissemination`,
  };
}

function bytesInput(portId, payload) {
  return { portId, typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.byteLength }, payload };
}
const jsonInput = (portId, value) => bytesInput(portId, encoder.encode(JSON.stringify(value)));

// hostcap/http-request raw-body-v1 lane: "$HRB" + int32le status + body.
function rawResponseFrame(body, status = 200) {
  const frame = new Uint8Array(8 + body.byteLength);
  frame.set([0x24, 0x48, 0x52, 0x42]);
  new DataView(frame.buffer).setInt32(4, status, true);
  frame.set(body, 8);
  return frame;
}
const fileBytes = (field) => new Uint8Array(fs.readFileSync(new URL(EXPECTED[field].file, SET)));

async function createHarness(t) {
  const harness = await createBrowserModuleHarness({
    wasmSource: new Uint8Array(fs.readFileSync(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  return harness;
}

function outputsByPort(response) {
  const map = new Map();
  for (const frame of response.outputs) map.set(frame.portId, frame);
  return map;
}

function splitStream(payload) {
  const records = [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let off = 0; off < payload.byteLength;) {
    const len = view.getUint32(off, true);
    off += 4;
    assert.ok(len > 0 && off + len <= payload.byteLength, "invalid record length");
    records.push(payload.subarray(off, off + len));
    off += len;
  }
  return records;
}

function unpackWxf(record) {
  const bb = new flatbuffers.ByteBuffer(Uint8Array.from(record));
  assert.ok(wxfLib.WXF.bufferHasIdentifier(bb), "$WXF identifier");
  return wxfLib.WXF.getRootAsWXF(bb).unpack();
}

// A record's codes, the CHUNK_CODECS undone as SDS 1.238 defines them (last back to first).
function recordCodes(r) {
  const E = wxfLib.wxfValuesEncoding;
  if (r.VALUES_ENCODING === E.InlineQuantizedUint16) return Uint16Array.from(r.QUANTIZED_U16);
  if (r.VALUES_ENCODING === E.InlineQuantizedUint8) return Uint8Array.from(r.QUANTIZED_U8);
  assert.equal(r.VALUES_ENCODING, E.InlineEncodedChunk);
  assert.deepEqual(r.CHUNK_CODECS, ["delta", "zigzag", "shuffle"]);
  const bytes = Uint8Array.from(r.QUANTIZED_U8);
  assert.equal(Number(r.CHUNK_BYTE_LENGTH), bytes.length);
  const wide = r.CHUNK_DTYPE === "uint16";
  const n = wide ? bytes.length / 2 : bytes.length;
  const c = wide ? new Uint16Array(n) : new Uint8Array(n);
  for (let i = 0; i < n; i++) c[i] = wide ? bytes[i] | (bytes[n + i] << 8) : bytes[i];
  const mask = wide ? 0xffff : 0xff;
  for (let i = 0; i < n; i++) c[i] = ((c[i] >>> 1) ^ -(c[i] & 1)) & mask;
  for (let i = 1; i < n; i++) c[i] = (c[i] + c[i - 1]) & mask;
  return c;
}

const expectedCodes = (field, width) => {
  const e = EXPECTED[field];
  const raw = gunzipSync(fs.readFileSync(new URL(e.widths[width].codes, SET)));
  return e.encoding === "InlineQuantizedUint8" ? new Uint8Array(raw) : new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
};

async function parse(harness, inputs) {
  const response = await harness.invoke({ methodId: "parse", inputs });
  return { response, outputs: outputsByPort(response) };
}

// Every record of one field's output against the reference: codes equal at every width, attributes as written.
function assertFieldMatchesReference(field, records) {
  const e = EXPECTED[field];
  const byWidth = new Map();
  for (const bytes of records) {
    assert.equal(decoder.decode(bytes.subarray(4, 8)), "$WXF");
    const r = unpackWxf(bytes);
    const width = r.GRID.NLON;
    if (!byWidth.has(width)) byWidth.set(width, []);
    byWidth.get(width).push(r);
  }
  for (const [widthKey, w] of Object.entries(e.widths)) {
    const width = Number(widthKey);
    const list = byWidth.get(width) ?? [];
    assert.equal(list.length, w.bands, `${field} ${width}: band records`);
    const d = 360 / width;
    let missing = 0;
    let lo = Infinity, hi = -Infinity;
    const codes = [];
    list.forEach((r, k) => {
      const row = w.l0 + 64 * k;
      assert.equal(r.FIELD_ID, `${SENSOR}:${FRAME_TIME_MS}:world${width}:${field}`);
      assert.equal(r.VARIABLE, wxfLib.wxfVariable[e.variable_enum]);
      assert.equal(r.VARIABLE_NAME, field);
      assert.equal(r.UNITS, e.units);
      assert.equal(r.LEVEL_KIND, wxfLib.wxfLevelKind[e.level_enum]);
      assert.equal(r.VALUES_ENCODING, wxfLib.wxfValuesEncoding[e.encoding]);
      assert.equal(r.SCALE_FACTOR, e.scale);
      assert.equal(r.ADD_OFFSET, e.offset);
      assert.equal(r.TIME_BASIS, wxfLib.wxfTimeBasis.ValidTimeOnly);
      assert.equal(Number(r.VALID_TIME_MS), e.scan_start_ms);
      assert.equal(Number(r.SCAN_END_TIME_MS), e.scan_end_ms);
      assert.equal(r.MODEL_CLASS, wxfLib.wxfModelClass.Analysis);
      assert.equal(r.SENSOR_ID, SENSOR);
      assert.ok(Math.abs(r.CHANNEL_WAVELENGTH_UM - e.wavelength_um) < 1e-6);
      assert.equal(r.PLATFORM_LONGITUDE_DEG, e.platform_lon0);
      assert.equal(r.PLATFORM_LATITUDE_DEG, 0);
      assert.equal(r.PLATFORM_HEIGHT_M, e.platform_height);
      assert.equal(r.LICENSE_CLASS, wxfLib.wxfLicenseClass.OpenAttribution);
      assert.equal(r.SOURCE_URL, `s3://noaa-goes19/${job(field).key}`);
      assert.equal(r.GRID.KIND, wxfLib.wxfGridKind.RegularLatLon);
      assert.equal(r.GRID.LAT0, 90 - (row + 0.5) * d);
      assert.equal(r.GRID.LON0, -180 + 0.5 * d);
      assert.equal(r.GRID.DLAT, -d);
      assert.equal(r.GRID.DLON, d);
      assert.equal(r.GRID.NLAT, Math.min(64, w.l1 - row));
      assert.equal(r.TILE_INDEX, Math.floor(row / 64));
      assert.equal(r.TILE_COUNT, w.tile_count);
      missing += r.MISSING_COUNT;
      if (r.MISSING_COUNT < r.GRID.NLAT * width) { lo = Math.min(lo, r.VALUE_MIN); hi = Math.max(hi, r.VALUE_MAX); }
      codes.push(recordCodes(r));
    });
    const got = codes.length === 1 ? codes[0] : (() => {
      const all = new (codes[0].constructor)(codes.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of codes) { all.set(c, at); at += c.length; }
      return all;
    })();
    const want = expectedCodes(field, widthKey);
    assert.equal(got.length, want.length, `${field} ${width}: cells`);
    let differ = 0, first = -1;
    for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) { differ++; if (first < 0) first = i; }
    assert.equal(differ, 0, `${field} ${width}: ${differ} codes differ from the reference (first at cell ${first}: ${got[first]} vs ${want[first]})`);
    assert.equal(missing, w.missing, `${field} ${width}: missing count`);
    assert.equal(lo, Math.fround(w.min), `${field} ${width}: VALUE_MIN`);
    assert.equal(hi, Math.fround(w.max), `${field} ${width}: VALUE_MAX`);
  }
}

test("imager-observation-parser artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("imager-observation-parser artifact is pure: canonical ABI, WASI-only imports", async () => {
  const inspection = await inspectModule(new Uint8Array(fs.readFileSync(ISOMORPHIC_WASM_PATH)));
  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort(), ["wasi_snapshot_preview1"]);
  for (const required of ["plugin_alloc", "plugin_free", "plugin_invoke_stream", "plugin_get_manifest_flatbuffer", "plugin_get_manifest_flatbuffer_size"]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

for (const field of FIELDS) {
  test(`parse: ${field} (${EXPECTED[field].file.slice(0, 32)}...) equals the reference at 4096, 2048 and 1024`, async (t) => {
    const harness = await createHarness(t);
    const { response, outputs } = await parse(harness, [jsonInput("jobs", job(field)), bytesInput("responses", rawResponseFrame(fileBytes(field)))]);
    assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
    assertFieldMatchesReference(field, splitStream(outputs.get("wxf_records").payload));
    const meta = JSON.parse(decoder.decode(outputs.get("wxf_meta").payload));
    assert.equal(meta.schema, "WXF.fbs");
    assert.equal(meta.provider_id, "noaa-goes");
    assert.equal(meta.source_name, "noaa-goes19");
    assert.equal(meta.reconcile, "duplicates");
    assert.equal(meta.license, "LicenseRef-NOAA-Open-Data");
    assert.match(meta.batch_id, /^[0-9a-f]{64}$/);
    const provenance = JSON.parse(Buffer.from(meta.provenance.json, "base64").toString("utf8"));
    assert.equal(provenance.normalized_count, Object.values(EXPECTED[field].widths).reduce((n, w) => n + w.bands, 0));
  });
}

test("parse: a file fetched as three byte ranges is joined first (206 parts), same records", async (t) => {
  const field = "reflectance_064um";
  const bytes = fileBytes(field);
  const cut = [0, 400_000, 900_000, bytes.byteLength];
  const harness = await createHarness(t);
  const inputs = [];
  for (let p = 0; p < 3; p++) inputs.push(jsonInput("jobs", job(field, { part: p, parts: 3 })));
  for (let p = 0; p < 3; p++) inputs.push(bytesInput("responses", rawResponseFrame(bytes.subarray(cut[p], cut[p + 1]), 206)));
  const { response, outputs } = await parse(harness, inputs);
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  assertFieldMatchesReference(field, splitStream(outputs.get("wxf_records").payload));
});

test("parse: only the requested widths", async (t) => {
  const field = "cloud_top_height";
  const harness = await createHarness(t);
  const { response, outputs } = await parse(harness, [jsonInput("jobs", job(field, { widths: "1024" })), bytesInput("responses", rawResponseFrame(fileBytes(field)))]);
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const widths = new Set(splitStream(outputs.get("wxf_records").payload).map((b) => unpackWxf(b).GRID.NLON));
  assert.deepEqual([...widths], [1024]);
});

test("parse refuses what it cannot attribute or read, by name", async (t) => {
  const harness = await createHarness(t);
  const field = "cloud_phase";
  const ok = bytesInput("responses", rawResponseFrame(fileBytes(field)));
  const cases = [
    [[jsonInput("jobs", job(field)), jsonInput("jobs", job(field)), ok], "job-response-count-mismatch"],
    [[jsonInput("jobs", job(field, { part: 1, parts: 2 })), ok], "incomplete-file"],
    [[jsonInput("jobs", job(field)), bytesInput("responses", rawResponseFrame(new Uint8Array(0), 404))], "fetch-failed"],
    [[jsonInput("jobs", { ...job(field), field: "sea_surface_temperature" }), ok], "invalid-file-job"],
    [[jsonInput("jobs", job(field)), bytesInput("responses", rawResponseFrame(encoder.encode("<Error>NoSuchKey</Error>")))], "netcdf-unreadable"],
    [[jsonInput("jobs", { ...job(field), variable: "NOT_THERE" }), ok], "netcdf-unreadable"],
  ];
  for (const [inputs, code] of cases) {
    const { response } = await parse(harness, inputs);
    assert.notEqual(response.statusCode, 0, code);
    assert.equal(response.errorCode, code, response.errorMessage);
    assert.equal(response.outputs.length, 0);
  }
});

// NO INPUT FRAME IS EVER DESTROYED SILENTLY (graph task modules-guest-nodes-drop-batched-frames): the compiled flow
// runtime fills an invocation port-blind up to 64 frames, so every job/response pair handed over is parsed - two files
// in one invocation are one ingest batch carrying both.
test("parse: two files in one invocation make one batch with both fields' records", async (t) => {
  const harness = await createHarness(t);
  const [a, b] = ["cloud_phase", "cloud_mask"];
  const { response, outputs } = await parse(harness, [
    jsonInput("jobs", job(a)), jsonInput("jobs", job(b)),
    bytesInput("responses", rawResponseFrame(fileBytes(a))), bytesInput("responses", rawResponseFrame(fileBytes(b))),
  ]);
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const records = splitStream(outputs.get("wxf_records").payload);
  const names = records.map((bytes) => unpackWxf(bytes).VARIABLE_NAME);
  assertFieldMatchesReference(a, records.filter((_, k) => names[k] === a));
  assertFieldMatchesReference(b, records.filter((_, k) => names[k] === b));
  const meta = JSON.parse(decoder.decode(outputs.get("wxf_meta").payload));
  const provenance = JSON.parse(Buffer.from(meta.provenance.json, "base64").toString("utf8"));
  assert.equal(provenance.normalized_count, records.length);
});
