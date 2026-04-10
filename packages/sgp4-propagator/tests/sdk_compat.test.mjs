import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  generateManifestHarnessPlan,
  materializeHarnessScenario,
} from "space-data-module-sdk/testing";
import { decodePluginInvokeResponse } from "space-data-module-sdk/invoke";
import { validatePluginArtifact } from "space-data-module-sdk/compliance";

const ROOT = new URL("..", import.meta.url);
const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/sgp4_wasm.wasm", import.meta.url);
const JS_LOADER_PATH = new URL("../dist/sgp4_wasm.js", import.meta.url);
const REQUEST_FIXTURE_PATH = new URL(
  "../tests/fixtures/request.propagate.json",
  import.meta.url,
);
const FLOW_EXAMPLE_PATH = new URL(
  "../tests/fixtures/sdn-flow/sgp4.single-plugin.flow.json",
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

function runWithWasmEdge(stdinBytes) {
  return spawnSync("wasmedge", [fileURLToPath(WASM_PATH)], {
    cwd: fileURLToPath(ROOT),
    input: stdinBytes,
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function assertSuccessfulResponse(response) {
  assert.equal(response.statusCode, 0);
  assert.ok(response.errorCode === "" || response.errorCode === null);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "response");

  const payload = JSON.parse(new TextDecoder().decode(response.outputs[0].payload));
  assert.equal(payload.objectName, "ISS (ZARYA)");
  assert.equal(payload.noradId, 25544);
  assert.ok(payload.numStates >= 13);
  assert.ok(Array.isArray(payload.states));
}

test("built artifact passes SDK compliance checks", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const report = await validatePluginArtifact({
    manifest,
    wasmPath: fileURLToPath(WASM_PATH),
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("built artifact loads through the JS/browser wrapper and preserves invoke_json", async () => {
  const require = createRequire(import.meta.url);
  const factory = require(fileURLToPath(JS_LOADER_PATH));
  const previousExitCode = process.exitCode;
  const Module = await factory({ print() {}, printErr() {} });
  process.exitCode = previousExitCode;
  const content = fs.readFileSync(REQUEST_FIXTURE_PATH, "utf8");

  const len = Module.lengthBytesUTF8(content);
  const ptr = Module._wasm_malloc(len + 1);
  Module.stringToUTF8(content, ptr, len + 1);

  try {
    const resultPtr = Module._wasm_invoke_json(ptr, len);
    const result = JSON.parse(Module.UTF8ToString(resultPtr));
    assert.equal(result.objectName, "ISS (ZARYA)");
    assert.equal(result.noradId, 25544);
    assert.ok(result.numStates >= 13);
  } finally {
    Module._wasm_free(ptr);
    process.exitCode = previousExitCode;
  }
});

test("built artifact handles command invoke smoke in WasmEdge", () => {
  const scenario = createHarnessScenario("command");
  const result = runWithWasmEdge(scenario.stdinBytes);
  assert.equal(result.status, 0, result.stderr?.toString("utf8") ?? "");
  const response = decodePluginInvokeResponse(new Uint8Array(result.stdout));
  assertSuccessfulResponse(response);
});

test("standalone artifact handles direct invoke in WasmEdge", () => {
  const standalonePath = fileURLToPath(
    new URL("../dist/sgp4_standalone.wasm", import.meta.url),
  );
  try {
    fs.accessSync(standalonePath);
  } catch {
    return; // standalone not built — skip
  }
  const scenario = createHarnessScenario("command");
  const result = spawnSync("wasmedge", [standalonePath], {
    cwd: fileURLToPath(ROOT),
    input: scenario.stdinBytes,
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr?.toString("utf8") ?? "");
  const response = decodePluginInvokeResponse(new Uint8Array(result.stdout));
  assertSuccessfulResponse(response);
});

test("standalone artifact exports the isomorphic invoke surface", async () => {
  const standalonePath = fileURLToPath(
    new URL("../dist/sgp4_standalone.wasm", import.meta.url),
  );
  try {
    fs.accessSync(standalonePath);
  } catch {
    return; // standalone not built — skip
  }
  const wasmBytes = fs.readFileSync(standalonePath);
  const compiled = await WebAssembly.compile(wasmBytes);
  const exportNames = WebAssembly.Module.exports(compiled).map((e) => e.name);
  for (const name of [
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(exportNames.includes(name), `missing export: ${name}`);
  }
  const imports = WebAssembly.Module.imports(compiled);
  const importModules = [...new Set(imports.map((i) => i.module))];
  assert.deepEqual(importModules, ["wasi_snapshot_preview1"]);
});

test("sdn-flow example is wired to the canonical invoke contract", () => {
  const flow = JSON.parse(fs.readFileSync(FLOW_EXAMPLE_PATH, "utf8"));
  assert.equal(flow.nodes.length, 1);
  assert.equal(flow.nodes[0].pluginId, "sgp4-propagator");
  assert.equal(flow.nodes[0].methodId, "invoke");
  assert.equal(flow.triggerBindings[0].targetPortId, "request");
});
