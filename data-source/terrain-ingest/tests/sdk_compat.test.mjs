// data-source/terrain-ingest SDK-compat tests: the four scheduler nodes turn a
// timer tick into a flatsql query, a bounded REGION-PRIORITY-ordered batch of
// terrain-tile plan frames, a storage attribution frame and an advanced resume
// mark — with runner defaults and node-CONFIG overrides through the builtin
// plugin.getConfig hostcall.
//
// Every assertion is a computable outcome of the SCHEDULE: which granule URLs
// a tile needs (including the N00/S01/E000/W001 naming edge cases), in what
// order tiles are planned, where a mark resumes the walk, how big a batch may
// be, and under exactly which conditions the mark advances.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
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

const S3 = "https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const readWasm = () => fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));

function frame(portId, payload) {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : Uint8Array.from(payload);
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.byteLength },
    payload: bytes,
  };
}
const jsonFrame = (portId, value) => frame(portId, JSON.stringify(value));
const tickInput = (firedAt = "2026-08-15T00:00:00Z") => jsonFrame("tick", { firedAt });

function createConfigStub(config = {}) {
  const calls = [];
  const dispatch = (operation) => {
    calls.push(operation);
    if (operation === "plugin.getConfig") return config;
    throw new Error(`unexpected hostcall operation: ${operation}`);
  };
  return { calls, dispatch };
}

async function createHarness(t, stub) {
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
    surface: "direct",
    hostcallDispatch: stub.dispatch,
  });
  t.after(() => harness.destroy());
  return harness;
}

function assertOk(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
}

function outputsByPort(response) {
  assertOk(response);
  const map = new Map();
  for (const out of response.outputs) {
    try {
      map.set(out.portId, JSON.parse(decoder.decode(out.payload)));
    } catch {
      map.set(out.portId, Buffer.from(out.payload));
    }
  }
  return map;
}

function planFrames(response) {
  assertOk(response);
  return response.outputs
    .filter((o) => o.portId === "plan")
    .map((o) => JSON.parse(decoder.decode(o.payload)));
}

// The reference fixture: two regions, higher-priority second in config order,
// so the priority sort (not the config order) must decide the walk.
//
//   alps    pri 10, max_level 2:  L0 1 tile, L1 1 tile, L2 2 tiles  -> 4
//   iceland pri  5, max_level 1:  L0 1 tile, L1 1 tile              -> 2
//
// Total enumeration: indices 0..3 alps (shallow before deep), 4..5 iceland.
const CONFIG = {
  tileset_id: "glo30-test",
  global_max_level: 4,
  regions: [
    { name: "iceland", west: -24, south: 63, east: -13, north: 67, max_level: 1, priority: 5 },
    { name: "alps", west: 5, south: 44, east: 8, north: 47, max_level: 2, priority: 10 },
  ],
  license: "Test License",
  license_url: "https://example.test/license",
  attribution: "Test Attribution",
};
const EPOCH = "2026-08-15T00:00:00.000Z";

// ---------------------------------------------------------------------------
// artifact
// ---------------------------------------------------------------------------

test("terrain-ingest artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("terrain-ingest imports only WASI + the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  const modules = Array.from(new Set(inspection.imports.map((e) => e.module))).sort();
  assert.deepEqual(modules, ["space_data_module_host", "wasi_snapshot_preview1"]);
});

test("the manifest declares capabilities [] and both runtime targets", () => {
  const manifest = readManifest();
  assert.deepEqual(manifest.capabilities, []);
  assert.deepEqual(manifest.runtimeTargets, ["browser", "wasmedge"]);
  assert.equal(manifest.pluginId, "com.digitalarsenal.data-source.terrain-ingest");
});

test("the guest-link metadata declares single-thread", () => {
  const metadata = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL("../dist/guest-link/metadata.json", import.meta.url)), "utf8"),
  );
  assert.equal(metadata.threadModel, "single-thread");
});

// ---------------------------------------------------------------------------
// mark_query
// ---------------------------------------------------------------------------

