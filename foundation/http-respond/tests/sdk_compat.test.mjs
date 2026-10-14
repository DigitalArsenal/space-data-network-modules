import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { decodeHttpResponse, fnv1a64Hex } from "space-data-module-sdk/http";
import { encodeFlowNotice } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

// foundation/http-respond on the typed contracts (1.0): an SDS $APR or $QRP decision plus the typed answer in, one $HTR
// out. FlatBuffers go out verbatim; JSON is rendered only here, only when the decision asks for it.
const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

async function loadStandard(code) {
  const esbuild = await import(pathToFileURL(path.join(STANDARDS_ROOT, "node_modules", "esbuild", "lib", "main.js")).href);
  const flatbuffersEntry = fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"));
  const out = await esbuild.build({ entryPoints: [path.join(STANDARDS_ROOT, "lib", "ts", code, "main.ts")], bundle: true, format: "esm", write: false, platform: "neutral", alias: { flatbuffers: flatbuffersEntry }, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
const flatbuffers = await import(pathToFileURL(fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"))).href);
const sds = Object.fromEntries(await Promise.all(["APR", "QRP", "NHS", "NEV", "NST", "PNV", "DAV", "OMM", "RFB"].map(async (c) => [c, await loadStandard(c)])));

// Build an SDS record through its generated object API: `${code}T` with the given fields.
function build(code, fields, { sizePrefixed = false, root = code } = {}) {
  const mod = sds[code];
  const object = Object.assign(new mod[`${root}T`](), fields);
  const b = new flatbuffers.Builder(256);
  const offset = object.pack(b);
  if (sizePrefixed) b.finishSizePrefixed(offset, `$${code}`);
  else b.finish(offset, `$${code}`);
  return b.asUint8Array().slice();
}
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const typeRef = (code) => ({ schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code, wireFormat: "flatbuffer" });
const frame = (portId, code, payload) => ({ portId, typeRef: typeRef(code), payload });

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const readWasm = () => fs.readFileSync(fileURLToPath(WASM_PATH));
async function harnessFor(t) {
  const harness = await createBrowserModuleHarness({ wasmSource: readWasm(), manifest: readManifest(), surface: "direct" });
  t.after(() => harness.destroy());
  return harness;
}
async function answer(harness, methodId, inputs) {
  const result = await harness.invoke({ methodId, inputs });
  assert.equal(result.statusCode, 0, result.errorMessage);
  assert.equal(result.outputs.length, 1, "exactly one $HTR");
  assert.equal(result.outputs[0].portId, "response");
  const http = decodeHttpResponse(result.outputs[0].payload);
  http.header = (name) => http.headers.find((h) => h.name === name)?.value;
  http.json = () => JSON.parse(new TextDecoder().decode(http.body));
  assert.deepEqual(http.headers.map((h) => h.name), http.headers.map((h) => h.name).slice().sort(), "headers sorted by NAME");
  return http;
}
const { aprMethod, aprRepresentation } = sds.APR;
const { qrpKind, qrpStatus, qrpRepresentation, qrpValueKind } = sds.QRP;
const apr = (fields = {}) => frame("decision", "APR", build("APR", { METHOD: aprMethod.GET, PATH: "/api/v1/x", ROUTE: "status", ...fields }));
const qrp = (fields = {}) => frame("decision", "QRP", build("QRP", { KIND: qrpKind.Request, ...fields }));
const etagOf = (bytes) => `W/"fnv1a64-${fnv1a64Hex(bytes)}"`;

// Two OMM records as the store delivers them (size-prefixed, concatenated).
const OMM_RECORDS = concat(
  build("OMM", { NORAD_CAT_ID: 25544, OBJECT_NAME: "ISS (ZARYA)", OBJECT_ID: "1998-067A", EPOCH: "2026-10-13T06:00:00.000Z", MEAN_MOTION: 15.5, ECCENTRICITY: 0.0004, INCLINATION: 51.64, BSTAR: 0.00012, COVARIANCE: [1, 2.5], USER_DEFINED_EPOCH_TIMESTAMP: 1791871200 }, { sizePrefixed: true }),
  build("OMM", { NORAD_CAT_ID: 20580, OBJECT_NAME: "HST", MEAN_MOTION: 15.1 }, { sizePrefixed: true }),
);
// The serving node's page: a size-prefixed QRP header, then the records.
const page = (header, records = new Uint8Array(0)) => frame("page", "QRP", concat(build("QRP", { KIND: qrpKind.Page, STATUS: qrpStatus.Ok, ...header }, { sizePrefixed: true }), records));

test("http-respond passes SDK compliance; every port names exactly one type", async () => {
  const manifest = readManifest();
  const report = await validateArtifactWithStandards({ manifest, wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const ports = Object.fromEntries(manifest.methods.map((m) => [m.methodId, m.inputPorts.map((p) => `${p.portId}:${p.acceptedTypeSets[0].allowedTypes[0].fileIdentifier}`)]));
  assert.deepEqual(ports.respond.slice(0, 7), ["decision:$APR", "status:$NHS", "activity:$NEV", "peers:$NST", "notices:$PNV", "availability:$DAV", "omm_records:$OMM"]);
  assert.equal(ports.respond.length, 6 + 17);
  assert.deepEqual(ports.respond_query, ["decision:$QRP", "page:$QRP"]);
  for (const method of manifest.methods) {
    assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$HTR");
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1, port.portId);
      assert.equal(port.acceptedTypeSets[0].allowedTypes[0].acceptsAnyFlatbuffer, undefined, port.portId);
      assert.equal(port.acceptedTypeSets[0].allowedTypes[0].wireFormat, "flatbuffer", port.portId);
    }
  }
});

test("http-respond imports only WASI and the host bridge (no hostcalls are made)", async () => {
  const inspection = await inspectModule(readWasm());
  for (const entry of inspection.imports) assert.ok(["wasi_snapshot_preview1", "space_data_module_host"].includes(entry.module), entry.module);
});

test("respond: an $NHS answers verbatim as FlatBuffers, or rendered with its IDL field names as JSON", async (t) => {
  const harness = await harnessFor(t);
  const nhs = build("NHS", { NODE_ID: "16Uiu2HAmSelf", GENERATED_AT_MS: 1791900000123n, UPTIME_S: 98765n, SERVICE_STATE: sds.NHS.nhsServiceState.Running, SERVICE_MODE: "daemon", HAS_DISK: true, DISK_FREE_BYTES: 250000000000n,
    THROUGHPUT_HISTORY: [Object.assign(new sds.NHS.NHSThroughputSampleT(), { TIME_MS: 1791900000000n, RATE_IN_BPS: 12.5 })], NOTES: ["disk 50% full"] });
  const fb = await answer(harness, "respond", [apr(), frame("status", "NHS", nhs)]);
  assert.equal(fb.status, 200);
  assert.equal(fb.header("content-type"), "application/x-flatbuffers");
  assert.equal(fb.header("x-sdn-file-identifier"), "$NHS");
  assert.deepEqual(fb.body, nhs, "the record goes out verbatim");

  const json = (await answer(harness, "respond", [apr({ ACCEPT: aprRepresentation.Json }), frame("status", "NHS", nhs)]));
  assert.equal(json.header("content-type"), "application/json");
  const body = json.json();
  assert.equal(body.NODE_ID, "16Uiu2HAmSelf");
  assert.equal(body.GENERATED_AT_MS, 1791900000123);
  assert.equal(body.SERVICE_STATE, "Running", "enums by name");
  assert.equal(body.DISK_FREE_BYTES, 250000000000);
  assert.equal(body.SOFTWARE_VERSION, null, "an absent string is null");
  assert.deepEqual(body.THROUGHPUT_HISTORY, [{ TIME_MS: 1791900000000, TOTAL_IN_BYTES: 0, TOTAL_OUT_BYTES: 0, RATE_IN_BPS: 12.5, RATE_OUT_BPS: 0 }]);
  assert.deepEqual(body.NOTES, ["disk 50% full"]);
  for (const key of Object.keys(body)) assert.match(key, /^[A-Z0-9_]+$/, "IDL field names exactly");
});

test("respond: $NEV, $NST and $PNV render as JSON objects (byte vectors as hex)", async (t) => {
  const harness = await harnessFor(t);
  const nev = build("NEV", { NODE_ID: "N", EVENTS: [Object.assign(new sds.NEV.NEVEventT(), { TIME_MS: 5n, KIND: sds.NEV.nevEventKind.PeerConnected, PEER_ID: "P", DETAIL: "inbound" })] });
  assert.deepEqual((await answer(harness, "respond", [apr({ ROUTE: "activity", ACCEPT: aprRepresentation.Json }), frame("activity", "NEV", nev)])).json().EVENTS,
    [{ TIME_MS: 5, KIND: "PeerConnected", PEER_ID: "P", SUBJECT: null, COUNT: 0, DETAIL: "inbound" }]);

  const NSTNode = sds.NST.NSTNodeT ?? null;
  const nst = NSTNode
    ? build("NST", { SOURCE_PEER_ID: "S", GENERATED_AT: 9n, NODES: [Object.assign(new NSTNode(), { PEER_ID: "P", DN: "Node P", MULTIFORMAT_ADDRESS: ["/ip4/1.2.3.4/tcp/4001"], IS_ONLINE: true, SOURCE: "connected" })] })
    : null;
  if (nst) {
    const peers = (await answer(harness, "respond", [apr({ ROUTE: "peers_list", ACCEPT: aprRepresentation.Json }), frame("peers", "NST", nst)])).json();
    assert.equal(peers.SOURCE_PEER_ID, "S");
    assert.deepEqual([peers.NODES[0].PEER_ID, peers.NODES[0].DN, peers.NODES[0].MULTIFORMAT_ADDRESS, peers.NODES[0].IS_ONLINE, peers.NODES[0].SOURCE], ["P", "Node P", ["/ip4/1.2.3.4/tcp/4001"], true, "connected"]);
  }

  const pnv = build("PNV", { VERIFIER_PEER_ID: "V", ENTRIES: [Object.assign(new sds.PNV.PNVEntryT(), { PUBLISHER_PEER_ID: "P", STANDARD: "OMM", SIGNATURE: [0xde, 0xad, 0xbe, 0xef], SIGNATURE_VERIFIED: true, ATTRIBUTION: sds.PNV.pnvAttribution.Relayed, PUBLISHER_KEY: [1, 2], KEY_SOURCE: sds.PNV.pnvKeySource.IdentityRecord })] });
  const notices = (await answer(harness, "respond", [apr({ ROUTE: "standards", ACCEPT: aprRepresentation.Json }), frame("notices", "PNV", pnv)])).json();
  assert.deepEqual([notices.VERIFIER_PEER_ID, notices.ENTRIES[0].SIGNATURE, notices.ENTRIES[0].PUBLISHER_KEY, notices.ENTRIES[0].ATTRIBUTION, notices.ENTRIES[0].KEY_SOURCE, notices.ENTRIES[0].SIGNATURE_VERIFIED],
    ["V", "deadbeef", "0102", "Relayed", "IdentityRecord", true]);
});

test("respond: a refusal answers its STATUS with the $APR itself, or {error, code} as JSON; Csv is 406; no body is 502", async (t) => {
  const harness = await harnessFor(t);
  const refusal = apr({ METHOD: aprMethod.POST, ROUTE: null, STATUS: 405, ERROR_CODE: "method-not-allowed", ERROR_MESSAGE: "no POST route for node status (GET only)" });
  const fb = await answer(harness, "respond", [refusal]);
  assert.deepEqual([fb.status, fb.header("content-type"), fb.header("x-sdn-file-identifier")], [405, "application/x-flatbuffers", "$APR"]);
  assert.deepEqual(fb.body, refusal.payload, "the refusal record verbatim");
  const decoded = sds.APR.APR.getRootAsAPR(new flatbuffers.ByteBuffer(fb.body));
  assert.equal(decoded.ERROR_CODE(), "method-not-allowed");

  const json = await answer(harness, "respond", [apr({ ACCEPT: aprRepresentation.Json, STATUS: 503, ERROR_CODE: "status-unavailable", ERROR_MESSAGE: "node status snapshot unavailable" })]);
  assert.equal(json.status, 503);
  assert.deepEqual(json.json(), { error: "node status snapshot unavailable", code: "status-unavailable" });

  const csv = await answer(harness, "respond", [apr({ ACCEPT: aprRepresentation.Csv }), frame("status", "NHS", build("NHS", {}))]);
  assert.deepEqual([csv.status, csv.json().code], [406, "not-acceptable"]);

  const empty = await answer(harness, "respond", [apr({ ACCEPT: aprRepresentation.Json })]);
  assert.deepEqual([empty.status, empty.json().code], [502, "missing-body"]);
  const emptyFb = await answer(harness, "respond", [apr()]);
  assert.equal(emptyFb.status, 502);
  assert.equal(sds.APR.APR.getRootAsAPR(new flatbuffers.ByteBuffer(emptyFb.body)).STATUS(), 502);
});

test("respond: a dataset is its $DAV + records as one stream, an OMM array as JSON, 304 on its ETAG, 503 with the $DAV when unavailable", async (t) => {
  const harness = await harnessFor(t);
  const ETAG = "W/\"fnv1a64-00000000deadbeef\"";
  const dav = build("DAV", { STANDARD: "OMM", SCHEMA_NAME: "OMM.fbs", KNOWN: true, AVAILABLE: true, BATCH_ID: "b1", RECORD_COUNT: 2n, ETAG });
  const latest = { ROUTE: "latest_dataset" };
  const fb = await answer(harness, "respond", [apr(latest), frame("availability", "DAV", dav), frame("omm_records", "OMM", OMM_RECORDS)]);
  assert.deepEqual([fb.status, fb.header("content-type"), fb.header("x-sdn-record-count"), fb.header("etag")], [200, "application/vnd.sdn.flatbuffers.stream", "2", ETAG]);
  // The stream: [size-prefixed $DAV, padded to 8][the records verbatim].
  const view = new DataView(fb.body.buffer, fb.body.byteOffset, fb.body.byteLength);
  const davLength = view.getUint32(0, true);
  const head = new flatbuffers.ByteBuffer(fb.body.slice(4, 4 + davLength));
  assert.ok(sds.DAV.DAV.bufferHasIdentifier(head));
  assert.equal(sds.DAV.DAV.getRootAsDAV(head).BATCH_ID(), "b1");
  const recordsAt = Math.ceil((4 + davLength) / 8) * 8;
  assert.deepEqual(fb.body.slice(recordsAt), OMM_RECORDS, "the records verbatim after the $DAV");

  const json = await answer(harness, "respond", [apr({ ...latest, ACCEPT: aprRepresentation.Json }), frame("availability", "DAV", dav), frame("omm_records", "OMM", OMM_RECORDS)]);
  const records = json.json();
  assert.equal(json.header("x-sdn-record-count"), "2");
  assert.deepEqual(records.map((r) => [r.NORAD_CAT_ID, r.OBJECT_NAME, r.MEAN_MOTION]), [[25544, "ISS (ZARYA)", 15.5], [20580, "HST", 15.1]]);
  assert.deepEqual([records[0].EPOCH, records[0].BSTAR, records[0].COVARIANCE, records[0].EPHEMERIS_TYPE, records[0].USER_DEFINED_EPOCH_TIMESTAMP], ["2026-10-13T06:00:00.000Z", 0.00012, [1, 2.5], "SGP4", 1791871200]);
  assert.equal(records[1].OBJECT_ID, null);

  const notModified = await answer(harness, "respond", [apr({ ...latest, IF_NONE_MATCH: ETAG }), frame("availability", "DAV", dav), frame("omm_records", "OMM", OMM_RECORDS)]);
  assert.deepEqual([notModified.status, notModified.header("etag"), notModified.body.length], [304, ETAG, 0]);

  const unavailable = build("DAV", { STANDARD: "OMM", KNOWN: true, AVAILABLE: false, UNAVAILABLE_REASON: sds.DAV.davUnavailableReason.NotHeld, PNM_CID: "bafy-pnm" });
  const u = await answer(harness, "respond", [apr({ ...latest, ACCEPT: aprRepresentation.Json, STATUS: 503, ERROR_CODE: "dataset-unavailable" }), frame("availability", "DAV", unavailable)]);
  assert.equal(u.status, 503);
  assert.deepEqual([u.json().UNAVAILABLE_REASON, u.json().PNM_CID, u.json().AVAILABLE], ["NotHeld", "bafy-pnm", false]);
  const uFb = await answer(harness, "respond", [apr({ ...latest, STATUS: 503 }), frame("availability", "DAV", unavailable)]);
  assert.deepEqual([uFb.status, uFb.header("x-sdn-file-identifier")], [503, "$DAV"]);
  assert.deepEqual(uFb.body, unavailable);

  const rfb = concat(build("RFB", {}, { sizePrefixed: true }));
  const notOmm = await answer(harness, "respond", [apr({ ...latest, ACCEPT: aprRepresentation.Json }), frame("availability", "DAV", dav), frame("rfb_records", "RFB", rfb)]);
  assert.deepEqual([notOmm.status, notOmm.json().code], [406, "not-acceptable"]);
  assert.match(notOmm.json().error, /\$RFB records; request format=flatbuffer/);
});

test("respond_query: refusals answer the status their ERROR_CODE names, as the $QRP or as {error, code}", async (t) => {
  const harness = await harnessFor(t);
  const cases = [["no-route", 404], ["method-not-allowed", 405], ["not-acceptable", 406], ["timeout", 422], ["too-large", 422], ["host-failed", 502], ["unavailable", 503], ["missing-sql", 400], ["invalid-sort", 400]];
  for (const [code, status] of cases) {
    const json = await answer(harness, "respond_query", [qrp({ KIND: qrpKind.Error, STATUS: qrpStatus.Error, ERROR_CODE: code, MESSAGE: `m-${code}`, REPRESENTATION: qrpRepresentation.Json })]);
    assert.equal(json.status, status, code);
    assert.deepEqual(json.json(), { error: `m-${code}`, code });
  }
  const error = qrp({ KIND: qrpKind.Error, STATUS: qrpStatus.Error, ERROR_CODE: "no-route", MESSAGE: "no route for GET /x" });
  const fb = await answer(harness, "respond_query", [error]);
  assert.deepEqual([fb.status, fb.header("x-sdn-file-identifier")], [404, "$QRP"]);
  assert.deepEqual(fb.body, error.payload);
  const busy = await answer(harness, "respond_query", [qrp({ KIND: qrpKind.Error, STATUS: qrpStatus.Busy, ERROR_CODE: "busy", RETRY_AFTER_MS: 1500, REPRESENTATION: qrpRepresentation.Json })]);
  assert.deepEqual([busy.status, busy.header("retry-after")], [503, "2"]);
});

test("respond_query: a records page goes out verbatim (FlatBuffer) or as an OMM array (Json); 304 on its ETAG", async (t) => {
  const harness = await harnessFor(t);
  const etag = etagOf(OMM_RECORDS);
  const p = page({ SCHEMA_NAME: "OMM", FILE_IDENTIFIER: "$OMM", RECORD_COUNT: 2, ETAG: etag }, OMM_RECORDS);
  const fb = await answer(harness, "respond_query", [qrp({ SCHEMA_NAME: "OMM" }), p]);
  assert.deepEqual([fb.status, fb.header("content-type"), fb.header("x-sdn-record-count"), fb.header("etag")], [200, "application/vnd.sdn.flatbuffers.stream", "2", etag]);
  assert.deepEqual(fb.body, p.payload, "the page stream verbatim: QRP header then the records");

  const json = await answer(harness, "respond_query", [qrp({ REPRESENTATION: qrpRepresentation.Json }), p]);
  assert.deepEqual(json.json().map((r) => r.NORAD_CAT_ID), [25544, 20580]);
  assert.equal(json.header("etag"), etag, "both representations share the tag");

  const notModified = await answer(harness, "respond_query", [qrp({ ETAG: etag }), p]);
  assert.deepEqual([notModified.status, notModified.body.length], [304, 0]);

  const empty = await answer(harness, "respond_query", [qrp({ REPRESENTATION: qrpRepresentation.Json }), page({ RECORD_COUNT: 0, ETAG: etagOf(new Uint8Array(0)) })]);
  assert.deepEqual([empty.status, empty.json(), empty.header("x-sdn-record-count")], [200, [], "0"]);

  const rfbPage = page({ FILE_IDENTIFIER: "$RFB", RECORD_COUNT: 1 }, build("RFB", {}, { sizePrefixed: true }));
  const notOmm = await answer(harness, "respond_query", [qrp({ REPRESENTATION: qrpRepresentation.Json }), rfbPage]);
  assert.deepEqual([notOmm.status, notOmm.json().code], [406, "not-acceptable"]);
});

test("respond_query: a projection renders {COLUMN: value} rows; the surface renders TABLES + limits; header errors and missing pages answer", async (t) => {
  const harness = await harnessFor(t);
  const cell = (fields) => Object.assign(new sds.QRP.QRPValueT(), fields);
  const projection = page({
    COLUMNS: [Object.assign(new sds.QRP.QRPColumnT(), { NAME: "NORAD_CAT_ID" }), Object.assign(new sds.QRP.QRPColumnT(), { NAME: "OBJECT_NAME" }), Object.assign(new sds.QRP.QRPColumnT(), { NAME: "BLOB" })],
    ROWS: [Object.assign(new sds.QRP.QRPRowT(), { CELLS: [cell({ KIND: qrpValueKind.Int, INT_VALUE: 25544n }), cell({ KIND: qrpValueKind.Text, TEXT_VALUE: "ISS" }), cell({ KIND: qrpValueKind.Bytes, BYTES_VALUE: [0, 1, 2] })] }),
      Object.assign(new sds.QRP.QRPRowT(), { CELLS: [cell({ KIND: qrpValueKind.Float, FLOAT_VALUE: 1.5 }), cell({ KIND: qrpValueKind.Null }), cell({ KIND: qrpValueKind.Bool, BOOL_VALUE: true })] })],
    TOTAL_COUNT: 2n, ETAG: "W/\"fnv1a64-0000000000000001\"",
  });
  const rows = await answer(harness, "respond_query", [qrp({ REPRESENTATION: qrpRepresentation.Json }), projection]);
  assert.deepEqual(rows.json(), [{ NORAD_CAT_ID: 25544, OBJECT_NAME: "ISS", BLOB: "AAEC" }, { NORAD_CAT_ID: 1.5, OBJECT_NAME: null, BLOB: true }]);
  assert.equal(rows.header("x-sdn-record-count"), "2");
  const rowsFb = await answer(harness, "respond_query", [qrp(), projection]);
  assert.deepEqual([rowsFb.header("x-sdn-record-count"), rowsFb.body], ["2", projection.payload]);

  const surface = page({ TABLES: [Object.assign(new sds.QRP.QRPTableT(), { NAME: "OMM", KIND: "standard", SOURCE: "OMM", RECORDS: 4213n, COLUMNS: [Object.assign(new sds.QRP.QRPColumnT(), { NAME: "NORAD_CAT_ID" })] })], MAX_ELAPSED_MS: 5000, MAX_ROWS: 50000n, MAX_BYTES: 16777216n });
  const listing = (await answer(harness, "respond_query", [qrp({ REPRESENTATION: qrpRepresentation.Json }), surface])).json();
  assert.deepEqual(listing, { TABLES: [{ NAME: "OMM", KIND: "standard", SOURCE: "OMM", RECORDS: 4213, COLUMNS: [{ NAME: "NORAD_CAT_ID", TYPE: null, UNIT: null, SORTABLE: false, INDEXED: false }] }], MAX_ELAPSED_MS: 5000, MAX_ROWS: 50000, MAX_BYTES: 16777216 });

  const headerError = await answer(harness, "respond_query", [qrp({ REPRESENTATION: qrpRepresentation.Json }), page({ KIND: qrpKind.Error, STATUS: qrpStatus.Error, ERROR_CODE: "timeout", MESSAGE: "statement timeout" })]);
  assert.deepEqual([headerError.status, headerError.json()], [422, { error: "statement timeout", code: "timeout" }]);
  const missing = await answer(harness, "respond_query", [qrp()]);
  assert.equal(missing.status, 502);
  assert.equal(sds.QRP.QRP.getRootAsQRP(new flatbuffers.ByteBuffer(missing.body)).ERROR_CODE(), "host-failed");
});

test("adopted fields: HTTP_STATUS wins; $NST / $PNV ETags give 304; RESPONSE_HEADERS ride the answer; BODY_REF answers by reference", async (t) => {
  const harness = await harnessFor(t);
  // HTTP_STATUS set by the deciding node wins over the code table.
  const told = await answer(harness, "respond_query", [qrp({ KIND: qrpKind.Error, STATUS: qrpStatus.Error, ERROR_CODE: "query-failed", HTTP_STATUS: 409, REPRESENTATION: qrpRepresentation.Json })]);
  assert.equal(told.status, 409);

  // $NST / $PNV entity tags.
  const nst = build("NST", { SOURCE_PEER_ID: "S", ETAG: "W/\"fnv1a64-00000000000000aa\"", NODES: [Object.assign(new sds.NST.NSTNodeT(), { PEER_ID: "P", STANDARDS: ["OMM", "CAT"] })] });
  const peers = await answer(harness, "respond", [apr({ ROUTE: "peers_list", ACCEPT: aprRepresentation.Json }), frame("peers", "NST", nst)]);
  assert.equal(peers.header("etag"), "W/\"fnv1a64-00000000000000aa\"");
  assert.deepEqual([peers.json().ETAG, peers.json().NODES[0].STANDARDS], ["W/\"fnv1a64-00000000000000aa\"", ["OMM", "CAT"]]);
  const peers304 = await answer(harness, "respond", [apr({ ROUTE: "peers_list", IF_NONE_MATCH: "W/\"fnv1a64-00000000000000aa\"" }), frame("peers", "NST", nst)]);
  assert.deepEqual([peers304.status, peers304.body.length], [304, 0]);
  const pnv = build("PNV", { ETAG: "\"p\"", ENTRIES: [Object.assign(new sds.PNV.PNVEntryT(), { STANDARD: "OMM", PNM: [9, 8, 7] })] });
  assert.equal((await answer(harness, "respond", [apr({ ROUTE: "standards", IF_NONE_MATCH: "\"p\"" }), frame("notices", "PNV", pnv)])).status, 304);
  const notices = (await answer(harness, "respond", [apr({ ROUTE: "standards", ACCEPT: aprRepresentation.Json }), frame("notices", "PNV", pnv)])).json();
  assert.deepEqual([notices.ETAG, notices.ENTRIES[0].PNM], ["\"p\"", "090807"]);

  // RESPONSE_HEADERS: lower-cased, CR/LF stripped, computed names refused.
  const header = (NAME, VALUE) => Object.assign(new sds.APR.APRParameterT(), { NAME, VALUE });
  const withHeaders = await answer(harness, "respond", [apr({ RESPONSE_HEADERS: [header("Cache-Control", "max-age=60"), header("X-Sdn-Cache-Age", "12\r\nset-cookie: x"), header("Content-Type", "text/html"), header("etag", "\"forged\"")] }), frame("status", "NHS", build("NHS", {}))]);
  assert.equal(withHeaders.header("cache-control"), "max-age=60");
  assert.equal(withHeaders.header("x-sdn-cache-age"), "12set-cookie: x", "CR/LF stripped: no injected header");
  assert.equal(withHeaders.header("set-cookie"), undefined);
  assert.equal(withHeaders.header("content-type"), "application/x-flatbuffers", "a computed header is never overridden");
  assert.equal(withHeaders.header("etag"), undefined);
  const refusedWithHeaders = await answer(harness, "respond", [apr({ STATUS: 503, ACCEPT: aprRepresentation.Json, RESPONSE_HEADERS: [header("Retry-After", "5"), header("cache-control", "no-store")] })]);
  assert.deepEqual([refusedWithHeaders.status, refusedWithHeaders.header("cache-control")], [503, "no-store"]);

  // Out-of-band delivery: no inline body, the $HTR names the host's token.
  const refPage = page({ FILE_IDENTIFIER: "$OMM", RECORD_COUNT: 30000, ETAG: "W/\"fnv1a64-0123456789abcdef\"", BODY_REF_TOKEN: 77n, BODY_REF_SIZE: 9000000n });
  const byRef = await answer(harness, "respond_query", [qrp(), refPage]);
  assert.deepEqual([byRef.status, byRef.body.length, Number(byRef.bodyRefToken), byRef.bodyRefSize, byRef.header("x-sdn-record-count"), byRef.header("etag")],
    [200, 0, 77, 9000000, "30000", "W/\"fnv1a64-0123456789abcdef\""]);
  assert.equal((await answer(harness, "respond_query", [qrp({ ETAG: "W/\"fnv1a64-0123456789abcdef\"" }), refPage])).status, 304);
  const davRef = build("DAV", { STANDARD: "OMM", KNOWN: true, AVAILABLE: true, RECORD_COUNT: 2n, ETAG: "\"d\"", BODY_REF_TOKEN: 5n, BODY_REF_SIZE: 640n });
  const latestRef = await answer(harness, "respond", [apr({ ROUTE: "latest_dataset" }), frame("availability", "DAV", davRef)]);
  assert.deepEqual([latestRef.status, latestRef.body.length, Number(latestRef.bodyRefToken), latestRef.bodyRefSize, latestRef.header("x-sdn-record-count")], [200, 0, 5, 640, "2"]);
  const refJson = await answer(harness, "respond", [apr({ ROUTE: "latest_dataset", ACCEPT: aprRepresentation.Json }), frame("availability", "DAV", davRef)]);
  assert.deepEqual([refJson.status, refJson.json().code], [502, "body-ref-unrenderable"]);
});

test("malformed, ambiguous and surplus inputs are refused by name, never answered from a guess", async (t) => {
  const harness = await harnessFor(t);
  const notApr = await harness.invoke({ methodId: "respond", inputs: [frame("decision", "APR", encodeFlowNotice({ kind: "info" }))] });
  assert.equal(notApr.errorCode, "invalid-decision-frame");
  const twoBodies = await harness.invoke({ methodId: "respond", inputs: [apr(), frame("status", "NHS", build("NHS", {})), frame("activity", "NEV", build("NEV", {}))] });
  assert.equal(twoBodies.errorCode, "ambiguous-body");
  const badPage = await harness.invoke({ methodId: "respond_query", inputs: [qrp(), frame("page", "QRP", new Uint8Array([1, 2, 3]))] });
  assert.equal(badPage.errorCode, "invalid-page");
  const twice = await harness.invoke({ methodId: "respond_query", inputs: [qrp(), qrp()] });
  assert.equal(twice.errorCode, "batched-input-frames");
  assert.match(twice.errorMessage, /2 frames on single-stream input port "decision"/);
  for (const r of [notApr, twoBodies, badPage, twice]) assert.equal(r.outputs.length, 0);
});
