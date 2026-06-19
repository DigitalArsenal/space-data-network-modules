import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const INVOKE = {
  methodId: "simulate_launch_ascent",
  inputPortId: "ascent",
  outputPortId: "launch",
  inputTypeRef: {
    schemaName: "LDM.fbs",
    fileIdentifier: "$LDM",
    rootTypeName: "LDM",
  },
};

const EARTH_MU_M3_S2 = 3.986004418e14;
const EARTH_ROTATION_RAD_S = 7.292115e-5;
const EARTH_MEAN_RADIUS_M = 6_371_008.8;

function assertClose(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${actual} to be within ${tolerance} of ${expected}`,
  );
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

// Falcon 9 Block 5 / Crew Dragon to a 200 km / 51.6 deg-class parking orbit.
// Launch azimuth 45 deg is the ISS-inclination azimuth from LC-39A
// (sin(az) = cos(51.6)/cos(28.6)); the module's built-in default stages carry
// the published Falcon 9 Block 5 parameters (see module.cpp header citations).
const falcon9CrewDragonRequest = Object.freeze({
  atmosphereProvider: "atmosphere-model",
  hypersonicsProvider: "hypersonics-propagator",
  atmosphereModel: "US76",
  vehicle: {
    name: "Falcon 9 Block 5 / Crew Dragon",
    referenceAreaM2: 10.75,
    referenceLengthM: 3.7,
    noseRadiusM: 1.85,
    massKg: 549_000,
  },
  launchSite: {
    name: "KSC LC-39A",
    latitudeDeg: 28.608389,
    longitudeDeg: -80.604333,
    altitudeM: 3,
  },
  targetOrbit: {
    altitudeM: 200_000,
    inclinationDeg: 51.64,
    azimuthDeg: 45,
    insertionSpeedMps: 7790,
  },
  guidance: {
    durationSeconds: 700,
    sampleStepSeconds: 15,
  },
});

function cloneRequest(overrides = {}) {
  return {
    ...falcon9CrewDragonRequest,
    ...overrides,
    vehicle: {
      ...falcon9CrewDragonRequest.vehicle,
      ...overrides.vehicle,
    },
    launchSite: {
      ...falcon9CrewDragonRequest.launchSite,
      ...overrides.launchSite,
    },
    targetOrbit: {
      ...falcon9CrewDragonRequest.targetOrbit,
      ...overrides.targetOrbit,
    },
    guidance: {
      ...falcon9CrewDragonRequest.guidance,
      ...overrides.guidance,
    },
  };
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`launch ascent simulation composes atmosphere and hypersonics samples on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(
      runtimeKind,
      WASM_PATH,
      t,
    );
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
          massKg: 12_000,
        },
        samples: [
          {
            id: "liftoff",
            elapsedSeconds: 0,
            altitudeM: 0,
            speedMps: 0,
            massKg: 12_000,
          },
          {
            id: "max-q",
            elapsedSeconds: 55,
            altitudeM: 10_000,
            speedMps: 1_500,
            massKg: 9_500,
          },
          {
            id: "upper-stage",
            elapsedSeconds: 180,
            altitudeM: 30_000,
            speedMps: 2_200,
            massKg: 5_000,
          },
        ],
      },
      INVOKE,
    );

    assert.equal(result.provider, "launch-ascent-analysis");
    assert.equal(result.status, "nominal");
    assert.equal(result.maxDynamicPressure.sampleId, "max-q");
    assertClose(
      result.maxDynamicPressure.valuePa,
      465_200,
      2_500,
      "max dynamic pressure",
    );
    assert.ok(result.maxMach.value > 7);
    assert.deepEqual(
      result.events.map((entry) => entry.event),
      ["liftoff", "max_dynamic_pressure", "ascent_complete"],
    );
    assert.equal(result.hypersonicConditions.length, 3);
  });

  test(`launch ascent integrates to a closed-loop SECO on the target orbit on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(
      runtimeKind,
      WASM_PATH,
      t,
    );
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(harness, cloneRequest(), INVOKE);

    assert.equal(result.provider, "launch-ascent-analysis");
    assert.equal(result.trajectorySource, "module-generated-target-orbit");
    const samples = result.trajectorySamples;
    assert.ok(samples.length >= 35);
    assert.equal(
      samples[0].phase,
      "liftoff",
      "first generated sample should be liftoff",
    );
    assert.equal(
      samples.at(-1).phase,
      "orbital-insertion",
      "last generated sample should be orbital insertion",
    );
    assert.ok(result.launchTrajectory.secoReached, "closed-loop SECO reached");

    // SECO cuts on the target circular-orbit specific energy, so the exact
    // numbers to check are the inertial orbit elements, not the ECEF speed.
    const orbit = result.achievedOrbit;
    assertClose(orbit.inertialSpeedMps, 7_790, 30, "inertial insertion speed");
    assert.ok(
      orbit.eccentricity < 0.01,
      `near-circular orbit, e=${orbit.eccentricity}`,
    );
    assertClose(orbit.apoapsisM, 200_000, 15_000, "apoapsis");
    assertClose(orbit.periapsisM, 200_000, 15_000, "periapsis");
    assertClose(orbit.inclinationDeg, 51.6, 3.0, "ISS-class inclination");
    assertClose(samples.at(-1).altitudeM, 200_000, 5_000, "insertion altitude");
    assert.ok(samples.at(-1).speedMps > 7_300, "ECEF insertion speed");

    // Heading is velocity-derived; during the near-vertical first seconds the
    // horizontal component is tiny, so steps are bounded loosely overall and
    // tightly once the vehicle is downrange.
    assert.ok(result.launchTrajectory.maxHeadingStepDeg < 25.0);

    assert.ok(result.deltaV.fromStationaryLaunchMps > 8_800);
    assert.ok(result.deltaV.fromStationaryLaunchMps < 10_500);
    assert.ok(result.deltaV.earthRotationBoostMps > 250);
    assert.ok(
      result.deltaV.gravityLossMps > 1_000,
      "gravity loss integrated along trajectory",
    );
    assert.ok(result.deltaV.fromStableOrbitDeorbitMps > 40);
    assert.ok(result.deltaV.fromStableOrbitDeorbitMps < 200);
    assert.equal(result.hypersonicConditions.length, samples.length);

    // Dense ECEF kinematics on every sample plus the terminalState contract
    // consumed by stackedMissionPropagator.js.
    for (const sample of samples) {
      assert.ok(sample.positionEcefM.every(Number.isFinite));
      assert.ok(sample.velocityEcefMps.every(Number.isFinite));
      assert.ok(Number.isFinite(sample.massKg));
    }
    const terminal = result.terminalState;
    assert.ok(terminal, "terminalState present");
    assert.equal(terminal.positionEcefM.length, 3);
    assert.equal(terminal.velocityEcefMps.length, 3);
    assert.ok(terminal.massKg > 12_500 && terminal.massKg < 549_000);
    assertClose(
      terminal.epochOffsetSeconds,
      samples.at(-1).elapsedSeconds,
      1e-6,
      "terminal epoch offset",
    );
  });

  test(`launch ascent matches Crew Dragon Demo-1 published telemetry checkpoints on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(
      runtimeKind,
      WASM_PATH,
      t,
    );
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    // Published reference: shahar603/Telemetry-Data (Crew Dragon Demo-1
    // webcast telemetry, github.com/shahar603/Telemetry-Data,
    // DM-1/JSON/{events,analysed}.json): maxq=59 s; MECO at T+158 s with
    // 1881 m/s at 85.3 km; last stage-2 frame at T+548.9 s with 7547 m/s at
    // 198 km (~SECO-1; NASA/SpaceX Demo-2 press kit lists SECO-1 at 8:47).
    // Vehicle constants are the module defaults: SpaceX Falcon 9 Block 5
    // public figures plus spaceflight101.com mass estimates (stage masses
    // are not officially published).
    //
    // Tolerances are deliberately generous and justified: stage propellant
    // and dry masses are public engineering estimates, Cd is constant, the
    // max-Q throttle bucket is a two-point approximation of the real
    // closed-loop profile, and webcast OCR itself quantizes the reference.
    const result = await invokeJsonRequest(
      harness,
      cloneRequest({
        guidance: { durationSeconds: 700, sampleStepSeconds: 2 },
      }),
      INVOKE,
    );
    const samples = result.trajectorySamples;
    const sampleAt = (time) =>
      samples.reduce((best, sample) =>
        Math.abs(sample.elapsedSeconds - time) <
        Math.abs(best.elapsedSeconds - time)
          ? sample
          : best,
      );

    // Max-Q window: published event at T+59 s (throttle bucket 44-71 s).
    assert.ok(
      result.maxDynamicPressure.elapsedSeconds > 35 &&
        result.maxDynamicPressure.elapsedSeconds < 80,
      `max-Q at ${result.maxDynamicPressure.elapsedSeconds} s should fall in the published throttle bucket`,
    );
    const maxQ = sampleAt(59);
    assertClose(
      maxQ.speedMps,
      281,
      100,
      "T+59 s speed vs DM-1 webcast 281 m/s",
    );
    assertClose(
      maxQ.altitudeM,
      7_600,
      3_000,
      "T+59 s altitude vs DM-1 webcast 7.6 km",
    );

    // Mid first-stage checkpoints.
    assertClose(
      sampleAt(120).speedMps,
      1_050,
      160,
      "T+120 s speed vs DM-1 webcast 1050 m/s",
    );
    assertClose(
      sampleAt(120).altitudeM,
      41_400,
      6_000,
      "T+120 s altitude vs DM-1 webcast 41.4 km",
    );
    assertClose(
      sampleAt(150).speedMps,
      1_715,
      260,
      "T+150 s speed vs DM-1 webcast 1715 m/s",
    );
    assertClose(
      sampleAt(150).altitudeM,
      74_600,
      11_000,
      "T+150 s altitude vs DM-1 webcast 74.6 km",
    );

    // MECO: scheduled at the published T+158 s; state must bracket telemetry.
    const meco = result.phaseEvents.find((event) => event.event === "meco");
    assert.ok(meco, "meco phase event present");
    assertClose(meco.elapsedSeconds, 158, 1, "MECO time");
    assertClose(
      meco.speedMps,
      1_881,
      290,
      "MECO speed vs DM-1 webcast 1881 m/s (±15%)",
    );
    assertClose(
      meco.altitudeM,
      85_300,
      10_000,
      "MECO altitude vs DM-1 webcast 85.3 km",
    );

    // Stage-2 ignition: published SES-1 at T+169 s.
    const ses1 = result.phaseEvents.find(
      (event) => event.event === "stage2_ignition",
    );
    assert.ok(ses1, "stage2_ignition phase event present");
    assertClose(ses1.elapsedSeconds, 169, 1, "SES-1 time");

    // SECO: closed-loop cutoff vs the published last stage-2 frame.
    const seco = result.phaseEvents.find((event) => event.event === "seco");
    assert.ok(seco, "seco phase event present");
    assertClose(
      seco.elapsedSeconds,
      548.9,
      45,
      "SECO time vs DM-1 last frame T+548.9 s",
    );
    assertClose(
      seco.speedMps,
      7_547,
      250,
      "SECO speed vs DM-1 webcast 7547 m/s",
    );
    assertClose(
      seco.altitudeM,
      198_000,
      8_000,
      "SECO altitude vs DM-1 webcast 198 km",
    );
  });

  test(`launch ascent upper-stage throttle materially changes the achieved orbit on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(
      runtimeKind,
      WASM_PATH,
      t,
    );
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const fullThrottle = await invokeJsonRequest(
      harness,
      cloneRequest({
        guidance: {
          durationSeconds: 900,
          throttleSchedule: [
            { elapsedSeconds: 0, throttle: 1.0 },
            { elapsedSeconds: 180, throttle: 1.0 },
          ],
        },
      }),
      INVOKE,
    );
    const reducedThrottle = await invokeJsonRequest(
      harness,
      cloneRequest({
        guidance: {
          durationSeconds: 900,
          throttleSchedule: [
            { elapsedSeconds: 0, throttle: 1.0 },
            { elapsedSeconds: 180, throttle: 0.62 },
          ],
        },
      }),
      INVOKE,
    );

    assert.ok(
      Number.isFinite(fullThrottle.achievedOrbit?.apoapsisM),
      "full-throttle run should report achieved orbit",
    );
    assert.ok(
      Number.isFinite(reducedThrottle.achievedOrbit?.apoapsisM),
      "reduced-throttle run should report achieved orbit",
    );
    assert.ok(
      fullThrottle.launchTrajectory.secoReached,
      "full throttle reaches SECO",
    );
    // Throttling the upper stage to 62% drops its thrust-to-weight enough
    // that gravity losses keep it from ever reaching the target orbital
    // energy: with real dynamics the run must not reach SECO and must end
    // with materially less energy, unlike the old kinematic generator that
    // simply rescaled the same path.
    assert.ok(
      !reducedThrottle.launchTrajectory.secoReached,
      "reduced throttle starves the insertion of energy",
    );
    assert.ok(
      reducedThrottle.insertionState.speedMps <
        fullThrottle.insertionState.speedMps - 250,
      "reducing throttle should lower insertion speed",
    );
    assert.ok(
      reducedThrottle.achievedOrbit.apoapsisM <
        fullThrottle.achievedOrbit.apoapsisM - 50_000,
      "reducing throttle should lower the achieved apoapsis",
    );
  });

  test(`explicit staged boost continues past target-orbit energy on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(
      runtimeKind,
      WASM_PATH,
      t,
    );
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(
      harness,
      cloneRequest({
        guidance: {
          durationSeconds: 940,
          sampleStepSeconds: 10,
          explicitStagePlan: true,
          continueAfterTargetOrbit: true,
          boosterMultiplier: 9.0,
          stages: [
            {
              name: "Booster ascent",
              startSeconds: 0,
              endSeconds: 158,
              throttle: 1.0,
            },
            {
              name: "Upper insertion",
              startSeconds: 169,
              endSeconds: 700,
              throttle: 1.0,
            },
            {
              name: "Stage 3",
              startSeconds: 700,
              endSeconds: 820,
              throttle: 1.1,
            },
            {
              name: "Stage 4",
              startSeconds: 820,
              endSeconds: 940,
              throttle: 1.1,
            },
          ],
          throttleSchedule: [
            { elapsedSeconds: 0, throttle: 1.0 },
            { elapsedSeconds: 158, throttle: 0.0 },
            { elapsedSeconds: 169, throttle: 1.0 },
            { elapsedSeconds: 700, throttle: 1.1 },
            { elapsedSeconds: 820, throttle: 1.1 },
            { elapsedSeconds: 940, throttle: 0.0 },
          ],
        },
      }),
      INVOKE,
    );

    const samples = result.trajectorySamples;
    assert.ok(samples.length >= 90, "extended boost should emit dense samples");
    assert.ok(
      result.launchTrajectory.targetOrbitEnergyReached,
      "extended boost crosses target-orbit energy",
    );
    assert.ok(
      result.launchTrajectory.secoReached,
      "extended boost records a terminal cutoff",
    );
    const phaseEventNames = result.phaseEvents.map((event) => event.event);
    assert.ok(
      phaseEventNames.includes("stage3_ignition"),
      "explicit guidance stage rows must ignite stage 3",
    );
    assert.ok(
      phaseEventNames.includes("stage3_cutoff"),
      "explicit guidance stage rows must burn stage 3 to cutoff",
    );
    assert.ok(
      phaseEventNames.includes("stage4_ignition"),
      "explicit guidance stage rows must ignite stage 4",
    );
    assert.ok(
      phaseEventNames.includes("stage4_cutoff"),
      "explicit guidance stage rows must burn stage 4 to cutoff",
    );
    assert.ok(
      result.insertionState.elapsedSeconds >= 930,
      `terminal insertion should be near the requested 940 s, got ${result.insertionState.elapsedSeconds}`,
    );
    assert.equal(samples.at(-1).phase, "orbital-insertion");
    assert.ok(
      result.achievedOrbit.inertialSpeedMps > 8_000,
      "continued physical boost should raise terminal inertial speed",
    );
    assert.ok(
      result.achievedOrbit.apoapsisM > 13_200_000,
      `post-target prograde burn should raise apoapsis beyond 13,200 km, got ${result.achievedOrbit.apoapsisM}`,
    );
    assert.ok(
      result.achievedOrbit.specificEnergyJkg > -15_300_000,
      `post-target prograde burn should raise specific energy, got ${result.achievedOrbit.specificEnergyJkg}`,
    );
    assert.ok(
      result.deltaV.fromStationaryLaunchMps > 10_200,
      "continued physical boost should raise reported launch delta-v",
    );
  });

  test(`explicit staged boost remains orbital with maximum booster scaling on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(
      runtimeKind,
      WASM_PATH,
      t,
    );
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(
      harness,
      cloneRequest({
        guidance: {
          durationSeconds: 940,
          sampleStepSeconds: 10,
          explicitStagePlan: true,
          continueAfterTargetOrbit: true,
          boosterMultiplier: 9.0,
          stages: [
            {
              name: "Booster ascent",
              startSeconds: 0,
              endSeconds: 158,
              throttle: 1.0,
            },
            {
              name: "Upper insertion",
              startSeconds: 169,
              endSeconds: 700,
              throttle: 1.0,
            },
            {
              name: "Stage 3",
              startSeconds: 700,
              endSeconds: 820,
              throttle: 1.1,
            },
            {
              name: "Stage 4",
              startSeconds: 820,
              endSeconds: 940,
              throttle: 1.1,
            },
          ],
          throttleSchedule: [
            { elapsedSeconds: 0, throttle: 1.0 },
            { elapsedSeconds: 158, throttle: 0.0 },
            { elapsedSeconds: 169, throttle: 1.0 },
            { elapsedSeconds: 700, throttle: 1.1 },
            { elapsedSeconds: 820, throttle: 1.1 },
            { elapsedSeconds: 940, throttle: 0.0 },
          ],
        },
      }),
      INVOKE,
    );

    assert.ok(
      result.launchTrajectory.targetOrbitEnergyReached,
      "booster-scaled explicit boost should still cross target-orbit energy",
    );
    assert.ok(
      result.achievedOrbit.periapsisM > 80_000,
      `booster-scaled terminal periapsis ${result.achievedOrbit.periapsisM} should stay above reentry interface`,
    );
    assert.ok(
      result.maxDynamicPressure.valuePa < 80_000,
      `booster-scaled max-Q ${result.maxDynamicPressure.valuePa} Pa should remain in a controlled ascent envelope`,
    );
  });

  test(`Sandcastle staged boost request reaches the farthest physical trajectory at UI max boosters on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(
      runtimeKind,
      WASM_PATH,
      t,
    );
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(
      harness,
      cloneRequest({
        vehicle: {
          name: "Falcon 9 Block 5 / Crew Dragon",
        },
        targetOrbit: {
          reentryInterfaceAltitudeM: 80_000,
        },
        guidance: {
          durationSeconds: 940,
          sampleStepSeconds: 10,
          explicitStagePlan: true,
          continueAfterTargetOrbit: true,
          boosterMultiplier: 100.0,
          stages: [
            {
              name: "Booster ascent",
              startSeconds: 0,
              endSeconds: 158,
              throttle: 1.0,
            },
            {
              name: "Upper insertion",
              startSeconds: 169,
              endSeconds: 700,
              throttle: 1.0,
            },
            {
              name: "Stage 3",
              startSeconds: 700,
              endSeconds: 820,
              throttle: 1.1,
            },
            {
              name: "Stage 4",
              startSeconds: 820,
              endSeconds: 940,
              throttle: 1.1,
            },
          ],
        },
      }),
      INVOKE,
    );

    assert.ok(
      result.launchTrajectory.targetOrbitEnergyReached,
      "UI max boosters should still cross target-orbit energy",
    );
    assert.ok(
      result.launchTrajectory.continuedAfterTargetOrbit,
      "UI max boosters should keep burning after target-orbit energy",
    );
    assert.ok(
      !result.launchTrajectory.impactReached,
      "UI max boosters should not terminate at impact",
    );
    assert.equal(result.trajectorySamples.at(-1).phase, "orbital-insertion");
    assert.ok(
      ["elliptic", "escape"].includes(result.achievedOrbit.orbitClass),
      `UI max boosters should return an orbital/escape conic, got ${result.achievedOrbit.orbitClass}`,
    );
    assert.ok(
      result.achievedOrbit.apoapsisM > 7_000_000 ||
        result.achievedOrbit.orbitClass === "escape",
      `UI max boosters should produce a high-energy terminal trajectory, got apoapsis ${result.achievedOrbit.apoapsisM} and class ${result.achievedOrbit.orbitClass}`,
    );
    assert.ok(
      result.deltaV.fromStationaryLaunchMps > 11_000,
      "UI max boosters should raise reported launch delta-v",
    );
  });

  test(`failed explicit staged boost terminates at impact instead of tunneling through Earth on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(
      runtimeKind,
      WASM_PATH,
      t,
    );
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(
      harness,
      cloneRequest({
        guidance: {
          durationSeconds: 940,
          sampleStepSeconds: 10,
          explicitStagePlan: true,
          continueAfterTargetOrbit: true,
          boosterMultiplier: 1.0,
          stages: [
            {
              name: "Booster ascent",
              startSeconds: 0,
              endSeconds: 158,
              throttle: 1.0,
            },
            {
              name: "Upper insertion",
              startSeconds: 169,
              endSeconds: 700,
              throttle: 1.0,
            },
            {
              name: "Stage 3",
              startSeconds: 700,
              endSeconds: 820,
              throttle: 1.1,
            },
            {
              name: "Stage 4",
              startSeconds: 820,
              endSeconds: 940,
              throttle: 1.1,
            },
          ],
        },
      }),
      INVOKE,
    );

    const samples = result.trajectorySamples;
    const last = samples.at(-1);
    assert.ok(
      result.launchTrajectory.impactReached,
      "failed explicit stack should report ground impact",
    );
    assert.equal(last.phase, "ascent-impact");
    assert.ok(
      last.altitudeM >= -1.0,
      `terminal altitude ${last.altitudeM} m should not tunnel below Earth`,
    );
    assert.ok(
      result.phaseEvents.some((event) => event.event === "impact"),
      "impact event should be emitted",
    );
  });

  test(`vacuum coast preserves inertial orbital energy on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(
      runtimeKind,
      WASM_PATH,
      t,
    );
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
        vehicle: { referenceAreaM2: 10.75, massKg: 20_000 },
        initialState: {
          positionEcefM: [orbitRadiusM, 0, 0],
          velocityEcefMps: [
            0,
            circularSpeedMps - EARTH_ROTATION_RAD_S * orbitRadiusM,
            0,
          ],
          massKg: 20_000,
        },
        stages: [
          {
            thrustVacuumN: 0,
            thrustSeaLevelN: 0,
            ispVacuumS: 300,
            burnSeconds: 0,
            propellantMassKg: 0,
            dryMassKg: 0,
          },
        ],
        targetOrbit: { altitudeM: 300_000 },
        guidance: { durationSeconds: 3_000, sampleStepSeconds: 10 },
      },
      INVOKE,
    );

    const samples = result.trajectorySamples;
    assert.ok(samples.length >= 250);
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

  test(`generated ascent samples are kinematically smooth on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(
      runtimeKind,
      WASM_PATH,
      t,
    );
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(
      harness,
      cloneRequest({
        guidance: { durationSeconds: 700, sampleStepSeconds: 2 },
      }),
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
      // Midpoint-rule consistency under powered flight: bounded by the jerk
      // term (throttle steps, stage events); measured maximum is ~3.7 m at
      // 2 s cadence across staging.
      assert.ok(
        error < 15.0,
        `sample ${index}: |delta_r - v_mean*dt| = ${error} m exceeds 15 m over dt=${dt}s`,
      );
    }
  });

  test(`initialState seeds a continuing phase exactly from terminalState on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(
      runtimeKind,
      WASM_PATH,
      t,
    );
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const first = await invokeJsonRequest(
      harness,
      cloneRequest({
        guidance: { durationSeconds: 300, sampleStepSeconds: 5 },
      }),
      INVOKE,
    );
    const seam = first.terminalState;
    assert.ok(seam, "truncated ascent still reports terminalState");
    assertClose(seam.epochOffsetSeconds, 300, 1e-6, "truncated terminal epoch");

    // Continue the mission from the seam as an unpowered coast phase.
    const second = await invokeJsonRequest(
      harness,
      {
        atmosphereModel: "US76",
        vehicle: { referenceAreaM2: 10.75, massKg: seam.massKg },
        initialState: seam,
        stages: [
          {
            thrustVacuumN: 0,
            thrustSeaLevelN: 0,
            ispVacuumS: 300,
            burnSeconds: 0,
            propellantMassKg: 0,
            dryMassKg: 0,
          },
        ],
        targetOrbit: { altitudeM: 200_000 },
        guidance: { durationSeconds: 120, sampleStepSeconds: 5 },
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
    assertClose(resumed.massKg, seam.massKg, 1e-6, "resumed mass");
    assertClose(
      second.terminalState.epochOffsetSeconds,
      seam.epochOffsetSeconds + second.trajectorySamples.at(-1).elapsedSeconds,
      1e-6,
      "epoch offset accumulates across phases",
    );
  });
}
