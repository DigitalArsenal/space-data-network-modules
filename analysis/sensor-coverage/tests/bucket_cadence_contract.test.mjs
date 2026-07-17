import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  createStandaloneHarnessOrSkip,
  invokeBinaryRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";
import {
  conicShape,
  createContractHarness,
  createCoveragePayload,
  invokeAndReadCoverage,
  invokeCoveragePayload,
  stateSample,
} from "./sensor_coverage_contract_helpers.mjs";

// -----------------------------------------------------------------------------
// Phase 2 regression pin for the sensor-coverage bucket-cadence contract.
//
// CONFIRMED DEFECT (live-verified 2026-07-17): the SCV coverage request carries
// a TIME_GRID (START_OFFSET_SEC / STOP_OFFSET_SEC / STEP_SEC / GRID_INDEX_START /
// GRID_INDEX_COUNT), but the module ignores the grid's step/count when it sizes
// its packed-raster output buckets. `total_window_count()`
// (src/cpp/module.cpp:1556-1564) derives windows from `states.size()-1`, and
// `module.cpp:1755` sets `raster_bucket_count = total_windows`. With 2881
// interpolation states at 15 s and an intended 60 s grid, the module therefore
// emits 2880 buckets where the request asked for 720.
//
// CONTRACT (the loop's Phase 3 fix makes the MAIN sub-test pass): the request
// TIME_GRID drives output buckets. For a 12-hour window with STEP_SEC=60 and
// GRID_INDEX_COUNT=720:
//   - RASTER_PRODUCTS.BUCKET_COUNT() == 720
//   - BUCKET_START_SECONDS / BUCKET_STOP_SECONDS arrays have 720 entries with
//     start[i] == i*60 and stop[i] == (i+1)*60, final boundary stop[719]==43200
//     included (not truncated)
//   - CURRENT_ACCESS_BITSET length == 720 * WORDS_PER_BUCKET words
//   - BUCKET_ACTIVE_CELL_COUNT length == 720
// The 2881 states at 15 s are interpolation inputs ONLY; they must not set the
// output bucket cadence.
//
// This began as the Phase 2 RED regression. Phase 3 keeps its original
// 720-vs-2880 assertion and extends it with partial-final and validation cases.
// -----------------------------------------------------------------------------

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const MANIFEST = JSON.parse(
  fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"),
);
const RUNTIME_KINDS = Object.freeze(
  MANIFEST.runtimeTargets.includes("browser") ? ["browser"] : [],
);

const STANDARDS_ROOT = resolveStandardsRoot();
const flatbuffers = await import(
  pathToFileURL(`${STANDARDS_ROOT}/node_modules/flatbuffers/mjs/flatbuffers.js`).href
);
const {
  SCV,
  SCVCoverageGridT,
  SCVCoverageRequestT,
  SCVEllipsoidT,
  SCVSensorT,
  SCVSensorShapeContractT,
  SCVStateSampleT,
  SCVTimeGridT,
  SCVT,
  SCVVec3T,
  scvAnalysisMode,
  scvBodyKind,
  scvCoordinateFrame,
  scvEnvelopeKind,
  scvGeometryDomain,
  scvMetricSeriesKind,
  scvRasterProductKind,
  scvSensorRangeBoundaryKind,
  scvSensorShapeKind,
} = await import(pathToFileURL(`${STANDARDS_ROOT}/lib/js/SCV/main.js`).href);

const SENSOR_COVERAGE_METHOD_ID = "compute_sensor_coverage";
const SENSOR_COVERAGE_PORT_ID = "coverage";
const SENSOR_COVERAGE_TYPE_REF = Object.freeze({
  schemaName: "SCV/main.fbs",
  fileIdentifier: "$SCV",
  rootTypeName: "SCV",
});

