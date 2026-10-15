import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule, loadModule } from "space-data-module-sdk/host/isomorphic";

import { MANIFEST_PATH, STANDARDS_ROOT, WASM_PATH, decodeTBP, readManifest, readWasm, requestFrame, sds } from "./lib/tbp.mjs";

const FLOW_EXAMPLE_PATH = new URL("./fixtures/hosted-runtime/cislunar.single-plugin.flow.json", import.meta.url);
const lagrangeRequest = () => ({ methodId: "invoke", inputs: [requestFrame({ PROBLEM: sds.tbpProblem.LibrationPoints, SYSTEM: Object.assign(new sds.tbpSystemT(), { MASS_RATIO: 0.0121505856 }) })] });

test("the manifest names $TBP on both ports and the artifact passes SDK compliance with the standards", async () => {
  const manifest = readManifest();
  const [method] = manifest.methods;
  assert.equal(manifest.methods.length, 1);
  for (const port of [...method.inputPorts, ...method.outputPorts]) {
    const types = port.acceptedTypeSets.flatMap((set) => set.allowedTypes);
    assert.deepEqual(types, [{ schemaName: "TBP.fbs", fileIdentifier: "$TBP", rootTypeName: "TBP", wireFormat: "flatbuffer" }]);
  }
  const report = await validateArtifactWithStandards({ manifest, wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  assert.deepEqual(JSON.parse(fs.readFileSync(new URL("../dist/plugin-manifest.json", import.meta.url), "utf8")), JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")));
});

test("the artifact imports only WASI (no hostcalls) and exports the invoke ABI", async () => {
  const inspection = await inspectModule(readWasm());
  assert.deepEqual(Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort(), ["wasi_snapshot_preview1"]);
  for (const name of ["plugin_alloc", "plugin_free", "plugin_invoke_stream", "plugin_get_manifest_flatbuffer", "plugin_get_manifest_flatbuffer_size"]) {
    assert.ok(inspection.exports.includes(name), name);
  }
});

test("the artifact answers through the WasmEdge server path", async (t) => {
  const isUnavailable = (error) => {
    for (let current = error; current; current = current.cause) {
      if (/spawn wasmedge ENOENT|command not found|Failed to launch|wasmedge.*not found/i.test(String(current))) return true;
    }
    return false;
  };
  let harness;
  let response;
  try {
    harness = await loadModule({ wasmSource: fileURLToPath(WASM_PATH), runtimeKind: "wasmedge", enableThreads: false });
    response = await harness.invoke(lagrangeRequest());
  } catch (error) {
    if (isUnavailable(error)) {
      t.skip("WasmEdge is not installed; install it to verify the server path.");
      return;
    }
    throw error;
  } finally {
    await harness?.destroy();
  }
  assert.equal(response.statusCode, 0, response.errorMessage);
  const answer = decodeTBP(response.outputs[0].payload);
  assert.equal(answer.LIBRATION_POINTS.length, 5);
});

test("the hosted-runtime example is wired to invoke/request", () => {
  const flow = JSON.parse(fs.readFileSync(FLOW_EXAMPLE_PATH, "utf8"));
  assert.equal(flow.nodes[0].pluginId, "cislunar-propagator");
  assert.equal(flow.nodes[0].methodId, "invoke");
  assert.equal(flow.triggerBindings[0].targetPortId, "request");
});
