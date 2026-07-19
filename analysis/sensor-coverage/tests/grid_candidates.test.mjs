import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const modulesRoot = path.resolve(packageRoot, "../..");
const commonRoot = path.join(modulesRoot, "common");

function compileAndRun(source) {
  const directory = mkdtempSync(path.join(tmpdir(), "coverage-grid-candidates-"));
  const sourcePath = path.join(directory, "test.cpp");
  const binaryPath = path.join(directory, "test");
  writeFileSync(sourcePath, source);
  execFileSync(
    process.env.CXX || "c++",
    ["-std=c++17", "-O2", `-I${commonRoot}`, sourcePath, "-o", binaryPath],
    { stdio: "pipe" },
  );
  return execFileSync(binaryPath, { encoding: "utf8" }).trim();
}

test("candidate grid ranges stay local for an ordinary footprint", () => {
  const output = compileAndRun(String.raw`
#include <algorithm>
#include <iostream>
#include <vector>
#include "sensor_coverage_core.h"
#include "sensor_coverage_core.cpp.inc"

int main() {
  using namespace sdn::coverage;
  const GridDefinition grid{-90, 90, -180, 180, 5, 5, 36, 72};
  const LonLat center{0, 0};
  const LonLat vertices[] = {{-3, -4}, {-3, 4}, {3, 4}, {3, -4}};
  std::vector<uint32_t> marks(36 * 72, 0);
  std::vector<uint32_t> candidates;
  appendFootprintCandidates(
    grid, center, vertices, 4, marks, 1, candidates);
  std::sort(candidates.begin(), candidates.end());
  const uint32_t centerCell = 18 * 72 + 36;
  std::cout << candidates.size() << " "
            << std::binary_search(candidates.begin(), candidates.end(), centerCell);
}
`);

  const [count, includesCenter] = output.split(" ").map(Number);
  assert.equal(includesCenter, 1);
  assert.ok(count > 0);
  assert.ok(count < 80, `ordinary footprint produced ${count} candidates`);
});

test("candidate grid ranges split rather than spanning the antimeridian", () => {
  const output = compileAndRun(String.raw`
#include <algorithm>
#include <iostream>
#include <vector>
#include "sensor_coverage_core.h"
#include "sensor_coverage_core.cpp.inc"

int main() {
  using namespace sdn::coverage;
  const GridDefinition grid{-90, 90, -180, 180, 5, 5, 36, 72};
  const LonLat center{0, 179.5};
  const LonLat vertices[] = {{-2, 178}, {-2, -179}, {2, -179}, {2, 178}};
  std::vector<uint32_t> marks(36 * 72, 0);
  std::vector<uint32_t> candidates;
  appendFootprintCandidates(
    grid, center, vertices, 4, marks, 1, candidates);
  bool west = false;
  bool east = false;
  for (const uint32_t index : candidates) {
    const uint32_t column = index % 72;
    west = west || column <= 1;
    east = east || column >= 70;
  }
  std::cout << candidates.size() << " " << west << " " << east;
}
`);

  const [count, includesWest, includesEast] = output.split(" ").map(Number);
  assert.equal(includesWest, 1);
  assert.equal(includesEast, 1);
  assert.ok(count < 80, `antimeridian footprint produced ${count} candidates`);
});

test("candidate grid ranges conservatively include every polar longitude", () => {
  const output = compileAndRun(String.raw`
#include <iostream>
#include <vector>
#include "sensor_coverage_core.h"
#include "sensor_coverage_core.cpp.inc"

int main() {
  using namespace sdn::coverage;
  const GridDefinition grid{-90, 90, -180, 180, 5, 5, 36, 72};
  const LonLat center{89, 10};
  const LonLat vertices[] = {{86, -170}, {88, -20}, {89.5, 80}, {87, 170}};
  std::vector<uint32_t> marks(36 * 72, 0);
  std::vector<uint32_t> candidates;
  appendFootprintCandidates(
    grid, center, vertices, 4, marks, 1, candidates);
  bool columns[72] = {};
  for (const uint32_t index : candidates) {
    columns[index % 72] = true;
  }
  int coveredColumns = 0;
  for (bool covered : columns) {
    coveredColumns += covered ? 1 : 0;
  }
  std::cout << coveredColumns;
}
`);

  assert.equal(Number(output), 72);
});

test("spherical cap rasterization produces narrow latitude-row spans", () => {
  const output = compileAndRun(String.raw`
#include <algorithm>
#include <iostream>
#include <vector>
#include "sensor_coverage_core.h"
#include "sensor_coverage_core.cpp.inc"

int main() {
  using namespace sdn::coverage;
  const GridDefinition grid{-90, 90, -180, 180, 5, 5, 36, 72};
  std::vector<uint32_t> marks(36 * 72, 0);
  std::vector<uint32_t> candidates;
  appendSphericalCapCandidates(
    grid, {0, 0}, 22, marks, 1, candidates);
  std::sort(candidates.begin(), candidates.end());
  const uint32_t centerCell = 18 * 72 + 36;
  std::cout << candidates.size() << " "
            << std::binary_search(candidates.begin(), candidates.end(), centerCell);
}
`);

  const [count, includesCenter] = output.split(" ").map(Number);
  assert.equal(includesCenter, 1);
  assert.ok(count >= 60);
  assert.ok(count <= 140, `22 degree cap produced ${count} candidates`);
});