// ---- deterministic fixture parameters ---------------------------------------
// A physically plausible ~550 km, 51.6 deg-inclination circular LEO track.
// 2881 state samples at exactly 15 s cover the full 43200 s (12 h) window; the
// TIME_GRID asks for 720 output buckets at 60 s. The two cadences are distinct
// on purpose so the states-vs-buckets conflation is unambiguous.
const EARTH_EQUATORIAL_RADIUS_M = 6378137.0;
const EARTH_POLAR_RADIUS_M = 6356752.314245;
const ORBIT_ALTITUDE_M = 550000.0;
const ORBIT_RADIUS_M = EARTH_EQUATORIAL_RADIUS_M + ORBIT_ALTITUDE_M;
const EARTH_GM = 3.986004418e14; // m^3 / s^2
const ORBIT_SPEED_MPS = Math.sqrt(EARTH_GM / ORBIT_RADIUS_M);
const ORBIT_ANGULAR_RATE = ORBIT_SPEED_MPS / ORBIT_RADIUS_M; // rad/s
const ORBIT_INCLINATION_RAD = (51.6 * Math.PI) / 180.0;

const WINDOW_SECONDS = 43200; // 12 h
const STATE_STEP_SECONDS = 15;
const STATE_COUNT = WINDOW_SECONDS / STATE_STEP_SECONDS + 1; // 2881 states
const GRID_STEP_SECONDS = 60;
const EXPECTED_BUCKET_COUNT = WINDOW_SECONDS / GRID_STEP_SECONDS; // 720
const SENSOR_ID = 7;

function resolveStandardsRoot() {
  const candidates = [
    process.env.SPACE_DATA_STANDARDS_ROOT,
    new URL("../../../../spacedatastandards.org", import.meta.url).pathname,
    new URL("../node_modules/spacedatastandards.org", import.meta.url).pathname,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(`${candidate}/lib/js/SCV/main.js`)) {
      return candidate;
    }
  }
  throw new Error("Unable to resolve SDS SCV JavaScript bindings.");
}

function radiansToDegrees(value) {
  return (value * 180.0) / Math.PI;
}

// Conic sensor: half-angle 12.5 deg, range 1600 km. Mirrors the shape-contract
// shape used elsewhere in the behavior suite (degrees on the wire).
function conicShapeContract(outerHalfAngleRad, maxRangeM) {
  return new SCVSensorShapeContractT(
    scvSensorShapeKind.CONIC,
    0,
    scvSensorRangeBoundaryKind.RADIAL_SPHERICAL,
    radiansToDegrees(outerHalfAngleRad),
    0,
    0,
    360,
    0,
    0,
    0,
    0,
    0,
    0,
    maxRangeM,
  );
}

// Inclined circular-orbit state at elapsed time `t`, with velocity as the exact
// analytic derivative of the position (magnitude == circular speed).
function inclinedCircularState(elapsedSeconds) {
  const theta = ORBIT_ANGULAR_RATE * elapsedSeconds;
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);
  const cosInc = Math.cos(ORBIT_INCLINATION_RAD);
  const sinInc = Math.sin(ORBIT_INCLINATION_RAD);
  const position = new SCVVec3T(
    ORBIT_RADIUS_M * cosTheta,
    ORBIT_RADIUS_M * sinTheta * cosInc,
    ORBIT_RADIUS_M * sinTheta * sinInc,
  );
  const velocity = new SCVVec3T(
    -ORBIT_SPEED_MPS * sinTheta,
    ORBIT_SPEED_MPS * cosTheta * cosInc,
    ORBIT_SPEED_MPS * cosTheta * sinInc,
  );
  return new SCVStateSampleT(
    SENSOR_ID,
    elapsedSeconds,
    position,
    velocity,
    0,
    0,
    0,
    1,
    scvCoordinateFrame.BODY_FIXED,
  );
}

