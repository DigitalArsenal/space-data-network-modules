#!/usr/bin/env node
// Deterministic fixture generator for data-source/weathernext-parser.
//
// Everything under tests/fixtures/wn3-0p1deg-clouds and tests/fixtures/
// wn3-cyclones is produced by THIS file, byte for byte, with no randomness
// and no clock: rerunning it must leave `git diff --quiet -- tests/fixtures`
// green. expected.json is computed HERE, independently of both parsers (the
// .ts reference and the wasm), from the same closed-form field the chunk
// bytes are written from — so a parser test compares against arithmetic,
// never against another parser's output.
//
// Layout facts (see PROVENANCE.md): 0.1 degree global grid 1801 x 3600,
// Zarr v3 array with dimension order init_time/member/lead_time/latitude/
// longitude and 64 x 64 (lat, lon) chunks; the real chunk shape, codec
// chain and dimension order are UNVERIFIED (anonymous bucket reads are
// 401/403), which is why every one of them is operator-declared config on
// the live path and job JSON here.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLOUDS_DIR = path.join(HERE, "wn3-0p1deg-clouds");
const CYCLONES_DIR = path.join(HERE, "wn3-cyclones");

// ---------------------------------------------------------------------------
// Grid + chunk layout (0.1 degree surface grid, WeatherNext 3 paper).
// ---------------------------------------------------------------------------

const GRID = Object.freeze({
  lat0: 90,
  lon0: 0,
  dlat: -0.1,
  dlon: 0.1,
  nlat: 1801,
  nlon: 3600,
  periodic_lon: true,
});
const CHUNK_LAT = 64;
const CHUNK_LON = 64;
const CHUNK_SHAPE = Object.freeze([1, 1, 1, CHUNK_LAT, CHUNK_LON]);
const DIMS = Object.freeze(["init_time", "member", "lead_time", "latitude", "longitude"]);
// Synoptic cycle: 15 days at hourly steps (0..360 h) -> 361 leads.
const ARRAY_SHAPE = Object.freeze([1, 64, 361, GRID.nlat, GRID.nlon]);
const LAYERS = Object.freeze([
  { array: "low_cloud_cover", layer: 0, variable: "LowCloudCover" },
  { array: "medium_cloud_cover", layer: 1, variable: "MediumCloudCover" },
  { array: "high_cloud_cover", layer: 2, variable: "HighCloudCover" },
]);

const INIT_TIME_ISO = "2026-09-02T00:00:00Z";
const INIT_TIME_MS = Date.UTC(2026, 8, 2, 0, 0, 0);
const LEAD_HOURS = 6;
const LEAD_INDEX = LEAD_HOURS; // lead step 1 h
const MEMBER_INDEX = 0;
const INIT_INDEX = 0;

// Cell value for layer L at global cell (i, j): computed in double, stored as
// float32 (Math.fround) exactly as the chunk bytes carry it.
function coverValue(layer, i, j) {
  const phi = 90 - 0.1 * i;
  const lambda = 0.1 * j;
  const v =
    0.5 +
    0.5 *
      Math.sin(((lambda + 20 * layer) * Math.PI) / 180 * (2 + layer)) *
      Math.cos(((phi - 10 * layer) * Math.PI) / 180 * (3 + layer));
  return Math.fround(Math.min(1, Math.max(0, v)));
}

