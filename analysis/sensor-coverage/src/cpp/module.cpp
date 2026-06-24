#ifdef DOMAIN
#undef DOMAIN
#endif
#ifndef SDN_BUNDLED_SDS_CPP_HEADERS
#include "SCV/main_generated.h"
#endif

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <map>

using namespace sdn_hypersonics;

namespace {

// The module build concatenates these shared core files from symlinks in this
// directory before this source is compiled.
#if 0
#include "sensor_shape_model.h"
#include "sensor_shape_model.cpp.inc"
#endif

constexpr double kEarthRadiusM = 6378137.0;
constexpr double kWgs84A = 6378137.0;
constexpr double kWgs84B = 6356752.3142451793;
constexpr double kWgs84A2 = kWgs84A * kWgs84A;
constexpr double kWgs84B2 = kWgs84B * kWgs84B;
constexpr double kWgs84E2 = 1.0 - kWgs84B2 / kWgs84A2;
constexpr double kWgs84Ep2 = kWgs84A2 / kWgs84B2 - 1.0;
constexpr double kRadiansToDegrees = 180.0 / 3.14159265358979323846;
constexpr double kCoverageSwathRenderAltitudeM = 1200.0;
constexpr int kVisibilityTransitionRefinementIterations = 8;
constexpr size_t kGridCellCacheMaxEntries = 4;
constexpr int kGridTileRowSpan = 8;
constexpr int kGridTileColumnSpan = 8;
constexpr uint32_t kGeometryPositionsRegionId = 1;
constexpr uint32_t kGeometryNormalsRegionId = 2;
constexpr uint32_t kGeometryStRegionId = 3;
constexpr uint32_t kGeometryRevealCoordsRegionId = 4;
constexpr uint32_t kGeometryIndicesRegionId = 5;
constexpr uint32_t kRasterRegionBaseId = 1000;

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

struct Vertex {
  double latitudeDeg = 0.0;
  double longitudeDeg = 0.0;
};

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
  Vec3 samplePositions[5];
  Vec3 sampleNormals[5];
  int sampleCount = 0;
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
  double stop = 86400.0;
  int rows = 0;
  int columns = 0;
};

struct CachedGridCells {
  std::string key;
  std::vector<Cell> cells;
};

