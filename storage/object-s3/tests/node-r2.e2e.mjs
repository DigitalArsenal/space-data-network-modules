// The task's end-to-end on a DEPLOYED NODE: the node (SDN_NODE_URL, e.g. http://127.0.0.1:17773 with dev auto-admin, or a
// node with an admin session cookie in SDN_NODE_COOKIE) has the storage-credentials and storage-object-s3-api flows
// installed and approved. The Cloudflare R2 credential is sealed here, "in the browser", to the key the node publishes
// (GET /api/v1/storage/credentials/r2), PUT to the node and opened there by the keyslot oracle into its secrets store; the
// object API then puts, heads, gets (ranged) and lists a 100 MB multipart object in s3://spaceaware, the bytes round-trip,
// and the object is deleted. Every answer is the $APR result record. The credential is read from r2.env here and sent only
// sealed; the test asserts it is in no response from the node. Skips without SDN_NODE_URL or r2.env. Writes only under
// _sdn-storage-e2e/<run>/, never enumerates buckets.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as H from "../../support/harness.mjs";

const NODE = (process.env.SDN_NODE_URL ?? "").replace(/\/$/, "");
const COOKIE = process.env.SDN_NODE_COOKIE ?? "";
const ENV_FILE = process.env.R2_ENV_FILE ?? path.join(os.homedir(), ".config", "spacedatanetwork", "r2.env");
const env = fs.existsSync(ENV_FILE)
  ? Object.fromEntries(fs.readFileSync(ENV_FILE, "utf8").split("\n").map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]))
  : {};
const LIVE = Boolean(NODE && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ENDPOINT);
const BUCKET = env.R2_BUCKET || "spaceaware";
const ENDPOINT = LIVE ? new URL(env.R2_ENDPOINT).origin : "";
const MiB = 1024 * 1024;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

async function call(method, urlPath, { query = {}, body, headers = {}, accept } = {}) {
  const url = new URL(NODE + urlPath);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const response = await fetch(url, { method, body, headers: { ...(COOKIE ? { cookie: COOKIE } : {}), ...(accept ? { accept } : {}), ...headers }, signal: AbortSignal.timeout(600_000) });
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()), headers: response.headers };
}
const record = (r) => { assert.equal(r.headers.get("x-sdn-file-identifier"), "$APR", `not an $APR answer: ${r.status} ${r.bytes.subarray(0, 200)}`); return H.readApr(r.bytes); };

test("deployed node: seal and PUT the R2 credential, then 100 MB multipart put, head, ranged get, list, delete in s3://spaceaware", { skip: LIVE ? false : "needs SDN_NODE_URL and r2.env" }, async () => {
  // 1. the node publishes its wrapping key; the credential is sealed to it
  const status = await call("GET", "/api/v1/storage/credentials/r2", { accept: "application/json" });
  assert.equal(status.status, 200, status.bytes.toString().slice(0, 300));
  const [slot] = JSON.parse(status.bytes.toString());
  assert.equal(slot.keySlotId, "provider-wrapping");
  assert.equal(slot.keySlotAlgorithm, "X25519");
  const envelope = H.seal(Buffer.from(JSON.stringify({ username: env.R2_ACCESS_KEY_ID, secret: env.R2_SECRET_ACCESS_KEY })), "provider-wrapping", Buffer.from(slot.keySlotPublicKey, "base64"));
  const stored = await call("PUT", "/api/v1/storage/credentials/r2", { body: envelope, accept: "application/json", headers: { "content-type": "application/json" } });
  assert.equal(stored.status, 200, stored.bytes.toString().slice(0, 300));
  assert.deepEqual(JSON.parse(stored.bytes.toString()), [{ store: "r2", credentialLane: "storage_r2", credentialConfigured: true, stored: true }]);
  for (const r of [status, stored]) {
    assert.ok(!r.bytes.includes(Buffer.from(env.R2_SECRET_ACCESS_KEY)) && !r.bytes.includes(Buffer.from(env.R2_ACCESS_KEY_ID)), "the node echoed the credential");
  }
  assert.equal(JSON.parse((await call("GET", "/api/v1/storage/credentials/r2", { accept: "application/json" })).bytes.toString())[0].credentialConfigured, true);

  // 2. the object API
  const prefix = `_sdn-storage-e2e/${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}/`;
  const key = `${prefix}object-100mb.bin`;
  const obj = (k) => `/api/v1/storage/objects/r2/${BUCKET}/${k.split("/").map(encodeURIComponent).join("/")}`;
  const q = (extra = {}) => ({ endpoint: ENDPOINT, region: "auto", ...extra });
  const object = crypto.randomBytes(100_000_000);
  const partSize = 16 * MiB;
  const parts = Math.ceil(object.length / partSize);
  try {
    const t0 = Date.now();
    const put = await call("PUT", obj(key), { query: q({ partSize: String(partSize), contentType: "application/octet-stream" }), body: object });
    const putRecord = record(put);
    assert.deepEqual([put.status, putRecord.STATUS, putRecord.ERROR_CODE ?? "", putRecord.ERROR_MESSAGE ?? ""], [200, 200, "", ""], putRecord.ERROR_MESSAGE);
    assert.deepEqual([H.paramsOf(putRecord).parts, H.paramsOf(putRecord).size], [String(parts), String(object.length)]);
    const partMd5 = Array.from({ length: parts }, (_, i) => crypto.createHash("md5").update(object.subarray(i * partSize, Math.min(object.length, (i + 1) * partSize))).digest());
    assert.equal(H.paramsOf(putRecord).etag.replaceAll('"', ""), `${crypto.createHash("md5").update(Buffer.concat(partMd5)).digest("hex")}-${parts}`);
    const putMs = Date.now() - t0;

    const headRaw = await call("HEAD", obj(key), { query: q() });
    assert.equal(headRaw.status, 200, "HTTP HEAD answers the status");
    const head = record(await call("GET", obj(key), { query: q({ head: "1" }) }));
    assert.deepEqual([head.STATUS, H.paramsOf(head)["content-length"]], [200, String(object.length)]);
    const ranges = 4, step = Math.ceil(object.length / ranges);
    const chunks = [];
    for (let i = 0; i < ranges; i++) {
      const got = await call("GET", obj(key), { query: q(), headers: { range: `bytes=${i * step}-${Math.min(object.length, (i + 1) * step) - 1}` } });
      const r = record(got);
      assert.equal(r.STATUS, 206, r.ERROR_MESSAGE);
      chunks.push(Buffer.from(r.BODY));
    }
    const back = Buffer.concat(chunks);
    assert.equal(back.length, object.length);
    assert.equal(sha(back), sha(object), "the bytes round-trip");
    const list = record(await call("GET", `/api/v1/storage/objects/r2/${BUCKET}`, { query: q({ prefix }) }));
    assert.equal(list.STATUS, 200, list.ERROR_MESSAGE);
    const entries = H.readFil(list.BODY).ENTRIES.map((e) => [e.NAME, Number(e.SIZE)]);
    assert.deepEqual(entries, [[key, object.length]]);
    console.log(`node ${NODE}: put ${object.length} B in ${parts} parts ${putMs} ms; head etag ${H.paramsOf(head).etag}; 4 ranged gets sha256 ${sha(back).slice(0, 16)}...; list ${entries.length} entry under ${prefix}`);
  } finally {
    const del = await call("DELETE", obj(key), { query: q() });
    assert.ok([200, 204].includes(del.status), `delete: ${del.status}`);
    const gone = record(await call("GET", obj(key), { query: q({ head: "1" }) }));
    assert.equal(gone.STATUS, 404);
  }
});
