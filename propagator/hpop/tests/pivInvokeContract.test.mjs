// SDS PIV invoke contract for propagator.hpop.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as flatbuffers from "../../../../spacedatastandards.org/node_modules/flatbuffers/mjs/flatbuffers.js";
import {
  bufferMutability,
  bufferOwnership,
  FlatBufferTypeRefT,
  payloadWireFormat,
  PIV,
  PIVResponseT,
  PIVRequestT,
  PIVT,
  pivStatus,
  TABT,
} from "../../../../spacedatastandards.org/lib/js/PIV/main.js";

import {
  encodePivInvokeRequest,
  invokePiv,
  invokePivBytes,
  loadRawHpopModule,
} from "./lib/pivInvokeHelper.mjs";

const REQUEST_FIXTURE_PATH = new URL(
  "./fixtures/request.propagate.json",
  import.meta.url,
);

const textDecoder = new TextDecoder();

function encodePivEnvelope(envelope) {
  const builder = new flatbuffers.Builder(1024);
  PIV.finishPIVBuffer(builder, envelope.pack(builder));
  return builder.asUint8Array();
}

function assertFailedPiv(response, { statusCode, status, errorCode }) {
  assert.equal(response.response.STATUS_CODE, statusCode);
  assert.equal(response.response.STATUS, status);
  assert.equal(response.response.ERROR_CODE, errorCode);
  assert.ok(response.response.ERROR_MESSAGE);
}

test("HPOP plugin_invoke_stream accepts SDS PIV request envelopes", async () => {
  const module = await loadRawHpopModule();
  try {
    module.__initialize?.();
    assert.equal(module._plugin_init(), 0);

    const response = invokePiv(module, {
      methodId: "invoke",
      inputs: [
        {
          portId: "request",
          bytes: await readFile(REQUEST_FIXTURE_PATH),
          schemaName: "orbpro.hpop.InvokeRequest",
          fileIdentifier: null,
        },
      ],
      outputStreamCap: 1,
    });

    assert.equal(response.response.STATUS_CODE, 0);
    assert.equal(response.outputPayloads.length, 1);
    assert.equal(response.outputPayloads[0].portId, "response");

    const payload = JSON.parse(
      textDecoder.decode(response.outputPayloads[0].bytes),
    );
    assert.ok(
      payload.version || payload.epochJD,
      "response must contain version or propagation result",
    );
  } finally {
    module._plugin_destroy?.();
  }
});

test("HPOP plugin_invoke_stream returns SDS PIV errors for invalid PIV envelopes", async () => {
  const module = await loadRawHpopModule();
  try {
    module.__initialize?.();
    assert.equal(module._plugin_init(), 0);

    const responseOnly = invokePivBytes(
      module,
      encodePivEnvelope(new PIVT(null, new PIVResponseT())),
    );
    assertFailedPiv(responseOnly, {
      statusCode: 400,
      status: pivStatus.FAILED,
      errorCode: "invalid-request",
    });

    const prePivBytes = invokePivBytes(module, new Uint8Array([1, 2, 3, 4]));
    assertFailedPiv(prePivBytes, {
      statusCode: 400,
      status: pivStatus.FAILED,
      errorCode: "invalid-request",
    });

    const unknownMethod = invokePiv(module, {
      methodId: "does_not_exist",
      inputs: [],
    });
    assertFailedPiv(unknownMethod, {
      statusCode: 404,
      status: pivStatus.NOT_FOUND,
      errorCode: "unknown-method",
    });

    const missingInput = invokePiv(module, {
      methodId: "invoke",
      inputs: [],
    });
    assertFailedPiv(missingInput, {
      statusCode: 400,
      status: pivStatus.FAILED,
      errorCode: "missing-required-input",
    });

    const invalidFrame = new TABT(
      64,
      8,
      8,
      payloadWireFormat.FLATBUFFER,
      new FlatBufferTypeRefT("orbpro.hpop.InvokeRequest", null, null, null),
      bufferMutability.IMMUTABLE,
      bufferOwnership.HOST_OWNED,
      0n,
    );
    invalidFrame.PORT_ID = "request";
    const badRangeBytes = encodePivEnvelope(
      new PIVT(
        new PIVRequestT("invoke", [invalidFrame], [1, 2, 3, 4], 0n, 1),
        null,
      ),
    );
    const badRange = invokePivBytes(module, badRangeBytes);
    assertFailedPiv(badRange, {
      statusCode: 400,
      status: pivStatus.FAILED,
      errorCode: "invalid-request-frame",
    });

    const validRequest = encodePivInvokeRequest({
      methodId: "invoke",
      inputs: [
        {
          portId: "request",
          bytes: await readFile(REQUEST_FIXTURE_PATH),
        },
      ],
    });
    const validResponse = invokePivBytes(module, validRequest);
    assert.equal(validResponse.response.STATUS_CODE, 0);
    assert.equal(validResponse.response.STATUS, pivStatus.OK);
  } finally {
    module._plugin_destroy?.();
  }
});
