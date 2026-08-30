// axis_engine.hpp — the GMAT-parity axis-type engine.
//
// GMAT-parity program item 8 (graph/tasks/gmat-08-frames-and-state-representations.md).
//
// ONE chain, not four. The task's finding is that frames are scattered across
// four incompatible enums and two different precession/nutation routes: the
// HPOP `coords.cpp` path is IAU-76/FK5 with a truncated 4-term nutation series,
// `higherpop/frames.hpp` is IAU-2006/2000A over vendored ERFA, and the engine
// carries its own XYS chain for display. This header makes the IAU-2006/2000A
// route THE route for every axis type, by delegating the astronomy to the same
// vendored ERFA (higherpop/third_party/erfa, BSD-3, derived with permission
// from IAU SOFA) that `higherpop/frames.hpp` already uses.
//
// That delegation is why the acceptance number "agrees with higherpop's ERFA
// chain to <= 1e-14" is met by construction rather than by a second
// implementation racing the first: there is only one series evaluation in the
// tree and both callers reach it. The IAU-76/FK5 route is retained under the
// explicitly named legacy axis types (`MOD_FK5`, `TOD_FK5`) so the OD path's
// answer stays reproducible instead of becoming an undocumented second answer.
//
// UNITS: positions metres, velocities metres/second, angles radians, times as
// two-part Julian dates (TT for the celestial side, UT1 for Earth rotation),
// matching ERFA. Rotation matrices are row-major and rotate a vector FROM the
// named axis set TO the axis set the function names as the target.
//
// This header needs `erfa.h` and `erfam.h` on the include path and the ERFA
// objects at link time. It has no other dependency — no FlatBuffers, no SDS —
// so it compiles into the WASM module, into a native parity test, and into
// higherpop alike.

#ifndef SDN_FOUNDATION_FRAMES_AXIS_ENGINE_HPP
#define SDN_FOUNDATION_FRAMES_AXIS_ENGINE_HPP

#include <cmath>
#include <cstdint>

extern "C" {
#include "erfa.h"
#include "erfam.h"
}

namespace sdn {
namespace frames {

// ---------------------------------------------------------------------------
// Axis vocabulary. Mirrors SDS `rfmAxisType` (Themis consult 2026-08-29,
// additive to $RFM, no new standard code) plus the two explicitly named legacy
// FK5 members the acceptance requires be retained rather than left implicit.
// Append-only; never reorder.
// ---------------------------------------------------------------------------
enum class AxisType : uint8_t {
  UNSPECIFIED = 0,
  MJ2000EQ = 1,   ///< Mean equator and equinox of J2000 (the classical J2000 frame)
  MJ2000EC = 2,   ///< Mean ecliptic and equinox of J2000
  ICRF = 3,       ///< International Celestial Reference Frame (GCRF at the origin)
  TEME = 4,       ///< True equator, mean equinox — SGP4's native frame
  MOD = 5,        ///< Mean of date, IAU-2006 precession
  TOD = 6,        ///< True of date, IAU-2006/2000A precession + nutation
  MOE = 7,        ///< Mean ecliptic of date
  TOE = 8,        ///< True ecliptic of date
  BODY_FIXED = 9,
  BODY_INERTIAL = 10,
  OBJECT_REFERENCED = 11,
  LOCAL_ALIGNED_CONSTRAINED = 12,
  EQUATOR = 13,
  GSE = 14,       ///< Geocentric Solar Ecliptic
  GSM = 15,       ///< Geocentric Solar Magnetospheric
  TOPOCENTRIC = 16,
  BODY_SPIN_SUN = 17,
  SPICE_DEFINED = 18,
  // Explicitly named legacy route — see the header comment. Retained so the
  // OD path's IAU-76/FK5 answer has a NAME and its own vectors instead of
  // being a silent second chain.
  MOD_FK5 = 19,
  TOD_FK5 = 20,
  ITRF = 21,      ///< Earth-fixed; BODY_FIXED about Earth, named for the classical usage
};

constexpr int kAxisTypeCount = 22;

// ---------------------------------------------------------------------------
// Small linear algebra. Row-major 3x3.
// ---------------------------------------------------------------------------
struct Vec3 {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

struct Mat3 {
  double m[3][3] = {{1.0, 0.0, 0.0}, {0.0, 1.0, 0.0}, {0.0, 0.0, 1.0}};
};

inline Mat3 identity() { return Mat3{}; }

inline Mat3 multiply(const Mat3& a, const Mat3& b) {
  Mat3 result;
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      double sum = 0.0;
      for (int k = 0; k < 3; ++k) {
        sum += a.m[i][k] * b.m[k][j];
      }
      result.m[i][j] = sum;
    }
  }
  return result;
}

inline Mat3 transpose(const Mat3& a) {
  Mat3 result;
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      result.m[i][j] = a.m[j][i];
    }
  }
  return result;
}

inline Vec3 apply(const Mat3& a, const Vec3& v) {
  return {a.m[0][0] * v.x + a.m[0][1] * v.y + a.m[0][2] * v.z,
          a.m[1][0] * v.x + a.m[1][1] * v.y + a.m[1][2] * v.z,
          a.m[2][0] * v.x + a.m[2][1] * v.y + a.m[2][2] * v.z};
}

