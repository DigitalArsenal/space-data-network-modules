import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { FlatcRunner } from "flatc-wasm";

import {
  conjunctionArtifactExists,
  createConjunctionCommandHarness,
} from "./lib/conjunctionCommandHarness.mjs";
import { buildThreadedWasmEdgeRunner } from "./lib/wasmedgePthreadRunner.mjs";

function readText(path) {
  return fs.readFileSync(new URL(path, import.meta.url), "utf8");
}

function conjunctionRequestSchema() {
  return {
    entry: "/schemas/ConjunctionScreenCatalogRequest.fbs",
    files: {
      "/schemas/ConjunctionScreenCatalogRequest.fbs": readText(
        "../schemas/ConjunctionScreenCatalogRequest.fbs",
      ),
      "/schemas/ConjunctionCommon.fbs": readText(
        "../schemas/ConjunctionCommon.fbs",
      ),
    },
  };
}

function ommSchema() {
  return {
    entry: "/sds/OMM/main.fbs",
    files: {
      "/sds/OMM/main.fbs": readText(
        "../node_modules/spacedatastandards.org/schema/OMM/main.fbs",
      ),
      "/sds/RFM/main.fbs": readText(
        "../node_modules/spacedatastandards.org/schema/RFM/main.fbs",
      ),
      "/sds/TIM/main.fbs": readText(
        "../node_modules/spacedatastandards.org/schema/TIM/main.fbs",
      ),
      "/sds/MET/main.fbs": readText(
        "../node_modules/spacedatastandards.org/schema/MET/main.fbs",
      ),
    },
  };
}

function createOmmRecord(flatc, noradCatId, options = {}) {
  return flatc.generateBinary(
    ommSchema(),
    JSON.stringify({
      OBJECT_NAME: `TEST-${noradCatId}`,
      OBJECT_ID: `2026-001${noradCatId}`,
      EPOCH: "2026-03-09T00:00:00.000000",
      MEAN_MOTION: 15.1,
      ECCENTRICITY: 0.001,
      INCLINATION: 53.0,
      RA_OF_ASC_NODE: 1.0,
      ARG_OF_PERICENTER: 2.0,
      MEAN_ANOMALY: 3.0,
      EPHEMERIS_TYPE: "SGP4",
      CLASSIFICATION_TYPE: "U",
      NORAD_CAT_ID: noradCatId,
      ELEMENT_SET_NO: 1,
      REV_AT_EPOCH: 1,
      BSTAR: 0.0,
      MEAN_MOTION_DOT: 0.0,
      MEAN_MOTION_DDOT: 0.0,
    }),
    { sizePrefix: options.sizePrefix === true },
  );
}

function createScreenCatalogRequest(flatc) {
  return flatc.generateBinary(
    conjunctionRequestSchema(),
    JSON.stringify({
      selectedSources: [
        {
          sourceKind: "OMM",
          sourceId: "celestrak-full-catalog",
          providerId: "celestrak.eth",
          schemaName: "OMM/main.fbs",
          fileIdentifier: "$OMM",
        },
      ],
      startJd: 2460743.5,
      durationDays: 0.01,
      thresholdKm: 15.0,
      numThreads: 1,
      coarseStepSec: 300.0,
      fineTolSec: 0.01,
      combinedRadiusM: 10.0,
    }),
    { sizePrefix: false },
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

  const response = await harness.invoke({
    methodId: "screen_catalog",
    inputs: [
      { portId: "request", payload: requestPayload },
      { portId: "catalog", payload: catalogPayload },
    ],
  });

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

  const response = await harness.invoke({
    methodId: "screen_catalog",
    inputs: [
      { portId: "request", payload: requestPayload },
      { portId: "catalog", payload: catalogPayload },
    ],
  });

  assert.equal(response.statusCode, 0, response.errorMessage);
  const result = response.outputs?.find((frame) => frame.portId === "result");
  assert.ok(result?.payload instanceof Uint8Array, "result payload is emitted");
  assert.ok(result.payload.byteLength > 0, "result payload is non-empty");
});
