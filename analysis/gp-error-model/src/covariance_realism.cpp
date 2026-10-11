// Covariance realism by data source (orbit-accuracy-experiments E14). Built in one translation unit after
// gp_error_model.cpp, common_epoch.cpp and state_transition.cpp, whose JSON frames, element loading, regime rule,
// RTN axes, positive-definite test and 6x6 algebra it uses. Units are SI throughout (m, m/s; m^2, m^2/s, m^2/s^2)
// unless a field says otherwise.
//
// pair_statistics       a predicted and a truth state, each with a covariance (RTN or inertial axes), or ephemeris samples
//                       interpolated at an epoch (Lagrange through the nearest degree + 1, covariance linear): the error in
//                       the RTN axes of the predicted state (or the truth's), both position covariances in those
//                       axes, d^2 against the combined covariance and against the predicted one alone, and the
//                       per-axis standardized errors. Operator file pairs, HPOP samples, element-set samples.
// fit_calibration       samples (stratum, RTN error, RTN position covariance): per stratum a variance factor by
//                       maximum likelihood (scalar k^2 = mean d^2 / 3), per-axis factors (s_k^2 = mean e_k^2 / P_kk,
//                       the marginal maximum likelihood per axis), or the factor that puts the stated coverage
//                       quantile of d^2 at its chi-square(3) value; with d^2 statistics before and after.
// calibrate_covariance  a frozen model applied to objects: factors by regime and horizon applied to a native
//                       covariance (operator files), or an element-set model (6x6 RTN second moment by regime and
//                       age, linear in age between bin centres, times its factor); the result in RTN and, given a
//                       state, in inertial axes, with the cell, the model's version and the cell's status.
// dcp_covariance        the density-forecast consider term: daily ln-density forecast errors by lead with
//                       covariance C, weighted over a prediction from its start s0 to t as a constant error would
//                       act on the along-track position, w_l = sum over lead-l segments of
//                       ((t - a)^2 - (t - b)^2) / (t - s0)^2 ([a, b] the segment clipped to [s0, t]; at three days
//                       of whole lead days 5/9, 3/9, 1/9), sigma_eff^2 = w' C w, and P = sigma_eff^2 g g', g the
//                       state's sensitivity to ln B from s0 (B dx/dB from HPOP, or B (S(t) - Phi(t) Phi(s0)^-1 S(s0))
//                       from samples that start earlier).

