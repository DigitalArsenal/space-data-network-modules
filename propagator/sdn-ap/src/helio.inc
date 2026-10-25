// -----------------------------------------------------------------------------
// SDN-AP 2h.3: heliocentric cruise segments. The set is the epoch state with
// mu_eff = mu_Sun (1 - beta) (radial SRP, the lightness number), the DE440
// planets (Venus, the Earth-Moon barycenter, Mars, Jupiter, Saturn as system
// point masses, tabulated every 6 h over the segment) and an RTN acceleration
// a0 + a1 t (thrust arcs; DESIGN 2h.3); RK4 on the ICRF Sun-centred state (km, s)
// at 1800 s, the node steps cut into parts inside a planet's sphere of influence
// (2 % of the distance over the relative speed). Not yet: the Laplace-Lagrange
// secular terms for long segments, planet-centred sets.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace helio {

constexpr double kMuSun = 1.32712440018e11;  // km^3/s^2 (DE440)
constexpr double kPlanetTableSeconds = 21600.0;
using lunar::DePlanet;
using lunar::kDePlanet;
using lunar::kDePlanets;
using lunar::kDePlanetStartEt;

/// The heliocentric planets at et (km, ICRF), 3 per planet; false outside the embedded span (2012-2029).
inline bool planets_at(double et, double* r) {
  for (int k = 0; k < kDePlanets; ++k) {
    const DePlanet& p = kDePlanet[k];
    if (!lunar::cheb3(p.coef, kDePlanetStartEt, p.record_s, p.records, p.degree, et, r + 3 * k)) return false;
  }
  return true;
}

/// The planet whose sphere of influence a_p (m_p / M_Sun)^(2/5) holds r at et (-1 none); *d the distance to it.
inline int sphere_of(double et, const double* r, double* d = nullptr) {
  double rp[3 * kDePlanets];
  if (!planets_at(et, rp)) return -1;
  for (int k = 0; k < kDePlanets; ++k) {
    const double* q = rp + 3 * k;
    const double dist = std::sqrt((r[0] - q[0]) * (r[0] - q[0]) + (r[1] - q[1]) * (r[1] - q[1]) + (r[2] - q[2]) * (r[2] - q[2]));
    const double soi = std::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]) * std::pow(kDePlanet[k].gm / kMuSun, 0.4);
    if (dist < soi) {
      if (d) *d = dist;
      return k;
    }
  }
  return -1;
}

struct Sat {
  double r0[3] = {}, v0[3] = {};
  double beta = 0.0;          // mu_eff = mu_Sun (1 - beta)
  double rtn[3] = {0, 0, 0};       // km/s^2
  double rtn_rate[3] = {0, 0, 0};  // km/s^3 (a steered or fading thrust arc)
  double et0 = 0.0;                // TT seconds from J2000 at the epoch
  const std::vector<double>* planets = nullptr;  // the planet table (owned by the caller), every kPlanetTableSeconds
  double tab_t0 = 0.0;             // its first node, s from the epoch
};

/// The planet table over t_lo .. t_hi (s from et0); false outside the embedded span.
inline bool tabulate(std::vector<double>& tab, double& tab_t0, double et0, double t_lo, double t_hi) {
  tab_t0 = t_lo - 2.0 * kPlanetTableSeconds;
  const int n = static_cast<int>((t_hi - tab_t0) / kPlanetTableSeconds) + 5;
  tab.assign(3 * kDePlanets * n, 0.0);
  for (int k = 0; k < n; ++k)
    if (!planets_at(et0 + tab_t0 + k * kPlanetTableSeconds, tab.data() + 3 * kDePlanets * k)) return false;
  return true;
}

