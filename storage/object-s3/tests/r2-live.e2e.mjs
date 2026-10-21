// The task's end-to-end against the real store: the sealed Cloudflare R2 credential goes through storage/credentials into the
// node's secrets store, and the committed flow puts, heads, gets (ranged) and lists a 100 MB multipart object in
// s3://spaceaware, the bytes round-trip, and the credential appears in no frame the modules emit except as the access key id
// in the Authorization header. Skips without ~/.config/spacedatanetwork/r2.env (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
// R2_ENDPOINT, R2_BUCKET). Writes only under _sdn-storage-e2e/<run>/ and deletes it; never lists or touches another key,
// never enumerates buckets.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as H from "../../support/harness.mjs";

const ENV_FILE = process.env.R2_ENV_FILE ?? path.join(os.homedir(), ".config", "spacedatanetwork", "r2.env");
const env = fs.existsSync(ENV_FILE)
  ? Object.fromEntries(fs.readFileSync(ENV_FILE, "utf8").split("\n").map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]))
  : {};
const LIVE = Boolean(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ENDPOINT);

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const MODULES = path.resolve(PACKAGE, "..", "..");
const CRED_MANIFEST = JSON.parse(fs.readFileSync(path.join(MODULES, "storage", "credentials", "plugin-manifest.json"), "utf8"));
const MiB = 1024 * 1024;
const BUCKET = env.R2_BUCKET || "spaceaware";
const ENDPOINT = LIVE ? new URL(env.R2_ENDPOINT).origin : "";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

