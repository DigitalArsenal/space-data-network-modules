import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import { validatePluginArtifact } from "space-data-module-sdk/compliance";
import { inspectModule, loadModule } from "space-data-module-sdk/host/isomorphic";
import {
  createBrowserModuleHarness,
} from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const FLOW_EXAMPLE_PATH = new URL(
  "../tests/fixtures/hosted-runtime/conjunction.single-plugin.flow.json",
  import.meta.url,
);
import { initCqrFlatc, encodeCqr, decodeCqr } from "./lib/cqr.mjs";
import { buildNativeWasiThreadsRunner } from "./lib/wasmedgeWasiThreadsRunner.mjs";
const flatc = await initCqrFlatc();

function createVersionInvokeRequest() {
  return {
    methodId: "version",
    inputs: [
      {
        portId: "request",
        payload: encodeCqr(flatc, { VERSION_QUERY: true }),
        typeRef: { schemaName: "CQR.fbs", fileIdentifier: "$CQR", rootTypeName: "CQR", wireFormat: "flatbuffer" },
      },
    ],
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
  assert.equal(decodeCqr(flatc, payload).VERSION_RESULT.VERSION, "0.2.0");
}

test("build publishes canonical browser and isomorphic artifact paths", () => {
  assert.equal(fs.existsSync(fileURLToPath(ISOMORPHIC_WASM_PATH)), true);
});

test("built artifact passes SDK compliance checks", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  assert.deepEqual(manifest.dependencies, []);
  const report = await validatePluginArtifact({
    manifest,
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("manifest declares CDM import probability command surface", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const method = manifest.methods.find(
    (entry) => entry.methodId === "compute_pc_from_cdm",
  );
  assert.ok(method, "compute_pc_from_cdm method is declared");
  assert.equal(method.inputPorts.length, 1);
  assert.equal(method.inputPorts[0].portId, "cdm");
  assert.equal(
    method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier,
    "$CDM",
  );
  assert.equal(method.outputPorts.length, 1);
  assert.equal(method.outputPorts[0].portId, "result");
  assert.equal(
    method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier,
    "$CQR",
  );
});

test("manifest declares CSM summary command surface", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const method = manifest.methods.find((entry) => entry.methodId === "emit_csm");
  assert.ok(method, "emit_csm method is declared");
  assert.equal(method.inputPorts.length, 1);
  assert.equal(method.inputPorts[0].portId, "request");
  assert.equal(
    method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier,
    "$CQR",
  );
  assert.equal(method.outputPorts.length, 1);
  assert.equal(method.outputPorts[0].portId, "csm");
  assert.equal(
    method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier,
    "$CSM",
  );
});

test("manifest declares Orekit CDM KVN parser/writer command surfaces", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const parseMethod = manifest.methods.find(
    (entry) => entry.methodId === "parse_cdm_kvn",
  );
  assert.ok(parseMethod, "parse_cdm_kvn method is declared");
  assert.equal(parseMethod.inputPorts.length, 1);
  assert.equal(parseMethod.inputPorts[0].portId, "kvn");
  assert.equal(parseMethod.outputPorts.length, 1);
  assert.equal(parseMethod.outputPorts[0].portId, "cdm");
  assert.equal(
    parseMethod.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier,
    "$CDM",
  );

  const writeMethod = manifest.methods.find(
    (entry) => entry.methodId === "write_cdm_kvn",
  );
  assert.ok(writeMethod, "write_cdm_kvn method is declared");
  assert.equal(writeMethod.inputPorts.length, 1);
  assert.equal(writeMethod.inputPorts[0].portId, "cdm");
  assert.equal(
    writeMethod.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier,
    "$CDM",
  );
  assert.equal(writeMethod.outputPorts.length, 1);
  assert.equal(writeMethod.outputPorts[0].portId, "kvn");
});

test("manifest declares Orekit CDM XML parser/writer command surfaces", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const parseMethod = manifest.methods.find(
    (entry) => entry.methodId === "parse_cdm_xml",
  );
  assert.ok(parseMethod, "parse_cdm_xml method is declared");
  assert.equal(parseMethod.inputPorts.length, 1);
  assert.equal(parseMethod.inputPorts[0].portId, "xml");
  assert.equal(parseMethod.outputPorts.length, 1);
  assert.equal(parseMethod.outputPorts[0].portId, "cdm");
  assert.equal(
    parseMethod.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier,
    "$CDM",
  );

  const writeMethod = manifest.methods.find(
    (entry) => entry.methodId === "write_cdm_xml",
  );
  assert.ok(writeMethod, "write_cdm_xml method is declared");
  assert.equal(writeMethod.inputPorts.length, 1);
  assert.equal(writeMethod.inputPorts[0].portId, "cdm");
  assert.equal(
    writeMethod.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier,
    "$CDM",
  );
  assert.equal(writeMethod.outputPorts.length, 1);
  assert.equal(writeMethod.outputPorts[0].portId, "xml");
});

test("primary artifact exposes canonical wasi-threads imports and exports", async () => {
  const inspection = await inspectModule(fs.readFileSync(ISOMORPHIC_WASM_PATH));
  assert.ok(inspection.imports.some(i => i.module === "wasi" && i.name === "thread-spawn"));
  assert.ok(inspection.exports.includes("wasi_thread_start"));
  assert.ok(!inspection.imports.some(i => /__pthread_create_js|emscripten|mailbox/.test(i.name)));
  for (const name of ["_start", "plugin_alloc", "plugin_free", "plugin_invoke_stream", "plugin_get_manifest_flatbuffer", "plugin_get_manifest_flatbuffer_size"]) assert.ok(inspection.exports.includes(name), name);
});

test("built artifact loads through the SDK WasmEdge pthread runner", async (t) => {
  let harness;
  try {
    harness = await loadModule({
      wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
      runtimeKind: "wasmedge",
      enableThreads: true,
      // SDK 0.8.18's raw CLI launcher needs the standard wasi.thread-spawn
      // verification host; encoding, command ABI and artifact stay SDK-owned.
      wasmEdgeBinary: await buildNativeWasiThreadsRunner(),
    });
  } catch (error) {
    if (/spawn wasmedge ENOENT|command not found|Failed to launch/i.test(String(error))) {
      t.skip("Install wasmedge to verify the pthread server-path harness.");
      return;
    }
    throw error;
  }
  t.after(async () => {
    await harness.destroy();
  });

  const response = await harness.invoke(createVersionInvokeRequest());
  assertSuccessfulResponse(response);
});

test("primary artifact executes through the SDK browser WASI harness", async (t) => {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(ISOMORPHIC_WASM_PATH), surface: "command", enableThreads: true });
  t.after(() => harness.destroy());
  assertSuccessfulResponse(await harness.invoke(createVersionInvokeRequest()));
});

test("hosted-runtime example is wired to the screen catalog command surface", () => {
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
