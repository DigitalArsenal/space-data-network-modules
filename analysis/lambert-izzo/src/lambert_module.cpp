#include "space_data_module_invoke.h"
#ifndef LAMBERT_IZZO_SOLVER_HPP
#include "lambert_izzo/solver.hpp"
#endif

#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

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

using SingleRevSolution = lambert_izzo::Solution;
using MultiRevSolution = lambert_izzo::RevolutionSolutions;

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
          "LMO.fbs",
          "$LMO",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit Lambert solve output.");
    return 1;
  }
  return 0;
}

int emit_success_lmo(const std::string& request_id,
                     const SingleRevSolution& solution,
                     const std::vector<MultiRevSolution>& multi) {
  flatbuffers::FlatBufferBuilder builder(1024 + multi.size() * 256);
  const auto request_id_offset =
      request_id.empty() ? 0 : builder.CreateString(request_id);
  const lambertVector3 v1(solution.v1.x, solution.v1.y, solution.v1.z);
  const lambertVector3 v2(solution.v2.x, solution.v2.y, solution.v2.z);
  const auto branch = CreatelambertSolutionBranch(
      builder,
      lambertBranchKind_SINGLE,
      0,
      &v1,
      &v2,
      solution.iterations);
  std::vector<flatbuffers::Offset<lambertSolutionBranch>> multi_offsets;
  multi_offsets.reserve(multi.size() * 2);
  for (const auto& pair : multi) {
    const lambertVector3 long_v1(
        pair.long_period.v1.x, pair.long_period.v1.y, pair.long_period.v1.z);
    const lambertVector3 long_v2(
        pair.long_period.v2.x, pair.long_period.v2.y, pair.long_period.v2.z);
    multi_offsets.push_back(CreatelambertSolutionBranch(
        builder,
        lambertBranchKind_MULTI_LONG_PERIOD,
        pair.revolutions,
        &long_v1,
        &long_v2,
        pair.long_period.iterations));
    const lambertVector3 short_v1(
        pair.short_period.v1.x, pair.short_period.v1.y, pair.short_period.v1.z);
    const lambertVector3 short_v2(
        pair.short_period.v2.x, pair.short_period.v2.y, pair.short_period.v2.z);
    multi_offsets.push_back(CreatelambertSolutionBranch(
        builder,
        lambertBranchKind_MULTI_SHORT_PERIOD,
        pair.revolutions,
        &short_v1,
        &short_v2,
        pair.short_period.iterations));
  }
  const auto multi_vector = builder.CreateVector(multi_offsets);
  const uint16_t max_feasible = multi.empty() ? 0 : multi.back().revolutions;
  const auto result = CreateLMO(
      builder,
      request_id_offset,
      lambertSolveState_OK,
      0,
      0,
      branch,
      multi_vector,
      max_feasible,
      0);
  FinishLMOBuffer(builder, result);

  if (plugin_push_output(
          "solutions",
          "LMO.fbs",
          "$LMO",
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
  lambert_izzo::Request core_request{
      {request->R1_X(), request->R1_Y(), request->R1_Z()},
      {request->R2_X(), request->R2_Y(), request->R2_Z()},
      request->TOF_SEC(),
      request->MU_KM3_S2(),
      request->TRANSFER_WAY() == lambertTransferPath_LONG,
      request->MAX_REVS(),
  };
  if (lambert_izzo::norm(core_request.r1) <= 0.0 ||
      lambert_izzo::norm(core_request.r2) <= 0.0) {
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
  if (lambert_izzo::norm(
          lambert_izzo::cross(core_request.r1, core_request.r2)) <= 0.0) {
    return emit_error_lmo(
        request_id,
        "unsupported-geometry",
        "Lambert request uses unsupported collinear transfer geometry.");
  }
  const lambert_izzo::Result solved = lambert_izzo::solve(core_request);
  if (solved.status != lambert_izzo::Status::Ok) {
    return emit_error_lmo(
        request_id,
        "no-convergence",
        "A feasible Lambert branch did not converge.");
  }
  return emit_success_lmo(request_id, solved.single, solved.multi);
}
