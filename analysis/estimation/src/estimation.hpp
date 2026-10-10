#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace sdn::estimation {

constexpr double kSpeedOfLight = 299792458.0;
constexpr double kEarthRotationRate = 7.292115146706979e-5;

using Vector6 = std::array<double, 6>;
using Matrix6 = std::array<double, 36>;

struct Vec3 {
  double x{0.0};
  double y{0.0};
  double z{0.0};
};

struct CartesianState {
  double epoch_seconds{0.0};
  Vector6 value{};
};

enum class MeasurementKind : std::uint16_t {
  RANGE = 0,
  RANGE_RATE = 1,
  DOPPLER = 2,
  AZIMUTH_ELEVATION = 3,
  X_EAST_Y_NORTH = 4,
  X_SOUTH_Y_EAST = 5,
  RIGHT_ASCENSION_DECLINATION = 6,
  POSITION_VECTOR = 7,
  SEQUENTIAL_RANGE = 8,
  PSEUDONOISE_RANGE = 9,
  TIME_CORRELATED_PHASE = 10,
  RELAY_RANGE = 11,
  RELAY_DOPPLER = 12,
  RELAY_DIFFERENCED_DOPPLER = 13,
  BISTATIC_RANGE = 14,
  SKIN_RANGE = 15,
  CROSSLINK_RANGE = 16,
  CROSSLINK_RANGE_RATE = 17,
  LASER_RANGE = 18,
  TIME_DIFFERENCE_OF_ARRIVAL = 19,
  FREQUENCY_DIFFERENCE_OF_ARRIVAL = 20,
  POSITION_VELOCITY = 21,
  PSEUDORANGE = 22,
  LINEAR = 23,
};

enum class TroposphereModel : std::uint8_t {
  NONE = 0,
  HOPFIELD_SAASTAMOINEN = 1,
  MARINI = 2,
};

enum class IonosphereModel : std::uint8_t {
  NONE = 0,
  TOTAL_ELECTRON_CONTENT = 1,
  REFERENCE_PROFILE = 2,
};

enum class EstimatorKind : std::uint8_t {
  BATCH_WEIGHTED_LEAST_SQUARES = 0,
  EXTENDED_KALMAN_FILTER = 1,
  UNSCENTED_KALMAN_FILTER = 2,
  EXTENDED_KALMAN_FILTER_WITH_RTS = 3,
  LINEAR_KALMAN_FILTER = 4,
  // Epistemic Support-Point Filter as the 2025 operational paper describes
  // it (Jah and Haslett, arXiv 2508.20806) and as the 2026 TEAG papers state
  // it (Jah 2026: TEAG, ESPF-HJ, arXiv 2603.10065); docs/espf-spec.md.
  ESPF_2025 = 5,
  ESPF_2026 = 6,
  // Ellipsoidal set-membership filter (Schweppe 1968; Bertsekas and Rhodes
  // 1971), linearized about the propagated centre.
  ELLIPSOIDAL_SET_MEMBERSHIP = 7,
};

enum class ProcessNoiseKind : std::uint8_t {
  NONE = 0,
  STATE_NOISE_COMPENSATION = 1,
  DYNAMIC_MODEL_COMPENSATION = 2,
};

struct HardwarePath {
  double transmitter_delay_seconds{0.0};
  double receiver_delay_seconds{0.0};
  double transponder_delay_seconds{0.0};
  std::uint32_t turnaround_numerator{1};
  std::uint32_t turnaround_denominator{1};
};

struct MediaEnvironment {
  double elevation_rad{1.5707963267948966};
  double latitude_rad{0.0};
  double height_m{0.0};
  double pressure_hpa{1013.25};
  double temperature_k{293.15};
  double relative_humidity{0.5};
  double wavelength_m{0.532e-6};
  double total_electron_content{0.0};
  double total_electron_content_rate_per_second{0.0};
  double frequency_hz{8.4e9};
};

