// data-source/glonass-source end to end on the typed contracts (1.0): the compiled wasm in the SDK browser harness, its node
// config served by plugin.getConfig (hostOptions.config), a TimerTick (TICK) in, HttpRequests (HREQ) out, the provider's
// files (test/fixtures) handed back as the HttpResponses (HRSP) hostcap/http-request answers, and $OEM FlatBuffers out.
// The $OEM bytes must equal the ones the legacy artifact (JSON hostcalls, [u32 count][u32 len][$OEM] stream) produced
// from the same fixtures, kept in test/fixtures/legacy/oem-stream.bin.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { decodeHttpRequest, encodeHttpResponse, encodeTimerTick } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const wasmPath = new URL("../dist/isomorphic/module.wasm", import.meta.url).pathname;
const manifest = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"));
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const TYPE = {
  TICK: { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" },
  HRSP: { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" },
};

async function harness(t, config = {}) {
  const host = await createBrowserModuleHarness({ wasmSource: new Uint8Array(fs.readFileSync(wasmPath)), manifest, surface: "direct", hostOptions: { config } });
  t.after(() => host.destroy());
  return host;
}
const tick = () => ({ portId: "tick", typeRef: TYPE.TICK, payload: encodeTimerTick({ triggerId: "glonass-request", firedMs: Date.UTC(2026, 9, 14) }) });
const response = (portId, url, body, { status = 200, error = "" } = {}) => ({
  portId, typeRef: TYPE.HRSP, payload: encodeHttpResponse({ url, status, error, headers: {}, body: new Uint8Array(body), retrievedMs: Date.UTC(2026, 9, 14) }),
});
const ok = (r) => { assert.equal(r.statusCode, 0, r.errorMessage); return r; };
// The one GET a method asks for.
const getOf = (r) => {
  const frames = ok(r).outputs.filter((f) => f.portId === "request");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].typeRef.fileIdentifier, "HREQ");
  const req = decodeHttpRequest(frames[0].payload);
  assert.equal(req.method, "GET");
  return req.url;
};
const oems = (r) => ok(r).outputs.filter((f) => f.portId === "oem").map((f) => {
  assert.equal(f.typeRef.fileIdentifier, "$OEM");
  assert.equal(f.typeRef.wireFormat, "flatbuffer");
  return Buffer.from(f.payload);
});
// The legacy artifact's [u32le count] then count x ([u32le len][$OEM]) stream.
function legacyOems() {
  const b = fixture("legacy/oem-stream.bin");
  const out = [];
  for (let k = 0, off = 4; k < b.readUInt32LE(0); k++) { const n = b.readUInt32LE(off); out.push(b.subarray(off + 4, off + 4 + n)); off += 4 + n; }
  return out;
}
const refused = (r, code) => {
  assert.notEqual(r.statusCode, 0);
  assert.equal(r.outputs?.length ?? 0, 0, "no partial output");
  if (code) assert.equal(r.errorCode, code, r.errorMessage);
};

test("the artifact validates, and every port names one concrete FlatBuffer type", async () => {
  const result = await validateArtifactWithStandards({ wasmPath, manifest, standardsRoot: new URL("../node_modules/spacedatastandards.org/", import.meta.url).pathname });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(manifest.capabilities, []);
  for (const method of manifest.methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      const types = port.acceptedTypeSets.flatMap((s) => s.allowedTypes);
      assert.equal(types.length, 1, `${method.methodId}.${port.portId}`);
      assert.equal(types[0].wireFormat, "flatbuffer");
      assert.ok(!types[0].acceptsAnyFlatbuffer);
    }
  }
});

const SOURCE_URL = "ftp://ftp.glonass-iac.ru/MCC/PRODUCTS/LATEST/Final.sp3";
const SP3_FILE = "synthetic_glonass.sp3.glo";

test("request -> emit: the IAC SP3 becomes one $OEM per GLONASS satellite, byte-identical to the legacy artifact's", async (t) => {
  const host = await harness(t);
  assert.equal(getOf(await host.invoke({ methodId: "request", inputs: [tick()] })), SOURCE_URL);
  const out = oems(await host.invoke({ methodId: "emit", inputs: [response("response", SOURCE_URL, fixture(SP3_FILE))] }));
  assert.equal(out.length, 25, "25 GLONASS satellites, the whole constellation by default");
  assert.deepEqual(out, legacyOems());
});

test("config objectCap bounds the satellites emitted, and sourceUrl is the URL asked for", async (t) => {
  const host = await harness(t, { objectCap: 4, sourceUrl: "https://example.test/iac_glonass.sp3" });
  assert.equal(getOf(await host.invoke({ methodId: "request", inputs: [tick()] })), "https://example.test/iac_glonass.sp3");
  const out = oems(await host.invoke({ methodId: "emit", inputs: [response("response", SOURCE_URL, fixture(SP3_FILE))] }));
  assert.deepEqual(out, legacyOems().slice(0, 4));
});

test("a non-200, a transport error or an SP3 without position records fails closed", async (t) => {
  const host = await harness(t);
  refused(await host.invoke({ methodId: "emit", inputs: [response("response", SOURCE_URL, fixture(SP3_FILE), { status: 404 })] }), "fetch-empty");
  refused(await host.invoke({ methodId: "emit", inputs: [response("response", SOURCE_URL, new Uint8Array(0), { status: 0, error: "unsupported protocol scheme \"ftp\"" })] }), "fetch-failed");
  const headerOnly = fixture(SP3_FILE).toString().split("\n").filter((l) => !l.startsWith("P")).join("\n");
  refused(await host.invoke({ methodId: "emit", inputs: [response("response", SOURCE_URL, Buffer.from(headerOnly))] }), "fetch-empty");
});
