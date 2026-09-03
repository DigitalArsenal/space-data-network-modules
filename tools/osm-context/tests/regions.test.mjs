// The region list: every URL's shape follows from the extract name, and the
// ocean pin is a real digest. No network.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { loadRegions, outputPaths, REGIONS_FILE, validateRegions } from "../build.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);

function committed() {
  return JSON.parse(fs.readFileSync(REGIONS_FILE, "utf8"));
}

test("the committed regions.json validates and names the two prototype regions", () => {
  const regions = loadRegions();
  assert.deepEqual(Object.keys(regions.regions).sort(), ["hessen", "zuid-holland"]);
  assert.equal(regions.regions.hessen.pbf, "https://download.geofabrik.de/europe/germany/hessen-latest.osm.pbf");
  assert.equal(regions.regions.hessen.md5, "https://download.geofabrik.de/europe/germany/hessen-latest.osm.pbf.md5");
  assert.equal(regions.regions.hessen.state, "https://download.geofabrik.de/europe/germany/hessen-updates/state.txt");
  assert.equal(regions.regions["zuid-holland"].pbf, "https://download.geofabrik.de/europe/netherlands/zuid-holland-latest.osm.pbf");
  assert.equal(regions.regions["zuid-holland"].state, "https://download.geofabrik.de/europe/netherlands/zuid-holland-updates/state.txt");
  assert.equal(regions.ocean.url, "https://osmdata.openstreetmap.de/download/water-polygons-split-3857.zip");
  assert.equal(regions.ocean.sha256, "05ba9c22b108adcae9724946f6da9b395119556c75cfac12cddc0f8079215435");
  assert.equal(regions.ocean.bytes, 928928907);
});

test("the evidence records were built from the regions the list names", () => {
  const regions = loadRegions();
  for (const [name, spec] of Object.entries(regions.regions)) {
    const record = JSON.parse(fs.readFileSync(path.join(HERE, "..", "evidence", `osm-context-${name}-20260902T202051Z.vtt.json`), "utf8"));
    assert.equal(record.PROVENANCE.SOURCE_URL, spec.pbf);
    assert.equal(record.TILESET_ID, `osm-context-${name}-20260902T202051Z`);
    assert.equal(record.PROVENANCE.DATASET_EPOCH, "2026-09-02T20:20:51Z");
  }
});

test("a region whose URLs do not follow from its name is refused", () => {
  const mutate = (change) => {
    const json = committed();
    change(json);
    return json;
  };
  assert.throws(() => validateRegions(mutate((j) => { j.regions.hessen.md5 = "https://download.geofabrik.de/europe/germany/hessen.md5"; })), /hessen\.md5 must be the extract URL plus \.md5/);
  assert.throws(() => validateRegions(mutate((j) => { j.regions.hessen.state = "https://download.geofabrik.de/europe/germany/state.txt"; })), /hessen\.state must be/);
  assert.throws(() => validateRegions(mutate((j) => { j.regions.hessen.pbf = "http://download.geofabrik.de/europe/germany/hessen-latest.osm.pbf"; })), /hessen\.pbf must be https:\/\/download\.geofabrik\.de\//);
  assert.throws(() => validateRegions(mutate((j) => { j.regions.Hessen = j.regions.hessen; })), /"Hessen" must be lower-case/);
  assert.throws(() => validateRegions(mutate((j) => { j.regions.hessen.bounds = [0, 0, 1, 1]; })), /unknown keys: bounds/);
  assert.throws(() => validateRegions(mutate((j) => { j.regions = {}; })), /names no regions/);
  assert.throws(() => validateRegions(mutate((j) => { j.ocean.sha256 = "not-a-digest"; })), /ocean\.sha256/);
  assert.throws(() => validateRegions(mutate((j) => { j.ocean.url = "https://example.org/water-polygons-split-3857.zip"; })), /ocean\.url must be/);
  assert.throws(() => validateRegions(mutate((j) => { delete j.ocean; })), /needs an `ocean` block/);
  // A well-formed new region is accepted as it is.
  const extended = mutate((j) => {
    j.regions.monaco = {
      pbf: "https://download.geofabrik.de/europe/monaco-latest.osm.pbf",
      md5: "https://download.geofabrik.de/europe/monaco-latest.osm.pbf.md5",
      state: "https://download.geofabrik.de/europe/monaco-updates/state.txt",
    };
  });
  assert.equal(validateRegions(extended), extended);
});

test("output paths carry the region and the compact epoch", () => {
  const paths = outputPaths({ out: "/tmp/o", region: "zuid-holland", epoch: "2026-09-02T20:20:51Z" });
  assert.deepEqual(paths, {
    archive: "/tmp/o/osm-context-zuid-holland-20260902T202051Z.pmtiles",
    record: "/tmp/o/osm-context-zuid-holland-20260902T202051Z.vtt.json",
    report: "/tmp/o/osm-context-zuid-holland-20260902T202051Z.run.json",
    log: "/tmp/o/build-zuid-holland.log",
    tmpdir: "/tmp/o/tmp/zuid-holland",
  });
  assert.throws(() => outputPaths({ out: "/tmp/o", region: "Zuid Holland", epoch: "2026-09-02T20:20:51Z" }), /lower-case/);
});
