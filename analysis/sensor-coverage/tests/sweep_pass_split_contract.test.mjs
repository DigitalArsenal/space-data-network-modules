import assert from "node:assert/strict";
import test from "node:test";

import {
  bitIsSet,
  buildGridCells,
  createContractHarness,
  createCoveragePayload,
  invokeAndReadCoverage,
  quaternionFromAxisAngle,
  resolvedFrame,
  sarAnnularSectorShape,
  stateSample,
} from "./sensor_coverage_contract_helpers.mjs";

// No-pass-splitting contract for the sweep-phase temporal subdivision.
//
// The subdivision splits a wide-swing segment into 2^m equal sub-windows and
// resumes the search at depth m so its leaves and merged intervals match the
// un-subdivided segment EXACTLY. The failure mode this guards is a subdivision
// that searches each sub-window to a FINER absolute time resolution than the
// segment: that resolves grazing micro-gaps (a few ms) the un-subdivided search
// merges over, splitting ONE continuous access into two passes. A naive
// "subdivide + recurse from depth 0 in each window" implementation does exactly
// that — it was observed to turn the cell below from one pass into two.
//
// Config: a full-circle annular SAR (look band 5..55 deg, so the reference is a
// clean look-angle annulus) sweeping +/-50 deg / 120 s about nadir over the
// coarse 8 deg grid, 15 s attitude samples. The witness cell (lat -12..-4,
// lon -28..-20) has a single continuous grazing-onset transit (~8.8 s..~15.7 s)
// whose onset sits mid-segment and whose span crosses many sub-window
// boundaries of segments that are subdivided (m >= 3). It MUST remain one pass.
const WINDOW_SECONDS = 90;
const STATE_STEP_SECONDS = 15;
const STATE_COUNT = WINDOW_SECONDS / STATE_STEP_SECONDS + 1;
const BUCKET_STEP_SECONDS = 0.5; // fine buckets so the covered span is precise
const BUCKET_COUNT = WINDOW_SECONDS / BUCKET_STEP_SECONDS;

const AMP_DEG = 50;
const PERIOD_SECONDS = 120;
const OFF_NADIR_DEG = 0;
const INNER_LOOK_DEG = 5;
const OUTER_LOOK_DEG = 55;
const RANGE_M = 2500000;
const TARGET_SWING_DEG = 3; // must match kSweepSubIntervalTargetSwingDeg
const MAX_SUBDIVISION_DEPTH = 6; // must match kSweepMaxSubIntervalDepth

// Witness cell, identified by geometry (robust to grid indexing).
const WITNESS_MIN_LAT = -12;
const WITNESS_MIN_LON = -28;

// Total pass-start count across the whole raster for this fixed config. The
// subdivision is bit-identical to the un-subdivided search, so this is stable;
// a splitting regression can only ADD passes, pushing the total above it.
const EXPECTED_TOTAL_PASS_STARTS = 39;

const R_M = 6378137 + 550000;
const GM = 3.986004418e14;
const V_MPS = Math.sqrt(GM / R_M);
const RATE = V_MPS / R_M;
const INC = (51.6 * Math.PI) / 180;

const GRID = Object.freeze({
  minLatitudeDeg: -60,
  maxLatitudeDeg: 60,
  minLongitudeDeg: -180,
  maxLongitudeDeg: 180,
  latitudeStepDeg: 8,
  longitudeStepDeg: 8,
});

const SHAPE = sarAnnularSectorShape({
  innerLookAngleDeg: INNER_LOOK_DEG,
  outerLookAngleDeg: OUTER_LOOK_DEG,
  minClockAngleDeg: -180,
  maxClockAngleDeg: 180,
  maxRangeM: RANGE_M,
  samplingDensity: 256,
});

function sweepQuaternion(t) {
  return quaternionFromAxisAngle(
    { x: 1, y: 0, z: 0 },
    OFF_NADIR_DEG + AMP_DEG * Math.sin((2 * Math.PI * t) / PERIOD_SECONDS),
  );
}

function orbitState(t) {
  const th = RATE * t;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const ci = Math.cos(INC);
  const si = Math.sin(INC);
  return stateSample({
    elapsedSeconds: t,
    position: { x: R_M * c, y: R_M * s * ci, z: R_M * s * si },
    velocity: { x: -V_MPS * s, y: V_MPS * c * ci, z: V_MPS * c * si },
    quaternion: sweepQuaternion(t),
  });
}

// Mirror the module's subdivision decision for one 15 s segment: the number of
// equal sub-windows is 2^m, where m is the smallest depth with 2^m >=
// ceil(swing / target), 0 when the swing is at or below the target.
function subdivisionDepth(states, segmentIndex) {
  const a = resolvedFrame(states[segmentIndex]).boresight;
  const b = resolvedFrame(states[segmentIndex + 1]).boresight;
  const dotp = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  const swingDeg = (Math.acos(dotp) * 180) / Math.PI;
  if (swingDeg <= TARGET_SWING_DEG) {
    return 0;
  }
  const windowsNeeded = Math.ceil(swingDeg / TARGET_SWING_DEG);
  let m = 0;
  while (m < MAX_SUBDIVISION_DEPTH && 1 << m < windowsNeeded) {
    m += 1;
  }
  return m;
}

