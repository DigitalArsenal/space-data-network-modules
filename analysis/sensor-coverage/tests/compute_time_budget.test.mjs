import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { parentPort, Worker, workerData } from "node:worker_threads";

import {
  conicShape,
  createContractHarness,
  createCoveragePayload,
  gridDimensions,
  invokeCoveragePayload,
  rectangularShape,
  sarAnnularSectorShape,
  stateSample,
} from "./sensor_coverage_contract_helpers.mjs";

// Production-scale regression fixture: one 12-hour LEO track sampled every
// 15 seconds (2881 interpolation states), request-driven 60-second output
// buckets (720), and the live coarse 8-degree regional grid (15 x 45 = 675).
const WINDOW_SECONDS = 12 * 60 * 60;
const STATE_STEP_SECONDS = 15;
const STATE_COUNT = WINDOW_SECONDS / STATE_STEP_SECONDS + 1;
const GRID_STEP_SECONDS = 60;
const GRID_INDEX_COUNT = WINDOW_SECONDS / GRID_STEP_SECONDS;
const COMPUTE_BUDGET_MS = 5000;
const WORKER_RESULT_GRACE_MS = 1000;
const WORKER_SETUP_TIMEOUT_MS = 8000;

const EARTH_RADIUS_M = 6378137;
const ORBIT_RADIUS_M = EARTH_RADIUS_M + 550000;
const EARTH_GM_M3_PER_S2 = 3.986004418e14;
const ORBIT_SPEED_MPS = Math.sqrt(EARTH_GM_M3_PER_S2 / ORBIT_RADIUS_M);
const ORBIT_RATE_RAD_PER_SEC = ORBIT_SPEED_MPS / ORBIT_RADIUS_M;
const INCLINATION_RAD = (51.6 * Math.PI) / 180;

const COARSE_GRID = Object.freeze({
  minLatitudeDeg: -60,
  maxLatitudeDeg: 60,
  minLongitudeDeg: -180,
  maxLongitudeDeg: 180,
  latitudeStepDeg: 8,
  longitudeStepDeg: 8,
});

const SHAPES = Object.freeze({
  conic: conicShape({
    outerHalfAngleDeg: 12.5,
    maxRangeM: 1600000,
  }),
  rectangular: rectangularShape({
    crossTrackHalfAngleDeg: 15,
    alongTrackHalfAngleDeg: 5,
    maxRangeM: 1600000,
  }),
  sar: sarAnnularSectorShape({
    innerLookAngleDeg: 26,
    outerLookAngleDeg: 34,
    minClockAngleDeg: -2,
    maxClockAngleDeg: 2,
    maxRangeM: 2500000,
    samplingDensity: 256,
  }),
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

function createBudgetPayload(shapeName) {
  const states = Array.from(
    { length: STATE_COUNT },
    (_, index) => orbitState(index * STATE_STEP_SECONDS),
  );
  return createCoveragePayload({
    id: `compute-time-budget-${shapeName}`,
    grid: COARSE_GRID,
    timeGrid: {
      start: 0,
      stop: WINDOW_SECONDS,
      step: GRID_STEP_SECONDS,
      count: GRID_INDEX_COUNT,
    },
    states,
    shape: SHAPES[shapeName],
    includePackedGeometry: false,
  });
}

async function prepareShapeMeasurement(shapeName) {
  const t = {
    skip(message) {
      throw new Error(message);
    },
  };
  const harness = await createContractHarness(t);
  const payload = createBudgetPayload(shapeName);
  return {
    async invoke() {
      const start = performance.now();
      const response = await invokeCoveragePayload(harness, payload);
      const elapsedMs = performance.now() - start;
      assert.equal(response.statusCode, 0, response.errorMessage);
      return elapsedMs;
    },
    async destroy() {
      await harness.destroy();
    },
  };
}

function measureShapeInWorker(shapeName) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let computeTimeout = null;
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { role: "compute-budget", shapeName },
      execArgv: [],
    });
    const settleAfterTermination = (callback) => {
      void worker.terminate().then(callback, reject);
    };
    const setupTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      settleAfterTermination(() => reject(new Error(
        `${shapeName} worker setup exceeded ${WORKER_SETUP_TIMEOUT_MS} ms`,
      )));
    }, WORKER_SETUP_TIMEOUT_MS);
    worker.once("message", (message) => {
      if (message.ready) {
        clearTimeout(setupTimeout);
        computeTimeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          settleAfterTermination(() => reject(new Error(
            `${shapeName} did not report completion within the ` +
              `${COMPUTE_BUDGET_MS} ms compute budget`,
          )));
        }, COMPUTE_BUDGET_MS + WORKER_RESULT_GRACE_MS);
        worker.postMessage({ invoke: true });
        worker.once("message", (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(computeTimeout);
          settleAfterTermination(() => result.error
            ? reject(new Error(result.error))
            : resolve(result.elapsedMs));
        });
      } else if (!settled) {
        settled = true;
        clearTimeout(setupTimeout);
        settleAfterTermination(() => reject(new Error(
          message.error ?? `${shapeName} worker did not become ready`,
        )));
      }
    });
    worker.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(setupTimeout);
      clearTimeout(computeTimeout);
      reject(error);
    });
    worker.once("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(setupTimeout);
        clearTimeout(computeTimeout);
        reject(new Error(
          `${shapeName} worker exited before reporting a result (code ${code})`,
        ));
      }
    });
  });
}

if (workerData?.role !== "compute-budget") {
  const dimensions = gridDimensions(COARSE_GRID);
  assert.equal(dimensions.rows * dimensions.columns, 675);
  assert.equal(STATE_COUNT, 2881);
  assert.equal(GRID_INDEX_COUNT, 720);

  test("conic, rectangular, and SAR meet the 12-hour coarse-grid compute budget", {
    timeout: Object.keys(SHAPES).length *
      (WORKER_SETUP_TIMEOUT_MS + COMPUTE_BUDGET_MS +
        WORKER_RESULT_GRACE_MS + 1000),
  }, async (t) => {
    for (const shapeName of Object.keys(SHAPES)) {
      await t.test(`${shapeName} completes under five seconds`, async (t) => {
        const elapsedMs = await measureShapeInWorker(shapeName);
        t.diagnostic(`${shapeName} compute time: ${elapsedMs.toFixed(3)} ms`);
        assert.ok(
          elapsedMs < COMPUTE_BUDGET_MS,
          `${shapeName} compute time ${elapsedMs.toFixed(3)} ms exceeded ${COMPUTE_BUDGET_MS} ms`,
        );
      });
    }
  });
} else {
  prepareShapeMeasurement(workerData.shapeName).then(
    (measurement) => {
      parentPort.postMessage({ ready: true });
      parentPort.once("message", () => {
        measurement.invoke().then(
          (elapsedMs) => parentPort.postMessage({ elapsedMs }),
          (error) => parentPort.postMessage({ error: error.stack ?? String(error) }),
        ).finally(() => measurement.destroy());
      });
    },
    (error) => parentPort.postMessage({ error: error.stack ?? String(error) }),
  );
}
