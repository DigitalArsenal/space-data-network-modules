// data-source/cell-tower-credentials on the typed contracts (1.0), end to end: the BUILT module linked into a one-node flow
// and run on the WasmEdge leg of the SDK flow runtime host, every hostcall the module makes decoded from its SDS $PIV request and answered with a real $PIV response
// (encodeHostCallResult) at the space_data_module_host import - the node's credential store, its keyslot oracle and
// node.publicKey played by this file. The keyslot envelope is a REAL X25519 + HKDF-SHA256 + AES-256-GCM seal made here
// with node:crypto, and the test host really opens it, so a module that mangled any envelope byte would fail to store.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import {
  decodeFlowNotice,
  decodeHostCall,
  decodeHttpRequest,
  encodeHostCallResult,
  encodeHttpRequest,
} from "space-data-module-sdk/runtime-contracts";
import { createFlowRuntimeHost } from "space-data-module-sdk/flow";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

async function loadStandard(code) {
  const esbuild = await import(pathToFileURL(path.join(STANDARDS_ROOT, "node_modules", "esbuild", "lib", "main.js")).href);
  const flatbuffersEntry = fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"));
  const out = await esbuild.build({ entryPoints: [path.join(STANDARDS_ROOT, "lib", "ts", code, "main.ts")], bundle: true, format: "esm", write: false, platform: "neutral", alias: { flatbuffers: flatbuffersEntry }, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
const flatbuffers = await import(pathToFileURL(fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"))).href);
const APR = await loadStandard("APR");
const QRP = await loadStandard("QRP");

const typeRef = (schemaName, fileIdentifier, rootTypeName) => ({ schemaName, fileIdentifier, rootTypeName, wireFormat: "flatbuffer" });
const T = { APR: typeRef("APR.fbs", "$APR", "APR"), QRP: typeRef("QRP.fbs", "$QRP", "QRP"), HREQ: typeRef("HttpRequest.fbs", "HREQ", "HttpRequest") };
const encoder = new TextEncoder();
const LANES = ["cell_opencellid", "cell_wigle"];

// ---- SDS records ---------------------------------------------------------------------------------------------------

function finish(object, id, sizePrefixed = false) {
  const b = new flatbuffers.Builder(512);
  const offset = object.pack(b);
  if (sizePrefixed) b.finishSizePrefixed(offset, id); else b.finish(offset, id);
  return b.asUint8Array().slice();
}
function apr({ route, method, params = {}, body, accept = 0 }) {
  const t = new APR.APRT();
  t.ROUTE = route;
  t.METHOD = method;
  t.PATH = "/api/v1/cellular/credentials/x";
  t.ACCEPT = accept;
  t.PARAMETERS = Object.entries(params).map(([k, v]) => Object.assign(new APR.APRParameterT(), { NAME: k, VALUE: v }));
  if (body) t.BODY = Array.from(body);
  return finish(t, "$APR");
}
const text = (v) => Object.assign(new QRP.QRPValueT(), { KIND: QRP.qrpValueKind.Text, TEXT_VALUE: v });
const bool = (v) => Object.assign(new QRP.QRPValueT(), { KIND: QRP.qrpValueKind.Bool, BOOL_VALUE: v });
const nul = () => new QRP.QRPValueT();
const COLUMNS = ["id", "name", "authority", "license", "attribution", "credentialRequired", "credentialConfigured", "credentialLane",
  "authoritative", "defaultSelected", "methods", "keySlotId", "keySlotPublicKey", "keySlotAlgorithm"];
// The catalog projection page as cell-tower-source route builds it.
function catalogPage(representation = QRP.qrpRepresentation.Json) {
  const t = new QRP.QRPT();
  t.KIND = QRP.qrpKind.Page;
  t.REPRESENTATION = representation;
  t.COLUMNS = COLUMNS.map((n) => Object.assign(new QRP.QRPColumnT(), { NAME: n }));
  const provider = (id, login) => Object.assign(new QRP.QRPRowT(), { CELLS: [text(id), text(id), text("authority"), text("CC BY-SA 4.0"),
    text("attribution"), bool(login), bool(false), text(`cell_${id}`), bool(false), bool(!login), text("SINGLE_SOURCE,HIGHEST_SAMPLE_COUNT"), nul(), nul(), nul()] });
  t.ROWS = [provider("opencellid", true), provider("wigle", true), provider("openstreetmap-overpass", false)];
  return finish(t, "$QRP", true);
}
function readQrp(bytes, sizePrefixed) {
  const body = sizePrefixed ? bytes.subarray(4, 4 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true)) : bytes;
  return QRP.QRP.getRootAsQRP(new flatbuffers.ByteBuffer(Uint8Array.from(body))).unpack();
}
const cellValue = (c) => (c.KIND === QRP.qrpValueKind.Text ? c.TEXT_VALUE : c.KIND === QRP.qrpValueKind.Bool ? c.BOOL_VALUE
  : c.KIND === QRP.qrpValueKind.Bytes ? Buffer.from(c.BYTES_VALUE) : null);
const rowsOf = (page) => page.ROWS.map((r) => Object.fromEntries(page.COLUMNS.map((c, i) => [c.NAME, cellValue(r.CELLS[i])])));

// ---- the keyslot (a real X25519 slot; the test host plays the node's oracle) ---------------------------------------

const slot = crypto.generateKeyPairSync("x25519");
const SLOT_PUBLIC = slot.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const INFO = Buffer.from("sdn-server/keyslot.unwrap/v1");
const aesKey = (privateKey, publicKey) => Buffer.from(crypto.hkdfSync("sha256", crypto.diffieHellman({ privateKey, publicKey }), Buffer.alloc(0), INFO, 32));
const x25519Public = (raw) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), raw]), format: "der", type: "spki" });

