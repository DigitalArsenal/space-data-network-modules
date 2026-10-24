#include "relative_nav.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace sdn::estimation {
namespace relnav {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 2.0 * kPi;
// Circular-chief models (HCW, SS-J2) refuse a chief above this eccentricity
// rather than silently applying a circular model to an eccentric orbit.
constexpr double kCircularChiefEccentricityLimit = 0.05;
constexpr double kEccentricChiefEccentricityLimit = 0.95;
// Below this eccentricity the osculating true anomaly of a perturbed chief is
// not smooth (the perigee direction is ill-defined), so the end-of-interval
// phase comes from Kepler's equation instead of the observation's reference.
constexpr double kReliableAnomalyEccentricity = 0.02;
// True-anomaly step of the Tschauner-Hempel integration (RK4).
constexpr double kIntegrationStep = 0.002;
constexpr double kMaximumIntegrationSteps = 1.0e6;

inline double& at(Matrix6& m, int row, int column) { return m[6 * row + column]; }
inline double at(const Matrix6& m, int row, int column) { return m[6 * row + column]; }

Matrix6 multiply(const Matrix6& a, const Matrix6& b) {
  Matrix6 out{};
  for (int i = 0; i < 6; ++i)
    for (int k = 0; k < 6; ++k) {
      const double aik = at(a, i, k);
      if (aik == 0.0) continue;
      for (int j = 0; j < 6; ++j) at(out, i, j) += aik * at(b, k, j);
    }
  return out;
}

Matrix6 transpose(const Matrix6& a) {
  Matrix6 out{};
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < 6; ++j) at(out, j, i) = at(a, i, j);
  return out;
}

Matrix6 sum(const Matrix6& a, const Matrix6& b) {
  Matrix6 out{};
  for (int i = 0; i < 36; ++i) out[i] = a[i] + b[i];
  return out;
}

Matrix6 symmetrize(const Matrix6& a) {
  Matrix6 out = a;
  for (int i = 0; i < 6; ++i)
    for (int j = i + 1; j < 6; ++j) {
      const double v = 0.5 * (at(a, i, j) + at(a, j, i));
      at(out, i, j) = v;
      at(out, j, i) = v;
    }
  return out;
}

Vector6 times(const Matrix6& a, const Vector6& x) {
  Vector6 out{};
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < 6; ++j) out[i] += at(a, i, j) * x[j];
  return out;
}

template <typename T, std::size_t N>
bool all_finite(const std::array<T, N>& values) {
  for (const T& v : values)
    if (!std::isfinite(v)) return false;
  return true;
}

double wrap_two_pi(double x) {
  x = std::fmod(x, kTwoPi);
  return x < 0.0 ? x + kTwoPi : x;
}

// Mean anomaly of a true anomaly in [0, 2 pi).
double mean_anomaly(double e, double nu) {
  const double half = 0.5 * nu;
  const double eccentric = 2.0 * std::atan2(std::sqrt(1.0 - e) * std::sin(half), std::sqrt(1.0 + e) * std::cos(half));
  return eccentric - e * std::sin(eccentric);
}

// True anomaly after the mean anomaly advances by `delta_mean` from `nu0`.
double advance_true_anomaly(double e, double nu0, double delta_mean) {
  const double target = mean_anomaly(e, wrap_two_pi(nu0)) + delta_mean;
  double eccentric = target;
  for (int i = 0; i < 50; ++i) {
    const double step = (eccentric - e * std::sin(eccentric) - target) / (1.0 - e * std::cos(eccentric));
    eccentric -= step;
    if (std::abs(step) < 1.0e-15) break;
  }
  return 2.0 * std::atan2(std::sqrt(1.0 + e) * std::sin(0.5 * eccentric), std::sqrt(1.0 - e) * std::cos(0.5 * eccentric));
}

