import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk";

const SRC_DIR = fileURLToPath(new URL("../src/cpp/", import.meta.url));
const MODULE_CPP_PATH = fileURLToPath(new URL("../src/cpp/module.cpp", import.meta.url));
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_CPP_DIR = fileURLToPath(
  new URL("../../../../spacedatastandards.org/lib/cpp/", import.meta.url),
);
const STANDARDS_ROOT = fileURLToPath(
  new URL("../../../../spacedatastandards.org/", import.meta.url),
);
const FLATBUFFERS_INCLUDE_CANDIDATES = [
  process.env.FLATBUFFERS_INCLUDE_DIR,
  fileURLToPath(new URL("../../../../flatbuffers/include/", import.meta.url)),
  fileURLToPath(new URL("../../../../../../flatbuffers/include/", import.meta.url)),
  fileURLToPath(new URL("../../../../orbpro-integration/sdk/include/", import.meta.url)),
].filter(Boolean);

function resolveFlatbuffersIncludeDir() {
  for (const includeDir of FLATBUFFERS_INCLUDE_CANDIDATES) {
    const headerPath = path.join(includeDir, "flatbuffers", "flatbuffers.h");
    if (!fs.existsSync(headerPath)) {
      continue;
    }
    const header = fs.readFileSync(headerPath, "utf8");
    if (
      header.includes("FLATBUFFERS_VERSION_MAJOR") &&
      header.includes("namespace flatbuffers")
    ) {
      return includeDir;
    }
  }
  return FLATBUFFERS_INCLUDE_CANDIDATES[0];
}

const FLATBUFFERS_INCLUDE_DIR = resolveFlatbuffersIncludeDir();
const flatbuffers = await import(
  pathToFileURL(`${STANDARDS_ROOT}/node_modules/flatbuffers/mjs/flatbuffers.js`).href
);
const {
  SCV,
  SCVCoverageRequestT,
  SCVSensorShapeContractT,
  SCVSensorT,
  SCVTargetT,
  SCVT,
  SCVVec3T,
  scvCoordinateFrame,
  scvEnvelopeKind,
  scvResultState,
  scvSensorRangeBoundaryKind,
  scvSensorShapeKind,
} = await import(pathToFileURL(`${STANDARDS_ROOT}/lib/js/SCV/main.js`).href);
const {
  SENSOR_SHAPE_CONFORMANCE_VECTORS,
} = await import(
  pathToFileURL(
    `${STANDARDS_ROOT}/test/fixtures/scvSensorShapeConformanceVectors.mjs`,
  ).href
);

