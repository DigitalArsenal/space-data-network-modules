// Volume-target coverage oracle (area-targets Phase 2 — 3D volume targets).
//
// The SPACE-domain hit predicate is a FREE 3D point: ∃ p with
// region.containsWorldPoint(p) AND p inside the sensor footprint at t
// (sensor_local_look_inside + range). The module resolves this with a bounded,
// deterministic octree over the region's world-space AABB (exact leaf-witness
// accepts, conservative-reject prunes, fail-closed depth cap).
//
// This suite proves the module's TARGET_RESULTS against an INDEPENDENT dense
// space-time (4D) lattice reference for CARTESIAN_BOX, EXTRUDED_POLYGON (with an
// altitude band) and a SPACE BoundingSphere, across conic / rectangular / SAR:
//   * accept ⊆ truth  (module-visible ⟹ a lenient-footprint region witness), and
//     reject ⊆ ¬truth (a strict-footprint region witness ⟹ module-visible).
//   * ALTITUDE-BAND correctness: a band above the footprint's reach → 0 access;
//     a band intersecting the beam → hits.
//   * DETERMINISM: TARGET_RESULTS byte-identical across SENSOR_COVERAGE_WORKERS
//     = 1, 2, 8, 32 (same target-index partition as the surface path).
//   * TINY-VOLUME (≤1 m) not lost.
//   * BUDGET: volume-target compute stays under a pinned ceiling.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parentPort, Worker, workerData } from "node:worker_threads";

import {
  boxTarget,
  conicShape,
  createCoveragePayload,
  decodeTargetResults,
  ecefToGeodetic,
  extrudedPolygonTarget,
  geodeticToEcef,
  rectangularShape,
  sarAnnularSectorShape,
  scvMetricSeriesKind,
  spacePointVisible,
  sphereTarget,
  stateSample,
} from "./sensor_coverage_contract_helpers.mjs";

