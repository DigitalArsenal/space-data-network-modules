import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  bitIsSet,
  conicShape,
  createContractHarness,
  createCoveragePayload,
  dot,
  geodeticToEcef,
  gridDimensions,
  interpolateState,
  invokeAndReadCoverage,
  lookAngleDegrees,
  magnitude,
  resolvedFrame,
  stateSample,
  subtract,
  surfacePointVisible,
} from "./sensor_coverage_contract_helpers.mjs";

const MODULE_SOURCE = readFileSync(
  new URL("../src/cpp/module.cpp", import.meta.url),
  "utf8",
);

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

// Exact owner-reported GSD-20/H3 provenance fixture. These are the live
// BODY_FIXED ECEF states and sensor-frame quaternions bounding the false
// first-swath split. The single cell is raster member 13375 of H3
// 83d743fffffffff in the production request.
const LIVE_MICROGAP_GRID = Object.freeze({
  minLatitudeDeg: -51,
  maxLatitudeDeg: -50.5,
  minLongitudeDeg: 27.5,
  maxLongitudeDeg: 28,
  latitudeStepDeg: 0.5,
  longitudeStepDeg: 0.5,
});
const LIVE_MICROGAP_SHAPE = conicShape({
  outerHalfAngleDeg: 12.5,
  maxRangeM: 1_600_000,
});
const LIVE_MICROGAP_STATES = Object.freeze([
  stateSample({
    elapsedSeconds: 9885,
    position: {
      x: 4008024.7429048102,
      y: 2064414.0666255667,
      z: -5200760.295066231,
    },
    velocity: {
      x: -4769.122505597513,
      y: 5288.686849553442,
      z: -1575.8934750947878,
    },
    quaternion: {
      x: 0.0015684387115439593,
      y: -0.0005480348341834906,
      z: -0.000017333637233522627,
      w: 0.9999986196777344,
    },
  }),
  stateSample({
    elapsedSeconds: 9900,
    position: {
      x: 3936030.6103196903,
      y: 2143537.1950419247,
      z: -5223682.249652127,
    },
    velocity: {
      x: -4829.9110941748295,
      y: 5260.874646371834,
      z: -1480.2992874511644,
    },
    quaternion: {
      x: 0.0015761964840169613,
      y: -0.0005171159050773068,
      z: 0.000015129295544017382,
      w: 0.999998623982498,
    },
  }),
]);

function lerpVector(start, stop, fraction) {
  return {
    x: start.x + (stop.x - start.x) * fraction,
    y: start.y + (stop.y - start.y) * fraction,
    z: (start.z ?? 0) + ((stop.z ?? 0) - (start.z ?? 0)) * fraction,
  };
}

function quadraticBernsteinProduct(left, right) {
  return [
    left[0] * right[0],
    0.5 * (left[0] * right[1] + left[1] * right[0]),
    (
      left[0] * right[2] +
      4 * left[1] * right[1] +
      left[2] * right[0]
    ) / 6,
    0.5 * (left[1] * right[2] + left[2] * right[1]),
    left[2] * right[2],
  ];
}

function jointConicQuarticControls(
  lookStart,
  lookStop,
  rawBoresightStart,
  rawBoresightStop,
  thresholdCosine,
) {
  const numerator = [
    dot(lookStart, rawBoresightStart),
    0.5 * (
      dot(lookStart, rawBoresightStop) +
      dot(lookStop, rawBoresightStart)
    ),
    dot(lookStop, rawBoresightStop),
  ];
  const lookNormSquared = [
    dot(lookStart, lookStart),
    dot(lookStart, lookStop),
    dot(lookStop, lookStop),
  ];
  const boresightNormSquared = [
    dot(rawBoresightStart, rawBoresightStart),
    dot(rawBoresightStart, rawBoresightStop),
    dot(rawBoresightStop, rawBoresightStop),
  ];
  const numeratorSquared = quadraticBernsteinProduct(numerator, numerator);
  const normProduct = quadraticBernsteinProduct(
    lookNormSquared,
    boresightNormSquared,
  );
  return {
    numerator,
    quartic: numeratorSquared.map(
      (value, index) =>
        value - thresholdCosine * thresholdCosine * normProduct[index],
    ),
  };
}

test("bridge proof is pinned to the original affine nlerp parameter", () => {
  assert.match(
    MODULE_SOURCE,
    /raw_affine_boresight_interval/,
    "bridge must recover raw boresights from the original interpolation basis",
  );
  assert.match(
    MODULE_SOURCE,
    /positive_quartic_bernstein_lower_bound/,
    "solid-conic bridge must use the cancellation-safe quartic proof",
  );
  assert.match(
    MODULE_SOURCE,
    /lower_operation_scale[\s\S]*std::fabs\(left\.lower\)[\s\S]*std::fabs\(right\.lower\)/,
    "cross-control averages must guard pre-cancellation operand magnitude",
  );
});

