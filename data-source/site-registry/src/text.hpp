// Text, date and URL helpers shared by the site-registry rules.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

#include "regex.hpp"

namespace sr {

inline bool startsWith(std::string_view s, std::string_view p) { return s.size() >= p.size() && s.compare(0, p.size(), p) == 0; }
inline bool endsWith(std::string_view s, std::string_view p) { return s.size() >= p.size() && s.compare(s.size() - p.size(), p.size(), p) == 0; }

inline std::string trim(std::string_view s) {
  size_t a = 0, b = s.size();
  auto ws = [](unsigned char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; };
  while (a < b && ws(static_cast<unsigned char>(s[a]))) ++a;
  while (b > a && ws(static_cast<unsigned char>(s[b - 1]))) --b;
  return std::string(s.substr(a, b - a));
}

// Unicode-aware trim (JavaScript String.prototype.trim) on UTF-32.
inline rx::Text trim32(const rx::Text& s) {
  size_t a = 0, b = s.size();
  while (a < b && rx::isSpace(s[a])) ++a;
  while (b > a && rx::isSpace(s[b - 1])) --b;
  return s.substr(a, b - a);
}

inline std::string asciiLower(std::string s) {
  for (char& c : s) if (c >= 'A' && c <= 'Z') c = char(c + 32);
  return s;
}

// Unicode lower case (simple folding) of UTF-8 text.
inline std::string lower(std::string_view s) {
  const rx::Text t = rx::utf32(s);
  std::string out;
  out.reserve(s.size());
  for (uint32_t c : t) rx::appendUtf8(out, rx::fold(c));
  return out;
}

inline std::vector<std::string> split(std::string_view s, char sep) {
  std::vector<std::string> out;
  size_t start = 0;
  for (size_t i = 0; i <= s.size(); ++i) {
    if (i == s.size() || s[i] == sep) { out.emplace_back(s.substr(start, i - start)); start = i + 1; }
  }
  return out;
}

inline std::string join(const std::vector<std::string>& parts, std::string_view sep) {
  std::string out;
  for (size_t i = 0; i < parts.size(); ++i) { if (i) out += sep; out += parts[i]; }
  return out;
}

inline std::string replaceAll(std::string s, std::string_view from, std::string_view to) {
  if (from.empty()) return s;
  size_t at = 0;
  while ((at = s.find(from, at)) != std::string::npos) { s.replace(at, from.size(), to); at += to.size(); }
  return s;
}

inline std::string pad2(int n) { char b[8]; std::snprintf(b, sizeof b, "%02d", n); return b; }

// ── ISO 8601 dates at a source's precision ───────────────────────────────
inline int precision(const std::string& date) { return date.empty() ? 0 : int(std::count(date.begin(), date.end(), '-')) + 1; }

// Two dates compared at their common precision ("1976" equals "1976-07-27").
inline int compareDates(const std::string& a, const std::string& b) {
  const int common = std::min(precision(a), precision(b));
  auto cut = [&](const std::string& d) {
    if (common == 0) return std::string();
    size_t at = 0;
    for (int k = 0; k < common; ++k) {
      at = d.find('-', at);
      if (at == std::string::npos) return d;
      if (k + 1 < common) ++at;
    }
    return d.substr(0, at);
  };
  const std::string x = cut(a), y = cut(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// A Wikidata time value ("+1978-02-22T00:00:00Z", precision 9/10/11) -> ISO 8601 at its precision.
inline std::string wikidataDate(const std::string& time, int prec) {
  if (time.size() < 11 || (time[0] != '+' && time[0] != '-') || time[0] == '-') return "";
  size_t dash = time.find('-', 1);
  if (dash == std::string::npos || dash + 6 > time.size()) return "";
  std::string year = time.substr(1, dash - 1);
  while (year.size() < 4) year = "0" + year;
  year = year.substr(year.size() - 4);
  const std::string month = time.substr(dash + 1, 2), day = time.substr(dash + 4, 2);
  if (prec >= 11 && day != "00") return year + "-" + month + "-" + day;
  if (prec >= 10 && month != "00") return year + "-" + month;
  return prec >= 9 ? year : "";
}

// ── names ────────────────────────────────────────────────────────────────
// The base letter of a precomposed Latin letter (its NFKD decomposition minus
// combining marks), 0 when it has none.
inline uint32_t latinBase(uint32_t c) {
  static const char* latin1 = "AAAAAA\0CEEEEIIII\0NOOOOO\0\0UUUUY\0\0aaaaaa\0ceeeeiiii\0nooooo\0\0uuuuy\0y";  // U+00C0..U+00FF
  if (c >= 0xC0 && c <= 0xFF) { const char b = latin1[c - 0xC0]; return b ? uint32_t(b) : 0; }
  struct R { uint32_t lo, hi; char upper; };
  static const R ext[] = {
      {0x100, 0x105, 'a'}, {0x106, 0x10D, 'c'}, {0x10E, 0x10F, 'd'}, {0x112, 0x11B, 'e'}, {0x11C, 0x123, 'g'}, {0x124, 0x125, 'h'},
      {0x128, 0x130, 'i'}, {0x134, 0x135, 'j'}, {0x136, 0x137, 'k'}, {0x139, 0x13E, 'l'}, {0x143, 0x148, 'n'}, {0x14C, 0x151, 'o'},
      {0x154, 0x159, 'r'}, {0x15A, 0x161, 's'}, {0x162, 0x165, 't'}, {0x168, 0x173, 'u'}, {0x174, 0x175, 'w'}, {0x176, 0x178, 'y'},
      {0x179, 0x17E, 'z'}, {0x17F, 0x17F, 's'}, {0x1A0, 0x1A1, 'o'}, {0x1AF, 0x1B0, 'u'}, {0x1CD, 0x1CE, 'a'}, {0x1CF, 0x1D0, 'i'},
      {0x1D1, 0x1D2, 'o'}, {0x1D3, 0x1DC, 'u'}, {0x1E6, 0x1E7, 'g'}, {0x1E8, 0x1E9, 'k'}, {0x1EA, 0x1ED, 'o'}, {0x1F4, 0x1F5, 'g'},
      {0x1F8, 0x1F9, 'n'}, {0x1FA, 0x1FB, 'a'}, {0x200, 0x203, 'a'}, {0x204, 0x207, 'e'}, {0x208, 0x20B, 'i'}, {0x20C, 0x20F, 'o'},
      {0x210, 0x213, 'r'}, {0x214, 0x217, 'u'}, {0x218, 0x219, 's'}, {0x21A, 0x21B, 't'}, {0x21E, 0x21F, 'h'}, {0x226, 0x227, 'a'},
      {0x228, 0x229, 'e'}, {0x22A, 0x231, 'o'}, {0x232, 0x233, 'y'},
  };
  for (const auto& r : ext) if (c >= r.lo && c <= r.hi) return uint32_t(r.upper);
  if (c >= 0x1E00 && c <= 0x1EFF) {
    static const struct { uint32_t lo, hi; char b; } add[] = {
        {0x1E00, 0x1E01, 'a'}, {0x1E02, 0x1E07, 'b'}, {0x1E08, 0x1E09, 'c'}, {0x1E0A, 0x1E13, 'd'}, {0x1E14, 0x1E1D, 'e'}, {0x1E1E, 0x1E1F, 'f'},
        {0x1E20, 0x1E21, 'g'}, {0x1E22, 0x1E2B, 'h'}, {0x1E2C, 0x1E2F, 'i'}, {0x1E30, 0x1E35, 'k'}, {0x1E36, 0x1E3D, 'l'}, {0x1E3E, 0x1E43, 'm'},
        {0x1E44, 0x1E4B, 'n'}, {0x1E4C, 0x1E53, 'o'}, {0x1E54, 0x1E57, 'p'}, {0x1E58, 0x1E5F, 'r'}, {0x1E60, 0x1E69, 's'}, {0x1E6A, 0x1E71, 't'},
        {0x1E72, 0x1E7B, 'u'}, {0x1E7C, 0x1E7F, 'v'}, {0x1E80, 0x1E89, 'w'}, {0x1E8A, 0x1E8D, 'x'}, {0x1E8E, 0x1E8F, 'y'}, {0x1E90, 0x1E95, 'z'},
        {0x1E96, 0x1E96, 'h'}, {0x1E97, 0x1E97, 't'}, {0x1E98, 0x1E98, 'w'}, {0x1E99, 0x1E99, 'y'}, {0x1EA0, 0x1EB7, 'a'}, {0x1EB8, 0x1EC7, 'e'},
        {0x1EC8, 0x1ECB, 'i'}, {0x1ECC, 0x1EE3, 'o'}, {0x1EE4, 0x1EF1, 'u'}, {0x1EF2, 0x1EF9, 'y'},
    };
    for (const auto& r : add) if (c >= r.lo && c <= r.hi) return uint32_t(r.b);
  }
  return 0;
}

// The words of a name, NFKD-folded to ASCII lower case ("Kernkraftwerk Grafenrheinfeld"
// -> {"kernkraftwerk","grafenrheinfeld"}); "ß" reads "ss"; other scripts drop out,
// as name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
// .replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, " ") does.
inline std::vector<std::string> foldedWords(std::string_view name) {
  const rx::Text t = rx::utf32(name);
  std::string flat;
  for (uint32_t c : t) {
    if (c >= 0x300 && c <= 0x36F) continue;
    uint32_t b = c;
    if (c >= 0x80) {
      if (c == 0xDF || c == 0x1E9E) { flat += "ss"; continue; }
      if (c == 0x132 || c == 0x133) { flat += "ij"; continue; }
      if (c >= 0xFF10 && c <= 0xFF19) { flat += char('0' + (c - 0xFF10)); continue; }
      if (c >= 0xFF21 && c <= 0xFF3A) { flat += char('a' + (c - 0xFF21)); continue; }
      if (c >= 0xFF41 && c <= 0xFF5A) { flat += char('a' + (c - 0xFF41)); continue; }
      b = latinBase(c);
      if (!b) { flat += ' '; continue; }
    }
    if (b >= 'A' && b <= 'Z') b += 32;
    flat += (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9') ? char(b) : ' ';
  }
  std::vector<std::string> words;
  for (auto& w : split(flat, ' ')) if (!w.empty()) words.push_back(w);
  return words;
}

// A URL-safe slug of a name ("Rocky Mountain Laboratories" -> "rocky-mountain-laboratories").
inline std::string slug(std::string_view name) {
  return join(foldedWords(name), "-");
}

// ── URLs and bytes ────────────────────────────────────────────────────────
// encodeURIComponent.
inline std::string encodeComponent(std::string_view s) {
  static const char* hex = "0123456789ABCDEF";
  std::string out;
  for (unsigned char c : s) {
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || std::strchr("-_.!~*'()", c)) out += char(c);
    else { out += '%'; out += hex[c >> 4]; out += hex[c & 15]; }
  }
  return out;
}
// application/x-www-form-urlencoded (URLSearchParams).
inline std::string encodeForm(std::string_view s) {
  static const char* hex = "0123456789ABCDEF";
  std::string out;
  for (unsigned char c : s) {
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || std::strchr("*-._", c)) out += char(c);
    else if (c == ' ') out += '+';
    else { out += '%'; out += hex[c >> 4]; out += hex[c & 15]; }
  }
  return out;
}
// A wiki page URL ("https://de.wikipedia.org/wiki/Forschungsreaktor_Karlstein").
inline std::string wikiUrl(std::string_view lang, std::string_view title) {
  std::string t = replaceAll(std::string(title), " ", "_");
  std::string enc;
  static const char* hex = "0123456789ABCDEF";
  for (unsigned char c : t) {
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || std::strchr("-_.!~*'():,/", c)) enc += char(c);
    else { enc += '%'; enc += hex[c >> 4]; enc += hex[c & 15]; }
  }
  return "https://" + std::string(lang) + ".wikipedia.org/wiki/" + enc;
}

inline std::string base64(const uint8_t* p, size_t n) {
  static const char* t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string s;
  s.reserve((n + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 2 < n; i += 3) {
    const uint32_t v = uint32_t(p[i]) << 16 | uint32_t(p[i + 1]) << 8 | p[i + 2];
    s += t[v >> 18]; s += t[(v >> 12) & 63]; s += t[(v >> 6) & 63]; s += t[v & 63];
  }
  if (i + 1 == n) { const uint32_t v = uint32_t(p[i]) << 16; s += t[v >> 18]; s += t[(v >> 12) & 63]; s += "=="; }
  else if (i + 2 == n) { const uint32_t v = uint32_t(p[i]) << 16 | uint32_t(p[i + 1]) << 8; s += t[v >> 18]; s += t[(v >> 12) & 63]; s += t[(v >> 6) & 63]; s += '='; }
  return s;
}

// RFC 3339 UTC from milliseconds since the epoch, to the second.
inline std::string rfc3339(int64_t ms) {
  int64_t secs = ms / 1000;
  int64_t days = secs / 86400;
  int64_t rem = secs % 86400;
  if (rem < 0) { rem += 86400; --days; }
  // civil from days (Howard Hinnant)
  days += 719468;
  const int64_t era = (days >= 0 ? days : days - 146096) / 146097;
  const int64_t doe = days - era * 146097;
  const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  int64_t y = yoe + era * 400;
  const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const int64_t mp = (5 * doy + 2) / 153;
  const int64_t d = doy - (153 * mp + 2) / 5 + 1;
  const int64_t m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) ++y;
  char b[32];
  std::snprintf(b, sizeof b, "%04lld-%02lld-%02lldT%02lld:%02lld:%02lldZ", (long long)y, (long long)m, (long long)d, (long long)(rem / 3600),
                (long long)(rem % 3600 / 60), (long long)(rem % 60));
  return b;
}

inline double kmBetween(double lat1, double lon1, double lat2, double lon2) {
  const double dLat = (lat1 - lat2) * 111.32;
  const double dLon = (lon1 - lon2) * 111.32 * std::cos(lat1 * M_PI / 180.0);
  return std::hypot(dLat, dLon);
}

}  // namespace sr
