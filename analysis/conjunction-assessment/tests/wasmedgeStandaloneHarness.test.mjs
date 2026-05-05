import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import { FlatcRunner } from "flatc-wasm";

import {
  conjunctionArtifactExists,
  createConjunctionCommandHarness,
  invokeConjunctionJson,
} from "./lib/conjunctionCommandHarness.mjs";
import {
  createLocalSgp4Plugin,
  sampleTrackWindowFromReference,
  sgp4ArtifactExists,
} from "./lib/sgp4TrackHarness.mjs";
import { buildThreadedWasmEdgeRunner } from "./lib/wasmedgePthreadRunner.mjs";
import { signCdmOutput, verifySignedCdmOutput } from "../index.js";

const CLOSE_PAIR_FIXTURE_PATH = new URL(
  "./fixtures/socrates/gp_61721,67298.json",
  import.meta.url,
);
const SOCRATES_REFERENCE_PATH = new URL(
  "./fixtures/socrates/reference.top3.json",
  import.meta.url,
);

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

test("conjunction WasmEdge harness accepts SGP4-sampled tracks for the known close pair", async (t) => {
  if (!conjunctionArtifactExists()) {
    t.skip("Build conjunction-assessment before running the WasmEdge harness test.");
    return;
  }
  if (!sgp4ArtifactExists()) {
    t.skip("Build the local SGP4 plugin before running the WasmEdge harness test.");
    return;
  }
  const runnerBinary = await buildThreadedWasmEdgeRunner(
    t,
    "conjunction-wasmedge-replay-runner-",
  );
  if (!runnerBinary) {
    return;
  }

  const gpRecords = JSON.parse(fs.readFileSync(CLOSE_PAIR_FIXTURE_PATH, "utf8"));
  const reference = JSON.parse(fs.readFileSync(SOCRATES_REFERENCE_PATH, "utf8"))
    .conjunctions[0];
  const harness = await createConjunctionCommandHarness({
    wasmEdgeRunnerBinary: runnerBinary,
  });
  const sgp4 = await createLocalSgp4Plugin();

  t.after(async () => {
    sgp4.destroy();
    await harness.destroy();
  });

  const [primaryTrack, secondaryTrack] = await sampleTrackWindowFromReference(
    sgp4,
    gpRecords,
    reference,
  );

  const { response, json } = await invokeConjunctionJson(harness, {
    operation: "assessTracks",
    params: {
      primary_track: primaryTrack,
      secondary_track: secondaryTrack,
      tca_hint_jd: Date.parse(reference.tca) / 86400000 + 2440587.5,
      window_hours: 0.2,
    },
  });

  assert.equal(response.statusCode, 0);
  assert.ok(Number.isFinite(Number(json?.tca_jd)));
  assert.ok(Number(json?.min_range_km) < 0.2);
  assert.ok(Number(json?.rel_speed_kms) > 5);
  assert.equal(json?.obj1_norad, 61721);
  assert.equal(json?.obj2_norad, 67298);
});

test("emit_cdm accepts SGP4-sampled track-backed conjunction requests", async (t) => {
  if (!conjunctionArtifactExists()) {
    t.skip("Build conjunction-assessment before running the WasmEdge harness test.");
    return;
  }
  if (!sgp4ArtifactExists()) {
    t.skip("Build the local SGP4 plugin before running the WasmEdge harness test.");
    return;
  }
  const runnerBinary = await buildThreadedWasmEdgeRunner(
    t,
    "conjunction-wasmedge-track-cdm-runner-",
  );
  if (!runnerBinary) {
    return;
  }

  const gpRecords = JSON.parse(fs.readFileSync(CLOSE_PAIR_FIXTURE_PATH, "utf8"));
  const reference = JSON.parse(fs.readFileSync(SOCRATES_REFERENCE_PATH, "utf8"))
    .conjunctions[0];
  const harness = await createConjunctionCommandHarness({
    wasmEdgeRunnerBinary: runnerBinary,
  });
  const sgp4 = await createLocalSgp4Plugin();

  t.after(async () => {
    sgp4.destroy();
    await harness.destroy();
  });

  const [primaryTrack, secondaryTrack] = await sampleTrackWindowFromReference(
    sgp4,
    gpRecords,
    reference,
  );
  const tcaHintJd = Date.parse(reference.tca) / 86400000 + 2440587.5;
  const flatc = await FlatcRunner.init();
  const requestPayload = flatc.generateBinary(
    conjunctionPairRequestSchema(),
    JSON.stringify({
      primaryTrack,
      secondaryTrack,
      startJd: tcaHintJd - 0.1 / 24,
      durationDays: 0.2 / 24,
      radius1M: 5,
      radius2M: 5,
    }),
    { sizePrefix: false },
  );

  const response = await harness.invoke({
    methodId: "emit_cdm",
    inputs: [{ portId: "request", payload: requestPayload }],
  });

  assert.equal(response.statusCode, 0, response.errorMessage);
  const cdm = response.outputs?.find((frame) => frame.portId === "cdm");
  assert.ok(cdm?.payload instanceof Uint8Array, "CDM payload is emitted");
  assert.ok(cdm.payload.byteLength > 0, "CDM payload is non-empty");

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const signed = signCdmOutput(cdm.payload, {
    privateKey,
    providerId: "celestrak.eth",
    sourcePnmCid: "bafybeisocratesfixture",
    moduleArtifactHash: "sha256:" + "b".repeat(64),
    moduleVersion: "0.2.0",
    cdmOutputId: "CDM-61721-67298",
  });
  assert.equal(
    verifySignedCdmOutput(cdm.payload, signed, publicKey),
    true,
    "signed CDM metadata verifies against emitted CDM bytes",
  );
});
