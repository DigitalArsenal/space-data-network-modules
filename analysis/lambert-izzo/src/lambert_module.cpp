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
  if (request->TOF_SEC() <= 0.0) {
    return emit_error_lmo(
        request_id,
        "invalid-time-of-flight",
        "Lambert time of flight must be greater than zero seconds.");
  }

  plugin_set_error(
      "solver-not-implemented",
      "Lambert solver runtime is not implemented yet; request validation passed.");
  return 501;
}
