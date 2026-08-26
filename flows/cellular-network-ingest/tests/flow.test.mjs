/*
 * Flow-level tests for the compiled cellular-network-ingest flow.
 *
 * These assert COMPUTABLE OUTCOMES only (owner law: no UI-wiring or
 * source-pattern tests). Every assertion here is a number or a byte range that
 * must hold for the ingest to be correct:
 *
 *   - the Range header arithmetic across chunks,
 *   - the 4 MiB clamp that the Go host's response-body cap imposes,
 *   - the row-boundary correction (a chunk ends mid-row; the next must not),
 *   - the record counts that actually reached storage.ingest_with_source,
 *   - reconcile=none and one batch id per chunk,
 *   - the inserted=0 refusal,
 *   - fail-closed publication.
 *
 * The SAME artifact the Go host would serve is instantiated in the JS flow
 * runtime host, with the host dialect the Go node speaks (base64 bodies,
 * {"ok":true,"result":{...}} envelopes).
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";

// The $IRM fixture builder lives beside the aggregate flow's tests; it is
// shared rather than duplicated so both flows exercise ONE definition of the
// record they both read.
import { irmRecord } from "../../cellular-network-aggregate/tests/irm-fixture.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const FLOW_WASM = new URL("../dist/runtime.wasm", import.meta.url);
const SOURCE_URL = "https://example.invalid/opencellid-bulk.csv";

const HEADER =
  "radio,mcc,net,area,cell,unit,lon,lat,range,samples,changeable,created,updated,averageSignal\n";

// Distinct sites, plus one duplicate of the first so deconfliction has real
// work: 310/260/40495/17811 appears twice and must collapse to ONE site.
const ROWS = [
  "LTE,310,260,40495,17811,0,-73.9857000,40.7484000,450,12,1,1700000000,1710000000,-91",
  "LTE,310,260,40495,17811,0,-73.9857200,40.7484200,460,88,1,1700000000,1710000500,-90",
  "NR,234,15,0,987654321,0,-0.1276000,51.5072000,125,8,1,1700000000,1710000000,-85",
  "GSM,262,1,1234,5678,0,13.4050000,52.5200000,900,42,1,1700000000,1710000000,-95",
  "UMTS,208,10,4321,8765,0,2.3522000,48.8566000,600,21,1,1700000000,1710000000,-88",
];
const BODY = Buffer.from(HEADER + ROWS.join("\n") + "\n", "utf8");

function encodeHostcallEnvelope(meta, segments = []) {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const total =
    4 + metaBytes.length + 4 + segments.reduce((sum, s) => sum + 4 + s.length, 0);
  const envelope = new Uint8Array(total);
  const view = new DataView(envelope.buffer);
  let offset = 0;
  view.setUint32(offset, metaBytes.length, true);
  envelope.set(metaBytes, offset + 4);
  offset += 4 + metaBytes.length;
  view.setUint32(offset, segments.length, true);
  offset += 4;
  for (const segment of segments) {
    view.setUint32(offset, segment.length, true);
    envelope.set(segment, offset + 4);
    offset += 4 + segment.length;
  }
  return envelope;
}

function decodeHostcallEnvelope(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const metaLen = view.getUint32(offset, true);
  offset += 4;
  const meta = JSON.parse(decoder.decode(bytes.subarray(offset, offset + metaLen)));
  offset += metaLen;
  const segmentCount = view.getUint32(offset, true);
  offset += 4;
  const segments = [];
  for (let i = 0; i < segmentCount; i++) {
    const segmentLen = view.getUint32(offset, true);
    offset += 4;
    segments.push(Uint8Array.from(bytes.subarray(offset, offset + segmentLen)));
    offset += segmentLen;
  }
  return { meta, segments };
}

// Serves the fixture as a real ranged origin: it honours the Range header,
// answers 206 with a truthful Content-Range, and refuses an unsatisfiable range
// with 416 — the three behaviours the chunking depends on.
// THE DURABLE STORE, standing in for the node's record store across flow runs.
// `marks` holds the $IRM buffers storage.write persisted, newest LAST; the
// flatsql read hands them back newest FIRST, which is what the real query's
// `ORDER BY rowid DESC` does.
export function createStore() {
  return { marks: [] };
}

function sizePrefixedStream(buffers) {
  const total = buffers.reduce((sum, b) => sum + 4 + b.length, 0);
  const out = Buffer.alloc(total);
  let offset = 0;
  for (const b of buffers) {
    out.writeUInt32LE(b.length, offset);
    Buffer.from(b).copy(out, offset + 4);
    offset += 4 + b.length;
  }
  return out;
}

function createHostStub({ config = {}, body = BODY, ingestResult, store = createStore() } = {}) {
  const calls = [];
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);

  const imports = {
    space_data_module_host: {
      call(opPtr, opLen, payloadPtr, payloadLen) {
        const heap = new Uint8Array(memoryRef.memory.buffer);
        const operation = decoder.decode(heap.subarray(opPtr, opPtr + opLen));
        const payload = Uint8Array.from(heap.subarray(payloadPtr, payloadPtr + payloadLen));
        const { meta, segments } = decodeHostcallEnvelope(payload);
        calls.push({ operation, meta, segments });

        if (operation === "plugin.getConfig") {
          response = encodeHostcallEnvelope({ ok: true, result: config });
          return 0;
        }

        if (operation === "http.request") {
          const range = meta.headers?.Range ?? meta.headers?.range;
          if (!range) {
            response = encodeHostcallEnvelope({
              ok: true,
              result: { status: 200, headers: {}, body: "", body_encoding: "base64" },
            });
            return 0;
          }
          const m = /bytes=(\d+)-(\d+)/.exec(range);
          const start = Number(m[1]);
          const end = Math.min(Number(m[2]), body.length - 1);
          if (start >= body.length) {
            response = encodeHostcallEnvelope({
              ok: true,
              result: {
                status: 416,
                headers: { "content-range": `bytes */${body.length}` },
                body: "",
                body_encoding: "base64",
              },
            });
            return 0;
          }
          response = encodeHostcallEnvelope({
            ok: true,
            result: {
              status: 206,
              headers: { "content-range": `bytes ${start}-${end}/${body.length}` },
              body: body.subarray(start, end + 1).toString("base64"),
              body_encoding: "base64",
            },
          });
          return 0;
        }

        if (operation === "storage.ingest_with_source") {
          const recordsRef = meta.records?.$bin ?? 0;
          const records = Buffer.from(segments[recordsRef]);
          let count = 0;
          for (let off = 0; off + 4 <= records.length; ) {
            const len = records.readUInt32LE(off);
            off += 4 + len;
            count++;
          }
          response = encodeHostcallEnvelope({
            ok: true,
            result: ingestResult
              ? ingestResult(meta, count)
              : { schema: meta.schema, inserted: count, batch_id: meta.batch_id },
          });
          return 0;
        }

        // THE DURABLE MARK, WRITE SIDE. storage.write is schema-typed; the
        // record it files is $IRM, minted and ratified by Themis in
        // spacedatastandards.org 1.196.0. This is the gap the ingest flow
        // recorded and could not close before that standard existed.
        if (operation === "storage.write") {
          // THE STUB REFUSES WHAT THE REAL HOST REFUSES. The Go node reads
          // `schema` (internal/modulert/caps/storage.go) and answers
          // {"ok":false,"error":{"message":"missing schema"}} without it. This
          // stub used to accept anything, so the module could send `type`
          // forever and every test agreed while the live node refused every
          // single mark write (graph: sdn-cellular-ingest-lands-no-batch).
          if (!meta.schema) {
            response = encodeHostcallEnvelope({
              ok: false,
              error: { message: "missing schema" },
            });
            return 0;
          }
          store.marks.push(Buffer.from(String(meta.data ?? ""), "base64"));
          response = encodeHostcallEnvelope({
            ok: true,
            result: { cid: `bafyMark${store.marks.length}`, source: meta.source, schema: meta.schema },
          });
          return 0;
        }

        // THE DURABLE MARK, READ SIDE. Newest first, exactly as the query's
        // ORDER BY rowid DESC returns them.
        if (operation === "storage.flatsql_query_stream") {
          const newestFirst = [...store.marks].reverse();
          response = encodeHostcallEnvelope({ ok: true, result: {} }, [
            newestFirst.length ? sizePrefixedStream(newestFirst) : new Uint8Array(0),
          ]);
          return 0;
        }

        response = encodeHostcallEnvelope({ ok: false, message: `unexpected op ${operation}` });
        return 1;
      },
      response_len() {
        return response.length;
      },
      read_response(dstPtr, dstLen) {
        const heap = new Uint8Array(memoryRef.memory.buffer);
        const length = Math.min(dstLen, response.length);
        heap.set(response.subarray(0, length), dstPtr);
        return length;
      },
    },
  };
  return { calls, imports, memoryRef, store };
}

async function runFlowOnce(stub) {
  const host = await createFlowRuntimeHost({
    wasmSource: new Uint8Array(fs.readFileSync(fileURLToPath(FLOW_WASM))),
    extraImports: stub.imports,
    runtimeTarget: "wasmedge",
  });
  stub.memoryRef.memory = host.memory;

  const emitted = [];
  host.enqueueTriggerFrame(0, {
    portId: "tick",
    bytes: encoder.encode(JSON.stringify({ firedAt: "2026-08-14T00:00:00Z" })),
  });
  await host.drain({
    "sdn.flow.egress:emit": ({ frames }) => {
      for (const frame of frames) emitted.push(decoder.decode(frame.bytes));
      return { statusCode: 0 };
    },
  });
  return emitted;
}

const httpCalls = (stub) => stub.calls.filter((c) => c.operation === "http.request");
const ingestCalls = (stub) =>
  stub.calls.filter((c) => c.operation === "storage.ingest_with_source");
const rangeOf = (call) => call.meta.headers?.Range ?? call.meta.headers?.range;
const writeCalls = (stub) => stub.calls.filter((c) => c.operation === "storage.write");
const startOfRange = (call) => Number(/bytes=(\d+)-/.exec(rangeOf(call))[1]);
const recordCount = (call) => {
  const records = Buffer.from(call.segments[call.meta.records?.$bin ?? 0]);
  let count = 0;
  for (let off = 0; off + 4 <= records.length; ) {
    off += 4 + records.readUInt32LE(off);
    count++;
  }
  return count;
};

test("ranged fetch: the chunk is requested as a Range, sized from node CONFIG", async () => {
  const stub = createHostStub({
    config: { cell_ingest_url: SOURCE_URL, cell_ingest_chunk_bytes: 256 },
  });
  await runFlowOnce(stub);

  const fetches = httpCalls(stub);
  assert.equal(fetches.length, 1, "one tick fetches exactly one chunk");
  assert.equal(fetches[0].meta.url, SOURCE_URL);
  assert.equal(rangeOf(fetches[0]), "bytes=0-255", "first chunk is [0, chunk-1]");
});

test("chunk size is CLAMPED to the host's 4 MiB response-body cap", async () => {
  // A larger ask would be truncated by the Go host and parse to a short row set
  // with no error anywhere, so the guest refuses to make it.
  const stub = createHostStub({
    config: { cell_ingest_url: SOURCE_URL, cell_ingest_chunk_bytes: 64 * 1024 * 1024 },
  });
  await runFlowOnce(stub);

  const range = rangeOf(httpCalls(stub)[0]);
  const end = Number(/bytes=0-(\d+)/.exec(range)[1]);
  assert.equal(end, 4 * 1024 * 1024 - 1, "clamped to exactly 4 MiB, not the configured 64 MiB");
});

test("the whole fixture in one chunk: every distinct site reaches storage", async () => {
  const stub = createHostStub({
    config: { cell_ingest_url: SOURCE_URL, cell_ingest_chunk_bytes: 65536 },
  });
  await runFlowOnce(stub);

  const stores = ingestCalls(stub);
  assert.equal(stores.length, 1, "one chunk, one store");

  const recordsRef = stores[0].meta.records?.$bin ?? 0;
  const records = Buffer.from(stores[0].segments[recordsRef]);
  let stored = 0;
  for (let off = 0; off + 4 <= records.length; ) {
    stored += 1;
    off += 4 + records.readUInt32LE(off);
  }
  // 5 rows, two of which are the SAME cell (310/260/40495/17811) -> 4 sites.
  assert.equal(stored, 4, "duplicate cell collapsed by deconfliction; 4 distinct sites stored");
});

test("storage attribution: $TBS, non-destructive reconcile, one batch id per chunk offset", async () => {
  const stub = createHostStub({
    config: { cell_ingest_url: SOURCE_URL, cell_ingest_chunk_bytes: 65536 },
  });
  await runFlowOnce(stub);

  const meta = ingestCalls(stub)[0].meta;
  assert.equal(meta.schema, "TBS");
  assert.equal(meta.provider_id, "opencellid");
  assert.equal(meta.source_url, SOURCE_URL);
  // A MODE THE HOST ACTUALLY HAS. This pinned "append", which
  // storage.ingest_with_source has never accepted (none|duplicates|current), so
  // the test agreed with the module while the host refused every chunk (graph:
  // sdn-cellular-ingest-lands-no-batch). `none` is the mode that means what
  // "append" was reaching for; `duplicates` is worse than wrong here, because
  // the host's intra-batch dedupe partitions on the satellite index and a $TBS
  // site populates none of it — six distinct sites collapse to one.
  // NOT the celestrak lane's source-batch reconcile: each batch is one CHUNK of
  // the provider's set, and reconciling would delete every earlier chunk.
  assert.equal(meta.reconcile, "none");
  assert.equal(meta.batch_id, "opencellid@0", "batch id keyed by chunk offset");
});

test("row-boundary correction: the next offset lands on a row start, never mid-row", async () => {
  // A 200-byte chunk ends inside a row. The advanced mark must point at the byte
  // after the last COMPLETE row, or the straddling row is silently dropped.
  const chunk = 200;
  const stub = createHostStub({
    config: { cell_ingest_url: SOURCE_URL, cell_ingest_chunk_bytes: chunk },
  });
  const emitted = await runFlowOnce(stub);

  const mark = emitted.map((t) => { try { return JSON.parse(t); } catch { return null; } })
    .find((v) => v && typeof v.next_offset === "number");
  assert.ok(mark, "publish_request emitted the advanced mark");

  const lastNewlineInChunk = BODY.subarray(0, chunk).lastIndexOf(0x0a);
  assert.equal(mark.next_offset, lastNewlineInChunk + 1, "offset is the byte after a newline");
  assert.ok(mark.next_offset < chunk, "corrected backwards from the nominal chunk end");
  assert.equal(BODY[mark.next_offset - 1], 0x0a, "the byte before the resume point IS a newline");
  assert.equal(mark.total_bytes, BODY.length, "total taken from Content-Range's denominator");
});

test("publication is fail-closed without a configured URL", async () => {
  const stub = createHostStub({
    config: { cell_ingest_url: SOURCE_URL, cell_ingest_chunk_bytes: 65536 },
  });
  await runFlowOnce(stub);

  const posts = httpCalls(stub).filter((c) => c.meta.method === "POST");
  assert.deepEqual(posts, [], "absence of configuration is not permission to publish");
});

test("publication POSTs the batch identity when a URL IS configured", async () => {
  const publishURL = "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish";
  const stub = createHostStub({
    config: {
      cell_ingest_url: SOURCE_URL,
      cell_ingest_chunk_bytes: 65536,
      cell_ingest_publish_url: publishURL,
    },
  });
  await runFlowOnce(stub);

  const posts = httpCalls(stub).filter((c) => c.meta.method === "POST");
  assert.equal(posts.length, 1);
  const bodyRef = posts[0].meta.body?.$bin ?? 0;
  const body = JSON.parse(Buffer.from(posts[0].segments[bodyRef]).toString("utf8"));
  assert.equal(body.schema, "TBS");
  assert.equal(body.providerId, "opencellid");
  assert.equal(body.batchId, "opencellid@0");
});

test("SILENT NOP: ok-with-inserted-0 stops the run and does NOT advance the mark", async () => {
  // The disk-floor refusal that hostcap/storage-ingest's ok:false check does not
  // catch. Byte-identical to a healthy empty tail, so it is only detectable
  // against the count the chunk actually produced.
  const stub = createHostStub({
    config: { cell_ingest_url: SOURCE_URL, cell_ingest_chunk_bytes: 65536 },
    ingestResult: (meta) => ({ schema: meta.schema, inserted: 0, batch_id: meta.batch_id }),
  });
  const emitted = await runFlowOnce(stub);

  const marks = emitted
    .map((t) => { try { return JSON.parse(t); } catch { return null; } })
    .filter((v) => v && typeof v.next_offset === "number");
  assert.deepEqual(marks, [], "no mark is emitted, so the next run re-fetches this chunk");
});

// ═══════════════════════════════════════════════════════════════════════════
// THE DURABLE RESUME MARK (graph tasks mod-cell-tower-ingest-flow "THE ONE REAL
// GAP" + "Second gap"; sds-ingest-resume-mark-record).
//
// The flow shipped with the mark landing on EGRESS and nowhere else, because
// `storage.write` is schema-typed and the record it needed did not exist.
// Themis minted and ratified $IRM in spacedatastandards.org 1.196.0, so the
// loop closes — and the acceptance the task named is exactly this: a
// multi-chunk ingest that CRASHES between chunks and RESUMES from the durable
// mark with the correct rows.
//
// "Crash" here is total and deliberate: run 2 gets a FRESH flow instance with
// FRESH guest memory and a FRESH host stub. Nothing survives between the runs
// except the record store. If the mark were not durable, run 2 would restart at
// byte 0 — which is the behaviour this test would have measured before today.
// ═══════════════════════════════════════════════════════════════════════════

// The fixture is a 92-byte header plus 5 rows, ending at absolute offsets
// 176, 260, 340, 419 and 499. A 300-byte chunk therefore ends INSIDE row 2, so
// the row-boundary correction has real work: the mark must name 260 — the end
// of the last COMPLETE row — and not 300. A mark of 300 would resume mid-row
// and the straddling row would be dropped by the decoder's own field guards,
// silently, because a short row is indistinguishable from a malformed one.
// The fixture is a 92-byte header plus 5 rows, ending at absolute offsets
// 176, 260, 340, 419 and 499. 260 lands EXACTLY on a row boundary, and that is
// deliberate here: this test is about the RESUME, and a mid-row cut would drag
// in the separate partial-tail defect pinned below. The row-boundary
// correction itself already has its own test above.
const CRASH_CHUNK_BYTES = 260;
const LAST_COMPLETE_ROW_END = 260;
const CRASH_CONFIG = {
  cell_ingest_url: SOURCE_URL,
  cell_ingest_chunk_bytes: CRASH_CHUNK_BYTES,
  cell_ingest_provider_id: "opencellid",
};

test("a multi-chunk ingest CRASHES between chunks and RESUMES from the durable mark with the correct rows", async () => {
  const store = createStore();

  // ── chunk 0 ──────────────────────────────────────────────────────────────
  const first = createHostStub({ config: CRASH_CONFIG, store });
  await runFlowOnce(first);

  assert.equal(startOfRange(httpCalls(first)[0]), 0, "the first run starts at byte 0");

  // THE MARK IS DURABLE: a schema-typed $IRM record went through storage.write.
  const firstWrites = writeCalls(first);
  assert.equal(firstWrites.length, 1, "chunk 0 must persist exactly one resume mark");
  // `schema`, not `type`: storage.write {schema, data:base64} is the hostcall
  // every host implements. The module sent `type`, so the Go node saw an empty
  // schema and refused every mark write — this assertion agreed with the module
  // and not with the host (graph: sdn-cellular-ingest-lands-no-batch).
  assert.equal(firstWrites[0].meta.schema, "IRM", "the mark is filed as an $IRM record");
  assert.equal(firstWrites[0].meta.source, "opencellid");
  const markBytes = Buffer.from(String(firstWrites[0].meta.data), "base64");
  assert.equal(
    markBytes.subarray(4, 8).toString("latin1"),
    "$IRM",
    "the persisted bytes are a real $IRM buffer, identified as one",
  );
  assert.equal(store.marks.length, 1);

  // Chunk 0 carried the duplicate pair (310/260/40495/17811 twice), which
  // deconfliction collapses to ONE site.
  const firstIngests = ingestCalls(first);
  assert.equal(firstIngests.length, 1);
  assert.equal(recordCount(firstIngests[0]), 1, "chunk 0's duplicate pair collapses to one site");
  assert.equal(firstIngests[0].meta.batch_id, "opencellid@0");

  // ── THE CRASH. Nothing survives but the store. ───────────────────────────
  const second = createHostStub({ config: CRASH_CONFIG, store });
  await runFlowOnce(second);

  // (1) IT RESUMED. The second run's Range starts where the first run's LAST
  // COMPLETE ROW ended (251), not at 0 and not at the nominal chunk end (260).
  // Starting at 260 would begin mid-row and silently drop the row that straddles
  // the boundary; starting at 0 would re-ingest chunk 0 forever.
  const resumeStart = startOfRange(httpCalls(second)[0]);
  assert.equal(
    resumeStart,
    LAST_COMPLETE_ROW_END,
    `the resumed fetch must start at the end of the last COMPLETE row (not the nominal chunk end ${CRASH_CHUNK_BYTES}), got ${resumeStart}`,
  );

  // (2) THE ROWS ARE CORRECT, which is only possible because the CSV HEADER
  // rode across on the mark. Chunk 1 carries the remaining three distinct sites
  // (London, Berlin, Paris). Without the carried header this decoder eats its
  // own first data row as the column contract and emits NOTHING — a headerless
  // chunk is byte-for-byte indistinguishable from a clean tail, which is the
  // task's "Second gap".
  const secondIngests = ingestCalls(second);
  assert.equal(secondIngests.length, 1, "the resumed chunk must reach storage");
  assert.equal(
    recordCount(secondIngests[0]),
    3,
    "the resumed chunk carries the three remaining distinct sites",
  );

  // (3) NO GAP AND NO OVERLAP: a new batch keyed by this chunk's offset, so the
  // a non-destructive reconcile cannot delete chunk 0's batch.
  assert.equal(secondIngests[0].meta.batch_id, `opencellid@${resumeStart}`);
  assert.notEqual(secondIngests[0].meta.batch_id, firstIngests[0].meta.batch_id);
  assert.equal(secondIngests[0].meta.reconcile, "none");

  // (4) THE MARK ADVANCED CUMULATIVELY. 1 site from chunk 0 + 3 from chunk 1.
  assert.equal(store.marks.length, 2, "the resumed chunk persists its own mark");
  const finalMark = store.marks[store.marks.length - 1];
  assert.equal(finalMark.subarray(4, 8).toString("latin1"), "$IRM");
});

test("a resumed chunk WITHOUT the carried CSV header decodes to nothing — the gap the mark closes", async () => {
  // The negative control for assertion (2) above. Same resumed byte offset, same
  // body, same everything — except the durable mark carries NO header line. If
  // this run stored rows, the header would not be what makes the resume work and
  // the assertion above would be proving nothing.
  const store = createStore();
  store.marks.push(
    Buffer.from(
      irmRecord({
        providerId: "opencellid",
        sourceUrl: SOURCE_URL,
        nextOffset: 260,
        totalBytes: BODY.length,
        nextChunkIndex: 1,
        recordsCommitted: 1,
        updatedAt: "2026-08-24T00:00:00Z",
        headerLine: "",
      }),
    ),
  );

  const stub = createHostStub({ config: CRASH_CONFIG, store });
  await runFlowOnce(stub);

  assert.equal(startOfRange(httpCalls(stub)[0]), 260, "it still resumes at the recorded offset");
  const ingests = ingestCalls(stub);
  const stored = ingests.length === 0 ? 0 : recordCount(ingests[0]);
  assert.equal(
    stored,
    0,
    "without the carried header the resumed chunk parses to zero rows — and looks exactly like a clean tail",
  );
});

test("a durable mark whose decoder-state stamp is unrecognised RESTARTS rather than resuming into nonsense", async () => {
  // A mark written by some other build, or by a future one. Resuming a deflate
  // decoder from a foreign blob does not fail loudly: it produces bytes that
  // parse and store. So an unrecognised stamp is discarded and the decode
  // context is simply not handed over.
  const store = createStore();
  store.marks.push(
    Buffer.from(
      irmRecord({
        providerId: "opencellid",
        sourceUrl: SOURCE_URL,
        nextOffset: 260,
        totalBytes: BODY.length,
        nextChunkIndex: 1,
        recordsCommitted: 1,
        updatedAt: "2026-08-24T00:00:00Z",
        headerLine: HEADER.trimEnd(),
        decoderState: '{"next_byte":999999,"header_done":true,"decoder":"Zm9yZWlnbg=="}',
        decoderStateFormat: "some-other-producer/v9",
      }),
    ),
  );

  const stub = createHostStub({ config: CRASH_CONFIG, store });
  await runFlowOnce(stub);

  // The byte offset is the mark's own and is still honoured — that field is
  // this flow's, not the decoder's. What must NOT ride along is the foreign
  // decoder state.
  assert.equal(startOfRange(httpCalls(stub)[0]), 260);
  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 1, "the run proceeds rather than wedging");
  assert.equal(
    recordCount(ingests[0]),
    3,
    "the carried header still applies; only the unrecognised decoder state is discarded",
  );
});

test("a mark belonging to a DIFFERENT provider is ignored, not resumed into", async () => {
  const store = createStore();
  store.marks.push(
    Buffer.from(
      irmRecord({
        providerId: "some-other-registry",
        sourceUrl: "https://elsewhere.invalid/other.csv",
        nextOffset: 4096,
        totalBytes: 999999,
        nextChunkIndex: 7,
        recordsCommitted: 50000,
        updatedAt: "2026-08-24T00:00:00Z",
        headerLine: HEADER.trimEnd(),
      }),
    ),
  );

  const stub = createHostStub({ config: CRASH_CONFIG, store });
  await runFlowOnce(stub);

  // Resuming provider A at provider B's offset skips the head of B's file and
  // never reports it. This run must start at 0.
  assert.equal(
    startOfRange(httpCalls(stub)[0]),
    0,
    "a foreign provider's mark must not move this provider's offset",
  );
});

// ── PINNED DEFECT: a ranged chunk's UNTERMINATED TAIL ROW is stored ─────────
//
// Found while building the resume acceptance above, and pinned rather than
// papered over. `ingest_meta`'s row-boundary correction fixes the next OFFSET
// (so the straddling row is re-fetched whole and no data is lost), but it runs
// AFTER `parse` has already decoded the chunk — and `decode_csv` treats the
// unterminated final line of a mid-row chunk as a row. When the truncation
// happens to land past `lat`/`lon`, that partial row parses to a real site with
// its trailing fields empty, and it is STORED.
//
// Consequence: one physical site can reach the store twice, in two different
// batches (the partial from chunk N, the whole row from chunk N+1). The
// a non-destructive reconcile is correct to keep both — it cannot know they are the same
// — so the duplicate survives, and a duplicated site set is indistinguishable
// from a larger one, which is exactly the failure mode the deconfliction rules
// exist to prevent.
//
// NOT fixed here, and the reason is recorded: the honest fix is for `parse` to
// drop an unterminated tail on a chunked lane, which needs an END-OF-OBJECT
// signal it does not have — a file whose LAST row legitimately has no trailing
// newline would otherwise lose that row, and the offset correction would then
// stall the run instead of finishing it. Designing that signal is a separate
// change from closing the durable mark. This test locks the current behaviour
// down so it cannot drift silently while that work is scheduled.
test("PINNED DEFECT: a chunk cut mid-row also stores its partial tail row", async () => {
  const store = createStore();
  const stub = createHostStub({
    // 300 cuts inside row 2 (which spans 260..339).
    config: { ...CRASH_CONFIG, cell_ingest_chunk_bytes: 300 },
    store,
  });
  await runFlowOnce(stub);

  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 1);
  assert.equal(
    recordCount(ingests[0]),
    2,
    "the duplicate pair collapses to one site, and the TRUNCATED row 2 is stored as a second — " +
      "this is the pinned defect, not the intended behaviour",
  );

  // The offset correction is still right: the next fetch re-reads row 2 WHOLE,
  // so nothing is lost. The defect is the surplus partial, never a gap.
  const markBytes = Buffer.from(String(writeCalls(stub)[0].meta.data), "base64");
  assert.equal(markBytes.subarray(4, 8).toString("latin1"), "$IRM");
  const second = createHostStub({ config: { ...CRASH_CONFIG, cell_ingest_chunk_bytes: 300 }, store });
  await runFlowOnce(second);
  assert.equal(
    startOfRange(httpCalls(second)[0]),
    260,
    "the resumed fetch re-reads the straddling row from its start — no data is lost",
  );
});
