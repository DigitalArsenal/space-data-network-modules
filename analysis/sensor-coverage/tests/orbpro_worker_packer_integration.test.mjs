// Cross-lane integration regression (area-targets Phase 1).
//
// THE test the two lanes never had. The module's own target_hits.test.mjs packs
// TARGETS with the SDS-lib bindings via local test helpers; the browser packs
// them with the OrbPro demo-lane packer (packages/sandcastle/gallery/_shared/
// coverageTargets.js → scvTargetsFromModels → coverageTargetToScvTargetT) inside
// the coverage worker. Neither lane ever fed a REAL-worker-packed request to the
// REAL wasm. This test closes that gap end to end:
//
//   pack via the REAL OrbPro worker packer  ->  invoke the REAL module.wasm
//   ->  assert TARGET_RESULTS length == targets length (one entry per target).
//
// It fails loudly against any module whose SCV schema lacks TARGET/TARGET_RESULTS
// support (e.g. a stale, pre-Phase-1 published-module runtime — the exact cause
// of the live `targetResults: []`), and passes against the Phase-1 wasm.
//
// Home: the modules suite owns the wasm + node harness; it reaches UP into the
// OrbPro superproject's demo-lane packer it must stay byte-compatible with. When
// the modules repo is checked out standalone (no superproject), every case skips.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createStandaloneHarness,
  invokeBinaryRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

// ── locate the OrbPro superproject that embeds this submodule ─────────────────
// tests/ -> sensor-coverage -> analysis -> space-data-network-modules -> packages -> OrbPro
const ORBPRO_ROOT = new URL("../../../../../", import.meta.url);
const ORBPRO_ROOT_NO_SLASH = ORBPRO_ROOT.href.replace(/\/$/, "");
const PACKER_URL = new URL(
  "packages/sandcastle/gallery/_shared/coverageTargets.js",
  ORBPRO_ROOT,
);
const SUPERPROJECT_PRESENT = existsSync(fileURLToPath(PACKER_URL));

// Map the demo lane's browser-absolute specifiers (/packages/space-data-module-
// sdk/... for the vendor flatbuffers, /packages/... for the SCV bindings) onto
// the OrbPro on-disk tree so the REAL packer + worker-scv bindings import in node.
if (SUPERPROJECT_PRESENT) {
  const loaderSrc = `
    export async function resolve(spec, ctx, next) {
      if (spec.startsWith("/packages/")) {
        return { url: ${JSON.stringify(ORBPRO_ROOT_NO_SLASH)} + spec, shortCircuit: true };
      }
      return next(spec, ctx);
    }`;
  register(`data:text/javascript,${encodeURIComponent(loaderSrc)}`);
}

const WASM_URL = process.env.SENSOR_COVERAGE_TEST_WASM
  ? pathToFileURL(process.env.SENSOR_COVERAGE_TEST_WASM)
  : new URL("../dist/isomorphic/module.wasm", import.meta.url);

const TYPE_REF = Object.freeze({
  schemaName: "SCV/main.fbs",
  fileIdentifier: "$SCV",
  rootTypeName: "SCV",
});
const ALTITUDE_M = 550000;
const SENSOR_ID = 7;

function sharedMemoryAvailable() {
  return (
    typeof SharedArrayBuffer === "function" &&
    typeof globalThis.WebAssembly?.Memory === "function"
  );
}

// WGS84 geodetic (lat/lon/alt) -> ECEF metres, matching the module's convention.
const WGS84_A = 6378137.0;
const WGS84_B = 6356752.314245;
const WGS84_E2 = 1.0 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
function geodeticToEcef(latDeg, lonDeg, altM = 0) {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const s = Math.sin(lat);
  const c = Math.cos(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s);
  return {
    x: (n + altM) * c * Math.cos(lon),
    y: (n + altM) * c * Math.sin(lon),
    z: (n * (1 - WGS84_E2) + altM) * s,
  };
}
function tangentVelocity(p) {
  const cx = -p.y;
  const cy = p.x;
  const cz = 0;
  const m = Math.hypot(cx, cy, cz) || 1;
  return { x: (cx / m) * 7500, y: (cy / m) * 7500, z: (cz / m) * 7500 };
}

