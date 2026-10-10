#include "estimation.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace sdn::estimation {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kTiny = 1.0e-20;

double& at(Matrix6& matrix, int row, int column) { return matrix[row * 6 + column]; }
double at(const Matrix6& matrix, int row, int column) { return matrix[row * 6 + column]; }

Vector6 state_delta(const CartesianState& left, const CartesianState& right) {
  Vector6 result{};
  for (int i = 0; i < 6; ++i) result[i] = left.value[i] - right.value[i];
  return result;
}

Vector6 mat_vec(const Matrix6& matrix, const Vector6& vector) {
  Vector6 result{};
  for (int row = 0; row < 6; ++row) {
    for (int column = 0; column < 6; ++column) {
      result[row] += at(matrix, row, column) * vector[column];
    }
  }
  return result;
}


Matrix6 multiply(const Matrix6& left, const Matrix6& right) {
  Matrix6 result{};
  for (int row = 0; row < 6; ++row) {
    for (int column = 0; column < 6; ++column) {
      for (int inner = 0; inner < 6; ++inner) {
        at(result, row, column) += at(left, row, inner) * at(right, inner, column);
      }
    }
  }
  return result;
}



Matrix6 symmetrize(const Matrix6& input) {
  Matrix6 result = input;
  for (int row = 0; row < 6; ++row) {
    for (int column = row + 1; column < 6; ++column) {
      const double value = 0.5 * (at(input, row, column) + at(input, column, row));
      at(result, row, column) = value;
      at(result, column, row) = value;
    }
  }
  return result;
}

bool solve6(const Matrix6& matrix, const Vector6& rhs, Vector6* solution) {
  if (solution == nullptr) return false;
  double augmented[6][7]{};
  for (int row = 0; row < 6; ++row) {
    for (int column = 0; column < 6; ++column) augmented[row][column] = at(matrix, row, column);
    augmented[row][6] = rhs[row];
  }
  for (int pivot = 0; pivot < 6; ++pivot) {
    int best = pivot;
    for (int row = pivot + 1; row < 6; ++row) {
      if (std::abs(augmented[row][pivot]) > std::abs(augmented[best][pivot])) best = row;
    }
    if (std::abs(augmented[best][pivot]) < kTiny) return false;
    if (best != pivot) {
      for (int column = pivot; column < 7; ++column) {
        std::swap(augmented[pivot][column], augmented[best][column]);
      }
    }
    const double divisor = augmented[pivot][pivot];
    for (int column = pivot; column < 7; ++column) augmented[pivot][column] /= divisor;
    for (int row = 0; row < 6; ++row) {
      if (row == pivot) continue;
      const double factor = augmented[row][pivot];
      for (int column = pivot; column < 7; ++column) {
        augmented[row][column] -= factor * augmented[pivot][column];
      }
    }
  }
  for (int i = 0; i < 6; ++i) (*solution)[i] = augmented[i][6];
  return true;
}

bool cholesky6(const Matrix6& matrix, Matrix6* lower) {
  if (lower == nullptr) return false;
  lower->fill(0.0);
  for (int row = 0; row < 6; ++row) {
    for (int column = 0; column <= row; ++column) {
      double sum = at(matrix, row, column);
      for (int k = 0; k < column; ++k) sum -= at(*lower, row, k) * at(*lower, column, k);
      if (row == column) {
        if (!(sum > 0.0) || !std::isfinite(sum)) return false;
        at(*lower, row, column) = std::sqrt(sum);
      } else {
        at(*lower, row, column) = sum / at(*lower, column, column);
      }
    }
  }
  return true;
}

Vec3 position(const CartesianState& state) {
  return {state.value[0], state.value[1], state.value[2]};
}

Vec3 velocity(const CartesianState& state) {
  return {state.value[3], state.value[4], state.value[5]};
}

bool is_range_like(MeasurementKind kind) {
  switch (kind) {
    case MeasurementKind::RANGE:
    case MeasurementKind::SEQUENTIAL_RANGE:
    case MeasurementKind::PSEUDONOISE_RANGE:
    case MeasurementKind::RELAY_RANGE:
    case MeasurementKind::BISTATIC_RANGE:
    case MeasurementKind::SKIN_RANGE:
    case MeasurementKind::CROSSLINK_RANGE:
    case MeasurementKind::LASER_RANGE: return true;
    default: return false;
  }
}

bool is_rate_like(MeasurementKind kind) {
  switch (kind) {
    case MeasurementKind::RANGE_RATE:
    case MeasurementKind::DOPPLER:
    case MeasurementKind::TIME_CORRELATED_PHASE:
    case MeasurementKind::RELAY_DOPPLER:
    case MeasurementKind::RELAY_DIFFERENCED_DOPPLER:
    case MeasurementKind::CROSSLINK_RANGE_RATE: return true;
    default: return false;
  }
}

double cipm2007_water_vapor_pressure_pa(double pressure_hpa, double temperature_k,
                                        double relative_humidity) {
  constexpr double l_p2 = 1.2378847e-5;
  constexpr double l_p1 = -1.9121316e-2;
  constexpr double l_0 = 33.93711047;
  constexpr double l_m1 = -6343.1645;
  const double saturation = std::exp(temperature_k *
      (temperature_k * l_p2 + l_p1) + l_0 + l_m1 / temperature_k);
  const double temperature_c = temperature_k - 273.15;
  const double enhancement = 1.00062 + 3.14e-6 * pressure_hpa +
                             5.6e-7 * temperature_c * temperature_c;
  return relative_humidity * enhancement * saturation;
}

double saastamoinen_height_correction_pa(double height_m) {
  constexpr double heights[] = {
      0.0, 200.0, 400.0, 600.0, 800.0, 1000.0, 1500.0,
      2000.0, 2500.0, 3000.0, 4000.0, 5000.0, 6000.0};
  constexpr double corrections[] = {
      116.0, 113.0, 110.0, 107.0, 104.0, 101.0, 94.0,
      88.0, 82.0, 76.0, 66.0, 57.0, 49.0};
  const double fixed_height = std::clamp(height_m, heights[0], heights[12]);
  for (int index = 0; index < 12; ++index) {
    if (fixed_height <= heights[index + 1]) {
      const double fraction = (fixed_height - heights[index]) /
                              (heights[index + 1] - heights[index]);
      return corrections[index] + fraction *
          (corrections[index + 1] - corrections[index]);
    }
  }
  return corrections[12];
}

Vec3 line_of_sight(double right_ascension, double declination) {
  const double cosine = std::cos(declination);
  return {cosine * std::cos(right_ascension), cosine * std::sin(right_ascension),
          std::sin(declination)};
}

double triple(Vec3 a, Vec3 b, Vec3 c) { return dot(a, cross(b, c)); }

struct Inverse3 {
  Vec3 row[3]{};
};

bool invert_columns(Vec3 column0, Vec3 column1, Vec3 column2, Inverse3* inverse) {
  if (inverse == nullptr) return false;
  const double determinant = triple(column0, column1, column2);
  if (std::abs(determinant) < 1.0e-14) return false;
  inverse->row[0] = scale(cross(column1, column2), 1.0 / determinant);
  inverse->row[1] = scale(cross(column2, column0), 1.0 / determinant);
  inverse->row[2] = scale(cross(column0, column1), 1.0 / determinant);
  return true;
}

double sparse_polynomial(double radius, double coefficient2, double coefficient5,
                         double coefficient8) {
  const double radius2 = radius * radius;
  const double radius3 = radius2 * radius;
  const double radius6 = radius3 * radius3;
  return radius6 * radius2 + coefficient2 * radius6 + coefficient5 * radius3 +
         coefficient8;
}

// Select Vallado's largest positive real root, then perform the same Halley
// refinement. A logarithmic bracket avoids carrying a general complex-root
// solver in the WASM guest and remains deterministic across runtimes.
double largest_positive_sparse_root(double coefficient2, double coefficient5,
                                    double coefficient8) {
  constexpr int kScanSteps = 32768;
  constexpr double kLogMinimum = -12.0;
  constexpr double kLogMaximum = 12.0;
  double lower = std::exp(kLogMinimum);
  double lower_value = sparse_polynomial(lower, coefficient2, coefficient5, coefficient8);
  double best_lower = 0.0;
  double best_upper = 0.0;
  for (int step = 1; step <= kScanSteps; ++step) {
    const double exponent = kLogMinimum +
        (kLogMaximum - kLogMinimum) * static_cast<double>(step) / kScanSteps;
    const double upper = std::exp(exponent);
    const double upper_value = sparse_polynomial(upper, coefficient2, coefficient5, coefficient8);
    if (std::isfinite(lower_value) && std::isfinite(upper_value) &&
        ((lower_value <= 0.0 && upper_value >= 0.0) ||
         (lower_value >= 0.0 && upper_value <= 0.0))) {
      best_lower = lower;
      best_upper = upper;
    }
    lower = upper;
    lower_value = upper_value;
  }
  if (!(best_upper > best_lower)) return 20000.0 / 6378.1363;

  for (int iteration = 0; iteration < 100; ++iteration) {
    const double middle = 0.5 * (best_lower + best_upper);
    const double lower_function = sparse_polynomial(best_lower, coefficient2, coefficient5,
                                                    coefficient8);
    const double middle_function = sparse_polynomial(middle, coefficient2, coefficient5,
                                                     coefficient8);
    if ((lower_function <= 0.0 && middle_function >= 0.0) ||
        (lower_function >= 0.0 && middle_function <= 0.0)) {
      best_upper = middle;
    } else {
      best_lower = middle;
    }
  }

  double radius = 0.5 * (best_lower + best_upper);
  for (int iteration = 0; iteration < 15; ++iteration) {
    const double r2 = radius * radius;
    const double r3 = r2 * radius;
    const double r4 = r2 * r2;
    const double r5 = r4 * radius;
    const double r6 = r3 * r3;
    const double r7 = r6 * radius;
    const double function = r6 * r2 + coefficient2 * r6 + coefficient5 * r3 + coefficient8;
    const double first = 8.0 * r7 + 6.0 * coefficient2 * r5 +
                         3.0 * coefficient5 * r2;
    const double second = 56.0 * r6 + 30.0 * coefficient2 * r4 +
                          6.0 * coefficient5 * radius;
    const double denominator = 2.0 * first * first - function * second;
    if (std::abs(denominator) < kTiny) break;
    const double next = radius - 2.0 * function * first / denominator;
    if (!(next > 0.0) || !std::isfinite(next)) break;
    radius = next;
  }
  return radius;
}