// ---- Constant-coefficient family (HCW and SS-J2) -------------------------
//
// In-plane: xdd = (w2 - 4 a^2 + 4 a^2 ... ) written in its integrated form
//   ydot = ydot0 - 2 a (x - x0),  xdd + w^2 x = 2 a ydot0 + 4 a^2 x0,
// cross-track: zdd = -q^2 z. HCW: a = w = q = n. SS-J2: a = n c,
// w = n sqrt(2 - c^2), q = n c + (3/2) J2 n (Re/r)^2 cos^2 i.
Matrix6 constant_coefficient_transition(double a, double w, double q, double dt) {
  const double sw = std::sin(w * dt), cw = std::cos(w * dt);
  const double sq = std::sin(q * dt), cq = std::cos(q * dt);
  const double g = 4.0 * a * a / (w * w);
  const double f = 1.0 - g;
  const double b = 2.0 * a / (w * w);
  Matrix6 m{};
  at(m, 0, 0) = g + f * cw;
  at(m, 0, 3) = sw / w;
  at(m, 0, 4) = b * (1.0 - cw);
  at(m, 1, 0) = 2.0 * a * f * (dt - sw / w);
  at(m, 1, 1) = 1.0;
  at(m, 1, 3) = -b * (1.0 - cw);
  at(m, 1, 4) = f * dt + g * sw / w;
  at(m, 2, 2) = cq;
  at(m, 2, 5) = sq / q;
  at(m, 3, 0) = -w * f * sw;
  at(m, 3, 3) = cw;
  at(m, 3, 4) = 2.0 * a * sw / w;
  at(m, 4, 0) = -2.0 * a * f * (cw - 1.0);
  at(m, 4, 3) = -2.0 * a * sw / w;
  at(m, 4, 4) = 1.0 - g * (1.0 - cw);
  at(m, 5, 2) = -q * sq;
  at(m, 5, 5) = cq;
  return m;
}

// ---- Eccentric chief (TH, YA) --------------------------------------------
//
// With rho = 1 + e cos(nu), normalized variables w = rho * (position) and
// their derivatives with respect to the true anomaly (primes) satisfy
//   x'' = 3 x / rho + 2 y',  y'' = -2 x',  z'' = -z.
// The dimensional state follows from w by the block map T(nu):
//   position = w_position / rho,
//   velocity = k e sin(nu) w_position + k rho w_velocity,  k = sqrt(mu / p^3).
struct Eccentric {
  double e{0.0}, k{0.0}, nu0{0.0}, nu1{0.0}, delta_nu{0.0}, delta_j{0.0};
};

bool eccentric_geometry(const RelativeConstants& constants, const ChiefReference& from,
                        const ChiefReference& to, double dt, Eccentric* g, std::string* error) {
  const double e = from.eccentricity, a = from.semi_major_axis_m;
  if (!(a > 0.0) || !(e >= 0.0) || e > kEccentricChiefEccentricityLimit ||
      !std::isfinite(from.true_anomaly_rad) || !std::isfinite(to.true_anomaly_rad)) {
    *error = "eccentric-chief models need a positive semi-major axis, an eccentricity in [0, 0.95] and finite true anomalies";
    return false;
  }
  const double mu = constants.gravitational_parameter_m3_s2;
  const double p = a * (1.0 - e * e);
  const double n = std::sqrt(mu / (a * a * a));
  g->e = e;
  g->k = std::sqrt(mu / (p * p * p));
  g->nu0 = wrap_two_pi(from.true_anomaly_rad);
  g->nu1 = wrap_two_pi(e < kReliableAnomalyEccentricity ? advance_true_anomaly(e, g->nu0, n * dt)
                                                         : to.true_anomaly_rad);
  double delta_mean = mean_anomaly(e, g->nu1) - mean_anomaly(e, g->nu0);
  if (delta_mean < 0.0) delta_mean += kTwoPi;
  double delta_nu = g->nu1 - g->nu0;
  if (delta_nu < 0.0) delta_nu += kTwoPi;
  // Whole revolutions from the elapsed time (the references fix only the
  // phase of each epoch).
  const double revolutions = std::round((n * dt - delta_mean) / kTwoPi);
  delta_mean += kTwoPi * revolutions;
  g->delta_nu = delta_nu + kTwoPi * revolutions;
  g->delta_j = delta_mean / std::pow(1.0 - e * e, 1.5);
  return true;
}

Matrix6 block_map(double e, double k, double nu, bool inverse) {
  const double rho = 1.0 + e * std::cos(nu), es = e * std::sin(nu);
  Matrix6 t{};
  for (int i = 0; i < 3; ++i) {
    if (!inverse) {
      at(t, i, i) = 1.0 / rho;
      at(t, i + 3, i) = k * es;
      at(t, i + 3, i + 3) = k * rho;
    } else {
      at(t, i, i) = rho;
      at(t, i + 3, i) = -es;
      at(t, i + 3, i + 3) = 1.0 / (k * rho);
    }
  }
  return t;
}