inline void accel(const Sat& s, double t, const double* r, const double* v, double* a) {
  const double rn = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  const double mu = kMuSun * (1.0 - s.beta);
  double h[3] = {r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]};
  const double hn = std::sqrt(h[0] * h[0] + h[1] * h[1] + h[2] * h[2]);
  double R[3], N[3], T[3];
  for (int c = 0; c < 3; ++c) { R[c] = r[c] / rn; N[c] = h[c] / hn; }
  T[0] = N[1] * R[2] - N[2] * R[1]; T[1] = N[2] * R[0] - N[0] * R[2]; T[2] = N[0] * R[1] - N[1] * R[0];
  const double ar = s.rtn[0] + s.rtn_rate[0] * t, at = s.rtn[1] + s.rtn_rate[1] * t, an = s.rtn[2] + s.rtn_rate[2] * t;
  for (int c = 0; c < 3; ++c) a[c] = -mu * r[c] / (rn * rn * rn) + ar * R[c] + at * T[c] + an * N[c];
  if (s.planets == nullptr) return;
  // the planets: 4-point Lagrange in the 6 h table, direct minus indirect terms
  const std::vector<double>& tab = *s.planets;
  const int nodes = static_cast<int>(tab.size() / (3 * kDePlanets));
  double u = (t - s.tab_t0) / kPlanetTableSeconds;
  int k = static_cast<int>(std::floor(u)) - 1;
  if (k < 0) k = 0;
  if (k > nodes - 4) k = nodes - 4;
  u -= k;
  const double w[4] = {-(u - 1) * (u - 2) * (u - 3) / 6.0, u * (u - 2) * (u - 3) / 2.0, -u * (u - 1) * (u - 3) / 2.0, u * (u - 1) * (u - 2) / 6.0};
  for (int p = 0; p < kDePlanets; ++p) {
    double q[3];
    for (int c = 0; c < 3; ++c) {
      const int at_ = 3 * p + c, st = 3 * kDePlanets;
      q[c] = w[0] * tab[st * k + at_] + w[1] * tab[st * (k + 1) + at_] + w[2] * tab[st * (k + 2) + at_] + w[3] * tab[st * (k + 3) + at_];
    }
    const double d[3] = {q[0] - r[0], q[1] - r[1], q[2] - r[2]};
    const double dn = std::sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]), qn = std::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]);
    const double gm = kDePlanet[p].gm;
    for (int c = 0; c < 3; ++c) a[c] += gm * (d[c] / (dn * dn * dn) - q[c] / (qn * qn * qn));
  }
}

/// States (stride 6) or positions (stride 3) at ascending times t (s from the epoch; earlier times backward): RK4 on
/// a fixed node grid of h seconds from the epoch.
constexpr double kStep = 1800.0;
inline bool states(const Sat& s, const double* t, int count, double* out, int stride, double h = kStep) {
  const double y0[6] = {s.r0[0], s.r0[1], s.r0[2], s.v0[0], s.v0[1], s.v0[2]};
  auto f = [&](double tt, const double* y, double* d) {
    double a[3];
    accel(s, tt, y, y + 3, a);
    for (int c = 0; c < 3; ++c) { d[c] = y[3 + c]; d[3 + c] = a[c]; }
  };
  // inside a planet's sphere of influence the node step is cut into parts of 2 % of the distance over the craft's
  // speed (the relative speed is lower: conservative), at least 1 s each
  auto parts = [&](double tt, const double* x) {
    if (s.planets == nullptr) return 1;
    const std::vector<double>& tab = *s.planets;
    const int nodes = static_cast<int>(tab.size() / (3 * kDePlanets));
    int k = static_cast<int>(std::lround((tt - s.tab_t0) / kPlanetTableSeconds));
    if (k < 0) k = 0;
    if (k > nodes - 1) k = nodes - 1;
    const double v = std::sqrt(x[3] * x[3] + x[4] * x[4] + x[5] * x[5]);
    int m = 1;
    for (int p = 0; p < kDePlanets; ++p) {
      const double* q = tab.data() + 3 * kDePlanets * k + 3 * p;
      const double d = std::sqrt((x[0] - q[0]) * (x[0] - q[0]) + (x[1] - q[1]) * (x[1] - q[1]) + (x[2] - q[2]) * (x[2] - q[2]));
      const double soi = std::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]) * std::pow(kDePlanet[p].gm / kMuSun, 0.4);
      if (d < soi) {
        const double sub = std::fmax(1.0, 0.02 * d / v);
        m = std::max(m, static_cast<int>(std::ceil(h / sub)));
      }
    }
    return m;
  };
  return segment::rk4_states(f, y0, h, t, count, out, stride, parts);
}
inline bool positions(const Sat& s, const double* t, int count, double* out) { return states(s, t, count, out, 3); }