function createBucketCadenceRequestPayload() {
  const stateSamples = [];
  for (let index = 0; index < STATE_COUNT; index += 1) {
    stateSamples.push(inclinedCircularState(index * STATE_STEP_SECONDS));
  }

  // Small raster grid keeps the exact-visibility work light while still
  // exercising per-cell bucketed products (24 cells -> 1 word per bucket).
  const grid = {
    minLatitudeDeg: -8,
    maxLatitudeDeg: 8,
    minLongitudeDeg: -12,
    maxLongitudeDeg: 12,
    latitudeStepDeg: 4,
    longitudeStepDeg: 4,
  };
  const rows = Math.ceil(
    (grid.maxLatitudeDeg - grid.minLatitudeDeg) / grid.latitudeStepDeg,
  );
  const columns = Math.ceil(
    (grid.maxLongitudeDeg - grid.minLongitudeDeg) / grid.longitudeStepDeg,
  );

  const request = new SCVCoverageRequestT(
    "scv-bucket-cadence-contract",
    BigInt("720"),
    scvAnalysisMode.COVERAGE,
    new SCVEllipsoidT(
      scvBodyKind.EARTH,
      "Earth",
      EARTH_EQUATORIAL_RADIUS_M,
      EARTH_POLAR_RADIUS_M,
      EARTH_EQUATORIAL_RADIUS_M,
      scvCoordinateFrame.BODY_FIXED,
    ),
    // TIME_GRID: start 0, stop 43200, STEP_SEC 60, GRID_INDEX_START 0,
    // GRID_INDEX_COUNT 720. THIS is the authority for output bucketing.
    new SCVTimeGridT(null, 0, 0, WINDOW_SECONDS, GRID_STEP_SECONDS, 0, EXPECTED_BUCKET_COUNT),
    new SCVCoverageGridT(
      "regional-grid",
      scvGeometryDomain.SURFACE,
      scvCoordinateFrame.BODY_FIXED,
      grid.minLatitudeDeg,
      grid.maxLatitudeDeg,
      grid.minLongitudeDeg,
      grid.maxLongitudeDeg,
      grid.latitudeStepDeg,
      grid.longitudeStepDeg,
      0,
      rows * columns,
      rows,
    ),
    [
      new SCVSensorT(
        SENSOR_ID,
        "sensor-7",
        "SCV bucket-cadence sensor",
        scvCoordinateFrame.BODY_FIXED,
        null,
        null,
        null,
        null,
        conicShapeContract((12.5 * Math.PI) / 180.0, 1600000),
      ),
    ],
    stateSamples,
    [],
    [],
    // ACCESS_COUNT drives the bucketed CURRENT_ACCESS_BITSET and
    // BUCKET_ACTIVE_CELL_COUNT bands; PERCENT_COVERED adds a per-cell band.
    [scvMetricSeriesKind.PERCENT_COVERED, scvMetricSeriesKind.ACCESS_COUNT],
    0,
    0,
    0,
    0,
    undefined,
    false,
  );
  const envelope = new SCVT(scvEnvelopeKind.REQUEST, request);
  const builder = new flatbuffers.Builder(1024);
  SCV.finishSCVBuffer(builder, envelope.pack(builder));
  return builder.asUint8Array();
}

// ---- SCV result decode + shared-memory band readers -------------------------
function decodeScvResult(response) {
  const frames = response.outputs
    .filter((frame) => frame.typeRef?.fileIdentifier === "$SCV")
    .map((frame) => {
      const byteBuffer = new flatbuffers.ByteBuffer(frame.payload);
      assert.equal(SCV.bufferHasIdentifier(byteBuffer), true);
      return SCV.getRootAsSCV(byteBuffer);
    });
  const resultEnvelope = frames.find(
    (envelope) => envelope.ENVELOPE_KIND() === scvEnvelopeKind.RESULT,
  );
  assert.ok(resultEnvelope, "missing canonical SCV RESULT output frame");
  const result = resultEnvelope.RESULT();
  assert.ok(result, "missing SCV RESULT payload");
  return result;
}

function rasterRegionMap(rasterProducts) {
  const regions = new Map();
  for (let index = 0; index < rasterProducts.memoryRegionsLength(); index += 1) {
    const region = rasterProducts.MEMORY_REGIONS(index);
    regions.set(`${region.REGION_ID()}:${region.RECORD_INDEX()}`, region);
  }
  return regions;
}

function findBand(rasterProducts, productKind) {
  for (let index = 0; index < rasterProducts.bandsLength(); index += 1) {
    const band = rasterProducts.BANDS(index);
    if (band.PRODUCT_KIND() === productKind) {
      return band;
    }
  }
  return null;
}

