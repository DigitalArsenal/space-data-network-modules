import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

// SDS PIV/TAB aligned typeRefs REQUIRE requiredAlignment and byteLength: the
// SDK invoke codec (src/invoke/codec.js normalizeFrameTypeRef) rejects a frame
// without them and the invoke throws before the wasm is ever entered. This
// suite omitted both, so every behavioural test in it was dead — failing
// identically against old and new artifacts, which reads as "the harness is
// broken" rather than "these fixtures are". Repaired under graph task
// modules-guest-nodes-drop-batched-frames.
function jsonInput(portId, value) {
  const payload = encoder.encode(JSON.stringify(value));
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.byteLength },
    payload,
  };
}

const RESPONSE_BODY = Uint8Array.from({ length: 40 }, (_, i) => (i * 17 + 9) & 0xff);
const REQUEST_BODY = Uint8Array.from({ length: 20 }, (_, i) => (i * 5 + 1) & 0xff);

// Byte params arrive as live views into guest memory; snapshot at dispatch.
function snapshotParams(params) {
  if (params instanceof Uint8Array) return Uint8Array.from(params);
  if (Array.isArray(params)) return params.map(snapshotParams);
  if (params && typeof params === "object") {
    return Object.fromEntries(
      Object.entries(params).map(([key, value]) => [key, snapshotParams(value)]),
    );
  }
  return params;
}

// SDK JS host dialect: {status,statusText,ok,headers,body:Uint8Array}.
function createJsHostStub({ failOps = {}, response } = {}) {
  const calls = [];
  const dispatch = (operation, params) => {
    calls.push({ operation, params: snapshotParams(params) });
    if (failOps[operation]) {
      throw new Error(failOps[operation]);
    }
    if (operation === "http.request") {
      return (
        response ?? {
          url: params.url,
          status: 200,
          statusText: "OK",
          ok: true,
          headers: { "content-type": "application/octet-stream", "x-node": "js" },
          body: RESPONSE_BODY,
        }
      );
    }
    throw new Error(`unexpected hostcall operation: ${operation}`);
  };
  return { calls, dispatch };
}

// Go host dialect: {status,headers,body:<string>,body_encoding:"utf8"|"base64"}.
function createGoHostStub(result) {
  const calls = [];
  const dispatch = (operation, params) => {
    calls.push({ operation, params: snapshotParams(params) });
    if (operation === "http.request") {
      return result;
    }
    throw new Error(`unexpected hostcall operation: ${operation}`);
  };
  return { calls, dispatch };
}

async function createHarness(t, stub) {
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
    surface: "direct",
    hostcallDispatch: stub.dispatch,
  });
  t.after(() => harness.destroy());
  return harness;
}

function decodeResponse(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "response");
  assert.equal(frame.wireFormat, "aligned-binary");
  return JSON.parse(decoder.decode(frame.payload));
}

test("hostcap/http-request artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("hostcap/http-request artifact exports the canonical ABI and imports only WASI + the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  assert.equal(inspection.profile, "module-host-abi");
  const importedModuleNames = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  assert.deepEqual(importedModuleNames, ["space_data_module_host", "wasi_snapshot_preview1"]);
  for (const required of [
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

test("request forwards method/url/headers/body/timeout and normalizes a JS-host binary response", async (t) => {
  const stub = createJsHostStub();
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "request",
    inputs: [
      jsonInput("request", {
        method: "POST",
        url: "https://api.example.test/v1/data",
        headers: { "content-type": "application/octet-stream" },
        bodyB64: Buffer.from(REQUEST_BODY).toString("base64"),
        timeoutMs: 15000,
      }),
    ],
  });

  const out = decodeResponse(response);
  assert.equal(out.status, 200);
  assert.equal(out.headers["x-node"], "js");
  assert.deepEqual(new Uint8Array(Buffer.from(out.bodyB64, "base64")), RESPONSE_BODY);

  assert.equal(stub.calls.length, 1);
  const { operation, params } = stub.calls[0];
  assert.equal(operation, "http.request");
  assert.equal(params.method, "POST");
  assert.equal(params.url, "https://api.example.test/v1/data");
  assert.deepEqual(params.headers, { "content-type": "application/octet-stream" });
  assert.equal(params.timeoutMs, 15000, "JS-host timeout spelling");
  assert.equal(params.timeout_ms, 15000, "Go-host timeout spelling");
  assert.equal(params.responseType, "binary");
  assert.equal(params.body_encoding, "base64", "Go-host body encoding marker");
  assert.deepEqual(
    new Uint8Array(params.body),
    REQUEST_BODY,
    "request body must reach the host as raw bytes (binary segment)",
  );
});

test("request defaults to GET with no body and no timeout fields", async (t) => {
  const stub = createJsHostStub();
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "request",
    inputs: [jsonInput("request", { url: "https://example.test/" })],
  });

  decodeResponse(response);
  const { params } = stub.calls[0];
  assert.equal(params.method, "GET");
  assert.equal(params.body, undefined, "no body field without bodyB64");
  assert.equal(params.timeoutMs, undefined);
});

