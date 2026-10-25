// -----------------------------------------------------------------------------
// The `launch_batch` method (DESIGN 5.3.3): a deployment sequence with small
// separation Delta v. One parent state x0 at t0 (a $LAM INSERTION or a $BOV
// burnout vector); object k of the batch is the impulse map (14) of the parent
// set with its own separation Delta v_k (UVW at t0) and its own B_k. The
// batch-joint fit estimates the parent's six elements and the batch mean B,
// and per object Delta v_k and B_k, under the hierarchical prior
// B_k ~ N(B_mean, sigma_B^2) (Stein shrinkage: James & Stein 1961; Efron &
// Morris 1975) and the separation prior Delta v_k ~ N(0, sigma_sep^2 I). The
// normal matrix is an arrowhead (the parent block coupled to the N object
// blocks), solved by the Schur complement in O(N). Each object's set carries
// its along-track order at the latest state (22); with 'catalog' sets the
// objects are associated with them by that order (the 1-D assignment: both
// sorted, matched in order).
// -----------------------------------------------------------------------------

namespace sdnap {
namespace deploy {

constexpr int kParent = 7;            ///< six elements and the batch mean B
constexpr int kOwn = 12;              ///< Delta v (3, km/s, UVW at t0), B_k, six mean-element offsets at t0, tauc and taus
constexpr double kSigmaTau = 1e-6;    ///< m/s^2: the once-per-revolution empirical terms' prior (DESIGN 2c), per object
/// The offsets' prior sigmas (the events eq order: n, a_f, a_g, chi, psi, lambda): about 100 m of position at t0 in the
/// angles and the eccentricity vector, 2e-7 of n (0.2 km of along-track drift a day). They carry the theory's own error
/// at the release, which ties the objects to the common state only while their own arcs are short: as an arc grows its
/// data outweigh the prior and the object's set converges to its own fit.
constexpr double kSigmaOffset = 1.5e-5, kSigmaOffsetN = 2e-7;
/// km/s: the separation prior (cm/s to m/s releases; $PCF LAUNCH.SEPARATION_SIGMA_M_S, default 1 m/s)
inline double sigma_sep() { return pcf::options().separation_sigma_m_s * 1e-3; }
/// m^2/kg: the batch mean's own prior, for conditioning only ($PCF LAUNCH.BATCH_MEAN_SIGMA_M2_KG, default 1)
inline double sigma_mean() { return pcf::options().batch_mean_sigma; }

struct Object {
  std::vector<double> t, r;   ///< minutes from t0; TEME km
  std::string name, id;
  uint32_t norad = 0;
  double dv[3] = {0.0, 0.0, 0.0};
  double b = 0.0;
  double delta[6] = {0, 0, 0, 0, 0, 0};
  double tau[2] = {0, 0};  ///< tauc, taus (m/s^2)
  double s_ref = 0.0;         ///< along-track offset from the parent at the reference time, km
  uint32_t assoc = 0;         ///< associated catalog NORAD (0: none)
  double assoc_ds = 0.0;
};

inline void own_of(const Object& o, double* own) {
  for (int c = 0; c < 3; ++c) own[c] = o.dv[c];
  own[3] = o.b;
  for (int j = 0; j < 6; ++j) own[4 + j] = o.delta[j];
  own[10] = o.tau[0];
  own[11] = o.tau[1];
}

/// Object k's set: the impulse map of the parent set at t0 with its Delta v, its own B.
inline bool object_set(const ElementRow& parent, const double* own, Elements& post) {
  ElementRow p = parent;
  p.bterm = own[3];
  p.tauc = own[10];
  p.taus = own[11];
  events::Boundary bd;
  if (!events::maneuver_map(elements_of(p), 0.0, own, 0.0, post, bd)) return false;
  double q[6];
  events::eq_of_elements(post, q);
  for (int j = 0; j < 6; ++j) q[j] += own[4 + j];
  return events::set_eq(post, q);
}

/// Model minus observed positions (km) of object `o`.
inline bool residuals(const ElementRow& parent, const double* own, const Object& o, double* res) {
  Elements post{};
  if (!object_set(parent, own, post)) return false;
  xpt::XpSat* s = static_cast<xpt::XpSat*>(std::calloc(1, sizeof(xpt::XpSat)));
  if (s == nullptr) return false;
  bool ok = xpt::xp_init(post, *s) == kPropOk;
  const int m = static_cast<int>(o.t.size());
  for (int k = 0; ok && k < m; ++k) {
    double rm[3], vm[3];
    if (xpt::xp_propagate(*s, o.t[k], rm, vm) != kPropOk) { ok = false; break; }
    for (int j = 0; j < 3; ++j) res[3 * k + j] = rm[j] - o.r[3 * k + j];
  }
  xpt::xp_release(*s);
  std::free(s);
  return ok;
}

/// Solve the symmetric positive system A x = b of one object's block in place (Cholesky); false when not positive.
inline bool solve_own(const double* A, double* b) {
  double M[kOwn * kOwn];
  for (int q = 0; q < kOwn * kOwn; ++q) M[q] = A[q];
  return fit::solve(M, b, kOwn);
}

struct Result {
  int status = -1, iterations = 0;
  double rms_km = 0.0;
  double cost = 0.0;
};

/// The batch-joint fit. `parent` holds the parent set at t0 (its B and AGOM the priors) and receives the fitted one;
/// `bmean` the batch mean B (in: its prior); the objects' dv and b hold the start and receive the fit.
inline Result fit_batch(ElementRow& parent, double& bmean, std::vector<Object>& obj, double sigma_b) {
  Result out;
  const int N = static_cast<int>(obj.size());
  const double bprior = bmean;
  // the parent block: the six elements and the once-per-revolution empirical terms the objects share (DESIGN 2c: the
  // theory's own error is common to a batch on one orbit), then the batch mean B
  fit::Options o6{};
  o6.fit_tau = 0;  // the empirical terms are each object's own (the theory's error differs along each arc)
  double xp[kParent];
  const int ne = fit::params_of(parent, o6, xp);
  const int np = ne + 1, ib = ne;
  xp[ib] = bmean;
  std::vector<double> xo(static_cast<size_t>(kOwn) * N);
  for (int k = 0; k < N; ++k) {
    for (int c = 0; c < 3; ++c) xo[kOwn * k + c] = obj[k].dv[c];
    xo[kOwn * k + 3] = obj[k].b;
    for (int j = 0; j < 6; ++j) xo[kOwn * k + 4 + j] = obj[k].delta[j];
    xo[kOwn * k + 10] = obj[k].tau[0];
    xo[kOwn * k + 11] = obj[k].tau[1];
  }
  const double n_ref = parent.mean_motion_rev_day * kTwoPi / kMinutesPerDay;
  auto offset_sigma = [&](int j) { return j == 0 ? kSigmaOffsetN * n_ref : kSigmaOffset; };
  std::vector<std::vector<double>> res(N), trial(N);
  int total = 0;
  for (int k = 0; k < N; ++k) {
    res[k].resize(3 * obj[k].t.size());
    trial[k].resize(res[k].size());
    total += static_cast<int>(obj[k].t.size());
  }
  auto parent_of = [&](const double* x) {
    ElementRow p = parent;
    fit::row_of(x, o6, p);
    return p;
  };
  auto eval_all = [&](const double* x, const std::vector<double>& own, std::vector<std::vector<double>>& rr) {
    const ElementRow p = parent_of(x);
    for (int k = 0; k < N; ++k)
      if (!residuals(p, own.data() + kOwn * k, obj[k], rr[k].data())) return false;
    return true;
  };
  auto cost_of = [&](const double* x, const std::vector<double>& own, const std::vector<std::vector<double>>& rr) {
    double c = 0.0;
    for (int k = 0; k < N; ++k) {
      for (double q : rr[k]) c += q * q;
      const double s = (own[kOwn * k + 3] - x[ib]) / sigma_b;
      c += s * s;
      for (int j = 0; j < 3; ++j) c += (own[kOwn * k + j] / sigma_sep()) * (own[kOwn * k + j] / sigma_sep());
      for (int j = 0; j < 6; ++j) c += (own[kOwn * k + 4 + j] / offset_sigma(j)) * (own[kOwn * k + 4 + j] / offset_sigma(j));
      for (int j = 10; j < 12; ++j) c += (own[kOwn * k + j] / kSigmaTau) * (own[kOwn * k + j] / kSigmaTau);
    }
    const double d = (x[ib] - bprior) / sigma_mean();
    return c + d * d;
  };
  if (!eval_all(xp, xo, res)) { out.status = -2; return out; }
  double cost = cost_of(xp, xo, res), mu = 1e-3;
  bool converged = false;
  int it = 0;
  std::vector<double> App(kParent * kParent), gp(kParent);
  std::vector<double> Apk(static_cast<size_t>(kParent) * kOwn * N), Akk(static_cast<size_t>(kOwn) * kOwn * N), gk(static_cast<size_t>(kOwn) * N);
  for (; it < 25 && !converged; ++it) {
    std::fill(App.begin(), App.end(), 0.0);
    std::fill(gp.begin(), gp.end(), 0.0);
    std::fill(Apk.begin(), Apk.end(), 0.0);
    std::fill(Akk.begin(), Akk.end(), 0.0);
    std::fill(gk.begin(), gk.end(), 0.0);
    const ElementRow p0 = parent_of(xp);
    for (int k = 0; k < N; ++k) {
      const int nr = static_cast<int>(res[k].size());
      constexpr int kCols = kParent - 1 + kOwn;
      std::vector<double> J(static_cast<size_t>(nr) * kCols), tr(nr);
      // parent columns (elements and tau): the parent perturbed, this object's own parameters fixed
      for (int a = 0; a < ne; ++a) {
        const double h = a == 5 ? 1e-7 * std::fabs(xp[5]) : a < 6 ? 1e-7 : std::fmax(1e-2 * std::fabs(xp[a]), 1e-9);
        double xh[kParent];
        for (int q = 0; q < np; ++q) xh[q] = xp[q];
        xh[a] += h;
        if (!residuals(parent_of(xh), xo.data() + kOwn * k, obj[k], tr.data())) { out.status = -3; return out; }
        for (int i = 0; i < nr; ++i) J[static_cast<size_t>(i) * kCols + a] = (tr[i] - res[k][i]) / h;
      }
      for (int a = 0; a < kOwn; ++a) {
        double own[kOwn];
        for (int q = 0; q < kOwn; ++q) own[q] = xo[kOwn * k + q];
        const double h = a < 3 ? 1e-6 : a == 3 ? std::fmax(1e-2 * std::fabs(own[3]), 1e-5) : a == 4 ? 1e-7 * n_ref : a < 10 ? 1e-7 : 1e-9;
        own[a] += h;
        if (!residuals(p0, own, obj[k], tr.data())) { out.status = -3; return out; }
        for (int i = 0; i < nr; ++i) J[static_cast<size_t>(i) * kCols + ne + a] = (tr[i] - res[k][i]) / h;
      }
      double* apk = Apk.data() + static_cast<size_t>(kParent) * kOwn * k;
      double* akk = Akk.data() + static_cast<size_t>(kOwn) * kOwn * k;
      double* g = gk.data() + kOwn * k;
      for (int i = 0; i < nr; ++i) {
        const double* row = J.data() + static_cast<size_t>(i) * kCols;
        for (int a = 0; a < ne; ++a) {
          gp[a] -= row[a] * res[k][i];
          for (int b = 0; b < ne; ++b) App[a * kParent + b] += row[a] * row[b];
          for (int c = 0; c < kOwn; ++c) apk[a * kOwn + c] += row[a] * row[ne + c];
        }
        for (int c = 0; c < kOwn; ++c) {
          g[c] -= row[ne + c] * res[k][i];
          for (int d = 0; d < kOwn; ++d) akk[c * kOwn + d] += row[ne + c] * row[ne + d];
        }
      }
      // the shrinkage prior couples B_k with the batch mean; the separation prior is the object's own
      const double w = 1.0 / (sigma_b * sigma_b), rs = xo[kOwn * k + 3] - xp[ib];
      akk[3 * kOwn + 3] += w;
      App[ib * kParent + ib] += w;
      apk[ib * kOwn + 3] -= w;
      g[3] -= w * rs;
      gp[ib] += w * rs;
      for (int c = 0; c < 3; ++c) {
        akk[c * kOwn + c] += 1.0 / (sigma_sep() * sigma_sep());
        g[c] -= xo[kOwn * k + c] / (sigma_sep() * sigma_sep());
      }
      for (int j = 0; j < 6; ++j) {
        const double sj = offset_sigma(j);
        akk[(4 + j) * kOwn + 4 + j] += 1.0 / (sj * sj);
        g[4 + j] -= xo[kOwn * k + 4 + j] / (sj * sj);
      }
      for (int j = 10; j < 12; ++j) {
        akk[j * kOwn + j] += 1.0 / (kSigmaTau * kSigmaTau);
        g[j] -= xo[kOwn * k + j] / (kSigmaTau * kSigmaTau);
      }
    }
    App[ib * kParent + ib] += 1.0 / (sigma_mean() * sigma_mean());
    gp[ib] -= (xp[ib] - bprior) / (sigma_mean() * sigma_mean());
    bool improved = false;
    for (int tries = 0; tries < 12 && !improved; ++tries) {
      // the arrowhead by the Schur complement: S = A_pp - sum A_pk A_kk^-1 A_kp, r = g_p - sum A_pk A_kk^-1 g_k
      double S[kParent * kParent], rp[kParent];
      for (int a = 0; a < np; ++a)
        for (int b = 0; b < np; ++b) S[a * np + b] = App[a * kParent + b];
      for (int a = 0; a < np; ++a) { S[a * np + a] *= (1.0 + mu); rp[a] = gp[a]; }
      std::vector<double> akk_d(static_cast<size_t>(kOwn) * kOwn * N);
      bool ok = true;
      for (int k = 0; k < N && ok; ++k) {
        const double* apk = Apk.data() + static_cast<size_t>(kParent) * kOwn * k;
        double* ad = akk_d.data() + static_cast<size_t>(kOwn) * kOwn * k;
        for (int q = 0; q < kOwn * kOwn; ++q) ad[q] = Akk[static_cast<size_t>(kOwn) * kOwn * k + q];
        for (int c = 0; c < kOwn; ++c) ad[c * kOwn + c] *= (1.0 + mu);
        // A_kk^-1 A_kp (4 x 7) and A_kk^-1 g_k
        double X[kOwn][kParent], y[kOwn];
        for (int a = 0; a < np && ok; ++a) {
          double col[kOwn];
          for (int c = 0; c < kOwn; ++c) col[c] = apk[a * kOwn + c];
          ok = solve_own(ad, col);
          for (int c = 0; c < kOwn; ++c) X[c][a] = col[c];
        }
        for (int c = 0; c < kOwn; ++c) y[c] = gk[kOwn * k + c];
        ok = ok && solve_own(ad, y);
        for (int a = 0; a < np && ok; ++a) {
          for (int b = 0; b < np; ++b) {
            double sum = 0.0;
            for (int c = 0; c < kOwn; ++c) sum += apk[a * kOwn + c] * X[c][b];
            S[a * np + b] -= sum;
          }
          double sum = 0.0;
          for (int c = 0; c < kOwn; ++c) sum += apk[a * kOwn + c] * y[c];
          rp[a] -= sum;
        }
      }
      double dp[kParent];
      for (int a = 0; a < np; ++a) dp[a] = rp[a];
      if (ok && fit::solve(S, dp, np)) {
        double xt[kParent];
        for (int a = 0; a < np; ++a) xt[a] = xp[a] + dp[a];
        std::vector<double> ot(xo);
        for (int k = 0; k < N && ok; ++k) {
          const double* apk = Apk.data() + static_cast<size_t>(kParent) * kOwn * k;
          double rhs[kOwn];
          for (int c = 0; c < kOwn; ++c) {
            double sum = 0.0;
            for (int a = 0; a < np; ++a) sum += apk[a * kOwn + c] * dp[a];
            rhs[c] = gk[kOwn * k + c] - sum;
          }
          ok = solve_own(akk_d.data() + static_cast<size_t>(kOwn) * kOwn * k, rhs);
          for (int c = 0; c < kOwn; ++c) ot[kOwn * k + c] += rhs[c];
        }
        if (ok && eval_all(xt, ot, trial)) {
          const double c = cost_of(xt, ot, trial);
          if (c < cost) {
            const double rel = (cost - c) / cost;
            for (int a = 0; a < np; ++a) xp[a] = xt[a];
            xo.swap(ot);
            res.swap(trial);
            cost = c;
            mu = std::fmax(mu * 0.3, 1e-12);
            improved = true;
            if (rel < 1e-10) converged = true;
            continue;
          }
        }
      }
      mu *= 10.0;
    }
    if (!improved) converged = true;
  }
  parent = parent_of(xp);
  bmean = xp[ib];
  double ss = 0.0;
  for (int k = 0; k < N; ++k) {
    for (int c = 0; c < 3; ++c) obj[k].dv[c] = xo[kOwn * k + c];
    obj[k].b = xo[kOwn * k + 3];
    for (int j = 0; j < 6; ++j) obj[k].delta[j] = xo[kOwn * k + 4 + j];
    obj[k].tau[0] = xo[kOwn * k + 10];
    obj[k].tau[1] = xo[kOwn * k + 11];
    for (double q : res[k]) ss += q * q;
  }
  out.rms_km = std::sqrt(ss / (total > 0 ? total : 1));
  out.cost = cost;
  out.iterations = it;
  out.status = converged ? 0 : 1;
  return out;
}

/// The along-track offset (km) of a state from the parent's at the same time: (r - r_p) on the parent's transverse
/// direction (h x r_p) / |h x r_p|.
inline double along_track(const double* rp, const double* vp, const double* r) {
  const double h[3] = {rp[1] * vp[2] - rp[2] * vp[1], rp[2] * vp[0] - rp[0] * vp[2], rp[0] * vp[1] - rp[1] * vp[0]};
  double s[3] = {h[1] * rp[2] - h[2] * rp[1], h[2] * rp[0] - h[0] * rp[2], h[0] * rp[1] - h[1] * rp[0]};
  const double ns = std::sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]);
  if (!(ns > 0.0)) return 0.0;
  return ((r[0] - rp[0]) * s[0] + (r[1] - rp[1]) * s[1] + (r[2] - rp[2]) * s[2]) / ns;
}

