import assert from "node:assert/strict";
import test from "node:test";

import {
  bitIsSet,
  buildGridCells,
  cellVisibleOnLattice,
  conicShape,
  createContractHarness,
  createCoveragePayload,
  invokeAndReadCoverage,
  lookAngleDegrees,
  productionLatticeCellVisible,
  quaternionFromAxisAngle,
  stateSample,
} from "./sensor_coverage_contract_helpers.mjs";

// Numerical-oracle record required by the repository contract:
//
// Source: closed-form WGS84 ECEF conversion and the public SCV solid-conic
// containment definition (horizon dot > 0, Euclidean range, cone angle).
// Units: geodetic degrees, ECEF metres, elapsed SI seconds.
// Frame: Earth BODY_FIXED; identity sensor quaternion means derived radial
// nadir. Epoch/time scale: synthetic elapsed seconds t=0..2; no UTC epoch is
// involved because all states are body-fixed and static.
// Tolerance: the oracle's 2e-12 rad containment allowance is approximately
// 1.3e-5 m at Earth radius. It covers libm rounding at exact tangency but is
// far smaller than the finest spatial lattice spacing used below.
//
// A finite lattice can prove positive witnesses, not continuum negatives.
// Therefore the contract asserted cell-for-cell and bucket-for-bucket is the
// pinned conservative invariant: oracle-positive is a subset of module-positive.
// The module may legitimately find a continuum intersection between oracle
// samples. Every scenario still evaluates every cell in every bucket.

function staticStates(latitudeDeg, longitudeDeg, options = {}) {
  return [0, 1, 2].map((elapsedSeconds) => stateSample({
    elapsedSeconds,
    latitudeDeg,
    longitudeDeg,
    altitudeM: options.altitudeM,
    quaternion: options.quaternion,
  }));
}

function scenario({
  name,
  grid,
  latitudeDeg,
  longitudeDeg,
  outerHalfAngleDeg,
  categories,
  witness = null,
  latticeDivisions = 64,
  quaternion = undefined,
}) {
  const states = staticStates(latitudeDeg, longitudeDeg, { quaternion });
  const shape = conicShape({ outerHalfAngleDeg });
  return {
    name,
    grid,
    states,
    shape,
    categories,
    witness,
    latticeDivisions,
  };
}

