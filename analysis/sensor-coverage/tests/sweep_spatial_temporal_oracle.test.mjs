import assert from "node:assert/strict";
import test from "node:test";

import {
  bitIsSet,
  buildGridCells,
  cellVisibleOnLattice,
  createContractHarness,
  createCoveragePayload,
  gridDimensions,
  invokeAndReadCoverage,
  quaternionFromAxisAngle,
  sarAnnularSectorShape,
  stateSample,
} from "./sensor_coverage_contract_helpers.mjs";

// Dense spatial/temporal oracle for the SWEPT-SAR path introduced by the
// sweep-phase temporal subdivision fix (large-amplitude scanning sensors).
//
// The subdivision only restructures the TIME windows the exact search runs
// over; the instantaneous footprint predicate is untouched, and the fix is
// prune-only (it can drop wasted work, never fabricate coverage). The one new
// risk is therefore MISSING a coverage moment that a sub-window skipped. This
// oracle pins the conservative invariant against that risk:
//
//   oracle-positive  =>  module-positive
//
// i.e. every cell that an INDEPENDENT closed-form footprint check finds covered
// at a sampled sweep phase must be marked covered in the module's raster for the
// bucket containing that phase. The module runs a continuum search, so its
// coverage is a superset of any finite sample set — a subdivision that dropped a
// real coverage moment breaks this invariant.
//
// Reference fidelity: the sensor is a FULL-CIRCLE annular SAR (no clock sector),
// so the footprint reduces to {range in [min,max], look angle in [inner,outer],
// above the local horizon} — exactly what the shape-generic surfacePointVisible
// helper computes, with no clock-azimuth convention to get wrong. Phases are
// sampled at the EXACT provided state times (every 5 s), so the reference and
// the module evaluate the identical attitude with no interpolation gap. The
// large 50 deg / 120 s cross-track sweep guarantees the subdivision path runs
// (each 5 s segment still swings ~13 deg at a zero crossing).

const WINDOW_SECONDS = 240; // two full sweep periods
const STATE_STEP_SECONDS = 5; // fine attitude sampling -> exact-time reference
const STATE_COUNT = WINDOW_SECONDS / STATE_STEP_SECONDS + 1; // 49
const GRID_STEP_SECONDS = 30;
const GRID_INDEX_COUNT = WINDOW_SECONDS / GRID_STEP_SECONDS; // 8

const OFF_NADIR_DEG = 30;
const SWEEP_AMPLITUDE_DEG = 50;
const SWEEP_PERIOD_SECONDS = 120;
const INNER_LOOK_DEG = OFF_NADIR_DEG - 4; // 26
const OUTER_LOOK_DEG = OFF_NADIR_DEG + 4; // 34
const MAX_RANGE_M = 2500000;

const EARTH_RADIUS_M = 6378137;
const ORBIT_RADIUS_M = EARTH_RADIUS_M + 550000;
const EARTH_GM_M3_PER_S2 = 3.986004418e14;
const ORBIT_SPEED_MPS = Math.sqrt(EARTH_GM_M3_PER_S2 / ORBIT_RADIUS_M);
const ORBIT_RATE_RAD_PER_SEC = ORBIT_SPEED_MPS / ORBIT_RADIUS_M;
const INCLINATION_RAD = (51.6 * Math.PI) / 180;

const GRID = Object.freeze({
  minLatitudeDeg: -60,
  maxLatitudeDeg: 60,
  minLongitudeDeg: -180,
  maxLongitudeDeg: 180,
  latitudeStepDeg: 8,
  longitudeStepDeg: 8,
});

// Full-circle annular SAR: -180..180 clock spans the whole azimuth, so the
// footprint is a pure look-angle annulus (inner..outer) bounded by max range.
const MODULE_SHAPE = sarAnnularSectorShape({
  innerLookAngleDeg: INNER_LOOK_DEG,
  outerLookAngleDeg: OUTER_LOOK_DEG,
  minClockAngleDeg: -180,
  maxClockAngleDeg: 180,
  maxRangeM: MAX_RANGE_M,
  samplingDensity: 256,
});

