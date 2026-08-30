// parameter_catalog.hpp — the named calculation-parameter evaluator.
//
// GMAT-parity program item 6
// (graph/tasks/gmat-06-parameter-catalog-and-event-locators.md).
//
// ONE evaluator for every named parameter in the roster. Stopping conditions,
// targeting goals, report files and plots all resolve a NAME through
// `src/generated/parameter_roster.hpp` and then evaluate it here, so there is
// exactly one answer to "what is SMA" in the stack rather than one per consumer.
//
// UNITS, normative and unconditional:
//   position  metres          velocity  metres per second
//   angles    RADIANS         time      seconds / days as the roster says
//   mu        m^3 / s^2
// The roster's `unit` string is the contract; the SDS envelope converts at the
// wire if its IDL says degrees, never here.
//
// WHAT THIS HEADER DOES NOT DO. It owns no element-set conversion and no frame
// chain. Element sets come from foundation/orbits/src/state_representations.hpp
// and rotations from foundation/frames/src/axis_engine.hpp — the same two
// headers the frames module compiles, so a parameter and a coordinate-system
// transform can never disagree about what a Keplerian element is. What lives
// here is the parameter VOCABULARY and the handful of quantities that are not
// element-set members: the B-plane, the angular-momentum triple, the
// planet-relative angles, the time scales and the state-transition sub-blocks.
//
// AUTHORITY FOR THE DEFINITIONS. Every formula below is the one in the
// reference mission-analysis tool's own Apache-2.0 source at the commit the
// parity program names (`src/gmatutil/util/CalculationUtilities.cpp`,
// `08c2a2aae0b5fed077b2e7b4fda992ff54386c60`), transcribed with its convention
// intact — which asymptote the B-plane is taken on, which sign the beta angle
// carries, which of the two sidereal series an hour angle uses. Parity against
// a tool whose conventions were guessed at is not parity.
//
// This header needs the vendored ERFA (through axis_engine.hpp) for the time
// scales, the sidereal series and the solar direction. It is otherwise
// dependency-free and compiles unchanged into the WASM module and into the
// native parity harness.

#ifndef SDN_ANALYSIS_PARAMETERS_PARAMETER_CATALOG_HPP
#define SDN_ANALYSIS_PARAMETERS_PARAMETER_CATALOG_HPP

#include <cmath>
#include <cstdint>

namespace sdn {
namespace parameters {

namespace ax = ::sdn::frames;
namespace orb = ::sdn::orbits;

// ---------------------------------------------------------------------------
// Outcome of one evaluation. Never an exception, never a silent substitution:
// a parameter that cannot be answered says which kind of "cannot".
// ---------------------------------------------------------------------------
enum class Status : uint8_t {
  OK = 0,
  /// The name is not in the roster. Refused, never guessed at.
  UNKNOWN_PARAMETER = 1,
  /// In the roster, but its owner family does not exist in this build yet.
  /// The descriptor's `availability` says which family.
  NOT_IMPLEMENTED = 2,
  /// The evaluation needs an input the caller did not supply (Earth
  /// orientation for a body-fixed chain, a reference epoch for an elapsed
  /// time, a state-transition matrix, a stated ballistic property).
  MISSING_INPUT = 3,
  /// Well-formed request, but the quantity does not exist for this orbit —
  /// a B-plane on a bound orbit, an eccentric anomaly on a hyperbola.
  UNDEFINED_FOR_THIS_ORBIT = 4,
  /// The underlying conversion refused (degenerate geometry, non-finite input).
  NUMERICAL_FAILURE = 5,
  /// The central body is not one this build carries an ephemeris or a rotation
  /// model for.
  UNSUPPORTED_CENTRAL_BODY = 6,
};

/// Properties the caller STATES rather than the module computing. A ballistic
/// coefficient is a fact about a spacecraft, not a function of its state; the
/// module echoes what it is given and returns MISSING_INPUT when it is not
/// given, because a defaulted drag area is a different spacecraft.
struct StatedProperties {
  double dryMass = 0.0;
  double totalMass = 0.0;
  double dragCoefficient = 0.0;
  double reflectivityCoefficient = 0.0;
  double dragArea = 0.0;
  double solarRadiationPressureArea = 0.0;
  double dragScaleFactor = 0.0;
  double solarRadiationPressureScaleFactor = 0.0;
  double atmosphericDensityScaleFactor = 0.0;

  bool hasDryMass = false;
  bool hasTotalMass = false;
  bool hasDragCoefficient = false;
  bool hasReflectivityCoefficient = false;
  bool hasDragArea = false;
  bool hasSolarRadiationPressureArea = false;
  bool hasDragScaleFactor = false;
  bool hasSolarRadiationPressureScaleFactor = false;
  bool hasAtmosphericDensityScaleFactor = false;
};

/// Everything one evaluation needs. The state is expressed in the caller's
/// chosen coordinate system; that system's resolution is the frames module's
/// job and has already happened by the time this struct is built.
struct EvaluationContext {
  /// TT/UT1 two-part Julian dates, from `frames::epochFromUtc`.
  ax::Epoch epoch;
  /// UTC as a two-part Julian date. Carried separately because the time
  /// parameters report UTC itself and re-deriving it from TT would lose the
  /// leap second the caller already resolved.
  double utc1 = 0.0;
  double utc2 = 0.0;
  bool epochSupplied = false;

  ax::EarthOrientation earthOrientation;
  bool earthOrientationSupplied = false;

  /// Central body of the coordinate system, as a `frames::BodyId`.
  int centralBodyId = 399;
  /// Gravitational parameter of that body, m^3/s^2. Zero means "not supplied".
  double gravitationalParameter = 0.0;
  /// Reference ellipsoid of that body, for the planetodetic quantities.
  orb::Ellipsoid ellipsoid;

  /// The state, in the caller's coordinate system. Inertial (non-rotating)
  /// axes about the central body: the planet-relative parameters rotate it to
  /// body-fixed themselves, because doing so needs the epoch and the Earth
  /// orientation that live here.
  orb::Cartesian state;

  /// Reference epoch for ElapsedDays / ElapsedSecs, as a two-part UTC JD.
  double referenceUtc1 = 0.0;
  double referenceUtc2 = 0.0;
  bool referenceEpochSupplied = false;

  /// Row-major 6x6 state-transition matrix, when the propagator produced one.
  double stateTransitionMatrix[36] = {0.0};
  bool stateTransitionMatrixSupplied = false;

