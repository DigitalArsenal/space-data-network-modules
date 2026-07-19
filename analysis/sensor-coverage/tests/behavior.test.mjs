import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  createStandaloneHarnessOrSkip,
  invokeBinaryRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const MANIFEST = JSON.parse(
  fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"),
);
const SENSOR_COVERAGE_RUNTIME_KINDS = Object.freeze(
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
  scvGeometryEncoding,
  scvIntervalCategory,
  scvMetricSeriesKind,
  scvRasterProductEncoding,
  scvRasterProductKind,
  scvSensorRangeBoundaryKind,
  scvResultState,
  scvSensorShapeKind,
} = await import(pathToFileURL(`${STANDARDS_ROOT}/lib/js/SCV/main.js`).href);
const {
  SENSOR_SHAPE_CONFORMANCE_VECTORS,
} = await import(
  pathToFileURL(
    `${STANDARDS_ROOT}/test/fixtures/scvSensorShapeConformanceVectors.mjs`,
  ).href
);
const WGS84_A = 6378137.0;
const WGS84_B = 6356752.3142451793;
const WGS84_E2 = 1.0 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
const SENSOR_COVERAGE_METHOD_ID = "compute_sensor_coverage";
const SENSOR_COVERAGE_PORT_ID = "coverage";
const SENSOR_COVERAGE_TYPE_REF = Object.freeze({
  schemaName: "SCV/main.fbs",
  fileIdentifier: "$SCV",
  rootTypeName: "SCV",
});

test("sensor coverage source delegates SCV shape semantics to the shared sensor model core", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const visibilityStart = source.indexOf("bool surface_sample_visible_from_resolved_state");
  const visibilityStop = source.indexOf("bool cell_visible_from_resolved_state", visibilityStart);
  assert.notEqual(visibilityStart, -1);
  assert.notEqual(visibilityStop, -1);
  const visibilitySource = source.slice(visibilityStart, visibilityStop);

  assert.match(source, /#include "sensor_shape_model\.h"/);
  assert.match(source, /#include "sensor_shape_model\.cpp\.inc"/);
  assert.match(source, /#include "SCV\/main_generated\.h"/);
  assert.match(source, /parse_sensor_shape_contract\(sensor\)/);
  assert.match(source, /sensor->SHAPE_CONTRACT\(\)/);
  assert.doesNotMatch(source, /sensor->SHAPE\(\)/);
  // local_look_inside is the shared model's lean containment predicate —
  // same delegation, minus per-call contract re-parse/label copies.
  assert.match(source, /(classify_local_look|local_look_inside)\(/);
  assert.match(source, /generate_sensor_boundary_directions\(/);
  assert.match(source, /scvSensorShapeKind_SAR_ANNULAR_SECTOR/);
  assert.match(source, /scvSensorShapeKind_CUSTOM_POLYGON/);
  assert.match(visibilitySource, /(classify_local_look|local_look_inside)\(/);
  assert.doesNotMatch(visibilitySource, /sensor\.type == "rectangular"/);
  assert.doesNotMatch(visibilitySource, /std::cos\(sensor\.outerHalfAngleRad\)/);
  assert.doesNotMatch(source, /\buses_full_clock_solid_conic_fast_bounds\b/);
  assert.doesNotMatch(source, /\bnadir_conic_footprint_angular_radius_rad\b/);
  assert.doesNotMatch(source, /\bnadir_conic_candidate_window\b/);
  assert.doesNotMatch(source, /\bcell_matches_nadir_conic_candidate_filter\b/);
});

test("sensor coverage source rejects non-SCV invocation at the FlatBuffer boundary", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const parseStart = source.indexOf("bool parse_coverage_input");
  const parseStop = source.indexOf("CellBounds cell_bounds_for", parseStart);
  assert.notEqual(parseStart, -1);
  assert.notEqual(parseStop, -1);
  const parseSource = source.slice(parseStart, parseStop);

  assert.match(parseSource, /must contain an SDS SCV FlatBuffer/i);
  assert.doesNotMatch(parseSource, /parse_grid\(payload\)/);
  assert.doesNotMatch(parseSource, /parse_sensor_tracks\(payload\)/);
  assert.doesNotMatch(source, /\bGridConfig parse_grid\(/);
  assert.doesNotMatch(source, /\bSensorConfig parse_sensor_config\(/);
  assert.doesNotMatch(source, /\bSensorConfig parse_sensor\(/);
  assert.doesNotMatch(source, /\bstd::vector<SensorTrack> parse_sensor_tracks\(/);
});

test("sensor coverage tests resolve only canonical spacedatastandards.org bindings", () => {
  const source = fs.readFileSync(new URL(import.meta.url), "utf8");
  const resolverStart = source.lastIndexOf("function resolveStandardsRoot()");
  const resolverStop = source.indexOf("function createScvShapeContractCoveragePayload", resolverStart);
  assert.notEqual(resolverStart, -1);
  assert.notEqual(resolverStop, -1);
  const resolverSource = source.slice(resolverStart, resolverStop);

  assert.match(resolverSource, /spacedatastandards\.org/);
  assert.doesNotMatch(resolverSource, /sds-wasm-module-architecture/);
});

test("sensor coverage source does not preserve polygon-swath analytics accumulation", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /\bbool point_in_polygon\(/);
  assert.doesNotMatch(source, /\bvoid accumulate_swaths\(/);
  assert.doesNotMatch(source, /point_in_polygon\(/);
  assert.doesNotMatch(source, /accumulate_swaths\(/);
});

test("sensor coverage FOM products use a grid-first exact visibility kernel", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const computeStart = source.indexOf("extern \"C\" int compute_sensor_coverage");
  const computeSource = source.slice(computeStart);
  const kernelStart = source.indexOf("void accumulate_grid_coverage_products");
  const kernelStop = source.indexOf("void merge_intervals");
  assert.notEqual(computeStart, -1);
  assert.notEqual(kernelStart, -1);
  assert.notEqual(kernelStop, -1);
  const kernelSource = source.slice(kernelStart, kernelStop);

  assert.match(source, /struct GridCellGeometry/);
  assert.match(source, /Vec3 surfacePosition/);
  assert.match(source, /Vec3 surfaceNormal/);
  assert.match(source, /bool cell_visible_from_state/);
  assert.match(source, /VisibilityInterval refined_visibility_interval/);
  assert.match(computeSource, /accumulate_grid_coverage_products\(\*cells, tracks, swaths, grid\)/);
  assert.doesNotMatch(computeSource, /accumulate_swaths\(cells, swaths, grid\)/);
  assert.doesNotMatch(kernelSource, /point_in_polygon/);
});

test("sensor coverage grid products bypass rendered swaths and broad-phase state windows", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const kernelStart = source.indexOf("void accumulate_grid_coverage_products");
  const kernelStop = source.indexOf("void merge_intervals");
  assert.notEqual(kernelStart, -1);
  assert.notEqual(kernelStop, -1);
  const kernelSource = source.slice(kernelStart, kernelStop);

  assert.doesNotMatch(kernelSource, /find_swath_segment/);
  assert.doesNotMatch(kernelSource, /index_swaths_by_sensor/);
  assert.match(kernelSource, /static_cast<void>\(swaths\);/);
  assert.match(kernelSource, /append_sensor_cap_candidates\(/);
  assert.match(kernelSource, /append_refined_visibility_intervals\(/);
});

test("sensor coverage metric-product path goes directly to exact visibility without local footprint candidates", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const computeStart = source.indexOf("extern \"C\" int compute_sensor_coverage");
  const directKernelStart = source.indexOf(
    "void accumulate_grid_coverage_products(\n    std::vector<Cell>& cells,\n    const std::vector<SensorTrack>& tracks,\n    const GridConfig& grid)",
  );
  const directKernelStop = source.indexOf("void merge_intervals", directKernelStart);
  assert.notEqual(computeStart, -1);
  assert.notEqual(directKernelStart, -1);
  assert.notEqual(directKernelStop, -1);
  const computeSource = source.slice(computeStart);
  const directKernelSource = source.slice(directKernelStart, directKernelStop);

  assert.match(source, /accumulate_grid_coverage_products\(\*cells, tracks, grid\)/);
  assert.match(computeSource, /if \(!metric_product_output\)/);
  assert.match(computeSource, /if \(metric_product_output\) \{\s+accumulate_grid_coverage_products\(\*cells, tracks, grid\);/);
  assert.doesNotMatch(
    directKernelSource,
    /compute_footprints\(track\.states, track\.sensor\)/,
  );
  assert.doesNotMatch(directKernelSource, /build_swath_segments\(track_footprints\)/);
});

test("sensor coverage module source does not serialize FOM products as SCV time-series vectors", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /SCVTimeSeriesPoint/);
  assert.doesNotMatch(source, /CreateSCVTimeSeriesPoint/);
  assert.doesNotMatch(source, /\btime_series\b/);
  assert.doesNotMatch(source, /&time_series/);
});

test("sensor coverage module source does not serialize cell or interval object vectors", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /std::vector<flatbuffers::Offset<SCVCellStat>>/);
  assert.doesNotMatch(source, /std::vector<flatbuffers::Offset<SCVInterval>>/);
  assert.doesNotMatch(source, /CreateSCVCellStat/);
  assert.doesNotMatch(source, /CreateSCVInterval/);
  assert.doesNotMatch(source, /&cell_stats/);
  assert.doesNotMatch(source, /&intervals/);
});

test("sensor coverage module source does not serialize latitude-band object vectors", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /std::vector<flatbuffers::Offset<SCVLatitudeBandStat>>/);
  assert.doesNotMatch(source, /CreateSCVLatitudeBandStat/);
  assert.doesNotMatch(source, /&latitude_bands/);
});

test("sensor coverage uses conservative candidates before the exact visibility kernel", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const directKernelStart = source.indexOf(
    "void accumulate_grid_coverage_products_range",
  );
  const directKernelStop = source.indexOf("void merge_intervals", directKernelStart);
  assert.notEqual(directKernelStart, -1);
  assert.notEqual(directKernelStop, -1);
  const directKernelSource = source.slice(directKernelStart, directKernelStop);

  assert.match(source, /conservativeGroundCapRadiusDeg\(/);
  assert.match(directKernelSource, /append_sensor_cap_candidates\(/);
  assert.match(directKernelSource, /for \(const uint32_t cell_index : candidate_cell_indices\)/);
  assert.doesNotMatch(directKernelSource, /for \(int row = 0; row < grid\.rows; \+\+row\)/);
  assert.doesNotMatch(directKernelSource, /for \(int column = 0; column < grid\.columns; \+\+column\)/);
  assert.ok(
    directKernelSource.indexOf("ensure_cell_geometry(cell, grid)") <
      directKernelSource.indexOf("refined_visibility_interval"),
    "every candidate cell must reach exact shared-core interval refinement after geometry is available",
  );
});

test("sensor coverage grid cells carry cached tile and surface-unit metadata", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const createStart = source.indexOf("std::vector<Cell> create_cells");
  const createStop = source.indexOf("void ensure_cell_geometry", createStart);
  assert.notEqual(createStart, -1);
  assert.notEqual(createStop, -1);
  const createSource = source.slice(createStart, createStop);

  assert.match(source, /constexpr int kGridTileRowSpan = 8;/);
  assert.match(source, /constexpr int kGridTileColumnSpan = 8;/);
  assert.match(source, /struct CellBounds/);
  assert.match(source, /int tileId = 0;/);
  assert.doesNotMatch(source, /double angularRadiusRad = 0.0;/);
  assert.doesNotMatch(source, /double cosAngularRadius = 1.0;/);
  assert.doesNotMatch(source, /double sinAngularRadius = 0.0;/);
  assert.match(source, /CellBounds cell_bounds_for\(int row, int column, const GridConfig& grid\)/);
  assert.match(createSource, /cell\.bounds = cell_bounds_for\(row, column, grid\);/);
  assert.match(createSource, /cell\.surfaceUnit = cell\.bounds\.centerUnit;/);
  assert.doesNotMatch(source, /cos_expanded_radius/);
  assert.doesNotMatch(source, /cell_matches_nadir_conic_candidate_filter/);
});

test("sensor coverage exact grid geometry is built lazily for candidate cells", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const createStart = source.indexOf("std::vector<Cell> create_cells");
  const createStop = source.indexOf("void ensure_cell_geometry", createStart);
  const kernelStart = source.indexOf(
    "void accumulate_grid_coverage_products_range",
  );
  const kernelStop = source.indexOf("void merge_intervals", kernelStart);
  assert.notEqual(createStart, -1);
  assert.notEqual(createStop, -1);
  assert.notEqual(kernelStart, -1);
  assert.notEqual(kernelStop, -1);
  const createSource = source.slice(createStart, createStop);
  const kernelSource = source.slice(kernelStart, kernelStop);

  assert.match(source, /bool geometryReady = false;/);
  assert.match(source, /bool surfaceUnitReady = false;/);
  assert.match(source, /void ensure_cell_geometry\(Cell& cell, const GridConfig& grid\)/);
  assert.doesNotMatch(source, /Vec3 cell_surface_unit\(Cell& cell\)/);
  assert.doesNotMatch(createSource, /grid_cell_geometry/);
  assert.match(kernelSource, /candidate_cell_indices/);
  assert.match(kernelSource, /for \(const uint32_t cell_index : candidate_cell_indices\)/);
  assert.match(kernelSource, /ensure_cell_geometry\(cell, grid\)/);
  assert.ok(
    kernelSource.indexOf("ensure_cell_geometry(cell, grid)") <
      kernelSource.indexOf("refined_visibility_interval"),
    "exact geometry must be built before exact interval refinement",
  );
});

test("sensor coverage caches immutable grid cells across analysis windows", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const computeStart = source.indexOf("extern \"C\" int compute_sensor_coverage");
  assert.notEqual(computeStart, -1);
  const computeSource = source.slice(computeStart);

  assert.match(source, /constexpr size_t kGridCellCacheMaxEntries = 4;/);
  assert.match(source, /struct CachedGridCells/);
  assert.match(source, /std::string grid_cache_key\(const GridConfig& grid\)/);
  assert.match(source, /void reset_cell_accumulators\(Cell& cell\)/);
  assert.match(source, /std::vector<Cell>& cached_grid_cells_for\(const GridConfig& grid\)/);
  assert.match(source, /reset_cell_accumulators\(cell\);/);
  assert.match(computeSource, /std::vector<Cell>\* cells = nullptr;/);
  assert.match(computeSource, /cells = &cached_grid_cells_for\(grid\);/);
  assert.doesNotMatch(computeSource, /create_cells\(grid\)/);
});

test("sensor coverage retains at most one generation of module output regions", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const computeStart = source.indexOf("extern \"C\" int compute_sensor_coverage");
  assert.notEqual(computeStart, -1);
  const computeSource = source.slice(computeStart);

  assert.match(source, /g_retained_output_allocations/);
  assert.match(source, /void release_retained_output_allocations\(\)/);
  assert.match(computeSource, /release_retained_output_allocations\(\);/);
  assert.match(source, /g_retained_output_allocations = std::move\(output_allocations\);/);
});

test("sensor coverage exact visibility reuses resolved endpoints and root state interpolation", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const intervalStart = source.indexOf("VisibilityInterval refined_visibility_interval");
  const intervalStop = source.indexOf("std::map<int, std::vector<const SwathSegment*>>", intervalStart);
  const directKernelStart = source.indexOf(
    "void accumulate_grid_coverage_products_range",
  );
  const directKernelStop = source.indexOf("void merge_intervals", directKernelStart);
  assert.notEqual(intervalStart, -1);
  assert.notEqual(intervalStop, -1);
  assert.notEqual(directKernelStart, -1);
  assert.notEqual(directKernelStop, -1);
  const intervalSource = source.slice(intervalStart, intervalStop);
  const directKernelSource = source.slice(directKernelStart, directKernelStop);
  const resolvedIndex = directKernelSource.indexOf(
    "const std::vector<ResolvedVisibilityState> resolved_states =",
  );
  const candidateLoopIndex = directKernelSource.indexOf(
    "for (const uint32_t cell_index : candidate_cell_indices)",
  );

  assert.match(source, /struct ResolvedVisibilityState/);
  assert.match(source, /ResolvedVisibilityState resolve_visibility_state\(const State& state\)/);
  assert.match(source, /std::vector<ResolvedVisibilityState> resolve_visibility_states/);
  assert.match(source, /bool cell_visible_from_resolved_state/);
  assert.notEqual(resolvedIndex, -1);
  assert.notEqual(candidateLoopIndex, -1);
  assert.ok(
    resolvedIndex < candidateLoopIndex,
    "endpoint frames must be resolved before iterating candidate cells",
  );
  assert.match(directKernelSource, /const ResolvedVisibilityState& start_resolved = resolved_states\[state_index\];/);
  assert.match(directKernelSource, /const ResolvedVisibilityState& stop_resolved = resolved_states\[state_index \+ 1\];/);
  assert.match(
    intervalSource,
    /cell_visible_from_resolved_state\(\s*cell,\s*sensor,\s*interval_start\)/,
  );
  assert.match(
    intervalSource,
    /cell_visible_from_resolved_state\(\s*cell,\s*sensor,\s*interval_stop\)/,
  );
  assert.match(
    intervalSource,
    /interpolate_state\(\s*interpolation_start\.state,\s*interpolation_stop\.state/,
  );
  assert.doesNotMatch(intervalSource, /resolve_sensor_frame/);
});

test("sensor coverage exact visibility only probes midpoint after endpoint checks", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const intervalStart = source.indexOf("VisibilityInterval refined_visibility_interval");
  const intervalStop = source.indexOf("std::map<int, std::vector<const SwathSegment*>>", intervalStart);
  assert.notEqual(intervalStart, -1);
  assert.notEqual(intervalStop, -1);
  const intervalSource = source.slice(intervalStart, intervalStop);
  const midpointIndex = intervalSource.indexOf("visible_mid");
  const endpointExitIndex = intervalSource.indexOf("if (!visible_start && visible_stop)");
  assert.notEqual(midpointIndex, -1);
  assert.notEqual(endpointExitIndex, -1);
  assert.ok(
    midpointIndex > endpointExitIndex,
    "midpoint visibility should only be evaluated after endpoint-only cases",
  );
});

