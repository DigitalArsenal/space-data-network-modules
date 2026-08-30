#pragma once

#include <array>
#include <cstdint>
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
  std::array<double, 4> value{};
  std::array<double, 4> sigma{{1.0, 1.0, 1.0, 1.0}};
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
};

struct PropagatorSample {
  CartesianState state{};
  Matrix6 stm{};
};

struct MeasurementPrediction {
  std::uint8_t count{0};
  std::array<double, 4> value{};
  std::array<Vector6, 4> jacobian{};
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

struct FilterConfig {
  CartesianState initial{};
  Matrix6 initial_covariance{};
  EstimatorKind estimator{EstimatorKind::EXTENDED_KALMAN_FILTER};
  ProcessNoiseKind process_noise{ProcessNoiseKind::NONE};
  std::array<double, 3> acceleration_psd{{0.0, 0.0, 0.0}};
  double dmc_correlation_time_seconds{3600.0};
  double sigma_edit_threshold{3.0};
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
};

struct FilterResult {
  std::vector<FilterEpoch> epochs;
  std::vector<std::size_t> rejected_indices;
  bool valid{false};
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
bool invert6(const Matrix6& input, Matrix6* inverse);
bool covariance_is_symmetric_positive_definite(const Matrix6& covariance,
                                               double tolerance = 1.0e-12);

double saastamoinen_hopfield_delay_m(const MediaEnvironment& environment);
double marini_murray_delay_m(const MediaEnvironment& environment);
double ionosphere_group_delay_m(const MediaEnvironment& environment);
double ionosphere_group_delay_rate_mps(const MediaEnvironment& environment);

MeasurementPrediction predict_measurement(const Observation& observation,
                                          const CartesianState& state);

BatchResult batch_weighted_least_squares(const BatchConfig& config,
                                         const std::vector<Observation>& observations,
                                         const std::vector<PropagatorSample>& samples);

FilterResult sequential_filter(const FilterConfig& config,
                               const std::vector<Observation>& observations,
                               const std::vector<PropagatorSample>& samples,
                               bool smooth);

std::vector<Observation> simulate_measurements(
    const std::vector<Observation>& templates,
    const std::vector<PropagatorSample>& truth_samples,
    const std::vector<ErrorModel>& error_models);

IodResult gauss_iod(const std::array<AnglesObservation, 3>& observations,
                    double gravitational_parameter_m3_s2);
IodResult laplace_iod(const std::array<AnglesObservation, 3>& observations,
                      double gravitational_parameter_m3_s2);
IodResult gibbs_iod(const std::array<CartesianState, 3>& positions,
                    double gravitational_parameter_m3_s2);
IodResult herrick_gibbs_iod(const std::array<CartesianState, 3>& positions,
                            double gravitational_parameter_m3_s2);

}  // namespace sdn::estimation