/// Levenberg-Marquardt on the epoch state, beta and the RTN acceleration (10 parameters; weak priors on the last
/// four) against J2000 Sun-centred positions (km). Returns the RMS (km) or a negative number.
inline double fit(Sat& s, const double* t, const double* pos, int count, int iterations, int np = 13) {
  constexpr int NP = 13;
  std::vector<double> res(3 * count), trial(3 * count), J(3 * count * NP, 0.0), p3(3 * count);
  auto get = [](Sat& q, int p) -> double& { return p < 3 ? q.r0[p] : p < 6 ? q.v0[p - 3] : p == 6 ? q.beta : p < 10 ? q.rtn[p - 7] : q.rtn_rate[p - 10]; };
  auto residuals = [&](const Sat& q, std::vector<double>& o) {
    if (!positions(q, t, count, p3.data())) return false;
    for (int k = 0; k < 3 * count; ++k) o[k] = p3[k] - pos[k];
    return true;
  };
  auto cost = [&](const std::vector<double>& v) { double c = 0; for (double x : v) c += x * x; return c; };
  if (!residuals(s, res)) return -1.0;
  double c0 = cost(res), lambda = 1e-3;
  const double step[NP] = {1e-3, 1e-3, 1e-3, 1e-7, 1e-7, 1e-7, 1e-6, 1e-12, 1e-12, 1e-12, 1e-18, 1e-18, 1e-18};
  const double prior_sigma[NP] = {0, 0, 0, 0, 0, 0, 1e-2, 1e-6, 1e-6, 1e-6, 1e-12, 1e-12, 1e-12};  // weak
  for (int it = 0; it < iterations; ++it) {
    for (int p = 0; p < np; ++p) {
      Sat q = s;
      get(q, p) += step[p];
      if (!residuals(q, trial)) return -1.0;
      for (int k = 0; k < 3 * count; ++k) J[k * NP + p] = (trial[k] - res[k]) / step[p];
    }
    double N[NP * NP] = {}, g[NP] = {};
    for (int k = 0; k < 3 * count; ++k)
      for (int i = 0; i < NP; ++i) {
        g[i] += J[k * NP + i] * res[k];
        for (int j = 0; j < NP; ++j) N[i * NP + j] += J[k * NP + i] * J[k * NP + j];
      }
    for (int p = np; p < NP; ++p) N[p * NP + p] = 1.0;  // fixed parameters: no step
    for (int p = 6; p < np; ++p) {
      N[p * NP + p] += 1.0 / (prior_sigma[p] * prior_sigma[p]);
      g[p] += get(s, p) / (prior_sigma[p] * prior_sigma[p]);
    }
    bool improved = false;
    for (int tries = 0; tries < 8 && !improved; ++tries) {
      // Jacobi-scaled (positions in km and accelerations in km/s^2 differ by 25 orders in the normal matrix)
      double A[NP * NP], b[NP], dx[NP], d[NP];
      for (int i = 0; i < NP; ++i) d[i] = N[i * NP + i] > 0.0 ? std::sqrt(N[i * NP + i]) : 1.0;
      for (int i = 0; i < NP; ++i)
        for (int j = 0; j < NP; ++j) A[i * NP + j] = N[i * NP + j] / (d[i] * d[j]);
      for (int i = 0; i < NP; ++i) { A[i * NP + i] *= 1.0 + lambda; b[i] = -g[i] / d[i]; }
      for (int c = 0; c < NP; ++c) {
        int pv = c;
        for (int r = c + 1; r < NP; ++r) if (std::fabs(A[r * NP + c]) > std::fabs(A[pv * NP + c])) pv = r;
        for (int j = 0; j < NP; ++j) std::swap(A[c * NP + j], A[pv * NP + j]);
        std::swap(b[c], b[pv]);
        if (A[c * NP + c] == 0.0) break;
        for (int r = c + 1; r < NP; ++r) {
          const double f = A[r * NP + c] / A[c * NP + c];
          for (int j = c; j < NP; ++j) A[r * NP + j] -= f * A[c * NP + j];
          b[r] -= f * b[c];
        }
      }
      for (int c = NP - 1; c >= 0; --c) {
        double sum = b[c];
        for (int j = c + 1; j < NP; ++j) sum -= A[c * NP + j] * dx[j];
        dx[c] = sum / A[c * NP + c];
      }
      for (int i = 0; i < NP; ++i) dx[i] /= d[i];
      Sat q = s;
      for (int p = 0; p < NP; ++p) get(q, p) += dx[p];
      if (residuals(q, trial) && cost(trial) < c0) {
        const double c1 = cost(trial);
        const bool converged = (c0 - c1) < 1e-12 * c0;
        s = q;
        res = trial;
        c0 = c1;
        lambda *= 0.3;
        improved = true;
        if (converged) it = iterations;
      } else {
        lambda *= 10.0;
      }
    }
    if (!improved) break;
  }
  return std::sqrt(c0 / count);
}

}  // namespace helio
}  // namespace sdnap

