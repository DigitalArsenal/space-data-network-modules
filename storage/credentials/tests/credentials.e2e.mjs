// storage/credentials, end to end: the BUILT module linked into the committed flows and run on the WasmEdge leg of the SDK
// flow runtime host (storage/support/harness.mjs). Every hostcall the module makes is decoded from its SDS $PIV request
// and answered with a real $PIV response; the keyslot envelope is a REAL X25519 + HKDF-SHA256 + AES-256-GCM seal made
// here with node:crypto and really opened by the test host, so a module that mangled any envelope byte would fail to store.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";

import * as H from "../../tools/test-support/harness.mjs";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PACKAGE, "plugin-manifest.json"), "utf8"));
const SECRET = "r2-secret-access-key-0123456789abcdef-SECRET";
const ACCESS = "AKIAEXAMPLEACCESSKEYID";

// ---- the one-node flow around `serve` and `mediate` (the QRP-level assertions) ----------------------------------------
const unit = {
  programId: "com.digitalarsenal.tests.storage-credentials", name: "credentials test", version: "0.0.1",
  nodes: [
    { nodeId: "serve", pluginId: MANIFEST.pluginId, methodId: "serve", kind: "transform", capabilities: MANIFEST.capabilities, drainPolicy: "single-shot" },
    { nodeId: "mediate", pluginId: MANIFEST.pluginId, methodId: "mediate", kind: "transform", capabilities: MANIFEST.capabilities, drainPolicy: "single-shot" },
    { nodeId: "egress", pluginId: "sdn.flow.egress", methodId: "emit", kind: "sink", drainPolicy: "single-shot" },
  ],
  edges: ["serve", "mediate"].flatMap((n) => ["decision", "page"].map((port) => ({ edgeId: `${n}-${port}`, fromNodeId: n, fromPortId: port, toNodeId: "egress", toPortId: "response", backpressurePolicy: "queue", queueDepth: 16 }))),
  triggers: [{ triggerId: "http", kind: "manual", source: "test" }, { triggerId: "task", kind: "manual", source: "test" }],
  triggerBindings: [
    { triggerId: "http", targetNodeId: "serve", targetPortId: "request", backpressurePolicy: "queue", queueDepth: 16 },
    { triggerId: "task", targetNodeId: "mediate", targetPortId: "credential", backpressurePolicy: "queue", queueDepth: 16 },
  ],
  requiredPlugins: [MANIFEST.pluginId],
};
const UNIT_WASM = H.compileFlow({ flow: unit, deps: { [MANIFEST.pluginId]: PACKAGE } });

async function exchange(node, { method, store = "r2", envelope, accept }) {
  const htq = H.encodeHtq({ method, path: `/api/v1/storage/credentials/${store}`, headers: accept ? { accept } : {}, body: envelope ? new TextEncoder().encode(envelope) : undefined });
  const { outputs } = await H.runFlow({ wasm: UNIT_WASM, node, inputs: [{ trigger: 0, portId: "request", payload: htq }] });
  return read(outputs);
}
function read(outputs) {
  const out = { outputs, decision: [], page: [] };
  for (const b of outputs) {
    if (H.idAt(b, 4) === "$QRP") out.decision.push(H.readQrp(b, false));
    else if (H.idAt(b, 8) === "$QRP") out.page.push(H.readQrp(b, true));
    else assert.fail(`an egress frame of no declared type: ${H.idAt(b, 4)}`);
  }
  return out;
}
const envelopeOf = (o, slotId) => H.seal(Buffer.from(JSON.stringify(o)), slotId);
function assertNoSecret(out) {
  for (const f of out.outputs) {
    assert.ok(!Buffer.from(f).includes(Buffer.from(SECRET)), "an output frame echoes the secret");
    assert.ok(!Buffer.from(f).includes(Buffer.from(ACCESS)), "an output frame echoes the access key id");
  }
}

test("storage/credentials passes SDK compliance with one concrete FlatBuffer type per port, holds no http and no plaintext path", async () => {
  const report = await validateArtifactWithStandards({ manifest: MANIFEST, wasmPath: path.join(PACKAGE, "dist", "isomorphic", "module.wasm"), standardsRoot: H.STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  for (const method of MANIFEST.methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      assert.equal(port.acceptedTypeSets.length, 1);
      assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1);
      assert.equal(port.acceptedTypeSets[0].allowedTypes[0].wireFormat, "flatbuffer");
    }
  }
  assert.deepEqual(MANIFEST.runtimeTargets, ["wasmedge"]);
  // the write grant and the unwrap oracle live here; no network and no signing
  assert.ok(MANIFEST.capabilities.includes("wallet_sign") && MANIFEST.capabilities.includes("secrets:storage_r2:write"));
  assert.ok(!MANIFEST.capabilities.includes("http") && !MANIFEST.capabilities.includes("clock"));
});

