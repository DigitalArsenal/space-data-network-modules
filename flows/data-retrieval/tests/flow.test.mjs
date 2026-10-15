/*
 * Flow-level tests for the compiled data-retrieval flow (typed contracts 1.0). The SAME artifact the host mounts at
 * /api/v1/data runs in the JS flow runtime host: a $HTQ enters http-route route, the $QRP decision and the $QRP page
 * travel route -> data-source/retrieval omm_bulk | data_query -> http-respond respond_query linked-direct inside the
 * artifact (a refusal goes straight from the router to the responder), and the only host crossings are the typed $PIV
 * hostcalls (storage.flatsql_epoch_stream, storage.flatsql_query_stream, plugin.getConfig, clock.now), answered here on
 * the wire the way a typed host answers them.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";
import { decodeHttpResponse, encodeHttpRequest, fnv1a64Hex } from "space-data-module-sdk/http";
import { decodeHostCall, decodeSqlValues, encodeHostCallResult, encodeModuleConfig } from "space-data-module-sdk/runtime-contracts";
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

const FLOW_WASM = new URL("../dist/runtime.wasm", import.meta.url);
const NOW_MS = 1791900000123n;
const RECORDS = ommStream([
  { NORAD_CAT_ID: 25544, OBJECT_NAME: "ISS (ZARYA)", EPOCH: "2026-10-13T06:00:00.000Z", MEAN_MOTION: 15.5, BSTAR: 0.00012 },
  { NORAD_CAT_ID: 20580, OBJECT_NAME: "HST", MEAN_MOTION: 15.1 },
]);
const ETAG = `W/"fnv1a64-${fnv1a64Hex(RECORDS)}"`;

// The store as storage.flatsql_epoch_stream / storage.flatsql_query_stream / plugin.getConfig / clock.now answer it.
function store({ config = {}, stream = RECORDS, fail = null, ref = null } = {}) {
  return typedHost((call) => {
    if (call.op === "clock.now") return { result: { UNIX_MS: NOW_MS } };
    if (call.op === "plugin.getConfig") return { raw: { config: encodeModuleConfig(config) } };
    if (call.op === "storage.flatsql_epoch_stream" || call.op === "storage.flatsql_query_stream") {
      if (fail) throw fail;
      if (ref && call.params.DELIVER === 1) return { result: { ROWS: 2n, COLUMNS: 1, REF: ref } };
      return { result: { ROWS: 2n, COLUMNS: 1 }, raw: { stream } };
    }
    throw hostError("unsupported", `unexpected op ${call.op}`);
  });
}
const BULK = "/api/v1/data/omm/bulk";
const sqlOf = (call) => new TextDecoder().decode(call.raw.sql);
// The tagged SQL values on a call's raw "params" as [tag, value] (i64 as a Number).
const sqlParams = (call) => decodeSqlValues(call.raw.params).map(({ t, v }) => [t, t === "i64" ? Number(v) : v]);

test("GET omm/bulk: every query-string parameter reaches storage.flatsql_epoch_stream; the page answers verbatim", async () => {
  const host = store();
  const http = await serve(FLOW_WASM, host, { method: "GET", path: BULK, query: "source=celestrak&mode=as_of&epoch=2026-10-13T06%3A00%3A00Z&limit=250" });
  assert.equal(http.status, 200);
  assert.equal(http.header("content-type"), "application/vnd.sdn.flatbuffers.stream");
  assert.equal(http.header("x-sdn-record-count"), "2");
  assert.equal(http.header("etag"), ETAG, "W/\"fnv1a64-<FNV-1a 64 of the record stream>\"");
  const { header, records } = splitPage(http.body);
  assert.deepEqual([header.SCHEMA_NAME, header.FILE_IDENTIFIER, header.RECORD_COUNT, header.ETAG, header.SOURCE_NAME, header.LIMIT], ["OMM", "$OMM", 2, ETAG, "celestrak", 250]);
  assert.deepEqual(records, RECORDS);
  const epoch = host.calls.find((c) => c.op === "storage.flatsql_epoch_stream");
  assert.deepEqual([epoch.params.SCHEMA, epoch.params.SOURCE, epoch.params.PROFILE, epoch.params.EPOCH, epoch.params.LIMIT, epoch.params.DELIVER],
    ["OMM.fbs", "celestrak", "as_of", Date.UTC(2026, 9, 13, 6) / 1000, 250, 1], "FlatBuffers ask DELIVER Ref; a host that answers inline is served inline");
  assert.equal(host.calls.some((c) => c.op === "clock.now"), false, "a stated epoch needs no clock");
});

test("format=json renders the page's records as an OMM array; If-None-Match equal to the ETAG answers 304", async () => {
  const http = await serve(FLOW_WASM, store(), { method: "GET", path: BULK, query: "format=json" });
  assert.deepEqual([http.status, http.header("content-type"), http.header("etag")], [200, "application/json", ETAG]);
  const body = http.json();
  assert.deepEqual(body.map((r) => [r.NORAD_CAT_ID, r.OBJECT_NAME, r.MEAN_MOTION]), [[25544, "ISS (ZARYA)", 15.5], [20580, "HST", 15.1]]);
  assert.equal(body[0].BSTAR, 0.00012);
  const jsonHost = store();
  await serve(FLOW_WASM, jsonHost, { method: "GET", path: BULK, query: "format=json" });
  assert.equal(jsonHost.calls.find((c) => c.op === "storage.flatsql_epoch_stream").params.DELIVER, 0, "JSON asks DELIVER Inline");
  const notModified = await serve(FLOW_WASM, store(), { method: "GET", path: BULK, headers: { "If-None-Match": ETAG } });
  assert.deepEqual([notModified.status, notModified.header("etag"), notModified.body.length], [304, ETAG, 0]);
});

test("no parameters: the module config, then the compiled defaults with epoch = clock.now", async () => {
  const host = store({ config: { profiles: { "OMM.fbs": { profile: "forward", limit: 123 } } } });
  const http = await serve(FLOW_WASM, host, { method: "GET", path: BULK });
  assert.equal(http.status, 200);
  const ops = host.calls.map((c) => c.op);
  assert.ok(ops.includes("plugin.getConfig") && ops.includes("clock.now"), ops.join(","));
  const epoch = host.calls.find((c) => c.op === "storage.flatsql_epoch_stream");
  assert.deepEqual([epoch.params.PROFILE, epoch.params.LIMIT, epoch.params.EPOCH], ["forward", 123, Number(NOW_MS) / 1000]);
  const bare = store();
  await serve(FLOW_WASM, bare, { method: "GET", path: BULK });
  const fallback = bare.calls.find((c) => c.op === "storage.flatsql_epoch_stream");
  assert.deepEqual([fallback.params.PROFILE, fallback.params.LIMIT], ["nearest", 50000]);
});

test("a host BodyRef answers the $HTR by reference (no inline body), 304 on its etag", async () => {
  const REF = { TOKEN: 31337n, SIZE: BigInt(RECORDS.length), FRAMES: 2n, FNV1A64: fnv1a64Hex(RECORDS) };
  const http = await serve(FLOW_WASM, store({ ref: REF }), { method: "GET", path: BULK, query: "epoch=1" });
  assert.deepEqual([http.status, http.body.length, Number(http.bodyRefToken), http.bodyRefSize], [200, 0, 31337, RECORDS.length]);
  assert.deepEqual([http.header("content-type"), http.header("x-sdn-record-count"), http.header("etag")], ["application/vnd.sdn.flatbuffers.stream", "2", ETAG]);
  const notModified = await serve(FLOW_WASM, store({ ref: REF }), { method: "GET", path: BULK, query: "epoch=1", headers: { "If-None-Match": ETAG } });
  assert.deepEqual([notModified.status, notModified.body.length, Number(notModified.bodyRefToken)], [304, 0, 0]);
  const query = await serve(FLOW_WASM, store({ ref: REF }), { method: "POST", path: "/api/v1/data/query", body: "SELECT _data FROM OMM" });
  assert.deepEqual([query.status, Number(query.bodyRefToken), query.header("x-sdn-record-count")], [200, 31337, "2"]);
  const json = await serve(FLOW_WASM, store({ ref: REF }), { method: "GET", path: BULK, query: "epoch=1&format=json" });
  assert.deepEqual([json.status, Number(json.bodyRefToken), json.json().length], [200, 0, 2], "JSON asks Inline and renders");
});

test("?profile=all reads every record of the lane through storage.flatsql_query_stream; no profile keeps the epoch-stream defaults", async () => {
  const host = store();
  const http = await serve(FLOW_WASM, host, { method: "GET", path: BULK, query: "profile=all&source=celestrak&limit=10" });
  assert.equal(http.status, 200);
  assert.equal(host.calls.some((c) => c.op === "storage.flatsql_epoch_stream"), false);
  const call = host.calls.find((c) => c.op === "storage.flatsql_query_stream");
  assert.match(sqlOf(call), /^SELECT _data FROM "OMM" WHERE \(\?1 = '' OR _source = \?1\)/);
  assert.deepEqual(sqlParams(call)[0], ["str", "OMM@celestrak"]);
  assert.deepEqual(sqlParams(call).at(-1), ["i64", 10]);
  assert.equal(splitPage(http.body).header.RECORD_COUNT, 2);
  const unspecified = store();
  await serve(FLOW_WASM, unspecified, { method: "GET", path: BULK, query: "epoch=1" });
  assert.equal(unspecified.calls.find((c) => c.op === "storage.flatsql_epoch_stream").params.PROFILE, "nearest", "Unspecified: the configured default");
});

test("rfb/bulk serves $RFB as FlatBuffers; JSON of $RFB is refused 406 without reaching the host", async () => {
  const host = store();
  const fb = await serve(FLOW_WASM, host, { method: "GET", path: "/api/v1/data/rfb/bulk", query: "format=flatbuffer" });
  assert.equal(fb.status, 200);
  assert.equal(host.calls.find((c) => c.op === "storage.flatsql_epoch_stream").params.SCHEMA, "RFB.fbs");
  const refused = store();
  const json = await serve(FLOW_WASM, refused, { method: "GET", path: "/api/v1/data/rfb/bulk", query: "format=json" });
  assert.deepEqual([json.status, json.json().code], [406, "not-acceptable"]);
  assert.match(json.json().error, /RFB\.fbs; request format=flatbuffer/);
  assert.equal(refused.calls.length, 0);
});

test("POST /query: a JSON body's SQL and tagged params, or raw SQL text, reach storage.flatsql_query_stream", async () => {
  const host = store();
  const http = await serve(FLOW_WASM, host, { method: "POST", path: "/api/v1/data/query", body: JSON.stringify({ sql: "SELECT _data FROM OMM WHERE NORAD_CAT_ID = ? AND OBJECT_NAME LIKE ?", params: [{ t: "i64", v: 25544 }, { t: "str", v: "ISS%" }] }) });
  assert.equal(http.status, 200);
  assert.equal(splitPage(http.body).header.RECORD_COUNT, 2);
  const [call] = host.calls;
  assert.equal(call.op, "storage.flatsql_query_stream");
  assert.equal(sqlOf(call), "SELECT _data FROM OMM WHERE NORAD_CAT_ID = ? AND OBJECT_NAME LIKE ?");
  assert.deepEqual(sqlParams(call), [["i64", 25544], ["str", "ISS%"]]);
  assert.equal(call.params.DELIVER, 1, "FlatBuffers ask DELIVER Ref");

  const raw = store();
  await serve(FLOW_WASM, raw, { method: "POST", path: "/api/v1/data/query", body: "SELECT _data FROM OMM LIMIT 1" });
  assert.equal(sqlOf(raw.calls[0]), "SELECT _data FROM OMM LIMIT 1");

  const empty = store();
  const missing = await serve(FLOW_WASM, empty, { method: "POST", path: "/api/v1/data/query", query: "format=json", body: "" });
  assert.deepEqual([missing.status, missing.json().code], [400, "missing-sql"]);
  assert.equal(empty.calls.length, 0);
});

test("an unknown path is 404 no-route without reaching the host; a storage failure is 502", async () => {
  const host = store();
  const none = await serve(FLOW_WASM, host, { method: "GET", path: "/api/v1/data/omm", query: "format=json" });
  assert.deepEqual([none.status, none.json().code], [404, "no-route"]);
  assert.equal(host.calls.length, 0);
  const failed = await serve(FLOW_WASM, store({ fail: hostError("failed", "disk I/O error") }), { method: "GET", path: BULK, query: "format=json&epoch=0.001" });
  assert.deepEqual([failed.status, failed.json().code], [502, "host-failed"]);
  assert.match(failed.json().error, /disk I\/O error/);
  const fb = await serve(FLOW_WASM, store({ fail: hostError("failed", "disk I/O error") }), { method: "GET", path: BULK, query: "epoch=1" });
  assert.equal(fb.status, 502);
  assert.equal(fb.header("x-sdn-file-identifier"), "$QRP", "the refusal record itself, as FlatBuffers");
});

test("the bundle carries the api block for the OpenAPI generator", () => {
  const flow = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../dist/flow.json", import.meta.url)), "utf8"));
  assert.equal(flow.api.basePath, "/api/v1/data");
  assert.deepEqual(flow.api.routes.map((r) => [r.method, r.path, r.anonymous]), [["GET", "omm/bulk", true], ["GET", "rfb/bulk", true], ["POST", "query", false]]);
  assert.deepEqual(Object.keys(flow.api.routes[0].responses["200"].content).sort(), ["application/json", "application/vnd.sdn.flatbuffers.stream"]);
  assert.deepEqual(Object.keys(flow.api.routes[1].responses["200"].content), ["application/vnd.sdn.flatbuffers.stream"]);
});
