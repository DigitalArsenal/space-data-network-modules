/**
 * Derived from Tudat WASM SGP4 and mission-segments tests:
 * https://github.com/DigitalArsenal/tudat-wasm/blob/c998d24001af69e60f07cc6a29ddf64c422dd9de/tests/wasm/src/testSpice.cpp
 * https://github.com/DigitalArsenal/tudat-wasm/blob/c998d24001af69e60f07cc6a29ddf64c422dd9de/tests/wasm/src/testMissionSegments.cpp
 *
 * The original Tudat coverage validates the Vallado canonical SGP4 benchmark,
 * a basic ISS-like orbit sanity check, and Izzo Lambert targeting against
 * textbook and unit-test references. This package-local variant preserves those
 * public-surface scenarios while driving the command-surface plugin ABI through
 * the SDK browser and WasmEdge harnesses.
 *
 * Tudat compares the Vallado benchmark in J2000 after converting from TEME.
 * This plugin's public contract returns TEME state vectors, so the numeric
 * reference below uses the same Vallado case in the vendored libsgp4
 * verification set at src/cpp/deps/sgp4/SGP4-VER.TLE.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const VALLADO_GP = {
  OBJECT_NAME: "VALLADO TEST CASE",
  OBJECT_ID: "1958-002B",
  EPOCH: "2000-06-27T18:50:19.733568",
  MEAN_MOTION: 10.82419157,
  ECCENTRICITY: 0.1859667,
  INCLINATION: 34.2682,
  RA_OF_ASC_NODE: 348.7242,
  ARG_OF_PERICENTER: 331.7664,
  MEAN_ANOMALY: 19.3264,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: "U",
  NORAD_CAT_ID: 5,
  ELEMENT_SET_NO: 4136,
  REV_AT_EPOCH: 41366,
  BSTAR: 0.000028098,
  MEAN_MOTION_DOT: 0.00000023,
  MEAN_MOTION_DDOT: 0.0,
};

const ISS_LIKE_GP = {
  OBJECT_NAME: "TUDAT ISS-LIKE",
  OBJECT_ID: "2000-001A",
  EPOCH: "2000-01-01T12:00:00.000000",
  MEAN_MOTION: 15.652173913043478,
  ECCENTRICITY: 0.0001,
  INCLINATION: 51.6,
  RA_OF_ASC_NODE: 0.0,
  ARG_OF_PERICENTER: 0.0,
  MEAN_ANOMALY: 0.0,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: "U",
  NORAD_CAT_ID: 25544,
  ELEMENT_SET_NO: 1,
  REV_AT_EPOCH: 1,
  BSTAR: 0.0001,
  MEAN_MOTION_DOT: 0.0,
  MEAN_MOTION_DDOT: 0.0,
};

const VALLADO_TEME_REFERENCE = {
  positionKm: [-9060.4737357, 4658.70952502, 813.686731533],
  velocityKmPerSec: [-2.23283278274, -4.11045348994, -3.15734543346],
};

const LAMBERT_ELLIPTICAL_CASE = {
  // Tudat testMissionSegments.cpp: "Elliptical case (Earth orbit)"
  r1: [2.0 * 6378.136, 0.0, 0.0],
  r2: [2.0 * 6378.136, 2.0 * Math.sqrt(3.0) * 6378.136, 0.0],
  tofSeconds: 5.0 * 806.78,
  expectedV1: [2.7358, 6.5943, 0.0],
  expectedV2: [-1.3679, 4.22503, 0.0],
};

const LAMBERT_HYPERBOLIC_CASE = {
  // Tudat testMissionSegments.cpp: "Hyperbolic case"
  r1: [0.02 * 149597870.7, 0.0, 0.0],
  r2: [0.0, -0.03 * 149597870.7, 0.0],
  tofSeconds: 100.0 * 86400.0,
  expectedV1: [-0.745457, 0.156743, 0.0],
};

function magnitude3({ x, y, z }) {
  return Math.sqrt(x * x + y * y + z * z);
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`tudat vallado sgp4 benchmark stays within textbook tolerance on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, ISOMORPHIC_WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const pointResult = await invokeJsonRequest(harness, {
      operation: "propagateToEpoch",
      params: {
        gp: VALLADO_GP,
        targetJd: 2451726.28495062,
      },
    });

    const positionErrorKm = Math.sqrt(
      (pointResult.x - VALLADO_TEME_REFERENCE.positionKm[0]) ** 2 +
        (pointResult.y - VALLADO_TEME_REFERENCE.positionKm[1]) ** 2 +
        (pointResult.z - VALLADO_TEME_REFERENCE.positionKm[2]) ** 2,
    );
    const velocityErrorKmPerSec = Math.sqrt(
      (pointResult.vx - VALLADO_TEME_REFERENCE.velocityKmPerSec[0]) ** 2 +
        (pointResult.vy - VALLADO_TEME_REFERENCE.velocityKmPerSec[1]) ** 2 +
        (pointResult.vz - VALLADO_TEME_REFERENCE.velocityKmPerSec[2]) ** 2,
    );

    assert.ok(positionErrorKm < 2e-5, "Vallado TEME position error < 2 cm");
    assert.ok(velocityErrorKmPerSec < 1e-8, "Vallado TEME velocity error < 1e-5 m/s");
  });
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`tudat vallado epoch conversion remains stable on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, ISOMORPHIC_WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const jdResult = await invokeJsonRequest(harness, {
      operation: "epochToJd",
      params: { epoch: VALLADO_GP.EPOCH },
    });

    assert.ok(Math.abs(jdResult.julianDate - 2451723.28495062) < 1e-8);
  });
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`tudat iss-like sgp4 sanity orbit stays in expected bounds on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, ISOMORPHIC_WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const pointResult = await invokeJsonRequest(harness, {
      operation: "propagateToEpoch",
      params: {
        gp: ISS_LIKE_GP,
        targetJd: 2451545.0,
      },
    });

    const positionMagnitude = magnitude3({
      x: pointResult.x,
      y: pointResult.y,
      z: pointResult.z,
    });
    const velocityMagnitude = magnitude3({
      x: pointResult.vx,
      y: pointResult.vy,
      z: pointResult.vz,
    });

    assert.ok(positionMagnitude > 6500.0, "ISS-like orbit radius > 6.5e6 m");
    assert.ok(positionMagnitude < 7000.0, "ISS-like orbit radius < 7.0e6 m");
    assert.ok(velocityMagnitude > 7.0, "ISS-like orbit velocity > 7.0 km/s");
    assert.ok(velocityMagnitude < 8.0, "ISS-like orbit velocity < 8.0 km/s");
  });
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`tudat Lambert elliptical textbook case matches Izzo reference velocities on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, ISOMORPHIC_WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(harness, {
      operation: "solveLambert",
      params: {
        r1: LAMBERT_ELLIPTICAL_CASE.r1,
        r2: LAMBERT_ELLIPTICAL_CASE.r2,
        tofSeconds: LAMBERT_ELLIPTICAL_CASE.tofSeconds,
      },
    });

    assert.equal(result.converged, true);
    for (let index = 0; index < 3; index += 1) {
      assert.ok(
        Math.abs(result.v1[index] - LAMBERT_ELLIPTICAL_CASE.expectedV1[index]) < 1e-3,
        `Expected elliptical departure V${index} to match Tudat within 1e-3 km/s.`,
      );
      assert.ok(
        Math.abs(result.v2[index] - LAMBERT_ELLIPTICAL_CASE.expectedV2[index]) < 1e-3,
        `Expected elliptical arrival V${index} to match Tudat within 1e-3 km/s.`,
      );
    }
    assert.ok(result.v1[1] > 0, "Elliptical case stays prograde like the Tudat source case.");
  });
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`tudat Lambert hyperbolic case matches Izzo reference velocities on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, ISOMORPHIC_WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(harness, {
      operation: "solveLambert",
      params: {
        r1: LAMBERT_HYPERBOLIC_CASE.r1,
        r2: LAMBERT_HYPERBOLIC_CASE.r2,
        tofSeconds: LAMBERT_HYPERBOLIC_CASE.tofSeconds,
      },
    });

    assert.equal(result.converged, true);
    assert.ok(
      Math.abs(result.v1[0] - LAMBERT_HYPERBOLIC_CASE.expectedV1[0]) <
        Math.abs(LAMBERT_HYPERBOLIC_CASE.expectedV1[0]) * 1e-3,
      "Expected hyperbolic radial departure velocity to stay within Tudat's 0.1% envelope.",
    );
    assert.ok(
      Math.abs(result.v1[1] - LAMBERT_HYPERBOLIC_CASE.expectedV1[1]) <
        Math.abs(LAMBERT_HYPERBOLIC_CASE.expectedV1[1]) * 1e-3,
      "Expected hyperbolic transverse departure velocity to stay within Tudat's 0.1% envelope.",
    );
  });
}
