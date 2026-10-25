// -----------------------------------------------------------------------------
// Two-body conversions: osculating elements of a state and the state of osculating elements, about a gravitational
// parameter mu (the inverse map of events.inc, the display exports).
// -----------------------------------------------------------------------------

namespace sdnap {
namespace twobody {

constexpr double kMuEarth = 398600.4418;  ///< km^3/s^2

/// Osculating elements of a state about mu: a (km; < 0 when open), e, i, node, argp, M (rad; hyperbolic M when e > 1).
inline bool elements_of(double mu, const double* r, const double* v, double* el) {
  const double h[3] = {r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]};
  const double hn = std::sqrt(h[0] * h[0] + h[1] * h[1] + h[2] * h[2]), rn = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  const double v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2], rv = r[0] * v[0] + r[1] * v[1] + r[2] * v[2];
  if (!(hn > 0.0) || !(rn > 0.0)) return false;
  const double energy = 0.5 * v2 - mu / rn;
  if (energy == 0.0) return false;  // parabolic
  const double a = -mu / (2.0 * energy), p = hn * hn / mu;
  const double inc = std::atan2(std::sqrt(h[0] * h[0] + h[1] * h[1]), h[2]);
  const double node = std::atan2(h[0], -h[1]);
  // argument of latitude from the node line (cos node, sin node, 0) and its normal in the orbit plane
  const double nx = std::cos(node), ny = std::sin(node);
  const double w[3] = {(h[1] * 0.0 - h[2] * ny) / hn, (h[2] * nx - h[0] * 0.0) / hn, (h[0] * ny - h[1] * nx) / hn};
  const double u = std::atan2(r[0] * w[0] + r[1] * w[1] + r[2] * w[2], r[0] * nx + r[1] * ny);
  const double ec = p / rn - 1.0, es = rv * hn / (mu * rn);
  const double e = std::sqrt(ec * ec + es * es), nu = std::atan2(es, ec);
  double M;
  if (e < 1.0) {
    const double E = std::atan2(std::sqrt(1.0 - e * e) * std::sin(nu), e + std::cos(nu));
    M = E - e * std::sin(E);
  } else {
    const double H = std::asinh(std::sqrt(e * e - 1.0) * std::sin(nu) / (1.0 + e * std::cos(nu)));
    M = e * std::sinh(H) - H;
  }
  el[0] = a; el[1] = e; el[2] = inc; el[3] = node; el[4] = u - nu; el[5] = M;
  return std::isfinite(a) && std::isfinite(M);
}

/// The state of osculating elements (as elements_of) about mu.
inline bool state_of(double mu, const double* el, double* r, double* v) {
  const double a = el[0], e = el[1], inc = el[2], node = el[3], argp = el[4], M = el[5];
  if (!(e >= 0.0) || e == 1.0 || (e < 1.0) != (a > 0.0)) return false;
  double cnu, snu;
  if (e < 1.0) {
    const double Mr = std::remainder(M, 2.0 * kPi);  // Danby's start, M reduced to [-pi, pi]
    double E = Mr + 0.85 * e * (std::sin(Mr) >= 0.0 ? 1.0 : -1.0);
    for (int it = 0; it < 60; ++it) {
      const double d = (E - e * std::sin(E) - Mr) / (1.0 - e * std::cos(E));
      E -= d;
      if (std::fabs(d) < 1e-15) break;
    }
    const double den = 1.0 - e * std::cos(E);
    cnu = (std::cos(E) - e) / den;
    snu = std::sqrt(1.0 - e * e) * std::sin(E) / den;
  } else {
    double H = std::asinh(M / e);
    for (int it = 0; it < 80; ++it) {
      const double d = (e * std::sinh(H) - H - M) / (e * std::cosh(H) - 1.0);
      H -= d;
      if (std::fabs(d) < 1e-15) break;
    }
    const double den = e * std::cosh(H) - 1.0;
    cnu = (e - std::cosh(H)) / den;
    snu = std::sqrt(e * e - 1.0) * std::sinh(H) / den;
  }
  const double p = a * (1.0 - e * e), rr = p / (1.0 + e * cnu), vs = std::sqrt(mu / p);
  const double xp = rr * cnu, yp = rr * snu, vxp = -vs * snu, vyp = vs * (e + cnu);
  const double cO = std::cos(node), sO = std::sin(node), ci = std::cos(inc), si = std::sin(inc), cw = std::cos(argp), sw = std::sin(argp);
  const double P[3] = {cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si};
  const double Q[3] = {-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si};
  for (int c = 0; c < 3; ++c) {
    r[c] = xp * P[c] + yp * Q[c];
    v[c] = vxp * P[c] + vyp * Q[c];
  }
  return std::isfinite(r[0]) && std::isfinite(v[0]);
}

}  // namespace twobody
}  // namespace sdnap
