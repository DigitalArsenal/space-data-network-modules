// analysis/optical-astrometry: shared vocabulary of the reduction.
// One translation unit (build.mjs): SDS headers, ERFA, the foundation/frames
// axis engine and EOP series, the estimation module's batch fit, then these
// files in order. Errors travel as flags and messages, never as exceptions
// (the WasmEdge exception trap), so every stage returns bool + an error text.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <map>
#include <numeric>
#include <string>
#include <utility>
#include <vector>

namespace oa {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 2.0 * kPi;
constexpr double kDeg = kPi / 180.0;
constexpr double kArcsec = kDeg / 3600.0;
constexpr double kSpeedOfLight = 299792458.0;            // m/s
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

struct V3 {
  double x = 0, y = 0, z = 0;
};
inline V3 operator+(V3 a, V3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline V3 operator-(V3 a, V3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline V3 operator*(V3 a, double s) { return {a.x * s, a.y * s, a.z * s}; }
inline double dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline V3 cross(V3 a, V3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
inline double norm(V3 a) { return std::sqrt(dot(a, a)); }
inline V3 unit(V3 a) {
  const double n = norm(a);
  return n > 0 ? a * (1.0 / n) : a;
}
inline V3 radec_to_unit(double ra, double dec) {
  return {std::cos(dec) * std::cos(ra), std::cos(dec) * std::sin(ra), std::sin(dec)};
}
inline void unit_to_radec(V3 u, double* ra, double* dec) {
  *ra = std::atan2(u.y, u.x);
  if (*ra < 0) *ra += kTwoPi;
  *dec = std::atan2(u.z, std::hypot(u.x, u.y));
}
// Angle between two unit vectors, stable at small separations.
inline double separation(V3 a, V3 b) { return std::atan2(norm(cross(a, b)), dot(a, b)); }

inline double median(std::vector<double> v) {
  if (v.empty()) return kNaN;
  const size_t m = v.size() / 2;
  std::nth_element(v.begin(), v.begin() + m, v.end());
  double hi = v[m];
  if (v.size() % 2) return hi;
  return 0.5 * (hi + *std::max_element(v.begin(), v.begin() + m));
}
// Median absolute deviation scaled to a Gaussian sigma.
inline double robust_sigma(const std::vector<double>& v) {
  if (v.size() < 2) return kNaN;
  const double m = median(v);
  std::vector<double> d(v.size());
  for (size_t i = 0; i < v.size(); ++i) d[i] = std::fabs(v[i] - m);
  return 1.4826 * median(d);
}
inline double quantile(std::vector<double> v, double q) {
  if (v.empty()) return kNaN;
  std::sort(v.begin(), v.end());
  const double at = q * (v.size() - 1);
  const size_t lo = static_cast<size_t>(std::floor(at));
  const size_t hi = std::min(lo + 1, v.size() - 1);
  return v[lo] + (at - lo) * (v[hi] - v[lo]);
}

// Symmetric positive (semi)definite solve by Cholesky with a pivot floor;
// returns false when the normal matrix is not positive definite.
inline bool cholesky_solve(std::vector<double> a, int n, std::vector<double>* b, std::vector<double>* inverse) {
  for (int j = 0; j < n; ++j) {
    double d = a[j * n + j];
    for (int k = 0; k < j; ++k) d -= a[j * n + k] * a[j * n + k];
    if (!(d > 0) || !std::isfinite(d)) return false;
    d = std::sqrt(d);
    a[j * n + j] = d;
    for (int i = j + 1; i < n; ++i) {
      double s = a[i * n + j];
      for (int k = 0; k < j; ++k) s -= a[i * n + k] * a[j * n + k];
      a[i * n + j] = s / d;
    }
  }
  auto solve = [&](std::vector<double>& x) {
    for (int i = 0; i < n; ++i) {
      double s = x[i];
      for (int k = 0; k < i; ++k) s -= a[i * n + k] * x[k];
      x[i] = s / a[i * n + i];
    }
    for (int i = n - 1; i >= 0; --i) {
      double s = x[i];
      for (int k = i + 1; k < n; ++k) s -= a[k * n + i] * x[k];
      x[i] = s / a[i * n + i];
    }
  };
  if (b) solve(*b);
  if (inverse) {
    inverse->assign(n * n, 0.0);
    for (int c = 0; c < n; ++c) {
      std::vector<double> e(n, 0.0);
      e[c] = 1.0;
      solve(e);
      for (int r = 0; r < n; ++r) (*inverse)[r * n + c] = e[r];
    }
  }
  return true;
}

// Calendar helpers on Unix seconds (UTC, no leap seconds inside a day).
inline bool parse_iso_utc_seconds(const std::string& text, double* unix_seconds) {
  int y = 0, mo = 0, d = 0, h = 0, mi = 0;
  double s = 0;
  if (std::sscanf(text.c_str(), "%d-%d-%dT%d:%d:%lf", &y, &mo, &d, &h, &mi, &s) != 6 &&
      std::sscanf(text.c_str(), "%d-%d-%d %d:%d:%lf", &y, &mo, &d, &h, &mi, &s) != 6)
    return false;
  // Days from civil (Howard Hinnant's algorithm), proleptic Gregorian.
  const int yy = y - (mo <= 2);
  const int era = (yy >= 0 ? yy : yy - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(yy - era * 400);
  const unsigned doy = (153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  const long days = static_cast<long>(era) * 146097 + static_cast<long>(doe) - 719468;
  *unix_seconds = days * 86400.0 + h * 3600.0 + mi * 60.0 + s;
  return true;
}
inline std::string iso_utc(double unix_seconds, int decimals = 6) {
  double whole = std::floor(unix_seconds);
  double frac = unix_seconds - whole;
  const double scale = std::pow(10.0, decimals);
  long long f = std::llround(frac * scale);
  if (f >= static_cast<long long>(scale)) { f -= static_cast<long long>(scale); whole += 1; }
  long long z = static_cast<long long>(whole) / 86400;
  long long sod = static_cast<long long>(whole) - z * 86400;
  if (sod < 0) { sod += 86400; z -= 1; }
  z += 719468;
  const long long era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = static_cast<unsigned>(z - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  long long y = static_cast<long long>(yoe) + era * 400;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  const unsigned d = doy - (153 * mp + 2) / 5 + 1;
  const unsigned m = mp < 10 ? mp + 3 : mp - 9;
  y += (m <= 2);
  char buf[64];
  if (decimals > 0)
    std::snprintf(buf, sizeof buf, "%04lld-%02u-%02uT%02lld:%02lld:%02lld.%0*lldZ", y, m, d, sod / 3600, (sod / 60) % 60,
                  sod % 60, decimals, f);
  else
    std::snprintf(buf, sizeof buf, "%04lld-%02u-%02uT%02lld:%02lld:%02lldZ", y, m, d, sod / 3600, (sod / 60) % 60, sod % 60);
  return buf;
}

}  // namespace oa