namespace covreal {

constexpr double kMuWgs84 = 3.986004418e14;  // m^3/s^2
constexpr double kReWgs84 = 6378137.0;       // m
constexpr double kChi2Q95 = 7.814727903251178;

bool vec(const nlohmann::json& j, size_t n, double* out) {
  if (!j.is_array() || j.size() != n) return false;
  for (size_t k = 0; k < n; ++k) {
    if (!j[k].is_number()) return false;
    out[k] = j[k].get<double>();
    if (!std::isfinite(out[k])) return false;
  }
  return true;
}
// A covariance given as a lower triangle (6 entries: 3x3; 21 entries: 6x6, row-major RR, TR, TT, NR, ...) or a full
// row-major matrix (9 or 36 entries), as a full 6x6 (a 3x3 fills the position block; the rest zero). `dim` is 3 or 6.
bool covariance_of(const nlohmann::json& j, double out[36], int* dim) {
  if (!j.is_array()) return false;
  const size_t n = j.size();
  std::fill(out, out + 36, 0.0);
  double v[36];
  if (n == 6 || n == 21) {
    const int d = n == 6 ? 3 : 6;
    if (!vec(j, n, v)) return false;
    for (int a = 0, t = 0; a < d; ++a)
      for (int b = 0; b <= a; ++b, ++t) out[6 * a + b] = out[6 * b + a] = v[t];
    *dim = d;
    return true;
  }
  if (n == 9 || n == 36) {
    const int d = n == 9 ? 3 : 6;
    if (!vec(j, n, v)) return false;
    for (int a = 0; a < d; ++a)
      for (int b = 0; b < d; ++b) out[6 * a + b] = 0.5 * (v[d * a + b] + v[d * b + a]);
    *dim = d;
    return true;
  }
  return false;
}
std::vector<double> lower21(const double m[36]) {
  std::vector<double> out;
  for (int a = 0; a < 6; ++a)
    for (int b = 0; b <= a; ++b) out.push_back(m[6 * a + b]);
  return out;
}
std::vector<double> lower6(const double m[36]) { return {m[0], m[6], m[7], m[12], m[13], m[14]}; }
std::vector<double> full36(const double m[36]) { return std::vector<double>(m, m + 36); }

// RTN rows (R, T, N) of a state.
void axes_of(const double r[3], const double v[3], double a[3][3]) { hpopcal::rtn_axes(r, v, a); }
// out = J m J' with J = blockdiag(A, A) (inertial -> RTN), or J' m J (RTN -> inertial).
void rotate6(const double a[3][3], const double m[36], double out[36], bool to_rtn) {
  double j[36] = {};
  for (int blk = 0; blk < 2; ++blk)
    for (int i = 0; i < 3; ++i)
      for (int k = 0; k < 3; ++k) j[6 * (3 * blk + i) + 3 * blk + k] = to_rtn ? a[i][k] : a[k][i];
  double jm[36] = {};
  for (int r = 0; r < 6; ++r)
    for (int c = 0; c < 6; ++c)
      for (int k = 0; k < 6; ++k) jm[6 * r + c] += j[6 * r + k] * m[6 * k + c];
  for (int r = 0; r < 6; ++r)
    for (int c = 0; c <= r; ++c) {
      double s = 0;
      for (int k = 0; k < 6; ++k) s += jm[6 * r + k] * j[6 * c + k];
      out[6 * r + c] = out[6 * c + r] = s;
    }
}
// d^2 = e' P^-1 e for the 3x3 position block of a full 6x6; false unless positive definite.
bool d2_of(const double m[36], const double e[3], double* d2, double* logdet = nullptr) {
  const double p[6] = {m[0], m[6], m[12], m[7], m[13], m[14]};  // xx, xy, xz, yy, yz, zz
  double ld = 0;
  if (!hpopcal::gauss_terms(p, e, &ld, d2)) return false;
  if (logdet) *logdet = ld;
  return true;
}

// Osculating mean altitude (a - R_E, km) and eccentricity of an inertial state (WGS-84).
void osculating(const double r[3], const double v[3], double* alt_km, double* ecc) {
  const double rn = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  const double v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const double a = 1.0 / (2.0 / rn - v2 / kMuWgs84);
  const double rv = r[0] * v[0] + r[1] * v[1] + r[2] * v[2];
  double e[3];
  for (int k = 0; k < 3; ++k) e[k] = ((v2 - kMuWgs84 / rn) * r[k] - rv * v[k]) / kMuWgs84;
  *ecc = std::sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
  *alt_km = a > 0 ? (a - kReWgs84) / 1e3 : 1e12;
}

double json_number(const nlohmann::json& o, const char* key, double fallback) {
  return o.is_object() && o.contains(key) && o[key].is_number() ? o[key].get<double>() : fallback;
}
std::string json_string(const nlohmann::json& o, const char* key) {
  return o.is_object() && o.contains(key) && o[key].is_string() ? o[key].get<std::string>() : std::string();
}
// An id as given (string or number) for echoing.
nlohmann::json id_of(const nlohmann::json& o) { return o.is_object() && o.contains("id") ? o["id"] : nlohmann::json(nullptr); }

// Linear interpolation of per-bin values at x between bin centres (clamped at the ends); `have` marks usable bins.
template <class Get>
bool interpolate_bins(const std::vector<std::pair<double, double>>& bins, const std::vector<bool>& have, double x, Get get, size_t width,
                      std::vector<double>* out) {
  std::vector<int> usable;
  for (size_t i = 0; i < bins.size(); ++i)
    if (have[i]) usable.push_back(static_cast<int>(i));
  if (usable.empty()) return false;
  auto centre = [&](int i) { return 0.5 * (bins[i].first + bins[i].second); };
  out->assign(width, 0.0);
  if (x <= centre(usable.front()) || usable.size() == 1) {
    for (size_t k = 0; k < width; ++k) (*out)[k] = get(usable.front(), k);
    return true;
  }
  if (x >= centre(usable.back())) {
    for (size_t k = 0; k < width; ++k) (*out)[k] = get(usable.back(), k);
    return true;
  }
  for (size_t u = 0; u + 1 < usable.size(); ++u) {
    const int i = usable[u], j = usable[u + 1];
    if (x >= centre(i) && x <= centre(j)) {
      const double f = (x - centre(i)) / (centre(j) - centre(i));
      for (size_t k = 0; k < width; ++k) (*out)[k] = (1 - f) * get(i, k) + f * get(j, k);
      return true;
    }
  }
  return false;
}


// A side given as ephemeris samples and an epoch: position and velocity by Lagrange interpolation through the
// degree + 1 samples nearest the epoch (the container's rule, e.g. a CCSDS OEM's INTERPOLATION_DEGREE), the
// covariance linear between the two samples that bracket it (a sample's own at its epoch). No extrapolation:
// an epoch outside the samples is reported, not guessed.
std::string interpolate_side(const nlohmann::json& side, nlohmann::json* out) {
  Instant t;
  if (!parse_instant(json_string(side, "epoch"), &t)) return "a side with samples needs epoch (ISO 8601 UTC).";
  const nlohmann::json& samples = side["samples"];
  if (!samples.is_array() || samples.size() < 2) return "samples is an array of at least two {epoch, position, velocity, covariance?}.";
  const int degree = static_cast<int>(json_number(side, "interpolationDegree", 5));
  if (degree < 1) return "interpolationDegree is at least 1.";
  const size_t n = samples.size();
  std::vector<double> dt(n), pv(6 * n);
  for (size_t i = 0; i < n; ++i) {
    Instant ti;
    if (!samples[i].is_object() || !parse_instant(json_string(samples[i], "epoch"), &ti) || !vec(samples[i]["position"], 3, &pv[6 * i]) ||
        !vec(samples[i]["velocity"], 3, &pv[6 * i + 3]))
      return "each sample needs epoch, position [3] and velocity [3].";
    dt[i] = seconds_between(t, ti);
    if (i && !(dt[i] > dt[i - 1])) return "samples are in strictly increasing time order.";
  }
  if (dt[0] > 1e-6 || dt[n - 1] < -1e-6) return "outside";
  size_t hi = 0;
  while (hi < n && dt[hi] < 0) ++hi;  // first sample at or after the epoch
  const size_t m = std::min(n, static_cast<size_t>(degree) + 1);
  size_t start = hi >= m / 2 ? hi - m / 2 : 0;
  if (start + m > n) start = n - m;
  std::vector<double> x(6, 0.0);
  for (size_t j = start; j < start + m; ++j) {
    double w = 1;
    for (size_t k = start; k < start + m; ++k)
      if (k != j) w *= (0 - dt[k]) / (dt[j] - dt[k]);
    for (int c = 0; c < 6; ++c) x[c] += w * pv[6 * j + c];
  }
  (*out)["position"] = std::vector<double>(x.begin(), x.begin() + 3);
  (*out)["velocity"] = std::vector<double>(x.begin() + 3, x.end());
  (*out)["covarianceAxes"] = side.value("covarianceAxes", std::string("RTN"));
  const size_t a = hi < n && std::fabs(dt[hi]) <= 1e-6 ? hi : (hi == 0 ? 0 : hi - 1), b = std::min(n - 1, a + 1);
  if (samples[a].contains("covariance") && !samples[a]["covariance"].is_null()) {
    double ca[36], cb[36];
    int da = 0, db = 0;
    if (!covariance_of(samples[a]["covariance"], ca, &da)) return "a sample's covariance is a lower triangle (6 or 21) or a full matrix (9 or 36).";
    double f = 0;
    if (b != a && std::fabs(dt[a]) > 1e-6) {
      if (!samples[b].contains("covariance") || !covariance_of(samples[b]["covariance"], cb, &db) || db != da) return "bracketing samples need covariances of one size.";
      f = (0 - dt[a]) / (dt[b] - dt[a]);
    } else {
      std::copy(ca, ca + 36, cb);
    }
    std::vector<double> c(36);
    for (int k = 0; k < 36; ++k) c[k] = (1 - f) * ca[k] + f * cb[k];
    (*out)["covariance"] = c;
  }
  (*out)["interpolated"] = {{"degree", static_cast<int>(m) - 1}, {"from", start}, {"samples", m}};
  return {};
}
}  // namespace covreal

