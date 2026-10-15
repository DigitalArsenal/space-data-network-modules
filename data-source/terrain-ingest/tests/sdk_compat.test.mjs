// data-source/terrain-ingest SDK-compat tests (typed contracts 1.0): the scheduler nodes turn a
// TimerTick into an $FSO query, a bounded REGION-PRIORITY-ordered batch of
// terrain-tile plan headers ($DTT), an IngestRequest and an advanced $IRM resume
// mark — with runner defaults and node-CONFIG overrides through the builtin
// plugin.getConfig hostcall.
//
// Every assertion is a computable outcome of the SCHEDULE: which granule URLs
// a tile needs (including the N00/S01/E000/W001 naming edge cases), in what
// order tiles are planned, where a mark resumes the walk, how big a batch may
// be, and under exactly which conditions the mark advances.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { decodeIngestResult } from "space-data-module-sdk/runtime-contracts";

import { publishedStandardsRoot } from "../../terrain-source/sds-headers.mjs";
import {
  MANIFEST,
  WASM_PATH,
  TYPE,
  createHarness,
  tickFrame,
  irmRecord,
  markFrames,
  jobIdOf,
  decodePlan,
  decodeIrm,
  decodeFsoQuery,
  decodeHttpRequest,
  decodeIngestRequest,
  encodeIngestRequest,
  encodeIngestResult,
  irmFrame,
  outputs,
  reportFrame,
  responseFrame,
  recordsFrame,
  IRM_LIB,
  jobRecord,
} from "./typed.mjs";

// THE VALIDATOR READS THE PACKAGE THE BUILD READ: the artifact is built from the standards this package resolves
// (SPACE_DATA_STANDARDS_ROOT when set), so that is what compliance is measured against.
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? publishedStandardsRoot(import.meta.url);
const S3 = "https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/";
const DATASET = "copernicus-glo30-quantized-mesh";

const plansOf = (response) => (outputs(response).get("plan") ?? []).map((bytes) => decodePlan(bytes)[0]);
const jobOf = (response) => decodeIrm(outputs(response).get("job")[0]);

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
const JOB_ID = jobIdOf(DATASET, "glo30-test", EPOCH);
const markAt = (next, extra = {}) => markFrames([irmRecord({ jobId: JOB_ID, next, ...extra })]);

// ---------------------------------------------------------------------------
// artifact
// ---------------------------------------------------------------------------

test("terrain-ingest artifact passes SDK compliance with typed ports only", async () => {
  const report = await validateArtifactWithStandards({ manifest: MANIFEST, wasmPath: WASM_PATH, standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  for (const method of MANIFEST.methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      assert.equal(port.acceptedTypeSets.length, 1, `${method.methodId}.${port.portId}`);
      assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1);
      const [type] = port.acceptedTypeSets[0].allowedTypes;
      assert.equal(type.acceptsAnyFlatbuffer, undefined);
      assert.equal(type.wireFormat, "flatbuffer");
      assert.ok(type.fileIdentifier && type.schemaName && type.rootTypeName, `${method.methodId}.${port.portId}`);
    }
  }
});

test("terrain-ingest imports only WASI + the sync hostcall bridge", async () => {
  const inspection = await inspectModule(fs.readFileSync(WASM_PATH));
  const modules = Array.from(new Set(inspection.imports.map((e) => e.module))).sort();
  assert.deepEqual(modules, ["space_data_module_host", "wasi_snapshot_preview1"]);
});