// The four in-plane fundamental solutions (columns) of the normalized
// equations: A = (s, (1 + rho) cos nu), B = (0, 1), C = (c, -(1 + rho) sin nu),
// D = (2 - 3 e s J, -3 rho^2 J) with s = rho sin nu, c = rho cos nu and
// J = integral of d nu / rho^2. Rows: x, y, x', y'.
void fundamental_in_plane(double e, double nu, double j, double f[4][4]) {
  const double cn = std::cos(nu), sn = std::sin(nu);
  const double rho = 1.0 + e * cn, s = rho * sn, c = rho * cn;
  const double s_prime = cn + e * std::cos(2.0 * nu);
  const double c_prime = -(sn + e * std::sin(2.0 * nu));
  const double col[4][4] = {
      {s, 0.0, c, 2.0 - 3.0 * e * s * j},
      {(2.0 + e * cn) * cn, 1.0, -(2.0 + e * cn) * sn, -3.0 * rho * rho * j},
      {s_prime, 0.0, c_prime, -3.0 * e * s_prime * j - 3.0 * e * s / (rho * rho)},
      {-2.0 * s, 0.0, -2.0 * c + e, 6.0 * e * s * j - 3.0}};
  for (int i = 0; i < 4; ++i)
    for (int k = 0; k < 4; ++k) f[i][k] = col[i][k];
}

bool invert4(const double in[4][4], double out[4][4]) {
  double m[4][8] = {};
  for (int i = 0; i < 4; ++i) {
    for (int j = 0; j < 4; ++j) m[i][j] = in[i][j];
    m[i][i + 4] = 1.0;
  }
  for (int pivot = 0; pivot < 4; ++pivot) {
    int best = pivot;
    for (int r = pivot + 1; r < 4; ++r)
      if (std::abs(m[r][pivot]) > std::abs(m[best][pivot])) best = r;
    if (std::abs(m[best][pivot]) < 1.0e-14) return false;
    if (best != pivot)
      for (int c = 0; c < 8; ++c) std::swap(m[pivot][c], m[best][c]);
    const double d = m[pivot][pivot];
    for (int c = 0; c < 8; ++c) m[pivot][c] /= d;
    for (int r = 0; r < 4; ++r) {
      if (r == pivot) continue;
      const double factor = m[r][pivot];
      for (int c = 0; c < 8; ++c) m[r][c] -= factor * m[pivot][c];
    }
  }
  for (int i = 0; i < 4; ++i)
    for (int j = 0; j < 4; ++j) out[i][j] = m[i][j + 4];
  return true;
}

bool yamanaka_ankersen_normalized(const Eccentric& g, Matrix6* out) {
  double f1[4][4], f0[4][4], inverse[4][4];
  fundamental_in_plane(g.e, g.nu1, g.delta_j, f1);
  fundamental_in_plane(g.e, g.nu0, 0.0, f0);
  Matrix6 psi{};
  if (!invert4(f0, inverse)) return false;
  const int plane[4] = {0, 1, 3, 4};
  for (int r = 0; r < 4; ++r)
    for (int c = 0; c < 4; ++c) {
      double v = 0.0;
      for (int m = 0; m < 4; ++m) v += f1[r][m] * inverse[m][c];
      at(psi, plane[r], plane[c]) = v;
    }
  const double cd = std::cos(g.delta_nu), sd = std::sin(g.delta_nu);
  at(psi, 2, 2) = cd;
  at(psi, 2, 5) = sd;
  at(psi, 5, 2) = -sd;
  at(psi, 5, 5) = cd;
  *out = psi;
  return true;
}

// d(w)/d(nu) = A(nu) w for w = [x, y, z, x', y', z'].
Matrix6 tschauner_hempel_generator(double e, double nu) {
  const double rho = 1.0 + e * std::cos(nu);
  Matrix6 a{};
  at(a, 0, 3) = at(a, 1, 4) = at(a, 2, 5) = 1.0;
  at(a, 3, 0) = 3.0 / rho;
  at(a, 3, 4) = 2.0;
  at(a, 4, 3) = -2.0;
  at(a, 5, 2) = -1.0;
  return a;
}

