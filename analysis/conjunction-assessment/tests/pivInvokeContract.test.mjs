// SDS PIV invoke contract for analysis.conjunction-assessment.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as flatbuffers from "flatbuffers";
import { bufferMutability } from "spacedatastandards.org/lib/js/PIV/bufferMutability.js";
import { bufferOwnership } from "spacedatastandards.org/lib/js/PIV/bufferOwnership.js";
import { FlatBufferTypeRefT } from "spacedatastandards.org/lib/js/PIV/FlatBufferTypeRef.js";
import { payloadWireFormat } from "spacedatastandards.org/lib/js/PIV/payloadWireFormat.js";
import { PIV, PIVT } from "spacedatastandards.org/lib/js/PIV/PIV.js";
import { PIVRequestT } from "spacedatastandards.org/lib/js/PIV/PIVRequest.js";
import { PIVResponseT } from "spacedatastandards.org/lib/js/PIV/PIVResponse.js";
import { pivStatus } from "spacedatastandards.org/lib/js/PIV/pivStatus.js";
import { TABT } from "spacedatastandards.org/lib/js/PIV/TAB.js";

import { initCqrFlatc, encodeCqr, decodeCqr } from "./lib/cqr.mjs";
const flatc = await initCqrFlatc();
import { loadRawConjunctionModule as loadSdkModule } from "./lib/screenCatalogParityHarness.mjs";
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

async function loadRawConjunctionModule() {
  const exports = await loadSdkModule();
  return {
    memory: exports.memory,
    pluginAlloc: exports.plugin_alloc,
    pluginFree: exports.plugin_free,
    pluginInvokeStream: exports.plugin_invoke_stream,
  };
}

function memoryBytes(module) {
  return new Uint8Array(module.memory.buffer);
}

function memoryView(module) {
  return new DataView(module.memory.buffer);
}

function pluginAlloc(module, size) {
  const pointer = module.pluginAlloc(size);
  assert.ok(pointer, "plugin_alloc returned null");
  return Number(pointer) >>> 0;
}

function pluginFree(module, pointer, size) {
  if (pointer) {
    module.pluginFree(pointer, size);
  }
}

function pluginInvokeStream(module, requestPointer, requestLength, responseSizePointer) {
  const pointer = module.pluginInvokeStream(
    requestPointer,
    requestLength,
    responseSizePointer,
  );
  assert.ok(pointer, "plugin_invoke_stream returned null");
  return Number(pointer) >>> 0;
}

function assertDirectExports(module) {
  assert.equal(typeof module.pluginAlloc, "function");
  assert.equal(typeof module.pluginFree, "function");
  assert.equal(typeof module.pluginInvokeStream, "function");
  assert.ok(module.memory instanceof WebAssembly.Memory);
}

function alignOffset(offset, alignment) {
  if (alignment <= 1) {
    return offset;
  }
  const remainder = offset % alignment;
  return remainder === 0 ? offset : offset + alignment - remainder;
}

function encodePivEnvelope(envelope) {
  const builder = new flatbuffers.Builder(1024);
  PIV.finishPIVBuffer(builder, envelope.pack(builder));
  return builder.asUint8Array();
}

function encodePivInvokeRequest({ methodId, inputs = [], traceId = 0n }) {
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
      input.schemaName ?? input.typeRef?.schemaName ?? null,
      input.fileIdentifier ?? input.typeRef?.fileIdentifier ?? null,
      null,
      input.rootTypeName ?? input.typeRef?.rootTypeName ?? null,
    );
    const frame = new TABT(
      offset,
      payload.length,
      alignment,
      input.wireFormat ?? payloadWireFormat.FLATBUFFER,
      typeRef,
      bufferMutability.IMMUTABLE,
      bufferOwnership.HOST_OWNED,
      BigInt(input.frameId ?? 0),
    );
    frame.PORT_ID = input.portId;
    return frame;
  });

  return encodePivEnvelope(
    new PIVT(
      new PIVRequestT(methodId, frames, arena, BigInt(traceId), 0),
      null,
    ),
  );
}

function decodePivEnvelope(bytes) {
  const buffer = new flatbuffers.ByteBuffer(bytes);
  assert.equal(PIV.bufferHasIdentifier(buffer), true);
  return PIV.getRootAsPIV(buffer).unpack();
}

function cloneBytes(module, pointer, size) {
  const start = Number(pointer) >>> 0;
  const end = start + (Number(size) >>> 0);
  return new Uint8Array(memoryBytes(module).slice(start, end));
}

function invokePivBytes(module, requestBytes) {
  const requestPointer = pluginAlloc(module, requestBytes.length);
  const responseSizePointer = pluginAlloc(module, 4);
  memoryBytes(module).set(requestBytes, requestPointer);
  memoryView(module).setUint32(responseSizePointer, 0, true);

  let responsePointer = 0;
  try {
    responsePointer = pluginInvokeStream(
      module,
      requestPointer,
      requestBytes.length,
      responseSizePointer,
    );
    const responseSize = memoryView(module).getUint32(
      responseSizePointer,
      true,
    );
    return decodePivEnvelope(cloneBytes(module, responsePointer, responseSize));
  } finally {
    pluginFree(module, responsePointer, 0);
    pluginFree(module, requestPointer, requestBytes.length);
    pluginFree(module, responseSizePointer, 4);
  }
}

function assertFailedPiv(envelope, { statusCode, status, errorCode }) {
  assert.equal(envelope.RESPONSE.STATUS_CODE, statusCode);
  assert.equal(envelope.RESPONSE.STATUS, status);
  assert.equal(envelope.RESPONSE.ERROR_CODE, errorCode);
  assert.ok(envelope.RESPONSE.ERROR_MESSAGE);
}

test("conjunction plugin_invoke_stream accepts and rejects SDS PIV envelopes", async () => {
  const module = await loadRawConjunctionModule();
  assertDirectExports(module);

  const valid = invokePivBytes(
    module,
    encodePivInvokeRequest({
      methodId: "version",
      inputs: [
        {
          portId: "request",
          bytes: encodeCqr(flatc, { VERSION_QUERY: true }),
          schemaName: "CQR.fbs",
          fileIdentifier: "$CQR",
          rootTypeName: "CQR",
        },
      ],
    }),
  );
  assert.equal(valid.RESPONSE.STATUS_CODE, 0);
  assert.equal(valid.RESPONSE.STATUS, pivStatus.OK);
  assert.equal(valid.RESPONSE.OUTPUTS.length, 1);
  assert.equal(valid.RESPONSE.OUTPUTS[0].PORT_ID, "result");
  const output = valid.RESPONSE.OUTPUTS[0];
  const payload = valid.RESPONSE.PAYLOAD_ARENA.slice(
    output.OFFSET,
    output.OFFSET + output.SIZE,
  );
  assert.equal(decodeCqr(flatc, new Uint8Array(payload)).VERSION_RESULT.VERSION, "0.2.0");

  assertFailedPiv(
    invokePivBytes(module, encodePivEnvelope(new PIVT(null, new PIVResponseT()))),
    {
      statusCode: 400,
      status: pivStatus.FAILED,
      errorCode: "invalid-request",
    },
  );

  assertFailedPiv(invokePivBytes(module, new Uint8Array([1, 2, 3, 4])), {
    statusCode: 400,
    status: pivStatus.FAILED,
    errorCode: "invalid-request",
  });

  assertFailedPiv(
    invokePivBytes(module, encodePivInvokeRequest({ methodId: "does_not_exist" })),
    {
      statusCode: 404,
      status: pivStatus.NOT_FOUND,
      errorCode: "unknown-method",
    },
  );
});
