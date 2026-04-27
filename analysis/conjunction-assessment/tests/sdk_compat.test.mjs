import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import { prepareConjunctionScreenCatalogRequest } from "../../../../orbpro-integration/conjunction-assessment/index.js";
import { validatePluginArtifact } from "space-data-module-sdk/compliance";
import { inspectModule, loadModule } from "space-data-module-sdk/host/isomorphic";
import {
  createBrowserModuleHarness,
} from "space-data-module-sdk/testing";
import { getConjunctionAssessmentManifest } from "../index.js";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const BROWSER_MODULE_PATH = new URL("../dist/browser/module.js", import.meta.url);
const BROWSER_WASM_PATH = new URL("../dist/browser/module.wasm", import.meta.url);
const OMM_CATALOG_PATH = new URL(
  "../../../../sandcastle/gallery/sgp4-propagation/omm-cache.fb",
  import.meta.url,
);
const FLOW_EXAMPLE_PATH = new URL(
  "../tests/fixtures/sdn-flow/conjunction.single-plugin.flow.json",
  import.meta.url,
);

function readFirstCatalogFrame() {
  const catalogBytes = fs.readFileSync(OMM_CATALOG_PATH);
  assert.ok(catalogBytes.byteLength > 4, "OMM catalog fixture should not be empty");
  const payloadSize =
    catalogBytes[0] |
    (catalogBytes[1] << 8) |
    (catalogBytes[2] << 16) |
    ((catalogBytes[3] << 24) >>> 0);
  assert.ok(payloadSize > 0, "OMM catalog fixture should contain a frame");
  assert.ok(
    catalogBytes.byteLength >= payloadSize + 4,
    "OMM catalog fixture first frame should be complete",
  );
  return new Uint8Array(catalogBytes.subarray(0, payloadSize + 4));
}

function createInvokeRequest() {
  const prepared = prepareConjunctionScreenCatalogRequest({
    catalogBytes: readFirstCatalogFrame(),
    catalogObjectCount: 1,
    orderedCatalogIndices: Uint32Array.from([0]),
    startOrderIndex: 0,
    endOrderIndex: 1,
    start_jd: 2460691.0,
    duration_days: 1 / 24,
    threshold_km: 50,
    coarse_step_sec: 30,
    combined_radius_m: 10,
    num_threads: 1,
  });
  return {
    methodId: "screen_catalog",
    inputs: prepared.inputs.map((input) => ({
      portId: input.portId,
      typeRef: input.typeRef,
      payload: input.bytes,
      alignment: input.alignment,
      sequence: input.sequence,
    })),
  };
}

function assertSuccessfulResponse(response) {
  assert.equal(response.statusCode, 0);
  assert.ok(response.errorCode === "" || response.errorCode === null);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "result");

  const payload = response.outputs[0].payload ?? response.outputs[0].bytes;
  assert.ok(payload instanceof Uint8Array, "response should contain result bytes");
  assert.ok(payload.byteLength > 0, "response result should not be empty");
}

function getWasmEdgeSkipReason() {
  const wasmPath = fileURLToPath(ISOMORPHIC_WASM_PATH);
  const objectDump = spawnSync("wasm-objdump", ["-x", wasmPath], {
    encoding: "utf8",
  });
  const versionProbe = spawnSync("wasmedge", ["--version"], {
    encoding: "utf8",
  });
  const hasExceptionTag = /(?:^|\n)Tag\[\d+\]:/.test(
    objectDump.stdout ?? "",
  );
  const versionMatch = /wasmedge version\s+(\d+)\.(\d+)\./i.exec(
    `${versionProbe.stdout ?? ""}\n${versionProbe.stderr ?? ""}`,
  );
  const major = Number(versionMatch?.[1] ?? Number.NaN);
  const minor = Number(versionMatch?.[2] ?? Number.NaN);
  if (
    Number.isFinite(major) &&
    Number.isFinite(minor) &&
    major === 0 &&
    minor <= 14
  ) {
    return "Installed WasmEdge cannot instantiate this artifact's exception support.";
  }

  if (
    hasExceptionTag &&
    Number.isFinite(major) &&
    Number.isFinite(minor) &&
    major === 0 &&
    minor <= 14
  ) {
    return "Installed WasmEdge cannot instantiate this artifact's exception support.";
  }

  const probe = spawnSync("wasmedge", [wasmPath], {
    input: Buffer.alloc(0),
    encoding: "utf8",
  });
  const output = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
  if (
    /malformed section id|unknown import/i.test(output) ||
    probe.signal === "SIGTRAP"
  ) {
    return "Installed WasmEdge cannot instantiate this artifact's exception support.";
  }
  return false;
}

