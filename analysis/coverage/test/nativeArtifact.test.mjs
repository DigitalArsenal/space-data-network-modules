import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const BASE_JD = 2451545.0;
const SECONDS_PER_DAY = 86400.0;
const FOM_IDS = {
  access_count: 0,
};
const COLOR_MAP_IDS = {
  viridis: 0,
};

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

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

function writeUnionRequest(gridId, sensorIds) {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  const mask = sensorIds.reduce(
    (value, sensorId) => value | (1n << BigInt(sensorId)),
    0n,
  );
  view.setUint32(0, gridId, true);
  view.setBigUint64(8, mask, true);
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
  view.setFloat64(24, maxValue, true);
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
  for (let index = 0; index < count; index += 1) {
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
  for (let index = 0; index < count; index += 1) {
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

function readHeatmap(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint32(0, true),
    height: view.getUint32(4, true),
    pixelCount: view.getUint32(8, true),
    pixels: bytes.slice(12),
  };
}

async function withHarness(t, callback) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  await callback(harness);
}

async function invoke(harness, methodId, portId, typeRef, payload) {
  return harness.invoke({
    methodId,
    inputs: [{ portId, typeRef, payload }],
  });
}

test("coverage manifest declares the shared browser/WasmEdge artifact", () => {
  const manifest = readManifest();
  assert.deepEqual(manifest.runtimeTargets, ["browser", "wasmedge"]);
  assert.equal(manifest.buildArtifacts?.[0]?.path, "dist/isomorphic/module.wasm");
});

test("coverage C++ artifact passes SDK compliance checks", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("coverage C++ artifact exposes the standalone isomorphic surface", async () => {
  const inspection = await inspectModule(fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)));
  const importedModuleNames = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(importedModuleNames, ["wasi_snapshot_preview1"]);
  for (const required of [
    "_start",
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

test("coverage C++ artifact accumulates footprint intervals and emits statistics", async (t) => {
  await withHarness(t, async (harness) => {
    const createGridResult = await invoke(
      harness,
      "create_grid",
      "grid",
      {
        schemaName: "orbpro.analysis.CoverageGridConfig",
        fileIdentifier: "CVGC",
        rootTypeName: "CoverageGridConfig",
      },
      writeGridConfig({
        minLatitudeDeg: 0,
        maxLatitudeDeg: 2,
        minLongitudeDeg: 0,
        maxLongitudeDeg: 3,
        latitudeStepDeg: 1,
        longitudeStepDeg: 1,
        startEpochJd: BASE_JD,
        endEpochJd: jdOffset(3600),
      }),
    );
    assert.equal(createGridResult.statusCode, 0, createGridResult.errorMessage);
    const gridFrame = createGridResult.outputs[0];
    assert.equal(gridFrame.typeRef?.fileIdentifier, "CVGI");
    const grid = readGridInfo(gridFrame.payload);
    assert.equal(grid.cellCount, 6);

    const accumulateResult = await invoke(
      harness,
      "accumulate_footprints",
      "footprints",
      {
        schemaName: "orbpro.analysis.CoverageFootprintBatch",
        fileIdentifier: "CVFB",
        rootTypeName: "CoverageFootprintBatch",
      },
      writeFootprintBatch(grid.gridId, [
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
    );
    assert.equal(accumulateResult.statusCode, 0, accumulateResult.errorMessage);
    assert.equal(accumulateResult.outputs.length, 0);

    const statsResult = await invoke(
      harness,
      "get_statistics",
      "grid",
      {
        schemaName: "orbpro.analysis.CoverageGridInfo",
        fileIdentifier: "CVGI",
        rootTypeName: "CoverageGridInfo",
      },
      writeGridIdRequest(grid.gridId),
    );
    assert.equal(statsResult.statusCode, 0, statsResult.errorMessage);
    const statistics = readStatistics(statsResult.outputs[0].payload);
    assert.equal(statistics.totalCells, 6);
    assert.equal(statistics.accessedCells, 1);
    assert.equal(statistics.multiAccessCells, 1);
    assert.equal(statistics.meanAccessCount, 2);
    assert.equal(statistics.meanRevisitTime, 300);
    assert.equal(statistics.maxGapDuration, 300);
    assert.equal(statistics.totalAccessTime, 1500);

    const intervalResult = await invoke(
      harness,
      "get_access_intervals",
      "cell",
      {
        schemaName: "orbpro.analysis.CoverageGridInfo",
        fileIdentifier: "CVGI",
        rootTypeName: "CoverageGridInfo",
      },
      writeGridIdRequest(grid.gridId, 0),
    );
    assert.equal(intervalResult.statusCode, 0, intervalResult.errorMessage);
    const intervals = readIntervals(intervalResult.outputs[0].payload);
    assert.equal(intervals.length, 2);
    assert.equal(intervals[0].duration, 900);
    assert.equal(intervals[1].duration, 600);

    const fomResult = await invoke(
      harness,
      "compute_fom",
      "grid",
      {
        schemaName: "orbpro.analysis.CoverageGridInfo",
        fileIdentifier: "CVGI",
        rootTypeName: "CoverageGridInfo",
      },
      writeGridIdRequest(grid.gridId, 0),
    );
    assert.equal(fomResult.statusCode, 0, fomResult.errorMessage);
    assert.deepEqual(readFomValues(fomResult.outputs[0].payload), [2, 0, 0, 0, 0, 0]);

    const heatmapResult = await invoke(
      harness,
      "generate_heatmap",
      "heatmap",
      {
        schemaName: "orbpro.analysis.CoverageHeatmapResult",
        fileIdentifier: "CVHR",
        rootTypeName: "CoverageHeatmapResult",
      },
      writeHeatmapRequest({
        gridId: grid.gridId,
        fomType: "access_count",
        colorMap: "viridis",
        width: 3,
        height: 2,
        minValue: 0,
        maxValue: 2,
      }),
    );
    assert.equal(heatmapResult.statusCode, 0, heatmapResult.errorMessage);
    const heatmap = readHeatmap(heatmapResult.outputs[0].payload);
    assert.equal(heatmap.width, 3);
    assert.equal(heatmap.height, 2);
    assert.equal(heatmap.pixelCount, 24);
    assert.equal(heatmap.pixels[3], 255);
    assert.equal(heatmap.pixels[7], 0);

    const unionResult = await invoke(
      harness,
      "analyze_sensor_union",
      "union",
      {
        schemaName: "orbpro.analysis.CoverageUnionResult",
        fileIdentifier: "CVUR",
        rootTypeName: "CoverageUnionResult",
      },
      writeUnionRequest(grid.gridId, [0, 1]),
    );
    assert.equal(unionResult.statusCode, 0, unionResult.errorMessage);
    const union = readUnion(unionResult.outputs[0].payload);
    assert.equal(union.unionCoveredCells, 1);
    assert.equal(union.fullyCoveredCells, 1);
    assert.equal(union.partialCoverageCells, 0);
    assert.equal(union.gapCells, 5);
    assert.equal(union.meanSensorsPerCoveredCell, 2);
    assert.equal(union.maxGapDurationSec, 300);
  });
});
