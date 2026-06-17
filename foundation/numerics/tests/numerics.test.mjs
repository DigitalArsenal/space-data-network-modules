import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "../../../../spacedatastandards.org/node_modules/flatbuffers/mjs/flatbuffers.js";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { NUM, NUMT } from "../../../../spacedatastandards.org/lib/js/NUM/NUM.js";
import { NUMGaussMarkovRequestT } from "../../../../spacedatastandards.org/lib/js/NUM/NUMGaussMarkovRequest.js";
import { NUMRootSolveRequestT } from "../../../../spacedatastandards.org/lib/js/NUM/NUMRootSolveRequest.js";
import { NUMScalarInterpolationRequestT } from "../../../../spacedatastandards.org/lib/js/NUM/NUMScalarInterpolationRequest.js";
import { NUMVectorDiscretizeRequestT } from "../../../../spacedatastandards.org/lib/js/NUM/NUMVectorDiscretizeRequest.js";
import { NUMVectorSaturateRequestT } from "../../../../spacedatastandards.org/lib/js/NUM/NUMVectorSaturateRequest.js";
import { numDiscretizeRoundDirection } from "../../../../spacedatastandards.org/lib/js/NUM/numDiscretizeRoundDirection.js";
import { numFunctionCode } from "../../../../spacedatastandards.org/lib/js/NUM/numFunctionCode.js";
import { numOperationCode } from "../../../../spacedatastandards.org/lib/js/NUM/numOperationCode.js";
import { numResultStatus } from "../../../../spacedatastandards.org/lib/js/NUM/numResultStatus.js";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function encodeRequest({
  operation = numOperationCode.NEWTON_RAPHSON,
  functionCode = numFunctionCode.QUADRATIC_MINUS_CONSTANT,
  initialEstimate = 3,
  targetValue = 4,
  accuracy = 1e-10,
  maxIterations = 50,
  traceId = "basilisk-avs-NewtonRaphson",
} = {}) {
  const builder = new flatbuffers.Builder(1024);
  const request = new NUMRootSolveRequestT(
    operation,
    functionCode,
    initialEstimate,
    targetValue,
    accuracy,
    maxIterations,
    traceId,
  );
  const root = new NUMT(request, null).pack(builder);
  NUM.finishNUMBuffer(builder, root);
  return builder.asUint8Array();
}

function encodeVectorSaturateRequest({
  state = [-555.0, 1.27, 5000000.0],
  lowerBounds = [-400.0, 5.0, -1.0],
  upperBounds = [0.0, 10.0, 5000001.0],
  traceId = "basilisk-saturate-testSaturate",
} = {}) {
  const builder = new flatbuffers.Builder(1024);
  const request = new NUMVectorSaturateRequestT(
    state,
    lowerBounds,
    upperBounds,
    traceId,
  );
  const root = new NUMT(null, null, request, null).pack(builder);
  NUM.finishNUMBuffer(builder, root);
  return builder.asUint8Array();
}

function encodeVectorDiscretizeRequest({
  state = [0.1, 10.1, 11.1],
  lsb = [10.0, 10.0, 10.0],
  roundDirection = numDiscretizeRoundDirection.TO_ZERO,
  carryError = false,
  previousError = [],
  traceId = "basilisk-discretize-testRoundToZero",
} = {}) {
  const builder = new flatbuffers.Builder(1024);
  const request = new NUMVectorDiscretizeRequestT(
    state,
    lsb,
    roundDirection,
    carryError,
    previousError,
    traceId,
  );
  const root = new NUMT(null, null, null, null, request, null).pack(builder);
  NUM.finishNUMBuffer(builder, root);
  return builder.asUint8Array();
}

