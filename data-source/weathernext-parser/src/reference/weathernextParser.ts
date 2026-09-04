// Reference parser for data-source/weathernext-parser (normative for tests).
//
// Two lanes, mirroring the wasm node's methods:
//   parseCloudChunks(jobs, responses) -> $WXF tiles (one per Zarr chunk)
//   parseCycloneTracks(job, response) -> $TCT tracks (one per storm x member)
//
// Records are built with the GENERATED JavaScript from the canonical
// spacedatastandards.org checkout (never hand-written bindings), through ONE
// flatbuffers instance: the one that checkout resolves. The reference and the
// wasm produce different record BYTES (different builders, different add
// order), which is why every test asserts decoded field values against the
// independently computed expected.json, never bytes against bytes.
//
// Erasable TypeScript only (Node strips types natively; no enum/namespace/
// parameter properties; specifiers keep their extension).

import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { cellCountOf, decodeChunk } from "./zarrChunk.ts";
import { parseCycloneCsv } from "./cycloneCsv.ts";

const WXF_LIB_URL = new URL("../../../../../spacedatastandards.org/lib/js/WXF/main.js", import.meta.url);
const TCT_LIB_URL = new URL("../../../../../spacedatastandards.org/lib/js/TCT/main.js", import.meta.url);

// One flatbuffers instance: the generated code imports the bare specifier
// "flatbuffers" from the standards checkout, so the Builder/ByteBuffer used
// here come from that same resolution (createRequire anchored on the lib).
const requireFromStandards = createRequire(WXF_LIB_URL);
const flatbuffers = requireFromStandards("flatbuffers") as {
  Builder: new (size?: number) => FlatbuffersBuilder;
  ByteBuffer: new (bytes: Uint8Array) => FlatbuffersByteBuffer;
};

interface FlatbuffersBuilder {
  asUint8Array(): Uint8Array;
}
interface FlatbuffersByteBuffer {}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GeneratedModule = any;
const wxfLib: GeneratedModule = await import(WXF_LIB_URL.href);
const tctLib: GeneratedModule = await import(TCT_LIB_URL.href);

export const PARSER_VERSION_CLOUDS = "weathernext-zarr-wasm/v1";
export const PARSER_VERSION_CYCLONES = "weathernext-cyclone-wasm/v1";
export const LICENSE_ID_HISTORICAL = "CC-BY-4.0";
export const LICENSE_ID_REALTIME = "LicenseRef-WeatherNext-RealTime-Experimental";
export const MAX_INLINE_CELLS = 1_048_576;
export const KT_TO_MS = 1852 / 3600;
export const NMI_TO_KM = 1.852;

// ---------------------------------------------------------------------------
// Job and response shapes (contract D).
// ---------------------------------------------------------------------------

export interface GridSpec {
  lat0: number;
  lon0: number;
  dlat: number;
  dlon: number;
  nlat: number;
  nlon: number;
  periodic_lon: boolean;
}

export interface ChunkJob {
  source_url: string;
  source_name: string;
  provider_id: string;
  array: string;
  variable_name: string;
  model_id: string;
  model_version: string;
  model_class: string;
  init_time_ms: number;
  lead_hours: number;
  horizon_hours: number;
  member_kind: string;
  member_index: number;
  ensemble_size: number;
  dtype: string;
  codecs: string[];
  chunk_shape: number[];
  chunk_index: number[];
  dims: string[];
  grid: GridSpec;
  license_class: string;
  license_url: string;
  citation: string;
  origin_id: string;
  dataset_id: string;
}

export interface CycloneJob {
  source_url: string;
  source_name: string;
  provider_id: string;
  archive_source: string;
  archive_name: string;
  model_id: string;
  model_version: string;
  model_class: string;
  ensemble_size: number;
  wind_averaging_period_s: number;
  license_class: string;
  license_url: string;
  citation: string;
  origin_id: string;
  dataset_id: string;
}

