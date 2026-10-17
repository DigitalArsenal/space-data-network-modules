#pragma once
#include <cmath>
#include <algorithm>

namespace cosmology {
// Astropy Planck18 (Planck VI 2018, Table 2, TT,TE,EE+lowE+lensing+BAO).
// Om0 excludes neutrinos: adding 0.3111 AND massive neutrinos double-counts them.
constexpr double speed_of_light_km_s = 299792.458;
constexpr double hubble_km_s_mpc = 67.66;
constexpr double omega_matter = 0.30966;
constexpr double omega_photons = 5.402015137139353e-5;
constexpr double omega_lambda = 0.6888463055445441;
constexpr double mpc_km = 3.0856775814913673e19;
constexpr double seconds_per_gyr = 31557600.0e9;
constexpr double max_redshift = 1100.0;

inline double inverse_expansion(double z) {
  const double zp1 = 1 + z;
  // Komatsu et al. (2011), eq. 26 fit; same fitting constants as Astropy.
  // Two massless species and one 0.06 eV species; Tnu0=1.9453688391750839 K.
  const double y = 357.9121209673803 / zp1;
  const double neutrinos = 0.22710731766 * (3.046 / 3.0) *
      (2 + std::pow(1 + std::pow(0.3173 * y, 1.83), 0.54644808743));
  return 1 / std::sqrt(zp1 * zp1 * zp1 *
      (omega_matter + omega_photons * (1 + neutrinos) * zp1) + omega_lambda);
}

// Integrate in log(1+z), resolving both the local and radiation-dominated era.
// A bounded adaptive Simpson rule keeps distance and time integration private.
template<class F>
double adaptive(const F& f, double a, double b, double fa, double fm, double fb,
                double whole, double tolerance, unsigned depth) {
  const double m = (a + b) / 2, l = (a + m) / 2, r = (m + b) / 2;
  const double fl = f(l), fr = f(r);
  const double left = (m - a) * (fa + 4 * fl + fm) / 6;
  const double right = (b - m) * (fm + 4 * fr + fb) / 6;
  const double delta = left + right - whole;
  if (depth == 0 || std::abs(delta) <= 15 * tolerance)
    return left + right + delta / 15;
  return adaptive(f, a, m, fa, fl, fm, left, tolerance / 2, depth - 1) +
         adaptive(f, m, b, fm, fr, fb, right, tolerance / 2, depth - 1);
}
inline double integral(double z, bool distance) {
  if (z == 0) return 0;
  const double end = std::log1p(z);
  const auto f = [distance](double x) {
    return inverse_expansion(std::expm1(x)) * (distance ? std::exp(x) : 1);
  };
  const double fa = f(0), fm = f(end / 2), fb = f(end);
  return adaptive(f, 0, end, fa, fm, fb, end * (fa + 4 * fm + fb) / 6,
                  2e-13 * std::min(1.0, end), 24);
}
struct Distances {
  double comoving_mpc, lookback_gyr, light_travel_mpc, luminosity_mpc;
};
inline double comoving(double z) {
  return speed_of_light_km_s / hubble_km_s_mpc * integral(z, true);
}
inline Distances distances(double z) {
  const double dc = comoving(z), time_integral = integral(z, false);
  return {dc, time_integral * mpc_km / hubble_km_s_mpc / seconds_per_gyr,
          time_integral * speed_of_light_km_s / hubble_km_s_mpc, dc * (1 + z)};
}
inline double redshift_from_luminosity(double luminosity_mpc) {
  double lo = 0, hi = max_redshift;
  for (unsigned i = 0; i < 64; ++i) {
    const double mid = (lo + hi) / 2;
    if (comoving(mid) * (1 + mid) < luminosity_mpc) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
} // namespace cosmology
