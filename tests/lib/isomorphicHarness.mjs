import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const cwdRequire = createRequire(path.join(process.cwd(), "package.json"));
const { createBrowserModuleHarness } = await import(
  pathToFileURL(cwdRequire.resolve("space-data-module-sdk/testing")).href,
);
const { loadModule } = await import(
  pathToFileURL(cwdRequire.resolve("space-data-module-sdk/host/isomorphic")).href,
);

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

export function isWasmEdgeAvailable() {
  const result = spawnSync("wasmedge", ["--version"], { stdio: "ignore" });
  return result.status === 0;
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
      wasmMemory: options.wasmMemory,
      memory: options.memory,
      sharedMemory: options.sharedMemory,
      allowRawInvoke: options.allowRawInvoke,
      initialMemoryBytes: options.initialMemoryBytes,
      maximumMemoryBytes: options.maximumMemoryBytes,
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
  if (runtimeKind === "wasmedge" && !isWasmEdgeAvailable()) {
    t.skip("Install wasmedge to verify the server-path harness.");
    return null;
  }

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

function toPayloadBytes(payload) {
  if (payload instanceof Uint8Array) {
    return payload;
  }
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (payload instanceof ArrayBuffer) {
    return new Uint8Array(payload);
  }
  throw new TypeError("Binary module requests require Uint8Array-compatible payload bytes.");
}

function isBrowserDirectHarness(harness) {
  return harness?.runtime?.kind === "browser" && harness?.runtime?.surface === "direct";
}

export async function invokeBinaryRequest(
  harness,
  payload,
  {
    methodId = "invoke",
    inputPortId = "request",
    inputTypeRef = null,
    alignment = 8,
  } = {},
) {
  const payloadBytes = toPayloadBytes(payload);

  if (!isBrowserDirectHarness(harness)) {
    const response = await harness.invoke({
      methodId,
      inputs: [
        {
          portId: inputPortId,
          typeRef: inputTypeRef,
          payload: payloadBytes,
        },
      ],
    });
    return response;
  }

  if (
    typeof SharedArrayBuffer !== "function" ||
    !(harness.memory?.buffer instanceof SharedArrayBuffer)
  ) {
    throw new Error(
      "Browser direct binary requests require SharedArrayBuffer-backed module memory.",
    );
  }
  const alloc = harness.instance?.exports?.plugin_alloc;
  const free = harness.instance?.exports?.plugin_free;
  if (typeof alloc !== "function" || typeof free !== "function") {
    throw new Error(
      "Browser direct binary requests require plugin_alloc and plugin_free exports.",
    );
  }

  const payloadSize = payloadBytes.byteLength;
  const payloadPtr = payloadSize > 0 ? alloc(payloadSize) : 0;
  if (payloadSize > 0 && !payloadPtr) {
    throw new Error("plugin_alloc returned null for binary request payload.");
  }
  if (payloadSize > 0 && payloadPtr % alignment !== 0) {
    if (payloadPtr > 0) {
      free(payloadPtr, payloadSize);
    }
    throw new Error(
      `plugin_alloc returned a payload pointer (${payloadPtr}) that is not ${alignment}-byte aligned.`,
    );
  }

  try {
    if (payloadSize > 0) {
      new Uint8Array(harness.memory.buffer, payloadPtr, payloadSize).set(payloadBytes);
    }
    const response = await harness.invoke({
      methodId,
      externalArena: new Uint8Array(harness.memory.buffer),
      inputs: [
        {
          portId: inputPortId,
          typeRef: inputTypeRef,
          offset: payloadPtr,
          size: payloadSize,
          alignment,
        },
      ],
    });
    return response;
  } finally {
    if (payloadSize > 0) {
      free(payloadPtr, payloadSize);
    }
  }
}

export async function invokeJsonRequest(
  harness,
  request,
  {
    methodId = "invoke",
    inputPortId = "request",
    outputPortId = "response",
    inputTypeRef = null,
  } = {},
) {
  const response = await harness.invoke({
    methodId,
    inputs: [
      {
        portId: inputPortId,
        typeRef: inputTypeRef,
        payload: Buffer.from(JSON.stringify(request), "utf8"),
      },
    ],
  });
  const payload = assertSuccessfulResponse(response, { outputPortId });
  return JSON.parse(new TextDecoder().decode(payload));
}