export interface DecodedResponse {
  status: number;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface ParseOptions {
  /** Clock used when the response carries no Date header (Unix ms UTC). */
  nowMs?: number;
}

export interface ParseResult<TRecord> {
  meta: Record<string, unknown>;
  recordsStream: Uint8Array;
  records: TRecord[];
  /** Unprefixed record buffers in stream order. */
  recordBuffers: Uint8Array[];
}

// ---------------------------------------------------------------------------
// hostcap/http-request response frames: default JSON lane
// {status, headers, bodyB64} or the raw-body-v1 lane "$HRB" + int32le status
// + body bytes.
// ---------------------------------------------------------------------------

const textDecoder = new TextDecoder();

export function decodeResponseFrame(frame: Uint8Array): DecodedResponse {
  if (
    frame.byteLength >= 8 &&
    frame[0] === 0x24 && frame[1] === 0x48 && frame[2] === 0x52 && frame[3] === 0x42
  ) {
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    return { status: view.getInt32(4, true), headers: {}, body: frame.subarray(8) };
  }
  const json = JSON.parse(textDecoder.decode(frame)) as {
    status?: number;
    headers?: Record<string, string>;
    bodyB64?: string;
  };
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(json.headers ?? {})) headers[name.toLowerCase()] = String(value);
  const body = json.bodyB64 ? new Uint8Array(Buffer.from(json.bodyB64, "base64")) : new Uint8Array(0);
  return { status: Number(json.status ?? 0), headers, body };
}

// ---------------------------------------------------------------------------
// Enum mapping (names -> generated enum values).
// ---------------------------------------------------------------------------

function enumValue(enumObject: Record<string, number>, name: string, fallback: string): number {
  const value = enumObject[name];
  if (typeof value === "number") return value;
  return enumObject[fallback];
}

export function variableForArray(array: string): number {
  const table: Record<string, string> = {
    low_cloud_cover: "LowCloudCover",
    medium_cloud_cover: "MediumCloudCover",
    high_cloud_cover: "HighCloudCover",
    total_cloud_cover: "TotalCloudCover",
  };
  return enumValue(wxfLib.wxfVariable, table[array] ?? "Unspecified", "Unspecified");
}

export function basinForCode(code: string): number {
  const table: Record<string, string> = {
    NA: "NorthAtlantic",
    EP: "EastPacific",
    CP: "CentralPacific",
    WP: "WestPacific",
    NI: "NorthIndian",
    SI: "SouthIndian",
    SP: "SouthPacific",
    SA: "SouthAtlantic",
  };
  return enumValue(tctLib.tctBasin, table[code.trim().toUpperCase()] ?? "Other", "Other");
}

export function categoryForWind(vmaxMs: number): number {
  const category = tctLib.tctIntensityCategory;
  if (vmaxMs < 17) return category.TropicalDepression;
  if (vmaxMs < 33) return category.TropicalStorm;
  if (vmaxMs < 43) return category.Category1;
  if (vmaxMs < 50) return category.Category2;
  if (vmaxMs < 58) return category.Category3;
  if (vmaxMs < 70) return category.Category4;
  return category.Category5;
}