struct Pcg32 {
  std::uint64_t state;
  std::uint64_t sequence;

  explicit Pcg32(std::uint64_t seed)
      : state(seed + 0x853c49e6748fea9bULL), sequence(0xda3e39cb94b95bdbULL) {}

  std::uint32_t next() {
    const std::uint64_t previous = state;
    state = previous * 6364136223846793005ULL + (sequence | 1ULL);
    const std::uint32_t xorshifted = static_cast<std::uint32_t>(((previous >> 18U) ^ previous) >> 27U);
    const std::uint32_t rotation = static_cast<std::uint32_t>(previous >> 59U);
    return (xorshifted >> rotation) | (xorshifted << ((-rotation) & 31));
  }

  double uniform() { return (static_cast<double>(next()) + 0.5) / 4294967296.0; }
  double normal() {
    const double u1 = std::max(uniform(), 1.0e-15);
    return std::sqrt(-2.0 * std::log(u1)) * std::cos(2.0 * kPi * uniform());
  }
};

Matrix6 process_noise(const FilterConfig& config, double elapsed_seconds) {
  Matrix6 result{};
  const double dt = std::max(0.0, elapsed_seconds);
  if (config.process_noise == ProcessNoiseKind::NONE || dt == 0.0) return result;
  double multiplier = 1.0;
  if (config.process_noise == ProcessNoiseKind::DYNAMIC_MODEL_COMPENSATION) {
    const double tau = std::max(config.dmc_correlation_time_seconds, 1.0e-9);
    multiplier = 1.0 - std::exp(-2.0 * dt / tau);
  }
  for (int axis = 0; axis < 3; ++axis) {
    const double q = config.acceleration_psd[axis] * multiplier;
    at(result, axis, axis) = q * dt * dt * dt / 3.0;
    at(result, axis, axis + 3) = q * dt * dt / 2.0;
    at(result, axis + 3, axis) = q * dt * dt / 2.0;
    at(result, axis + 3, axis + 3) = q * dt;
  }
  return result;
}

double wrap_angle(double value) {
  while (value > kPi) value -= 2.0 * kPi;
  while (value < -kPi) value += 2.0 * kPi;
  return value;
}

double residual_component(MeasurementKind kind, int component, double observed,
                          double predicted) {
  if (kind == MeasurementKind::AZIMUTH_ELEVATION ||
      kind == MeasurementKind::RIGHT_ASCENSION_DECLINATION) {
    return wrap_angle(observed - predicted);
  }
  (void)component;
  return observed - predicted;
}

}  // namespace

Matrix6 process_noise_covariance(const FilterConfig& config, double elapsed_seconds) {
  return process_noise(config, elapsed_seconds);
}

double measurement_residual(MeasurementKind kind, int component, double observed,
                            double predicted) {
  return residual_component(kind, component, observed, predicted);
}

