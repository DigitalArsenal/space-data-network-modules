import test from "node:test";
import assert from "node:assert/strict";

import { createCoverageAnalyzer } from "../index.js";

const BASE_JD = 2451545.0;
const SECONDS_PER_DAY = 86400.0;

function jdOffset(seconds) {
  return BASE_JD + seconds / SECONDS_PER_DAY;
}

function rectangle(minLatDeg, minLonDeg, maxLatDeg, maxLonDeg) {
  return [
    { latDeg: minLatDeg, lonDeg: minLonDeg },
    { latDeg: minLatDeg, lonDeg: maxLonDeg },
    { latDeg: maxLatDeg, lonDeg: maxLonDeg },
    { latDeg: maxLatDeg, lonDeg: minLonDeg },
  ];
}

test("Coverage analyzer accumulates footprints, tracks intervals, computes FOMs, and emits heatmaps", async function () {
  const analyzer = await createCoverageAnalyzer({
    requireEmbeddedManifest: true,
  });

  try {
    const grid = analyzer.createGrid({
      minLatitudeDeg: 0,
      maxLatitudeDeg: 2,
      minLongitudeDeg: 0,
      maxLongitudeDeg: 3,
      latitudeStepDeg: 1,
      longitudeStepDeg: 1,
      startEpochJd: BASE_JD,
      endEpochJd: jdOffset(3600),
    });

    const summary = analyzer.accumulateFootprints(grid.gridId, [
      {
        sensorId: 0,
        startEpochJd: jdOffset(0),
        endEpochJd: jdOffset(600),
        vertices: rectangle(0, 0, 1, 1),
      },
      {
        sensorId: 1,
        startEpochJd: jdOffset(300),
        endEpochJd: jdOffset(900),
        vertices: rectangle(0, 0, 1, 1),
      },
      {
        sensorId: 0,
        startEpochJd: jdOffset(1200),
        endEpochJd: jdOffset(1800),
        vertices: rectangle(0, 0, 1, 1),
      },
      {
        sensorId: 1,
        startEpochJd: jdOffset(0),
        endEpochJd: jdOffset(600),
        vertices: rectangle(0, 1, 1, 2),
      },
    ]);

    assert.equal(summary.footprintCount, 4);
    assert.equal(summary.affectedCells, 4);
    assert.equal(summary.accessedCellCount, 2);
    assert.equal(summary.updatedIntervals, 3);

    const cell0 = analyzer.getCellData(grid.gridId, 0);
    assert.equal(cell0.accessCount, 2);
    assert.equal(cell0.revisitCount, 1);
    assert.equal(cell0.totalAccessDuration, 1500);
    assert.equal(cell0.minRevisitTime, 300);
    assert.equal(cell0.maxRevisitTime, 300);
    assert.equal(cell0.sensorMask.toString(10), "3");
    assert.equal(cell0.flags & 0x01, 0x01);
    assert.equal(cell0.flags & 0x02, 0x02);

    const intervals = analyzer.getAccessIntervals(grid.gridId, 0);
    assert.equal(intervals.length, 2);
    assert.equal(intervals[0].duration, 900);
    assert.equal(intervals[1].duration, 600);

    const statistics = analyzer.getStatistics(grid.gridId);
    assert.equal(statistics.totalCells, 6);
    assert.equal(statistics.accessedCells, 2);
    assert.equal(statistics.multiAccessCells, 1);
    assert.equal(statistics.totalAccessTime, 2100);
    assert.equal(statistics.meanAccessCount, 1.5);
    assert.equal(statistics.meanRevisitTime, 300);
    assert.equal(statistics.maxGapDuration, 300);
    assert.ok(Math.abs(statistics.percentCoverage - 33.3333333333) < 1e-6);

    const accessCountFom = analyzer.computeFom(grid.gridId, "access_count");
    assert.deepEqual(Array.from(accessCountFom), [2, 1, 0, 0, 0, 0]);

    const coverageFom = analyzer.computeFom(grid.gridId, "percent_coverage");
    assert.ok(Math.abs(coverageFom[0] - 41.6666666667) < 1e-6);
    assert.ok(Math.abs(coverageFom[1] - 16.6666666667) < 1e-6);

    const union = analyzer.analyzeSensorUnion(grid.gridId, { sensorIds: [0, 1] });
    assert.equal(union.unionCoveredCells, 2);
    assert.equal(union.fullyCoveredCells, 1);
    assert.equal(union.partialCoverageCells, 1);
    assert.equal(union.gapCells, 4);
    assert.equal(union.meanSensorsPerCoveredCell, 1.5);
    assert.equal(union.maxGapDurationSec, 300);

    const minimumSensorSet = analyzer.computeMinimumSensorSet(grid.gridId, {
      cellIndices: [0, 1],
    });
    assert.deepEqual(minimumSensorSet.selectedSensorIds, [1]);
    assert.equal(minimumSensorSet.requiredCellCount, 2);
    assert.equal(minimumSensorSet.coveredCellCount, 2);
    assert.equal(minimumSensorSet.uncoveredCellCount, 0);
    assert.equal(minimumSensorSet.coverageComplete, true);

    const heatmap = analyzer.generateHeatmap(grid.gridId, {
      fomType: "access_count",
      colorMap: "viridis",
      width: 3,
      height: 2,
      minValue: 0,
      maxValue: 2,
    });
    assert.equal(heatmap.width, 3);
    assert.equal(heatmap.height, 2);
    assert.equal(heatmap.pixels.length, 24);
    assert.equal(heatmap.pixels[3], 255);
    assert.equal(heatmap.pixels[7], 255);
  } finally {
    analyzer.destroy();
  }
});

