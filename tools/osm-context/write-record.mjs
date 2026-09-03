// tools/osm-context/write-record.mjs — the tileset record for one PMTiles archive.
//
// WHAT THIS IS. The port of the prototype's tools/write_record.py, so the
// builder has one runtime (Node) instead of Node plus a Python venv carrying
// the pmtiles package. It reads the archive's 127-byte PMTiles v3 header and
// the TileJSON-style metadata embedded behind it (planetiler writes the
// `vector_layers` list, the attribution and the OSM replication epoch there),
// digests the whole file, and writes the record build.mjs places beside the
// archive. Nothing here decodes a tile.
//
// THE RECORD IS A FIXTURE, NOT YET A STANDARD. Phase 1 of the plan puts a
// $VTT (Vector Tile Tileset) table into spacedatastandards.org, modeled on
// $DTT; until that release exists there is no IDL to be exact against. So this
// writes the DTT-shaped JSON the prototype wrote — the same keys in the same
// order with the same values (evidence/*.vtt.json) — and claims nothing more.
// When $VTT lands this file grows a projector like
// tools/terrain-pyramid/dtt-projection.mjs and the record gets its FlatBuffer
// form beside the JSON. The CID stays empty until the archive is pinned,
// which is the publisher's step, not this one.
//
// THE EPOCH IS CHECKED, NOT COPIED. DATASET_EPOCH is the Geofabrik replication
// timestamp of the extract. planetiler copies the extract header's own
// replication timestamp into the archive metadata
// (`planetiler:osm:osmosisreplicationtime`); a caller that states an epoch is
// checked against it and a disagreement is refused, because the two only
// differ when the extract and its state file came from different Geofabrik
// runs — and a record that names the wrong map is worse than no record.
//
//   node tools/osm-context/write-record.mjs \
//     --archive out/osm-context-hessen-20260902T202051Z.pmtiles --region hessen \
//     --source-url https://download.geofabrik.de/europe/germany/hessen-latest.osm.pbf \
//     --retrieved-at 2026-09-03T18:56:15Z --processor "planetiler 0.10.2" \
//     [--epoch 2026-09-02T20:20:51Z] [--out <file.vtt.json>]
//
// --out defaults to the archive path with .pmtiles replaced by .vtt.json; the
// record is also printed, as the prototype did.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

export const PMTILES_HEADER_BYTES = 127;
export const PMTILES_MEDIA_TYPE = "application/vnd.pmtiles";
export const REPLICATION_TIME_KEY = "planetiler:osm:osmosisreplicationtime";
// A planetiler metadata block is a few hundred bytes; anything approaching
// this is not one, and the allocation is refused before it happens.
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const PMTILES_MAGIC = "PMTiles";
const COMPRESSION = ["unknown", "none", "gzip", "brotli", "zstd"];
const TILE_TYPE = ["unknown", "mvt", "png", "jpeg", "webp", "avif"];
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const REGION_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Parse the fixed 127-byte PMTiles v3 header (all integers little-endian).
 * Field names follow the spec so a reader can check them against it.
 */
