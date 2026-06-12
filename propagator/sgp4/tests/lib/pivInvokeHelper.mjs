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
  // dist artifacts ship signed (appended publication record collection);
  // strip it the way runtime consumers (OrbPro resolveProtectedWasmBytes,
  // SDK loaders) do before handing bytes to the Emscripten factory.
  const wasmBinary = stripPublicationRecordCollection(
    await readFile(path.join(browserDistDir, "module.wasm")),
  );
  return factory({ wasmBinary });
}

function alignOffset(offset, alignment) {
  if (alignment <= 1) {
    return offset;
  }
  const remainder = offset % alignment;
  return remainder === 0 ? offset : offset + alignment - remainder;
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
      input.typeRef?.wireFormat ?? payloadWireFormat.FLATBUFFER,
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
  module.HEAPU8.set(bytes, Number(pointer) >>> 0);
}

function cloneBytes(module, pointer, size) {
  const start = Number(pointer) >>> 0;
  const end = start + (Number(size) >>> 0);
  return new Uint8Array(module.HEAPU8.slice(start, end));
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
  new DataView(module.HEAPU8.buffer).setUint32(responseSizePointer, 0, true);

  let responsePointer = 0;
  try {
    responsePointer = module._plugin_invoke_stream(
      requestPointer,
      requestBytes.length,
      responseSizePointer,
    );
    const responseSize = new DataView(module.HEAPU8.buffer).getUint32(
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
