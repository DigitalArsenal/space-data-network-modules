// Area/point-target coverage oracle (area-targets Phase 1).
//
// Proves the module's TARGET_RESULTS against an independent dense space-time
// lattice reference, plus the guardian-gate invariants:
//   * accept ⊆ truth / reject ⊆ ¬truth for ground POINT + POLYGON targets
//     (conic, exact reference footprint predicate).
//   * REGION GATE: a footprint hit inside a polygon's bounding rectangle but
//     OUTSIDE the polygon is NOT a target hit (a rect-only implementation fails).
//   * tangency / pass-splitting identical to the cell convention (ACCESS_COUNT =
//     number of passes, REVISIT_COUNT = passes-1, one PASS_START_BUCKET each).
//   * rectangular + SAR controls, using the module's own grid-cell coverage as
//     ground truth (the target machinery reuses the cell footprint machinery).
//   * DETERMINISM: TARGET_RESULTS byte-identical across SENSOR_COVERAGE_WORKERS
//     = 1, 2, 8, 32.
//   * targets_only parity: targets_only recompute == the TARGET_RESULTS of a
//     full grid+targets run.
//   * ANTIMERIDIAN polygon rejected fail-closed (present, zero coverage).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parentPort, Worker, workerData } from "node:worker_threads";

import {
  conicShape,
  decodeTargetResults,
  degreesToRadians,
  geodeticToEcef,
  interpolateState,
  invokeAndReadCoverage,
  pointTarget,
  polygonTarget,
  rectangularShape,
  sarAnnularSectorShape,
  scvMetricSeriesKind,
  stateSample,
  surfacePointVisible,
} from "./sensor_coverage_contract_helpers.mjs";

