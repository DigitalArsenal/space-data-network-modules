import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { decodeHostCall, decodeSqlValues, encodeHostCallResult, encodeModuleConfig } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

// data-source/retrieval on the typed contracts (1.0): $QRP Request in, $QRP decision + $QRP page stream out, and the
// store reads SDS $PIV hostcalls (storage.flatsql_epoch_stream / storage.flatsql_query_stream, clock.now,
// plugin.getConfig). The host here answers the module's actual $PIV calls on the wire, so the tests can assert the
// module's own request bytes (raw "sql", the tagged SQL values on raw "params", DELIVER); the config is one ModuleConfig.
const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const readWasm = () => fs.readFileSync(fileURLToPath(WASM_PATH));
const QRP_TYPE = { schemaName: "QRP.fbs", fileIdentifier: "$QRP", rootTypeName: "QRP", wireFormat: "flatbuffer" };

// The standard's own generated TS bindings (bundled with the standards' esbuild) decode and build $QRP.
async function loadStandard(code) {
  const esbuild = await import(pathToFileURL(path.join(STANDARDS_ROOT, "node_modules", "esbuild", "lib", "main.js")).href);
  const out = await esbuild.build({
    entryPoints: [path.join(STANDARDS_ROOT, "lib", "ts", code, "main.ts")], bundle: true, format: "esm", write: false, platform: "neutral", logLevel: "silent",
    alias: { flatbuffers: fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js")) },
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
const Q = await loadStandard("QRP");
const flatbuffers = await import(pathToFileURL(fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"))).href);

function qrp(fields) {
  const t = new Q.QRPT();
  for (const [k, v] of Object.entries(fields)) {
    if (k === "PARAMETERS") t.PARAMETERS = v.map((p) => Object.assign(new Q.QRPValueT(), p));
    else t[k] = v;
  }
  const b = new flatbuffers.Builder(256);
  b.finish(t.pack(b), "$QRP");
  return b.asUint8Array();
}
const decodeQrp = (bytes) => {
  const bb = new flatbuffers.ByteBuffer(bytes);
  assert.ok(Q.QRP.bufferHasIdentifier(bb), "a $QRP frame");
  return Q.QRP.getRootAsQRP(bb).unpack();
};
const requestFrame = (port, fields) => ({ portId: port, typeRef: QRP_TYPE, payload: qrp({ KIND: Q.qrpKind.Request, ...fields }) });

// A size-prefixed stream of minimal FlatBuffers carrying file identifier $CODE.
function recordStream(code, count) {
  const out = new Uint8Array(count * 20), v = new DataView(out.buffer);
  for (let i = 0; i < count; i++) {
    v.setUint32(i * 20, 16, true);
    v.setUint32(i * 20 + 4, 12, true);
    out.set(new TextEncoder().encode(`$${code}`), i * 20 + 8);
    v.setUint16(i * 20 + 12, 4, true); v.setUint16(i * 20 + 14, 4 + i, true);
    v.setInt32(i * 20 + 16, 4, true);
  }
  return out;
}
// FNV-1a 64, word-folded (8-byte little-endian words, then the tail bytes): the gateway's shared etag algorithm.
function fnvEtag(bytes) {
  const prime = 1099511628211n, mask = (1n << 64n) - 1n;
  let hash = 1469598103934665603n, i = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (; i + 8 <= bytes.length; i += 8) hash = ((hash ^ view.getBigUint64(i, true)) * prime) & mask;
  for (; i < bytes.length; i++) hash = ((hash ^ BigInt(bytes[i])) * prime) & mask;
  return `W/"fnv1a64-${hash.toString(16).padStart(16, "0")}"`;
}
// The page stream: the size-prefixed $QRP header (+ an optional zero padding prefix), then the records verbatim.
function splitPage(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = v.getUint32(0, true);
  const header = decodeQrp(bytes.subarray(4, 4 + size));
  let at = 4 + size;
  if (at < bytes.length && v.getUint32(at, true) === 0) at += 4;
  return { header, headerEnd: at, records: bytes.subarray(at) };
}

// The host: answers each $PIV call from `answer(op, call)` -> { result, lists, raw } or throws { code, message }.
async function harnessFor(t, answer) {
  const calls = [];
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (source, imports) => {
    let memory, response = new Uint8Array(0);
    const host = {
      ...imports.space_data_module_host,
      call(opPtr, opLen, ptr, len) {
        const call = decodeHostCall(new Uint8Array(memory.buffer).slice(ptr, ptr + len));
        calls.push(call);
        try {
          response = encodeHostCallResult({ ok: true, op: call.op, ...(answer(call.op, call) ?? {}) });
        } catch (error) {
          response = encodeHostCallResult({ ok: false, error: { code: error.code ?? "failed", message: error.message } });
        }
        return 0;
      },
      response_len: () => response.length,
      read_response(dst, len) {
        const n = Math.min(len, response.length);
        new Uint8Array(memory.buffer).set(response.subarray(0, n), dst);
        return n;
      },
    };
    const result = await instantiate(source, { ...imports, space_data_module_host: host });
    const instance = result.instance ?? result;
    memory = instance.exports.memory;
    return result;
  };
  let harness;
  try {
    harness = await createBrowserModuleHarness({ wasmSource: readWasm(), manifest: readManifest(), surface: "direct", hostcallDispatch: () => { throw new Error("unused"); } });
  } finally {
    WebAssembly.instantiate = instantiate;
  }
  t.after(() => harness.destroy());
  return { harness, calls };
}

const NOW_MS = 1_791_900_000_123n;
const OMM_STREAM = recordStream("OMM", 3);
function storeHost({ config = {}, stream = OMM_STREAM, fail = {} } = {}) {
  return (op, call) => {
    if (fail[op]) throw fail[op];
    if (op === "clock.now") return { result: { UNIX_MS: NOW_MS } };
    if (op === "plugin.getConfig") return { raw: { config: encodeModuleConfig(config) } };
    if (op === "storage.flatsql_epoch_stream" || op === "storage.flatsql_query_stream") return { result: { ROWS: 3n, COLUMNS: 1 }, raw: { stream } };
    throw Object.assign(new Error(`unexpected hostcall ${op}`), { code: "unsupported" });
  };
}
const outputsOf = (result) => {
  assert.equal(result.statusCode, 0, result.errorMessage);
  return Object.fromEntries(result.outputs.map((o) => [o.portId, o.payload]));
};

test("data-source/retrieval passes SDK compliance with typed $QRP ports only", async () => {
  const report = await validateArtifactWithStandards({ manifest: readManifest(), wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  for (const method of readManifest().methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      assert.equal(port.acceptedTypeSets.length, 1, port.portId);
      assert.deepEqual(port.acceptedTypeSets[0].allowedTypes, [QRP_TYPE], `${method.methodId}.${port.portId}`);
    }
  }
});

test("data-source/retrieval imports only WASI and the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  assert.equal(inspection.profile, "module-host-abi");
  assert.deepEqual(Array.from(new Set(inspection.imports.map((e) => e.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});

test("omm_bulk: the request's stated fields win, the page carries the header then the records verbatim", async (t) => {
  const { harness, calls } = await harnessFor(t, storeHost({ config: { profiles: { "OMM.fbs": { profile: "forward", limit: 7 } } } }));
  const request = { SCHEMA_NAME: "OMM", FILE_IDENTIFIER: "$OMM", SOURCE_NAME: "celestrak", TIME_PROFILE: Q.qrpTimeProfile.AsOf, PROFILE_EPOCH_MS: 1_791_000_000_000n, LIMIT: 25, REPRESENTATION: Q.qrpRepresentation.Json, ETAG: "W/\"old\"" };
  const frame = requestFrame("request", request);
  const out = outputsOf(await harness.invoke({ methodId: "omm_bulk", inputs: [frame] }));
  assert.deepEqual(out.decision, frame.payload, "the request is passed on verbatim");

  const epoch = calls.find((c) => c.op === "storage.flatsql_epoch_stream");
  assert.deepEqual([epoch.params.SCHEMA, epoch.params.SOURCE, epoch.params.PROFILE, epoch.params.EPOCH, epoch.params.LIMIT, epoch.params.DELIVER], ["OMM.fbs", "celestrak", "as_of", 1_791_000_000, 25, 0]);
  assert.equal(calls.some((c) => c.op === "clock.now"), false, "a stated epoch needs no clock");

  const { header, records } = splitPage(out.page);
  assert.deepEqual(records, OMM_STREAM, "the record frames follow the header verbatim");
  assert.equal(header.KIND, Q.qrpKind.Page);
  assert.deepEqual([header.SCHEMA_NAME, header.FILE_IDENTIFIER, header.RECORD_COUNT, header.ETAG], ["OMM", "$OMM", 3, fnvEtag(OMM_STREAM)]);
  assert.deepEqual([header.SOURCE_NAME, header.TIME_PROFILE, Number(header.PROFILE_EPOCH_MS), header.LIMIT, header.REPRESENTATION], ["celestrak", Q.qrpTimeProfile.AsOf, 1_791_000_000_000, 25, Q.qrpRepresentation.Json]);
  assert.equal(header.HTTP_STATUS, 200);
  assert.deepEqual([Number(header.BODY_REF_TOKEN), Number(header.BODY_REF_SIZE)], [0, 0], "inline: no body reference");
});

test("omm_bulk: unstated fields come from the config, then the compiled fallback with epoch = clock.now", async (t) => {
  const config = { profiles: { "RFB.fbs": { profile: "forward", limit: 5000, source: "satnogs" }, "OMM.fbs": { limit: 9 } } };
  const stream = recordStream("RFB", 2);
  const { harness, calls } = await harnessFor(t, storeHost({ config, stream }));
  const out = outputsOf(await harness.invoke({ methodId: "omm_bulk", inputs: [requestFrame("request", { SCHEMA_NAME: "RFB" })] }));
  const epoch = calls.find((c) => c.op === "storage.flatsql_epoch_stream");
  assert.deepEqual([epoch.params.SCHEMA, epoch.params.SOURCE, epoch.params.PROFILE, epoch.params.LIMIT], ["RFB.fbs", "satnogs", "forward", 5000]);
  assert.equal(epoch.params.EPOCH, Number(NOW_MS) / 1000, "no stated or configured epoch: clock.now");
  const { header } = splitPage(out.page);
  assert.deepEqual([header.SCHEMA_NAME, header.FILE_IDENTIFIER, header.RECORD_COUNT, header.TIME_PROFILE, Number(header.PROFILE_EPOCH_MS), header.LIMIT], ["RFB", "$RFB", 2, Q.qrpTimeProfile.Forward, Number(NOW_MS), 5000]);
});

test("omm_bulk without a request frame resolves the defaults and answers the Request it served", async (t) => {
  const { harness, calls } = await harnessFor(t, storeHost());
  const out = outputsOf(await harness.invoke({ methodId: "omm_bulk", inputs: [] }));
  const epoch = calls.find((c) => c.op === "storage.flatsql_epoch_stream");
  assert.deepEqual([epoch.params.SCHEMA, epoch.params.SOURCE, epoch.params.PROFILE, epoch.params.LIMIT, epoch.params.EPOCH], ["OMM.fbs", null, "nearest", 50000, Number(NOW_MS) / 1000], "SOURCE unset: every source");
  const decision = decodeQrp(out.decision);
  assert.deepEqual([decision.KIND, decision.SCHEMA_NAME, decision.TIME_PROFILE, decision.LIMIT, Number(decision.PROFILE_EPOCH_MS)], [Q.qrpKind.Request, "OMM", Q.qrpTimeProfile.Nearest, 50000, Number(NOW_MS)]);
  assert.equal(splitPage(out.page).header.RECORD_COUNT, 3);
});

test("omm_bulk refusals: Latest, an over-bound source, no clock, a host failure; an upstream Error passes on", async (t) => {
  const { harness, calls } = await harnessFor(t, storeHost({ fail: { "clock.now": Object.assign(new Error("clock not granted"), { code: "not-authorized" }) } }));
  const refusal = async (fields) => {
    const out = outputsOf(await harness.invoke({ methodId: "omm_bulk", inputs: [requestFrame("request", { REPRESENTATION: Q.qrpRepresentation.Json, ETAG: "W/\"x\"", ...fields })] }));
    assert.equal(out.page, undefined, "no page beside an error");
    const error = decodeQrp(out.decision);
    assert.equal(error.KIND, Q.qrpKind.Error);
    assert.equal(error.REPRESENTATION, Q.qrpRepresentation.Json, "the representation is carried");
    assert.equal(error.ETAG, "W/\"x\"");
    assert.equal(error.HTTP_STATUS, { "invalid-profile": 400, "invalid-parameter": 400, "window-unsupported": 400, unavailable: 503 }[error.ERROR_CODE], error.ERROR_CODE);
    return error;
  };
  assert.equal((await refusal({ TIME_PROFILE: Q.qrpTimeProfile.Latest })).ERROR_CODE, "invalid-profile");
  const long = await refusal({ SOURCE_NAME: "s".repeat(129), PROFILE_EPOCH_MS: 1000n });
  assert.equal(long.ERROR_CODE, "invalid-parameter");
  assert.match(long.MESSAGE, /SOURCE_NAME is 129 bytes; .* at most 128/);
  assert.equal((await refusal({})).ERROR_CODE, "unavailable", "no stated epoch and no clock");
  assert.equal(calls.some((c) => c.op === "storage.flatsql_epoch_stream"), false, "nothing reached the store");

  const failing = await harnessFor(t, storeHost({ fail: { "storage.flatsql_epoch_stream": Object.assign(new Error("engine closed"), { code: "failed" }) } }));
  const failed = decodeQrp(outputsOf(await failing.harness.invoke({ methodId: "omm_bulk", inputs: [requestFrame("request", { PROFILE_EPOCH_MS: 1000n })] })).decision);
  assert.deepEqual([failed.KIND, failed.ERROR_CODE, failed.HTTP_STATUS], [Q.qrpKind.Error, "host-failed", 502]);
  assert.match(failed.MESSAGE, /engine closed/);

  const upstream = { portId: "request", typeRef: QRP_TYPE, payload: qrp({ KIND: Q.qrpKind.Error, ERROR_CODE: "no-route", MESSAGE: "x" }) };
  const passed = outputsOf(await harness.invoke({ methodId: "omm_bulk", inputs: [upstream] }));
  assert.deepEqual(passed.decision, upstream.payload);
});

test("data_query: SQL + typed parameters become the $PIV raw sql and tagged raw params; the page names the first frame's standard", async (t) => {
  const stream = recordStream("CAT", 4);
  const { harness, calls } = await harnessFor(t, storeHost({ stream }));
  const sql = "SELECT _data FROM CAT WHERE NORAD_CAT_ID = ? AND OBJECT_NAME LIKE ? AND RCS > ? AND DECAYED = ? AND X IS ?";
  const params = [
    { KIND: Q.qrpValueKind.Int, INT_VALUE: 25544n }, { KIND: Q.qrpValueKind.Text, TEXT_VALUE: "ISS%" }, { KIND: Q.qrpValueKind.Float, FLOAT_VALUE: 0.5 },
    { KIND: Q.qrpValueKind.Bool, BOOL_VALUE: true }, { KIND: Q.qrpValueKind.Null },
  ];
  const frame = requestFrame("query", { SQL: sql, PARAMETERS: params, ETAG: "W/\"y\"" });
  const out = outputsOf(await harness.invoke({ methodId: "data_query", inputs: [frame] }));
  assert.deepEqual(out.decision, frame.payload);
  const [call] = calls;
  assert.equal(call.op, "storage.flatsql_query_stream");
  assert.equal(new TextDecoder().decode(call.raw.sql), sql);
  assert.equal(call.params.DELIVER, 1, "a FlatBuffer answer asks for Ref delivery (the host here answers inline anyway)");
  assert.equal(call.lists.sql_params, undefined, "no SqlValue list any more");
  assert.deepEqual(decodeSqlValues(call.raw.params), [{ t: "i64", v: 25544n }, { t: "str", v: "ISS%" }, { t: "f64", v: 0.5 }, { t: "bool", v: true }, { t: "null", v: null }]);
  const { header, records } = splitPage(out.page);
  assert.deepEqual(records, stream);
  assert.deepEqual([header.KIND, header.SCHEMA_NAME, header.FILE_IDENTIFIER, header.RECORD_COUNT, header.ETAG, header.SQL], [Q.qrpKind.Page, "CAT", "$CAT", 4, fnvEtag(stream), null]);
});

test("data_query: an empty result answers an empty page; refusals and host failures answer $QRP Errors", async (t) => {
  const empty = await harnessFor(t, storeHost({ stream: new Uint8Array(0) }));
  const page = splitPage(outputsOf(await empty.harness.invoke({ methodId: "data_query", inputs: [requestFrame("query", { SQL: "SELECT 1 WHERE 0" })] })).page);
  assert.deepEqual([page.header.RECORD_COUNT, page.records.length, page.header.ETAG], [0, 0, fnvEtag(new Uint8Array(0))]);

  const { harness, calls } = await harnessFor(t, storeHost());
  const code = async (fields) => decodeQrp(outputsOf(await harness.invoke({ methodId: "data_query", inputs: [requestFrame("query", fields)] })).decision);
  assert.equal((await code({})).ERROR_CODE, "missing-sql");
  assert.equal(calls.length, 0, "refusals never reach the store");
  // bytes and text of any length travel in the tagged encoding (no 255-byte bound)
  const long = "t".repeat(70_000);
  assert.equal((await code({ SQL: "SELECT ?, ?", PARAMETERS: [{ KIND: Q.qrpValueKind.Bytes, BYTES_VALUE: [1, 2] }, { KIND: Q.qrpValueKind.Text, TEXT_VALUE: long }] })).KIND, Q.qrpKind.Request);
  const [bytes, text] = decodeSqlValues(calls.at(-1).raw.params);
  assert.deepEqual([bytes.t, Array.from(bytes.v), text.t, text.v.length], ["bytes", [1, 2], "str", long.length]);

  const sqlError = await harnessFor(t, storeHost({ fail: { "storage.flatsql_query_stream": Object.assign(new Error("SQL error: no such table: NOPE"), { code: "failed" }) } }));
  assert.equal(decodeQrp(outputsOf(await sqlError.harness.invoke({ methodId: "data_query", inputs: [requestFrame("query", { SQL: "SELECT * FROM NOPE" })] })).decision).ERROR_CODE, "query-failed");
  const down = await harnessFor(t, storeHost({ fail: { "storage.flatsql_query_stream": Object.assign(new Error("store unavailable"), { code: "failed" }) } }));
  assert.equal(decodeQrp(outputsOf(await down.harness.invoke({ methodId: "data_query", inputs: [requestFrame("query", { SQL: "SELECT 1" })] })).decision).ERROR_CODE, "host-failed");
});

test("a frame that is not a $QRP is refused", async (t) => {
  const { harness } = await harnessFor(t, storeHost());
  const result = await harness.invoke({ methodId: "data_query", inputs: [{ portId: "query", typeRef: QRP_TYPE, payload: new TextEncoder().encode('{"sql":"SELECT 1"}') }] });
  assert.notEqual(result.statusCode, 0);
  assert.equal(result.errorCode, "invalid-request-frame");
});

// The compiled flow runtime drains a node's queue port-blind (maxStreams is declarative only), so a surplus frame on a
// single-stream port is refused by name rather than silently destroyed (graph: modules-guest-nodes-drop-batched-frames).
test("surplus frames are refused, never dropped", async (t) => {
  const { harness, calls } = await harnessFor(t, storeHost());
  for (const [methodId, port] of [["omm_bulk", "request"], ["data_query", "query"]]) {
    const result = await harness.invoke({ methodId, inputs: [requestFrame(port, { SQL: "SELECT 1" }), requestFrame(port, { SQL: "SELECT 2" })] });
    assert.equal(result.errorCode, "batched-input-frames");
    assert.match(result.errorMessage, new RegExp(`2 frames on single-stream input port "${port}"`));
    assert.equal(result.outputs.length, 0);
  }
  assert.equal(calls.length, 0);
});

test("omm_bulk: TIME_PROFILE Unspecified defers to config / nearest; All reads every record of the lane in the window", async (t) => {
  const { harness, calls } = await harnessFor(t, storeHost({ config: { profiles: { "OMM.fbs": { profile: "as_of" } } } }));
  const unstated = outputsOf(await harness.invoke({ methodId: "omm_bulk", inputs: [requestFrame("request", { SCHEMA_NAME: "OMM", PROFILE_EPOCH_MS: 1000n })] }));
  assert.equal(calls.at(-1).op, "storage.flatsql_epoch_stream");
  assert.equal(calls.at(-1).params.PROFILE, "as_of", "Unspecified: the configured default");
  assert.equal(splitPage(unstated.page).header.TIME_PROFILE, Q.qrpTimeProfile.AsOf);

  const all = outputsOf(await harness.invoke({ methodId: "omm_bulk", inputs: [requestFrame("request", { SCHEMA_NAME: "OMM", TIME_PROFILE: Q.qrpTimeProfile.All, SOURCE_NAME: "celestrak", FROM_EPOCH_MS: 1_791_000_000_000n, TO_EPOCH_MS: 1_791_086_400_000n, LIMIT: 10 })] }));
  const call = calls.at(-1);
  assert.equal(call.op, "storage.flatsql_query_stream", "All is not a per-object profile: a plain query of the lane");
  assert.equal(new TextDecoder().decode(call.raw.sql), 'SELECT _data FROM "OMM" WHERE (?1 = \'\' OR _source = ?1) AND USER_DEFINED_EPOCH_TIMESTAMP >= ?2 AND USER_DEFINED_EPOCH_TIMESTAMP <= ?3 LIMIT ?4');
  assert.deepEqual(decodeSqlValues(call.raw.params).map((p) => p.v), ["OMM@celestrak", 1_791_000_000, 1_791_086_400, 10n]);
  assert.equal(call.params.DELIVER, 1);
  const { header, records } = splitPage(all.page);
  assert.deepEqual([header.TIME_PROFILE, header.RECORD_COUNT, header.HTTP_STATUS], [Q.qrpTimeProfile.All, 3, 200]);
  assert.deepEqual(records, OMM_STREAM);

  const everySource = outputsOf(await harness.invoke({ methodId: "omm_bulk", inputs: [requestFrame("request", { SCHEMA_NAME: "RFB", TIME_PROFILE: Q.qrpTimeProfile.All })] }));
  assert.equal(new TextDecoder().decode(calls.at(-1).raw.sql), 'SELECT _data FROM "RFB" WHERE (?1 = \'\' OR _source = ?1) LIMIT ?2');
  assert.deepEqual(decodeSqlValues(calls.at(-1).raw.params).map((p) => p.v), ["", 50000n]);
  assert.ok(everySource.page);
});

test("omm_bulk: an epoch window is served for $OMM with All only (400 window-unsupported otherwise, nothing reaches the store)", async (t) => {
  const { harness, calls } = await harnessFor(t, storeHost());
  for (const fields of [{ SCHEMA_NAME: "RFB", TIME_PROFILE: Q.qrpTimeProfile.All, FROM_EPOCH_MS: 1000n }, { SCHEMA_NAME: "OMM", TIME_PROFILE: Q.qrpTimeProfile.Nearest, TO_EPOCH_MS: 1000n, PROFILE_EPOCH_MS: 5n }]) {
    const error = decodeQrp(outputsOf(await harness.invoke({ methodId: "omm_bulk", inputs: [requestFrame("request", fields)] })).decision);
    assert.deepEqual([error.KIND, error.ERROR_CODE, error.HTTP_STATUS], [Q.qrpKind.Error, "window-unsupported", 400]);
  }
  assert.equal(calls.filter((c) => c.op.startsWith("storage.")).length, 0);
});

test("a host BodyRef answer (DELIVER Ref) makes the page the header alone, carrying the reference; Json asks Inline", async (t) => {
  const REF = { TOKEN: 77n, SIZE: 4096n, FRAMES: 12n, FNV1A64: "00000000deadbeef" };
  const refHost = (op, call) => (op.startsWith("storage.") ? { result: { ROWS: 12n, COLUMNS: 1, REF } } : storeHost()(op, call));
  const { harness, calls } = await harnessFor(t, refHost);
  for (const [methodId, port, fields] of [["omm_bulk", "request", { PROFILE_EPOCH_MS: 1000n }], ["data_query", "query", { SQL: "SELECT _data FROM OMM" }]]) {
    const out = outputsOf(await harness.invoke({ methodId, inputs: [requestFrame(port, fields)] }));
    assert.equal(calls.at(-1).params.DELIVER, 1, `${methodId}: Ref asked`);
    const v = new DataView(out.page.buffer, out.page.byteOffset, out.page.byteLength);
    const size = v.getUint32(0, true);
    assert.equal(out.page.length, 4 + size, "the header alone, no inline frames");
    const header = decodeQrp(out.page.subarray(4));
    assert.deepEqual([Number(header.BODY_REF_TOKEN), Number(header.BODY_REF_SIZE), header.RECORD_COUNT, header.ETAG, header.HTTP_STATUS, header.KIND],
      [77, 4096, 12, 'W/"fnv1a64-00000000deadbeef"', 200, Q.qrpKind.Page]);
  }
  await harness.invoke({ methodId: "data_query", inputs: [requestFrame("query", { SQL: "SELECT 1", REPRESENTATION: Q.qrpRepresentation.Json })] });
  assert.equal(calls.at(-1).params.DELIVER, 0, "Json: the responder renders the bytes, so they come inline");
});
