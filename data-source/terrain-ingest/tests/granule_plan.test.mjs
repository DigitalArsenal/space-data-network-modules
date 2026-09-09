// granule_plan: the GRANULE-MAJOR enumeration the pyramid builder runs.
//
// The properties that matter are all properties of the SCHEDULE, and all
// computable:
//
//   * PARTITION. Walking the whole enumeration must assign every tile of the
//     region to EXACTLY ONE cell — no tile planned twice (duplicate work and a
//     duplicate record), none missed (a hole in the pyramid). The south-west
//     corner rule is what makes that true and this is what proves it.
//   * CONTAINMENT. Every tile a cell plans must lie inside that cell's 2x2
//     granule neighbourhood, or the encoder samples an extent it was never
//     given bytes for and fills it with sea level.
//   * RESUMABILITY. The enumeration is a pure function of the config, so the
//     mark is one integer and re-planning from it reproduces the tail exactly.
//   * THE LEVEL FLOOR. Below level 8 a tile is wider than a granule and the
//     containment argument collapses; the planner must refuse by name rather
//     than build tiles with most of their extent missing.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"));
const WASM = fs.readFileSync(fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url)));
const S3 = "https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const frame = (portId, payload) => {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : Uint8Array.from(payload);
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.byteLength },
    payload: bytes,
  };
};
const jsonFrame = (portId, value) => frame(portId, JSON.stringify(value));

// A 2x2-degree region built to two levels, so the walk covers four cells at
// each of z8 and z9 and the partition has something to get wrong.
const REGION = { name: "test-coast", west: 10, south: 45, east: 12, north: 47, max_level: 9 };
const CONFIG = {
  tileset_id: "spaceaware-terrain",
  dataset_epoch: "2023-04-01T00:00:00.000Z",
  retrieved_at: "2026-08-26T00:00:00.000Z",
  max_level: 9,
  min_level: 8,
  grid_size: 65,
  regions: [REGION],
};

