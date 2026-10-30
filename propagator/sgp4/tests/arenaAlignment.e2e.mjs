// The answer's payload arena starts on an 8-byte boundary (propagator/sgp4 1.4.1). Each frame's OFFSET is aligned
// inside the arena, so with the arena aligned in the answer every payload lies on its declared ALIGNMENT, as the
// module SDK's decoder requires. 1.4.0 built the arena as a plain byte vector, aligned on 4 bytes: with an even number
// of frames the first payload sat at byte 60 of the answer, and decodePluginInvokeResponse refused it ("payload is
// misaligned: absolute offset 60 violates alignment 8"), so harnesses padded the bytes.
// For each artifact (dist/browser, dist/browser-shared on shared memory, dist/isomorphic), through the SDK host
// (createBrowserModuleHarness, direct surface), whose invoke decodes the answer as the module returns it: ingest_omm of
// Space-Track's 2026-10-29 sets (tests/fixtures/spacetrack-gp, cited there), then propagate_state of 1, 2, 3, 4 and 10
// of them and propagate_ephemeris of 1, 2, 3 and 4, in TEME. Every answer is accepted, and every frame's payload is
// byte for byte 1.4.0's: SHA-256 recorded from 1.4.0 (149beb394's dist/browser, read without the alignment check).
// Run: node --test tests/arenaAlignment.e2e.mjs (needs dist/ built).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing/browser";

import { ReferenceFrame, encodeOmmPayload, encodePropagatorBatchRequest } from "./lib/payloadEncoders.mjs";

const OMM_TYPE = { schemaName: "orbpro.sds.omm", fileIdentifier: "$OMM", rootTypeName: "OMM" };
const PROP_TYPE = { schemaName: "orbpro.propagator.PropagatorBatchRequest", fileIdentifier: "PROP", rootTypeName: "PropagatorBatchRequest" };
const SETS = JSON.parse(fs.readFileSync(new URL("./fixtures/spacetrack-gp/gp-2026-10-29.json", import.meta.url), "utf8")).map((r) => ({
  noradId: Number(r.NORAD_CAT_ID), objectId: r.OBJECT_ID, objectName: r.OBJECT_NAME, epoch: r.EPOCH, meanMotion: Number(r.MEAN_MOTION),
  eccentricity: Number(r.ECCENTRICITY), inclination: Number(r.INCLINATION), raan: Number(r.RA_OF_ASC_NODE), argPericenter: Number(r.ARG_OF_PERICENTER),
  meanAnomaly: Number(r.MEAN_ANOMALY), bstar: Number(r.BSTAR), meanMotionDot: 0, meanMotionDdot: 0 }));
