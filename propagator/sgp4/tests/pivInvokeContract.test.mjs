// SDS PIV invoke contract for propagator.sgp4.
//
// `plugin_invoke_stream` consumes a root PIV envelope with REQUEST populated
// and returns a root PIV envelope with RESPONSE populated. TAB.PORT_ID carries
// method-port routing; PAYLOAD_ARENA carries frame bodies.

import test from "node:test";
import assert from "node:assert/strict";
import * as flatbuffers from "flatbuffers";

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

import {
  decodePropagatorState,
  encodeOmmPayload,
  encodePropagatorBatchRequest,
} from "./lib/payloadEncoders.mjs";
import { loadRawSgp4Module } from "./lib/pivInvokeHelper.mjs";

function alignOffset(offset, alignment) {
  if (alignment <= 1) {
    return offset;
  }
  const remainder = offset % alignment;
  return remainder === 0 ? offset : offset + alignment - remainder;
}

function encodePivInvokeRequest({
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

function decodePivEnvelope(bytes) {
  const buffer = new flatbuffers.ByteBuffer(bytes);
  assert.equal(PIV.bufferHasIdentifier(buffer), true);
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

function invokePiv(module, requestBytes) {
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
    const responseBytes = cloneBytes(module, responsePointer, responseSize);
    return decodePivEnvelope(responseBytes);
  } finally {
    if (responsePointer) {
      module._plugin_free(responsePointer, 0);
    }
    module._plugin_free(requestPointer, requestBytes.length);
    module._plugin_free(responseSizePointer, 4);
  }
}

function responseOutputPayload(response, portId) {
  const frame = response.OUTPUTS.find((output) => output.PORT_ID === portId);
  assert.ok(frame, `expected PIV output frame on port ${portId}`);
  return new Uint8Array(
    response.PAYLOAD_ARENA.slice(frame.OFFSET, frame.OFFSET + frame.SIZE),
  );
}

test("SGP4 plugin_invoke_stream accepts SDS PIV request envelopes", async () => {
  const module = await loadRawSgp4Module();
  try {
    const ingestRequest = encodePivInvokeRequest({
      methodId: "ingest_omm",
      inputs: [
        {
          bytes: encodeOmmPayload(),
          portId: "omm",
          schemaName: "orbpro.sds.omm",
          fileIdentifier: "$OMM",
        },
      ],
    });
    assert.equal(
      decodePivEnvelope(ingestRequest).REQUEST.INPUTS[0].PORT_ID,
      "omm",
    );

    const ingestEnvelope = invokePiv(module, ingestRequest);
    assert.equal(ingestEnvelope.RESPONSE.STATUS_CODE, 0);
    assert.equal(module._get_satellite_count(), 1);

    const propagateEnvelope = invokePiv(
      module,
      encodePivInvokeRequest({
        methodId: "propagate_state",
        inputs: [
          {
            bytes: encodePropagatorBatchRequest({
              epoch: 2460310.5,
              entityHandles: [0],
              maxCount: 1,
            }),
            portId: "request",
            schemaName: "orbpro.propagator.PropagatorBatchRequest",
            fileIdentifier: "PROP",
          },
        ],
        outputStreamCap: 1,
      }),
    );

    assert.equal(propagateEnvelope.RESPONSE.STATUS_CODE, 0);
    const stateBytes = responseOutputPayload(
      propagateEnvelope.RESPONSE,
      "state",
    );
    const state = decodePropagatorState(stateBytes);
    assert.equal(state.catalogNumber, 25544);
    assert.equal(state.valid, true);
    assert.ok(Number.isFinite(state.position[0]));
  } finally {
    module._plugin_destroy();
  }
});
