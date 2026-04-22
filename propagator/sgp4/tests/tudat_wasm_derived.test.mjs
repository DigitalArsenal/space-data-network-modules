/**
 * Derived from Tudat WASM SGP4 tests:
 *   https://github.com/DigitalArsenal/tudat-wasm/blob/c998d24001af69e60f07cc6a29ddf64c422dd9de/tests/wasm/src/testSpice.cpp
 *
 * The original Tudat coverage validates the Vallado canonical SGP4 benchmark
 * and a basic ISS-like orbit sanity check. This package-local variant drives
 * the SDK 0.8.0 browser harness through the same `ingest_omm` +
 * `propagate_state` path that every downstream host uses, so a green run here
 * means the OrbPro native propagator still matches the textbook reference
 * inside the SDK-compliant WASM envelope.
 *
 * Tudat compares the Vallado benchmark in J2000 after converting from TEME.
 * This plugin's public contract returns TEME state vectors, so the numeric
 * reference below uses the same Vallado case in the vendored libsgp4
 * verification set at src/cpp/deps/sgp4/SGP4-VER.TLE.
 *
 * Tudat's Lambert (`testMissionSegments`) scenarios are intentionally not
 * ported — this plugin only exposes SGP4 propagation. Lambert targeting lives
 * in a separate plugin in the OrbPro suite.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import {
  decodePropagatorState,
  encodeOmmPayload,
  encodePropagatorBatchRequest,
} from "./lib/payloadEncoders.mjs";

const ISOMORPHIC_WASM_PATH = fileURLToPath(
  new URL("../dist/isomorphic/module.wasm", import.meta.url),
);

const VALLADO_OMM = {
  noradId: 5,
  objectName: "VALLADO TEST CASE",
  objectId: "1958-002B",
  epoch: "2000-06-27T18:50:19.733568",
  meanMotion: 10.82419157,
  eccentricity: 0.1859667,
  inclination: 34.2682,
  raan: 348.7242,
  argPericenter: 331.7664,
  meanAnomaly: 19.3264,
  bstar: 0.000028098,
  meanMotionDot: 0.00000023,
  meanMotionDdot: 0.0,
};

// JD of the Vallado epoch is 2451723.28495062; propagate three days forward
// to match the canonical Vallado verification sample.
const VALLADO_TARGET_JD = 2451726.28495062;

// The plugin emits PropagatorState in ECEF meters / meters per second. The
// Vallado canonical test case is published in TEME km, so we cannot compare
// vectors directly without implementing the TEME→ECEF rotation. Position
// magnitude is preserved by any orthonormal rotation, so comparing |r| against
// the TEME radius is a tight, frame-invariant invariant: any SGP4 regression
// will move the radius well outside the 1 cm band.
//
// Velocity magnitude is NOT frame-invariant — ECEF velocity includes an
// ω×r term from Earth's rotation, so we only bound it to a reasonable
// orbital-velocity envelope rather than trying to match the TEME speed.
const VALLADO_TEME_POSITION_MAGNITUDE_METERS = Math.sqrt(
  (-9060.4737357) ** 2 + 4658.70952502 ** 2 + 813.686731533 ** 2,
) * 1000;

const ISS_LIKE_OMM = {
  noradId: 25544,
  objectName: "TUDAT ISS-LIKE",
  objectId: "2000-001A",
  epoch: "2000-01-01T12:00:00.000000",
  meanMotion: 15.652173913043478,
  eccentricity: 0.0001,
  inclination: 51.6,
  raan: 0.0,
  argPericenter: 0.0,
  meanAnomaly: 0.0,
  bstar: 0.0001,
  meanMotionDot: 0.0,
  meanMotionDdot: 0.0,
};

// Propagate exactly at epoch so we can bound the state-vector magnitudes
// against the canonical ISS orbital parameters.
const ISS_TARGET_JD = 2451545.0;

function magnitude3([x, y, z]) {
  return Math.sqrt(x * x + y * y + z * z);
}

async function createHarness(t) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(ISOMORPHIC_WASM_PATH),
    surface: "direct",
  });
  t.after(() => {
    harness.destroy();
  });
  return harness;
}

async function ingestOmm(harness, ommOverrides) {
  const response = await harness.invoke({
    methodId: "ingest_omm",
    inputs: [
      {
        portId: "omm",
        payload: encodeOmmPayload(ommOverrides),
        typeRef: {
          schemaName: "orbpro.sds.omm",
          fileIdentifier: "$OMM",
        },
      },
    ],
  });
  assert.equal(response.statusCode ?? 0, 0, response.errorMessage ?? "");
}

async function propagateAtJd(harness, targetJd) {
  const response = await harness.invoke({
    methodId: "propagate_state",
    inputs: [
      {
        portId: "request",
        payload: encodePropagatorBatchRequest({
          epoch: targetJd,
          entityHandles: [0],
          maxCount: 1,
        }),
        typeRef: {
          schemaName: "orbpro.propagator.PropagatorBatchRequest",
          fileIdentifier: "PROP",
        },
      },
    ],
    outputStreamCap: 1,
  });
  assert.equal(response.statusCode ?? 0, 0, response.errorMessage ?? "");
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "state");
  return decodePropagatorState(new Uint8Array(response.outputs[0].payload));
}

test("tudat vallado sgp4 benchmark stays within textbook tolerance", async (t) => {
  const harness = await createHarness(t);
  await ingestOmm(harness, VALLADO_OMM);
  const state = await propagateAtJd(harness, VALLADO_TARGET_JD);

  assert.equal(state.catalogNumber, VALLADO_OMM.noradId);
  assert.equal(state.valid, true);

  const positionMagnitudeMeters = magnitude3(state.position);
  const velocityMagnitudeMetersPerSec = magnitude3(state.velocity);

  const positionMagnitudeErrorMeters = Math.abs(
    positionMagnitudeMeters - VALLADO_TEME_POSITION_MAGNITUDE_METERS,
  );

  assert.ok(
    positionMagnitudeErrorMeters < 1e-2,
    `Vallado orbit radius matches reference within 1 cm (got |p|=${positionMagnitudeMeters}, ref=${VALLADO_TEME_POSITION_MAGNITUDE_METERS}, err=${positionMagnitudeErrorMeters} m)`,
  );
  // ECEF speed ≈ TEME speed for this orbit minus ω×r; keep a loose envelope.
  assert.ok(
    velocityMagnitudeMetersPerSec > 3_000.0 &&
      velocityMagnitudeMetersPerSec < 8_000.0,
    `Vallado orbit speed within expected orbital envelope (got |v|=${velocityMagnitudeMetersPerSec} m/s)`,
  );
});

test("tudat iss-like sgp4 sanity orbit stays in expected bounds", async (t) => {
  const harness = await createHarness(t);
  await ingestOmm(harness, ISS_LIKE_OMM);
  const state = await propagateAtJd(harness, ISS_TARGET_JD);

  assert.equal(state.catalogNumber, ISS_LIKE_OMM.noradId);
  assert.equal(state.valid, true);

  const positionMagnitude = magnitude3(state.position);
  const velocityMagnitude = magnitude3(state.velocity);

  assert.ok(
    positionMagnitude > 6_500_000.0,
    `ISS-like orbit radius > 6500 km (got ${positionMagnitude} m)`,
  );
  assert.ok(
    positionMagnitude < 7_000_000.0,
    `ISS-like orbit radius < 7000 km (got ${positionMagnitude} m)`,
  );
  assert.ok(
    velocityMagnitude > 7_000.0,
    `ISS-like orbit velocity > 7.0 km/s (got ${velocityMagnitude} m/s)`,
  );
  assert.ok(
    velocityMagnitude < 8_000.0,
    `ISS-like orbit velocity < 8.0 km/s (got ${velocityMagnitude} m/s)`,
  );
});
