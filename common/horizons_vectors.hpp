#pragma once
// Horizons VECTORS wire contract. All clocks here are TDB calendar seconds;
// these helpers never convert TDB to UTC or apply leap seconds.
#include "civil_time.hpp"
#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <string>
#include <vector>

namespace horizons {
constexpr size_t kHorizonsLineCap = 90024;
constexpr size_t kDefaultPageRows = 80000;
constexpr size_t kMaxPageRows = 89000;
constexpr int64_t kDay = 86400;
constexpr int64_t kWindowStep = 600;
constexpr int64_t kJ2000UnixSeconds = 946728000;
using State = std::array<double, 6>;

inline std::string trim(const std::string& text) {
  size_t a = 0, b = text.size();
  while (a < b && std::isspace(static_cast<unsigned char>(text[a]))) ++a;
  while (b > a && std::isspace(static_cast<unsigned char>(text[b - 1]))) --b;
  return text.substr(a, b - a);
}

inline bool parseCalendar(const std::string& text, double& seconds) {
  if (text.size() < 19 || text[4] != '-' || text[7] != '-' ||
      (text[10] != 'T' && text[10] != ' ') || text[13] != ':' || text[16] != ':') return false;
  const size_t positions[] = {0, 5, 8, 11, 14, 17};
  int fields[6] = {};
  for (size_t f = 0; f < 6; ++f) {
    const size_t digits = f == 0 ? 4 : 2;
    for (size_t i = 0; i < digits; ++i) {
      const char c = text[positions[f] + i];
      if (c < '0' || c > '9') return false;
      fields[f] = fields[f] * 10 + c - '0';
    }
  }
  const int y = fields[0], m = fields[1], d = fields[2];
  static constexpr int monthDays[] = {31,28,31,30,31,30,31,31,30,31,30,31};
  if (y < 1 || m < 1 || m > 12 || d < 1 ||
      d > monthDays[m - 1] + (m == 2 && sdn_time::leap_year(y) ? 1 : 0) ||
      fields[3] > 23 || fields[4] > 59 || fields[5] > 59) return false;
  double fraction = 0.0, place = 0.1;
  if (text.size() > 19) {
    if (text[19] != '.' || text.size() == 20) return false;
    for (size_t i = 20; i < text.size(); ++i) {
      if (text[i] < '0' || text[i] > '9') return false;
      fraction += (text[i] - '0') * place;
      place *= 0.1;
    }
  }
  seconds = double(sdn_time::days_from_civil(y, m, d) * kDay - kJ2000UnixSeconds +
                   fields[3] * 3600 + fields[4] * 60 + fields[5]) + fraction;
  return true;
}

inline std::string formatCalendar(double seconds, bool space = false) {
  if (!std::isfinite(seconds) || std::abs(seconds) > 2.5e11) return {};
  const int64_t micro = std::llround(seconds * 1000000.0) + kJ2000UnixSeconds * 1000000LL;
  std::string result = sdn_time::format_iso_micro(micro);
  if (result.substr(result.size() - 7) == ".000000") result.resize(result.size() - 7);
  if (space) result[10] = ' ';
  return result;
}

inline bool parseCoverage(const std::string& text, bool lower, double& seconds, std::string& error) {
  error.clear();
  const std::string marker = lower ? " prior to A.D. " : " after A.D. ";
  const size_t target = text.find("No ephemeris for target \"");
  const size_t start = text.find(marker, target);
  if (target == std::string::npos || start == std::string::npos) {
    error = "unknown-horizons-error"; return false;
  }
  const size_t first = start + marker.size(), end = text.find(" TDB", first);
  if (end == std::string::npos) { error = "invalid-coverage-bound"; return false; }
  const std::string stamp = text.substr(first, end - first);
  if (stamp.size() < 20 || stamp[4] != '-' || stamp[8] != '-') {
    error = "invalid-coverage-bound"; return false;
  }
  std::string month = stamp.substr(5, 3);
  for (char& c : month) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
  constexpr const char* months[] = {"JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"};
  int mo = 0;
  for (int i = 0; i < 12; ++i) if (month == months[i]) mo = i + 1;
  if (!mo) { error = "invalid-coverage-bound"; return false; }
  const std::string iso = stamp.substr(0, 5) + (mo < 10 ? "0" : "") + std::to_string(mo) + stamp.substr(8);
  if (!parseCalendar(iso, seconds)) { error = "invalid-coverage-bound"; return false; }
  return true;
}

inline std::string encodeQuery(const std::string& value) {
  constexpr const char* hex = "0123456789ABCDEF";
  std::string result;
  for (unsigned char c : value) {
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
        (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') result += char(c);
    else { result += '%'; result += hex[c >> 4]; result += hex[c & 15]; }
  }
  return result;
}

inline std::string requestUrl(int id, int64_t start, int64_t stop, int64_t step) {
  std::string url = "https://ssd.jpl.nasa.gov/api/horizons.api?format=text";
  const auto add = [&](const char* key, const std::string& value) {
    url += '&'; url += key; url += '='; url += encodeQuery("'" + value + "'");
  };
  add("COMMAND", std::to_string(id)); add("OBJ_DATA", "NO"); add("MAKE_EPHEM", "YES");
  add("EPHEM_TYPE", "VECTORS"); add("CENTER", "500@10");
  add("START_TIME", formatCalendar(double(start), true)); add("STOP_TIME", formatCalendar(double(stop), true));
  add("STEP_SIZE", step == kDay ? "1 d" : "10 m"); add("VEC_TABLE", "2");
  add("REF_SYSTEM", "ICRF"); add("REF_PLANE", "FRAME"); add("OUT_UNITS", "KM-S");
  add("VEC_LABELS", "NO"); add("CSV_FORMAT", "YES");
  return url;
}

struct Page { int64_t start, stop, step; size_t rows, offset; };
inline bool pages(int64_t start, int64_t stop, int64_t step, size_t pageRows,
                  std::vector<Page>& result, std::string& error) {
  result.clear(); error.clear();
  if (!pageRows || pageRows > kMaxPageRows) { error = "invalid-page-rows"; return false; }
  if (step <= 0 || stop < start || (stop - start) % step != 0) { error = "invalid-request-grid"; return false; }
  const size_t count = size_t((stop - start) / step) + 1;
  for (size_t offset = 0; offset < count; offset += pageRows) {
    const size_t rows = std::min(pageRows, count - offset);
    const int64_t first = start + int64_t(offset) * step;
    result.push_back({first, first + int64_t(rows - 1) * step, step, rows, offset});
  }
  return true;
}

inline bool number(const std::string& field, double& value) {
  const std::string clean = trim(field);
  if (clean.empty()) return false;
  char* end = nullptr;
  value = std::strtod(clean.c_str(), &end);
  return end == clean.c_str() + clean.size() && std::isfinite(value);
}

inline std::string headerValue(const std::string& header, const std::string& key) {
  const size_t at = header.find(key);
  if (at == std::string::npos || (at && header[at - 1] != '\n')) return {};
  const size_t colon = header.find(':', at + key.size());
  const size_t end = header.find('\n', at);
  if (colon == std::string::npos || colon > end) return {};
  return trim(header.substr(colon + 1, end - colon - 1));
}

inline bool validateTarget(const std::string& text, int expectedId, std::string& error) {
  const std::string target = headerValue(text.substr(0, text.find("$$SOE")), "Target body name");
  if (target.find("(" + std::to_string(expectedId) + ")") == std::string::npos) {
    error = "vector-target-mismatch"; return false;
  }
  return true;
}

inline bool parseVectorRows(const std::string& text, std::vector<double>& epochs,
                            std::vector<State>& rows, std::string& error) {
  epochs.clear(); rows.clear(); error.clear();
  const size_t begin = text.find("$$SOE"), end = text.find("$$EOE");
  if (begin == std::string::npos) { error = "unknown-horizons-error"; return false; }
  if (end == std::string::npos || end <= begin) { error = "truncated-vector-page"; return false; }
  const auto markerLine = [&](size_t at) {
    return (at == 0 || text[at - 1] == '\n') &&
           (at + 5 == text.size() || text[at + 5] == '\r' || text[at + 5] == '\n');
  };
  if (!markerLine(begin) || !markerLine(end)) { error = "invalid-vector-markers"; return false; }
  const std::string header = text.substr(0, begin);
  const std::string center = headerValue(header, "Center body name");
  if (headerValue(header, "Output units") != "KM-S" ||
      headerValue(header, "Reference frame") != "ICRF" ||
      headerValue(header, "Output type") != "GEOMETRIC cartesian states" ||
      headerValue(header, "Output format") != "2 (position and velocity)" ||
      center.find("Sun (10)") != 0 || header.find("JDTDB,") == std::string::npos ||
      header.find("Calendar Date (TDB)") == std::string::npos) {
    error = "invalid-vector-header"; return false;
  }
  const size_t lineCount = size_t(std::count(text.begin(), text.begin() + end, '\n')) + 1;
  if (lineCount > kHorizonsLineCap) { error = "horizons-line-cap"; return false; }
  size_t at = text.find('\n', begin);
  if (at == std::string::npos) { error = "truncated-vector-page"; return false; }
  ++at;
  while (at < end) {
    const size_t newline = text.find('\n', at);
    if (newline == std::string::npos || newline > end) { error = "truncated-vector-page"; rows.clear(); return false; }
    const std::string line = trim(text.substr(at, newline - at));
    at = newline + 1;
    if (rows.size() >= kMaxPageRows) { error = "horizons-line-cap"; rows.clear(); return false; }
    std::vector<std::string> fields;
    size_t fieldStart = 0;
    for (size_t i = 0; i <= line.size(); ++i) if (i == line.size() || line[i] == ',') {
      fields.push_back(line.substr(fieldStart, i - fieldStart)); fieldStart = i + 1;
    }
    if (fields.size() != 9 || !trim(fields.back()).empty()) { error = "invalid-vector-row"; rows.clear(); return false; }
    double jd = 0;
    if (!number(fields[0], jd)) { error = "invalid-vector-epoch"; rows.clear(); return false; }
    State row{};
    for (size_t i = 0; i < row.size(); ++i) if (!number(fields[i + 2], row[i])) {
      error = "invalid-vector-state"; rows.clear(); return false;
    }
    epochs.push_back(jd); rows.push_back(row);
  }
  if (rows.empty()) { error = "missing-vector-row"; return false; }
  return true;
}

inline bool parseVectors(const std::string& text, int64_t start, int64_t step, size_t expected,
                         std::vector<State>& rows, std::string& error) {
  rows.clear(); error.clear();
  if (step <= 0 || !expected || expected > kMaxPageRows) { error = "invalid-request-grid"; return false; }
  std::vector<double> epochs;
  if (!parseVectorRows(text, epochs, rows, error)) return false;
  if (rows.size() != expected) {
    error = rows.size() < expected ? "missing-vector-row" : "extra-vector-row";
    rows.clear(); return false;
  }
  for (size_t i = 0; i < epochs.size(); ++i) {
    const int64_t epoch = start + int64_t(i) * step;
    const double expectedJd = 2451545.0 + double(epoch) / double(kDay);
    if (std::abs(epochs[i] - expectedJd) > 1e-6) { error = "vector-grid-mismatch"; rows.clear(); return false; }
  }
  return true;
}

inline int reconcileId(const std::string& mission, int kernelId) {
  return mission == "artemis-ii" && kernelId == -24 ? -1024 : kernelId;
}
}  // namespace horizons