struct Observation {
  std::string id;
  double epoch_seconds{0.0};
  MeasurementKind kind{MeasurementKind::RANGE};
  std::uint8_t value_count{1};
  std::array<double, 6> value{};
  std::array<double, 6> sigma{{1.0, 1.0, 1.0, 1.0, 1.0, 1.0}};
  Vec3 station_position_m{};
  Vec3 station_velocity_mps{};
  Vec3 station_east{};
  Vec3 station_north{};
  Vec3 station_up{};
  Vec3 remote_position_m{};
  Vec3 remote_velocity_mps{};
  HardwarePath hardware{};
  MediaEnvironment media{};
  TroposphereModel troposphere{TroposphereModel::NONE};
  IonosphereModel ionosphere{IonosphereModel::NONE};
  bool apply_light_time{true};
  bool apply_sagnac{true};
  std::uint32_t transmitter_index{0};
  std::uint32_t receiver_index{0};
  std::vector<double> linear_matrix;
  std::vector<double> linear_offset;
  double satellite_clock_bias_m{0};
};

struct PropagatorSample {
  CartesianState state{};
  Matrix6 stm{};
};

struct MeasurementPrediction {
  std::uint8_t count{0};
  std::array<double, 6> value{};
  std::array<Vector6, 6> jacobian{};
  double geometric_range_m{0.0};
  double light_time_m{0.0};
  double sagnac_m{0.0};
  double troposphere_m{0.0};
  double ionosphere_m{0.0};
  double hardware_m{0.0};
};

struct ErrorModel {
  MeasurementKind kind{MeasurementKind::RANGE};
  double noise_sigma{1.0};
  double bias{0.0};
  double bias_sigma{0.0};
  double sigma_edit_threshold{3.0};
  std::uint64_t seed{1};
};

struct BatchConfig {
  CartesianState a_priori{};
  Matrix6 a_priori_covariance{};
  int maximum_iterations{12};
  double state_convergence_tolerance{1.0e-4};
  double rms_convergence_tolerance{1.0e-8};
  double sigma_edit_threshold{3.0};
};

struct BatchIteration {
  int iteration{0};
  double prefit_rms{0.0};
  double postfit_rms{0.0};
  double correction_norm{0.0};
  std::size_t accepted_count{0};
  std::size_t rejected_count{0};
};

struct BatchResult {
  CartesianState estimate{};
  Matrix6 covariance{};
  std::vector<double> residuals;
  std::vector<std::size_t> rejected_indices;
  std::vector<BatchIteration> iterations;
  std::vector<Matrix6> iteration_covariances;
  double residual_rms{0.0};
  double recovered_noise_sigma{0.0};
  bool converged{false};
};

using Vector8 = std::array<double, 8>;
using Matrix8 = std::array<double, 64>;
using PropagatorPort =
    std::function<bool(const CartesianState &, double, PropagatorSample *)>;

// ESPF parameters. Every default is the value a paper states or the choice
// docs/espf-spec.md records for a value it leaves open.
struct EspfOptions {
  int smolyak_level{0};                // 0: the variant's default (2025: 2, 2026: 3)
  double initial_bound_scale{3};       // r0: {(x - x0)' P0^-1 (x - x0) <= r0^2}
  double process_bound_scale{1};       // k_w: process-noise set shape k_w^2 Q
  double measurement_bound_scale{1};   // k_y: sensor set shape Pi_y = k_y^2 R
  // 2026 (TEAG, ESPF-HJ, 2603.10065).
  double sigma_initial{1}, sigma_min{0.1}, sigma_max{1};
  double rate_expand{1.15}, rate_contract{0.97};
  int minimum_survivors{0};            // 0: N_min = 2n + 1
  int pcrb_rank{0};                    // 0: state dimension n; 1: measurement rank m
  int medoid_metric{0};                // 0: MVEE of the survivors; 1: innovation metric
  double vfi_floor_ratio{1e-12};
  double mvee_tolerance{1e-7};
  int mvee_max_iterations{20000};
  bool entropy_diagnostics{false};
  bool record_support{false};          // emit each epoch's survivors
  // 2025 (2508.20806).
  double plausibility_radius{3};       // r = sqrt(-2 log(1 - eta))
  double compatibility_floor{1e-6};    // epsilon in S = -log(Comp + epsilon)
  double surprisal_threshold{1};
  double regularization{1e-6};
  bool regularization_relative{true};
  double spread_sigma0{1}, spread_sigma_min{0}, spread_sigma_max{1e300};
  double dispersion_gain{0}, surprisal_gain{0}, surprisal_reference{0}, surprisal_scale{1};
  double radius_gain_expand{0}, radius_gain_contract{0};
  double decay_rate{0.05};
  int mode_weighting{0};               // 0 residual possibility, 1 singleton necessity, 2 compatibility
  bool gaussian_limit{false};          // appendix: UT points, product fusion (the UKF)
  double pcrb_trigger{1};              // 2026: expand at this fraction of the PCRB floor (G18)
};

