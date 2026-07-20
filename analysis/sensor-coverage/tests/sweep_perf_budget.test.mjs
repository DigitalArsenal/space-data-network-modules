import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { parentPort, Worker, workerData } from "node:worker_threads";

import {
  createContractHarness,
  createCoveragePayload,
  gridDimensions,
  invokeCoveragePayload,
  quaternionFromAxisAngle,
  sarAnnularSectorShape,
  stateSample,
} from "./sensor_coverage_contract_helpers.mjs";

// RED perf regression for the owner-reported scanning-SAR lockup.
//
// Sensor: side-looking SAR, off-nadir 30 deg, swath half 4 deg (26..34 deg look
// angle), along half 2 deg (+/-2 deg clock), max range 2500 km, cross-track
// sweep amplitude 50 deg / period 120 s. Grid: the live coarse 8 deg regional
// band, 12-hour window, 15 s attitude samples, 60 s output buckets.
//
// The owner reported this configuration as a lockup ("stuck 5+ minutes"). Two
// things caused it: the demo's watchdog re-ran an UNBOUNDED sequential retry
// (fixed in OrbPro branch sweep-watchdog), and the module compute is genuinely
// heavy here — up to 80 deg off-nadir with a 2500 km range makes the per-instant
// footprint enormous, so the exact per-cell temporal search takes ~155 s. This
// test pins that the MODULE COMPLETES in bounded time (it never hangs) inside
// the threaded worker harness within a hard budget. Note: the sweep-phase
// subdivision is bit-identical to the un-subdivided search and does NOT speed up
// this footprint-bound config; it restores prune power for sweep-bound (small-
// footprint) configs while preserving pass-start semantics exactly. A regression
// that degenerated the search well past baseline blows the budget.
const WINDOW_SECONDS = 12 * 60 * 60;
const STATE_STEP_SECONDS = 15;
const STATE_COUNT = WINDOW_SECONDS / STATE_STEP_SECONDS + 1; // 2881
const GRID_STEP_SECONDS = 60;
const GRID_INDEX_COUNT = WINDOW_SECONDS / GRID_STEP_SECONDS; // 720

const OFF_NADIR_DEG = 30;
const SWEEP_AMPLITUDE_DEG = 50;
const SWEEP_PERIOD_SECONDS = 120;
const SWEEP_SIDE = 1; // right-looking

// This is a COMPLETION / non-runaway guard, not a speedup claim. The
// sweep-phase subdivision is bit-identical to the un-subdivided search
// (verified against origin/main), and this config is footprint-bound — at up to
// 80 deg off-nadir with a 2500 km range the per-instant footprint is enormous,
// so tight per-sub-window caps prune little and the compute stays ~baseline
// (measured ~155 s in the threaded worker harness; threading gives ~no speedup
// as a few hot cells dominate). The point the owner reported was that the
// compute HUNG; the module in fact COMPLETES in bounded time, and the demo's
// bounded watchdog (OrbPro branch sweep-watchdog) caps the wait. This budget is
// the achieved time plus ~50 % headroom; a regression that degenerated the
// search (e.g. a lost subdivision blowing past 2x baseline) trips it.
const SWEEP_COARSE_COMPUTE_BUDGET_MS = 240000;
const WORKER_SETUP_TIMEOUT_MS = 8000;
const WORKER_RESULT_GRACE_MS = 2000;

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

const SWEEP_SHAPE = sarAnnularSectorShape({
  innerLookAngleDeg: OFF_NADIR_DEG - 4, // 26
  outerLookAngleDeg: OFF_NADIR_DEG + 4, // 34
  minClockAngleDeg: -2,
  maxClockAngleDeg: 2,
  maxRangeM: 2500000,
  samplingDensity: 256,
});

// Cross-track roll about the along-track (local x) axis — the module base frame
// is already nadir, matching OrbPro's sensorSweepRollRadians.
function sweepQuaternion(elapsedSeconds) {
  const rollDeg =
    SWEEP_SIDE * OFF_NADIR_DEG +
    SWEEP_AMPLITUDE_DEG *
      Math.sin((2 * Math.PI * elapsedSeconds) / SWEEP_PERIOD_SECONDS);
  return quaternionFromAxisAngle({ x: 1, y: 0, z: 0 }, rollDeg);
}