bool tschauner_hempel_normalized(const Eccentric& g, Matrix6* psi, std::string* error) {
  const double steps_real = std::ceil(std::abs(g.delta_nu) / kIntegrationStep);
  if (!(steps_real < kMaximumIntegrationSteps)) {
    *error = "the Tschauner-Hempel integration would exceed its step budget; shorten the interval";
    return false;
  }
  const int steps = std::max(1, static_cast<int>(steps_real));
  const double h = g.delta_nu / steps;
  Matrix6 m{};
  for (int i = 0; i < 6; ++i) at(m, i, i) = 1.0;
  double nu = g.nu0;
  auto scaled = [](const Matrix6& a, double s) {
    Matrix6 r{};
    for (int i = 0; i < 36; ++i) r[i] = a[i] * s;
    return r;
  };
  for (int step = 0; step < steps; ++step) {
    const Matrix6 k1 = multiply(tschauner_hempel_generator(g.e, nu), m);
    const Matrix6 k2 = multiply(tschauner_hempel_generator(g.e, nu + 0.5 * h), sum(m, scaled(k1, 0.5 * h)));
    const Matrix6 k3 = multiply(tschauner_hempel_generator(g.e, nu + 0.5 * h), sum(m, scaled(k2, 0.5 * h)));
    const Matrix6 k4 = multiply(tschauner_hempel_generator(g.e, nu + h), sum(m, scaled(k3, h)));
    for (int i = 0; i < 36; ++i) m[i] += h / 6.0 * (k1[i] + 2.0 * k2[i] + 2.0 * k3[i] + k4[i]);
    nu += h;
  }
  *psi = m;
  return true;
}

bool circular_chief(const ChiefReference& chief, std::string* error) {
  if (!(chief.semi_major_axis_m > 0.0) || !(chief.eccentricity >= 0.0) ||
      chief.eccentricity > kCircularChiefEccentricityLimit || !std::isfinite(chief.inclination_rad)) {
    *error = "circular-chief models need a positive semi-major axis and an eccentricity of at most 0.05";
    return false;
  }
  return true;
}

// ---- Kalman machinery -----------------------------------------------------

Matrix6 process_noise(const RelativeConfig& config, double dt) {
  Matrix6 q{};
  if (!config.white_acceleration || dt <= 0.0) return q;
  for (int i = 0; i < 3; ++i) {
    const double psd = config.acceleration_psd[i];
    at(q, i, i) = psd * dt * dt * dt / 3.0;
    at(q, i, i + 3) = at(q, i + 3, i) = psd * dt * dt / 2.0;
    at(q, i + 3, i + 3) = psd * dt;
  }
  return q;
}

struct Gain {
  Matrix6 inverse{};
  double nis{0.0};
  Vector6 innovation{};
};

// NIS of an observation against a belief with H = I: nu' (P + R)^-1 nu.
bool normalized_innovation(const Vector6& state, const Matrix6& covariance, const Vector6& observed,
                           const Matrix6& noise, Gain* gain) {
  const Matrix6 s = symmetrize(sum(covariance, noise));
  if (!invert6(s, &gain->inverse)) return false;
  for (int i = 0; i < 6; ++i) gain->innovation[i] = observed[i] - state[i];
  const Vector6 weighted = times(gain->inverse, gain->innovation);
  gain->nis = 0.0;
  for (int i = 0; i < 6; ++i) gain->nis += gain->innovation[i] * weighted[i];
  return std::isfinite(gain->nis);
}

// Joseph-form update with H = I.
void assimilate(const Vector6& predicted, const Matrix6& covariance, const Matrix6& noise,
                const Gain& gain, Vector6* state, Matrix6* updated) {
  const Matrix6 k = multiply(covariance, gain.inverse);
  const Vector6 correction = times(k, gain.innovation);
  for (int i = 0; i < 6; ++i) (*state)[i] = predicted[i] + correction[i];
  Matrix6 ikh = k;
  for (int i = 0; i < 36; ++i) ikh[i] = -ikh[i];
  for (int i = 0; i < 6; ++i) at(ikh, i, i) += 1.0;
  *updated = symmetrize(sum(multiply(multiply(ikh, covariance), transpose(ikh)),
                            multiply(multiply(k, noise), transpose(k))));
}