struct SetMembershipOptions {
  double initial_bound_scale{3};
  double process_bound_scale{3};
  double measurement_bound_scale{3};
  int criterion{0};                    // 0: minimum trace; 1: minimum log det
};

// The state an ESPF or set-membership run carries from one observation to
// the next; restartable (an arc can be split at any epoch).
struct SupportState {
  double epoch_seconds{0};
  EstimatorKind estimator{EstimatorKind::ESPF_2026};
  int count{0};
  std::vector<double> points;          // count x 6, SI, request frame
  std::vector<double> possibility;     // count
  Vector6 estimate{};
  Matrix6 shape{};
  double sigma{1}, radius{3}, dispersion{0};
  int steps{0};
  bool valid{false};
};

struct SupportEpoch {
  double epoch_seconds{0};
  Vector6 estimate{};
  Matrix6 shape{};                     // posterior set (2026: MVEE of the survivors; 2025: spread; SMF: bound)
  Matrix6 carried_shape{};             // what is carried forward (2026: sigma^2 MVEE; 2025: sigma^2 spread; SMF: bound)
  Matrix6 predicted_shape{};
  int support_count{0}, survivor_count{0}, medoid_index{-1};
  double choquet_surprisal{0}, information{0}, normalization_shift{0};
  double minimum_whitened_innovation{0}, basin_radius{0}, basin_threshold{0};
  double pcrb_floor{0}, log_volume_change{0}, sigma{0}, radius{0}, dispersion{0};
  double mean_surprisal{0}, regime_log_det{0}, entropy{0}, entropy_alpha{0};
  bool inconsistent{false}, accepted{true};
  std::vector<double> survivors;       // survivor_count x 6 when recorded
  std::vector<double> survivor_possibility;
};

struct FilterConfig {
  CartesianState initial{};
  Matrix6 initial_covariance{};
  EstimatorKind estimator{EstimatorKind::EXTENDED_KALMAN_FILTER};
  ProcessNoiseKind process_noise{ProcessNoiseKind::NONE};
  std::array<double, 3> acceleration_psd{{0.0, 0.0, 0.0}};
  double dmc_correlation_time_seconds{3600.0};
  double sigma_edit_threshold{3.0};
  double ukf_alpha{1}, ukf_beta{2}, ukf_kappa{0};
  PropagatorPort propagator;
  bool adaptive_process_noise{false}, inflate_measurement_noise{false};
  double adaptation_rate{0.05}, minimum_process_scale{0.01},
      maximum_process_scale{100};
  double maximum_measurement_scale{100};
  bool estimate_clock{false};
  double initial_clock_bias_m{0}, initial_clock_drift_mps{0};
  Matrix8 initial_covariance8{};
  double clock_bias_psd{0}, clock_drift_psd{0};
  EspfOptions espf{};
  SetMembershipOptions set_membership{};
  SupportState initial_support{};      // used when valid
};

struct FilterEpoch {
  CartesianState filtered{};
  Matrix6 filtered_covariance{};
  CartesianState predicted{};
  Matrix6 predicted_covariance{};
  CartesianState smoothed{};
  Matrix6 smoothed_covariance{};
  Matrix6 transition{};
  double normalized_innovation_squared{0.0};
  bool accepted{false};
  Vector8 filtered_extended{}, smoothed_extended{};
  Matrix8 filtered_covariance_extended{}, smoothed_covariance_extended{};
  double process_noise_scale{1}, measurement_noise_scale{1};
};

struct FilterResult {
  std::vector<FilterEpoch> epochs;
  std::vector<std::size_t> rejected_indices;
  bool valid{false};
  std::vector<SupportEpoch> support;   // ESPF and set-membership runs
  SupportState final_support{};
  std::string error;
};

struct AnglesObservation {
  double epoch_seconds{0.0};
  double right_ascension_rad{0.0};
  double declination_rad{0.0};
  Vec3 observer_position_m{};
};

struct IodResult {
  CartesianState state{};
  int iterations{0};
  bool valid{false};
};

Vec3 add(Vec3 a, Vec3 b);
Vec3 subtract(Vec3 a, Vec3 b);
Vec3 scale(Vec3 a, double s);
double dot(Vec3 a, Vec3 b);
Vec3 cross(Vec3 a, Vec3 b);
double norm(Vec3 a);