export function parsePmtilesHeader(bytes) {
  assert.ok(bytes instanceof Uint8Array, "header bytes must be a Buffer or Uint8Array");
  assert.ok(bytes.length >= PMTILES_HEADER_BYTES, `a PMTiles header is ${PMTILES_HEADER_BYTES} bytes, got ${bytes.length}`);
  const magic = Buffer.from(bytes.subarray(0, PMTILES_MAGIC.length)).toString("latin1");
  if (magic !== PMTILES_MAGIC) throw new Error(`not a PMTiles archive (magic ${JSON.stringify(magic)})`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(7);
  if (version !== 3) throw new Error(`PMTiles spec version ${version} is not supported (this reads version 3)`);
  const u64 = (offset) => {
    const value = view.getBigUint64(offset, true);
    assert.ok(value <= BigInt(Number.MAX_SAFE_INTEGER), `header u64 at byte ${offset} exceeds JavaScript's safe range`);
    return Number(value);
  };
  const u8 = (offset) => view.getUint8(offset);
  const i32 = (offset) => view.getInt32(offset, true);
  const named = (table, code, what) => {
    const name = table[code];
    if (name === undefined) throw new Error(`PMTiles ${what} code ${code} is not defined by spec version 3`);
    return name;
  };
  return {
    version,
    root_dir_offset: u64(8),
    root_dir_length: u64(16),
    metadata_offset: u64(24),
    metadata_length: u64(32),
    leaf_dirs_offset: u64(40),
    leaf_dirs_length: u64(48),
    tile_data_offset: u64(56),
    tile_data_length: u64(64),
    addressed_tiles_count: u64(72),
    tile_entries_count: u64(80),
    tile_contents_count: u64(88),
    clustered: u8(96) === 1,
    internal_compression: named(COMPRESSION, u8(97), "internal compression"),
    tile_compression: named(COMPRESSION, u8(98), "tile compression"),
    tile_type: named(TILE_TYPE, u8(99), "tile type"),
    min_zoom: u8(100),
    max_zoom: u8(101),
    min_lon_e7: i32(102),
    min_lat_e7: i32(106),
    max_lon_e7: i32(110),
    max_lat_e7: i32(114),
    center_zoom: u8(118),
    center_lon_e7: i32(119),
    center_lat_e7: i32(123),
  };
}

/** Decode the metadata section: JSON, compressed as the header's internal_compression says. */
export function decodePmtilesMetadata(bytes, compression) {
  let json;
  if (compression === "gzip") json = zlib.gunzipSync(bytes);
  else if (compression === "none") json = bytes;
  else throw new Error(`PMTiles internal compression ${compression} is not supported here (planetiler writes gzip)`);
  const metadata = JSON.parse(Buffer.from(json).toString("utf8"));
  assert.ok(metadata && typeof metadata === "object" && !Array.isArray(metadata), "PMTiles metadata is not a JSON object");
  return metadata;
}

/** 2026-09-02T20:20:51Z -> 20260902T202051Z, the form used in file and tileset names. */
export function compactEpoch(epoch) {
  assert.match(epoch, ISO_SECONDS, `epoch ${JSON.stringify(epoch)} is not YYYY-MM-DDTHH:MM:SSZ`);
  return epoch.replace(/[-:]/g, "");
}

/**
 * Read header, metadata, byte count and sha256 of an archive in one pass over
 * a regular file that must not change underneath the read.
 */
export function readPmtilesArchive(file) {
  const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(handle, { bigint: true });
    assert.ok(before.isFile(), `${file} is not a regular file`);
    assert.ok(before.size <= BigInt(Number.MAX_SAFE_INTEGER), `${file} exceeds JavaScript's safe byte range`);
    const sizeBytes = Number(before.size);
    assert.ok(sizeBytes >= PMTILES_HEADER_BYTES, `${file}: ${sizeBytes} bytes is shorter than a PMTiles header`);
    const headerBytes = Buffer.alloc(PMTILES_HEADER_BYTES);
    assert.equal(fs.readSync(handle, headerBytes, 0, PMTILES_HEADER_BYTES, 0), PMTILES_HEADER_BYTES, `${file}: short read on the header`);
    const header = parsePmtilesHeader(headerBytes);
    assert.ok(header.metadata_length <= MAX_METADATA_BYTES, `${file}: metadata section of ${header.metadata_length} bytes is not a tileset metadata block`);
    assert.ok(header.metadata_offset + header.metadata_length <= sizeBytes, `${file}: metadata section lies outside the file`);
    const metadataBytes = Buffer.alloc(header.metadata_length);
    if (header.metadata_length > 0) {
      assert.equal(fs.readSync(handle, metadataBytes, 0, header.metadata_length, header.metadata_offset), header.metadata_length, `${file}: short read on the metadata`);
    }
    const metadata = decodePmtilesMetadata(metadataBytes, header.internal_compression);
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(1 << 20);
    let offset = 0;
    while (offset < sizeBytes) {
      const read = fs.readSync(handle, chunk, 0, Math.min(chunk.length, sizeBytes - offset), offset);
      assert.ok(read > 0, `${file} ended while being digested`);
      hash.update(chunk.subarray(0, read));
      offset += read;
    }
    const after = fs.fstatSync(handle, { bigint: true });
    assert.equal(after.size, before.size, `${file} changed size while being read`);
    assert.equal(after.mtimeMs, before.mtimeMs, `${file} was modified while being read`);
    return { file, header, metadata, sizeBytes, sha256: hash.digest("hex") };
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * The record. Pure: everything it needs is passed in, so the tests can feed it
 * a saved header and compare against the prototype's saved output.
 */
export function buildTilesetRecord({ header, metadata, sizeBytes, sha256, region, sourceUrl, epoch, retrievedAt, processor }) {
  assert.ok(header && typeof header === "object", "header is required");
  assert.ok(metadata && typeof metadata === "object", "metadata is required");
  assert.ok(typeof region === "string" && REGION_NAME.test(region), `region ${JSON.stringify(region)} must be lower-case words joined by hyphens`);
  assert.ok(typeof sourceUrl === "string" && sourceUrl.startsWith("https://"), `source URL ${JSON.stringify(sourceUrl)} must be an https URL`);
  assert.ok(typeof retrievedAt === "string" && ISO_SECONDS.test(retrievedAt), `retrieved-at ${JSON.stringify(retrievedAt)} is not YYYY-MM-DDTHH:MM:SSZ`);
  assert.ok(typeof processor === "string" && processor.trim().length > 0, "processor must name the tool that cut the archive");
  assert.ok(Number.isSafeInteger(sizeBytes) && sizeBytes > 0, "sizeBytes must be a positive integer");
  assert.ok(typeof sha256 === "string" && HEX_SHA256.test(sha256), "sha256 must be 64 hex characters");
  assert.equal(header.tile_type, "mvt", `archive tile type is ${header.tile_type}, not mvt; the layer list below assumes vector tiles`);

  const archiveEpoch = metadata[REPLICATION_TIME_KEY];
  if (archiveEpoch !== undefined) {
    assert.ok(typeof archiveEpoch === "string" && ISO_SECONDS.test(archiveEpoch), `archive ${REPLICATION_TIME_KEY} ${JSON.stringify(archiveEpoch)} is not YYYY-MM-DDTHH:MM:SSZ`);
  }
  if (epoch !== undefined) {
    assert.ok(typeof epoch === "string" && ISO_SECONDS.test(epoch), `epoch ${JSON.stringify(epoch)} is not YYYY-MM-DDTHH:MM:SSZ`);
    if (archiveEpoch !== undefined && archiveEpoch !== epoch) {
      throw new Error(`epoch ${epoch} disagrees with the archive's ${REPLICATION_TIME_KEY} ${archiveEpoch}: the extract and its state file are not from the same Geofabrik run`);
    }
  } else if (archiveEpoch === undefined) {
    throw new Error(`no epoch: pass one, or build from an extract whose header carries ${REPLICATION_TIME_KEY}`);
  }
  const datasetEpoch = epoch ?? archiveEpoch;

  const vectorLayers = metadata.vector_layers;
  assert.ok(Array.isArray(vectorLayers) && vectorLayers.length > 0, "archive metadata has no vector_layers");
  const layers = vectorLayers.map((layer, index) => {
    assert.ok(layer && typeof layer.id === "string" && layer.id.length > 0, `vector_layers[${index}] has no id`);
    const fields = layer.fields ?? {};
    assert.ok(fields && typeof fields === "object" && !Array.isArray(fields), `vector_layers[${index}].fields is not an object`);
    return {
      NAME: layer.id,
      MIN_ZOOM: layer.minzoom ?? header.min_zoom,
      MAX_ZOOM: layer.maxzoom ?? header.max_zoom,
      FIELDS: Object.keys(fields).sort(compareCodeUnits),
    };
  });

  return {
    TILESET_ID: `osm-context-${region}-${compactEpoch(datasetEpoch)}`,
    TILESET_NAME: `OSM context tileset, ${region}, epoch ${datasetEpoch}`,
    TILING_SCHEME: "WEB_MERCATOR",
    MIN_ZOOM: header.min_zoom,
    MAX_ZOOM: header.max_zoom,
    BOUNDS: [header.min_lon_e7 / 1e7, header.min_lat_e7 / 1e7, header.max_lon_e7 / 1e7, header.max_lat_e7 / 1e7],
    LAYERS: layers,
    PAYLOAD: {
      CID: "",
      SIZE_BYTES: sizeBytes,
      DIGEST: `sha256:${sha256}`,
      MEDIA_TYPE: PMTILES_MEDIA_TYPE,
    },
    PROVENANCE: {
      DATASET_ID: "openstreetmap",
      DATASET_NAME: "OpenStreetMap",
      DATASET_URL: "https://www.openstreetmap.org",
      DATASET_EPOCH: datasetEpoch,
      SOURCE_URL: sourceUrl,
      RETRIEVED_AT: retrievedAt,
      LICENSE: "ODbL-1.0",
      LICENSE_URL: "https://opendatacommons.org/licenses/odbl/1-0/",
      ATTRIBUTION: "© OpenStreetMap contributors",
      SHARE_ALIKE: true,
      NON_COMMERCIAL_ONLY: false,
      PROCESSOR: processor,
    },
  };
}

/** Two-space indented JSON with a trailing newline — the bytes json.dump(indent=2) wrote. */
export function formatRecord(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Read an archive, build its record, write it. Returns the record. */
export function writeTilesetRecord({ archive, out, region, sourceUrl, epoch, retrievedAt, processor }) {
  const read = readPmtilesArchive(archive);
  const record = buildTilesetRecord({ ...read, region, sourceUrl, epoch, retrievedAt, processor });
  const target = out ?? defaultRecordPath(archive);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, formatRecord(record));
  return { record, out: target };
}

export function defaultRecordPath(archive) {
  assert.ok(archive.endsWith(".pmtiles"), `${archive} does not end in .pmtiles; pass --out`);
  return `${archive.slice(0, -".pmtiles".length)}.vtt.json`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--archive") args.archive = path.resolve(value());
    else if (flag === "--region") args.region = value();
    else if (flag === "--source-url") args.sourceUrl = value();
    else if (flag === "--epoch") args.epoch = value();
    else if (flag === "--retrieved-at") args.retrievedAt = value();
    else if (flag === "--processor") args.processor = value();
    else if (flag === "--out") args.out = path.resolve(value());
    else throw new Error(`unknown argument ${flag}`);
  }
  for (const required of ["archive", "region", "sourceUrl", "retrievedAt", "processor"]) {
    if (args[required] === undefined) {
      const flagName = `--${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      throw new Error(`${flagName} is required`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { record, out } = writeTilesetRecord(args);
  process.stdout.write(formatRecord(record));
  process.stderr.write(`wrote ${out}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`write-record: ${error.message}\n`);
    process.exit(1);
  });
}
