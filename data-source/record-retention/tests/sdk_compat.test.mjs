import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const HOUR_MS = 3_600_000;
const FIXED_NOW_MS = 1_791_259_200_000; // 2026-10-06T00:00:00Z

// Known answers for the content ID (raw CIDv1, sha2-256 multihash, base32 "b"):
// - "hello world": the IPFS documentation's raw-leaf CID of those 11 bytes
//   (sha2-256 b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9);
// - a real $WXF record (GFS 2026-10-06T06Z f006 2 m temperature, level-4 tile
//   26_6, 1628 bytes) and the CID an SDN node (spacedatanetwork 1.1.0) returned
//   when it stored it - the identity the node's storage.delete looks it up by.
const HELLO = new TextEncoder().encode("hello world");
const HELLO_CID = "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e";
const WXF_RECORD = new Uint8Array(fs.readFileSync(new URL("./data/wxf-gfs-20261006T06-f006-tile26_6-record0.bin", import.meta.url)));
const WXF_CID = "bafkreibo5h2q7bya3a6am2lcumvmeqazzl5rsc5ohdlccqv7jvluk4agbq";

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const readWasm = () => fs.readFileSync(fileURLToPath(WASM_PATH));
// (the behaviour tests run the browser-declared test build of the same source: the SDK's in-process harness is the
// browser leg only, and the shipped artifact targets wasmedge - build.mjs)
const TEST_WASM_PATH = new URL("../dist/test-browser/module.wasm", import.meta.url);
const TEST_MANIFEST_PATH = new URL("../dist/test-browser/plugin-manifest.json", import.meta.url);

// [u32le size][record] frames, as storage.flatsql_query_stream returns them
function frames(records) {
  const out = new Uint8Array(records.reduce((n, r) => n + 4 + r.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const r of records) { view.setUint32(at, r.length, true); out.set(r, at + 4); at += 4 + r.length; }
  return out;
}

// Host stub: config, clock, the query stream (each call answers the next
// prepared stream, then empty) and storage.delete (true for held CIDs).
function createHostStub({ config = {}, streams = [], held = new Set(), refuse = new Set() } = {}) {
  const calls = [];
  const queue = [...streams];
  const dispatch = (operation, params) => {
    calls.push({ operation, params });
    switch (operation) {
      case "plugin.getConfig": return config;
      case "clock.now": return FIXED_NOW_MS;
      case "storage.flatsql_query_stream": {
        const s = queue.shift() ?? new Uint8Array(0);
        return { rows: 0, columns: 1, stream: s };
      }
      case "storage.delete":
        if (refuse.has(params.cid)) throw new Error("delete failed: store is read-only");
        if (!held.has(params.cid)) throw new Error("delete failed: record not found");
        held.delete(params.cid);
        return true;
      default: throw new Error(`unexpected hostcall operation: ${operation}`);
    }
  };
  return { calls, dispatch };
}

async function createHarness(t, stub) {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(fileURLToPath(TEST_WASM_PATH)), manifest: JSON.parse(fs.readFileSync(TEST_MANIFEST_PATH, "utf8")), surface: "command", hostcallDispatch: stub.dispatch });
  t.after(() => harness.destroy());
  return harness;
}
const report = (response) => JSON.parse(new TextDecoder().decode(response.outputs.find((o) => o.portId === "report").payload));