function encodeScalarInterpolationRequest({
  operation = numOperationCode.LINEAR_INTERPOLATION,
  x1 = 2.0,
  x2 = 8.0,
  y1 = 0.0,
  y2 = 0.0,
  value1 = 10.0,
  value2 = 22.0,
  z11 = 0.0,
  z12 = 0.0,
  z21 = 0.0,
  z22 = 0.0,
  interpolationX = 5.0,
  interpolationY = 0.0,
  traceId = "basilisk-linearInterpolation-HandlesNormalInputs",
} = {}) {
  const builder = new flatbuffers.Builder(1024);
  const request = new NUMScalarInterpolationRequestT(
    operation,
    x1,
    x2,
    y1,
    y2,
    value1,
    value2,
    z11,
    z12,
    z21,
    z22,
    interpolationX,
    interpolationY,
    traceId,
  );
  const root = new NUMT(null, null, null, null, null, null, request, null).pack(builder);
  NUM.finishNUMBuffer(builder, root);
  return builder.asUint8Array();
}

function encodeGaussMarkovRequest({
  operation = numOperationCode.GAUSS_MARKOV_SEQUENCE,
  dimension = 2,
  sampleCount = 100000,
  warmupCount = 0,
  rngSeed = 1000,
  propagationMatrix = [0.0, 0.0, 0.0, 0.0],
  noiseMatrix = [1.0, 0.0, 0.0, 1.0],
  stateBounds = [-1.0, -1.0],
  emitSamples = false,
  traceId = "basilisk-gaussMarkov-gaussianOnlyMode",
} = {}) {
  const builder = new flatbuffers.Builder(1024);
  const request = new NUMGaussMarkovRequestT(
    operation,
    dimension,
    sampleCount,
    warmupCount,
    rngSeed,
    propagationMatrix,
    noiseMatrix,
    stateBounds,
    emitSamples,
    traceId,
  );
  const root = new NUMT(null, null, null, null, null, null, null, null, request, null).pack(builder);
  NUM.finishNUMBuffer(builder, root);
  return builder.asUint8Array();
}

async function invokeNumerics(harness, payload) {
  return harness.invoke({
    methodId: "solve_scalar_root",
    inputs: [
      {
        portId: "request",
        typeRef: {
          schemaName: "NUM.fbs",
          fileIdentifier: "$NUM",
          rootTypeName: "NUM",
        },
        payload,
      },
    ],
  });
}

async function invokeVectorSaturate(harness, payload) {
  return harness.invoke({
    methodId: "saturate_vector",
    inputs: [
      {
        portId: "request",
        typeRef: {
          schemaName: "NUM.fbs",
          fileIdentifier: "$NUM",
          rootTypeName: "NUM",
        },
        payload,
      },
    ],
  });
}

async function invokeVectorDiscretize(harness, payload) {
  return harness.invoke({
    methodId: "discretize_vector",
    inputs: [
      {
        portId: "request",
        typeRef: {
          schemaName: "NUM.fbs",
          fileIdentifier: "$NUM",
          rootTypeName: "NUM",
        },
        payload,
      },
    ],
  });
}

async function invokeScalarInterpolation(harness, payload) {
  return harness.invoke({
    methodId: "interpolate_scalar",
    inputs: [
      {
        portId: "request",
        typeRef: {
          schemaName: "NUM.fbs",
          fileIdentifier: "$NUM",
          rootTypeName: "NUM",
        },
        payload,
      },
    ],
  });
}

async function invokeGaussMarkov(harness, payload) {
  return harness.invoke({
    methodId: "compute_gauss_markov_sequence",
    inputs: [
      {
        portId: "request",
        typeRef: {
          schemaName: "NUM.fbs",
          fileIdentifier: "$NUM",
          rootTypeName: "NUM",
        },
        payload,
      },
    ],
  });
}

function decodeResult(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "result");
  assert.equal(frame.typeRef?.schemaName, "NUM.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, "$NUM");
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  assert.equal(NUM.bufferHasIdentifier(bb), true);
  const envelope = NUM.getRootAsNUM(bb);
  const result = envelope.ROOT_SOLVE_RESULT();
  assert.ok(result, "missing NUM.ROOT_SOLVE_RESULT");
  assert.equal(result.STATUS(), numResultStatus.OK, result.ERROR_MESSAGE());
  return result;
}

