// Shared harness for driving OrbPro's native `plugin_stream_invoke` directly
// from the contract tests. The C++ bridge in `plugin_invoke_bridge.cpp`
// already exposes `plugin_invoke_stream` (SDK 0.8.0) that wraps the native
// entry point, but the contract tests verify the raw direct-call surface so
// the existing OrbPro hosts that embed the WASM (outside the SDK harness)
// continue to talk to the same wire format as the plugin-sdk runtime.

import * as flatbuffers from "flatbuffers";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  StreamInvokeRequest,
  StreamInvokeRequestT,
} from "./generated/orbpro/plugin/stream-invoke-request.js";
import {
  StreamInvokeResponse,
} from "./generated/orbpro/plugin/stream-invoke-response.js";
import {
  TypedArenaBufferT,
} from "./generated/orbpro/stream/typed-arena-buffer.js";
import {
  FlatBufferTypeRefT,
} from "./generated/orbpro/stream/flat-buffer-type-ref.js";
import {
  BufferOwnership,
} from "./generated/orbpro/stream/buffer-ownership.js";
import {
  BufferMutability,
} from "./generated/orbpro/stream/buffer-mutability.js";
import {
  PayloadWireFormat,
} from "./generated/orbpro/stream/payload-wire-format.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const browserDistDir = path.resolve(__dirname, "..", "..", "dist", "browser");

// --- Module loader ----------------------------------------------------------

let cachedFactory = null;

async function loadFactory() {
  if (!cachedFactory) {
    const moduleUrl = new URL(
      "file://" + path.join(browserDistDir, "module.js"),
    );
    const imported = await import(moduleUrl.href);
    cachedFactory = imported.default;
  }
  return cachedFactory;
}

export async function loadRawSgp4Module() {
  const factory = await loadFactory();
  const wasmBinary = await readFile(path.join(browserDistDir, "module.wasm"));
  // Emscripten's standalone-wasm loader calls `_start` which kicks
  // `__wasm_call_ctors` (needed to initialize global std::map/vector/string
  // state inside the plugin). The plugin's `main()` returns cleanly on empty
  // stdin, so it's safe to let the factory auto-run the entry point.
  return factory({ wasmBinary });
}

// --- Codec helpers ----------------------------------------------------------

export function encodeStreamInvokeRequest({
  methodId,
  inputs = [],
  outputStreamCap = 0,
}) {
  const builder = new flatbuffers.Builder(1024);
  const request = new StreamInvokeRequestT(methodId, inputs, outputStreamCap);
  builder.finish(request.pack(builder));
  return builder.asUint8Array();
}

export function decodeStreamInvokeResponse(bytes) {
  const buffer = new flatbuffers.ByteBuffer(bytes);
  return StreamInvokeResponse.getRootAsStreamInvokeResponse(buffer).unpack();
}

// --- Raw wire helpers -------------------------------------------------------

function writeBytes(module, pointer, bytes) {
  module.HEAPU8.set(bytes, Number(pointer) >>> 0);
}

function cloneBytes(module, pointer, size) {
  const start = Number(pointer) >>> 0;
  const end = start + (Number(size) >>> 0);
  return new Uint8Array(module.HEAPU8.slice(start, end));
}

function buildTypedInput(module, input, index, stagedPointers) {
  const payloadPointer = module._malloc(input.bytes.length);
  stagedPointers.push(payloadPointer);
  writeBytes(module, payloadPointer, input.bytes);

  const typeRef =
    input.typeRef instanceof FlatBufferTypeRefT
      ? input.typeRef
      : new FlatBufferTypeRefT(
          input.typeRef?.schemaName ?? input.schemaName ?? null,
          input.typeRef?.fileIdentifier ?? input.fileIdentifier ?? null,
          Array.isArray(input.typeRef?.schemaHash)
            ? [...input.typeRef.schemaHash]
            : [],
          Boolean(input.typeRef?.acceptsAnyFlatbuffer ?? false),
          input.typeRef?.wireFormat ?? PayloadWireFormat.Flatbuffer,
          input.typeRef?.rootTypeName ?? null,
          Number(input.typeRef?.fixedStringLength ?? 0),
          Number(input.typeRef?.byteLength ?? 0),
          Number(input.typeRef?.requiredAlignment ?? 0),
        );

  return new TypedArenaBufferT(
    typeRef,
    input.portId ?? `in-${index}`,
    Number(input.alignment ?? 8),
    payloadPointer,
    input.bytes.length,
    BufferOwnership.BORROWED,
    Number(input.generation ?? 0),
    BufferMutability.IMMUTABLE,
    BigInt(input.traceToken ?? 0),
    Number(input.streamId ?? 0),
    BigInt(input.sequence ?? 0),
    Boolean(input.endOfStream ?? false),
  );
}

export function invokeStream(
  module,
  { methodId, inputs, outputStreamCap = 0 } = {},
) {
  const stagedPointers = [];
  const typedInputs = inputs.map((input, index) =>
    buildTypedInput(module, input, index, stagedPointers),
  );

  const requestBytes = encodeStreamInvokeRequest({
    methodId,
    inputs: typedInputs,
    outputStreamCap,
  });
  const requestPointer = module._malloc(requestBytes.length);
  const responseSizePointer = module._malloc(4);
  writeBytes(module, requestPointer, requestBytes);
  new DataView(module.HEAPU8.buffer).setUint32(responseSizePointer, 0, true);

  let responsePointer = 0;
  try {
    responsePointer = module._plugin_stream_invoke(
      requestPointer,
      requestBytes.length,
      responseSizePointer,
    );
    const responseSize = new DataView(module.HEAPU8.buffer).getUint32(
      responseSizePointer,
      true,
    );
    const responseBytes = cloneBytes(module, responsePointer, responseSize);
    const response = decodeStreamInvokeResponse(responseBytes);
    const outputPayloads = response.outputs.map((output) => ({
      ...output,
      bytes: cloneBytes(module, output.offset, output.size),
    }));
    for (const output of response.outputs) {
      if (output.offset) {
        module._free(output.offset);
      }
    }
    return { response, outputPayloads };
  } finally {
    if (responsePointer) {
      module._free(responsePointer);
    }
    module._free(requestPointer);
    module._free(responseSizePointer);
    for (const pointer of stagedPointers) {
      module._free(pointer);
    }
  }
}