test("the manifest declares capabilities [] and both runtime targets", () => {
  assert.deepEqual(MANIFEST.capabilities, []);
  assert.deepEqual(MANIFEST.runtimeTargets, ["browser", "wasmedge"]);
  assert.equal(MANIFEST.pluginId, "com.digitalarsenal.data-source.terrain-ingest");
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

test("mark_query reads $IRM through the CODE-NAMED view, as one $FSO QUERY_RECORDS", async (t) => {
  // The old default named a table no node has (`terrain_ingest_mark`), so the mark read back NOTHING on any real
  // node and every run restarted at cell 0 - silently, because an absent mark is a valid first run.
  const harness = await createHarness(t, {});
  const query = decodeFsoQuery(outputs(await harness.invoke({ methodId: "mark_query", inputs: [tickFrame()] })).get("query")[0]);
  assert.equal(query.sql, "SELECT _data FROM IRM ORDER BY _rowid DESC LIMIT ?");
  assert.deepEqual(query.params, [{ t: "i64", v: 32 }], "the newest few rows, so one relation can hold several lanes");
  assert.deepEqual(harness.hostCalls, ["plugin.getConfig"]);
});

test("mark_query's SQL and scan depth are configurable, and neither defaults to nothing", async (t) => {
  const harness = await createHarness(t, { mark_sql: "SELECT _data FROM IRM WHERE 1 ORDER BY _rowid DESC LIMIT ?", mark_scan_rows: 8 });
  const query = decodeFsoQuery(outputs(await harness.invoke({ methodId: "mark_query", inputs: [tickFrame()] })).get("query")[0]);
  assert.equal(query.sql, "SELECT _data FROM IRM WHERE 1 ORDER BY _rowid DESC LIMIT ?");
  assert.deepEqual(query.params, [{ t: "i64", v: 8 }]);
});

// ---------------------------------------------------------------------------
// granule URL construction — the naming edge cases, exercised through the plan
// ---------------------------------------------------------------------------

test("granule URLs handle the N00 / S01 / E000 / W001 edge cells exactly", async (t) => {
  // A 2x2 degree region straddling the equator and prime meridian, planned at level 0 only (S counts down from the
  // south edge, so [-1,0) is S01 and [0,1) is N00; W likewise, so [-1,0) is W001 and [0,1) is E000).
  const harness = await createHarness(t, {
    tileset_id: "edge-test",
    global_max_level: 0,
    regions: [{ name: "origin", west: -1, south: -1, east: 1, north: 1, max_level: 0, priority: 1 }],
  });
  const plans = plansOf(await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame()] }));
  assert.equal(plans.length, 2, "the region straddles both level-0 root tiles");

  const stem = (latTag, lonTag) => `Copernicus_DSM_COG_10_${latTag}_00_${lonTag}_00`;
  const dem = (latTag, lonTag) => `${S3}${stem(latTag, lonTag)}_DEM/${stem(latTag, lonTag)}_DEM.tif`;
  const wbm = (latTag, lonTag) => `${S3}${stem(latTag, lonTag)}_DEM/AUXFILES/${stem(latTag, lonTag)}_WBM.tif`;

  const west = plans.find((p) => p.x === 0);
  const east = plans.find((p) => p.x === 1);
  // The cell list covers the POSTS, not the square: a granule holds latitudes (lat, lat+1] and longitudes [lon, lon+1).
  assert.deepEqual(west.demUrls, [
    dem("S02", "W001"), dem("S02", "E000"),
    dem("S01", "W001"), dem("S01", "E000"),
    dem("N00", "W001"), dem("N00", "E000"),
  ]);
  assert.deepEqual(west.wbmUrls, [
    wbm("S02", "W001"), wbm("S02", "E000"),
    wbm("S01", "W001"), wbm("S01", "E000"),
    wbm("N00", "W001"), wbm("N00", "E000"),
  ]);
  assert.deepEqual(east.demUrls, [
    dem("S02", "E000"), dem("S02", "E001"),
    dem("S01", "E000"), dem("S01", "E001"),
    dem("N00", "E000"), dem("N00", "E001"),
  ]);
  assert.deepEqual(east.wbmUrls, [
    wbm("S02", "E000"), wbm("S02", "E001"),
    wbm("S01", "E000"), wbm("S01", "E001"),
    wbm("N00", "E000"), wbm("N00", "E001"),
  ]);
});