test("R2 live: 100 MB multipart put, head, ranged get, list and delete in s3://spaceaware; the credential never leaves the node", { skip: LIVE ? false : "no r2.env" }, async () => {
  const wasm = H.compileFlow(H.loadFlow("storage-object-s3"));

  // 1. the credential is sealed in the "browser" and opened on the node by storage/credentials
  const node = H.createNode();
  const seed = {
    programId: "com.digitalarsenal.tests.storage-credentials-seed", name: "seed", version: "0.0.1",
    nodes: [{ nodeId: "credentials", pluginId: CRED_MANIFEST.pluginId, methodId: "mediate", kind: "transform", capabilities: CRED_MANIFEST.capabilities, drainPolicy: "single-shot" },
      { nodeId: "egress", pluginId: "sdn.flow.egress", methodId: "emit", kind: "sink", drainPolicy: "single-shot" }],
    edges: ["decision", "page"].map((port) => ({ edgeId: port, fromNodeId: "credentials", fromPortId: port, toNodeId: "egress", toPortId: "response", backpressurePolicy: "queue", queueDepth: 4 })),
    triggers: [{ triggerId: "task", kind: "manual", source: "test" }],
    triggerBindings: [{ triggerId: "task", targetNodeId: "credentials", targetPortId: "credential", backpressurePolicy: "queue", queueDepth: 4 }],
    requiredPlugins: [CRED_MANIFEST.pluginId],
  };
  const seedWasm = H.compileFlow({ flow: seed, deps: { [CRED_MANIFEST.pluginId]: path.join(MODULES, "storage", "credentials") } });
  const envelope = H.seal(Buffer.from(JSON.stringify({ username: env.R2_ACCESS_KEY_ID, secret: env.R2_SECRET_ACCESS_KEY })));
  const stored = await H.runFlow({ wasm: seedWasm, node, inputs: [{ trigger: 0, portId: "credential", payload: H.apr({ route: "credential-put", params: { store: "r2" }, body: new TextEncoder().encode(envelope) }) }] });
  assert.equal(node.store.has("storage_r2"), true);
  for (const b of stored.outputs) {
    assert.ok(!Buffer.from(b).includes(Buffer.from(env.R2_SECRET_ACCESS_KEY)) && !Buffer.from(b).includes(Buffer.from(env.R2_ACCESS_KEY_ID)), "storage/credentials echoed the credential");
  }

  const prefix = `_sdn-storage-e2e/${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}/`;
  const key = `${prefix}object-100mb.bin`;
  const P = (extra = {}) => ({ store: "r2", endpoint: ENDPOINT, bucket: BUCKET, region: "auto", ...extra });
  const run = async (tasks) => {
    const { outputs } = await H.runFlow({ wasm, node, inputs: tasks.map((t) => ({ trigger: 0, portId: "task", payload: H.apr(t) })) });
    const results = [], listings = [];
    for (const b of outputs) {
      assert.ok(!Buffer.from(b).includes(Buffer.from(env.R2_SECRET_ACCESS_KEY)), "an egress frame carries the secret");
      if (H.idAt(b, 4) === "$APR") results.push(H.readApr(b)); else if (H.idAt(b, 4) === "$FIL") listings.push(H.readFil(b));
    }
    return { results, listings };
  };
  const byId = (rs, id) => rs.find((r) => r.REQUEST_ID === id);
  const object = crypto.randomBytes(100_000_000);
  const partSize = 16 * MiB;
  const parts = Math.ceil(object.length / partSize);
  try {
    // 2. put (multipart: 6 parts of 16 MiB)
    const t0 = Date.now();
    let { results } = await run([{ route: "put", requestId: "put", params: P({ key, partSize, contentType: "application/octet-stream" }), body: object }]);
    assert.equal(results.length, 1);
    assert.deepEqual([results[0].STATUS, results[0].ERROR_CODE ?? "", results[0].ERROR_MESSAGE ?? ""], [200, "", ""], results[0].ERROR_MESSAGE);
    assert.deepEqual([H.paramsOf(results[0]).parts, H.paramsOf(results[0]).size], [String(parts), String(object.length)]);
    const partMd5 = Array.from({ length: parts }, (_, i) => crypto.createHash("md5").update(object.subarray(i * partSize, Math.min(object.length, (i + 1) * partSize))).digest());
    assert.equal(H.paramsOf(results[0]).etag.replaceAll('"', ""), `${crypto.createHash("md5").update(Buffer.concat(partMd5)).digest("hex")}-${parts}`, "the composite ETag R2 computed matches the parts sent");
    const putMs = Date.now() - t0;

    // 3. head, then ranged gets that reassemble the object, then list
    const ranges = 3;
    const step = Math.ceil(object.length / ranges);
    ({ results } = await run([
      { route: "head", requestId: "head", params: P({ key }) },
      ...Array.from({ length: ranges }, (_, i) => ({ route: "get", requestId: `get${i}`, params: P({ key, range: `bytes=${i * step}-${Math.min(object.length, (i + 1) * step) - 1}` }) })),
    ]));
    assert.deepEqual([byId(results, "head").STATUS, H.paramsOf(byId(results, "head"))["content-length"]], [200, String(object.length)]);
    for (let i = 0; i < ranges; i++) assert.equal(byId(results, `get${i}`).STATUS, 206);
    const back = Buffer.concat(Array.from({ length: ranges }, (_, i) => Buffer.from(byId(results, `get${i}`).BODY)));
    assert.equal(back.length, object.length);
    assert.equal(sha(back), sha(object), "the bytes round-trip");
    const listed = await run([{ route: "list", requestId: "list", params: P({ prefix }) }]);
    assert.deepEqual(listed.listings[0].ENTRIES.map((e) => [e.NAME, Number(e.SIZE)]), [[key, object.length]]);
    console.log(`R2 live: put ${object.length} B in ${parts} parts ${putMs} ms; head ${H.paramsOf(byId(results, "head")).etag}; ranged get sha256 ${sha(back).slice(0, 16)}...; list ${listed.listings[0].ENTRIES.length} entry under ${prefix}`);
  } finally {
    // 4. delete, then head is 404
    const { results } = await run([{ route: "delete", requestId: "del", params: P({ key }) }]);
    assert.ok([200, 204].includes(results[0].STATUS), `delete: ${results[0].STATUS}`);
    const gone = await run([{ route: "head", requestId: "gone", params: P({ key }) }]);
    assert.equal(gone.results[0].STATUS, 404);
  }
  assert.equal(node.calls.filter((c) => c.op.startsWith("secrets.") && c.op !== "secrets.get" && c.op !== "secrets.put").length, 0);
});