// ── pair_statistics ──
extern "C" int pair_statistics() {
  using namespace covreal;
  const nlohmann::json in = json_input("pairs");
  if (!in.is_object() || !in.contains("pairs") || !in["pairs"].is_array()) return fail("invalid-pairs", "pairs must be JSON {pairs: [...]}.");
  const std::string axes_from = in.value("axesFrom", std::string("predicted"));
  if (axes_from != "predicted" && axes_from != "truth") return fail("invalid-pairs", "axesFrom is predicted or truth.");
  nlohmann::json rows = nlohmann::json::array();
  uint64_t not_pd = 0, without_truth_cov = 0;
  for (const auto& p : in["pairs"]) {
    if (!p.is_object() || !p.contains("predicted") || !p.contains("truth")) return fail("invalid-pairs", "each pair needs predicted and truth.");
    nlohmann::json resolved[2];
    std::string missing;
    for (int side = 0; side < 2 && missing.empty(); ++side) {
      const nlohmann::json& given = p[side ? "truth" : "predicted"];
      if (given.is_object() && given.contains("samples")) {
        const std::string e = interpolate_side(given, &resolved[side]);
        if (e == "outside") missing = std::string(side ? "truth" : "predicted") + " epoch outside its samples";
        else if (!e.empty()) return fail("invalid-pairs", e);
      } else {
        resolved[side] = given;
      }
    }
    if (!missing.empty()) {
      rows.push_back({{"id", id_of(p)}, {"missing", missing}});
      continue;
    }
    const nlohmann::json& pr = resolved[0];
    const nlohmann::json& tr = resolved[1];
    double rp[3], vp[3], rt[3], vt[3];
    if (!pr.is_object() || !tr.is_object() || !vec(pr["position"], 3, rp) || !vec(pr["velocity"], 3, vp) || !vec(tr["position"], 3, rt) ||
        !vec(tr["velocity"], 3, vt))
      return fail("invalid-pairs", "predicted and truth need position [3] (m) and velocity [3] (m/s), inertial, one frame.");
    double a[3][3];
    if (axes_from == "predicted") axes_of(rp, vp, a);
    else axes_of(rt, vt, a);
    // Each covariance into the chosen RTN axes. RTN or UVW covariances are taken in their own state's axes and
    // rotated through inertial axes when the other state's axes are used.
    auto to_axes = [&](const nlohmann::json& side, const double r[3], const double v[3], double out[36], bool* present) -> std::string {
      *present = false;
      double m[36] = {};
      int dim = 0;
      if (side.contains("covarianceTerms")) {
        // A weighted sum of covariances in the same axes (e.g. A + q_R U_R + q_T U_T + q_N U_N + a consider term).
        const nlohmann::json& terms = side["covarianceTerms"];
        if (!terms.is_array() || terms.empty()) return "covarianceTerms is a non-empty array of {weight, covariance}.";
        for (const auto& term : terms) {
          double c[36];
          int d = 0;
          if (!term.is_object() || !term.contains("covariance") || !covariance_of(term["covariance"], c, &d))
            return "each covariance term needs a covariance (lower 6 or 21, or full 9 or 36).";
          const double w = json_number(term, "weight", 1.0);
          if (!(w >= 0)) return "covariance term weights are non-negative.";
          for (int k = 0; k < 36; ++k) m[k] += w * c[k];
          dim = std::max(dim, d);
        }
      } else {
        if (!side.contains("covariance") || side["covariance"].is_null()) return {};
        if (!covariance_of(side["covariance"], m, &dim)) return "covariance is a lower triangle (6 or 21) or a full matrix (9 or 36).";
      }
      const std::string axes = side.value("covarianceAxes", std::string("RTN"));
      double inertial[36];
      if (axes == "RTN" || axes == "UVW") {
        double own[3][3];
        axes_of(r, v, own);
        rotate6(own, m, inertial, false);
      } else if (axes == "INERTIAL") {
        std::copy(m, m + 36, inertial);
      } else {
        return "covarianceAxes is RTN, UVW or INERTIAL.";
      }
      rotate6(a, inertial, out, true);
      if (dim == 3)
        for (int r6 = 0; r6 < 6; ++r6)
          for (int c6 = 0; c6 < 6; ++c6)
            if (r6 >= 3 || c6 >= 3) out[6 * r6 + c6] = 0;
      *present = true;
      return {};
    };
    double pp[36], pt[36];
    bool has_p = false, has_t = false;
    std::string e = to_axes(pr, rp, vp, pp, &has_p);
    if (e.empty()) e = to_axes(tr, rt, vt, pt, &has_t);
    if (!e.empty()) return fail("invalid-pairs", e);
    if (!has_p) return fail("invalid-pairs", "the predicted state needs a covariance.");
    double err[3], verr[3];
    for (int k = 0; k < 3; ++k) {
      err[k] = (rp[0] - rt[0]) * a[k][0] + (rp[1] - rt[1]) * a[k][1] + (rp[2] - rt[2]) * a[k][2];
      verr[k] = (vp[0] - vt[0]) * a[k][0] + (vp[1] - vt[1]) * a[k][1] + (vp[2] - vt[2]) * a[k][2];
    }
    double comb[36];
    for (int k = 0; k < 36; ++k) comb[k] = pp[k] + (has_t ? pt[k] : 0.0);
    if (!has_t) ++without_truth_cov;
    nlohmann::json row{{"id", id_of(p)}, {"errorRtn", std::vector<double>(err, err + 3)}, {"velocityErrorRtn", std::vector<double>(verr, verr + 3)},
                       {"predictedInterpolated", pr.contains("interpolated") ? pr["interpolated"] : nlohmann::json(nullptr)},
                       {"predictedRtn", lower6(pp)}, {"truthRtn", has_t ? nlohmann::json(lower6(pt)) : nlohmann::json(nullptr)}};
    double d2c = 0, d2p = 0, ldc = 0;
    const bool okc = d2_of(comb, err, &d2c, &ldc), okp = d2_of(pp, err, &d2p);
    if (!okc || !okp) ++not_pd;
    row["d2Combined"] = okc ? nlohmann::json(d2c) : nlohmann::json(nullptr);
    row["logDetCombined"] = okc ? nlohmann::json(ldc) : nlohmann::json(nullptr);
    row["d2Predicted"] = okp ? nlohmann::json(d2p) : nlohmann::json(nullptr);
    std::vector<double> zc(3), zp(3);
    for (int k = 0; k < 3; ++k) {
      zc[k] = comb[7 * k] > 0 ? err[k] / std::sqrt(comb[7 * k]) : std::nan("");
      zp[k] = pp[7 * k] > 0 ? err[k] / std::sqrt(pp[7 * k]) : std::nan("");
    }
    row["zCombined"] = zc;
    row["zPredicted"] = zp;
    rows.push_back(row);
  }
  return emit("statistics", {{"kind", "e14-pair-statistics"}, {"version", 1}, {"axes", axes_from == "predicted" ? "RTN of the predicted state" : "RTN of the truth state"},
                             {"units", "m, m/s, m^2; error = predicted - truth; lower triangles RR, TR, TT, NR, NT, NN"},
                             {"counts", {{"pairs", rows.size()}, {"notPositiveDefinite", not_pd}, {"withoutTruthCovariance", without_truth_cov}}},
                             {"pairs", rows}});
}

