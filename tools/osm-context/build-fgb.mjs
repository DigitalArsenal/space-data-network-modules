// tools/osm-context/build-fgb.mjs — the OSM context epoch as FlatGeobuf files.
//
// OWNER DECISION 2026-09-03: "we need to host it as flatgeobuf". This is the
// FlatGeobuf builder next to build.mjs (PMTiles). One epoch is ONE DIRECTORY:
//
//   out/osm-context-<region>-<epoch>-fgb/
//     osm-context.fgb.json     the epoch record (files, sha256, counts, epoch,
//                              source, licence, attribution)
//     building.fgb             one FlatGeobuf per category and geometry kind,
//     road-lines.fgb           EPSG:4326, packed Hilbert R-tree index, the
//     water.fgb ...            columns the detector reads and nothing else
//
// A FlatGeobuf is FlatBuffers on disk with a spatial index in the header, so a
// client range-reads only the features under its view; there is no server
// component and no tile pyramid. The trade is storage: FlatGeobuf holds full-
// resolution geometry as float64 with no compression, so a region's building
// file is 7-10x the PMTiles archive of all seven layers (Hessen, measured
// 2026-09-03: 792 MB lean buildings vs 107 MB PMTiles). What a viewport pass
// transfers is similar under both.
//
// THE PIPELINE, per category:
//   1. osmium tags-filter <extract> <selectors> -o <tmp>/<category>.osm.pbf
//      The same tag selectors profile/osm-context.yml uses, so the two
//      builders answer the same question.
//   2. ogr2ogr -f FlatGeobuf <out>/<file>.fgb <tmp>/<category>.osm.pbf <layer>
//      with OSM_CONFIG_FILE=profile/osmconf-fgb.ini, which declares exactly
//      the tag columns the detector reads (height, building:levels, lanes,
//      width, ...) and turns other_tags OFF; `multipolygons` gives the
//      polygon file (closed ways and multipolygon relations, holes intact),
//      `lines` the line file (highways, railways, coastlines, runways,
//      taxiways, piers).
//   3. ogrinfo -so on every output for the feature count that goes into the
//      record; the file's magic bytes are checked here too.
//   4. The ocean: the osmdata water polygons (regions.json `ocean`, EPSG:3857)
//      reprojected to EPSG:4326 and clipped to the extract's bounding box into
//      ocean.fgb (category water, polygon, no tags) — coastline-derived open
//      water, which no extract carries as a natural=water polygon.
//   5. osm-context.fgb.json, DTT-shaped like write-record.mjs's record: the
//      $VTT/$OSM-context table is still to land in spacedatastandards.org, so
//      this is the fixture the OrbPro reader (runtime/fgbContext.js) validates.
//      PAYLOAD.CID stays empty until the directory is pinned.
//
//   node tools/osm-context/build-fgb.mjs --region hessen [--out out] [--cache cache]
//        [--offline] [--osmium <path>] [--ogr2ogr <path>] [--ogrinfo <path>]
//        [--no-ocean] [--ocean-sha256 <hex>] [--retrieved-at <iso>]
//
// Needs osmium-tool >= 1.14 and GDAL >= 3.6 (FlatGeobuf driver with spatial
// index, OSM driver) on PATH; nothing is installed by this script and a
// missing tool is a refusal that names it.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  digestFile,
  ensureExtract,
  ensureOcean,
  loadRegions,
  nowIso,
  run,
  stripAnsi,
} from "./build.mjs";
import { compactEpoch } from "./write-record.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OSMCONF = path.join(HERE, "profile", "osmconf-fgb.ini");
export const FGB_RECORD_NAME = "osm-context.fgb.json";
export const FGB_RECORD_FORMAT = "osm-context-fgb/1";
export const FGB_MEDIA_TYPE = "application/x-flatgeobuf";
export const DIRECTORY_MEDIA_TYPE = "application/vnd.ipld.dag-pb";
/**
 * FlatGeobuf magic: "fgb", major version 3, "fgb", then the writer's patch
 * version (GDAL writes 1, the reference writer 0), which is not checked.
 */
export const FGB_MAGIC = Object.freeze([0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62]);
const REGION_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * The categories, verbatim from profile/osm-context.yml's selectors, as
 * osmium tags-filter expressions (way-only: nodes carry no area or length the
 * detector rasterises; relations are kept implicitly by osmium's way
 * filtering because ogr2ogr assembles multipolygons from member ways — so
 * `r/` selectors are listed where relations carry the tag).
 *
 * `outputs` names the FlatGeobuf files each category yields and the GDAL OSM
 * layer feeding each: `multipolygons` (closed ways + multipolygon relations)
 * or `lines` (open ways).
 */
