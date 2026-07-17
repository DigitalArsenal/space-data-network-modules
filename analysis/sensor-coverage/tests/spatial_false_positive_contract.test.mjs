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
  stateSample,
  surfacePointVisible,
} from "./sensor_coverage_contract_helpers.mjs";

// Numerical-oracle record required by the repository contract:
//
// Source: closed-form WGS84 ECEF conversion and the public SCV solid-conic
// containment definition (horizon dot > 0, Euclidean range, cone angle).
// Units: geodetic degrees, ECEF metres, elapsed SI seconds.
// Frame: Earth BODY_FIXED with the module's derived frame plus the supplied
// sensor quaternion. The two named regressions are literal crops of the
// OrbPro request at original state indices 2556..2557 and 2165..2166.
// Epoch/time scale: intervals are shifted to synthetic elapsed seconds t=0..15;
// no UTC epoch is involved because interpolation is entirely BODY_FIXED.
// Tolerance: oracle membership uses a 65x65 closed spatial lattice (0.03125
// degree pitch on each 2-degree regression cell) at 401 closed temporal
// samples per 15-second segment (0.0375-second pitch). The independent
// rectangle optimizer stops below 1e-4 geodetic degree and diagnoses clips
// between lattice points. The asserted negative witnesses remain at least 0.4
// degree outside the FOV, over twelve spatial pitches and far beyond numeric
// noise. A 2e-12 rad allowance covers libm rounding at exact containment.

const ORACLE_POSITION_TOLERANCE_DEG = 1e-4;
const VISIBILITY_TOLERANCE_RAD = 2e-12;
const VISIBILITY_TOLERANCE_DEG = VISIBILITY_TOLERANCE_RAD * 180 / Math.PI;
const SPATIAL_SUBDIVISIONS = 64;
const TEMPORAL_SUBDIVISIONS = 400;

function staticStates(latitudeDeg, longitudeDeg) {
  return [0, 1, 2].map((elapsedSeconds) => stateSample({
    elapsedSeconds,
    latitudeDeg,
    longitudeDeg,
  }));
}

// Match the independently tightened physics gate: maximize signed conic FOV
// slack over the complete lat/lon rectangle from a 5x5 seed lattice, then use
// bounded Hooke-Jeeves refinement until both coordinate steps are <1e-4 deg.
function maximumSignedConicSlack(cell, state, shape) {
  const evaluate = (longitudeDeg, latitudeDeg) => ({
    longitudeDeg,
    latitudeDeg,
    slackDeg: shape.outerHalfAngleDeg -
      lookAngleDegrees(state, latitudeDeg, longitudeDeg),
  });

  let best = null;
  const seedDivisions = 4;
  for (let latitudeIndex = 0; latitudeIndex <= seedDivisions; latitudeIndex += 1) {
    for (let longitudeIndex = 0; longitudeIndex <= seedDivisions; longitudeIndex += 1) {
      const latitudeDeg = cell.minLatitudeDeg +
        ((cell.maxLatitudeDeg - cell.minLatitudeDeg) * latitudeIndex) / seedDivisions;
      const longitudeDeg = cell.minLongitudeDeg +
        ((cell.maxLongitudeDeg - cell.minLongitudeDeg) * longitudeIndex) / seedDivisions;
      const candidate = evaluate(longitudeDeg, latitudeDeg);
      if (!best || candidate.slackDeg > best.slackDeg) {
        best = candidate;
      }
    }
  }

  let longitudeStepDeg =
    (cell.maxLongitudeDeg - cell.minLongitudeDeg) / seedDivisions;
  let latitudeStepDeg =
    (cell.maxLatitudeDeg - cell.minLatitudeDeg) / seedDivisions;
  const directions = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];
  for (
    let iteration = 0;
    iteration < 64 &&
      (longitudeStepDeg > ORACLE_POSITION_TOLERANCE_DEG ||
        latitudeStepDeg > ORACLE_POSITION_TOLERANCE_DEG);
    iteration += 1
  ) {
    let improved = false;
    for (const [longitudeDirection, latitudeDirection] of directions) {
      const longitudeDeg = Math.max(
        cell.minLongitudeDeg,
        Math.min(
          cell.maxLongitudeDeg,
          best.longitudeDeg + longitudeDirection * longitudeStepDeg,
        ),
      );
      const latitudeDeg = Math.max(
        cell.minLatitudeDeg,
        Math.min(
          cell.maxLatitudeDeg,
          best.latitudeDeg + latitudeDirection * latitudeStepDeg,
        ),
      );
      const candidate = evaluate(longitudeDeg, latitudeDeg);
      if (candidate.slackDeg > best.slackDeg) {
        best = candidate;
        improved = true;
      }
    }
    if (!improved) {
      longitudeStepDeg *= 0.5;
      latitudeStepDeg *= 0.5;
    }
  }
  return best;
}

