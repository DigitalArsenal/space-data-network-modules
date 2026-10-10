// Objects named by NORAD catalog number (propagate_state 1.2.0).
//
// Entity handles follow ingestion order: after ingesting A and then B, handle
// 0 is A. A caller that asked for "handle 0" meaning B got A's state, with
// nothing in the answer to say so. A request may now name its objects by
// catalog number: each is resolved by that number, an unknown number refuses
// the request, and handles given alongside must hold the same objects.
//
// Reference: each object's state propagated alone in a fresh module (its own
// handle 0), which is the answer the caller meant. Equality is exact: the
// same element set, SGP4 code and epoch give the same doubles.
import test from "node:test";
import assert from "node:assert/strict";

import { invokePiv, loadRawSgp4Module } from "./lib/pivInvokeHelper.mjs";
import {
  decodePropagatorState,
  encodeOmmPayload,
  encodePropagatorBatchRequest,
  encodeSizePrefixedStream,
} from "./lib/payloadEncoders.mjs";

const OMM_TYPE = { schemaName: "orbpro.sds.omm", fileIdentifier: "$OMM", rootTypeName: "OMM" };
const PROP_TYPE = { schemaName: "orbpro.propagator.PropagatorBatchRequest", fileIdentifier: "PROP", rootTypeName: "PropagatorBatchRequest" };
const EPOCH = 2460310.75;  // 2024-01-01T06:00:00 UTC, six hours after both sets

// A: the ISS fixture. B: a sun-synchronous LEO with different elements.
const A = { noradId: 25544 };
const B = {
  noradId: 43013, objectName: "NOAA 20", objectId: "2017-073A", epoch: "2024-01-01T00:00:00",
  meanMotion: 14.19545214, eccentricity: 0.0001397, inclination: 98.7302, raan: 51.2511,
  argPericenter: 92.7364, meanAnomaly: 267.3994, bstar: 0.000036, meanMotionDot: 0.00000044,
};

function ingest(module, payload) {
  const result = invokePiv(module, { methodId: "ingest_omm", inputs: [{ portId: "omm", payload, typeRef: OMM_TYPE }] });
  assert.equal(result.response.STATUS_CODE, 0, result.response.ERROR_MESSAGE);
}

function propagate(module, request, outputStreamCap = 4) {
  return invokePiv(module, {
    methodId: "propagate_state",
    inputs: [{ portId: "request", payload: encodePropagatorBatchRequest({ epoch: EPOCH, ...request }), typeRef: PROP_TYPE }],
    outputStreamCap,
  });
}

// The object's state from a module that holds only it.
async function alone(fields) {
  const module = await loadRawSgp4Module();
  try {
    ingest(module, encodeOmmPayload(fields));
    const result = propagate(module, { entityHandles: [0], maxCount: 1 });
    assert.equal(result.response.STATUS_CODE, 0);
    return decodePropagatorState(result.outputPayloads[0].bytes);
  } finally {
    module._plugin_destroy();
  }
}

function assertSameState(actual, expected, label) {
  assert.equal(actual.catalogNumber, expected.catalogNumber, `${label}: catalog number`);
  assert.equal(actual.valid, true, `${label}: valid`);
  assert.deepEqual(actual.position, expected.position, `${label}: position`);
  assert.deepEqual(actual.velocity, expected.velocity, `${label}: velocity`);
}