const scenarios = [
  scenario({
    name: "coarse-8deg-live-phase edge clip between the nine production samples",
    grid: {
      minLatitudeDeg: -12,
      maxLatitudeDeg: 12,
      minLongitudeDeg: 164,
      maxLongitudeDeg: 180,
      latitudeStepDeg: 8,
      longitudeStepDeg: 8,
    },
    latitudeDeg: -5,
    longitudeDeg: 178,
    outerHalfAngleDeg: 12.5,
    categories: ["coarse", "phase-0", "smaller-than-cell", "live-mode"],
    witness: { cellIndex: 3, latitudeDeg: -4, longitudeDeg: 178 },
  }),
  {
    ...scenario({
      name: "coarse-8deg edge clip with a nonzero minimum range",
      grid: {
        minLatitudeDeg: -12,
        maxLatitudeDeg: 12,
        minLongitudeDeg: 164,
        maxLongitudeDeg: 180,
        latitudeStepDeg: 8,
        longitudeStepDeg: 8,
      },
      latitudeDeg: -5,
      longitudeDeg: 178,
      outerHalfAngleDeg: 12.5,
      categories: ["coarse", "nonzero-min-range", "smaller-than-cell"],
      witness: { cellIndex: 3, latitudeDeg: -4, longitudeDeg: 178 },
    }),
    shape: conicShape({ outerHalfAngleDeg: 12.5, minRangeM: 1 }),
  },
  scenario({
    name: "coarse-8deg phase offset one",
    grid: {
      minLatitudeDeg: -10,
      maxLatitudeDeg: 14,
      minLongitudeDeg: 160,
      maxLongitudeDeg: 176,
      latitudeStepDeg: 8,
      longitudeStepDeg: 8,
    },
    latitudeDeg: -3,
    longitudeDeg: 170,
    outerHalfAngleDeg: 12.5,
    categories: ["coarse", "phase-1", "smaller-than-cell"],
    witness: { cellIndex: 3, latitudeDeg: -2, longitudeDeg: 170 },
  }),
  scenario({
    name: "coarse-8deg phase offset two",
    grid: {
      minLatitudeDeg: -9,
      maxLatitudeDeg: 15,
      minLongitudeDeg: 161,
      maxLongitudeDeg: 177,
      latitudeStepDeg: 8,
      longitudeStepDeg: 8,
    },
    latitudeDeg: -2,
    longitudeDeg: 171,
    outerHalfAngleDeg: 12.5,
    categories: ["coarse", "phase-2", "smaller-than-cell"],
    witness: { cellIndex: 3, latitudeDeg: -1, longitudeDeg: 171 },
  }),
  scenario({
    name: "fine-0.5deg grid with footprint below the production sample pitch",
    grid: {
      minLatitudeDeg: -0.75,
      maxLatitudeDeg: 0.75,
      minLongitudeDeg: 10,
      maxLongitudeDeg: 11,
      latitudeStepDeg: 0.5,
      longitudeStepDeg: 0.5,
    },
    latitudeDeg: -0.3,
    longitudeDeg: 10.625,
    outerHalfAngleDeg: 0.8,
    categories: ["fine", "smaller-than-cell"],
    witness: { cellIndex: 3, latitudeDeg: -0.25, longitudeDeg: 10.625 },
  }),
  scenario({
    name: "footprint comparable to a four-degree cell",
    grid: {
      minLatitudeDeg: -4,
      maxLatitudeDeg: 4,
      minLongitudeDeg: -4,
      maxLongitudeDeg: 4,
      latitudeStepDeg: 4,
      longitudeStepDeg: 4,
    },
    latitudeDeg: 0.05,
    longitudeDeg: 0.05,
    outerHalfAngleDeg: 40,
    categories: ["comparable-to-cell", "boresight-near-corner"],
  }),
  scenario({
    name: "footprint larger than an eight-degree cell",
    grid: {
      minLatitudeDeg: -12,
      maxLatitudeDeg: 12,
      minLongitudeDeg: -12,
      maxLongitudeDeg: 12,
      latitudeStepDeg: 8,
      longitudeStepDeg: 8,
    },
    latitudeDeg: 0,
    longitudeDeg: 0,
    outerHalfAngleDeg: 65,
    categories: ["larger-than-cell"],
  }),
  scenario({
    name: "off-nadir tilted conic positive footprint",
    grid: {
      minLatitudeDeg: -2,
      maxLatitudeDeg: 2,
      minLongitudeDeg: 1,
      maxLongitudeDeg: 5,
      latitudeStepDeg: 1,
      longitudeStepDeg: 1,
    },
    latitudeDeg: 0,
    longitudeDeg: 0,
    outerHalfAngleDeg: 5,
    quaternion: quaternionFromAxisAngle({ x: 0, y: 1, z: 0 }, 30),
    categories: ["off-nadir", "fine"],
    latticeDivisions: 48,
  }),
  scenario({
    name: "antimeridian crossing into the negative-longitude edge cell",
    grid: {
      minLatitudeDeg: -12,
      maxLatitudeDeg: 12,
      minLongitudeDeg: -180,
      maxLongitudeDeg: -164,
      latitudeStepDeg: 8,
      longitudeStepDeg: 8,
    },
    latitudeDeg: -4.6,
    longitudeDeg: 179.5,
    outerHalfAngleDeg: 18,
    categories: ["antimeridian", "coarse"],
    witness: { cellIndex: 2, latitudeDeg: -4, longitudeDeg: -180 },
  }),
  scenario({
    name: "high-latitude polar-row edge clip",
    grid: {
      minLatitudeDeg: 88,
      maxLatitudeDeg: 90,
      minLongitudeDeg: -120,
      maxLongitudeDeg: 120,
      latitudeStepDeg: 1,
      longitudeStepDeg: 120,
    },
    latitudeDeg: 88.9,
    longitudeDeg: 30,
    outerHalfAngleDeg: 3,
    categories: ["high-latitude", "polar-cell", "smaller-than-cell"],
    witness: { cellIndex: 3, latitudeDeg: 89, longitudeDeg: 30 },
    latticeDivisions: 120,
  }),
];