const CPP_BEHAVIOR_TEST = String.raw`
#include <cmath>
#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#include "sensor_shape_model.h"
#include "sensor_shape_model.cpp.inc"

using namespace sdn_hypersonics;

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 2.0 * kPi;
constexpr double kTolerance = 1.0e-10;

double deg(double value) {
  return value * kPi / 180.0;
}

bool near(double left, double right, double tolerance = kTolerance) {
  return std::fabs(left - right) <= tolerance;
}

void require(bool condition, const std::string& message) {
  if (!condition) {
    std::cerr << message << "\n";
    std::exit(1);
  }
}

SensorVec3 look_direction(double coneDeg, double clockDeg) {
  const double cone = deg(coneDeg);
  const double clock = deg(clockDeg);
  return normalize_vector({
      std::sin(cone) * std::cos(clock),
      std::sin(cone) * std::sin(clock),
      std::cos(cone),
  });
}

void require_unit_directions(
    const std::vector<SensorVec3>& directions,
    size_t expectedCount,
    const std::string& label) {
  require(directions.size() == expectedCount, label + " boundary count mismatch");
  for (const SensorVec3& direction : directions) {
    require(std::isfinite(direction.x), label + " boundary x is not finite");
    require(std::isfinite(direction.y), label + " boundary y is not finite");
    require(std::isfinite(direction.z), label + " boundary z is not finite");
    require(near(vector_magnitude(direction), 1.0, 1.0e-9), label + " boundary direction is not normalized");
  }
}

void test_clock_ranges() {
  const SensorClockRange full = normalize_clock_range_rad(0.0, kTwoPi);
  require(full.fullCircle, "0..360 clock range must normalize to full circle");
  require(!full.wrapped, "full clock range must not be marked wrapped");
  require(near(full.spanRad, kTwoPi), "full clock range must preserve 2*pi span");

  const SensorClockRange wrapped = normalize_clock_range_rad(deg(300.0), deg(60.0));
  require(!wrapped.fullCircle, "300..60 clock range must be partial");
  require(wrapped.wrapped, "300..60 clock range must be wrapped");
  require(near(wrapped.startRad, deg(300.0)), "wrapped start angle changed");
  require(near(wrapped.stopRad, deg(60.0)), "wrapped stop angle changed");
  require(near(wrapped.spanRad, deg(120.0)), "wrapped span must be 120 degrees");

  require(clock_angle_in_range(deg(350.0), wrapped), "350 degrees should be inside wrapped sector");
  require(clock_angle_in_range(deg(30.0), wrapped), "30 degrees should be inside wrapped sector");
  require(!clock_angle_in_range(deg(180.0), wrapped), "180 degrees should be outside wrapped sector");
}

void test_conic_classification() {
  const SensorShapeContract solid = make_conic_shape(deg(20.0), 0.0, 0.0, kTwoPi, 100.0, 1000.0);
  require(near(solid.outerHalfAngleRad, deg(20.0)), "conic outer angle was not preserved");
  require(near(solid.minRangeM, 100.0), "conic min range was not preserved");
  require(near(solid.maxRangeM, 1000.0), "conic max range was not preserved");
  require(classify_local_look(solid, scale_vector(look_direction(10.0, 0.0), 500.0)).inside,
      "10 degree conic look should be inside 20 degree solid cone");
  require(!classify_local_look(solid, scale_vector(look_direction(25.0, 0.0), 500.0)).inside,
      "25 degree conic look should be outside 20 degree solid cone");

  const SensorShapeContract annular = make_conic_shape(deg(30.0), deg(10.0));
  require(!classify_local_look(annular, look_direction(5.0, 0.0)).inside,
      "inner cutout must exclude looks below inner half angle");
  require(classify_local_look(annular, look_direction(15.0, 0.0)).inside,
      "annular conic should include looks between inner and outer half angles");
}

void test_rectangular_classification() {
  const SensorShapeContract rectangular = make_rectangular_shape(deg(10.0), deg(20.0));
  require(near(rectangular.crossTrackHalfAngleRad, deg(10.0)), "rectangular cross-track angle was not preserved");
  require(near(rectangular.alongTrackHalfAngleRad, deg(20.0)), "rectangular along-track angle was not preserved");
  require(classify_local_look(rectangular, {std::tan(deg(5.0)), std::tan(deg(10.0)), 1.0}).inside,
      "rectangular look inside both half angles should classify inside");
  require(!classify_local_look(rectangular, {std::tan(deg(15.0)), 0.0, 1.0}).inside,
      "rectangular look beyond cross-track half angle should classify outside");
  require(!classify_local_look(rectangular, {0.0, std::tan(deg(25.0)), 1.0}).inside,
      "rectangular look beyond along-track half angle should classify outside");
}

void test_sar_annular_sector_classification() {
  const SensorShapeContract sar = make_sar_annular_sector_shape(
      deg(20.0),
      deg(40.0),
      deg(300.0),
      deg(60.0));
  require(near(sar.innerHalfAngleRad, deg(20.0)), "SAR inner look angle was not preserved");
  require(near(sar.outerHalfAngleRad, deg(40.0)), "SAR outer look angle was not preserved");
  require(sar.clockRange.wrapped, "SAR 300..60 sector must wrap");
  require(classify_local_look(sar, look_direction(30.0, 350.0)).inside,
      "SAR look inside annulus and wrapped clock sector should classify inside");
  require(!classify_local_look(sar, look_direction(30.0, 180.0)).inside,
      "SAR look outside clock sector should classify outside");
  require(!classify_local_look(sar, look_direction(10.0, 350.0)).inside,
      "SAR look below inner angle should classify outside");
  require(!classify_local_look(sar, look_direction(45.0, 350.0)).inside,
      "SAR look beyond outer angle should classify outside");
}

SensorShapeContract conformance_shape(const std::string& name) {
  if (name == "solid-conic") {
    return make_conic_shape(kPi / 6.0, 0.0, 0.0, kTwoPi, 0.0, 100.0);
  }
  if (name == "inner-cutout") {
    return make_conic_shape(kPi / 4.0, kPi / 18.0, 0.0, kTwoPi, 0.0, 100.0);
  }
  if (name == "partial-clock-sector") {
    return make_conic_shape(kPi / 4.0, 0.0, 0.0, kPi / 2.0, 0.0, 100.0);
  }
  if (name == "wrapped-clock-sector") {
    return make_conic_shape(kPi / 4.0, 0.0, 5.0 * kPi / 3.0, kPi / 3.0, 0.0, 100.0);
  }
  if (name == "rectangular") {
    return make_rectangular_shape(kPi / 8.0, kPi / 10.0, 0.0, 100.0);
  }
  if (name == "sar-annular-sector") {
    return make_sar_annular_sector_shape(kPi / 9.0, kPi / 4.0, -kPi / 6.0, kPi / 6.0, 0.0, 100.0);
  }
  return make_custom_polygon_shape(
      {{-0.4, -0.4, 1.0}, {0.4, -0.4, 1.0}, {0.4, 0.4, 1.0}, {-0.4, 0.4, 1.0}},
      0.0,
      100.0);
}

void require_contains_label(
    const std::vector<std::string>& labels,
    const std::string& label,
    const std::string& vectorName) {
  require(
      std::find(labels.begin(), labels.end(), label) != labels.end(),
      vectorName + " missing conformance label " + label);
}

void require_conformance_vector(
    const std::string& name,
    const SensorVec3& inside,
    const SensorVec3& outside) {
  const SensorShapeContract shape = conformance_shape(name);
  const SensorClassification insideClassification = classify_local_look(shape, inside);
  const SensorClassification outsideClassification = classify_local_look(shape, outside);
  require(insideClassification.supported, name + " inside classification must be supported");
  require(outsideClassification.supported, name + " outside classification must be supported");
  require(insideClassification.inside, name + " inside vector must classify inside");
  require(!outsideClassification.inside, name + " outside vector must classify outside");
  require(insideClassification.lookRangeM <= 100.0 + 1.0e-9, name + " inside range must honor radius");
  require(outsideClassification.lookRangeM <= 100.0 + 1.0e-9, name + " outside vector must stay within radius");
  require_contains_label(shape.conformanceLabels, name, name);
}

void test_shared_conformance_vectors() {
  require_conformance_vector("solid-conic", {0.0, 0.0, 50.0}, {50.0, 0.0, 50.0});
  require_conformance_vector("inner-cutout", {20.0, 0.0, 50.0}, {1.0, 0.0, 50.0});
  require_conformance_vector("partial-clock-sector", {20.0, 20.0, 50.0}, {-20.0, 20.0, 50.0});
  require_conformance_vector("wrapped-clock-sector", {20.0, 0.0, 50.0}, {0.0, 20.0, 50.0});
  require_conformance_vector("rectangular", {10.0, 5.0, 50.0}, {30.0, 0.0, 50.0});
  require_conformance_vector("sar-annular-sector", {20.0, 0.0, 50.0}, {0.0, 20.0, 50.0});
  require_conformance_vector("custom-polygon", {0.0, 0.0, 50.0}, {50.0, 0.0, 50.0});
}

void test_custom_polygon_classification() {
  const SensorShapeContract custom = make_custom_polygon_shape(
      {{-0.4, -0.4, 1.0}, {0.4, -0.4, 1.0}, {0.4, 0.4, 1.0}, {-0.4, 0.4, 1.0}},
      0.0,
      100.0);
  require(custom.supported, "custom polygon contract must be supported");
  const SensorClassification insideClassification =
      classify_local_look(custom, {0.0, 0.0, 50.0});
  const SensorClassification outsideClassification =
      classify_local_look(custom, {50.0, 0.0, 50.0});
  require(insideClassification.supported,
      "custom polygon inside classification must be supported");
  require(insideClassification.inside,
      "custom polygon boresight look must classify inside");
  require(!outsideClassification.inside,
      "custom polygon off-axis look must classify outside");
  require(generate_sensor_boundary_directions(custom).size() == 4,
      "custom polygon boundary generation must return its vertices");

  const SensorShapeContract degenerate = make_custom_polygon_shape(
      {{0.0, 0.0, 1.0}, {0.4, 0.0, 1.0}}, 0.0, 100.0);
  require(!degenerate.supported,
      "custom polygon with fewer than 3 vertices must be unsupported");
  const SensorClassification degenerateClassification =
      classify_local_look(degenerate, {0.0, 0.0, 50.0});
  require(!degenerateClassification.inside,
      "degenerate custom polygon must not claim containment");
}

void test_boundary_generation() {
  SensorShapeContract conic = make_conic_shape(deg(20.0));
  conic.boundarySamples = 12;
  require_unit_directions(generate_sensor_boundary_directions(conic), 12, "conic");

  const SensorShapeContract rectangular = make_rectangular_shape(deg(10.0), deg(20.0));
  require_unit_directions(generate_sensor_boundary_directions(rectangular), 4, "rectangular");

  SensorShapeContract sar = make_sar_annular_sector_shape(deg(20.0), deg(40.0), deg(300.0), deg(60.0));
  sar.boundarySamples = 10;
  require_unit_directions(generate_sensor_boundary_directions(sar), 20, "SAR");
}

}  // namespace

int main() {
  test_clock_ranges();
  test_conic_classification();
  test_rectangular_classification();
  test_sar_annular_sector_classification();
  test_shared_conformance_vectors();
  test_custom_polygon_classification();
  test_boundary_generation();
  return 0;
}
`;