export function normaliseLongitude(lon: number): number {
  let value = lon;
  while (value >= 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

// ---------------------------------------------------------------------------
// Time helpers.
// ---------------------------------------------------------------------------

export function formatIsoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function parseIsoMs(text: string): number {
  const ms = Date.parse(text.trim());
  if (!Number.isFinite(ms)) throw new Error(`malformed ISO 8601 time "${text}"`);
  return ms;
}

function retrievedAtMs(headers: Record<string, string>, nowMs: number): number {
  const date = headers.date;
  if (date) {
    const parsed = Date.parse(date);
    if (Number.isFinite(parsed)) return parsed;
  }
  return nowMs;
}

// ---------------------------------------------------------------------------
// Hashing (batch id, normalized record hash).
// ---------------------------------------------------------------------------

export function sha256Hex(parts: Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

function normalizedSha256(schema: string, records: Uint8Array[]): string {
  const hash = createHash("sha256");
  const zero = new Uint8Array([0]);
  for (const record of records) {
    hash.update(schema);
    hash.update(zero);
    hash.update(record);
    hash.update(zero);
  }
  return hash.digest("hex");
}

function concatStream(records: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const record of records) total += 4 + record.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const record of records) {
    view.setUint32(offset, record.byteLength, true);
    out.set(record, offset + 4);
    offset += 4 + record.byteLength;
  }
  return out;
}

export function splitStream(stream: Uint8Array): Uint8Array[] {
  const records: Uint8Array[] = [];
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  let offset = 0;
  while (offset < stream.byteLength) {
    const length = view.getUint32(offset, true);
    offset += 4;
    records.push(stream.subarray(offset, offset + length));
    offset += length;
  }
  return records;
}

function licenseIdFor(licenseClass: string): string {
  return licenseClass === "Historical" ? LICENSE_ID_HISTORICAL : LICENSE_ID_REALTIME;
}

function commonSourceUrl(urls: string[]): string {
  if (urls.length === 1) return urls[0];
  let prefix = urls[0] ?? "";
  for (const url of urls) {
    let k = 0;
    while (k < prefix.length && k < url.length && prefix[k] === url[k]) k++;
    prefix = prefix.slice(0, k);
  }
  const slash = prefix.lastIndexOf("/");
  return slash >= 0 ? prefix.slice(0, slash + 1) : prefix;
}

function buildMeta(input: {
  schema: string;
  job: { provider_id: string; source_name: string; license_class: string; license_url: string; citation: string; origin_id: string };
  sourceUrl: string;
  batchId: string;
  archive?: { source: string; name: string };
  provenance: Record<string, unknown>;
}): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    schema: input.schema,
    provider_id: input.job.provider_id,
    source_name: input.job.source_name,
    source_url: input.sourceUrl,
    batch_id: input.batchId,
    content_key_id: "public",
    source_peer: `source:${input.job.origin_id}`,
    reconcile: "duplicates",
    license: licenseIdFor(input.job.license_class),
    license_url: input.job.license_url,
    citation: input.job.citation,
  };
  if (input.archive) meta.archive = input.archive;
  meta.provenance = {
    source: input.job.source_name,
    json: Buffer.from(JSON.stringify(input.provenance), "utf8").toString("base64"),
  };
  return meta;
}

function buildProvenance(input: {
  parserVersion: string;
  sourceUrl: string;
  status: number;
  headers: Record<string, string>;
  sourceSha256: string;
  normalizedSha256: string;
  normalizedCount: number;
  schemaCounts: Record<string, number>;
  retrievedAtMs: number;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    source_url: input.sourceUrl,
    http_status: input.status,
  };
  if (input.headers.etag) out.etag = input.headers.etag;
  if (input.headers["last-modified"]) out.last_modified = input.headers["last-modified"];
  if (input.headers["content-type"]) out.content_type = input.headers["content-type"];
  out.retrieved_at = formatIsoSeconds(input.retrievedAtMs);
  out.parser_version = input.parserVersion;
  out.source_sha256 = input.sourceSha256;
  out.normalized_sha256 = input.normalizedSha256;
  out.normalized_count = input.normalizedCount;
  out.schema_counts = input.schemaCounts;
  out.warnings = [];
  out.from_cache = false;
  return out;
}

function finishRecord(builder: FlatbuffersBuilder): Uint8Array {
  // The generated finish*SizePrefixed*Buffer wrote [u32 size][record]; the
  // stream re-prefixes, so strip the four bytes here (identifier lands at 4..8).
  return Uint8Array.from(builder.asUint8Array().subarray(4));
}

// ---------------------------------------------------------------------------
// Cloud chunks -> WXF tiles.
// ---------------------------------------------------------------------------

export interface WxfTile {
  values: Float32Array;
  nlat: number;
  nlon: number;
  lat0: number;
  lon0: number;
  tileIndex: number;
  tileCount: number;
  valueMin: number;
  valueMax: number;
  missingCount: number;
  periodicLon: boolean;
}

