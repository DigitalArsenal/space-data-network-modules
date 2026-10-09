#include <complex>

// map_covariance: an RTN covariance of an element set's state mapped from one
// epoch to others through a state transition matrix. Built in one
// translation unit after gp_error_model.cpp (element loading, SGP4, RTN axes)
// and analysis/lambert-izzo's solver header.
//
// The covariance is the lower triangle of the 6x6 position/velocity matrix
// (km, km/s) in the RTN axes of the anchor set's SGP4 state (TEME; at t0 the
// state of `axesSet` when given, e.g. the set whose scatter it is): rows R,
// T, N of position, then velocity differences projected on the same axes (as
// accumulate's errors are). With B(t) the block-diagonal rotation into those
// axes at t,  C(t) = B(t) Phi(t, t0) B(t0)' C(t0) B(t0) Phi(t, t0)' B(t)'.
// The STM methods, all in SGP4's TEME (treated as inertial over the span):
//   sgp4      Phi = J(t) J(t0)^-1, J the Jacobian of SGP4's state with respect
//             to the nonsingular mean elements (n, e cos w, e sin w, i, node,
//             M + w), by central differences (steps 1e-7 n for n, 1e-7 for the
//             others); B* is held. The linearized SGP4 STM of Osweiler (2006).
//   two-body  Keplerian motion (WGS-72 mu) from the anchor's SGP4 state at t0;
//             Phi by complex-step differentiation of the universal-variable
//             Kepler solution (exact to rounding).
//   lambert   Thompson, Gossner, Sais and Cunningham (2019): the two-body arc
//             through the anchor's SGP4 positions at the earlier and later
//             epoch (Izzo's solver), N = floor(dt / P) full revolutions with P
//             from SGP4's state at the earlier epoch (their eqs. 16-18; N - 1
//             when the time of flight is too short for N), and for N > 0 the
//             branch whose energy is nearest SGP4's (their eq. 19); the arc is
//             prograde about SGP4's angular momentum. Phi is the two-body STM
//             along that arc, which their perturbed-Lambert construction (eqs.
//             9-15) approximates by finite differences. A transfer angle
//             within 1 degree of 0 or 180 degrees leaves the plane undefined:
//             within the first revolution near 0 degrees (a target seconds or
//             minutes from t0) the arc is SGP4's osculating one ("short-arc");
//             otherwise the target is refused. A target before t0 uses the
//             inverse of the forward map.

namespace stm {

using Mat6 = std::array<double, 36>;  // row-major
using cplx = std::complex<double>;
constexpr double kMu = kMuWgs72;

Mat6 multiply(const Mat6& a, const Mat6& b) {
  Mat6 c{};
  for (int i = 0; i < 6; ++i)
    for (int k = 0; k < 6; ++k) {
      const double aik = a[6 * i + k];
      for (int j = 0; j < 6; ++j) c[6 * i + j] += aik * b[6 * k + j];
    }
  return c;
}
Mat6 transpose(const Mat6& a) {
  Mat6 t{};
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < 6; ++j) t[6 * j + i] = a[6 * i + j];
  return t;
}
// Gauss-Jordan with partial pivoting; false when singular.
bool invert(const Mat6& a, Mat6* out) {
  double m[6][12];
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < 12; ++j) m[i][j] = j < 6 ? a[6 * i + j] : (j - 6 == i ? 1.0 : 0.0);
  for (int c = 0; c < 6; ++c) {
    int p = c;
    for (int r = c + 1; r < 6; ++r)
      if (std::fabs(m[r][c]) > std::fabs(m[p][c])) p = r;
    if (!(std::fabs(m[p][c]) > 0)) return false;
    if (p != c)
      for (int j = 0; j < 12; ++j) std::swap(m[p][j], m[c][j]);
    const double d = m[c][c];
    for (int j = 0; j < 12; ++j) m[c][j] /= d;
    for (int r = 0; r < 6; ++r) {
      if (r == c) continue;
      const double f = m[r][c];
      if (f == 0) continue;
      for (int j = 0; j < 12; ++j) m[r][j] -= f * m[c][j];
    }
  }
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < 6; ++j) (*out)[6 * i + j] = m[i][j + 6];
  return true;
}

// Block-diagonal rotation into the RTN axes of (r, v): rows R, T, N.
Mat6 rtn_block(const double r[3], const double v[3]) {
  double axes[3][3];
  hpopcal::rtn_axes(r, v, axes);
  Mat6 b{};
  for (int blk = 0; blk < 2; ++blk)
    for (int i = 0; i < 3; ++i)
      for (int k = 0; k < 3; ++k) b[6 * (3 * blk + i) + 3 * blk + k] = axes[i][k];
  return b;
}

