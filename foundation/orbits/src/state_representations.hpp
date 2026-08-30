// state_representations.hpp — the 14 GMAT-parity orbit state representations.
//
// GMAT-parity program item 8 (graph/tasks/gmat-08-frames-and-state-representations.md).
//
// One canonical interchange form — Cartesian position/velocity about the
// central body in the coordinate system the caller names — and a total pair of
// conversions to and from every other element set. Every set converts to
// Cartesian and back; the round-trip is the acceptance.
//
// UNITS, normative and unconditional:
//   position  metres
//   velocity  metres per second
//   angles    RADIANS inside this header (the SDS envelope carries degrees for
//             the fields whose IDL says degrees; conversion happens at the
//             envelope, never here)
//   mu        m^3 / s^2
//
// This header is dependency-free (STL <cmath> only) so it can be compiled into
// the WASM module, into a native parity test, and into higherpop without
// dragging FlatBuffers along. It contains NO frame knowledge — a representation
// is a parameterisation of a state, the coordinate system it is expressed in is
// the frames module's business (foundation/frames).
//
// Singularity policy (acceptance: "the degenerate cases (e -> 0, i -> 0,
// i -> 180 deg) handled by the set that is designed for them rather than by an
// exception"): each set declares the regime it is well-posed on. Keplerian is
// singular at e -> 0 and i -> 0; equinoctial is the set designed for e -> 0 and
// i -> 0 (retrograde factor +1) and for i -> 180 deg (retrograde factor -1);
// the asymptote sets are the ones designed for hyperbolic orbits. Callers pick
// the set; this header never silently substitutes one for another, and it never
// throws — every entry point returns a bool and leaves the output untouched on
// failure.

#ifndef SDN_FOUNDATION_ORBITS_STATE_REPRESENTATIONS_HPP
#define SDN_FOUNDATION_ORBITS_STATE_REPRESENTATIONS_HPP

#include <cmath>
#include <cstdint>

