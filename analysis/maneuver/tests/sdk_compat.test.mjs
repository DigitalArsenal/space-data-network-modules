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
const DIST_MANIFEST_PATH = new URL("../dist/plugin-manifest.json", import.meta.url);
const REQUEST_FIXTURE_PATH = new URL(
  "../tests/fixtures/request.hohmann.json",
  import.meta.url,
);
const FLOW_EXAMPLE_PATH = new URL(
  "../tests/fixtures/hosted-runtime/maneuver.single-plugin.flow.json",
  import.meta.url,
);

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
  assert.equal(payload.error, undefined);
  assert.equal(typeof payload.totalDeltaV, "number");
  assert.ok(payload.totalDeltaV > 0);
}

test("build publishes ONE artifact, and the manifest beside it", () => {
  // There is no dist/browser lane any more. 0.1.0 shipped an emcc
  // `dist/browser/module.js` + `.wasm` PAIR beside the isomorphic wasm, which
  // is two artifacts that can differ from one set of sources — the shape the
  // isomorphic law exists to refuse. The single wasi artifact loads in the
  // browser, under WasmEdge and under Docker WasmEdge, so a second copy bought
  // nothing but the opportunity to diverge.
  assert.equal(fs.existsSync(fileURLToPath(ISOMORPHIC_WASM_PATH)), true);
  assert.equal(fs.existsSync(fileURLToPath(DIST_MANIFEST_PATH)), true);
  assert.equal(
    fs.existsSync(fileURLToPath(new URL("../dist/browser", import.meta.url))),
    false,
    "dist/browser is the retired emcc lane and must not come back",
  );
  const shipped = JSON.parse(fs.readFileSync(fileURLToPath(DIST_MANIFEST_PATH), "utf8"));
  const source = JSON.parse(fs.readFileSync(fileURLToPath(MANIFEST_PATH), "utf8"));
  assert.deepEqual(shipped, source, "dist manifest drifted from plugin-manifest.json");
});

test("the manifest declares the sequential thread model and justifies it", () => {
  // The compile OPTION is what `resolveThreadModel` actually reads; the
  // manifest field is what a reviewer reads. build.js passes the manifest's
  // value explicitly and fails on drift, and this asserts the manifest half so
  // the declaration cannot quietly become "whatever runtimeTargets infers".
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  assert.equal(manifest.threadModel, "wasi-sequential");
  assert.equal(manifest.pluginFamily, "maneuver");
  assert.ok(manifest.sequentialJustification?.kind);
  assert.ok(String(manifest.sequentialJustification?.detail ?? "").length > 200);
});

test("built artifact passes SDK compliance checks", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
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

  const response = await harness.invoke(createInvokeRequest());
  assertSuccessfulResponse(response);
});

test("built artifact loads through the WasmEdge server path", async (t) => {
  let harness;
  try {
    harness = await loadModule({
      wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
      runtimeKind: "wasmedge",
      // See tests/vectors.test.mjs: the wasi-sequential lane's declared shared
      // memory needs the threads proposal to LOAD, which is a wasm-ld property
      // of the wasm32-wasip1-threads triple, not a threading claim by this
      // module (its manifest declares wasi-sequential and it spawns nothing).
      enableThreads: true,
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
  assert.equal(flow.nodes[0].pluginId, "maneuver-planner");
  assert.equal(flow.nodes[0].methodId, "invoke");
  assert.equal(flow.triggerBindings[0].targetPortId, "request");
});