/** Pure geometry + statistics for one chunk; shared by the record builder. */
export function chunkToTile(job: ChunkJob, cells: Float32Array): WxfTile {
  const latDim = job.dims.indexOf("latitude");
  const lonDim = job.dims.indexOf("longitude");
  if (latDim < 0 || lonDim < 0) throw new Error("dims must name latitude and longitude");
  const chunkLat = job.chunk_shape[latDim];
  const chunkLon = job.chunk_shape[lonDim];
  const i0 = job.chunk_index[latDim] * chunkLat;
  const j0 = job.chunk_index[lonDim] * chunkLon;
  const { nlat: gridNlat, nlon: gridNlon } = job.grid;
  const nlat = Math.min(chunkLat, gridNlat - i0);
  const nlon = Math.min(chunkLon, gridNlon - j0);
  if (nlat <= 0 || nlon <= 0) throw new Error("chunk index lies outside the declared grid");
  // The chunk is laid out over every dimension in `dims`; the non-spatial
  // dimensions have extent 1 in a per-(init, member, lead) chunk, so the cell
  // at (li, lj) sits at li * chunkLon + lj when latitude precedes longitude.
  const latStride = latDim < lonDim ? chunkLon : 1;
  const lonStride = latDim < lonDim ? 1 : chunkLat;
  const values = new Float32Array(nlat * nlon);
  let valueMin = Number.POSITIVE_INFINITY;
  let valueMax = Number.NEGATIVE_INFINITY;
  let missingCount = 0;
  for (let li = 0; li < nlat; li++) {
    for (let lj = 0; lj < nlon; lj++) {
      const value = cells[li * latStride + lj * lonStride];
      values[li * nlon + lj] = value;
      if (Number.isNaN(value)) {
        missingCount++;
      } else {
        if (value < valueMin) valueMin = value;
        if (value > valueMax) valueMax = value;
      }
    }
  }
  if (missingCount === nlat * nlon) {
    valueMin = 0;
    valueMax = 0;
  }
  const tilesPerRow = Math.ceil(gridNlon / chunkLon);
  const tileRows = Math.ceil(gridNlat / chunkLat);
  return {
    values,
    nlat,
    nlon,
    lat0: job.grid.lat0 + i0 * job.grid.dlat,
    lon0: job.grid.lon0 + j0 * job.grid.dlon,
    tileIndex: job.chunk_index[latDim] * tilesPerRow + job.chunk_index[lonDim],
    tileCount: tileRows * tilesPerRow,
    valueMin,
    valueMax,
    missingCount,
    periodicLon: job.grid.periodic_lon && nlon === gridNlon,
  };
}

export function fieldIdFor(job: ChunkJob): string {
  return `${job.model_id}|${formatIsoSeconds(job.init_time_ms)}|${job.member_kind}${job.member_index}|${job.array}|${job.lead_hours}h`;
}

