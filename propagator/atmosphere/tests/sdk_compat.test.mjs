import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validatePluginArtifact } from "space-data-module-sdk/compliance";
import { inspectModule, loadModule } from "space-data-module-sdk/host/isomorphic";
import {
  createBrowserModuleHarness,
  generateManifestHarnessPlan,
  materializeHarnessScenario,
} from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const BROWSER_MODULE_PATH = new URL("../dist/browser/module.js", import.meta.url);
const BROWSER_WASM_PATH = new URL("../dist/browser/module.wasm", import.meta.url);
const REQUEST_FIXTURE_PATH = new URL(
  "../tests/fixtures/request.altitude.json",
  import.meta.url,
);
const FLOW_EXAMPLE_PATH = new URL(
  "../tests/fixtures/hosted-runtime/atmosphere.single-plugin.flow.json",
  import.meta.url,
);
const HFC_ALLOWED_TYPES = [
  { schemaName: "HFC.fbs", fileIdentifier: "$HFC", rootTypeName: "HFC" },
  {
    schemaName: "HFC.fbs",
    fileIdentifier: "$HFC",
    rootTypeName: "HFC",
    wireFormat: "aligned-binary",
    requiredAlignment: 8,
  },
];
const SPW_ALLOWED_TYPES = [
  { schemaName: "SPW.fbs", fileIdentifier: "$SPW", rootTypeName: "SPW" },
  {
    schemaName: "SPW.fbs",
    fileIdentifier: "$SPW",
    rootTypeName: "SPW",
    wireFormat: "aligned-binary",
    requiredAlignment: 8,
  },
];

function readFixtureBytes() {
  return fs.readFileSync(REQUEST_FIXTURE_PATH);
}

function createHarnessScenario(surface) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const plan = generateManifestHarnessPlan({
    manifest,
    payloadForPort({ portId }) {
      if (portId !== "request") {
        return null;
      }
      return readFixtureBytes();
    },
  });
  const scenario = plan.generatedCases.find((entry) => entry.surface === surface);
  assert.ok(scenario, `missing ${surface} harness scenario`);
  return materializeHarnessScenario(scenario);
}

function createInvokeRequest() {
  const scenario = createHarnessScenario("command");
  return {
    methodId: scenario.methodId,
    inputs: scenario.inputs,
  };
}

function assertSuccessfulResponse(response) {
  assert.equal(response.statusCode, 0);
  assert.ok(response.errorCode === "" || response.errorCode === null);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "response");

  const payload = JSON.parse(new TextDecoder().decode(response.outputs[0].payload));
  assert.equal(payload.model, "US76");
  assert.equal(payload.altitudeM, 10000);
  assert.ok(payload.state.density > 0);
  assert.ok(payload.state.temperature > 200);
}

test("build publishes canonical browser and isomorphic artifact paths", () => {
  assert.equal(fs.existsSync(fileURLToPath(ISOMORPHIC_WASM_PATH)), true);
  assert.equal(fs.existsSync(fileURLToPath(BROWSER_MODULE_PATH)), true);
  assert.equal(fs.existsSync(fileURLToPath(BROWSER_WASM_PATH)), true);
});

test("built artifact passes SDK compliance checks", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const report = await validatePluginArtifact({
    manifest,
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("manifest declares the fixed atmosphere provider method", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const method = manifest.methods.find(
    (entry) => entry.methodId === "query_atmosphere_state_batch",
  );
  assert.ok(method);
  assert.equal(method.inputPorts[0].portId, "atmosphere");
  assert.equal(method.inputPorts[1].portId, "space_weather");
  assert.equal(method.inputPorts[1].required, false);
  assert.equal(method.outputPorts[0].portId, "states");
  assert.deepEqual(method.inputPorts[0].acceptedTypeSets[0].allowedTypes, HFC_ALLOWED_TYPES);
  assert.deepEqual(method.inputPorts[1].acceptedTypeSets[0].allowedTypes, SPW_ALLOWED_TYPES);
  assert.deepEqual(method.outputPorts[0].acceptedTypeSets[0].allowedTypes, HFC_ALLOWED_TYPES);
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

  const response = await harness.invoke(createInvokeRequest());
  assertSuccessfulResponse(response);
});

test("built artifact loads through the WasmEdge server path", async (t) => {
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

test("hosted-runtime example is wired to the canonical invoke contract", () => {
  const flow = JSON.parse(fs.readFileSync(FLOW_EXAMPLE_PATH, "utf8"));
  assert.equal(flow.nodes.length, 1);
  assert.equal(flow.nodes[0].pluginId, "atmosphere-model");
  assert.equal(flow.nodes[0].methodId, "invoke");
  assert.equal(flow.triggerBindings[0].targetPortId, "request");
});