function seal(plaintext, slotId = "provider-wrapping") {
  const eph = crypto.generateKeyPairSync("x25519");
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey(eph.privateKey, slot.publicKey), nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ slotId, ephemeralPublicKey: eph.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
    nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64") });
}
function unwrap(raw) {
  const sealed = Buffer.from(raw.ciphertext);
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey(slot.privateKey, x25519Public(Buffer.from(raw.ephemeral_public_key))), Buffer.from(raw.nonce));
  decipher.setAuthTag(sealed.subarray(-16));
  return Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
}

// ---- the host: every hostcall decoded from $PIV and answered with $PIV ----------------------------------------------

function createNode({ store = new Map(), publicKey = "hex", refuseWrites = false } = {}) {
  const calls = [];
  const answer = (call) => {
    const id = call.params?.ID;
    switch (call.op) {
      case "node.publicKey":
        if (publicKey === "none") return { ok: false, error: { code: "unsupported", message: "no node key" } };
        return { ok: true, op: call.op, raw: { value: publicKey === "hex" ? SLOT_PUBLIC.toString("hex") : SLOT_PUBLIC } };
      case "secrets.status":
        return { ok: true, op: call.op, result: { ID: id, CONFIGURED: store.has(id) } };
      case "secrets.get": {
        const held = store.get(id);
        return { ok: true, op: call.op, result: { ID: id, USERNAME: held?.username ?? "", CONFIGURED: !!held }, raw: { secret: held ? Buffer.from(held.secret) : new Uint8Array(0) } };
      }
      case "secrets.put":
        if (refuseWrites) return { ok: false, error: { code: "not-authorized", message: "no write grant" } };
        store.set(id, { username: call.params.USERNAME ?? "", secret: Buffer.from(call.raw.secret).toString() });
        return { ok: true, op: call.op, result: { ID: id, CONFIGURED: true } };
      case "secrets.clear":
        if (refuseWrites) return { ok: false, error: { code: "not-authorized", message: "no write grant" } };
        store.delete(id);
        return { ok: true, op: call.op };
      case "keyslot.unwrap":
        if (call.params.SLOT_ID !== "provider-wrapping") return { ok: false, error: { code: "invalid-params", message: "unknown slot" } };
        try { return { ok: true, op: call.op, raw: { data: unwrap(call.raw) } }; } catch { return { ok: false, error: { code: "failed", message: "open failed" } }; }
      default:
        return { ok: false, error: { code: "unsupported", message: call.op } };
    }
  };
  return { calls, store, answer };
}

