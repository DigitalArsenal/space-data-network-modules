// build-fgb.mjs: the argv it hands osmium and ogr2ogr, its parsers against
// saved tool output, the record it writes. No osmium, no GDAL, no network.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CATEGORIES,
  FGB_MAGIC,
  FGB_MEDIA_TYPE,
  FGB_RECORD_FORMAT,
  assertFgbMagic,
  buildFgbRecord,
  fgbOutputPaths,
  ogr2ogrArgs,
  oceanArgs,
  osmiumFilterArgs,
  parseArgs,
  parseOgrinfoCount,
  parseOsmiumBbox,
  parseToolVersion,
} from "../build-fgb.mjs";
import { profileLayers } from "../build.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const fixture = (name) => path.join(HERE, "fixtures", name);

test("the FlatGeobuf categories are the PMTiles profile's seven layers, each with its outputs", () => {
  const profile = fs.readFileSync(path.join(HERE, "..", "profile", "osm-context.yml"), "utf8");
  assert.deepEqual(CATEGORIES.map((c) => c.category).sort(), profileLayers(profile).map((layer) => layer.id).sort());
  for (const category of CATEGORIES) {
    assert.ok(category.selectors.length > 0, `${category.category} has selectors`);
    assert.ok(category.outputs.length > 0, `${category.category} has outputs`);
    for (const output of category.outputs) {
      assert.match(output.name, /^[a-z0-9]+(?:-[a-z0-9]+)*\.fgb$/);
      assert.ok(["multipolygons", "lines"].includes(output.layer));
      assert.equal(output.kind, output.layer === "lines" ? "line" : "polygon");
    }
  }
  const names = CATEGORIES.flatMap((c) => c.outputs.map((o) => o.name));
  assert.equal(new Set(names).size, names.length, "output names are unique");
});

test("osmium and ogr2ogr argv are exact and absolute", () => {
  assert.deepEqual(osmiumFilterArgs({ pbf: "/x/hessen.osm.pbf", category: "building", out: "/x/tmp/building.osm.pbf" }), [
    "tags-filter", "--overwrite", "--no-progress", "-o", "/x/tmp/building.osm.pbf", "/x/hessen.osm.pbf", "wr/building",
  ]);
  assert.deepEqual(osmiumFilterArgs({ pbf: "/x/a.pbf", category: "water", out: "/x/w.pbf" }).slice(6), [
    "wr/natural=water", "wr/waterway=riverbank,dock", "wr/landuse=reservoir,basin", "w/natural=coastline",
  ]);
  assert.throws(() => osmiumFilterArgs({ pbf: "a.pbf", category: "water", out: "/x/w.pbf" }), /absolute/);
  assert.throws(() => osmiumFilterArgs({ pbf: "/a.pbf", category: "ocean", out: "/x/w.pbf" }), /unknown category/);
  assert.deepEqual(ogr2ogrArgs({ input: "/x/tmp/building.osm.pbf", output: "/x/out/building.fgb", layer: "multipolygons", where: "building IS NOT NULL" }), [
    "-f", "FlatGeobuf", "-lco", "SPATIAL_INDEX=YES", "-nln", "building", "-t_srs", "EPSG:4326", "-progress",
    "-where", "building IS NOT NULL", "/x/out/building.fgb", "/x/tmp/building.osm.pbf", "multipolygons",
  ]);
  assert.throws(() => ogr2ogrArgs({ input: "/a", output: "/b.fgb", layer: "points" }), /multipolygons or lines/);
  const ocean = oceanArgs({ zip: "/c/water-polygons-split-3857.zip", output: "/o/ocean.fgb", bbox: { west: 7.7, south: 49.3, east: 10.3, north: 51.7 } });
  assert.deepEqual(ocean.slice(8, 13), ["-clipdst", "7.7", "49.3", "10.3", "51.7"]);
  assert.equal(ocean[ocean.length - 1], "/vsizip//c/water-polygons-split-3857.zip/water-polygons-split-3857/water_polygons.shp");
  assert.throws(() => oceanArgs({ zip: "/c.zip", output: "/o.fgb", bbox: { west: NaN, south: 0, east: 1, north: 1 } }), /finite/);
});

test("parsers: ogrinfo feature count, osmium bounding box, tool versions", () => {
  assert.equal(parseOgrinfoCount("INFO: Open of `x.fgb'\nLayer name: building\nGeometry: Multi Polygon\nFeature Count: 2761957\nExtent: (8.0, 49.0) - (10.0, 51.0)\n"), 2761957);
  assert.throws(() => parseOgrinfoCount("Layer name: a\n"), /expected exactly one/);
  assert.throws(() => parseOgrinfoCount("Feature Count: 1\nFeature Count: 2\n"), /expected exactly one/);
  assert.deepEqual(parseOsmiumBbox("File:\n  Name: hessen-latest.osm.pbf\nData:\n  Bounding box: (7.7726,49.3949,10.2384,51.6577)\n"), { west: 7.7726, south: 49.3949, east: 10.2384, north: 51.6577 });
  assert.throws(() => parseOsmiumBbox("Data:\n  Bounding box: (2,1,1,2)\n"), /not ordered/);
  assert.throws(() => parseOsmiumBbox("no box"), /no bounding box/);
  assert.equal(parseToolVersion("osmium version 1.19.1\nlibosmium version 2.22.0\n", "osmium"), "1.19.1");
  assert.equal(parseToolVersion('GDAL 3.13.3 "Iowa City", released 2026/08/13\n', "gdal"), "3.13.3");
  assert.throws(() => parseToolVersion("nothing", "gdal"), /did not print a version/);
});

