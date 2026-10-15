/*
 * Flow-level tests for the compiled public-query flow (gateway loop G.5, typed contracts 1.0). The SAME artifact the
 * host mounts at /api/v1/query runs in the JS flow runtime host: a $HTQ enters route_public_query, the $QRP decision and
 * the $QRP page travel route -> flatsql-query sandbox_query -> http-respond respond_query linked-direct inside the
 * artifact, and the only host crossings are the typed $PIV hostcalls (storage.query_sandboxed, storage.query_surface,
 * clock.now), answered here on the wire the way a typed host answers them.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";
import { decodeHttpResponse, encodeHttpRequest, fnv1a64Hex } from "space-data-module-sdk/http";
import { decodeHostCall, decodeSqlValues, encodeHostCallResult, encodeSqlValues } from "space-data-module-sdk/runtime-contracts";
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

async function loadStandard(code) {
  const esbuild = await import(pathToFileURL(path.join(STANDARDS_ROOT, "node_modules", "esbuild", "lib", "main.js")).href);
  const flatbuffersEntry = fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"));
  const out = await esbuild.build({ entryPoints: [path.join(STANDARDS_ROOT, "lib", "ts", code, "main.ts")], bundle: true, format: "esm", write: false, platform: "neutral", alias: { flatbuffers: flatbuffersEntry }, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
const flatbuffers = await import(pathToFileURL(fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"))).href);
const { QRP } = await loadStandard("QRP");
const { OMM, OMMT } = await loadStandard("OMM");

const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
// $OMM records as the store delivers them: size-prefixed, concatenated.
function ommStream(records) {
  return concat(...records.map((fields) => {
    const b = new flatbuffers.Builder(256);
    b.finishSizePrefixed(Object.assign(new OMMT(), fields).pack(b), "$OMM");
    return b.asUint8Array().slice();
  }));
}
// A page stream -> { header (unpacked QRP), records (the bytes after the header and its padding) }.
function splitPage(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = view.getUint32(0, true);
  const header = QRP.getSizePrefixedRootAsQRP(new flatbuffers.ByteBuffer(bytes.slice(0, 4 + size))).unpack();
  let at = 4 + size;
  while (at + 4 <= bytes.length && view.getUint32(at, true) === 0) at += 4;
  return { header, records: bytes.slice(at) };
}

// A typed host on the wire: each $PIV call is decoded and answered with a $PIV response by `answer(call)`.
function typedHost(answer) {
  const calls = [];
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);
  const imports = {
    space_data_module_host: {
      call(opPtr, opLen, ptr, len) {
        const call = decodeHostCall(new Uint8Array(memoryRef.memory.buffer).slice(ptr, ptr + len));
        calls.push(call);
        let out;
        try { out = { ok: true, op: call.op, ...(answer(call) ?? {}) }; } catch (error) { out = { ok: false, error: { code: error.code ?? "failed", message: error.message } }; }
        response = encodeHostCallResult(out);
        return 0;
      },
      response_len: () => response.length,
      read_response(dst, len) {
        const n = Math.min(len, response.length);
        new Uint8Array(memoryRef.memory.buffer).set(response.subarray(0, n), dst);
        return n;
      },
    },
  };
  return { calls, imports, memoryRef };
}
const hostError = (code, message) => Object.assign(new Error(message), { code });

async function serve(wasmUrl, host, request) {
  const runtime = await createFlowRuntimeHost({ wasmSource: new Uint8Array(fs.readFileSync(fileURLToPath(wasmUrl))), extraImports: host.imports, runtimeTarget: "wasmedge" });
  host.memoryRef.memory = runtime.memory;
  const responses = [];
  runtime.enqueueTriggerFrame(0, { portId: "request", bytes: encodeHttpRequest(request) });
  await runtime.drain({ "sdn.flow.egress:emit": ({ frames }) => { for (const f of frames) responses.push(decodeHttpResponse(f.bytes)); return { statusCode: 0 }; } }, { maxIterations: 100 });
  assert.equal(responses.length, 1, "exactly one $HTR");
  const [http] = responses;
  http.header = (name) => http.headers.find((h) => h.name === name)?.value;
  http.json = () => JSON.parse(new TextDecoder().decode(http.body));
  return http;
}

const FLOW_WASM = new URL("../dist/query/runtime.wasm", import.meta.url);
const NOW_MS = 1791900000123n;
const RECORDS = ommStream([
  { NORAD_CAT_ID: 25544, OBJECT_NAME: "ISS (ZARYA)", EPOCH: "2026-10-13T06:00:00.000Z", MEAN_MOTION: 15.5, BSTAR: 0.00012 },
  { NORAD_CAT_ID: 20580, OBJECT_NAME: "HST", MEAN_MOTION: 15.1 },
]);
const ETAG = `W/"fnv1a64-${fnv1a64Hex(RECORDS)}"`;

// The store as storage.query_sandboxed / storage.query_surface / clock.now answer it.
function store({ rows = null, fail = null, ref = null } = {}) {
  return typedHost((call) => {
    if (call.op === "clock.now") return { result: { UNIX_MS: NOW_MS } };
    if (call.op === "storage.query_surface") {
      return { result: { TIMEOUT_MS: 5000, MAX_ROWS: 50000n, MAX_BYTES: 16777216n },
        lists: { tables: [{ NAME: "OMM", KIND: "standard", SOURCE: "OMM", RECORDS: 4213n }], columns: [{ TABLE: "OMM", NAME: "NORAD_CAT_ID" }, { TABLE: "OMM", NAME: "OBJECT_NAME" }] } };
    }
    if (call.op === "storage.query_sandboxed") {
      if (fail) throw fail;
      if (ref && call.params.DELIVER === 1) return { result: { KIND: 0, ROWS: 2n, COLUMNS: 1, REF: ref } };
      if (rows) return { result: { KIND: 1, ROWS: BigInt(rows.cells.length / rows.columns.length), COLUMNS: rows.columns.length }, lists: { columns: rows.columns.map((VALUE) => ({ VALUE })) }, raw: { cells: encodeSqlValues(rows.cells) } };
      return { result: { KIND: 0, ROWS: 2n, COLUMNS: 1 }, raw: { stream: RECORDS } };
    }
    throw hostError("unsupported", `unexpected op ${call.op}`);
  });
}
const sqlOf = (call) => new TextDecoder().decode(call.raw.sql);
// The tagged SQL values on a call's raw "params" (i64 as a Number).
const sqlParams = (call) => decodeSqlValues(call.raw.params).map(({ t, v }) => (t === "i64" ? Number(v) : v));
const post = (body, query = "", headers = {}) => ({ method: "POST", path: "/api/v1/query", query, headers, body: typeof body === "string" ? body : JSON.stringify(body) });

test("POST raw SQL: sort and limit compose the effective SQL; the page stream answers verbatim as FlatBuffers", async () => {
  const host = store();
  const http = await serve(FLOW_WASM, host, post({ sql: "SELECT _data FROM OMM", sort: "NORAD_CAT_ID desc", limit: 2 }));
  assert.equal(http.status, 200);
  assert.equal(http.header("content-type"), "application/vnd.sdn.flatbuffers.stream");
  assert.equal(http.header("x-sdn-record-count"), "2");
  assert.equal(http.header("etag"), ETAG);
  const { header, records } = splitPage(http.body);
  assert.deepEqual([header.RECORD_COUNT, header.FILE_IDENTIFIER, header.SCHEMA_NAME, header.ETAG], [2, "$OMM", "OMM", ETAG]);
  assert.deepEqual(records, RECORDS, "the records verbatim after the page header");
  const [call] = host.calls;
  assert.equal(call.op, "storage.query_sandboxed");
  assert.equal(sqlOf(call), "SELECT * FROM (SELECT _data FROM OMM) ORDER BY \"NORAD_CAT_ID\" DESC LIMIT 2");
  assert.deepEqual([call.params.WANT, call.params.DELIVER], [0, 1], "WANT Stream, DELIVER Ref (a host that answers inline is served inline)");
});

test("?format=json: WANT Auto; a record stream renders as an OMM array, a projection as {COLUMN: value} rows", async () => {
  const host = store();
  const http = await serve(FLOW_WASM, host, post({ sql: "SELECT _data FROM OMM", params: [{ t: "i64", v: 25544 }] }, "format=json"));
  assert.equal(http.status, 200);
  assert.equal(http.header("content-type"), "application/json");
  assert.deepEqual(http.json().map((r) => [r.NORAD_CAT_ID, r.OBJECT_NAME]), [[25544, "ISS (ZARYA)"], [20580, "HST"]]);
  assert.deepEqual([host.calls[0].params.WANT, host.calls[0].params.DELIVER], [2, 0], "WANT Auto, DELIVER Inline: the responder renders the bytes");
  assert.equal(sqlOf(host.calls[0]), "SELECT _data FROM OMM");
  assert.deepEqual(decodeSqlValues(host.calls[0].raw.params), [{ t: "i64", v: 25544n }]);

  const rows = store({ rows: { columns: ["NORAD_CAT_ID", "OBJECT_NAME"], cells: [{ t: "i64", v: 25544n }, { t: "str", v: "ISS" }, { t: "i64", v: 20580n }, { t: "null" }] } });
  const projection = await serve(FLOW_WASM, rows, post({ sql: "SELECT NORAD_CAT_ID, OBJECT_NAME FROM OMM", format: "json" }));
  assert.equal(projection.status, 200);
  assert.deepEqual(projection.json(), [{ NORAD_CAT_ID: 25544, OBJECT_NAME: "ISS" }, { NORAD_CAT_ID: 20580, OBJECT_NAME: null }]);
  assert.equal(projection.header("x-sdn-record-count"), "2");
});

test("a profile request runs the engine-native profile SQL; no epoch defaults through clock.now", async () => {
  const host = store();
  const http = await serve(FLOW_WASM, host, post({ profile: "nearest", source: "celestrak", limit: 10 }));
  assert.equal(http.status, 200);
  const sandboxed = host.calls.find((c) => c.op === "storage.query_sandboxed");
  assert.ok(host.calls.some((c) => c.op === "clock.now"), "clock.now defaults the epoch");
  assert.match(sqlOf(sandboxed), /^SELECT _data FROM \(SELECT _data, ROW_NUMBER\(\) OVER \(PARTITION BY NORAD_CAT_ID ORDER BY ABS\(USER_DEFINED_EPOCH_TIMESTAMP - \?2\)\)/);
  assert.deepEqual(sqlParams(sandboxed), ["OMM@celestrak", Number(NOW_MS) / 1000, 10]);

  const stated = store();
  await serve(FLOW_WASM, stated, post({ profile: "as_of", epoch: "2026-10-13T00:00:00Z" }));
  assert.equal(stated.calls.some((c) => c.op === "clock.now"), false, "a stated epoch needs no clock");
  assert.deepEqual(sqlParams(stated.calls[0]).slice(1), [Date.UTC(2026, 9, 13) / 1000, 50000]);
});

test("a host BodyRef answers the $HTR by reference (no inline body), 304 on its etag", async () => {
  const REF = { TOKEN: 9001n, SIZE: BigInt(RECORDS.length), FRAMES: 2n, FNV1A64: fnv1a64Hex(RECORDS) };
  const host = store({ ref: REF });
  const http = await serve(FLOW_WASM, host, post({ sql: "SELECT _data FROM OMM" }));
  assert.deepEqual([http.status, http.body.length, Number(http.bodyRefToken), http.bodyRefSize], [200, 0, 9001, RECORDS.length]);
  assert.deepEqual([http.header("content-type"), http.header("x-sdn-record-count"), http.header("etag")], ["application/vnd.sdn.flatbuffers.stream", "2", ETAG]);
  assert.equal(host.calls[0].params.DELIVER, 1);
  const notModified = await serve(FLOW_WASM, store({ ref: REF }), post({ sql: "SELECT _data FROM OMM" }, "", { "If-None-Match": ETAG }));
  assert.deepEqual([notModified.status, notModified.body.length, Number(notModified.bodyRefToken)], [304, 0, 0]);
  const json = await serve(FLOW_WASM, store({ ref: REF }), post({ sql: "SELECT _data FROM OMM" }, "format=json"));
  assert.deepEqual([json.status, Number(json.bodyRefToken), json.json().length], [200, 0, 2], "JSON asks Inline and renders");
});

test("profile all: every unified-OMM-view record of the source; Unspecified with no SQL is refused", async () => {
  const host = store();
  const http = await serve(FLOW_WASM, host, post({ profile: "all", source: "celestrak" }));
  assert.equal(http.status, 200);
  const call = host.calls.find((c) => c.op === "storage.query_sandboxed");
  assert.match(sqlOf(call), /^SELECT _data FROM OMM WHERE \(\?1 = '' OR _source = \?1\)/);
  assert.equal(sqlParams(call)[0], "OMM@celestrak");
  assert.equal(host.calls.some((c) => c.op === "clock.now"), false, "All needs no reference instant");
  const both = await serve(FLOW_WASM, store(), post({ profile: "all", sql: "SELECT 1" }, "format=json"));
  assert.deepEqual([both.status, both.json().code], [400, "ambiguous-query"]);
});

test("GET lists the queryable surface (JSON on request)", async () => {
  const host = store();
  const http = await serve(FLOW_WASM, host, { method: "GET", path: "/api/v1/query", query: "format=json" });
  assert.equal(http.status, 200);
  assert.deepEqual(http.json(), {
    TABLES: [{ NAME: "OMM", KIND: "standard", SOURCE: "OMM", RECORDS: 4213, COLUMNS: [{ NAME: "NORAD_CAT_ID", TYPE: null, UNIT: null, SORTABLE: false, INDEXED: false }, { NAME: "OBJECT_NAME", TYPE: null, UNIT: null, SORTABLE: false, INDEXED: false }] }],
    MAX_ELAPSED_MS: 5000, MAX_ROWS: 50000, MAX_BYTES: 16777216,
  });
  assert.deepEqual(host.calls.map((c) => c.op), ["storage.query_surface"]);
  const fb = await serve(FLOW_WASM, store(), { method: "GET", path: "/api/v1/query" });
  assert.deepEqual([fb.status, fb.header("x-sdn-record-count")], [200, "1"]);
  assert.equal(splitPage(fb.body).header.TABLES[0].NAME, "OMM");
});

test("refusals: PUT 405 and an empty POST 400 never reach the host", async () => {
  const host = store();
  const put = await serve(FLOW_WASM, host, { method: "PUT", path: "/api/v1/query", query: "format=json", body: "SELECT 1" });
  assert.deepEqual([put.status, put.json().code], [405, "method-not-allowed"]);
  const empty = await serve(FLOW_WASM, host, post({}, "format=json"));
  assert.deepEqual([empty.status, empty.json().code], [400, "missing-sql"]);
  assert.equal(host.calls.length, 0);
});

test("host failures map to honest statuses: timeout 422, not-a-record-stream 406, other 502", async () => {
  const timeout = await serve(FLOW_WASM, store({ fail: hostError("timeout", "statement timeout after 5000 ms") }), post({ sql: "SELECT 1" }, "format=json"));
  assert.deepEqual([timeout.status, timeout.json().code], [422, "timeout"]);
  const projection = await serve(FLOW_WASM, store({ fail: hostError("sandbox", "not-a-record-stream: the query projects columns") }), post({ sql: "SELECT NORAD_CAT_ID FROM OMM" }, "format=json"));
  assert.deepEqual([projection.status, projection.json().code], [406, "not-acceptable"]);
  assert.match(projection.json().error, /request format=json for projection results/);
  const failed = await serve(FLOW_WASM, store({ fail: hostError("failed", "engine crashed") }), post({ sql: "SELECT 1" }, "format=json"));
  assert.deepEqual([failed.status, failed.json().code], [502, "host-failed"]);
});

test("If-None-Match equal to the page ETAG answers 304", async () => {
  const http = await serve(FLOW_WASM, store(), post({ sql: "SELECT _data FROM OMM" }, "", { "If-None-Match": ETAG }));
  assert.deepEqual([http.status, http.header("etag"), http.body.length], [304, ETAG, 0]);
  const stale = await serve(FLOW_WASM, store(), post({ sql: "SELECT _data FROM OMM" }, "", { "If-None-Match": "W/\"fnv1a64-0000000000000000\"" }));
  assert.equal(stale.status, 200);
});

test("the bundle carries the api block for the OpenAPI generator", () => {
  const flow = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../dist/query/flow.json", import.meta.url)), "utf8"));
  assert.equal(flow.api.basePath, "/api/v1/query");
  assert.deepEqual(flow.api.routes.map((r) => [r.method, r.path, r.anonymous]), [["GET", "", true], ["POST", "", true]]);
  assert.deepEqual(Object.keys(flow.api.routes[1].responses).sort(), ["200", "304", "400", "405", "406", "422", "502"]);
  assert.deepEqual(Object.keys(flow.api.routes[1].responses["200"].content).sort(), ["application/json", "application/vnd.sdn.flatbuffers.stream"]);
});
