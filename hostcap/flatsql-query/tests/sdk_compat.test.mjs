import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { decodeHostCall, decodeSqlValues, encodeHostCallResult, encodeSqlValues } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

// hostcap/flatsql-query on the typed contracts (1.0): `query` takes a FlatSQL $FSO control frame and answers $FSB chunks
// + an $FSO status (the FlatSQL node's query_records contract); `sandbox_query` takes a QRP Request and answers the QRP
// decision + a QRP-headed page stream. Every host call is an SDS $PIV invocation, answered here on the wire so the tests
// assert the module's own request bytes (raw "sql", the tagged SQL values on raw "params", WANT / DELIVER).
const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

// The tagged SQL values on a call's raw "params" as [tag, value] (i64 as a Number).
const sqlParams = (call) => decodeSqlValues(call.raw.params).map(({ t, v }) => [t, t === "i64" ? Number(v) : v]);
const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const readWasm = () => fs.readFileSync(fileURLToPath(WASM_PATH));
const typeRef = (code) => ({ schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code, wireFormat: "flatbuffer" });

// The standards' own generated TS bindings, bundled with the standards repo's esbuild.
const FLATBUFFERS_PATH = fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"));
const flatbuffers = await import(pathToFileURL(FLATBUFFERS_PATH).href);
async function loadStandard(code) {
  const esbuild = await import(pathToFileURL(path.join(STANDARDS_ROOT, "node_modules", "esbuild", "lib", "main.js")).href);
  const out = await esbuild.build({ entryPoints: [path.join(STANDARDS_ROOT, "lib", "ts", code, "main.ts")], bundle: true, format: "esm", write: false, platform: "neutral", alias: { flatbuffers: FLATBUFFERS_PATH }, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
const FSO = await loadStandard("FSO");
const FSB = await loadStandard("FSB");
const QRP = await loadStandard("QRP");

function packed(Type, fields, id) {
  const object = Object.assign(new Type(), fields);
  const b = new flatbuffers.Builder(256);
  b.finish(object.pack(b), id);
  return b.asUint8Array();
}
const fsoFrame = (fields) => ({ portId: "query", typeRef: typeRef("FSO"), payload: packed(FSO.FSOT, fields, "$FSO") });
function qrpRequest(fields = {}) {
  const t = new QRP.QRPT();
  Object.assign(t, { KIND: QRP.qrpKind.Request }, fields);
  const b = new flatbuffers.Builder(256);
  b.finish(t.pack(b), "$QRP");
  return b.asUint8Array();
}
const qrpFrame = (port, fields) => ({ portId: port, typeRef: typeRef("QRP"), payload: qrpRequest(fields) });
const qrpValue = (fields) => Object.assign(new QRP.QRPValueT(), fields);
const decode = (Mod, root, bytes) => Mod[root][`getRootAs${root}`](new flatbuffers.ByteBuffer(bytes)).unpack();
const text = (v) => (v instanceof Uint8Array || Array.isArray(v) ? new TextDecoder().decode(Uint8Array.from(v)) : v);

// FlatSQL tagged parameters: [u8 tag][u32le size][bytes].
function tagged(params) {
  const parts = params.map(([tag, value]) => {
    let body;
    if (tag === 0) body = new Uint8Array(0);
    else if (tag === 1) body = Uint8Array.of(value ? 1 : 0);
    else if (tag === 2) { body = new Uint8Array(8); new DataView(body.buffer).setBigInt64(0, BigInt(value), true); }
    else if (tag === 3) { body = new Uint8Array(8); new DataView(body.buffer).setFloat64(0, value, true); }
    else body = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const out = new Uint8Array(5 + body.length);
    out[0] = tag; new DataView(out.buffer).setUint32(1, body.length, true); out.set(body, 5);
    return out;
  });
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { all.set(p, at); at += p.length; }
  return Array.from(all);
}

// A size-prefixed stream of `count` minimal FlatBuffers carrying file identifier `$CODE`, each padded to `size` bytes.
function recordStream(code, count, size = 16) {
  const out = new Uint8Array(count * (4 + size)), v = new DataView(out.buffer);
  for (let i = 0; i < count; i++) {
    const at = i * (4 + size);
    v.setUint32(at, size, true);
    v.setUint32(at + 4, 12, true);
    out.set(new TextEncoder().encode(`$${code}`), at + 8);
    v.setUint16(at + 12, 4, true); v.setUint16(at + 14, 4, true); v.setInt32(at + 16, 4, true);
    for (let j = 16; j < size; j++) out[at + 4 + j] = (i * 31 + j) & 0xff;
  }
  return out;
}
function fnvEtag(bytes) {
  const prime = 1099511628211n, mask = (1n << 64n) - 1n;
  let hash = 1469598103934665603n, i = 0;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (; i + 8 <= bytes.length; i += 8) hash = ((hash ^ v.getBigUint64(i, true)) * prime) & mask;
  for (; i < bytes.length; i++) hash = ((hash ^ BigInt(bytes[i])) * prime) & mask;
  return `W/"fnv1a64-${hash.toString(16).padStart(16, "0")}"`;
}

// The test's host: every $PIV call is decoded from guest memory, recorded, and answered by `answer(op, call)`
// ({ result, lists, raw }), or failed when it throws ({ code, message }).
async function harnessFor(t, answer) {
  const calls = [];
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (source, imports) => {
    let memory;
    let response = new Uint8Array(0);
    const host = {
      ...imports.space_data_module_host,
      call(opPtr, opLen, ptr, len) {
        const call = decodeHostCall(new Uint8Array(memory.buffer, ptr, len).slice());
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
    harness = await createBrowserModuleHarness({ wasmSource: readWasm(), manifest: readManifest(), surface: "direct", hostcallDispatch: () => { throw new Error("unreachable"); } });
  } finally {
    WebAssembly.instantiate = instantiate;
  }
  t.after(() => harness.destroy());
  return { harness, calls };
}
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

// Split one QRP page stream into its header and the record bytes that follow.
function splitPage(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = v.getUint32(0, true);
  const header = decode(QRP, "QRP", bytes.slice(4, 4 + size));
  const padded = (4 + size + 7) & ~7;
  assert.ok(bytes.slice(4 + size, padded).every((b) => b === 0), "the header frame is padded to 8 bytes with a zero-length prefix");
  return { header, records: bytes.slice(padded) };
}
function sandboxOutputs(result) {
  assert.equal(result.statusCode, 0, result.errorMessage);
  const decisions = result.outputs.filter((o) => o.portId === "decision");
  const pages = result.outputs.filter((o) => o.portId === "page");
  assert.equal(decisions.length, 1);
  return { decision: decode(QRP, "QRP", decisions[0].payload), decisionBytes: decisions[0].payload, page: pages[0] ? splitPage(pages[0].payload) : null };
}

// ---------------------------------------------------------------------------------------------------------------------

test("hostcap/flatsql-query passes SDK compliance with one concrete type per port", async () => {
  const manifest = readManifest();
  const report = await validateArtifactWithStandards({ manifest, wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const ids = {};
  for (const method of manifest.methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      assert.equal(port.acceptedTypeSets.length, 1);
      assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1);
      assert.equal(port.acceptedTypeSets[0].allowedTypes[0].acceptsAnyFlatbuffer, undefined);
      ids[`${method.methodId}.${port.portId}`] = port.acceptedTypeSets[0].allowedTypes[0].fileIdentifier;
    }
  }
  assert.deepEqual(ids, { "query.query": "$FSO", "query.records": "$FSB", "query.status": "$FSO", "sandbox_query.query": "$QRP", "sandbox_query.surface": "$QRP", "sandbox_query.decision": "$QRP", "sandbox_query.page": "$QRP" });
});

test("hostcap/flatsql-query imports only WASI and the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  assert.equal(inspection.profile, "module-host-abi");
  assert.deepEqual(Array.from(new Set(inspection.imports.map((e) => e.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});

// ---- query ------------------------------------------------------------------------------------------------------------

test("query: an $FSO becomes one typed storage.flatsql_query_stream; a > 1 MiB result answers two $FSB chunks + COMPLETE", async (t) => {
  const stream = recordStream("OMM", 20, 60000);  // 1,200,080 bytes
  const { harness, calls } = await harnessFor(t, (op) => {
    assert.equal(op, "storage.flatsql_query_stream");
    return { result: { ROWS: 20n, COLUMNS: 1 }, raw: { stream } };
  });
  const sql = "SELECT _data FROM OMM WHERE NORAD_CAT_ID > ? AND OBJECT_NAME = ? AND MEAN_MOTION < ? AND DECAYED = ? AND X IS ?";
  const result = await harness.invoke({ methodId: "query", inputs: [fsoFrame({
    OPERATION: FSO.flatSqlNodeOperation.QUERY_RECORDS, REQUEST_ID: 77n, QUERY: Array.from(new TextEncoder().encode(sql)),
    PARAMETERS: tagged([[2, 25544], [4, "ISS (ZARYA)"], [3, 15.5], [1, true], [0]]), PARAMETER_COUNT: 5,
  })] });
  assert.equal(result.statusCode, 0, result.errorMessage);

  const [call] = calls;
  assert.equal(text(call.raw.sql), sql);
  assert.equal(call.params.DELIVER, 0, "deliver Inline");
  assert.deepEqual(sqlParams(call), [["i64", 25544], ["str", "ISS (ZARYA)"], ["f64", 15.5], ["bool", true], ["null", null]]);
  assert.deepEqual(call.raw.params, Uint8Array.from(tagged([[2, 25544], [4, "ISS (ZARYA)"], [3, 15.5], [1, true], [0]])), "the $FSO PARAMETERS travel verbatim");

  const chunks = result.outputs.filter((o) => o.portId === "records").map((o) => decode(FSB, "FSB", o.payload));
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((c) => [c.CHUNK_SEQUENCE, c.FINAL, c.KIND, Number(c.REQUEST_ID), Number(c.TOTAL_BYTES), Number(c.RECORD_COUNT), c.COLUMN_COUNT]),
    [[0, false, FSB.flatSqlByteStreamKind.QUERY_RESULT, 77, stream.length, 20, 1], [1, true, FSB.flatSqlByteStreamKind.QUERY_RESULT, 77, stream.length, 20, 1]]);
  assert.equal(chunks[0].DATA.length, 1024 * 1024);
  assert.deepEqual(Uint8Array.from([...chunks[0].DATA, ...chunks[1].DATA]), stream, "the chunks reassemble the stream verbatim");

  const statuses = result.outputs.filter((o) => o.portId === "status").map((o) => decode(FSO, "FSO", o.payload));
  assert.equal(statuses.length, 1);
  assert.deepEqual([statuses[0].OPERATION, statuses[0].STATUS, Number(statuses[0].AFFECTED_RECORDS), Number(statuses[0].RESULT_BYTES), Number(statuses[0].REQUEST_ID)],
    [FSO.flatSqlNodeOperation.QUERY_RECORDS, FSO.flatSqlNodeStatus.COMPLETE, 20, stream.length, 77]);
  assert.equal(result.outputs.at(-1).portId, "status", "status follows the chunks");
});

test("query: an empty result still answers one FINAL chunk", async (t) => {
  const { harness } = await harnessFor(t, () => ({ result: { ROWS: 0n, COLUMNS: 0 }, raw: { stream: new Uint8Array(0) } }));
  const result = await harness.invoke({ methodId: "query", inputs: [fsoFrame({ OPERATION: FSO.flatSqlNodeOperation.QUERY_RECORDS, QUERY: Array.from(new TextEncoder().encode("SELECT 1 WHERE 0")) })] });
  const chunks = result.outputs.filter((o) => o.portId === "records").map((o) => decode(FSB, "FSB", o.payload));
  assert.deepEqual(chunks.map((c) => [c.CHUNK_SEQUENCE, c.FINAL, c.DATA.length]), [[0, true, 0]]);
});

test("query: bytes and long text travel verbatim; a malformed control frame is refused on status with no hostcall", async (t) => {
  const carried = await harnessFor(t, () => ({ result: { ROWS: 0n, COLUMNS: 0 }, raw: { stream: new Uint8Array(0) } }));
  const params = tagged([[2, 1], [5, Uint8Array.of(1, 2, 3)], [4, "x".repeat(70_000)]]);
  const ok = await carried.harness.invoke({ methodId: "query", inputs: [fsoFrame({ OPERATION: FSO.flatSqlNodeOperation.QUERY_RECORDS, REQUEST_ID: 5n, QUERY: Array.from(new TextEncoder().encode("SELECT ?, ?, ?")), PARAMETERS: params, PARAMETER_COUNT: 3 })] });
  assert.equal(decode(FSO, "FSO", ok.outputs.at(-1).payload).STATUS, FSO.flatSqlNodeStatus.COMPLETE);
  assert.deepEqual(carried.calls[0].raw.params, Uint8Array.from(params));
  assert.deepEqual(sqlParams(carried.calls[0]).map(([t, v]) => [t, t === "str" ? v.length : t === "bytes" ? Array.from(v) : v]), [["i64", 1], ["bytes", [1, 2, 3]], ["str", 70_000]]);

  const { harness, calls } = await harnessFor(t, () => assert.fail("no hostcall"));
  const sql = Array.from(new TextEncoder().encode("SELECT ?"));
  const statusOf = async (fields) => {
    const result = await harness.invoke({ methodId: "query", inputs: [fsoFrame({ OPERATION: FSO.flatSqlNodeOperation.QUERY_RECORDS, REQUEST_ID: 5n, QUERY: sql, ...fields })] });
    assert.equal(result.statusCode, 0, "database-semantics failures answer on status, invoke OK");
    assert.equal(result.outputs.length, 1);
    const s = decode(FSO, "FSO", result.outputs[0].payload);
    return [s.STATUS, s.ERROR_CODE, text(s.MESSAGE), Number(s.REQUEST_ID)];
  };
  const [st, code, message, id] = await statusOf({ PARAMETERS: tagged([[2, 1], [9, Uint8Array.of(1)]]), PARAMETER_COUNT: 2 });
  assert.deepEqual([st, code, id], [FSO.flatSqlNodeStatus.INVALID_ARGUMENT, "invalid-control-frame", 5]);
  assert.match(message, /Unsupported query parameter tag/);
  assert.match((await statusOf({ PARAMETERS: tagged([[2, 1]]), PARAMETER_COUNT: 2 }))[2], /Malformed query parameter payload/);
  assert.deepEqual((await statusOf({ PARAMETERS: tagged([[2, 1]]).slice(0, 7), PARAMETER_COUNT: 1 })).slice(0, 2), [FSO.flatSqlNodeStatus.INVALID_ARGUMENT, "invalid-control-frame"]);
  assert.match((await statusOf({ OPERATION: FSO.flatSqlNodeOperation.COMPACT }))[2], /requires QUERY_RECORDS/);
  assert.match((await statusOf({ QUERY: [] }))[2], /requires SQL bytes/);
  assert.equal(calls.length, 0);
});

test("query: a host failure answers a status naming it", async (t) => {
  const { harness } = await harnessFor(t, () => fail("invalid-params", "SQL error: no such table: NOPE"));
  const result = await harness.invoke({ methodId: "query", inputs: [fsoFrame({ OPERATION: FSO.flatSqlNodeOperation.QUERY_RECORDS, QUERY: Array.from(new TextEncoder().encode("SELECT * FROM NOPE")) })] });
  assert.equal(result.statusCode, 0);
  assert.deepEqual(result.outputs.map((o) => o.portId), ["status"]);
  const s = decode(FSO, "FSO", result.outputs[0].payload);
  assert.deepEqual([s.STATUS, s.ERROR_CODE, text(s.MESSAGE)], [FSO.flatSqlNodeStatus.INVALID_ARGUMENT, "query-failed", "invalid-params: SQL error: no such table: NOPE"]);
  const { harness: slow } = await harnessFor(t, () => fail("timeout", "statement timeout"));
  const late = decode(FSO, "FSO", (await slow.invoke({ methodId: "query", inputs: [fsoFrame({ OPERATION: FSO.flatSqlNodeOperation.QUERY_RECORDS, QUERY: [83] })] })).outputs[0].payload);
  assert.equal(late.STATUS, FSO.flatSqlNodeStatus.RESOURCE_EXHAUSTED);
});

// ---- sandbox_query ------------------------------------------------------------------------------------------------------

test("sandbox_query: raw SQL is wrapped with sort/limit; a Stream answer is a page header + the records verbatim", async (t) => {
  const stream = recordStream("OMM", 3);
  const { harness, calls } = await harnessFor(t, (op) => {
    assert.equal(op, "storage.query_sandboxed");
    return { result: { KIND: 0, ROWS: 3n, COLUMNS: 1 }, raw: { stream } };
  });
  const request = { SQL: "SELECT _data FROM OMM WHERE NORAD_CAT_ID > ?", PARAMETERS: [qrpValue({ KIND: QRP.qrpValueKind.Int, INT_VALUE: 40000n })], SORT_FIELD: "EPOCH", SORT_DESC: true, LIMIT: 10, ETAG: "W/\"x\"" };
  const frame = qrpFrame("query", request);
  const { decisionBytes, page } = sandboxOutputs(await harness.invoke({ methodId: "sandbox_query", inputs: [frame] }));
  assert.deepEqual(decisionBytes, frame.payload, "the request is passed on verbatim");
  const [call] = calls;
  assert.equal(text(call.raw.sql), "SELECT * FROM (SELECT _data FROM OMM WHERE NORAD_CAT_ID > ?) ORDER BY \"EPOCH\" DESC LIMIT 10");
  assert.deepEqual([call.params.WANT, call.params.DELIVER], [0, 1], "WANT Stream, DELIVER Ref (the host here answers inline anyway)");
  assert.deepEqual(sqlParams(call), [["i64", 40000]]);
  assert.deepEqual([page.header.KIND, page.header.STATUS, page.header.FILE_IDENTIFIER, page.header.SCHEMA_NAME, page.header.RECORD_COUNT, Number(page.header.TOTAL_COUNT), page.header.ETAG],
    [QRP.qrpKind.Page, QRP.qrpStatus.Ok, "$OMM", "OMM", 3, 3, fnvEtag(stream)]);
  assert.deepEqual([page.header.HTTP_STATUS, Number(page.header.BODY_REF_TOKEN)], [200, 0]);
  assert.deepEqual(page.records, stream);
});

test("sandbox_query: a time profile runs the unified-OMM-view SQL; epoch 0 defaults to clock.now; Json asks WANT Auto", async (t) => {
  const NOW = 1_791_900_000_500;
  const { harness, calls } = await harnessFor(t, (op) => (op === "clock.now" ? { result: { UNIX_MS: BigInt(NOW) } } : { result: { KIND: 0, ROWS: 0n }, raw: { stream: new Uint8Array(0) } }));
  const { page } = sandboxOutputs(await harness.invoke({ methodId: "sandbox_query", inputs: [qrpFrame("query", { TIME_PROFILE: QRP.qrpTimeProfile.AsOf, SOURCE_NAME: "celestrak", REPRESENTATION: QRP.qrpRepresentation.Json })] }));
  assert.deepEqual(calls.map((c) => c.op), ["clock.now", "storage.query_sandboxed"]);
  const call = calls[1];
  assert.match(text(call.raw.sql), /ORDER BY USER_DEFINED_EPOCH_TIMESTAMP DESC\) rn FROM OMM WHERE \(\?1 = '' OR _source = \?1\) AND USER_DEFINED_EPOCH_TIMESTAMP <= \?2\) WHERE rn = 1 LIMIT \?3$/);
  assert.deepEqual([call.params.WANT, call.params.DELIVER], [2, 0], "WANT Auto and DELIVER Inline for Json: the responder renders the bytes");
  assert.deepEqual(sqlParams(call), [["str", "OMM@celestrak"], ["f64", NOW / 1000], ["i64", 50000]]);
  assert.deepEqual([page.header.TIME_PROFILE, Number(page.header.PROFILE_EPOCH_MS), page.header.LIMIT, page.header.REPRESENTATION, page.header.FILE_IDENTIFIER, page.header.RECORD_COUNT],
    [QRP.qrpTimeProfile.AsOf, NOW, 50000, QRP.qrpRepresentation.Json, "$OMM", 0]);

  const { harness: given, calls: givenCalls } = await harnessFor(t, () => ({ result: { KIND: 0 }, raw: { stream: new Uint8Array(0) } }));
  sandboxOutputs(await given.invoke({ methodId: "sandbox_query", inputs: [qrpFrame("query", { TIME_PROFILE: QRP.qrpTimeProfile.Nearest, PROFILE_EPOCH_MS: 1_700_000_000_000n, LIMIT: 7 })] }));
  assert.deepEqual(givenCalls.map((c) => c.op), ["storage.query_sandboxed"], "a stated epoch needs no clock");
  assert.match(text(givenCalls[0].raw.sql), /ABS\(USER_DEFINED_EPOCH_TIMESTAMP - \?2\)/);
  assert.deepEqual(sqlParams(givenCalls[0]).map(([, v]) => v), ["", 1_700_000_000, 7]);
});

test("sandbox_query: a Rows answer is a projection page (COLUMNS + ROWS) with an ETag over the header", async (t) => {
  const { harness } = await harnessFor(t, () => ({
    result: { KIND: 1, ROWS: 2n, COLUMNS: 2 },
    lists: { columns: [{ VALUE: "NORAD_CAT_ID" }, { VALUE: "OBJECT_NAME" }] },
    raw: { cells: encodeSqlValues([{ t: "i64", v: 25544n }, { t: "str", v: "ISS (ZARYA)" }, { t: "i64", v: 20580n }, { t: "null" }]) },
  }));
  const { page } = sandboxOutputs(await harness.invoke({ methodId: "sandbox_query", inputs: [qrpFrame("query", { SQL: "SELECT NORAD_CAT_ID, OBJECT_NAME FROM OMM", REPRESENTATION: QRP.qrpRepresentation.Json })] }));
  assert.deepEqual(page.header.COLUMNS.map((c) => c.NAME), ["NORAD_CAT_ID", "OBJECT_NAME"]);
  assert.deepEqual(page.header.ROWS.map((r) => r.CELLS.map((c) => [c.KIND, c.KIND === QRP.qrpValueKind.Int ? Number(c.INT_VALUE) : c.TEXT_VALUE])),
    [[[QRP.qrpValueKind.Int, 25544], [QRP.qrpValueKind.Text, "ISS (ZARYA)"]], [[QRP.qrpValueKind.Int, 20580], [QRP.qrpValueKind.Null, null]]]);
  assert.deepEqual([page.header.RECORD_COUNT, Number(page.header.TOTAL_COUNT)], [0, 2]);
  assert.match(page.header.ETAG, /^W\/"fnv1a64-[0-9a-f]{16}"$/);
  assert.equal(page.records.length, 0);
  const again = sandboxOutputs(await harness.invoke({ methodId: "sandbox_query", inputs: [qrpFrame("query", { SQL: "SELECT NORAD_CAT_ID, OBJECT_NAME FROM OMM", REPRESENTATION: QRP.qrpRepresentation.Json })] }));
  assert.equal(again.page.header.ETAG, page.header.ETAG, "equal answers carry equal tags");
});

test("sandbox_query: the surface request lists tables, columns and the serving limits", async (t) => {
  const { harness, calls } = await harnessFor(t, (op) => {
    assert.equal(op, "storage.query_surface");
    return {
      result: { TIMEOUT_MS: 5000, MAX_ROWS: 100000n, MAX_BYTES: 67108864n },
      lists: { tables: [{ NAME: "OMM", KIND: "standard", SOURCE: "OMM", RECORDS: 31000n }, { NAME: "OMM@celestrak", KIND: "lane", SOURCE: "celestrak", RECORDS: -1n }, { NAME: "LDM", KIND: "view", SOURCE: "LDM", RECORDS: 0n }],
        // LDM's first field is a sub-table: its SITE column is the engine's >=1-column placeholder (a one-byte read of
        // slot 0, never the site), which the host marks PLACEHOLDER. It is not advertised; `_data` is the honest column.
        columns: [{ TABLE: "OMM", NAME: "NORAD_CAT_ID" }, { TABLE: "OMM", NAME: "EPOCH" }, { TABLE: "OMM@celestrak", NAME: "_data" },
          { TABLE: "LDM", NAME: "SITE", PLACEHOLDER: true }, { TABLE: "LDM", NAME: "_data" }] },
    };
  });
  const frame = qrpFrame("surface", { ETAG: "W/\"old\"" });
  const { decisionBytes, page } = sandboxOutputs(await harness.invoke({ methodId: "sandbox_query", inputs: [frame] }));
  assert.deepEqual(decisionBytes, frame.payload);
  assert.equal(calls.length, 1);
  assert.deepEqual([page.header.MAX_ELAPSED_MS, Number(page.header.MAX_ROWS), Number(page.header.MAX_BYTES)], [5000, 100000, 67108864]);
  assert.deepEqual(page.header.TABLES.map((tb) => [tb.NAME, tb.KIND, tb.SOURCE, Number(tb.RECORDS), tb.COLUMNS.map((c) => c.NAME)]),
    [["OMM", "standard", "OMM", 31000, ["NORAD_CAT_ID", "EPOCH"]], ["OMM@celestrak", "lane", "celestrak", -1, ["_data"]], ["LDM", "view", "LDM", 0, ["_data"]]]);
  assert.match(page.header.ETAG, /^W\/"fnv1a64-/);

  const { harness: down } = await harnessFor(t, () => fail("failed", "engine not open"));
  const { decision, page: none } = sandboxOutputs(await down.invoke({ methodId: "sandbox_query", inputs: [qrpFrame("surface", {})] }));
  assert.deepEqual([decision.KIND, decision.ERROR_CODE, decision.MESSAGE, none], [QRP.qrpKind.Error, "host-failed", "engine not open", null]);
});

test("sandbox_query: refusals before the host and every host error map to QRP Error codes", async (t) => {
  const { harness, calls } = await harnessFor(t, () => assert.fail("no hostcall"));
  const refusal = async (fields) => {
    const { decision, page } = sandboxOutputs(await harness.invoke({ methodId: "sandbox_query", inputs: [qrpFrame("query", { REPRESENTATION: QRP.qrpRepresentation.Json, ETAG: "W/\"e\"", ...fields })] }));
    assert.equal(page, null);
    assert.deepEqual([decision.KIND, decision.STATUS, decision.REPRESENTATION, decision.ETAG, decision.HTTP_STATUS], [QRP.qrpKind.Error, QRP.qrpStatus.Error, QRP.qrpRepresentation.Json, "W/\"e\"", 400]);
    return decision.ERROR_CODE;
  };
  assert.equal(await refusal({}), "missing-sql");
  assert.equal(await refusal({ SQL: "SELECT 1", TIME_PROFILE: QRP.qrpTimeProfile.Nearest }), "ambiguous-query");
  assert.equal(await refusal({ TIME_PROFILE: QRP.qrpTimeProfile.Latest }), "invalid-profile");
  assert.equal(await refusal({ SQL: "SELECT 1", TIME_PROFILE: QRP.qrpTimeProfile.All }), "ambiguous-query");
  assert.equal(await refusal({ SQL: "SELECT 1", FROM_EPOCH_MS: 1000n }), "window-unsupported");
  assert.equal(await refusal({ TIME_PROFILE: QRP.qrpTimeProfile.Nearest, TO_EPOCH_MS: 1000n }), "window-unsupported");
  assert.equal(await refusal({ SQL: "SELECT 1", SORT_FIELD: "EPOCH; DROP" }), "invalid-sort");
  assert.equal(calls.length, 0);

  const cases = [
    ["timeout", "statement timeout after 5000 ms", "timeout"],
    ["too-large", "row-cap: more than 100000 rows", "too-large"],
    ["invalid-params", "not-a-record-stream: projection requested as flatbuffer", "not-acceptable"],
    ["sandbox", "not-authorized: table _secrets", "query-failed"],
    // The node's own sandbox rejections: hostcall code "sandbox", engine message "sandbox: <code>: <detail>"
    // (flatsqlrt.SandboxError). The engine's code is the public one.
    ["sandbox", "sandbox: not-authorized: UPDATE is not permitted (read-only SELECT sandbox)", "not-authorized"],
    ["sandbox", "sandbox: multi-statement: more than one statement", "multi-statement"],
    ["sandbox", "sandbox: timeout: statement exceeded its deadline", "timeout"],
    ["sandbox", "sandbox: row-cap: result exceeds 100 rows", "row-cap"],
    ["sandbox", "sandbox: byte-cap: result exceeds 1048576 bytes", "byte-cap"],
    ["sandbox", "sandbox: something-new: an engine code this module does not know", "query-failed"],
    ["not-authorized", "authorizer denied", "query-failed"],
    ["failed", "SQL error: near \"SELEC\": syntax error", "query-failed"],
    ["failed", "engine crashed", "host-failed"],
  ];
  const statusOf = { timeout: 422, "too-large": 422, "row-cap": 422, "byte-cap": 422, "not-acceptable": 406, "query-failed": 400,
    "not-authorized": 400, "multi-statement": 400, "host-failed": 502 };
  for (const [code, message, expected] of cases) {
    const { harness: h } = await harnessFor(t, () => fail(code, message));
    const { decision, page } = sandboxOutputs(await h.invoke({ methodId: "sandbox_query", inputs: [qrpFrame("query", { SQL: "SELECT 1" })] }));
    assert.equal(decision.ERROR_CODE, expected, `${code}: ${message}`);
    assert.equal(decision.HTTP_STATUS, statusOf[expected], `${expected} HTTP_STATUS`);
    assert.equal(page, null);
    if (expected === "not-acceptable") assert.match(decision.MESSAGE, /request format=json for projection results$/);
  }
});

test("sandbox_query takes exactly one request frame; surplus frames are refused, never dropped", async (t) => {
  const { harness, calls } = await harnessFor(t, () => assert.fail("no hostcall"));
  const neither = await harness.invoke({ methodId: "sandbox_query", inputs: [] });
  assert.equal(neither.errorCode, "missing-request-frame");
  const both = await harness.invoke({ methodId: "sandbox_query", inputs: [qrpFrame("query", { SQL: "SELECT 1" }), qrpFrame("surface", {})] });
  assert.equal(both.errorCode, "ambiguous-request");
  const twice = await harness.invoke({ methodId: "sandbox_query", inputs: [qrpFrame("query", { SQL: "SELECT 1" }), qrpFrame("query", { SQL: "SELECT 2" })] });
  assert.equal(twice.errorCode, "batched-input-frames");
  assert.match(twice.errorMessage, /2 frames on single-stream input port "query"/);
  const fsoTwice = await harness.invoke({ methodId: "query", inputs: [fsoFrame({ OPERATION: FSO.flatSqlNodeOperation.QUERY_RECORDS, QUERY: [83] }), fsoFrame({ OPERATION: FSO.flatSqlNodeOperation.QUERY_RECORDS, QUERY: [83] })] });
  assert.equal(fsoTwice.errorCode, "batched-input-frames");
  for (const r of [neither, both, twice, fsoTwice]) assert.equal(r.outputs.length, 0);
  assert.equal(calls.length, 0);
});

test("the source contains no port-blind plugin_get_input_frame(0)", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/flatsql_query_module.cpp", import.meta.url)), "utf8");
  assert.deepEqual(source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && line.includes("plugin_get_input_frame(0)")), []);
});

test("sandbox_query: TIME_PROFILE All reads every unified-OMM-view record of the source in the window; Unspecified needs SQL", async (t) => {
  const stream = recordStream("OMM", 2);
  const { harness, calls } = await harnessFor(t, () => ({ result: { KIND: 0, ROWS: 2n }, raw: { stream } }));
  const { page } = sandboxOutputs(await harness.invoke({ methodId: "sandbox_query", inputs: [qrpFrame("query", { TIME_PROFILE: QRP.qrpTimeProfile.All, SOURCE_NAME: "celestrak", FROM_EPOCH_MS: 1_791_000_000_000n, TO_EPOCH_MS: 1_791_086_400_000n })] }));
  const [call] = calls;
  assert.equal(text(call.raw.sql), "SELECT _data FROM OMM WHERE (?1 = '' OR _source = ?1) AND USER_DEFINED_EPOCH_TIMESTAMP >= ?2 AND USER_DEFINED_EPOCH_TIMESTAMP <= ?3 LIMIT ?4");
  assert.deepEqual(sqlParams(call).map(([, v]) => v), ["OMM@celestrak", 1_791_000_000, 1_791_086_400, 50000]);
  assert.equal(calls.some((c) => c.op === "clock.now"), false, "All needs no reference instant");
  assert.deepEqual([page.header.TIME_PROFILE, page.header.RECORD_COUNT, page.header.LIMIT, Number(page.header.FROM_EPOCH_MS), page.header.HTTP_STATUS], [QRP.qrpTimeProfile.All, 2, 50000, 1_791_000_000_000, 200]);
  assert.deepEqual(page.records, stream);

  const { harness: open } = await harnessFor(t, () => ({ result: { KIND: 0 }, raw: { stream: new Uint8Array(0) } }));
  const unspecified = sandboxOutputs(await open.invoke({ methodId: "sandbox_query", inputs: [qrpFrame("query", { TIME_PROFILE: QRP.qrpTimeProfile.Unspecified })] }));
  assert.equal(unspecified.decision.ERROR_CODE, "missing-sql", "Unspecified is no profile: SQL is required");
});

test("sandbox_query: a host BodyRef answer makes the page the header alone carrying the reference", async (t) => {
  const { harness, calls } = await harnessFor(t, () => ({ result: { KIND: 0, ROWS: 9n, COLUMNS: 1, REF: { TOKEN: 31n, SIZE: 2048n, FRAMES: 9n, FNV1A64: "0123456789abcdef" } } }));
  const out = await harness.invoke({ methodId: "sandbox_query", inputs: [qrpFrame("query", { TIME_PROFILE: QRP.qrpTimeProfile.Nearest, PROFILE_EPOCH_MS: 1000n })] });
  assert.equal(calls[0].params.DELIVER, 1, "Ref asked");
  const pageBytes = out.outputs.find((o) => o.portId === "page").payload;
  const size = new DataView(pageBytes.buffer, pageBytes.byteOffset, pageBytes.byteLength).getUint32(0, true);
  const header = decode(QRP, "QRP", pageBytes.slice(4, 4 + size));
  assert.ok(pageBytes.length <= ((4 + size + 7) & ~7), "no inline record frames");
  assert.deepEqual([Number(header.BODY_REF_TOKEN), Number(header.BODY_REF_SIZE), header.RECORD_COUNT, header.ETAG, header.FILE_IDENTIFIER, header.HTTP_STATUS],
    [31, 2048, 9, 'W/"fnv1a64-0123456789abcdef"', "$OMM", 200]);
});

test("sandbox_query: bytes and text of any length travel as parameters and come back as cells", async (t) => {
  const long = "y".repeat(70_000);
  const { harness, calls } = await harnessFor(t, () => ({
    result: { KIND: 1, ROWS: 1n, COLUMNS: 2 },
    lists: { columns: [{ VALUE: "B" }, { VALUE: "T" }] },
    raw: { cells: encodeSqlValues([{ t: "bytes", v: Uint8Array.of(9, 8, 7) }, { t: "str", v: long }]) },
  }));
  const { page } = sandboxOutputs(await harness.invoke({ methodId: "sandbox_query", inputs: [qrpFrame("query", { SQL: "SELECT ? AS B, ? AS T", REPRESENTATION: QRP.qrpRepresentation.Json,
    PARAMETERS: [qrpValue({ KIND: QRP.qrpValueKind.Bytes, BYTES_VALUE: [1, 2] }), qrpValue({ KIND: QRP.qrpValueKind.Text, TEXT_VALUE: long })] })] }));
  assert.deepEqual(sqlParams(calls[0]).map(([t, v]) => [t, t === "str" ? v.length : Array.from(v)]), [["bytes", [1, 2]], ["str", 70_000]]);
  const [cell0, cell1] = page.header.ROWS[0].CELLS;
  assert.deepEqual([cell0.KIND, Array.from(cell0.BYTES_VALUE), cell1.KIND, cell1.TEXT_VALUE.length], [QRP.qrpValueKind.Bytes, [9, 8, 7], QRP.qrpValueKind.Text, 70_000]);
});