function decodeVectorSaturateResult(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "result");
  assert.equal(frame.typeRef?.schemaName, "NUM.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, "$NUM");
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  assert.equal(NUM.bufferHasIdentifier(bb), true);
  const envelope = NUM.getRootAsNUM(bb);
  const result = envelope.VECTOR_SATURATE_RESULT();
  assert.ok(result, "missing NUM.VECTOR_SATURATE_RESULT");
  assert.equal(result.STATUS(), numResultStatus.OK, result.ERROR_MESSAGE());
  return result;
}

function decodeVectorDiscretizeResult(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "result");
  assert.equal(frame.typeRef?.schemaName, "NUM.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, "$NUM");
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  assert.equal(NUM.bufferHasIdentifier(bb), true);
  const envelope = NUM.getRootAsNUM(bb);
  const result = envelope.VECTOR_DISCRETIZE_RESULT();
  assert.ok(result, "missing NUM.VECTOR_DISCRETIZE_RESULT");
  assert.equal(result.STATUS(), numResultStatus.OK, result.ERROR_MESSAGE());
  return result;
}

function decodeScalarInterpolationResult(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "result");
  assert.equal(frame.typeRef?.schemaName, "NUM.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, "$NUM");
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  assert.equal(NUM.bufferHasIdentifier(bb), true);
  const envelope = NUM.getRootAsNUM(bb);
  const result = envelope.SCALAR_INTERPOLATION_RESULT();
  assert.ok(result, "missing NUM.SCALAR_INTERPOLATION_RESULT");
  assert.equal(result.STATUS(), numResultStatus.OK, result.ERROR_MESSAGE());
  return result;
}

function decodeGaussMarkovResult(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "result");
  assert.equal(frame.typeRef?.schemaName, "NUM.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, "$NUM");
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  assert.equal(NUM.bufferHasIdentifier(bb), true);
  const envelope = NUM.getRootAsNUM(bb);
  const result = envelope.GAUSS_MARKOV_RESULT();
  assert.ok(result, "missing NUM.GAUSS_MARKOV_RESULT");
  assert.equal(result.STATUS(), numResultStatus.OK, result.ERROR_MESSAGE());
  return result;
}

function assertNear(actual, expected, tolerance, label) {
  const delta = Math.abs(actual - expected);
  assert.ok(delta <= tolerance, `${label} delta ${delta} exceeds ${tolerance}; actual=${actual}, expected=${expected}`);
}

function assertVector(result, getter, lengthGetter, expected, tolerance, label) {
  assert.equal(result[lengthGetter](), expected.length, `${label} length`);
  for (const [index, value] of expected.entries()) {
    assertNear(result[getter](index), value, tolerance, `${label} ${index}`);
  }
}

async function withHarness(t, callback) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  await callback(harness);
}

test("build publishes canonical isomorphic artifact path", () => {
  assert.equal(fs.existsSync(fileURLToPath(ISOMORPHIC_WASM_PATH)), true);
});

test("manifest exposes Gauss-Markov sequence method", () => {
  const methodIds = readManifest().methods.map((method) => method.methodId);
  assert.ok(methodIds.includes("compute_gauss_markov_sequence"));
});

test("built artifact passes SDK compliance checks", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("built artifact exposes the standalone isomorphic surface", async () => {
  const inspection = await inspectModule(fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)));
  const importedModuleNames = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(importedModuleNames, ["wasi_snapshot_preview1"]);
  for (const required of [
    "_start",
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

// Authoritative numerical source:
// Basilisk `src/architecture/utilities/tests/test_avsEigenSupport.cpp`
// solves f(x) = x*x - 4 from x0 = 3.0 with 1e-10 accuracy.
test("matches Basilisk avsEigenSupport NewtonRaphson scalar root", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(await invokeNumerics(harness, encodeRequest()));
    assertNear(result.ROOT(), 2.0, 1e-10, "ROOT");
    assert.ok(Math.abs(result.RESIDUAL()) <= 1e-10, `residual ${result.RESIDUAL()} exceeds 1e-10`);
    assert.ok(result.ITERATIONS() > 0, "expected at least one Newton-Raphson iteration");
  });
});

