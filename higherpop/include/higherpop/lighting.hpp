// higherpop/lighting.hpp — eclipse geometry, Sun/Moon ephemeris, illumination.
//
// Provides the shadow/lighting analysis STK and FreeFlyer use for power,
// thermal and optical-visibility work:
//   * Sun and Moon geocentric position (GCRF) via the vendored ERFA ephemeris
//     (epv00 for the Earth-Sun vector, moon98 for the Moon).
//   * Conical umbra/penumbra shadow model (dual-cone), giving the fraction of
//     the solar disc visible from a spacecraft — 1 (full sun), 0 (umbra), or a
//     partial value (penumbra), using the apparent-radii overlap of two discs.
//   * Convenience predicates: inSunlight / inUmbra / inPenumbra, and beta-angle.
//
// Units km, angles rad. Needs ERFA (like frames.hpp); the core stays dep-free,
// so include this only when you need lighting.
//
// Build: link the vendored ERFA objects (see frames_README.md).

#ifndef HIGHERPOP_LIGHTING_HPP
#define HIGHERPOP_LIGHTING_HPP

#include <cmath>
#include <algorithm>
#include "higherpop/vec3.hpp"
#include "higherpop/frames.hpp"   // timescales(), UTCDate, EOP, AS2R, DJ00

extern "C" {
  int  eraEpv00(double date1, double date2, double pvh[2][3], double pvb[2][3]);
  void eraMoon98(double date1, double date2, double pv[2][3]);
}

namespace hp {
namespace lighting {

constexpr double AU_KM     = 149597870.7;
constexpr double R_SUN_KM  = 696000.0;    // solar photosphere radius
constexpr double R_EARTH_KM= 6378.137;    // equatorial (shadow uses spherical Earth)
constexpr double R_MOON_KM = 1737.4;

// Sun position in GCRF (km), geocentric. epv00 gives Earth heliocentric (AU);
// the Sun as seen from Earth is the negative of that, in the same (BCRS≈GCRS
// to the ~mas level that matters for shadow geometry) frame.
inline Vec3 sunGcrf(const frames::UTCDate& d) {
  frames::EOP e; // ephemeris needs only TT; EOP irrelevant here
  frames::JulianTT_UT1 t = frames::timescales(d, e);
  double pvh[2][3], pvb[2][3];
  eraEpv00(t.tt1, t.tt2, pvh, pvb);
  return Vec3{ -pvh[0][0]*AU_KM, -pvh[0][1]*AU_KM, -pvh[0][2]*AU_KM };
}

// Moon geocentric position in GCRF (km).
inline Vec3 moonGcrf(const frames::UTCDate& d) {
  frames::EOP e;
  frames::JulianTT_UT1 t = frames::timescales(d, e);
  double pv[2][3];
  eraMoon98(t.tt1, t.tt2, pv);
  return Vec3{ pv[0][0]*AU_KM, pv[0][1]*AU_KM, pv[0][2]*AU_KM };
}

// ---- Fraction of the solar disc visible from position r_sat (GCRF, km),
//      occulted by a spherical body of radius R_body at r_body (GCRF, km).
//      Returns 1 (unocculted) … 0 (total). Uses the standard two-disc overlap
//      (apparent angular radii of Sun and occulting body, and their apparent
//      separation), i.e. the Montenbruck-Gill "shadow function".
inline double discOcclusion(const Vec3& r_sat, const Vec3& r_sun,
                            const Vec3& r_body, double R_body) {
  Vec3 s_sun  = r_sun  - r_sat;   // sat -> Sun
  Vec3 s_body = r_body - r_sat;   // sat -> occulter
  double ds = norm(s_sun), db = norm(s_body);
  double a = std::asin(std::min(1.0, R_SUN_KM/ds));   // apparent Sun radius
  double b = std::asin(std::min(1.0, R_body /db));    // apparent body radius
  double c = std::acos(std::max(-1.0,std::min(1.0, dot(s_sun,s_body)/(ds*db)))); // separation
  if (c >= a+b) return 1.0;               // no overlap: full sun
  if (c + a <= b) return 0.0;             // Sun fully behind body: total eclipse
  if (c + b <= a) {                       // body fully inside Sun disc (annular)
    return 1.0 - (b*b)/(a*a);
  }
  // partial overlap: area of the two circular segments (lens area)
  double x = (c*c + a*a - b*b)/(2.0*c);
  double y = std::sqrt(std::max(0.0, a*a - x*x));
  double area = a*a*std::acos(std::min(1.0,std::max(-1.0,x/a)))
              + b*b*std::acos(std::min(1.0,std::max(-1.0,(c-x)/b)))
              - c*y;
  double sun_area = M_PI*a*a;
  return std::max(0.0, 1.0 - area/sun_area);
}

// Fraction of sunlight reaching the spacecraft, accounting for Earth (and
// optionally Moon) occultation. 1 = full sun, 0 = total shadow.
inline double sunFraction(const Vec3& r_sat, const frames::UTCDate& d,
                          bool include_moon=false) {
  Vec3 sun  = sunGcrf(d);
  double f  = discOcclusion(r_sat, sun, Vec3{0,0,0}, R_EARTH_KM); // Earth at origin
  if (include_moon) {
    Vec3 moon = moonGcrf(d);
    f = std::min(f, discOcclusion(r_sat, sun, moon, R_MOON_KM));
  }
  return f;
}

inline bool inSunlight (const Vec3& r_sat, const frames::UTCDate& d){ return sunFraction(r_sat,d) > 0.999; }
inline bool inUmbra    (const Vec3& r_sat, const frames::UTCDate& d){ return sunFraction(r_sat,d) < 1e-6;  }
inline bool inPenumbra (const Vec3& r_sat, const frames::UTCDate& d){ double f=sunFraction(r_sat,d); return f>=1e-6 && f<=0.999; }

// Beta angle: angle between the Sun direction and the orbit plane (rad).
// Positive/negative sign follows the orbit angular-momentum direction.
inline double betaAngle(const Vec3& r_sat, const Vec3& v_sat, const frames::UTCDate& d) {
  Vec3 h = cross(r_sat, v_sat);          // orbit normal
  Vec3 sun = unit(sunGcrf(d));
  double sinb = dot(unit(h), sun);
  return std::asin(std::max(-1.0,std::min(1.0,sinb)));
}

} // namespace lighting
} // namespace hp

#endif // HIGHERPOP_LIGHTING_HPP