test("granule URLs carry zero-padded lat/lon for an ordinary land tile", async (t) => {
  const harness = await createHarness(t, CONFIG);
  const plans = plansOf(await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame()] }));
  // Plan index 0 is the alps' level-0 tile: lon 5..8 and lat 43..46, so 4x4 cells.
  const first = plans[0];
  assert.equal(first.demUrls.length, 16);
  assert.equal(first.demUrls[0], `${S3}Copernicus_DSM_COG_10_N43_00_E005_00_DEM/Copernicus_DSM_COG_10_N43_00_E005_00_DEM.tif`);
  assert.ok(first.demUrls.some((u) => u.endsWith("Copernicus_DSM_COG_10_N44_00_E005_00_DEM.tif")));
  assert.equal(first.wbmUrls[0], `${S3}Copernicus_DSM_COG_10_N43_00_E005_00_DEM/AUXFILES/Copernicus_DSM_COG_10_N43_00_E005_00_WBM.tif`);
});

test("a western-hemisphere region names W granules with three digits", async (t) => {
  const harness = await createHarness(t, CONFIG);
  const plans = plansOf(await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame()] }));
  const iceland = plans[4];
  assert.match(iceland.remarks, /^region iceland, tile index 4$/);
  assert.match(iceland.demUrls[0], /Copernicus_DSM_COG_10_N62_00_W024_00_DEM\.tif$/);
  assert.ok(iceland.demUrls.some((u) => /Copernicus_DSM_COG_10_N63_00_W024_00_DEM\.tif$/.test(u)));
});

// ---------------------------------------------------------------------------
// ingest_plan — ordering, batching, resume, backlog
// ---------------------------------------------------------------------------

test("the walk is REGION-PRIORITY ordered: higher priority first, shallow before deep", async (t) => {
  const harness = await createHarness(t, CONFIG);
  const plans = plansOf(await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame()] }));
  assert.equal(plans.length, 6, "the whole fixture pyramid fits one default batch");
  assert.deepEqual(
    plans.map((p) => [p.remarks.split(",")[0], p.level]),
    [["region alps", 0], ["region alps", 1], ["region alps", 2], ["region alps", 2], ["region iceland", 0], ["region iceland", 1]],
  );
  assert.deepEqual(plans.map((p) => Number(p.remarks.split("tile index ")[1])), [0, 1, 2, 3, 4, 5]);
  // TMS row origin is SOUTH: the lower row index is the southern tile.
  assert.equal(plans[2].y, 2);
  assert.equal(plans[3].y, 3);
  assert.ok(plans[2].south < plans[3].south);
  for (const p of plans) {
    assert.equal(p.payloadBytes, 0, "a plan header carries no mesh");
    assert.equal(p.tilingScheme, 1, "GEOGRAPHIC_WGS84");
  }
});

test("every granule of a tile is planned - a 404 is open ocean, never an error", async (t) => {
  // The guest cannot cheaply know land from ocean, so ALL intersecting granules are listed (the header's
  // SOURCE_QUERY / water SOURCE_QUERY) and the encoder reads a 404 as no-data.
  const harness = await createHarness(t, CONFIG);
  for (const p of plansOf(await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame()] }))) {
    assert.ok(p.demUrls.length > 0 && p.demUrls.length === p.wbmUrls.length);
  }
});

test("provenance passes the configured licence and attribution through VERBATIM", async (t) => {
  const harness = await createHarness(t, CONFIG);
  for (const p of plansOf(await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame()] }))) {
    assert.equal(p.provenance.LICENSE, "Test License");
    assert.equal(p.provenance.LICENSE_URL, "https://example.test/license");
    assert.equal(p.provenance.ATTRIBUTION, "Test Attribution");
    assert.equal(p.tilesetId, "glo30-test");
    assert.equal(p.provenance.DATASET_EPOCH, EPOCH);
    assert.equal(p.provenance.RETRIEVED_AT, "2026-08-15T00:00:00.000Z", "the tick's clock, never invented");
  }
});

