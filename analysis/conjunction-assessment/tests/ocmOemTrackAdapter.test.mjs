import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { FlatcRunner } from "flatc-wasm";

import * as conjunctionModule from "../index.js";
import {
  conjunctionArtifactExists,
  createConjunctionCommandHarness,
} from "./lib/conjunctionCommandHarness.mjs";
import { buildThreadedWasmEdgeRunner } from "./lib/wasmedgePthreadRunner.mjs";

function readText(path) {
  return fs.readFileSync(new URL(path, import.meta.url), "utf8");
}

function conjunctionPairRequestSchema() {
  return {
    entry: "/schemas/ConjunctionPairRequest.fbs",
    files: {
      "/schemas/ConjunctionPairRequest.fbs": readText(
        "../schemas/ConjunctionPairRequest.fbs",
      ),
      "/schemas/ConjunctionCommon.fbs": readText(
        "../schemas/ConjunctionCommon.fbs",
      ),
    },
  };
}

const startIso = "2026-03-09T00:00:00.000Z";
const startJd = 2461108.5;
const ocmRecord = {
  METADATA: {
    OBJECT_NAME: "OCM-PRIMARY",
    INTERNATIONAL_DESIGNATOR: "2026-001A",
    OBJECT_DESIGNATOR: "99001",
    START_TIME: startIso,
  },
  STATE_STEP_SIZE: 60,
  STATE_VECTOR_SIZE: 6,
  STATE_DATA: [
    7000, 0, 0, 0, 7.5, 0,
    6999.985, 450, 0, -0.48, 7.49998, 0,
    6999.94, 900, 0, -0.96, 7.4999, 0,
  ],
};
const oemRecord = {
  EPHEMERIS_DATA_BLOCK: [
    {
      OBJECT: { OBJECT_NAME: "OEM-SECONDARY", NORAD_CAT_ID: 99002 },
      REFERENCE_FRAME: "EME2000",
      START_TIME: startIso,
      STEP_SIZE: 60,
      STATE_VECTOR_SIZE: 6,
      EPHEMERIS_DATA: [
        7000.02, 0, 0, 0, 7.49, 0,
        7000.005, 449.4, 0, -0.478, 7.48998, 0,
        6999.96, 898.8, 0, -0.956, 7.4899, 0,
      ],
    },
  ],
};

test("OCM and OEM source records adapt to propagated tracks", () => {
  assert.equal(typeof conjunctionModule.adaptOcmToPropagatedTrack, "function");
  assert.equal(typeof conjunctionModule.adaptOemToPropagatedTrack, "function");

  const primary = conjunctionModule.adaptOcmToPropagatedTrack(ocmRecord);
  const secondary = conjunctionModule.adaptOemToPropagatedTrack(oemRecord);

  assert.equal(primary.objectName, "OCM-PRIMARY");
  assert.equal(primary.objectId, "2026-001A");
  assert.equal(primary.noradCatId, 99001);
  assert.equal(primary.referenceFrame, "UNKNOWN");
  assert.equal(primary.samples.length, 3);
  assert.deepEqual(primary.samples[1], {
    jd: startJd + 60 / 86400,
    xKm: 6999.985,
    yKm: 450,
    zKm: 0,
    vxKmS: -0.48,
    vyKmS: 7.49998,
    vzKmS: 0,
  });

  assert.equal(secondary.objectName, "OEM-SECONDARY");
  assert.equal(secondary.noradCatId, 99002);
  assert.equal(secondary.referenceFrame, "ICRF");
  assert.equal(secondary.samples.length, 3);
  assert.equal(secondary.samples[2].jd, startJd + 120 / 86400);
});

test("emit_cdm accepts an OCM/OEM-derived propagated-track request", async (t) => {
  if (!conjunctionArtifactExists()) {
    t.skip("Build conjunction-assessment before running the OCM/OEM CDM harness test.");
    return;
  }
  const runnerBinary = await buildThreadedWasmEdgeRunner(
    t,
    "conjunction-ocm-oem-cdm-runner-",
  );
  if (!runnerBinary) {
    return;
  }

  const flatc = await FlatcRunner.init();
  const primaryTrack = conjunctionModule.adaptOcmToPropagatedTrack(ocmRecord);
  const secondaryTrack = conjunctionModule.adaptOemToPropagatedTrack(oemRecord);
  const requestPayload = flatc.generateBinary(
    conjunctionPairRequestSchema(),
    JSON.stringify({
      primaryTrack,
      secondaryTrack,
      startJd,
      durationDays: 120 / 86400,
      radius1M: 5,
      radius2M: 5,
    }),
    { sizePrefix: false },
  );
  const harness = await createConjunctionCommandHarness({
    wasmEdgeRunnerBinary: runnerBinary,
  });
  t.after(async () => {
    await harness.destroy();
  });

  const response = await harness.invoke({
    methodId: "emit_cdm",
    inputs: [{ portId: "request", payload: requestPayload }],
  });

  assert.equal(response.statusCode, 0, response.errorMessage);
  const cdm = response.outputs?.find((frame) => frame.portId === "cdm");
  assert.ok(cdm?.payload instanceof Uint8Array, "CDM payload is emitted");
  assert.ok(cdm.payload.byteLength > 0, "CDM payload is non-empty");
});
