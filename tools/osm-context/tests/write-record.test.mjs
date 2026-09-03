// The record writer against the prototype's saved header. No Java, no network.
//
// tests/fixtures/hessen.header.bin is the first 127 bytes of the prototype's
// Hessen archive, verbatim. tests/fixtures/hessen-header-only.pmtiles is that
// header with its offsets patched so the root directory (47 B) and the gzipped
// metadata (624 B) follow it directly — a 798-byte archive with no tiles whose
// header still describes the real build (13,150 tiles, z0–14, Hessen bounds).
// The expected record is evidence/osm-context-hessen-20260902T202051Z.vtt.json,
// which write_record.py wrote from the real 107 MB archive; everything but the
// payload size and digest must come out identical.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import zlib from "node:zlib";

import {
  buildTilesetRecord,
  compactEpoch,
  decodePmtilesMetadata,
  defaultRecordPath,
  formatRecord,
  parsePmtilesHeader,
  PMTILES_HEADER_BYTES,
  readPmtilesArchive,
  REPLICATION_TIME_KEY,
} from "../write-record.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIXTURES = path.join(HERE, "fixtures");
const HEADER = path.join(FIXTURES, "hessen.header.bin");
const ARCHIVE = path.join(FIXTURES, "hessen-header-only.pmtiles");
const EVIDENCE = path.join(HERE, "..", "evidence", "osm-context-hessen-20260902T202051Z.vtt.json");
const WRITE_RECORD = path.join(HERE, "..", "write-record.mjs");

// What the prototype's `pmtiles show` and the Python reader printed for the
// real archive (evidence/run-hessen.txt, BUILD-EVIDENCE.md).
const HESSEN = {
  region: "hessen",
  sourceUrl: "https://download.geofabrik.de/europe/germany/hessen-latest.osm.pbf",
  epoch: "2026-09-02T20:20:51Z",
  retrievedAt: "2026-09-03T18:56:15Z",
  processor: "planetiler 0.10.2",
};

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osm-context-record-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the verbatim Hessen header parses to the values the Python reader printed", () => {
  const bytes = fs.readFileSync(HEADER);
  assert.equal(bytes.length, PMTILES_HEADER_BYTES);
  const header = parsePmtilesHeader(bytes);
  assert.deepEqual(header, {
    version: 3,
    root_dir_offset: 127,
    root_dir_length: 47,
    metadata_offset: 107057377,
    metadata_length: 624,
    leaf_dirs_offset: 107058001,
    leaf_dirs_length: 28167,
    tile_data_offset: 16384,
    tile_data_length: 107040993,
    addressed_tiles_count: 13150,
    tile_entries_count: 13150,
    tile_contents_count: 13150,
    clustered: true,
    internal_compression: "gzip",
    tile_compression: "gzip",
    tile_type: "mvt",
    min_zoom: 0,
    max_zoom: 14,
    min_lon_e7: 77680210,
    min_lat_e7: 493932120,
    max_lon_e7: 102459520,
    max_lat_e7: 516591580,
    center_zoom: 7,
    center_lon_e7: 90069865,
    center_lat_e7: 505261850,
  });
  // The sections the header describes add up to the real archive's byte count.
  assert.equal(header.leaf_dirs_offset + header.leaf_dirs_length, 107086168);
});

test("a header that is not PMTiles v3 is refused", () => {
  const bytes = Buffer.from(fs.readFileSync(HEADER));
  assert.throws(() => parsePmtilesHeader(bytes.subarray(0, 100)), /127 bytes/);
  const wrongMagic = Buffer.from(bytes);
  wrongMagic.write("PMTilez", 0, "latin1");
  assert.throws(() => parsePmtilesHeader(wrongMagic), /not a PMTiles archive/);
  const wrongVersion = Buffer.from(bytes);
  wrongVersion[7] = 2;
  assert.throws(() => parsePmtilesHeader(wrongVersion), /spec version 2/);
  const unknownCompression = Buffer.from(bytes);
  unknownCompression[97] = 9;
  assert.throws(() => parsePmtilesHeader(unknownCompression), /internal compression code 9/);
});

