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

struct Vec3 {
  double x;
  double y;
  double z;
};

struct SingleRevSolution {
  Vec3 v1;
  Vec3 v2;
  uint32_t iterations;
};

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

int emit_success_lmo(const std::string& request_id, const SingleRevSolution& solution) {
  flatbuffers::FlatBufferBuilder builder(512);
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
  const auto result = CreateLMO(
      builder,
      request_id_offset,
      lambertSolveState_OK,
      0,
      0,
      branch,
      0,
      0,
      0);
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

double vector_norm(const Vec3& value) {
  return vector_norm(value.x, value.y, value.z);
}

Vec3 add(const Vec3& left, const Vec3& right) {
  return {left.x + right.x, left.y + right.y, left.z + right.z};
}

Vec3 scale(const Vec3& value, double scalar) {
  return {value.x * scalar, value.y * scalar, value.z * scalar};
}

Vec3 cross(const Vec3& left, const Vec3& right) {
  return {
      (left.y * right.z) - (left.z * right.y),
      (left.z * right.x) - (left.x * right.z),
      (left.x * right.y) - (left.y * right.x)};
}

Vec3 normalize(const Vec3& value) {
  const double norm = vector_norm(value);
  return {value.x / norm, value.y / norm, value.z / norm};
}

double cross_norm(const LMS& request) {
  const double cx = (request.R1_Y() * request.R2_Z()) - (request.R1_Z() * request.R2_Y());
  const double cy = (request.R1_Z() * request.R2_X()) - (request.R1_X() * request.R2_Z());
  const double cz = (request.R1_X() * request.R2_Y()) - (request.R1_Y() * request.R2_X());
  return vector_norm(cx, cy, cz);
}

double hypergeometric_f(double z) {
  constexpr double tolerance = 1e-11;
  double sj = 1.0;
  double cj = 1.0;
  for (int j = 0; j <= 12; ++j) {
    const double cj1 = cj * (3.0 + j) * (1.0 + j) / (2.5 + j) * z / (j + 1.0);
    const double sj1 = sj + cj1;
    sj = sj1;
    cj = cj1;
    if (std::abs(cj1) < tolerance) {
      break;
    }
  }
  return sj;
}

double x2tof(double x, int revolutions, double lambda) {
  constexpr double battin = 0.01;
  const double dist = std::abs(x - 1.0);
  const double u = 1.0 - (x * x);
  const double y = std::sqrt(1.0 - (lambda * lambda * u));

  if (dist < 1e-8) {
    return 2.0 / 3.0 * (1.0 - std::pow(lambda, 3));
  }
  if (dist < battin) {
    const double eta = y - (lambda * x);
    const double s1 = 0.5 * (1.0 - lambda - (x * eta));
    const double q = 4.0 / 3.0 * hypergeometric_f(s1);
    return ((std::pow(eta, 3) * q) + (4.0 * lambda * eta)) / 2.0 +
           (revolutions * M_PI / std::pow(std::abs(u), 1.5));
  }

  const double f = (y - (lambda * x)) * std::sqrt(std::abs(u));
  const double g = (x * y) + (lambda * u);
  const double d = u > 0.0
                       ? std::atan2(f, g) + (revolutions * M_PI)
                       : std::atanh(f / g);
  return ((d / std::sqrt(std::abs(u))) - x + (lambda * y)) / u;
}

void time_of_flight_derivatives(double x, double tof, double lambda, double* dt, double* d2t, double* d3t) {
  if (std::abs(x - 1.0) < 1e-8) {
    *dt = 2.0 / 5.0 * (std::pow(lambda, 5) - 1.0);
    *d2t = 0.0;
    *d3t = 0.0;
    return;
  }
  const double u = 1.0 - (x * x);
  const double y = std::sqrt(1.0 - (lambda * lambda * u));
  *dt = (3.0 * tof * x - 2.0 + (2.0 * std::pow(lambda, 3) * x / y)) / u;
  *d2t = (3.0 * tof + (5.0 * x * *dt) +
          (2.0 * (1.0 - (lambda * lambda)) * std::pow(lambda, 3) / std::pow(y, 3))) /
         u;
  *d3t = (7.0 * x * *d2t + (8.0 * *dt) -
          (6.0 * (1.0 - (lambda * lambda)) * std::pow(lambda, 5) * x / std::pow(y, 5))) /
         u;
}

double izzo_initial_guess_zero_rev(double lambda, double nondimensional_tof) {
  const double t00 = std::acos(lambda) + (lambda * std::sqrt(1.0 - (lambda * lambda)));
  const double t1 = 2.0 / 3.0 * (1.0 - std::pow(lambda, 3));
  if (nondimensional_tof >= t00) {
    return std::pow(t00 / nondimensional_tof, 2.0 / 3.0) - 1.0;
  }
  if (nondimensional_tof <= t1) {
    return 2.5 * t1 * (t1 - nondimensional_tof) /
           (nondimensional_tof * (1.0 - std::pow(lambda, 5))) +
           1.0;
  }
  return std::pow(
             t00 / nondimensional_tof,
             std::log(t1 / t00) / std::log(2.0)) -
         1.0;
}

bool householder_zero_rev(double target_tof, double lambda, double* x, uint32_t* iterations) {
  constexpr double tolerance = 1e-8;
  double x0 = *x;
  double xnew = x0;
  for (uint32_t iteration = 1; iteration <= 8; ++iteration) {
    const double tof = x2tof(x0, 0, lambda);
    double dt = 0.0;
    double d2t = 0.0;
    double d3t = 0.0;
    time_of_flight_derivatives(x0, tof, lambda, &dt, &d2t, &d3t);
    const double delta = tof - target_tof;
    const double dt2 = dt * dt;
    xnew = x0 - delta * (dt2 - (delta * d2t / 2.0)) /
                   (dt * (dt2 - (delta * d2t)) + (d3t * delta * delta / 6.0));
    const double error = std::abs(x0 - xnew);
    x0 = xnew;
    *iterations = iteration;
    if (error < tolerance) {
      *x = xnew;
      return true;
    }
  }
  *x = xnew;
  return false;
}

bool solve_single_revolution(const LMS& request, SingleRevSolution* solution) {
  const Vec3 r1 = {request.R1_X(), request.R1_Y(), request.R1_Z()};
  const Vec3 r2 = {request.R2_X(), request.R2_Y(), request.R2_Z()};
  const Vec3 chord = {r2.x - r1.x, r2.y - r1.y, r2.z - r1.z};
  const double chord_norm = vector_norm(chord);
  const double r1_norm = vector_norm(r1);
  const double r2_norm = vector_norm(r2);
  const double semiperimeter = 0.5 * (r1_norm + r2_norm + chord_norm);
  double lambda = std::sqrt(1.0 - (chord_norm / semiperimeter));

  Vec3 h_hat = normalize(cross(normalize(r1), normalize(r2)));
  if (request.TRANSFER_WAY() == lambertTransferPath_LONG) {
    lambda = -lambda;
    h_hat = scale(h_hat, -1.0);
  }
  const Vec3 r1_hat = normalize(r1);
  const Vec3 r2_hat = normalize(r2);
  const Vec3 t1_hat = cross(h_hat, r1_hat);
  const Vec3 t2_hat = cross(h_hat, r2_hat);
  const double nondimensional_tof =
      std::sqrt(2.0 * request.MU_KM3_S2() / std::pow(semiperimeter, 3)) *
      request.TOF_SEC();
  double x = izzo_initial_guess_zero_rev(lambda, nondimensional_tof);
  uint32_t iterations = 0;
  if (!householder_zero_rev(nondimensional_tof, lambda, &x, &iterations)) {
    return false;
  }

  const double y = std::sqrt(1.0 - (lambda * lambda * (1.0 - (x * x))));
  const double gamma = std::sqrt(request.MU_KM3_S2() * semiperimeter / 2.0);
  const double rho = (r1_norm - r2_norm) / chord_norm;
  const double sigma = std::sqrt(1.0 - (rho * rho));
  const double vr1 = gamma * ((lambda * y - x) - (rho * (lambda * y + x))) / r1_norm;
  const double vr2 = -gamma * ((lambda * y - x) + (rho * (lambda * y + x))) / r2_norm;
  const double vt = gamma * sigma * (y + (lambda * x));
  const double vt1 = vt / r1_norm;
  const double vt2 = vt / r2_norm;

  solution->v1 = add(scale(r1_hat, vr1), scale(t1_hat, vt1));
  solution->v2 = add(scale(r2_hat, vr2), scale(t2_hat, vt2));
  solution->iterations = iterations;
  return true;
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
  if (request->MAX_REVS() == 0) {
    SingleRevSolution solution{};
    if (!solve_single_revolution(*request, &solution)) {
      return emit_error_lmo(
          request_id,
          "no-convergence",
          "Lambert zero-revolution solve did not converge.");
    }
    return emit_success_lmo(request_id, solution);
  }

  plugin_set_error(
      "solver-not-implemented",
      "Lambert solver runtime is not implemented yet; request validation passed.");
  return 501;
}