namespace sdnap {
namespace helio {

/// The segment set of a cruise arc (2h.3 / 2h.5): np 6 (two-body), 7 (+ beta), 10 (+ RTN) or 13 (+ its rate); with
/// `segment` the rule of segment::choose_segment (at least 5 days). out: the kept set (epoch t_fit[first]); returns
/// its RMS (km, < 0 on refusal) and first.
inline double fit_segmented(double et_arc, const double* t_fit, const double* pos_fit, const double* vel_fit, int nfit, double t_hi, int np,
                            bool segment, Sat& out, int& first, std::vector<double>& table) {
  // one planet table for the arc and the prediction (t_hi, s from the arc's start), re-based per segment
  double arc_t0 = 0.0;
  if (!tabulate(table, arc_t0, et_arc, t_fit[0], t_hi)) return -3.0;
  auto fit_at = [&](int k, Sat& q) {
    q = Sat{};
    for (int c = 0; c < 3; ++c) { q.r0[c] = pos_fit[3 * k + c]; q.v0[c] = vel_fit[3 * k + c]; }
    q.et0 = et_arc + t_fit[k];
    q.planets = &table;
    q.tab_t0 = arc_t0 - t_fit[k];
    std::vector<double> t(t_fit + k, t_fit + nfit);
    for (double& x : t) x -= t_fit[k];
    return fit(q, t.data(), pos_fit + 3 * k, nfit - k, 60, np);
  };
  double rms = -1.0;
  first = segment::choose_segment(t_fit, nfit, segment, 5.0 * 86400.0, [&](int k) { Sat q; return fit_at(k, q); }, rms);
  if (first < 0) return -2.0;
  return fit_at(first, out);
}

/// A cruise arc's set (2h.3 / 2h.5): the arc cut after its latest sphere-of-influence passage (the set's epoch carried
/// across the flyby), then fit_segmented. -5 when the arc ends inside a sphere of influence (a planet-centred set);
/// first indexes the whole arc.
inline double fit_cruise(double et_arc, const double* t_fit, const double* pos_fit, const double* vel_fit, int nfit, double t_hi, int np,
                         bool segment, Sat& out, int& first, std::vector<double>& table) {
  int from = 0;
  for (int k = 0; k < nfit; ++k)
    if (sphere_of(et_arc + t_fit[k], pos_fit + 3 * k) >= 0) from = k + 1;
  if (from > nfit - 24) return -5.0;
  const double rms = fit_segmented(et_arc, t_fit + from, pos_fit + 3 * from, vel_fit + 3 * from, nfit - from, t_hi, np, segment, out, first, table);
  first += from;
  return rms;
}

}  // namespace helio
}  // namespace sdnap

/// Diagnostic of the heliocentric baseline (2h.3): fit to `nfit` J2000 Sun-centred states (positions and velocities,
/// km and km/s) at `t_fit` seconds (ascending, from 0); `mode` & 7: 0 two-body, 1 with beta, 2 with beta and the RTN
/// acceleration, 3 with its linear rate; `mode` & 8 segments at a thrust change (segment::choose_segment). Positions
/// at `t_out` (s, same origin) into `out`; returns the kept fit's RMS (km), negative on refusal; *start_out the kept
/// segment's start (s).
SDNAP_EXPORT("sdnap_helio_fit_predict")
double sdnap_helio_fit_predict(double whole, double frac, const double* t_fit, const double* pos_fit, const double* vel_fit, int32_t nfit,
                               const double* t_out, int32_t nout, double* out, int32_t mode, double* start_out) {
  using namespace sdnap::helio;
  const int np = (mode & 7) == 0 ? 6 : (mode & 7) == 1 ? 7 : (mode & 7) == 2 ? 10 : 13;
  Sat s;
  int first = 0;
  std::vector<double> table;
  const double et_arc = sdnap::lunar::et_of(whole, frac);
  const double t_hi = std::max(t_fit[nfit - 1], nout > 0 ? t_out[nout - 1] : 0.0);
  const double rms = fit_cruise(et_arc, t_fit, pos_fit, vel_fit, nfit, t_hi, np, (mode & 8) != 0, s, first, table);
  if (rms < 0) return rms;
  const double t0 = t_fit[first];
  if (start_out) *start_out = t0;
  std::vector<double> t(t_out, t_out + nout);
  for (double& x : t) x -= t0;
  if (nout > 0 && !positions(s, t.data(), nout, out)) return -4.0;
  return rms;
}