const EPOCH = 2461343.5; // 2026-10-30T00:00:00 UTC
const request = (fields) => [{ portId: "request", typeRef: PROP_TYPE, payload: encodePropagatorBatchRequest({ outputFrame: ReferenceFrame.TEME, ...fields }) }];
const CALLS = [
  ["ingest_omm", { methodId: "ingest_omm", inputs: SETS.map((set) => ({ portId: "omm", typeRef: OMM_TYPE, payload: encodeOmmPayload(set) })) }],
  ...[1, 2, 3, 4, 10].map((n) => [`propagate_state of ${n}`, { methodId: "propagate_state", outputStreamCap: 16,
    inputs: request({ epoch: EPOCH, catalogNumbers: SETS.slice(0, n).map((set) => set.noradId) }) }]),
  ...[1, 2, 3, 4].map((n) => [`propagate_ephemeris of ${n}`, { methodId: "propagate_ephemeris", outputStreamCap: 16,
    inputs: request({ epoch: EPOCH, stopEpoch: EPOCH + 1 / 24, stepSeconds: 600, catalogNumbers: SETS.slice(0, n).map((set) => set.noradId) }) }]),
];
// 1.4.0's payloads, SHA-256 per frame in answer order
const RECORDED = {
  "ingest_omm": [],
  "propagate_state of 1": [
    "67bdd67f5c645976c43984943441e8991ec1b4c9ee943754225da7ec6ca8c6ba",
  ],
  "propagate_state of 2": [
    "67bdd67f5c645976c43984943441e8991ec1b4c9ee943754225da7ec6ca8c6ba",
    "5e6a70797ed98b691e93d28cedfc5ebdea1f75c7fb63d1d49734209a30a4733c",
  ],
  "propagate_state of 3": [
    "67bdd67f5c645976c43984943441e8991ec1b4c9ee943754225da7ec6ca8c6ba",
    "5e6a70797ed98b691e93d28cedfc5ebdea1f75c7fb63d1d49734209a30a4733c",
    "5bdc9bdb2dcb1e40dc3b37bff2a058db0c8b01f78bf66176c0e7674874430f2d",
  ],
  "propagate_state of 4": [
    "67bdd67f5c645976c43984943441e8991ec1b4c9ee943754225da7ec6ca8c6ba",
    "5e6a70797ed98b691e93d28cedfc5ebdea1f75c7fb63d1d49734209a30a4733c",
    "5bdc9bdb2dcb1e40dc3b37bff2a058db0c8b01f78bf66176c0e7674874430f2d",
    "19d9476b49e427999cc7805014be614544b4072f8f309d17c971ef0b5dfee4c6",
  ],
  "propagate_state of 10": [
    "67bdd67f5c645976c43984943441e8991ec1b4c9ee943754225da7ec6ca8c6ba",
    "5e6a70797ed98b691e93d28cedfc5ebdea1f75c7fb63d1d49734209a30a4733c",
    "5bdc9bdb2dcb1e40dc3b37bff2a058db0c8b01f78bf66176c0e7674874430f2d",
    "19d9476b49e427999cc7805014be614544b4072f8f309d17c971ef0b5dfee4c6",
    "999bd47ab1481b7ef74ba42b0de8e411aafc04c9eca19fe7103d35370d7c8b66",
    "04e786174da3797a571d6dba0e358354a70bc2901f7ceeea5945a17ad530ae11",
    "9cdd06260b67805f453467697ab8327d5591630ab7dec83c61721d3a240b90e7",
    "ae47aee3aabc90a33fdf7e0e054302af8a92116ee4150c236102c6ef5d0cdae6",
    "5cee0aa2f69957f68ecff2fc4bd4f54016e0f24d676602b8a35c82f35e25dbee",
    "5a1ffdee4d1e24f42c91c50b0684d83324e09282904109700cd6f6cfd089b8c9",
  ],
  "propagate_ephemeris of 1": [
    "3ec8089cbc21491e03baa326c43d737faadbe21041f09708f7af215229b76163",
  ],
  "propagate_ephemeris of 2": [
    "3ec8089cbc21491e03baa326c43d737faadbe21041f09708f7af215229b76163",
    "893916de51c866b20b283e78d178f8af69a4318d5ec2630074026ed8516d7cf2",
  ],
  "propagate_ephemeris of 3": [
    "3ec8089cbc21491e03baa326c43d737faadbe21041f09708f7af215229b76163",
    "893916de51c866b20b283e78d178f8af69a4318d5ec2630074026ed8516d7cf2",
    "5d2a7cf5698182e38c5db4dc228a7b2a9e754e48c7cfd790d1fd56e53865c8ca",
  ],
  "propagate_ephemeris of 4": [
    "3ec8089cbc21491e03baa326c43d737faadbe21041f09708f7af215229b76163",
    "893916de51c866b20b283e78d178f8af69a4318d5ec2630074026ed8516d7cf2",
    "5d2a7cf5698182e38c5db4dc228a7b2a9e754e48c7cfd790d1fd56e53865c8ca",
    "0fa046a9b35eeca611b73b85a126b6bd0e66c00bd7aa35b16980cbb26b8f0e4c",
  ],
};
const FLAVORS = [
  ["browser", {}],
  ["browser-shared", { sharedMemory: true, initialMemoryBytes: 64 * 1024 * 1024, maximumMemoryBytes: 2 * 1024 * 1024 * 1024 }],
  ["isomorphic", {}],
];
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

for (const [flavor, options] of FLAVORS) {
  test(`dist/${flavor}: the SDK decoder takes every answer unpadded; the payloads are 1.4.0's`, async (t) => {
    if (options.sharedMemory && typeof SharedArrayBuffer !== "function") {
      t.skip("SharedArrayBuffer is not available in this runtime.");
      return;
    }
    const harness = await createBrowserModuleHarness({
      wasmSource: fs.readFileSync(new URL(`../dist/${flavor}/module.wasm`, import.meta.url)), surface: "direct", ...options });
    try {
      const payloads = {};
      for (const [label, call] of CALLS) {
        const answer = await harness.invoke(call);
        assert.equal(answer.statusCode, 0, `${label}: ${answer.errorCode} ${answer.errorMessage}`);
        for (const frame of answer.outputs) {
          const offset = frame.payload.byteOffset;
          assert.equal(offset % frame.alignment, 0, `${label}: a payload at byte ${offset} of the answer, alignment ${frame.alignment}`);
        }
        payloads[label] = answer.outputs.map((frame) => sha256(frame.payload));
      }
      assert.deepEqual(payloads, RECORDED);
    } finally {
      harness.destroy();
    }
  });
}