// ---- Curvilinear RTN --------------------------------------------------------
//
// With the chief at radius r and radial rate rdot, a deputy at rectilinear
// (x, y, z) has radius rd = |(r + x, y, z)|, in-plane angle th = atan2(y, r + x)
// and out-of-plane angle ph = atan2(z, hypot(r + x, y)). The curvilinear
// state is [rd - r, r th, r ph] and the time derivatives of those three.
struct ChiefRadial {
  double r{0.0}, rdot{0.0};
};

bool chief_radial(const RelativeConstants& constants, const ChiefReference& c, ChiefRadial* out) {
  const double e = c.eccentricity, a = c.semi_major_axis_m, mu = constants.gravitational_parameter_m3_s2;
  if (!(a > 0.0) || !(e >= 0.0) || !(e < 1.0) || !(mu > 0.0) || !std::isfinite(c.true_anomaly_rad)) return false;
  const double p = a * (1.0 - e * e);
  out->r = p / (1.0 + e * std::cos(c.true_anomaly_rad));
  out->rdot = std::sqrt(mu / p) * e * std::sin(c.true_anomaly_rad);
  return std::isfinite(out->r) && out->r > 0.0;
}

bool rect_to_curv_state(const ChiefRadial& c, const Vector6& s, Vector6* out) {
  const double x = c.r + s[0], y = s[1], z = s[2];
  const double plane2 = x * x + y * y, rd = std::sqrt(plane2 + z * z);
  if (!(plane2 > 0.0)) return false;
  const double plane = std::sqrt(plane2);
  const double rd_dot = (x * (c.rdot + s[3]) + y * s[4] + z * s[5]) / rd;
  const double theta = std::atan2(y, x), theta_dot = (x * s[4] - y * (c.rdot + s[3])) / plane2;
  const double phi = std::atan2(z, plane), phi_dot = (s[5] * rd - z * rd_dot) / (rd * plane);
  *out = {rd - c.r, c.r * theta, c.r * phi, rd_dot - c.rdot, c.rdot * theta + c.r * theta_dot,
          c.rdot * phi + c.r * phi_dot};
  return all_finite(*out);
}

bool curv_to_rect_state(const ChiefRadial& c, const Vector6& q, Vector6* out) {
  const double rd = c.r + q[0], rd_dot = c.rdot + q[3];
  if (!(rd > 0.0)) return false;
  const double theta = q[1] / c.r, phi = q[2] / c.r;
  const double theta_dot = (q[4] - c.rdot * theta) / c.r, phi_dot = (q[5] - c.rdot * phi) / c.r;
  const double ct = std::cos(theta), st = std::sin(theta), cp = std::cos(phi), sp = std::sin(phi);
  const double plane = rd * cp, plane_dot = rd_dot * cp - rd * sp * phi_dot;
  *out = {plane * ct - c.r, plane * st, rd * sp, plane_dot * ct - plane * st * theta_dot - c.rdot,
          plane_dot * st + plane * ct * theta_dot, rd_dot * sp + rd * cp * phi_dot};
  return all_finite(*out);
}

// Central-difference Jacobian of a state map (positions 1 m, rates 1 mm/s).
template <typename Map>
bool jacobian(const Map& map, const Vector6& at_state, Matrix6* out) {
  for (int j = 0; j < 6; ++j) {
    const double h = j < 3 ? 1.0 : 1.0e-3;
    Vector6 plus = at_state, minus = at_state, fp{}, fm{};
    plus[j] += h;
    minus[j] -= h;
    if (!map(plus, &fp) || !map(minus, &fm)) return false;
    for (int i = 0; i < 6; ++i) (*out)[6 * i + j] = (fp[i] - fm[i]) / (2.0 * h);
  }
  return true;
}

template <typename Map>
bool map_belief(const Map& map, const Vector6& state, const Matrix6& covariance, Vector6* out_state,
                Matrix6* out_covariance) {
  if (!map(state, out_state)) return false;
  if (out_covariance == nullptr) return true;
  Matrix6 j{};
  if (!jacobian(map, state, &j)) return false;
  *out_covariance = symmetrize(multiply(multiply(j, covariance), transpose(j)));
  return true;
}

