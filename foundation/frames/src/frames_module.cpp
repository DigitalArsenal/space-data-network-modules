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

 The operations 1-4 below port selected Basilisk geodeticConversion utilities
 to the SDK's standalone C++/WASI surface and SDS FRM FlatBuffer envelopes.

 Operations 5, 6 and 7 (STATE_TRANSFORM, FRAME_ROTATION,
 STATE_REPRESENTATION_CONVERT) are the GMAT-parity coordinate-system surface.
 They consume a fully specified $RFM RFMCoordinateSystem — an axis set AND an
 origin — and evaluate it over the one IAU-2006/2000A chain in
 src/axis_engine.hpp and the one element-set library in
 foundation/orbits/src/state_representations.hpp. Nothing here re-derives a
 series or an element set; this file is wire, resolution and error handling.
 */

#include "space_data_module_invoke.h"

#include <cmath>
#include <cstdint>
#include <cstring>

namespace {

namespace ax = ::sdn::frames;
namespace orb = ::sdn::orbits;

constexpr double kSmall = 1e-15;

// The root axes for every resolution below: ICRF/GCRF, centred on the Earth.
// Every coordinate system is expressed relative to this one pivot so that N
// axis sets and M origins cost N + M chains rather than N * M.
constexpr int kRootBodyId = static_cast<int>(ax::BodyId::EARTH);

// Gravitational parameters, m^3/s^2, for the bodies this module can centre a
// coordinate system on. Used ONLY when the caller does not supply
// FRMStateVector.GRAVITATIONAL_PARAMETER; the request always wins.
// Values: IAU 2015 nominal (Sun), DE440 (Earth, Moon, Mars).
struct BodyGm {
  int bodyId;
  double gm;
};
constexpr BodyGm kBodyGm[] = {
    {static_cast<int>(ax::BodyId::SUN), 1.32712440018e20},
    {static_cast<int>(ax::BodyId::EARTH), 3.986004418e14},
    {static_cast<int>(ax::BodyId::MOON), 4.902800118e12},
    {static_cast<int>(ax::BodyId::MARS), 4.282837362e13},
};

// Moon-to-Earth mass ratio, DE440. Used for the Earth-Moon barycentre and the
// Earth-Moon libration points. A PARAMETER of the engine, pinned here so the
// module has one answer rather than none.
constexpr double kMoonToEarthMassRatio = 0.0123000371;

double bodyGm(int bodyId, bool* found) {
  for (const BodyGm& entry : kBodyGm) {
    if (entry.bodyId == bodyId) {
      if (found != nullptr) {
        *found = true;
      }
      return entry.gm;
    }
  }
  if (found != nullptr) {
    *found = false;
  }
  return 0.0;
}

struct Vec3 {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

struct Matrix3 {
  double m11 = 0.0;
  double m12 = 0.0;
  double m13 = 0.0;
  double m21 = 0.0;
  double m22 = 0.0;
  double m23 = 0.0;
  double m31 = 0.0;
  double m32 = 0.0;
  double m33 = 0.0;
};

struct TransformOutput {
  frmResultStatus status = frmResultStatus::OK;
  const char* message = nullptr;
  Vec3 position;

  // Operations 5/6/7 only. `hasState` / `hasRotation` say which of these the
  // emitter should write; an empty result for operations 1-4 is the contract.
  bool hasState = false;
  bool hasRotation = false;
  frmStateRepresentation representation = frmStateRepresentation::UNSPECIFIED;
  double elements[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
  Vec3 statePosition;
  Vec3 stateVelocity;
  double gravitationalParameter = 0.0;
  const char* coordinateSystemName = nullptr;
  const char* epoch = nullptr;
  const char* epochTimeSystem = nullptr;
  Matrix3 rotation;
  Matrix3 rotationRate;
  Vec3 angularVelocity;
  const char* eopDataSetEpoch = nullptr;
  const char* eopDataSetCid = nullptr;
};

bool is_finite(double value) {
  return std::isfinite(value);
}

bool is_finite(const Vec3& value) {
  return is_finite(value.x) && is_finite(value.y) && is_finite(value.z);
}

bool is_finite(const Matrix3& value) {
  return is_finite(value.m11) && is_finite(value.m12) && is_finite(value.m13) &&
      is_finite(value.m21) && is_finite(value.m22) && is_finite(value.m23) &&
      is_finite(value.m31) && is_finite(value.m32) && is_finite(value.m33);
}

Vec3 read_vec3(const FRMVector3* value) {
  if (value == nullptr) {
    return {};
  }
  return {value->X(), value->Y(), value->Z()};
}

Matrix3 read_matrix(const FRMMatrix3* value) {
  if (value == nullptr) {
    return {};
  }
  return {
      value->M11(), value->M12(), value->M13(),
      value->M21(), value->M22(), value->M23(),
      value->M31(), value->M32(), value->M33()};
}

Vec3 multiply(const Matrix3& matrix, const Vec3& vector) {
  return {
      matrix.m11 * vector.x + matrix.m12 * vector.y + matrix.m13 * vector.z,
      matrix.m21 * vector.x + matrix.m22 * vector.y + matrix.m23 * vector.z,
      matrix.m31 * vector.x + matrix.m32 * vector.y + matrix.m33 * vector.z};
}

Vec3 transpose_multiply(const Matrix3& matrix, const Vec3& vector) {
  return {
      matrix.m11 * vector.x + matrix.m21 * vector.y + matrix.m31 * vector.z,
      matrix.m12 * vector.x + matrix.m22 * vector.y + matrix.m32 * vector.z,
      matrix.m13 * vector.x + matrix.m23 * vector.y + matrix.m33 * vector.z};
}

Matrix3 to_matrix3(const ax::Mat3& value) {
  return {value.m[0][0], value.m[0][1], value.m[0][2],
          value.m[1][0], value.m[1][1], value.m[1][2],
          value.m[2][0], value.m[2][1], value.m[2][2]};
}

Vec3 to_vec3(const ax::Vec3& value) { return {value.x, value.y, value.z}; }

bool valid_equatorial_radius(double equatorial_radius_m) {
  return is_finite(equatorial_radius_m) && equatorial_radius_m > 0.0;
}

bool valid_ellipsoid_or_sphere(double equatorial_radius_m, double polar_radius_m) {
  if (!valid_equatorial_radius(equatorial_radius_m) || !is_finite(polar_radius_m)) {
    return false;
  }
  return polar_radius_m < 0.0 ||
      (polar_radius_m > 0.0 && equatorial_radius_m >= polar_radius_m);
}

bool lla_to_pcpf(
    const Vec3& lla,
    double equatorial_radius_m,
    double polar_radius_m,
    Vec3* output) {
  if (output == nullptr || !is_finite(lla) ||
      !valid_ellipsoid_or_sphere(equatorial_radius_m, polar_radius_m)) {
    return false;
  }

  const double sin_lat = std::sin(lla.x);
  const double cos_lat = std::cos(lla.x);
  const double sin_lon = std::sin(lla.y);
  const double cos_lon = std::cos(lla.y);
  double flattening_term = 0.0;
  if (polar_radius_m >= 0.0) {
    flattening_term =
        (equatorial_radius_m * equatorial_radius_m - polar_radius_m * polar_radius_m) /
        (equatorial_radius_m * equatorial_radius_m);
  }
  const double normal_radius =
      equatorial_radius_m / std::sqrt(1.0 - flattening_term * sin_lat * sin_lat);

  output->x = (normal_radius + lla.z) * cos_lat * cos_lon;
  output->y = (normal_radius + lla.z) * cos_lat * sin_lon;
  output->z = (normal_radius * (1.0 - flattening_term) + lla.z) * sin_lat;
  return is_finite(*output);
}

bool pcpf_to_lla(
    const Vec3& pcpf,
    double equatorial_radius_m,
    double polar_radius_m,
    Vec3* output) {
  if (output == nullptr || !is_finite(pcpf) ||
      !valid_ellipsoid_or_sphere(equatorial_radius_m, polar_radius_m)) {
    return false;
  }

  const double p = std::hypot(pcpf.x, pcpf.y);
  if (polar_radius_m < 0.0) {
    *output = {
        std::atan2(pcpf.z, p),
        std::atan2(pcpf.y, pcpf.x),
        std::sqrt(p * p + pcpf.z * pcpf.z) - equatorial_radius_m};
    return is_finite(*output);
  }

  if (p <= kSmall && std::fabs(pcpf.z) <= kSmall) {
    return false;
  }

  const double a2 = equatorial_radius_m * equatorial_radius_m;
  const double b2 = polar_radius_m * polar_radius_m;
  const double first_eccentricity_squared = (a2 - b2) / a2;
  const double second_eccentricity_squared = (a2 - b2) / b2;
  const double theta = std::atan2(pcpf.z * equatorial_radius_m, p * polar_radius_m);
  const double sin_theta = std::sin(theta);
  const double cos_theta = std::cos(theta);
  const double latitude = std::atan2(
      pcpf.z + second_eccentricity_squared * polar_radius_m * sin_theta * sin_theta * sin_theta,
      p - first_eccentricity_squared * equatorial_radius_m * cos_theta * cos_theta * cos_theta);
  const double longitude = std::atan2(pcpf.y, pcpf.x);
  const double sin_latitude = std::sin(latitude);
  const double cos_latitude = std::cos(latitude);
  if (std::fabs(cos_latitude) <= kSmall) {
    return false;
  }

  const double normal_radius =
      equatorial_radius_m / std::sqrt(1.0 - first_eccentricity_squared * sin_latitude * sin_latitude);
  const double altitude = p / cos_latitude - normal_radius;

  *output = {latitude, longitude, altitude};
  return is_finite(*output);
}

// ===========================================================================
// Operations 5/6/7 — coordinate systems.
// ===========================================================================

/// Everything the epoch-dependent chains need that is NOT in the request's
/// geometry: the epoch itself, the Earth-orientation row the caller supplied,
/// and the optional referenced-object state.
struct EvaluationContext {
  ax::Epoch epoch;
  ax::EarthOrientation eop;
  bool eopSupplied = false;
  const char* eopDataSetEpoch = nullptr;
  const char* eopDataSetCid = nullptr;

