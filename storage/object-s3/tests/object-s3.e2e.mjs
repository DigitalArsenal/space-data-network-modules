// storage/object-s3, end to end: the BUILT module linked into the committed flows/storage-object-s3.flow.json (sign ->
// hostcap/http-request -> split -> http-request -> assemble -> http-request -> finish) and run on the WasmEdge leg of the SDK
// flow runtime host (storage/support/harness.mjs). The credential is the node's: a sealed envelope opened by the REAL
// storage/credentials artifact into the test host's secrets store, then READ by object-s3 through secrets.get. http.request
// is a real HTTP exchange against a SigV4-verifying S3 mock (support/mock-s3.mjs: its own implementation on node:crypto, so
// a signing mistake is a 403 there, not a pass). The AWS-published GET Object example fixes the signature itself.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { decodeHttpRequest } from "space-data-module-sdk/runtime-contracts";

import * as H from "../../tools/test-support/harness.mjs";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const MODULES = path.resolve(PACKAGE, "..", "..");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PACKAGE, "plugin-manifest.json"), "utf8"));
const CREDENTIALS = path.join(MODULES, "storage", "credentials");
const CRED_MANIFEST = JSON.parse(fs.readFileSync(path.join(CREDENTIALS, "plugin-manifest.json"), "utf8"));

const ACCESS = "AKIATESTACCESSKEY0001";
const SECRET = "test-secret-access-key-0123456789abcdefghij-SECRET";
const BUCKET = "testbucket";
const MiB = 1024 * 1024;

const { flow, deps: flowDeps } = H.loadFlow("storage-object-s3");
let WASM;
let mock;
before(async () => {
  WASM = H.compileFlow({ flow, deps: flowDeps });
  mock = await H.startMockS3({ accessKey: ACCESS, secret: SECRET, bucket: BUCKET, region: "auto" });
});
after(() => mock?.stop());

// ---- the credential reaches the node the way it does in production: sealed, opened, stored --------------------------
async function nodeHolding(store, username = ACCESS, secret = SECRET, extra = {}) {
  const node = H.createNode(extra);
  const unit = {
    programId: "com.digitalarsenal.tests.storage-credentials-seed", name: "seed", version: "0.0.1",
    nodes: [{ nodeId: "credentials", pluginId: CRED_MANIFEST.pluginId, methodId: "mediate", kind: "transform", capabilities: CRED_MANIFEST.capabilities, drainPolicy: "single-shot" },
      { nodeId: "egress", pluginId: "sdn.flow.egress", methodId: "emit", kind: "sink", drainPolicy: "single-shot" }],
    edges: ["decision", "page"].map((port) => ({ edgeId: port, fromNodeId: "credentials", fromPortId: port, toNodeId: "egress", toPortId: "response", backpressurePolicy: "queue", queueDepth: 4 })),
    triggers: [{ triggerId: "task", kind: "manual", source: "test" }],
    triggerBindings: [{ triggerId: "task", targetNodeId: "credentials", targetPortId: "credential", backpressurePolicy: "queue", queueDepth: 4 }],
    requiredPlugins: [CRED_MANIFEST.pluginId],
  };
  seedWasm ??= H.compileFlow({ flow: unit, deps: { [CRED_MANIFEST.pluginId]: CREDENTIALS } });
  const envelope = H.seal(Buffer.from(JSON.stringify({ username, secret })));
  await H.runFlow({ wasm: seedWasm, node, inputs: [{ trigger: 0, portId: "credential", payload: H.apr({ route: "credential-put", params: { store }, body: new TextEncoder().encode(envelope) }) }] });
  assert.equal(node.store.get(`storage_${store}`)?.secret, secret, "the credential is stored by storage/credentials");
  node.calls.length = 0;
  return node;
}
let seedWasm;