Matrix6 identity6();
bool invert6(const Matrix6 &input, Matrix6 *inverse);
bool covariance_is_symmetric_positive_definite(const Matrix6 &covariance,
                                               double tolerance = 1.0e-12);

double saastamoinen_hopfield_delay_m(const MediaEnvironment &environment);
double marini_murray_delay_m(const MediaEnvironment &environment);
double ionosphere_group_delay_m(const MediaEnvironment &environment);
double ionosphere_group_delay_rate_mps(const MediaEnvironment &environment);

MeasurementPrediction predict_measurement(const Observation &observation,
                                          const CartesianState &state);

BatchResult
batch_weighted_least_squares(const BatchConfig &config,
                             const std::vector<Observation> &observations,
                             const std::vector<PropagatorSample> &samples);

FilterResult sequential_filter(const FilterConfig &config,
                               const std::vector<Observation> &observations,
                               const std::vector<PropagatorSample> &samples,
                               bool smooth);

// The process-noise covariance of the sequential filters over an interval,
// and the residual convention they share (angles wrapped to [-pi, pi]).
Matrix6 process_noise_covariance(const FilterConfig &config, double elapsed_seconds);
double measurement_residual(MeasurementKind kind, int component, double observed, double predicted);

// ESPF (2025 and 2026 variants) and the ellipsoidal set-membership filter.
// Nonlinear propagation through config.propagator only (espf.cpp).
FilterResult support_filter(const FilterConfig &config, const std::vector<Observation> &observations);
FilterResult set_membership_filter(const FilterConfig &config, const std::vector<Observation> &observations);

std::vector<Observation>
simulate_measurements(const std::vector<Observation> &templates,
                      const std::vector<PropagatorSample> &truth_samples,
                      const std::vector<ErrorModel> &error_models);

// Batch least squares of the state at the configuration epoch plus dynamic
// parameters (B, BDOT, AGOM, ...), through an external propagator. The
// propagator returns, for one seed [state, parameters] and the observation
// epochs, each sample's state, its 6x6 STM and its 6 x p parameter
// sensitivity (row-major), all relative to the seed epoch. Returning false
// means the samples are not available yet (inverted port).
struct ParameterSample {
  CartesianState state{};
  Matrix6 stm{};
  std::vector<double> sensitivity;
};
using ParameterPropagatorPort = std::function<bool(
    const Vector6 &seed, const std::vector<double> &parameters,
    std::vector<ParameterSample> *samples)>;

struct BatchFitConfig {
  Vector6 initial_state{};
  std::vector<double> initial_parameters;
  // (6 + p)^2 row-major, or empty for no a priori information.
  std::vector<double> apriori_covariance;
  // Per observation, value_count^2 row-major (empty: its sigmas). With
  // rtn_axes the matrix is in the radial, transverse, normal axes of the
  // observed state itself (POSITION_VELOCITY observations).
  std::vector<std::vector<double>> observation_covariances;
  bool rtn_axes{false};
  int maximum_iterations{20};
  double correction_tolerance{1.0e-3};
  double sigma_edit_threshold{0.0};
  ParameterPropagatorPort propagator;
};

struct BatchFitResult {
  bool valid{false};
  bool pending{false};  // the propagator has not answered yet
  std::string error;
  std::vector<double> estimate;    // 6 + p
  std::vector<double> covariance;  // (6 + p)^2, formal
  double chi_square{0.0};
  double weighted_rms{0.0};
  double reduced_chi_square{0.0};
  std::size_t measurement_count{0};
  std::size_t degrees_of_freedom{0};
  int iterations{0};
  bool converged{false};
  std::vector<double> whitened_residuals;
  std::vector<std::size_t> rejected_indices;
};

BatchFitResult batch_fit(const BatchFitConfig &config,
                         const std::vector<Observation> &observations);

IodResult gauss_iod(const std::array<AnglesObservation, 3> &observations,
                    double gravitational_parameter_m3_s2);
IodResult laplace_iod(const std::array<AnglesObservation, 3> &observations,
                      double gravitational_parameter_m3_s2);
IodResult gibbs_iod(const std::array<CartesianState, 3> &positions,
                    double gravitational_parameter_m3_s2);
IodResult herrick_gibbs_iod(const std::array<CartesianState, 3> &positions,
                            double gravitational_parameter_m3_s2);

} // namespace sdn::estimation