  ax::GeomagneticDipole dipole;

  bool haveObjectState = false;
  const char* objectId = nullptr;
  ax::Vec3 objectPositionRoot;
  ax::Vec3 objectVelocityRoot;
};

/// A coordinate system reduced to numbers: how to rotate the root axes into it,
/// how fast those axes turn, and where its origin is in the root axes.
struct ResolvedSystem {
  ax::Mat3 rotation;              ///< root axes -> these axes
  ax::Mat3 rotationRate;          ///< d/dt of the above, per second
  ax::Vec3 angularVelocityRoot;   ///< rad/s, these axes wrt root, in ROOT axes
  ax::Vec3 originPosition;        ///< origin in root axes, metres
  ax::Vec3 originVelocity;        ///< metres/second
  int originBodyId = kRootBodyId; ///< body whose GM the element sets default to
  bool needsEop = false;          ///< the axis chain reads Earth orientation
};

/// ISO-8601 UTC "YYYY-MM-DDTHH:MM:SS[.fff][Z]" -> broken-down UTC.
/// A refusal on anything else; this module never guesses an epoch.
bool parse_iso_utc(const char* text, int* year, int* month, int* day, int* hour,
                   int* minute, double* second) {
  if (text == nullptr) {
    return false;
  }
  const std::size_t length = std::strlen(text);
  if (length < 19) {
    return false;
  }
  for (int i = 0; i < 19; ++i) {
    const char c = text[i];
    const bool digitPosition = !(i == 4 || i == 7 || i == 10 || i == 13 || i == 16);
    if (digitPosition && (c < '0' || c > '9')) {
      return false;
    }
  }
  if (text[4] != '-' || text[7] != '-' || (text[10] != 'T' && text[10] != ' ') ||
      text[13] != ':' || text[16] != ':') {
    return false;
  }
  auto number = [&text](int offset, int digits) {
    int value = 0;
    for (int i = 0; i < digits; ++i) {
      value = value * 10 + (text[offset + i] - '0');
    }
    return value;
  };
  *year = number(0, 4);
  *month = number(5, 2);
  *day = number(8, 2);
  *hour = number(11, 2);
  *minute = number(14, 2);
  double seconds = static_cast<double>(number(17, 2));
  if (length > 19 && text[19] == '.') {
    double scale = 0.1;
    for (std::size_t i = 20; i < length && text[i] >= '0' && text[i] <= '9'; ++i) {
      seconds += (text[i] - '0') * scale;
      scale *= 0.1;
    }
  }
  *second = seconds;
  return true;
}

bool axis_type_needs_eop(rfmAxisType type) {
  switch (type) {
    case rfmAxisType::BODY_FIXED:
    case rfmAxisType::TOPOCENTRIC:
    case rfmAxisType::SOLAR_MAGNETOSPHERIC:
      return true;
    default:
      return false;
  }
}

ax::OrbitalDirection to_orbital_direction(rfmVectorSpecification spec, bool* ok) {
  *ok = true;
  switch (spec) {
    case rfmVectorSpecification::RADIAL: return ax::OrbitalDirection::RADIAL;
    case rfmVectorSpecification::ANTI_RADIAL: return ax::OrbitalDirection::ANTI_RADIAL;
    case rfmVectorSpecification::VELOCITY: return ax::OrbitalDirection::VELOCITY;
    case rfmVectorSpecification::ANTI_VELOCITY: return ax::OrbitalDirection::ANTI_VELOCITY;
    case rfmVectorSpecification::ORBIT_NORMAL: return ax::OrbitalDirection::NORMAL;
    case rfmVectorSpecification::ANTI_ORBIT_NORMAL: return ax::OrbitalDirection::ANTI_NORMAL;
    default: break;
  }
  *ok = false;
  return ax::OrbitalDirection::RADIAL;
}

ax::Vec3 read_axis_vector(const ::flatbuffers::Vector<double>* values, bool* ok) {
  if (values == nullptr || values->size() != 3) {
    *ok = false;
    return {};
  }
  *ok = true;
  return {values->Get(0), values->Get(1), values->Get(2)};
}

/// The orientation half of a coordinate system, as a function of epoch, for
/// every axis set whose only argument is time. Returns false for the axis sets
/// that additionally need an object state or caller-supplied vectors; those are
/// handled in `resolve_system`, which owns their rates too.
bool epoch_only_rotation(rfmAxisType type, int axisBodyId, const EvaluationContext& context,
                         const RFMCoordinateSystem* system, const ax::Epoch& epoch,
                         ax::Mat3* out) {
  ax::RotationElements elements;
  switch (type) {
    case rfmAxisType::ICRF:
      *out = ax::identity();
      return true;
    case rfmAxisType::MEAN_EQUATOR_EQUINOX_J2000:
      *out = ax::gcrfToMj2000Eq(epoch);
      return true;
    case rfmAxisType::MEAN_ECLIPTIC_EQUINOX_J2000:
      *out = ax::gcrfToMj2000Ec(epoch);
      return true;
    case rfmAxisType::TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE:
      *out = ax::gcrfToTeme(epoch);
      return true;
    case rfmAxisType::MEAN_OF_DATE_EQUATOR:
      *out = ax::gcrfToMod(epoch);
      return true;
    case rfmAxisType::MEAN_OF_DATE_ECLIPTIC:
      *out = ax::gcrfToMoe(epoch);
      return true;
    case rfmAxisType::TRUE_OF_DATE_EQUATOR:
      *out = ax::gcrfToTod(epoch);
      return true;
    case rfmAxisType::TRUE_OF_DATE_ECLIPTIC:
      *out = ax::gcrfToToe(epoch);
      return true;
    case rfmAxisType::MEAN_OF_DATE_EQUATOR_FK5:
      *out = ax::gcrfToModFk5(epoch);
      return true;
    case rfmAxisType::TRUE_OF_DATE_EQUATOR_FK5:
      *out = ax::gcrfToTodFk5(epoch);
      return true;
    case rfmAxisType::SOLAR_ECLIPTIC_MAGNETOSPHERIC:
      *out = ax::gcrfToGse(epoch);
      return true;
    case rfmAxisType::SOLAR_MAGNETOSPHERIC:
      *out = ax::gcrfToGsm(epoch, context.eop, context.dipole);
      return true;
    case rfmAxisType::BODY_FIXED:
      if (axisBodyId == kRootBodyId) {
        // Earth body-fixed IS ITRF, and ITRF is reached through the CIO-based
        // chain with polar motion — not through the WGCCRE polynomial, which
        // carries no Earth-orientation data at all.
        *out = ax::gcrfToItrf(epoch, context.eop);
        return true;
      }
      if (!ax::rotationElementsForBody(axisBodyId, &elements)) {
        return false;
      }
      *out = ax::icrfToBodyFixed(epoch, elements);
      return true;
    case rfmAxisType::BODY_INERTIAL:
    case rfmAxisType::BODY_EQUATOR:
      if (!ax::rotationElementsForBody(axisBodyId, &elements)) {
        return false;
      }
      *out = ax::icrfToBodyInertial(epoch, elements);
      return true;
    case rfmAxisType::BODY_SPIN_SUN: {
      if (!ax::rotationElementsForBody(axisBodyId, &elements)) {
        return false;
      }
      // The spin axis is the third row of the body-inertial rotation carried
      // back into the root axes.
      const ax::Mat3 bodyInertial = ax::icrfToBodyInertial(epoch, elements);
      const ax::Vec3 spinAxis{bodyInertial.m[2][0], bodyInertial.m[2][1], bodyInertial.m[2][2]};
      return ax::bodySpinSunTriad(spinAxis, ax::sunDirectionGcrf(epoch), out);
    }
    case rfmAxisType::TOPOCENTRIC: {
      if (system == nullptr || system->ORIGIN() == nullptr) {
        return false;
      }
      const RFMOrigin* origin = system->ORIGIN();
      const ax::Mat3 bodyFixed = (axisBodyId == kRootBodyId)
          ? ax::gcrfToItrf(epoch, context.eop)
          : ax::identity();
      if (axisBodyId != kRootBodyId) {
        if (!ax::rotationElementsForBody(axisBodyId, &elements)) {
          return false;
        }
      }
      const ax::Mat3 bodyRotation = (axisBodyId == kRootBodyId)
          ? bodyFixed
          : ax::icrfToBodyFixed(epoch, elements);
      const double latitude = origin->SITE_LATITUDE() * (ERFA_DPI / 180.0);
      const double longitude = origin->SITE_LONGITUDE() * (ERFA_DPI / 180.0);
      *out = ax::multiply(ax::topocentricFromBodyFixed(latitude, longitude), bodyRotation);
      return true;
    }
    default:
      return false;
  }
}

/// Origin position in the root axes, as a function of epoch. Non-inertial
/// origins get their velocity by differentiating THIS function, so an origin
/// and its motion can never disagree.
bool origin_position(const RFMOrigin* origin, const EvaluationContext& context,
                     const ax::Epoch& epoch, ax::Vec3* out, int* bodyId) {
  if (origin == nullptr) {
    *out = ax::Vec3{};
    *bodyId = kRootBodyId;
    return true;
  }
  switch (origin->KIND()) {
    case rfmOriginKind::UNSPECIFIED:
    case rfmOriginKind::CELESTIAL_BODY: {
      const int id = origin->KIND() == rfmOriginKind::UNSPECIFIED
          ? kRootBodyId
          : origin->CELESTIAL_BODY_ID();
      *bodyId = id;
      if (id == kRootBodyId) {
        *out = ax::Vec3{};
        return true;
      }
      if (id == static_cast<int>(ax::BodyId::MOON)) {
        *out = ax::moonPositionGcrf(epoch);
        return true;
      }
      if (id == static_cast<int>(ax::BodyId::SUN)) {
        *out = ax::scale(ax::sunDirectionGcrf(epoch), 0.0);
        // The Sun's geocentric DISTANCE comes from the same ERFA ephemeris the
        // direction does; recompute it rather than scaling a unit vector.
        double pvh[2][3];
        double pvb[2][3];
        eraEpv00(epoch.tt1, epoch.tt2, pvh, pvb);
        *out = ax::Vec3{-pvh[0][0] * ERFA_DAU, -pvh[0][1] * ERFA_DAU, -pvh[0][2] * ERFA_DAU};
        return true;
      }
      return false;
    }
    case rfmOriginKind::BARYCENTRE: {
      *bodyId = kRootBodyId;
      if (origin->BARYCENTRE_ID() != static_cast<int>(ax::BodyId::EARTH_MOON_BARYCENTRE)) {
        return false;
      }
      *out = ax::earthMoonBarycenterGcrf(epoch, kMoonToEarthMassRatio);
      return true;
    }
    case rfmOriginKind::LIBRATION_POINT: {
      *bodyId = kRootBodyId;
      const int primary = origin->LIBRATION_PRIMARY_ID();
      const int secondary = origin->LIBRATION_SECONDARY_ID();
      if (primary != kRootBodyId || secondary != static_cast<int>(ax::BodyId::MOON)) {
        return false;
      }
      const int index = static_cast<int>(origin->LIBRATION_POINT());
      if (index < 1 || index > 5) {
        return false;
      }
      const ax::Vec3 separation = ax::moonPositionGcrf(epoch);
      const ax::Vec3 separationRate =
          ax::positionRate([](const ax::Epoch& at) { return ax::moonPositionGcrf(at); }, epoch);
      const double massRatio = kMoonToEarthMassRatio / (1.0 + kMoonToEarthMassRatio);
      ax::Vec3 point;
      if (!ax::librationPointFromPrimary(separation, separationRate, massRatio, index, &point)) {
        return false;
      }
      // Relative to the PRIMARY (the Earth), which is the root origin.
      *out = point;
      return true;
    }
    case rfmOriginKind::SPACE_OBJECT: {
      *bodyId = kRootBodyId;
      if (!context.haveObjectState) {
        return false;
      }
      // Linear over the differentiation step only; the state is a measurement
      // at ONE epoch and this module does not propagate. The rate of a
      // spacecraft-centred origin is therefore taken from the supplied
      // velocity directly in resolve_system, not from this function.
      *out = context.objectPositionRoot;
      return true;
    }
    case rfmOriginKind::GROUND_SITE: {
      *bodyId = origin->SITE_BODY_ID() == 0 ? kRootBodyId : origin->SITE_BODY_ID();
      if (*bodyId != kRootBodyId) {
        return false;
      }
      // The site is geodetic on the body; lift it to the root axes through the
      // body-fixed rotation so a topocentric system has a real centre.
      const double latitude = origin->SITE_LATITUDE() * (ERFA_DPI / 180.0);
      const double longitude = origin->SITE_LONGITUDE() * (ERFA_DPI / 180.0);
      const double altitude = origin->SITE_ALTITUDE();
      const double a = 6378137.0;
      const double f = 1.0 / 298.257223563;
      const double e2 = f * (2.0 - f);
      const double sinLat = std::sin(latitude);
      const double n = a / std::sqrt(1.0 - e2 * sinLat * sinLat);
      const ax::Vec3 fixed{(n + altitude) * std::cos(latitude) * std::cos(longitude),
                           (n + altitude) * std::cos(latitude) * std::sin(longitude),
                           (n * (1.0 - e2) + altitude) * sinLat};
      *out = ax::apply(ax::transpose(ax::gcrfToItrf(epoch, context.eop)), fixed);
      return true;
    }
    default:
      return false;
  }
}

/// Reduce a $RFM coordinate system to rotation, rate and origin.
bool resolve_system(const RFMCoordinateSystem* system, const EvaluationContext& context,
                    ResolvedSystem* out, frmResultStatus* status, const char** message) {
  *status = frmResultStatus::OK;
  *message = nullptr;
  if (system == nullptr) {
    *status = frmResultStatus::INVALID_INPUT;
    *message = "A coordinate system is required for this operation.";
    return false;
  }

  const rfmAxisType axisType = system->AXIS_TYPE();
  const int axisBodyId =
      system->AXIS_REFERENCE_BODY_ID() == 0 ? kRootBodyId : system->AXIS_REFERENCE_BODY_ID();
  out->needsEop = axis_type_needs_eop(axisType) ||
      (axisType == rfmAxisType::BODY_FIXED && axisBodyId == kRootBodyId);
  if (out->needsEop && !context.eopSupplied) {
    *status = frmResultStatus::MISSING_EOP_DATA;
    *message =
        "This axis chain reads Earth orientation; supply an $EOP row on the "
        "earth_orientation port rather than have it extrapolated.";
    return false;
  }

  // --- the axis sets that are a function of epoch alone --------------------
  ax::Mat3 probe;
  if (epoch_only_rotation(axisType, axisBodyId, context, system, context.epoch, &probe)) {
    const ax::RotationWithRate withRate = ax::rotationWithRate(
        [&](const ax::Epoch& at) {
          ax::Mat3 value;
          epoch_only_rotation(axisType, axisBodyId, context, system, at, &value);
          return value;
        },
        context.epoch);
    out->rotation = withRate.rotation;
    out->rotationRate = withRate.rate;
    out->angularVelocityRoot = withRate.angularVelocitySource;
  } else if (axisType == rfmAxisType::OBJECT_REFERENCED) {
    // Axes built from a referenced object's own geometry. Their angular
    // velocity is EXACT for the data available: with position and velocity but
    // no acceleration, the triad turns at (r x v)/|r|^2. Differencing the
    // triad numerically would instead measure a straight-line extrapolation of
    // the object and be wrong by the orbital curvature.
    const RFMObjectReferencedAxes* axes = system->OBJECT_REFERENCED_AXES();
    if (axes == nullptr || !context.haveObjectState) {
      *status = frmResultStatus::INVALID_INPUT;
      *message =
          "OBJECT_REFERENCED axes need the referenced object's state on the "
          "object_state port.";
      return false;
    }
    bool okPrimary = true;
    bool okSecondary = true;
    const ax::OrbitalDirection primary = to_orbital_direction(axes->X_AXIS(), &okPrimary);
    const ax::OrbitalDirection secondary = to_orbital_direction(axes->Z_AXIS(), &okSecondary);
    if (!okPrimary || !okSecondary) {
      *status = frmResultStatus::INVALID_INPUT;
      *message = "OBJECT_REFERENCED axes need an X_AXIS and a Z_AXIS direction.";
      return false;
    }
    if (!ax::objectReferencedTriad(primary, secondary, context.objectPositionRoot,
                                   context.objectVelocityRoot, &out->rotation)) {
      *status = frmResultStatus::SINGULAR_ELEMENT_SET;
      *message = "The referenced object's geometry does not define a triad.";
      return false;
    }
    const double radius = ax::norm(context.objectPositionRoot);
    if (!(radius > 0.0)) {
      *status = frmResultStatus::INVALID_INPUT;
      *message = "The referenced object's position is degenerate.";
      return false;
    }
    out->angularVelocityRoot = ax::scale(
        ax::cross(context.objectPositionRoot, context.objectVelocityRoot), 1.0 / (radius * radius));
    // R_dot = -[R omega]x R.
    const ax::Vec3 omegaTarget = ax::apply(out->rotation, out->angularVelocityRoot);
    ax::Mat3 skew;
    skew.m[0][0] = 0.0;          skew.m[0][1] = omegaTarget.z;  skew.m[0][2] = -omegaTarget.y;
    skew.m[1][0] = -omegaTarget.z; skew.m[1][1] = 0.0;          skew.m[1][2] = omegaTarget.x;
    skew.m[2][0] = omegaTarget.y;  skew.m[2][1] = -omegaTarget.x; skew.m[2][2] = 0.0;
    out->rotationRate = ax::multiply(skew, out->rotation);
    for (int i = 0; i < 3; ++i) {
      for (int j = 0; j < 3; ++j) {
        out->rotationRate.m[i][j] = -out->rotationRate.m[i][j];
      }
    }
  } else if (axisType == rfmAxisType::LOCAL_ALIGNED_CONSTRAINED) {
    const RFMLocalAlignedConstrainedAxes* axes = system->LOCAL_ALIGNED_CONSTRAINED_AXES();
    if (axes == nullptr) {
      *status = frmResultStatus::INVALID_INPUT;
      *message = "LOCAL_ALIGNED_CONSTRAINED axes need their vectors.";
      return false;
    }
    bool okAlign = false;
    bool okConstraint = false;
    const ax::Vec3 alignment = read_axis_vector(axes->ALIGNMENT_VECTOR(), &okAlign);
    const ax::Vec3 constraint = read_axis_vector(axes->CONSTRAINT_VECTOR(), &okConstraint);
    if (!okAlign || !okConstraint) {
      *status = frmResultStatus::INVALID_INPUT;
      *message = "LOCAL_ALIGNED_CONSTRAINED needs a 3-element alignment and constraint vector.";
      return false;
    }
    if (!ax::triadFromPrimarySecondary(alignment, constraint, &out->rotation)) {
      *status = frmResultStatus::SINGULAR_ELEMENT_SET;
      *message = "The alignment and constraint vectors are parallel.";
      return false;
    }
    // The vectors are constants OF THIS REQUEST, so these axes do not turn
    // within it. A caller that needs a rate re-issues the request at two
    // epochs with its own vectors; the module never invents their motion.
    out->rotationRate = ax::Mat3{{{0.0, 0.0, 0.0}, {0.0, 0.0, 0.0}, {0.0, 0.0, 0.0}}};
    out->angularVelocityRoot = ax::Vec3{};
  } else if (axisType == rfmAxisType::EPHEMERIS_KERNEL_DEFINED) {
    *status = frmResultStatus::UNSUPPORTED_AXIS_TYPE;
    *message =
        "Kernel-defined axes need a loaded orientation kernel, which this "
        "module does not carry.";
    return false;
  } else {
    *status = frmResultStatus::UNSUPPORTED_AXIS_TYPE;
    *message = "This axis set is not implemented by this provider.";
    return false;
  }

  // --- the origin ----------------------------------------------------------
  const RFMOrigin* origin = system->ORIGIN();
  int bodyId = kRootBodyId;
  if (!origin_position(origin, context, context.epoch, &out->originPosition, &bodyId)) {
    *status = frmResultStatus::INVALID_INPUT;
    *message = "This origin cannot be resolved by this provider.";
    return false;
  }
  out->originBodyId = bodyId;

  if (origin != nullptr && origin->KIND() == rfmOriginKind::SPACE_OBJECT) {
    out->originVelocity = context.objectVelocityRoot;
  } else if (origin == nullptr || origin->KIND() == rfmOriginKind::UNSPECIFIED ||
             (origin->KIND() == rfmOriginKind::CELESTIAL_BODY &&
              origin->CELESTIAL_BODY_ID() == kRootBodyId)) {
    out->originVelocity = ax::Vec3{};
  } else {
    out->originVelocity = ax::positionRate(
        [&](const ax::Epoch& at) {
          ax::Vec3 value;
          int ignored = kRootBodyId;
          origin_position(origin, context, at, &value, &ignored);
          return value;
        },
        context.epoch);
  }
  return true;
}

// --- element sets ----------------------------------------------------------

/// Element set -> Cartesian, in the element set's own coordinate system.
bool cartesian_from_elements(frmStateRepresentation representation, const double* elements,
                             const ax::Vec3& cartesianPosition,
                             const ax::Vec3& cartesianVelocity, double mu,
                             const orb::Ellipsoid& ellipsoid, orb::Cartesian* out,
                             frmResultStatus* status, const char** message) {
  *status = frmResultStatus::OK;
  *message = nullptr;
  switch (representation) {
    case frmStateRepresentation::CARTESIAN: {
      // $FRM says ELEMENTS carries "the 6 element values of REPRESENTATION",
      // and for CARTESIAN those ARE position and velocity. POSITION/VELOCITY
      // are the same state and win when present; a caller that filled only
      // ELEMENTS is not sending an origin-centred zero state, and reading one
      // out of the absent fields would be a silent wrong answer.
      const bool haveVectors =
          cartesianPosition.x != 0.0 || cartesianPosition.y != 0.0 ||
          cartesianPosition.z != 0.0 || cartesianVelocity.x != 0.0 ||
          cartesianVelocity.y != 0.0 || cartesianVelocity.z != 0.0;
      if (haveVectors) {
        out->position = {cartesianPosition.x, cartesianPosition.y, cartesianPosition.z};
        out->velocity = {cartesianVelocity.x, cartesianVelocity.y, cartesianVelocity.z};
      } else {
        out->position = {elements[0], elements[1], elements[2]};
        out->velocity = {elements[3], elements[4], elements[5]};
      }
      return true;
    }
    case frmStateRepresentation::KEPLERIAN: {
      const orb::Keplerian k{elements[0], elements[1], elements[2],
                             elements[3], elements[4], elements[5]};
      if (orb::cartesianFromKeplerian(k, mu, out)) return true;
      break;
    }
    case frmStateRepresentation::MODIFIED_KEPLERIAN: {
      const orb::ModifiedKeplerian mk{elements[0], elements[1], elements[2],
                                      elements[3], elements[4], elements[5]};
      orb::Keplerian k;
      if (orb::keplerianFromModifiedKeplerian(mk, &k) &&
          orb::cartesianFromKeplerian(k, mu, out)) {
        return true;
      }
      break;
    }
    case frmStateRepresentation::SPHERICAL_AZFPA: {
      // GMAT/SDS order: RMAG, RA, DEC, VMAG, AZI, FPA.
      const orb::SphericalAZFPA s{elements[0], elements[1], elements[2],
                                  elements[3], elements[5], elements[4]};
      if (orb::cartesianFromSphericalAzfpa(s, out)) return true;
      break;
    }
    case frmStateRepresentation::SPHERICAL_RADEC: {
      const orb::SphericalRADEC s{elements[0], elements[1], elements[2],
                                  elements[3], elements[4], elements[5]};
      if (orb::cartesianFromSphericalRadec(s, out)) return true;
      break;
    }
    case frmStateRepresentation::EQUINOCTIAL: {
      const orb::Equinoctial e{elements[0], elements[1], elements[2],
                               elements[3], elements[4], elements[5]};
      if (orb::cartesianFromEquinoctial(e, mu, out)) return true;
      break;
    }
    case frmStateRepresentation::MODIFIED_EQUINOCTIAL: {
      const orb::ModifiedEquinoctial e{elements[0], elements[1], elements[2],
                                       elements[3], elements[4], elements[5]};
      if (orb::cartesianFromModifiedEquinoctial(e, mu, out)) return true;
      break;
    }
    case frmStateRepresentation::ALTERNATE_EQUINOCTIAL: {
      const orb::AlternateEquinoctial e{elements[0], elements[1], elements[2],
                                        elements[3], elements[4], elements[5]};
      if (orb::cartesianFromAlternateEquinoctial(e, mu, out)) return true;
      break;
    }
    case frmStateRepresentation::DELAUNAY: {
      const orb::Delaunay d{elements[0], elements[1], elements[2],
                            elements[3], elements[4], elements[5]};
      orb::Keplerian k;
      if (orb::keplerianFromDelaunay(d, mu, &k) && orb::cartesianFromKeplerian(k, mu, out)) {
        return true;
      }
      break;
    }
    case frmStateRepresentation::PLANETODETIC: {
      // GMAT/SDS order: LAT, LON, HGT, VMAG, AZI, HFPA.
      const orb::Planetodetic p{elements[0], elements[1], elements[2],
                                elements[3], elements[5], elements[4]};
      if (orb::cartesianFromPlanetodetic(p, ellipsoid, out)) return true;
      break;
    }
    case frmStateRepresentation::INCOMING_ASYMPTOTE:
    case frmStateRepresentation::OUTGOING_ASYMPTOTE: {
      const orb::Asymptote a{elements[0], elements[1], elements[2],
                             elements[3], elements[4], elements[5]};
      orb::Keplerian k;
      const bool incoming = representation == frmStateRepresentation::INCOMING_ASYMPTOTE;
      if (orb::keplerianFromAsymptote(a, mu, incoming, &k) &&
          orb::cartesianFromKeplerian(k, mu, out)) {
        return true;
      }
      break;
    }
    case frmStateRepresentation::BROUWER_MEAN_SHORT:
    case frmStateRepresentation::BROUWER_MEAN_LONG:
      // NOT IMPLEMENTED, and deliberately not approximated. The Brouwer (1959)
      // mean/osculating transformation is only admissible here against the
      // published worked example this task's acceptance names, and that vector
      // is not in the tree. A first-order transcription checked by nothing but
      // its own round trip would look right and be unfalsifiable, which is the
      // failure mode the program's vector-provenance rule exists to prevent.
      *status = frmResultStatus::UNSUPPORTED_STATE_REPRESENTATION;
      *message =
          "Brouwer mean elements are not implemented by this provider.";
      return false;
    default:
      *status = frmResultStatus::UNSUPPORTED_STATE_REPRESENTATION;
      *message = "This element set is not implemented by this provider.";
      return false;
  }
  *status = frmResultStatus::SINGULAR_ELEMENT_SET;
  *message =
      "The state is at a singularity of the requested element set; this "
      "provider reports it rather than substituting another set.";
  return false;
}

/// Cartesian -> element set.
bool elements_from_cartesian(frmStateRepresentation representation, const orb::Cartesian& state,
                             double mu, const orb::Ellipsoid& ellipsoid, double* elements,
                             frmResultStatus* status, const char** message) {
  *status = frmResultStatus::OK;
  *message = nullptr;
  orb::Keplerian k;
  const bool haveKeplerian = orb::keplerianFromCartesian(state, mu, &k);
  switch (representation) {
    case frmStateRepresentation::CARTESIAN:
      elements[0] = state.position.x; elements[1] = state.position.y;
      elements[2] = state.position.z; elements[3] = state.velocity.x;
      elements[4] = state.velocity.y; elements[5] = state.velocity.z;
      return true;
    case frmStateRepresentation::KEPLERIAN:
      if (!haveKeplerian) break;
      elements[0] = k.semiMajorAxis; elements[1] = k.eccentricity;
      elements[2] = k.inclination; elements[3] = k.raan;
      elements[4] = k.argumentOfPeriapsis; elements[5] = k.trueAnomaly;
      return true;
    case frmStateRepresentation::MODIFIED_KEPLERIAN: {
      orb::ModifiedKeplerian mk;
      if (!haveKeplerian || !orb::modifiedKeplerianFromKeplerian(k, &mk)) break;
      elements[0] = mk.radiusOfPeriapsis; elements[1] = mk.radiusOfApoapsis;
      elements[2] = mk.inclination; elements[3] = mk.raan;
      elements[4] = mk.argumentOfPeriapsis; elements[5] = mk.trueAnomaly;
      return true;
    }
    case frmStateRepresentation::SPHERICAL_AZFPA: {
      orb::SphericalAZFPA s;
      if (!orb::sphericalAzfpaFromCartesian(state, &s)) break;
      elements[0] = s.radius; elements[1] = s.rightAscension;
      elements[2] = s.declination; elements[3] = s.speed;
      elements[4] = s.azimuth; elements[5] = s.flightPathAngle;
      return true;
    }
    case frmStateRepresentation::SPHERICAL_RADEC: {
      orb::SphericalRADEC s;
      if (!orb::sphericalRadecFromCartesian(state, &s)) break;
      elements[0] = s.radius; elements[1] = s.rightAscension;
      elements[2] = s.declination; elements[3] = s.speed;
      elements[4] = s.velocityRightAscension; elements[5] = s.velocityDeclination;
      return true;
    }
    case frmStateRepresentation::EQUINOCTIAL: {
      orb::Equinoctial e;
      if (!haveKeplerian || !orb::equinoctialFromKeplerian(k, 1, &e)) break;
      elements[0] = e.semiMajorAxis; elements[1] = e.h; elements[2] = e.k;
      elements[3] = e.p; elements[4] = e.q; elements[5] = e.meanLongitude;
      return true;
    }
    case frmStateRepresentation::MODIFIED_EQUINOCTIAL: {
      orb::ModifiedEquinoctial e;
      if (!orb::modifiedEquinoctialFromCartesian(state, mu, 1, &e)) break;
      elements[0] = e.semiLatusRectum; elements[1] = e.f; elements[2] = e.g;
      elements[3] = e.h; elements[4] = e.k; elements[5] = e.trueLongitude;
      return true;
    }
    case frmStateRepresentation::ALTERNATE_EQUINOCTIAL: {
      orb::AlternateEquinoctial e;
      if (!orb::alternateEquinoctialFromCartesian(state, mu, 1, &e)) break;
      elements[0] = e.meanMotion; elements[1] = e.h; elements[2] = e.k;
      elements[3] = e.p; elements[4] = e.q; elements[5] = e.meanLongitude;
      return true;
    }
    case frmStateRepresentation::DELAUNAY: {
      orb::Delaunay d;
      if (!haveKeplerian || !orb::delaunayFromKeplerian(k, mu, &d)) break;
      elements[0] = d.l; elements[1] = d.g; elements[2] = d.h;
      elements[3] = d.L; elements[4] = d.G; elements[5] = d.H;
      return true;
    }
    case frmStateRepresentation::PLANETODETIC: {
      orb::Planetodetic p;
      if (!orb::planetodeticFromCartesian(state, ellipsoid, &p)) break;
      elements[0] = p.latitude; elements[1] = p.longitude; elements[2] = p.height;
      elements[3] = p.speed; elements[4] = p.azimuth;
      elements[5] = p.flightPathAngle;
      return true;
    }
    case frmStateRepresentation::INCOMING_ASYMPTOTE:
    case frmStateRepresentation::OUTGOING_ASYMPTOTE: {
      orb::Asymptote a;
      const bool incoming = representation == frmStateRepresentation::INCOMING_ASYMPTOTE;
      if (!haveKeplerian || !orb::asymptoteFromKeplerian(k, mu, incoming, &a)) break;
      elements[0] = a.radiusOfPeriapsis; elements[1] = a.c3Energy;
      elements[2] = a.asymptoteRightAscension; elements[3] = a.asymptoteDeclination;
      elements[4] = a.velocityAzimuthAtPeriapsis; elements[5] = a.trueAnomaly;
      return true;
    }
    case frmStateRepresentation::BROUWER_MEAN_SHORT:
    case frmStateRepresentation::BROUWER_MEAN_LONG:
      // See the matching case in cartesian_from_elements.
      *status = frmResultStatus::UNSUPPORTED_STATE_REPRESENTATION;
      *message =
          "Brouwer mean elements are not implemented by this provider.";
      return false;
    default:
      *status = frmResultStatus::UNSUPPORTED_STATE_REPRESENTATION;
      *message = "This element set is not implemented by this provider.";
      return false;
  }
  *status = frmResultStatus::SINGULAR_ELEMENT_SET;
  *message =
      "The state is at a singularity of the requested element set; this "
      "provider reports it rather than substituting another set.";
  return false;
}

/// $FRM carries the ellipsoid as two RADII; the element-set library takes a
/// radius and a flattening. WGS-84 is the default when the request omits them,
/// which is the only body this provider's planetodetic set is defined for.
orb::Ellipsoid make_ellipsoid(const FRMFrameTransformRequest* request) {
  const double a = valid_equatorial_radius(request->EQUATORIAL_RADIUS_M())
      ? request->EQUATORIAL_RADIUS_M()
      : 6378137.0;
  const double b = request->POLAR_RADIUS_M() > 0.0 ? request->POLAR_RADIUS_M() : 6356752.314245;
  return orb::Ellipsoid{a, (a - b) / a};
}

double resolve_mu(const FRMStateVector* state, int originBodyId, bool* found) {
  if (state != nullptr && state->GRAVITATIONAL_PARAMETER() > 0.0) {
    *found = true;
    return state->GRAVITATIONAL_PARAMETER();
  }
  return bodyGm(originBodyId, found);
}

void read_elements(const FRMStateVector* state, double* elements) {
  for (int i = 0; i < 6; ++i) {
    elements[i] = 0.0;
  }
  if (state == nullptr || state->ELEMENTS() == nullptr) {
    return;
  }
  const auto* values = state->ELEMENTS();
  const std::size_t count = values->size() < 6 ? values->size() : 6;
  for (std::size_t i = 0; i < count; ++i) {
    elements[i] = values->Get(static_cast<::flatbuffers::uoffset_t>(i));
  }
}

// ===========================================================================

TransformOutput evaluate_state_operations(const FRMFrameTransformRequest* request,
                                          const EvaluationContext& context) {
  TransformOutput out;
  const frmOperationCode operation = request->OPERATION();

  ResolvedSystem source;
  frmResultStatus status = frmResultStatus::OK;
  const char* message = nullptr;

  const RFMCoordinateSystem* sourceSystem = request->SOURCE_COORDINATE_SYSTEM();
  const RFMCoordinateSystem* targetSystem = request->TARGET_COORDINATE_SYSTEM();

  if (operation == frmOperationCode::STATE_REPRESENTATION_CONVERT) {
    // One coordinate system, two element sets. No rotation, no translation.
    const FRMStateVector* state = request->SOURCE_STATE();
    if (state == nullptr) {
      return {frmResultStatus::INVALID_INPUT,
              "STATE_REPRESENTATION_CONVERT requires SOURCE_STATE.", {}};
    }
    int originBodyId = kRootBodyId;
    if (sourceSystem != nullptr && sourceSystem->ORIGIN() != nullptr &&
        sourceSystem->ORIGIN()->KIND() == rfmOriginKind::CELESTIAL_BODY) {
      originBodyId = sourceSystem->ORIGIN()->CELESTIAL_BODY_ID();
    }
    bool haveMu = false;
    const double mu = resolve_mu(state, originBodyId, &haveMu);
    if (!haveMu) {
      return {frmResultStatus::INVALID_INPUT,
              "No gravitational parameter for this origin; supply "
              "GRAVITATIONAL_PARAMETER on the state.",
              {}};
    }
    const orb::Ellipsoid ellipsoid = make_ellipsoid(request);

    double elements[6];
    read_elements(state, elements);
    const ax::Vec3 position = state->POSITION() != nullptr
        ? ax::Vec3{state->POSITION()->X(), state->POSITION()->Y(), state->POSITION()->Z()}
        : ax::Vec3{};
    const ax::Vec3 velocity = state->VELOCITY() != nullptr
        ? ax::Vec3{state->VELOCITY()->X(), state->VELOCITY()->Y(), state->VELOCITY()->Z()}
        : ax::Vec3{};

    orb::Cartesian cartesian;
    if (!cartesian_from_elements(state->REPRESENTATION(), elements, position, velocity, mu,
                                 ellipsoid, &cartesian, &status, &message)) {
      return {status, message, {}};
    }
    if (!elements_from_cartesian(request->TARGET_REPRESENTATION(), cartesian, mu, ellipsoid,
                                 out.elements, &status, &message)) {
      return {status, message, {}};
    }
    out.status = frmResultStatus::OK;
    out.hasState = true;
    out.representation = request->TARGET_REPRESENTATION();
    out.statePosition = {cartesian.position.x, cartesian.position.y, cartesian.position.z};
    out.stateVelocity = {cartesian.velocity.x, cartesian.velocity.y, cartesian.velocity.z};
    out.gravitationalParameter = mu;
    out.coordinateSystemName =
        sourceSystem != nullptr && sourceSystem->NAME() != nullptr ? sourceSystem->NAME()->c_str()
                                                                   : nullptr;
    out.epoch = request->EPOCH() != nullptr ? request->EPOCH()->c_str() : nullptr;
    out.epochTimeSystem =
        request->EPOCH_TIME_SYSTEM() != nullptr ? request->EPOCH_TIME_SYSTEM()->c_str() : nullptr;
    out.eopDataSetEpoch = context.eopDataSetEpoch;
    out.eopDataSetCid = context.eopDataSetCid;
    return out;
  }

  ResolvedSystem target;
  if (!resolve_system(sourceSystem, context, &source, &status, &message)) {
    return {status, message, {}};
  }
  if (!resolve_system(targetSystem, context, &target, &status, &message)) {
    return {status, message, {}};
  }

  // Rotation source -> target and its derivative.
  const ax::Mat3 rotation = ax::multiply(target.rotation, ax::transpose(source.rotation));
  ax::Mat3 rotationRate;
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      double sum = 0.0;
      for (int k = 0; k < 3; ++k) {
        sum += target.rotationRate.m[i][k] * source.rotation.m[j][k] +
            target.rotation.m[i][k] * source.rotationRate.m[j][k];
      }
      rotationRate.m[i][j] = sum;
    }
  }
  out.rotation = to_matrix3(rotation);
  out.rotationRate = to_matrix3(rotationRate);
  out.angularVelocity = to_vec3(ax::angularVelocityInSourceAxes(rotation, rotationRate));
  out.hasRotation = true;
  out.eopDataSetEpoch = context.eopDataSetEpoch;
  out.eopDataSetCid = context.eopDataSetCid;
  out.epoch = request->EPOCH() != nullptr ? request->EPOCH()->c_str() : nullptr;
  out.epochTimeSystem =
      request->EPOCH_TIME_SYSTEM() != nullptr ? request->EPOCH_TIME_SYSTEM()->c_str() : nullptr;

