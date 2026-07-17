import assert from "node:assert/strict";
import test from "node:test";

import {
  bitIsSet,
  buildGridCells,
  cellVisibleOnLattice,
  conicShape,
  createContractHarness,
  createCoveragePayload,
  interpolateState,
  invokeAndReadCoverage,
  lookAngleDegrees,
  quaternionFromAxisAngle,
  stateSample,
  surfacePointVisible,
} from "./sensor_coverage_contract_helpers.mjs";

// Numerical-oracle record required by the repository contract:
//
// Source: the diagnostic point is the published Phase 1 fixture witness at
// elapsed seconds 17145/17160/17175 (cell 305, WGS84 point -4 deg, 108 deg),
// translated to a local elapsed-second origin without changing ECEF state.
// Boundary ownership uses a closed-form WGS84 conic/cell-edge tangency. The
// remaining cases are body-fixed WGS84 motions constructed to put a narrow
// radial-nadir conic footprint between the production candidate probes. Units
// are ECEF metres, m/s, geodetic degrees, and elapsed SI seconds.
// Frame: Earth BODY_FIXED. Epoch/time scale: the Phase 1 source epoch is
// 2026-05-24T12:00:00Z UTC; shifting every state/time-grid offset by the same
// constant preserves the interpolation physics. Synthetic cases use elapsed
// time only and no civil epoch.
// Tolerances: the spatial oracle uses the helper's 2e-12 rad libm allowance.
// Temporal searches divide 64 s into 4096 closed samples (15.625 ms); each
// constructed positive interval supplies several independent positive samples,
// while the endpoint tangency is asserted directly rather than inferred.

const PHASE1_CELL_GRID = Object.freeze({
  minLatitudeDeg: -12,
  maxLatitudeDeg: -4,
  minLongitudeDeg: 100,
  maxLongitudeDeg: 108,
  latitudeStepDeg: 8,
  longitudeStepDeg: 8,
});
const PHASE1_SHAPE = conicShape({ outerHalfAngleDeg: 12.5 });
const PHASE1_WITNESS_POINT = Object.freeze({ latitudeDeg: -4, longitudeDeg: 108 });

const PHASE1_STATES = Object.freeze([
  Object.freeze({
    originalElapsedSeconds: 17145,
    position: Object.freeze({
      x: -2048044.323662069,
      y: 6551432.157680758,
      z: -447286.1204772966,
    }),
    velocity: Object.freeze({
      x: -4158.662033082042,
      y: -900.3234819181218,
      z: 5949.660417955269,
    }),
    quaternion: Object.freeze({
      x: 0.00012668728018789264,
      y: 0.0001782067850036461,
      z: 0.00004848761560617969,
      w: 0.9999999749208127,
    }),
  }),
  Object.freeze({
    originalElapsedSeconds: 17160,
    position: Object.freeze({
      x: -2110155.3601105907,
      y: 6537095.95975102,
      z: -357983.57740003546,
    }),
    velocity: Object.freeze({
      x: -4122.670698543399,
      y: -1011.1340688026637,
      z: 5957.0881710663825,
    }),
    quaternion: Object.freeze({
      x: 0.00010135957647520738,
      y: 0.00014282010135890818,
      z: -0.0000763334670599761,
      w: 0.9999999817509283,
    }),
  }),
  Object.freeze({
    originalElapsedSeconds: 17175,
    position: Object.freeze({
      x: -2171719.803289159,
      y: 6521099.014988031,
      z: -268581.9763199774,
    }),
    velocity: Object.freeze({
      x: -4085.786939318961,
      y: -1121.752601378953,
      z: 5962.867866061731,
    }),
    quaternion: Object.freeze({
      x: 0.00007605058307639806,
      y: 0.00010724880170520164,
      z: 0.00004884647943812372,
      w: 0.9999999901640124,
    }),
  }),
]);

function phase1State(index, elapsedSeconds) {
  const source = PHASE1_STATES[index];
  return stateSample({
    elapsedSeconds,
    position: source.position,
    velocity: source.velocity,
    quaternion: source.quaternion,
  });
}

function visibleTimesForSingleCell({
  start,
  stop,
  grid,
  shape,
  timeDivisions = 4096,
  spatialDivisions = 8,
}) {
  const [cell] = buildGridCells(grid);
  const visibleTimes = [];
  for (let index = 0; index <= timeDivisions; index += 1) {
    const elapsedSeconds = start.elapsedSeconds +
      ((stop.elapsedSeconds - start.elapsedSeconds) * index) / timeDivisions;
    const state = interpolateState(start, stop, elapsedSeconds);
    if (cellVisibleOnLattice(cell, state, shape, spatialDivisions)) {
      visibleTimes.push(elapsedSeconds);
    }
  }
  return visibleTimes;
}