test("data-source/record-retention artifact passes SDK compliance", async () => {
  const result = await validateArtifactWithStandards({ manifest: readManifest(), wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
});

test("artifact imports only WASI and the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  const modules = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  assert.deepEqual(modules, ["space_data_module_host", "wasi_snapshot_preview1"]);
  for (const required of ["plugin_alloc", "plugin_free", "plugin_invoke_stream", "plugin_get_manifest_flatbuffer"]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

test("content IDs equal the published raw CIDv1 and the node's own CID; expired records are deleted by them", async (t) => {
  const held = new Set([HELLO_CID, WXF_CID]);
  const stub = createHostStub({ config: { targets: [{ schema: "WXF.fbs", table: "WXF", time_column: "VALID_TIME_MS", sources: ["gfs-0p25-sea"] }] }, streams: [frames([HELLO, WXF_RECORD])], held });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({ methodId: "expire", inputs: [] });
  assert.equal(response.statusCode, 0, response.errorMessage);

  const deletes = stub.calls.filter((c) => c.operation === "storage.delete");
  assert.deepEqual(deletes.map((c) => c.params.cid), [HELLO_CID, WXF_CID]);
  assert.ok(deletes.every((c) => c.params.schema === "WXF.fbs"));
  assert.equal(held.size, 0);

  // the default window: 72 h before the host clock, on the record's own time column, for the named source
  const query = stub.calls.find((c) => c.operation === "storage.flatsql_query_stream").params;
  assert.equal(query.sql, "SELECT _data FROM WXF WHERE _source = ?1 AND VALID_TIME_MS < ?2 LIMIT ?3");
  assert.deepEqual(query.params, [{ t: "str", v: "WXF@gfs-0p25-sea" }, { t: "i64", v: FIXED_NOW_MS - 72 * HOUR_MS }, { t: "i64", v: 2000 }]);
  assert.deepEqual(report(response), { window_hours: 72, cutoff_ms: FIXED_NOW_MS - 72 * HOUR_MS, deleted: 2, not_held: 0, refused: 0, capped: false });
});

test("config sets the window, the batch and the time unit; every source when none is named; full batches are read again", async (t) => {
  const { createHash } = await import("node:crypto");
  const cid = (b) => "b" + base32(Uint8Array.from([1, 0x55, 0x12, 0x20, ...createHash("sha256").update(b).digest()]));
  const records = Array.from({ length: 3 }, (_, i) => new TextEncoder().encode(`record ${i}`));
  const held = new Set(records.map(cid));
  const stub = createHostStub({
    config: { window_hours: 24, batch: 2, targets: [{ schema: "OMM.fbs", table: "OMM", time_column: "EPOCH", time_unit: "s" }] },
    streams: [frames(records.slice(0, 2)), frames(records.slice(2))],
    held,
  });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({ methodId: "expire", inputs: [] });
  assert.equal(response.statusCode, 0, response.errorMessage);

  const queries = stub.calls.filter((c) => c.operation === "storage.flatsql_query_stream").map((c) => c.params);
  assert.equal(queries.length, 2, "a full batch is followed by another read; a short one ends the pass");
  assert.equal(queries[0].sql, "SELECT _data FROM OMM WHERE EPOCH < ?1 LIMIT ?2");
  assert.deepEqual(queries[0].params, [{ t: "i64", v: Math.round((FIXED_NOW_MS - 24 * HOUR_MS) / 1000) }, { t: "i64", v: 2 }]);
  assert.equal(report(response).deleted, 3);
  assert.equal(held.size, 0);
});

test("a record the store does not hold is counted, a refused delete fails the pass", async (t) => {
  const gone = createHostStub({ streams: [frames([HELLO])], held: new Set() });
  let harness = await createHarness(t, gone);
  let response = await harness.invoke({ methodId: "expire", inputs: [] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.deepEqual([report(response).deleted, report(response).not_held], [0, 1]);

  const refused = createHostStub({ streams: [frames([HELLO])], held: new Set([HELLO_CID]), refuse: new Set([HELLO_CID]) });
  harness = await createHarness(t, refused);
  response = await harness.invoke({ methodId: "expire", inputs: [] });
  assert.equal(response.statusCode, 502);
  assert.match(response.errorMessage ?? "", /deletes refused/);
});

function base32(bytes) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "", buffer = 0, bits = 0;
  for (const b of bytes) { buffer = (buffer << 8) | b; bits += 8; while (bits >= 5) { out += alphabet[(buffer >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += alphabet[(buffer << (5 - bits)) & 31];
  return out;
}