test("mark_query emits {sql,params}, which is the only shape flatsql-query executes", async (t) => {
  const stub = createConfigStub();
  const harness = await createHarness(t, stub);
  const query = outputsByPort(await harness.invoke({ methodId: "mark_query", inputs: [tickInput()] })).get("query");
  assert.match(query.sql, /^SELECT \* FROM terrain_ingest_mark WHERE dataset_id = \? LIMIT 1$/);
  assert.deepEqual(query.params, [{ t: "str", v: "copernicus-glo30-quantized-mesh" }]);
  assert.deepEqual(stub.calls, ["plugin.getConfig"]);
});

test("mark_query keys the mark on the CONFIGURED dataset", async (t) => {
  const harness = await createHarness(t, createConfigStub({ dataset_id: "glo30-custom" }));
  const query = outputsByPort(await harness.invoke({ methodId: "mark_query", inputs: [tickInput()] })).get("query");
  assert.deepEqual(query.params, [{ t: "str", v: "glo30-custom" }]);
});

// ---------------------------------------------------------------------------
// granule URL construction — the naming edge cases, exercised through the plan
// ---------------------------------------------------------------------------

test("granule URLs handle the N00 / S01 / E000 / W001 edge cells exactly", async (t) => {
  // A 2x2 degree region straddling the equator and prime meridian, planned at
  // level 0 only: the two root-adjacent tiles clip to exactly the four cells
  // whose names are the known traps (S counts down from the south edge, so
  // [-1,0) is S01 and [0,1) is N00; W likewise, so [-1,0) is W001 and [0,1)
  // is E000).
  const harness = await createHarness(
    t,
    createConfigStub({
      tileset_id: "edge-test",
      global_max_level: 0,
      regions: [{ name: "origin", west: -1, south: -1, east: 1, north: 1, max_level: 0, priority: 1 }],
    }),
  );
  const plans = planFrames(await harness.invoke({ methodId: "ingest_plan", inputs: [tickInput()] }));
  assert.equal(plans.length, 2, "the region straddles both level-0 root tiles");

  const stem = (latTag, lonTag) => `Copernicus_DSM_COG_10_${latTag}_00_${lonTag}_00`;
  const dem = (latTag, lonTag) => `${S3}${stem(latTag, lonTag)}_DEM/${stem(latTag, lonTag)}_DEM.tif`;
  const wbm = (latTag, lonTag) => `${S3}${stem(latTag, lonTag)}_DEM/AUXFILES/${stem(latTag, lonTag)}_WBM.tif`;

  const west = plans.find((p) => p.tile.x === 0);
  const east = plans.find((p) => p.tile.x === 1);
  // Western root tile: only the [-1,0) longitude column -> W001; both latitude
  // cells -> S01 below the equator, N00 above it.
  assert.deepEqual(west.dem_urls, [dem("S01", "W001"), dem("N00", "W001")]);
  assert.deepEqual(west.wbm_urls, [wbm("S01", "W001"), wbm("N00", "W001")]);
  // Eastern root tile: only the [0,1) column -> E000.
  assert.deepEqual(east.dem_urls, [dem("S01", "E000"), dem("N00", "E000")]);
  assert.deepEqual(east.wbm_urls, [wbm("S01", "E000"), wbm("N00", "E000")]);
});

test("granule URLs carry zero-padded lat/lon for an ordinary land tile", async (t) => {
  const harness = await createHarness(t, createConfigStub(CONFIG));
  const plans = planFrames(await harness.invoke({ methodId: "ingest_plan", inputs: [tickInput()] }));
  // Plan index 0 is the alps' level-0 tile; its granules are the region bbox
  // [5,44]-[8,47] expanded to whole-degree cells: lon 5..7, lat 44..46.
  const first = plans[0];
  assert.equal(first.dem_urls.length, 9);
  assert.equal(
    first.dem_urls[0],
    `${S3}Copernicus_DSM_COG_10_N44_00_E005_00_DEM/Copernicus_DSM_COG_10_N44_00_E005_00_DEM.tif`,
  );
  assert.equal(
    first.wbm_urls[0],
    `${S3}Copernicus_DSM_COG_10_N44_00_E005_00_DEM/AUXFILES/Copernicus_DSM_COG_10_N44_00_E005_00_WBM.tif`,
  );
});