// Exact conic edge tangency: derive the cone half-angle from the intended
// WGS84 surface witness rather than rounding a nominal angle.
{
  const states = staticStates(-5, 178);
  const tangentPoint = { latitudeDeg: -4, longitudeDeg: 178 };
  scenarios.push({
    name: "inclusive edge tangency between production lattice points",
    grid: {
      minLatitudeDeg: -12,
      maxLatitudeDeg: 12,
      minLongitudeDeg: 164,
      maxLongitudeDeg: 180,
      latitudeStepDeg: 8,
      longitudeStepDeg: 8,
    },
    states,
    shape: conicShape({
      outerHalfAngleDeg: lookAngleDegrees(states[0], tangentPoint.latitudeDeg, tangentPoint.longitudeDeg),
    }),
    categories: ["edge-tangency", "coarse"],
    witness: { cellIndex: 3, ...tangentPoint },
    latticeDivisions: 64,
  });
}

test("dense WGS84 oracle positives are never omitted by conic cell intersection", async (t) => {
  const coveredCategories = new Set(scenarios.flatMap((entry) => entry.categories));
  for (const required of [
    "coarse",
    "fine",
    "phase-0",
    "phase-1",
    "phase-2",
    "smaller-than-cell",
    "comparable-to-cell",
    "larger-than-cell",
    "edge-tangency",
    "boresight-near-corner",
    "antimeridian",
    "high-latitude",
    "polar-cell",
    "nonzero-min-range",
    "off-nadir",
  ]) {
    assert.equal(coveredCategories.has(required), true, `scenario matrix must cover ${required}`);
  }

  const harness = await createContractHarness(t);
  if (!harness) {
    return;
  }
  t.after(async () => {
    await harness.destroy();
  });

  for (const entry of scenarios) {
    await t.test(entry.name, async () => {
      const cells = buildGridCells(entry.grid);
      const extraPoints = entry.witness ? [entry.witness] : [];
      const oraclePositiveCells = cells
        .filter((cell) => cellVisibleOnLattice(
          cell,
          entry.states[0],
          entry.shape,
          entry.latticeDivisions,
          extraPoints,
        ))
        .map((cell) => cell.index);
      assert.ok(
        oraclePositiveCells.length > 0,
        `${entry.name}: dense oracle must contain at least one positive cell`,
      );

      if (entry.witness) {
        const witnessCell = cells[entry.witness.cellIndex];
        assert.ok(witnessCell, `${entry.name}: witness cell index must exist`);
        assert.equal(
          cellVisibleOnLattice(
            witnessCell,
            entry.states[0],
            entry.shape,
            entry.latticeDivisions,
            [entry.witness],
          ),
          true,
          `${entry.name}: named continuum witness must be visible`,
        );
      }

      const output = await invokeAndReadCoverage(
        harness,
        createCoveragePayload({
          id: `spatial-${entry.name}`,
          grid: entry.grid,
          timeGrid: { start: 0, stop: 2, step: 1, count: 2 },
          states: entry.states,
          shape: entry.shape,
        }),
      );
      assert.equal(output.bucketCount, 2, `${entry.name}: fixture cadence must stay isolated`);

      for (let bucketIndex = 0; bucketIndex < 2; bucketIndex += 1) {
        for (const cell of cells) {
          const oraclePositive = oraclePositiveCells.includes(cell.index);
          const modulePositive = bitIsSet(output, bucketIndex, cell.index);
          if (oraclePositive) {
            assert.equal(
              modulePositive,
              true,
              `${entry.name}: oracle-positive pair omitted at bucket=${bucketIndex}, ` +
                `cell=${cell.index}, bounds=` +
                `[${cell.minLatitudeDeg},${cell.maxLatitudeDeg}]x` +
                `[${cell.minLongitudeDeg},${cell.maxLongitudeDeg}]`,
            );
          }
        }
      }
    });
  }
});