Vec3 add(Vec3 a, Vec3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
Vec3 subtract(Vec3 a, Vec3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
Vec3 scale(Vec3 a, double s) { return {a.x * s, a.y * s, a.z * s}; }
double dot(Vec3 a, Vec3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
Vec3 cross(Vec3 a, Vec3 b) {
  return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}
double norm(Vec3 a) { return std::sqrt(dot(a, a)); }

Matrix6 identity6() {
  Matrix6 result{};
  for (int i = 0; i < 6; ++i) at(result, i, i) = 1.0;
  return result;
}

bool invert6(const Matrix6& input, Matrix6* inverse) {
  if (inverse == nullptr) return false;
  double augmented[6][12]{};
  for (int row = 0; row < 6; ++row) {
    for (int column = 0; column < 6; ++column) augmented[row][column] = at(input, row, column);
    augmented[row][row + 6] = 1.0;
  }
  for (int pivot = 0; pivot < 6; ++pivot) {
    int best = pivot;
    for (int row = pivot + 1; row < 6; ++row) {
      if (std::abs(augmented[row][pivot]) > std::abs(augmented[best][pivot])) best = row;
    }
    if (std::abs(augmented[best][pivot]) < kTiny) return false;
    if (best != pivot) {
      for (int column = 0; column < 12; ++column) {
        std::swap(augmented[pivot][column], augmented[best][column]);
      }
    }
    const double divisor = augmented[pivot][pivot];
    for (double& value : augmented[pivot]) value /= divisor;
    for (int row = 0; row < 6; ++row) {
      if (row == pivot) continue;
      const double factor = augmented[row][pivot];
      for (int column = 0; column < 12; ++column) {
        augmented[row][column] -= factor * augmented[pivot][column];
      }
    }
  }
  for (int row = 0; row < 6; ++row) {
    for (int column = 0; column < 6; ++column) at(*inverse, row, column) = augmented[row][column + 6];
  }
  return true;
}

bool covariance_is_symmetric_positive_definite(const Matrix6& covariance, double tolerance) {
  for (int row = 0; row < 6; ++row) {
    for (int column = row + 1; column < 6; ++column) {
      if (std::abs(at(covariance, row, column) - at(covariance, column, row)) > tolerance) return false;
    }
  }
  Matrix6 lower{};
  return cholesky6(covariance, &lower);
}

double saastamoinen_hopfield_delay_m(const MediaEnvironment& environment) {
  constexpr double l0 = 2.2768e-5;
  const double elevation = std::max(environment.elevation_rad, 0.05);
  const double zenith = std::abs(0.5 * kPi - elevation);
  const double inverse_cosine = 1.0 / std::cos(zenith);
  const double tangent = std::tan(zenith);
  const double pressure_pa = environment.pressure_hpa * 100.0;
  const double vapor_pressure_pa = cipm2007_water_vapor_pressure_pa(
      environment.pressure_hpa, environment.temperature_k,
      environment.relative_humidity);
  const double hydrostatic_zenith = l0 * pressure_pa;
  const double wet_zenith = l0 * (1255.0 / environment.temperature_k + 0.05) *
                            vapor_pressure_pa;
  const double hydrostatic_slant = hydrostatic_zenith * inverse_cosine;
  const double wet_slant = (wet_zenith - l0 *
      saastamoinen_height_correction_pa(environment.height_m) * tangent * tangent) *
      inverse_cosine;
  return hydrostatic_slant + wet_slant;
}

double marini_murray_delay_m(const MediaEnvironment& environment) {
  const double elevation = std::max(environment.elevation_rad, 0.01);
  const double wavelength_um = std::max(environment.wavelength_m * 1.0e6, 0.1);
  const double lambda2 = wavelength_um * wavelength_um;
  const double dispersion = 0.9650 + (0.0164 + 0.000228 / lambda2) / lambda2;
  const double site_function = 1.0 - 0.0026 * std::cos(2.0 * environment.latitude_rad) -
                               0.00031 * 0.001 * environment.height_m;
  const double pressure_pa = environment.pressure_hpa * 100.0;
  const double vapor_pressure_pa = cipm2007_water_vapor_pressure_pa(
      environment.pressure_hpa, environment.temperature_k,
      environment.relative_humidity);
  const double ah = 0.00002357 * pressure_pa;
  const double aw = 0.00000141 * vapor_pressure_pa;
  const double k = 1.163 - 0.00968 * std::cos(2.0 * environment.latitude_rad) -
                   0.00104 * environment.temperature_k + 0.0000001435 * pressure_pa;
  const double b = 1.084e-10 * pressure_pa * environment.temperature_k * k +
      4.734e-12 * pressure_pa * (pressure_pa / environment.temperature_k) *
      (2.0 * k) / (3.0 * k - 1.0);
  const double total = ah + aw + b;
  const double sine = std::sin(elevation);
  return dispersion / site_function * total /
         (sine + b / (total * (sine + 0.01)));
}

double ionosphere_group_delay_m(const MediaEnvironment& environment) {
  if (!(environment.frequency_hz > 0.0)) return 0.0;
  // ITU-R P.531-14 equation (4): 1.345e-7 s at 1 GHz and 1e18 el/m2.
  constexpr double kP531RangeCoefficient = kSpeedOfLight * 1.345e-7;
  return kP531RangeCoefficient * environment.total_electron_content /
         (environment.frequency_hz * environment.frequency_hz);
}

double ionosphere_group_delay_rate_mps(const MediaEnvironment& environment) {
  if (!(environment.frequency_hz > 0.0)) return 0.0;
  constexpr double kP531RangeCoefficient = kSpeedOfLight * 1.345e-7;
  return kP531RangeCoefficient * environment.total_electron_content_rate_per_second /
         (environment.frequency_hz * environment.frequency_hz);
}

MeasurementPrediction predict_measurement(const Observation& observation,
                                          const CartesianState& state) {
  MeasurementPrediction prediction{};
  if (observation.kind == MeasurementKind::POSITION_VELOCITY) {
    prediction.count = 6;
    for (int i=0;i<6;++i) { prediction.value[i]=state.value[i]; prediction.jacobian[i][i]=1; }
    return prediction;
  }
  if (observation.kind == MeasurementKind::PSEUDORANGE) {
    // Corrected transmitter coordinates must already be in the reception frame.
    if (observation.apply_light_time || observation.apply_sagnac) return prediction;
    Observation range_observation = observation;
    range_observation.kind = MeasurementKind::RANGE;
    prediction = predict_measurement(range_observation, state);
    prediction.value[0] -= observation.satellite_clock_bias_m;
    return prediction;
  }
  const Vec3 r = position(state);
  const Vec3 v = velocity(state);
  const Vec3 relative = subtract(r, observation.station_position_m);
  const Vec3 relative_velocity = subtract(v, observation.station_velocity_mps);
  const double geometric_range = std::max(norm(relative), 1.0e-9);
  Vec3 signal_relative = relative;
  if (observation.apply_light_time) {
    double delay = geometric_range / kSpeedOfLight;
    for (int iteration = 0; iteration < 4; ++iteration) {
      signal_relative = subtract(relative, scale(v, delay));
      delay = norm(signal_relative) / kSpeedOfLight;
    }
  }
  const double range = std::max(norm(signal_relative), 1.0e-9);
  const Vec3 unit = scale(signal_relative, 1.0 / range);
  const double range_rate = dot(unit, relative_velocity);
  prediction.geometric_range_m = geometric_range;
  prediction.hardware_m = kSpeedOfLight *
      (observation.hardware.transmitter_delay_seconds + observation.hardware.receiver_delay_seconds +
       observation.hardware.transponder_delay_seconds);
  if (observation.apply_light_time) prediction.light_time_m = range - geometric_range;
  if (observation.apply_sagnac) {
    prediction.sagnac_m = kEarthRotationRate / kSpeedOfLight *
        (observation.station_position_m.x * r.y - observation.station_position_m.y * r.x);
  }
  if (observation.troposphere == TroposphereModel::HOPFIELD_SAASTAMOINEN) {
    prediction.troposphere_m = saastamoinen_hopfield_delay_m(observation.media);
  } else if (observation.troposphere == TroposphereModel::MARINI) {
    prediction.troposphere_m = marini_murray_delay_m(observation.media);
  }
  if (observation.ionosphere != IonosphereModel::NONE) {
    prediction.ionosphere_m = ionosphere_group_delay_m(observation.media);
  }

  auto range_jacobian = [&]() {
    Vector6 h{};
    h[0] = unit.x;
    h[1] = unit.y;
    h[2] = unit.z;
    return h;
  };
  auto range_rate_jacobian = [&]() {
    Vector6 h{};
    const Vec3 transverse = subtract(relative_velocity, scale(unit, range_rate));
    h[0] = transverse.x / range;
    h[1] = transverse.y / range;
    h[2] = transverse.z / range;
    h[3] = unit.x;
    h[4] = unit.y;
    h[5] = unit.z;
    return h;
  };

  const double corrected_range = geometric_range + prediction.light_time_m + prediction.sagnac_m +
      prediction.troposphere_m + prediction.ionosphere_m + prediction.hardware_m;

  if (is_range_like(observation.kind)) {
    prediction.count = 1;
    prediction.value[0] = corrected_range;
    prediction.jacobian[0] = range_jacobian();
    if (observation.kind == MeasurementKind::BISTATIC_RANGE) {
      const Vec3 transmitter_relative = subtract(r, observation.remote_position_m);
      const double transmitter_range = std::max(norm(transmitter_relative), 1.0e-9);
      const Vec3 transmitter_unit = scale(transmitter_relative, 1.0 / transmitter_range);
      prediction.value[0] += transmitter_range;
      prediction.jacobian[0][0] += transmitter_unit.x;
      prediction.jacobian[0][1] += transmitter_unit.y;
      prediction.jacobian[0][2] += transmitter_unit.z;
    }
    return prediction;
  }

  if (observation.kind == MeasurementKind::RELAY_DIFFERENCED_DOPPLER) {
    const Vec3 second_relative = subtract(r, observation.remote_position_m);
    const Vec3 second_velocity = subtract(v, observation.remote_velocity_mps);
    const double second_range = std::max(norm(second_relative), 1.0e-9);
    const Vec3 second_unit = scale(second_relative, 1.0 / second_range);
    const double second_rate = dot(second_unit, second_velocity);
    const Vec3 second_transverse = subtract(second_velocity,
                                            scale(second_unit, second_rate));
    const double turnaround = static_cast<double>(observation.hardware.turnaround_numerator) /
                              std::max(1u, observation.hardware.turnaround_denominator);
    const double frequency = observation.media.frequency_hz * turnaround;
    const double factor = -frequency / kSpeedOfLight;
    const Vector6 first_h = range_rate_jacobian();
    Vector6 second_h{};
    second_h[0] = second_transverse.x / second_range;
    second_h[1] = second_transverse.y / second_range;
    second_h[2] = second_transverse.z / second_range;
    second_h[3] = second_unit.x;
    second_h[4] = second_unit.y;
    second_h[5] = second_unit.z;
    prediction.count = 1;
    prediction.value[0] = (range_rate - second_rate) * factor;
    for (int i = 0; i < 6; ++i) {
      prediction.jacobian[0][i] = (first_h[i] - second_h[i]) * factor;
    }
    return prediction;
  }

  if (is_rate_like(observation.kind)) {
    prediction.count = 1;
    prediction.jacobian[0] = range_rate_jacobian();
    if (observation.kind == MeasurementKind::DOPPLER ||
        observation.kind == MeasurementKind::RELAY_DOPPLER ||
        observation.kind == MeasurementKind::RELAY_DIFFERENCED_DOPPLER ||
        observation.kind == MeasurementKind::TIME_CORRELATED_PHASE) {
      const double turnaround = static_cast<double>(observation.hardware.turnaround_numerator) /
                                std::max(1u, observation.hardware.turnaround_denominator);
      const double frequency = observation.media.frequency_hz * turnaround;
      const double media_rate = observation.ionosphere == IonosphereModel::NONE
                                    ? 0.0 : ionosphere_group_delay_rate_mps(observation.media);
      prediction.value[0] = -(range_rate + media_rate) * frequency / kSpeedOfLight;
      for (double& value : prediction.jacobian[0]) value *= -frequency / kSpeedOfLight;
    } else {
      prediction.value[0] = range_rate;
    }
    return prediction;
  }

  if (observation.kind == MeasurementKind::POSITION_VECTOR) {
    prediction.count = 3;
    for (int i = 0; i < 3; ++i) {
      prediction.value[i] = state.value[i];
      prediction.jacobian[i][i] = 1.0;
    }
    return prediction;
  }

  if (observation.kind == MeasurementKind::RIGHT_ASCENSION_DECLINATION) {
    prediction.count = 2;
    const double xy2 = signal_relative.x * signal_relative.x + signal_relative.y * signal_relative.y;
    prediction.value[0] = std::atan2(signal_relative.y, signal_relative.x);
    prediction.value[1] = std::atan2(signal_relative.z, std::sqrt(xy2));
    prediction.jacobian[0][0] = -signal_relative.y / std::max(xy2, kTiny);
    prediction.jacobian[0][1] = signal_relative.x / std::max(xy2, kTiny);
    const double rho_xy = std::max(std::sqrt(xy2), 1.0e-12);
    const double range2 = range * range;
    prediction.jacobian[1][0] = -signal_relative.x * signal_relative.z / (range2 * rho_xy);
    prediction.jacobian[1][1] = -signal_relative.y * signal_relative.z / (range2 * rho_xy);
    prediction.jacobian[1][2] = rho_xy / range2;
    return prediction;
  }

  const double station_radius = std::max(norm(observation.station_position_m), 1.0);
  const double latitude = std::asin(observation.station_position_m.z / station_radius);
  const double longitude = std::atan2(observation.station_position_m.y,
                                      observation.station_position_m.x);
  const Vec3 fallback_east{-std::sin(longitude), std::cos(longitude), 0.0};
  const Vec3 fallback_north{-std::sin(latitude) * std::cos(longitude),
                            -std::sin(latitude) * std::sin(longitude), std::cos(latitude)};
  const Vec3 fallback_up{std::cos(latitude) * std::cos(longitude),
                         std::cos(latitude) * std::sin(longitude), std::sin(latitude)};
  const Vec3 east = norm(observation.station_east) > 0.5 ? observation.station_east : fallback_east;
  const Vec3 north = norm(observation.station_north) > 0.5 ? observation.station_north : fallback_north;
  const Vec3 up = norm(observation.station_up) > 0.5 ? observation.station_up : fallback_up;
  const double e = dot(signal_relative, east);
  const double n = dot(signal_relative, north);
  const double u = dot(signal_relative, up);

  if (observation.kind == MeasurementKind::AZIMUTH_ELEVATION) {
    prediction.count = 2;
    prediction.value[0] = std::atan2(e, n);
    if (prediction.value[0] < 0.0) prediction.value[0] += 2.0 * std::acos(-1.0);
    prediction.value[1] = std::atan2(u, std::sqrt(e * e + n * n));
  } else if (observation.kind == MeasurementKind::X_EAST_Y_NORTH) {
    prediction.count = 2;
    prediction.value[0] = e;
    prediction.value[1] = n;
    prediction.jacobian[0][0] = east.x;
    prediction.jacobian[0][1] = east.y;
    prediction.jacobian[0][2] = east.z;
    prediction.jacobian[1][0] = north.x;
    prediction.jacobian[1][1] = north.y;
    prediction.jacobian[1][2] = north.z;
    return prediction;
  } else if (observation.kind == MeasurementKind::X_SOUTH_Y_EAST) {
    prediction.count = 2;
    prediction.value[0] = -n;
    prediction.value[1] = e;
    prediction.jacobian[0][0] = -north.x;
    prediction.jacobian[0][1] = -north.y;
    prediction.jacobian[0][2] = -north.z;
    prediction.jacobian[1][0] = east.x;
    prediction.jacobian[1][1] = east.y;
    prediction.jacobian[1][2] = east.z;
    return prediction;
  } else if (observation.kind == MeasurementKind::TIME_DIFFERENCE_OF_ARRIVAL ||
             observation.kind == MeasurementKind::FREQUENCY_DIFFERENCE_OF_ARRIVAL) {
    const Vec3 second_relative = subtract(r, observation.remote_position_m);
    const double second_range = std::max(norm(second_relative), 1.0e-9);
    const Vec3 second_unit = scale(second_relative, 1.0 / second_range);
    prediction.count = 1;
    if (observation.kind == MeasurementKind::TIME_DIFFERENCE_OF_ARRIVAL) {
      prediction.value[0] = (range - second_range) / kSpeedOfLight;
      prediction.jacobian[0][0] = (unit.x - second_unit.x) / kSpeedOfLight;
      prediction.jacobian[0][1] = (unit.y - second_unit.y) / kSpeedOfLight;
      prediction.jacobian[0][2] = (unit.z - second_unit.z) / kSpeedOfLight;
    } else {
      const Vec3 second_velocity = subtract(v, observation.remote_velocity_mps);
      const double second_rate = dot(second_unit, second_velocity);
      const double factor = observation.media.frequency_hz / kSpeedOfLight;
      prediction.value[0] = (range_rate - second_rate) * factor;
      const Vector6 first_h = range_rate_jacobian();
      for (int i = 0; i < 6; ++i) prediction.jacobian[0][i] = first_h[i] * factor;
      prediction.jacobian[0][3] -= second_unit.x * factor;
      prediction.jacobian[0][4] -= second_unit.y * factor;
      prediction.jacobian[0][5] -= second_unit.z * factor;
    }
    return prediction;
  }

  if (prediction.count == 2) {
    // Angular Jacobians are evaluated with a symmetric one-millimetre
    // perturbation. This is guest physics and therefore byte-identical across
    // runtimes; JavaScript never differentiates the observable.
    for (int column = 0; column < 3; ++column) {
      CartesianState plus = state;
      CartesianState minus = state;
      plus.value[column] += 0.001;
      minus.value[column] -= 0.001;
      Observation copy = observation;
      copy.kind = MeasurementKind::X_EAST_Y_NORTH;
      const Vec3 rp = subtract(position(plus), copy.station_position_m);
      const Vec3 rm = subtract(position(minus), copy.station_position_m);
      const double ep = dot(rp, east), np = dot(rp, north), upv = dot(rp, up);
      const double em = dot(rm, east), nm = dot(rm, north), umv = dot(rm, up);
      const double azp = std::atan2(ep, np), azm = std::atan2(em, nm);
      const double elp = std::atan2(upv, std::sqrt(ep * ep + np * np));
      const double elm = std::atan2(umv, std::sqrt(em * em + nm * nm));
      prediction.jacobian[0][column] = wrap_angle(azp - azm) / 0.002;
      prediction.jacobian[1][column] = (elp - elm) / 0.002;
    }
  }
  return prediction;
}

BatchResult batch_weighted_least_squares(const BatchConfig& config,
                                         const std::vector<Observation>& observations,
                                         const std::vector<PropagatorSample>& samples) {
  BatchResult result{};
  result.estimate = config.a_priori;
  if (observations.empty() || observations.size() != samples.size()) return result;
  Matrix6 apriori_information{};
  if (!invert6(config.a_priori_covariance, &apriori_information)) return result;
  double previous_rms = std::numeric_limits<double>::infinity();
  std::vector<bool> rejected(observations.size(), false);

  for (int iteration = 0; iteration < config.maximum_iterations; ++iteration) {
    Matrix6 normal = apriori_information;
    Vector6 rhs = mat_vec(apriori_information, state_delta(config.a_priori, result.estimate));
    double sum_squared = 0.0;
    std::size_t scalar_count = 0;
    std::size_t accepted_count = 0;

    const Vector6 epoch_delta = state_delta(result.estimate, config.a_priori);
    std::vector<MeasurementPrediction> predictions(observations.size());
    double largest_normalized = config.sigma_edit_threshold;
    std::size_t largest_index = observations.size();
    for (std::size_t index = 0; index < observations.size(); ++index) {
      CartesianState linearized = samples[index].state;
      const Vector6 propagated_delta = mat_vec(samples[index].stm, epoch_delta);
      for (int i = 0; i < 6; ++i) linearized.value[i] += propagated_delta[i];
      predictions[index] = predict_measurement(observations[index], linearized);
      if (iteration == 0 || rejected[index]) continue;
      for (int component = 0; component < predictions[index].count; ++component) {
        const double sigma = std::max(observations[index].sigma[component], 1.0e-18);
        const double residual = residual_component(observations[index].kind, component,
                                                   observations[index].value[component],
                                                   predictions[index].value[component]);
        const double normalized = std::abs(residual / sigma);
        if (normalized > largest_normalized) {
          largest_normalized = normalized;
          largest_index = index;
        }
      }
    }
    if (largest_index < observations.size()) rejected[largest_index] = true;

    for (std::size_t index = 0; index < observations.size(); ++index) {
      const MeasurementPrediction& predicted = predictions[index];
      if (rejected[index]) continue;
      ++accepted_count;
      for (int component = 0; component < predicted.count; ++component) {
        Vector6 h_epoch{};
        for (int column = 0; column < 6; ++column) {
          for (int inner = 0; inner < 6; ++inner) {
            h_epoch[column] += predicted.jacobian[component][inner] * at(samples[index].stm, inner, column);
          }
        }
        const double sigma = std::max(observations[index].sigma[component], 1.0e-18);
        const double weight = 1.0 / (sigma * sigma);
        const double residual = residual_component(observations[index].kind, component,
                                                   observations[index].value[component],
                                                   predicted.value[component]);
        for (int row = 0; row < 6; ++row) {
          rhs[row] += h_epoch[row] * weight * residual;
          for (int column = 0; column < 6; ++column) {
            at(normal, row, column) += h_epoch[row] * weight * h_epoch[column];
          }
        }
        sum_squared += residual * residual;
        ++scalar_count;
      }
    }

    Matrix6 iteration_covariance{};
    if (!invert6(normal, &iteration_covariance)) return result;
    result.iteration_covariances.push_back(symmetrize(iteration_covariance));

    Vector6 correction{};
    if (!solve6(normal, rhs, &correction)) return result;
    for (int i = 0; i < 6; ++i) result.estimate.value[i] += correction[i];
    const double correction_norm = std::sqrt(dot({correction[0], correction[1], correction[2]},
                                                 {correction[0], correction[1], correction[2]}));
    const double rms = scalar_count > 0 ? std::sqrt(sum_squared / scalar_count) : 0.0;
    result.iterations.push_back({iteration + 1, rms, rms, correction_norm, accepted_count,
                                 observations.size() - accepted_count});
    if (correction_norm <= config.state_convergence_tolerance &&
        std::abs(previous_rms - rms) <= config.rms_convergence_tolerance) {
      result.converged = true;
      result.covariance = result.iteration_covariances.back();
      break;
    }
    previous_rms = rms;
    if (iteration + 1 == config.maximum_iterations) {
      result.covariance = result.iteration_covariances.back();
    }
  }

  const Vector6 final_delta = state_delta(result.estimate, config.a_priori);
  double residual_square_sum = 0.0;
  std::size_t residual_count = 0;
  for (std::size_t index = 0; index < observations.size(); ++index) {
    CartesianState linearized = samples[index].state;
    const Vector6 propagated_delta = mat_vec(samples[index].stm, final_delta);
    for (int i = 0; i < 6; ++i) linearized.value[i] += propagated_delta[i];
    const MeasurementPrediction predicted = predict_measurement(observations[index], linearized);
    for (int component = 0; component < predicted.count; ++component) {
      const double residual = residual_component(observations[index].kind, component,
                                                 observations[index].value[component],
                                                 predicted.value[component]);
      result.residuals.push_back(residual);
      if (!rejected[index]) {
        residual_square_sum += residual * residual;
        ++residual_count;
      }
    }
    if (rejected[index]) result.rejected_indices.push_back(index);
  }
  result.residual_rms = residual_count > 0 ? std::sqrt(residual_square_sum / residual_count) : 0.0;
  const std::size_t dof = residual_count > 6 ? residual_count - 6 : residual_count;
  result.recovered_noise_sigma = dof > 0 ? std::sqrt(residual_square_sum / dof) : 0.0;
  result.covariance = symmetrize(result.covariance);
  return result;
}

namespace {
// Fixed capacity, active dimension 6 or 8. The stride is always eight.
using V = Vector8;
using M = Matrix8;
M tr8(const M &a, int n) {
  M b{};
  for (int i = 0; i < n; ++i)
    for (int j = 0; j < n; ++j)
      b[8 * i + j] = a[8 * j + i];
  return b;
}
M mul8(const M &a, const M &b, int n) {
  M c{};
  for (int i = 0; i < n; ++i)
    for (int j = 0; j < n; ++j)
      for (int k = 0; k < n; ++k)
        c[8 * i + j] += a[8 * i + k] * b[8 * k + j];
  return c;
}
M sym8(M a, int n) {
  for (int i = 0; i < n; ++i)
    for (int j = 0; j < i; ++j)
      a[8 * i + j] = a[8 * j + i] = .5 * (a[8 * i + j] + a[8 * j + i]);
  return a;
}
bool chol8(const M &a, M *l, int n) {
  l->fill(0);
  for (int i = 0; i < n; ++i)
    for (int j = 0; j <= i; ++j) {
      if (!std::isfinite(a[8 * i + j]) || !std::isfinite(a[8 * j + i]) ||
          std::abs(a[8 * i + j] - a[8 * j + i]) >
              1e-10 * std::max(1.0, std::sqrt(
                                        std::abs(a[8 * i + i] * a[8 * j + j]))))
        return false;
      double v = a[8 * i + j];
      for (int k = 0; k < j; ++k)
        v -= (*l)[8 * i + k] * (*l)[8 * j + k];
      if (i == j) {
        if (!(v > 0) || !std::isfinite(v))
          return false;
        (*l)[8 * i + j] = std::sqrt(v);
      } else
        (*l)[8 * i + j] = v / (*l)[8 * j + j];
    }
  return true;
}
bool inv8(const M &a, M *inverse, int n) {
  M l{};
  if (!chol8(a, &l, n))
    return false;
  inverse->fill(0);
  for (int col = 0; col < n; ++col) {
    V y{}, x{};
    for (int i = 0; i < n; ++i) {
      double v = i == col ? 1 : 0;
      for (int k = 0; k < i; ++k)
        v -= l[8 * i + k] * y[k];
      y[i] = v / l[8 * i + i];
    }
    for (int i = n; i-- > 0;) {
      double v = y[i];
      for (int k = i + 1; k < n; ++k)
        v -= l[8 * k + i] * x[k];
      x[i] = v / l[8 * i + i];
    }
    for (int i = 0; i < n; ++i)
      (*inverse)[8 * i + col] = x[i];
  }
  return true;
}
M expand6(const Matrix6 &a) {
  M b{};
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < 6; ++j)
      b[8 * i + j] = a[6 * i + j];
  return b;
}
CartesianState cartesian(const V &x, double t) {
  CartesianState s{};
  s.epoch_seconds = t;
  std::copy_n(x.begin(), 6, s.value.begin());
  return s;
}
struct SigmaCloud {
  std::array<V, 17> points{};
  int count;
  double wm0, wc0, wi;
};
bool cloud(const V &x, const M &p, int n, const FilterConfig &c,
           SigmaCloud *out) {
  const double scale = c.ukf_alpha * c.ukf_alpha * (n + c.ukf_kappa);
  if (!(scale > 1e-12) || !std::isfinite(scale))
    return false;
  M l{};
  if (!chol8(p, &l, n))
    return false;
  out->count = 2 * n + 1;
  out->wm0 = 1 - n / scale;
  out->wc0 = out->wm0 + 1 - c.ukf_alpha * c.ukf_alpha + c.ukf_beta;
  out->wi = .5 / scale;
  out->points[0] = x;
  for (int j = 0; j < n; ++j) {
    out->points[1 + j] = out->points[1 + n + j] = x;
    for (int i = 0; i < n; ++i) {
      const double d = std::sqrt(scale) * l[8 * i + j];
      out->points[1 + j][i] += d;
      out->points[1 + n + j][i] -= d;
    }
  }
  return true;
}
// Full measurement model including module-local linear and receiver-clock
// lanes.
bool measurement(const Observation &o, const V &x, int n, V *y, M *h) {
  y->fill(0);
  h->fill(0);
  if (o.kind == MeasurementKind::LINEAR) {
    if (o.linear_matrix.size() != static_cast<std::size_t>(o.value_count * n) ||
        o.linear_offset.size() != o.value_count)
      return false;
    for (int i = 0; i < o.value_count; ++i) {
      (*y)[i] = o.linear_offset[i];
      for (int j = 0; j < n; ++j) {
        double v = o.linear_matrix[i * n + j];
        (*h)[8 * i + j] = v;
        (*y)[i] += v * x[j];
      }
    }
  } else {
    auto prediction = predict_measurement(o, cartesian(x, o.epoch_seconds));
    if (prediction.count != o.value_count)
      return false;
    for (int i = 0; i < o.value_count; ++i) {
      (*y)[i] = prediction.value[i];
      for (int j = 0; j < 6; ++j)
        (*h)[8 * i + j] = prediction.jacobian[i][j];
    }
    if (o.kind == MeasurementKind::PSEUDORANGE && n == 8) {
      (*y)[0] += x[6];
      (*h)[6] = 1;
    }
  }
  for (int i = 0; i < o.value_count; ++i) {
    if (!std::isfinite((*y)[i]))
      return false;
    for (int j = 0; j < n; ++j)
      if (!std::isfinite((*h)[8 * i + j]))
        return false;
  }
  return true;
}
} // namespace

FilterResult sequential_filter(const FilterConfig &config,
                               const std::vector<Observation> &observations,
                               const std::vector<PropagatorSample> &samples,
                               bool smooth) {
  FilterResult result{};
  const int n = config.estimate_clock ? 8 : 6;
  const bool ukf = config.estimator == EstimatorKind::UNSCENTED_KALMAN_FILTER;
  const bool linear = config.estimator == EstimatorKind::LINEAR_KALMAN_FILTER;
  if (observations.empty() ||
      (!config.propagator && samples.size() != observations.size()) ||
      (config.estimator != EstimatorKind::EXTENDED_KALMAN_FILTER &&
       config.estimator != EstimatorKind::EXTENDED_KALMAN_FILTER_WITH_RTS &&
       !ukf && !linear) ||
      (linear && config.propagator))
    return result;
  if (!std::isfinite(config.initial.epoch_seconds) ||
      !std::isfinite(config.sigma_edit_threshold) ||
      config.sigma_edit_threshold <= 0 || !std::isfinite(config.ukf_alpha) ||
      config.ukf_alpha <= 0 || !std::isfinite(config.ukf_beta) ||
      config.ukf_beta < 0 || !std::isfinite(config.ukf_kappa) ||
      n + config.ukf_kappa <= 0 || !std::isfinite(config.adaptation_rate) ||
      config.adaptation_rate <= 0 || config.adaptation_rate > 1 ||
      !std::isfinite(config.minimum_process_scale) ||
      config.minimum_process_scale <= 0 || config.minimum_process_scale > 1 ||
      !std::isfinite(config.maximum_process_scale) ||
      config.maximum_process_scale < 1 ||
      !std::isfinite(config.maximum_measurement_scale) ||
      config.maximum_measurement_scale < 1)
    return result;
  for (double v : config.acceleration_psd)
    if (!std::isfinite(v) || v < 0)
      return result;
  for (double v : {config.clock_bias_psd, config.clock_drift_psd})
    if (!std::isfinite(v) || v < 0)
      return result;
  if (config.process_noise != ProcessNoiseKind::NONE &&
      config.process_noise != ProcessNoiseKind::STATE_NOISE_COMPENSATION &&
      config.process_noise != ProcessNoiseKind::DYNAMIC_MODEL_COMPENSATION)
    return result;
  if (config.process_noise == ProcessNoiseKind::DYNAMIC_MODEL_COMPENSATION &&
      (!std::isfinite(config.dmc_correlation_time_seconds) ||
       config.dmc_correlation_time_seconds <= 0))
    return result;
  V x{};
  std::copy(config.initial.value.begin(), config.initial.value.end(),
            x.begin());
  if (n == 8) {
    x[6] = config.initial_clock_bias_m;
    x[7] = config.initial_clock_drift_mps;
  }
  for (double v : x)
    if (!std::isfinite(v))
      return result;
  M p = n == 8 ? config.initial_covariance8
               : expand6(config.initial_covariance),
    scratch{};
  if (!chol8(p, &scratch, n))
    return result;
  CartesianState previous_nominal = config.initial;
  Matrix6 previous_stm = identity6();
  double previous_epoch = config.initial.epoch_seconds, qscale = 1;
  std::vector<M> predictions, crosses;
  std::vector<V> predicted_states;
  for (std::size_t index = 0; index < observations.size(); ++index) {
    const auto &o = observations[index];
    const int m = o.value_count;
    if (!std::isfinite(o.epoch_seconds) || o.epoch_seconds < previous_epoch ||
        m < 1 || m > 6 ||
        static_cast<unsigned>(o.kind) >
            static_cast<unsigned>(MeasurementKind::LINEAR))
      return result;
    if (linear && o.kind != MeasurementKind::LINEAR &&
        o.kind != MeasurementKind::POSITION_VECTOR &&
        o.kind != MeasurementKind::POSITION_VELOCITY)
      return result;
    for (int j = 0; j < m; ++j)
      if (!std::isfinite(o.value[j]) || !std::isfinite(o.sigma[j]) ||
          o.sigma[j] <= 0)
        return result;
    const double dt = o.epoch_seconds - previous_epoch;
    M phi{};
    for (int i = 0; i < n; ++i)
      phi[8 * i + i] = 1;
    if (n == 8)
      phi[6 * 8 + 7] = dt;
    PropagatorSample nominal{};
    if (!config.propagator) {
      nominal = samples[index];
      Matrix6 inv_previous{}, inv_current{};
      if (!std::isfinite(nominal.state.epoch_seconds) ||
          std::abs(nominal.state.epoch_seconds - o.epoch_seconds) > 1e-8 ||
          !invert6(previous_stm, &inv_previous) ||
          !invert6(nominal.stm, &inv_current))
        return result;
      for (double v : nominal.state.value)
        if (!std::isfinite(v))
          return result;
      for (double v : nominal.stm)
        if (!std::isfinite(v))
          return result;
      const auto f = multiply(nominal.stm, inv_previous);
      for (int i = 0; i < 6; ++i)
        for (int j = 0; j < 6; ++j)
          phi[8 * i + j] = f[6 * i + j];
    }
    auto propagate = [&](const V &seed, V *dest, M *transition) {
      *dest = seed;
      PropagatorSample answer{};
      if (config.propagator) {
        if (dt == 0) {
          answer.state = cartesian(seed, o.epoch_seconds);
          answer.stm = identity6();
        } else if (!config.propagator(cartesian(seed, previous_epoch),
                                      o.epoch_seconds, &answer))
          return false;
        if (!std::isfinite(answer.state.epoch_seconds) ||
            std::abs(answer.state.epoch_seconds - o.epoch_seconds) > 1e-8)
          return false;
        for (double v : answer.state.value)
          if (!std::isfinite(v))
            return false;
        for (double v : answer.stm)
          if (!std::isfinite(v))
            return false;
        for (int i = 0; i < 6; ++i) {
          (*dest)[i] = answer.state.value[i];
          if (transition)
            for (int j = 0; j < 6; ++j)
              (*transition)[8 * i + j] = answer.stm[6 * i + j];
        }
      } else
        for (int i = 0; i < 6; ++i) {
          (*dest)[i] = nominal.state.value[i];
          for (int j = 0; j < 6; ++j)
            (*dest)[i] +=
                phi[8 * i + j] * (seed[j] - previous_nominal.value[j]);
        }
      if (n == 8)
        (*dest)[6] = seed[6] + dt * seed[7];
      return true;
    };
    V xp{};
    M pp{}, cross{};
    if (ukf && dt != 0) {
      SigmaCloud sc{};
      if (!cloud(x, p, n, config, &sc))
        return result;
      std::array<V, 17> propagated{};
      bool ready = true;
      // Request the entire cloud in one port round-trip.
      for (int k = 0; k < sc.count; ++k)
        if (!propagate(sc.points[k], &propagated[k], k == 0 ? &phi : nullptr))
          ready = false;
      if (!ready)
        return result;
      xp = propagated[0];
      for (int k = 1; k < sc.count; ++k)
        for (int i = 0; i < n; ++i)
          xp[i] += sc.wi * (propagated[k][i] - propagated[0][i]);
      for (int k = 0; k < sc.count; ++k) {
        double w = k == 0 ? sc.wc0 : sc.wi;
        for (int i = 0; i < n; ++i)
          for (int j = 0; j < n; ++j) {
            pp[8 * i + j] +=
                w * (propagated[k][i] - xp[i]) * (propagated[k][j] - xp[j]);
            cross[8 * i + j] +=
                w * (sc.points[k][i] - x[i]) * (propagated[k][j] - xp[j]);
          }
      }
    } else {
      if (!propagate(x, &xp, &phi))
        return result;
      cross = mul8(p, tr8(phi, n), n);
      pp = mul8(phi, cross, n);
    }
    M q = expand6(process_noise(config, dt));
    if (n == 8) {
      q[54] = config.clock_bias_psd * dt +
              config.clock_drift_psd * dt * dt * dt / 3;
      q[55] = q[62] = config.clock_drift_psd * dt * dt / 2;
      q[63] = config.clock_drift_psd * dt;
    }
    for (int i = 0; i < 64; ++i)
      pp[i] += qscale * q[i];
    pp = sym8(pp, n);
    if (!chol8(pp, &scratch, n))
      return result;
    V mean{};
    M h{}, s{}, cxy{};
    if (!measurement(o, xp, n, &mean, &h))
      return result;
    if (ukf) {
      SigmaCloud sc{};
      if (!cloud(xp, pp, n, config, &sc))
        return result;
      std::array<V, 17> ys{};
      for (int k = 0; k < sc.count; ++k) {
        M ignored{};
        if (!measurement(o, sc.points[k], n, &ys[k], &ignored))
          return result;
      }
      mean = ys[0];
      // Local angular differences keep a cloud straddling 0/2pi continuous.
      for (int k = 1; k < sc.count; ++k)
        for (int i = 0; i < m; ++i)
          mean[i] += sc.wi * residual_component(o.kind, i, ys[k][i], ys[0][i]);
      for (int k = 0; k < sc.count; ++k) {
        const double w = k == 0 ? sc.wc0 : sc.wi;
        V dy{};
        for (int i = 0; i < m; ++i)
          dy[i] = residual_component(o.kind, i, ys[k][i], mean[i]);
        for (int i = 0; i < m; ++i)
          for (int j = 0; j < m; ++j)
            s[8 * i + j] += w * dy[i] * dy[j];
        for (int i = 0; i < n; ++i)
          for (int j = 0; j < m; ++j)
            cxy[8 * i + j] += w * (sc.points[k][i] - xp[i]) * dy[j];
      }
    } else {
      for (int i = 0; i < n; ++i)
        for (int j = 0; j < m; ++j)
          for (int k = 0; k < n; ++k)
            cxy[8 * i + j] += pp[8 * i + k] * h[8 * j + k];
      for (int i = 0; i < m; ++i)
        for (int j = 0; j < m; ++j)
          for (int k = 0; k < n; ++k)
            s[8 * i + j] += h[8 * i + k] * cxy[8 * k + j];
    }
    V innovation{};
    for (int i = 0; i < m; ++i)
      innovation[i] = residual_component(o.kind, i, o.value[i], mean[i]);
    const M noiseless = s;
    double rscale = 1, nis = 0;
    bool accepted = true;
    M inverse{};
    // Sigma edit is applied to the conditional (whitened) vector innovations.
    auto innovation_stats = [&](double scale, double *maximum) {
      s = noiseless;
      for (int i = 0; i < m; ++i)
        s[8 * i + i] += scale * o.sigma[i] * o.sigma[i];
      s = sym8(s, m);
      M l{};
      if (!chol8(s, &l, m) || !inv8(s, &inverse, m))
        return false;
      V whitened{};
      nis = 0;
      *maximum = 0;
      for (int i = 0; i < m; ++i) {
        double v = innovation[i];
        for (int j = 0; j < i; ++j)
          v -= l[8 * i + j] * whitened[j];
        whitened[i] = v / l[8 * i + i];
        nis += whitened[i] * whitened[i];
        *maximum = std::max(*maximum, std::abs(whitened[i]));
      }
      return std::isfinite(nis);
    };
    double max_sigma = 0;
    if (!innovation_stats(1, &max_sigma))
      return result;
    if (max_sigma > config.sigma_edit_threshold &&
        config.inflate_measurement_noise) {
      // Increase only R, never P or the observation. Bisection finds the least
      // inflation passing the existing gate, subject to the caller's cap.
      double low = 1, high = config.maximum_measurement_scale;
      if (!innovation_stats(high, &max_sigma))
        return result;
      if (max_sigma <= config.sigma_edit_threshold) {
        for (int k = 0; k < 40; ++k) {
          double mid = (low + high) / 2;
          if (!innovation_stats(mid, &max_sigma))
            return result;
          if (max_sigma > config.sigma_edit_threshold)
            low = mid;
          else
            high = mid;
        }
      }
      rscale = high;
      if (!innovation_stats(rscale, &max_sigma))
        return result;
    }
    accepted = max_sigma <= config.sigma_edit_threshold;
    V updated = xp;
    M updated_p = pp;
    if (accepted) {
      M gain{};
      for (int i = 0; i < n; ++i)
        for (int j = 0; j < m; ++j)
          for (int k = 0; k < m; ++k)
            gain[8 * i + j] += cxy[8 * i + k] * inverse[8 * k + j];
      for (int i = 0; i < n; ++i)
        for (int j = 0; j < m; ++j)
          updated[i] += gain[8 * i + j] * innovation[j];
      if (ukf) {
        for (int i = 0; i < n; ++i)
          for (int j = 0; j < n; ++j)
            for (int k = 0; k < m; ++k)
              updated_p[8 * i + j] -= gain[8 * i + k] * cxy[8 * j + k];
      } else {
        M ikh{};
        for (int i = 0; i < n; ++i) {
          ikh[8 * i + i] = 1;
          for (int j = 0; j < n; ++j)
            for (int k = 0; k < m; ++k)
              ikh[8 * i + j] -= gain[8 * i + k] * h[8 * k + j];
        }
        updated_p = mul8(mul8(ikh, pp, n), tr8(ikh, n), n);
        for (int i = 0; i < n; ++i)
          for (int j = 0; j < n; ++j)
            for (int k = 0; k < m; ++k)
              updated_p[8 * i + j] += gain[8 * i + k] * rscale * o.sigma[k] *
                                      o.sigma[k] * gain[8 * j + k];
      }
    } else
      result.rejected_indices.push_back(index);
    updated_p = sym8(updated_p, n);
    if (!chol8(updated_p, &scratch, n))
      return result;
    for (double v : updated)
      if (!std::isfinite(v))
        return result;
    FilterEpoch e{};
    e.filtered = cartesian(updated, o.epoch_seconds);
    e.predicted = cartesian(xp, o.epoch_seconds);
    e.smoothed = e.filtered;
    e.filtered_extended = e.smoothed_extended = updated;
    e.filtered_covariance_extended = e.smoothed_covariance_extended = updated_p;
    for (int i = 0; i < 6; ++i)
      for (int j = 0; j < 6; ++j) {
        e.filtered_covariance[6 * i + j] = e.smoothed_covariance[6 * i + j] =
            updated_p[8 * i + j];
        e.predicted_covariance[6 * i + j] = pp[8 * i + j];
        e.transition[6 * i + j] = phi[8 * i + j];
      }
    e.normalized_innovation_squared = nis;
    e.accepted = accepted;
    e.process_noise_scale = qscale;
    e.measurement_noise_scale = rscale;
    result.epochs.push_back(e);
    predictions.push_back(pp);
    predicted_states.push_back(xp);
    crosses.push_back(cross);
    // Mehra-style innovation covariance matching, restricted to one positive
    // scale of the supplied Q. Whiten each measurement by its declared R.
    // E[nu nu' - S] = (q_true-q_used) H Q_base H'. Exclude edited/inflated
    // data.
    if (config.adaptive_process_noise && accepted && rscale == 1) {
      double mismatch = 0, sensitivity = 0;
      for (int i = 0; i < m; ++i) {
        const double r = o.sigma[i] * o.sigma[i];
        mismatch +=
            (innovation[i] * innovation[i] - noiseless[8 * i + i] - r) / r;
        for (int j = 0; j < n; ++j)
          for (int k = 0; k < n; ++k)
            sensitivity += h[8 * i + j] * q[8 * j + k] * h[8 * i + k] / r;
      }
      if (sensitivity > 1e-15) {
        const double target = std::clamp(qscale + mismatch / sensitivity,
                                         config.minimum_process_scale,
                                         config.maximum_process_scale);
        qscale = (1 - config.adaptation_rate) * qscale +
                 config.adaptation_rate * target;
      }
    }
    x = updated;
    p = updated_p;
    previous_epoch = o.epoch_seconds;
    if (!config.propagator) {
      previous_nominal = nominal.state;
      previous_stm = nominal.stm;
    }
  }
  if (smooth)
    for (std::size_t i = result.epochs.size() - 1; i-- > 0;) {
      auto &e = result.epochs[i];
      const auto &next = result.epochs[i + 1];
      M inv{};
      if (!inv8(predictions[i + 1], &inv, n))
        return result;
      const M gain = mul8(crosses[i + 1], inv, n);
      for (int j = 0; j < n; ++j)
        for (int k = 0; k < n; ++k)
          e.smoothed_extended[j] +=
              gain[8 * j + k] *
              (next.smoothed_extended[k] - predicted_states[i + 1][k]);
      M delta{};
      for (int j = 0; j < 64; ++j)
        delta[j] = next.smoothed_covariance_extended[j] - predictions[i + 1][j];
      const M correction = mul8(mul8(gain, delta, n), tr8(gain, n), n);
      for (int j = 0; j < 64; ++j)
        e.smoothed_covariance_extended[j] += correction[j];
      e.smoothed_covariance_extended = sym8(e.smoothed_covariance_extended, n);
      if (!chol8(e.smoothed_covariance_extended, &scratch, n))
        return result;
      e.smoothed = cartesian(e.smoothed_extended, e.filtered.epoch_seconds);
      for (int j = 0; j < 6; ++j)
        for (int k = 0; k < 6; ++k)
          e.smoothed_covariance[6 * j + k] =
              e.smoothed_covariance_extended[8 * j + k];
    }
  result.valid = true;
  return result;
}

std::vector<Observation>
simulate_measurements(const std::vector<Observation> &templates,
                      const std::vector<PropagatorSample> &truth_samples,
                      const std::vector<ErrorModel> &error_models) {
  std::vector<Observation> simulated = templates;
  if (templates.size() != truth_samples.size())
    return {};
  for (std::size_t index = 0; index < simulated.size(); ++index) {
    const ErrorModel *model = nullptr;
    for (const ErrorModel& candidate : error_models) {
      if (candidate.kind == simulated[index].kind) { model = &candidate; break; }
    }
    ErrorModel fallback{};
    fallback.kind = simulated[index].kind;
    if (model == nullptr) model = &fallback;
    Pcg32 random(model->seed + static_cast<std::uint64_t>(index) * 0x9e3779b97f4a7c15ULL);
    const MeasurementPrediction prediction = predict_measurement(simulated[index], truth_samples[index].state);
    simulated[index].value_count = prediction.count;
    const double sampled_bias = model->bias + model->bias_sigma * random.normal();
    for (int component = 0; component < prediction.count; ++component) {
      simulated[index].value[component] = prediction.value[component] + sampled_bias +
                                          model->noise_sigma * random.normal();
      simulated[index].sigma[component] = model->noise_sigma;
    }
  }
  return simulated;
}

IodResult gibbs_iod(const std::array<CartesianState, 3>& positions,
                    double gravitational_parameter_m3_s2) {
  IodResult result{};
  const Vec3 r1 = position(positions[0]);
  const Vec3 r2 = position(positions[1]);
  const Vec3 r3 = position(positions[2]);
  const double m1 = norm(r1), m2 = norm(r2), m3 = norm(r3);
  if (!(m1 > 0.0 && m2 > 0.0 && m3 > 0.0 && gravitational_parameter_m3_s2 > 0.0)) return result;
  const Vec3 z12 = cross(r1, r2), z23 = cross(r2, r3), z31 = cross(r3, r1);
  const Vec3 n = add(add(scale(z23, m1), scale(z31, m2)), scale(z12, m3));
  const Vec3 d = add(add(z12, z23), z31);
  const Vec3 s = add(add(scale(r1, m2 - m3), scale(r2, m3 - m1)), scale(r3, m1 - m2));
  const double nm = norm(n), dm = norm(d);
  if (nm < kTiny || dm < kTiny) return result;
  const Vec3 v2 = scale(add(scale(cross(d, r2), 1.0 / m2), s),
                          std::sqrt(gravitational_parameter_m3_s2 / (nm * dm)));
  result.state = positions[1];
  result.state.value[3] = v2.x;
  result.state.value[4] = v2.y;
  result.state.value[5] = v2.z;
  result.iterations = 1;
  result.valid = true;
  return result;
}

IodResult herrick_gibbs_iod(const std::array<CartesianState, 3>& positions,
                            double gravitational_parameter_m3_s2) {
  IodResult result{};
  const Vec3 r1 = position(positions[0]), r2 = position(positions[1]), r3 = position(positions[2]);
  const double m1 = norm(r1), m2 = norm(r2), m3 = norm(r3);
  const double dt21 = positions[1].epoch_seconds - positions[0].epoch_seconds;
  const double dt32 = positions[2].epoch_seconds - positions[1].epoch_seconds;
  const double dt31 = positions[2].epoch_seconds - positions[0].epoch_seconds;
  if (std::abs(dt21 * dt32 * dt31) < kTiny || m1 * m2 * m3 < kTiny) return result;
  const Vec3 v2 = add(
      add(scale(r1, -dt32 * (1.0 / (dt21 * dt31) + gravitational_parameter_m3_s2 /
                                                       (12.0 * m1 * m1 * m1))),
          scale(r2, (dt32 - dt21) * (1.0 / (dt21 * dt32) + gravitational_parameter_m3_s2 /
                                                            (12.0 * m2 * m2 * m2)))),
      scale(r3, dt21 * (1.0 / (dt32 * dt31) + gravitational_parameter_m3_s2 /
                                                  (12.0 * m3 * m3 * m3))));
  result.state = positions[1];
  result.state.value[3] = v2.x;
  result.state.value[4] = v2.y;
  result.state.value[5] = v2.z;
  result.iterations = 1;
  result.valid = true;
  return result;
}

IodResult gauss_iod(const std::array<AnglesObservation, 3>& observations,
                    double gravitational_parameter_m3_s2) {
  IodResult result{};
  const double tau12 = observations[0].epoch_seconds - observations[1].epoch_seconds;
  const double tau32 = observations[2].epoch_seconds - observations[1].epoch_seconds;
  const double tau13 = observations[0].epoch_seconds - observations[2].epoch_seconds;
  if (std::abs(tau12 * tau32 * tau13) < kTiny ||
      !(gravitational_parameter_m3_s2 > 0.0)) return result;
  const Vec3 l1 = line_of_sight(observations[0].right_ascension_rad, observations[0].declination_rad);
  const Vec3 l2 = line_of_sight(observations[1].right_ascension_rad, observations[1].declination_rad);
  const Vec3 l3 = line_of_sight(observations[2].right_ascension_rad, observations[2].declination_rad);
  Inverse3 inverse_los{};
  if (!invert_columns(l1, l2, l3, &inverse_los)) return result;

  // Vallado's canonical units condition the eighth-order polynomial. They do
  // not choose a force model; propagation and STM data remain caller-owned.
  constexpr double kCanonicalLengthM = 6378136.3;
  const double canonical_time = std::sqrt(
      kCanonicalLengthM * kCanonicalLengthM * kCanonicalLengthM /
      gravitational_parameter_m3_s2);
  const Vec3 rsite1 = observations[0].observer_position_m;
  const Vec3 rsite2 = observations[1].observer_position_m;
  const Vec3 rsite3 = observations[2].observer_position_m;
  const Vec3 canonical_sites[3] = {
      scale(rsite1, 1.0 / kCanonicalLengthM),
      scale(rsite2, 1.0 / kCanonicalLengthM),
      scale(rsite3, 1.0 / kCanonicalLengthM)};
  double lir[3][3]{};
  for (int row = 0; row < 3; ++row) {
    for (int column = 0; column < 3; ++column) {
      lir[row][column] = dot(inverse_los.row[row], canonical_sites[column]);
    }
  }

  const double tau12c = tau12 / canonical_time;
  const double tau32c = tau32 / canonical_time;
  const double interval = tau32c - tau12c;
  const double a1 = tau32c / interval;
  double a1u = tau32c * (interval * interval - tau32c * tau32c) /
               (6.0 * interval);
  const double a3 = -tau12c / interval;
  double a3u = -tau12c * (interval * interval - tau12c * tau12c) /
               (6.0 * interval);
  const double d1c = lir[1][0] * a1 - lir[1][1] + lir[1][2] * a3;
  const double d2c = lir[1][0] * a1u + lir[1][2] * a3u;
  const double los_site_dot = dot(l2, canonical_sites[1]);
  const double site_magnitude = norm(canonical_sites[1]);
  const double coefficient2 = -(d1c * d1c + 2.0 * d1c * los_site_dot +
                                site_magnitude * site_magnitude);
  const double coefficient5 = -2.0 * (los_site_dot * d2c + d1c * d2c);
  const double coefficient8 = -d2c * d2c;
  double canonical_radius = largest_positive_sparse_root(coefficient2, coefficient5,
                                                        coefficient8);
  if (!(canonical_radius > 0.0) || canonical_radius * kCanonicalLengthM > 50000000.0) {
    canonical_radius = 35000000.0 / kCanonicalLengthM;
  }

  const double radius = canonical_radius * kCanonicalLengthM;
  a1u *= canonical_time * canonical_time;
  a3u *= canonical_time * canonical_time;
  const double inverse_radius3 = gravitational_parameter_m3_s2 /
      (radius * radius * radius);
  const double c1 = a1 + a1u * inverse_radius3;
  constexpr double c2 = -1.0;
  const double c3 = a3 + a3u * inverse_radius3;
  if (std::abs(c1 * c3) < kTiny) return result;

  const Vec3 sites[3] = {rsite1, rsite2, rsite3};
  for (int row = 0; row < 3; ++row) {
    for (int column = 0; column < 3; ++column) {
      lir[row][column] = dot(inverse_los.row[row], sites[column]);
    }
  }
  const double coefficients[3] = {-c1, -c2, -c3};
  double rho_matrix[3]{};
  for (int row = 0; row < 3; ++row) {
    for (int column = 0; column < 3; ++column) {
      rho_matrix[row] += lir[row][column] * coefficients[column];
    }
  }
  const Vec3 r1 = add(rsite1, scale(l1, rho_matrix[0] / c1));
  const Vec3 r2 = add(rsite2, scale(l2, rho_matrix[1] / c2));
  const Vec3 r3 = add(rsite3, scale(l3, rho_matrix[2] / c3));
  std::array<CartesianState, 3> states{};
  states[0].value = {r1.x, r1.y, r1.z, 0.0, 0.0, 0.0};
  states[1].value = {r2.x, r2.y, r2.z, 0.0, 0.0, 0.0};
  states[2].value = {r3.x, r3.y, r3.z, 0.0, 0.0, 0.0};
  IodResult gibbs = gibbs_iod(states, gravitational_parameter_m3_s2);
  if (!gibbs.valid) return result;
  gibbs.state.epoch_seconds = observations[1].epoch_seconds;
  gibbs.iterations = 15;
  return gibbs;
}

IodResult laplace_iod(const std::array<AnglesObservation, 3>& observations,
                      double gravitational_parameter_m3_s2) {
  IodResult result{};
  const double tau12 = observations[0].epoch_seconds - observations[1].epoch_seconds;
  const double tau13 = observations[0].epoch_seconds - observations[2].epoch_seconds;
  const double tau32 = observations[2].epoch_seconds - observations[1].epoch_seconds;
  if (std::abs(tau12 * tau13 * tau32) < kTiny ||
      !(gravitational_parameter_m3_s2 > 0.0)) return result;
  const Vec3 l1 = line_of_sight(observations[0].right_ascension_rad, observations[0].declination_rad);
  const Vec3 l2 = line_of_sight(observations[1].right_ascension_rad, observations[1].declination_rad);
  const Vec3 l3 = line_of_sight(observations[2].right_ascension_rad, observations[2].declination_rad);
  constexpr double kCanonicalLengthM = 6378136.3;
  const double canonical_time = std::sqrt(
      kCanonicalLengthM * kCanonicalLengthM * kCanonicalLengthM /
      gravitational_parameter_m3_s2);
  const double tau12c = tau12 / canonical_time;
  const double tau13c = tau13 / canonical_time;
  const double tau32c = tau32 / canonical_time;
  const double s1 = -tau32c / (tau12c * tau13c);
  const double s2 = (tau12c + tau32c) / (tau12c * tau32c);
  const double s3 = -tau12c / (-tau13c * tau32c);
  const double s4 = 2.0 / (tau12c * tau13c);
  const double s5 = 2.0 / (tau12c * tau32c);
  const double s6 = 2.0 / (-tau13c * tau32c);
  const Vec3 ldot = add(add(scale(l1, s1), scale(l2, s2)), scale(l3, s3));
  const Vec3 lddot = add(add(scale(l1, s4), scale(l2, s5)), scale(l3, s6));
  const Vec3 site1 = scale(observations[0].observer_position_m, 1.0 / kCanonicalLengthM);
  const Vec3 site2 = scale(observations[1].observer_position_m, 1.0 / kCanonicalLengthM);
  const Vec3 site3 = scale(observations[2].observer_position_m, 1.0 / kCanonicalLengthM);
  const Vec3 site_dot = add(add(scale(site1, s1), scale(site2, s2)), scale(site3, s3));
  const Vec3 site_ddot = add(add(scale(site1, s4), scale(site2, s5)), scale(site3, s6));
  const double d = 2.0 * triple(l2, ldot, lddot);
  if (std::abs(d) < 1.0e-14) return result;
  const double d1c = triple(l2, ldot, site_ddot);
  const double d2c = triple(l2, ldot, site2);
  const double d3c = triple(l2, site_ddot, lddot);
  const double d4c = triple(l2, site2, lddot);
  const double los_site_dot = dot(l2, site2);
  const double coefficient2 = los_site_dot * 4.0 * d1c / d -
                              4.0 * d1c * d1c / (d * d) - dot(site2, site2);
  const double coefficient5 = los_site_dot * 4.0 * d2c / d -
                              8.0 * d1c * d2c / (d * d);
  const double coefficient8 = -4.0 * d2c * d2c / (d * d);
  const double canonical_radius = largest_positive_sparse_root(
      coefficient2, coefficient5, coefficient8);
  if (!(canonical_radius > 0.0)) return result;
  const double radius3 = canonical_radius * canonical_radius * canonical_radius;
  const double rho = -2.0 * d1c / d - 2.0 * d2c / (radius3 * d);
  const double rho_dot = -d3c / d - d4c / (radius3 * d);
  const Vec3 state_position_canonical = add(site2, scale(l2, rho));
  const Vec3 state_velocity_canonical = add(add(site_dot, scale(l2, rho_dot)),
                                            scale(ldot, rho));
  const Vec3 state_position = scale(state_position_canonical, kCanonicalLengthM);
  const Vec3 state_velocity = scale(state_velocity_canonical,
                                    kCanonicalLengthM / canonical_time);
  result.state.epoch_seconds = observations[1].epoch_seconds;
  result.state.value = {state_position.x, state_position.y, state_position.z,
                        state_velocity.x, state_velocity.y, state_velocity.z};
  result.iterations = 15;
  result.valid = true;
  return result;
}

}  // namespace sdn::estimation