test("the batch is capped at batch_tiles and the remainder is reported as backlog", async (t) => {
  const harness = await createHarness(t, { ...CONFIG, batch_tiles: 2 });
  const response = await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame()] });
  const plans = plansOf(response);
  assert.equal(plans.length, 2);
  assert.equal(response.backlogRemaining, 4, "6 total tiles minus the 2 planned");
  const job = jobOf(response);
  assert.equal(job.jobId, JOB_ID);
  assert.equal(job.firstIndex, 0);
  assert.equal(job.nextIndex, 2, "the stride is the batch's tile count");
  assert.equal(job.epoch, EPOCH);
  assert.deepEqual(job.tags, ["lane:terrain", "walk:tile"]);
  assert.match(job.notes, /of 6$/);
});

test("a matching mark RESUMES the walk at its NEXT_CHUNK_INDEX", async (t) => {
  const harness = await createHarness(t, { ...CONFIG, batch_tiles: 2 });
  const response = await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame(), ...markAt(2)] });
  const plans = plansOf(response);
  assert.deepEqual(plans.map((p) => p.remarks), ["region alps, tile index 2", "region alps, tile index 3"]);
  assert.equal(plans[0].level, 2);
  assert.equal(response.backlogRemaining, 2);
  assert.equal(jobOf(response).firstIndex, 2);
});

test("a mark for a DIFFERENT tileset or epoch is ignored, never resumed from", async (t) => {
  const harness = await createHarness(t, CONFIG);
  for (const jobId of [jobIdOf(DATASET, "other", EPOCH), jobIdOf(DATASET, "glo30-test", "2020-01-01T00:00:00.000Z")]) {
    const plans = plansOf(await harness.invoke({
      methodId: "ingest_plan",
      inputs: [tickFrame(), ...markFrames([irmRecord({ jobId, next: 4 })])],
    }));
    assert.equal(plans[0].remarks, "region alps, tile index 0", jobId);
  }
});

test("a drained enumeration is a clean no-op with zero backlog", async (t) => {
  const harness = await createHarness(t, CONFIG);
  const response = await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame(), ...markAt(6)] });
  assert.equal(response.statusCode, 0, "a completed pyramid is not an error");
  assert.equal(response.outputs.length, 0, "nothing is planned, so the run ends here");
  assert.equal(response.backlogRemaining, 0);
});

test("the mark's ETag rides out on every plan header as its ETAG (the granule fetches' If-None-Match)", async (t) => {
  const harness = await createHarness(t, CONFIG);
  const plans = plansOf(await harness.invoke({
    methodId: "ingest_plan",
    inputs: [tickFrame(), ...markAt(1, { etag: '"9a1b-glo30"' })],
  }));
  assert.ok(plans.length > 0);
  for (const p of plans) assert.equal(p.etag, '"9a1b-glo30"');
});

test("ingest_plan fails closed without a tileset or regions", async (t) => {
  let response = await (await createHarness(t, { regions: CONFIG.regions })).invoke({ methodId: "ingest_plan", inputs: [tickFrame()] });
  assert.equal(response.errorCode, "missing-tileset-id");
  response = await (await createHarness(t, { tileset_id: "glo30-test" })).invoke({ methodId: "ingest_plan", inputs: [tickFrame()] });
  assert.equal(response.errorCode, "missing-regions");
});

test("ingest_plan refuses a tick it cannot date when config pins no epoch", async (t) => {
  const harness = await createHarness(t, CONFIG);
  const response = await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame(null)] });
  assert.equal(response.errorCode, "missing-dataset-epoch");
});

test("a config-pinned dataset_epoch overrides the tick's date", async (t) => {
  const harness = await createHarness(t, { ...CONFIG, dataset_epoch: "2026-01-01T00:00:00.000Z" });
  const response = await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame()] });
  assert.equal(jobOf(response).epoch, "2026-01-01T00:00:00.000Z");
});

// ---------------------------------------------------------------------------
// ingest_meta
// ---------------------------------------------------------------------------

const JOB = jobRecord({ jobId: JOB_ID, first: 128, next: 192, walk: "tile", epoch: EPOCH });
const STREAM = Buffer.from("opaque-terrain-tile-stream");

