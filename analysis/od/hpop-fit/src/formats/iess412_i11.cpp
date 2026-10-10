// "iess412-i11": Intelsat / SES IESS-412 eleven-parameter ephemeris
// (SES public S3 <CODE>_THRU.I11; Intelsat publishes the same parameters).
//
// The file is text: a SUBJECT line naming the satellite, the epoch
// ("YEAR MONTH DAY HOUR MINUTE SECOND" then six numbers), three parameter rows
// (LM0 LM1 LM2 / LONC LONC1 LONS LONS1 / LATC LATC1 LATS LATS1, each label row
// followed by a units row and a value row) and a check line "THE PREDICTED
// SATELLITE LONGITUDE AND LATITUDE AT <n> HOURS AFTER EPOCH ARE <lon> DEG. E
// AND <lat> DEG. N". The file declares no time scale; UTC is used.
//
// Model (IESS-412, eleven-parameter ephemeris; t in days since the epoch,
// angles in degrees, psi the diurnal phase):
//   psi = (360.98564736629 + LM1) * t     the satellite's inertial mean motion:
//         the Earth's rotation rate plus the longitude drift rate; LONC/LONS and
//         LATC/LATS are the cos/sin amplitudes of that once-per-orbit term.
//   lat = (LATC + LATC1 t) cos psi + (LATS + LATS1 t) sin psi
//   lon = LM0 + LM1 t + LM2 t^2 + (LONC + LONC1 t) cos psi + (LONS + LONS1 t) sin psi
//         - (pi/360) (LATC cos psi + LATS sin psi)(LATS cos psi - LATC sin psi)
// The last lon term is the figure-eight (inclination) correction
// -(i^2/4) sin 2u, i the latitude amplitude and u the argument of latitude,
// with the epoch amplitudes LATC/LATS.
// Section and equation numbers of IESS-412 are not cited: the standard's text
// was not available to this work. The model above was fixed against the files
// themselves: for SES M03_THRU.I11 (AMC-3, epoch 2026-06-09 14:30) it
// reproduces the file's own check line at 170 h (232.0261 E, -5.2151 N) to
// 2e-5 deg; parse() applies that same check to every file and refuses a file
// whose parameters do not reproduce it ("iess412-check-mismatch").
//
// The standard gives no radius or velocity. The radius is derived, not
// published: Kepler's third law from the mean motion (psi rate), with the
// radial term of the eccentricity read from LONC/LONS (longitude amplitude =
// 2e rad, r = a(1 - e cos M)). Samples carry positions only (has_velocity =
// false), in the Earth-fixed frame ("ITRF"), every 60 s from the epoch over the
// check line's stated span (168 h = 7 days when the file states none), written
// as the epoch string plus offset_s.
#include <cmath>

#include "formats_support.hpp"

