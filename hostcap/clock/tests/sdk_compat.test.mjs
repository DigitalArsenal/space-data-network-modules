import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { createBrowserHost } from "space-data-module-sdk/host/browser";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const FIXED_NOW_MS = 1_782_950_400_000; // 2026-07-03T00:00:00Z
const FIXED_NOW_ISO = "2026-07-03T00:00:00.000Z";

const decoder = new TextDecoder();

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

// Host-bridge stub: serves the clock built-ins and records every outgoing
// hostcall so tests can assert the exact operations the node issues.
function createHostStub({ failOps = {} } = {}) {
  const calls = [];
  const dispatch = (operation, params) => {
    calls.push({ operation, params });
    if (failOps[operation]) {
      throw new Error(failOps[operation]);
    }
    switch (operation) {
      case "clock.now":
        return FIXED_NOW_MS;
      case "clock.nowIso":
        return FIXED_NOW_ISO;
      default:
        throw new Error(`unexpected hostcall operation: ${operation}`);
    }
  };
  return { calls, dispatch };
}

// Zero-input invokes must use the command surface (see data-source/retrieval:
// a PIV request without payload-arena bytes flips the direct surface into
// plugin-owned external-arena output descriptors).
async function createHarness(t, options) {
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
    surface: "command",
    ...options,
  });
  t.after(() => harness.destroy());
  return harness;
}

test("hostcap/clock artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("hostcap/clock artifact exports the canonical ABI and imports only WASI + the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  assert.equal(inspection.profile, "module-host-abi");
  const importedModuleNames = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  assert.deepEqual(importedModuleNames, ["space_data_module_host", "wasi_snapshot_preview1"]);
  for (const required of [
    "_start",
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

test("now samples clock.now + clock.nowIso and emits one time JSON frame", async (t) => {
  const stub = createHostStub();
  const harness = await createHarness(t, { hostcallDispatch: stub.dispatch });
  const response = await harness.invoke({ methodId: "now", inputs: [] });

  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "time");
  assert.equal(frame.wireFormat, "aligned-binary");
  assert.deepEqual(JSON.parse(decoder.decode(frame.payload)), {
    unixMs: FIXED_NOW_MS,
    iso: FIXED_NOW_ISO,
  });
  assert.deepEqual(
    stub.calls.map((entry) => entry.operation),
    ["clock.now", "clock.nowIso"],
    "the node must issue exactly the two clock hostcalls",
  );
});

test("now works against the real BrowserHost clock built-ins (capability-gated passthrough)", async (t) => {
  const host = createBrowserHost({ capabilities: ["clock"] });
  const harness = await createHarness(t, { host });
  const before = Date.now();
  const response = await harness.invoke({ methodId: "now", inputs: [] });
  const after = Date.now();

  assert.equal(response.statusCode, 0, response.errorMessage);
  const time = JSON.parse(decoder.decode(response.outputs[0].payload));
  assert.ok(time.unixMs >= before && time.unixMs <= after, "unixMs must come from the host clock");
  const parsedIso = Date.parse(time.iso);
  assert.ok(Number.isFinite(parsedIso), "iso must be a parseable RFC3339 timestamp");
  assert.ok(Math.abs(parsedIso - time.unixMs) < 5_000, "iso and unixMs must agree");
});

test("now fails closed when the host clock is unavailable", async (t) => {
  const stub = createHostStub({ failOps: { "clock.now": "clock capability not granted" } });
  const harness = await createHarness(t, { hostcallDispatch: stub.dispatch });
  const response = await harness.invoke({ methodId: "now", inputs: [] });

  assert.notEqual(response.statusCode, 0, "host error must fail the invoke");
  assert.equal(response.errorCode, "clock-unavailable");
  assert.match(String(response.errorMessage), /clock capability not granted/);
  assert.equal(response.outputs.length, 0);
});

test("now propagates a clock.nowIso failure after a successful clock.now", async (t) => {
  const stub = createHostStub({ failOps: { "clock.nowIso": "nowIso exploded" } });
  const harness = await createHarness(t, { hostcallDispatch: stub.dispatch });
  const response = await harness.invoke({ methodId: "now", inputs: [] });

  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "clock-unavailable");
  assert.match(String(response.errorMessage), /nowIso exploded/);
});
