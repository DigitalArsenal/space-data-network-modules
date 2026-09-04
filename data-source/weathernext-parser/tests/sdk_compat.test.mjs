// data-source/weathernext-parser SDK-compat tests: the compiled wasm runs in
// the SDK browser harness against the deterministic fixtures and its records
// are unpacked through the spacedatastandards.org generated JS lib and
// asserted against the SAME expected.json constants the reference parser is
// held to (tests/fixtures/generate-fixtures.mjs). The wasm and the reference
// build records with different builders, so bytes are never compared — decoded
// values are.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire as createModuleRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";


const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ??
  fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const WXF_LIB_URL = new URL("../../../../spacedatastandards.org/lib/js/WXF/main.js", import.meta.url);
const TCT_LIB_URL = new URL("../../../../spacedatastandards.org/lib/js/TCT/main.js", import.meta.url);
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

// Job JSON exactly as the source module's plan / cyclone_request nodes emit it
// (contract D), pointed at the fixture chunk paths.
function chunkJob(name, { codecs = ["bytes"], licenseClass = "Historical" } = {}) {
  const chunk = EXPECTED_CLOUDS.chunks[name];
  const job = EXPECTED_CLOUDS.job;
  return {
    source_url: `https://storage.googleapis.com/weathernext3_spatial/wn3/${chunk.array}/c/${chunk.chunk_index.join("/")}`,
    source_name: job.source_name,
    provider_id: "weathernext",
    array: chunk.array,
    variable_name: chunk.array,
    model_id: job.model_id,
    model_version: "",
    model_class: job.model_class,
    init_time_ms: job.init_time_ms,
    lead_hours: job.lead_hours,
    horizon_hours: job.horizon_hours,
    member_kind: job.member_kind,
    member_index: job.member_index,
    ensemble_size: job.ensemble_size,
    dtype: EXPECTED_CLOUDS.dtype,
    codecs,
    chunk_shape: EXPECTED_CLOUDS.chunk_shape,
    chunk_index: chunk.chunk_index,
    dims: EXPECTED_CLOUDS.dims,
    grid: EXPECTED_CLOUDS.grid,
    license_class: licenseClass,
    license_url: licenseClass === "Historical" ? HISTORICAL_URL : REALTIME_URL,
    citation: "Forecast data (CC BY 4.0)",
    origin_id: job.origin_id,
    dataset_id: job.dataset_id,
  };
}

function cycloneJob({ licenseClass = "Historical" } = {}) {
  return {
    source_url: "https://storage.googleapis.com/weathernext3_spatial/cyclones/cyclone-tracks.csv",
    source_name: EXPECTED_CYCLONES.source_name,
    provider_id: "weathernext",
    archive_source: EXPECTED_CYCLONES.archive.source,
    archive_name: EXPECTED_CYCLONES.archive.name,
    model_id: "weathernext-3",
    model_version: "",
    model_class: "MachineLearnedGlobalEnsemble",
    ensemble_size: EXPECTED_CYCLONES.ensemble_size,
    wind_averaging_period_s: EXPECTED_CYCLONES.wind_averaging_period_s,
    license_class: licenseClass,
    license_url: licenseClass === "Historical" ? HISTORICAL_URL : REALTIME_URL,
    citation: "Forecast data (CC BY 4.0)",
    origin_id: "storage.googleapis.com",
    dataset_id: "weathernext3_spatial",
  };
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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

function readChunk(name, zstd = false) {
  return new Uint8Array(fs.readFileSync(new URL(zstd ? `${name}.zst` : name, CLOUDS)));
}

function sha256Hex(parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

// SDS PIV/TAB aligned typeRefs REQUIRE requiredAlignment and byteLength.
function bytesInput(portId, payload) {
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.byteLength },
    payload,
  };
}

function jsonInput(portId, value) {
  return bytesInput(portId, encoder.encode(JSON.stringify(value)));
}

function jsonResponse(body, headers = {}) {
  return { status: 200, headers, bodyB64: Buffer.from(body).toString("base64") };
}

// hostcap/http-request raw-body-v1 lane: "$HRB" + int32le status + body.
function rawResponseFrame(body, status = 200) {
  const frame = new Uint8Array(8 + body.byteLength);
  frame.set([0x24, 0x48, 0x52, 0x42]);
  new DataView(frame.buffer).setInt32(4, status, true);
  frame.set(body, 8);
  return frame;
}