test("ingest_meta authors batch_id tileset@epoch#first-index, append (None) reconcile, the ledger in provenance", async (t) => {
  const harness = await createHarness(t, {});
  const out = outputs(await harness.invoke({
    methodId: "ingest_meta",
    inputs: [
      irmFrame("job", JOB),
      recordsFrame(STREAM),
      reportFrame(64),
      responseFrame({ etag: '"9a1b-glo30"', "last-modified": "Sat, 15 Aug 2026 02:18:01 GMT" }, 200, { retrievedMs: 1786760000000 }),
    ],
  }));
  const meta = decodeIngestRequest(out.get("meta")[0]);
  assert.equal(meta.schema, "DTT");
  assert.equal(meta.tags.batchId, `glo30-test@${EPOCH}#128`);
  assert.equal(meta.tags.providerId, "copernicus");
  assert.equal(meta.tags.sourceName, "copernicus-glo30");
  assert.equal(meta.reconcile, "none", "a batch is a WINDOW of the pyramid: append, never reconcile");
  assert.equal(meta.provenance.etag, '"9a1b-glo30"');
  assert.equal(meta.provenance.lastModified, "Sat, 15 Aug 2026 02:18:01 GMT");
  assert.equal(meta.provenance.httpStatus, 200);
  assert.equal(meta.provenance.normalizedCount, 64, "the report's record count rides with the batch");
  assert.deepEqual(meta.provenance.schemaCounts, { "DTT.fbs": 64 });
  assert.equal(meta.provenance.parser, "terrain-source");
});

test("ingest_meta forwards the record stream untouched", async (t) => {
  const harness = await createHarness(t, {});
  const bytes = Buffer.from("some tile bytes the scheduler must never parse");
  const out = outputs(await harness.invoke({ methodId: "ingest_meta", inputs: [irmFrame("job", JOB), recordsFrame(bytes)] }));
  assert.deepEqual(Buffer.from(out.get("records")[0]), bytes);
  // No report: the count is unknown, never faked.
  const meta = decodeIngestRequest(out.get("meta")[0]);
  assert.deepEqual(meta.provenance.schemaCounts, {});
});

test("ingest_meta REFUSES a job whose JOB_ID does not name the edition", async (t) => {
  // The epoch is the edition boundary; storage cannot invent the edition a tile belongs to.
  const harness = await createHarness(t, {});
  for (const jobId of [`${DATASET}@glo30-test`, "glo30-test", `@glo30-test@${EPOCH}`]) {
    const response = await harness.invoke({
      methodId: "ingest_meta",
      inputs: [irmFrame("job", jobRecord({ jobId, first: 128, next: 192 })), recordsFrame(STREAM)],
    });
    assert.equal(response.errorCode, "incomplete-job-attribution", jobId);
    assert.equal(response.outputs.length, 0, "nothing reaches storage");
  }
});

// ---------------------------------------------------------------------------
// publish_request — the mark advance and the batch announce
// ---------------------------------------------------------------------------

const BATCH = `glo30-test@${EPOCH}#128`;
const META = encodeIngestRequest({
  schema: "DTT",
  tags: { providerId: "copernicus", sourceName: "copernicus-glo30", batchId: BATCH, sourceUrl: S3 },
  reconcile: "none",
  provenance: { etag: '"9a1b-glo30"', lastModified: "Sat, 15 Aug 2026 02:18:01 GMT", normalizedCount: 64, schemaCounts: { "DTT.fbs": 64 } },
});
const metaWithCount = (count) => encodeIngestRequest({
  schema: "DTT",
  tags: { providerId: "copernicus", sourceName: "copernicus-glo30", batchId: BATCH },
  provenance: { normalizedCount: count, schemaCounts: { "DTT.fbs": count } },
});
const result = (r = {}) => ({ portId: "result", typeRef: TYPE.INGR, payload: encodeIngestResult({ schema: "DTT", batchId: BATCH, inserted: 64, ...r }) });
const meta = (bytes = META) => ({ portId: "meta", typeRef: TYPE.INGQ, payload: bytes });
const PUBLISH_URL = "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish";