const CPP_SDS_CONTRACT_TEST = String.raw`
#include "flatbuffers/flatbuffers.h"
#ifdef DOMAIN
#undef DOMAIN
#endif
#include "SCV/main_generated.h"

#include <cmath>
#include <cstdlib>
#include <iostream>
#include <string>

#include "sensor_shape_model.h"
#include "sensor_shape_model.cpp.inc"

using namespace sdn_hypersonics;

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kDegreesToRadians = kPi / 180.0;

bool near(double left, double right, double tolerance = 1.0e-10) {
  return std::fabs(left - right) <= tolerance;
}

void require(bool condition, const std::string& message) {
  if (!condition) {
    std::cerr << message << "\n";
    std::exit(1);
  }
}

}  // namespace

int main() {
  flatbuffers::FlatBufferBuilder builder(1024);
  auto shape = CreateSCVSensorShapeContract(
      builder,
      scvSensorShapeKind_RECTANGULAR,
      scvSensorAxisConvention_LOCAL_X_RIGHT_Y_UP_Z_BORESIGHT,
      scvSensorRangeBoundaryKind_LOCAL_Z_PLANE,
      0.0,
      0.0,
      0.0,
      360.0,
      12.0,
      18.0,
      0.0,
      0.0,
      0.0,
      20.0,
      200.0);
  auto sensor = CreateSCVSensor(
      builder,
      42,
      0,
      0,
      scvCoordinateFrame_UNKNOWN,
      0,
      0,
      0,
      0,
      shape);
  builder.Finish(sensor);

  const SCVSensor* parsedSensor = flatbuffers::GetRoot<SCVSensor>(builder.GetBufferPointer());
  const SensorShapeContract contract = parse_sensor_shape_contract(parsedSensor);
  require(contract.kind == SensorShapeKind::Rectangular, "SHAPE_KIND must parse rectangular contracts");
  require(contract.rangeBoundary == SensorRangeBoundaryKind::LocalZPlane, "RANGE_BOUNDARY must parse local-z-plane contracts");
  require(near(contract.crossTrackHalfAngleRad, 12.0 * kDegreesToRadians), "X_HALF_ANGLE_DEG must be preserved");
  require(near(contract.alongTrackHalfAngleRad, 18.0 * kDegreesToRadians), "Y_HALF_ANGLE_DEG must be preserved");
  require(near(contract.minRangeM, 20.0), "MIN_RANGE_M must be preserved");
  require(near(contract.maxRangeM, 200.0), "MAX_RANGE_M must be preserved");

  flatbuffers::FlatBufferBuilder missingContractBuilder(1024);
  auto missingContractSensor = CreateSCVSensor(
      missingContractBuilder,
      7,
      0,
      0,
      scvCoordinateFrame_UNKNOWN,
      0,
      0,
      0,
      0,
      0);
  missingContractBuilder.Finish(missingContractSensor);
  const SCVSensor* missingContractParsed =
      flatbuffers::GetRoot<SCVSensor>(missingContractBuilder.GetBufferPointer());
  const SensorShapeContract missingContract =
      parse_sensor_shape_contract(missingContractParsed);
  require(!missingContract.supported, "SCV sensor without SHAPE_CONTRACT must be unsupported");
  require(
      missingContract.unsupportedReason.find("SHAPE_CONTRACT") != std::string::npos,
      "missing SHAPE_CONTRACT failure must explain the missing contract");
  return 0;
}
`;