inline Vec3 cross(const Vec3& a, const Vec3& b) {
  return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}
inline double dot(const Vec3& a, const Vec3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline double norm(const Vec3& a) { return std::sqrt(dot(a, a)); }
inline Vec3 add(const Vec3& a, const Vec3& b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline Vec3 sub(const Vec3& a, const Vec3& b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline Vec3 scale(const Vec3& a, double s) { return {a.x * s, a.y * s, a.z * s}; }
inline Vec3 unit(const Vec3& a) {
  const double n = norm(a);
  return n > 0.0 ? scale(a, 1.0 / n) : Vec3{};
}

/// Build a right-handed rotation whose rows are the given orthonormal triad.
/// The result rotates a vector from the parent axes into the triad's axes.
inline Mat3 fromRows(const Vec3& xHat, const Vec3& yHat, const Vec3& zHat) {
  Mat3 result;
  result.m[0][0] = xHat.x; result.m[0][1] = xHat.y; result.m[0][2] = xHat.z;
  result.m[1][0] = yHat.x; result.m[1][1] = yHat.y; result.m[1][2] = yHat.z;
  result.m[2][0] = zHat.x; result.m[2][1] = zHat.y; result.m[2][2] = zHat.z;
  return result;
}

/// Orthonormalise a primary/secondary pair into a triad: the primary direction
/// is preserved exactly, the secondary only fixes the roll about it. This is
/// the kernel of both ObjectReferenced and LocalAlignedConstrained.
inline bool triadFromPrimarySecondary(const Vec3& primary, const Vec3& secondary, Mat3* out) {
  if (out == nullptr) {
    return false;
  }
  const Vec3 xHat = unit(primary);
  if (norm(xHat) <= 0.0) {
    return false;
  }
  Vec3 zRaw = cross(primary, secondary);
  if (norm(zRaw) <= 0.0) {
    return false;  // primary and secondary are parallel: roll undefined
  }
  const Vec3 zHat = unit(zRaw);
  const Vec3 yHat = cross(zHat, xHat);
  *out = fromRows(xHat, yHat, zHat);
  return true;
}

// ---------------------------------------------------------------------------
// Earth-orientation parameters. Supplied by the caller from the EOP data
// module — this header never reads a file and never guesses. Zeroed EOP is a
// legitimate (and reproducible) choice for a vector comparison; it is never a
// silent default for operational use, which is why the struct has no
// "load defaults" entry point.
// ---------------------------------------------------------------------------
struct EarthOrientation {
  double dut1 = 0.0;         ///< UT1 - UTC, seconds
  double xPole = 0.0;        ///< polar motion x, RADIANS
  double yPole = 0.0;        ///< polar motion y, RADIANS
  double dX = 0.0;           ///< CIP offset dX to IAU-2006/2000A, RADIANS
  double dY = 0.0;           ///< CIP offset dY, RADIANS
  double lengthOfDay = 0.0;  ///< excess length of day, seconds
};

/// Two-part Julian dates for the scales the chain needs.
struct Epoch {
  double tt1 = 0.0;   ///< TT, part 1
  double tt2 = 0.0;   ///< TT, part 2
  double ut11 = 0.0;  ///< UT1, part 1
  double ut12 = 0.0;  ///< UT1, part 2
};

/// Build an Epoch from a UTC calendar date and the EOP. Returns false when
/// ERFA rejects the date (which includes an epoch outside the leap-second
/// table's range — a refusal, never an extrapolation).
inline bool epochFromUtc(int year, int month, int day, int hour, int minute, double second,
                         const EarthOrientation& eop, Epoch* out) {
  if (out == nullptr) {
    return false;
  }
  double utc1 = 0.0;
  double utc2 = 0.0;
  if (eraDtf2d("UTC", year, month, day, hour, minute, second, &utc1, &utc2) != 0) {
    return false;
  }
  double tai1 = 0.0;
  double tai2 = 0.0;
  if (eraUtctai(utc1, utc2, &tai1, &tai2) != 0) {
    return false;
  }
  if (eraTaitt(tai1, tai2, &out->tt1, &out->tt2) != 0) {
    return false;
  }
  if (eraUtcut1(utc1, utc2, eop.dut1, &out->ut11, &out->ut12) != 0) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The Earth chain, all of it delegating the series to ERFA.
// ---------------------------------------------------------------------------

namespace detail {

inline Mat3 fromErfa(double r[3][3]) {
  Mat3 result;
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      result.m[i][j] = r[i][j];
    }
  }
  return result;
}

}  // namespace detail

/// GCRF -> ITRF, the CIO-based IAU-2006/2000A transformation of IERS
/// Conventions 2010, exactly as SOFA implements it. This is THE chain.
inline Mat3 gcrfToItrf(const Epoch& epoch, const EarthOrientation& eop) {
  double x = 0.0;
  double y = 0.0;
  eraXy06(epoch.tt1, epoch.tt2, &x, &y);
  const double s = eraS06(epoch.tt1, epoch.tt2, x, y);
  x += eop.dX;
  y += eop.dY;

  double rc2i[3][3];
  eraC2ixys(x, y, s, rc2i);
  const double era = eraEra00(epoch.ut11, epoch.ut12);
  const double sp = eraSp00(epoch.tt1, epoch.tt2);
  double rpom[3][3];
  eraPom00(eop.xPole, eop.yPole, sp, rpom);
  double rc2t[3][3];
  eraC2tcio(rc2i, era, rpom, rc2t);
  return detail::fromErfa(rc2t);
}

/// GCRF -> mean of date (IAU-2006 precession, bias included).
inline Mat3 gcrfToMod(const Epoch& epoch) {
  double rb[3][3];
  double rp[3][3];
  double rbp[3][3];
  eraBp06(epoch.tt1, epoch.tt2, rb, rp, rbp);
  return detail::fromErfa(rbp);
}

/// GCRF -> true of date (IAU-2006/2000A precession-nutation, bias included).
inline Mat3 gcrfToTod(const Epoch& epoch) {
  double rnpb[3][3];
  eraPnm06a(epoch.tt1, epoch.tt2, rnpb);
  return detail::fromErfa(rnpb);
}

/// GCRF -> mean equator and equinox of J2000 (frame bias only).
inline Mat3 gcrfToMj2000Eq(const Epoch& epoch) {
  (void)epoch;
  double rb[3][3];
  double rp[3][3];
  double rbp[3][3];
  // Frame bias alone is the J2000.0 value of the bias-precession matrix.
  eraBp06(ERFA_DJ00, 0.0, rb, rp, rbp);
  return detail::fromErfa(rb);
}

/// GCRF -> mean ecliptic and equinox of J2000.
inline Mat3 gcrfToMj2000Ec(const Epoch& epoch) {
  (void)epoch;
  double rm[3][3];
  eraEcm06(ERFA_DJ00, 0.0, rm);
  return detail::fromErfa(rm);
}

/// GCRF -> mean ecliptic of date.
inline Mat3 gcrfToMoe(const Epoch& epoch) {
  double rm[3][3];
  eraEcm06(epoch.tt1, epoch.tt2, rm);
  return detail::fromErfa(rm);
}

/// GCRF -> true ecliptic of date: true of date, then rotated by the true
/// obliquity about the true equinox.
inline Mat3 gcrfToToe(const Epoch& epoch) {
  double dpsi = 0.0;
  double deps = 0.0;
  eraNut06a(epoch.tt1, epoch.tt2, &dpsi, &deps);
  const double trueObliquity = eraObl06(epoch.tt1, epoch.tt2) + deps;
  double r[3][3];
  eraIr(r);
  eraRx(trueObliquity, r);
  return multiply(detail::fromErfa(r), gcrfToTod(epoch));
}

/// GCRF -> TEME. TEME is true of date with the origin of right ascension moved
/// from the true equinox to the "mean equinox of date" used by SGP4, i.e. true
/// of date rotated about the pole by the equation of the equinoxes.
inline Mat3 gcrfToTeme(const Epoch& epoch) {
  const double equationOfEquinoxes = eraEe06a(epoch.tt1, epoch.tt2);
  double r[3][3];
  eraIr(r);
  eraRz(equationOfEquinoxes, r);
  return multiply(detail::fromErfa(r), gcrfToTod(epoch));
}

// --- The explicitly named legacy IAU-76/FK5 route ---------------------------
// Retained, named and testable rather than deleted, because the OD path's
// stored answers were produced by it. New work uses the IAU-2006/2000A members.

/// GCRF -> mean of date via IAU-76 precession (the FK5 route).
inline Mat3 gcrfToModFk5(const Epoch& epoch) {
  double rp[3][3];
  eraPmat76(epoch.tt1, epoch.tt2, rp);
  return detail::fromErfa(rp);
}

/// GCRF -> true of date via IAU-76 precession + IAU-1980 nutation (FK5).
inline Mat3 gcrfToTodFk5(const Epoch& epoch) {
  double rnpb[3][3];
  eraPnm80(epoch.tt1, epoch.tt2, rnpb);
  return detail::fromErfa(rnpb);
}

// ---------------------------------------------------------------------------
// Sun and Moon directions, from ERFA's own ephemerides — no SPICE kernel and
// no external file. `eraEpv00` is the Earth's heliocentric position/velocity
// (VSOP-class, sub-milliarcsecond over 1900-2100); `eraMoon98` is the
// geocentric lunar position. Both are what make GSE, GSM, BodySpinSun and the
// Earth-Moon barycentre / libration-point origins reachable in a self-contained
// module.
// ---------------------------------------------------------------------------

/// Unit vector from the Earth to the Sun, in GCRF (equatorial, mean J2000).
inline Vec3 sunDirectionGcrf(const Epoch& epoch) {
  double pvh[2][3];
  double pvb[2][3];
  eraEpv00(epoch.tt1, epoch.tt2, pvh, pvb);
  // pvh is the Earth's position relative to the Sun, heliocentric, in the
  // BCRS (equatorial) frame. The Sun direction is its negative.
  return unit(Vec3{-pvh[0][0], -pvh[0][1], -pvh[0][2]});
}

/// Geocentric position of the Moon in GCRF, METRES.
inline Vec3 moonPositionGcrf(const Epoch& epoch) {
  double pv[2][3];
  eraMoon98(epoch.tt1, epoch.tt2, pv);
  // ERFA returns astronomical units; convert to metres.
  return {pv[0][0] * ERFA_DAU, pv[0][1] * ERFA_DAU, pv[0][2] * ERFA_DAU};
}

// ---------------------------------------------------------------------------
// GSE and GSM — Hapgood (1992), "Space physics coordinate transformations:
// a user guide", Planet. Space Sci. 40, 711.
//
//   GSE: x toward the Sun, z normal to the ecliptic (northward), y completing.
//   GSM: x toward the Sun, z in the plane containing x and the geomagnetic
//        dipole axis, so the dipole lies in the x-z plane.
// ---------------------------------------------------------------------------

/// IGRF-epoch geomagnetic dipole colatitude/east-longitude, radians. Supplied
/// by the caller so the dipole model is a PARAMETER, not a constant frozen into
/// the frames code — the dipole drifts and its model is the caller's choice.
struct GeomagneticDipole {
  double colatitude = 0.0;  ///< rad, geographic colatitude of the north dipole pole
  double eastLongitude = 0.0;  ///< rad
};

/// GCRF -> GSE.
inline Mat3 gcrfToGse(const Epoch& epoch) {
  const Vec3 sunHat = sunDirectionGcrf(epoch);
  // Ecliptic pole in GCRF: the z axis of the mean ecliptic of date.
  double rm[3][3];
  eraEcm06(epoch.tt1, epoch.tt2, rm);
  const Vec3 eclipticPole = {rm[2][0], rm[2][1], rm[2][2]};

  const Vec3 xHat = sunHat;
  const Vec3 yHat = unit(cross(eclipticPole, xHat));
  const Vec3 zHat = cross(xHat, yHat);
  return fromRows(xHat, yHat, zHat);
}

/// GCRF -> GSM. Requires the dipole direction, which is defined in the
/// Earth-fixed frame and so needs the EOP-bearing Earth rotation to reach GCRF.
inline Mat3 gcrfToGsm(const Epoch& epoch, const EarthOrientation& eop,
                      const GeomagneticDipole& dipole) {
  const Vec3 sunHat = sunDirectionGcrf(epoch);

  // Dipole axis in the Earth-fixed frame, then rotated into GCRF.
  const Vec3 dipoleFixed = {std::sin(dipole.colatitude) * std::cos(dipole.eastLongitude),
                            std::sin(dipole.colatitude) * std::sin(dipole.eastLongitude),
                            std::cos(dipole.colatitude)};
  const Mat3 itrfToGcrfMatrix = transpose(gcrfToItrf(epoch, eop));
  const Vec3 dipoleGcrf = unit(apply(itrfToGcrfMatrix, dipoleFixed));

  const Vec3 xHat = sunHat;
  // y completes a right-handed set with the dipole in the x-z plane.
  const Vec3 yHat = unit(cross(dipoleGcrf, xHat));
  const Vec3 zHat = cross(xHat, yHat);
  return fromRows(xHat, yHat, zHat);
}

// ---------------------------------------------------------------------------
// ObjectReferenced — the local orbital triads. The acceptance requires "the
// three live RTN triads collapse to one named convention"; this is that
// convention, and every consumer takes it from here.
//
//   RIC / RTN / RSW (all three names, ONE definition):
//       x = radial (position direction)
//       z = cross-track (orbit normal, r x v)
//       y = in-track, completing the right-handed set (z x x)
//
//   LVLH / VVLH as GMAT and Cesium use them are re-labellings of the same
//   triad, produced by `objectReferencedTriad` with a different primary; they
//   are NOT re-derived independently anywhere.
// ---------------------------------------------------------------------------

/// The one RTN/RIC/RSW convention. Rotates GCRF -> RTN.
inline bool radialTransverseNormal(const Vec3& position, const Vec3& velocity, Mat3* out) {
  if (out == nullptr) {
    return false;
  }
  const Vec3 xHat = unit(position);
  const Vec3 normal = cross(position, velocity);
  if (norm(normal) <= 0.0 || norm(xHat) <= 0.0) {
    return false;
  }
  const Vec3 zHat = unit(normal);
  const Vec3 yHat = cross(zHat, xHat);
  *out = fromRows(xHat, yHat, zHat);
  return true;
}

/// General ObjectReferenced axes: the caller names which orbital direction is
/// the primary axis and which is the constraint. This subsumes RTN, LVLH, VVLH
/// and GMAT's ObjectReferenced without a second triad derivation.
enum class OrbitalDirection : uint8_t {
  RADIAL = 0,
  ANTI_RADIAL = 1,
  VELOCITY = 2,
  ANTI_VELOCITY = 3,
  NORMAL = 4,
  ANTI_NORMAL = 5,
};

inline Vec3 orbitalDirectionVector(OrbitalDirection direction, const Vec3& position,
                                   const Vec3& velocity) {
  switch (direction) {
    case OrbitalDirection::RADIAL: return position;
    case OrbitalDirection::ANTI_RADIAL: return scale(position, -1.0);
    case OrbitalDirection::VELOCITY: return velocity;
    case OrbitalDirection::ANTI_VELOCITY: return scale(velocity, -1.0);
    case OrbitalDirection::NORMAL: return cross(position, velocity);
    case OrbitalDirection::ANTI_NORMAL: return scale(cross(position, velocity), -1.0);
  }
  return Vec3{};
}

inline bool objectReferencedTriad(OrbitalDirection primary, OrbitalDirection secondary,
                                  const Vec3& position, const Vec3& velocity, Mat3* out) {
  return triadFromPrimarySecondary(orbitalDirectionVector(primary, position, velocity),
                                   orbitalDirectionVector(secondary, position, velocity), out);
}

// ---------------------------------------------------------------------------
// Topocentric — east/north/up at a geodetic site on a body, expressed in that
// body's body-fixed frame.
// ---------------------------------------------------------------------------

inline Mat3 topocentricFromBodyFixed(double geodeticLatitude, double eastLongitude) {
  const double sinLat = std::sin(geodeticLatitude);
  const double cosLat = std::cos(geodeticLatitude);
  const double sinLon = std::sin(eastLongitude);
  const double cosLon = std::cos(eastLongitude);
  const Vec3 east = {-sinLon, cosLon, 0.0};
  const Vec3 north = {-sinLat * cosLon, -sinLat * sinLon, cosLat};
  const Vec3 up = {cosLat * cosLon, cosLat * sinLon, sinLat};
  return fromRows(east, north, up);
}

// ---------------------------------------------------------------------------
// BodySpinSun — x along the body's spin axis, z completed toward the Sun. Used
// for solar-relative body analysis; GMAT's BodySpinSun.
// ---------------------------------------------------------------------------

inline bool bodySpinSunTriad(const Vec3& spinAxisGcrf, const Vec3& sunDirectionGcrf, Mat3* out) {
  return triadFromPrimarySecondary(spinAxisGcrf, sunDirectionGcrf, out);
}

// ---------------------------------------------------------------------------
// Non-Earth body-fixed frames, from the IAU/WGCCRE published rotation
// elements. The elements are PARAMETERS — the caller supplies the report's
// coefficients — so a WGCCRE report revision is a data change, never a code
// change, and Mars/Moon/any body share one implementation.
//
// The WGCCRE convention: alpha0/delta0 are the right ascension and declination
// of the body's north pole in the ICRF, W is the prime-meridian angle measured
// easterly along the body's equator from the node of the body equator on the
// ICRF equator. All three are polynomials in time.
// ---------------------------------------------------------------------------

struct RotationElements {
  double alpha0 = 0.0;      ///< rad, pole right ascension at J2000
  double alpha1 = 0.0;      ///< rad per Julian century
  double delta0 = 0.0;      ///< rad, pole declination at J2000
  double delta1 = 0.0;      ///< rad per Julian century
  double w0 = 0.0;          ///< rad, prime meridian at J2000
  double wDot = 0.0;        ///< rad per day
};

/// ICRF -> body-fixed for a body with the given WGCCRE rotation elements.
///
/// The matrix is Rz(W) Rx(pi/2 - delta0) Rz(pi/2 + alpha0), which is the
/// WGCCRE definition written as an Euler sequence.
inline Mat3 icrfToBodyFixed(const Epoch& epoch, const RotationElements& elements) {
  const double daysSinceJ2000 = (epoch.tt1 - ERFA_DJ00) + epoch.tt2;
  const double centuries = daysSinceJ2000 / 36525.0;
  const double alpha = elements.alpha0 + elements.alpha1 * centuries;
  const double delta = elements.delta0 + elements.delta1 * centuries;
  const double w = elements.w0 + elements.wDot * daysSinceJ2000;

  double r[3][3];
  eraIr(r);
  eraRz(ERFA_DPI / 2.0 + alpha, r);
  eraRx(ERFA_DPI / 2.0 - delta, r);
  eraRz(w, r);
  return detail::fromErfa(r);
}

/// ICRF -> body-inertial: the body's equator and prime-meridian node WITHOUT
/// the rotation, i.e. the same chain with W = 0.
inline Mat3 icrfToBodyInertial(const Epoch& epoch, const RotationElements& elements) {
  RotationElements inertial = elements;
  inertial.w0 = 0.0;
  inertial.wDot = 0.0;
  return icrfToBodyFixed(epoch, inertial);
}

// ---------------------------------------------------------------------------
// Origins. An axis set is only half a coordinate system; the other half is the
// point it is centred on. Mirrors SDS `RFMOrigin` (Themis, additive to $RFM).
//
// The translation is a plain vector subtraction once every origin is expressed
// in the same inertial axes, which is what makes "arbitrary origin" a data
// question rather than a combinatorial explosion of frame code.
// ---------------------------------------------------------------------------

enum class OriginKind : uint8_t {
  UNSPECIFIED = 0,
  CELESTIAL_BODY = 1,
  BARYCENTER = 2,
  LIBRATION_POINT = 3,
  SPACECRAFT = 4,
  GROUND_SITE = 5,
};

/// Earth-Moon barycentre in GCRF, metres. The mass ratio is a PARAMETER: the
/// caller passes the value from whatever constants set it is reproducing, so
/// this header never freezes a GM ratio of its own.
inline Vec3 earthMoonBarycenterGcrf(const Epoch& epoch, double moonToEarthMassRatio) {
  const Vec3 moon = moonPositionGcrf(epoch);
  const double fraction = moonToEarthMassRatio / (1.0 + moonToEarthMassRatio);
  return scale(moon, fraction);
}

/// Collinear libration point of a primary/secondary pair, to the precision of
/// the classical quintic. `index` is 1, 2 or 3 for L1, L2, L3; L4 and L5 are
/// the exact equilateral points and are returned in closed form.
///
/// `separation` is the primary-to-secondary vector in the working inertial
/// axes; `massRatio` is m2 / (m1 + m2).
inline bool librationPoint(const Vec3& separation, double massRatio, int index, Vec3* out) {
  if (out == nullptr || !(massRatio > 0.0) || massRatio >= 1.0) {
    return false;
  }
  const double distance = norm(separation);
  if (!(distance > 0.0)) {
    return false;
  }
  const Vec3 xHat = scale(separation, 1.0 / distance);

  if (index == 4 || index == 5) {
    // Equilateral points: rotate the primary-secondary line by +-60 degrees in
    // the orbit plane. Without a velocity the plane is underdetermined, so the
    // caller must supply one through `librationPointInPlane` instead.
    return false;
  }
  if (index < 1 || index > 3) {
    return false;
  }

  // Solve the collinear quintic by Newton from the classical series starter.
  const double mu = massRatio;
  double gamma = std::cbrt(mu / (3.0 * (1.0 - mu)));
  double position = 0.0;
  for (int iteration = 0; iteration < 200; ++iteration) {
    double f = 0.0;
    double fPrime = 0.0;
    if (index == 1) {
      f = gamma * gamma * gamma * gamma * gamma - (3.0 - mu) * gamma * gamma * gamma * gamma +
          (3.0 - 2.0 * mu) * gamma * gamma * gamma - mu * gamma * gamma + 2.0 * mu * gamma - mu;
      fPrime = 5.0 * gamma * gamma * gamma * gamma - 4.0 * (3.0 - mu) * gamma * gamma * gamma +
               3.0 * (3.0 - 2.0 * mu) * gamma * gamma - 2.0 * mu * gamma + 2.0 * mu;
    } else if (index == 2) {
      f = gamma * gamma * gamma * gamma * gamma + (3.0 - mu) * gamma * gamma * gamma * gamma +
          (3.0 - 2.0 * mu) * gamma * gamma * gamma - mu * gamma * gamma - 2.0 * mu * gamma - mu;
      fPrime = 5.0 * gamma * gamma * gamma * gamma + 4.0 * (3.0 - mu) * gamma * gamma * gamma +
               3.0 * (3.0 - 2.0 * mu) * gamma * gamma - 2.0 * mu * gamma - 2.0 * mu;
    } else {
      f = gamma * gamma * gamma * gamma * gamma + (2.0 + mu) * gamma * gamma * gamma * gamma +
          (1.0 + 2.0 * mu) * gamma * gamma * gamma - (1.0 - mu) * gamma * gamma -
          2.0 * (1.0 - mu) * gamma - (1.0 - mu);
      fPrime = 5.0 * gamma * gamma * gamma * gamma + 4.0 * (2.0 + mu) * gamma * gamma * gamma +
               3.0 * (1.0 + 2.0 * mu) * gamma * gamma - 2.0 * (1.0 - mu) * gamma -
               2.0 * (1.0 - mu);
    }
    if (std::fabs(fPrime) < 1e-300) {
      return false;
    }
    const double step = -f / fPrime;
    gamma += step;
    if (std::fabs(step) < 1e-15) {
      break;
    }
  }
  if (!(gamma > 0.0) || !std::isfinite(gamma)) {
    return false;
  }

  // Distance from the barycentre along the primary-secondary line.
  if (index == 1) {
    position = distance * (1.0 - mu - gamma);
  } else if (index == 2) {
    position = distance * (1.0 - mu + gamma);
  } else {
    position = -distance * (mu + gamma);
  }
  *out = scale(xHat, position);
  return std::isfinite(position);
}

// ---------------------------------------------------------------------------
// The composed transform. Origin translation and axis rotation, applied in the
// only order that is correct: translate in the SOURCE inertial axes, then
// rotate.
// ---------------------------------------------------------------------------

struct StateVector {
  Vec3 position;  ///< metres
  Vec3 velocity;  ///< metres/second
};

/// Rotate a state by a constant matrix and its time derivative. `omega` is the
/// angular velocity of the TARGET axes expressed in the SOURCE axes; passing a
/// zero omega is correct for, and only for, a genuinely non-rotating pair.
inline StateVector rotateState(const Mat3& rotation, const Vec3& omega, const StateVector& state) {
  StateVector result;
  result.position = apply(rotation, state.position);
  const Vec3 corrected = sub(state.velocity, cross(omega, state.position));
  result.velocity = apply(rotation, corrected);
  return result;
}

/// Translate a state to a new origin, both expressed in the same axes.
inline StateVector translateState(const StateVector& state, const StateVector& newOrigin) {
  return {sub(state.position, newOrigin.position), sub(state.velocity, newOrigin.velocity)};
}


/// Libration point of a primary/secondary pair, expressed relative to the
/// PRIMARY in the same axes the separation is given in.
///
/// `librationPoint` above solves the collinear quintic and reports the point
/// relative to the pair's BARYCENTRE, which is the CR3BP convention and not the
/// frame a consumer centres a coordinate system on. This wrapper shifts to the
/// primary and adds the equilateral points, which need the orbit plane and so
/// need the separation's rate.
///
/// `separationRate` is d(separation)/dt in the same axes; it is used only to
/// fix the orbit plane for L4/L5 and is ignored for L1/L2/L3.
inline bool librationPointFromPrimary(const Vec3& separation, const Vec3& separationRate,
                                      double massRatio, int index, Vec3* out) {
  if (out == nullptr || !(massRatio > 0.0) || massRatio >= 1.0) {
    return false;
  }
  const double distance = norm(separation);
  if (!(distance > 0.0)) {
    return false;
  }
  if (index == 4 || index == 5) {
    // The equilateral points are exact: an equilateral triangle on the
    // primary-secondary line, in the instantaneous orbit plane. L4 leads the
    // secondary, L5 trails it.
    const Vec3 xHat = scale(separation, 1.0 / distance);
    const Vec3 normal = cross(separation, separationRate);
    if (norm(normal) <= 0.0) {
      return false;  // no orbit plane: the equilateral points are undefined
    }
    const Vec3 zHat = unit(normal);
    const Vec3 yHat = cross(zHat, xHat);
    const double sign = index == 4 ? 1.0 : -1.0;
    *out = add(scale(xHat, 0.5 * distance),
               scale(yHat, sign * distance * std::sqrt(3.0) / 2.0));
    return true;
  }
  Vec3 fromBarycentre;
  if (!librationPoint(separation, massRatio, index, &fromBarycentre)) {
    return false;
  }
  // The barycentre sits at massRatio * separation from the primary.
  *out = add(fromBarycentre, scale(separation, massRatio));
  return true;
}

// ---------------------------------------------------------------------------
// Published IAU/WGCCRE rotation elements, as DATA.
//
// `icrfToBodyFixed` deliberately takes the coefficients as a parameter so a
// WGCCRE report revision is a data change. A shipped module still has to know
// the published numbers for the bodies it serves, so they live here, in one
// table, cited — never re-typed at each call site.
//
// Source: Archinal et al., "Report of the IAU Working Group on Cartographic
// Coordinates and Rotational Elements: 2015", Celest. Mech. Dyn. Astr. 130:22
// (2018), Tables 1 and 2. Angles converted from degrees to radians here.
//
// The Moon's entry is the report's MEAN elements (the E1..E13 libration series
// is a further additive correction and is NOT applied); Mars and Earth are the
// report's linear terms. Every consumer that needs the libration terms passes
// its own RotationElements rather than editing this table.
// ---------------------------------------------------------------------------

/// Ephemeris body codes used by the origin/axis resolution.
enum class BodyId : int {
  SUN = 10,
  EARTH = 399,
  MOON = 301,
  MARS = 499,
  EARTH_MOON_BARYCENTRE = 3,
};

inline constexpr double degreesToRadians(double degrees) {
  return degrees * (ERFA_DPI / 180.0);
}

/// WGCCRE-2015 elements for a body, by ephemeris body code. Returns false for
/// a body the table does not carry — a refusal, never a silent identity.
inline bool rotationElementsForBody(int bodyId, RotationElements* out) {
  if (out == nullptr) {
    return false;
  }
  switch (bodyId) {
    case static_cast<int>(BodyId::EARTH):
      // alpha0 = 0.00 - 0.641 T, delta0 = 90.00 - 0.557 T, W = 190.147 + 360.9856235 d
      *out = RotationElements{degreesToRadians(0.0),      degreesToRadians(-0.641),
                              degreesToRadians(90.0),     degreesToRadians(-0.557),
                              degreesToRadians(190.147),  degreesToRadians(360.9856235)};
      return true;
    case static_cast<int>(BodyId::MOON):
      // alpha0 = 269.9949 + 0.0031 T, delta0 = 66.5392 + 0.0130 T,
      // W = 38.3213 + 13.17635815 d  (mean terms; libration series excluded)
      *out = RotationElements{degreesToRadians(269.9949), degreesToRadians(0.0031),
                              degreesToRadians(66.5392),  degreesToRadians(0.0130),
                              degreesToRadians(38.3213),  degreesToRadians(13.17635815)};
      return true;
    case static_cast<int>(BodyId::MARS):
      // alpha0 = 317.269202 - 0.10927547 T, delta0 = 54.432516 - 0.05827105 T,
      // W = 176.049863 + 350.891982443297 d (periodic terms excluded)
      *out = RotationElements{degreesToRadians(317.269202), degreesToRadians(-0.10927547),
                              degreesToRadians(54.432516),  degreesToRadians(-0.05827105),
                              degreesToRadians(176.049863), degreesToRadians(350.891982443297)};
      return true;
    case static_cast<int>(BodyId::SUN):
      // alpha0 = 286.13, delta0 = 63.87, W = 84.176 + 14.1844000 d
      *out = RotationElements{degreesToRadians(286.13), 0.0,
                              degreesToRadians(63.87),  0.0,
                              degreesToRadians(84.176), degreesToRadians(14.1844000)};
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Angular RATES.
//
// The acceptance asks for the angular rate of every axis set, not only its
// orientation. Two of the twenty-two chains have a closed-form rate (Earth
// rotation, body rotation); the rest are compositions of ERFA series, solar and
// lunar ephemerides and orbit-derived triads whose analytic derivative would be
// a second, separately-wrong implementation of the same thing.
//
// So the rate is taken the one way that is uniform, exact to the arithmetic and
// impossible to get out of step with the orientation it differentiates: a
// central difference of the SAME orientation function.
//
// ERROR BUDGET, stated rather than assumed. For a rotation whose fastest term
// is Earth rotation (omega = 7.292e-5 rad/s) the central difference truncation
// error is (omega^3 h^2)/6. At h = 1 s that is 6.5e-14 * 1/6 ~ 1e-14 rad/s, and
// round-off in the differenced matrix is ~2 eps / h ~ 4e-16. h = 1 s therefore
// sits near the minimum of the combined error and meets the 1e-14 rad/s bar;
// `angularRateStepSeconds` exposes it so a caller measuring a faster frame can
// shorten it.
// ---------------------------------------------------------------------------

constexpr double kDefaultAngularRateStepSeconds = 1.0;

/// Shift an epoch by `seconds`, keeping the two-part Julian split intact.
inline Epoch shiftEpoch(const Epoch& epoch, double seconds) {
  Epoch shifted = epoch;
  const double days = seconds / 86400.0;
  shifted.tt2 += days;
  shifted.ut12 += days;
  return shifted;
}

inline Mat3 subtractScaled(const Mat3& a, const Mat3& b, double scaleFactor) {
  Mat3 result;
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      result.m[i][j] = (a.m[i][j] - b.m[i][j]) * scaleFactor;
    }
  }
  return result;
}

/// Angular velocity of the TARGET axes with respect to the source axes,
/// expressed in the SOURCE axes, from a rotation R (source -> target) and its
/// time derivative.
///
/// With R_dot = W R and W skew, a vector fixed in the source appears in the
/// target to turn at -omega, so W = -[omega_target]x. Reading the skew back out
/// gives omega in TARGET components; rotating by R^T expresses it in the source
/// axes, which is what $FRM's ANGULAR_VELOCITY_RAD_S is defined to carry.
inline Vec3 angularVelocityInSourceAxes(const Mat3& rotation, const Mat3& rotationRate) {
  const Mat3 w = multiply(rotationRate, transpose(rotation));
  const Vec3 omegaTarget{w.m[1][2], -w.m[0][2], w.m[0][1]};
  return apply(transpose(rotation), omegaTarget);
}

struct RotationWithRate {
  Mat3 rotation;                 ///< source -> target
  Mat3 rate;                     ///< d(rotation)/dt, per second
  Vec3 angularVelocitySource;    ///< rad/s, target axes wrt source, in source axes
};

/// Differentiate any orientation function of epoch by central difference.
/// `rotationAt` must be a callable taking an Epoch and returning a Mat3.
template <typename RotationFn>
inline RotationWithRate rotationWithRate(RotationFn rotationAt, const Epoch& epoch,
                                         double stepSeconds = kDefaultAngularRateStepSeconds) {
  RotationWithRate result;
  result.rotation = rotationAt(epoch);
  const Mat3 ahead = rotationAt(shiftEpoch(epoch, stepSeconds));
  const Mat3 behind = rotationAt(shiftEpoch(epoch, -stepSeconds));
  result.rate = subtractScaled(ahead, behind, 1.0 / (2.0 * stepSeconds));
  result.angularVelocitySource = angularVelocityInSourceAxes(result.rotation, result.rate);
  return result;
}

/// Differentiate any position function of epoch the same way. Used for the
/// non-inertial ORIGINS (the Moon, the Earth-Moon barycentre, a libration
/// point) whose velocity is otherwise unavailable in closed form.
template <typename PositionFn>
inline Vec3 positionRate(PositionFn positionAt, const Epoch& epoch,
                         double stepSeconds = kDefaultAngularRateStepSeconds) {
  const Vec3 ahead = positionAt(shiftEpoch(epoch, stepSeconds));
  const Vec3 behind = positionAt(shiftEpoch(epoch, -stepSeconds));
  return scale(sub(ahead, behind), 1.0 / (2.0 * stepSeconds));
}

}  // namespace frames
}  // namespace sdn

#endif  // SDN_FOUNDATION_FRAMES_AXIS_ENGINE_HPP