// Authoritative numerical source:
// Basilisk `src/architecture/utilities/tests/test_saturate.cpp` `Saturate.testSaturate`
// clamps [-555, 1.27, 5000000] by per-component bounds
// [[-400, 0], [5, 10], [-1, 5000001]] and expects [-400, 5, 5000000].
// Values are unitless numerical utility inputs; equality is exact for this
// source vector, with zero tolerance represented by 0.0 below.
test("matches Basilisk Saturate.testSaturate vector clamp", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeVectorSaturateResult(
      await invokeVectorSaturate(harness, encodeVectorSaturateRequest()),
    );
    assert.equal(result.saturatedStateLength(), 3);
    assertNear(result.SATURATED_STATE(0), -400.0, 0.0, "saturated state 0");
    assertNear(result.SATURATED_STATE(1), 5.0, 0.0, "saturated state 1");
    assertNear(result.SATURATED_STATE(2), 5000000.0, 0.0, "saturated state 2");
    assert.equal(result.TRACE_ID(), "basilisk-saturate-testSaturate");
  });
});

// Authoritative numerical source:
// Basilisk `src/architecture/utilities/tests/test_discretize.cpp`
// `Discretize.testRoundToZero`, `testRoundFromZero`, and `testRoundNear`
// quantize 3-vectors using LSB [10, 10, 10] with exact integer outputs.
// Values are unitless numerical utility inputs; equality is exact for these
// source vectors, with zero tolerance represented by 0.0 below.
test("matches Basilisk Discretize no-carry vector rounding modes", async (t) => {
  await withHarness(t, async (harness) => {
    const cases = [
      {
        traceId: "basilisk-discretize-testRoundToZero",
        roundDirection: numDiscretizeRoundDirection.TO_ZERO,
        state: [0.1, 10.1, 11.1],
        expected: [0.0, 10.0, 10.0],
      },
      {
        traceId: "basilisk-discretize-testRoundFromZero",
        roundDirection: numDiscretizeRoundDirection.FROM_ZERO,
        state: [0.1, 10.1, 11.1],
        expected: [10.0, 20.0, 20.0],
      },
      {
        traceId: "basilisk-discretize-testRoundNear",
        roundDirection: numDiscretizeRoundDirection.NEAR,
        state: [0.1, 10.1, 15.1],
        expected: [0.0, 10.0, 20.0],
      },
    ];

    for (const testCase of cases) {
      const result = decodeVectorDiscretizeResult(
        await invokeVectorDiscretize(harness, encodeVectorDiscretizeRequest(testCase)),
      );
      assertVector(result, "DISCRETIZED_STATE", "discretizedStateLength", testCase.expected, 0.0, testCase.traceId);
      assert.equal(result.TRACE_ID(), testCase.traceId);
    }
  });
});

// Authoritative numerical source:
// Basilisk `src/architecture/utilities/tests/test_discretize.cpp`
// `Discretize.testRoundToZeroCarryError` emits [0, 10, 10] on the first call,
// carries error [0.1, 0.1, 5], then emits [0, 10, 20] on the second call.
test("matches Basilisk Discretize carry-error vector rounding", async (t) => {
  await withHarness(t, async (harness) => {
    const first = decodeVectorDiscretizeResult(
      await invokeVectorDiscretize(
        harness,
        encodeVectorDiscretizeRequest({
          state: [0.1, 10.1, 15.0],
          roundDirection: numDiscretizeRoundDirection.TO_ZERO,
          carryError: true,
          traceId: "basilisk-discretize-testRoundToZeroCarryError-first",
        }),
      ),
    );
    assertVector(first, "DISCRETIZED_STATE", "discretizedStateLength", [0.0, 10.0, 10.0], 0.0, "first output");
    assertVector(first, "DISCRETIZATION_ERROR", "discretizationErrorLength", [0.1, 0.1, 5.0], 1e-12, "first error");

    const second = decodeVectorDiscretizeResult(
      await invokeVectorDiscretize(
        harness,
        encodeVectorDiscretizeRequest({
          state: [0.1, 10.1, 15.0],
          roundDirection: numDiscretizeRoundDirection.TO_ZERO,
          carryError: true,
          previousError: [
            first.DISCRETIZATION_ERROR(0),
            first.DISCRETIZATION_ERROR(1),
            first.DISCRETIZATION_ERROR(2),
          ],
          traceId: "basilisk-discretize-testRoundToZeroCarryError-second",
        }),
      ),
    );
    assertVector(second, "DISCRETIZED_STATE", "discretizedStateLength", [0.0, 10.0, 20.0], 0.0, "second output");
    assert.equal(second.TRACE_ID(), "basilisk-discretize-testRoundToZeroCarryError-second");
  });
});

