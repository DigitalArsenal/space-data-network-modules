import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const WASM_PATH = new URL("../dist/od_wasm.wasm", import.meta.url);
const STANDALONE_WASM_PATH = new URL("../dist/od_standalone.wasm", import.meta.url);
const JS_LOADER_PATH = new URL("../dist/od_wasm.js", import.meta.url);
const MINIMAL_MEME = `created:2026-03-10 20:32:53 UTC
ephemeris_start:2026-03-10 20:16:42 UTC ephemeris_stop:2026-03-13 20:16:42 UTC step_size:60
ephemeris_source:blend
UVW
2026069201642.000 2331.2303823166 -3812.9956790343 -5288.3093377396 7.1279396227 1.8278970842 1.8252801029
5.0574356535e-07 -4.0409074495e-07 7.9867014315e-07 -1.5244353051e-10 2.2405205309e-10 1.3019804582e-06 8.6964446628e-10
-9.2645027173e-10 -1.4154697945e-12 2.0332016107e-12 -4.8806160534e-10 4.2160627916e-10 1.9653622789e-12 -8.4753151771e-13
5.2167151149e-13 -3.5430236412e-13 -1.9835853617e-13 1.7374846904e-09 -6.5771401381e-16 2.6012134046e-15 5.4232564737e-12
2026069201742.000 2753.5753612189 -3695.1830223004 -5167.4424341778 6.9451594823 2.0977895841 2.2021774396
5.5877928873e-07 -4.7375264519e-07 9.1102189897e-07 -2.1752319120e-10 4.1022000836e-10 1.5237983513e-06 9.7534909273e-10
-1.0742139295e-09 -1.7844400970e-12 2.2539013390e-12 -5.4098450089e-10 4.9252228263e-10 2.2865893169e-12 -9.5425673314e-13
5.7442159873e-13 -5.2862580271e-13 2.2079571161e-13 1.9544407278e-09 -1.3018409197e-15 3.0161098392e-15 5.1863337220e-12
2026069201842.000 3164.0497097397 -3561.4406046759 -5024.2367974268 6.7323931239 2.3586995247 2.5696384902
6.1526243750e-07 -5.5175648026e-07 1.0420883160e-06 -2.9911207274e-10 6.5538787474e-10 1.7697659451e-06 1.0887857305e-09
-1.2415650564e-09 -2.2403173610e-12 2.4917480116e-12 -5.9748245532e-10 5.7189693440e-10 2.6325665880e-12 -1.0690003735e-12
6.3090290772e-13 -7.1251333042e-13 6.7782739014e-13 2.1394109823e-09 -1.9784042803e-15 3.3732085227e-15 4.9203888241e-12
`;

function readFixtureBytes() {
  return new TextEncoder().encode(MINIMAL_MEME);
}

function createHarnessScenario(surface) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const plan = generateManifestHarnessPlan({
    manifest,
    payloadForPort({ portId }) {
      if (portId !== "meme") {
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "od-sdk-compat-"));

  try {
    return spawnSync("wasmedge", [fileURLToPath(WASM_PATH)], {
      cwd: fileURLToPath(ROOT),
      input: stdinBytes,
      encoding: null,
      maxBuffer: 16 * 1024 * 1024,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function assertSuccessfulResponse(response) {
  assert.equal(response.statusCode, 0);
  assert.ok(response.errorCode === "" || response.errorCode === null);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "result");

  const payloadText = new TextDecoder().decode(response.outputs[0].payload);
  const payload = JSON.parse(payloadText);
  assert.equal(payload.error, undefined);
  assert.equal(typeof payload.RMS, "string");
}

test("built artifact passes SDK compliance checks", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const report = await validatePluginArtifact({
    manifest,
    wasmPath: fileURLToPath(WASM_PATH),
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("built artifact loads through the JS/browser wrapper and preserves parse-and-fit", async () => {
  const require = createRequire(import.meta.url);
  const factory = require(fileURLToPath(JS_LOADER_PATH));
  const previousExitCode = process.exitCode;
  const Module = await factory({ print() {}, printErr() {} });
  process.exitCode = previousExitCode;
  const content = new TextDecoder().decode(readFixtureBytes());

  const len = Module.lengthBytesUTF8(content);
  const ptr = Module._wasm_malloc(len + 1);
  Module.stringToUTF8(content, ptr, len + 1);

  try {
    const resultPtr = Module._wasm_parse_and_fit(ptr, len);
    const result = JSON.parse(Module.UTF8ToString(resultPtr));
    assert.equal(result.error, undefined);
    assert.equal(typeof result.RMS, "string");
  } finally {
    Module._wasm_free(ptr);
    process.exitCode = previousExitCode;
  }
});

test("standalone artifact handles direct invoke in WasmEdge", { skip: !fs.existsSync(fileURLToPath(STANDALONE_WASM_PATH)) && "standalone .wasm not built" }, () => {
  const scenario = createHarnessScenario("command");
  const result = spawnSync("wasmedge", [fileURLToPath(STANDALONE_WASM_PATH)], {
    cwd: fileURLToPath(ROOT),
    input: scenario.stdinBytes,
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr?.toString("utf8") ?? "");
  const response = decodePluginInvokeResponse(new Uint8Array(result.stdout));
  assertSuccessfulResponse(response);
});

test("standalone artifact exports the isomorphic invoke surface", { skip: !fs.existsSync(fileURLToPath(STANDALONE_WASM_PATH)) && "standalone .wasm not built" }, async () => {
  const bytes = fs.readFileSync(fileURLToPath(STANDALONE_WASM_PATH));
  const compiled = await WebAssembly.compile(bytes);
  const exportNames = WebAssembly.Module.exports(compiled).map((e) => e.name);
  for (const fn of [
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(exportNames.includes(fn), `missing export: ${fn}`);
  }
  const importModules = [
    ...new Set(WebAssembly.Module.imports(compiled).map((i) => i.module)),
  ];
  assert.deepStrictEqual(importModules, ["wasi_snapshot_preview1"]);
});

test("built artifact handles command invoke smoke in WasmEdge", () => {
  const scenario = createHarnessScenario("command");
  const result = runWithWasmEdge(scenario.stdinBytes);
  assert.equal(result.status, 0, result.stderr?.toString("utf8") ?? "");
  const response = decodePluginInvokeResponse(new Uint8Array(result.stdout));
  assertSuccessfulResponse(response);
});
