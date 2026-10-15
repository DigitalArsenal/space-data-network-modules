/*
 * Flow-level tests for the CELLULAR DENSITY-TILE SERVING LANE on the typed contracts (1.0)
 * (graph tasks sdn-cellular-density-tiles / upstream-modules-2; owner 2026-08-24: "all worldwide cell towers must
 * reach the cellular sandcastle").
 *
 * COMPUTABLE OUTCOMES ONLY (owner law: no UI-wiring or source-pattern tests). Every assertion is a status code, a
 * count, a coordinate, a byte comparison, or the presence/absence of a host call.
 *
 * THE TILE CONTRACT. The landed OrbPro client's grammar (cellularTileStream.js at f9e39b5437) - points mode only at or
 * below budget, density above it, a non-empty cells array, count the TRUE population, the sample deterministic, cells
 * partitioning their tile - is now carried by a $QRP projection page (foundation/http-respond respond_query) instead of
 * a JSON envelope: points as LATITUDE/LONGITUDE rows, density as lon/lat/count rows, TOTAL_COUNT the population,
 * TRUNCATED the sample, PARTIAL a capped or unscoped read, STORED/AS_OF_MS/STALE the store's honesty block. The
 * client's index math (lonToTileX / latToTileY / tileBounds / densityCellRectangle) is kept verbatim below so seam
 * ownership is still judged the renderer's way.
 *
 * The SAME artifact the Go host would serve runs in the JS flow runtime host at runtimeTarget "wasmedge"; every
 * hostcall is an SDS $PIV invocation answered as the Go node answers it (typed-host.mjs).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  configHandler,
  createHostStub,
  frames,
  htqTrigger,
  httpAnswerOf,
  irmRecord,
  isMarkQuery,
  readPage,
  runFlow,
  sds,
  build,
  stream,
  streamAnswer,
  tbsSite,
} from "./typed-host.mjs";

const FLOW_WASM = new URL("../dist/runtime.wasm", import.meta.url);

// ═══════════════ the client's tile-index math, VERBATIM (cellularTileStream.js @ f9e39b5437) ═════
const TILE_INDEX_EPSILON = 1e-9;
function lonToTileX(lonDeg, z) {
  const n = 2 ** z;
  return Math.min(Math.max(Math.floor(((lonDeg + 180) / 360) * n + TILE_INDEX_EPSILON), 0), n - 1);
}
function latToTileY(latDeg, z) {
  const n = 2 ** z;
  const phi = (latDeg * Math.PI) / 180;
  const raw = ((1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2) * n + TILE_INDEX_EPSILON;
  return Math.min(Math.max(Math.floor(raw), 0), n - 1);
}
function tileBounds(z, x, y) {
  const n = 2 ** z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const south = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
  return { west, south, north, east };
}
function densityCellRectangle(tile, n, cell) {
  const bounds = tileBounds(tile.z, tile.x, tile.y);
  const spanLon = (bounds.east - bounds.west) / n;
  const spanLat = (bounds.north - bounds.south) / n;
  return { west: cell.lon, south: cell.lat, east: cell.lon + spanLon, north: cell.lat + spanLat };
}
// ═══════════════════════════ end client math ════════════════════════════

// The tile contract the client enforces, judged on the typed page.
const THRESHOLD = 2048;
const BUDGET = 4096;
const DENSITY_N = 16;
function tileOf(answer) {
  assert.equal(answer.status, 200, `a tile answers 200, got ${answer.status}`);
  assert.equal(answer.header("content-type"), "application/vnd.sdn.flatbuffers.stream");
  const { header, rows, records } = readPage(answer.body);
  assert.equal(records.length, 0, "a tile is a projection: no record frames follow the header");
  assert.equal(header.SCHEMA_NAME, "TBS");
  const columns = header.COLUMNS.map((c) => c.NAME);
  const mode = columns.join(",") === "LATITUDE,LONGITUDE" ? "points" : columns.join(",") === "lon,lat,count" ? "density" : null;
  assert.ok(mode, `unknown tile columns ${columns}`);
  const count = Number(header.TOTAL_COUNT);
  if (mode === "points") {
    assert.ok(count <= BUDGET, `points mode with count ${count} > budget`);
    for (const p of rows) {
      assert.ok(Number.isFinite(p.LATITUDE) && Math.abs(p.LATITUDE) <= 90);
      assert.ok(Number.isFinite(p.LONGITUDE) && Math.abs(p.LONGITUDE) <= 180);
    }
  } else {
    assert.ok(count > BUDGET, `density mode with count ${count} <= budget`);
    assert.ok(rows.length > 0, "density cells must be a non-empty array");
  }
  const message = header.MESSAGE ?? "";
  const malformed = Number(/malformed (\d+)/.exec(message)?.[1]);
  const scoped = /scoped true/.test(message);
  const cacheState = /cache (\w+)/.exec(message)?.[1];
  return {
    mode, rows, count, header, scoped, malformed, cacheState,
    sampled: header.TRUNCATED, partial: header.PARTIAL, scanned: Number(header.SCANNED),
    records: Number(header.STORED), stale: header.STALE, asOfMs: Number(header.AS_OF_MS),
  };
}

// ── fixtures ───────────────────────────────────────────────────────────────

// A stored $TBS site whose writer OMITTED its position: it must be skipped, never plotted at null island.
function positionlessSite() {
  const { TBSProvenanceT, TBSConsensusT, tbsMergeMethod } = sds.TBS;
  return build("TBS", {
    ID: "positionless",
    SOURCES: [Object.assign(new TBSProvenanceT(), { PROVIDER_ID: "x", RETRIEVED_AT: "2026-08-24T00:00:00Z", LICENSE: "CC0" })],
    CONSENSUS: Object.assign(new TBSConsensusT(), { METHOD: tbsMergeMethod.SINGLE_SOURCE }),
  });
}
const storeOf = (points, extra = []) => stream([
  ...points.map(([lat, lon], i) => tbsSite({ id: `site-${i}`, latitude: lat, longitude: lon })),
  ...extra,
]);

function hostFor({ config = {}, rows = new Uint8Array(0), mark = null } = {}) {
  return createHostStub({
    "plugin.getConfig": configHandler(config),
    "storage.flatsql_query_stream": (c) => (isMarkQuery(c.sql) ? streamAnswer(mark ? stream([mark]) : new Uint8Array(0)) : streamAnswer(rows)),
  });
}
const queries = (stub) => stub.calls.filter((c) => c.operation === "storage.flatsql_query_stream");
const fetches = (stub) => stub.calls.filter((c) => c.operation === "http.request");
async function get(stub, path, query = "") {
  const { egress } = await runFlow(FLOW_WASM, stub, htqTrigger({ method: "GET", path, query }));
  return httpAnswerOf(egress);
}

const Z = 5;
const HOME_LAT = 40.7;
const HOME_LON = -74.0;
const X = lonToTileX(HOME_LON, Z);
const Y = latToTileY(HOME_LAT, Z);
function jitteredInTile(count, seed = 1) {
  const points = [];
  let state = seed;
  for (let i = 0; i < count; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const dLat = ((state % 1000) / 1000) * 4 - 2;
    const dLon = (((state >> 10) % 1000) / 1000) * 8 - 4;
    let lat = HOME_LAT + dLat;
    let lon = HOME_LON + dLon;
    if (lonToTileX(lon, Z) !== X || latToTileY(lat, Z) !== Y) { lat = HOME_LAT; lon = HOME_LON; }
    points.push([lat, lon]);
  }
  return points;
}
const WARM_MARK = irmRecord({
  providerId: "opencellid",
  sourceUrl: "https://example.invalid/opencellid-bulk.csv",
  nextOffset: 3145728,
  totalBytes: 3145728,
  nextChunkIndex: 1,
  recordsCommitted: 41234,
  updatedAt: "2026-08-24T12:00:00Z",
});
const tilePath = (z, x, y) => `/api/v1/cellular/tiles/${z}/${x}/${y}`;

// ── 1. META ────────────────────────────────────────────────────────────────

test("the meta page declares the tile contract and reports the store honestly from the mark alone", async () => {
  const stub = hostFor({ mark: WARM_MARK });
  const answer = await get(stub, "/api/v1/cellular/tiles/meta");
  assert.equal(answer.status, 200);
  const { header, rows, records } = readPage(answer.body);
  assert.equal(records.length, 0);
  assert.equal(rows.length, 1, "the capability envelope is one row");
  const meta = rows[0];
  assert.equal(meta.scheme, "xyz");
  for (const field of ["minZoom", "maxZoom", "threshold", "budget", "densityN"]) assert.ok(Number.isInteger(meta[field]), field);
  assert.deepEqual([meta.minZoom, meta.maxZoom, meta.threshold, meta.budget, meta.densityN], [0, 18, THRESHOLD, BUDGET, DENSITY_N]);
  assert.equal(meta.latClamp, 85.05112878);
  assert.equal(meta.tileUrlTemplate, "/api/v1/cellular/tiles/{z}/{x}/{y}");
  assert.equal(meta.cacheState, "warm");
  assert.equal(meta.records, 41234);
  assert.equal(meta.epoch, "2026-08-24T12:00:00Z");
  assert.equal(meta.stale, false);
  assert.ok(meta.dataset.length > 0);
  // the same honesty block on the page header
  assert.equal(Number(header.STORED), 41234);
  assert.equal(Number(header.AS_OF_MS), Date.parse("2026-08-24T12:00:00Z"));
  assert.equal(header.STALE, false);

  // NO ROW SCAN for meta: exactly one store read, and it is the mark read.
  assert.equal(queries(stub).length, 1, "meta must not scan the record store");
  assert.ok(isMarkQuery(queries(stub)[0].sql), "meta's one read is the durable $IRM mark read");
  assert.equal(fetches(stub).length, 0);
});

test("meta asked for JSON renders the envelope as one object with the client's field names", async () => {
  const answer = await get(hostFor({ mark: WARM_MARK }), "/api/v1/cellular/tiles/meta", "format=json");
  assert.equal(answer.status, 200);
  assert.equal(answer.header("content-type"), "application/json");
  const [meta] = JSON.parse(Buffer.from(answer.body).toString("utf8"));
  assert.equal(meta.scheme, "xyz");
  assert.equal(meta.budget, BUDGET);
  assert.equal(meta.cacheState, "warm");
});

test("meta over an un-ingested store says empty rather than claiming to be current", async () => {
  const answer = await get(hostFor({ mark: null }), "/api/v1/cellular/tiles/meta");
  const { header, rows } = readPage(answer.body);
  assert.equal(rows[0].cacheState, "empty");
  assert.equal(rows[0].records, 0);
  assert.equal(rows[0].stale, true);
  assert.ok(!Number.isNaN(Date.parse(rows[0].epoch)), "still an ISO timestamp the client can parse");
  assert.equal(Number(header.STORED), 0);
  assert.equal(Number(header.AS_OF_MS), 0);
  assert.equal(header.STALE, true);
});

// ── 2. A POINTS TILE ───────────────────────────────────────────────────────

test("a points tile carries exactly the sites inside it", async () => {
  const inTile = [[HOME_LAT, HOME_LON], [HOME_LAT + 0.01, HOME_LON + 0.01], [HOME_LAT - 0.01, HOME_LON - 0.01]];
  // Not in the tile: a site on the other side of the planet, and one whose writer omitted its position.
  const rows = storeOf(inTile, [tbsSite({ id: "sydney", latitude: -33.9, longitude: 151.2 }), positionlessSite()]);
  const stub = hostFor({ mark: WARM_MARK, rows });
  const tile = tileOf(await get(stub, tilePath(Z, X, Y)));
  assert.equal(tile.mode, "points");
  assert.equal(tile.count, 3);
  assert.equal(tile.sampled, false);
  assert.equal(tile.rows.length, 3);
  // exact doubles: the shipped points ARE the stored positions
  assert.deepEqual(tile.rows.map((p) => [p.LATITUDE, p.LONGITUDE]).sort(), inTile.slice().sort());
  for (const p of tile.rows) {
    assert.equal(lonToTileX(p.LONGITUDE, Z), X);
    assert.equal(latToTileY(p.LATITUDE, Z), Y);
  }
  // the positionless record was skipped, not plotted: 4 positioned records scanned of 5 stored
  assert.equal(tile.scanned, 4);
  assert.equal(tile.malformed, 1);
  assert.equal(tile.cacheState, "warm");
  assert.equal(tile.records, 41234);
});

test("an empty store answers an empty tile and says which of the two it is", async () => {
  const stub = hostFor({ mark: null });
  const tile = tileOf(await get(stub, tilePath(Z, X, Y)));
  assert.equal(tile.mode, "points");
  assert.equal(tile.count, 0);
  assert.deepEqual(tile.rows, []);
  assert.equal(tile.cacheState, "empty");
  assert.equal(tile.records, 0);
  assert.equal(tile.stale, true);
  assert.equal(fetches(stub).length, 0);
});

// ── 3. THE DETERMINISTIC SAMPLE ────────────────────────────────────────────

test("a tile above the threshold and at or below budget ships a deterministic sample", async () => {
  const rows = storeOf(jitteredInTile(3000));
  const once = () => get(hostFor({ mark: WARM_MARK, rows }), tilePath(Z, X, Y));
  const first = await once();
  const tile = tileOf(first);
  assert.equal(tile.mode, "points", "still points: the client refuses density at or below budget");
  assert.equal(tile.count, 3000, "count is the tile's TRUE population, not the shipped count");
  assert.equal(tile.sampled, true);
  assert.ok(tile.rows.length <= THRESHOLD && tile.rows.length > 0);
  assert.equal(tile.rows.length, Math.ceil(3000 / Math.ceil(3000 / THRESHOLD)), "stride ceil(count/threshold)");
  // DETERMINISM: the same store and tile give the same rows (the page's GENERATED_AT_MS aside)
  const second = tileOf(await once());
  assert.deepEqual(second.rows, tile.rows, "the sample must be reproducible");
});

// ── 4. A DENSITY TILE ──────────────────────────────────────────────────────

test("a tile above budget ships a 16x16 density grid whose cells account for every site", async () => {
  const tile = tileOf(await get(hostFor({ mark: WARM_MARK, rows: storeOf(jitteredInTile(4500)) }), tilePath(Z, X, Y)));
  assert.equal(tile.mode, "density");
  assert.equal(tile.count, 4500);
  assert.ok(tile.rows.length > 0 && tile.rows.length <= DENSITY_N * DENSITY_N);
  assert.equal(tile.rows.reduce((sum, cell) => sum + cell.count, 0), tile.count, "the cells account for every site");
  for (const cell of tile.rows) assert.ok(cell.count > 0, "an emitted density cell is populated");
  // the cells partition their parent tile EXACTLY (zero tolerance: the server sends the exact doubles it used)
  const bounds = tileBounds(Z, X, Y);
  for (const cell of tile.rows) {
    const rect = densityCellRectangle({ z: Z, x: X, y: Y }, DENSITY_N, cell);
    assert.ok(rect.west >= bounds.west && rect.east <= bounds.east, "cell inside the tile (lon)");
    assert.ok(rect.south >= bounds.south && rect.north <= bounds.north, "cell inside the tile (lat)");
  }
});

// ── 5. BOUNDS ARE REFUSED, NEVER CLAMPED ───────────────────────────────────

for (const [label, requestPath] of [
  ["zoom above the maximum", tilePath(19, 0, 0)],
  ["zoom far above the maximum", tilePath(30, 0, 0)],
  ["x at 2^z", tilePath(2, 4, 0)],
  ["y at 2^z", tilePath(2, 0, 4)],
  ["a non-integer index", "/api/v1/cellular/tiles/5/3.5/9"],
  ["a negative index", "/api/v1/cellular/tiles/5/-1/9"],
  ["too few path segments", "/api/v1/cellular/tiles/5/9"],
  ["too many path segments", "/api/v1/cellular/tiles/5/9/9/9"],
]) {
  test(`${label} is refused 400, not clamped into a neighbouring tile`, async () => {
    const stub = hostFor({ mark: WARM_MARK, rows: storeOf([[HOME_LAT, HOME_LON]]) });
    const answer = await get(stub, requestPath, "format=json");
    assert.equal(answer.status, 400, `${requestPath} must be a 400`);
    const error = JSON.parse(Buffer.from(answer.body).toString("utf8"));
    assert.ok(typeof error.error === "string" && error.error.length > 0, "the reason is named");
    assert.ok(["tile-bounds", "tile-path"].includes(error.code), `unexpected code ${error.code}`);
    // a refusal costs the store NOTHING: no row scan, no mark read, no fetch
    assert.equal(queries(stub).length, 0, "a refused tile request must not read the store");
    assert.equal(fetches(stub).length, 0);
  });
}

test("a refusal without format=json is the $APR itself", async () => {
  const answer = await get(hostFor({}), tilePath(19, 0, 0));
  assert.equal(answer.status, 400);
  const apr = (await import("./typed-host.mjs")).unpack("APR", answer.body);
  assert.equal(apr.STATUS, 400);
  assert.equal(apr.ERROR_CODE, "tile-bounds");
});

// ── 6. THE TILE LANE AND THE CACHE LANE ARE MUTUALLY EXCLUSIVE ─────────────

test("a tile request never reaches the aggregate cache lane, and vice versa", async () => {
  const rows = storeOf([[HOME_LAT, HOME_LON]]);
  const tile = tileOf(await get(hostFor({ mark: WARM_MARK, rows }), tilePath(Z, X, Y)));
  assert.equal(tile.mode, "points");

  const aggStub = hostFor({ mark: WARM_MARK, rows });
  const { egress } = await runFlow(FLOW_WASM, aggStub, htqTrigger({
    method: "POST", path: "/api/v1/cellular/aggregate", body: JSON.stringify({ PROVIDERS: ["opencellid"], LIMIT: 2000 }),
  }));
  assert.equal(httpAnswerOf(egress).status, 200);
  assert.equal(queries(aggStub).length, 2, "the aggregate lane still runs its two reads");
});

// ── 7. THE READ IS SCOPED AND BOUNDED (graph sdn-cellular-tile-lane-stalls-after-tile-plan) ──

const tileRowQuery = (stub) => queries(stub).find((c) => !isMarkQuery(c.sql));

test("the tile row read is scoped to the tile's own rectangle and bounded by the row budget", async () => {
  const stub = hostFor({ mark: WARM_MARK, rows: storeOf([[HOME_LAT, HOME_LON]]) });
  await get(stub, tilePath(Z, X, Y));
  const rowQuery = tileRowQuery(stub);
  assert.ok(rowQuery, "the tile lane must issue a row read");
  assert.match(rowQuery.sql,
    /SELECT _data FROM TBS WHERE LATITUDE >= \?1 AND LATITUDE <= \?2 AND LONGITUDE >= \?3 AND LONGITUDE <= \?4 ORDER BY _rowid DESC LIMIT \?5/);
  const bounds = tileBounds(Z, X, Y);
  assert.deepEqual(rowQuery.sqlValues.map((p) => p.t), ["f64", "f64", "f64", "f64", "i64"], "four f64 bounds and an i64 budget");
  assert.deepEqual(rowQuery.sqlParams, [bounds.south, bounds.north, bounds.west, bounds.east, 25000]);
});

test("a deeper tile reads a strictly smaller rectangle than its ancestor", async () => {
  const read = async (z) => {
    const stub = hostFor({ mark: WARM_MARK, rows: storeOf([[HOME_LAT, HOME_LON]]) });
    await get(stub, tilePath(z, lonToTileX(HOME_LON, z), latToTileY(HOME_LAT, z)));
    const [south, north, west, east] = tileRowQuery(stub).sqlParams;
    return { south, north, west, east };
  };
  const a = await read(12);
  const b = await read(2);
  assert.ok(a.north - a.south < b.north - b.south && a.east - a.west < b.east - b.west);
  assert.ok(a.south >= b.south && a.north <= b.north && a.west >= b.west && a.east <= b.east);
});

test("an explicit cell_tile_sql override is taken verbatim with the budget as its one param, and the page admits it", async () => {
  const override = "SELECT _data FROM my_tbs_view ORDER BY rowid DESC LIMIT ?";
  const config = { cell_tile_sql: override, cell_tile_max_rows: 1234 };
  const stub = hostFor({ config, mark: WARM_MARK, rows: storeOf([[HOME_LAT, HOME_LON]]) });
  const tile = tileOf(await get(stub, tilePath(Z, X, Y)));
  const rowQuery = tileRowQuery(stub);
  assert.equal(rowQuery.sql, override);
  assert.deepEqual(rowQuery.sqlParams, [1234]);
  assert.equal(tile.scoped, false);
  assert.equal(tile.partial, true, "an unscoped slice is a partial read: an empty tile there is not 'no sites'");
});

test("a read that hits the row budget answers 200 and SAYS it was partial", async () => {
  const rows = storeOf([[HOME_LAT, HOME_LON], [HOME_LAT + 0.001, HOME_LON + 0.001], [HOME_LAT + 0.002, HOME_LON + 0.002], [HOME_LAT + 0.003, HOME_LON + 0.003]]);
  const tile = tileOf(await get(hostFor({ config: { cell_tile_max_rows: 4 }, mark: WARM_MARK, rows }), tilePath(Z, X, Y)));
  assert.equal(tile.scanned, 4);
  assert.equal(tile.partial, true, "a full read must be reported as partial");
  assert.equal(tile.count, 4);
});

test("a read inside the row budget is NOT reported as partial", async () => {
  const tile = tileOf(await get(hostFor({ mark: WARM_MARK, rows: storeOf([[HOME_LAT, HOME_LON]]) }), tilePath(Z, X, Y)));
  assert.equal(tile.partial, false);
  assert.equal(tile.scanned, 1);
  assert.equal(tile.scoped, true, "the default read is scoped to the tile");
});

test("the row stream may arrive as several $FSB chunks and is reassembled in order", async () => {
  // 3000 sites are far more than one MiB? No - so force chunking through the store stream size instead: 1.2 MiB of
  // sites crosses flatsql-query's 1 MiB FSB chunk boundary.
  const many = jitteredInTile(6000);
  const rows = storeOf(many);
  assert.ok(rows.length > 1024 * 1024, `fixture must exceed one FSB chunk (${rows.length} bytes)`);
  const tile = tileOf(await get(hostFor({ mark: WARM_MARK, rows }), tilePath(Z, X, Y)));
  assert.equal(tile.mode, "density");
  assert.equal(tile.count, 6000, "every site across both chunks is counted");
  assert.equal(frames(rows).length, 6000);
});
