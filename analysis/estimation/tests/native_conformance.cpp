#include "estimation.hpp"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <iostream>
#include <vector>

using namespace sdn::estimation;

namespace {

Matrix6 diagonal(double position_variance, double velocity_variance) {
  Matrix6 result{};
  for (int i = 0; i < 3; ++i) result[i * 6 + i] = position_variance;
  for (int i = 3; i < 6; ++i) result[i * 6 + i] = velocity_variance;
  return result;
}

Matrix6 constant_velocity_stm(double dt) {
  Matrix6 result = identity6();
  for (int i = 0; i < 3; ++i) result[i * 6 + i + 3] = dt;
  return result;
}

CartesianState propagated(const CartesianState& initial, double dt) {
  CartesianState result = initial;
  result.epoch_seconds += dt;
  for (int i = 0; i < 3; ++i) result.value[i] += initial.value[i + 3] * dt;
  return result;
}

double position_error(const CartesianState& a, const CartesianState& b) {
  return std::hypot(std::hypot(a.value[0] - b.value[0], a.value[1] - b.value[1]),
                    a.value[2] - b.value[2]);
}

double relative_error(double actual, double expected) {
  return std::abs(actual - expected) / std::max(std::abs(expected), 1.0e-18);
}

double wrapped_angle_error(double actual, double expected) {
  return std::abs(std::remainder(actual - expected, 2.0 * std::acos(-1.0)));
}

Vector6 multiply(const Matrix6& matrix, const Vector6& vector) {
  Vector6 result{};
  for (int row = 0; row < 6; ++row) {
    for (int column = 0; column < 6; ++column) {
      result[row] += matrix[row * 6 + column] * vector[column];
    }
  }
  return result;
}

struct TestPcg32 {
  std::uint64_t state;
  std::uint64_t sequence{0xda3e39cb94b95bdbULL};

  explicit TestPcg32(std::uint64_t seed) : state(seed + 0x853c49e6748fea9bULL) {}

  std::uint32_t next() {
    const std::uint64_t previous = state;
    state = previous * 6364136223846793005ULL + (sequence | 1ULL);
    const std::uint32_t xorshifted =
        static_cast<std::uint32_t>(((previous >> 18U) ^ previous) >> 27U);
    const std::uint32_t rotation = static_cast<std::uint32_t>(previous >> 59U);
    return (xorshifted >> rotation) | (xorshifted << ((-rotation) & 31));
  }

  double normal() {
    const double u1 = std::max((static_cast<double>(next()) + 0.5) / 4294967296.0,
                               1.0e-15);
    const double u2 = (static_cast<double>(next()) + 0.5) / 4294967296.0;
    return std::sqrt(-2.0 * std::log(u1)) *
           std::cos(2.0 * std::acos(-1.0) * u2);
  }
};

double normalized_estimation_error_squared(const CartesianState& estimate,
                                           const CartesianState& truth,
                                           const Matrix6& covariance) {
  Matrix6 inverse{};
  assert(invert6(covariance, &inverse));
  Vector6 error{};
  for (int i = 0; i < 6; ++i) error[i] = estimate.value[i] - truth.value[i];
  double nees = 0.0;
  for (int row = 0; row < 6; ++row) {
    for (int column = 0; column < 6; ++column) {
      nees += error[row] * inverse[row * 6 + column] * error[column];
    }
  }
  return nees;
}

}  // namespace

