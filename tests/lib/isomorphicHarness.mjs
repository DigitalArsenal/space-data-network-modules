import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createBrowserModuleHarness,
} from "../../../space-data-module-sdk/src/testing/browserModuleHarness.js";
import {
  loadModule,
} from "../../../space-data-module-sdk/src/host/isomorphicLoader.js";

export const STANDALONE_RUNTIME_KINDS = Object.freeze(["browser", "wasmedge"]);

function resolveWasmPath(wasmPath) {
  if (wasmPath instanceof URL) {
    return fileURLToPath(wasmPath);
  }
  return String(wasmPath);
}

export function isMissingWasmEdgeError(error) {
  return /spawn wasmedge ENOENT|command not found|Failed to launch/i.test(
    String(error),
  );
}

export async function createStandaloneHarness(runtimeKind, wasmPath, options = {}) {
  const resolvedWasmPath = resolveWasmPath(wasmPath);
  if (runtimeKind === "browser") {
    return createBrowserModuleHarness({
      wasmSource: fs.readFileSync(resolvedWasmPath),
      surface: options.surface ?? "command",
      host: options.host,
      hostOptions: options.hostOptions,
      args: options.args,
      env: options.env,
      logOutput: options.logOutput,
      performance: options.performance,
    });
  }

  if (runtimeKind === "wasmedge") {
    return loadModule({
      wasmSource: resolvedWasmPath,
      runtimeKind: "wasmedge",
      enableThreads: options.enableThreads ?? false,
      wasmEdgeBinary: options.wasmEdgeBinary,
      wasmEdgeRunnerBinary: options.wasmEdgeRunnerBinary,
      args: options.args,
      env: options.env,
      cwd: options.cwd,
    });
  }

  throw new Error(`Unsupported runtime kind: ${runtimeKind}`);
}

export async function createStandaloneHarnessOrSkip(
  runtimeKind,
  wasmPath,
  t,
  options = {},
) {
  try {
    return await createStandaloneHarness(runtimeKind, wasmPath, options);
  } catch (error) {
    if (runtimeKind === "wasmedge" && isMissingWasmEdgeError(error)) {
      t.skip("Install wasmedge to verify the server-path harness.");
      return null;
    }
    throw error;
  }
}

export function assertSuccessfulResponse(
  response,
  { outputPortId = "response" } = {},
) {
  assert.equal(response.statusCode, 0);
  assert.ok(response.errorCode === "" || response.errorCode === null);
  const frame = response.outputs.find((entry) => entry.portId === outputPortId);
  assert.ok(frame, `missing ${outputPortId} output frame`);
  return frame.payload;
}

export async function invokeJsonRequest(
  harness,
  request,
  { methodId = "invoke", inputPortId = "request", outputPortId = "response" } = {},
) {
  const response = await harness.invoke({
    methodId,
    inputs: [
      {
        portId: inputPortId,
        payload: Buffer.from(JSON.stringify(request), "utf8"),
      },
    ],
  });
  const payload = assertSuccessfulResponse(response, { outputPortId });
  return JSON.parse(new TextDecoder().decode(payload));
}