// Authoritative numerical source:
// Basilisk `src/architecture/utilities/tests/test_linearInterpolation.cpp`
// computes y = y1 * (x2 - x) / (x2 - x1) + y2 * (x - x1) / (x2 - x1).
// The upstream test uses random samples, so this deterministic vector fixes
// the same source formula at x1=2, x2=8, y1=10, y2=22, x=5 -> y=16.
test("matches Basilisk linearInterpolation source formula", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeScalarInterpolationResult(
      await invokeScalarInterpolation(harness, encodeScalarInterpolationRequest()),
    );
    assertNear(result.VALUE(), 16.0, 0.0, "linear interpolation value");
    assert.equal(result.TRACE_ID(), "basilisk-linearInterpolation-HandlesNormalInputs");
  });
});

// Authoritative numerical source:
// Basilisk `src/architecture/utilities/tests/test_bilinearInterpolation.cpp`
// computes z from the four rectangular corner values using the bilinear
// weighted-area formula. The upstream test uses random samples, so this
// deterministic vector fixes the same formula at x=0.5, y=11 -> z=4.
test("matches Basilisk bilinearInterpolation source formula", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeScalarInterpolationResult(
      await invokeScalarInterpolation(
        harness,
        encodeScalarInterpolationRequest({
          operation: numOperationCode.BILINEAR_INTERPOLATION,
          x1: 0.0,
          x2: 2.0,
          y1: 10.0,
          y2: 14.0,
          value1: 0.0,
          value2: 0.0,
          z11: 1.0,
          z12: 9.0,
          z21: 5.0,
          z22: 13.0,
          interpolationX: 0.5,
          interpolationY: 11.0,
          traceId: "basilisk-bilinearInterpolation-HandlesNormalInputs",
        }),
      ),
    );
    assertNear(result.VALUE(), 4.0, 0.0, "bilinear interpolation value");
    assert.equal(result.TRACE_ID(), "basilisk-bilinearInterpolation-HandlesNormalInputs");
  });
});

// Authoritative numerical source:
// Basilisk `src/architecture/utilities/tests/test_gaussMarkov.cpp`
// `GaussMarkov.stdDeviationIsExpected` seeds `std::minstd_rand` with 1000,
// warms up 5000 states, and checks the AR(1) steady-state standard deviation
// for propagation diag(0.9) and noise diag(sqrt(0.19)).
test("matches Basilisk GaussMarkov steady-state standard deviation", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeGaussMarkovResult(
      await invokeGaussMarkov(
        harness,
        encodeGaussMarkovRequest({
          propagationMatrix: [0.9, 0.0, 0.0, 0.9],
          noiseMatrix: [Math.sqrt(0.19), 0.0, 0.0, Math.sqrt(0.19)],
          stateBounds: [100.0, 100.0],
          warmupCount: 5000,
          traceId: "basilisk-gaussMarkov-stdDeviationIsExpected",
        }),
      ),
    );
    assert.equal(result.standardDeviationLength(), 2);
    assertNear(result.STANDARD_DEVIATION(0), 1.0, 0.1, "standard deviation 0");
    assertNear(result.STANDARD_DEVIATION(1), 1.0, 0.1, "standard deviation 1");
    assert.equal(result.samplesLength(), 0);
    assert.equal(result.TRACE_ID(), "basilisk-gaussMarkov-stdDeviationIsExpected");
  });
});

