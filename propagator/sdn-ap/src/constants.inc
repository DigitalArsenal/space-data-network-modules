// -----------------------------------------------------------------------------
// Constants, gravity models and theory identifiers.
// -----------------------------------------------------------------------------

namespace sdnap {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 2.0 * kPi;
constexpr double kDeg = kPi / 180.0;
constexpr double kX2o3 = 2.0 / 3.0;
constexpr double kMinutesPerDay = 1440.0;
/// Julian date of 1950 January 0.0 (the SGP4 epoch origin).
constexpr double kJd1950 = 2433281.5;

/// Theories this module carries. The values are this module's own; an
/// element set says which theory it was fitted under and is propagated only
/// under that theory.
enum Theory : int32_t {
  kTheorySgp4 = 0,     ///< SGP4/SDP4 (STR#3, Vallado et al. 2006), ephemeris type 0.
  kTheorySgp4Xp = 4,   ///< SGP4-XP (US Space Force), ephemeris type 4: BTERM and AGOM.
  kTheorySdnAp = 16,   ///< SDN-AP: SDN's own theory (labelled as its own, never "SGP4-XP").
};

/// Zonal gravity model of a theory (normalised to Earth radii and minutes).
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

/// WGS-72 (Vallado et al. 2006 "wgs72"), the SGP4 element-set convention.
inline Gravity gravity_wgs72() {
  return make_gravity(398600.8, 6378.135, 0.001082616, -0.00000253881, -0.00000165597, 0.0);
}

}  // namespace sdnap
