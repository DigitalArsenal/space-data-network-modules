import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
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
  SCVStateSampleT,
  SCVTimeGridT,
  SCVT,
  SCVVec3T,
  scvAnalysisMode,
  scvBodyKind,
  scvCoordinateFrame,
  scvEnvelopeKind,
  scvGeometryDomain,
  scvIntervalCategory,
  scvMetricSeriesKind,
  scvResultState,
  scvSensorShapeKind,
} = await import(pathToFileURL(`${STANDARDS_ROOT}/lib/js/SCV/main.js`).href);
const JSON_COVERAGE_REQUEST_TYPE = Object.freeze({
  schemaName: "SensorCoverageCompatibilityJson",
  fileIdentifier: "JSON",
  rootTypeName: "SensorCoverageCompatibilityRequest",
});
const WGS84_A = 6378137.0;
const WGS84_B = 6356752.3142451793;
const WGS84_E2 = 1.0 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);

test("sensor coverage FOM accumulation culls grid candidates by swath bounds before polygon tests", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const accumulateStart = source.indexOf("void accumulate_swaths");
  const accumulateStop = source.indexOf("void merge_intervals");
  assert.notEqual(accumulateStart, -1);
  assert.notEqual(accumulateStop, -1);
  const accumulateSource = source.slice(accumulateStart, accumulateStop);

  assert.match(source, /struct SwathBounds/);
  assert.match(source, /SwathBounds swath_bounds/);
  assert.match(source, /CellRange candidate_cell_range/);
  assert.doesNotMatch(accumulateSource, /for \(auto& cell : cells\)/);
  assert.match(accumulateSource, /row <= range\.maxRow/);
  assert.match(accumulateSource, /column <= range\.maxColumn/);
});

test("sensor coverage FOM analytics use a grid-first exact visibility kernel", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const computeStart = source.indexOf("extern \"C\" int compute_sensor_coverage");
  const computeSource = source.slice(computeStart);
  const kernelStart = source.indexOf("void accumulate_grid_analytics");
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
  assert.match(computeSource, /accumulate_grid_analytics\(\*cells, tracks, swaths, grid\)/);
  assert.doesNotMatch(computeSource, /accumulate_swaths\(cells, swaths, grid\)/);
  assert.doesNotMatch(kernelSource, /point_in_polygon/);
});

test("sensor coverage grid analytics indexes generated swaths without quadratic lookup", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const kernelStart = source.indexOf("void accumulate_grid_analytics");
  const kernelStop = source.indexOf("void merge_intervals");
  assert.notEqual(kernelStart, -1);
  assert.notEqual(kernelStop, -1);
  const kernelSource = source.slice(kernelStart, kernelStop);

  assert.doesNotMatch(source, /find_swath_segment/);
  assert.match(source, /index_swaths_by_sensor/);
  assert.match(source, /std::map<int, std::vector<const SwathSegment\*>>/);
  assert.match(kernelSource, /size_t swath_index = 0;/);
  assert.match(kernelSource, /const std::vector<const SwathSegment\*>& track_swaths/);
  assert.match(kernelSource, /track_swaths\[swath_index\]/);
});

test("sensor coverage analytics-only path uses local footprint candidates without serializing visualization swaths", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const computeStart = source.indexOf("extern \"C\" int compute_sensor_coverage");
  assert.notEqual(computeStart, -1);
  const computeSource = source.slice(computeStart);

  assert.match(source, /accumulate_grid_analytics\(\*cells, tracks, grid\)/);
  assert.match(source, /compute_footprints\(track\.states, track\.sensor\)/);
  assert.match(source, /build_swath_segments\(track_footprints\)/);
  assert.match(computeSource, /if \(!analytics_only_output\)/);
  assert.match(computeSource, /if \(analytics_only_output\) \{\s+accumulate_grid_analytics\(\*cells, tracks, grid\);/);
});

test("sensor coverage analytics-only path uses analytic candidate bounds for fallback nadir conic sensors", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const directKernelStart = source.indexOf(
    "void accumulate_grid_analytics(\n    std::vector<Cell>& cells,\n    const std::vector<SensorTrack>& tracks,\n    const GridConfig& grid)",
  );
  const directKernelStop = source.indexOf("void merge_intervals", directKernelStart);
  assert.notEqual(directKernelStart, -1);
  assert.notEqual(directKernelStop, -1);
  const directKernelSource = source.slice(directKernelStart, directKernelStop);

  assert.match(source, /bool uses_fallback_nadir_conic_bounds/);
  assert.match(source, /struct NadirConicCandidateWindow/);
  assert.match(source, /NadirConicCandidateWindow nadir_conic_candidate_window/);
  assert.match(directKernelSource, /uses_fallback_nadir_conic_bounds\(track\)/);
  assert.match(directKernelSource, /nadir_conic_candidate_window\(track\.sensor, start, stop, grid\)/);
  assert.match(directKernelSource, /bounds = candidate_window\.bounds/);
});

test("sensor coverage fallback nadir analytics culls rectangle candidates by angular distance", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const directKernelStart = source.indexOf(
    "void accumulate_grid_analytics(\n    std::vector<Cell>& cells,\n    const std::vector<SensorTrack>& tracks,\n    const GridConfig& grid)",
  );
  const directKernelStop = source.indexOf("void merge_intervals", directKernelStart);
  assert.notEqual(directKernelStart, -1);
  assert.notEqual(directKernelStop, -1);
  const directKernelSource = source.slice(directKernelStart, directKernelStop);

  assert.match(source, /struct NadirConicCandidateFilter/);
  assert.match(source, /struct NadirConicCandidateWindow/);
  assert.match(source, /NadirConicCandidateWindow nadir_conic_candidate_window/);
  assert.match(source, /bool cell_matches_nadir_conic_candidate_filter/);
  assert.match(directKernelSource, /nadir_filter = candidate_window\.filter/);
  assert.match(directKernelSource, /cell_matches_nadir_conic_candidate_filter\(cell, nadir_filter\)/);
  assert.ok(
    directKernelSource.indexOf("cell_matches_nadir_conic_candidate_filter") <
      directKernelSource.indexOf("refined_visibility_interval"),
    "nadir angular culling must run before exact interval refinement",
  );
});

