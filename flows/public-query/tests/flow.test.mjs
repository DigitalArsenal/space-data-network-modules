/*
 * Flow-level tests for the compiled public-query flow (gateway loop G.5) —
 * BRIDGE mode. The SAME artifact the Go host mounts at /api/v1/query is
 * instantiated in the JS flow runtime host (browser parity): a $HTQ
 * HttpRequest enters the route_public_query node, the route ->
 * flatsql-query sandbox_query -> (omm-json) -> http-respond chain runs
 * linked-direct inside the artifact's linear memory, and the ONLY host
 * crossings are the declared storage_query hostcalls
 * (storage.query_sandboxed / storage.query_surface) plus clock.now for
 * default profile epochs — stubbed with the Go-host response dialect.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";
import { decodeHttpResponse, encodeHttpRequest, fnv1a64Hex } from "space-data-module-sdk/http";

import * as flatbuffers from "../../../../spacedatastandards.org/node_modules/flatbuffers/mjs/flatbuffers.js";
import { OMM } from "../../../../spacedatastandards.org/lib/js/OMM/main.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const QUERY_WASM = new URL("../dist/query/runtime.wasm", import.meta.url);

// ---------------------------------------------------------------------------
// Hostcall wire helpers (Go-host dialect).
// ---------------------------------------------------------------------------

function encodeHostcallEnvelope(meta, segments = []) {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const total = 4 + metaBytes.length + 4 + segments.reduce((sum, seg) => sum + 4 + seg.length, 0);
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
  const metaLen = view.getUint32(0, true);
  const meta = JSON.parse(decoder.decode(bytes.subarray(4, 4 + metaLen)));
  return { meta };
}

// Go json.Marshal emits map keys ALPHABETICALLY at every level — fixtures
// must mirror that byte layout (the G.3 key-vs-value collision lesson).
function deepSortKeys(value) {
  if (Array.isArray(value)) return value.map(deepSortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, deepSortKeys(v)]),
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Fixtures: the engine's raw stream form — concatenated SIZE-PREFIXED $OMM
// records (flatsqlrt A.1: raw stream bytes == ingested stream bytes).
// ---------------------------------------------------------------------------

function encodeOmm(record) {
  const builder = new flatbuffers.Builder(512);
  const objectName = builder.createString(record.object_name);
  OMM.startOMM(builder);
  OMM.addObjectName(builder, objectName);
  OMM.addMeanMotion(builder, record.mean_motion);
  OMM.addNoradCatId(builder, record.norad_cat_id);
  OMM.addUserDefinedEpochTimestamp(builder, record.epoch_ts);
  OMM.finishSizePrefixedOMMBuffer(builder, OMM.endOMM(builder));
  return builder.asUint8Array().slice();
}

function concatFrames(frames) {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0);
  const stream = new Uint8Array(total);
  let offset = 0;
  for (const frame of frames) {
    stream.set(frame, offset);
    offset += frame.length;
  }
  return stream;
}

const OMM_RECORDS = [
  encodeOmm({ object_name: "ISS (ZARYA)", norad_cat_id: 25544, mean_motion: 15.49, epoch_ts: 1783300000 }),
  encodeOmm({ object_name: "NOAA 19", norad_cat_id: 33591, mean_motion: 14.12, epoch_ts: 1783300100 }),
];
const OMM_STREAM = concatFrames(OMM_RECORDS);

const SURFACE_RESULT = deepSortKeys({
  tables: [
    { name: "OMM", kind: "view", columns: ["CCSDS_OMM_VERS", "NORAD_CAT_ID", "_data", "_source"], records: 2 },
    { name: "OMM@celestrak-gp", kind: "table", source: "celestrak-gp", columns: ["CCSDS_OMM_VERS", "NORAD_CAT_ID", "_data"], records: 2 },
  ],
  caps: { timeout_ms: 5000, max_rows: 200000, max_bytes: 134217728 },
});

// ---------------------------------------------------------------------------
// Hostcall stub.
// ---------------------------------------------------------------------------

function createQueryStub({ sandboxed, surface } = {}) {
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

        if (operation === "clock.now") {
          response = encodeHostcallEnvelope({ ok: true, result: 1783300000000 });
          return 0;
        }
        if (operation === "storage.query_sandboxed" && sandboxed) {
          const { meta: outMeta, segments = [] } =
            typeof sandboxed === "function" ? sandboxed(meta) : sandboxed;
          response = encodeHostcallEnvelope(deepSortKeys(outMeta), segments);
          return outMeta.ok ? 0 : 1;
        }
        if (operation === "storage.query_surface") {
          const result = surface ?? SURFACE_RESULT;
          response = encodeHostcallEnvelope({ ok: true, result: deepSortKeys(result) });
          return 0;
        }
        response = encodeHostcallEnvelope({ ok: false, error: { message: `unexpected op ${operation}` } });
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

async function pumpRequest(stub, request) {
  const host = await createFlowRuntimeHost({
    wasmSource: new Uint8Array(fs.readFileSync(fileURLToPath(QUERY_WASM))),
    extraImports: stub.imports,
  });
  stub.memoryRef.memory = host.memory;

  const responses = [];
  host.enqueueTriggerFrame(0, {
    portId: "request",
    bytes: encodeHttpRequest(request),
  });
  await host.drain(
    {
      "sdn.flow.egress:emit": ({ frames }) => {
        for (const frame of frames) {
          responses.push(decodeHttpResponse(frame.bytes));
        }
        return { statusCode: 0 };
      },
    },
    { maxIterations: 100 },
  );
  assert.equal(responses.length, 1, "expected exactly one $HTR frame");
  return responses[0];
}

function header(http, name) {
  for (const entry of http.headers ?? []) {
    if (entry.name === name) return entry.value;
  }
  return undefined;
}

function streamOk(rows) {
  return {
    meta: { ok: true, result: { columns: 1, rows, stream: { $bin: 0 } } },
    segments: [OMM_STREAM],
  };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

test("public query: POST fb SELECT streams aligned frames verbatim", async () => {
  const stub = createQueryStub({
    sandboxed: (meta) => {
      assert.equal(meta.sql, "SELECT _data FROM OMM");
      assert.equal(meta.want, "stream");
      assert.equal(meta.deliver, "ref");
      return streamOk(2);
    },
  });
  const http = await pumpRequest(stub, {
    method: "POST",
    path: "/api/v1/query",
    query: "",
    body: encoder.encode(JSON.stringify({ sql: "SELECT _data FROM OMM" })),
  });
  assert.equal(http.status, 200);
  assert.equal(header(http, "content-type"), "application/vnd.sdn.flatbuffers.stream");
  assert.equal(header(http, "x-sdn-record-count"), "2");
  assert.equal(header(http, "etag"), `W/"fnv1a64-${fnv1a64Hex(OMM_STREAM)}"`);
  assert.deepEqual(Array.from(http.body), Array.from(OMM_STREAM), "stream verbatim");
});

test("public query: host body reference rides the $HTR BODY_REF fields", async () => {
  const etag = fnv1a64Hex(OMM_STREAM);
  const stub = createQueryStub({
    sandboxed: {
      meta: {
        ok: true,
        result: { columns: 1, rows: 2, ref: { fnv1a64: etag, frames: 2, size: OMM_STREAM.length, token: 7 } },
      },
      segments: [],
    },
  });
  const http = await pumpRequest(stub, {
    method: "POST",
    path: "/api/v1/query",
    query: "",
    body: encoder.encode(JSON.stringify({ sql: "SELECT _data FROM OMM" })),
  });
  assert.equal(http.status, 200);
  assert.equal(Number(http.bodyRefToken), 7);
  assert.equal(Number(http.bodyRefSize), OMM_STREAM.length);
  assert.equal(header(http, "x-sdn-record-count"), "2");
  assert.equal(header(http, "etag"), `W/"fnv1a64-${etag}"`);
  assert.equal(http.body?.length ?? 0, 0, "no inline body with a BODY_REF");
});

test("public query: format=json full-record result is the bare-array OMM presentation (schema-exact keys)", async () => {
  const stub = createQueryStub({
    sandboxed: (meta) => {
      assert.equal(meta.want, "auto", "json path asks stream-with-rows-fallback");
      assert.equal(meta.deliver, undefined, "json path needs inline bytes");
      return streamOk(2);
    },
  });
  const http = await pumpRequest(stub, {
    method: "POST",
    path: "/api/v1/query",
    query: "format=json",
    body: encoder.encode(JSON.stringify({ sql: "SELECT _data FROM OMM" })),
  });
  assert.equal(http.status, 200);
  assert.equal(header(http, "content-type"), "application/json");
  assert.equal(header(http, "x-sdn-record-count"), "2");
  assert.equal(header(http, "etag"), `W/"fnv1a64-${fnv1a64Hex(OMM_STREAM)}"`, "shared etag across encodings");
  const records = JSON.parse(decoder.decode(http.body));
  assert.ok(Array.isArray(records), "bare top-level array");
  assert.equal(records.length, 2);
  assert.equal(records[0].OBJECT_NAME, "ISS (ZARYA)");
  assert.equal(records[0].NORAD_CAT_ID, 25544);
  assert.equal(records[1].MEAN_MOTION, 14.12);
});

test("public query: projection results are engine-assembled rows JSON with verbatim column keys", async () => {
  const rowsJson = encoder.encode('[{"NORAD_CAT_ID":25544,"MEAN_MOTION":15.49},{"NORAD_CAT_ID":33591,"MEAN_MOTION":14.12}]');
  const stub = createQueryStub({
    sandboxed: {
      meta: { ok: true, result: { columns: 2, json: { $bin: 0 }, kind: "rows", rows: 2 } },
      segments: [rowsJson],
    },
  });
  const http = await pumpRequest(stub, {
    method: "POST",
    path: "/api/v1/query",
    query: "format=json",
    body: encoder.encode(JSON.stringify({ sql: "SELECT NORAD_CAT_ID, MEAN_MOTION FROM OMM" })),
  });
  assert.equal(http.status, 200);
  assert.equal(header(http, "content-type"), "application/json");
  assert.equal(header(http, "x-sdn-record-count"), "2");
  const rows = JSON.parse(decoder.decode(http.body));
  assert.deepEqual(rows, [
    { NORAD_CAT_ID: 25544, MEAN_MOTION: 15.49 },
    { NORAD_CAT_ID: 33591, MEAN_MOTION: 14.12 },
  ]);
});

test("public query: sort/limit wrap the SQL in-wasm; invalid sort answers 400", async () => {
  const stub = createQueryStub({
    sandboxed: (meta) => {
      assert.equal(
        meta.sql,
        'SELECT * FROM (SELECT _data FROM OMM) ORDER BY "NORAD_CAT_ID" DESC LIMIT 5',
      );
      return streamOk(2);
    },
  });
  const http = await pumpRequest(stub, {
    method: "POST",
    path: "/api/v1/query",
    query: "",
    body: encoder.encode(
      JSON.stringify({ sql: "SELECT _data FROM OMM", sort: "NORAD_CAT_ID DESC", limit: 5 }),
    ),
  });
  assert.equal(http.status, 200);

  const badStub = createQueryStub({});
  const bad = await pumpRequest(badStub, {
    method: "POST",
    path: "/api/v1/query",
    query: "",
    body: encoder.encode(JSON.stringify({ sql: "SELECT _data FROM OMM", sort: "x; DROP TABLE" })),
  });
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(decoder.decode(bad.body)).code, "invalid-sort");
  assert.equal(badStub.calls.length, 0, "invalid sort never reaches the host");
});

test("public query: profile composes the engine epoch SQL with default epoch=now", async () => {
  const stub = createQueryStub({
    sandboxed: (meta) => {
      assert.match(meta.sql, /ROW_NUMBER\(\) OVER \(PARTITION BY NORAD_CAT_ID ORDER BY ABS/);
      assert.equal(meta.params.length, 3);
      assert.deepEqual(meta.params[0], { t: "str", v: "celestrak-gp" });
      assert.equal(meta.params[1].t, "f64");
      assert.ok(Math.abs(meta.params[1].v - 1783300000) < 1, "epoch defaulted from clock.now");
      assert.deepEqual(meta.params[2], { t: "i64", v: 50000 });
      return streamOk(2);
    },
  });
  const http = await pumpRequest(stub, {
    method: "POST",
    path: "/api/v1/query",
    query: "",
    body: encoder.encode(JSON.stringify({ profile: "nearest", source: "celestrak-gp" })),
  });
  assert.equal(http.status, 200);
  assert.equal(stub.calls.map((c) => c.operation).join(","), "clock.now,storage.query_sandboxed");
});

test("public query: sandbox rejections map to honest statuses with machine-readable codes", async () => {
  const cases = [
    ["row-cap", "sandbox: row-cap: result exceeds 200000 rows", 422],
    ["timeout", "sandbox: timeout: statement exceeded 5000 ms", 422],
    ["byte-cap", "sandbox: byte-cap: result exceeds 134217728 bytes", 422],
    ["not-authorized", "sandbox: not-authorized: PRAGMA is not permitted (read-only SELECT sandbox)", 400],
    ["multi-statement", "sandbox: multi-statement: exactly one SELECT statement is allowed", 400],
    ["not-a-record-stream", "sandbox: not-a-record-stream: raw response stream queries must return only BLOB cells", 406],
  ];
  for (const [code, message, expectedStatus] of cases) {
    const stub = createQueryStub({
      sandboxed: { meta: { ok: false, error: { message, sandbox: code } }, segments: [] },
    });
    const http = await pumpRequest(stub, {
      method: "POST",
      path: "/api/v1/query",
      query: "",
      body: encoder.encode(JSON.stringify({ sql: "PRAGMA anything" })),
    });
    assert.equal(http.status, expectedStatus, `${code} -> ${expectedStatus}`);
    const body = JSON.parse(decoder.decode(http.body));
    assert.equal(body.code, code);
    assert.ok(body.error.includes(code), "error message carries the engine text");
  }
});

test("public query: plain SQL errors answer 400; POST without sql answers 400 before any hostcall", async () => {
  const stub = createQueryStub({
    sandboxed: {
      meta: { ok: false, error: { message: "sandboxed query failed: flatsqlrt: query_sandboxed: SQL error: no such column: nope" } },
      segments: [],
    },
  });
  const http = await pumpRequest(stub, {
    method: "POST",
    path: "/api/v1/query",
    query: "",
    body: encoder.encode(JSON.stringify({ sql: "SELECT nope FROM OMM" })),
  });
  assert.equal(http.status, 400);

  const emptyStub = createQueryStub({});
  const empty = await pumpRequest(emptyStub, {
    method: "POST",
    path: "/api/v1/query",
    query: "",
    body: new Uint8Array(0),
  });
  assert.equal(empty.status, 400);
  assert.equal(JSON.parse(decoder.decode(empty.body)).code, "missing-sql");
  assert.equal(emptyStub.calls.length, 0);
});

test("public query: raw SQL text body works; DELETE answers 404", async () => {
  const stub = createQueryStub({
    sandboxed: (meta) => {
      assert.equal(meta.sql, "SELECT _data FROM OMM LIMIT 1");
      return streamOk(1);
    },
  });
  const http = await pumpRequest(stub, {
    method: "POST",
    path: "/api/v1/query",
    query: "",
    body: encoder.encode("SELECT _data FROM OMM LIMIT 1"),
  });
  assert.equal(http.status, 200);

  const rejected = await pumpRequest(createQueryStub({}), {
    method: "DELETE",
    path: "/api/v1/query",
    query: "",
  });
  assert.equal(rejected.status, 404);
});

test("public query: GET serves the queryable-surface listing with caps; If-None-Match answers 304", async () => {
  const stub = createQueryStub({});
  const http = await pumpRequest(stub, {
    method: "GET",
    path: "/api/v1/query",
    query: "",
  });
  assert.equal(http.status, 200);
  assert.equal(header(http, "content-type"), "application/json");
  const surface = JSON.parse(decoder.decode(http.body));
  assert.equal(surface.tables[0].name, "OMM");
  assert.equal(surface.tables[1].name, "OMM@celestrak-gp");
  assert.ok(surface.tables[0].columns.includes("_source"));
  assert.equal(surface.caps.timeout_ms, 5000);
  const etag = header(http, "etag");
  assert.match(etag, /^W\/"fnv1a64-[0-9a-f]{16}"$/);

  const cached = await pumpRequest(createQueryStub({}), {
    method: "GET",
    path: "/api/v1/query",
    query: "",
    headers: [{ name: "if-none-match", value: etag }],
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.body?.length ?? 0, 0);
});

test("public query bundle carries the api block for the OpenAPI generator", () => {
  const flow = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL("../dist/query/flow.json", import.meta.url)), "utf8"),
  );
  assert.equal(flow.api.basePath, "/api/v1/query");
  assert.deepEqual(
    flow.api.routes.map((route) => [route.method, route.path, route.anonymous]),
    [
      ["GET", "", true],
      ["POST", "", true],
    ],
  );
  assert.ok(flow.api.routes[1].responses["422"], "resource-cap rejections documented");
  assert.ok(flow.api.routes[1].responses["406"], "projection-as-fb documented");
});