test("swept-SAR transit crossing sub-window boundaries stays ONE pass (no split)", async (t) => {
  const harness = await createContractHarness(t);
  if (!harness) {
    return;
  }
  try {
    const states = Array.from({ length: STATE_COUNT }, (_, i) =>
      orbitState(i * STATE_STEP_SECONDS),
    );
    const payload = createCoveragePayload({
      id: "sweep-pass-split-contract",
      grid: GRID,
      timeGrid: {
        start: 0,
        stop: WINDOW_SECONDS,
        step: BUCKET_STEP_SECONDS,
        count: BUCKET_COUNT,
      },
      states,
      shape: SHAPE,
      includePackedGeometry: false,
    });
    const output = await invokeAndReadCoverage(harness, payload);
    const cells = buildGridCells(GRID);

    const witnessIndex = cells.findIndex(
      (c) =>
        Math.abs(c.minLatitudeDeg - WITNESS_MIN_LAT) < 1e-6 &&
        Math.abs(c.minLongitudeDeg - WITNESS_MIN_LON) < 1e-6,
    );
    assert.ok(witnessIndex >= 0, "witness cell must exist in the grid");

    // Covered time span of the witness cell (fine buckets).
    let tmin = Infinity;
    let tmax = -Infinity;
    for (let b = 0; b < output.bucketCount; b += 1) {
      if (bitIsSet(output, b, witnessIndex)) {
        tmin = Math.min(tmin, output.bucketStart[b]);
        tmax = Math.max(tmax, output.bucketStop[b]);
      }
    }
    assert.ok(
      Number.isFinite(tmin) && tmax > tmin,
      "witness cell must be covered (non-trivial scenario)",
    );

    // ── Meaningfulness: the transit really crosses a sub-window boundary of a
    // subdivided (m > 0) segment. ──
    const firstSegment = Math.floor(tmin / STATE_STEP_SECONDS);
    const m = subdivisionDepth(states, firstSegment);
    assert.ok(
      m > 0,
      `witness segment ${firstSegment} must be subdivided (2^m windows); got m=${m}`,
    );
    const subWindowSeconds = STATE_STEP_SECONDS / (1 << m);
    // A span wider than one sub-window necessarily contains a boundary.
    assert.ok(
      tmax - tmin > subWindowSeconds,
      `covered span ${(tmax - tmin).toFixed(3)}s must exceed one sub-window ` +
        `${subWindowSeconds.toFixed(3)}s so it crosses a boundary`,
    );
    // Exhibit an actual boundary time strictly inside the covered span.
    let crossedBoundary = null;
    for (
      let seg = firstSegment;
      seg <= Math.floor(tmax / STATE_STEP_SECONDS) && seg + 1 < STATE_COUNT;
      seg += 1
    ) {
      const segM = subdivisionDepth(states, seg);
      if (segM <= 0) continue;
      const t0 = seg * STATE_STEP_SECONDS;
      for (let i = 1; i < 1 << segM; i += 1) {
        const bt = t0 + (STATE_STEP_SECONDS * i) / (1 << segM);
        if (bt > tmin + 1e-6 && bt < tmax - 1e-6) {
          crossedBoundary = bt;
          break;
        }
      }
      if (crossedBoundary !== null) break;
    }
    assert.ok(
      crossedBoundary !== null,
      "the covered span must straddle a computed sub-window boundary",
    );

    t.diagnostic(
      `witness cell#${witnessIndex} span=[${tmin.toFixed(2)},${tmax.toFixed(2)}]s ` +
        `m=${m} subWindow=${subWindowSeconds.toFixed(3)}s ` +
        `boundary=${crossedBoundary.toFixed(3)}s passCount=${output.passCount[witnessIndex]}`,
    );

    // ── The property: ONE continuous access, ONE pass start. A resolution-
    // mismatched subdivision splits this grazing transit into two. ──
    assert.equal(
      output.passCount[witnessIndex],
      1,
      "a single continuous transit crossing sub-window boundaries must remain " +
        "exactly one pass (accessCount == 1)",
    );

    // ── Whole-raster guard: subdivision never fabricates extra passes. ──
    let totalPassStarts = 0;
    for (let i = 0; i < cells.length; i += 1) {
      totalPassStarts += output.passCount[i];
    }
    assert.equal(
      totalPassStarts,
      EXPECTED_TOTAL_PASS_STARTS,
      "total pass-start count must match the un-subdivided search; a splitting " +
        "regression raises it",
    );
  } finally {
    await harness.destroy();
  }
});
