import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC_DIR = fileURLToPath(new URL("../src/cpp/", import.meta.url));

const CPP_BEHAVIOR_TEST = String.raw`
#include <cmath>
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

void test_custom_polygon_unsupported() {
  const SensorShapeContract custom = make_custom_polygon_unsupported_shape({{1.0, 0.0, 0.0}});
  const SensorClassification classification = classify_local_look(custom, {0.0, 0.0, 1.0});
  require(!custom.supported, "custom polygon contract must be marked unsupported");
  require(!classification.supported, "custom polygon classification must be unsupported");
  require(!classification.inside, "custom polygon classification must not claim containment");
  require(classification.reason.find("unsupported shape") != std::string::npos,
      "custom polygon classification must report unsupported shape");
  require(generate_sensor_boundary_directions(custom).empty(),
      "custom polygon boundary generation must be empty while unsupported");
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
  test_custom_polygon_unsupported();
  test_boundary_generation();
  return 0;
}
`;

test("shared C++ sensor shape model executes closed-form behavior checks", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sensor-shape-model-"));
  try {
    const sourcePath = path.join(tmpDir, "behavior.cpp");
    const executablePath = path.join(tmpDir, "behavior");
    fs.writeFileSync(sourcePath, CPP_BEHAVIOR_TEST);

    const compiler = process.env.CXX || "c++";
    const compile = spawnSync(
      compiler,
      ["-std=c++17", "-O0", "-I", SRC_DIR, sourcePath, "-o", executablePath],
      { encoding: "utf8" },
    );
    assert.equal(
      compile.status,
      0,
      `failed to compile C++ behavior harness\nstdout:\n${compile.stdout}\nstderr:\n${compile.stderr}`,
    );

    const run = spawnSync(executablePath, [], { encoding: "utf8" });
    assert.equal(
      run.status,
      0,
      `C++ behavior harness failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