import { createCoveragePayload } from "./sensor_coverage_contract_helpers.mjs";
import {
  createStandaloneHarness,
  invokeBinaryRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const WGS84_B_M = 6356752.314245;
const ALTITUDE_M = 550000;
const CONIC = conicShape({ outerHalfAngleDeg: 12.5, maxRangeM: 1600000 });

const WASM_URL = process.env.SENSOR_COVERAGE_TEST_WASM
  ? pathToFileURL(path.resolve(process.env.SENSOR_COVERAGE_TEST_WASM))
  : new URL("../dist/isomorphic/module.wasm", import.meta.url);

const TYPE_REF = Object.freeze({
  schemaName: "SCV/main.fbs",
  fileIdentifier: "$SCV",
  rootTypeName: "SCV",
});

function sharedMemoryAvailable() {
  return (
    typeof SharedArrayBuffer === "function" &&
    typeof globalThis.WebAssembly?.Memory === "function"
  );
}

// Single-thread harness (SENSOR_COVERAGE_WORKERS=1) so no guest thread is spawned
// and the synchronous invoke never blocks the node main thread on pthread_join.
async function createHarness(workers = "1") {
  return createStandaloneHarness("browser", WASM_URL, {
    surface: "direct",
    sharedMemory: true,
    allowRawInvoke: false,
    initialMemoryBytes: 64 * 1024 * 1024,
    maximumMemoryBytes: 2 * 1024 * 1024 * 1024,
    env: { SENSOR_COVERAGE_WORKERS: String(workers) },
  });
}

async function invokeTargets(harness, payload) {
  const response = await invokeBinaryRequest(harness, payload, {
    methodId: "compute_sensor_coverage",
    inputPortId: "coverage",
    inputTypeRef: TYPE_REF,
    alignment: 8,
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  return response;
}

// ── reference region membership ─────────────────────────────────────────────
function pointInPolygon(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lonDeg;
    const yi = ring[i].latDeg;
    const xj = ring[j].lonDeg;
    const yj = ring[j].latDeg;
    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointTargetModel({ targetId, name, latDeg, lonDeg, radiusM }) {
  const centerEcef = geodeticToEcef(latDeg, lonDeg, 0);
  const angRad = ((radiusM / WGS84_B_M) * 180) / Math.PI;
  const latPad = angRad + 1e-4;
  const lonPad =
    angRad / Math.max(Math.cos(degreesToRadians(latDeg)), 1e-3) + 1e-4;
  return {
    scv: pointTarget({ targetId, name, latitudeDeg: latDeg, longitudeDeg: lonDeg, radiusM }),
    bounds: {
      minLat: latDeg - latPad,
      maxLat: latDeg + latPad,
      minLon: lonDeg - lonPad,
      maxLon: lonDeg + lonPad,
    },
    regionContains: (lat, lon) => {
      const p = geodeticToEcef(lat, lon, 0);
      const dx = p.x - centerEcef.x;
      const dy = p.y - centerEcef.y;
      const dz = p.z - centerEcef.z;
      return dx * dx + dy * dy + dz * dz <= radiusM * radiusM;
    },
  };
}

function polygonTargetModel({ targetId, name, ring }) {
  const lats = ring.map((r) => r.latDeg);
  const lons = ring.map((r) => r.lonDeg);
  return {
    scv: polygonTarget({ targetId, name, ring }),
    bounds: {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLon: Math.min(...lons),
      maxLon: Math.max(...lons),
    },
    regionContains: (lat, lon) => pointInPolygon(lon, lat, ring),
  };
}

// Dense lattice over the target bounding rectangle: does any region-interior
// lattice point lie inside the footprint at this resolved state? `toleranceRad`
// inflates (+) or shrinks (−) the exact footprint boundary.
function referenceVisibleAt(model, state, shape, toleranceRad, divisions = 160) {
  const { minLat, maxLat, minLon, maxLon } = model.bounds;
  for (let i = 0; i <= divisions; i += 1) {
    const lat = minLat + ((maxLat - minLat) * i) / divisions;
    for (let j = 0; j <= divisions; j += 1) {
      const lon = minLon + ((maxLon - minLon) * j) / divisions;
      if (!model.regionContains(lat, lon)) continue;
      if (surfacePointVisible(lat, lon, state, shape, toleranceRad)) {
        return true;
      }
    }
  }
  return false;
}

function stateAtTime(states, t) {
  let k = 0;
  while (k + 1 < states.length && states[k + 1].elapsedSeconds < t) k += 1;
  const a = states[Math.min(k, states.length - 2)];
  const b = states[Math.min(k + 1, states.length - 1)];
  return interpolateState(a, b, t);
}

function moduleVisibleAt(target, t) {
  for (let i = 0; i < target.intervalStart.length; i += 1) {
    if (t >= target.intervalStart[i] && t <= target.intervalStop[i]) {
      return true;
    }
  }
  return false;
}

// A ground track that sweeps its sub-satellite point across longitude at a fixed
// latitude, altitude 550 km, identity attitude (nadir-pointing footprint).
function sweepStates(lonSamples, latDeg = 0) {
  return lonSamples.map(([elapsedSeconds, lonDeg]) =>
    stateSample({ elapsedSeconds, latitudeDeg: latDeg, longitudeDeg: lonDeg, altitudeM: ALTITUDE_M }),
  );
}

function windowFor(states, step) {
  const stop = states[states.length - 1].elapsedSeconds;
  const count = Math.max(1, Math.round(stop / step));
  return { start: 0, stop, step, count };
}

function targetsOnlyPayload({ id, states, timeGrid, shape, targets }) {
  return createCoveragePayload({
    id,
    grid: {
      minLatitudeDeg: -5,
      maxLatitudeDeg: 5,
      minLongitudeDeg: -10,
      maxLongitudeDeg: 10,
      latitudeStepDeg: 5,
      longitudeStepDeg: 5,
    },
    timeGrid,
    states,
    shape,
    requestedProducts: [], // no raster products
    includePackedGeometry: false, // → targets_only mode
    targets,
  });
}

if (workerData?.role === "determinism") {
  // Child: run one worker count, hash the TARGET_RESULTS-bearing RESULT frame.
  const run = async () => {
    const states = sweepStates(
      Array.from({ length: 25 }, (_, i) => [i * 5, -6 + (i * 12) / 24]),
    );
    const timeGrid = windowFor(states, 10);
    // A dozen point targets scattered along/around the ground track.
    const targets = Array.from({ length: 12 }, (_, i) =>
      pointTargetModel({
        targetId: 100 + i,
        name: `t${i}`,
        latDeg: (i % 5) - 2,
        lonDeg: -6 + i,
        radiusM: 120000,
      }).scv,
    );
    const payload = targetsOnlyPayload({
      id: "determinism",
      states,
      timeGrid,
      shape: CONIC,
      targets,
    });
    const harness = await createStandaloneHarness("browser", WASM_URL, {
      surface: "direct",
      sharedMemory: true,
      allowRawInvoke: false,
      initialMemoryBytes: 64 * 1024 * 1024,
      maximumMemoryBytes: 2 * 1024 * 1024 * 1024,
      env: { SENSOR_COVERAGE_WORKERS: String(workerData.workers) },
    });
    try {
      const response = await invokeBinaryRequest(harness, payload, {
        methodId: "compute_sensor_coverage",
        inputPortId: "coverage",
        inputTypeRef: TYPE_REF,
        alignment: 8,
      });
      assert.equal(response.statusCode, 0, response.errorMessage);
      const frame = response.outputs.find(
        (f) => f.typeRef?.fileIdentifier === "$SCV",
      );
      assert.ok(frame, "missing $SCV frame");
      const hash = createHash("sha256")
        .update(Buffer.from(frame.payload))
        .digest("hex");
      parentPort.postMessage({
        hash,
        spawnCount: harness.threadHost ? harness.threadHost.spawnCount() : 0,
      });
    } finally {
      await harness.destroy?.();
    }
  };
  run().catch((error) =>
    parentPort.postMessage({ error: error.stack ?? String(error) }),
  );
} else {
  test("conic POINT: dense space-time oracle (accept ⊆ truth, reject ⊆ ¬truth)", async (t) => {
    if (!sharedMemoryAvailable()) return t.skip("SharedArrayBuffer unavailable.");
    const states = sweepStates(
      Array.from({ length: 25 }, (_, i) => [i * 5, -6 + (i * 12) / 24]),
    );
    const timeGrid = windowFor(states, 10);
    const model = pointTargetModel({
      targetId: 7,
      name: "point-oracle",
      latDeg: 0,
      lonDeg: 0,
      radiusM: 120000,
    });
    const harness = await createHarness();
    try {
      const response = await invokeTargets(
        harness,
        targetsOnlyPayload({ id: "conic-point-oracle", states, timeGrid, shape: CONIC, targets: [model.scv] }),
      );
      const [result] = decodeTargetResults(response);
      assert.equal(result.targetId, 7);
      assert.ok(result.accessCount >= 1, "target must be seen at least once");

      let acceptChecked = 0;
      let rejectChecked = 0;
      for (let tSec = 0; tSec <= timeGrid.stop; tSec += 1) {
        const state = stateAtTime(states, tSec);
        const moduleVis = moduleVisibleAt(result, tSec);
        // accept ⊆ truth: a reported-visible time must be visible for an
        // inflated (lenient) footprint — the module never fabricates access.
        if (moduleVis) {
          acceptChecked += 1;
          assert.ok(
            referenceVisibleAt(model, state, CONIC, 0.01),
            `module claims access at t=${tSec}s with no lenient-footprint witness`,
          );
        }
        // reject ⊆ ¬truth: a strictly-visible time (shrunk footprint) must be
        // reported — the module never drops a robust access.
        if (referenceVisibleAt(model, state, CONIC, -0.01)) {
          rejectChecked += 1;
          assert.ok(
            moduleVis,
            `module misses a strictly-visible access at t=${tSec}s`,
          );
        }
      }
      assert.ok(acceptChecked > 3, "expected several accept samples");
      assert.ok(rejectChecked > 3, "expected several reject samples");
    } finally {
      await harness.destroy?.();
    }
  });

  test("conic POLYGON: dense space-time oracle + region gate never over-accepts", async (t) => {
    if (!sharedMemoryAvailable()) return t.skip("SharedArrayBuffer unavailable.");
    // Big right triangle: region = { x≥0, y≥0, x+y ≤ 10 }. Bounding rect [0,10]².
    const ring = [
      { lonDeg: 0, latDeg: 0 },
      { lonDeg: 10, latDeg: 0 },
      { lonDeg: 0, latDeg: 10 },
    ];
    const model = polygonTargetModel({ targetId: 9, name: "triangle", ring });
    // Sub-satellite point sweeps THROUGH the rect's non-polygon corner (≈9,9)
    // and never enters the triangle → footprint overlaps the bounding rect but
    // not the region. A rect-only implementation would (wrongly) report access.
    const states = sweepStates(
      Array.from({ length: 21 }, (_, i) => [i * 5, 7 + (i * 4) / 20]),
      9,
    );
    const timeGrid = windowFor(states, 10);
    const harness = await createHarness();
    try {
      const response = await invokeTargets(
        harness,
        targetsOnlyPayload({ id: "poly-gate-miss", states, timeGrid, shape: CONIC, targets: [model.scv] }),
      );
      const [result] = decodeTargetResults(response);
      // Reference confirms: never a region∩footprint witness for these states.
      for (let tSec = 0; tSec <= timeGrid.stop; tSec += 2) {
        assert.equal(
          referenceVisibleAt(model, stateAtTime(states, tSec), CONIC, 0.02),
          false,
          `reference should find no polygon witness at t=${tSec}`,
        );
      }
      assert.equal(
        result.accessCount,
        0,
        "REGION GATE: footprint in the bounding rect but outside the polygon is NOT a hit",
      );
    } finally {
      await harness.destroy?.();
    }
  });

  test("conic POLYGON: hit when the footprint reaches inside the polygon", async (t) => {
    if (!sharedMemoryAvailable()) return t.skip("SharedArrayBuffer unavailable.");
    const ring = [
      { lonDeg: 0, latDeg: 0 },
      { lonDeg: 10, latDeg: 0 },
      { lonDeg: 0, latDeg: 10 },
    ];
    const model = polygonTargetModel({ targetId: 9, name: "triangle", ring });
    // Sub-sat sweeps through (≈2,2), which is well inside the triangle.
    const states = sweepStates(
      Array.from({ length: 21 }, (_, i) => [i * 5, 0.5 + (i * 3) / 20]),
      2,
    );
    const timeGrid = windowFor(states, 10);
    const harness = await createHarness();
    try {
      const response = await invokeTargets(
        harness,
        targetsOnlyPayload({ id: "poly-gate-hit", states, timeGrid, shape: CONIC, targets: [model.scv] }),
      );
      const [result] = decodeTargetResults(response);
      assert.ok(result.accessCount >= 1, "in-polygon footprint must be a hit");
      // accept ⊆ truth on the reported interval interior.
      for (let i = 0; i < result.intervalStart.length; i += 1) {
        const mid = 0.5 * (result.intervalStart[i] + result.intervalStop[i]);
        assert.ok(
          referenceVisibleAt(model, stateAtTime(states, mid), CONIC, 0.01),
          `reported interval midpoint ${mid}s has no polygon witness`,
        );
      }
    } finally {
      await harness.destroy?.();
    }
  });

  test("conic POINT: tangency / pass-splitting matches the cell convention", async (t) => {
    if (!sharedMemoryAvailable()) return t.skip("SharedArrayBuffer unavailable.");
    // Sub-sat: over target (pass 1), away, back over target (pass 2).
    const lonSamples = [];
    for (let i = 0; i <= 10; i += 1) lonSamples.push([i * 5, -3 + (i * 3) / 10]); // -3→0
    for (let i = 1; i <= 10; i += 1) lonSamples.push([50 + i * 5, (i * 6) / 10]); // 0→6
    for (let i = 1; i <= 10; i += 1) lonSamples.push([100 + i * 5, 6 - (i * 6) / 10]); // 6→0
    for (let i = 1; i <= 10; i += 1) lonSamples.push([150 + i * 5, -(i * 3) / 10]); // 0→-3
    const states = sweepStates(lonSamples);
    const timeGrid = windowFor(states, 10);
    const model = pointTargetModel({
      targetId: 3,
      name: "two-pass",
      latDeg: 0,
      lonDeg: 0,
      radiusM: 100000,
    });
    const harness = await createHarness();
    try {
      const response = await invokeTargets(
        harness,
        targetsOnlyPayload({ id: "two-pass", states, timeGrid, shape: CONIC, targets: [model.scv] }),
      );
      const [result] = decodeTargetResults(response);
      assert.equal(result.accessCount, 2, "two separated passes → ACCESS_COUNT 2");
      assert.equal(result.revisitCount, 1, "two passes → REVISIT_COUNT 1");
      assert.equal(result.passStartBuckets.length, 2, "one PASS_START_BUCKET per pass");
      assert.equal(result.intervalStart.length, 2);
      assert.ok(result.maxGapSec > 0, "there is a gap between the two passes");
    } finally {
      await harness.destroy?.();
    }
  });

  // Rectangular + SAR: use the module's own grid-cell coverage as ground truth.
  // A POINT target inside a well-covered cell must register access; a target in a
  // never-covered cell must not. This exercises the non-conic witness machinery.
  for (const [label, shape] of [
    ["rectangular", rectangularShape({ crossTrackHalfAngleDeg: 15, alongTrackHalfAngleDeg: 15, maxRangeM: 1600000 })],
    ["sar", sarAnnularSectorShape({ innerLookAngleDeg: 8, outerLookAngleDeg: 20, minClockAngleDeg: -180, maxClockAngleDeg: 180, maxRangeM: 2500000, samplingDensity: 64 })],
  ]) {
    test(`${label}: target access agrees with grid-cell coverage (cell-as-truth)`, async (t) => {
      if (!sharedMemoryAvailable()) return t.skip("SharedArrayBuffer unavailable.");
      const grid = {
        minLatitudeDeg: -6,
        maxLatitudeDeg: 6,
        minLongitudeDeg: -12,
        maxLongitudeDeg: 12,
        latitudeStepDeg: 2,
        longitudeStepDeg: 2,
      };
      const states = sweepStates(
        Array.from({ length: 25 }, (_, i) => [i * 5, -8 + (i * 16) / 24]),
      );
      const timeGrid = windowFor(states, 10);
      const columns = Math.round((grid.maxLongitudeDeg - grid.minLongitudeDeg) / grid.longitudeStepDeg);
      const rows = Math.round((grid.maxLatitudeDeg - grid.minLatitudeDeg) / grid.latitudeStepDeg);

      const harness = await createHarness();
      try {
        // Full grid coverage → find the most- and least-covered cells.
        const gridPayload = createCoveragePayload({
          id: `${label}-grid-truth`,
          grid,
          timeGrid,
          states,
          shape,
          requestedProducts: [scvMetricSeriesKind.ACCESS_COUNT],
          includePackedGeometry: false,
        });
        const cov = await invokeAndReadCoverage(harness, gridPayload);
        let best = { index: -1, passes: -1 };
        let coveredCells = 0;
        for (let idx = 0; idx < cov.passCount.length; idx += 1) {
          if (cov.passCount[idx] > 0) coveredCells += 1;
          if (cov.passCount[idx] > best.passes) best = { index: idx, passes: cov.passCount[idx] };
        }
        assert.ok(best.passes > 0, "grid must cover at least one cell");
        const cellCenter = (index) => {
          const row = Math.floor(index / columns);
          const column = index % columns;
          return {
            latDeg: grid.minLatitudeDeg + (row + 0.5) * grid.latitudeStepDeg,
            lonDeg: grid.minLongitudeDeg + (column + 0.5) * grid.longitudeStepDeg,
          };
        };
        // POSITIVE: point target at the best-covered cell center (radius ≈ 0.35
        // cell so the sphere stays well inside the cell).
        const hot = cellCenter(best.index);
        const radiusM = 0.35 * grid.latitudeStepDeg * 111000;
        const hotTarget = pointTarget({ targetId: 1, name: "hot", latitudeDeg: hot.latDeg, longitudeDeg: hot.lonDeg, radiusM });
        // NEGATIVE: a target far outside the swept band (well below the track).
        const coldTarget = pointTarget({ targetId: 2, name: "cold", latitudeDeg: -40, longitudeDeg: 60, radiusM });

        const response = await invokeTargets(
          harness,
          targetsOnlyPayload({ id: `${label}-targets`, states, timeGrid, shape, targets: [hotTarget, coldTarget] }),
        );
        const results = decodeTargetResults(response);
        const hotResult = results.find((r) => r.targetId === 1);
        const coldResult = results.find((r) => r.targetId === 2);
        assert.ok(hotResult.accessCount >= 1, `${label}: target in a covered cell must register access`);
        assert.equal(coldResult.accessCount, 0, `${label}: target far off-track must register no access`);
        assert.ok(coveredCells > 0);
      } finally {
        await harness.destroy?.();
      }
    });
  }

  test("targets_only recompute == TARGET_RESULTS of the full grid+targets run", async (t) => {
    if (!sharedMemoryAvailable()) return t.skip("SharedArrayBuffer unavailable.");
    const states = sweepStates(
      Array.from({ length: 25 }, (_, i) => [i * 5, -6 + (i * 12) / 24]),
    );
    const timeGrid = windowFor(states, 10);
    const targets = [
      pointTargetModel({ targetId: 11, name: "a", latDeg: 0, lonDeg: 0, radiusM: 120000 }).scv,
      pointTargetModel({ targetId: 12, name: "b", latDeg: 1, lonDeg: 2, radiusM: 120000 }).scv,
    ];
    const grid = {
      minLatitudeDeg: -4,
      maxLatitudeDeg: 4,
      minLongitudeDeg: -8,
      maxLongitudeDeg: 8,
      latitudeStepDeg: 4,
      longitudeStepDeg: 4,
    };
    // Fresh harness per invoke (matches every other test; avoids conflating the
    // contract with test-harness output-buffer reuse across invokes).
    const onlyHarness = await createHarness();
    let onlyResults;
    try {
      onlyResults = decodeTargetResults(
        await invokeTargets(
          onlyHarness,
          createCoveragePayload({ id: "parity-only", grid, timeGrid, states, shape: CONIC, requestedProducts: [], includePackedGeometry: false, targets }),
        ),
      );
    } finally {
      await onlyHarness.destroy?.();
    }
    const fullHarness = await createHarness();
    let fullResults;
    try {
      fullResults = decodeTargetResults(
        await invokeTargets(
          fullHarness,
          createCoveragePayload({ id: "parity-full", grid, timeGrid, states, shape: CONIC, requestedProducts: [scvMetricSeriesKind.ACCESS_COUNT], includePackedGeometry: false, targets }),
        ),
      );
    } finally {
      await fullHarness.destroy?.();
    }
    assert.deepEqual(
      onlyResults,
      fullResults,
      "targets_only TARGET_RESULTS must equal the combined run's TARGET_RESULTS",
    );
  });

  test("antimeridian-crossing polygon is rejected fail-closed (present, zero access)", async (t) => {
    if (!sharedMemoryAvailable()) return t.skip("SharedArrayBuffer unavailable.");
    // A polygon straddling the ±180° seam. Sub-sat parks right on it, so a
    // naive bounding-rect search WOULD report access — fail-closed forbids it.
    const ring = [
      { lonDeg: 175, latDeg: -2 },
      { lonDeg: -175, latDeg: -2 },
      { lonDeg: -175, latDeg: 2 },
      { lonDeg: 175, latDeg: 2 },
    ];
    const model = polygonTargetModel({ targetId: 21, name: "seam", ring });
    const states = sweepStates(
      Array.from({ length: 15 }, (_, i) => [i * 5, 179 + i * 0.1]),
      0,
    );
    const timeGrid = windowFor(states, 10);
    const harness = await createHarness();
    try {
      const response = await invokeTargets(
        harness,
        targetsOnlyPayload({ id: "antimeridian", states, timeGrid, shape: CONIC, targets: [model.scv] }),
      );
      const [result] = decodeTargetResults(response);
      assert.equal(result.targetId, 21, "rejected target still appears in index order");
      assert.equal(result.accessCount, 0, "antimeridian polygon must be fail-closed (zero access)");
      assert.equal(result.intervalStart.length, 0);
    } finally {
      await harness.destroy?.();
    }
  });

  test("TARGET_RESULTS byte-identical across SENSOR_COVERAGE_WORKERS = 1,2,8,32", {
    timeout: 120000,
  }, async (t) => {
    if (!sharedMemoryAvailable()) return t.skip("SharedArrayBuffer unavailable.");
    const runWorkers = (workers) =>
      new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), {
          workerData: { role: "determinism", workers },
        });
        worker.once("message", (m) =>
          worker.terminate().then(
            () => (m.error ? reject(new Error(m.error)) : resolve(m)),
            reject,
          ),
        );
        worker.once("error", reject);
      });
    const counts = [1, 2, 8, 32];
    const runs = [];
    for (const workers of counts) {
      runs.push({ workers, ...(await runWorkers(workers)) });
    }
    const base = runs[0];
    for (const r of runs) {
      t.diagnostic(`W=${r.workers}: hash=${r.hash.slice(0, 16)} spawned=${r.spawnCount}`);
      assert.equal(
        r.hash,
        base.hash,
        `TARGET_RESULTS at W=${r.workers} must be byte-identical to W=1`,
      );
    }
    // At least one multi-worker run must actually spawn a real guest thread.
    assert.ok(
      runs.some((r) => r.workers > 1 && r.spawnCount > 0),
      "multi-worker target fan-out must spawn real threads",
    );
  });
}