test("a western-hemisphere region names W granules with three digits", async (t) => {
  const harness = await createHarness(t, createConfigStub(CONFIG));
  const plans = planFrames(await harness.invoke({ methodId: "ingest_plan", inputs: [tickInput()] }));
  // Index 4 is iceland's level-0 tile: lon -24..-14 -> W024..W014, lat 63..66.
  const iceland = plans[4];
  assert.equal(iceland.region, "iceland");
  assert.match(iceland.dem_urls[0], /Copernicus_DSM_COG_10_N63_00_W024_00_DEM\.tif$/);
});

// ---------------------------------------------------------------------------
// ingest_plan — ordering, batching, resume, backlog
// ---------------------------------------------------------------------------

test("the walk is REGION-PRIORITY ordered: higher priority first, shallow before deep", async (t) => {
  const harness = await createHarness(t, createConfigStub(CONFIG));
  const plans = planFrames(await harness.invoke({ methodId: "ingest_plan", inputs: [tickInput()] }));
  assert.equal(plans.length, 6, "the whole fixture pyramid fits one default batch");
  // The alps are LISTED SECOND in config but carry the higher priority, so the
  // sort — not the config order — must have decided the walk.
  assert.deepEqual(
    plans.map((p) => [p.region, p.tile.level]),
    [["alps", 0], ["alps", 1], ["alps", 2], ["alps", 2], ["iceland", 0], ["iceland", 1]],
  );
  assert.deepEqual(plans.map((p) => p.index), [0, 1, 2, 3, 4, 5]);
  // TMS row origin is SOUTH: the alps' two level-2 tiles stack northward, so
  // the lower row index comes first and is the southern tile.
  assert.equal(plans[2].tile.y, 2);
  assert.equal(plans[3].tile.y, 3);
  assert.ok(plans[2].tile.south < plans[3].tile.south);
});

test("every plan entry allows 404 — ocean granules simply do not exist upstream", async (t) => {
  // The guest cannot cheaply know land from ocean, so ALL granules are planned
  // and the fetcher treats 404 as no-data. This is the documented contract,
  // not a fallback.
  const harness = await createHarness(t, createConfigStub(CONFIG));
  const plans = planFrames(await harness.invoke({ methodId: "ingest_plan", inputs: [tickInput()] }));
  for (const p of plans) assert.equal(p.allow_404, true);
});

test("provenance passes the configured licence and attribution through VERBATIM", async (t) => {
  const harness = await createHarness(t, createConfigStub(CONFIG));
  const plans = planFrames(await harness.invoke({ methodId: "ingest_plan", inputs: [tickInput()] }));
  for (const p of plans) {
    assert.equal(p.provenance.license, "Test License");
    assert.equal(p.provenance.license_url, "https://example.test/license");
    assert.equal(p.provenance.attribution, "Test Attribution");
    assert.equal(p.provenance.tileset_id, "glo30-test");
    assert.equal(p.provenance.dataset_epoch, EPOCH);
  }
});

test("the batch is capped at batch_tiles and the remainder is reported as backlog", async (t) => {
  const harness = await createHarness(t, createConfigStub({ ...CONFIG, batch_tiles: 2 }));
  const response = await harness.invoke({ methodId: "ingest_plan", inputs: [tickInput()] });
  const plans = planFrames(response);
  assert.equal(plans.length, 2);
  assert.deepEqual(plans.map((p) => p.index), [0, 1]);
  assert.equal(response.backlogRemaining, 4, "6 total tiles minus the 2 planned");
  const job = outputsByPort(response).get("job");
  assert.equal(job.first_tile_index, 0);
  assert.equal(job.tiles_planned, 2);
  assert.equal(job.total_tiles, 6);
  assert.equal(job.dataset_epoch, EPOCH);
  assert.equal(job.lane, "terrain");
});

