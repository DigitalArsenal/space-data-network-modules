// Star places and distances.
//
// propagate(): the rigorous epoch propagation of the Gaia DR3 documentation
// (section 4.1.7; Butkevich & Lindegren 2014, A&A 570, A62): the uniform
// space motion of a star with position, proper motion, parallax and radial
// velocity, from one epoch to another in barycentric ICRS. Without a
// parallax or a radial velocity the radial proper motion is zero, which is
// the linear propagation.
//
// edsd(): the distance posterior with the exponentially decreasing space
// density prior (Bailer-Jones 2015, PASP 127, 994; Astraatmadja &
// Bailer-Jones 2016, ApJ 832, 137), length scale L = 1.35 kpc: its mode and
// the 68% highest-density interval, on a fine grid.
#pragma once
#include <algorithm>
#include <cmath>
#include <utility>
#include <vector>

namespace gaia_octree::astrometry {

constexpr double kPi = 3.14159265358979323846;
constexpr double kDeg = kPi / 180;
constexpr double kMasToRad = kPi / (180.0 * 3600.0 * 1000.0);
// au in km over a Julian year in s: km/s -> au/yr.
constexpr double kAuKmPerYearS = 149597870.7 / (365.25 * 86400.0);

struct Place { double raDeg, decDeg; };

// The position at epoch t1 (Julian years) of a star at (ra, dec) at t0, with
// pmra (times cos dec) and pmdec in mas/yr, parallax in mas, rv in km/s.
inline Place propagate(double raDeg, double decDeg, double pmra, double pmdec, double parallax, double rv, double t0, double t1) {
  const double t = t1 - t0;
  if (!(std::isfinite(pmra) && std::isfinite(pmdec)) || t == 0) return {raDeg, decDeg};
  const double a = raDeg * kDeg, d = decDeg * kDeg;
  const double sa = std::sin(a), ca = std::cos(a), sd = std::sin(d), cd = std::cos(d);
  const double p[3] = {-sa, ca, 0}, q[3] = {-sd * ca, -sd * sa, cd}, r[3] = {cd * ca, cd * sa, sd};
  const double ma = pmra * kMasToRad, md = pmdec * kMasToRad;  // rad/yr
  const double mu0[3] = {p[0] * ma + q[0] * md, p[1] * ma + q[1] * md, p[2] * ma + q[2] * md};
  // Radial proper motion mu_r = v_r * parallax / A (rad/yr), zero without both.
  const double mur = (std::isfinite(parallax) && parallax > 0 && std::isfinite(rv)) ? rv * parallax * kMasToRad / kAuKmPerYearS : 0;
  const double mu02 = ma * ma + md * md;
  const double f = 1 / std::sqrt(1 + 2 * mur * t + (mu02 + mur * mur) * t * t);
  double u[3];
  for (int i = 0; i < 3; ++i) u[i] = (r[i] * (1 + mur * t) + mu0[i] * t) * f;
  double ra = std::atan2(u[1], u[0]) / kDeg;
  if (ra < 0) ra += 360;
  return {ra, std::atan2(u[2], std::hypot(u[0], u[1])) / kDeg};
}

inline void unit(double raDeg, double decDeg, double out[3]) {
  const double a = raDeg * kDeg, d = decDeg * kDeg;
  out[0] = std::cos(d) * std::cos(a); out[1] = std::cos(d) * std::sin(a); out[2] = std::sin(d);
}

// Julian years (TT) of a Julian date (TT): J2000.0 is JD 2451545.0.
inline double julianYear(double jd, double fraction = 0) { return 2000.0 + ((jd - 2451545.0) + fraction) / 365.25; }

struct Distance { double mode = NAN, lo = NAN, hi = NAN; };

// EDSD posterior distance (pc) from a parallax and its uncertainty (mas).
inline Distance edsd(double parallaxMas, double sigmaMas, double lengthPc = 1350.0) {
  if (!(std::isfinite(parallaxMas) && std::isfinite(sigmaMas) && sigmaMas > 0)) return {};
  // ln P(r) = 2 ln r - r / L - (w - 1000 / r)^2 / (2 s^2), r in pc.
  const auto lnp = [&](double r) { const double x = parallaxMas - 1000.0 / r; return 2 * std::log(r) - r / lengthPc - x * x / (2 * sigmaMas * sigmaMas); };
  const double near = parallaxMas + 8 * sigmaMas > 0 ? 1000.0 / (parallaxMas + 8 * sigmaMas) : 1.0;
  const double far = parallaxMas - 8 * sigmaMas > 0 ? 1000.0 / (parallaxMas - 8 * sigmaMas) : 30 * lengthPc;
  const double lo = std::max(1e-3, near * 0.5), hi = std::max(far * 1.5, lo * 2);
  constexpr int kN = 2000;
  std::vector<double> r(kN), lp(kN), w(kN);
  int best = 0;
  for (int i = 0; i < kN; ++i) {
    r[i] = lo * std::pow(hi / lo, (i + 0.5) / kN);
    lp[i] = lnp(r[i]);
    if (lp[i] > lp[best]) best = i;
  }
  const double dl = std::log(hi / lo) / kN;
  double total = 0;
  for (int i = 0; i < kN; ++i) total += (w[i] = std::exp(lp[i] - lp[best]) * r[i] * dl);  // mass of the cell (dr = r dln r)
  // 68% HDI of a unimodal posterior: grow the interval from the mode, always
  // taking the denser neighbor (density, not mass), until 68.27% of the mass.
  int first = best, last = best;
  double mass = w[best];
  while (mass < 0.6827 * total && (first > 0 || last < kN - 1)) {
    const bool left = last == kN - 1 || (first > 0 && lp[first - 1] >= lp[last + 1]);
    mass += left ? w[--first] : w[++last];
  }
  return {r[best], r[first], r[last]};
}

}  // namespace gaia_octree::astrometry