// --- Dependency bridge helpers ----------------------------------------------
// Mirrors the shape the plugin-sdk's `createDependencyStreamBridge()` expects
// so tests can exercise the dependency-invocation path without reaching for a
// host loader.

export function createInstantiatedDependency(module) {
  return {
    memory: {
      buffer: module.HEAPU8.buffer,
    },
    resolvedExports: {
      malloc: module._malloc,
      free: module._free,
    },
    invokeRawStream(requestBytes) {
      const requestPointer = module._malloc(requestBytes.length);
      const responseSizePointer = module._malloc(4);
      writeBytes(module, requestPointer, requestBytes);
      new DataView(module.HEAPU8.buffer).setUint32(
        responseSizePointer,
        0,
        true,
      );
      let responsePointer = 0;
      try {
        responsePointer = module._plugin_stream_invoke(
          requestPointer,
          requestBytes.length,
          responseSizePointer,
        );
        const responseSize = new DataView(module.HEAPU8.buffer).getUint32(
          responseSizePointer,
          true,
        );
        return cloneBytes(module, responsePointer, responseSize);
      } finally {
        if (responsePointer) {
          module._free(responsePointer);
        }
        module._free(requestPointer);
        module._free(responseSizePointer);
      }
    },
    cloneBytes(offset, size) {
      return cloneBytes(module, offset, size);
    },
    release(pointer) {
      module._free(pointer);
    },
  };
}

// --- Dependency-bridge invoke ----------------------------------------------
// Runs the same StreamInvoke round-trip through a pre-built dependency
// instance (as produced by `createInstantiatedDependency`). Exercises the
// exact wire surface that a host embedding the module via SDK 0.8.0
// `instantiated_dependency.invokeRawStream` would drive.

export function invokeStreamViaDependency(
  instantiatedDependency,
  { methodId, inputs, outputStreamCap = 0 } = {},
) {
  const { malloc, free } = instantiatedDependency.resolvedExports;
  const { buffer } = instantiatedDependency.memory;

  const writeDepBytes = (pointer, bytes) => {
    new Uint8Array(buffer).set(bytes, Number(pointer) >>> 0);
  };

  const stagedPointers = [];
  const typedInputs = inputs.map((input, index) => {
    const payload = input.bytes;
    const pointer = payload.length > 0 ? Number(malloc(payload.length)) : 0;
    if (pointer) {
      writeDepBytes(pointer, payload);
      stagedPointers.push(pointer);
    }
    const typeRef =
      input.typeRef instanceof FlatBufferTypeRefT
        ? input.typeRef
        : new FlatBufferTypeRefT(
            input.typeRef?.schemaName ?? input.schemaName ?? null,
            input.typeRef?.fileIdentifier ?? input.fileIdentifier ?? null,
            Array.isArray(input.typeRef?.schemaHash)
              ? [...input.typeRef.schemaHash]
              : [],
            Boolean(input.typeRef?.acceptsAnyFlatbuffer ?? false),
            input.typeRef?.wireFormat ?? PayloadWireFormat.Flatbuffer,
            input.typeRef?.rootTypeName ?? null,
            Number(input.typeRef?.fixedStringLength ?? 0),
            Number(input.typeRef?.byteLength ?? 0),
            Number(input.typeRef?.requiredAlignment ?? 0),
          );
    return new TypedArenaBufferT(
      typeRef,
      input.portId ?? `in-${index}`,
      Number(input.alignment ?? 8),
      pointer,
      payload.length,
      BufferOwnership.BORROWED,
      Number(input.generation ?? 0),
      BufferMutability.IMMUTABLE,
      BigInt(input.traceToken ?? 0),
      Number(input.streamId ?? 0),
      BigInt(input.sequence ?? 0),
      Boolean(input.endOfStream ?? false),
    );
  });

  try {
    const requestBytes = encodeStreamInvokeRequest({
      methodId,
      inputs: typedInputs,
      outputStreamCap,
    });
    const responseBytes = instantiatedDependency.invokeRawStream(requestBytes);
    if (!responseBytes || responseBytes.length === 0) {
      return {
        statusCode: 0,
        backlogRemaining: 0,
        yielded: false,
        outputs: [],
        errorMessage: null,
      };
    }
    const response = decodeStreamInvokeResponse(responseBytes);
    const outputs = response.outputs.map((output) => ({
      ...output,
      bytes: instantiatedDependency.cloneBytes(output.offset, output.size),
    }));
    for (const output of response.outputs) {
      if (output.offset) {
        instantiatedDependency.release(output.offset);
      }
    }
    return {
      statusCode: response.errorCode ?? 0,
      backlogRemaining: response.backlogRemaining ?? 0,
      yielded: response.yielded ?? false,
      outputs,
      errorMessage: response.errorMessage ?? null,
    };
  } finally {
    for (const pointer of stagedPointers) {
      free(pointer);
    }
  }
}

export { StreamInvokeRequest, StreamInvokeResponse };