import {
  createStandaloneHarness,
  invokeBinaryRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const ALTITUDE_M = 550000;
const CONIC = conicShape({ outerHalfAngleDeg: 20, maxRangeM: 2000000 });

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

// ── models (independent reference geometry + dense region sample points) ───────
function boxModel({ targetId, name, centerLatDeg, centerLonDeg, centerAltM, halfM }) {
  const c = geodeticToEcef(centerLatDeg, centerLonDeg, centerAltM);
  const min = { x: c.x - halfM, y: c.y - halfM, z: c.z - halfM };
  const max = { x: c.x + halfM, y: c.y + halfM, z: c.z + halfM };
  const pts = [];
  const N = 6;
  for (let i = 0; i <= N; i += 1)
    for (let j = 0; j <= N; j += 1)
      for (let k = 0; k <= N; k += 1)
        pts.push({
          x: min.x + ((max.x - min.x) * i) / N,
          y: min.y + ((max.y - min.y) * j) / N,
          z: min.z + ((max.z - min.z) * k) / N,
        });
  return {
    scv: boxTarget({ targetId, name, minEcef: min, maxEcef: max }),
    samplePoints: pts,
  };
}

function sphereModel({ targetId, name, centerLatDeg, centerLonDeg, centerAltM, radiusM }) {
  const c = geodeticToEcef(centerLatDeg, centerLonDeg, centerAltM);
  const pts = [];
  const N = 8;
  for (let i = 0; i <= N; i += 1)
    for (let j = 0; j <= N; j += 1)
      for (let k = 0; k <= N; k += 1) {
        const p = {
          x: c.x - radiusM + (2 * radiusM * i) / N,
          y: c.y - radiusM + (2 * radiusM * j) / N,
          z: c.z - radiusM + (2 * radiusM * k) / N,
        };
        const dx = p.x - c.x;
        const dy = p.y - c.y;
        const dz = p.z - c.z;
        if (dx * dx + dy * dy + dz * dz <= radiusM * radiusM) pts.push(p);
      }
  return {
    scv: sphereTarget({ targetId, name, centerEcef: c, radiusM }),
    samplePoints: pts,
  };
}

function pointInPolygon(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lonDeg;
    const yi = ring[i].latDeg;
    const xj = ring[j].lonDeg;
    const yj = ring[j].latDeg;
    const intersect =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function extrudedModel({ targetId, name, ring, minAltitudeM, maxAltitudeM }) {
  const lats = ring.map((r) => r.latDeg);
  const lons = ring.map((r) => r.lonDeg);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const pts = [];
  // Dense enough that the worst inter-sample angular gap (in the sensor look
  // direction, incl. the altitude dimension at slant range) stays below the
  // oracle tolerance band — otherwise a real continuous witness the module finds
  // can fall between reference samples.
  const N = 16;
  const A = 12;
  for (let i = 0; i <= N; i += 1) {
    const lat = minLat + ((maxLat - minLat) * i) / N;
    for (let j = 0; j <= N; j += 1) {
      const lon = minLon + ((maxLon - minLon) * j) / N;
      if (!pointInPolygon(lon, lat, ring)) continue;
      for (let k = 0; k <= A; k += 1) {
        const alt = minAltitudeM + ((maxAltitudeM - minAltitudeM) * k) / A;
        pts.push(geodeticToEcef(lat, lon, alt));
      }
    }
  }
  return {
    scv: extrudedPolygonTarget({ targetId, name, ring, minAltitudeM, maxAltitudeM }),
    samplePoints: pts,
  };
}

function referenceVisibleAt(model, state, shape, toleranceRad) {
  for (const p of model.samplePoints) {
    if (spacePointVisible(p, state, shape, toleranceRad)) return true;
  }
  return false;
}

// A ground track whose sub-satellite point sweeps longitude at a fixed latitude,
// nadir-pointing (identity attitude).
function sweepStates(lonSamples, latDeg = 0, altitudeM = ALTITUDE_M) {
  return lonSamples.map(([elapsedSeconds, lonDeg]) =>
    stateSample({ elapsedSeconds, latitudeDeg: latDeg, longitudeDeg: lonDeg, altitudeM }),
  );
}

function windowFor(states, step) {
  const stop = states[states.length - 1].elapsedSeconds;
  const count = Math.max(1, Math.round(stop / step));
  return { start: 0, stop, step, count };
}

function stateAtTime(states, t) {
  let k = 0;
  while (k + 1 < states.length && states[k + 1].elapsedSeconds < t) k += 1;
  const a = states[Math.min(k, states.length - 2)];
  const b = states[Math.min(k + 1, states.length - 1)];
  // Reuse the helper interpolation via a tiny local lerp of the frame.
  return interpolate(a, b, t);
}

function interpolate(a, b, t) {
  const span = b.elapsedSeconds - a.elapsedSeconds;
  const f = span > 0 ? Math.min(1, Math.max(0, (t - a.elapsedSeconds) / span)) : 0;
  const lerp = (u, v) => u + (v - u) * f;
  return {
    sensorId: a.sensorId,
    elapsedSeconds: t,
    position: {
      x: lerp(a.position.x, b.position.x),
      y: lerp(a.position.y, b.position.y),
      z: lerp(a.position.z, b.position.z),
    },
    velocity: a.velocity,
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
  };
}

function moduleVisibleAt(target, t) {
  for (let i = 0; i < target.intervalStart.length; i += 1) {
    if (t >= target.intervalStart[i] && t <= target.intervalStop[i]) return true;
  }
  return false;
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
    requestedProducts: [],
    includePackedGeometry: false,
    targets,
  });
}

