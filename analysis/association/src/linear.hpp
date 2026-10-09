// Small dense linear algebra for the association gate: row-major matrices of
// at most six rows, a Cholesky factor of the innovation covariance, the
// Mahalanobis form through it and its log-determinant.
#include <array>
#include <cmath>
#include <cstddef>
#include <vector>

namespace assoc {

using Vec3 = std::array<double, 3>;
using Mat3 = std::array<std::array<double, 3>, 3>;
using Mat6 = std::array<std::array<double, 6>, 6>;

inline Vec3 sub3(const Vec3& a, const Vec3& b) { return {a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }
inline Vec3 add3(const Vec3& a, const Vec3& b) { return {a[0] + b[0], a[1] + b[1], a[2] + b[2]}; }
inline Vec3 scale3(const Vec3& a, double s) { return {a[0] * s, a[1] * s, a[2] * s}; }
inline double dot3(const Vec3& a, const Vec3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
inline double norm3(const Vec3& a) { return std::sqrt(dot3(a, a)); }
inline Vec3 cross3(const Vec3& a, const Vec3& b) {
  return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
}
inline Vec3 apply3(const Mat3& m, const Vec3& v) {
  return {m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
          m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]};
}
inline Mat3 transpose3(const Mat3& m) {
  Mat3 t{};
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) t[i][j] = m[j][i];
  return t;
}
inline Mat3 mul3(const Mat3& a, const Mat3& b) {
  Mat3 c{};
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j)
      for (int k = 0; k < 3; ++k) c[i][j] += a[i][k] * b[k][j];
  return c;
}
// Row vector times matrix: (v^T M)^T.
inline Vec3 rowTimes3(const Vec3& v, const Mat3& m) {
  return {v[0] * m[0][0] + v[1] * m[1][0] + v[2] * m[2][0], v[0] * m[0][1] + v[1] * m[1][1] + v[2] * m[2][1],
          v[0] * m[0][2] + v[1] * m[1][2] + v[2] * m[2][2]};
}

// A symmetric positive-definite n x n matrix (n <= 6) through its Cholesky
// factor L (S = L L^T). Fails when S is not positive definite.
struct Cholesky {
  std::size_t n = 0;
  std::vector<double> l;  // row-major lower triangle
  bool factor(const std::vector<double>& s, std::size_t size) {
    n = size;
    l.assign(n * n, 0.0);
    for (std::size_t j = 0; j < n; ++j) {
      double d = s[j * n + j];
      for (std::size_t k = 0; k < j; ++k) d -= l[j * n + k] * l[j * n + k];
      if (!(d > 0.0) || !std::isfinite(d)) return false;
      l[j * n + j] = std::sqrt(d);
      for (std::size_t i = j + 1; i < n; ++i) {
        double v = s[i * n + j];
        for (std::size_t k = 0; k < j; ++k) v -= l[i * n + k] * l[j * n + k];
        l[i * n + j] = v / l[j * n + j];
      }
    }
    return true;
  }
  // nu^T S^-1 nu = |L^-1 nu|^2.
  double mahalanobis(const std::vector<double>& nu) const {
    std::vector<double> y(n, 0.0);
    double sum = 0.0;
    for (std::size_t i = 0; i < n; ++i) {
      double v = nu[i];
      for (std::size_t k = 0; k < i; ++k) v -= l[i * n + k] * y[k];
      y[i] = v / l[i * n + i];
      sum += y[i] * y[i];
    }
    return sum;
  }
  double logDet() const {
    double s = 0.0;
    for (std::size_t i = 0; i < n; ++i) s += 2.0 * std::log(l[i * n + i]);
    return s;
  }
};

}  // namespace assoc
