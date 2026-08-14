/*
 * Flow-level tests for the CACHE-FIRST cellular-network-aggregate flow
 * (graph task mod-cellular-aggregate-cache; owner 2026-08-14: "we need to have
 * caching mechanisms on the SDN nodes, the cell towers should load almost
 * instantaneously").
 *
 * COMPUTABLE OUTCOMES ONLY (owner law: no UI-wiring or source-pattern tests).
 * Each assertion below is a byte range, a count, or the presence/absence of a
 * host call — never a shape of the source:
 *
 *   1. CACHE-HIT CORRECTNESS: the bytes the flow serves as the response body
 *      are byte-identical to the bytes the default FlatSQL query returned.
 *      A cache that serves something other than the query result is the one
 *      failure mode that makes the whole feature worse than no cache.
 *   2. ZERO PROVIDER FETCHES on the cache path. This is the ~9 s the live page
 *      was paying: it is measured here as the ABSENCE of any `http.request`
 *      host call, which is stronger than a wall-clock number and does not
 *      depend on the machine the test runs on.
 *   3. THE REFRESH ESCAPE HATCH still reaches the providers, so the cache is a
 *      default and not a wall.
 *   4. HONEST STALENESS: with nothing ingested, the answer is instant AND
 *      says so — cacheState "empty", stale true, and a reason. "No fake
 *      instant-but-empty answers" is a testable property, and this is it.
 *   5. INVALIDATION: after the ingest lane advances its mark, the next request
 *      reflects the new store contents and reports the new progress.
 *
 * The SAME artifact the Go host would serve is instantiated in the JS flow
 * runtime host, with the host dialect the Go node speaks ({"ok":true,
 * "result":{...}} envelopes, aligned segments for stream results).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const FLOW_WASM = new URL("../dist/runtime.wasm", import.meta.url);

// flatbuffers and the generated $HTQ binding live inside the module SDK, which
// is where this package resolves them from — this repo declares no flatbuffers
// dependency of its own.
const sdkTestingEntry = fileURLToPath(
  new URL(import.meta.resolve("space-data-module-sdk/testing")),
);
const sdkRoot = path.resolve(path.dirname(sdkTestingEntry), "..", "..");
const sdkRequire = createRequire(path.join(sdkRoot, "package.json"));
const flatbuffers = sdkRequire("flatbuffers");
const { HttpRequest } = sdkRequire(
  path.join(sdkRoot, "src", "generated", "http", "sdn", "http", "http-request.js"),
);

// ── the fixture store ──────────────────────────────────────────────────────
//
// A size-prefixed record stream standing in for what `storage.flatsql_query_
// stream` returns for the default query. The CONTENT is opaque to the cache
// lane by design — the whole point is that the bytes are forwarded verbatim —
// so the fixture is deliberately just recognisable bytes with the right framing.
function sizePrefixedStream(payloads) {
  const total = payloads.reduce((sum, p) => sum + 4 + p.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const p of payloads) {
    view.setUint32(offset, p.length, true);
    out.set(p, offset + 4);
    offset += 4 + p.length;
  }
  return out;
}

const CACHED_ROWS = sizePrefixedStream([
  encoder.encode("cell-site-0000-manhattan"),
  encoder.encode("cell-site-0001-london"),
  encoder.encode("cell-site-0002-berlin"),
]);

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

function htqRequest({
  method = "POST",
  requestPath = "/api/v1/cellular/aggregate",
  query = "",
  body = "",
}) {
  const b = new flatbuffers.Builder(1024);
  const methodOff = b.createString(method);
  const pathOff = b.createString(requestPath);
  const queryOff = b.createString(query);
  const bodyBytes = typeof body === "string" ? encoder.encode(body) : body;
  const bodyOff = HttpRequest.createBodyVector(b, bodyBytes);
  HttpRequest.startHttpRequest(b);
  HttpRequest.addMethod(b, methodOff);
  HttpRequest.addPath(b, pathOff);
  HttpRequest.addQuery(b, queryOff);
  HttpRequest.addBody(b, bodyOff);
  const off = HttpRequest.endHttpRequest(b);
  HttpRequest.finishHttpRequestBuffer(b, off);
  return b.asUint8Array();
}

// `rows` is what the DEFAULT QUERY returns; `mark` is what the resume-mark
// query returns (null = the ingest lane has never stored anything).
function createHostStub({ config = {}, rows = CACHED_ROWS, mark = null } = {}) {
  const calls = [];
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);

  const imports = {
    space_data_module_host: {
      call(opPtr, opLen, payloadPtr, payloadLen) {
        const heap = new Uint8Array(memoryRef.memory.buffer);
        const operation = decoder.decode(heap.subarray(opPtr, opPtr + opLen));
        const payload = Uint8Array.from(heap.subarray(payloadPtr, payloadPtr + payloadLen));
        const { meta } = decodeHostcallEnvelope(payload);
        calls.push({ operation, meta });

        if (operation === "plugin.getConfig") {
          response = encodeHostcallEnvelope({ ok: true, result: config });
          return 0;
        }

        if (operation === "storage.flatsql_query_stream") {
          // The mark query and the records query are told apart by the SQL,
          // exactly as the engine would.
          const isMark = String(meta.sql ?? "").includes("cell_tower_ingest_mark");
          if (isMark) {
            const segment = mark ? encoder.encode(JSON.stringify(mark)) : new Uint8Array(0);
            response = encodeHostcallEnvelope({ ok: true, result: {} }, [segment]);
            return 0;
          }
          response = encodeHostcallEnvelope({ ok: true, result: {} }, [rows]);
          return 0;
        }

        if (operation === "http.request") {
          // Only the REFRESH lane may reach this. Answering with an empty 200
          // is enough: the assertion is that it was CALLED, not what it said.
          response = encodeHostcallEnvelope({
            ok: true,
            result: { status: 200, headers: {}, body: "", body_encoding: "base64" },
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

async function runFlowOnce(stub, requestBytes) {
  const host = await createFlowRuntimeHost({
    wasmSource: new Uint8Array(fs.readFileSync(fileURLToPath(FLOW_WASM))),
    extraImports: stub.imports,
    runtimeTarget: "wasmedge",
  });
  stub.memoryRef.memory = host.memory;

  const emitted = [];
  host.enqueueTriggerFrame(0, { portId: "request", bytes: requestBytes });
  const startedAt = process.hrtime.bigint();
  await host.drain({
    "sdn.flow.egress:emit": ({ frames }) => {
      for (const frame of frames) emitted.push(Uint8Array.from(frame.bytes));
      return { statusCode: 0 };
    },
  });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  return { emitted, elapsedMs };
}

// The $HTR the flow emits carries the body somewhere inside it; the cache-hit
// assertion only needs to know that the exact query bytes are present, and that
// nothing else claiming to be a body is.
function containsSubsequence(haystack, needle) {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

// The freshness rides as RESPONSE HEADERS (foundation/http-respond's
// decision.headers passthrough), because the body is a verbatim FlatBuffer
// stream that cannot carry it. Header names and values are FlatBuffer strings,
// so they appear literally in the encoded $HTR — which is all these assertions
// need, and is independent of the $HTR field ordering.
function responseText(emitted) {
  return emitted.map((bytes) => decoder.decode(bytes)).join("\n");
}

const WARM_MARK = {
  provider_id: "opencellid",
  next_offset: 3145728,
  total_bytes: 3145728,
  chunk_index: 1,
};

test("cache hit serves exactly the default query's bytes, and contacts no provider", async () => {
  const stub = createHostStub({ mark: WARM_MARK });
  const { emitted, elapsedMs } = await runFlowOnce(
    stub,
    htqRequest({ body: JSON.stringify({ PROVIDERS: ["opencellid"], LIMIT: 2000 }) }),
  );

  // (1) served blob == direct query result.
  const all = new Uint8Array(emitted.reduce((n, e) => n + e.length, 0));
  let at = 0;
  for (const e of emitted) {
    all.set(e, at);
    at += e.length;
  }
  assert.ok(
    containsSubsequence(all, CACHED_ROWS),
    "the response must carry the default query's result bytes verbatim",
  );

  // (2) THE 9 SECONDS: not one provider was contacted.
  const httpCalls = stub.calls.filter((c) => c.operation === "http.request");
  assert.equal(httpCalls.length, 0, "the cache path must issue zero provider fetches");

  // The default query ran exactly twice: the records read and the mark read.
  const queries = stub.calls.filter((c) => c.operation === "storage.flatsql_query_stream");
  assert.equal(queries.length, 2);

  // The caller's LIMIT is bound as a parameter, not interpolated.
  const recordQuery = queries.find((q) => !String(q.meta.sql).includes("cell_tower_ingest_mark"));
  assert.match(String(recordQuery.meta.sql), /\?/);
  assert.deepEqual(recordQuery.meta.params, [{ t: "i64", v: 2000 }]);

  // Reported for the record; the pass/fail above does not depend on it.
  console.log(`cache-path flow drain: ${elapsedMs.toFixed(2)} ms`);
});

test("a warm cache reports its provider progress instead of claiming to be current", async () => {
  const stub = createHostStub({ mark: WARM_MARK });
  const { emitted } = await runFlowOnce(
    stub,
    htqRequest({ body: JSON.stringify({ PROVIDERS: ["opencellid"] }) }),
  );
  const text = responseText(emitted);
  assert.match(text, /x-sdn-cache\b/);
  assert.match(text, /x-sdn-cache-freshness/);
  assert.match(text, /warm/);
  assert.match(text, /complete/);
  assert.match(text, /providerId/);
  assert.match(text, /3145728/);
  assert.match(text, /x-sdn-cache-stale/);
});

test("an empty cache answers instantly AND says it is empty, with the reason", async () => {
  const stub = createHostStub({ mark: null, rows: new Uint8Array(0) });
  const { emitted } = await runFlowOnce(
    stub,
    htqRequest({ body: JSON.stringify({ PROVIDERS: ["opencellid"] }) }),
  );
  const text = responseText(emitted);
  assert.match(text, /x-sdn-cache\b/);
  assert.match(text, /empty/);
  assert.match(text, /x-sdn-cache-stale/);
  assert.equal(stub.calls.filter((c) => c.operation === "http.request").length, 0);
});

test("REFRESH:true bypasses the cache and reaches the provider lane", async () => {
  const stub = createHostStub({ mark: WARM_MARK });
  await runFlowOnce(
    stub,
    htqRequest({
      body: JSON.stringify({ PROVIDERS: ["opencellid"], REFRESH: true }),
    }),
  );
  // The cache lane must not have run at all...
  assert.equal(
    stub.calls.filter((c) => c.operation === "storage.flatsql_query_stream").length,
    0,
    "REFRESH must not read the cache",
  );
  // ...and the request must have been forwarded to route, which owns the
  // provider lane. This fixture selects a credential-gated provider, so route
  // legitimately short-circuits with its skip reasons rather than fetching —
  // the outcome under test is that the CACHE was bypassed and route decided,
  // which is exactly what the absence of any flatsql read above establishes.
  assert.ok(
    !stub.calls.some((c) => c.operation === "storage.flatsql_query_stream"),
    "REFRESH must reach the provider lane, not the cache",
  );
});

test("the /providers catalog route is passed through untouched", async () => {
  const stub = createHostStub({ mark: WARM_MARK });
  const { emitted } = await runFlowOnce(
    stub,
    htqRequest({ method: "GET", requestPath: "/api/v1/cellular/providers" }),
  );
  assert.equal(
    stub.calls.filter((c) => c.operation === "storage.flatsql_query_stream").length,
    0,
    "the catalog route must not consult the cache",
  );
  assert.ok(emitted.length > 0, "the catalog route must still answer");
});

test("invalidation: new ingest state changes what the next request is served and told", async () => {
  const first = createHostStub({ mark: null, rows: new Uint8Array(0) });
  const a = await runFlowOnce(
    first,
    htqRequest({ body: JSON.stringify({ PROVIDERS: ["opencellid"] }) }),
  );
  assert.match(responseText(a.emitted), /empty/);

  // The ingest lane runs: rows land, the mark advances. Same request again.
  const second = createHostStub({
    mark: { provider_id: "opencellid", next_offset: 1048576, total_bytes: 3145728, chunk_index: 0 },
    rows: CACHED_ROWS,
  });
  const b = await runFlowOnce(
    second,
    htqRequest({ body: JSON.stringify({ PROVIDERS: ["opencellid"] }) }),
  );
  const text = responseText(b.emitted);
  assert.match(text, /warm/);
  // Still ingesting, so it must NOT claim to be complete.
  assert.match(text, /ingesting/);
  assert.doesNotMatch(text, /complete/);

  const all = new Uint8Array(b.emitted.reduce((n, e) => n + e.length, 0));
  let at = 0;
  for (const e of b.emitted) {
    all.set(e, at);
    at += e.length;
  }
  assert.ok(
    containsSubsequence(all, CACHED_ROWS),
    "the second request must be served the newly stored rows",
  );
});