test("published Phase 1 endpoint point witness remains independently reproducible", () => {
  const states = [
    phase1State(0, 0),
    phase1State(1, 15),
    phase1State(2, 30),
  ];
  assert.equal(
    surfacePointVisible(
      PHASE1_WITNESS_POINT.latitudeDeg,
      PHASE1_WITNESS_POINT.longitudeDeg,
      states[1],
      PHASE1_SHAPE,
    ),
    true,
    "the published t=17160 s endpoint witness must remain visible",
  );
  assert.equal(
    surfacePointVisible(
      PHASE1_WITNESS_POINT.latitudeDeg,
      PHASE1_WITNESS_POINT.longitudeDeg,
      states[2],
      PHASE1_SHAPE,
    ),
    false,
    "the point must be invisible after the endpoint witness",
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
const TANGENCY_STATE = stateSample({
  elapsedSeconds: 15,
  latitudeDeg: 0,
  longitudeDeg: 0,
  altitudeM: 500000,
});
const TANGENCY_SHAPE = conicShape({
  // Closed-form boundary: the conic half-angle is exactly the WGS84 look
  // angle from the nadir sensor to the cell's nearest point (lat 0, lon 1).
  outerHalfAngleDeg: lookAngleDegrees(TANGENCY_STATE, 0, 1),
  // A negligible inner cutout keeps this boundary-ownership fixture on the
  // exact conic predicate. It is six orders of magnitude below the tangent
  // look angle and cannot change the closed-form outer-edge contact.
  innerHalfAngleDeg: 0.000001,
});

function tangencyStateAt(elapsedSeconds) {
  if (elapsedSeconds === 15) {
    return TANGENCY_STATE;
  }
  return { ...TANGENCY_AWAY_STATE, elapsedSeconds };
}

test("an exact endpoint tangency belongs only to the later bucket", async (t) => {
  const states = [
    tangencyStateAt(0),
    TANGENCY_STATE,
    tangencyStateAt(30),
  ];
  const [cell] = buildGridCells(TANGENCY_GRID);
  assert.equal(cellVisibleOnLattice(cell, states[0], TANGENCY_SHAPE, 64), false);
  assert.equal(cellVisibleOnLattice(cell, states[1], TANGENCY_SHAPE, 64), true);
  assert.equal(cellVisibleOnLattice(cell, states[2], TANGENCY_SHAPE, 64), false);
  assert.equal(
    cellVisibleOnLattice(
      cell,
      interpolateState(states[0], states[1], 14.999),
      TANGENCY_SHAPE,
      64,
    ),
    false,
    "the cell must be invisible immediately before the exact tangency",
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
      id: "temporal-final-stop-singleton",
      grid: TANGENCY_GRID,
      timeGrid: { start: 0, stop: 30, step: 15, count: 2 },
      states,
      shape: TANGENCY_SHAPE,
    }),
  );
  assert.equal(bitIsSet(output, 0, 0), false);
  assert.equal(bitIsSet(output, 1, 0), true);
  assert.equal(output.passCount[0], 1, "an endpoint singleton counts as one pass start");
});

test("an exact access singleton at final STOP belongs to the last bucket", async (t) => {
  const states = [tangencyStateAt(0), TANGENCY_STATE];
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
      id: "temporal-final-stop-singleton",
      grid: TANGENCY_GRID,
      timeGrid: { start: 0, stop: 15, step: 15, count: 1 },
      states,
      shape: TANGENCY_SHAPE,
    }),
  );
  assert.equal(
    bitIsSet(output, 0, 0),
    true,
    "the exact final STOP instant must be retained in the last bucket",
  );
  assert.equal(output.passCount[0], 1, "the final-STOP singleton counts as a pass start");
});

