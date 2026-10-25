// -----------------------------------------------------------------------------
// foundation/sgp4-str3: SGP4/SDP4 after Spacetrack Report No. 3 (Hoots &
// Roehrich 1980) with the corrections Vallado, Crawford, Hujsak & Kelso (2006),
// AIAA 2006-6753, document in their text; written clean room (src/*.inc name
// their sources). Apache-2.0 (the repository's LICENSE).
//
// One translation unit includes this header. It supplies what the two parts
// read from their includer (pi, 2 pi, 2/3, the 1950 epoch and the zonal
// gravity model with WGS-72), then the parts. propagator/sdn-ap inlines the
// same two parts after its own constants.inc, which carries these definitions
// for that module.
//
// Use: Elements e{} (split Julian epoch, radians, rad/min); Sat s;
// sat_init(e, gravity_wgs72(), s, Sgp4Mode::kAfspc or kImproved); then
// sat_propagate(s, nodes or nullptr, minutes, r, v): TEME km and km/s, kPropOk
// or a kProp* status. Resonant SDP4 objects may carry checkpoints
// (fill_checkpoints, 4 * kCheckpointNodes doubles); without them every call
// integrates from the epoch, to the same bits.
// -----------------------------------------------------------------------------
#ifndef FOUNDATION_SGP4_STR3_H
#define FOUNDATION_SGP4_STR3_H

#include <cmath>
#include <cstdint>

namespace sdnap {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 2.0 * kPi;
constexpr double kX2o3 = 2.0 / 3.0;
/// Julian date of 1950 January 0.0 (the SGP4 epoch origin).
constexpr double kJd1950 = 2433281.5;

/// Zonal gravity model (normalized to Earth radii and minutes).
struct Gravity {
  double mu;             ///< km^3/s^2
  double radius_km;      ///< equatorial radius, km
  double xke;            ///< sqrt(mu) in earth radii^1.5 per minute
  double tumin;          ///< 1 / xke
  double j2, j3, j4, j5;
  double j3oj2;
};

inline Gravity make_gravity(double mu, double radius_km, double j2, double j3, double j4, double j5) {
  Gravity g{};
  g.mu = mu;
  g.radius_km = radius_km;
  g.xke = 60.0 / std::sqrt(radius_km * radius_km * radius_km / mu);
  g.tumin = 1.0 / g.xke;
  g.j2 = j2;
  g.j3 = j3;
  g.j4 = j4;
  g.j5 = j5;
  g.j3oj2 = j3 / j2;
  return g;
}

/// WGS-72 (AIAA 2006-6753 VI.B, Table 2), the SGP4 element-set convention.
inline Gravity gravity_wgs72() {
  return make_gravity(398600.8, 6378.135, 0.001082616, -0.00000253881, -0.00000165597, 0.0);
}

}  // namespace sdnap

#include "../src/sgp4_core.inc"
#include "../src/model.inc"

#endif  // FOUNDATION_SGP4_STR3_H