// ── SGP4 Jacobian with respect to nonsingular mean elements ──
void nonsingular(const ElementSet& s, double p[6]) {
  p[0] = s.el[0];
  p[1] = s.el[1] * std::cos(s.el[4]);
  p[2] = s.el[1] * std::sin(s.el[4]);
  p[3] = s.el[2];
  p[4] = s.el[3];
  p[5] = s.el[5] + s.el[4];
}
bool init_elements(const ElementSet& s, const double p[6], elsetrec& rec) {
  const double e = std::hypot(p[1], p[2]);
  const double w = e > 0 ? std::atan2(p[2], p[1]) : 0.0;
  char satn[9] = "00000";
  std::memset(&rec, 0, sizeof(rec));
  return SGP4Funcs::sgp4init(wgs72, 'i', satn, s.sgp4_epoch, s.el[6], 0.0, 0.0, e, w, p[3], p[5] - w, p[0], p[4], rec) &&
         rec.error == 0;
}
// J at each time (minutes from the set's epoch), TEME km and km/s per unit element.
bool sgp4_jacobians(const ElementSet& s, const std::vector<double>& minutes, std::vector<Mat6>* jac) {
  double p0[6];
  nonsingular(s, p0);
  const double step[6] = {1e-7 * p0[0], 1e-7, 1e-7, 1e-7, 1e-7, 1e-7};
  jac->assign(minutes.size(), Mat6{});
  std::vector<std::array<double, 6>> plus(minutes.size());
  for (int k = 0; k < 6; ++k) {
    for (int sign = 1; sign >= -1; sign -= 2) {
      double p[6];
      std::copy(p0, p0 + 6, p);
      p[k] += sign * step[k];
      elsetrec rec;
      if (!init_elements(s, p, rec)) return false;
      for (size_t j = 0; j < minutes.size(); ++j) {
        double r[3], v[3];
        if (!SGP4Funcs::sgp4(rec, minutes[j], r, v) || rec.error != 0) return false;
        const double x[6] = {r[0], r[1], r[2], v[0], v[1], v[2]};
        if (sign > 0) {
          std::copy(x, x + 6, plus[j].begin());
        } else {
          for (int c = 0; c < 6; ++c) (*jac)[j][6 * c + k] = (plus[j][c] - x[c]) / (2 * step[k]);
        }
      }
    }
  }
  return true;
}

// ── Two-body motion: universal variables, complex so that Phi follows by complex step ──
cplx dot(const cplx a[3], const cplx b[3]) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
void stumpff(cplx z, cplx* c, cplx* s) {
  if (std::abs(z) < 0.1) {  // series: C = sum (-z)^k / (2k+2)!, S = sum (-z)^k / (2k+3)!
    *c = 0;
    *s = 0;
    cplx zk = 1;
    double fc = 2, fs = 6;
    for (int k = 0; k < 12; ++k) {
      *c += zk / fc;
      *s += zk / fs;
      zk *= -z;
      fc *= (2.0 * k + 3) * (2.0 * k + 4);
      fs *= (2.0 * k + 4) * (2.0 * k + 5);
    }
  } else if (z.real() > 0) {
    const cplx q = std::sqrt(z);
    *c = (1.0 - std::cos(q)) / z;
    *s = (q - std::sin(q)) / (q * q * q);
  } else {
    const cplx q = std::sqrt(-z);
    *c = (std::cosh(q) - 1.0) / (-z);
    *s = (std::sinh(q) - q) / (q * q * q);
  }
}
// State after dt seconds (dt may be negative); false without convergence.
bool kepler(const cplx r0[3], const cplx v0[3], double dt, cplx r[3], cplx v[3]) {
  const double sm = std::sqrt(kMu);
  const cplx r0n = std::sqrt(dot(r0, r0));
  const cplx sigma = dot(r0, v0) / sm;
  const cplx alpha = 2.0 / r0n - dot(v0, v0) / kMu;
  cplx x = alpha.real() > 1e-12 ? sm * dt * alpha : sm * dt / r0n;
  bool converged = false;
  for (int it = 0, extra = 0; it < 200; ++it) {
    const cplx z = alpha * x * x;
    cplx c, s;
    stumpff(z, &c, &s);
    const cplx f = sigma * x * x * c + (1.0 - alpha * r0n) * x * x * x * s + r0n * x - sm * dt;
    const cplx df = sigma * x * (1.0 - z * s) + (1.0 - alpha * r0n) * x * x * c + r0n;  // the radius at x
    const cplx dx = f / df;
    x -= dx;
    if (converged && ++extra >= 2) break;  // two more steps settle the imaginary part
    if (std::fabs(dx.real()) <= 1e-14 * std::max(1.0, std::fabs(x.real()))) converged = true;
  }
  if (!converged) return false;
  const cplx z = alpha * x * x;
  cplx c, s;
  stumpff(z, &c, &s);
  const cplx f = 1.0 - x * x * c / r0n, g = dt - x * x * x * s / sm;
  for (int a = 0; a < 3; ++a) r[a] = f * r0[a] + g * v0[a];
  const cplx rn = std::sqrt(dot(r, r));
  const cplx fd = sm / (rn * r0n) * x * (z * s - 1.0), gd = 1.0 - x * x * c / rn;
  for (int a = 0; a < 3; ++a) v[a] = fd * r0[a] + gd * v0[a];
  return std::isfinite(r[0].real()) && std::isfinite(v[0].real());
}
// Phi of two-body motion from (r0, v0) over dt, by complex step (h = 1e-20).
bool two_body_stm(const double r0[3], const double v0[3], double dt, Mat6* phi) {
  constexpr double h = 1e-20;
  for (int k = 0; k < 6; ++k) {
    cplx r[3], v[3], rc[3], vc[3];
    for (int a = 0; a < 3; ++a) {
      rc[a] = cplx(r0[a], k == a ? h : 0.0);
      vc[a] = cplx(v0[a], k == a + 3 ? h : 0.0);
    }
    if (!kepler(rc, vc, dt, r, v)) return false;
    for (int a = 0; a < 3; ++a) {
      (*phi)[6 * a + k] = r[a].imag() / h;
      (*phi)[6 * (a + 3) + k] = v[a].imag() / h;
    }
  }
  return true;
}

