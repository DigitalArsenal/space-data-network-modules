import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule, loadModule } from "space-data-module-sdk/host/isomorphic";
import {
  createBrowserModuleHarness,
  generateManifestHarnessPlan,
  materializeHarnessScenario,
} from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const { XTC } = await import(pathToFileURL(path.join(STANDARDS_ROOT, "lib", "js", "XTC", "main.js")).href);
const flatbuffers = await import(pathToFileURL(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js")).href);
const XTC_TYPE = { schemaName: "XTC.fbs", fileIdentifier: "$XTC", rootTypeName: "XTC", wireFormat: "flatbuffer" };

// A real SDS $XTC SpaceSystem record.
function buildXtcFixture() {
  const builder = new flatbuffers.Builder(256);
  const name = builder.createString("BasiliskRuntime");
  const shortDescription = builder.createString("Basilisk runtime telemetry and command dictionary");
  XTC.startXTC(builder);
  XTC.addName(builder, name);
  XTC.addShortDescription(builder, shortDescription);
  XTC.finishXTCBuffer(builder, XTC.endXTC(builder));
  return builder.asUint8Array().slice();
}
const XTC_FIXTURE = buildXtcFixture();

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function createHarnessScenario(surface) {
  const plan = generateManifestHarnessPlan({
    manifest: readManifest(),
    payloadForPort({ portId }) {
      return portId === "dictionary" ? XTC_FIXTURE : null;
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

function assertEchoResponse(response) {
  assert.equal(response.statusCode, 0);
  assert.ok(response.errorCode === "" || response.errorCode === null);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "dictionary");
  assert.equal(response.outputs[0].typeRef?.fileIdentifier ?? "$XTC", "$XTC");
  assert.deepEqual(Uint8Array.from(response.outputs[0].payload), XTC_FIXTURE);
  const xtc = XTC.getRootAsXTC(new flatbuffers.ByteBuffer(Uint8Array.from(response.outputs[0].payload)));
  assert.equal(xtc.NAME(), "BasiliskRuntime");
}

test("build publishes canonical isomorphic artifact path", () => {
  assert.equal(fs.existsSync(fileURLToPath(ISOMORPHIC_WASM_PATH)), true);
});

test("built artifact passes SDK compliance checks", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("built artifact exposes standalone command surface", async () => {
  const inspection = await inspectModule(
    fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
  );
  const importedModuleNames = Array.from(
    new Set(inspection.imports.map((entry) => entry.module)),
  ).sort();

  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(importedModuleNames, ["wasi_snapshot_preview1"]);
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

test("built artifact loads through SDK browser harness", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "command",
  });
  t.after(() => {
    harness.destroy();
  });

  const response = await harness.invoke(createInvokeRequest());
  assertEchoResponse(response);
});

test("built artifact loads through WasmEdge server path", async (t) => {
  // WasmEdge is launched lazily, on the first invoke: a missing binary surfaces there, not in loadModule.
  const isUnavailable = (error) => {
    for (let current = error; current; current = current.cause) {
      if (/spawn wasmedge ENOENT|command not found|Failed to launch/i.test(String(current))) return true;
    }
    return false;
  };
  let harness;
  let response;
  try {
    harness = await loadModule({
      wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
      runtimeKind: "wasmedge",
      enableThreads: true,
    });
    response = await harness.invoke(createInvokeRequest());
  } catch (error) {
    if (isUnavailable(error)) {
      t.skip("Install wasmedge to verify the server-path harness.");
      return;
    }
    throw error;
  } finally {
    await harness?.destroy();
  }
  assertEchoResponse(response);
});

test("echo_xtc_dictionary ports name one concrete $XTC FlatBuffer type", () => {
  const method = readManifest().methods.find((entry) => entry.methodId === "echo_xtc_dictionary");
  for (const port of [...method.inputPorts, ...method.outputPorts]) {
    assert.equal(port.acceptedTypeSets.length, 1);
    assert.deepEqual(port.acceptedTypeSets[0].allowedTypes, [XTC_TYPE]);
  }
});

test("echo_xtc_dictionary refuses a payload that is not an $XTC", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "command",
  });
  t.after(() => harness.destroy());
  const response = await harness.invoke({
    methodId: "echo_xtc_dictionary",
    inputs: [{ portId: "dictionary", typeRef: XTC_TYPE, payload: new TextEncoder().encode("not-an-xtc-dictionary") }],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "invalid-dictionary");
  assert.equal(response.outputs.length, 0);
});