// THE WASMEDGE LEG. This artifact declares runtimeTargets [wasmedge] (wallet_sign and secrets.* have no browser host),
// so the SDK browser harness refuses it at the door (runtime-target-out-of-scope). The SDK's in-process WasmEdge-leg
// host is the compiled-flow runtime host, so the test compiles a one-node flow around `mediate` - one manual trigger per
// input port, every output port to the egress sink - with the SDK CLI and drives it at runtimeTarget "wasmedge", the
// hostcall import answered here.
const SDK_CLI = fileURLToPath(new URL("../node_modules/space-data-module-sdk/bin/space-data-module.js", import.meta.url));
const FLOW_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cell-tower-credentials-flow-"));
const PORTS = ["catalog", "credential", "requests"];
{
  const plugin = "com.digitalarsenal.data-source.cell-tower-credentials";
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const flow = {
    programId: "com.digitalarsenal.tests.cell-tower-credentials", name: "credentials test", version: "0.0.1",
    nodes: [
      { nodeId: "credentials", pluginId: plugin, methodId: "mediate", kind: "transform", capabilities: manifest.capabilities, drainPolicy: "single-shot" },
      { nodeId: "egress", pluginId: "sdn.flow.egress", methodId: "emit", kind: "sink", drainPolicy: "single-shot" },
    ],
    edges: ["decision", "page", "requests", "status"].map((port) => ({ edgeId: `out-${port}`, fromNodeId: "credentials", fromPortId: port, toNodeId: "egress", toPortId: "response", backpressurePolicy: "queue", queueDepth: 16 })),
    triggers: PORTS.map((port) => ({ triggerId: `in-${port}`, kind: "manual", source: "test" })),
    triggerBindings: PORTS.map((port) => ({ triggerId: `in-${port}`, targetNodeId: "credentials", targetPortId: port, backpressurePolicy: "queue", queueDepth: 16 })),
    requiredPlugins: [plugin],
  };
  fs.writeFileSync(path.join(FLOW_DIR, "flow.json"), JSON.stringify(flow, null, 2));
  fs.writeFileSync(path.join(FLOW_DIR, "deps.json"), JSON.stringify({ [plugin]: fileURLToPath(new URL("..", import.meta.url)) }));
  execFileSync(process.execPath, [SDK_CLI, "flow", "compile", path.join(FLOW_DIR, "flow.json"), "--deps", path.join(FLOW_DIR, "deps.json"), "--out", path.join(FLOW_DIR, "dist")], { stdio: "pipe" });
}
const FLOW_WASM = fs.readFileSync(path.join(FLOW_DIR, "dist", "runtime.wasm"));
test.after(() => fs.rmSync(FLOW_DIR, { recursive: true, force: true }));