test("absolute-fraction quartic rejects a normalized-local false proof", () => {
  // Materially separated original boresights make nlerp non-associative in
  // parameter. On this deterministic adversary, replacing the raw absolute
  // chords U(f) with normalized local endpoints would falsely certify a cone
  // whose cosine threshold is 0.3.
  const originalBoresightStart = { x: 1, y: 0, z: 0 };
  const originalBoresightStop = {
    x: -0.9321599516425437,
    y: 0.3620467159825795,
    z: 0,
  };
  const fractionStart = 0.568141835155412;
  const fractionStop = 0.9549578646382244;
  const lookStart = {
    x: 0.3508176350688649,
    y: 0.3906522777438855,
    z: 0,
  };
  const lookStop = {
    x: -0.19103289117691374,
    y: 0.5612612540252514,
    z: 0,
  };
  const rawStart = lerpVector(
    originalBoresightStart,
    originalBoresightStop,
    fractionStart,
  );
  const rawStop = lerpVector(
    originalBoresightStart,
    originalBoresightStop,
    fractionStop,
  );
  const unitStart = lerpVector(rawStart, rawStart, 0);
  const unitStop = lerpVector(rawStop, rawStop, 0);
  for (const unit of [unitStart, unitStop]) {
    const length = magnitude(unit);
    unit.x /= length;
    unit.y /= length;
  }
  const wrongLocalNumerator = [
    dot(lookStart, unitStart),
    0.5 * (dot(lookStart, unitStop) + dot(lookStop, unitStart)),
    dot(lookStop, unitStop),
  ];
  const absoluteCrossDots = [
    dot(lookStart, rawStop),
    dot(lookStop, rawStart),
  ];
  assert.ok(
    absoluteCrossDots[0] < 0 && absoluteCrossDots[1] > 0,
    "adversary must exercise opposite-signed cross-control cancellation",
  );
  const wrongLocalLower = Math.min(...wrongLocalNumerator) /
    Math.max(magnitude(lookStart), magnitude(lookStop));
  assert.ok(
    wrongLocalLower > 0.3,
    `control requires the unsound local proof to accept; got ${wrongLocalLower}`,
  );

  const absoluteProof = jointConicQuarticControls(
    lookStart,
    lookStop,
    rawStart,
    rawStop,
    0.3,
  );
  assert.ok(
    Math.min(...absoluteProof.quartic) < 0,
    "the absolute-fraction proof must stay inconclusive",
  );

  let denseMinimumCosine = 1;
  let denseMinimumSquaredClearance = Number.POSITIVE_INFINITY;
  const denseSteps = 100_000;
  for (let index = 0; index <= denseSteps; index += 1) {
    const localFraction = index / denseSteps;
    const absoluteFraction = fractionStart +
      (fractionStop - fractionStart) * localFraction;
    const look = lerpVector(lookStart, lookStop, localFraction);
    const rawBoresight = lerpVector(
      originalBoresightStart,
      originalBoresightStop,
      absoluteFraction,
    );
    denseMinimumCosine = Math.min(
      denseMinimumCosine,
      dot(look, rawBoresight) /
        (magnitude(look) * magnitude(rawBoresight)),
    );
    const numerator = dot(look, rawBoresight);
    denseMinimumSquaredClearance = Math.min(
      denseMinimumSquaredClearance,
      numerator * numerator -
        0.3 * 0.3 * dot(look, look) * dot(rawBoresight, rawBoresight),
    );
  }
  assert.ok(
    denseMinimumCosine < 0.3,
    `adversary must contain real invisibility; got ${denseMinimumCosine}`,
  );
  assert.ok(
    Math.min(...absoluteProof.quartic) <=
      denseMinimumSquaredClearance + 1e-12,
    "absolute Bernstein minimum must contain the dense actual clearance",
  );
});