  if (operation == frmOperationCode::FRAME_ROTATION) {
    out.status = frmResultStatus::OK;
    return out;
  }

  // --- STATE_TRANSFORM -----------------------------------------------------
  const FRMStateVector* state = request->SOURCE_STATE();
  if (state == nullptr) {
    return {frmResultStatus::INVALID_INPUT, "STATE_TRANSFORM requires SOURCE_STATE.", {}};
  }
  bool haveMu = false;
  const double sourceMu = resolve_mu(state, source.originBodyId, &haveMu);
  if (!haveMu) {
    return {frmResultStatus::INVALID_INPUT,
            "No gravitational parameter for the source origin; supply "
            "GRAVITATIONAL_PARAMETER on the state.",
            {}};
  }
  const orb::Ellipsoid ellipsoid = make_ellipsoid(request);

  double elements[6];
  read_elements(state, elements);
  const ax::Vec3 statePosition = state->POSITION() != nullptr
      ? ax::Vec3{state->POSITION()->X(), state->POSITION()->Y(), state->POSITION()->Z()}
      : ax::Vec3{};
  const ax::Vec3 stateVelocity = state->VELOCITY() != nullptr
      ? ax::Vec3{state->VELOCITY()->X(), state->VELOCITY()->Y(), state->VELOCITY()->Z()}
      : ax::Vec3{};

