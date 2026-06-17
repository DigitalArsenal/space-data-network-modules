/*
 ISC License

 Native GNSS dilution-of-precision kernel for the SDK standalone C++ surface.
 The aligned-binary layout keeps the initial contract intentionally small:
 receiver ECEF/geodetic coordinates plus satellite ECEF positions.
 */

#include "space_data_module_invoke.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr uint32_t kRequestHeaderSize = 80;
constexpr uint32_t kSatelliteRecordSize = 32;

struct Vec3 {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

struct Satellite {
  Vec3 position;
  double weight = 1.0;
};

struct DopRequest {
  uint32_t satellite_count = 0;
  double elevation_mask_rad = -kPi * 0.5;
  Vec3 receiver_position;
  double receiver_longitude_rad = 0.0;
  double receiver_latitude_rad = 0.0;
  std::vector<Satellite> satellites{};
};

struct EnuFrame {
  Vec3 east;
  Vec3 north;
  Vec3 up;
};

struct DopResult {
  double gdop = 0.0;
  double pdop = 0.0;
  double hdop = 0.0;
  double vdop = 0.0;
  double tdop = 0.0;
  uint32_t used_satellites = 0;
  uint32_t status = 0;
};

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

bool finite(double value) {
  return std::isfinite(value);
}

bool finite(const Vec3& value) {
  return finite(value.x) && finite(value.y) && finite(value.z);
}

double dot(const Vec3& left, const Vec3& right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

Vec3 subtract(const Vec3& left, const Vec3& right) {
  return {left.x - right.x, left.y - right.y, left.z - right.z};
}

Vec3 scale(const Vec3& vector, double scalar) {
  return {vector.x * scalar, vector.y * scalar, vector.z * scalar};
}

double magnitude(const Vec3& vector) {
  return std::hypot(vector.x, vector.y, vector.z);
}

Vec3 normalize(const Vec3& vector) {
  const double length = magnitude(vector);
  if (!finite(length) || length <= 0.0) {
    return {};
  }
  return scale(vector, 1.0 / length);
}

EnuFrame create_enu_frame(double longitude, double latitude) {
  const double sin_lon = std::sin(longitude);
  const double cos_lon = std::cos(longitude);
  const double sin_lat = std::sin(latitude);
  const double cos_lat = std::cos(latitude);
  return {
      {-sin_lon, cos_lon, 0.0},
      {-sin_lat * cos_lon, -sin_lat * sin_lon, cos_lat},
      {cos_lat * cos_lon, cos_lat * sin_lon, sin_lat}};
}

bool decode_request(const uint8_t* bytes, uint32_t length, DopRequest* request) {
  if (bytes == nullptr || request == nullptr || length < kRequestHeaderSize) {
    return false;
  }
  const uint32_t satellite_count = read_u32(bytes, 0);
  if (satellite_count > 100000u ||
      length < kRequestHeaderSize + satellite_count * kSatelliteRecordSize) {
    return false;
  }

  request->satellite_count = satellite_count;
  request->elevation_mask_rad = read_f64(bytes, 8);
  request->receiver_position = {
      read_f64(bytes, 16),
      read_f64(bytes, 24),
      read_f64(bytes, 32)};
  request->receiver_longitude_rad = read_f64(bytes, 40);
  request->receiver_latitude_rad = read_f64(bytes, 48);
  if (!finite(request->elevation_mask_rad)) {
    request->elevation_mask_rad = -kPi * 0.5;
  }
  if (!finite(request->receiver_position) ||
      !finite(request->receiver_longitude_rad) ||
      !finite(request->receiver_latitude_rad)) {
    return false;
  }

  request->satellites.clear();
  request->satellites.reserve(satellite_count);
  uint32_t cursor = kRequestHeaderSize;
  for (uint32_t index = 0; index < satellite_count; ++index) {
    Satellite satellite{};
    satellite.position = {
        read_f64(bytes, cursor),
        read_f64(bytes, cursor + 8),
        read_f64(bytes, cursor + 16)};
    satellite.weight = read_f64(bytes, cursor + 24);
    if (!finite(satellite.position)) {
      return false;
    }
    if (!finite(satellite.weight) || satellite.weight <= 0.0) {
      satellite.weight = 1.0;
    }
    request->satellites.push_back(satellite);
    cursor += kSatelliteRecordSize;
  }
  return true;
}

bool invert_4x4(const double input[4][4], double inverse[4][4]) {
  double augmented[4][8]{};
  for (uint32_t row = 0; row < 4; ++row) {
    for (uint32_t column = 0; column < 4; ++column) {
      augmented[row][column] = input[row][column];
    }
    augmented[row][row + 4] = 1.0;
  }

  for (uint32_t column = 0; column < 4; ++column) {
    uint32_t pivot = column;
    double pivot_abs = std::fabs(augmented[pivot][column]);
    for (uint32_t row = column + 1; row < 4; ++row) {
      const double candidate_abs = std::fabs(augmented[row][column]);
      if (candidate_abs > pivot_abs) {
        pivot = row;
        pivot_abs = candidate_abs;
      }
    }
    if (pivot_abs < 1.0e-14 || !finite(pivot_abs)) {
      return false;
    }
    if (pivot != column) {
      for (uint32_t entry = 0; entry < 8; ++entry) {
        std::swap(augmented[pivot][entry], augmented[column][entry]);
      }
    }

    const double divisor = augmented[column][column];
    for (uint32_t entry = 0; entry < 8; ++entry) {
      augmented[column][entry] /= divisor;
    }
    for (uint32_t row = 0; row < 4; ++row) {
      if (row == column) {
        continue;
      }
      const double factor = augmented[row][column];
      for (uint32_t entry = 0; entry < 8; ++entry) {
        augmented[row][entry] -= factor * augmented[column][entry];
      }
    }
  }

  for (uint32_t row = 0; row < 4; ++row) {
    for (uint32_t column = 0; column < 4; ++column) {
      inverse[row][column] = augmented[row][column + 4];
    }
  }
  return true;
}

double quadratic_form(const double matrix[3][3], const Vec3& vector) {
  const Vec3 product{
      matrix[0][0] * vector.x + matrix[0][1] * vector.y + matrix[0][2] * vector.z,
      matrix[1][0] * vector.x + matrix[1][1] * vector.y + matrix[1][2] * vector.z,
      matrix[2][0] * vector.x + matrix[2][1] * vector.y + matrix[2][2] * vector.z};
  return dot(vector, product);
}

double safe_sqrt(double value) {
  return std::sqrt(std::max(value, 0.0));
}

DopResult compute_dop_result(const DopRequest& request) {
  const EnuFrame enu =
      create_enu_frame(request.receiver_longitude_rad, request.receiver_latitude_rad);

  double normal[4][4]{};
  uint32_t used_satellites = 0;
  for (const Satellite& satellite : request.satellites) {
    const Vec3 relative = subtract(satellite.position, request.receiver_position);
    const double range = magnitude(relative);
    if (!finite(range) || range <= 0.0) {
      continue;
    }
    const Vec3 los = scale(relative, 1.0 / range);
    const double elevation = std::asin(std::max(-1.0, std::min(1.0, dot(los, enu.up))));
    if (elevation < request.elevation_mask_rad) {
      continue;
    }
    const double row[4] = {-los.x, -los.y, -los.z, 1.0};
    for (uint32_t i = 0; i < 4; ++i) {
      for (uint32_t j = 0; j < 4; ++j) {
        normal[i][j] += satellite.weight * row[i] * row[j];
      }
    }
    ++used_satellites;
  }

  DopResult result{};
  result.used_satellites = used_satellites;
  if (used_satellites < 4u) {
    result.status = 2;
    return result;
  }

  double inverse[4][4]{};
  if (!invert_4x4(normal, inverse)) {
    result.status = 3;
    return result;
  }

  const double qpos[3][3] = {
      {inverse[0][0], inverse[0][1], inverse[0][2]},
      {inverse[1][0], inverse[1][1], inverse[1][2]},
      {inverse[2][0], inverse[2][1], inverse[2][2]}};
  const double q_east = quadratic_form(qpos, enu.east);
  const double q_north = quadratic_form(qpos, enu.north);
  const double q_up = quadratic_form(qpos, enu.up);
  const double q_time = inverse[3][3];

  result.pdop = safe_sqrt(inverse[0][0] + inverse[1][1] + inverse[2][2]);
  result.hdop = safe_sqrt(q_east + q_north);
  result.vdop = safe_sqrt(q_up);
  result.tdop = safe_sqrt(q_time);
  result.gdop = safe_sqrt(result.pdop * result.pdop + result.tdop * result.tdop);
  result.status = 0;
  return result;
}

std::vector<uint8_t> encode_result(const DopResult& result) {
  std::vector<uint8_t> bytes(64);
  write_f64(bytes, 0, result.gdop);
  write_f64(bytes, 8, result.pdop);
  write_f64(bytes, 16, result.hdop);
  write_f64(bytes, 24, result.vdop);
  write_f64(bytes, 32, result.tdop);
  write_u32(bytes, 40, result.used_satellites);
  write_u32(bytes, 44, result.status);
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

}  // namespace

extern "C" int compute_dop(void) {
  plugin_reset_output_state();
  const plugin_input_frame_t* frame = find_request_frame();
  if (frame == nullptr || frame->payload == nullptr) {
    plugin_set_error("missing-request", "DOP request frame is required.");
    return 3;
  }

  DopRequest request{};
  if (!decode_request(frame->payload, frame->payload_length, &request)) {
    plugin_set_error("invalid-request", "DOP request is malformed.");
    return 3;
  }

  const std::vector<uint8_t> output = encode_result(compute_dop_result(request));
  if (plugin_push_output(
          "results",
          "orbpro.analysis.DopResult",
          "DOPR",
          output.data(),
          static_cast<uint32_t>(output.size())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit DOP result.");
    return 1;
  }
  return 0;
}