struct CoverageInput {
  GridConfig grid;
  std::vector<SensorTrack> tracks;
  std::vector<scvMetricSeriesKind> requestedProducts;
  bool isScv = false;
  bool includePackedGeometry = true;
  bool scvSwathOnly = false;
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

GridCellGeometry grid_cell_geometry(
    double latitude_deg,
    double longitude_deg,
    double latitude_step_deg,
    double longitude_step_deg) {
  GridCellGeometry geometry{};
  set_grid_cell_sample(geometry, 0, latitude_deg, longitude_deg);
  geometry.surfacePosition = geometry.samplePositions[0];
  geometry.surfaceNormal = geometry.sampleNormals[0];
  geometry.surfaceUnit = normalize(geometry.surfacePosition);
  const double min_latitude = clamp(latitude_deg - 0.5 * latitude_step_deg, -90.0, 90.0);
  const double max_latitude = clamp(latitude_deg + 0.5 * latitude_step_deg, -90.0, 90.0);
  const double min_longitude = clamp(longitude_deg - 0.5 * longitude_step_deg, -180.0, 180.0);
  const double max_longitude = clamp(longitude_deg + 0.5 * longitude_step_deg, -180.0, 180.0);
  set_grid_cell_sample(geometry, 1, min_latitude, min_longitude);
  set_grid_cell_sample(geometry, 2, min_latitude, max_longitude);
  set_grid_cell_sample(geometry, 3, max_latitude, min_longitude);
  set_grid_cell_sample(geometry, 4, max_latitude, max_longitude);
  geometry.sampleCount = 5;
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

GridConfig grid_from_scv_request(const SCVCoverageRequest* request) {
  GridConfig config{};
  if (const auto* coverage_grid = request->COVERAGE_GRID()) {
    config.minLat = coverage_grid->MIN_LAT_DEG();
    config.maxLat = coverage_grid->MAX_LAT_DEG();
    config.minLon = coverage_grid->MIN_LON_DEG();
    config.maxLon = coverage_grid->MAX_LON_DEG();
    config.latStep = std::max(0.01, coverage_grid->LAT_STEP_DEG());
    config.lonStep = std::max(0.01, coverage_grid->LON_STEP_DEG());
  }
  if (const auto* time_grid = request->TIME_GRID()) {
    config.start = time_grid->START_OFFSET_SEC();
    config.stop = time_grid->STOP_OFFSET_SEC();
  }
  config.rows = std::max(1, static_cast<int>(std::ceil((config.maxLat - config.minLat) / config.latStep)));
  config.columns = std::max(1, static_cast<int>(std::ceil((config.maxLon - config.minLon) / config.lonStep)));
  return config;
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
  if (config.shapeContract.kind == SensorShapeKind::CustomPolygon) {
    config.shapeContract.supported = false;
    config.shapeContract.unsupportedReason = "CUSTOM_POLYGON requires exact polygon geometry";
  }
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
    input.isScv = true;
    input.grid = grid_from_scv_request(envelope->REQUEST());
    input.tracks = tracks_from_scv_request(envelope->REQUEST());
    const SCVCoverageRequest* request = envelope->REQUEST();
    const auto* requested_products = request->REQUESTED_PRODUCTS();
    const bool has_explicit_products =
      requested_products != nullptr && requested_products->size() > 0;
    input.scvSwathOnly = request->ANALYSIS_MODE() == scvAnalysisMode_SWATH;
    input.includePackedGeometry = request->INCLUDE_PACKED_GEOMETRY();
    if (!input.scvSwathOnly && !has_explicit_products) {
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
  const double latitude = grid.minLat + (row + 0.5) * grid.latStep;
  const double longitude = grid.minLon + (column + 0.5) * grid.lonStep;
  const int tile_columns = std::max(
    1,
    (grid.columns + kGridTileColumnSpan - 1) / kGridTileColumnSpan);
  CellBounds bounds{};
  bounds.tileRow = row / kGridTileRowSpan;
  bounds.tileColumn = column / kGridTileColumnSpan;
  bounds.tileId = bounds.tileRow * tile_columns + bounds.tileColumn;
  bounds.minLatitudeDeg = clamp(latitude - 0.5 * grid.latStep, -90.0, 90.0);
  bounds.maxLatitudeDeg = clamp(latitude + 0.5 * grid.latStep, -90.0, 90.0);
  bounds.minLongitudeDeg = clamp(longitude - 0.5 * grid.lonStep, -180.0, 180.0);
  bounds.maxLongitudeDeg = clamp(longitude + 0.5 * grid.lonStep, -180.0, 180.0);
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
      cell.latitude = grid.minLat + (row + 0.5) * grid.latStep;
      cell.longitude = grid.minLon + (column + 0.5) * grid.lonStep;
      cell.bounds = cell_bounds_for(row, column, grid);
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
  cell.geometry = grid_cell_geometry(cell.latitude, cell.longitude, grid.latStep, grid.lonStep);
  cell.surfaceUnit = cell.geometry.surfaceUnit;
  cell.surfaceUnitReady = true;
  cell.geometryReady = true;
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
  SensorShapeContract boundary_contract = sensor.shapeContract;
  boundary_contract.boundarySamples = std::max(8, boundary_contract.boundarySamples);
  for (const SensorVec3& local : generate_sensor_boundary_directions(boundary_contract)) {
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
  for (const Vec3& direction : sensor_directions(sensor, frame.boresight, frame.xAxis, frame.yAxis)) {
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

  const SensorClassification classification = classify_local_look(
    sensor.shapeContract,
    {
      dot(sensor_to_cell, frame.xAxis),
      dot(sensor_to_cell, frame.yAxis),
      dot(sensor_to_cell, frame.boresight),
    });
  return classification.inside;
}

bool cell_visible_from_resolved_state(
    const GridCellGeometry& cell,
    const SensorConfig& sensor,
    const ResolvedVisibilityState& state) {
  for (int sample_index = 0; sample_index < cell.sampleCount; ++sample_index) {
    if (surface_sample_visible_from_resolved_state(
          cell.samplePositions[sample_index],
          cell.sampleNormals[sample_index],
          sensor,
          state)) {
      return true;
    }
  }
  return false;
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
    const ResolvedVisibilityState& start,
    const ResolvedVisibilityState& stop) {
  if (!(stop.state.elapsedSeconds > start.state.elapsedSeconds)) {
    return {};
  }

  const bool visible_start = cell_visible_from_resolved_state(cell, sensor, start);
  const bool visible_stop = cell_visible_from_resolved_state(cell, sensor, stop);

  if (visible_start && visible_stop) {
    return {start.state.elapsedSeconds, stop.state.elapsedSeconds, true};
  }
  if (visible_start && !visible_stop) {
    const double exit = refined_transition_time(
      cell,
      sensor,
      start,
      stop,
      start.state.elapsedSeconds,
      true,
      stop.state.elapsedSeconds,
      false);
    return {start.state.elapsedSeconds, exit, exit > start.state.elapsedSeconds};
  }
  if (!visible_start && visible_stop) {
    const double entry = refined_transition_time(
      cell,
      sensor,
      start,
      stop,
      start.state.elapsedSeconds,
      false,
      stop.state.elapsedSeconds,
      true);
    return {entry, stop.state.elapsedSeconds, stop.state.elapsedSeconds > entry};
  }

  const double mid_time = 0.5 * (start.state.elapsedSeconds + stop.state.elapsedSeconds);
  const bool visible_mid = cell_visible_at_time(cell, sensor, start, stop, mid_time);
  if (visible_mid) {
    const double entry = refined_transition_time(
      cell,
      sensor,
      start,
      stop,
      start.state.elapsedSeconds,
      false,
      mid_time,
      true);
    const double exit = refined_transition_time(
      cell,
      sensor,
      start,
      stop,
      mid_time,
      true,
      stop.state.elapsedSeconds,
      false);
    return {entry, exit, exit > entry};
  }
  return {};
}

std::map<int, std::vector<const SwathSegment*>> index_swaths_by_sensor(
    const std::vector<SwathSegment>& swaths) {
  std::map<int, std::vector<const SwathSegment*>> swaths_by_sensor;
  for (const auto& swath : swaths) {
    swaths_by_sensor[swath.sensorId].push_back(&swath);
  }
  return swaths_by_sensor;
}

void add_cell_interval(Cell& cell, const VisibilityInterval& interval, int sensor_id) {
  if (!interval.valid || !(interval.stop > interval.start)) {
    return;
  }
  cell.intervals.push_back({interval.start, interval.stop, {sensor_id}});
}

void accumulate_grid_coverage_products(
    std::vector<Cell>& cells,
    const std::vector<SensorTrack>& tracks,
    const std::vector<SwathSegment>& swaths,
    const GridConfig& grid) {
  const std::map<int, std::vector<const SwathSegment*>> swaths_by_sensor =
    index_swaths_by_sensor(swaths);
  for (const auto& track : tracks) {
    if (track.states.size() < 2) {
      continue;
    }
    const auto swath_group = swaths_by_sensor.find(track.sensor.sensorId);
    if (swath_group == swaths_by_sensor.end()) {
      continue;
    }
    const std::vector<const SwathSegment*>& track_swaths = swath_group->second;
    const std::vector<ResolvedVisibilityState> resolved_states =
      resolve_visibility_states(track.states);
    size_t swath_index = 0;
    for (size_t state_index = 0; state_index + 1 < track.states.size(); ++state_index) {
      const State& start = track.states[state_index];
      const State& stop = track.states[state_index + 1];
      const ResolvedVisibilityState& start_resolved = resolved_states[state_index];
      const ResolvedVisibilityState& stop_resolved = resolved_states[state_index + 1];
      while (
        swath_index < track_swaths.size() &&
        track_swaths[swath_index]->stop <= start.elapsedSeconds + 1.0e-9
      ) {
        ++swath_index;
      }
      if (swath_index >= track_swaths.size()) {
        break;
      }
      const SwathSegment& swath = *track_swaths[swath_index];
      if (
        std::fabs(swath.start - start.elapsedSeconds) >= 1.0e-9 ||
        std::fabs(swath.stop - stop.elapsedSeconds) >= 1.0e-9
      ) {
        continue;
      }

      for (int row = 0; row < grid.rows; ++row) {
        for (int column = 0; column < grid.columns; ++column) {
          const size_t cell_index = static_cast<size_t>(row * grid.columns + column);
          if (cell_index >= cells.size()) {
            continue;
          }
          Cell& cell = cells[cell_index];
          ensure_cell_geometry(cell, grid);
          const VisibilityInterval interval = refined_visibility_interval(
            cell.geometry,
            track.sensor,
            start_resolved,
            stop_resolved);
          add_cell_interval(cell, interval, track.sensor.sensorId);
        }
      }
    }
  }
}

void accumulate_grid_coverage_products(
    std::vector<Cell>& cells,
    const std::vector<SensorTrack>& tracks,
    const GridConfig& grid) {
  for (const auto& track : tracks) {
    if (track.states.size() < 2) {
      continue;
    }
    const std::vector<ResolvedVisibilityState> resolved_states =
      resolve_visibility_states(track.states);
    for (size_t state_index = 0; state_index + 1 < track.states.size(); ++state_index) {
      const ResolvedVisibilityState& start_resolved = resolved_states[state_index];
      const ResolvedVisibilityState& stop_resolved = resolved_states[state_index + 1];
      for (int row = 0; row < grid.rows; ++row) {
        for (int column = 0; column < grid.columns; ++column) {
          const size_t cell_index = static_cast<size_t>(row * grid.columns + column);
          if (cell_index >= cells.size()) {
            continue;
          }
          Cell& cell = cells[cell_index];
          ensure_cell_geometry(cell, grid);
          const VisibilityInterval interval = refined_visibility_interval(
            cell.geometry,
            track.sensor,
            start_resolved,
            stop_resolved);
          add_cell_interval(cell, interval, track.sensor.sensorId);
        }
      }
    }
  }
}

void merge_intervals(Cell& cell, double scenario_start, double scenario_stop) {
  if (cell.intervals.empty()) {
    return;
  }
  std::sort(cell.intervals.begin(), cell.intervals.end(), [](const Interval& left, const Interval& right) {
    return left.start < right.start;
  });
  std::vector<Interval> merged;
  for (const auto& interval : cell.intervals) {
    const Interval clipped{
      clamp(interval.start, scenario_start, scenario_stop),
      clamp(interval.stop, scenario_start, scenario_stop),
      interval.contributingSensorIds,
    };
    if (clipped.stop <= clipped.start) {
      continue;
    }
    if (merged.empty() || clipped.start > merged.back().stop) {
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

void update_cell_statistics(Cell& cell, const GridConfig& grid) {
  merge_intervals(cell, grid.start, grid.stop);
  cell.accessCount = static_cast<int>(cell.intervals.size());
  cell.revisitCount = std::max(0, cell.accessCount - 1);
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

  double response_gap_sum = 0.0;
  int response_gap_count = 0;
  auto accumulate_response_gap = [&](double gap) {
    const double finite_gap = std::max(0.0, gap);
    cell.maxResponse = std::max(cell.maxResponse, finite_gap);
    cell.maxGap = std::max(cell.maxGap, finite_gap);
    response_gap_sum += finite_gap;
    ++response_gap_count;
  };

  cell.firstResponse = std::max(0.0, cell.intervals.front().start - grid.start);
  accumulate_response_gap(cell.firstResponse);
  for (size_t index = 0; index < cell.intervals.size(); ++index) {
    cell.totalAccess += cell.intervals[index].stop - cell.intervals[index].start;
    if (index > 0) {
      const double gap = cell.intervals[index].start - cell.intervals[index - 1].stop;
      cell.revisitGapTotal += gap;
      accumulate_response_gap(gap);
    }
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
    if (cell.totalAccess > 0.0) {
      ++statistics.accessedCells;
      statistics.totalAccessDurationSec += cell.totalAccess;
    }
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

uint32_t total_window_count(const std::vector<SensorTrack>& tracks) {
  uint32_t total = 0;
  for (const auto& track : tracks) {
    if (track.states.size() > 1) {
      total = std::max(total, static_cast<uint32_t>(track.states.size() - 1));
    }
  }
  return total;
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
    std::string* error = nullptr) {
  flatbuffers::FlatBufferBuilder builder(4096);
  std::vector<ModuleOutputAllocation> output_allocations;
  std::vector<float> raster_percent_coverage;
  std::vector<uint32_t> raster_pass_count;
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
  std::vector<double> raster_cell_bounds;
  raster_cell_bounds.reserve(cells.size() * 4);
  std::vector<double> raster_cell_centers;
  raster_cell_centers.reserve(cells.size() * 2);
  std::vector<double> raster_bucket_start_seconds;
  raster_bucket_start_seconds.reserve(raster_bucket_count);
  std::vector<double> raster_bucket_stop_seconds;
  raster_bucket_stop_seconds.reserve(raster_bucket_count);
  const double raster_step = raster_bucket_count > 0
    ? duration / static_cast<double>(raster_bucket_count)
    : duration;
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
      ensure_byte_raster(
        raster_current_access_rgba,
        static_cast<size_t>(raster_bucket_count) * raster_cell_count * 4u);
      ensure_uint_raster(raster_bucket_active_cell_count, raster_bucket_count);
      if (raster_bucket_count > 0 && raster_step > 0.0) {
        for (const auto& interval : cell.intervals) {
          const double interval_start = std::max(interval.start, grid.start);
          const double interval_stop = std::min(interval.stop, grid.stop);
          if (!(interval_stop > interval_start)) {
            continue;
          }
          const uint32_t first_window = static_cast<uint32_t>(std::max(
            0.0,
            std::floor((interval_start - grid.start) / raster_step)));
          const uint32_t last_window = static_cast<uint32_t>(std::min(
            static_cast<double>(raster_bucket_count - 1u),
            std::ceil((interval_stop - grid.start) / raster_step) - 1.0));
          if (first_window > last_window) {
            continue;
          }
          for (uint32_t window_index = first_window; window_index <= last_window; ++window_index) {
            const double window_start =
              grid.start + static_cast<double>(window_index) * raster_step;
            const double window_stop = std::min(window_start + raster_step, grid.stop);
            if (!(interval_stop > window_start && interval_start < window_stop)) {
              continue;
            }
            const uint32_t word_index =
              window_index * raster_words_per_bucket +
              static_cast<uint32_t>(cell_index / 32u);
            const uint32_t mask = 1u << static_cast<uint32_t>(cell_index % 32u);
            if ((raster_current_access_bitset[word_index] & mask) == 0u) {
              raster_current_access_bitset[word_index] |= mask;
              ++raster_bucket_active_cell_count[window_index];
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
        if (cell.totalAccess > 0.0) {
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

  const double step = total_windows > 0
    ? duration / static_cast<double>(total_windows)
    : duration;
  const auto time_grid = CreateSCVTimeGridDirect(
    builder,
    nullptr,
    0.0,
    grid.start,
    grid.stop,
    step,
    0,
    total_windows);
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
  raster_bands.reserve(14);
  std::vector<flatbuffers::Offset<SCVMemoryRegion>> raster_memory_regions;
  raster_memory_regions.reserve(14);
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
    !push_uint8_band(
      scvRasterProductKind_CURRENT_ACCESS_RGBA,
      scvMetricSeriesKind_ACCESS_COUNT,
      raster_current_access_rgba,
      4,
      raster_bucket_count) ||
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
    aggregate_statistics);
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

  const std::string output_mode = "";
  const bool swath_preview_output =
    input.scvSwathOnly;
  const bool metric_product_output =
    !swath_preview_output &&
    !input.includePackedGeometry;

  const uint32_t total_windows = total_window_count(tracks);
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
      update_cell_statistics(cell, grid);
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
