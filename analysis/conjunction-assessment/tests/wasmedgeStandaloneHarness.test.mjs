import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import { FlatcRunner } from "flatc-wasm";
import { encodeCqr, decodeCqr, pairRequest } from "./lib/cqr.mjs";

import {
  conjunctionArtifactExists,
  createConjunctionCommandHarness,
  invokeConjunctionJson,
} from "./lib/conjunctionCommandHarness.mjs";
import { gpSource } from "./lib/cqr.mjs";
import { buildThreadedWasmEdgeRunner } from "./lib/wasmedgePthreadRunner.mjs";
import { signCdmOutput, verifySignedCdmOutput } from "../index.js";
import { privateFixtureSkip, readPrivateFixtureJson, privateFixturePath } from "./lib/privateFixtures.mjs";

const SOCRATES_SKIP = privateFixtureSkip("socrates/gp_61721,67298.json", "socrates/reference.top3.json");
const CLOSE_PAIR_FIXTURE_PATH = privateFixturePath("socrates/gp_61721,67298.json");
const SOCRATES_REFERENCE_PATH = privateFixturePath("socrates/reference.top3.json");
function readText(path) {
  return fs.readFileSync(new URL(path, import.meta.url), "utf8");
}

test("conjunction WasmEdge harness accepts canonical OMM sources for the known close pair", { skip: SOCRATES_SKIP }, async (t) => {
  if (!conjunctionArtifactExists()) {
    t.skip("Build conjunction-assessment before running the WasmEdge harness test.");
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

  t.after(async () => {
    await harness.destroy();
  });

  const [primaryTrack, secondaryTrack] = gpRecords.map(gpSource);

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

test("emit_cdm accepts canonical OMM-backed conjunction requests", { skip: SOCRATES_SKIP }, async (t) => {
  if (!conjunctionArtifactExists()) {
    t.skip("Build conjunction-assessment before running the WasmEdge harness test.");
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

  t.after(async () => {
    await harness.destroy();
  });

  const [primaryTrack, secondaryTrack] = gpRecords.map(gpSource);
  const tcaHintJd = Date.parse(reference.tca) / 86400000 + 2440587.5;
  const flatc = await FlatcRunner.init();
  const requestPayload = encodeCqr(flatc, pairRequest({
      primaryTrack,
      secondaryTrack,
      startJd: tcaHintJd - 0.1 / 24,
      durationDays: 0.2 / 24,
      radius1M: 5,
      radius2M: 5,
    }),
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

test("emit_csm accepts canonical OMM-backed conjunction requests", { skip: SOCRATES_SKIP }, async (t) => {
  if (!conjunctionArtifactExists()) {
    t.skip("Build conjunction-assessment before running the WasmEdge harness test.");
    return;
  }
  const runnerBinary = await buildThreadedWasmEdgeRunner(
    t,
    "conjunction-wasmedge-track-csm-runner-",
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

  t.after(async () => {
    await harness.destroy();
  });

  const [primaryTrack, secondaryTrack] = gpRecords.map(gpSource);
  const tcaHintJd = Date.parse(reference.tca) / 86400000 + 2440587.5;
  const flatc = await FlatcRunner.init();
  const requestPayload = encodeCqr(flatc, pairRequest({
      primaryTrack,
      secondaryTrack,
      startJd: tcaHintJd - 0.1 / 24,
      durationDays: 0.2 / 24,
      radius1M: 5,
      radius2M: 5,
    }),
  );

  const response = await harness.invoke({
    methodId: "emit_csm",
    inputs: [{ portId: "request", payload: requestPayload }],
  });

  assert.equal(response.statusCode, 0, response.errorMessage);
  const csm = response.outputs?.find((frame) => frame.portId === "csm");
  assert.ok(csm?.payload instanceof Uint8Array, "CSM payload is emitted");
  assert.ok(csm.payload.byteLength > 0, "CSM payload is non-empty");
});