test("sensor coverage transition refinement has an explicit bounded accuracy budget", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const transitionStart = source.indexOf("double refined_transition_time");
  const transitionStop = source.indexOf("VisibilityInterval refined_visibility_interval", transitionStart);
  assert.notEqual(transitionStart, -1);
  assert.notEqual(transitionStop, -1);
  const transitionSource = source.slice(transitionStart, transitionStop);

  assert.match(source, /constexpr int kVisibilityTransitionRefinementIterations = 8;/);
  assert.match(transitionSource, /iteration < kVisibilityTransitionRefinementIterations/);
  assert.doesNotMatch(transitionSource, /iteration < 12/);
});

function decodeScvFrames(response) {
  return response.outputs
    .filter((frame) => frame.typeRef?.fileIdentifier === "$SCV")
    .map((frame) => {
      const byteBuffer = new flatbuffers.ByteBuffer(frame.payload);
      assert.equal(SCV.bufferHasIdentifier(byteBuffer), true);
      return {
        frame,
        envelope: SCV.getRootAsSCV(byteBuffer),
      };
    });
}

function findScvEnvelope(response, envelopeKind) {
  return decodeScvFrames(response).find(
    ({ envelope }) => envelope.ENVELOPE_KIND() === envelopeKind,
  );
}

function assertSharedMemoryBuffer(memoryBuffer) {
  assert.ok(
    typeof SharedArrayBuffer === "function" &&
      memoryBuffer instanceof SharedArrayBuffer,
    "module product regions must reference SharedArrayBuffer-backed WASM memory",
  );
}

function regionDescriptors(owner) {
  const regions = new Map();
  const length = owner.memoryRegionsLength();
  for (let index = 0; index < length; index += 1) {
    const region = owner.MEMORY_REGIONS(index);
    assert.ok(region, `SCV memory region ${index} is missing`);
    assert.equal(region.SHARED(), true, "SCV memory regions must be shared");
    assert.equal(region.MUTABLE(), false, "SCV product regions must be immutable");
    assert.ok(region.BYTE_OFFSET() > 0n, "SCV memory region offset must be non-zero");
    assert.ok(region.BYTE_LENGTH() > 0n, "SCV memory region length must be non-zero");
    assert.ok(region.ALIGNMENT() >= 4, "SCV memory region alignment must be declared");
    regions.set(`${region.REGION_ID()}:${region.RECORD_INDEX()}`, region);
  }
  return regions;
}