  orb::Cartesian inSource;
  if (!cartesian_from_elements(state->REPRESENTATION(), elements, statePosition, stateVelocity,
                               sourceMu, ellipsoid, &inSource, &status, &message)) {
    return {status, message, {}};
  }

  // Lift to the root axes about the root origin, then drop into the target.
  const ax::Vec3 rSource{inSource.position.x, inSource.position.y, inSource.position.z};
  const ax::Vec3 vSource{inSource.velocity.x, inSource.velocity.y, inSource.velocity.z};
  const ax::Mat3 sourceToRoot = ax::transpose(source.rotation);
  const ax::Vec3 rRoot = ax::add(ax::apply(sourceToRoot, rSource), source.originPosition);
  // v_source = R_s (v_root - originVel) + R_s_dot (r_root - originPos)
  //   => v_root = R_s^T (v_source - R_s_dot (r_root - originPos)) + originVel
  const ax::Vec3 relativeRoot = ax::sub(rRoot, source.originPosition);
  const ax::Vec3 vRoot = ax::add(
      ax::apply(sourceToRoot, ax::sub(vSource, ax::apply(source.rotationRate, relativeRoot))),
      source.originVelocity);

  const ax::Vec3 relativeTarget = ax::sub(rRoot, target.originPosition);
  const ax::Vec3 rTarget = ax::apply(target.rotation, relativeTarget);
  const ax::Vec3 vTarget = ax::add(
      ax::apply(target.rotation, ax::sub(vRoot, target.originVelocity)),
      ax::apply(target.rotationRate, relativeTarget));

