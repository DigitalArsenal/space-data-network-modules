import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { FlatcRunner } from "flatc-wasm";
import { publishedSchema, encodeCqr, decodeCqr, catalogRequest, catalogInReferenceUnits, sdnLengthPrefixed } from "./lib/cqr.mjs";

import {
  conjunctionArtifactExists,
  createConjunctionCommandHarness,
} from "./lib/conjunctionCommandHarness.mjs";
import { buildThreadedWasmEdgeRunner } from "./lib/wasmedgePthreadRunner.mjs";

const ommSchema = () => publishedSchema('OMM');

function createOmmRecord(flatc, noradCatId, options = {}) {
  const record = flatc.generateBinary(
    ommSchema(),
    JSON.stringify({
      CENTER_NAME: "EARTH",
      REFERENCE_FRAME: { REFERENCE_FRAME_type: "CelestialFrameWrapper", REFERENCE_FRAME: { frame: "TEMEOFDATE" } },
      TIME_SYSTEM: "UTC",
      OBJECT_NAME: `TEST-${noradCatId}`,
      OBJECT_ID: `2026-001${noradCatId}`,
      EPOCH: "2026-03-09T00:00:00.000000",
      MEAN_MOTION: options.meanMotion ?? 15.1,
      ECCENTRICITY: options.eccentricity ?? 0.001,
      INCLINATION: options.inclination ?? 53.0,
      RA_OF_ASC_NODE: options.raOfAscNode ?? 1.0,
      ARG_OF_PERICENTER: options.argOfPericenter ?? 2.0,
      MEAN_ANOMALY: options.meanAnomaly ?? 3.0,
      EPHEMERIS_TYPE: "SGP4",
      CLASSIFICATION_TYPE: "U",
      NORAD_CAT_ID: noradCatId,
      ELEMENT_SET_NO: 1,
      REV_AT_EPOCH: 1,
      BSTAR: 0.0,
      MEAN_MOTION_DOT: 0.0,
      MEAN_MOTION_DDOT: 0.0,
    }),
    { sizePrefix: false },
  );
  return options.sizePrefix === true ? sdnLengthPrefixed(record) : record;
}

function createScreenCatalogRequest(flatc, overrides = {}) {
  return encodeCqr(flatc, catalogRequest({
      selectedSources: [
        {
          sourceKind: "OMM",
          sourceId: "celestrak-full-catalog",
          providerId: "celestrak.eth",
          schemaName: "OMM/main.fbs",
          fileIdentifier: "$OMM",
        },
      ],
      startJd: 2461108.5,
      durationDays: 1 / 864001,
      thresholdKm: 15.0,
      numThreads: 1,
      coarseStepSec: 300.0,
      fineTolSec: 0.01,
      combinedRadiusM: 10.0,
      ...overrides,
    }),
  );
}

function encodeUint32beFramedStream(records) {
  const totalLength = records.reduce((sum, record) => sum + 4 + record.length, 0);
  const stream = new Uint8Array(totalLength);
  const view = new DataView(stream.buffer);
  let offset = 0;
  for (const record of records) {
    view.setUint32(offset, record.length, false);
    offset += 4;
    stream.set(record, offset);
    offset += record.length;
  }
  return stream;
}

// SDN API framing is a host concern. CQR's catalog port receives one verified
// unprefixed OMM record per PIV frame, preserving reception order.
function catalogFrames(stream) {
  const frames = [];
  for (let at = 0; at < stream.length;) {
    const size = new DataView(stream.buffer, stream.byteOffset).getUint32(at, false); at += 4;
    let payload = stream.subarray(at, at + size); at += size;
    if (String.fromCharCode(...payload.subarray(8,12)) === '$OMM') payload = payload.subarray(4);
    frames.push({ portId: 'catalog', payload });
  }
  return frames;
}