// ── fit_calibration ──
extern "C" int fit_calibration() {
  using namespace covreal;
  const nlohmann::json in = json_input("samples");
  if (!in.is_object() || !in.contains("samples") || !in["samples"].is_array()) return fail("invalid-samples", "samples must be JSON {samples: [...]}.");
  const nlohmann::json opt = input("options") ? json_input("options") : nlohmann::json::object();
  if (!opt.is_object()) return fail("invalid-options", "options must be a JSON object.");
  const std::string method = opt.value("method", std::string("scalar-mle"));
  if (method != "scalar-mle" && method != "axes-mle" && method != "coverage") return fail("invalid-options", "method is scalar-mle, axes-mle or coverage.");
  const double coverage = json_number(opt, "coverage", 0.95);
  if (!(coverage > 0 && coverage < 1)) return fail("invalid-options", "coverage is in (0, 1).");
  const double target_q = chi2_quantile3(coverage);
  const double min_samples = json_number(opt, "minimumSamples", 1), min_objects = json_number(opt, "minimumObjects", 1);
  struct S {
    std::vector<double> d2, z2[3];
    std::vector<std::array<double, 3>> e;
    std::vector<std::array<double, 36>> p;
    std::set<std::string> objects;
    uint64_t not_pd = 0;
  };
  std::map<std::string, S> strata;
  std::vector<std::string> order;
  for (const auto& s : in["samples"]) {
    double e[3], m[36];
    int dim = 0;
    if (!s.is_object() || !s.contains("stratum") || !s["stratum"].is_string() || !vec(s["error"], 3, e) || !s.contains("covariance") ||
        !covariance_of(s["covariance"], m, &dim))
      return fail("invalid-samples", "each sample needs stratum (string), error [3] and covariance (lower 6 or full 9, the same units squared).");
    const std::string key = s["stratum"].get<std::string>();
    if (!strata.count(key)) order.push_back(key);
    S& st = strata[key];
    st.objects.insert(s.contains("object") ? s["object"].dump() : std::string("-"));
    double d2 = 0;
    if (!d2_of(m, e, &d2)) { ++st.not_pd; continue; }
    st.d2.push_back(d2);
    for (int k = 0; k < 3; ++k) st.z2[k].push_back(e[k] * e[k] / m[7 * k]);
    std::array<double, 3> ea{e[0], e[1], e[2]};
    std::array<double, 36> pa;
    std::copy(m, m + 36, pa.begin());
    st.e.push_back(ea);
    st.p.push_back(pa);
  }
  auto summary = [&](const std::vector<double>& d2) {
    double sum = 0;
    uint64_t inside = 0;
    for (double x : d2) { sum += x; inside += x <= kChi2Q95; }
    const double n = static_cast<double>(std::max<size_t>(1, d2.size()));
    return nlohmann::json{{"meanD2Over3", sum / n / 3.0}, {"coverage95", inside / n}};
  };
  nlohmann::json out = nlohmann::json::array();
  for (const std::string& key : order) {
    S& st = strata[key];
    nlohmann::json row{{"stratum", key}, {"n", st.d2.size()}, {"objects", st.objects.size()}, {"notPositiveDefinite", st.not_pd}};
    const bool enough = st.d2.size() >= min_samples && st.objects.size() >= min_objects && !st.d2.empty();
    row["status"] = enough ? "FITTED" : "INSUFFICIENT";
    if (!st.d2.empty()) row["before"] = summary(st.d2);
    if (enough) {
      std::vector<double> after;
      if (method == "scalar-mle" || method == "coverage") {
        double k2 = 0;
        if (method == "scalar-mle") {
          double sum = 0;
          for (double x : st.d2) sum += x;
          k2 = sum / st.d2.size() / 3.0;
        } else {
          std::vector<double> d = st.d2;
          std::sort(d.begin(), d.end());
          // The empirical quantile (type 7, linear between order statistics) of d^2 at `coverage`.
          const double h = (d.size() - 1) * coverage;
          const size_t lo = static_cast<size_t>(std::floor(h)), hi = std::min(d.size() - 1, lo + 1);
          const double q = d[lo] + (d[hi] - d[lo]) * (h - lo);
          k2 = q / target_q;
        }
        row["factor"] = k2;
        for (double x : st.d2) after.push_back(k2 > 0 ? x / k2 : std::numeric_limits<double>::infinity());
      } else {
        std::vector<double> s2(3);
        for (int k = 0; k < 3; ++k) {
          double sum = 0;
          for (double z : st.z2[k]) sum += z;
          s2[k] = sum / st.z2[k].size();
        }
        row["axesFactors"] = s2;
        // d^2 after: P' = S P S, S = diag(sqrt(s2)) in the position block.
        for (size_t i = 0; i < st.e.size(); ++i) {
          double m[36];
          std::copy(st.p[i].begin(), st.p[i].end(), m);
          for (int r6 = 0; r6 < 3; ++r6)
            for (int c6 = 0; c6 < 3; ++c6) m[6 * r6 + c6] *= std::sqrt(s2[r6] * s2[c6]);
          double d2 = 0;
          after.push_back(d2_of(m, st.e[i].data(), &d2) ? d2 : std::numeric_limits<double>::infinity());
        }
      }
      row["after"] = summary(after);
    }
    out.push_back(row);
  }
  return emit("calibration", {{"kind", "e14-calibration"}, {"version", 1}, {"method", method}, {"coverage", coverage},
                              {"rule", method == "scalar-mle" ? "variance factor k^2 = mean d^2 / 3 (maximum likelihood of a common scale)"
                                       : method == "coverage" ? "variance factor k^2 = the d^2 quantile at the coverage / its chi-square(3) value"
                                                               : "per-axis variance factors s_k^2 = mean (e_k^2 / P_kk) (marginal maximum likelihood); P' = S P S"},
                              {"strata", out}});
}