// Build the FULL SCV coverage request exactly the way the OrbPro coverage worker
// does (createScvCoverageRequestPayload): worker-scv bindings + OrbPro vendor
// flatbuffers, targets packed by the REAL demo-lane packer.
async function buildWorkerPackedRequest(demoModels) {
  const W = await import(PACKER_URL.href.replace("coverageTargets.js", "worker-scv/main.js"));
  const packer = await import(PACKER_URL.href);
  const flatbuffers = await import(
    "/packages/space-data-module-sdk/src/vendor/flatbuffers/flatbuffers.js"
  );

  // Nadir conic sweeping the sub-satellite point across longitude at the equator,
  // so a target at (0,0) sits directly under the track (guaranteed access).
  const states = Array.from({ length: 25 }, (_, i) => {
    const lonDeg = -6 + (i * 12) / 24;
    const position = geodeticToEcef(0, lonDeg, ALTITUDE_M);
    const velocity = tangentVelocity(position);
    return new W.SCVStateSampleT(
      SENSOR_ID,
      i * 5,
      new W.SCVVec3T(position.x, position.y, position.z),
      new W.SCVVec3T(velocity.x, velocity.y, velocity.z),
      0,
      0,
      0,
      1,
      W.scvCoordinateFrame.BODY_FIXED,
    );
  });
  const shapeContract = new W.SCVSensorShapeContractT(
    W.scvSensorShapeKind.CONIC,
    0,
    W.scvSensorRangeBoundaryKind.RADIAL_SPHERICAL,
    12.5, 0, 0, 360, 0, 0, 0, 0, 0, 0, 1600000, [],
    W.scvCoordinateFrame.BODY_FIXED,
  );
  const grid = {
    minLatitudeDeg: -5, maxLatitudeDeg: 5,
    minLongitudeDeg: -10, maxLongitudeDeg: 10,
    latitudeStepDeg: 5, longitudeStepDeg: 5,
  };
  const req = new W.SCVCoverageRequestT(
    "orbpro-sensor-coverage",
    BigInt(0),
    W.scvAnalysisMode.COVERAGE,
    new W.SCVEllipsoidT(W.scvBodyKind.EARTH, "Earth", WGS84_A, WGS84_B, WGS84_A, W.scvCoordinateFrame.BODY_FIXED),
    new W.SCVTimeGridT(null, 0, 0, 120, 10, 0, 12),
    new W.SCVCoverageGridT(
      "orbpro-coverage-grid",
      W.scvGeometryDomain.SURFACE,
      W.scvCoordinateFrame.BODY_FIXED,
      grid.minLatitudeDeg, grid.maxLatitudeDeg, grid.minLongitudeDeg, grid.maxLongitudeDeg,
      grid.latitudeStepDeg, grid.longitudeStepDeg, 0, 8,
      Math.min(grid.latitudeStepDeg, grid.longitudeStepDeg),
    ),
    [new W.SCVSensorT(SENSOR_ID, "sensor-7", "orbpro-sensor-coverage", W.scvCoordinateFrame.BODY_FIXED, null, null, null, null, shapeContract)],
    states,
    // ── THE surface under test: TARGETS packed by the REAL OrbPro worker packer.
    packer.scvTargetsFromModels(demoModels),
    [],
    [W.scvMetricSeriesKind.ACCESS_COUNT],
    0, 0, 0, 0, undefined, false,
  );
  const envelope = new W.SCVT(W.scvEnvelopeKind.REQUEST, req, null, null, null, null);
  const builder = new flatbuffers.Builder(1024);
  W.SCV.finishSCVBuffer(builder, envelope.pack(builder));
  return { payload: builder.asUint8Array(), bindings: W, flatbuffers };
}

