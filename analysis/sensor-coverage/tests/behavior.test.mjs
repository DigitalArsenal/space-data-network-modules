import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`sensor coverage module accumulates time coverage and colored swaths on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(
      harness,
      {
        grid: {
          minLatitudeDeg: 0,
          maxLatitudeDeg: 2,
          minLongitudeDeg: 0,
          maxLongitudeDeg: 3,
          latitudeStepDeg: 1,
          longitudeStepDeg: 1,
        },
        timeSpan: {
          startSeconds: 0,
          stopSeconds: 3600,
        },
        figureOfMerit: "percent_coverage",
        colorMap: "stk_coverage",
        footprints: [
          {
            sensorId: 0,
            startSeconds: 0,
            stopSeconds: 600,
            minLatitudeDeg: 0,
            maxLatitudeDeg: 1,
            minLongitudeDeg: 0,
            maxLongitudeDeg: 1,
          },
          {
            sensorId: 1,
            startSeconds: 300,
            stopSeconds: 900,
            minLatitudeDeg: 0,
            maxLatitudeDeg: 1,
            minLongitudeDeg: 0,
            maxLongitudeDeg: 1,
          },
          {
            sensorId: 0,
            startSeconds: 1200,
            stopSeconds: 1800,
            minLatitudeDeg: 0,
            maxLatitudeDeg: 1,
            minLongitudeDeg: 0,
            maxLongitudeDeg: 1,
          },
          {
            sensorId: 1,
            startSeconds: 0,
            stopSeconds: 600,
            minLatitudeDeg: 0,
            maxLatitudeDeg: 1,
            minLongitudeDeg: 1,
            maxLongitudeDeg: 2,
          },
        ],
      },
      {
        methodId: "compute_sensor_coverage",
        inputPortId: "coverage",
        outputPortId: "coverage",
      },
    );

    assert.equal(result.provider, "sensor-coverage-analysis");
    assert.equal(result.grid.cellCount, 6);
    assert.equal(result.statistics.accessedCells, 2);
    assert.equal(result.statistics.multiAccessCells, 1);
    assert.equal(result.statistics.totalAccessDurationSec, 2100);
    assert.ok(Math.abs(result.statistics.percentCoverage - 33.3333333333) < 1e-6);
    assert.equal(result.cells[0].accessCount, 2);
    assert.equal(result.cells[0].totalAccessDurationSec, 1500);
    assert.equal(result.cells[0].maxGapDurationSec, 300);
    assert.ok(Math.abs(result.cells[0].percentCoverage - 41.6666666667) < 1e-6);
    assert.equal(result.cells[1].accessCount, 1);
    assert.ok(Math.abs(result.cells[1].percentCoverage - 16.6666666667) < 1e-6);
    assert.equal(result.swaths.length, 2);
    assert.ok(result.swaths.every((swath) => swath.colorRgba.length === 4));
    assert.ok(result.swaths[0].colorRgba[3] > 0);
    assert.equal(result.figureOfMerit.values.length, 6);
    assert.equal(result.figureOfMerit.units, "percent");
  });
}