// ── calibrate_covariance ──
namespace covreal {

struct FactorCell {
  std::string regime;  // "*" for any
  double lo = 0, hi = 0;
  bool axes = false;
  double factor = 1, s2[3] = {1, 1, 1};
  std::string status;
};
struct SetModel {
  Options options;  // regimes and age bins (gp-error-model's)
  std::map<std::pair<int, int>, std::array<double, 21>> cov;  // km, km/s
  std::map<std::pair<int, int>, double> factor, n;
  std::map<std::pair<int, int>, std::string> status;
  double minimum_bin_samples = 0;
};

std::string read_set_model(const nlohmann::json& j, SetModel* m) {
  nlohmann::json opt{{"regimes", j.contains("regimes") ? j["regimes"] : nlohmann::json()}, {"ageBinsDays", j.contains("ageBinsDays") ? j["ageBinsDays"] : nlohmann::json()}};
  std::string e = parse_options(opt, &m->options);
  if (!e.empty()) return e;
  m->minimum_bin_samples = json_number(j, "minimumBinSamples", 0);
  if (!j.contains("strata") || !j["strata"].is_array()) return "an element-set model needs strata [{regimeIndex, ageIndex, n, covariance[21]}].";
  for (const auto& s : j["strata"]) {
    if (!s.is_object() || !s.contains("regimeIndex") || !s["regimeIndex"].is_number_integer() || !s.contains("ageIndex") ||
        !s["ageIndex"].is_number_integer())
      return "each stratum needs integer regimeIndex and ageIndex.";
    const std::pair<int, int> key{s["regimeIndex"].get<int>(), s["ageIndex"].get<int>()};
    std::array<double, 21> c{};
    if (!vec(s["covariance"], 21, c.data())) return "each stratum's covariance is 21 numbers (lower triangle, RTN, km, km/s).";
    m->cov[key] = c;
    m->n[key] = json_number(s, "n", 1e300);
  }
  if (j.contains("factors")) {
    if (!j["factors"].is_array()) return "factors is an array.";
    for (const auto& f : j["factors"]) {
      if (!f.is_object() || !f.contains("regimeIndex") || !f["regimeIndex"].is_number_integer() || !f.contains("ageIndex") ||
          !f["ageIndex"].is_number_integer() || !f.contains("factor") || !f["factor"].is_number() || !(f["factor"].get<double>() > 0))
        return "each factor needs integer regimeIndex, ageIndex and factor > 0.";
      m->factor[{f["regimeIndex"].get<int>(), f["ageIndex"].get<int>()}] = f["factor"].get<double>();
    }
  }
  if (j.contains("status")) {
    if (!j["status"].is_array()) return "status is an array.";
    for (const auto& s : j["status"])
      if (s.is_object() && s.contains("regimeIndex") && s["regimeIndex"].is_number_integer() && s.contains("ageIndex") && s["ageIndex"].is_number_integer())
        m->status[{s["regimeIndex"].get<int>(), s["ageIndex"].get<int>()}] = json_string(s, "status");
  }
  return {};
}

std::string read_factor_cells(const nlohmann::json& j, std::vector<FactorCell>* cells) {
  if (!j.contains("strata") || !j["strata"].is_array()) return "a factor model needs strata [{regime, horizonDays [lo, hi], factor | axesFactors [3]}].";
  for (const auto& s : j["strata"]) {
    FactorCell c;
    double h[2];
    if (!s.is_object() || !vec(s["horizonDays"], 2, h) || !(h[1] > h[0])) return "each stratum needs horizonDays [lo, hi] with lo < hi.";
    c.lo = h[0];
    c.hi = h[1];
    c.regime = s.contains("regime") && s["regime"].is_string() ? s["regime"].get<std::string>() : "*";
    if (s.contains("axesFactors")) {
      if (!vec(s["axesFactors"], 3, c.s2) || !(c.s2[0] > 0 && c.s2[1] > 0 && c.s2[2] > 0)) return "axesFactors are three positive numbers.";
      c.axes = true;
    } else if (s.contains("factor") && s["factor"].is_number() && s["factor"].get<double>() > 0) {
      c.factor = s["factor"].get<double>();
    } else {
      return "each stratum needs factor > 0 or axesFactors [3].";
    }
    c.status = json_string(s, "status");
    cells->push_back(c);
  }
  return {};
}

}  // namespace covreal