export const CATEGORIES = Object.freeze([
  Object.freeze({
    category: "water",
    selectors: Object.freeze([
      "wr/natural=water", "wr/waterway=riverbank,dock", "wr/landuse=reservoir,basin", "w/natural=coastline",
    ]),
    outputs: Object.freeze([
      Object.freeze({ name: "water.fgb", layer: "multipolygons", kind: "polygon", where: "natural = 'water' OR waterway IN ('riverbank','dock') OR landuse IN ('reservoir','basin')" }),
      Object.freeze({ name: "water-lines.fgb", layer: "lines", kind: "line", where: "natural = 'coastline'" }),
    ]),
  }),
  Object.freeze({
    category: "road",
    selectors: Object.freeze(["w/highway"]),
    outputs: Object.freeze([
      Object.freeze({ name: "road-lines.fgb", layer: "lines", kind: "line", where: "highway IS NOT NULL" }),
    ]),
  }),
  Object.freeze({
    category: "rail",
    selectors: Object.freeze(["w/railway=rail,light_rail,tram"]),
    outputs: Object.freeze([
      Object.freeze({ name: "rail-lines.fgb", layer: "lines", kind: "line", where: "railway IN ('rail','light_rail','tram')" }),
    ]),
  }),
  Object.freeze({
    category: "aeroway",
    selectors: Object.freeze(["wr/aeroway=aerodrome,apron,runway,taxiway,helipad,hangar"]),
    outputs: Object.freeze([
      Object.freeze({ name: "aeroway.fgb", layer: "multipolygons", kind: "polygon", where: "aeroway IN ('aerodrome','apron','runway','taxiway','helipad','hangar')" }),
      Object.freeze({ name: "aeroway-lines.fgb", layer: "lines", kind: "line", where: "aeroway IN ('runway','taxiway')" }),
    ]),
  }),
  Object.freeze({
    category: "parking",
    selectors: Object.freeze(["wr/amenity=parking"]),
    outputs: Object.freeze([
      Object.freeze({ name: "parking.fgb", layer: "multipolygons", kind: "polygon", where: "amenity = 'parking'" }),
    ]),
  }),
  Object.freeze({
    category: "industrial",
    selectors: Object.freeze(["wr/landuse=industrial,port,harbour", "wr/industrial", "wr/man_made=works,storage_tank,pier"]),
    outputs: Object.freeze([
      Object.freeze({ name: "industrial.fgb", layer: "multipolygons", kind: "polygon", where: "landuse IN ('industrial','port','harbour') OR industrial IS NOT NULL OR man_made IN ('works','storage_tank','pier')" }),
      Object.freeze({ name: "industrial-lines.fgb", layer: "lines", kind: "line", where: "man_made = 'pier'" }),
    ]),
  }),
  Object.freeze({
    category: "building",
    selectors: Object.freeze(["wr/building"]),
    outputs: Object.freeze([
      Object.freeze({ name: "building.fgb", layer: "multipolygons", kind: "polygon", where: "building IS NOT NULL AND building <> 'no'" }),
    ]),
  }),
]);

/** The exact osmium argv for one category's filtered extract. */
export function osmiumFilterArgs({ pbf, category, out }) {
  const spec = CATEGORIES.find((c) => c.category === category);
  assert.ok(spec, `unknown category ${JSON.stringify(category)}`);
  assert.ok(path.isAbsolute(pbf) && path.isAbsolute(out), "pbf and out must be absolute paths");
  return ["tags-filter", "--overwrite", "--no-progress", "-o", out, pbf, ...spec.selectors];
}

/** The exact ogr2ogr argv for one output file. */
export function ogr2ogrArgs({ input, output, layer, where }) {
  assert.ok(path.isAbsolute(input) && path.isAbsolute(output), "input and output must be absolute paths");
  assert.ok(layer === "multipolygons" || layer === "lines", `layer must be multipolygons or lines, got ${layer}`);
  const args = [
    "-f", "FlatGeobuf",
    "-lco", "SPATIAL_INDEX=YES",
    "-nln", path.basename(output, ".fgb"),
    "-t_srs", "EPSG:4326",
    "-progress",
  ];
  if (where) args.push("-where", where);
  args.push(output, input, layer);
  return args;
}

/** The shapefile inside osmdata's water-polygons-split-3857.zip. */
export const OCEAN_SHAPEFILE_IN_ZIP = "water-polygons-split-3857/water_polygons.shp";