test("assertFgbMagic accepts a real FlatGeobuf and refuses anything else", () => {
  assertFgbMagic(fixture("fixture-building.fgb"));
  const head = fs.readFileSync(fixture("fixture-building.fgb")).subarray(0, 7);
  assert.deepEqual(Array.from(head), FGB_MAGIC);
  assert.throws(() => assertFgbMagic(fixture("hessen.header.bin")), /not FlatGeobuf magic/);
});

test("fgbOutputPaths and parseArgs", () => {
  const paths = fgbOutputPaths({ out: "/o", region: "hessen", epoch: "2026-09-02T20:20:51Z" });
  assert.equal(paths.dir, "/o/osm-context-hessen-20260902T202051Z-fgb");
  assert.equal(paths.record, "/o/osm-context-hessen-20260902T202051Z-fgb/osm-context.fgb.json");
  assert.equal(paths.report, "/o/osm-context-hessen-20260902T202051Z-fgb.run.json");
  assert.throws(() => fgbOutputPaths({ out: "/o", region: "Hessen", epoch: "2026-09-02T20:20:51Z" }), /lower-case/);
  const args = parseArgs(["--region", "hessen", "--offline", "--no-ocean", "--out", "/tmp/o", "--ocean-sha256", "ab"]);
  assert.equal(args.region, "hessen");
  assert.equal(args.offline, true);
  assert.equal(args.ocean, false);
  assert.equal(args.out, "/tmp/o");
  assert.equal(args.oceanSha256, "ab");
  assert.throws(() => parseArgs([]), /--region is required/);
  assert.throws(() => parseArgs(["--region"]), /needs a value/);
  assert.throws(() => parseArgs(["--region", "x", "--bogus"]), /unknown argument/);
});

test("buildFgbRecord: DTT-shaped, files verbatim, sizes summed, ocean provenance", () => {
  const files = [
    { name: "building.fgb", category: "building", kind: "polygon", layer: "multipolygons", where: "building IS NOT NULL AND building <> 'no'", bytes: 792230144, sha256: "a".repeat(64), featureCount: 2761957 },
    { name: "road-lines.fgb", category: "road", kind: "line", layer: "lines", where: "highway IS NOT NULL", bytes: 364512632, sha256: "b".repeat(64), featureCount: 1189661 },
    { name: "ocean.fgb", category: "water", kind: "polygon", layer: "ocean", where: null, bytes: 1000, sha256: "c".repeat(64), featureCount: 3 },
  ];
  const record = buildFgbRecord({
    region: "hessen",
    epoch: "2026-09-02T20:20:51Z",
    sourceUrl: "https://download.geofabrik.de/europe/germany/hessen-latest.osm.pbf",
    retrievedAt: "2026-09-03T18:56:15Z",
    processor: "osmium-tool 1.19.1 + GDAL 3.13.3 (ogr2ogr FlatGeobuf)",
    files,
    ocean: { url: "https://osmdata.openstreetmap.de/download/water-polygons-split-3857.zip", sha256: "d".repeat(64), filesDated: "2026-09-01T23:28:00Z" },
  });
  assert.equal(record.FORMAT, FGB_RECORD_FORMAT);
  assert.equal(record.TILESET_ID, "osm-context-hessen-20260902T202051Z-fgb");
  assert.equal(record.CRS, "EPSG:4326");
  assert.deepEqual(record.PAYLOAD, { CID: "", SIZE_BYTES: 792230144 + 364512632 + 1000, MEDIA_TYPE: "application/vnd.ipld.dag-pb" });
  assert.equal(record.FILES.length, 3);
  assert.deepEqual(record.FILES[0], {
    NAME: "building.fgb", CATEGORY: "building", KIND: "polygon", MEDIA_TYPE: FGB_MEDIA_TYPE, BYTES: 792230144,
    SHA256: "a".repeat(64), FEATURE_COUNT: 2761957, LAYER: "multipolygons", WHERE: "building IS NOT NULL AND building <> 'no'",
  });
  assert.equal(record.DATASET_EPOCH, "2026-09-02T20:20:51Z");
  assert.equal(record.PROVENANCE.LICENSE, "ODbL-1.0");
  assert.equal(record.PROVENANCE.SHARE_ALIKE, true);
  assert.equal(record.PROVENANCE.ATTRIBUTION, "© OpenStreetMap contributors");
  assert.equal(record.PROVENANCE.OCEAN.FILES_DATED, "2026-09-01T23:28:00Z");
  assert.deepEqual(Object.keys(record), ["FORMAT", "TILESET_ID", "REGION", "CRS", "PAYLOAD", "FILES", "DATASET_EPOCH", "PROVENANCE"]);
  assert.throws(() => buildFgbRecord({ region: "hessen", epoch: "2026-09-02T20:20:51Z", sourceUrl: "http://x", retrievedAt: "2026-09-03T18:56:15Z", processor: "p", files }), /https/);
  assert.throws(() => buildFgbRecord({ region: "hessen", epoch: "2026-09-02T20:20:51Z", sourceUrl: "https://x", retrievedAt: "2026-09-03T18:56:15Z", processor: "p", files: [files[0], files[0]] }), /listed twice/);
  assert.throws(() => buildFgbRecord({ region: "hessen", epoch: "2026-09-02T20:20:51Z", sourceUrl: "https://x", retrievedAt: "2026-09-03T18:56:15Z", processor: "p", files: [{ ...files[0], sha256: "zz" }] }), /sha256/);
});