extern "C" int calibrate_covariance() {
  using namespace covreal;
  const nlohmann::json model = json_input("model"), objects = json_input("objects");
  if (!model.is_object() || !model.contains("kind") || !model["kind"].is_string()) return fail("invalid-model", "model must be JSON with a kind.");
  if (!objects.is_object() || !objects.contains("objects") || !objects["objects"].is_array()) return fail("invalid-objects", "objects must be JSON {objects: [...]}.");
  const std::string kind = model["kind"].get<std::string>();
  const std::string version = json_string(model, "version");
  if (version.empty()) return fail("invalid-model", "model needs a version (the calibration version).");
  const bool set_model = kind == "e14-element-set-model";
  if (!set_model && kind != "e14-factors") return fail("invalid-model", "model kind is e14-factors or e14-element-set-model.");
  SetModel sm;
  std::vector<FactorCell> cells;
  std::string e = set_model ? read_set_model(model, &sm) : read_factor_cells(model, &cells);
  if (!e.empty()) return fail("invalid-model", e);
  // Regimes for factor models (named in the cells): the model's own list, gp-error-model's form.
  Options regime_options;
  if (!set_model) {
    nlohmann::json ro{{"regimes", model.contains("regimes") ? model["regimes"] : nlohmann::json()}};
    if (!model.contains("regimes")) ro.erase("regimes");
    e = parse_options(ro, &regime_options);
    if (!e.empty()) return fail("invalid-model", e);
  }
  const Options& ropt = set_model ? sm.options : regime_options;
  // Element sets, when objects name one (norad and epoch): their regime by gp-error-model's rule.
  std::vector<ElementSet> sets;
  Counts counts;
  if (input("elements") && !load_elements(ropt, sets, counts)) return fail("invalid-elements", error_text);
  auto find_set = [&](uint32_t norad, const std::string& epoch) -> const ElementSet* {
    Instant t;
    if (!parse_instant(epoch, &t)) return nullptr;
    for (const ElementSet& s : sets)
      if (s.norad == norad && std::fabs(seconds_between(s.epoch, t)) <= 1.0) return &s;
    return nullptr;
  };
  nlohmann::json rows = nlohmann::json::array();
  uint64_t outside = 0;
  for (const auto& o : objects["objects"]) {
    if (!o.is_object()) return fail("invalid-objects", "each object is a JSON object.");
    nlohmann::json row{{"id", id_of(o)}};
    double r[3], v[3];
    const bool has_state = o.contains("state") && o["state"].is_object() && vec(o["state"]["position"], 3, r) && vec(o["state"]["velocity"], 3, v);
    // The regime: given by id, or from the named element set, or from the state's osculating elements.
    int regime = -1;
    if (o.contains("regime") && o["regime"].is_string()) {
      for (size_t i = 0; i < ropt.regimes.size(); ++i)
        if (ropt.regimes[i].id == o["regime"].get<std::string>()) regime = static_cast<int>(i);
    } else if (o.contains("set") && o["set"].is_object()) {
      // Sets outside every regime are not loaded (gp-error-model's rule): such an object is OUTSIDE.
      const ElementSet* s = find_set(static_cast<uint32_t>(json_number(o["set"], "norad", 0)), json_string(o["set"], "epoch"));
      regime = s ? s->regime : -1;
    } else if (has_state) {
      double alt = 0, ecc = 0;
      osculating(r, v, &alt, &ecc);
      regime = regime_of(ropt, alt, ecc);
    }
    row["regime"] = regime >= 0 ? nlohmann::json(ropt.regimes[regime].id) : nlohmann::json(nullptr);
    if (regime < 0) { row["status"] = "OUTSIDE"; ++outside; rows.push_back(row); continue; }
    const double object_factor = json_number(o, "objectFactor", 1.0);
    if (!(object_factor > 0)) return fail("invalid-objects", "objectFactor is positive.");
    double rtn[36] = {};
    std::string status;
    if (set_model) {
      if (!o.contains("ageDays") || !o["ageDays"].is_number()) return fail("invalid-objects", "an element-set model needs each object's ageDays.");
      const double age = o["ageDays"].get<double>();
      std::vector<std::pair<double, double>> bins = sm.options.ages;
      std::vector<bool> have(bins.size());
      for (size_t i = 0; i < bins.size(); ++i) {
        const auto key = std::make_pair(regime, static_cast<int>(i));
        have[i] = sm.cov.count(key) && sm.n[key] >= sm.minimum_bin_samples;
      }
      std::vector<double> c21, k2;
      if (!interpolate_bins(bins, have, age, [&](int i, size_t k) { return sm.cov[{regime, i}][k]; }, 21, &c21)) {
        row["status"] = "NO_MODEL";
        rows.push_back(row);
        continue;
      }
      std::vector<bool> have_f(bins.size());
      for (size_t i = 0; i < bins.size(); ++i) have_f[i] = have[i] && sm.factor.count({regime, static_cast<int>(i)});
      double factor = 1.0;
      if (std::any_of(have_f.begin(), have_f.end(), [](bool b) { return b; }) &&
          interpolate_bins(bins, have_f, age, [&](int i, size_t) { return sm.factor[{regime, i}]; }, 1, &k2))
        factor = k2[0];
      for (int a = 0, t = 0; a < 6; ++a)
        for (int b = 0; b <= a; ++b, ++t) rtn[6 * a + b] = rtn[6 * b + a] = c21[t] * 1e6 * factor * object_factor;  // km -> m
      const int bin = age_of(sm.options, age);
      status = bin >= 0 && sm.status.count({regime, bin}) ? sm.status[{regime, bin}] : "UNSTATED";
      row["cell"] = {{"ageIndex", bin}, {"ageDays", age}};
      row["factor"] = factor * object_factor;
    } else {
      if (!o.contains("horizonDays") || !o["horizonDays"].is_number()) return fail("invalid-objects", "a factor model needs each object's horizonDays.");
      const double h = o["horizonDays"].get<double>();
      double native[36];
      int dim = 0;
      if (!o.contains("covariance") || !covariance_of(o["covariance"], native, &dim)) return fail("invalid-objects", "a factor model needs each object's covariance.");
      const std::string axes = o.value("covarianceAxes", std::string("RTN"));
      if (axes == "INERTIAL") {
        if (!has_state) return fail("invalid-objects", "an inertial covariance needs the object's state.");
        double ax[3][3];
        axes_of(r, v, ax);
        rotate6(ax, native, rtn, true);
      } else if (axes == "RTN" || axes == "UVW") {
        std::copy(native, native + 36, rtn);
      } else {
        return fail("invalid-objects", "covarianceAxes is RTN, UVW or INERTIAL.");
      }
      const FactorCell* cell = nullptr;
      for (const FactorCell& c : cells)
        if ((c.regime == "*" || c.regime == ropt.regimes[regime].id) && h >= c.lo && h < c.hi) { cell = &c; break; }
      if (!cell) { row["status"] = "NO_MODEL"; rows.push_back(row); continue; }
      double s[6];
      for (int k = 0; k < 3; ++k) s[k] = s[k + 3] = std::sqrt((cell->axes ? cell->s2[k] : cell->factor) * object_factor);
      for (int a = 0; a < 6; ++a)
        for (int b = 0; b < 6; ++b) rtn[6 * a + b] *= s[a] * s[b];
      status = cell->status.empty() ? "UNSTATED" : cell->status;
      row["cell"] = {{"horizonDays", {cell->lo, cell->hi}}, {"horizon", h}};
      if (cell->axes) row["axesFactors"] = std::vector<double>(cell->s2, cell->s2 + 3);
      else row["factor"] = cell->factor * object_factor;
    }
    row["status"] = status;
    row["covarianceRtn"] = lower21(rtn);
    if (has_state) {
      double ax[3][3], inertial[36];
      axes_of(r, v, ax);
      rotate6(ax, rtn, inertial, false);
      row["covarianceInertial"] = full36(inertial);
    }
    rows.push_back(row);
  }
  return emit("covariance", {{"kind", "e14-calibrated-covariance"}, {"version", 1}, {"calibrationVersion", version}, {"model", kind},
                             {"units", "SI (m, m/s); covarianceRtn lower triangle RR, TR, TT, NR, NT, NN, dR R, ...; covarianceInertial row-major 6x6"},
                             {"rule", set_model ? "factor x object factor x the model's RTN second moment, linear in age between usable bin centres"
                                                : "S P S with S = diag(s_R, s_T, s_N, s_R, s_T, s_N), s^2 the cell's (axes) or common factor times the object factor; velocity rows scale with their position axes"},
                             {"counts", {{"objects", rows.size()}, {"outsideRegimes", outside}}}, {"objects", rows}});
}

