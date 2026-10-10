// Shared harness for driving the SGP4 module's canonical SDS PIV invoke ABI.

import * as flatbuffers from "flatbuffers";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  bufferMutability,
  bufferOwnership,
  FlatBufferTypeRefT,
  payloadWireFormat,
  PIV,
  PIVRequestT,
  PIVT,
  TABT,
} from "spacedatastandards.org/lib/js/PIV/main.js";
import { stripPublicationRecordCollection } from "space-data-module-sdk/transport";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const browserDistDir = path.resolve(__dirname, "..", "..", "dist", "browser");

const cachedFactories = new Map();

async function loadFactory(distDir) {
  if (!cachedFactories.has(distDir)) {
    const moduleUrl = new URL(
      "file://" + path.join(distDir, "module.js"),
    );
    const imported = await import(moduleUrl.href);
    cachedFactories.set(distDir, imported.default);
  }
  return cachedFactories.get(distDir);
}

// The browser artifact (module.js and module.wasm) of this package, or of
// another build in `distDir` (the 1.1.0 baseline, for the regression digests).
export async function loadRawSgp4Module(distDir = browserDistDir) {
  const factory = await loadFactory(distDir);
  // dist artifacts ship signed (appended publication record collection);
  // strip it the way runtime consumers (OrbPro resolveProtectedWasmBytes,
  // SDK loaders) do before handing bytes to the Emscripten factory.
  const wasmBinary = stripPublicationRecordCollection(
    await readFile(path.join(distDir, "module.wasm")),
  );
  // The module grows its memory from inside the wasm, which leaves the
  // glue's HEAPU8 view on the old buffer; keep the memory to read it fresh.
  let memory = null;
  const module = await factory({
    wasmBinary,
    instantiateWasm(imports, receive) {
      WebAssembly.instantiate(wasmBinary, imports).then(({ instance, module: compiled }) => {
        memory = instance.exports.memory;
        receive(instance, compiled);
      });
      return {};
    },
  });
  module.currentHeap = () => (memory ? new Uint8Array(memory.buffer) : module.HEAPU8);
  return module;
}

function heap(module) {
  return module.currentHeap ? module.currentHeap() : module.HEAPU8;
}

function alignOffset(offset, alignment) {
  if (alignment <= 1) {
    return offset;
  }
  const remainder = offset % alignment;
  return remainder === 0 ? offset : offset + alignment - remainder;
}

function encodeWireFormat(value) {
  if (typeof value === "number") {
    return value;
  }
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-") === "aligned-binary"
    ? payloadWireFormat.ALIGNED_BINARY
    : payloadWireFormat.FLATBUFFER;
}

function decodeWireFormat(value) {
  return value === payloadWireFormat.ALIGNED_BINARY ? "aligned-binary" : "flatbuffer";
}

export function encodePivInvokeRequest({
  methodId,
  inputs = [],
  outputStreamCap = 0,
  traceId = 0n,
}) {
  const arena = [];
  const frames = inputs.map((input) => {
    const payload = input.bytes ?? input.payload ?? new Uint8Array();
    const alignment = Number(input.alignment ?? 8);
    const offset = alignOffset(arena.length, alignment);
    while (arena.length < offset) {
      arena.push(0);
    }
    for (const byte of payload) {
      arena.push(byte);
    }

    const typeRef = new FlatBufferTypeRefT(
      input.typeRef?.schemaName ?? input.schemaName ?? null,
      input.typeRef?.fileIdentifier ?? input.fileIdentifier ?? null,
      input.typeRef?.schemaVersion ?? null,
      input.typeRef?.rootTypeName ?? input.rootTypeName ?? null,
    );
    const frame = new TABT(
      offset,
      payload.length,
      alignment,
      encodeWireFormat(input.wireFormat ?? input.typeRef?.wireFormat),
      typeRef,
      input.mutability ?? bufferMutability.IMMUTABLE,
      input.ownership ?? bufferOwnership.HOST_OWNED,
      BigInt(input.frameId ?? 0),
    );
    frame.PORT_ID = input.portId;
    return frame;
  });

  const request = new PIVRequestT(
    methodId,
    frames,
    arena,
    BigInt(traceId),
    Number(outputStreamCap),
  );
  const envelope = new PIVT(request, null);
  const builder = new flatbuffers.Builder(Math.max(1024, arena.length + 256));
  PIV.finishPIVBuffer(builder, envelope.pack(builder));
  return builder.asUint8Array();
}

