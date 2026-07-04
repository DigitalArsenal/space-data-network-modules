// data-source/celestrak-request SDK-compat tests (loop C.8a): request-builder
// nodes turn a timer tick into hostcap/http-request request JSONs + parser
// job JSONs, with runner-default URLs and node-CONFIG overrides via the
// builtin plugin.getConfig hostcall.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

function tickInput() {
  return {
    portId: "tick",
    typeRef: { wireFormat: "aligned-binary" },
    payload: encoder.encode(JSON.stringify({ firedAt: "2026-07-04T00:00:00Z" })),
  };
}

function createConfigStub(config = {}) {
  const calls = [];
  const dispatch = (operation) => {
    calls.push(operation);
    if (operation === "plugin.getConfig") {
      return config;
    }
    throw new Error(`unexpected hostcall operation: ${operation}`);
  };
  return { calls, dispatch };
}

async function createHarness(t, stub) {
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
    surface: "direct",
    hostcallDispatch: stub.dispatch,
  });
  t.after(() => harness.destroy());
  return harness;
}

function outputsByPort(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  const map = new Map();
  for (const frame of response.outputs) {
    map.set(frame.portId, JSON.parse(decoder.decode(frame.payload)));
  }
  return map;
}

test("celestrak-request artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("gp emits the runner-default request + job with attribution", async (t) => {
  const stub = createConfigStub();
  const harness = await createHarness(t, stub);
  const outputs = outputsByPort(
    await harness.invoke({ methodId: "gp", inputs: [tickInput()] }),
  );
  const request = outputs.get("request");
  assert.equal(request.method, "GET");
  assert.equal(
    request.url,
    "https://celestrak.org/NORAD/elements/gp.php?SPECIAL=full-catalog&FORMAT=csv",
  );
  assert.equal(request.timeoutMs, 90000, "runner HTTPTimeout default");
  const job = outputs.get("job");
  assert.equal(job.source_name, "celestrak-gp");
  assert.equal(job.provider_id, "space-data-network-02");
  assert.equal(job.source_url, request.url);
  assert.equal(job.archive_source, "celestrak");
  assert.equal(job.archive_name, "catalog.csv");
  assert.deepEqual(stub.calls, ["plugin.getConfig"]);
});

test("gp honors node-CONFIG URL/timeout/provider overrides", async (t) => {
  const stub = createConfigStub({
    celestrak_gp_url: "https://fixtures.test/gp.csv",
    celestrak_http_timeout_ms: 5000,
    celestrak_provider_id: "prov-test",
  });
  const harness = await createHarness(t, stub);
  const outputs = outputsByPort(
    await harness.invoke({ methodId: "gp", inputs: [tickInput()] }),
  );
  assert.equal(outputs.get("request").url, "https://fixtures.test/gp.csv");
  assert.equal(outputs.get("request").timeoutMs, 5000);
  assert.equal(outputs.get("job").provider_id, "prov-test");
});

test("satcat emits BOTH legacy txt and csv fetches (runner dual-source parity)", async (t) => {
  const stub = createConfigStub();
  const harness = await createHarness(t, stub);
  const outputs = outputsByPort(
    await harness.invoke({ methodId: "satcat", inputs: [tickInput()] }),
  );
  assert.equal(outputs.get("request_txt").url, "https://celestrak.org/pub/satcat.txt");
  assert.equal(outputs.get("request_csv").url, "https://celestrak.org/pub/satcat.csv");
  assert.equal(outputs.get("job_txt").source_name, "celestrak-satcat");
  assert.equal(outputs.get("job_csv").source_name, "celestrak-satcat-csv");
  assert.equal(outputs.get("job_txt").archive_name, "satcat.txt");
  assert.equal(outputs.get("job_csv").archive_name, "satcat.csv");
});

test("spw emits the space-weather fetch + job", async (t) => {
  const stub = createConfigStub();
  const harness = await createHarness(t, stub);
  const outputs = outputsByPort(
    await harness.invoke({ methodId: "spw", inputs: [tickInput()] }),
  );
  assert.equal(outputs.get("request").url, "https://celestrak.org/SpaceData/SW-All.csv");
  assert.equal(outputs.get("job").source_name, "celestrak-space-weather");
  assert.equal(outputs.get("job").archive_name, "SW-All.csv");
});

test("celestrak-request imports only WASI + the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  const importedModuleNames = Array.from(
    new Set(inspection.imports.map((entry) => entry.module)),
  ).sort();
  assert.deepEqual(importedModuleNames, ["space_data_module_host", "wasi_snapshot_preview1"]);
});