test("catalog_numbers answers the named object after A then B are ingested separately", async () => {
  const [stateA, stateB] = [await alone(A), await alone(B)];
  const module = await loadRawSgp4Module();
  try {
    ingest(module, encodeOmmPayload(A));
    ingest(module, encodeOmmPayload(B));

    // The 1.1.0 trap, unchanged: handle 0 is A, whatever the caller meant.
    const byHandle = propagate(module, { entityHandles: [0], maxCount: 1 });
    assertSameState(decodePropagatorState(byHandle.outputPayloads[0].bytes), stateA, "handle 0");

    const byNumber = propagate(module, { catalogNumbers: [B.noradId] });
    assert.equal(byNumber.response.STATUS_CODE, 0, byNumber.response.ERROR_MESSAGE);
    assert.equal(byNumber.outputPayloads.length, 1);
    assertSameState(decodePropagatorState(byNumber.outputPayloads[0].bytes), stateB, "catalog B");

    const both = propagate(module, { catalogNumbers: [B.noradId, A.noradId] });
    assertSameState(decodePropagatorState(both.outputPayloads[0].bytes), stateB, "catalog [B, A] first");
    assertSameState(decodePropagatorState(both.outputPayloads[1].bytes), stateA, "catalog [B, A] second");

    // Handle 0 offered as B is refused, not answered with A.
    const mismatch = propagate(module, { entityHandles: [0], catalogNumbers: [B.noradId] });
    assert.equal(mismatch.response.STATUS_CODE, 400);
    assert.equal(mismatch.response.ERROR_CODE, "handle-mismatch");
    assert.match(mismatch.response.ERROR_MESSAGE, /handle 0 is NORAD 25544, not 43013/);
    assert.equal(mismatch.outputPayloads.length, 0);

    const matched = propagate(module, { entityHandles: [1], catalogNumbers: [B.noradId] });
    assertSameState(decodePropagatorState(matched.outputPayloads[0].bytes), stateB, "handle 1 + catalog B");

    const unknown = propagate(module, { catalogNumbers: [99999] });
    assert.equal(unknown.response.STATUS_CODE, 400);
    assert.equal(unknown.response.ERROR_CODE, "unknown-object");
    assert.equal(unknown.outputPayloads.length, 0);
  } finally {
    module._plugin_destroy();
  }
});

test("catalog_numbers answers the named object when one stream carries B before A", async () => {
  const [stateA, stateB] = [await alone(A), await alone(B)];
  const module = await loadRawSgp4Module();
  try {
    ingest(module, encodeSizePrefixedStream([encodeOmmPayload(B), encodeOmmPayload(A)]));
    // Handle 0 is now B: the order of the stream, not of the caller's list.
    const byHandle = propagate(module, { entityHandles: [0], maxCount: 1 });
    assertSameState(decodePropagatorState(byHandle.outputPayloads[0].bytes), stateB, "handle 0 (stream order)");

    for (const [fields, state] of [[A, stateA], [B, stateB]]) {
      const result = propagate(module, { catalogNumbers: [fields.noradId] });
      assert.equal(result.response.STATUS_CODE, 0, result.response.ERROR_MESSAGE);
      assertSameState(decodePropagatorState(result.outputPayloads[0].bytes), state, `catalog ${fields.noradId}`);
    }
    const mismatch = propagate(module, { entityHandles: [0], catalogNumbers: [A.noradId] });
    assert.equal(mismatch.response.ERROR_CODE, "handle-mismatch");
  } finally {
    module._plugin_destroy();
  }
});

// A command runtime starts every invocation empty: one invocation can carry
// its element sets on the omm port and name its objects.
test("one invocation carries its element sets and names its object", async () => {
  const [stateB] = [await alone(B)];
  const module = await loadRawSgp4Module();
  try {
    const result = invokePiv(module, {
      methodId: "propagate_state",
      outputStreamCap: 1,
      inputs: [
        { portId: "request", payload: encodePropagatorBatchRequest({ epoch: EPOCH, catalogNumbers: [B.noradId] }), typeRef: PROP_TYPE },
        { portId: "omm", payload: encodeSizePrefixedStream([encodeOmmPayload(A), encodeOmmPayload(B)]), typeRef: OMM_TYPE },
      ],
    });
    assert.equal(result.response.STATUS_CODE, 0, result.response.ERROR_MESSAGE);
    assert.equal(result.outputPayloads.length, 1);
    assertSameState(decodePropagatorState(result.outputPayloads[0].bytes), stateB, "one-shot catalog B");
  } finally {
    module._plugin_destroy();
  }
});