/**
 * ogr2ogr argv for the ocean: osmdata's EPSG:3857 shapefile (read straight
 * out of the zip through GDAL's /vsizip/), clipped to the extract bbox
 * (given in EPSG:4326, so the clip is applied after reprojection with
 * -clipdst), written to EPSG:4326 without attributes (`-select` with no
 * fields: the ocean carries no tags).
 */
export function oceanArgs({ zip, output, bbox }) {
  assert.ok(path.isAbsolute(zip) && path.isAbsolute(output), "zip and output must be absolute paths");
  const { west, south, east, north } = bbox;
  for (const v of [west, south, east, north]) assert.ok(Number.isFinite(v), "bbox must be finite");
  return [
    "-f", "FlatGeobuf",
    "-lco", "SPATIAL_INDEX=YES",
    "-nln", "ocean",
    "-t_srs", "EPSG:4326",
    "-clipdst", String(west), String(south), String(east), String(north),
    "-progress",
    output,
    `/vsizip/${zip}/${OCEAN_SHAPEFILE_IN_ZIP}`,
  ];
}

/** `ogrinfo -so -al` prints "Feature Count: N" once per layer; the file holds one layer. */
export function parseOgrinfoCount(text) {
  const matches = [...stripAnsi(text).matchAll(/^Feature Count:\s*(\d+)\s*$/gm)];
  if (matches.length !== 1) throw new Error(`ogrinfo printed ${matches.length} "Feature Count" lines, expected exactly one`);
  return Number(matches[0][1]);
}

/** `osmium fileinfo -e` prints the data bounding box as "(west,south,east,north)". */
export function parseOsmiumBbox(text) {
  const match = /Bounding box:\s*\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/.exec(stripAnsi(text));
  if (!match) throw new Error("osmium fileinfo printed no bounding box");
  const [west, south, east, north] = match.slice(1, 5).map(Number);
  assert.ok(west < east && south < north, `bounding box (${west},${south},${east},${north}) is not ordered`);
  return { west, south, east, north };
}

/** `osmium --version` / `ogr2ogr --version` first lines. */
export function parseToolVersion(text, tool) {
  const line = stripAnsi(text).split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const patterns = {
    osmium: /osmium version (\d+\.\d+\.\d+)/,
    gdal: /GDAL (\d+\.\d+\.\d+)/,
  };
  const match = patterns[tool].exec(line);
  if (!match) throw new Error(`${tool} --version did not print a version: ${JSON.stringify(line)}`);
  return match[1];
}

/** The first eight bytes must be the FlatGeobuf magic. */
export function assertFgbMagic(file) {
  const handle = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(8);
    const read = fs.readSync(handle, head, 0, 8, 0);
    assert.equal(read, 8, `${file}: shorter than a FlatGeobuf header`);
    for (let i = 0; i < FGB_MAGIC.length; i++) {
      if (head[i] !== FGB_MAGIC[i]) throw new Error(`${file}: byte ${i} is 0x${head[i].toString(16)}, not FlatGeobuf magic 0x${FGB_MAGIC[i].toString(16)}`);
    }
  } finally {
    fs.closeSync(handle);
  }
}

/** Where an epoch lands. */
export function fgbOutputPaths({ out, region, epoch }) {
  assert.ok(REGION_NAME.test(region), `region ${JSON.stringify(region)} must be lower-case words joined by hyphens`);
  const stem = `osm-context-${region}-${compactEpoch(epoch)}`;
  const dir = path.join(out, `${stem}-fgb`);
  return {
    dir,
    record: path.join(dir, FGB_RECORD_NAME),
    report: path.join(out, `${stem}-fgb.run.json`),
    log: path.join(out, `build-fgb-${region}.log`),
    tmpdir: path.join(out, "tmp", `${region}-fgb`),
  };
}

/**
 * The epoch record. Pure: every input is passed in so the tests can build one
 * from saved numbers. DTT-shaped like write-record.mjs (same provenance keys);
 * FILES is what the reader walks.
 */
