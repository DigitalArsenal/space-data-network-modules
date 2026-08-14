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
 *   - reconcile=append and one batch id per chunk,
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
function createHostStub({ config = {}, body = BODY, ingestResult } = {}) {
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
  return { calls, imports, memoryRef };
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

test("storage attribution: $TBS, append reconcile, one batch id per chunk offset", async () => {
  const stub = createHostStub({
    config: { cell_ingest_url: SOURCE_URL, cell_ingest_chunk_bytes: 65536 },
  });
  await runFlowOnce(stub);

  const meta = ingestCalls(stub)[0].meta;
  assert.equal(meta.schema, "TBS");
  assert.equal(meta.provider_id, "opencellid");
  assert.equal(meta.source_url, SOURCE_URL);
  // NOT the celestrak lane's source-batch reconcile: each batch is one CHUNK of
  // the provider's set, and reconciling would delete every earlier chunk.
  assert.equal(meta.reconcile, "append");
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
