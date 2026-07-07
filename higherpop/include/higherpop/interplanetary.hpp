// higherpop/interplanetary.hpp — patched-conic interplanetary mission design.
//
// The deep-space primitives STK Astrogator and FreeFlyer provide for
// preliminary interplanetary trajectory design:
//   * Planetary ephemeris (heliocentric position/velocity) via the vendored
//     ERFA plan94 analytic series (Mercury..Neptune).
//   * Heliocentric transfer design: a Lambert solve between two planet
//     positions gives the departure/arrival heliocentric velocities; the
//     hyperbolic excess velocities v_inf follow from the planet velocities.
//   * Departure/arrival energy: C3 (= v_inf^2), injection dv from a parking
//     orbit, and arrival v_inf for capture/flyby.
//   * Gravity assist: the turn angle a flyby imparts for a given v_inf and
//     periapsis radius, and the resulting heliocentric velocity change.
//   * B-plane targeting: map an incoming hyperbolic asymptote to the B-vector
//     (B·R, B·T) used to target a flyby aim point.
//
// Units km, s, km/s. Needs ERFA (planetary ephemeris) like frames.hpp.
// Header-only otherwise; include only when doing interplanetary work.

#ifndef HIGHERPOP_INTERPLANETARY_HPP
#define HIGHERPOP_INTERPLANETARY_HPP

#include <cmath>
#include "higherpop/vec3.hpp"
#include "higherpop/frames.hpp"      // UTCDate, timescales
#include "higherpop/rpo/lambert.hpp" // heliocentric Lambert

extern "C" {
  int eraPlan94(double date1, double date2, int np, double pv[2][3]);
}

namespace hp {
namespace interplanetary {

constexpr double MU_SUN  = 1.32712440018e11; // km^3/s^2
constexpr double AU_KM   = 149597870.7;
constexpr double DAY_S   = 86400.0;

// Planet gravitational parameters (km^3/s^2) for patched-conic legs.
enum Planet { MERCURY=1, VENUS=2, EARTH=3, MARS=4, JUPITER=5, SATURN=6, URANUS=7, NEPTUNE=8 };
inline double muPlanet(Planet p){
  switch(p){
    case MERCURY: return 2.2032e4;   case VENUS:  return 3.24859e5;
    case EARTH:   return 3.986004418e5; case MARS: return 4.282837e4;
    case JUPITER: return 1.26686534e8; case SATURN:return 3.7931187e7;
    case URANUS:  return 5.793939e6;  case NEPTUNE:return 6.836529e6;
  } return 0.0;
}

struct StateHelio { Vec3 r, v; };  // heliocentric, km & km/s

// Heliocentric planet state via ERFA plan94 (TT epoch).
inline StateHelio planetState(Planet p, const frames::UTCDate& d) {
  frames::EOP e;
  frames::JulianTT_UT1 t = frames::timescales(d, e);
  double pv[2][3];
  eraPlan94(t.tt1, t.tt2, (int)p, pv);
  return StateHelio{ Vec3{pv[0][0]*AU_KM, pv[0][1]*AU_KM, pv[0][2]*AU_KM},
                     Vec3{pv[1][0]*AU_KM/DAY_S, pv[1][1]*AU_KM/DAY_S, pv[1][2]*AU_KM/DAY_S} };
}

// ---- Heliocentric transfer between two planets (patched-conic) ------------
struct Transfer {
  Vec3   v_dep_helio, v_arr_helio; // heliocentric transfer velocities
  Vec3   vinf_dep, vinf_arr;       // hyperbolic excess vectors (rel. to planet)
  double C3_dep;                   // departure energy [km^2/s^2] = |vinf_dep|^2
  double vinf_arr_mag;             // arrival speed rel. to target [km/s]
  double tof_s;
  bool   ok;
};

inline Transfer planTransfer(Planet from, const frames::UTCDate& dep,
                             Planet to,   const frames::UTCDate& arr,
                             double tof_s, bool prograde=true) {
  StateHelio P1 = planetState(from, dep);
  StateHelio P2 = planetState(to,   arr);
  auto lam = rpo::lambert(P1.r, P2.r, tof_s, MU_SUN, prograde, false);
  Transfer T;
  T.ok = lam.ok;
  T.v_dep_helio = lam.v1;
  T.v_arr_helio = lam.v2;
  T.vinf_dep = lam.v1 - P1.v;   // relative to departure planet
  T.vinf_arr = lam.v2 - P2.v;   // relative to arrival planet
  T.C3_dep = dot(T.vinf_dep, T.vinf_dep);
  T.vinf_arr_mag = norm(T.vinf_arr);
  T.tof_s = tof_s;
  return T;
}

// Injection dv from a circular parking orbit of radius r_park about the
// departure planet onto the departure hyperbola (v_inf given).
inline double injectionDv(double vinf, double r_park, double mu_planet) {
  double v_hyp_peri = std::sqrt(vinf*vinf + 2.0*mu_planet/r_park); // hyperbola periapsis speed
  double v_circ     = std::sqrt(mu_planet/r_park);
  return v_hyp_peri - v_circ;
}

// ---- Gravity assist --------------------------------------------------------
// Turn angle (rad) of the v_inf vector for a flyby at periapsis radius rp:
//   sin(delta/2) = 1/e,  e = 1 + rp*vinf^2/mu_planet
inline double flybyTurnAngle(double vinf, double rp, double mu_planet) {
  double e = 1.0 + rp*vinf*vinf/mu_planet;
  return 2.0*std::asin(1.0/e);
}
// Maximum heliocentric speed change from a single flyby = 2*vinf*sin(delta/2).
inline double flybyDeltaVmax(double vinf, double rp, double mu_planet) {
  double delta = flybyTurnAngle(vinf, rp, mu_planet);
  return 2.0*vinf*std::sin(delta/2.0);
}

// ---- B-plane targeting -----------------------------------------------------
// Given an incoming hyperbolic excess velocity vector (relative to the target
// planet) and the target-body mu and periapsis radius, return the B-plane
// magnitude |B| (aim-point offset) and the (S,T,R) unit triad. The B-plane is
// perpendicular to the incoming asymptote S = vinf/|vinf|; T lies in a
// reference plane (here the ecliptic X-Y), R = S x T.
struct BPlane { Vec3 S, T, R; double B_mag; };

inline BPlane bPlane(const Vec3& vinf, double rp, double mu_planet) {
  BPlane bp;
  bp.S = unit(vinf);
  Vec3 ref{0,0,1};                          // ecliptic pole
  bp.T = unit(cross(bp.S, ref));
  bp.R = cross(bp.S, bp.T);
  double vinf2 = dot(vinf,vinf);
  double e = 1.0 + rp*vinf2/mu_planet;      // hyperbola eccentricity for periapsis rp
  double a = -mu_planet/vinf2;              // hyperbola semi-major axis (<0)
  // impact parameter b = |a| sqrt(e^2 - 1)
  bp.B_mag = std::fabs(a)*std::sqrt(e*e - 1.0);
  return bp;
}

} // namespace interplanetary
} // namespace hp

#endif // HIGHERPOP_INTERPLANETARY_HPP
