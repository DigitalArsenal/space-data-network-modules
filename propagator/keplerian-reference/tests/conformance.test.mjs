/**
 * The reference propagator's conformance set.
 *
 * Tier B: closed-form anchors from vectors/vectors.json, generated
 *         independently of the module (vectors/PROVENANCE.md).
 * Tier C: invariants with no stored expectation — vis-viva closure, period
 *         closure, determinism, declared frame/flags, typed refusals.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EARTH_ROTATION_RATE,
  MU,
  SECONDS_PER_DAY,
  withinBand,
} from "../vectors/index.mjs";
import { ErrorCode, ReferenceFrame, StateFlags, loadModule } from "./harness.mjs";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vectors = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "vectors", "vectors.json"), "utf8"),
);

/** Undo the ECEF rotation to recover inertial magnitudes for vis-viva. */
function inertialFromEcef(state) {
  const [x, y, z] = state.position;
  const [vx, vy, vz] = state.velocity;
  // v_inertial = v_ecef + omega x r, expressed in the rotated axes; magnitudes
  // are frame-independent under a pure rotation, so this is enough.
  const vxi = vx - EARTH_ROTATION_RATE * y;
  const vyi = vy + EARTH_ROTATION_RATE * x;
  return {
    radius: Math.hypot(x, y, z),
    speed: Math.hypot(vxi, vyi, vz),
  };
}

test("TIER B — every closed-form anchor is reproduced by the module", async () => {
  const propagator = await loadModule();
  let checked = 0;

  for (const testCase of vectors.cases) {
    const { elements, julianDate } = testCase.params;
    const ingested = propagator.initFromOmm([elements]);
    assert.equal(ingested, 1, `${testCase.id}: ingest returned ${ingested}`);

    const { status, state } = propagator.propagate(julianDate, 0);
    assert.equal(status, ErrorCode.OK, `${testCase.id}: propagate status`);

    for (const axis of [0, 1, 2]) {
      const expectedPosition = testCase.expect[`position.${axis}`];
      assert.ok(
        withinBand(state.position[axis], expectedPosition, testCase.band.position),
        `${testCase.id}: position[${axis}] = ${state.position[axis]} but the closed form says ` +
          `${expectedPosition} (delta ${state.position[axis] - expectedPosition} m)`,
      );
      const expectedVelocity = testCase.expect[`velocity.${axis}`];
      assert.ok(
        withinBand(state.velocity[axis], expectedVelocity, testCase.band.velocity),
        `${testCase.id}: velocity[${axis}] = ${state.velocity[axis]} but the closed form says ` +
          `${expectedVelocity} (delta ${state.velocity[axis] - expectedVelocity} m/s)`,
      );
    }
    assert.ok(withinBand(state.epoch, testCase.expect.epoch, testCase.band.time));
    checked += 1;
  }

  assert.ok(checked >= 15, `only ${checked} anchors were checked`);
});

test("TIER C — vis-viva closes on the module's own output", async () => {
  const propagator = await loadModule();
  for (const testCase of vectors.cases) {
    const { elements, julianDate } = testCase.params;
    propagator.initFromOmm([elements]);
    const { state } = propagator.propagate(julianDate, 0);

    const n = (elements.meanMotionRevPerDay * 2 * Math.PI) / SECONDS_PER_DAY;
    const a = Math.cbrt(MU / (n * n));
    const { radius, speed } = inertialFromEcef(state);
    const energy = (speed * speed) / 2 - MU / radius;
    const expected = -MU / (2 * a);
    const relative = Math.abs((energy - expected) / expected);

    // No stored expectation: this is the orbit adjudicating itself. The band is
    // loose enough to absorb the approximate un-rotation above and tight enough
    // that a wrong semi-major axis (the classic mu/units error) cannot pass.
    assert.ok(
      relative < 1e-6,
      `${testCase.id}: specific energy ${energy} vs -mu/2a ${expected} (rel ${relative.toExponential(3)})`,
    );
  }
});

test("TIER C — one full period returns to the same inertial position", async () => {
  const propagator = await loadModule();
  const seen = new Set();
  for (const testCase of vectors.cases) {
    const { elements } = testCase.params;
    if (seen.has(elements.noradCatId)) continue;
    seen.add(elements.noradCatId);

    propagator.initFromOmm([elements]);
    const periodDays = 1 / elements.meanMotionRevPerDay;
    const start = elements.epochJd;

    const a = propagator.propagate(start, 0).state;
    const b = propagator.propagate(start + periodDays, 0).state;

    // Compare RADIUS rather than the ECEF vector: the Earth has turned under
    // the orbit in one period, so identical ECEF coordinates would be wrong.
    const ra = Math.hypot(...a.position);
    const rb = Math.hypot(...b.position);
    assert.ok(
      Math.abs(ra - rb) < 1e-3,
      `period closure for ${elements.noradCatId}: |r| went ${ra} -> ${rb}`,
    );
  }
});