async function invokeWithTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("screen_catalog accepts SDN data API uint32be OMM FlatBuffer streams", async (t) => {
  if (!conjunctionArtifactExists()) {
    t.skip("Build conjunction-assessment before running the SDN stream adapter test.");
    return;
  }
  const runnerBinary = await buildThreadedWasmEdgeRunner(
    t,
    "conjunction-sdn-stream-runner-",
  );
  if (!runnerBinary) {
    return;
  }

  const flatc = await FlatcRunner.init();
  const requestPayload = createScreenCatalogRequest(flatc);
  const catalogPayload = encodeUint32beFramedStream([
    createOmmRecord(flatc, 90001),
    createOmmRecord(flatc, 90002),
  ]);
  const harness = await createConjunctionCommandHarness({
    wasmEdgeRunnerBinary: runnerBinary,
  });
  t.after(async () => {
    await harness.destroy();
  });

  const response = await invokeWithTimeout(
    harness.invoke({
      methodId: "screen_catalog",
      inputs: [
        { portId: "request", payload: requestPayload },
        ...catalogFrames(catalogPayload),
      ],
    }),
    10000,
    "screen_catalog SDN data API OMM stream invoke",
  );

  assert.equal(response.statusCode, 0, response.errorMessage);
  const result = response.outputs?.find((frame) => frame.portId === "result");
  assert.ok(result?.payload instanceof Uint8Array, "result payload is emitted");
  assert.ok(result.payload.byteLength > 0, "result payload is non-empty");
});

test("screen_catalog accepts SDN data API uint32be streams of size-prefixed OMM records", async (t) => {
  if (!conjunctionArtifactExists()) {
    t.skip("Build conjunction-assessment before running the SDN stream adapter test.");
    return;
  }
  const runnerBinary = await buildThreadedWasmEdgeRunner(
    t,
    "conjunction-sdn-size-prefixed-stream-runner-",
  );
  if (!runnerBinary) {
    return;
  }

  const flatc = await FlatcRunner.init();
  const requestPayload = createScreenCatalogRequest(flatc);
  const catalogPayload = encodeUint32beFramedStream([
    createOmmRecord(flatc, 91001, { sizePrefix: true }),
    createOmmRecord(flatc, 91002, { sizePrefix: true }),
  ]);
  const harness = await createConjunctionCommandHarness({
    wasmEdgeRunnerBinary: runnerBinary,
  });
  t.after(async () => {
    await harness.destroy();
  });

  const response = await invokeWithTimeout(
    harness.invoke({
      methodId: "screen_catalog",
      inputs: [
        { portId: "request", payload: requestPayload },
        ...catalogFrames(catalogPayload),
      ],
    }),
    10000,
    "screen_catalog size-prefixed SDN data API OMM stream invoke",
  );

  assert.equal(response.statusCode, 0, response.errorMessage);
  const result = response.outputs?.find((frame) => frame.portId === "result");
  assert.ok(result?.payload instanceof Uint8Array, "result payload is emitted");
  assert.ok(result.payload.byteLength > 0, "result payload is non-empty");
});

test(
  "screen_catalog keeps direct SDN catalog screening bounded for larger streams",
  { timeout: 120000 },
  async (t) => {
    if (!conjunctionArtifactExists()) {
      t.skip("Build conjunction-assessment before running the SDN stream adapter test.");
      return;
    }
    const runnerBinary = await buildThreadedWasmEdgeRunner(
      t,
      "conjunction-sdn-bounded-stream-runner-",
    );
    if (!runnerBinary) {
      return;
    }

    const flatc = await FlatcRunner.init();
    const requestPayload = createScreenCatalogRequest(flatc, {
      durationDays: 1 / 86400,
      coarseStepSec: 600.0,
      numThreads: 1,
      usePerigeeFilter: false,
    });
    const records = Array.from({ length: 1200 }, (_, index) =>
      createOmmRecord(flatc, 92000 + index, {
        sizePrefix: true,
        meanMotion: 14.0 + (index % 40) * 0.02,
        inclination: 20.0 + (index % 80) * 0.25,
        meanAnomaly: index % 360,
      }),
    );
    const catalogPayload = encodeUint32beFramedStream(records);
    const harness = await createConjunctionCommandHarness({
      wasmEdgeRunnerBinary: runnerBinary,
    });
    t.after(async () => {
      await harness.destroy();
    });

    const response = await harness.invoke({
      methodId: "screen_catalog",
      inputs: [
        { portId: "request", payload: requestPayload },
        ...catalogFrames(catalogPayload),
      ],
    });
    assert.equal(response.statusCode, 0, response.errorMessage);
    // PIV caps bound output, independent of interpreter/JIT throughput. SDS
    // 1.220.0 CQRCatalogResult and CQRScreeningStatistics define these counts;
    // the unordered 1200-object catalog has 1200*1199/2 candidate pairs.
    assert.equal(response.outputs.length, 1);
    const result = response.outputs?.find((frame) => frame.portId === "result");
    assert.ok(result?.payload instanceof Uint8Array, "result payload is emitted");
    const decoded = catalogInReferenceUnits(decodeCqr(flatc, result.payload).CATALOG_RESULT);
    assert.equal(decoded.objectsParsed, 1200);
    const record = decodeCqr(flatc, result.payload).CATALOG_RESULT;
    assert.equal(record.STATISTICS.PAIRS_SCREENED, 1200 * 1199 / 2);
    assert.equal(record.STATISTICS.FAILED_PAIRS, 0);
    assert.ok(record.EVENTS.length <= 128);
  },
);