const P = (extra = {}) => ({ store: "r2", endpoint: mock.endpoint, bucket: BUCKET, region: "auto", ...extra });
async function run(node, tasks) {
  const { outputs } = await H.runFlow({ wasm: WASM, node, inputs: tasks.map((t) => ({ trigger: 0, portId: "task", payload: H.apr(t) })) });
  const results = [], listings = [];
  for (const b of outputs) {
    assert.ok(!Buffer.from(b).includes(Buffer.from(SECRET)), "an egress frame carries the secret");
    if (H.idAt(b, 4) === "$APR") results.push(H.readApr(b));
    else if (H.idAt(b, 4) === "$FIL") listings.push(H.readFil(b));
    else assert.fail(`an egress frame of no declared type: ${H.idAt(b, 4)}`);
  }
  return { results, listings, outputs };
}
const byId = (results, id) => results.find((r) => r.REQUEST_ID === id);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// ---- manifest invariants ---------------------------------------------------------------------------------------------
test("object-s3 passes SDK compliance; it holds the read grant and the clock, never a write grant, http or the unwrap oracle", async () => {
  const report = await validateArtifactWithStandards({ manifest: MANIFEST, wasmPath: path.join(PACKAGE, "dist", "isomorphic", "module.wasm"), standardsRoot: H.STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  assert.deepEqual(MANIFEST.methods.map((m) => m.methodId), ["serve", "sign", "split", "assemble", "finish"]);
  for (const method of MANIFEST.methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      assert.equal(port.acceptedTypeSets.length, 1);
      assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1);
      assert.equal(port.acceptedTypeSets[0].allowedTypes[0].wireFormat, "flatbuffer");
    }
  }
  assert.ok(MANIFEST.capabilities.every((c) => c === "clock" || /^secrets:storage_[a-z0-9_]+$/.test(c)), JSON.stringify(MANIFEST.capabilities));
  assert.ok(!MANIFEST.capabilities.some((c) => c.endsWith(":write")), "no write grant");
  // the same lanes are the ones storage/credentials may write, so a lane is readable exactly where it is writable
  const lanes = (m, suffix) => m.capabilities.filter((c) => c.startsWith("secrets:") && c.endsWith(suffix)).map((c) => c.replace(/:write$/, ""));
  assert.deepEqual(lanes(MANIFEST, "").sort(), [...new Set(lanes(CRED_MANIFEST, ":write"))].sort());
  assert.deepEqual(MANIFEST.runtimeTargets, ["wasmedge"]);
});

// A one-node flow around `sign`, for the tests that read the signed request itself.
let signUnit;
function signWasm() {
  signUnit ??= H.compileFlow({ flow: {
    programId: "com.digitalarsenal.tests.storage-sign", name: "sign", version: "0.0.1",
    nodes: [{ nodeId: "sign", pluginId: MANIFEST.pluginId, methodId: "sign", kind: "transform", capabilities: MANIFEST.capabilities, drainPolicy: "single-shot" },
      { nodeId: "egress", pluginId: "sdn.flow.egress", methodId: "emit", kind: "sink", drainPolicy: "single-shot" }],
    edges: ["requests", "held"].map((port) => ({ edgeId: port, fromNodeId: "sign", fromPortId: port, toNodeId: "egress", toPortId: "response", backpressurePolicy: "queue", queueDepth: 4 })),
    triggers: [{ triggerId: "task", kind: "manual", source: "test" }],
    triggerBindings: [{ triggerId: "task", targetNodeId: "sign", targetPortId: "task", backpressurePolicy: "queue", queueDepth: 4 }],
    requiredPlugins: [MANIFEST.pluginId],
  }, deps: { [MANIFEST.pluginId]: PACKAGE } });
  return signUnit;
}

