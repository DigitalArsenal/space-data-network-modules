/**
 * Derived from Tudat WASM propagation tests:
 * https://github.com/DigitalArsenal/tudat-wasm/blob/c998d24001af69e60f07cc6a29ddf64c422dd9de/tests/wasm/test_propagation_node.cjs
 *
 * The local fixture under tests/fixtures/tudat.reference.json captures the
 * sampled Tudat state histories for the copied two-body and high-fidelity
 * cases. These checks drive the public HPOP command ABI only, through the SDK
 * browser harness or the WasmEdge loader.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const TUDAT_REFERENCE_PATH = new URL("./fixtures/tudat.reference.json", import.meta.url);

const MU_EARTH = 398600.4418;
const TUDAT_REFERENCE = JSON.parse(
  fs.readFileSync(TUDAT_REFERENCE_PATH, "utf8"),
);

function magnitude3([x, y, z]) {
  return Math.sqrt(x * x + y * y + z * z);
}

function distance3(a, b) {
  return Math.hypot(
    a[0] - b[0],
    a[1] - b[1],
    a[2] - b[2],
  );
}

function orbitalEnergy(state) {
  const radius = magnitude3(state.position);
  const speed = magnitude3(state.velocity);
  return 0.5 * speed * speed - MU_EARTH / radius;
}

function createKeplerianState() {
  const {
    semiMajorAxisKm,
    eccentricity,
    inclinationRad,
    raanRad,
    argPeriapsisRad,
    trueAnomalyRad,
  } = TUDAT_REFERENCE.initialKeplerianElements;

  const p = semiMajorAxisKm * (1 - eccentricity * eccentricity);
  const radius = p / (1 + eccentricity * Math.cos(trueAnomalyRad));
  const perifocalPosition = [
    radius * Math.cos(trueAnomalyRad),
    radius * Math.sin(trueAnomalyRad),
    0,
  ];
  const perifocalVelocity = [
    -Math.sqrt(MU_EARTH / p) * Math.sin(trueAnomalyRad),
    Math.sqrt(MU_EARTH / p) * (eccentricity + Math.cos(trueAnomalyRad)),
    0,
  ];

  const cosO = Math.cos(raanRad);
  const sinO = Math.sin(raanRad);
  const cosI = Math.cos(inclinationRad);
  const sinI = Math.sin(inclinationRad);
  const cosW = Math.cos(argPeriapsisRad);
  const sinW = Math.sin(argPeriapsisRad);

  const rotation = [
    [
      cosO * cosW - sinO * sinW * cosI,
      -cosO * sinW - sinO * cosW * cosI,
      sinO * sinI,
    ],
    [
      sinO * cosW + cosO * sinW * cosI,
      -sinO * sinW + cosO * cosW * cosI,
      -cosO * sinI,
    ],
    [sinW * sinI, cosW * sinI, cosI],
  ];

  const rotate = ([x, y, z]) => [
    rotation[0][0] * x + rotation[0][1] * y + rotation[0][2] * z,
    rotation[1][0] * x + rotation[1][1] * y + rotation[1][2] * z,
    rotation[2][0] * x + rotation[2][1] * y + rotation[2][2] * z,
  ];

  return {
    position: rotate(perifocalPosition),
    velocity: rotate(perifocalVelocity),
  };
}

function makePropagateRequest(targetSeconds, integrator, forces) {
  const initialState = createKeplerianState();
  return {
    operation: "propagate",
    params: {
      epochJD: TUDAT_REFERENCE.epochJulianDate,
      targetJD: TUDAT_REFERENCE.epochJulianDate + targetSeconds / 86400.0,
      position: initialState.position,
      velocity: initialState.velocity,
      integrator,
      forces,
    },
  };
}

async function invokePropagate(harness, targetSeconds, integrator, forces) {
  return invokeJsonRequest(
    harness,
    makePropagateRequest(targetSeconds, integrator, forces),
  );
}

function assertNearTudatSample(result, sample, positionToleranceKm, velocityToleranceKmPerSec) {
  const positionError = distance3(result.position, sample.positionKm);
  const velocityError = distance3(result.velocity, sample.velocityKmPerSec);
  assert.ok(
    positionError <= positionToleranceKm,
    `Expected position error <= ${positionToleranceKm} km, got ${positionError} km at t=${sample.timeSeconds}s`,
  );
  assert.ok(
    velocityError <= velocityToleranceKmPerSec,
    `Expected velocity error <= ${velocityToleranceKmPerSec} km/s, got ${velocityError} km/s at t=${sample.timeSeconds}s`,
  );
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`tudat two-body samples match the copied state history on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, ISOMORPHIC_WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const twoBodyConfig = {
      integrator: {
        method: "RK4",
        initialStep: TUDAT_REFERENCE.twoBody.stepSeconds,
        absTolerance: 1e-12,
        relTolerance: 1e-12,
        maxSteps: 100000,
      },
      forces: {
        pointMass: true,
        j2: false,
        j3: false,
        j4: false,
        thirdBody: false,
        drag: false,
        srp: false,
      },
    };

    const initialState = createKeplerianState();
    const initialEnergy = orbitalEnergy(initialState);

    for (const sample of TUDAT_REFERENCE.twoBody.samples) {
      const result = await invokePropagate(
        harness,
        sample.timeSeconds,
        twoBodyConfig.integrator,
        twoBodyConfig.forces,
      );
      assertNearTudatSample(result, sample, 5e-4, 5e-7);

      const finalState = {
        position: result.position,
        velocity: result.velocity,
      };
      const finalEnergy = orbitalEnergy(finalState);
      assert.ok(
        Math.abs(finalEnergy - initialEnergy) < Math.abs(initialEnergy) * 1e-6,
        "Two-body energy remains conserved within Tudat's original envelope.",
      );
    }
  });
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`tudat high-fidelity samples stay within the copied perturbation envelope on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, ISOMORPHIC_WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const highFidelityConfig = {
      integrator: {
        method: "RK4",
        initialStep: TUDAT_REFERENCE.highFidelity.stepSeconds,
        absTolerance: 1e-12,
        relTolerance: 1e-12,
        maxSteps: 100000,
      },
      forces: {
        pointMass: true,
        j2: true,
        j3: false,
        j4: false,
        maxDegree: 8,
        maxOrder: 8,
        thirdBody: true,
        sun: true,
        moon: false,
        drag: false,
        srp: false,
      },
    };

    const firstSample = TUDAT_REFERENCE.highFidelity.samples[0];
    const lastSample = TUDAT_REFERENCE.highFidelity.samples.at(-1);
    const firstResult = await invokePropagate(
      harness,
      firstSample.timeSeconds,
      highFidelityConfig.integrator,
      highFidelityConfig.forces,
    );
    const lastResult = await invokePropagate(
      harness,
      lastSample.timeSeconds,
      highFidelityConfig.integrator,
      highFidelityConfig.forces,
    );

    const driftKm = distance3(lastResult.position, firstResult.position);
    assert.ok(driftKm > 0.01, "High-fidelity drift stays measurably non-zero (> 10 m).");
    assert.ok(driftKm < 200.0, "High-fidelity drift remains physically bounded (< 200 km).");

    for (const sample of TUDAT_REFERENCE.highFidelity.samples) {
      const result = await invokePropagate(
        harness,
        sample.timeSeconds,
        highFidelityConfig.integrator,
        highFidelityConfig.forces,
      );
      assertNearTudatSample(result, sample, 60.0, 0.05);

      const radiusKm = magnitude3(result.position);
      assert.ok(radiusKm > 6371.0, "Radius stays above Earth's surface.");
      assert.ok(radiusKm < 8000.0, "Radius stays within the original Tudat LEO bound.");
    }
  });
}
