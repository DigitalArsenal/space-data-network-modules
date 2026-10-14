/*
 * Flow-level tests for the compiled geonames-ingest flow on the typed contracts (1.0) - BRIDGE mode: the SAME
 * runtime.wasm the Go host serves from its cron timer, in the JS flow runtime host (WasmEdge leg). A TimerTick enters
 * and the whole mark read -> plan -> fetch -> inflate -> parse -> ingest -> publish chain runs linked-direct inside the
 * artifact, every frame a FlatBuffer ($FSO / $FSB, HttpRequest / HttpResponse with the job's $GNP header in CONTEXT,
 * $GNP stream, IngestRequest / IngestResult, $IRM, FlowNotice); the only host crossings are the declared hostcalls, each
 * an SDS $PIV invocation answered here as the Go node answers it: plugin.getConfig (one ModuleConfig on raw "config"),
 * storage.flatsql_query_stream (StreamResult + raw aligned size-prefixed stream), http.request (HttpParams + raw url /
 * headers / body) and storage.ingest_with_source (StorageIngestParams + raw records + list provenance).
 *
 * These assert COMPUTABLE OUTCOMES only. Every assertion is a number, a URL, a byte range or a decoded field that must
 * hold for the ingest to be correct:
 *   - which lane a tick runs, and which URLs that lane asks for,
 *   - the range header bounded by the Go host's 4 MiB response-body cap,
 *   - the in-guest ZIP inflate on the seed edition,
 *   - the resolved admin/country NAMES $GNP requires, joined from the lookup fetches,
 *   - the record counts that actually reached storage.ingest_with_source,
 *   - no reconcile and one batch id per edition,
 *   - the same-data ledger: a repeat day costs ZERO fetches, and an unchanged file costs ONE conditional request that
 *     304s and stores nothing; the $IRM a run emits is the mark the next run resumes from,
 *   - the inserted=0 refusal,
 *   - fail-closed publication.
 *
 * Data: verbatim slices of the live GeoNames dumps (data-source/geonames-source/tests/fixtures, PROVENANCE.md), the
 * seed served as a real ZIP around the modifications rows so the vendored in-guest inflate runs end to end.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";
import {
  decodeFlowNotice,
  decodeHostCall,
  decodeHttpResponse,
  decodeIngestResult,
  encodeHostCallResult,
  encodeModuleConfig,
  encodeTimerTick,
  identifierOf,
} from "space-data-module-sdk/runtime-contracts";

const decoder = new TextDecoder();
const FLOW_WASM = new URL("../dist/runtime.wasm", import.meta.url);
const FIXTURES = new URL("../../../data-source/geonames-source/tests/fixtures/", import.meta.url);
const fixture = (name) => fs.readFileSync(fileURLToPath(new URL(name, FIXTURES)));
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const lib = (code) => pathToFileURL(path.join(STANDARDS_ROOT, `lib/js/${code}/main.js`));
const flatbuffers = createRequire(lib("GNP"))("flatbuffers");
const gnpLib = await import(lib("GNP").href);
const irmLib = await import(lib("IRM").href);

const BASE = "https://download.geonames.org/export/dump/";
const MODIFICATIONS = fixture("geonames-modifications.slice.txt");
const DELETES = fixture("geonames-deletes.slice.txt");
const ADMIN1 = fixture("admin1CodesASCII.slice.txt");
const ADMIN2 = fixture("admin2Codes.slice.txt");
const COUNTRY = fixture("countryInfo.slice.txt");
const PLACE_ROWS = MODIFICATIONS.toString("utf8").trimEnd().split("\n").length;
const AUG15 = Date.UTC(2026, 7, 15);
const RETRIEVED_MS = Date.UTC(2026, 7, 15, 2, 18);
const PUBLISH_URL = "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish";

// A real ZIP around the fixture rows, so the SEED lane exercises the vendored in-guest inflate end to end rather than a
// stand-in.
function buildZip(name, contents) {
  const nameBytes = Buffer.from(name, "utf8");
  const raw = Buffer.from(contents);
  const deflated = zlib.deflateRawSync(raw, { level: 9 });
  const crc = zlib.crc32 ? zlib.crc32(raw) : 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBytes.length, 12);
  eocd.writeUInt32LE(local.length + nameBytes.length + deflated.length, 16);
  return Buffer.concat([local, nameBytes, deflated, central, nameBytes, eocd]);
}

const SEED_ZIP = buildZip("cities15000.txt", MODIFICATIONS);
const SEED_ETAG = '"3273cd-6590c8be06b08"';

// An $IRM mark of this lane as publish_request authors it.
function irmMark({ date, etag = null, dataset = "geonames" }) {
  const { IRMT, IRMSourceT, irmJobState } = irmLib;
  const record = new IRMT(`geonames-ingest/${dataset}`, BigInt(Date.parse(`${date}T00:00:00Z`) / 86400000), "geonames",
    "com.digitalarsenal.data-source.geonames-ingest",
    new IRMSourceT(`${BASE}modifications-${date}.txt`, null, null, null, 0n, etag, null, null, `${date}T00:00:00.000Z`), irmJobState.COMPLETE);
  record.UPDATED_AT = `${date}T02:30:00.000Z`;
  const b = new flatbuffers.Builder(512);
  b.finish(record.pack(b), "$IRM");
  return b.asUint8Array().slice();
}
// The engine's aligned size-prefixed stream: each record size-prefixed, zero-length prefixes as padding.
function recordStream(records) {
  return Buffer.concat(records.flatMap((r) => {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(r.length, 0);
    return [len, Buffer.from(r), Buffer.alloc(4)];
  }));
}
const SEEDED_MARK = irmMark({ date: "2026-08-14", etag: '"76b6-yesterday"' });

const headerLines = (bytes) => Object.fromEntries(decoder.decode(bytes ?? new Uint8Array(0)).split(/\r?\n/).filter(Boolean)
  .map((l) => [l.slice(0, l.indexOf(":")).trim().toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
const headerBlock = (headers) => Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n");

// The host side of the typed hostcalls. Serves the gazetteer as a real origin: it honours Range, answers a truthful
// Content-Range, publishes an ETag, and honours If-None-Match with a 304 - the four behaviours this lane's schedule and
// ledger depend on. The store answers the mark read with `marks` ($IRM records) and the ingest with `ingestResult`.
function createHostStub({ config = {}, marks = [], ingestResult, missingDeletes = false } = {}) {
  const calls = [];
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);
  const answer = (r) => { response = encodeHostCallResult(r); return 0; };
  const bodies = new Map([
    [`${BASE}cities15000.zip`, { body: SEED_ZIP, etag: SEED_ETAG }],
    [`${BASE}admin1CodesASCII.txt`, { body: ADMIN1 }],
    [`${BASE}admin2Codes.txt`, { body: ADMIN2 }],
    [`${BASE}countryInfo.txt`, { body: COUNTRY }],
    [`${BASE}modifications-2026-08-15.txt`, { body: MODIFICATIONS, etag: '"76b6-mods"' }],
    [`${BASE}modifications-2026-08-16.txt`, { body: MODIFICATIONS, etag: '"76b6-mods-16"' }],
    [`${BASE}deletes-2026-08-15.txt`, { body: DELETES, etag: '"76b6-dels"' }],
    [`${BASE}deletes-2026-08-16.txt`, { body: DELETES, etag: '"76b6-dels-16"' }],
  ]);
  const http = (status, headers, body) =>
    answer({ ok: true, op: "http.request", result: { STATUS: status, RETRIEVED_MS: BigInt(RETRIEVED_MS) }, raw: { url: "", headers: headerBlock(headers), body: Buffer.from(body) } });
  const imports = { space_data_module_host: {
    call(opPtr, opLen, payloadPtr, payloadLen) {
      const heap = new Uint8Array(memoryRef.memory.buffer);
      const operation = decoder.decode(heap.subarray(opPtr, opPtr + opLen));
      const call = decodeHostCall(Uint8Array.from(heap.subarray(payloadPtr, payloadPtr + payloadLen)));
      assert.equal(call.op, operation);
      const c = { operation, params: call.params, lists: call.lists, raw: call.raw };
      calls.push(c);
      if (operation === "plugin.getConfig") return answer({ ok: true, op: operation, raw: { config: encodeModuleConfig(config) } });
      if (operation === "storage.flatsql_query_stream") {
        c.sql = decoder.decode(call.raw.sql);
        return answer({ ok: true, op: operation, result: { ROWS: BigInt(marks.length), COLUMNS: 1 }, raw: { stream: recordStream(marks) } });
      }
      if (operation === "http.request") {
        c.url = decoder.decode(call.raw.url);
        c.headers = headerLines(call.raw.headers);
        c.method = call.params.METHOD || "GET";
        if (c.url === PUBLISH_URL) return http(202, {}, "");
        const entry = bodies.get(c.url);
        // GeoNames retains only the most recent day's deletes file and answers 404 with an HTML body for anything older.
        if (!entry || (missingDeletes && c.url.includes("deletes-"))) return http(404, {}, "<!DOCTYPE HTML>\n<title>404 Not Found</title>\n");
        const ifNoneMatch = c.headers["if-none-match"];
        if (ifNoneMatch && entry.etag && ifNoneMatch === entry.etag) return http(304, { etag: entry.etag }, "");
        const etag = entry.etag ? { etag: entry.etag } : {};
        const range = c.headers.range;
        if (!range) return http(200, { ...etag, "content-length": String(entry.body.length) }, entry.body);
        const m = /bytes=(\d+)-(\d+)/.exec(range);
        const start = Number(m[1]), end = Math.min(Number(m[2]), entry.body.length - 1);
        return http(206, { ...etag, "content-range": `bytes ${start}-${end}/${entry.body.length}` }, entry.body.subarray(start, end + 1));
      }
      if (operation === "storage.ingest_with_source") {
        const records = Buffer.from(call.raw.records);
        let count = 0;
        for (let off = 0; off + 4 <= records.length;) { off += 4 + records.readUInt32LE(off); count++; }
        c.records = records;
        const p = call.params;
        return answer({ ok: true, op: operation, result: ingestResult ? ingestResult(p, count) : { SCHEMA: p.SCHEMA, BATCH_ID: p.BATCH_ID, INSERTED: BigInt(count) } });
      }
      return answer({ ok: false, error: { code: "unsupported", message: `unexpected op ${operation}` } });
    },
    response_len() { return response.length; },
    read_response(dst, len) { const n = Math.min(len, response.length); new Uint8Array(memoryRef.memory.buffer).set(response.subarray(0, n), dst); return n; },
  } };
  return { calls, imports, memoryRef };
}

// Egress frames by type: IngestResult, FlowNotice, HttpResponse (publication), $IRM (the mark).
async function runFlowOnce(stub, firedMs = AUG15) {
  const host = await createFlowRuntimeHost({ wasmSource: new Uint8Array(fs.readFileSync(FLOW_WASM)), extraImports: stub.imports, runtimeTarget: "wasmedge" });
  stub.memoryRef.memory = host.memory;
  const egress = { results: [], notices: [], publications: [], marks: [], ports: new Set() };
  host.enqueueTriggerFrame(0, { portId: "tick", bytes: encodeTimerTick({ triggerId: "timer-geonames-ingest", scheduledMs: firedMs, firedMs }) });
  await host.drain({
    "sdn.flow.egress:emit": ({ frames }) => {
      for (const f of frames) {
        egress.ports.add(f.portId);
        const id = identifierOf(f.bytes);
        if (id === "INGR") egress.results.push(decodeIngestResult(f.bytes));
        else if (id === "FNTC") egress.notices.push(decodeFlowNotice(f.bytes));
        else if (id === "HRSP") egress.publications.push(decodeHttpResponse(f.bytes));
        else if (id === "$IRM") egress.marks.push({ bytes: Uint8Array.from(f.bytes), irm: irmLib.IRM.getRootAsIRM(new flatbuffers.ByteBuffer(Uint8Array.from(f.bytes))).unpack() });
        else if (id === "$FSO") egress.notices.push({ fso: true });
        else assert.fail(`an egress frame that is no typed contract: "${id}"`);
      }
      return { statusCode: 0 };
    },
  });
  return egress;
}

const httpCalls = (stub) => stub.calls.filter((c) => c.operation === "http.request");
const ingestCalls = (stub) => stub.calls.filter((c) => c.operation === "storage.ingest_with_source");
const fetchedUrls = (stub) => httpCalls(stub).map((c) => c.url);
function storedRecords(call) {
  const out = [];
  for (let off = 0; off + 4 <= call.records.length;) {
    const len = call.records.readUInt32LE(off);
    out.push(call.records.subarray(off + 4, off + 4 + len));
    off += 4 + len;
  }
  return out;
}
const decodeGnp = (record) => gnpLib.GNP.getRootAsGNP(new flatbuffers.ByteBuffer(Uint8Array.from(record))).unpack();

// ---------------------------------------------------------------------------
// the SEED lane
// ---------------------------------------------------------------------------

test("the first tick seeds: the marks are read, the archive is fetched RANGED and inflated in-guest", async () => {
  const stub = createHostStub();
  await runFlowOnce(stub);
  const read = stub.calls.find((c) => c.operation === "storage.flatsql_query_stream");
  assert.equal(read.sql, "SELECT _data FROM IRM ORDER BY _rowid DESC LIMIT ?", "the $IRM marks through the code-named view");
  const seedCall = httpCalls(stub).find((c) => c.url.endsWith("cities15000.zip"));
  // The Go host caps a response body at 4 MiB; a larger ask is truncated by the host and inflates to a plausible short
  // gazetteer with no error anywhere.
  assert.equal(seedCall.headers.range, `bytes=0-${4 * 1024 * 1024 - 1}`);
  const stores = ingestCalls(stub);
  assert.equal(stores.length, 1, "one tick, one store");
  assert.equal(storedRecords(stores[0]).length, PLACE_ROWS, "every row inside the ZIP reached storage, which proves the in-guest inflate ran");
});

test("the seed fetches all three lookup files and nothing else", async () => {
  const stub = createHostStub();
  await runFlowOnce(stub);
  assert.deepEqual(fetchedUrls(stub).sort(), [`${BASE}admin1CodesASCII.txt`, `${BASE}admin2Codes.txt`, `${BASE}cities15000.zip`, `${BASE}countryInfo.txt`]);
});

test("the stored records carry the RESOLVED names the join produced, not just codes", async () => {
  // $GNP: "Carried beside the code so a consumer need not hold the division tables to render a place." The country
  // file is fetched in the same tick and joined in-guest, so this is end-to-end evidence that the join happened.
  const stub = createHostStub();
  await runFlowOnce(stub);
  const [raw] = storedRecords(ingestCalls(stub)[0]);
  // The file identifier lives at bytes 4..8 of a FlatBuffer root; getting it wrong is how a stream reaches storage and is
  // routed to the wrong table.
  assert.equal(raw.subarray(4, 8).toString("latin1"), "$GNP");
  const place = decodeGnp(raw);
  assert.equal(place.COUNTRY_NAME, "Argentina", "COUNTRY_NAME resolved from countryInfo.txt");
  assert.equal(place.ID, "geonames:3432555", "the publisher-stable ID is minted and prefixed");
  assert.equal(place.SOURCE.LICENSE, "CC BY 4.0", "the licence rides on every record");
  assert.equal(place.SOURCE.DATASET_EPOCH, "2026-08-15T00:00:00.000Z", "the edition is the tick's day");
  assert.equal(place.SOURCE.SOURCE_URL, `${BASE}cities15000.zip`);
});

test("storage attribution: GNP.fbs, no reconcile, one batch id per edition, the response's provenance", async () => {
  const stub = createHostStub();
  await runFlowOnce(stub);
  const { params, lists } = ingestCalls(stub)[0];
  assert.deepEqual([params.SCHEMA, params.PROVIDER_ID, params.SOURCE_NAME, params.BATCH_ID, params.SOURCE_URL],
    ["GNP.fbs", "geonames", "geonames-gazetteer", "geonames@2026-08-15", `${BASE}cities15000.zip`]);
  // NOT a source-batch reconcile: a daily modifications file is an upsert of a few thousand rows and retiring older
  // batches on it would delete the rest of the world.
  assert.equal(params.RECONCILE, 1, "reconcileKind None");
  assert.equal(lists.provenance.length, 1);
  const p = lists.provenance[0];
  assert.deepEqual([p.HTTP_STATUS, p.ETAG, p.NORMALIZED_COUNT, p.PARSER], [206, SEED_ETAG, BigInt(PLACE_ROWS), "geonames-ingest-wasm"]);
});

test("the mark that comes out of a seed is an $IRM marking the dataset SEEDED and ledgering the ETag", async () => {
  const stub = createHostStub();
  const egress = await runFlowOnce(stub);
  assert.equal(egress.marks.length, 1, "publish_request emitted the advanced mark");
  const { irm } = egress.marks[0];
  assert.equal(irm.JOB_ID, "geonames-ingest/geonames");
  assert.equal(irm.STATE, irmLib.irmJobState.COMPLETE);
  assert.deepEqual(irm.TAGS, ["date:2026-08-15", "lane:seed"]);
  assert.equal(irm.SOURCE.SOURCE_VERSION, "2026-08-15T00:00:00.000Z");
  assert.equal(irm.SOURCE.ENTITY_TAG, SEED_ETAG, "the mark IS the same-data ledger");
  assert.equal(irm.RECORDS_COMMITTED, BigInt(PLACE_ROWS));
  // the run's notices: the inflate report and the parse summary
  assert.deepEqual(egress.notices.filter((n) => !n.fso).map((n) => [n.kind, n.reason]).sort(), [["info", "inflated"], ["info", "places-decoded"]]);
  assert.deepEqual(egress.results.map((r) => [r.schema, r.batchId, r.inserted]), [["GNP.fbs", "geonames@2026-08-15", PLACE_ROWS]]);
});

// ---------------------------------------------------------------------------
// the DELTA lane
// ---------------------------------------------------------------------------

test("a seeded mark makes the tick a DELTA: modifications + deletes, no lookups", async () => {
  const stub = createHostStub({ marks: [SEEDED_MARK] });
  const egress = await runFlowOnce(stub);
  assert.deepEqual(fetchedUrls(stub).sort(), [`${BASE}deletes-2026-08-15.txt`, `${BASE}modifications-2026-08-15.txt`]);
  // The daily modifications file is a file of FULL geoname rows (verified live 2026-08-15), so it upserts through the
  // SAME decoder as the seed.
  const stores = ingestCalls(stub);
  assert.equal(stores.length, 1);
  assert.equal(storedRecords(stores[0]).length, PLACE_ROWS);
  assert.equal(stores[0].params.BATCH_ID, "geonames@2026-08-15");
  assert.deepEqual(egress.marks[0].irm.TAGS, ["date:2026-08-15", "lane:delta"]);
  // The tombstones leave the flow on egress: no host capability removes a stored row, and inventing one would be a new
  // host capability this lane may not add.
  const tombstones = egress.notices.find((n) => n.reason === "tombstones");
  assert.ok(tombstones, "the tombstone list reached egress");
  assert.equal(tombstones.count, 1);
  assert.deepEqual(tombstones.items, ["geonames:793657\tMalynivka\tduplicate"]);
});

test("a missing deletes file does not stop the day's places from being stored", async () => {
  // GeoNames retains only the most recent day's deletes file; every older date 404s with an HTML body. The places lane
  // must be unaffected.
  const stub = createHostStub({ marks: [SEEDED_MARK], missingDeletes: true });
  const egress = await runFlowOnce(stub);
  assert.equal(ingestCalls(stub).length, 1, "the modifications still reached storage");
  assert.equal(storedRecords(ingestCalls(stub)[0]).length, PLACE_ROWS);
  assert.equal(egress.notices.find((n) => n.reason === "tombstones"), undefined, "nothing is tombstoned from a 404 body");
});

test("the $IRM one run emits is the mark the next run resumes from", async () => {
  // Day 15 seeds; the store hands that very $IRM back on day 16, which is then a DELTA for the 16th.
  const first = createHostStub();
  const [{ bytes: mark }] = (await runFlowOnce(first)).marks;
  const second = createHostStub({ marks: [mark] });
  await runFlowOnce(second, AUG15 + 86400000);
  assert.deepEqual(fetchedUrls(second).sort(), [`${BASE}deletes-2026-08-16.txt`, `${BASE}modifications-2026-08-16.txt`]);
  assert.equal(httpCalls(second).find((c) => c.url.includes("modifications-")).headers["if-none-match"], SEED_ETAG);
});

// ---------------------------------------------------------------------------
// the SAME-DATA LEDGER
// ---------------------------------------------------------------------------

test("a tick for a day already on the mark costs ZERO fetches", async () => {
  const stub = createHostStub({ marks: [irmMark({ date: "2026-08-15", etag: '"76b6-mods"' })] });
  await runFlowOnce(stub);
  assert.deepEqual(fetchedUrls(stub), [], "the cheapest possible no-op");
  assert.deepEqual(ingestCalls(stub), []);
});

test("an unchanged file costs ONE conditional request, 304s, and stores nothing", async () => {
  // The mark's ETag rides out as if-none-match. A 304 is the ledger paying off, not a failure: the run ends without
  // storing identical rows again.
  const stub = createHostStub({ marks: [irmMark({ date: "2026-08-14", etag: '"76b6-mods"' })] });
  const egress = await runFlowOnce(stub);
  const modsCall = httpCalls(stub).find((c) => c.url.includes("modifications-"));
  assert.equal(modsCall.headers["if-none-match"], '"76b6-mods"');
  assert.deepEqual(ingestCalls(stub), [], "nothing is re-stored");
  assert.deepEqual(egress.marks, [], "and no mark advances over a store that never happened");
  const report = egress.notices.find((n) => n.kind === "unchanged");
  assert.ok(report, "the no-op is OBSERVABLE, not indistinguishable from a flow that never fired");
  assert.equal(report.reason, "not-modified");
  assert.ok(report.items.includes("status=304"));
});

// ---------------------------------------------------------------------------
// failure modes
// ---------------------------------------------------------------------------

test("SILENT NOP: inserted=0 stops the run and does NOT advance the mark", async () => {
  // Byte-identical to a day the gazetteer did not change, so it is only detectable against the count the tick actually
  // produced.
  const stub = createHostStub({ ingestResult: (p) => ({ SCHEMA: p.SCHEMA, BATCH_ID: p.BATCH_ID, INSERTED: 0n }) });
  const egress = await runFlowOnce(stub);
  assert.deepEqual(egress.marks, [], "no mark, so the next tick re-fetches this edition");
});

test("publication is fail-closed without a configured URL", async () => {
  const stub = createHostStub();
  await runFlowOnce(stub);
  assert.deepEqual(httpCalls(stub).filter((c) => c.method === "POST"), [], "absence of configuration is not permission to publish");
});

test("the epoch announce POSTs the IngestResult naming the batch when a URL IS configured", async () => {
  const stub = createHostStub({ config: { geonames_publish_url: PUBLISH_URL } });
  const egress = await runFlowOnce(stub);
  const posts = httpCalls(stub).filter((c) => c.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, PUBLISH_URL);
  assert.equal(posts[0].headers["content-type"], "application/octet-stream");
  const body = decodeIngestResult(posts[0].raw.body);
  assert.deepEqual([body.schema, body.providerId, body.sourceName, body.batchId, body.inserted], ["GNP.fbs", "geonames", "geonames-gazetteer", "geonames@2026-08-15", PLACE_ROWS]);
  assert.deepEqual(egress.publications.map((r) => r.status), [202]);
});