// The independent closed-form annulus the reference lattice checks. Its
// half-angle range maps directly onto the SAR look-angle band.
const REFERENCE_SHAPE = Object.freeze({
  maxRangeM: MAX_RANGE_M,
  minRangeM: 0,
  innerHalfAngleDeg: INNER_LOOK_DEG,
  outerHalfAngleDeg: OUTER_LOOK_DEG,
});

function sweepQuaternion(elapsedSeconds) {
  const rollDeg =
    OFF_NADIR_DEG +
    SWEEP_AMPLITUDE_DEG *
      Math.sin((2 * Math.PI * elapsedSeconds) / SWEEP_PERIOD_SECONDS);
  return quaternionFromAxisAngle({ x: 1, y: 0, z: 0 }, rollDeg);
}

function sweepOrbitState(elapsedSeconds) {
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
    quaternion: sweepQuaternion(elapsedSeconds),
  });
}

function bucketForTime(output, elapsedSeconds) {
  for (let bucket = 0; bucket < output.bucketCount; bucket += 1) {
    if (
      elapsedSeconds >= output.bucketStart[bucket] &&
      elapsedSeconds < output.bucketStop[bucket]
    ) {
      return bucket;
    }
  }
  return -1;
}

test("swept full-circle SAR (amp-50) coverage is a superset of the dense footprint oracle", async (t) => {
  const harness = await createContractHarness(t);
  if (!harness) {
    return;
  }
  try {
    const states = Array.from({ length: STATE_COUNT }, (_, index) =>
      sweepOrbitState(index * STATE_STEP_SECONDS),
    );
    const payload = createCoveragePayload({
      id: "sweep-oracle-fullcircle-sar",
      grid: GRID,
      timeGrid: {
        start: 0,
        stop: WINDOW_SECONDS,
        step: GRID_STEP_SECONDS,
        count: GRID_INDEX_COUNT,
      },
      states,
      shape: MODULE_SHAPE,
      includePackedGeometry: false,
    });

    const output = await invokeAndReadCoverage(harness, payload);
    const cells = buildGridCells(GRID);
    const { rows, columns } = gridDimensions(GRID);
    assert.equal(cells.length, rows * columns);

    let oraclePositives = 0;
    let moduleCoveredBits = 0;
    const misses = [];

    for (let stateIndex = 0; stateIndex < states.length; stateIndex += 1) {
      const state = states[stateIndex];
      const elapsed = state.elapsedSeconds;
      const bucket = bucketForTime(output, elapsed);
      // A phase that lands exactly on a bucket boundary (or the final stop) has
      // an ambiguous owning bucket; skip those to keep the invariant crisp.
      if (bucket < 0) {
        continue;
      }
      for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
        if (!cellVisibleOnLattice(cells[cellIndex], state, REFERENCE_SHAPE, 16)) {
          continue;
        }
        oraclePositives += 1;
        if (!bitIsSet(output, bucket, cellIndex)) {
          if (misses.length < 12) {
            misses.push(
              `t=${elapsed}s cell#${cellIndex} ` +
                `[${cells[cellIndex].minLatitudeDeg}..${cells[cellIndex].maxLatitudeDeg} lat, ` +
                `${cells[cellIndex].minLongitudeDeg}..${cells[cellIndex].maxLongitudeDeg} lon] ` +
                `bucket ${bucket}`,
            );
          }
        }
      }
    }

    // Count module-covered bits so the scenario is proven non-trivial (a fix
    // that silently produced an empty raster would otherwise pass vacuously).
    for (let bucket = 0; bucket < output.bucketCount; bucket += 1) {
      for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
        if (bitIsSet(output, bucket, cellIndex)) {
          moduleCoveredBits += 1;
        }
      }
    }

    t.diagnostic(
      `oracle positives=${oraclePositives}, module covered bits=${moduleCoveredBits}, misses=${misses.length}`,
    );
    assert.ok(
      oraclePositives > 0,
      "the swept-SAR oracle must find real coverage (scenario must be non-trivial)",
    );
    assert.ok(
      moduleCoveredBits > 0,
      "the module must report coverage for the swept-SAR scenario",
    );
    assert.equal(
      misses.length,
      0,
      `module raster must cover every dense-oracle positive; missed:\n${misses.join("\n")}`,
    );
  } finally {
    await harness.destroy();
  }
});