test("a matching mark RESUMES the walk at next_tile_index", async (t) => {
  const harness = await createHarness(t, createConfigStub({ ...CONFIG, batch_tiles: 2 }));
  const response = await harness.invoke({
    methodId: "ingest_plan",
    inputs: [
      tickInput(),
      jsonFrame("mark", {
        dataset_id: "copernicus-glo30-quantized-mesh",
        tileset_id: "glo30-test",
        dataset_epoch: EPOCH,
        next_tile_index: 2,
      }),
    ],
  });
  const plans = planFrames(response);
  assert.deepEqual(plans.map((p) => p.index), [2, 3], "the walk continues after the stored tiles");
  assert.equal(plans[0].region, "alps");
  assert.equal(plans[0].tile.level, 2);
  assert.equal(response.backlogRemaining, 2);
  assert.equal(outputsByPort(response).get("job").first_tile_index, 2);
});

test("a mark for a DIFFERENT tileset or epoch is ignored, never resumed from", async (t) => {
  // Resuming tileset A from tileset B's index would skip A's shallow levels
  // forever; a new epoch replans from tile 0 by the same rule.
  const harness = await createHarness(t, createConfigStub(CONFIG));
  for (const mark of [
    { dataset_id: "copernicus-glo30-quantized-mesh", tileset_id: "other", dataset_epoch: EPOCH, next_tile_index: 4 },
    { dataset_id: "copernicus-glo30-quantized-mesh", tileset_id: "glo30-test", dataset_epoch: "2020-01-01T00:00:00.000Z", next_tile_index: 4 },
  ]) {
    const plans = planFrames(
      await harness.invoke({ methodId: "ingest_plan", inputs: [tickInput(), jsonFrame("mark", mark)] }),
    );
    assert.equal(plans[0].index, 0, JSON.stringify(mark));
  }
});

test("a drained enumeration is a clean no-op with zero backlog", async (t) => {
  const harness = await createHarness(t, createConfigStub(CONFIG));
  const response = await harness.invoke({
    methodId: "ingest_plan",
    inputs: [
      tickInput(),
      jsonFrame("mark", {
        dataset_id: "copernicus-glo30-quantized-mesh",
        tileset_id: "glo30-test",
        dataset_epoch: EPOCH,
        next_tile_index: 6,
      }),
    ],
  });
  assert.equal(response.statusCode, 0, "a completed pyramid is not an error");
  assert.equal(response.outputs.length, 0, "nothing is planned, so the run ends here");
  assert.equal(response.backlogRemaining, 0);
});

test("the mark's ETag rides out on every plan entry as if_none_match", async (t) => {
  const harness = await createHarness(t, createConfigStub(CONFIG));
  const plans = planFrames(
    await harness.invoke({
      methodId: "ingest_plan",
      inputs: [
        tickInput(),
        jsonFrame("mark", {
          dataset_id: "copernicus-glo30-quantized-mesh",
          tileset_id: "glo30-test",
          dataset_epoch: EPOCH,
          next_tile_index: 1,
          etag: '"9a1b-glo30"',
        }),
      ],
    }),
  );
  for (const p of plans) assert.equal(p.if_none_match, '"9a1b-glo30"');
});

test("ingest_plan fails closed without a tileset or regions", async (t) => {
  const harness = await createHarness(t, createConfigStub({ regions: CONFIG.regions }));
  let response = await harness.invoke({ methodId: "ingest_plan", inputs: [tickInput()] });
  assert.equal(response.errorCode, "missing-tileset-id");

  const harness2 = await createHarness(t, createConfigStub({ tileset_id: "glo30-test" }));
  response = await harness2.invoke({ methodId: "ingest_plan", inputs: [tickInput()] });
  assert.equal(response.errorCode, "missing-regions");
});

test("ingest_plan refuses a tick it cannot date when config pins no epoch", async (t) => {
  const harness = await createHarness(t, createConfigStub(CONFIG));
  const response = await harness.invoke({ methodId: "ingest_plan", inputs: [jsonFrame("tick", {})] });
  assert.equal(response.errorCode, "missing-dataset-epoch");
});