async function runOracle(t, { model, shape, states, timeGrid, id, leniencyRad = 0.02, strictRad = 0.03 }) {
  const harness = await createHarness();
  try {
    const response = await invokeTargets(
      harness,
      targetsOnlyPayload({ id, states, timeGrid, shape, targets: [model.scv] }),
    );
    const [result] = decodeTargetResults(response);
    let acceptChecked = 0;
    let rejectChecked = 0;
    for (let tSec = 0; tSec <= timeGrid.stop; tSec += 1) {
      const state = stateAtTime(states, tSec);
      const moduleVis = moduleVisibleAt(result, tSec);
      if (moduleVis) {
        acceptChecked += 1;
        assert.ok(
          referenceVisibleAt(model, state, shape, leniencyRad),
          `accept ⊄ truth: module claims access at t=${tSec}s with no lenient region witness`,
        );
      }
      if (referenceVisibleAt(model, state, shape, -strictRad)) {
        rejectChecked += 1;
        assert.ok(
          moduleVis,
          `reject ⊄ ¬truth: module misses a strictly-visible access at t=${tSec}s`,
        );
      }
    }
    return { result, acceptChecked, rejectChecked };
  } finally {
    await harness.destroy?.();
  }
}

if (workerData?.role === "volume-determinism") {
  const run = async () => {
    const states = sweepStates(
      Array.from({ length: 25 }, (_, i) => [i * 5, -6 + (i * 12) / 24]),
    );
    const timeGrid = windowFor(states, 10);
    const targets = [
      boxModel({ targetId: 200, name: "box-a", centerLatDeg: 0, centerLonDeg: 0, centerAltM: 60000, halfM: 60000 }).scv,
      boxModel({ targetId: 201, name: "box-b", centerLatDeg: 1, centerLonDeg: 2, centerAltM: 40000, halfM: 50000 }).scv,
      sphereModel({ targetId: 202, name: "sph", centerLatDeg: -1, centerLonDeg: -2, centerAltM: 80000, radiusM: 70000 }).scv,
      extrudedModel({ targetId: 203, name: "ext", ring: [
        { lonDeg: -1, latDeg: -1 }, { lonDeg: 1, latDeg: -1 }, { lonDeg: 1, latDeg: 1 }, { lonDeg: -1, latDeg: 1 },
      ], minAltitudeM: 0, maxAltitudeM: 120000 }).scv,
    ];
    const harness = await createStandaloneHarness("browser", WASM_URL, {
      surface: "direct",
      sharedMemory: true,
      allowRawInvoke: false,
      initialMemoryBytes: 64 * 1024 * 1024,
      maximumMemoryBytes: 2 * 1024 * 1024 * 1024,
      env: { SENSOR_COVERAGE_WORKERS: String(workerData.workers) },
    });
    try {
      const response = await invokeBinaryRequest(harness, targetsOnlyPayload({ id: "vol-determinism", states, timeGrid, shape: CONIC, targets }), {
        methodId: "compute_sensor_coverage",
        inputPortId: "coverage",
        inputTypeRef: TYPE_REF,
        alignment: 8,
      });
      assert.equal(response.statusCode, 0, response.errorMessage);
      const frame = response.outputs.find((f) => f.typeRef?.fileIdentifier === "$SCV");
      assert.ok(frame, "missing $SCV frame");
      const hash = createHash("sha256").update(Buffer.from(frame.payload)).digest("hex");
      parentPort.postMessage({ hash, spawnCount: harness.threadHost ? harness.threadHost.spawnCount() : 0 });
    } finally {
      await harness.destroy?.();
    }
  };
  run().catch((error) => parentPort.postMessage({ error: error.stack ?? String(error) }));
} else {
  test("conic BOX above ground: dense 4D lattice (accept ⊆ truth, reject ⊆ ¬truth)", async (t) => {
    if (!sharedMemoryAvailable()) return t.skip("SharedArrayBuffer unavailable.");
    const states = sweepStates(Array.from({ length: 25 }, (_, i) => [i * 5, -6 + (i * 12) / 24]));
    const timeGrid = windowFor(states, 10);
    const model = boxModel({ targetId: 30, name: "box", centerLatDeg: 0, centerLonDeg: 0, centerAltM: 60000, halfM: 70000 });
    const { result, acceptChecked, rejectChecked } = await runOracle(t, { model, shape: CONIC, states, timeGrid, id: "conic-box" });
    assert.ok(result.accessCount >= 1, "box must be seen at least once");
    assert.ok(acceptChecked > 3, "expected several accept samples");
    assert.ok(rejectChecked > 3, "expected several reject samples");
  });

  test("conic SPHERE (space): dense 4D lattice (accept ⊆ truth, reject ⊆ ¬truth)", async (t) => {
    if (!sharedMemoryAvailable()) return t.skip("SharedArrayBuffer unavailable.");
    const states = sweepStates(Array.from({ length: 25 }, (_, i) => [i * 5, -6 + (i * 12) / 24]));
    const timeGrid = windowFor(states, 10);
    const model = sphereModel({ targetId: 31, name: "sphere", centerLatDeg: 0, centerLonDeg: 0, centerAltM: 90000, radiusM: 90000 });
    const { result, acceptChecked, rejectChecked } = await runOracle(t, { model, shape: CONIC, states, timeGrid, id: "conic-sphere" });
    assert.ok(result.accessCount >= 1, "sphere must be seen at least once");
    assert.ok(acceptChecked > 3, "expected several accept samples");
    assert.ok(rejectChecked > 3, "expected several reject samples");
  });

  test("conic EXTRUDED_POLYGON in-beam band: dense 4D lattice", async (t) => {
    if (!sharedMemoryAvailable()) return t.skip("SharedArrayBuffer unavailable.");
    const states = sweepStates(Array.from({ length: 25 }, (_, i) => [i * 5, -6 + (i * 12) / 24]));
    const timeGrid = windowFor(states, 10);
    const model = extrudedModel({ targetId: 32, name: "prism", ring: [
      { lonDeg: -1.2, latDeg: -1.2 }, { lonDeg: 1.2, latDeg: -1.2 }, { lonDeg: 1.2, latDeg: 1.2 }, { lonDeg: -1.2, latDeg: 1.2 },
    ], minAltitudeM: 0, maxAltitudeM: 120000 });
    const { result, acceptChecked, rejectChecked } = await runOracle(t, { model, shape: CONIC, states, timeGrid, id: "conic-extruded", leniencyRad: 0.03, strictRad: 0.045 });
    assert.ok(result.accessCount >= 1, "in-beam prism must be seen");
    assert.ok(acceptChecked > 3, "expected several accept samples");
    assert.ok(rejectChecked > 3, "expected several reject samples");
  });

  test("altitude-band correctness: band above the footprint's reach → 0 access; in-beam band → hits", async (t) => {
    if (!sharedMemoryAvailable()) return t.skip("SharedArrayBuffer unavailable.");
    const states = sweepStates(Array.from({ length: 21 }, (_, i) => [i * 5, -4 + (i * 8) / 20]));
    const timeGrid = windowFor(states, 10);
    const ring = [
      { lonDeg: -1, latDeg: -1 }, { lonDeg: 1, latDeg: -1 }, { lonDeg: 1, latDeg: 1 }, { lonDeg: -1, latDeg: 1 },
    ];
    const inBeam = extrudedModel({ targetId: 40, name: "low", ring, minAltitudeM: 0, maxAltitudeM: 100000 });
    // A band ABOVE the sensor (nadir cone reaches DOWN): 1500–1600 km altitude is
    // behind the boresight → never in the footprint.
    const aboveReach = extrudedModel({ targetId: 41, name: "high", ring, minAltitudeM: 1500000, maxAltitudeM: 1600000 });
    const harness = await createHarness();
    try {
      const response = await invokeTargets(
        harness,
        targetsOnlyPayload({ id: "alt-band", states, timeGrid, shape: CONIC, targets: [inBeam.scv, aboveReach.scv] }),
      );
      const results = decodeTargetResults(response);
      assert.ok(results.find((r) => r.targetId === 40).accessCount >= 1, "in-beam altitude band must register access");
      // Reference confirms: the high band is never a witness.
      for (let tSec = 0; tSec <= timeGrid.stop; tSec += 2) {
        assert.equal(referenceVisibleAt(aboveReach, stateAtTime(states, tSec), CONIC, 0.05), false,
          `reference should find no high-band witness at t=${tSec}`);
      }
      assert.equal(results.find((r) => r.targetId === 41).accessCount, 0, "band above the footprint's reach → 0 access");
    } finally {
      await harness.destroy?.();
    }
  });

  for (const [label, shape] of [
    ["rectangular", rectangularShape({ crossTrackHalfAngleDeg: 22, alongTrackHalfAngleDeg: 22, maxRangeM: 2000000 })],
    ["sar", sarAnnularSectorShape({ innerLookAngleDeg: 5, outerLookAngleDeg: 28, minClockAngleDeg: -180, maxClockAngleDeg: 180, maxRangeM: 3000000, samplingDensity: 64 })],
  ]) {
    test(`${label} SPACE box: dense 4D lattice (accept ⊆ truth, reject ⊆ ¬truth)`, async (t) => {
      if (!sharedMemoryAvailable()) return t.skip("SharedArrayBuffer unavailable.");
      const states = sweepStates(Array.from({ length: 25 }, (_, i) => [i * 5, -6 + (i * 12) / 24]));
      const timeGrid = windowFor(states, 10);
      const model = boxModel({ targetId: 50, name: `${label}-box`, centerLatDeg: 0, centerLonDeg: 0, centerAltM: 50000, halfM: 60000 });
      const { result, acceptChecked, rejectChecked } = await runOracle(t, { model, shape, states, timeGrid, id: `${label}-box` });
      assert.ok(result.accessCount >= 1, `${label}: box must be seen`);
      assert.ok(acceptChecked > 2, "expected accept samples");
      assert.ok(rejectChecked > 2, "expected reject samples");
    });
  }

  // ── Adversarial temporal oracles (guardian correction A) ───────────────────
  // These target the two defects of a FIXED temporal subdivision (segment/8):
  //   (a) a transit shorter than one sub-interval is MISSED;
  //   (b) a brief dip-out inside a solid sub-interval is OVER-CLAIMED, merging two
  //       genuinely separate passes. RED on the fixed-K commit (3196ed7), GREEN on
  //       the adaptive swept-guided search.

  // (a) Brief transit shorter than segment/8, coarse cadence, MUST be caught. One
  // 30 s segment (states at t=0,30); the narrow (3°) footprint clips a small space
  // sphere for ~2.6 s around t≈9.5 s — between every fixed-K sample time.
  test("brief transit shorter than segment/8 is caught (adaptive temporal search)", async (t) => {
    if (!sharedMemoryAvailable()) return t.skip("SharedArrayBuffer unavailable.");
    const NARROW = conicShape({ outerHalfAngleDeg: 3, maxRangeM: 2000000 });
    const states = sweepStates([[0, 0], [30, 6]]); // rate 0.2°/s, one 30 s segment
    const timeGrid = { start: 0, stop: 30, step: 5, count: 6 };
    const model = sphereModel({ targetId: 70, name: "blip", centerLatDeg: 0, centerLonDeg: 1.9, centerAltM: 20000, radiusM: 6000 });
    // The transit is real at its centre and invisible at the fixed-K sample times
    // (segment/8 = 3.75 s ⇒ samples at 0,3.75,7.5,11.25,15,… ). A fixed subdivision
    // therefore never samples inside it.
    assert.equal(referenceVisibleAt(model, stateAtTime(states, 9.5), NARROW, 0), true, "transit must be real at its centre");
    assert.equal(referenceVisibleAt(model, stateAtTime(states, 7.5), NARROW, 0), false, "invisible at fixed-K endpoint 7.5 s");
    assert.equal(referenceVisibleAt(model, stateAtTime(states, 11.25), NARROW, 0), false, "invisible at fixed-K midpoint 11.25 s");
    const harness = await createHarness();
    try {
      const [result] = decodeTargetResults(
        await invokeTargets(harness, targetsOnlyPayload({ id: "brief-transit", states, timeGrid, shape: NARROW, targets: [model.scv] })),
      );
      assert.ok(result.accessCount >= 1, "adaptive search must catch the sub-segment/8 transit");
    } finally {
      await harness.destroy?.();
    }
  });

  // (b) Brief dip-out inside a solid sub-interval MUST split into two passes. A SAR
  // annular sector (inner 6°, outer 30°) sweeps over a small space sphere: visible
  // on the annulus, INVISIBLE crossing the inner hole (nadir), visible again. The
  // ~5 s dip sits inside the fixed-K sub-interval [7.5,15] whose endpoints are both
  // visible, so a fixed va&&vb solid push over-claims and merges the two passes.
  test("brief dip-out inside a solid sub-interval splits into two passes", async (t) => {
    if (!sharedMemoryAvailable()) return t.skip("SharedArrayBuffer unavailable.");
    const SAR = sarAnnularSectorShape({ innerLookAngleDeg: 6, outerLookAngleDeg: 30, minClockAngleDeg: -180, maxClockAngleDeg: 180, maxRangeM: 3000000, samplingDensity: 64 });
    const states = sweepStates([[0, 0], [30, 6]]); // rate 0.2°/s, one 30 s segment
    const timeGrid = { start: 0, stop: 30, step: 5, count: 6 };
    const model = sphereModel({ targetId: 71, name: "dip", centerLatDeg: 0, centerLonDeg: 2.25, centerAltM: 20000, radiusM: 6000 });
    // The dip is real mid-sub-interval (invisible over the hole at t≈11.25) while
    // BOTH fixed-K endpoints of [7.5,15] are visible — the exact merge trap.
    assert.equal(referenceVisibleAt(model, stateAtTime(states, 6), SAR, 0), true, "visible on the approaching annulus");
    assert.equal(referenceVisibleAt(model, stateAtTime(states, 11.25), SAR, 0), false, "invisible crossing the inner hole (dip)");
    assert.equal(referenceVisibleAt(model, stateAtTime(states, 18), SAR, 0), true, "visible on the departing annulus");
    assert.equal(referenceVisibleAt(model, stateAtTime(states, 7.5), SAR, 0), true, "fixed-K sub-interval [7.5,15] left endpoint visible");
    assert.equal(referenceVisibleAt(model, stateAtTime(states, 15), SAR, 0), true, "fixed-K sub-interval [7.5,15] right endpoint visible");
    const harness = await createHarness();
    try {
      const [result] = decodeTargetResults(
        await invokeTargets(harness, targetsOnlyPayload({ id: "brief-dip", states, timeGrid, shape: SAR, targets: [model.scv] })),
      );
      assert.equal(result.accessCount, 2, "the dip must split the pass into TWO accesses (no over-claim/merge)");
      assert.equal(result.passStartBuckets.length, 2, "two passes → two PASS_START_BUCKETS");
      assert.ok(result.revisitCount === 1, "two passes → REVISIT_COUNT 1");
    } finally {
      await harness.destroy?.();
    }
  });

  test("tiny-volume (≤1 m) SPACE box + sphere directly under-track register access", async (t) => {
    if (!sharedMemoryAvailable()) return t.skip("SharedArrayBuffer unavailable.");
    const states = sweepStates(Array.from({ length: 11 }, (_, i) => [i * 5, -0.5 + i * 0.1]));
    const timeGrid = windowFor(states, 10);
    const c = geodeticToEcef(0, 0, 20000);
    const box1m = boxTarget({ targetId: 1, name: "box1m", minEcef: { x: c.x - 0.5, y: c.y - 0.5, z: c.z - 0.5 }, maxEcef: { x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 } });
    const sph1m = sphereTarget({ targetId: 2, name: "sph1m", centerEcef: geodeticToEcef(0, 0, 30000), radiusM: 1 });
    const harness = await createHarness();
    try {
      const results = decodeTargetResults(
        await invokeTargets(harness, targetsOnlyPayload({ id: "tiny-vol", states, timeGrid, shape: CONIC, targets: [box1m, sph1m] })),
      );
      assert.ok(results.find((r) => r.targetId === 1).accessCount >= 1, "≤1 m box under-track must register access");
      assert.ok(results.find((r) => r.targetId === 2).accessCount >= 1, "≤1 m sphere under-track must register access");
    } finally {
      await harness.destroy?.();
    }
  });

  test("ecefToGeodetic round-trips geodeticToEcef (reference sanity)", () => {
    for (const [lat, lon, alt] of [[0, 0, 0], [12, 34, 50000], [-40, 170, 800000]]) {
      const g = ecefToGeodetic(geodeticToEcef(lat, lon, alt));
      assert.ok(Math.abs(g.latitudeDeg - lat) < 1e-6, "lat round-trip");
      assert.ok(Math.abs(((g.longitudeDeg - lon + 540) % 360) - 180) < 1e-6, "lon round-trip");
      assert.ok(Math.abs(g.altitudeM - alt) < 1e-3, "alt round-trip");
    }
  });

  test("volume-target compute budget ceiling", { timeout: 30000 }, async (t) => {
    if (!sharedMemoryAvailable()) return t.skip("SharedArrayBuffer unavailable.");
    const states = sweepStates(Array.from({ length: 49 }, (_, i) => [i * 5, -12 + (i * 24) / 48]));
    const timeGrid = windowFor(states, 5);
    const targets = [
      boxModel({ targetId: 60, name: "b", centerLatDeg: 0, centerLonDeg: 0, centerAltM: 60000, halfM: 80000 }).scv,
      sphereModel({ targetId: 61, name: "s", centerLatDeg: 1, centerLonDeg: 3, centerAltM: 90000, radiusM: 90000 }).scv,
      extrudedModel({ targetId: 62, name: "e", ring: [
        { lonDeg: 4, latDeg: -1 }, { lonDeg: 7, latDeg: -1 }, { lonDeg: 7, latDeg: 2 }, { lonDeg: 4, latDeg: 2 },
      ], minAltitudeM: 0, maxAltitudeM: 150000 }).scv,
    ];
    const harness = await createHarness("1");
    try {
      const payload = targetsOnlyPayload({ id: "vol-budget", states, timeGrid, shape: CONIC, targets });
      const start = performance.now();
      const response = await invokeTargets(harness, payload);
      const elapsedMs = performance.now() - start;
      t.diagnostic(`volume-target compute: ${elapsedMs.toFixed(0)} ms`);
      const results = decodeTargetResults(response);
      assert.ok(results.length === 3, "three volume targets");
      assert.ok(results.some((r) => r.accessCount >= 1), "at least one volume target seen");
      // Adaptive swept-guided temporal search (continuity-proven solid intervals
      // + depth-9 leaf) with three large volume targets: achieved single-thread
      // ~382 ms on the build host; ceiling = achieved+50% (≈580 ms). Present to
      // catch a gross volume-octree regression.
      const CEILING_MS = Number(process.env.SENSOR_COVERAGE_VOLUME_BUDGET_MS ?? 0) || 580;
      assert.ok(elapsedMs < CEILING_MS, `volume-target compute ${elapsedMs.toFixed(0)} ms exceeded the ${CEILING_MS} ms ceiling`);
    } finally {
      await harness.destroy?.();
    }
  });

  test("TARGET_RESULTS byte-identical across SENSOR_COVERAGE_WORKERS = 1,2,8,32 (volume targets)", { timeout: 120000 }, async (t) => {
    if (!sharedMemoryAvailable()) return t.skip("SharedArrayBuffer unavailable.");
    const runWorkers = (workers) =>
      new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { role: "volume-determinism", workers } });
        worker.once("message", (m) => worker.terminate().then(() => (m.error ? reject(new Error(m.error)) : resolve(m)), reject));
        worker.once("error", reject);
      });
    const runs = [];
    for (const workers of [1, 2, 8, 32]) runs.push({ workers, ...(await runWorkers(workers)) });
    const base = runs[0];
    for (const r of runs) {
      t.diagnostic(`W=${r.workers}: hash=${r.hash.slice(0, 16)} spawned=${r.spawnCount}`);
      assert.equal(r.hash, base.hash, `volume TARGET_RESULTS at W=${r.workers} must be byte-identical to W=1`);
    }
    assert.ok(runs.some((r) => r.workers > 1 && r.spawnCount > 0), "multi-worker volume fan-out must spawn real threads");
  });
}