export function buildFgbRecord({ region, epoch, sourceUrl, retrievedAt, processor, files, ocean = null }) {
  assert.ok(REGION_NAME.test(region), `region ${JSON.stringify(region)} must be lower-case words joined by hyphens`);
  assert.match(epoch, ISO_SECONDS, `epoch ${JSON.stringify(epoch)} is not YYYY-MM-DDTHH:MM:SSZ`);
  assert.ok(typeof sourceUrl === "string" && sourceUrl.startsWith("https://"), "source URL must be https");
  assert.match(retrievedAt, ISO_SECONDS, `retrieved-at ${JSON.stringify(retrievedAt)} is not YYYY-MM-DDTHH:MM:SSZ`);
  assert.ok(typeof processor === "string" && processor.trim().length > 0, "processor must name the tools");
  assert.ok(Array.isArray(files) && files.length > 0, "files must be a non-empty array");
  const seen = new Set();
  let totalBytes = 0;
  const FILES = files.map((file) => {
    assert.match(file.name, /^[a-z0-9]+(?:-[a-z0-9]+)*\.fgb$/, `file name ${JSON.stringify(file.name)}`);
    assert.ok(!seen.has(file.name), `${file.name} listed twice`);
    seen.add(file.name);
    assert.ok(file.kind === "polygon" || file.kind === "line", `${file.name}: kind ${file.kind}`);
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 8, `${file.name}: bytes ${file.bytes}`);
    assert.match(file.sha256, /^[0-9a-f]{64}$/, `${file.name}: sha256`);
    assert.ok(Number.isSafeInteger(file.featureCount) && file.featureCount >= 0, `${file.name}: featureCount`);
    totalBytes += file.bytes;
    return {
      NAME: file.name,
      CATEGORY: file.category,
      KIND: file.kind,
      MEDIA_TYPE: FGB_MEDIA_TYPE,
      BYTES: file.bytes,
      SHA256: file.sha256,
      FEATURE_COUNT: file.featureCount,
      LAYER: file.layer,
      WHERE: file.where ?? null,
    };
  });
  const record = {
    FORMAT: FGB_RECORD_FORMAT,
    TILESET_ID: `osm-context-${region}-${compactEpoch(epoch)}-fgb`,
    REGION: region,
    CRS: "EPSG:4326",
    PAYLOAD: { CID: "", SIZE_BYTES: totalBytes, MEDIA_TYPE: DIRECTORY_MEDIA_TYPE },
    FILES,
    DATASET_EPOCH: epoch,
    PROVENANCE: {
      SOURCE: "OpenStreetMap",
      SOURCE_URL: sourceUrl,
      RETRIEVED_AT: retrievedAt,
      PROCESSOR: processor,
      LICENSE: "ODbL-1.0",
      SHARE_ALIKE: true,
      ATTRIBUTION: "© OpenStreetMap contributors",
      OCEAN: ocean === null ? null : {
        SOURCE_URL: ocean.url,
        SHA256: ocean.sha256,
        FILES_DATED: ocean.filesDated,
        LICENSE: "ODbL-1.0",
      },
    },
  };
  return record;
}

