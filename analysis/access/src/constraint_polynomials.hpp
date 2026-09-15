#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <utility>
#include <vector>

// Boundary candidates on a normalized, linearly interpolated sample segment.
// Squaring the angular equation and clearing the limb projection denominator
// can add roots. The caller must evaluate the original constraint between the
// candidates; these helpers never decide whether access is allowed.
namespace acw_polynomial {
using Vector = std::array<double, 3>;
namespace detail {
using Polynomial = std::vector<long double>;  // ascending powers
using LinearVector = std::array<std::array<long double, 2>, 3>;

inline Polynomial add(const Polynomial& a, const Polynomial& b, long double factor = 1) {
  Polynomial result(std::max(a.size(), b.size()), 0);
  for (size_t i = 0; i < a.size(); ++i) result[i] += a[i];
  for (size_t i = 0; i < b.size(); ++i) result[i] += factor * b[i];
  return result;
}

inline Polynomial multiply(const Polynomial& a, const Polynomial& b) {
  Polynomial result(a.size() + b.size() - 1, 0);
  for (size_t i = 0; i < a.size(); ++i)
    for (size_t j = 0; j < b.size(); ++j) result[i + j] += a[i] * b[j];
  return result;
}

inline Polynomial dot(const LinearVector& a, const LinearVector& b) {
  Polynomial result(3, 0);
  for (size_t i = 0; i < 3; ++i) {
    result[0] += a[i][0] * b[i][0];
    result[1] += a[i][0] * b[i][1] + a[i][1] * b[i][0];
    result[2] += a[i][1] * b[i][1];
  }
  return result;
}

inline LinearVector linear(const Vector& start, const Vector& end,
                           const std::array<long double, 3>& scale) {
  LinearVector result{};
  for (size_t i = 0; i < 3; ++i) {
    result[i][0] = static_cast<long double>(start[i]) / scale[i];
    result[i][1] = (static_cast<long double>(end[i]) - start[i]) / scale[i];
  }
  return result;
}

inline long double vectorScale(const Vector& start, const Vector& end) {
  long double scale = 0;
  for (size_t i = 0; i < 3; ++i)
    scale = std::max(scale, std::max(std::abs(static_cast<long double>(start[i])),
                                   std::abs(static_cast<long double>(end[i]))));
  return scale > 0 ? scale : 1;
}

inline long double evaluate(const Polynomial& polynomial, long double t) {
  long double result = 0;
  for (size_t i = polynomial.size(); i > 0; --i) result = result * t + polynomial[i - 1];
  return result;
}

inline void unique(std::vector<long double>& values) {
  std::sort(values.begin(), values.end());
  values.erase(std::unique(values.begin(), values.end(), [](long double a, long double b) {
    return std::abs(a - b) <= 8 * std::numeric_limits<long double>::epsilon();
  }), values.end());
}

// Derivative roots partition [0,1] into monotone pieces. Every simple root is
// bracketed on one piece; a repeated root is a zero at a derivative root.
// At most degree four is used here, so recursion and work are strictly bounded.
inline std::vector<long double> realRoots(Polynomial polynomial) {
  while (polynomial.size() > 1 && polynomial.back() == 0) polynomial.pop_back();
  long double scale = 0;
  for (long double coefficient : polynomial) scale = std::max(scale, std::abs(coefficient));
  if (!(scale > 0) || polynomial.size() < 2) return {};
  for (auto& coefficient : polynomial) coefficient /= scale;
  if (polynomial.size() == 2) {
    const long double root = -polynomial[0] / polynomial[1];
    return root >= 0 && root <= 1 ? std::vector<long double>{root} : std::vector<long double>{};
  }
  Polynomial derivative(polynomial.size() - 1);
  for (size_t i = 1; i < polynomial.size(); ++i) derivative[i - 1] = i * polynomial[i];
  auto critical = realRoots(derivative);
  std::vector<long double> points{0, 1};
  points.insert(points.end(), critical.begin(), critical.end());
  unique(points);
  long double coefficientSum = 0;
  for (long double coefficient : polynomial) coefficientSum += std::abs(coefficient);
  const long double roundoff = 64 * std::numeric_limits<long double>::epsilon() * coefficientSum;
  std::vector<long double> roots;
  for (long double point : points)
    if (std::abs(evaluate(polynomial, point)) <= roundoff) roots.push_back(point);
  for (size_t i = 1; i < points.size(); ++i) {
    long double lo = points[i - 1], hi = points[i];
    long double flo = evaluate(polynomial, lo), fhi = evaluate(polynomial, hi);
    if (!((flo < 0 && fhi > 0) || (flo > 0 && fhi < 0))) continue;
    for (int iteration = 0; iteration < 96; ++iteration) {
      const long double middle = lo + (hi - lo) / 2;
      if (middle == lo || middle == hi) break;
      const long double value = evaluate(polynomial, middle);
      if (value == 0) { lo = hi = middle; break; }
      if ((flo < 0 && value < 0) || (flo > 0 && value > 0)) {
        lo = middle;
        flo = value;
      } else {
        hi = middle;
      }
    }
    roots.push_back(lo + (hi - lo) / 2);
  }
  unique(roots);
  return roots;
}

inline std::vector<double> output(std::vector<long double> roots) {
  unique(roots);
  std::vector<double> result;
  for (long double root : roots) {
    const double value = static_cast<double>(root);
    if (std::isfinite(value) && value >= 0 && value <= 1) result.push_back(value);
  }
  result.erase(std::unique(result.begin(), result.end()), result.end());
  return result;
}
}  // namespace detail

inline std::vector<double> angularRoots(const Vector& a0, const Vector& a1,
                                        const Vector& b0, const Vector& b1, double threshold) {
  const long double aScale = detail::vectorScale(a0, a1), bScale = detail::vectorScale(b0, b1);
  const auto a = detail::linear(a0, a1, {aScale, aScale, aScale});
  const auto b = detail::linear(b0, b1, {bScale, bScale, bScale});
  const auto ab = detail::dot(a, b);
  const long double cosine = std::cos(threshold);
  const long double sine = std::sin(threshold);
  const auto magnitudeProduct = detail::multiply(detail::dot(a, a), detail::dot(b, b));
  if (std::abs(sine) < std::abs(cosine)) {
    // Near aligned/anti-aligned directions, use the cross-product form to
    // avoid subtracting two nearly equal squared dot products.
    detail::Polynomial crossSquared{0};
    for (size_t i = 0; i < 3; ++i) {
      const size_t j = (i + 1) % 3, k = (i + 2) % 3;
      const auto component = detail::add(
        detail::multiply({a[j][0], a[j][1]}, {b[k][0], b[k][1]}),
        detail::multiply({a[k][0], a[k][1]}, {b[j][0], b[j][1]}), -1);
      crossSquared = detail::add(crossSquared, detail::multiply(component, component));
    }
    return detail::output(detail::realRoots(detail::add(crossSquared, magnitudeProduct, -sine * sine)));
  }
  // (a.b)^2 - cos(theta)^2 |a|^2 |b|^2 = 0.
  return detail::output(detail::realRoots(detail::add(detail::multiply(ab, ab),
    magnitudeProduct, -cosine * cosine)));
}

inline std::vector<double> lightingRoots(const Vector& earth0, const Vector& earth1,
                                         const Vector& sun0, const Vector& sun1,
                                         double earthRadius, double sunRadius, bool penumbra) {
  const long double eScale = detail::vectorScale(earth0, earth1), sScale = detail::vectorScale(sun0, sun1);
  const auto earth = detail::linear(earth0, earth1, {eScale, eScale, eScale});
  const auto sun = detail::linear(sun0, sun1, {sScale, sScale, sScale});
  const long double r = earthRadius / eScale, s = sunRadius / sScale;
  auto es = detail::dot(earth, sun), ee = detail::dot(earth, earth), ss = detail::dot(sun, sun);
  ee[0] -= r * r;
  ss[0] -= s * s;
  // At separation asin(R/|e|) +/- asin(S/|s|), the dot product D
  // satisfies D +/- R*S = sqrt((|e|^2-R^2)(|s|^2-S^2)).
  es[0] += penumbra ? r * s : -r * s;
  return detail::output(detail::realRoots(detail::add(detail::multiply(es, es),
                                                       detail::multiply(ee, ss), -1)));
}

inline std::vector<double> maskStationaryRoots(const Vector& los0, const Vector& los1,
                                               const Vector& up, const Vector& east,
                                               const Vector& north, double slope) {
  const long double scale = detail::vectorScale(los0, los1);
  const auto los = detail::linear(los0, los1, {scale, scale, scale});
  auto project = [&](const Vector& axis) {
    detail::Polynomial result(2, 0);
    for (size_t i = 0; i < 3; ++i)
      for (size_t j = 0; j < 2; ++j) result[j] += axis[i] * los[i][j];
    return result;
  };
  const auto u = project(up), e = project(east), n = project(north);
  const auto q = detail::dot(los, los);
  const auto h = detail::add(detail::multiply(e, e), detail::multiply(n, n));
  // On a piece with constant mask slope m, g = elevation - m * azimuth.
  // Its derivative is A/(Q sqrt(H)) - m*K/H. A's quadratic term cancels
  // exactly; express the remaining coefficients directly to preserve that.
  const detail::Polynomial a{u[1] * q[0] - u[0] * q[1] / 2,
                             u[1] * q[1] / 2 - u[0] * q[2]};
  const long double mk = slope * (n[0] * e[1] - e[0] * n[1]);
  // A^2 H - (mK)^2 Q^2 = 0; squaring can add harmless partition points.
  return detail::output(detail::realRoots(detail::add(
    detail::multiply(detail::multiply(a, a), h), detail::multiply(q, q), -mk * mk)));
}

inline std::vector<double> limbRoots(const Vector& o0, const Vector& o1,
                                     const Vector& target0, const Vector& target1,
                                     double equatorialRadius, double polarRadius) {
  if (!(equatorialRadius > 0 && polarRadius > 0)) return {};
  const std::array<long double, 3> scale{equatorialRadius, equatorialRadius, polarRadius};
  const auto p = detail::linear(o0, o1, scale);
  const auto q = detail::linear(target0, target1, scale);
  auto d = q;
  for (size_t i = 0; i < 3; ++i)
    for (size_t j = 0; j < 2; ++j) d[i][j] -= p[i][j];
  auto pp = detail::dot(p, p), qq = detail::dot(q, q);
  pp[0] -= 1;
  qq[0] -= 1;
  const auto pd = detail::dot(p, d);
  // Interior closest point: (p.p-1)(d.d) - (p.d)^2 = 0.
  auto roots = detail::realRoots(detail::add(detail::multiply(pp, detail::dot(d, d)),
                                            detail::multiply(pd, pd), -1));
  // Clamping the closest point to the finite segment can put it at either
  // endpoint. Their own ellipsoid crossings are therefore also candidates.
  for (const auto& endpoint : {pp, qq}) {
    const auto endpointRoots = detail::realRoots(endpoint);
    roots.insert(roots.end(), endpointRoots.begin(), endpointRoots.end());
  }
  return detail::output(std::move(roots));
}
}  // namespace acw_polynomial
