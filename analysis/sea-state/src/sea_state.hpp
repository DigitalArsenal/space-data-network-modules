#pragma once
#include <algorithm>
#include <cmath>
#include <limits>

// Physics only: no SDK, wire types, host APIs, or renderer dependencies.
namespace sea {
constexpr double pi = 3.141592653589793238462643383279502884;
constexpr double gravity = 9.80665;
constexpr double pm_alpha = 0.0081, pm_beta = 0.74;
struct Input {
  double wind, fetch = 0, duration = 0, wind_from = 0;
  double wave_height = 0, wave_period = 0;
  double wave_from = std::numeric_limits<double>::quiet_NaN();
};
struct State {
  double wind = 0, wind19 = 0, hs = 0, tp = 0, fp = 0, m0 = 0;
  double alpha = 0, gamma = 1, effective_fetch = 0, dimensionless_fetch = 0;
  double hs_uncapped = 0, alpha_uncapped = 0, energy_scale = 1;
  const char* regime = "calm";
  double swell_height, swell_period, swell_from, wind_from, chop;
};
inline double bearing(double degrees) {
  const double v = std::fmod(degrees, 360.0);
  return v < 0 ? v + 360.0 : (v == 0 ? 0 : v);
}
// Dimensionless integral of Hasselmann et al. 1973 Eq. (2.4.1).
// q=f/fp, y=ln(q); split at the sigma change, integrate in log-frequency.
inline double shape_integrand(double y, double gamma) {
  const double q = std::exp(y), sigma = q <= 1 ? .07 : .09;
  const double r = (q - 1) / sigma;
  return std::exp(-4*y - 1.25*std::exp(-4*y) + std::log(gamma)*std::exp(-.5*r*r));
}
inline double shape_integral(double gamma) {
  if (gamma == 1) return .2; // Exact integral over q in (0,infinity).
  double sum = 0;
  for (int part = 0; part < 2; ++part) {
    const double a = part == 0 ? std::log(.2) : 0;
    const double b = part == 0 ? 0 : std::log(64.0);
    constexpr int n = 2048;
    const double h = (b-a)/n;
    double s = shape_integrand(a,gamma) + shape_integrand(b,gamma);
    for (int i=1; i<n; ++i) s += (i%2 ? 4 : 2)*shape_integrand(a+i*h,gamma);
    sum += h*s/3;
  }
  // Beyond q=64, peak enhancement is zero to machine precision; exact PM tail.
  return sum - std::expm1(-1.25/std::pow(64.0,4))/5;
}
inline State evaluate(const Input& in) {
  State s;
  s.wind = std::clamp(in.wind,0.0,70.0);
  // SPM 1984 vol I Eq. (3-26), inverted; valid height z<20 m.
  s.wind19 = s.wind*std::pow(19.5/10.0,1.0/7.0);
  if (s.wind > 0) {
    s.alpha = pm_alpha;
    s.fp = std::pow(4*pm_beta/5,.25)*gravity/(2*pi*s.wind19);
    s.hs = 2*std::sqrt(pm_alpha/pm_beta)*s.wind19*s.wind19/gravity;
    s.regime = "fully-developed";
    const double pm_variance = s.hs*s.hs/16;
    const double x_pm = std::pow(3.5*gravity/(s.wind*s.fp),1/.33);
    const double x_fetch = in.fetch > 0 ? gravity*in.fetch/(s.wind*s.wind) : std::numeric_limits<double>::infinity();
    // Explicit approximation: integrate dt=dF/cg(fp(F)), cg=g/(4*pi*fp).
    // This is a derived peak travel time, NOT an empirical JONSWAP duration law.
    const double x_duration = in.duration > 0 ? std::pow(gravity*in.duration/s.wind*.67/(4*pi*3.5),1/.67) : std::numeric_limits<double>::infinity();
    const double x = std::min({x_pm,x_fetch,x_duration});
    s.dimensionless_fetch = x;
    s.effective_fetch = x*s.wind*s.wind/gravity;
    if (x < x_pm) {
      s.regime = x_duration < x_fetch ? "duration-limited" : "fetch-limited";
      s.alpha = .076*std::pow(x,-.22);
      s.fp = 3.5*gravity/s.wind*std::pow(x,-.33);
      s.gamma = 3.3;
      s.m0 = s.alpha*gravity*gravity/std::pow(2*pi*s.fp,4)*shape_integral(s.gamma);
      s.hs_uncapped = 4*std::sqrt(s.m0);
      s.alpha_uncapped = s.alpha;
      // Explicit energy saturation, not another empirical fit. Keep alpha
      // consistent with the capped spectrum consumed by the FFT host.
      s.energy_scale = std::min(1.0,pm_variance/s.m0);
      s.alpha *= s.energy_scale;
      s.m0 *= s.energy_scale;
      s.hs = 4*std::sqrt(s.m0);
    } else {
      s.m0 = pm_variance;
      s.hs_uncapped = s.hs;
      s.alpha_uncapped = s.alpha;
    }
    s.tp = 1/s.fp;
  }
  // Existing console rendering policy, kept separate from spectral quantities.
  s.wind_from = bearing(in.wind_from);
  s.swell_from = std::isfinite(in.wave_from) ? bearing(in.wave_from) : s.wind_from;
  s.swell_height = std::clamp(in.wave_height > 0 ? in.wave_height : s.hs,.4,30.0);
  s.swell_period = std::clamp(in.wave_period > 0 ? in.wave_period : s.tp,2.0,30.0);
  s.chop = .6 + .6*std::min(1.0,s.wind/17);
  return s;
}
}
