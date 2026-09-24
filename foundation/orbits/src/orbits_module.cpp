#include "space_data_module_invoke.h"

#include "flatbuffers/flatbuffers.h"

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>


// Generated from the published spacedatastandards.org package by
// generate-sds-headers.mjs; never edited by hand.
#include "CDM_generated.h"
#include "CRD_generated.h"
#include "GRV_generated.h"
#include "OCM_generated.h"
#include "OEM_generated.h"
#include "OMM_generated.h"
#include "OPM_generated.h"

// GMAT-parity element-set conversions (dependency-free, SI units, radians).
#include "state_representations.hpp"

namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kTwoPi = 2.0 * kPi;
constexpr double kDegreesToRadians = kPi / 180.0;
constexpr double kRadiansToDegrees = 180.0 / kPi;
constexpr double kSecondsPerDay = 86400.0;
constexpr double kSmall = 1e-12;
constexpr double kSingularOrbitTolerance = 1e-10;
constexpr double kBasiliskSolarFlux = 1372.5398;
constexpr double kSpeedOfLightMetersPerSecond = 299792458.0;

bool finite(double value);

double compute_omm_mean_motion_rev_per_day(double semi_major_axis, double gm) {
  if (!std::isfinite(semi_major_axis) || !std::isfinite(gm) ||
      semi_major_axis <= 0.0 || gm <= 0.0) {
    return 0.0;
  }
  return std::sqrt(gm / (semi_major_axis * semi_major_axis * semi_major_axis)) *
         kSecondsPerDay / kTwoPi;
}

// Thin builders over the generated SDS API, one per record this module emits.

::flatbuffers::Offset<OMM> BuildOmmElements(
    ::flatbuffers::FlatBufferBuilder& builder,
    ::flatbuffers::Offset<::flatbuffers::String> creation_date,
    ::flatbuffers::Offset<::flatbuffers::String> originator,
    ::flatbuffers::Offset<::flatbuffers::String> object_name,
    ::flatbuffers::Offset<::flatbuffers::String> object_id,
    ::flatbuffers::Offset<::flatbuffers::String> center_name,
    int8_t time_system,
    int8_t mean_element_theory,
    ::flatbuffers::Offset<::flatbuffers::String> comment,
    ::flatbuffers::Offset<::flatbuffers::String> epoch,
    double semi_major_axis,
    double eccentricity,
    double inclination,
    double raan,
    double arg_pericenter,
    double mean_anomaly,
    double gm) {
  const double mean_motion = compute_omm_mean_motion_rev_per_day(semi_major_axis, gm);
  OMMBuilder b(builder);
  b.add_GM(gm);
  b.add_MEAN_ANOMALY(mean_anomaly);
  b.add_ARG_OF_PERICENTER(arg_pericenter);
  b.add_RA_OF_ASC_NODE(raan);
  b.add_INCLINATION(inclination);
  b.add_ECCENTRICITY(eccentricity);
  b.add_MEAN_MOTION(mean_motion);
  b.add_SEMI_MAJOR_AXIS(semi_major_axis);
  b.add_EPOCH(epoch);
  b.add_COMMENT(comment);
  b.add_MEAN_ELEMENT_THEORY(static_cast<meanElementSource>(mean_element_theory));
  b.add_TIME_SYSTEM(static_cast<timingStandard>(time_system));
  b.add_CENTER_NAME(center_name);
  b.add_OBJECT_ID(object_id);
  b.add_OBJECT_NAME(object_name);
  b.add_ORIGINATOR(originator);
  b.add_CREATION_DATE(creation_date);
  b.add_CCSDS_OMM_VERS(2.0);
  return b.Finish();
}

::flatbuffers::Offset<ephemerisDataLine> BuildOemLine(
    ::flatbuffers::FlatBufferBuilder& builder,
    ::flatbuffers::Offset<::flatbuffers::String> epoch,
    double x,
    double y,
    double z,
    double x_dot,
    double y_dot,
    double z_dot,
    double x_ddot = 0.0,
    double y_ddot = 0.0,
    double z_ddot = 0.0) {
  return CreateephemerisDataLine(builder, epoch, x, y, z, x_dot, y_dot, z_dot, x_ddot, y_ddot, z_ddot);
}

::flatbuffers::Offset<ephemerisDataBlock> BuildOemBlock(
    ::flatbuffers::FlatBufferBuilder& builder,
    ::flatbuffers::Offset<::flatbuffers::String> comment,
    ::flatbuffers::Offset<::flatbuffers::String> center_name,
    int8_t time_system,
    ::flatbuffers::Offset<::flatbuffers::String> start_time,
    ::flatbuffers::Offset<::flatbuffers::String> stop_time,
    ::flatbuffers::Offset<::flatbuffers::Vector<::flatbuffers::Offset<ephemerisDataLine>>> lines,
    uint8_t state_vector_size = 6) {
  ephemerisDataBlockBuilder b(builder);
  b.add_EPHEMERIS_DATA_LINES(lines);
  b.add_STATE_VECTOR_SIZE(state_vector_size);
  b.add_STOP_TIME(stop_time);
  b.add_START_TIME(start_time);
  b.add_TIME_SYSTEM(static_cast<timingStandard>(time_system));
  b.add_CENTER_NAME(center_name);
  b.add_COMMENT(comment);
  return b.Finish();
}

::flatbuffers::Offset<OEM> BuildOem(
    ::flatbuffers::FlatBufferBuilder& builder,
    ::flatbuffers::Offset<::flatbuffers::String> classification,
    double version,
    ::flatbuffers::Offset<::flatbuffers::String> creation_date,
    ::flatbuffers::Offset<::flatbuffers::String> originator,
    ::flatbuffers::Offset<::flatbuffers::Vector<::flatbuffers::Offset<ephemerisDataBlock>>> blocks) {
  return CreateOEM(builder, classification, version, creation_date, originator, blocks);
}

::flatbuffers::Offset<CDM> BuildCdmRelativeState(
    ::flatbuffers::FlatBufferBuilder& builder,
    ::flatbuffers::Offset<::flatbuffers::String> creation_date,
    ::flatbuffers::Offset<::flatbuffers::String> originator,
    ::flatbuffers::Offset<::flatbuffers::String> message_for,
    ::flatbuffers::Offset<::flatbuffers::String> message_id,
    ::flatbuffers::Offset<::flatbuffers::String> tca,
    double miss_distance,
    double relative_speed,
    double relative_position_r,
    double relative_position_t,
    double relative_position_n,
    double relative_velocity_r,
    double relative_velocity_t,
    double relative_velocity_n) {
  CDMBuilder b(builder);
  b.add_RELATIVE_VELOCITY_N(relative_velocity_n);
  b.add_RELATIVE_VELOCITY_T(relative_velocity_t);
  b.add_RELATIVE_VELOCITY_R(relative_velocity_r);
  b.add_RELATIVE_POSITION_N(relative_position_n);
  b.add_RELATIVE_POSITION_T(relative_position_t);
  b.add_RELATIVE_POSITION_R(relative_position_r);
  b.add_RELATIVE_SPEED(relative_speed);
  b.add_MISS_DISTANCE(miss_distance);
  b.add_TCA(tca);
  b.add_MESSAGE_ID(message_id);
  b.add_MESSAGE_FOR(message_for);
  b.add_ORIGINATOR(originator);
  b.add_CREATION_DATE(creation_date);
  b.add_CCSDS_CDM_VERS(2.0);
  return b.Finish();
}

struct CartesianState {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double x_dot = 0.0;
  double y_dot = 0.0;
  double z_dot = 0.0;
};