function regionTypedArray(memoryBuffer, region, ArrayCtor, expectedLength, name) {
  assertSharedMemoryBuffer(memoryBuffer);
  const byteOffset = Number(region.BYTE_OFFSET());
  const byteLength = Number(region.BYTE_LENGTH());
  assert.equal(
    byteLength,
    expectedLength * ArrayCtor.BYTES_PER_ELEMENT,
    `${name} region byte length must match element count`,
  );
  assert.equal(
    byteOffset % ArrayCtor.BYTES_PER_ELEMENT,
    0,
    `${name} region must be aligned to its element width`,
  );
  return new ArrayCtor(memoryBuffer, byteOffset, expectedLength);
}

function regionFor(regions, regionId, recordIndex, name) {
  const region = regions.get(`${regionId}:${recordIndex}`);
  assert.ok(region, `${name} must reference a declared SCV memory region`);
  return region;
}

function assertRenderableScvGeometry(result, expectedSegments, memoryBuffer) {
  const geometry = result.GEOMETRY();
  assert.ok(geometry, "SCV result must include packed geometry for rendering");
  assert.equal(geometry.WINDOW_COUNT(), expectedSegments);
  assert.equal(geometry.segmentsLength(), expectedSegments);
  assert.equal(geometry.ENCODING(), scvGeometryEncoding.SHARED_MEMORY_OFFSET);
  assert.equal(geometry.positionsLength(), 0);
  assert.equal(geometry.normalsLength(), 0);
  assert.equal(geometry.stLength(), 0);
  assert.equal(geometry.revealCoordsLength(), 0);
  assert.equal(geometry.indicesLength(), 0);
  assert.ok(
    geometry.memoryRegionsLength() >= 5,
    "SCV geometry must declare module-owned regions for positions, normals, ST, reveal coordinates, and indices",
  );
  const firstSegment = geometry.SEGMENTS(0);
  assert.ok(firstSegment, "SCV geometry must include segment descriptors");
  assert.equal(firstSegment.VERTEX_COUNT(), 4);
  assert.equal(firstSegment.INDEX_COUNT(), 6);
  assert.equal(firstSegment.START_OFFSET_SEC(), 0);
  const regions = regionDescriptors(geometry);
  const positions = regionTypedArray(
    memoryBuffer,
    regionFor(regions, geometry.POSITIONS_REGION_ID(), geometry.POSITIONS_RECORD_INDEX(), "POSITIONS"),
    Float32Array,
    expectedSegments * 12,
    "POSITIONS",
  );
  const normals = regionTypedArray(
    memoryBuffer,
    regionFor(regions, geometry.NORMALS_REGION_ID(), geometry.NORMALS_RECORD_INDEX(), "NORMALS"),
    Float32Array,
    expectedSegments * 12,
    "NORMALS",
  );
  const sts = regionTypedArray(
    memoryBuffer,
    regionFor(regions, geometry.ST_REGION_ID(), geometry.ST_RECORD_INDEX(), "ST"),
    Float32Array,
    expectedSegments * 8,
    "ST",
  );
  const indices = regionTypedArray(
    memoryBuffer,
    regionFor(regions, geometry.INDICES_REGION_ID(), geometry.INDICES_RECORD_INDEX(), "INDICES"),
    Uint32Array,
    expectedSegments * 6,
    "INDICES",
  );
  assert.equal(indices[0], 0);
  assert.equal(indices[5], 3);
  for (let index = 0; index < positions.length; index++) {
    assert.ok(
      Number.isFinite(positions[index]),
      `SCV geometry POSITIONS[${index}] must be finite`,
    );
  }
  for (let index = 0; index < normals.length; index += 3) {
    const normalMagnitude = Math.hypot(
      normals[index],
      normals[index + 1],
      normals[index + 2],
    );
    assert.ok(
      Math.abs(normalMagnitude - 1) < 1.0e-3,
      `SCV geometry normal ${index / 3} must be unit length`,
    );
  }
  for (let index = 0; index < sts.length; index++) {
    const value = sts[index];
    assert.ok(
      value >= 0 && value <= 1,
      `SCV geometry ST[${index}] must be normalized`,
    );
  }
}

function assertPackedScvRasterProducts(result, expected, memoryBuffer) {
  assert.equal(
    typeof result.RASTER_PRODUCTS,
    "function",
    "SCVResult must expose generated RASTER_PRODUCTS accessor",
  );
  const rasterProducts = result.RASTER_PRODUCTS();
  assert.ok(
    rasterProducts,
    "SCV result must include module-authored packed raster products",
  );
  assert.equal(rasterProducts.CELL_COUNT(), expected.cellCount);
  assert.equal(rasterProducts.ROWS(), expected.rows);
  assert.equal(rasterProducts.COLUMNS(), expected.columns);
  assert.equal(rasterProducts.BUCKET_COUNT(), expected.bucketCount);
  assert.equal(rasterProducts.WORDS_PER_BUCKET(), expected.wordsPerBucket);
  assert.ok(
    rasterProducts.bandsLength() >= expected.minimumBandCount,
    `expected at least ${expected.minimumBandCount} packed raster bands`,
  );
  assert.ok(
    rasterProducts.memoryRegionsLength() >= expected.minimumBandCount,
    "SCV raster products must declare module-owned memory regions for every packed band",
  );
  const regions = regionDescriptors(rasterProducts);
  for (let index = 0; index < rasterProducts.bandsLength(); index += 1) {
    const band = rasterProducts.BANDS(index);
    assert.ok(band, `SCV raster band ${index} is missing`);
    assert.ok(band.MEMORY_REGION_ID() > 0, "SCV raster bands must reference memory regions");
    assert.equal(band.float32ValuesLength(), 0);
    assert.equal(band.float64ValuesLength(), 0);
    assert.equal(band.uint32ValuesLength(), 0);
    regionFor(
      regions,
      band.MEMORY_REGION_ID(),
      band.MEMORY_RECORD_INDEX(),
      `raster band ${band.PRODUCT_KIND()}`,
    );
  }
  if (memoryBuffer) {
    assertSharedMemoryBuffer(memoryBuffer);
  }
  return rasterProducts;
}

function scvRasterBand(result, productKind) {
  const rasterProducts = result.RASTER_PRODUCTS();
  assert.ok(rasterProducts, "SCV result must include packed raster products");
  for (let index = 0; index < rasterProducts.bandsLength(); index += 1) {
    const band = rasterProducts.BANDS(index);
    if (band.PRODUCT_KIND() === productKind) {
      return band;
    }
  }
  assert.fail(`missing packed raster band ${productKind}`);
}

function scvRasterBandValues(result, productKind, memoryBuffer) {
  const rasterProducts = result.RASTER_PRODUCTS();
  const regions = regionDescriptors(rasterProducts);
  const band = scvRasterBand(result, productKind);
  const region = regionFor(
    regions,
    band.MEMORY_REGION_ID(),
    band.MEMORY_RECORD_INDEX(),
    `raster band ${productKind}`,
  );
  if (band.ENCODING() === scvRasterProductEncoding.FLOAT32) {
    return regionTypedArray(
      memoryBuffer,
      region,
      Float32Array,
      band.CELL_COUNT() * Math.max(1, band.COMPONENTS_PER_CELL()),
      `raster band ${productKind}`,
    );
  }
  if (band.ENCODING() === scvRasterProductEncoding.FLOAT64) {
    const componentCount = Math.max(1, band.COMPONENTS_PER_CELL());
    const recordCount = band.BUCKET_COUNT() > 0 ? band.BUCKET_COUNT() : band.CELL_COUNT();
    return regionTypedArray(
      memoryBuffer,
      region,
      Float64Array,
      recordCount * componentCount,
      `raster band ${productKind}`,
    );
  }
  if (
    band.ENCODING() === scvRasterProductEncoding.UINT32 ||
    band.ENCODING() === scvRasterProductEncoding.BITSET_UINT32
  ) {
    const recordCount =
      band.BUCKET_COUNT() > 0
        ? band.BUCKET_COUNT() * Math.max(1, band.WORDS_PER_BUCKET())
        : band.CELL_COUNT() * Math.max(1, band.COMPONENTS_PER_CELL());
    return regionTypedArray(
      memoryBuffer,
      region,
      Uint32Array,
      recordCount,
      `raster band ${productKind}`,
    );
  }
  if (band.ENCODING() === scvRasterProductEncoding.UINT8) {
    const recordCount =
      band.BUCKET_COUNT() > 0
        ? band.BUCKET_COUNT() * band.CELL_COUNT()
        : band.CELL_COUNT();
    return regionTypedArray(
      memoryBuffer,
      region,
      Uint8Array,
      recordCount * Math.max(1, band.COMPONENTS_PER_CELL()),
      `raster band ${productKind}`,
    );
  }
  assert.fail(`unsupported raster band encoding ${band.ENCODING()}`);
}

function assertTypedAggregateStatistics(result) {
  const statistics = result.AGGREGATE_STATISTICS();
  assert.ok(statistics, "SCV result must include typed aggregate statistics");
  assert.equal(statistics.ACTIVE_SENSOR_COUNT(), result.TOTAL_SENSORS());
  assert.equal(statistics.TOTAL_WINDOWS(), result.TOTAL_WINDOWS());
  const rasterProducts = result.RASTER_PRODUCTS();
  if (rasterProducts) {
    assert.equal(statistics.TOTAL_CELLS(), rasterProducts.CELL_COUNT());
  }
  assert.ok(statistics.TOTAL_CELLS() >= 0);
  assert.ok(statistics.TOTAL_INTERVAL_COUNT() >= 0);
  assert.ok(Number.isFinite(statistics.TOTAL_ACCESS_DURATION_SEC()));
  assert.ok(Number.isFinite(statistics.TOTAL_GAP_DURATION_SEC()));
  assert.ok(Number.isFinite(statistics.MAX_GAP_DURATION_SEC()));
  assert.ok(Number.isFinite(statistics.MEAN_REVISIT_TIME_SEC()));
  assert.ok(Number.isFinite(statistics.MAX_RESPONSE_TIME_SEC()));
  assert.ok(Number.isFinite(statistics.MEAN_RESPONSE_TIME_SEC()));
  assert.ok(Number.isFinite(statistics.PERCENT_COVERAGE()));
  assert.doesNotMatch(
    result.MESSAGE() ?? "",
    /scv-summary|\"statistics\"|\"contract\"/,
    "SCV MESSAGE must be diagnostic text, not coverage-summary JSON",
  );
  return statistics;
}

function assertNoInlineScvCellOrIntervalVectors(result) {
  assert.equal(
    typeof result.cellStatsLength,
    "undefined",
    "SCV RESULT bindings must not expose inline per-cell statistic vectors",
  );
  assert.equal(
    typeof result.intervalsLength,
    "undefined",
    "SCV RESULT bindings must not expose inline access interval vectors",
  );
}

