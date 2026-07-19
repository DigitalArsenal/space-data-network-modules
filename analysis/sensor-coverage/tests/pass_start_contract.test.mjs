import assert from "node:assert/strict";
import test from "node:test";

import {
  bitIsSet,
  conicShape,
  createContractHarness,
  createCoveragePayload,
  gridDimensions,
  invokeAndReadCoverage,
  lookAngleDegrees,
  stateSample,
} from "./sensor_coverage_contract_helpers.mjs";

// Live-scale contract fixture: WGS84 BODY_FIXED ECEF metres and SI seconds,
// 12 hours of a closed-form 550 km / 51.6 degree circular orbit sampled every
// 15 seconds, request-owned 60-second buckets, and the deployed 4-degree grid.
// The equality is exact because both products describe the same module-authored
// access topology: a solid-conic transit has one pass start at the first bucket
// of each contiguous CURRENT_ACCESS_BITSET run.
const WINDOW_SECONDS = 12 * 60 * 60;
const STATE_STEP_SECONDS = 15;
const STATE_COUNT = WINDOW_SECONDS / STATE_STEP_SECONDS + 1;
const BUCKET_STEP_SECONDS = 60;
const BUCKET_COUNT = WINDOW_SECONDS / BUCKET_STEP_SECONDS;

const EARTH_RADIUS_M = 6378137;
const ORBIT_RADIUS_M = EARTH_RADIUS_M + 550000;
const EARTH_GM_M3_PER_S2 = 3.986004418e14;
const ORBIT_SPEED_MPS = Math.sqrt(EARTH_GM_M3_PER_S2 / ORBIT_RADIUS_M);
const ORBIT_RATE_RAD_PER_SEC = ORBIT_SPEED_MPS / ORBIT_RADIUS_M;
const INCLINATION_RAD = 51.6 * Math.PI / 180;

const MEDIUM_GRID = Object.freeze({
  minLatitudeDeg: -60,
  maxLatitudeDeg: 60,
  minLongitudeDeg: -180,
  maxLongitudeDeg: 180,
  latitudeStepDeg: 4,
  longitudeStepDeg: 4,
});

function orbitState(elapsedSeconds) {
  const theta = ORBIT_RATE_RAD_PER_SEC * elapsedSeconds;
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);
  const cosInclination = Math.cos(INCLINATION_RAD);
  const sinInclination = Math.sin(INCLINATION_RAD);
  return stateSample({
    elapsedSeconds,
    position: {
      x: ORBIT_RADIUS_M * cosTheta,
      y: ORBIT_RADIUS_M * sinTheta * cosInclination,
      z: ORBIT_RADIUS_M * sinTheta * sinInclination,
    },
    velocity: {
      x: -ORBIT_SPEED_MPS * sinTheta,
      y: ORBIT_SPEED_MPS * cosTheta * cosInclination,
      z: ORBIT_SPEED_MPS * cosTheta * sinInclination,
    },
  });
}

function contiguousRunStarts(output, cellIndex) {
  const starts = [];
  let active = false;
  for (let bucketIndex = 0; bucketIndex < output.bucketCount; bucketIndex += 1) {
    const nextActive = bitIsSet(output, bucketIndex, cellIndex);
    if (nextActive && !active) {
      starts.push(bucketIndex);
    }
    active = nextActive;
  }
  return starts;
}

const TANGENCY_GRID = Object.freeze({
  minLatitudeDeg: 0,
  maxLatitudeDeg: 0.01,
  minLongitudeDeg: 1,
  maxLongitudeDeg: 1.01,
  latitudeStepDeg: 0.01,
  longitudeStepDeg: 0.01,
});
const TANGENCY_AWAY_STATE = stateSample({
  elapsedSeconds: 0,
  latitudeDeg: 0,
  longitudeDeg: -0.5,
  altitudeM: 500000,
});
const TANGENCY_CONTACT_STATE = stateSample({
  elapsedSeconds: 10,
  latitudeDeg: 0,
  longitudeDeg: 0,
  altitudeM: 500000,
});
const SOLID_TANGENCY_SHAPE = conicShape({
  // Closed-form WGS84 boundary contact at the cell's southwest corner.
  // No inner cutout or clock cut makes this a genuinely solid conic.
  outerHalfAngleDeg: lookAngleDegrees(TANGENCY_CONTACT_STATE, 0, 1),
});

function tangencyState(elapsedSeconds, atContact) {
  return {
    ...(atContact ? TANGENCY_CONTACT_STATE : TANGENCY_AWAY_STATE),
    elapsedSeconds,
  };
}