test("spherical cap rasterization wraps at the antimeridian", () => {
  const output = compileAndRun(String.raw`
#include <iostream>
#include <vector>
#include "sensor_coverage_core.h"
#include "sensor_coverage_core.cpp.inc"

int main() {
  using namespace sdn::coverage;
  const GridDefinition grid{-90, 90, -180, 180, 5, 5, 36, 72};
  std::vector<uint32_t> marks(36 * 72, 0);
  std::vector<uint32_t> candidates;
  appendSphericalCapCandidates(
    grid, {0, 179}, 12, marks, 1, candidates);
  bool west = false;
  bool east = false;
  for (const uint32_t index : candidates) {
    const uint32_t column = index % 72;
    west = west || column <= 1;
    east = east || column >= 70;
  }
  std::cout << candidates.size() << " " << west << " " << east;
}
`);

  const [count, includesWest, includesEast] = output.split(" ").map(Number);
  assert.equal(includesWest, 1);
  assert.equal(includesEast, 1);
  assert.ok(count < 80, `wrapped cap produced ${count} candidates`);
});

test("closed-form nadir look geometry bounds the ground footprint", () => {
  const output = compileAndRun(String.raw`
#include <iostream>
#include "sensor_coverage_core.h"
#include "sensor_coverage_core.cpp.inc"

int main() {
  using namespace sdn::coverage;
  const double earth = 6356752.3142451793;
  const double observer = earth + 500000.0;
  const double nadir = conservativeGroundCapRadiusDeg(
    observer, earth, 12.5);
  const double horizonLook = std::asin(earth / observer) *
    57.295779513082320877;
  const double limb = conservativeGroundCapRadiusDeg(
    observer, earth, horizonLook + 0.1);
  const double horizon = std::acos(earth / observer) *
    57.295779513082320877;
  std::cout << nadir << " " << limb << " " << horizon;
}
`);

  const [nadir, limb, horizon] = output.split(" ").map(Number);
  assert.ok(nadir > 0.5 && nadir < 3, `unexpected nadir cap ${nadir}`);
  assert.ok(Math.abs(limb - horizon) < 1e-4);
});

test("production coverage uses candidate cells before exact visibility", () => {
  const source = readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const firstOverload = source.indexOf(
    "void accumulate_grid_coverage_products",
  );
  const statistics = source.indexOf("void merge_intervals", firstOverload);
  const accumulationSource = source.slice(firstOverload, statistics);

  assert.match(source, /appendSphericalCapCandidates\(/);
  assert.match(source, /conservativeGroundCapRadiusDeg\(/);
  assert.match(accumulationSource, /append_sensor_cap_candidates\(/);
  assert.match(accumulationSource, /candidate_cell_indices/);
  assert.match(accumulationSource, /append_refined_visibility_intervals\(/);
  assert.doesNotMatch(
    accumulationSource,
    /for \(int row = 0; row < grid\.rows; \+\+row\)[\s\S]*for \(int column = 0; column < grid\.columns; \+\+column\)/,
  );
});

test("module build opts into the reusable sensor coverage C++ core", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const buildSource = readFileSync(
    new URL("../../../scripts/build-sdk-compiled-module.mjs", import.meta.url),
    "utf8",
  );

  assert.deepEqual(packageJson.sdnModuleCompile.sharedCppSources, [
    "common/sensor_coverage_core.h",
    "common/sensor_coverage_core.cpp.inc",
  ]);
  assert.match(buildSource, /sharedCppSources/);
  assert.match(buildSource, /resolveSharedCppSources/);
});

test("sensor-local boundary directions are cached outside the state loop", () => {
  const source = readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const footprintStart = source.indexOf("FootprintSample compute_footprint");
  const footprintStop = source.indexOf(
    "std::vector<FootprintSample> compute_footprints",
    footprintStart,
  );
  const footprintSource = source.slice(footprintStart, footprintStop);

  assert.match(source, /localBoundaryDirections/);
  assert.match(source, /initialize_sensor_boundary_directions/);
  assert.doesNotMatch(footprintSource, /generate_sensor_boundary_directions\(/);
});

test("swept grid candidate caps reuse resolved state-segment endpoints", () => {
  const source = readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const accumulationStart = source.indexOf(
    "void accumulate_grid_coverage_products_range",
  );
  const accumulationStop = source.indexOf(
    "void accumulate_grid_coverage_products(",
    accumulationStart + 1,
  );
  const accumulationSource = source.slice(accumulationStart, accumulationStop);

  assert.match(accumulationSource, /resolve_visibility_states\(track\.states\)/);
  assert.match(accumulationSource, /const ResolvedVisibilityState& start_resolved/);
  assert.match(accumulationSource, /const ResolvedVisibilityState& stop_resolved/);
  assert.match(
    accumulationSource,
    /append_sensor_cap_candidates\(\s*seg_start,\s*seg_stop/,
  );
  assert.doesNotMatch(accumulationSource, /midpoint_resolved/);
  assert.doesNotMatch(
    accumulationSource,
    /resolve_visibility_state\((?:start|stop)_resolved\.state\)/,
  );
});

test("production grid bounds use closed-form sensor caps before limb fallback", () => {
  const source = readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const accumulationStart = source.indexOf(
    "void accumulate_grid_coverage_products_range",
  );
  const accumulationStop = source.indexOf(
    "void accumulate_grid_coverage_products(",
    accumulationStart + 1,
  );
  const accumulationSource = source.slice(accumulationStart, accumulationStop);

  assert.match(source, /conservativeGroundCapRadiusDeg\(/);
  assert.match(source, /maxBoundaryAngleRad/);
  assert.match(accumulationSource, /append_sensor_cap_candidates\(/);
  assert.doesNotMatch(accumulationSource, /endpoint_candidate_bounds/);
});