/// The TEME state of Elements at t minutes from their epoch.
inline bool state_at(const Elements& e, double t, double* r, double* v) {
  xpt::XpSat* s = static_cast<xpt::XpSat*>(std::calloc(1, sizeof(xpt::XpSat)));
  if (s == nullptr) return false;
  const bool ok = xpt::xp_init(e, *s) == kPropOk && xpt::xp_propagate(*s, t, r, v) == kPropOk;
  xpt::xp_release(*s);
  std::free(s);
  return ok;
}

}  // namespace deploy

}  // namespace sdnap

extern "C" int launch_batch(void) {
  using namespace sdnap;
  plugin_reset_output_state();
  if (const int rc = pcf::read(pcf::kLaunchBatch)) return rc;
  {
    bool have_spw = false, have_dcl = false;
    if (const int st = envload::apply_frames(have_spw, have_dcl)) return st;
  }
  double w0 = 0.0, f0 = 0.0, x0[3], v0[3];
  std::string mission;
  {
    const int st = launch::parent_state(w0, f0, x0, v0, mission);
    if (st == 3) return 3;
    if (st == 1) { plugin_set_error("missing-input", "launch_batch takes the parent state as a 'launch' $LAM or a 'burnout' $BOV."); return 3; }
  }
  double beff = 0.01, agom = 0.01;
  if (const int st = launch::priors(beff, agom)) return st;
  // the objects: one TEME block each
  std::vector<deploy::Object> obj;
  const uint32_t frames_n = plugin_get_input_count();
  for (uint32_t fi = 0; fi < frames_n; ++fi) {
    const plugin_input_frame_t* f = plugin_get_input_frame(fi);
    if (f == nullptr || f->port_id == nullptr || std::strcmp(f->port_id, "ephemeris") != 0) continue;
    const uint8_t* p = f->payload;
    uint32_t n = f->payload_length;
    if (n >= 12 && std::memcmp(p + 4, "$OEM", 4) != 0 && std::memcmp(p + 8, "$OEM", 4) == 0) { p += 4; n -= 4; }
    flatbuffers::Verifier verifier(p, n);
    if (!VerifyOEMBuffer(verifier)) { plugin_set_error("invalid-oem", "An 'ephemeris' $OEM does not verify."); return 3; }
    const OEM* oemr = GetOEM(p);
    if (oemr->EPHEMERIS_DATA_BLOCK() == nullptr) continue;
    for (const ephemerisDataBlock* blk : *oemr->EPHEMERIS_DATA_BLOCK()) {
      if (blk->CENTER_NAME() != nullptr && blk->CENTER_NAME()->size() > 0 && !oem::same_text(blk->CENTER_NAME()->c_str(), "EARTH")) {
        plugin_set_error("unsupported-center", "A batch's ephemerides are Earth-centered (CENTER_NAME EARTH).");
        return 3;
      }
      if (oem::axes_of(blk->REFERENCE_FRAME()) != oem::Axes::Teme) { plugin_set_error("unsupported-frame", "launch_batch reads TEME ephemerides."); return 3; }
      if (blk->TIME_SYSTEM() != timingStandard_UTC) { plugin_set_error("unsupported-time-system", "Only UTC ephemerides are read."); return 3; }
      const auto* lines = blk->EPHEMERIS_DATA_LINES();
      if (lines == nullptr || lines->size() < 6) { plugin_set_error("too-few-states", "Each object's block needs at least 6 states."); return 3; }
      deploy::Object o;
      for (const ephemerisDataLine* L : *lines) {
        double w, fr;
        if (!fitoem::text_epoch(L->EPOCH(), w, fr)) { plugin_set_error("invalid-oem", "A state has no readable EPOCH."); return 3; }
        const double tm = fitoem::minutes_between(w0, f0, w, fr);
        if (tm < 0.0) { plugin_set_error("state-before-release", "An object's state precedes the parent state's epoch."); return 3; }
        o.t.push_back(tm);
        o.r.insert(o.r.end(), {L->X(), L->Y(), L->Z()});
      }
      if (const auto* ob = blk->OBJECT()) {
        if (ob->OBJECT_NAME() != nullptr) o.name = ob->OBJECT_NAME()->c_str();
        if (ob->OBJECT_ID() != nullptr) o.id = ob->OBJECT_ID()->c_str();
        o.norad = ob->NORAD_CAT_ID();
      }
      o.b = beff;
      obj.push_back(std::move(o));
    }
  }
  if (obj.size() < 2) { plugin_set_error("missing-input", "launch_batch takes two or more objects' 'ephemeris' blocks."); return 3; }
  // the parent set at t0, and the start: each object's separation from its first state
  Elements pe{};
  pe.epoch_jd_whole = w0;
  pe.epoch_jd_frac = f0;
  pe.theory = kTheorySdnAp;
  pe.bterm = beff;
  pe.agom = agom;
  int iters = 0;
  if (!events::inverse_at_epoch(pe, x0, v0, &iters)) { plugin_set_error("inverse-failed", "The inverse map did not converge at the parent state."); return 3; }
  ElementRow parent = evd::row_of(pe);
  for (const deploy::Object& o : obj) parent.arc_end_min = std::fmax(parent.arc_end_min, o.t.back());  // the tau terms' arc
  double bmean = beff;
  // a weak hierarchical prior (sigma the prior B_eff itself): early arcs at 300 km pin B_k better than that, and the
  // half-B prior pulled an object 25 % below the batch mean 16 % toward it (FFM-1, six objects, 6 h arcs)
  // the shrinkage sigma: $PCF LAUNCH.SHRINK_SIGMA_M2_KG, absent the prior B_eff (floored at 1e-3 m^2/kg)
  const double sigma_b = pcf::options().has_shrink ? pcf::options().shrink_sigma : std::fmax(std::fabs(beff), 1e-3);
  const deploy::Result br = deploy::fit_batch(parent, bmean, obj, sigma_b);
  if (br.status < 0) { plugin_set_error("fit-failed", "The batch-joint fit did not converge."); return 3; }
  // (22) the along-track order at the reference time: the latest catalog epoch when 'catalog' sets are given (there
  // the objects have drifted apart and the catalog sets are at their best), else the latest state of the arcs
  struct Cat { uint32_t norad; Elements e; double s; };
  std::vector<Cat> cats;
  double t_ref = 0.0;
  for (const deploy::Object& o : obj) t_ref = std::fmax(t_ref, o.t.back());
  for (uint32_t fi = 0; fi < frames_n; ++fi) {
    const plugin_input_frame_t* f = plugin_get_input_frame(fi);
    if (f == nullptr || f->port_id == nullptr || std::strcmp(f->port_id, "catalog") != 0) continue;
    ElementRow row{};
    if (!omm::decode(f->payload, f->payload_length, row)) { plugin_set_error("invalid-catalog", "A 'catalog' payload is not a decodable SDS $OMM set."); return 3; }
    cats.push_back({row.norad_cat_id, elements_of(row), 0.0});
  }
  if (!cats.empty()) {
    t_ref = -std::numeric_limits<double>::infinity();
    for (const Cat& c : cats) t_ref = std::fmax(t_ref, fitoem::minutes_between(w0, f0, c.e.epoch_jd_whole, c.e.epoch_jd_frac));
    if (!(t_ref > 0.0)) { plugin_set_error("catalog-before-release", "The catalog sets precede the parent state's epoch."); return 3; }
  }
  double rp[3], vp[3];
  {
    ElementRow pm = parent;
    pm.bterm = bmean;
    if (!deploy::state_at(elements_of(pm), t_ref, rp, vp)) { plugin_set_error("propagation-failed", "The parent set does not reach the reference time."); return 3; }
  }
  for (deploy::Object& o : obj) {
    Elements post{};
    double r[3], v[3];
    double own[deploy::kOwn];
    deploy::own_of(o, own);
    if (!deploy::object_set(parent, own, post) || !deploy::state_at(post, t_ref, r, v)) { plugin_set_error("propagation-failed", "An object's set does not reach the reference time."); return 3; }
    o.s_ref = deploy::along_track(rp, vp, r);
  }
  for (Cat& c : cats) {
    const double tc = fitoem::minutes_between(c.e.epoch_jd_whole, c.e.epoch_jd_frac, w0, f0) + t_ref;
    double r[3], v[3];
    if (!deploy::state_at(c.e, tc, r, v)) { plugin_set_error("catalog-set-refused", "A catalog set does not propagate to the reference time."); return 3; }
    c.s = deploy::along_track(rp, vp, r);
  }
  std::vector<int> order(obj.size());
  for (size_t k = 0; k < obj.size(); ++k) order[k] = static_cast<int>(k);
  std::sort(order.begin(), order.end(), [&](int a, int b) { return obj[a].s_ref < obj[b].s_ref; });
  if (!cats.empty()) {
    std::sort(cats.begin(), cats.end(), [](const Cat& a, const Cat& b) { return a.s < b.s; });
    // the 1-D assignment: both sorted, matched in order; with unequal counts the contiguous alignment of least
    // summed |offset difference|
    const int N = static_cast<int>(obj.size()), M = static_cast<int>(cats.size());
    const int pairs = std::min(N, M);
    int best_off = 0;
    double best = std::numeric_limits<double>::infinity();
    for (int off = 0; off <= std::abs(N - M); ++off) {
      double sum = 0.0;
      for (int q = 0; q < pairs; ++q) {
        const int k = N >= M ? q + off : q, c = N >= M ? q : q + off;
        sum += std::fabs(obj[order[k]].s_ref - cats[c].s);
      }
      if (sum < best) { best = sum; best_off = off; }
    }
    for (int q = 0; q < pairs; ++q) {
      const int k = N >= M ? q + best_off : q, c = N >= M ? q : q + best_off;
      obj[order[k]].assoc = cats[c].norad;
      obj[order[k]].assoc_ds = obj[order[k]].s_ref - cats[c].s;
    }
  }
  std::vector<int> rank(obj.size());
  for (size_t q = 0; q < order.size(); ++q) rank[order[q]] = static_cast<int>(q) + 1;
  for (size_t k = 0; k < obj.size(); ++k) {
    const deploy::Object& o = obj[k];
    Elements post{};
    double own[deploy::kOwn];
    deploy::own_of(o, own);
    if (!deploy::object_set(parent, own, post)) { plugin_set_error("maneuver-failed", "The impulse map did not converge for an object."); return 3; }
    post.norad = o.assoc != 0 ? o.assoc : o.norad;
    char comment[320];
    char assoc[96] = "";
    if (o.assoc != 0) std::snprintf(assoc, sizeof assoc, "; associated with NORAD %u (along-track %.3f km apart)", o.assoc, o.assoc_ds);
    std::snprintf(comment, sizeof comment,
                  "SDN-AP batch-joint fit (DESIGN 5.3.3; %zu objects, RMS %.6f km, %d iterations): separation dv U %.3f V %.3f W %.3f mm/s, B_eff %.5g m^2/kg (batch mean %.5g, sigma %.3g); along-track %d of %zu at %.1f h (%.3f km from the parent)%s",
                  obj.size(), br.rms_km, br.iterations, 1e6 * o.dv[0], 1e6 * o.dv[1], 1e6 * o.dv[2], o.b, bmean, sigma_b, rank[k], obj.size(),
                  t_ref / 60.0, o.s_ref, assoc);
    flatbuffers::FlatBufferBuilder tb(256);
    const std::string nm = !o.name.empty() ? o.name : (!mission.empty() ? mission : std::string("BATCH OBJECT"));
    const auto s_name = tb.CreateString(nm.c_str());
    const auto s_id = !o.id.empty() ? tb.CreateString(o.id.c_str()) : flatbuffers::Offset<flatbuffers::String>(0);
    const auto s_c = tb.CreateString("EARTH");
    OMMBuilder ob(tb);
    ob.add_CENTER_NAME(s_c);
    ob.add_OBJECT_NAME(s_name);
    if (!s_id.IsNull()) ob.add_OBJECT_ID(s_id);
    tb.Finish(ob.Finish());
    if (const int rc = evm::push_set(post, GetOMM(tb.GetBufferPointer()), comment)) return rc;
  }
  return 0;
}