function buildWxfRecord(job: ChunkJob, tile: WxfTile, retrievedAt: number): Uint8Array {
  if (tile.values.length > MAX_INLINE_CELLS) {
    throw new Error(`tile of ${tile.values.length} cells exceeds the inline limit ${MAX_INLINE_CELLS}`);
  }
  const grid = new wxfLib.WXFGridT();
  grid.KIND = wxfLib.wxfGridKind.RegularLatLon;
  grid.LAT0 = tile.lat0;
  grid.LON0 = tile.lon0;
  grid.DLAT = job.grid.dlat;
  grid.DLON = job.grid.dlon;
  grid.NLAT = tile.nlat;
  grid.NLON = tile.nlon;
  grid.PERIODIC_LON = tile.periodicLon;

  const record = new wxfLib.WXFT();
  record.FIELD_ID = fieldIdFor(job);
  record.MODEL_CLASS = enumValue(wxfLib.wxfModelClass, job.model_class, "Unspecified");
  record.MODEL_ID = job.model_id;
  record.MODEL_VERSION = job.model_version ?? "";
  record.INIT_TIME_MS = BigInt(job.init_time_ms);
  record.LEAD_HOURS = job.lead_hours;
  record.VALID_TIME_MS = BigInt(job.init_time_ms + Math.round(job.lead_hours * 3600000));
  record.HORIZON_HOURS = job.horizon_hours;
  record.MEMBER_KIND = enumValue(wxfLib.wxfMemberKind, job.member_kind, "Member");
  record.MEMBER_INDEX = job.member_index;
  record.ENSEMBLE_SIZE = job.ensemble_size;
  record.VARIABLE = variableForArray(job.array);
  record.VARIABLE_NAME = job.array;
  record.UNITS = "1";
  record.LEVEL_KIND = wxfLib.wxfLevelKind.EntireAtmosphere;
  record.LEVEL_VALUE = 0;
  record.TEMPORAL_KIND = wxfLib.wxfTemporalKind.Instantaneous;
  record.ACCUMULATION_HOURS = 0;
  record.GRID = grid;
  record.TILE_INDEX = tile.tileIndex;
  record.TILE_COUNT = tile.tileCount;
  record.VALUES_ENCODING = wxfLib.wxfValuesEncoding.InlineFloat32;
  record.VALUES = Array.from(tile.values);
  record.CHUNK_CID = null;
  record.CHUNK_DTYPE = null;
  record.CHUNK_CODECS = [];
  record.CHUNK_BYTE_LENGTH = BigInt(0);
  record.VALUE_MIN = tile.valueMin;
  record.VALUE_MAX = tile.valueMax;
  record.MISSING_COUNT = tile.missingCount;
  record.ORIGIN_ID = job.origin_id;
  record.DATASET_ID = job.dataset_id;
  record.SOURCE_URL = job.source_url;
  record.RETRIEVED_AT = BigInt(retrievedAt);
  record.LICENSE_CLASS = enumValue(wxfLib.wxfLicenseClass, job.license_class, "RealTimeExperimental");
  record.LICENSE_URL = job.license_url;
  record.CITATION = job.citation ?? "";
  record.PRODUCER_PEER_ID = "";

  const builder = new flatbuffers.Builder(4096 + tile.values.length * 4);
  const offset = record.pack(builder);
  wxfLib.WXF.finishSizePrefixedWXFBuffer(builder, offset);
  return finishRecord(builder);
}

export function unpackWxf(record: Uint8Array): GeneratedModule {
  return wxfLib.WXF.getRootAsWXF(new flatbuffers.ByteBuffer(record)).unpack();
}

export function parseCloudChunks(
  jobs: ChunkJob[],
  responses: DecodedResponse[],
  options: ParseOptions = {},
): ParseResult<GeneratedModule> {
  if (jobs.length !== responses.length) {
    throw new Error(`job-response-count-mismatch: ${jobs.length} jobs, ${responses.length} responses`);
  }
  if (jobs.length === 0) throw new Error("no chunk jobs");
  const nowMs = options.nowMs ?? Date.now();
  const recordBuffers: Uint8Array[] = [];
  const records: GeneratedModule[] = [];
  for (let k = 0; k < jobs.length; k++) {
    const job = jobs[k];
    const response = responses[k];
    if (response.status !== 200) {
      throw new Error(`fetch-failed: chunk ${k} (${job.source_url}) returned HTTP status ${response.status}`);
    }
    const cells = decodeChunk(response.body, {
      codecs: job.codecs,
      dataType: job.dtype,
      chunkShape: job.chunk_shape,
    });
    if (cells.length !== cellCountOf(job.chunk_shape)) throw new Error("chunk-size-mismatch");
    const tile = chunkToTile(job, cells);
    const record = buildWxfRecord(job, tile, retrievedAtMs(response.headers, nowMs));
    recordBuffers.push(record);
    records.push(unpackWxf(record));
  }
  const batchId = sha256Hex(responses.map((response) => response.body));
  const sourceUrl = commonSourceUrl(jobs.map((job) => job.source_url));
  const provenance = buildProvenance({
    parserVersion: PARSER_VERSION_CLOUDS,
    sourceUrl,
    status: 200,
    headers: responses[0].headers,
    sourceSha256: batchId,
    normalizedSha256: normalizedSha256("WXF.fbs", recordBuffers),
    normalizedCount: recordBuffers.length,
    schemaCounts: { "WXF.fbs": recordBuffers.length },
    retrievedAtMs: retrievedAtMs(responses[0].headers, nowMs),
  });
  const meta = buildMeta({ schema: "WXF.fbs", job: jobs[0], sourceUrl, batchId, provenance });
  return { meta, recordsStream: concatStream(recordBuffers), records, recordBuffers };
}

