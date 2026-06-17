/*
 ISC License

 Copyright (c) 2021, Autonomous Vehicle Systems Lab, University of Colorado at Boulder

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

 This module ports the Basilisk BSpline.interpolate() numerical method to the
 SDK's standalone C++/WASI surface and SDS BSP FlatBuffer envelopes.
 */

#include "space_data_module_invoke.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace {

constexpr double kPivotTolerance = 1e-12;

struct Vec3 {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

struct InputData {
  std::vector<double> t;
  std::vector<double> x1;
  std::vector<double> x2;
  std::vector<double> x3;
  uint32_t sample_count = 0;
  int order = 0;
  bool has_x_dot_0 = false;
  bool has_x_dot_n = false;
  bool has_x_ddot_0 = false;
  bool has_x_ddot_n = false;
  Vec3 x_dot_0;
  Vec3 x_dot_n;
  Vec3 x_ddot_0;
  Vec3 x_ddot_n;
  std::string trace_id;
};

struct InterpolationOutput {
  std::vector<double> t;
  std::vector<double> x1;
  std::vector<double> x2;
  std::vector<double> x3;
  std::vector<double> xd1;
  std::vector<double> xd2;
  std::vector<double> xd3;
  std::vector<double> xdd1;
  std::vector<double> xdd2;
  std::vector<double> xdd3;
};

struct BasisValues {
  std::vector<double> n;
  std::vector<double> n1;
  std::vector<double> n2;
};

struct InterpolationResult {
  bspInterpolationStatus status = bspInterpolationStatus_OK;
  const char* message = nullptr;
};

double& matrix_at(std::vector<double>& matrix, int dimension, int row, int column) {
  return matrix[static_cast<size_t>(row * dimension + column)];
}

double matrix_at_const(const std::vector<double>& matrix, int dimension, int row, int column) {
  return matrix[static_cast<size_t>(row * dimension + column)];
}

bool is_finite_vector(const std::vector<double>& values) {
  for (double value : values) {
    if (!std::isfinite(value)) {
      return false;
    }
  }
  return true;
}

bool copy_vector(const ::flatbuffers::Vector<double>* source, std::vector<double>* target) {
  if (source == nullptr || target == nullptr) {
    return false;
  }
  target->resize(source->size());
  for (size_t index = 0; index < source->size(); ++index) {
    (*target)[index] = source->Get(index);
  }
  return true;
}

bool copy_vec3(const ::flatbuffers::Vector<double>* source, Vec3* target) {
  if (source == nullptr || target == nullptr || source->size() != 3) {
    return false;
  }
  target->x = source->Get(0);
  target->y = source->Get(1);
  target->z = source->Get(2);
  return std::isfinite(target->x) && std::isfinite(target->y) && std::isfinite(target->z);
}

bool validate_times(const std::vector<double>& t) {
  if (t.size() < 2 || !is_finite_vector(t)) {
    return false;
  }
  for (size_t index = 1; index < t.size(); ++index) {
    if (!(t[index] > t[index - 1])) {
      return false;
    }
  }
  return t.back() > 0.0;
}

BasisValues basis_function(double t, const std::vector<double>& knots, int basis_count, int order) {
  const int columns = order + 1;
  const int rows = basis_count + 1;
  std::vector<double> n(static_cast<size_t>(rows * columns), 0.0);
  std::vector<double> n1(static_cast<size_t>(rows * columns), 0.0);
  std::vector<double> n2(static_cast<size_t>(rows * columns), 0.0);

  auto entry = [columns](std::vector<double>& matrix, int row, int column) -> double& {
    return matrix[static_cast<size_t>(row * columns + column)];
  };
  auto get = [columns](const std::vector<double>& matrix, int row, int column) -> double {
    return matrix[static_cast<size_t>(row * columns + column)];
  };

  for (int row = 0; row < basis_count; ++row) {
    if (t >= knots[static_cast<size_t>(row)] && t < knots[static_cast<size_t>(row + 1)]) {
      entry(n, row, 0) = 1.0;
    }
  }
  if (std::fabs(t - 1.0) < 1e-5) {
    entry(n, basis_count - 1, 0) = 1.0;
  }

  for (int p = 1; p <= order; ++p) {
    for (int row = 0; row < basis_count; ++row) {
      const double left_denominator =
          knots[static_cast<size_t>(row + p)] - knots[static_cast<size_t>(row)];
      if (left_denominator != 0.0) {
        entry(n, row, p) +=
            (t - knots[static_cast<size_t>(row)]) / left_denominator * get(n, row, p - 1);
        entry(n1, row, p) += static_cast<double>(p) / left_denominator * get(n, row, p - 1);
        entry(n2, row, p) += static_cast<double>(p) / left_denominator * get(n1, row, p - 1);
      }

      const double right_denominator =
          knots[static_cast<size_t>(row + p + 1)] - knots[static_cast<size_t>(row + 1)];
      if (right_denominator != 0.0) {
        entry(n, row, p) +=
            (knots[static_cast<size_t>(row + p + 1)] - t) / right_denominator * get(n, row + 1, p - 1);
        entry(n1, row, p) -= static_cast<double>(p) / right_denominator * get(n, row + 1, p - 1);
        entry(n2, row, p) -= static_cast<double>(p) / right_denominator * get(n1, row + 1, p - 1);
      }
    }
  }

  BasisValues values;
  values.n.resize(static_cast<size_t>(basis_count));
  values.n1.resize(static_cast<size_t>(basis_count));
  values.n2.resize(static_cast<size_t>(basis_count));
  for (int row = 0; row < basis_count; ++row) {
    values.n[static_cast<size_t>(row)] = get(n, row, order);
    values.n1[static_cast<size_t>(row)] = get(n1, row, order);
    values.n2[static_cast<size_t>(row)] = get(n2, row, order);
  }
  return values;
}

double dot_product(const std::vector<double>& left, const std::vector<double>& right) {
  double sum = 0.0;
  const size_t count = std::min(left.size(), right.size());
  for (size_t index = 0; index < count; ++index) {
    sum += left[index] * right[index];
  }
  return sum;
}

bool solve_linear_system(
    const std::vector<double>& matrix,
    const std::vector<double>& rhs,
    int dimension,
    std::vector<double>* solution) {
  std::vector<double> a = matrix;
  std::vector<double> b = rhs;
  solution->assign(static_cast<size_t>(dimension), 0.0);

  for (int column = 0; column < dimension; ++column) {
    int pivot_row = column;
    double pivot_abs = std::fabs(matrix_at_const(a, dimension, column, column));
    for (int row = column + 1; row < dimension; ++row) {
      const double candidate = std::fabs(matrix_at_const(a, dimension, row, column));
      if (candidate > pivot_abs) {
        pivot_abs = candidate;
        pivot_row = row;
      }
    }
    if (pivot_abs <= kPivotTolerance) {
      return false;
    }
    if (pivot_row != column) {
      for (int j = column; j < dimension; ++j) {
        std::swap(matrix_at(a, dimension, column, j), matrix_at(a, dimension, pivot_row, j));
      }
      std::swap(b[static_cast<size_t>(column)], b[static_cast<size_t>(pivot_row)]);
    }

    const double pivot = matrix_at_const(a, dimension, column, column);
    for (int row = column + 1; row < dimension; ++row) {
      const double factor = matrix_at_const(a, dimension, row, column) / pivot;
      matrix_at(a, dimension, row, column) = 0.0;
      for (int j = column + 1; j < dimension; ++j) {
        matrix_at(a, dimension, row, j) -= factor * matrix_at_const(a, dimension, column, j);
      }
      b[static_cast<size_t>(row)] -= factor * b[static_cast<size_t>(column)];
    }
  }

  for (int row = dimension - 1; row >= 0; --row) {
    double sum = b[static_cast<size_t>(row)];
    for (int column = row + 1; column < dimension; ++column) {
      sum -= matrix_at_const(a, dimension, row, column) * (*solution)[static_cast<size_t>(column)];
    }
    const double diagonal = matrix_at_const(a, dimension, row, row);
    if (std::fabs(diagonal) <= kPivotTolerance) {
      return false;
    }
    (*solution)[static_cast<size_t>(row)] = sum / diagonal;
  }
  return true;
}

InterpolationResult parse_request(const BSPInterpolationRequest* request, InputData* input) {
  if (request == nullptr || input == nullptr || request->WAYPOINTS() == nullptr) {
    return {bspInterpolationStatus_INVALID_INPUT, "BSPInterpolationRequest.WAYPOINTS is required."};
  }

  const BSPVector3Series* waypoints = request->WAYPOINTS();
  if (!copy_vector(waypoints->T(), &input->t) ||
      !copy_vector(waypoints->X1(), &input->x1) ||
      !copy_vector(waypoints->X2(), &input->x2) ||
      !copy_vector(waypoints->X3(), &input->x3)) {
    return {bspInterpolationStatus_INVALID_INPUT, "Waypoint T, X1, X2, and X3 arrays are required."};
  }

  const size_t waypoint_count = input->t.size();
  if (waypoint_count < 2 ||
      input->x1.size() != waypoint_count ||
      input->x2.size() != waypoint_count ||
      input->x3.size() != waypoint_count ||
      !validate_times(input->t) ||
      !is_finite_vector(input->x1) ||
      !is_finite_vector(input->x2) ||
      !is_finite_vector(input->x3)) {
    return {bspInterpolationStatus_INVALID_INPUT, "Waypoint arrays must be finite, equal length, and strictly increasing in time."};
  }

  input->sample_count = request->SAMPLE_COUNT();
  input->order = static_cast<int>(request->POLYNOMIAL_ORDER());
  input->has_x_dot_0 = request->HAS_X_DOT_0();
  input->has_x_dot_n = request->HAS_X_DOT_N();
  input->has_x_ddot_0 = request->HAS_X_D_DOT_0();
  input->has_x_ddot_n = request->HAS_X_D_DOT_N();
  if (request->TRACE_ID() != nullptr) {
    input->trace_id = request->TRACE_ID()->str();
  }

  if (input->sample_count < 2 || input->order < 1) {
    return {bspInterpolationStatus_INVALID_INPUT, "SAMPLE_COUNT must be at least 2 and POLYNOMIAL_ORDER must be positive."};
  }
  if (input->has_x_dot_0 && !copy_vec3(request->X_DOT_0(), &input->x_dot_0)) {
    return {bspInterpolationStatus_INVALID_INPUT, "X_DOT_0 must contain exactly three finite values when enabled."};
  }
  if (input->has_x_dot_n && !copy_vec3(request->X_DOT_N(), &input->x_dot_n)) {
    return {bspInterpolationStatus_INVALID_INPUT, "X_DOT_N must contain exactly three finite values when enabled."};
  }
  if (input->has_x_ddot_0 && !copy_vec3(request->X_D_DOT_0(), &input->x_ddot_0)) {
    return {bspInterpolationStatus_INVALID_INPUT, "X_D_DOT_0 must contain exactly three finite values when enabled."};
  }
  if (input->has_x_ddot_n && !copy_vec3(request->X_D_DOT_N(), &input->x_ddot_n)) {
    return {bspInterpolationStatus_INVALID_INPUT, "X_D_DOT_N must contain exactly three finite values when enabled."};
  }

  const int waypoint_rank = static_cast<int>(waypoint_count) - 1;
  int endpoint_constraints = 0;
  endpoint_constraints += input->has_x_dot_0 ? 1 : 0;
  endpoint_constraints += input->has_x_dot_n ? 1 : 0;
  endpoint_constraints += input->has_x_ddot_0 ? 1 : 0;
  endpoint_constraints += input->has_x_ddot_n ? 1 : 0;
  if (input->order > waypoint_rank + endpoint_constraints) {
    return {bspInterpolationStatus_UNSUPPORTED_ORDER, "Requested polynomial order is too high for the waypoint and endpoint constraint rank."};
  }

  return {bspInterpolationStatus_OK, nullptr};
}

InterpolationResult interpolate(const InputData& input, InterpolationOutput* output) {
  if (output == nullptr) {
    return {bspInterpolationStatus_INVALID_INPUT, "Internal output buffer is missing."};
  }

  const int waypoint_rank = static_cast<int>(input.x1.size()) - 1;
  int endpoint_constraints = 0;
  endpoint_constraints += input.has_x_dot_0 ? 1 : 0;
  endpoint_constraints += input.has_x_dot_n ? 1 : 0;
  endpoint_constraints += input.has_x_ddot_0 ? 1 : 0;
  endpoint_constraints += input.has_x_ddot_n ? 1 : 0;

  const int basis_count = waypoint_rank + endpoint_constraints + 1;
  const int order = input.order;
  const int knot_rank = waypoint_rank + order + endpoint_constraints + 1;
  const double total_time = input.t[static_cast<size_t>(waypoint_rank)];

  std::vector<double> waypoint_u(static_cast<size_t>(waypoint_rank + 1), 0.0);
  for (int index = 0; index <= waypoint_rank; ++index) {
    waypoint_u[static_cast<size_t>(index)] = input.t[static_cast<size_t>(index)] / total_time;
  }

  std::vector<double> knots(static_cast<size_t>(knot_rank + 1), 0.0);
  for (int p = 0; p <= order; ++p) {
    knots[static_cast<size_t>(p)] = 0.0;
  }
  for (int j = 0; j < knot_rank - 2 * order - 1; ++j) {
    double u = 0.0;
    for (int i = j; i < j + order; ++i) {
      if (i >= static_cast<int>(waypoint_u.size())) {
        u += waypoint_u[static_cast<size_t>(waypoint_rank)] / static_cast<double>(order);
      } else {
        u += waypoint_u[static_cast<size_t>(i)] / static_cast<double>(order);
      }
      knots[static_cast<size_t>(order + j + 1)] = u;
    }
  }
  for (int p = 0; p <= order; ++p) {
    knots[static_cast<size_t>(knot_rank - order + p)] = 1.0;
  }

  std::vector<double> a(static_cast<size_t>(basis_count * basis_count), 0.0);
  std::vector<double> q1(static_cast<size_t>(basis_count), 0.0);
  std::vector<double> q2(static_cast<size_t>(basis_count), 0.0);
  std::vector<double> q3(static_cast<size_t>(basis_count), 0.0);

  int row = -1;
  if (input.has_x_dot_0) {
    row += 1;
    matrix_at(a, basis_count, row, 0) = -1.0;
    matrix_at(a, basis_count, row, 1) = 1.0;
    q1[static_cast<size_t>(row)] = knots[static_cast<size_t>(order + 1)] / static_cast<double>(order) * input.x_dot_0.x * total_time;
    q2[static_cast<size_t>(row)] = knots[static_cast<size_t>(order + 1)] / static_cast<double>(order) * input.x_dot_0.y * total_time;
    q3[static_cast<size_t>(row)] = knots[static_cast<size_t>(order + 1)] / static_cast<double>(order) * input.x_dot_0.z * total_time;
  }
  if (input.has_x_ddot_0) {
    row += 1;
    matrix_at(a, basis_count, row, 0) = knots[static_cast<size_t>(order + 2)];
    matrix_at(a, basis_count, row, 1) =
        -(knots[static_cast<size_t>(order + 1)] + knots[static_cast<size_t>(order + 2)]);
    matrix_at(a, basis_count, row, 2) = knots[static_cast<size_t>(order + 1)];
    const double scale =
        std::pow(knots[static_cast<size_t>(order + 1)], 2.0) * knots[static_cast<size_t>(order + 2)] /
        (static_cast<double>(order) * static_cast<double>(order - 1)) * std::pow(total_time, 2.0);
    q1[static_cast<size_t>(row)] = scale * input.x_ddot_0.x;
    q2[static_cast<size_t>(row)] = scale * input.x_ddot_0.y;
    q3[static_cast<size_t>(row)] = scale * input.x_ddot_0.z;
  }

  row += 1;
  int waypoint_index = -1;
  const int waypoint_start_row = row;
  for (row = waypoint_start_row; row < waypoint_rank + waypoint_start_row + 1; ++row) {
    waypoint_index += 1;
    const BasisValues basis = basis_function(
        waypoint_u[static_cast<size_t>(waypoint_index)],
        knots,
        basis_count,
        order);
    for (int column = 0; column < basis_count; ++column) {
      matrix_at(a, basis_count, row, column) = basis.n[static_cast<size_t>(column)];
    }
    q1[static_cast<size_t>(row)] = input.x1[static_cast<size_t>(waypoint_index)];
    q2[static_cast<size_t>(row)] = input.x2[static_cast<size_t>(waypoint_index)];
    q3[static_cast<size_t>(row)] = input.x3[static_cast<size_t>(waypoint_index)];
  }

  row = waypoint_rank + waypoint_start_row;
  if (input.has_x_ddot_n) {
    row += 1;
    matrix_at(a, basis_count, row, waypoint_rank + endpoint_constraints - 2) =
        1.0 - knots[static_cast<size_t>(knot_rank - order - 1)];
    matrix_at(a, basis_count, row, waypoint_rank + endpoint_constraints - 1) =
        -(2.0 - knots[static_cast<size_t>(knot_rank - order - 1)] - knots[static_cast<size_t>(knot_rank - order - 2)]);
    matrix_at(a, basis_count, row, waypoint_rank + endpoint_constraints) =
        1.0 - knots[static_cast<size_t>(knot_rank - order - 2)];
    const double scale =
        std::pow(1.0 - knots[static_cast<size_t>(knot_rank - order - 1)], 2.0) *
        (1.0 - knots[static_cast<size_t>(knot_rank - order - 2)]) /
        (static_cast<double>(order) * static_cast<double>(order - 1)) * std::pow(total_time, 2.0);
    q1[static_cast<size_t>(row)] = scale * input.x_ddot_n.x;
    q2[static_cast<size_t>(row)] = scale * input.x_ddot_n.y;
    q3[static_cast<size_t>(row)] = scale * input.x_ddot_n.z;
  }
  if (input.has_x_dot_n) {
    row += 1;
    matrix_at(a, basis_count, row, waypoint_rank + endpoint_constraints - 1) = -1.0;
    matrix_at(a, basis_count, row, waypoint_rank + endpoint_constraints) = 1.0;
    const double scale =
        (1.0 - knots[static_cast<size_t>(knot_rank - order - 1)]) / static_cast<double>(order) * total_time;
    q1[static_cast<size_t>(row)] = scale * input.x_dot_n.x;
    q2[static_cast<size_t>(row)] = scale * input.x_dot_n.y;
    q3[static_cast<size_t>(row)] = scale * input.x_dot_n.z;
  }

  std::vector<double> c1;
  std::vector<double> c2;
  std::vector<double> c3;
  if (!solve_linear_system(a, q1, basis_count, &c1) ||
      !solve_linear_system(a, q2, basis_count, &c2) ||
      !solve_linear_system(a, q3, basis_count, &c3)) {
    return {bspInterpolationStatus_SINGULAR_SYSTEM, "B-spline interpolation matrix is singular or numerically unstable."};
  }

  const size_t sample_count = static_cast<size_t>(input.sample_count);
  output->t.assign(sample_count, 0.0);
  output->x1.assign(sample_count, 0.0);
  output->x2.assign(sample_count, 0.0);
  output->x3.assign(sample_count, 0.0);
  output->xd1.assign(sample_count, 0.0);
  output->xd2.assign(sample_count, 0.0);
  output->xd3.assign(sample_count, 0.0);
  output->xdd1.assign(sample_count, 0.0);
  output->xdd2.assign(sample_count, 0.0);
  output->xdd3.assign(sample_count, 0.0);

  const double dt = 1.0 / static_cast<double>(input.sample_count - 1);
  double sample_u = 0.0;
  for (size_t index = 0; index < sample_count; ++index) {
    const BasisValues basis = basis_function(sample_u, knots, basis_count, order);
    output->t[index] = sample_u * total_time;
    output->x1[index] = dot_product(basis.n, c1);
    output->x2[index] = dot_product(basis.n, c2);
    output->x3[index] = dot_product(basis.n, c3);
    output->xd1[index] = dot_product(basis.n1, c1) / total_time;
    output->xd2[index] = dot_product(basis.n1, c2) / total_time;
    output->xd3[index] = dot_product(basis.n1, c3) / total_time;
    output->xdd1[index] = dot_product(basis.n2, c1) / std::pow(total_time, 2.0);
    output->xdd2[index] = dot_product(basis.n2, c2) / std::pow(total_time, 2.0);
    output->xdd3[index] = dot_product(basis.n2, c3) / std::pow(total_time, 2.0);
    sample_u += dt;
  }

  return {bspInterpolationStatus_OK, nullptr};
}

int emit_result(
    bspInterpolationStatus status,
    const char* message,
    const InterpolationOutput* output,
    const char* trace_id) {
  ::flatbuffers::FlatBufferBuilder builder(4096);
  static const std::vector<double> empty;
  const std::vector<double>* t = output ? &output->t : &empty;
  const std::vector<double>* x1 = output ? &output->x1 : &empty;
  const std::vector<double>* x2 = output ? &output->x2 : &empty;
  const std::vector<double>* x3 = output ? &output->x3 : &empty;
  const std::vector<double>* xd1 = output ? &output->xd1 : &empty;
  const std::vector<double>* xd2 = output ? &output->xd2 : &empty;
  const std::vector<double>* xd3 = output ? &output->xd3 : &empty;
  const std::vector<double>* xdd1 = output ? &output->xdd1 : &empty;
  const std::vector<double>* xdd2 = output ? &output->xdd2 : &empty;
  const std::vector<double>* xdd3 = output ? &output->xdd3 : &empty;

  const auto samples = CreateBSPVector3SeriesDirect(builder, t, x1, x2, x3);
  const auto result = CreateBSPInterpolationResultDirect(
      builder,
      status,
      message,
      samples,
      xd1,
      xd2,
      xd3,
      xdd1,
      xdd2,
      xdd3,
      trace_id);
  const auto envelope = CreateBSP(builder, 0, result);
  FinishBSPBuffer(builder, envelope);

  if (plugin_push_output(
          "result",
          "BSP.fbs",
          "$BSP",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit BSP interpolation result.");
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

extern "C" int interpolate_bspline(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_request_frame();
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0) {
    plugin_set_error("missing-request", "No BSP interpolation request frame was provided.");
    return 3;
  }
  if (!BSPBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-request-buffer", "Input is not an SDS BSP FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyBSPBuffer(verifier)) {
    plugin_set_error("invalid-request-buffer", "Input is not a valid SDS BSP FlatBuffer.");
    return 3;
  }

  const BSP* envelope = GetBSP(frame->payload);
  const BSPInterpolationRequest* request = envelope ? envelope->INTERPOLATION_REQUEST() : nullptr;
  InputData input;
  InterpolationResult parsed = parse_request(request, &input);
  if (parsed.status != bspInterpolationStatus_OK) {
    return emit_result(parsed.status, parsed.message, nullptr, input.trace_id.empty() ? nullptr : input.trace_id.c_str());
  }

  InterpolationOutput output;
  const InterpolationResult result = interpolate(input, &output);
  if (result.status != bspInterpolationStatus_OK) {
    return emit_result(result.status, result.message, nullptr, input.trace_id.empty() ? nullptr : input.trace_id.c_str());
  }

  return emit_result(bspInterpolationStatus_OK, nullptr, &output, input.trace_id.empty() ? nullptr : input.trace_id.c_str());
}