test("sensor coverage fallback nadir candidate culling avoids per-cell inverse trig", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const matcherStart = source.indexOf("bool cell_matches_nadir_conic_candidate_filter");
  const matcherStop = source.indexOf("bool surface_sample_visible_from_resolved_state", matcherStart);
  assert.notEqual(matcherStart, -1);
  assert.notEqual(matcherStop, -1);
  const matcherSource = source.slice(matcherStart, matcherStop);

  assert.match(source, /double cosRadius = -1.0;/);
  assert.match(source, /double sinRadius = 0.0;/);
  assert.match(source, /filter\.cosRadius = std::cos/);
  assert.match(source, /filter\.sinRadius = std::sin/);
  assert.match(
    matcherSource,
    /filter\.cosRadius \* cell\.bounds\.cosAngularRadius/,
  );
  assert.match(matcherSource, /filter\.sinRadius \* cell\.bounds\.sinAngularRadius/);
  assert.match(matcherSource, />= cos_expanded_radius/);
  assert.doesNotMatch(matcherSource, /central_angle_rad/);
});

test("sensor coverage grid cells carry cached tile and angular bounds metadata", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const createStart = source.indexOf("std::vector<Cell> create_cells");
  const createStop = source.indexOf("void ensure_cell_geometry", createStart);
  const matcherStart = source.indexOf("bool cell_matches_nadir_conic_candidate_filter");
  const matcherStop = source.indexOf("bool surface_sample_visible_from_resolved_state", matcherStart);
  assert.notEqual(createStart, -1);
  assert.notEqual(createStop, -1);
  assert.notEqual(matcherStart, -1);
  assert.notEqual(matcherStop, -1);
  const createSource = source.slice(createStart, createStop);
  const matcherSource = source.slice(matcherStart, matcherStop);

  assert.match(source, /constexpr int kGridTileRowSpan = 8;/);
  assert.match(source, /constexpr int kGridTileColumnSpan = 8;/);
  assert.match(source, /struct CellBounds/);
  assert.match(source, /int tileId = 0;/);
  assert.match(source, /double angularRadiusRad = 0.0;/);
  assert.match(source, /double cosAngularRadius = 1.0;/);
  assert.match(source, /double sinAngularRadius = 0.0;/);
  assert.match(source, /CellBounds cell_bounds_for\(int row, int column, const GridConfig& grid\)/);
  assert.match(createSource, /cell\.bounds = cell_bounds_for\(row, column, grid\);/);
  assert.match(createSource, /cell\.surfaceUnit = cell\.bounds\.centerUnit;/);
  assert.match(matcherSource, /cos_expanded_radius/);
  assert.doesNotMatch(matcherSource, /cell_surface_unit\(cell\)/);
});

