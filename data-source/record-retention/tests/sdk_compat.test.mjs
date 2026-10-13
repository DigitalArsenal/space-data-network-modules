import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
// (the behaviour tests run the browser-declared test build of the same source: the SDK's in-process harness is the
// browser leg only, and the shipped artifact targets wasmedge - build.mjs)
const TEST_WASM_PATH = new URL("../dist/test-browser/module.wasm", import.meta.url);
const TEST_MANIFEST_PATH = new URL("../dist/test-browser/plugin-manifest.json", import.meta.url);
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const HOUR_MS = 3_600_000;
const FIXED_NOW_MS = 1_791_259_200_000; // 2026-10-06T00:00:00Z

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const readWasm = () => fs.readFileSync(fileURLToPath(WASM_PATH));

// Host stub: config, clock and storage.expire (answers per call from `answers`, recording every payload).
function createHostStub({ config = {}, answers = [], fail = null } = {}) {
  const calls = [];
  const queue = [...answers];
  const dispatch = (operation, params) => {
    calls.push({ operation, params });
    switch (operation) {
      case "plugin.getConfig": return config;
      case "clock.now": return FIXED_NOW_MS;
      case "storage.expire":
        if (fail) throw new Error(fail);
        return queue.shift() ?? { deleted: 0, missing: 0, capped: false };
      default: throw new Error(`unexpected hostcall operation: ${operation}`);
    }
  };
  return { calls, dispatch, expires: () => calls.filter((c) => c.operation === "storage.expire").map((c) => c.params) };
}

async function invoke(t, stub) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(TEST_WASM_PATH)), manifest: JSON.parse(fs.readFileSync(TEST_MANIFEST_PATH, "utf8")),
    surface: "command", hostcallDispatch: stub.dispatch,
  });
  t.after(() => harness.destroy());
  return harness.invoke({ methodId: "expire", inputs: [] });
}
const report = (response) => JSON.parse(new TextDecoder().decode(response.outputs.find((o) => o.portId === "report").payload));

test("data-source/record-retention artifact passes SDK compliance", async () => {
  const result = await validateArtifactWithStandards({ manifest: readManifest(), wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
});

test("artifact imports only WASI and the sync hostcall bridge, and targets the node (wasmedge)", async () => {
  const inspection = await inspectModule(readWasm());
  assert.deepEqual(Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
  for (const required of ["plugin_alloc", "plugin_free", "plugin_invoke_stream", "plugin_get_manifest_flatbuffer"]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
  assert.deepEqual(readManifest().runtimeTargets, ["wasmedge"]);
  assert.deepEqual(readManifest().capabilities, ["storage_write"]);
});

test("default: WXF from noaa-ncep, the window 72 h before the host clock, one storage.expire", async (t) => {
  const stub = createHostStub({ answers: [{ deleted: 4608, missing: 0, capped: false }] });
  const response = await invoke(t, stub);
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.deepEqual(stub.expires(), [{ schema: "WXF.fbs", provider_id: "noaa-ncep", before_ms: FIXED_NOW_MS - 72 * HOUR_MS, batch: 500, max_deletes: 100000 }]);
  assert.deepEqual(report(response), { window_hours: 72, cutoff_ms: FIXED_NOW_MS - 72 * HOUR_MS, deleted: 4608, not_held: 0, capped: false, unchanged: true });
});

test("config: window, batch, budget; one call a source, the budget carried across them; totals summed", async (t) => {
  const stub = createHostStub({
    config: { window_hours: 24, batch: 100, max_deletes: 1000, targets: [{ schema: "WXF.fbs", provider_id: "noaa-ncep", sources: ["gfs-0p25-sea", "goes19-world"] }, { schema: "OMM.fbs", sources: ["celestrak-gp"] }] },
    answers: [{ deleted: 300, missing: 2, capped: false }, { deleted: 200, missing: 0, capped: false }, { deleted: 7, missing: 1, capped: false }],
  });
  const response = await invoke(t, stub);
  assert.equal(response.statusCode, 0, response.errorMessage);
  const cutoff = FIXED_NOW_MS - 24 * HOUR_MS;
  assert.deepEqual(stub.expires(), [
    { schema: "WXF.fbs", provider_id: "noaa-ncep", source_name: "gfs-0p25-sea", before_ms: cutoff, batch: 100, max_deletes: 1000 },
    { schema: "WXF.fbs", provider_id: "noaa-ncep", source_name: "goes19-world", before_ms: cutoff, batch: 100, max_deletes: 700 },
    { schema: "OMM.fbs", source_name: "celestrak-gp", before_ms: cutoff, batch: 100, max_deletes: 500 },
  ]);
  assert.deepEqual(report(response), { window_hours: 24, cutoff_ms: cutoff, deleted: 507, not_held: 3, capped: false, unchanged: true });
});

test("a target naming no lane is refused before any deletion; a host failure fails the pass", async (t) => {
  const bare = createHostStub({ config: { targets: [{ schema: "WXF.fbs", provider_id: "" }] } });
  let response = await invoke(t, bare);
  assert.equal(response.statusCode, 400);
  assert.equal(bare.expires().length, 0);

  const failing = createHostStub({ fail: "expire failed: store is read-only" });
  response = await invoke(t, failing);
  assert.equal(response.statusCode, 502);
  assert.match(response.errorMessage ?? "", /read-only/);
});
