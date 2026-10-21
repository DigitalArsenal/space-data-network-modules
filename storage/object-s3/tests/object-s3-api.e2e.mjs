// The node's admin object API, end to end: the COMMITTED flows storage-credentials (the only holder of the secrets write
// grant and the unwrap oracle) and storage-object-s3-api (the read grant, the clock and http) compiled and run on the
// WasmEdge leg of the SDK flow runtime host over ONE node (one credential store). The credential is sealed in the
// "browser", PUT to /api/v1/storage/credentials/r2, opened by the node and stored; the object API then signs with it
// against the SigV4-verifying S3 mock (support/mock-s3.mjs). Every answer is one $HTR from foundation/http-respond whose
// body is the $APR result record.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import * as H from "../../support/harness.mjs";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const FLOWS = path.resolve(PACKAGE, "..", "..", "flows");
const ACCESS = "AKIAAPIACCESSKEY0002";
const SECRET = "api-secret-access-key-0123456789abcdefghij-SECRET";
const BUCKET = "apibucket";
const MiB = 1024 * 1024;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const loadFlow = H.loadFlow;
const credentialsFlow = loadFlow("storage-credentials");
const objectsFlow = loadFlow("storage-object-s3-api");
let credentialsWasm, objectsWasm, mock;
before(async () => {
  credentialsWasm = H.compileFlow(credentialsFlow);
  objectsWasm = H.compileFlow(objectsFlow);
  mock = await H.startMockS3({ accessKey: ACCESS, secret: SECRET, bucket: BUCKET, region: "auto" });
});
after(() => mock?.stop());

const answer = (outputs) => {
  const answers = outputs.filter((b) => H.idAt(b, 4) === "$HTR").map((b) => H.decodeHttpResponse(b));
  assert.equal(answers.length, 1, "exactly one $HTR per exchange");
  assert.equal(outputs.length, 1, "nothing else leaves the flow");
  for (const b of outputs) assert.ok(!Buffer.from(b).includes(Buffer.from(SECRET)), "the secret is in an egress frame");
  const a = answers[0];
  return { status: a.status, record: a.body?.length && a.headers.some((h) => h.value === "$APR") ? H.readApr(a.body) : null, body: a.body };
};
const credential = async (node, method, body, store = "r2") => {
  const htq = H.encodeHtq({ method, path: `/api/v1/storage/credentials/${store}`, headers: { accept: "application/json" }, body: body && new TextEncoder().encode(body) });
  const { outputs } = await H.runFlow({ wasm: credentialsWasm, node, inputs: [{ trigger: 0, portId: "request", payload: htq }] });
  const a = outputs.map((b) => H.decodeHttpResponse(b))[0];
  return { status: a.status, json: JSON.parse(Buffer.from(a.body).toString()) };
};
const objects = async (node, method, p, query = {}, body, headers = {}) => {
  const q = new URLSearchParams({ endpoint: mock.endpoint, ...query }).toString();
  const htq = H.encodeHtq({ method, path: `/api/v1/storage/objects/${p}`, query: q, headers, body });
  const { outputs } = await H.runFlow({ wasm: objectsWasm, node, inputs: [{ trigger: 0, portId: "request", payload: htq }] });
  return answer(outputs);
};

test("the grants are split across the two flows: write + unwrap only in credentials, read + clock + http only in the object API", () => {
  const caps = (f) => new Set(f.flow.nodes.flatMap((n) => n.capabilities));
  const writer = caps(credentialsFlow), reader = caps(objectsFlow);
  assert.ok(writer.has("wallet_sign") && writer.has("secrets:storage_r2:write") && writer.has("secrets:storage_r2"));
  assert.ok(!writer.has("http") && !writer.has("clock"), "the flow that writes credentials can reach no network");
  assert.ok(reader.has("http") && reader.has("clock") && reader.has("secrets:storage_r2"));
  assert.ok(![...reader].some((c) => c.endsWith(":write") || c === "wallet_sign"), "the flow that signs can write no credential and has no unwrap oracle");
  for (const f of [credentialsFlow, objectsFlow]) {
    assert.ok(f.flow.api.routes.every((r) => r.anonymous === false), "every route is behind an admin session");
    assert.equal(f.flow.triggers.length, 1, "the host mounts the first http trigger only");
  }
  assert.notEqual(credentialsFlow.flow.triggers[0].httpPath, objectsFlow.flow.triggers[0].httpPath);
});