function temporalRectangleOracle(cell, states, shape) {
  let visible = false;
  let best = null;
  for (let segmentIndex = 0; segmentIndex + 1 < states.length; segmentIndex += 1) {
    const start = states[segmentIndex];
    const stop = states[segmentIndex + 1];
    for (let sampleIndex = 0; sampleIndex <= TEMPORAL_SUBDIVISIONS; sampleIndex += 1) {
      if (segmentIndex > 0 && sampleIndex === 0) {
        continue;
      }
      const elapsedSeconds = start.elapsedSeconds +
        (stop.elapsedSeconds - start.elapsedSeconds) *
          sampleIndex / TEMPORAL_SUBDIVISIONS;
      const state = interpolateState(start, stop, elapsedSeconds);
      // Evaluate the complete horizon+range+shape predicate on a documented
      // 65x65 rectangle lattice at every one of the 401 temporal samples.
      // The independent optimizer below closes clips between lattice points
      // and supplies the signed-slack diagnostic used by the OrbPro gate.
      const denseLatticeVisible = cellVisibleOnLattice(
        cell,
        state,
        shape,
        SPATIAL_SUBDIVISIONS,
      );
      const candidate = maximumSignedConicSlack(cell, state, shape);
      if (!best || candidate.slackDeg > best.slackDeg) {
        best = { ...candidate, elapsedSeconds };
      }
      const optimizedWitnessVisible =
        candidate.slackDeg >= -VISIBILITY_TOLERANCE_DEG &&
        surfacePointVisible(
          candidate.latitudeDeg,
          candidate.longitudeDeg,
          state,
          shape,
          VISIBILITY_TOLERANCE_RAD,
        );
      if (denseLatticeVisible || optimizedWitnessVisible) {
        visible = true;
      }
    }
  }
  return { visible, best };
}

function oracleVisibleCellIndices(cells, states, shape) {
  const results = new Map(cells.map((cell) => [
    cell.index,
    temporalRectangleOracle(cell, states, shape),
  ]));
  return {
    indices: cells
      .filter((cell) => results.get(cell.index).visible)
      .map((cell) => cell.index),
    results,
  };
}

const cases = [
  {
    name: "nonempty set-equality control with a hard extra",
    states: staticStates(0, 0),
    grid: {
      minLatitudeDeg: -1,
      maxLatitudeDeg: 1,
      minLongitudeDeg: -0.75,
      maxLongitudeDeg: 3.25,
      latitudeStepDeg: 2,
      longitudeStepDeg: 2,
    },
    timeGrid: { start: 0, stop: 2, step: 1, count: 2 },
    witnessCenter: { latitudeDeg: 0, longitudeDeg: 2.25 },
    requirePositiveControl: true,
  },
  {
    name: "OrbPro fine-grid hard extra centered at [-53,-85]",
    states: [
      stateSample({
        elapsedSeconds: 0,
        position: {
          x: 395256.8029712568,
          y: -4355106.221396469,
          z: -5315136.642186377,
        },
        velocity: {
          x: 6978.985903172343,
          y: 1862.387135776529,
          z: -1006.525073362337,
        },
        quaternion: {
          x: 0.001607342386773494,
          y: -0.0003577837922532299,
          z: -0.00001114214379858167,
          w: 0.9999986441576122,
        },
      }),
      stateSample({
        elapsedSeconds: 15,
        position: {
          x: 499913.46958982694,
          y: -4326691.586061188,
          z: -5329502.858313682,
        },
        velocity: {
          x: 6974.981126399911,
          y: 1926.1554648774127,
          z: -908.927893147463,
        },
        quaternion: {
          x: 0.0016122502989808255,
          y: -0.0003239832456586463,
          z: -0.000009990858937169699,
          w: 0.9999986477910922,
        },
      }),
    ],
    grid: {
      minLatitudeDeg: -54,
      maxLatitudeDeg: -52,
      minLongitudeDeg: -86,
      maxLongitudeDeg: -84,
      latitudeStepDeg: 2,
      longitudeStepDeg: 2,
    },
    timeGrid: { start: 0, stop: 15, step: 15, count: 1 },
    witnessCenter: { latitudeDeg: -53, longitudeDeg: -85 },
  },
  {
    name: "OrbPro fine-grid hard extra centered at [-49,-79]",
    states: [
      stateSample({
        elapsedSeconds: 0,
        position: {
          x: 1028757.8811061506,
          y: -4611836.8514682045,
          z: -5004665.947243986,
        },
        velocity: {
          x: 5869.89580644014,
          y: 3718.749888879107,
          z: -2220.5328282363816,
        },
        quaternion: {
          x: 0.0015023886998928211,
          y: -0.0007430987876954076,
          z: -0.000019309471892971362,
          w: 0.9999985951287784,
        },
      }),
      stateSample({
        elapsedSeconds: 15,
        position: {
          x: 1116722.9349040063,
          y: -4555524.531277131,
          z: -5037283.817629347,
        },
        velocity: {
          x: 5858.569088606531,
          y: 3789.4106859319013,
          z: -2128.4199406456746,
        },
        quaternion: {
          x: 0.0015132858547583373,
          y: -0.0007169797782790011,
          z: 0.00002635843451638088,
          w: 0.9999985976045929,
        },
      }),
    ],
    grid: {
      minLatitudeDeg: -50,
      maxLatitudeDeg: -48,
      minLongitudeDeg: -80,
      maxLongitudeDeg: -78,
      latitudeStepDeg: 2,
      longitudeStepDeg: 2,
    },
    timeGrid: { start: 0, stop: 15, step: 15, count: 1 },
    witnessCenter: { latitudeDeg: -49, longitudeDeg: -79 },
  },
];

