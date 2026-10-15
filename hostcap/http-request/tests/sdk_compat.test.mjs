import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { decodeHttpResponse, encodeHttpRequest, encodeFlowNotice } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

// hostcap/http-request on the typed contracts (1.0): HttpRequest frames in, HttpResponse frames out, and the host
// call itself an SDS $PIV hostcall the SDK host bridge decodes into the host's own http.request arguments.
const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const readWasm = () => fs.readFileSync(fileURLToPath(WASM_PATH));
const requestFrame = (request) => ({ portId: "request", typeRef: { schemaName: "HttpRequest.fbs", fileIdentifier: "HREQ", rootTypeName: "HttpRequest", wireFormat: "flatbuffer" }, payload: encodeHttpRequest(request) });

const RESPONSE_BODY = Uint8Array.from({ length: 40 }, (_, i) => (i * 17 + 9) & 0xff);
const REQUEST_BODY = Uint8Array.from({ length: 20 }, (_, i) => (i * 5 + 1) & 0xff);

// The SDK JS host's http.request: arguments {url, method, headers, body, timeoutMs, maxBytes, redirect, responseType},
// answer {url, status, headers, body}. Byte arguments arrive as views into guest memory, so they are copied.
function hostStub({ fail = {}, answer } = {}) {
  const calls = [];
  const dispatch = (operation, params) => {
    calls.push({ operation, params: { ...params, body: params?.body ? Uint8Array.from(params.body) : undefined } });
    if (fail[params?.url]) throw Object.assign(new Error(fail[params.url]), { name: "HostCapabilityError" });
    if (operation !== "http.request") throw new Error(`unexpected hostcall ${operation}`);
    return answer?.(params) ?? { url: params.url, status: 200, headers: { "Content-Type": "application/octet-stream", "X-Node": "js" }, body: RESPONSE_BODY };
  };
  return { calls, dispatch };
}
async function harnessFor(t, stub) {
  const harness = await createBrowserModuleHarness({ wasmSource: readWasm(), manifest: readManifest(), surface: "direct", hostcallDispatch: stub.dispatch });
  t.after(() => harness.destroy());
  return harness;
}
function responses(result) {
  assert.equal(result.statusCode, 0, result.errorMessage);
  return result.outputs.map((frame) => {
    assert.equal(frame.portId, "response");
    return decodeHttpResponse(frame.payload);
  });
}

test("hostcap/http-request passes SDK compliance with typed ports", async () => {
  const report = await validateArtifactWithStandards({ manifest: readManifest(), wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const [method] = readManifest().methods;
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "HREQ");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "HRSP");
});

test("hostcap/http-request imports only WASI and the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  assert.equal(inspection.profile, "module-host-abi");
  assert.deepEqual(Array.from(new Set(inspection.imports.map((e) => e.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});

test("an HttpRequest becomes the host's http.request; the HttpResponse carries the body verbatim", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, stub);
  const context = encodeFlowNotice({ kind: "info", reason: "lead f006" });
  const [out] = responses(await harness.invoke({ methodId: "request", inputs: [requestFrame({
    method: "POST", url: "https://api.example.test/v1/data", headers: { "Content-Type": "application/octet-stream", Range: "bytes=0-63" },
    body: REQUEST_BODY, timeoutMs: 15000, maxBytes: 4194304, context,
  })] }));
  assert.equal(out.status, 200);
  assert.equal(out.url, "https://api.example.test/v1/data");
  assert.deepEqual(out.body, RESPONSE_BODY);
  assert.deepEqual(out.headers, { "content-type": "application/octet-stream", "x-node": "js" });
  assert.deepEqual(out.context, context, "CONTEXT is echoed verbatim");
  assert.equal(out.error, "");
  assert.ok(Math.abs(out.retrievedMs - Date.now()) < 60_000);

  assert.equal(stub.calls.length, 1);
  const { operation, params } = stub.calls[0];
  assert.equal(operation, "http.request");
  assert.deepEqual([params.method, params.url, params.timeoutMs, params.maxBytes, params.redirect], ["POST", "https://api.example.test/v1/data", 15000, 4194304, "follow"]);
  assert.deepEqual(params.headers, { "content-type": "application/octet-stream", range: "bytes=0-63" });
  assert.deepEqual(params.body, REQUEST_BODY, "the request body reaches the host as bytes");
});

test("a URL longer than any aligned string travels on the raw url frame", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, stub);
  const url = `https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20261013/06/atmos/${"x".repeat(600)}.idx`;
  const [out] = responses(await harness.invoke({ methodId: "request", inputs: [requestFrame({ url })] }));
  assert.equal(out.url, url);
  assert.equal(stub.calls[0].params.method, "GET");
});

test("every request of a fan-in batch is answered in order; a refused one answers STATUS 0 with its ERROR", async (t) => {
  const stub = hostStub({ fail: { "https://b.example.test/": "http not granted" }, answer: (p) => ({ url: p.url, status: p.url.includes("c.") ? 304 : 200, headers: {}, body: new TextEncoder().encode(p.url) }) });
  const harness = await harnessFor(t, stub);
  const urls = ["https://a.example.test/", "https://b.example.test/", "https://c.example.test/"];
  const out = responses(await harness.invoke({ methodId: "request", inputs: urls.map((url) => requestFrame({ url })) }));
  assert.deepEqual(out.map((r) => r.status), [200, 0, 304]);
  assert.equal(new TextDecoder().decode(out[0].body), urls[0]);
  assert.match(out[1].error, /^not-authorized: http not granted/);
  assert.equal(out[2].body.length, urls[2].length);
});

test("a frame that is not an HttpRequest is refused", async (t) => {
  const harness = await harnessFor(t, hostStub());
  const result = await harness.invoke({ methodId: "request", inputs: [{ portId: "request", typeRef: { schemaName: "HttpRequest.fbs", fileIdentifier: "HREQ", rootTypeName: "HttpRequest", wireFormat: "flatbuffer" }, payload: encodeFlowNotice({ kind: "info" }) }] });
  assert.notEqual(result.statusCode, 0);
  assert.equal(result.errorCode, "invalid-request");
});
