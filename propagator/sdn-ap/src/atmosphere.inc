// -----------------------------------------------------------------------------
// SGP4XP's selectable drag atmosphere (side B's option, outside the SGP4-XP
// specification; SPEC 15). With no atmosphere (nullptr) the drag is the
// theory's own (SPEC 3: Jacchia 1970 on the generic flux model). A `fit` or
// `propagate` whose $PCF FORCES selects another gives the call an Atmosphere
// (atmosphere_inputs.inc reads it from the call's frames):
//   - Jacchia 1970 (SPEC 3.2, 3.3) on measured drivers from $SPW rows;
//   - NRLMSISE-00 on those drivers: gtd7d of the public-domain Brodowski C port
//     in third_party/nrlmsise00 (consumed as it is, SHA-256 pinned by
//     build.mjs), total mass density with anomalous oxygen, every switch 1 but
//     the output units (the daily-Ap form), as propagator/ffm and
//     analysis/density-calibration drive it;
//   - NRLMSISE-00 times exp(s(t)), s the open-DCA common mode of a $DCL.
// Every set initialized during the call carries the call's atmosphere
// (RateContext); one initialized elsewhere (the ABI, the epoch store) carries
// none. NRLMSISE-00 keeps file-static state, so the atmosphere is evaluated on
// the calling thread only: the invoke methods that select it are single-threaded.
// -----------------------------------------------------------------------------

#include "nrlmsise00.h"

namespace sdnap {
namespace atm {

/// One daily $SPW row as NRLMSISE-00 reads it: the UTC day (MJD), the observed F10.7, its 81-day centered mean and
/// the daily Ap.
struct SpwDay {
  int32_t mjd;
  double f107_obs, f107_center81, ap_avg;
};

enum Model : int32_t { kJacchia70 = 0, kNrlmsise00 = 1 };

struct Atmosphere {
  Model model = kJacchia70;
  bool measured = false;               ///< drivers from `days` (else SPEC 3.1's generic flux model; Jacchia 1970 only)
  std::vector<SpwDay> days;            ///< ascending MJD, one row per day
  std::vector<double> dca_d50, dca_s;  ///< open-DCA nodes (days from 1950 January 0.0 UTC) and s = ln(rho / rho_NRLMSISE-00)
  mutable bool before_rows = false;    ///< an evaluation asked for a day before the first row (the call is refused)
};

/// The atmosphere of the call in progress (nullptr: the theory's own); xp_init gives it to the set.
inline const Atmosphere*& active() {
  static const Atmosphere* a = nullptr;
  return a;
}

/// The row in force on UTC day `mjd`: the last row at or before it, so past the last row that row holds (HOLD_LAST);
/// before the first row the first, and the call is refused (before_rows).
inline const SpwDay& row_at(const Atmosphere& a, int32_t mjd) {
  const std::vector<SpwDay>& d = a.days;
  size_t lo = 0, hi = d.size();
  while (lo < hi) {
    const size_t mid = (lo + hi) / 2;
    if (d[mid].mjd <= mjd) lo = mid + 1;
    else hi = mid;
  }
  if (lo == 0) {
    a.before_rows = true;
    return d[0];
  }
  return d[lo - 1];
}

/// The drivers at d50 (days from 1950 January 0.0 UTC), NRLMSISE-00's daily-Ap convention: F10.7 the observed flux of
/// the previous UTC day, F10.7a the 81-day centered mean of the day, Ap the daily Ap of the day. In SPEC 3.2 they are F,
/// F-bar and Ap.
inline drag::Flux drivers_at(const Atmosphere& a, double d50) {
  const int32_t mjd = static_cast<int32_t>(std::floor(d50 + 33281.0));  // MJD = d50 + (2433281.5 - 2400000.5)
  drag::Flux f{};
  f.f = row_at(a, mjd - 1).f107_obs;
  const SpwDay& day = row_at(a, mjd);
  f.fbar = day.f107_center81;
  f.ap = day.ap_avg;
  return f;
}

/// exp(s(t)) of the open DCA: s linear in UTC between the $DCL's nodes, held at the end values outside them (the
/// producer's forecast nodes carry its decay; no second one applies).
inline double dca_scale(const Atmosphere& a, double d50) {
  const std::vector<double>& t = a.dca_d50;
  const std::vector<double>& s = a.dca_s;
  double v;
  if (d50 <= t.front()) {
    v = s.front();
  } else if (d50 >= t.back()) {
    v = s.back();
  } else {
    size_t lo = 0, hi = t.size() - 1;
    while (hi - lo > 1) {
      const size_t mid = (lo + hi) / 2;
      if (t[mid] <= d50) lo = mid;
      else hi = mid;
    }
    const double w = (d50 - t[lo]) / (t[hi] - t[lo]);
    v = s[lo] * (1.0 - w) + s[hi] * w;
  }
  return std::exp(v);
}

/// NRLMSISE-00 total mass density (kg/m^3) at geodetic latitude and longitude (rad), geodetic height (km) and d50 (UTC),
/// with drivers f: the day of year and UT seconds of d50, local solar time = UT + longitude / 15.
inline double msis_density(double d50, double lat, double lon, double h, const drag::Flux& f) {
  double D, N;
  drag::day_of_year(d50, D, N);
  const double day = std::floor(D);
  const double sec = (D - day) * 86400.0;
  const double lon_deg = lon / kDeg;
  double lst = std::fmod(sec / 3600.0 + lon_deg / 15.0, 24.0);
  if (lst < 0.0) lst += 24.0;
  nrlmsise00::nrlmsise_input in;
  nrlmsise00::nrlmsise_flags flags;
  nrlmsise00::nrlmsise_output out;
  std::memset(&in, 0, sizeof in);
  std::memset(&flags, 0, sizeof flags);
  std::memset(&out, 0, sizeof out);
  flags.switches[0] = 0;
  for (int k = 1; k < 24; ++k) flags.switches[k] = 1;
  in.doy = static_cast<int>(day) + 1;
  in.sec = sec;
  in.alt = h;
  in.g_lat = lat / kDeg;
  in.g_long = lon_deg;
  in.lst = lst;
  in.f107A = f.fbar;
  in.f107 = f.f;
  in.ap = f.ap;
  in.ap_a = nullptr;
  nrlmsise00::gtd7d(&in, &flags, &out);
  return out.d[5] * 1000.0;  // g/cm^3 -> kg/m^3
}

/// Longitude in [-pi, pi).
inline double wrap_pi(double x) {
  double r = std::fmod(x + kPi, kTwoPi);
  if (r < 0.0) r += kTwoPi;
  return r - kPi;
}

}  // namespace atm
}  // namespace sdnap