function isMissing(layer, i, j) {
  if (layer !== 1) return false;
  const li = i % CHUNK_LAT;
  const lj = j % CHUNK_LON;
  return li >= 30 && li <= 32 && lj >= 30 && lj <= 32;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function chunkFileName(array, latChunk, lonChunk) {
  return `${array}.c.${INIT_INDEX}.${MEMBER_INDEX}.${LEAD_INDEX}.${latChunk}.${lonChunk}.bin`;
}

// Writes one 64 x 64 float32 little-endian chunk (NaN fill past the array
// edge) and returns its expected decode.
function buildChunk({ array, layer }, latChunk, lonChunk) {
  const bytes = new Uint8Array(CHUNK_LAT * CHUNK_LON * 4);
  const view = new DataView(bytes.buffer);
  const i0 = latChunk * CHUNK_LAT;
  const j0 = lonChunk * CHUNK_LON;
  const nlat = Math.min(CHUNK_LAT, GRID.nlat - i0);
  const nlon = Math.min(CHUNK_LON, GRID.nlon - j0);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let missing = 0;
  const cells = new Float32Array(nlat * nlon);
  for (let li = 0; li < CHUNK_LAT; li++) {
    for (let lj = 0; lj < CHUNK_LON; lj++) {
      const gi = i0 + li;
      const gj = j0 + lj;
      let value = Number.NaN;
      if (gi < GRID.nlat && gj < GRID.nlon && !isMissing(layer, gi, gj)) {
        value = coverValue(layer, gi, gj);
      }
      view.setFloat32((li * CHUNK_LON + lj) * 4, value, true);
      if (li < nlat && lj < nlon) {
        cells[li * nlon + lj] = value;
        if (Number.isNaN(value)) missing++;
        else {
          if (value < min) min = value;
          if (value > max) max = value;
        }
      }
    }
  }
  const spotsWanted = nlat === CHUNK_LAT ? [[0, 0], [63, 63], [31, 17]] : [[nlat - 1, 63]];
  const spots = spotsWanted.map(([li, lj]) => ({ i: li, j: lj, value: cells[li * nlon + lj] }));
  const tilesPerRow = Math.ceil(GRID.nlon / CHUNK_LON);
  const tileRows = Math.ceil(GRID.nlat / CHUNK_LAT);
  return {
    bytes,
    expected: {
      array,
      layer,
      chunk_index: [INIT_INDEX, MEMBER_INDEX, LEAD_INDEX, latChunk, lonChunk],
      sha256: sha256(bytes),
      byte_length: bytes.byteLength,
      NLAT: nlat,
      NLON: nlon,
      LAT0: GRID.lat0 + i0 * GRID.dlat,
      LON0: GRID.lon0 + j0 * GRID.dlon,
      DLAT: GRID.dlat,
      DLON: GRID.dlon,
      PERIODIC_LON: GRID.periodic_lon && nlon === GRID.nlon,
      TILE_INDEX: latChunk * tilesPerRow + lonChunk,
      TILE_COUNT: tileRows * tilesPerRow,
      VALUE_MIN: min,
      VALUE_MAX: max,
      MISSING_COUNT: missing,
      cell_count: nlat * nlon,
      spots,
    },
  };
}

function zarrArrayMetadata(array, withZstd) {
  const codecs = [{ name: "bytes", configuration: { endian: "little" } }];
  if (withZstd) codecs.push({ name: "zstd", configuration: { level: 3, checksum: false } });
  return {
    zarr_format: 3,
    node_type: "array",
    shape: ARRAY_SHAPE,
    data_type: "float32",
    chunk_grid: { name: "regular", configuration: { chunk_shape: CHUNK_SHAPE } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    fill_value: "NaN",
    codecs,
    dimension_names: DIMS,
    attributes: { units: "1", long_name: `${array.replace(/_/g, " ")} fraction` },
  };
}

function zstd(bytes) {
  return zlib.zstdCompressSync(bytes, {
    params: {
      [zlib.constants.ZSTD_c_compressionLevel]: 3,
      [zlib.constants.ZSTD_c_checksumFlag]: 0,
    },
  });
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function generateClouds() {
  fs.mkdirSync(CLOUDS_DIR, { recursive: true });
  const chunks = {};
  const plan = [
    ...LAYERS.map((layer) => [layer, 14, 7]),
    [LAYERS[0], 28, 7], // edge chunk: rows 1792..1800 real, 55 rows NaN fill
  ];
  for (const layer of LAYERS) {
    writeJson(path.join(CLOUDS_DIR, `${layer.array}.zarr.json`), zarrArrayMetadata(layer.array, false));
    writeJson(path.join(CLOUDS_DIR, `${layer.array}.zstd.zarr.json`), zarrArrayMetadata(layer.array, true));
  }
  for (const [layer, latChunk, lonChunk] of plan) {
    const name = chunkFileName(layer.array, latChunk, lonChunk);
    const { bytes, expected } = buildChunk(layer, latChunk, lonChunk);
    fs.writeFileSync(path.join(CLOUDS_DIR, name), bytes);
    const compressed = zstd(bytes);
    fs.writeFileSync(path.join(CLOUDS_DIR, `${name}.zst`), compressed);
    chunks[name] = {
      ...expected,
      zst_file: `${name}.zst`,
      zst_sha256: sha256(compressed),
      zst_byte_length: compressed.byteLength,
    };
  }
  const validTimeMs = INIT_TIME_MS + LEAD_HOURS * 3600000;
  writeJson(path.join(CLOUDS_DIR, "expected.json"), {
    generator: "tests/fixtures/generate-fixtures.mjs",
    grid: GRID,
    chunk_shape: CHUNK_SHAPE,
    dims: DIMS,
    dtype: "float32",
    layers: LAYERS,
    job: {
      model_id: "weathernext-3",
      model_class: "MachineLearnedGlobalEnsemble",
      init_time: INIT_TIME_ISO,
      init_time_ms: INIT_TIME_MS,
      lead_hours: LEAD_HOURS,
      valid_time_ms: validTimeMs,
      horizon_hours: 360,
      member_kind: "Member",
      member_index: MEMBER_INDEX,
      ensemble_size: 64,
      units: "1",
      level_kind: "EntireAtmosphere",
      temporal_kind: "Instantaneous",
      origin_id: "storage.googleapis.com",
      dataset_id: "weathernext3_spatial",
      source_name: "weathernext3-clouds-0p1deg",
    },
    field_ids: Object.fromEntries(
      LAYERS.map((layer) => [
        layer.array,
        `weathernext-3|${INIT_TIME_ISO}|Member${MEMBER_INDEX}|${layer.array}|${LEAD_HOURS}h`,
      ]),
    ),
    chunks,
  });
}

// ---------------------------------------------------------------------------
// Cyclone tracks (hand-set rows; the CSV and expected.json are both derived
// from this one table).
// ---------------------------------------------------------------------------

const CSV_HEADER = [
  "storm_id", "storm_name", "basin", "track_origin", "init_time", "member", "valid_time",
  "lead_hours", "latitude", "longitude", "existence_probability", "max_sustained_wind_kt",
  "min_central_pressure_hpa", "radius_max_wind_nmi",
  "r34_ne_nmi", "r34_se_nmi", "r34_sw_nmi", "r34_nw_nmi",
  "r50_ne_nmi", "r50_se_nmi", "r50_sw_nmi", "r50_nw_nmi",
  "r64_ne_nmi", "r64_se_nmi", "r64_sw_nmi", "r64_nw_nmi",
];

const LEADS = [0, 6, 12, 18, 24];
// Row order inside each (storm, member) group is deliberately NOT ascending
// (6, 0, 18, 12, 24): the parser must sort points by valid time.
const LEAD_FILE_ORDER = [6, 0, 18, 12, 24];

// "" = blank cell (not reported). Numbers are written as given.
const STORMS = [
  {
    storm_id: "2026245N12300",
    storm_name: "ALPHA",
    basin: "NA",
    track_origin: "existing",
    lat0: 12.0,
    lon0: 300.0, // [0, 360) form; normalises to -60
    dlat: 0.5,
    dlon: -1.0,
    existence: ["", "", "", "", ""],
    members: [
      {
        vmax_kt: [30, 40, 55, 65, 75],
        pmin_hpa: [1005, 1000, 992, 985, 978],
        rmw_nmi: [30, 25, 20, 15, 15],
        r34: [[0, 0, 0, 0], [60, 50, 40, 50], [80, 70, 60, 70], [90, 80, 70, 80], [100, 90, 80, 90]],
        r50: [[0, 0, 0, 0], [0, 0, 0, 0], [30, 25, 20, 25], [45, 40, 35, 40], [55, 50, 40, 50]],
        r64: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [15, 10, 10, 15], [25, 20, 15, 20]],
      },
      {
        vmax_kt: [30, 45, 60, 70, 85],
        pmin_hpa: [1005, 998, 989, 981, 970],
        rmw_nmi: [30, 22, 18, 14, 12],
        r34: [[0, 0, 0, 0], [65, 55, 45, 55], [85, 75, 65, 75], [95, 85, 75, 85], [110, 95, 85, 95]],
        r50: [[0, 0, 0, 0], [0, 0, 0, 0], [35, 30, 25, 30], [50, 45, 40, 45], [60, 55, 45, 55]],
        r64: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [20, 15, 15, 20], [30, 25, 20, 25]],
      },
      {
        vmax_kt: [28, 35, 50, 62, 66],
        pmin_hpa: [1006, 1002, 995, 988, 986],
        rmw_nmi: ["", 28, 24, 20, 18],
        r34: [["", "", "", ""], [40, 30, 30, 40], [70, 60, 50, 60], [80, 70, 60, 70], [85, 75, 65, 75]],
        r50: [["", "", "", ""], [0, 0, 0, 0], [20, 15, 15, 20], [35, 30, 25, 30], [40, 35, 30, 35]],
        r64: [["", "", "", ""], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [10, 10, 5, 10]],
      },
    ],
  },
  {
    storm_id: "2026248N15290",
    storm_name: "",
    basin: "NA",
    track_origin: "genesis",
    lat0: 15.0,
    lon0: -70.0,
    dlat: 0.4,
    dlon: -0.8,
    existence: [0.35, 0.5, 0.7, 0.85, 0.9],
    members: [
      {
        vmax_kt: [20, 25, 30, 35, 40],
        pmin_hpa: [1008, 1007, 1005, 1002, 1000],
        rmw_nmi: ["", 40, 35, 30, 30],
        r34: [["", "", "", ""], ["", "", "", ""], ["", "", "", ""], [40, 30, 30, 40], [50, 40, 40, 50]],
        r50: [["", "", "", ""], ["", "", "", ""], ["", "", "", ""], [0, 0, 0, 0], [0, 0, 0, 0]],
        r64: [["", "", "", ""], ["", "", "", ""], ["", "", "", ""], [0, 0, 0, 0], [0, 0, 0, 0]],
      },
      {
        vmax_kt: [20, 24, 28, 33, 38],
        pmin_hpa: [1008, 1007, 1006, 1004, 1001],
        rmw_nmi: ["", 42, 38, 34, 30],
        r34: [["", "", "", ""], ["", "", "", ""], ["", "", "", ""], ["", "", "", ""], [45, 35, 35, 45]],
        r50: [["", "", "", ""], ["", "", "", ""], ["", "", "", ""], ["", "", "", ""], [0, 0, 0, 0]],
        r64: [["", "", "", ""], ["", "", "", ""], ["", "", "", ""], ["", "", "", ""], [0, 0, 0, 0]],
      },
      {
        vmax_kt: [22, 27, 33, 39, 46],
        pmin_hpa: [1008, 1006, 1004, 1000, 996],
        rmw_nmi: ["", 38, 32, 28, 25],
        r34: [["", "", "", ""], ["", "", "", ""], ["", "", "", ""], [35, 30, 25, 30], [60, 50, 45, 50]],
        r50: [["", "", "", ""], ["", "", "", ""], ["", "", "", ""], [0, 0, 0, 0], [0, 0, 0, 0]],
        r64: [["", "", "", ""], ["", "", "", ""], ["", "", "", ""], [0, 0, 0, 0], [0, 0, 0, 0]],
      },
    ],
  },
];

const KT_TO_MS = (kt) => Math.fround((kt * 1852) / 3600);
const NMI_TO_KM = (nmi) => (nmi === "" ? -1 : Math.fround(nmi * 1.852));

function categoryFor(vmaxMs) {
  if (vmaxMs < 17) return "TropicalDepression";
  if (vmaxMs < 33) return "TropicalStorm";
  if (vmaxMs < 43) return "Category1";
  if (vmaxMs < 50) return "Category2";
  if (vmaxMs < 58) return "Category3";
  if (vmaxMs < 70) return "Category4";
  return "Category5";
}

function normaliseLongitude(lon) {
  let v = lon;
  while (v >= 180) v -= 360;
  while (v < -180) v += 360;
  return v;
}

function isoAt(ms) {
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
}

function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function generateCyclones() {
  fs.mkdirSync(CYCLONES_DIR, { recursive: true });
  const lines = [CSV_HEADER.join(",")];
  const tracks = {};
  const trackOrder = [];
  // Interleave storms per member so grouping is by (storm, member) in
  // first-appearance order, never by file position.
  for (let m = 0; m < 3; m++) {
    for (const storm of STORMS) {
      const member = storm.members[m];
      const key = `${storm.storm_id}|${m}`;
      trackOrder.push(key);
      const points = [];
      for (const lead of LEAD_FILE_ORDER) {
        const k = LEADS.indexOf(lead);
        const validMs = INIT_TIME_MS + lead * 3600000;
        const lat = storm.lat0 + storm.dlat * k + 0.1 * m;
        const lon = storm.lon0 + storm.dlon * k;
        const row = [
          storm.storm_id,
          storm.storm_name,
          storm.basin,
          storm.track_origin,
          INIT_TIME_ISO,
          m,
          isoAt(validMs),
          lead,
          lat.toFixed(1),
          lon.toFixed(1),
          storm.existence[k],
          member.vmax_kt[k],
          member.pmin_hpa[k],
          member.rmw_nmi[k],
          ...member.r34[k],
          ...member.r50[k],
          ...member.r64[k],
        ];
        lines.push(row.map(csvCell).join(","));
        const vmaxMs = KT_TO_MS(member.vmax_kt[k]);
        points.push({
          VALID_TIME_MS: validMs,
          LEAD_HOURS: lead,
          LATITUDE: Number(lat.toFixed(1)),
          LONGITUDE: normaliseLongitude(Number(lon.toFixed(1))),
          MAX_SUSTAINED_WIND_MS: vmaxMs,
          MIN_CENTRAL_PRESSURE_PA: member.pmin_hpa[k] * 100,
          RADIUS_MAX_WIND_KM: NMI_TO_KM(member.rmw_nmi[k]),
          RADII: [34, 50, 64].map((kt, r) => {
            const quadrants = [member.r34, member.r50, member.r64][r][k];
            return {
              THRESHOLD_WIND_MS: KT_TO_MS(kt),
              NE_KM: NMI_TO_KM(quadrants[0]),
              SE_KM: NMI_TO_KM(quadrants[1]),
              SW_KM: NMI_TO_KM(quadrants[2]),
              NW_KM: NMI_TO_KM(quadrants[3]),
            };
          }),
          CATEGORY: categoryFor(vmaxMs),
          EXISTENCE_PROBABILITY: storm.existence[k] === "" ? 1 : storm.existence[k],
        });
      }
      points.sort((a, b) => a.VALID_TIME_MS - b.VALID_TIME_MS);
      tracks[key] = {
        STORM_ID: storm.storm_id,
        STORM_NAME: storm.storm_name,
        BASIN: "NorthAtlantic",
        TRACK_KIND: "Forecast",
        TRACK_ORIGIN: storm.track_origin === "genesis" ? "Genesis" : "ExistingSystem",
        MEMBER_KIND: "Member",
        MEMBER_INDEX: m,
        INIT_TIME_MS,
        point_count: points.length,
        first_valid_time_ms: points[0].VALID_TIME_MS,
        last_valid_time_ms: points[points.length - 1].VALID_TIME_MS,
        points,
      };
    }
  }
  const csv = `${lines.join("\r\n")}\r\n`;
  const csvBytes = Buffer.from(csv, "utf8");
  fs.writeFileSync(path.join(CYCLONES_DIR, "cyclone-tracks.csv"), csvBytes);
  writeJson(path.join(CYCLONES_DIR, "expected.json"), {
    generator: "tests/fixtures/generate-fixtures.mjs",
    csv_sha256: sha256(csvBytes),
    csv_byte_length: csvBytes.byteLength,
    row_count: lines.length - 1,
    record_count: trackOrder.length,
    init_time: INIT_TIME_ISO,
    init_time_ms: INIT_TIME_MS,
    ensemble_size: 64,
    wind_averaging_period_s: 60,
    source_name: "weathernext3-cyclone-tracks",
    archive: { source: "weathernext", name: "cyclone-tracks.csv" },
    track_order: trackOrder,
    tracks,
  });
}

generateClouds();
generateCyclones();
console.log(`fixtures written under ${path.relative(process.cwd(), HERE) || "."}`);