int main() {
  CartesianState truth{};
  truth.value = {7000000.0, 1200000.0, 300000.0, -1200.0, 7300.0, 450.0};
  CartesianState apriori = truth;
  apriori.value[0] += 120.0;
  apriori.value[1] -= 80.0;
  apriori.value[2] += 60.0;
  apriori.value[3] += 0.12;
  apriori.value[4] -= 0.08;
  apriori.value[5] += 0.05;

  std::vector<Observation> templates;
  std::vector<PropagatorSample> samples;
  std::vector<PropagatorSample> truth_samples;
  for (int i = 0; i < 24; ++i) {
    const double dt = i * 20.0;
    PropagatorSample sample{};
    sample.state = propagated(apriori, dt);
    sample.stm = constant_velocity_stm(dt);
    samples.push_back(sample);
    PropagatorSample truth_sample = sample;
    truth_sample.state = propagated(truth, dt);
    truth_samples.push_back(truth_sample);
    Observation observation{};
    observation.id = "obs-" + std::to_string(i);
    observation.epoch_seconds = dt;
    observation.station_position_m = {6378137.0, 0.0, 0.0};
    observation.station_velocity_mps = {0.0, kEarthRotationRate * 6378137.0, 0.0};
    observation.apply_light_time = false;
    observation.apply_sagnac = false;
    observation.kind = (i % 3 == 0) ? MeasurementKind::POSITION_VECTOR
                                    : ((i % 3 == 1) ? MeasurementKind::RANGE
                                                    : MeasurementKind::RANGE_RATE);
    const MeasurementPrediction prediction = predict_measurement(observation, truth_sample.state);
    observation.value_count = prediction.count;
    observation.value = prediction.value;
    for (int component = 0; component < prediction.count; ++component) {
      observation.sigma[component] = observation.kind == MeasurementKind::POSITION_VECTOR ? 1.0 :
                                     observation.kind == MeasurementKind::RANGE ? 1.0 : 0.01;
    }
    templates.push_back(observation);
  }

  BatchConfig batch{};
  batch.a_priori = apriori;
  batch.a_priori_covariance = diagonal(10000.0, 1.0);
  batch.maximum_iterations = 10;
  batch.state_convergence_tolerance = 1.0e-6;
  batch.rms_convergence_tolerance = 1.0e-9;
  batch.sigma_edit_threshold = 4.0;
  BatchResult fit = batch_weighted_least_squares(batch, templates, samples);
  assert(fit.converged);
  assert(fit.iteration_covariances.size() == fit.iterations.size());
  for (const Matrix6& iteration_covariance : fit.iteration_covariances) {
    assert(covariance_is_symmetric_positive_definite(iteration_covariance, 1.0e-8));
  }
  assert(position_error(fit.estimate, truth) < 1.0);
  assert(covariance_is_symmetric_positive_definite(fit.covariance, 1.0e-8));

  // Tier C residual orthogonality: evaluate the complete weighted normal
  // equation, including the a-priori information term, at the converged
  // epoch state. A zero correction means this score is numerically zero.
  Matrix6 apriori_information{};
  assert(invert6(batch.a_priori_covariance, &apriori_information));
  Vector6 estimate_minus_apriori{};
  Vector6 apriori_minus_estimate{};
  for (int i = 0; i < 6; ++i) {
    estimate_minus_apriori[i] = fit.estimate.value[i] - apriori.value[i];
    apriori_minus_estimate[i] = -estimate_minus_apriori[i];
  }
  Vector6 normal_score = multiply(apriori_information, apriori_minus_estimate);
  for (std::size_t index = 0; index < templates.size(); ++index) {
    CartesianState linearized = samples[index].state;
    const Vector6 propagated_delta = multiply(samples[index].stm,
                                               estimate_minus_apriori);
    for (int i = 0; i < 6; ++i) linearized.value[i] += propagated_delta[i];
    const MeasurementPrediction prediction = predict_measurement(templates[index],
                                                                  linearized);
    for (int component = 0; component < prediction.count; ++component) {
      Vector6 h_epoch{};
      for (int column = 0; column < 6; ++column) {
        for (int inner = 0; inner < 6; ++inner) {
          h_epoch[column] += prediction.jacobian[component][inner] *
                             samples[index].stm[inner * 6 + column];
        }
      }
      const double residual = templates[index].value[component] -
                              prediction.value[component];
      const double sigma = std::max(templates[index].sigma[component], 1.0e-18);
      const double weight = 1.0 / (sigma * sigma);
      for (int column = 0; column < 6; ++column) {
        normal_score[column] += h_epoch[column] * weight * residual;
      }
    }
  }
  double residual_orthogonality = 0.0;
  for (double component : normal_score) {
    residual_orthogonality = std::max(residual_orthogonality,
                                      std::abs(component));
  }
  assert(residual_orthogonality < 1.0e-6);

  std::vector<Observation> edited = templates;
  edited[7].value[0] += 1000.0;
  BatchResult edited_fit = batch_weighted_least_squares(batch, edited, samples);
  assert(edited_fit.rejected_indices.size() == 1);
  assert(edited_fit.rejected_indices[0] == 7);

  FilterConfig filter{};
  filter.initial = apriori;
  filter.initial_covariance = diagonal(10000.0, 1.0);
  filter.estimator = EstimatorKind::EXTENDED_KALMAN_FILTER;
  filter.process_noise = ProcessNoiseKind::STATE_NOISE_COMPENSATION;
  filter.acceleration_psd = {1.0e-6, 1.0e-6, 1.0e-6};
  filter.sigma_edit_threshold = 20.0;
  FilterResult ekf = sequential_filter(filter, templates, samples, true);
  assert(ekf.valid);
  const CartesianState final_truth = propagated(truth, templates.back().epoch_seconds);
  assert(position_error(ekf.epochs.back().filtered, final_truth) < 1.0);
  for (const FilterEpoch& epoch : ekf.epochs) {
    for (int axis = 0; axis < 6; ++axis) {
      assert(epoch.smoothed_covariance[axis * 6 + axis] <=
             epoch.filtered_covariance[axis * 6 + axis] + 1.0e-8);
    }
  }

  filter.estimator = EstimatorKind::UNSCENTED_KALMAN_FILTER;
  FilterResult ukf = sequential_filter(filter, templates, samples, false);
  assert(ukf.valid);
  double covariance_difference = 0.0;
  for (int i = 0; i < 36; ++i) {
    covariance_difference += std::abs(ukf.epochs.back().filtered_covariance[i] -
                                      ekf.epochs.back().filtered_covariance[i]);
  }
  assert(covariance_difference > 1.0e-9);

  FilterConfig no_noise = filter;
  no_noise.estimator = EstimatorKind::EXTENDED_KALMAN_FILTER;
  no_noise.process_noise = ProcessNoiseKind::NONE;
  FilterResult zero_q = sequential_filter(no_noise, templates, samples, false);
  const double snc_growth_ratio =
      ekf.epochs.back().predicted_covariance[0] /
      zero_q.epochs.back().predicted_covariance[0];
  assert(snc_growth_ratio > 1.0);
  FilterConfig dmc = no_noise;
  dmc.process_noise = ProcessNoiseKind::DYNAMIC_MODEL_COMPENSATION;
  dmc.acceleration_psd = {1.0e-5, 1.0e-5, 1.0e-5};
  dmc.dmc_correlation_time_seconds = 300.0;
  FilterResult dmc_result = sequential_filter(dmc, templates, samples, false);
  const double process_noise_ratio =
      dmc_result.epochs.back().predicted_covariance[0] /
      zero_q.epochs.back().predicted_covariance[0];
  assert(process_noise_ratio > 1.0);
  const double smoother_position_error = position_error(
      ekf.epochs.back().smoothed, final_truth);
  assert(smoother_position_error < 0.5);

  ErrorModel error{};
  error.kind = MeasurementKind::RANGE;
  error.noise_sigma = 4.0;
  error.seed = 42;
  const std::vector<Observation> simulated = simulate_measurements(templates, truth_samples, {error});
  assert(simulated.size() == templates.size());

  // Tier C statistical lane. Position-vector observations keep this Monte
  // Carlo focused on estimator consistency rather than on a second force
  // model: caller-supplied samples and STMs are the only propagation inputs.
  std::vector<Observation> monte_carlo_templates;
  std::vector<PropagatorSample> monte_carlo_nominal;
  std::vector<PropagatorSample> monte_carlo_truth;
  for (int index = 0; index < 32; ++index) {
    const double dt = index * 15.0;
    Observation observation;
    observation.id = "mc-" + std::to_string(index);
    observation.epoch_seconds = dt;
    observation.kind = MeasurementKind::POSITION_VECTOR;
    observation.value_count = 3;
    observation.apply_light_time = false;
    observation.apply_sagnac = false;
    monte_carlo_templates.push_back(observation);
    PropagatorSample nominal;
    nominal.state = propagated(apriori, dt);
    nominal.stm = constant_velocity_stm(dt);
    monte_carlo_nominal.push_back(nominal);
    PropagatorSample exact = nominal;
    exact.state = propagated(truth, dt);
    monte_carlo_truth.push_back(exact);
  }

  constexpr int simulator_runs = 200;
  constexpr double injected_sigma = 2.0;
  int simulator_inside_three_sigma = 0;
  double recovered_noise_square_sum = 0.0;
  for (int run = 0; run < simulator_runs; ++run) {
    ErrorModel injected;
    injected.kind = MeasurementKind::POSITION_VECTOR;
    injected.noise_sigma = injected_sigma;
    injected.seed = 0x600d0000ULL + static_cast<std::uint64_t>(run);
    const std::vector<Observation> run_observations = simulate_measurements(
        monte_carlo_templates, monte_carlo_truth, {injected});
    BatchConfig run_config = batch;
    run_config.sigma_edit_threshold = 1.0e9;
    const BatchResult run_fit = batch_weighted_least_squares(
        run_config, run_observations, monte_carlo_nominal);
    assert(run_fit.converged);
    const double rss_position_sigma = std::sqrt(
        run_fit.covariance[0] + run_fit.covariance[7] + run_fit.covariance[14]);
    if (position_error(run_fit.estimate, truth) <= 3.0 * rss_position_sigma) {
      ++simulator_inside_three_sigma;
    }
    recovered_noise_square_sum += run_fit.recovered_noise_sigma *
                                  run_fit.recovered_noise_sigma;
  }
  const double simulator_coverage =
      static_cast<double>(simulator_inside_three_sigma) / simulator_runs;
  const double recovered_noise_sigma =
      std::sqrt(recovered_noise_square_sum / simulator_runs);
  assert(simulator_coverage >= 0.95);
  assert(relative_error(recovered_noise_sigma, injected_sigma) <= 0.05);

  constexpr int nees_runs = 100;
  double nees_sum = 0.0;
  for (int run = 0; run < nees_runs; ++run) {
    TestPcg32 random(0x4e454553ULL + static_cast<std::uint64_t>(run));
    CartesianState randomized_initial = truth;
    for (int axis = 0; axis < 3; ++axis) {
      randomized_initial.value[axis] += 100.0 * random.normal();
      randomized_initial.value[axis + 3] += 0.1 * random.normal();
    }
    std::vector<PropagatorSample> run_nominal;
    run_nominal.reserve(monte_carlo_nominal.size());
    for (const PropagatorSample& exact : monte_carlo_truth) {
      PropagatorSample nominal = exact;
      const double dt = exact.state.epoch_seconds - truth.epoch_seconds;
      nominal.state = propagated(randomized_initial, dt);
      nominal.stm = constant_velocity_stm(dt);
      run_nominal.push_back(nominal);
    }
    ErrorModel measurement_noise;
    measurement_noise.kind = MeasurementKind::POSITION_VECTOR;
    measurement_noise.noise_sigma = 5.0;
    measurement_noise.seed = 0x10000000ULL + static_cast<std::uint64_t>(run);
    const std::vector<Observation> run_observations = simulate_measurements(
        monte_carlo_templates, monte_carlo_truth, {measurement_noise});
    FilterConfig run_filter;
    run_filter.initial = randomized_initial;
    run_filter.initial_covariance = diagonal(10000.0, 0.01);
    run_filter.estimator = EstimatorKind::EXTENDED_KALMAN_FILTER;
    run_filter.process_noise = ProcessNoiseKind::NONE;
    run_filter.sigma_edit_threshold = 1.0e9;
    const FilterResult run_result = sequential_filter(run_filter, run_observations,
                                                      run_nominal, false);
    assert(run_result.valid);
    const CartesianState run_truth = monte_carlo_truth.back().state;
    nees_sum += normalized_estimation_error_squared(
        run_result.epochs.back().filtered, run_truth,
        run_result.epochs.back().filtered_covariance);
  }
  const double average_nees = nees_sum / nees_runs;
  // chi-square(600) central 95% interval divided by 100 trials.
  constexpr double nees_lower_95 = 5.3402;
  constexpr double nees_upper_95 = 6.6977;
  assert(average_nees >= nees_lower_95 && average_nees <= nees_upper_95);

  MediaEnvironment media{};
  media.elevation_rad = 0.7;
  media.latitude_rad = 0.5;
  media.pressure_hpa = 1013.25;
  media.temperature_k = 293.15;
  media.total_electron_content = 1.0e17;
  media.frequency_hz = 1.57542e9;
  const double saastamoinen = saastamoinen_hopfield_delay_m(media);
  const double marini = marini_murray_delay_m(media);
  const double ionosphere = ionosphere_group_delay_m(media);
  assert(saastamoinen > 2.0 && saastamoinen < 5.0);
  assert(marini > 2.0 && marini < 6.0);
  assert(std::abs(ionosphere -
                  kSpeedOfLight * 1.345e-7 * 1.0e17 /
                      (1.57542e9 * 1.57542e9)) < 1.0e-12);

  MediaEnvironment orekit_saastamoinen;
  orekit_saastamoinen.elevation_rad = 5.0 * std::acos(-1.0) / 180.0;
  orekit_saastamoinen.latitude_rad = 37.5 * std::acos(-1.0) / 180.0;
  orekit_saastamoinen.height_m = 824.0;
  orekit_saastamoinen.pressure_hpa = 1013.25;
  orekit_saastamoinen.temperature_k = 293.15;
  orekit_saastamoinen.relative_humidity = 0.5;
  const double orekit_saastamoinen_delay =
      saastamoinen_hopfield_delay_m(orekit_saastamoinen);
  constexpr double orekit_saastamoinen_expected = 24.26096;
  const double orekit_saastamoinen_relative = relative_error(
      orekit_saastamoinen_delay, orekit_saastamoinen_expected);
  assert(orekit_saastamoinen_relative <= 1.0e-4);

  MediaEnvironment orekit_marini;
  orekit_marini.elevation_rad = 10.0 * std::acos(-1.0) / 180.0;
  orekit_marini.latitude_rad = 45.0 * std::acos(-1.0) / 180.0;
  orekit_marini.height_m = 100.0;
  orekit_marini.pressure_hpa = 1013.25;
  orekit_marini.temperature_k = 293.15;
  orekit_marini.relative_humidity = 0.5;
  orekit_marini.wavelength_m = 694.3e-9;
  const double orekit_marini_delay = marini_murray_delay_m(orekit_marini);
  constexpr double orekit_marini_expected = 13.2611;
  const double orekit_marini_relative = relative_error(
      orekit_marini_delay, orekit_marini_expected);
  assert(orekit_marini_relative <= 1.0e-4);

  MediaEnvironment p531_table3;
  p531_table3.total_electron_content = 1.0e18;
  p531_table3.frequency_hz = 1.0e9;
  const double p531_table3_range_error = ionosphere_group_delay_m(p531_table3);
  constexpr double p531_table3_expected_range_m = kSpeedOfLight * 1.345e-7;
  assert(std::abs(p531_table3_range_error - p531_table3_expected_range_m) <= 1.0e-12);

  // Tier A: mechanically exported from the official Orekit 13.1.7 tests
  // RangeTest, RangeRateTest, AngularAzElTest and AngularRaDecTest at tag
  // cc18cc16de92ef36159114113cfbb042ae88d0db. The exporter records the
  // estimated observable together with the exact inertial spacecraft/station
  // PV and topocentric basis used by Orekit.
  struct OrekitCase {
    MeasurementKind kind;
    Vector6 state;
    Vec3 station;
    Vec3 station_velocity;
    Vec3 east;
    Vec3 north;
    Vec3 up;
    std::array<double, 2> expected;
    int count;
  };
  const std::array<OrekitCase, 4> orekit_cases{{
    {MeasurementKind::RANGE,
     {-1295599.6811685357, -15894523.031858629, -5481625.0681028850,
      1630.1457053487827, 1327.2811382907917, -4035.1681217224270},
     {1424049.3090948395, -3569268.4255451380, -5075607.7290556915},
     {260.28310275759740, 103.83884142818422, 0.0053736611785990040},
     {0.92881396518391090, 0.37054637727427240, 1.9189976410372010e-05},
     {0.29613379900853120, -0.74232203878850120, 0.60105138200794280},
     {0.22273165730115113, -0.55825923460144900, -0.79921038270163070},
     {12628271.529401785, 0.0}, 1},
    {MeasurementKind::RANGE_RATE,
     {-5596894.4714920010, -6967948.9198903170, 12442633.751413770,
      -259.82121877613910, -4645.6449290825320, -1953.0384009677020},
     {-2604154.6282714800, -1435338.4996088883, 5624664.1781489750},
     {104.65772525013132, -189.89302603049248, -0.0028217638958535885},
     {0.48268536491910097, -0.87579383322970480, -1.3028244768897856e-05},
     {0.77539103281341880, 0.42734240911969157, 0.46491634903530630},
     {-0.40716530393128403, -0.22441841957512987, 0.88535461157094960},
     {1339.6401123429280, 0.0}, 1},
    {MeasurementKind::AZIMUTH_ELEVATION,
     {4717826.6914451510, -902212.90495740950, -14455585.819479698,
      781.44749801529790, 4978.0826974190800, 607.80713485873230},
     {2590182.1374107030, 2839029.3112663333, -5075456.2950842230},
     {-207.01731867957787, 188.87466228624170, 0.0016040740369067951},
     {-0.73873623989223440, 0.67399463487255210, 5.7356838323585620e-06},
     {0.53865009190501860, 0.59038585072033940, 0.60108287761334100},
     {0.40512324835856806, 0.44404479439830700, -0.79918669546431210},
     {3.6899649937063690, 0.70616945021684650}, 2},
    {MeasurementKind::RIGHT_ASCENSION_DECLINATION,
     {-5596884.8863709880, -6967777.5434173420, 12442705.797265543,
      -259.84410788814404, -4645.6734249456085, -1952.9875152653850},
     {1797138.2114396875, -2368913.1394458710, 5624696.3890194090},
     {172.73503080682790, 131.05422156962854, 0.0048612648737582365},
     {0.79666047129309450, 0.60442707829404260, 2.2449763424081670e-05},
     {-0.53514366265602440, 0.70532472942436470, 0.46490675020001804},
     {0.28098639432926253, -0.37038484457031184, 0.88535965184464250},
     {-2.5851748062111820, 0.66428957635140300}, 2},
  }};
  double orekit_max_relative = 0.0;
  double orekit_max_angle_rad = 0.0;
  double orekit_range_relative = 0.0;
  double orekit_range_rate_relative = 0.0;
  double orekit_az_el_relative = 0.0;
  double orekit_ra_dec_relative = 0.0;
  for (const OrekitCase& fixture : orekit_cases) {
    Observation observation;
    observation.kind = fixture.kind;
    observation.station_position_m = fixture.station;
    observation.station_velocity_mps = fixture.station_velocity;
    observation.station_east = fixture.east;
    observation.station_north = fixture.north;
    observation.station_up = fixture.up;
    // Orekit's estimated state is already at the signal event epoch. This
    // vector lane therefore exercises the observable itself; the independent
    // correction lane below exercises the reception->emission light-time map.
    observation.apply_light_time = false;
    observation.apply_sagnac = false;
    CartesianState authority_state;
    authority_state.value = fixture.state;
    const MeasurementPrediction actual = predict_measurement(observation, authority_state);
    assert(actual.count == fixture.count);
    for (int component = 0; component < fixture.count; ++component) {
      if (fixture.kind == MeasurementKind::AZIMUTH_ELEVATION ||
          fixture.kind == MeasurementKind::RIGHT_ASCENSION_DECLINATION) {
        const double error = wrapped_angle_error(actual.value[component], fixture.expected[component]);
        orekit_max_angle_rad = std::max(orekit_max_angle_rad, error);
        const double relative = error /
            std::max(std::abs(fixture.expected[component]), 1.0e-18);
        if (fixture.kind == MeasurementKind::AZIMUTH_ELEVATION) {
          orekit_az_el_relative = std::max(orekit_az_el_relative, relative);
        } else {
          orekit_ra_dec_relative = std::max(orekit_ra_dec_relative, relative);
        }
        assert(relative <= 1.0e-6);
      } else {
        const double error = relative_error(actual.value[component], fixture.expected[component]);
        orekit_max_relative = std::max(orekit_max_relative, error);
        if (fixture.kind == MeasurementKind::RANGE) {
          orekit_range_relative = std::max(orekit_range_relative, error);
        } else {
          orekit_range_rate_relative = std::max(orekit_range_rate_relative, error);
        }
        if (error > 1.0e-6) {
          std::cerr << "Orekit scalar mismatch kind=" << static_cast<int>(fixture.kind)
                    << " actual=" << actual.value[component]
                    << " expected=" << fixture.expected[component]
                    << " relative=" << error << "\n";
        }
        assert(error <= 1.0e-6);
      }
    }
  }

  Observation correction_case;
  correction_case.kind = MeasurementKind::RANGE;
  correction_case.station_position_m = {6378137.0, 1200.0, -900.0};
  correction_case.station_velocity_mps = {0.0, kEarthRotationRate * 6378137.0, 0.0};
  CartesianState correction_state;
  correction_state.value = {7020000.0, 1100000.0, 500000.0, -900.0, 7350.0, 420.0};
  correction_case.apply_light_time = false;
  correction_case.apply_sagnac = false;
  const double bare_range = predict_measurement(correction_case, correction_state).value[0];
  correction_case.apply_light_time = true;
  const MeasurementPrediction light_time_range = predict_measurement(correction_case, correction_state);
  const double light_time_magnitude_error =
      std::abs((light_time_range.value[0] - bare_range) - light_time_range.light_time_m);
  assert(light_time_magnitude_error < 1.0e-9);
  correction_case.apply_light_time = false;
  correction_case.apply_sagnac = true;
  const MeasurementPrediction sagnac_range = predict_measurement(correction_case, correction_state);
  const double sagnac_magnitude_error =
      std::abs((sagnac_range.value[0] - bare_range) - sagnac_range.sagnac_m);
  assert(sagnac_magnitude_error < 1.0e-9);

  Observation doppler_case;
  doppler_case.kind = MeasurementKind::DOPPLER;
  doppler_case.media.frequency_hz = 8.4e9;
  doppler_case.media.total_electron_content_rate_per_second = 2.5e13;
  doppler_case.ionosphere = IonosphereModel::TOTAL_ELECTRON_CONTENT;
  doppler_case.hardware.turnaround_numerator = 880;
  doppler_case.hardware.turnaround_denominator = 749;
  doppler_case.apply_light_time = false;
  doppler_case.apply_sagnac = false;
  CartesianState doppler_state;
  doppler_state.value = {7000000.0, 0.0, 0.0, 100.0, 0.0, 0.0};
  const MeasurementPrediction doppler = predict_measurement(doppler_case, doppler_state);
  const double media_rate = ionosphere_group_delay_rate_mps(doppler_case.media);
  const double expected_doppler = -(100.0 + media_rate) *
      doppler_case.media.frequency_hz * (880.0 / 749.0) / kSpeedOfLight;
  assert(relative_error(doppler.value[0], expected_doppler) < 1.0e-12);

  // Every public measurement kind must be a reachable, finite model. The
  // differenced relay observable additionally proves it is not an alias for
  // the one-leg relay Doppler model.
  Observation roster_case = correction_case;
  roster_case.station_east = {0.0, 1.0, 0.0};
  roster_case.station_north = {0.0, 0.0, 1.0};
  roster_case.station_up = {1.0, 0.0, 0.0};
  roster_case.remote_position_m = {-6378137.0, 1500.0, 700.0};
  roster_case.remote_velocity_mps = {20.0, -15.0, 3.0};
  roster_case.media.frequency_hz = 8.4e9;
  roster_case.hardware.turnaround_numerator = 880;
  roster_case.hardware.turnaround_denominator = 749;
  roster_case.apply_light_time = false;
  roster_case.apply_sagnac = false;
  for (int ordinal = 0; ordinal <= 20; ++ordinal) {
    roster_case.kind = static_cast<MeasurementKind>(ordinal);
    const MeasurementPrediction prediction = predict_measurement(roster_case,
                                                                  correction_state);
    assert(prediction.count > 0);
    for (int component = 0; component < prediction.count; ++component) {
      assert(std::isfinite(prediction.value[component]));
      for (double derivative : prediction.jacobian[component]) {
        assert(std::isfinite(derivative));
      }
    }
  }
  roster_case.kind = MeasurementKind::RELAY_DOPPLER;
  const double relay_doppler = predict_measurement(roster_case,
                                                   correction_state).value[0];
  roster_case.kind = MeasurementKind::RELAY_DIFFERENCED_DOPPLER;
  const double relay_dowd = predict_measurement(roster_case,
                                                correction_state).value[0];
  assert(std::abs(relay_doppler - relay_dowd) > 1.0);

  // Tier B: Vallado, Fundamentals of Astrodynamics and Applications, 4th ed.,
  // Examples 7-2 through 7-4. The inputs and printed answers are mirrored by
  // the official valladopy repository at commit
  // 2f3d1600c0f8fd0ebc2f149d8195f06f79d3f579.
  constexpr double vallado_mu = 3.986004415e14;
  constexpr double radians_per_degree =
      3.141592653589793238462643383279502884 / 180.0;
  const std::array<double, 3> right_ascension_deg{0.939913, 45.025748, 67.886655};
  const std::array<double, 3> declination_deg{18.667717, 35.664741, 36.996583};
  const std::array<double, 3> sighting_epochs{-480.0, 0.0, 240.0};
  const std::array<Vec3, 3> sighting_sites_km{{
      {4054.881, 2748.195, 4074.237},
      {3956.224, 2888.232, 4074.364},
      {3905.073, 2956.935, 4074.430},
  }};
  std::array<AnglesObservation, 3> angles{};
  for (int index = 0; index < 3; ++index) {
    angles[index].epoch_seconds = sighting_epochs[index];
    angles[index].right_ascension_rad = right_ascension_deg[index] * radians_per_degree;
    angles[index].declination_rad = declination_deg[index] * radians_per_degree;
    angles[index].observer_position_m = scale(sighting_sites_km[index], 1000.0);
  }
  const IodResult vallado_gauss = gauss_iod(angles, vallado_mu);
  const IodResult vallado_laplace = laplace_iod(angles, vallado_mu);
  assert(vallado_gauss.valid && vallado_laplace.valid);
  const Vector6 gauss_expected{
      6313378.130210396, 5247505.633448950, 6467707.164431651,
      -4185.488280436629, 4788.492916889814, 1721.714659663034};
  const Vector6 laplace_expected{
      6375656.382985365, 5309839.885514231, 6530941.565891183,
      22320.79637714886, 26241.61577925484, 28464.611900869997};
  double gauss_max_error = 0.0;
  double laplace_max_error = 0.0;
  for (int component = 0; component < 6; ++component) {
    gauss_max_error = std::max(gauss_max_error,
                               std::abs(vallado_gauss.state.value[component] -
                                        gauss_expected[component]));
    laplace_max_error = std::max(laplace_max_error,
                                 std::abs(vallado_laplace.state.value[component] -
                                          laplace_expected[component]));
  }
  assert(gauss_max_error < 1.0e-6);
  assert(laplace_max_error < 1.0e-6);

  std::array<CartesianState, 3> vallado_gibbs_positions{};
  vallado_gibbs_positions[0].value = {0.0, 0.0, 6378136.3, 0.0, 0.0, 0.0};
  vallado_gibbs_positions[1].value = {0.0, -4464696.0, -5102509.0, 0.0, 0.0, 0.0};
  vallado_gibbs_positions[2].value = {0.0, 5740323.0, 3189068.0, 0.0, 0.0, 0.0};
  const IodResult vallado_gibbs = gibbs_iod(vallado_gibbs_positions, vallado_mu);
  const Vector6 gibbs_expected{0.0, -4464696.0, -5102509.0,
                              0.0, 5531.1472050176125, -5191.806413494606};
  double vallado_gibbs_max_error = 0.0;
  for (int component = 3; component < 6; ++component) {
    vallado_gibbs_max_error = std::max(
        vallado_gibbs_max_error,
        std::abs(vallado_gibbs.state.value[component] - gibbs_expected[component]));
  }
  assert(vallado_gibbs.valid && vallado_gibbs_max_error < 1.0e-9);

  std::array<CartesianState, 3> vallado_herrick_positions{};
  vallado_herrick_positions[0].epoch_seconds = 0.0;
  vallado_herrick_positions[1].epoch_seconds = 76.48;
  vallado_herrick_positions[2].epoch_seconds = 153.04;
  vallado_herrick_positions[0].value = {
      3419855.64, 6019826.02, 2784600.22, 0.0, 0.0, 0.0};
  vallado_herrick_positions[1].value = {
      2935911.95, 6326183.24, 2660595.84, 0.0, 0.0, 0.0};
  vallado_herrick_positions[2].value = {
      2434952.02, 6597386.74, 2521523.11, 0.0, 0.0, 0.0};
  const IodResult vallado_herrick = herrick_gibbs_iod(vallado_herrick_positions,
                                                       vallado_mu);
  const Vector6 herrick_expected{2935911.95, 6326183.24, 2660595.84,
                                -6441.557227511062, 3777.559606719521,
                                -1720.5675602414345};
  double vallado_herrick_max_error = 0.0;
  for (int component = 3; component < 6; ++component) {
    vallado_herrick_max_error = std::max(
        vallado_herrick_max_error,
        std::abs(vallado_herrick.state.value[component] - herrick_expected[component]));
  }
  assert(vallado_herrick.valid && vallado_herrick_max_error < 1.0e-9);

  constexpr double mu = 3.986004418e14;
  constexpr double radius = 7000000.0;
  constexpr double step = 40.0;
  const double angle = std::sqrt(mu / (radius * radius * radius)) * step;
  std::array<CartesianState, 3> positions{};
  positions[0].epoch_seconds = -step;
  positions[1].epoch_seconds = 0.0;
  positions[2].epoch_seconds = step;
  positions[0].value = {radius * std::cos(-angle), radius * std::sin(-angle), 0.0, 0.0, 0.0, 0.0};
  positions[1].value = {radius, 0.0, 0.0, 0.0, 0.0, 0.0};
  positions[2].value = {radius * std::cos(angle), radius * std::sin(angle), 0.0, 0.0, 0.0, 0.0};
  IodResult gibbs = gibbs_iod(positions, mu);
  IodResult herrick = herrick_gibbs_iod(positions, mu);
  const double circular_speed = std::sqrt(mu / radius);
  assert(gibbs.valid && std::abs(gibbs.state.value[4] - circular_speed) < 1.0e-6);
  assert(herrick.valid && std::abs(herrick.state.value[4] - circular_speed) < 20.0);

  const double batch_position_error = position_error(fit.estimate, truth);
  const double batch_position_sigma_rss = std::sqrt(
      fit.covariance[0] + fit.covariance[7] + fit.covariance[14]);
  const double truth_position_norm = std::hypot(
      std::hypot(truth.value[0], truth.value[1]), truth.value[2]);
  std::cout << "{\"batch_position_error_m\":" << batch_position_error
            << ",\"batch_position_relative_error\":"
            << batch_position_error / truth_position_norm
            << ",\"batch_rms\":" << fit.residual_rms
            << ",\"batch_position_sigma_rss_m\":" << batch_position_sigma_rss
            << ",\"batch_iteration_count\":" << fit.iterations.size()
            << ",\"residual_orthogonality\":" << residual_orthogonality
            << ",\"edited_count\":" << edited_fit.rejected_indices.size()
            << ",\"edited_index\":" << edited_fit.rejected_indices.front()
            << ",\"filter_position_error_m\":"
            << position_error(ekf.epochs.back().filtered, final_truth)
            << ",\"smoother_position_error_m\":" << smoother_position_error
            << ",\"ukf_covariance_difference\":" << covariance_difference
            << ",\"snc_growth_ratio\":" << snc_growth_ratio
            << ",\"dmc_growth_ratio\":" << process_noise_ratio
            << ",\"simulator_coverage\":" << simulator_coverage
            << ",\"recovered_noise_sigma\":" << recovered_noise_sigma
            << ",\"average_nees\":" << average_nees
            << ",\"saastamoinen_m\":" << saastamoinen
            << ",\"marini_m\":" << marini
            << ",\"ionosphere_m\":" << ionosphere
            << ",\"orekit_saastamoinen_relative\":"
            << orekit_saastamoinen_relative
            << ",\"orekit_marini_relative\":" << orekit_marini_relative
            << ",\"p531_table3_range_m\":" << p531_table3_range_error
            << ",\"orekit_measurement_max_relative\":" << orekit_max_relative
            << ",\"orekit_angle_max_rad\":" << orekit_max_angle_rad
            << ",\"orekit_range_relative\":" << orekit_range_relative
            << ",\"orekit_range_rate_relative\":" << orekit_range_rate_relative
            << ",\"orekit_az_el_relative\":" << orekit_az_el_relative
            << ",\"orekit_ra_dec_relative\":" << orekit_ra_dec_relative
            << ",\"light_time_m\":" << light_time_range.light_time_m
            << ",\"light_time_magnitude_error_m\":" << light_time_magnitude_error
            << ",\"sagnac_m\":" << sagnac_range.sagnac_m
            << ",\"sagnac_magnitude_error_m\":" << sagnac_magnitude_error
            << ",\"doppler_hz\":" << doppler.value[0]
            << ",\"relay_dowd_hz\":" << relay_dowd
            << ",\"vallado_gauss_max_error_si\":" << gauss_max_error
            << ",\"vallado_laplace_max_error_si\":" << laplace_max_error
            << ",\"vallado_gibbs_max_error_mps\":" << vallado_gibbs_max_error
            << ",\"vallado_herrick_max_error_mps\":" << vallado_herrick_max_error
            << ",\"gibbs_velocity_error_mps\":"
            << std::abs(gibbs.state.value[4] - circular_speed)
            << ",\"herrick_velocity_error_mps\":"
            << std::abs(herrick.state.value[4] - circular_speed)
            << "}\n";
  return 0;
}
