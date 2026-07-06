import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { encodeHttpRequest, HTTP_REQUEST_TYPE_REF } from "space-data-module-sdk/http";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

async function createHarness(t) {
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  return harness;
}

async function invokeRoute(t, request) {
  const harness = await createHarness(t);
  return harness.invoke({
    methodId: "route",
    inputs: [
      {
        portId: "request",
        typeRef: HTTP_REQUEST_TYPE_REF,
        payload: encodeHttpRequest(request),
      },
    ],
  });
}

// The module must emit exactly one decision frame per request.
function decodeDecision(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1, "route must emit exactly one decision frame");
  const [frame] = response.outputs;
  assert.equal(frame.portId, "decision");
  assert.equal(frame.wireFormat, "aligned-binary");
  return JSON.parse(new TextDecoder().decode(frame.payload));
}

test("foundation/http-route artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("foundation/http-route artifact is standalone WASI with canonical exports", async () => {
  const inspection = await inspectModule(readWasm());
  const importedModuleNames = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(importedModuleNames, ["wasi_snapshot_preview1"], "pure compute: WASI imports only");
  for (const required of [
    "_start",
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

test("route /omm/bulk parses RFC3339 epoch, profile alias, limit, source, format, If-None-Match", async (t) => {
  const response = await invokeRoute(t, {
    method: "GET",
    path: "/api/v1/omm/bulk",
    // RFC3339 epoch stays URL-encoded on the wire; the module owns decoding.
    query: "epoch=2026-07-01T12%3A00%3A00Z&mode=as_of&limit=250&source=celestrak-gp&format=json",
    headers: { "if-none-match": "\"etag-123\"", accept: "*/*" },
  });
  const decision = decodeDecision(response);
  assert.equal(decision.route, "omm_bulk");
  assert.equal(decision.format, "json");
  assert.equal(decision.ifNoneMatch, "\"etag-123\"");
  assert.equal(decision.query.schema, "OMM.fbs");
  assert.equal(decision.query.source, "celestrak-gp");
  assert.equal(decision.query.profile, "as_of", "mode must alias profile");
  assert.equal(decision.query.limit, 250);
  // 2026-07-01T12:00:00Z in unix seconds, independently via Date.UTC.
  assert.ok(Math.abs(decision.query.epoch - Date.UTC(2026, 6, 1, 12, 0, 0) / 1000) < 1e-6);
});

test("route /omm/bulk accepts unix-seconds epoch and prefers profile over mode", async (t) => {
  const response = await invokeRoute(t, {
    method: "GET",
    path: "/omm/bulk",
    query: "epoch=1751500800.5&profile=nearest&mode=forward",
  });
  const decision = decodeDecision(response);
  assert.equal(decision.route, "omm_bulk");
  assert.ok(Math.abs(decision.query.epoch - 1751500800.5) < 1e-6);
  assert.equal(decision.query.profile, "nearest", "profile must beat its mode alias");
});

test("route /omm/bulk defaults: format flatbuffer, no epoch/profile/limit/source keys, no ifNoneMatch", async (t) => {
  const response = await invokeRoute(t, {
    method: "GET",
    path: "/api/v1/omm/bulk",
    query: "",
  });
  const decision = decodeDecision(response);
  assert.equal(decision.route, "omm_bulk");
  assert.equal(decision.format, "flatbuffer", "format must default to flatbuffer");
  assert.equal(decision.ifNoneMatch, undefined, "absent If-None-Match must omit the key");
  assert.deepEqual(decision.query, { schema: "OMM.fbs" }, "absent params defer to retrieval defaults");
});

test("route /omm/bulk ignores an unparseable epoch (defers to retrieval defaults)", async (t) => {
  const response = await invokeRoute(t, {
    method: "GET",
    path: "/omm/bulk",
    query: "epoch=yesterday&limit=-5&format=xml",
  });
  const decision = decodeDecision(response);
  assert.equal(decision.route, "omm_bulk");
  assert.equal(decision.query.epoch, undefined);
  assert.equal(decision.query.limit, undefined, "non-positive limit must be dropped");
  assert.equal(decision.format, "flatbuffer", "unknown format must fall back to flatbuffer");
});

test("route /query passes a JSON SQL body through verbatim", async (t) => {
  const body = {
    sql: "SELECT * FROM omm WHERE NORAD_CAT_ID = ?",
    params: [{ t: "i64", v: 25544 }],
  };
  const response = await invokeRoute(t, {
    method: "POST",
    path: "/api/v1/query",
    query: "format=json",
    body: JSON.stringify(body),
  });
  const decision = decodeDecision(response);
  assert.equal(decision.route, "data_query");
  assert.equal(decision.format, "json");
  assert.equal(decision.sql, body.sql);
  assert.deepEqual(decision.params, body.params);
});

test("route /query accepts a raw SQL text body", async (t) => {
  const response = await invokeRoute(t, {
    method: "POST",
    path: "/query",
    body: "SELECT COUNT(*) FROM omm",
  });
  const decision = decodeDecision(response);
  assert.equal(decision.route, "data_query");
  assert.equal(decision.sql, "SELECT COUNT(*) FROM omm");
  assert.deepEqual(decision.params, []);
  assert.equal(decision.format, "flatbuffer");
});

test("route /query without a SQL body degrades to not_found", async (t) => {
  const response = await invokeRoute(t, {
    method: "POST",
    path: "/api/v1/query",
  });
  const decision = decodeDecision(response);
  assert.equal(decision.route, "not_found");
  assert.match(decision.error, /SQL request body/);
});

test("route unknown path emits a not_found decision (single frame)", async (t) => {
  const response = await invokeRoute(t, {
    method: "GET",
    path: "/api/v1/nope",
    headers: { "If-None-Match": "abc" },
  });
  const decision = decodeDecision(response);
  assert.equal(decision.route, "not_found");
  assert.match(decision.error, /GET \/api\/v1\/nope/);
  assert.equal(decision.ifNoneMatch, "abc", "If-None-Match lookup must be case-insensitive");
});

// ---------------------------------------------------------------------------
// discover: the gateway discovery routing method (loop G.2).
// ---------------------------------------------------------------------------

async function invokeDiscover(t, request) {
  const harness = await createHarness(t);
  return harness.invoke({
    methodId: "discover",
    inputs: [
      {
        portId: "request",
        typeRef: HTTP_REQUEST_TYPE_REF,
        payload: encodeHttpRequest(request),
      },
    ],
  });
}

test("discover routes /peers (with and without trailing slash) to peers_list", async (t) => {
  for (const path of ["/api/v1/peers", "/api/v1/peers/"]) {
    const decision = decodeDecision(await invokeDiscover(t, { method: "GET", path, query: "" }));
    assert.equal(decision.route, "peers_list", path);
    assert.equal(decision.format, "flatbuffer");
    assert.equal(decision.peerId, undefined);
  }
});

test("discover routes /peers/{peerId} to peer_get with the percent-decoded segment", async (t) => {
  const decision = decodeDecision(
    await invokeDiscover(t, {
      method: "GET",
      path: "/api/v1/peers/16Uiu2HAm9oK2jAeVC2RMESFcYfq7BKGp2K2CCDxzoKhB5s9vpbj3/",
      query: "format=json",
      headers: { "if-none-match": 'W/"fnv1a64-0011223344556677"' },
    }),
  );
  assert.equal(decision.route, "peer_get");
  assert.equal(decision.peerId, "16Uiu2HAm9oK2jAeVC2RMESFcYfq7BKGp2K2CCDxzoKhB5s9vpbj3");
  assert.equal(decision.format, "json");
  assert.equal(decision.ifNoneMatch, 'W/"fnv1a64-0011223344556677"');
});

test("discover routes /standards to standards", async (t) => {
  const decision = decodeDecision(
    await invokeDiscover(t, { method: "GET", path: "/api/v1/standards", query: "format=json" }),
  );
  assert.equal(decision.route, "standards");
  assert.equal(decision.format, "json");
});

test("discover degrades deeper per-peer paths and non-GET methods to not_found", async (t) => {
  const deep = decodeDecision(
    await invokeDiscover(t, { method: "GET", path: "/api/v1/peers/16Uiu2HAmX/pnm", query: "" }),
  );
  assert.equal(deep.route, "not_found");
  assert.ok(deep.error);

  const post = decodeDecision(
    await invokeDiscover(t, { method: "POST", path: "/api/v1/peers", query: "" }),
  );
  assert.equal(post.route, "not_found");
  assert.match(post.error, /GET/);
});