function assertNoInlineScvLatitudeBandVectors(result) {
  assert.equal(
    typeof result.latitudeBandsLength,
    "undefined",
    "SCV RESULT bindings must not expose inline latitude-band statistic vectors",
  );
}

function assertNoInlineScvTimeSeries(result) {
  assert.equal(
    typeof result.timeSeriesLength,
    "undefined",
    "SCV RESULT bindings must not expose inline FOM/current-access metric time-series vectors",
  );
}

function assertRasterBandMetricKind(result, productKind, metricKind) {
  const band = scvRasterBand(result, productKind);
  assert.equal(
    band.METRIC_KIND(),
    metricKind,
    `packed raster band ${productKind} must advertise requested metric kind`,
  );
  return band;
}

function assertRequestedPerCellRasterProducts(result, requestedProducts) {
  for (const product of requestedProducts) {
    if (product === scvMetricSeriesKind.PERCENT_COVERED) {
      assertRasterBandMetricKind(
        result,
        scvRasterProductKind.PERCENT_COVERAGE,
        product,
      );
    } else if (product === scvMetricSeriesKind.ACCESS_COUNT) {
      for (const productKind of [
        scvRasterProductKind.PASS_COUNT,
        scvRasterProductKind.PASS_COUNT_RGBA,
        scvRasterProductKind.CURRENT_ACCESS_BITSET,
        scvRasterProductKind.CURRENT_ACCESS_RGBA,
        scvRasterProductKind.BUCKET_ACTIVE_CELL_COUNT,
      ]) {
        assertRasterBandMetricKind(result, productKind, product);
      }
    } else if (product === scvMetricSeriesKind.CONTACT_DURATION_SECONDS) {
      assertRasterBandMetricKind(
        result,
        scvRasterProductKind.CONTACT_DURATION_SECONDS,
        product,
      );
    } else if (product === scvMetricSeriesKind.REVISIT_SECONDS) {
      assertRasterBandMetricKind(
        result,
        scvRasterProductKind.REVISIT_SECONDS,
        product,
      );
    } else if (product === scvMetricSeriesKind.GAP_SECONDS) {
      assertRasterBandMetricKind(
        result,
        scvRasterProductKind.GAP_SECONDS,
        product,
      );
    } else if (product === scvMetricSeriesKind.REDUNDANCY) {
      assertRasterBandMetricKind(
        result,
        scvRasterProductKind.REDUNDANCY,
        product,
      );
    }
  }
}

function scvPercentCoverageValues(result, memoryBuffer) {
  const rasterProducts = result.RASTER_PRODUCTS();
  assert.ok(rasterProducts, "SCV result must include packed raster products");
  const values = scvRasterBandValues(
    result,
    scvRasterProductKind.PERCENT_COVERAGE,
    memoryBuffer,
  );
  assert.equal(values.length, rasterProducts.CELL_COUNT());
  return values;
}

function scvCoveredCellCount(result, memoryBuffer) {
  return scvPercentCoverageValues(result, memoryBuffer).reduce(
    (total, value) => total + (value > 0 ? 1 : 0),
    0,
  );
}

function scvCoveredCellIds(result, memoryBuffer) {
  const ids = [];
  const values = scvPercentCoverageValues(result, memoryBuffer);
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] > 0) {
      ids.push(index);
    }
  }
  return ids;
}

function scvCoverageFractionTotal(result, memoryBuffer) {
  return scvPercentCoverageValues(result, memoryBuffer).reduce(
    (total, value) => total + value / 100.0,
    0,
  );
}

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