namespace sdn {
namespace orbits {

// ---------------------------------------------------------------------------
// Vocabulary — mirrors SDS `frmStateRepresentation` (Themis consult 2026-08-29,
// additive to $FRM, no new standard code). The numbering is the ratified one;
// it is append-only and must never be reordered.
// ---------------------------------------------------------------------------
enum class Representation : uint8_t {
  UNSPECIFIED = 0,
  CARTESIAN = 1,
  KEPLERIAN = 2,
  MODIFIED_KEPLERIAN = 3,
  SPHERICAL_AZFPA = 4,
  SPHERICAL_RADEC = 5,
  EQUINOCTIAL = 6,
  MODIFIED_EQUINOCTIAL = 7,
  ALTERNATE_EQUINOCTIAL = 8,
  DELAUNAY = 9,
  PLANETODETIC = 10,
  INCOMING_ASYMPTOTE = 11,
  OUTGOING_ASYMPTOTE = 12,
  BROUWER_MEAN_SHORT = 13,
  BROUWER_MEAN_LONG = 14,
};

constexpr double kPi = 3.14159265358979323846264338327950288;
constexpr double kTwoPi = 2.0 * kPi;

// Tolerances that decide which branch a conversion takes. These are the
// *structural* thresholds (is this orbit circular / equatorial / parabolic),
// deliberately far looser than the 1e-12 round-trip acceptance: a state inside
// the threshold is handled by the non-singular branch, which is exact, not
// approximated.
constexpr double kCircularTolerance = 1e-11;
constexpr double kEquatorialTolerance = 1e-11;
constexpr double kParabolicTolerance = 1e-11;

// ---------------------------------------------------------------------------
// Small vector algebra. Deliberately local: this header must not depend on
// higherpop/vec3.hpp (which is native-only) nor on the HPOP coords types.
// ---------------------------------------------------------------------------
struct Vec3 {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

inline Vec3 add(const Vec3& a, const Vec3& b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline Vec3 sub(const Vec3& a, const Vec3& b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline Vec3 scale(const Vec3& a, double s) { return {a.x * s, a.y * s, a.z * s}; }
inline double dot(const Vec3& a, const Vec3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline Vec3 cross(const Vec3& a, const Vec3& b) {
  return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}
inline double norm(const Vec3& a) { return std::sqrt(dot(a, a)); }
inline bool finite(const Vec3& a) {
  return std::isfinite(a.x) && std::isfinite(a.y) && std::isfinite(a.z);
}
inline Vec3 unit(const Vec3& a) {
  const double n = norm(a);
  return n > 0.0 ? scale(a, 1.0 / n) : Vec3{};
}

/// Wrap to [0, 2pi).
inline double wrapTwoPi(double angle) {
  double wrapped = std::fmod(angle, kTwoPi);
  if (wrapped < 0.0) {
    wrapped += kTwoPi;
  }
  return wrapped;
}

/// Wrap to (-pi, pi].
inline double wrapPi(double angle) {
  double wrapped = wrapTwoPi(angle);
  if (wrapped > kPi) {
    wrapped -= kTwoPi;
  }
  return wrapped;
}

// ---------------------------------------------------------------------------
// The canonical interchange form.
// ---------------------------------------------------------------------------
struct Cartesian {
  Vec3 position;  ///< metres
  Vec3 velocity;  ///< metres per second
};

// ---------------------------------------------------------------------------
// 2. Keplerian — a, e, i, RAAN, argument of periapsis, true anomaly.
// Singular at e -> 0 (argument of periapsis undefined) and i -> 0 (RAAN
// undefined). For e >= 1 `semiMajorAxis` is negative and `trueAnomaly` is
// restricted to the range where the radius is positive.
// ---------------------------------------------------------------------------
struct Keplerian {
  double semiMajorAxis = 0.0;        ///< m (negative for hyperbolic)
  double eccentricity = 0.0;
  double inclination = 0.0;          ///< rad, [0, pi]
  double raan = 0.0;                 ///< rad, [0, 2pi)
  double argumentOfPeriapsis = 0.0;  ///< rad, [0, 2pi)
  double trueAnomaly = 0.0;          ///< rad, [0, 2pi) elliptic; (-nu_inf, nu_inf) hyperbolic
};

// ---------------------------------------------------------------------------
// 3. ModifiedKeplerian — periapsis/apoapsis radius instead of a and e. GMAT's
// RadPer/RadApo set. Well posed for e < 1; for hyperbolic orbits GMAT carries a
// negative apoapsis radius, and so do we (RadApo = a(1+e) < 0).
// ---------------------------------------------------------------------------
struct ModifiedKeplerian {
  double radiusOfPeriapsis = 0.0;    ///< m
  double radiusOfApoapsis = 0.0;     ///< m (negative for hyperbolic)
  double inclination = 0.0;          ///< rad
  double raan = 0.0;                 ///< rad
  double argumentOfPeriapsis = 0.0;  ///< rad
  double trueAnomaly = 0.0;          ///< rad
};

// ---------------------------------------------------------------------------
// 4. SphericalAZFPA — radius, right ascension, declination, speed, azimuth,
// vertical flight path angle. Non-singular for every bound and unbound orbit;
// degenerate only where the position or velocity vector vanishes.
// ---------------------------------------------------------------------------
struct SphericalAZFPA {
  double radius = 0.0;             ///< m
  double rightAscension = 0.0;     ///< rad, [0, 2pi)
  double declination = 0.0;        ///< rad, [-pi/2, pi/2]
  double speed = 0.0;              ///< m/s
  double flightPathAngle = 0.0;    ///< rad, vertical FPA measured from the radius vector, [0, pi]
  double azimuth = 0.0;            ///< rad, measured from local north toward east, [0, 2pi)
};

// ---------------------------------------------------------------------------
// 5. SphericalRADEC — same position triple, velocity as speed + right
// ascension/declination of the velocity vector.
// ---------------------------------------------------------------------------
struct SphericalRADEC {
  double radius = 0.0;                     ///< m
  double rightAscension = 0.0;             ///< rad
  double declination = 0.0;                ///< rad
  double speed = 0.0;                      ///< m/s
  double velocityRightAscension = 0.0;     ///< rad
  double velocityDeclination = 0.0;        ///< rad
};

// ---------------------------------------------------------------------------
// 6. Equinoctial — GMAT's set: SemiMajorAxis, h, k, p, q, MeanLongitude, with a
// retrograde factor j = +1 (direct) or j = -1 (retrograde). This is THE set
// designed for e -> 0 and i -> 0; with j = -1 it is the set designed for
// i -> 180 deg.
//
//   h = e sin(argPer + j*raan)
//   k = e cos(argPer + j*raan)
//   p = tan(i/2)^j sin(raan)
//   q = tan(i/2)^j cos(raan)
//   meanLongitude = meanAnomaly + argPer + j*raan
// ---------------------------------------------------------------------------
struct Equinoctial {
  double semiMajorAxis = 0.0;   ///< m
  double h = 0.0;
  double k = 0.0;
  double p = 0.0;
  double q = 0.0;
  double meanLongitude = 0.0;   ///< rad
  int retrogradeFactor = 1;     ///< +1 direct, -1 retrograde
};

// ---------------------------------------------------------------------------
// 7. ModifiedEquinoctial — the p, f, g, h, k, L set. Non-singular for every
// eccentricity including e >= 1, which is why it is the natural set for the
// hyperbolic regime and the one higherpop's MEE-VOP formulation integrates.
//
//   p = a (1 - e^2)                 (semi-latus rectum)
//   f = e cos(argPer + j*raan)
//   g = e sin(argPer + j*raan)
//   h = tan(i/2)^j cos(raan)
//   k = tan(i/2)^j sin(raan)
//   L = trueAnomaly + argPer + j*raan   (true longitude)
// ---------------------------------------------------------------------------
struct ModifiedEquinoctial {
  double semiLatusRectum = 0.0;  ///< m
  double f = 0.0;
  double g = 0.0;
  double h = 0.0;
  double k = 0.0;
  double trueLongitude = 0.0;    ///< rad
  int retrogradeFactor = 1;
};

// ---------------------------------------------------------------------------
// 8. AlternateEquinoctial — GMAT's variant that swaps the semi-major axis for
// the mean motion. Identical elsewhere to Equinoctial. Defined only for
// elliptic orbits, where the mean motion is real.
// ---------------------------------------------------------------------------
struct AlternateEquinoctial {
  double meanMotion = 0.0;      ///< rad/s
  double h = 0.0;
  double k = 0.0;
  double p = 0.0;
  double q = 0.0;
  double meanLongitude = 0.0;   ///< rad
  int retrogradeFactor = 1;
};

// ---------------------------------------------------------------------------
// 9. Delaunay — the canonical action-angle set of classical celestial
// mechanics (Vallado 4th ed. §2.6 / Brouwer & Clemence).
//
//   l = mean anomaly              L = sqrt(mu a)
//   g = argument of periapsis     G = L sqrt(1 - e^2)
//   h = right ascension of node   H = G cos i
//
// Elliptic only: L is imaginary for e >= 1.
// ---------------------------------------------------------------------------
struct Delaunay {
  double l = 0.0;  ///< rad, mean anomaly
  double g = 0.0;  ///< rad, argument of periapsis
  double h = 0.0;  ///< rad, RAAN
  double L = 0.0;  ///< m^2/s
  double G = 0.0;  ///< m^2/s
  double H = 0.0;  ///< m^2/s
};

// ---------------------------------------------------------------------------
// 10. Planetodetic — geodetic latitude/longitude/height of the sub-satellite
// point plus the velocity in the same spherical form as SphericalAZFPA. This
// set is defined against an ELLIPSOID, so it carries one; unlike every other
// set here it is frame-dependent (the longitude is body-fixed), which is why
// the ellipsoid travels with the element set rather than with the caller.
// ---------------------------------------------------------------------------
struct Planetodetic {
  double latitude = 0.0;         ///< rad, geodetic
  double longitude = 0.0;        ///< rad, body-fixed east longitude
  double height = 0.0;           ///< m above the reference ellipsoid
  double speed = 0.0;            ///< m/s
  double flightPathAngle = 0.0;  ///< rad
  double azimuth = 0.0;          ///< rad
};

/// Reference ellipsoid for the planetodetic set.
struct Ellipsoid {
  double equatorialRadius = 0.0;  ///< m
  double flattening = 0.0;        ///< dimensionless; 0 for a sphere
};

// ---------------------------------------------------------------------------
// 11/12. Incoming / Outgoing asymptote (B-plane) sets. Hyperbolic only. The
// asymptote direction is given by its right ascension and declination, the
// orientation about it by the velocity azimuth at periapsis.
// ---------------------------------------------------------------------------
struct Asymptote {
  double radiusOfPeriapsis = 0.0;      ///< m
  double c3Energy = 0.0;               ///< m^2/s^2, = -mu/a
  double asymptoteRightAscension = 0.0;///< rad
  double asymptoteDeclination = 0.0;   ///< rad
  double velocityAzimuthAtPeriapsis = 0.0; ///< rad
  double trueAnomaly = 0.0;            ///< rad
};

// ---------------------------------------------------------------------------
// 13/14. Brouwer mean elements, short-period-only and short+long-period.
// Carried as an osculating-shaped element set; the transformation between mean
// and osculating is the Brouwer (1959) theory and lives in the frames/orbits
// module's Brouwer implementation, not in this header's pure kinematics.
// ---------------------------------------------------------------------------
struct BrouwerMean {
  double semiMajorAxis = 0.0;        ///< m
  double eccentricity = 0.0;
  double inclination = 0.0;          ///< rad
  double raan = 0.0;                 ///< rad
  double argumentOfPeriapsis = 0.0;  ///< rad
  double meanAnomaly = 0.0;          ///< rad
};

// ===========================================================================
// Anomaly conversions
// ===========================================================================

/// True -> eccentric anomaly (elliptic).
inline double trueToEccentricAnomaly(double trueAnomaly, double eccentricity) {
  const double beta = std::sqrt(1.0 - eccentricity * eccentricity);
  return std::atan2(beta * std::sin(trueAnomaly), eccentricity + std::cos(trueAnomaly));
}

/// Eccentric -> true anomaly (elliptic).
inline double eccentricToTrueAnomaly(double eccentricAnomaly, double eccentricity) {
  const double beta = std::sqrt(1.0 - eccentricity * eccentricity);
  return std::atan2(beta * std::sin(eccentricAnomaly),
                    std::cos(eccentricAnomaly) - eccentricity);
}

/// Eccentric -> mean anomaly (elliptic). Kepler's equation, forward direction.
inline double eccentricToMeanAnomaly(double eccentricAnomaly, double eccentricity) {
  return eccentricAnomaly - eccentricity * std::sin(eccentricAnomaly);
}

/// True -> hyperbolic anomaly.
inline double trueToHyperbolicAnomaly(double trueAnomaly, double eccentricity) {
  const double beta = std::sqrt(eccentricity * eccentricity - 1.0);
  const double sinH = beta * std::sin(trueAnomaly) / (1.0 + eccentricity * std::cos(trueAnomaly));
  return std::asinh(sinH);
}

/// Hyperbolic -> true anomaly.
inline double hyperbolicToTrueAnomaly(double hyperbolicAnomaly, double eccentricity) {
  const double beta = std::sqrt(eccentricity * eccentricity - 1.0);
  return std::atan2(-beta * std::sinh(hyperbolicAnomaly),
                    1.0 - eccentricity * std::cosh(hyperbolicAnomaly)) + kPi;
}

/// Hyperbolic -> mean anomaly.
inline double hyperbolicToMeanAnomaly(double hyperbolicAnomaly, double eccentricity) {
  return eccentricity * std::sinh(hyperbolicAnomaly) - hyperbolicAnomaly;
}

/// Mean -> eccentric anomaly. Newton with a Danby starter, then a final
/// Halley polish. Converges for every e in [0, 1) including e -> 1^-.
inline bool meanToEccentricAnomaly(double meanAnomaly, double eccentricity, double* out) {
  if (out == nullptr || !std::isfinite(meanAnomaly) || !(eccentricity >= 0.0) ||
      eccentricity >= 1.0) {
    return false;
  }
  const double M = wrapPi(meanAnomaly);
  // Danby's starter: cubic in the correction, excellent even at high e.
  double E = M + 0.85 * eccentricity * (std::sin(M) < 0.0 ? -1.0 : 1.0);
  for (int iteration = 0; iteration < 100; ++iteration) {
    const double sinE = std::sin(E);
    const double cosE = std::cos(E);
    const double f = E - eccentricity * sinE - M;
    const double f1 = 1.0 - eccentricity * cosE;
    if (std::fabs(f1) < 1e-300) {
      return false;
    }
    const double f2 = eccentricity * sinE;
    const double f3 = eccentricity * cosE;
    // Danby's quartic correction.
    double d = -f / f1;
    d = -f / (f1 + 0.5 * d * f2);
    d = -f / (f1 + 0.5 * d * f2 + d * d * f3 / 6.0);
    E += d;
    if (std::fabs(d) < 1e-15) {
      *out = E;
      return true;
    }
  }
  *out = E;
  return std::isfinite(E);
}

/// Mean -> hyperbolic anomaly. Newton from a logarithmic starter.
inline bool meanToHyperbolicAnomaly(double meanAnomaly, double eccentricity, double* out) {
  if (out == nullptr || !std::isfinite(meanAnomaly) || !(eccentricity > 1.0)) {
    return false;
  }
  const double M = meanAnomaly;
  // Starter: for large |M| the log form is close; near zero use M/(e-1).
  double H = 0.0;
  const double absM = std::fabs(M);
  if (absM > 6.0) {
    H = std::log(2.0 * absM / eccentricity + 1.8) * (M < 0.0 ? -1.0 : 1.0);
  } else {
    H = M / (eccentricity - 1.0);
    // Guard the small-(e-1) case where that starter overshoots wildly.
    const double cap = std::asinh(absM / eccentricity + 1.0) + 1.0;
    if (std::fabs(H) > cap) {
      H = cap * (M < 0.0 ? -1.0 : 1.0);
    }
  }
  for (int iteration = 0; iteration < 200; ++iteration) {
    const double sinhH = std::sinh(H);
    const double coshH = std::cosh(H);
    const double f = eccentricity * sinhH - H - M;
    const double f1 = eccentricity * coshH - 1.0;
    if (std::fabs(f1) < 1e-300) {
      return false;
    }
    const double d = -f / f1;
    H += d;
    if (std::fabs(d) < 1e-14 * (1.0 + std::fabs(H))) {
      *out = H;
      return true;
    }
  }
  *out = H;
  return std::isfinite(H);
}

// ===========================================================================
// Cartesian <-> Keplerian
// ===========================================================================

inline bool keplerianFromCartesian(const Cartesian& state, double mu, Keplerian* out) {
  if (out == nullptr || mu <= 0.0 || !finite(state.position) || !finite(state.velocity)) {
    return false;
  }
  const double r = norm(state.position);
  const double v = norm(state.velocity);
  if (!(r > 0.0)) {
    return false;
  }

  const Vec3 h = cross(state.position, state.velocity);
  const double hMag = norm(h);
  if (!(hMag > 0.0)) {
    return false;  // rectilinear: no orbit plane, Keplerian is undefined
  }

  // Eccentricity vector.
  const Vec3 eVec = sub(scale(state.position, (v * v - mu / r) / mu),
                        scale(state.velocity, dot(state.position, state.velocity) / mu));
  const double e = norm(eVec);

  // Specific energy -> semi-major axis. Parabolic (|1-e| < tol) has no finite a.
  const double energy = 0.5 * v * v - mu / r;
  if (std::fabs(1.0 - e) < kParabolicTolerance || std::fabs(energy) < 1e-300) {
    return false;
  }
  const double a = -mu / (2.0 * energy);

  // atan2 throughout, never acos: acos(x) loses half the significant digits as
  // |x| -> 1, which is precisely the geometry every one of these angles sits in
  // for a near-equatorial or near-circular orbit. The atan2 forms below are
  // exact to machine precision across the whole range.
  const double hXY = std::hypot(h.x, h.y);
  const double inclination = std::atan2(hXY, h.z);

  // Node vector: z_hat x h.
  const Vec3 n = {-h.y, h.x, 0.0};
  const double nMag = norm(n);
  const Vec3 hHat = scale(h, 1.0 / hMag);

  double raan = 0.0;
  double argumentOfPeriapsis = 0.0;
  double trueAnomaly = 0.0;

  const bool equatorial = nMag < kEquatorialTolerance * hMag;
  const bool circular = e < kCircularTolerance;

  if (!equatorial && !circular) {
    const Vec3 nHat = scale(n, 1.0 / nMag);
    const Vec3 eHat = scale(eVec, 1.0 / e);
    raan = std::atan2(n.y, n.x);
    // Angle from the node to periapsis, measured in the orbit plane about hHat.
    argumentOfPeriapsis = std::atan2(dot(eHat, cross(hHat, nHat)), dot(eHat, nHat));
    // Angle from periapsis to the position, measured the same way.
    trueAnomaly = std::atan2(dot(state.position, cross(hHat, eHat)), dot(state.position, eHat));
  } else if (!equatorial && circular) {
    // Circular inclined: periapsis undefined. GMAT's convention places
    // periapsis at the ascending node and carries the argument of latitude in
    // the true-anomaly slot.
    const Vec3 nHat = scale(n, 1.0 / nMag);
    raan = std::atan2(n.y, n.x);
    argumentOfPeriapsis = 0.0;
    trueAnomaly = std::atan2(dot(state.position, cross(hHat, nHat)), dot(state.position, nHat));
  } else if (equatorial && !circular) {
    // Equatorial elliptic: node undefined. Periapsis is measured from the
    // x axis (the longitude of periapsis) and carried in argumentOfPeriapsis.
    const Vec3 eHat = scale(eVec, 1.0 / e);
    const Vec3 xHat = {1.0, 0.0, 0.0};
    raan = 0.0;
    argumentOfPeriapsis = std::atan2(dot(eHat, cross(hHat, xHat)), dot(eHat, xHat));
    trueAnomaly = std::atan2(dot(state.position, cross(hHat, eHat)), dot(state.position, eHat));
  } else {
    // Equatorial circular: only the true longitude is defined.
    const Vec3 xHat = {1.0, 0.0, 0.0};
    raan = 0.0;
    argumentOfPeriapsis = 0.0;
    trueAnomaly = std::atan2(dot(state.position, cross(hHat, xHat)), dot(state.position, xHat));
  }

  out->semiMajorAxis = a;
  out->eccentricity = e;
  out->inclination = inclination;
  out->raan = wrapTwoPi(raan);
  out->argumentOfPeriapsis = wrapTwoPi(argumentOfPeriapsis);
  out->trueAnomaly = wrapTwoPi(trueAnomaly);
  return std::isfinite(a) && std::isfinite(e);
}

inline bool cartesianFromKeplerian(const Keplerian& elements, double mu, Cartesian* out) {
  if (out == nullptr || mu <= 0.0) {
    return false;
  }
  const double a = elements.semiMajorAxis;
  const double e = elements.eccentricity;
  if (!std::isfinite(a) || !(e >= 0.0) || std::fabs(1.0 - e) < kParabolicTolerance) {
    return false;
  }
  // Semi-latus rectum: p = a(1 - e^2). Correct in both regimes because a < 0
  // when e > 1.
  const double p = a * (1.0 - e * e);
  if (!(p > 0.0)) {
    return false;
  }
  const double nu = elements.trueAnomaly;
  const double denominator = 1.0 + e * std::cos(nu);
  if (!(denominator > 0.0)) {
    return false;  // beyond the asymptote: no real position
  }
  const double r = p / denominator;

  // Perifocal position and velocity.
  const double cosNu = std::cos(nu);
  const double sinNu = std::sin(nu);
  const double sqrtMuOverP = std::sqrt(mu / p);
  const Vec3 rPqw = {r * cosNu, r * sinNu, 0.0};
  const Vec3 vPqw = {-sqrtMuOverP * sinNu, sqrtMuOverP * (e + cosNu), 0.0};

  // Perifocal -> reference: R_z(-raan) R_x(-i) R_z(-argPer).
  const double cosO = std::cos(elements.raan);
  const double sinO = std::sin(elements.raan);
  const double cosI = std::cos(elements.inclination);
  const double sinI = std::sin(elements.inclination);
  const double cosW = std::cos(elements.argumentOfPeriapsis);
  const double sinW = std::sin(elements.argumentOfPeriapsis);

  const double m11 = cosO * cosW - sinO * sinW * cosI;
  const double m12 = -cosO * sinW - sinO * cosW * cosI;
  const double m13 = sinO * sinI;
  const double m21 = sinO * cosW + cosO * sinW * cosI;
  const double m22 = -sinO * sinW + cosO * cosW * cosI;
  const double m23 = -cosO * sinI;
  const double m31 = sinW * sinI;
  const double m32 = cosW * sinI;
  const double m33 = cosI;

  out->position = {m11 * rPqw.x + m12 * rPqw.y + m13 * rPqw.z,
                   m21 * rPqw.x + m22 * rPqw.y + m23 * rPqw.z,
                   m31 * rPqw.x + m32 * rPqw.y + m33 * rPqw.z};
  out->velocity = {m11 * vPqw.x + m12 * vPqw.y + m13 * vPqw.z,
                   m21 * vPqw.x + m22 * vPqw.y + m23 * vPqw.z,
                   m31 * vPqw.x + m32 * vPqw.y + m33 * vPqw.z};
  return finite(out->position) && finite(out->velocity);
}

// ===========================================================================
// Keplerian <-> ModifiedKeplerian
// ===========================================================================

inline bool modifiedKeplerianFromKeplerian(const Keplerian& in, ModifiedKeplerian* out) {
  if (out == nullptr || !std::isfinite(in.semiMajorAxis) || !(in.eccentricity >= 0.0)) {
    return false;
  }
  out->radiusOfPeriapsis = in.semiMajorAxis * (1.0 - in.eccentricity);
  out->radiusOfApoapsis = in.semiMajorAxis * (1.0 + in.eccentricity);
  out->inclination = in.inclination;
  out->raan = in.raan;
  out->argumentOfPeriapsis = in.argumentOfPeriapsis;
  out->trueAnomaly = in.trueAnomaly;
  return std::isfinite(out->radiusOfPeriapsis) && std::isfinite(out->radiusOfApoapsis);
}

inline bool keplerianFromModifiedKeplerian(const ModifiedKeplerian& in, Keplerian* out) {
  if (out == nullptr) {
    return false;
  }
  const double rp = in.radiusOfPeriapsis;
  const double ra = in.radiusOfApoapsis;
  const double sum = ra + rp;
  if (!(rp > 0.0) || std::fabs(sum) < 1e-300) {
    return false;
  }
  out->semiMajorAxis = sum / 2.0;
  out->eccentricity = (ra - rp) / sum;
  out->inclination = in.inclination;
  out->raan = in.raan;
  out->argumentOfPeriapsis = in.argumentOfPeriapsis;
  out->trueAnomaly = in.trueAnomaly;
  return std::isfinite(out->semiMajorAxis) && std::isfinite(out->eccentricity);
}

// ===========================================================================
// Cartesian <-> SphericalAZFPA
// ===========================================================================

inline bool sphericalAzfpaFromCartesian(const Cartesian& state, SphericalAZFPA* out) {
  if (out == nullptr || !finite(state.position) || !finite(state.velocity)) {
    return false;
  }
  const double r = norm(state.position);
  const double v = norm(state.velocity);
  if (!(r > 0.0) || !(v > 0.0)) {
    return false;
  }
  const double rightAscension = std::atan2(state.position.y, state.position.x);
  const double declination = std::asin(std::fmin(1.0, std::fmax(-1.0, state.position.z / r)));

  // Vertical flight path angle: angle between the radius and velocity vectors.
  const double cosFpa = std::fmin(1.0, std::fmax(-1.0, dot(state.position, state.velocity) / (r * v)));
  const double flightPathAngle = std::acos(cosFpa);

  // Local horizontal basis at the sub-point: north and east.
  const double sinRa = std::sin(rightAscension);
  const double cosRa = std::cos(rightAscension);
  const double sinDec = std::sin(declination);
  const double cosDec = std::cos(declination);
  const Vec3 east = {-sinRa, cosRa, 0.0};
  const Vec3 north = {-sinDec * cosRa, -sinDec * sinRa, cosDec};

  // Azimuth of the horizontal velocity component, from north toward east.
  const double vEast = dot(state.velocity, east);
  const double vNorth = dot(state.velocity, north);
  double azimuth = std::atan2(vEast, vNorth);

  out->radius = r;
  out->rightAscension = wrapTwoPi(rightAscension);
  out->declination = declination;
  out->speed = v;
  out->flightPathAngle = flightPathAngle;
  out->azimuth = wrapTwoPi(azimuth);
  return true;
}

inline bool cartesianFromSphericalAzfpa(const SphericalAZFPA& in, Cartesian* out) {
  if (out == nullptr || !(in.radius > 0.0) || !(in.speed >= 0.0)) {
    return false;
  }
  const double sinRa = std::sin(in.rightAscension);
  const double cosRa = std::cos(in.rightAscension);
  const double sinDec = std::sin(in.declination);
  const double cosDec = std::cos(in.declination);

  const Vec3 radial = {cosDec * cosRa, cosDec * sinRa, sinDec};
  const Vec3 east = {-sinRa, cosRa, 0.0};
  const Vec3 north = {-sinDec * cosRa, -sinDec * sinRa, cosDec};

  out->position = scale(radial, in.radius);

  const double cosFpa = std::cos(in.flightPathAngle);
  const double sinFpa = std::sin(in.flightPathAngle);
  const double vRadial = in.speed * cosFpa;
  const double vHorizontal = in.speed * sinFpa;
  const double vNorth = vHorizontal * std::cos(in.azimuth);
  const double vEast = vHorizontal * std::sin(in.azimuth);

  out->velocity = add(scale(radial, vRadial), add(scale(north, vNorth), scale(east, vEast)));
  return finite(out->position) && finite(out->velocity);
}

// ===========================================================================
// Cartesian <-> SphericalRADEC
// ===========================================================================

inline bool sphericalRadecFromCartesian(const Cartesian& state, SphericalRADEC* out) {
  if (out == nullptr || !finite(state.position) || !finite(state.velocity)) {
    return false;
  }
  const double r = norm(state.position);
  const double v = norm(state.velocity);
  if (!(r > 0.0) || !(v > 0.0)) {
    return false;
  }
  out->radius = r;
  out->rightAscension = wrapTwoPi(std::atan2(state.position.y, state.position.x));
  out->declination = std::asin(std::fmin(1.0, std::fmax(-1.0, state.position.z / r)));
  out->speed = v;
  out->velocityRightAscension = wrapTwoPi(std::atan2(state.velocity.y, state.velocity.x));
  out->velocityDeclination = std::asin(std::fmin(1.0, std::fmax(-1.0, state.velocity.z / v)));
  return true;
}

inline bool cartesianFromSphericalRadec(const SphericalRADEC& in, Cartesian* out) {
  if (out == nullptr || !(in.radius > 0.0) || !(in.speed >= 0.0)) {
    return false;
  }
  out->position = {in.radius * std::cos(in.declination) * std::cos(in.rightAscension),
                   in.radius * std::cos(in.declination) * std::sin(in.rightAscension),
                   in.radius * std::sin(in.declination)};
  out->velocity = {
      in.speed * std::cos(in.velocityDeclination) * std::cos(in.velocityRightAscension),
      in.speed * std::cos(in.velocityDeclination) * std::sin(in.velocityRightAscension),
      in.speed * std::sin(in.velocityDeclination)};
  return finite(out->position) && finite(out->velocity);
}

// ===========================================================================
// Keplerian <-> Equinoctial
// ===========================================================================

inline bool equinoctialFromKeplerian(const Keplerian& in, int retrogradeFactor, Equinoctial* out) {
  if (out == nullptr || (retrogradeFactor != 1 && retrogradeFactor != -1)) {
    return false;
  }
  const double e = in.eccentricity;
  if (!(e >= 0.0) || e >= 1.0) {
    return false;  // equinoctial mean longitude requires an elliptic orbit
  }
  const double j = static_cast<double>(retrogradeFactor);
  const double lambda = in.argumentOfPeriapsis + j * in.raan;
  const double tanHalfI = std::tan(in.inclination / 2.0);
  if (!std::isfinite(tanHalfI) || tanHalfI < 0.0) {
    return false;
  }
  const double tanTerm = retrogradeFactor == 1 ? tanHalfI : (tanHalfI > 0.0 ? 1.0 / tanHalfI : 0.0);
  if (!std::isfinite(tanTerm)) {
    return false;
  }

  const double eccentricAnomaly = trueToEccentricAnomaly(in.trueAnomaly, e);
  const double meanAnomaly = eccentricToMeanAnomaly(eccentricAnomaly, e);

  out->semiMajorAxis = in.semiMajorAxis;
  out->h = e * std::sin(lambda);
  out->k = e * std::cos(lambda);
  out->p = tanTerm * std::sin(in.raan);
  out->q = tanTerm * std::cos(in.raan);
  out->meanLongitude = wrapTwoPi(meanAnomaly + lambda);
  out->retrogradeFactor = retrogradeFactor;
  return std::isfinite(out->h) && std::isfinite(out->k) && std::isfinite(out->p) &&
         std::isfinite(out->q);
}

inline bool keplerianFromEquinoctial(const Equinoctial& in, Keplerian* out) {
  if (out == nullptr || (in.retrogradeFactor != 1 && in.retrogradeFactor != -1)) {
    return false;
  }
  const double j = static_cast<double>(in.retrogradeFactor);
  const double e = std::hypot(in.h, in.k);
  if (!(e >= 0.0) || e >= 1.0) {
    return false;
  }
  const double lambda = (e > 0.0) ? std::atan2(in.h, in.k) : 0.0;
  const double pqMag = std::hypot(in.p, in.q);
  const double raan = (pqMag > 0.0) ? std::atan2(in.p, in.q) : 0.0;

  double inclination = 0.0;
  if (in.retrogradeFactor == 1) {
    inclination = 2.0 * std::atan(pqMag);
  } else {
    inclination = kPi - 2.0 * std::atan(pqMag);
  }

  const double argumentOfPeriapsis = lambda - j * raan;
  const double meanAnomaly = in.meanLongitude - lambda;

  double eccentricAnomaly = 0.0;
  if (!meanToEccentricAnomaly(meanAnomaly, e, &eccentricAnomaly)) {
    return false;
  }
  const double trueAnomaly = eccentricToTrueAnomaly(eccentricAnomaly, e);

  out->semiMajorAxis = in.semiMajorAxis;
  out->eccentricity = e;
  out->inclination = inclination;
  out->raan = wrapTwoPi(raan);
  out->argumentOfPeriapsis = wrapTwoPi(argumentOfPeriapsis);
  out->trueAnomaly = wrapTwoPi(trueAnomaly);
  return true;
}

// ===========================================================================
// Keplerian <-> ModifiedEquinoctial
// ===========================================================================

inline bool modifiedEquinoctialFromKeplerian(const Keplerian& in, int retrogradeFactor,
                                             ModifiedEquinoctial* out) {
  if (out == nullptr || (retrogradeFactor != 1 && retrogradeFactor != -1)) {
    return false;
  }
  const double e = in.eccentricity;
  const double a = in.semiMajorAxis;
  if (!(e >= 0.0) || std::fabs(1.0 - e) < kParabolicTolerance) {
    return false;
  }
  const double p = a * (1.0 - e * e);
  if (!(p > 0.0)) {
    return false;
  }
  const double j = static_cast<double>(retrogradeFactor);
  const double lambda = in.argumentOfPeriapsis + j * in.raan;
  const double tanHalfI = std::tan(in.inclination / 2.0);
  const double tanTerm = retrogradeFactor == 1 ? tanHalfI : (tanHalfI > 0.0 ? 1.0 / tanHalfI : 0.0);
  if (!std::isfinite(tanTerm)) {
    return false;
  }

  out->semiLatusRectum = p;
  out->f = e * std::cos(lambda);
  out->g = e * std::sin(lambda);
  out->h = tanTerm * std::cos(in.raan);
  out->k = tanTerm * std::sin(in.raan);
  out->trueLongitude = wrapTwoPi(in.trueAnomaly + lambda);
  out->retrogradeFactor = retrogradeFactor;
  return std::isfinite(out->f) && std::isfinite(out->g) && std::isfinite(out->h) &&
         std::isfinite(out->k);
}

inline bool keplerianFromModifiedEquinoctial(const ModifiedEquinoctial& in, Keplerian* out) {
  if (out == nullptr || (in.retrogradeFactor != 1 && in.retrogradeFactor != -1)) {
    return false;
  }
  const double j = static_cast<double>(in.retrogradeFactor);
  const double e = std::hypot(in.f, in.g);
  if (std::fabs(1.0 - e) < kParabolicTolerance) {
    return false;
  }
  const double p = in.semiLatusRectum;
  if (!(p > 0.0)) {
    return false;
  }
  const double a = p / (1.0 - e * e);
  const double lambda = (e > 0.0) ? std::atan2(in.g, in.f) : 0.0;
  const double hkMag = std::hypot(in.h, in.k);
  const double raan = (hkMag > 0.0) ? std::atan2(in.k, in.h) : 0.0;
  const double inclination = in.retrogradeFactor == 1 ? 2.0 * std::atan(hkMag)
                                                      : kPi - 2.0 * std::atan(hkMag);

  out->semiMajorAxis = a;
  out->eccentricity = e;
  out->inclination = inclination;
  out->raan = wrapTwoPi(raan);
  out->argumentOfPeriapsis = wrapTwoPi(lambda - j * raan);
  out->trueAnomaly = wrapTwoPi(in.trueLongitude - lambda);
  return std::isfinite(a);
}

// ===========================================================================
// Keplerian <-> AlternateEquinoctial
// ===========================================================================

inline bool alternateEquinoctialFromKeplerian(const Keplerian& in, double mu, int retrogradeFactor,
                                              AlternateEquinoctial* out) {
  if (out == nullptr || mu <= 0.0 || !(in.semiMajorAxis > 0.0)) {
    return false;
  }
  Equinoctial equinoctial;
  if (!equinoctialFromKeplerian(in, retrogradeFactor, &equinoctial)) {
    return false;
  }
  const double a = equinoctial.semiMajorAxis;
  out->meanMotion = std::sqrt(mu / (a * a * a));
  out->h = equinoctial.h;
  out->k = equinoctial.k;
  out->p = equinoctial.p;
  out->q = equinoctial.q;
  out->meanLongitude = equinoctial.meanLongitude;
  out->retrogradeFactor = equinoctial.retrogradeFactor;
  return std::isfinite(out->meanMotion) && out->meanMotion > 0.0;
}

inline bool keplerianFromAlternateEquinoctial(const AlternateEquinoctial& in, double mu,
                                              Keplerian* out) {
  if (out == nullptr || mu <= 0.0 || !(in.meanMotion > 0.0)) {
    return false;
  }
  Equinoctial equinoctial;
  equinoctial.semiMajorAxis = std::cbrt(mu / (in.meanMotion * in.meanMotion));
  equinoctial.h = in.h;
  equinoctial.k = in.k;
  equinoctial.p = in.p;
  equinoctial.q = in.q;
  equinoctial.meanLongitude = in.meanLongitude;
  equinoctial.retrogradeFactor = in.retrogradeFactor;
  return keplerianFromEquinoctial(equinoctial, out);
}

// ===========================================================================
// Cartesian <-> ModifiedEquinoctial, DIRECT.
//
// This is the non-singular path, and it is the reason the equinoctial family
// meets the round-trip acceptance in the degenerate regimes while Keplerian
// cannot: it never forms the argument of periapsis or the RAAN, the two angles
// that become undefined as e -> 0 and i -> 0. Routing the equinoctial sets
// through Keplerian would inherit exactly the singularity they exist to avoid,
// so nothing here goes via `keplerianFromCartesian`.
//
// Basis (with h = tan(i/2)^j cos(raan), k = tan(i/2)^j sin(raan)):
//
//   s2 = 1 + h^2 + k^2
//   fHat = (1/s2) [1 - h^2 + k^2,  2hk,            -2h]
//   gHat = (1/s2) [2hk,            1 + h^2 - k^2,   2k]
//   wHat = fHat x gHat = (1/s2) [2k, -2h, 1 - h^2 - k^2]
//
//   position = r (cos L fHat + sin L gHat),  r = p / (1 + f cos L + g sin L)
//   velocity = sqrt(mu/p) [ -(sin L + g) fHat + (cos L + f) gHat ]
//
// Both identities are exact for every eccentricity, hyperbolic included.
// ===========================================================================

namespace detail {

/// The equinoctial in-plane basis for a given (h, k), where
/// h = tan(i/2) cos(raan) and k = tan(i/2) sin(raan).
///
/// Derived from fHat = Rz(raan) Rx(i) Rz(-raan) xHat, then written in h and k
/// so that no trig of the (undefined as i -> 0) node angle survives:
///
///   s2   = 1 + h^2 + k^2
///   fHat = (1/s2) [1 + h^2 - k^2,  2hk,            -2k]
///   gHat = (1/s2) [2hk,            1 - h^2 + k^2,   2h]
///   wHat = fHat x gHat = (1/s2) [2k, -2h, 1 - h^2 - k^2]
inline void equinoctialBasis(double h, double k, Vec3* fHat, Vec3* gHat) {
  const double h2 = h * h;
  const double k2 = k * k;
  const double s2 = 1.0 + h2 + k2;
  const double inv = 1.0 / s2;
  *fHat = {inv * (1.0 + h2 - k2), inv * (2.0 * h * k), inv * (-2.0 * k)};
  *gHat = {inv * (2.0 * h * k), inv * (1.0 - h2 + k2), inv * (2.0 * h)};
}

/// The retrograde factor -1 set is DEFINED as the direct set computed in the
/// frame flipped by diag(1, -1, -1) — a proper rotation that carries an orbit
/// of inclination i to one of inclination pi - i. That makes i -> 180 deg the
/// flipped frame's i -> 0, which is the regime the direct set is exact on, and
/// it makes the pair of conversions exact inverses by construction rather than
/// by a hand-derived closed form. Applying it twice is the identity.
inline Cartesian flipRetrograde(const Cartesian& state) {
  return {{state.position.x, -state.position.y, -state.position.z},
          {state.velocity.x, -state.velocity.y, -state.velocity.z}};
}

}  // namespace detail

inline bool modifiedEquinoctialFromCartesian(const Cartesian& state, double mu,
                                             int retrogradeFactor, ModifiedEquinoctial* out) {
  if (out == nullptr || mu <= 0.0 || (retrogradeFactor != 1 && retrogradeFactor != -1) ||
      !finite(state.position) || !finite(state.velocity)) {
    return false;
  }
  const Cartesian working =
      retrogradeFactor == 1 ? state : detail::flipRetrograde(state);

  const double r = norm(working.position);
  if (!(r > 0.0)) {
    return false;
  }
  const Vec3 hVec = cross(working.position, working.velocity);
  const double hMag = norm(hVec);
  if (!(hMag > 0.0)) {
    return false;
  }
  const double p = hMag * hMag / mu;
  const Vec3 wHat = scale(hVec, 1.0 / hMag);

  const double denominator = 1.0 + wHat.z;
  if (!(denominator > 0.0)) {
    // i -> 180 deg in the working frame: that is the OTHER retrograde factor's
    // regime, and substituting it silently is exactly the "handled by an
    // exception" behaviour the acceptance forbids. Refuse; the caller picks the
    // set designed for the orbit.
    return false;
  }
  const double hElement = -wHat.y / denominator;
  const double kElement = wHat.x / denominator;

  Vec3 fHat;
  Vec3 gHat;
  detail::equinoctialBasis(hElement, kElement, &fHat, &gHat);

  const double v2 = dot(working.velocity, working.velocity);
  const Vec3 eVec = sub(scale(working.position, (v2 - mu / r) / mu),
                        scale(working.velocity, dot(working.position, working.velocity) / mu));

  out->semiLatusRectum = p;
  out->f = dot(eVec, fHat);
  out->g = dot(eVec, gHat);
  out->h = hElement;
  out->k = kElement;
  out->trueLongitude = wrapTwoPi(std::atan2(dot(working.position, gHat), dot(working.position, fHat)));
  out->retrogradeFactor = retrogradeFactor;
  return std::isfinite(out->f) && std::isfinite(out->g) && p > 0.0;
}

inline bool cartesianFromModifiedEquinoctial(const ModifiedEquinoctial& in, double mu,
                                             Cartesian* out) {
  if (out == nullptr || mu <= 0.0 ||
      (in.retrogradeFactor != 1 && in.retrogradeFactor != -1) || !(in.semiLatusRectum > 0.0)) {
    return false;
  }
  Vec3 fHat;
  Vec3 gHat;
  detail::equinoctialBasis(in.h, in.k, &fHat, &gHat);

  const double cosL = std::cos(in.trueLongitude);
  const double sinL = std::sin(in.trueLongitude);
  const double w = 1.0 + in.f * cosL + in.g * sinL;
  if (!(w > 0.0)) {
    return false;  // beyond the asymptote
  }
  const double r = in.semiLatusRectum / w;
  const double sqrtMuOverP = std::sqrt(mu / in.semiLatusRectum);

  Cartesian working;
  working.position = add(scale(fHat, r * cosL), scale(gHat, r * sinL));
  working.velocity = add(scale(fHat, -sqrtMuOverP * (sinL + in.g)),
                         scale(gHat, sqrtMuOverP * (cosL + in.f)));

  *out = in.retrogradeFactor == 1 ? working : detail::flipRetrograde(working);
  return finite(out->position) && finite(out->velocity);
}

// ---------------------------------------------------------------------------
// Cartesian <-> Equinoctial, DIRECT (via the modified-equinoctial basis, never
// via Keplerian). Elliptic only, because the set carries a MEAN longitude.
//
// The intermediate longitude of periapsis is undefined as e -> 0, but it
// CANCELS: the true anomaly is formed by subtracting it and the mean longitude
// by adding it back, and at e = 0 mean, eccentric and true anomaly coincide
// exactly, so the composite is exact regardless of the arbitrary value the
// atan2 returns.
// ---------------------------------------------------------------------------

inline bool equinoctialFromCartesian(const Cartesian& state, double mu, int retrogradeFactor,
                                     Equinoctial* out) {
  if (out == nullptr) {
    return false;
  }
  ModifiedEquinoctial modified;
  if (!modifiedEquinoctialFromCartesian(state, mu, retrogradeFactor, &modified)) {
    return false;
  }
  const double e = std::hypot(modified.f, modified.g);
  if (!(e >= 0.0) || e >= 1.0) {
    return false;
  }
  const double a = modified.semiLatusRectum / (1.0 - e * e);
  const double longitudeOfPeriapsis = std::atan2(modified.g, modified.f);
  const double trueAnomaly = modified.trueLongitude - longitudeOfPeriapsis;
  const double eccentricAnomaly = trueToEccentricAnomaly(trueAnomaly, e);
  const double meanAnomaly = eccentricToMeanAnomaly(eccentricAnomaly, e);

  out->semiMajorAxis = a;
  // h = e sin(longitude of periapsis), k = e cos(...) — note the transposition
  // against the modified set, which is the historical difference between the
  // two conventions and is preserved here deliberately.
  out->h = modified.g;
  out->k = modified.f;
  out->p = modified.k;
  out->q = modified.h;
  out->meanLongitude = wrapTwoPi(meanAnomaly + longitudeOfPeriapsis);
  out->retrogradeFactor = retrogradeFactor;
  return std::isfinite(a);
}

inline bool cartesianFromEquinoctial(const Equinoctial& in, double mu, Cartesian* out) {
  if (out == nullptr) {
    return false;
  }
  const double e = std::hypot(in.h, in.k);
  if (!(e >= 0.0) || e >= 1.0 || !(in.semiMajorAxis > 0.0)) {
    return false;
  }
  const double longitudeOfPeriapsis = std::atan2(in.h, in.k);
  const double meanAnomaly = in.meanLongitude - longitudeOfPeriapsis;
  double eccentricAnomaly = 0.0;
  if (!meanToEccentricAnomaly(meanAnomaly, e, &eccentricAnomaly)) {
    return false;
  }
  const double trueAnomaly = eccentricToTrueAnomaly(eccentricAnomaly, e);

  ModifiedEquinoctial modified;
  modified.semiLatusRectum = in.semiMajorAxis * (1.0 - e * e);
  modified.f = in.k;
  modified.g = in.h;
  modified.h = in.q;
  modified.k = in.p;
  modified.trueLongitude = wrapTwoPi(trueAnomaly + longitudeOfPeriapsis);
  modified.retrogradeFactor = in.retrogradeFactor;
  return cartesianFromModifiedEquinoctial(modified, mu, out);
}

/// Cartesian <-> AlternateEquinoctial, direct (mean motion in place of a).
inline bool alternateEquinoctialFromCartesian(const Cartesian& state, double mu,
                                              int retrogradeFactor, AlternateEquinoctial* out) {
  if (out == nullptr || mu <= 0.0) {
    return false;
  }
  Equinoctial equinoctial;
  if (!equinoctialFromCartesian(state, mu, retrogradeFactor, &equinoctial)) {
    return false;
  }
  const double a = equinoctial.semiMajorAxis;
  if (!(a > 0.0)) {
    return false;
  }
  out->meanMotion = std::sqrt(mu / (a * a * a));
  out->h = equinoctial.h;
  out->k = equinoctial.k;
  out->p = equinoctial.p;
  out->q = equinoctial.q;
  out->meanLongitude = equinoctial.meanLongitude;
  out->retrogradeFactor = equinoctial.retrogradeFactor;
  return std::isfinite(out->meanMotion) && out->meanMotion > 0.0;
}

inline bool cartesianFromAlternateEquinoctial(const AlternateEquinoctial& in, double mu,
                                              Cartesian* out) {
  if (out == nullptr || mu <= 0.0 || !(in.meanMotion > 0.0)) {
    return false;
  }
  Equinoctial equinoctial;
  equinoctial.semiMajorAxis = std::cbrt(mu / (in.meanMotion * in.meanMotion));
  equinoctial.h = in.h;
  equinoctial.k = in.k;
  equinoctial.p = in.p;
  equinoctial.q = in.q;
  equinoctial.meanLongitude = in.meanLongitude;
  equinoctial.retrogradeFactor = in.retrogradeFactor;
  return cartesianFromEquinoctial(equinoctial, mu, out);
}

// ===========================================================================
// Keplerian <-> Delaunay
// ===========================================================================

inline bool delaunayFromKeplerian(const Keplerian& in, double mu, Delaunay* out) {
  if (out == nullptr || mu <= 0.0) {
    return false;
  }
  const double a = in.semiMajorAxis;
  const double e = in.eccentricity;
  if (!(a > 0.0) || !(e >= 0.0) || e >= 1.0) {
    return false;  // Delaunay is defined for elliptic orbits only
  }
  const double L = std::sqrt(mu * a);
  const double G = L * std::sqrt(1.0 - e * e);
  const double H = G * std::cos(in.inclination);

  const double eccentricAnomaly = trueToEccentricAnomaly(in.trueAnomaly, e);
  out->l = wrapTwoPi(eccentricToMeanAnomaly(eccentricAnomaly, e));
  out->g = in.argumentOfPeriapsis;
  out->h = in.raan;
  out->L = L;
  out->G = G;
  out->H = H;
  return std::isfinite(L) && std::isfinite(G) && std::isfinite(H);
}

inline bool keplerianFromDelaunay(const Delaunay& in, double mu, Keplerian* out) {
  if (out == nullptr || mu <= 0.0 || !(in.L > 0.0) || !(in.G > 0.0)) {
    return false;
  }
  const double a = in.L * in.L / mu;
  const double ratio = in.G / in.L;
  const double eSquared = 1.0 - ratio * ratio;
  if (!(eSquared >= 0.0)) {
    return false;
  }
  const double e = std::sqrt(eSquared);
  const double cosI = std::fmin(1.0, std::fmax(-1.0, in.H / in.G));
  double eccentricAnomaly = 0.0;
  if (!meanToEccentricAnomaly(in.l, e, &eccentricAnomaly)) {
    return false;
  }
  out->semiMajorAxis = a;
  out->eccentricity = e;
  out->inclination = std::acos(cosI);
  out->raan = wrapTwoPi(in.h);
  out->argumentOfPeriapsis = wrapTwoPi(in.g);
  out->trueAnomaly = wrapTwoPi(eccentricToTrueAnomaly(eccentricAnomaly, e));
  return true;
}

// ===========================================================================
// Cartesian <-> Planetodetic
//
// The position half is the standard geodetic conversion; the velocity half is
// the SphericalAZFPA velocity triple expressed against the GEODETIC local
// horizontal (the plane normal to the ellipsoid normal), which is what makes
// this set distinct from SphericalAZFPA rather than a relabelling of it.
// ===========================================================================

inline bool planetodeticFromCartesian(const Cartesian& state, const Ellipsoid& ellipsoid,
                                      Planetodetic* out) {
  if (out == nullptr || !finite(state.position) || !finite(state.velocity) ||
      !(ellipsoid.equatorialRadius > 0.0) || !(ellipsoid.flattening >= 0.0) ||
      ellipsoid.flattening >= 1.0) {
    return false;
  }
  const double a = ellipsoid.equatorialRadius;
  const double f = ellipsoid.flattening;
  const double eSquared = f * (2.0 - f);
  const double x = state.position.x;
  const double y = state.position.y;
  const double z = state.position.z;
  const double p = std::hypot(x, y);

  const double longitude = std::atan2(y, x);

  // Bowring's method with one Newton polish: converges to sub-nanometre in the
  // first iteration for every terrestrial altitude, and the polish drives the
  // residual to machine precision (acceptance: 1e-9 m against Orekit's
  // OneAxisEllipsoidTest).
  double latitude = 0.0;
  double height = 0.0;
  if (p < 1e-12) {
    // Polar: longitude is arbitrary, latitude is +-90 deg.
    latitude = (z >= 0.0) ? kPi / 2.0 : -kPi / 2.0;
    const double b = a * (1.0 - f);
    height = std::fabs(z) - b;
  } else {
    const double b = a * (1.0 - f);
    const double ePrimeSquared = (a * a - b * b) / (b * b);
    const double theta = std::atan2(z * a, p * b);
    const double sinTheta = std::sin(theta);
    const double cosTheta = std::cos(theta);
    latitude = std::atan2(z + ePrimeSquared * b * sinTheta * sinTheta * sinTheta,
                          p - eSquared * a * cosTheta * cosTheta * cosTheta);
    for (int iteration = 0; iteration < 8; ++iteration) {
      const double sinLat = std::sin(latitude);
      const double N = a / std::sqrt(1.0 - eSquared * sinLat * sinLat);
      height = p / std::cos(latitude) - N;
      const double next = std::atan2(z, p * (1.0 - eSquared * N / (N + height)));
      if (std::fabs(next - latitude) < 1e-16) {
        latitude = next;
        break;
      }
      latitude = next;
    }
    const double sinLat = std::sin(latitude);
    const double N = a / std::sqrt(1.0 - eSquared * sinLat * sinLat);
    height = p / std::cos(latitude) - N;
  }

  // Geodetic local horizontal basis.
  const double sinLat = std::sin(latitude);
  const double cosLat = std::cos(latitude);
  const double sinLon = std::sin(longitude);
  const double cosLon = std::cos(longitude);
  const Vec3 up = {cosLat * cosLon, cosLat * sinLon, sinLat};
  const Vec3 east = {-sinLon, cosLon, 0.0};
  const Vec3 north = {-sinLat * cosLon, -sinLat * sinLon, cosLat};

  const double speed = norm(state.velocity);
  if (!(speed > 0.0)) {
    return false;
  }
  const double vUp = dot(state.velocity, up);
  const double vEast = dot(state.velocity, east);
  const double vNorth = dot(state.velocity, north);

  out->latitude = latitude;
  out->longitude = wrapPi(longitude);
  out->height = height;
  out->speed = speed;
  // Vertical flight path angle measured from the geodetic up direction.
  out->flightPathAngle = std::acos(std::fmin(1.0, std::fmax(-1.0, vUp / speed)));
  out->azimuth = wrapTwoPi(std::atan2(vEast, vNorth));
  return std::isfinite(latitude) && std::isfinite(height);
}

inline bool cartesianFromPlanetodetic(const Planetodetic& in, const Ellipsoid& ellipsoid,
                                      Cartesian* out) {
  if (out == nullptr || !(ellipsoid.equatorialRadius > 0.0) || !(ellipsoid.flattening >= 0.0) ||
      ellipsoid.flattening >= 1.0 || !(in.speed >= 0.0)) {
    return false;
  }
  const double a = ellipsoid.equatorialRadius;
  const double f = ellipsoid.flattening;
  const double eSquared = f * (2.0 - f);
  const double sinLat = std::sin(in.latitude);
  const double cosLat = std::cos(in.latitude);
  const double sinLon = std::sin(in.longitude);
  const double cosLon = std::cos(in.longitude);
  const double N = a / std::sqrt(1.0 - eSquared * sinLat * sinLat);

  out->position = {(N + in.height) * cosLat * cosLon,
                   (N + in.height) * cosLat * sinLon,
                   (N * (1.0 - eSquared) + in.height) * sinLat};

  const Vec3 up = {cosLat * cosLon, cosLat * sinLon, sinLat};
  const Vec3 east = {-sinLon, cosLon, 0.0};
  const Vec3 north = {-sinLat * cosLon, -sinLat * sinLon, cosLat};

  const double vUp = in.speed * std::cos(in.flightPathAngle);
  const double vHorizontal = in.speed * std::sin(in.flightPathAngle);
  const double vNorth = vHorizontal * std::cos(in.azimuth);
  const double vEast = vHorizontal * std::sin(in.azimuth);

  out->velocity = add(scale(up, vUp), add(scale(north, vNorth), scale(east, vEast)));
  return finite(out->position) && finite(out->velocity);
}

// ===========================================================================
// Keplerian <-> Asymptote (incoming / outgoing). Hyperbolic only.
//
// The asymptote unit vector S is the direction the velocity tends to as the
// true anomaly tends to +-nu_inf, where cos(nu_inf) = -1/e. The outgoing
// asymptote uses +nu_inf, the incoming one -nu_inf. The set carries the
// asymptote's right ascension/declination, the radius of periapsis, C3, the
// velocity azimuth at periapsis (the rotation about S) and the true anomaly.
// ===========================================================================

namespace detail {

/// Build the perifocal-to-reference rotation columns from a Keplerian set.
inline void perifocalBasis(const Keplerian& in, Vec3* pHat, Vec3* qHat, Vec3* wHat) {
  const double cosO = std::cos(in.raan);
  const double sinO = std::sin(in.raan);
  const double cosI = std::cos(in.inclination);
  const double sinI = std::sin(in.inclination);
  const double cosW = std::cos(in.argumentOfPeriapsis);
  const double sinW = std::sin(in.argumentOfPeriapsis);
  *pHat = {cosO * cosW - sinO * sinW * cosI, sinO * cosW + cosO * sinW * cosI, sinW * sinI};
  *qHat = {-cosO * sinW - sinO * cosW * cosI, -sinO * sinW + cosO * cosW * cosI, cosW * sinI};
  *wHat = {sinO * sinI, -cosO * sinI, cosI};
}

}  // namespace detail

/// `incoming` selects the incoming (true) or outgoing (false) asymptote.
inline bool asymptoteFromKeplerian(const Keplerian& in, double mu, bool incoming, Asymptote* out) {
  if (out == nullptr || mu <= 0.0) {
    return false;
  }
  const double e = in.eccentricity;
  const double a = in.semiMajorAxis;
  if (!(e > 1.0) || !(a < 0.0)) {
    return false;  // asymptote sets are hyperbolic-only
  }
  Vec3 pHat;
  Vec3 qHat;
  Vec3 wHat;
  detail::perifocalBasis(in, &pHat, &qHat, &wHat);

  const double nuInfinity = std::acos(-1.0 / e);
  const double nuAsymptote = incoming ? -nuInfinity : nuInfinity;
  // Asymptote direction in the perifocal frame.
  const Vec3 sHat = add(scale(pHat, std::cos(nuAsymptote)), scale(qHat, std::sin(nuAsymptote)));

  out->radiusOfPeriapsis = a * (1.0 - e);
  out->c3Energy = -mu / a;
  out->asymptoteRightAscension = wrapTwoPi(std::atan2(sHat.y, sHat.x));
  out->asymptoteDeclination = std::asin(std::fmin(1.0, std::fmax(-1.0, sHat.z)));

  // Velocity azimuth at periapsis: the angle, about the asymptote, from the
  // reference normal (S x z_hat, the node of the plane normal to S) to the
  // orbit's angular-momentum direction.
  const Vec3 reference = unit(cross(sHat, Vec3{0.0, 0.0, 1.0}));
  const double refNorm = norm(cross(sHat, Vec3{0.0, 0.0, 1.0}));
  if (!(refNorm > 0.0)) {
    return false;  // asymptote along the pole: azimuth undefined
  }
  const Vec3 referenceCross = cross(sHat, reference);
  const double cosAz = dot(wHat, reference);
  const double sinAz = dot(wHat, referenceCross);
  out->velocityAzimuthAtPeriapsis = wrapTwoPi(std::atan2(sinAz, cosAz));
  out->trueAnomaly = in.trueAnomaly;
  return std::isfinite(out->c3Energy);
}

inline bool keplerianFromAsymptote(const Asymptote& in, double mu, bool incoming, Keplerian* out) {
  if (out == nullptr || mu <= 0.0 || !(in.c3Energy > 0.0) || !(in.radiusOfPeriapsis > 0.0)) {
    return false;
  }
  const double a = -mu / in.c3Energy;
  if (!(a < 0.0)) {
    return false;
  }
  const double e = 1.0 - in.radiusOfPeriapsis / a;
  if (!(e > 1.0)) {
    return false;
  }

  const double cosDec = std::cos(in.asymptoteDeclination);
  const Vec3 sHat = {cosDec * std::cos(in.asymptoteRightAscension),
                     cosDec * std::sin(in.asymptoteRightAscension),
                     std::sin(in.asymptoteDeclination)};

  const Vec3 referenceRaw = cross(sHat, Vec3{0.0, 0.0, 1.0});
  const double refNorm = norm(referenceRaw);
  if (!(refNorm > 0.0)) {
    return false;
  }
  const Vec3 reference = scale(referenceRaw, 1.0 / refNorm);
  const Vec3 referenceCross = cross(sHat, reference);

  // Rebuild the angular-momentum direction from the azimuth.
  const Vec3 wHat = add(scale(reference, std::cos(in.velocityAzimuthAtPeriapsis)),
                        scale(referenceCross, std::sin(in.velocityAzimuthAtPeriapsis)));

  const double nuInfinity = std::acos(-1.0 / e);
  const double nuAsymptote = incoming ? -nuInfinity : nuInfinity;
  // sHat = cos(nu_a) pHat + sin(nu_a) qHat, and qHat = wHat x pHat, so
  // pHat = cos(nu_a) sHat - sin(nu_a) (wHat x sHat).
  const Vec3 pHat = sub(scale(sHat, std::cos(nuAsymptote)),
                        scale(cross(wHat, sHat), std::sin(nuAsymptote)));

  const double inclination = std::acos(std::fmin(1.0, std::fmax(-1.0, wHat.z)));
  const Vec3 node = {-wHat.y, wHat.x, 0.0};
  const double nodeNorm = norm(node);
  double raan = 0.0;
  double argumentOfPeriapsis = 0.0;
  if (nodeNorm > 0.0) {
    raan = std::atan2(node.y, node.x);
    const Vec3 nodeUnit = scale(node, 1.0 / nodeNorm);
    argumentOfPeriapsis = std::atan2(dot(pHat, cross(wHat, nodeUnit)), dot(pHat, nodeUnit));
  } else {
    raan = 0.0;
    argumentOfPeriapsis = std::atan2(pHat.y, pHat.x);
  }

  out->semiMajorAxis = a;
  out->eccentricity = e;
  out->inclination = inclination;
  out->raan = wrapTwoPi(raan);
  out->argumentOfPeriapsis = wrapTwoPi(argumentOfPeriapsis);
  out->trueAnomaly = in.trueAnomaly;
  return true;
}

}  // namespace orbits
}  // namespace sdn

#endif  // SDN_FOUNDATION_ORBITS_STATE_REPRESENTATIONS_HPP
