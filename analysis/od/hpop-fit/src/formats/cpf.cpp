// "cpf": ILRS Consolidated Prediction Format, version 2 (ESA/ESOC, EDC, CDDIS).
// Spec: "ILRS Consolidated Laser Ranging Prediction Format, Version 2.00",
// R. Ricklefs, 2006 (ilrs.gsfc.nasa.gov/docs). Records used:
//   H1  "H1 CPF 2 <source> <yyyy> <mm> <dd> <hh> <seq> <target> [notes]"
//   H2  "H2 <ilrs id> <sic> <norad> <start y m d h m s> <end y m d h m s>
//        <step s> <target type> <ref frame> <rot angle type> <com corr> <dynamics>"
//       ref frame 0 = geocentric true body-fixed (ITRF); other values are
//       space-fixed frames and are refused. (Field positions are from the
//       v2.00 document; not checked against a live file.)
//   10  "10 <direction> <MJD> <seconds of day> <leap flag> <x> <y> <z>", metres,
//       UTC. A seconds-of-day of 86400 or more on a leap-second day is written
//       23:59:60.xxx.
// Velocity (20), correction (30), transponder (40) and other records are
// skipped. One RawSeries; ILRS id YYPPPNN is mapped to a COSPAR designator.
#include "formats_support.hpp"

namespace odhpop::formats::detail {
namespace {

// 8606101 (YYPPPNN) -> "1986-061A"; empty when it is not that shape.
std::string cospar_from_ilrs(std::string_view id) {
  if (id.size() != 7) return {};
  long long yy, launch, piece;
  if (!to_int(id.substr(0, 2), &yy) || !to_int(id.substr(2, 3), &launch) || !to_int(id.substr(5, 2), &piece)) return {};
  if (piece < 1 || piece > 26) return {};
  char out[16];
  std::snprintf(out, sizeof out, "%04lld-%03lld%c", yy >= 57 ? 1900 + yy : 2000 + yy, launch, static_cast<char>('A' + piece - 1));
  return out;
}

}  // namespace

ParseResult parse_cpf(const uint8_t* bytes, std::size_t size) {
  const std::vector<std::string_view> lines = lines_of(bytes, size);
  RawSeries series;
  series.frame = "ITRF";
  series.scale = "UTC";
  bool have_h1 = false, have_h2 = false;
  const long long mjd0 = days_from_civil(1858, 11, 17);
  for (std::size_t n = 0; n < lines.size(); ++n) {
    const std::vector<std::string_view> t = tokens(lines[n]);
    if (t.empty()) continue;
    const std::string where = " (line " + std::to_string(n + 1) + ")";
    const std::string rec = upper(t[0]);
    if (rec == "H1") {
      if (t.size() < 10 || upper(t[1]) != "CPF") return failure("parse-failed", "bad H1 record" + where);
      long long version;
      if (!to_int(t[2], &version) || version != 2) return failure("unsupported-format", "CPF version " + std::string(t[2]) + " (only v2 is read)" + where);
      series.object_name = std::string(t[9]);
      have_h1 = true;
    } else if (rec == "H2") {
      if (t.size() < 4) return failure("parse-failed", "bad H2 record" + where);
      series.object_id = cospar_from_ilrs(t[1]);
      long long norad;
      if (to_int(t[3], &norad) && norad > 0) series.norad_cat_id = static_cast<int>(norad);
      long long frame;
      if (t.size() > 18 && to_int(t[18], &frame) && frame != 0)
        return failure("unsupported-frame", "CPF reference frame code " + std::to_string(frame) + " is not geocentric body-fixed" + where);
      have_h2 = true;
    } else if (rec == "10") {
      if (!have_h1 || !have_h2) return failure("parse-failed", "record 10 before the H1/H2 headers" + where);
      if (t.size() < 8) return failure("parse-failed", "short record 10" + where);
      long long mjd, dir, leap;
      double sod, xyz[3];
      if (!to_int(t[1], &dir) || !to_int(t[2], &mjd) || !to_double(t[3], &sod) || !to_int(t[4], &leap))
        return failure("parse-failed", "bad record 10" + where);
      for (int k = 0; k < 3; ++k)
        if (!to_double(t[5 + k], &xyz[k])) return failure("parse-failed", "bad position" + where);
      const std::string_view sods = t[3];
      const std::size_t dot = sods.find('.');
      long long whole;
      if (!to_int(dot == std::string_view::npos ? sods : sods.substr(0, dot), &whole) || whole < 0)
        return failure("parse-failed", "bad seconds of day" + where);
      int y, mo, d;
      civil_from_days(mjd0 + mjd, &y, &mo, &d);
      int hh, mm;
      std::string sec;
      if (whole >= 86400) {  // the inserted leap second
        hh = 23; mm = 59;
        sec = std::to_string(60 + (whole - 86400));
      } else {
        hh = static_cast<int>(whole / 3600);
        mm = static_cast<int>(whole / 60 % 60);
        sec = std::to_string(whole % 60);
      }
      if (dot != std::string_view::npos) sec += std::string(sods.substr(dot));
      RawSample s;
      s.epoch = iso_datetime(y, mo, d, hh, mm, sec);
      for (int k = 0; k < 3; ++k) s.r_km[k] = xyz[k] / 1000.0;
      s.has_velocity = false;
      series.samples.push_back(s);
    }
  }
  if (!have_h1) return failure("parse-failed", "not a CPF file (no H1 record)");
  if (series.samples.empty()) return failure("parse-failed", "CPF holds no record 10 positions");
  ParseResult r;
  r.ok = true;
  r.objects.push_back(std::move(series));
  return r;
}

}  // namespace odhpop::formats::detail