// ---------------------------------------------------------------------------
// Cyclone CSV -> TCT tracks.
// ---------------------------------------------------------------------------

function numberOrNegative(cell: string, scale: number): number {
  const text = cell.trim();
  if (text === "") return -1;
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error(`malformed numeric cell "${cell}"`);
  return Math.fround(value * scale);
}

function requiredNumber(row: Record<string, string>, column: string): number {
  const value = Number(row[column]);
  if (row[column] === undefined || row[column].trim() === "" || !Number.isFinite(value)) {
    throw new Error(`malformed or missing ${column}`);
  }
  return value;
}

function buildRadii(row: Record<string, string>, kt: number): GeneratedModule {
  const radii = new tctLib.TCTRadiiT();
  radii.THRESHOLD_WIND_MS = Math.fround((kt * 1852) / 3600);
  radii.NE_KM = numberOrNegative(row[`r${kt}_ne_nmi`] ?? "", NMI_TO_KM);
  radii.SE_KM = numberOrNegative(row[`r${kt}_se_nmi`] ?? "", NMI_TO_KM);
  radii.SW_KM = numberOrNegative(row[`r${kt}_sw_nmi`] ?? "", NMI_TO_KM);
  radii.NW_KM = numberOrNegative(row[`r${kt}_nw_nmi`] ?? "", NMI_TO_KM);
  return radii;
}

function buildPoint(row: Record<string, string>): GeneratedModule {
  const point = new tctLib.TCTPointT();
  point.VALID_TIME_MS = BigInt(parseIsoMs(row.valid_time ?? ""));
  point.LEAD_HOURS = requiredNumber(row, "lead_hours");
  point.LATITUDE = requiredNumber(row, "latitude");
  point.LONGITUDE = normaliseLongitude(requiredNumber(row, "longitude"));
  const vmaxMs = Math.fround((requiredNumber(row, "max_sustained_wind_kt") * 1852) / 3600);
  point.MAX_SUSTAINED_WIND_MS = vmaxMs;
  point.MIN_CENTRAL_PRESSURE_PA = Math.fround(requiredNumber(row, "min_central_pressure_hpa") * 100);
  point.RADIUS_MAX_WIND_KM = numberOrNegative(row.radius_max_wind_nmi ?? "", NMI_TO_KM);
  point.RADII = [34, 50, 64].map((kt) => buildRadii(row, kt));
  point.CATEGORY = categoryForWind(vmaxMs);
  const existence = (row.existence_probability ?? "").trim();
  point.EXISTENCE_PROBABILITY = existence === "" ? 1 : Math.fround(Number(existence));
  point.MOTION_DIRECTION_DEG = -1;
  point.MOTION_SPEED_MS = -1;
  return point;
}