namespace odhpop::formats::detail {
namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kDeg = kPi / 180.0;
constexpr double kEarthRotationDegPerDay = 360.98564736629;  // IERS sidereal rotation per solar day
constexpr double kMuKm3S2 = 398600.4418;
constexpr double kStepSeconds = 60.0;
constexpr double kDefaultSpanHours = 168.0;
constexpr double kCheckToleranceDeg = 0.005;

struct Params {
  double LM0 = 0, LM1 = 0, LM2 = 0, LONC = 0, LONC1 = 0, LONS = 0, LONS1 = 0, LATC = 0, LATC1 = 0, LATS = 0, LATS1 = 0;
  double* slot(std::string_view name) {
    if (name == "LM0") return &LM0;
    if (name == "LM1") return &LM1;
    if (name == "LM2") return &LM2;
    if (name == "LONC") return &LONC;
    if (name == "LONC1") return &LONC1;
    if (name == "LONS") return &LONS;
    if (name == "LONS1") return &LONS1;
    if (name == "LATC") return &LATC;
    if (name == "LATC1") return &LATC1;
    if (name == "LATS") return &LATS;
    if (name == "LATS1") return &LATS1;
    return nullptr;
  }
};

struct Geocentric {
  double lon_deg, lat_deg, radius_km;
};

Geocentric evaluate(const Params& p, double t_days) {
  const double rate = kEarthRotationDegPerDay + p.LM1;  // deg/day
  const double psi = rate * t_days * kDeg;
  const double c = std::cos(psi), s = std::sin(psi);
  const double lat = (p.LATC + p.LATC1 * t_days) * c + (p.LATS + p.LATS1 * t_days) * s;
  const double lon = p.LM0 + p.LM1 * t_days + p.LM2 * t_days * t_days + (p.LONC + p.LONC1 * t_days) * c +
                     (p.LONS + p.LONS1 * t_days) * s -
                     (kPi / 360.0) * (p.LATC * c + p.LATS * s) * (p.LATS * c - p.LATC * s);
  const double n = rate * kDeg / 86400.0;  // rad/s
  const double a = std::cbrt(kMuKm3S2 / (n * n));
  const double radial = (kDeg / 2.0) * ((p.LONS + p.LONS1 * t_days) * c - (p.LONC + p.LONC1 * t_days) * s);
  return {lon, lat, a * (1.0 - radial)};
}

double wrap180(double d) {
  d = std::fmod(d, 360.0);
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

}  // namespace

ParseResult parse_iess412_i11(const uint8_t* bytes, std::size_t size) {
  const std::vector<std::string_view> lines = lines_of(bytes, size);
  Params p;
  int found = 0;
  std::string name, epoch_iso;
  bool have_epoch = false;
  std::vector<std::string_view> flat;  // every token, for the check line

  for (std::size_t n = 0; n < lines.size(); ++n) {
    const std::string line = upper(trim(lines[n]));
    const std::vector<std::string_view> t = tokens(lines[n]);
    for (std::string_view w : t) flat.push_back(w);
    if (line.rfind("SUBJECT:", 0) == 0) {
      const std::size_t f = line.find(" FOR ");
      if (f != std::string::npos) {
        std::string who = std::string(trim(std::string_view(line).substr(f + 5)));
        const std::size_t slash = who.find(" / ");
        name = std::string(trim(std::string_view(who).substr(0, slash)));
      }
      continue;
    }
    if (line.rfind("YEAR", 0) == 0 && line.find("MONTH") != std::string::npos) {
      for (std::size_t m = n + 1; m < lines.size(); ++m) {
        const std::vector<std::string_view> e = tokens(lines[m]);
        if (e.empty()) continue;
        long long v[5];
        double sec;
        if (e.size() != 6 || !to_double(e[5], &sec)) return failure("parse-failed", "epoch row needs six numbers");
        for (int k = 0; k < 5; ++k)
          if (!to_int(e[k], &v[k])) return failure("parse-failed", "bad epoch field " + std::string(e[k]));
        epoch_iso = iso_datetime(static_cast<int>(v[0]), static_cast<int>(v[1]), static_cast<int>(v[2]),
                                 static_cast<int>(v[3]), static_cast<int>(v[4]), e[5]);
        have_epoch = true;
        break;
      }
      continue;
    }
    // A label row: every token is one of the eleven names.
    bool labels = !t.empty();
    std::vector<double*> slots;
    for (std::string_view w : t) {
      double* s = p.slot(upper(w));
      if (!s) { labels = false; break; }
      slots.push_back(s);
    }
    if (!labels) continue;
    for (std::size_t m = n + 1; m < lines.size(); ++m) {
      const std::string u = upper(lines[m]);
      if (trim(u).empty() || u.find("DEG") != std::string::npos) continue;
      const std::vector<std::string_view> vals = tokens(lines[m]);
      if (vals.size() != slots.size()) return failure("parse-failed", "parameter row has the wrong number of values");
      for (std::size_t k = 0; k < vals.size(); ++k)
        if (!to_double(vals[k], slots[k])) return failure("parse-failed", "bad parameter value " + std::string(vals[k]));
      found += static_cast<int>(vals.size());
      break;
    }
  }
  if (found != 11) return failure("parse-failed", "IESS-412 file holds " + std::to_string(found) + " of the 11 parameters");
  if (!have_epoch) return failure("parse-failed", "IESS-412 file has no epoch");

  // The check line: "... AT <n> HOURS AFTER EPOCH ARE <lon> DEG. E AND <lat> DEG. N".
  double hours = kDefaultSpanHours, chk_lon = 0, chk_lat = 0;
  bool have_check = false;
  for (std::size_t i = 1; i + 1 < flat.size(); ++i) {
    if (upper(flat[i]) != "HOURS" || upper(flat[i + 1]) != "AFTER") continue;
    double h;
    if (!to_double(flat[i - 1], &h) || h <= 0) break;
    hours = h;
    std::size_t j = i + 2;
    while (j < flat.size() && upper(flat[j]) != "ARE") ++j;
    double lon, lat;
    if (++j >= flat.size() || !to_double(flat[j], &lon)) break;
    bool west = false;
    for (++j; j < flat.size() && upper(flat[j]) != "AND"; ++j)
      if (upper(flat[j]) == "W" || upper(flat[j]) == "DEG.W") west = true;
    if (++j >= flat.size() || !to_double(flat[j], &lat)) break;
    chk_lon = west ? -lon : lon;
    chk_lat = lat;
    have_check = true;
    break;
  }
  if (have_check) {
    const Geocentric g = evaluate(p, hours / 24.0);
    if (std::fabs(wrap180(g.lon_deg - chk_lon)) > kCheckToleranceDeg || std::fabs(g.lat_deg - chk_lat) > kCheckToleranceDeg)
      return failure("iess412-check-mismatch",
                     "parameters give " + std::to_string(g.lon_deg) + " E, " + std::to_string(g.lat_deg) +
                         " N at the file's check epoch; the file states " + std::to_string(chk_lon) + " E, " +
                         std::to_string(chk_lat) + " N");
  }

  RawSeries series;
  series.frame = "ITRF";
  series.scale = "UTC";
  series.object_name = name;
  const long long steps = static_cast<long long>(std::floor(hours * 3600.0 / kStepSeconds + 1e-9));
  series.samples.reserve(static_cast<std::size_t>(steps) + 1);
  for (long long k = 0; k <= steps; ++k) {
    const double off = static_cast<double>(k) * kStepSeconds;
    const Geocentric g = evaluate(p, off / 86400.0);
    const double lon = g.lon_deg * kDeg, lat = g.lat_deg * kDeg;
    RawSample s;
    s.epoch = epoch_iso;
    s.offset_s = off;
    s.r_km[0] = g.radius_km * std::cos(lat) * std::cos(lon);
    s.r_km[1] = g.radius_km * std::cos(lat) * std::sin(lon);
    s.r_km[2] = g.radius_km * std::sin(lat);
    s.has_velocity = false;
    series.samples.push_back(s);
  }
  ParseResult r;
  r.ok = true;
  r.objects.push_back(std::move(series));
  return r;
}

}  // namespace odhpop::formats::detail