export function decodePivEnvelope(bytes) {
  const buffer = new flatbuffers.ByteBuffer(bytes);
  if (!PIV.bufferHasIdentifier(buffer)) {
    throw new Error("PIV payload missing $PIV file identifier");
  }
  return PIV.getRootAsPIV(buffer).unpack();
}

function writeBytes(module, pointer, bytes) {
  heap(module).set(bytes, Number(pointer) >>> 0);
}

function cloneBytes(module, pointer, size) {
  const start = Number(pointer) >>> 0;
  const end = start + (Number(size) >>> 0);
  return new Uint8Array(heap(module).slice(start, end));
}

// The raw PIV response bytes of one invocation.
export function invokePivRaw(module, requestBytes) {
  const requestPointer = module._plugin_alloc(requestBytes.length);
  const responseSizePointer = module._plugin_alloc(4);
  writeBytes(module, requestPointer, requestBytes);
  new DataView(heap(module).buffer).setUint32(responseSizePointer, 0, true);
  let responsePointer = 0;
  try {
    responsePointer = module._plugin_invoke_stream(requestPointer, requestBytes.length, responseSizePointer);
    const responseSize = new DataView(heap(module).buffer).getUint32(responseSizePointer, true);
    return cloneBytes(module, responsePointer, responseSize);
  } finally {
    if (responsePointer) module._plugin_free(responsePointer, 0);
    module._plugin_free(requestPointer, requestBytes.length);
    module._plugin_free(responseSizePointer, 4);
  }
}

export function invokePiv(
  module,
  { methodId, inputs, outputStreamCap = 0, traceId = 0n } = {},
) {
  const requestBytes = encodePivInvokeRequest({
    methodId,
    inputs,
    outputStreamCap,
    traceId,
  });
  const requestPointer = module._plugin_alloc(requestBytes.length);
  const responseSizePointer = module._plugin_alloc(4);
  writeBytes(module, requestPointer, requestBytes);
  new DataView(heap(module).buffer).setUint32(responseSizePointer, 0, true);

  let responsePointer = 0;
  try {
    responsePointer = module._plugin_invoke_stream(
      requestPointer,
      requestBytes.length,
      responseSizePointer,
    );
    const responseSize = new DataView(heap(module).buffer).getUint32(
      responseSizePointer,
      true,
    );
    const envelope = decodePivEnvelope(
      cloneBytes(module, responsePointer, responseSize),
    );
    const response = envelope.RESPONSE;
    const outputPayloads = response.OUTPUTS.map((output) => ({
      portId: output.PORT_ID,
      typeRef: output.TYPE_REF
        ? {
            schemaName: output.TYPE_REF.SCHEMA_NAME,
            fileIdentifier: output.TYPE_REF.FILE_IDENTIFIER,
            rootTypeName: output.TYPE_REF.ROOT_TYPE,
          }
        : null,
      wireFormat: decodeWireFormat(output.WIRE_FORMAT),
      alignment: output.ALIGNMENT,
      bytes: new Uint8Array(
        response.PAYLOAD_ARENA.slice(
          output.OFFSET,
          output.OFFSET + output.SIZE,
        ),
      ),
    }));
    return { envelope, response, outputPayloads };
  } finally {
    if (responsePointer) {
      module._plugin_free(responsePointer, 0);
    }
    module._plugin_free(requestPointer, requestBytes.length);
    module._plugin_free(responseSizePointer, 4);
  }
}