test("screen_catalog rejects mixed frames instead of silently relabeling a secondary track", async (t) => {
  if (!conjunctionArtifactExists()) {
    t.skip("Build conjunction-assessment before running the mixed source screen_catalog test.");
    return;
  }
  const runnerBinary = await buildThreadedWasmEdgeRunner(
    t,
    "conjunction-mixed-source-runner-",
  );
  if (!runnerBinary) {
    return;
  }

  const flatc = await FlatcRunner.init();
  const requestPayload = createScreenCatalogRequest(flatc, {
    selectedSources: [
      {
        sourceKind: "OMM",
        sourceId: "celestrak-primary",
        providerId: "celestrak.eth",
        schemaName: "OMM/main.fbs",
        fileIdentifier: "$OMM",
      },
      {
        sourceKind: "OCM",
        sourceId: "operator-secondary",
        providerId: "operator.example",
        schemaName: "OCM/main.fbs",
        fileIdentifier: "$OCM",
      },
    ],
    primaryGps: [
      {
        objectName: "PRIMARY-GP",
        objectId: "2026-PRIMARY",
        epoch: "2026-03-09T00:00:00.000000",
        meanMotion: 15.1,
        eccentricity: 0.001,
        inclination: 53.0,
        raOfAscNode: 1.0,
        argOfPericenter: 2.0,
        meanAnomaly: 3.0,
        ephemerisType: 0,
        classificationType: "U",
        noradCatId: 96001,
        elementSetNo: 1,
        revAtEpoch: 1,
        bstar: 0.0,
        meanMotionDot: 0.0,
        meanMotionDdot: 0.0,
      },
    ],
    secondaryTracks: [
      {
        sourcePluginId: "operator-ocm-adapter",
        sourceHandle: 42,
        objectName: "SECONDARY-TRACK",
        objectId: "2026-SECONDARY",
        noradCatId: 96002,
        referenceFrame: "ICRF",
        samples: [
          {
            jd: 2461108.5,
            xKm: 7000.02,
            yKm: 0,
            zKm: 0,
            vxKmS: 0,
            vyKmS: 7.49,
            vzKmS: 0,
          },
          {
            jd: 2461108.5 + 60 / 86400,
            xKm: 7000.005,
            yKm: 449.4,
            zKm: 0,
            vxKmS: -0.478,
            vyKmS: 7.48998,
            vzKmS: 0,
          },
        ],
      },
    ],
    durationDays: 1 / 86400,
    coarseStepSec: 600.0,
  });
  const harness = await createConjunctionCommandHarness({
    wasmEdgeRunnerBinary: runnerBinary,
  });
  t.after(async () => {
    await harness.destroy();
  });

  const response = await harness.invoke({
    methodId: "screen_catalog",
    inputs: [{ portId: "request", payload: requestPayload }],
  });

  assert.notEqual(response.statusCode, 0);
  assert.ok(response.errorMessage);
});
