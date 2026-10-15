/*
 * Flow-level tests for the compiled cellular-network-ingest flow on the typed contracts (1.0).
 *
 * COMPUTABLE OUTCOMES ONLY (owner law: no UI-wiring or source-pattern tests). Every assertion is a number, a byte range
 * or a typed field that must hold for the ingest to be correct:
 *
 *   - the Range header arithmetic across chunks, and the 4 MiB clamp the Go host's response-body cap imposes,
 *   - the row-boundary correction (a chunk ends mid-row; the next must not start there),
 *   - the record counts that actually reached storage.ingest_with_source, reconcile None, one batch id per chunk,
 *   - the inserted=0 refusal, fail-closed publication, the durable $IRM resume across a crash, the 304 notice.
 *
 * The SAME artifact the Go host would serve runs in the JS flow runtime host; every hostcall is an SDS $PIV invocation
 * answered as the Go node answers it (../../cellular-network-aggregate/tests/typed-host.mjs, shared so both flows read
 * ONE definition of the $IRM they exchange with the store).
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { decodeIngestResult } from "space-data-module-sdk/runtime-contracts";

import {
  DECODER_STATE_FORMAT,
  configHandler,
  createHostStub,
  frames,
  httpAnswer,
  irmRecord,
  isMarkQuery,
  runFlow,
  sds,
  stream,
  streamAnswer,
  tickTrigger,
  unpack,
} from "../../cellular-network-aggregate/tests/typed-host.mjs";

const FLOW_WASM = new URL("../dist/runtime.wasm", import.meta.url);
const SOURCE_URL = "https://example.invalid/opencellid-bulk.csv";

const HEADER = "radio,mcc,net,area,cell,unit,lon,lat,range,samples,changeable,created,updated,averageSignal\n";
// Distinct sites, plus one duplicate of the first so deconfliction has real work: 310/260/40495/17811 appears twice
// and must collapse to ONE site.
const ROWS = [
  "LTE,310,260,40495,17811,0,-73.9857000,40.7484000,450,12,1,1700000000,1710000000,-91",
  "LTE,310,260,40495,17811,0,-73.9857200,40.7484200,460,88,1,1700000000,1710000500,-90",
  "NR,234,15,0,987654321,0,-0.1276000,51.5072000,125,8,1,1700000000,1710000000,-85",
  "GSM,262,1,1234,5678,0,13.4050000,52.5200000,900,42,1,1700000000,1710000000,-95",
  "UMTS,208,10,4321,8765,0,2.3522000,48.8566000,600,21,1,1700000000,1710000000,-88",
];
const BODY = Buffer.from(HEADER + ROWS.join("\n") + "\n", "utf8");

/** The durable store across flow runs: the $IRM buffers storage.write persisted, newest LAST. */
const createStore = () => ({ marks: [] });

function hostFor({ config = {}, body = BODY, ingestResult, store = createStore(), notModified = false } = {}) {
  return createHostStub({
    "plugin.getConfig": configHandler(config),
    "http.request": (c) => {
      if (c.method === "POST") return httpAnswer(202, "");
      // HTTP 304: the host presents the validators it recorded and the origin answers "not modified" with NO body
      if (notModified) return httpAnswer(304, "", { etag: 'W/"bulk-export-v7"' });
      const m = /bytes=(\d+)-(\d+)/.exec(c.headers.range ?? "");
      if (!m) return httpAnswer(200, "");
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), body.length - 1);
      if (start >= body.length) return httpAnswer(416, "", { "content-range": `bytes */${body.length}` });
      return httpAnswer(206, body.subarray(start, end + 1), { "content-range": `bytes ${start}-${end}/${body.length}` });
    },
    "storage.ingest_with_source": (c) => {
      const count = frames(c.raw.records).length;
      const r = ingestResult ? ingestResult(c.params, count) : { INSERTED: count };
      return { result: { SCHEMA: c.params.SCHEMA, BATCH_ID: c.params.BATCH_ID, INSERTED: BigInt(r.INSERTED) } };
    },
    // THE DURABLE MARK, WRITE SIDE: storage.write is schema-typed; the record it files is $IRM.
    "storage.write": (c) => {
      assert.equal(c.params.SCHEMA, "IRM.fbs", "the mark is filed as an $IRM record");
      store.marks.push(Buffer.from(c.raw.data));
      return { result: { CID: `bafyMark${store.marks.length}` } };
    },
    // THE DURABLE MARK, READ SIDE: newest first, as the query's ORDER BY _rowid DESC returns them.
    "storage.flatsql_query_stream": (c) => {
      assert.ok(isMarkQuery(c.sql), `the ingest lane reads only the mark: ${c.sql}`);
      return streamAnswer(store.marks.length ? stream([...store.marks].reverse()) : new Uint8Array(0));
    },
  });
}