test("PUT: a real sealed envelope is opened by the host and the secret reaches secrets.put on raw \"secret\" only", async () => {
  const node = H.createNode();
  const out = await exchange(node, { method: "PUT", envelope: envelopeOf({ username: ACCESS, secret: SECRET }), accept: "application/json" });
  const unwrapCall = node.calls.find((c) => c.op === "keyslot.unwrap");
  assert.equal(unwrapCall.params.SLOT_ID, "provider-wrapping");
  assert.equal(unwrapCall.params.ALGORITHM, 4, "X25519");
  const put = node.calls.find((c) => c.op === "secrets.put");
  assert.equal(put.params.ID, "storage_r2");
  assert.equal(put.params.USERNAME, ACCESS);
  assert.deepEqual(node.store.get("storage_r2"), { username: ACCESS, secret: SECRET });
  assert.equal(out.decision[0].KIND, H.QRP.qrpKind.Request);
  assert.equal(out.decision[0].REPRESENTATION, H.QRP.qrpRepresentation.Json, "the request's representation rides to the responder");
  assert.deepEqual(H.rowsOf(out.page[0]), [{ store: "r2", credentialLane: "storage_r2", credentialConfigured: true, stored: true }]);
  assert.equal(node.calls.some((c) => c.op === "secrets.get"), false, "this module never reads a value");
  assertNoSecret(out);
});

test("PUT refusals: bad store, unsealed body, wrong slot, unopenable envelope, missing half, refused store, long username", async () => {
  const cases = [
    [{ store: "a.b", envelope: envelopeOf({ username: ACCESS, secret: SECRET }) }, 400, "bad-store"],
    [{ store: "R2", envelope: envelopeOf({ username: ACCESS, secret: SECRET }) }, 400, "bad-store"],
    [{ envelope: JSON.stringify({ username: ACCESS, secret: SECRET }) }, 400, "unsealed-credential"],
    [{ envelope: envelopeOf({ username: ACCESS, secret: SECRET }, "other-slot") }, 400, "unknown-key-slot"],
    [{ envelope: JSON.stringify({ ...JSON.parse(envelopeOf({ username: ACCESS, secret: SECRET })), ciphertext: Buffer.from("tampered-tampered").toString("base64") }) }, 400, "unwrap-failed"],
    [{ envelope: envelopeOf({ username: ACCESS, secret: "" }) }, 400, "empty-secret"],
    [{ envelope: envelopeOf({ username: "", secret: SECRET }) }, 400, "empty-secret"],
    [{ envelope: envelopeOf({ username: "u".repeat(256), secret: SECRET }) }, 400, "username-too-long"],
  ];
  for (const [request, status, code] of cases) {
    const node = H.createNode();
    const out = await exchange(node, { method: "PUT", ...request });
    assert.equal(out.page.length, 0, code);
    assert.deepEqual([out.decision[0].KIND, out.decision[0].HTTP_STATUS, out.decision[0].ERROR_CODE], [H.QRP.qrpKind.Error, status, code]);
    assert.equal(node.calls.some((c) => c.op === "secrets.put"), false, `${code}: nothing stored`);
    assertNoSecret(out);
  }
  const refused = await exchange(H.createNode({ refuseWrites: true }), { method: "PUT", envelope: envelopeOf({ username: ACCESS, secret: SECRET }) });
  assert.deepEqual([refused.decision[0].HTTP_STATUS, refused.decision[0].ERROR_CODE], [403, "store-refused"]);
  assertNoSecret(refused);
});

test("DELETE answers the same whether or not a credential was held (no presence oracle); a refused clear is 403", async () => {
  const held = H.createNode({ store: new Map([["storage_r2", { username: ACCESS, secret: SECRET }]]) });
  const a = await exchange(held, { method: "DELETE" });
  const b = await exchange(H.createNode(), { method: "DELETE" });
  assert.equal(held.store.has("storage_r2"), false);
  assert.deepEqual(H.rowsOf(a.page[0]), H.rowsOf(b.page[0]));
  assert.deepEqual(H.rowsOf(a.page[0]), [{ store: "r2", credentialLane: "storage_r2", credentialConfigured: false, cleared: true }]);
  const refused = await exchange(H.createNode({ refuseWrites: true }), { method: "DELETE" });
  assert.deepEqual([refused.decision[0].HTTP_STATUS, refused.decision[0].ERROR_CODE], [403, "clear-refused"]);
});

test("GET: presence only plus the node's wrapping key as raw bytes; no node key -> no key cells; never a value", async () => {
  const node = H.createNode({ store: new Map([["storage_r2", { username: ACCESS, secret: SECRET }]]) });
  const out = await exchange(node, { method: "GET" });
  const [row] = H.rowsOf(out.page[0]);
  assert.deepEqual([row.store, row.credentialLane, row.credentialConfigured, row.keySlotId, row.keySlotAlgorithm], ["r2", "storage_r2", true, "provider-wrapping", "X25519"]);
  assert.deepEqual(row.keySlotPublicKey, H.SLOT_PUBLIC);
  assert.equal(node.calls.some((c) => c.op === "secrets.get"), false);
  assertNoSecret(out);
  const bare = await exchange(H.createNode({ publicKey: "none" }), { method: "GET", store: "s3" });
  const [none] = H.rowsOf(bare.page[0]);
  assert.deepEqual([none.credentialConfigured, "keySlotId" in none], [false, false], "the key slot is never invented");
});

