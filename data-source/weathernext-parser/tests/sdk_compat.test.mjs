// data-source/weathernext-parser on the typed contracts (1.0): the compiled wasm runs in the SDK browser harness
// against the deterministic fixtures. Its input is what hostcap/http-request answers - HttpResponses (HRSP) whose
// CONTEXT is the parse job as a size-prefixed SDS header record ($WXF per cloud chunk, $TCT for the cyclone tracks),
// exactly as weathernext-source builds them - and its outputs are the record streams, the batch's IngestRequest
// (INGQ) and, for the cyclone lane, the HttpResponse itself for archiving. Records are unpacked through the
// spacedatastandards.org generated JS lib and asserted against the SAME expected.json constants the reference parser
// is held to (tests/fixtures/generate-fixtures.mjs). The only hostcall is plugin.getConfig (the chunk extents, the
// dimension order and the provider id). The wasm and the reference build records with different builders, so bytes
// are never compared - decoded values are.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire as createModuleRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { decodeHostCall, decodeIngestRequest, encodeFlowNotice, encodeHttpResponse } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ??
  fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const WXF_LIB_URL = pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/WXF/main.js"));
const TCT_LIB_URL = pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/TCT/main.js"));
const flatbuffers = createModuleRequire(WXF_LIB_URL)("flatbuffers");
const wxfLib = await import(WXF_LIB_URL.href);
const tctLib = await import(TCT_LIB_URL.href);

const CLOUDS = new URL("./fixtures/wn3-0p1deg-clouds/", import.meta.url);
const CYCLONES = new URL("./fixtures/wn3-cyclones/", import.meta.url);
const EXPECTED_CLOUDS = JSON.parse(fs.readFileSync(new URL("expected.json", CLOUDS), "utf8"));
const EXPECTED_CYCLONES = JSON.parse(fs.readFileSync(new URL("expected.json", CYCLONES), "utf8"));
const CHUNK_NAMES = Object.keys(EXPECTED_CLOUDS.chunks);
const CSV_BYTES = new Uint8Array(fs.readFileSync(new URL("cyclone-tracks.csv", CYCLONES)));