const FLOW_NODE_IDS = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../dist/flow.json", import.meta.url)), "utf8")).nodes.map((n) => n.nodeId);
async function runOnce(stub) {
  const { egress, host } = await runFlow(FLOW_WASM, stub, tickTrigger());
  // the NODE RUN DIGEST the Go runner reads after a timer tick (cronmount.go readNodeRunDigest / retrievalDiagnosis)
  const digest = FLOW_NODE_IDS.map((nodeId, index) => {
    const state = host.getNodeState(index);
    return { nodeId, invocations: Number(state.invocationCount), lastStatus: Number(state.lastStatus) };
  });
  return { egress, digest };
}

const httpCalls = (stub) => stub.calls.filter((c) => c.operation === "http.request");
const gets = (stub) => httpCalls(stub).filter((c) => c.method !== "POST");
const ingestCalls = (stub) => stub.calls.filter((c) => c.operation === "storage.ingest_with_source");
const writeCalls = (stub) => stub.calls.filter((c) => c.operation === "storage.write");
const startOfRange = (call) => Number(/bytes=(\d+)-/.exec(call.headers.range)[1]);
const recordCount = (call) => frames(call.raw.records).length;
const marksOn = (egress) => egress.filter((e) => e.type === "$IRM");

test("ranged fetch: the chunk is requested as a Range, sized from node CONFIG", async () => {
  const stub = hostFor({ config: { cell_ingest_url: SOURCE_URL, cell_ingest_chunk_bytes: 256 } });
  await runOnce(stub);
  assert.equal(gets(stub).length, 1, "one tick fetches exactly one chunk");
  assert.equal(gets(stub)[0].url, SOURCE_URL);
  assert.equal(gets(stub)[0].headers.range, "bytes=0-255", "first chunk is [0, chunk-1]");
});

test("chunk size is CLAMPED to the host's 4 MiB response-body cap", async () => {
  const stub = hostFor({ config: { cell_ingest_url: SOURCE_URL, cell_ingest_chunk_bytes: 64 * 1024 * 1024 } });
  await runOnce(stub);
  const end = Number(/bytes=0-(\d+)/.exec(gets(stub)[0].headers.range)[1]);
  assert.equal(end, 4 * 1024 * 1024 - 1, "clamped to exactly 4 MiB, not the configured 64 MiB");
});

test("the whole fixture in one chunk: every distinct site reaches storage", async () => {
  const stub = hostFor({ config: { cell_ingest_url: SOURCE_URL, cell_ingest_chunk_bytes: 65536 } });
  await runOnce(stub);
  assert.equal(ingestCalls(stub).length, 1, "one chunk, one store");
  const sites = frames(ingestCalls(stub)[0].raw.records).map((r) => unpack("TBS", r));
  // 5 rows, two of which are the SAME cell (310/260/40495/17811) -> 4 sites
  assert.equal(sites.length, 4, "duplicate cell collapsed by deconfliction; 4 distinct sites stored");
  assert.ok(sites.every((s) => s.SOURCES.every((p) => p.PROVIDER_ID === "opencellid")));
  assert.ok(sites.every((s) => s.CONSENSUS.METHOD === sds.TBS.tbsMergeMethod.HIGHEST_SAMPLE_COUNT));
});

test("storage attribution: TBS.fbs, reconcile None, one batch id per chunk offset, provenance", async () => {
  const stub = hostFor({ config: { cell_ingest_url: SOURCE_URL, cell_ingest_chunk_bytes: 65536 } });
  await runOnce(stub);
  const { params, lists } = ingestCalls(stub)[0];
  assert.equal(params.SCHEMA, "TBS.fbs");
  assert.equal(params.PROVIDER_ID, "opencellid");
  assert.equal(params.SOURCE_NAME, "cell-tower-bulk");
  assert.equal(params.SOURCE_URL, SOURCE_URL);
  // NOT the celestrak lane's source-batch reconcile, and NOT duplicates (the host's intra-batch dedupe partitions on
  // the satellite index, which a $TBS site populates none of): each batch is one CHUNK of the provider's set.
  assert.equal(params.RECONCILE, 1, "reconcileKind None");
  assert.equal(params.BATCH_ID, "opencellid@0", "batch id keyed by chunk offset");
  assert.equal(lists.provenance.length, 1);
  assert.equal(lists.provenance[0].SOURCE_URL, SOURCE_URL);
  assert.equal(lists.provenance[0].HTTP_STATUS, 206);
  assert.equal(Number(lists.provenance[0].NORMALIZED_COUNT), 4);
});

