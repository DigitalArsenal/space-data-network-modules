/**
 * BEHAVIOUR tests for the operations that are NOT vector-driven.
 *
 * The Hohmann / plane-change / combined tests that used to live here have
 * MOVED to vectors.test.mjs, and the `hohmannReference()` helper they leaned on
 * is gone. That helper recomputed the expected answer from the same closed form
 * the module implements, inside the assertion — a tautology that could only
 * fail on a typo, and that agreed with the module on cases where the module is
 * demonstrably wrong. Expectations now come from `vectors/vectors.json`, whose
 * provenance is recorded per row in `vectors/PROVENANCE.md`.
 *
 * What remains here is coverage of the relative-motion operations
 * (`computeCAM`, `computeRoeStateTransition`, `simulateRendezvous`,
 * `planRelativeWaypointMission`), which no maneuver command card consumes and
 * which therefore have no authoritative vector yet. They assert structure and
 * self-consistency, which is honest for what they are — and is why they are
 * kept separate from the file that claims parity.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const MU_EARTH = 398600441800000.0;

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`collision-avoidance maneuvers honor miss-distance and timing config on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t, {
      enableThreads: true,
    });
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(harness, {
      operation: "computeCAM",
      params: {
        initialState: {
          position: [50, 0, 0],
          velocity: [0, -0.02, 0],
        },
        chief: {
          semiMajorAxis: 6_778_000,
          eccentricity: 0,
          inclination: 0,
          mu: MU_EARTH,
        },
        config: {
          minMissDistance: 1_000,
          timeToTCA: 600,
          maxDeltaV: 10,
          preferRadial: false,
        },
      },
    });

    const magnitude = Math.hypot(...result.deltaV);
    assert.equal(result.feasible, true);
    assert.equal(result.achievedMiss, 1_000);
    assert.equal(result.optimalBurnTime, 600);
    assert.ok(Math.abs(result.magnitude - magnitude) < 1e-12);
    assert.ok(result.magnitude <= 10);
  });

  test(`KGD ROE STM propagation returns finite J2 state transition data on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t, {
      enableThreads: true,
    });
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(harness, {
      operation: "computeRoeStateTransition",
      params: {
        model: "j2",
        deltaTime: 1200,
        initialRoe: [1e-5, 2e-5, 1e-6, 2e-6, 3e-6, 4e-6],
        chief: {
          semiMajorAxis: 6_778_000,
          eccentricity: 0.001,
          inclination: 51.6 * Math.PI / 180,
          raan: 0,
          argumentOfPerigee: 0,
          meanAnomaly: 0,
          mu: MU_EARTH,
        },
      },
    });

    assert.equal(result.model, "j2");
    assert.equal(result.reference, "Koenig-Guffanti-D'Amico ROE STM");
    assert.equal(result.stm.length, 6);
    assert.equal(result.stm[0].length, 6);
    assert.equal(result.propagatedRoe.length, 6);
    assert.ok(Math.abs(result.stm[0][0] - 1) < 1e-12);
    assert.ok(result.propagatedRoe.every(Number.isFinite));
  });

  test(`closed-loop rendezvous simulation tracks the combined-case profile on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t, {
      enableThreads: true,
    });
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(harness, {
      operation: "simulateRendezvous",
      params: {
        chief: {
          semiMajorAxis: 6_778_000,
          eccentricity: 0,
          inclination: 51.6 * Math.PI / 180,
          mu: MU_EARTH,
        },
        initialPosition: [100, -338.8, 0],
        brakePoint: [0, -80, 0],
        holdPoint: [0, -30, 0],
        driftDuration: 2000,
        brakeDuration: 400,
        holdDuration: 300,
        integration: { timeStep: 0.5, outputEvery: 40 },
      },
    });

    assert.equal(result.phases.totalTime, 2700);
    assert.ok(result.meanMotion > 0);
    assert.ok(result.solvedInitialVelocity.every(Number.isFinite));
    assert.ok(result.metrics.totalDeltaV > 0);
    assert.ok(result.metrics.maxPositionError < 1);
    assert.ok(result.metrics.finalPositionError < 0.05);
    assert.ok(result.metrics.finalVelocityError < 1e-3);
    assert.equal(result.metrics.saturatedSteps, 0);
    assert.ok(result.trajectory.length > 0);
    assert.equal(result.trajectory[0].phase, "drift");
    assert.equal(result.trajectory.at(-1).phase, "hold");
    const last = result.trajectory.at(-1);
    assert.ok(Math.abs(last.position[1] - (-30)) < 0.1);
    assert.ok(last.position.every(Number.isFinite));
  });

  test(`relative waypoint mission planning returns finite burns and trajectory on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t, {
      enableThreads: true,
    });
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const period =
      2 * Math.PI * Math.sqrt((6_778_000 ** 3) / MU_EARTH);
    const legTof = 0.75 * period;
    const result = await invokeJsonRequest(harness, {
      operation: "planRelativeWaypointMission",
      params: {
        initialState: {
          position: [0, -200, 0],
          velocity: [0, 0, 0],
        },
        chief: {
          semiMajorAxis: 6_778_000,
          eccentricity: 0.001,
          inclination: 51.6 * Math.PI / 180,
          raan: 0,
          argumentOfPerigee: 0,
          meanAnomaly: 0,
          mu: MU_EARTH,
        },
        waypoints: [
          { position: [40, -120, 20], tof: legTof },
          { position: [0, -60, 0], tof: legTof },
          { position: [0, 0, 0], tof: legTof },
        ],
        options: {
          includeJ2: true,
          positionTolerance: 5,
          pointsPerLeg: 24,
        },
      },
    });

    assert.equal(result.reference, "Koenig-Guffanti-D'Amico ROE STM");
    assert.equal(result.converged, true);
    assert.equal(result.legs.length, 3);
    assert.equal(result.trajectory.length, 72);
    assert.ok(result.totalDeltaV > 0);
    assert.ok(result.totalTime > 0);
    assert.ok(result.legs.every((leg) => leg.converged));
    assert.ok(result.legs.every((leg) => Number.isFinite(leg.totalDeltaV)));
    assert.ok(result.trajectory.every((point) =>
      point.position.every(Number.isFinite) &&
      point.velocity.every(Number.isFinite),
    ));
  });
}

/**
 * THE `version` OPERATION MUST NAME THE MODULE THAT ANSWERS IT.
 *
 * It returned "1.0.0" from 0.1.0 through 0.3.0 — a version this module has
 * never carried — because nothing compared it to anything. The one operation
 * whose entire job is to say which artifact you are talking to was answering a
 * fiction, and a consumer using it to decide whether the module it fetched has
 * the operation it needs was reading a constant.
 *
 * The manifest is the authority; this asserts the two agree, so the next
 * release cannot forget one of them.
 */
test("the version operation agrees with plugin-manifest.json", async (t) => {
  const harness = await createStandaloneHarnessOrSkip("browser", WASM_PATH, t);
  if (!harness) {
    return;
  }
  t.after(async () => {
    await harness.destroy();
  });

  const manifest = JSON.parse(
    await readFile(new URL("../plugin-manifest.json", import.meta.url), "utf8"),
  );
  const result = await invokeJsonRequest(harness, { operation: "version", params: {} });
  assert.equal(result.version, manifest.version);
});

/**
 * The delivery row a node admits is DATA, and it declares the version the
 * artifact claims. A row that names a different version from the manifest
 * would publish an artifact under a name that does not answer to it.
 */
test("the module catalog entry agrees with plugin-manifest.json", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../plugin-manifest.json", import.meta.url), "utf8"),
  );
  const entry = JSON.parse(
    await readFile(new URL("../delivery/modules-catalog.entry.json", import.meta.url), "utf8"),
  );
  assert.equal(entry.VERSION, manifest.version);
  assert.equal(entry.MODULE_ID, manifest.pluginId);
  assert.equal(entry.ARTIFACT_PATH, `/modules/${manifest.pluginId}/${manifest.version}/module.wasm`);
});
