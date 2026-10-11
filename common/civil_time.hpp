#pragma once
// common/civil_time.hpp: proleptic Gregorian calendar arithmetic for the source parsers.
//
// Integers only, Howard Hinnant's days_from_civil / civil_from_days
// (https://howardhinnant.github.io/date_algorithms.html). No time-scale conversion happens here: a
// parser states the scale its source declares and leaves leap seconds to foundation/time.
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>

namespace sdn_time {

inline int64_t days_from_civil(int64_t y, int64_t m, int64_t d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const int64_t yoe = y - era * 400;
  const int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468;
}

inline void civil_from_days(int64_t z, int64_t* y, int64_t* m, int64_t* d) {
  z += 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const int64_t doe = z - era * 146097;
  const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const int64_t mp = (5 * doy + 2) / 153;
  *d = doy - (153 * mp + 2) / 5 + 1;
  *m = mp + (mp < 10 ? 3 : -9);
  *y = yoe + era * 400 + (*m <= 2);
}

inline bool leap_year(int64_t y) { return y % 4 == 0 && (y % 100 != 0 || y % 400 == 0); }

inline bool valid_date(int64_t y, int64_t m, int64_t d) {
  static const int days[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  return d <= days[m - 1] + (m == 2 && leap_year(y) ? 1 : 0);
}

// "YYYY-MM-DDTHH:MM:SS" with optional ".f" (any number of digits) and an optional zone: "Z", or "+HHMM",
// "+HH:MM", "-HHMM", "-HH:MM". On success `*unix_seconds` is the instant in whole and fractional seconds
// since 1970-01-01T00:00:00 on the clock the text is written on, moved to UTC by the zone; `*zone_given`
// says whether the text named a zone (a text without one is the caller's declared scale, not assumed UTC).
inline bool parse_iso(const std::string& text, double* unix_seconds, bool* zone_given = nullptr) {
  int y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0, used = 0;
  if (std::sscanf(text.c_str(), "%4d-%2d-%2dT%2d:%2d:%2d%n", &y, &mo, &d, &h, &mi, &s, &used) != 6) return false;
  if (text.size() < 19 || text[4] != '-' || text[7] != '-' || text[10] != 'T' || text[13] != ':' || text[16] != ':') return false;
  if (!valid_date(y, mo, d) || h < 0 || h > 23 || mi < 0 || mi > 59 || s < 0 || s > 60) return false;
  double fraction = 0.0;
  size_t at = static_cast<size_t>(used);
  if (at < text.size() && text[at] == '.') {
    size_t end = at + 1;
    while (end < text.size() && text[end] >= '0' && text[end] <= '9') ++end;
    if (end == at + 1) return false;
    fraction = std::strtod(("0" + text.substr(at, end - at)).c_str(), nullptr);
    at = end;
  }
  double offset = 0.0;
  bool zone = false;
  if (at < text.size()) {
    zone = true;
    if (text[at] == 'Z' && at + 1 == text.size()) {
      at = text.size();
    } else if (text[at] == '+' || text[at] == '-') {
      const double sign = text[at] == '-' ? -1.0 : 1.0;
      std::string digits;
      for (size_t i = at + 1; i < text.size(); ++i) {
        if (text[i] == ':' && digits.size() == 2) continue;
        if (text[i] < '0' || text[i] > '9') return false;
        digits.push_back(text[i]);
      }
      if (digits.size() != 4) return false;
      const int oh = (digits[0] - '0') * 10 + (digits[1] - '0'), om = (digits[2] - '0') * 10 + (digits[3] - '0');
      if (oh > 23 || om > 59) return false;
      offset = sign * (oh * 3600.0 + om * 60.0);
      at = text.size();
    } else {
      return false;
    }
  }
  if (at != text.size()) return false;
  *unix_seconds = static_cast<double>(days_from_civil(y, mo, d)) * 86400.0 + h * 3600.0 + mi * 60.0 + s + fraction - offset;
  if (zone_given) *zone_given = zone;
  return true;
}

// "YYYY-MM-DDTHH:MM:SS.ffffff" for whole microseconds since 1970-01-01T00:00:00 (no zone suffix).
inline std::string format_iso_micro(int64_t unix_micro) {
  int64_t days = unix_micro / 86400000000LL;
  int64_t rem = unix_micro % 86400000000LL;
  if (rem < 0) { rem += 86400000000LL; --days; }
  int64_t y, m, d;
  civil_from_days(days, &y, &m, &d);
  const int64_t secs = rem / 1000000, micro = rem % 1000000;
  char out[40];
  std::snprintf(out, sizeof(out), "%04lld-%02lld-%02lldT%02lld:%02lld:%02lld.%06lld", static_cast<long long>(y), static_cast<long long>(m),
                static_cast<long long>(d), static_cast<long long>(secs / 3600), static_cast<long long>(secs / 60 % 60),
                static_cast<long long>(secs % 60), static_cast<long long>(micro));
  return out;
}

}  // namespace sdn_time