test("row-boundary correction: the next offset lands on a row start, never mid-row", async () => {
  const chunk = 200;
  const stub = hostFor({ config: { cell_ingest_url: SOURCE_URL, cell_ingest_chunk_bytes: chunk } });
  const { egress } = await runOnce(stub);
  const [mark] = marksOn(egress);
  assert.ok(mark, "publish_request emitted the advanced $IRM mark to egress");
  const next = Number(mark.NEXT_OFFSET);
  const lastNewlineInChunk = BODY.subarray(0, chunk).lastIndexOf(0x0a);
  assert.equal(next, lastNewlineInChunk + 1, "offset is the byte after a newline");
  assert.ok(next < chunk, "corrected backwards from the nominal chunk end");
  assert.equal(BODY[next - 1], 0x0a, "the byte before the resume point IS a newline");
  assert.equal(Number(mark.SOURCE.TOTAL_BYTES), BODY.length, "total taken from Content-Range's denominator");
});

test("publication is fail-closed without a configured URL", async () => {
  const stub = hostFor({ config: { cell_ingest_url: SOURCE_URL, cell_ingest_chunk_bytes: 65536 } });
  await runOnce(stub);
  assert.deepEqual(httpCalls(stub).filter((c) => c.method === "POST"), [], "absence of configuration is not permission to publish");
});

test("publication POSTs an IngestResult naming the batch when a URL IS configured", async () => {
  const publishURL = "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish";
  const stub = hostFor({ config: { cell_ingest_url: SOURCE_URL, cell_ingest_chunk_bytes: 65536, cell_ingest_publish_url: publishURL } });
  await runOnce(stub);
  const posts = httpCalls(stub).filter((c) => c.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, publishURL);
  assert.equal(posts[0].headers["content-type"], "application/octet-stream");
  const body = decodeIngestResult(Uint8Array.from(posts[0].body));
  assert.equal(body.schema, "TBS.fbs");
  assert.equal(body.providerId, "opencellid");
  assert.equal(body.sourceName, "cell-tower-bulk");
  assert.equal(body.batchId, "opencellid@0");
});

test("SILENT NOP: ok-with-inserted-0 stops the run and does NOT advance the mark", async () => {
  const store = createStore();
  const stub = hostFor({ config: { cell_ingest_url: SOURCE_URL, cell_ingest_chunk_bytes: 65536 }, store, ingestResult: () => ({ INSERTED: 0 }) });
  const { egress, digest } = await runOnce(stub);
  assert.deepEqual(marksOn(egress), [], "no mark is emitted, so the next run re-fetches this chunk");
  assert.deepEqual(writeCalls(stub), []);
  assert.deepEqual(store.marks, []);
  const publish = digest.find((n) => n.nodeId === "publish");
  assert.equal(publish.lastStatus, 502, "the refusal is the runner's verdict, not a silent success");
});

// ═══════════════════════════════════════════════════════════════════════════
// THE DURABLE RESUME MARK. "Crash" is total and deliberate: run 2 gets a FRESH flow instance, FRESH guest memory and a
// FRESH host stub; nothing survives between the runs except the record store.
//
// The fixture is a 92-byte header plus 5 rows ending at absolute offsets 176, 260, 340, 419 and 499. 260 lands
// EXACTLY on a row boundary, deliberately: this test is about the RESUME (a mid-row cut drags in the partial-tail
// defect pinned below).
// ═══════════════════════════════════════════════════════════════════════════
const CRASH_CONFIG = { cell_ingest_url: SOURCE_URL, cell_ingest_chunk_bytes: 260, cell_ingest_provider_id: "opencellid" };