test("a node: seal and PUT the credential, then put, get, head, list and delete over the object API; the mock verified every signature", async () => {
  await mock.reset();
  const node = H.createNode();
  const sealed = H.seal(Buffer.from(JSON.stringify({ username: ACCESS, secret: SECRET })));
  const stored = await credential(node, "PUT", sealed);
  assert.deepEqual([stored.status, stored.json], [200, [{ store: "r2", credentialLane: "storage_r2", credentialConfigured: true, stored: true }]]);
  assert.equal((await credential(node, "GET")).json[0].credentialConfigured, true);

  const body = crypto.randomBytes(200_000);
  const put = await objects(node, "PUT", `r2/${BUCKET}/terrain/499/a%20b%2Bc.bin`, { region: "auto", contentType: "application/octet-stream" }, body);
  assert.deepEqual([put.status, put.record.STATUS], [200, 200]);
  const head = await objects(node, "GET", `r2/${BUCKET}/terrain/499/a%20b%2Bc.bin`, { head: "1" });
  assert.equal(H.paramsOf(head.record)["content-length"], String(body.length));
  assert.equal(H.paramsOf(head.record)["content-type"], "application/octet-stream");
  assert.equal(head.record.BODY.length, 0, "the metadata read carries no object bytes");
  const got = await objects(node, "GET", `r2/${BUCKET}/terrain/499/a%20b%2Bc.bin`);
  assert.equal(sha(Buffer.from(got.record.BODY)), sha(body), "the bytes round-trip through the API");
  const ranged = await objects(node, "GET", `r2/${BUCKET}/terrain/499/a%20b%2Bc.bin`, {}, undefined, { range: "bytes=10-19" });
  assert.deepEqual([ranged.record.STATUS, Buffer.from(ranged.record.BODY).equals(body.subarray(10, 20))], [206, true]);
  const list = await objects(node, "GET", `r2/${BUCKET}`, { prefix: "terrain/" });
  const listing = H.readFil(list.record.BODY);
  assert.deepEqual(listing.ENTRIES.map((e) => [e.NAME, Number(e.SIZE)]), [["terrain/499/a b+c.bin", body.length]]);
  assert.equal((await objects(node, "DELETE", `r2/${BUCKET}/terrain/499/a%20b%2Bc.bin`)).record.STATUS, 204);
  const gone = await objects(node, "GET", `r2/${BUCKET}/terrain/499/a%20b%2Bc.bin`);
  assert.deepEqual([gone.status, gone.record.ERROR_CODE], [404, "NoSuchKey"]);
  const state = await mock.state();
  assert.ok(state.requests.length >= 6 && state.requests.every((r) => r.auth === "ok"));
  // the only credential read is secrets.get, by the object API; nothing in it wrote or unwrapped
  const reads = node.calls.filter((c) => c.op.startsWith("secrets.") && c.op !== "secrets.put" && c.op !== "secrets.status");
  assert.ok(reads.every((c) => c.op === "secrets.get"));
});

test("a 12 MiB multipart put over the API; a refused route and a missing credential answer as HTTP statuses", async () => {
  await mock.reset();
  const node = H.createNode();
  const noCredential = await objects(node, "GET", `r2/${BUCKET}/k`);
  assert.deepEqual([noCredential.status, noCredential.record.ERROR_CODE], [403, "no-credential"]);
  await credential(node, "PUT", H.seal(Buffer.from(JSON.stringify({ username: ACCESS, secret: SECRET }))));
  const big = crypto.randomBytes(12 * MiB + 5);
  const put = await objects(node, "PUT", `r2/${BUCKET}/big/obj.bin`, { partSize: String(5 * MiB), multipartThreshold: String(6 * MiB) }, big);
  assert.deepEqual([put.status, put.record.STATUS, H.paramsOf(put.record).parts, H.paramsOf(put.record).size], [200, 200, "3", String(big.length)]);
  assert.equal((await mock.state()).objects["big/obj.bin"].sha256, sha(big));
  const refused = [
    [await objects(node, "PATCH", `r2/${BUCKET}/k`), 405, "method-not-allowed"],
    [await objects(node, "GET", `r2`), 404, "no-bucket"],
    [await objects(node, "PUT", `r2/${BUCKET}`), 404, "no-key"],
    [await objects(node, "GET", `r2/${BUCKET}/k`, { endpoint: "http://example.com" }), 400, "bad-endpoint"],
  ];
  for (const [r, status, code] of refused) assert.deepEqual([r.status, r.record.ERROR_CODE], [status, code], code);
  const failing = await (async () => { await mock.failPart(1); return objects(node, "PUT", `r2/${BUCKET}/big/fail.bin`, { partSize: String(5 * MiB), multipartThreshold: String(6 * MiB) }, crypto.randomBytes(11 * MiB)); })();
  assert.deepEqual([failing.status, failing.record.ERROR_CODE], [502, "multipart-part-failed"]);
  assert.equal((await mock.state()).aborted.length, 1);
});
