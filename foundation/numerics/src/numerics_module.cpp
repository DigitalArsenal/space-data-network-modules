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

 This module ports Basilisk numerical utility formulas to the SDK's standalone
 C++/WASI surface and SDS NUM FlatBuffer envelopes.
 */

#include "space_data_module_invoke.h"

#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <random>
#include <vector>

namespace {

constexpr double kDerivativeTolerance = 1e-14;
constexpr double kInterpolationTolerance = 1e-14;

struct RootSolveOutput {
  numResultStatus status = numResultStatus_OK;
  const char* message = nullptr;
  double root = 0.0;
  double residual = 0.0;
  uint32_t iterations = 0;
};

struct VectorSaturateOutput {
  numResultStatus status = numResultStatus_OK;
  const char* message = nullptr;
  std::vector<double> saturated_state;
};

struct VectorDiscretizeOutput {
  numResultStatus status = numResultStatus_OK;
  const char* message = nullptr;
  std::vector<double> discretized_state;
  std::vector<double> discretization_error;
};

struct ScalarInterpolationOutput {
  numResultStatus status = numResultStatus_OK;
  const char* message = nullptr;
  double value = 0.0;
};

struct GaussMarkovOutput {
  numResultStatus status = numResultStatus_OK;
  const char* message = nullptr;
  std::vector<double> mean;
  std::vector<double> standard_deviation;
  std::vector<double> minimum;
  std::vector<double> maximum;
  std::vector<double> final_state;
  std::vector<double> samples;
};

bool evaluate_function(numFunctionCode function, double x, double target, double* value, double* derivative) {
  if (value == nullptr || derivative == nullptr || !std::isfinite(x) || !std::isfinite(target)) {
    return false;
  }
  switch (function) {
    case numFunctionCode_QUADRATIC_MINUS_CONSTANT:
      *value = x * x - target;
      *derivative = 2.0 * x;
      return std::isfinite(*value) && std::isfinite(*derivative);
    case numFunctionCode_UNKNOWN:
    default:
      return false;
  }
}

RootSolveOutput solve_newton_raphson(const NUMRootSolveRequest* request) {
  if (request == nullptr) {
    return {numResultStatus_INVALID_INPUT, "Root solve request is missing.", 0.0, 0.0, 0};
  }
  if (request->OPERATION() != numOperationCode_NEWTON_RAPHSON) {
    return {numResultStatus_UNSUPPORTED_OPERATION, "NUM operation is not supported.", 0.0, 0.0, 0};
  }

  const numFunctionCode function = request->FUNCTION();
  const double accuracy = request->ACCURACY();
  const double target = request->TARGET_VALUE();
  double x = request->INITIAL_ESTIMATE();
  const uint32_t max_iterations = request->MAX_ITERATIONS() == 0 ? 50 : request->MAX_ITERATIONS();

  if (!std::isfinite(x) || !std::isfinite(target) || !std::isfinite(accuracy) || accuracy <= 0.0 || max_iterations == 0) {
    return {numResultStatus_INVALID_INPUT, "Newton-Raphson request contains invalid scalar parameters.", 0.0, 0.0, 0};
  }

  double residual = 0.0;
  for (uint32_t iteration = 1; iteration <= max_iterations; ++iteration) {
    double derivative = 0.0;
    if (!evaluate_function(function, x, target, &residual, &derivative)) {
      return {numResultStatus_UNSUPPORTED_OPERATION, "NUM function is not supported.", x, residual, iteration - 1};
    }
    if (!std::isfinite(derivative) || std::fabs(derivative) <= kDerivativeTolerance) {
      return {numResultStatus_INVALID_INPUT, "Newton-Raphson derivative is zero or numerically unstable.", x, residual, iteration - 1};
    }

    const double next = x - residual / derivative;
    if (!std::isfinite(next)) {
      return {numResultStatus_INVALID_INPUT, "Newton-Raphson iteration produced a non-finite root estimate.", x, residual, iteration};
    }

    double next_derivative = 0.0;
    double next_residual = 0.0;
    if (!evaluate_function(function, next, target, &next_residual, &next_derivative)) {
      return {numResultStatus_UNSUPPORTED_OPERATION, "NUM function is not supported.", next, residual, iteration};
    }

    const double step = std::fabs(next - x);
    x = next;
    residual = next_residual;
    if (step <= accuracy || std::fabs(residual) <= accuracy) {
      return {numResultStatus_OK, nullptr, x, residual, iteration};
    }
  }

  return {numResultStatus_DID_NOT_CONVERGE, "Newton-Raphson did not converge within MAX_ITERATIONS.", x, residual, max_iterations};
}

VectorSaturateOutput saturate_vector_request(const NUMVectorSaturateRequest* request) {
  if (request == nullptr) {
    return {numResultStatus_INVALID_INPUT, "Vector saturate request is missing.", {}};
  }

  const auto* state = request->STATE();
  const auto* lower_bounds = request->LOWER_BOUNDS();
  const auto* upper_bounds = request->UPPER_BOUNDS();
  if (state == nullptr || lower_bounds == nullptr || upper_bounds == nullptr || state->size() == 0) {
    return {numResultStatus_INVALID_INPUT, "Vector saturate request requires state and bound vectors.", {}};
  }
  if (state->size() != lower_bounds->size() || state->size() != upper_bounds->size()) {
    return {numResultStatus_INVALID_INPUT, "Vector saturate state and bound vector lengths must match.", {}};
  }

  std::vector<double> saturated_state;
  saturated_state.reserve(state->size());
  for (::flatbuffers::uoffset_t index = 0; index < state->size(); ++index) {
    const double value = state->Get(index);
    const double lower = lower_bounds->Get(index);
    const double upper = upper_bounds->Get(index);
    if (!std::isfinite(value) || !std::isfinite(lower) || !std::isfinite(upper) || lower > upper) {
      return {numResultStatus_INVALID_INPUT, "Vector saturate request contains invalid numeric bounds.", {}};
    }
    double saturated = value;
    if (saturated < lower) {
      saturated = lower;
    }
    if (saturated > upper) {
      saturated = upper;
    }
    saturated_state.push_back(saturated);
  }

  return {numResultStatus_OK, nullptr, saturated_state};
}

VectorDiscretizeOutput discretize_vector_request(const NUMVectorDiscretizeRequest* request) {
  if (request == nullptr) {
    return {numResultStatus_INVALID_INPUT, "Vector discretize request is missing.", {}, {}};
  }

  const auto* state = request->STATE();
  const auto* lsb = request->LSB();
  const auto* previous_error = request->PREVIOUS_ERROR();
  if (state == nullptr || lsb == nullptr || state->size() == 0) {
    return {numResultStatus_INVALID_INPUT, "Vector discretize request requires state and LSB vectors.", {}, {}};
  }
  if (state->size() != lsb->size()) {
    return {numResultStatus_INVALID_INPUT, "Vector discretize state and LSB vector lengths must match.", {}, {}};
  }
  if (previous_error != nullptr && previous_error->size() != 0 && previous_error->size() != state->size()) {
    return {numResultStatus_INVALID_INPUT, "Vector discretize previous-error length must match state when provided.", {}, {}};
  }

  std::vector<double> discretized_state;
  std::vector<double> discretization_error;
  discretized_state.reserve(state->size());
  discretization_error.reserve(state->size());

  for (::flatbuffers::uoffset_t index = 0; index < state->size(); ++index) {
    const double bin_size = lsb->Get(index);
    const double prior_error =
        request->CARRY_ERROR() && previous_error != nullptr && previous_error->size() != 0 ? previous_error->Get(index) : 0.0;
    const double value = state->Get(index) + prior_error;
    if (!std::isfinite(value) || !std::isfinite(bin_size) || bin_size <= 0.0 || !std::isfinite(prior_error)) {
      return {numResultStatus_INVALID_INPUT, "Vector discretize request contains invalid numeric values.", {}, {}};
    }

    const double scaled_magnitude = std::fabs(value / bin_size);
    double rounded_magnitude = 0.0;
    switch (request->ROUND_DIRECTION()) {
      case numDiscretizeRoundDirection_TO_ZERO:
        rounded_magnitude = std::floor(scaled_magnitude);
        break;
      case numDiscretizeRoundDirection_FROM_ZERO:
        rounded_magnitude = std::ceil(scaled_magnitude);
        break;
      case numDiscretizeRoundDirection_NEAR:
        rounded_magnitude = std::round(scaled_magnitude);
        break;
      default:
        return {numResultStatus_INVALID_INPUT, "Vector discretize round direction is not supported.", {}, {}};
    }

    const double discretized = std::copysign(rounded_magnitude * bin_size, value);
    discretized_state.push_back(discretized);
    discretization_error.push_back(value - discretized);
  }

  return {numResultStatus_OK, nullptr, discretized_state, discretization_error};
}

ScalarInterpolationOutput interpolate_scalar_request(const NUMScalarInterpolationRequest* request) {
  if (request == nullptr) {
    return {numResultStatus_INVALID_INPUT, "Scalar interpolation request is missing.", 0.0};
  }

  const double x1 = request->X1();
  const double x2 = request->X2();
  const double x = request->INTERPOLATION_X();
  if (!std::isfinite(x1) || !std::isfinite(x2) || !std::isfinite(x) || std::fabs(x2 - x1) <= kInterpolationTolerance) {
    return {numResultStatus_INVALID_INPUT, "Scalar interpolation request contains invalid x coordinates.", 0.0};
  }

  switch (request->OPERATION()) {
    case numOperationCode_LINEAR_INTERPOLATION: {
      const double value1 = request->VALUE1();
      const double value2 = request->VALUE2();
      if (!std::isfinite(value1) || !std::isfinite(value2)) {
        return {numResultStatus_INVALID_INPUT, "Linear interpolation request contains non-finite sample values.", 0.0};
      }
      const double denominator = x2 - x1;
      const double value = value1 * (x2 - x) / denominator + value2 * (x - x1) / denominator;
      if (!std::isfinite(value)) {
        return {numResultStatus_INVALID_INPUT, "Linear interpolation produced a non-finite value.", 0.0};
      }
      return {numResultStatus_OK, nullptr, value};
    }
    case numOperationCode_BILINEAR_INTERPOLATION: {
      const double y1 = request->Y1();
      const double y2 = request->Y2();
      const double y = request->INTERPOLATION_Y();
      const double z11 = request->Z11();
      const double z12 = request->Z12();
      const double z21 = request->Z21();
      const double z22 = request->Z22();
      if (!std::isfinite(y1) || !std::isfinite(y2) || !std::isfinite(y) || std::fabs(y2 - y1) <= kInterpolationTolerance ||
          !std::isfinite(z11) || !std::isfinite(z12) || !std::isfinite(z21) || !std::isfinite(z22)) {
        return {numResultStatus_INVALID_INPUT, "Bilinear interpolation request contains invalid coordinates or corner values.", 0.0};
      }
      const double denominator = (x2 - x1) * (y2 - y1);
      const double value =
          (z11 * (x2 - x) * (y2 - y) + z21 * (x - x1) * (y2 - y) + z12 * (x2 - x) * (y - y1) +
           z22 * (x - x1) * (y - y1)) /
          denominator;
      if (!std::isfinite(value)) {
        return {numResultStatus_INVALID_INPUT, "Bilinear interpolation produced a non-finite value.", 0.0};
      }
      return {numResultStatus_OK, nullptr, value};
    }
    case numOperationCode_UNKNOWN:
    case numOperationCode_NEWTON_RAPHSON:
    case numOperationCode_GAUSS_MARKOV_SEQUENCE:
    default:
      return {numResultStatus_UNSUPPORTED_OPERATION, "Scalar interpolation operation is not supported.", 0.0};
  }
}

bool vector_has_finite_values(const ::flatbuffers::Vector<double>* values) {
  if (values == nullptr) {
    return false;
  }
  for (::flatbuffers::uoffset_t index = 0; index < values->size(); ++index) {
    if (!std::isfinite(values->Get(index))) {
      return false;
    }
  }
  return true;
}

std::vector<double> copy_vector(const ::flatbuffers::Vector<double>* values) {
  std::vector<double> copied;
  if (values == nullptr) {
    return copied;
  }
  copied.reserve(values->size());
  for (::flatbuffers::uoffset_t index = 0; index < values->size(); ++index) {
    copied.push_back(values->Get(index));
  }
  return copied;
}

void gauss_markov_step(
    std::vector<double>* current_state,
    const std::vector<double>& propagation_matrix,
    const std::vector<double>& noise_matrix,
    const std::vector<double>& state_bounds,
    std::minstd_rand* generator,
    std::normal_distribution<double>* distribution) {
  const size_t dimension = current_state->size();
  std::vector<double> random_values(dimension, 0.0);
  for (size_t index = 0; index < dimension; ++index) {
    random_values[index] = (*distribution)(*generator);
  }

  std::vector<double> next_state(dimension, 0.0);
  for (size_t row = 0; row < dimension; ++row) {
    double propagated = 0.0;
    double error = 0.0;
    for (size_t column = 0; column < dimension; ++column) {
      const size_t matrix_index = row * dimension + column;
      propagated += propagation_matrix[matrix_index] * (*current_state)[column];
      error += noise_matrix[matrix_index] * random_values[column];
    }
    double value = propagated + error;
    const double bound = state_bounds[row];
    if (bound > 0.0 && std::fabs(value) > bound) {
      value = std::copysign(bound, value);
    }
    next_state[row] = value;
  }

  *current_state = next_state;
}

GaussMarkovOutput compute_gauss_markov_request(const NUMGaussMarkovRequest* request) {
  if (request == nullptr) {
    return {numResultStatus_INVALID_INPUT, "Gauss-Markov request is missing.", {}, {}, {}, {}, {}, {}};
  }
  if (request->OPERATION() != numOperationCode_GAUSS_MARKOV_SEQUENCE) {
    return {numResultStatus_UNSUPPORTED_OPERATION, "NUM operation is not supported.", {}, {}, {}, {}, {}, {}};
  }

  const uint32_t dimension_u32 = request->DIMENSION();
  const uint32_t sample_count = request->SAMPLE_COUNT();
  const uint32_t warmup_count = request->WARMUP_COUNT();
  if (dimension_u32 == 0 || sample_count == 0) {
    return {numResultStatus_INVALID_INPUT, "Gauss-Markov request requires positive DIMENSION and SAMPLE_COUNT.", {}, {}, {}, {}, {}, {}};
  }

  const auto* propagation_vector = request->PROPAGATION_MATRIX();
  const auto* noise_vector = request->NOISE_MATRIX();
  const auto* bounds_vector = request->STATE_BOUNDS();
  const uint64_t dimension = dimension_u32;
  const uint64_t matrix_entry_count = dimension * dimension;
  if (matrix_entry_count > std::numeric_limits<::flatbuffers::uoffset_t>::max()) {
    return {numResultStatus_INVALID_INPUT, "Gauss-Markov matrix dimensions are too large.", {}, {}, {}, {}, {}, {}};
  }
  if (propagation_vector == nullptr || noise_vector == nullptr || bounds_vector == nullptr ||
      propagation_vector->size() != matrix_entry_count || noise_vector->size() != matrix_entry_count ||
      bounds_vector->size() != dimension) {
    return {numResultStatus_INVALID_INPUT, "Gauss-Markov request vector lengths do not match DIMENSION.", {}, {}, {}, {}, {}, {}};
  }
  if (!vector_has_finite_values(propagation_vector) || !vector_has_finite_values(noise_vector) || !vector_has_finite_values(bounds_vector)) {
    return {numResultStatus_INVALID_INPUT, "Gauss-Markov request contains non-finite matrix or bound values.", {}, {}, {}, {}, {}, {}};
  }
  if (request->EMIT_SAMPLES() && sample_count > 0 &&
      dimension > static_cast<uint64_t>(std::numeric_limits<size_t>::max() / sample_count)) {
    return {numResultStatus_INVALID_INPUT, "Gauss-Markov sample output size overflows host limits.", {}, {}, {}, {}, {}, {}};
  }

  const std::vector<double> propagation_matrix = copy_vector(propagation_vector);
  const std::vector<double> noise_matrix = copy_vector(noise_vector);
  const std::vector<double> state_bounds = copy_vector(bounds_vector);

  std::vector<double> current_state(dimension_u32, 0.0);
  std::minstd_rand generator;
  generator.seed(request->RNG_SEED());
  std::normal_distribution<double> distribution(0.0, 1.0);

  for (uint32_t index = 0; index < warmup_count; ++index) {
    gauss_markov_step(&current_state, propagation_matrix, noise_matrix, state_bounds, &generator, &distribution);
  }

  GaussMarkovOutput output;
  output.status = numResultStatus_OK;
  output.mean.assign(dimension_u32, 0.0);
  output.standard_deviation.assign(dimension_u32, 0.0);
  output.minimum.assign(dimension_u32, std::numeric_limits<double>::infinity());
  output.maximum.assign(dimension_u32, -std::numeric_limits<double>::infinity());
  output.final_state.assign(dimension_u32, 0.0);
  if (request->EMIT_SAMPLES()) {
    output.samples.reserve(static_cast<size_t>(sample_count) * static_cast<size_t>(dimension_u32));
  }

  std::vector<double> m2(dimension_u32, 0.0);
  for (uint32_t sample_index = 0; sample_index < sample_count; ++sample_index) {
    gauss_markov_step(&current_state, propagation_matrix, noise_matrix, state_bounds, &generator, &distribution);

    const double count = static_cast<double>(sample_index + 1);
    for (uint32_t state_index = 0; state_index < dimension_u32; ++state_index) {
      const double value = current_state[state_index];
      if (request->EMIT_SAMPLES()) {
        output.samples.push_back(value);
      }
      if (value < output.minimum[state_index]) {
        output.minimum[state_index] = value;
      }
      if (value > output.maximum[state_index]) {
        output.maximum[state_index] = value;
      }
      const double delta = value - output.mean[state_index];
      output.mean[state_index] += delta / count;
      const double delta2 = value - output.mean[state_index];
      m2[state_index] += delta * delta2;
    }
  }

  for (uint32_t state_index = 0; state_index < dimension_u32; ++state_index) {
    output.standard_deviation[state_index] =
        sample_count > 1 ? std::sqrt(m2[state_index] / static_cast<double>(sample_count - 1)) : 0.0;
    output.final_state[state_index] = current_state[state_index];
  }

  return output;
}

int emit_root_solve_result(const RootSolveOutput& output, const char* trace_id) {
  ::flatbuffers::FlatBufferBuilder builder(1024);
  const auto result = CreateNUMRootSolveResultDirect(
      builder,
      output.status,
      output.message,
      output.root,
      output.residual,
      output.iterations,
      trace_id);
  const auto envelope = CreateNUM(builder, 0, result);
  FinishNUMBuffer(builder, envelope);

  if (plugin_push_output(
          "result",
          "NUM.fbs",
          "$NUM",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit NUM root-solve result.");
    return 1;
  }
  return 0;
}

int emit_vector_saturate_result(const VectorSaturateOutput& output, const char* trace_id) {
  ::flatbuffers::FlatBufferBuilder builder(1024);
  const auto result = CreateNUMVectorSaturateResultDirect(
      builder,
      output.status,
      output.message,
      &output.saturated_state,
      trace_id);
  const auto envelope = CreateNUM(builder, 0, 0, 0, result);
  FinishNUMBuffer(builder, envelope);

  if (plugin_push_output(
          "result",
          "NUM.fbs",
          "$NUM",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit NUM vector-saturate result.");
    return 1;
  }
  return 0;
}

int emit_vector_discretize_result(const VectorDiscretizeOutput& output, const char* trace_id) {
  ::flatbuffers::FlatBufferBuilder builder(1024);
  const auto result = CreateNUMVectorDiscretizeResultDirect(
      builder,
      output.status,
      output.message,
      &output.discretized_state,
      &output.discretization_error,
      trace_id);
  const auto envelope = CreateNUM(builder, 0, 0, 0, 0, 0, result);
  FinishNUMBuffer(builder, envelope);

  if (plugin_push_output(
          "result",
          "NUM.fbs",
          "$NUM",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit NUM vector-discretize result.");
    return 1;
  }
  return 0;
}

int emit_scalar_interpolation_result(const ScalarInterpolationOutput& output, const char* trace_id) {
  ::flatbuffers::FlatBufferBuilder builder(1024);
  const auto result = CreateNUMScalarInterpolationResultDirect(
      builder,
      output.status,
      output.message,
      output.value,
      trace_id);
  const auto envelope = CreateNUM(builder, 0, 0, 0, 0, 0, 0, 0, result);
  FinishNUMBuffer(builder, envelope);

  if (plugin_push_output(
          "result",
          "NUM.fbs",
          "$NUM",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit NUM scalar-interpolation result.");
    return 1;
  }
  return 0;
}

int emit_gauss_markov_result(const GaussMarkovOutput& output, const char* trace_id) {
  ::flatbuffers::FlatBufferBuilder builder(1024);
  const auto result = CreateNUMGaussMarkovResultDirect(
      builder,
      output.status,
      output.message,
      &output.mean,
      &output.standard_deviation,
      &output.minimum,
      &output.maximum,
      &output.final_state,
      &output.samples,
      trace_id);
  const auto envelope = CreateNUM(builder, 0, 0, 0, 0, 0, 0, 0, 0, 0, result);
  FinishNUMBuffer(builder, envelope);

  if (plugin_push_output(
          "result",
          "NUM.fbs",
          "$NUM",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit NUM Gauss-Markov result.");
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

extern "C" int solve_scalar_root(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_request_frame();
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0) {
    plugin_set_error("missing-request", "No NUM root-solve request frame was provided.");
    return 3;
  }
  if (!NUMBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-request-buffer", "Input is not an SDS NUM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyNUMBuffer(verifier)) {
    plugin_set_error("invalid-request-buffer", "Input is not a valid SDS NUM FlatBuffer.");
    return 3;
  }

  const NUM* envelope = GetNUM(frame->payload);
  const NUMRootSolveRequest* request = envelope ? envelope->ROOT_SOLVE_REQUEST() : nullptr;
  const char* trace_id = request && request->TRACE_ID() ? request->TRACE_ID()->c_str() : nullptr;
  return emit_root_solve_result(solve_newton_raphson(request), trace_id);
}

extern "C" int saturate_vector(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_request_frame();
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0) {
    plugin_set_error("missing-request", "No NUM vector-saturate request frame was provided.");
    return 3;
  }
  if (!NUMBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-request-buffer", "Input is not an SDS NUM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyNUMBuffer(verifier)) {
    plugin_set_error("invalid-request-buffer", "Input is not a valid SDS NUM FlatBuffer.");
    return 3;
  }

  const NUM* envelope = GetNUM(frame->payload);
  const NUMVectorSaturateRequest* request = envelope ? envelope->VECTOR_SATURATE_REQUEST() : nullptr;
  const char* trace_id = request && request->TRACE_ID() ? request->TRACE_ID()->c_str() : nullptr;
  return emit_vector_saturate_result(saturate_vector_request(request), trace_id);
}

extern "C" int discretize_vector(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_request_frame();
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0) {
    plugin_set_error("missing-request", "No NUM vector-discretize request frame was provided.");
    return 3;
  }
  if (!NUMBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-request-buffer", "Input is not an SDS NUM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyNUMBuffer(verifier)) {
    plugin_set_error("invalid-request-buffer", "Input is not a valid SDS NUM FlatBuffer.");
    return 3;
  }

  const NUM* envelope = GetNUM(frame->payload);
  const NUMVectorDiscretizeRequest* request = envelope ? envelope->VECTOR_DISCRETIZE_REQUEST() : nullptr;
  const char* trace_id = request && request->TRACE_ID() ? request->TRACE_ID()->c_str() : nullptr;
  return emit_vector_discretize_result(discretize_vector_request(request), trace_id);
}

extern "C" int interpolate_scalar(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_request_frame();
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0) {
    plugin_set_error("missing-request", "No NUM scalar-interpolation request frame was provided.");
    return 3;
  }
  if (!NUMBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-request-buffer", "Input is not an SDS NUM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyNUMBuffer(verifier)) {
    plugin_set_error("invalid-request-buffer", "Input is not a valid SDS NUM FlatBuffer.");
    return 3;
  }

  const NUM* envelope = GetNUM(frame->payload);
  const NUMScalarInterpolationRequest* request = envelope ? envelope->SCALAR_INTERPOLATION_REQUEST() : nullptr;
  const char* trace_id = request && request->TRACE_ID() ? request->TRACE_ID()->c_str() : nullptr;
  return emit_scalar_interpolation_result(interpolate_scalar_request(request), trace_id);
}

extern "C" int compute_gauss_markov_sequence(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_request_frame();
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0) {
    plugin_set_error("missing-request", "No NUM Gauss-Markov request frame was provided.");
    return 3;
  }
  if (!NUMBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-request-buffer", "Input is not an SDS NUM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyNUMBuffer(verifier)) {
    plugin_set_error("invalid-request-buffer", "Input is not a valid SDS NUM FlatBuffer.");
    return 3;
  }

  const NUM* envelope = GetNUM(frame->payload);
  const NUMGaussMarkovRequest* request = envelope ? envelope->GAUSS_MARKOV_REQUEST() : nullptr;
  const char* trace_id = request && request->TRACE_ID() ? request->TRACE_ID()->c_str() : nullptr;
  return emit_gauss_markov_result(compute_gauss_markov_request(request), trace_id);
}