bool valid_noise(const Matrix6& r) {
  if (!all_finite(r)) return false;
  return covariance_is_symmetric_positive_definite(r, 1.0e-12 * (1.0 + std::abs(r[0]) + std::abs(r[35])));
}

}  // namespace relnav

bool rectilinear_to_curvilinear(const RelativeConstants& constants, const ChiefReference& chief,
                                const Vector6& state, const Matrix6& covariance,
                                Vector6* curvilinear_state, Matrix6* curvilinear_covariance) {
  relnav::ChiefRadial c;
  if (!relnav::chief_radial(constants, chief, &c)) return false;
  return relnav::map_belief([&](const Vector6& in, Vector6* out) { return relnav::rect_to_curv_state(c, in, out); },
                            state, covariance, curvilinear_state, curvilinear_covariance);
}

bool curvilinear_to_rectilinear(const RelativeConstants& constants, const ChiefReference& chief,
                                const Vector6& state, const Matrix6& covariance,
                                Vector6* rectilinear_state, Matrix6* rectilinear_covariance) {
  relnav::ChiefRadial c;
  if (!relnav::chief_radial(constants, chief, &c)) return false;
  return relnav::map_belief([&](const Vector6& in, Vector6* out) { return relnav::curv_to_rect_state(c, in, out); },
                            state, covariance, rectilinear_state, rectilinear_covariance);
}

bool relative_transition(RelativeModel model, const RelativeConstants& constants,
                         const ChiefReference& from, const ChiefReference& to,
                         double elapsed_seconds, Matrix6* transition, std::string* error) {
  std::string scratch;
  if (error == nullptr) error = &scratch;
  if (transition == nullptr || !std::isfinite(elapsed_seconds) || elapsed_seconds < 0.0 ||
      !(constants.gravitational_parameter_m3_s2 > 0.0)) {
    *error = "transition needs a positive gravitational parameter and a finite, non-negative interval";
    return false;
  }
  if (elapsed_seconds == 0.0) {
    *transition = identity6();
    return true;
  }
  const double mu = constants.gravitational_parameter_m3_s2;
  switch (model) {
    case RelativeModel::HILL_CLOHESSY_WILTSHIRE: {
      if (!relnav::circular_chief(from, error)) return false;
      const double n = std::sqrt(mu / (from.semi_major_axis_m * from.semi_major_axis_m * from.semi_major_axis_m));
      *transition = relnav::constant_coefficient_transition(n, n, n, elapsed_seconds);
      return true;
    }
    case RelativeModel::SCHWEIGHART_SEDWICK_J2: {
      if (!relnav::circular_chief(from, error)) return false;
      if (!(constants.j2 >= 0.0) || !(constants.equatorial_radius_m > 0.0)) {
        *error = "SCHWEIGHART_SEDWICK_J2 needs a non-negative J2 and a positive equatorial radius";
        return false;
      }
      const double r = from.semi_major_axis_m;
      const double n = std::sqrt(mu / (r * r * r));
      const double ratio2 = (constants.equatorial_radius_m / r) * (constants.equatorial_radius_m / r);
      const double s = 3.0 * constants.j2 * ratio2 * (1.0 + 3.0 * std::cos(2.0 * from.inclination_rad)) / 8.0;
      const double c2 = 1.0 + s;
      const double w2 = (2.0 - c2) * n * n;
      if (!(c2 > 0.0) || !(w2 > 0.0)) {
        *error = "the J2 correction leaves no oscillatory in-plane motion for this chief";
        return false;
      }
      const double ci = std::cos(from.inclination_rad);
      const double a = n * std::sqrt(c2);
      const double q = a + 1.5 * constants.j2 * n * ratio2 * ci * ci;
      *transition = relnav::constant_coefficient_transition(a, std::sqrt(w2), q, elapsed_seconds);
      return true;
    }
    case RelativeModel::TSCHAUNER_HEMPEL:
    case RelativeModel::YAMANAKA_ANKERSEN: {
      relnav::Eccentric g;
      if (!relnav::eccentric_geometry(constants, from, to, elapsed_seconds, &g, error)) return false;
      Matrix6 psi{};
      if (model == RelativeModel::YAMANAKA_ANKERSEN) {
        if (!relnav::yamanaka_ankersen_normalized(g, &psi)) {
          *error = "the Yamanaka-Ankersen matrix is singular for this chief";
          return false;
        }
      } else if (!relnav::tschauner_hempel_normalized(g, &psi, error)) {
        return false;
      }
      *transition = relnav::multiply(relnav::multiply(relnav::block_map(g.e, g.k, g.nu1, false), psi),
                                     relnav::block_map(g.e, g.k, g.nu0, true));
      return relnav::all_finite(*transition);
    }
  }
  *error = "unknown relative model";
  return false;
}

