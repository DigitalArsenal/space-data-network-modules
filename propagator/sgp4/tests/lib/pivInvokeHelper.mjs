// Shared harness for driving the SGP4 module's canonical SDS PIV invoke ABI.

import * as flatbuffers from "flatbuffers";
import fs from "node:fs";
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
import { createBrowserModuleHarness } from "space-data-module-sdk/testing/browser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isomorphicArtifact = path.resolve(
  __dirname,
  "..",
  "..",
  "dist",
  "isomorphic",
  "module.wasm",
);

export async function loadRawSgp4Module() {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(isomorphicArtifact),
    surface: "direct",
  });
  const exports = harness.instance.exports;
  const memory = harness.memory ?? exports.memory;
  if (!memory) throw new Error("SGP4 direct harness did not expose linear memory.");

  // Preserve the small Emscripten-shaped adapter used by the focused PIV
  // contract tests while they now execute the canonical WASI artifact. The
  // aliases are test-only; no production loader depends on Emscripten glue.
  const module = {
    destroy() {
      harness.destroy();
    },
  };
  for (const name of [
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
    "plugin_destroy",
    "get_satellite_count",
    "plugin_get_cat_record_json_size",
    "plugin_get_cat_record_json",
    "malloc",
    "free",
  ]) {
    if (typeof exports[name] === "function") module[`_${name}`] = exports[name];
  }
  if (typeof exports.plugin_destroy === "function") {
    module._plugin_destroy = (...args) => {
      try {
        return exports.plugin_destroy(...args);
      } finally {
        harness.destroy();
      }
    };
  }
  Object.defineProperty(module, "HEAPU8", {
    get() {
      return new Uint8Array(memory.buffer);
    },
  });
  return module;
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