test("Coverage analyzer prefers the smallest greedy covering subset when overlap exists", async function () {
  const analyzer = await createCoverageAnalyzer({
    requireEmbeddedManifest: true,
  });

  try {
    const grid = analyzer.createGrid({
      minLatitudeDeg: 0,
      maxLatitudeDeg: 2,
      minLongitudeDeg: 0,
      maxLongitudeDeg: 2,
      latitudeStepDeg: 1,
      longitudeStepDeg: 1,
      startEpochJd: BASE_JD,
      endEpochJd: jdOffset(1800),
    });

    analyzer.accumulateFootprints(grid.gridId, [
      {
        sensorId: 0,
        startEpochJd: jdOffset(0),
        endEpochJd: jdOffset(600),
        vertices: rectangle(0, 0, 1, 2),
      },
      {
        sensorId: 1,
        startEpochJd: jdOffset(0),
        endEpochJd: jdOffset(600),
        vertices: rectangle(1, 0, 2, 1),
      },
      {
        sensorId: 2,
        startEpochJd: jdOffset(0),
        endEpochJd: jdOffset(600),
        vertices: rectangle(1, 1, 2, 2),
      },
    ]);

    const minimumSet = analyzer.computeMinimumSensorSet(grid.gridId);
    assert.deepEqual(minimumSet.selectedSensorIds, [0, 1, 2]);
    assert.deepEqual(minimumSet.candidateSensorIds, [0, 1, 2]);
    assert.equal(minimumSet.coverageComplete, true);
    assert.equal(minimumSet.coveredCellCount, 4);
    assert.equal(minimumSet.uncoveredCellCount, 0);

    const partialSet = analyzer.computeMinimumSensorSet(grid.gridId, {
      sensorIds: [0, 2],
    });
    assert.equal(partialSet.coverageComplete, false);
    assert.equal(partialSet.coveredCellCount, 3);
    assert.equal(partialSet.uncoveredCellCount, 1);
  } finally {
    analyzer.destroy();
  }
});

test("Coverage analyzer computes a greedy minimum sensor set for full coverage", async function () {
  const analyzer = await createCoverageAnalyzer({
    requireEmbeddedManifest: true,
  });

  try {
    const grid = analyzer.createGrid({
      minLatitudeDeg: 0,
      maxLatitudeDeg: 1,
      minLongitudeDeg: 0,
      maxLongitudeDeg: 4,
      latitudeStepDeg: 1,
      longitudeStepDeg: 1,
      startEpochJd: BASE_JD,
      endEpochJd: jdOffset(3600),
    });

    analyzer.accumulateFootprints(grid.gridId, [
      {
        sensorId: 0,
        startEpochJd: jdOffset(0),
        endEpochJd: jdOffset(600),
        vertices: rectangle(0, 0, 1, 2),
      },
      {
        sensorId: 1,
        startEpochJd: jdOffset(0),
        endEpochJd: jdOffset(600),
        vertices: rectangle(0, 1, 1, 4),
      },
      {
        sensorId: 2,
        startEpochJd: jdOffset(0),
        endEpochJd: jdOffset(600),
        vertices: rectangle(0, 3, 1, 4),
      },
    ]);

    const result = analyzer.computeMinimumSensorSet(grid.gridId);
    assert.deepEqual([...result.selectedSensorIds].sort((a, b) => a - b), [0, 1]);
    assert.equal(result.coveredCellCount, 4);
    assert.equal(result.uncoveredCellCount, 0);
    assert.equal(result.coverageFraction, 1);
    assert.equal(result.selectedSensorIds.length, 2);
  } finally {
    analyzer.destroy();
  }
});