// Reads the WHOLE module-owned shared-memory region backing a band, so the
// observed element count reflects exactly what the module wrote (independent of
// any band metadata that is itself part of the defect surface).
function readBandRegion(rasterProducts, productKind, memoryBuffer, ArrayCtor) {
  const band = findBand(rasterProducts, productKind);
  assert.ok(band, `raster band ${productKind} must be present`);
  const region = rasterRegionMap(rasterProducts).get(
    `${band.MEMORY_REGION_ID()}:${band.MEMORY_RECORD_INDEX()}`,
  );
  assert.ok(region, `raster band ${productKind} must reference a declared region`);
  const byteOffset = Number(region.BYTE_OFFSET());
  const byteLength = Number(region.BYTE_LENGTH());
  assert.equal(
    byteLength % ArrayCtor.BYTES_PER_ELEMENT,
    0,
    `raster band ${productKind} region must align to its element width`,
  );
  return {
    band,
    values: new ArrayCtor(memoryBuffer, byteOffset, byteLength / ArrayCtor.BYTES_PER_ELEMENT),
  };
}

async function createHarness(runtimeKind, t) {
  return createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t, {
    surface: "direct",
    sharedMemory: true,
    allowRawInvoke: false,
    initialMemoryBytes: 64 * 1024 * 1024,
    maximumMemoryBytes: 2 * 1024 * 1024 * 1024,
  });
}

