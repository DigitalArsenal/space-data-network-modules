// data-source/nwp-grib2-parser SDK-compat tests on the typed contracts (1.0): HttpResponse (HRSP) frames in, each carrying
// its job - a size-prefixed $WXF header record, as nwp-field-source's plan builds it - in CONTEXT; an IngestRequest (INGQ)
// and a $WXF record stream out. The compiled wasm runs in the SDK browser harness on real NOAA GRIB2
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
import { decodeIngestRequest, encodeFlowNotice, encodeHttpResponse } from "space-data-module-sdk/runtime-contracts";
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
  cloud_cover_low: "LowCloudCover", cloud_cover_mid: "MediumCloudCover", cloud_cover_high: "HighCloudCover", air_temperature_2m: "Temperature2m",
  precipitation_rate_surface: "Unspecified", visibility_surface: "Unspecified", geopotential_height_cloud_ceiling: "GeopotentialHeight" };

const HRSP = { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" };
const CITATION = "NOAA/NCEP Global Forecast System via NOAA Open Data Dissemination (AWS)";

// The job of a fixture file: the $WXF header record (size-prefixed, no values) nwp-field-source's plan puts in
// HttpRequest.CONTEXT and hostcap/http-request echoes back in the HttpResponse.
function job(file, { product = JOBS[file].product, tiles = 1, datasetId = new URL(INVENTORY[file].url).hostname.split(".")[0], fieldId } = {}) {
  const j = JOBS[file];
  const { WXF, WXFGrid } = wxfLib;
  const b = new flatbuffers.Builder(1024);
  const s = (v) => b.createString(v);
  const id = s(fieldId ?? `${j.model_key}:20261006T00:f024:${product}`), modelId = s(j.model_id), name = s(product), url = s(INVENTORY[file].url),
    origin = s("NOAA Open Data Dissemination (AWS)"), dataset = s(datasetId), licenseUrl = s("https://www.weather.gov/disclaimer"), citation = s(CITATION);
  WXFGrid.startWXFGrid(b);
  WXFGrid.addKind(b, wxfLib.wxfGridKind.RegularLatLon); WXFGrid.addDlat(b, j.grid_deg); WXFGrid.addDlon(b, j.grid_deg); WXFGrid.addNlat(b, j.band_rows);
  const grid = WXFGrid.endWXFGrid(b);
  WXF.startWXF(b);
  WXF.addFieldId(b, id); WXF.addModelClass(b, wxfLib.wxfModelClass[j.model_class]); WXF.addModelId(b, modelId);
  WXF.addTimeBasis(b, wxfLib.wxfTimeBasis.Initialization); WXF.addInitTimeMs(b, BigInt(INIT_MS)); WXF.addLeadHours(b, 24); WXF.addValidTimeMs(b, BigInt(INIT_MS + 24 * 3600000));
  WXF.addMemberKind(b, j.spread ? wxfLib.wxfMemberKind.StandardDeviation : wxfLib.wxfMemberKind.Unspecified);
  if (j.ensemble_size) WXF.addEnsembleSize(b, j.ensemble_size);
  WXF.addVariableName(b, name); WXF.addGrid(b, grid); WXF.addTileCount(b, tiles); WXF.addSourceUrl(b, url);
  WXF.addOriginId(b, origin); WXF.addDatasetId(b, dataset); WXF.addLicenseClass(b, wxfLib.wxfLicenseClass.OpenAttribution); WXF.addLicenseUrl(b, licenseUrl); WXF.addCitation(b, citation);
  b.finishSizePrefixed(WXF.endWXF(b), "$WXF");
  return b.asUint8Array().slice();
}
// A byte-range response as hostcap/http-request answers it: the body verbatim, the request's CONTEXT echoed.
function response(file, body, { status = 206, context = job(file), headers = {}, retrievedMs = Date.UTC(2026, 9, 6, 5, 30) } = {}) {
  return { portId: "responses", typeRef: HRSP, payload: encodeHttpResponse({ url: INVENTORY[file].url, status, headers, body, context, retrievedMs }) };
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

test("nwp-grib2-parser artifact passes SDK compliance with typed ports only", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const report = await validateArtifactWithStandards({ manifest, wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const [method] = manifest.methods;
  const ids = Object.fromEntries([...method.inputPorts, ...method.outputPorts].map((p) => {
    assert.equal(p.acceptedTypeSets.length, 1);
    assert.equal(p.acceptedTypeSets[0].allowedTypes.length, 1);
    assert.equal(p.acceptedTypeSets[0].allowedTypes[0].acceptsAnyFlatbuffer, undefined);
    return [p.portId, p.acceptedTypeSets[0].allowedTypes[0].fileIdentifier];
  }));
  assert.deepEqual(ids, { responses: "HRSP", wxf_meta: "INGQ", wxf_records: "$WXF" });
});

test("nwp-grib2-parser artifact is pure: canonical ABI, WASI-only imports", async () => {
  const inspection = await inspectModule(new Uint8Array(fs.readFileSync(ISOMORPHIC_WASM_PATH)));
  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort(), ["wasi_snapshot_preview1"]);
});

for (const file of Object.keys(JOBS)) {
  test(`parse: ${file} - every record's codes equal ecCodes' packing integers`, async (t) => {
    const harness = await createHarness(t);
    const body = gribBytes(file);
    const headers = { etag: "\"5c0ffee\"", "last-modified": "Tue, 06 Oct 2026 03:41:07 GMT", "content-type": "binary/octet-stream" };
    const { response: r, outputs } = await parse(harness, [response(file, body, { headers })]);
    assert.equal(r.statusCode, 0, `${r.errorCode}: ${r.errorMessage}`);
    const records = splitStream(outputs.get("wxf_records").payload);
    assertMatchesEcCodes(file, records);
    for (const bytes of records) assert.equal(Number(unpackWxf(bytes).RETRIEVED_AT), Date.UTC(2026, 9, 6, 5, 30), "the host's receive time");
    const meta = decodeIngestRequest(outputs.get("wxf_meta").payload);
    const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const normalized = createHash("sha256");
    for (const rec of records) normalized.update("WXF.fbs").update(Buffer.of(0)).update(rec).update(Buffer.of(0));
    assert.deepEqual(meta, {
      schema: "WXF.fbs",
      tags: { providerId: "noaa-ncep", sourceName: JOBS[file].product, batchId: sha(body), sourceUrl: INVENTORY[file].url, contentKeyId: "public",
        sourcePeer: "source:NOAA Open Data Dissemination (AWS)", license: "LicenseRef-NOAA-Open-Data", licenseUrl: "https://www.weather.gov/disclaimer", citation: CITATION, shareAlike: false },
      reconcile: "duplicates",
      archive: null,
      provenance: { attributes: [], sourceUrl: INVENTORY[file].url, httpStatus: 206, etag: headers.etag, lastModified: headers["last-modified"], contentType: "binary/octet-stream",
        retrievedMs: Date.UTC(2026, 9, 6, 5, 30), parser: "nwp-grib2-parser", parserVersion: "nwp-grib2-parser/v2", sourceSha256: sha(body),
        normalizedSha256: normalized.digest("hex"), normalizedCount: records.length, schemaCounts: { "WXF.fbs": records.length }, warnings: [], fromCache: false },
    }, "the batch id is the content hash of the fetched bytes");
  });
}

// The sea product's tiles (job tile_deg 11.25: the world-clouds demo's level-4 tiles, x from 180 W, y from the north
// pole, both edges carried): every tile a batch of its own, handed out one an invocation through the backlog; the whole
// field, put back together from its tiles, is ecCodes' packing integers exactly, and a point two tiles share (an edge,
// or the 180th meridian's wrap) carries the same code in both.
// A tiled job (TILE_COUNT 512, 11.25 deg: the world-clouds demo's level-4 tiles, x from 180 W, y from the north pole): the first
// tile's batch out, the other 511 yielded as backlog - a yielded node is resumed without input by the compiled flow
// runtime (flows/nwp-field-ingest/tests puts all 512 back together against ecCodes).
test("parse: a tiled job - the first tile's batch, the other 511 as backlog", async (t) => {
  const harness = await createHarness(t);
  const file = "gfs-0p25-air.grib2";
  const { response: r, outputs } = await parse(harness, [response(file, gribBytes(file), { context: job(file, { tiles: 512 }) })]);
  assert.equal(r.statusCode, 0, `${r.errorCode}: ${r.errorMessage}`);
  assert.equal(r.yielded, true);
  assert.equal(r.backlogRemaining, 511);
  const meta = decodeIngestRequest(outputs.get("wxf_meta").payload);
  assert.equal(meta.tags.batchId, "gfs:20261006T00:f024:s4:0:0");
  assert.equal(meta.tags.sourceName, "gfs-0p25-sea");
  assert.equal(meta.provenance.normalizedCount, EXPECTED[file].length);
  const records = splitStream(outputs.get("wxf_records").payload).map(unpackWxf);
  assert.deepEqual(records.map((r) => r.VARIABLE_NAME).sort(), EXPECTED[file].map((e) => e.name).sort());
  for (const r of records) {
    assert.equal(r.FIELD_ID, `gfs:20261006T00:f24:${r.VARIABLE_NAME}:s4:0:0`);
    assert.deepEqual([r.GRID.LAT0, r.GRID.LON0, r.GRID.NLAT, r.GRID.NLON, r.GRID.PERIODIC_LON, r.TILE_INDEX, r.TILE_COUNT], [78.75, -180, 46, 46, false, 0, 512]);
    // the tile's corner (78.75 N, 180 W) is the whole field's row 675, column 720 (lon 0 E is column 0)
    const e = EXPECTED[file].find((x) => x.name === r.VARIABLE_NAME);
    assert.equal(recordCodes(r).length, 46 * 46);
    assert.ok(Math.abs(r.SCALE_FACTOR - e.scale) <= Math.abs(e.scale) * 1e-15);
  }
});

test("parse: all four products in one invocation are one batch, no frame dropped", async (t) => {
  const harness = await createHarness(t);
  const files = Object.keys(JOBS);
  const { response: r, outputs } = await parse(harness, files.map((f) => response(f, gribBytes(f))));
  assert.equal(r.statusCode, 0, `${r.errorCode}: ${r.errorMessage}`);
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
    const { response: r } = await parse(harness, [response(file, body)]);
    assert.equal(r.errorCode, code, r.errorMessage);
    assert.equal(r.outputs.length, 0);
  }
  const failed = await parse(harness, [response(file, new Uint8Array(0), { status: 404 })]);
  assert.equal(failed.response.errorCode, "fetch-failed");
  const lost = await parse(harness, [response(file, gribBytes(file), { status: 0, context: new Uint8Array(0) })]);
  assert.equal(lost.response.errorCode, "invalid-grib-job", "pairing is by CONTEXT: a response without its job cannot be attributed");
  const notJob = await parse(harness, [response(file, gribBytes(file), { context: encodeFlowNotice({ kind: "info" }) })]);
  assert.equal(notJob.response.errorCode, "invalid-grib-job");
  const unknownDataset = await parse(harness, [response(file, gribBytes(file), { context: job(file, { datasetId: "example-bucket" }) })]);
  assert.match(unknownDataset.response.errorMessage, /dataset "example-bucket" has no provider attribution/);
  const wrongGrid = await parse(harness, [response("gfs-0p50-clouds.grib2", gribBytes("gfs-0p50-clouds.grib2"), { context: job("gfs-0p25-surface.grib2", { product: "gfs-0p50-clouds" }) })]);
  assert.equal(wrongGrid.response.errorCode, "grid-unsupported", "a 0.25 deg job on a 0.5 deg field is refused, not resampled");
});