const hiddenInteriorCases = [
  {
    name: "narrow rotating footprint enters between start/mid/stop probes",
    grid: {
      minLatitudeDeg: -0.005,
      maxLatitudeDeg: 0.005,
      minLongitudeDeg: 0.01,
      maxLongitudeDeg: 0.02,
      latitudeStepDeg: 0.01,
      longitudeStepDeg: 0.01,
    },
    shape: conicShape({ outerHalfAngleDeg: 0.05 }),
    start: stateSample({
      elapsedSeconds: 0,
      latitudeDeg: 0,
      longitudeDeg: 0,
      altitudeM: 500000,
      quaternion: quaternionFromAxisAngle({ x: 0, y: 1, z: 0 }, 0),
    }),
    stop: stateSample({
      elapsedSeconds: 64,
      latitudeDeg: 0,
      longitudeDeg: 0,
      altitudeM: 500000,
      quaternion: quaternionFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.9),
    }),
  },
  {
    name: "translated narrow footprint enters between capped subdivision probes",
    grid: {
      minLatitudeDeg: -0.005,
      maxLatitudeDeg: 0.005,
      minLongitudeDeg: -16.18,
      maxLongitudeDeg: -16.17,
      latitudeStepDeg: 0.01,
      longitudeStepDeg: 0.01,
    },
    shape: conicShape({ outerHalfAngleDeg: 0.1 }),
    start: stateSample({
      elapsedSeconds: 0,
      latitudeDeg: 0,
      longitudeDeg: -20,
      altitudeM: 500000,
    }),
    stop: stateSample({
      elapsedSeconds: 64,
      latitudeDeg: 0,
      longitudeDeg: 20,
      altitudeM: 500000,
    }),
  },
];

for (const entry of hiddenInteriorCases) {
  test(entry.name, async (t) => {
    const [cell] = buildGridCells(entry.grid);
    const midpoint = interpolateState(entry.start, entry.stop, 32);
    assert.equal(
      cellVisibleOnLattice(cell, entry.start, entry.shape, 8),
      false,
      `${entry.name}: start must be invisible`,
    );
    assert.equal(
      cellVisibleOnLattice(cell, midpoint, entry.shape, 8),
      false,
      `${entry.name}: midpoint must be invisible`,
    );
    assert.equal(
      cellVisibleOnLattice(cell, entry.stop, entry.shape, 8),
      false,
      `${entry.name}: stop must be invisible`,
    );
    const oracleVisibleTimes = visibleTimesForSingleCell(entry);
    assert.ok(
      oracleVisibleTimes.length >= 3,
      `${entry.name}: exhaustive interior-time oracle must find a resolved access interval`,
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
        id: `temporal-${entry.name}`,
        grid: entry.grid,
        timeGrid: { start: 0, stop: 64, step: 64, count: 1 },
        states: [entry.start, entry.stop],
        shape: entry.shape,
      }),
    );
    assert.equal(
      bitIsSet(output, 0, 0),
      true,
      `${entry.name}: module omitted oracle-positive hidden interior access ` +
        `(first oracle time=${oracleVisibleTimes[0]} s)`,
    );
    assert.equal(output.passCount[0], 1, `${entry.name}: one crossing must start exactly one pass`);
  });
}

test("annular sweep preserves a hidden gap as two pass starts", async (t) => {
  const grid = {
    minLatitudeDeg: -0.0005,
    maxLatitudeDeg: 0.0005,
    minLongitudeDeg: -0.0005,
    maxLongitudeDeg: 0.0005,
    latitudeStepDeg: 0.001,
    longitudeStepDeg: 0.001,
  };
  const shape = conicShape({
    innerHalfAngleDeg: 2,
    outerHalfAngleDeg: 20,
  });
  const start = stateSample({
    elapsedSeconds: 0,
    latitudeDeg: 0,
    longitudeDeg: 0,
    altitudeM: 500000,
    quaternion: quaternionFromAxisAngle(
      { x: 0, y: 1, z: 0 },
      -6,
    ),
  });
  const stop = stateSample({
    elapsedSeconds: 64,
    latitudeDeg: 0,
    longitudeDeg: 0,
    altitudeM: 500000,
    quaternion: quaternionFromAxisAngle(
      { x: 0, y: 1, z: 0 },
      18,
    ),
  });
  const [cell] = buildGridCells(grid);
  const oracleRuns = [];
  let active = false;
  for (let index = 0; index <= 4096; index += 1) {
    const elapsedSeconds = 64 * index / 4096;
    const visible = cellVisibleOnLattice(
      cell,
      interpolateState(start, stop, elapsedSeconds),
      shape,
      8,
    );
    if (visible && !active) {
      oracleRuns.push(elapsedSeconds);
    }
    active = visible;
  }
  assert.equal(oracleRuns.length, 2, "independent oracle must resolve two annular passes");

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
      id: "temporal-annular-hidden-gap",
      grid,
      timeGrid: { start: 0, stop: 64, step: 64, count: 1 },
      states: [start, stop],
      shape,
    }),
  );
  assert.equal(bitIsSet(output, 0, 0), true);
  assert.equal(output.passCount[0], 2, "hidden annular gap must retain two pass starts");
});