test("diagnosed coarse edge witness is invisible at all nine production samples", () => {
  const entry = scenarios[0];
  const witnessCell = buildGridCells(entry.grid)[entry.witness.cellIndex];
  assert.equal(
    productionLatticeCellVisible(witnessCell, entry.states[0], entry.shape),
    false,
    "the RED witness must isolate the 3x3 lattice mechanism",
  );
  assert.equal(
    cellVisibleOnLattice(
      witnessCell,
      entry.states[0],
      entry.shape,
      entry.latticeDivisions,
      [entry.witness],
    ),
    true,
    "the exhaustive oracle must see the between-sample edge clip",
  );
});

test("a provably cap-disjoint cell remains negative", async (t) => {
  const grid = {
    minLatitudeDeg: -1,
    maxLatitudeDeg: 1,
    minLongitudeDeg: 0,
    maxLongitudeDeg: 20,
    latitudeStepDeg: 1,
    longitudeStepDeg: 10,
  };
  const states = staticStates(0, 0);
  const shape = conicShape({ outerHalfAngleDeg: 0.5 });
  const cells = buildGridCells(grid);
  // Row 0, column 1 spans longitude [10,20]. Its nearest point is over nine
  // degrees outside this sub-degree nadir footprint, well beyond the oracle
  // tolerance and the conservative footprint cap.
  const farCell = cells[1];
  assert.equal(
    cellVisibleOnLattice(farCell, states[0], shape, 128),
    false,
    "the independent dense oracle must classify the far cell negative",
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
      id: "spatial-cap-disjoint-negative",
      grid,
      timeGrid: { start: 0, stop: 2, step: 1, count: 2 },
      states,
      shape,
    }),
  );
  for (let bucketIndex = 0; bucketIndex < 2; bucketIndex += 1) {
    assert.equal(
      bitIsSet(output, bucketIndex, farCell.index),
      false,
      `cap-disjoint cell must remain negative in bucket ${bucketIndex}`,
    );
  }
});

test("a tilted conic does not turn its subpoint envelope into access", async (t) => {
  const grid = {
    minLatitudeDeg: -1,
    maxLatitudeDeg: 1,
    minLongitudeDeg: -1,
    maxLongitudeDeg: 1,
    latitudeStepDeg: 1,
    longitudeStepDeg: 1,
  };
  const states = staticStates(0, 0, {
    quaternion: quaternionFromAxisAngle(
      { x: 0, y: 1, z: 0 },
      30,
    ),
  });
  const shape = conicShape({ outerHalfAngleDeg: 5 });
  const cells = buildGridCells(grid);
  for (const cell of cells) {
    assert.equal(
      cellVisibleOnLattice(cell, states[0], shape, 128),
      false,
      `tilted-cone exact oracle must reject subpoint cell ${cell.index}`,
    );
  }

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
      id: "spatial-tilted-conic-subpoint-negative",
      grid,
      timeGrid: { start: 0, stop: 2, step: 1, count: 2 },
      states,
      shape,
    }),
  );
  for (let bucketIndex = 0; bucketIndex < 2; bucketIndex += 1) {
    for (const cell of cells) {
      assert.equal(
        bitIsSet(output, bucketIndex, cell.index),
        false,
        `tilted-cone subpoint cell ${cell.index} must stay negative`,
      );
    }
  }
});