test("a config-pinned dataset_epoch overrides the tick's date", async (t) => {
  const harness = await createHarness(
    t,
    createConfigStub({ ...CONFIG, dataset_epoch: "2026-01-01T00:00:00.000Z" }),
  );
  const response = await harness.invoke({ methodId: "ingest_plan", inputs: [tickInput()] });
  assert.equal(outputsByPort(response).get("job").dataset_epoch, "2026-01-01T00:00:00.000Z");
});

// ---------------------------------------------------------------------------
// ingest_meta
// ---------------------------------------------------------------------------

const JOB = {
  lane: "terrain",
  dataset_id: "copernicus-glo30-quantized-mesh",
  tileset_id: "glo30-test",
  dataset_epoch: EPOCH,
  first_tile_index: 128,
  tiles_planned: 64,
  provider_id: "copernicus",
  source_name: "copernicus-glo30",
};

const recordsFrame = (text = "opaque-terrain-tile-stream") => frame("records", text);

test("ingest_meta authors batch_id tileset@epoch#first-index, append reconcile, lane terrain", async (t) => {
  const harness = await createHarness(t, createConfigStub());
  const outputs = outputsByPort(
    await harness.invoke({
      methodId: "ingest_meta",
      inputs: [
        jsonFrame("job", JOB),
        recordsFrame(),
        jsonFrame("decision", { recordsOut: 64 }),
        jsonFrame("response", {
          status: 200,
          headers: { etag: '"9a1b-glo30"', "last-modified": "Sat, 15 Aug 2026 02:18:01 GMT" },
        }),
      ],
    }),
  );
  const meta = outputs.get("meta");
  assert.equal(meta.schema, "DTT");
  assert.equal(meta.batch_id, `glo30-test@${EPOCH}#128`);
  assert.equal(meta.reconcile, "append");
  assert.equal(meta.dataset_id, "copernicus-glo30-quantized-mesh");
  assert.equal(meta.dataset_epoch, EPOCH);
  assert.equal(meta.lane, "terrain");
  assert.equal(meta.records_in, 64);
  assert.equal(meta.etag, '"9a1b-glo30"');
  assert.equal(meta.last_modified, "Sat, 15 Aug 2026 02:18:01 GMT");
});

test("ingest_meta forwards the record stream untouched", async (t) => {
  const harness = await createHarness(t, createConfigStub());
  const records = recordsFrame("some tile bytes the scheduler must never parse");
  const response = await harness.invoke({ methodId: "ingest_meta", inputs: [jsonFrame("job", JOB), records] });
  assertOk(response);
  const out = response.outputs.find((o) => o.portId === "records");
  assert.deepEqual(Buffer.from(out.payload), Buffer.from(records.payload));
});

test("ingest_meta REFUSES a job missing the edition identity — dataset_epoch above all", async (t) => {
  // The epoch is the edition boundary; storage cannot invent the edition a
  // tile belongs to, so a job without one never reaches the storage lane.
  const harness = await createHarness(t, createConfigStub());
  for (const missing of ["dataset_epoch", "dataset_id", "tileset_id"]) {
    const job = { ...JOB };
    delete job[missing];
    const response = await harness.invoke({
      methodId: "ingest_meta",
      inputs: [jsonFrame("job", job), recordsFrame()],
    });
    assert.equal(response.errorCode, "incomplete-job-attribution", missing);
    assert.equal(response.outputs.length, 0, "nothing reaches storage");
  }
});

// ---------------------------------------------------------------------------
// publish_request — the mark advance and the batch announce
// ---------------------------------------------------------------------------

const META = {
  schema: "DTT",
  provider_id: "copernicus",
  source_name: "copernicus-glo30",
  dataset_id: "copernicus-glo30-quantized-mesh",
  tileset_id: "glo30-test",
  dataset_epoch: EPOCH,
  lane: "terrain",
  batch_id: `glo30-test@${EPOCH}#128`,
  first_tile_index: 128,
  tiles_planned: 64,
  etag: '"9a1b-glo30"',
  last_modified: "Sat, 15 Aug 2026 02:18:01 GMT",
  records_in: 64,
};
const RESULT = { schema: "DTT", inserted: 64, batch_id: META.batch_id };
const PUBLISH_URL = "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish";