test("TIER C — output is byte-identical across repeated and re-ingested calls", async () => {
  const propagator = await loadModule();
  const { elements, julianDate } = vectors.cases[0].params;

  propagator.initFromOmm([elements]);
  const first = propagator.propagate(julianDate, 0).bytes;
  const second = propagator.propagate(julianDate, 0).bytes;
  assert.deepEqual([...second], [...first], "two identical calls diverged");

  // Determinism must survive the lifecycle, not just the call.
  propagator.destroy();
  propagator.initFromOmm([elements]);
  const third = propagator.propagate(julianDate, 0).bytes;
  assert.deepEqual(
    [...third],
    [...first],
    "output changed after destroy + re-ingest — state leaked across the lifecycle",
  );
});

test("TIER C — frame, flags and the reserved padding bytes are all declared", async () => {
  const propagator = await loadModule();
  const { elements, julianDate } = vectors.cases[0].params;
  propagator.initFromOmm([elements]);
  const { state } = propagator.propagate(julianDate, 0);

  assert.equal(
    state.referenceFrame,
    ReferenceFrame.ECEF,
    "the ABI requires ECEF output and the field must SAY so",
  );
  assert.equal(state.flags & StateFlags.VALID, StateFlags.VALID, "VALID flag not set");
  assert.deepEqual(
    state.reserved,
    [0, 0, 0],
    "the three IDL-reserved bytes at offsets 57..59 must be zero; non-zero here means the " +
      "writer assigned reference_frame directly instead of using the generated setter, and a " +
      "consumer reading offset 56 as a 32-bit word sees garbage",
  );
});

test("TIER C — batch and single agree exactly", async () => {
  const propagator = await loadModule();
  const elementSets = vectors.cases.slice(0, 4).map((c) => c.params.elements);
  propagator.initFromOmm(elementSets);
  const julianDate = elementSets[0].epochJd + 0.01;

  const batch = propagator.propagateBatch(julianDate, elementSets.length);
  assert.equal(batch.status, ErrorCode.OK);

  for (let index = 0; index < elementSets.length; index += 1) {
    const single = propagator.propagate(julianDate, index).state;
    assert.deepEqual(
      batch.states[index].position,
      single.position,
      `entity ${index}: batch and single disagree — the batch path is not the same physics`,
    );
  }
});

test("TIER C — every refusal has its own documented code", async () => {
  const propagator = await loadModule();

  // Nothing ingested yet.
  assert.equal(
    propagator.propagate(2460000.5, 0).status,
    ErrorCode.NOT_INITIALIZED,
    "propagating before ingest must be distinguishable from a bad index",
  );

  propagator.initFromOmm([vectors.cases[0].params.elements]);
  assert.equal(
    propagator.propagate(2460000.5, 99).status,
    ErrorCode.BAD_ENTITY_INDEX,
    "an out-of-range entity index must have its own code",
  );

  // A hyperbolic eccentricity describes no closed orbit.
  const unphysical = {
    ...vectors.cases[0].params.elements,
    eccentricity: 1.5,
  };
  assert.ok(
    propagator.initFromOmm([unphysical]) < 0,
    "e >= 1 must be refused at ingest, not propagated into confident nonsense",
  );

  // A negative mean motion is not an orbit either.
  assert.ok(
    propagator.initFromOmm([{ ...vectors.cases[0].params.elements, meanMotionRevPerDay: -1 }]) < 0,
    "a non-positive mean motion must be refused",
  );
});

test("TIER C — create RETURNS its handle instead of implying count-1", async () => {
  const propagator = await loadModule();
  propagator.initFromOmm([vectors.cases[0].params.elements]);

  const handle = propagator.ingestOne(vectors.cases[4].params.elements);
  assert.equal(handle, 1, "ingest must return the handle it assigned");
  assert.equal(propagator.entityCount(), 2);

  // The handle it returned is the one that works.
  assert.equal(propagator.propagate(2460000.5, handle).status, ErrorCode.OK);
});
