import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import { validatePluginArtifact } from "space-data-module-sdk/compliance";
import { inspectModule, loadModule } from "space-data-module-sdk/host/isomorphic";
import {
  buildWasmEdgeEmscriptenPthreadRunner,
  createBrowserModuleHarness,
} from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const BROWSER_MODULE_PATH = new URL("../dist/browser/module.js", import.meta.url);
const BROWSER_WASM_PATH = new URL("../dist/browser/module.wasm", import.meta.url);
const FLOW_EXAMPLE_PATH = new URL(
  "../tests/fixtures/hosted-runtime/conjunction.single-plugin.flow.json",
  import.meta.url,
);
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function createVersionInvokeRequest() {
  return {
    methodId: "invoke",
    inputs: [
      {
        portId: "request",
        payload: textEncoder.encode(JSON.stringify({ operation: "version" })),
      },
    ],
  };
}

function assertSuccessfulResponse(response) {
  assert.equal(response.statusCode, 0);
  assert.ok(response.errorCode === "" || response.errorCode === null);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "response");

  const payload = response.outputs[0].payload ?? response.outputs[0].bytes;
  assert.ok(payload instanceof Uint8Array, "response should contain result bytes");
  assert.ok(payload.byteLength > 0, "response result should not be empty");
  assert.equal(JSON.parse(textDecoder.decode(payload)).version, "0.2.0");
}

async function buildThreadedWasmEdgeRunner(t) {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "conjunction-wasmedge-pthread-runner-"),
  );
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const outputPath = path.join(tempDir, "wasmedge-pthread-runner");
  try {
    return await buildWasmEdgeEmscriptenPthreadRunner({ outputPath });
  } catch (error) {
    if (
      /WasmEdge include|WasmEdge library|not found|startup probe timed out|failed startup probe/i.test(
        String(error),
      )
    ) {
      t.skip(
        "Install a working WasmEdge C API library to verify the pthread runner.",
      );
      return null;
    }
    throw error;
  }
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

test("built artifact exposes the WasmEdge Emscripten pthread surface", async () => {
  const inspection = await inspectModule(
    fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
  );
  const importedModuleNames = Array.from(
    new Set(inspection.imports.map((entry) => entry.module)),
  ).sort();
  const envImports = inspection.imports.filter((entry) => entry.module === "env");

  assert.equal(inspection.profile, "emscripten");
  assert.deepEqual(importedModuleNames, ["env", "wasi_snapshot_preview1"]);
  assert.ok(
    envImports.some(
      (entry) => entry.kind === "memory" && entry.name === "memory",
    ),
    "pthread isomorphic artifact should import shared env.memory",
  );
  assert.ok(
    envImports.some(
      (entry) =>
        entry.name.includes("pthread") || entry.name.includes("thread"),
    ),
    "pthread isomorphic artifact should import Emscripten thread hostcalls",
  );
  assert.ok(inspection.exports.includes("_start"));
  assert.ok(inspection.exports.includes("plugin_alloc"));
  assert.ok(inspection.exports.includes("plugin_free"));
  assert.ok(inspection.exports.includes("plugin_invoke_stream"));
  assert.ok(inspection.exports.includes("plugin_get_manifest_flatbuffer"));
  assert.ok(inspection.exports.includes("plugin_get_manifest_flatbuffer_size"));
});

test("built artifact loads through the SDK WasmEdge pthread runner", async (t) => {
  const runnerBinary = await buildThreadedWasmEdgeRunner(t);
  if (!runnerBinary) {
    return;
  }
  let harness;
  try {
    harness = await loadModule({
      wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
      runtimeKind: "wasmedge",
      wasmEdgeRunnerBinary: runnerBinary,
      enableThreads: true,
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

test("pthread isomorphic artifact is not routed through the browser WASI harness", async () => {
  await assert.rejects(
    () =>
      createBrowserModuleHarness({
        wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
        surface: "command",
      }),
    /Browser harness only supports standalone WASI or space_data_module_host artifacts/i,
  );
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