async function invoke(node, inputs) {
  const memoryRef = { memory: null };
  let own = new Uint8Array(0);
  const imports = { space_data_module_host: {
    call(opPtr, opLen, ptr, len) {
      const call = decodeHostCall(Uint8Array.from(new Uint8Array(memoryRef.memory.buffer, ptr, len)));
      node.calls.push(call);
      const r = node.answer(call);
      own = encodeHostCallResult(r.ok ? { ...r, op: call.op } : r);
      return 0;
    },
    response_len: () => own.length,
    read_response(dst, len) { const n = Math.min(len, own.length); new Uint8Array(memoryRef.memory.buffer).set(own.subarray(0, n), dst); return n; },
  } };
  const host = await createFlowRuntimeHost({ wasmSource: new Uint8Array(FLOW_WASM), extraImports: imports, runtimeTarget: "wasmedge" });
  memoryRef.memory = host.memory;
  for (const input of inputs) host.enqueueTriggerFrame(PORTS.indexOf(input.portId), { portId: input.portId, bytes: input.payload });
  const outputs = [];
  await host.drain({ "sdn.flow.egress:emit": ({ frames }) => { for (const f of frames) outputs.push(Uint8Array.from(f.bytes)); return { statusCode: 0 }; } });
  return { outputs, status: Number(host.getNodeState(0).lastStatus) };
}
const idAt = (b, at) => Buffer.from(b.subarray(at, at + 4)).toString("latin1");
async function mediate(t, node, inputs) {
  const response = await invoke(node, inputs);
  assert.equal(response.status, 0, "mediate refused");
  const out = { response, decision: [], page: [], requests: [], notices: [] };
  for (const b of response.outputs) {
    if (idAt(b, 4) === "$QRP") out.decision.push(readQrp(b, false));
    else if (idAt(b, 8) === "$QRP") out.page.push(readQrp(b, true));
    else if (idAt(b, 4) === "HREQ") out.requests.push(decodeHttpRequest(b));
    else if (idAt(b, 4) === "FNTC") out.notices.push(decodeFlowNotice(b));
    else assert.fail(`an egress frame of no declared type: ${idAt(b, 4)}`);
  }
  return out;
}
const putTask = (envelope, lane = "cell_opencellid", provider = "opencellid") =>
  ({ portId: "credential", typeRef: T.APR, payload: apr({ route: "credential-put", method: APR.aprMethod.PUT, params: { providerId: provider, credentialLane: lane }, body: encoder.encode(envelope), accept: APR.aprRepresentation.Json }) });
const clearTask = (lane = "cell_opencellid") =>
  ({ portId: "credential", typeRef: T.APR, payload: apr({ route: "credential-clear", method: APR.aprMethod.DELETE, params: { providerId: "opencellid", credentialLane: lane } }) });
const SECRET = "pk.0123456789abcdef-SECRET";
const envelopeOf = (o) => seal(Buffer.from(JSON.stringify(o)));
function assertNoSecret(out, secret = SECRET) {
  for (const f of out.response.outputs) assert.ok(!Buffer.from(f).includes(Buffer.from(secret)), "an output frame echoes the secret");
}

// ---- tests ---------------------------------------------------------------------------------------------------------