for (const runtimeKind of RUNTIME_KINDS) {
  test(`SCV request TIME_GRID drives output bucket cadence on ${runtimeKind}`, async (t) => {
    if (
      typeof SharedArrayBuffer !== "function" ||
      typeof globalThis.WebAssembly?.Memory !== "function"
    ) {
      t.skip("Shared-memory browser direct harness is unavailable in this runtime.");
      return;
    }

    const harness = await createHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await invokeBinaryRequest(
      harness,
      createBucketCadenceRequestPayload(),
      {
        methodId: SENSOR_COVERAGE_METHOD_ID,
        inputPortId: SENSOR_COVERAGE_PORT_ID,
        inputTypeRef: SENSOR_COVERAGE_TYPE_REF,
        alignment: 8,
      },
    );

    // A non-zero status here would be a setup/harness failure, not the cadence
    // contract failure this test exists to pin — fail loudly and distinctly.
    assert.equal(response.statusCode, 0, `module invoke failed: ${response.errorMessage}`);

    const result = decodeScvResult(response);
    const raster = result.RASTER_PRODUCTS();
    assert.ok(raster, "SCV result must include packed raster products");

    const memoryBuffer = harness.memory.buffer;
    const wordsPerBucket = raster.WORDS_PER_BUCKET();
    const bucketStart = readBandRegion(
      raster,
      scvRasterProductKind.BUCKET_START_SECONDS,
      memoryBuffer,
      Float64Array,
    ).values;
    const bucketStop = readBandRegion(
      raster,
      scvRasterProductKind.BUCKET_STOP_SECONDS,
      memoryBuffer,
      Float64Array,
    ).values;
    const currentAccessBitset = readBandRegion(
      raster,
      scvRasterProductKind.CURRENT_ACCESS_BITSET,
      memoryBuffer,
      Uint32Array,
    ).values;
    const bucketActiveCellCount = readBandRegion(
      raster,
      scvRasterProductKind.BUCKET_ACTIVE_CELL_COUNT,
      memoryBuffer,
      Uint32Array,
    ).values;

    // Diagnostic record of the observed RASTER_PRODUCTS bucketing.
    console.error(
      "[bucket-cadence] observed:",
      JSON.stringify({
        stateCount: STATE_COUNT,
        expectedBucketCount: EXPECTED_BUCKET_COUNT,
        observedBucketCount: raster.BUCKET_COUNT(),
        wordsPerBucket,
        bucketStartLength: bucketStart.length,
        bucketStopLength: bucketStop.length,
        firstBucketStart: bucketStart.length ? bucketStart[0] : null,
        firstBucketStop: bucketStop.length ? bucketStop[0] : null,
        lastBucketStart: bucketStart.length ? bucketStart[bucketStart.length - 1] : null,
        lastBucketStop: bucketStop.length ? bucketStop[bucketStop.length - 1] : null,
        currentAccessBitsetLength: currentAccessBitset.length,
        bucketActiveCellCountLength: bucketActiveCellCount.length,
      }),
    );

    // ----- DENSE-STATE INDEPENDENCE WITNESS ----------------------------------
    // This preserves the original defect fixture but now asserts the final
    // contract: 2881 dense interpolation states are intentionally different
    // from the 720 requested output buckets and do not control output cadence.
    await t.test("dense states remain interpolation-only inputs", () => {
      assert.equal(STATE_COUNT, 2881, "fixture must supply 2881 interpolation states");
      assert.notEqual(
        STATE_COUNT - 1,
        EXPECTED_BUCKET_COUNT,
        "fixture must keep state segments distinct from requested buckets",
      );
      assert.equal(
        raster.BUCKET_COUNT(),
        EXPECTED_BUCKET_COUNT,
        "dense state cadence must not replace request GRID_INDEX_COUNT",
      );
    });

    // ----- MAIN CONTRACT ------------------------------------------------------
    // The request TIME_GRID (STEP_SEC=60, GRID_INDEX_COUNT=720) is the authority
    // for output bucketing. This sub-test FAILS today (expected 720, actual
    // 2880) and PASSES after the authoritative Phase 3 fix. It never skips or
    // tolerates the wrong bucket count.
    await t.test("request STEP_SEC=60 / GRID_INDEX_COUNT=720 yields 720 output buckets", () => {
      assert.equal(
        raster.BUCKET_COUNT(),
        EXPECTED_BUCKET_COUNT,
        "RASTER_PRODUCTS.BUCKET_COUNT() must equal the request GRID_INDEX_COUNT (720)",
      );

      assert.equal(
        bucketStart.length,
        EXPECTED_BUCKET_COUNT,
        "BUCKET_START_SECONDS must carry one entry per requested bucket",
      );
      assert.equal(
        bucketStop.length,
        EXPECTED_BUCKET_COUNT,
        "BUCKET_STOP_SECONDS must carry one entry per requested bucket",
      );
      for (let index = 0; index < EXPECTED_BUCKET_COUNT; index += 1) {
        assert.equal(
          bucketStart[index],
          index * GRID_STEP_SECONDS,
          `BUCKET_START_SECONDS[${index}] must be index*STEP_SEC`,
        );
        assert.equal(
          bucketStop[index],
          (index + 1) * GRID_STEP_SECONDS,
          `BUCKET_STOP_SECONDS[${index}] must be (index+1)*STEP_SEC`,
        );
      }
      // Final boundary is included, not truncated.
      assert.equal(
        bucketStop[EXPECTED_BUCKET_COUNT - 1],
        WINDOW_SECONDS,
        "final BUCKET_STOP_SECONDS must reach the window end (43200)",
      );

      assert.equal(
        currentAccessBitset.length,
        EXPECTED_BUCKET_COUNT * wordsPerBucket,
        "CURRENT_ACCESS_BITSET must be 720 * WORDS_PER_BUCKET words",
      );
      assert.equal(
        bucketActiveCellCount.length,
        EXPECTED_BUCKET_COUNT,
        "BUCKET_ACTIVE_CELL_COUNT must carry one entry per requested bucket",
      );
      assert.equal(result.TOTAL_WINDOWS(), EXPECTED_BUCKET_COUNT);
      assert.equal(result.TIME_GRID().STEP_SEC(), GRID_STEP_SECONDS);
      assert.equal(result.TIME_GRID().GRID_INDEX_COUNT(), EXPECTED_BUCKET_COUNT);
      assert.equal(raster.TIME_GRID().STEP_SEC(), GRID_STEP_SECONDS);
      assert.equal(raster.TIME_GRID().GRID_INDEX_COUNT(), EXPECTED_BUCKET_COUNT);
    });
  });
}

const SMALL_GRID = Object.freeze({
  minLatitudeDeg: -1,
  maxLatitudeDeg: 1,
  minLongitudeDeg: -1,
  maxLongitudeDeg: 1,
  latitudeStepDeg: 2,
  longitudeStepDeg: 2,
});
const SMALL_SHAPE = conicShape({ outerHalfAngleDeg: 5 });

