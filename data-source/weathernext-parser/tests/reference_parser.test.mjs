// The .ts reference parser against the independently computed expected.json
// (tests/fixtures/generate-fixtures.mjs). Every constant asserted here is
// ARITHMETIC from the fixture generator, never the output of another parser:
// grid geometry, tile index/count, min/max/missing, bit-exact spot cells,
// enum mapping, epochs, identifiers, batch ids and licence carriage.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import {
  LICENSE_ID_HISTORICAL,
  LICENSE_ID_REALTIME,
  PARSER_VERSION_CLOUDS,
  PARSER_VERSION_CYCLONES,
  decodeResponseFrame,
  parseCloudChunks,
  parseCycloneTracks,
  splitStream,
} from "../src/reference/weathernextParser.ts";
import { decodeChunk, halfToFloat } from "../src/reference/zarrChunk.ts";
import { parseCycloneCsv } from "../src/reference/cycloneCsv.ts";

const CLOUDS = new URL("./fixtures/wn3-0p1deg-clouds/", import.meta.url);
const CYCLONES = new URL("./fixtures/wn3-cyclones/", import.meta.url);
const EXPECTED_CLOUDS = JSON.parse(fs.readFileSync(new URL("expected.json", CLOUDS), "utf8"));
const EXPECTED_CYCLONES = JSON.parse(fs.readFileSync(new URL("expected.json", CYCLONES), "utf8"));
const CHUNK_NAMES = Object.keys(EXPECTED_CLOUDS.chunks);
const CSV_BYTES = new Uint8Array(fs.readFileSync(new URL("cyclone-tracks.csv", CYCLONES)));

const HISTORICAL_URL = "https://creativecommons.org/licenses/by/4.0/";
const REALTIME_URL = "https://storage.googleapis.com/weathernext-public/terms-of-use.pdf";
const NOW_MS = Date.UTC(2026, 8, 3, 12, 0, 0);
const decoder = new TextDecoder();

