// data-source/cell-tower-ingest on the typed contracts (1.0): every method in the SDK browser harness, every frame a
// FlatBuffer — $HTQ / TimerTick / $FSB / $APR / HttpResponse / $TBS / $IRM / IngestResult / IngestRequest in; $HTQ,
// $FSO, $APR, $DAV, $TBS, $QRP pages, HttpRequest (CONTEXT [$APR, $IRM]), IngestRequest, $IRM, FlowNotice out — and
// plugin.getConfig answered with a real $PIV response. The ingest data is a real OpenCelliD-format CSV export (the
// bulk export's own header and rows, as flows/cellular-network-ingest serves it).

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import zlib from "node:zlib";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import {
  decodeFlowNotice,
  decodeHttpRequest,
  decodeIngestRequest,
  decodeIngestResult,
  encodeHttpResponse,
  encodeIngestRequest,
  encodeIngestResult,
  encodeTimerTick,
  identifierOf,
} from "space-data-module-sdk/runtime-contracts";

import {
  MANIFEST_PATH, STANDARDS_ROOT, TYPE, WASM_PATH, build, createHarness, decodeFso, framesOf, fsbChunks, htq, irm, ok, on, one,
  page, params, read, sds, stream, tbs, text,
} from "./helpers.mjs";

const SOURCE_URL = "https://example.invalid/opencellid-bulk.csv";
const HEADER = "radio,mcc,net,area,cell,unit,lon,lat,range,samples,changeable,created,updated,averageSignal\n";
const ROWS = [
  "LTE,310,260,40495,17811,0,-73.9857000,40.7484000,450,12,1,1700000000,1710000000,-91",
  "LTE,310,260,40495,17811,0,-73.9857200,40.7484200,460,88,1,1700000000,1710000500,-90",
  "NR,234,15,0,987654321,0,-0.1276000,51.5072000,125,8,1,1700000000,1710000000,-85",
  "GSM,262,1,1234,5678,0,13.4050000,52.5200000,900,42,1,1700000000,1710000000,-95",
  "UMTS,208,10,4321,8765,0,2.3522000,48.8566000,600,21,1,1700000000,1710000000,-88",
];
const BODY = Buffer.from(HEADER + ROWS.join("\n") + "\n", "utf8");
const tick = () => ({ portId: "tick", typeRef: TYPE.TICK, payload: encodeTimerTick({ triggerId: "timer-cell-ingest", firedMs: Date.UTC(2026, 9, 13) }) });
const AGG = "/api/v1/cellular/aggregate";

// ---- compliance ------------------------------------------------------------------------------------------------

test("cell-tower-ingest passes SDK compliance with one concrete FlatBuffer type on every port", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const report = await validateArtifactWithStandards({ manifest, wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const ids = {};
  for (const method of manifest.methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      assert.equal(port.acceptedTypeSets.length, 1, port.portId);
      assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1, port.portId);
      const [type] = port.acceptedTypeSets[0].allowedTypes;
      assert.equal(type.acceptsAnyFlatbuffer, undefined);
      assert.equal(type.wireFormat, "flatbuffer");
      ids[`${method.methodId}.${port.portId}`] = type.fileIdentifier;
    }
  }
  assert.deepEqual(ids, {
    "cache_plan.request": "$HTQ", "cache_plan.passthrough": "$HTQ", "cache_plan.tile": "$HTQ", "cache_plan.query": "$FSO", "cache_plan.mark_query": "$FSO", "cache_plan.job": "$APR",
    "cache_freshness.job": "$APR", "cache_freshness.records": "$TBS", "cache_freshness.mark": "$FSB", "cache_freshness.decision": "$APR", "cache_freshness.availability": "$DAV",
    "tile_plan.request": "$HTQ", "tile_plan.meta_mark_query": "$FSO", "tile_plan.meta_job": "$APR", "tile_plan.rows_query": "$FSO", "tile_plan.tile_mark_query": "$FSO",
    "tile_plan.tile_job": "$APR", "tile_plan.refusal": "$APR",
    "tile_meta.job": "$APR", "tile_meta.mark": "$FSB", "tile_meta.decision": "$QRP", "tile_meta.page": "$QRP",
    "tile.job": "$APR", "tile.rows": "$FSB", "tile.mark": "$FSB", "tile.decision": "$QRP", "tile.page": "$QRP",
    "mark_query.tick": "TICK", "mark_query.query": "$FSO",
    "ingest_plan.tick": "TICK", "ingest_plan.mark": "$FSB", "ingest_plan.request": "HREQ",
    "ingest_meta.records": "$TBS", "ingest_meta.response": "HRSP", "ingest_meta.resume": "$IRM", "ingest_meta.meta": "INGQ", "ingest_meta.mark": "$IRM", "ingest_meta.unchanged": "FNTC",
    "publish_request.result": "INGR", "publish_request.meta": "INGQ", "publish_request.mark": "$IRM", "publish_request.mark_record": "$IRM", "publish_request.request": "HREQ",
  });
  // cache_freshness has an input "records" ($FSB) and an output "records" ($TBS); the map above keeps the latter.
  const freshness = manifest.methods.find((m) => m.methodId === "cache_freshness");
  assert.equal(freshness.inputPorts.find((p) => p.portId === "records").acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$FSB");
});