RelativeResult relative_filter(const RelativeConfig& config,
                               const std::vector<RelativeObservation>& observations) {
  RelativeResult result;
  auto refuse = [&](const char* message) { result.valid = false; result.error = message; return result; };
  if (static_cast<unsigned>(config.model) > static_cast<unsigned>(RelativeModel::YAMANAKA_ANKERSEN))
    return refuse("unknown relative model");
  if (!std::isfinite(config.epoch_seconds) || !relnav::all_finite(config.state))
    return refuse("the initial state and epoch must be finite");
  if (!relnav::valid_noise(config.covariance)) return refuse("the initial covariance must be symmetric positive definite");
  for (double v : config.acceleration_psd)
    if (!std::isfinite(v) || v < 0.0) return refuse("acceleration spectral densities must be finite and non-negative");
  const bool recover = config.recovery.enabled;
  if (recover && !valid_recovery_config(config.recovery))
    return refuse("innovation recovery needs a probability in (0, 1), a confirmation count of at least 2, an inflation of at least 1 and a positive maximum gap");
  InnovationRecovery controller(config.recovery);

  // The linear models are rectilinear; a curvilinear wire state converts in
  // and every reported state converts back at the observation's chief.
  Vector6 x = config.state;
  Matrix6 p = config.covariance;
  if (config.curvilinear &&
      !curvilinear_to_rectilinear(config.constants, config.chief, config.state, config.covariance, &x, &p))
    return refuse("the curvilinear initial state is not valid for this chief");
  double previous_epoch = config.epoch_seconds;
  ChiefReference previous_chief = config.chief;
  result.epochs.reserve(observations.size());
  for (const RelativeObservation& o : observations) {
    if (!std::isfinite(o.epoch_seconds) || o.epoch_seconds < previous_epoch)
      return refuse("observations must be finite and chronological");
    if (!relnav::all_finite(o.state)) return refuse("observation states must be finite");
    if (!relnav::valid_noise(o.covariance)) return refuse("observation covariances must be symmetric positive definite");
    Vector6 z = o.state;
    Matrix6 r = o.covariance;
    if (config.curvilinear &&
        !curvilinear_to_rectilinear(config.constants, o.chief, o.state, o.covariance, &z, &r))
      return refuse("a curvilinear observation is not valid for its chief");
    const double dt = o.epoch_seconds - previous_epoch;
    Matrix6 phi{};
    std::string error;
    if (!relative_transition(config.model, config.constants, previous_chief, o.chief, dt, &phi, &error))
      return refuse(error.c_str());
    const Matrix6 q = relnav::process_noise(config, dt);
    const Vector6 predicted = relnav::times(phi, x);
    const Matrix6 predicted_p = relnav::symmetrize(relnav::sum(relnav::multiply(relnav::multiply(phi, p), relnav::transpose(phi)), q));
    relnav::Gain gain;
    if (!relnav::normalized_innovation(predicted, predicted_p, z, r, &gain))
      return refuse("the innovation covariance is not invertible");

    RelativeEpoch row;
    row.epoch_seconds = o.epoch_seconds;
    row.normalized_innovation_squared = gain.nis;
    RecoveryAction action = RecoveryAction::ACCEPTED;
    if (recover) {
      bool has_candidate = false;
      double candidate_nis = 0.0;
      if (controller.pending_at(o.epoch_seconds) && config.recovery.strategy == RecoveryStrategy::PREDICTIVE_CONSISTENCY) {
        // The candidate started at the previous observation; the same
        // dynamics and process noise carry it to this one.
        const RecoveryBelief& c = controller.candidate();
        const Matrix6 candidate_p = relnav::symmetrize(relnav::sum(relnav::multiply(relnav::multiply(phi, c.covariance), relnav::transpose(phi)), q));
        relnav::Gain candidate_gain;
        has_candidate = relnav::normalized_innovation(relnav::times(phi, c.state), candidate_p, z, r, &candidate_gain);
        candidate_nis = candidate_gain.nis;
      }
      row.has_recovery = true;
      row.recovery = controller.decide(o.epoch_seconds, gain.nis, has_candidate, candidate_nis);
      action = row.recovery.action;
    }
    if (action == RecoveryAction::ACCEPTED) {
      relnav::assimilate(predicted, predicted_p, r, gain, &x, &p);
    } else if (action == RecoveryAction::HELD) {
      x = predicted;
      p = predicted_p;
      controller.set_candidate({z, r});
    } else {
      x = z;
      for (int i = 0; i < 36; ++i) p[i] = config.recovery.covariance_inflation * r[i];
    }
    if (config.curvilinear) {
      Vector6 predicted_wire{};
      if (!rectilinear_to_curvilinear(config.constants, o.chief, predicted, predicted_p, &predicted_wire, &row.predicted_covariance) ||
          !rectilinear_to_curvilinear(config.constants, o.chief, x, p, &row.filtered_state, &row.filtered_covariance))
        return refuse("a curvilinear state is not valid for its chief");
      row.predicted_state = predicted_wire;
      for (int i = 0; i < 6; ++i) row.innovation[i] = o.state[i] - predicted_wire[i];
    } else {
      row.predicted_state = predicted;
      row.predicted_covariance = predicted_p;
      row.innovation = gain.innovation;
      row.filtered_state = x;
      row.filtered_covariance = p;
    }
    result.epochs.push_back(row);
    previous_epoch = o.epoch_seconds;
    previous_chief = o.chief;
  }
  result.valid = true;
  return result;
}