async function createHarness(t) {
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
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

function jsonFrame(map, portId) {
  const frame = map.get(portId);
  assert.ok(frame, `missing output frame ${portId}`);
  return JSON.parse(decoder.decode(frame.payload));
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

test("weathernext-parser artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("weathernext-parser artifact is pure: canonical ABI, WASI-only imports", async () => {
  const inspection = await inspectModule(readWasm());
  assert.equal(inspection.profile, "standalone");
  const importedModuleNames = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  assert.deepEqual(importedModuleNames, ["wasi_snapshot_preview1"]);
  for (const required of [
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

test("parse_cloud_chunks: bytes-codec chunks -> $WXF tiles matching expected.json", async (t) => {
  const harness = await createHarness(t);
  const inputs = [];
  for (const name of CHUNK_NAMES) inputs.push(jsonInput("jobs", chunkJob(name)));
  for (const name of CHUNK_NAMES) {
    inputs.push(jsonInput("responses", jsonResponse(readChunk(name), { date: DATE_HEADER, etag: '"abc"' })));
  }
  const response = await harness.invoke({ methodId: "parse_cloud_chunks", inputs });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const outputs = outputsByPort(response);

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
    assert.equal(record.SOURCE_URL, chunkJob(CHUNK_NAMES[k]).source_url);
  }

  const meta = jsonFrame(outputs, "wxf_meta");
  assert.equal(meta.schema, "WXF.fbs");
  assert.equal(meta.provider_id, "weathernext");
  assert.equal(meta.source_name, EXPECTED_CLOUDS.job.source_name);
  assert.equal(meta.batch_id, sha256Hex(CHUNK_NAMES.map((name) => readChunk(name))));
  assert.equal(meta.content_key_id, "public");
  assert.equal(meta.source_peer, "source:storage.googleapis.com");
  assert.equal(meta.reconcile, "duplicates");
  assert.equal(meta.license, "CC-BY-4.0");
  assert.equal(meta.license_url, "https://creativecommons.org/licenses/by/4.0/");
  assert.equal(meta.archive, undefined, "field lane archives nothing");
  assert.ok(meta.source_url.startsWith("https://storage.googleapis.com/weathernext3_spatial/wn3/"));
  const provenance = JSON.parse(Buffer.from(meta.provenance.json, "base64").toString("utf8"));
  assert.equal(provenance.parser_version, "weathernext-zarr-wasm/v1");
  assert.equal(provenance.source_sha256, meta.batch_id);
  assert.equal(provenance.normalized_count, CHUNK_NAMES.length);
  assert.deepEqual(provenance.schema_counts, { "WXF.fbs": CHUNK_NAMES.length });
  assert.equal(provenance.etag, '"abc"');
  assert.equal(provenance.retrieved_at, "2026-09-03T12:00:00Z");
  assert.match(provenance.normalized_sha256, /^[0-9a-f]{64}$/);
  assert.equal(outputs.has("raw"), false, "no raw port: the samples ride VALUES");
});

test("parse_cloud_chunks: raw-body-v1 responses and the real-time licence class", async (t) => {
  const harness = await createHarness(t);
  const name = CHUNK_NAMES[0];
  const response = await harness.invoke({
    methodId: "parse_cloud_chunks",
    inputs: [
      jsonInput("jobs", chunkJob(name, { licenseClass: "RealTimeExperimental" })),
      bytesInput("responses", rawResponseFrame(readChunk(name))),
    ],
  });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const outputs = outputsByPort(response);
  const record = unpackWxf(splitStream(outputs.get("wxf_records").payload)[0]);
  assertWxfMatchesExpected(record, name);
  assert.equal(record.LICENSE_CLASS, 0, "RealTimeExperimental");
  assert.equal(record.LICENSE_URL, "https://storage.googleapis.com/weathernext-public/terms-of-use.pdf");
  const meta = jsonFrame(outputs, "wxf_meta");
  assert.equal(meta.license, "LicenseRef-WeatherNext-RealTime-Experimental");
  assert.equal(meta.source_url, chunkJob(name).source_url, "single chunk keeps its URL");
});

test("parse_cloud_chunks: zstd chunks report codec-unsupported in this build", async (t) => {
  const harness = await createHarness(t);
  const name = CHUNK_NAMES[0];
  const response = await harness.invoke({
    methodId: "parse_cloud_chunks",
    inputs: [
      jsonInput("jobs", chunkJob(name, { codecs: ["bytes", "zstd"] })),
      jsonInput("responses", jsonResponse(readChunk(name, true))),
    ],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "codec-unsupported");
  assert.match(response.errorMessage ?? "", /zstd/);
  assert.equal(response.outputs.length, 0);
});

test("parse_cloud_chunks: a non-200 chunk fails the batch", async (t) => {
  const harness = await createHarness(t);
  const name = CHUNK_NAMES[0];
  const response = await harness.invoke({
    methodId: "parse_cloud_chunks",
    inputs: [
      jsonInput("jobs", chunkJob(name)),
      jsonInput("responses", { status: 503, headers: {}, bodyB64: "" }),
    ],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "fetch-failed");
  assert.match(response.errorMessage ?? "", /503/);
});

test("parse_cloud_chunks: jobs and responses must pair one to one", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_cloud_chunks",
    inputs: [
      jsonInput("jobs", chunkJob(CHUNK_NAMES[0])),
      jsonInput("jobs", chunkJob(CHUNK_NAMES[1])),
      jsonInput("jobs", chunkJob(CHUNK_NAMES[2])),
      jsonInput("responses", jsonResponse(readChunk(CHUNK_NAMES[0]))),
      jsonInput("responses", jsonResponse(readChunk(CHUNK_NAMES[1]))),
    ],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "job-response-count-mismatch");
  assert.match(response.errorMessage ?? "", /3 job frames but 2 response frames/);
});

test("parse_cloud_chunks: a short chunk body is refused by size", async (t) => {
  const harness = await createHarness(t);
  const name = CHUNK_NAMES[0];
  const response = await harness.invoke({
    methodId: "parse_cloud_chunks",
    inputs: [
      jsonInput("jobs", chunkJob(name)),
      jsonInput("responses", jsonResponse(readChunk(name).subarray(0, 100))),
    ],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "chunk-size-mismatch");
});

test("parse_cyclone_tracks: CSV -> $TCT tracks matching expected.json, raw passthrough, archive meta", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_cyclone_tracks",
    inputs: [
      jsonInput("job", cycloneJob()),
      jsonInput("response", jsonResponse(CSV_BYTES, { "content-type": "text/csv", date: DATE_HEADER })),
    ],
  });
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
    assert.equal(Number(record.RETRIEVED_AT), Date.UTC(2026, 8, 3, 12, 0, 0));
    for (let i = 0; i < track.points.length; i++) {
      assert.equal(record.POINTS[i].CATEGORY, categories[track.points[i].CATEGORY], `${key} point ${i} category`);
    }
  }

  const meta = jsonFrame(outputs, "tct_meta");
  assert.equal(meta.schema, "TCT.fbs");
  assert.equal(meta.batch_id, EXPECTED_CYCLONES.csv_sha256);
  assert.equal(meta.source_name, EXPECTED_CYCLONES.source_name);
  assert.equal(meta.reconcile, "duplicates");
  assert.deepEqual(meta.archive, EXPECTED_CYCLONES.archive);
  assert.equal(meta.license, "CC-BY-4.0");
  const provenance = JSON.parse(Buffer.from(meta.provenance.json, "base64").toString("utf8"));
  assert.equal(provenance.parser_version, "weathernext-cyclone-wasm/v1");
  assert.equal(provenance.content_type, "text/csv");
  assert.deepEqual(provenance.schema_counts, { "TCT.fbs": EXPECTED_CYCLONES.record_count });

  assert.deepEqual(Buffer.from(outputs.get("raw").payload), Buffer.from(CSV_BYTES), "raw passthrough byte-equal");
});

test("parse_cyclone_tracks: a non-200 fetch fails closed", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_cyclone_tracks",
    inputs: [jsonInput("job", cycloneJob()), jsonInput("response", { status: 503, headers: {}, bodyB64: "" })],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "fetch-failed");
  assert.match(response.errorMessage ?? "", /503/);
});
