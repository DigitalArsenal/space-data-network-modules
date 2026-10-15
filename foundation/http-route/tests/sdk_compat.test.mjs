import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { encodeHttpRequest } from "space-data-module-sdk/http";
import { encodeFlowNotice } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

// foundation/http-route on the typed contracts (1.0): one $HTQ in, exactly ONE typed decision out - an SDS $QRP for the
// query/data routes (Request on "bulk" / "query" / "surface", Error on "refusal") and an SDS $APR for the others.
const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

// The standards' own generated TypeScript bindings, bundled for Node by the standards repo's esbuild.
async function loadStandard(code) {
  const esbuild = await import(pathToFileURL(path.join(STANDARDS_ROOT, "node_modules", "esbuild", "lib", "main.js")).href);
  const flatbuffersEntry = fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"));
  const out = await esbuild.build({ entryPoints: [path.join(STANDARDS_ROOT, "lib", "ts", code, "main.ts")], bundle: true, format: "esm", write: false, platform: "neutral", alias: { flatbuffers: flatbuffersEntry }, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
const flatbuffers = await import(pathToFileURL(fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"))).href);
const { APR, aprMethod, aprRepresentation } = await loadStandard("APR");
const { QRP, qrpKind, qrpStatus, qrpTimeProfile, qrpRepresentation, qrpValueKind } = await loadStandard("QRP");

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const readWasm = () => fs.readFileSync(fileURLToPath(WASM_PATH));
const HTQ = { schemaName: "HttpRequestAbi.fbs", fileIdentifier: "$HTQ", rootTypeName: "HttpRequest", wireFormat: "flatbuffer" };
const requestFrame = (request) => ({ portId: "request", typeRef: HTQ, payload: encodeHttpRequest(request) });

async function harnessFor(t) {
  const harness = await createBrowserModuleHarness({ wasmSource: readWasm(), manifest: readManifest(), surface: "direct" });
  t.after(() => harness.destroy());
  return harness;
}
// One invoke -> the ONE decision frame: { port, value } with value unpacked through the SDS bindings.
async function decide(harness, methodId, request) {
  const result = await harness.invoke({ methodId, inputs: [requestFrame(request)] });
  assert.equal(result.statusCode, 0, result.errorMessage);
  assert.equal(result.outputs.length, 1, "exactly one decision per request");
  const [frame] = result.outputs;
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  if (APR.bufferHasIdentifier(bb)) return { port: frame.portId, apr: APR.getRootAsAPR(bb).unpack() };
  assert.ok(QRP.bufferHasIdentifier(bb), "the decision is an $APR or a $QRP");
  return { port: frame.portId, qrp: QRP.getRootAsQRP(bb).unpack() };
}
const params = (apr) => Object.fromEntries(apr.PARAMETERS.map((p) => [p.NAME, p.VALUE]));
const typeOf = (port) => port.acceptedTypeSets[0].allowedTypes[0].fileIdentifier;

test("http-route passes SDK compliance; every port names exactly one type", async () => {
  const manifest = readManifest();
  const report = await validateArtifactWithStandards({ manifest, wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const ports = Object.fromEntries(manifest.methods.map((m) => [m.methodId, Object.fromEntries(m.outputPorts.map((p) => [p.portId, typeOf(p)]))]));
  assert.deepEqual(ports, {
    route: { bulk: "$QRP", query: "$QRP", refusal: "$QRP" },
    discover: { decision: "$APR" },
    route_public_query: { query: "$QRP", surface: "$QRP", refusal: "$QRP" },
    route_node_status: { decision: "$APR" },
    route_node_activity: { decision: "$APR" },
  });
  for (const method of manifest.methods) {
    assert.equal(typeOf(method.inputPorts[0]), "$HTQ");
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      assert.equal(port.acceptedTypeSets.length, 1);
      assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1);
      assert.equal(port.acceptedTypeSets[0].allowedTypes[0].acceptsAnyFlatbuffer, undefined);
      assert.equal(port.acceptedTypeSets[0].allowedTypes[0].wireFormat, "flatbuffer");
    }
  }
});

test("http-route imports only WASI and the host bridge (no hostcalls are made)", async () => {
  const inspection = await inspectModule(readWasm());
  for (const entry of inspection.imports) assert.ok(["wasi_snapshot_preview1", "space_data_module_host"].includes(entry.module), entry.module);
});

test("route: /<code>/bulk becomes a $QRP Request with every query-string parameter typed", async (t) => {
  const harness = await harnessFor(t);
  const { port, qrp } = await decide(harness, "route", {
    method: "GET", path: "/api/v1/data/omm/bulk", query: "source=celestrak&mode=as_of&epoch=2026-10-13T06%3A00%3A00Z&limit=250",
    headers: { "If-None-Match": "W/\"fnv1a64-0123456789abcdef\"" },
  });
  assert.equal(port, "bulk");
  assert.equal(qrp.KIND, qrpKind.Request);
  assert.equal(qrp.SCHEMA_NAME, "OMM");
  assert.equal(qrp.FILE_IDENTIFIER, "$OMM");
  assert.equal(qrp.SOURCE_NAME, "celestrak");
  assert.equal(qrp.TIME_PROFILE, qrpTimeProfile.AsOf, "the mode alias names the profile");
  assert.equal(Number(qrp.PROFILE_EPOCH_MS), Date.UTC(2026, 9, 13, 6), "RFC3339 epoch -> Unix ms");
  assert.equal(qrp.LIMIT, 250);
  assert.equal(qrp.REPRESENTATION, qrpRepresentation.Default);
  assert.equal(qrp.ETAG, "W/\"fnv1a64-0123456789abcdef\"", "If-None-Match rides ETAG verbatim");

  const rfb = await decide(harness, "route", { method: "GET", path: "/test/data/rfb/bulk", query: "profile=nearest&mode=forward&epoch=1791880000.5" });
  assert.equal(rfb.port, "bulk");
  assert.equal(rfb.qrp.SCHEMA_NAME, "RFB", "any standard code is a bulk route");
  assert.equal(rfb.qrp.TIME_PROFILE, qrpTimeProfile.Nearest, "profile wins over its mode alias");
  assert.equal(Number(rfb.qrp.PROFILE_EPOCH_MS), 1791880000500, "unix seconds -> ms");
  assert.equal(rfb.qrp.ETAG, null);

  const plain = await decide(harness, "route", { method: "GET", path: "/api/v1/data/omm/bulk", query: "limit=0&format=flatbuffer" });
  assert.equal(plain.qrp.TIME_PROFILE, qrpTimeProfile.Unspecified, "no profile: not stated, the serving node's default applies");
  const all = await decide(harness, "route", { method: "GET", path: "/api/v1/data/omm/bulk", query: "profile=all" });
  assert.equal(all.qrp.TIME_PROFILE, qrpTimeProfile.All, "all: every record in the window");
  assert.equal(Number(plain.qrp.PROFILE_EPOCH_MS), 0, "no epoch: now");
  assert.equal(plain.qrp.LIMIT, 0, "a non-positive limit defers to the default");
  assert.equal(plain.qrp.REPRESENTATION, qrpRepresentation.FlatBuffer);
});

test("route: JSON is negotiated by ?format or Accept; JSON of a standard other than $OMM is refused 406", async (t) => {
  const harness = await harnessFor(t);
  const byFormat = await decide(harness, "route", { method: "GET", path: "/api/v1/data/omm/bulk", query: "format=json" });
  assert.equal(byFormat.qrp.REPRESENTATION, qrpRepresentation.Json);
  const byAccept = await decide(harness, "route", { method: "GET", path: "/api/v1/data/omm/bulk", headers: { Accept: "application/json" } });
  assert.equal(byAccept.qrp.REPRESENTATION, qrpRepresentation.Json);
  const fbAccept = await decide(harness, "route", { method: "GET", path: "/api/v1/data/omm/bulk", headers: { Accept: "application/x-flatbuffers" } });
  assert.equal(fbAccept.qrp.REPRESENTATION, qrpRepresentation.FlatBuffer);

  const refused = await decide(harness, "route", { method: "GET", path: "/api/v1/data/rfb/bulk", query: "format=json", headers: { "if-none-match": "\"x\"" } });
  assert.equal(refused.port, "refusal");
  assert.equal(refused.qrp.KIND, qrpKind.Error);
  assert.equal(refused.qrp.STATUS, qrpStatus.Error);
  assert.equal(refused.qrp.ERROR_CODE, "not-acceptable");
  assert.equal(refused.qrp.HTTP_STATUS, 406);
  assert.match(refused.qrp.MESSAGE, /RFB\.fbs; request format=flatbuffer/);
  assert.equal(refused.qrp.REPRESENTATION, qrpRepresentation.Json, "the refusal keeps the representation it is rendered in");
  assert.equal(refused.qrp.ETAG, "\"x\"");

  const badProfile = await decide(harness, "route", { method: "GET", path: "/api/v1/data/omm/bulk", query: "profile=sideways" });
  assert.deepEqual([badProfile.port, badProfile.qrp.ERROR_CODE, badProfile.qrp.HTTP_STATUS], ["refusal", "invalid-profile", 400]);
  const badEpoch = await decide(harness, "route", { method: "GET", path: "/api/v1/data/omm/bulk", query: "epoch=yesterday" });
  assert.deepEqual([badEpoch.port, badEpoch.qrp.ERROR_CODE], ["refusal", "invalid-epoch"]);
});

test("route: /query parses the client's JSON body into SQL + typed PARAMETERS; raw SQL text works too", async (t) => {
  const harness = await harnessFor(t);
  const body = JSON.stringify({ sql: "SELECT _data FROM OMM WHERE NORAD_CAT_ID = ? AND OBJECT_NAME LIKE ?", params: [
    { t: "i64", v: 25544 }, { t: "str", v: "ISS%" }, { t: "f64", v: 1.5 }, { t: "bool", v: true }, { t: "null" }, { t: "bytes", v: "AAEC/w==" }, 7, 2.25, "plain", false, null, { t: "i64", v: "9007199254740993" },
  ] });
  const { port, qrp } = await decide(harness, "route", { method: "POST", path: "/api/v1/data/query", body });
  assert.equal(port, "query");
  assert.equal(qrp.SQL, "SELECT _data FROM OMM WHERE NORAD_CAT_ID = ? AND OBJECT_NAME LIKE ?");
  const values = qrp.PARAMETERS.map((v) => {
    switch (v.KIND) {
      case qrpValueKind.Int: return ["Int", BigInt(v.INT_VALUE)];
      case qrpValueKind.Text: return ["Text", v.TEXT_VALUE];
      case qrpValueKind.Float: return ["Float", v.FLOAT_VALUE];
      case qrpValueKind.Bool: return ["Bool", v.BOOL_VALUE];
      case qrpValueKind.Bytes: return ["Bytes", Array.from(v.BYTES_VALUE)];
      default: return ["Null"];
    }
  });
  assert.deepEqual(values, [["Int", 25544n], ["Text", "ISS%"], ["Float", 1.5], ["Bool", true], ["Null"], ["Bytes", [0, 1, 2, 255]], ["Int", 7n], ["Float", 2.25], ["Text", "plain"], ["Bool", false], ["Null"], ["Int", 9007199254740993n]]);

  const raw = await decide(harness, "route", { method: "POST", path: "/api/v1/data/query", body: "  SELECT 1  \n" });
  assert.deepEqual([raw.port, raw.qrp.SQL, raw.qrp.PARAMETERS.length], ["query", "SELECT 1", 0]);

  const missing = await decide(harness, "route", { method: "POST", path: "/api/v1/data/query", body: "" });
  assert.deepEqual([missing.port, missing.qrp.ERROR_CODE], ["refusal", "missing-sql"]);
  const badParams = await decide(harness, "route", { method: "POST", path: "/api/v1/data/query", body: JSON.stringify({ sql: "SELECT ?", params: [{ t: "i64", v: "seven" }] }) });
  assert.equal(badParams.qrp.ERROR_CODE, "invalid-params");
  assert.match(badParams.qrp.MESSAGE, /^params\[0\]: i64 parameter is not an integer/);
  const badJson = await decide(harness, "route", { method: "POST", path: "/api/v1/data/query", body: "{\"sql\": " });
  assert.equal(badJson.qrp.ERROR_CODE, "invalid-body");
});

test("route: an unmatched path is refused 404 no-route", async (t) => {
  const { port, qrp } = await decide(await harnessFor(t), "route", { method: "DELETE", path: "/api/v1/data/omm" });
  assert.equal(port, "refusal");
  assert.equal(qrp.ERROR_CODE, "no-route");
  assert.equal(qrp.HTTP_STATUS, 404);
  assert.equal(qrp.MESSAGE, "no route for DELETE /api/v1/data/omm");
});

test("discover: every discovery route becomes an $APR with its parameters", async (t) => {
  const harness = await harnessFor(t);
  const peers = await decide(harness, "discover", { method: "GET", path: "/api/v1/peers/", headers: { "If-None-Match": "\"e\"" } });
  assert.equal(peers.port, "decision");
  assert.deepEqual([peers.apr.ROUTE, peers.apr.METHOD, peers.apr.PATH, peers.apr.IF_NONE_MATCH, peers.apr.STATUS], ["peers_list", aprMethod.GET, "/api/v1/peers/", "\"e\"", 0]);
  const one = await decide(harness, "discover", { method: "HEAD", path: "/api/v1/peers/16Uiu2HAm%2Fx", query: "format=json" });
  assert.deepEqual([one.apr.ROUTE, params(one.apr), one.apr.ACCEPT, one.apr.METHOD], ["peer_get", { peerId: "16Uiu2HAm/x" }, aprRepresentation.Json, aprMethod.HEAD]);
  const pnm = await decide(harness, "discover", { method: "GET", path: "/api/v1/peers/P1/pnm", query: "limit=500" });
  assert.deepEqual([pnm.apr.ROUTE, params(pnm.apr)], ["pnm_history", { peerId: "P1", limit: "100" }], "limit clamped to 100");
  const pnmDefault = await decide(harness, "discover", { method: "GET", path: "/api/v1/peers/P1/pnm", query: "limit=x" });
  assert.equal(params(pnmDefault.apr).limit, "1", "the default is the newest publication");
  const latest = await decide(harness, "discover", { method: "GET", path: "/api/v1/peers/P1/omm/latest" });
  assert.deepEqual([latest.apr.ROUTE, params(latest.apr)], ["latest_dataset", { peerId: "P1", standard: "omm" }]);
  const standards = await decide(harness, "discover", { method: "GET", path: "/api/v1/standards" });
  assert.equal(standards.apr.ROUTE, "standards");
});

test("discover: non-GET and unmatched paths are refused 404 on the same $APR port", async (t) => {
  const harness = await harnessFor(t);
  const post = await decide(harness, "discover", { method: "POST", path: "/api/v1/peers" });
  assert.deepEqual([post.port, post.apr.STATUS, post.apr.ERROR_CODE, post.apr.ROUTE], ["decision", 404, "no-route", null]);
  assert.match(post.apr.ERROR_MESSAGE, /discovery routes are GET/);
  const deep = await decide(harness, "discover", { method: "GET", path: "/api/v1/peers/P1/omm/older" });
  assert.deepEqual([deep.apr.STATUS, deep.apr.ERROR_CODE], [404, "no-route"]);
});

test("route_public_query: POST SQL / profile, GET surface, other methods 405", async (t) => {
  const harness = await harnessFor(t);
  const sql = await decide(harness, "route_public_query", { method: "POST", path: "/api/v1/query", query: "format=json", body: JSON.stringify({ sql: "SELECT NORAD_CAT_ID FROM OMM", params: [{ t: "i64", v: 1 }], sort: "NORAD_CAT_ID desc", limit: 10, format: "flatbuffer" }) });
  assert.equal(sql.port, "query");
  assert.deepEqual([sql.qrp.SQL, sql.qrp.SORT_FIELD, sql.qrp.SORT_DESC, sql.qrp.LIMIT, sql.qrp.PARAMETERS.length], ["SELECT NORAD_CAT_ID FROM OMM", "NORAD_CAT_ID", true, 10, 1]);
  assert.equal(sql.qrp.REPRESENTATION, qrpRepresentation.Json, "?format wins over the body's format");
  const bodyFormat = await decide(harness, "route_public_query", { method: "POST", path: "/api/v1/query", body: JSON.stringify({ sql: "SELECT 1", format: "json" }) });
  assert.equal(bodyFormat.qrp.REPRESENTATION, qrpRepresentation.Json);

  const profile = await decide(harness, "route_public_query", { method: "POST", path: "/api/v1/query", body: JSON.stringify({ profile: "epoch.as_of", epoch: "2026-10-13T00:00:00Z", source: "celestrak", limit: 5 }) });
  assert.deepEqual([profile.port, profile.qrp.TIME_PROFILE, Number(profile.qrp.PROFILE_EPOCH_MS), profile.qrp.SOURCE_NAME, profile.qrp.SCHEMA_NAME, profile.qrp.SQL], ["query", qrpTimeProfile.AsOf, Date.UTC(2026, 9, 13), "celestrak", "OMM", null]);

  const surface = await decide(harness, "route_public_query", { method: "GET", path: "/api/v1/query", headers: { "If-None-Match": "\"s\"" } });
  assert.deepEqual([surface.port, surface.qrp.KIND, surface.qrp.ETAG, surface.qrp.SQL], ["surface", qrpKind.Request, "\"s\"", null]);

  const put = await decide(harness, "route_public_query", { method: "PUT", path: "/api/v1/query", body: "SELECT 1" });
  assert.deepEqual([put.port, put.qrp.ERROR_CODE, put.qrp.HTTP_STATUS], ["refusal", "method-not-allowed", 405]);
  const empty = await decide(harness, "route_public_query", { method: "POST", path: "/api/v1/query", body: "{}" });
  assert.deepEqual([empty.port, empty.qrp.ERROR_CODE], ["refusal", "missing-sql"]);
  const badSort = await decide(harness, "route_public_query", { method: "POST", path: "/api/v1/query", body: JSON.stringify({ sql: "SELECT 1", sort: "A sideways" }) });
  assert.equal(badSort.qrp.ERROR_CODE, "invalid-sort");
});

test("route_node_status / route_node_activity: GET routes, other methods 405, activity limit clamped", async (t) => {
  const harness = await harnessFor(t);
  const status = await decide(harness, "route_node_status", { method: "GET", path: "/api/v1/node/status", headers: { Accept: "application/json" } });
  assert.deepEqual([status.port, status.apr.ROUTE, status.apr.ACCEPT, status.apr.STATUS], ["decision", "status", aprRepresentation.Json, 0]);
  const post = await decide(harness, "route_node_status", { method: "POST", path: "/api/v1/node/status" });
  assert.deepEqual([post.apr.STATUS, post.apr.ERROR_CODE, post.apr.ERROR_MESSAGE], [405, "method-not-allowed", "no POST route for node status (GET only)"]);

  const activity = await decide(harness, "route_node_activity", { method: "GET", path: "/api/v1/node/activity", query: "limit=9999" });
  assert.deepEqual([activity.apr.ROUTE, params(activity.apr)], ["activity", { limit: "256" }]);
  assert.deepEqual(params((await decide(harness, "route_node_activity", { method: "GET", path: "/x", query: "limit=0" })).apr), { limit: "1" });
  assert.deepEqual(params((await decide(harness, "route_node_activity", { method: "GET", path: "/x", query: "limit=12abc" })).apr), { limit: "50" });
  const del = await decide(harness, "route_node_activity", { method: "DELETE", path: "/api/v1/node/activity" });
  assert.deepEqual([del.apr.STATUS, del.apr.ERROR_CODE], [405, "method-not-allowed"]);
});

test("a frame that is not an $HTQ is refused; two request frames are refused, never one silently dropped", async (t) => {
  const harness = await harnessFor(t);
  const notHtq = await harness.invoke({ methodId: "route", inputs: [{ portId: "request", typeRef: HTQ, payload: encodeFlowNotice({ kind: "info" }) }] });
  assert.notEqual(notHtq.statusCode, 0);
  assert.equal(notHtq.errorCode, "invalid-request-frame");
  for (const methodId of ["route", "discover", "route_public_query", "route_node_status", "route_node_activity"]) {
    const twice = await harness.invoke({ methodId, inputs: [requestFrame({ method: "GET", path: "/a" }), requestFrame({ method: "GET", path: "/b" })] });
    assert.equal(twice.errorCode, "batched-input-frames", methodId);
    assert.match(twice.errorMessage, /2 frames on single-stream input port "request"/);
    assert.equal(twice.outputs.length, 0);
  }
});
