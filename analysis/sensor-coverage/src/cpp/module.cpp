#include <map>

using namespace sdn_hypersonics;

namespace {

constexpr double kEarthRadiusM = 6378137.0;
constexpr double kWgs84A = 6378137.0;
constexpr double kWgs84B = 6356752.3142451793;
constexpr double kWgs84A2 = kWgs84A * kWgs84A;
constexpr double kWgs84B2 = kWgs84B * kWgs84B;
constexpr double kWgs84E2 = 1.0 - kWgs84B2 / kWgs84A2;
constexpr double kWgs84Ep2 = kWgs84A2 / kWgs84B2 - 1.0;
constexpr double kRadiansToDegrees = 180.0 / 3.14159265358979323846;
constexpr int kCoverageGeometryChunkSize = 256;
constexpr int kVisibilityTransitionRefinementIterations = 8;
constexpr size_t kGridCellCacheMaxEntries = 4;
constexpr int kGridTileRowSpan = 8;
constexpr int kGridTileColumnSpan = 8;

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
  std::string type = "conic";
  double outerHalfAngleRad = 0.20;
  double xHalfAngleRad = 0.12;
  double yHalfAngleRad = 0.12;
  double radiusMeters = 1500000.0;
  int angularSamples = 32;
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

struct SwathBounds {
  double minLatitudeDeg = 90.0;
  double maxLatitudeDeg = -90.0;
  double minLongitudeDeg = 180.0;
  double maxLongitudeDeg = -180.0;
  bool crossesDateline = false;
};

struct CellRange {
  int minRow = 0;
  int maxRow = -1;
  int minColumn = 0;
  int maxColumn = -1;
};

struct NadirConicCandidateFilter {
  Vec3 centerUnit;
  double radiusRad = 0.0;
  double cosRadius = -1.0;
  double sinRadius = 0.0;
  bool valid = false;
};

struct NadirConicCandidateWindow {
  SwathBounds bounds;
  NadirConicCandidateFilter filter;
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
  double angularRadiusRad = 0.0;
  double cosAngularRadius = 1.0;
  double sinAngularRadius = 0.0;
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
  // Legacy lower-32 compatibility field. Exact identity is carried by
  // contributingSensorIds and serialized as sensorIds/sensorBitsetWords.
  uint32_t sensorMask = 0;
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

bool is_finite_vec(Vec3 value) {
  return std::isfinite(value.x) && std::isfinite(value.y) && std::isfinite(value.z);
}

Vec3 normalize(Vec3 value, Vec3 fallback = {1.0, 0.0, 0.0}) {
  const double length = magnitude(value);
  if (!(length > 0.0) || !std::isfinite(length)) {
    return fallback;
  }
  return scale(value, 1.0 / length);
}

double central_angle_rad(Vec3 left_unit, Vec3 right_unit) {
  return std::acos(clamp(dot(left_unit, right_unit), -1.0, 1.0));
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

GridConfig parse_grid(const std::string& request) {
  const std::string grid = object_value(request, "grid");
  const std::string time_span = object_value(request, "timeSpan");
  GridConfig config{};
  config.minLat = number_value(grid, "minLatitudeDeg", -8.0);
  config.maxLat = number_value(grid, "maxLatitudeDeg", 8.0);
  config.minLon = number_value(grid, "minLongitudeDeg", -12.0);
  config.maxLon = number_value(grid, "maxLongitudeDeg", 12.0);
  config.latStep = std::max(0.01, number_value(grid, "latitudeStepDeg", 2.0));
  config.lonStep = std::max(0.01, number_value(grid, "longitudeStepDeg", 2.0));
  config.start = number_value(time_span, "startSeconds", 0.0);
  config.stop = number_value(time_span, "stopSeconds", 3600.0);
  config.rows = std::max(1, static_cast<int>(std::ceil((config.maxLat - config.minLat) / config.latStep)));
  config.columns = std::max(1, static_cast<int>(std::ceil((config.maxLon - config.minLon) / config.lonStep)));
  return config;
}

SensorConfig parse_sensor_config(const std::string& sensor_json, int fallback_sensor_id = 0) {
  SensorConfig config{};
  config.sensorId = static_cast<int>(number_value(sensor_json, "sensorId", static_cast<double>(fallback_sensor_id)));
  config.type = string_value(sensor_json, "type", "conic");
  config.outerHalfAngleRad = clamp(number_value(sensor_json, "outerHalfAngleRad", 0.20), 0.01, 1.2);
  config.xHalfAngleRad = clamp(number_value(sensor_json, "xHalfAngleRad", config.outerHalfAngleRad), 0.01, 1.2);
  config.yHalfAngleRad = clamp(number_value(sensor_json, "yHalfAngleRad", config.outerHalfAngleRad), 0.01, 1.2);
  config.radiusMeters = std::max(1.0, number_value(sensor_json, "radiusMeters", 1500000.0));
  config.angularSamples = static_cast<int>(clamp(number_value(sensor_json, "angularSamples", 32.0), 8.0, 96.0));
  return config;
}

SensorConfig parse_sensor(const std::string& request) {
  const std::string sensor = object_value(request, "sensor");
  return parse_sensor_config(sensor.empty() ? request : sensor);
}

Vec3 parse_vec3(const std::string& object) {
  return {
    number_value(object, "x", 0.0),
    number_value(object, "y", 0.0),
    number_value(object, "z", 0.0),
  };
}

SensorFrame parse_sensor_frame(const std::string& object) {
  const std::string sensor_frame = object_value(object, "sensorFrame");
  SensorFrame frame{};
  if (sensor_frame.empty()) {
    return frame;
  }
  frame.boresight = parse_vec3(object_value(sensor_frame, "boresight"));
  frame.xAxis = parse_vec3(object_value(sensor_frame, "xAxis"));
  frame.yAxis = parse_vec3(object_value(sensor_frame, "yAxis"));
  frame.valid =
    is_finite_vec(frame.boresight) &&
    is_finite_vec(frame.xAxis) &&
    is_finite_vec(frame.yAxis) &&
    magnitude(frame.boresight) > 0.0 &&
    magnitude(frame.xAxis) > 0.0 &&
    magnitude(frame.yAxis) > 0.0;
  return frame;
}

std::vector<State> parse_states(const std::string& request) {
  const auto objects = object_array(request, "states");
  std::vector<State> states;
  states.reserve(objects.size());
  for (const auto& object : objects) {
    const std::string position = object_value(object, "position");
    const std::string velocity = object_value(object, "velocity");
    State state{};
    state.elapsedSeconds = number_value(object, "elapsedSeconds", 0.0);
    state.position = {
      number_value(position, "x", 0.0),
      number_value(position, "y", 0.0),
      number_value(position, "z", 0.0),
    };
    state.velocity = {
      number_value(velocity, "x", 0.0),
      number_value(velocity, "y", 0.0),
      number_value(velocity, "z", 0.0),
    };
    state.sensorFrame = parse_sensor_frame(object);
    if (
      std::isfinite(state.elapsedSeconds) &&
      magnitude(state.position) > kEarthRadiusM + 1.0 &&
      magnitude(state.velocity) > 0.0
    ) {
      states.push_back(state);
    }
  }
  std::sort(states.begin(), states.end(), [](const State& left, const State& right) {
    return left.elapsedSeconds < right.elapsedSeconds;
  });
  return states;
}

std::vector<SensorTrack> parse_sensor_tracks(const std::string& request) {
  const auto sensor_objects = object_array(request, "sensors");
  std::vector<SensorTrack> tracks;
  if (!sensor_objects.empty()) {
    tracks.reserve(sensor_objects.size());
    for (size_t index = 0; index < sensor_objects.size(); ++index) {
      const auto& sensor_object = sensor_objects[index];
      const std::string nested_sensor = object_value(sensor_object, "sensor");
      SensorTrack track{};
      track.sensor = parse_sensor_config(
        nested_sensor.empty() ? sensor_object : nested_sensor,
        static_cast<int>(index));
      track.states = parse_states(sensor_object);
      if (track.states.size() >= 2) {
        tracks.push_back(track);
      }
    }
    return tracks;
  }

  SensorTrack track{};
  track.sensor = parse_sensor(request);
  track.states = parse_states(request);
  if (track.states.size() >= 2) {
    tracks.push_back(track);
  }
  return tracks;
}

Vec3 vec3_from_scv(const SCVVec3* value) {
  if (!value) {
    return {};
  }
  return {value->X(), value->Y(), value->Z()};
}

SensorFrame fallback_sensor_frame(const State& state) {
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

  const SensorFrame base = fallback_sensor_frame(state);
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
    return config;
  }
  config.sensorId = static_cast<int>(sensor->SENSOR_ID());
  if (sensor->SHAPE() == scvSensorShapeKind_RECTANGULAR) {
    config.type = "rectangular";
  }
  const double half_angle_deg = sensor->HALF_ANGLE_DEG();
  if (half_angle_deg > 0.0) {
    config.outerHalfAngleRad = clamp(half_angle_deg / kRadiansToDegrees, 0.01, 1.2);
  }
  const double cross_track_deg = sensor->CROSS_TRACK_HALF_ANGLE_DEG();
  const double along_track_deg = sensor->ALONG_TRACK_HALF_ANGLE_DEG();
  config.xHalfAngleRad = clamp(
    (cross_track_deg > 0.0 ? cross_track_deg : half_angle_deg) / kRadiansToDegrees,
    0.01,
    1.2);
  config.yHalfAngleRad = clamp(
    (along_track_deg > 0.0 ? along_track_deg : half_angle_deg) / kRadiansToDegrees,
    0.01,
    1.2);
  const double max_range = sensor->MAX_RANGE_M();
  if (max_range > 0.0) {
    config.radiusMeters = max_range;
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

bool payload_has_scv_identifier(const std::string& payload) {
  return payload.size() >= 8 &&
    SCVBufferHasIdentifier(reinterpret_cast<const uint8_t*>(payload.data()));
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
    input.includePackedGeometry =
      !has_explicit_products || request->INCLUDE_PACKED_GEOMETRY();
    return true;
  }

  input.isScv = false;
  input.includePackedGeometry = true;
  input.scvSwathOnly = false;
  input.grid = parse_grid(payload);
  input.tracks = parse_sensor_tracks(payload);
  return true;
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

  const Vec3 corner_units[4] = {
    geodetic_surface_unit(bounds.minLatitudeDeg, bounds.minLongitudeDeg),
    geodetic_surface_unit(bounds.minLatitudeDeg, bounds.maxLongitudeDeg),
    geodetic_surface_unit(bounds.maxLatitudeDeg, bounds.minLongitudeDeg),
    geodetic_surface_unit(bounds.maxLatitudeDeg, bounds.maxLongitudeDeg),
  };
  for (const auto& corner_unit : corner_units) {
    bounds.angularRadiusRad = std::max(
      bounds.angularRadiusRad,
      central_angle_rad(bounds.centerUnit, corner_unit));
  }
  bounds.cosAngularRadius = std::cos(bounds.angularRadiusRad);
  bounds.sinAngularRadius = std::sin(bounds.angularRadiusRad);
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
  cell.sensorMask = 0;
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
  const SensorFrame fallback = fallback_sensor_frame(state);
  if (!state.sensorFrame.valid) {
    return fallback;
  }

  SensorFrame frame{};
  frame.boresight = normalize(state.sensorFrame.boresight, fallback.boresight);
  Vec3 x_axis = subtract(
    state.sensorFrame.xAxis,
    scale(frame.boresight, dot(state.sensorFrame.xAxis, frame.boresight)));
  frame.xAxis = normalize(x_axis, fallback.xAxis);

  Vec3 y_axis = subtract(
    state.sensorFrame.yAxis,
    scale(frame.boresight, dot(state.sensorFrame.yAxis, frame.boresight)));
  y_axis = subtract(y_axis, scale(frame.xAxis, dot(y_axis, frame.xAxis)));
  frame.yAxis = normalize(y_axis, normalize(cross(frame.boresight, frame.xAxis), fallback.yAxis));
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

std::vector<Vec3> sensor_directions(const SensorConfig& sensor, Vec3 boresight, Vec3 x_axis, Vec3 y_axis) {
  std::vector<Vec3> directions;
  if (sensor.type == "rectangular") {
    const double sx = std::tan(sensor.xHalfAngleRad);
    const double sy = std::tan(sensor.yHalfAngleRad);
    const double signs[4][2] = {{-1.0, -1.0}, {-1.0, 1.0}, {1.0, 1.0}, {1.0, -1.0}};
    for (const auto& sign : signs) {
      directions.push_back(normalize(add(add(boresight, scale(x_axis, sign[0] * sx)), scale(y_axis, sign[1] * sy))));
    }
    return directions;
  }

  const double cos_angle = std::cos(sensor.outerHalfAngleRad);
  const double sin_angle = std::sin(sensor.outerHalfAngleRad);
  for (int index = 0; index < sensor.angularSamples; ++index) {
    const double clock = 2.0 * 3.14159265358979323846 * static_cast<double>(index) / static_cast<double>(sensor.angularSamples);
    const Vec3 lateral = add(scale(x_axis, std::cos(clock)), scale(y_axis, std::sin(clock)));
    directions.push_back(normalize(add(scale(boresight, cos_angle), scale(lateral, sin_angle))));
  }
  return directions;
}

FootprintSample compute_footprint(const State& state, const SensorConfig& sensor) {
  const SensorFrame frame = resolve_sensor_frame(state);
  const Vec3 subpoint = geodetic_surface_point(state.position);
  Vec3 center_point = subpoint;
  intersect_earth(state.position, frame.boresight, sensor.radiusMeters, center_point);

  FootprintSample sample{};
  sample.sensorId = sensor.sensorId;
  sample.elapsedSeconds = state.elapsedSeconds;
  sample.center = to_cartographic(center_point);

  double left_metric = -1.0e100;
  double right_metric = 1.0e100;
  for (const Vec3& direction : sensor_directions(sensor, frame.boresight, frame.xAxis, frame.yAxis)) {
    Vec3 hit;
    if (!intersect_earth(state.position, direction, sensor.radiusMeters, hit)) {
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

bool point_in_polygon(double latitude, double longitude, const std::vector<Vertex>& polygon) {
  bool inside = false;
  for (size_t i = 0, j = polygon.size() - 1; i < polygon.size(); j = i++) {
    const double yi = polygon[i].latitudeDeg;
    const double yj = polygon[j].latitudeDeg;
    const double xi = polygon[i].longitudeDeg;
    const double xj = polygon[j].longitudeDeg;
    if (((yi > latitude) != (yj > latitude)) &&
        (longitude < (xj - xi) * (latitude - yi) / (yj - yi + 1.0e-15) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

std::vector<Vertex> segment_polygon(const SwathSegment& segment) {
  return {
    segment.leftStart,
    segment.leftStop,
    segment.rightStop,
    segment.rightStart,
  };
}

SwathBounds swath_bounds(const std::vector<Vertex>& polygon) {
  SwathBounds bounds{};
  double min_longitude = 180.0;
  double max_longitude = -180.0;
  for (const auto& vertex : polygon) {
    bounds.minLatitudeDeg = std::min(bounds.minLatitudeDeg, vertex.latitudeDeg);
    bounds.maxLatitudeDeg = std::max(bounds.maxLatitudeDeg, vertex.latitudeDeg);
    min_longitude = std::min(min_longitude, vertex.longitudeDeg);
    max_longitude = std::max(max_longitude, vertex.longitudeDeg);
  }
  bounds.minLongitudeDeg = min_longitude;
  bounds.maxLongitudeDeg = max_longitude;
  bounds.crossesDateline = max_longitude - min_longitude > 180.0;
  return bounds;
}

int first_cell_center_index(double coordinate, double grid_min, double step) {
  return static_cast<int>(std::ceil((coordinate - grid_min) / step - 0.5 - 1.0e-12));
}

int last_cell_center_index(double coordinate, double grid_min, double step) {
  return static_cast<int>(std::floor((coordinate - grid_min) / step - 0.5 + 1.0e-12));
}

CellRange candidate_cell_range(const SwathBounds& bounds, const GridConfig& grid) {
  CellRange range{};
  if (
    grid.rows <= 0 ||
    grid.columns <= 0 ||
    bounds.maxLatitudeDeg < grid.minLat ||
    bounds.minLatitudeDeg > grid.maxLat
  ) {
    return range;
  }

  range.minRow = std::max(0, first_cell_center_index(bounds.minLatitudeDeg, grid.minLat, grid.latStep));
  range.maxRow = std::min(grid.rows - 1, last_cell_center_index(bounds.maxLatitudeDeg, grid.minLat, grid.latStep));
  if (range.maxRow < range.minRow) {
    return {0, -1, 0, -1};
  }

  if (bounds.crossesDateline) {
    range.minColumn = 0;
    range.maxColumn = grid.columns - 1;
    return range;
  }

  if (bounds.maxLongitudeDeg < grid.minLon || bounds.minLongitudeDeg > grid.maxLon) {
    return {0, -1, 0, -1};
  }

  range.minColumn = std::max(0, first_cell_center_index(bounds.minLongitudeDeg, grid.minLon, grid.lonStep));
  range.maxColumn = std::min(grid.columns - 1, last_cell_center_index(bounds.maxLongitudeDeg, grid.minLon, grid.lonStep));
  if (range.maxColumn < range.minColumn) {
    return {0, -1, 0, -1};
  }
  return range;
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

void accumulate_swaths(std::vector<Cell>& cells, const std::vector<SwathSegment>& segments, const GridConfig& grid) {
  for (const auto& segment : segments) {
    const auto polygon = segment_polygon(segment);
    const SwathBounds bounds = swath_bounds(polygon);
    const CellRange range = candidate_cell_range(bounds, grid);
    for (int row = range.minRow; row <= range.maxRow; ++row) {
      for (int column = range.minColumn; column <= range.maxColumn; ++column) {
        const size_t cell_index = static_cast<size_t>(row * grid.columns + column);
        if (cell_index >= cells.size()) {
          continue;
        }
        Cell& cell = cells[cell_index];
        if (!point_in_polygon(cell.latitude, cell.longitude, polygon)) {
          continue;
        }
        cell.intervals.push_back({segment.start, segment.stop, {segment.sensorId}});
        if (segment.sensorId >= 0 && segment.sensorId < 32) {
          cell.sensorMask |= static_cast<uint32_t>(1u << segment.sensorId);
        }
        add_unique_sensor_id(cell.contributingSensorIds, segment.sensorId);
      }
    }
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

double nadir_conic_footprint_angular_radius_rad(const SensorConfig& sensor, const State& state) {
  const double spacecraft_radius = magnitude(state.position);
  if (!(spacecraft_radius > kEarthRadiusM) || !std::isfinite(spacecraft_radius)) {
    return 0.0;
  }

  const double sin_argument = clamp(
    spacecraft_radius / kEarthRadiusM * std::sin(sensor.outerHalfAngleRad),
    -1.0,
    1.0);
  double fov_radius = std::asin(sin_argument) - sensor.outerHalfAngleRad;
  if (!std::isfinite(fov_radius) || fov_radius < 0.0) {
    fov_radius = 0.0;
  }

  double range_radius = 3.14159265358979323846;
  if (sensor.radiusMeters > 0.0) {
    const double cosine = clamp(
      (spacecraft_radius * spacecraft_radius + kEarthRadiusM * kEarthRadiusM -
        sensor.radiusMeters * sensor.radiusMeters) /
        (2.0 * spacecraft_radius * kEarthRadiusM),
      -1.0,
      1.0);
    range_radius = std::acos(cosine);
  }

  const double angular_radius =
    std::min(std::max(0.0, fov_radius), std::max(0.0, range_radius));
  return angular_radius;
}

double nadir_conic_angular_radius_deg(const SensorConfig& sensor, const State& state, const GridConfig& grid) {
  const double angular_radius = nadir_conic_footprint_angular_radius_rad(sensor, state);
  const double cell_margin = 0.5 * std::max(grid.latStep, grid.lonStep);
  return angular_radius * kRadiansToDegrees + cell_margin + 1.0e-9;
}

bool uses_fallback_nadir_conic_bounds(const SensorTrack& track) {
  if (track.sensor.type != "conic") {
    return false;
  }
  for (const auto& state : track.states) {
    if (state.sensorFrame.valid) {
      return false;
    }
  }
  return true;
}

NadirConicCandidateWindow nadir_conic_candidate_window(
    const SensorConfig& sensor,
    const State& start,
    const State& stop,
    const GridConfig& grid) {
  const State mid = interpolate_state(
    start,
    stop,
    0.5 * (start.elapsedSeconds + stop.elapsedSeconds));
  const Vec3 start_surface = geodetic_surface_point(start.position);
  const Vec3 mid_surface = geodetic_surface_point(mid.position);
  const Vec3 stop_surface = geodetic_surface_point(stop.position);
  const Vec3 start_unit = normalize(start_surface);
  const Vec3 mid_unit = normalize(mid_surface);
  const Vec3 stop_unit = normalize(stop_surface);
  const Vertex samples[3] = {
    to_cartographic(start_surface),
    to_cartographic(mid_surface),
    to_cartographic(stop_surface),
  };
  const double margin = std::max({
    nadir_conic_angular_radius_deg(sensor, start, grid),
    nadir_conic_angular_radius_deg(sensor, mid, grid),
    nadir_conic_angular_radius_deg(sensor, stop, grid),
  });
  const double footprint_radius_rad =
    std::max({
      nadir_conic_footprint_angular_radius_rad(sensor, start),
      nadir_conic_footprint_angular_radius_rad(sensor, mid),
      nadir_conic_footprint_angular_radius_rad(sensor, stop),
    });

  double min_latitude = 90.0;
  double max_latitude = -90.0;
  double min_longitude = 180.0;
  double max_longitude = -180.0;
  for (const auto& sample : samples) {
    min_latitude = std::min(min_latitude, sample.latitudeDeg);
    max_latitude = std::max(max_latitude, sample.latitudeDeg);
    min_longitude = std::min(min_longitude, sample.longitudeDeg);
    max_longitude = std::max(max_longitude, sample.longitudeDeg);
  }

  NadirConicCandidateWindow window{};
  window.bounds.minLatitudeDeg = clamp(min_latitude - margin, -90.0, 90.0);
  window.bounds.maxLatitudeDeg = clamp(max_latitude + margin, -90.0, 90.0);
  window.bounds.crossesDateline =
    max_longitude - min_longitude > 180.0 ||
    min_longitude - margin < -180.0 ||
    max_longitude + margin > 180.0;
  if (window.bounds.crossesDateline) {
    window.bounds.minLongitudeDeg = -180.0;
    window.bounds.maxLongitudeDeg = 180.0;
  } else {
    window.bounds.minLongitudeDeg = clamp(min_longitude - margin, -180.0, 180.0);
    window.bounds.maxLongitudeDeg = clamp(max_longitude + margin, -180.0, 180.0);
  }

  const double sweep_radius_rad =
    std::max(central_angle_rad(mid_unit, start_unit), central_angle_rad(mid_unit, stop_unit));

  window.filter.centerUnit = mid_unit;
  window.filter.radiusRad =
    footprint_radius_rad + sweep_radius_rad + 1.0e-12;
  window.filter.cosRadius = std::cos(
    clamp(window.filter.radiusRad, 0.0, 3.14159265358979323846));
  window.filter.sinRadius = std::sin(
    clamp(window.filter.radiusRad, 0.0, 3.14159265358979323846));
  window.filter.valid =
    std::isfinite(window.filter.radiusRad) &&
    std::isfinite(window.filter.cosRadius) &&
    std::isfinite(window.filter.sinRadius);
  return window;
}

Vec3 cell_surface_unit(Cell& cell) {
  if (!cell.surfaceUnitReady) {
    cell.surfaceUnit = geodetic_surface_unit(cell.latitude, cell.longitude);
    cell.surfaceUnitReady = true;
  }
  return cell.surfaceUnit;
}

bool cell_matches_nadir_conic_candidate_filter(
    Cell& cell,
    const NadirConicCandidateFilter& filter) {
  if (!filter.valid) {
    return true;
  }
  if (filter.radiusRad + cell.bounds.angularRadiusRad >= 3.14159265358979323846) {
    return true;
  }
  const double cos_expanded_radius =
    filter.cosRadius * cell.bounds.cosAngularRadius -
    filter.sinRadius * cell.bounds.sinAngularRadius;
  return dot(
    cell.bounds.centerUnit,
    filter.centerUnit) >= cos_expanded_radius;
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
  if (!(range > 0.0) || !std::isfinite(range) || range > sensor.radiusMeters) {
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

  if (sensor.type == "rectangular") {
    const double along_angle = std::atan2(dot(look, frame.xAxis), forward);
    const double cross_angle = std::atan2(dot(look, frame.yAxis), forward);
    return std::fabs(along_angle) <= sensor.xHalfAngleRad &&
      std::fabs(cross_angle) <= sensor.yHalfAngleRad;
  }

  return forward >= std::cos(sensor.outerHalfAngleRad);
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
  if (sensor_id >= 0 && sensor_id < 32) {
    cell.sensorMask |= static_cast<uint32_t>(1u << sensor_id);
  }
}

void accumulate_grid_analytics(
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

      const auto polygon = segment_polygon(swath);
      const SwathBounds bounds = swath_bounds(polygon);
      const CellRange range = candidate_cell_range(bounds, grid);
      for (int row = range.minRow; row <= range.maxRow; ++row) {
        for (int column = range.minColumn; column <= range.maxColumn; ++column) {
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

void accumulate_grid_analytics(
    std::vector<Cell>& cells,
    const std::vector<SensorTrack>& tracks,
    const GridConfig& grid) {
  for (const auto& track : tracks) {
    if (track.states.size() < 2) {
      continue;
    }
    const bool use_nadir_bounds = uses_fallback_nadir_conic_bounds(track);
    std::vector<SwathSegment> track_swaths;
    if (!use_nadir_bounds) {
      const std::vector<FootprintSample> track_footprints =
        compute_footprints(track.states, track.sensor);
      track_swaths = build_swath_segments(track_footprints);
    }
    const std::vector<ResolvedVisibilityState> resolved_states =
      resolve_visibility_states(track.states);
    size_t swath_index = 0;
    for (size_t state_index = 0; state_index + 1 < track.states.size(); ++state_index) {
      const State& start = track.states[state_index];
      const State& stop = track.states[state_index + 1];
      const ResolvedVisibilityState& start_resolved = resolved_states[state_index];
      const ResolvedVisibilityState& stop_resolved = resolved_states[state_index + 1];
      SwathBounds bounds{};
      NadirConicCandidateFilter nadir_filter{};
      if (use_nadir_bounds) {
        const NadirConicCandidateWindow candidate_window =
          nadir_conic_candidate_window(track.sensor, start, stop, grid);
        bounds = candidate_window.bounds;
        nadir_filter = candidate_window.filter;
      } else {
        while (
          swath_index < track_swaths.size() &&
          track_swaths[swath_index].stop <= start.elapsedSeconds + 1.0e-9
        ) {
          ++swath_index;
        }
        if (swath_index >= track_swaths.size()) {
          break;
        }
        const SwathSegment& swath = track_swaths[swath_index];
        if (
          std::fabs(swath.start - start.elapsedSeconds) >= 1.0e-9 ||
          std::fabs(swath.stop - stop.elapsedSeconds) >= 1.0e-9
        ) {
          continue;
        }
        const auto polygon = segment_polygon(swath);
        bounds = swath_bounds(polygon);
      }

      const CellRange range = candidate_cell_range(bounds, grid);
      for (int row = range.minRow; row <= range.maxRow; ++row) {
        for (int column = range.minColumn; column <= range.maxColumn; ++column) {
          const size_t cell_index = static_cast<size_t>(row * grid.columns + column);
          if (cell_index >= cells.size()) {
            continue;
          }
          Cell& cell = cells[cell_index];
          if (
            use_nadir_bounds &&
            !cell_matches_nadir_conic_candidate_filter(cell, nadir_filter)
          ) {
            continue;
          }
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

std::string color_json(double percent) {
  const double u = clamp(percent / 100.0, 0.0, 1.0);
  const int red = static_cast<int>(std::round(245.0 * u + 10.0));
  const int green = static_cast<int>(std::round(190.0 * (1.0 - std::fabs(u - 0.5) * 2.0) + 35.0));
  const int blue = static_cast<int>(std::round(235.0 * (1.0 - u) + 20.0));
  const int alpha = percent > 0.0 ? 190 : 35;
  char buffer[128];
  std::snprintf(buffer, sizeof(buffer), "[%d,%d,%d,%d]", red, green, blue, alpha);
  return buffer;
}

std::string vertex_json(const Vertex& vertex) {
  char buffer[160];
  std::snprintf(
    buffer,
    sizeof(buffer),
    "{\"latitudeDeg\":%.12g,\"longitudeDeg\":%.12g}",
    vertex.latitudeDeg,
    vertex.longitudeDeg);
  return buffer;
}

std::string interval_json(const Interval& interval) {
  char buffer[192];
  std::snprintf(
    buffer,
    sizeof(buffer),
    "{\"startSeconds\":%.12g,\"stopSeconds\":%.12g,\"durationSec\":%.12g}",
    interval.start,
    interval.stop,
    interval.stop - interval.start);
  return buffer;
}

std::string intervals_json(const std::vector<Interval>& intervals) {
  std::string output = "[";
  for (size_t index = 0; index < intervals.size(); ++index) {
    if (index > 0) {
      output += ",";
    }
    output += interval_json(intervals[index]);
  }
  output += "]";
  return output;
}

std::string sensor_ids_json(const std::vector<int>& sensor_ids) {
  std::string output = "[";
  for (size_t index = 0; index < sensor_ids.size(); ++index) {
    if (index > 0) {
      output += ",";
    }
    output += std::to_string(sensor_ids[index]);
  }
  output += "]";
  return output;
}

std::vector<uint64_t> sensor_bitset_words(const std::vector<int>& sensor_ids) {
  int max_sensor_id = -1;
  for (const int sensor_id : sensor_ids) {
    if (sensor_id > max_sensor_id) {
      max_sensor_id = sensor_id;
    }
  }
  if (max_sensor_id < 0) {
    return {};
  }

  std::vector<uint64_t> words(static_cast<size_t>(max_sensor_id / 64 + 1), 0);
  for (const int sensor_id : sensor_ids) {
    if (sensor_id < 0) {
      continue;
    }
    const size_t word_index = static_cast<size_t>(sensor_id / 64);
    const uint64_t bit = static_cast<uint64_t>(1) << (sensor_id % 64);
    words[word_index] |= bit;
  }
  return words;
}

uint32_t legacy_sensor_mask(const std::vector<int>& sensor_ids) {
  uint32_t mask = 0;
  for (const int sensor_id : sensor_ids) {
    if (sensor_id >= 0 && sensor_id < 32) {
      mask |= static_cast<uint32_t>(1u << sensor_id);
    }
  }
  return mask;
}

std::string sensor_bitset_words_json(const std::vector<int>& sensor_ids) {
  const auto words = sensor_bitset_words(sensor_ids);
  std::string output = "[";
  for (size_t index = 0; index < words.size(); ++index) {
    if (index > 0) {
      output += ",";
    }
    output += "\"";
    output += std::to_string(words[index]);
    output += "\"";
  }
  output += "]";
  return output;
}

std::string cells_json(const std::vector<Cell>& cells, double duration, bool sparse = false) {
  std::string output = "[";
  bool first = true;
  for (size_t index = 0; index < cells.size(); ++index) {
    const auto& cell = cells[index];
    if (sparse && cell.accessCount <= 0 && cell.intervals.empty() && cell.totalAccess <= 0.0) {
      continue;
    }
    if (!first) {
      output += ",";
    }
    first = false;
    const double percent = duration > 0.0 ? 100.0 * cell.totalAccess / duration : 0.0;
    char buffer[1024];
    std::snprintf(
      buffer,
      sizeof(buffer),
      "{\"index\":%d,\"row\":%d,\"column\":%d,\"latitudeDeg\":%.12g,"
      "\"longitudeDeg\":%.12g,\"accessCount\":%d,\"revisitCount\":%d,"
      "\"totalAccessDurationSec\":%.12g,\"percentCoverage\":%.12g,"
      "\"maxGapDurationSec\":%.12g,\"meanRevisitTimeSec\":%.12g,"
      "\"firstResponseTimeSec\":%.12g,\"maxResponseTimeSec\":%.12g,"
      "\"meanResponseTimeSec\":%.12g,\"totalGapDurationSec\":%.12g,"
      "\"sensorContributionCount\":%zu,\"sensorMask\":%u,\"sensorIds\":",
      cell.index,
      cell.row,
      cell.column,
      cell.latitude,
      cell.longitude,
      cell.accessCount,
      cell.revisitCount,
      cell.totalAccess,
      percent,
      cell.maxGap,
      cell.meanRevisit,
      cell.firstResponse,
      cell.maxResponse,
      cell.meanResponse,
      cell.totalGap,
      cell.contributingSensorIds.size(),
      cell.sensorMask);
    output += buffer;
    output += sensor_ids_json(cell.contributingSensorIds);
    output += ",\"sensorBitsetWords\":";
    output += sensor_bitset_words_json(cell.contributingSensorIds);
    output += ",\"colorRgba\":";
    output += color_json(percent);
    output += ",\"intervals\":";
    output += intervals_json(cell.intervals);
    output += "}";
  }
  output += "]";
  return output;
}

std::string coverage_intervals_json(const std::vector<Cell>& cells) {
  std::string output = "[";
  bool first = true;
  for (const auto& cell : cells) {
    for (const auto& interval : cell.intervals) {
      if (!first) {
        output += ",";
      }
      first = false;
      char buffer[512];
      std::snprintf(
        buffer,
        sizeof(buffer),
        "{\"cellIndex\":%d,\"row\":%d,\"column\":%d,"
        "\"startSeconds\":%.12g,\"stopSeconds\":%.12g,\"durationSec\":%.12g,"
        "\"sensorContributionCount\":%zu,\"sensorMask\":%u,\"sensorIds\":",
        cell.index,
        cell.row,
        cell.column,
        interval.start,
        interval.stop,
        interval.stop - interval.start,
        interval.contributingSensorIds.size(),
        legacy_sensor_mask(interval.contributingSensorIds));
      output += buffer;
      output += sensor_ids_json(interval.contributingSensorIds);
      output += ",\"sensorBitsetWords\":";
      output += sensor_bitset_words_json(interval.contributingSensorIds);
      output += "}";
    }
  }
  output += "]";
  return output;
}

double fom_value_for_cell(
  const Cell& cell,
  const std::string& fom_type,
  double duration,
  std::string& units) {
  double value = cell.totalAccess;
  units = "seconds";
  if (fom_type == "access_count") {
    value = cell.accessCount;
    units = "count";
  } else if (fom_type == "percent_coverage") {
    value = duration > 0.0 ? 100.0 * cell.totalAccess / duration : 0.0;
    units = "percent";
  } else if (fom_type == "max_gap_duration" || fom_type == "gap_time") {
    value = cell.maxGap;
    units = "seconds";
  } else if (fom_type == "mean_revisit_time" || fom_type == "revisit_time") {
    value = cell.meanRevisit;
    units = "seconds";
  } else if (fom_type == "response_time") {
    value = cell.firstResponse;
    units = "seconds";
  }
  return value;
}

std::string fom_values_json(
  const std::vector<Cell>& cells,
  const std::string& fom_type,
  double duration,
  std::string& units) {
  std::string values = "[";
  for (size_t index = 0; index < cells.size(); ++index) {
    if (index > 0) {
      values += ",";
    }
    const double value = fom_value_for_cell(cells[index], fom_type, duration, units);
    char buffer[64];
    std::snprintf(buffer, sizeof(buffer), "%.12g", value);
    values += buffer;
  }
  values += "]";
  return values;
}

std::string fom_product_json(
  const std::vector<Cell>& cells,
  const std::string& fom_type,
  double duration) {
  std::string units = "seconds";
  const std::string values = fom_values_json(cells, fom_type, duration, units);
  return "{\"type\":" + quote(fom_type) + ",\"units\":" + quote(units) + ",\"values\":" + values + "}";
}

std::string fom_products_json(const std::vector<Cell>& cells, double duration) {
  return std::string("{") +
    "\"percent_coverage\":" + fom_product_json(cells, "percent_coverage", duration) + "," +
    "\"gap_time\":" + fom_product_json(cells, "gap_time", duration) + "," +
    "\"revisit_time\":" + fom_product_json(cells, "revisit_time", duration) + "," +
    "\"response_time\":" + fom_product_json(cells, "response_time", duration) +
    "}";
}

std::string fom_json(const std::vector<Cell>& cells, const std::string& fom_type, double duration) {
  if (fom_type == "none") {
    return "{\"type\":\"none\",\"units\":\"\",\"values\":[],\"products\":{}}";
  }
  std::string units = "seconds";
  const std::string values = fom_values_json(cells, fom_type, duration, units);
  return "{\"type\":" + quote(fom_type) + ",\"units\":" + quote(units) +
    ",\"values\":" + values + ",\"products\":" + fom_products_json(cells, duration) + "}";
}

std::string swaths_json(const std::vector<SwathSegment>& segments, double duration) {
  std::string output = "[";
  for (size_t index = 0; index < segments.size(); ++index) {
    if (index > 0) {
      output += ",";
    }
    const auto& segment = segments[index];
    const double percent = duration > 0.0 ? 100.0 * (segment.stop - segment.start) / duration : 0.0;
    char header[512];
    std::snprintf(
      header,
      sizeof(header),
      "{\"index\":%d,\"sensorId\":%d,\"kind\":\"orekit_along_track_swath\","
      "\"startSeconds\":%.12g,\"stopSeconds\":%.12g,"
      "\"totalAccessDurationSec\":%.12g,\"percentCoverage\":%.12g,\"colorRgba\":%s,",
      segment.index,
      segment.sensorId,
      segment.start,
      segment.stop,
      segment.stop - segment.start,
      percent,
      color_json(percent).c_str());
    output += header;
    output += "\"leftEdge\":[" + vertex_json(segment.leftStart) + "," + vertex_json(segment.leftStop) + "],";
    output += "\"rightEdge\":[" + vertex_json(segment.rightStart) + "," + vertex_json(segment.rightStop) + "],";
    output += "\"centerline\":[" + vertex_json(segment.centerStart) + "," + vertex_json(segment.centerStop) + "],";
    output += "\"vertices\":[" + vertex_json(segment.leftStart) + "," + vertex_json(segment.leftStop) + "," +
      vertex_json(segment.rightStop) + "," + vertex_json(segment.rightStart) + "]}";
  }
  output += "]";
  return output;
}

std::string footprints_json(const std::vector<FootprintSample>& samples) {
  std::string output = "[";
  for (size_t index = 0; index < samples.size(); ++index) {
    if (index > 0) {
      output += ",";
    }
    const auto& sample = samples[index];
    char header[256];
    std::snprintf(
      header,
      sizeof(header),
      "{\"sensorId\":%d,\"elapsedSeconds\":%.12g,\"center\":%s,\"vertices\":[",
      sample.sensorId,
      sample.elapsedSeconds,
      vertex_json(sample.center).c_str());
    output += header;
    for (size_t vertex_index = 0; vertex_index < sample.vertices.size(); ++vertex_index) {
      if (vertex_index > 0) {
        output += ",";
      }
      output += vertex_json(sample.vertices[vertex_index]);
    }
    output += "]}";
  }
  output += "]";
  return output;
}

std::string aggregate_geometry_json(const std::vector<SwathSegment>& segments, size_t active_sensor_count) {
  size_t vertex_count = 0;
  std::string deltas = "[";
  for (size_t index = 0; index < segments.size(); ++index) {
    if (index > 0) {
      deltas += ",";
    }
    const auto& segment = segments[index];
    vertex_count += 4;
    char delta[512];
    std::snprintf(
      delta,
      sizeof(delta),
      "{\"operation\":\"add\",\"polygonIndex\":%zu,\"swathIndex\":%d,"
      "\"sensorId\":%d,\"chunkId\":%zu,\"startSeconds\":%.12g,\"stopSeconds\":%.12g}",
      index,
      segment.index,
      segment.sensorId,
      index / static_cast<size_t>(kCoverageGeometryChunkSize),
      segment.start,
      segment.stop);
    deltas += delta;
  }
  deltas += "]";

  char header[1024];
  std::snprintf(
    header,
    sizeof(header),
    "{\"contract\":\"orbpro.coverage.aggregate.v0\","
    "\"aggregation\":\"all_active_sensors\","
    "\"operationMode\":\"additive_deltas\","
    "\"activeSensorCount\":%zu,"
    "\"chunkSize\":%d,"
    "\"full\":{\"kind\":\"multipolygon\",\"polygonCount\":%zu,\"ringCount\":%zu,"
    "\"vertexCount\":%zu,\"ringReference\":\"swaths[].vertices\"},"
    "\"deltas\":",
    active_sensor_count,
    kCoverageGeometryChunkSize,
    segments.size(),
    segments.size(),
    vertex_count);
  return std::string(header) + deltas + "}";
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

std::string coverage_statistics_json(const CoverageStatistics& statistics) {
  char buffer[1024];
  std::snprintf(
    buffer,
    sizeof(buffer),
    "{\"totalCells\":%zu,\"accessedCells\":%d,\"multiAccessCells\":%d,"
    "\"activeSensorCount\":%zu,\"swathCount\":%zu,\"totalWindows\":%u,"
    "\"totalIntervalCount\":%d,\"totalRevisitCount\":%d,"
    "\"totalAccessDurationSec\":%.12g,\"totalGapDurationSec\":%.12g,"
    "\"maxGapDurationSec\":%.12g,\"meanRevisitTimeSec\":%.12g,"
    "\"maxResponseTimeSec\":%.12g,\"meanResponseTimeSec\":%.12g,"
    "\"percentCoverage\":%.12g}",
    statistics.totalCells,
    statistics.accessedCells,
    statistics.multiAccessCells,
    statistics.activeSensorCount,
    statistics.swathCount,
    statistics.totalWindows,
    statistics.totalIntervalCount,
    statistics.totalRevisitCount,
    statistics.totalAccessDurationSec,
    statistics.totalGapDurationSec,
    statistics.maxGapDurationSec,
    statistics.meanRevisitTimeSec,
    statistics.maxResponseTimeSec,
    statistics.meanResponseTimeSec,
    statistics.percentCoverage);
  return buffer;
}

std::string scv_summary_message_json(const CoverageStatistics& statistics) {
  return std::string("{") +
    "\"contract\":\"orbpro.coverage.scv-summary.v0\"," +
    "\"provider\":\"sensor-coverage-analysis\"," +
    "\"status\":\"nominal\"," +
    "\"statistics\":" + coverage_statistics_json(statistics) +
    "}";
}

uint32_t total_window_count(const std::vector<SensorTrack>& tracks) {
  uint32_t total = 0;
  for (const auto& track : tracks) {
    if (track.states.size() > 1) {
      total += static_cast<uint32_t>(track.states.size() - 1);
    }
  }
  return total;
}

std::vector<uint8_t> build_scv_result(
    const GridConfig& grid,
    const std::vector<SensorTrack>& tracks,
    const std::vector<Cell>& cells,
    const std::vector<SwathSegment>& swaths,
    uint32_t total_windows,
    bool include_geometry,
    const std::string& message) {
  flatbuffers::FlatBufferBuilder builder(4096);
  std::vector<flatbuffers::Offset<SCVCellStat>> cell_stats;
  cell_stats.reserve(cells.size());
  std::vector<flatbuffers::Offset<SCVInterval>> intervals;
  std::vector<flatbuffers::Offset<SCVTimeSeriesPoint>> time_series;
  time_series.reserve(cells.size() * 6);

  const double duration = std::max(0.0, grid.stop - grid.start);
  auto push_metric = [&](scvMetricSeriesKind kind, const Cell& cell, double value) {
    time_series.push_back(CreateSCVTimeSeriesPoint(
      builder,
      kind,
      grid.start,
      0,
      value,
      0,
      static_cast<uint32_t>(cell.index)));
  };
  for (const auto& cell : cells) {
    std::vector<uint32_t> sensor_ids;
    sensor_ids.reserve(cell.contributingSensorIds.size());
    for (const int sensor_id : cell.contributingSensorIds) {
      if (sensor_id >= 0) {
        sensor_ids.push_back(static_cast<uint32_t>(sensor_id));
      }
    }
    const std::vector<uint64_t> bitset_words = sensor_bitset_words(cell.contributingSensorIds);
    const double coverage_fraction = duration > 0.0 ? cell.totalAccess / duration : 0.0;
    const double mean_gap = cell.accessCount > 0
      ? cell.totalGap / static_cast<double>(cell.accessCount + 1)
      : duration;
    cell_stats.push_back(CreateSCVCellStatDirect(
      builder,
      static_cast<uint32_t>(cell.index),
      cell.latitude,
      cell.longitude,
      0.0,
      static_cast<uint32_t>(cell.accessCount),
      total_windows,
      coverage_fraction,
      cell.meanRevisit,
      cell.maxGap,
      mean_gap,
      static_cast<double>(sensor_ids.size()),
      &sensor_ids,
      &bitset_words));
    push_metric(
      scvMetricSeriesKind_PERCENT_COVERED,
      cell,
      coverage_fraction * 100.0);
    push_metric(
      scvMetricSeriesKind_ACCESS_COUNT,
      cell,
      static_cast<double>(cell.accessCount));
    push_metric(
      scvMetricSeriesKind_CONTACT_DURATION_SECONDS,
      cell,
      cell.totalAccess);
    push_metric(
      scvMetricSeriesKind_REVISIT_SECONDS,
      cell,
      cell.meanRevisit);
    push_metric(
      scvMetricSeriesKind_GAP_SECONDS,
      cell,
      cell.maxGap);
    push_metric(
      scvMetricSeriesKind_REDUNDANCY,
      cell,
      static_cast<double>(sensor_ids.size()));
    for (const auto& interval : cell.intervals) {
      for (const int sensor_id : interval.contributingSensorIds) {
        if (sensor_id < 0) {
          continue;
        }
        intervals.push_back(CreateSCVInterval(
          builder,
          static_cast<uint32_t>(sensor_id),
          0,
          scvIntervalCategory_ACCESS,
          interval.start,
          interval.stop,
          interval.stop - interval.start,
          0.0,
          0.0,
          static_cast<uint32_t>(cell.index)));
      }
    }
  }

  flatbuffers::Offset<SCVPackedGeometryChunk> geometry = 0;
  if (include_geometry) {
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
      auto push_vertex = [&](const Vertex& vertex) {
        reveal_coords.push_back(static_cast<float>(vertex.longitudeDeg));
        reveal_coords.push_back(static_cast<float>(vertex.latitudeDeg));
      };
      push_vertex(segment.leftStart);
      push_vertex(segment.leftStop);
      push_vertex(segment.rightStop);
      push_vertex(segment.rightStart);
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

    geometry = CreateSCVPackedGeometryChunkDirect(
      builder,
      "sensor-coverage-analysis",
      0,
      0,
      0,
      static_cast<uint32_t>(swaths.size()),
      scvGeometryDomain_SURFACE,
      scvCoordinateFrame_BODY_FIXED,
      scvGeometryEncoding_FLAT_FLOAT32,
      grid.start,
      grid.stop,
      nullptr,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      nullptr,
      nullptr,
      nullptr,
      &reveal_coords,
      &indices,
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
  const auto result = CreateSCVResultDirect(
    builder,
    "sensor-coverage-analysis",
    0,
    scvResultState_OK,
    time_grid,
    target_body,
    static_cast<uint32_t>(tracks.size()),
    total_windows,
    &cell_stats,
    &intervals,
	    nullptr,
	    &time_series,
	    nullptr,
	    nullptr,
	    nullptr,
	    geometry,
	    message.c_str());
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

  const std::string output_mode = input.isScv
    ? std::string("")
    : string_value(request_payload, "outputMode", "");
  const bool swath_only_output =
    (!input.isScv && output_mode == "swath_only") ||
    (input.isScv && input.scvSwathOnly);
  const bool analytics_only_output =
    !swath_only_output &&
    ((!input.isScv && output_mode == "analytics_only") ||
      (input.isScv && !input.includePackedGeometry));

  const uint32_t total_windows = total_window_count(tracks);
  const uint32_t progress_stride = std::max<uint32_t>(1, total_windows / 20);
  uint32_t completed_windows = 0;
  std::vector<FootprintSample> footprints;
  std::vector<SwathSegment> swaths;
  if (!analytics_only_output) {
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
  if (!analytics_only_output && swaths.empty()) {
    return fail("empty-swath", "Sensor geometry did not intersect Earth over the sampled time span.");
  }

  std::vector<Cell>* cells = nullptr;
  if (!swath_only_output) {
    cells = &cached_grid_cells_for(grid);
    if (analytics_only_output) {
      accumulate_grid_analytics(*cells, tracks, grid);
    } else {
      accumulate_grid_analytics(*cells, tracks, swaths, grid);
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
  const std::string statistics_json = coverage_statistics_json(statistics);
  const std::string scv_summary_message = scv_summary_message_json(statistics);

  const double duration = grid.stop - grid.start;
  const std::string fom_type = swath_only_output
    ? std::string("none")
    : input.isScv
      ? std::string("percent_coverage")
      : string_value(request_payload, "figureOfMerit", "percent_coverage");
  const bool aggregate_output =
    output_mode == "aggregate_differential_geometry" ||
    output_mode == "swath_only" ||
    tracks.size() > 1;
  const std::string coverage_source = input.isScv
    ? std::string("")
    : object_value(request_payload, "coverageSource");
  const std::vector<SwathSegment> empty_swaths;
  const std::vector<SwathSegment>& response_swaths =
    analytics_only_output ? empty_swaths : swaths;
  char header[2048];
  std::snprintf(
    header,
    sizeof(header),
    "{\"provider\":\"sensor-coverage-analysis\",\"status\":\"nominal\","
    "\"swathMode\":\"orekit_along_track_swath\","
    "\"coverageSource\":%s,"
    "\"grid\":{\"rows\":%d,\"columns\":%d,\"cellCount\":%zu,"
    "\"latitudeStepDeg\":%.12g,\"longitudeStepDeg\":%.12g},"
    "\"statistics\":%s,",
    coverage_source.empty() ? "{}" : coverage_source.c_str(),
    grid.rows,
    grid.columns,
    response_cells.size(),
    grid.latStep,
    grid.lonStep,
    statistics_json.c_str());

  std::string response = std::string(header) +
    "\"cells\":" + cells_json(response_cells, duration, analytics_only_output) + "," +
    "\"coverageIntervals\":" + coverage_intervals_json(response_cells) + "," +
    "\"figureOfMerit\":" + fom_json(response_cells, fom_type, duration) + "," +
    "\"footprints\":" +
      ((analytics_only_output || aggregate_output) ? std::string("[]") : footprints_json(footprints)) + "," +
    "\"swaths\":" + swaths_json(response_swaths, duration) + "," +
    "\"aggregateGeometry\":" + aggregate_geometry_json(response_swaths, tracks.size()) + "," +
    "\"assumptions\":[\"OrbPro Sensor-owned propagated states define the coverage source\","
    "\"swath polygons are continuous along-track left/right footprint bands\","
    "\"grid cells are secondary figure-of-merit samples accumulated from swath geometry\"]}";

  if (!input.isScv) {
    const int json_status = emit_json(
      "coverage",
      "SensorCoverageCompatibilityJson",
      "JSON",
      response);
    if (json_status != 0) {
      return json_status;
    }
    if (analytics_only_output) {
      return 0;
    }
  }

  const int progress_status =
    emit_scv_progress_frame(tracks, total_windows, total_windows);
  if (progress_status != 0) {
    return progress_status;
  }

    const std::vector<uint8_t> scv_result =
      build_scv_result(
        grid,
        tracks,
        response_cells,
        response_swaths,
        total_windows,
        input.includePackedGeometry,
        scv_summary_message);
  return emit_bytes(
    "coverage",
    "SCV/main.fbs",
    "$SCV",
    scv_result.data(),
    static_cast<uint32_t>(scv_result.size()));
}
