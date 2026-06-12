import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const INVOKE = {
  methodId: "simulate_reentry",
  inputPortId: "scenario",
  outputPortId: "reentry",
};

const EARTH_MU_M3_S2 = 3.986004418e14;
const EARTH_ROTATION_RAD_S = 7.292115e-5;
const EARTH_MEAN_RADIUS_M = 6_371_008.8;
const G0 = 9.80665;

function assertClose(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

// Aerodynamic (non-gravitational, non-frame) acceleration recovered by
// finite-differencing consecutive ECEF samples and removing gravity plus the
// rotating-frame centrifugal/Coriolis terms the integrator applies.
function aeroAccelerationMps2(samples, index) {
  const a = samples[index];
  const b = samples[index + 1];
  const dt = b.elapsedSeconds - a.elapsedSeconds;
  const dv = [0, 1, 2].map(
    (k) => (b.velocityEcefMps[k] - a.velocityEcefMps[k]) / dt,
  );
  const r = [0, 1, 2].map((k) => (a.positionEcefM[k] + b.positionEcefM[k]) / 2);
  const v = [0, 1, 2].map(
    (k) => (a.velocityEcefMps[k] + b.velocityEcefMps[k]) / 2,
  );
  const rMag = Math.hypot(...r);
  const gravity = r.map((x) => (-EARTH_MU_M3_S2 / rMag ** 3) * x);
  const centrifugal = [
    EARTH_ROTATION_RAD_S ** 2 * r[0],
    EARTH_ROTATION_RAD_S ** 2 * r[1],
    0,
  ];
  const coriolis = [
    2 * EARTH_ROTATION_RAD_S * v[1],
    -2 * EARTH_ROTATION_RAD_S * v[0],
    0,
  ];
  return Math.hypot(
    ...[0, 1, 2].map((k) => dv[k] - gravity[k] - centrifugal[k] - coriolis[k]),
  );
}

function peakAeroDeceleration(samples) {
  let peak = 0;
  let peakIndex = 0;
  for (let index = 0; index < samples.length - 1; index += 1) {
    const accel = aeroAccelerationMps2(samples, index);
    if (accel > peak) {
      peak = accel;
      peakIndex = index;
    }
  }
  return {
    accelMps2: peak,
    gLoad: peak / G0,
    elapsedSeconds: samples[peakIndex].elapsedSeconds,
    altitudeM: samples[peakIndex].altitudeM,
    speedMps: samples[peakIndex].speedMps,
  };
}

function inertialSpecificEnergy(sample) {
  const r = sample.positionEcefM;
  const v = sample.velocityEcefMps;
  const vInertial = [
    v[0] - EARTH_ROTATION_RAD_S * r[1],
    v[1] + EARTH_ROTATION_RAD_S * r[0],
    v[2],
  ];
  return (
    0.5 * (vInertial[0] ** 2 + vInertial[1] ** 2 + vInertial[2] ** 2) -
    EARTH_MU_M3_S2 / Math.hypot(...r)
  );
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`reentry simulation composes atmosphere and hypersonics samples on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(
      harness,
      {
        atmosphereProvider: "atmosphere-model",
        hypersonicsProvider: "hypersonics-propagator",
        atmosphereModel: "US76",
        vehicle: {
          referenceAreaM2: 1.2,
          referenceLengthM: 2,
          noseRadiusM: 0.5,
          massKg: 900,
        },
        samples: [
          { id: "entry-interface", elapsedSeconds: 0, altitudeM: 80_000, speedMps: 11_000 },
          { id: "max-q", elapsedSeconds: 110, altitudeM: 10_000, speedMps: 1_500 },
          { id: "impact", elapsedSeconds: 240, altitudeM: 0, speedMps: 200 },
        ],
      },
      INVOKE,
    );

    assert.equal(result.provider, "reentry-analysis");
    assert.equal(result.atmosphereProvider, "atmosphere-model");
    assert.equal(result.hypersonicsProvider, "hypersonics-propagator");
    assert.equal(result.outcome, "impact");
    assert.equal(result.trajectorySamples.length, 3);
    assert.equal(result.peakDynamicPressure.sampleId, "max-q");
    assertClose(result.peakDynamicPressure.valuePa, 465_200, 2_500, "peak dynamic pressure");
    assert.equal(result.peakHeating.sampleId, "entry-interface");
    assert.ok(result.peakHeating.valueWm2 > result.peakDynamicPressure.valuePa);
    assert.equal(result.impactPoint.altitudeM, 0);
  });

  test(`reentry module integrates a physical entry-corridor trajectory on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(
      harness,
      {
        atmosphereProvider: "atmosphere-model",
        hypersonicsProvider: "hypersonics-propagator",
        atmosphereModel: "US76",
        vehicle: {
          name: "Crew Dragon",
          referenceAreaM2: 12.3,
          referenceLengthM: 4.0,
          noseRadiusM: 3.0,
          massKg: 9_616,
        },
        entryInterface: {
          latitudeDeg: 26.5,
          longitudeDeg: -110.0,
          altitudeM: 121_920,
          speedMps: 7_650,
          flightPathAngleDeg: -2.2,
        },
        targetImpact: {
          latitudeDeg: 29.7,
          longitudeDeg: -83.5,
          altitudeM: 0,
        },
        corridor: {
          durationSeconds: 2_500,
          sampleStepSeconds: 2,
        },
        stableOrbit: {
          altitudeM: 420_000,
        },
      },
      INVOKE,
    );

    assert.equal(result.provider, "reentry-analysis");
    assert.equal(result.trajectorySource, "module-generated-entry-corridor");
    assert.equal(result.outcome, "impact");
    const samples = result.trajectorySamples;
    assert.ok(samples.length >= 100, `expected dense sampling, got ${samples.length}`);
    assertClose(samples[0].altitudeM, 121_920, 1, "entry interface altitude");
    assertClose(samples.at(-1).altitudeM, 0, 1, "impact altitude");

    // Real dynamics: altitude must be monotonically non-increasing for this
    // shallow lift-up LEO return only after drag bites; globally it must
    // never exceed the interface altitude and must lose nearly all speed.
    assert.ok(
      Math.max(...samples.map((sample) => sample.altitudeM)) <= 122_500,
      "no spurious lofting above the entry interface",
    );
    assert.ok(samples.at(-1).speedMps < 250, "near-terminal-velocity impact");

    // The initial heading is aimed at the published-target splashdown point;
    // the trajectory must actually advance toward it (downrange grows, track
    // moves north-east), but a 3-DOF integrator does not teleport onto the
    // exact target like the old kinematic corridor generator did.
    assert.ok(samples.at(-1).downrangeM > 1_000_000, "substantial downrange");
    assert.ok(
      samples.at(-1).longitudeDeg > -110.0,
      "track advances eastward toward the target",
    );
    assert.ok(
      samples.at(-1).latitudeDeg > 26.5,
      "track advances northward toward the target",
    );
    assert.ok(result.trajectoryGeometry.maxHeadingStepDeg < 5.0);

    // Per-sample dense kinematics for downstream phase chaining.
    for (const sample of samples) {
      assert.equal(sample.positionEcefM.length, 3);
      assert.equal(sample.velocityEcefMps.length, 3);
      assert.ok(sample.positionEcefM.every(Number.isFinite));
      assert.ok(sample.velocityEcefMps.every(Number.isFinite));
    }
    assert.ok(
      Math.max(
        ...samples.slice(1).map(
          (sample, index) => sample.elapsedSeconds - samples[index].elapsedSeconds,
        ),
      ) <= 2.0 + 1e-9,
      "atmospheric sample cadence at or below 2 s",
    );

    // terminalState contract consumed by stackedMissionPropagator.js.
    const terminal = result.terminalState;
    assert.ok(terminal, "terminalState present");
    assert.equal(terminal.positionEcefM.length, 3);
    assert.equal(terminal.velocityEcefMps.length, 3);
    assert.equal(terminal.massKg, 9_616);
    assertClose(
      terminal.epochOffsetSeconds,
      samples.at(-1).elapsedSeconds,
      1e-6,
      "terminal epoch offset",
    );

    assert.ok(result.deltaV.fromStableOrbitDeorbitMps > 70);
    assert.ok(result.deltaV.fromStableOrbitDeorbitMps < 250);
    assert.equal(result.hypersonicConditions.length, samples.length);
  });

  test(`ballistic entry matches the Allen-Eggers closed form (NACA Report 1381) on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    // Allen & Eggers, "A Study of the Motion and Aerodynamic Heating of
    // Ballistic Missiles Entering the Earth's Atmosphere at High Supersonic
    // Speeds", NACA Report 1381 (1958), https://ntrs.nasa.gov/citations/19930091020.
    // Published atmosphere parameters (report p. 2-3):
    //   rho = rho0 * exp(-beta*y), rho0 = 0.0034 slug/ft^3, 1/beta = 22,000 ft.
    // Closed form (gravity-neglected, straight-line, constant-gamma):
    //   a_max   = beta * V_E^2 * sin(theta_E) / (2 e)
    //   y@a_max = (1/beta) * ln(rho0 / (beta * B * sin(theta_E))),  B = m/(Cd*A)
    //   V@a_max = V_E / sqrt(e)
    const SLUG_PER_FT3_TO_KG_PER_M3 = 515.378818;
    const rho0 = 0.0034 * SLUG_PER_FT3_TO_KG_PER_M3; // 1.7523 kg/m^3
    const scaleHeightM = 22_000 * 0.3048; // 6705.6 m
    const massKg = 1_000;
    const dragCoefficient = 1.0;
    const areaM2 = 1.0;
    const ballisticCoefficient = massKg / (dragCoefficient * areaM2);
    const entrySpeedMps = 11_000;
    const entryAngleDeg = 60; // steep: the closed form neglects gravity
    const sinTheta = Math.sin((entryAngleDeg * Math.PI) / 180);

    const result = await invokeJsonRequest(
      harness,
      {
        atmosphereModel: "EXPONENTIAL",
        atmosphereRho0KgM3: rho0,
        atmosphereScaleHeightM: scaleHeightM,
        vehicle: {
          referenceAreaM2: areaM2,
          referenceLengthM: 1,
          noseRadiusM: 0.5,
          massKg,
          dragCoefficient,
          liftToDragRatio: 0,
        },
        entryInterface: {
          latitudeDeg: 0,
          longitudeDeg: 0,
          altitudeM: 100_000,
          speedMps: entrySpeedMps,
          flightPathAngleDeg: -entryAngleDeg,
          headingDeg: 90,
        },
        corridor: {
          durationSeconds: 200,
          sampleStepSeconds: 0.05,
          terminalAltitudeM: 3_000,
        },
      },
      INVOKE,
    );

    const samples = result.trajectorySamples;
    const peak = peakAeroDeceleration(samples);

    const aMaxTheory = (entrySpeedMps ** 2 * sinTheta) / (2 * Math.E * scaleHeightM);
    const altitudeTheory =
      scaleHeightM * Math.log((rho0 * scaleHeightM) / (ballisticCoefficient * sinTheta));
    const speedAtPeakTheory = entrySpeedMps / Math.sqrt(Math.E);

    // <=2% agreement on both peak-deceleration magnitude and altitude. The
    // residual is dominated by physics the closed form deliberately neglects
    // (gravity along the path, Earth curvature/rotation), not by integration
    // error (vacuum energy drift of this RK4 is ~1e-12 over 3000 s).
    assertClose(
      peak.accelMps2,
      aMaxTheory,
      0.02 * aMaxTheory,
      "Allen-Eggers peak deceleration magnitude",
    );
    assertClose(
      peak.altitudeM,
      altitudeTheory,
      0.02 * altitudeTheory,
      "Allen-Eggers peak deceleration altitude",
    );
    assertClose(
      peak.speedMps,
      speedAtPeakTheory,
      0.03 * speedAtPeakTheory,
      "Allen-Eggers speed at peak deceleration (V_E / sqrt(e))",
    );
  });

  test(`Apollo 11 class lunar-return entry produces published-range load factors on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    // Apollo 11 Mission Report (MSC-00171) and Entry Postflight Analysis
    // (Mission Report Supplement 10): EI at 400,000 ft (121.92 km), inertial
    // velocity 36,194.368 ft/s (11.0320 km/s), inertial flight-path angle
    // -6.48 deg (BET -6.5230 deg), first maximum load factor 6.73 g at
    // EI+82 s, second maximum 6.00 g. The capsule flew L/D ~0.30 with a
    // guidance-driven bank schedule; a constant 55-deg bank is a simplified
    // stand-in, so the published +-0.3 g BET tolerance is widened to +-1.2 g
    // and the peak-time gate to EI+[60, 130] s.
    const entryLatDeg = -3.19;
    const headingDeg = 62.0; // Earth-relative azimuth near the BET inertial 50.18 deg
    const inertialSpeedMps = 11_032.0;
    const rotationBoost =
      EARTH_ROTATION_RAD_S *
      (EARTH_MEAN_RADIUS_M + 121_920) *
      Math.cos((entryLatDeg * Math.PI) / 180) *
      Math.sin((headingDeg * Math.PI) / 180);
    const entrySpeedMps = inertialSpeedMps - rotationBoost;

    const apolloVehicle = {
      referenceAreaM2: 12.02, // 154.4 mm-scale: pi * (3.912 m / 2)^2 command module
      referenceLengthM: 3.91,
      noseRadiusM: 4.69, // CM aft heat-shield spherical radius
      massKg: 5_470,
      dragCoefficient: 1.27,
      liftToDragRatio: 0.3,
    };
    const entryInterface = {
      latitudeDeg: entryLatDeg,
      longitudeDeg: 171.96,
      altitudeM: 121_920,
      speedMps: entrySpeedMps,
      flightPathAngleDeg: -6.52,
      headingDeg,
    };

    const lifting = await invokeJsonRequest(
      harness,
      {
        atmosphereModel: "US76",
        vehicle: apolloVehicle,
        entryInterface,
        corridor: {
          durationSeconds: 1_200,
          sampleStepSeconds: 1,
          terminalAltitudeM: 7_100, // published nominal drogue altitude 23,300 ft
          bankAngleDeg: 55,
        },
      },
      INVOKE,
    );
    const liftingPeak = peakAeroDeceleration(lifting.trajectorySamples);
    assert.ok(
      liftingPeak.gLoad > 6.73 - 1.2 && liftingPeak.gLoad < 6.73 + 1.2,
      `lifting-entry peak load ${liftingPeak.gLoad} g should bracket the published 6.73 g`,
    );
    assert.ok(
      liftingPeak.elapsedSeconds > 60 && liftingPeak.elapsedSeconds < 130,
      `peak load time ${liftingPeak.elapsedSeconds} s should bracket the published EI+82 s`,
    );
    assert.ok(
      liftingPeak.altitudeM > 40_000 && liftingPeak.altitudeM < 70_000,
      `peak load altitude ${liftingPeak.altitudeM} m in the sensible-deceleration band`,
    );

    const ballistic = await invokeJsonRequest(
      harness,
      {
        atmosphereModel: "US76",
        vehicle: { ...apolloVehicle, liftToDragRatio: 0 },
        entryInterface,
        corridor: {
          durationSeconds: 1_200,
          sampleStepSeconds: 1,
          terminalAltitudeM: 7_100,
        },
      },
      INVOKE,
    );
    const ballisticPeak = peakAeroDeceleration(ballistic.trajectorySamples);
    assert.ok(
      ballisticPeak.gLoad > liftingPeak.gLoad + 2,
      `removing lift must sharply raise peak load (ballistic ${ballisticPeak.gLoad} g vs lifting ${liftingPeak.gLoad} g)`,
    );
  });

  test(`vacuum coast preserves inertial orbital energy on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const orbitRadiusM = EARTH_MEAN_RADIUS_M + 300_000;
    const circularSpeedMps = Math.sqrt(EARTH_MU_M3_S2 / orbitRadiusM);
    const result = await invokeJsonRequest(
      harness,
      {
        atmosphereModel: "US76",
        vehicle: { referenceAreaM2: 12.3, massKg: 9_616 },
        initialState: {
          positionEcefM: [orbitRadiusM, 0, 0],
          velocityEcefMps: [0, circularSpeedMps - EARTH_ROTATION_RAD_S * orbitRadiusM, 0],
          massKg: 9_616,
        },
        corridor: {
          durationSeconds: 3_000,
          sampleStepSeconds: 10,
          terminalAltitudeM: 0,
        },
      },
      INVOKE,
    );

    const samples = result.trajectorySamples;
    assert.equal(result.outcome, "duration-cap");
    const initialEnergy = inertialSpecificEnergy(samples[0]);
    for (const sample of samples) {
      const drift = Math.abs(
        (inertialSpecificEnergy(sample) - initialEnergy) / initialEnergy,
      );
      assert.ok(
        drift < 1e-9,
        `relative energy drift ${drift} at t=${sample.elapsedSeconds}s exceeds 1e-9`,
      );
    }
  });

  test(`generated samples are kinematically smooth on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(
      harness,
      {
        atmosphereModel: "US76",
        vehicle: { referenceAreaM2: 12.3, referenceLengthM: 4.0, noseRadiusM: 3.0, massKg: 9_616 },
        entryInterface: {
          latitudeDeg: 24.0,
          longitudeDeg: -100.0,
          altitudeM: 121_920,
          speedMps: 7_600,
          flightPathAngleDeg: -2.0,
          headingDeg: 65,
        },
        corridor: { durationSeconds: 2_500, sampleStepSeconds: 2 },
      },
      INVOKE,
    );

    const samples = result.trajectorySamples;
    assert.ok(samples.length > 200);
    for (let index = 1; index < samples.length; index += 1) {
      const a = samples[index - 1];
      const b = samples[index];
      const dt = b.elapsedSeconds - a.elapsedSeconds;
      if (dt <= 0) {
        continue;
      }
      const error = Math.hypot(
        ...[0, 1, 2].map(
          (k) =>
            b.positionEcefM[k] -
            a.positionEcefM[k] -
            ((a.velocityEcefMps[k] + b.velocityEcefMps[k]) / 2) * dt,
        ),
      );
      // Midpoint-rule consistency: |delta_r - v_mean*dt| is bounded by the
      // jerk term ~ |a_dot| dt^3 / 12; measured maximum is ~0.19 m at 2 s
      // cadence through peak deceleration.
      assert.ok(
        error < 1.0,
        `sample ${index}: |delta_r - v_mean*dt| = ${error} m exceeds 1 m over dt=${dt}s`,
      );
    }
  });

  test(`initialState seeds a continuing phase exactly from terminalState on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const baseRequest = {
      atmosphereModel: "US76",
      vehicle: { referenceAreaM2: 12.3, referenceLengthM: 4.0, noseRadiusM: 3.0, massKg: 9_616 },
      entryInterface: {
        latitudeDeg: 24.0,
        longitudeDeg: -100.0,
        altitudeM: 121_920,
        speedMps: 7_600,
        flightPathAngleDeg: -2.0,
        headingDeg: 65,
      },
      corridor: { durationSeconds: 300, sampleStepSeconds: 2 },
    };
    const first = await invokeJsonRequest(harness, baseRequest, INVOKE);
    assert.equal(first.outcome, "duration-cap");
    const seam = first.terminalState;

    const second = await invokeJsonRequest(
      harness,
      {
        atmosphereModel: "US76",
        vehicle: baseRequest.vehicle,
        initialState: seam,
        corridor: { durationSeconds: 2_500, sampleStepSeconds: 2 },
      },
      INVOKE,
    );

    const resumed = second.trajectorySamples[0];
    for (let k = 0; k < 3; k += 1) {
      assertClose(
        resumed.positionEcefM[k],
        seam.positionEcefM[k],
        1e-3,
        `resumed position component ${k}`,
      );
      assertClose(
        resumed.velocityEcefMps[k],
        seam.velocityEcefMps[k],
        1e-6,
        `resumed velocity component ${k}`,
      );
    }
    assert.equal(resumed.massKg, seam.massKg);
    assertClose(
      second.terminalState.epochOffsetSeconds,
      seam.epochOffsetSeconds + second.trajectorySamples.at(-1).elapsedSeconds,
      1e-6,
      "epoch offset accumulates across phases",
    );
  });

  test(`Crew Dragon entry hits the published drogue-deploy gate on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    // NASA Commercial Crew coverage (Demo-2 and later, e.g.
    // x.com/nasa/status/1289247461152886784): drogue deploy at roughly
    // 18,000 ft (5.49 km) at about 350 mph (156 m/s). A constant hypersonic
    // Cd (1.3) overestimates subsonic drag, so the gate is generous.
    const result = await invokeJsonRequest(
      harness,
      {
        atmosphereModel: "US76",
        vehicle: {
          name: "Crew Dragon",
          referenceAreaM2: 12.3,
          referenceLengthM: 4.0,
          noseRadiusM: 3.0,
          massKg: 9_616,
        },
        entryInterface: {
          latitudeDeg: 24.0,
          longitudeDeg: -100.0,
          altitudeM: 121_920,
          speedMps: 7_600,
          flightPathAngleDeg: -2.0,
          headingDeg: 65,
        },
        corridor: {
          durationSeconds: 2_500,
          sampleStepSeconds: 2,
          terminalAltitudeM: 5_486, // 18,000 ft drogue gate
        },
      },
      INVOKE,
    );

    assert.equal(result.outcome, "terminal-altitude");
    const last = result.trajectorySamples.at(-1);
    assertClose(last.altitudeM, 5_486, 5, "drogue-gate altitude");
    assert.ok(
      last.speedMps > 100 && last.speedMps < 220,
      `drogue-gate speed ${last.speedMps} m/s should bracket the published ~156 m/s`,
    );

    const peak = peakAeroDeceleration(result.trajectorySamples);
    assert.ok(
      peak.gLoad > 2.5 && peak.gLoad < 5.5,
      `LEO-return peak load ${peak.gLoad} g should be in the published Crew Dragon 3-5 g class`,
    );
  });
}