  StatedProperties properties;
};

// ---------------------------------------------------------------------------
// Constants that are DEFINITIONS, not measurements.
// ---------------------------------------------------------------------------

/// A1 - TAI, seconds. A definition of the A1 atomic scale, not a measurement,
/// so it is compared with `==` and never with a tolerance.
constexpr double kA1MinusTaiSeconds = 0.0343817;

/// Modified Julian Date offset, JD - 2400000.5. The one `$TIM` carries.
constexpr double kModifiedJulianDateOffset = 2400000.5;

constexpr double kSecondsPerDay = 86400.0;

// ---------------------------------------------------------------------------
// Small local helpers. Deliberately not shared with the other two headers:
// each of the three owns its own vector algebra so none of them can be broken
// by a change made for another.
// ---------------------------------------------------------------------------

namespace detail {

struct V3 {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

inline V3 fromCartesian(const orb::Vec3& value) { return {value.x, value.y, value.z}; }
inline double dot(const V3& a, const V3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline V3 cross(const V3& a, const V3& b) {
  return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}
inline double norm(const V3& a) { return std::sqrt(dot(a, a)); }
inline V3 scale(const V3& a, double s) { return {a.x * s, a.y * s, a.z * s}; }
inline V3 sub(const V3& a, const V3& b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline V3 add(const V3& a, const V3& b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline V3 unit(const V3& a) {
  const double n = norm(a);
  return n > 0.0 ? scale(a, 1.0 / n) : V3{0.0, 0.0, 0.0};
}

inline double wrapTwoPi(double angle) {
  const double twoPi = 2.0 * orb::kPi;
  double wrapped = std::fmod(angle, twoPi);
  if (wrapped < 0.0) wrapped += twoPi;
  return wrapped;
}

inline double wrapPi(double angle) {
  double wrapped = wrapTwoPi(angle);
  if (wrapped > orb::kPi) wrapped -= 2.0 * orb::kPi;
  return wrapped;
}

/// Geocentric position of the Sun in the working inertial axes, METRES, for a
/// central body this build carries. Earth and the Moon are reachable from the
/// same ERFA the frames module already compiles; anything else is refused
/// rather than approximated by the Earth's Sun direction.
inline bool sunPositionFromCentralBody(const ax::Epoch& epoch, int centralBodyId, V3* out) {
  double pvh[2][3];
  double pvb[2][3];
  eraEpv00(epoch.tt1, epoch.tt2, pvh, pvb);
  // pvh is the Earth relative to the Sun, in astronomical units, equatorial.
  const V3 earthToSun{-pvh[0][0] * ERFA_DAU, -pvh[0][1] * ERFA_DAU, -pvh[0][2] * ERFA_DAU};
  if (centralBodyId == static_cast<int>(ax::BodyId::EARTH)) {
    *out = earthToSun;
    return true;
  }
  if (centralBodyId == static_cast<int>(ax::BodyId::MOON)) {
    const ax::Vec3 moon = ax::moonPositionGcrf(epoch);
    *out = sub(earthToSun, V3{moon.x, moon.y, moon.z});
    return true;
  }
  return false;
}

/// Greenwich mean sidereal time over the IAU-2006 series, radians. This is the
/// same chain the frames module's Earth rotation uses.
inline double greenwichMeanSiderealTime2006(const ax::Epoch& epoch) {
  return eraGmst06(epoch.ut11, epoch.ut12, epoch.tt1, epoch.tt2);
}

/// Greenwich mean sidereal time over the explicitly named legacy IAU-1982
/// series, radians.
///
/// Retained under its own name for the same reason `MOD_FK5`/`TOD_FK5` are:
/// the legacy route is a DIFFERENT answer (they part company at the milli-
/// arcsecond level and grow apart away from J2000), and an undocumented second
/// chain is what the parity program forbids. This is the series with the
/// published worked example, so it is the one the acceptance measures.
///
///   theta_GMST = 67310.54841 s
///              + (876600 h * 3600 + 8640184.812866) T_UT1
///              + 0.093104 T_UT1^2
///              - 6.2e-6 T_UT1^3
inline double greenwichMeanSiderealTime1982(const ax::Epoch& epoch) {
  const double julianCenturies =
      ((epoch.ut11 - ERFA_DJ00) + epoch.ut12) / 36525.0;
  const double linear = 876600.0 * 3600.0 + 8640184.812866;
  double seconds = 67310.54841 + linear * julianCenturies +
                   0.093104 * julianCenturies * julianCenturies -
                   6.2e-6 * julianCenturies * julianCenturies * julianCenturies;
  seconds = std::fmod(seconds, kSecondsPerDay);
  if (seconds < 0.0) seconds += kSecondsPerDay;
  // 86400 sidereal seconds span one full turn.
  return wrapTwoPi(seconds * (2.0 * orb::kPi) / kSecondsPerDay);
}

/// Rotation from the working inertial axes to the central body's body-fixed
/// axes, with the body's angular velocity in the inertial axes.
inline bool bodyFixedRotation(const EvaluationContext& context, ax::Mat3* rotation,
                              ax::Vec3* angularVelocity, Status* status) {
  if (context.centralBodyId == static_cast<int>(ax::BodyId::EARTH)) {
    if (!context.earthOrientationSupplied) {
      *status = Status::MISSING_INPUT;
      return false;
    }
    const ax::EarthOrientation eop = context.earthOrientation;
    const ax::RotationWithRate withRate = ax::rotationWithRate(
        [&eop](const ax::Epoch& at) { return ax::gcrfToItrf(at, eop); },
        context.epoch);
    *rotation = withRate.rotation;
    *angularVelocity = withRate.angularVelocitySource;
    return true;
  }
  ax::RotationElements elements;
  if (!ax::rotationElementsForBody(context.centralBodyId, &elements)) {
    *status = Status::UNSUPPORTED_CENTRAL_BODY;
    return false;
  }
  const ax::RotationWithRate withRate = ax::rotationWithRate(
      [&elements](const ax::Epoch& at) { return ax::icrfToBodyFixed(at, elements); },
      context.epoch);
  *rotation = withRate.rotation;
  *angularVelocity = withRate.angularVelocitySource;
  return true;
}

}  // namespace detail

// ---------------------------------------------------------------------------
// Derived quantities, computed once and shared by every parameter in a batch.
// Building this is where the cost is; evaluating a name from it is a lookup.
// ---------------------------------------------------------------------------

struct Derived {
  bool valid = false;

  detail::V3 position;
  detail::V3 velocity;
  double radius = 0.0;
  double speed = 0.0;

  detail::V3 angularMomentum;
  double angularMomentumMagnitude = 0.0;

  /// Eccentricity VECTOR, unnormalised, and its magnitude.
  detail::V3 eccentricityVector;
  double eccentricity = 0.0;

  /// Specific orbital energy and the characteristic energy C3 = v^2 - 2mu/r.
  double specificEnergy = 0.0;
  double characteristicEnergy = 0.0;
  double semiMajorAxis = 0.0;
  double semiLatusRectum = 0.0;

  bool keplerianValid = false;
  orb::Keplerian keplerian;

  bool bodyFixedValid = false;
  Status bodyFixedStatus = Status::OK;
  detail::V3 positionBodyFixed;
  detail::V3 velocityBodyFixed;

  bool planetodeticValid = false;
  orb::Planetodetic planetodetic;

  bool sunValid = false;
  detail::V3 sunDirection;   ///< unit, working inertial axes
  detail::V3 sunPosition;    ///< metres, working inertial axes
};

/// Build the shared derivations. Returns false only when the state itself is
/// unusable (zero radius, non-finite components); every other partial failure
/// is recorded in the corresponding `*Valid` flag so a parameter that does not
/// need it still evaluates.
inline bool buildDerived(const EvaluationContext& context, Derived* out) {
  if (out == nullptr) return false;
  Derived derived;
  derived.position = detail::fromCartesian(context.state.position);
  derived.velocity = detail::fromCartesian(context.state.velocity);
  derived.radius = detail::norm(derived.position);
  derived.speed = detail::norm(derived.velocity);
  if (!(derived.radius > 0.0) || !std::isfinite(derived.radius) ||
      !std::isfinite(derived.speed)) {
    return false;
  }

  derived.angularMomentum = detail::cross(derived.position, derived.velocity);
  derived.angularMomentumMagnitude = detail::norm(derived.angularMomentum);

  const double mu = context.gravitationalParameter;
  if (mu > 0.0) {
    const double rdotv = detail::dot(derived.position, derived.velocity);
    const double factor = derived.speed * derived.speed - mu / derived.radius;
    derived.eccentricityVector = detail::scale(
        detail::sub(detail::scale(derived.position, factor),
                    detail::scale(derived.velocity, rdotv)),
        1.0 / mu);
    derived.eccentricity = detail::norm(derived.eccentricityVector);
    derived.specificEnergy = derived.speed * derived.speed / 2.0 - mu / derived.radius;
    derived.characteristicEnergy = 2.0 * derived.specificEnergy;
    const double inverseSemiMajorAxis =
        2.0 / derived.radius - derived.speed * derived.speed / mu;
    derived.semiMajorAxis =
        std::fabs(inverseSemiMajorAxis) > 0.0 ? 1.0 / inverseSemiMajorAxis : 0.0;
    derived.semiLatusRectum =
        derived.angularMomentumMagnitude * derived.angularMomentumMagnitude / mu;
    derived.keplerianValid =
        orb::keplerianFromCartesian(context.state, mu, &derived.keplerian);
  }

  if (context.epochSupplied) {
    ax::Mat3 rotation;
    ax::Vec3 omega;
    Status status = Status::OK;
    if (detail::bodyFixedRotation(context, &rotation, &omega, &status)) {
      const ax::StateVector rotated = ax::rotateState(
          rotation, omega,
          ax::StateVector{{derived.position.x, derived.position.y, derived.position.z},
                          {derived.velocity.x, derived.velocity.y, derived.velocity.z}});
      derived.positionBodyFixed = {rotated.position.x, rotated.position.y,
                                   rotated.position.z};
      derived.velocityBodyFixed = {rotated.velocity.x, rotated.velocity.y,
                                   rotated.velocity.z};
      derived.bodyFixedValid = true;
      if (context.ellipsoid.equatorialRadius > 0.0) {
        const orb::Cartesian bodyFixedState{
            {derived.positionBodyFixed.x, derived.positionBodyFixed.y,
             derived.positionBodyFixed.z},
            {derived.velocityBodyFixed.x, derived.velocityBodyFixed.y,
             derived.velocityBodyFixed.z}};
        derived.planetodeticValid = orb::planetodeticFromCartesian(
            bodyFixedState, context.ellipsoid, &derived.planetodetic);
      }
    } else {
      derived.bodyFixedStatus = status;
    }

    detail::V3 sun;
    if (detail::sunPositionFromCentralBody(context.epoch, context.centralBodyId, &sun)) {
      derived.sunPosition = sun;
      derived.sunDirection = detail::unit(sun);
      derived.sunValid = true;
    }
  }

  derived.valid = true;
  *out = derived;
  return true;
}

// ---------------------------------------------------------------------------
// The B-plane.
//
// Transcribed from the reference tool's `CalculateBPlaneData`, conventions
// intact:
//   * the S vector is the INCOMING asymptote (arrival geometry) —
//     S = (1/e) e_hat + sqrt(1 - 1/e^2) (h_hat x e_hat);
//   * b = h^2 / (mu sqrt(e^2 - 1)), which equals |a| sqrt(e^2 - 1);
//   * B = b [ sqrt(1 - 1/e^2) e_hat - (1/e)(h_hat x e_hat) ], so B . S = 0
//     identically rather than by cancellation;
//   * T = (S_y, -S_x, 0)/|(S_x, S_y)| lies in the reference plane;
//   * R = S x T completes the right-handed triad.
// The outgoing variants are the same construction on the outgoing asymptote,
// which the roster names separately rather than overloading these four.
// ---------------------------------------------------------------------------

struct BPlane {
  detail::V3 sHat;
  detail::V3 tHat;
  detail::V3 rHat;
  detail::V3 bVector;
  double bDotT = 0.0;
  double bDotR = 0.0;
  double magnitude = 0.0;
  double angle = 0.0;
};

inline bool computeBPlane(const Derived& derived, double mu, bool incoming, BPlane* out) {
  if (out == nullptr || !(mu > 0.0)) return false;
  const double e = derived.eccentricity;
  if (!(e > 1.0)) return false;
  const detail::V3 eHat = detail::unit(derived.eccentricityVector);
  const detail::V3 hHat = detail::unit(derived.angularMomentum);
  const detail::V3 nHat = detail::cross(hHat, eHat);
  const double oneOverE = 1.0 / e;
  const double transverse = std::sqrt(1.0 - oneOverE * oneOverE);
  const double sign = incoming ? 1.0 : -1.0;

  BPlane plane;
  plane.sHat = detail::add(detail::scale(eHat, oneOverE),
                           detail::scale(nHat, sign * transverse));
  const double b = (derived.angularMomentumMagnitude * derived.angularMomentumMagnitude) /
                   (mu * std::sqrt(e * e - 1.0));
  plane.bVector = detail::scale(
      detail::sub(detail::scale(eHat, sign * transverse), detail::scale(nHat, oneOverE)),
      b);

  const double planar = std::sqrt(plane.sHat.x * plane.sHat.x + plane.sHat.y * plane.sHat.y);
  if (!(planar > 0.0)) {
    // The asymptote is along the reference-plane normal, so T is undefined.
    // Refusing is the answer; picking an arbitrary T would report a B-plane
    // orientation that means nothing.
    return false;
  }
  plane.tHat = detail::scale(detail::V3{plane.sHat.y, -plane.sHat.x, 0.0}, 1.0 / planar);
  plane.rHat = detail::cross(plane.sHat, plane.tHat);
  plane.bDotT = detail::dot(plane.bVector, plane.tHat);
  plane.bDotR = detail::dot(plane.bVector, plane.rHat);
  plane.magnitude = std::sqrt(plane.bDotT * plane.bDotT + plane.bDotR * plane.bDotR);
  plane.angle = std::atan2(plane.bDotR, plane.bDotT);
  *out = plane;
  return true;
}

/// Unit vector along the OUTGOING (departure) asymptote, in the working axes.
/// This is the vector `DLA` and `RLA` are the declination and right ascension
/// of, and it is built by the reference tool's own second construction —
///   s = [1 + C3 (h/mu)^2]^-1 [ (sqrt(C3)/mu)(h x e) - e ]
/// — kept rather than reduced to the B-plane's form so the two agree by
/// measurement instead of by assumption.
inline bool outgoingAsymptoteDirection(const Derived& derived, double mu, detail::V3* out) {
  if (out == nullptr || !(mu > 0.0)) return false;
  if (!(derived.eccentricity > 1.0)) return false;
  const double c3 = derived.characteristicEnergy;
  if (!(c3 > 0.0)) return false;
  const double hOverMu = derived.angularMomentumMagnitude / mu;
  const double scaleFactor = 1.0 / (1.0 + c3 * hOverMu * hOverMu);
  const detail::V3 term = detail::sub(
      detail::scale(detail::cross(derived.angularMomentum, derived.eccentricityVector),
                    std::sqrt(c3) / mu),
      derived.eccentricityVector);
  *out = detail::scale(term, scaleFactor);
  return true;
}

/// Unit vector along the INCOMING (arrival) asymptote. The same construction
/// with the transverse term reversed, which is the mirror of the outgoing one
/// through the periapsis direction.
inline bool incomingAsymptoteDirection(const Derived& derived, double mu, detail::V3* out) {
  if (out == nullptr || !(mu > 0.0)) return false;
  if (!(derived.eccentricity > 1.0)) return false;
  const double c3 = derived.characteristicEnergy;
  if (!(c3 > 0.0)) return false;
  const double hOverMu = derived.angularMomentumMagnitude / mu;
  const double scaleFactor = 1.0 / (1.0 + c3 * hOverMu * hOverMu);
  const detail::V3 term = detail::sub(
      detail::scale(detail::cross(derived.angularMomentum, derived.eccentricityVector),
                    -std::sqrt(c3) / mu),
      derived.eccentricityVector);
  *out = detail::scale(term, scaleFactor);
  return true;
}

// ---------------------------------------------------------------------------
// Time scales.
// ---------------------------------------------------------------------------

enum class TimeScale : uint8_t { UTC = 0, TAI = 1, TT = 2, TDB = 3, A1 = 4, UT1 = 5 };

/// Two-part Julian date in the requested scale, from the context's UTC.
inline bool julianDateInScale(const EvaluationContext& context, TimeScale scale,
                              double* part1, double* part2) {
  if (!context.epochSupplied) return false;
  double tai1 = 0.0;
  double tai2 = 0.0;
  if (eraUtctai(context.utc1, context.utc2, &tai1, &tai2) != 0) return false;
  switch (scale) {
    case TimeScale::UTC:
      *part1 = context.utc1;
      *part2 = context.utc2;
      return true;
    case TimeScale::UT1:
      // UT1 = UTC + (UT1 - UTC), and (UT1 - UTC) is a MEASURED quantity that
      // arrives with the Earth-orientation row. Without that row there is no
      // UT1 to report, and assuming zero would be reporting UTC under another
      // name.
      if (!context.earthOrientationSupplied) return false;
      *part1 = context.utc1;
      *part2 = context.utc2 + context.earthOrientation.dut1 / kSecondsPerDay;
      return true;
    case TimeScale::TAI:
      *part1 = tai1;
      *part2 = tai2;
      return true;
    case TimeScale::A1:
      // A1 - TAI is a DEFINITION. Added on the second part so the day number
      // is untouched and the constant lands at full double precision.
      *part1 = tai1;
      *part2 = tai2 + kA1MinusTaiSeconds / kSecondsPerDay;
      return true;
    case TimeScale::TT: {
      double tt1 = 0.0;
      double tt2 = 0.0;
      if (eraTaitt(tai1, tai2, &tt1, &tt2) != 0) return false;
      *part1 = tt1;
      *part2 = tt2;
      return true;
    }
    case TimeScale::TDB: {
      double tt1 = 0.0;
      double tt2 = 0.0;
      if (eraTaitt(tai1, tai2, &tt1, &tt2) != 0) return false;
      // TDB - TT from the ERFA series. The observer terms are zeroed: this is
      // the geocentric TDB the time module reports, and adding a topocentric
      // correction here would make the same epoch read differently depending
      // on which parameter asked for it.
      const double ut =
          std::fmod(std::fmod(context.utc1, 1.0) + std::fmod(context.utc2, 1.0), 1.0);
      const double dtr = eraDtdb(tt1, tt2, ut, 0.0, 0.0, 0.0);
      double tdb1 = 0.0;
      double tdb2 = 0.0;
      if (eraTttdb(tt1, tt2, dtr, &tdb1, &tdb2) != 0) return false;
      *part1 = tdb1;
      *part2 = tdb2;
      return true;
    }
  }
  return false;
}

/// Gregorian calendar breakdown of a two-part Julian date in a given scale.
struct Gregorian {
  int year = 0;
  int month = 0;
  int day = 0;
  int hour = 0;
  int minute = 0;
  double second = 0.0;
};

inline bool gregorianInScale(const EvaluationContext& context, TimeScale scale,
                             Gregorian* out) {
  double part1 = 0.0;
  double part2 = 0.0;
  if (out == nullptr || !julianDateInScale(context, scale, &part1, &part2)) return false;
  int year = 0;
  int month = 0;
  int day = 0;
  int hmsf[4] = {0, 0, 0, 0};
  // UTC is the one scale that must be broken down AS UTC, because only there
  // does a day ever hold 86401 seconds. Every other scale here is uniform and
  // is broken down on the TAI-like path.
  const char* scaleName = scale == TimeScale::UTC ? "UTC" : "TAI";
  const int resolution = 9;
  if (eraD2dtf(scaleName, resolution, part1, part2, &year, &month, &day, hmsf) != 0) {
    return false;
  }
  out->year = year;
  out->month = month;
  out->day = day;
  out->hour = hmsf[0];
  out->minute = hmsf[1];
  out->second =
      static_cast<double>(hmsf[2]) + static_cast<double>(hmsf[3]) / 1.0e9;
  return true;
}

/// Modified Julian Date in a scale, JD - 2400000.5.
inline bool modifiedJulianDateInScale(const EvaluationContext& context, TimeScale scale,
                                      double* out) {
  double part1 = 0.0;
  double part2 = 0.0;
  if (out == nullptr || !julianDateInScale(context, scale, &part1, &part2)) return false;
  // Subtract the offset from the LARGER part first so the sum keeps its
  // precision: (part1 - offset) is exact for the day number, and part2 stays a
  // fraction of a day.
  *out = (part1 - kModifiedJulianDateOffset) + part2;
  return true;
}

// ---------------------------------------------------------------------------
// The evaluator.
//
// `values` receives up to `descriptor->elementCount` doubles. A parameter whose
// kind is EPOCH_TEXT or IDENTIFIER_TEXT writes nothing here and is served by
// `evaluateText` instead — the two are separate entry points so a caller can
// never read a calendar date out of a double.
// ---------------------------------------------------------------------------

/// Fill six element values from any element set the orbits header carries.
inline Status evaluateElementSet(const EvaluationContext& context, const Derived& derived,
                                 orb::Representation representation, double* values) {
  const double mu = context.gravitationalParameter;
  if (!(mu > 0.0) && representation != orb::Representation::CARTESIAN &&
      representation != orb::Representation::SPHERICAL_AZFPA &&
      representation != orb::Representation::SPHERICAL_RADEC) {
    return Status::MISSING_INPUT;
  }
  switch (representation) {
    case orb::Representation::CARTESIAN:
      values[0] = context.state.position.x;
      values[1] = context.state.position.y;
      values[2] = context.state.position.z;
      values[3] = context.state.velocity.x;
      values[4] = context.state.velocity.y;
      values[5] = context.state.velocity.z;
      return Status::OK;
    case orb::Representation::KEPLERIAN: {
      if (!derived.keplerianValid) return Status::NUMERICAL_FAILURE;
      const orb::Keplerian& k = derived.keplerian;
      values[0] = k.semiMajorAxis;
      values[1] = k.eccentricity;
      values[2] = k.inclination;
      values[3] = k.raan;
      values[4] = k.argumentOfPeriapsis;
      values[5] = k.trueAnomaly;
      return Status::OK;
    }
    case orb::Representation::MODIFIED_KEPLERIAN: {
      if (!derived.keplerianValid) return Status::NUMERICAL_FAILURE;
      orb::ModifiedKeplerian set;
      if (!orb::modifiedKeplerianFromKeplerian(derived.keplerian, &set)) {
        return Status::NUMERICAL_FAILURE;
      }
      values[0] = set.radiusOfPeriapsis;
      values[1] = set.radiusOfApoapsis;
      values[2] = set.inclination;
      values[3] = set.raan;
      values[4] = set.argumentOfPeriapsis;
      values[5] = set.trueAnomaly;
      return Status::OK;
    }
    case orb::Representation::SPHERICAL_AZFPA: {
      orb::SphericalAZFPA set;
      if (!orb::sphericalAzfpaFromCartesian(context.state, &set)) {
        return Status::NUMERICAL_FAILURE;
      }
      values[0] = set.radius;
      values[1] = set.rightAscension;
      values[2] = set.declination;
      values[3] = set.speed;
      values[4] = set.azimuth;
      values[5] = set.flightPathAngle;
      return Status::OK;
    }
    case orb::Representation::SPHERICAL_RADEC: {
      orb::SphericalRADEC set;
      if (!orb::sphericalRadecFromCartesian(context.state, &set)) {
        return Status::NUMERICAL_FAILURE;
      }
      values[0] = set.radius;
      values[1] = set.rightAscension;
      values[2] = set.declination;
      values[3] = set.speed;
      values[4] = set.velocityRightAscension;
      values[5] = set.velocityDeclination;
      return Status::OK;
    }
    case orb::Representation::EQUINOCTIAL: {
      orb::Equinoctial set;
      if (!orb::equinoctialFromCartesian(context.state, mu, 1, &set)) {
        return Status::NUMERICAL_FAILURE;
      }
      values[0] = set.semiMajorAxis;
      values[1] = set.h;
      values[2] = set.k;
      values[3] = set.p;
      values[4] = set.q;
      values[5] = set.meanLongitude;
      return Status::OK;
    }
    case orb::Representation::MODIFIED_EQUINOCTIAL: {
      orb::ModifiedEquinoctial set;
      if (!orb::modifiedEquinoctialFromCartesian(context.state, mu, 1, &set)) {
        return Status::NUMERICAL_FAILURE;
      }
      values[0] = set.semiLatusRectum;
      values[1] = set.f;
      values[2] = set.g;
      values[3] = set.h;
      values[4] = set.k;
      values[5] = set.trueLongitude;
      return Status::OK;
    }
    case orb::Representation::ALTERNATE_EQUINOCTIAL: {
      orb::AlternateEquinoctial set;
      if (!orb::alternateEquinoctialFromCartesian(context.state, mu, 1, &set)) {
        return Status::NUMERICAL_FAILURE;
      }
      values[0] = set.meanMotion;
      values[1] = set.h;
      values[2] = set.k;
      values[3] = set.p;
      values[4] = set.q;
      values[5] = set.meanLongitude;
      return Status::OK;
    }
    case orb::Representation::DELAUNAY: {
      if (!derived.keplerianValid) return Status::NUMERICAL_FAILURE;
      orb::Delaunay set;
      if (!orb::delaunayFromKeplerian(derived.keplerian, mu, &set)) {
        return Status::UNDEFINED_FOR_THIS_ORBIT;
      }
      values[0] = set.l;
      values[1] = set.g;
      values[2] = set.h;
      values[3] = set.L;
      values[4] = set.G;
      values[5] = set.H;
      return Status::OK;
    }
    case orb::Representation::PLANETODETIC: {
      if (!derived.bodyFixedValid) {
        return derived.bodyFixedStatus == Status::OK ? Status::MISSING_INPUT
                                                     : derived.bodyFixedStatus;
      }
      if (!derived.planetodeticValid) return Status::NUMERICAL_FAILURE;
      const orb::Planetodetic& set = derived.planetodetic;
      values[0] = set.latitude;
      values[1] = set.longitude;
      values[2] = set.height;
      values[3] = set.speed;
      values[4] = set.azimuth;
      values[5] = set.flightPathAngle;
      return Status::OK;
    }
    case orb::Representation::INCOMING_ASYMPTOTE:
    case orb::Representation::OUTGOING_ASYMPTOTE: {
      if (!derived.keplerianValid) return Status::NUMERICAL_FAILURE;
      if (!(derived.eccentricity > 1.0)) return Status::UNDEFINED_FOR_THIS_ORBIT;
      orb::Asymptote set;
      const bool incoming = representation == orb::Representation::INCOMING_ASYMPTOTE;
      if (!orb::asymptoteFromKeplerian(derived.keplerian, mu, incoming, &set)) {
        return Status::UNDEFINED_FOR_THIS_ORBIT;
      }
      values[0] = set.radiusOfPeriapsis;
      values[1] = set.c3Energy;
      values[2] = set.asymptoteRightAscension;
      values[3] = set.asymptoteDeclination;
      values[4] = set.velocityAzimuthAtPeriapsis;
      values[5] = set.trueAnomaly;
      return Status::OK;
    }
    default:
      return Status::NOT_IMPLEMENTED;
  }
}

/// A single element of an element set, by index.
inline Status evaluateElement(const EvaluationContext& context, const Derived& derived,
                              orb::Representation representation, int index,
                              double* value) {
  double elements[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
  const Status status = evaluateElementSet(context, derived, representation, elements);
  if (status != Status::OK) return status;
  *value = elements[index];
  return status;
}

inline Status statedValue(bool present, double value, double* out) {
  if (!present) return Status::MISSING_INPUT;
  *out = value;
  return Status::OK;
}

/// Evaluate one named parameter into `values`.
///
/// `count` receives the number of doubles written. A refusal writes nothing and
/// leaves `*count` at zero — a caller that ignores the status reads no number
/// at all rather than a stale or defaulted one.
inline Status evaluate(ParameterId id, const EvaluationContext& context,
                       const Derived& derived, double* values, int* count) {
  if (values == nullptr || count == nullptr) return Status::NUMERICAL_FAILURE;
  *count = 0;
  const Descriptor* descriptor = findById(id);
  if (descriptor == nullptr) return Status::UNKNOWN_PARAMETER;
  if (descriptor->availability != Availability::IMPLEMENTED &&
      descriptor->availability != Availability::CALLER_SUPPLIED) {
    return Status::NOT_IMPLEMENTED;
  }
  if (!derived.valid) return Status::NUMERICAL_FAILURE;

  const double mu = context.gravitationalParameter;
  const bool haveMu = mu > 0.0;
  const orb::Keplerian& kep = derived.keplerian;

  // Helpers that are common enough to be worth naming once.
  const auto needMu = [&](Status* status) {
    if (!haveMu) {
      *status = Status::MISSING_INPUT;
      return false;
    }
    return true;
  };
  const auto needKeplerian = [&](Status* status) {
    if (!haveMu) {
      *status = Status::MISSING_INPUT;
      return false;
    }
    if (!derived.keplerianValid) {
      *status = Status::NUMERICAL_FAILURE;
      return false;
    }
    return true;
  };
  const auto needBodyFixed = [&](Status* status) {
    if (!context.epochSupplied) {
      *status = Status::MISSING_INPUT;
      return false;
    }
    if (!derived.bodyFixedValid) {
      *status = derived.bodyFixedStatus == Status::OK ? Status::MISSING_INPUT
                                                      : derived.bodyFixedStatus;
      return false;
    }
    return true;
  };

  Status status = Status::OK;
  double value = 0.0;

  switch (id) {
    // ---- Cartesian ------------------------------------------------------
    case ParameterId::X: value = context.state.position.x; break;
    case ParameterId::Y: value = context.state.position.y; break;
    case ParameterId::Z: value = context.state.position.z; break;
    case ParameterId::VX: value = context.state.velocity.x; break;
    case ParameterId::VY: value = context.state.velocity.y; break;
    case ParameterId::VZ: value = context.state.velocity.z; break;

    // ---- Keplerian ------------------------------------------------------
    case ParameterId::SMA:
      if (!needKeplerian(&status)) return status;
      value = kep.semiMajorAxis;
      break;
    case ParameterId::ECC:
      if (!needMu(&status)) return status;
      value = derived.eccentricity;
      break;
    case ParameterId::INC:
      if (!needKeplerian(&status)) return status;
      value = kep.inclination;
      break;
    case ParameterId::RAAN:
      if (!needKeplerian(&status)) return status;
      value = kep.raan;
      break;
    case ParameterId::RADN:
      // Right ascension of the DESCENDING node: the ascending node's,
      // half a turn away.
      if (!needKeplerian(&status)) return status;
      value = detail::wrapTwoPi(kep.raan + orb::kPi);
      break;
    case ParameterId::AOP:
      if (!needKeplerian(&status)) return status;
      value = kep.argumentOfPeriapsis;
      break;
    case ParameterId::TA:
      if (!needKeplerian(&status)) return status;
      value = kep.trueAnomaly;
      break;
    case ParameterId::EA: {
      if (!needKeplerian(&status)) return status;
      if (!(kep.eccentricity < 1.0)) return Status::UNDEFINED_FOR_THIS_ORBIT;
      value = detail::wrapTwoPi(
          orb::trueToEccentricAnomaly(kep.trueAnomaly, kep.eccentricity));
      break;
    }
    case ParameterId::HA: {
      if (!needKeplerian(&status)) return status;
      if (!(kep.eccentricity > 1.0)) return Status::UNDEFINED_FOR_THIS_ORBIT;
      value = orb::trueToHyperbolicAnomaly(kep.trueAnomaly, kep.eccentricity);
      break;
    }
    case ParameterId::MA: {
      if (!needKeplerian(&status)) return status;
      if (kep.eccentricity < 1.0) {
        value = detail::wrapTwoPi(orb::eccentricToMeanAnomaly(
            orb::trueToEccentricAnomaly(kep.trueAnomaly, kep.eccentricity),
            kep.eccentricity));
      } else if (kep.eccentricity > 1.0) {
        value = orb::hyperbolicToMeanAnomaly(
            orb::trueToHyperbolicAnomaly(kep.trueAnomaly, kep.eccentricity),
            kep.eccentricity);
      } else {
        return Status::UNDEFINED_FOR_THIS_ORBIT;
      }
      break;
    }
    case ParameterId::MM: {
      if (!needKeplerian(&status)) return status;
      const double a = std::fabs(kep.semiMajorAxis);
      if (!(a > 0.0)) return Status::UNDEFINED_FOR_THIS_ORBIT;
      value = std::sqrt(mu / (a * a * a));
      break;
    }
    case ParameterId::RadApo:
    case ParameterId::RadPer: {
      if (!needKeplerian(&status)) return status;
      value = id == ParameterId::RadApo
                  ? kep.semiMajorAxis * (1.0 + kep.eccentricity)
                  : kep.semiMajorAxis * (1.0 - kep.eccentricity);
      break;
    }

    // ---- spherical ------------------------------------------------------
    case ParameterId::RMAG: value = derived.radius; break;
    case ParameterId::VMAG: value = derived.speed; break;
    case ParameterId::RA:
      status = evaluateElement(context, derived, orb::Representation::SPHERICAL_RADEC, 1,
                               &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::DEC:
      status = evaluateElement(context, derived, orb::Representation::SPHERICAL_RADEC, 2,
                               &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::RAV:
      status = evaluateElement(context, derived, orb::Representation::SPHERICAL_RADEC, 4,
                               &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::DECV:
      status = evaluateElement(context, derived, orb::Representation::SPHERICAL_RADEC, 5,
                               &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::AZI:
      status = evaluateElement(context, derived, orb::Representation::SPHERICAL_AZFPA, 4,
                               &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::FPA:
      status = evaluateElement(context, derived, orb::Representation::SPHERICAL_AZFPA, 5,
                               &value);
      if (status != Status::OK) return status;
      break;

    // ---- planet-relative ------------------------------------------------
    case ParameterId::Altitude:
      if (!needBodyFixed(&status)) return status;
      if (!derived.planetodeticValid) return Status::MISSING_INPUT;
      value = derived.planetodetic.height;
      break;
    case ParameterId::Latitude:
      if (!needBodyFixed(&status)) return status;
      if (!derived.planetodeticValid) return Status::MISSING_INPUT;
      value = derived.planetodetic.latitude;
      break;
    case ParameterId::Longitude:
      if (!needBodyFixed(&status)) return status;
      value = detail::wrapPi(
          std::atan2(derived.positionBodyFixed.y, derived.positionBodyFixed.x));
      break;
    case ParameterId::GeocentricLatitude:
      if (!needBodyFixed(&status)) return status;
      value = std::atan2(derived.positionBodyFixed.z,
                         std::sqrt(derived.positionBodyFixed.x * derived.positionBodyFixed.x +
                                   derived.positionBodyFixed.y * derived.positionBodyFixed.y));
      break;
    case ParameterId::GeocentricAltitude:
      if (!(context.ellipsoid.equatorialRadius > 0.0)) return Status::MISSING_INPUT;
      value = derived.radius - context.ellipsoid.equatorialRadius;
      break;
    case ParameterId::MHA:
      if (!context.epochSupplied) return Status::MISSING_INPUT;
      value = detail::greenwichMeanSiderealTime2006(context.epoch);
      break;
    case ParameterId::MHA_IAU1982:
      if (!context.epochSupplied) return Status::MISSING_INPUT;
      value = detail::greenwichMeanSiderealTime1982(context.epoch);
      break;
    case ParameterId::LST:
    case ParameterId::LST_IAU1982: {
      if (!needBodyFixed(&status)) return status;
      const double longitude = detail::wrapPi(
          std::atan2(derived.positionBodyFixed.y, derived.positionBodyFixed.x));
      const double hourAngle = id == ParameterId::LST
                                   ? detail::greenwichMeanSiderealTime2006(context.epoch)
                                   : detail::greenwichMeanSiderealTime1982(context.epoch);
      value = detail::wrapTwoPi(hourAngle + longitude);
      break;
    }
    case ParameterId::BetaAngle: {
      if (!context.epochSupplied) return Status::MISSING_INPUT;
      if (!derived.sunValid) return Status::UNSUPPORTED_CENTRAL_BODY;
      if (!(derived.angularMomentumMagnitude > 0.0)) return Status::NUMERICAL_FAILURE;
      value = std::asin(
          detail::dot(detail::unit(derived.angularMomentum), derived.sunDirection));
      break;
    }

    // ---- equinoctial families -------------------------------------------
    case ParameterId::EquinoctialH:
      status = evaluateElement(context, derived, orb::Representation::EQUINOCTIAL, 1, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::EquinoctialK:
      status = evaluateElement(context, derived, orb::Representation::EQUINOCTIAL, 2, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::EquinoctialP:
      status = evaluateElement(context, derived, orb::Representation::EQUINOCTIAL, 3, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::EquinoctialQ:
      status = evaluateElement(context, derived, orb::Representation::EQUINOCTIAL, 4, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::MLONG:
      status = evaluateElement(context, derived, orb::Representation::EQUINOCTIAL, 5, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::ModEquinoctialF:
      status = evaluateElement(context, derived, orb::Representation::MODIFIED_EQUINOCTIAL,
                               1, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::ModEquinoctialG:
      status = evaluateElement(context, derived, orb::Representation::MODIFIED_EQUINOCTIAL,
                               2, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::ModEquinoctialH:
      status = evaluateElement(context, derived, orb::Representation::MODIFIED_EQUINOCTIAL,
                               3, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::ModEquinoctialK:
      status = evaluateElement(context, derived, orb::Representation::MODIFIED_EQUINOCTIAL,
                               4, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::TLONG:
      status = evaluateElement(context, derived, orb::Representation::MODIFIED_EQUINOCTIAL,
                               5, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::AltEquinoctialP:
      status = evaluateElement(context, derived, orb::Representation::ALTERNATE_EQUINOCTIAL,
                               3, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::AltEquinoctialQ:
      status = evaluateElement(context, derived, orb::Representation::ALTERNATE_EQUINOCTIAL,
                               4, &value);
      if (status != Status::OK) return status;
      break;

    // ---- Delaunay -------------------------------------------------------
    case ParameterId::Delaunayl:
    case ParameterId::Delaunayg:
    case ParameterId::Delaunayh:
    case ParameterId::DelaunayL:
    case ParameterId::DelaunayG:
    case ParameterId::DelaunayH: {
      int index = 0;
      switch (id) {
        case ParameterId::Delaunayl: index = 0; break;
        case ParameterId::Delaunayg: index = 1; break;
        case ParameterId::Delaunayh: index = 2; break;
        case ParameterId::DelaunayL: index = 3; break;
        case ParameterId::DelaunayG: index = 4; break;
        default: index = 5; break;
      }
      status = evaluateElement(context, derived, orb::Representation::DELAUNAY, index, &value);
      if (status != Status::OK) return status;
      break;
    }

    // ---- planetodetic ---------------------------------------------------
    case ParameterId::PlanetodeticRMAG:
      if (!needBodyFixed(&status)) return status;
      value = detail::norm(derived.positionBodyFixed);
      break;
    case ParameterId::PlanetodeticLAT:
      status = evaluateElement(context, derived, orb::Representation::PLANETODETIC, 0, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::PlanetodeticLON:
      status = evaluateElement(context, derived, orb::Representation::PLANETODETIC, 1, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::PlanetodeticVMAG:
      if (!needBodyFixed(&status)) return status;
      value = detail::norm(derived.velocityBodyFixed);
      break;
    case ParameterId::PlanetodeticAZI:
      status = evaluateElement(context, derived, orb::Representation::PLANETODETIC, 4, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::PlanetodeticHFPA:
      status = evaluateElement(context, derived, orb::Representation::PLANETODETIC, 5, &value);
      if (status != Status::OK) return status;
      break;

    // ---- asymptote sets --------------------------------------------------
    case ParameterId::IncomingRadPer:
    case ParameterId::IncomingC3Energy:
    case ParameterId::IncomingRHA:
    case ParameterId::IncomingDHA:
    case ParameterId::IncomingBVAZI:
    case ParameterId::OutgoingRadPer:
    case ParameterId::OutgoingC3Energy:
    case ParameterId::OutgoingRHA:
    case ParameterId::OutgoingDHA:
    case ParameterId::OutgoingBVAZI: {
      const bool incoming = id == ParameterId::IncomingRadPer ||
                            id == ParameterId::IncomingC3Energy ||
                            id == ParameterId::IncomingRHA ||
                            id == ParameterId::IncomingDHA ||
                            id == ParameterId::IncomingBVAZI;
      int index = 0;
      switch (id) {
        case ParameterId::IncomingRadPer:
        case ParameterId::OutgoingRadPer: index = 0; break;
        case ParameterId::IncomingC3Energy:
        case ParameterId::OutgoingC3Energy: index = 1; break;
        case ParameterId::IncomingRHA:
        case ParameterId::OutgoingRHA: index = 2; break;
        case ParameterId::IncomingDHA:
        case ParameterId::OutgoingDHA: index = 3; break;
        default: index = 4; break;
      }
      status = evaluateElement(
          context, derived,
          incoming ? orb::Representation::INCOMING_ASYMPTOTE
                   : orb::Representation::OUTGOING_ASYMPTOTE,
          index, &value);
      if (status != Status::OK) return status;
      break;
    }

    // ---- orbital scalars -------------------------------------------------
    case ParameterId::SemilatusRectum:
      if (!needMu(&status)) return status;
      value = derived.semiLatusRectum;
      break;
    case ParameterId::OrbitPeriod: {
      if (!needMu(&status)) return status;
      if (!(derived.semiMajorAxis > 0.0)) return Status::UNDEFINED_FOR_THIS_ORBIT;
      const double a = derived.semiMajorAxis;
      value = 2.0 * orb::kPi * std::sqrt(a * a * a / mu);
      break;
    }
    case ParameterId::C3Energy:
      if (!needMu(&status)) return status;
      value = derived.characteristicEnergy;
      break;
    case ParameterId::Energy:
      if (!needMu(&status)) return status;
      value = derived.specificEnergy;
      break;
    case ParameterId::VelApoapsis:
    case ParameterId::VelPeriapsis: {
      if (!needKeplerian(&status)) return status;
      const double a = kep.semiMajorAxis;
      const double e = kep.eccentricity;
      if (!(a > 0.0) || !(e < 1.0)) return Status::UNDEFINED_FOR_THIS_ORBIT;
      value = id == ParameterId::VelApoapsis
                  ? std::sqrt(mu * (1.0 - e) / (a * (1.0 + e)))
                  : std::sqrt(mu * (1.0 + e) / (a * (1.0 - e)));
      break;
    }
    case ParameterId::Apoapsis:
    case ParameterId::Periapsis:
      // The apsis STOPPING FUNCTION: r . v, whose zero is the apsis and whose
      // slope says which one. Reported as the function itself so an event
      // locator can bracket and refine it, rather than as a boolean that has
      // already thrown the root away.
      value = detail::dot(derived.position, derived.velocity);
      break;

    // ---- angular momentum ------------------------------------------------
    case ParameterId::HMAG: value = derived.angularMomentumMagnitude; break;
    case ParameterId::HX: value = derived.angularMomentum.x; break;
    case ParameterId::HY: value = derived.angularMomentum.y; break;
    case ParameterId::HZ: value = derived.angularMomentum.z; break;

    // ---- asymptote declination / right ascension -------------------------
    case ParameterId::DLA:
    case ParameterId::RLA:
    case ParameterId::DLAIncoming:
    case ParameterId::RLAIncoming: {
      if (!needMu(&status)) return status;
      const bool incoming =
          id == ParameterId::DLAIncoming || id == ParameterId::RLAIncoming;
      detail::V3 asymptote;
      const bool ok = incoming ? incomingAsymptoteDirection(derived, mu, &asymptote)
                               : outgoingAsymptoteDirection(derived, mu, &asymptote);
      if (!ok) return Status::UNDEFINED_FOR_THIS_ORBIT;
      const bool wantDeclination =
          id == ParameterId::DLA || id == ParameterId::DLAIncoming;
      value = wantDeclination ? std::asin(asymptote.z)
                              : std::atan2(asymptote.y, asymptote.x);
      break;
    }

    // ---- B-plane ---------------------------------------------------------
    case ParameterId::BdotT:
    case ParameterId::BdotR:
    case ParameterId::BVectorMag:
    case ParameterId::BVectorAngle:
    case ParameterId::BdotTOutgoing:
    case ParameterId::BdotROutgoing:
    case ParameterId::BVectorMagOutgoing:
    case ParameterId::BVectorAngleOutgoing: {
      if (!needMu(&status)) return status;
      const bool incoming = id == ParameterId::BdotT || id == ParameterId::BdotR ||
                            id == ParameterId::BVectorMag ||
                            id == ParameterId::BVectorAngle;
      BPlane plane;
      if (!computeBPlane(derived, mu, incoming, &plane)) {
        return derived.eccentricity > 1.0 ? Status::NUMERICAL_FAILURE
                                          : Status::UNDEFINED_FOR_THIS_ORBIT;
      }
      switch (id) {
        case ParameterId::BdotT:
        case ParameterId::BdotTOutgoing: value = plane.bDotT; break;
        case ParameterId::BdotR:
        case ParameterId::BdotROutgoing: value = plane.bDotR; break;
        case ParameterId::BVectorMag:
        case ParameterId::BVectorMagOutgoing: value = plane.magnitude; break;
        default: value = plane.angle; break;
      }
      break;
    }

    // ---- time ------------------------------------------------------------
    case ParameterId::A1ModJulian:
    case ParameterId::TAIModJulian:
    case ParameterId::TTModJulian:
    case ParameterId::TDBModJulian:
    case ParameterId::UTCModJulian:
    case ParameterId::CurrA1MJD: {
      TimeScale scale = TimeScale::UTC;
      switch (id) {
        case ParameterId::A1ModJulian:
        case ParameterId::CurrA1MJD: scale = TimeScale::A1; break;
        case ParameterId::TAIModJulian: scale = TimeScale::TAI; break;
        case ParameterId::TTModJulian: scale = TimeScale::TT; break;
        case ParameterId::TDBModJulian: scale = TimeScale::TDB; break;
        default: scale = TimeScale::UTC; break;
      }
      if (!modifiedJulianDateInScale(context, scale, &value)) return Status::MISSING_INPUT;
      break;
    }
    case ParameterId::ElapsedDays:
    case ParameterId::ElapsedSecs: {
      if (!context.epochSupplied) return Status::MISSING_INPUT;
      if (!context.referenceEpochSupplied) return Status::MISSING_INPUT;
      // Differenced in TAI, because UTC is not a uniform scale: a leap second
      // inside the interval makes a UTC difference the wrong duration.
      double tai1 = 0.0;
      double tai2 = 0.0;
      double referenceTai1 = 0.0;
      double referenceTai2 = 0.0;
      if (eraUtctai(context.utc1, context.utc2, &tai1, &tai2) != 0) {
        return Status::NUMERICAL_FAILURE;
      }
      if (eraUtctai(context.referenceUtc1, context.referenceUtc2, &referenceTai1,
                    &referenceTai2) != 0) {
        return Status::NUMERICAL_FAILURE;
      }
      const double days = (tai1 - referenceTai1) + (tai2 - referenceTai2);
      value = id == ParameterId::ElapsedDays ? days : days * kSecondsPerDay;
      break;
    }

    // ---- state transition ------------------------------------------------
    case ParameterId::OrbitSTM: {
      if (!context.stateTransitionMatrixSupplied) return Status::MISSING_INPUT;
      for (int i = 0; i < 36; ++i) values[i] = context.stateTransitionMatrix[i];
      *count = 36;
      return Status::OK;
    }
    case ParameterId::OrbitSTMA:
    case ParameterId::OrbitSTMB:
    case ParameterId::OrbitSTMC:
    case ParameterId::OrbitSTMD: {
      if (!context.stateTransitionMatrixSupplied) return Status::MISSING_INPUT;
      // The 6x6 splits into four 3x3 blocks:
      //   A = d r / d r0   B = d r / d v0
      //   C = d v / d r0   D = d v / d v0
      const int rowOffset =
          (id == ParameterId::OrbitSTMC || id == ParameterId::OrbitSTMD) ? 3 : 0;
      const int columnOffset =
          (id == ParameterId::OrbitSTMB || id == ParameterId::OrbitSTMD) ? 3 : 0;
      for (int row = 0; row < 3; ++row) {
        for (int column = 0; column < 3; ++column) {
          values[row * 3 + column] =
              context.stateTransitionMatrix[(row + rowOffset) * 6 + (column + columnOffset)];
        }
      }
      *count = 9;
      return Status::OK;
    }

    // ---- element-set aggregates -------------------------------------------
    case ParameterId::Cartesian:
    case ParameterId::Keplerian:
    case ParameterId::ModKeplerian:
    case ParameterId::SphericalRADEC:
    case ParameterId::SphericalAZFPA:
    case ParameterId::Equinoctial:
    case ParameterId::ModEquinoctial:
    case ParameterId::Delaunay:
    case ParameterId::Planetodetic:
    case ParameterId::IncomingAsymptote:
    case ParameterId::OutgoingAsymptote: {
      orb::Representation representation = orb::Representation::CARTESIAN;
      switch (id) {
        case ParameterId::Keplerian: representation = orb::Representation::KEPLERIAN; break;
        case ParameterId::ModKeplerian:
          representation = orb::Representation::MODIFIED_KEPLERIAN;
          break;
        case ParameterId::SphericalRADEC:
          representation = orb::Representation::SPHERICAL_RADEC;
          break;
        case ParameterId::SphericalAZFPA:
          representation = orb::Representation::SPHERICAL_AZFPA;
          break;
        case ParameterId::Equinoctial:
          representation = orb::Representation::EQUINOCTIAL;
          break;
        case ParameterId::ModEquinoctial:
          representation = orb::Representation::MODIFIED_EQUINOCTIAL;
          break;
        case ParameterId::Delaunay: representation = orb::Representation::DELAUNAY; break;
        case ParameterId::Planetodetic:
          representation = orb::Representation::PLANETODETIC;
          break;
        case ParameterId::IncomingAsymptote:
          representation = orb::Representation::INCOMING_ASYMPTOTE;
          break;
        case ParameterId::OutgoingAsymptote:
          representation = orb::Representation::OUTGOING_ASYMPTOTE;
          break;
        default: representation = orb::Representation::CARTESIAN; break;
      }
      status = evaluateElementSet(context, derived, representation, values);
      if (status != Status::OK) return status;
      *count = 6;
      return Status::OK;
    }

    // ---- named additions ---------------------------------------------------
    case ParameterId::RadialVelocity:
      value = detail::dot(derived.position, derived.velocity) / derived.radius;
      break;
    case ParameterId::HorizontalFlightPathAngle: {
      double vertical = 0.0;
      status = evaluateElement(context, derived, orb::Representation::SPHERICAL_AZFPA, 5,
                               &vertical);
      if (status != Status::OK) return status;
      // The two flight path angles are complements: one is measured from the
      // radius vector, the other from the plane perpendicular to it.
      value = orb::kPi / 2.0 - vertical;
      break;
    }
    case ParameterId::AltitudeOfPeriapsis:
    case ParameterId::AltitudeOfApoapsis: {
      if (!needKeplerian(&status)) return status;
      if (!(context.ellipsoid.equatorialRadius > 0.0)) return Status::MISSING_INPUT;
      const double radius = id == ParameterId::AltitudeOfApoapsis
                                ? kep.semiMajorAxis * (1.0 + kep.eccentricity)
                                : kep.semiMajorAxis * (1.0 - kep.eccentricity);
      value = radius - context.ellipsoid.equatorialRadius;
      break;
    }
    case ParameterId::ArgumentOfLatitude:
      if (!needKeplerian(&status)) return status;
      value = detail::wrapTwoPi(kep.argumentOfPeriapsis + kep.trueAnomaly);
      break;
    case ParameterId::EccentricityVectorX:
      if (!needMu(&status)) return status;
      value = derived.eccentricityVector.x;
      break;
    case ParameterId::EccentricityVectorY:
      if (!needMu(&status)) return status;
      value = derived.eccentricityVector.y;
      break;
    case ParameterId::EccentricityVectorZ:
      if (!needMu(&status)) return status;
      value = derived.eccentricityVector.z;
      break;
    case ParameterId::SemiMinorAxis: {
      if (!needMu(&status)) return status;
      const double e = derived.eccentricity;
      if (!(std::fabs(e - 1.0) > 0.0)) return Status::UNDEFINED_FOR_THIS_ORBIT;
      value = std::fabs(derived.semiMajorAxis) * std::sqrt(std::fabs(1.0 - e * e));
      break;
    }
    case ParameterId::HyperbolicExcessVelocity:
      if (!needMu(&status)) return status;
      if (!(derived.characteristicEnergy > 0.0)) return Status::UNDEFINED_FOR_THIS_ORBIT;
      value = std::sqrt(derived.characteristicEnergy);
      break;
    case ParameterId::BallisticCoefficient: {
      if (!context.properties.hasTotalMass || !context.properties.hasDragCoefficient ||
          !context.properties.hasDragArea) {
        return Status::MISSING_INPUT;
      }
      const double denominator =
          context.properties.dragCoefficient * context.properties.dragArea;
      if (!(denominator > 0.0)) return Status::NUMERICAL_FAILURE;
      value = context.properties.totalMass / denominator;
      break;
    }
    case ParameterId::AreaToMassRatio: {
      if (!context.properties.hasTotalMass ||
          !context.properties.hasSolarRadiationPressureArea) {
        return Status::MISSING_INPUT;
      }
      if (!(context.properties.totalMass > 0.0)) return Status::NUMERICAL_FAILURE;
      value = context.properties.solarRadiationPressureArea / context.properties.totalMass;
      break;
    }
    case ParameterId::UT1ModJulian:
      if (!modifiedJulianDateInScale(context, TimeScale::UT1, &value)) {
        return Status::MISSING_INPUT;
      }
      break;

    // ---- stated properties -------------------------------------------------
    case ParameterId::DryMass:
      status = statedValue(context.properties.hasDryMass, context.properties.dryMass, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::TotalMass:
      status =
          statedValue(context.properties.hasTotalMass, context.properties.totalMass, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::Cd:
      status = statedValue(context.properties.hasDragCoefficient,
                           context.properties.dragCoefficient, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::Cr:
      status = statedValue(context.properties.hasReflectivityCoefficient,
                           context.properties.reflectivityCoefficient, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::DragArea:
      status =
          statedValue(context.properties.hasDragArea, context.properties.dragArea, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::SRPArea:
      status = statedValue(context.properties.hasSolarRadiationPressureArea,
                           context.properties.solarRadiationPressureArea, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::SPADDragScaleFactor:
      status = statedValue(context.properties.hasDragScaleFactor,
                           context.properties.dragScaleFactor, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::SPADSRPScaleFactor:
      status = statedValue(context.properties.hasSolarRadiationPressureScaleFactor,
                           context.properties.solarRadiationPressureScaleFactor, &value);
      if (status != Status::OK) return status;
      break;
    case ParameterId::AtmosDensityScaleFactor:
      status = statedValue(context.properties.hasAtmosphericDensityScaleFactor,
                           context.properties.atmosphericDensityScaleFactor, &value);
      if (status != Status::OK) return status;
      break;

    default:
      // In the roster and marked implemented, but this switch has no arm.
      // Reported rather than silently returning zero.
      return Status::NOT_IMPLEMENTED;
  }

  if (!std::isfinite(value)) return Status::NUMERICAL_FAILURE;
  values[0] = value;
  *count = 1;
  return Status::OK;
}

/// Evaluate a parameter whose value is text (the Gregorian epochs). Writes at
/// most `capacity` bytes including the terminator and returns the status.
inline Status evaluateText(ParameterId id, const EvaluationContext& context, char* text,
                           int capacity) {
  if (text == nullptr || capacity < 32) return Status::NUMERICAL_FAILURE;
  TimeScale scale;
  switch (id) {
    case ParameterId::A1Gregorian: scale = TimeScale::A1; break;
    case ParameterId::TAIGregorian: scale = TimeScale::TAI; break;
    case ParameterId::TTGregorian: scale = TimeScale::TT; break;
    case ParameterId::TDBGregorian: scale = TimeScale::TDB; break;
    case ParameterId::UTCGregorian: scale = TimeScale::UTC; break;
    case ParameterId::UT1Gregorian: scale = TimeScale::UT1; break;
    default: return Status::UNKNOWN_PARAMETER;
  }
  Gregorian gregorian;
  if (!gregorianInScale(context, scale, &gregorian)) return Status::MISSING_INPUT;

  // ISO 8601 with nine fractional digits, written by hand: the module carries
  // no formatting library and a printf pulls one in.
  auto writeDigits = [](char* out, int value, int width) {
    for (int i = width - 1; i >= 0; --i) {
      out[i] = static_cast<char>('0' + (value % 10));
      value /= 10;
    }
  };
  int position = 0;
  writeDigits(text + position, gregorian.year, 4); position += 4;
  text[position++] = '-';
  writeDigits(text + position, gregorian.month, 2); position += 2;
  text[position++] = '-';
  writeDigits(text + position, gregorian.day, 2); position += 2;
  text[position++] = 'T';
  writeDigits(text + position, gregorian.hour, 2); position += 2;
  text[position++] = ':';
  writeDigits(text + position, gregorian.minute, 2); position += 2;
  text[position++] = ':';
  const int wholeSeconds = static_cast<int>(gregorian.second);
  writeDigits(text + position, wholeSeconds, 2); position += 2;
  text[position++] = '.';
  const double fractional = gregorian.second - static_cast<double>(wholeSeconds);
  int nanoseconds = static_cast<int>(fractional * 1.0e9 + 0.5);
  if (nanoseconds > 999999999) nanoseconds = 999999999;
  writeDigits(text + position, nanoseconds, 9); position += 9;
  text[position] = '\0';
  return Status::OK;
}

}  // namespace parameters
}  // namespace sdn

#endif  // SDN_ANALYSIS_PARAMETERS_PARAMETER_CATALOG_HPP