function createScvShapeContractCoveragePayload(shapeContract, options = {}) {
  const earthRadius = 6378137.0;
  const orbitRadius = earthRadius + 500000.0;
  const speed = 7612.608173223869;
  const makeState = (theta, elapsedSeconds) =>
    new SCVStateSampleT(
      3,
      elapsedSeconds,
      new SCVVec3T(
        orbitRadius * Math.cos(theta),
        orbitRadius * Math.sin(theta),
        0,
      ),
      new SCVVec3T(-speed * Math.sin(theta), speed * Math.cos(theta), 0),
      0,
      0,
      0,
      1,
      scvCoordinateFrame.BODY_FIXED,
    );
  const stateSamples = [
    makeState(-0.04, 0),
    makeState(0, 600),
    makeState(0.04, 1200),
  ].slice(0, options.stateSampleCount ?? 3);
  const request = new SCVCoverageRequestT(
    `shape-contract-${shapeContract.SHAPE_KIND}`,
    BigInt("303"),
    scvAnalysisMode.COVERAGE,
    new SCVEllipsoidT(
      scvBodyKind.EARTH,
      "Earth",
      earthRadius,
      6356752.314245,
      earthRadius,
      scvCoordinateFrame.BODY_FIXED,
    ),
    new SCVTimeGridT(null, 0, 0, 1200, 600, 0, 2),
    new SCVCoverageGridT(
      "shape-contract-grid",
      scvGeometryDomain.SURFACE,
      scvCoordinateFrame.BODY_FIXED,
      -10,
      10,
      -16,
      16,
      2,
      2,
      0,
      160,
      10,
    ),
    [
      new SCVSensorT(
        3,
        "sensor-shape-contract",
        "SCV shape contract sensor",
        scvCoordinateFrame.BODY_FIXED,
        null,
        null,
        null,
        null,
        shapeContract,
      ),
    ],
    stateSamples,
    [],
    [],
    [scvMetricSeriesKind.PERCENT_COVERED],
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

function solidConicContract() {
  return new SCVSensorShapeContractT(
    scvSensorShapeKind.CONIC,
    0,
    scvSensorRangeBoundaryKind.RADIAL_SPHERICAL,
    14,
    0,
    0,
    360,
    0,
    0,
    0,
    0,
    0,
    0,
    1600000,
  );
}

function radiansToDegrees(value) {
  return (value * 180.0) / Math.PI;
}

function conicShapeContract(outerHalfAngleRad = 0.22, maxRangeM = 1600000) {
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

function conformanceShapeContract(vector, radiusMeters = vector.shape.radiusMeters) {
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
      radiusMeters,
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
      radiusMeters,
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
      radiusMeters,
    );
  }
  throw new Error(`Unsupported conformance vector type: ${vector.type}`);
}

function createScvConformanceCoveragePayload(vector) {
  const earthRadius = 6378137.0;
  // The module clamps SCV grid resolution to 0.01 degrees, so scale the
  // 100 m local vectors uniformly while preserving their angular contracts.
  const coverageScale = 100.0;
  const sensorAltitudeM = 50.0 * coverageScale;
  const radiusMeters = vector.shape.radiusMeters * coverageScale;
  const sensorPosition = new SCVVec3T(earthRadius + sensorAltitudeM, 0, 0);
  const sensorVelocity = new SCVVec3T(0, 7600, 0);
  const makeState = (elapsedSeconds) =>
    new SCVStateSampleT(
      9,
      elapsedSeconds,
      sensorPosition,
      sensorVelocity,
      0,
      0,
      0,
      1,
      scvCoordinateFrame.BODY_FIXED,
    );
  const shapeContract = conformanceShapeContract(vector, radiusMeters);
  const request = new SCVCoverageRequestT(
    `shape-conformance-${vector.name}`,
    BigInt("909"),
    scvAnalysisMode.COVERAGE,
    new SCVEllipsoidT(
      scvBodyKind.EARTH,
      "Earth",
      earthRadius,
      6356752.314245,
      earthRadius,
      scvCoordinateFrame.BODY_FIXED,
    ),
    new SCVTimeGridT(null, 0, 0, 1, 1, 0, 1),
    new SCVCoverageGridT(
      "shape-conformance-grid",
      scvGeometryDomain.SURFACE,
      scvCoordinateFrame.BODY_FIXED,
      -0.025,
      0.025,
      -0.025,
      0.025,
      0.01,
      0.01,
      0,
      25,
      0.01,
    ),
    [
      new SCVSensorT(
        9,
        "sensor-shape-conformance",
        `SCV ${vector.name} conformance sensor`,
        scvCoordinateFrame.BODY_FIXED,
        null,
        null,
        null,
        null,
        shapeContract,
      ),
    ],
    [makeState(0), makeState(1)],
    [],
    [],
    [scvMetricSeriesKind.PERCENT_COVERED],
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

function createSingleSensorCoverageRequest() {
  const earthRadius = 6378137.0;
  const orbitRadius = earthRadius + 500000.0;
  const speed = 7612.608173223869;
  const makeState = (theta, elapsedSeconds) => ({
    elapsedSeconds,
    position: {
      x: orbitRadius * Math.cos(theta),
      y: orbitRadius * Math.sin(theta),
      z: 0,
    },
    velocity: {
      x: -speed * Math.sin(theta),
      y: speed * Math.cos(theta),
      z: 0,
    },
  });
  return {
    sensors: [
      {
        sensorId: 7,
        type: "conic",
        outerHalfAngleRad: 0.22,
        radiusMeters: 1600000,
        states: [
          makeState(-0.04, 0),
          makeState(0, 600),
          makeState(0.04, 1200),
        ],
      },
    ],
    grid: {
      minLatitudeDeg: -8,
      maxLatitudeDeg: 8,
      minLongitudeDeg: -12,
      maxLongitudeDeg: 12,
      latitudeStepDeg: 4,
      longitudeStepDeg: 4,
    },
    timeSpan: {
      startSeconds: 0,
      stopSeconds: 1200,
    },
    figureOfMerit: "percent_coverage",
  };
}

function createSeparatedContributorCoverageRequest() {
  const earthRadius = 6378137.0;
  const orbitRadius = earthRadius + 500000.0;
  const speed = 7612.608173223869;
  const makeState = (theta, elapsedSeconds) => ({
    elapsedSeconds,
    position: {
      x: orbitRadius * Math.cos(theta),
      y: orbitRadius * Math.sin(theta),
      z: 0,
    },
    velocity: {
      x: -speed * Math.sin(theta),
      y: speed * Math.cos(theta),
      z: 0,
    },
  });
  const firstPassStates = [
    makeState(-0.08, 0),
    makeState(-0.04, 600),
    makeState(0, 1200),
    makeState(0.04, 1800),
    makeState(0.08, 2400),
  ];
  const secondPassStates = [
    makeState(-0.08, 3600),
    makeState(-0.04, 4200),
    makeState(0, 4800),
    makeState(0.04, 5400),
    makeState(0.08, 6000),
  ];

  return {
    sensors: [
      {
        sensorId: 0,
        type: "conic",
        outerHalfAngleRad: 0.22,
        radiusMeters: 1600000,
        states: firstPassStates,
      },
      {
        sensorId: 33,
        type: "conic",
        outerHalfAngleRad: 0.22,
        radiusMeters: 1600000,
        states: secondPassStates,
      },
    ],
    grid: {
      minLatitudeDeg: -8,
      maxLatitudeDeg: 8,
      minLongitudeDeg: -12,
      maxLongitudeDeg: 12,
      latitudeStepDeg: 2,
      longitudeStepDeg: 2,
    },
    timeSpan: {
      startSeconds: 0,
      stopSeconds: 6000,
    },
    figureOfMerit: "percent_coverage",
  };
}

function geodeticToEcef(latitudeDeg, longitudeDeg, altitudeM = 0) {
  const latitude = latitudeDeg * (Math.PI / 180);
  const longitude = longitudeDeg * (Math.PI / 180);
  const sinLatitude = Math.sin(latitude);
  const cosLatitude = Math.cos(latitude);
  const sinLongitude = Math.sin(longitude);
  const cosLongitude = Math.cos(longitude);
  const normalRadius =
    WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLatitude * sinLatitude);
  return {
    x: (normalRadius + altitudeM) * cosLatitude * cosLongitude,
    y: (normalRadius + altitudeM) * cosLatitude * sinLongitude,
    z: (normalRadius * (1.0 - WGS84_E2) + altitudeM) * sinLatitude,
  };
}

function highLatitudeNadirState(latitudeDeg, longitudeDeg, elapsedSeconds) {
  const latitude = latitudeDeg * (Math.PI / 180);
  const longitude = longitudeDeg * (Math.PI / 180);
  const ground = geodeticToEcef(latitudeDeg, longitudeDeg, 0);
  const position = geodeticToEcef(latitudeDeg, longitudeDeg, 500000);
  const boresightLength = Math.hypot(
    ground.x - position.x,
    ground.y - position.y,
    ground.z - position.z,
  );
  const east = {
    x: -Math.sin(longitude),
    y: Math.cos(longitude),
    z: 0,
  };
  const north = {
    x: -Math.sin(latitude) * Math.cos(longitude),
    y: -Math.sin(latitude) * Math.sin(longitude),
    z: Math.cos(latitude),
  };
  return {
    elapsedSeconds,
    position,
    velocity: {
      x: 7612.608173223869 * east.x,
      y: 7612.608173223869 * east.y,
      z: 7612.608173223869 * east.z,
    },
    sensorFrame: {
      boresight: {
        x: (ground.x - position.x) / boresightLength,
        y: (ground.y - position.y) / boresightLength,
        z: (ground.z - position.z) / boresightLength,
      },
      xAxis: east,
      yAxis: north,
    },
  };
}

function createHighLatitudeWgs84CoverageRequest() {
  return {
    coverageSource: {
      brand: "OrbPro",
      mode: "WGS84 high-latitude nadir regression",
      attachedToPropagatedEntity: true,
      positionPropertyType: "PropagatedPositionProperty",
      sensorFrameSource: "entity.computeModelMatrix",
    },
    sensor: {
      sensorId: 11,
      type: "conic",
      outerHalfAngleRad: 0.04,
      radiusMeters: 1600000,
      angularSamples: 24,
    },
    states: [
      highLatitudeNadirState(60, -0.03, 0),
      highLatitudeNadirState(60, 0, 600),
      highLatitudeNadirState(60, 0.03, 1200),
    ],
    grid: {
      minLatitudeDeg: 58,
      maxLatitudeDeg: 62,
      minLongitudeDeg: -2,
      maxLongitudeDeg: 2,
      latitudeStepDeg: 0.5,
      longitudeStepDeg: 0.5,
    },
    timeSpan: {
      startSeconds: 0,
      stopSeconds: 1200,
    },
    figureOfMerit: "percent_coverage",
  };
}

function createScvCoverageRequestPayload({
  windowCount = 2,
  requestedProducts = [scvMetricSeriesKind.PERCENT_COVERED],
} = {}) {
  const earthRadius = 6378137.0;
  const orbitRadius = earthRadius + 500000.0;
  const speed = 7612.608173223869;
  const stepSeconds = 600;
  const makeState = (theta, elapsedSeconds) =>
    new SCVStateSampleT(
      7,
      elapsedSeconds,
      new SCVVec3T(
        orbitRadius * Math.cos(theta),
        orbitRadius * Math.sin(theta),
        0,
      ),
      new SCVVec3T(-speed * Math.sin(theta), speed * Math.cos(theta), 0),
      0,
      0,
      0,
      1,
      scvCoordinateFrame.BODY_FIXED,
    );
  const stateSamples = [];
  for (let index = 0; index <= windowCount; index++) {
    const fraction = windowCount > 0 ? index / windowCount : 0;
    stateSamples.push(makeState(-0.04 + 0.08 * fraction, index * stepSeconds));
  }
  const request = new SCVCoverageRequestT(
    "scv-request-test",
    BigInt("42"),
    undefined,
    new SCVEllipsoidT(
      scvBodyKind.EARTH,
      "Earth",
      earthRadius,
      6356752.314245,
      earthRadius,
      scvCoordinateFrame.BODY_FIXED,
    ),
    new SCVTimeGridT(null, 0, 0, windowCount * stepSeconds, stepSeconds, 0, windowCount),
    new SCVCoverageGridT(
      "regional-grid",
      scvGeometryDomain.SURFACE,
      scvCoordinateFrame.BODY_FIXED,
      -8,
      8,
      -12,
      12,
      4,
      4,
      0,
      24,
      4,
    ),
    [
      new SCVSensorT(
        7,
        "sensor-7",
        "SCV request sensor",
        scvCoordinateFrame.BODY_FIXED,
        null,
        null,
        null,
        null,
        conicShapeContract(0.22, 1600000),
      ),
    ],
    stateSamples,
    [],
    [],
    requestedProducts,
    0,
    0,
    0,
    0,
    undefined,
    true,
  );
  const envelope = new SCVT(scvEnvelopeKind.REQUEST, request);
  const builder = new flatbuffers.Builder(1024);
  SCV.finishSCVBuffer(builder, envelope.pack(builder));
  return builder.asUint8Array();
}

function createScvMetricProductCoverageRequestPayload({
  windowCount = 2,
  requestedProducts = [scvMetricSeriesKind.PERCENT_COVERED],
  grid = {
    minLatitudeDeg: -8,
    maxLatitudeDeg: 8,
    minLongitudeDeg: -12,
    maxLongitudeDeg: 12,
    latitudeStepDeg: 4,
    longitudeStepDeg: 4,
  },
} = {}) {
  const earthRadius = 6378137.0;
  const orbitRadius = earthRadius + 500000.0;
  const speed = 7612.608173223869;
  const stepSeconds = 600;
  const makeState = (theta, elapsedSeconds) =>
    new SCVStateSampleT(
      7,
      elapsedSeconds,
      new SCVVec3T(
        orbitRadius * Math.cos(theta),
        orbitRadius * Math.sin(theta),
        0,
      ),
      new SCVVec3T(-speed * Math.sin(theta), speed * Math.cos(theta), 0),
      0,
      0,
      0,
      1,
      scvCoordinateFrame.BODY_FIXED,
    );
  const stateSamples = [];
  for (let index = 0; index <= windowCount; index++) {
    const fraction = windowCount > 0 ? index / windowCount : 0;
    stateSamples.push(makeState(-0.04 + 0.08 * fraction, index * stepSeconds));
  }
  const rows = Math.ceil(
    (grid.maxLatitudeDeg - grid.minLatitudeDeg) / grid.latitudeStepDeg,
  );
  const columns = Math.ceil(
    (grid.maxLongitudeDeg - grid.minLongitudeDeg) / grid.longitudeStepDeg,
  );
  const request = new SCVCoverageRequestT(
    "scv-metric-product-test",
    BigInt("43"),
    scvAnalysisMode.COVERAGE,
    new SCVEllipsoidT(
      scvBodyKind.EARTH,
      "Earth",
      earthRadius,
      6356752.314245,
      earthRadius,
      scvCoordinateFrame.BODY_FIXED,
    ),
    new SCVTimeGridT(null, 0, 0, windowCount * stepSeconds, stepSeconds, 0, windowCount),
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
        7,
        "sensor-7",
        "SCV request sensor",
        scvCoordinateFrame.BODY_FIXED,
        null,
        null,
        null,
        null,
        conicShapeContract(0.22, 1600000),
      ),
    ],
    stateSamples,
    [],
    [],
    requestedProducts,
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

function createScvMultiSensorMetricProductCoverageRequestPayload({
  sensorCount = 16,
  windowCount = 5,
  requestedProducts = [scvMetricSeriesKind.ACCESS_COUNT],
} = {}) {
  const earthRadius = 6378137.0;
  const orbitRadius = earthRadius + 500000.0;
  const speed = 7612.608173223869;
  const stepSeconds = 10;
  const sensors = [];
  const stateSamples = [];
  for (let sensorIndex = 0; sensorIndex < sensorCount; sensorIndex++) {
    sensors.push(
      new SCVSensorT(
        sensorIndex,
        `sensor-${sensorIndex}`,
        `SCV multi-sensor request sensor ${sensorIndex}`,
        scvCoordinateFrame.BODY_FIXED,
        null,
        null,
        null,
        null,
        conicShapeContract(0.22, 1600000),
      ),
    );
    const phaseOffset = (sensorIndex / Math.max(1, sensorCount)) * 0.02;
    for (let index = 0; index <= windowCount; index++) {
      const fraction = windowCount > 0 ? index / windowCount : 0;
      const theta = -0.04 + 0.08 * fraction + phaseOffset;
      stateSamples.push(
        new SCVStateSampleT(
          sensorIndex,
          index * stepSeconds,
          new SCVVec3T(
            orbitRadius * Math.cos(theta),
            orbitRadius * Math.sin(theta),
            0,
          ),
          new SCVVec3T(-speed * Math.sin(theta), speed * Math.cos(theta), 0),
          0,
          0,
          0,
          1,
          scvCoordinateFrame.BODY_FIXED,
        ),
      );
    }
  }

  const request = new SCVCoverageRequestT(
    "scv-multi-sensor-metric-product-test",
    BigInt("44"),
    scvAnalysisMode.COVERAGE,
    new SCVEllipsoidT(
      scvBodyKind.EARTH,
      "Earth",
      earthRadius,
      6356752.314245,
      earthRadius,
      scvCoordinateFrame.BODY_FIXED,
    ),
    new SCVTimeGridT(
      null,
      0,
      0,
      windowCount * stepSeconds,
      stepSeconds,
      0,
      windowCount,
    ),
    new SCVCoverageGridT(
      "single-cell-grid",
      scvGeometryDomain.SURFACE,
      scvCoordinateFrame.BODY_FIXED,
      -2,
      2,
      -2,
      2,
      4,
      4,
      0,
      1,
      4,
    ),
    sensors,
    stateSamples,
    [],
    [],
    requestedProducts,
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

function createScvSwathPreviewCoverageRequestPayload({ windowCount = 2 } = {}) {
  const earthRadius = 6378137.0;
  const orbitRadius = earthRadius + 500000.0;
  const speed = 7612.608173223869;
  const stepSeconds = 600;
  const makeState = (theta, elapsedSeconds) =>
    new SCVStateSampleT(
      7,
      elapsedSeconds,
      new SCVVec3T(
        orbitRadius * Math.cos(theta),
        orbitRadius * Math.sin(theta),
        0,
      ),
      new SCVVec3T(-speed * Math.sin(theta), speed * Math.cos(theta), 0),
      0,
      0,
      0,
      1,
      scvCoordinateFrame.BODY_FIXED,
    );
  const stateSamples = [];
  for (let index = 0; index <= windowCount; index++) {
    const fraction = windowCount > 0 ? index / windowCount : 0;
    stateSamples.push(makeState(-0.04 + 0.08 * fraction, index * stepSeconds));
  }
  const request = new SCVCoverageRequestT(
    "scv-swath-preview-test",
    BigInt("44"),
    scvAnalysisMode.SWATH,
    new SCVEllipsoidT(
      scvBodyKind.EARTH,
      "Earth",
      earthRadius,
      6356752.314245,
      earthRadius,
      scvCoordinateFrame.BODY_FIXED,
    ),
    new SCVTimeGridT(null, 0, 0, windowCount * stepSeconds, stepSeconds, 0, windowCount),
    new SCVCoverageGridT(
      "regional-grid",
      scvGeometryDomain.SURFACE,
      scvCoordinateFrame.BODY_FIXED,
      -8,
      8,
      -12,
      12,
      4,
      4,
      0,
      24,
      4,
    ),
    [
      new SCVSensorT(
        7,
        "sensor-7",
        "SCV request sensor",
        scvCoordinateFrame.BODY_FIXED,
        null,
        null,
        null,
        null,
        conicShapeContract(0.22, 1600000),
      ),
    ],
    stateSamples,
    [],
    [],
    [],
    0,
    0,
    0,
    0,
    undefined,
    true,
  );
  const envelope = new SCVT(scvEnvelopeKind.REQUEST, request);
  const builder = new flatbuffers.Builder(1024);
  SCV.finishSCVBuffer(builder, envelope.pack(builder));
  return builder.asUint8Array();
}

function createScvOffNadirCoverageRequestPayload(offNadirAlongTrackRad = 0) {
  const earthRadius = 6378137.0;
  const orbitRadius = earthRadius + 500000.0;
  const speed = 7612.608173223869;
  const halfAngleDeg = 0.08 * (180 / Math.PI);
  const rotationHalfAngle = offNadirAlongTrackRad / 2;
  const qx = 0;
  const qy = Math.sin(rotationHalfAngle);
  const qz = 0;
  const qw = Math.cos(rotationHalfAngle);
  const makeState = (theta, elapsedSeconds) =>
    new SCVStateSampleT(
      0,
      elapsedSeconds,
      new SCVVec3T(
        orbitRadius * Math.cos(theta),
        orbitRadius * Math.sin(theta),
        0,
      ),
      new SCVVec3T(-speed * Math.sin(theta), speed * Math.cos(theta), 0),
      qx,
      qy,
      qz,
      qw,
      scvCoordinateFrame.BODY_FIXED,
    );
  const request = new SCVCoverageRequestT(
    "scv-off-nadir-parity",
    BigInt("77"),
    undefined,
    new SCVEllipsoidT(
      scvBodyKind.EARTH,
      "Earth",
      earthRadius,
      6356752.314245,
      earthRadius,
      scvCoordinateFrame.BODY_FIXED,
    ),
    new SCVTimeGridT(null, 0, 0, 1200, 600, 0, 2),
    new SCVCoverageGridT(
      "off-nadir-grid",
      scvGeometryDomain.SURFACE,
      scvCoordinateFrame.BODY_FIXED,
      -8,
      8,
      -16,
      16,
      2,
      2,
      0,
      128,
      2,
    ),
    [
      new SCVSensorT(
        0,
        "sensor-0",
        "SCV off-nadir parity sensor",
        scvCoordinateFrame.BODY_FIXED,
        null,
        null,
        null,
        null,
        conicShapeContract(0.08, 1600000),
      ),
    ],
    [makeState(-0.03, 0), makeState(0, 600), makeState(0.03, 1200)],
    [],
    [],
    [scvMetricSeriesKind.PERCENT_COVERED],
    0,
    0,
    0,
    0,
    undefined,
    true,
  );
  const envelope = new SCVT(scvEnvelopeKind.REQUEST, request);
  const builder = new flatbuffers.Builder(1024);
  SCV.finishSCVBuffer(builder, envelope.pack(builder));
  return builder.asUint8Array();
}

function createSensorCoverageHarness(runtimeKind, t) {
  return createStandaloneHarnessOrSkip(
    runtimeKind,
    WASM_PATH,
    t,
    runtimeKind === "browser"
        ? {
            surface: "direct",
            sharedMemory: true,
            allowRawInvoke: false,
            initialMemoryBytes: 64 * 1024 * 1024,
            maximumMemoryBytes: 2 * 1024 * 1024 * 1024,
          }
      : {},
  );
}

function invokeSensorCoverageScv(harness, payload) {
  return invokeBinaryRequest(harness, payload, {
    methodId: SENSOR_COVERAGE_METHOD_ID,
    inputPortId: SENSOR_COVERAGE_PORT_ID,
    inputTypeRef: SENSOR_COVERAGE_TYPE_REF,
    alignment: 8,
  });
}

test("sensor coverage browser behavior harness disables raw direct invoke", async (t) => {
  const harness = await createSensorCoverageHarness("browser", t);
  if (!harness) {
    return;
  }
  t.after(async () => {
    await harness.destroy();
  });

  await assert.rejects(
    harness.invokeRaw(new Uint8Array([0, 1, 2, 3])),
    /raw direct invoke is disabled/i,
  );
});

for (const runtimeKind of SENSOR_COVERAGE_RUNTIME_KINDS) {
  test(`sensor coverage module accepts an SDS SCV binary request frame on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await invokeSensorCoverageScv(
      harness,
      createScvCoverageRequestPayload(),
    );

    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(
      response.outputs.some((frame) => frame.typeRef?.fileIdentifier === "JSON"),
      false,
      "SCV request path must not emit non-SCV result frames",
    );
    const resultEnvelope = findScvEnvelope(response, scvEnvelopeKind.RESULT);
    assert.ok(resultEnvelope, "missing canonical SCV result output frame");
    const result = resultEnvelope.envelope.RESULT();
    assert.ok(result, "missing SCV RESULT payload");
    assert.equal(result.TOTAL_SENSORS(), 1);
    assert.equal(result.TOTAL_WINDOWS(), 2);
    assertNoInlineScvCellOrIntervalVectors(result);
    assertNoInlineScvTimeSeries(result);
    assert.equal(result.RASTER_PRODUCTS().CELL_COUNT(), 24);
    assertRenderableScvGeometry(result, 2, harness.memory.buffer);
  });

  test(`sensor coverage module emits SCV metric products as packed raster and aggregate descriptors on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await invokeSensorCoverageScv(
      harness,
      createScvMetricProductCoverageRequestPayload(),
    );

    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(
      response.outputs.some((frame) => frame.typeRef?.fileIdentifier === "JSON"),
      false,
      "SCV metric-product request must not emit non-SCV result frames",
    );
    const resultEnvelope = findScvEnvelope(response, scvEnvelopeKind.RESULT);
    assert.ok(resultEnvelope, "missing canonical SCV result output frame");
    const result = resultEnvelope.envelope.RESULT();
    assert.ok(result, "missing SCV RESULT payload");
    assert.equal(result.TOTAL_SENSORS(), 1);
    assert.equal(result.TOTAL_WINDOWS(), 2);
    const cellCount = 24;
    assertNoInlineScvCellOrIntervalVectors(result);
    assertTypedAggregateStatistics(result);
    assertNoInlineScvTimeSeries(result);
    assertPackedScvRasterProducts(result, {
      cellCount,
      rows: 4,
      columns: 6,
      bucketCount: result.TOTAL_WINDOWS(),
      wordsPerBucket: Math.ceil(cellCount / 32),
      minimumBandCount: 3,
    }, harness.memory.buffer);
    assertRasterBandMetricKind(
      result,
      scvRasterProductKind.PERCENT_COVERAGE,
      scvMetricSeriesKind.PERCENT_COVERED,
    );
    assert.equal(result.GEOMETRY(), null);
  });

  test(`sensor coverage module bounds output-region memory across invokes on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const payload = createScvMetricProductCoverageRequestPayload({
      requestedProducts: [
        scvMetricSeriesKind.PERCENT_COVERED,
        scvMetricSeriesKind.ACCESS_COUNT,
        scvMetricSeriesKind.CONTACT_DURATION_SECONDS,
        scvMetricSeriesKind.REVISIT_SECONDS,
        scvMetricSeriesKind.GAP_SECONDS,
        scvMetricSeriesKind.REDUNDANCY,
      ],
      grid: {
        minLatitudeDeg: -90,
        maxLatitudeDeg: 90,
        minLongitudeDeg: -180,
        maxLongitudeDeg: 180,
        latitudeStepDeg: 5,
        longitudeStepDeg: 5,
      },
    });
    const firstResponse = await invokeSensorCoverageScv(harness, payload);
    assert.equal(firstResponse.statusCode, 0, firstResponse.errorMessage);
    const firstResult = findScvEnvelope(
      firstResponse,
      scvEnvelopeKind.RESULT,
    ).envelope.RESULT();
    const firstPercentCoverage = Array.from(scvRasterBandValues(
      firstResult,
      scvRasterProductKind.PERCENT_COVERAGE,
      harness.memory.buffer,
    ));
    const warmMemoryBytes = harness.memory.buffer.byteLength;

    let lastResponse = firstResponse;
    for (let invokeIndex = 0; invokeIndex < 320; invokeIndex += 1) {
      lastResponse = await invokeSensorCoverageScv(harness, payload);
      assert.equal(lastResponse.statusCode, 0, lastResponse.errorMessage);
    }
    const lastResult = findScvEnvelope(
      lastResponse,
      scvEnvelopeKind.RESULT,
    ).envelope.RESULT();
    const lastPercentCoverage = Array.from(scvRasterBandValues(
      lastResult,
      scvRasterProductKind.PERCENT_COVERAGE,
      harness.memory.buffer,
    ));

    assert.equal(harness.memory.buffer.byteLength, warmMemoryBytes);
    assert.deepEqual(lastPercentCoverage, firstPercentCoverage);
  });

  test(`sensor coverage module keeps metric-product time windows global across sensors on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const sensorCount = 16;
    const windowCount = 5;
    const response = await invokeSensorCoverageScv(
      harness,
      createScvMultiSensorMetricProductCoverageRequestPayload({
        sensorCount,
        windowCount,
      }),
    );

    assert.equal(response.statusCode, 0, response.errorMessage);
    const resultEnvelope = findScvEnvelope(response, scvEnvelopeKind.RESULT);
    assert.ok(resultEnvelope, "missing canonical SCV result output frame");
    const result = resultEnvelope.envelope.RESULT();
    assert.ok(result, "missing SCV RESULT payload");
    assert.equal(result.TOTAL_SENSORS(), sensorCount);
    assert.equal(result.TOTAL_WINDOWS(), windowCount);
    assertNoInlineScvCellOrIntervalVectors(result);
    assertNoInlineScvTimeSeries(result);
    assert.equal(result.RASTER_PRODUCTS().CELL_COUNT(), 1);
    assert.equal(typeof result.HEATMAP, "undefined");
    assert.equal(typeof result.heatmapLength, "undefined");
    const activeCellCount = scvRasterBandValues(
      result,
      scvRasterProductKind.BUCKET_ACTIVE_CELL_COUNT,
      harness.memory.buffer,
    );
    assert.equal(
      activeCellCount.length,
      windowCount,
    );
    assert.ok(
      activeCellCount.some((value) => value > 0),
      "bucket active-cell count must carry module-authored current-access values",
    );
  });

  test(`sensor coverage module rejects SCV metric product requests without explicit products on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await invokeSensorCoverageScv(
      harness,
      createScvMetricProductCoverageRequestPayload({
        requestedProducts: [],
      }),
    );

    assert.notEqual(response.statusCode, 0);
    assert.match(response.errorMessage, /REQUESTED_PRODUCTS/i);
  });

  test(`sensor coverage module emits requested per-cell packed raster products on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const requestedProducts = [
      scvMetricSeriesKind.PERCENT_COVERED,
      scvMetricSeriesKind.ACCESS_COUNT,
      scvMetricSeriesKind.CONTACT_DURATION_SECONDS,
      scvMetricSeriesKind.REVISIT_SECONDS,
      scvMetricSeriesKind.GAP_SECONDS,
      scvMetricSeriesKind.REDUNDANCY,
    ];
    const response = await invokeSensorCoverageScv(
      harness,
      createScvMetricProductCoverageRequestPayload({
        requestedProducts,
      }),
    );

    assert.equal(response.statusCode, 0, response.errorMessage);
    const resultEnvelope = findScvEnvelope(response, scvEnvelopeKind.RESULT);
    assert.ok(resultEnvelope, "missing canonical SCV result output frame");
    const result = resultEnvelope.envelope.RESULT();
    assert.ok(result, "missing SCV RESULT payload");
    assertNoInlineScvCellOrIntervalVectors(result);
    assertNoInlineScvTimeSeries(result);
    assertRequestedPerCellRasterProducts(result, requestedProducts);
    assert.equal(typeof result.HEATMAP, "undefined");
    assert.equal(typeof result.heatmapLength, "undefined");

    const columns = 6;
    const rows = 4;
    const cellCount = rows * columns;
    const rasterProducts = assertPackedScvRasterProducts(result, {
      cellCount,
      rows,
      columns,
      bucketCount: result.TOTAL_WINDOWS(),
      wordsPerBucket: Math.ceil(cellCount / 32),
      minimumBandCount: 14,
    }, harness.memory.buffer);
    const passCountValues = scvRasterBandValues(
      result,
      scvRasterProductKind.PASS_COUNT,
      harness.memory.buffer,
    );
    assert.equal(passCountValues.length, cellCount);
    assert.ok(passCountValues.every((value) => value >= 0));
    assert.ok(
      passCountValues.some((value) => value > 0),
      "PASS_COUNT raster must contain module-authored covered cells",
    );
    const percentValues = scvRasterBandValues(
      result,
      scvRasterProductKind.PERCENT_COVERAGE,
      harness.memory.buffer,
    );
    assert.equal(percentValues.length, cellCount);
    assert.ok(
      percentValues.every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 100,
      ),
      "PERCENT_COVERAGE raster must contain bounded finite percentages",
    );
    assert.ok(
      percentValues.some((value) => value > 0),
      "PERCENT_COVERAGE raster must contain module-authored covered cells",
    );
    const passCountRgbaBand = scvRasterBand(
      result,
      scvRasterProductKind.PASS_COUNT_RGBA,
    );
    assert.equal(passCountRgbaBand.ENCODING(), scvRasterProductEncoding.UINT8);
    assert.equal(passCountRgbaBand.COMPONENTS_PER_CELL(), 4);
    assert.equal(passCountRgbaBand.CELL_COUNT(), cellCount);
    assert.equal(passCountRgbaBand.BUCKET_COUNT(), 0);
    const passCountRgbaValues = scvRasterBandValues(
      result,
      scvRasterProductKind.PASS_COUNT_RGBA,
      harness.memory.buffer,
    );
    assert.equal(passCountRgbaValues.length, cellCount * 4);
    assert.ok(
      passCountRgbaValues.some((value, index) => index % 4 === 3 && value > 0),
      "PASS_COUNT_RGBA must contain module-authored visible alpha values",
    );
    const currentAccessRgbaBand = scvRasterBand(
      result,
      scvRasterProductKind.CURRENT_ACCESS_RGBA,
    );
    assert.equal(currentAccessRgbaBand.ENCODING(), scvRasterProductEncoding.UINT8);
    assert.equal(currentAccessRgbaBand.COMPONENTS_PER_CELL(), 4);
    assert.equal(currentAccessRgbaBand.CELL_COUNT(), cellCount);
    assert.equal(currentAccessRgbaBand.BUCKET_COUNT(), result.TOTAL_WINDOWS());
    const currentAccessRgbaValues = scvRasterBandValues(
      result,
      scvRasterProductKind.CURRENT_ACCESS_RGBA,
      harness.memory.buffer,
    );
    assert.equal(
      currentAccessRgbaValues.length,
      result.TOTAL_WINDOWS() * cellCount * 4,
    );
    assert.ok(
      currentAccessRgbaValues.some((value, index) => index % 4 === 3 && value > 0),
      "CURRENT_ACCESS_RGBA must contain module-authored visible alpha values",
    );
    assert.equal(rasterProducts.CELL_COUNT(), cellCount);
  });

  test(`sensor coverage module maps requested SCV FOM and raster products exactly on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const requestedProducts = [
      scvMetricSeriesKind.COVERED_CELL_COUNT,
      scvMetricSeriesKind.OVERLAP_COUNT,
      scvMetricSeriesKind.LATITUDE_BAND_COVERAGE,
    ];
    const response = await invokeSensorCoverageScv(
      harness,
      createScvMetricProductCoverageRequestPayload({
        requestedProducts,
      }),
    );

    assert.equal(response.statusCode, 0, response.errorMessage);
    const resultEnvelope = findScvEnvelope(response, scvEnvelopeKind.RESULT);
    assert.ok(resultEnvelope, "missing canonical SCV result output frame");
    const result = resultEnvelope.envelope.RESULT();
    assert.ok(result, "missing SCV RESULT payload");
    assert.equal(result.GEOMETRY(), null);
    assertNoInlineScvCellOrIntervalVectors(result);
    assertNoInlineScvLatitudeBandVectors(result);
    assertNoInlineScvTimeSeries(result);
    const statistics = assertTypedAggregateStatistics(result);
    assert.ok(requestedProducts.includes(scvMetricSeriesKind.COVERED_CELL_COUNT));
    assert.ok(requestedProducts.includes(scvMetricSeriesKind.OVERLAP_COUNT));
    assert.ok(
      requestedProducts.includes(scvMetricSeriesKind.LATITUDE_BAND_COVERAGE),
    );
    assert.ok(Number.isFinite(statistics.ACCESSED_CELLS()));
    assert.ok(Number.isFinite(statistics.MULTI_ACCESS_CELLS()));
    assert.equal(
      typeof scvRasterProductKind.LATITUDE_BAND_COVERAGE,
      "number",
      "SDS SCV must define a packed latitude-band raster product kind",
    );
    const latitudeBand = scvRasterBand(
      result,
      scvRasterProductKind.LATITUDE_BAND_COVERAGE,
    );
    assert.equal(latitudeBand.METRIC_KIND(), scvMetricSeriesKind.LATITUDE_BAND_COVERAGE);
    assert.equal(latitudeBand.ENCODING(), scvRasterProductEncoding.FLOAT64);
    assert.equal(latitudeBand.COMPONENTS_PER_CELL(), 6);
    assert.equal(latitudeBand.CELL_COUNT(), 4);
    assert.equal(latitudeBand.BUCKET_COUNT(), 0);
    const latitudeBandValues = scvRasterBandValues(
      result,
      scvRasterProductKind.LATITUDE_BAND_COVERAGE,
      harness.memory.buffer,
    );
    assert.equal(latitudeBandValues.length, 24);
    assert.equal(latitudeBandValues[0], -8);
    assert.equal(latitudeBandValues[1], -4);
    for (let index = 2; index < 6; index += 1) {
      assert.ok(Number.isFinite(latitudeBandValues[index]));
    }
  });

  test(`sensor coverage module honors SCV swath mode without grid coverage products on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await invokeSensorCoverageScv(
      harness,
      createScvSwathPreviewCoverageRequestPayload(),
    );

    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(
      response.outputs.some((frame) => frame.typeRef?.fileIdentifier === "JSON"),
      false,
      "SCV swath request must not emit non-SCV result frames",
    );
    const resultEnvelope = findScvEnvelope(response, scvEnvelopeKind.RESULT);
    assert.ok(resultEnvelope, "missing canonical SCV result output frame");
    const result = resultEnvelope.envelope.RESULT();
    assert.ok(result, "missing SCV RESULT payload");
    assert.equal(result.TOTAL_SENSORS(), 1);
    assert.equal(result.TOTAL_WINDOWS(), 2);
    assertNoInlineScvCellOrIntervalVectors(result);
    assertNoInlineScvTimeSeries(result);
    assertRenderableScvGeometry(result, 2, harness.memory.buffer);
  });

  test(`sensor coverage module applies shared sensor-shape conformance vectors on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const results = new Map();
    for (const vector of SENSOR_SHAPE_CONFORMANCE_VECTORS) {
      const response = await invokeSensorCoverageScv(
        harness,
        createScvConformanceCoveragePayload(vector),
      );
      assert.equal(response.statusCode, 0, `${vector.name}: ${response.errorMessage}`);
      const result = findScvEnvelope(response, scvEnvelopeKind.RESULT)?.envelope.RESULT();
      assert.ok(result, `${vector.name}: missing SCV result`);
      assertNoInlineScvCellOrIntervalVectors(result);
      assertNoInlineScvTimeSeries(result);
      const rasterProducts = result.RASTER_PRODUCTS();
      assert.ok(rasterProducts, `${vector.name}: missing SCV raster products`);
      results.set(vector.name, {
        total: scvCoveredCellCount(result, harness.memory.buffer),
        coveredCellIds: scvCoveredCellIds(result, harness.memory.buffer),
        fractionTotal: scvCoverageFractionTotal(result, harness.memory.buffer),
        totalSensors: result.TOTAL_SENSORS(),
        totalWindows: result.TOTAL_WINDOWS(),
        totalCells: rasterProducts.CELL_COUNT(),
      });
    }

    const solid = results.get("solid-conic");
    const rectangular = results.get("rectangular");
    const sar = results.get("sar-annular-sector");
    const partialClock = results.get("partial-clock-sector");
    const innerCutout = results.get("inner-cutout");

    const resultSummary = JSON.stringify(Array.from(results.entries()));
    assert.ok(
      solid.total > 0,
      `solid conic should cover at least one cell: ${resultSummary}`,
    );
    assert.notEqual(
      solid.fractionTotal,
      rectangular.fractionTotal,
      "conic coverage fraction must differ from rectangular",
    );
    assert.notEqual(
      solid.fractionTotal,
      sar.fractionTotal,
      "conic coverage fraction must differ from SAR",
    );
    assert.ok(
      partialClock.total < solid.total,
      `partial-clock covered cell count (${partialClock.total}) must be less than full-clock conic (${solid.total})`,
    );
    assert.ok(
      innerCutout.total < solid.total,
      `inner-cutout covered cell count (${innerCutout.total}) must be less than solid conic (${solid.total})`,
    );
  });

  test(`sensor coverage module evaluates SCV CUSTOM_POLYGON coverage on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await invokeSensorCoverageScv(
      harness,
      createScvShapeContractCoveragePayload(
        new SCVSensorShapeContractT(
          scvSensorShapeKind.CUSTOM_POLYGON,
          0,
          scvSensorRangeBoundaryKind.RADIAL_SPHERICAL,
          0,
          0,
          0,
          360,
          0,
          0,
          0,
          0,
          0,
          0,
          1600000,
          [
            new SCVVec3T(-0.3, -0.3, 1),
            new SCVVec3T(0.3, -0.3, 1),
            new SCVVec3T(0.3, 0.3, 1),
            new SCVVec3T(-0.3, 0.3, 1),
          ],
          scvCoordinateFrame.BODY_FIXED,
        ),
      ),
    );

    assert.equal(response.statusCode, 0, response.errorMessage);
  });

  test(`sensor coverage module rejects unsupported SCV shapes before state-count validation on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await invokeSensorCoverageScv(
      harness,
      createScvShapeContractCoveragePayload(
        new SCVSensorShapeContractT(
          scvSensorShapeKind.CUSTOM_POLYGON,
          0,
          scvSensorRangeBoundaryKind.RADIAL_SPHERICAL,
          0,
          0,
          0,
          360,
          0,
          0,
          0,
          0,
          0,
          0,
          1600000,
          [
            new SCVVec3T(0, 0, 1),
            new SCVVec3T(0.1, 0, 1),
          ],
          scvCoordinateFrame.BODY_FIXED,
        ),
        { stateSampleCount: 1 },
      ),
    );

    assert.notEqual(response.statusCode, 0);
    assert.match(response.errorMessage, /custom polygon/i);
    assert.doesNotMatch(response.errorMessage, /missing-states|at least two propagated/i);
  });

  test(`sensor coverage module rejects non-SCV payloads on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await invokeSensorCoverageScv(
      harness,
      Buffer.from(JSON.stringify(createSingleSensorCoverageRequest()), "utf8"),
    );

    assert.notEqual(response.statusCode, 0);
    assert.match(response.errorMessage, /SDS SCV FlatBuffer|valid SCV FlatBuffer/);
  });

  test(`sensor coverage module emits SDS SCV progress frames on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await invokeSensorCoverageScv(
      harness,
      createScvCoverageRequestPayload(),
    );

    assert.equal(response.statusCode, 0, response.errorMessage);
    const progressEnvelopes = decodeScvFrames(response)
      .filter(({ envelope }) => envelope.ENVELOPE_KIND() === scvEnvelopeKind.PROGRESS);
    const progressEnvelope = progressEnvelopes.at(-1);
    assert.ok(progressEnvelope, "missing canonical SCV progress output frame");
    assert.equal(progressEnvelope.frame.portId, "coverage");
    const progress = progressEnvelope.envelope.PROGRESS();
    assert.ok(progress, "missing SCV PROGRESS payload");
    assert.equal(progress.TOTAL_SENSORS(), 1);
    assert.equal(progress.TOTAL_WINDOWS(), 2);
    assert.equal(progress.COMPLETED_WINDOWS(), 2);
    assert.equal(progress.BACKLOG_REMAINING(), 0);
    assert.equal(progress.COMPLETION_FRACTION(), 1);
    assert.match(progress.MESSAGE(), /complete/i);
  });

  test(`sensor coverage module emits non-final SDS SCV progress cadence on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await invokeSensorCoverageScv(
      harness,
      createScvCoverageRequestPayload({ windowCount: 5 }),
    );

    assert.equal(response.statusCode, 0, response.errorMessage);
    const progressFrames = decodeScvFrames(response)
      .filter(({ envelope }) => envelope.ENVELOPE_KIND() === scvEnvelopeKind.PROGRESS)
      .map(({ envelope }) => envelope.PROGRESS());
    assert.ok(
      progressFrames.length >= 2,
      `expected at least one non-final progress frame plus final progress, got ${progressFrames.length}`,
    );
    assert.ok(
      progressFrames.some((progress) =>
        progress &&
        progress.TOTAL_WINDOWS() === 5 &&
        progress.COMPLETED_WINDOWS() > 0 &&
        progress.COMPLETED_WINDOWS() < progress.TOTAL_WINDOWS() &&
        progress.COMPLETION_FRACTION() > 0 &&
        progress.COMPLETION_FRACTION() < 1
      ),
      "expected a non-final progress frame for the multi-window SCV job",
    );
    const finalProgress = progressFrames.at(-1);
    assert.equal(finalProgress.TOTAL_WINDOWS(), 5);
    assert.equal(finalProgress.COMPLETED_WINDOWS(), 5);
    assert.equal(finalProgress.BACKLOG_REMAINING(), 0);
    assert.equal(finalProgress.COMPLETION_FRACTION(), 1);
  });

  test(`sensor coverage module emits an SDS SCV binary result frame on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await invokeSensorCoverageScv(
      harness,
      createScvCoverageRequestPayload(),
    );

    assert.equal(response.statusCode, 0);
    const resultEnvelope = findScvEnvelope(response, scvEnvelopeKind.RESULT);
    assert.ok(resultEnvelope, "missing canonical SCV result output frame");
    assert.equal(resultEnvelope.frame.portId, "coverage");
    assert.equal(resultEnvelope.frame.typeRef?.schemaName, "SCV/main.fbs");

    const envelope = resultEnvelope.envelope;
    assert.equal(envelope.ENVELOPE_KIND(), scvEnvelopeKind.RESULT);
    const result = envelope.RESULT();
    assert.ok(result, "missing SCV RESULT payload");
    assert.equal(result.STATUS(), scvResultState.OK);
    assert.equal(result.TOTAL_SENSORS(), 1);
    assert.equal(result.TOTAL_WINDOWS(), 2);
    assertNoInlineScvCellOrIntervalVectors(result);
    assertNoInlineScvTimeSeries(result);
    assert.equal(result.RASTER_PRODUCTS().CELL_COUNT(), 24);
    assertRenderableScvGeometry(result, 2, harness.memory.buffer);
  });

  test(`sensor coverage SCV request preserves time-dynamic sensor attitude on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const invokeScv = async (offNadirRad) => {
      const response = await invokeSensorCoverageScv(
        harness,
        createScvOffNadirCoverageRequestPayload(offNadirRad),
      );
      assert.equal(response.statusCode, 0, response.errorMessage);
      const resultEnvelope = findScvEnvelope(response, scvEnvelopeKind.RESULT);
      assert.ok(resultEnvelope, "missing canonical SCV result output frame");
      const geometry = resultEnvelope.envelope.RESULT()?.GEOMETRY();
      assert.ok(geometry, "SCV result must include packed geometry");
      assert.ok(geometry.segmentsLength() > 0, "SCV geometry must include swath segments");
      const regions = regionDescriptors(geometry);
      const revealCoords = regionTypedArray(
        harness.memory.buffer,
        regionFor(
          regions,
          geometry.REVEAL_COORDS_REGION_ID(),
          geometry.REVEAL_COORDS_RECORD_INDEX(),
          "REVEAL_COORDS",
        ),
        Float32Array,
        geometry.segmentsLength() * 8,
        "REVEAL_COORDS",
      );
      const firstSegment = geometry.SEGMENTS(0);
      const vertexOffset = firstSegment.VERTEX_OFFSET() * 2;
      const leftStartLon = revealCoords[vertexOffset];
      const rightStartLon = revealCoords[vertexOffset + 6];
      return (leftStartLon + rightStartLon) / 2;
    };

    const nadirLongitude = await invokeScv(0);
    const offNadirLongitude = await invokeScv(0.28);
    assert.ok(
      offNadirLongitude > nadirLongitude + 0.5,
      `expected SCV attitude quaternion to move swath centerline, got ${nadirLongitude} and ${offNadirLongitude}`,
    );
  });
}
