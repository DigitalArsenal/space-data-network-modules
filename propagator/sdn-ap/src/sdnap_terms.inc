// -----------------------------------------------------------------------------
// SDN-AP terms (DESIGN 2, experiments/sdn-gp-starlink-ffm-match at ab0824d):
//   2a  drag: NRLMSISE-00 (gtd7d, the FFM truth's model) x exp(s(t)), the
//       open-DCA common mode s(t) from $DCL (0 until the rows are loaded), the
//       space weather from $SPW (F10.7 of the previous day, its 81-day mean,
//       daily ap; constants until the rows are loaded); the reference path of
//       2a.2: K-point trapezoid in eccentric anomaly for near-circular orbits
//       (z = a e / H < 3), the SPEC 3.4 perigee band otherwise;
//   2b  drag-makeup thrust: dynamics carry B_eff = (1 - kappa) B, signed;
//   2c  empirical transverse accelerations tau0 + tauc cos u + taus sin u,
//       g(t) = 1 on the fit arc, exp(-(t - t_e) / tau_e) after it.
// -----------------------------------------------------------------------------

#include "nrlmsise00.h"

namespace sdnap {
namespace sdn {

constexpr int kTrapezoid = 12;           // 2a.2: K
/// 2c: persistence of the empirical terms after the arc end, minutes (population default 1 day; $PCF
/// FORCES.EMPIRICAL_TERMS.PERSISTENCE_HOURS)
inline double& tau_persistence_minutes() {
  static double m = 1440.0;
  return m;
}
constexpr double kScaleHeightKm = 60.0;  // 2a.2 rule z = a e / H

/// Space weather and the DCA common mode in force (module state; $SPW and
/// $DCL ingestion replaces the defaults).
struct Environment {
  double f107 = 150.0, f107a = 150.0, ap = 15.0, s = 0.0;
  int32_t kernel = 1;  ///< 2a.4 shared kernel on (0: the direct reference path)
};
inline Environment& environment() {
  static Environment env;
  return env;
}

/// Daily space weather from $SPW rows, read as FFM reads them (NRLMSISE-00's
/// driver at a UTC instant on day d: F10.7 the observed flux of day d - 1,
/// F10.7a the 81-day centered mean of day d, Ap the daily Ap of day d).
struct SpwDay {
  double f107_obs, f107_center81, ap_avg;
  int32_t mjd;
  int32_t pad;
};
struct SpaceWeather {
  SpwDay* days = nullptr;  ///< sorted by MJD
  uint32_t count = 0;
};
inline SpaceWeather& space_weather() {
  static SpaceWeather sw;
  return sw;
}

inline const SpwDay* spw_day(int32_t mjd) {
  const SpaceWeather& sw = space_weather();
  uint32_t lo = 0, hi = sw.count;
  while (lo < hi) {
    const uint32_t mid = (lo + hi) / 2;
    if (sw.days[mid].mjd < mjd) lo = mid + 1; else hi = mid;
  }
  return lo < sw.count && sw.days[lo].mjd == mjd ? &sw.days[lo] : nullptr;
}

/// The open-DCA common mode from $DCL (SDS 1.261.0, read as FFM reads it):
/// UTC nodes of s = ln(rho / rho_NRLMSISE-00), linear between nodes, held
/// at the end values outside them.
struct DensityCorrection {
  double* d50 = nullptr;  ///< node times, days from 1950 January 0.0 UTC
  double* s = nullptr;
  uint32_t count = 0;
};
inline DensityCorrection& density_correction() {
  static DensityCorrection dc;
  return dc;
}

inline double dca_scale(double d50, double fallback) {
  const DensityCorrection& dc = density_correction();
  if (dc.count == 0) return fallback;
  if (d50 <= dc.d50[0]) return dc.s[0];
  if (d50 >= dc.d50[dc.count - 1]) return dc.s[dc.count - 1];
  uint32_t lo = 0, hi = dc.count - 1;
  while (hi - lo > 1) {
    const uint32_t mid = (lo + hi) / 2;
    if (dc.d50[mid] <= d50) lo = mid; else hi = mid;
  }
  const double w = (d50 - dc.d50[lo]) / (dc.d50[hi] - dc.d50[lo]);
  return dc.s[lo] * (1.0 - w) + dc.s[hi] * w;
}

/// The environment at d50 (days from 1950 January 0.0 UTC): the $SPW rows
/// where they cover the day and the day before, else the values in force;
/// s from the $DCL nodes when loaded.
inline Environment environment_at(double d50) {
  Environment env = environment();
  const int32_t mjd = static_cast<int32_t>(std::floor(d50 + 33281.0));
  const SpwDay* today = spw_day(mjd);
  const SpwDay* yesterday = spw_day(mjd - 1);
  if (today != nullptr && yesterday != nullptr) {
    env.f107 = yesterday->f107_obs;
    env.f107a = today->f107_center81;
    env.ap = today->ap_avg;
  }
  env.s = dca_scale(d50, env.s);
  return env;
}

/// NRLMSISE-00 total mass density (kg/m^3) at geodetic latitude/longitude
/// (rad), height (km), UT day of year and seconds in the environment env
/// (its s not applied).
inline double msis_raw(double lat, double lon, double h, int doy, double sec, const Environment& env) {
  nrlmsise_flags flags{};
  flags.switches[0] = 0;
  for (int k = 1; k < 24; ++k) flags.switches[k] = 1;
  nrlmsise_input in{};
  in.year = 0;
  in.doy = doy;
  in.sec = sec;
  in.alt = h;
  in.g_lat = lat / kDeg;
  in.g_long = lon / kDeg;
  double lst = sec / 3600.0 + in.g_long / 15.0;
  lst = std::fmod(lst, 24.0);
  if (lst < 0.0) lst += 24.0;
  in.lst = lst;
  in.f107A = env.f107a;
  in.f107 = env.f107;
  in.ap = env.ap;
  nrlmsise_output out{};
  gtd7d(&in, &flags, &out);
  return out.d[5] * 1000.0;  // g/cm^3 -> kg/m^3
}

/// NRLMSISE-00 x exp(s) with the environment at d50.
inline double msis_density(double lat, double lon, double h, int doy, double sec, double d50) {
  const Environment env = environment_at(d50);
  return msis_raw(lat, lon, h, doy, sec, env) * std::exp(env.s);
}

}  // namespace sdn
}  // namespace sdnap
