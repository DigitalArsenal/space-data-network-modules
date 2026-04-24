import test from "node:test";
import assert from "node:assert/strict";

import { createCoverageAnalyzer } from "../index.js";

const BASE_JD = 2451545.0;
const SECONDS_PER_DAY = 86400.0;

const FOM_IDS = {
  access_count: 0,
  total_access_duration: 1,
  percent_coverage: 2,
  mean_revisit_time: 3,
  max_revisit_time: 4,
  time_to_first_access: 5,
  number_of_gaps: 6,
  max_gap_duration: 7,
  average_gap_duration: 8,
};

const COLOR_MAP_IDS = {
  viridis: 0,
  jet: 1,
  hot: 2,
  cool: 3,
  grayscale: 4,
  stk_coverage: 5,
};

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

function writeGridConfig(config) {
  const bytes = new Uint8Array(80);
  const view = new DataView(bytes.buffer);
  const doubles = [
    config.minLatitudeDeg,
    config.maxLatitudeDeg,
    config.minLongitudeDeg,
    config.maxLongitudeDeg,
    config.latitudeStepDeg,
    config.longitudeStepDeg,
    config.startEpochJd,
    config.endEpochJd,
  ];
  doubles.forEach((value, index) => view.setFloat64(index * 8, value, true));
  view.setUint32(64, 0, true);
  return bytes;
}

function writeFootprintBatch(gridId, footprints) {
  let totalBytes = 16;
  for (const footprint of footprints) {
    totalBytes += 24 + footprint.vertices.length * 16;
  }
  const bytes = new Uint8Array(totalBytes);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, gridId, true);
  view.setUint32(4, footprints.length, true);
  let offset = 16;
  for (const footprint of footprints) {
    view.setFloat64(offset, footprint.startEpochJd, true);
    view.setFloat64(offset + 8, footprint.endEpochJd, true);
    view.setUint32(offset + 16, footprint.sensorId, true);
    view.setUint32(offset + 20, footprint.vertices.length, true);
    offset += 24;
    for (const vertex of footprint.vertices) {
      view.setFloat64(offset, vertex.latDeg, true);
      view.setFloat64(offset + 8, vertex.lonDeg, true);
      offset += 16;
    }
  }
  return bytes;
}

function writeGridIdRequest(gridId, extraU32 = 0) {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, gridId, true);
  view.setUint32(4, extraU32, true);
  return bytes;
}

function writeHeatmapRequest({
  gridId,
  fomType,
  colorMap,
  width,
  height,
  minValue,
  maxValue,
}) {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, gridId, true);
  view.setUint32(4, FOM_IDS[fomType], true);
  view.setUint32(8, COLOR_MAP_IDS[colorMap], true);
  view.setUint32(12, width, true);
  view.setUint32(16, height, true);
  view.setFloat64(24, minValue, true);
  view.setFloat64(32 - 8, maxValue, true);
  return bytes;
}

function writeUnionRequest(gridId, sensorIds) {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  const mask = sensorIds.reduce((value, sensorId) => value | (1n << BigInt(sensorId)), 0n);
  view.setUint32(0, gridId, true);
  view.setBigUint64(8, mask, true);
  return bytes;
}

function readGridInfo(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    gridId: view.getUint32(0, true),
    rowCount: view.getUint32(4, true),
    columnCount: view.getUint32(8, true),
    cellCount: view.getUint32(12, true),
  };
}

function readStatistics(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    totalCells: view.getUint32(0, true),
    accessedCells: view.getUint32(4, true),
    multiAccessCells: view.getUint32(8, true),
    percentCoverage: view.getFloat64(16, true),
    meanAccessCount: view.getFloat64(24, true),
    meanRevisitTime: view.getFloat64(32, true),
    maxGapDuration: view.getFloat64(56, true),
    totalAccessTime: view.getFloat64(64, true),
  };
}

function readIntervals(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(8, true);
  const intervals = [];
  let offset = 16;
  for (let index = 0; index < count; index++) {
    intervals.push({
      startTime: view.getFloat64(offset, true),
      endTime: view.getFloat64(offset + 8, true),
      duration: view.getFloat64(offset + 16, true),
    });
    offset += 32;
  }
  return intervals;
}

function readFomValues(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(8, true);
  const values = [];
  let offset = 16;
  for (let index = 0; index < count; index++) {
    values.push(view.getFloat64(offset, true));
    offset += 8;
  }
  return values;
}

