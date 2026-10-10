// Epistemic Support-Point Filter (ESPF) in its 2025 operational form (Jah and
// Haslett, arXiv 2508.20806) and its 2026 canonical form (Jah 2026: TEAG
// section 5.1; ESPF-HJ Theorem 1 and sections 6 and 9; arXiv 2603.10065
// sections 2-4), and the ellipsoidal set-membership filter (Schweppe 1968;
// Bertsekas and Rhodes 1971) used as the bounded-set baseline. Every support
// point is propagated through config.propagator (the inverted port the UKF
// uses), so the caller's propagator (propagator/hpop) supplies all dynamics.
// docs/espf-spec.md maps each step to its paper, section and equation and
// records every choice made where the papers leave a gap.
#include "estimation.hpp"
#include "teag.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <numeric>

namespace sdn::estimation {
namespace {

using teag::Vec;
constexpr int kN = 6;

Vec vec_of(const Matrix6 &m) { return Vec(m.begin(), m.end()); }
Matrix6 matrix_of(const Vec &v) {
  Matrix6 m{};
  std::copy_n(v.begin(), 36, m.begin());
  return m;
}
Vector6 vector_of(const double *x) {
  Vector6 v{};
  std::copy_n(x, kN, v.begin());
  return v;
}

bool finite_all(const Vec &v) {
  for (double x : v)
    if (!std::isfinite(x)) return false;
  return true;
}

// Sensor values (and, with `jacobian`, the m x 6 Jacobian) predicted for one
// state, the core filters' measurement(): y = H x + offset for LINEAR
// records, otherwise predict_measurement (the model the EKF/UKF and the
// observation simulator use).
bool measure_state(const Observation &o, const double *x, double *out, double *jacobian = nullptr) {
  const int m = o.value_count;
  if (o.kind == MeasurementKind::LINEAR) {
    if (o.linear_matrix.size() != static_cast<std::size_t>(m) * kN || o.linear_offset.size() != static_cast<std::size_t>(m)) return false;
    for (int i = 0; i < m; ++i) {
      double y = o.linear_offset[i];
      for (int j = 0; j < kN; ++j) {
        y += o.linear_matrix[i * kN + j] * x[j];
        if (jacobian) jacobian[i * kN + j] = o.linear_matrix[i * kN + j];
      }
      if (!std::isfinite(y)) return false;
      out[i] = y;
    }
    return true;
  }
  CartesianState s{};
  s.epoch_seconds = o.epoch_seconds;
  std::copy_n(x, kN, s.value.begin());
  const auto p = predict_measurement(o, s);
  if (p.count != m || p.count < 1) return false;
  for (int i = 0; i < m; ++i) {
    if (!std::isfinite(p.value[i])) return false;
    out[i] = p.value[i];
    if (jacobian)
      for (int j = 0; j < kN; ++j) jacobian[i * kN + j] = p.jacobian[i][j];
  }
  return true;
}

// The predicted measurement support, angles unwrapped about point 0 so a
// cloud straddling 0/2pi stays continuous (as the UKF's sigma cloud).
bool measure_support(const Observation &o, const Vec &points, int count, Vec *gamma) {
  const int m = o.value_count;
  gamma->assign(static_cast<std::size_t>(count) * m, 0.0);
  for (int k = 0; k < count; ++k)
    if (!measure_state(o, &points[k * kN], &(*gamma)[k * m])) return false;
  for (int k = 1; k < count; ++k)
    for (int i = 0; i < m; ++i)
      (*gamma)[k * m + i] = (*gamma)[i] + measurement_residual(o.kind, i, (*gamma)[k * m + i], (*gamma)[i]);
  return true;
}

// Innovation of the observation against a predicted value (wrapped).
void innovation(const Observation &o, const double *predicted, double *e) {
  for (int i = 0; i < o.value_count; ++i) e[i] = measurement_residual(o.kind, i, o.value[i], predicted[i]);
}

Vec sensor_shape(const Observation &o, double scale) {
  const int m = o.value_count;
  Vec r(static_cast<std::size_t>(m) * m, 0.0);
  for (int i = 0; i < m; ++i) r[i * m + i] = scale * scale * o.sigma[i] * o.sigma[i];
  return r;
}

// Propagates every point to `to`; requests all of them in one port round
// trip and returns false while any answer is pending.
bool propagate_all(const FilterConfig &config, const Vec &points, int count, double from, double to, Vec *out,
                   std::vector<Matrix6> *stms, std::string *error) {
  out->assign(points.size(), 0.0);
  if (stms) stms->assign(count, identity6());
  bool ready = true;
  for (int k = 0; k < count; ++k) {
    if (from == to) {
      std::copy_n(&points[k * kN], kN, &(*out)[k * kN]);
      continue;
    }
    CartesianState seed{};
    seed.epoch_seconds = from;
    std::copy_n(&points[k * kN], kN, seed.value.begin());
    PropagatorSample answer{};
    if (!config.propagator(seed, to, &answer)) {
      ready = false;
      continue;
    }
    if (!std::isfinite(answer.state.epoch_seconds) || std::abs(answer.state.epoch_seconds - to) > 1e-8) {
      *error = "propagated sample epoch differs from the target";
      return false;
    }
    for (int i = 0; i < kN; ++i) {
      if (!std::isfinite(answer.state.value[i])) {
        *error = "propagated sample is not finite";
        return false;
      }
      (*out)[k * kN + i] = answer.state.value[i];
    }
    if (stms) (*stms)[k] = answer.stm;
  }
  return ready;
}

// Affine stretch of a cloud about `center` taking shape `from` to shape `to`
// (x -> c + L_to L_from^-1 (x - c)). Affine maps carry the MVEE (and the
// spread) of the cloud exactly, so this realises the Minkowski expansion
// S = F + W of the prediction on the cloud (docs/espf-spec.md G5).
bool stretch(Vec *points, int count, const double *center, const Vec &from, const Vec &to) {
  Vec lf, lt;
  if (!teag::cholesky(from, kN, &lf) || !teag::cholesky(to, kN, &lt)) return false;
  Vec d(kN), z(kN);
  for (int k = 0; k < count; ++k) {
    for (int i = 0; i < kN; ++i) d[i] = (*points)[k * kN + i] - center[i];
    teag::solve_lower(lf, kN, d.data(), z.data());
    for (int i = 0; i < kN; ++i) {
      double v = center[i];
      for (int j = 0; j <= i; ++j) v += lt[i * kN + j] * z[j];
      (*points)[k * kN + i] = v;
    }
  }
  return true;
}

bool positive(const Matrix6 &q) {
  for (int i = 0; i < kN; ++i)
    if (q[i * kN + i] > 0.0) return true;
  return false;
}

// Spread (1/normalizer) sum (p_i - ref)(p_i - ref)' over `subset`.
Vec spread(const Vec &points, int dim, const std::vector<int> &subset, const double *ref, double normalizer) {
  Vec s(static_cast<std::size_t>(dim) * dim, 0.0);
  for (int k : subset)
    for (int a = 0; a < dim; ++a)
      for (int b = 0; b < dim; ++b)
        s[a * dim + b] += (points[k * dim + a] - ref[a]) * (points[k * dim + b] - ref[b]);
  for (double &v : s) v /= normalizer;
  return s;
}

bool mvee_of(const Vec &points, const std::vector<int> &subset, int dim, const EspfOptions &o, teag::Ellipsoid *e) {
  Vec sub;
  sub.reserve(subset.size() * dim);
  for (int k : subset)
    for (int i = 0; i < dim; ++i) sub.push_back(points[k * dim + i]);
  return teag::mvee(sub, static_cast<int>(subset.size()), dim, o.mvee_tolerance, o.mvee_max_iterations, e);
}

std::vector<int> all_indices(int count) {
  std::vector<int> v(count);
  std::iota(v.begin(), v.end(), 0);
  return v;
}

// Smolyak Clenshaw-Curtis grid scaled into the unit ball (its MVEE is the
// unit ball by symmetry), so that c + L xi has MVEE c, L L'.
Vec unit_grid(int level) {
  Vec g = teag::smolyak_clenshaw_curtis(kN, level);
  double worst = 0.0;
  for (std::size_t k = 0; k < g.size() / kN; ++k) {
    double s = 0.0;
    for (int i = 0; i < kN; ++i) s += g[k * kN + i] * g[k * kN + i];
    worst = std::max(worst, s);
  }
  const double scale = worst > 0 ? 1.0 / std::sqrt(worst) : 1.0;
  for (double &v : g) v *= scale;
  return g;
}

Vec place(const double *center, const Vec &shape, const Vec &grid, bool *ok) {
  Vec l;
  *ok = teag::cholesky(shape, kN, &l);
  const int count = static_cast<int>(grid.size() / kN);
  Vec out(grid.size());
  for (int k = 0; k < count; ++k)
    for (int i = 0; i < kN; ++i) {
      double v = center[i];
      for (int j = 0; j <= i; ++j) v += l[i * kN + j] * grid[k * kN + j];
      out[k * kN + i] = v;
    }
  return out;
}

FilterEpoch history_row(const SupportEpoch &e, const Vector6 &predicted_center) {
  FilterEpoch f{};
  f.filtered.epoch_seconds = f.predicted.epoch_seconds = f.smoothed.epoch_seconds = e.epoch_seconds;
  f.filtered.value = f.smoothed.value = e.estimate;
  f.predicted.value = predicted_center;
  f.filtered_covariance = f.smoothed_covariance = e.shape;
  f.predicted_covariance = e.predicted_shape;
  f.transition = identity6();
  f.normalized_innovation_squared = e.minimum_whitened_innovation;
  f.accepted = e.accepted;
  for (int i = 0; i < kN; ++i) {
    f.filtered_extended[i] = f.smoothed_extended[i] = e.estimate[i];
    for (int j = 0; j < kN; ++j)
      f.filtered_covariance_extended[8 * i + j] = f.smoothed_covariance_extended[8 * i + j] = e.shape[i * kN + j];
  }
  return f;
}

bool common_checks(const FilterConfig &config, const std::vector<Observation> &observations, FilterResult *result) {
  if (!config.propagator) { result->error = "ESPF and set-membership estimators need nonlinear propagation"; return false; }
  if (config.estimate_clock) { result->error = "ESPF and set-membership estimators estimate the six-state orbit only"; return false; }
  if (observations.empty()) { result->error = "no observations"; return false; }
  double previous = config.initial_support.valid ? config.initial_support.epoch_seconds : config.initial.epoch_seconds;
  for (const auto &o : observations) {
    if (!std::isfinite(o.epoch_seconds) || o.epoch_seconds < previous || o.value_count < 1 || o.value_count > 6 ||
        o.kind == MeasurementKind::PSEUDORANGE) {
      result->error = "observations must be chronological, 1..6 lanes, and not PSEUDORANGE";
      return false;
    }
    if (o.kind == MeasurementKind::LINEAR &&
        (o.linear_matrix.size() != static_cast<std::size_t>(o.value_count) * kN ||
         o.linear_offset.size() != static_cast<std::size_t>(o.value_count) || !finite_all(o.linear_matrix) ||
         !finite_all(o.linear_offset))) {
      result->error = "LINEAR observations need a finite value_count x 6 matrix and value_count offsets";
      return false;
    }
    for (int j = 0; j < o.value_count; ++j)
      if (!std::isfinite(o.value[j]) || !(o.sigma[j] > 0) || !std::isfinite(o.sigma[j])) {
        result->error = "observation values and sigmas must be finite, sigmas positive";
        return false;
      }
    previous = o.epoch_seconds;
  }
  for (double v : config.acceleration_psd)
    if (!std::isfinite(v) || v < 0) { result->error = "process noise spectral density must be finite and non-negative"; return false; }
  return true;
}

// ---------------------------------------------------------------------------
// ESPF 2026: TEAG section 5.1 with the ESPF-HJ recursion (Theorem 1) and the
// PCRB-admissible basin (TEAG Definition 3.15), minimum-q survivors with the
// N_min = 2n + 1 floor (2603.10065), the whitened minimax medoid (TEAG Axiom
// 3.5, ESPF-HJ eq. 49), MVEE regeneration with the possibility field reset to
// zero impossibility (ESPF-HJ Theorem 1 (iii)), and the asymmetric sigma
// controller r+ = 1.15, r- = 0.97 (ESPF-HJ section 6; TEAG Remark 3.25).
bool step_2026(const FilterConfig &c, const Observation &o, double from, SupportState *st, SupportEpoch *out,
               Vector6 *predicted_center, std::string *error, bool *pending) {
  const EspfOptions &opt = c.espf;
  const int count = st->count, m = o.value_count;
  const double dt = o.epoch_seconds - from;
  Vec predicted;
  if (!propagate_all(c, st->points, count, from, o.epoch_seconds, &predicted, nullptr, error)) {
    *pending = error->empty();
    return false;
  }
  const std::vector<int> all = all_indices(count);
  // Prediction: Jaynesian expansion, the Minkowski sum with the process set.
  teag::Ellipsoid ef;
  if (!mvee_of(predicted, all, kN, opt, &ef)) { *error = "the propagated support is degenerate (no MVEE)"; return false; }
  Vec predicted_shape = ef.shape;
  Matrix6 q = process_noise_covariance(c, dt);
  if (positive(q)) {
    Vec w = vec_of(q);
    for (double &v : w) v *= opt.process_bound_scale * opt.process_bound_scale;
    predicted_shape = teag::minkowski_outer(ef.shape, w, kN);
    if (!stretch(&predicted, count, ef.center.data(), ef.shape, predicted_shape)) { *error = "prediction stretch failed"; return false; }
  }
  std::copy_n(ef.center.begin(), kN, predicted_center->begin());
  // Update: whitened squared innovations in the MVEE-whitened measurement
  // space, Pi_e = bound(MVEE(h(X)) + Pi_y).
  Vec gamma;
  if (!measure_support(o, predicted, count, &gamma)) { *error = "measurement model failed on the support"; return false; }
  teag::Ellipsoid eg;
  Vec gamma_shape;
  if (count >= m + 1 && mvee_of(gamma, all, m, opt, &eg)) gamma_shape = eg.shape;
  else { gamma_shape = spread(gamma, m, all, &gamma[0], 1.0); }
  const Vec sensor = sensor_shape(o, opt.measurement_bound_scale);
  const Vec pi_e = teag::minkowski_outer(gamma_shape, sensor, m);
  Vec le;
  if (!teag::cholesky(pi_e, m, &le)) { *error = "innovation shape is not positive definite"; return false; }
  Vec qv(count), prior_phi(count), psi(count), prior_pi(count), e(m);
  double q_min = teag::kInfinity;
  for (int k = 0; k < count; ++k) {
    innovation(o, &gamma[k * m], e.data());
    qv[k] = teag::whitened_squared(le, m, e.data());
    psi[k] = 0.5 * qv[k];
    prior_pi[k] = st->possibility[k];
    prior_phi[k] = teag::impossibility(prior_pi[k]);
    q_min = std::min(q_min, qv[k]);
  }
  out->choquet_surprisal = teag::choquet_surprisal(qv, prior_pi);
  out->information = teag::information_content(out->choquet_surprisal);
  Vec field = teag::conjoin(prior_phi, psi);
  out->normalization_shift = teag::rescale(&field);
  out->minimum_whitened_innovation = q_min;
  const int n_eff = opt.pcrb_rank == 1 ? m : kN;
  const teag::PcrbBasin basin = teag::pcrb_basin(field, out->information, n_eff, 1.0);
  out->basin_radius = basin.radius;
  out->basin_threshold = basin.threshold;
  out->pcrb_floor = teag::pcrb_floor(n_eff, out->information);
  std::vector<int> order = all;
  std::stable_sort(order.begin(), order.end(), [&](int a, int b) { return field[a] < field[b]; });
  std::vector<int> survivors;
  for (int k : order)
    if (field[k] <= basin.threshold) survivors.push_back(k);
  const int n_min = opt.minimum_survivors > 0 ? opt.minimum_survivors : 2 * kN + 1;
  if (static_cast<int>(survivors.size()) < n_min) survivors.assign(order.begin(), order.begin() + std::min(n_min, count));
  std::sort(survivors.begin(), survivors.end());
  out->support_count = count;
  out->survivor_count = static_cast<int>(survivors.size());
  teag::Ellipsoid es;
  if (!mvee_of(predicted, survivors, kN, opt, &es)) { *error = "the surviving support is degenerate (no MVEE)"; return false; }
  // Commitment: the whitened minimax medoid of the survivors.
  int medoid = -1;
  if (opt.medoid_metric == 1) medoid = teag::minimax_medoid(gamma, m, survivors, pi_e);
  else medoid = teag::minimax_medoid(predicted, kN, survivors, es.shape);
  if (medoid < 0) { *error = "medoid failed"; return false; }
  out->medoid_index = medoid;
  // Sigma controller: expand when the realised contraction reaches the PCRB
  // floor (scaled by pcrb_trigger), otherwise contract.
  double lv_post = 0, lv_pred = 0;
  if (!teag::log_det_spd(es.shape, kN, &lv_post) || !teag::log_det_spd(predicted_shape, kN, &lv_pred)) {
    *error = "log det failed";
    return false;
  }
  out->log_volume_change = 0.5 * (lv_post - lv_pred);
  if (out->information > 0.0 && out->log_volume_change <= opt.pcrb_trigger * out->pcrb_floor) st->sigma = std::min(opt.sigma_max, st->sigma * opt.rate_expand);
  else st->sigma = std::max(opt.sigma_min, st->sigma * opt.rate_contract);
  {
    double ld = 0;
    if (teag::log_det_spd(gamma_shape, m, &ld)) {
      double ls = 0;
      if (teag::log_det_spd(sensor, m, &ls)) out->regime_log_det = ld - ls;
    }
  }
  if (opt.entropy_diagnostics) {
    Vec pts, poss;
    for (int k : survivors) {
      for (int i = 0; i < kN; ++i) pts.push_back(predicted[k * kN + i]);
      poss.push_back(teag::possibility(field[k]));
    }
    teag::EntropyReport rep;
    if (teag::possibilistic_entropy(pts, poss, kN, 2 * kN + 1, &rep)) { out->entropy = rep.entropy; out->entropy_alpha = rep.truncation_alpha; }
  }
  if (opt.record_support)
    for (int k : survivors) {
      for (int i = 0; i < kN; ++i) out->survivors.push_back(predicted[k * kN + i]);
      out->survivor_possibility.push_back(teag::possibility(field[k]));
    }
  // Regeneration about the medoid with the survivors' MVEE scaled by sigma^2,
  // VFI eigenvalue floor, possibility reset to 1.
  Vec carried = es.shape;
  for (double &v : carried) v *= st->sigma * st->sigma;
  if (!teag::clamp_eigenvalues(&carried, kN, opt.vfi_floor_ratio)) { *error = "VFI clamp failed"; return false; }
  bool ok = false;
  const Vec grid = unit_grid(opt.smolyak_level > 0 ? opt.smolyak_level : 3);
  st->points = place(&predicted[medoid * kN], carried, grid, &ok);
  if (!ok) { *error = "regeneration shape is not positive definite"; return false; }
  st->count = static_cast<int>(grid.size() / kN);
  st->possibility.assign(st->count, 1.0);
  st->estimate = vector_of(&predicted[medoid * kN]);
  st->shape = matrix_of(carried);
  st->epoch_seconds = o.epoch_seconds;
  ++st->steps;
  out->epoch_seconds = o.epoch_seconds;
  out->estimate = st->estimate;
  out->shape = matrix_of(es.shape);
  out->carried_shape = st->shape;
  out->predicted_shape = matrix_of(predicted_shape);
  out->sigma = st->sigma;
  out->accepted = true;
  return true;
}

// ---------------------------------------------------------------------------
// ESPF 2025 (2508.20806): support points propagated (section 7.1), Minkowski
// prediction (7.2-7.3), joint epistemic spread and uniform compatibility
// (8.1), surprisal pruning (8.2), sup-min fusion (8.3), mode extraction
// (section 9), spread, radius and sigma adaptation (10.1-10.3), kernel (10.4)
// and regeneration (10.5); the Algorithm block of section 12.
bool step_2025(const FilterConfig &c, const Observation &o, double from, SupportState *st, SupportEpoch *out,
               Vector6 *predicted_center, std::string *error, bool *pending) {
  const EspfOptions &opt = c.espf;
  const int count = st->count, m = o.value_count;
  const double dt = o.epoch_seconds - from;
  Vec predicted;
  if (!propagate_all(c, st->points, count, from, o.epoch_seconds, &predicted, nullptr, error)) {
    *pending = error->empty();
    return false;
  }
  const std::vector<int> all = all_indices(count);
  std::vector<int> rest(all.begin() + 1, all.end());
  const double norm = std::max(1, count - 1);  // 1/(2n) for 2n + 1 points
  Vec pf = spread(predicted, kN, rest, &predicted[0], norm);
  Matrix6 q = process_noise_covariance(c, dt);
  Vec pred_shape = pf;
  if (positive(q)) {
    Vec w = vec_of(q);
    for (double &v : w) v *= opt.process_bound_scale * opt.process_bound_scale;
    pred_shape = teag::minkowski_outer(pf, w, kN);
    if (!stretch(&predicted, count, &predicted[0], pf, pred_shape)) { *error = "prediction stretch failed"; return false; }
  }
  std::copy_n(&predicted[0], kN, predicted_center->begin());
  Vec gamma;
  if (!measure_support(o, predicted, count, &gamma)) { *error = "measurement model failed on the support"; return false; }
  const Vec ph = spread(gamma, m, rest, &gamma[0], norm);
  const Vec sensor = sensor_shape(o, opt.measurement_bound_scale);
  const Vec pi_e = teag::minkowski_outer(ph, sensor, m);
  Vec le;
  if (!teag::cholesky(pi_e, m, &le)) { *error = "joint epistemic spread is not positive definite"; return false; }
  const double r2 = st->radius * st->radius;
  Vec d2(count), comp(count), surprisal(count), e(m);
  std::vector<int> survivors;
  double mean_s = 0;
  for (int k = 0; k < count; ++k) {
    innovation(o, &gamma[k * m], e.data());
    d2[k] = teag::whitened_squared(le, m, e.data());
    comp[k] = d2[k] <= r2 ? 1.0 : 0.0;
    surprisal[k] = -std::log(comp[k] + opt.compatibility_floor);
    mean_s += surprisal[k] / count;
    if (surprisal[k] <= opt.surprisal_threshold) survivors.push_back(k);
  }
  out->support_count = count;
  out->mean_surprisal = mean_s;
  out->minimum_whitened_innovation = *std::min_element(d2.begin(), d2.end());
  if (survivors.empty()) {  // every hypothesis falsified: no update (G9)
    out->inconsistent = true;
    out->accepted = false;
    survivors = all;
    for (int k = 0; k < count; ++k) comp[k] = 1.0;
  }
  out->survivor_count = out->inconsistent ? 0 : static_cast<int>(survivors.size());
  // Sup-min fusion and mode extraction w ~ pi N.
  Vec posterior(count, 0.0);
  for (int k : survivors) posterior[k] = std::min(st->possibility[k], comp[k]);
  Vec weight(count, 0.0);
  double total = 0;
  if (opt.mode_weighting == 1) {
    for (int k : survivors) {
      double other = 0;
      for (int j : survivors) if (j != k) other = std::max(other, posterior[j]);
      weight[k] = posterior[k] * (1.0 - other);
      total += weight[k];
    }
    if (!(total > 0)) {  // ties at the maximum: their mean
      const double top = *std::max_element(posterior.begin(), posterior.end());
      for (int k : survivors) weight[k] = posterior[k] == top ? 1.0 : 0.0;
      total = 0;
      for (int k : survivors) total += weight[k];
    }
  } else {
    for (int k : survivors) {  // with every hypothesis falsified the evidence carries no weight (G9)
      weight[k] = posterior[k] * (out->inconsistent || opt.mode_weighting == 2 ? comp[k] : std::exp(-0.5 * d2[k]));
      total += weight[k];
    }
    if (!(total > 0)) for (int k : survivors) { weight[k] = 1.0; total += 1.0; }
  }
  Vector6 mode{};
  for (int k : survivors)
    for (int i = 0; i < kN; ++i) mode[i] += weight[k] / total * predicted[k * kN + i];
  // Spread about the mode, (1/2n) sum over the retained points, regularized.
  Vec pk = spread(predicted, kN, survivors, mode.data(), norm);
  if (opt.regularization_relative) {
    for (int i = 0; i < kN; ++i) pk[i * kN + i] += opt.regularization * pk[i * kN + i];
  } else {
    for (int i = 0; i < kN; ++i) pk[i * kN + i] += opt.regularization;
  }
  Vec lk;
  if (!teag::cholesky(pk, kN, &lk)) {  // fewer survivors than dimensions: fall back to the predicted spread (G10)
    pk = pred_shape;
    if (!teag::cholesky(pk, kN, &lk)) { *error = "spread matrix is not positive definite"; return false; }
  }
  double dk = 0;
  teag::log_det_spd(pk, kN, &dk);
  const double ddk = st->steps > 0 ? dk - st->dispersion : 0.0;
  if (ddk > 0) st->radius *= 1.0 + opt.radius_gain_expand * ddk;
  else if (ddk < 0) st->radius *= std::max(0.0, 1.0 - opt.radius_gain_contract * std::abs(ddk));
  st->dispersion = dk;
  const double s_k = opt.surprisal_scale * (1.0 + opt.surprisal_gain * (mean_s - opt.surprisal_reference));
  const double raw = opt.spread_sigma0 * std::exp(-opt.dispersion_gain * dk + opt.surprisal_gain * (s_k - opt.surprisal_reference));
  double sigma = std::min(opt.spread_sigma_max, std::max(opt.spread_sigma_min, raw));
  ++st->steps;
  sigma *= std::exp(-opt.decay_rate * st->steps);
  st->sigma = sigma;
  if (opt.record_support)
    for (int k : survivors) {
      for (int i = 0; i < kN; ++i) out->survivors.push_back(predicted[k * kN + i]);
      out->survivor_possibility.push_back(posterior[k]);
    }
  // Kernel possibilities of the regenerated points and regeneration.
  st->count = 2 * kN + 1;
  st->points.assign(static_cast<std::size_t>(st->count) * kN, 0.0);
  st->possibility.assign(st->count, 1.0);
  for (int i = 0; i < kN; ++i) st->points[i] = mode[i];
  const double kernel = std::exp(-sigma * sigma / (2.0 * st->radius * st->radius));
  for (int j = 0; j < kN; ++j) {
    for (int i = 0; i < kN; ++i) {
      const double dv = (i >= j) ? sigma * lk[i * kN + j] : 0.0;
      st->points[(1 + j) * kN + i] = mode[i] + dv;
      st->points[(1 + kN + j) * kN + i] = mode[i] - dv;
    }
    st->possibility[1 + j] = st->possibility[1 + kN + j] = kernel;
  }
  st->estimate = mode;
  Vec carried = pk;
  for (double &v : carried) v *= sigma * sigma;
  st->shape = matrix_of(carried);
  st->epoch_seconds = o.epoch_seconds;
  out->epoch_seconds = o.epoch_seconds;
  out->estimate = mode;
  out->shape = matrix_of(pk);
  out->carried_shape = st->shape;
  out->predicted_shape = matrix_of(pred_shape);
  out->sigma = sigma;
  out->radius = st->radius;
  out->dispersion = dk;
  return true;
}

// ESPF 2025 in the Gaussian limit of its appendix: the unscented transform's
// points and weights, Gaussian kernels read as densities, additive Q and R,
// and product (Bayes) fusion. An independent implementation of the UKF, so
// that agreement with EstimatorKind::UNSCENTED_KALMAN_FILTER tests the
// reduction claim (docs/espf-spec.md T2).
bool step_gaussian(const FilterConfig &c, const Observation &o, double from, SupportState *st, SupportEpoch *out,
                   Vector6 *predicted_center, std::string *error, bool *pending) {
  const int m = o.value_count;
  const double dt = o.epoch_seconds - from;
  const double lambda_scale = c.ukf_alpha * c.ukf_alpha * (kN + c.ukf_kappa);
  const double wm0 = 1 - kN / lambda_scale, wc0 = wm0 + 1 - c.ukf_alpha * c.ukf_alpha + c.ukf_beta, wi = 0.5 / lambda_scale;
  auto sigma_points = [&](const Vector6 &x, const Vec &p, Vec *pts) {
    Vec l;
    if (!teag::cholesky(p, kN, &l)) return false;
    pts->assign(static_cast<std::size_t>(2 * kN + 1) * kN, 0.0);
    for (int i = 0; i < kN; ++i) (*pts)[i] = x[i];
    for (int j = 0; j < kN; ++j)
      for (int i = 0; i < kN; ++i) {
        const double d = i >= j ? std::sqrt(lambda_scale) * l[i * kN + j] : 0.0;
        (*pts)[(1 + j) * kN + i] = x[i] + d;
        (*pts)[(1 + kN + j) * kN + i] = x[i] - d;
      }
    return true;
  };
  const int count = 2 * kN + 1;
  Vector6 xp = st->estimate;
  Vec pp = vec_of(st->shape);
  if (dt != 0) {
    Vec pts, prop;
    if (!sigma_points(st->estimate, vec_of(st->shape), &pts)) { *error = "prior is not positive definite"; return false; }
    if (!propagate_all(c, pts, count, from, o.epoch_seconds, &prop, nullptr, error)) { *pending = error->empty(); return false; }
    for (int i = 0; i < kN; ++i) {
      xp[i] = prop[i];
      for (int k = 1; k < count; ++k) xp[i] += wi * (prop[k * kN + i] - prop[i]);
    }
    std::fill(pp.begin(), pp.end(), 0.0);
    for (int k = 0; k < count; ++k) {
      const double w = k == 0 ? wc0 : wi;
      for (int a = 0; a < kN; ++a)
        for (int b = 0; b < kN; ++b) pp[a * kN + b] += w * (prop[k * kN + a] - xp[a]) * (prop[k * kN + b] - xp[b]);
    }
  }
  const Matrix6 q = process_noise_covariance(c, dt);
  for (int i = 0; i < 36; ++i) pp[i] += q[i];
  for (int a = 0; a < kN; ++a)
    for (int b = 0; b < a; ++b) pp[a * kN + b] = pp[b * kN + a] = 0.5 * (pp[a * kN + b] + pp[b * kN + a]);
  *predicted_center = xp;
  Vec pts;
  if (!sigma_points(xp, pp, &pts)) { *error = "predicted covariance is not positive definite"; return false; }
  Vec gamma(static_cast<std::size_t>(count) * m);
  for (int k = 0; k < count; ++k)
    if (!measure_state(o, &pts[k * kN], &gamma[k * m])) { *error = "measurement model failed"; return false; }
  Vec mean(m);
  for (int i = 0; i < m; ++i) {
    mean[i] = gamma[i];
    for (int k = 1; k < count; ++k) mean[i] += wi * measurement_residual(o.kind, i, gamma[k * m + i], gamma[i]);
  }
  Vec s(static_cast<std::size_t>(m) * m, 0.0), cxy(static_cast<std::size_t>(kN) * m, 0.0), dy(m);
  for (int k = 0; k < count; ++k) {
    const double w = k == 0 ? wc0 : wi;
    for (int i = 0; i < m; ++i) dy[i] = measurement_residual(o.kind, i, gamma[k * m + i], mean[i]);
    for (int a = 0; a < m; ++a)
      for (int b = 0; b < m; ++b) s[a * m + b] += w * dy[a] * dy[b];
    for (int a = 0; a < kN; ++a)
      for (int b = 0; b < m; ++b) cxy[a * m + b] += w * (pts[k * kN + a] - xp[a]) * dy[b];
  }
  for (int i = 0; i < m; ++i) s[i * m + i] += o.sigma[i] * o.sigma[i];
  Vec sinv;
  if (!teag::spd_inverse(s, m, &sinv)) { *error = "innovation covariance is not positive definite"; return false; }
  Vec innov(m);
  for (int i = 0; i < m; ++i) innov[i] = measurement_residual(o.kind, i, o.value[i], mean[i]);
  Vec gain(static_cast<std::size_t>(kN) * m, 0.0);
  for (int a = 0; a < kN; ++a)
    for (int b = 0; b < m; ++b)
      for (int k = 0; k < m; ++k) gain[a * m + b] += cxy[a * m + k] * sinv[k * m + b];
  Vector6 xu = xp;
  for (int a = 0; a < kN; ++a)
    for (int b = 0; b < m; ++b) xu[a] += gain[a * m + b] * innov[b];
  Vec pu = pp;
  for (int a = 0; a < kN; ++a)
    for (int b = 0; b < kN; ++b)
      for (int k = 0; k < m; ++k) pu[a * kN + b] -= gain[a * m + k] * cxy[b * m + k];
  for (int a = 0; a < kN; ++a)
    for (int b = 0; b < a; ++b) pu[a * kN + b] = pu[b * kN + a] = 0.5 * (pu[a * kN + b] + pu[b * kN + a]);
  double nis = 0;
  for (int a = 0; a < m; ++a)
    for (int b = 0; b < m; ++b) nis += innov[a] * sinv[a * m + b] * innov[b];
  st->estimate = xu;
  st->shape = matrix_of(pu);
  st->epoch_seconds = o.epoch_seconds;
  ++st->steps;
  out->epoch_seconds = o.epoch_seconds;
  out->estimate = xu;
  out->shape = out->carried_shape = st->shape;
  out->predicted_shape = matrix_of(pp);
  out->minimum_whitened_innovation = nis;
  out->support_count = out->survivor_count = count;
  out->accepted = true;
  return true;
}

SupportState initial_support(const FilterConfig &c, bool *ok, std::string *error) {
  *ok = false;
  if (c.initial_support.valid) {
    SupportState s = c.initial_support;
    if (s.count < 0 || s.points.size() != static_cast<std::size_t>(s.count) * kN ||
        s.possibility.size() != static_cast<std::size_t>(s.count) || !finite_all(s.points)) {
      *error = "initial support is malformed";
      return s;
    }
    *ok = true;
    return s;
  }
  SupportState s{};
  s.epoch_seconds = c.initial.epoch_seconds;
  s.estimator = c.estimator;
  s.estimate = c.initial.value;
  const EspfOptions &o = c.espf;
  Vec p0 = vec_of(c.initial_covariance);
  if (c.estimator == EstimatorKind::ESPF_2025 && o.gaussian_limit) {
    s.shape = c.initial_covariance;
    s.count = 0;
    *ok = true;
    return s;
  }
  const double r0 = c.estimator == EstimatorKind::ELLIPSOIDAL_SET_MEMBERSHIP ? c.set_membership.initial_bound_scale : o.initial_bound_scale;
  Vec s0 = p0;
  for (double &v : s0) v *= r0 * r0;
  s.shape = matrix_of(s0);
  if (c.estimator == EstimatorKind::ELLIPSOIDAL_SET_MEMBERSHIP) {
    Vec l;
    if (!teag::cholesky(s0, kN, &l)) { *error = "initial covariance is not positive definite"; return s; }
    *ok = true;
    return s;
  }
  if (c.estimator == EstimatorKind::ESPF_2025) {
    // The admissible box [x0 - r0 sqrt(P0_ii), x0 + r0 sqrt(P0_ii)] and the
    // Smolyak points mapped into it (2025 sections 6.1 and 6.4.3).
    const Vec grid = teag::smolyak_clenshaw_curtis(kN, o.smolyak_level > 0 ? o.smolyak_level : 2);
    s.count = static_cast<int>(grid.size() / kN);
    s.points.resize(grid.size());
    for (int k = 0; k < s.count; ++k)
      for (int i = 0; i < kN; ++i) {
        const double half = r0 * std::sqrt(std::max(0.0, p0[i * kN + i]));
        if (!(half > 0)) { *error = "initial covariance has a non-positive diagonal"; return s; }
        s.points[k * kN + i] = c.initial.value[i] + half * grid[k * kN + i];
      }
    s.possibility.assign(s.count, 1.0);
    s.sigma = o.spread_sigma0;
    s.radius = o.plausibility_radius;
    *ok = true;
    return s;
  }
  const Vec grid = unit_grid(o.smolyak_level > 0 ? o.smolyak_level : 3);
  bool placed = false;
  s.points = place(c.initial.value.data(), s0, grid, &placed);
  if (!placed) { *error = "initial covariance is not positive definite"; return s; }
  s.count = static_cast<int>(grid.size() / kN);
  s.possibility.assign(s.count, 1.0);
  s.sigma = o.sigma_initial;
  *ok = true;
  return s;
}

}  // namespace

FilterResult support_filter(const FilterConfig &config, const std::vector<Observation> &observations) {
  FilterResult result{};
  if (config.estimator != EstimatorKind::ESPF_2025 && config.estimator != EstimatorKind::ESPF_2026) {
    result.error = "support_filter runs ESPF_2025 or ESPF_2026";
    return result;
  }
  if (!common_checks(config, observations, &result)) return result;
  bool ok = false;
  SupportState st = initial_support(config, &ok, &result.error);
  if (!ok) return result;
  double previous = st.epoch_seconds;
  for (std::size_t index = 0; index < observations.size(); ++index) {
    const Observation &o = observations[index];
    SupportEpoch epoch{};
    Vector6 predicted_center{};
    bool pending = false;
    std::string error;
    bool stepped = false;
    if (config.estimator == EstimatorKind::ESPF_2026) stepped = step_2026(config, o, previous, &st, &epoch, &predicted_center, &error, &pending);
    else if (config.espf.gaussian_limit) stepped = step_gaussian(config, o, previous, &st, &epoch, &predicted_center, &error, &pending);
    else stepped = step_2025(config, o, previous, &st, &epoch, &predicted_center, &error, &pending);
    if (!stepped) {
      if (!pending) result.error = error.empty() ? "ESPF step failed" : error;
      return result;
    }
    if (!epoch.accepted) result.rejected_indices.push_back(index);
    result.epochs.push_back(history_row(epoch, predicted_center));
    result.support.push_back(std::move(epoch));
    previous = o.epoch_seconds;
  }
  st.estimator = config.estimator;
  st.valid = true;
  result.final_support = st;
  result.valid = true;
  return result;
}

// ---------------------------------------------------------------------------
// Ellipsoidal set-membership filter (Schweppe 1968; Bertsekas and Rhodes
// 1971; the optimal bounding ellipsoid family of Fogel and Huang 1982):
// predict x+ = f(x), E+ = bound(F E F' + W) (minimum-trace outer bound),
// update by the outer ellipsoid of the intersection of E with the
// linearized measurement set {x : (y - h(x))' R_b^-1 (y - h(x)) <= 1},
// minimizing trace (or log det) over the family parameter. An empty
// intersection leaves the set unchanged and flags the observation.
// Linearization error is not bounded (docs/espf-spec.md B1).
FilterResult set_membership_filter(const FilterConfig &config, const std::vector<Observation> &observations) {
  FilterResult result{};
  if (config.estimator != EstimatorKind::ELLIPSOIDAL_SET_MEMBERSHIP) { result.error = "set_membership_filter runs ELLIPSOIDAL_SET_MEMBERSHIP"; return result; }
  if (!common_checks(config, observations, &result)) return result;
  bool ok = false;
  SupportState st = initial_support(config, &ok, &result.error);
  if (!ok) return result;
  const SetMembershipOptions &so = config.set_membership;
  double previous = st.epoch_seconds;
  for (std::size_t index = 0; index < observations.size(); ++index) {
    const Observation &o = observations[index];
    const int m = o.value_count;
    const double dt = o.epoch_seconds - previous;
    Vec center(st.estimate.begin(), st.estimate.end()), propagated;
    std::vector<Matrix6> stm;
    std::string error;
    if (!propagate_all(config, center, 1, previous, o.epoch_seconds, &propagated, &stm, &error)) {
      if (!error.empty()) result.error = error;
      return result;
    }
    // Predicted set F P F' (+) W.
    Vec p = vec_of(st.shape), f = vec_of(stm[0]), fp(36, 0.0), pf(36, 0.0);
    for (int a = 0; a < kN; ++a)
      for (int b = 0; b < kN; ++b)
        for (int k = 0; k < kN; ++k) fp[a * kN + b] += f[a * kN + k] * p[k * kN + b];
    for (int a = 0; a < kN; ++a)
      for (int b = 0; b < kN; ++b)
        for (int k = 0; k < kN; ++k) pf[a * kN + b] += fp[a * kN + k] * f[b * kN + k];
    Matrix6 q = process_noise_covariance(config, dt);
    if (positive(q)) {
      Vec w = vec_of(q);
      for (double &v : w) v *= so.process_bound_scale * so.process_bound_scale;
      pf = teag::minkowski_outer(pf, w, kN);
    }
    for (int a = 0; a < kN; ++a)
      for (int b = 0; b < a; ++b) pf[a * kN + b] = pf[b * kN + a] = 0.5 * (pf[a * kN + b] + pf[b * kN + a]);
    // Linearized measurement.
    Vec e(m), h(static_cast<std::size_t>(m) * kN), rb = sensor_shape(o, so.measurement_bound_scale), rbinv, predicted_values(m);
    if (!measure_state(o, propagated.data(), predicted_values.data(), h.data())) { result.error = "measurement model failed"; return result; }
    for (int i = 0; i < m; ++i) e[i] = measurement_residual(o.kind, i, o.value[i], predicted_values[i]);
    teag::spd_inverse(rb, m, &rbinv);
    Vec pinv;
    if (!teag::spd_inverse(pf, kN, &pinv)) { result.error = "predicted set is not positive definite"; return result; }
    // H' Rb^-1 H and H' Rb^-1 e.
    Vec hth(36, 0.0), hte(kN, 0.0);
    double ete = 0;
    for (int a = 0; a < m; ++a)
      for (int b = 0; b < m; ++b) ete += e[a] * rbinv[a * m + b] * e[b];
    for (int i = 0; i < kN; ++i)
      for (int a = 0; a < m; ++a)
        for (int b = 0; b < m; ++b) {
          hte[i] += h[a * kN + i] * rbinv[a * m + b] * e[b];
          for (int j = 0; j < kN; ++j) hth[i * kN + j] += h[a * kN + i] * rbinv[a * m + b] * h[b * kN + j];
        }
    // The outer family {(1 - rho) dx' P^-1 dx + rho (e - H dx)' Rb^-1 (e - H dx) <= 1}
    // contains the intersection for every rho in [0, 1). By the S-lemma the
    // intersection is empty iff beta(rho) < 0 for some rho; otherwise the
    // member minimizing the criterion is the update (Schweppe 1968, sec. 4;
    // Fogel and Huang 1982).
    struct Member { bool ok{false}; double beta{-1}; Vec shape; Vec delta; double cost{teag::kInfinity}; };
    auto member = [&](double rho) {
      Member c;
      Vec mm(36);
      for (int i = 0; i < 36; ++i) mm[i] = (1.0 - rho) * pinv[i] + rho * hth[i];
      Vec minv;
      if (!teag::spd_inverse(mm, kN, &minv)) return c;
      c.delta.assign(kN, 0.0);
      for (int i = 0; i < kN; ++i)
        for (int j = 0; j < kN; ++j) c.delta[i] += minv[i * kN + j] * rho * hte[j];
      double dmd = 0;
      for (int i = 0; i < kN; ++i)
        for (int j = 0; j < kN; ++j) dmd += c.delta[i] * mm[i * kN + j] * c.delta[j];
      c.beta = 1.0 - rho * ete + dmd;
      if (!(c.beta > 0.0) || !std::isfinite(c.beta)) return c;
      c.shape = minv;
      for (double &v : c.shape) v *= c.beta;
      double cost = 0;
      if (so.criterion == 1) { if (!teag::log_det_spd(c.shape, kN, &cost)) return c; }
      else cost = teag::trace(c.shape, kN);
      c.cost = cost;
      c.ok = true;
      return c;
    };
    const int grid_points = 200;
    const double rho_max = 1.0 - 1e-9;
    bool empty = false;
    Member best = member(0.0);
    double best_rho = 0.0;
    for (int k = 1; k <= grid_points; ++k) {
      const double rho = rho_max * k / grid_points;
      Member c = member(rho);
      if (c.beta < 0.0 && std::isfinite(c.beta)) empty = true;
      if (c.ok && c.cost < best.cost) { best = c; best_rho = rho; }
    }
    if (!empty) {  // golden-section refinement about the best grid member
      double lo = std::max(0.0, best_rho - rho_max / grid_points), hi = std::min(rho_max, best_rho + rho_max / grid_points);
      const double g = 0.5 * (std::sqrt(5.0) - 1.0);
      double x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo);
      Member c1 = member(x1), c2 = member(x2);
      for (int it = 0; it < 60; ++it) {
        if (c1.cost <= c2.cost) { hi = x2; x2 = x1; c2 = c1; x1 = hi - g * (hi - lo); c1 = member(x1); }
        else { lo = x1; x1 = x2; c1 = c2; x2 = lo + g * (hi - lo); c2 = member(x2); }
      }
      for (const Member *c : {&c1, &c2})
        if (c->ok && c->cost < best.cost) best = *c;
    }
    SupportEpoch ep{};
    ep.epoch_seconds = o.epoch_seconds;
    ep.predicted_shape = matrix_of(pf);
    Vector6 predicted_center = vector_of(propagated.data());
    Vector6 center_out = predicted_center;
    Matrix6 shape_out = matrix_of(pf);
    if (!empty && best.ok) {
      for (int i = 0; i < kN; ++i) center_out[i] += best.delta[i];
      shape_out = matrix_of(best.shape);
    }
    ep.inconsistent = empty;
    ep.accepted = !empty;
    ep.estimate = center_out;
    ep.shape = ep.carried_shape = shape_out;
    // Innovation statistic of the centre against the set-implied spread.
    {
      Vec s(static_cast<std::size_t>(m) * m, 0.0), sinv;
      for (int a = 0; a < m; ++a)
        for (int b = 0; b < m; ++b) {
          for (int i = 0; i < kN; ++i)
            for (int j = 0; j < kN; ++j) s[a * m + b] += h[a * kN + i] * pf[i * kN + j] * h[b * kN + j];
          if (a == b) s[a * m + a] += rb[a * m + a];
        }
      if (teag::spd_inverse(s, m, &sinv)) {
        double v = 0;
        for (int a = 0; a < m; ++a)
          for (int b = 0; b < m; ++b) v += e[a] * sinv[a * m + b] * e[b];
        ep.minimum_whitened_innovation = v;
      }
    }
    ep.support_count = ep.survivor_count = 1;
    if (empty) result.rejected_indices.push_back(index);
    st.estimate = center_out;
    st.shape = shape_out;
    st.epoch_seconds = o.epoch_seconds;
    ++st.steps;
    result.epochs.push_back(history_row(ep, predicted_center));
    result.support.push_back(std::move(ep));
    previous = o.epoch_seconds;
  }
  st.estimator = config.estimator;
  st.valid = true;
  result.final_support = st;
  result.valid = true;
  return result;
}

}  // namespace sdn::estimation
