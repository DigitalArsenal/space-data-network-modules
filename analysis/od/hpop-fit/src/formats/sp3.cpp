// "sp3": IGS / ESA / BKG precise orbits, SP3-c and SP3-d. Spec: "The Extended
// Standard Product 3 Orbit Format (SP3-d)", IGS/GNSS Working Group, Feb 2016
// (SP3-c: Hilla, 2010). Also accepts the gzip the archives serve (.sp3.gz).
//
// Header (fixed columns, 1-based): line 1 "#cP2026 10  7  0  0  0.00000000
// 96 ORBIT IGS20 HLM  IGS" - version letter col 2, P/V col 3, coordinate
// system cols 47-51 ("IGS20" is reported as written); line 2 "##" GPS week,
// seconds of week, epoch interval; "%c" lines: the first carries the time
// system in cols 10-12 (GPS, GLO, GAL, QZS, TAI, UTC; "ccc" = unspecified, read
// as GPS as SP3-c defines). Epoch line "*  YYYY MM DD hh mm ss.ssssssss";
// position record "PXXX x y z clock" (F14.6, km, microseconds); velocity record
// "VXXX vx vy vz rate" (dm/s, 1e-4 km/s). A position of 0.000000 on all three
// axes or 999999.999999 is the bad/absent flag; such records, and the
// velocity record of that epoch, are skipped.
//
// One RawSeries per satellite id (as written, e.g. "G01"); epochs are the
// file's own digits on the declared time system, never converted.
#include "formats_support.hpp"

namespace odhpop::formats::detail {
namespace {

std::string_view field(std::string_view line, std::size_t col0, std::size_t width) {
  if (col0 >= line.size()) return {};
  return trim(line.substr(col0, width));
}

bool bad_triplet(const double v[3]) {
  for (int k = 0; k < 3; ++k)
    if (v[k] >= 999999.0 || v[k] <= -999999.0) return true;
  return v[0] == 0 && v[1] == 0 && v[2] == 0;
}

}  // namespace

ParseResult parse_sp3(const uint8_t* in, std::size_t size) {
  std::vector<uint8_t> inflated;
  const uint8_t* bytes = in;
  if (size > 2 && in[0] == 0x1f && in[1] == 0x8b) {
    const std::string e = gunzip(in, size, 512u * 1024 * 1024, &inflated);
    if (!e.empty()) return failure("parse-failed", "gzip: " + e);
    bytes = inflated.data();
    size = inflated.size();
  }
  const std::vector<std::string_view> lines = lines_of(bytes, size);
  if (lines.empty() || lines[0].size() < 3 || lines[0][0] != '#' || lines[0][1] < 'a' || lines[0][1] > 'd')
    return failure("parse-failed", "not an SP3 file (line 1 must start #a..#d)");
  const std::string frame(field(lines[0], 46, 5));
  if (frame.empty()) return failure("parse-failed", "SP3 header has no coordinate system");
  std::string scale;
  ParseResult r;
  std::vector<std::size_t> last_epoch_idx;  // per series: index of the epoch of its last sample
  std::string epoch;
  std::size_t epoch_idx = 0;
  bool have_epoch = false, eof = false;

  for (std::size_t n = 1; n < lines.size() && !eof; ++n) {
    const std::string_view line = lines[n];
    if (line.empty()) continue;
    const std::string where = " (line " + std::to_string(n + 1) + ")";
    if (starts_with(line, "%c") && scale.empty()) {
      const std::vector<std::string_view> t = tokens(line);
      scale = t.size() > 3 && t[3] != "ccc" ? std::string(t[3]) : "GPS";
      continue;
    }
    if (starts_with(line, "EOF")) { eof = true; continue; }
    if (line[0] == '*') {
      const std::vector<std::string_view> t = tokens(line.substr(1));
      long long v[5];
      double sec;
      if (t.size() != 6 || !to_double(t[5], &sec)) return failure("parse-failed", "bad epoch line" + where);
      for (int k = 0; k < 5; ++k)
        if (!to_int(t[k], &v[k])) return failure("parse-failed", "bad epoch line" + where);
      epoch = iso_datetime(static_cast<int>(v[0]), static_cast<int>(v[1]), static_cast<int>(v[2]), static_cast<int>(v[3]),
                           static_cast<int>(v[4]), t[5]);
      have_epoch = true;
      ++epoch_idx;
      continue;
    }
    if (line[0] != 'P' && line[0] != 'V') continue;  // header and EP/EV/comment records
    if (!have_epoch) return failure("parse-failed", "record before the first epoch" + where);
    if (line.size() < 4 + 3 * 14) return failure("parse-failed", "short SP3 record" + where);
    std::string id(line.substr(1, 3));
    if (id[0] == ' ') id[0] = 'G';  // SP3-a: a blank constellation letter is GPS
    for (char& c : id)
      if (c == ' ') c = '0';
    double v[3];
    for (int k = 0; k < 3; ++k)
      if (!to_double(field(line, 4 + 14 * k, 14), &v[k])) return failure("parse-failed", "bad SP3 value" + where);
    if (bad_triplet(v)) continue;
    std::size_t si = 0;
    for (; si < r.objects.size(); ++si)
      if (r.objects[si].object_name == id) break;
    if (line[0] == 'P') {
      if (si == r.objects.size()) {
        r.objects.emplace_back();
        r.objects.back().object_name = id;
        r.objects.back().frame = frame;
        r.objects.back().scale = scale;
        last_epoch_idx.push_back(0);
      }
      RawSample s;
      s.epoch = epoch;
      for (int k = 0; k < 3; ++k) s.r_km[k] = v[k];
      s.has_velocity = false;
      r.objects[si].samples.push_back(s);
      last_epoch_idx[si] = epoch_idx;
    } else if (si < r.objects.size() && last_epoch_idx[si] == epoch_idx) {
      RawSample& s = r.objects[si].samples.back();
      for (int k = 0; k < 3; ++k) s.v_km[k] = v[k] * 1e-4;  // dm/s -> km/s
      s.has_velocity = true;
    }
  }
  if (scale.empty()) return failure("parse-failed", "SP3 header has no %c time-system line");
  for (RawSeries& s : r.objects) s.scale = scale;
  if (r.objects.empty()) return failure("parse-failed", "SP3 file holds no usable position records");
  r.ok = true;
  return r;
}

}  // namespace odhpop::formats::detail
