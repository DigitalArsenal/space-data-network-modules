// analysis/maneuver-detection: shared types, vectors, time, robust statistics
// and the error flag.
//
// Errors are recorded and returned as `false`, never thrown: a C++ exception
// unwound inside a module left WasmEdge 0.16 looping in free(). nlohmann::json
// is compiled with JSON_NOEXCEPTION, and every JSON access checks its type.
#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <map>
#include <string>
#include <utility>
#include <vector>

namespace {
using Json = nlohmann::json;
using Vec3 = std::array<double, 3>;
using State = std::array<double, 6>;
constexpr double kMu = 398600.4418;   // km^3/s^2, Earth GM (EGM-96 / WGS 84)
constexpr double kRe = 6378.137;      // km, WGS 84 equatorial radius (apogee/perigee altitudes)
constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 2.0 * kPi;
constexpr double kDeg = 180.0 / kPi;
// rad/s: the Earth rotation the ABI propagators use for TEME -> Earth-fixed
// (propagator/sgp4, propagator/keplerian-reference).
constexpr double kEarthRate = 7.292115146706979e-5;
constexpr size_t kMaxStatesPerBlock = 400000;
constexpr size_t kMaxBlocks = 200000;
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

const char* error = "Invalid maneuver detection request.";
std::string errorBuffer;
bool failWith(const std::string& message) {
  errorBuffer = message;
  error = errorBuffer.c_str();
  return false;
}
#define NEED(condition, message) do { if (!(condition)) { error = message; return false; } } while (0)

int fail(const char* message) {
  plugin_set_error("invalid-maneuver-detection-request", message);
  return 1;
}

Vec3 sub(const Vec3& a, const Vec3& b) { return {a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }
Vec3 add(const Vec3& a, const Vec3& b) { return {a[0] + b[0], a[1] + b[1], a[2] + b[2]}; }
double dot(const Vec3& a, const Vec3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
Vec3 cross(const Vec3& a, const Vec3& b) {
  return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
}
double norm(const Vec3& a) { return std::sqrt(dot(a, a)); }
Vec3 scale(const Vec3& a, double s) { return {a[0] * s, a[1] * s, a[2] * s}; }
Vec3 unit(const Vec3& a) { return scale(a, 1.0 / norm(a)); }
double smaOf(const Vec3& r, const Vec3& v) { return 1.0 / (2.0 / norm(r) - dot(v, v) / kMu); }

// ── time: UTC seconds since 1970 (no leap-second table; an interval that
// straddles a leap second is off by one second at most) ────────────────────
int64_t daysFromCivil(int64_t y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + static_cast<int64_t>(doe) - 719468;
}
void civilFromDays(int64_t z, int64_t& y, unsigned& m, unsigned& d) {
  z += 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = static_cast<unsigned>(z - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  y = static_cast<int64_t>(yoe) + era * 400;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  d = doy - (153 * mp + 2) / 5 + 1;
  m = mp < 10 ? mp + 3 : mp - 9;
  y += m <= 2;
}
// "YYYY-MM-DDTHH:MM:SS[.f...][Z]"
bool parseIso(const char* text, double& out) {
  if (!text) return false;
  int y, mo, d, h, mi, used = 0;
  double s;
  if (std::sscanf(text, "%4d-%2d-%2dT%2d:%2d:%lf%n", &y, &mo, &d, &h, &mi, &s, &used) != 6) return false;
  const char* rest = text + used;
  if (!(*rest == 0 || (rest[0] == 'Z' && rest[1] == 0))) return false;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || !(s >= 0 && s < 61)) return false;
  out = double(daysFromCivil(y, mo, d)) * 86400.0 + h * 3600.0 + mi * 60.0 + s;
  return true;
}
bool parseIso(const flatbuffers::String* text, double& out) { return text && parseIso(text->c_str(), out); }
std::string isoMs(double t) {
  const double rounded = std::round(t * 1000.0) / 1000.0;
  int64_t whole = static_cast<int64_t>(std::floor(rounded));
  int ms = static_cast<int>(std::llround((rounded - double(whole)) * 1000.0));
  if (ms == 1000) { ++whole; ms = 0; }
  const int64_t day = whole >= 0 ? whole / 86400 : (whole - 86399) / 86400;
  const int64_t rem = whole - day * 86400;
  int64_t y; unsigned m, d;
  civilFromDays(day, y, m, d);
  char buffer[40];
  std::snprintf(buffer, sizeof buffer, "%04lld-%02u-%02uT%02lld:%02lld:%02lld.%03dZ", static_cast<long long>(y), m, d,
    static_cast<long long>(rem / 3600), static_cast<long long>(rem % 3600 / 60), static_cast<long long>(rem % 60), ms);
  return buffer;
}

// ── robust statistics ────────────────────────────────────────────────────
double median(std::vector<double> x) {
  const size_t n = x.size();
  if (n == 0) return kNaN;
  std::nth_element(x.begin(), x.begin() + n / 2, x.end());
  double m = x[n / 2];
  if (n % 2 == 0) m = 0.5 * (m + *std::max_element(x.begin(), x.begin() + n / 2));
  return m;
}
// The p-quantile (0..1) by the nearest-rank rule on the sorted values.
double quantile(std::vector<double> x, double p) {
  if (x.empty()) return kNaN;
  std::sort(x.begin(), x.end());
  const size_t k = std::min(x.size() - 1, size_t(std::floor(p * double(x.size()))));
  return x[k];
}
// Median and 1.4826 * MAD of x[i-w .. i+w].
void robust(const std::vector<double>& x, size_t i, int w, double& m, double& s) {
  const size_t lo = i >= size_t(w) ? i - w : 0, hi = std::min(x.size(), i + w + 1);
  std::vector<double> window(x.begin() + lo, x.begin() + hi);
  m = median(window);
  for (double& v : window) v = std::fabs(v - m);
  s = 1.4826 * median(window);
}

// Chi-square survival functions for 1 and 3 degrees of freedom.
double chi2Tail1(double x) { return std::erfc(std::sqrt(std::max(0.0, x) / 2.0)); }
double chi2Tail3(double x) {
  x = std::max(0.0, x);
  return std::erfc(std::sqrt(x / 2.0)) + std::sqrt(2.0 * x / kPi) * std::exp(-x / 2.0);
}
// The three-degree-of-freedom threshold with the tail probability of h^2 at one.
double chi2Threshold3(double h2) {
  const double p = chi2Tail1(h2);
  double lo = h2, hi = h2 + 200.0;
  for (int k = 0; k < 200; ++k) {
    const double mid = 0.5 * (lo + hi);
    if (chi2Tail3(mid) > p) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// Wilson score interval (95 %) of k successes in n.
void wilson(size_t k, size_t n, double& lo, double& hi) {
  if (n == 0) { lo = hi = kNaN; return; }
  const double z = 1.959963984540054, p = double(k) / double(n), nn = double(n);
  const double denom = 1.0 + z * z / nn;
  const double centre = (p + z * z / (2 * nn)) / denom;
  const double half = z * std::sqrt(p * (1 - p) / nn + z * z / (4 * nn * nn)) / denom;
  lo = std::max(0.0, centre - half);
  hi = std::min(1.0, centre + half);
}

// ── JSON options ─────────────────────────────────────────────────────────
bool readNumber(const Json& v, const char* key, double lo, double hi, double& out) {
  if (!v.is_number()) return failWith(std::string(key) + " must be a number.");
  const double x = v.get<double>();
  if (!std::isfinite(x) || x < lo || x > hi)
    return failWith(std::string(key) + " must be from " + std::to_string(lo) + " to " + std::to_string(hi) + ".");
  out = x;
  return true;
}
bool readInteger(const Json& v, const char* key, int lo, int hi, int& out) {
  double x;
  if (!readNumber(v, key, lo, hi, x)) return false;
  if (x != std::floor(x)) return failWith(std::string(key) + " must be an integer.");
  out = int(x);
  return true;
}

// Size-prefixed or plain FlatBuffers of one identifier in one frame payload:
// every root, verified, in order.
template <typename Root>
bool forEachRecord(const uint8_t* bytes, size_t length, const char* ident,
                   bool (*verify)(flatbuffers::Verifier&), bool (*verifyPrefixed)(flatbuffers::Verifier&),
                   const Root* (*get)(const void*), const Root* (*getPrefixed)(const void*),
                   std::vector<const Root*>& out, const char* what) {
  flatbuffers::Verifier::Options vo;
  vo.max_depth = 128;
  vo.max_tables = 50000000;
  if (length >= 8 && flatbuffers::BufferHasIdentifier(bytes, ident, false) &&
      !flatbuffers::BufferHasIdentifier(bytes, ident, true)) {
    flatbuffers::Verifier verifier(bytes, length, vo);
    if (!verify(verifier)) return failWith(std::string("A ") + what + " frame is not a valid " + ident + " FlatBuffer.");
    out.push_back(get(bytes));
    return true;
  }
  size_t at = 0;
  while (at < length) {
    if (length - at < 8) return failWith(std::string("A ") + what + " frame ends in a truncated record.");
    const uint32_t len = flatbuffers::ReadScalar<uint32_t>(bytes + at);
    if (len > length - at - 4) return failWith(std::string("A ") + what + " frame ends in a truncated record.");
    const uint8_t* rec = bytes + at;
    flatbuffers::Verifier verifier(rec, size_t(len) + 4, vo);
    if (!flatbuffers::BufferHasIdentifier(rec, ident, true) || !verifyPrefixed(verifier))
      return failWith(std::string("A ") + what + " frame holds a record that is not a valid size-prefixed " + ident + " FlatBuffer.");
    out.push_back(getPrefixed(rec));
    at += 4 + size_t(len);
  }
  return true;
}
}  // namespace
