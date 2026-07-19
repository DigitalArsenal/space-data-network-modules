#ifdef DOMAIN
#undef DOMAIN
#endif
#ifndef SDN_BUNDLED_SDS_CPP_HEADERS
#include "SCV/main_generated.h"
#endif

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <map>
#include <pthread.h>
#include <thread>
#include <utility>
#include <vector>

using namespace sdn_hypersonics;

namespace {

// The module build concatenates these shared core files from symlinks in this
// directory before this source is compiled.
#if 0
#include "sensor_shape_model.h"
#include "sensor_shape_model.cpp.inc"
#include "sensor_coverage_core.h"
#include "sensor_coverage_core.cpp.inc"
#endif

constexpr double kEarthRadiusM = 6378137.0;
constexpr double kWgs84A = 6378137.0;
constexpr double kWgs84B = 6356752.3142451793;
constexpr double kWgs84A2 = kWgs84A * kWgs84A;
constexpr double kWgs84B2 = kWgs84B * kWgs84B;
constexpr double kWgs84E2 = 1.0 - kWgs84B2 / kWgs84A2;
constexpr double kWgs84Ep2 = kWgs84A2 / kWgs84B2 - 1.0;
constexpr double kRadiansToDegrees = 180.0 / 3.14159265358979323846;
constexpr double kSensorShapeEpsilon = 1.0e-12;
constexpr double kCoverageSwathRenderAltitudeM = 1200.0;
constexpr int kVisibilityTransitionRefinementIterations = 8;
constexpr int kVisibilitySearchMaxDepth = 12;
constexpr double kMaximumGeodeticGeocentricLatitudeSeparationDeg =
  0.19242430115956035;
constexpr size_t kGridCellCacheMaxEntries = 4;
constexpr int kGridTileRowSpan = 8;
constexpr int kGridTileColumnSpan = 8;
constexpr uint32_t kGeometryPositionsRegionId = 1;
constexpr uint32_t kGeometryNormalsRegionId = 2;
constexpr uint32_t kGeometryStRegionId = 3;
constexpr uint32_t kGeometryRevealCoordsRegionId = 4;
constexpr uint32_t kGeometryIndicesRegionId = 5;
constexpr uint32_t kRasterRegionBaseId = 1000;

// ── Area/point-target region gate (area-targets Phase 1) ─────────────────────
// While a ground target (POINT / POLYGON) is being accumulated this thread-local
// points at that target's immutable spatial region. It narrows EVERY footprint
// acceptance to witnesses that also lie inside the region (containsWorldPoint)
// and suppresses the cap-inside-rectangle fast-accepts (spherical_cap_inside_cell
// and everything that funnels through it), so a target hit always requires a
// concrete witness inside footprint AND region. The gate NEVER prunes: a
// rejected point is simply "not visible", so the exact-accept/conservative-reject
// subdivision continues unchanged. It is nullptr for all grid-cell work, which
// keeps the cell path byte-identical. Each target is owned by exactly one worker
// and the region is const during accumulation, so no synchronization is needed.
// See design/AREA_TARGETS_REVISIT_DESIGN.md (§1 hit predicate + GUARDIAN GATE).
thread_local const sdn_spatial_region::SpatialRegion* t_target_region_gate =
  nullptr;
// When the active target is a ground POINT (BoundingSphere) these carry its
// sub-point + angular radius so the witness subdivision can prune patches that
// are provably outside the sphere. This is a SOUND, target-only, prune-only
// bound (a patch entirely outside the region holds no region∩footprint witness),
// so it never affects an accept — it only stops the search from exhausting the
// footprint area for a point target whose footprint sits just off the region.
thread_local bool t_target_is_point = false;
thread_local double t_target_point_lat_deg = 0.0;
thread_local double t_target_point_lon_deg = 0.0;
thread_local double t_target_point_radius_deg = 0.0;

double inflate_proof_upper_bound(double value);
double deflate_proof_lower_bound(double value);

struct Interval {
  double start = 0.0;
  double stop = 0.0;
  std::vector<int> contributingSensorIds;
};

struct Vec3 {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

struct SensorFrame {
  Vec3 boresight;
  Vec3 xAxis;
  Vec3 yAxis;
  bool valid = false;
};

struct Quaternion {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double w = 1.0;
};

using Vertex = sdn::coverage::LonLat;

struct Cartographic {
  double longitudeRad = 0.0;
  double latitudeRad = 0.0;
  double altitudeM = 0.0;
};

struct State {
  double elapsedSeconds = 0.0;
  Vec3 position;
  Vec3 velocity;
  SensorFrame sensorFrame;
};

struct ResolvedVisibilityState {
  State state;
  SensorFrame frame;
};

struct SensorConfig {
  int sensorId = 0;
  SensorShapeContract shapeContract;
  std::vector<SensorVec3> localBoundaryDirections;
  double maxBoundaryAngleRad = 0.0;
  double outerHalfAngleCosLower = -1.0;
  double outerHalfAngleCosUpper = -1.0;
  double outerHalfAngleSinUpper = 0.0;
  double innerHalfAngleCosLower = 1.0;
  double inclusiveOuterBoundaryCosLower = 1.0;
  double inclusiveInnerBoundaryCosUpper = 1.0;
  double membershipOuterBoundaryCos = 1.0;
  double membershipInnerBoundaryCos = 1.0;
  bool inclusiveOuterBoundaryAlwaysAccepted = false;
  bool inclusiveInnerBoundaryAlwaysAccepted = true;
  bool inclusiveInnerBoundaryImpossible = false;
  double clockCenterCos = 1.0;
  double clockCenterSin = 0.0;
  double clockHalfSpanRad = 3.14159265358979323846;
  double clockBoundaryCosLower = -1.0;
  double membershipClockBoundaryCos = -1.0;
  double clockBoundarySinLower = 0.0;
  double clockBoundarySinUpper = 0.0;
  bool clockMembershipAlwaysAccepted = true;
  bool clockMembershipNeedsScalarFallback = false;
  bool clockZeroAccepted = true;
  double inclusiveCrossTrackTangentUpper = 0.0;
  double inclusiveAlongTrackTangentUpper = 0.0;
  bool inclusiveCrossTrackAlwaysAccepted = false;
  bool inclusiveAlongTrackAlwaysAccepted = false;
  SensorVec3 representativeLocalDirection;
  bool hasRepresentativeLocalDirection = false;
  std::vector<SensorVec3> fixedWitnessLocalDirections;
};

struct SensorTrack {
  SensorConfig sensor;
  std::vector<State> states;
};

struct FootprintSample {
  int sensorId = 0;
  double elapsedSeconds = 0.0;
  Vertex center;
  Vertex left;
  Vertex right;
  std::vector<Vertex> vertices;
  bool boundaryComplete = false;
};

struct SurfacePatchGeometry {
  float centerX = 0.0f;
  float centerY = 0.0f;
  float centerZ = 0.0f;
  float radiusM = -1.0f;
};

struct SwathSegment {
  int index = 0;
  int sensorId = 0;
  double start = 0.0;
  double stop = 0.0;
  Vertex leftStart;
  Vertex leftStop;
  Vertex rightStart;
  Vertex rightStop;
  Vertex centerStart;
  Vertex centerStop;
};

struct GridCellGeometry {
  Vec3 surfacePosition;
  Vec3 surfaceNormal;
  Vec3 surfaceUnit;
  // 3x3 lat/lon lattice: center, edge midpoints, and corners. This is only a
  // fast accept path. Solid conics additionally search the continuous WGS84
  // rectangle with rejection-safe patch bounds and exact point witnesses.
  Vec3 samplePositions[9];
  Vec3 sampleNormals[9];
  int sampleCount = 0;
  double minLatitudeDeg = 0.0;
  double maxLatitudeDeg = 0.0;
  double minGeocentricLatitudeDeg = 0.0;
  double maxGeocentricLatitudeDeg = 0.0;
  double minLongitudeDeg = 0.0;
  double maxLongitudeDeg = 0.0;
  double maximumParallelDerivativeM = kWgs84A;
  // Lazily populated quadtree geometry for proof-only surface bounds. These
  // values depend solely on the immutable cell rectangle and are reused across
  // every state segment and invocation served by the grid cache.
  mutable std::vector<SurfacePatchGeometry> surfacePatchCache;
};

struct CellBounds {
  int tileRow = 0;
  int tileColumn = 0;
  int tileId = 0;
  double minLatitudeDeg = 0.0;
  double maxLatitudeDeg = 0.0;
  double minLongitudeDeg = 0.0;
  double maxLongitudeDeg = 0.0;
  Vec3 centerUnit;
};

struct Cell {
  int index = 0;
  int row = 0;
  int column = 0;
  double latitude = 0.0;
  double longitude = 0.0;
  CellBounds bounds;
  Vec3 surfaceUnit;
  GridCellGeometry geometry;
  bool surfaceUnitReady = false;
  bool geometryReady = false;
  std::vector<Interval> intervals;
  std::vector<uint32_t> passStartBuckets;
  std::vector<int> contributingSensorIds;
  double totalAccess = 0.0;
  double maxGap = 0.0;
  double meanRevisit = 0.0;
  double firstResponse = 0.0;
  double maxResponse = 0.0;
  double meanResponse = 0.0;
  double totalGap = 0.0;
  double revisitGapTotal = 0.0;
  int accessCount = 0;
  int revisitCount = 0;
};

struct GridConfig {
  double minLat = -90.0;
  double maxLat = 90.0;
  double minLon = -180.0;
  double maxLon = 180.0;
  double latStep = 1.0;
  double lonStep = 1.0;
  double start = 0.0;
  double stop = 0.0;
  double step = 0.0;
  uint32_t gridIndexStart = 0;
  uint32_t gridIndexCount = 0;
  std::string epochIso;
  double epochJulianDate = 0.0;
  int rows = 0;
  int columns = 0;
};

struct CachedGridCells {
  std::string key;
  std::vector<Cell> cells;
};

// One accumulator per SCVTarget. It embeds a Cell so the exact per-cell interval
// machinery (merge_intervals + update_cell_statistics) runs verbatim over the
// target — identical tangency / pass-splitting / revisit semantics. `region` is
// the immutable spatial region (constructed before fan-out, const during
// accumulation) that gates every footprint acceptance to the target. `rejected`
// targets (unsupported kind/domain or antimeridian-crossing polygon) carry no
// region and produce a zero-coverage result, preserving target-index order.
struct TargetAccumulator {
  Cell cell;
  sdn_spatial_region::SpatialRegion region{
    sdn_spatial_region::SpatialRegionType::BOUNDING_SPHERE};
  uint32_t targetId = 0;
  std::string name;
  bool rejected = false;
  // Conservative segment-level cull geometry (see target_region_disjoint_from_cap).
  // For a POINT: a lon/lat disc. For a POLYGON: the ring in [lon,lat] degrees.
  bool boundIsPoint = false;
  double boundPointLatDeg = 0.0;
  double boundPointLonDeg = 0.0;
  double boundPointRadiusDeg = 0.0;
  std::vector<double> boundRingLonLatDeg;
};

struct CoverageInput {
  GridConfig grid;
  std::vector<SensorTrack> tracks;
  std::vector<scvMetricSeriesKind> requestedProducts;
  std::vector<TargetAccumulator> targets;
  bool isScv = false;
  bool includePackedGeometry = true;
  bool scvSwathOnly = false;
  // targets_only mode (PHASE-1 INTEGRATION CONTRACT): TARGETS non-empty AND
  // REQUESTED_PRODUCTS empty AND INCLUDE_PACKED_GEOMETRY false → emit only
  // TARGET_RESULTS and skip ALL grid cell allocation / accumulation.
  bool targetsOnly = false;
};

struct VisibilityInterval {
  double start = 0.0;
  double stop = 0.0;
  bool valid = false;
};

double clamp(double value, double min_value, double max_value) {
  return std::max(min_value, std::min(max_value, value));
}

double dot(Vec3 left, Vec3 right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

Vec3 add(Vec3 left, Vec3 right) {
  return {left.x + right.x, left.y + right.y, left.z + right.z};
}

Vec3 subtract(Vec3 left, Vec3 right) {
  return {left.x - right.x, left.y - right.y, left.z - right.z};
}

Vec3 scale(Vec3 value, double scalar) {
  return {value.x * scalar, value.y * scalar, value.z * scalar};
}

Vec3 cross(Vec3 left, Vec3 right) {
  return {
    left.y * right.z - left.z * right.y,
    left.z * right.x - left.x * right.z,
    left.x * right.y - left.y * right.x,
  };
}

double magnitude(Vec3 value) {
  return std::sqrt(dot(value, value));
}

Vec3 normalize(Vec3 value, Vec3 fallback = {1.0, 0.0, 0.0}) {
  const double length = magnitude(value);
  if (!(length > 0.0) || !std::isfinite(length)) {
    return fallback;
  }
  return scale(value, 1.0 / length);
}

Vertex to_cartographic(Vec3 point) {
  const double p = std::hypot(point.x, point.y);
  const double longitude = std::atan2(point.y, point.x);
  const double theta = std::atan2(point.z * kWgs84A, p * kWgs84B);
  const double sin_theta = std::sin(theta);
  const double cos_theta = std::cos(theta);
  const double latitude = std::atan2(
    point.z + kWgs84Ep2 * kWgs84B * sin_theta * sin_theta * sin_theta,
    p - kWgs84E2 * kWgs84A * cos_theta * cos_theta * cos_theta);
  return {
    latitude * kRadiansToDegrees,
    longitude * kRadiansToDegrees,
  };
}

Cartographic ecef_to_geodetic(Vec3 point) {
  const Vertex vertex = to_cartographic(point);
  const double latitude = vertex.latitudeDeg / kRadiansToDegrees;
  const double longitude = vertex.longitudeDeg / kRadiansToDegrees;
  const double p = std::hypot(point.x, point.y);
  const double sin_latitude = std::sin(latitude);
  const double prime_vertical =
    kWgs84A / std::sqrt(1.0 - kWgs84E2 * sin_latitude * sin_latitude);
  const double altitude =
    p / std::max(std::cos(latitude), 1.0e-12) - prime_vertical;
  return {longitude, latitude, altitude};
}

Vec3 geodetic_to_ecef(Cartographic cartographic) {
  const double cos_latitude = std::cos(cartographic.latitudeRad);
  const double sin_latitude = std::sin(cartographic.latitudeRad);
  const double cos_longitude = std::cos(cartographic.longitudeRad);
  const double sin_longitude = std::sin(cartographic.longitudeRad);
  const double prime_vertical =
    kWgs84A / std::sqrt(1.0 - kWgs84E2 * sin_latitude * sin_latitude);
  return {
    (prime_vertical + cartographic.altitudeM) * cos_latitude * cos_longitude,
    (prime_vertical + cartographic.altitudeM) * cos_latitude * sin_longitude,
    (prime_vertical * (1.0 - kWgs84E2) + cartographic.altitudeM) * sin_latitude,
  };
}

Vec3 geodetic_surface_point(Vec3 point) {
  Cartographic cartographic = ecef_to_geodetic(point);
  cartographic.altitudeM = 0.0;
  return geodetic_to_ecef(cartographic);
}

Vec3 geodetic_surface_unit(double latitude_deg, double longitude_deg) {
  const Cartographic cartographic{
    longitude_deg / kRadiansToDegrees,
    latitude_deg / kRadiansToDegrees,
    0.0,
  };
  return normalize(geodetic_to_ecef(cartographic));
}

double geocentric_latitude_deg_from_geodetic(double latitude_deg) {
  const double latitude_rad = latitude_deg / kRadiansToDegrees;
  return std::atan2(
    (1.0 - kWgs84E2) * std::sin(latitude_rad),
    std::cos(latitude_rad)) * kRadiansToDegrees;
}

Vertex direction_lon_lat(Vec3 direction) {
  const Vec3 unit = normalize(direction);
  return {
    std::atan2(unit.z, std::hypot(unit.x, unit.y)) * kRadiansToDegrees,
    std::atan2(unit.y, unit.x) * kRadiansToDegrees,
  };
}

Vec3 geodetic_surface_normal(Vec3 ecef_point) {
  return normalize({
    ecef_point.x / kWgs84A2,
    ecef_point.y / kWgs84A2,
    ecef_point.z / kWgs84B2,
  }, normalize(ecef_point));
}

void set_grid_cell_sample(GridCellGeometry& geometry, int index, double latitude_deg, double longitude_deg) {
  const Cartographic cartographic{
    longitude_deg / kRadiansToDegrees,
    latitude_deg / kRadiansToDegrees,
    0.0,
  };
  const Vec3 surface_position = geodetic_to_ecef(cartographic);
  const Vec3 scaled_normal = {
    surface_position.x / kWgs84A2,
    surface_position.y / kWgs84A2,
    surface_position.z / kWgs84B2,
  };
  geometry.samplePositions[index] = surface_position;
  geometry.sampleNormals[index] = normalize(scaled_normal);
}

GridCellGeometry grid_cell_geometry(const CellBounds& bounds) {
  GridCellGeometry geometry{};
  const double latitude_deg =
    0.5 * (bounds.minLatitudeDeg + bounds.maxLatitudeDeg);
  const double longitude_deg =
    0.5 * (bounds.minLongitudeDeg + bounds.maxLongitudeDeg);
  set_grid_cell_sample(geometry, 0, latitude_deg, longitude_deg);
  geometry.surfacePosition = geometry.samplePositions[0];
  geometry.surfaceNormal = geometry.sampleNormals[0];
  geometry.surfaceUnit = normalize(geometry.surfacePosition);
  const double min_latitude = bounds.minLatitudeDeg;
  const double max_latitude = bounds.maxLatitudeDeg;
  const double min_longitude = bounds.minLongitudeDeg;
  const double max_longitude = bounds.maxLongitudeDeg;
  set_grid_cell_sample(geometry, 1, min_latitude, min_longitude);
  set_grid_cell_sample(geometry, 2, min_latitude, max_longitude);
  set_grid_cell_sample(geometry, 3, max_latitude, min_longitude);
  set_grid_cell_sample(geometry, 4, max_latitude, max_longitude);
  set_grid_cell_sample(geometry, 5, min_latitude, longitude_deg);
  set_grid_cell_sample(geometry, 6, max_latitude, longitude_deg);
  set_grid_cell_sample(geometry, 7, latitude_deg, min_longitude);
  set_grid_cell_sample(geometry, 8, latitude_deg, max_longitude);
  geometry.sampleCount = 9;
  geometry.minLatitudeDeg = min_latitude;
  geometry.maxLatitudeDeg = max_latitude;
  geometry.minGeocentricLatitudeDeg =
    geocentric_latitude_deg_from_geodetic(min_latitude);
  geometry.maxGeocentricLatitudeDeg =
    geocentric_latitude_deg_from_geodetic(max_latitude);
  geometry.minLongitudeDeg = min_longitude;
  geometry.maxLongitudeDeg = max_longitude;
  if (min_latitude <= 0.0 && max_latitude >= 0.0) {
    geometry.maximumParallelDerivativeM = kWgs84A;
  } else {
    double maximum_parallel_derivative_m = 0.0;
    for (int sample_index = 0; sample_index < geometry.sampleCount; ++sample_index) {
      maximum_parallel_derivative_m = std::max(
        maximum_parallel_derivative_m,
        std::hypot(
          geometry.samplePositions[sample_index].x,
          geometry.samplePositions[sample_index].y));
    }
    geometry.maximumParallelDerivativeM = inflate_proof_upper_bound(
      maximum_parallel_derivative_m);
  }
  return geometry;
}

bool intersect_earth(Vec3 origin, Vec3 direction, double max_range, Vec3& result) {
  const Vec3 unit_direction = normalize(direction);
  const Vec3 scaled_origin = {
    origin.x / kWgs84A,
    origin.y / kWgs84A,
    origin.z / kWgs84B,
  };
  const Vec3 scaled_direction = {
    unit_direction.x / kWgs84A,
    unit_direction.y / kWgs84A,
    unit_direction.z / kWgs84B,
  };
  const double a = dot(scaled_direction, scaled_direction);
  const double b = 2.0 * dot(scaled_origin, scaled_direction);
  const double c = dot(scaled_origin, scaled_origin) - 1.0;
  const double discriminant = b * b - 4.0 * a * c;
  if (!(discriminant >= 0.0) || !std::isfinite(discriminant)) {
    return false;
  }
  const double root = std::sqrt(discriminant);
  double range = (-b - root) / (2.0 * a);
  if (!(range > 0.0)) {
    range = (-b + root) / (2.0 * a);
  }
  if (!(range > 0.0) || range > max_range) {
    return false;
  }
  result = add(origin, scale(unit_direction, range));
  return true;
}

bool is_supported_scv_shape_kind(scvSensorShapeKind shape_kind) {
  switch (shape_kind) {
    case scvSensorShapeKind_CONIC:
    case scvSensorShapeKind_RECTANGULAR:
    case scvSensorShapeKind_SAR_ANNULAR_SECTOR:
    case scvSensorShapeKind_CUSTOM_POLYGON:
      return true;
    default:
      return false;
  }
}

Vec3 vec3_from_scv(const SCVVec3* value) {
  if (!value) {
    return {};
  }
  return {value->X(), value->Y(), value->Z()};
}

SensorFrame derived_nadir_sensor_frame(const State& state) {
  const Vec3 radial = normalize(state.position);
  Vec3 x_axis = subtract(state.velocity, scale(radial, dot(state.velocity, radial)));
  x_axis = normalize(x_axis, normalize({-radial.y, radial.x, 0.0}));
  SensorFrame frame{};
  frame.boresight = scale(radial, -1.0);
  frame.xAxis = x_axis;
  frame.yAxis = normalize(cross(frame.boresight, frame.xAxis), {0.0, 0.0, 1.0});
  frame.valid = true;
  return frame;
}

Quaternion normalize_quaternion(Quaternion value) {
  const double length = std::sqrt(
    value.x * value.x +
    value.y * value.y +
    value.z * value.z +
    value.w * value.w);
  if (!(length > 0.0) || !std::isfinite(length)) {
    return {};
  }
  return {
    value.x / length,
    value.y / length,
    value.z / length,
    value.w / length,
  };
}

Vec3 rotate_local_vector(Quaternion q, Vec3 vector) {
  const Vec3 qv{q.x, q.y, q.z};
  const Vec3 t = scale(cross(qv, vector), 2.0);
  return add(add(vector, scale(t, q.w)), cross(qv, t));
}

Vec3 frame_vector_from_local(const SensorFrame& base, Vec3 local) {
  return add(
    add(scale(base.xAxis, local.x), scale(base.yAxis, local.y)),
    scale(base.boresight, local.z));
}

SensorFrame sensor_frame_from_scv_quaternion(const State& state, const SCVStateSample* sample) {
  SensorFrame frame{};
  const Quaternion q = normalize_quaternion({
    sample->QUATERNION_X(),
    sample->QUATERNION_Y(),
    sample->QUATERNION_Z(),
    sample->QUATERNION_W(),
  });
  const double q_length = std::sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (!(q_length > 0.0) || !std::isfinite(q_length)) {
    return frame;
  }

  const SensorFrame base = derived_nadir_sensor_frame(state);
  frame.boresight = normalize(
    frame_vector_from_local(base, rotate_local_vector(q, {0.0, 0.0, 1.0})),
    base.boresight);
  frame.xAxis = normalize(
    frame_vector_from_local(base, rotate_local_vector(q, {1.0, 0.0, 0.0})),
    base.xAxis);
  frame.yAxis = normalize(
    frame_vector_from_local(base, rotate_local_vector(q, {0.0, 1.0, 0.0})),
    base.yAxis);
  frame.valid = true;
  return frame;
}

bool grid_from_scv_request(
    const SCVCoverageRequest* request,
    GridConfig& config,
    std::string& error) {
  if (const auto* coverage_grid = request->COVERAGE_GRID()) {
    config.minLat = coverage_grid->MIN_LAT_DEG();
    config.maxLat = coverage_grid->MAX_LAT_DEG();
    config.minLon = coverage_grid->MIN_LON_DEG();
    config.maxLon = coverage_grid->MAX_LON_DEG();
    config.latStep = std::max(0.01, coverage_grid->LAT_STEP_DEG());
    config.lonStep = std::max(0.01, coverage_grid->LON_STEP_DEG());
  }
  const auto* time_grid = request->TIME_GRID();
  if (!time_grid) {
    error = "SCV coverage TIME_GRID is required.";
    return false;
  }
  config.start = time_grid->START_OFFSET_SEC();
  config.stop = time_grid->STOP_OFFSET_SEC();
  config.step = time_grid->STEP_SEC();
  config.gridIndexStart = time_grid->GRID_INDEX_START();
  config.gridIndexCount = time_grid->GRID_INDEX_COUNT();
  config.epochIso = time_grid->EPOCH_ISO()
    ? time_grid->EPOCH_ISO()->str()
    : "";
  config.epochJulianDate = time_grid->EPOCH_JULIAN_DATE();

  if (!std::isfinite(config.step) || !(config.step > 0.0)) {
    error = "SCV coverage TIME_GRID STEP_SEC must be finite and greater than zero.";
    return false;
  }
  if (config.gridIndexCount < 1u) {
    error = "SCV coverage TIME_GRID GRID_INDEX_COUNT must be at least one.";
    return false;
  }
  if (
    !std::isfinite(config.start) ||
    !std::isfinite(config.stop) ||
    !(config.start < config.stop)
  ) {
    error = "SCV coverage TIME_GRID START_OFFSET_SEC must be less than STOP_OFFSET_SEC.";
    return false;
  }
  const long double span =
    static_cast<long double>(config.stop) -
    static_cast<long double>(config.start);
  const long double step = static_cast<long double>(config.step);
  const long double minimum_span =
    static_cast<long double>(config.gridIndexCount - 1u) * step;
  const long double maximum_span =
    static_cast<long double>(config.gridIndexCount) * step;
  if (!(minimum_span < span && span <= maximum_span)) {
    error =
      "SCV coverage TIME_GRID span is inconsistent with STEP_SEC and "
      "GRID_INDEX_COUNT; require (count-1)*step < stop-start <= count*step.";
    return false;
  }
  config.rows = std::max(1, static_cast<int>(std::ceil((config.maxLat - config.minLat) / config.latStep)));
  config.columns = std::max(1, static_cast<int>(std::ceil((config.maxLon - config.minLon) / config.lonStep)));
  return true;
}

void initialize_sensor_boundary_directions(SensorConfig& sensor) {
  SensorShapeContract boundary_contract = sensor.shapeContract;
  boundary_contract.boundarySamples = std::max(
    8,
    boundary_contract.boundarySamples);
  sensor.localBoundaryDirections =
    generate_sensor_boundary_directions(boundary_contract);
  sensor.maxBoundaryAngleRad = 0.0;
  sensor.outerHalfAngleCosLower = deflate_proof_lower_bound(std::cos(
    sensor.shapeContract.outerHalfAngleRad));
  sensor.outerHalfAngleCosUpper = inflate_proof_upper_bound(std::cos(
    sensor.shapeContract.outerHalfAngleRad));
  sensor.outerHalfAngleSinUpper = inflate_proof_upper_bound(std::sin(
    sensor.shapeContract.outerHalfAngleRad));
  sensor.innerHalfAngleCosLower = deflate_proof_lower_bound(std::cos(
    sensor.shapeContract.innerHalfAngleRad));
  sensor.hasRepresentativeLocalDirection = false;
  sensor.fixedWitnessLocalDirections.clear();
  const SensorShapeContract& shape = sensor.shapeContract;
  const double inclusive_outer_threshold_rad =
    shape.outerHalfAngleRad + kSensorShapeEpsilon;
  sensor.inclusiveOuterBoundaryAlwaysAccepted =
    inclusive_outer_threshold_rad >= 3.14159265358979323846;
  sensor.membershipOuterBoundaryCos = std::cos(clamp(
    inclusive_outer_threshold_rad,
    0.0,
    3.14159265358979323846));
  sensor.inclusiveOuterBoundaryCosLower = deflate_proof_lower_bound(
    sensor.membershipOuterBoundaryCos);
  const double inclusive_inner_threshold_rad =
    shape.innerHalfAngleRad - kSensorShapeEpsilon;
  sensor.inclusiveInnerBoundaryAlwaysAccepted =
    inclusive_inner_threshold_rad <= 0.0;
  sensor.inclusiveInnerBoundaryImpossible =
    inclusive_inner_threshold_rad > 3.14159265358979323846;
  sensor.membershipInnerBoundaryCos = std::cos(clamp(
    inclusive_inner_threshold_rad,
    0.0,
    3.14159265358979323846));
  sensor.inclusiveInnerBoundaryCosUpper = inflate_proof_upper_bound(
    sensor.membershipInnerBoundaryCos);
  sensor.clockMembershipAlwaysAccepted = shape.clockRange.fullCircle;
  sensor.clockMembershipNeedsScalarFallback = false;
  sensor.clockZeroAccepted = clock_angle_in_range(0.0, shape.clockRange);
  sensor.clockCenterCos = 1.0;
  sensor.clockCenterSin = 0.0;
  sensor.clockHalfSpanRad = 3.14159265358979323846;
  sensor.clockBoundaryCosLower = -1.0;
  sensor.membershipClockBoundaryCos = -1.0;
  sensor.clockBoundarySinLower = 0.0;
  sensor.clockBoundarySinUpper = 0.0;
  if (!shape.clockRange.fullCircle) {
    const double effective_start_rad = std::max(
      0.0,
      shape.clockRange.startRad - kSensorShapeEpsilon);
    const double effective_stop_rad = std::min(
      2.0 * 3.14159265358979323846,
      shape.clockRange.stopRad + kSensorShapeEpsilon);
    const double effective_span_rad = shape.clockRange.wrapped
      ? 2.0 * 3.14159265358979323846 - effective_start_rad +
        effective_stop_rad
      : std::max(0.0, effective_stop_rad - effective_start_rad);
    sensor.clockMembershipAlwaysAccepted =
      effective_span_rad >= 2.0 * 3.14159265358979323846;
    const double center_rad = normalize_angle_rad(
      effective_start_rad + 0.5 * effective_span_rad);
    sensor.clockCenterCos = std::cos(center_rad);
    sensor.clockCenterSin = std::sin(center_rad);
    sensor.clockHalfSpanRad = 0.5 * effective_span_rad;
    sensor.membershipClockBoundaryCos = std::cos(clamp(
      sensor.clockHalfSpanRad,
      0.0,
      3.14159265358979323846));
    sensor.clockBoundaryCosLower = deflate_proof_lower_bound(
      sensor.membershipClockBoundaryCos);
    sensor.clockBoundarySinUpper = inflate_proof_upper_bound(std::sin(clamp(
      sensor.clockHalfSpanRad,
      0.0,
      3.14159265358979323846)));
    sensor.clockBoundarySinLower = deflate_proof_lower_bound(std::sin(clamp(
      sensor.clockHalfSpanRad,
      0.0,
      3.14159265358979323846)));
    sensor.clockMembershipNeedsScalarFallback =
      !shape.clockRange.wrapped &&
      shape.clockRange.stopRad + kSensorShapeEpsilon >=
        2.0 * 3.14159265358979323846 &&
      !sensor.clockMembershipAlwaysAccepted;
  }
  const double inclusive_cross_track_rad =
    shape.crossTrackHalfAngleRad + kSensorShapeEpsilon;
  const double inclusive_along_track_rad =
    shape.alongTrackHalfAngleRad + kSensorShapeEpsilon;
  sensor.inclusiveCrossTrackAlwaysAccepted =
    inclusive_cross_track_rad >= 0.5 * 3.14159265358979323846;
  sensor.inclusiveAlongTrackAlwaysAccepted =
    inclusive_along_track_rad >= 0.5 * 3.14159265358979323846;
  sensor.inclusiveCrossTrackTangentUpper =
    sensor.inclusiveCrossTrackAlwaysAccepted
      ? std::numeric_limits<double>::infinity()
      : inflate_proof_upper_bound(std::tan(inclusive_cross_track_rad));
  sensor.inclusiveAlongTrackTangentUpper =
    sensor.inclusiveAlongTrackAlwaysAccepted
      ? std::numeric_limits<double>::infinity()
      : inflate_proof_upper_bound(std::tan(inclusive_along_track_rad));
  if (shape.kind == SensorShapeKind::Rectangular) {
    sensor.representativeLocalDirection = {0.0, 0.0, 1.0};
    sensor.hasRepresentativeLocalDirection = true;
  } else if (
    (shape.kind == SensorShapeKind::Conic ||
      shape.kind == SensorShapeKind::SarAnnularSector) &&
    shape.outerHalfAngleRad >= shape.innerHalfAngleRad
  ) {
    if (
      shape.kind == SensorShapeKind::Conic &&
      shape.innerHalfAngleRad <= 1.0e-14 &&
      shape.clockRange.fullCircle
    ) {
      sensor.representativeLocalDirection = {0.0, 0.0, 1.0};
    } else {
      const double angle = 0.5 * (
        shape.innerHalfAngleRad + shape.outerHalfAngleRad);
      const double clock = shape.clockRange.fullCircle
        ? 0.0
        : normalize_angle_rad(
          shape.clockRange.startRad + 0.5 * shape.clockRange.spanRad);
      const double radial = std::sin(angle);
      sensor.representativeLocalDirection = {
        radial * std::cos(clock),
        radial * std::sin(clock),
        std::cos(angle),
      };
    }
    sensor.hasRepresentativeLocalDirection = true;
  }
  constexpr double kInteriorFractions[] = {0.25, 0.5, 0.75};
  if (shape.kind == SensorShapeKind::Rectangular) {
    for (double cross_fraction : kInteriorFractions) {
      const double cross_angle =
        (2.0 * cross_fraction - 1.0) * shape.crossTrackHalfAngleRad;
      for (double along_fraction : kInteriorFractions) {
        const double along_angle =
          (2.0 * along_fraction - 1.0) * shape.alongTrackHalfAngleRad;
        sensor.fixedWitnessLocalDirections.push_back({
          std::tan(cross_angle),
          std::tan(along_angle),
          1.0,
        });
      }
    }
  } else if (
    shape.kind == SensorShapeKind::Conic ||
    shape.kind == SensorShapeKind::SarAnnularSector
  ) {
    for (double radial_fraction : kInteriorFractions) {
      const double angle =
        shape.innerHalfAngleRad +
        radial_fraction * (
          shape.outerHalfAngleRad - shape.innerHalfAngleRad);
      const double radial = std::sin(angle);
      for (double clock_fraction : kInteriorFractions) {
        const double clock = shape.clockRange.fullCircle
          ? 2.0 * 3.14159265358979323846 * clock_fraction
          : normalize_angle_rad(
            shape.clockRange.startRad +
            clock_fraction * shape.clockRange.spanRad);
        sensor.fixedWitnessLocalDirections.push_back({
          radial * std::cos(clock),
          radial * std::sin(clock),
          std::cos(angle),
        });
      }
    }
  }
  for (const SensorVec3& direction : sensor.localBoundaryDirections) {
    const double direction_length = std::sqrt(
      direction.x * direction.x +
      direction.y * direction.y +
      direction.z * direction.z);
    if (!(direction_length > 0.0) || !std::isfinite(direction_length)) {
      continue;
    }
    sensor.maxBoundaryAngleRad = std::max(
      sensor.maxBoundaryAngleRad,
      std::acos(clamp(direction.z / direction_length, -1.0, 1.0)));
  }
}

SensorConfig sensor_from_scv(const SCVSensor* sensor, int fallback_sensor_id) {
  SensorConfig config{};
  if (!sensor) {
    config.sensorId = fallback_sensor_id;
    config.shapeContract.supported = false;
    config.shapeContract.unsupportedReason = "SCV sensor entry is missing";
    return config;
  }
  config.sensorId = static_cast<int>(sensor->SENSOR_ID());
  config.shapeContract = parse_sensor_shape_contract(sensor);
  if (const SCVSensorShapeContract* shape = sensor->SHAPE_CONTRACT()) {
    if (!is_supported_scv_shape_kind(shape->SHAPE_KIND())) {
      config.shapeContract.supported = false;
      config.shapeContract.unsupportedReason = "unsupported sensor shape in SHAPE_CONTRACT()";
    }
  }
  initialize_sensor_boundary_directions(config);
  return config;
}

std::vector<SensorTrack> tracks_from_scv_request(const SCVCoverageRequest* request) {
  std::map<int, std::vector<State>> states_by_sensor;
  if (const auto* samples = request->STATE_SAMPLES()) {
    for (const auto* sample : *samples) {
      if (!sample) {
        continue;
      }
      State state{};
      state.elapsedSeconds = sample->TIME_OFFSET_SEC();
      state.position = vec3_from_scv(sample->POSITION_M());
      state.velocity = vec3_from_scv(sample->VELOCITY_MPS());
      state.sensorFrame = sensor_frame_from_scv_quaternion(state, sample);
      if (
        std::isfinite(state.elapsedSeconds) &&
        magnitude(state.position) > kEarthRadiusM + 1.0 &&
        magnitude(state.velocity) > 0.0
      ) {
        states_by_sensor[static_cast<int>(sample->SENSOR_ID())].push_back(state);
      }
    }
  }

  std::vector<SensorTrack> tracks;
  if (const auto* sensors = request->SENSORS()) {
    tracks.reserve(sensors->size());
    for (uint32_t index = 0; index < sensors->size(); ++index) {
      const auto* sensor = sensors->Get(index);
      SensorTrack track{};
      track.sensor = sensor_from_scv(sensor, static_cast<int>(index));
      auto found = states_by_sensor.find(track.sensor.sensorId);
      if (found != states_by_sensor.end()) {
        track.states = found->second;
      }
      std::sort(track.states.begin(), track.states.end(), [](const State& left, const State& right) {
        return left.elapsedSeconds < right.elapsedSeconds;
      });
      if (track.states.size() >= 2) {
        tracks.push_back(track);
      }
    }
  }
  return tracks;
}

bool validate_scv_sensor_shapes(const SCVCoverageRequest* request, std::string& error) {
  if (const auto* sensors = request->SENSORS()) {
    for (uint32_t index = 0; index < sensors->size(); ++index) {
      const SensorConfig sensor = sensor_from_scv(sensors->Get(index), static_cast<int>(index));
      if (!sensor.shapeContract.supported) {
        error = sensor.shapeContract.unsupportedReason.empty()
          ? "unsupported sensor shape"
          : sensor.shapeContract.unsupportedReason;
        return false;
      }
    }
  }
  return true;
}

bool payload_has_scv_identifier(const std::string& payload) {
  return payload.size() >= 8 &&
    SCVBufferHasIdentifier(reinterpret_cast<const uint8_t*>(payload.data()));
}

bool is_supported_metric_product(scvMetricSeriesKind product) {
  switch (product) {
    case scvMetricSeriesKind_PERCENT_COVERED:
    case scvMetricSeriesKind_COVERED_CELL_COUNT:
    case scvMetricSeriesKind_ACCESS_COUNT:
    case scvMetricSeriesKind_CONTACT_DURATION_SECONDS:
    case scvMetricSeriesKind_REVISIT_SECONDS:
    case scvMetricSeriesKind_GAP_SECONDS:
    case scvMetricSeriesKind_REDUNDANCY:
    case scvMetricSeriesKind_OVERLAP_COUNT:
    case scvMetricSeriesKind_LATITUDE_BAND_COVERAGE:
      return true;
    default:
      return false;
  }
}

bool metric_product_requested(
    const std::vector<scvMetricSeriesKind>& requested_products,
    scvMetricSeriesKind product) {
  for (const auto requested_product : requested_products) {
    if (requested_product == product) {
      return true;
    }
  }
  return false;
}

std::vector<TargetAccumulator> parse_targets_from_scv_request(
    const SCVCoverageRequest* request);

bool parse_coverage_input(const std::string& payload, CoverageInput& input, std::string& error) {
  if (payload_has_scv_identifier(payload)) {
    flatbuffers::Verifier verifier(
      reinterpret_cast<const uint8_t*>(payload.data()),
      payload.size());
    if (!VerifySCVBuffer(verifier)) {
      error = "Input port \"coverage\" must contain a valid SCV FlatBuffer.";
      return false;
    }
    const SCV* envelope = GetSCV(payload.data());
    if (!envelope || envelope->ENVELOPE_KIND() != scvEnvelopeKind_REQUEST || !envelope->REQUEST()) {
      error = "Input port \"coverage\" SCV envelope must contain a REQUEST payload.";
      return false;
    }
    const SCVCoverageRequest* request = envelope->REQUEST();
    input.isScv = true;
    if (!grid_from_scv_request(request, input.grid, error)) {
      return false;
    }
    input.tracks = tracks_from_scv_request(request);
    const auto* requested_products = request->REQUESTED_PRODUCTS();
    const bool has_explicit_products =
      requested_products != nullptr && requested_products->size() > 0;
    input.scvSwathOnly = request->ANALYSIS_MODE() == scvAnalysisMode_SWATH;
    input.includePackedGeometry = request->INCLUDE_PACKED_GEOMETRY();
    input.targets = parse_targets_from_scv_request(request);
    const bool has_targets = !input.targets.empty();
    // PHASE-1 INTEGRATION CONTRACT: TARGETS non-empty + REQUESTED_PRODUCTS empty
    // + INCLUDE_PACKED_GEOMETRY false → targets_only recompute. Otherwise the
    // usual "declare your products" contract holds.
    input.targetsOnly =
      has_targets && !has_explicit_products &&
      !input.includePackedGeometry && !input.scvSwathOnly;
    if (!input.scvSwathOnly && !has_explicit_products && !input.targetsOnly) {
      error = "SCV coverage REQUESTED_PRODUCTS must explicitly declare every requested FOM/raster product.";
      return false;
    }
    if (has_explicit_products) {
      input.requestedProducts.reserve(requested_products->size());
      for (uint32_t index = 0; index < requested_products->size(); ++index) {
        const auto product =
          static_cast<scvMetricSeriesKind>(requested_products->Get(index));
        if (!is_supported_metric_product(product)) {
          error = "SCV coverage REQUESTED_PRODUCTS contains an unsupported metric product.";
          return false;
        }
        if (!metric_product_requested(input.requestedProducts, product)) {
          input.requestedProducts.push_back(product);
        }
      }
    }
    if (!validate_scv_sensor_shapes(request, error)) {
      return false;
    }
    return true;
  }

  error = "Input port \"coverage\" must contain an SDS SCV FlatBuffer.";
  return false;
}

CellBounds cell_bounds_for(int row, int column, const GridConfig& grid) {
  const double min_latitude = clamp(
    grid.minLat + static_cast<double>(row) * grid.latStep,
    -90.0,
    90.0);
  const double max_latitude = clamp(
    std::min(grid.maxLat, grid.minLat + static_cast<double>(row + 1) * grid.latStep),
    -90.0,
    90.0);
  const double min_longitude = clamp(
    grid.minLon + static_cast<double>(column) * grid.lonStep,
    -180.0,
    180.0);
  const double max_longitude = clamp(
    std::min(grid.maxLon, grid.minLon + static_cast<double>(column + 1) * grid.lonStep),
    -180.0,
    180.0);
  const double latitude = 0.5 * (min_latitude + max_latitude);
  const double longitude = 0.5 * (min_longitude + max_longitude);
  const int tile_columns = std::max(
    1,
    (grid.columns + kGridTileColumnSpan - 1) / kGridTileColumnSpan);
  CellBounds bounds{};
  bounds.tileRow = row / kGridTileRowSpan;
  bounds.tileColumn = column / kGridTileColumnSpan;
  bounds.tileId = bounds.tileRow * tile_columns + bounds.tileColumn;
  bounds.minLatitudeDeg = min_latitude;
  bounds.maxLatitudeDeg = max_latitude;
  bounds.minLongitudeDeg = min_longitude;
  bounds.maxLongitudeDeg = max_longitude;
  bounds.centerUnit = geodetic_surface_unit(latitude, longitude);
  return bounds;
}

std::vector<Cell> create_cells(const GridConfig& grid) {
  std::vector<Cell> cells;
  cells.reserve(static_cast<size_t>(grid.rows * grid.columns));
  int index = 0;
  for (int row = 0; row < grid.rows; ++row) {
    for (int column = 0; column < grid.columns; ++column) {
      Cell cell{};
      cell.index = index++;
      cell.row = row;
      cell.column = column;
      cell.bounds = cell_bounds_for(row, column, grid);
      cell.latitude = 0.5 * (
        cell.bounds.minLatitudeDeg + cell.bounds.maxLatitudeDeg);
      cell.longitude = 0.5 * (
        cell.bounds.minLongitudeDeg + cell.bounds.maxLongitudeDeg);
      cell.surfaceUnit = cell.bounds.centerUnit;
      cell.surfaceUnitReady = true;
      cells.push_back(cell);
    }
  }
  return cells;
}

std::string grid_cache_key(const GridConfig& grid) {
  char buffer[256];
  std::snprintf(
    buffer,
    sizeof(buffer),
    "%.12g|%.12g|%.12g|%.12g|%.12g|%.12g|%d|%d",
    grid.minLat,
    grid.maxLat,
    grid.minLon,
    grid.maxLon,
    grid.latStep,
    grid.lonStep,
    grid.rows,
    grid.columns);
  return buffer;
}

void reset_cell_accumulators(Cell& cell) {
  cell.intervals.clear();
  cell.passStartBuckets.clear();
  cell.contributingSensorIds.clear();
  cell.totalAccess = 0.0;
  cell.maxGap = 0.0;
  cell.meanRevisit = 0.0;
  cell.firstResponse = 0.0;
  cell.maxResponse = 0.0;
  cell.meanResponse = 0.0;
  cell.totalGap = 0.0;
  cell.revisitGapTotal = 0.0;
  cell.accessCount = 0;
  cell.revisitCount = 0;
}

std::vector<CachedGridCells>& grid_cell_cache() {
  static std::vector<CachedGridCells> cache;
  return cache;
}

std::vector<Cell>& cached_grid_cells_for(const GridConfig& grid) {
  const std::string key = grid_cache_key(grid);
  std::vector<CachedGridCells>& cache = grid_cell_cache();
  for (auto& entry : cache) {
    if (entry.key == key) {
      for (auto& cell : entry.cells) {
        reset_cell_accumulators(cell);
      }
      return entry.cells;
    }
  }
  if (cache.size() >= kGridCellCacheMaxEntries) {
    cache.erase(cache.begin());
  }
  CachedGridCells entry{};
  entry.key = key;
  entry.cells = create_cells(grid);
  cache.push_back(entry);
  for (auto& cell : cache.back().cells) {
    reset_cell_accumulators(cell);
  }
  return cache.back().cells;
}

void ensure_cell_geometry(Cell& cell, const GridConfig& grid) {
  if (cell.geometryReady) {
    return;
  }
  cell.geometry = grid_cell_geometry(cell.bounds);
  cell.surfaceUnit = cell.geometry.surfaceUnit;
  cell.surfaceUnitReady = true;
  cell.geometryReady = true;
}

// Build one TargetAccumulator per SCVTarget. Regions are constructed fully here,
// before any fan-out, and stay const during accumulation. Phase 1 ships ground
// POINT and POLYGON/RECTANGLE targets in the SURFACE domain; anything else (SPACE
// volumes, malformed geometry) or an antimeridian-crossing polygon is rejected
// fail-closed and kept in target-index order with zero coverage.
std::vector<TargetAccumulator> parse_targets_from_scv_request(
    const SCVCoverageRequest* request) {
  std::vector<TargetAccumulator> targets;
  const auto* scv_targets = request->TARGETS();
  if (scv_targets == nullptr || scv_targets->size() == 0) {
    return targets;
  }
  targets.reserve(scv_targets->size());
  for (uint32_t index = 0; index < scv_targets->size(); ++index) {
    const SCVTarget* scv_target = scv_targets->Get(index);
    TargetAccumulator target;
    target.cell.index = static_cast<int>(index);
    if (scv_target == nullptr) {
      target.rejected = true;
      targets.push_back(std::move(target));
      continue;
    }
    target.targetId = scv_target->TARGET_ID();
    if (scv_target->NAME() != nullptr) {
      target.name = scv_target->NAME()->str();
    }
    const scvTargetShape kind = scv_target->TARGET_KIND();
    const bool surface_domain =
      scv_target->DOMAIN() == scvGeometryDomain_SURFACE;

    double min_lat_deg = 0.0;
    double max_lat_deg = 0.0;
    double min_lon_deg = 0.0;
    double max_lon_deg = 0.0;
    bool built = false;

    if (surface_domain && kind == scvTargetShape_POINT &&
        scv_target->POSITION_M() != nullptr) {
      // POINT: POSITION_M is ECEF WGS84 metres, RADIUS_M the BoundingSphere.
      const Vec3 center_ecef = vec3_from_scv(scv_target->POSITION_M());
      const double radius_m = std::max(scv_target->RADIUS_M(), 1.0);
      sdn_spatial_region::SpatialRegion region(
        sdn_spatial_region::SpatialRegionType::BOUNDING_SPHERE);
      region.setBoundingSphereConfig({
        center_ecef.x, center_ecef.y, center_ecef.z, radius_m});
      target.region = std::move(region);
      // Search rect = the lon/lat rectangle that strictly contains the sphere's
      // surface footprint. Widen longitude by 1/cos(latitude) since parallels
      // shrink toward the poles.
      const Cartographic center = ecef_to_geodetic(center_ecef);
      const double center_lat_deg = center.latitudeRad * kRadiansToDegrees;
      const double center_lon_deg = center.longitudeRad * kRadiansToDegrees;
      const double angular_radius_deg = (radius_m / kWgs84B) * kRadiansToDegrees;
      const double lat_pad_deg = angular_radius_deg + 1.0e-6;
      const double cos_lat = std::cos(center.latitudeRad);
      const double lon_pad_deg =
        angular_radius_deg / std::max(cos_lat, 1.0e-3) + 1.0e-6;
      target.boundIsPoint = true;
      target.boundPointLatDeg = center_lat_deg;
      target.boundPointLonDeg = center_lon_deg;
      target.boundPointRadiusDeg = angular_radius_deg;
      min_lat_deg = clamp(center_lat_deg - lat_pad_deg, -90.0, 90.0);
      max_lat_deg = clamp(center_lat_deg + lat_pad_deg, -90.0, 90.0);
      min_lon_deg = center_lon_deg - lon_pad_deg;
      max_lon_deg = center_lon_deg + lon_pad_deg;
      if (max_lon_deg - min_lon_deg >= 360.0) {
        min_lon_deg = -180.0;
        max_lon_deg = 180.0;
        built = true;
      } else if (min_lon_deg < -180.0 || max_lon_deg > 180.0) {
        // Seam-adjacent point: keep the search rect seam-free — fail closed.
        target.rejected = true;
      } else {
        built = true;
      }
    } else if (surface_domain &&
               (kind == scvTargetShape_POLYGON ||
                kind == scvTargetShape_RECTANGLE) &&
               scv_target->POLYGON_VERTICES() != nullptr &&
               scv_target->POLYGON_VERTICES()->size() >= 3) {
      // POLYGON/RECTANGLE: POLYGON_VERTICES carry lon/lat degrees (z ignored),
      // stored into the region as interleaved [lon,lat] radians.
      const auto* verts = scv_target->POLYGON_VERTICES();
      std::vector<double> positions_rad;
      positions_rad.reserve(static_cast<size_t>(verts->size()) * 2u);
      min_lat_deg = max_lat_deg = verts->Get(0)->Y();
      min_lon_deg = max_lon_deg = verts->Get(0)->X();
      bool antimeridian = false;
      double previous_lon_deg = verts->Get(0)->X();
      for (uint32_t v = 0; v < verts->size(); ++v) {
        const double lon_deg = verts->Get(v)->X();
        const double lat_deg = verts->Get(v)->Y();
        // A single edge jumping more than 180° in longitude marks an
        // antimeridian crossing: the naive lon min/max rect would exclude the
        // seam (SpatialRegion normalizes to [-π,π]). Reject fail-closed.
        if (v > 0 && std::fabs(lon_deg - previous_lon_deg) > 180.0) {
          antimeridian = true;
        }
        previous_lon_deg = lon_deg;
        min_lat_deg = std::min(min_lat_deg, lat_deg);
        max_lat_deg = std::max(max_lat_deg, lat_deg);
        min_lon_deg = std::min(min_lon_deg, lon_deg);
        max_lon_deg = std::max(max_lon_deg, lon_deg);
        positions_rad.push_back(lon_deg / kRadiansToDegrees);
        positions_rad.push_back(lat_deg / kRadiansToDegrees);
        target.boundRingLonLatDeg.push_back(lon_deg);
        target.boundRingLonLatDeg.push_back(lat_deg);
      }
      if (antimeridian || (max_lon_deg - min_lon_deg) > 180.0) {
        target.rejected = true;
      } else {
        sdn_spatial_region::SpatialRegion region(
          sdn_spatial_region::SpatialRegionType::CARTOGRAPHIC_POLYGON);
        region.setCartographicPolygonConfig(
          positions_rad.data(),
          static_cast<uint32_t>(positions_rad.size() / 2u),
          0.0,
          0.0);
        target.region = std::move(region);
        // Small pad so exact boundary witnesses fall inside the search rect.
        min_lat_deg = clamp(min_lat_deg - 1.0e-6, -90.0, 90.0);
        max_lat_deg = clamp(max_lat_deg + 1.0e-6, -90.0, 90.0);
        min_lon_deg = clamp(min_lon_deg - 1.0e-6, -180.0, 180.0);
        max_lon_deg = clamp(max_lon_deg + 1.0e-6, -180.0, 180.0);
        built = true;
      }
    } else {
      target.rejected = true;
    }

    if (built && max_lat_deg > min_lat_deg && max_lon_deg > min_lon_deg) {
      CellBounds bounds{};
      bounds.minLatitudeDeg = min_lat_deg;
      bounds.maxLatitudeDeg = max_lat_deg;
      bounds.minLongitudeDeg = min_lon_deg;
      bounds.maxLongitudeDeg = max_lon_deg;
      target.cell.bounds = bounds;
      target.cell.latitude = 0.5 * (min_lat_deg + max_lat_deg);
      target.cell.longitude = 0.5 * (min_lon_deg + max_lon_deg);
      target.cell.geometry = grid_cell_geometry(bounds);
      target.cell.surfaceUnit = target.cell.geometry.surfaceUnit;
      target.cell.surfaceUnitReady = true;
      target.cell.geometryReady = true;
    } else {
      target.rejected = true;
    }
    targets.push_back(std::move(target));
  }
  return targets;
}

SensorFrame resolve_sensor_frame(const State& state) {
  const SensorFrame derived_frame = derived_nadir_sensor_frame(state);
  if (!state.sensorFrame.valid) {
    return derived_frame;
  }

  SensorFrame frame{};
  frame.boresight = normalize(state.sensorFrame.boresight, derived_frame.boresight);
  Vec3 x_axis = subtract(
    state.sensorFrame.xAxis,
    scale(frame.boresight, dot(state.sensorFrame.xAxis, frame.boresight)));
  frame.xAxis = normalize(x_axis, derived_frame.xAxis);

  Vec3 y_axis = subtract(
    state.sensorFrame.yAxis,
    scale(frame.boresight, dot(state.sensorFrame.yAxis, frame.boresight)));
  y_axis = subtract(y_axis, scale(frame.xAxis, dot(y_axis, frame.xAxis)));
  frame.yAxis = normalize(y_axis, normalize(cross(frame.boresight, frame.xAxis), derived_frame.yAxis));
  frame.valid = true;
  return frame;
}

ResolvedVisibilityState resolve_visibility_state(const State& state) {
  return {state, resolve_sensor_frame(state)};
}

std::vector<ResolvedVisibilityState> resolve_visibility_states(const std::vector<State>& states) {
  std::vector<ResolvedVisibilityState> resolved;
  resolved.reserve(states.size());
  for (const auto& state : states) {
    resolved.push_back(resolve_visibility_state(state));
  }
  return resolved;
}

double sensor_max_range_m(const SensorConfig& sensor) {
  return sensor.shapeContract.maxRangeM > 0.0
    ? sensor.shapeContract.maxRangeM
    : 1.0e100;
}

std::vector<Vec3> sensor_directions(const SensorConfig& sensor, Vec3 boresight, Vec3 x_axis, Vec3 y_axis) {
  std::vector<Vec3> directions;
  directions.reserve(sensor.localBoundaryDirections.size());
  for (const SensorVec3& local : sensor.localBoundaryDirections) {
    directions.push_back(normalize(add(
      add(scale(x_axis, local.x), scale(y_axis, local.y)),
      scale(boresight, local.z))));
  }
  return directions;
}

FootprintSample compute_footprint(const State& state, const SensorConfig& sensor) {
  const SensorFrame frame = resolve_sensor_frame(state);
  const Vec3 subpoint = geodetic_surface_point(state.position);
  const double max_range_m = sensor_max_range_m(sensor);
  Vec3 center_point = subpoint;
  intersect_earth(state.position, frame.boresight, max_range_m, center_point);

  FootprintSample sample{};
  sample.sensorId = sensor.sensorId;
  sample.elapsedSeconds = state.elapsedSeconds;
  sample.center = to_cartographic(center_point);

  double left_metric = -1.0e100;
  double right_metric = 1.0e100;
  const std::vector<Vec3> directions =
    sensor_directions(sensor, frame.boresight, frame.xAxis, frame.yAxis);
  for (const Vec3& direction : directions) {
    Vec3 hit;
    if (!intersect_earth(state.position, direction, max_range_m, hit)) {
      continue;
    }
    const Vertex vertex = to_cartographic(hit);
    sample.vertices.push_back(vertex);
    const double lateral_metric = dot(subtract(hit, center_point), frame.yAxis);
    if (lateral_metric > left_metric) {
      left_metric = lateral_metric;
      sample.left = vertex;
    }
    if (lateral_metric < right_metric) {
      right_metric = lateral_metric;
      sample.right = vertex;
    }
  }

  if (!sample.vertices.empty() && left_metric < -1.0e90) {
    sample.left = sample.vertices.front();
  }
  if (sample.vertices.size() > 1 && right_metric > 1.0e90) {
    sample.right = sample.vertices.back();
  }
  sample.boundaryComplete =
    !directions.empty() && sample.vertices.size() == directions.size();
  return sample;
}

std::vector<FootprintSample> compute_footprints(const std::vector<State>& states, const SensorConfig& sensor) {
  std::vector<FootprintSample> samples;
  samples.reserve(states.size());
  for (const auto& state : states) {
    FootprintSample sample = compute_footprint(state, sensor);
    if (sample.vertices.size() >= 3) {
      samples.push_back(sample);
    }
  }
  return samples;
}

std::vector<SwathSegment> build_swath_segments(const std::vector<FootprintSample>& samples) {
  std::vector<SwathSegment> segments;
  if (samples.size() < 2) {
    return segments;
  }
  for (size_t index = 0; index + 1 < samples.size(); ++index) {
    const auto& start = samples[index];
    const auto& stop = samples[index + 1];
    if (!(stop.elapsedSeconds > start.elapsedSeconds)) {
      continue;
    }
    SwathSegment segment{};
    segment.index = static_cast<int>(segments.size());
    segment.sensorId = start.sensorId;
    segment.start = start.elapsedSeconds;
    segment.stop = stop.elapsedSeconds;
    segment.leftStart = start.left;
    segment.leftStop = stop.left;
    segment.rightStart = start.right;
    segment.rightStop = stop.right;
    segment.centerStart = start.center;
    segment.centerStop = stop.center;
    segments.push_back(segment);
  }
  return segments;
}

void add_unique_sensor_id(std::vector<int>& sensor_ids, int sensor_id) {
  if (sensor_id < 0) {
    return;
  }
  if (std::find(sensor_ids.begin(), sensor_ids.end(), sensor_id) == sensor_ids.end()) {
    sensor_ids.push_back(sensor_id);
  }
}

void merge_sensor_ids(std::vector<int>& target, const std::vector<int>& source) {
  for (const int sensor_id : source) {
    add_unique_sensor_id(target, sensor_id);
  }
}

State interpolate_state(const State& start, const State& stop, double elapsed_seconds) {
  const double span = stop.elapsedSeconds - start.elapsedSeconds;
  const double fraction = span > 0.0
    ? clamp((elapsed_seconds - start.elapsedSeconds) / span, 0.0, 1.0)
    : 0.0;
  State state{};
  state.elapsedSeconds = elapsed_seconds;
  state.position = add(start.position, scale(subtract(stop.position, start.position), fraction));
  state.velocity = add(start.velocity, scale(subtract(stop.velocity, start.velocity), fraction));
  if (start.sensorFrame.valid && stop.sensorFrame.valid) {
    state.sensorFrame.valid = true;
    state.sensorFrame.boresight = normalize(add(
      start.sensorFrame.boresight,
      scale(subtract(stop.sensorFrame.boresight, start.sensorFrame.boresight), fraction)));
    state.sensorFrame.xAxis = normalize(add(
      start.sensorFrame.xAxis,
      scale(subtract(stop.sensorFrame.xAxis, start.sensorFrame.xAxis), fraction)));
    state.sensorFrame.yAxis = normalize(add(
      start.sensorFrame.yAxis,
      scale(subtract(stop.sensorFrame.yAxis, start.sensorFrame.yAxis), fraction)));
  }
  return state;
}

bool sensor_local_look_inside(
    const SensorConfig& sensor,
    SensorVec3 local_look) {
  const SensorShapeContract& shape = sensor.shapeContract;
  if (!shape.supported) {
    return false;
  }
  const double range_m = vector_magnitude(local_look);
  if (
    (shape.minRangeM > 0.0 &&
      range_m + kSensorShapeEpsilon < shape.minRangeM) ||
    (shape.maxRangeM > 0.0 &&
      range_m - kSensorShapeEpsilon > shape.maxRangeM)
  ) {
    return false;
  }
  if (
    shape.kind != SensorShapeKind::Conic &&
    shape.kind != SensorShapeKind::SarAnnularSector
  ) {
    return local_look_inside(shape, local_look);
  }
  const SensorVec3 unit_look = normalize_vector(local_look);
  constexpr double kMembershipFallbackGuard =
    64.0 * std::numeric_limits<double>::epsilon();
  bool use_scalar_fallback = sensor.clockMembershipNeedsScalarFallback;
  bool clock_accepted = sensor.clockMembershipAlwaysAccepted;
  if (!clock_accepted && !use_scalar_fallback) {
    const double transverse = std::hypot(unit_look.x, unit_look.y);
    if (!(transverse > 0.0)) {
      clock_accepted = sensor.clockZeroAccepted;
    } else {
      const double center_dot =
        (unit_look.x * sensor.clockCenterCos +
          unit_look.y * sensor.clockCenterSin) /
        transverse;
      use_scalar_fallback =
        !std::isfinite(center_dot) ||
        std::fabs(center_dot - sensor.membershipClockBoundaryCos) <=
          kMembershipFallbackGuard;
      clock_accepted =
        center_dot >= sensor.membershipClockBoundaryCos;
    }
  }
  bool outer_accepted = sensor.inclusiveOuterBoundaryAlwaysAccepted;
  if (!outer_accepted) {
    use_scalar_fallback = use_scalar_fallback ||
      std::fabs(unit_look.z - sensor.membershipOuterBoundaryCos) <=
        kMembershipFallbackGuard;
    outer_accepted = unit_look.z >= sensor.membershipOuterBoundaryCos;
  }
  bool inner_accepted = sensor.inclusiveInnerBoundaryAlwaysAccepted;
  if (!inner_accepted && !sensor.inclusiveInnerBoundaryImpossible) {
    use_scalar_fallback = use_scalar_fallback ||
      std::fabs(unit_look.z - sensor.membershipInnerBoundaryCos) <=
        kMembershipFallbackGuard;
    inner_accepted = unit_look.z <= sensor.membershipInnerBoundaryCos;
  }
  if (use_scalar_fallback) {
    return local_look_inside(shape, local_look);
  }
  return clock_accepted && outer_accepted && inner_accepted;
}

bool surface_sample_visible_from_resolved_state(
    Vec3 surface_position,
    Vec3 surface_normal,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& resolved) {
  const State& state = resolved.state;
  const SensorFrame& frame = resolved.frame;
  const Vec3 sensor_to_cell = subtract(surface_position, state.position);
  const double range = magnitude(sensor_to_cell);
  if (!(range > 0.0) || !std::isfinite(range)) {
    return false;
  }

  const Vec3 target_to_sensor = normalize(subtract(state.position, surface_position));
  if (dot(target_to_sensor, surface_normal) <= 0.0) {
    return false;
  }

  const Vec3 look = scale(sensor_to_cell, 1.0 / range);
  const double forward = dot(look, frame.boresight);
  if (!(forward > 0.0)) {
    return false;
  }

  if (!sensor_local_look_inside(
        sensor,
        {
          dot(sensor_to_cell, frame.xAxis),
          dot(sensor_to_cell, frame.yAxis),
          dot(sensor_to_cell, frame.boresight),
        })) {
    return false;
  }
  // Area/point-target region gate (Gate 1 — instantaneous concrete witness).
  // A footprint witness only counts for a target when it also lies inside the
  // target's spatial region. This is accept-narrowing only: a rejected point is
  // reported not visible, so every surface-patch subdivision that consults this
  // predicate keeps searching (it never prunes on a region miss).
  if (t_target_region_gate != nullptr &&
      !t_target_region_gate->containsWorldPoint(
        surface_position.x, surface_position.y, surface_position.z)) {
    return false;
  }
  return true;
}

bool longitude_inside_closed_cell(
    double longitude_deg,
    double min_longitude_deg,
    double max_longitude_deg) {
  double longitude = longitude_deg;
  const double reference = 0.5 * (min_longitude_deg + max_longitude_deg);
  while (longitude - reference > 180.0) {
    longitude -= 360.0;
  }
  while (longitude - reference < -180.0) {
    longitude += 360.0;
  }
  constexpr double kLongitudeToleranceDeg = 1.0e-10;
  return
    longitude >= min_longitude_deg - kLongitudeToleranceDeg &&
    longitude <= max_longitude_deg + kLongitudeToleranceDeg;
}

bool conservative_range_cap_radius_deg(
    double observer_distance_m,
    double maximum_range_m,
    double& radius_deg) {
  if (!(maximum_range_m > 0.0) || maximum_range_m >= 1.0e90) {
    radius_deg = 180.0;
    return true;
  }
  if (
    !std::isfinite(observer_distance_m) ||
    !std::isfinite(maximum_range_m) ||
    !(observer_distance_m > kWgs84A)
  ) {
    radius_deg = 180.0;
    return true;
  }
  // Every WGS84 surface point has radial magnitude in [B,A]. Minimize the
  // law-of-cosines threshold over that complete shell. This is a necessary
  // (therefore rejection-safe) maximum-range cap for the ellipsoid.
  constexpr double kShapeRangeBoundaryEpsilonM = 1.0e-12;
  const double proof_maximum_range_m = inflate_proof_upper_bound(
    maximum_range_m + kShapeRangeBoundaryEpsilonM);
  if (
    proof_maximum_range_m <
    deflate_proof_lower_bound(observer_distance_m) - kWgs84A
  ) {
    return false;
  }
  const double critical_radius = std::sqrt(std::max(
    0.0,
    observer_distance_m * observer_distance_m -
      proof_maximum_range_m * proof_maximum_range_m));
  const double radii[] = {
    kWgs84B,
    kWgs84A,
    clamp(critical_radius, kWgs84B, kWgs84A),
  };
  double minimum_cosine = 1.0;
  for (const double body_radius : radii) {
    const double cosine = (
      observer_distance_m * observer_distance_m +
      body_radius * body_radius -
      proof_maximum_range_m * proof_maximum_range_m) /
      (2.0 * observer_distance_m * body_radius);
    minimum_cosine = std::min(
      minimum_cosine,
      deflate_proof_lower_bound(cosine));
  }
  if (minimum_cosine > 1.0) {
    return false;
  }
  radius_deg = inflate_proof_upper_bound(
    std::acos(clamp(minimum_cosine, -1.0, 1.0)) *
      kRadiansToDegrees);
  return true;
}

bool conservative_boresight_footprint_cap_radius_deg(
    double observer_distance_m,
    double boresight_off_nadir_rad,
    double cone_boundary_angle_rad,
    double& radius_deg) {
  if (
    !std::isfinite(observer_distance_m) ||
    !(observer_distance_m > kWgs84B) ||
    !std::isfinite(boresight_off_nadir_rad) ||
    !std::isfinite(cone_boundary_angle_rad) ||
    cone_boundary_angle_rad < 0.0
  ) {
    return false;
  }

  const double radius_ratio = clamp(
    kWgs84B / observer_distance_m,
    0.0,
    1.0);
  const double horizon_look_rad = std::asin(radius_ratio);
  const double maximum_look_rad =
    boresight_off_nadir_rad + cone_boundary_angle_rad;
  if (!(maximum_look_rad < horizon_look_rad)) {
    return false;
  }

  // On the conservative B sphere, radial and azimuthal expansion bound the
  // image of the local angular ball. WGS84/geocentric conversion slack is
  // paid here and again by moving-cap callers.
  const double distance_ratio = observer_distance_m / kWgs84B;
  const double mapped_argument = clamp(
    distance_ratio * std::sin(maximum_look_rad),
    -1.0,
    1.0);
  const double denominator = std::sqrt(std::max(
    1.0e-30,
    1.0 - mapped_argument * mapped_argument));
  const double radial_scale = std::max(
    0.0,
    distance_ratio * std::cos(maximum_look_rad) / denominator - 1.0);
  const double mapped_ground_rad =
    std::asin(mapped_argument) - maximum_look_rad;
  const double azimuthal_scale = maximum_look_rad > 1.0e-14
    ? std::sin(std::max(0.0, mapped_ground_rad)) /
      std::sin(maximum_look_rad)
    : std::max(0.0, distance_ratio - 1.0);
  const double mapping_scale = std::max(radial_scale, azimuthal_scale);

  radius_deg = inflate_proof_upper_bound(
    mapping_scale * cone_boundary_angle_rad * kRadiansToDegrees +
      2.0 * kMaximumGeodeticGeocentricLatitudeSeparationDeg);
  return std::isfinite(radius_deg) && radius_deg >= 0.0;
}

bool cell_intersects_conservative_sensor_cap(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& resolved) {
  const double observer_distance_m = magnitude(resolved.state.position);
  if (!(observer_distance_m > kWgs84A) || !std::isfinite(observer_distance_m)) {
    return true;
  }
  const Vec3 observer_unit = normalize(resolved.state.position);
  const Vec3 nadir = scale(observer_unit, -1.0);
  const double boresight_off_nadir_rad = std::acos(clamp(
    dot(resolved.frame.boresight, nadir),
    -1.0,
    1.0));
  double cap_radius_deg = sdn::coverage::conservativeGroundCapRadiusDeg(
    observer_distance_m,
    kWgs84B,
    (boresight_off_nadir_rad + sensor.maxBoundaryAngleRad) *
      kRadiansToDegrees) +
    kMaximumGeodeticGeocentricLatitudeSeparationDeg + 1.0e-9;
  const double horizon_radius_deg = inflate_proof_upper_bound(
    std::acos(clamp(
      kWgs84B / observer_distance_m,
      0.0,
      1.0)) * kRadiansToDegrees +
      kMaximumGeodeticGeocentricLatitudeSeparationDeg + 1.0e-9);
  cap_radius_deg = std::min(cap_radius_deg, horizon_radius_deg);

  double range_radius_deg = 180.0;
  if (!conservative_range_cap_radius_deg(
        observer_distance_m,
        sensor_max_range_m(sensor),
        range_radius_deg)) {
    return false;
  }
  cap_radius_deg = std::min(cap_radius_deg, range_radius_deg);

  const bool subpoint_envelope_intersects =
    sdn::coverage::sphericalCapIntersectsRectangle(
    direction_lon_lat(observer_unit),
    cap_radius_deg,
    cell.minGeocentricLatitudeDeg,
    cell.maxGeocentricLatitudeDeg,
    cell.minLongitudeDeg,
    cell.maxLongitudeDeg);
  if (!subpoint_envelope_intersects) {
    return false;
  }
  // A tighter boresight-centered spherical cap is tempting here, but the
  // WGS84 ray-to-ground map is anisotropic near the limb. The subpoint cap is
  // the last rejection authority; exact surface witnesses decide access.
  return true;
}

bool has_solid_conic_continuum_contract(const SensorConfig& sensor) {
  constexpr double kShapeToleranceRad = 1.0e-14;
  return
    sensor.shapeContract.kind == SensorShapeKind::Conic &&
    sensor.shapeContract.rangeBoundary == SensorRangeBoundaryKind::RadialSpherical &&
    sensor.shapeContract.innerHalfAngleRad <= kShapeToleranceRad &&
    sensor.shapeContract.clockRange.fullCircle;
}

double radial_magnitude_at_geodetic_latitude(double latitude_deg);

bool solid_conic_cell_proven_angle_disjoint(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& resolved) {
  const double observer_distance_m = magnitude(resolved.state.position);
  if (
    !(observer_distance_m > kWgs84A) ||
    !std::isfinite(observer_distance_m) ||
    sensor.shapeContract.outerHalfAngleRad >= 3.14159265358979323846
  ) {
    return false;
  }

  // Every WGS84 surface point is P=r*q with r in [B,A]. Bound c=u*q over
  // the exact geocentric lat/lon rectangle using its nearest directions to u
  // and -u. For radial nadir n=-u, the forward score
  //
  //   f(r,c)=(D-r*c)/sqrt(D^2+r^2-2*D*r*c)
  //
  // is maximized over radius at r=B. As a function of c it has only an
  // interior minimum, so its maximum over [cMin,cMax] is at an endpoint.
  // The chord from radial nadir to the actual boresight then bounds arbitrary
  // off-nadir pointing by Cauchy-Schwarz. This is an outer bound used only for
  // rejection; it never supplies a positive access result.
  const Vec3 observer_unit = normalize(resolved.state.position);
  const Vertex observer_direction = direction_lon_lat(observer_unit);
  const Vertex antipodal_direction = direction_lon_lat(scale(observer_unit, -1.0));
  const double minimum_distance_deg =
    sdn::coverage::minimumAngularDistanceToRectangleDeg(
      observer_direction,
      cell.minGeocentricLatitudeDeg,
      cell.maxGeocentricLatitudeDeg,
      cell.minLongitudeDeg,
      cell.maxLongitudeDeg);
  const double antipodal_minimum_distance_deg =
    sdn::coverage::minimumAngularDistanceToRectangleDeg(
      antipodal_direction,
      cell.minGeocentricLatitudeDeg,
      cell.maxGeocentricLatitudeDeg,
      cell.minLongitudeDeg,
      cell.maxLongitudeDeg);
  if (
    !std::isfinite(minimum_distance_deg) ||
    !std::isfinite(antipodal_minimum_distance_deg)
  ) {
    return false;
  }
  const double c_max = clamp(inflate_proof_upper_bound(std::cos(
    minimum_distance_deg / kRadiansToDegrees)), -1.0, 1.0);
  const double rectangle_c_min = clamp(deflate_proof_lower_bound(-std::cos(
    antipodal_minimum_distance_deg / kRadiansToDegrees)), -1.0, 1.0);
  // A visible WGS84 point cannot lie beyond the radius-B spherical horizon
  // by more than the maximum angle between its geodetic normal and radial
  // direction. Restricting the relaxed cosine interval prevents far-side
  // shell points (which geometrically look along nadir through Earth) from
  // weakening the forward bound.
  const double horizon_ground_angle_rad = std::min(
    3.14159265358979323846,
    std::acos(clamp(
      kWgs84B / observer_distance_m,
      0.0,
      1.0)) +
      kMaximumGeodeticGeocentricLatitudeSeparationDeg /
        kRadiansToDegrees);
  const double c_min = std::max(
    rectangle_c_min,
    deflate_proof_lower_bound(std::cos(horizon_ground_angle_rad)));
  if (c_min > c_max) {
    return true;
  }
  const double cell_minimum_radius_m = std::max(
    kWgs84B,
    deflate_proof_lower_bound(std::min(
      radial_magnitude_at_geodetic_latitude(cell.minLatitudeDeg),
      radial_magnitude_at_geodetic_latitude(cell.maxLatitudeDeg))));
  if (
    !(cell_minimum_radius_m >= kWgs84B) ||
    !std::isfinite(cell_minimum_radius_m)
  ) {
    return false;
  }
  auto radial_forward = [&](double direction_cosine) {
    const double range_m = std::sqrt(std::max(
      0.0,
      observer_distance_m * observer_distance_m +
        cell_minimum_radius_m * cell_minimum_radius_m -
        2.0 * observer_distance_m * cell_minimum_radius_m *
          direction_cosine));
    if (!(range_m > 0.0)) {
      return 1.0;
    }
    return clamp(
      (observer_distance_m -
        cell_minimum_radius_m * direction_cosine) / range_m,
      -1.0,
      1.0);
  };
  const double radial_forward_upper = std::max(
    radial_forward(c_min),
    radial_forward(c_max));
  const Vec3 radial_nadir = scale(observer_unit, -1.0);
  const double boresight_chord = inflate_proof_upper_bound(magnitude(subtract(
    resolved.frame.boresight,
    radial_nadir)));
  const double forward_upper = inflate_proof_upper_bound(
    radial_forward_upper + boresight_chord);
  constexpr double kShapeBoundaryEpsilonRad = 1.0e-12;
  const double required_forward = deflate_proof_lower_bound(std::cos(std::min(
    3.14159265358979323846,
    sensor.shapeContract.outerHalfAngleRad +
      kShapeBoundaryEpsilonRad)));
  return forward_upper < required_forward;
}

bool solid_conic_nadir_sweep_proven_disjoint(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop) {
  if (!has_solid_conic_continuum_contract(sensor)) {
    return false;
  }
  const double start_distance_m = magnitude(start.state.position);
  const double stop_distance_m = magnitude(stop.state.position);
  if (
    !(start_distance_m > kWgs84A) ||
    !(stop_distance_m > kWgs84A)
  ) {
    return false;
  }
  const Vec3 start_unit = scale(
    start.state.position,
    1.0 / start_distance_m);
  const Vec3 stop_unit = scale(
    stop.state.position,
    1.0 / stop_distance_m);
  const double observer_chord = inflate_proof_upper_bound(magnitude(subtract(
    start_unit,
    stop_unit)));
  if (!(observer_chord < 2.0 - 1.0e-12)) {
    return false;
  }
  // Chord-based rotation remains conservative when dot(u,v) rounds to one;
  // acos(dot) would otherwise collapse a small real sweep to zero.
  const double observer_rotation_rad = inflate_proof_upper_bound(
    2.0 * std::asin(clamp(0.5 * observer_chord, 0.0, 1.0)));
  const double normalized_arc_minimum_length = deflate_proof_lower_bound(
    std::sqrt(std::max(
      0.0,
      1.0 - 0.25 * observer_chord * observer_chord)));
  if (!(normalized_arc_minimum_length > 0.0)) {
    return false;
  }

  // Bound the complete interpolated boresight's departure from radial nadir.
  // Endpoint raw-frame errors interpolate affinely, and unequal observer radii
  // perturb the normalized position chord. Normalization changes either vector
  // by no more than twice its relative precursor error divided by the chord's
  // minimum length.
  const double endpoint_nadir_chord_error = std::max(
    magnitude(add(start.state.sensorFrame.boresight, start_unit)),
    magnitude(add(stop.state.sensorFrame.boresight, stop_unit)));
  const double maximum_distance_raw_m = std::max(
    start_distance_m,
    stop_distance_m);
  const double maximum_distance_m = inflate_proof_upper_bound(
    maximum_distance_raw_m);
  const double radius_relative_error = inflate_proof_upper_bound(std::fabs(
    stop_distance_m - start_distance_m) /
      deflate_proof_lower_bound(maximum_distance_raw_m));
  const double boresight_nadir_chord_bound = inflate_proof_upper_bound(
    2.0 * (endpoint_nadir_chord_error + radius_relative_error) /
      normalized_arc_minimum_length);
  if (!(boresight_nadir_chord_bound < 0.25)) {
    return false;
  }
  const double maximum_off_nadir_rad = 2.0 * std::asin(clamp(
    0.5 * boresight_nadir_chord_bound,
    0.0,
    1.0));

  const double cell_minimum_radius_m = std::max(
    kWgs84B,
    deflate_proof_lower_bound(std::min(
      radial_magnitude_at_geodetic_latitude(cell.minLatitudeDeg),
      radial_magnitude_at_geodetic_latitude(cell.maxLatitudeDeg))));
  if (!(cell_minimum_radius_m > 0.0)) {
    return false;
  }

  // Directly bound the conic forward score over the complete observer arc
  // and cell rectangle. This is materially tighter than converting the cone
  // to a B-sphere ground cap, yet remains rejection-only. The distance from
  // either start direction to the moving arc can decrease by at most the
  // observer rotation (spherical triangle inequality).
  const double observer_rotation_deg =
    observer_rotation_rad * kRadiansToDegrees;
  const double nearest_start_distance_deg =
    sdn::coverage::minimumAngularDistanceToRectangleDeg(
      direction_lon_lat(start_unit),
      cell.minGeocentricLatitudeDeg,
      cell.maxGeocentricLatitudeDeg,
      cell.minLongitudeDeg,
      cell.maxLongitudeDeg);
  const double nearest_antipodal_distance_deg =
    sdn::coverage::minimumAngularDistanceToRectangleDeg(
      direction_lon_lat(scale(start_unit, -1.0)),
      cell.minGeocentricLatitudeDeg,
      cell.maxGeocentricLatitudeDeg,
      cell.minLongitudeDeg,
      cell.maxLongitudeDeg);
  if (
    std::isfinite(nearest_start_distance_deg) &&
    std::isfinite(nearest_antipodal_distance_deg)
  ) {
    constexpr double kAngularProofGuardDeg = 1.0e-9;
    const double minimum_track_distance_deg = std::max(
      0.0,
      nearest_start_distance_deg - observer_rotation_deg -
        kAngularProofGuardDeg);
    const double minimum_antipodal_track_distance_deg = std::max(
      0.0,
      nearest_antipodal_distance_deg - observer_rotation_deg -
        kAngularProofGuardDeg);
    const double c_max = clamp(inflate_proof_upper_bound(std::cos(
      minimum_track_distance_deg / kRadiansToDegrees)), -1.0, 1.0);
    const double rectangle_c_min = clamp(deflate_proof_lower_bound(-std::cos(
      minimum_antipodal_track_distance_deg / kRadiansToDegrees)),
      -1.0,
      1.0);
    const double horizon_ground_angle_rad = std::min(
      3.14159265358979323846,
      std::acos(clamp(
        kWgs84B / maximum_distance_m,
        0.0,
        1.0)) +
        kMaximumGeodeticGeocentricLatitudeSeparationDeg /
          kRadiansToDegrees);
    const double c_min = std::max(
      rectangle_c_min,
      deflate_proof_lower_bound(std::cos(horizon_ground_angle_rad)));
    if (c_min > c_max) {
      return true;
    }
    auto radial_forward = [&](double direction_cosine) {
      const double range_m = std::sqrt(std::max(
        0.0,
        maximum_distance_m * maximum_distance_m +
          cell_minimum_radius_m * cell_minimum_radius_m -
          2.0 * maximum_distance_m * cell_minimum_radius_m *
            direction_cosine));
      if (!(range_m > 0.0)) {
        return 1.0;
      }
      return clamp(
        (maximum_distance_m -
          cell_minimum_radius_m * direction_cosine) / range_m,
        -1.0,
        1.0);
    };
    const double radial_forward_upper = inflate_proof_upper_bound(std::max(
      radial_forward(c_min),
      radial_forward(c_max)));
    const double forward_upper = inflate_proof_upper_bound(
      radial_forward_upper + boresight_nadir_chord_bound);
    constexpr double kShapeBoundaryEpsilonRad = 1.0e-12;
    const double required_forward = deflate_proof_lower_bound(std::cos(
      std::min(
        3.14159265358979323846,
        sensor.shapeContract.outerHalfAngleRad +
          kShapeBoundaryEpsilonRad)));
    if (forward_upper < required_forward) {
      return true;
    }
  }
  const double instantaneous_ground_radius_deg =
    sdn::coverage::conservativeGroundCapRadiusDeg(
      maximum_distance_m,
      cell_minimum_radius_m,
      (maximum_off_nadir_rad + sensor.maxBoundaryAngleRad) *
        kRadiansToDegrees) +
      kMaximumGeodeticGeocentricLatitudeSeparationDeg;
  const double swept_radius_deg = inflate_proof_upper_bound(
    observer_rotation_deg +
      instantaneous_ground_radius_deg + 1.0e-9);
  const double minimum_cell_distance_deg =
    sdn::coverage::minimumAngularDistanceToRectangleDeg(
      direction_lon_lat(start_unit),
      cell.minGeocentricLatitudeDeg,
      cell.maxGeocentricLatitudeDeg,
      cell.minLongitudeDeg,
      cell.maxLongitudeDeg);
  return std::isfinite(minimum_cell_distance_deg) &&
    minimum_cell_distance_deg > swept_radius_deg;
}

bool solid_conic_cell_has_exact_spatial_witness(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& resolved,
    Vec3* witness_position = nullptr);

bool boresight_ground_point_inside_cell(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& resolved,
    Vec3* witness_position = nullptr) {
  // Only valid for shapes that actually contain their boresight direction —
  // inner-cutout (annular) shapes see a ring, not the beam center.
  if (!sensor_local_look_inside(sensor, {0.0, 0.0, 1.0})) {
    return false;
  }
  Vec3 ground_point;
  if (!intersect_earth(
        resolved.state.position,
        resolved.frame.boresight,
        1.0e100,
        ground_point)) {
    return false;
  }
  if (!surface_sample_visible_from_resolved_state(
        ground_point,
        geodetic_surface_normal(ground_point),
        sensor,
        resolved)) {
    return false;
  }
  const Vertex ground = to_cartographic(ground_point);
  if (
    ground.latitudeDeg < cell.minLatitudeDeg ||
    ground.latitudeDeg > cell.maxLatitudeDeg
  ) {
    return false;
  }
  const bool inside = longitude_inside_closed_cell(
    ground.longitudeDeg,
    cell.minLongitudeDeg,
    cell.maxLongitudeDeg);
  if (inside && witness_position) {
    *witness_position = ground_point;
  }
  return inside;
}

bool cell_visible_from_resolved_state(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& state,
    Vec3* witness_position = nullptr) {
  const bool solid_conic = has_solid_conic_continuum_contract(sensor);
  if (solid_conic) {
    if (!cell_intersects_conservative_sensor_cap(cell, sensor, state)) {
      return false;
    }
    if (solid_conic_cell_proven_angle_disjoint(cell, sensor, state)) {
      return false;
    }
  }
  for (int sample_index = 0; sample_index < cell.sampleCount; ++sample_index) {
    if (surface_sample_visible_from_resolved_state(
          cell.samplePositions[sample_index],
          cell.sampleNormals[sample_index],
          sensor,
          state)) {
      if (witness_position) {
        *witness_position = cell.samplePositions[sample_index];
      }
      return true;
    }
  }
  // Footprints narrower than the surface-sample pitch (pencil beams, small
  // apertures on coarse grids) can lie entirely between lattice points. The
  // exact boresight point is another fast accept.
  if (boresight_ground_point_inside_cell(
        cell,
        sensor,
        state,
        witness_position)) {
    return true;
  }

  // The WGS84/off-nadir conic footprint is not itself a spherical cap. The
  // cap below is a proven superset built from independent cone, horizon, and
  // range bounds. It may reject a disjoint cell, but cap overlap is never a
  // positive access proof. Inner-cutout, clock-limited, and non-conic shapes
  // retain exact lattice/boresight accepts only.
  if (!solid_conic) {
    return false;
  }
  return solid_conic_cell_has_exact_spatial_witness(
    cell,
    sensor,
    state,
    witness_position);
}

bool cell_visible_from_state(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const State& state) {
  return cell_visible_from_resolved_state(cell, sensor, resolve_visibility_state(state));
}

bool cell_visible_at_time(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop,
    double elapsed_seconds) {
  return cell_visible_from_state(cell, sensor, interpolate_state(start.state, stop.state, elapsed_seconds));
}

double refined_transition_time(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop,
    double left_time,
    bool left_visible,
    double right_time,
    bool right_visible) {
  double left = left_time;
  double right = right_time;
  bool visible_left = left_visible;
  bool visible_right = right_visible;
  for (int iteration = 0; iteration < kVisibilityTransitionRefinementIterations; ++iteration) {
    const double mid = 0.5 * (left + right);
    const bool visible_mid = cell_visible_at_time(cell, sensor, start, stop, mid);
    if (visible_mid == visible_left) {
      left = mid;
      visible_left = visible_mid;
    } else {
      right = mid;
      visible_right = visible_mid;
    }
  }
  return visible_right ? right : left;
}

VisibilityInterval refined_visibility_interval(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& interpolation_start,
    const ResolvedVisibilityState& interpolation_stop,
    const ResolvedVisibilityState& interval_start,
    const ResolvedVisibilityState& interval_stop) {
  if (!(interval_stop.state.elapsedSeconds > interval_start.state.elapsedSeconds)) {
    return {};
  }

  const bool visible_start = cell_visible_from_resolved_state(
    cell,
    sensor,
    interval_start);
  const bool visible_stop = cell_visible_from_resolved_state(
    cell,
    sensor,
    interval_stop);

  if (visible_start && visible_stop) {
    return {
      interval_start.state.elapsedSeconds,
      interval_stop.state.elapsedSeconds,
      true,
    };
  }
  if (visible_start && !visible_stop) {
    const double exit = refined_transition_time(
      cell,
      sensor,
      interpolation_start,
      interpolation_stop,
      interval_start.state.elapsedSeconds,
      true,
      interval_stop.state.elapsedSeconds,
      false);
    return {
      interval_start.state.elapsedSeconds,
      exit,
      exit >= interval_start.state.elapsedSeconds,
    };
  }
  if (!visible_start && visible_stop) {
    const double entry = refined_transition_time(
      cell,
      sensor,
      interpolation_start,
      interpolation_stop,
      interval_start.state.elapsedSeconds,
      false,
      interval_stop.state.elapsedSeconds,
      true);
    return {
      entry,
      interval_stop.state.elapsedSeconds,
      interval_stop.state.elapsedSeconds >= entry,
    };
  }

  const double mid_time = 0.5 * (
    interval_start.state.elapsedSeconds + interval_stop.state.elapsedSeconds);
  const bool visible_mid = cell_visible_at_time(
    cell,
    sensor,
    interpolation_start,
    interpolation_stop,
    mid_time);
  if (visible_mid) {
    const double entry = refined_transition_time(
      cell,
      sensor,
      interpolation_start,
      interpolation_stop,
      interval_start.state.elapsedSeconds,
      false,
      mid_time,
      true);
    const double exit = refined_transition_time(
      cell,
      sensor,
      interpolation_start,
      interpolation_stop,
      mid_time,
      true,
      interval_stop.state.elapsedSeconds,
      false);
    return {entry, exit, exit >= entry};
  }
  return {};
}

struct SweptSensorCap {
  Vertex center;
  double angularRadiusDeg = 180.0;
  double maximumBoresightOffNadirRad = 3.14159265358979323846;
  double minimumObserverDistanceM = 0.0;
  double maximumObserverDistanceM = 0.0;
  bool positiveProofEligible = false;
};

double minimum_magnitude_on_segment(Vec3 start, Vec3 stop) {
  const Vec3 displacement = subtract(stop, start);
  const double displacement_squared = dot(displacement, displacement);
  const double fraction = displacement_squared > 0.0
    ? clamp(-dot(start, displacement) / displacement_squared, 0.0, 1.0)
    : 0.0;
  return magnitude(add(start, scale(displacement, fraction)));
}

SweptSensorCap conservative_swept_sensor_cap(
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop,
    const SensorConfig& sensor) {
  const Vec3 start_observer_unit = normalize(start.state.position);
  const Vec3 stop_observer_unit = normalize(stop.state.position);
  const double observer_rotation_rad = std::acos(clamp(
    dot(start_observer_unit, stop_observer_unit),
    -1.0,
    1.0));
  const Vec3 start_nadir = scale(start_observer_unit, -1.0);
  const Vec3 stop_nadir = scale(stop_observer_unit, -1.0);
  const double start_off_nadir_rad = std::acos(clamp(
    dot(start.frame.boresight, start_nadir),
    -1.0,
    1.0));
  const double stop_off_nadir_rad = std::acos(clamp(
    dot(stop.frame.boresight, stop_nadir),
    -1.0,
    1.0));
  const double boresight_dot = clamp(
    dot(start.frame.boresight, stop.frame.boresight),
    -1.0,
    1.0);
  const double boresight_rotation_rad = std::acos(boresight_dot);

  // Linear interpolation followed by normalization traces the minor great-
  // circle arc for non-antipodal vectors. The triangle inequality therefore
  // bounds every intermediate off-nadir angle by the start angle plus the
  // complete boresight and observer rotations. Near-antipodal input falls
  // back to the full sphere instead of making an unsafe pruning decision.
  double maximum_off_nadir_rad = 3.14159265358979323846;
  bool positive_proof_eligible = false;
  if (
    dot(start_observer_unit, stop_observer_unit) > -0.999999999999 &&
    boresight_dot > -0.999999999999 &&
    start.state.sensorFrame.valid &&
    stop.state.sensorFrame.valid
  ) {
    maximum_off_nadir_rad = std::min(
      3.14159265358979323846,
      std::max({
        start_off_nadir_rad,
        stop_off_nadir_rad,
        start_off_nadir_rad + boresight_rotation_rad + observer_rotation_rad,
      }));
    positive_proof_eligible = true;
  }

  const double maximum_observer_distance_m = std::max(
    magnitude(start.state.position),
    magnitude(stop.state.position));
  const double minimum_observer_distance_m = minimum_magnitude_on_segment(
    start.state.position,
    stop.state.position);
  const double instantaneous_radius_deg =
    sdn::coverage::conservativeGroundCapRadiusDeg(
      maximum_observer_distance_m,
      kWgs84B,
      (maximum_off_nadir_rad + sensor.maxBoundaryAngleRad) *
        kRadiansToDegrees) +
      kMaximumGeodeticGeocentricLatitudeSeparationDeg + 1.0e-9;
  return {
    direction_lon_lat(start_observer_unit),
    std::min(
      180.0,
      observer_rotation_rad * kRadiansToDegrees +
        instantaneous_radius_deg),
    maximum_off_nadir_rad,
    minimum_observer_distance_m,
    maximum_observer_distance_m,
    positive_proof_eligible,
  };
}

bool fixed_local_shape_ray_angle_rad(
    const SensorConfig& sensor,
    double& angle_rad) {
  const SensorShapeContract& shape = sensor.shapeContract;
  if (!shape.supported) {
    return false;
  }
  switch (shape.kind) {
    case SensorShapeKind::Rectangular:
      angle_rad = 0.0;
      return true;
    case SensorShapeKind::Conic:
    case SensorShapeKind::SarAnnularSector:
      if (
        shape.outerHalfAngleRad < shape.innerHalfAngleRad ||
        shape.innerHalfAngleRad > 3.14159265358979323846
      ) {
        return false;
      }
      angle_rad = clamp(
        0.5 * (shape.innerHalfAngleRad + shape.outerHalfAngleRad),
        0.0,
        3.14159265358979323846);
      return
        angle_rad >= shape.innerHalfAngleRad &&
        angle_rad <= shape.outerHalfAngleRad;
    case SensorShapeKind::CustomPolygon:
      if (sensor.localBoundaryDirections.empty()) {
        return false;
      }
      angle_rad = std::acos(clamp(
        sensor.localBoundaryDirections.front().z,
        -1.0,
        1.0));
      return std::isfinite(angle_rad);
    case SensorShapeKind::Unknown:
    default:
      return false;
  }
}

bool local_shape_ray_reaches_visible_surface_for_entire_interval(
    const SensorConfig& sensor,
    const SweptSensorCap& cap,
    double local_ray_angle_rad) {
  if (
    !cap.positiveProofEligible ||
    !(cap.minimumObserverDistanceM > kWgs84A) ||
    !(cap.maximumObserverDistanceM >= cap.minimumObserverDistanceM)
  ) {
    return false;
  }

  const double maximum_look_angle_rad =
    cap.maximumBoresightOffNadirRad + local_ray_angle_rad;
  const double horizon_look_angle_rad = std::asin(clamp(
    kWgs84B / cap.maximumObserverDistanceM,
    0.0,
    1.0));
  if (
    !std::isfinite(maximum_look_angle_rad) ||
    !(maximum_look_angle_rad < horizon_look_angle_rad)
  ) {
    return false;
  }

  // The WGS84 ellipsoid contains the sphere of radius B. A ray that crosses
  // that sphere must enter WGS84 no later, so the sphere's near intersection
  // is a conservative upper bound on the ellipsoid hit range.
  const double sin_look = std::sin(maximum_look_angle_rad);
  const double cos_look = std::cos(maximum_look_angle_rad);
  const double discriminant =
    kWgs84B * kWgs84B -
    cap.maximumObserverDistanceM * cap.maximumObserverDistanceM *
      sin_look * sin_look;
  if (!(discriminant > 0.0)) {
    return false;
  }
  const double maximum_hit_range_m =
    cap.maximumObserverDistanceM * cos_look - std::sqrt(discriminant);
  if (
    sensor.shapeContract.maxRangeM > 0.0 &&
    maximum_hit_range_m > sensor.shapeContract.maxRangeM
  ) {
    return false;
  }

  // Every WGS84 surface point lies inside the sphere of radius A. The reverse
  // triangle inequality therefore supplies a range lower bound independent of
  // ray azimuth and ellipsoid latitude.
  const double minimum_hit_range_m =
    cap.minimumObserverDistanceM - kWgs84A;
  return
    sensor.shapeContract.minRangeM <= 0.0 ||
    minimum_hit_range_m >= sensor.shapeContract.minRangeM;
}

bool fixed_shape_ray_reaches_visible_surface_for_entire_interval(
    const SensorConfig& sensor,
    const SweptSensorCap& cap) {
  double local_ray_angle_rad = 0.0;
  return
    fixed_local_shape_ray_angle_rad(sensor, local_ray_angle_rad) &&
    local_shape_ray_reaches_visible_surface_for_entire_interval(
      sensor,
      cap,
      local_ray_angle_rad);
}

bool spherical_cap_inside_cell(
    const SweptSensorCap& cap,
    const GridCellGeometry& cell) {
  // Area/point-target region gate (Gate 3 — suppress cap-inside-rectangle
  // fast-accept). A swept cap contained in the target's bounding rectangle does
  // NOT imply it is contained in the region (rect ⊋ region), so this and every
  // whole-interval proof that funnels through it (continuously-visible footprint,
  // moving-ray, SAR/patch geometry proofs) must not short-circuit to VISIBLE for
  // a target. Returning false only cancels the fast-accept; the concrete
  // region-gated witness search below still decides the target.
  if (t_target_region_gate != nullptr) {
    return false;
  }
  if (
    !std::isfinite(cap.angularRadiusDeg) ||
    cap.angularRadiusDeg < 0.0 ||
    cap.angularRadiusDeg >= 180.0 ||
    cap.center.latitudeDeg < cell.minGeocentricLatitudeDeg ||
    cap.center.latitudeDeg > cell.maxGeocentricLatitudeDeg ||
    !longitude_inside_closed_cell(
      cap.center.longitudeDeg,
      cell.minLongitudeDeg,
      cell.maxLongitudeDeg)
  ) {
    return false;
  }

  double minimum_boundary_distance_deg = std::min(
    cap.center.latitudeDeg - cell.minGeocentricLatitudeDeg,
    cell.maxGeocentricLatitudeDeg - cap.center.latitudeDeg);
  if (cell.maxLongitudeDeg - cell.minLongitudeDeg < 360.0) {
    const double longitude_reference_deg =
      0.5 * (cell.minLongitudeDeg + cell.maxLongitudeDeg);
    double center_longitude_deg = cap.center.longitudeDeg;
    while (center_longitude_deg - longitude_reference_deg > 180.0) {
      center_longitude_deg -= 360.0;
    }
    while (center_longitude_deg - longitude_reference_deg < -180.0) {
      center_longitude_deg += 360.0;
    }
    const double center_latitude_rad =
      cap.center.latitudeDeg / kRadiansToDegrees;
    auto distance_to_meridian_deg = [&](double longitude_deg) {
      const double longitude_delta_rad =
        (center_longitude_deg - longitude_deg) / kRadiansToDegrees;
      return std::asin(clamp(
        std::fabs(std::cos(center_latitude_rad) *
          std::sin(longitude_delta_rad)),
        0.0,
        1.0)) * kRadiansToDegrees;
    };
    minimum_boundary_distance_deg = std::min({
      minimum_boundary_distance_deg,
      distance_to_meridian_deg(cell.minLongitudeDeg),
      distance_to_meridian_deg(cell.maxLongitudeDeg),
    });
  }

  constexpr double kContainmentSafetyDeg = 1.0e-9;
  return
    cap.angularRadiusDeg + kContainmentSafetyDeg <
    minimum_boundary_distance_deg;
}

bool cell_contains_continuously_visible_sensor_footprint(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop,
    const SweptSensorCap* precomputed_cap = nullptr) {
  const SweptSensorCap computed_cap = precomputed_cap
    ? SweptSensorCap{}
    : conservative_swept_sensor_cap(start, stop, sensor);
  const SweptSensorCap& cap = precomputed_cap
    ? *precomputed_cap
    : computed_cap;
  return
    spherical_cap_inside_cell(cap, cell) &&
    fixed_shape_ray_reaches_visible_surface_for_entire_interval(sensor, cap);
}

double inflate_proof_upper_bound(double value) {
  const double scale_value = std::max(1.0, std::fabs(value));
  const double inflated = value +
    128.0 * std::numeric_limits<double>::epsilon() * scale_value;
  return std::nextafter(inflated, std::numeric_limits<double>::infinity());
}

double deflate_proof_lower_bound(double value) {
  const double scale_value = std::max(1.0, std::fabs(value));
  const double deflated = value -
    128.0 * std::numeric_limits<double>::epsilon() * scale_value;
  return std::nextafter(deflated, -std::numeric_limits<double>::infinity());
}

struct UnitDirectionEnvelope {
  Vec3 center;
  double chordError = 2.0;
  bool valid = false;
};

UnitDirectionEnvelope normalized_arc_envelope(Vec3 start, Vec3 stop) {
  const double start_length = magnitude(start);
  const double stop_length = magnitude(stop);
  if (
    !(start_length > 0.0) ||
    !(stop_length > 0.0) ||
    !std::isfinite(start_length) ||
    !std::isfinite(stop_length)
  ) {
    return {};
  }
  const Vec3 unit_start = scale(start, 1.0 / start_length);
  const Vec3 unit_stop = scale(stop, 1.0 / stop_length);
  if (dot(unit_start, unit_stop) <= -0.999999999999) {
    return {};
  }
  const Vec3 center = normalize(add(unit_start, unit_stop));
  const double chord_error = inflate_proof_upper_bound(std::max(
    magnitude(subtract(unit_start, center)),
    magnitude(subtract(unit_stop, center))));
  return {center, chord_error, chord_error < 2.0};
}

UnitDirectionEnvelope normalized_ball_envelope(
    Vec3 center_vector,
    double vector_error) {
  const double center_length = magnitude(center_vector);
  const double error = inflate_proof_upper_bound(std::max(0.0, vector_error));
  if (
    !(center_length > error) ||
    !std::isfinite(center_length) ||
    !std::isfinite(error)
  ) {
    return {};
  }
  const double angular_error = std::asin(clamp(
    error / center_length,
    0.0,
    1.0));
  const double chord_error = inflate_proof_upper_bound(
    2.0 * std::sin(0.5 * angular_error));
  return {normalize(center_vector), chord_error, chord_error < 2.0};
}

bool resolved_frame_envelopes(
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop,
    UnitDirectionEnvelope& boresight,
    UnitDirectionEnvelope& x_axis,
    UnitDirectionEnvelope& y_axis) {
  if (!start.state.sensorFrame.valid || !stop.state.sensorFrame.valid) {
    return false;
  }

  boresight = normalized_arc_envelope(
    start.state.sensorFrame.boresight,
    stop.state.sensorFrame.boresight);
  const UnitDirectionEnvelope raw_x = normalized_arc_envelope(
    start.state.sensorFrame.xAxis,
    stop.state.sensorFrame.xAxis);
  const UnitDirectionEnvelope raw_y = normalized_arc_envelope(
    start.state.sensorFrame.yAxis,
    stop.state.sensorFrame.yAxis);
  if (!boresight.valid || !raw_x.valid || !raw_y.valid) {
    return false;
  }

  const Vec3 projected_x = subtract(
    raw_x.center,
    scale(boresight.center, dot(raw_x.center, boresight.center)));
  const double projected_x_error = inflate_proof_upper_bound(
    2.0 * (raw_x.chordError + boresight.chordError));
  x_axis = normalized_ball_envelope(projected_x, projected_x_error);
  if (!x_axis.valid) {
    return false;
  }

  const Vec3 y_without_boresight = subtract(
    raw_y.center,
    scale(boresight.center, dot(raw_y.center, boresight.center)));
  const double y_without_boresight_error = inflate_proof_upper_bound(
    2.0 * (raw_y.chordError + boresight.chordError));
  const Vec3 projected_y = subtract(
    y_without_boresight,
    scale(x_axis.center, dot(y_without_boresight, x_axis.center)));
  const double projected_y_error = inflate_proof_upper_bound(
    2.0 * y_without_boresight_error + 2.0 * x_axis.chordError);
  y_axis = normalized_ball_envelope(projected_y, projected_y_error);
  return y_axis.valid;
}

struct IntervalShapeProofContext {
  SweptSensorCap sweptCap;
  UnitDirectionEnvelope boresight;
  UnitDirectionEnvelope xAxis;
  UnitDirectionEnvelope yAxis;
  bool valid = false;
};

IntervalShapeProofContext interval_shape_proof_context(
    const SensorConfig& sensor,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop) {
  IntervalShapeProofContext context{};
  context.sweptCap = conservative_swept_sensor_cap(start, stop, sensor);
  context.valid = resolved_frame_envelopes(
    start,
    stop,
    context.boresight,
    context.xAxis,
    context.yAxis);
  return context;
}

Vec3 world_direction_for_local_ray(
    const SensorFrame& frame,
    SensorVec3 local_direction) {
  return normalize(add(
    add(
      scale(frame.xAxis, local_direction.x),
      scale(frame.yAxis, local_direction.y)),
    scale(frame.boresight, local_direction.z)));
}

bool local_ray_is_inside_shape(
    const SensorConfig& sensor,
    SensorVec3 local_direction) {
  const SensorShapeContract& shape = sensor.shapeContract;
  const double minimum_range_m = std::max(0.0, shape.minRangeM);
  const double maximum_range_m = shape.maxRangeM > 0.0
    ? shape.maxRangeM
    : std::max(1.0, minimum_range_m + 1.0);
  if (maximum_range_m < minimum_range_m) {
    return false;
  }
  const double probe_range_m = 0.5 * (
    minimum_range_m + maximum_range_m);
  const double direction_length = std::sqrt(
    local_direction.x * local_direction.x +
    local_direction.y * local_direction.y +
    local_direction.z * local_direction.z);
  if (!(direction_length > 0.0)) {
    return false;
  }
  return sensor_local_look_inside(sensor, {
    local_direction.x * probe_range_m / direction_length,
    local_direction.y * probe_range_m / direction_length,
    local_direction.z * probe_range_m / direction_length,
  });
}

struct ProofInterval {
  double lower = 0.0;
  double upper = 0.0;
  bool valid = false;
};

ProofInterval proof_interval(double lower, double upper) {
  if (!std::isfinite(lower) || !std::isfinite(upper) || lower > upper) {
    return {};
  }
  return {
    deflate_proof_lower_bound(lower),
    inflate_proof_upper_bound(upper),
    true,
  };
}

ProofInterval add_proof_intervals(
    ProofInterval left,
    ProofInterval right) {
  if (!left.valid || !right.valid) {
    return {};
  }
  return proof_interval(
    left.lower + right.lower,
    left.upper + right.upper);
}

ProofInterval subtract_proof_intervals(
    ProofInterval left,
    ProofInterval right) {
  if (!left.valid || !right.valid) {
    return {};
  }
  return proof_interval(
    left.lower - right.upper,
    left.upper - right.lower);
}

ProofInterval multiply_proof_intervals(
    ProofInterval left,
    ProofInterval right) {
  if (!left.valid || !right.valid) {
    return {};
  }
  const double products[] = {
    left.lower * right.lower,
    left.lower * right.upper,
    left.upper * right.lower,
    left.upper * right.upper,
  };
  return proof_interval(
    *std::min_element(std::begin(products), std::end(products)),
    *std::max_element(std::begin(products), std::end(products)));
}

ProofInterval square_proof_interval(ProofInterval value) {
  if (!value.valid) {
    return {};
  }
  const double maximum = std::max(
    value.lower * value.lower,
    value.upper * value.upper);
  const double minimum = value.lower <= 0.0 && value.upper >= 0.0
    ? 0.0
    : std::min(
      value.lower * value.lower,
      value.upper * value.upper);
  return proof_interval(minimum, maximum);
}

ProofInterval scale_proof_interval(ProofInterval value, double factor) {
  if (!value.valid || !std::isfinite(factor)) {
    return {};
  }
  return factor >= 0.0
    ? proof_interval(value.lower * factor, value.upper * factor)
    : proof_interval(value.upper * factor, value.lower * factor);
}

ProofInterval sqrt_proof_interval(ProofInterval value) {
  if (!value.valid || value.lower < 0.0) {
    return {};
  }
  return proof_interval(
    std::sqrt(value.lower),
    std::sqrt(value.upper));
}

ProofInterval divide_proof_intervals(
    ProofInterval numerator,
    ProofInterval denominator) {
  if (
    !numerator.valid ||
    !denominator.valid ||
    denominator.lower <= 0.0
  ) {
    return {};
  }
  return multiply_proof_intervals(
    numerator,
    proof_interval(
      1.0 / denominator.upper,
      1.0 / denominator.lower));
}

ProofInterval centered_proof_interval(double center, double error) {
  if (!std::isfinite(center) || !std::isfinite(error) || error < 0.0) {
    return {};
  }
  return proof_interval(center - error, center + error);
}

bool conservative_ray_ellipsoid_ground_track_cap(
    const SensorConfig& sensor,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop,
    UnitDirectionEnvelope ray,
    double local_angular_radius_rad,
    SweptSensorCap& ground_cap) {
  if (!ray.valid || local_angular_radius_rad < 0.0) {
    return false;
  }
  ray.chordError = inflate_proof_upper_bound(
    ray.chordError +
    2.0 * std::sin(0.5 * std::min(
      local_angular_radius_rad,
      3.14159265358979323846)));
  if (!(ray.chordError < 2.0)) {
    return false;
  }

  const Vec3 position_center = scale(add(
    start.state.position,
    stop.state.position), 0.5);
  const Vec3 position_error_components = scale({
    std::fabs(stop.state.position.x - start.state.position.x),
    std::fabs(stop.state.position.y - start.state.position.y),
    std::fabs(stop.state.position.z - start.state.position.z),
  }, 0.5);
  const ProofInterval positions[] = {
    centered_proof_interval(
      position_center.x,
      position_error_components.x),
    centered_proof_interval(
      position_center.y,
      position_error_components.y),
    centered_proof_interval(
      position_center.z,
      position_error_components.z),
  };
  const ProofInterval directions[] = {
    centered_proof_interval(ray.center.x, ray.chordError),
    centered_proof_interval(ray.center.y, ray.chordError),
    centered_proof_interval(ray.center.z, ray.chordError),
  };
  const double inverse_radii_squared[] = {
    1.0 / kWgs84A2,
    1.0 / kWgs84A2,
    1.0 / kWgs84B2,
  };

  ProofInterval quadratic_a = proof_interval(0.0, 0.0);
  ProofInterval quadratic_b = proof_interval(0.0, 0.0);
  ProofInterval quadratic_c = proof_interval(-1.0, -1.0);
  for (int component = 0; component < 3; ++component) {
    quadratic_a = add_proof_intervals(
      quadratic_a,
      scale_proof_interval(
        square_proof_interval(directions[component]),
        inverse_radii_squared[component]));
    quadratic_b = add_proof_intervals(
      quadratic_b,
      scale_proof_interval(
        multiply_proof_intervals(
          positions[component],
          directions[component]),
        inverse_radii_squared[component]));
    quadratic_c = add_proof_intervals(
      quadratic_c,
      scale_proof_interval(
        square_proof_interval(positions[component]),
        inverse_radii_squared[component]));
  }
  const ProofInterval discriminant = subtract_proof_intervals(
    square_proof_interval(quadratic_b),
    multiply_proof_intervals(quadratic_a, quadratic_c));
  if (
    !quadratic_a.valid ||
    !quadratic_b.valid ||
    !quadratic_c.valid ||
    !discriminant.valid ||
    !(quadratic_a.lower > 0.0) ||
    !(quadratic_c.lower > 0.0) ||
    !(discriminant.lower > 0.0)
  ) {
    return false;
  }

  // The near positive root is evaluated as C/(-B+sqrt(D)); this is
  // algebraically equivalent to the quadratic formula and avoids cancellation
  // for a low-orbit observer looking toward Earth.
  const ProofInterval negative_b = proof_interval(
    -quadratic_b.upper,
    -quadratic_b.lower);
  const ProofInterval denominator = add_proof_intervals(
    negative_b,
    sqrt_proof_interval(discriminant));
  const ProofInterval hit_range = divide_proof_intervals(
    quadratic_c,
    denominator);
  if (
    !hit_range.valid ||
    !(hit_range.lower > 0.0) ||
    (sensor.shapeContract.minRangeM > 0.0 &&
      hit_range.lower < sensor.shapeContract.minRangeM) ||
    (sensor.shapeContract.maxRangeM > 0.0 &&
      hit_range.upper > sensor.shapeContract.maxRangeM)
  ) {
    return false;
  }

  const double reference_range_m = 0.5 * (
    hit_range.lower + hit_range.upper);
  const Vec3 ground_center_vector = add(
    position_center,
    scale(ray.center, reference_range_m));
  const double ground_error_m = inflate_proof_upper_bound(
    magnitude(position_error_components) +
    hit_range.upper * ray.chordError +
    0.5 * (hit_range.upper - hit_range.lower));
  const UnitDirectionEnvelope ground_direction = normalized_ball_envelope(
    ground_center_vector,
    ground_error_m);
  if (!ground_direction.valid) {
    return false;
  }
  ground_cap = {};
  ground_cap.center = direction_lon_lat(ground_direction.center);
  ground_cap.angularRadiusDeg = inflate_proof_upper_bound(
    2.0 * std::asin(clamp(
      0.5 * ground_direction.chordError,
      0.0,
      1.0)) * kRadiansToDegrees);
  ground_cap.minimumObserverDistanceM = minimum_magnitude_on_segment(
    start.state.position,
    stop.state.position);
  ground_cap.maximumObserverDistanceM = std::max(
    magnitude(start.state.position),
    magnitude(stop.state.position));
  ground_cap.positiveProofEligible = true;
  return std::isfinite(ground_cap.angularRadiusDeg);
}

bool conservative_ray_sphere_shell_ground_track_cap(
    const SensorConfig& sensor,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop,
    UnitDirectionEnvelope ray,
    double local_angular_radius_rad,
    SweptSensorCap& ground_cap) {
  if (!ray.valid || local_angular_radius_rad < 0.0) {
    return false;
  }
  ray.chordError = inflate_proof_upper_bound(
    ray.chordError +
    2.0 * std::sin(0.5 * std::min(
      local_angular_radius_rad,
      3.14159265358979323846)));
  const UnitDirectionEnvelope observer = normalized_arc_envelope(
    start.state.position,
    stop.state.position);
  if (!observer.valid || !(ray.chordError < 2.0)) {
    return false;
  }

  const double inward_cosine_center = dot(
    ray.center,
    scale(observer.center, -1.0));
  const double inward_cosine_error = inflate_proof_upper_bound(
    ray.chordError + observer.chordError);
  const double minimum_inward_cosine = deflate_proof_lower_bound(
    inward_cosine_center - inward_cosine_error);
  const double maximum_inward_cosine = std::min(
    1.0,
    inflate_proof_upper_bound(
      inward_cosine_center + inward_cosine_error));
  if (!(minimum_inward_cosine > 0.0)) {
    return false;
  }

  const double minimum_observer_distance_m = deflate_proof_lower_bound(
    minimum_magnitude_on_segment(
      start.state.position,
      stop.state.position));
  const double maximum_observer_distance_m = inflate_proof_upper_bound(
    std::max(
      magnitude(start.state.position),
      magnitude(stop.state.position)));
  if (!(minimum_observer_distance_m > kWgs84A)) {
    return false;
  }
  auto sphere_hit_range = [](double distance, double inward_cosine, double radius) {
    const double transverse_squared = distance * distance * std::max(
      0.0,
      1.0 - inward_cosine * inward_cosine);
    const double discriminant = radius * radius - transverse_squared;
    if (!(discriminant > 0.0)) {
      return std::numeric_limits<double>::quiet_NaN();
    }
    return distance * inward_cosine - std::sqrt(discriminant);
  };
  // WGS84 contains the B sphere and is contained by the A sphere. For an
  // inward ray crossing B, the ellipsoid's first hit lies between the outer-
  // sphere and inner-sphere hits. The near-hit range increases with observer
  // distance and decreases with inward cosine for every observer outside A.
  const double minimum_hit_range_m = deflate_proof_lower_bound(
    sphere_hit_range(
      minimum_observer_distance_m,
      maximum_inward_cosine,
      kWgs84A));
  const double maximum_hit_range_m = inflate_proof_upper_bound(
    sphere_hit_range(
      maximum_observer_distance_m,
      minimum_inward_cosine,
      kWgs84B));
  if (
    !std::isfinite(minimum_hit_range_m) ||
    !std::isfinite(maximum_hit_range_m) ||
    !(minimum_hit_range_m > 0.0) ||
    maximum_hit_range_m < minimum_hit_range_m ||
    (sensor.shapeContract.minRangeM > 0.0 &&
      minimum_hit_range_m < sensor.shapeContract.minRangeM) ||
    (sensor.shapeContract.maxRangeM > 0.0 &&
      maximum_hit_range_m > sensor.shapeContract.maxRangeM)
  ) {
    return false;
  }

  const Vec3 position_center = scale(add(
    start.state.position,
    stop.state.position), 0.5);
  const double position_error_m = 0.5 * magnitude(subtract(
    stop.state.position,
    start.state.position));
  const double reference_range_m = 0.5 * (
    minimum_hit_range_m + maximum_hit_range_m);
  const Vec3 ground_center_vector = add(
    position_center,
    scale(ray.center, reference_range_m));
  const double ground_error_m = inflate_proof_upper_bound(
    position_error_m +
    maximum_hit_range_m * ray.chordError +
    0.5 * (maximum_hit_range_m - minimum_hit_range_m));
  const UnitDirectionEnvelope ground_direction = normalized_ball_envelope(
    ground_center_vector,
    ground_error_m);
  if (!ground_direction.valid) {
    return false;
  }
  ground_cap = {};
  ground_cap.center = direction_lon_lat(ground_direction.center);
  ground_cap.angularRadiusDeg = inflate_proof_upper_bound(
    2.0 * std::asin(clamp(
      0.5 * ground_direction.chordError,
      0.0,
      1.0)) * kRadiansToDegrees);
  ground_cap.minimumObserverDistanceM = minimum_observer_distance_m;
  ground_cap.maximumObserverDistanceM = maximum_observer_distance_m;
  ground_cap.positiveProofEligible = true;
  return std::isfinite(ground_cap.angularRadiusDeg);
}

bool conservative_fixed_local_ray_ground_track_cap(
    const SensorConfig& sensor,
    SensorVec3 local_direction,
    double local_angular_radius_rad,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop,
    const SweptSensorCap& interval_cap,
    const UnitDirectionEnvelope& boresight,
    const UnitDirectionEnvelope& x_axis,
    const UnitDirectionEnvelope& y_axis,
    SweptSensorCap& ray_ground_cap) {
  if (
    !local_ray_is_inside_shape(sensor, local_direction) ||
    !std::isfinite(local_angular_radius_rad) ||
    local_angular_radius_rad < 0.0
  ) {
    return false;
  }
  const double local_length = std::sqrt(
    local_direction.x * local_direction.x +
    local_direction.y * local_direction.y +
    local_direction.z * local_direction.z);
  const double local_x = local_direction.x / local_length;
  const double local_y = local_direction.y / local_length;
  const double local_z = local_direction.z / local_length;
  const double local_ray_angle_rad =
    std::acos(clamp(local_z, -1.0, 1.0)) + local_angular_radius_rad;
  if (!local_shape_ray_reaches_visible_surface_for_entire_interval(
        sensor,
        interval_cap,
        local_ray_angle_rad)) {
    return false;
  }

  const Vec3 ray_center_vector = add(
    add(
      scale(x_axis.center, local_x),
      scale(y_axis.center, local_y)),
    scale(boresight.center, local_z));
  const double ray_vector_error = inflate_proof_upper_bound(
    std::fabs(local_x) * x_axis.chordError +
    std::fabs(local_y) * y_axis.chordError +
    std::fabs(local_z) * boresight.chordError);
  const UnitDirectionEnvelope ray_envelope = normalized_ball_envelope(
    ray_center_vector,
    ray_vector_error);
  if (!ray_envelope.valid) {
    return false;
  }
  if (conservative_ray_sphere_shell_ground_track_cap(
        sensor,
        start,
        stop,
        ray_envelope,
        local_angular_radius_rad,
        ray_ground_cap)) {
    return true;
  }
  if (conservative_ray_ellipsoid_ground_track_cap(
        sensor,
        start,
        stop,
        ray_envelope,
        local_angular_radius_rad,
        ray_ground_cap)) {
    return true;
  }
  const Vec3 start_ray = world_direction_for_local_ray(
    start.frame,
    {local_x, local_y, local_z});
  Vec3 start_ground;
  if (!intersect_earth(
        start.state.position,
        start_ray,
        1.0e100,
        start_ground)) {
    return false;
  }
  const double ray_chord_from_start = inflate_proof_upper_bound(
    magnitude(subtract(start_ray, ray_envelope.center)) +
      ray_envelope.chordError);
  if (!(ray_chord_from_start < 2.0)) {
    return false;
  }
  const double ray_rotation_rad = inflate_proof_upper_bound(
    2.0 * std::asin(clamp(
      0.5 * ray_chord_from_start,
      0.0,
      1.0)));
  const Vec3 start_observer_unit = normalize(start.state.position);
  const Vec3 stop_observer_unit = normalize(stop.state.position);
  const double observer_chord = inflate_proof_upper_bound(magnitude(subtract(
    start_observer_unit,
    stop_observer_unit)));
  if (!(observer_chord < 2.0)) {
    return false;
  }
  const double observer_rotation_rad = inflate_proof_upper_bound(
    2.0 * std::asin(clamp(0.5 * observer_chord, 0.0, 1.0)));
  const Vec3 start_nadir = scale(start_observer_unit, -1.0);
  const double start_off_nadir_chord = inflate_proof_upper_bound(
    magnitude(subtract(start_ray, start_nadir)));
  const double start_off_nadir_rad = inflate_proof_upper_bound(
    2.0 * std::asin(clamp(
      0.5 * start_off_nadir_chord,
      0.0,
      1.0)));

  double mapped_ray_radius_deg = 0.0;
  if (!conservative_boresight_footprint_cap_radius_deg(
        interval_cap.maximumObserverDistanceM,
        start_off_nadir_rad,
        ray_rotation_rad + observer_rotation_rad +
          local_angular_radius_rad,
        mapped_ray_radius_deg)) {
    return false;
  }
  // Even with zero angular rotation, an off-nadir ray's ground hit moves as
  // observer radius changes. Bound that radial mapping displacement on the B
  // sphere at both extrema; WGS84 conversion slack is paid separately below.
  const double start_observer_distance_m = magnitude(start.state.position);
  if (
    !(interval_cap.minimumObserverDistanceM > kWgs84B) ||
    !(interval_cap.maximumObserverDistanceM >=
      interval_cap.minimumObserverDistanceM) ||
    !(start_observer_distance_m > kWgs84B)
  ) {
    return false;
  }
  const double start_ground_radius_deg =
    sdn::coverage::conservativeGroundCapRadiusDeg(
      start_observer_distance_m,
      kWgs84B,
      start_off_nadir_rad * kRadiansToDegrees);
  const double minimum_distance_ground_radius_deg =
    sdn::coverage::conservativeGroundCapRadiusDeg(
      interval_cap.minimumObserverDistanceM,
      kWgs84B,
      start_off_nadir_rad * kRadiansToDegrees);
  const double maximum_distance_ground_radius_deg =
    sdn::coverage::conservativeGroundCapRadiusDeg(
      interval_cap.maximumObserverDistanceM,
      kWgs84B,
      start_off_nadir_rad * kRadiansToDegrees);
  const double observer_radius_mapping_shift_deg =
    inflate_proof_upper_bound(std::max(
      std::fabs(
        minimum_distance_ground_radius_deg - start_ground_radius_deg),
      std::fabs(
        maximum_distance_ground_radius_deg - start_ground_radius_deg)));
  ray_ground_cap = {};
  ray_ground_cap.center = direction_lon_lat(start_ground);
  ray_ground_cap.angularRadiusDeg = inflate_proof_upper_bound(
    observer_rotation_rad * kRadiansToDegrees +
      mapped_ray_radius_deg +
      observer_radius_mapping_shift_deg +
      2.0 * kMaximumGeodeticGeocentricLatitudeSeparationDeg +
      1.0e-9);
  return true;
}

bool fixed_local_ray_ground_track_inside_cell(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    SensorVec3 local_direction,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop,
    const SweptSensorCap& interval_cap,
    const UnitDirectionEnvelope& boresight,
    const UnitDirectionEnvelope& x_axis,
    const UnitDirectionEnvelope& y_axis) {
  SweptSensorCap ray_ground_cap;
  return
    conservative_fixed_local_ray_ground_track_cap(
      sensor,
      local_direction,
      0.0,
      start,
      stop,
      interval_cap,
      boresight,
      x_axis,
      y_axis,
      ray_ground_cap) &&
    spherical_cap_inside_cell(ray_ground_cap, cell);
}

struct LocalLookEnvelope {
  double xCenter = 0.0;
  double yCenter = 0.0;
  double zCenter = 0.0;
  double xError = 2.0;
  double yError = 2.0;
  double zError = 2.0;
  double transverseError = 2.0;
  double minimumRangeM = 0.0;
  double maximumRangeM = std::numeric_limits<double>::infinity();
  bool valid = false;
};

double radial_magnitude_at_geodetic_latitude(double latitude_deg) {
  const Vec3 position = geodetic_to_ecef({
    0.0,
    latitude_deg / kRadiansToDegrees,
    0.0,
  });
  return magnitude(position);
}

double geocentric_latitude_at_geodetic_latitude(double latitude_deg) {
  const Vec3 position = geodetic_to_ecef({
    0.0,
    latitude_deg / kRadiansToDegrees,
    0.0,
  });
  return std::atan2(
    position.z,
    std::hypot(position.x, position.y));
}

double conservative_surface_patch_radius_m(
    double min_latitude_deg,
    double max_latitude_deg,
    double min_longitude_deg,
    double max_longitude_deg,
    double maximum_parallel_derivative_m) {
  // For the zero-altitude WGS84 parameterization P(phi,lambda), the geodetic
  // coordinate derivatives are orthogonal with
  //   |dP/dphi| = M(phi) <= a^2/b
  //   |dP/dlambda| = N(phi) cos(phi).
  // The latter is bounded once by the immutable root cell. Integrating the
  // derivative norm along the straight parameter-space path from the patch
  // center to any point proves this Euclidean ball radius without evaluating
  // trigonometry at every quadtree node.
  const double half_latitude_span_rad = inflate_proof_upper_bound(
    0.5 * std::fabs(max_latitude_deg - min_latitude_deg) /
      kRadiansToDegrees);
  const double half_longitude_span_rad = inflate_proof_upper_bound(
    0.5 * std::fabs(max_longitude_deg - min_longitude_deg) /
      kRadiansToDegrees);
  const double maximum_meridional_derivative_m =
    inflate_proof_upper_bound(kWgs84A2 / kWgs84B);
  const double meridional_distance_m = inflate_proof_upper_bound(
    maximum_meridional_derivative_m * half_latitude_span_rad);
  const double parallel_distance_m = inflate_proof_upper_bound(
    maximum_parallel_derivative_m * half_longitude_span_rad);
  return inflate_proof_upper_bound(std::hypot(
    meridional_distance_m,
    parallel_distance_m));
}

struct SolidConicSpatialSearch {
  const GridCellGeometry& cell;
  const SensorConfig& sensor;
  const ResolvedVisibilityState& resolved;
  double preferredLatitudeDeg = 0.0;
  double preferredLongitudeDeg = 0.0;
  double preferredForward = -1.0;
  bool hasPreferred = false;
  Vec3 acceptedPosition;
  bool hasAccepted = false;
};

bool evaluate_solid_conic_spatial_candidate(
    SolidConicSpatialSearch& search,
    double latitude_deg,
    double longitude_deg) {
  const Vec3 surface_position = geodetic_to_ecef({
    longitude_deg / kRadiansToDegrees,
    latitude_deg / kRadiansToDegrees,
    0.0,
  });
  const Vec3 sensor_to_surface = subtract(
    surface_position,
    search.resolved.state.position);
  const double range_m = magnitude(sensor_to_surface);
  if (!(range_m > 0.0) || !std::isfinite(range_m)) {
    return false;
  }
  const double forward = dot(
    scale(sensor_to_surface, 1.0 / range_m),
    search.resolved.frame.boresight);
  if (!search.hasPreferred || forward > search.preferredForward) {
    search.preferredLatitudeDeg = latitude_deg;
    search.preferredLongitudeDeg = longitude_deg;
    search.preferredForward = forward;
    search.hasPreferred = true;
  }
  constexpr double kShapeBoundaryEpsilonRad = 1.0e-12;
  if (
    search.sensor.shapeContract.outerHalfAngleRad <
      3.14159265358979323846 - kShapeBoundaryEpsilonRad &&
    forward < std::cos(
      search.sensor.shapeContract.outerHalfAngleRad +
        kShapeBoundaryEpsilonRad)
  ) {
    // Exact horizon/range/normal work cannot turn an angle-disjoint point into
    // a conic witness. Keep its score for search ordering, then stop cheaply.
    return false;
  }
  // This is the only positive predicate in the continuum search. It applies
  // the exact WGS84 horizon, Euclidean range, and shape tests. The shape model
  // documents a 1e-12-radian inclusive boundary epsilon; no cap or patch
  // inflation is promoted to access.
  const bool visible = surface_sample_visible_from_resolved_state(
    surface_position,
    geodetic_surface_normal(surface_position),
    search.sensor,
    search.resolved);
  if (visible) {
    search.acceptedPosition = surface_position;
    search.hasAccepted = true;
  }
  return visible;
}

bool optimize_solid_conic_rectangle_witness(
    SolidConicSpatialSearch& search,
    bool stop_at_first_visible = true) {
  constexpr int kSeedDivisions = 4;

  // The cone axis hit, clamped to the rectangle, is the exact closest-point
  // candidate for a nadir circular footprint and a strong starting point for
  // an off-nadir WGS84 footprint. It is still only accepted by the exact point
  // predicate above.
  Vec3 boresight_ground_point;
  const bool evaluated_boresight_candidate = intersect_earth(
        search.resolved.state.position,
        search.resolved.frame.boresight,
        1.0e100,
        boresight_ground_point);
  if (evaluated_boresight_candidate) {
    const Vertex ground = to_cartographic(boresight_ground_point);
    const double longitude_reference_deg = 0.5 * (
      search.cell.minLongitudeDeg + search.cell.maxLongitudeDeg);
    double longitude_deg = ground.longitudeDeg;
    while (longitude_deg - longitude_reference_deg > 180.0) {
      longitude_deg -= 360.0;
    }
    while (longitude_deg - longitude_reference_deg < -180.0) {
      longitude_deg += 360.0;
    }
    if (evaluate_solid_conic_spatial_candidate(
          search,
          clamp(
            ground.latitudeDeg,
            search.cell.minLatitudeDeg,
            search.cell.maxLatitudeDeg),
          clamp(
            longitude_deg,
            search.cell.minLongitudeDeg,
            search.cell.maxLongitudeDeg)) &&
        stop_at_first_visible) {
      return true;
    }
  }

  // Nadir fast-reject (reject-only performance heuristic; never an access
  // authority). When the boresight axis pierces WGS84 essentially straight
  // down, the clamped-axis candidate evaluated above is the exact
  // closest-point candidate for the circular footprint; if it missed the
  // rectangle, the generic seed grid and its hill-climb add no positive
  // authority and would repeat dozens of ECEF evaluations for every
  // neighboring cap-overlap cell. The only first-visible caller
  // (solid_conic_cell_has_exact_spatial_witness) always follows a false
  // optimizer result with the exact search_solid_conic_surface_patch
  // subdivision, so any real witness is still recovered and the visibility
  // decision is byte-identical. The maximum-clearance mode
  // (stop_at_first_visible == false) keeps the full search.
  if (stop_at_first_visible && evaluated_boresight_candidate) {
    const Vec3 observer_unit = normalize(search.resolved.state.position);
    const double nadir_alignment = dot(
      search.resolved.frame.boresight,
      scale(observer_unit, -1.0));
    if (nadir_alignment > 1.0 - 1.0e-13) {
      return false;
    }
  }

  for (int latitude_index = 0;
       latitude_index <= kSeedDivisions;
       ++latitude_index) {
    const double latitude_deg = search.cell.minLatitudeDeg +
      (search.cell.maxLatitudeDeg - search.cell.minLatitudeDeg) *
        static_cast<double>(latitude_index) / kSeedDivisions;
    for (int longitude_index = 0;
         longitude_index <= kSeedDivisions;
         ++longitude_index) {
      const double longitude_deg = search.cell.minLongitudeDeg +
        (search.cell.maxLongitudeDeg - search.cell.minLongitudeDeg) *
          static_cast<double>(longitude_index) / kSeedDivisions;
      if (evaluate_solid_conic_spatial_candidate(
            search,
            latitude_deg,
            longitude_deg) &&
          stop_at_first_visible) {
        return true;
      }
    }
  }

  if (!search.hasPreferred) {
    return false;
  }
  double latitude_step_deg =
    (search.cell.maxLatitudeDeg - search.cell.minLatitudeDeg) /
      kSeedDivisions;
  double longitude_step_deg =
    (search.cell.maxLongitudeDeg - search.cell.minLongitudeDeg) /
      kSeedDivisions;
  constexpr double kCoordinateClosureDeg = 1.0e-7;
  constexpr int kMaximumIterations = 72;
  constexpr int kDirections[8][2] = {
    {1, 0}, {-1, 0}, {0, 1}, {0, -1},
    {1, 1}, {1, -1}, {-1, 1}, {-1, -1},
  };
  for (int iteration = 0;
       iteration < kMaximumIterations &&
         (latitude_step_deg > kCoordinateClosureDeg ||
          longitude_step_deg > kCoordinateClosureDeg);
       ++iteration) {
    const double prior_forward = search.preferredForward;
    for (const auto& direction : kDirections) {
      const double latitude_deg = clamp(
        search.preferredLatitudeDeg +
          direction[1] * latitude_step_deg,
        search.cell.minLatitudeDeg,
        search.cell.maxLatitudeDeg);
      const double longitude_deg = clamp(
        search.preferredLongitudeDeg +
          direction[0] * longitude_step_deg,
        search.cell.minLongitudeDeg,
        search.cell.maxLongitudeDeg);
      if (evaluate_solid_conic_spatial_candidate(
            search,
            latitude_deg,
            longitude_deg) &&
          stop_at_first_visible) {
        return true;
      }
    }
    if (!(search.preferredForward > prior_forward)) {
      latitude_step_deg *= 0.5;
      longitude_step_deg *= 0.5;
    }
  }
  if (!stop_at_first_visible && search.hasPreferred) {
    return evaluate_solid_conic_spatial_candidate(
      search,
      search.preferredLatitudeDeg,
      search.preferredLongitudeDeg);
  }
  return false;
}

void interval_proof_surface_patch_geometry(
    const GridCellGeometry& cell,
    uint32_t patch_key,
    int patch_depth,
    double min_latitude_deg,
    double max_latitude_deg,
    double min_longitude_deg,
    double max_longitude_deg,
    Vec3& center_position,
    double& patch_radius_m);

bool solid_conic_patch_may_contain_witness(
    SolidConicSpatialSearch& search,
    uint32_t patch_key,
    int patch_depth,
    double min_latitude_deg,
    double max_latitude_deg,
    double min_longitude_deg,
    double max_longitude_deg) {
  const double observer_distance_m = magnitude(
    search.resolved.state.position);
  if (!(observer_distance_m > kWgs84A)) {
    return true;
  }
  const Vec3 observer_unit = scale(
    search.resolved.state.position,
    1.0 / observer_distance_m);
  Vec3 center_position;
  double patch_radius_m = 0.0;
  interval_proof_surface_patch_geometry(
    search.cell,
    patch_key,
    patch_depth,
    min_latitude_deg,
    max_latitude_deg,
    min_longitude_deg,
    max_longitude_deg,
    center_position,
    patch_radius_m);
  const Vec3 center_look = subtract(
    center_position,
    search.resolved.state.position);
  const double center_range_m = magnitude(center_look);
  if (
    !std::isfinite(patch_radius_m) ||
    !std::isfinite(center_range_m)
  ) {
    return true;
  }
  constexpr double kShapeRangeBoundaryEpsilonM = 1.0e-12;
  const double minimum_patch_range_m = deflate_proof_lower_bound(std::max(
    0.0,
    center_range_m - patch_radius_m));
  const double maximum_patch_range_m = inflate_proof_upper_bound(
    center_range_m + patch_radius_m);
  if (
    (search.sensor.shapeContract.minRangeM > 0.0 &&
      maximum_patch_range_m + kShapeRangeBoundaryEpsilonM <
        search.sensor.shapeContract.minRangeM) ||
    (search.sensor.shapeContract.maxRangeM > 0.0 &&
      minimum_patch_range_m - kShapeRangeBoundaryEpsilonM >
        search.sensor.shapeContract.maxRangeM)
  ) {
    return false;
  }
  // Angle disjointness is the common fast rejection. Test the
  // actual-boresight ECEF patch ball before the more expensive ellipsoid
  // horizon and radial-shell bounds; it is independent of both and remains
  // rejection-only.
  if (center_range_m > patch_radius_m) {
    const double center_forward_upper = inflate_proof_upper_bound(dot(
      scale(center_look, 1.0 / center_range_m),
      search.resolved.frame.boresight));
    if (search.sensor.shapeContract.outerHalfAngleRad <
        0.5 * 3.14159265358979323846) {
      const double patch_sine_upper = std::min(
        1.0,
        inflate_proof_upper_bound(
          patch_radius_m / center_range_m));
      const double patch_cosine_lower = deflate_proof_lower_bound(std::sqrt(
        std::max(
          0.0,
          deflate_proof_lower_bound(
            1.0 - patch_sine_upper * patch_sine_upper))));
      // cos(halfAngle + patchAngle) is a lower bound when the cached cone
      // cosine is rounded down, its sine and the patch sine are rounded up,
      // and the patch cosine is rounded down. The additive guard dominates
      // the former two-radian boundary guards after conversion to cosine.
      const double required_center_forward_lower =
        deflate_proof_lower_bound(
          search.sensor.outerHalfAngleCosLower * patch_cosine_lower -
          search.sensor.outerHalfAngleSinUpper * patch_sine_upper -
          4.0e-12);
      if (center_forward_upper < required_center_forward_lower) {
        return false;
      }
    } else {
      const double center_angle_rad = std::acos(clamp(
        center_forward_upper,
        -1.0,
        1.0));
      const double patch_angle_rad = std::asin(clamp(
        patch_radius_m / center_range_m,
        0.0,
        1.0));
      constexpr double kRejectionRoundingGuardRad = 1.0e-12;
      if (std::max(
            0.0,
            center_angle_rad - patch_angle_rad -
              kRejectionRoundingGuardRad) >
          search.sensor.shapeContract.outerHalfAngleRad +
            kRejectionRoundingGuardRad) {
        return false;
      }
    }
  }
  // Near nadir, candidate enumeration has already confined the search to the
  // outer ground cap and the actual-boresight ECEF ball above is the sharp
  // conic test. The ellipsoid horizon/radial-shell relaxations below are much
  // looser at fine patch depths; skipping them only retains extra candidates
  // and cannot reject a real witness.
  constexpr double kNearNadirPatchAngleOnlyRad =
    0.5 / kRadiansToDegrees;
  if (dot(
        search.resolved.frame.boresight,
        scale(observer_unit, -1.0)) >=
      std::cos(kNearNadirPatchAngleOnlyRad)) {
    return true;
  }
  // Bound the exact ellipsoid horizon predicate H(P)=dot(S-P,N(P)).
  // Every patch point is within patch_radius_m of the center, while WGS84's
  // geodetic normal follows the unit lat/lon sphere. The meridian-plus-
  // parallel path bounds the normal chord throughout the closed rectangle.
  const double normal_path_bound_rad = inflate_proof_upper_bound(
    0.5 * (
      std::fabs(max_latitude_deg - min_latitude_deg) +
      std::fabs(max_longitude_deg - min_longitude_deg)) /
        kRadiansToDegrees);
  const double normal_chord_bound = inflate_proof_upper_bound(
    normal_path_bound_rad >= 3.14159265358979323846
    ? 2.0
    : 2.0 * std::sin(0.5 * normal_path_bound_rad));
  const Vec3 center_normal = geodetic_surface_normal(center_position);
  const double center_horizon_score = dot(
    subtract(search.resolved.state.position, center_position),
    center_normal);
  const double horizon_score_error = inflate_proof_upper_bound(
    patch_radius_m +
      center_range_m * normal_chord_bound +
      patch_radius_m * normal_chord_bound);
  const double horizon_score_upper = inflate_proof_upper_bound(
    center_horizon_score + horizon_score_error);
  if (!(horizon_score_upper > 0.0)) {
    return false;
  }
  const double boresight_chord = inflate_proof_upper_bound(magnitude(subtract(
    search.resolved.frame.boresight,
    scale(observer_unit, -1.0))));
  constexpr double kNearNadirRadialBoundLimitRad =
    0.5 / kRadiansToDegrees;
  const double near_nadir_radial_bound_limit_chord =
    2.0 * std::sin(0.5 * kNearNadirRadialBoundLimitRad);
  if (boresight_chord > near_nadir_radial_bound_limit_chord) {
    // The radial-shell relaxation intentionally pays the complete off-nadir
    // chord and becomes too loose for stronger tilts. The actual-boresight
    // rejection above remains authoritative in that regime.
    return true;
  }
  const double min_geocentric_latitude_deg =
    geocentric_latitude_at_geodetic_latitude(min_latitude_deg) *
      kRadiansToDegrees;
  const double max_geocentric_latitude_deg =
    geocentric_latitude_at_geodetic_latitude(max_latitude_deg) *
      kRadiansToDegrees;
  const double nearest_distance_deg =
    sdn::coverage::minimumAngularDistanceToRectangleDeg(
      direction_lon_lat(observer_unit),
      min_geocentric_latitude_deg,
      max_geocentric_latitude_deg,
      min_longitude_deg,
      max_longitude_deg);
  const double antipodal_distance_deg =
    sdn::coverage::minimumAngularDistanceToRectangleDeg(
      direction_lon_lat(scale(observer_unit, -1.0)),
      min_geocentric_latitude_deg,
      max_geocentric_latitude_deg,
      min_longitude_deg,
      max_longitude_deg);
  if (
    !std::isfinite(nearest_distance_deg) ||
    !std::isfinite(antipodal_distance_deg)
  ) {
    return true;
  }
  const double c_max = clamp(inflate_proof_upper_bound(std::cos(
    nearest_distance_deg / kRadiansToDegrees)), -1.0, 1.0);
  const double horizon_angle_rad = std::min(
    3.14159265358979323846,
    std::acos(clamp(
      kWgs84B / observer_distance_m,
      0.0,
      1.0)) +
      kMaximumGeodeticGeocentricLatitudeSeparationDeg /
        kRadiansToDegrees);
  const double c_min = std::max(
    clamp(deflate_proof_lower_bound(-std::cos(
      antipodal_distance_deg / kRadiansToDegrees)), -1.0, 1.0),
    deflate_proof_lower_bound(std::cos(horizon_angle_rad)));
  if (c_min > c_max) {
    return false;
  }
  const double minimum_radius_m = std::max(
    kWgs84B,
    deflate_proof_lower_bound(std::min(
      radial_magnitude_at_geodetic_latitude(min_latitude_deg),
      radial_magnitude_at_geodetic_latitude(max_latitude_deg))));
  auto radial_forward = [&](double direction_cosine) {
    const double range_m = std::sqrt(std::max(
      0.0,
      observer_distance_m * observer_distance_m +
        minimum_radius_m * minimum_radius_m -
        2.0 * observer_distance_m * minimum_radius_m *
          direction_cosine));
    return range_m > 0.0
      ? clamp(
        (observer_distance_m - minimum_radius_m * direction_cosine) /
          range_m,
        -1.0,
        1.0)
      : 1.0;
  };
  const double radial_forward_upper = std::max(
    radial_forward(c_min),
    radial_forward(c_max));
  const double forward_upper = inflate_proof_upper_bound(
    radial_forward_upper + boresight_chord);
  constexpr double kShapeBoundaryEpsilonRad = 1.0e-12;
  const double required_forward = deflate_proof_lower_bound(std::cos(std::min(
    3.14159265358979323846,
    search.sensor.shapeContract.outerHalfAngleRad +
      kShapeBoundaryEpsilonRad)));
  return forward_upper >= required_forward;
}

bool search_solid_conic_surface_patch(
    SolidConicSpatialSearch& search,
    double min_latitude_deg,
    double max_latitude_deg,
    double min_longitude_deg,
    double max_longitude_deg,
    uint32_t patch_key,
    int depth) {
  const double mid_latitude_deg = 0.5 * (
    min_latitude_deg + max_latitude_deg);
  const double mid_longitude_deg = 0.5 * (
    min_longitude_deg + max_longitude_deg);
  // Sound region-patch cull for a ground POINT target: if the closest point of
  // this patch rectangle to the sphere sub-point is farther than the sphere
  // radius, the whole patch is outside the region and holds no witness — prune.
  // Distances use a scaled-planar chord (a lower bound on the true angular
  // distance) so a patch that could touch the sphere is never dropped.
  if (t_target_region_gate != nullptr && t_target_is_point) {
    const double clamped_lat = clamp(
      t_target_point_lat_deg, min_latitude_deg, max_latitude_deg);
    double point_lon = t_target_point_lon_deg;
    const double lon_ref = 0.5 * (min_longitude_deg + max_longitude_deg);
    while (point_lon - lon_ref > 180.0) point_lon -= 360.0;
    while (point_lon - lon_ref < -180.0) point_lon += 360.0;
    const double clamped_lon = clamp(
      point_lon, min_longitude_deg, max_longitude_deg);
    const double d_lat = t_target_point_lat_deg - clamped_lat;
    const double d_lon = (point_lon - clamped_lon) *
      std::cos(t_target_point_lat_deg / kRadiansToDegrees);
    const double planar_distance_deg = std::hypot(d_lat, d_lon);
    if (planar_distance_deg - 0.02 > t_target_point_radius_deg) {
      return false;
    }
  }
  if (!solid_conic_patch_may_contain_witness(
        search,
        patch_key,
        depth,
        min_latitude_deg,
        max_latitude_deg,
        min_longitude_deg,
        max_longitude_deg)) {
    return false;
  }
  if (evaluate_solid_conic_spatial_candidate(
        search,
        mid_latitude_deg,
        mid_longitude_deg)) {
    return true;
  }

  // Search depth can place candidates, but it grants no access authority:
  // every positive result must come from the exact point predicate above.
  // Sixteen bisections put an eight-degree cell below 15 metres. Exact
  // optimizer candidates handle boundary/tangency witnesses; capping the
  // fallback prevents an unresolved horizon edge from creating an unbounded
  // quadtree denial of service.
  // Targets (region gate active) use a shallower cap: their region∩footprint
  // overlap can sit OFF the footprint centre, so the optimizer's centre-seeking
  // candidates miss it and this fallback would otherwise subdivide the whole
  // footprint disc. A cap of 12 keeps a large target bounding rectangle at a
  // few-hundred-metre leaf (finer than the target's own extent) — ample for
  // area/point targets — while bounding the search. Cells keep depth 16.
  //
  // CONTRACT (guardian-pinned): the target witness-subdivision worst-case
  // resolution is  rect_max_degrees / 2^12  =  rect_max_degrees / 4096  (the
  // widest side of the target's own bounding rectangle divided by 4096). It is
  // RELATIVE to the target extent, so arbitrarily small targets are still
  // resolved: a sub-metre target has a sub-metre bounding rectangle and hence a
  // sub-millimetre leaf. Direct-under-track hits are found by the exact optimizer
  // candidate (the boresight ground point), independent of this cap. The
  // depth-12 pin in tests/target_hits.test.mjs guards this (<=1 m point AND
  // <=1 m polygon under-track must register access).
  constexpr int kSpatialSearchMaximumDepth = 16;
  constexpr int kTargetSpatialSearchMaximumDepth = 12;
  const int spatial_search_max_depth = t_target_region_gate != nullptr
    ? kTargetSpatialSearchMaximumDepth
    : kSpatialSearchMaximumDepth;
  if (depth >= spatial_search_max_depth) {
    return false;
  }

  const int preferred_child = search.hasPreferred
    ? (search.preferredLatitudeDeg >= mid_latitude_deg ? 2 : 0) +
      (search.preferredLongitudeDeg >= mid_longitude_deg ? 1 : 0)
    : 0;
  const int child_order[4] = {
    preferred_child,
    preferred_child ^ 1,
    preferred_child ^ 2,
    preferred_child ^ 3,
  };
  for (const int child : child_order) {
    const bool north = child >= 2;
    const bool east = (child & 1) != 0;
    if (search_solid_conic_surface_patch(
          search,
          north ? mid_latitude_deg : min_latitude_deg,
          north ? max_latitude_deg : mid_latitude_deg,
          east ? mid_longitude_deg : min_longitude_deg,
          east ? max_longitude_deg : mid_longitude_deg,
          patch_key * 4u + static_cast<uint32_t>(child),
          depth + 1)) {
      return true;
    }
  }
  return false;
}

void interval_proof_surface_patch_geometry(
    const GridCellGeometry& cell,
    uint32_t patch_key,
    int patch_depth,
    double min_latitude_deg,
    double max_latitude_deg,
    double min_longitude_deg,
    double max_longitude_deg,
    Vec3& center_position,
    double& patch_radius_m) {
  constexpr int kCachedMaximumDepth = 4;
  constexpr uint32_t kQuadtreePowers[] = {
    1u, 4u, 16u, 64u, 256u,
  };
  constexpr size_t kCacheSize = (1024u - 1u) / 3u;
  if (patch_depth <= kCachedMaximumDepth) {
    if (cell.surfacePatchCache.size() < kCacheSize) {
      cell.surfacePatchCache.resize(kCacheSize);
    }
    const uint32_t level_power = kQuadtreePowers[patch_depth];
    const size_t patch_index =
      static_cast<size_t>((level_power - 1u) / 3u) +
      static_cast<size_t>(patch_key - level_power);
    SurfacePatchGeometry& cached = cell.surfacePatchCache[patch_index];
    if (!(cached.radiusM >= 0.0f)) {
      const Vec3 exact_center = geodetic_to_ecef({
        0.5 * (min_longitude_deg + max_longitude_deg) /
          kRadiansToDegrees,
        0.5 * (min_latitude_deg + max_latitude_deg) /
          kRadiansToDegrees,
        0.0,
      });
      cached.centerX = static_cast<float>(exact_center.x);
      cached.centerY = static_cast<float>(exact_center.y);
      cached.centerZ = static_cast<float>(exact_center.z);
      const Vec3 stored_center{
        static_cast<double>(cached.centerX),
        static_cast<double>(cached.centerY),
        static_cast<double>(cached.centerZ),
      };
      const double required_radius_m = inflate_proof_upper_bound(
        conservative_surface_patch_radius_m(
          min_latitude_deg,
          max_latitude_deg,
          min_longitude_deg,
          max_longitude_deg,
          cell.maximumParallelDerivativeM) +
        magnitude(subtract(exact_center, stored_center)));
      cached.radiusM = static_cast<float>(required_radius_m);
      if (static_cast<double>(cached.radiusM) < required_radius_m) {
        cached.radiusM = std::nextafterf(
          cached.radiusM,
          std::numeric_limits<float>::infinity());
      }
    }
    center_position = {
      static_cast<double>(cached.centerX),
      static_cast<double>(cached.centerY),
      static_cast<double>(cached.centerZ),
    };
    patch_radius_m = static_cast<double>(cached.radiusM);
    return;
  }
  center_position = geodetic_to_ecef({
    0.5 * (min_longitude_deg + max_longitude_deg) / kRadiansToDegrees,
    0.5 * (min_latitude_deg + max_latitude_deg) / kRadiansToDegrees,
    0.0,
  });
  patch_radius_m = conservative_surface_patch_radius_m(
    min_latitude_deg,
    max_latitude_deg,
    min_longitude_deg,
    max_longitude_deg,
    cell.maximumParallelDerivativeM);
}

bool solid_conic_interval_surface_patch_proven_angle_disjoint(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& interpolation_start,
    const ResolvedVisibilityState& interpolation_stop,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop,
    const IntervalShapeProofContext& context,
    uint32_t patch_key,
    double min_latitude_deg,
    double max_latitude_deg,
    double min_longitude_deg,
    double max_longitude_deg,
    int depth) {
  Vec3 surface_center;
  double surface_error_m = 0.0;
  interval_proof_surface_patch_geometry(
    cell,
    patch_key,
    depth,
    min_latitude_deg,
    max_latitude_deg,
    min_longitude_deg,
    max_longitude_deg,
    surface_center,
    surface_error_m);
  const Vec3 start_look = subtract(
    surface_center,
    start.state.position);
  const Vec3 stop_look = subtract(
    surface_center,
    stop.state.position);
  UnitDirectionEnvelope look = normalized_arc_envelope(
    start_look,
    stop_look);
  const Vec3 observer_displacement = subtract(
    stop.state.position,
    start.state.position);
  const double displacement_squared = dot(
    observer_displacement,
    observer_displacement);
  const double minimum_fraction = displacement_squared > 0.0
    ? clamp(
      dot(start_look, observer_displacement) /
        displacement_squared,
      0.0,
      1.0)
    : 0.0;
  const double center_minimum_range_m = deflate_proof_lower_bound(magnitude(
    subtract(
      start_look,
      scale(observer_displacement, minimum_fraction))));
  if (
    look.valid &&
    context.boresight.valid &&
    center_minimum_range_m > surface_error_m
  ) {
    const double spatial_angle_error_rad = inflate_proof_upper_bound(
      std::asin(clamp(
        surface_error_m / center_minimum_range_m,
        0.0,
        1.0)));
    look.chordError = inflate_proof_upper_bound(
      look.chordError +
        2.0 * std::sin(0.5 * spatial_angle_error_rad));
    const double center_angle_rad = std::acos(clamp(
      dot(look.center, context.boresight.center),
      -1.0,
      1.0));
    const double look_error_rad = inflate_proof_upper_bound(
      2.0 * std::asin(clamp(0.5 * look.chordError, 0.0, 1.0)));
    const double boresight_error_rad = inflate_proof_upper_bound(
      2.0 * std::asin(clamp(
        0.5 * context.boresight.chordError,
        0.0,
        1.0)));
    const double minimum_angle_rad = deflate_proof_lower_bound(std::max(
      0.0,
      center_angle_rad - look_error_rad - boresight_error_rad));
    if (minimum_angle_rad >
        sensor.shapeContract.outerHalfAngleRad + 1.0e-12) {
      return true;
    }
  }

  // This search can only certify rejection. At the depth cap an unresolved
  // patch remains a candidate and the established temporal refinement path
  // decides it; no access is dropped by search resolution.
  constexpr int kIntervalSpatialProofMaximumDepth = 12;
  if (depth >= kIntervalSpatialProofMaximumDepth) {
    return false;
  }
  const double mid_latitude_deg = 0.5 * (
    min_latitude_deg + max_latitude_deg);
  const double mid_longitude_deg = 0.5 * (
    min_longitude_deg + max_longitude_deg);
  for (uint32_t child = 0; child < 4u; ++child) {
    const bool north = child >= 2u;
    const bool east = (child & 1u) != 0u;
    if (!solid_conic_interval_surface_patch_proven_angle_disjoint(
          cell,
          sensor,
          interpolation_start,
          interpolation_stop,
          start,
          stop,
          context,
          patch_key * 4u + child,
          north ? mid_latitude_deg : min_latitude_deg,
          north ? max_latitude_deg : mid_latitude_deg,
          east ? mid_longitude_deg : min_longitude_deg,
          east ? max_longitude_deg : mid_longitude_deg,
          depth + 1)) {
      return false;
    }
  }
  return true;
}

bool solid_conic_cell_has_exact_spatial_witness(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& resolved,
    Vec3* witness_position) {
  SolidConicSpatialSearch search{cell, sensor, resolved};
  const bool found = optimize_solid_conic_rectangle_witness(search) ||
    search_solid_conic_surface_patch(
      search,
      cell.minLatitudeDeg,
      cell.maxLatitudeDeg,
      cell.minLongitudeDeg,
      cell.maxLongitudeDeg,
      1u,
      0);
  if (found && witness_position && search.hasAccepted) {
    *witness_position = search.acceptedPosition;
  }
  return found;
}

LocalLookEnvelope surface_patch_local_look_envelope(
    const GridCellGeometry& cell,
    uint32_t patch_key,
    int patch_depth,
    double min_latitude_deg,
    double max_latitude_deg,
    double min_longitude_deg,
    double max_longitude_deg,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop,
    const UnitDirectionEnvelope& boresight,
    const UnitDirectionEnvelope& x_axis,
    const UnitDirectionEnvelope& y_axis) {
  if (patch_depth < 0) {
    return {};
  }
  Vec3 center_position;
  double patch_radius_m = 0.0;
  interval_proof_surface_patch_geometry(
    cell,
    patch_key,
    patch_depth,
    min_latitude_deg,
    max_latitude_deg,
    min_longitude_deg,
    max_longitude_deg,
    center_position,
    patch_radius_m);
  const Vec3 start_look_vector = subtract(
    center_position,
    start.state.position);
  const Vec3 stop_look_vector = subtract(
    center_position,
    stop.state.position);
  const UnitDirectionEnvelope center_look = normalized_arc_envelope(
    start_look_vector,
    stop_look_vector);
  if (!center_look.valid) {
    return {};
  }

  const Vec3 observer_displacement = subtract(
    stop.state.position,
    start.state.position);
  const double displacement_squared = dot(
    observer_displacement,
    observer_displacement);
  const double minimum_fraction = displacement_squared > 0.0
    ? clamp(
      dot(start_look_vector, observer_displacement) /
        displacement_squared,
      0.0,
      1.0)
    : 0.0;
  const double center_minimum_range_m = deflate_proof_lower_bound(magnitude(
    subtract(
      start_look_vector,
      scale(observer_displacement, minimum_fraction))));
  if (!(center_minimum_range_m > patch_radius_m)) {
    return {};
  }
  const double spatial_angular_error_rad = std::asin(clamp(
    patch_radius_m / center_minimum_range_m,
    0.0,
    1.0));
  const double spatial_chord_error = inflate_proof_upper_bound(
    2.0 * std::sin(0.5 * spatial_angular_error_rad));
  const double look_error = inflate_proof_upper_bound(
    center_look.chordError + spatial_chord_error);

  LocalLookEnvelope envelope{};
  envelope.xCenter = dot(center_look.center, x_axis.center);
  envelope.yCenter = dot(center_look.center, y_axis.center);
  envelope.zCenter = dot(center_look.center, boresight.center);
  envelope.xError = inflate_proof_upper_bound(
    look_error + x_axis.chordError);
  envelope.yError = inflate_proof_upper_bound(
    look_error + y_axis.chordError);
  envelope.zError = inflate_proof_upper_bound(
    look_error + boresight.chordError);
  // Projection of one 3-D look perturbation onto the orthonormal transverse
  // plane has norm no greater than the original chord error. Treating that
  // same perturbation independently in X and Y would introduce an unnecessary
  // sqrt(2) inflation in the SAR clock-sector proof.
  envelope.transverseError = inflate_proof_upper_bound(
    look_error + std::hypot(
      x_axis.chordError,
      y_axis.chordError));
  envelope.minimumRangeM = deflate_proof_lower_bound(
    center_minimum_range_m - patch_radius_m);
  envelope.maximumRangeM = inflate_proof_upper_bound(
    std::max(
      magnitude(start_look_vector),
      magnitude(stop_look_vector)) +
    patch_radius_m);
  envelope.valid = true;
  return envelope;
}

double minimum_absolute_interval_value(double lower, double upper) {
  if (lower <= 0.0 && upper >= 0.0) {
    return 0.0;
  }
  return std::min(std::fabs(lower), std::fabs(upper));
}

bool local_look_envelope_is_shape_disjoint(
    const LocalLookEnvelope& envelope,
    const SensorConfig& sensor) {
  const SensorShapeContract& shape = sensor.shapeContract;
  if (!envelope.valid) {
    return false;
  }
  if (
    (shape.maxRangeM > 0.0 &&
      envelope.minimumRangeM > shape.maxRangeM + 1.0e-12) ||
    (shape.minRangeM > 0.0 &&
      envelope.maximumRangeM + 1.0e-12 < shape.minRangeM)
  ) {
    return true;
  }

  const double x_lower = std::max(-1.0, envelope.xCenter - envelope.xError);
  const double x_upper = std::min(1.0, envelope.xCenter + envelope.xError);
  const double y_lower = std::max(-1.0, envelope.yCenter - envelope.yError);
  const double y_upper = std::min(1.0, envelope.yCenter + envelope.yError);
  const double z_lower = std::max(-1.0, envelope.zCenter - envelope.zError);
  const double z_upper = std::min(1.0, envelope.zCenter + envelope.zError);
  if (z_upper <= 0.0) {
    return true;
  }

  if (shape.kind == SensorShapeKind::Rectangular) {
    const double maximum_forward = std::max(0.0, z_upper);
    if (
      !sensor.inclusiveCrossTrackAlwaysAccepted &&
      minimum_absolute_interval_value(x_lower, x_upper) >
        sensor.inclusiveCrossTrackTangentUpper * maximum_forward
    ) {
      return true;
    }
    return
      !sensor.inclusiveAlongTrackAlwaysAccepted &&
      minimum_absolute_interval_value(y_lower, y_upper) >
        sensor.inclusiveAlongTrackTangentUpper * maximum_forward;
  }

  if (
    shape.kind != SensorShapeKind::Conic &&
    shape.kind != SensorShapeKind::SarAnnularSector
  ) {
    return false;
  }
  if (
    !sensor.inclusiveOuterBoundaryAlwaysAccepted &&
    z_upper < sensor.inclusiveOuterBoundaryCosLower
  ) {
    return true;
  }
  if (sensor.inclusiveInnerBoundaryImpossible) {
    return true;
  }
  if (
    !sensor.inclusiveInnerBoundaryAlwaysAccepted &&
    z_lower > sensor.inclusiveInnerBoundaryCosUpper
  ) {
    return true;
  }
  if (sensor.clockMembershipAlwaysAccepted) {
    return false;
  }

  const double transverse_center = std::hypot(
    envelope.xCenter,
    envelope.yCenter);
  const double transverse_error = envelope.transverseError;
  if (!(transverse_center > transverse_error)) {
    return false;
  }
  // The transverse error ball rotates its center direction by at most
  // asin(error/radius). Compare cos(center distance) against a one-sided
  // bound for cos(halfSpan + error), using the request's inclusive clock
  // epsilon already folded into the cached half span.
  const double error_sine_upper = inflate_proof_upper_bound(clamp(
    transverse_error / transverse_center,
    0.0,
    1.0));
  if (
    sensor.clockHalfSpanRad > 0.5 * 3.14159265358979323846 &&
    !(error_sine_upper < sensor.clockBoundarySinLower)
  ) {
    // halfSpan + asin(error) may reach pi, where no clock-disjoint proof is
    // possible.
    return false;
  }
  const double error_cosine = std::sqrt(std::max(
    0.0,
    1.0 - error_sine_upper * error_sine_upper));
  const double error_cosine_bound =
    sensor.clockHalfSpanRad <= 0.5 * 3.14159265358979323846
      ? deflate_proof_lower_bound(error_cosine)
      : inflate_proof_upper_bound(error_cosine);
  const double separation_threshold_lower = deflate_proof_lower_bound(
    sensor.clockBoundaryCosLower * error_cosine_bound -
      sensor.clockBoundarySinUpper * error_sine_upper);
  const double rounding_guard =
    8.0 * std::numeric_limits<double>::epsilon();
  const double center_dot_upper = inflate_proof_upper_bound(
    (envelope.xCenter * sensor.clockCenterCos +
      envelope.yCenter * sensor.clockCenterSin) /
      transverse_center +
    rounding_guard);
  return center_dot_upper < separation_threshold_lower;
}

bool fixed_surface_witness_visible_for_entire_interval(
    Vec3 surface_position,
    Vec3 surface_normal,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop);

int conservative_sar_interval_ground_caps(
    const SensorConfig& sensor,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop,
    const IntervalShapeProofContext& context,
    SweptSensorCap (&ground_caps)[2]) {
  const SensorShapeContract& shape = sensor.shapeContract;
  if (
    !context.valid ||
    shape.kind != SensorShapeKind::SarAnnularSector ||
    shape.clockRange.fullCircle ||
    shape.innerHalfAngleRad < 0.0 ||
    shape.outerHalfAngleRad > 3.14159265358979323846 ||
    shape.outerHalfAngleRad < shape.innerHalfAngleRad
  ) {
    return 0;
  }
  constexpr int kLookPartitions = 2;
  const double look_span_rad =
    shape.outerHalfAngleRad - shape.innerHalfAngleRad;
  const double clock_center_rad = normalize_angle_rad(
    shape.clockRange.startRad + 0.5 * shape.clockRange.spanRad);
  for (int look_index = 0; look_index < kLookPartitions; ++look_index) {
    const double sub_minimum_look_rad =
      shape.innerHalfAngleRad +
      static_cast<double>(look_index) *
        look_span_rad / kLookPartitions;
    const double sub_maximum_look_rad =
      shape.innerHalfAngleRad +
      static_cast<double>(look_index + 1) *
        look_span_rad / kLookPartitions;
    const double look_center_rad = 0.5 * (
      sub_minimum_look_rad + sub_maximum_look_rad);
    const double transverse = std::sin(look_center_rad);
    const SensorVec3 local_center{
      transverse * std::cos(clock_center_rad),
      transverse * std::sin(clock_center_rad),
      std::cos(look_center_rad),
    };
    double maximum_transverse_scale = std::max(
      std::sin(sub_minimum_look_rad),
      std::sin(sub_maximum_look_rad));
    if (
      sub_minimum_look_rad <= 0.5 * 3.14159265358979323846 &&
      sub_maximum_look_rad >= 0.5 * 3.14159265358979323846
    ) {
      maximum_transverse_scale = 1.0;
    }
    const double local_radius_rad =
      0.5 * (sub_maximum_look_rad - sub_minimum_look_rad) +
      0.5 * maximum_transverse_scale * shape.clockRange.spanRad +
      1.0e-12;
    if (!conservative_fixed_local_ray_ground_track_cap(
          sensor,
          local_center,
          local_radius_rad,
          start,
          stop,
          context.sweptCap,
          context.boresight,
          context.xAxis,
          context.yAxis,
          ground_caps[look_index])) {
      return 0;
    }
  }
  return kLookPartitions;
}

bool surface_patch_proven_shape_disjoint(
    double min_latitude_deg,
    double max_latitude_deg,
    double min_longitude_deg,
    double max_longitude_deg,
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& midpoint,
    const ResolvedVisibilityState& stop,
    const SweptSensorCap& interval_cap,
    const UnitDirectionEnvelope& boresight,
    const UnitDirectionEnvelope& x_axis,
    const UnitDirectionEnvelope& y_axis,
    uint32_t patch_key,
    int depth,
    int maximum_depth,
    bool has_preferred_point,
    double preferred_latitude_deg,
    double preferred_longitude_deg,
    bool& visible_witness_proven) {
  const LocalLookEnvelope envelope = surface_patch_local_look_envelope(
    cell,
    patch_key,
    depth,
    min_latitude_deg,
    max_latitude_deg,
    min_longitude_deg,
    max_longitude_deg,
    start,
    stop,
    boresight,
    x_axis,
    y_axis);
  if (local_look_envelope_is_shape_disjoint(
        envelope,
        sensor)) {
    return true;
  }

  if (depth >= maximum_depth) {
    const Vec3 center_position = geodetic_to_ecef({
      0.5 * (min_longitude_deg + max_longitude_deg) / kRadiansToDegrees,
      0.5 * (min_latitude_deg + max_latitude_deg) / kRadiansToDegrees,
      0.0,
    });
    visible_witness_proven = fixed_surface_witness_visible_for_entire_interval(
      center_position,
      geodetic_surface_normal(center_position),
      sensor,
      start,
      stop);
    if (!visible_witness_proven) {
      const Vec3 midpoint_look = subtract(
        center_position,
        midpoint.state.position);
      visible_witness_proven = fixed_local_ray_ground_track_inside_cell(
        cell,
        sensor,
        {
          dot(midpoint_look, midpoint.frame.xAxis),
          dot(midpoint_look, midpoint.frame.yAxis),
          dot(midpoint_look, midpoint.frame.boresight),
        },
        start,
        stop,
        interval_cap,
        boresight,
        x_axis,
        y_axis);
    }
    return false;
  }
  const double mid_latitude_deg =
    0.5 * (min_latitude_deg + max_latitude_deg);
  const double mid_longitude_deg =
    0.5 * (min_longitude_deg + max_longitude_deg);
  bool all_disjoint = true;
  auto visit = [&](uint32_t child_index) {
    if (visible_witness_proven) {
      return;
    }
    const bool north = child_index >= 2u;
    const bool east = (child_index & 1u) != 0u;
    const double child_min_lat = north
      ? mid_latitude_deg
      : min_latitude_deg;
    const double child_max_lat = north
      ? max_latitude_deg
      : mid_latitude_deg;
    const double child_min_lon = east
      ? mid_longitude_deg
      : min_longitude_deg;
    const double child_max_lon = east
      ? max_longitude_deg
      : mid_longitude_deg;
    const uint32_t child_key = patch_key * 4u + child_index;
    all_disjoint = surface_patch_proven_shape_disjoint(
      child_min_lat,
      child_max_lat,
      child_min_lon,
      child_max_lon,
      cell,
      sensor,
      start,
      midpoint,
      stop,
      interval_cap,
      boresight,
      x_axis,
      y_axis,
      child_key,
      depth + 1,
      maximum_depth,
      has_preferred_point,
      preferred_latitude_deg,
      preferred_longitude_deg,
      visible_witness_proven) && all_disjoint;
  };
  if (has_preferred_point) {
    const uint32_t preferred_child =
      (preferred_latitude_deg >= mid_latitude_deg ? 2u : 0u) +
      (preferred_longitude_deg >= mid_longitude_deg ? 1u : 0u);
    visit(preferred_child);
    visit(preferred_child ^ 1u);
    visit(preferred_child ^ 2u);
    visit(preferred_child ^ 3u);
  } else {
    visit(0u);
    visit(1u);
    visit(2u);
    visit(3u);
  }
  return all_disjoint;
}

enum class CellIntervalGeometryProof {
  Unknown,
  Disjoint,
  Visible,
};

CellIntervalGeometryProof sar_region_interval_geometry_proof(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop,
    const SweptSensorCap& interval_cap,
    const UnitDirectionEnvelope& boresight,
    const UnitDirectionEnvelope& x_axis,
    const UnitDirectionEnvelope& y_axis,
    double minimum_look_rad,
    double maximum_look_rad,
    double minimum_clock_offset_rad,
    double maximum_clock_offset_rad,
    int depth) {
  const SensorShapeContract& shape = sensor.shapeContract;
  const double look_center_rad = 0.5 * (
    minimum_look_rad + maximum_look_rad);
  const double clock_offset_center_rad = 0.5 * (
    minimum_clock_offset_rad + maximum_clock_offset_rad);
  const double clock_center_rad = normalize_angle_rad(
    shape.clockRange.startRad + clock_offset_center_rad);
  const double transverse = std::sin(look_center_rad);
  const SensorVec3 local_center{
    transverse * std::cos(clock_center_rad),
    transverse * std::sin(clock_center_rad),
    std::cos(look_center_rad),
  };
  const double local_radius_rad =
    0.5 * (maximum_look_rad - minimum_look_rad) +
    0.5 * (maximum_clock_offset_rad - minimum_clock_offset_rad) +
    1.0e-12;
  SweptSensorCap ground_cap;
  const bool cap_proven = conservative_fixed_local_ray_ground_track_cap(
    sensor,
    local_center,
    local_radius_rad,
    start,
    stop,
    interval_cap,
    boresight,
    x_axis,
    y_axis,
    ground_cap);
  if (cap_proven) {
    if (!sdn::coverage::sphericalCapIntersectsRectangle(
          ground_cap.center,
          ground_cap.angularRadiusDeg,
          cell.minGeocentricLatitudeDeg,
          cell.maxGeocentricLatitudeDeg,
          cell.minLongitudeDeg,
          cell.maxLongitudeDeg)) {
      return CellIntervalGeometryProof::Disjoint;
    }
    if (spherical_cap_inside_cell(ground_cap, cell)) {
      return CellIntervalGeometryProof::Visible;
    }
  }

  constexpr int kSarShapeRegionProofMaxDepth = 6;
  if (depth >= kSarShapeRegionProofMaxDepth) {
    return CellIntervalGeometryProof::Unknown;
  }
  const double look_span_rad = maximum_look_rad - minimum_look_rad;
  const double clock_span_rad =
    maximum_clock_offset_rad - minimum_clock_offset_rad;
  CellIntervalGeometryProof first = CellIntervalGeometryProof::Unknown;
  CellIntervalGeometryProof second = CellIntervalGeometryProof::Unknown;
  if (look_span_rad >= clock_span_rad) {
    const double middle_look_rad = 0.5 * (
      minimum_look_rad + maximum_look_rad);
    first = sar_region_interval_geometry_proof(
      cell,
      sensor,
      start,
      stop,
      interval_cap,
      boresight,
      x_axis,
      y_axis,
      minimum_look_rad,
      middle_look_rad,
      minimum_clock_offset_rad,
      maximum_clock_offset_rad,
      depth + 1);
    if (first == CellIntervalGeometryProof::Visible) {
      return first;
    }
    second = sar_region_interval_geometry_proof(
      cell,
      sensor,
      start,
      stop,
      interval_cap,
      boresight,
      x_axis,
      y_axis,
      middle_look_rad,
      maximum_look_rad,
      minimum_clock_offset_rad,
      maximum_clock_offset_rad,
      depth + 1);
  } else {
    const double middle_clock_offset_rad = 0.5 * (
      minimum_clock_offset_rad + maximum_clock_offset_rad);
    first = sar_region_interval_geometry_proof(
      cell,
      sensor,
      start,
      stop,
      interval_cap,
      boresight,
      x_axis,
      y_axis,
      minimum_look_rad,
      maximum_look_rad,
      minimum_clock_offset_rad,
      middle_clock_offset_rad,
      depth + 1);
    if (first == CellIntervalGeometryProof::Visible) {
      return first;
    }
    second = sar_region_interval_geometry_proof(
      cell,
      sensor,
      start,
      stop,
      interval_cap,
      boresight,
      x_axis,
      y_axis,
      minimum_look_rad,
      maximum_look_rad,
      middle_clock_offset_rad,
      maximum_clock_offset_rad,
      depth + 1);
  }
  if (second == CellIntervalGeometryProof::Visible) {
    return second;
  }
  return
    first == CellIntervalGeometryProof::Disjoint &&
      second == CellIntervalGeometryProof::Disjoint
    ? CellIntervalGeometryProof::Disjoint
    : CellIntervalGeometryProof::Unknown;
}

CellIntervalGeometryProof cell_interval_geometry_proof(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop,
    const IntervalShapeProofContext& context,
    int spatial_maximum_depth) {
  if (!context.valid) {
    return CellIntervalGeometryProof::Unknown;
  }
  const double midpoint_seconds = 0.5 * (
    start.state.elapsedSeconds + stop.state.elapsedSeconds);
  const ResolvedVisibilityState midpoint = resolve_visibility_state(
    interpolate_state(start.state, stop.state, midpoint_seconds));
  bool has_preferred_point = false;
  double preferred_latitude_deg = 0.0;
  double preferred_longitude_deg = 0.0;
  const SensorVec3 preferred_local_direction =
    sensor.representativeLocalDirection;
  has_preferred_point = sensor.hasRepresentativeLocalDirection;
  if (has_preferred_point) {
    Vec3 preferred_surface_position;
    has_preferred_point = intersect_earth(
      midpoint.state.position,
      world_direction_for_local_ray(
        midpoint.frame,
        preferred_local_direction),
      1.0e100,
      preferred_surface_position);
    if (has_preferred_point) {
      const Vertex preferred = to_cartographic(preferred_surface_position);
      preferred_latitude_deg = clamp(
        preferred.latitudeDeg,
        cell.minLatitudeDeg,
        cell.maxLatitudeDeg);
      const double longitude_reference_deg = 0.5 * (
        cell.minLongitudeDeg + cell.maxLongitudeDeg);
      preferred_longitude_deg = preferred.longitudeDeg;
      while (preferred_longitude_deg - longitude_reference_deg > 180.0) {
        preferred_longitude_deg -= 360.0;
      }
      while (preferred_longitude_deg - longitude_reference_deg < -180.0) {
        preferred_longitude_deg += 360.0;
      }
      preferred_longitude_deg = clamp(
        preferred_longitude_deg,
        cell.minLongitudeDeg,
        cell.maxLongitudeDeg);
    }
  }
  bool visible_witness_proven = false;
  const bool disjoint = surface_patch_proven_shape_disjoint(
    cell.minLatitudeDeg,
    cell.maxLatitudeDeg,
    cell.minLongitudeDeg,
    cell.maxLongitudeDeg,
    cell,
    sensor,
    start,
    midpoint,
    stop,
    context.sweptCap,
    context.boresight,
    context.xAxis,
    context.yAxis,
    1u,
    0,
    spatial_maximum_depth,
    has_preferred_point,
    preferred_latitude_deg,
    preferred_longitude_deg,
    visible_witness_proven);
  if (visible_witness_proven) {
    return CellIntervalGeometryProof::Visible;
  }
  return disjoint
    ? CellIntervalGeometryProof::Disjoint
    : CellIntervalGeometryProof::Unknown;
}

bool fixed_surface_witness_visible_for_entire_interval_with_frame_envelopes(
    Vec3 surface_position,
    Vec3 surface_normal,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop,
    const UnitDirectionEnvelope& boresight,
    const UnitDirectionEnvelope& x_axis,
    const UnitDirectionEnvelope& y_axis) {
  // Area/point-target region gate (Gate 2 — whole-interval concrete witness).
  // This is the single sink for every "one immutable ground point stays visible
  // across the interval" proof. Region membership is time-invariant for a fixed
  // ground point, so one check on the witness suffices: outside the region it is
  // not a target witness. Accept-narrowing only; the caller keeps searching.
  if (t_target_region_gate != nullptr &&
      !t_target_region_gate->containsWorldPoint(
        surface_position.x, surface_position.y, surface_position.z)) {
    return false;
  }
  // Horizon is affine for a fixed WGS84 point: dot(S(t)-P,N) > 0.
  const double horizon_start = dot(
    subtract(start.state.position, surface_position),
    surface_normal);
  const double horizon_stop = dot(
    subtract(stop.state.position, surface_position),
    surface_normal);
  if (!(deflate_proof_lower_bound(
        std::min(horizon_start, horizon_stop)) > 0.0)) {
    return false;
  }

  // For affine observer motion, distance to a fixed point is convex: its
  // maximum is at an endpoint and its minimum is the point-to-segment range.
  const Vec3 start_look_vector = subtract(
    surface_position,
    start.state.position);
  const Vec3 stop_look_vector = subtract(
    surface_position,
    stop.state.position);
  const double maximum_range_m = inflate_proof_upper_bound(std::max(
    magnitude(start_look_vector),
    magnitude(stop_look_vector)));
  const Vec3 observer_displacement = subtract(
    stop.state.position,
    start.state.position);
  const double displacement_squared = dot(
    observer_displacement,
    observer_displacement);
  const double minimum_fraction = displacement_squared > 0.0
    ? clamp(
      dot(start_look_vector, observer_displacement) /
        displacement_squared,
      0.0,
      1.0)
    : 0.0;
  const double minimum_range_m = deflate_proof_lower_bound(magnitude(subtract(
    start_look_vector,
    scale(observer_displacement, minimum_fraction))));
  if (
    (sensor.shapeContract.minRangeM > 0.0 &&
      minimum_range_m < sensor.shapeContract.minRangeM) ||
    (sensor.shapeContract.maxRangeM > 0.0 &&
      maximum_range_m > sensor.shapeContract.maxRangeM)
  ) {
    return false;
  }

  const UnitDirectionEnvelope look = normalized_arc_envelope(
    start_look_vector,
    stop_look_vector);
  if (!look.valid) {
    return false;
  }

  const double x_center = dot(look.center, x_axis.center);
  const double y_center = dot(look.center, y_axis.center);
  const double z_center = dot(look.center, boresight.center);
  const double x_error = inflate_proof_upper_bound(
    look.chordError + x_axis.chordError);
  const double y_error = inflate_proof_upper_bound(
    look.chordError + y_axis.chordError);
  const double z_error = inflate_proof_upper_bound(
    look.chordError + boresight.chordError);
  const double x_lower = std::max(-1.0, x_center - x_error);
  const double x_upper = std::min(1.0, x_center + x_error);
  const double y_lower = std::max(-1.0, y_center - y_error);
  const double y_upper = std::min(1.0, y_center + y_error);
  const double z_lower = std::max(-1.0, z_center - z_error);
  const double z_upper = std::min(1.0, z_center + z_error);
  const SensorShapeContract& shape = sensor.shapeContract;
  if (
    shape.kind == SensorShapeKind::Conic &&
    shape.innerHalfAngleRad <= 1.0e-14 &&
    shape.clockRange.fullCircle
  ) {
    // Near the cone axis, subtracting a first-order chord error from z is far
    // too loose because cosine clearance is second order. Bound the actual
    // angular separation instead with the spherical triangle inequality.
    const double center_angle_rad = inflate_proof_upper_bound(std::acos(clamp(
      z_center,
      -1.0,
      1.0)));
    const double look_angle_error_rad = inflate_proof_upper_bound(
      2.0 * std::asin(clamp(0.5 * look.chordError, 0.0, 1.0)));
    const double boresight_angle_error_rad = inflate_proof_upper_bound(
      2.0 * std::asin(clamp(0.5 * boresight.chordError, 0.0, 1.0)));
    const double maximum_angle_rad = inflate_proof_upper_bound(
      center_angle_rad + look_angle_error_rad +
        boresight_angle_error_rad);
    constexpr double kShapeBoundaryEpsilonRad = 1.0e-12;
    return
      maximum_angle_rad < 0.5 * 3.14159265358979323846 &&
      (shape.outerHalfAngleRad >= 3.14159265358979323846 ||
        maximum_angle_rad <=
          shape.outerHalfAngleRad + kShapeBoundaryEpsilonRad);
  }
  if (!(z_lower > 0.0)) {
    return false;
  }

  switch (shape.kind) {
    case SensorShapeKind::Rectangular: {
      auto axis_inside = [&](double lower, double upper, double half_angle) {
        if (half_angle >= 0.5 * 3.14159265358979323846) {
          return true;
        }
        const double maximum_absolute_component = inflate_proof_upper_bound(
          std::max(std::fabs(lower), std::fabs(upper)));
        const double permitted_component = deflate_proof_lower_bound(
          std::tan(half_angle) * z_lower);
        return maximum_absolute_component < permitted_component;
      };
      return
        axis_inside(
          x_lower,
          x_upper,
          shape.crossTrackHalfAngleRad) &&
        axis_inside(
          y_lower,
          y_upper,
          shape.alongTrackHalfAngleRad);
    }
    case SensorShapeKind::Conic:
    case SensorShapeKind::SarAnnularSector: {
      if (shape.outerHalfAngleRad < 3.14159265358979323846) {
        if (!(z_lower > sensor.outerHalfAngleCosUpper)) {
          return false;
        }
      }
      if (shape.innerHalfAngleRad > 0.0) {
        if (shape.innerHalfAngleRad >= 3.14159265358979323846) {
          return false;
        }
        if (!(z_upper < sensor.innerHalfAngleCosLower)) {
          return false;
        }
      }
      if (!shape.clockRange.fullCircle) {
        const double transverse_center = std::hypot(x_center, y_center);
        const double transverse_error = inflate_proof_upper_bound(
          look.chordError + std::hypot(
            x_axis.chordError,
            y_axis.chordError));
        if (!(transverse_center > transverse_error)) {
          return false;
        }
        const double clock_error = inflate_proof_upper_bound(std::asin(clamp(
          transverse_error / transverse_center,
          0.0,
          1.0)));
        const double clock_angle = normalize_angle_rad(
          std::atan2(y_center, x_center));
        const double from_clock_start = normalize_angle_rad(
          clock_angle - shape.clockRange.startRad);
        if (
          !(from_clock_start > clock_error) ||
          !(shape.clockRange.spanRad - from_clock_start > clock_error)
        ) {
          return false;
        }
      }
      return true;
    }
    case SensorShapeKind::CustomPolygon:
    case SensorShapeKind::Unknown:
    default:
      return false;
  }
}

bool fixed_surface_witness_visible_for_entire_interval(
    Vec3 surface_position,
    Vec3 surface_normal,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop) {
  UnitDirectionEnvelope boresight;
  UnitDirectionEnvelope x_axis;
  UnitDirectionEnvelope y_axis;
  if (!resolved_frame_envelopes(
        start,
        stop,
        boresight,
        x_axis,
        y_axis)) {
    return false;
  }
  return fixed_surface_witness_visible_for_entire_interval_with_frame_envelopes(
    surface_position,
    surface_normal,
    sensor,
    start,
    stop,
    boresight,
    x_axis,
    y_axis);
}

bool exact_surface_witness_from_resolved_state(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& resolved,
    Vec3& witness_position) {
  for (int sample_index = 0; sample_index < cell.sampleCount; ++sample_index) {
    if (surface_sample_visible_from_resolved_state(
          cell.samplePositions[sample_index],
          cell.sampleNormals[sample_index],
          sensor,
          resolved)) {
      witness_position = cell.samplePositions[sample_index];
      return true;
    }
  }
  if (boresight_ground_point_inside_cell(
        cell,
        sensor,
        resolved,
        &witness_position)) {
    return true;
  }
  return
    has_solid_conic_continuum_contract(sensor) &&
    solid_conic_cell_has_exact_spatial_witness(
      cell,
      sensor,
      resolved,
      &witness_position);
}

bool surface_position_inside_cell(
    Vec3 surface_position,
    const GridCellGeometry& cell) {
  const Vertex position = to_cartographic(surface_position);
  return
    position.latitudeDeg >= cell.minLatitudeDeg &&
    position.latitudeDeg <= cell.maxLatitudeDeg &&
    longitude_inside_closed_cell(
      position.longitudeDeg,
      cell.minLongitudeDeg,
      cell.maxLongitudeDeg);
}

bool fixed_midpoint_local_ray_witness_visible_for_entire_interval(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    SensorVec3 local_direction,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& midpoint,
    const ResolvedVisibilityState& stop,
    const UnitDirectionEnvelope* cached_boresight = nullptr,
    const UnitDirectionEnvelope* cached_x_axis = nullptr,
    const UnitDirectionEnvelope* cached_y_axis = nullptr) {
  const Vec3 world_direction = world_direction_for_local_ray(
    midpoint.frame,
    local_direction);
  Vec3 surface_position;
  if (!intersect_earth(
        midpoint.state.position,
        world_direction,
        1.0e100,
        surface_position)) {
    return false;
  }
  if (!surface_position_inside_cell(surface_position, cell)) {
    const Vertex representative = to_cartographic(surface_position);
    const double latitude_deg = clamp(
      representative.latitudeDeg,
      cell.minLatitudeDeg,
      cell.maxLatitudeDeg);
    const double longitude_reference_deg =
      0.5 * (cell.minLongitudeDeg + cell.maxLongitudeDeg);
    double longitude_deg = representative.longitudeDeg;
    while (longitude_deg - longitude_reference_deg > 180.0) {
      longitude_deg -= 360.0;
    }
    while (longitude_deg - longitude_reference_deg < -180.0) {
      longitude_deg += 360.0;
    }
    longitude_deg = clamp(
      longitude_deg,
      cell.minLongitudeDeg,
      cell.maxLongitudeDeg);
    surface_position = geodetic_to_ecef({
      longitude_deg / kRadiansToDegrees,
      latitude_deg / kRadiansToDegrees,
      0.0,
    });
  }
  if (cached_boresight && cached_x_axis && cached_y_axis) {
    return fixed_surface_witness_visible_for_entire_interval_with_frame_envelopes(
      surface_position,
      geodetic_surface_normal(surface_position),
      sensor,
      start,
      stop,
      *cached_boresight,
      *cached_x_axis,
      *cached_y_axis);
  }
  return fixed_surface_witness_visible_for_entire_interval(
    surface_position,
    geodetic_surface_normal(surface_position),
    sensor,
    start,
    stop);
}

bool representative_local_shape_direction(
    const SensorConfig& sensor,
    SensorVec3& direction) {
  if (!sensor.hasRepresentativeLocalDirection) {
    return false;
  }
  direction = sensor.representativeLocalDirection;
  return true;
}

bool cell_has_moving_local_shape_ray_for_entire_interval(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop,
    const IntervalShapeProofContext& context,
    bool include_shape_subcones,
    const ResolvedVisibilityState* midpoint = nullptr,
    const Vec3* midpoint_witness = nullptr) {
  if (!context.valid) {
    return false;
  }
  auto ray_proves_access = [&](SensorVec3 local_direction) {
    return fixed_local_ray_ground_track_inside_cell(
      cell,
      sensor,
      local_direction,
      start,
      stop,
      context.sweptCap,
      context.boresight,
      context.xAxis,
      context.yAxis);
  };

  SensorVec3 representative;
  if (
    representative_local_shape_direction(sensor, representative) &&
    ray_proves_access(representative)
  ) {
    return true;
  }
  const SensorShapeContract& shape = sensor.shapeContract;
  if (
    midpoint &&
    has_solid_conic_continuum_contract(sensor)
  ) {
    // A point aimed at the cell center (then corners/edge midpoints) is often
    // a stronger continuous-transit witness than the instantaneous
    // closest-to-boresight point, which naturally sits on the cell boundary.
    // Each candidate is accepted only if its complete local-ray ground track
    // is proven to remain inside the cell and shape for the whole interval.
    for (int sample_index = 0;
         sample_index < cell.sampleCount;
         ++sample_index) {
      const Vec3 midpoint_look = subtract(
        cell.samplePositions[sample_index],
        midpoint->state.position);
      if (ray_proves_access({
            dot(midpoint_look, midpoint->frame.xAxis),
            dot(midpoint_look, midpoint->frame.yAxis),
            dot(midpoint_look, midpoint->frame.boresight),
          })) {
        return true;
      }
    }
    Vec3 recovered_witness;
    const Vec3* exact_witness = midpoint_witness;
    if (!exact_witness && exact_surface_witness_from_resolved_state(
          cell,
          sensor,
          *midpoint,
          recovered_witness)) {
      exact_witness = &recovered_witness;
    }
    if (exact_witness) {
      const Vec3 surface_position = *exact_witness;
      const Vec3 midpoint_look = subtract(
        surface_position,
        midpoint->state.position);
      if (ray_proves_access({
            dot(midpoint_look, midpoint->frame.xAxis),
            dot(midpoint_look, midpoint->frame.yAxis),
            dot(midpoint_look, midpoint->frame.boresight),
          })) {
        return true;
      }
    }
  }
  if (
    !include_shape_subcones ||
    shape.kind != SensorShapeKind::SarAnnularSector ||
    shape.clockRange.fullCircle
  ) {
    return false;
  }
  constexpr int kLookPartitions = 2;
  constexpr int kClockPartitions = 2;
  const double look_span_rad =
    shape.outerHalfAngleRad - shape.innerHalfAngleRad;
  for (int look_index = 0; look_index < kLookPartitions; ++look_index) {
    const double look_rad = shape.innerHalfAngleRad +
      (static_cast<double>(look_index) + 0.5) *
        look_span_rad / kLookPartitions;
    const double transverse = std::sin(look_rad);
    for (int clock_index = 0; clock_index < kClockPartitions; ++clock_index) {
      const double clock_rad = normalize_angle_rad(
        shape.clockRange.startRad +
        (static_cast<double>(clock_index) + 0.5) *
          shape.clockRange.spanRad / kClockPartitions);
      if (ray_proves_access({
            transverse * std::cos(clock_rad),
            transverse * std::sin(clock_rad),
            std::cos(look_rad),
          })) {
        return true;
      }
    }
  }
  return false;
}

bool conservative_enclosing_local_shape_cap(
    const SensorConfig& sensor,
    SensorVec3& center_direction,
    double& angular_radius_rad) {
  const SensorShapeContract& shape = sensor.shapeContract;
  constexpr double kPi = 3.14159265358979323846;
  switch (shape.kind) {
    case SensorShapeKind::Rectangular: {
      center_direction = {0.0, 0.0, 1.0};
      if (
        shape.crossTrackHalfAngleRad >= 0.5 * kPi ||
        shape.alongTrackHalfAngleRad >= 0.5 * kPi
      ) {
        angular_radius_rad = 0.5 * kPi;
      } else {
        angular_radius_rad = std::atan(std::hypot(
          std::tan(shape.crossTrackHalfAngleRad),
          std::tan(shape.alongTrackHalfAngleRad)));
      }
      return true;
    }
    case SensorShapeKind::Conic:
      center_direction = {0.0, 0.0, 1.0};
      angular_radius_rad = clamp(shape.outerHalfAngleRad, 0.0, kPi);
      return true;
    case SensorShapeKind::SarAnnularSector: {
      if (
        shape.outerHalfAngleRad < shape.innerHalfAngleRad ||
        shape.innerHalfAngleRad < 0.0 ||
        shape.outerHalfAngleRad > kPi
      ) {
        return false;
      }
      if (shape.clockRange.fullCircle) {
        center_direction = {0.0, 0.0, 1.0};
        angular_radius_rad = shape.outerHalfAngleRad;
        return true;
      }
      const double look_center_rad = 0.5 * (
        shape.innerHalfAngleRad + shape.outerHalfAngleRad);
      const double clock_center_rad = normalize_angle_rad(
        shape.clockRange.startRad + 0.5 * shape.clockRange.spanRad);
      const double transverse = std::sin(look_center_rad);
      center_direction = {
        transverse * std::cos(clock_center_rad),
        transverse * std::sin(clock_center_rad),
        std::cos(look_center_rad),
      };
      // Move first in look angle and then along a constant-look small circle.
      // The latter path length is sin(look) times its clock-angle sweep, so
      // the triangle inequality encloses the complete annular sector.
      double maximum_transverse_scale = std::max(
        std::sin(shape.innerHalfAngleRad),
        std::sin(shape.outerHalfAngleRad));
      if (
        shape.innerHalfAngleRad <= 0.5 * kPi &&
        shape.outerHalfAngleRad >= 0.5 * kPi
      ) {
        maximum_transverse_scale = 1.0;
      }
      angular_radius_rad = std::min(
        kPi,
        0.5 * (shape.outerHalfAngleRad - shape.innerHalfAngleRad) +
          0.5 * maximum_transverse_scale * shape.clockRange.spanRad);
      return true;
    }
    case SensorShapeKind::CustomPolygon:
    case SensorShapeKind::Unknown:
    default:
      return false;
  }
}

bool cell_intersects_conservative_local_shape_ground_track(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop,
    const IntervalShapeProofContext& context,
    const SweptSensorCap* precomputed_sar_caps,
    int precomputed_sar_cap_count) {
  if (!context.valid) {
    return true;
  }
  auto local_cap_intersects = [&](
      SensorVec3 local_center,
      double local_radius_rad,
      bool& proven) {
    SweptSensorCap ground_cap;
    if (!conservative_fixed_local_ray_ground_track_cap(
          sensor,
          local_center,
          local_radius_rad,
          start,
          stop,
          context.sweptCap,
          context.boresight,
          context.xAxis,
          context.yAxis,
          ground_cap)) {
      proven = false;
      return true;
    }
    return sdn::coverage::sphericalCapIntersectsRectangle(
      ground_cap.center,
      ground_cap.angularRadiusDeg,
      cell.minGeocentricLatitudeDeg,
      cell.maxGeocentricLatitudeDeg,
      cell.minLongitudeDeg,
      cell.maxLongitudeDeg);
  };

  const SensorShapeContract& shape = sensor.shapeContract;
  if (
    shape.kind == SensorShapeKind::SarAnnularSector &&
    !shape.clockRange.fullCircle
  ) {
    if (precomputed_sar_cap_count >= 0) {
      for (int cap_index = 0;
           cap_index < precomputed_sar_cap_count;
           ++cap_index) {
        const SweptSensorCap& cap = precomputed_sar_caps[cap_index];
        if (sdn::coverage::sphericalCapIntersectsRectangle(
              cap.center,
              cap.angularRadiusDeg,
              cell.minGeocentricLatitudeDeg,
              cell.maxGeocentricLatitudeDeg,
              cell.minLongitudeDeg,
              cell.maxLongitudeDeg)) {
          return true;
        }
      }
      // A zero count means the conservative construction was inconclusive.
      return precomputed_sar_cap_count == 0;
    }
    // Cover the annular clock sector by a small union of local spherical
    // caps. Each cap is an outer bound for its radial/clock sub-rectangle;
    // rejecting the cell against every member therefore cannot drop access.
    constexpr int kLookPartitions = 2;
    constexpr int kClockPartitions = 1;
    const double look_span_rad =
      shape.outerHalfAngleRad - shape.innerHalfAngleRad;
    if (look_span_rad < 0.0 || shape.clockRange.spanRad < 0.0) {
      return true;
    }
    for (int look_index = 0; look_index < kLookPartitions; ++look_index) {
      const double look_center_rad = shape.innerHalfAngleRad +
        (static_cast<double>(look_index) + 0.5) *
          look_span_rad / kLookPartitions;
      const double transverse = std::sin(look_center_rad);
      for (int clock_index = 0; clock_index < kClockPartitions; ++clock_index) {
        const double clock_center_rad = normalize_angle_rad(
          shape.clockRange.startRad +
          (static_cast<double>(clock_index) + 0.5) *
            shape.clockRange.spanRad / kClockPartitions);
        const SensorVec3 local_center{
          transverse * std::cos(clock_center_rad),
          transverse * std::sin(clock_center_rad),
          std::cos(look_center_rad),
        };
        // Changing look by d moves exactly d on the sphere; changing clock by
        // d at fixed look follows a small-circle path no longer than d.
        const double sub_minimum_look_rad =
          shape.innerHalfAngleRad +
          static_cast<double>(look_index) *
            look_span_rad / kLookPartitions;
        const double sub_maximum_look_rad =
          shape.innerHalfAngleRad +
          static_cast<double>(look_index + 1) *
            look_span_rad / kLookPartitions;
        double maximum_transverse_scale = std::max(
          std::sin(sub_minimum_look_rad),
          std::sin(sub_maximum_look_rad));
        if (
          sub_minimum_look_rad <= 0.5 * 3.14159265358979323846 &&
          sub_maximum_look_rad >= 0.5 * 3.14159265358979323846
        ) {
          maximum_transverse_scale = 1.0;
        }
        const double local_radius_rad =
          0.5 * look_span_rad / kLookPartitions +
          0.5 * maximum_transverse_scale *
            shape.clockRange.spanRad / kClockPartitions +
          1.0e-12;
        bool proven = true;
        if (local_cap_intersects(local_center, local_radius_rad, proven)) {
          return true;
        }
        if (!proven) {
          return true;
        }
      }
    }
    return false;
  }

  SensorVec3 local_center;
  double local_radius_rad = 0.0;
  if (!conservative_enclosing_local_shape_cap(
        sensor,
        local_center,
        local_radius_rad)) {
    return true;
  }
  bool proven = true;
  return local_cap_intersects(local_center, local_radius_rad, proven) ||
    !proven;
}

bool cell_has_fixed_visible_witness_for_entire_interval(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& midpoint,
    const ResolvedVisibilityState& stop) {
  // Coarse cells can wholly contain a footprint without containing any of the
  // nine lattice samples. Freeze exact interior shape rays' midpoint Earth
  // hits (or their closest closed-cell points), then certify the same WGS84
  // point—not a moving ray—for the complete interval. The small deterministic
  // basis covers inscribed rectangular/SAR sub-cones; it is only a source of
  // proof witnesses, never a sample-based acceptance rule.
  UnitDirectionEnvelope boresight;
  UnitDirectionEnvelope x_axis;
  UnitDirectionEnvelope y_axis;
  if (!resolved_frame_envelopes(
        start,
        stop,
        boresight,
        x_axis,
        y_axis)) {
    return false;
  }
  auto direction_proves_access = [&](SensorVec3 local_direction) {
    const bool visible = fixed_midpoint_local_ray_witness_visible_for_entire_interval(
      cell,
      sensor,
      local_direction,
      start,
      midpoint,
      stop,
      &boresight,
      &x_axis,
      &y_axis);
    return visible;
  };

  SensorVec3 local_direction;
  if (
    representative_local_shape_direction(sensor, local_direction) &&
    direction_proves_access(local_direction)
  ) {
    return true;
  }

  for (int sample_index = 0; sample_index < cell.sampleCount; ++sample_index) {
    if (fixed_surface_witness_visible_for_entire_interval_with_frame_envelopes(
          cell.samplePositions[sample_index],
          cell.sampleNormals[sample_index],
          sensor,
          start,
          stop,
          boresight,
          x_axis,
          y_axis)) {
      return true;
    }
  }

  for (const SensorVec3 local_witness_direction :
       sensor.fixedWitnessLocalDirections) {
    if (direction_proves_access(local_witness_direction)) {
      return true;
    }
  }
  return false;
}

bool exact_visibility_geometry_is_constant(
    const State& start,
    const State& stop) {
  auto same_vec3 = [](Vec3 left, Vec3 right) {
    return
      left.x == right.x &&
      left.y == right.y &&
      left.z == right.z;
  };
  return
    same_vec3(start.position, stop.position) &&
    same_vec3(start.velocity, stop.velocity) &&
    start.sensorFrame.valid == stop.sensorFrame.valid &&
    (!start.sensorFrame.valid || (
      same_vec3(start.sensorFrame.boresight, stop.sensorFrame.boresight) &&
      same_vec3(start.sensorFrame.xAxis, stop.sensorFrame.xAxis) &&
      same_vec3(start.sensorFrame.yAxis, stop.sensorFrame.yAxis)));
}

bool cell_intersects_conservative_swept_sensor_cap(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop) {
  const SweptSensorCap cap = conservative_swept_sensor_cap(
    start,
    stop,
    sensor);
  return sdn::coverage::sphericalCapIntersectsRectangle(
    cap.center,
    cap.angularRadiusDeg,
    cell.minGeocentricLatitudeDeg,
    cell.maxGeocentricLatitudeDeg,
    cell.minLongitudeDeg,
    cell.maxLongitudeDeg);
}

double extend_fixed_surface_witness_proof_from_sample(
    Vec3 surface_position,
    Vec3 surface_normal,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& interpolation_start,
    const ResolvedVisibilityState& interpolation_stop,
    const ResolvedVisibilityState& anchor,
    const ResolvedVisibilityState& target) {
  const double anchor_time = anchor.state.elapsedSeconds;
  const double target_time = target.state.elapsedSeconds;
  if (anchor_time == target_time) {
    return anchor_time;
  }
  auto interval_is_proven = [&](double candidate_time) {
    const ResolvedVisibilityState candidate = resolve_visibility_state(
      interpolate_state(
        interpolation_start.state,
        interpolation_stop.state,
        candidate_time));
    const ResolvedVisibilityState& proof_start =
      candidate_time < anchor_time ? candidate : anchor;
    const ResolvedVisibilityState& proof_stop =
      candidate_time < anchor_time ? anchor : candidate;
    return fixed_surface_witness_visible_for_entire_interval(
      surface_position,
      surface_normal,
      sensor,
      proof_start,
      proof_stop);
  };
  if (interval_is_proven(target_time)) {
    return target_time;
  }
  if (!interval_is_proven(anchor_time)) {
    return anchor_time;
  }

  // The same immutable WGS84 point is the authority for every accepted
  // candidate. Bisection only enlarges an already-proven interval; it never
  // infers a transition from aggregate cell visibility.
  double proven_time = anchor_time;
  double unproven_time = target_time;
  constexpr int kWitnessProofExtensionIterations = 16;
  for (int iteration = 0;
       iteration < kWitnessProofExtensionIterations;
       ++iteration) {
    const double candidate_time = 0.5 * (proven_time + unproven_time);
    if (interval_is_proven(candidate_time)) {
      proven_time = candidate_time;
    } else {
      unproven_time = candidate_time;
    }
  }
  return proven_time;
}

void append_proven_conic_leaf_witness_neighborhood(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& interpolation_start,
    const ResolvedVisibilityState& interpolation_stop,
    const ResolvedVisibilityState& left_target,
    const ResolvedVisibilityState& sample,
    bool visible_sample,
    const ResolvedVisibilityState& right_target,
    std::vector<VisibilityInterval>& intervals) {
  if (!visible_sample) {
    return;
  }
  Vec3 surface_position;
  if (!exact_surface_witness_from_resolved_state(
        cell,
        sensor,
        sample,
        surface_position)) {
    // The caller's exact predicate still proves this instant even if a
    // witness cannot be recovered (for example, at a numeric boundary).
    intervals.push_back({
      sample.state.elapsedSeconds,
      sample.state.elapsedSeconds,
      true,
    });
    return;
  }
  const Vec3 surface_normal = geodetic_surface_normal(surface_position);
  const double proven_left = extend_fixed_surface_witness_proof_from_sample(
    surface_position,
    surface_normal,
    sensor,
    interpolation_start,
    interpolation_stop,
    sample,
    left_target);
  const double proven_right = extend_fixed_surface_witness_proof_from_sample(
    surface_position,
    surface_normal,
    sensor,
    interpolation_start,
    interpolation_stop,
    sample,
    right_target);
  intervals.push_back({
    std::min(proven_left, proven_right),
    std::max(proven_left, proven_right),
    true,
  });
}

void append_refined_visibility_intervals_impl(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& interpolation_start,
    const ResolvedVisibilityState& interpolation_stop,
    const ResolvedVisibilityState& start,
    bool visible_start,
    const ResolvedVisibilityState& stop,
    bool visible_stop,
    int depth,
    std::vector<VisibilityInterval>& intervals,
    const IntervalShapeProofContext* precomputed_root_context,
    bool root_nadir_checked,
    bool root_joint_angle_checked,
    bool root_swept_cap_checked) {
  if (!(stop.state.elapsedSeconds > start.state.elapsedSeconds)) {
    return;
  }
  if (exact_visibility_geometry_is_constant(start.state, stop.state)) {
    if (visible_start) {
      intervals.push_back({
        start.state.elapsedSeconds,
        stop.state.elapsedSeconds,
        true,
      });
    }
    return;
  }

  const bool solid_conic_continuum =
    has_solid_conic_continuum_contract(sensor);
  const bool reuse_root_checks =
    depth == 0 && precomputed_root_context != nullptr;
  if (
    solid_conic_continuum &&
    !(reuse_root_checks && root_nadir_checked) &&
    solid_conic_nadir_sweep_proven_disjoint(
      cell,
      sensor,
      start,
      stop)
  ) {
    return;
  }

  // Three aggregate visible probes are not a continuum proof: they can use
  // different cell points. Accept a complete interval only when the swept
  // outer footprint is proven to remain inside this cell and one immutable
  // local ray is proven to hit WGS84 within range throughout the interval.
  if (cell_contains_continuously_visible_sensor_footprint(
        cell,
        sensor,
        start,
        stop,
        reuse_root_checks
          ? &precomputed_root_context->sweptCap
          : nullptr)) {
    intervals.push_back({
      start.state.elapsedSeconds,
      stop.state.elapsedSeconds,
      true,
    });
    return;
  }

  IntervalShapeProofContext computed_proof_context;
  if (!reuse_root_checks) {
    computed_proof_context = interval_shape_proof_context(
      sensor,
      start,
      stop);
  }
  const IntervalShapeProofContext& proof_context = reuse_root_checks
    ? *precomputed_root_context
    : computed_proof_context;
  SweptSensorCap sar_limiting_caps[2];
  const bool has_partial_sar_shape =
    sensor.shapeContract.kind == SensorShapeKind::SarAnnularSector &&
    !sensor.shapeContract.clockRange.fullCircle;
  const bool sar_ground_cap_checkpoint =
    depth == 0;
  const int sar_limiting_cap_count =
    has_partial_sar_shape && sar_ground_cap_checkpoint
    ? conservative_sar_interval_ground_caps(
      sensor,
      start,
      stop,
      proof_context,
      sar_limiting_caps)
    : -1;
  if (!cell_intersects_conservative_local_shape_ground_track(
      cell,
      sensor,
      start,
      stop,
      proof_context,
      sar_limiting_caps,
      sar_limiting_cap_count)
  ) {
    return;
  }
  if (
    solid_conic_continuum &&
    !(reuse_root_checks && root_joint_angle_checked) &&
    !visible_start &&
    !visible_stop &&
    proof_context.valid &&
    solid_conic_interval_surface_patch_proven_angle_disjoint(
      cell,
      sensor,
      interpolation_start,
      interpolation_stop,
      start,
      stop,
      proof_context,
      1u,
      cell.minLatitudeDeg,
      cell.maxLatitudeDeg,
      cell.minLongitudeDeg,
      cell.maxLongitudeDeg,
      0)
  ) {
    return;
  }

  const double mid_time = 0.5 * (
    start.state.elapsedSeconds + stop.state.elapsedSeconds);
  const ResolvedVisibilityState mid = resolve_visibility_state(
    interpolate_state(
      interpolation_start.state,
      interpolation_stop.state,
      mid_time));
  const bool nonconic_proof_checkpoint =
    sensor.shapeContract.kind == SensorShapeKind::SarAnnularSector
    ? (depth == 0 || depth == 4 || depth == 8)
    : (depth == 0 || depth == 3 || depth == 6 || depth == 9);
  const bool has_interval_geometry_proof =
    sensor.shapeContract.kind == SensorShapeKind::Conic ||
    sensor.shapeContract.kind == SensorShapeKind::Rectangular ||
    sensor.shapeContract.kind == SensorShapeKind::SarAnnularSector;
  const bool representative_ray_proves_access =
    !solid_conic_continuum &&
    (sensor.shapeContract.kind != SensorShapeKind::SarAnnularSector ||
      nonconic_proof_checkpoint) &&
    cell_has_moving_local_shape_ray_for_entire_interval(
      cell,
      sensor,
      start,
      stop,
      proof_context,
      false);
  if (representative_ray_proves_access) {
    intervals.push_back({
      start.state.elapsedSeconds,
      stop.state.elapsedSeconds,
      true,
    });
    return;
  }
  SensorVec3 representative_local_direction;
  const bool representative_fixed_witness_proves_access =
    !solid_conic_continuum &&
    representative_local_shape_direction(
      sensor,
      representative_local_direction) &&
    fixed_midpoint_local_ray_witness_visible_for_entire_interval(
      cell,
      sensor,
      representative_local_direction,
      start,
      mid,
      stop);
  if (representative_fixed_witness_proves_access) {
    intervals.push_back({
      start.state.elapsedSeconds,
      stop.state.elapsedSeconds,
      true,
    });
    return;
  }
  bool interval_geometry_was_checked = false;
  if (
    sensor.shapeContract.kind == SensorShapeKind::SarAnnularSector &&
    nonconic_proof_checkpoint &&
    !visible_start &&
    !visible_stop
  ) {
    interval_geometry_was_checked = true;
    const CellIntervalGeometryProof geometry_proof =
      cell_interval_geometry_proof(
        cell,
        sensor,
        start,
        stop,
        proof_context,
        depth >= 8 ? 10 : 7);
    if (geometry_proof == CellIntervalGeometryProof::Visible) {
      intervals.push_back({
        start.state.elapsedSeconds,
        stop.state.elapsedSeconds,
        true,
      });
      return;
    }
    if (geometry_proof == CellIntervalGeometryProof::Disjoint) {
      return;
    }
  }
  Vec3 midpoint_witness;
  const bool visible_mid = cell_visible_from_resolved_state(
    cell,
    sensor,
    mid,
    &midpoint_witness);
  if (
    solid_conic_continuum &&
    visible_mid &&
    proof_context.valid &&
    fixed_surface_witness_visible_for_entire_interval_with_frame_envelopes(
      midpoint_witness,
      geodetic_surface_normal(midpoint_witness),
      sensor,
      start,
      stop,
      proof_context.boresight,
      proof_context.xAxis,
      proof_context.yAxis)
  ) {
    intervals.push_back({
      start.state.elapsedSeconds,
      stop.state.elapsedSeconds,
      true,
    });
    return;
  }
  if (
    solid_conic_continuum &&
    (visible_start || visible_mid || visible_stop)
  ) {
    if (cell_has_moving_local_shape_ray_for_entire_interval(
          cell,
          sensor,
          start,
          stop,
          proof_context,
          false,
          &mid,
          visible_mid ? &midpoint_witness : nullptr)) {
      intervals.push_back({
        start.state.elapsedSeconds,
        stop.state.elapsedSeconds,
        true,
      });
      return;
    }
  }
  if (
    (visible_start || visible_mid || visible_stop ||
      (nonconic_proof_checkpoint &&
        sensor.shapeContract.kind != SensorShapeKind::SarAnnularSector)) &&
    cell_has_fixed_visible_witness_for_entire_interval(
      cell,
      sensor,
      start,
      mid,
      stop)
  ) {
    intervals.push_back({
      start.state.elapsedSeconds,
      stop.state.elapsedSeconds,
      true,
    });
    return;
  }
  if (
    !visible_start && !visible_mid && !visible_stop &&
    nonconic_proof_checkpoint &&
    !interval_geometry_was_checked &&
    !solid_conic_continuum &&
    has_interval_geometry_proof
  ) {
    const CellIntervalGeometryProof geometry_proof =
      cell_interval_geometry_proof(
        cell,
        sensor,
        start,
        stop,
        proof_context,
        depth >= 8 ? 10 : 7);
    if (geometry_proof == CellIntervalGeometryProof::Visible) {
      intervals.push_back({
        start.state.elapsedSeconds,
        stop.state.elapsedSeconds,
        true,
      });
      return;
    }
    if (geometry_proof == CellIntervalGeometryProof::Disjoint) {
      return;
    }
  }

  const bool swept_cap_intersects =
    (reuse_root_checks && root_swept_cap_checked) ||
    cell_intersects_conservative_swept_sensor_cap(
      cell,
      sensor,
      start,
      stop);
  if (!visible_start && !visible_mid && !visible_stop &&
      !swept_cap_intersects) {
    return;
  }

  if (depth >= kVisibilitySearchMaxDepth) {
    if (solid_conic_continuum) {
      // Never connect existential cell samples by assumption. Recover the
      // exact WGS84 witness behind each positive sample and extend it only as
      // far as that same immutable point proves continuous visibility. Exact
      // tangencies naturally remain zero-duration singleton intervals.
      append_proven_conic_leaf_witness_neighborhood(
        cell,
        sensor,
        interpolation_start,
        interpolation_stop,
        start,
        start,
        visible_start,
        mid,
        intervals);
      append_proven_conic_leaf_witness_neighborhood(
        cell,
        sensor,
        interpolation_start,
        interpolation_stop,
        start,
        mid,
        visible_mid,
        stop,
        intervals);
      append_proven_conic_leaf_witness_neighborhood(
        cell,
        sensor,
        interpolation_start,
        interpolation_stop,
        mid,
        stop,
        visible_stop,
        stop,
        intervals);
      return;
    }
    const VisibilityInterval refined = refined_visibility_interval(
      cell,
      sensor,
      interpolation_start,
      interpolation_stop,
      start,
      stop);
    if (refined.valid) {
      intervals.push_back(refined);
    }
    return;
  }

  append_refined_visibility_intervals_impl(
    cell,
    sensor,
    interpolation_start,
    interpolation_stop,
    start,
    visible_start,
    mid,
    visible_mid,
    depth + 1,
    intervals,
    nullptr,
    false,
    false,
    false);
  append_refined_visibility_intervals_impl(
    cell,
    sensor,
    interpolation_start,
    interpolation_stop,
    mid,
    visible_mid,
    stop,
    visible_stop,
    depth + 1,
    intervals,
    nullptr,
    false,
    false,
    false);
}

void append_refined_visibility_intervals(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& interpolation_start,
    const ResolvedVisibilityState& interpolation_stop,
    double interval_start_seconds,
    double interval_stop_seconds,
    int depth,
    std::vector<VisibilityInterval>& intervals,
    const bool* known_visible_start,
    bool* visible_stop_result,
    const IntervalShapeProofContext* precomputed_root_context = nullptr,
    bool root_nadir_checked = false,
    bool root_joint_angle_checked = false,
    bool root_swept_cap_checked = false) {
  if (!(interval_stop_seconds > interval_start_seconds)) {
    return;
  }
  const ResolvedVisibilityState start = resolve_visibility_state(
    interpolate_state(
      interpolation_start.state,
      interpolation_stop.state,
      interval_start_seconds));
  const ResolvedVisibilityState stop = resolve_visibility_state(
    interpolate_state(
      interpolation_start.state,
      interpolation_stop.state,
      interval_stop_seconds));
  const bool visible_start = known_visible_start
    ? *known_visible_start
    : cell_visible_from_resolved_state(
      cell,
      sensor,
      start);
  const bool visible_stop = cell_visible_from_resolved_state(
    cell,
    sensor,
    stop);
  if (visible_stop_result) {
    *visible_stop_result = visible_stop;
  }
  append_refined_visibility_intervals_impl(
    cell,
    sensor,
    interpolation_start,
    interpolation_stop,
    start,
    visible_start,
    stop,
    visible_stop,
    depth,
    intervals,
    precomputed_root_context,
    root_nadir_checked,
    root_joint_angle_checked,
    root_swept_cap_checked);
}

std::map<int, std::vector<const SwathSegment*>> index_swaths_by_sensor(
    const std::vector<SwathSegment>& swaths) {
  std::map<int, std::vector<const SwathSegment*>> swaths_by_sensor;
  for (const auto& swath : swaths) {
    swaths_by_sensor[swath.sensorId].push_back(&swath);
  }
  return swaths_by_sensor;
}

void add_cell_interval(
    Cell& cell,
    const VisibilityInterval& interval,
    int sensor_id) {
  if (!interval.valid || interval.stop < interval.start) {
    return;
  }
  cell.intervals.push_back({interval.start, interval.stop, {sensor_id}});
}

bool solid_conic_interval_has_constructive_visible_cover(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& interpolation_start,
    const ResolvedVisibilityState& interpolation_stop,
    double interval_start_seconds,
    double interval_stop_seconds,
    int depth) {
  const ResolvedVisibilityState interval_start = resolve_visibility_state(
    interpolate_state(
      interpolation_start.state,
      interpolation_stop.state,
      interval_start_seconds));
  const ResolvedVisibilityState interval_stop = resolve_visibility_state(
    interpolate_state(
      interpolation_start.state,
      interpolation_stop.state,
      interval_stop_seconds));
  const double midpoint_seconds = 0.5 * (
    interval_start_seconds + interval_stop_seconds);
  const double candidate_seconds[3] = {
    midpoint_seconds,
    interval_start_seconds,
    interval_stop_seconds,
  };
  for (const double candidate_second : candidate_seconds) {
    const ResolvedVisibilityState candidate = resolve_visibility_state(
      interpolate_state(
        interpolation_start.state,
        interpolation_stop.state,
        candidate_second));
    Vec3 witness_position;
    SolidConicSpatialSearch maximum_clearance_search{
      cell,
      sensor,
      candidate,
    };
    const bool optimized_found = optimize_solid_conic_rectangle_witness(
      maximum_clearance_search,
      false);
    if (optimized_found && maximum_clearance_search.hasAccepted) {
      witness_position = maximum_clearance_search.acceptedPosition;
    }
    if (
      optimized_found &&
      fixed_surface_witness_visible_for_entire_interval(
        witness_position,
        geodetic_surface_normal(witness_position),
        sensor,
        interval_start,
        interval_stop)
    ) {
      return true;
    }
    const bool exact_found = exact_surface_witness_from_resolved_state(
        cell,
        sensor,
        candidate,
        witness_position);
    if (
      exact_found &&
      fixed_surface_witness_visible_for_entire_interval(
        witness_position,
        geodetic_surface_normal(witness_position),
        sensor,
        interval_start,
        interval_stop)
    ) {
      return true;
    }
  }
  // A union of two closed, touching proof intervals is itself a constructive
  // visibility proof even when the footprint moves far enough that no single
  // surface point spans the parent interval.
  constexpr int kGapCoverMaximumDepth = 10;
  if (
    depth >= kGapCoverMaximumDepth ||
    !(midpoint_seconds > interval_start_seconds) ||
    !(midpoint_seconds < interval_stop_seconds)
  ) {
    return false;
  }
  return
    solid_conic_interval_has_constructive_visible_cover(
      cell,
      sensor,
      interpolation_start,
      interpolation_stop,
      interval_start_seconds,
      midpoint_seconds,
      depth + 1) &&
    solid_conic_interval_has_constructive_visible_cover(
      cell,
      sensor,
      interpolation_start,
      interpolation_stop,
      midpoint_seconds,
      interval_stop_seconds,
      depth + 1);
}

// Refinement leaves can recover different exact points from the same solid
// conic transit. Roundoff in the independently extended witness neighborhoods
// may leave a tiny positive gap between those proof fragments. Close such a
// gap only when one immutable WGS84 point is itself proven visible throughout
// the complete gap. This is constructive interval stitching, not a time or
// bucket tolerance: a genuine invisibility gap has no such witness and remains
// a separate pass start, however short it is.
void bridge_proven_solid_conic_gaps(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& interpolation_start,
    const ResolvedVisibilityState& interpolation_stop,
    std::vector<VisibilityInterval>& intervals) {
  if (!has_solid_conic_continuum_contract(sensor) || intervals.size() < 2u) {
    return;
  }
  std::sort(
    intervals.begin(),
    intervals.end(),
    [](const VisibilityInterval& left, const VisibilityInterval& right) {
      if (left.start != right.start) {
        return left.start < right.start;
      }
      return left.stop < right.stop;
    });
  std::vector<VisibilityInterval> stitched;
  stitched.reserve(intervals.size());
  for (const VisibilityInterval& interval : intervals) {
    if (!interval.valid || interval.stop < interval.start) {
      continue;
    }
    if (stitched.empty()) {
      stitched.push_back(interval);
      continue;
    }
    VisibilityInterval& prior = stitched.back();
    bool bridge_is_proven = interval.start <= prior.stop;
    if (!bridge_is_proven) {
      bridge_is_proven =
        solid_conic_interval_has_constructive_visible_cover(
          cell,
          sensor,
          interpolation_start,
          interpolation_stop,
          prior.stop,
          interval.start,
          0);
    }
    if (bridge_is_proven) {
      prior.stop = std::max(prior.stop, interval.stop);
    } else {
      stitched.push_back(interval);
    }
  }
  intervals = std::move(stitched);
}

sdn::coverage::GridDefinition coverage_grid_definition(const GridConfig& grid) {
  return {
    grid.minLat,
    grid.maxLat,
    grid.minLon,
    grid.maxLon,
    grid.latStep,
    grid.lonStep,
    grid.rows,
    grid.columns,
  };
}

sdn::coverage::LonLat horizon_cap_center(const State& state) {
  const Vertex center = to_cartographic(geodetic_surface_point(state.position));
  return {center.latitudeDeg, center.longitudeDeg};
}

uint32_t next_candidate_generation(
    uint32_t generation,
    std::vector<uint32_t>& marks) {
  if (generation == std::numeric_limits<uint32_t>::max()) {
    std::fill(marks.begin(), marks.end(), 0u);
    return 1u;
  }
  return generation + 1u;
}

void append_sensor_cap_candidates(
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop,
    const SweptSensorCap& cap,
    const sdn::coverage::GridDefinition& grid,
    std::vector<uint32_t>& candidate_marks,
    uint32_t generation,
    std::vector<uint32_t>& candidate_cell_indices) {
  const double angular_radius_deg = cap.angularRadiusDeg +
      // Candidate caps are expressed in geodetic grid coordinates while the
      // radius is geocentric. Twice the maximum WGS84 geodetic/geocentric
      // latitude separation prevents fine polar-grid false negatives.
      2.0 * kMaximumGeodeticGeocentricLatitudeSeparationDeg;
  sdn::coverage::appendSphericalCapCandidates(
    grid,
    horizon_cap_center(start.state),
    angular_radius_deg,
    candidate_marks,
    generation,
    candidate_cell_indices);
  static_cast<void>(stop);
}

// Interleaved-ownership worker body: process ONLY the cells this worker owns,
// i.e. those whose cell_index satisfies (cell_index % stride) == residue. A
// stride of 1 (residue 0) is the whole grid (the single-thread control). Every
// scratch buffer below is function-local, so N of these run concurrently over
// disjoint cell stripes with ZERO shared mutable state — each cell's intervals
// are produced by exactly one worker in the same track/segment order as the
// single-thread path, so the merged result is BIT-IDENTICAL regardless of
// stride. Interleaving (not contiguous ranges) spreads each sensor's spatially
// banded footprint evenly across workers for load balance.
void accumulate_grid_coverage_products_range(
    std::vector<Cell>& cells,
    const std::vector<SensorTrack>& tracks,
    const GridConfig& grid,
    uint32_t stride,
    uint32_t residue) {
  const sdn::coverage::GridDefinition candidate_grid =
    coverage_grid_definition(grid);
  std::vector<uint32_t> candidate_marks(cells.size(), 0u);
  std::vector<uint32_t> candidate_cell_indices;
  candidate_cell_indices.reserve(std::min<size_t>(cells.size(), 256u));
  uint32_t candidate_generation = 0u;

  for (const auto& track : tracks) {
    if (track.states.size() < 2) {
      continue;
    }
    const std::vector<ResolvedVisibilityState> resolved_states =
      resolve_visibility_states(track.states);
    std::vector<uint32_t> cached_visibility_state_index(
      cells.size(),
      std::numeric_limits<uint32_t>::max());
    std::vector<uint8_t> cached_visibility(cells.size(), 0u);

    const auto process_segment = [&](
        const ResolvedVisibilityState& seg_start,
        const ResolvedVisibilityState& seg_stop,
        uint32_t state_index) {
      candidate_generation = next_candidate_generation(
        candidate_generation,
        candidate_marks);
      candidate_cell_indices.clear();
      const bool solid_conic =
        has_solid_conic_continuum_contract(track.sensor);
      // The interval frame envelopes and swept cap depend only on the state
      // segment and sensor, not on the candidate cell. Reuse them for every
      // shape: narrow rectangular/SAR footprints otherwise rebuild the same
      // trigonometric proof context once per candidate cell at the root of
      // the temporal search.
      const IntervalShapeProofContext segment_proof_context =
        interval_shape_proof_context(
          track.sensor,
          seg_start,
          seg_stop);
      const SweptSensorCap& segment_cap = segment_proof_context.sweptCap;
      append_sensor_cap_candidates(
        seg_start,
        seg_stop,
        segment_cap,
        candidate_grid,
        candidate_marks,
        candidate_generation,
        candidate_cell_indices);

      for (const uint32_t cell_index : candidate_cell_indices) {
        if (cell_index >= cells.size()) {
          continue;
        }
        // Interleaved ownership: skip cells belonging to a sibling worker. The
        // (cheap) candidate enumeration above runs in every worker; only the
        // expensive per-cell visibility work below is partitioned.
        if (stride > 1u && (cell_index % stride) != residue) {
          continue;
        }
        Cell& cell = cells[cell_index];
        ensure_cell_geometry(cell, grid);
        // The broad geodetic enumerator above carries coordinate-conversion
        // slack. Apply the same geocentric swept-cap/rectangle rejection used
        // by the temporal search before any exact endpoint witness searches.
        // This cap is an outer bound, so only a proven disjoint result prunes.
        if (!sdn::coverage::sphericalCapIntersectsRectangle(
              segment_cap.center,
              segment_cap.angularRadiusDeg,
              cell.geometry.minGeocentricLatitudeDeg,
              cell.geometry.maxGeocentricLatitudeDeg,
              cell.geometry.minLongitudeDeg,
              cell.geometry.maxLongitudeDeg)) {
          continue;
        }
        // append_refined_visibility_intervals_impl performs this identical
        // rejection after resolving two expensive exact endpoint predicates.
        // Hoisting it is semantics-neutral and especially important on fine
        // grids, where most cap-overlap neighbors are still conic-disjoint.
        if (solid_conic_nadir_sweep_proven_disjoint(
              cell.geometry,
              track.sensor,
              seg_start,
              seg_stop)) {
          continue;
        }
        if (solid_conic) {
          if (
            segment_proof_context.valid &&
            solid_conic_interval_surface_patch_proven_angle_disjoint(
              cell.geometry,
              track.sensor,
              seg_start,
              seg_stop,
              seg_start,
              seg_stop,
              segment_proof_context,
              1u,
              cell.geometry.minLatitudeDeg,
              cell.geometry.maxLatitudeDeg,
              cell.geometry.minLongitudeDeg,
              cell.geometry.maxLongitudeDeg,
              0)
          ) {
            continue;
          }
        }
        std::vector<VisibilityInterval> intervals;
        bool known_visible_start = false;
        const bool* known_visible_start_pointer = nullptr;
        if (cached_visibility_state_index[cell_index] == state_index) {
          known_visible_start = cached_visibility[cell_index] != 0u;
          known_visible_start_pointer = &known_visible_start;
        }
        bool visible_stop = false;
        append_refined_visibility_intervals(
          cell.geometry,
          track.sensor,
          seg_start,
          seg_stop,
          seg_start.state.elapsedSeconds,
          seg_stop.state.elapsedSeconds,
          0,
          intervals,
          known_visible_start_pointer,
          &visible_stop,
          &segment_proof_context,
          solid_conic,
          solid_conic,
          true);
        bridge_proven_solid_conic_gaps(
          cell.geometry,
          track.sensor,
          seg_start,
          seg_stop,
          intervals);
        cached_visibility_state_index[cell_index] = state_index + 1u;
        cached_visibility[cell_index] = visible_stop ? 1u : 0u;
        for (const VisibilityInterval& interval : intervals) {
          add_cell_interval(
            cell,
            interval,
            track.sensor.sensorId);
        }
      }
    };

    for (size_t state_index = 0; state_index + 1 < track.states.size(); ++state_index) {
      const ResolvedVisibilityState& start_resolved = resolved_states[state_index];
      const ResolvedVisibilityState& stop_resolved = resolved_states[state_index + 1];
      process_segment(
        start_resolved,
        stop_resolved,
        static_cast<uint32_t>(state_index));
    }
  }
}

// ── Isomorphic wasi-threads fan-out ──────────────────────────────────────────
// The per-cell visibility work is embarrassingly parallel (each cell's result
// depends only on the cell + the const tracks/grid). We partition it across
// std::thread-equivalent pthreads. Results are bit-identical to the single
// thread path for ANY worker count (interleaved ownership, see
// accumulate_grid_coverage_products_range).
constexpr int kSensorCoverageDefaultWorkers = 8;
constexpr int kSensorCoverageMaxWorkers = 32;
constexpr uint32_t kSensorCoverageMinCellsPerWorker = 96u;

int sensor_coverage_worker_count(uint32_t cell_count) {
  int requested = kSensorCoverageDefaultWorkers;
  // hardware_concurrency() reports 1 under wasm32-wasip1-threads (wasi-libc has
  // no CPU-count source); trust it only when it actually reports parallelism.
  const unsigned hc = std::thread::hardware_concurrency();
  if (hc >= 2u) {
    requested = static_cast<int>(hc);
  }
  // Optional host override (WASI env) for scaling benchmarks + a 1-worker
  // parity control. Unset/invalid -> the default above.
  if (const char* env = std::getenv("SENSOR_COVERAGE_WORKERS")) {
    const int parsed = std::atoi(env);
    if (parsed > 0) {
      requested = parsed;
    }
  }
  if (requested > kSensorCoverageMaxWorkers) {
    requested = kSensorCoverageMaxWorkers;
  }
  // Never split below the minimum useful stripe size.
  const int by_cells =
    static_cast<int>(cell_count / kSensorCoverageMinCellsPerWorker);
  if (requested > by_cells) {
    requested = by_cells;
  }
  if (requested < 1) {
    requested = 1;
  }
  return requested;
}

struct CoverageAccumWorkerArg {
  std::vector<Cell>* cells;
  const std::vector<SensorTrack>* tracks;
  const GridConfig* grid;
  uint32_t stride;
  uint32_t residue;
};

void* sensor_coverage_accum_worker(void* raw) {
  CoverageAccumWorkerArg* arg = static_cast<CoverageAccumWorkerArg*>(raw);
  accumulate_grid_coverage_products_range(
    *arg->cells, *arg->tracks, *arg->grid, arg->stride, arg->residue);
  return nullptr;
}

void accumulate_grid_coverage_products_impl(
    std::vector<Cell>& cells,
    const std::vector<SensorTrack>& tracks,
    const GridConfig& grid) {
  const uint32_t cell_count = static_cast<uint32_t>(cells.size());
  const int workers = sensor_coverage_worker_count(cell_count);
  if (workers <= 1) {
    // Single-thread control path (RMS / bit-parity reference).
    accumulate_grid_coverage_products_range(cells, tracks, grid, 1u, 0u);
    return;
  }

  const uint32_t stride = static_cast<uint32_t>(workers);
  std::vector<CoverageAccumWorkerArg> args(static_cast<size_t>(workers));
  std::vector<pthread_t> thread_ids(static_cast<size_t>(workers));
  std::vector<uint8_t> spawned(static_cast<size_t>(workers), 0u);
  for (int w = 0; w < workers; ++w) {
    args[static_cast<size_t>(w)] = CoverageAccumWorkerArg{
      &cells, &tracks, &grid, stride, static_cast<uint32_t>(w)};
  }

  // Try to spawn residues 1..W-1 as pthreads. pthread_create is used DIRECTLY
  // (not std::thread) so a host that cannot spawn a guest thread degrades
  // gracefully rather than aborting (std::thread's ctor calls std::terminate
  // under -fno-exceptions on spawn failure). The wasi-threads contract
  // (wasi.thread-spawn import + wasi_thread_start export) is satisfied by the
  // pthread_create reference regardless of runtime spawn success.
  int spawned_count = 0;
  for (int w = 1; w < workers; ++w) {
    const int rc = pthread_create(
      &thread_ids[static_cast<size_t>(w)], nullptr,
      &sensor_coverage_accum_worker, &args[static_cast<size_t>(w)]);
    if (rc == 0) {
      spawned[static_cast<size_t>(w)] = 1u;
      ++spawned_count;
    }
  }

  if (spawned_count == 0) {
    // No host thread support at all (e.g. the browser Web-Worker path, where a
    // guest thread cannot share the SharedArrayBuffer). Run the WHOLE grid as a
    // single stride-1 pass so the (cheap but non-trivial) candidate enumeration
    // is done ONCE — NOT once per stripe. This makes the sequential fallback as
    // fast as the pre-threading single-thread path; the per-stripe inline
    // fallback below would otherwise re-enumerate W times.
    accumulate_grid_coverage_products_range(cells, tracks, grid, 1u, 0u);
    return;
  }

  // Some workers are running. The calling thread covers residue 0 plus any
  // stripe whose spawn failed (disjoint cells from the running workers — race
  // free). Then join the spawned workers.
  for (int w = 1; w < workers; ++w) {
    if (!spawned[static_cast<size_t>(w)]) {
      accumulate_grid_coverage_products_range(
        cells, tracks, grid, stride, static_cast<uint32_t>(w));
    }
  }
  accumulate_grid_coverage_products_range(cells, tracks, grid, stride, 0u);
  for (int w = 1; w < workers; ++w) {
    if (spawned[static_cast<size_t>(w)]) {
      pthread_join(thread_ids[static_cast<size_t>(w)], nullptr);
    }
  }
}

void accumulate_grid_coverage_products(
    std::vector<Cell>& cells,
    const std::vector<SensorTrack>& tracks,
    const std::vector<SwathSegment>& swaths,
    const GridConfig& grid) {
  static_cast<void>(swaths);
  accumulate_grid_coverage_products_impl(cells, tracks, grid);
}

void accumulate_grid_coverage_products(
    std::vector<Cell>& cells,
    const std::vector<SensorTrack>& tracks,
    const GridConfig& grid) {
  accumulate_grid_coverage_products_impl(cells, tracks, grid);
}

// Conservative, target-only, PRUNE-ONLY segment cull. Returns true when the
// target's spatial region is provably outside the segment's footprint swept cap,
// so the whole segment can be skipped. This is essential for viability: without
// it a footprint that sweeps a large target bounding rectangle while missing the
// region (concave / triangular polygons) can never accept early and would
// exhaust the depth-capped witness subdivision. It CANNOT cause a false reject —
// the swept cap conservatively contains the footprint, so "region outside cap"
// implies "region ∩ footprint empty" over the whole segment. Distances are a
// LOWER bound (equirectangular chord, longitude scaled by cos φ) with a margin
// that absorbs the geodetic/geocentric latitude gap of the cap centre, so a
// region anywhere near the footprint is never culled. NOTE: this is a sound
// region-based cull; it does not touch the accept path (Gates 1/2/3), where the
// guardian's "region never prunes an accept" rule still holds exactly.
bool target_region_disjoint_from_cap(
    const TargetAccumulator& target,
    const SweptSensorCap& cap) {
  if (!(cap.angularRadiusDeg >= 0.0) || cap.angularRadiusDeg >= 180.0) {
    return false;
  }
  constexpr double kCullMarginDeg = 0.4;  // geodetic/geocentric + chord slack
  const double sub_lat_deg = cap.center.latitudeDeg;
  const double sub_lon_deg = cap.center.longitudeDeg;
  const double threshold_deg = cap.angularRadiusDeg + kCullMarginDeg;
  const auto normalized_delta_lon = [](double a, double b) {
    double d = a - b;
    while (d > 180.0) d -= 360.0;
    while (d < -180.0) d += 360.0;
    return d;
  };
  const double cos_sub_lat = std::cos(sub_lat_deg / kRadiansToDegrees);
  if (target.boundIsPoint) {
    const double d_lat = sub_lat_deg - target.boundPointLatDeg;
    const double d_lon = normalized_delta_lon(sub_lon_deg, target.boundPointLonDeg) *
      cos_sub_lat;
    const double distance_deg = std::hypot(d_lat, d_lon);
    return distance_deg - target.boundPointRadiusDeg > threshold_deg;
  }
  const std::vector<double>& ring = target.boundRingLonLatDeg;
  const size_t vertex_count = ring.size() / 2;
  if (vertex_count < 3) {
    return false;
  }
  // Sub-point inside the polygon → region is reachable, never cull.
  bool inside = false;
  for (size_t i = 0, j = vertex_count - 1; i < vertex_count; j = i++) {
    const double yi = ring[i * 2 + 1];
    const double yj = ring[j * 2 + 1];
    const double xi = normalized_delta_lon(ring[i * 2], sub_lon_deg);
    const double xj = normalized_delta_lon(ring[j * 2], sub_lon_deg);
    if ((yi > sub_lat_deg) != (yj > sub_lat_deg) &&
        0.0 < (xj - xi) * (sub_lat_deg - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  if (inside) {
    return false;
  }
  // Minimum distance from the sub-point to any polygon edge (scaled planar).
  double min_edge_deg = std::numeric_limits<double>::infinity();
  for (size_t i = 0, j = vertex_count - 1; i < vertex_count; j = i++) {
    const double ax = normalized_delta_lon(ring[j * 2], sub_lon_deg) * cos_sub_lat;
    const double ay = ring[j * 2 + 1];
    const double bx = normalized_delta_lon(ring[i * 2], sub_lon_deg) * cos_sub_lat;
    const double by = ring[i * 2 + 1];
    const double vx = bx - ax;
    const double vy = by - ay;
    const double wx = 0.0 - ax;
    const double wy = sub_lat_deg - ay;
    const double len_sq = vx * vx + vy * vy;
    double t = len_sq > 0.0 ? (vx * wx + vy * wy) / len_sq : 0.0;
    t = clamp(t, 0.0, 1.0);
    const double cx = ax + t * vx;
    const double cy = ay + t * vy;
    min_edge_deg = std::min(min_edge_deg, std::hypot(0.0 - cx, sub_lat_deg - cy));
  }
  return min_edge_deg > threshold_deg;
}

// ── Target coverage accumulation (area-targets Phase 1) ──────────────────────
// Mirrors accumulate_grid_coverage_products_range but partitions by TARGET index
// (target_index % stride == residue). Each target runs the exact per-cell
// interval search on its synthetic bounding-rectangle geometry with its region
// gate active, so every acceptance is a witness inside footprint AND region. All
// disjoint/prune bounds are unchanged and remain sound: region ⊆ the bounding
// rectangle, so a rectangle-disjoint footprint is region-disjoint. Results are
// independent of worker count — each target is owned by exactly one worker and
// targets never interact — so TARGET_RESULTS is byte-identical for any stride.
void accumulate_target_coverage_products_range(
    std::vector<TargetAccumulator>& targets,
    const std::vector<SensorTrack>& tracks,
    const GridConfig& grid,
    uint32_t stride,
    uint32_t residue) {
  static_cast<void>(grid);
  const uint32_t target_count = static_cast<uint32_t>(targets.size());
  if (target_count == 0u) {
    return;
  }
  for (const auto& track : tracks) {
    if (track.states.size() < 2) {
      continue;
    }
    const std::vector<ResolvedVisibilityState> resolved_states =
      resolve_visibility_states(track.states);
    const bool solid_conic = has_solid_conic_continuum_contract(track.sensor);
    for (size_t state_index = 0;
         state_index + 1 < track.states.size();
         ++state_index) {
      const ResolvedVisibilityState& seg_start = resolved_states[state_index];
      const ResolvedVisibilityState& seg_stop = resolved_states[state_index + 1];
      const IntervalShapeProofContext segment_proof_context =
        interval_shape_proof_context(track.sensor, seg_start, seg_stop);
      const SweptSensorCap& segment_cap = segment_proof_context.sweptCap;
      for (uint32_t t = 0; t < target_count; ++t) {
        // Interleaved ownership: each target belongs to exactly one worker.
        if (stride > 1u && (t % stride) != residue) {
          continue;
        }
        TargetAccumulator& target = targets[t];
        if (target.rejected) {
          continue;
        }
        GridCellGeometry& geometry = target.cell.geometry;
        // Region-vs-swept-cap cull FIRST: skips the (potentially expensive)
        // exhaustive witness search whenever the region is provably outside the
        // segment footprint. Prune-only, cannot false-reject.
        if (target_region_disjoint_from_cap(target, segment_cap)) {
          continue;
        }
        // Disjoint prefilters, identical to the cell path and run with the gate
        // OFF (they never accept). Sound for targets because region ⊆ rect.
        if (!sdn::coverage::sphericalCapIntersectsRectangle(
              segment_cap.center,
              segment_cap.angularRadiusDeg,
              geometry.minGeocentricLatitudeDeg,
              geometry.maxGeocentricLatitudeDeg,
              geometry.minLongitudeDeg,
              geometry.maxLongitudeDeg)) {
          continue;
        }
        if (solid_conic_nadir_sweep_proven_disjoint(
              geometry, track.sensor, seg_start, seg_stop)) {
          continue;
        }
        if (solid_conic &&
            segment_proof_context.valid &&
            solid_conic_interval_surface_patch_proven_angle_disjoint(
              geometry,
              track.sensor,
              seg_start,
              seg_stop,
              seg_start,
              seg_stop,
              segment_proof_context,
              1u,
              geometry.minLatitudeDeg,
              geometry.maxLatitudeDeg,
              geometry.minLongitudeDeg,
              geometry.maxLongitudeDeg,
              0)) {
          continue;
        }
        // Region gate ON only around the acceptance-bearing search + gap bridge.
        // The (solid_conic, solid_conic, true) root flags mirror the cell body:
        // the nadir / joint-angle / swept-cap root checks were just performed.
        std::vector<VisibilityInterval> intervals;
        bool visible_stop = false;
        t_target_region_gate = &target.region;
        t_target_is_point = target.boundIsPoint;
        t_target_point_lat_deg = target.boundPointLatDeg;
        t_target_point_lon_deg = target.boundPointLonDeg;
        t_target_point_radius_deg = target.boundPointRadiusDeg;
        append_refined_visibility_intervals(
          geometry,
          track.sensor,
          seg_start,
          seg_stop,
          seg_start.state.elapsedSeconds,
          seg_stop.state.elapsedSeconds,
          0,
          intervals,
          nullptr,
          &visible_stop,
          &segment_proof_context,
          solid_conic,
          solid_conic,
          true);
        bridge_proven_solid_conic_gaps(
          geometry,
          track.sensor,
          seg_start,
          seg_stop,
          intervals);
        t_target_region_gate = nullptr;
        t_target_is_point = false;
        for (const VisibilityInterval& interval : intervals) {
          add_cell_interval(target.cell, interval, track.sensor.sensorId);
        }
      }
    }
  }
}

int sensor_coverage_target_worker_count(uint32_t target_count) {
  int requested = kSensorCoverageDefaultWorkers;
  const unsigned hc = std::thread::hardware_concurrency();
  if (hc >= 2u) {
    requested = static_cast<int>(hc);
  }
  if (const char* env = std::getenv("SENSOR_COVERAGE_WORKERS")) {
    const int parsed = std::atoi(env);
    if (parsed > 0) {
      requested = parsed;
    }
  }
  if (requested > kSensorCoverageMaxWorkers) {
    requested = kSensorCoverageMaxWorkers;
  }
  if (requested > static_cast<int>(target_count)) {
    requested = static_cast<int>(target_count);
  }
  if (requested < 1) {
    requested = 1;
  }
  return requested;
}

struct TargetAccumWorkerArg {
  std::vector<TargetAccumulator>* targets;
  const std::vector<SensorTrack>* tracks;
  const GridConfig* grid;
  uint32_t stride;
  uint32_t residue;
};

void* sensor_coverage_target_accum_worker(void* raw) {
  TargetAccumWorkerArg* arg = static_cast<TargetAccumWorkerArg*>(raw);
  accumulate_target_coverage_products_range(
    *arg->targets, *arg->tracks, *arg->grid, arg->stride, arg->residue);
  return nullptr;
}

// Fan targets across the SAME wasi-threads pool as the grid. EMPTY-TARGETS
// ZERO-COST SHORT-CIRCUIT: no targets → no spawn, no per-segment work (callers
// additionally skip this call entirely when TARGETS is empty).
void accumulate_target_coverage_products(
    std::vector<TargetAccumulator>& targets,
    const std::vector<SensorTrack>& tracks,
    const GridConfig& grid) {
  const uint32_t target_count = static_cast<uint32_t>(targets.size());
  if (target_count == 0u) {
    return;
  }
  const int workers = sensor_coverage_target_worker_count(target_count);
  if (workers <= 1) {
    accumulate_target_coverage_products_range(targets, tracks, grid, 1u, 0u);
    return;
  }
  const uint32_t stride = static_cast<uint32_t>(workers);
  std::vector<TargetAccumWorkerArg> args(static_cast<size_t>(workers));
  std::vector<pthread_t> thread_ids(static_cast<size_t>(workers));
  std::vector<uint8_t> spawned(static_cast<size_t>(workers), 0u);
  for (int w = 0; w < workers; ++w) {
    args[static_cast<size_t>(w)] = TargetAccumWorkerArg{
      &targets, &tracks, &grid, stride, static_cast<uint32_t>(w)};
  }
  int spawned_count = 0;
  for (int w = 1; w < workers; ++w) {
    const int rc = pthread_create(
      &thread_ids[static_cast<size_t>(w)], nullptr,
      &sensor_coverage_target_accum_worker, &args[static_cast<size_t>(w)]);
    if (rc == 0) {
      spawned[static_cast<size_t>(w)] = 1u;
      ++spawned_count;
    }
  }
  if (spawned_count == 0) {
    accumulate_target_coverage_products_range(targets, tracks, grid, 1u, 0u);
    return;
  }
  for (int w = 1; w < workers; ++w) {
    if (!spawned[static_cast<size_t>(w)]) {
      accumulate_target_coverage_products_range(
        targets, tracks, grid, stride, static_cast<uint32_t>(w));
    }
  }
  accumulate_target_coverage_products_range(targets, tracks, grid, stride, 0u);
  for (int w = 1; w < workers; ++w) {
    if (spawned[static_cast<size_t>(w)]) {
      pthread_join(thread_ids[static_cast<size_t>(w)], nullptr);
    }
  }
}

// Merge only overlapping or touching closed intervals. State cadence is an
// interpolation input and cannot define a permissible access gap: using it as
// a merge tolerance would erase real pass starts.
void merge_intervals(
    Cell& cell,
    double scenario_start,
    double scenario_stop,
    double gap_tolerance_seconds) {
  if (cell.intervals.empty()) {
    return;
  }
  std::sort(cell.intervals.begin(), cell.intervals.end(), [](const Interval& left, const Interval& right) {
    return left.start < right.start;
  });
  const double tolerance = std::max(0.0, gap_tolerance_seconds);
  std::vector<Interval> merged;
  for (const auto& interval : cell.intervals) {
    if (interval.stop < scenario_start || interval.start > scenario_stop) {
      continue;
    }
    const Interval clipped{
      clamp(interval.start, scenario_start, scenario_stop),
      clamp(interval.stop, scenario_start, scenario_stop),
      interval.contributingSensorIds,
    };
    if (clipped.stop < clipped.start) {
      continue;
    }
    if (merged.empty() || clipped.start > merged.back().stop + tolerance) {
      merged.push_back(clipped);
    } else {
      merged.back().stop = std::max(merged.back().stop, clipped.stop);
      merge_sensor_ids(merged.back().contributingSensorIds, clipped.contributingSensorIds);
    }
  }
  cell.intervals = merged;
  cell.contributingSensorIds.clear();
  for (const auto& interval : cell.intervals) {
    merge_sensor_ids(cell.contributingSensorIds, interval.contributingSensorIds);
  }
}

void update_cell_statistics(
    Cell& cell,
    const GridConfig& grid,
    double merge_gap_tolerance) {
  merge_intervals(cell, grid.start, grid.stop, merge_gap_tolerance);
  cell.passStartBuckets.clear();
  cell.totalAccess = 0.0;
  cell.maxGap = 0.0;
  cell.totalGap = 0.0;
  cell.revisitGapTotal = 0.0;
  cell.firstResponse = 0.0;
  cell.maxResponse = 0.0;
  cell.meanResponse = 0.0;
  const double duration = std::max(0.0, grid.stop - grid.start);
  if (cell.intervals.empty()) {
    cell.totalGap = duration;
    cell.firstResponse = duration;
    cell.maxGap = duration;
    cell.maxResponse = duration;
    cell.meanResponse = duration;
    return;
  }

  const auto containing_bucket = [&](double elapsed_seconds) {
    if (elapsed_seconds >= grid.stop) {
      return grid.gridIndexCount - 1u;
    }
    return static_cast<uint32_t>(clamp(
      std::floor((elapsed_seconds - grid.start) / grid.step),
      0.0,
      static_cast<double>(grid.gridIndexCount - 1u)));
  };
  for (const Interval& interval : cell.intervals) {
    const uint32_t first_bucket = containing_bucket(interval.start);
    cell.passStartBuckets.push_back(first_bucket);
  }
  cell.accessCount = static_cast<int>(cell.intervals.size());
  cell.revisitCount = std::max(0, cell.accessCount - 1);

  double response_gap_sum = 0.0;
  int response_gap_count = 0;
  auto accumulate_response_gap = [&](double gap) {
    const double finite_gap = std::max(0.0, gap);
    cell.maxResponse = std::max(cell.maxResponse, finite_gap);
    cell.maxGap = std::max(cell.maxGap, finite_gap);
    response_gap_sum += finite_gap;
    ++response_gap_count;
  };

  cell.firstResponse = std::max(
    0.0,
    cell.intervals.front().start - grid.start);
  accumulate_response_gap(cell.firstResponse);
  for (const Interval& interval : cell.intervals) {
    cell.totalAccess += interval.stop - interval.start;
  }
  for (size_t index = 1; index < cell.intervals.size(); ++index) {
    const double gap =
      cell.intervals[index].start - cell.intervals[index - 1].stop;
    cell.revisitGapTotal += gap;
    accumulate_response_gap(gap);
  }
  accumulate_response_gap(grid.stop - cell.intervals.back().stop);
  cell.totalGap = std::max(0.0, duration - cell.totalAccess);
  cell.meanRevisit =
    cell.revisitCount > 0 ? cell.revisitGapTotal / cell.revisitCount : 0.0;
  cell.meanResponse =
    response_gap_count > 0 ? response_gap_sum / response_gap_count : 0.0;
}

struct CoverageStatistics {
  size_t totalCells = 0;
  int accessedCells = 0;
  int multiAccessCells = 0;
  size_t activeSensorCount = 0;
  size_t swathCount = 0;
  uint32_t totalWindows = 0;
  int totalIntervalCount = 0;
  int totalRevisitCount = 0;
  double totalAccessDurationSec = 0.0;
  double totalGapDurationSec = 0.0;
  double maxGapDurationSec = 0.0;
  double meanRevisitTimeSec = 0.0;
  double maxResponseTimeSec = 0.0;
  double meanResponseTimeSec = 0.0;
  double percentCoverage = 0.0;
};

CoverageStatistics coverage_statistics(
    const std::vector<Cell>& cells,
    size_t active_sensor_count,
    size_t swath_count,
    uint32_t total_windows) {
  CoverageStatistics statistics{};
  statistics.totalCells = cells.size();
  statistics.activeSensorCount = active_sensor_count;
  statistics.swathCount = swath_count;
  statistics.totalWindows = total_windows;
  double revisit_gap_total = 0.0;
  double response_sum = 0.0;
  for (const auto& cell : cells) {
    statistics.totalIntervalCount += cell.accessCount;
    statistics.totalRevisitCount += cell.revisitCount;
    statistics.totalGapDurationSec += cell.totalGap;
    statistics.maxGapDurationSec = std::max(statistics.maxGapDurationSec, cell.maxGap);
    revisit_gap_total += cell.revisitGapTotal;
    statistics.maxResponseTimeSec = std::max(statistics.maxResponseTimeSec, cell.maxResponse);
    response_sum += cell.meanResponse;
    if (cell.accessCount > 0) {
      ++statistics.accessedCells;
    }
    statistics.totalAccessDurationSec += cell.totalAccess;
    if (cell.contributingSensorIds.size() > 1) {
      ++statistics.multiAccessCells;
    }
  }
  statistics.meanRevisitTimeSec = statistics.totalRevisitCount > 0
    ? revisit_gap_total / static_cast<double>(statistics.totalRevisitCount)
    : 0.0;
  statistics.meanResponseTimeSec = cells.empty()
    ? 0.0
    : response_sum / static_cast<double>(cells.size());
  statistics.percentCoverage = cells.empty()
    ? 0.0
    : 100.0 * static_cast<double>(statistics.accessedCells) / static_cast<double>(cells.size());
  return statistics;
}

uint32_t statistics_count(size_t value) {
  return value > static_cast<size_t>(std::numeric_limits<uint32_t>::max())
    ? std::numeric_limits<uint32_t>::max()
    : static_cast<uint32_t>(value);
}

uint32_t statistics_count(int value) {
  return value < 0 ? 0u : statistics_count(static_cast<size_t>(value));
}

uint8_t coverage_alpha_byte(double alpha) {
  const double clamped = std::max(0.0, std::min(1.0, alpha));
  return static_cast<uint8_t>(std::round(255.0 * clamped));
}

void write_rgba(
    std::vector<uint8_t>& values,
    size_t offset,
    uint8_t red,
    uint8_t green,
    uint8_t blue,
    uint8_t alpha) {
  if (offset + 3 >= values.size()) {
    return;
  }
  values[offset] = red;
  values[offset + 1] = green;
  values[offset + 2] = blue;
  values[offset + 3] = alpha;
}

size_t raster_texture_cell_rgba_offset(const Cell& cell, const GridConfig& grid) {
  const int texture_row = std::max(0, grid.rows - 1 - cell.row);
  const int texture_column = std::max(0, cell.column);
  return static_cast<size_t>(
    (texture_row * std::max(1, grid.columns) + texture_column) * 4);
}

void pass_count_rgba(uint32_t pass_count, uint8_t rgba[4]) {
  if (pass_count == 0u) {
    rgba[0] = 0u;
    rgba[1] = 0u;
    rgba[2] = 0u;
    rgba[3] = 0u;
    return;
  }
  struct Stop {
    uint32_t count;
    uint8_t red;
    uint8_t green;
    uint8_t blue;
    uint8_t alpha;
  };
  static constexpr Stop kStops[] = {
    {1u, 96u, 165u, 250u, 190u},
    {5u, 45u, 212u, 191u, 195u},
    {20u, 74u, 222u, 128u, 200u},
    {50u, 250u, 204u, 21u, 210u},
    {100u, 249u, 115u, 22u, 220u},
    {200u, 239u, 68u, 68u, 225u},
    {300u, 217u, 70u, 239u, 230u},
  };
  const Stop* selected = &kStops[0];
  for (const auto& stop : kStops) {
    if (pass_count >= stop.count) {
      selected = &stop;
    }
  }
  rgba[0] = selected->red;
  rgba[1] = selected->green;
  rgba[2] = selected->blue;
  rgba[3] = selected->alpha;
}

void current_access_rgba(double percent_coverage, uint8_t rgba[4]) {
  const double t = std::max(0.0, std::min(1.0, percent_coverage / 100.0));
  rgba[0] = static_cast<uint8_t>(std::round(47.0 + (255.0 - 47.0) * t));
  rgba[1] = static_cast<uint8_t>(std::round(119.0 + (35.0 - 119.0) * t));
  rgba[2] = static_cast<uint8_t>(std::round(255.0 + (20.0 - 255.0) * t));
  rgba[3] = coverage_alpha_byte(0.70);
}

struct ModuleOutputAllocation {
  uint32_t ptr = 0;
  uint32_t size = 0;
};

std::vector<ModuleOutputAllocation> g_retained_output_allocations;

template <typename T>
bool append_shared_memory_region(
    flatbuffers::FlatBufferBuilder& builder,
    const std::vector<T>& values,
    uint32_t region_id,
    uint32_t record_index,
    const char* region_key,
    std::vector<flatbuffers::Offset<SCVMemoryRegion>>& regions,
    std::vector<ModuleOutputAllocation>& allocations,
    std::string* error) {
  if (values.empty()) {
    if (error) {
      *error = std::string("Cannot create empty SCV memory region for ") + region_key + ".";
    }
    return false;
  }
  const size_t byte_length = values.size() * sizeof(T);
  if (byte_length > static_cast<size_t>(std::numeric_limits<uint32_t>::max())) {
    if (error) {
      *error = std::string("SCV memory region exceeds SDK allocator range for ") + region_key + ".";
    }
    return false;
  }
  const uint32_t byte_length_u32 = static_cast<uint32_t>(byte_length);
  const uint32_t ptr = plugin_alloc(byte_length_u32);
  if (ptr == 0u) {
    if (error) {
      *error = std::string("plugin_alloc failed for SCV memory region ") + region_key + ".";
    }
    return false;
  }
  const uint32_t declared_alignment =
    std::max<uint32_t>(4u, static_cast<uint32_t>(alignof(T)));
  if (ptr % declared_alignment != 0u) {
    plugin_free(ptr, byte_length_u32);
    if (error) {
      *error = std::string("plugin_alloc returned misaligned SCV memory region ") + region_key + ".";
    }
    return false;
  }
  std::memcpy(
    reinterpret_cast<void*>(static_cast<uintptr_t>(ptr)),
    values.data(),
    byte_length);
  allocations.push_back(ModuleOutputAllocation{ptr, byte_length_u32});
  regions.push_back(CreateSCVMemoryRegionDirect(
    builder,
    region_id,
    record_index,
    region_key,
    static_cast<uint64_t>(ptr),
    static_cast<uint64_t>(byte_length),
    static_cast<uint32_t>(sizeof(T)),
    declared_alignment,
    true,
    false));
  return true;
}

void free_module_output_allocations(
    const std::vector<ModuleOutputAllocation>& allocations) {
  for (const auto& allocation : allocations) {
    if (allocation.ptr != 0u && allocation.size != 0u) {
      plugin_free(allocation.ptr, allocation.size);
    }
  }
}

void release_retained_output_allocations() {
  free_module_output_allocations(g_retained_output_allocations);
  g_retained_output_allocations.clear();
}

// Serialize one SCVTargetResult per target, in target-index order (byte-
// identical for any worker count). INTERVAL_START/STOP_SEC are window-relative
// seconds (0 = window start = grid.start), the same frame as the TIME_GRID.
// Rejected targets fall through with zero intervals (fail-closed).
std::vector<::flatbuffers::Offset<SCVTargetResult>> build_target_results(
    flatbuffers::FlatBufferBuilder& builder,
    const std::vector<TargetAccumulator>& targets,
    double window_start_seconds) {
  std::vector<::flatbuffers::Offset<SCVTargetResult>> target_results;
  target_results.reserve(targets.size());
  for (const auto& target : targets) {
    const Cell& cell = target.cell;
    std::vector<double> interval_start_sec;
    std::vector<double> interval_stop_sec;
    interval_start_sec.reserve(cell.intervals.size());
    interval_stop_sec.reserve(cell.intervals.size());
    for (const auto& interval : cell.intervals) {
      interval_start_sec.push_back(interval.start - window_start_seconds);
      interval_stop_sec.push_back(interval.stop - window_start_seconds);
    }
    const std::vector<uint32_t> pass_start_buckets = cell.passStartBuckets;
    target_results.push_back(CreateSCVTargetResultDirect(
      builder,
      target.targetId,
      target.name.empty() ? nullptr : target.name.c_str(),
      static_cast<uint32_t>(std::max(0, cell.accessCount)),
      static_cast<uint32_t>(std::max(0, cell.revisitCount)),
      cell.totalAccess,
      cell.meanRevisit,
      cell.maxGap,
      &interval_start_sec,
      &interval_stop_sec,
      &pass_start_buckets,
      nullptr));  // ACCESS_BITSET optional — omitted in Phase 1.
  }
  return target_results;
}

// targets_only result: only TARGET_RESULTS (+ time grid / body / status /
// message). No raster products, no packed geometry — the cheap target-only
// recompute path of the PHASE-1 INTEGRATION CONTRACT.
std::vector<uint8_t> build_scv_targets_only_result(
    const GridConfig& grid,
    const std::vector<TargetAccumulator>& targets,
    uint32_t total_windows,
    const std::string& message) {
  flatbuffers::FlatBufferBuilder builder(1024);
  const auto time_grid = CreateSCVTimeGridDirect(
    builder,
    grid.epochIso.empty() ? nullptr : grid.epochIso.c_str(),
    grid.epochJulianDate,
    grid.start,
    grid.stop,
    grid.step,
    grid.gridIndexStart,
    grid.gridIndexCount);
  const auto target_body = CreateSCVEllipsoidDirect(
    builder,
    scvBodyKind_EARTH,
    "Earth",
    kEarthRadiusM,
    6356752.314245,
    kEarthRadiusM,
    scvCoordinateFrame_BODY_FIXED);
  const auto target_results = build_target_results(builder, targets, grid.start);
  const auto result = CreateSCVResultDirect(
    builder,
    "sensor-coverage-analysis",
    0,
    scvResultState_OK,
    time_grid,
    target_body,
    0,
    total_windows,
    nullptr,
    nullptr,
    0,
    0,
    message.c_str(),
    0,
    target_results.empty() ? nullptr : &target_results);
  const auto envelope = CreateSCV(
    builder,
    scvEnvelopeKind_RESULT,
    0,
    0,
    0,
    result,
    0);
  FinishSCVBuffer(builder, envelope);
  const uint8_t* begin = builder.GetBufferPointer();
  return std::vector<uint8_t>(begin, begin + builder.GetSize());
}

std::vector<uint8_t> build_scv_result(
    const GridConfig& grid,
    const std::vector<SensorTrack>& tracks,
    const std::vector<Cell>& cells,
    const std::vector<SwathSegment>& swaths,
    uint32_t total_windows,
    const CoverageStatistics& statistics,
    const std::vector<scvMetricSeriesKind>& requested_products,
    bool include_geometry,
    const std::string& message,
    const std::vector<TargetAccumulator>& targets,
    std::string* error = nullptr) {
  flatbuffers::FlatBufferBuilder builder(4096);
  std::vector<ModuleOutputAllocation> output_allocations;
  std::vector<float> raster_percent_coverage;
  std::vector<uint32_t> raster_pass_count;
  std::vector<uint32_t> raster_bucket_pass_start_count;
  std::vector<uint8_t> raster_pass_count_rgba;
  std::vector<float> raster_contact_duration;
  std::vector<float> raster_revisit;
  std::vector<float> raster_gap;
  std::vector<float> raster_redundancy;
  std::vector<double> raster_latitude_band_coverage;
  std::vector<uint32_t> raster_current_access_bitset;
  std::vector<uint8_t> raster_current_access_rgba;
  std::vector<uint32_t> raster_bucket_active_cell_count;

  const double duration = std::max(0.0, grid.stop - grid.start);
  const uint32_t raster_cell_count = statistics_count(cells.size());
  const uint32_t raster_bucket_count = total_windows;
  const uint32_t raster_words_per_bucket = std::max(
    1u,
    (raster_cell_count + 31u) / 32u);
  // CURRENT_ACCESS_RGBA is a direct-texture visual product scaling as
  // buckets x cells x 4 bytes. Fine grids push it past what plugin_alloc
  // can provide (60 km GSD x 12 h / 15 s buckets = 1.6 GB) while shipped
  // renderers rebuild colors from CURRENT_ACCESS_BITSET + PASS_COUNT and
  // never sample a texture that large. Emit it only while texture-sized;
  // past the cap the band is simply absent from the raster products.
  constexpr size_t kMaxCurrentAccessRgbaBytes = 128ull * 1024ull * 1024ull;
  const size_t current_access_rgba_bytes =
    static_cast<size_t>(raster_bucket_count) * raster_cell_count * 4u;
  const bool emit_current_access_rgba =
    current_access_rgba_bytes > 0 &&
    current_access_rgba_bytes <= kMaxCurrentAccessRgbaBytes;
  std::vector<double> raster_cell_bounds;
  raster_cell_bounds.reserve(cells.size() * 4);
  std::vector<double> raster_cell_centers;
  raster_cell_centers.reserve(cells.size() * 2);
  std::vector<double> raster_bucket_start_seconds;
  raster_bucket_start_seconds.reserve(raster_bucket_count);
  std::vector<double> raster_bucket_stop_seconds;
  raster_bucket_stop_seconds.reserve(raster_bucket_count);
  const double raster_step = grid.step;
  for (uint32_t bucket_index = 0; bucket_index < raster_bucket_count; ++bucket_index) {
    const double bucket_start =
      grid.start + static_cast<double>(bucket_index) * raster_step;
    raster_bucket_start_seconds.push_back(bucket_start);
    raster_bucket_stop_seconds.push_back(std::min(bucket_start + raster_step, grid.stop));
  }
  auto ensure_float_raster = [](std::vector<float>& values, size_t size) {
    if (values.empty()) {
      values.assign(size, 0.0f);
    }
  };
  auto ensure_uint_raster = [](std::vector<uint32_t>& values, size_t size) {
    if (values.empty()) {
      values.assign(size, 0u);
    }
  };
  auto ensure_byte_raster = [](std::vector<uint8_t>& values, size_t size) {
    if (values.empty()) {
      values.assign(size, 0u);
    }
  };
  for (const auto& cell : cells) {
    raster_cell_bounds.push_back(cell.bounds.minLongitudeDeg);
    raster_cell_bounds.push_back(cell.bounds.minLatitudeDeg);
    raster_cell_bounds.push_back(cell.bounds.maxLongitudeDeg);
    raster_cell_bounds.push_back(cell.bounds.maxLatitudeDeg);
    raster_cell_centers.push_back(cell.longitude);
    raster_cell_centers.push_back(cell.latitude);
    const double coverage_fraction = duration > 0.0 ? cell.totalAccess / duration : 0.0;
    const size_t cell_index = static_cast<size_t>(std::max(cell.index, 0));
    if (metric_product_requested(requested_products, scvMetricSeriesKind_PERCENT_COVERED)) {
      ensure_float_raster(raster_percent_coverage, cells.size());
      raster_percent_coverage[cell_index] = static_cast<float>(coverage_fraction * 100.0);
    }
    if (metric_product_requested(requested_products, scvMetricSeriesKind_ACCESS_COUNT)) {
      ensure_uint_raster(raster_pass_count, cells.size());
      raster_pass_count[cell_index] = statistics_count(cell.accessCount);
      ensure_byte_raster(raster_pass_count_rgba, cells.size() * 4u);
      uint8_t pass_rgba[4] = {};
      pass_count_rgba(raster_pass_count[cell_index], pass_rgba);
      write_rgba(
        raster_pass_count_rgba,
        raster_texture_cell_rgba_offset(cell, grid),
        pass_rgba[0],
        pass_rgba[1],
        pass_rgba[2],
        pass_rgba[3]);
      ensure_uint_raster(
        raster_current_access_bitset,
        static_cast<size_t>(raster_bucket_count) * raster_words_per_bucket);
      ensure_uint_raster(
        raster_bucket_pass_start_count,
        static_cast<size_t>(raster_bucket_count) * raster_cell_count);
      for (const uint32_t pass_start_bucket : cell.passStartBuckets) {
        if (pass_start_bucket < raster_bucket_count) {
          ++raster_bucket_pass_start_count[
            static_cast<size_t>(pass_start_bucket) * raster_cell_count +
              cell_index];
        }
      }
      if (emit_current_access_rgba) {
        ensure_byte_raster(
          raster_current_access_rgba,
          current_access_rgba_bytes);
      }
      ensure_uint_raster(raster_bucket_active_cell_count, raster_bucket_count);
      if (raster_bucket_count > 0 && raster_step > 0.0) {
        for (const auto& interval : cell.intervals) {
          const double interval_start = std::max(interval.start, grid.start);
          const double interval_stop = std::min(interval.stop, grid.stop);
          if (interval_stop < interval_start) {
            continue;
          }
          const auto containing_window = [&](double elapsed_seconds) {
            if (elapsed_seconds >= grid.stop) {
              return raster_bucket_count - 1u;
            }
            return static_cast<uint32_t>(clamp(
              std::floor((elapsed_seconds - grid.start) / raster_step),
              0.0,
              static_cast<double>(raster_bucket_count - 1u)));
          };
          const uint32_t first_window = containing_window(interval_start);
          const uint32_t last_window = containing_window(interval_stop);
          if (first_window > last_window) {
            continue;
          }
          for (uint32_t window_index = first_window; window_index <= last_window; ++window_index) {
            const double window_start =
              grid.start + static_cast<double>(window_index) * raster_step;
            const double window_stop = std::min(window_start + raster_step, grid.stop);
            const bool positive_duration_overlap =
              interval_stop > interval_start &&
              interval_stop >= window_start &&
              interval_start < window_stop;
            const bool singleton_in_window =
              interval_stop == interval_start &&
              window_index == first_window;
            if (!positive_duration_overlap && !singleton_in_window) {
              continue;
            }
            const uint32_t word_index =
              window_index * raster_words_per_bucket +
              static_cast<uint32_t>(cell_index / 32u);
            const uint32_t mask = 1u << static_cast<uint32_t>(cell_index % 32u);
            if ((raster_current_access_bitset[word_index] & mask) == 0u) {
              raster_current_access_bitset[word_index] |= mask;
              ++raster_bucket_active_cell_count[window_index];
              if (emit_current_access_rgba) {
                uint8_t access_rgba[4] = {};
                current_access_rgba(coverage_fraction * 100.0, access_rgba);
                write_rgba(
                  raster_current_access_rgba,
                  static_cast<size_t>(window_index) * raster_cell_count * 4u +
                    raster_texture_cell_rgba_offset(cell, grid),
                  access_rgba[0],
                  access_rgba[1],
                  access_rgba[2],
                  access_rgba[3]);
              }
            }
          }
        }
      }
    }
    if (metric_product_requested(requested_products, scvMetricSeriesKind_CONTACT_DURATION_SECONDS)) {
      ensure_float_raster(raster_contact_duration, cells.size());
      raster_contact_duration[cell_index] = static_cast<float>(cell.totalAccess);
    }
    if (metric_product_requested(requested_products, scvMetricSeriesKind_REVISIT_SECONDS)) {
      ensure_float_raster(raster_revisit, cells.size());
      raster_revisit[cell_index] = static_cast<float>(cell.meanRevisit);
    }
    if (metric_product_requested(requested_products, scvMetricSeriesKind_GAP_SECONDS)) {
      ensure_float_raster(raster_gap, cells.size());
      raster_gap[cell_index] = static_cast<float>(cell.maxGap);
    }
    if (metric_product_requested(requested_products, scvMetricSeriesKind_REDUNDANCY)) {
      ensure_float_raster(raster_redundancy, cells.size());
      raster_redundancy[cell_index] =
        static_cast<float>(cell.contributingSensorIds.size());
    }
  }

  if (metric_product_requested(requested_products, scvMetricSeriesKind_LATITUDE_BAND_COVERAGE)) {
    raster_latitude_band_coverage.reserve(static_cast<size_t>(std::max(0, grid.rows)) * 6u);
    for (int row = 0; row < grid.rows; ++row) {
      int row_cell_count = 0;
      int covered_cell_count = 0;
      double revisit_sum = 0.0;
      double max_gap = 0.0;
      double redundancy_sum = 0.0;
      for (const auto& cell : cells) {
        if (cell.row != row) {
          continue;
        }
        ++row_cell_count;
        if (cell.accessCount > 0) {
          ++covered_cell_count;
        }
        revisit_sum += cell.meanRevisit;
        max_gap = std::max(max_gap, cell.maxGap);
        redundancy_sum += static_cast<double>(cell.contributingSensorIds.size());
      }
      const double coverage_fraction = row_cell_count > 0
        ? static_cast<double>(covered_cell_count) / static_cast<double>(row_cell_count)
        : 0.0;
      const double mean_revisit = row_cell_count > 0
        ? revisit_sum / static_cast<double>(row_cell_count)
        : 0.0;
      const double mean_redundancy = row_cell_count > 0
        ? redundancy_sum / static_cast<double>(row_cell_count)
        : 0.0;
      const double min_lat = grid.minLat + static_cast<double>(row) * grid.latStep;
      const double max_lat = std::min(grid.maxLat, min_lat + grid.latStep);
      raster_latitude_band_coverage.push_back(min_lat);
      raster_latitude_band_coverage.push_back(max_lat);
      raster_latitude_band_coverage.push_back(coverage_fraction);
      raster_latitude_band_coverage.push_back(mean_revisit);
      raster_latitude_band_coverage.push_back(max_gap);
      raster_latitude_band_coverage.push_back(mean_redundancy);
    }
  }

  flatbuffers::Offset<SCVPackedGeometryChunk> geometry = 0;
  if (include_geometry) {
    std::vector<float> positions;
    positions.reserve(swaths.size() * 12);
    std::vector<float> normals;
    normals.reserve(swaths.size() * 12);
    std::vector<float> texture_coordinates;
    texture_coordinates.reserve(swaths.size() * 8);
    std::vector<float> reveal_coords;
    reveal_coords.reserve(swaths.size() * 8);
    std::vector<uint32_t> indices;
    indices.reserve(swaths.size() * 6);
    std::vector<uint32_t> segment_ids;
    segment_ids.reserve(swaths.size());
    std::vector<uint32_t> geometry_sensor_ids;
    geometry_sensor_ids.reserve(swaths.size());
    std::vector<flatbuffers::Offset<SCVSwathSegment>> geometry_segments;
    geometry_segments.reserve(swaths.size());
    for (size_t index = 0; index < swaths.size(); ++index) {
      const auto& segment = swaths[index];
      const uint32_t vertex_offset = static_cast<uint32_t>(index * 4);
      const uint32_t index_offset = static_cast<uint32_t>(index * 6);
      const double duration = std::max(grid.stop - grid.start, 0.001);
      const double start_s = clamp((segment.start - grid.start) / duration, 0.0, 1.0);
      const double stop_s = clamp((segment.stop - grid.start) / duration, 0.0, 1.0);
      auto push_vertex = [&](const Vertex& vertex, double s, double t) {
        const Cartographic cartographic{
          vertex.longitudeDeg / kRadiansToDegrees,
          vertex.latitudeDeg / kRadiansToDegrees,
          kCoverageSwathRenderAltitudeM,
        };
        const Vec3 position = geodetic_to_ecef(cartographic);
        const Vec3 normal = geodetic_surface_normal(position);
        positions.push_back(static_cast<float>(position.x));
        positions.push_back(static_cast<float>(position.y));
        positions.push_back(static_cast<float>(position.z));
        normals.push_back(static_cast<float>(normal.x));
        normals.push_back(static_cast<float>(normal.y));
        normals.push_back(static_cast<float>(normal.z));
        texture_coordinates.push_back(static_cast<float>(s));
        texture_coordinates.push_back(static_cast<float>(t));
        reveal_coords.push_back(static_cast<float>(vertex.longitudeDeg));
        reveal_coords.push_back(static_cast<float>(vertex.latitudeDeg));
      };
      push_vertex(segment.leftStart, start_s, 0.0);
      push_vertex(segment.leftStop, stop_s, 0.0);
      push_vertex(segment.rightStop, stop_s, 1.0);
      push_vertex(segment.rightStart, start_s, 1.0);
      indices.push_back(vertex_offset);
      indices.push_back(vertex_offset + 1);
      indices.push_back(vertex_offset + 2);
      indices.push_back(vertex_offset);
      indices.push_back(vertex_offset + 2);
      indices.push_back(vertex_offset + 3);

      const uint32_t segment_id = static_cast<uint32_t>(std::max(segment.index, 0));
      const uint32_t sensor_id = static_cast<uint32_t>(std::max(segment.sensorId, 0));
      segment_ids.push_back(segment_id);
      geometry_sensor_ids.push_back(sensor_id);
      const std::vector<uint32_t> segment_sensor_ids{sensor_id};
      geometry_segments.push_back(CreateSCVSwathSegmentDirect(
        builder,
        segment_id,
        sensor_id,
        segment_id,
        scvGeometryDomain_SURFACE,
        scvCoordinateFrame_BODY_FIXED,
        segment.start,
        segment.stop,
        vertex_offset,
        4,
        index_offset,
        6,
        &segment_sensor_ids));
    }

    std::vector<flatbuffers::Offset<SCVMemoryRegion>> geometry_memory_regions;
    geometry_memory_regions.reserve(5);
    if (
      !append_shared_memory_region(
        builder,
        positions,
        kGeometryPositionsRegionId,
        0,
        "geometry.positions.float32",
        geometry_memory_regions,
        output_allocations,
        error) ||
      !append_shared_memory_region(
        builder,
        normals,
        kGeometryNormalsRegionId,
        0,
        "geometry.normals.float32",
        geometry_memory_regions,
        output_allocations,
        error) ||
      !append_shared_memory_region(
        builder,
        texture_coordinates,
        kGeometryStRegionId,
        0,
        "geometry.st.float32",
        geometry_memory_regions,
        output_allocations,
        error) ||
      !append_shared_memory_region(
        builder,
        reveal_coords,
        kGeometryRevealCoordsRegionId,
        0,
        "geometry.reveal_coords.float32",
        geometry_memory_regions,
        output_allocations,
        error) ||
      !append_shared_memory_region(
        builder,
        indices,
        kGeometryIndicesRegionId,
        0,
        "geometry.indices.uint32",
        geometry_memory_regions,
        output_allocations,
        error)
    ) {
      free_module_output_allocations(output_allocations);
      return {};
    }

    geometry = CreateSCVPackedGeometryChunkDirect(
      builder,
      "sensor-coverage-analysis",
      0,
      0,
      0,
      static_cast<uint32_t>(swaths.size()),
      scvGeometryDomain_SURFACE,
      scvCoordinateFrame_BODY_FIXED,
      scvGeometryEncoding_SHARED_MEMORY_OFFSET,
      grid.start,
      grid.stop,
      &geometry_memory_regions,
      kGeometryPositionsRegionId,
      0,
      kGeometryNormalsRegionId,
      0,
      kGeometryStRegionId,
      0,
      kGeometryRevealCoordsRegionId,
      0,
      kGeometryIndicesRegionId,
      0,
      nullptr,
      nullptr,
      nullptr,
      nullptr,
      nullptr,
      &segment_ids,
      &geometry_sensor_ids,
      &geometry_segments);
  }

  const auto time_grid = CreateSCVTimeGridDirect(
    builder,
    grid.epochIso.empty() ? nullptr : grid.epochIso.c_str(),
    grid.epochJulianDate,
    grid.start,
    grid.stop,
    grid.step,
    grid.gridIndexStart,
    grid.gridIndexCount);
  const auto target_body = CreateSCVEllipsoidDirect(
    builder,
    scvBodyKind_EARTH,
    "Earth",
    kEarthRadiusM,
    6356752.314245,
    kEarthRadiusM,
    scvCoordinateFrame_BODY_FIXED);
  const auto raster_grid = CreateSCVCoverageGridDirect(
    builder,
    "coverage-grid",
    scvGeometryDomain_SURFACE,
    scvCoordinateFrame_BODY_FIXED,
    grid.minLat,
    grid.maxLat,
    grid.minLon,
    grid.maxLon,
    grid.latStep,
    grid.lonStep,
    0.0,
    raster_cell_count,
    std::max(grid.latStep, grid.lonStep));
  std::vector<flatbuffers::Offset<SCVPackedRasterBand>> raster_bands;
  raster_bands.reserve(15);
  std::vector<flatbuffers::Offset<SCVMemoryRegion>> raster_memory_regions;
  raster_memory_regions.reserve(15);
  uint32_t next_raster_region_id = kRasterRegionBaseId;
  auto push_float32_band = [&](
      scvRasterProductKind product_kind,
      scvMetricSeriesKind metric_kind,
      const std::vector<float>& values) -> bool {
    if (values.empty()) {
      return true;
    }
    const uint32_t region_id = next_raster_region_id++;
    const std::string region_key =
      std::string("raster.float32.") + std::to_string(static_cast<int>(product_kind));
    if (!append_shared_memory_region(
        builder,
        values,
        region_id,
        0,
        region_key.c_str(),
        raster_memory_regions,
        output_allocations,
        error)) {
      return false;
    }
    raster_bands.push_back(CreateSCVPackedRasterBandDirect(
      builder,
      product_kind,
      metric_kind,
      scvRasterProductEncoding_FLOAT32,
      1,
      raster_cell_count,
      0,
      0,
      region_id,
      0,
      nullptr,
      nullptr,
      nullptr));
    return true;
  };
  auto push_uint8_band = [&](
      scvRasterProductKind product_kind,
      scvMetricSeriesKind metric_kind,
      const std::vector<uint8_t>& values,
      uint32_t components_per_cell,
      uint32_t bucket_count) -> bool {
    if (values.empty()) {
      return true;
    }
    const uint32_t region_id = next_raster_region_id++;
    const std::string region_key =
      std::string("raster.uint8.") + std::to_string(static_cast<int>(product_kind));
    if (!append_shared_memory_region(
        builder,
        values,
        region_id,
        0,
        region_key.c_str(),
        raster_memory_regions,
        output_allocations,
        error)) {
      return false;
    }
    raster_bands.push_back(CreateSCVPackedRasterBandDirect(
      builder,
      product_kind,
      metric_kind,
      scvRasterProductEncoding_UINT8,
      components_per_cell,
      raster_cell_count,
      bucket_count,
      0,
      region_id,
      0,
      nullptr,
      nullptr,
      nullptr));
    return true;
  };
  auto push_uint32_band = [&](
      scvRasterProductKind product_kind,
      scvMetricSeriesKind metric_kind,
      const std::vector<uint32_t>& values,
      uint32_t bucket_count,
      uint32_t words_per_bucket) -> bool {
    if (values.empty()) {
      return true;
    }
    const uint32_t region_id = next_raster_region_id++;
    const std::string region_key =
      std::string("raster.uint32.") + std::to_string(static_cast<int>(product_kind));
    if (!append_shared_memory_region(
        builder,
        values,
        region_id,
        0,
        region_key.c_str(),
        raster_memory_regions,
        output_allocations,
        error)) {
      return false;
    }
    raster_bands.push_back(CreateSCVPackedRasterBandDirect(
      builder,
      product_kind,
      metric_kind,
      words_per_bucket > 0
        ? scvRasterProductEncoding_BITSET_UINT32
        : scvRasterProductEncoding_UINT32,
      1,
      raster_cell_count,
      bucket_count,
      words_per_bucket,
      region_id,
      0,
      nullptr,
      nullptr,
      nullptr));
    return true;
  };
  auto push_float64_band = [&](
      scvRasterProductKind product_kind,
      scvMetricSeriesKind metric_kind,
      const std::vector<double>& values,
      uint32_t components_per_cell,
      uint32_t cell_count,
      uint32_t bucket_count,
      uint32_t words_per_bucket) -> bool {
    if (values.empty()) {
      return true;
    }
    const uint32_t region_id = next_raster_region_id++;
    const std::string region_key =
      std::string("raster.float64.") + std::to_string(static_cast<int>(product_kind));
    if (!append_shared_memory_region(
        builder,
        values,
        region_id,
        0,
        region_key.c_str(),
        raster_memory_regions,
        output_allocations,
        error)) {
      return false;
    }
    raster_bands.push_back(CreateSCVPackedRasterBandDirect(
      builder,
      product_kind,
      metric_kind,
      scvRasterProductEncoding_FLOAT64,
      components_per_cell,
      cell_count,
      bucket_count,
      words_per_bucket,
      region_id,
      0,
      nullptr,
      nullptr,
      nullptr));
    return true;
  };
  if (
    !push_float64_band(
      scvRasterProductKind_CELL_BOUNDS_DEG,
      scvMetricSeriesKind_PERCENT_COVERED,
      raster_cell_bounds,
      4,
      raster_cell_count,
      0,
      0) ||
    !push_float64_band(
      scvRasterProductKind_CELL_CENTERS_DEG,
      scvMetricSeriesKind_PERCENT_COVERED,
      raster_cell_centers,
      2,
      raster_cell_count,
      0,
      0) ||
    !push_float32_band(
      scvRasterProductKind_PERCENT_COVERAGE,
      scvMetricSeriesKind_PERCENT_COVERED,
      raster_percent_coverage) ||
    !push_uint32_band(
      scvRasterProductKind_PASS_COUNT,
      scvMetricSeriesKind_ACCESS_COUNT,
      raster_pass_count,
      0,
      0) ||
    !push_uint32_band(
      scvRasterProductKind_BUCKET_PASS_START_COUNT,
      scvMetricSeriesKind_ACCESS_COUNT,
      raster_bucket_pass_start_count,
      raster_bucket_count,
      0) ||
    !push_uint8_band(
      scvRasterProductKind_PASS_COUNT_RGBA,
      scvMetricSeriesKind_ACCESS_COUNT,
      raster_pass_count_rgba,
      4,
      0) ||
    !push_float32_band(
      scvRasterProductKind_CONTACT_DURATION_SECONDS,
      scvMetricSeriesKind_CONTACT_DURATION_SECONDS,
      raster_contact_duration) ||
    !push_float32_band(
      scvRasterProductKind_REVISIT_SECONDS,
      scvMetricSeriesKind_REVISIT_SECONDS,
      raster_revisit) ||
    !push_float32_band(
      scvRasterProductKind_GAP_SECONDS,
      scvMetricSeriesKind_GAP_SECONDS,
      raster_gap) ||
    !push_float32_band(
      scvRasterProductKind_REDUNDANCY,
      scvMetricSeriesKind_REDUNDANCY,
      raster_redundancy) ||
    !push_float64_band(
      scvRasterProductKind_BUCKET_START_SECONDS,
      scvMetricSeriesKind_ACCESS_COUNT,
      raster_bucket_start_seconds,
      1,
      raster_cell_count,
      raster_bucket_count,
      0) ||
    !push_float64_band(
      scvRasterProductKind_BUCKET_STOP_SECONDS,
      scvMetricSeriesKind_ACCESS_COUNT,
      raster_bucket_stop_seconds,
      1,
      raster_cell_count,
      raster_bucket_count,
      0) ||
    !push_float64_band(
      scvRasterProductKind_LATITUDE_BAND_COVERAGE,
      scvMetricSeriesKind_LATITUDE_BAND_COVERAGE,
      raster_latitude_band_coverage,
      6,
      statistics_count(std::max(0, grid.rows)),
      0,
      0) ||
    !push_uint32_band(
      scvRasterProductKind_CURRENT_ACCESS_BITSET,
      scvMetricSeriesKind_ACCESS_COUNT,
      raster_current_access_bitset,
      raster_bucket_count,
      raster_words_per_bucket) ||
    (emit_current_access_rgba &&
      !push_uint8_band(
        scvRasterProductKind_CURRENT_ACCESS_RGBA,
        scvMetricSeriesKind_ACCESS_COUNT,
        raster_current_access_rgba,
        4,
        raster_bucket_count)) ||
    !push_uint32_band(
      scvRasterProductKind_BUCKET_ACTIVE_CELL_COUNT,
      scvMetricSeriesKind_ACCESS_COUNT,
      raster_bucket_active_cell_count,
      raster_bucket_count,
      0)
  ) {
    free_module_output_allocations(output_allocations);
    return {};
  }
  const auto raster_products = CreateSCVPackedRasterProductsDirect(
    builder,
    "sensor-coverage-analysis",
    0,
    raster_grid,
    time_grid,
    statistics_count(grid.rows),
    statistics_count(grid.columns),
    raster_cell_count,
    raster_bucket_count,
    raster_words_per_bucket,
    &raster_memory_regions,
    &raster_bands);
  const auto aggregate_statistics = CreateSCVAggregateStatistics(
    builder,
    statistics_count(statistics.totalCells),
    statistics_count(statistics.accessedCells),
    statistics_count(statistics.multiAccessCells),
    statistics_count(statistics.activeSensorCount),
    statistics_count(statistics.swathCount),
    statistics.totalWindows,
    statistics_count(statistics.totalIntervalCount),
    statistics_count(statistics.totalRevisitCount),
    statistics.totalAccessDurationSec,
    statistics.totalGapDurationSec,
    statistics.maxGapDurationSec,
    statistics.meanRevisitTimeSec,
    statistics.maxResponseTimeSec,
    statistics.meanResponseTimeSec,
    statistics.percentCoverage);
  const auto target_results = build_target_results(builder, targets, grid.start);
  const auto result = CreateSCVResultDirect(
    builder,
    "sensor-coverage-analysis",
    0,
    scvResultState_OK,
    time_grid,
    target_body,
    static_cast<uint32_t>(tracks.size()),
    total_windows,
    nullptr,
    nullptr,
    geometry,
    raster_products,
    message.c_str(),
    aggregate_statistics,
    target_results.empty() ? nullptr : &target_results);
  const auto envelope = CreateSCV(
    builder,
    scvEnvelopeKind_RESULT,
    0,
    0,
    0,
    result,
    0);
  FinishSCVBuffer(builder, envelope);

  const uint8_t* begin = builder.GetBufferPointer();
  g_retained_output_allocations = std::move(output_allocations);
  return std::vector<uint8_t>(begin, begin + builder.GetSize());
}

std::vector<uint8_t> build_scv_progress(
    const std::vector<SensorTrack>& tracks,
    uint32_t completed_windows,
    uint32_t total_windows) {
  flatbuffers::FlatBufferBuilder builder(256);
  const uint32_t total_sensors = static_cast<uint32_t>(tracks.size());
  const uint32_t backlog_remaining =
    completed_windows < total_windows ? total_windows - completed_windows : 0u;
  const double completion_fraction = total_windows > 0
    ? clamp(
        static_cast<double>(completed_windows) / static_cast<double>(total_windows),
        0.0,
        1.0)
    : 1.0;
  const auto progress = CreateSCVProgressDirect(
    builder,
    "sensor-coverage-analysis",
    0,
    scvResultState_OK,
    total_sensors,
    total_sensors,
    completed_windows,
    total_windows,
    backlog_remaining,
    completion_fraction,
    completed_windows >= total_windows
      ? "Sensor coverage complete."
      : "Sensor coverage in progress.");
  const auto envelope = CreateSCV(
    builder,
    scvEnvelopeKind_PROGRESS,
    0,
    progress,
    0,
    0,
    0);
  FinishSCVBuffer(builder, envelope);

  const uint8_t* begin = builder.GetBufferPointer();
  return std::vector<uint8_t>(begin, begin + builder.GetSize());
}

int emit_scv_progress_frame(
    const std::vector<SensorTrack>& tracks,
    uint32_t completed_windows,
    uint32_t total_windows) {
  const std::vector<uint8_t> scv_progress =
    build_scv_progress(tracks, completed_windows, total_windows);
  return emit_bytes(
    "coverage",
    "SCV/main.fbs",
    "$SCV",
    scv_progress.data(),
    static_cast<uint32_t>(scv_progress.size()));
}

}  // namespace

extern "C" int compute_sensor_coverage(void) {
  release_retained_output_allocations();
  plugin_reset_output_state();

  const std::string request_payload = payload_for_port("coverage");
  if (request_payload.empty()) {
    return fail("missing-coverage", "Input port \"coverage\" is required.");
  }

  CoverageInput input{};
  std::string parse_error;
  if (!parse_coverage_input(request_payload, input, parse_error)) {
    return fail("invalid-coverage", parse_error.c_str());
  }

  const GridConfig grid = input.grid;
  if (!(grid.stop > grid.start)) {
    return fail("invalid-time-span", "Coverage stopSeconds must be greater than startSeconds.");
  }

  const std::vector<SensorTrack>& tracks = input.tracks;
  if (tracks.empty()) {
    return fail("missing-states", "Coverage request must include at least two propagated sensor-owner states.");
  }

  // targets_only recompute (PHASE-1 INTEGRATION CONTRACT): accumulate ONLY the
  // targets and emit TARGET_RESULTS — no grid cell allocation, no accumulation,
  // no raster products, no swaths.
  if (input.targetsOnly) {
    accumulate_target_coverage_products(input.targets, tracks, grid);
    for (auto& target : input.targets) {
      update_cell_statistics(target.cell, grid, 0.0);
    }
    const std::vector<uint8_t> targets_only_result =
      build_scv_targets_only_result(
        grid,
        input.targets,
        grid.gridIndexCount,
        "sensor-coverage-analysis complete");
    return emit_bytes(
      "coverage",
      "SCV/main.fbs",
      "$SCV",
      targets_only_result.data(),
      static_cast<uint32_t>(targets_only_result.size()));
  }

  const std::string output_mode = "";
  const bool swath_preview_output =
    input.scvSwathOnly;
  const bool metric_product_output =
    !swath_preview_output &&
    !input.includePackedGeometry;

  const uint32_t total_windows = grid.gridIndexCount;
  const uint32_t progress_stride = std::max<uint32_t>(1, total_windows / 20);
  uint32_t completed_windows = 0;
  std::vector<FootprintSample> footprints;
  std::vector<SwathSegment> swaths;
  if (!metric_product_output) {
    for (const auto& track : tracks) {
      const std::vector<FootprintSample> track_footprints = compute_footprints(track.states, track.sensor);
      const std::vector<SwathSegment> track_swaths = build_swath_segments(track_footprints);
      footprints.insert(footprints.end(), track_footprints.begin(), track_footprints.end());
      for (auto segment : track_swaths) {
        segment.index = static_cast<int>(swaths.size());
        swaths.push_back(segment);
        completed_windows = std::min<uint32_t>(completed_windows + 1, total_windows);
        if (
          input.isScv &&
          completed_windows < total_windows &&
          (completed_windows == 1 || completed_windows % progress_stride == 0)
        ) {
          const int progress_status =
            emit_scv_progress_frame(tracks, completed_windows, total_windows);
          if (progress_status != 0) {
            return progress_status;
          }
        }
      }
    }
  }
  if (!metric_product_output && swaths.empty()) {
    return fail("empty-swath", "Sensor geometry did not intersect Earth over the sampled time span.");
  }

  std::vector<Cell>* cells = nullptr;
  if (!swath_preview_output) {
    cells = &cached_grid_cells_for(grid);
    if (metric_product_output) {
      accumulate_grid_coverage_products(*cells, tracks, grid);
    } else {
      accumulate_grid_coverage_products(*cells, tracks, swaths, grid);
    }
  }

  if (cells != nullptr) {
    for (auto& cell : *cells) {
      update_cell_statistics(cell, grid, 0.0);
    }
  }
  // Full run may also carry targets — compute them in the same invocation
  // (empty TARGETS is a zero-cost no-op inside accumulate_target_coverage_products).
  if (!input.targets.empty()) {
    accumulate_target_coverage_products(input.targets, tracks, grid);
    for (auto& target : input.targets) {
      update_cell_statistics(target.cell, grid, 0.0);
    }
  }
  const std::vector<Cell> empty_cells;
  const std::vector<Cell>& response_cells = cells == nullptr ? empty_cells : *cells;
  const CoverageStatistics statistics =
    coverage_statistics(response_cells, tracks.size(), swaths.size(), total_windows);
  const std::string scv_summary_message = "sensor-coverage-analysis complete";

  const std::vector<SwathSegment> empty_swaths;
  const std::vector<SwathSegment>& response_swaths =
    metric_product_output ? empty_swaths : swaths;

  const int progress_status =
    emit_scv_progress_frame(tracks, total_windows, total_windows);
  if (progress_status != 0) {
    return progress_status;
  }

  std::string result_error;
  const std::vector<uint8_t> scv_result =
    build_scv_result(
      grid,
      tracks,
      response_cells,
      response_swaths,
      total_windows,
      statistics,
      input.requestedProducts,
      input.includePackedGeometry,
      scv_summary_message,
      input.targets,
      &result_error);
  if (scv_result.empty() && !result_error.empty()) {
    return fail("coverage-output-regions", result_error.c_str());
  }
  return emit_bytes(
    "coverage",
    "SCV/main.fbs",
    "$SCV",
    scv_result.data(),
    static_cast<uint32_t>(scv_result.size()));
}