// ---- the published SigV4 example -------------------------------------------------------------------------------------
test("SigV4: the AWS-published GET Object example (Range bytes=0-9, virtual-hosted) signs to the documented signature", async () => {
  const wasm = signWasm();
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html  "Example: GET Object"
  const node = H.createNode({ store: new Map([["storage_custom", { username: "AKIAIOSFODNN7EXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" }]]) });
  const task = H.apr({ route: "get", requestId: "aws-doc", params: { store: "custom", endpoint: "https://s3.amazonaws.com", region: "us-east-1", bucket: "examplebucket", key: "test.txt", style: "virtual", range: "bytes=0-9", date: "20130524T000000Z", freshRead: "false" } });
  const { outputs } = await H.runFlow({ wasm, node, inputs: [{ trigger: 0, portId: "task", payload: task }] });
  assert.equal(outputs.length, 1);
  const request = decodeHttpRequest(outputs[0]);
  assert.equal(request.method, "GET");
  assert.equal(request.url, "https://examplebucket.s3.amazonaws.com/test.txt");
  assert.equal(request.headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41".replace(",SignedHeaders", ", SignedHeaders").replace(",Signature", ", Signature"));
  assert.equal(request.headers["x-amz-content-sha256"], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(request.headers.range, "bytes=0-9");
  assert.equal(request.headers.host, undefined, "Host is derived from the URL, which is what was signed");
  assert.ok(!Buffer.from(outputs[0]).includes(Buffer.from("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")), "the secret is in the request");
  assert.deepEqual(node.calls.map((c) => c.op), ["secrets.get"], "one credential read, and no clock read when the task fixes the date");
});

test("payload hash: UNSIGNED-PAYLOAD for a body over https, the body's SHA-256 when payload=signed or over plain http, the empty hash for reads", async () => {
  const wasm = signWasm();
  const node = H.createNode({ store: new Map([["storage_r2", { username: ACCESS, secret: SECRET }]]) });
  const body = Buffer.from("payload bytes");
  const hashOf = async (params, withBody = true) => {
    const task = H.apr({ route: withBody ? "put" : "get", requestId: "ph", params: { store: "r2", bucket: BUCKET, key: "k", region: "auto", date: "20261021T120000Z", ...params }, body: withBody ? body : undefined });
    const { outputs } = await H.runFlow({ wasm, node, inputs: [{ trigger: 0, portId: "task", payload: task }] });
    return decodeHttpRequest(outputs[0]).headers["x-amz-content-sha256"];
  };
  assert.equal(await hashOf({ endpoint: "https://x.r2.cloudflarestorage.com" }), "UNSIGNED-PAYLOAD");
  assert.equal(await hashOf({ endpoint: "https://x.r2.cloudflarestorage.com", payload: "signed" }), sha(body));
  assert.equal(await hashOf({ endpoint: "http://127.0.0.1:9000" }), sha(body));
  assert.equal(await hashOf({ endpoint: "http://127.0.0.1:9000", payload: "unsigned" }), "UNSIGNED-PAYLOAD");
  assert.equal(await hashOf({ endpoint: "https://x.r2.cloudflarestorage.com" }, false), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

// ---- put / head / get / list / delete against the verifying mock -------------------------------------------------------
test("small objects: put, head, ranged get, delete, 404; unicode and reserved characters in the key sign correctly", async () => {
  await mock.reset();
  const node = await nodeHolding("r2");
  const body = Buffer.from("hello object store, twice over. ".repeat(20));
  const key = "terrain/499/ünï cøde+&=/a b.txt";
  let { results } = await run(node, [{ route: "put", requestId: "p1", params: P({ key, contentType: "text/plain", cacheControl: "public, max-age=60" }), body }]);
  assert.deepEqual([results[0].STATUS, results[0].ERROR_CODE ?? ""], [200, ""]);
  assert.equal(H.paramsOf(results[0]).etag, `"${crypto.createHash("md5").update(body).digest("hex")}"`);
  ({ results } = await run(node, [
    { route: "head", requestId: "h1", params: P({ key }) },
    { route: "get", requestId: "g1", params: P({ key }) },
    { route: "get", requestId: "g2", params: P({ key, range: "bytes=3-9" }) },
    { route: "head", requestId: "h2", params: P({ key: "missing/object" }) },
    { route: "get", requestId: "g3", params: P({ key: "missing/object" }) },
  ]));
  assert.deepEqual([byId(results, "h1").STATUS, H.paramsOf(byId(results, "h1"))["content-length"], H.paramsOf(byId(results, "h1"))["content-type"]], [200, String(body.length), "text/plain"]);
  assert.deepEqual(Buffer.from(byId(results, "g1").BODY), body);
  assert.equal(byId(results, "g2").STATUS, 206);
  assert.equal(Buffer.from(byId(results, "g2").BODY).toString(), body.subarray(3, 10).toString());
  assert.equal(H.paramsOf(byId(results, "g2"))["content-range"], `bytes 3-9/${body.length}`);
  assert.deepEqual([byId(results, "h2").STATUS, byId(results, "h2").ERROR_CODE], [404, "NotFound"]);
  assert.deepEqual([byId(results, "g3").STATUS, byId(results, "g3").ERROR_CODE], [404, "NoSuchKey"]);
  ({ results } = await run(node, [{ route: "delete", requestId: "d1", params: P({ key }) }, { route: "head", requestId: "h3", params: P({ key }) }]));
  assert.equal(byId(results, "d1").STATUS, 204);
  assert.equal(byId(results, "h3").STATUS, 404, "deleted");
  const state = await mock.state();
  assert.ok(state.requests.length > 0 && state.requests.every((r) => r.auth === "ok"), "the mock verified every signature independently");
  assert.ok(state.requests.every((r) => new RegExp(`^AWS4-HMAC-SHA256 Credential=${ACCESS}/\\d{8}/auto/s3/aws4_request, SignedHeaders=.*host.*x-amz-content-sha256.*x-amz-date`).test(r.authorization)));
});

test("payload=unsigned and a signed payload both verify; plain http signs the body's SHA-256 by default", async () => {
  await mock.reset();
  const node = await nodeHolding("r2");
  const body = crypto.randomBytes(300_000);
  const { results } = await run(node, [
    { route: "put", requestId: "u1", params: P({ key: "x/unsigned.bin", payload: "unsigned" }), body },
    { route: "put", requestId: "u2", params: P({ key: "x/signed.bin" }), body },
    { route: "put", requestId: "u3", params: P({ key: "x/forced.bin", payload: "signed" }), body },
  ]);
  assert.deepEqual(results.map((r) => r.STATUS).sort(), [200, 200, 200]);
  const state = await mock.state();
  assert.equal(state.objects["x/unsigned.bin"].sha256, sha(body));
  assert.equal(state.objects["x/signed.bin"].sha256, sha(body));
  assert.equal(state.objects["x/forced.bin"].sha256, sha(body));
});

test("list: prefix, delimiter (common prefixes as directories), pagination by continuation token, size and last-modified", async () => {
  await mock.reset();
  const node = await nodeHolding("r2");
  const keys = ["raw/499/a.img", "raw/499/b.img", "raw/301/c.img", "raw/301/d.img", "pack/e.dtts"];
  await run(node, keys.map((key, i) => ({ route: "put", requestId: `l${i}`, params: P({ key }), body: Buffer.alloc(10 + i, i) })));
  let page = await run(node, [{ route: "list", requestId: "ls1", params: P({ prefix: "raw/", delimiter: "/" }) }]);
  assert.deepEqual(page.listings[0].ENTRIES.map((e) => [e.NAME, e.KIND]), [["raw/301/", H.FIL.filEntryKind.Directory], ["raw/499/", H.FIL.filEntryKind.Directory]]);
  assert.equal(page.listings[0].PATH, `${BUCKET}/raw/`);
  // pagination
  const seen = [];
  let token = "";
  for (let i = 0; i < 10; i++) {
    page = await run(node, [{ route: "list", requestId: `pg${i}`, params: P({ maxKeys: 2, ...(token ? { continuationToken: token } : {}) }) }]);
    const p = H.paramsOf(page.results[0]);
    seen.push(...page.listings[0].ENTRIES.map((e) => [e.NAME, Number(e.SIZE)]));
    assert.ok(page.listings[0].ENTRIES.every((e) => Number(e.MODIFIED_AT_MS) > 1.7e12), "LastModified parsed to unix ms");
    token = p.nextContinuationToken ?? "";
    if (p.isTruncated !== "true") break;
    assert.equal(p.keyCount, "2");
  }
  assert.deepEqual(seen.map(([k]) => k), [...keys].sort());
  assert.deepEqual(Object.fromEntries(seen), Object.fromEntries(keys.map((k, i) => [k, 10 + i])));
});

// ---- multipart ---------------------------------------------------------------------------------------------------------
test("multipart: a put above the threshold runs create -> 3 parts -> complete through the DAG; bytes, size and composite ETag round-trip", async () => {
  await mock.reset();
  const node = await nodeHolding("r2");
  const big = crypto.randomBytes(12 * MiB + 17);
  let { results } = await run(node, [{ route: "put", requestId: "m1", params: P({ key: "big/obj.bin", partSize: 5 * MiB, multipartThreshold: 6 * MiB, contentType: "application/octet-stream" }), body: big }]);
  assert.equal(results.length, 1, "exactly one result for the put");
  const put = results[0];
  assert.deepEqual([put.STATUS, put.ERROR_CODE ?? ""], [200, ""]);
  const p = H.paramsOf(put);
  assert.deepEqual([p.parts, p.size, p.key], ["3", String(big.length), "big/obj.bin"]);
  const state = await mock.state();
  assert.equal(state.objects["big/obj.bin"].sha256, sha(big), "the stored object is the put body, byte for byte");
  const partMd5s = [0, 1, 2].map((i) => crypto.createHash("md5").update(big.subarray(i * 5 * MiB, Math.min(big.length, (i + 1) * 5 * MiB))).digest());
  assert.equal(H.paramsOf(put).etag, `"${crypto.createHash("md5").update(Buffer.concat(partMd5s)).digest("hex")}-3"`);
  assert.deepEqual(state.requests.filter((r) => r.path.endsWith("big/obj.bin")).map((r) => r.method + r.query.replace(/uploadId=[^&]+/, "uploadId=U")),
    ["POST?uploads=", "PUT?partNumber=1&uploadId=U", "PUT?partNumber=2&uploadId=U", "PUT?partNumber=3&uploadId=U", "POST?uploadId=U"]);
  // head and ranged gets reassemble it
  ({ results } = await run(node, [{ route: "head", requestId: "h", params: P({ key: "big/obj.bin" }) },
    ...[0, 1, 2].map((i) => ({ route: "get", requestId: `g${i}`, params: P({ key: "big/obj.bin", range: `bytes=${i * 5 * MiB}-${Math.min(big.length, (i + 1) * 5 * MiB) - 1}` }) }))]));
  assert.equal(H.paramsOf(byId(results, "h"))["content-length"], String(big.length));
  const back = Buffer.concat([0, 1, 2].map((i) => Buffer.from(byId(results, `g${i}`).BODY)));
  assert.equal(sha(back), sha(big));
});

test("multipart: a part the store refuses aborts the upload and answers multipart-part-failed; nothing is stored", async () => {
  await mock.reset();
  const node = await nodeHolding("r2");
  await mock.failPart(2);
  const { results } = await run(node, [{ route: "put", requestId: "f1", params: P({ key: "big/fails.bin", partSize: 5 * MiB, multipartThreshold: 6 * MiB }), body: crypto.randomBytes(11 * MiB) }]);
  assert.equal(results.length, 1);
  assert.deepEqual([results[0].STATUS, results[0].ERROR_CODE], [502, "multipart-part-failed"]);
  assert.match(results[0].ERROR_MESSAGE, /part 2: InternalError/);
  const state = await mock.state();
  assert.equal(state.aborted.length, 1, "AbortMultipartUpload was sent");
  assert.equal(state.objects["big/fails.bin"], undefined);
});

test("multipart: a refused CreateMultipartUpload answers the store's error; a bad partSize is refused before any request", async () => {
  await mock.reset();
  const node = await nodeHolding("r2", ACCESS, "the-wrong-secret");
  let { results } = await run(node, [{ route: "put", requestId: "c1", params: P({ key: "big/denied.bin", partSize: 5 * MiB, multipartThreshold: 6 * MiB }), body: crypto.randomBytes(7 * MiB) }]);
  assert.deepEqual([results[0].STATUS, results[0].ERROR_CODE], [403, "SignatureDoesNotMatch"]);
  assert.match(results[0].ERROR_MESSAGE, /CreateMultipartUpload refused/);
  const good = await nodeHolding("r2");
  ({ results } = await run(good, [{ route: "put", requestId: "c2", params: P({ key: "big/tiny-parts.bin", partSize: 1 * MiB, multipartThreshold: 6 * MiB }), body: crypto.randomBytes(7 * MiB) }]));
  assert.deepEqual([results[0].STATUS, results[0].ERROR_CODE], [400, "bad-part-size"]);
  assert.equal((await mock.state()).requests.filter((r) => r.path.endsWith("tiny-parts.bin")).length, 0);
});

// ---- refusals and the credential --------------------------------------------------------------------------------------
test("refusals are results, never traps: no credential, no read grant, no clock, bad endpoint, bad store, unknown route", async () => {
  await mock.reset();
  const cases = [
    [await nodeHolding("s3"), P({ key: "k" }), 403, "no-credential"],            // the r2 lane holds nothing on this node
    [await nodeHolding("r2", ACCESS, SECRET, { refuseReads: true }), P({ key: "k" }), 403, "no-credential"],
    [await nodeHolding("r2", ACCESS, SECRET, { withClock: false }), P({ key: "k" }), 503, "no-clock"],
    [await nodeHolding("r2"), P({ key: "k", endpoint: "http://example.com" }), 400, "bad-endpoint"],
    [await nodeHolding("r2"), P({ key: "k", endpoint: "ftp://x" }), 400, "bad-endpoint"],
    [await nodeHolding("r2"), P({ key: "k", store: "R2" }), 400, "bad-store"],
    [await nodeHolding("r2"), P({ key: "" }), 400, "missing-key"],
    [await nodeHolding("r2"), P({ key: "k", bucket: "a/b" }), 400, "bad-bucket"],
  ];
  for (const [node, params, status, code] of cases) {
    const { results } = await run(node, [{ route: "get", requestId: "z", params }]);
    assert.deepEqual([results.length, results[0].STATUS, results[0].ERROR_CODE], [1, status, code], code);
  }
  const { results } = await run(await nodeHolding("r2"), [{ route: "copy", requestId: "z", params: P({ key: "k" }) }]);
  assert.deepEqual([results[0].STATUS, results[0].ERROR_CODE], [400, "unknown-route"]);
  assert.equal((await mock.state()).requests.length, 0, "no refused task reached the network");
});

test("the date comes from the clock when the task fixes none: one clock read per invocation, one credential read per store", async () => {
  await mock.reset();
  const node = await nodeHolding("r2", ACCESS, SECRET, { now: new Date().toISOString() });
  await run(node, [0, 1, 2].map((i) => ({ route: "head", requestId: `c${i}`, params: P({ key: `k${i}` }) })));
  const ops = node.calls.map((c) => c.op);
  assert.equal(ops.filter((o) => o === "clock.nowIso").length, 1);
  assert.equal(ops.filter((o) => o === "secrets.get").length, 1);
  assert.equal(ops.filter((o) => o.startsWith("secrets.") && o !== "secrets.get").length, 0, "this module never writes, clears or probes a credential");
  assert.equal(ops.includes("keyslot.unwrap"), false);
});