function compileAndRunCpp(source, { includeDirs = [SRC_DIR], label = "C++ harness" } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sensor-shape-model-"));
  try {
    const sourcePath = path.join(tmpDir, "harness.cpp");
    const executablePath = path.join(tmpDir, "harness");
    fs.writeFileSync(sourcePath, source);

    const compiler = process.env.CXX || "c++";
    const includeArgs = includeDirs.flatMap((includeDir) => ["-I", includeDir]);
    const compile = spawnSync(
      compiler,
      ["-std=c++17", "-O0", ...includeArgs, sourcePath, "-o", executablePath],
      { encoding: "utf8" },
    );
    assert.equal(
      compile.status,
      0,
      `failed to compile ${label}\nstdout:\n${compile.stdout}\nstderr:\n${compile.stderr}`,
    );

    const run = spawnSync(executablePath, [], { encoding: "utf8" });
    assert.equal(
      run.status,
      0,
      `${label} failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function radiansToDegrees(value) {
  return (value * 180.0) / Math.PI;
}

function conformanceShapeContract(vector) {
  const shape = vector.shape;
  const minRangeMeters = shape.minRangeMeters ?? 0;
  if (vector.type === "conic") {
    return new SCVSensorShapeContractT(
      scvSensorShapeKind.CONIC,
      0,
      scvSensorRangeBoundaryKind.RADIAL_SPHERICAL,
      radiansToDegrees(shape.outerHalfAngleRad),
      radiansToDegrees(shape.innerHalfAngleRad),
      radiansToDegrees(shape.minimumClockAngleRad),
      radiansToDegrees(shape.maximumClockAngleRad),
      0,
      0,
      0,
      0,
      1,
      minRangeMeters,
      shape.radiusMeters,
    );
  }
  if (vector.type === "rectangular") {
    return new SCVSensorShapeContractT(
      scvSensorShapeKind.RECTANGULAR,
      0,
      scvSensorRangeBoundaryKind.RADIAL_SPHERICAL,
      0,
      0,
      0,
      360,
      radiansToDegrees(shape.xHalfAngleRad),
      radiansToDegrees(shape.yHalfAngleRad),
      0,
      0,
      1,
      minRangeMeters,
      shape.radiusMeters,
    );
  }
  if (vector.type === "sar") {
    return new SCVSensorShapeContractT(
      scvSensorShapeKind.SAR_ANNULAR_SECTOR,
      0,
      scvSensorRangeBoundaryKind.RADIAL_SPHERICAL,
      0,
      0,
      radiansToDegrees(shape.minimumClockAngleRad),
      radiansToDegrees(shape.maximumClockAngleRad),
      0,
      0,
      radiansToDegrees(shape.innerLookAngleRad),
      radiansToDegrees(shape.outerLookAngleRad),
      shape.sarSamplingDensity,
      minRangeMeters,
      shape.radiusMeters,
    );
  }
  throw new Error(`Unsupported conformance vector type: ${vector.type}`);
}

function vectorTarget(targetId, name, coordinates) {
  return new SCVTargetT(
    targetId,
    String(targetId),
    name,
    scvCoordinateFrame.SENSOR_LOCAL,
    new SCVVec3T(coordinates[0], coordinates[1], coordinates[2]),
    null,
    0,
  );
}

function createSensorModelTargetPayload(vector) {
  const request = new SCVCoverageRequestT(
    `sensor-model-target-parity-${vector.name}`,
    BigInt("6006"),
    0,
    null,
    null,
    null,
    [
      new SCVSensorT(
        11,
        "sensor-model-parity",
        `sensor-model ${vector.name} parity sensor`,
        scvCoordinateFrame.SENSOR_LOCAL,
        null,
        null,
        null,
        null,
        conformanceShapeContract(vector),
      ),
    ],
    [],
    [
      vectorTarget(1, `${vector.name}:inside`, vector.inside),
      vectorTarget(2, `${vector.name}:outside`, vector.outside),
    ],
    [],
    [],
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

async function invokeSensorModel(payload) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(WASM_PATH),
    surface: "direct",
    sharedMemory: true,
    allowRawInvoke: false,
    initialMemoryBytes: 64 * 1024 * 1024,
    maximumMemoryBytes: 2 * 1024 * 1024 * 1024,
  });
  try {
    const payloadSize = payload.byteLength;
    const payloadPtr = harness.instance.exports.plugin_alloc(payloadSize);
    new Uint8Array(harness.memory.buffer, payloadPtr, payloadSize).set(payload);
    try {
      return await harness.invoke({
        methodId: "evaluate_sensor_shape",
        externalArena: new Uint8Array(harness.memory.buffer),
        inputs: [
          {
            portId: "sensor",
            typeRef: {
              schemaName: "SCV/main.fbs",
              fileIdentifier: "$SCV",
              rootTypeName: "SCV",
            },
            offset: payloadPtr,
            size: payloadSize,
            alignment: 8,
          },
        ],
      });
    } finally {
      harness.instance.exports.plugin_free(payloadPtr, payloadSize);
    }
  } finally {
    await harness.destroy();
  }
}

function sensorModelResult(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  const frame = response.outputs.find(
    (entry) => entry.typeRef?.fileIdentifier === "$SCV",
  );
  assert.ok(frame, "sensor-model response must include an SCV result frame");
  const byteBuffer = new flatbuffers.ByteBuffer(frame.payload);
  assert.equal(SCV.bufferHasIdentifier(byteBuffer), true);
  const envelope = SCV.getRootAsSCV(byteBuffer);
  assert.equal(envelope.ENVELOPE_KIND(), scvEnvelopeKind.RESULT);
  const result = envelope.RESULT();
  assert.ok(result, "sensor-model response must include SCV RESULT");
  return result;
}

test("shared C++ sensor shape model executes closed-form behavior checks", () => {
  compileAndRunCpp(CPP_BEHAVIOR_TEST, { label: "C++ behavior harness" });
});

test("sensor-model module classifies SCV target samples with the shared shape model", async (t) => {
  if (typeof SharedArrayBuffer !== "function") {
    t.skip("SharedArrayBuffer is not available in this runtime.");
    return;
  }

  for (const vector of SENSOR_SHAPE_CONFORMANCE_VECTORS) {
    const result = sensorModelResult(
      await invokeSensorModel(createSensorModelTargetPayload(vector)),
    );
    assert.equal(result.STATUS(), scvResultState.OK, vector.name);
    assert.equal(result.TOTAL_SENSORS(), 1, vector.name);
    assert.equal(result.TOTAL_WINDOWS(), 1, vector.name);
    const statistics = result.AGGREGATE_STATISTICS();
    assert.ok(statistics, `${vector.name}: missing target sample statistics`);
    assert.equal(statistics.TOTAL_CELLS(), 2, vector.name);
    assert.equal(statistics.ACCESSED_CELLS(), 1, vector.name);
    assert.equal(statistics.ACTIVE_SENSOR_COUNT(), 1, vector.name);
    assert.equal(statistics.TOTAL_INTERVAL_COUNT(), 2, vector.name);
    assert.match(result.MESSAGE(), new RegExp(`${vector.name}.*targetInside=1`));
  }
});

test("shared C++ parser compiles against current SDS sensor contract headers", () => {
  compileAndRunCpp(CPP_SDS_CONTRACT_TEST, {
    includeDirs: [SRC_DIR, STANDARDS_CPP_DIR, FLATBUFFERS_INCLUDE_DIR],
    label: "SDS contract parser harness",
  });
});

test("module source evaluates request sensors and rejects unsupported contracts", () => {
  const source = fs.readFileSync(MODULE_CPP_PATH, "utf8");
  assert.match(source, /#include "SCV\/main_generated\.h"/);
  assert.match(source, /REQUEST\(\)->SENSORS\(\)|request->SENSORS\(\)/);
  assert.match(source, /parse_sensor_shape_contract\(/);
  assert.match(source, /generate_sensor_boundary_directions\(/);
  assert.match(source, /classify_local_look\(/);
  assert.match(source, /fail\(\s*"missing-sensors"/);
  assert.match(source, /fail\(\s*"unsupported-shape"/);
  assert.match(source, /SensorShapeKind::Unknown/);
  assert.match(source, /SensorShapeKind::CustomPolygon/);

  const resultCallStart = source.indexOf("CreateSCVResult(");
  const resultCallEnd = source.indexOf("auto scv = CreateSCV", resultCallStart);
  assert.notEqual(resultCallStart, -1);
  assert.notEqual(resultCallEnd, -1);
  const resultCall = source.slice(resultCallStart, resultCallEnd);
  for (const retiredToken of [
    "SCVCellStat",
    "SCVInterval",
    "SCVLatitudeBandStat",
    "SCVTimeSeriesPoint",
    "CELL_STATS",
    "INTERVALS",
    "LATITUDE_BANDS",
    "TIME_SERIES",
  ]) {
    assert.doesNotMatch(resultCall, new RegExp(retiredToken));
  }
  assert.doesNotMatch(resultCall, /,\s*0,\s*0,\s*0,\s*0,\s*0,\s*0,\s*message\)/);
});
