/*
 ISC License

 Copyright (c) 2024, Autonomous Vehicle Systems Lab, University of Colorado at Boulder

 Permission to use, copy, modify, and/or distribute this software for any
 purpose with or without fee is hereby granted, provided that the above
 copyright notice and this permission notice appear in all copies.

 THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

 This module ports selected Basilisk geodeticConversion utilities to the SDK's
 standalone C++/WASI surface and SDS FRM FlatBuffer envelopes.
 */

#include "space_data_module_invoke.h"

#include <cmath>
#include <cstdint>
#include <cstring>

namespace {

constexpr double kSmall = 1e-15;

struct Vec3 {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

struct Matrix3 {
  double m11 = 0.0;
  double m12 = 0.0;
  double m13 = 0.0;
  double m21 = 0.0;
  double m22 = 0.0;
  double m23 = 0.0;
  double m31 = 0.0;
  double m32 = 0.0;
  double m33 = 0.0;
};

struct TransformOutput {
  frmResultStatus status = frmResultStatus_OK;
  const char* message = nullptr;
  Vec3 position;
};

bool is_finite(double value) {
  return std::isfinite(value);
}

bool is_finite(const Vec3& value) {
  return is_finite(value.x) && is_finite(value.y) && is_finite(value.z);
}

bool is_finite(const Matrix3& value) {
  return is_finite(value.m11) && is_finite(value.m12) && is_finite(value.m13) &&
      is_finite(value.m21) && is_finite(value.m22) && is_finite(value.m23) &&
      is_finite(value.m31) && is_finite(value.m32) && is_finite(value.m33);
}

Vec3 read_vec3(const FRMVector3* value) {
  if (value == nullptr) {
    return {};
  }
  return {value->X(), value->Y(), value->Z()};
}

Matrix3 read_matrix(const FRMMatrix3* value) {
  if (value == nullptr) {
    return {};
  }
  return {
      value->M11(), value->M12(), value->M13(),
      value->M21(), value->M22(), value->M23(),
      value->M31(), value->M32(), value->M33()};
}

Vec3 multiply(const Matrix3& matrix, const Vec3& vector) {
  return {
      matrix.m11 * vector.x + matrix.m12 * vector.y + matrix.m13 * vector.z,
      matrix.m21 * vector.x + matrix.m22 * vector.y + matrix.m23 * vector.z,
      matrix.m31 * vector.x + matrix.m32 * vector.y + matrix.m33 * vector.z};
}

Vec3 transpose_multiply(const Matrix3& matrix, const Vec3& vector) {
  return {
      matrix.m11 * vector.x + matrix.m21 * vector.y + matrix.m31 * vector.z,
      matrix.m12 * vector.x + matrix.m22 * vector.y + matrix.m32 * vector.z,
      matrix.m13 * vector.x + matrix.m23 * vector.y + matrix.m33 * vector.z};
}

bool valid_equatorial_radius(double equatorial_radius_m) {
  return is_finite(equatorial_radius_m) && equatorial_radius_m > 0.0;
}

bool valid_ellipsoid_or_sphere(double equatorial_radius_m, double polar_radius_m) {
  if (!valid_equatorial_radius(equatorial_radius_m) || !is_finite(polar_radius_m)) {
    return false;
  }
  return polar_radius_m < 0.0 ||
      (polar_radius_m > 0.0 && equatorial_radius_m >= polar_radius_m);
}

bool lla_to_pcpf(
    const Vec3& lla,
    double equatorial_radius_m,
    double polar_radius_m,
    Vec3* output) {
  if (output == nullptr || !is_finite(lla) ||
      !valid_ellipsoid_or_sphere(equatorial_radius_m, polar_radius_m)) {
    return false;
  }

  const double sin_lat = std::sin(lla.x);
  const double cos_lat = std::cos(lla.x);
  const double sin_lon = std::sin(lla.y);
  const double cos_lon = std::cos(lla.y);
  double flattening_term = 0.0;
  if (polar_radius_m >= 0.0) {
    flattening_term =
        (equatorial_radius_m * equatorial_radius_m - polar_radius_m * polar_radius_m) /
        (equatorial_radius_m * equatorial_radius_m);
  }
  const double normal_radius =
      equatorial_radius_m / std::sqrt(1.0 - flattening_term * sin_lat * sin_lat);

  output->x = (normal_radius + lla.z) * cos_lat * cos_lon;
  output->y = (normal_radius + lla.z) * cos_lat * sin_lon;
  output->z = (normal_radius * (1.0 - flattening_term) + lla.z) * sin_lat;
  return is_finite(*output);
}

bool pcpf_to_lla(
    const Vec3& pcpf,
    double equatorial_radius_m,
    double polar_radius_m,
    Vec3* output) {
  if (output == nullptr || !is_finite(pcpf) ||
      !valid_ellipsoid_or_sphere(equatorial_radius_m, polar_radius_m)) {
    return false;
  }

  const double p = std::hypot(pcpf.x, pcpf.y);
  if (polar_radius_m < 0.0) {
    *output = {
        std::atan2(pcpf.z, p),
        std::atan2(pcpf.y, pcpf.x),
        std::sqrt(p * p + pcpf.z * pcpf.z) - equatorial_radius_m};
    return is_finite(*output);
  }

  if (p <= kSmall && std::fabs(pcpf.z) <= kSmall) {
    return false;
  }

  const double a2 = equatorial_radius_m * equatorial_radius_m;
  const double b2 = polar_radius_m * polar_radius_m;
  const double first_eccentricity_squared = (a2 - b2) / a2;
  const double second_eccentricity_squared = (a2 - b2) / b2;
  const double theta = std::atan2(pcpf.z * equatorial_radius_m, p * polar_radius_m);
  const double sin_theta = std::sin(theta);
  const double cos_theta = std::cos(theta);
  const double latitude = std::atan2(
      pcpf.z + second_eccentricity_squared * polar_radius_m * sin_theta * sin_theta * sin_theta,
      p - first_eccentricity_squared * equatorial_radius_m * cos_theta * cos_theta * cos_theta);
  const double longitude = std::atan2(pcpf.y, pcpf.x);
  const double sin_latitude = std::sin(latitude);
  const double cos_latitude = std::cos(latitude);
  if (std::fabs(cos_latitude) <= kSmall) {
    return false;
  }

  const double normal_radius =
      equatorial_radius_m / std::sqrt(1.0 - first_eccentricity_squared * sin_latitude * sin_latitude);
  const double altitude = p / cos_latitude - normal_radius;

  *output = {latitude, longitude, altitude};
  return is_finite(*output);
}

TransformOutput evaluate_frame_transform(const FRMFrameTransformRequest* request) {
  if (request == nullptr) {
    return {frmResultStatus_INVALID_INPUT, "Frame transform request is missing.", {}};
  }
  if (request->POSITION() == nullptr) {
    return {frmResultStatus_INVALID_INPUT, "Frame transform request requires POSITION.", {}};
  }

  const Vec3 position = read_vec3(request->POSITION());
  if (!is_finite(position)) {
    return {frmResultStatus_INVALID_INPUT, "Frame transform request contains a non-finite POSITION.", {}};
  }

  switch (request->OPERATION()) {
    case frmOperationCode_PCI_TO_PCPF: {
      if (request->TRANSFORM_DCM() == nullptr) {
        return {frmResultStatus_INVALID_INPUT, "PCI_TO_PCPF requires TRANSFORM_DCM.", {}};
      }
      const Matrix3 transform = read_matrix(request->TRANSFORM_DCM());
      if (!is_finite(transform)) {
        return {frmResultStatus_INVALID_INPUT, "PCI_TO_PCPF received a non-finite TRANSFORM_DCM.", {}};
      }
      return {frmResultStatus_OK, nullptr, multiply(transform, position)};
    }
    case frmOperationCode_PCPF_TO_PCI: {
      if (request->TRANSFORM_DCM() == nullptr) {
        return {frmResultStatus_INVALID_INPUT, "PCPF_TO_PCI requires TRANSFORM_DCM.", {}};
      }
      const Matrix3 transform = read_matrix(request->TRANSFORM_DCM());
      if (!is_finite(transform)) {
        return {frmResultStatus_INVALID_INPUT, "PCPF_TO_PCI received a non-finite TRANSFORM_DCM.", {}};
      }
      return {frmResultStatus_OK, nullptr, transpose_multiply(transform, position)};
    }
    case frmOperationCode_LLA_TO_PCPF: {
      Vec3 output;
      if (!lla_to_pcpf(position, request->EQUATORIAL_RADIUS_M(), request->POLAR_RADIUS_M(), &output)) {
        return {frmResultStatus_INVALID_INPUT, "LLA_TO_PCPF received invalid geodetic or ellipsoid parameters.", {}};
      }
      return {frmResultStatus_OK, nullptr, output};
    }
    case frmOperationCode_PCPF_TO_LLA: {
      Vec3 output;
      if (!pcpf_to_lla(position, request->EQUATORIAL_RADIUS_M(), request->POLAR_RADIUS_M(), &output)) {
        return {frmResultStatus_INVALID_INPUT, "PCPF_TO_LLA received invalid Cartesian or ellipsoid parameters.", {}};
      }
      return {frmResultStatus_OK, nullptr, output};
    }
    case frmOperationCode_UNKNOWN:
    default:
      return {frmResultStatus_UNSUPPORTED_OPERATION, "FRM operation is not supported.", {}};
  }
}

int emit_frame_transform_result(const TransformOutput& output, const char* trace_id) {
  ::flatbuffers::FlatBufferBuilder builder(1024);
  const auto position = CreateFRMVector3(builder, output.position.x, output.position.y, output.position.z);
  const auto result = CreateFRMFrameTransformResultDirect(
      builder,
      output.status,
      output.message,
      position,
      trace_id);
  const auto envelope = CreateFRM(builder, 0, result);
  FinishFRMBuffer(builder, envelope);

  if (plugin_push_output(
          "result",
          "FRM.fbs",
          "$FRM",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit FRM frame-transform result.");
    return 1;
  }
  return 0;
}

const plugin_input_frame_t* find_request_frame() {
  const uint32_t input_count = plugin_get_input_count();
  for (uint32_t index = 0; index < input_count; ++index) {
    const plugin_input_frame_t* frame = plugin_get_input_frame(index);
    if (frame != nullptr && frame->port_id != nullptr && std::strcmp(frame->port_id, "request") == 0) {
      return frame;
    }
  }
  return nullptr;
}

}  // namespace

extern "C" int transform_frame_position(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_request_frame();
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0) {
    plugin_set_error("missing-request", "No FRM frame-transform request frame was provided.");
    return 3;
  }
  if (!FRMBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-request-buffer", "Input is not an SDS FRM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyFRMBuffer(verifier)) {
    plugin_set_error("invalid-request-buffer", "Input is not a valid SDS FRM FlatBuffer.");
    return 3;
  }

  const FRM* envelope = GetFRM(frame->payload);
  const FRMFrameTransformRequest* request = envelope ? envelope->FRAME_TRANSFORM_REQUEST() : nullptr;
  const char* trace_id = request && request->TRACE_ID() ? request->TRACE_ID()->c_str() : nullptr;
  return emit_frame_transform_result(evaluate_frame_transform(request), trace_id);
}