function buildTctRecord(job: CycloneJob, rows: Record<string, string>[], retrievedAt: number): Uint8Array {
  const first = rows[0];
  const points = rows.map(buildPoint);
  points.sort((a, b) => (a.VALID_TIME_MS < b.VALID_TIME_MS ? -1 : a.VALID_TIME_MS > b.VALID_TIME_MS ? 1 : 0));

  const record = new tctLib.TCTT();
  record.STORM_ID = first.storm_id;
  record.STORM_NAME = first.storm_name ?? "";
  record.BASIN = basinForCode(first.basin ?? "");
  record.TRACK_KIND = tctLib.tctTrackKind.Forecast;
  record.TRACK_ORIGIN =
    (first.track_origin ?? "").trim().toLowerCase() === "genesis"
      ? tctLib.tctTrackOrigin.Genesis
      : tctLib.tctTrackOrigin.ExistingSystem;
  record.MODEL_CLASS = enumValue(tctLib.wxfModelClass, job.model_class, "Unspecified");
  record.MODEL_ID = job.model_id;
  record.MODEL_VERSION = job.model_version ?? "";
  record.INIT_TIME_MS = BigInt(parseIsoMs(first.init_time ?? ""));
  record.MEMBER_KIND = tctLib.wxfMemberKind.Member;
  record.MEMBER_INDEX = Number(first.member);
  record.ENSEMBLE_SIZE = job.ensemble_size;
  record.WIND_AVERAGING_PERIOD_S = job.wind_averaging_period_s;
  record.POINTS = points;
  record.ORIGIN_ID = job.origin_id;
  record.DATASET_ID = job.dataset_id;
  record.SOURCE_URL = job.source_url;
  record.RETRIEVED_AT = BigInt(retrievedAt);
  record.LICENSE_CLASS = enumValue(tctLib.wxfLicenseClass, job.license_class, "RealTimeExperimental");
  record.LICENSE_URL = job.license_url;
  record.CITATION = job.citation ?? "";
  record.PRODUCER_PEER_ID = "";

  const builder = new flatbuffers.Builder(2048);
  const offset = record.pack(builder);
  tctLib.TCT.finishSizePrefixedTCTBuffer(builder, offset);
  return finishRecord(builder);
}

export function unpackTct(record: Uint8Array): GeneratedModule {
  return tctLib.TCT.getRootAsTCT(new flatbuffers.ByteBuffer(record)).unpack();
}

export function parseCycloneTracks(
  job: CycloneJob,
  response: DecodedResponse,
  options: ParseOptions = {},
): ParseResult<GeneratedModule> {
  if (response.status !== 200) {
    throw new Error(`fetch-failed: cyclone tracks returned HTTP status ${response.status}`);
  }
  const nowMs = options.nowMs ?? Date.now();
  const csv = parseCycloneCsv(textDecoder.decode(response.body));
  for (const column of ["storm_id", "member", "valid_time", "latitude", "longitude", "max_sustained_wind_kt"]) {
    if (!csv.header.includes(column)) throw new Error(`cyclone CSV is missing required column ${column}`);
  }
  // Group by (storm_id, member) in FIRST-APPEARANCE order, file order kept
  // within a group until the per-track sort by valid time.
  const groups = new Map<string, Record<string, string>[]>();
  for (const row of csv.rows) {
    if ((row.storm_id ?? "").trim() === "") continue;
    const key = `${row.storm_id}|${Number(row.member)}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  if (groups.size === 0) throw new Error("no cyclone track rows parsed");
  const retrievedAt = retrievedAtMs(response.headers, nowMs);
  const recordBuffers: Uint8Array[] = [];
  const records: GeneratedModule[] = [];
  for (const rows of groups.values()) {
    const record = buildTctRecord(job, rows, retrievedAt);
    recordBuffers.push(record);
    records.push(unpackTct(record));
  }
  const batchId = sha256Hex([response.body]);
  const provenance = buildProvenance({
    parserVersion: PARSER_VERSION_CYCLONES,
    sourceUrl: job.source_url,
    status: response.status,
    headers: response.headers,
    sourceSha256: batchId,
    normalizedSha256: normalizedSha256("TCT.fbs", recordBuffers),
    normalizedCount: recordBuffers.length,
    schemaCounts: { "TCT.fbs": recordBuffers.length },
    retrievedAtMs: retrievedAt,
  });
  const meta = buildMeta({
    schema: "TCT.fbs",
    job,
    sourceUrl: job.source_url,
    batchId,
    archive: { source: job.archive_source, name: job.archive_name },
    provenance,
  });
  return { meta, recordsStream: concatStream(recordBuffers), records, recordBuffers };
}