  const orb::Cartesian inTarget{{rTarget.x, rTarget.y, rTarget.z},
                                {vTarget.x, vTarget.y, vTarget.z}};
  bool haveTargetMu = false;
  const double targetMu = bodyGm(target.originBodyId, &haveTargetMu);
  const double muForTarget = haveTargetMu ? targetMu : sourceMu;

  const frmStateRepresentation targetRepresentation =
      request->TARGET_REPRESENTATION() == frmStateRepresentation::UNSPECIFIED
          ? frmStateRepresentation::CARTESIAN
          : request->TARGET_REPRESENTATION();
  if (!elements_from_cartesian(targetRepresentation, inTarget, muForTarget, ellipsoid,
                               out.elements, &status, &message)) {
    return {status, message, {}};
  }

  out.status = frmResultStatus::OK;
  out.hasState = true;
  out.representation = targetRepresentation;
  out.statePosition = {rTarget.x, rTarget.y, rTarget.z};
  out.stateVelocity = {vTarget.x, vTarget.y, vTarget.z};
  out.gravitationalParameter = muForTarget;
  out.coordinateSystemName =
      targetSystem != nullptr && targetSystem->NAME() != nullptr ? targetSystem->NAME()->c_str()
                                                                 : nullptr;
  out.position = {rTarget.x, rTarget.y, rTarget.z};
  return out;
}

TransformOutput evaluate_frame_transform(const FRMFrameTransformRequest* request,
                                         const EvaluationContext& context) {
  if (request == nullptr) {
    return {frmResultStatus::INVALID_INPUT, "Frame transform request is missing.", {}};
  }

  switch (request->OPERATION()) {
    case frmOperationCode::STATE_TRANSFORM:
    case frmOperationCode::FRAME_ROTATION:
    case frmOperationCode::STATE_REPRESENTATION_CONVERT:
      return evaluate_state_operations(request, context);
    default:
      break;
  }

  if (request->POSITION() == nullptr) {
    return {frmResultStatus::INVALID_INPUT, "Frame transform request requires POSITION.", {}};
  }

  const Vec3 position = read_vec3(request->POSITION());
  if (!is_finite(position)) {
    return {frmResultStatus::INVALID_INPUT, "Frame transform request contains a non-finite POSITION.", {}};
  }

  switch (request->OPERATION()) {
    case frmOperationCode::PCI_TO_PCPF: {
      if (request->TRANSFORM_DCM() == nullptr) {
        return {frmResultStatus::INVALID_INPUT, "PCI_TO_PCPF requires TRANSFORM_DCM.", {}};
      }
      const Matrix3 transform = read_matrix(request->TRANSFORM_DCM());
      if (!is_finite(transform)) {
        return {frmResultStatus::INVALID_INPUT, "PCI_TO_PCPF received a non-finite TRANSFORM_DCM.", {}};
      }
      return {frmResultStatus::OK, nullptr, multiply(transform, position)};
    }
    case frmOperationCode::PCPF_TO_PCI: {
      if (request->TRANSFORM_DCM() == nullptr) {
        return {frmResultStatus::INVALID_INPUT, "PCPF_TO_PCI requires TRANSFORM_DCM.", {}};
      }
      const Matrix3 transform = read_matrix(request->TRANSFORM_DCM());
      if (!is_finite(transform)) {
        return {frmResultStatus::INVALID_INPUT, "PCPF_TO_PCI received a non-finite TRANSFORM_DCM.", {}};
      }
      return {frmResultStatus::OK, nullptr, transpose_multiply(transform, position)};
    }
    case frmOperationCode::LLA_TO_PCPF: {
      Vec3 output;
      if (!lla_to_pcpf(position, request->EQUATORIAL_RADIUS_M(), request->POLAR_RADIUS_M(), &output)) {
        return {frmResultStatus::INVALID_INPUT, "LLA_TO_PCPF received invalid geodetic or ellipsoid parameters.", {}};
      }
      return {frmResultStatus::OK, nullptr, output};
    }
    case frmOperationCode::PCPF_TO_LLA: {
      Vec3 output;
      if (!pcpf_to_lla(position, request->EQUATORIAL_RADIUS_M(), request->POLAR_RADIUS_M(), &output)) {
        return {frmResultStatus::INVALID_INPUT, "PCPF_TO_LLA received invalid Cartesian or ellipsoid parameters.", {}};
      }
      return {frmResultStatus::OK, nullptr, output};
    }
    case frmOperationCode::UNKNOWN:
    default:
      return {frmResultStatus::UNSUPPORTED_OPERATION, "FRM operation is not supported.", {}};
  }
}

int emit_frame_transform_result(const TransformOutput& output, const char* trace_id) {
  ::flatbuffers::FlatBufferBuilder builder(2048);
  const auto position = CreateFRMVector3(builder, output.position.x, output.position.y, output.position.z);

  ::flatbuffers::Offset<FRMStateVector> targetState = 0;
  if (output.hasState) {
    const std::vector<double> elements(output.elements, output.elements + 6);
    targetState = CreateFRMStateVectorDirect(
        builder,
        output.representation,
        &elements,
        CreateFRMVector3(builder, output.statePosition.x, output.statePosition.y,
                         output.statePosition.z),
        CreateFRMVector3(builder, output.stateVelocity.x, output.stateVelocity.y,
                         output.stateVelocity.z),
        output.coordinateSystemName,
        output.epoch,
        output.epochTimeSystem,
        output.gravitationalParameter);
  }

  ::flatbuffers::Offset<FRMMatrix3> rotation = 0;
  ::flatbuffers::Offset<FRMMatrix3> rotationRate = 0;
  ::flatbuffers::Offset<FRMVector3> angularVelocity = 0;
  if (output.hasRotation) {
    rotation = CreateFRMMatrix3(builder, output.rotation.m11, output.rotation.m12,
                                output.rotation.m13, output.rotation.m21, output.rotation.m22,
                                output.rotation.m23, output.rotation.m31, output.rotation.m32,
                                output.rotation.m33);
    rotationRate = CreateFRMMatrix3(
        builder, output.rotationRate.m11, output.rotationRate.m12, output.rotationRate.m13,
        output.rotationRate.m21, output.rotationRate.m22, output.rotationRate.m23,
        output.rotationRate.m31, output.rotationRate.m32, output.rotationRate.m33);
    angularVelocity = CreateFRMVector3(builder, output.angularVelocity.x,
                                       output.angularVelocity.y, output.angularVelocity.z);
  }

  const auto result = CreateFRMFrameTransformResultDirect(
      builder,
      output.status,
      output.message,
      position,
      trace_id,
      targetState,
      rotation,
      rotationRate,
      angularVelocity,
      output.eopDataSetEpoch,
      output.eopDataSetCid);
  const auto envelope = CreateFRM(builder, 0, result);
  FinishFRMBuffer(builder, envelope);

  if (plugin_push_output(
          "result",
          "FRM.fbs",
          "$FRM",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit FRM frame-transform result.");
    return 1;
  }
  return 0;
}

const plugin_input_frame_t* find_frame(const char* portId) {
  const uint32_t input_count = plugin_get_input_count();
  for (uint32_t index = 0; index < input_count; ++index) {
    const plugin_input_frame_t* frame = plugin_get_input_frame(index);
    if (frame != nullptr && frame->port_id != nullptr && std::strcmp(frame->port_id, portId) == 0) {
      return frame;
    }
  }
  return nullptr;
}

// EOP table helpers are inserted here by the SDK build.
#include "eop_table.hpp"

/// Read the referenced object's state, in the ROOT axes about the root origin.
void read_object_state(EvaluationContext* context) {
  const plugin_input_frame_t* frame = find_frame("object_state");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0) {
    return;
  }
  if (!FRMBufferHasIdentifier(frame->payload)) {
    return;
  }
  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyFRMBuffer(verifier)) {
    return;
  }
  const FRM* envelope = GetFRM(frame->payload);
  const FRMFrameTransformRequest* request =
      envelope != nullptr ? envelope->FRAME_TRANSFORM_REQUEST() : nullptr;
  const FRMStateVector* state = request != nullptr ? request->SOURCE_STATE() : nullptr;
  if (state == nullptr || state->POSITION() == nullptr || state->VELOCITY() == nullptr) {
    return;
  }
  context->objectPositionRoot = {state->POSITION()->X(), state->POSITION()->Y(),
                                 state->POSITION()->Z()};
  context->objectVelocityRoot = {state->VELOCITY()->X(), state->VELOCITY()->Y(),
                                 state->VELOCITY()->Z()};
  if (request->SOURCE_COORDINATE_SYSTEM() != nullptr &&
      request->SOURCE_COORDINATE_SYSTEM()->ORIGIN() != nullptr &&
      request->SOURCE_COORDINATE_SYSTEM()->ORIGIN()->OBJECT_ID() != nullptr) {
    context->objectId = request->SOURCE_COORDINATE_SYSTEM()->ORIGIN()->OBJECT_ID()->c_str();
  }
  context->haveObjectState = true;
}

}  // namespace