test("request normalizes the Go-host utf8 string body dialect to bodyB64", async (t) => {
  const stub = createGoHostStub({
    status: 404,
    headers: { "Content-Type": "text/plain" },
    body: "not found",
    body_encoding: "utf8",
  });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "request",
    inputs: [jsonInput("request", { url: "https://example.test/missing" })],
  });

  const out = decodeResponse(response);
  assert.equal(out.status, 404);
  assert.equal(out.headers["Content-Type"], "text/plain");
  assert.equal(Buffer.from(out.bodyB64, "base64").toString("utf8"), "not found");
});

test("request passes the Go-host base64 body dialect through verbatim", async (t) => {
  const bodyB64 = Buffer.from(RESPONSE_BODY).toString("base64");
  const stub = createGoHostStub({
    status: 200,
    headers: {},
    body: bodyB64,
    body_encoding: "base64",
  });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "request",
    inputs: [jsonInput("request", { url: "https://example.test/blob" })],
  });

  const out = decodeResponse(response);
  assert.equal(out.status, 200);
  assert.equal(out.bodyB64, bodyB64);
});

test("request rejects a missing url before any hostcall", async (t) => {
  const stub = createJsHostStub();
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "request",
    inputs: [jsonInput("request", { method: "GET" })],
  });

  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "missing-url");
  assert.equal(stub.calls.length, 0);
});

test("request rejects invalid bodyB64 before any hostcall", async (t) => {
  const stub = createJsHostStub();
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "request",
    inputs: [jsonInput("request", { url: "https://example.test/", bodyB64: "@@not-base64@@" })],
  });

  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "invalid-body");
  assert.equal(stub.calls.length, 0);
});

test("request surfaces host errors (origin denied) with the host message", async (t) => {
  const stub = createJsHostStub({
    failOps: { "http.request": 'HTTP origin "https://evil.test" is not permitted by this host.' },
  });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "request",
    inputs: [jsonInput("request", { url: "https://evil.test/" })],
  });

  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "http-request-failed");
  assert.match(String(response.errorMessage), /not permitted by this host/);

  // A FAILED REQUEST STILL EMITS ITS SLOT. This assertion used to read
  // `outputs.length === 0`, and it was stale from the moment 7fefaf4 landed —
  // it was never caught because every behavioural test in this suite was dead
  // (the fixtures omitted the aligned typeRef fields the SDK invoke codec
  // requires, so the invoke threw before the wasm was entered; repaired under
  // graph task modules-guest-nodes-drop-batched-frames).
  //
  // The contract this node now holds is ONE RESPONSE FRAME PER REQUEST FRAME,
  // in input order, INCLUDING failures: a failure that emits nothing shifts
  // every later body one slot left and silently misattributes it to the wrong
  // request. Status 0 is outside 2xx, so a consumer filtering on status drops
  // this exactly as it drops a 500, while the slot stays aligned.
  assert.equal(response.outputs.length, 1, "a failed request must still occupy its slot");
  const [frame] = response.outputs;
  assert.equal(frame.portId, "response");
  const slot = JSON.parse(decoder.decode(new Uint8Array(frame.payload)));
  assert.equal(slot.status, 0);
  assert.equal(slot.bodyB64, "");
  assert.equal(slot.error, "http-request-failed");
  assert.match(String(slot.errorMessage), /not permitted by this host/);
});
