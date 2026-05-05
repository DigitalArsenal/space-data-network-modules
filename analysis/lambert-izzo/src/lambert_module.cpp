#include "space_data_module_invoke.h"

#include <cmath>
#include <cstdint>
#include <string>

namespace {

const plugin_input_frame_t* find_request_frame() {
  const uint32_t input_count = plugin_get_input_count();
  for (uint32_t index = 0; index < input_count; ++index) {
    const plugin_input_frame_t* frame = plugin_get_input_frame(index);
    if (frame != nullptr && frame->port_id != nullptr &&
        std::string(frame->port_id) == "request") {
      return frame;
    }
  }
  return nullptr;
}

int emit_error_lmo(const std::string& request_id, const char* code, const char* message) {
  flatbuffers::FlatBufferBuilder builder(256);
  const auto result = CreateLMODirect(
      builder,
      request_id.empty() ? nullptr : request_id.c_str(),
      lambertSolveState_ERROR,
      code,
      message);
  FinishLMOBuffer(builder, result);

  if (plugin_push_output(
          "solutions",
          "spacedata.LMO",
          "LMO",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit Lambert solve output.");
    return 1;
  }
  return 0;
}

bool all_finite(const LMS& request) {
  return std::isfinite(request.R1_X()) &&
         std::isfinite(request.R1_Y()) &&
         std::isfinite(request.R1_Z()) &&
         std::isfinite(request.R2_X()) &&
         std::isfinite(request.R2_Y()) &&
         std::isfinite(request.R2_Z()) &&
         std::isfinite(request.TOF_SEC()) &&
         std::isfinite(request.MU_KM3_S2());
}

double vector_norm(double x, double y, double z) {
  return std::sqrt((x * x) + (y * y) + (z * z));
}

double cross_norm(const LMS& request) {
  const double cx = (request.R1_Y() * request.R2_Z()) - (request.R1_Z() * request.R2_Y());
  const double cy = (request.R1_Z() * request.R2_X()) - (request.R1_X() * request.R2_Z());
  const double cz = (request.R1_X() * request.R2_Y()) - (request.R1_Y() * request.R2_X());
  return vector_norm(cx, cy, cz);
}

std::string request_id_from(const LMS& request) {
  const flatbuffers::String* request_id = request.REQUEST_ID();
  return request_id == nullptr ? std::string() : request_id->str();
}

}  // namespace

extern "C" int solve_lambert(void) {
  const plugin_input_frame_t* frame = find_request_frame();
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0) {
    plugin_set_error("missing-request", "Lambert solve requires one LMS request frame.");
    return 1;
  }

  flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyLMSBuffer(verifier)) {
    plugin_set_error("invalid-request-buffer", "Lambert request is not a valid LMS FlatBuffer.");
    return 1;
  }

  const LMS* request = GetLMS(frame->payload);
  const std::string request_id = request_id_from(*request);

  if (!all_finite(*request)) {
    return emit_error_lmo(
        request_id,
        "non-finite-input",
        "Lambert request contains a non-finite numeric input.");
  }
  if (vector_norm(request->R1_X(), request->R1_Y(), request->R1_Z()) <= 0.0 ||
      vector_norm(request->R2_X(), request->R2_Y(), request->R2_Z()) <= 0.0) {
    return emit_error_lmo(
        request_id,
        "invalid-position-vector",
        "Lambert request position vectors must have non-zero length.");
  }
  if (request->TOF_SEC() <= 0.0) {
    return emit_error_lmo(
        request_id,
        "invalid-time-of-flight",
        "Lambert time of flight must be greater than zero seconds.");
  }
  if (request->MU_KM3_S2() <= 0.0) {
    return emit_error_lmo(
        request_id,
        "invalid-gravitational-parameter",
        "Lambert gravitational parameter must be greater than zero km^3/s^2.");
  }
  if (request->MAX_REVS() > 32) {
    return emit_error_lmo(
        request_id,
        "invalid-revolution-budget",
        "Lambert revolution budget must be in the range 0..32.");
  }
  if (cross_norm(*request) <= 0.0) {
    return emit_error_lmo(
        request_id,
        "unsupported-geometry",
        "Lambert request uses unsupported collinear transfer geometry.");
  }

  plugin_set_error(
      "solver-not-implemented",
      "Lambert solver runtime is not implemented yet; request validation passed.");
  return 501;
}