extern "C" int transform_frame_position(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_frame("request");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0) {
    plugin_set_error("missing-request", "No FRM frame-transform request frame was provided.");
    return 3;
  }
  if (!FRMBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-request-buffer", "Input is not an SDS FRM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyFRMBuffer(verifier)) {
    plugin_set_error("invalid-request-buffer", "Input is not a valid SDS FRM FlatBuffer.");
    return 3;
  }

  const FRM* envelope = GetFRM(frame->payload);
  const FRMFrameTransformRequest* request = envelope ? envelope->FRAME_TRANSFORM_REQUEST() : nullptr;
  const char* trace_id = request && request->TRACE_ID() ? request->TRACE_ID()->c_str() : nullptr;

  EvaluationContext context;
  read_object_state(&context);

  // The geomagnetic dipole model is a PARAMETER of GSM. IGRF-13 epoch 2020.0
  // geographic north dipole pole: 80.65 N, 287.32 E; the colatitude below is
  // its complement. A caller reproducing another epoch supplies its own axes
  // through LOCAL_ALIGNED_CONSTRAINED rather than silently getting this one.
  context.dipole.colatitude = (90.0 - 80.65) * (ERFA_DPI / 180.0);
  context.dipole.eastLongitude = 287.32 * (ERFA_DPI / 180.0);

  if (request != nullptr &&
      (request->OPERATION() == frmOperationCode::STATE_TRANSFORM ||
       request->OPERATION() == frmOperationCode::FRAME_ROTATION ||
       request->OPERATION() == frmOperationCode::STATE_REPRESENTATION_CONVERT)) {
    const char* epochText = request->EPOCH() != nullptr ? request->EPOCH()->c_str() : nullptr;
    const char* scale =
        request->EPOCH_TIME_SYSTEM() != nullptr ? request->EPOCH_TIME_SYSTEM()->c_str() : "UTC";
    if (epochText == nullptr) {
      return emit_frame_transform_result(
          {frmResultStatus::INVALID_INPUT,
           "This operation requires EPOCH; a time-dependent axis chain is never "
           "evaluated at an assumed epoch.",
           {}},
          trace_id);
    }
    if (std::strcmp(scale, "UTC") != 0) {
      return emit_frame_transform_result(
          {frmResultStatus::INVALID_INPUT,
           "EPOCH_TIME_SYSTEM must be UTC for this provider; convert with the "
           "$TIM time module first.",
           {}},
          trace_id);
    }
    int year = 0, month = 0, day = 0, hour = 0, minute = 0;
    double second = 0.0;
    if (!parse_iso_utc(epochText, &year, &month, &day, &hour, &minute, &second)) {
      return emit_frame_transform_result(
          {frmResultStatus::INVALID_INPUT, "EPOCH is not an ISO 8601 UTC timestamp.", {}},
          trace_id);
    }
    double utc1, utc2;
    if (eraDtf2d("UTC", year, month, day, hour, minute, second, &utc1, &utc2) != 0) {
      return emit_frame_transform_result({frmResultStatus::INVALID_INPUT, "Invalid UTC epoch.", {}}, trace_id);
    }
    const EOP* eopProvenance = nullptr;
    const std::string eopError = read_eop_table(utc1, utc2, &context.eop, &eopProvenance, &context.eopSupplied);
    if (!eopError.empty()) {
      return emit_frame_transform_result({frmResultStatus::INVALID_INPUT, eopError.c_str(), {}}, trace_id);
    }
    if (eopProvenance) {
      context.eopDataSetEpoch = eopProvenance->DATA_SET_EPOCH() ? eopProvenance->DATA_SET_EPOCH()->c_str() : nullptr;
      context.eopDataSetCid = eopProvenance->DATA_SET_CID() ? eopProvenance->DATA_SET_CID()->c_str() : nullptr;
    }
    if (!ax::epochFromUtc(year, month, day, hour, minute, second, context.eop, &context.epoch)) {
      return emit_frame_transform_result(
          {frmResultStatus::INVALID_INPUT,
           "EPOCH lies outside the leap-second table; this provider refuses "
           "rather than extrapolating.",
           {}},
          trace_id);
    }
    if (eopProvenance && eopProvenance->IAU_CONVENTION() == iauPrecessionNutationModel::IAU_2000A) {
      // Preserve the observed CIP when moving offsets from IAU 2000A to 2006/2000A.
      // SOFA Earth Attitude cookbook section 5.1 footnote 2.
      double x00,y00,s00,x06,y06;
      eraXys00a(context.epoch.tt1,context.epoch.tt2,&x00,&y00,&s00);
      eraXy06(context.epoch.tt1,context.epoch.tt2,&x06,&y06);
      context.eop.dX += x00-x06;
      context.eop.dY += y00-y06;
    }
  }

  return emit_frame_transform_result(evaluate_frame_transform(request, context), trace_id);
}