bool inertial_to_rtn(double mu, const Vector6& chief, const Vector6& deputy,
                     Vector6* relative, ChiefReference* reference) {
  if (!(mu > 0.0) || relative == nullptr || reference == nullptr || !relnav::all_finite(chief) ||
      !relnav::all_finite(deputy))
    return false;
  const double r[3] = {chief[0], chief[1], chief[2]}, v[3] = {chief[3], chief[4], chief[5]};
  const double h[3] = {r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]};
  auto dot3 = [](const double* a, const double* b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; };
  const double rn = std::sqrt(dot3(r, r)), hn = std::sqrt(dot3(h, h));
  if (!(rn > 0.0) || !(hn > 0.0)) return false;
  double radial[3], normal[3], along[3];
  for (int i = 0; i < 3; ++i) { radial[i] = r[i] / rn; normal[i] = h[i] / hn; }
  along[0] = normal[1] * radial[2] - normal[2] * radial[1];
  along[1] = normal[2] * radial[0] - normal[0] * radial[2];
  along[2] = normal[0] * radial[1] - normal[1] * radial[0];
  const double dr[3] = {deputy[0] - r[0], deputy[1] - r[1], deputy[2] - r[2]};
  const double dv[3] = {deputy[3] - v[0], deputy[4] - v[1], deputy[5] - v[2]};
  const double rho[3] = {dot3(dr, radial), dot3(dr, along), dot3(dr, normal)};
  const double rate[3] = {dot3(dv, radial), dot3(dv, along), dot3(dv, normal)};
  const double omega = hn / (rn * rn);
  (*relative)[0] = rho[0];
  (*relative)[1] = rho[1];
  (*relative)[2] = rho[2];
  (*relative)[3] = rate[0] + omega * rho[1];
  (*relative)[4] = rate[1] - omega * rho[0];
  (*relative)[5] = rate[2];
  const double v2 = dot3(v, v), rv = dot3(r, v);
  const double energy = 0.5 * v2 - mu / rn;
  if (!(energy < 0.0)) return false;
  double ecc[3];
  for (int i = 0; i < 3; ++i) ecc[i] = ((v2 - mu / rn) * r[i] - rv * v[i]) / mu;
  const double p = hn * hn / mu;
  reference->semi_major_axis_m = -mu / (2.0 * energy);
  reference->eccentricity = std::sqrt(dot3(ecc, ecc));
  reference->inclination_rad = std::acos(std::max(-1.0, std::min(1.0, h[2] / hn)));
  reference->true_anomaly_rad = std::atan2(std::sqrt(p / mu) * rv / rn, p / rn - 1.0);
  return true;
}

}  // namespace sdn::estimation
