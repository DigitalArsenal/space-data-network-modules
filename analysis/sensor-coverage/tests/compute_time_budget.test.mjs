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
const COARSE_COMPUTE_BUDGET_MS = 5000;
const FINE_COMPUTE_BUDGET_MS = 10000;
const WORKER_RESULT_GRACE_MS = 1000;
const WORKER_SETUP_TIMEOUT_MS = 8000;
const configuredFineWatchdogMs = Number(
  process.env.SENSOR_COVERAGE_FINE_WATCHDOG_MS,
);
const FINE_WORKER_WATCHDOG_MS =
  Number.isFinite(configuredFineWatchdogMs) && configuredFineWatchdogMs > 0
    ? configuredFineWatchdogMs
    : FINE_COMPUTE_BUDGET_MS + WORKER_RESULT_GRACE_MS;

const EARTH_RADIUS_M = 6378137;
const ORBIT_RADIUS_M = EARTH_RADIUS_M + 550000;
const EARTH_GM_M3_PER_S2 = 3.986004418e14;
const ORBIT_SPEED_MPS = Math.sqrt(EARTH_GM_M3_PER_S2 / ORBIT_RADIUS_M);
const ORBIT_RATE_RAD_PER_SEC = ORBIT_SPEED_MPS / ORBIT_RADIUS_M;
const EARTH_ROTATION_RATE_RAD_PER_SEC = 7.292115e-5;
const INCLINATION_RAD = (51.6 * Math.PI) / 180;
const FINE_SENSOR_ATTITUDE = Object.freeze({
  x: Math.sin(0.1 * Math.PI / 180),
  y: 0,
  z: 0,
  w: Math.cos(0.1 * Math.PI / 180),
});

const COARSE_GRID = Object.freeze({
  minLatitudeDeg: -60,
  maxLatitudeDeg: 60,
  minLongitudeDeg: -180,
  maxLongitudeDeg: 180,
  latitudeStepDeg: 8,
  longitudeStepDeg: 8,
});

const FINE_GRID = Object.freeze({
  minLatitudeDeg: -60,
  maxLatitudeDeg: 60,
  minLongitudeDeg: -180,
  maxLongitudeDeg: 180,
  latitudeStepDeg: 2,
  longitudeStepDeg: 2,
});

const GRID_CASES = Object.freeze({
  coarse: COARSE_GRID,
  fine: FINE_GRID,
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

function orbitState(elapsedSeconds, earthFixedGroundTrack = false) {
  const theta = ORBIT_RATE_RAD_PER_SEC * elapsedSeconds;
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);
  const cosInclination = Math.cos(INCLINATION_RAD);
  const sinInclination = Math.sin(INCLINATION_RAD);
  const inertialPosition = {
    x: ORBIT_RADIUS_M * cosTheta,
    y: ORBIT_RADIUS_M * sinTheta * cosInclination,
    z: ORBIT_RADIUS_M * sinTheta * sinInclination,
  };
  const inertialVelocity = {
    x: -ORBIT_SPEED_MPS * sinTheta,
    y: ORBIT_SPEED_MPS * cosTheta * cosInclination,
    z: ORBIT_SPEED_MPS * cosTheta * sinInclination,
  };
  if (!earthFixedGroundTrack) {
    return stateSample({
      elapsedSeconds,
      position: inertialPosition,
      velocity: inertialVelocity,
    });
  }
  const earthAngle = EARTH_ROTATION_RATE_RAD_PER_SEC * elapsedSeconds;
  const cosEarth = Math.cos(earthAngle);
  const sinEarth = Math.sin(earthAngle);
  const rotateToEarthFixed = ({ x, y, z }) => ({
    x: cosEarth * x + sinEarth * y,
    y: -sinEarth * x + cosEarth * y,
    z,
  });
  const relativeInertialVelocity = {
    x: inertialVelocity.x +
      EARTH_ROTATION_RATE_RAD_PER_SEC * inertialPosition.y,
    y: inertialVelocity.y -
      EARTH_ROTATION_RATE_RAD_PER_SEC * inertialPosition.x,
    z: inertialVelocity.z,
  };
  return stateSample({
    elapsedSeconds,
    position: rotateToEarthFixed(inertialPosition),
    velocity: rotateToEarthFixed(relativeInertialVelocity),
    quaternion: FINE_SENSOR_ATTITUDE,
  });
}

function createBudgetPayload(shapeName, gridName) {
  const states = Array.from(
    { length: STATE_COUNT },
    (_, index) => orbitState(
      index * STATE_STEP_SECONDS,
      gridName === "fine",
    ),
  );
  return createCoveragePayload({
    id: `compute-time-budget-${gridName}-${shapeName}`,
    grid: GRID_CASES[gridName],
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

async function prepareShapeMeasurement(shapeName, gridName) {
  const t = {
    skip(message) {
      throw new Error(message);
    },
  };
  const harness = await createContractHarness(t);
  const payload = createBudgetPayload(shapeName, gridName);
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

function measureShapeInWorker(shapeName, gridName, workerWatchdogMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let computeTimeout = null;
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { role: "compute-budget", shapeName, gridName },
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
              `${workerWatchdogMs} ms worker watchdog`,
          )));
        }, workerWatchdogMs);
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
  const coarseDimensions = gridDimensions(COARSE_GRID);
  const fineDimensions = gridDimensions(FINE_GRID);
  assert.equal(coarseDimensions.rows * coarseDimensions.columns, 675);
  assert.equal(fineDimensions.rows * fineDimensions.columns, 10800);
  assert.equal(STATE_COUNT, 2881);
  assert.equal(GRID_INDEX_COUNT, 720);

  test("conic, rectangular, and SAR meet the 12-hour coarse-grid compute budget", {
    timeout: Object.keys(SHAPES).length *
      (WORKER_SETUP_TIMEOUT_MS + COARSE_COMPUTE_BUDGET_MS +
        WORKER_RESULT_GRACE_MS + 1000),
  }, async (t) => {
    for (const shapeName of Object.keys(SHAPES)) {
      await t.test(`${shapeName} completes under five seconds`, async (t) => {
        const elapsedMs = await measureShapeInWorker(
          shapeName,
          "coarse",
          COARSE_COMPUTE_BUDGET_MS + WORKER_RESULT_GRACE_MS,
        );
        t.diagnostic(`${shapeName} compute time: ${elapsedMs.toFixed(3)} ms`);
        assert.ok(
          elapsedMs < COARSE_COMPUTE_BUDGET_MS,
          `${shapeName} compute time ${elapsedMs.toFixed(3)} ms exceeded ` +
            `${COARSE_COMPUTE_BUDGET_MS} ms`,
        );
      });
    }
  });

  test("conic meets the 12-hour fine-grid compute budget", {
    timeout: WORKER_SETUP_TIMEOUT_MS + FINE_WORKER_WATCHDOG_MS + 1000,
  }, async (t) => {
    const elapsedMs = await measureShapeInWorker(
      "conic",
      "fine",
      FINE_WORKER_WATCHDOG_MS,
    );
    t.diagnostic(`fine conic compute time: ${elapsedMs.toFixed(3)} ms`);
    assert.ok(
      elapsedMs < FINE_COMPUTE_BUDGET_MS,
      `fine conic compute time ${elapsedMs.toFixed(3)} ms exceeded ` +
        `${FINE_COMPUTE_BUDGET_MS} ms`,
    );
  });
} else {
  prepareShapeMeasurement(workerData.shapeName, workerData.gridName).then(
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
