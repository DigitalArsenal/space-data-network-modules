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

function job(field, { widths, maxPart } = {}) {
  const e = EXPECTED[field];
  const product = e.file.match(/OR_(ABI-L2-[A-Z]+M)\d/)[1];   // (the mesoscale product's folder: ABI-L2-CMIPM, ...)
  return {
    kind: "abi", satellite: "goes-east", sensor: SENSOR, bucket: "noaa-goes19",
    key: `${product}/2026/280/06/${e.file}`, size: fs.statSync(new URL(e.file, SET)).size,
    variable: e.variable, field, frame_time_ms: FRAME_TIME_MS,
    ...(widths ? { widths } : {}), ...(maxPart ? { max_part_bytes: maxPart } : {}),
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

// The flow's http connector, played: parse pushes requests, the answers go back on "responses" in order; a node that
// yields is resumed without input (as the compiled runtime does). -> { requests, batches, notices, status, last }
async function drive(harness, work, serve) {
  const out = { requests: [], batches: [], notices: [], status: [], last: null };
  let inputs = work.map((w) => jsonInput("work", w));
  for (let round = 0; round < 200; round++) {
    const response = await harness.invoke({ methodId: "parse", inputs });
    out.last = response;
    const by = (port) => response.outputs.filter((f) => f.portId === port);
    const requests = by("requests").map((f) => JSON.parse(decoder.decode(f.payload)));
    out.requests.push(...requests);
    const metas = by("wxf_meta"), records = by("wxf_records");
    for (let k = 0; k < metas.length; k++) out.batches.push({ meta: JSON.parse(decoder.decode(metas[k].payload)), records: splitStream(records[k].payload) });
    out.notices.push(...by("notices").map((f) => JSON.parse(decoder.decode(f.payload))));
    out.status.push(...by("status").map((f) => JSON.parse(decoder.decode(f.payload))));
    if (requests.length) { inputs = requests.map((r) => bytesInput("responses", serve(r))); continue; }
    if (response.yielded || metas.length) { inputs = []; continue; }
    return out;
  }
  throw new Error("the engine did not settle");
}
// S3 played: the landed-mark probe 416 (not landed), the file whole or by range (206)
function serveFiles(files, { landed = new Set() } = {}) {
  return (r) => {
    const url = new URL(r.url);
    if (url.searchParams.get("sdn-ingest") === "landed") return rawResponseFrame(new Uint8Array(0), landed.has(r.url) ? 304 : 416);
    const body = files[url.pathname.slice(1)];
    if (!body) return rawResponseFrame(new Uint8Array(0), 404);
    const m = r.headers?.Range?.match(/^bytes=(\d+)-(\d+)$/);
    return m ? rawResponseFrame(body.subarray(Number(m[1]), Number(m[2]) + 1), 206) : rawResponseFrame(body);
  };
}
const filesOf = (...fields) => Object.fromEntries(fields.map((f) => [job(f).key, fileBytes(f)]));

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
    const { requests, batches, status, last } = await drive(harness, [job(field)], serveFiles(filesOf(field)));
    assert.equal(last.statusCode, 0, `${last.errorCode}: ${last.errorMessage}`);
    assert.deepEqual(status, []);
    // the landed-mark probe first (no validators of its own, a range past any object), then the file
    assert.equal(requests[0].url, `https://noaa-goes19.s3.amazonaws.com/${job(field).key}?sdn-ingest=landed&field=${field}`);
    assert.equal(requests[0].headers.Range, "bytes=1099511627776-");
    assert.equal(requests[0].headers["If-Modified-Since"], undefined);
    assert.equal(requests[1].headers["If-Modified-Since"], "Thu, 01 Jan 1970 00:00:00 GMT");
    assert.equal(batches.length, 1);
    assertFieldMatchesReference(field, batches[0].records);
    const meta = batches[0].meta;
    assert.equal(meta.schema, "WXF.fbs");
    assert.equal(meta.provider_id, "noaa-goes");
    assert.equal(meta.source_name, "noaa-goes19");
    assert.equal(meta.reconcile, "duplicates");
    assert.equal(meta.license, "LicenseRef-NOAA-Open-Data");
    assert.match(meta.batch_id, /^[0-9a-f]{64}$/);
    assert.equal(meta.satellite, "goes-east");
    assert.equal(meta.field, field);
    assert.equal(meta.frame_time_ms, FRAME_TIME_MS);
    assert.equal(meta.landed_mark, requests[0].url);
    const provenance = JSON.parse(Buffer.from(meta.provenance.json, "base64").toString("utf8"));
    assert.equal(provenance.normalized_count, Object.values(EXPECTED[field].widths).reduce((n, w) => n + w.bands, 0));
  });
}