export function parseArgs(argv) {
  const args = { out: path.join(HERE, "out"), cache: path.join(HERE, "cache"), offline: false, ocean: true, osmium: "osmium", ogr2ogr: "ogr2ogr", ogrinfo: "ogrinfo" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${arg} needs a value`); return v; };
    if (arg === "--region") args.region = next();
    else if (arg === "--out") args.out = path.resolve(next());
    else if (arg === "--cache") args.cache = path.resolve(next());
    else if (arg === "--offline") args.offline = true;
    else if (arg === "--no-ocean") args.ocean = false;
    else if (arg === "--ocean-sha256") args.oceanSha256 = next();
    else if (arg === "--osmium") args.osmium = next();
    else if (arg === "--ogr2ogr") args.ogr2ogr = next();
    else if (arg === "--ogrinfo") args.ogrinfo = next();
    else if (arg === "--retrieved-at") args.retrievedAt = next();
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!args.region) throw new Error("--region is required");
  return args;
}

async function checked(command, argv, { cwd, onChunk } = {}) {
  const result = await run(command, argv, { cwd, onChunk });
  if (result.code !== 0) throw new Error(`${command} ${argv.join(" ")} exited ${result.code ?? result.signal}:\n${result.output.slice(-4000)}`);
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const regions = loadRegions();
  const spec = regions.regions[args.region];
  if (!spec) throw new Error(`unknown region ${args.region}; known: ${Object.keys(regions.regions).join(", ")}`);
  const startedAt = nowIso();

  const versions = {
    osmium: parseToolVersion((await checked(args.osmium, ["--version"])).output, "osmium"),
    gdal: parseToolVersion((await checked(args.ogr2ogr, ["--version"])).output, "gdal"),
  };
  const processor = `osmium-tool ${versions.osmium} + GDAL ${versions.gdal} (ogr2ogr FlatGeobuf)`;
  console.log(`== ${processor}`);

  const extract = await ensureExtract({ cache: args.cache, region: args.region, spec, offline: args.offline });
  const epoch = extract.state.timestamp;
  const paths = fgbOutputPaths({ out: args.out, region: args.region, epoch });
  fs.rmSync(paths.dir, { recursive: true, force: true });
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.mkdirSync(paths.tmpdir, { recursive: true });
  const log = fs.createWriteStream(paths.log, { flags: "w" });
  const onChunk = (chunk) => log.write(chunk);
  // build.mjs's run() spawns with the inherited environment; the GDAL OSM
  // driver reads its layer/column configuration from OSM_CONFIG_FILE.
  process.env.OSM_CONFIG_FILE = OSMCONF;

  const bbox = parseOsmiumBbox((await checked(args.osmium, ["fileinfo", "-e", extract.pbf], { onChunk })).output);
  console.log(`== ${args.region} epoch ${epoch}, bbox ${JSON.stringify(bbox)}`);

  const files = [];
  const timings = {};
  for (const category of CATEGORIES) {
    const filtered = path.join(paths.tmpdir, `${category.category}.osm.pbf`);
    let t0 = Date.now();
    await checked(args.osmium, osmiumFilterArgs({ pbf: extract.pbf, category: category.category, out: filtered }), { onChunk });
    timings[`osmium:${category.category}`] = Date.now() - t0;
    for (const output of category.outputs) {
      const file = path.join(paths.dir, output.name);
      t0 = Date.now();
      const result = await run(args.ogr2ogr, ogr2ogrArgs({ input: filtered, output: file, layer: output.layer, where: output.where }), { onChunk });
      if (result.code !== 0) throw new Error(`ogr2ogr for ${output.name} exited ${result.code}:\n${result.output.slice(-4000)}`);
      timings[`ogr2ogr:${output.name}`] = Date.now() - t0;
      assertFgbMagic(file);
      const featureCount = parseOgrinfoCount((await checked(args.ogrinfo, ["-so", "-al", file], { onChunk })).output);
      const digest = digestFile(file);
      files.push({ name: output.name, category: category.category, kind: output.kind, layer: output.layer, where: output.where, bytes: digest.bytes, sha256: digest.sha256, featureCount });
      console.log(`== ${output.name}: ${featureCount} features, ${digest.bytes} bytes`);
    }
  }

  let ocean = null;
  if (args.ocean) {
    ocean = await ensureOcean({ cache: args.cache, offline: args.offline, ocean: regions.ocean, pinOverride: args.oceanSha256 });
    const file = path.join(paths.dir, "ocean.fgb");
    const t0 = Date.now();
    const result = await run(args.ogr2ogr, oceanArgs({ zip: ocean.path, output: file, bbox }), { onChunk });
    if (result.code !== 0) throw new Error(`ogr2ogr for ocean.fgb exited ${result.code}:\n${result.output.slice(-4000)}`);
    timings["ogr2ogr:ocean.fgb"] = Date.now() - t0;
    assertFgbMagic(file);
    const featureCount = parseOgrinfoCount((await checked(args.ogrinfo, ["-so", "-al", file], { onChunk })).output);
    const digest = digestFile(file);
    files.push({ name: "ocean.fgb", category: "water", kind: "polygon", layer: "ocean", where: null, bytes: digest.bytes, sha256: digest.sha256, featureCount });
    console.log(`== ocean.fgb: ${featureCount} features, ${digest.bytes} bytes`);
  }

  const record = buildFgbRecord({
    region: args.region,
    epoch,
    sourceUrl: extract.sourceUrl,
    retrievedAt: args.retrievedAt ?? extract.retrievedAt,
    processor,
    files,
    ocean,
  });
  fs.writeFileSync(paths.record, `${JSON.stringify(record, null, 2)}\n`);
  const report = {
    region: args.region,
    epoch,
    startedAt,
    finishedAt: nowIso(),
    versions,
    extract: { pbf: extract.pbf, bytes: extract.bytes, md5: extract.md5, sourceUrl: extract.sourceUrl, retrievedAt: extract.retrievedAt },
    bbox,
    ocean: ocean === null ? null : { path: ocean.path, sha256: ocean.sha256, filesDated: ocean.filesDated },
    files,
    timingsMs: timings,
    outputs: paths,
  };
  fs.writeFileSync(paths.report, `${JSON.stringify(report, null, 2)}\n`);
  log.end();
  fs.rmSync(paths.tmpdir, { recursive: true, force: true });
  console.log(`== wrote ${paths.record}`);
  console.log(JSON.stringify(report.timingsMs));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exit(1);
  });
}
