/*
 * Flow-level tests for the CACHE-FIRST cellular-network-aggregate flow on the typed contracts (1.0)
 * (graph task mod-cellular-aggregate-cache; owner 2026-08-14: "the cell towers should load almost instantaneously").
 *
 * COMPUTABLE OUTCOMES ONLY (owner law): each assertion is a byte range, a count, a typed field, or the presence /
 * absence of a host call.
 *
 *   1. CACHE-HIT CORRECTNESS: the records the flow serves are byte-identical to the stored $TBS rows the default FlatSQL
 *      query returned (after the dataset's $DAV frame, which says what they are).
 *   2. ZERO PROVIDER FETCHES on the cache path: the ABSENCE of any http.request hostcall.
 *   3. THE REFRESH ESCAPE HATCH still reaches the provider lane.
 *   4. HONEST STALENESS: nothing ingested -> instant AND says so (x-sdn-cache empty, $DAV KNOWN false / NotPublished).
 *   5. INVALIDATION: after the ingest lane advances its mark, the next request reflects the new store and progress.
 *
 * The SAME artifact the Go host would serve runs in the JS flow runtime host; every hostcall is an SDS $PIV invocation
 * answered as the Go node answers it (typed-host.mjs).
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  configHandler,
  createHostStub,
  frames,
  htqTrigger,
  httpAnswer,
  httpAnswerOf,
  irmRecord,
  isMarkQuery,
  runFlow,
  sds,
  stream,
  streamAnswer,
  tbsSite,
  unpack,
} from "./typed-host.mjs";

const FLOW_WASM = new URL("../dist/runtime.wasm", import.meta.url);

const SITES = [
  tbsSite({ id: "opencellid:17811", latitude: 40.7484, longitude: -73.9857 }),
  tbsSite({ id: "opencellid:987654321", latitude: 51.5072, longitude: -0.1276 }),
  tbsSite({ id: "opencellid:5678", latitude: 52.52, longitude: 13.405 }),
];
const CACHED_ROWS = stream(SITES);

function hostFor({ config = {}, rows = CACHED_ROWS, mark = null } = {}) {
  return createHostStub({
    "plugin.getConfig": configHandler(config),
    "storage.flatsql_query_stream": (c) => (isMarkQuery(c.sql) ? streamAnswer(mark ? stream([mark]) : new Uint8Array(0)) : streamAnswer(rows)),
    // only the REFRESH lane may reach this; an empty 200 is enough - the assertion is that it was CALLED
    "http.request": () => httpAnswer(200, ""),
  });
}
const queries = (stub) => stub.calls.filter((c) => c.operation === "storage.flatsql_query_stream");
const fetches = (stub) => stub.calls.filter((c) => c.operation === "http.request");
async function aggregate(stub, body, query = "") {
  const { egress } = await runFlow(FLOW_WASM, stub, htqTrigger({ method: "POST", path: "/api/v1/cellular/aggregate", query, body: JSON.stringify(body) }));
  return httpAnswerOf(egress);
}
// The answer of a dataset: one stream, its $DAV first, then the records verbatim. A dataset with no records is
// answered by foundation/http-respond as its $DAV alone (one record, application/x-flatbuffers).
function dataset(answer) {
  assert.equal(answer.status, 200);
  if (answer.header("content-type") === "application/x-flatbuffers") {
    assert.equal(answer.header("x-sdn-file-identifier"), "$DAV");
    return { dav: unpack("DAV", answer.body), records: [] };
  }
  assert.equal(answer.header("content-type"), "application/vnd.sdn.flatbuffers.stream");
  const [head, ...records] = frames(answer.body);
  return { dav: unpack("DAV", head), records };
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

test("cache hit serves exactly the default query's records, and contacts no provider", async () => {
  const stub = hostFor({ mark: WARM_MARK });
  const answer = await aggregate(stub, { PROVIDERS: ["opencellid"], LIMIT: 2000 });
  const { dav, records } = dataset(answer);
  // (1) served records == the direct query result, byte for byte
  assert.deepEqual(records.map((r) => Buffer.from(r).toString("hex")), SITES.map((s) => Buffer.from(s).toString("hex")));
  assert.ok(Buffer.from(answer.body).includes(Buffer.from(CACHED_ROWS)), "the stored stream is forwarded verbatim");
  assert.equal(answer.header("x-sdn-record-count"), "3");
  assert.equal(dav.STANDARD, "TBS");
  assert.equal(dav.SCHEMA_NAME, "TBS.fbs");
  assert.equal(Number(dav.RECORD_COUNT), 3);

  // (2) THE 9 SECONDS: not one provider was contacted
  assert.equal(fetches(stub).length, 0, "the cache path must issue zero provider fetches");

  // exactly two reads - the records and the mark - and the caller's LIMIT is bound, not interpolated
  assert.equal(queries(stub).length, 2);
  const recordQuery = queries(stub).find((q) => !isMarkQuery(q.sql));
  assert.match(recordQuery.sql, /\?/);
  assert.deepEqual(recordQuery.sqlParams, [2000]);
  assert.equal(recordQuery.sqlValues[0].t, "i64", "an int64 parameter");
});

test("a warm, completed cache says so: x-sdn-cache headers and a FRESH $DAV stamped by the mark", async () => {
  const answer = await aggregate(hostFor({ mark: WARM_MARK }), { PROVIDERS: ["opencellid"] });
  const { dav } = dataset(answer);
  assert.equal(answer.header("x-sdn-cache"), "warm");
  assert.equal(answer.header("x-sdn-cache-freshness"), "complete");
  assert.equal(answer.header("x-sdn-cache-stale"), "false");
  assert.match(answer.header("x-sdn-cache-providers"), /providerId=opencellid/);
  assert.match(answer.header("x-sdn-cache-providers"), /totalBytes=3145728/);
  assert.deepEqual([dav.KNOWN, dav.AVAILABLE, dav.FRESH], [true, true, true]);
  assert.equal(Number(dav.PUBLISHED_AT_MS), Date.parse("2026-08-24T12:00:00Z"));
  assert.equal(dav.PROVIDER_ID, "opencellid");
});

test("an empty cache answers instantly AND says it is empty", async () => {
  const stub = hostFor({ mark: null, rows: new Uint8Array(0) });
  const answer = await aggregate(stub, { PROVIDERS: ["opencellid"] });
  const { dav, records } = dataset(answer);
  assert.equal(records.length, 0);
  assert.equal(answer.header("x-sdn-cache"), "empty");
  assert.equal(answer.header("x-sdn-cache-stale"), "true");
  assert.deepEqual([dav.KNOWN, dav.AVAILABLE], [false, false]);
  assert.equal(dav.UNAVAILABLE_REASON, sds.DAV.davUnavailableReason.NotPublished);
  assert.equal(Number(dav.RECORD_COUNT), 0);
  assert.equal(fetches(stub).length, 0);
});

test("REFRESH:true bypasses the cache and reaches the provider lane", async () => {
  const stub = hostFor({ mark: WARM_MARK });
  const answer = await aggregate(stub, { PROVIDERS: ["openstreetmap-overpass"], BBOX: { south: 52.3, west: 13.0, north: 52.7, east: 13.8 }, REFRESH: true });
  assert.equal(queries(stub).length, 0, "REFRESH must not read the cache");
  assert.ok(fetches(stub).length >= 1, "REFRESH must reach the providers");
  assert.ok(fetches(stub).every((c) => c.url.includes("interpreter?data=")), "the Overpass endpoints and mirrors");
  const { dav } = dataset(answer);
  assert.equal(dav.SOURCE_NAME, "cellular-aggregate", "the live lane answered, not the cache");
});

test("the /providers catalog route is passed through to the provider lane, untouched by the cache", async () => {
  const stub = createHostStub({
    "plugin.getConfig": configHandler({}),
    "secrets.status": () => ({ result: { ID: "", CONFIGURED: false } }),
    "node.publicKey": () => ({ error: { code: "unsupported", message: "no key" } }),
  });
  const { egress } = await runFlow(FLOW_WASM, stub, htqTrigger({ method: "GET", path: "/api/v1/cellular/providers" }));
  const answer = httpAnswerOf(egress);
  assert.equal(answer.status, 200);
  assert.equal(queries(stub).length, 0, "the catalog route must not consult the cache");
});

test("invalidation: new ingest state changes what the next request is served and told", async () => {
  const a = await aggregate(hostFor({ mark: null, rows: new Uint8Array(0) }), { PROVIDERS: ["opencellid"] });
  assert.equal(a.header("x-sdn-cache"), "empty");

  const b = await aggregate(hostFor({
    mark: irmRecord({
      providerId: "opencellid",
      sourceUrl: "https://example.invalid/opencellid-bulk.csv",
      nextOffset: 1048576,
      totalBytes: 3145728,
      nextChunkIndex: 1,
      recordsCommitted: 900,
      updatedAt: "2026-08-24T11:00:00Z",
    }),
    rows: CACHED_ROWS,
  }), { PROVIDERS: ["opencellid"] });
  assert.equal(b.header("x-sdn-cache"), "warm");
  assert.equal(b.header("x-sdn-cache-freshness"), "ingesting", "still ingesting: it must NOT claim to be complete");
  assert.equal(b.header("x-sdn-cache-stale"), "true");
  const { dav, records } = dataset(b);
  assert.equal(dav.FRESH, false);
  assert.equal(records.length, 3, "the second request is served the newly stored rows");
});
