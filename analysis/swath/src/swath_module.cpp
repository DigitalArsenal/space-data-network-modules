/*
 ISC License

 This module ports the swath footprint projection kernel to the SDK's
 standalone C++/WASI surface using aligned-binary request/result records.
 */

#include "space_data_module_invoke.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kTwoPi = 2.0 * kPi;
constexpr double kWgs84A = 6378137.0;
constexpr double kWgs84B = 6356752.3142451793;
constexpr double kWgs84A2 = kWgs84A * kWgs84A;
constexpr double kWgs84B2 = kWgs84B * kWgs84B;
constexpr double kWgs84E2 = 1.0 - kWgs84B2 / kWgs84A2;
constexpr double kWgs84Ep2 = kWgs84A2 / kWgs84B2 - 1.0;
constexpr uint32_t kStateRecordSize = 64;
constexpr uint32_t kSensorRecordSize = 576;
constexpr uint32_t kTargetRecordSize = 64;
constexpr uint32_t kFootprintVertexSize = 64;
constexpr uint32_t kGroundTrackPointSize = 64;
constexpr uint32_t kSwathSegmentSize = 64;

struct Vec3 {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

struct Cartographic {
  double longitude = 0.0;
  double latitude = 0.0;
  double altitude = 0.0;
};

struct StateRecord {
  Vec3 position;
  Vec3 velocity;
  double julian_date = 0.0;
};

struct SensorRecord {
  uint32_t sensor_type = 0;
  uint32_t custom_direction_count = 0;
  double half_angle_rad = 0.0;
  double along_track_fov_rad = 0.0;
  double cross_track_fov_rad = 0.0;
  double angular_resolution_rad = kPi / 18.0;
  double roll_rad = 0.0;
  double pitch_rad = 0.0;
  double yaw_rad = 0.0;
  double min_range_m = 0.0;
  double max_range_m = 2.0e7;
  double min_elevation_rad = 0.0;
  double max_elevation_rad = kPi * 0.5;
  Vec3 custom_directions[16];
};

struct TargetRecord {
  double longitude = 0.0;
  double latitude = 0.0;
  double altitude = 0.0;
};

struct LvlhFrame {
  Vec3 radial;
  Vec3 along_track;
  Vec3 cross_track;
  Vec3 nadir;
};

struct SensorAxes {
  Vec3 x;
  Vec3 y;
  Vec3 z;
};

struct FootprintVertex {
  double longitude = 0.0;
  double latitude = 0.0;
  double altitude = 0.0;
  double julian_date = 0.0;
  double ground_range = 0.0;
  double look_angle = 0.0;
  uint32_t flags = 0;
  uint32_t vertex_index = 0;
};

struct GroundTrackPoint {
  double julian_date = 0.0;
  double longitude = 0.0;
  double latitude = 0.0;
  double altitude = 0.0;
  double heading = 0.0;
  double speed = 0.0;
  uint32_t flags = 0;
};

struct EnuFrame {
  Vec3 east;
  Vec3 north;
  Vec3 up;
};

struct AccessGeometry {
  double range = 0.0;
  double elevation = 0.0;
  double azimuth = 0.0;
  double slant_range = 0.0;
  double look_angle = 0.0;
  bool is_visible = false;
  bool is_occluded = false;
};

struct SwathSegment {
  double start_time = 0.0;
  double end_time = 0.0;
  double center_lon = 0.0;
  double center_lat = 0.0;
  uint32_t left_vertex_start = 0;
  uint32_t left_vertex_count = 0;
  uint32_t right_vertex_start = 0;
  uint32_t right_vertex_count = 0;
};

struct SwathResult {
  std::vector<SwathSegment> segments{};
  std::vector<FootprintVertex> vertices{};
};

struct DecoratedVertex {
  FootprintVertex vertex{};
  double along_track = 0.0;
};

SensorRecord decode_sensor(const uint8_t* bytes);

bool finite(double value) {
  return std::isfinite(value);
}

bool finite(const Vec3& value) {
  return finite(value.x) && finite(value.y) && finite(value.z);
}

double read_f64(const uint8_t* bytes, uint32_t offset) {
  double value = 0.0;
  std::memcpy(&value, bytes + offset, sizeof(value));
  return value;
}

uint32_t read_u32(const uint8_t* bytes, uint32_t offset) {
  uint32_t value = 0;
  std::memcpy(&value, bytes + offset, sizeof(value));
  return value;
}

void write_f64(std::vector<uint8_t>& bytes, uint32_t offset, double value) {
  std::memcpy(bytes.data() + offset, &value, sizeof(value));
}

void write_u32(std::vector<uint8_t>& bytes, uint32_t offset, uint32_t value) {
  std::memcpy(bytes.data() + offset, &value, sizeof(value));
}

double magnitude(const Vec3& vector) {
  return std::hypot(vector.x, vector.y, vector.z);
}

double dot(const Vec3& left, const Vec3& right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

Vec3 cross(const Vec3& left, const Vec3& right) {
  return {
      left.y * right.z - left.z * right.y,
      left.z * right.x - left.x * right.z,
      left.x * right.y - left.y * right.x};
}

Vec3 add(const Vec3& left, const Vec3& right) {
  return {left.x + right.x, left.y + right.y, left.z + right.z};
}

Vec3 subtract(const Vec3& left, const Vec3& right) {
  return {left.x - right.x, left.y - right.y, left.z - right.z};
}

Vec3 scale(const Vec3& vector, double scalar) {
  return {vector.x * scalar, vector.y * scalar, vector.z * scalar};
}

Vec3 normalize(const Vec3& vector) {
  const double length = magnitude(vector);
  if (length <= 0.0 || !finite(length)) {
    return {};
  }
  return scale(vector, 1.0 / length);
}

double clamp(double value, double min_value, double max_value) {
  return std::max(min_value, std::min(max_value, value));
}

Vec3 rotate_around_axis(const Vec3& vector, const Vec3& axis, double angle) {
  if (!finite(angle) || std::fabs(angle) < 1.0e-15) {
    return vector;
  }
  const Vec3 unit_axis = normalize(axis);
  const double cos_angle = std::cos(angle);
  const double sin_angle = std::sin(angle);
  const double axis_dot = dot(unit_axis, vector);
  return add(
      add(scale(vector, cos_angle), scale(cross(unit_axis, vector), sin_angle)),
      scale(unit_axis, axis_dot * (1.0 - cos_angle)));
}

Cartographic ecef_to_geodetic(const Vec3& position) {
  const double p = std::hypot(position.x, position.y);
  const double longitude = std::atan2(position.y, position.x);
  const double theta = std::atan2(position.z * kWgs84A, p * kWgs84B);
  const double sin_theta = std::sin(theta);
  const double cos_theta = std::cos(theta);
  const double latitude = std::atan2(
      position.z + kWgs84Ep2 * kWgs84B * sin_theta * sin_theta * sin_theta,
      p - kWgs84E2 * kWgs84A * cos_theta * cos_theta * cos_theta);
  const double sin_latitude = std::sin(latitude);
  const double prime_vertical =
      kWgs84A / std::sqrt(1.0 - kWgs84E2 * sin_latitude * sin_latitude);
  const double altitude =
      p / std::max(std::cos(latitude), 1.0e-12) - prime_vertical;
  return {longitude, latitude, altitude};
}

Vec3 geodetic_to_ecef(const TargetRecord& target) {
  const double cos_lat = std::cos(target.latitude);
  const double sin_lat = std::sin(target.latitude);
  const double cos_lon = std::cos(target.longitude);
  const double sin_lon = std::sin(target.longitude);
  const double prime_vertical =
      kWgs84A / std::sqrt(1.0 - kWgs84E2 * sin_lat * sin_lat);
  return {
      (prime_vertical + target.altitude) * cos_lat * cos_lon,
      (prime_vertical + target.altitude) * cos_lat * sin_lon,
      (prime_vertical * (1.0 - kWgs84E2) + target.altitude) * sin_lat};
}

EnuFrame create_enu_frame(const TargetRecord& target) {
  const double sin_lon = std::sin(target.longitude);
  const double cos_lon = std::cos(target.longitude);
  const double sin_lat = std::sin(target.latitude);
  const double cos_lat = std::cos(target.latitude);
  return {
      {-sin_lon, cos_lon, 0.0},
      {-sin_lat * cos_lon, -sin_lat * sin_lon, cos_lat},
      {cos_lat * cos_lon, cos_lat * sin_lon, sin_lat}};
}

double haversine_distance(const Cartographic& left, const Cartographic& right) {
  const double d_lat = right.latitude - left.latitude;
  const double d_lon = right.longitude - left.longitude;
  const double sin_lat = std::sin(d_lat * 0.5);
  const double sin_lon = std::sin(d_lon * 0.5);
  const double a = sin_lat * sin_lat +
                   std::cos(left.latitude) * std::cos(right.latitude) *
                       sin_lon * sin_lon;
  const double c = 2.0 * std::atan2(std::sqrt(a), std::sqrt(std::max(1.0 - a, 0.0)));
  return kWgs84A * c;
}

double normalize_angle(double angle) {
  double value = angle;
  while (value <= -kPi) {
    value += kTwoPi;
  }
  while (value > kPi) {
    value -= kTwoPi;
  }
  return value;
}

double heading_between(const Cartographic& left, const Cartographic& right) {
  const double d_lon = normalize_angle(right.longitude - left.longitude);
  const double y = std::sin(d_lon) * std::cos(right.latitude);
  const double x = std::cos(left.latitude) * std::sin(right.latitude) -
                   std::sin(left.latitude) * std::cos(right.latitude) *
                       std::cos(d_lon);
  return std::atan2(y, x);
}

bool project_ray_to_ellipsoid(
    const Vec3& origin,
    const Vec3& direction,
    Vec3* position,
    Cartographic* cartographic,
    double* distance) {
  if (position == nullptr || cartographic == nullptr || distance == nullptr ||
      !finite(origin) || !finite(direction)) {
    return false;
  }

  const Vec3 unit_direction = normalize(direction);
  const Vec3 scaled_origin = {
      origin.x / kWgs84A,
      origin.y / kWgs84A,
      origin.z / kWgs84B};
  const Vec3 scaled_direction = {
      unit_direction.x / kWgs84A,
      unit_direction.y / kWgs84A,
      unit_direction.z / kWgs84B};
  const double a = dot(scaled_direction, scaled_direction);
  const double b = 2.0 * dot(scaled_origin, scaled_direction);
  const double c = dot(scaled_origin, scaled_origin) - 1.0;
  const double discriminant = b * b - 4.0 * a * c;
  if (discriminant < 0.0 || !finite(discriminant)) {
    return false;
  }

  const double sqrt_discriminant = std::sqrt(discriminant);
  double t = (-b - sqrt_discriminant) / (2.0 * a);
  if (t < 0.0) {
    t = (-b + sqrt_discriminant) / (2.0 * a);
    if (t < 0.0) {
      return false;
    }
  }

  *position = add(origin, scale(unit_direction, t));
  *cartographic = ecef_to_geodetic(*position);
  *distance = std::fabs(t);
  return finite(*position) && finite(cartographic->longitude) &&
         finite(cartographic->latitude) && finite(cartographic->altitude) &&
         finite(*distance);
}

StateRecord decode_state(const uint8_t* bytes) {
  return {
      {read_f64(bytes, 0), read_f64(bytes, 8), read_f64(bytes, 16)},
      {read_f64(bytes, 24), read_f64(bytes, 32), read_f64(bytes, 40)},
      read_f64(bytes, 48)};
}

bool decode_state_batch(
    const uint8_t* bytes,
    uint32_t length,
    std::vector<StateRecord>* states) {
  if (bytes == nullptr || states == nullptr || length < 16) {
    return false;
  }
  const uint32_t count = read_u32(bytes, 0);
  if (count > 100000u || length < 16u + count * kStateRecordSize) {
    return false;
  }
  states->clear();
  states->reserve(count);
  uint32_t cursor = 16;
  for (uint32_t index = 0; index < count; ++index) {
    states->push_back(decode_state(bytes + cursor));
    cursor += kStateRecordSize;
  }
  return true;
}

bool decode_swath_request(
    const uint8_t* bytes,
    uint32_t length,
    SensorRecord* sensor,
    std::vector<StateRecord>* states) {
  if (bytes == nullptr || sensor == nullptr || states == nullptr ||
      length < 16u + kSensorRecordSize) {
    return false;
  }
  const uint32_t count = read_u32(bytes, 0);
  const uint32_t states_offset = 16u + kSensorRecordSize;
  if (count > 100000u || length < states_offset + count * kStateRecordSize) {
    return false;
  }
  *sensor = decode_sensor(bytes + 16);
  states->clear();
  states->reserve(count);
  uint32_t cursor = states_offset;
  for (uint32_t index = 0; index < count; ++index) {
    states->push_back(decode_state(bytes + cursor));
    cursor += kStateRecordSize;
  }
  return true;
}

SensorRecord decode_sensor(const uint8_t* bytes) {
  SensorRecord sensor{};
  sensor.sensor_type = read_u32(bytes, 0);
  sensor.custom_direction_count = std::min(read_u32(bytes, 8), 16u);
  sensor.half_angle_rad = read_f64(bytes, 16);
  sensor.along_track_fov_rad = read_f64(bytes, 24);
  sensor.cross_track_fov_rad = read_f64(bytes, 32);
  sensor.angular_resolution_rad = read_f64(bytes, 40);
  sensor.roll_rad = read_f64(bytes, 48);
  sensor.pitch_rad = read_f64(bytes, 56);
  sensor.yaw_rad = read_f64(bytes, 64);
  sensor.min_range_m = read_f64(bytes, 72);
  sensor.max_range_m = read_f64(bytes, 80);
  sensor.min_elevation_rad = read_f64(bytes, 88);
  sensor.max_elevation_rad = read_f64(bytes, 96);
  for (uint32_t index = 0; index < sensor.custom_direction_count; ++index) {
    const uint32_t base = 160 + index * 24;
    sensor.custom_directions[index] = {
        read_f64(bytes, base),
        read_f64(bytes, base + 8),
        read_f64(bytes, base + 16)};
  }
  if (!finite(sensor.angular_resolution_rad) || sensor.angular_resolution_rad <= 0.0) {
    sensor.angular_resolution_rad = kPi / 18.0;
  }
  if (!finite(sensor.max_range_m) || sensor.max_range_m <= 0.0) {
    sensor.max_range_m = 2.0e7;
  }
  return sensor;
}

TargetRecord decode_target(const uint8_t* bytes) {
  return {read_f64(bytes, 0), read_f64(bytes, 8), read_f64(bytes, 16)};
}

LvlhFrame compute_lvlh_frame(const StateRecord& state) {
  const Vec3 radial = normalize(state.position);
  const Vec3 velocity_projection =
      subtract(state.velocity, scale(radial, dot(state.velocity, radial)));
  Vec3 along_track = magnitude(velocity_projection) > 0.0
                         ? normalize(velocity_projection)
                         : normalize(cross({0.0, 0.0, 1.0}, radial));
  Vec3 cross_track = normalize(cross(radial, along_track));
  return {radial, along_track, cross_track, scale(radial, -1.0)};
}

SensorAxes compose_sensor_axes(const LvlhFrame& frame, const SensorRecord& sensor) {
  Vec3 x_axis = frame.along_track;
  Vec3 y_axis = frame.cross_track;
  Vec3 z_axis = frame.nadir;

  y_axis = rotate_around_axis(y_axis, x_axis, sensor.roll_rad);
  z_axis = rotate_around_axis(z_axis, x_axis, sensor.roll_rad);
  x_axis = rotate_around_axis(x_axis, y_axis, sensor.pitch_rad);
  z_axis = rotate_around_axis(z_axis, y_axis, sensor.pitch_rad);
  x_axis = rotate_around_axis(x_axis, z_axis, sensor.yaw_rad);
  y_axis = rotate_around_axis(y_axis, z_axis, sensor.yaw_rad);

  return {normalize(x_axis), normalize(y_axis), normalize(z_axis)};
}

std::vector<Vec3> build_conical_directions(const SensorAxes& axes, const SensorRecord& sensor) {
  const double half_angle = finite(sensor.half_angle_rad) && sensor.half_angle_rad > 0.0
                                ? sensor.half_angle_rad
                                : 0.0;
  const uint32_t steps = std::max(
      16u,
      static_cast<uint32_t>(std::ceil(kTwoPi / sensor.angular_resolution_rad)));
  std::vector<Vec3> directions;
  directions.reserve(steps);
  for (uint32_t index = 0; index < steps; ++index) {
    const double angle = kTwoPi * static_cast<double>(index) / static_cast<double>(steps);
    directions.push_back(normalize(add(
        scale(axes.z, std::cos(half_angle)),
        add(
            scale(axes.x, std::cos(angle) * std::sin(half_angle)),
            scale(axes.y, std::sin(angle) * std::sin(half_angle))))));
  }
  return directions;
}

std::vector<Vec3> build_rectangular_directions(
    const SensorAxes& axes,
    const SensorRecord& sensor) {
  const double half_along = sensor.along_track_fov_rad * 0.5;
  const double half_cross = sensor.cross_track_fov_rad * 0.5;
  const double resolution = std::max(sensor.angular_resolution_rad, 1.0e-3);
  const uint32_t along_samples = std::max(
      3u,
      static_cast<uint32_t>(std::ceil(sensor.along_track_fov_rad / resolution)) + 1u);
  const uint32_t cross_samples = std::max(
      3u,
      static_cast<uint32_t>(std::ceil(sensor.cross_track_fov_rad / resolution)) + 1u);

  std::vector<Vec3> directions{};
  directions.reserve(along_samples * 2u + cross_samples * 2u);

  const auto push_direction = [&](double along_angle, double cross_angle) {
    directions.push_back(normalize(add(
        add(axes.z, scale(axes.x, std::tan(along_angle))),
        scale(axes.y, std::tan(cross_angle)))));
  };

  for (uint32_t index = 0; index < along_samples; ++index) {
    const double t = along_samples == 1u
                         ? 0.5
                         : static_cast<double>(index) /
                               static_cast<double>(along_samples - 1u);
    const double along_angle = -half_along + t * sensor.along_track_fov_rad;
    push_direction(along_angle, -half_cross);
  }
  for (uint32_t index = 1; index + 1u < cross_samples; ++index) {
    const double t =
        static_cast<double>(index) / static_cast<double>(cross_samples - 1u);
    const double cross_angle = -half_cross + t * sensor.cross_track_fov_rad;
    push_direction(half_along, cross_angle);
  }
  for (uint32_t remaining = along_samples; remaining > 0u; --remaining) {
    const uint32_t index = remaining - 1u;
    const double t = along_samples == 1u
                         ? 0.5
                         : static_cast<double>(index) /
                               static_cast<double>(along_samples - 1u);
    const double along_angle = -half_along + t * sensor.along_track_fov_rad;
    push_direction(along_angle, half_cross);
  }
  for (uint32_t remaining = cross_samples - 1u; remaining > 1u; --remaining) {
    const uint32_t index = remaining - 1u;
    const double t =
        static_cast<double>(index) / static_cast<double>(cross_samples - 1u);
    const double cross_angle = -half_cross + t * sensor.cross_track_fov_rad;
    push_direction(-half_along, cross_angle);
  }

  return directions;
}

std::vector<Vec3> build_custom_directions(
    const SensorAxes& axes,
    const SensorRecord& sensor) {
  if (sensor.custom_direction_count == 0u) {
    return build_conical_directions(axes, sensor);
  }

  std::vector<Vec3> directions{};
  directions.reserve(sensor.custom_direction_count);
  for (uint32_t index = 0; index < sensor.custom_direction_count; ++index) {
    const Vec3& direction = sensor.custom_directions[index];
    directions.push_back(normalize(add(
        add(scale(axes.x, direction.x), scale(axes.y, direction.y)),
        scale(axes.z, direction.z))));
  }
  return directions;
}

std::vector<Vec3> build_ray_directions(const LvlhFrame& frame, const SensorRecord& sensor) {
  const SensorAxes axes = compose_sensor_axes(frame, sensor);
  if (sensor.sensor_type == 1u) {
    return build_rectangular_directions(axes, sensor);
  }
  if (sensor.sensor_type == 2u) {
    return build_custom_directions(axes, sensor);
  }
  return build_conical_directions(axes, sensor);
}

std::vector<FootprintVertex> compute_footprint(
    const StateRecord& state,
    const SensorRecord& sensor) {
  const LvlhFrame frame = compute_lvlh_frame(state);
  const std::vector<Vec3> directions = build_ray_directions(frame, sensor);
  const Cartographic subpoint = ecef_to_geodetic(scale(normalize(state.position), kWgs84A));
  std::vector<FootprintVertex> vertices;
  vertices.reserve(directions.size());

  for (uint32_t index = 0; index < directions.size(); ++index) {
    Vec3 position{};
    Cartographic cartographic{};
    double range = 0.0;
    if (!project_ray_to_ellipsoid(
            state.position,
            directions[index],
            &position,
            &cartographic,
            &range)) {
      continue;
    }
    if (range < sensor.min_range_m || range > sensor.max_range_m) {
      continue;
    }
    const double look_angle = std::acos(clamp(
        dot(frame.nadir, normalize(subtract(position, state.position))),
        -1.0,
        1.0));
    vertices.push_back({
        cartographic.longitude,
        cartographic.latitude,
        cartographic.altitude,
        state.julian_date,
        haversine_distance(subpoint, cartographic),
        look_angle,
        0x03,
        index});
  }

  return vertices;
}

std::vector<GroundTrackPoint> compute_ground_track(const std::vector<StateRecord>& states) {
  std::vector<GroundTrackPoint> track{};
  track.reserve(states.size());
  for (const StateRecord& state : states) {
    const Cartographic cartographic = ecef_to_geodetic(state.position);
    track.push_back({
        state.julian_date,
        cartographic.longitude,
        cartographic.latitude,
        cartographic.altitude,
        0.0,
        0.0,
        0});
  }

  for (size_t index = 0; index < track.size(); ++index) {
    const GroundTrackPoint& current = track[index];
    const size_t next_index = std::min(index + 1, track.size() - 1);
    const size_t prev_index = index == 0 ? 0 : index - 1;
    const GroundTrackPoint& reference =
        next_index == index ? track[prev_index] : track[next_index];
    const Cartographic current_geo{current.longitude, current.latitude, current.altitude};
    const Cartographic reference_geo{
        reference.longitude, reference.latitude, reference.altitude};
    track[index].heading = heading_between(current_geo, reference_geo);
    const double delta_days = std::fabs(reference.julian_date - current.julian_date);
    const double delta_seconds = std::max(delta_days * 86400.0, 1.0e-6);
    track[index].speed = haversine_distance(current_geo, reference_geo) / delta_seconds;
  }

  return track;
}

bool point_on_segment(
    const TargetRecord& point,
    const FootprintVertex& start,
    const FootprintVertex& end) {
  const double cross_value =
      (point.latitude - start.latitude) * (end.longitude - start.longitude) -
      (point.longitude - start.longitude) * (end.latitude - start.latitude);
  if (std::fabs(cross_value) > 1.0e-12) {
    return false;
  }
  const double dot_value =
      (point.longitude - start.longitude) * (end.longitude - start.longitude) +
      (point.latitude - start.latitude) * (end.latitude - start.latitude);
  if (dot_value < 0.0) {
    return false;
  }
  const double segment_length_squared =
      (end.longitude - start.longitude) * (end.longitude - start.longitude) +
      (end.latitude - start.latitude) * (end.latitude - start.latitude);
  return dot_value <= segment_length_squared;
}

bool point_in_polygon(
    const TargetRecord& point,
    const std::vector<FootprintVertex>& vertices) {
  if (vertices.size() < 3) {
    return false;
  }
  bool inside = false;
  for (size_t index = 0; index < vertices.size(); ++index) {
    const FootprintVertex& current = vertices[index];
    const FootprintVertex& next = vertices[(index + 1) % vertices.size()];
    if (point_on_segment(point, current, next)) {
      return true;
    }
    const bool intersects =
        (current.latitude > point.latitude) != (next.latitude > point.latitude);
    if (!intersects) {
      continue;
    }
    const double intersect_lon =
        ((next.longitude - current.longitude) * (point.latitude - current.latitude)) /
            (next.latitude - current.latitude) +
        current.longitude;
    if (point.longitude <= intersect_lon) {
      inside = !inside;
    }
  }
  return inside;
}

AccessGeometry compute_access_geometry(
    const StateRecord& state,
    const SensorRecord& sensor,
    const TargetRecord& target) {
  const Vec3 target_position = geodetic_to_ecef(target);
  const Vec3 sensor_to_target = subtract(target_position, state.position);
  const Vec3 target_to_sensor = subtract(state.position, target_position);
  const double range = magnitude(sensor_to_target);
  const Vec3 sensor_to_target_unit = normalize(sensor_to_target);
  const Vec3 target_to_sensor_unit = normalize(target_to_sensor);
  const EnuFrame enu = create_enu_frame(target);
  const double east = dot(target_to_sensor_unit, enu.east);
  const double north = dot(target_to_sensor_unit, enu.north);
  const double up = dot(target_to_sensor_unit, enu.up);
  double azimuth = std::atan2(east, north);
  if (azimuth < 0.0) {
    azimuth += kTwoPi;
  }
  const LvlhFrame frame = compute_lvlh_frame(state);
  const double look_angle = std::acos(clamp(dot(frame.nadir, sensor_to_target_unit), -1.0, 1.0));
  const bool inside_footprint = point_in_polygon(target, compute_footprint(state, sensor));
  return {
      range,
      std::asin(clamp(up, -1.0, 1.0)),
      azimuth,
      range,
      look_angle,
      inside_footprint,
      false};
}

SwathResult compute_swath(const std::vector<StateRecord>& states, const SensorRecord& sensor) {
  SwathResult result{};
  const std::vector<GroundTrackPoint> ground_track = compute_ground_track(states);
  result.segments.reserve(states.size());

  for (size_t index = 0; index < states.size(); ++index) {
    const StateRecord& state = states[index];
    const std::vector<FootprintVertex> footprint = compute_footprint(state, sensor);
    const LvlhFrame frame = compute_lvlh_frame(state);
    const GroundTrackPoint& center = ground_track[index];
    const Vec3 subpoint = geodetic_to_ecef({center.longitude, center.latitude, 0.0});

    std::vector<DecoratedVertex> left_vertices{};
    std::vector<DecoratedVertex> right_vertices{};
    for (const FootprintVertex& vertex : footprint) {
      const Vec3 vertex_position =
          geodetic_to_ecef({vertex.longitude, vertex.latitude, vertex.altitude});
      const Vec3 offset = subtract(vertex_position, subpoint);
      const double along = dot(offset, frame.along_track);
      const double cross_track = dot(offset, frame.cross_track);
      DecoratedVertex decorated{vertex, along};
      if (cross_track <= 0.0) {
        left_vertices.push_back(decorated);
      } else {
        right_vertices.push_back(decorated);
      }
    }

    if (left_vertices.empty() && !footprint.empty()) {
      left_vertices.push_back({footprint.front(), 0.0});
    }
    if (right_vertices.empty() && footprint.size() > 1) {
      right_vertices.push_back({footprint.back(), 0.0});
    }

    const auto by_along = [](const DecoratedVertex& left, const DecoratedVertex& right) {
      return left.along_track < right.along_track;
    };
    std::sort(left_vertices.begin(), left_vertices.end(), by_along);
    std::sort(right_vertices.begin(), right_vertices.end(), by_along);

    SwathSegment segment{};
    segment.start_time = state.julian_date;
    segment.end_time = index + 1 < states.size() ? states[index + 1].julian_date : state.julian_date;
    segment.center_lon = center.longitude;
    segment.center_lat = center.latitude;
    segment.left_vertex_start = static_cast<uint32_t>(result.vertices.size());
    segment.left_vertex_count = static_cast<uint32_t>(left_vertices.size());
    for (const DecoratedVertex& vertex : left_vertices) {
      result.vertices.push_back(vertex.vertex);
    }
    segment.right_vertex_start = static_cast<uint32_t>(result.vertices.size());
    segment.right_vertex_count = static_cast<uint32_t>(right_vertices.size());
    for (const DecoratedVertex& vertex : right_vertices) {
      result.vertices.push_back(vertex.vertex);
    }
    result.segments.push_back(segment);
  }

  return result;
}

std::vector<uint8_t> encode_containment(bool inside) {
  std::vector<uint8_t> bytes(16);
  write_u32(bytes, 0, inside ? 1u : 0u);
  return bytes;
}

std::vector<uint8_t> encode_access_geometry(const AccessGeometry& geometry) {
  std::vector<uint8_t> bytes(64);
  write_f64(bytes, 0, geometry.range);
  write_f64(bytes, 8, geometry.elevation);
  write_f64(bytes, 16, geometry.azimuth);
  write_f64(bytes, 24, geometry.slant_range);
  write_f64(bytes, 32, geometry.look_angle);
  write_u32(bytes, 48, geometry.is_visible ? 1u : 0u);
  write_u32(bytes, 52, geometry.is_occluded ? 1u : 0u);
  return bytes;
}

std::vector<uint8_t> encode_swath(const SwathResult& swath) {
  std::vector<uint8_t> bytes(
      32 + swath.segments.size() * kSwathSegmentSize +
      swath.vertices.size() * kFootprintVertexSize);
  write_u32(bytes, 0, static_cast<uint32_t>(swath.segments.size()));
  write_u32(bytes, 4, static_cast<uint32_t>(swath.vertices.size()));
  write_u32(bytes, 8, kSwathSegmentSize);
  write_u32(bytes, 12, kFootprintVertexSize);
  for (size_t index = 0; index < swath.segments.size(); ++index) {
    const SwathSegment& segment = swath.segments[index];
    const uint32_t base = 32 + static_cast<uint32_t>(index) * kSwathSegmentSize;
    write_f64(bytes, base, segment.start_time);
    write_f64(bytes, base + 8, segment.end_time);
    write_f64(bytes, base + 16, segment.center_lon);
    write_f64(bytes, base + 24, segment.center_lat);
    write_u32(bytes, base + 32, segment.left_vertex_start);
    write_u32(bytes, base + 36, segment.left_vertex_count);
    write_u32(bytes, base + 40, segment.right_vertex_start);
    write_u32(bytes, base + 44, segment.right_vertex_count);
  }
  const uint32_t vertex_offset =
      32 + static_cast<uint32_t>(swath.segments.size()) * kSwathSegmentSize;
  for (size_t index = 0; index < swath.vertices.size(); ++index) {
    const FootprintVertex& vertex = swath.vertices[index];
    const uint32_t base = vertex_offset + static_cast<uint32_t>(index) * kFootprintVertexSize;
    write_f64(bytes, base, vertex.longitude);
    write_f64(bytes, base + 8, vertex.latitude);
    write_f64(bytes, base + 16, vertex.altitude);
    write_f64(bytes, base + 24, vertex.julian_date);
    write_f64(bytes, base + 32, vertex.ground_range);
    write_f64(bytes, base + 40, vertex.look_angle);
    write_u32(bytes, base + 48, vertex.flags);
    write_u32(bytes, base + 52, vertex.vertex_index);
  }
  return bytes;
}

std::vector<uint8_t> encode_footprint(const std::vector<FootprintVertex>& vertices) {
  std::vector<uint8_t> bytes(16 + vertices.size() * kFootprintVertexSize);
  write_u32(bytes, 0, static_cast<uint32_t>(vertices.size()));
  write_u32(bytes, 4, kFootprintVertexSize);
  for (uint32_t index = 0; index < vertices.size(); ++index) {
    const FootprintVertex& vertex = vertices[index];
    const uint32_t base = 16 + index * kFootprintVertexSize;
    write_f64(bytes, base, vertex.longitude);
    write_f64(bytes, base + 8, vertex.latitude);
    write_f64(bytes, base + 16, vertex.altitude);
    write_f64(bytes, base + 24, vertex.julian_date);
    write_f64(bytes, base + 32, vertex.ground_range);
    write_f64(bytes, base + 40, vertex.look_angle);
    write_u32(bytes, base + 48, vertex.flags);
    write_u32(bytes, base + 52, vertex.vertex_index);
  }
  return bytes;
}

std::vector<uint8_t> encode_ground_track(const std::vector<GroundTrackPoint>& points) {
  std::vector<uint8_t> bytes(16 + points.size() * kGroundTrackPointSize);
  write_u32(bytes, 0, static_cast<uint32_t>(points.size()));
  write_u32(bytes, 4, kGroundTrackPointSize);
  for (size_t index = 0; index < points.size(); ++index) {
    const uint32_t base = 16 + static_cast<uint32_t>(index) * kGroundTrackPointSize;
    write_f64(bytes, base, points[index].julian_date);
    write_f64(bytes, base + 8, points[index].longitude);
    write_f64(bytes, base + 16, points[index].latitude);
    write_f64(bytes, base + 24, points[index].altitude);
    write_f64(bytes, base + 32, points[index].heading);
    write_f64(bytes, base + 40, points[index].speed);
    write_u32(bytes, base + 48, points[index].flags);
  }
  return bytes;
}

const plugin_input_frame_t* find_request_frame() {
  const uint32_t input_count = plugin_get_input_count();
  for (uint32_t index = 0; index < input_count; ++index) {
    const plugin_input_frame_t* frame = plugin_get_input_frame(index);
    if (frame != nullptr && frame->port_id != nullptr &&
        std::strcmp(frame->port_id, "request") == 0) {
      return frame;
    }
  }
  return nullptr;
}

int unsupported_method(const char* method) {
  plugin_reset_output_state();
  plugin_set_error(method, "Swath native method is not implemented in this migration slice.");
  return 4;
}

}  // namespace

extern "C" int project_footprint(void) {
  plugin_reset_output_state();
  const plugin_input_frame_t* frame = find_request_frame();
  if (frame == nullptr || frame->payload == nullptr ||
      frame->payload_length < kStateRecordSize + kSensorRecordSize) {
    plugin_set_error("missing-request", "Swath footprint request is missing or too short.");
    return 3;
  }

  const StateRecord state = decode_state(frame->payload);
  const SensorRecord sensor = decode_sensor(frame->payload + kStateRecordSize);
  if (!finite(state.position) || !finite(state.velocity)) {
    plugin_set_error("invalid-request", "Swath state vector contains non-finite values.");
    return 3;
  }

  const std::vector<uint8_t> output = encode_footprint(compute_footprint(state, sensor));
  if (plugin_push_output(
          "results",
          "orbpro.analysis.SwathFootprintResult",
          "SFPR",
          output.data(),
          static_cast<uint32_t>(output.size())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit swath footprint result.");
    return 1;
  }
  return 0;
}

extern "C" int ground_track(void) {
  plugin_reset_output_state();
  const plugin_input_frame_t* frame = find_request_frame();
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 16) {
    plugin_set_error("missing-request", "Swath ground-track request is missing or too short.");
    return 3;
  }

  std::vector<StateRecord> states{};
  if (!decode_state_batch(frame->payload, frame->payload_length, &states)) {
    plugin_set_error("invalid-request", "Swath ground-track state batch is malformed.");
    return 3;
  }

  const std::vector<uint8_t> output = encode_ground_track(compute_ground_track(states));
  if (plugin_push_output(
          "results",
          "orbpro.analysis.SwathGroundTrackResult",
          "SGRS",
          output.data(),
          static_cast<uint32_t>(output.size())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit swath ground-track result.");
    return 1;
  }
  return 0;
}

extern "C" int generate_swath(void) {
  plugin_reset_output_state();
  const plugin_input_frame_t* frame = find_request_frame();
  if (frame == nullptr || frame->payload == nullptr ||
      frame->payload_length < 16u + kSensorRecordSize) {
    plugin_set_error("missing-request", "Swath generation request is missing or too short.");
    return 3;
  }

  SensorRecord sensor{};
  std::vector<StateRecord> states{};
  if (!decode_swath_request(frame->payload, frame->payload_length, &sensor, &states)) {
    plugin_set_error("invalid-request", "Swath generation request is malformed.");
    return 3;
  }

  const std::vector<uint8_t> output = encode_swath(compute_swath(states, sensor));
  if (plugin_push_output(
          "results",
          "orbpro.analysis.SwathGenerationResult",
          "SWAS",
          output.data(),
          static_cast<uint32_t>(output.size())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit swath generation result.");
    return 1;
  }
  return 0;
}

extern "C" int point_in_footprint(void) {
  plugin_reset_output_state();
  const plugin_input_frame_t* frame = find_request_frame();
  if (frame == nullptr || frame->payload == nullptr ||
      frame->payload_length < kStateRecordSize + kSensorRecordSize + kTargetRecordSize) {
    plugin_set_error("missing-request", "Swath containment request is missing or too short.");
    return 3;
  }

  const StateRecord state = decode_state(frame->payload);
  const SensorRecord sensor = decode_sensor(frame->payload + kStateRecordSize);
  const TargetRecord target =
      decode_target(frame->payload + kStateRecordSize + kSensorRecordSize);
  if (!finite(state.position) || !finite(state.velocity) ||
      !std::isfinite(target.longitude) || !std::isfinite(target.latitude)) {
    plugin_set_error("invalid-request", "Swath containment request contains non-finite values.");
    return 3;
  }

  const bool inside = point_in_polygon(target, compute_footprint(state, sensor));
  const std::vector<uint8_t> output = encode_containment(inside);
  if (plugin_push_output(
          "results",
          "orbpro.analysis.SwathContainmentResult",
          "SPIR",
          output.data(),
          static_cast<uint32_t>(output.size())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit swath containment result.");
    return 1;
  }
  return 0;
}

extern "C" int access_geometry(void) {
  plugin_reset_output_state();
  const plugin_input_frame_t* frame = find_request_frame();
  if (frame == nullptr || frame->payload == nullptr ||
      frame->payload_length < kStateRecordSize + kSensorRecordSize + kTargetRecordSize) {
    plugin_set_error("missing-request", "Swath access-geometry request is missing or too short.");
    return 3;
  }

  const StateRecord state = decode_state(frame->payload);
  const SensorRecord sensor = decode_sensor(frame->payload + kStateRecordSize);
  const TargetRecord target =
      decode_target(frame->payload + kStateRecordSize + kSensorRecordSize);
  if (!finite(state.position) || !finite(state.velocity) ||
      !std::isfinite(target.longitude) || !std::isfinite(target.latitude) ||
      !std::isfinite(target.altitude)) {
    plugin_set_error("invalid-request", "Swath access-geometry request contains non-finite values.");
    return 3;
  }

  const std::vector<uint8_t> output =
      encode_access_geometry(compute_access_geometry(state, sensor, target));
  if (plugin_push_output(
          "results",
          "orbpro.analysis.SwathAccessResult",
          "SAPR",
          output.data(),
          static_cast<uint32_t>(output.size())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit swath access-geometry result.");
    return 1;
  }
  return 0;
}