test("build publishes canonical browser and isomorphic artifact paths", () => {
  assert.equal(fs.existsSync(fileURLToPath(ISOMORPHIC_WASM_PATH)), true);
  assert.equal(fs.existsSync(fileURLToPath(BROWSER_MODULE_PATH)), true);
  assert.equal(fs.existsSync(fileURLToPath(BROWSER_WASM_PATH)), true);
});

test("built artifact passes SDK compliance checks", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  assert.deepEqual(manifest.dependencies, [
    {
      pluginId: "com.orbpro.sgp4",
      minVersion: "1.0.0",
    },
  ]);
  const report = await validatePluginArtifact({
    manifest,
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("built artifact exposes the standalone isomorphic surface", async () => {
  const inspection = await inspectModule(
    fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
  );
  const importedModuleNames = Array.from(
    new Set(inspection.imports.map((entry) => entry.module)),
  ).sort();

  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(importedModuleNames, ["wasi_snapshot_preview1"]);
  assert.ok(inspection.exports.includes("_start"));
  assert.ok(inspection.exports.includes("plugin_alloc"));
  assert.ok(inspection.exports.includes("plugin_free"));
  assert.ok(inspection.exports.includes("plugin_invoke_stream"));
  assert.ok(inspection.exports.includes("plugin_get_manifest_flatbuffer"));
  assert.ok(inspection.exports.includes("plugin_get_manifest_flatbuffer_size"));
});

test("built artifact loads through the SDK browser harness", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "command",
  });
  t.after(() => {
    harness.destroy();
  });

  const embeddedManifest = await getConjunctionAssessmentManifest(harness);
  assert.equal(embeddedManifest.dependencies.length, 1);
  assert.equal(embeddedManifest.dependencies[0].pluginId, "com.orbpro.sgp4");
  assert.equal(embeddedManifest.dependencies[0].minVersion, "1.0.0");

  const response = await harness.invoke(createInvokeRequest());
  assertSuccessfulResponse(response);
});

test("built artifact loads through the WasmEdge server path", {
  skip:
    getWasmEdgeSkipReason() ||
    "WasmEdge server-path coverage requires a runtime with wasm exception support.",
}, async (t) => {
  let harness;
  try {
    harness = await loadModule({
      wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
      runtimeKind: "wasmedge",
      enableThreads: false,
    });
  } catch (error) {
    if (/spawn wasmedge ENOENT|command not found|Failed to launch/i.test(String(error))) {
      t.skip("Install wasmedge to verify the server-path harness.");
      return;
    }
    throw error;
  }
  t.after(async () => {
    await harness.destroy();
  });

  const response = await harness.invoke(createInvokeRequest());
  assertSuccessfulResponse(response);
});

test("sdn-flow example is wired to the screen catalog command surface", () => {
  const flow = JSON.parse(fs.readFileSync(FLOW_EXAMPLE_PATH, "utf8"));
  assert.equal(flow.nodes.length, 1);
  assert.equal(flow.nodes[0].pluginId, "conjunction-assessment");
  assert.equal(flow.nodes[0].methodId, "screen_catalog");
  assert.deepEqual(flow.requiredPlugins, [
    "conjunction-assessment",
    "com.orbpro.sgp4",
  ]);
  assert.equal(flow.triggerBindings[0].targetPortId, "request");
});
