// data-source/intelsat-source end to end on the typed contracts (1.0): the compiled wasm in the SDK browser harness, its node
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
const tick = () => ({ portId: "tick", typeRef: TYPE.TICK, payload: encodeTimerTick({ triggerId: "intelsat-request", firedMs: Date.UTC(2026, 9, 14) }) });
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

const LISTING_URL = "https://my.intelsat.com/ephemeris/public";
const BASE = "https://my.intelsat.com/Resource/Ephemeris/";
const SELECTED = "i_aor_e_302.00_is-21_20260710_235300";
const FILE_URL = BASE + SELECTED + ".txt";
const ECF_FILE = "i_aor_e_302.00_is-21_20260710_235300.sample.txt";

test("request -> select_file -> emit: the newest IS-21 ECF file becomes one $OEM, byte-identical to the legacy artifact's", async (t) => {
  const host = await harness(t);
  assert.equal(getOf(await host.invoke({ methodId: "request", inputs: [tick()] })), LISTING_URL);
  assert.equal(getOf(await host.invoke({ methodId: "select_file", inputs: [response("listing", LISTING_URL, fixture("ephemeris_public.sample.html"))] })), FILE_URL);
  const out = oems(await host.invoke({ methodId: "emit", inputs: [response("response", FILE_URL, fixture(ECF_FILE))] }));
  assert.deepEqual(out, legacyOems());
});

test("config target and ephemerisBase choose another satellite's ECF file", async (t) => {
  const host = await harness(t, { target: "is-34", ephemerisBase: "https://mirror.example.test/eph" });
  const url = getOf(await host.invoke({ methodId: "select_file", inputs: [response("listing", LISTING_URL, fixture("ephemeris_public.sample.html"))] }));
  assert.match(url, /^https:\/\/mirror\.example\.test\/eph\/[^/]*_e_[^/]*_is-34_\d{8}_\d{6}\.txt$/);
});

test("a failed listing, a file that 404s or an ECF without data rows fails closed", async (t) => {
  const host = await harness(t);
  refused(await host.invoke({ methodId: "select_file", inputs: [response("listing", LISTING_URL, new Uint8Array(0), { status: 503 })] }), "fetch-empty");
  refused(await host.invoke({ methodId: "emit", inputs: [response("response", FILE_URL, new Uint8Array(0), { status: 404 })] }), "fetch-empty");
  const headerOnly = fixture(ECF_FILE).toString().split("\n").slice(0, 3).join("\n");
  refused(await host.invoke({ methodId: "emit", inputs: [response("response", FILE_URL, Buffer.from(headerOnly))] }), "fetch-empty");
});