test("live GSD-20 grazing corner remains one contiguous solid-conic pass", async (t) => {
  // Independent closed-form oracle: the cell's northeast corner is one of
  // the module's own nine fixed samples. It stays inside the solid cone at
  // every microsecond across the exact 1.443 ms interval that the deployed
  // module declares inactive. A bridge is therefore physically required.
  const gapStartSeconds = 9896.826783;
  const gapStopSeconds = 9896.828226;
  const witnessStepSeconds = 0.000001;
  const witnessSampleCount = Math.round(
    (gapStopSeconds - gapStartSeconds) / witnessStepSeconds,
  );
  const originalStartFrame = resolvedFrame(LIVE_MICROGAP_STATES[0]);
  const originalStopFrame = resolvedFrame(LIVE_MICROGAP_STATES[1]);
  const interpolationSpan =
    LIVE_MICROGAP_STATES[1].elapsedSeconds -
    LIVE_MICROGAP_STATES[0].elapsedSeconds;
  const rawBoresightAt = (elapsedSeconds) => lerpVector(
    originalStartFrame.boresight,
    originalStopFrame.boresight,
    (elapsedSeconds - LIVE_MICROGAP_STATES[0].elapsedSeconds) /
      interpolationSpan,
  );
  const surfacePosition = geodeticToEcef(-50.5, 28, 0);
  const proofStartState = interpolateState(
    LIVE_MICROGAP_STATES[0],
    LIVE_MICROGAP_STATES[1],
    gapStartSeconds,
  );
  const proofStopState = interpolateState(
    LIVE_MICROGAP_STATES[0],
    LIVE_MICROGAP_STATES[1],
    gapStopSeconds,
  );
  const membershipThreshold = Math.cos(12.5 * Math.PI / 180 + 1e-12);
  const liveProof = jointConicQuarticControls(
    subtract(surfacePosition, proofStartState.position),
    subtract(surfacePosition, proofStopState.position),
    rawBoresightAt(gapStartSeconds),
    rawBoresightAt(gapStopSeconds),
    membershipThreshold,
  );
  assert.ok(
    Math.min(...liveProof.numerator) > 0,
    "positive numerator makes squared cone membership equivalent",
  );
  assert.ok(
    Math.min(...liveProof.quartic) > 0,
    `absolute-fraction quartic must prove the live gap: ${liveProof.quartic}`,
  );
  let denseMinimumSquaredClearance = Number.POSITIVE_INFINITY;
  for (let index = 0; index <= witnessSampleCount; index += 1) {
    const elapsedSeconds = index === witnessSampleCount
      ? gapStopSeconds
      : gapStartSeconds + index * witnessStepSeconds;
    const state = interpolateState(
      LIVE_MICROGAP_STATES[0],
      LIVE_MICROGAP_STATES[1],
      elapsedSeconds,
    );
    assert.equal(
      surfacePointVisible(-50.5, 28, state, LIVE_MICROGAP_SHAPE),
      true,
      `northeast-corner exact witness must remain visible at ${elapsedSeconds}`,
    );
    const look = subtract(surfacePosition, state.position);
    const rawBoresight = rawBoresightAt(elapsedSeconds);
    const numerator = dot(look, rawBoresight);
    denseMinimumSquaredClearance = Math.min(
      denseMinimumSquaredClearance,
      numerator * numerator -
        membershipThreshold * membershipThreshold *
          dot(look, look) * dot(rawBoresight, rawBoresight),
    );
  }
  assert.ok(denseMinimumSquaredClearance > 0);
  assert.ok(
    Math.min(...liveProof.quartic) <= denseMinimumSquaredClearance + 0.1,
    "live Bernstein minimum must contain the dense actual clearance",
  );

  const harness = await createContractHarness(t);
  if (!harness) return;
  t.after(async () => {
    await harness.destroy();
  });
  const output = await invokeAndReadCoverage(
    harness,
    createCoveragePayload({
      id: "live-gsd20-solid-conic-microgap",
      grid: LIVE_MICROGAP_GRID,
      timeGrid: {
        start: 9896.82,
        stop: 9896.84,
        step: 0.000001,
        count: 20_001,
      },
      states: LIVE_MICROGAP_STATES,
      shape: LIVE_MICROGAP_SHAPE,
      includePackedGeometry: false,
    }),
  );
  const passStartBuckets = output.bucketPassStartCount.flatMap(
    (count, bucketIndex) => Array.from({ length: count }, () => bucketIndex),
  );
  const accessRunStarts = contiguousRunStarts(output, 0);
  const observed = {
    passCount: output.passCount[0],
    passStartCount: passStartBuckets.length,
    accessRunCount: accessRunStarts.length,
  };
  const provenance = {
    passStartsSeconds: passStartBuckets.map(
      (bucketIndex) => output.bucketStart[bucketIndex],
    ),
    accessRunStartsSeconds: accessRunStarts.map(
      (bucketIndex) => output.bucketStart[bucketIndex],
    ),
  };
  assert.deepEqual(
    observed,
    { passCount: 1, passStartCount: 1, accessRunCount: 1 },
    `one continuous exact witness must produce one pass/start/run; observed ${JSON.stringify(provenance)}`,
  );
});

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
