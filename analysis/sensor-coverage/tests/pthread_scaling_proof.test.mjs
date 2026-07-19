// Isomorphic-pthreads PROOF: real thread-spawn + linear-ish scaling + bit-parity.
//
// The C6 deliverable. Drives the SAME wasi-threads artifact at several worker
// counts (SENSOR_COVERAGE_WORKERS env) on the 12-hour fine-grid solid-conic case
// (the ~7 s single-thread hot path) and asserts:
//   1. BIT-PARITY: the packed raster products are byte-identical across ALL
//      worker counts (interleaved cell ownership is deterministic — threading
//      never changes results). This is the RMS-parity control for coverage.
//   2. REAL THREADS: at W workers the host spawns W-1 real OS threads
//      (pthread_create -> wasi.thread-spawn -> a distinct node worker each), so
//      distinctOsThreadCount == W-1. A stubbed/single-thread build could not.
//   3. SPEEDUP: wall time drops materially as workers increase (concurrency is
//      genuine, not just spawned-and-idle).
//
// Runs each measurement in a child worker_thread so its blocking pthread_join
// (Atomics.wait) never touches a main event loop, exactly like the browser
// coverage worker and the compute_time_budget harness.

import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { parentPort, Worker, workerData } from "node:worker_threads";

import {
  conicShape,
  createCoveragePayload,
  gridDimensions,
  stateSample,
} from "./sensor_coverage_contract_helpers.mjs";

const WINDOW_SECONDS = 12 * 60 * 60;
const STATE_STEP_SECONDS = 15;
const STATE_COUNT = WINDOW_SECONDS / STATE_STEP_SECONDS + 1; // 2881
const GRID_STEP_SECONDS = 60;
const GRID_INDEX_COUNT = WINDOW_SECONDS / GRID_STEP_SECONDS; // 720

const EARTH_RADIUS_M = 6378137;
const ORBIT_RADIUS_M = EARTH_RADIUS_M + 550000;
const EARTH_GM_M3_PER_S2 = 3.986004418e14;
const ORBIT_SPEED_MPS = Math.sqrt(EARTH_GM_M3_PER_S2 / ORBIT_RADIUS_M);
const ORBIT_RATE_RAD_PER_SEC = ORBIT_SPEED_MPS / ORBIT_RADIUS_M;
const EARTH_ROTATION_RATE_RAD_PER_SEC = 7.292115e-5;
const INCLINATION_RAD = (51.6 * Math.PI) / 180;
const SENSOR_ATTITUDE = Object.freeze({
  x: Math.sin((0.1 * Math.PI) / 180),
  y: 0,
  z: 0,
  w: Math.cos((0.1 * Math.PI) / 180),
});
const FINE_GRID = Object.freeze({
  minLatitudeDeg: -60,
  maxLatitudeDeg: 60,
  minLongitudeDeg: -180,
  maxLongitudeDeg: 180,
  latitudeStepDeg: 2,
  longitudeStepDeg: 2,
});
const CONIC = conicShape({ outerHalfAngleDeg: 12.5, maxRangeM: 1600000 });

const WORKER_COUNTS = [1, 2, 4, 8];
const MEASURE_TIMEOUT_MS = 45000; // W=1 single-thread ~7 s + harness setup headroom

function orbitState(elapsedSeconds) {
  const theta = ORBIT_RATE_RAD_PER_SEC * elapsedSeconds;
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);
  const cosInc = Math.cos(INCLINATION_RAD);
  const sinInc = Math.sin(INCLINATION_RAD);
  const p = {
    x: ORBIT_RADIUS_M * cosTheta,
    y: ORBIT_RADIUS_M * sinTheta * cosInc,
    z: ORBIT_RADIUS_M * sinTheta * sinInc,
  };
  const v = {
    x: -ORBIT_SPEED_MPS * sinTheta,
    y: ORBIT_SPEED_MPS * cosTheta * cosInc,
    z: ORBIT_SPEED_MPS * cosTheta * sinInc,
  };
  const earthAngle = EARTH_ROTATION_RATE_RAD_PER_SEC * elapsedSeconds;
  const ce = Math.cos(earthAngle);
  const se = Math.sin(earthAngle);
  const rot = ({ x, y, z }) => ({ x: ce * x + se * y, y: -se * x + ce * y, z });
  const relV = {
    x: v.x + EARTH_ROTATION_RATE_RAD_PER_SEC * p.y,
    y: v.y - EARTH_ROTATION_RATE_RAD_PER_SEC * p.x,
    z: v.z,
  };
  return stateSample({
    elapsedSeconds,
    position: rot(p),
    velocity: rot(relV),
    quaternion: SENSOR_ATTITUDE,
  });
}

function buildFineConicPayload() {
  const states = Array.from({ length: STATE_COUNT }, (_, i) =>
    orbitState(i * STATE_STEP_SECONDS),
  );
  return createCoveragePayload({
    id: "pthread-scaling-fine-conic",
    grid: FINE_GRID,
    timeGrid: {
      start: 0,
      stop: WINDOW_SECONDS,
      step: GRID_STEP_SECONDS,
      count: GRID_INDEX_COUNT,
    },
    states,
    shape: CONIC,
    includePackedGeometry: false,
  });
}