function sha256Hex(parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

function readChunk(name, zstd = false) {
  return new Uint8Array(fs.readFileSync(new URL(zstd ? `${name}.zst` : name, CLOUDS)));
}

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

function response(body, headers = {}) {
  return { status: 200, headers, body };
}

// Every WXF assertion the expected.json carries for one decoded record.
function assertWxfMatchesExpected(record, name, { fieldIds = EXPECTED_CLOUDS.field_ids } = {}) {
  const chunk = EXPECTED_CLOUDS.chunks[name];
  const job = EXPECTED_CLOUDS.job;
  assert.equal(record.FIELD_ID, fieldIds[chunk.array]);
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

test("bytes codec: every chunk decodes to the expected.json constants", () => {
  const jobs = CHUNK_NAMES.map((name) => chunkJob(name));
  const responses = CHUNK_NAMES.map((name) =>
    response(readChunk(name), { date: "Thu, 03 Sep 2026 12:00:00 GMT", etag: '"abc"' }),
  );
  const result = parseCloudChunks(jobs, responses, { nowMs: NOW_MS });
  assert.equal(result.records.length, CHUNK_NAMES.length);
  const enums = { low_cloud_cover: 14, medium_cloud_cover: 13, high_cloud_cover: 12 };
  for (let k = 0; k < CHUNK_NAMES.length; k++) {
    const record = result.records[k];
    assertWxfMatchesExpected(record, CHUNK_NAMES[k]);
    assert.equal(record.VARIABLE, enums[EXPECTED_CLOUDS.chunks[CHUNK_NAMES[k]].array], "wxfVariable mapping");
    assert.equal(record.MODEL_CLASS, 1, "MachineLearnedGlobalEnsemble");
    assert.equal(record.MEMBER_KIND, 0, "Member");
    assert.equal(record.LEVEL_KIND, 4, "EntireAtmosphere");
    assert.equal(record.TEMPORAL_KIND, 0, "Instantaneous");
    assert.equal(record.VALUES_ENCODING, 0, "InlineFloat32");
    assert.equal(record.LICENSE_CLASS, 1, "Historical");
    assert.equal(record.LICENSE_URL, HISTORICAL_URL);
    assert.equal(Number(record.RETRIEVED_AT), Date.UTC(2026, 8, 3, 12, 0, 0), "Date header wins");
    assert.equal(decoder.decode(result.recordBuffers[k].subarray(4, 8)), "$WXF");
  }
  const split = splitStream(result.recordsStream);
  assert.equal(split.length, CHUNK_NAMES.length);
  for (let k = 0; k < split.length; k++) assert.deepEqual(split[k], result.recordBuffers[k]);

  assert.equal(result.meta.schema, "WXF.fbs");
  assert.equal(result.meta.batch_id, sha256Hex(CHUNK_NAMES.map((name) => readChunk(name))));
  assert.equal(result.meta.source_name, EXPECTED_CLOUDS.job.source_name);
  assert.equal(result.meta.provider_id, "weathernext");
  assert.equal(result.meta.source_peer, "source:storage.googleapis.com");
  assert.equal(result.meta.reconcile, "duplicates");
  assert.equal(result.meta.license, LICENSE_ID_HISTORICAL);
  assert.equal(result.meta.license_url, HISTORICAL_URL);
  assert.equal(result.meta.archive, undefined, "field lane archives nothing");
  const provenance = JSON.parse(Buffer.from(result.meta.provenance.json, "base64").toString("utf8"));
  assert.equal(provenance.parser_version, PARSER_VERSION_CLOUDS);
  assert.equal(provenance.source_sha256, result.meta.batch_id);
  assert.equal(provenance.normalized_count, CHUNK_NAMES.length);
  assert.deepEqual(provenance.schema_counts, { "WXF.fbs": CHUNK_NAMES.length });
  assert.equal(provenance.etag, '"abc"');
  assert.equal(provenance.retrieved_at, "2026-09-03T12:00:00Z");
});

test("zstd codec: identical VALUES to the bytes variant", () => {
  const plain = parseCloudChunks(
    CHUNK_NAMES.map((name) => chunkJob(name)),
    CHUNK_NAMES.map((name) => response(readChunk(name))),
    { nowMs: NOW_MS },
  );
  const zstd = parseCloudChunks(
    CHUNK_NAMES.map((name) => chunkJob(name, { codecs: ["bytes", "zstd"] })),
    CHUNK_NAMES.map((name) => response(readChunk(name, true))),
    { nowMs: NOW_MS },
  );
  for (let k = 0; k < CHUNK_NAMES.length; k++) {
    const chunk = EXPECTED_CLOUDS.chunks[CHUNK_NAMES[k]];
    assert.equal(sha256Hex([readChunk(CHUNK_NAMES[k], true)]), chunk.zst_sha256);
    assert.equal(zstd.records[k].VALUES.length, plain.records[k].VALUES.length);
    for (let i = 0; i < plain.records[k].VALUES.length; i++) {
      assert.ok(Object.is(zstd.records[k].VALUES[i], plain.records[k].VALUES[i]), `cell ${i} of ${CHUNK_NAMES[k]}`);
    }
    assertWxfMatchesExpected(zstd.records[k], CHUNK_NAMES[k]);
  }
  assert.equal(zstd.meta.batch_id, sha256Hex(CHUNK_NAMES.map((name) => readChunk(name, true))));
});

test("real-time licence class rides the job into record and meta", () => {
  const name = CHUNK_NAMES[0];
  const result = parseCloudChunks([chunkJob(name, { licenseClass: "RealTimeExperimental" })], [response(readChunk(name))], { nowMs: NOW_MS });
  assert.equal(result.records[0].LICENSE_CLASS, 0);
  assert.equal(result.records[0].LICENSE_URL, REALTIME_URL);
  assert.equal(result.meta.license, LICENSE_ID_REALTIME);
  assert.equal(result.meta.license_url, REALTIME_URL);
  assert.equal(result.meta.source_url, chunkJob(name).source_url, "single chunk keeps its URL");
  assert.equal(Number(result.records[0].RETRIEVED_AT), NOW_MS, "no Date header -> clock");
});

test("a chunk whose byte length disagrees with the declared shape is refused", () => {
  const name = CHUNK_NAMES[0];
  const short = readChunk(name).subarray(0, 100);
  assert.throws(() => parseCloudChunks([chunkJob(name)], [response(short)]), /chunk-size-mismatch/);
  assert.throws(
    () => parseCloudChunks([chunkJob(name), chunkJob(name)], [response(readChunk(name))]),
    /job-response-count-mismatch/,
  );
  assert.throws(() => parseCloudChunks([chunkJob(name)], [{ status: 503, headers: {}, body: new Uint8Array(0) }]), /fetch-failed.*503/);
  assert.throws(
    () => parseCloudChunks([chunkJob(name, { codecs: ["bytes", "blosc"] })], [response(readChunk(name))]),
    /codec-unsupported/,
  );
});

test("float16 chunks decode bit-exactly", () => {
  // 1.0, -2.0, 0.5, NaN, +inf, smallest subnormal as binary16.
  const halves = [0x3c00, 0xc000, 0x3800, 0x7e00, 0x7c00, 0x0001];
  const bytes = new Uint8Array(halves.length * 2);
  const view = new DataView(bytes.buffer);
  halves.forEach((half, i) => view.setUint16(i * 2, half, true));
  const cells = decodeChunk(bytes, { codecs: ["bytes"], dataType: "float16", chunkShape: [1, 6] });
  assert.equal(cells[0], 1);
  assert.equal(cells[1], -2);
  assert.equal(cells[2], 0.5);
  assert.ok(Number.isNaN(cells[3]));
  assert.equal(cells[4], Number.POSITIVE_INFINITY);
  assert.equal(cells[5], Math.fround(2 ** -24));
  assert.equal(halfToFloat(0x0001), 2 ** -24);
});

test("http response frames decode from both the JSON and raw-body-v1 lanes", () => {
  const body = readChunk(CHUNK_NAMES[0]);
  const json = new TextEncoder().encode(
    JSON.stringify({ status: 200, headers: { Date: "Thu, 03 Sep 2026 12:00:00 GMT" }, bodyB64: Buffer.from(body).toString("base64") }),
  );
  const fromJson = decodeResponseFrame(json);
  assert.equal(fromJson.status, 200);
  assert.equal(fromJson.headers.date, "Thu, 03 Sep 2026 12:00:00 GMT");
  assert.deepEqual(fromJson.body, body);
  const raw = new Uint8Array(8 + body.byteLength);
  raw.set([0x24, 0x48, 0x52, 0x42]);
  new DataView(raw.buffer).setInt32(4, 200, true);
  raw.set(body, 8);
  const fromRaw = decodeResponseFrame(raw);
  assert.equal(fromRaw.status, 200);
  assert.deepEqual(fromRaw.body, body);
});

test("cyclone CSV: every track matches expected.json", () => {
  const csv = parseCycloneCsv(decoder.decode(CSV_BYTES));
  assert.equal(csv.rows.length, EXPECTED_CYCLONES.row_count);
  assert.equal(csv.header.length, 26);

  const result = parseCycloneTracks(cycloneJob(), response(CSV_BYTES, { "content-type": "text/csv" }), { nowMs: NOW_MS });
  assert.equal(result.records.length, EXPECTED_CYCLONES.record_count);
  for (let k = 0; k < EXPECTED_CYCLONES.track_order.length; k++) {
    const key = EXPECTED_CYCLONES.track_order[k];
    const record = result.records[k];
    const track = assertTctMatchesExpected(record, key);
    assert.equal(record.BASIN, 1, "NorthAtlantic");
    assert.equal(record.TRACK_KIND, 0, "Forecast");
    assert.equal(record.TRACK_ORIGIN, track.TRACK_ORIGIN === "Genesis" ? 1 : 0);
    assert.equal(record.MEMBER_KIND, 0, "Member");
    assert.equal(record.MODEL_CLASS, 1);
    assert.equal(record.LICENSE_CLASS, 1);
    const categories = { TropicalDepression: 1, TropicalStorm: 2, Category1: 3, Category2: 4, Category3: 5, Category4: 6, Category5: 7 };
    for (let i = 0; i < track.points.length; i++) {
      assert.equal(record.POINTS[i].CATEGORY, categories[track.points[i].CATEGORY], `${key} point ${i} category`);
    }
    assert.equal(decoder.decode(result.recordBuffers[k].subarray(4, 8)), "$TCT");
  }
  assert.equal(result.records[1].TRACK_ORIGIN, 1, "storm 2 is a genesis system");
  assert.equal(result.records[0].TRACK_ORIGIN, 0, "storm 1 existed at initialisation");
  assert.equal(result.records[0].POINTS[0].LONGITUDE, -60, "300 E normalises to -60");
  assert.equal(result.records[0].POINTS[0].RADII[0].NE_KM, 0, "zero radius stays 0");
  assert.equal(result.records[1].POINTS[0].RADIUS_MAX_WIND_KM, -1, "blank radius -> -1");
  assert.equal(result.records[1].POINTS[0].RADII[0].NE_KM, -1, "blank quadrant -> -1");

  assert.equal(result.meta.schema, "TCT.fbs");
  assert.equal(result.meta.batch_id, EXPECTED_CYCLONES.csv_sha256);
  assert.deepEqual(result.meta.archive, EXPECTED_CYCLONES.archive);
  assert.equal(result.meta.license, LICENSE_ID_HISTORICAL);
  const provenance = JSON.parse(Buffer.from(result.meta.provenance.json, "base64").toString("utf8"));
  assert.equal(provenance.parser_version, PARSER_VERSION_CYCLONES);
  assert.equal(provenance.content_type, "text/csv");
  assert.deepEqual(provenance.schema_counts, { "TCT.fbs": EXPECTED_CYCLONES.record_count });
  assert.equal(splitStream(result.recordsStream).length, EXPECTED_CYCLONES.record_count);
});

test("cyclone CSV: a non-200 fetch fails closed", () => {
  assert.throws(() => parseCycloneTracks(cycloneJob(), { status: 503, headers: {}, body: new Uint8Array(0) }), /fetch-failed.*503/);
});