async function invokeTangencySequence(t, id, contactPattern) {
  const harness = await createContractHarness(t);
  if (!harness) {
    return null;
  }
  t.after(async () => {
    await harness.destroy();
  });
  const stop = (contactPattern.length - 1) * 10;
  return invokeAndReadCoverage(
    harness,
    createCoveragePayload({
      id,
      grid: TANGENCY_GRID,
      timeGrid: { start: 0, stop, step: stop, count: 1 },
      states: contactPattern.map((atContact, index) =>
        tangencyState(index * 10, atContact)),
      shape: SOLID_TANGENCY_SHAPE,
    }),
  );
}

test("two genuine solid-conic tangencies in one bucket remain two pass starts", async (t) => {
  // Independent endpoint construction: F,T,F,T,F. The invisible midpoint at
  // t=20 proves that the two singleton contacts are not refinement fragments
  // from one continuous transit.
  const output = await invokeTangencySequence(
    t,
    "solid-conic-two-same-bucket-tangencies",
    [false, true, false, true, false],
  );
  if (!output) return;
  assert.equal(bitIsSet(output, 0, 0), true);
  assert.equal(output.passCount[0], 2);
  assert.equal(output.bucketPassStartCount?.[0], 2);
});

test("a second solid-conic tangency at final STOP remains a pass start", async (t) => {
  // F,T,F,T with the second closed singleton exactly at final STOP.
  const output = await invokeTangencySequence(
    t,
    "solid-conic-two-tangencies-final-stop",
    [false, true, false, true],
  );
  if (!output) return;
  assert.equal(bitIsSet(output, 0, 0), true);
  assert.equal(output.passCount[0], 2);
  assert.equal(output.bucketPassStartCount?.[0], 2);
});

test("solid-conic pass starts equal contiguous access-bitset runs", {
  timeout: 120_000,
}, async (t) => {
  const dimensions = gridDimensions(MEDIUM_GRID);
  assert.equal(dimensions.rows * dimensions.columns, 2700);
  const states = Array.from(
    { length: STATE_COUNT },
    (_, index) => orbitState(index * STATE_STEP_SECONDS),
  );
  const harness = await createContractHarness(t);
  if (!harness) {
    return;
  }
  t.after(async () => {
    await harness.destroy();
  });

  const output = await invokeAndReadCoverage(
    harness,
    createCoveragePayload({
      id: "solid-conic-pass-start-contract",
      grid: MEDIUM_GRID,
      timeGrid: {
        start: 0,
        stop: WINDOW_SECONDS,
        step: BUCKET_STEP_SECONDS,
        count: BUCKET_COUNT,
      },
      states,
      shape: conicShape({
        outerHalfAngleDeg: 12.5,
        maxRangeM: 1_600_000,
      }),
      includePackedGeometry: false,
    }),
  );
  assert.equal(output.bucketCount, BUCKET_COUNT);
  assert.equal(output.passCount.length, dimensions.rows * dimensions.columns);

  const runStartsByCell = Array.from(
    { length: dimensions.rows * dimensions.columns },
    (_, cellIndex) => contiguousRunStarts(output, cellIndex),
  );
  const mismatches = runStartsByCell.flatMap((runStarts, cellIndex) =>
    output.passCount[cellIndex] === runStarts.length
      ? []
      : [{
        cellIndex,
        passCount: output.passCount[cellIndex],
        runStarts,
        passStarts: output.bucketPassStartCount
          ? Array.from({ length: output.bucketCount }, (_, bucketIndex) => ({
            bucketIndex,
            count: output.bucketPassStartCount[
              bucketIndex * output.passCount.length + cellIndex
            ],
          })).filter(({ count }) => count > 0)
          : null,
      }]);
  assert.equal(
    mismatches.length,
    0,
    `solid-conic pass counts split contiguous transits: ${JSON.stringify(mismatches.slice(0, 20))}`,
  );

  assert.ok(
    output.bucketPassStartCount,
    "ACCESS_COUNT output must include BUCKET_PASS_START_COUNT",
  );
  assert.equal(
    output.bucketPassStartCount.length,
    output.bucketCount * output.passCount.length,
  );
  for (let cellIndex = 0; cellIndex < output.passCount.length; cellIndex += 1) {
    const runStarts = new Set(runStartsByCell[cellIndex]);
    for (let bucketIndex = 0; bucketIndex < output.bucketCount; bucketIndex += 1) {
      const actual = output.bucketPassStartCount[
        bucketIndex * output.passCount.length + cellIndex
      ];
      const expected = runStarts.has(bucketIndex) ? 1 : 0;
      assert.equal(
        actual,
        expected,
        `cell ${cellIndex}, bucket ${bucketIndex}: pass-start band must mark only run starts`,
      );
    }
  }
});