test("cell-tower-ingest imports only the hostcall bridge and WASI", async () => {
  const inspection = await inspectModule(new Uint8Array(fs.readFileSync(WASM_PATH)));
  assert.deepEqual(Array.from(new Set(inspection.imports.map((e) => e.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});

// ---- cache_plan ------------------------------------------------------------------------------------------------

test("cache_plan: exactly one lane per request — tile, passthrough (non-aggregate, REFRESH) or the cache read", async (t) => {
  const harness = await createHarness(t, { cell_cache_max_rows: 50, cell_ingest_provider_id: "mls-archive" });
  // the tile lane: the $HTQ forwarded byte-for-byte, nothing else
  const tileIn = htq("/api/v1/cellular/tiles/3/1/2");
  const tile = ok(await harness.invoke({ methodId: "cache_plan", inputs: [tileIn] }));
  assert.deepEqual(tile.outputs.map((f) => f.portId), ["tile"]);
  assert.deepEqual(Buffer.from(one(tile, "tile")), Buffer.from(tileIn.payload));
  // the catalog and an explicit REFRESH go to route untouched
  for (const input of [htq("/api/v1/cellular/providers"), htq(AGG, { method: "POST", body: JSON.stringify({ REFRESH: true, PROVIDERS: ["mls-archive"] }) })]) {
    const r = ok(await harness.invoke({ methodId: "cache_plan", inputs: [input] }));
    assert.deepEqual(r.outputs.map((f) => f.portId), ["passthrough"]);
    assert.deepEqual(Buffer.from(one(r, "passthrough")), Buffer.from(input.payload));
  }
  // the cache lane: LIMIT capped at cell_cache_max_rows, the default query, the mark read, the $APR job
  const cache = ok(await harness.invoke({ methodId: "cache_plan", inputs: [htq(AGG, { method: "POST", query: "format=json", headers: { "if-none-match": "W/\"x\"" }, body: JSON.stringify({ LIMIT: 700 }) })] }));
  assert.deepEqual(cache.outputs.map((f) => f.portId).sort(), ["job", "mark_query", "query"]);
  assert.deepEqual(decodeFso(one(cache, "query")), { sql: "SELECT _data FROM TBS ORDER BY _rowid DESC LIMIT ?", params: [{ t: "i64", v: 50 }] });
  assert.deepEqual(decodeFso(one(cache, "mark_query")), { sql: "SELECT _data FROM IRM ORDER BY _rowid DESC LIMIT ?", params: [{ t: "i64", v: 32 }] });
  const job = read("APR", one(cache, "job"));
  assert.equal(job.ROUTE, "aggregate-cache");
  assert.equal(job.METHOD, sds.APR.aprMethod.POST);
  assert.equal(job.PATH, AGG);
  assert.equal(job.ACCEPT, sds.APR.aprRepresentation.Json);
  assert.equal(job.IF_NONE_MATCH, "W/\"x\"");
  assert.equal(job.SELECTION, "SELECT _data FROM TBS ORDER BY _rowid DESC LIMIT ?");
  assert.deepEqual(params(job.PARAMETERS), { LIMIT: "50", maxRows: "50", provider: "mls-archive" });
});

// ---- cache_freshness -------------------------------------------------------------------------------------------

const cacheJob = () => {
  const j = new sds.APR.APRT();
  j.ROUTE = "aggregate-cache";
  j.SCHEMA_NAME = "TBS.fbs";
  j.PARAMETERS = [Object.assign(new sds.APR.APRParameterT(), { NAME: "provider", VALUE: "opencellid" })];
  return { portId: "job", typeRef: TYPE.APR, payload: build("APR", j) };
};
const CACHED = stream([tbs(40.7484, -73.9857), tbs(51.5072, -0.1276), tbs(52.52, 13.405)]);

async function freshness(t, markData) {
  const harness = await createHarness(t);
  // the cached rows arrive as several $FSB chunks, out of order: the answer is the stream reassembled verbatim
  const rows = fsbChunks("records", CACHED, 97).reverse();
  const r = ok(await harness.invoke({ methodId: "cache_freshness", inputs: [cacheJob(), ...rows, ...fsbChunks("mark", markData)] }));
  assert.deepEqual(Buffer.from(one(r, "records")), CACHED, "the cached $TBS stream, byte for byte");
  return { dav: read("DAV", one(r, "availability")), decision: read("APR", one(r, "decision")) };
}

test("cache_freshness: an un-ingested store answers instantly AND says it is empty", async (t) => {
  const { dav, decision } = await freshness(t, null);
  assert.deepEqual([dav.KNOWN, dav.AVAILABLE, dav.UNAVAILABLE_REASON], [false, false, sds.DAV.davUnavailableReason.NotPublished]);
  assert.deepEqual([dav.STANDARD, dav.SCHEMA_NAME, dav.PROVIDER_ID, Number(dav.RECORD_COUNT), Number(dav.BYTE_COUNT)], ["TBS", "TBS.fbs", "opencellid", 3, CACHED.length]);
  assert.equal(decision.ROUTE, "aggregate-cache");
  assert.deepEqual(params(decision.RESPONSE_HEADERS), { "x-sdn-cache": "empty", "x-sdn-cache-freshness": "unknown", "x-sdn-cache-stale": "true", "x-sdn-cache-providers": "" });
});

test("cache_freshness: a mark read to its end is fresh; one mid-ingest says so and reports its progress", async (t) => {
  const complete = await freshness(t, stream([irm({ providerId: "opencellid", sourceUrl: SOURCE_URL, nextOffset: 499, totalBytes: 499, nextChunkIndex: 2, recordsCommitted: 4, batchId: "opencellid@260", updatedAt: "2026-10-13T01:02:03.456Z" })]));
  assert.deepEqual([complete.dav.KNOWN, complete.dav.AVAILABLE, complete.dav.FRESH], [true, true, true]);
  assert.equal(Number(complete.dav.PUBLISHED_AT_MS), Date.UTC(2026, 9, 13, 1, 2, 3, 456));
  assert.equal(complete.dav.BATCH_ID, "opencellid@260");
  assert.deepEqual(params(complete.decision.RESPONSE_HEADERS), {
    "x-sdn-cache": "warm", "x-sdn-cache-freshness": "complete", "x-sdn-cache-stale": "false",
    "x-sdn-cache-providers": "providerId=opencellid;nextOffset=499;totalBytes=499;chunkIndex=2;state=complete" });
  const ingesting = await freshness(t, stream([irm({ providerId: "opencellid", sourceUrl: SOURCE_URL, nextOffset: 260, totalBytes: 499, nextChunkIndex: 1 })]));
  assert.deepEqual([ingesting.dav.AVAILABLE, ingesting.dav.FRESH], [true, false]);
  assert.equal(params(ingesting.decision.RESPONSE_HEADERS)["x-sdn-cache-freshness"], "ingesting");
  assert.equal(params(ingesting.decision.RESPONSE_HEADERS)["x-sdn-cache-stale"], "true");
});

test("cache_freshness: mark rows that are not $IRM are 'unavailable', never a guessed timestamp", async (t) => {
  const { dav, decision } = await freshness(t, stream([tbs(1, 1)]));
  assert.deepEqual([dav.KNOWN, dav.AVAILABLE, dav.FRESH, Number(dav.PUBLISHED_AT_MS)], [true, true, false, 0]);
  assert.equal(params(decision.RESPONSE_HEADERS)["x-sdn-cache-freshness"], "unavailable");
});

// ---- tile_plan -------------------------------------------------------------------------------------------------

test("tile_plan: bounds and malformed paths are refused 400 as an $APR, never clamped", async (t) => {
  const harness = await createHarness(t);
  const cases = { "/api/v1/cellular/tiles/19/0/0": "tile-bounds", "/api/v1/cellular/tiles/3/8/0": "tile-bounds", "/api/v1/cellular/tiles/3/0/8": "tile-bounds",
    "/api/v1/cellular/tiles/3.5/0/0": "tile-bounds", "/api/v1/cellular/tiles/+3/0/0": "tile-bounds", "/api/v1/cellular/tiles/3/0": "tile-path", "/api/v1/cellular/tilesx/1/0/0": "tile-path" };
  for (const [path, code] of Object.entries(cases)) {
    const r = ok(await harness.invoke({ methodId: "tile_plan", inputs: [htq(path)] }));
    assert.deepEqual(r.outputs.map((f) => f.portId), ["refusal"], path);
    const refusal = read("APR", one(r, "refusal"));
    assert.deepEqual([refusal.STATUS, refusal.ERROR_CODE, refusal.PATH, refusal.ROUTE], [400, code, path, "tile"], path);
    assert.ok(refusal.ERROR_MESSAGE.length > 0);
  }
});

test("tile_plan: /tiles/meta reads the mark only; an operator cell_tile_sql is taken verbatim and reported unscoped", async (t) => {
  const meta = ok(await (await createHarness(t)).invoke({ methodId: "tile_plan", inputs: [htq("/api/v1/cellular/tiles/meta", { query: "format=json" })] }));
  assert.deepEqual(meta.outputs.map((f) => f.portId).sort(), ["meta_job", "meta_mark_query"]);
  const job = read("APR", one(meta, "meta_job"));
  assert.deepEqual([job.ROUTE, job.ACCEPT, params(job.PARAMETERS).provider], ["tile-meta", sds.APR.aprRepresentation.Json, "opencellid"]);
  const harness = await createHarness(t, { cell_tile_sql: "SELECT _data FROM TBS LIMIT ?", cell_tile_max_rows: 777 });
  const r = ok(await harness.invoke({ methodId: "tile_plan", inputs: [htq("/api/v1/cellular/tiles/4/3/5")] }));
  assert.deepEqual(decodeFso(one(r, "rows_query")), { sql: "SELECT _data FROM TBS LIMIT ?", params: [{ t: "i64", v: 777 }] });
  assert.equal(params(read("APR", one(r, "tile_job")).PARAMETERS).scoped, "false");
  // a deeper tile reads a strictly smaller rectangle than its ancestor
  const parent = decodeFso(one(ok(await harness.invoke({ methodId: "tile_plan", inputs: [htq("/api/v1/cellular/tiles/1/1/0")] })), "tile_mark_query"));
  assert.equal(parent.sql, "SELECT _data FROM IRM ORDER BY _rowid DESC LIMIT ?");
});

// ---- tile / tile_meta ------------------------------------------------------------------------------------------

// Tile 2/2/1 spans lon [0, 90], lat [0, 66.51...]: points strictly inside it, plus some outside.
function insidePoints(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push([1 + ((i * 37) % 6000) / 100, 1 + ((i * 53) % 8800) / 100]);
  return out;
}
const tileJob = (z, x, y, { maxRows = 25000, scoped = true, accept = 0 } = {}) => {
  const j = new sds.APR.APRT();
  j.ROUTE = "tile";
  j.ACCEPT = accept;
  j.IF_NONE_MATCH = "W/\"t\"";
  j.PARAMETERS = Object.entries({ z, x, y, maxRows, scoped, provider: "opencellid" }).map(([NAME, VALUE]) => Object.assign(new sds.APR.APRParameterT(), { NAME, VALUE: String(VALUE) }));
  return { portId: "job", typeRef: TYPE.APR, payload: build("APR", j) };
};
const MARK = stream([irm({ providerId: "opencellid", sourceUrl: SOURCE_URL, nextOffset: 499, totalBytes: 499, nextChunkIndex: 2, recordsCommitted: 1234, updatedAt: "2026-10-13T00:00:00.000Z" })]);

async function runTile(t, points, opts = {}, mark = MARK) {
  const harness = await createHarness(t);
  const rows = stream(points.map(([lat, lon]) => tbs(lat, lon)));
  const r = ok(await harness.invoke({ methodId: "tile", inputs: [tileJob(2, 2, 1, opts), ...fsbChunks("rows", rows, 4096), ...fsbChunks("mark", mark)] }));
  const decision = read("QRP", one(r, "decision"));
  assert.deepEqual([decision.KIND, decision.SCHEMA_NAME, decision.ETAG], [sds.QRP.qrpKind.Request, "TBS", "W/\"t\""]);
  return page(one(r, "page"));
}

test("tile: a points tile carries exactly the sites inside it, exact doubles, with the dataset block", async (t) => {
  const inside = [[40.7484, 10.5], [10.25, 45.125], [66.5, 89.9]];
  const { header, names, rows } = await runTile(t, [...inside, [-10, 10], [40, -73.98], [70, 10]]);
  assert.deepEqual(names, ["LATITUDE", "LONGITUDE"]);
  assert.deepEqual(rows, inside.map(([LATITUDE, LONGITUDE]) => ({ LATITUDE, LONGITUDE })));
  assert.deepEqual([Number(header.TOTAL_COUNT), Number(header.SCANNED), header.PARTIAL, header.TRUNCATED], [3, 6, false, false]);
  assert.deepEqual([Number(header.STORED), Number(header.AS_OF_MS), header.STALE], [1234, Date.UTC(2026, 9, 13), false]);
  assert.equal(header.MESSAGE, "tile 2/2/1 mode points cache warm scoped true malformed 0");
});

test("tile: above the threshold and within budget, a deterministic stride sample that says it is sampled", async (t) => {
  const pts = insidePoints(3000);
  const a = await runTile(t, pts);
  const b = await runTile(t, pts);
  assert.deepEqual(a.rows, b.rows, "byte-identical on every request");
  assert.equal(Number(a.header.TOTAL_COUNT), 3000, "count is the TRUE population, never the shipped rows");
  assert.equal(a.rows.length, 1500, "stride ceil(3000/2048) = 2");
  assert.equal(a.header.TRUNCATED, true);
  assert.deepEqual(a.rows[1], { LATITUDE: pts[2][0], LONGITUDE: pts[2][1] });
});

test("tile: above budget, a 16x16 density grid whose non-empty cells account for every site", async (t) => {
  const { header, names, rows } = await runTile(t, insidePoints(5000));
  assert.deepEqual(names, ["lon", "lat", "count"]);
  assert.equal(Number(header.TOTAL_COUNT), 5000);
  assert.equal(rows.reduce((n, r) => n + r.count, 0), 5000);
  assert.ok(rows.every((r) => r.count > 0), "empty cells are omitted");
  const north = (Math.atan(Math.sinh(Math.PI * (1 - (2 * 1) / 4))) * 180) / Math.PI;
  for (const r of rows) {
    assert.equal(r.lon / (90 / 16) % 1 < 1e-9 || Math.abs(Math.round(r.lon / (90 / 16)) - r.lon / (90 / 16)) < 1e-9, true);
    assert.ok(r.lat >= 0 && r.lat < north);
  }
  assert.match(header.MESSAGE, /mode density/);
});

test("tile: an empty store answers an empty tile and says which of the two it is; a capped or unscoped read is PARTIAL", async (t) => {
  const empty = await runTile(t, [], {}, null);
  assert.deepEqual([Number(empty.header.TOTAL_COUNT), empty.rows.length, Number(empty.header.STORED), Number(empty.header.AS_OF_MS), empty.header.STALE], [0, 0, 0, 0, true]);
  assert.match(empty.header.MESSAGE, /cache empty/);
  const capped = await runTile(t, insidePoints(10), { maxRows: 10 });
  assert.equal(capped.header.PARTIAL, true, "the read hit the row budget");
  const inside = await runTile(t, insidePoints(10), { maxRows: 11 });
  assert.equal(inside.header.PARTIAL, false);
  const unscoped = await runTile(t, insidePoints(10), { scoped: false });
  assert.equal(unscoped.header.PARTIAL, true);
  assert.match(unscoped.header.MESSAGE, /scoped false/);
});

test("tile_meta: one projection row declaring the tile contract, the store honestly", async (t) => {
  const harness = await createHarness(t);
  const job = new sds.APR.APRT();
  job.ROUTE = "tile-meta";
  job.ACCEPT = sds.APR.aprRepresentation.Json;
  const input = { portId: "job", typeRef: TYPE.APR, payload: build("APR", job) };
  const warm = ok(await harness.invoke({ methodId: "tile_meta", inputs: [input, ...fsbChunks("mark", MARK)] }));
  assert.equal(read("QRP", one(warm, "decision")).REPRESENTATION, sds.QRP.qrpRepresentation.Json);
  const { header, rows } = page(one(warm, "page"));
  assert.deepEqual(rows, [{ scheme: "xyz", minZoom: 0, maxZoom: 18, threshold: 2048, budget: 4096, densityN: 16, latClamp: 85.05112878,
    tileUrlTemplate: "/api/v1/cellular/tiles/{z}/{x}/{y}", deconfliction: rows[0].deconfliction, dataset: "cellular-base-stations",
    epoch: "2026-10-13T00:00:00.000Z", records: 1234, stale: false, cacheState: "warm" }]);
  assert.match(rows[0].deconfliction, /pre-deconflicted/);
  assert.deepEqual([Number(header.STORED), header.STALE], [1234, false]);
  const empty = page(one(ok(await harness.invoke({ methodId: "tile_meta", inputs: [input, ...fsbChunks("mark", null)] })), "page"));
  assert.deepEqual([empty.rows[0].cacheState, empty.rows[0].records, empty.rows[0].epoch, empty.rows[0].stale], ["empty", 0, "1970-01-01T00:00:00Z", true]);
});

// ---- mark_query, ingest_plan -----------------------------------------------------------------------------------

test("mark_query: a tick reads the newest $IRM marks (config overrides honoured)", async (t) => {
  const r = ok(await (await createHarness(t, { cell_ingest_mark_scan_rows: 5, cell_ingest_mark_sql: "SELECT _data FROM IRM LIMIT ?" })).invoke({ methodId: "mark_query", inputs: [tick()] }));
  assert.deepEqual(decodeFso(one(r, "query")), { sql: "SELECT _data FROM IRM LIMIT ?", params: [{ t: "i64", v: 5 }] });
});

// The CONTEXT ingest_plan sends: [$APR run contract, $IRM job].
function contextOf(request) {
  const frames = framesOf(request.context);
  assert.deepEqual(frames.map(identifierOf), ["$APR", "$IRM"]);
  return { run: read("APR", frames[0]), job: read("IRM", frames[1]) };
}
async function plan(t, config, markData) {
  const harness = await createHarness(t, { cell_ingest_url: SOURCE_URL, ...config });
  const r = ok(await harness.invoke({ methodId: "ingest_plan", inputs: [tick(), ...fsbChunks("mark", markData)] }));
  return on(r, "request").map(decodeHttpRequest);
}

test("ingest_plan: a fresh run fetches [0, chunk-1], its run contract and $IRM job in CONTEXT", async (t) => {
  const [request] = await plan(t, { cell_ingest_chunk_bytes: 256, cell_ingest_http_timeout_ms: 1234 }, null);
  assert.deepEqual([request.method, request.url, request.headers, request.timeoutMs], ["GET", SOURCE_URL, { range: "bytes=0-255" }, 1234]);
  const { run, job } = contextOf(request);
  assert.equal(run.ROUTE, "ingest");
  assert.equal(run.SCHEMA_NAME, "TBS.fbs");
  assert.deepEqual(params(run.PARAMETERS), { PROVIDERS: "opencellid", METHOD: "HIGHEST_SAMPLE_COUNT", LIMIT: "1000000", FULL_POPULATION: "true", provider: "opencellid", fetches: "1" });
  assert.deepEqual(params(run.RESPONSE_HEADERS), { "x-sdn-providers-consulted": "opencellid" });
  assert.deepEqual([job.PROVIDER_ID, job.JOB_ID, job.SOURCE.SOURCE_URL, Number(job.NEXT_OFFSET), job.NEXT_CHUNK_INDEX, Number(job.CHUNK_BYTE_BUDGET), job.MERGE_POLICY, job.TARGET_STANDARD, job.RECONCILE_MODE],
    ["opencellid", `opencellid@${SOURCE_URL}`, SOURCE_URL, 0, 0, 256, "HIGHEST_SAMPLE_COUNT", "$TBS", "none"]);
  assert.equal(job.DECODE_CONTEXT, null);
  // the 64 MiB ask is clamped to the host's 4 MiB response cap; the numeric merge-method key wins
  const [clamped] = await plan(t, { cell_ingest_chunk_bytes: 64 * 1024 * 1024, cell_ingest_merge_method: 4 }, null);
  assert.equal(clamped.headers.range, `bytes=0-${4 * 1024 * 1024 - 1}`);
  assert.equal(params(contextOf(clamped).run.PARAMETERS).METHOD, "CENTROID");
});

test("ingest_plan: resumes from this provider's durable mark, carrying its header; ignores another provider's", async (t) => {
  const marks = stream([
    irm({ providerId: "some-other-registry", sourceUrl: "https://elsewhere.invalid/other.csv", nextOffset: 4096, totalBytes: 999999, nextChunkIndex: 7 }),
    irm({ providerId: "opencellid", sourceUrl: SOURCE_URL, nextOffset: 260, totalBytes: BODY.length, nextChunkIndex: 1, recordsCommitted: 1, headerLine: HEADER.trimEnd() }),
  ]);
  const [request] = await plan(t, { cell_ingest_chunk_bytes: 260 }, marks);
  assert.equal(request.headers.range, `bytes=260-${BODY.length - 1}`, "clamped to the known total");
  const { job } = contextOf(request);
  assert.deepEqual([Number(job.NEXT_OFFSET), job.NEXT_CHUNK_INDEX, Number(job.RECORDS_COMMITTED), job.DECODE_CONTEXT.HEADER_LINE], [260, 1, 1, HEADER.trimEnd()]);
  const [foreign] = await plan(t, {}, stream([irm({ providerId: "some-other-registry", sourceUrl: SOURCE_URL, nextOffset: 4096, totalBytes: 999999 })]));
  assert.equal(foreign.headers.range.startsWith("bytes=0-"), true, "a foreign provider's mark never moves this provider's offset");
});

test("ingest_plan: an unrecognised decoder stamp is dropped (header kept); the shared stamp is carried; a complete object is not refetched", async (t) => {
  const mark = (decoderStateFormat) => stream([irm({ providerId: "opencellid", sourceUrl: SOURCE_URL, nextOffset: 260, totalBytes: 1 << 20, nextChunkIndex: 1, headerLine: HEADER.trimEnd(),
    decoderState: Buffer.from("tinfl-state-bytes"), decoderStateFormat })]);
  const [foreign] = await plan(t, {}, mark("some-other-producer/v9"));
  const dropped = contextOf(foreign).job.DECODE_CONTEXT;
  assert.equal(dropped.HEADER_LINE, HEADER.trimEnd());
  assert.deepEqual([dropped.DECODER_STATE.length, dropped.WINDOW.length, dropped.DECODER_STATE_FORMAT], [0, 0, null]);
  assert.equal(foreign.headers.range.startsWith("bytes=260-"), true, "the offset is this flow's own and still honoured");
  const [shared] = await plan(t, {}, mark("cell-tower-source/tinfl-v1"));
  const kept = contextOf(shared).job.DECODE_CONTEXT;
  assert.deepEqual([Buffer.from(kept.DECODER_STATE).toString(), kept.DECODER_STATE_FORMAT, kept.WINDOW.length, kept.COMPRESSION], ["tinfl-state-bytes", "cell-tower-source/tinfl-v1", 16, "gzip"]);
  assert.deepEqual(await plan(t, {}, stream([irm({ providerId: "opencellid", sourceUrl: SOURCE_URL, nextOffset: 499, totalBytes: 499 })])), []);
});

test("ingest_plan: no cell_ingest_url fails closed", async (t) => {
  const r = await (await createHarness(t)).invoke({ methodId: "ingest_plan", inputs: [tick()] });
  assert.equal(r.errorCode, "missing-ingest-url");
});

// ---- ingest_meta -----------------------------------------------------------------------------------------------

// A chunk response as hostcap/http-request answers it, with ingest_plan's own CONTEXT echoed.
async function chunkResponse(t, { offset = 0, chunk, marks = null, status = 206, body } = {}) {
  const [request] = await plan(t, { cell_ingest_chunk_bytes: chunk }, marks);
  const end = Math.min(offset + chunk, BODY.length);
  return {
    request,
    frame: { portId: "response", typeRef: TYPE.HRSP, payload: encodeHttpResponse({ url: SOURCE_URL, status, retrievedMs: Date.UTC(2026, 9, 13, 5),
      headers: status === 304 ? { etag: "W/\"v7\"" } : { "content-range": `bytes ${offset}-${end - 1}/${BODY.length}`, etag: "W/\"v7\"", "content-type": "text/csv" },
      body: body ?? (status === 304 ? new Uint8Array(0) : BODY.subarray(offset, end)), context: request.context }) },
  };
}
const RECORDS = stream([tbs(40.7484, -73.9857), tbs(51.5072, -0.1276)]);
const recordsIn = (bytes = RECORDS) => ({ portId: "records", typeRef: TYPE.TBS, payload: bytes });

test("ingest_meta: attribution, records forwarded, and a mark corrected back to the last COMPLETE row with chunk 0's header", async (t) => {
  const { frame } = await chunkResponse(t, { chunk: 200 });
  const harness = await createHarness(t, { cell_ingest_source_name: "ocid-bulk" });
  const r = ok(await harness.invoke({ methodId: "ingest_meta", inputs: [recordsIn(), frame] }));
  assert.deepEqual(Buffer.from(one(r, "records")), RECORDS);
  const meta = decodeIngestRequest(one(r, "meta"));
  assert.equal(meta.schema, "TBS.fbs");
  assert.deepEqual(meta.tags, { ...meta.tags, providerId: "opencellid", sourceName: "ocid-bulk", batchId: "opencellid@0", sourceUrl: SOURCE_URL });
  assert.equal(meta.reconcile, "none");
  assert.deepEqual([meta.provenance.httpStatus, meta.provenance.etag, meta.provenance.contentType, meta.provenance.retrievedMs, meta.provenance.parser, meta.provenance.normalizedCount],
    [206, "W/\"v7\"", "text/csv", Date.UTC(2026, 9, 13, 5), "cell-tower-ingest-wasm-v1", 2]);
  const mark = read("IRM", one(r, "mark"));
  const lastNewline = BODY.subarray(0, 200).lastIndexOf(0x0a);
  assert.equal(Number(mark.NEXT_OFFSET), lastNewline + 1, "the byte after a newline, never mid-row");
  assert.equal(BODY[Number(mark.NEXT_OFFSET) - 1], 0x0a);
  assert.equal(Number(mark.SOURCE.TOTAL_BYTES), BODY.length, "Content-Range's denominator");
  assert.equal(mark.DECODE_CONTEXT.HEADER_LINE, HEADER.trimEnd());
  assert.deepEqual([mark.LAST_CHUNK.CHUNK_INDEX, mark.LAST_CHUNK.BATCH_ID, Number(mark.LAST_CHUNK.RANGE_FIRST_BYTE), Number(mark.LAST_CHUNK.RANGE_LAST_BYTE), mark.LAST_CHUNK.RECORDS_DECODED],
    [0, "opencellid@0", 0, lastNewline, 2]);
  assert.deepEqual([mark.NEXT_CHUNK_INDEX, Number(mark.SEQUENCE), mark.STATE], [1, 1, sds.IRM.irmJobState.IN_PROGRESS]);
});

test("ingest_meta: a resumed chunk keeps the carried header and reaches COMPLETE at the end of the object", async (t) => {
  const marks = stream([irm({ providerId: "opencellid", sourceUrl: SOURCE_URL, nextOffset: 260, totalBytes: BODY.length, nextChunkIndex: 1, recordsCommitted: 1, headerLine: HEADER.trimEnd() })]);
  const { frame } = await chunkResponse(t, { offset: 260, chunk: 4096, marks });
  const r = ok(await (await createHarness(t)).invoke({ methodId: "ingest_meta", inputs: [recordsIn(), frame] }));
  const mark = read("IRM", one(r, "mark"));
  assert.deepEqual([Number(mark.NEXT_OFFSET), mark.STATE, mark.DECODE_CONTEXT.HEADER_LINE, Number(mark.RECORDS_COMMITTED), mark.LAST_CHUNK.BATCH_ID],
    [BODY.length, sds.IRM.irmJobState.COMPLETE, HEADER.trimEnd(), 1, "opencellid@260"]);
});

test("ingest_meta: the decoder's own next byte wins over the newline estimate; gzip bytes are never a header", async (t) => {
  const gz = zlib.gzipSync(BODY);
  const { frame } = await chunkResponse(t, { chunk: 4096, body: gz });
  const resume = irm({ providerId: "opencellid", sourceUrl: SOURCE_URL, nextOffset: 12345, decoderState: Buffer.from("decoder"), decoderStateFormat: "cell-tower-source/tinfl-v1" });
  const r = ok(await (await createHarness(t)).invoke({ methodId: "ingest_meta", inputs: [recordsIn(), frame, { portId: "resume", typeRef: TYPE.IRM, payload: resume }] }));
  const mark = read("IRM", one(r, "mark"));
  assert.equal(Number(mark.NEXT_OFFSET), 12345);
  assert.deepEqual([Buffer.from(mark.DECODE_CONTEXT.DECODER_STATE).toString(), mark.DECODE_CONTEXT.DECODER_STATE_FORMAT, mark.DECODE_CONTEXT.COMPRESSION, mark.DECODE_CONTEXT.HEADER_LINE],
    ["decoder", "cell-tower-source/tinfl-v1", "gzip", null]);
});

test("ingest_meta: HTTP 304 is one Unchanged notice and nothing else", async (t) => {
  const { frame } = await chunkResponse(t, { chunk: 4096, status: 304 });
  const r = ok(await (await createHarness(t)).invoke({ methodId: "ingest_meta", inputs: [recordsIn(new Uint8Array(0)), frame] }));
  assert.deepEqual(r.outputs.map((f) => f.portId), ["unchanged"]);
  const notice = decodeFlowNotice(one(r, "unchanged"));
  assert.deepEqual({ ...notice, atMs: 0 }, { kind: "unchanged", schema: "TBS.fbs", providerId: "opencellid", sourceName: "cell-tower-bulk", batchId: "", count: 0, reason: "not-modified", items: [SOURCE_URL], atMs: 0 });
});

test("ingest_meta: a response with no $IRM job in CONTEXT is refused, never guessed", async (t) => {
  const r = await (await createHarness(t)).invoke({ methodId: "ingest_meta", inputs: [recordsIn(),
    { portId: "response", typeRef: TYPE.HRSP, payload: encodeHttpResponse({ url: SOURCE_URL, status: 206, body: BODY }) }] });
  assert.equal(r.errorCode, "missing-context");
});

// ---- publish_request -------------------------------------------------------------------------------------------

async function candidate(t) {
  const marks = stream([irm({ providerId: "opencellid", sourceUrl: SOURCE_URL, nextOffset: 260, totalBytes: BODY.length, nextChunkIndex: 1, recordsCommitted: 1, headerLine: HEADER.trimEnd() })]);
  const { frame } = await chunkResponse(t, { offset: 260, chunk: 4096, marks });
  const r = ok(await (await createHarness(t)).invoke({ methodId: "ingest_meta", inputs: [recordsIn(stream([tbs(1, 1), tbs(2, 2), tbs(3, 3)])), frame] }));
  return { meta: one(r, "meta"), mark: one(r, "mark") };
}
const publishInputs = (c, result) => [
  { portId: "result", typeRef: TYPE.INGR, payload: encodeIngestResult(result) },
  { portId: "meta", typeRef: TYPE.INGQ, payload: c.meta },
  { portId: "mark", typeRef: TYPE.IRM, payload: c.mark },
];

test("publish_request: the mark advances from the storage result; publication is fail-closed without a URL", async (t) => {
  const c = await candidate(t);
  const r = ok(await (await createHarness(t)).invoke({ methodId: "publish_request", inputs: publishInputs(c, { schema: "TBS.fbs", batchId: "opencellid@260", inserted: 3 }) }));
  assert.deepEqual(r.outputs.map((f) => f.portId), ["mark_record"]);
  const mark = read("IRM", one(r, "mark_record"));
  assert.deepEqual([Number(mark.RECORDS_COMMITTED), mark.LAST_CHUNK.RECORDS_STORED, Number(mark.NEXT_OFFSET), mark.STATE, mark.NEXT_CHUNK_INDEX],
    [4, 3, BODY.length, sds.IRM.irmJobState.COMPLETE, 2]);
  assert.ok(mark.COMPLETED_AT && mark.LAST_CHUNK.COMMITTED_AT && mark.UPDATED_AT);
});

test("publish_request: with a URL, one POST whose body is the IngestResult naming the batch", async (t) => {
  const c = await candidate(t);
  const url = "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish";
  const r = ok(await (await createHarness(t, { cell_ingest_publish_url: url })).invoke({ methodId: "publish_request", inputs: publishInputs(c, { schema: "TBS.fbs", batchId: "opencellid@260", inserted: 3 }) }));
  const request = decodeHttpRequest(one(r, "request"));
  assert.deepEqual([request.method, request.url, request.headers["content-type"]], ["POST", url, "application/octet-stream"]);
  const body = decodeIngestResult(request.body);
  assert.deepEqual([body.schema, body.providerId, body.sourceName, body.batchId, body.inserted], ["TBS.fbs", "opencellid", "cell-tower-bulk", "opencellid@260", 3]);
});

test("publish_request: the SILENT NOP (inserted 0 for records) and a REFUSED batch advance nothing", async (t) => {
  const c = await candidate(t);
  const harness = await createHarness(t);
  const nop = await harness.invoke({ methodId: "publish_request", inputs: publishInputs(c, { schema: "TBS.fbs", inserted: 0 }) });
  assert.equal(nop.errorCode, "ingest-stored-nothing");
  assert.equal(nop.outputs.length, 0);
  const refused = await harness.invoke({ methodId: "publish_request", inputs: publishInputs(c, { schema: "TBS.fbs", refused: "disk below the 5 GiB floor" }) });
  assert.equal(refused.errorCode, "ingest-refused");
  assert.equal(refused.outputs.length, 0);
  // an empty tail (no records, nothing inserted) is not a nop
  const empty = encodeIngestRequest({ schema: "TBS.fbs", tags: { providerId: "opencellid", sourceName: "cell-tower-bulk", batchId: "opencellid@499" }, reconcile: "none", provenance: { normalizedCount: 0 } });
  ok(await harness.invoke({ methodId: "publish_request", inputs: [publishInputs(c, { inserted: 0 })[0], { portId: "meta", typeRef: TYPE.INGQ, payload: empty }, publishInputs(c, {})[2]] }));
});

test("single-stream ports refuse a surplus frame by name", async (t) => {
  const r = await (await createHarness(t)).invoke({ methodId: "mark_query", inputs: [tick(), tick()] });
  assert.equal(r.errorCode, "batched-input-frames");
  assert.equal(text(r.errorMessage).includes("\"tick\""), true);
});