test("cell-tower-credentials passes SDK compliance with one concrete FlatBuffer type per port", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const report = await validateArtifactWithStandards({ manifest, wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const ids = {};
  for (const port of [...manifest.methods[0].inputPorts, ...manifest.methods[0].outputPorts]) {
    assert.equal(port.acceptedTypeSets.length, 1);
    const types = port.acceptedTypeSets[0].allowedTypes;
    assert.equal(types.length, 1);
    assert.equal(types[0].acceptsAnyFlatbuffer, undefined);
    assert.equal(types[0].wireFormat, "flatbuffer");
    ids[port.portId + (manifest.methods[0].inputPorts.includes(port) ? "<" : ">")] = types[0].fileIdentifier;
  }
  assert.deepEqual(ids, { "catalog<": "$QRP", "credential<": "$APR", "requests<": "HREQ", "decision>": "$QRP", "page>": "$QRP", "requests>": "HREQ", "status>": "FNTC" });
  assert.deepEqual(manifest.runtimeTargets, ["wasmedge"]);
  assert.equal(manifest.version, "0.2.0");
});

test("catalog: a held lane flips configured + selected, the node key fills the key slot (hex -> 32 raw bytes)", async (t) => {
  const node = createNode({ store: new Map([["cell_wigle", { username: "u", secret: "s" }]]) });
  const out = await mediate(t, node, [{ portId: "catalog", typeRef: T.QRP, payload: catalogPage() }]);
  assert.equal(out.decision.length, 1);
  assert.equal(out.decision[0].KIND, QRP.qrpKind.Request);
  assert.equal(out.decision[0].REPRESENTATION, QRP.qrpRepresentation.Json, "the request's representation rides to the responder");
  const rows = rowsOf(out.page[0]);
  assert.deepEqual(rows.map((r) => [r.id, r.credentialConfigured, r.defaultSelected]),
    [["opencellid", false, false], ["wigle", true, true], ["openstreetmap-overpass", false, true]]);
  for (const r of rows) {
    assert.equal(r.keySlotId, "provider-wrapping");
    assert.equal(r.keySlotAlgorithm, "X25519");
    assert.deepEqual(r.keySlotPublicKey, SLOT_PUBLIC);
  }
  // presence only: status asked for the two credentialed lanes, nothing read a value
  assert.deepEqual(node.calls.filter((c) => c.op === "secrets.status").map((c) => c.params.ID), LANES);
  assert.equal(node.calls.some((c) => c.op === "secrets.get"), false);
});

test("catalog: no node key -> the key slot cells stay Null (never invented)", async (t) => {
  const out = await mediate(t, createNode({ publicKey: "none" }), [{ portId: "catalog", typeRef: T.QRP, payload: catalogPage() }]);
  for (const r of rowsOf(out.page[0])) assert.deepEqual([r.keySlotId, r.keySlotPublicKey, r.keySlotAlgorithm], [null, null, null]);
});

test("put: a real sealed envelope is opened by the host and the secret reaches secrets.put on raw \"secret\" only", async (t) => {
  const node = createNode();
  const out = await mediate(t, node, [putTask(envelopeOf({ username: "alice", secret: SECRET }))]);
  const unwrapCall = node.calls.find((c) => c.op === "keyslot.unwrap");
  assert.equal(unwrapCall.params.SLOT_ID, "provider-wrapping");
  assert.equal(unwrapCall.params.ALGORITHM, 4, "X25519");
  const put = node.calls.find((c) => c.op === "secrets.put");
  assert.equal(put.params.ID, "cell_opencellid");
  assert.equal(put.params.USERNAME, "alice");
  assert.equal(Buffer.from(put.raw.secret).toString(), SECRET);
  assert.deepEqual(node.store.get("cell_opencellid"), { username: "alice", secret: SECRET });
  assert.equal(out.decision[0].KIND, QRP.qrpKind.Request);
  assert.deepEqual(rowsOf(out.page[0]), [{ providerId: "opencellid", credentialLane: "cell_opencellid", credentialConfigured: true, stored: true }]);
  assertNoSecret(out);
});

test("put refusals: foreign lane, unsealed body, wrong slot, unopenable envelope, empty secret, refused store, long username", async (t) => {
  const cases = [
    [putTask(envelopeOf({ secret: SECRET }), "spacetrack"), 400, "bad-lane"],
    [putTask(JSON.stringify({ username: "alice", secret: SECRET })), 400, "unsealed-credential"],
    [putTask(envelopeOf({ secret: SECRET }).replace("provider-wrapping", "other-slot")), 400, "unknown-key-slot"],
    [putTask(JSON.stringify({ ...JSON.parse(envelopeOf({ secret: SECRET })), ciphertext: Buffer.from("tampered-tampered").toString("base64") })), 400, "unwrap-failed"],
    [putTask(envelopeOf({ username: "alice", secret: "" })), 400, "empty-secret"],
    [putTask(envelopeOf({ username: "u".repeat(256), secret: SECRET })), 400, "username-too-long"],
  ];
  for (const [task, status, code] of cases) {
    const node = createNode();
    const out = await mediate(t, node, [task]);
    assert.equal(out.page.length, 0, code);
    assert.deepEqual([out.decision[0].KIND, out.decision[0].HTTP_STATUS, out.decision[0].ERROR_CODE], [QRP.qrpKind.Error, status, code]);
    assert.equal(node.calls.some((c) => c.op === "secrets.put"), false, `${code}: nothing stored`);
    assertNoSecret(out);
  }
  const refused = await mediate(t, createNode({ refuseWrites: true }), [putTask(envelopeOf({ secret: SECRET }))]);
  assert.deepEqual([refused.decision[0].HTTP_STATUS, refused.decision[0].ERROR_CODE], [403, "store-refused"]);
  assertNoSecret(refused);
});

test("clear: the same answer whether or not a credential was held (no presence oracle); a refused clear is 403", async (t) => {
  const held = createNode({ store: new Map([["cell_opencellid", { username: "", secret: SECRET }]]) });
  const a = await mediate(t, held, [clearTask()]);
  const b = await mediate(t, createNode(), [clearTask()]);
  assert.equal(held.store.has("cell_opencellid"), false);
  assert.deepEqual(rowsOf(a.page[0]), rowsOf(b.page[0]));
  assert.deepEqual(rowsOf(a.page[0]), [{ providerId: "opencellid", credentialLane: "cell_opencellid", credentialConfigured: false, cleared: true }]);
  const bad = await mediate(t, createNode(), [clearTask("secrets_spacetrack")]);
  assert.equal(bad.decision[0].ERROR_CODE, "bad-lane");
  const refused = await mediate(t, createNode({ refuseWrites: true }), [clearTask()]);
  assert.deepEqual([refused.decision[0].HTTP_STATUS, refused.decision[0].ERROR_CODE], [403, "clear-refused"]);
});

test("requests: {{credential}} filled from the CONTEXT lane, others verbatim, an empty lane dropped with a Skipped notice", async (t) => {
  const contract = (provider, lane) => {
    const params = { PROVIDERS: "opencellid,wigle,openstreetmap-overpass", provider, fetches: "3" };
    if (lane) params.credentialLane = lane;
    const record = apr({ route: "aggregate", method: APR.aprMethod.POST, params });
    const stream = new Uint8Array(4 + record.length);
    new DataView(stream.buffer).setUint32(0, record.length, true);
    stream.set(record, 4);
    return stream;
  };
  const credentialed = encodeHttpRequest({ url: "https://opencellid.org/cell/getInArea?key={{credential}}&format=csv", headers: { accept: "text/csv" }, timeoutMs: 40000, context: contract("opencellid", "cell_opencellid") });
  const missing = encodeHttpRequest({ url: "https://api.wigle.net/api/v2/cell/search?u={{credential_user}}&k={{credential}}", context: contract("wigle", "cell_wigle") });
  const open = encodeHttpRequest({ url: "https://overpass-api.de/api/interpreter?data=x", context: contract("openstreetmap-overpass") });
  const node = createNode({ store: new Map([["cell_opencellid", { username: "bob", secret: "a b&c" }]]) });
  const out = await mediate(t, node, [credentialed, missing, open].map((payload) => ({ portId: "requests", typeRef: T.HREQ, payload })));
  assert.equal(out.decision.length + out.page.length, 0, "a fetch is not an HTTP answer");
  assert.deepEqual(out.requests.map((r) => r.url), ["https://opencellid.org/cell/getInArea?key=a%20b%26c&format=csv", "https://overpass-api.de/api/interpreter?data=x"]);
  assert.equal(out.requests[0].timeoutMs, 40000);
  assert.deepEqual(out.requests[0].headers, { accept: "text/csv" });
  assert.deepEqual(Buffer.from(out.requests[0].context), Buffer.from(contract("opencellid", "cell_opencellid")), "CONTEXT travels untouched");
  assert.ok(out.response.outputs.some((f) => Buffer.from(f).equals(Buffer.from(open))), "an uncredentialed fetch passes verbatim");
  assert.equal(out.notices.length, 1);
  assert.deepEqual([out.notices[0].kind, out.notices[0].reason, out.notices[0].items], ["skipped", "credential-unavailable", ["wigle=no-credential"]]);
  assert.deepEqual(node.calls.filter((c) => c.op === "secrets.get").map((c) => c.params.ID), LANES);
});

test("one task kind per invocation; a surplus catalog frame is refused, nothing is answered", async () => {
  const both = await invoke(createNode(), [{ portId: "catalog", payload: catalogPage() }, clearTask()]);
  assert.equal(both.status, 500, "ambiguous-task");
  assert.equal(both.outputs.length, 0);
  const two = await invoke(createNode(), [{ portId: "catalog", payload: catalogPage() }, { portId: "catalog", payload: catalogPage() }]);
  assert.equal(two.status, 500, "batched-input-frames");
  assert.equal(two.outputs.length, 0);
});