test("publish_request advances the mark from the STORAGE RESULT", async (t) => {
  const harness = await createHarness(t, {});
  const out = outputs(await harness.invoke({ methodId: "publish_request", inputs: [result(), meta(), irmFrame("job", JOB)] }));
  const mark = decodeIrm(out.get("mark")[0]);
  assert.equal(mark.jobId, JOB_ID);
  assert.equal(mark.nextIndex, 192, "first index + the batch's stride");
  assert.equal(mark.recordsCommitted, 64, "only what storage confirmed");
  assert.equal(mark.record.LAST_CHUNK.BATCH_ID, BATCH);
  assert.equal(mark.record.LAST_CHUNK.RECORDS_STORED, 64);
  assert.equal(mark.etag, '"9a1b-glo30"', "the mark IS the same-data ledger");
  assert.equal(mark.lastModified, "Sat, 15 Aug 2026 02:18:01 GMT");
  assert.equal(mark.record.RANGE_MODE, IRM_LIB.irmRangeMode.PART_INDEX);
  assert.equal(mark.record.DECODE_CONTEXT, null, "no JSON state rides in the mark");
});

test("SILENT NOP: inserted 0 for a batch that carried tiles advances NOTHING; a refused batch neither", async (t) => {
  const harness = await createHarness(t, {});
  const nop = await harness.invoke({ methodId: "publish_request", inputs: [result({ inserted: 0 }), meta(), irmFrame("job", JOB)] });
  assert.equal(nop.errorCode, "ingest-stored-nothing");
  assert.equal(nop.outputs.length, 0, "no mark, so the next tick replans this batch");
  const refused = await harness.invoke({
    methodId: "publish_request",
    inputs: [result({ inserted: 0, refused: "refused: disk guardrail" }), meta(), irmFrame("job", JOB)],
  });
  assert.equal(refused.errorCode, "ingest-refused");
  assert.equal(refused.outputs.length, 0);
});

test("a genuinely empty batch (all-ocean tiles skipped upstream) still advances the mark", async (t) => {
  const harness = await createHarness(t, {});
  const out = outputs(await harness.invoke({
    methodId: "publish_request",
    inputs: [result({ inserted: 0 }), meta(metaWithCount(0)), irmFrame("job", JOB)],
  }));
  assert.equal(decodeIrm(out.get("mark")[0]).nextIndex, 192, "the walk must not stall on open ocean");
});

test("the batch announce is fail-closed without a configured URL", async (t) => {
  const harness = await createHarness(t, {});
  const out = outputs(await harness.invoke({ methodId: "publish_request", inputs: [result(), meta(), irmFrame("job", JOB)] }));
  assert.equal(out.get("request"), undefined, "absence of config is not permission to publish");
  assert.ok(out.get("mark"), "but the mark is NOT gated on publication");
});

test("the batch announce POSTs an IngestResult naming the DTT batch", async (t) => {
  const harness = await createHarness(t, { publish_url: PUBLISH_URL });
  const out = outputs(await harness.invoke({ methodId: "publish_request", inputs: [result(), meta(), irmFrame("job", JOB)] }));
  const request = decodeHttpRequest(out.get("request")[0]);
  assert.equal(request.method, "POST");
  assert.equal(request.url, PUBLISH_URL);
  assert.deepEqual(request.headers, { "content-type": "application/octet-stream" });
  const body = decodeIngestResult(request.body);
  assert.deepEqual([body.schema, body.providerId, body.sourceName, body.batchId, body.inserted],
    ["DTT", "copernicus", "copernicus-glo30", BATCH, 64]);
});

test("publish_request requires the result, the meta and the job", async (t) => {
  // Every port is required, so the SDK harness refuses the invocation before the guest is entered.
  const harness = await createHarness(t, {});
  for (const inputs of [[result(), meta()], [meta(), irmFrame("job", JOB)], [result(), irmFrame("job", JOB)]]) {
    const response = await harness.invoke({ methodId: "publish_request", inputs });
    assert.equal(response.errorCode, "missing-required-input");
    assert.equal(response.outputs.length, 0);
  }
});