function decodeTargetResults(request, response) {
  const W = request.bindings;
  const fb = request.flatbuffers;
  // The module can emit multiple $SCV frames (PROGRESS + the canonical RESULT);
  // pick the RESULT envelope, exactly as the demo worker's decode path does.
  const root = response.outputs
    .filter((f) => f.typeRef?.fileIdentifier === "$SCV")
    .map((f) => W.SCV.getRootAsSCV(new fb.ByteBuffer(f.payload)))
    .find((env) => env.ENVELOPE_KIND() === W.scvEnvelopeKind.RESULT);
  assert.ok(root, "module emitted no $SCV RESULT frame");
  const result = root.RESULT();
  assert.ok(result, "RESULT payload missing");
  const out = [];
  for (let i = 0; i < result.targetResultsLength(); i += 1) {
    const t = result.TARGET_RESULTS(i);
    out.push({ targetId: t.TARGET_ID() >>> 0, accessCount: t.ACCESS_COUNT() >>> 0 });
  }
  return out;
}

async function invoke(harness, payload) {
  const response = await invokeBinaryRequest(harness, payload, {
    methodId: "compute_sensor_coverage",
    inputPortId: "coverage",
    inputTypeRef: TYPE_REF,
    alignment: 8,
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  return response;
}

async function makeHarness() {
  return createStandaloneHarness("browser", WASM_URL, {
    surface: "direct",
    sharedMemory: true,
    allowRawInvoke: false,
    initialMemoryBytes: 64 * 1024 * 1024,
    maximumMemoryBytes: 2 * 1024 * 1024 * 1024,
    env: { SENSOR_COVERAGE_WORKERS: "1" },
  });
}

test("OrbPro worker-packed POINT + POLYGON round-trip: one TARGET_RESULT per target, with access", async (t) => {
  if (!SUPERPROJECT_PRESENT) {
    return t.skip("OrbPro superproject packer not present (standalone modules checkout).");
  }
  if (!sharedMemoryAvailable()) return t.skip("SharedArrayBuffer unavailable.");

  // The plain demo target models (what serializableCoverageTargets emits on the
  // page): a point under the track, and a small polygon straddling the equator.
  const demoModels = [
    { id: 101, name: "Point 101", kind: "point", positionsLonLatDeg: [[0, 0]], radiusM: 120000 },
    {
      id: 202,
      name: "Area 202",
      kind: "polygon",
      positionsLonLatDeg: [[-1, -1], [1, -1], [1, 1], [-1, 1]],
    },
  ];
  const request = await buildWorkerPackedRequest(demoModels);
  const harness = await makeHarness();
  try {
    const response = await invoke(harness, request.payload);
    const results = decodeTargetResults(request, response);

    // The core regression assertion: the module echoes exactly one TARGET_RESULT
    // per packed target. Empty here == the live `targetResults: []` bug.
    assert.equal(
      results.length,
      demoModels.length,
      "module must return one TARGET_RESULT per OrbPro-packed target (empty == the stale-wasm live bug)",
    );
    const point = results.find((r) => r.targetId === 101);
    const polygon = results.find((r) => r.targetId === 202);
    assert.ok(point, "point target 101 missing from TARGET_RESULTS");
    assert.ok(polygon, "polygon target 202 missing from TARGET_RESULTS");
    assert.ok(point.accessCount >= 1, "under-track point must register access");
    assert.ok(polygon.accessCount >= 1, "under-track polygon must register access");
  } finally {
    await harness.destroy?.();
  }
});

test("OrbPro worker-packed empty targets → empty TARGET_RESULTS (zero-cost path preserved)", async (t) => {
  if (!SUPERPROJECT_PRESENT) {
    return t.skip("OrbPro superproject packer not present (standalone modules checkout).");
  }
  if (!sharedMemoryAvailable()) return t.skip("SharedArrayBuffer unavailable.");

  const request = await buildWorkerPackedRequest([]);
  const harness = await makeHarness();
  try {
    const response = await invoke(harness, request.payload);
    const results = decodeTargetResults(request, response);
    assert.equal(results.length, 0, "no targets in → no TARGET_RESULTS out");
  } finally {
    await harness.destroy?.();
  }
});