test("a multi-chunk ingest CRASHES between chunks and RESUMES from the durable mark with the correct rows", async () => {
  const store = createStore();
  const first = hostFor({ config: CRASH_CONFIG, store });
  await runOnce(first);
  assert.equal(startOfRange(gets(first)[0]), 0, "the first run starts at byte 0");
  assert.equal(writeCalls(first).length, 1, "chunk 0 persists exactly one resume mark");
  const mark0 = unpack("IRM", store.marks[0]);
  assert.equal(mark0.PROVIDER_ID, "opencellid");
  assert.equal(Number(mark0.NEXT_OFFSET), 260);
  assert.equal(mark0.DECODE_CONTEXT.HEADER_LINE, HEADER.trimEnd(), "the CSV header row rides on the mark");
  assert.equal(Number(mark0.RECORDS_COMMITTED), 1);
  assert.equal(recordCount(ingestCalls(first)[0]), 1, "chunk 0's duplicate pair collapses to one site");
  assert.equal(ingestCalls(first)[0].params.BATCH_ID, "opencellid@0");

  // ── THE CRASH. Nothing survives but the store. ──
  const second = hostFor({ config: CRASH_CONFIG, store });
  await runOnce(second);
  const resumeStart = startOfRange(gets(second)[0]);
  assert.equal(resumeStart, 260, "the resumed fetch starts at the end of the last COMPLETE row");
  // THE ROWS ARE CORRECT only because the CSV HEADER rode across on the mark
  assert.equal(recordCount(ingestCalls(second)[0]), 3, "the resumed chunk carries the three remaining distinct sites");
  assert.equal(ingestCalls(second)[0].params.BATCH_ID, `opencellid@${resumeStart}`);
  assert.equal(ingestCalls(second)[0].params.RECONCILE, 1);
  // THE MARK ADVANCED CUMULATIVELY: 1 site from chunk 0 + 3 from chunk 1
  assert.equal(store.marks.length, 2);
  const mark1 = unpack("IRM", store.marks[1]);
  assert.equal(Number(mark1.RECORDS_COMMITTED), 4);
  assert.equal(mark1.NEXT_CHUNK_INDEX, 2);
  assert.equal(mark1.STATE, sds.IRM.irmJobState.COMPLETE, "the source was read to its end");
});

test("a resumed chunk WITHOUT the carried CSV header decodes to nothing - the gap the mark closes", async () => {
  const store = createStore();
  store.marks.push(Buffer.from(irmRecord({
    providerId: "opencellid", sourceUrl: SOURCE_URL, nextOffset: 260, totalBytes: BODY.length,
    nextChunkIndex: 1, recordsCommitted: 1, updatedAt: "2026-08-24T00:00:00Z", headerLine: "",
  })));
  const stub = hostFor({ config: CRASH_CONFIG, store });
  await runOnce(stub);
  assert.equal(startOfRange(gets(stub)[0]), 260, "it still resumes at the recorded offset");
  const stored = ingestCalls(stub).length === 0 ? 0 : recordCount(ingestCalls(stub)[0]);
  assert.equal(stored, 0, "without the carried header the resumed chunk parses to zero rows");
});

test("a durable mark whose decoder-state stamp is unrecognised hands over no decoder state, only its own fields", async () => {
  const store = createStore();
  store.marks.push(Buffer.from(irmRecord({
    providerId: "opencellid", sourceUrl: SOURCE_URL, nextOffset: 260, totalBytes: BODY.length,
    nextChunkIndex: 1, recordsCommitted: 1, updatedAt: "2026-08-24T00:00:00Z", headerLine: HEADER.trimEnd(),
    decoderState: Buffer.from("a foreign decoder image"), decoderStateFormat: "some-other-producer/v9",
  })));
  const stub = hostFor({ config: CRASH_CONFIG, store });
  await runOnce(stub);
  assert.equal(startOfRange(gets(stub)[0]), 260, "the mark's own byte offset is honoured");
  assert.equal(ingestCalls(stub).length, 1, "the run proceeds rather than wedging");
  assert.equal(recordCount(ingestCalls(stub)[0]), 3, "the carried header still applies");
  const next = unpack("IRM", store.marks.at(-1));
  assert.equal(next.DECODE_CONTEXT.DECODER_STATE.length, 0, "the foreign decoder image is not carried forward");
  assert.notEqual(next.DECODE_CONTEXT.DECODER_STATE_FORMAT, "some-other-producer/v9");
  assert.notEqual(DECODER_STATE_FORMAT, "some-other-producer/v9");
});

