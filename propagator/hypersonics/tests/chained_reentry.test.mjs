import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
} from "../../../tests/lib/isomorphicHarness.mjs";

const cwdRequire = createRequire(path.join(process.cwd(), "package.json"));
const { forwardOutputFrameAsInput } = await import(
  pathToFileURL(cwdRequire.resolve("space-data-module-sdk/invoke")).href
);

const HYPERSONICS_WASM = new URL(
  "../dist/isomorphic/module.wasm",
  import.meta.url,
);
const REENTRY_WASM = new URL(
  "../../../analysis/reentry/dist/isomorphic/module.wasm",
  import.meta.url,
);

// Apollo-class capsule reentry, generated trajectory (the reentry module's
// closed-form 3-DOF integrator emits trajectorySamples with id /
// elapsedSeconds / altitudeM / speedMps / massKg / flightPathAngleDeg).
const REENTRY_REQUEST = {
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
};

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`reentry trajectory chains zero-copy into hypersonics on ${runtimeKind}`, async (t) => {
    const reentry = await createStandaloneHarnessOrSkip(
      runtimeKind,
      REENTRY_WASM,
      t,
    );
    if (!reentry) {
      return;
    }
    const hypersonics = await createStandaloneHarnessOrSkip(
      runtimeKind,
      HYPERSONICS_WASM,
      t,
    );
    if (!hypersonics) {
      await reentry.destroy();
      return;
    }
    t.after(async () => {
      await reentry.destroy();
      await hypersonics.destroy();
    });

    const reentryResponse = await reentry.invoke({
      methodId: "simulate_reentry",
      inputs: [
        {
          portId: "scenario",
          payload: Buffer.from(JSON.stringify(REENTRY_REQUEST), "utf8"),
        },
      ],
    });
    assert.equal(
      reentryResponse.statusCode,
      0,
      reentryResponse.errorMessage ?? "",
    );
    const reentryFrame = reentryResponse.outputs.find(
      (frame) => frame.portId === "reentry",
    );
    assert.ok(reentryFrame, "reentry module must emit a reentry frame");

    // THE HOP: module A's response bytes become module B's input frame with
    // no JSON decode / re-serialize on the host. forwardOutputFrameAsInput
    // reuses the exact payload view from A's response arena.
    const forwarded = forwardOutputFrameAsInput(reentryFrame, {
      portId: "trajectory",
    });
    assert.equal(
      forwarded.payload,
      reentryFrame.payload,
      "forwarded descriptor must reference module A's bytes, not a copy",
    );

    const hypersonicsResponse = await hypersonics.invoke({
      methodId: "evaluate_hypersonic_state_batch",
      inputs: [forwarded],
    });
    assert.equal(
      hypersonicsResponse.statusCode,
      0,
      hypersonicsResponse.errorMessage ?? "",
    );
    const conditionsFrame = hypersonicsResponse.outputs.find(
      (frame) => frame.portId === "conditions",
    );
    assert.ok(conditionsFrame);
    const result = JSON.parse(new TextDecoder().decode(conditionsFrame.payload));

    // Cross-check against the payload module A actually produced.
    const reentryResult = JSON.parse(
      new TextDecoder().decode(reentryFrame.payload),
    );
    const trajectory = reentryResult.trajectorySamples;
    assert.ok(Array.isArray(trajectory) && trajectory.length > 10);
    assert.equal(result.provider, "hypersonics-propagator");
    assert.equal(result.count, trajectory.length);
    assert.deepEqual(
      result.conditions.map((entry) => entry.id),
      trajectory.map((entry) => entry.id),
      "hypersonics must evaluate exactly the forwarded trajectory samples",
    );

    // Spot-check physics consistency on a mid-trajectory hypersonic sample:
    // Mach from the forwarded sample's speed and the US76 sound speed.
    const probe = result.conditions.find(
      (entry) => entry.mach > 5 && entry.altitudeM < 80_000,
    );
    assert.ok(probe, "expected at least one hypersonic condition below 80 km");
    const source = trajectory.find((entry) => entry.id === probe.id);
    assert.ok(Math.abs(probe.speedMps - source.speedMps) < 1e-6);
    assert.ok(Math.abs(probe.altitudeM - source.altitudeM) < 1e-6);
    assert.ok(
      Math.abs(probe.mach - probe.speedMps / probe.atmosphere.soundSpeedMps) <
        1e-9,
    );
  });
}