async function planOnce(t, { config = CONFIG, mark = null } = {}) {
  const harness = await createBrowserModuleHarness({
    wasmSource: WASM,
    manifest: MANIFEST,
    surface: "direct",
    hostcallDispatch: (operation) => {
      if (operation === "plugin.getConfig") return config;
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  t.after(() => harness.destroy());
  const inputs = [jsonFrame("tick", { firedAt: "2026-08-26T00:00:00Z" })];
  if (mark) inputs.push(jsonFrame("mark", mark));
  const response = await harness.invoke({ methodId: "granule_plan", inputs });
  if (response.statusCode !== 0) return { error: response.errorCode, message: response.errorMessage };
  const byPort = new Map();
  for (const out of response.outputs) byPort.set(out.portId, JSON.parse(decoder.decode(out.payload)));
  return { byPort, backlog: response.backlogRemaining };
}

// Walk the whole enumeration by following the mark the job frame implies.
async function walkAll(t, config = CONFIG) {
  const cells = [];
  let next = 0;
  for (let guard = 0; guard < 200; guard++) {
    const { byPort } = await planOnce(t, {
      config,
      mark: { tileset_id: config.tileset_id, dataset_epoch: config.dataset_epoch, next_tile_index: next },
    });
    if (!byPort || !byPort.has("plan")) break;
    const job = byPort.get("job");
    cells.push({ job, plan: byPort.get("plan"), byPort });
    next = job.cell_index + 1;
  }
  return cells;
}

test("one invocation plans ONE cell: four DEM + four water descriptors and one tile block", async (t) => {
  const { byPort } = await planOnce(t);
  const plan = byPort.get("plan");
  const job = byPort.get("job");

  assert.equal(job.level, 8, "the shallowest planned level first");
  // The walk starts at cell (9, 44), not (10, 45), and that is the point. The
  // westmost z8 tile the region overlaps is x=270, whose west edge is 9.84375
  // — its SOUTH-WEST CORNER is in the cell to the WEST of the region. And the
  // southmost is y=192, whose south edge is exactly 45.0: the granule that
  // HOLDS that post row is N44, one cell SOUTH of the region, because a
  // granule's posts run from its north edge down to one spacing above its
  // south edge. Bounding the walk by the region's own degrees would drop that
  // entire column and that entire row.
  assert.equal(job.cell_lon, 9);
  assert.equal(job.cell_lat, 44);
  assert.equal(plan.tilesetId, "spaceaware-terrain");
  assert.equal(plan.scheme, "GEOGRAPHIC_WGS84");
  assert.equal(plan.rowOriginNorth, false);
  assert.equal(plan.gridSize, 65);
  assert.equal(plan.skipOceanTiles, true, "ocean omission remains the default");
  assert.ok(Array.isArray(plan.tiles) && plan.tiles.length > 0);

  // The provenance keys are the ones DTTProvenance is built from, verbatim.
  assert.equal(plan.provenance.datasetEpoch, CONFIG.dataset_epoch);
  assert.equal(plan.provenance.retrievedAt, CONFIG.retrieved_at);
  assert.ok(plan.provenance.license.length > 0, "LICENSE is required and never defaulted away");
  assert.ok(plan.provenance.sourceUrl.startsWith(S3));

  // The 2x2 neighbourhood, always exactly four of each.
  const demUrls = [0, 1, 2, 3].map((s) => byPort.get(`dem_${s}`).url);
  const wbmUrls = [0, 1, 2, 3].map((s) => byPort.get(`wbm_${s}`).url);
  assert.deepEqual(demUrls.map((u) => u.match(/_(N\d\d|S\d\d)_00_(E\d\d\d|W\d\d\d)/).slice(1)), [
    ["N44", "E009"],
    ["N44", "E010"],
    ["N45", "E009"],
    ["N45", "E010"],
  ]);
  for (const descriptor of [0, 1, 2, 3].map((s) => byPort.get(`dem_${s}`))) {
    assert.equal(descriptor.responseWire, "raw-body-v1", "binary granules never ride base64 JSON");
    assert.equal(descriptor.allow_404, true, "the dataset publishes no object over open ocean");
    assert.equal(descriptor.method, "GET");
  }
  for (const url of wbmUrls) assert.ok(url.includes("_WBM"), `water-body auxiliary, got ${url}`);
});

test("native planner retains observed ocean records only on explicit boolean opt-in", async (t) => {
  const baseline = (await planOnce(t)).byPort;
  for (const skipOceanTiles of [false, true]) {
    const { byPort } = await planOnce(t, { config: { ...CONFIG, skipOceanTiles } });
    assert.equal(byPort.get("plan").skipOceanTiles, skipOceanTiles);
    assert.deepEqual({ ...byPort.get("plan"), skipOceanTiles: true }, baseline.get("plan"),
      "the opt-in changes no addresses, geometry options or source provenance");
    assert.deepEqual(byPort.get("job"), baseline.get("job"));
  }
  for (const skipOceanTiles of ["false", 0, null, {}]) {
    const response = await planOnce(t, { config: { ...CONFIG, skipOceanTiles } });
    assert.equal(response.error, "invalid-ocean-skip-option");
    assert.equal(response.byPort, undefined);
  }
});

test("the enumeration PARTITIONS the region: every tile once, none missed", async (t) => {
  const cells = await walkAll(t);
  assert.ok(cells.length >= 8, `2x2 degrees at two levels is at least 8 cells, got ${cells.length}`);

  const seen = new Map(); // "level/x/y" -> times planned
  for (const { job, plan } of cells) {
    for (const tile of plan.tiles) {
      const key = `${job.level}/${tile.x}/${tile.y}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  for (const [key, times] of seen) {
    assert.equal(times, 1, `tile ${key} planned ${times} times: a duplicate is a duplicate record`);
  }

  // …and the set is exactly the region's tiles at each level, computed here
  // from the scheme rather than from anything the planner said.
  for (const level of [8, 9]) {
    const size = 180 / 2 ** level;
    const x0 = Math.floor((REGION.west + 180) / size);
    const x1 = Math.floor((REGION.east + 180) / size - 1e-9);
    const y0 = Math.floor((REGION.south + 90) / size);
    const y1 = Math.floor((REGION.north + 90) / size - 1e-9);
    const expected = new Set();
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) expected.add(`${level}/${x}/${y}`);
    const got = new Set([...seen.keys()].filter((k) => k.startsWith(`${level}/`)));
    assert.deepEqual(got, expected, `level ${level} is covered exactly`);
  }
});

test("EVERY POST of every planned tile is inside the cell's 2x2 granule neighbourhood", async (t) => {
  // The property is about POSTS, not about squares, and that distinction is
  // the whole bug this test failed to catch before 2026-08-26.
  //
  // A Copernicus granule's tiepoint is its NORTH-WEST corner and its posts stop
  // one spacing short of its south edge, so granule (lat, lon) holds
  // latitudes (lat, lat+1] and longitudes [lon, lon+1). The 2x2 neighbourhood
  // {cell_lat, cell_lat+1} x {cell_lon, cell_lon+1} therefore holds
  // latitudes (cell_lat, cell_lat+2] and longitudes [cell_lon, cell_lon+2).
  //
  // Under the old assignment rule (south-west corner INSIDE the square) a tile
  // whose south edge sat exactly on a whole-degree parallel had its entire
  // south post row OUTSIDE that latitude range: the encoder found no granule
  // for those 65 posts and emitted 0 m, a 340-metre cliff against the tile to
  // the south on the real pyramid. Asserting `south >= cell_lat` passed
  // happily on exactly the tiles that were broken, which is why the assertion
  // below is written against the granule's real coverage instead.
  let onParallel = 0;
  for (const { job, plan } of await walkAll(t)) {
    const size = 180 / 2 ** job.level;
    for (const tile of plan.tiles) {
      const west = -180 + tile.x * size;
      const south = -90 + tile.y * size;
      if (south === Math.floor(south)) onParallel += 1;
      // Latitude: (cell_lat, cell_lat + 2] — STRICT at the south end, because
      // the granule below the cell is not fetched.
      assert.ok(
        south > job.cell_lat,
        `south ${south} is not held by cell ${job.cell_lat} (its posts belong to ${job.cell_lat - 1})`,
      );
      assert.ok(south + size <= job.cell_lat + 2, "north edge inside the neighbourhood");
      // Longitude: [cell_lon, cell_lon + 2) — inclusive at the west end.
      assert.ok(west >= job.cell_lon, `west ${west} in cell ${job.cell_lon}`);
      assert.ok(west + size < job.cell_lon + 2, "east edge inside the neighbourhood");
    }
  }
  assert.ok(onParallel > 0, "the fixture must actually contain tiles sitting on a whole degree");
});

test("CHILD_AVAILABILITY CLAIMS NOTHING, because a shallow-to-deep walk cannot know it", async (t) => {
  // "A set bit states the child exists in this tileset." This planner walks
  // shallow to deep and the encoder SKIPS every all-ocean tile, so whether a
  // child inside the region block ends up stored is decided at a level that has
  // not been built yet. The old rule claimed region-block membership instead,
  // and a cross-check against a real regional store found the error in BOTH
  // directions: 114 bits claiming a child the tileset does not hold, and 18
  // clearing one it does.
  //
  // A clear bit is an absence of claim, not a claim of absence, so declining to
  // assert is the honest state of this knowledge. The tileset's real
  // availability statement is layer.json, which IS exact.
  const cells = await walkAll(t);
  let tiles = 0;
  for (const { plan } of cells) {
    for (const tile of plan.tiles) {
      tiles += 1;
      assert.equal(tile.childAvailability, 0, "no bit is set, at any level");
    }
  }
  assert.ok(tiles > 0, "the fixture must actually plan tiles");
});

test("the mark resumes the walk exactly, and a drained walk is a clean no-op", async (t) => {
  const all = await walkAll(t);
  const resumeAt = all[3].job.cell_index;
  const { byPort } = await planOnce(t, {
    mark: { tileset_id: CONFIG.tileset_id, dataset_epoch: CONFIG.dataset_epoch, next_tile_index: resumeAt },
  });
  assert.deepEqual(byPort.get("plan"), all[3].plan, "resuming reproduces the same cell exactly");

  const drained = await planOnce(t, {
    mark: { tileset_id: CONFIG.tileset_id, dataset_epoch: CONFIG.dataset_epoch, next_tile_index: 1e6 },
  });
  assert.ok(!drained.byPort?.has("plan"), "a drained enumeration emits nothing");
  assert.ok(!drained.error, "…and is not an error");
});

test("a mark for another tileset or edition is IGNORED, never half-applied", async (t) => {
  const fresh = await planOnce(t);
  const foreign = await planOnce(t, {
    mark: { tileset_id: "some-other-pyramid", dataset_epoch: "1999-01-01T00:00:00.000Z", next_tile_index: 3 },
  });
  assert.deepEqual(foreign.byPort.get("plan"), fresh.byPort.get("plan"), "the walk starts from the top");
});

test("a level below the granule floor is REFUSED by name", async (t) => {
  const shallow = await planOnce(t, { config: { ...CONFIG, min_level: 7 } });
  assert.equal(shallow.error, "level-below-granule-floor");
  assert.match(shallow.message, /DOWNSAMPLING/);
});

test("the planner fails closed on identity it must not invent", async (t) => {
  for (const [key, code] of [
    ["tileset_id", "missing-tileset-id"],
    ["dataset_epoch", "missing-dataset-epoch"],
    ["retrieved_at", "missing-retrieved-at"],
  ]) {
    const config = { ...CONFIG };
    delete config[key];
    const result = await planOnce(t, { config });
    assert.equal(result.error, code, `missing ${key}`);
  }
  const noRegions = await planOnce(t, { config: { ...CONFIG, regions: [] } });
  assert.equal(noRegions.error, "no-regions");
});

test("an inset nested inside a broader region does not duplicate its tiles", async (t) => {
  // Insets are the point of the priority list: a small region built deeper,
  // inside a broader one built shallower. Their shared levels overlap
  // GEOGRAPHICALLY, so without an owner rule both regions plan the same
  // addresses — two fetch-and-encode passes and two records at one address,
  // which the serving lane's "newest record wins" would hide completely.
  const config = {
    ...CONFIG,
    max_level: 10,
    regions: [
      { name: "broad", west: 10, south: 45, east: 12, north: 47, max_level: 9, priority: 10 },
      { name: "inset", west: 10.5, south: 45.5, east: 11.5, north: 46.5, max_level: 10, priority: 20 },
    ],
  };
  const cells = await walkAll(t, config);
  assert.ok(cells.length > 0);

  const owner = new Map();
  for (const { job, plan } of cells) {
    for (const tile of plan.tiles) {
      const key = `${job.level}/${tile.x}/${tile.y}`;
      assert.ok(!owner.has(key), `tile ${key} planned by ${owner.get(key)} and again by ${job.region}`);
      owner.set(key, job.region);
    }
  }

  // …and the higher-priority region is the one that owns the shared ground.
  const size = 180 / 2 ** 9;
  const insetX = Math.floor((10.75 + 180) / size);
  const insetY = Math.floor((45.75 + 90) / size);
  assert.equal(owner.get(`9/${insetX}/${insetY}`), "inset", "priority decides, not config order");
});