struct Vector3 {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

struct KeplerianElements {
  double semi_major_axis = 0.0;
  double eccentricity = 0.0;
  double inclination = 0.0;
  double raan = 0.0;
  double arg_pericenter = 0.0;
  double mean_anomaly = 0.0;
  double gm = 0.0;
  double periapsis_radius = 0.0;
};

struct EquinoctialElements {
  double af = 0.0;
  double ag = 0.0;
  double true_longitude = 0.0;
  double semi_major_axis = 0.0;
  double chi = 0.0;
  double psi = 0.0;
};

struct ElementRecord {
  double semi_major_axis = 0.0;
  double eccentricity = 0.0;
  double inclination = 0.0;
  double raan = 0.0;
  double arg_pericenter = 0.0;
  double anomaly = 0.0;
  double periapsis_radius = 0.0;
  int8_t anomaly_type = 0;
};

struct OemMetadata {
  const char* epoch = nullptr;
  const char* center_name = nullptr;
  int8_t time_system = 11;
};

struct RelativeHillState {
  Vector3 position;
  Vector3 velocity;
  double miss_distance = 0.0;
  double relative_speed = 0.0;
};

bool solve_eccentric_anomaly(double mean_anomaly, double eccentricity, double* eccentric_anomaly) {
  if (eccentric_anomaly == nullptr || eccentricity < 0.0 || eccentricity >= 1.0) {
    return false;
  }

  double anomaly = std::fmod(mean_anomaly, 2.0 * kPi);
  if (anomaly > kPi) {
    anomaly -= 2.0 * kPi;
  } else if (anomaly < -kPi) {
    anomaly += 2.0 * kPi;
  }

  double estimate = eccentricity < 0.8 ? anomaly : (anomaly >= 0.0 ? kPi : -kPi);
  for (int iteration = 0; iteration < 50; ++iteration) {
    const double f = estimate - eccentricity * std::sin(estimate) - anomaly;
    const double fp = 1.0 - eccentricity * std::cos(estimate);
    if (fp == 0.0) {
      return false;
    }
    const double delta = f / fp;
    estimate -= delta;
    if (std::abs(delta) <= 1e-14) {
      *eccentric_anomaly = estimate;
      return true;
    }
  }

  *eccentric_anomaly = estimate;
  return std::abs(estimate - eccentricity * std::sin(estimate) - anomaly) <= 1e-12;
}

bool solve_hyperbolic_anomaly(double mean_anomaly, double eccentricity, double* hyperbolic_anomaly) {
  if (hyperbolic_anomaly == nullptr || eccentricity <= 1.0 || !finite(mean_anomaly)) {
    return false;
  }

  double estimate = std::asinh(mean_anomaly / eccentricity);
  for (int iteration = 0; iteration < 60; ++iteration) {
    const double f = eccentricity * std::sinh(estimate) - estimate - mean_anomaly;
    const double fp = eccentricity * std::cosh(estimate) - 1.0;
    if (fp == 0.0 || !finite(f) || !finite(fp)) {
      return false;
    }
    const double delta = f / fp;
    estimate -= delta;
    if (std::abs(delta) <= 1e-14) {
      *hyperbolic_anomaly = estimate;
      return true;
    }
  }

  *hyperbolic_anomaly = estimate;
  return std::abs(eccentricity * std::sinh(estimate) - estimate - mean_anomaly) <= 1e-12;
}

bool finite(double value) {
  return std::isfinite(value);
}

double dot(const Vector3& lhs, const Vector3& rhs) {
  return lhs.x * rhs.x + lhs.y * rhs.y + lhs.z * rhs.z;
}

Vector3 cross(const Vector3& lhs, const Vector3& rhs) {
  return {
      lhs.y * rhs.z - lhs.z * rhs.y,
      lhs.z * rhs.x - lhs.x * rhs.z,
      lhs.x * rhs.y - lhs.y * rhs.x,
  };
}

Vector3 scale(const Vector3& value, double factor) {
  return {value.x * factor, value.y * factor, value.z * factor};
}

Vector3 add(const Vector3& lhs, const Vector3& rhs) {
  return {lhs.x + rhs.x, lhs.y + rhs.y, lhs.z + rhs.z};
}

Vector3 subtract(const Vector3& lhs, const Vector3& rhs) {
  return {lhs.x - rhs.x, lhs.y - rhs.y, lhs.z - rhs.z};
}

double norm(const Vector3& value) {
  return std::sqrt(dot(value, value));
}

Vector3 position_vector(const CartesianState& state) {
  return {state.x, state.y, state.z};
}

Vector3 velocity_vector(const CartesianState& state) {
  return {state.x_dot, state.y_dot, state.z_dot};
}

bool compute_hill_relative_state(
    const CartesianState& chief,
    const CartesianState& deputy,
    RelativeHillState* relative) {
  if (relative == nullptr) {
    return false;
  }

  const Vector3 rc = position_vector(chief);
  const Vector3 vc = velocity_vector(chief);
  const Vector3 rd = position_vector(deputy);
  const Vector3 vd = velocity_vector(deputy);
  const double rc_norm = norm(rc);
  const Vector3 h = cross(rc, vc);
  const double h_norm = norm(h);
  if (!(rc_norm > kSmall) || !(h_norm > kSmall) ||
      !finite(rc_norm) || !finite(h_norm)) {
    return false;
  }

  const Vector3 radial = scale(rc, 1.0 / rc_norm);
  const Vector3 normal = scale(h, 1.0 / h_norm);
  const Vector3 transverse = cross(normal, radial);
  const Vector3 rho_inertial = subtract(rd, rc);
  const Vector3 rho_dot_inertial = subtract(vd, vc);
  const Vector3 rho_hill = {
      dot(radial, rho_inertial),
      dot(transverse, rho_inertial),
      dot(normal, rho_inertial),
  };
  const Vector3 rho_dot_hill = {
      dot(radial, rho_dot_inertial),
      dot(transverse, rho_dot_inertial),
      dot(normal, rho_dot_inertial),
  };
  const double true_anomaly_rate = h_norm / (rc_norm * rc_norm);
  const Vector3 omega_cross_rho = {
      -true_anomaly_rate * rho_hill.y,
      true_anomaly_rate * rho_hill.x,
      0.0,
  };

  relative->position = rho_hill;
  relative->velocity = subtract(rho_dot_hill, omega_cross_rho);
  relative->miss_distance = norm(relative->position);
  relative->relative_speed = norm(relative->velocity);

  return finite(relative->position.x) && finite(relative->position.y) &&
         finite(relative->position.z) && finite(relative->velocity.x) &&
         finite(relative->velocity.y) && finite(relative->velocity.z) &&
         finite(relative->miss_distance) && finite(relative->relative_speed);
}

Vector3 hill_to_inertial(
    const Vector3& radial,
    const Vector3& transverse,
    const Vector3& normal,
    const Vector3& hill_vector) {
  return add(
      add(scale(radial, hill_vector.x), scale(transverse, hill_vector.y)),
      scale(normal, hill_vector.z));
}

bool compute_deputy_from_hill_relative_state(
    const CartesianState& chief,
    const RelativeHillState& relative,
    CartesianState* deputy) {
  if (deputy == nullptr) {
    return false;
  }

  const Vector3 rc = position_vector(chief);
  const Vector3 vc = velocity_vector(chief);
  const double rc_norm = norm(rc);
  const Vector3 h = cross(rc, vc);
  const double h_norm = norm(h);
  if (!(rc_norm > kSmall) || !(h_norm > kSmall) ||
      !finite(rc_norm) || !finite(h_norm)) {
    return false;
  }

  const Vector3 radial = scale(rc, 1.0 / rc_norm);
  const Vector3 normal = scale(h, 1.0 / h_norm);
  const Vector3 transverse = cross(normal, radial);
  const double true_anomaly_rate = h_norm / (rc_norm * rc_norm);
  const Vector3 omega_cross_rho = {
      -true_anomaly_rate * relative.position.y,
      true_anomaly_rate * relative.position.x,
      0.0,
  };
  const Vector3 rho_dot_hill = add(relative.velocity, omega_cross_rho);
  const Vector3 rho_inertial = hill_to_inertial(radial, transverse, normal, relative.position);
  const Vector3 rho_dot_inertial = hill_to_inertial(radial, transverse, normal, rho_dot_hill);
  const Vector3 rd = add(rc, rho_inertial);
  const Vector3 vd = add(vc, rho_dot_inertial);

  deputy->x = rd.x;
  deputy->y = rd.y;
  deputy->z = rd.z;
  deputy->x_dot = vd.x;
  deputy->y_dot = vd.y;
  deputy->z_dot = vd.z;

  return finite(deputy->x) && finite(deputy->y) && finite(deputy->z) &&
         finite(deputy->x_dot) && finite(deputy->y_dot) && finite(deputy->z_dot);
}

double clamp_unit(double value) {
  if (value > 1.0) {
    return 1.0;
  }
  if (value < -1.0) {
    return -1.0;
  }
  return value;
}

double normalize_radians(double value) {
  double normalized = std::fmod(value, kTwoPi);
  if (normalized < 0.0) {
    normalized += kTwoPi;
  }
  return normalized;
}

double normalize_degrees(double radians) {
  double degrees = normalize_radians(radians) * kRadiansToDegrees;
  if (degrees >= 360.0) {
    degrees -= 360.0;
  }
  return degrees;
}

bool convert_rectilinear_anomaly_values_to_cartesian(
    double semi_major_axis,
    double eccentricity,
    double inclination,
    double raan,
    double arg_pericenter,
    double anomaly,
    double gm,
    CartesianState* state) {
  // Basilisk's e == 1 rectilinear elem2rv branch treats f as the source
  // eccentric/hyperbolic anomaly and constrains motion to the periapsis axis.
  if (state == nullptr || !finite(semi_major_axis) || !finite(eccentricity) ||
      !finite(inclination) || !finite(raan) || !finite(arg_pericenter) ||
      !finite(anomaly) || !finite(gm) || gm <= 0.0 ||
      std::abs(eccentricity - 1.0) > kSingularOrbitTolerance ||
      std::abs(semi_major_axis) <= kSmall) {
    return false;
  }

  const double radius = semi_major_axis > 0.0
                            ? semi_major_axis * (1.0 - eccentricity * std::cos(anomaly))
                            : semi_major_axis * (1.0 - eccentricity * std::cosh(anomaly));
  if (!(radius > 0.0) || !finite(radius)) {
    return false;
  }

  const double velocity_squared = 2.0 * gm / radius - gm / semi_major_axis;
  if (!(velocity_squared > 0.0) || !finite(velocity_squared)) {
    return false;
  }

  const double cos_raan = std::cos(raan);
  const double sin_raan = std::sin(raan);
  const double cos_i = std::cos(inclination);
  const double sin_i = std::sin(inclination);
  const double cos_argp = std::cos(arg_pericenter);
  const double sin_argp = std::sin(arg_pericenter);
  const Vector3 direction = {
      cos_raan * cos_argp - sin_raan * sin_argp * cos_i,
      sin_raan * cos_argp + cos_raan * sin_argp * cos_i,
      sin_argp * sin_i,
  };
  const double velocity_sign = std::sin(anomaly) > 0.0 ? 1.0 : -1.0;
  const double velocity_magnitude = std::sqrt(velocity_squared);

  state->x = radius * direction.x;
  state->y = radius * direction.y;
  state->z = radius * direction.z;
  state->x_dot = velocity_sign * velocity_magnitude * direction.x;
  state->y_dot = velocity_sign * velocity_magnitude * direction.y;
  state->z_dot = velocity_sign * velocity_magnitude * direction.z;

  return finite(state->x) && finite(state->y) && finite(state->z) &&
         finite(state->x_dot) && finite(state->y_dot) && finite(state->z_dot);
}

bool convert_parabolic_true_anomaly_values_to_cartesian(
    double periapsis_radius,
    double eccentricity,
    double inclination,
    double raan,
    double arg_pericenter,
    double true_anomaly,
    double gm,
    CartesianState* state) {
  if (state == nullptr || !finite(periapsis_radius) || !finite(eccentricity) ||
      !finite(inclination) || !finite(raan) || !finite(arg_pericenter) ||
      !finite(true_anomaly) || !finite(gm) || periapsis_radius <= 0.0 ||
      gm <= 0.0 || std::abs(eccentricity - 1.0) > kSingularOrbitTolerance) {
    return false;
  }

  const double parameter = 2.0 * periapsis_radius;
  const double cos_true_anomaly = std::cos(true_anomaly);
  const double sin_true_anomaly = std::sin(true_anomaly);
  const double denominator = 1.0 + cos_true_anomaly;
  if (!(parameter > 0.0) || !(denominator > kSmall)) {
    return false;
  }

  const double radius = parameter / denominator;
  const double velocity_factor = std::sqrt(gm / parameter);
  if (!(radius > 0.0) || !finite(radius) || !finite(velocity_factor)) {
    return false;
  }

  const double x_orbital = radius * cos_true_anomaly;
  const double y_orbital = radius * sin_true_anomaly;
  const double x_dot_orbital = -velocity_factor * sin_true_anomaly;
  const double y_dot_orbital = velocity_factor * (1.0 + cos_true_anomaly);

  const double cos_raan = std::cos(raan);
  const double sin_raan = std::sin(raan);
  const double cos_i = std::cos(inclination);
  const double sin_i = std::sin(inclination);
  const double cos_argp = std::cos(arg_pericenter);
  const double sin_argp = std::sin(arg_pericenter);

  const double m11 = cos_raan * cos_argp - sin_raan * sin_argp * cos_i;
  const double m12 = -cos_raan * sin_argp - sin_raan * cos_argp * cos_i;
  const double m21 = sin_raan * cos_argp + cos_raan * sin_argp * cos_i;
  const double m22 = -sin_raan * sin_argp + cos_raan * cos_argp * cos_i;
  const double m31 = sin_argp * sin_i;
  const double m32 = cos_argp * sin_i;

  state->x = m11 * x_orbital + m12 * y_orbital;
  state->y = m21 * x_orbital + m22 * y_orbital;
  state->z = m31 * x_orbital + m32 * y_orbital;
  state->x_dot = m11 * x_dot_orbital + m12 * y_dot_orbital;
  state->y_dot = m21 * x_dot_orbital + m22 * y_dot_orbital;
  state->z_dot = m31 * x_dot_orbital + m32 * y_dot_orbital;

  return finite(state->x) && finite(state->y) && finite(state->z) &&
         finite(state->x_dot) && finite(state->y_dot) && finite(state->z_dot);
}

bool convert_keplerian_values_to_cartesian(
    double semi_major_axis,
    double eccentricity,
    double inclination,
    double raan,
    double arg_pericenter,
    double mean_anomaly,
    double gm,
    CartesianState* state);

bool convert_keplerian_to_cartesian(const OMM* omm, CartesianState* state) {
  if (omm == nullptr) {
    return false;
  }
  return convert_keplerian_values_to_cartesian(
      omm->SEMI_MAJOR_AXIS(),
      omm->ECCENTRICITY(),
      omm->INCLINATION() * kDegreesToRadians,
      omm->RA_OF_ASC_NODE() * kDegreesToRadians,
      omm->ARG_OF_PERICENTER() * kDegreesToRadians,
      omm->MEAN_ANOMALY() * kDegreesToRadians,
      omm->GM(),
      state);
}

bool convert_keplerian_values_to_cartesian(
    double semi_major_axis,
    double eccentricity,
    double inclination,
    double raan,
    double arg_pericenter,
    double mean_anomaly,
    double gm,
    CartesianState* state) {
  if (state == nullptr) {
    return false;
  }
  if (!finite(semi_major_axis) || !finite(eccentricity) || !finite(inclination) ||
      !finite(raan) || !finite(arg_pericenter) || !finite(mean_anomaly) ||
      !finite(gm) || eccentricity < 0.0 || gm <= 0.0) {
    return false;
  }

  const bool elliptical = eccentricity < 1.0;
  const bool hyperbolic = eccentricity > 1.0;
  if ((!elliptical && !hyperbolic) ||
      (elliptical && !(semi_major_axis > 0.0)) ||
      (hyperbolic && !(semi_major_axis < 0.0))) {
    return false;
  }

  double x_orbital = 0.0;
  double y_orbital = 0.0;
  double x_dot_orbital = 0.0;
  double y_dot_orbital = 0.0;

  if (elliptical) {
    double eccentric_anomaly = 0.0;
    if (!solve_eccentric_anomaly(mean_anomaly, eccentricity, &eccentric_anomaly)) {
      return false;
    }

    const double cos_e = std::cos(eccentric_anomaly);
    const double sin_e = std::sin(eccentric_anomaly);
    const double beta = std::sqrt(1.0 - eccentricity * eccentricity);
    const double radius = semi_major_axis * (1.0 - eccentricity * cos_e);
    if (!(radius > 0.0)) {
      return false;
    }

    x_orbital = semi_major_axis * (cos_e - eccentricity);
    y_orbital = semi_major_axis * beta * sin_e;
    const double velocity_factor = std::sqrt(gm * semi_major_axis) / radius;
    x_dot_orbital = -velocity_factor * sin_e;
    y_dot_orbital = velocity_factor * beta * cos_e;
  } else {
    double hyperbolic_anomaly = 0.0;
    if (!solve_hyperbolic_anomaly(mean_anomaly, eccentricity, &hyperbolic_anomaly)) {
      return false;
    }

    const double cosh_h = std::cosh(hyperbolic_anomaly);
    const double sinh_h = std::sinh(hyperbolic_anomaly);
    const double beta = std::sqrt(eccentricity * eccentricity - 1.0);
    const double denominator = eccentricity * cosh_h - 1.0;
    if (!(denominator > 0.0)) {
      return false;
    }

    x_orbital = semi_major_axis * (cosh_h - eccentricity);
    y_orbital = -semi_major_axis * beta * sinh_h;
    const double velocity_factor = std::sqrt(gm / (-semi_major_axis)) / denominator;
    x_dot_orbital = -velocity_factor * sinh_h;
    y_dot_orbital = velocity_factor * beta * cosh_h;
  }

  const double cos_raan = std::cos(raan);
  const double sin_raan = std::sin(raan);
  const double cos_i = std::cos(inclination);
  const double sin_i = std::sin(inclination);
  const double cos_argp = std::cos(arg_pericenter);
  const double sin_argp = std::sin(arg_pericenter);

  const double m11 = cos_raan * cos_argp - sin_raan * sin_argp * cos_i;
  const double m12 = -cos_raan * sin_argp - sin_raan * cos_argp * cos_i;
  const double m21 = sin_raan * cos_argp + cos_raan * sin_argp * cos_i;
  const double m22 = -sin_raan * sin_argp + cos_raan * cos_argp * cos_i;
  const double m31 = sin_argp * sin_i;
  const double m32 = cos_argp * sin_i;

  state->x = m11 * x_orbital + m12 * y_orbital;
  state->y = m21 * x_orbital + m22 * y_orbital;
  state->z = m31 * x_orbital + m32 * y_orbital;
  state->x_dot = m11 * x_dot_orbital + m12 * y_dot_orbital;
  state->y_dot = m21 * x_dot_orbital + m22 * y_dot_orbital;
  state->z_dot = m31 * x_dot_orbital + m32 * y_dot_orbital;

  return finite(state->x) && finite(state->y) && finite(state->z) &&
         finite(state->x_dot) && finite(state->y_dot) && finite(state->z_dot);
}

bool mean_anomaly_from_true_anomaly(
    double true_anomaly,
    double eccentricity,
    double* mean_anomaly) {
  if (mean_anomaly == nullptr || !finite(true_anomaly) || !finite(eccentricity) ||
      eccentricity < 0.0) {
    return false;
  }

  if (eccentricity < 1.0) {
    const double eccentric_anomaly = 2.0 * std::atan2(
        std::sqrt(1.0 - eccentricity) * std::sin(true_anomaly / 2.0),
        std::sqrt(1.0 + eccentricity) * std::cos(true_anomaly / 2.0));
    *mean_anomaly = normalize_radians(eccentric_anomaly - eccentricity * std::sin(eccentric_anomaly));
    return finite(*mean_anomaly);
  }

  if (std::abs(eccentricity - 1.0) <= kSingularOrbitTolerance) {
    const double parabolic_parameter = std::tan(true_anomaly / 2.0);
    if (!finite(parabolic_parameter)) {
      return false;
    }
    *mean_anomaly =
        parabolic_parameter + parabolic_parameter * parabolic_parameter *
                                  parabolic_parameter / 3.0;
    return finite(*mean_anomaly);
  }

  if (eccentricity > 1.0) {
    const double tanh_half_h = std::sqrt((eccentricity - 1.0) / (eccentricity + 1.0)) *
                               std::tan(true_anomaly / 2.0);
    if (!finite(tanh_half_h) || std::abs(tanh_half_h) >= 1.0) {
      return false;
    }
    const double hyperbolic_anomaly = 2.0 * std::atanh(tanh_half_h);
    *mean_anomaly = eccentricity * std::sinh(hyperbolic_anomaly) - hyperbolic_anomaly;
    return finite(*mean_anomaly);
  }

  return false;
}

bool true_anomaly_from_parabolic_mean_anomaly(
    double mean_anomaly,
    double* true_anomaly) {
  if (true_anomaly == nullptr || !finite(mean_anomaly)) {
    return false;
  }

  const double scaled_mean = 1.5 * mean_anomaly;
  const double root = std::sqrt(scaled_mean * scaled_mean + 1.0);
  const double parabolic_parameter =
      std::cbrt(scaled_mean + root) + std::cbrt(scaled_mean - root);
  if (!finite(parabolic_parameter)) {
    return false;
  }

  *true_anomaly = 2.0 * std::atan(parabolic_parameter);
  return finite(*true_anomaly);
}

bool true_anomaly_from_mean_anomaly(
    double mean_anomaly,
    double eccentricity,
    double* true_anomaly) {
  if (true_anomaly == nullptr || !finite(mean_anomaly) || !finite(eccentricity) ||
      eccentricity < 0.0) {
    return false;
  }

  if (eccentricity < 1.0) {
    double eccentric_anomaly = 0.0;
    if (!solve_eccentric_anomaly(mean_anomaly, eccentricity, &eccentric_anomaly)) {
      return false;
    }
    *true_anomaly = normalize_radians(2.0 * std::atan2(
        std::sqrt(1.0 + eccentricity) * std::sin(eccentric_anomaly / 2.0),
        std::sqrt(1.0 - eccentricity) * std::cos(eccentric_anomaly / 2.0)));
    return finite(*true_anomaly);
  }

  if (std::abs(eccentricity - 1.0) <= kSingularOrbitTolerance) {
    return true_anomaly_from_parabolic_mean_anomaly(mean_anomaly, true_anomaly);
  }

  if (eccentricity > 1.0) {
    double hyperbolic_anomaly = 0.0;
    if (!solve_hyperbolic_anomaly(mean_anomaly, eccentricity, &hyperbolic_anomaly)) {
      return false;
    }
    *true_anomaly = 2.0 * std::atan(
        std::sqrt((eccentricity + 1.0) / (eccentricity - 1.0)) *
        std::tanh(hyperbolic_anomaly / 2.0));
    return finite(*true_anomaly);
  }

  return false;
}

bool convert_opm_keplerian_to_elements(const OPM* opm, KeplerianElements* elements) {
  if (opm == nullptr || elements == nullptr) {
    return false;
  }

  double mean_anomaly = 0.0;
  if (!mean_anomaly_from_true_anomaly(
          opm->TRUE_ANOMALY() * kDegreesToRadians,
          opm->ECCENTRICITY(),
          &mean_anomaly)) {
    return false;
  }

  elements->semi_major_axis = opm->SEMI_MAJOR_AXIS();
  elements->eccentricity = opm->ECCENTRICITY();
  elements->inclination = opm->INCLINATION();
  elements->raan = normalize_degrees(opm->RA_OF_ASC_NODE() * kDegreesToRadians);
  elements->arg_pericenter = normalize_degrees(opm->ARG_OF_PERICENTER() * kDegreesToRadians);
  elements->mean_anomaly = mean_anomaly * kRadiansToDegrees;
  elements->gm = opm->GM();

  return finite(elements->semi_major_axis) && finite(elements->eccentricity) &&
         finite(elements->inclination) && finite(elements->raan) &&
         finite(elements->arg_pericenter) && finite(elements->mean_anomaly) &&
         finite(elements->gm) && elements->eccentricity >= 0.0 && elements->gm > 0.0;
}

bool convert_opm_keplerian_to_cartesian(const OPM* opm, CartesianState* state) {
  KeplerianElements elements;
  if (!convert_opm_keplerian_to_elements(opm, &elements)) {
    return false;
  }

  return convert_keplerian_values_to_cartesian(
      elements.semi_major_axis,
      elements.eccentricity,
      elements.inclination * kDegreesToRadians,
      elements.raan * kDegreesToRadians,
      elements.arg_pericenter * kDegreesToRadians,
      elements.mean_anomaly * kDegreesToRadians,
      elements.gm,
      state);
}

bool convert_cartesian_to_keplerian(
    const CartesianState& state,
    double gm,
    KeplerianElements* elements,
    bool allow_parabolic = false) {
  if (elements == nullptr || !finite(gm) || gm <= 0.0) {
    return false;
  }

  const Vector3 position = {state.x, state.y, state.z};
  const Vector3 velocity = {state.x_dot, state.y_dot, state.z_dot};
  const double position_norm = norm(position);
  const double velocity_squared = dot(velocity, velocity);
  if (!(position_norm > 0.0) || !finite(position_norm) || !finite(velocity_squared)) {
    return false;
  }

  const Vector3 angular_momentum = cross(position, velocity);
  const double angular_momentum_norm = norm(angular_momentum);
  if (!(angular_momentum_norm > kSmall)) {
    return false;
  }

  const Vector3 node = {-angular_momentum.y, angular_momentum.x, 0.0};
  const double node_norm = norm(node);
  const Vector3 eccentricity_vector = subtract(
      scale(position, (velocity_squared - gm / position_norm) / gm),
      scale(velocity, dot(position, velocity) / gm));
  const double eccentricity = norm(eccentricity_vector);
  if (!finite(eccentricity)) {
    return false;
  }

  const double specific_energy = 0.5 * velocity_squared - gm / position_norm;
  const bool hyperbolic = eccentricity > 1.0 + kSingularOrbitTolerance;
  const bool parabolic = std::abs(eccentricity - 1.0) <= kSingularOrbitTolerance;
  if ((parabolic && !allow_parabolic) ||
      (hyperbolic && !(specific_energy > 0.0)) ||
      (!hyperbolic && !parabolic && !(specific_energy < 0.0))) {
    return false;
  }
  double semi_major_axis = 0.0;
  if (!parabolic) {
    semi_major_axis = -gm / (2.0 * specific_energy);
    if (!finite(semi_major_axis) ||
        (hyperbolic && !(semi_major_axis < 0.0)) ||
        (!hyperbolic && !(semi_major_axis > 0.0))) {
      return false;
    }
  }

  const double inclination = std::acos(clamp_unit(angular_momentum.z / angular_momentum_norm));
  const bool circular = !hyperbolic && eccentricity <= kSingularOrbitTolerance;
  const bool equatorial = node_norm <= kSingularOrbitTolerance;

  double raan = 0.0;
  double arg_pericenter = 0.0;
  double mean_anomaly = 0.0;

  if (!equatorial) {
    raan = normalize_radians(std::atan2(node.y, node.x));
  }

  if (!circular) {
    if (!equatorial) {
      const double arg_pericenter_cos =
          clamp_unit(dot(node, eccentricity_vector) / (node_norm * eccentricity));
      const double arg_pericenter_sin =
          dot(cross(node, eccentricity_vector), angular_momentum) /
          (node_norm * eccentricity * angular_momentum_norm);
      arg_pericenter = normalize_radians(std::atan2(arg_pericenter_sin, arg_pericenter_cos));
    } else {
      arg_pericenter = normalize_radians(std::atan2(eccentricity_vector.y, eccentricity_vector.x));
    }

    const double true_anomaly_cos =
        clamp_unit(dot(eccentricity_vector, position) / (eccentricity * position_norm));
    const double true_anomaly_sin =
        dot(cross(eccentricity_vector, position), angular_momentum) /
        (eccentricity * position_norm * angular_momentum_norm);
    const double true_anomaly = std::atan2(true_anomaly_sin, true_anomaly_cos);
    const double anomaly_denominator = 1.0 + eccentricity * std::cos(true_anomaly);
    if (std::abs(anomaly_denominator) <= kSmall) {
      return false;
    }
    if (parabolic) {
      mean_anomaly = true_anomaly;
    } else if (hyperbolic) {
      const double tanh_argument =
          std::sqrt(eccentricity * eccentricity - 1.0) * std::sin(true_anomaly) /
          (eccentricity + std::cos(true_anomaly));
      if (std::abs(tanh_argument) >= 1.0) {
        return false;
      }
      const double hyperbolic_anomaly = std::atanh(tanh_argument);
      mean_anomaly = eccentricity * std::sinh(hyperbolic_anomaly) - hyperbolic_anomaly;
    } else {
      const double normalized_true_anomaly = normalize_radians(true_anomaly);
      const double eccentric_anomaly = std::atan2(
          std::sqrt(1.0 - eccentricity * eccentricity) * std::sin(normalized_true_anomaly) / anomaly_denominator,
          (eccentricity + std::cos(normalized_true_anomaly)) / anomaly_denominator);
      mean_anomaly = normalize_radians(
          eccentric_anomaly - eccentricity * std::sin(eccentric_anomaly));
    }
  } else if (!equatorial) {
    const double argument_of_latitude_cos = clamp_unit(dot(node, position) / (node_norm * position_norm));
    const double argument_of_latitude_sin =
        dot(cross(node, position), angular_momentum) /
        (node_norm * position_norm * angular_momentum_norm);
    mean_anomaly = normalize_radians(std::atan2(argument_of_latitude_sin, argument_of_latitude_cos));
  } else {
    mean_anomaly = angular_momentum.z >= 0.0
                       ? normalize_radians(std::atan2(position.y, position.x))
                       : normalize_radians(std::atan2(-position.y, position.x));
  }

  elements->semi_major_axis = parabolic ? 0.0 : semi_major_axis;
  elements->eccentricity = parabolic ? 1.0 : (circular ? 0.0 : eccentricity);
  elements->inclination = normalize_degrees(inclination);
  elements->raan = normalize_degrees(raan);
  elements->arg_pericenter = normalize_degrees(arg_pericenter);
  elements->mean_anomaly =
      (hyperbolic || parabolic) ? mean_anomaly * kRadiansToDegrees : normalize_degrees(mean_anomaly);
  elements->gm = gm;
  elements->periapsis_radius =
      finite(angular_momentum_norm) && angular_momentum_norm > 0.0
          ? (angular_momentum_norm * angular_momentum_norm / gm) /
                (1.0 + elements->eccentricity)
          : 0.0;

  return finite(elements->semi_major_axis) && finite(elements->eccentricity) &&
         finite(elements->inclination) && finite(elements->raan) &&
         finite(elements->arg_pericenter) && finite(elements->mean_anomaly);
}

bool normalize_parabolic_recovered_elements_to_omm(KeplerianElements* elements) {
  if (elements == nullptr) {
    return false;
  }
  const bool parabolic =
      std::abs(elements->eccentricity - 1.0) <= kSingularOrbitTolerance &&
      std::abs(elements->semi_major_axis) <= kSingularOrbitTolerance;
  if (!parabolic) {
    return true;
  }

  double mean_anomaly = 0.0;
  if (!mean_anomaly_from_true_anomaly(
          elements->mean_anomaly * kDegreesToRadians,
          elements->eccentricity,
          &mean_anomaly)) {
    return false;
  }
  elements->semi_major_axis = 0.0;
  elements->eccentricity = 1.0;
  elements->mean_anomaly = mean_anomaly * kRadiansToDegrees;
  return finite(elements->mean_anomaly);
}

bool record_true_anomaly_from_anomaly(
    double anomaly,
    double eccentricity,
    int8_t anomaly_type,
    double* true_anomaly) {
  if (true_anomaly == nullptr || !finite(anomaly) || !finite(eccentricity)) {
    return false;
  }
  if (anomaly_type == 0) {
    *true_anomaly = anomaly;
    return true;
  }
  if (anomaly_type != 1 || eccentricity < 0.0 || eccentricity >= 1.0) {
    return false;
  }

  double eccentric_anomaly = 0.0;
  if (!solve_eccentric_anomaly(anomaly, eccentricity, &eccentric_anomaly)) {
    return false;
  }

  *true_anomaly = 2.0 * std::atan2(
      std::sqrt(1.0 + eccentricity) * std::sin(eccentric_anomaly / 2.0),
      std::sqrt(1.0 - eccentricity) * std::cos(eccentric_anomaly / 2.0));
  return finite(*true_anomaly);
}

bool record_mean_anomaly_from_anomaly(
    double anomaly,
    double eccentricity,
    int8_t anomaly_type,
    double* mean_anomaly) {
  if (mean_anomaly == nullptr || !finite(anomaly) || !finite(eccentricity) ||
      eccentricity < 0.0) {
    return false;
  }
  if (anomaly_type == 1) {
    *mean_anomaly = eccentricity < 1.0 ? normalize_radians(anomaly) : anomaly;
    return finite(*mean_anomaly);
  }
  if (anomaly_type != 0) {
    return false;
  }
  return mean_anomaly_from_true_anomaly(anomaly, eccentricity, mean_anomaly);
}

bool eccentric_anomaly_from_true_anomaly(
    double true_anomaly,
    double eccentricity,
    double* eccentric_anomaly) {
  if (eccentric_anomaly == nullptr || !finite(true_anomaly) || !finite(eccentricity) ||
      eccentricity < 0.0 || eccentricity >= 1.0) {
    return false;
  }
  *eccentric_anomaly = 2.0 * std::atan2(
      std::sqrt(1.0 - eccentricity) * std::sin(true_anomaly / 2.0),
      std::sqrt(1.0 + eccentricity) * std::cos(true_anomaly / 2.0));
  return finite(*eccentric_anomaly);
}

bool true_anomaly_from_eccentric_anomaly(
    double eccentric_anomaly,
    double eccentricity,
    double* true_anomaly) {
  if (true_anomaly == nullptr || !finite(eccentric_anomaly) || !finite(eccentricity) ||
      eccentricity < 0.0 || eccentricity >= 1.0) {
    return false;
  }
  *true_anomaly = 2.0 * std::atan2(
      std::sqrt(1.0 + eccentricity) * std::sin(eccentric_anomaly / 2.0),
      std::sqrt(1.0 - eccentricity) * std::cos(eccentric_anomaly / 2.0));
  return finite(*true_anomaly);
}

bool convert_record_mean_osc_map(
    const ElementRecord& source,
    const GRV* gravity,
    double direction_sign,
    ElementRecord* elements) {
  if (gravity == nullptr || elements == nullptr) {
    return false;
  }
  if (direction_sign != 1.0 && direction_sign != -1.0) {
    return false;
  }

  const double a = source.semi_major_axis;
  const double e = source.eccentricity;
  const double i = source.inclination * kDegreesToRadians;
  const double Omega = source.raan * kDegreesToRadians;
  const double omega = source.arg_pericenter * kDegreesToRadians;
  const double anomaly = source.anomaly * kDegreesToRadians;
  const double req = gravity->EQUATORIAL_RADIUS();
  const double J2 = gravity->J2();

  if (!finite(a) || !finite(e) || !finite(i) || !finite(Omega) || !finite(omega) ||
      !finite(anomaly) || !finite(req) || !finite(J2) || !(a > 0.0) ||
      !(req > 0.0) || e < 0.0 || e >= 1.0) {
    return false;
  }

  double f = 0.0;
  if (!record_true_anomaly_from_anomaly(anomaly, e, source.anomaly_type, &f)) {
    return false;
  }

  double E = 0.0;
  if (!eccentric_anomaly_from_true_anomaly(f, e, &E)) {
    return false;
  }
  const double M = E - e * std::sin(E);

  const double cos_i = std::cos(i);
  const double sin_i = std::sin(i);
  const double tan_i = std::tan(i);
  const double cos_i2 = cos_i * cos_i;
  const double cos_i4 = cos_i2 * cos_i2;
  const double cos_i6 = cos_i4 * cos_i2;
  const double critical_denom = 1.0 - 5.0 * cos_i2;
  const double e2 = e * e;
  const double eta2 = 1.0 - e2;
  if (!(eta2 > 0.0) || std::abs(tan_i) <= kSmall ||
      std::abs(critical_denom) <= kSmall) {
    return false;
  }

  const double eta = std::sqrt(eta2);
  const double gamma2 = direction_sign * J2 / 2.0 * std::pow(req / a, 2.0);
  const double gamma2p = gamma2 / std::pow(eta, 4.0);
  const double cos_f = std::cos(f);
  const double sin_f = std::sin(f);
  const double a_r = (1.0 + e * cos_f) / eta2;
  const double a_r3 = std::pow(a_r, 3.0);
  const double eta3 = std::pow(eta, 3.0);
  const double eta6 = std::pow(eta, 6.0);
  const double two_omega = 2.0 * omega;
  const double two_omega_two_f = two_omega + 2.0 * f;
  const double two_omega_f = two_omega + f;
  const double two_omega_three_f = two_omega + 3.0 * f;
  const double sin_i2 = 1.0 - cos_i2;
  const double cos_2omega = std::cos(two_omega);
  const double sin_2omega = std::sin(two_omega);

  const double ap = a + a * gamma2 *
      ((3.0 * cos_i2 - 1.0) * (a_r3 - 1.0 / eta3) +
       3.0 * sin_i2 * a_r3 * std::cos(two_omega_two_f));

  const double de1 = gamma2p / 8.0 * e * eta2 *
      (1.0 - 11.0 * cos_i2 - 40.0 * cos_i4 / critical_denom) *
      cos_2omega;

  const double de = de1 + eta2 / 2.0 *
      (gamma2 *
           ((3.0 * cos_i2 - 1.0) / eta6 *
                (e * eta + e / (1.0 + eta) + 3.0 * cos_f +
                 3.0 * e * cos_f * cos_f + e2 * cos_f * cos_f * cos_f) +
            3.0 * sin_i2 / eta6 *
                (e + 3.0 * cos_f + 3.0 * e * cos_f * cos_f +
                 e2 * cos_f * cos_f * cos_f) *
                std::cos(two_omega_two_f)) -
       gamma2p * sin_i2 *
           (3.0 * std::cos(two_omega_f) + std::cos(two_omega_three_f)));

  const double di = -e * de1 / eta2 / tan_i +
      gamma2p / 2.0 * cos_i * sin_i *
          (3.0 * std::cos(two_omega_two_f) + 3.0 * e * std::cos(two_omega_f) +
           e * std::cos(two_omega_three_f));

  const double f_minus_m_plus_e_sin_f = f - M + e * sin_f;
  const double MpopOp = M + omega + Omega +
      gamma2p / 8.0 * eta3 *
          (1.0 - 11.0 * cos_i2 - 40.0 * cos_i4 / critical_denom) *
          sin_2omega -
      gamma2p / 16.0 *
          (2.0 + e2 - 11.0 * (2.0 + 3.0 * e2) * cos_i2 -
           40.0 * (2.0 + 5.0 * e2) * cos_i4 / critical_denom -
           400.0 * e2 * cos_i6 / (critical_denom * critical_denom)) *
          sin_2omega +
      gamma2p / 4.0 *
          (-6.0 * (1.0 - 5.0 * cos_i2) * f_minus_m_plus_e_sin_f +
           (3.0 - 5.0 * cos_i2) *
               (3.0 * std::sin(two_omega_two_f) +
                3.0 * e * std::sin(two_omega_f) +
                e * std::sin(two_omega_three_f))) -
      gamma2p / 8.0 * e2 * cos_i *
          (11.0 + 80.0 * cos_i2 / critical_denom +
           200.0 * cos_i4 / (critical_denom * critical_denom)) *
          sin_2omega -
      gamma2p / 2.0 * cos_i *
          (6.0 * f_minus_m_plus_e_sin_f -
           3.0 * std::sin(two_omega_two_f) -
           3.0 * e * std::sin(two_omega_f) -
           e * std::sin(two_omega_three_f));

  const double edM = gamma2p / 8.0 * e * eta3 *
          (1.0 - 11.0 * cos_i2 - 40.0 * cos_i4 / critical_denom) *
          sin_2omega -
      gamma2p / 4.0 * eta3 *
          (2.0 * (3.0 * cos_i2 - 1.0) *
               (std::pow(a_r * eta, 2.0) + a_r + 1.0) * sin_f +
           3.0 * sin_i2 *
               ((-std::pow(a_r * eta, 2.0) - a_r + 1.0) *
                    std::sin(two_omega_f) +
                (std::pow(a_r * eta, 2.0) + a_r + 1.0 / 3.0) *
                    std::sin(two_omega_three_f)));

  const double dOmega = -gamma2p / 8.0 * e2 * cos_i *
          (11.0 + 80.0 * cos_i2 / critical_denom +
           200.0 * cos_i4 / (critical_denom * critical_denom)) *
          sin_2omega -
      gamma2p / 2.0 * cos_i *
          (6.0 * f_minus_m_plus_e_sin_f -
           3.0 * std::sin(two_omega_two_f) -
           3.0 * e * std::sin(two_omega_f) -
           e * std::sin(two_omega_three_f));

  const double d1 = (e + de) * std::sin(M) + edM * std::cos(M);
  const double d2 = (e + de) * std::cos(M) - edM * std::sin(M);
  const double Mp = std::atan2(d1, d2);
  const double ep = std::sqrt(d1 * d1 + d2 * d2);
  if (!finite(ep) || ep < 0.0 || ep >= 1.0) {
    return false;
  }

  const double d3 = (std::sin(i / 2.0) + std::cos(i / 2.0) * di / 2.0) *
          std::sin(Omega) +
      std::sin(i / 2.0) * dOmega * std::cos(Omega);
  const double d4 = (std::sin(i / 2.0) + std::cos(i / 2.0) * di / 2.0) *
          std::cos(Omega) -
      std::sin(i / 2.0) * dOmega * std::sin(Omega);
  const double Omegap = std::atan2(d3, d4);
  const double ip = 2.0 * std::asin(clamp_unit(std::sqrt(d3 * d3 + d4 * d4)));
  const double omegap = MpopOp - Mp - Omegap;

  double Ep = 0.0;
  if (!solve_eccentric_anomaly(Mp, ep, &Ep)) {
    return false;
  }
  double fp = 0.0;
  if (!true_anomaly_from_eccentric_anomaly(Ep, ep, &fp)) {
    return false;
  }

  elements->semi_major_axis = ap;
  elements->eccentricity = ep;
  elements->inclination = normalize_degrees(ip);
  elements->raan = normalize_degrees(Omegap);
  elements->arg_pericenter = normalize_degrees(omegap);
  elements->anomaly = normalize_degrees(fp);
  elements->periapsis_radius = 0.0;
  elements->anomaly_type = 0;

  return finite(elements->semi_major_axis) && finite(elements->eccentricity) &&
         finite(elements->inclination) && finite(elements->raan) &&
         finite(elements->arg_pericenter) && finite(elements->anomaly);
}

bool convert_record_mean_to_osculating(
    const ElementRecord& source,
    const GRV* gravity,
    ElementRecord* elements) {
  return convert_record_mean_osc_map(source, gravity, 1.0, elements);
}

bool convert_record_osculating_to_mean(
    const ElementRecord& source,
    const GRV* gravity,
    ElementRecord* elements) {
  return convert_record_mean_osc_map(source, gravity, -1.0, elements);
}

bool compute_j_zonal_perturbation_acceleration(
    const CartesianState& state,
    const GRV* gravity,
    Vector3* acceleration) {
  if (gravity == nullptr || acceleration == nullptr) {
    return false;
  }

  const int declared_degree = static_cast<int>(gravity->MAX_DEGREE());
  const int order = declared_degree > 6 ? 6 : declared_degree;
  const double mu = gravity->MU();
  const double req = gravity->EQUATORIAL_RADIUS();
  const double j2 = gravity->J2();
  const double j3 = gravity->J3();
  const double j4 = gravity->J4();
  const double j5 = gravity->J5();
  const double j6 = gravity->J6();

  if (order < 2 || !finite(state.x) || !finite(state.y) || !finite(state.z) ||
      !finite(mu) || !finite(req) || !finite(j2) ||
      (order >= 3 && !finite(j3)) || (order >= 4 && !finite(j4)) ||
      (order >= 5 && !finite(j5)) || (order >= 6 && !finite(j6)) ||
      !(mu > 0.0) || !(req > 0.0)) {
    return false;
  }

  const double r = std::sqrt(state.x * state.x + state.y * state.y + state.z * state.z);
  if (!finite(r) || !(r > kSmall)) {
    return false;
  }

  const double inv_r = 1.0 / r;
  const double xr = state.x * inv_r;
  const double yr = state.y * inv_r;
  const double zr = state.z * inv_r;
  const double z2 = zr * zr;
  const double z3 = z2 * zr;
  const double z4 = z2 * z2;
  const double z5 = z4 * zr;
  const double z6 = z3 * z3;
  const double req_r = req * inv_r;
  const double mu_r2 = mu / (r * r);
  Vector3 total;

  if (order >= 2) {
    const double scale = -1.5 * j2 * mu_r2 * std::pow(req_r, 2.0);
    total.x += scale * (1.0 - 5.0 * z2) * xr;
    total.y += scale * (1.0 - 5.0 * z2) * yr;
    total.z += scale * (3.0 - 5.0 * z2) * zr;
  }
  if (order >= 3) {
    const double scale = 0.5 * j3 * mu_r2 * std::pow(req_r, 3.0);
    total.x += scale * 5.0 * (7.0 * z3 - 3.0 * zr) * xr;
    total.y += scale * 5.0 * (7.0 * z3 - 3.0 * zr) * yr;
    total.z += scale * -3.0 * (10.0 * z2 - (35.0 / 3.0) * z4 - 1.0);
  }
  if (order >= 4) {
    const double scale = 5.0 / 8.0 * j4 * mu_r2 * std::pow(req_r, 4.0);
    total.x += scale * (3.0 - 42.0 * z2 + 63.0 * z4) * xr;
    total.y += scale * (3.0 - 42.0 * z2 + 63.0 * z4) * yr;
    total.z += scale * (15.0 - 70.0 * z2 + 63.0 * z4) * zr;
  }
  if (order >= 5) {
    const double scale = 1.0 / 8.0 * j5 * mu_r2 * std::pow(req_r, 5.0);
    total.x += scale * 3.0 * (35.0 * zr - 210.0 * z3 + 231.0 * z5) * xr;
    total.y += scale * 3.0 * (35.0 * zr - 210.0 * z3 + 231.0 * z5) * yr;
    total.z += scale * -(15.0 - 315.0 * z2 + 945.0 * z4 - 693.0 * z6);
  }
  if (order >= 6) {
    const double scale = -1.0 / 16.0 * j6 * mu_r2 * std::pow(req_r, 6.0);
    total.x += scale * (35.0 - 945.0 * z2 + 3465.0 * z4 - 3003.0 * z6) * xr;
    total.y += scale * (35.0 - 945.0 * z2 + 3465.0 * z4 - 3003.0 * z6) * yr;
    total.z += scale * -(3003.0 * z6 - 4851.0 * z4 + 2205.0 * z2 - 245.0) * zr;
  }

  if (!finite(total.x) || !finite(total.y) || !finite(total.z)) {
    return false;
  }

  *acceleration = total;
  return true;
}

bool compute_solar_radiation_pressure_acceleration(
    double mass,
    double area,
    double coefficient,
    const CRD* sun_vector,
    Vector3* acceleration) {
  if (sun_vector == nullptr || acceleration == nullptr) {
    return false;
  }

  const Vector3 sun = {
      sun_vector->X(),
      sun_vector->Y(),
      sun_vector->Z(),
  };
  const double sun_distance = norm(sun);

  if (!finite(area) || !finite(mass) || !finite(coefficient) ||
      !finite(sun.x) || !finite(sun.y) || !finite(sun.z) ||
      !(area > 0.0) || !(mass > 0.0) || !(coefficient > 0.0) ||
      !finite(sun_distance) || !(sun_distance > kSmall)) {
    return false;
  }

  const double acceleration_scale =
      (-coefficient * area * kBasiliskSolarFlux) /
      (mass * kSpeedOfLightMetersPerSecond * std::pow(sun_distance, 3.0)) /
      1000.0;

  *acceleration = scale(sun, acceleration_scale);
  return finite(acceleration->x) && finite(acceleration->y) &&
         finite(acceleration->z);
}

bool record_shape_supports_anomaly_conversion(
    const ElementRecord& source) {
  return (source.semi_major_axis > 0.0 &&
          source.eccentricity >= 0.0 &&
          source.eccentricity < 1.0) ||
         (source.semi_major_axis < 0.0 &&
          source.eccentricity > 1.0) ||
         (std::abs(source.semi_major_axis) <= kSmall &&
          std::abs(source.eccentricity - 1.0) <= kSingularOrbitTolerance &&
          source.periapsis_radius > 0.0);
}

bool normalize_record_to_mean_anomaly(
    const ElementRecord& source,
    ElementRecord* elements) {
  if (elements == nullptr || !record_shape_supports_anomaly_conversion(source)) {
    return false;
  }

  double mean_anomaly = 0.0;
  if (!record_mean_anomaly_from_anomaly(
          source.anomaly * kDegreesToRadians,
          source.eccentricity,
          source.anomaly_type,
          &mean_anomaly)) {
    return false;
  }

  *elements = source;
  elements->anomaly_type = 1;
  elements->anomaly = source.eccentricity < 1.0
                          ? normalize_degrees(mean_anomaly)
                          : mean_anomaly * kRadiansToDegrees;
  return finite(elements->anomaly);
}

bool normalize_record_to_true_anomaly(
    const ElementRecord& source,
    ElementRecord* elements) {
  if (elements == nullptr || !record_shape_supports_anomaly_conversion(source)) {
    return false;
  }

  double true_anomaly = 0.0;
  if (source.anomaly_type == 0) {
    true_anomaly = source.anomaly * kDegreesToRadians;
  } else if (source.anomaly_type == 1) {
    if (!true_anomaly_from_mean_anomaly(
            source.anomaly * kDegreesToRadians,
            source.eccentricity,
            &true_anomaly)) {
      return false;
    }
  } else {
    return false;
  }

  *elements = source;
  elements->anomaly_type = 0;
  elements->anomaly = source.eccentricity < 1.0
                          ? normalize_degrees(true_anomaly)
                          : true_anomaly * kRadiansToDegrees;
  return finite(elements->anomaly);
}

bool convert_record_to_omm(
    const ElementRecord& source,
    double gm,
    KeplerianElements* elements) {
  if (elements == nullptr || !finite(gm) || gm <= 0.0) {
    return false;
  }
  const bool parabolic =
      std::abs(source.semi_major_axis) <= kSmall &&
      std::abs(source.eccentricity - 1.0) <= kSingularOrbitTolerance &&
      source.periapsis_radius > 0.0;

  double mean_anomaly = 0.0;
  if (!record_mean_anomaly_from_anomaly(
          source.anomaly * kDegreesToRadians,
          source.eccentricity,
          source.anomaly_type,
          &mean_anomaly)) {
    return false;
  }

  elements->semi_major_axis = parabolic ? 0.0 : source.semi_major_axis;
  elements->eccentricity = parabolic ? 1.0 : source.eccentricity;
  elements->inclination = source.inclination;
  elements->raan = normalize_degrees(source.raan * kDegreesToRadians);
  elements->arg_pericenter = normalize_degrees(source.arg_pericenter * kDegreesToRadians);
  elements->mean_anomaly = mean_anomaly * kRadiansToDegrees;
  elements->gm = gm;

  return finite(elements->semi_major_axis) && finite(elements->eccentricity) &&
         finite(elements->inclination) && finite(elements->raan) &&
         finite(elements->arg_pericenter) && finite(elements->mean_anomaly) &&
         finite(elements->gm) &&
         ((elements->semi_major_axis > 0.0 &&
           elements->eccentricity >= 0.0 &&
           elements->eccentricity < 1.0) ||
          (elements->semi_major_axis < 0.0 &&
           elements->eccentricity > 1.0) ||
          parabolic);
}

bool convert_record_to_cartesian(
    const ElementRecord& source,
    double gm,
    CartesianState* state) {
  if (state == nullptr || !finite(gm) || gm <= 0.0) {
    return false;
  }

  if (source.anomaly_type == 0 &&
      std::abs(source.eccentricity - 1.0) <= kSingularOrbitTolerance &&
      std::abs(source.semi_major_axis) > kSmall) {
    return convert_rectilinear_anomaly_values_to_cartesian(
        source.semi_major_axis,
        source.eccentricity,
        source.inclination * kDegreesToRadians,
        source.raan * kDegreesToRadians,
        source.arg_pericenter * kDegreesToRadians,
        source.anomaly * kDegreesToRadians,
        gm,
        state);
  }

  if (source.anomaly_type == 0 &&
      std::abs(source.eccentricity - 1.0) <= kSingularOrbitTolerance &&
      std::abs(source.semi_major_axis) <= kSmall) {
    return convert_parabolic_true_anomaly_values_to_cartesian(
        source.periapsis_radius,
        source.eccentricity,
        source.inclination * kDegreesToRadians,
        source.raan * kDegreesToRadians,
        source.arg_pericenter * kDegreesToRadians,
        source.anomaly * kDegreesToRadians,
        gm,
        state);
  }

  if (source.anomaly_type == 1 &&
      std::abs(source.eccentricity - 1.0) <= kSingularOrbitTolerance &&
      std::abs(source.semi_major_axis) <= kSmall) {
    double true_anomaly = 0.0;
    if (!true_anomaly_from_parabolic_mean_anomaly(
            source.anomaly * kDegreesToRadians,
            &true_anomaly)) {
      return false;
    }
    return convert_parabolic_true_anomaly_values_to_cartesian(
        source.periapsis_radius,
        source.eccentricity,
        source.inclination * kDegreesToRadians,
        source.raan * kDegreesToRadians,
        source.arg_pericenter * kDegreesToRadians,
        true_anomaly,
        gm,
        state);
  }

  double mean_anomaly = 0.0;
  if (!record_mean_anomaly_from_anomaly(
          source.anomaly * kDegreesToRadians,
          source.eccentricity,
          source.anomaly_type,
          &mean_anomaly)) {
    return false;
  }

  return convert_keplerian_values_to_cartesian(
      source.semi_major_axis,
      source.eccentricity,
      source.inclination * kDegreesToRadians,
      source.raan * kDegreesToRadians,
      source.arg_pericenter * kDegreesToRadians,
      mean_anomaly,
      gm,
      state);
}

const plugin_input_frame_t* find_input_frame(const char* port_id) {
  const uint32_t input_count = plugin_get_input_count();
  for (uint32_t index = 0; index < input_count; ++index) {
    const plugin_input_frame_t* frame = plugin_get_input_frame(index);
    if (frame != nullptr && frame->port_id != nullptr && std::strcmp(frame->port_id, port_id) == 0) {
      return frame;
    }
  }
  return nullptr;
}

const char* flatbuffer_string_or_null(const ::flatbuffers::String* value) {
  return value == nullptr ? nullptr : value->c_str();
}

::flatbuffers::Offset<::flatbuffers::String> create_optional_string(
    ::flatbuffers::FlatBufferBuilder& builder,
    const char* value) {
  return value == nullptr ? 0 : builder.CreateString(value);
}

int8_t timing_standard_from_string(const char* value) {
  if (value == nullptr || std::strcmp(value, "UTC") == 0) {
    return 11;
  }
  if (std::strcmp(value, "GPS") == 0) {
    return 1;
  }
  if (std::strcmp(value, "TAI") == 0) {
    return 5;
  }
  if (std::strcmp(value, "TT") == 0) {
    return 9;
  }
  if (std::strcmp(value, "UT1") == 0) {
    return 10;
  }
  if (std::strcmp(value, "TDB") == 0) {
    return 7;
  }
  if (std::strcmp(value, "TCB") == 0) {
    return 6;
  }
  if (std::strcmp(value, "TCG") == 0) {
    return 8;
  }
  if (std::strcmp(value, "GMST") == 0) {
    return 0;
  }
  if (std::strcmp(value, "MET") == 0) {
    return 2;
  }
  if (std::strcmp(value, "MRT") == 0) {
    return 3;
  }
  if (std::strcmp(value, "SCLK") == 0) {
    return 4;
  }
  return 11;
}

int emit_oem(const OMM* omm, const CartesianState& state) {
  ::flatbuffers::FlatBufferBuilder builder(1024);

  const char* epoch = flatbuffer_string_or_null(omm->EPOCH());
  const char* center = flatbuffer_string_or_null(omm->CENTER_NAME());
  const char* creation_date = flatbuffer_string_or_null(omm->CREATION_DATE());

  const auto epoch_offset = create_optional_string(builder, epoch);
  const auto center_offset = create_optional_string(builder, center != nullptr ? center : "EARTH");
  const auto line = BuildOemLine(
      builder,
      epoch_offset,
      state.x,
      state.y,
      state.z,
      state.x_dot,
      state.y_dot,
      state.z_dot);
  const std::vector<::flatbuffers::Offset<ephemerisDataLine>> line_entries = {line};
  const auto line_vector = builder.CreateVector(line_entries);
  const auto block_comment = builder.CreateString("Generated from SDS OMM Keplerian mean elements.");
  const auto block = BuildOemBlock(
      builder,
      block_comment,
      center_offset,
      static_cast<int8_t>(omm->TIME_SYSTEM()),
      epoch_offset,
      epoch_offset,
      line_vector);
  const std::vector<::flatbuffers::Offset<ephemerisDataBlock>> block_entries = {block};
  const auto block_vector = builder.CreateVector(block_entries);
  const auto classification = builder.CreateString("U");
  const auto creation_offset = create_optional_string(
      builder,
      creation_date != nullptr ? creation_date : "2026-05-24T00:00:00Z");
  const auto originator = builder.CreateString("DigitalArsenal foundation/orbits");
  const auto oem = BuildOem(builder, classification, 2.0, creation_offset, originator, block_vector);
  builder.Finish(oem, "$OEM");

  if (plugin_push_output(
          "cartesian_state",
          "OEM.fbs",
          "$OEM",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit OEM Cartesian state.");
    return 1;
  }
  return 0;
}

int emit_oem_from_opm(const OPM* opm, const CartesianState& state) {
  if (opm == nullptr) {
    plugin_set_error("missing-opm", "No OPM input was provided.");
    return 3;
  }

  ::flatbuffers::FlatBufferBuilder builder(1024);

  const char* epoch = flatbuffer_string_or_null(opm->EPOCH());
  const char* center = flatbuffer_string_or_null(opm->CENTER_NAME());
  const char* creation_date = flatbuffer_string_or_null(opm->CREATION_DATE());
  const int8_t time_system = timing_standard_from_string(flatbuffer_string_or_null(opm->TIME_SYSTEM()));

  const auto epoch_offset = create_optional_string(builder, epoch);
  const auto center_offset = create_optional_string(builder, center != nullptr ? center : "EARTH");
  const auto line = BuildOemLine(
      builder,
      epoch_offset,
      state.x,
      state.y,
      state.z,
      state.x_dot,
      state.y_dot,
      state.z_dot);
  const std::vector<::flatbuffers::Offset<ephemerisDataLine>> line_entries = {line};
  const auto line_vector = builder.CreateVector(line_entries);
  const auto block_comment = builder.CreateString("Generated from SDS OPM Cartesian state.");
  const auto block = BuildOemBlock(
      builder,
      block_comment,
      center_offset,
      time_system,
      epoch_offset,
      epoch_offset,
      line_vector);
  const std::vector<::flatbuffers::Offset<ephemerisDataBlock>> block_entries = {block};
  const auto block_vector = builder.CreateVector(block_entries);
  const auto classification = builder.CreateString("U");
  const auto creation_offset = create_optional_string(
      builder,
      creation_date != nullptr ? creation_date : "2026-05-24T00:00:00Z");
  const auto originator = builder.CreateString("DigitalArsenal foundation/orbits");
  const auto oem = BuildOem(builder, classification, 2.0, creation_offset, originator, block_vector);
  builder.Finish(oem, "$OEM");

  if (plugin_push_output(
          "cartesian_state",
          "OEM.fbs",
          "$OEM",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit OEM Cartesian state.");
    return 1;
  }
  return 0;
}

bool extract_cdm_relative_state(const CDM* cdm, RelativeHillState* relative) {
  if (cdm == nullptr || relative == nullptr) {
    return false;
  }

  relative->position = {
      cdm->RELATIVE_POSITION_R(),
      cdm->RELATIVE_POSITION_T(),
      cdm->RELATIVE_POSITION_N(),
  };
  relative->velocity = {
      cdm->RELATIVE_VELOCITY_R(),
      cdm->RELATIVE_VELOCITY_T(),
      cdm->RELATIVE_VELOCITY_N(),
  };
  relative->miss_distance = cdm->MISS_DISTANCE();
  relative->relative_speed = cdm->RELATIVE_SPEED();

  return finite(relative->position.x) && finite(relative->position.y) &&
         finite(relative->position.z) && finite(relative->velocity.x) &&
         finite(relative->velocity.y) && finite(relative->velocity.z) &&
         finite(relative->miss_distance) && finite(relative->relative_speed);
}

bool extract_oem_state(const OEM* oem, CartesianState* state, OemMetadata* metadata) {
  if (oem == nullptr || state == nullptr || metadata == nullptr) {
    return false;
  }
  const auto blocks = oem->EPHEMERIS_DATA_BLOCK();
  if (blocks == nullptr || blocks->size() == 0) {
    return false;
  }
  const ephemerisDataBlock* block = blocks->Get(0);
  if (block == nullptr) {
    return false;
  }
  const auto lines = block->EPHEMERIS_DATA_LINES();
  if (lines == nullptr || lines->size() == 0) {
    return false;
  }
  const ephemerisDataLine* line = lines->Get(0);
  if (line == nullptr) {
    return false;
  }

  state->x = line->X();
  state->y = line->Y();
  state->z = line->Z();
  state->x_dot = line->X_DOT();
  state->y_dot = line->Y_DOT();
  state->z_dot = line->Z_DOT();
  if (!finite(state->x) || !finite(state->y) || !finite(state->z) ||
      !finite(state->x_dot) || !finite(state->y_dot) || !finite(state->z_dot)) {
    return false;
  }

  metadata->epoch = flatbuffer_string_or_null(line->EPOCH());
  if (metadata->epoch == nullptr) {
    metadata->epoch = flatbuffer_string_or_null(block->START_TIME());
  }
  metadata->center_name = flatbuffer_string_or_null(block->CENTER_NAME());
  metadata->time_system = static_cast<int8_t>(block->TIME_SYSTEM());
  return true;
}

bool extract_opm_metadata(const OPM* opm, OemMetadata* metadata) {
  if (opm == nullptr || metadata == nullptr) {
    return false;
  }

  metadata->epoch = flatbuffer_string_or_null(opm->EPOCH());
  metadata->center_name = flatbuffer_string_or_null(opm->CENTER_NAME());
  metadata->time_system = timing_standard_from_string(flatbuffer_string_or_null(opm->TIME_SYSTEM()));
  return true;
}

bool extract_opm_state(const OPM* opm, CartesianState* state, OemMetadata* metadata) {
  if (opm == nullptr || state == nullptr || metadata == nullptr) {
    return false;
  }

  state->x = opm->X();
  state->y = opm->Y();
  state->z = opm->Z();
  state->x_dot = opm->X_DOT();
  state->y_dot = opm->Y_DOT();
  state->z_dot = opm->Z_DOT();
  if (!finite(state->x) || !finite(state->y) || !finite(state->z) ||
      !finite(state->x_dot) || !finite(state->y_dot) || !finite(state->z_dot)) {
    return false;
  }

  return extract_opm_metadata(opm, metadata);
}

int emit_omm(
    const OMM* context,
    const OemMetadata& metadata,
    const KeplerianElements& elements) {
  ::flatbuffers::FlatBufferBuilder builder(1024);

  const char* context_center = context ? flatbuffer_string_or_null(context->CENTER_NAME()) : nullptr;
  const char* center = metadata.center_name != nullptr ? metadata.center_name : context_center;
  const char* epoch = metadata.epoch != nullptr
                          ? metadata.epoch
                          : (context ? flatbuffer_string_or_null(context->EPOCH()) : nullptr);
  const int8_t time_system = metadata.time_system != 0
                                 ? metadata.time_system
                                 : (context ? static_cast<int8_t>(context->TIME_SYSTEM()) : static_cast<int8_t>(11));

  const auto creation_date = create_optional_string(
      builder,
      context && context->CREATION_DATE() ? context->CREATION_DATE()->c_str() : "2026-05-24T00:00:00Z");
  const auto originator = builder.CreateString("DigitalArsenal foundation/orbits");
  const auto object_name = create_optional_string(
      builder,
      context ? flatbuffer_string_or_null(context->OBJECT_NAME()) : nullptr);
  const auto object_id = create_optional_string(
      builder,
      context ? flatbuffer_string_or_null(context->OBJECT_ID()) : nullptr);
  const auto center_name = create_optional_string(builder, center != nullptr ? center : "EARTH");
  const auto comment = builder.CreateString("Generated from SDS OEM Cartesian state and SDS OMM gravity context.");
  const auto epoch_offset = create_optional_string(builder, epoch);

  const auto omm = BuildOmmElements(
      builder,
      creation_date,
      originator,
      object_name,
      object_id,
      center_name,
      time_system,
      context ? static_cast<int8_t>(context->MEAN_ELEMENT_THEORY()) : static_cast<int8_t>(2),
      comment,
      epoch_offset,
      elements.semi_major_axis,
      elements.eccentricity,
      elements.inclination,
      elements.raan,
      elements.arg_pericenter,
      elements.mean_anomaly,
      elements.gm);
  builder.Finish(omm, "$OMM");

  if (plugin_push_output(
          "mean_elements",
          "OMM.fbs",
          "$OMM",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit OMM mean elements.");
    return 1;
  }
  return 0;
}

int emit_omm_from_opm(
    const OPM* opm,
    const OemMetadata& metadata,
    const KeplerianElements& elements) {
  if (opm == nullptr) {
    plugin_set_error("missing-opm", "No OPM input was provided.");
    return 3;
  }

  ::flatbuffers::FlatBufferBuilder builder(1024);

  const char* center = metadata.center_name != nullptr ? metadata.center_name : "EARTH";
  const char* epoch = metadata.epoch != nullptr ? metadata.epoch : flatbuffer_string_or_null(opm->EPOCH());

  const auto creation_date = create_optional_string(
      builder,
      opm->CREATION_DATE() ? opm->CREATION_DATE()->c_str() : "2026-05-24T00:00:00Z");
  const auto originator = builder.CreateString("DigitalArsenal foundation/orbits");
  const auto object_name = create_optional_string(builder, flatbuffer_string_or_null(opm->OBJECT_NAME()));
  const auto object_id = create_optional_string(builder, flatbuffer_string_or_null(opm->OBJECT_ID()));
  const auto center_name = create_optional_string(builder, center);
  const auto comment = builder.CreateString("Generated from SDS OPM Cartesian state.");
  const auto epoch_offset = create_optional_string(builder, epoch);

  const auto omm = BuildOmmElements(
      builder,
      creation_date,
      originator,
      object_name,
      object_id,
      center_name,
      metadata.time_system,
      2,
      comment,
      epoch_offset,
      elements.semi_major_axis,
      elements.eccentricity,
      elements.inclination,
      elements.raan,
      elements.arg_pericenter,
      elements.mean_anomaly,
      elements.gm);
  builder.Finish(omm, "$OMM");

  if (plugin_push_output(
          "mean_elements",
          "OMM.fbs",
          "$OMM",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit OMM mean elements.");
    return 1;
  }
  return 0;
}

int emit_cdm_relative_hill(
    const OCM* chief,
    const OCM* deputy,
    const OemMetadata& metadata,
    const RelativeHillState& relative) {
  if (chief == nullptr || deputy == nullptr) {
    plugin_set_error("missing-ocm", "Both chief and deputy OCM inputs are required.");
    return 3;
  }
  auto designator = [](const OCM* o) -> const char* {
    const Metadata* md = o->METADATA();
    if (md == nullptr) return nullptr;
    if (md->OBJECT_DESIGNATOR() != nullptr) return md->OBJECT_DESIGNATOR()->c_str();
    return flatbuffer_string_or_null(md->INTERNATIONAL_DESIGNATOR());
  };
  const char* chief_id = designator(chief);
  const char* deputy_id = designator(deputy);
  std::string message_id = "foundation-orbits-hill-relative";
  if (chief_id != nullptr || deputy_id != nullptr) {
    message_id = std::string(chief_id != nullptr ? chief_id : "chief") + "-to-" +
                 (deputy_id != nullptr ? deputy_id : "deputy");
  }

  ::flatbuffers::FlatBufferBuilder builder(1024);
  const Header* header = chief->HEADER();
  const auto creation_date = create_optional_string(
      builder, header != nullptr ? flatbuffer_string_or_null(header->CREATION_DATE()) : nullptr);
  const auto originator = builder.CreateString("DigitalArsenal foundation/orbits");
  const auto message_for = builder.CreateString("Basilisk Hill relative state");
  const auto message_id_offset = builder.CreateString(message_id);
  const auto tca = create_optional_string(builder, metadata.epoch);
  const auto cdm = BuildCdmRelativeState(
      builder,
      creation_date,
      originator,
      message_for,
      message_id_offset,
      tca,
      relative.miss_distance,
      relative.relative_speed,
      relative.position.x,
      relative.position.y,
      relative.position.z,
      relative.velocity.x,
      relative.velocity.y,
      relative.velocity.z);
  builder.Finish(cdm, "$CDM");

  if (plugin_push_output(
          "relative_state",
          "CDM.fbs",
          "$CDM",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit CDM relative Hill state.");
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// $OCM input and output. One trajectory row per message: CARTESIAN_PV, or a
// SANA Orbital Elements set (KEPLERIAN, KEPLERIAN_MEAN, EQUINOCTIAL,
// EQUINOCTIAL_MOD) in CCSDS 502.0-B-3 units: km, km/s and degrees. Epoch,
// time system, centre and reference frame are required and copied through;
// nothing is defaulted.
// ---------------------------------------------------------------------------

bool timing_standard_named(const char* value, timingStandard* out) {
  struct Row { const char* name; timingStandard value; };
  static const Row kRows[] = {
      {"UTC", timingStandard::UTC}, {"GPS", timingStandard::GPS}, {"TAI", timingStandard::TAI},
      {"TT", timingStandard::TT}, {"UT1", timingStandard::UT1}, {"TDB", timingStandard::TDB},
      {"TCB", timingStandard::TCB}, {"TCG", timingStandard::TCG}, {"GMST", timingStandard::GMST},
      {"MET", timingStandard::MET}, {"MRT", timingStandard::MRT}, {"SCLK", timingStandard::SCLK},
  };
  if (value == nullptr) return false;
  for (const Row& r : kRows) {
    if (std::strcmp(value, r.name) == 0) {
      *out = r.value;
      return true;
    }
  }
  return false;
}

struct OcmInput {
  std::vector<uint8_t> bytes;  // aligned copy of the frame
  const OCM* ocm = nullptr;
  OemMetadata metadata;
  timingStandard time_system = timingStandard::UTC;
  double gm = 0.0;             // km^3/s^2, PERTURBATIONS.GM
  std::vector<double> row;     // first STATE_DATA row
};

// Reads and checks one $OCM frame (plain or size-prefixed) on `port`.
int read_ocm_frame(const char* port, OcmInput* in) {
  const plugin_input_frame_t* frame = find_input_frame(port);
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 12) {
    const std::string message = std::string("No $OCM frame on port \"") + port + "\".";
    plugin_set_error("missing-ocm", message.c_str());
    return 3;
  }
  in->bytes.assign(frame->payload, frame->payload + frame->payload_length);
  if (OCMBufferHasIdentifier(in->bytes.data())) {
    ::flatbuffers::Verifier verifier(in->bytes.data(), in->bytes.size());
    if (VerifyOCMBuffer(verifier)) in->ocm = GetOCM(in->bytes.data());
  } else if (SizePrefixedOCMBufferHasIdentifier(in->bytes.data())) {
    ::flatbuffers::Verifier verifier(in->bytes.data(), in->bytes.size());
    if (VerifySizePrefixedOCMBuffer(verifier)) in->ocm = GetSizePrefixedOCM(in->bytes.data());
  }
  if (in->ocm == nullptr) {
    const std::string message = std::string("Port \"") + port + "\" does not carry a verifiable $OCM buffer.";
    plugin_set_error("invalid-ocm-buffer", message.c_str());
    return 3;
  }
  const OCM* o = in->ocm;
  const Metadata* md = o->METADATA();
  const char* epoch = md != nullptr ? flatbuffer_string_or_null(md->START_TIME()) : nullptr;
  if (epoch == nullptr && md != nullptr) epoch = flatbuffer_string_or_null(md->EPOCH_TZERO());
  if (epoch == nullptr) {
    plugin_set_error("missing-epoch", "OCM METADATA.START_TIME or EPOCH_TZERO is required.");
    return 3;
  }
  if (md == nullptr || !timing_standard_named(flatbuffer_string_or_null(md->TIME_SYSTEM()), &in->time_system)) {
    plugin_set_error("missing-time-system", "OCM METADATA.TIME_SYSTEM must name a supported time scale.");
    return 3;
  }
  if (o->CENTER_NAME() == nullptr || o->CENTER_NAME()->size() == 0) {
    plugin_set_error("missing-center", "OCM CENTER_NAME is required.");
    return 3;
  }
  if (o->TRAJ_REF_FRAME() == nullptr) {
    plugin_set_error("missing-frame", "OCM TRAJ_REF_FRAME is required.");
    return 3;
  }
  in->metadata.epoch = epoch;
  in->metadata.center_name = o->CENTER_NAME()->c_str();
  in->metadata.time_system = static_cast<int8_t>(in->time_system);
  in->gm = o->PERTURBATIONS() != nullptr ? o->PERTURBATIONS()->GM() : 0.0;
  const auto* data = o->STATE_DATA();
  const uint32_t width = o->STATE_VECTOR_SIZE();
  if (data == nullptr || width == 0 || data->size() < width) {
    plugin_set_error("missing-state-data", "OCM STATE_DATA must hold at least one row.");
    return 3;
  }
  in->row.assign(data->begin(), data->begin() + width);
  for (double v : in->row) {
    if (!finite(v)) {
      plugin_set_error("invalid-state-data", "OCM STATE_DATA must be finite.");
      return 3;
    }
  }
  return 0;
}

int read_ocm_cartesian(const char* port, OcmInput* in, CartesianState* state) {
  if (const int rc = read_ocm_frame(port, in)) return rc;
  if (in->ocm->TRAJ_TYPE() != trajectoryType::CARTESIAN_PV || in->row.size() != 6) {
    plugin_set_error("unsupported-trajectory-type", "Expected OCM TRAJ_TYPE CARTESIAN_PV with 6 values per row.");
    return 3;
  }
  state->x = in->row[0];
  state->y = in->row[1];
  state->z = in->row[2];
  state->x_dot = in->row[3];
  state->y_dot = in->row[4];
  state->z_dot = in->row[5];
  return 0;
}

// Any SANA element set onto the Keplerian record (km, degrees).
int read_ocm_elements(const char* port, OcmInput* in, ElementRecord* elements) {
  if (const int rc = read_ocm_frame(port, in)) return rc;
  const trajectoryType type = in->ocm->TRAJ_TYPE();
  const std::vector<double>& r = in->row;
  if ((type == trajectoryType::KEPLERIAN || type == trajectoryType::KEPLERIAN_MEAN) && r.size() == 6) {
    elements->semi_major_axis = r[0];
    elements->eccentricity = r[1];
    elements->inclination = r[2];
    elements->raan = r[3];
    elements->arg_pericenter = r[4];
    elements->anomaly = r[5];
    elements->periapsis_radius = 0.0;
    elements->anomaly_type = type == trajectoryType::KEPLERIAN ? 0 : 1;
    return 0;
  }
  if ((type == trajectoryType::EQUINOCTIAL || type == trajectoryType::EQUINOCTIAL_MOD) && r.size() == 7) {
    if (r[6] != 1.0 && r[6] != -1.0) {
      plugin_set_error("invalid-state-data", "The equinoctial retrograde factor must be +1 or -1.");
      return 3;
    }
    sdn::orbits::Keplerian kep;
    bool ok = false;
    if (type == trajectoryType::EQUINOCTIAL) {
      // SANA EQUINOCTIAL: a, af, ag, mean longitude, chi, psi, fr.
      sdn::orbits::Equinoctial eq;
      eq.semiMajorAxis = r[0] * 1000.0;
      eq.k = r[1];
      eq.h = r[2];
      eq.meanLongitude = r[3] * kDegreesToRadians;
      eq.p = r[4];
      eq.q = r[5];
      eq.retrogradeFactor = static_cast<int>(r[6]);
      ok = sdn::orbits::keplerianFromEquinoctial(eq, &kep);
    } else {
      // SANA EQUINOCTIALMOD: p, af, ag, true longitude, chi, psi, fr.
      sdn::orbits::ModifiedEquinoctial me;
      me.semiLatusRectum = r[0] * 1000.0;
      me.f = r[1];
      me.g = r[2];
      me.trueLongitude = r[3] * kDegreesToRadians;
      me.k = r[4];
      me.h = r[5];
      me.retrogradeFactor = static_cast<int>(r[6]);
      ok = sdn::orbits::keplerianFromModifiedEquinoctial(me, &kep);
    }
    if (!ok) {
      plugin_set_error("unsupported-orbit", "The equinoctial elements do not describe a finite orbit.");
      return 3;
    }
    // Undefined angles follow the Cartesian path: a circular orbit zeroes the
    // argument of periapsis and carries the argument of latitude; a circular
    // equatorial one also zeroes RAAN and carries the (retrograde) true longitude.
    double raan = kep.raan;
    double arg_pericenter = kep.argumentOfPeriapsis;
    double anomaly = kep.trueAnomaly;
    if (kep.eccentricity <= kSingularOrbitTolerance) {
      anomaly += arg_pericenter;
      arg_pericenter = 0.0;
      if (std::sin(kep.inclination) <= kSingularOrbitTolerance) {
        anomaly += kep.inclination < 0.5 * kPi ? raan : -raan;
        raan = 0.0;
      }
    }
    elements->semi_major_axis = kep.semiMajorAxis / 1000.0;
    elements->eccentricity = kep.eccentricity <= kSingularOrbitTolerance ? 0.0 : kep.eccentricity;
    elements->inclination = kep.inclination * kRadiansToDegrees;
    elements->raan = normalize_degrees(raan);
    elements->arg_pericenter = normalize_degrees(arg_pericenter);
    elements->anomaly = normalize_degrees(anomaly);
    elements->periapsis_radius = 0.0;
    elements->anomaly_type = 0;
    return 0;
  }
  plugin_set_error(
      "unsupported-trajectory-type",
      "Expected OCM TRAJ_TYPE KEPLERIAN or KEPLERIAN_MEAN (6 values) or EQUINOCTIAL or EQUINOCTIAL_MOD (7 values).");
  return 3;
}

// Writes the input $OCM back out with its trajectory replaced; header,
// identity, centre, frame, perturbations and physical properties are kept.
int emit_ocm_trajectory(
    const char* port,
    const OcmInput& in,
    trajectoryType type,
    const std::vector<double>& row,
    const char* averaging,
    const char* comment) {
  OCMT out;
  in.ocm->UnPackTo(&out);
  if (!out.COVARIANCE_DATA.empty()) {
    if (!out.HEADER) out.HEADER = std::make_unique<HeaderT>();
    out.HEADER->COMMENT.push_back("Input covariance not carried: it belongs to the input representation.");
  }
  out.TRAJ_TYPE = type;
  out.STATE_VECTOR_SIZE = static_cast<uint8_t>(row.size());
  out.STATE_DATA = row;
  out.STATE_STEP_SIZE = 0.0;
  out.COVARIANCE_DATA.clear();
  out.COV_REF_FRAME.reset();
  out.POLYNOMIAL_POSITION_RECORDS.clear();
  out.POLYNOMIAL_OE_RECORDS.clear();
  out.ORB_AVERAGING = averaging != nullptr ? averaging : "";
  if (!out.HEADER) out.HEADER = std::make_unique<HeaderT>();
  out.HEADER->COMMENT.push_back(comment);
  if (out.METADATA) out.METADATA->STOP_TIME = out.METADATA->START_TIME.empty()
                                                  ? out.METADATA->EPOCH_TZERO
                                                  : out.METADATA->START_TIME;

  ::flatbuffers::FlatBufferBuilder builder(2048);
  builder.FinishSizePrefixed(CreateOCM(builder, &out), OCMIdentifier());
  if (plugin_push_output_ex(port, "OCM.fbs", "$OCM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "OCM", 0, 0,
                            builder.GetBufferPointer(), static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit $OCM.");
    return 1;
  }
  return 0;
}

int emit_ocm_cartesian(const char* port, const OcmInput& in, const CartesianState& state, const char* comment) {
  return emit_ocm_trajectory(port, in, trajectoryType::CARTESIAN_PV,
                             {state.x, state.y, state.z, state.x_dot, state.y_dot, state.z_dot}, nullptr, comment);
}

// Keplerian record as SANA KEPLERIAN (true anomaly) or KEPLERIAN_MEAN.
int emit_ocm_keplerian(const char* port, const OcmInput& in, const ElementRecord& e,
                       const char* averaging, const char* comment) {
  return emit_ocm_trajectory(port, in,
                             e.anomaly_type == 0 ? trajectoryType::KEPLERIAN : trajectoryType::KEPLERIAN_MEAN,
                             {e.semi_major_axis, e.eccentricity, e.inclination, e.raan, e.arg_pericenter, e.anomaly},
                             averaging, comment);
}

// Keplerian record as SANA EQUINOCTIAL (mean longitude). fr = +1 for direct
// orbits and -1 for retrograde ones, each away from its singular inclination.
int emit_ocm_equinoctial(const char* port, const OcmInput& in, const ElementRecord& e, const char* comment) {
  double true_anomaly = e.anomaly * kDegreesToRadians;
  if (e.anomaly_type == 1 &&
      !true_anomaly_from_mean_anomaly(e.anomaly * kDegreesToRadians, e.eccentricity, &true_anomaly)) {
    plugin_set_error("unsupported-orbit", "Equinoctial output needs a finite elliptical orbit.");
    return 3;
  }
  sdn::orbits::Keplerian kep;
  kep.semiMajorAxis = e.semi_major_axis * 1000.0;
  kep.eccentricity = e.eccentricity;
  kep.inclination = e.inclination * kDegreesToRadians;
  kep.raan = e.raan * kDegreesToRadians;
  kep.argumentOfPeriapsis = e.arg_pericenter * kDegreesToRadians;
  kep.trueAnomaly = true_anomaly;
  const int fr = e.inclination > 90.0 ? -1 : 1;
  sdn::orbits::Equinoctial eq;
  if (!(e.semi_major_axis > 0.0) || e.eccentricity < 0.0 || e.eccentricity >= 1.0 ||
      !sdn::orbits::equinoctialFromKeplerian(kep, fr, &eq)) {
    plugin_set_error("unsupported-orbit", "Equinoctial output needs a finite elliptical orbit.");
    return 3;
  }
  return emit_ocm_trajectory(port, in, trajectoryType::EQUINOCTIAL,
                             {eq.semiMajorAxis / 1000.0, eq.k, eq.h, normalize_degrees(eq.meanLongitude), eq.p, eq.q,
                              static_cast<double>(fr)},
                             nullptr, comment);
}

// $OEM from an $OCM input: its epoch, time system, centre and frame.
int emit_oem_from_ocm(const OcmInput& in, const CartesianState& state, const char* comment,
                      const Vector3* acceleration = nullptr) {
  OEMT oem;
  oem.CCSDS_OEM_VERS = 2.0;
  oem.CLASSIFICATION = "U";
  if (in.ocm->HEADER() != nullptr && in.ocm->HEADER()->CREATION_DATE() != nullptr) {
    oem.CREATION_DATE = in.ocm->HEADER()->CREATION_DATE()->str();
  }
  oem.ORIGINATOR = "DigitalArsenal foundation/orbits";
  auto block = std::make_unique<ephemerisDataBlockT>();
  block->COMMENT = comment;
  block->CENTER_NAME = in.metadata.center_name;
  block->REFERENCE_FRAME = std::make_unique<RFMT>();
  in.ocm->TRAJ_REF_FRAME()->UnPackTo(block->REFERENCE_FRAME.get());
  block->TIME_SYSTEM = in.time_system;
  block->START_TIME = in.metadata.epoch;
  block->STOP_TIME = in.metadata.epoch;
  block->STATE_VECTOR_SIZE = acceleration != nullptr ? 9 : 6;
  auto line = std::make_unique<ephemerisDataLineT>();
  line->EPOCH = in.metadata.epoch;
  line->X = state.x;
  line->Y = state.y;
  line->Z = state.z;
  line->X_DOT = state.x_dot;
  line->Y_DOT = state.y_dot;
  line->Z_DOT = state.z_dot;
  if (acceleration != nullptr) {
    line->X_DDOT = acceleration->x;
    line->Y_DDOT = acceleration->y;
    line->Z_DDOT = acceleration->z;
  }
  block->EPHEMERIS_DATA_LINES.push_back(std::move(line));
  oem.EPHEMERIS_DATA_BLOCK.push_back(std::move(block));
  ::flatbuffers::FlatBufferBuilder builder(1024);
  builder.Finish(CreateOEM(builder, &oem), "$OEM");
  if (plugin_push_output("cartesian_state", "OEM.fbs", "$OEM", builder.GetBufferPointer(),
                         static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit OEM Cartesian state.");
    return 1;
  }
  return 0;
}

// $OMM from an $OCM input.
int emit_omm_from_ocm(const OcmInput& in, const KeplerianElements& elements, const char* comment) {
  ::flatbuffers::FlatBufferBuilder builder(1024);
  const Header* header = in.ocm->HEADER();
  const Metadata* md = in.ocm->METADATA();
  const auto creation_date = create_optional_string(
      builder, header != nullptr ? flatbuffer_string_or_null(header->CREATION_DATE()) : nullptr);
  const auto originator = builder.CreateString("DigitalArsenal foundation/orbits");
  const auto object_name = create_optional_string(builder, md != nullptr ? flatbuffer_string_or_null(md->OBJECT_NAME()) : nullptr);
  const auto object_id = create_optional_string(
      builder, md != nullptr ? flatbuffer_string_or_null(md->INTERNATIONAL_DESIGNATOR()) : nullptr);
  const auto center_name = builder.CreateString(in.metadata.center_name);
  const auto comment_offset = builder.CreateString(comment);
  const auto epoch = builder.CreateString(in.metadata.epoch);
  const auto omm = BuildOmmElements(builder, creation_date, originator, object_name, object_id, center_name,
                                    static_cast<int8_t>(in.time_system), 2, comment_offset, epoch,
                                    elements.semi_major_axis, elements.eccentricity, elements.inclination,
                                    elements.raan, elements.arg_pericenter, elements.mean_anomaly, elements.gm);
  builder.Finish(omm, "$OMM");
  if (plugin_push_output("mean_elements", "OMM.fbs", "$OMM", builder.GetBufferPointer(),
                         static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit OMM mean elements.");
    return 1;
  }
  return 0;
}

bool read_grv_frame(std::vector<uint8_t>* storage, const GRV** gravity) {
  const plugin_input_frame_t* frame = find_input_frame("gravity_context");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-gravity-context", "No GRV gravity_context frame was provided.");
    return false;
  }
  storage->assign(frame->payload, frame->payload + frame->payload_length);
  ::flatbuffers::Verifier verifier(storage->data(), storage->size());
  if (!VerifyGRVBuffer(verifier)) {
    plugin_set_error("invalid-grv-buffer", "Input gravity_context is not a valid SDS GRV FlatBuffer.");
    return false;
  }
  *gravity = GetGRV(storage->data());
  return true;
}

int emit_normalized_keplerian_anomaly(bool output_true_anomaly) {
  plugin_reset_output_state();
  OcmInput in;
  ElementRecord input;
  if (const int rc = read_ocm_elements("keplerian_state", &in, &input)) return rc;
  if (in.ocm->TRAJ_TYPE() != trajectoryType::KEPLERIAN && in.ocm->TRAJ_TYPE() != trajectoryType::KEPLERIAN_MEAN) {
    plugin_set_error("unsupported-trajectory-type", "Expected OCM TRAJ_TYPE KEPLERIAN or KEPLERIAN_MEAN.");
    return 3;
  }
  ElementRecord output;
  const bool converted = output_true_anomaly ? normalize_record_to_true_anomaly(input, &output)
                                             : normalize_record_to_mean_anomaly(input, &output);
  if (!converted) {
    plugin_set_error("unsupported-orbit", "The Keplerian elements must describe a finite elliptical or hyperbolic orbit.");
    return 3;
  }
  const char* averaging = in.ocm->ORB_AVERAGING() != nullptr ? in.ocm->ORB_AVERAGING()->c_str() : nullptr;
  return emit_ocm_keplerian("keplerian_state", in, output, averaging,
                            output_true_anomaly ? "Anomaly converted to true anomaly." : "Anomaly converted to mean anomaly.");
}

}  // namespace

extern "C" int keplerian_to_cartesian(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("mean_elements");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-mean-elements", "No OMM mean-elements frame was provided.");
    return 3;
  }
  if (!OMMBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-omm-buffer", "Input is not an SDS OMM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyOMMBuffer(verifier)) {
    plugin_set_error("invalid-omm-buffer", "Input is not a valid SDS OMM FlatBuffer.");
    return 3;
  }

  const OMM* omm = GetOMM(frame->payload);
  CartesianState state;
  if (!convert_keplerian_to_cartesian(omm, &state)) {
    plugin_set_error(
        "unsupported-orbit",
        "OMM must contain finite elliptical Keplerian elements with SEMI_MAJOR_AXIS > 0, 0 <= ECCENTRICITY < 1, and GM > 0.");
    return 3;
  }

  return emit_oem(omm, state);
}

extern "C" int cartesian_to_keplerian(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* cartesian_frame = find_input_frame("cartesian_state");
  if (cartesian_frame == nullptr || cartesian_frame->payload == nullptr || cartesian_frame->payload_length < 8) {
    plugin_set_error("missing-cartesian-state", "No OEM Cartesian state frame was provided.");
    return 3;
  }
  if (!OEMBufferHasIdentifier(cartesian_frame->payload)) {
    plugin_set_error("invalid-oem-buffer", "Input cartesian_state is not an SDS OEM FlatBuffer.");
    return 3;
  }
  ::flatbuffers::Verifier oem_verifier(cartesian_frame->payload, cartesian_frame->payload_length);
  if (!VerifyOEMBuffer(oem_verifier)) {
    plugin_set_error("invalid-oem-buffer", "Input cartesian_state is not a valid SDS OEM FlatBuffer.");
    return 3;
  }

  const plugin_input_frame_t* context_frame = find_input_frame("gravity_context");
  if (context_frame == nullptr || context_frame->payload == nullptr || context_frame->payload_length < 8) {
    plugin_set_error("missing-gravity-context", "No OMM gravity_context frame was provided.");
    return 3;
  }
  if (!OMMBufferHasIdentifier(context_frame->payload)) {
    plugin_set_error("invalid-context-buffer", "Input gravity_context is not an SDS OMM FlatBuffer.");
    return 3;
  }
  ::flatbuffers::Verifier context_verifier(context_frame->payload, context_frame->payload_length);
  if (!VerifyOMMBuffer(context_verifier)) {
    plugin_set_error("invalid-context-buffer", "Input gravity_context is not a valid SDS OMM FlatBuffer.");
    return 3;
  }

  CartesianState state;
  OemMetadata metadata;
  if (!extract_oem_state(GetOEM(cartesian_frame->payload), &state, &metadata)) {
    plugin_set_error("missing-state-vector", "OEM must contain at least one explicit ephemerisDataLine state vector.");
    return 3;
  }

  const OMM* context = GetOMM(context_frame->payload);
  KeplerianElements elements;
  if (!convert_cartesian_to_keplerian(
          state,
          context ? context->GM() : 0.0,
          &elements,
          true) ||
      !normalize_parabolic_recovered_elements_to_omm(&elements)) {
    plugin_set_error(
        "unsupported-orbit",
        "OEM state and gravity_context.GM must describe a finite elliptical, hyperbolic, or parabolic orbit.");
    return 3;
  }

  return emit_omm(context, metadata, elements);
}

extern "C" int opm_to_oem(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("orbit_parameters");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-orbit-parameters", "No OPM orbit_parameters frame was provided.");
    return 3;
  }
  if (!OPMBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-opm-buffer", "Input orbit_parameters is not an SDS OPM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyOPMBuffer(verifier)) {
    plugin_set_error("invalid-opm-buffer", "Input orbit_parameters is not a valid SDS OPM FlatBuffer.");
    return 3;
  }

  CartesianState state;
  OemMetadata metadata;
  const OPM* opm = GetOPM(frame->payload);
  if (!extract_opm_state(opm, &state, &metadata)) {
    plugin_set_error("missing-state-vector", "OPM must contain a finite Cartesian state vector.");
    return 3;
  }

  return emit_oem_from_opm(opm, state);
}

extern "C" int opm_keplerian_to_oem(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("orbit_parameters");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-orbit-parameters", "No OPM orbit_parameters frame was provided.");
    return 3;
  }
  if (!OPMBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-opm-buffer", "Input orbit_parameters is not an SDS OPM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyOPMBuffer(verifier)) {
    plugin_set_error("invalid-opm-buffer", "Input orbit_parameters is not a valid SDS OPM FlatBuffer.");
    return 3;
  }

  CartesianState state;
  const OPM* opm = GetOPM(frame->payload);
  if (!convert_opm_keplerian_to_cartesian(opm, &state)) {
    plugin_set_error(
        "unsupported-orbit",
        "OPM must contain finite elliptical or hyperbolic Keplerian elements with TRUE_ANOMALY and GM > 0.");
    return 3;
  }

  return emit_oem_from_opm(opm, state);
}

extern "C" int opm_keplerian_to_omm(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("orbit_parameters");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-orbit-parameters", "No OPM orbit_parameters frame was provided.");
    return 3;
  }
  if (!OPMBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-opm-buffer", "Input orbit_parameters is not an SDS OPM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyOPMBuffer(verifier)) {
    plugin_set_error("invalid-opm-buffer", "Input orbit_parameters is not a valid SDS OPM FlatBuffer.");
    return 3;
  }

  const OPM* opm = GetOPM(frame->payload);
  OemMetadata metadata;
  if (!extract_opm_metadata(opm, &metadata)) {
    plugin_set_error("missing-orbit-parameters", "OPM metadata could not be read.");
    return 3;
  }

  KeplerianElements elements;
  if (!convert_opm_keplerian_to_elements(opm, &elements)) {
    plugin_set_error(
        "unsupported-orbit",
        "OPM must contain finite elliptical or hyperbolic Keplerian elements with TRUE_ANOMALY and GM > 0.");
    return 3;
  }

  return emit_omm_from_opm(opm, metadata, elements);
}

extern "C" int opm_to_omm(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("orbit_parameters");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-orbit-parameters", "No OPM orbit_parameters frame was provided.");
    return 3;
  }
  if (!OPMBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-opm-buffer", "Input orbit_parameters is not an SDS OPM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyOPMBuffer(verifier)) {
    plugin_set_error("invalid-opm-buffer", "Input orbit_parameters is not a valid SDS OPM FlatBuffer.");
    return 3;
  }

  CartesianState state;
  OemMetadata metadata;
  const OPM* opm = GetOPM(frame->payload);
  if (!extract_opm_state(opm, &state, &metadata)) {
    plugin_set_error("missing-state-vector", "OPM must contain a finite Cartesian state vector.");
    return 3;
  }

  KeplerianElements elements;
  if (!convert_cartesian_to_keplerian(
          state,
          opm ? opm->GM() : 0.0,
          &elements,
          true) ||
      !normalize_parabolic_recovered_elements_to_omm(&elements)) {
    plugin_set_error(
        "unsupported-orbit",
        "OPM Cartesian state and GM must describe a finite elliptical, hyperbolic, or parabolic orbit.");
    return 3;
  }

  return emit_omm_from_opm(opm, metadata, elements);
}

extern "C" int ocm_keplerian_to_oem(void) {
  plugin_reset_output_state();
  OcmInput in;
  ElementRecord elements;
  if (const int rc = read_ocm_elements("keplerian_state", &in, &elements)) return rc;
  CartesianState state;
  if (!convert_record_to_cartesian(elements, in.gm, &state)) {
    plugin_set_error("unsupported-orbit",
                     "The OCM element set and PERTURBATIONS.GM must describe a finite elliptical or hyperbolic orbit.");
    return 3;
  }
  return emit_oem_from_ocm(in, state, "Generated from an SDS OCM element set.");
}

extern "C" int ocm_keplerian_to_state(void) {
  plugin_reset_output_state();
  OcmInput in;
  ElementRecord elements;
  if (const int rc = read_ocm_elements("keplerian_state", &in, &elements)) return rc;
  CartesianState state;
  if (!convert_record_to_cartesian(elements, in.gm, &state)) {
    plugin_set_error("unsupported-orbit",
                     "The OCM element set and PERTURBATIONS.GM must describe a finite elliptical or hyperbolic orbit.");
    return 3;
  }
  return emit_ocm_cartesian("vector_state", in, state, "Cartesian state from the element set.");
}

extern "C" int ocm_state_to_oem(void) {
  plugin_reset_output_state();
  OcmInput in;
  CartesianState state;
  if (const int rc = read_ocm_cartesian("vector_state", &in, &state)) return rc;
  return emit_oem_from_ocm(in, state, "Generated from an SDS OCM Cartesian state.");
}

extern "C" int ocm_state_to_j_zonal_acceleration_oem(void) {
  plugin_reset_output_state();
  OcmInput in;
  CartesianState state;
  if (const int rc = read_ocm_cartesian("vector_state", &in, &state)) return rc;
  std::vector<uint8_t> grv_bytes;
  const GRV* gravity = nullptr;
  if (!read_grv_frame(&grv_bytes, &gravity)) return 3;
  Vector3 acceleration;
  if (!compute_j_zonal_perturbation_acceleration(state, gravity, &acceleration)) {
    plugin_set_error("unsupported-gravity-context",
                     "The OCM state and GRV MU/EQUATORIAL_RADIUS/J2-J6 must describe a finite Basilisk J2-J6 zonal perturbation request.");
    return 3;
  }
  return emit_oem_from_ocm(in, state, "Generated from an SDS OCM Cartesian state and GRV J-zonal gravity context.",
                           &acceleration);
}

extern "C" int ocm_state_to_srp_acceleration_oem(void) {
  plugin_reset_output_state();
  OcmInput in;
  CartesianState state;
  if (const int rc = read_ocm_cartesian("vector_state", &in, &state)) return rc;
  const plugin_input_frame_t* sun_frame = find_input_frame("sun_vector");
  if (sun_frame == nullptr || sun_frame->payload == nullptr || sun_frame->payload_length < 8) {
    plugin_set_error("missing-sun-vector", "No CRD sun_vector frame was provided.");
    return 3;
  }
  std::vector<uint8_t> crd_bytes(sun_frame->payload, sun_frame->payload + sun_frame->payload_length);
  ::flatbuffers::Verifier verifier(crd_bytes.data(), crd_bytes.size());
  if (!VerifyCRDBuffer(verifier)) {
    plugin_set_error("invalid-crd-buffer", "Input sun_vector is not a valid SDS CRD FlatBuffer.");
    return 3;
  }
  const PhysicalProperties* physical = in.ocm->PHYSICAL_PROPERTIES();
  Vector3 acceleration;
  if (physical == nullptr ||
      !compute_solar_radiation_pressure_acceleration(physical->WET_MASS(), physical->SRP_CONST_AREA(),
                                                     physical->SOLAR_RAD_COEFF(), GetCRD(crd_bytes.data()),
                                                     &acceleration)) {
    plugin_set_error("unsupported-srp-context",
                     "OCM PHYSICAL_PROPERTIES WET_MASS/SRP_CONST_AREA/SOLAR_RAD_COEFF and CRD X/Y/Z must describe a finite Basilisk solar radiation pressure request.");
    return 3;
  }
  return emit_oem_from_ocm(in, state,
                           "Generated from SDS OCM physical properties and a CRD Sun vector using the Basilisk solarRad convention.",
                           &acceleration);
}

extern "C" int ocm_state_to_omm(void) {
  plugin_reset_output_state();
  OcmInput in;
  CartesianState state;
  if (const int rc = read_ocm_cartesian("vector_state", &in, &state)) return rc;
  KeplerianElements elements;
  if (!convert_cartesian_to_keplerian(state, in.gm, &elements, true)) {
    plugin_set_error("unsupported-orbit",
                     "The OCM state and PERTURBATIONS.GM must describe a finite elliptical, hyperbolic, or parabolic orbit.");
    return 3;
  }
  if (!normalize_parabolic_recovered_elements_to_omm(&elements)) {
    plugin_set_error("unsupported-orbit",
                     "The OCM state and PERTURBATIONS.GM must describe a finite parabolic orbit with a Barker mean anomaly.");
    return 3;
  }
  return emit_omm_from_ocm(in, elements, "Generated from an SDS OCM Cartesian state.");
}

extern "C" int ocm_state_to_keplerian(void) {
  plugin_reset_output_state();
  OcmInput in;
  CartesianState state;
  if (const int rc = read_ocm_cartesian("vector_state", &in, &state)) return rc;
  KeplerianElements elements;
  if (!convert_cartesian_to_keplerian(state, in.gm, &elements, true)) {
    plugin_set_error("unsupported-orbit",
                     "The OCM state and PERTURBATIONS.GM must describe a finite elliptical, hyperbolic, or parabolic orbit.");
    return 3;
  }
  if (std::abs(elements.eccentricity - 1.0) <= kSingularOrbitTolerance &&
      std::abs(elements.semi_major_axis) <= kSingularOrbitTolerance) {
    plugin_set_error("unsupported-orbit",
                     "SANA KEPLERIAN element sets cannot express a parabolic orbit (infinite semi-major axis).");
    return 3;
  }
  ElementRecord record;
  record.semi_major_axis = elements.semi_major_axis;
  record.eccentricity = elements.eccentricity;
  record.inclination = elements.inclination;
  record.raan = elements.raan;
  record.arg_pericenter = elements.arg_pericenter;
  record.anomaly = elements.mean_anomaly;
  record.anomaly_type = 1;
  return emit_ocm_keplerian("keplerian_state", in, record, "OSCULATING", "Osculating Keplerian elements from the Cartesian state.");
}

extern "C" int ocm_state_to_equinoctial(void) {
  plugin_reset_output_state();
  OcmInput in;
  CartesianState state;
  if (const int rc = read_ocm_cartesian("vector_state", &in, &state)) return rc;
  KeplerianElements elements;
  if (!convert_cartesian_to_keplerian(state, in.gm, &elements)) {
    plugin_set_error("unsupported-orbit",
                     "The OCM state and PERTURBATIONS.GM must describe a finite elliptical orbit.");
    return 3;
  }
  ElementRecord record;
  record.semi_major_axis = elements.semi_major_axis;
  record.eccentricity = elements.eccentricity;
  record.inclination = elements.inclination;
  record.raan = elements.raan;
  record.arg_pericenter = elements.arg_pericenter;
  record.anomaly = elements.mean_anomaly;
  record.anomaly_type = 1;
  return emit_ocm_equinoctial("equinoctial_state", in, record, "Equinoctial elements from the Cartesian state.");
}

extern "C" int ocm_keplerian_to_omm(void) {
  plugin_reset_output_state();
  OcmInput in;
  ElementRecord record;
  if (const int rc = read_ocm_elements("keplerian_state", &in, &record)) return rc;
  KeplerianElements elements;
  if (!convert_record_to_omm(record, in.gm, &elements)) {
    plugin_set_error("unsupported-orbit",
                     "The OCM element set and PERTURBATIONS.GM must describe a finite elliptical or hyperbolic orbit.");
    return 3;
  }
  return emit_omm_from_ocm(in, elements, "Generated from an SDS OCM element set.");
}

extern "C" int ocm_keplerian_to_true_anomaly(void) {
  return emit_normalized_keplerian_anomaly(true);
}

extern "C" int ocm_keplerian_to_mean_anomaly(void) {
  return emit_normalized_keplerian_anomaly(false);
}

namespace {
// Basilisk clMeanOscMap: first-order J2 Brouwer map between mean and
// osculating Keplerian elements.
int map_mean_osculating(bool to_osculating) {
  plugin_reset_output_state();
  OcmInput in;
  ElementRecord source;
  if (const int rc = read_ocm_elements("keplerian_state", &in, &source)) return rc;
  const char* averaging = in.ocm->ORB_AVERAGING() != nullptr ? in.ocm->ORB_AVERAGING()->c_str() : "";
  const bool is_mean = std::strcmp(averaging, "BROUWER") == 0;
  if (to_osculating != is_mean) {
    plugin_set_error("unsupported-averaging",
                     to_osculating ? "Mean-to-osculating needs ORB_AVERAGING BROUWER elements."
                                   : "Osculating-to-mean needs osculating elements (ORB_AVERAGING absent or OSCULATING).");
    return 3;
  }
  std::vector<uint8_t> grv_bytes;
  const GRV* gravity = nullptr;
  if (!read_grv_frame(&grv_bytes, &gravity)) return 3;
  ElementRecord elements;
  const bool ok = to_osculating ? convert_record_mean_to_osculating(source, gravity, &elements)
                                : convert_record_osculating_to_mean(source, gravity, &elements);
  if (!ok) {
    plugin_set_error("unsupported-orbit",
                     to_osculating ? "The elements and GRV EQUATORIAL_RADIUS/J2 must describe a finite elliptical first-order J2 mean-to-osculating map."
                                   : "The elements and GRV EQUATORIAL_RADIUS/J2 must describe a finite elliptical first-order J2 osculating-to-mean map.");
    return 3;
  }
  return emit_ocm_keplerian("keplerian_state", in, elements, to_osculating ? "OSCULATING" : "BROUWER",
                            to_osculating ? "First-order J2 Brouwer mean-to-osculating map (Basilisk clMeanOscMap)."
                                          : "First-order J2 Brouwer osculating-to-mean map (Basilisk clMeanOscMap).");
}
}  // namespace

extern "C" int ocm_keplerian_mean_to_osculating(void) {
  return map_mean_osculating(true);
}

extern "C" int ocm_keplerian_osculating_to_mean(void) {
  return map_mean_osculating(false);
}

extern "C" int keplerian_to_equinoctial(void) {
  plugin_reset_output_state();
  OcmInput in;
  ElementRecord record;
  if (const int rc = read_ocm_elements("keplerian_state", &in, &record)) return rc;
  return emit_ocm_equinoctial("equinoctial_state", in, record, "SANA EQUINOCTIAL elements from the Keplerian elements.");
}

extern "C" int equinoctial_to_keplerian(void) {
  plugin_reset_output_state();
  OcmInput in;
  ElementRecord record;
  if (const int rc = read_ocm_elements("equinoctial_state", &in, &record)) return rc;
  const char* averaging = in.ocm->ORB_AVERAGING() != nullptr ? in.ocm->ORB_AVERAGING()->c_str() : nullptr;
  return emit_ocm_keplerian("keplerian_state", in, record, averaging, "Keplerian elements from the equinoctial elements.");
}

extern "C" int ocm_equinoctial_to_omm(void) {
  plugin_reset_output_state();
  OcmInput in;
  ElementRecord record;
  if (const int rc = read_ocm_elements("equinoctial_state", &in, &record)) return rc;
  KeplerianElements elements;
  if (!convert_record_to_omm(record, in.gm, &elements)) {
    plugin_set_error("unsupported-orbit", "The equinoctial elements and PERTURBATIONS.GM must describe a finite elliptical orbit.");
    return 3;
  }
  return emit_omm_from_ocm(in, elements, "Generated from SDS OCM equinoctial elements.");
}

extern "C" int ocm_equinoctial_to_oem(void) {
  plugin_reset_output_state();
  OcmInput in;
  ElementRecord record;
  if (const int rc = read_ocm_elements("equinoctial_state", &in, &record)) return rc;
  CartesianState state;
  if (!convert_record_to_cartesian(record, in.gm, &state)) {
    plugin_set_error("unsupported-orbit", "The equinoctial elements and PERTURBATIONS.GM must describe a finite elliptical orbit.");
    return 3;
  }
  return emit_oem_from_ocm(in, state, "Generated from SDS OCM equinoctial elements.");
}

extern "C" int ocm_equinoctial_to_state(void) {
  plugin_reset_output_state();
  OcmInput in;
  ElementRecord record;
  if (const int rc = read_ocm_elements("equinoctial_state", &in, &record)) return rc;
  CartesianState state;
  if (!convert_record_to_cartesian(record, in.gm, &state)) {
    plugin_set_error("unsupported-orbit", "The equinoctial elements and PERTURBATIONS.GM must describe a finite elliptical orbit.");
    return 3;
  }
  return emit_ocm_cartesian("vector_state", in, state, "Cartesian state from the equinoctial elements.");
}

extern "C" int ocm_pair_to_cdm_relative_hill(void) {
  plugin_reset_output_state();
  OcmInput chief;
  OcmInput deputy;
  CartesianState chief_state;
  CartesianState deputy_state;
  if (const int rc = read_ocm_cartesian("chief_state", &chief, &chief_state)) return rc;
  if (const int rc = read_ocm_cartesian("deputy_state", &deputy, &deputy_state)) return rc;
  RelativeHillState relative;
  if (!compute_hill_relative_state(chief_state, deputy_state, &relative)) {
    plugin_set_error("unsupported-state",
                     "Chief and deputy OCM states must be finite and chief angular momentum must be non-zero.");
    return 3;
  }
  return emit_cdm_relative_hill(chief.ocm, deputy.ocm, chief.metadata, relative);
}

extern "C" int cdm_relative_hill_to_ocm_deputy_state(void) {
  plugin_reset_output_state();
  OcmInput chief;
  CartesianState chief_state;
  if (const int rc = read_ocm_cartesian("chief_state", &chief, &chief_state)) return rc;
  const plugin_input_frame_t* relative_frame = find_input_frame("relative_state");
  if (relative_frame == nullptr || relative_frame->payload == nullptr || relative_frame->payload_length < 8) {
    plugin_set_error("missing-relative-state", "No CDM relative_state frame was provided.");
    return 3;
  }
  std::vector<uint8_t> cdm_bytes(relative_frame->payload, relative_frame->payload + relative_frame->payload_length);
  ::flatbuffers::Verifier verifier(cdm_bytes.data(), cdm_bytes.size());
  if (!CDMBufferHasIdentifier(cdm_bytes.data()) || !VerifyCDMBuffer(verifier)) {
    plugin_set_error("invalid-cdm-buffer", "Input relative_state is not a valid SDS CDM FlatBuffer.");
    return 3;
  }
  const CDM* relative_cdm = GetCDM(cdm_bytes.data());
  RelativeHillState relative;
  if (!extract_cdm_relative_state(relative_cdm, &relative)) {
    plugin_set_error("missing-relative-fields",
                     "CDM relative_state must contain finite RTN/Hill relative position and velocity fields.");
    return 3;
  }
  CartesianState deputy_state;
  if (!compute_deputy_from_hill_relative_state(chief_state, relative, &deputy_state)) {
    plugin_set_error("unsupported-state",
                     "The chief OCM state and CDM relative_state must be finite and chief angular momentum must be non-zero.");
    return 3;
  }
  // The deputy is a different object: the chief's identity is not reused,
  // and its epoch is the CDM TCA when one is given.
  OCMT out;
  chief.ocm->UnPackTo(&out);
  out.TRAJ_TYPE = trajectoryType::CARTESIAN_PV;
  out.STATE_VECTOR_SIZE = 6;
  out.STATE_DATA = {deputy_state.x, deputy_state.y, deputy_state.z, deputy_state.x_dot, deputy_state.y_dot, deputy_state.z_dot};
  out.STATE_STEP_SIZE = 0.0;
  out.COVARIANCE_DATA.clear();
  out.COV_REF_FRAME.reset();
  out.ORB_AVERAGING.clear();
  out.PHYSICAL_PROPERTIES.reset();
  out.MANEUVER_DATA.clear();
  out.ORBIT_DETERMINATION.reset();
  out.ORB_REVNUM = 0;
  if (!out.METADATA) out.METADATA = std::make_unique<MetadataT>();
  auto& md = *out.METADATA;
  md.OBJECT_NAME = relative_cdm->MESSAGE_ID() != nullptr ? relative_cdm->MESSAGE_ID()->str() : "Basilisk Hill deputy state";
  md.INTERNATIONAL_DESIGNATOR.clear();
  md.OBJECT_DESIGNATOR.clear();
  md.CATALOG_NAME.clear();
  if (relative_cdm->TCA() != nullptr) {
    md.START_TIME = relative_cdm->TCA()->str();
    md.STOP_TIME = md.START_TIME;
    md.EPOCH_TZERO = md.START_TIME;
  }
  if (!out.HEADER) out.HEADER = std::make_unique<HeaderT>();
  out.HEADER->COMMENT.push_back("Deputy state from the chief state and a CDM Hill-frame relative state.");
  ::flatbuffers::FlatBufferBuilder builder(2048);
  builder.FinishSizePrefixed(CreateOCM(builder, &out), OCMIdentifier());
  if (plugin_push_output_ex("deputy_state", "OCM.fbs", "$OCM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "OCM", 0, 0,
                            builder.GetBufferPointer(), static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit OCM deputy state.");
    return 1;
  }
  return 0;
}