test("routing: no store, a nested path and a foreign method are refused by name", async () => {
  const node = H.createNode();
  const nostore = H.encodeHtq({ method: "PUT", path: "/api/v1/storage/credentials/" });
  const nested = H.encodeHtq({ method: "PUT", path: "/api/v1/storage/credentials/r2/x" });
  const other = H.encodeHtq({ method: "PATCH", path: "/api/v1/storage/credentials/r2" });
  const outside = H.encodeHtq({ method: "GET", path: "/api/v1/storage/objects/r2" });
  const got = [];
  for (const payload of [nostore, nested, other, outside]) {
    const { outputs } = await H.runFlow({ wasm: UNIT_WASM, node, inputs: [{ trigger: 0, portId: "request", payload }] });
    const r = read(outputs);
    got.push([r.decision[0].HTTP_STATUS, r.decision[0].ERROR_CODE]);
  }
  assert.deepEqual(got, [[404, "no-store"], [404, "no-store"], [405, "method-not-allowed"], [404, "no-route"]]);
});

test("mediate (the typed task path) and a surplus frame: one task per invocation", async () => {
  const task = (route) => H.apr({ route, params: { store: "minio" }, body: route === "credential-put" ? new TextEncoder().encode(envelopeOf({ username: ACCESS, secret: SECRET })) : undefined });
  const node = H.createNode();
  const { outputs } = await H.runFlow({ wasm: UNIT_WASM, node, inputs: [{ trigger: 1, portId: "credential", payload: task("credential-put") }] });
  assert.deepEqual(H.rowsOf(read(outputs).page[0]), [{ store: "minio", credentialLane: "storage_minio", credentialConfigured: true, stored: true }]);
  assert.deepEqual(node.store.get("storage_minio"), { username: ACCESS, secret: SECRET });
  const surplus = await H.runFlow({ wasm: UNIT_WASM, node: H.createNode(), inputs: [1, 2].map(() => ({ trigger: 1, portId: "credential", payload: task("credential-clear") })) });
  assert.equal(Number(surplus.host.getNodeState(1).lastStatus), 500, "batched-input-frames");
  assert.equal(surplus.outputs.length, 0, "a surplus is refused, nothing is answered");
});

// ---- the committed flow: the HTTP edge through foundation/http-respond --------------------------------------------------
test("the committed flow answers PUT/GET/DELETE as $HTR: status, JSON rendering, bytes as base64, never a value", async () => {
  const wasm = H.compileFlow(H.loadFlow("storage-credentials"));
  const node = H.createNode();
  const run = async (method, body, accept = "application/json") => {
    const payload = H.encodeHtq({ method, path: "/api/v1/storage/credentials/r2", headers: { accept }, body: body ? new TextEncoder().encode(body) : undefined });
    const { outputs } = await H.runFlow({ wasm, node, inputs: [{ trigger: 0, portId: "request", payload }] });
    const answers = outputs.filter((b) => H.idAt(b, 4) === "$HTR").map((b) => H.decodeHttpResponse(b));
    assert.equal(answers.length, 1, "exactly one $HTR per exchange");
    for (const b of outputs) {
      assert.ok(!Buffer.from(b).includes(Buffer.from(SECRET)), "the secret is in an egress frame");
    }
    return { status: answers[0].status, json: answers[0].body?.length ? JSON.parse(Buffer.from(answers[0].body).toString()) : null };
  };
  const status = await run("GET");
  assert.equal(status.status, 200);
  assert.deepEqual([status.json[0].store, status.json[0].credentialConfigured, status.json[0].keySlotId], ["r2", false, "provider-wrapping"]);
  assert.equal(Buffer.from(status.json[0].keySlotPublicKey, "base64").equals(H.SLOT_PUBLIC), true, "the key is base64 in the Json rendering");
  const stored = await run("PUT", envelopeOf({ username: ACCESS, secret: SECRET }));
  assert.equal(stored.status, 200);
  assert.deepEqual(stored.json, [{ store: "r2", credentialLane: "storage_r2", credentialConfigured: true, stored: true }]);
  assert.equal((await run("GET")).json[0].credentialConfigured, true);
  const bad = await run("PUT", JSON.stringify({ username: ACCESS, secret: SECRET }));
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "unsealed-credential");
  const cleared = await run("DELETE");
  assert.deepEqual([cleared.status, cleared.json[0].credentialConfigured], [200, false]);
  assert.equal(node.store.size, 0);
});
