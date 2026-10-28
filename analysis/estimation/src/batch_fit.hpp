#pragma once

#include "estimation.hpp"

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

// fit_batch: batch least squares through an inverted propagator port
// (batch_fit.cpp). Only batch_fit.cpp and module.cpp include this header;
// the modules that compose estimation.hpp into their own builds
// (catalog-composer, observation-simulator) do not see it.
namespace sdn::estimation {

// Batch least squares of the state at the configuration epoch plus dynamic
// parameters (B, BDOT, AGOM, ECOM2, ...) and measurement parameters, through
// an external propagator. For one seed [state, parameters] and a list of
// epochs (an observation's epoch plus a shift: the time bias), the
// propagator returns each sample's state, its 6x6 STM and its 6 x p
// parameter sensitivity (row-major), all relative to the seed epoch.
// PENDING: the samples are not available yet (inverted port); REFUSED: the
// propagator rejects the seed (for example a parameter outside its domain),
// with its error text in *refusal.
struct ParameterSample {
  CartesianState state{};
  Matrix6 stm{};
  std::vector<double> sensitivity;
};
struct EpochRequest {
  std::size_t observation{0};
  double shift_seconds{0.0};
};
enum class PortAnswer : std::uint8_t { ANSWERED = 0, PENDING = 1, REFUSED = 2 };
using ParameterPropagatorPort = std::function<PortAnswer(
    const Vector6 &seed, const std::vector<double> &parameters,
    const std::vector<EpochRequest> &epochs,
    std::vector<ParameterSample> *samples, std::string *refusal)>;

enum class ParameterTransform : std::uint8_t { IDENTITY = 0, LOGARITHM = 1 };
enum class MeasurementParameterKind : std::uint8_t { BIAS = 0, DRIFT = 1, TIME_BIAS = 2 };

struct MeasurementParameter {
  MeasurementParameterKind kind{MeasurementParameterKind::BIAS};
  int component{0};
  std::vector<std::size_t> observations;
  double value{0.0};
  double sigma{0.0};  // a priori; 0: none
  bool consider{false};
  bool has_reference{false};
  double reference_seconds{0.0};  // DRIFT, from the configuration epoch
};

struct CovarianceBlock {
  std::vector<std::size_t> observations;
  std::vector<double> covariance;
};

struct CovarianceRegularization {
  int block{-1};
  std::size_t observation{0};
  int dimension{0};
  int raised{0};
  double minimum_eigenvalue{0.0};
  double frobenius_change{0.0};
  double maximum_correlation_change{0.0};
};

struct BatchFitConfig {
  Vector6 initial_state{};
  std::vector<double> initial_parameters;
  // (6 + p)^2 row-major, or empty for no a priori information.
  std::vector<double> apriori_covariance;
  // Per observation, value_count^2 row-major (empty: its sigmas). With
  // rtn_axes the matrix is in the radial, transverse, normal axes of the
  // observed state (POSITION_VELOCITY; POSITION_VECTOR with the predicted
  // velocity); other kinds keep their own components.
  std::vector<std::vector<double>> observation_covariances;
  bool rtn_axes{false};
  int maximum_iterations{20};
  double correction_tolerance{1.0e-3};
  double sigma_edit_threshold{0.0};
  ParameterPropagatorPort propagator;
  std::vector<ParameterTransform> transforms;  // p or empty
  // Each dynamic parameter's domain: p entries each, required when p > 0;
  // NaN: unbounded on that side.
  std::vector<double> lower_bounds;
  std::vector<double> upper_bounds;
  std::vector<bool> consider;                  // p or empty
  std::vector<MeasurementParameter> measurement_parameters;
  std::vector<CovarianceBlock> covariance_blocks;
  bool regularize{false};
  double correlation_floor{1.0e-3};
  bool rtn_output{false};
};

enum class BatchFitTermination : std::uint8_t { CONVERGED = 0, MAXIMUM_ITERATIONS = 1, STALLED = 2 };

struct BatchFitResult {
  bool valid{false};
  bool pending{false};  // the propagator has not answered yet
  std::string error;
  std::vector<double> estimate;    // 6 + p + q
  std::vector<double> covariance;  // (6 + p + q)^2, formal
  std::vector<double> scaled_covariance;
  double chi_square{0.0};
  double weighted_rms{0.0};
  double reduced_chi_square{0.0};
  std::size_t measurement_count{0};
  std::size_t degrees_of_freedom{0};
  int iterations{0};
  bool converged{false};
  std::vector<double> whitened_residuals;
  std::vector<std::size_t> rejected_indices;
  std::size_t measurement_parameter_count{0};
  std::vector<double> consider_covariance;
  std::vector<std::uint8_t> bound_status;
  std::vector<double> covariance_rtn;
  std::vector<double> consider_covariance_rtn;
  std::vector<CovarianceRegularization> regularizations;
  BatchFitTermination termination{BatchFitTermination::CONVERGED};
  std::size_t rejected_trials{0};  // trials not accepted, refused ones included
  std::size_t refused_trials{0};
  std::string refusal;             // the first refusal's text
};

BatchFitResult batch_fit(const BatchFitConfig &config,
                         const std::vector<Observation> &observations);

} // namespace sdn::estimation