test("parse: a file larger than max_part_bytes is fetched as byte ranges, one a round, appended: same records", async (t) => {
  const field = "reflectance_064um";   // 1.47 MB, 1 MiB parts
  const harness = await createHarness(t);
  const { requests, batches, last } = await drive(harness, [job(field, { maxPart: 1048576 })], serveFiles(filesOf(field)));
  assert.equal(last.statusCode, 0, `${last.errorCode}: ${last.errorMessage}`);
  const ranges = requests.slice(1).map((r) => r.headers.Range);
  assert.equal(ranges.length, 2);
  assert.match(ranges[0], /^bytes=0-\d+$/);
  assertFieldMatchesReference(field, batches[0].records);
});

test("parse: only the requested widths", async (t) => {
  const field = "cloud_top_height";
  const harness = await createHarness(t);
  const { batches } = await drive(harness, [job(field, { widths: "1024" })], serveFiles(filesOf(field)));
  const widths = new Set(batches[0].records.map((b) => unpackWxf(b).GRID.NLON));
  assert.deepEqual([...widths], [1024]);
});

test("parse: a field the node already holds (its landed mark answers 304) is noticed, not fetched", async (t) => {
  const field = "cloud_mask";
  const harness = await createHarness(t);
  const mark = `https://noaa-goes19.s3.amazonaws.com/${job(field).key}?sdn-ingest=landed&field=${field}`;
  const { requests, batches, notices, status } = await drive(harness, [job(field)], serveFiles(filesOf(field), { landed: new Set([mark]) }));
  assert.equal(requests.length, 1, "the probe only");
  assert.equal(batches.length, 0);
  assert.deepEqual(notices, [{ satellite: "goes-east", frame_time_ms: FRAME_TIME_MS, field, state: "landed" }]);
  assert.deepEqual(status, [{ landed_before: 1, status: 304, unchanged: true }]);
});

test("parse: queued jobs one at a time, each its own batch; a job queued twice is fetched once", async (t) => {
  const harness = await createHarness(t);
  const [a, b] = ["cloud_phase", "cloud_mask"];
  const { batches, requests, last } = await drive(harness, [job(a), job(b), job(a)], serveFiles(filesOf(a, b)));
  assert.equal(last.statusCode, 0);
  assert.deepEqual(batches.map((x) => x.meta.field), [a, b]);
  assert.equal(requests.length, 4, "a probe and the file, per job");
  assertFieldMatchesReference(a, batches[0].records);
  assertFieldMatchesReference(b, batches[1].records);
});

test("parse: a job that fails is reported by name and the rest go on; the spell ends refused", async (t) => {
  const harness = await createHarness(t);
  const [a, b] = ["cloud_phase", "cloud_mask"];
  const broken = { ...job(a), variable: "NOT_THERE" };
  const { batches, status, last } = await drive(harness, [broken, job(b), { ...job(b), kind: "sonar" }], serveFiles(filesOf(a, b)));
  assert.deepEqual(batches.map((x) => x.meta.field), [b]);
  assert.equal(status.length, 2);
  assert.match(status[0].failed.error, /unknown work kind "sonar"/);
  assert.match(status[1].failed.error, /NOT_THERE/);
  assert.equal(last.errorCode, "imager-job-failed");
  const missing = await drive(harness, [{ ...job(a), key: "ABI-L2-ACTPM/2026/280/06/gone.nc" }], serveFiles({}));
  assert.match(missing.status[0].failed.error, /answered HTTP 404/);
});

test("parse refuses a response it never asked for", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({ methodId: "parse", inputs: [bytesInput("responses", rawResponseFrame(new Uint8Array(4)))] });
  assert.equal(response.errorCode, "unexpected-response");
});