const HISTORICAL_URL = "https://creativecommons.org/licenses/by/4.0/";
const REALTIME_URL = "https://storage.googleapis.com/weathernext-public/terms-of-use.pdf";
const HRSP = { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" };
const LICENSE = { RealTimeExperimental: 0, Historical: 1 };

function sizePrefixed(build) {
  const b = new flatbuffers.Builder(1024);
  build(b);
  return b.asUint8Array().slice();
}

// The chunk's job as weathernext-source:plan builds it: a size-prefixed $WXF header record (no samples) naming the
// field and the chunk's tile on the declared grid.
function chunkContext(name, { codecs = ["bytes"], licenseClass = "Historical", dtype = EXPECTED_CLOUDS.dtype } = {}) {
  const chunk = EXPECTED_CLOUDS.chunks[name];
  const job = EXPECTED_CLOUDS.job;
  const t = new wxfLib.WXFT();
  Object.assign(t, {
    FIELD_ID: EXPECTED_CLOUDS.field_ids[chunk.array], MODEL_CLASS: 1, MODEL_ID: job.model_id, MODEL_VERSION: "",
    INIT_TIME_MS: BigInt(job.init_time_ms), LEAD_HOURS: job.lead_hours, VALID_TIME_MS: BigInt(job.valid_time_ms),
    HORIZON_HOURS: job.horizon_hours, MEMBER_KIND: 0, MEMBER_INDEX: job.member_index, ENSEMBLE_SIZE: job.ensemble_size,
    VARIABLE: { low_cloud_cover: 14, medium_cloud_cover: 13, high_cloud_cover: 12 }[chunk.array], VARIABLE_NAME: chunk.array,
    GRID: Object.assign(new wxfLib.WXFGridT(), { LAT0: chunk.LAT0, LON0: chunk.LON0, DLAT: chunk.DLAT, DLON: chunk.DLON, NLAT: chunk.NLAT, NLON: chunk.NLON, PERIODIC_LON: chunk.PERIODIC_LON }),
    TILE_INDEX: chunk.TILE_INDEX, TILE_COUNT: chunk.TILE_COUNT, CHUNK_DTYPE: dtype, CHUNK_CODECS: codecs,
    ORIGIN_ID: job.origin_id, DATASET_ID: job.dataset_id, SOURCE_URL: chunkUrl(name),
    LICENSE_CLASS: LICENSE[licenseClass], LICENSE_URL: licenseClass === "Historical" ? HISTORICAL_URL : REALTIME_URL,
    CITATION: "Forecast data (CC BY 4.0)",
  });
  return sizePrefixed((b) => wxfLib.WXF.finishSizePrefixedWXFBuffer(b, t.pack(b)));
}
const chunkUrl = (name) => {
  const chunk = EXPECTED_CLOUDS.chunks[name];
  return `https://storage.googleapis.com/weathernext3_spatial/wn3/${chunk.array}/c/${chunk.chunk_index.join("/")}`;
};

// The cyclone job: a size-prefixed $TCT header record (no points).
const CYCLONE_URL = "https://storage.googleapis.com/weathernext3_spatial/cyclones/cyclone-tracks.csv";
function cycloneContext({ licenseClass = "Historical" } = {}) {
  const t = new tctLib.TCTT();
  Object.assign(t, {
    STORM_ID: "", MODEL_CLASS: 1, MODEL_ID: "weathernext-3", MODEL_VERSION: "",
    ENSEMBLE_SIZE: EXPECTED_CYCLONES.ensemble_size, WIND_AVERAGING_PERIOD_S: EXPECTED_CYCLONES.wind_averaging_period_s,
    ORIGIN_ID: "storage.googleapis.com", DATASET_ID: "weathernext3_spatial", SOURCE_URL: CYCLONE_URL,
    LICENSE_CLASS: LICENSE[licenseClass], LICENSE_URL: licenseClass === "Historical" ? HISTORICAL_URL : REALTIME_URL,
    CITATION: "Forecast data (CC BY 4.0)",
  });
  return sizePrefixed((b) => tctLib.TCT.finishSizePrefixedTCTBuffer(b, t.pack(b)));
}

// The SAME expected.json assertions the reference parser is held to
// (tests/reference_parser.test.mjs), applied to a record the wasm built.
function assertWxfMatchesExpected(record, name) {
  const chunk = EXPECTED_CLOUDS.chunks[name];
  const job = EXPECTED_CLOUDS.job;
  assert.equal(record.FIELD_ID, EXPECTED_CLOUDS.field_ids[chunk.array]);
  assert.equal(record.GRID.NLAT, chunk.NLAT);
  assert.equal(record.GRID.NLON, chunk.NLON);
  assert.equal(record.GRID.LAT0, chunk.LAT0);
  assert.equal(record.GRID.LON0, chunk.LON0);
  assert.equal(record.GRID.DLAT, chunk.DLAT);
  assert.equal(record.GRID.DLON, chunk.DLON);
  assert.equal(record.GRID.PERIODIC_LON, chunk.PERIODIC_LON);
  assert.equal(record.TILE_INDEX, chunk.TILE_INDEX);
  assert.equal(record.TILE_COUNT, chunk.TILE_COUNT);
  assert.equal(record.VALUES.length, chunk.cell_count);
  assert.equal(record.VALUE_MIN, Math.fround(chunk.VALUE_MIN));
  assert.equal(record.VALUE_MAX, Math.fround(chunk.VALUE_MAX));
  assert.equal(record.MISSING_COUNT, chunk.MISSING_COUNT);
  for (const spot of chunk.spots) {
    const value = record.VALUES[spot.i * chunk.NLON + spot.j];
    assert.equal(value, Math.fround(spot.value), `spot (${spot.i}, ${spot.j}) of ${name}`);
  }
  let missing = 0;
  for (const value of record.VALUES) if (Number.isNaN(value)) missing++;
  assert.equal(missing, chunk.MISSING_COUNT, "NaN cells inline");
  assert.equal(Number(record.INIT_TIME_MS), job.init_time_ms);
  assert.equal(record.LEAD_HOURS, job.lead_hours);
  assert.equal(Number(record.VALID_TIME_MS), job.init_time_ms + job.lead_hours * 3600000);
  assert.equal(record.HORIZON_HOURS, job.horizon_hours);
  assert.equal(record.MEMBER_INDEX, job.member_index);
  assert.equal(record.ENSEMBLE_SIZE, job.ensemble_size);
  assert.equal(record.VARIABLE_NAME, chunk.array);
  assert.equal(record.UNITS, job.units);
  assert.equal(record.MODEL_ID, job.model_id);
  assert.equal(record.ORIGIN_ID, job.origin_id);
  assert.equal(record.DATASET_ID, job.dataset_id);
  assert.equal(record.PRODUCER_PEER_ID, "", "identity is attached at publication, never guessed");
}

function assertTctMatchesExpected(record, key) {
  const track = EXPECTED_CYCLONES.tracks[key];
  assert.equal(record.STORM_ID, track.STORM_ID);
  assert.equal(record.STORM_NAME, track.STORM_NAME);
  assert.equal(record.MEMBER_INDEX, track.MEMBER_INDEX);
  assert.equal(Number(record.INIT_TIME_MS), track.INIT_TIME_MS);
  assert.equal(record.POINTS.length, track.point_count);
  assert.equal(Number(record.POINTS[0].VALID_TIME_MS), track.first_valid_time_ms);
  assert.equal(Number(record.POINTS.at(-1).VALID_TIME_MS), track.last_valid_time_ms);
  assert.equal(record.ENSEMBLE_SIZE, EXPECTED_CYCLONES.ensemble_size);
  assert.equal(record.WIND_AVERAGING_PERIOD_S, EXPECTED_CYCLONES.wind_averaging_period_s);
  for (let i = 1; i < record.POINTS.length; i++) {
    assert.ok(record.POINTS[i].VALID_TIME_MS > record.POINTS[i - 1].VALID_TIME_MS, "points ascend");
  }
  for (let i = 0; i < track.points.length; i++) {
    const got = record.POINTS[i];
    const want = track.points[i];
    assert.equal(Number(got.VALID_TIME_MS), want.VALID_TIME_MS);
    assert.equal(got.LEAD_HOURS, want.LEAD_HOURS);
    assert.equal(got.LATITUDE, want.LATITUDE);
    assert.equal(got.LONGITUDE, want.LONGITUDE);
    assert.equal(got.MAX_SUSTAINED_WIND_MS, Math.fround(want.MAX_SUSTAINED_WIND_MS));
    assert.equal(got.MIN_CENTRAL_PRESSURE_PA, Math.fround(want.MIN_CENTRAL_PRESSURE_PA));
    assert.equal(got.RADIUS_MAX_WIND_KM, Math.fround(want.RADIUS_MAX_WIND_KM));
    assert.equal(got.EXISTENCE_PROBABILITY, Math.fround(want.EXISTENCE_PROBABILITY));
    assert.equal(got.RADII.length, 3);
    for (let r = 0; r < 3; r++) {
      for (const field of ["THRESHOLD_WIND_MS", "NE_KM", "SE_KM", "SW_KM", "NW_KM"]) {
        assert.equal(got.RADII[r][field], Math.fround(want.RADII[r][field]), `${key} point ${i} radii ${r} ${field}`);
      }
    }
    assert.equal(got.MOTION_DIRECTION_DEG, -1);
    assert.equal(got.MOTION_SPEED_MS, -1);
  }
  return track;
}

const decoder = new TextDecoder();

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const readWasm = () => fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
const readChunk = (name, zstd = false) => new Uint8Array(fs.readFileSync(new URL(zstd ? `${name}.zst` : name, CLOUDS)));

function sha256Hex(parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

// What hostcap/http-request answers: an HttpResponse echoing the request's CONTEXT.
const responseInput = (portId, { body = new Uint8Array(0), status = 200, headers = {}, context, error, retrievedMs, url } = {}) =>
  ({ portId, typeRef: HRSP, payload: encodeHttpResponse({ url, status, headers, body, context, error, retrievedMs }) });
const chunkInput = (name, options = {}, response = {}) =>
  responseInput("responses", { url: chunkUrl(name), body: readChunk(name), context: chunkContext(name, options), ...response });

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
    wasmSource: readWasm(), manifest: readManifest(), surface: "direct",
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
  let off = 0;
  while (off < payload.byteLength) {
    assert.ok(off + 4 <= payload.byteLength, "truncated size prefix");
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

function unpackTct(record) {
  const bb = new flatbuffers.ByteBuffer(Uint8Array.from(record));
  assert.ok(tctLib.TCT.bufferHasIdentifier(bb), "$TCT identifier");
  return tctLib.TCT.getRootAsTCT(bb).unpack();
}

const DATE_HEADER = "Thu, 03 Sep 2026 12:00:00 GMT";

test("weathernext-parser artifact passes SDK compliance with typed ports only", async () => {
  const report = await validateArtifactWithStandards({ manifest: readManifest(), wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const ids = {};
  for (const method of readManifest().methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      assert.equal(port.acceptedTypeSets.length, 1, port.portId);
      assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1, port.portId);
      const [type] = port.acceptedTypeSets[0].allowedTypes;
      assert.equal(type.acceptsAnyFlatbuffer, undefined, port.portId);
      assert.equal(type.wireFormat, "flatbuffer", port.portId);
      ids[`${method.methodId}.${port.portId}`] = type.fileIdentifier;
    }
  }
  assert.deepEqual(ids, {
    "parse_cloud_chunks.responses": "HRSP", "parse_cloud_chunks.wxf_meta": "INGQ", "parse_cloud_chunks.wxf_records": "$WXF",
    "parse_cyclone_tracks.response": "HRSP", "parse_cyclone_tracks.tct_meta": "INGQ", "parse_cyclone_tracks.tct_records": "$TCT", "parse_cyclone_tracks.raw": "HRSP",
  });
  assert.deepEqual(readManifest().capabilities, [], "no capability: plugin.getConfig is the only hostcall");
});

test("weathernext-parser artifact: canonical ABI, imports only WASI and the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  const importedModuleNames = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  assert.deepEqual(importedModuleNames, ["space_data_module_host", "wasi_snapshot_preview1"]);
  for (const required of ["plugin_alloc", "plugin_free", "plugin_invoke_stream", "plugin_get_manifest_flatbuffer", "plugin_get_manifest_flatbuffer_size"]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

test("parse_cloud_chunks: bytes-codec chunk responses (job in CONTEXT) -> $WXF tiles matching expected.json + an IngestRequest", async (t) => {
  const harness = await createHarness(t);
  const inputs = CHUNK_NAMES.map((name) => chunkInput(name, {}, { headers: { date: DATE_HEADER, etag: '"abc"' } }));
  const response = await harness.invoke({ methodId: "parse_cloud_chunks", inputs });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  assert.deepEqual(harness.wire.map((c) => c.op), ["plugin.getConfig"], "one hostcall: the node config");
  const outputs = outputsByPort(response);

  assert.equal(outputs.get("wxf_records").typeRef?.fileIdentifier, "$WXF");
  const records = splitStream(outputs.get("wxf_records").payload);
  assert.equal(records.length, CHUNK_NAMES.length);
  const enums = { low_cloud_cover: 14, medium_cloud_cover: 13, high_cloud_cover: 12 };
  for (let k = 0; k < CHUNK_NAMES.length; k++) {
    assert.equal(decoder.decode(records[k].subarray(4, 8)), "$WXF");
    const record = unpackWxf(records[k]);
    assertWxfMatchesExpected(record, CHUNK_NAMES[k]);
    assert.equal(record.VARIABLE, enums[EXPECTED_CLOUDS.chunks[CHUNK_NAMES[k]].array]);
    assert.equal(record.MODEL_CLASS, 1, "MachineLearnedGlobalEnsemble");
    assert.equal(record.MEMBER_KIND, 0, "Member");
    assert.equal(record.LEVEL_KIND, 4, "EntireAtmosphere");
    assert.equal(record.TEMPORAL_KIND, 0, "Instantaneous");
    assert.equal(record.VALUES_ENCODING, 0, "InlineFloat32");
    assert.equal(record.LICENSE_CLASS, 1, "Historical");
    assert.equal(record.LICENSE_URL, "https://creativecommons.org/licenses/by/4.0/");
    assert.equal(Number(record.RETRIEVED_AT), Date.UTC(2026, 8, 3, 12, 0, 0), "Date header wins");
    assert.equal(record.SOURCE_URL, chunkUrl(CHUNK_NAMES[k]));
  }

  assert.equal(outputs.get("wxf_meta").typeRef?.fileIdentifier, "INGQ");
  const meta = decodeIngestRequest(outputs.get("wxf_meta").payload);
  assert.equal(meta.schema, "WXF.fbs");
  const batchId = sha256Hex(CHUNK_NAMES.map((name) => readChunk(name)));
  assert.equal(meta.tags.providerId, "weathernext");
  assert.equal(meta.tags.sourceName, EXPECTED_CLOUDS.job.source_name);
  assert.equal(meta.tags.batchId, batchId);
  assert.equal(meta.tags.contentKeyId, "public");
  assert.equal(meta.tags.sourcePeer, "source:storage.googleapis.com");
  assert.equal(meta.tags.license, "CC-BY-4.0");
  assert.equal(meta.tags.licenseUrl, "https://creativecommons.org/licenses/by/4.0/");
  assert.equal(meta.tags.citation, "Forecast data (CC BY 4.0)");
  assert.equal(meta.tags.shareAlike, false);
  assert.equal(meta.reconcile, "duplicates");
  assert.equal(meta.archive, null, "field lane archives nothing");
  assert.equal(meta.tags.sourceUrl, "https://storage.googleapis.com/weathernext3_spatial/wn3/");
  const provenance = meta.provenance;
  assert.equal(provenance.sourceUrl, meta.tags.sourceUrl);
  assert.equal(provenance.httpStatus, 200);
  assert.equal(provenance.parserVersion, "weathernext-zarr-wasm/v1");
  assert.equal(provenance.sourceSha256, batchId);
  assert.equal(provenance.normalizedCount, CHUNK_NAMES.length);
  assert.deepEqual(provenance.schemaCounts, { "WXF.fbs": CHUNK_NAMES.length });
  assert.deepEqual(provenance.warnings, []);
  assert.equal(provenance.fromCache, false);
  assert.equal(provenance.etag, '"abc"');
  assert.equal(provenance.retrievedMs, Date.UTC(2026, 8, 3, 12, 0, 0));
  assert.match(provenance.normalizedSha256, /^[0-9a-f]{64}$/);
  assert.equal(outputs.has("raw"), false, "no raw port: the samples ride VALUES");
});

test("parse_cloud_chunks: no Date header -> the host's RETRIEVED_MS; the real-time licence class", async (t) => {
  const harness = await createHarness(t);
  const name = CHUNK_NAMES[0];
  const retrievedMs = Date.UTC(2026, 8, 3, 12, 34, 56, 789);
  const response = await harness.invoke({ methodId: "parse_cloud_chunks", inputs: [chunkInput(name, { licenseClass: "RealTimeExperimental" }, { retrievedMs })] });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const outputs = outputsByPort(response);
  const record = unpackWxf(splitStream(outputs.get("wxf_records").payload)[0]);
  assertWxfMatchesExpected(record, name);
  assert.equal(record.LICENSE_CLASS, 0, "RealTimeExperimental");
  assert.equal(record.LICENSE_URL, REALTIME_URL);
  assert.equal(Number(record.RETRIEVED_AT), retrievedMs);
  const meta = decodeIngestRequest(outputs.get("wxf_meta").payload);
  assert.equal(meta.tags.license, "LicenseRef-WeatherNext-RealTime-Experimental");
  assert.equal(meta.tags.sourceUrl, chunkUrl(name), "single chunk keeps its URL");
  assert.equal(meta.provenance.retrievedMs, Date.UTC(2026, 8, 3, 12, 34, 56), "provenance keeps the whole second");
});

test("parse_cloud_chunks: the provider id and the chunk extents come from the node config", async (t) => {
  const name = CHUNK_NAMES[0];
  const provider = await createHarness(t, { weathernext_provider_id: "prov-test" });
  const ok = await provider.invoke({ methodId: "parse_cloud_chunks", inputs: [chunkInput(name)] });
  assert.equal(decodeIngestRequest(outputsByPort(ok).get("wxf_meta").payload).tags.providerId, "prov-test");
  const extents = await createHarness(t, { weathernext_chunk_lat: 32 });
  const refused = await extents.invoke({ methodId: "parse_cloud_chunks", inputs: [chunkInput(name)] });
  assert.equal(refused.errorCode, "chunk-size-mismatch", "a 64 x 64 body is not a 32 x 64 chunk");
  const dims = await createHarness(t, { weathernext_dims: "init_time,member,lead_time,y,x" });
  assert.equal((await dims.invoke({ methodId: "parse_cloud_chunks", inputs: [chunkInput(name)] })).errorCode, "dims-invalid");
});

test("parse_cloud_chunks: zstd chunks report codec-unsupported in this build", async (t) => {
  const harness = await createHarness(t);
  const name = CHUNK_NAMES[0];
  const response = await harness.invoke({ methodId: "parse_cloud_chunks", inputs: [chunkInput(name, { codecs: ["bytes", "zstd"] }, { body: readChunk(name, true) })] });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "codec-unsupported");
  assert.match(response.errorMessage ?? "", /zstd/);
  assert.equal(response.outputs.length, 0);
});

test("parse_cloud_chunks: a non-200 chunk (or a failed exchange) fails the batch", async (t) => {
  const harness = await createHarness(t);
  const name = CHUNK_NAMES[0];
  const response = await harness.invoke({ methodId: "parse_cloud_chunks", inputs: [chunkInput(name), chunkInput(CHUNK_NAMES[1], {}, { status: 503, body: new Uint8Array(0) })] });
  assert.equal(response.errorCode, "fetch-failed");
  assert.match(response.errorMessage ?? "", /chunk 1 .* 503/);
  const failed = await harness.invoke({ methodId: "parse_cloud_chunks", inputs: [chunkInput(name, {}, { status: 0, body: new Uint8Array(0), error: "timeout: no answer in 90000 ms" })] });
  assert.equal(failed.errorCode, "fetch-failed");
  assert.match(failed.errorMessage ?? "", /status 0 \(timeout: no answer in 90000 ms\)/);
});

test("parse_cloud_chunks: a response without its CONTEXT job, or not an HttpResponse, is refused by name", async (t) => {
  const harness = await createHarness(t);
  const name = CHUNK_NAMES[0];
  const noJob = await harness.invoke({ methodId: "parse_cloud_chunks", inputs: [chunkInput(name), responseInput("responses", { body: readChunk(name) })] });
  assert.equal(noJob.errorCode, "invalid-chunk-job");
  assert.match(noJob.errorMessage, /^chunk job 1: /);
  const wrong = await harness.invoke({ methodId: "parse_cloud_chunks", inputs: [chunkInput(name, {}, { context: cycloneContext() })] });
  assert.equal(wrong.errorCode, "invalid-chunk-job");
  const notResponse = await harness.invoke({ methodId: "parse_cloud_chunks", inputs: [{ portId: "responses", typeRef: HRSP, payload: encodeFlowNotice({ kind: "info" }) }] });
  assert.equal(notResponse.errorCode, "invalid-response-frame");
  for (const r of [noJob, wrong, notResponse]) assert.equal(r.outputs.length, 0);
});

test("parse_cloud_chunks: a short chunk body is refused by size", async (t) => {
  const harness = await createHarness(t);
  const name = CHUNK_NAMES[0];
  const response = await harness.invoke({ methodId: "parse_cloud_chunks", inputs: [chunkInput(name, {}, { body: readChunk(name).subarray(0, 100) })] });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "chunk-size-mismatch");
});

test("parse_cyclone_tracks: CSV -> $TCT tracks matching expected.json, the HttpResponse passed on for archiving, archive naming", async (t) => {
  const harness = await createHarness(t);
  const input = responseInput("response", { url: CYCLONE_URL, body: CSV_BYTES, headers: { "content-type": "text/csv", date: DATE_HEADER }, context: cycloneContext() });
  const response = await harness.invoke({ methodId: "parse_cyclone_tracks", inputs: [input] });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const outputs = outputsByPort(response);

  const records = splitStream(outputs.get("tct_records").payload);
  assert.equal(records.length, EXPECTED_CYCLONES.record_count);
  const categories = { TropicalDepression: 1, TropicalStorm: 2, Category1: 3, Category2: 4, Category3: 5, Category4: 6, Category5: 7 };
  for (let k = 0; k < records.length; k++) {
    assert.equal(decoder.decode(records[k].subarray(4, 8)), "$TCT");
    const key = EXPECTED_CYCLONES.track_order[k];
    const record = unpackTct(records[k]);
    const track = assertTctMatchesExpected(record, key);
    assert.equal(record.BASIN, 1, "NorthAtlantic");
    assert.equal(record.TRACK_KIND, 0, "Forecast");
    assert.equal(record.TRACK_ORIGIN, track.TRACK_ORIGIN === "Genesis" ? 1 : 0);
    assert.equal(record.MEMBER_KIND, 0);
    assert.equal(record.MODEL_CLASS, 1);
    assert.equal(record.MODEL_ID, "weathernext-3");
    assert.equal(record.LICENSE_CLASS, 1);
    assert.equal(record.SOURCE_URL, CYCLONE_URL);
    assert.equal(Number(record.RETRIEVED_AT), Date.UTC(2026, 8, 3, 12, 0, 0));
    for (let i = 0; i < track.points.length; i++) {
      assert.equal(record.POINTS[i].CATEGORY, categories[track.points[i].CATEGORY], `${key} point ${i} category`);
    }
  }

  const meta = decodeIngestRequest(outputs.get("tct_meta").payload);
  assert.equal(meta.schema, "TCT.fbs");
  assert.equal(meta.tags.batchId, EXPECTED_CYCLONES.csv_sha256);
  assert.equal(meta.tags.sourceName, EXPECTED_CYCLONES.source_name);
  assert.equal(meta.tags.sourceUrl, CYCLONE_URL);
  assert.equal(meta.reconcile, "duplicates");
  assert.deepEqual(meta.archive, EXPECTED_CYCLONES.archive);
  assert.equal(meta.tags.license, "CC-BY-4.0");
  assert.equal(meta.provenance.parserVersion, "weathernext-cyclone-wasm/v1");
  assert.equal(meta.provenance.contentType, "text/csv");
  assert.deepEqual(meta.provenance.schemaCounts, { "TCT.fbs": EXPECTED_CYCLONES.record_count });

  const raw = outputs.get("raw");
  assert.equal(raw.typeRef?.fileIdentifier, "HRSP");
  assert.deepEqual(Buffer.from(raw.payload), Buffer.from(input.payload), "the HttpResponse passes on byte-equal (its BODY is the CSV)");
});

test("parse_cyclone_tracks: a non-200 fetch fails closed; a response without its $TCT job is refused", async (t) => {
  const harness = await createHarness(t);
  const failed = await harness.invoke({ methodId: "parse_cyclone_tracks", inputs: [responseInput("response", { status: 503, context: cycloneContext() })] });
  assert.equal(failed.errorCode, "fetch-failed");
  assert.match(failed.errorMessage ?? "", /503/);
  const noJob = await harness.invoke({ methodId: "parse_cyclone_tracks", inputs: [responseInput("response", { body: CSV_BYTES })] });
  assert.equal(noJob.errorCode, "invalid-cyclone-job");
});