test("solid-conic output equals the dense rectangle oracle in both directions", async (t) => {
  const harness = await createContractHarness(t);
  if (!harness) {
    return;
  }
  t.after(async () => {
    await harness.destroy();
  });

  const shape = conicShape({
    outerHalfAngleDeg: 12.5,
    maxRangeM: 1_600_000,
  });

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const cells = buildGridCells(entry.grid);
      const witnessCell = cells.find((cell) =>
        0.5 * (cell.minLatitudeDeg + cell.maxLatitudeDeg) ===
          entry.witnessCenter.latitudeDeg &&
        0.5 * (cell.minLongitudeDeg + cell.maxLongitudeDeg) ===
          entry.witnessCenter.longitudeDeg);
      assert.ok(witnessCell, `${entry.name}: named witness cell must exist`);

      const oracle = oracleVisibleCellIndices(cells, entry.states, shape);
      const expected = oracle.indices;
      const witnessBest = oracle.results.get(witnessCell.index).best;
      assert.ok(
        witnessBest.slackDeg < -0.4,
        `${entry.name}: witness must be outside by >0.4 deg; ` +
          `maximum signed FOV slack=${witnessBest.slackDeg}`,
      );

      if (entry.requirePositiveControl) {
        assert.ok(expected.length > 0, `${entry.name}: fixture must include true positives`);
      }
      assert.equal(
        expected.includes(witnessCell.index),
        false,
        `${entry.name}: hard-extra witness must be oracle-negative`,
      );

      const output = await invokeAndReadCoverage(
        harness,
        createCoveragePayload({
          id: `spatial-false-positive-${entry.witnessCenter.latitudeDeg}`,
          grid: entry.grid,
          timeGrid: entry.timeGrid,
          states: entry.states,
          shape,
        }),
      );
      assert.equal(output.bucketCount, entry.timeGrid.count);

      for (let bucketIndex = 0; bucketIndex < output.bucketCount; bucketIndex += 1) {
        const actual = cells
          .filter((cell) => bitIsSet(output, bucketIndex, cell.index))
          .map((cell) => cell.index);
        const missing = expected.filter((index) => !actual.includes(index));
        const hardExtras = actual.filter((index) => !expected.includes(index));
        assert.deepEqual(
          { missing, hardExtras },
          { missing: [], hardExtras: [] },
          `${entry.name}: bucket=${bucketIndex} must equal the dense rectangle oracle; ` +
            `missing=${JSON.stringify(missing)}, ` +
            `hardExtras=${JSON.stringify(hardExtras)}, ` +
            `witnessCell=${witnessCell.index}, ` +
            `witnessMaxSlackDeg=${witnessBest.slackDeg}, ` +
            `witnessBestTime=${witnessBest.elapsedSeconds}`,
        );
      }
    });
  }

  await t.test("high-latitude ellipsoid horizon is not clipped by the B-sphere cap", async () => {
    const polarShape = conicShape({
      outerHalfAngleDeg: 68,
      maxRangeM: 4_000_000,
    });
    const polarGrid = {
      minLatitudeDeg: -64.951,
      maxLatitudeDeg: -64.949,
      minLongitudeDeg: -0.001,
      maxLongitudeDeg: 0.001,
      latitudeStepDeg: 0.002,
      longitudeStepDeg: 0.002,
    };
    const polarStates = [0, 15].map((elapsedSeconds) => stateSample({
      elapsedSeconds,
      position: {
        x: 324004.6215646696,
        y: 0,
        z: -6870501.407901299,
      },
      velocity: { x: 0, y: 7500, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
    }));
    const cells = buildGridCells(polarGrid);
    assert.equal(cells.length, 1);
    const oracle = oracleVisibleCellIndices(cells, polarStates, polarShape);
    assert.deepEqual(
      oracle.indices,
      [0],
      `closed-form high-latitude witness must be visible; ` +
        `maximum signed FOV slack=${oracle.results.get(0).best.slackDeg}`,
    );

    const output = await invokeAndReadCoverage(
      harness,
      createCoveragePayload({
        id: "spatial-polar-horizon-slack",
        grid: polarGrid,
        timeGrid: { start: 0, stop: 15, step: 15, count: 1 },
        states: polarStates,
        shape: polarShape,
      }),
    );
    const actual = cells
      .filter((cell) => bitIsSet(output, 0, cell.index))
      .map((cell) => cell.index);
    assert.deepEqual(actual, oracle.indices);
  });
});
