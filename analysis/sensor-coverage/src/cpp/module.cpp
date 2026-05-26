using namespace sdn_hypersonics;

namespace {

constexpr double kEarthRadiusM = 6378137.0;
constexpr double kRadiansToDegrees = 180.0 / 3.14159265358979323846;
constexpr int kCoverageGeometryChunkSize = 256;

struct Interval {
  double start = 0.0;
  double stop = 0.0;
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

struct Vertex {
  double latitudeDeg = 0.0;
  double longitudeDeg = 0.0;
};

struct State {
  double elapsedSeconds = 0.0;
  Vec3 position;
  Vec3 velocity;
  SensorFrame sensorFrame;
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

struct Cell {
  int index = 0;
  int row = 0;
  int column = 0;
  double latitude = 0.0;
  double longitude = 0.0;
  std::vector<Interval> intervals;
  std::vector<int> contributingSensorIds;
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

Vertex to_cartographic(Vec3 point) {
  const Vec3 unit = normalize(point);
  return {
    std::asin(clamp(unit.z, -1.0, 1.0)) * kRadiansToDegrees,
    std::atan2(unit.y, unit.x) * kRadiansToDegrees,
  };
}

bool intersect_earth(Vec3 origin, Vec3 direction, double max_range, Vec3& result) {
  const Vec3 unit_direction = normalize(direction);
  const double b = dot(origin, unit_direction);
  const double c = dot(origin, origin) - kEarthRadiusM * kEarthRadiusM;
  const double discriminant = b * b - c;
  if (!(discriminant >= 0.0)) {
    return false;
  }
  const double root = std::sqrt(discriminant);
  double range = -b - root;
  if (!(range > 0.0)) {
    range = -b + root;
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
      cells.push_back(cell);
    }
  }
  return cells;
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
  const Vec3 radial = normalize(state.position);
  const SensorFrame frame = resolve_sensor_frame(state);
  const Vec3 subpoint = scale(radial, kEarthRadiusM);
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

void accumulate_swaths(std::vector<Cell>& cells, const std::vector<SwathSegment>& segments, const GridConfig& grid) {
  for (const auto& segment : segments) {
    const auto polygon = segment_polygon(segment);
    for (auto& cell : cells) {
      if (!point_in_polygon(cell.latitude, cell.longitude, polygon)) {
        continue;
      }
      cell.intervals.push_back({segment.start, segment.stop});
      if (segment.sensorId >= 0 && segment.sensorId < 32) {
        cell.sensorMask |= static_cast<uint32_t>(1u << segment.sensorId);
      }
      if (
        std::find(
          cell.contributingSensorIds.begin(),
          cell.contributingSensorIds.end(),
          segment.sensorId) == cell.contributingSensorIds.end()
      ) {
        cell.contributingSensorIds.push_back(segment.sensorId);
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
    };
    if (clipped.stop <= clipped.start) {
      continue;
    }
    if (merged.empty() || clipped.start > merged.back().stop) {
      merged.push_back(clipped);
    } else {
      merged.back().stop = std::max(merged.back().stop, clipped.stop);
    }
  }
  cell.intervals = merged;
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

std::string cells_json(const std::vector<Cell>& cells, double duration) {
  std::string output = "[";
  for (size_t index = 0; index < cells.size(); ++index) {
    if (index > 0) {
      output += ",";
    }
    const auto& cell = cells[index];
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
      "\"sensorContributionCount\":%zu,\"sensorMask\":%u,\"colorRgba\":%s,"
      "\"intervals\":",
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
      cell.sensorMask,
      color_json(percent).c_str());
    output += buffer;
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
        "\"sensorContributionCount\":%zu,\"sensorMask\":%u}",
        cell.index,
        cell.row,
        cell.column,
        interval.start,
        interval.stop,
        interval.stop - interval.start,
        cell.contributingSensorIds.size(),
        cell.sensorMask);
      output += buffer;
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

}  // namespace

extern "C" int compute_sensor_coverage(void) {
  plugin_reset_output_state();

  const std::string request = payload_for_port("coverage");
  if (request.empty()) {
    return fail("missing-coverage", "Input port \"coverage\" is required.");
  }

  const GridConfig grid = parse_grid(request);
  if (!(grid.stop > grid.start)) {
    return fail("invalid-time-span", "Coverage stopSeconds must be greater than startSeconds.");
  }

  const std::vector<SensorTrack> tracks = parse_sensor_tracks(request);
  if (tracks.empty()) {
    return fail("missing-states", "Coverage request must include at least two propagated sensor-owner states.");
  }

  std::vector<FootprintSample> footprints;
  std::vector<SwathSegment> swaths;
  for (const auto& track : tracks) {
    const std::vector<FootprintSample> track_footprints = compute_footprints(track.states, track.sensor);
    const std::vector<SwathSegment> track_swaths = build_swath_segments(track_footprints);
    footprints.insert(footprints.end(), track_footprints.begin(), track_footprints.end());
    for (auto segment : track_swaths) {
      segment.index = static_cast<int>(swaths.size());
      swaths.push_back(segment);
    }
  }
  if (swaths.empty()) {
    return fail("empty-swath", "Sensor geometry did not intersect Earth over the sampled time span.");
  }

  std::vector<Cell> cells = create_cells(grid);
  accumulate_swaths(cells, swaths, grid);

  int accessed = 0;
  int multi_access = 0;
  int total_interval_count = 0;
  int total_revisit_count = 0;
  double total_access = 0.0;
  double total_gap = 0.0;
  double max_gap = 0.0;
  double revisit_gap_total = 0.0;
  double max_response = 0.0;
  double response_sum = 0.0;
  for (auto& cell : cells) {
    update_cell_statistics(cell, grid);
    total_interval_count += cell.accessCount;
    total_revisit_count += cell.revisitCount;
    total_gap += cell.totalGap;
    max_gap = std::max(max_gap, cell.maxGap);
    revisit_gap_total += cell.revisitGapTotal;
    max_response = std::max(max_response, cell.maxResponse);
    response_sum += cell.meanResponse;
    if (cell.totalAccess > 0.0) {
      ++accessed;
      total_access += cell.totalAccess;
    }
    if (cell.contributingSensorIds.size() > 1) {
      ++multi_access;
    }
  }

  const double duration = grid.stop - grid.start;
  const std::string fom_type = string_value(request, "figureOfMerit", "percent_coverage");
  const std::string output_mode = string_value(request, "outputMode", "");
  const bool aggregate_output =
    output_mode == "aggregate_differential_geometry" || tracks.size() > 1;
  const std::string coverage_source = object_value(request, "coverageSource");
  char header[2048];
  std::snprintf(
    header,
    sizeof(header),
    "{\"provider\":\"sensor-coverage-analysis\",\"status\":\"nominal\","
    "\"swathMode\":\"orekit_along_track_swath\","
    "\"coverageSource\":%s,"
    "\"grid\":{\"rows\":%d,\"columns\":%d,\"cellCount\":%zu,"
    "\"latitudeStepDeg\":%.12g,\"longitudeStepDeg\":%.12g},"
    "\"statistics\":{\"totalCells\":%zu,\"accessedCells\":%d,\"multiAccessCells\":%d,"
    "\"activeSensorCount\":%zu,\"swathCount\":%zu,"
    "\"totalIntervalCount\":%d,\"totalRevisitCount\":%d,"
    "\"totalAccessDurationSec\":%.12g,\"totalGapDurationSec\":%.12g,"
    "\"maxGapDurationSec\":%.12g,\"meanRevisitTimeSec\":%.12g,"
    "\"maxResponseTimeSec\":%.12g,\"meanResponseTimeSec\":%.12g,"
    "\"percentCoverage\":%.12g},",
    coverage_source.empty() ? "{}" : coverage_source.c_str(),
    grid.rows,
    grid.columns,
    cells.size(),
    grid.latStep,
    grid.lonStep,
    cells.size(),
    accessed,
    multi_access,
    tracks.size(),
    swaths.size(),
    total_interval_count,
    total_revisit_count,
    total_access,
    total_gap,
    max_gap,
    total_revisit_count > 0 ? revisit_gap_total / total_revisit_count : 0.0,
    max_response,
    cells.empty() ? 0.0 : response_sum / static_cast<double>(cells.size()),
    cells.empty() ? 0.0 : 100.0 * static_cast<double>(accessed) / static_cast<double>(cells.size()));

  std::string response = std::string(header) +
    "\"cells\":" + cells_json(cells, duration) + "," +
    "\"coverageIntervals\":" + coverage_intervals_json(cells) + "," +
    "\"figureOfMerit\":" + fom_json(cells, fom_type, duration) + "," +
    "\"footprints\":" + (aggregate_output ? std::string("[]") : footprints_json(footprints)) + "," +
    "\"swaths\":" + swaths_json(swaths, duration) + "," +
    "\"aggregateGeometry\":" + aggregate_geometry_json(swaths, tracks.size()) + "," +
    "\"assumptions\":[\"OrbPro Sensor-owned propagated states define the coverage source\","
    "\"swath polygons are continuous along-track left/right footprint bands\","
    "\"grid cells are secondary figure-of-merit samples accumulated from swath geometry\"]}";

  return emit_json("coverage", "TAB.fbs", "$TAB", response);
}