test("publish_request advances next_tile_index from the STORAGE RESULT", async (t) => {
  const harness = await createHarness(t, createConfigStub());
  const outputs = outputsByPort(
    await harness.invoke({
      methodId: "publish_request",
      inputs: [jsonFrame("result", RESULT), jsonFrame("meta", META)],
    }),
  );
  const mark = outputs.get("mark");
  assert.equal(mark.dataset_id, "copernicus-glo30-quantized-mesh");
  assert.equal(mark.tileset_id, "glo30-test");
  assert.equal(mark.dataset_epoch, EPOCH);
  assert.equal(mark.next_tile_index, 192, "first_tile_index + tiles_planned");
  assert.equal(mark.lane, "terrain");
  assert.equal(mark.etag, '"9a1b-glo30"', "the mark IS the same-data ledger");
  assert.equal(mark.last_modified, "Sat, 15 Aug 2026 02:18:01 GMT");
});

test("SILENT NOP: ok-with-inserted-0 for a batch that carried tiles advances NOTHING", async (t) => {
  const harness = await createHarness(t, createConfigStub());
  const response = await harness.invoke({
    methodId: "publish_request",
    inputs: [jsonFrame("result", { ...RESULT, inserted: 0 }), jsonFrame("meta", META)],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "ingest-stored-nothing");
  assert.equal(response.outputs.length, 0, "no mark, so the next tick replans this batch");
});

test("a genuinely empty batch (all-ocean tiles skipped upstream) still advances the mark", async (t) => {
  const harness = await createHarness(t, createConfigStub());
  const outputs = outputsByPort(
    await harness.invoke({
      methodId: "publish_request",
      inputs: [
        jsonFrame("result", { ...RESULT, inserted: 0 }),
        jsonFrame("meta", { ...META, records_in: 0 }),
      ],
    }),
  );
  assert.equal(outputs.get("mark").next_tile_index, 192, "the walk must not stall on open ocean");
});

test("the batch announce is fail-closed without a configured URL", async (t) => {
  const harness = await createHarness(t, createConfigStub());
  const outputs = outputsByPort(
    await harness.invoke({
      methodId: "publish_request",
      inputs: [jsonFrame("result", RESULT), jsonFrame("meta", META)],
    }),
  );
  assert.equal(outputs.get("request"), undefined, "absence of config is not permission to publish");
  assert.ok(outputs.get("mark"), "but the mark is NOT gated on publication");
});

test("the batch announce POSTs the DTT batch identity through the publication path", async (t) => {
  const harness = await createHarness(t, createConfigStub({ publish_url: PUBLISH_URL }));
  const outputs = outputsByPort(
    await harness.invoke({
      methodId: "publish_request",
      inputs: [jsonFrame("result", RESULT), jsonFrame("meta", META)],
    }),
  );
  const request = outputs.get("request");
  assert.equal(request.method, "POST");
  assert.equal(request.url, PUBLISH_URL);
  assert.equal(request.headers["content-type"], "application/json");
  const body = JSON.parse(Buffer.from(request.bodyB64, "base64").toString("utf8"));
  assert.deepEqual(Object.keys(body).sort(), ["batchId", "providerId", "schema", "sourceName"]);
  assert.deepEqual(body, {
    schema: "DTT",
    providerId: "copernicus",
    sourceName: "copernicus-glo30",
    batchId: `glo30-test@${EPOCH}#128`,
  });
});

test("publish_request requires BOTH the result and the meta frame", async (t) => {
  // Both ports are declared required, so the SDK harness refuses the
  // invocation before the guest is entered — the contract working, not a gap.
  // The guest's own refusals stand behind it for the composed flow runtime,
  // which does not pre-validate.
  const harness = await createHarness(t, createConfigStub());
  for (const inputs of [[jsonFrame("result", RESULT)], [jsonFrame("meta", META)]]) {
    const response = await harness.invoke({ methodId: "publish_request", inputs });
    assert.notEqual(response.statusCode, 0);
    assert.equal(response.errorCode, "missing-required-input");
    assert.equal(response.outputs.length, 0);
  }
});