test("sensor coverage exact grid geometry is built lazily for candidate cells", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const createStart = source.indexOf("std::vector<Cell> create_cells");
  const createStop = source.indexOf("void ensure_cell_geometry", createStart);
  const kernelStart = source.indexOf(
    "void accumulate_grid_analytics(\n    std::vector<Cell>& cells,\n    const std::vector<SensorTrack>& tracks,\n    const GridConfig& grid)",
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
  assert.match(source, /Vec3 cell_surface_unit\(Cell& cell\)/);
  assert.doesNotMatch(createSource, /grid_cell_geometry/);
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

test("sensor coverage exact visibility resolves endpoint frames once per state window", () => {
  const source = fs.readFileSync(
    new URL("../src/cpp/module.cpp", import.meta.url),
    "utf8",
  );
  const intervalStart = source.indexOf("VisibilityInterval refined_visibility_interval");
  const intervalStop = source.indexOf("std::map<int, std::vector<const SwathSegment*>>", intervalStart);
  const directKernelStart = source.indexOf(
    "void accumulate_grid_analytics(\n    std::vector<Cell>& cells,\n    const std::vector<SensorTrack>& tracks,\n    const GridConfig& grid)",
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
  const candidateLoopIndex = directKernelSource.indexOf("for (int row = range.minRow");

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
  assert.match(intervalSource, /cell_visible_from_resolved_state\(cell, sensor, start\)/);
  assert.match(intervalSource, /cell_visible_from_resolved_state\(cell, sensor, stop\)/);
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

function assertRenderableScvGeometry(result, expectedSegments) {
  const geometry = result.GEOMETRY();
  assert.ok(geometry, "SCV result must include packed geometry for rendering");
  assert.equal(geometry.WINDOW_COUNT(), expectedSegments);
  assert.equal(geometry.segmentIdsLength(), expectedSegments);
  assert.equal(geometry.sensorIdsLength(), expectedSegments);
  assert.equal(geometry.segmentsLength(), expectedSegments);
  assert.equal(geometry.revealCoordsLength(), expectedSegments * 8);
  assert.equal(geometry.indicesLength(), expectedSegments * 6);
  assert.equal(geometry.SEGMENT_IDS(0), 0);
  assert.equal(geometry.INDICES(0), 0);
  assert.equal(geometry.INDICES(5), 3);
  const firstSegment = geometry.SEGMENTS(0);
  assert.ok(firstSegment, "SCV geometry must include segment descriptors");
  assert.equal(firstSegment.VERTEX_COUNT(), 4);
  assert.equal(firstSegment.INDEX_COUNT(), 6);
  assert.equal(firstSegment.START_OFFSET_SEC(), 0);
}

function resolveStandardsRoot() {
  const candidates = [
    process.env.SPACE_DATA_STANDARDS_ROOT,
    new URL("../../../../sds-wasm-module-architecture", import.meta.url).pathname,
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

function createScvCoverageRequestPayload({ windowCount = 2 } = {}) {
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
        scvSensorShapeKind.CONIC,
        scvCoordinateFrame.BODY_FIXED,
        null,
        null,
        null,
        null,
        0.22 * (180 / Math.PI),
        0,
        0,
        0,
        1600000,
      ),
    ],
    stateSamples,
  );
  const envelope = new SCVT(scvEnvelopeKind.REQUEST, request);
  const builder = new flatbuffers.Builder(1024);
  SCV.finishSCVBuffer(builder, envelope.pack(builder));
  return builder.asUint8Array();
}

function createScvAnalyticsOnlyCoverageRequestPayload({ windowCount = 2 } = {}) {
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
    "scv-analytics-only-test",
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
        scvSensorShapeKind.CONIC,
        scvCoordinateFrame.BODY_FIXED,
        null,
        null,
        null,
        null,
        0.22 * (180 / Math.PI),
        0,
        0,
        0,
        1600000,
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

function createScvSwathOnlyCoverageRequestPayload({ windowCount = 2 } = {}) {
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
    "scv-swath-only-test",
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
        scvSensorShapeKind.CONIC,
        scvCoordinateFrame.BODY_FIXED,
        null,
        null,
        null,
        null,
        0.22 * (180 / Math.PI),
        0,
        0,
        0,
        1600000,
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
        scvSensorShapeKind.CONIC,
        scvCoordinateFrame.BODY_FIXED,
        null,
        null,
        null,
        null,
        halfAngleDeg,
        0,
        0,
        0,
        1600000,
      ),
    ],
    [makeState(-0.03, 0), makeState(0, 600), makeState(0.03, 1200)],
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
    runtimeKind === "browser" ? { surface: "direct" } : {},
  );
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`sensor coverage module accepts an SDS SCV binary request frame on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await harness.invoke({
      methodId: "compute_sensor_coverage",
      inputs: [
        {
          portId: "coverage",
          typeRef: {
            schemaName: "SCV/main.fbs",
            fileIdentifier: "$SCV",
            rootTypeName: "SCV",
          },
          payload: createScvCoverageRequestPayload(),
        },
      ],
    });

    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(
      response.outputs.some((frame) => frame.typeRef?.fileIdentifier === "JSON"),
      false,
      "SCV request path should not emit JSON compatibility results",
    );
    const resultEnvelope = findScvEnvelope(response, scvEnvelopeKind.RESULT);
    assert.ok(resultEnvelope, "missing canonical SCV result output frame");
    const result = resultEnvelope.envelope.RESULT();
    assert.ok(result, "missing SCV RESULT payload");
    assert.equal(result.TOTAL_SENSORS(), 1);
    assert.equal(result.TOTAL_WINDOWS(), 2);
    assert.equal(result.cellStatsLength(), 24);
    assertRenderableScvGeometry(result, 2);
  });

  test(`sensor coverage module honors SCV analytics-only products without packed geometry on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await harness.invoke({
      methodId: "compute_sensor_coverage",
      inputs: [
        {
          portId: "coverage",
          typeRef: {
            schemaName: "SCV/main.fbs",
            fileIdentifier: "$SCV",
            rootTypeName: "SCV",
          },
          payload: createScvAnalyticsOnlyCoverageRequestPayload(),
        },
      ],
    });

    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(
      response.outputs.some((frame) => frame.typeRef?.fileIdentifier === "JSON"),
      false,
      "SCV analytics-only request must not emit JSON compatibility results",
    );
    const resultEnvelope = findScvEnvelope(response, scvEnvelopeKind.RESULT);
    assert.ok(resultEnvelope, "missing canonical SCV result output frame");
    const result = resultEnvelope.envelope.RESULT();
    assert.ok(result, "missing SCV RESULT payload");
    assert.equal(result.TOTAL_SENSORS(), 1);
    assert.equal(result.TOTAL_WINDOWS(), 2);
    assert.equal(result.cellStatsLength(), 24);
    const summary = JSON.parse(result.MESSAGE());
    assert.equal(summary.contract, "orbpro.coverage.scv-summary.v0");
    assert.equal(summary.provider, "sensor-coverage-analysis");
    assert.equal(summary.statistics.activeSensorCount, 1);
    assert.equal(summary.statistics.totalWindows, 2);
    assert.equal(summary.statistics.totalCells, result.cellStatsLength());
    assert.equal(summary.statistics.totalIntervalCount, result.intervalsLength());
    assert.ok(Number.isFinite(summary.statistics.percentCoverage));
    assert.ok(Number.isFinite(summary.statistics.meanRevisitTimeSec));
    assert.ok(Number.isFinite(summary.statistics.meanResponseTimeSec));
    assert.ok(
      result.timeSeriesLength() > 0,
      "SCV analytics result must carry module-authored metric time-series products",
    );
    const metricKinds = new Set();
    for (let index = 0; index < result.timeSeriesLength(); index += 1) {
      metricKinds.add(result.TIME_SERIES(index).METRIC_KIND());
    }
    assert.ok(metricKinds.has(scvMetricSeriesKind.PERCENT_COVERED));
    assert.ok(metricKinds.has(scvMetricSeriesKind.ACCESS_COUNT));
    assert.ok(metricKinds.has(scvMetricSeriesKind.CONTACT_DURATION_SECONDS));
    assert.ok(metricKinds.has(scvMetricSeriesKind.REVISIT_SECONDS));
    assert.ok(metricKinds.has(scvMetricSeriesKind.GAP_SECONDS));
    assert.ok(metricKinds.has(scvMetricSeriesKind.REDUNDANCY));
    assert.equal(result.GEOMETRY(), null);
  });

  test(`sensor coverage module honors SCV swath mode without grid analytics on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await harness.invoke({
      methodId: "compute_sensor_coverage",
      inputs: [
        {
          portId: "coverage",
          typeRef: {
            schemaName: "SCV/main.fbs",
            fileIdentifier: "$SCV",
            rootTypeName: "SCV",
          },
          payload: createScvSwathOnlyCoverageRequestPayload(),
        },
      ],
    });

    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(
      response.outputs.some((frame) => frame.typeRef?.fileIdentifier === "JSON"),
      false,
      "SCV swath request must not emit JSON compatibility results",
    );
    const resultEnvelope = findScvEnvelope(response, scvEnvelopeKind.RESULT);
    assert.ok(resultEnvelope, "missing canonical SCV result output frame");
    const result = resultEnvelope.envelope.RESULT();
    assert.ok(result, "missing SCV RESULT payload");
    assert.equal(result.TOTAL_SENSORS(), 1);
    assert.equal(result.TOTAL_WINDOWS(), 2);
    assert.equal(result.cellStatsLength(), 0);
    assert.equal(result.intervalsLength(), 0);
    assertRenderableScvGeometry(result, 2);
  });

  test(`sensor coverage module emits SDS SCV progress frames on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await harness.invoke({
      methodId: "compute_sensor_coverage",
      inputs: [
        {
          portId: "coverage",
          typeRef: {
            schemaName: "SCV/main.fbs",
            fileIdentifier: "$SCV",
            rootTypeName: "SCV",
          },
          payload: createScvCoverageRequestPayload(),
        },
      ],
    });

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

    const response = await harness.invoke({
      methodId: "compute_sensor_coverage",
      inputs: [
        {
          portId: "coverage",
          typeRef: {
            schemaName: "SCV/main.fbs",
            fileIdentifier: "$SCV",
            rootTypeName: "SCV",
          },
          payload: createScvCoverageRequestPayload({ windowCount: 5 }),
        },
      ],
    });

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

    const response = await harness.invoke({
      methodId: "compute_sensor_coverage",
      inputs: [
        {
          portId: "coverage",
          typeRef: JSON_COVERAGE_REQUEST_TYPE,
          payload: Buffer.from(
            JSON.stringify(createSingleSensorCoverageRequest()),
            "utf8",
          ),
        },
      ],
    });

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
    assert.equal(result.cellStatsLength(), 24);
    assertRenderableScvGeometry(result, 2);
  });

  test(`sensor coverage module aggregates all active sensors into one differential geometry product on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

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
    const sharedStates = [
      makeState(-0.08, 0),
      makeState(-0.04, 600),
      makeState(0, 1200),
      makeState(0.04, 1800),
      makeState(0.08, 2400),
    ];

    const sensors = Array.from({ length: 3 }, (_, sensorIndex) => ({
      sensorId: sensorIndex,
      type: "conic",
      outerHalfAngleRad: 0.22,
      radiusMeters: 1600000,
      states: sharedStates,
    }));

    const result = await invokeJsonRequest(
      harness,
      {
        coverageSource: {
          brand: "OrbPro",
          mode: "all active sensors in one analysis",
          attachedToPropagatedEntity: true,
          positionPropertyType: "PropagatedPositionProperty",
          requestedSensorCount: sensors.length,
        },
        sensors,
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
          stopSeconds: 2400,
        },
        figureOfMerit: "percent_coverage",
        outputMode: "aggregate_differential_geometry",
      },
      {
        methodId: "compute_sensor_coverage",
        inputPortId: "coverage",
        outputPortId: "coverage",
        inputTypeRef: JSON_COVERAGE_REQUEST_TYPE,
      },
    );

    assert.equal(result.provider, "sensor-coverage-analysis");
    assert.equal(result.statistics.activeSensorCount, 3);
    assert.equal(result.swaths.length, 12);
    assert.equal(result.aggregateGeometry.contract, "orbpro.coverage.aggregate.v0");
    assert.equal(result.aggregateGeometry.aggregation, "all_active_sensors");
    assert.equal(result.aggregateGeometry.operationMode, "additive_deltas");
    assert.equal(result.aggregateGeometry.activeSensorCount, 3);
    assert.equal(result.aggregateGeometry.full.kind, "multipolygon");
    assert.equal(result.aggregateGeometry.full.polygonCount, result.swaths.length);
    assert.equal(result.aggregateGeometry.full.ringReference, "swaths[].vertices");
    assert.equal(result.aggregateGeometry.deltas.length, result.swaths.length);
    assert.ok(
      result.aggregateGeometry.deltas.every((delta) => delta.operation === "add"),
    );
    assert.ok(
      result.aggregateGeometry.deltas.every((delta) =>
        Number.isInteger(delta.chunkId),
      ),
    );
    assert.ok(
      result.cells.some((cell) => cell.sensorContributionCount > 1),
      "expected at least one grid cell to record overlapping sensor contribution",
    );
    assert.ok(
      Array.isArray(result.coverageIntervals),
      "coverage result should expose merged access intervals",
    );
    assert.ok(result.coverageIntervals.length > 0);
    assert.equal(
      result.statistics.totalIntervalCount,
      result.coverageIntervals.length,
    );
    assert.ok(Number.isFinite(result.statistics.maxGapDurationSec));
    assert.ok(Number.isFinite(result.statistics.meanRevisitTimeSec));
    assert.ok(Number.isFinite(result.statistics.maxResponseTimeSec));
    assert.ok(Number.isFinite(result.statistics.meanResponseTimeSec));
    assert.ok(Number.isInteger(result.statistics.totalRevisitCount));
    assert.ok(
      result.coverageIntervals.every(
        (interval) =>
          interval.stopSeconds > interval.startSeconds &&
          interval.durationSec === interval.stopSeconds - interval.startSeconds,
      ),
    );
    assert.ok(
      result.cells.some(
        (cell) =>
          cell.intervals.length > 0 &&
          Number.isFinite(cell.firstResponseTimeSec) &&
          Number.isFinite(cell.maxResponseTimeSec),
      ),
      "expected covered cells to include interval and response metrics",
    );
    assert.deepEqual(
      Object.keys(result.figureOfMerit.products).sort(),
      [
        "gap_time",
        "percent_coverage",
        "response_time",
        "revisit_time",
      ],
    );
    assert.equal(result.figureOfMerit.products.percent_coverage.units, "percent");
    assert.equal(result.figureOfMerit.products.gap_time.units, "seconds");
    assert.equal(result.figureOfMerit.products.revisit_time.units, "seconds");
    assert.equal(result.figureOfMerit.products.response_time.units, "seconds");
    assert.equal(
      result.figureOfMerit.products.response_time.values.length,
      result.grid.cellCount,
    );
  });

  test(`sensor coverage module can return authoritative swath-only geometry without FOM accumulation on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const request = createSingleSensorCoverageRequest();
    request.figureOfMerit = "none";
    request.outputMode = "swath_only";

    const result = await invokeJsonRequest(
      harness,
      request,
      {
        methodId: "compute_sensor_coverage",
        inputPortId: "coverage",
        outputPortId: "coverage",
        inputTypeRef: JSON_COVERAGE_REQUEST_TYPE,
      },
    );

    assert.equal(result.provider, "sensor-coverage-analysis");
    assert.equal(result.statistics.activeSensorCount, 1);
    assert.equal(result.swaths.length, 2);
    assert.equal(result.aggregateGeometry.full.polygonCount, result.swaths.length);
    assert.equal(result.cells.length, 0);
    assert.equal(result.coverageIntervals.length, 0);
    assert.equal(result.figureOfMerit.type, "none");
    assert.deepEqual(result.figureOfMerit.values, []);
    assert.deepEqual(result.figureOfMerit.products, {});
  });

  test(`sensor coverage module can return analytics-only FOM without serializing swath visualization products on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const request = createSeparatedContributorCoverageRequest();
    request.figureOfMerit = "percent_coverage";
    request.outputMode = "analytics_only";

    const response = await harness.invoke({
      methodId: "compute_sensor_coverage",
      inputs: [
        {
          portId: "coverage",
          typeRef: JSON_COVERAGE_REQUEST_TYPE,
          payload: Buffer.from(JSON.stringify(request), "utf8"),
        },
      ],
    });
    assert.equal(response.statusCode, 0, response.errorMessage);
    const jsonFrame = response.outputs.find(
      (frame) => frame.typeRef?.fileIdentifier === "JSON",
    );
    assert.ok(jsonFrame, "analytics-only request must emit JSON analytics");
    assert.equal(
      findScvEnvelope(response, scvEnvelopeKind.RESULT),
      undefined,
      "analytics-only JSON request must not emit unused SCV visualization frames",
    );
    const result = JSON.parse(new TextDecoder().decode(jsonFrame.payload));

    assert.equal(result.provider, "sensor-coverage-analysis");
    assert.equal(result.statistics.activeSensorCount, 2);
    assert.equal(result.statistics.swathCount, 0);
    assert.ok(result.cells.length > 0);
    assert.equal(result.cells.length, result.statistics.accessedCells);
    assert.ok(result.coverageIntervals.length > 0);
    assert.equal(result.figureOfMerit.type, "percent_coverage");
    assert.equal(result.swaths.length, 0);
    assert.equal(result.aggregateGeometry.full.polygonCount, 0);
  });

  test(`sensor coverage module accepts a 1000-sensor analysis without splitting work per sensor on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const earthRadius = 6378137.0;
    const orbitRadius = earthRadius + 550000.0;
    const speed = 7560.0;
    const sensors = Array.from({ length: 1000 }, (_, sensorIndex) => {
      const phase = (2 * Math.PI * sensorIndex) / 1000;
      const inclination = 0.22 * Math.sin(sensorIndex * 0.37);
      const makeState = (theta, elapsedSeconds) => ({
        elapsedSeconds,
        position: {
          x: orbitRadius * Math.cos(theta + phase),
          y: orbitRadius * Math.sin(theta + phase),
          z: orbitRadius * inclination * Math.sin(theta + phase),
        },
        velocity: {
          x: -speed * Math.sin(theta + phase),
          y: speed * Math.cos(theta + phase),
          z: speed * inclination * Math.cos(theta + phase),
        },
      });
      return {
        sensorId: sensorIndex,
        type: "conic",
        outerHalfAngleRad: 0.055,
        radiusMeters: 900000,
        angularSamples: 8,
        states: [makeState(0, 0), makeState(0.025, 180)],
      };
    });

    const result = await invokeJsonRequest(
      harness,
      {
        coverageSource: {
          brand: "OrbPro",
          mode: "1000 satellite aggregate coverage",
          requestedSensorCount: sensors.length,
        },
        sensors,
        grid: {
          minLatitudeDeg: -30,
          maxLatitudeDeg: 30,
          minLongitudeDeg: -180,
          maxLongitudeDeg: 180,
          latitudeStepDeg: 15,
          longitudeStepDeg: 30,
        },
        timeSpan: {
          startSeconds: 0,
          stopSeconds: 180,
        },
        figureOfMerit: "percent_coverage",
        outputMode: "aggregate_differential_geometry",
      },
      {
        methodId: "compute_sensor_coverage",
        inputPortId: "coverage",
        outputPortId: "coverage",
        inputTypeRef: JSON_COVERAGE_REQUEST_TYPE,
      },
    );

    assert.equal(result.statistics.activeSensorCount, 1000);
    assert.equal(result.swaths.length, 1000);
    assert.equal(result.aggregateGeometry.activeSensorCount, 1000);
    assert.equal(result.aggregateGeometry.full.polygonCount, 1000);
    assert.equal(result.aggregateGeometry.deltas.length, 1000);
    assert.ok(result.statistics.accessedCells > 0);

    const highSensorCell = result.cells.find(
      (cell) =>
        Array.isArray(cell.sensorIds) &&
        cell.sensorIds.some((sensorId) => sensorId >= 32),
    );
    assert.ok(
      highSensorCell,
      "expected exact contributing sensor ids beyond the legacy 32-bit mask",
    );
    assert.equal(
      highSensorCell.sensorContributionCount,
      highSensorCell.sensorIds.length,
    );
    assert.ok(Array.isArray(highSensorCell.sensorBitsetWords));
    assert.ok(
      highSensorCell.sensorBitsetWords.length >=
        Math.floor(Math.max(...highSensorCell.sensorIds) / 64) + 1,
    );
    assert.ok(
      highSensorCell.sensorBitsetWords.every((word) => typeof word === "string"),
      "JSON compatibility results should encode 64-bit bitset words as decimal strings",
    );
    assert.ok(
      result.coverageIntervals.every((interval) => Array.isArray(interval.sensorIds)),
      "coverage intervals should expose exact contributing sensor ids",
    );
  });

  test(`sensor coverage intervals preserve exact per-interval contributors beyond 32 sensors on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(
      harness,
      createSeparatedContributorCoverageRequest(),
      {
        methodId: "compute_sensor_coverage",
        inputPortId: "coverage",
        outputPortId: "coverage",
        inputTypeRef: JSON_COVERAGE_REQUEST_TYPE,
      },
    );

    const intervalsByCell = new Map();
    for (const interval of result.coverageIntervals) {
      const intervals = intervalsByCell.get(interval.cellIndex) ?? [];
      intervals.push(interval);
      intervalsByCell.set(interval.cellIndex, intervals);
    }
    const intervals = Array.from(intervalsByCell.values())
      .find(
        (entries) =>
          entries.some((interval) => interval.sensorIds.includes(0)) &&
          entries.some((interval) => interval.sensorIds.includes(33)),
      )
      ?.sort((left, right) => left.startSeconds - right.startSeconds) ?? [];
    assert.equal(intervals.length, 2);
    assert.deepEqual(intervals[0].sensorIds, [0]);
    assert.deepEqual(intervals[1].sensorIds, [33]);
    assert.equal(intervals[1].sensorContributionCount, 1);
    assert.deepEqual(intervals[1].sensorBitsetWords, ["8589934592"]);
  });

  test(`sensor coverage SCV result emits canonical access intervals beyond 32 sensors on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await harness.invoke({
      methodId: "compute_sensor_coverage",
      inputs: [
        {
          portId: "coverage",
          typeRef: JSON_COVERAGE_REQUEST_TYPE,
          payload: Buffer.from(
            JSON.stringify(createSeparatedContributorCoverageRequest()),
            "utf8",
          ),
        },
      ],
    });

    assert.equal(response.statusCode, 0, response.errorMessage);
    const resultEnvelope = findScvEnvelope(response, scvEnvelopeKind.RESULT);
    assert.ok(resultEnvelope, "missing canonical SCV result output frame");
    const result = resultEnvelope.envelope.RESULT();
    assert.ok(result, "missing SCV RESULT payload");
    assert.ok(result.intervalsLength() >= 2);

    const intervals = Array.from(
      { length: result.intervalsLength() },
      (_, index) => result.INTERVALS(index),
    );
    const intervalsByCell = new Map();
    for (const interval of intervals) {
      const cellIntervals = intervalsByCell.get(interval.CELL_ID()) ?? [];
      cellIntervals.push(interval);
      intervalsByCell.set(interval.CELL_ID(), cellIntervals);
    }
    const cellIntervals =
      Array.from(intervalsByCell.values())
        .find(
          (entries) =>
            entries.some((interval) => interval.SENSOR_ID() === 0) &&
            entries.some((interval) => interval.SENSOR_ID() === 33),
        )
        ?.sort((left, right) => left.START_OFFSET_SEC() - right.START_OFFSET_SEC()) ?? [];
    assert.equal(cellIntervals.length, 2);
    assert.equal(cellIntervals[0].SENSOR_ID(), 0);
    assert.equal(cellIntervals[1].SENSOR_ID(), 33);
    assert.equal(cellIntervals[0].INTERVAL_KIND(), scvIntervalCategory.ACCESS);
    assert.equal(cellIntervals[1].INTERVAL_KIND(), scvIntervalCategory.ACCESS);
    assert.equal(
      cellIntervals[1].DURATION_SEC(),
      cellIntervals[1].STOP_OFFSET_SEC() - cellIntervals[1].START_OFFSET_SEC(),
    );
    assert.ok(cellIntervals[1].START_OFFSET_SEC() >= 3600);
  });

  test(`sensor coverage module handles the dense 1000-satellite Sandcastle batch shape on ${runtimeKind}`, async (t) => {
    if (runtimeKind !== "browser") {
      t.skip("Dense Sandcastle batch stress is guarded on the browser worker path.");
      return;
    }
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const earthRadius = 6378137.0;
    const orbitRadius = earthRadius + 500000.0;
    const speed = 7612.608173223869;
    const stateCount = 25;
    const sensorCount = 400;
    const stepSeconds = 5;
    const meanMotion = speed / orbitRadius;
    const sensors = Array.from({ length: sensorCount }, (_, sensorIndex) => {
      const phase = (2 * Math.PI * sensorIndex) / 1000;
      const ringIndex = Math.floor(sensorIndex / 25);
      const inclinationScale = 0.12;
      const makeState = (stateIndex) => {
        const elapsedSeconds = stateIndex * stepSeconds;
        const theta = -0.22 + phase + meanMotion * elapsedSeconds;
        const zTheta = theta * 0.7 + ringIndex * ((2 * Math.PI) / 40);
        return {
          elapsedSeconds,
          position: {
            x: orbitRadius * Math.cos(theta),
            y: orbitRadius * Math.sin(theta),
            z: orbitRadius * inclinationScale * Math.sin(zTheta),
          },
          velocity: {
            x: -speed * Math.sin(theta),
            y: speed * Math.cos(theta),
            z: speed * inclinationScale * 0.7 * Math.cos(zTheta),
          },
        };
      };
      return {
        sensorId: sensorIndex,
        type: "conic",
        outerHalfAngleRad: (12.5 * Math.PI) / 180,
        radiusMeters: 1600000,
        angularSamples: 8,
        states: Array.from({ length: stateCount }, (_, stateIndex) =>
          makeState(stateIndex),
        ),
      };
    });

    const result = await invokeJsonRequest(
      harness,
      {
        coverageSource: {
          brand: "OrbPro",
          mode: "1000 satellite aggregate coverage first worker batch",
          requestedSensorCount: 1000,
          batchStartSensorIndex: 0,
          batchSensorCount: sensorCount,
        },
        sensors,
        grid: {
          minLatitudeDeg: -90,
          maxLatitudeDeg: 90,
          minLongitudeDeg: -180,
          maxLongitudeDeg: 180,
          latitudeStepDeg: 5,
          longitudeStepDeg: 5,
        },
        timeSpan: {
          startSeconds: 0,
          stopSeconds: 120,
        },
        figureOfMerit: "percent_coverage",
        outputMode: "aggregate_differential_geometry",
      },
      {
        methodId: "compute_sensor_coverage",
        inputPortId: "coverage",
        outputPortId: "coverage",
        inputTypeRef: JSON_COVERAGE_REQUEST_TYPE,
      },
    );

    assert.equal(result.statistics.activeSensorCount, sensorCount);
    assert.equal(result.swaths.length, sensorCount * (stateCount - 1));
    assert.equal(result.aggregateGeometry.full.polygonCount, result.swaths.length);
    assert.ok(result.statistics.accessedCells > 0);
    assert.ok(result.coverageIntervals.length > 0);
  });

  test(`sensor coverage module derives moving Orekit-style swaths from sensor-attached states on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

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

    const result = await invokeJsonRequest(
      harness,
      {
        coverageSource: {
          brand: "OrbPro",
          mode: "OrbPro Sensor attached to propagated entity",
          sensorObject: "Cesium.Sensor",
          ownerEntityId: "orbpro-coverage-sat",
          sensorEntityId: "orbpro-coverage-sat",
          attachedToPropagatedEntity: true,
          positionPropertyType: "PropagatedPositionProperty",
          sampleCount: 5,
        },
        sensor: {
          sensorId: 0,
          type: "conic",
          outerHalfAngleRad: 0.22,
          radiusMeters: 1600000,
        },
        states: [
          makeState(-0.08, 0),
          makeState(-0.04, 600),
          makeState(0, 1200),
          makeState(0.04, 1800),
          makeState(0.08, 2400),
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
          stopSeconds: 2400,
        },
        figureOfMerit: "percent_coverage",
        colorMap: "orbpro_coverage",
      },
      {
        methodId: "compute_sensor_coverage",
        inputPortId: "coverage",
        outputPortId: "coverage",
        inputTypeRef: JSON_COVERAGE_REQUEST_TYPE,
      },
    );

    assert.equal(result.provider, "sensor-coverage-analysis");
    assert.equal(result.coverageSource.brand, "OrbPro");
    assert.equal(result.coverageSource.attachedToPropagatedEntity, true);
    assert.equal(result.coverageSource.positionPropertyType, "PropagatedPositionProperty");
    assert.equal(result.grid.cellCount, 96);
    assert.equal(result.swathMode, "orekit_along_track_swath");
    assert.equal(result.swaths.length, 4);
    assert.ok(result.statistics.accessedCells > 0);
    assert.ok(result.statistics.totalAccessDurationSec > 0);
    assert.ok(result.statistics.percentCoverage > 0);
    assert.ok(result.swaths.every((swath) => swath.kind === "orekit_along_track_swath"));
    assert.ok(result.swaths.every((swath) => swath.vertices.length === 4));
    assert.ok(result.swaths.every((swath) => swath.leftEdge.length === 2));
    assert.ok(result.swaths.every((swath) => swath.rightEdge.length === 2));
    assert.ok(result.swaths.every((swath) => swath.colorRgba.length === 4));
    assert.notEqual(
      result.swaths[0].vertices[0].longitudeDeg,
      result.swaths.at(-1).vertices[0].longitudeDeg,
    );
    assert.ok(
      result.swaths.at(-1).centerline[1].longitudeDeg >
        result.swaths[0].centerline[0].longitudeDeg,
    );
    assert.equal(result.figureOfMerit.values.length, 96);
    assert.equal(result.figureOfMerit.units, "percent");
  });

  test(`sensor coverage module honors the supplied time-dynamic sensor frame on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const earthRadius = 6378137.0;
    const orbitRadius = earthRadius + 500000.0;
    const speed = 7612.608173223869;
    const offNadirRad = 0.28;
    const makeState = (theta, elapsedSeconds, offNadirAlongTrackRad = 0) => {
      const radial = {
        x: Math.cos(theta),
        y: Math.sin(theta),
        z: 0,
      };
      const along = {
        x: -Math.sin(theta),
        y: Math.cos(theta),
        z: 0,
      };
      const cross = {
        x: 0,
        y: 0,
        z: 1,
      };
      const nadir = {
        x: -radial.x,
        y: -radial.y,
        z: 0,
      };
      const cos = Math.cos(offNadirAlongTrackRad);
      const sin = Math.sin(offNadirAlongTrackRad);
      return {
        elapsedSeconds,
        position: {
          x: orbitRadius * radial.x,
          y: orbitRadius * radial.y,
          z: 0,
        },
        velocity: {
          x: speed * along.x,
          y: speed * along.y,
          z: 0,
        },
        sensorFrame: {
          boresight: {
            x: nadir.x * cos + along.x * sin,
            y: nadir.y * cos + along.y * sin,
            z: 0,
          },
          xAxis: {
            x: along.x * cos - nadir.x * sin,
            y: along.y * cos - nadir.y * sin,
            z: 0,
          },
          yAxis: cross,
        },
      };
    };
    const baseRequest = {
      coverageSource: {
        brand: "OrbPro",
        mode: "OrbPro Sensor attached to propagated entity",
        sensorObject: "Cesium.Sensor",
        attachedToPropagatedEntity: true,
        positionPropertyType: "PropagatedPositionProperty",
        sensorFrameSource: "entity.computeModelMatrix",
      },
      sensor: {
        sensorId: 0,
        type: "conic",
        outerHalfAngleRad: 0.08,
        radiusMeters: 1600000,
      },
      grid: {
        minLatitudeDeg: -8,
        maxLatitudeDeg: 8,
        minLongitudeDeg: -16,
        maxLongitudeDeg: 16,
        latitudeStepDeg: 2,
        longitudeStepDeg: 2,
      },
      timeSpan: {
        startSeconds: 0,
        stopSeconds: 1200,
      },
      figureOfMerit: "percent_coverage",
      colorMap: "orbpro_coverage",
    };

    const nadirResult = await invokeJsonRequest(
      harness,
      {
        ...baseRequest,
        states: [
          makeState(-0.03, 0),
          makeState(0, 600),
          makeState(0.03, 1200),
        ],
      },
      {
        methodId: "compute_sensor_coverage",
        inputPortId: "coverage",
        outputPortId: "coverage",
        inputTypeRef: JSON_COVERAGE_REQUEST_TYPE,
      },
    );

    const offNadirResult = await invokeJsonRequest(
      harness,
      {
        ...baseRequest,
        states: [
          makeState(-0.03, 0, offNadirRad),
          makeState(0, 600, offNadirRad),
          makeState(0.03, 1200, offNadirRad),
        ],
      },
      {
        methodId: "compute_sensor_coverage",
        inputPortId: "coverage",
        outputPortId: "coverage",
        inputTypeRef: JSON_COVERAGE_REQUEST_TYPE,
      },
    );

    const nadirLongitude = nadirResult.swaths[0].centerline[0].longitudeDeg;
    const offNadirLongitude =
      offNadirResult.swaths[0].centerline[0].longitudeDeg;
    assert.ok(
      offNadirLongitude > nadirLongitude + 0.5,
      `expected supplied sensor frame to move swath centerline, got ${nadirLongitude} and ${offNadirLongitude}`,
    );
    assert.equal(
      offNadirResult.coverageSource.sensorFrameSource,
      "entity.computeModelMatrix",
    );
  });

  test(`sensor coverage module projects footprints on the WGS84 ellipsoid on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(
      harness,
      createHighLatitudeWgs84CoverageRequest(),
      {
        methodId: "compute_sensor_coverage",
        inputPortId: "coverage",
        outputPortId: "coverage",
        inputTypeRef: JSON_COVERAGE_REQUEST_TYPE,
      },
    );

    assert.equal(result.provider, "sensor-coverage-analysis");
    assert.equal(result.footprints.length, 3);
    assert.ok(result.swaths.length >= 2);
    assert.ok(
      result.footprints.every(
        (footprint) => Math.abs(footprint.center.latitudeDeg - 60) < 1.0e-4,
      ),
      `WGS84 geodetic nadir centers should stay near 60 deg latitude, got ${result.footprints
        .map((footprint) => footprint.center.latitudeDeg.toFixed(6))
        .join(", ")}`,
    );
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
      const response = await harness.invoke({
        methodId: "compute_sensor_coverage",
        inputs: [
          {
            portId: "coverage",
            typeRef: {
              schemaName: "SCV/main.fbs",
              fileIdentifier: "$SCV",
              rootTypeName: "SCV",
            },
            payload: createScvOffNadirCoverageRequestPayload(offNadirRad),
          },
        ],
      });
      assert.equal(response.statusCode, 0, response.errorMessage);
      const resultEnvelope = findScvEnvelope(response, scvEnvelopeKind.RESULT);
      assert.ok(resultEnvelope, "missing canonical SCV result output frame");
      const geometry = resultEnvelope.envelope.RESULT()?.GEOMETRY();
      assert.ok(geometry, "SCV result must include packed geometry");
      assert.ok(geometry.segmentsLength() > 0, "SCV geometry must include swath segments");
      const firstSegment = geometry.SEGMENTS(0);
      const vertexOffset = firstSegment.VERTEX_OFFSET() * 2;
      const leftStartLon = geometry.REVEAL_COORDS(vertexOffset);
      const rightStartLon = geometry.REVEAL_COORDS(vertexOffset + 6);
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