test("a mark belonging to a DIFFERENT provider is ignored, not resumed into", async () => {
  const store = createStore();
  store.marks.push(Buffer.from(irmRecord({
    providerId: "some-other-registry", sourceUrl: "https://elsewhere.invalid/other.csv", nextOffset: 4096,
    totalBytes: 999999, nextChunkIndex: 7, recordsCommitted: 50000, updatedAt: "2026-08-24T00:00:00Z", headerLine: HEADER.trimEnd(),
  })));
  const stub = hostFor({ config: CRASH_CONFIG, store });
  await runOnce(stub);
  assert.equal(startOfRange(gets(stub)[0]), 0, "a foreign provider's mark must not move this provider's offset");
});

// PINNED DEFECT (unchanged by the typed contracts): ingest_meta's row-boundary correction fixes the next OFFSET, but
// parse has already decoded the chunk, and decode_csv treats the unterminated final line of a mid-row chunk as a row.
// When the cut lands past lat/lon, that partial row is a real site and is STORED; the next chunk re-reads it whole.
// The honest fix needs an END-OF-OBJECT signal parse does not have. Locked here so it cannot drift silently.
test("PINNED DEFECT: a chunk cut mid-row also stores its partial tail row", async () => {
  const store = createStore();
  const stub = hostFor({ config: { ...CRASH_CONFIG, cell_ingest_chunk_bytes: 300 }, store });
  await runOnce(stub);
  assert.equal(recordCount(ingestCalls(stub)[0]), 2, "the duplicate pair as one site, and the TRUNCATED row 2 as a second");
  const second = hostFor({ config: { ...CRASH_CONFIG, cell_ingest_chunk_bytes: 300 }, store });
  await runOnce(second);
  assert.equal(startOfRange(gets(second)[0]), 260, "the resumed fetch re-reads the straddling row from its start");
});

// ═══════════════════════════════════════════════════════════════════════════
// HTTP 304 NOT MODIFIED IS A SUCCESSFUL RUN WITH NOTHING NEW. The verdict asserted is the RUNNER'S OWN, computed as
// sdn-server internal/flowrt/cronmount.go retrievalDiagnosis computes it from the node digest: a node that ran and
// returned non-zero is a REFUSAL. No node may refuse a 304.
// ═══════════════════════════════════════════════════════════════════════════
test("HTTP 304: no node refuses, nothing is stored, the mark does not move, and the notice reaches egress", async () => {
  const store = createStore();
  const stub = hostFor({ config: { cell_ingest_url: SOURCE_URL, cell_ingest_chunk_bytes: 65536 }, store, notModified: true });
  const { egress, digest } = await runOnce(stub);
  assert.deepEqual(digest.filter((n) => n.invocations > 0 && n.lastStatus !== 0), [], "a 304 is not a failed fetch");
  assert.equal(gets(stub).length, 1, "the chunk was still requested");
  assert.deepEqual(ingestCalls(stub), [], "no batch may be stored for a 304");
  assert.deepEqual(writeCalls(stub), [], "the resume mark must not move past bytes never read");
  const notices = egress.filter((e) => e.type === "FNTC");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, "unchanged");
  assert.equal(notices[0].providerId, "opencellid");
  assert.equal(notices[0].sourceName, "cell-tower-bulk");
  assert.deepEqual(notices[0].items, [SOURCE_URL]);
});

test("HTTP 304: the following run re-asks for the same chunk", async () => {
  const store = createStore();
  const config = { cell_ingest_url: SOURCE_URL, cell_ingest_chunk_bytes: 256 };
  const first = hostFor({ config, store, notModified: true });
  await runOnce(first);
  assert.equal(startOfRange(gets(first)[0]), 0);
  const second = hostFor({ config, store });
  await runOnce(second);
  assert.equal(startOfRange(gets(second)[0]), 0, "a 304 leaves the mark where it was");
  assert.equal(ingestCalls(second).length, 1, "and the changed body then lands normally");
});

test("an ingest lane with no source URL fails closed instead of inventing one", async () => {
  const stub = hostFor({ config: {} });
  const { digest } = await runOnce(stub);
  assert.equal(gets(stub).length, 0);
  const plan = digest.find((n) => n.nodeId === "plan");
  assert.equal(plan.lastStatus, 400);
});