function smallStates(times) {
  return times.map((elapsedSeconds) => stateSample({
    elapsedSeconds,
    latitudeDeg: 0,
    longitudeDeg: 0,
  }));
}

test("request STEP_SEC is preserved when the final bucket is partial", async (t) => {
  const harness = await createContractHarness(t);
  if (!harness) {
    return;
  }
  t.after(async () => {
    await harness.destroy();
  });
  const output = await invokeAndReadCoverage(
    harness,
    createCoveragePayload({
      id: "bucket-partial-final",
      grid: SMALL_GRID,
      timeGrid: { start: 100, stop: 125, step: 10, count: 3, gridIndexStart: 7 },
      states: smallStates([100, 108, 116, 125]),
      shape: SMALL_SHAPE,
    }),
  );
  assert.equal(output.bucketCount, 3);
  assert.deepEqual(output.bucketStart, [100, 110, 120]);
  assert.deepEqual(output.bucketStop, [110, 120, 125]);
  assert.equal(output.result.TOTAL_WINDOWS(), 3);
  assert.equal(output.result.TIME_GRID().STEP_SEC(), 10);
  assert.equal(output.result.TIME_GRID().GRID_INDEX_START(), 7);
  assert.equal(output.result.TIME_GRID().GRID_INDEX_COUNT(), 3);
  assert.equal(output.raster.TIME_GRID().STEP_SEC(), 10);
  assert.equal(output.raster.TIME_GRID().GRID_INDEX_START(), 7);
  assert.equal(output.raster.TIME_GRID().GRID_INDEX_COUNT(), 3);
});

test("invalid request TIME_GRID values are rejected without inference or truncation", async (t) => {
  const harness = await createContractHarness(t);
  if (!harness) {
    return;
  }
  t.after(async () => {
    await harness.destroy();
  });
  const cases = [
    {
      name: "TIME_GRID absent",
      includeTimeGrid: false,
      timeGrid: { start: 0, stop: 10, step: 10, count: 1 },
      message: /TIME_GRID/i,
    },
    {
      name: "STEP_SEC zero",
      timeGrid: { start: 0, stop: 10, step: 0, count: 1 },
      message: /STEP_SEC/i,
    },
    {
      name: "STEP_SEC negative",
      timeGrid: { start: 0, stop: 10, step: -1, count: 10 },
      message: /STEP_SEC/i,
    },
    {
      name: "STEP_SEC NaN",
      timeGrid: { start: 0, stop: 10, step: Number.NaN, count: 1 },
      message: /STEP_SEC/i,
    },
    {
      name: "STEP_SEC infinity",
      timeGrid: { start: 0, stop: 10, step: Number.POSITIVE_INFINITY, count: 1 },
      message: /STEP_SEC/i,
    },
    {
      name: "GRID_INDEX_COUNT zero",
      timeGrid: { start: 0, stop: 10, step: 10, count: 0 },
      message: /GRID_INDEX_COUNT/i,
    },
    {
      name: "START equals STOP",
      timeGrid: { start: 10, stop: 10, step: 10, count: 1 },
      message: /START.*STOP|STOP.*START/i,
    },
    {
      name: "START exceeds STOP",
      timeGrid: { start: 11, stop: 10, step: 10, count: 1 },
      message: /START.*STOP|STOP.*START/i,
    },
    {
      name: "span is too short for count",
      timeGrid: { start: 0, stop: 20, step: 10, count: 3 },
      message: /span|GRID_INDEX_COUNT/i,
    },
    {
      name: "span is too long for count",
      timeGrid: { start: 0, stop: 31, step: 10, count: 3 },
      message: /span|GRID_INDEX_COUNT/i,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const response = await invokeCoveragePayload(
        harness,
        createCoveragePayload({
          id: `invalid-${entry.name}`,
          grid: SMALL_GRID,
          timeGrid: entry.timeGrid,
          states: smallStates([0, 1]),
          shape: SMALL_SHAPE,
          includeTimeGrid: entry.includeTimeGrid ?? true,
        }),
      );
      assert.notEqual(response.statusCode, 0, `${entry.name}: invoke must fail`);
      assert.match(response.errorMessage, entry.message, `${entry.name}: clear validation message`);
    });
  }
});
