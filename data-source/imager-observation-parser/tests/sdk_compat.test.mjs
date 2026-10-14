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
import { createHash } from "node:crypto";
import { decodeHostCall, decodeIngestRequest, encodeHttpResponse } from "space-data-module-sdk/runtime-contracts";
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

// The file job select_files puts on each GET's CONTEXT: one size-prefixed $WXF header record (GRID present, empty).
function key(field) {
  const e = EXPECTED[field];
  const product = e.file.match(/OR_(ABI-L2-[A-Z]+M)\d/)[1];   // (the mesoscale product's folder: ABI-L2-CMIPM, ...)
  return `${product}/2026/280/06/${e.file}`;
}
function jobBytes(field, { part = 0, parts = 1, variable = EXPECTED[field]?.variable ?? "CMI" } = {}) {
  const W = wxfLib.WXF;
  const b = new flatbuffers.Builder(512);
  const s = (v) => b.createString(v);
  const fid = s(field), vname = s(variable), sensor = s(SENSOR), dataset = s("noaa-goes19");
  const url = s(`https://noaa-goes19.s3.amazonaws.com/${key(field in EXPECTED ? field : "cloud_phase")}`);
  const origin = s("NOAA Open Data Dissemination (AWS)"), licenseUrl = s(LICENSE_URL), citation = s(`${SENSOR} data courtesy of NOAA via NOAA Open Data Dissemination`);
  const grid = wxfLib.WXFGrid.createWXFGrid(b, 0, 0, 0, 0, 0, 0, 0, false);
  W.startWXF(b);
  W.addFieldId(b, fid); W.addVariableName(b, vname); W.addTimeBasis(b, wxfLib.wxfTimeBasis.ValidTimeOnly); W.addValidTimeMs(b, BigInt(FRAME_TIME_MS));
  W.addGrid(b, grid); W.addTileIndex(b, part); W.addTileCount(b, parts); W.addSensorId(b, sensor); W.addDatasetId(b, dataset); W.addSourceUrl(b, url);
  W.addOriginId(b, origin); W.addLicenseClass(b, wxfLib.wxfLicenseClass.OpenAttribution); W.addLicenseUrl(b, licenseUrl); W.addCitation(b, citation);
  W.finishSizePrefixedWXFBuffer(b, W.endWXF(b));
  return b.asUint8Array().slice();
}
const LICENSE_URL = "https://www.ncei.noaa.gov/access/metadata/landing-page/bin/iso?id=gov.noaa.ncdc:C01502";
const HRSP = { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" };
// hostcap/http-request's answer: an HttpResponse with the body verbatim and the request's CONTEXT echoed.
const response = (field, body, { status = 200, context = jobBytes(field), headers, retrievedMs = RETRIEVED_MS } = {}) =>
  ({ portId: "responses", typeRef: HRSP, payload: encodeHttpResponse({ url: `https://noaa-goes19.s3.amazonaws.com/${key(field)}`, status, headers, body, context, retrievedMs }) });
const RETRIEVED_MS = Date.UTC(2026, 9, 7, 6, 12, 3);
const fileBytes = (field) => new Uint8Array(fs.readFileSync(new URL(EXPECTED[field].file, SET)));

// The SDK harness's BrowserHost answers plugin.getConfig from its `config` option (one ModuleConfig on raw "config", as
// the Go node answers). The hostcall import is only watched, to decode every $PIV request into `wire`.
const instantiate = WebAssembly.instantiate;
async function createHarness(t, config = {}) {
  const wire = [];
  WebAssembly.instantiate = async (module, imports) => {
    const host = imports?.space_data_module_host;
    if (!host) return instantiate(module, imports);
    let memory;
    const wrapped = { ...imports, space_data_module_host: { ...host,
      call: (op, opLen, ptr, len) => {
        const call = decodeHostCall(new Uint8Array(memory.buffer, ptr, len).slice());
        wire.push(call);
        return host.call(op, opLen, ptr, len);
      },
    } };
    const instance = await instantiate(module, wrapped);
    memory = instance.exports.memory;
    return instance;
  };
  t.after(() => { WebAssembly.instantiate = instantiate; });
  const harness = await createBrowserModuleHarness({
    wasmSource: new Uint8Array(fs.readFileSync(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
    hostOptions: { config },
  });
  t.after(() => harness.destroy());
  harness.wire = wire;
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
      assert.equal(r.SOURCE_URL, `s3://noaa-goes19/${key(field)}`);
      assert.equal(Number(r.RETRIEVED_AT), RETRIEVED_MS);
      assert.equal(r.ORIGIN_ID, "NOAA Open Data Dissemination (AWS)");
      assert.equal(r.DATASET_ID, "noaa-goes19");
      assert.equal(r.LICENSE_URL, LICENSE_URL);
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

test("imager-observation-parser artifact passes SDK compliance, every port one concrete type", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const report = await validateArtifactWithStandards({ manifest, wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const [method] = manifest.methods;
  const ids = [...method.inputPorts, ...method.outputPorts].map((port) => {
    assert.equal(port.acceptedTypeSets.length, 1, port.portId);
    assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1, port.portId);
    const [type] = port.acceptedTypeSets[0].allowedTypes;
    assert.equal(type.acceptsAnyFlatbuffer, undefined);
    assert.equal(type.wireFormat, "flatbuffer");
    return [port.portId, type.fileIdentifier];
  });
  assert.deepEqual(ids, [["responses", "HRSP"], ["wxf_meta", "INGQ"], ["wxf_records", "$WXF"]]);
});

test("imager-observation-parser artifact: canonical ABI, WASI + the hostcall bridge (plugin.getConfig) only, no capability", async () => {
  const inspection = await inspectModule(new Uint8Array(fs.readFileSync(ISOMORPHIC_WASM_PATH)));
  assert.deepEqual(Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
  for (const required of ["plugin_alloc", "plugin_free", "plugin_invoke_stream", "plugin_get_manifest_flatbuffer", "plugin_get_manifest_flatbuffer_size"]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")).capabilities, []);
});

for (const field of FIELDS) {
  test(`parse: ${field} (${EXPECTED[field].file.slice(0, 32)}...) equals the reference at 4096, 2048 and 1024`, async (t) => {
    const harness = await createHarness(t);
    const body = fileBytes(field);
    const { response: r, outputs } = await parse(harness, [response(field, body, { headers: { etag: "\"e1\"", "content-type": "application/x-netcdf", "last-modified": "Wed, 07 Oct 2026 06:01:00 GMT" } })]);
    assert.equal(r.statusCode, 0, `${r.errorCode}: ${r.errorMessage}`);
    assert.deepEqual(harness.wire.map((c) => c.op), ["plugin.getConfig"]);
    const records = splitStream(outputs.get("wxf_records").payload);
    assertFieldMatchesReference(field, records);
    assert.equal(outputs.get("wxf_meta").typeRef?.fileIdentifier, "INGQ");
    const meta = decodeIngestRequest(outputs.get("wxf_meta").payload);
    const batchId = createHash("sha256").update(body).digest("hex");
    assert.deepEqual({ ...meta, provenance: undefined }, {
      schema: "WXF.fbs",
      tags: { providerId: "noaa-goes", sourceName: "noaa-goes19-world", batchId, sourceUrl: `s3://noaa-goes19/${key(field)}`, contentKeyId: "public",
        sourcePeer: "source:NOAA Open Data Dissemination (AWS)", license: "LicenseRef-NOAA-Open-Data", licenseUrl: LICENSE_URL,
        citation: `${SENSOR} data courtesy of NOAA via NOAA Open Data Dissemination`, shareAlike: false },
      reconcile: "duplicates", archive: null, provenance: undefined,
    });
    const normalized = createHash("sha256");
    for (const rec of records) normalized.update("WXF.fbs").update(new Uint8Array([0])).update(rec).update(new Uint8Array([0]));
    assert.deepEqual(meta.provenance, { attributes: [], sourceUrl: `s3://noaa-goes19/${key(field)}`, httpStatus: 200, etag: "\"e1\"", lastModified: "Wed, 07 Oct 2026 06:01:00 GMT",
      contentType: "application/x-netcdf", retrievedMs: RETRIEVED_MS, parser: "imager-observation-parser", parserVersion: "imager-observation-parser/v1",
      sourceSha256: batchId, normalizedSha256: normalized.digest("hex"), normalizedCount: records.length, schemaCounts: { "WXF.fbs": records.length }, warnings: [], fromCache: false });
    assert.equal(records.length, Object.values(EXPECTED[field].widths).reduce((n, w) => n + w.bands, 0));
  });
}

test("parse: a file fetched as three byte ranges is joined first (206 parts), same records and batch id", async (t) => {
  const field = "reflectance_064um";
  const bytes = fileBytes(field);
  const cut = [0, 400_000, 900_000, bytes.byteLength];
  const harness = await createHarness(t);
  const inputs = [];
  for (let p = 0; p < 3; p++) inputs.push(response(field, bytes.subarray(cut[p], cut[p + 1]), { status: 206, context: jobBytes(field, { part: p, parts: 3 }) }));
  const { response: r, outputs } = await parse(harness, inputs);
  assert.equal(r.statusCode, 0, `${r.errorCode}: ${r.errorMessage}`);
  assertFieldMatchesReference(field, splitStream(outputs.get("wxf_records").payload));
  assert.equal(decodeIngestRequest(outputs.get("wxf_meta").payload).tags.batchId, createHash("sha256").update(bytes).digest("hex"));
});

test("parse: only the configured widths (imager_widths, a string or a dotted list)", async (t) => {
  const field = "cloud_top_height";
  for (const config of [{ imager_widths: "1024" }, { imager_widths: [2048, 1024] }]) {
    const harness = await createHarness(t, config);
    const { response: r, outputs } = await parse(harness, [response(field, fileBytes(field))]);
    assert.equal(r.statusCode, 0, `${r.errorCode}: ${r.errorMessage}`);
    const widths = new Set(splitStream(outputs.get("wxf_records").payload).map((b) => unpackWxf(b).GRID.NLON));
    assert.deepEqual([...widths], typeof config.imager_widths === "string" ? [1024] : [2048, 1024]);
  }
  const bad = await createHarness(t, { imager_widths: "512" });
  assert.equal((await parse(bad, [response(field, fileBytes(field))])).response.errorCode, "invalid-widths");
});

test("parse refuses what it cannot attribute or read, by name", async (t) => {
  const harness = await createHarness(t);
  const field = "cloud_phase";
  const body = fileBytes(field);
  const cases = [
    [[], "missing-required-input"],   // (refused by the invoke glue: the port is required)
    [[response(field, body, { context: jobBytes(field, { part: 1, parts: 2 }), status: 206 })], "incomplete-file"],
    [[response(field, new Uint8Array(0), { status: 404 })], "fetch-failed"],
    [[response(field, body, { context: new Uint8Array(0) })], "invalid-file-job"],
    [[response(field, body, { context: jobBytes("sea_surface_temperature", { variable: "SST" }) })], "invalid-file-job"],
    [[{ portId: "responses", typeRef: HRSP, payload: new TextEncoder().encode("{\"status\":200}") }], "invalid-response-frame"],
    [[response(field, new TextEncoder().encode("<Error>NoSuchKey</Error>"))], "netcdf-unreadable"],
    [[response(field, body, { context: jobBytes(field, { variable: "NOT_THERE" }) })], "netcdf-unreadable"],
  ];
  for (const [inputs, code] of cases) {
    const { response: r } = await parse(harness, inputs);
    assert.notEqual(r.statusCode, 0, code);
    assert.equal(r.errorCode, code, r.errorMessage);
    assert.equal(r.outputs.length, 0);
  }
});

// NO INPUT FRAME IS EVER DESTROYED SILENTLY (graph task modules-guest-nodes-drop-batched-frames): the compiled flow
// runtime fills an invocation port-blind up to 64 frames, so every response handed over is parsed - two files in one
// invocation are one ingest batch carrying both.
test("parse: two files in one invocation make one batch with both fields' records", async (t) => {
  const harness = await createHarness(t);
  const [a, b] = ["cloud_phase", "cloud_mask"];
  const { response: r, outputs } = await parse(harness, [response(a, fileBytes(a)), response(b, fileBytes(b))]);
  assert.equal(r.statusCode, 0, `${r.errorCode}: ${r.errorMessage}`);
  const records = splitStream(outputs.get("wxf_records").payload);
  const names = records.map((bytes) => unpackWxf(bytes).VARIABLE_NAME);
  assertFieldMatchesReference(a, records.filter((_, k) => names[k] === a));
  assertFieldMatchesReference(b, records.filter((_, k) => names[k] === b));
  const meta = decodeIngestRequest(outputs.get("wxf_meta").payload);
  assert.equal(meta.provenance.normalizedCount, records.length);
  assert.equal(meta.tags.batchId, createHash("sha256").update(fileBytes(a)).update(fileBytes(b)).digest("hex"));
});