function readUnion(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    unionCoveredCells: view.getUint32(12, true),
    fullyCoveredCells: view.getUint32(16, true),
    partialCoverageCells: view.getUint32(20, true),
    gapCells: view.getUint32(24, true),
    meanSensorsPerCoveredCell: view.getFloat64(40, true),
    maxGapDurationSec: view.getFloat64(48, true),
  };
}

test("Coverage analyzer exposes native streamInvoke for aligned-binary coverage operations", async function () {
  const analyzer = await createCoverageAnalyzer({
    requireEmbeddedManifest: true,
  });

  try {
    assert.equal(analyzer.supportsStreamInvoke, true);

    const createGridResult = analyzer.streamInvoke({
      methodId: "create_grid",
      inputs: [
        {
          portId: "grid",
          alignment: 8,
          bytes: writeGridConfig({
            minLatitudeDeg: 0,
            maxLatitudeDeg: 2,
            minLongitudeDeg: 0,
            maxLongitudeDeg: 3,
            latitudeStepDeg: 1,
            longitudeStepDeg: 1,
            startEpochJd: BASE_JD,
            endEpochJd: jdOffset(3600),
          }),
        },
      ],
      outputStreamCap: 1,
    });
    assert.equal(createGridResult.statusCode, 0);
    const grid = readGridInfo(createGridResult.outputs[0].bytes);
    assert.equal(grid.cellCount, 6);

    const accumulateResult = analyzer.streamInvoke({
      methodId: "accumulate_footprints",
      inputs: [
        {
          portId: "footprints",
          alignment: 8,
          bytes: writeFootprintBatch(grid.gridId, [
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
          ]),
        },
      ],
      outputStreamCap: 1,
    });
    assert.equal(accumulateResult.statusCode, 0);

    const statsResult = analyzer.streamInvoke({
      methodId: "get_statistics",
      inputs: [{ portId: "grid", alignment: 8, bytes: writeGridIdRequest(grid.gridId) }],
      outputStreamCap: 1,
    });
    assert.equal(statsResult.statusCode, 0);
    const statistics = readStatistics(statsResult.outputs[0].bytes);
    assert.equal(statistics.totalCells, 6);
    assert.equal(statistics.accessedCells, 1);
    assert.equal(statistics.meanAccessCount, 2);
    assert.equal(statistics.maxGapDuration, 300);

    const intervalResult = analyzer.streamInvoke({
      methodId: "get_access_intervals",
      inputs: [{ portId: "cell", alignment: 8, bytes: writeGridIdRequest(grid.gridId, 0) }],
      outputStreamCap: 1,
    });
    assert.equal(intervalResult.statusCode, 0);
    const intervals = readIntervals(intervalResult.outputs[0].bytes);
    assert.equal(intervals.length, 2);
    assert.equal(intervals[0].duration, 900);
    assert.equal(intervals[1].duration, 600);

    const fomResult = analyzer.streamInvoke({
      methodId: "compute_fom",
      inputs: [{ portId: "grid", alignment: 8, bytes: writeGridIdRequest(grid.gridId, FOM_IDS.access_count) }],
      outputStreamCap: 1,
    });
    assert.equal(fomResult.statusCode, 0);
    assert.deepEqual(readFomValues(fomResult.outputs[0].bytes), [2, 0, 0, 0, 0, 0]);

    const heatmapResult = analyzer.streamInvoke({
      methodId: "generate_heatmap",
      inputs: [
        {
          portId: "heatmap",
          alignment: 8,
          bytes: writeHeatmapRequest({
            gridId: grid.gridId,
            fomType: "access_count",
            colorMap: "viridis",
            width: 3,
            height: 2,
            minValue: 0,
            maxValue: 2,
          }),
        },
      ],
      outputStreamCap: 1,
    });
    assert.equal(heatmapResult.statusCode, 0);
    assert.equal(heatmapResult.outputs[0].bytes.length, 12 + 24);

    const unionResult = analyzer.streamInvoke({
      methodId: "analyze_sensor_union",
      inputs: [{ portId: "union", alignment: 8, bytes: writeUnionRequest(grid.gridId, [0, 1]) }],
      outputStreamCap: 1,
    });
    assert.equal(unionResult.statusCode, 0);
    const union = readUnion(unionResult.outputs[0].bytes);
    assert.equal(union.unionCoveredCells, 1);
    assert.equal(union.fullyCoveredCells, 1);
    assert.equal(union.partialCoverageCells, 0);
    assert.equal(union.gapCells, 5);
    assert.equal(union.meanSensorsPerCoveredCell, 2);
    assert.equal(union.maxGapDurationSec, 300);
  } finally {
    analyzer.destroy();
  }
});