function sweepOrbitState(elapsedSeconds) {
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
    quaternion: sweepQuaternion(elapsedSeconds),
  });
}

function createSweepPayload() {
  const states = Array.from({ length: STATE_COUNT }, (_, index) =>
    sweepOrbitState(index * STATE_STEP_SECONDS),
  );
  return createCoveragePayload({
    id: "sweep-perf-owner-config-coarse",
    grid: COARSE_GRID,
    timeGrid: {
      start: 0,
      stop: WINDOW_SECONDS,
      step: GRID_STEP_SECONDS,
      count: GRID_INDEX_COUNT,
    },
    states,
    shape: SWEEP_SHAPE,
    includePackedGeometry: false,
  });
}

async function prepareSweepMeasurement() {
  const t = {
    skip(message) {
      throw new Error(message);
    },
  };
  const harness = await createContractHarness(t);
  const payload = createSweepPayload();
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

function measureSweepInWorker(workerWatchdogMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let computeTimeout = null;
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { role: "sweep-perf-budget" },
      execArgv: [],
    });
    const settleAfterTermination = (callback) => {
      void worker.terminate().then(callback, reject);
    };
    const setupTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      settleAfterTermination(() =>
        reject(
          new Error(`sweep worker setup exceeded ${WORKER_SETUP_TIMEOUT_MS} ms`),
        ),
      );
    }, WORKER_SETUP_TIMEOUT_MS);
    worker.once("message", (message) => {
      if (message.ready) {
        clearTimeout(setupTimeout);
        computeTimeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          settleAfterTermination(() =>
            reject(
              new Error(
                `sweep compute did not report completion within the ` +
                  `${workerWatchdogMs} ms worker watchdog`,
              ),
            ),
          );
        }, workerWatchdogMs);
        worker.postMessage({ invoke: true });
        worker.once("message", (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(computeTimeout);
          settleAfterTermination(() =>
            result.error
              ? reject(new Error(result.error))
              : resolve(result.elapsedMs),
          );
        });
      } else if (!settled) {
        settled = true;
        clearTimeout(setupTimeout);
        settleAfterTermination(() =>
          reject(new Error(message.error ?? "sweep worker did not become ready")),
        );
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
        reject(
          new Error(`sweep worker exited before reporting a result (code ${code})`),
        );
      }
    });
  });
}

if (workerData?.role !== "sweep-perf-budget") {
  const { rows, columns } = gridDimensions(COARSE_GRID);
  assert.equal(rows * columns, 675);
  assert.equal(STATE_COUNT, 2881);
  assert.equal(GRID_INDEX_COUNT, 720);

  test(
    "scanning SAR sweep amp-50 owner config completes within the coarse compute budget",
    {
      timeout:
        WORKER_SETUP_TIMEOUT_MS +
        SWEEP_COARSE_COMPUTE_BUDGET_MS +
        WORKER_RESULT_GRACE_MS +
        2000,
    },
    async (t) => {
      const elapsedMs = await measureSweepInWorker(
        SWEEP_COARSE_COMPUTE_BUDGET_MS + WORKER_RESULT_GRACE_MS,
      );
      t.diagnostic(`sweep amp-50 coarse compute time: ${elapsedMs.toFixed(3)} ms`);
      assert.ok(
        elapsedMs < SWEEP_COARSE_COMPUTE_BUDGET_MS,
        `sweep amp-50 coarse compute time ${elapsedMs.toFixed(3)} ms exceeded ` +
          `${SWEEP_COARSE_COMPUTE_BUDGET_MS} ms`,
      );
    },
  );
} else {
  prepareSweepMeasurement().then(
    (measurement) => {
      parentPort.postMessage({ ready: true });
      parentPort.once("message", () => {
        measurement
          .invoke()
          .then(
            (elapsedMs) => parentPort.postMessage({ elapsedMs }),
            (error) =>
              parentPort.postMessage({ error: error.stack ?? String(error) }),
          )
          .finally(() => measurement.destroy());
      });
    },
    (error) => parentPort.postMessage({ error: error.stack ?? String(error) }),
  );
}
