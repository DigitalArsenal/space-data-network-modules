// "planet-states": Planet Labs https://ephemerides.planet-labs.com/planet.states
//
// The file has no header and no declaration of frame, scale or units. What it
// is, from reading the live file (102 rows) in memory on 2026-10-10:
//   - whitespace-separated, 10 columns per row, one row per satellite:
//       id  t  x y z  vx vy vz  c9  c10
//     id is a short alphanumeric token ("2409", "24ae", "s4", "s112").
//   - Units: metres and metres per second. |r| is 6.74e6..6.97e6 m and |v| is
//     about 7.6 km/s for every row.
//   - Axes: inertial. Per row the vis-viva semi-major axis is 6743..6962 km
//     with eccentricity 0.0005..0.003 and inclination 96.8..97.7 degrees (the
//     SkySat/Dove sun-synchronous planes); an Earth-fixed velocity would break
//     both. The epoch convention (below) is J2000-referenced, so the frame is
//     reported as J2000; the file does not say J2000 vs GCRF vs TEME. This is
//     inferred, not declared.
//   - Time: t is seconds past J2000 (2000-01-01T12:00:00) on a uniform scale.
//     Every t ends in exactly .184000; TT - TAI = 32.184 s, so t is TT seconds
//     past J2000 at whole TAI seconds (SPICE ET would carry a millisecond-level
//     periodic term, which is absent). The calendar label of TT instant t is
//     J2000 + t in TT; TAI is that minus 32.184 s. TAI is the scale the fit
//     understands (time_frames parse_epoch has no TT), and the shift is the
//     defined constant, so each epoch is reported as a whole-second TAI label
//     with scale "TAI".
//   - c9 (13.8..145) and c10 (always "inf") are not identified and are ignored.
// Each satellite appears once (a single current state), so each RawSeries has
// one sample. The file is not a time series.
#include "formats_support.hpp"

namespace odhpop::formats::detail {
namespace {

// "844879576.184000" -> whole microseconds at the source's own precision.
bool decimal_to_micro(std::string_view s, long long* micro, std::size_t* decimals) {
  const std::size_t dot = s.find('.');
  long long whole;
  if (!to_int(dot == std::string_view::npos ? s : s.substr(0, dot), &whole) || whole < 0) return false;
  long long frac = 0;
  std::size_t d = 0;
  if (dot != std::string_view::npos) {
    const std::string_view f = s.substr(dot + 1);
    d = f.size();
    if (d > 6) return false;  // finer than the file ever writes; refuse rather than round
    for (char c : f) {
      if (c < '0' || c > '9') return false;
      frac = frac * 10 + (c - '0');
    }
    for (std::size_t k = d; k < 6; ++k) frac *= 10;
  }
  *micro = whole * 1000000 + frac;
  *decimals = d;
  return true;
}

}  // namespace

ParseResult parse_planet_states(const uint8_t* bytes, std::size_t size) {
  constexpr long long kTtMinusTaiMicro = 32184000;
  const long long j2000_days = days_from_civil(2000, 1, 1);
  ParseResult r;
  const std::vector<std::string_view> lines = lines_of(bytes, size);
  for (std::size_t n = 0; n < lines.size(); ++n) {
    const std::vector<std::string_view> t = tokens(lines[n]);
    if (t.empty()) continue;
    const std::string where = " (line " + std::to_string(n + 1) + ")";
    if (t.size() != 10) return failure("parse-failed", "planet.states row needs 10 columns" + where);
    long long micro;
    std::size_t decimals;
    if (!decimal_to_micro(t[1], &micro, &decimals)) return failure("parse-failed", "bad time " + std::string(t[1]) + where);
    double v[6];
    for (int k = 0; k < 6; ++k)
      if (!to_double(t[2 + k], &v[k])) return failure("parse-failed", "bad state component" + where);
    micro -= kTtMinusTaiMicro;  // TT label -> TAI label
    if (micro < 0) return failure("parse-failed", "time before J2000" + where);
    const long long total = 12 * 3600 + micro / 1000000, frac = micro % 1000000;
    const long long tod = total % 86400;
    int y, mo, d;
    civil_from_days(j2000_days + total / 86400, &y, &mo, &d);
    std::string seconds = std::to_string(tod % 60);
    if (decimals > 0) {
      char f[8];
      std::snprintf(f, sizeof f, "%06lld", frac);
      seconds += "." + std::string(f).substr(0, decimals);
    }
    RawSample s;
    s.epoch = iso_datetime(y, mo, d, static_cast<int>(tod / 3600), static_cast<int>(tod / 60 % 60), seconds);
    for (int k = 0; k < 3; ++k) {
      s.r_km[k] = v[k] / 1000.0;
      s.v_km[k] = v[3 + k] / 1000.0;
    }
    RawSeries* series = nullptr;
    for (RawSeries& o : r.objects)
      if (o.object_name == t[0]) series = &o;
    if (!series) {
      r.objects.emplace_back();
      series = &r.objects.back();
      series->object_name = std::string(t[0]);
      series->frame = "J2000";
      series->scale = "TAI";
    }
    series->samples.push_back(s);
  }
  if (r.objects.empty()) return failure("parse-failed", "planet.states holds no rows");
  r.ok = true;
  return r;
}

}  // namespace odhpop::formats::detail
