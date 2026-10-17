// analysis/rpo-history: shared types, vectors, UTC time and the error flag.
//
// Errors are recorded and returned as `false`, never thrown: a C++ exception
// unwound inside a module left WasmEdge 0.16 looping in free().
#include <algorithm>
#include <array>
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
using Vec3 = std::array<double, 3>;
using State = std::array<double, 6>;
using Mat3 = std::array<double, 9>;  // row-major
constexpr double kMu = 398600.4418;     // km^3/s^2, Earth GM (EGM-96 / WGS 84): osculating elements
constexpr double kMuWgs72 = 398600.8;   // km^3/s^2, SGP4's WGS-72 GM: an element set's mean altitude
constexpr double kReWgs72 = 6378.135;   // km, SGP4's WGS-72 equatorial radius
constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 2.0 * kPi;
constexpr double kDeg = 180.0 / kPi;
// rad/s: the Earth rotation the ABI propagators use for TEME -> Earth-fixed.
constexpr double kEarthRate = 7.292115146706979e-5;
constexpr size_t kMaxStatesPerBlock = 400000;
constexpr size_t kMaxBlocks = 20000;
constexpr size_t kMaxSamples = 2000000;
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

const char* error = "Invalid RPO history request.";
std::string errorBuffer;
bool failWith(const std::string& message) {
  errorBuffer = message;
  error = errorBuffer.c_str();
  return false;
}
#define NEED(condition, message) do { if (!(condition)) { error = message; return false; } } while (0)

int fail(const char* message) {
  plugin_set_error("invalid-rpo-history-request", message);
  return 1;
}

Vec3 sub(const Vec3& a, const Vec3& b) { return {a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }
double dot(const Vec3& a, const Vec3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
Vec3 cross(const Vec3& a, const Vec3& b) {
  return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
}
double norm(const Vec3& a) { return std::sqrt(dot(a, a)); }
Vec3 scale(const Vec3& a, double s) { return {a[0] * s, a[1] * s, a[2] * s}; }
Vec3 unit(const Vec3& a) { return scale(a, 1.0 / norm(a)); }
Vec3 posOf(const State& s) { return {s[0], s[1], s[2]}; }
Vec3 velOf(const State& s) { return {s[3], s[4], s[5]}; }

// 3x3 helpers, row-major.
Mat3 mul(const Mat3& a, const Mat3& b) {
  Mat3 c{};
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) c[3 * i + j] = a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j];
  return c;
}
Mat3 transpose(const Mat3& a) { return {a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]}; }
Mat3 sandwich(const Mat3& j, const Mat3& c) { return mul(mul(j, c), transpose(j)); }  // J C J^T
Mat3 addM(const Mat3& a, const Mat3& b) {
  Mat3 c{};
  for (int i = 0; i < 9; ++i) c[i] = a[i] + b[i];
  return c;
}
bool invert(const Mat3& m, Mat3& out) {
  const double c00 = m[4] * m[8] - m[5] * m[7], c01 = m[5] * m[6] - m[3] * m[8], c02 = m[3] * m[7] - m[4] * m[6];
  const double det = m[0] * c00 + m[1] * c01 + m[2] * c02;
  if (!(std::fabs(det) > 0) || !std::isfinite(det)) return false;
  out = {c00 / det, (m[2] * m[7] - m[1] * m[8]) / det, (m[1] * m[5] - m[2] * m[4]) / det,
         c01 / det, (m[0] * m[8] - m[2] * m[6]) / det, (m[2] * m[3] - m[0] * m[5]) / det,
         c02 / det, (m[1] * m[6] - m[0] * m[7]) / det, (m[0] * m[4] - m[1] * m[3]) / det};
  return true;
}

// ── time: UTC seconds since 1970 (no leap-second table) ─────────────────────
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
std::string fmt(double v, const char* f = "%.6g") {
  char b[64];
  std::snprintf(b, sizeof b, f, v);
  return b;
}

double median(std::vector<double> x) {
  const size_t n = x.size();
  if (n == 0) return kNaN;
  std::nth_element(x.begin(), x.begin() + n / 2, x.end());
  double m = x[n / 2];
  if (n % 2 == 0) m = 0.5 * (m + *std::max_element(x.begin(), x.begin() + n / 2));
  return m;
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
    if (len == 0) { at += 4; continue; }  // zero-length prefix: padding
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

std::string textOf(const flatbuffers::String* s) { return s ? s->str() : std::string(); }
}  // namespace