test("metadata decodes from gzip or none and nothing else", () => {
  const json = Buffer.from(JSON.stringify({ vector_layers: [] }));
  assert.deepEqual(decodePmtilesMetadata(zlib.gzipSync(json), "gzip"), { vector_layers: [] });
  assert.deepEqual(decodePmtilesMetadata(json, "none"), { vector_layers: [] });
  assert.throws(() => decodePmtilesMetadata(zlib.brotliCompressSync(json), "brotli"), /brotli is not supported/);
  assert.throws(() => decodePmtilesMetadata(Buffer.from("[]"), "none"), /not a JSON object/);
});

test("the header-only archive reads back as the real build's header, metadata and its own digest", () => {
  const archive = readPmtilesArchive(ARCHIVE);
  const bytes = fs.readFileSync(ARCHIVE);
  assert.equal(archive.sizeBytes, 798);
  assert.equal(archive.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(archive.header.root_dir_offset, 127);
  assert.equal(archive.header.root_dir_length, 47);
  assert.equal(archive.header.metadata_offset, 174);
  assert.equal(archive.header.metadata_length, 624);
  assert.equal(archive.header.addressed_tiles_count, 13150);
  assert.equal(archive.metadata.name, "osm-context");
  assert.equal(archive.metadata["planetiler:version"], "0.10.2");
  assert.equal(archive.metadata[REPLICATION_TIME_KEY], "2026-09-02T20:20:51Z");
  assert.equal(archive.metadata["planetiler:osm:osmosisreplicationseq"], "4890");
  assert.deepEqual(archive.metadata.vector_layers.map((layer) => layer.id), ["aeroway", "building", "industrial", "parking", "rail", "road", "water"]);
  assert.match(archive.metadata.attribution, /OpenStreetMap contributors/);
});

test("the record matches the prototype's saved output except for the payload bytes", () => {
  const archive = readPmtilesArchive(ARCHIVE);
  const record = buildTilesetRecord({ ...archive, ...HESSEN });
  const expected = JSON.parse(fs.readFileSync(EVIDENCE, "utf8"));
  assert.equal(record.PAYLOAD.SIZE_BYTES, 798);
  assert.equal(record.PAYLOAD.DIGEST, `sha256:${archive.sha256}`);
  const comparable = { ...record, PAYLOAD: { ...record.PAYLOAD, SIZE_BYTES: expected.PAYLOAD.SIZE_BYTES, DIGEST: expected.PAYLOAD.DIGEST } };
  assert.deepEqual(comparable, expected);
  // Key order is part of the shape: the serialized text must be the prototype's.
  assert.equal(formatRecord(comparable), fs.readFileSync(EVIDENCE, "utf8"));
});

test("formatRecord writes the bytes json.dump(indent=2, ensure_ascii=False) wrote", () => {
  const text = fs.readFileSync(EVIDENCE, "utf8");
  assert.equal(formatRecord(JSON.parse(text)), text);
  assert.match(text, /© OpenStreetMap contributors/);
});

test("the epoch is taken from the archive when not given and refused when it disagrees", () => {
  const archive = readPmtilesArchive(ARCHIVE);
  const { epoch: _omitted, ...withoutEpoch } = HESSEN;
  const record = buildTilesetRecord({ ...archive, ...withoutEpoch });
  assert.equal(record.PROVENANCE.DATASET_EPOCH, "2026-09-02T20:20:51Z");
  assert.equal(record.TILESET_ID, "osm-context-hessen-20260902T202051Z");
  assert.throws(() => buildTilesetRecord({ ...archive, ...HESSEN, epoch: "2026-09-01T20:20:51Z" }), /disagrees with the archive/);
  const noEpoch = { ...archive, metadata: { ...archive.metadata } };
  delete noEpoch.metadata[REPLICATION_TIME_KEY];
  assert.throws(() => buildTilesetRecord({ ...noEpoch, ...withoutEpoch }), /no epoch/);
  assert.equal(buildTilesetRecord({ ...noEpoch, ...HESSEN }).PROVENANCE.DATASET_EPOCH, HESSEN.epoch);
});

test("inputs that would produce a lying record are refused", () => {
  const archive = readPmtilesArchive(ARCHIVE);
  assert.throws(() => buildTilesetRecord({ ...archive, ...HESSEN, region: "Hessen" }), /lower-case/);
  assert.throws(() => buildTilesetRecord({ ...archive, ...HESSEN, sourceUrl: "http://download.geofabrik.de/x.pbf" }), /https URL/);
  assert.throws(() => buildTilesetRecord({ ...archive, ...HESSEN, retrievedAt: "2026-09-03" }), /retrieved-at/);
  assert.throws(() => buildTilesetRecord({ ...archive, ...HESSEN, processor: " " }), /processor/);
  assert.throws(() => buildTilesetRecord({ ...archive, ...HESSEN, header: { ...archive.header, tile_type: "png" } }), /tile type is png/);
  assert.throws(() => buildTilesetRecord({ ...archive, ...HESSEN, metadata: { ...archive.metadata, vector_layers: [] } }), /no vector_layers/);
  assert.throws(() => compactEpoch("2026-09-02 20:20:51"), /not YYYY-MM-DD/);
  assert.equal(compactEpoch("2026-09-02T20:20:51Z"), "20260902T202051Z");
  assert.equal(defaultRecordPath("/x/osm-context-hessen-20260902T202051Z.pmtiles"), "/x/osm-context-hessen-20260902T202051Z.vtt.json");
  assert.throws(() => defaultRecordPath("/x/archive.mbtiles"), /does not end in \.pmtiles/);
});

test("layer fields are sorted and per-layer zooms fall back to the header's", () => {
  const archive = readPmtilesArchive(ARCHIVE);
  const metadata = {
    ...archive.metadata,
    vector_layers: [{ id: "building", fields: { "roof:shape": "String", height: "Number", "building:levels": "Number", min_height: "Number" } }],
  };
  const record = buildTilesetRecord({ ...archive, metadata, ...HESSEN });
  assert.deepEqual(record.LAYERS, [{ NAME: "building", MIN_ZOOM: 0, MAX_ZOOM: 14, FIELDS: ["building:levels", "height", "min_height", "roof:shape"] }]);
});

test("the CLI writes the record beside the archive and prints it", async (t) => {
  const dir = temporary(t);
  const archive = path.join(dir, "osm-context-hessen-20260902T202051Z.pmtiles");
  fs.copyFileSync(ARCHIVE, archive);
  const { stdout } = await execFileAsync(process.execPath, [
    WRITE_RECORD,
    "--archive", archive,
    "--region", HESSEN.region,
    "--source-url", HESSEN.sourceUrl,
    "--retrieved-at", HESSEN.retrievedAt,
    "--processor", HESSEN.processor,
  ]);
  const written = fs.readFileSync(path.join(dir, "osm-context-hessen-20260902T202051Z.vtt.json"), "utf8");
  assert.equal(stdout, written);
  const record = JSON.parse(written);
  assert.equal(record.TILESET_ID, "osm-context-hessen-20260902T202051Z");
  assert.equal(record.PAYLOAD.SIZE_BYTES, 798);
  await assert.rejects(
    execFileAsync(process.execPath, [WRITE_RECORD, "--archive", archive, "--region", "hessen"]),
    (error) => /--source-url is required/.test(error.stderr) && error.code === 1,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [WRITE_RECORD, "--archive", archive, "--region", HESSEN.region, "--source-url", HESSEN.sourceUrl,
      "--retrieved-at", HESSEN.retrievedAt, "--processor", HESSEN.processor, "--epoch", "2026-01-01T00:00:00Z"]),
    (error) => /disagrees with the archive/.test(error.stderr) && error.code === 1,
  );
});
