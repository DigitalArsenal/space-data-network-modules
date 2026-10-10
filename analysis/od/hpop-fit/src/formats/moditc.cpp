// "moditc": the Modified ITC ephemeris format that Space-Track / the 19th
// Space Defense Squadron accept from operators (SpaceX's MEME files are the
// same layout).
//
// Spec: "Spaceflight Safety Handbook for Satellite Operators", Version 1.7,
// 18th & 19th Space Defense Squadron (space-track.org/documents/
// SFS_Handbook_For_Operators_V1.7.pdf), chapter "Ephemeris Formats":
//   - Overview (printed p.16): every format is in the mean equator / mean
//     equinox J2000.0 frame, positions in km, velocities in km/s; 19 SDS
//     corrects leap seconds, so epochs are UTC.
//   - "Modified ITC Ephemeris Format" (printed p.19-20, Figure 7): four header
//     lines, the fourth naming the orbital frame of the covariance (UVW = RTN).
//     Then, per ephemeris point, one line "yyyyDDDhhmmss.sss x y z dx dy dz"
//     followed by three lines holding the 21 values of the lower-triangular 6x6
//     position/velocity covariance (7 per line).
// The handbook gives no header keywords (the first three lines are free text;
// SpaceX writes created / ephemeris_start..stop..step_size / ephemeris_source)
// and does not state whether a point may omit its covariance; this parser
// accepts a state line followed by three seven-value rows or by none. The
// header carries no object name or identifier, so those stay empty. The
// covariance is not part of RawSeries and is validated but not returned.
#include <cctype>

#include "formats_support.hpp"

namespace odhpop::formats::detail {
namespace {

// "yyyyDDDhhmmss[.sss]": >= 13 digits before any '.', digits only.
bool is_state_epoch(std::string_view t) {
  const std::size_t dot = t.find('.');
  const std::size_t whole = dot == std::string_view::npos ? t.size() : dot;
  if (whole != 13) return false;
  for (std::size_t i = 0; i < t.size(); ++i)
    if (i != dot && !std::isdigit(static_cast<unsigned char>(t[i]))) return false;
  return true;
}

}  // namespace

ParseResult parse_moditc(const uint8_t* bytes, std::size_t size) {
  std::vector<std::string_view> lines;
  for (std::string_view l : lines_of(bytes, size))
    if (!trim(l).empty()) lines.push_back(trim(l));
  if (lines.size() < 5) return failure("parse-failed", "Modified ITC needs four header lines and at least one state");

  RawSeries series;
  series.frame = "EME2000";  // MEME J2000.0 (handbook overview)
  series.scale = "UTC";
  std::size_t at = 4;
  while (at < lines.size()) {
    const std::string where = " (line " + std::to_string(at + 1) + ")";
    const std::vector<std::string_view> t = tokens(lines[at]);
    if (t.size() != 7 || !is_state_epoch(t[0])) return failure("parse-failed", "expected a state line yyyyDDDhhmmss.sss x y z dx dy dz" + where);
    RawSample s;
    const std::string_view e = t[0];
    s.epoch = std::string(e.substr(0, 4)) + "-" + std::string(e.substr(4, 3)) + "T" + std::string(e.substr(7, 2)) + ":" +
              std::string(e.substr(9, 2)) + ":" + std::string(e.substr(11));
    long long doy;
    to_int(e.substr(4, 3), &doy);
    if (doy < 1 || doy > 366) return failure("parse-failed", "bad day of year" + where);
    for (int k = 0; k < 3; ++k)
      if (!to_double(t[1 + k], &s.r_km[k]) || !to_double(t[4 + k], &s.v_km[k]))
        return failure("parse-failed", "bad state component" + where);
    ++at;
    std::size_t cov_rows = 0;
    while (at < lines.size() && cov_rows < 3) {
      const std::vector<std::string_view> c = tokens(lines[at]);
      if (c.size() == 7 && is_state_epoch(c[0])) break;  // the next point
      if (c.size() != 7) return failure("parse-failed", "covariance row needs seven values (line " + std::to_string(at + 1) + ")");
      for (std::string_view w : c) {
        double v;
        if (!to_double(w, &v)) return failure("parse-failed", "bad covariance value " + std::string(w) + " (line " + std::to_string(at + 1) + ")");
      }
      ++cov_rows;
      ++at;
    }
    if (cov_rows != 0 && cov_rows != 3) return failure("parse-failed", "covariance block has " + std::to_string(cov_rows) + " rows, expected 3" + where);
    series.samples.push_back(s);
  }
  ParseResult r;
  r.ok = true;
  r.objects.push_back(std::move(series));
  return r;
}

}  // namespace odhpop::formats::detail