// ── dcp_covariance ──
extern "C" int dcp_covariance() {
  using namespace covreal;
  const nlohmann::json in = json_input("request");
  if (!in.is_object()) return fail("invalid-request", "request must be a JSON object.");
  if (!in.contains("leadCovariance") || !in["leadCovariance"].is_array() || in["leadCovariance"].empty())
    return fail("invalid-request", "leadCovariance is a K x K array (variance of the daily ln-density error by lead day).");
  const size_t K = in["leadCovariance"].size();
  std::vector<double> C(K * K);
  for (size_t i = 0; i < K; ++i)
    if (!vec(in["leadCovariance"][i], K, &C[K * i])) return fail("invalid-request", "leadCovariance rows are K numbers.");
  for (size_t i = 0; i < K; ++i) {
    if (!(C[K * i + i] >= 0)) return fail("invalid-request", "leadCovariance diagonal is non-negative.");
    for (size_t j = 0; j < i; ++j)
      if (std::fabs(C[K * i + j] - C[K * j + i]) > 1e-12 * (1 + std::fabs(C[K * i + j]))) return fail("invalid-request", "leadCovariance is symmetric.");
  }
  Instant s0;
  if (!parse_instant(json_string(in, "start"), &s0)) return fail("invalid-request", "start is the ISO 8601 UTC time the forecast part begins.");
  struct Seg { double a, b; size_t lead; };
  std::vector<Seg> segs;
  if (!in.contains("segments") || !in["segments"].is_array()) return fail("invalid-request", "segments [{from, to, lead}] map times to lead days.");
  for (const auto& s : in["segments"]) {
    Instant a, b;
    if (!s.is_object() || !parse_instant(json_string(s, "from"), &a) || !parse_instant(json_string(s, "to"), &b) || !s.contains("lead") ||
        !s["lead"].is_number_integer())
      return fail("invalid-request", "each segment needs from, to (ISO 8601 UTC) and an integer lead (1..K).");
    const int lead = s["lead"].get<int>();
    if (lead < 1 || lead > static_cast<int>(K)) return fail("invalid-request", "segment lead is 1..K.");
    const double sa = seconds_between(s0, a), sb = seconds_between(s0, b);
    if (!(sb > sa)) return fail("invalid-request", "segments run forward (to > from).");
    segs.push_back({sa, sb, static_cast<size_t>(lead - 1)});
  }
  const double B = json_number(in, "ballisticCoefficient", 0);
  if (!in.contains("epochs") || !in["epochs"].is_array()) return fail("invalid-request", "epochs [{epoch, sensitivity[6] | stm[36] and s[6]}].");
  // Sensitivity at the start, when the samples start earlier: Phi(s0) and S(s0).
  stm::Mat6 phi0{}, phi0_inv{};
  double S0[6] = {};
  const bool from_samples = in.contains("startSample");
  if (from_samples) {
    const auto& ss = in["startSample"];
    if (!ss.is_object() || !vec(ss["stm"], 36, phi0.data()) || !vec(ss["s"], 6, S0) || !(B > 0))
      return fail("invalid-request", "startSample needs stm [36] and s [6] (dx/dB, SI) at the start, and ballisticCoefficient B > 0.");
    if (!stm::invert(phi0, &phi0_inv)) return fail("invalid-request", "the start STM is singular.");
  }
  nlohmann::json rows = nlohmann::json::array();
  for (const auto& ep : in["epochs"]) {
    Instant t;
    if (!ep.is_object() || !parse_instant(json_string(ep, "epoch"), &t)) return fail("invalid-request", "each epoch needs epoch (ISO 8601 UTC).");
    const double tt = seconds_between(s0, t);
    double g[6] = {};
    if (ep.contains("sensitivity")) {
      if (!vec(ep["sensitivity"], 6, g)) return fail("invalid-request", "sensitivity is [6] (dx/d ln B from the start, SI).");
    } else if (from_samples) {
      stm::Mat6 phi{};
      double S[6];
      if (!vec(ep["stm"], 36, phi.data()) || !vec(ep["s"], 6, S)) return fail("invalid-request", "with startSample each epoch needs stm [36] and s [6].");
      const stm::Mat6 rel = stm::multiply(phi, phi0_inv);  // Phi(t, s0)
      for (int i = 0; i < 6; ++i) {
        double x = S[i];
        for (int k = 0; k < 6; ++k) x -= rel[6 * i + k] * S0[k];
        g[i] = B * x;
      }
    } else {
      return fail("invalid-request", "each epoch needs sensitivity, or stm and s with a startSample.");
    }
    std::vector<double> w(K, 0.0);
    double sigma2 = 0;
    if (tt > 0) {
      for (const Seg& s : segs) {
        const double a = std::max(s.a, 0.0), b = std::min(s.b, tt);
        if (b > a) w[s.lead] += ((tt - a) * (tt - a) - (tt - b) * (tt - b)) / (tt * tt);
      }
      for (size_t i = 0; i < K; ++i)
        for (size_t j = 0; j < K; ++j) sigma2 += w[i] * C[K * i + j] * w[j];
      if (sigma2 < 0) return fail("invalid-request", "leadCovariance is not positive semidefinite (w' C w < 0).");
    }
    double P[36];
    for (int i = 0; i < 6; ++i)
      for (int j = 0; j < 6; ++j) P[6 * i + j] = sigma2 * g[i] * g[j];
    double covered = 0;
    for (double x : w) covered += x;
    nlohmann::json row{{"epoch", json_string(ep, "epoch")}, {"secondsFromStart", tt}, {"sigmaEff", std::sqrt(sigma2)}, {"weights", w},
                       {"weightCovered", covered}, {"sensitivity", std::vector<double>(g, g + 6)}, {"covariance", full36(P)}};
    if (ep.contains("base")) {
      double base[36];
      int dim = 0;
      if (!covariance_of(ep["base"], base, &dim) || dim != 6) return fail("invalid-request", "base is a 6x6 covariance (21 lower or 36 full), SI, the frame of g.");
      for (int k = 0; k < 36; ++k) base[k] += P[k];
      row["total"] = full36(base);
    }
    rows.push_back(row);
  }
  return emit("dcp", {{"kind", "e14-dcp"}, {"version", 1}, {"start", json_string(in, "start")}, {"leadDays", K},
                      {"rule", "w_l = sum over lead-l segments of ((t-a)^2 - (t-b)^2)/(t-s0)^2 on [s0, t]; sigma_eff^2 = w' C w; P = sigma_eff^2 g g'"},
                      {"epochs", rows}});
}