// ── Thompson et al. (2019): the Lambert arc between two SGP4 positions ──
struct Arc {
  std::string error;
  int revolutions = 0;
  std::string branch;
  double v1[3] = {};
  double energy = 0, sgp4_energy = 0;
};
Arc lambert_arc(const double r1[3], const double v1s[3], const double r2[3], double dt) {
  Arc arc;
  const double r1n = std::sqrt(r1[0] * r1[0] + r1[1] * r1[1] + r1[2] * r1[2]);
  const double r2n = std::sqrt(r2[0] * r2[0] + r2[1] * r2[1] + r2[2] * r2[2]);
  const double vv = v1s[0] * v1s[0] + v1s[1] * v1s[1] + v1s[2] * v1s[2];
  arc.sgp4_energy = vv / 2 - kMu / r1n;
  const double a = 1.0 / (2.0 / r1n - vv / kMu);  // eq. 16
  if (!(a > 0)) { arc.error = "SGP4 state not elliptic"; return arc; }
  const double period = 2 * kPi * std::sqrt(a * a * a / kMu);  // eq. 17
  int n = static_cast<int>(std::floor(dt / period));          // eq. 18
  const double c12[3] = {r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]};
  const double h[3] = {r1[1] * v1s[2] - r1[2] * v1s[1], r1[2] * v1s[0] - r1[0] * v1s[2], r1[0] * v1s[1] - r1[1] * v1s[0]};
  const double sin_angle = std::sqrt(c12[0] * c12[0] + c12[1] * c12[1] + c12[2] * c12[2]) / (r1n * r2n);
  if (sin_angle < std::sin(kDeg)) {
    // Within a revolution and within a degree of the start (seconds or minutes
    // of arc): the Lambert plane is undefined and the arc it tends to is SGP4's
    // osculating one, so that arc is used.
    if (n == 0 && r1[0] * r2[0] + r1[1] * r2[1] + r1[2] * r2[2] > 0) {
      std::copy(v1s, v1s + 3, arc.v1);
      arc.branch = "short-arc";
      arc.energy = arc.sgp4_energy;
      return arc;
    }
    arc.error = "transfer angle within 1 degree of 0 or 180 degrees";
    return arc;
  }
  lambert_izzo::Request q;
  q.r1 = {r1[0], r1[1], r1[2]};
  q.r2 = {r2[0], r2[1], r2[2]};
  q.tof = dt;
  q.mu = kMu;
  q.long_way = c12[0] * h[0] + c12[1] * h[1] + c12[2] * h[2] < 0;
  for (; n >= 0; --n) {
    if (n == 0) {
      q.max_revolutions = 0;
      const lambert_izzo::Result res = lambert_izzo::solve(q);
      if (res.status != lambert_izzo::Status::Ok) { arc.error = "Lambert solver did not converge"; return arc; }
      arc.branch = "single";
      arc.v1[0] = res.single.v1.x; arc.v1[1] = res.single.v1.y; arc.v1[2] = res.single.v1.z;
      break;
    }
    const lambert_izzo::Result res = lambert_izzo::solve_revolutions(q, static_cast<uint32_t>(n));
    if (res.status == lambert_izzo::Status::InvalidInput) continue;  // too short for n: n - 1
    if (res.status != lambert_izzo::Status::Ok) { arc.error = "Lambert solver did not converge"; return arc; }
    const lambert_izzo::Solution* best = nullptr;
    for (const auto* cand : {&res.multi[0].long_period, &res.multi[0].short_period}) {  // eq. 19
      const double e = (cand->v1.x * cand->v1.x + cand->v1.y * cand->v1.y + cand->v1.z * cand->v1.z) / 2 - kMu / r1n;
      if (!best || std::fabs(e - arc.sgp4_energy) < std::fabs(arc.energy - arc.sgp4_energy)) {
        best = cand;
        arc.energy = e;
        arc.branch = cand == &res.multi[0].long_period ? "long-period" : "short-period";
      }
    }
    arc.v1[0] = best->v1.x; arc.v1[1] = best->v1.y; arc.v1[2] = best->v1.z;
    break;
  }
  arc.revolutions = std::max(n, 0);
  const double ve = arc.v1[0] * arc.v1[0] + arc.v1[1] * arc.v1[1] + arc.v1[2] * arc.v1[2];
  arc.energy = ve / 2 - kMu / r1n;
  return arc;
}