// Authoritative numerical source:
// Basilisk `src/architecture/utilities/tests/test_gaussMarkov.cpp`
// `GaussMarkov.gaussianOnlyMode` uses zero propagation, identity noise,
// disabled bounds, and checks standard-normal mean and standard deviation.
test("matches Basilisk GaussMarkov gaussian-only statistics", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeGaussMarkovResult(
      await invokeGaussMarkov(harness, encodeGaussMarkovRequest()),
    );
    assert.equal(result.meanLength(), 2);
    assert.equal(result.standardDeviationLength(), 2);
    assertNear(result.MEAN(0), 0.0, 0.1, "mean 0");
    assertNear(result.MEAN(1), 0.0, 0.1, "mean 1");
    assertNear(result.STANDARD_DEVIATION(0), 1.0, 0.1, "standard deviation 0");
    assertNear(result.STANDARD_DEVIATION(1), 1.0, 0.1, "standard deviation 1");
    assert.equal(result.TRACE_ID(), "basilisk-gaussMarkov-gaussianOnlyMode");
  });
});

// Authoritative numerical source:
// Basilisk `src/architecture/utilities/tests/test_gaussMarkov.cpp`
// `GaussMarkov.meanIsZero` uses identity propagation, identity noise,
// 1e-15 bounds, 1000 warmup samples, and checks mean inside 4/sqrt(numPts).
test("matches Basilisk GaussMarkov tiny-bounds zero-mean case", async (t) => {
  await withHarness(t, async (harness) => {
    const sampleCount = 100000;
    const result = decodeGaussMarkovResult(
      await invokeGaussMarkov(
        harness,
        encodeGaussMarkovRequest({
          sampleCount,
          warmupCount: 1000,
          propagationMatrix: [1.0, 0.0, 0.0, 1.0],
          noiseMatrix: [1.0, 0.0, 0.0, 1.0],
          stateBounds: [1e-15, 1e-15],
          traceId: "basilisk-gaussMarkov-meanIsZero",
        }),
      ),
    );
    const tolerance = 4.0 / Math.sqrt(sampleCount);
    assert.ok(Math.abs(result.MEAN(0)) < tolerance, `mean 0 ${result.MEAN(0)} exceeds ${tolerance}`);
    assert.ok(Math.abs(result.MEAN(1)) < tolerance, `mean 1 ${result.MEAN(1)} exceeds ${tolerance}`);
    assert.equal(result.TRACE_ID(), "basilisk-gaussMarkov-meanIsZero");
  });
});

// Authoritative numerical source:
// Basilisk `src/architecture/utilities/tests/test_gaussMarkov.cpp`
// `GaussMarkov.boundsAreRespected` uses positive state bounds, and
// `gauss_markov.cpp` clamps any state exceeding the symmetric bound.
test("matches Basilisk GaussMarkov symmetric bound clamp semantics", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeGaussMarkovResult(
      await invokeGaussMarkov(
        harness,
        encodeGaussMarkovRequest({
          sampleCount: 25000,
          rngSeed: 1500,
          propagationMatrix: [1.0, 0.0, 0.0, 1.0],
          noiseMatrix: [0.5, 0.0, 0.0, 0.005],
          stateBounds: [10.0, 0.1],
          traceId: "basilisk-gaussMarkov-boundsAreRespected",
        }),
      ),
    );
    assert.ok(result.MAXIMUM(0) <= 10.0, `maximum 0 ${result.MAXIMUM(0)} exceeded bound`);
    assert.ok(result.MAXIMUM(1) <= 0.1, `maximum 1 ${result.MAXIMUM(1)} exceeded bound`);
    assert.ok(result.MINIMUM(0) >= -10.0, `minimum 0 ${result.MINIMUM(0)} exceeded bound`);
    assert.ok(result.MINIMUM(1) >= -0.1, `minimum 1 ${result.MINIMUM(1)} exceeded bound`);
    assert.equal(result.TRACE_ID(), "basilisk-gaussMarkov-boundsAreRespected");
  });
});