// ── child worker: measure ONE worker count, return raster hash + timing + stats
async function measureInWorker(workers) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { role: "measure", workers },
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new Error(`W=${workers} exceeded ${MEASURE_TIMEOUT_MS} ms`));
    }, MEASURE_TIMEOUT_MS);
    worker.once("message", (m) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().then(
        () => (m.error ? reject(new Error(m.error)) : resolve(m)),
        reject,
      );
    });
    worker.once("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}

if (workerData?.role !== "measure") {
  test("isomorphic-pthreads: bit-parity + real threads + speedup on fine conic", {
    timeout: WORKER_COUNTS.length * MEASURE_TIMEOUT_MS + 10000,
  }, async (t) => {
    if (typeof SharedArrayBuffer !== "function") {
      t.skip("SharedArrayBuffer unavailable.");
      return;
    }
    const { rows, columns } = gridDimensions(FINE_GRID);
    assert.equal(rows * columns, 10800);

    const results = [];
    for (const workers of WORKER_COUNTS) {
      const r = await measureInWorker(workers);
      t.diagnostic(
        `W=${workers}: ${r.elapsedMs.toFixed(1)} ms  ` +
          `rasterHash=${r.rasterHash}  spawned=${r.spawnCount}  ` +
          `osThreads=${r.distinctOsThreadCount}`,
      );
      results.push({ workers, ...r });
    }

    const base = results[0]; // W=1 = the single-thread control path
    // 1. BIT-PARITY across every worker count.
    for (const r of results) {
      assert.equal(
        r.rasterHash,
        base.rasterHash,
        `raster products at W=${r.workers} must be byte-identical to W=1 ` +
          `(threading is deterministic)`,
      );
    }
    // 2. REAL threads: W workers -> W-1 spawned OS threads.
    for (const r of results) {
      if (r.workers === 1) {
        assert.equal(r.spawnCount, 0, "W=1 spawns no threads (control path)");
      } else {
        assert.equal(
          r.distinctOsThreadCount,
          r.workers - 1,
          `W=${r.workers} must spawn ${r.workers - 1} distinct OS threads`,
        );
      }
    }
    // 3. SPEEDUP: more workers -> materially less wall time.
    const eight = results.find((r) => r.workers === 8);
    const speedup = base.elapsedMs / eight.elapsedMs;
    t.diagnostic(`8-worker speedup vs 1: ${speedup.toFixed(2)}x`);
    assert.ok(
      eight.elapsedMs < base.elapsedMs * 0.6,
      `8-worker time ${eight.elapsedMs.toFixed(1)} ms must be < 60% of ` +
        `1-worker ${base.elapsedMs.toFixed(1)} ms (got ${speedup.toFixed(2)}x)`,
    );
  });
} else {
  // Child: run ONE measurement with a fixed worker count.
  const run = async () => {
    const { createStandaloneHarness, invokeBinaryRequest } = await import(
      "../../../tests/lib/isomorphicHarness.mjs"
    );
    const { createHash } = await import("node:crypto");
    const wasmUrl = new URL("../dist/isomorphic/module.wasm", import.meta.url);
    const payload = buildFineConicPayload();
    const harness = await createStandaloneHarness("browser", wasmUrl, {
      surface: "direct",
      sharedMemory: true,
      allowRawInvoke: false,
      initialMemoryBytes: 128 * 1024 * 1024,
      maximumMemoryBytes: 2 * 1024 * 1024 * 1024,
      env: { SENSOR_COVERAGE_WORKERS: String(workerData.workers) },
    });
    try {
      // One timed invoke. The grid-cell cache build (create_cells, O(cells)) is
      // single-threaded and identical across worker counts, so it is a small,
      // fair, conservative constant in the speedup comparison.
      const t0 = performance.now();
      const response = await invokeBinaryRequest(harness, payload, {
        methodId: "compute_sensor_coverage",
        inputPortId: "coverage",
        inputTypeRef: {
          schemaName: "SCV/main.fbs",
          fileIdentifier: "$SCV",
          rootTypeName: "SCV",
        },
        alignment: 8,
      });
      const elapsedMs = performance.now() - t0;
      assert.equal(response.statusCode, 0, response.errorMessage);
      // Hash the SCV result frame bytes = the packed products payload. Identical
      // input + deterministic threading => identical bytes at any worker count.
      const frame = response.outputs.find(
        (f) => f.typeRef?.fileIdentifier === "$SCV",
      );
      assert.ok(frame, "missing $SCV output frame");
      const rasterHash = createHash("sha256")
        .update(Buffer.from(frame.payload))
        .digest("hex")
        .slice(0, 16);
      parentPort.postMessage({
        elapsedMs,
        rasterHash,
        spawnCount: harness.threadHost ? harness.threadHost.spawnCount() : 0,
        distinctOsThreadCount: harness.threadHost
          ? harness.threadHost.distinctOsThreadCount()
          : 0,
      });
    } finally {
      await harness.destroy?.();
    }
  };
  run().catch((error) =>
    parentPort.postMessage({ error: error.stack ?? String(error) }),
  );
}