std::array<double, 21> lower_of(const Mat6& m) {
  std::array<double, 21> l{};
  for (int a = 0, t = 0; a < 6; ++a)
    for (int b = 0; b <= a; ++b, ++t) l[t] = 0.5 * (m[6 * a + b] + m[6 * b + a]);
  return l;
}

}  // namespace stm

extern "C" int map_covariance() {
  using namespace stm;
  const nlohmann::json opt = json_input("options");
  if (!opt.is_object() || !opt.contains("requests") || !opt["requests"].is_array())
    return fail("invalid-options", "options must be JSON with a requests array.");
  Options defaults;
  default_options(&defaults);
  Counts counts;
  std::vector<ElementSet> sets;
  if (!load_elements(defaults, sets, counts)) return fail("invalid-elements", error_text);
  nlohmann::json results = nlohmann::json::array();
  uint64_t mapped = 0, refused = 0;
  for (const auto& req : opt["requests"]) {
    if (!req.is_object() || !req.contains("norad") || !req["norad"].is_number_unsigned() || !req.contains("set") ||
        !req["set"].is_string() || !req.contains("covariance") || !req["covariance"].is_array() ||
        req["covariance"].size() != 21 || !req.contains("to") || !req["to"].is_array())
      return fail("invalid-options", "each request needs norad, set, covariance (21) and to.");
    const std::string method = req.value("method", std::string("sgp4"));
    if (method != "sgp4" && method != "two-body" && method != "lambert")
      return fail("invalid-options", "method is sgp4, two-body or lambert.");
    const bool want_stm = req.value("stm", false);
    const uint32_t norad = req["norad"].get<uint32_t>();
    Instant set_epoch;
    if (!parse_instant(req["set"].get<std::string>(), &set_epoch)) return fail("invalid-options", "set is not ISO 8601 UTC.");
    nlohmann::json row{{"norad", norad}, {"set", req["set"]}, {"method", method}};
    ElementSet* s = common::find_set(sets, norad, set_epoch);
    if (!s) {
      row["error"] = "element set not found";
      ++refused;
      results.push_back(row);
      continue;
    }
    Instant t0 = s->epoch;
    if (req.contains("from") && (!req["from"].is_string() || !parse_instant(req["from"].get<std::string>(), &t0)))
      return fail("invalid-options", "from is not ISO 8601 UTC.");
    row["from"] = req.contains("from") ? req["from"] : nlohmann::json(s->epoch_text);
    Mat6 c0{};
    for (int a = 0, t = 0; a < 6; ++a)
      for (int b = 0; b <= a; ++b, ++t) {
        if (!req["covariance"][t].is_number()) return fail("invalid-options", "covariance entries are numbers.");
        c0[6 * a + b] = c0[6 * b + a] = req["covariance"][t].get<double>();
      }
    std::vector<Instant> targets;
    for (const auto& t : req["to"]) {
      Instant at;
      if (!t.is_string() || !parse_instant(t.get<std::string>(), &at)) return fail("invalid-options", "to holds ISO 8601 UTC epochs.");
      targets.push_back(at);
    }
    // Nominal SGP4 states (TEME) at t0 and at each target.
    const double m0 = seconds_between(s->epoch, t0) / 60.0;
    double r0[3], v0[3];
    if (!propagate(*s, m0, r0, v0)) {
      row["error"] = "SGP4 failed at the covariance epoch";
      ++refused;
      results.push_back(row);
      continue;
    }
    // The covariance's axes: the anchor's state at t0, or with axesSet another
    // set's state there (Thompson et al. rotate the final set's scatter with
    // the final set's own state before mapping it back along the first set).
    Mat6 b0 = rtn_block(r0, v0);
    if (req.contains("axesSet")) {
      Instant at;
      if (!req["axesSet"].is_string() || !parse_instant(req["axesSet"].get<std::string>(), &at))
        return fail("invalid-options", "axesSet is not ISO 8601 UTC.");
      ElementSet* a = common::find_set(sets, norad, at);
      double ra[3], va[3];
      if (!a || !propagate(*a, seconds_between(a->epoch, t0) / 60.0, ra, va)) {
        row["error"] = "axes set not found or not propagated";
        ++refused;
        results.push_back(row);
        continue;
      }
      b0 = rtn_block(ra, va);
      row["axesSet"] = a->epoch_text;
    }
    const Mat6 cart0 = multiply(multiply(transpose(b0), c0), b0);  // RTN -> TEME
    std::vector<double> minutes{m0};
    for (const Instant& t : targets) minutes.push_back(seconds_between(s->epoch, t) / 60.0);
    std::vector<Mat6> jac;
    Mat6 j0inv{};
    bool sgp4_ok = true;
    if (method == "sgp4") sgp4_ok = sgp4_jacobians(*s, minutes, &jac) && invert(jac[0], &j0inv);
    nlohmann::json outs = nlohmann::json::array();
    for (size_t k = 0; k < targets.size(); ++k) {
      nlohmann::json o{{"epoch", req["to"][k]}};
      double r[3], v[3];
      const double dt = (minutes[k + 1] - m0) * 60.0;
      Mat6 phi{};
      std::string err;
      if (!propagate(*s, minutes[k + 1], r, v)) {
        err = "SGP4 failed at the target";
      } else if (method == "sgp4") {
        if (!sgp4_ok) err = "SGP4 Jacobian failed";
        else phi = multiply(jac[k + 1], j0inv);
      } else if (method == "two-body") {
        if (!two_body_stm(r0, v0, dt, &phi)) err = "Kepler solution did not converge";
      } else {
        // The arc runs forward in time, from the earlier of (t0, target) to the later.
        const bool forward = dt >= 0;
        const double* ra = forward ? r0 : r;
        const double* va = forward ? v0 : v;
        const double* rb = forward ? r : r0;
        if (std::fabs(dt) < 1e-6) {
          for (int i = 0; i < 6; ++i) phi[7 * i] = 1;
        } else {
          const Arc arc = lambert_arc(ra, va, rb, std::fabs(dt));
          if (!arc.error.empty()) {
            err = arc.error;
          } else {
            Mat6 fwd{};
            if (!two_body_stm(ra, arc.v1, std::fabs(dt), &fwd)) err = "Kepler solution did not converge";
            else if (forward) phi = fwd;
            else if (!invert(fwd, &phi)) err = "singular Lambert STM";
            o["lambert"] = {{"revolutions", arc.revolutions}, {"branch", arc.branch},
                            {"v1", {arc.v1[0], arc.v1[1], arc.v1[2]}}, {"energy", arc.energy},
                            {"sgp4Energy", arc.sgp4_energy}};
          }
        }
      }
      if (!err.empty()) {
        o["error"] = err;
        ++refused;
        outs.push_back(o);
        continue;
      }
      const Mat6 bt = rtn_block(r, v);
      const Mat6 cart = multiply(multiply(phi, cart0), transpose(phi));
      const Mat6 rtn = multiply(multiply(bt, cart), transpose(bt));
      const std::array<double, 21> l = lower_of(rtn);
      o["covariance"] = l;
      if (want_stm) o["stm"] = phi;
      outs.push_back(o);
      ++mapped;
    }
    row["targets"] = outs;
    results.push_back(row);
  }
  return emit("covariance", {{"kind", "covariance-map"}, {"version", 1},
                             {"units", "km, km/s; RTN axes of the anchor set's SGP4 state; stm in TEME (km, km/s)"},
                             {"counts", {{"elementSets", counts.records}, {"refused", counts.refused},
                                         {"duplicateEpochs", counts.duplicates}, {"mapped", mapped}, {"failed", refused}}},
                             {"results", results}});
}
