#include <cmath>
#include <cstdio>
#include <cstdlib>

#include "formats_support.hpp"

namespace odhpop::formats::detail {

ParseResult failure(const std::string& code, const std::string& message) {
  ParseResult r;
  r.ok = false;
  r.error_code = code;
  r.error_message = message;
  return r;
}

std::vector<std::string_view> lines_of(const uint8_t* bytes, std::size_t size) {
  std::vector<std::string_view> out;
  const char* p = reinterpret_cast<const char*>(bytes);
  std::size_t start = 0;
  for (std::size_t i = 0; i <= size; ++i) {
    if (i == size || p[i] == '\n') {
      if (i == size && start == size) break;
      std::size_t end = i;
      if (end > start && p[end - 1] == '\r') --end;
      out.emplace_back(p + start, end - start);
      start = i + 1;
    }
  }
  return out;
}

std::string_view trim(std::string_view s) {
  std::size_t a = 0, b = s.size();
  while (a < b && (s[a] == ' ' || s[a] == '\t' || s[a] == '\r' || s[a] == '\n')) ++a;
  while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t' || s[b - 1] == '\r' || s[b - 1] == '\n')) --b;
  return s.substr(a, b - a);
}

std::vector<std::string_view> tokens(std::string_view s) {
  std::vector<std::string_view> out;
  std::size_t i = 0;
  while (i < s.size()) {
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t')) ++i;
    std::size_t j = i;
    while (j < s.size() && s[j] != ' ' && s[j] != '\t') ++j;
    if (j > i) out.push_back(s.substr(i, j - i));
    i = j;
  }
  return out;
}

bool to_double(std::string_view s, double* out) {
  if (s.empty() || s.size() > 63) return false;
  char buf[64];
  for (std::size_t i = 0; i < s.size(); ++i) buf[i] = s[i];
  buf[s.size()] = 0;
  char* end = nullptr;
  const double v = std::strtod(buf, &end);
  if (end != buf + s.size() || !std::isfinite(v)) return false;
  *out = v;
  return true;
}

bool to_int(std::string_view s, long long* out) {
  if (s.empty() || s.size() > 18) return false;
  std::size_t i = (s[0] == '-' || s[0] == '+') ? 1 : 0;
  if (i == s.size()) return false;
  long long v = 0;
  for (std::size_t k = i; k < s.size(); ++k) {
    if (s[k] < '0' || s[k] > '9') return false;
    v = v * 10 + (s[k] - '0');
  }
  *out = s[0] == '-' ? -v : v;
  return true;
}

bool starts_with(std::string_view s, std::string_view prefix) {
  return s.size() >= prefix.size() && s.substr(0, prefix.size()) == prefix;
}

std::string upper(std::string_view s) {
  std::string r(s);
  for (char& c : r)
    if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 32);
  return r;
}

// Howard Hinnant's civil-calendar algorithms (public domain).
long long days_from_civil(int y, int m, int d) {
  y -= m <= 2;
  const long long era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + static_cast<long long>(doe) - 719468;
}

void civil_from_days(long long z, int* y, int* m, int* d) {
  z += 719468;
  const long long era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = static_cast<unsigned>(z - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const long long yy = static_cast<long long>(yoe) + era * 400;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  *d = static_cast<int>(doy - (153 * mp + 2) / 5 + 1);
  *m = static_cast<int>(mp < 10 ? mp + 3 : mp - 9);
  *y = static_cast<int>(yy + (*m <= 2));
}

std::string iso_datetime(int y, int mo, int d, int h, int mi, std::string_view seconds) {
  char head[40];
  std::snprintf(head, sizeof head, "%04d-%02d-%02dT%02d:%02d:", y, mo, d, h, mi);
  std::string s(head);
  const std::size_t dot = seconds.find('.');
  const std::size_t intdigits = dot == std::string_view::npos ? seconds.size() : dot;
  if (intdigits < 2) s.append(2 - intdigits, '0');
  s.append(seconds);
  return s;
}

}  // namespace odhpop::formats::detail
