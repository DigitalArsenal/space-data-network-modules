// Fixed columns: USNO readme.finals2000A and Paris C04 file FORMAT headers.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
namespace {
using eop_wire::Json;
constexpr double AS2R = 4.848136811095359935899141e-6;
constexpr size_t MAX_BYTES = 16 * 1024 * 1024;
std::string trim(const std::string& s) {
  auto b = s.find_first_not_of(" \r\n\t");
  return b == std::string::npos
             ? ""
             : s.substr(b, s.find_last_not_of(" \r\n\t") - b + 1);
}
bool number(const std::string& line, size_t start, size_t length, double& value,
            bool optional = false) {
  std::string s = start >= line.size() ? "" : trim(line.substr(start, length));
  if (s.empty()) {
    value = NAN;
    return optional;
  }
  // Published decimal fields, not C strtod extensions (NaN, infinity, hex).
  if (s.find_first_not_of(" +-.0123456789") != std::string::npos) return false;
  char* end = nullptr;
  value = std::strtod(s.c_str(), &end);
  return end != s.c_str() && *end == '\0' && std::isfinite(value);
}
struct Row {
  int y, m, d;
  uint32_t mjd;
  bool predicted = false;
  double v[6], err[6];
};
// Gregorian calendar to MJD; independent integer calendar arithmetic.
bool calendar(Row& r, double mjd) {
  if (r.y < 1962 || r.y > 9999 || r.m < 1 || r.m > 12 || r.d < 1) return false;
  const int days[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  bool leap = (r.y % 4 == 0 && (r.y % 100 != 0 || r.y % 400 == 0));
  if (r.d > days[r.m - 1] + (r.m == 2 && leap)) return false;
  int a = (14 - r.m) / 12, y = r.y + 4800 - a, m = r.m + 12 * a - 3;
  int expected = r.d + (153 * m + 2) / 5 + 365 * y + y / 4 - y / 100 + y / 400 -
                 32045 - 2400001;
  if (mjd != expected) return false;
  r.mjd = expected;
  return true;
}
bool date_fields(const std::string& l, bool finals, Row& r) {
  double y, m, d, mjd;
  if (!number(l, 0, finals ? 2 : 4, y) ||
      !number(l, finals ? 2 : 4, finals ? 2 : 4, m) ||
      !number(l, finals ? 4 : 8, finals ? 2 : 4, d))
    return false;
  if (y != std::floor(y) || m != std::floor(m) || d != std::floor(d))
    return false;
  r.y = y;
  r.m = m;
  r.d = d;
  if (finals) {
    if (!number(l, 7, 8, mjd)) return false;
    r.y += mjd <= 51543 ? 1900 : 2000;
    return calendar(r, mjd);
  }
  return true;
}
// 1 = row, 0 = legitimate blank future date, -1 = malformed row.
int finals(const std::string& l, Row& r) {
  if (!date_fields(l, true, r)) return -1;
  if (trim(l.size() > 16 ? l.substr(16) : "").empty()) return 0;
  if (l.size() < 78 || (l[16] != 'I' && l[16] != 'P') ||
      (l[57] != 'I' && l[57] != 'P'))
    return -1;
  r.predicted = l[16] == 'P' || l[57] == 'P';
  const size_t at[] = {18, 37, 58, 97, 116, 79}, len[] = {9, 9, 10, 9, 9, 7};
  const size_t errAt[] = {27, 46, 68, 106, 125, 86};
  for (int i = 0; i < 6; ++i) {
    if (!number(l, at[i], len[i], r.v[i], i >= 3) ||
        !number(l, errAt[i], len[i], r.err[i], true))
      return -1;
  }
  if (std::isfinite(r.v[3]) != std::isfinite(r.v[4])) return -1;
  if (std::isfinite(r.v[3])) {
    if (l.size() < 96 || (l[95] != 'I' && l[95] != 'P')) return -1;
    r.predicted = r.predicted || l[95] == 'P';
  }
  for (int i : {3, 4, 5}) {
    r.v[i] *= 0.001;
    r.err[i] *= 0.001;
  }
  return 1;
}
int c04(const std::string& l, Row& r, bool legacy) {
  if (!date_fields(l, false, r)) return -1;
  double mjd, hour;
  if (!number(l, legacy ? 12 : 16, legacy ? 7 : 10, mjd) || !calendar(r, mjd))
    return -1;
  if (!legacy && (!number(l, 12, 4, hour) || hour != 0)) return -1;
  const size_t modernAt[] = {26, 38, 50, 62, 74, 110},
               modernErr[] = {122, 134, 146, 158, 170, 206};
  const size_t oldAt[] = {19, 30, 41, 65, 76, 53},
               oldLen[] = {11, 11, 12, 11, 11, 12},
               oldErr[] = {87, 98, 109, 131, 143, 120},
               oldErrLen[] = {11, 11, 11, 12, 12, 11};
  for (int i = 0; i < 6; ++i) {
    if (!number(l, legacy ? oldAt[i] : modernAt[i], legacy ? oldLen[i] : 12,
                r.v[i]) ||
        !number(l, legacy ? oldErr[i] : modernErr[i],
                legacy ? oldErrLen[i] : 12, r.err[i]))
      return -1;
  }
  return 1;
}
bool decode64(const std::string& s, std::string& out) {
  static const std::string chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (s.size() % 4 || s.size() > 4 * ((MAX_BYTES + 2) / 3)) return false;
  for (size_t i = 0; i < s.size(); i += 4) {
    uint32_t n = 0;
    int pad = 0;
    for (int j = 0; j < 4; ++j) {
      char c = s[i + j];
      if (c == '=') {
        if (j < 2 || i + 4 != s.size()) return false;
        ++pad;
        n <<= 6;
      } else {
        auto v = chars.find(c);
        if (v == std::string::npos || pad) return false;
        n = (n << 6) | v;
      }
    }
    if (pad > 2 || (pad == 2 && (n & 0xffff)) || (pad == 1 && (n & 0xff)))
      return false;
    out.push_back(n >> 16);
    if (pad < 2) out.push_back(n >> 8);
    if (pad < 1) out.push_back(n);
  }
  return out.size() <= MAX_BYTES;
}
void append(const Row& r, int source, const std::string& cid,
            const std::string& epoch, std::vector<uint8_t>& stream) {
  flatbuffers::FlatBufferBuilder b(512);
  b.ForceDefaults(true);  // preserve authoritative HP zeroes
  char date[32];
  std::snprintf(date, sizeof(date), "%04d-%02d-%02dT00:00:00Z", r.y, r.m, r.d);
  auto ds = b.CreateString(date), cs = b.CreateString(cid),
       es = epoch.empty() ? flatbuffers::Offset<flatbuffers::String>()
                          : b.CreateString(epoch);
  EOPBuilder row(b);
  row.add_DATE(ds);
  row.add_MJD(r.mjd);
  row.add_DATA_SET_CID(cs);
  if (!epoch.empty()) row.add_DATA_SET_EPOCH(es);
  row.add_SERIES(source == 0   ? eopSeries::FINALS2000A
                 : source == 1 ? eopSeries::IERS_C04_20
                               : eopSeries::OTHER);
  // The actual C04 file header says IAU 2000, as does finals2000A's readme.
  row.add_IAU_CONVENTION(iauPrecessionNutationModel::IAU_2000A);
  row.add_DATA_TYPE(r.predicted ? DataType::PREDICTED : DataType::OBSERVED);
  double x = r.v[0] * AS2R, y = r.v[1] * AS2R;
  row.add_X_POLE_WANDER_RADIANS_HP(x);
  row.add_X_POLE_WANDER_RADIANS(x);
  row.add_Y_POLE_WANDER_RADIANS_HP(y);
  row.add_Y_POLE_WANDER_RADIANS(y);
  row.add_UT1_MINUS_UTC_SECONDS_HP(r.v[2]);
  row.add_UT1_MINUS_UTC_SECONDS(r.v[2]);
  if (std::isfinite(r.v[3])) {
    row.add_X_CELESTIAL_POLE_OFFSET_RADIANS_HP(r.v[3] * AS2R);
    row.add_X_CELESTIAL_POLE_OFFSET_RADIANS(r.v[3] * AS2R);
  }
  if (std::isfinite(r.v[4])) {
    row.add_Y_CELESTIAL_POLE_OFFSET_RADIANS_HP(r.v[4] * AS2R);
    row.add_Y_CELESTIAL_POLE_OFFSET_RADIANS(r.v[4] * AS2R);
  }
  if (std::isfinite(r.v[5])) {
    row.add_LENGTH_OF_DAY_CORRECTION_SECONDS_HP(r.v[5]);
    row.add_LENGTH_OF_DAY_CORRECTION_SECONDS(r.v[5]);
  }
  if (std::isfinite(r.err[0]))
    row.add_X_POLE_WANDER_UNCERTAINTY_RADIANS(r.err[0] * AS2R);
  if (std::isfinite(r.err[1]))
    row.add_Y_POLE_WANDER_UNCERTAINTY_RADIANS(r.err[1] * AS2R);
  if (std::isfinite(r.err[2]))
    row.add_UT1_MINUS_UTC_UNCERTAINTY_SECONDS(r.err[2]);
  if (std::isfinite(r.err[3]))
    row.add_X_CELESTIAL_POLE_OFFSET_UNCERTAINTY_RADIANS(r.err[3] * AS2R);
  if (std::isfinite(r.err[4]))
    row.add_Y_CELESTIAL_POLE_OFFSET_UNCERTAINTY_RADIANS(r.err[4] * AS2R);
  if (std::isfinite(r.err[5]))
    row.add_LENGTH_OF_DAY_UNCERTAINTY_SECONDS(r.err[5]);
  // SDK transport prefixes a standalone FlatBuffer (the existing parser
  // convention).
  FinishEOPBuffer(b, row.Finish());
  const uint32_t length = b.GetSize();
  for (int i = 0; i < 4; ++i)
    stream.push_back(static_cast<uint8_t>(length >> (8 * i)));
  stream.insert(stream.end(), b.GetBufferPointer(),
                b.GetBufferPointer() + b.GetSize());
}
int parse(int source) {
  using namespace eop_wire;
  plugin_reset_output_state();
  if (!unique_inputs())
    return error("Duplicate input frames are not supported.");
  auto job = json(frame("job"));
  if (!job.is_object()) return error("job must be a JSON object.");
  for (auto key : {"data_set_epoch", "source_url", "format", "series_name"})
    if (job.contains(key) && !job[key].is_string())
      return error("Job metadata must be strings.");
  if (job.contains("format") && job["format"] != sources[source].format)
    return error("Job format does not match parser method.");
  auto raw = frame("body"), response = frame("response");
  if (bool(raw) == bool(response))
    return error("Supply exactly one body or HTTP response.");
  std::string body;
  if (raw) {
    if (raw->payload_length > MAX_BYTES) return error("Source exceeds 16 MiB.");
    body.assign(reinterpret_cast<const char*>(raw->payload),
                raw->payload_length);
  } else {
    auto http = json(response);
    if (!http.is_object() || !http.contains("status") ||
        !http["status"].is_number_integer())
      return error("Invalid HTTP response.");
    if (http["status"] == 304)
      return push("unchanged", {{"status", 304},
                                {"unchanged", true},
                                {"series_name", sources[source].name}}) < 0
                 ? 5
                 : 0;
    if (http["status"] != 200 || !http.contains("bodyB64") ||
        !http["bodyB64"].is_string())
      return error("HTTP 200 and bodyB64 required.");
    if (!decode64(http["bodyB64"].get<std::string>(), body))
      return error("Invalid base64 response body.");
  }
  const auto hash = ephem::sha256_hex(
      reinterpret_cast<const uint8_t*>(body.data()), body.size());
  const std::string cid =
      "f01551220" + hash;  // CIDv1, raw codec, sha2-256, multibase base16
  std::vector<Row> rows;
  size_t start = 0, lineNo = 0;
  int skipped = 0;
  while (start < body.size()) {
    size_t end = body.find('\n', start);
    if (end == std::string::npos) end = body.size();
    std::string line = body.substr(start, end - start);
    start = end + 1;
    ++lineNo;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (trim(line).empty()) continue;
    // C04 has documented prose/FORMAT headings; data rows start with four
    // digits.
    if (source && (line.size() < 4 ||
                   !std::all_of(line.begin(), line.begin() + 4,
                                [](char c) { return c >= '0' && c <= '9'; }))) {
      const std::string heading = trim(line);
      const bool knownHeading =
          heading[0] == '#' ||
          (source == 2 &&
           (heading.find("EARTH ORIENTATION") == 0 ||
            heading.find("INTERNATIONAL EARTH") == 0 ||
            heading.find("EOP (IERS)") == 0 ||
            heading.find("Description:") == 0 ||
            heading.find("contact:") == 0 || heading.find("FORMAT(") == 0 ||
            heading.find("Date") == 0 || heading[0] == '"' ||
            heading == "(0h UTC)"));
      if (!rows.empty() || !knownHeading)
        return error("Unexpected text in C04 data.");
      continue;
    }
    Row r{};
    int result = source ? c04(line, r, source == 2) : finals(line, r);
    if (result < 0) {
      auto message =
          "Malformed fixed-column EOP row at line " + std::to_string(lineNo);
      return error(message.c_str());
    }
    if (!result) {
      ++skipped;
      continue;
    }
    for (double sigma : r.err)
      if (std::isfinite(sigma) && sigma < 0)
        return error("Negative EOP uncertainty.");
    if (!rows.empty() && r.mjd <= rows.back().mjd)
      return error("EOP dates must be strictly increasing.");
    rows.push_back(r);
  }
  if (rows.empty()) return error("No EOP rows found.");
  std::vector<uint8_t> stream;
  for (const auto& row : rows)
    append(row, source, cid, job.value("data_set_epoch", std::string()),
           stream);
  if (plugin_push_output_ex("records", "EOP.fbs", "$EOP",
                            PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "EOP", 0, 0,
                            stream.data(), stream.size()) < 0)
    return 5;
  return push("meta",
              {{"schema", "EOP.fbs"},
               {"source_url",
                job.value("source_url", std::string(sources[source].url))},
               {"series_name", sources[source].name},
               {"format", sources[source].format},
               {"sha256", hash},
               {"data_set_cid", cid},
               {"record_count", rows.size()},
               {"empty_future_rows", skipped}}) < 0
             ? 5
             : 0;
}
}  // namespace
extern "C" int parse_finals2000a() { return parse(0); }
extern "C" int parse_c04() { return parse(1); }
extern "C" int parse_paris() { return parse(2); }
