// -----------------------------------------------------------------------------
// The invoke surface: `fit` takes $OEM ephemerides (one fit per data block:
// EPHEMERIS_DATA_LINES, TEME or Earth-fixed, UTC, km) and returns one $OCM
// element set per block (ocm.inc): SGP4XP under the theory's own forces (BTERM
// and AGOM fitted, at the two-line text's digits), AP under any other $PCF
// FORCES, its epoch the first state of the fit interval (USEABLE_START_TIME to
// USEABLE_STOP_TIME, the whole block when neither is stated); later states are
// held out and scored. The record carries the forces, the daily rows and the
// density-correction nodes the set flies on, the orbit determination and its
// FIT_STATISTICS, typed. PROVENANCE is this module's, or, where the call gives
// the ephemeris's $PVN on 'provenance' (none, or one per 'ephemeris' frame in
// their order), that PVN field for field with this module as PRODUCER.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace fitoem {

struct Sample {
  double whole, frac;  // split Julian date (UTC)
  double r[3], v[3];
  bool has_v;
};

/// Osculating two-body Keplerian elements of a TEME state (km, km/s), as the
/// starting set of the fit.
inline void start_row(const Sample& s, ElementRow& row) {
  const double mu = 398600.4415;
  const double* r = s.r;
  const double* v = s.v;
  const double rn = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  const double v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const double h[3] = {r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]};
  const double hn = std::sqrt(h[0] * h[0] + h[1] * h[1] + h[2] * h[2]);
  const double rv = r[0] * v[0] + r[1] * v[1] + r[2] * v[2];
  double ev[3];
  for (int j = 0; j < 3; ++j) ev[j] = ((v2 - mu / rn) * r[j] - rv * v[j]) / mu;
  const double e = std::sqrt(ev[0] * ev[0] + ev[1] * ev[1] + ev[2] * ev[2]);
  const double a = 1.0 / (2.0 / rn - v2 / mu);
  const double inc = std::acos(h[2] / hn);
  double node = std::atan2(h[0], -h[1]);
  const double nvec[3] = {std::cos(node), std::sin(node), 0.0};
  double argp = std::atan2((h[0] * (nvec[1] * ev[2] - nvec[2] * ev[1]) + h[1] * (nvec[2] * ev[0] - nvec[0] * ev[2]) +
                            h[2] * (nvec[0] * ev[1] - nvec[1] * ev[0])) / hn,
                           nvec[0] * ev[0] + nvec[1] * ev[1] + nvec[2] * ev[2]);
  double nu = std::atan2((h[0] * (ev[1] * r[2] - ev[2] * r[1]) + h[1] * (ev[2] * r[0] - ev[0] * r[2]) +
                          h[2] * (ev[0] * r[1] - ev[1] * r[0])) / hn,
                         ev[0] * r[0] + ev[1] * r[1] + ev[2] * r[2]);
  const double E = 2.0 * std::atan(std::sqrt((1.0 - e) / (1.0 + e)) * std::tan(nu / 2.0));
  const double M = E - e * std::sin(E);
  auto deg = [](double x) { double d = x / kDeg; d -= 360.0 * std::floor(d / 360.0); return d; };
  row.mean_motion_rev_day = std::sqrt(mu / (a * a * a)) * 86400.0 / kTwoPi;
  row.eccentricity = e;
  row.inclination_deg = inc / kDeg;
  row.raan_deg = deg(node);
  row.arg_pericenter_deg = deg(argp);
  row.mean_anomaly_deg = deg(M);
}

/// The fit's prior on a term in the space the fit estimates it in: LOG_NORMAL its natural log (the mean the log of the
/// median, the sigma that of the log), GAUSSIAN_SIGNED the term itself.
inline void set_prior(const pcf::Prior& p, int32_t& log_flag, double& mean, double& sigma) {
  log_flag = p.form == pcfPriorForm_LOG_NORMAL ? 1 : 0;
  mean = log_flag ? std::log(p.mean) : p.mean;
  sigma = p.sigma;
}

inline bool text_epoch(const flatbuffers::String* s, double& whole, double& frac) {
  return s != nullptr && omm::epoch(s->c_str(), s->size(), whole, frac);
}

/// The CID of the call's $PCF (the first 'configuration' frame, its plain record): FIT_STATISTICS.PCF_CID.
inline std::string configuration_cid() {
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f == nullptr || f->port_id == nullptr || f->payload == nullptr || std::strcmp(f->port_id, "configuration") != 0) continue;
    const uint8_t* p = f->payload;
    uint32_t n = f->payload_length;
    plain_view(p, n, "$PCF");
    return sdn_cid::cid_v1_raw_sha256(p, n);
  }
  return std::string();
}

inline double minutes_between(double w0, double f0, double w1, double f1) {
  return ((w1 - w0) + (f1 - f0)) * kMinutesPerDay;
}

/// SPEC 17.3: the a priori sigma of each TEME position component the fit weights with (unit weights: 1 km), the
/// weighting it states (OD_DATA_WEIGHTING), and WEIGHTED_RMS: the post-fit RMS of the position components over that
/// sigma, sqrt(sum (r_i / sigma)^2 / (3 states)) = FIT_RMS_KM / sqrt(3) / sigma.
constexpr double kMeasurementSigmaKm = 1.0;
constexpr const char* kWeighting = "UNIT WEIGHTS: A PRIORI SIGMA 1 KM PER TEME POSITION COMPONENT";
inline double weighted_rms(double fit_rms_km) { return fit_rms_km / std::sqrt(3.0) / kMeasurementSigmaKm; }

/// SPEC 17.3: SEDR (W/kg) of a fitted set, the energy its non-gravitational forces remove (the $OCM's definition):
/// -dE/dt = (mu / (3 a)) (n-dot_ng / n), positive under drag, from `ng_rate` (n-dot_ng / n in 1/day, the theory's
/// epoch rates with and without BTERM), mu / a = (n a)^2 with the theory's mean motion and semi-major axis, in m and s.
inline double sedr(const ElementRow& row, double ng_rate) {
  const double n_min = row.mean_motion_rev_day * kTwoPi / kMinutesPerDay;
  const double a_m = std::pow(xpt::kKe / n_min, kX2o3) * xpt::kRe * 1000.0;
  const double na = n_min / 60.0 * a_m;  // m/s
  return (na * na / 3.0) * (ng_rate / 86400.0);
}

/// The default fit span (DESIGN 2e.3; the experiment's fit-length study: 48 / 72 h fits cut the 72-96 h
/// error from 2.96 to 0.50 / 0.37 km against 24 h).
constexpr double kDefaultSpanMinutes = 48.0 * 60.0;
/// The validation tail of the span rule: the latest 24 h of the useable data, a day-1 prediction (a 6 h tail
/// scores the fit's short-period error and kept 48 h on 17 of 21 sphere windows: day 3 0.144 km against 0.093 with
/// 24 h; GEO and IGSO keep 48 h with either; diagnostic: sdnap_span_tail_minutes).
inline double& tail_minutes() {
  static double t = 24.0 * 60.0;
  return t;
}

/// Diagnostics of the fit-design study (sdnap_fit_epoch_diagnostic, sdnap_fit_jacobian_diagnostic); the defaults change
/// nothing. epoch_placement: where the fitted set's epoch sits in the fit interval, 0 its first state (the module's), 1 the
/// state nearest its middle, 2 its last state. jacobian_always: 1 takes the finite-difference columns (fit::run's fallback)
/// in every fit, not only an eccentric orbit's.
inline int& epoch_placement() {
  static int p = 0;
  return p;
}
inline int& jacobian_always() {
  static int j = 0;
  return j;
}

}  // namespace fitoem
}  // namespace sdnap

namespace sdnap {
namespace fitoem {

/// An Earth set whose fit RMS exceeds this is refused (fit-implausible), km.
constexpr double kImplausibleRmsKm = 100.0;

/// Whether a block's first state (with a velocity) has an osculating eccentricity above `e_min` about the Earth.
inline bool eccentric_block(const ephemerisDataBlock* blk, double e_min) {
  const auto* lines = blk->EPHEMERIS_DATA_LINES();
  if (lines == nullptr || lines->size() == 0) return false;
  const ephemerisDataLine* L = lines->Get(0);
  const double r[3] = {L->X(), L->Y(), L->Z()}, v[3] = {L->X_DOT(), L->Y_DOT(), L->Z_DOT()};
  if (v[0] == 0.0 && v[1] == 0.0 && v[2] == 0.0) return false;
  double el[6];
  return twobody::elements_of(twobody::kMuEarth, r, v, el) && el[1] > e_min;
}

/// SPEC 12.8: a block whose first state is above e 0.3 (xpt::tess::kWideE) with its perigee below 2,500 km, where 3.4's
/// density acts: a 72 h arc there does not separate BTERM from the residuals of the field and the third bodies.
constexpr double kHighEDragArcMinutes = 7.0 * kMinutesPerDay;  ///< the arc the policy fits when the ephemeris allows
inline bool high_e_drag_block(const ephemerisDataBlock* blk) {
  const auto* lines = blk->EPHEMERIS_DATA_LINES();
  if (lines == nullptr || lines->size() == 0) return false;
  const ephemerisDataLine* L = lines->Get(0);
  const double r[3] = {L->X(), L->Y(), L->Z()}, v[3] = {L->X_DOT(), L->Y_DOT(), L->Z_DOT()};
  if (v[0] == 0.0 && v[1] == 0.0 && v[2] == 0.0) return false;
  double el[6];
  return twobody::elements_of(twobody::kMuEarth, r, v, el) && el[1] > xpt::tess::kWideE && el[0] > 0.0 &&
         el[0] * (1.0 - el[1]) - xpt::kRe < 2500.0;
}

/// The osculating period (minutes) of a block's first state about the Earth (0 when it carries no velocity).
inline double period_minutes(const ephemerisDataBlock* blk) {
  const auto* lines = blk->EPHEMERIS_DATA_LINES();
  if (lines == nullptr || lines->size() == 0) return 0.0;
  const ephemerisDataLine* L = lines->Get(0);
  const double r[3] = {L->X(), L->Y(), L->Z()}, v[3] = {L->X_DOT(), L->Y_DOT(), L->Z_DOT()};
  double el[6];
  if ((v[0] == 0.0 && v[1] == 0.0 && v[2] == 0.0) || !twobody::elements_of(twobody::kMuEarth, r, v, el) || !(el[0] > 0.0)) return 0.0;
  return kTwoPi * std::sqrt(el[0] * el[0] * el[0] / twobody::kMuEarth) / 60.0;
}

/// SPEC 12.8, the arc check of a fit. A data gap: two consecutive fitted states more than kArcGapRevolutions apart. An
/// along-track step (a maneuver indicator): the fit residuals' along-track component (model minus data on the model's
/// velocity direction), averaged per revolution over bins of at least 3 states, is regressed on a quadratic in time and
/// on the quadratic plus a hinge, max(0, t - t_h), at each boundary between bins with at least 3 bins on either side;
/// the hinge that lowers the residual sum the most is the candidate, its F ratio (the drop over the hinged fit's
/// residual variance) and the velocity step its rate change c implies, |c| / 3 (a tangential step dv changes the
/// along-track drift rate by 3 dv). A step is flagged when both pass kStepMinimumF and kStepMinimumMs.
constexpr double kArcGapRevolutions = 2.0;
constexpr double kStepMinimumMs = 0.002;
constexpr double kStepMinimumF = 100.0;
struct ArcCheck {
  double gap_minutes = 0.0;  ///< the largest interval between consecutive fitted states
  double gap_at = 0.0;       ///< its start, minutes from the epoch
  double step_ms = 0.0;      ///< the candidate hinge's velocity step, m/s
  double step_at = 0.0;      ///< its time, minutes from the epoch
  double step_f = 0.0;       ///< its F ratio
  int bins = 0;              ///< the revolution bins tested (0: too few for the test)
  bool gap = false, step = false;
};
inline ArcCheck arc_check(const ElementRow& row, const double* t, const double* r, int count) {
  ArcCheck c;
  if (count < 2 || !(row.mean_motion_rev_day > 0.0)) return c;
  std::vector<int> order(static_cast<size_t>(count));
  for (int k = 0; k < count; ++k) order[static_cast<size_t>(k)] = k;
  std::stable_sort(order.begin(), order.end(), [&](int a, int b) { return t[a] < t[b]; });
  for (int k = 1; k < count; ++k) {
    const double d = t[order[static_cast<size_t>(k)]] - t[order[static_cast<size_t>(k - 1)]];
    if (d > c.gap_minutes) { c.gap_minutes = d; c.gap_at = t[order[static_cast<size_t>(k - 1)]]; }
  }
  const double period = kMinutesPerDay / row.mean_motion_rev_day, t0 = t[order[0]];
  c.gap = c.gap_minutes > kArcGapRevolutions * period;
  const Elements e = elements_of(row);
  xpt::XpSat* s = static_cast<xpt::XpSat*>(std::malloc(sizeof(xpt::XpSat)));
  if (s == nullptr) return c;
  bool ok = xpt::xp_init(e, *s) == kPropOk;
  std::vector<double> sum_t, sum_a;
  std::vector<int> num;
  for (int q = 0; ok && q < count; ++q) {
    const int k = order[static_cast<size_t>(q)];
    double rm[3], vm[3];
    if (xpt::xp_propagate(*s, t[k], rm, vm) != kPropOk) { ok = false; break; }
    const double vn = std::sqrt(vm[0] * vm[0] + vm[1] * vm[1] + vm[2] * vm[2]);
    if (!(vn > 0.0)) { ok = false; break; }
    double along = 0.0;
    for (int j = 0; j < 3; ++j) along += (rm[j] - r[3 * k + j]) * vm[j] / vn;
    const size_t bin = static_cast<size_t>(std::floor((t[k] - t0) / period));
    if (bin >= num.size()) { sum_t.resize(bin + 1, 0.0); sum_a.resize(bin + 1, 0.0); num.resize(bin + 1, 0); }
    sum_t[bin] += t[k];
    sum_a[bin] += along;
    ++num[bin];
  }
  xpt::xp_release(*s);
  std::free(s);
  if (!ok) return c;
  std::vector<double> bt, ba;  // bin mean time (days from the arc's middle) and along-track residual (km)
  const double mid = 0.5 * (t0 + t[order[static_cast<size_t>(count - 1)]]);
  for (size_t b = 0; b < num.size(); ++b)
    if (num[b] >= 3) { bt.push_back((sum_t[b] / num[b] - mid) / kMinutesPerDay); ba.push_back(sum_a[b] / num[b]); }
  const int K = static_cast<int>(bt.size());
  if (K < 9) return c;
  c.bins = K;
  // least squares of ba on [1, tau, tau^2] and, with hinge >= 0, max(0, tau - tau_h): the residual sum, the hinge's slope
  auto regress = [&](double tau_h, bool hinge, double& slope) -> double {
    const int p = hinge ? 4 : 3;
    double A[16] = {}, y[4] = {};
    auto col = [&](int i, double tau) { return i == 0 ? 1.0 : i == 1 ? tau : i == 2 ? tau * tau : std::fmax(0.0, tau - tau_h); };
    for (int k = 0; k < K; ++k)
      for (int i = 0; i < p; ++i) {
        y[i] += col(i, bt[static_cast<size_t>(k)]) * ba[static_cast<size_t>(k)];
        for (int j = 0; j < p; ++j) A[i * p + j] += col(i, bt[static_cast<size_t>(k)]) * col(j, bt[static_cast<size_t>(k)]);
      }
    if (!fit::solve(A, y, p)) return -1.0;
    double rss = 0.0;
    for (int k = 0; k < K; ++k) {
      double m = 0.0;
      for (int i = 0; i < p; ++i) m += y[i] * col(i, bt[static_cast<size_t>(k)]);
      const double d = ba[static_cast<size_t>(k)] - m;
      rss += d * d;
    }
    slope = hinge ? y[3] : 0.0;
    return rss;
  };
  double unused = 0.0;
  const double rss0 = regress(0.0, false, unused);
  if (!(rss0 >= 0.0)) return c;
  double best = -1.0;
  for (int h = 3; h <= K - 3; ++h) {
    const double tau_h = 0.5 * (bt[static_cast<size_t>(h - 1)] + bt[static_cast<size_t>(h)]);
    double slope = 0.0;
    const double rss1 = regress(tau_h, true, slope);
    if (!(rss1 >= 0.0)) continue;
    const double f = rss1 > 0.0 ? (rss0 - rss1) / (rss1 / (K - 4)) : (rss0 > rss1 ? 1e300 : 0.0);
    if (f > best) {
      best = f;
      c.step_f = f;
      c.step_ms = std::fabs(slope) * 1000.0 / 86400.0 / 3.0;  // km/day of along-track rate to m/s of velocity
      c.step_at = mid + tau_h * kMinutesPerDay;
    }
  }
  c.step = c.step_f >= kStepMinimumF && c.step_ms >= kStepMinimumMs;
  return c;
}

/// SPEC 12.8, the drag prior's fall-back. After a fit of at least kFallbackArcHours under NRLMSISE-00 at 800 to 1400 km on
/// the band default (the wide sigma of the log), the fit is redone under the band median's prior of 0.4.11 (median 0.0005
/// m^2/kg, sigma of the log ln 10) when the posterior sigma of the log exceeds kFallbackSigmaLog (B), or BTERM moved more
/// than kFallbackMovedSigmas (k) posterior sigmas from the band median while the fit RMS exceeds kBandMedianRmsKm by
/// more than 25 %, or the arc check flags a data gap or an along-track step.
constexpr double kFallbackArcHours = 71.0;
constexpr double kFallbackSigmaLog = 0.5;
constexpr double kFallbackMovedSigmas = 3.0;
constexpr double kBandMedianRmsKm = 0.01516;
constexpr double kFallbackRmsRatio = 1.25;
constexpr double kBandMedianBterm = 0.0005;

/// The 'provenance' frames: none, or one verified $PVN (plain or size-prefixed) per 'ephemeris' frame in their order;
/// 0 with `out` filled, or 3 refused by name.
inline int provenance_frames(std::vector<const PVN*>& out) {
  out.clear();
  size_t ephemeris_frames = 0;
  for (uint32_t fi = 0; fi < plugin_get_input_count(); ++fi) {
    const plugin_input_frame_t* f = plugin_get_input_frame(fi);
    if (f == nullptr || f->port_id == nullptr) continue;
    if (std::strcmp(f->port_id, "ephemeris") == 0) ++ephemeris_frames;
    if (std::strcmp(f->port_id, "provenance") != 0) continue;
    const uint8_t* p = f->payload;
    uint32_t n = f->payload_length;
    if (!plain_view(p, n, "$PVN")) {
      plugin_set_error("invalid-pvn", "A 'provenance' payload is not an SDS $PVN (plain or size-prefixed).");
      return 3;
    }
    flatbuffers::Verifier::Options vopt;
    vopt.check_alignment = false;
    flatbuffers::Verifier v(p, n, vopt);
    if (!VerifyPVNBuffer(v)) {
      plugin_set_error("invalid-pvn", "A 'provenance' $PVN does not verify.");
      return 3;
    }
    out.push_back(GetPVN(p));
  }
  if (!out.empty() && out.size() != ephemeris_frames) {
    plugin_set_error("provenance-count", "Either no 'provenance' $PVN or one per 'ephemeris' frame, in their order.");
    return 3;
  }
  return 0;
}

}  // namespace fitoem
}  // namespace sdnap

/// The fit of every 'ephemeris' block: SGP4XP (theory 4).
static int fit_blocks() {
  using namespace sdnap;
  plugin_reset_output_state();
  const uint32_t frames = plugin_get_input_count();
  // SPEC 12.8: after the call's $PCF, either no further $PCF or one per 'ephemeris' frame, in the frames' order
  const std::vector<pcf::ObjectPriors>& objects = pcf::object_priors();
  if (!objects.empty()) {
    size_t ephemeris_frames = 0;
    for (uint32_t fi = 0; fi < frames; ++fi) {
      const plugin_input_frame_t* f = plugin_get_input_frame(fi);
      if (f != nullptr && f->port_id != nullptr && std::strcmp(f->port_id, "ephemeris") == 0) ++ephemeris_frames;
    }
    if (objects.size() != ephemeris_frames)
      return pcf::refuse("configuration", "after the call's $PCF, either none or one $PCF per 'ephemeris' frame (its object's priors)");
  }
  std::vector<const PVN*> sources;
  if (const int rc = fitoem::provenance_frames(sources)) return rc;
  uint32_t blocks_done = 0;
  size_t ephemeris_index = 0;
  for (uint32_t fi = 0; fi < frames; ++fi) {
    const plugin_input_frame_t* f = plugin_get_input_frame(fi);
    if (f == nullptr || f->port_id == nullptr || std::strcmp(f->port_id, "ephemeris") != 0) continue;
    // the call's options with this frame's object priors where its $PCF states them
    pcf::Options frame_options = pcf::options();
    if (!objects.empty()) {
      const pcf::ObjectPriors& op = objects[ephemeris_index];
      if (op.drag_given) {
        frame_options.drag_prior = op.drag;
        frame_options.drag_prior_given = true;
      }
      if (op.srp_given) {
        frame_options.srp_prior = op.srp;
        frame_options.srp_prior_given = true;
      }
    }
    const PVN* source = sources.empty() ? nullptr : sources[ephemeris_index];
    ++ephemeris_index;
    const pcf::Options& po = frame_options;
    const uint8_t* payload = f->payload;
    uint32_t payload_length = f->payload_length;
    if (!plain_view(payload, payload_length, "$OEM")) {
      plugin_set_error("invalid-oem", "An 'ephemeris' payload is not an SDS $OEM (plain or size-prefixed).");
      return 3;
    }
    if (!verify_as_given<OEM>(f->payload, f->payload_length, payload, "$OEM")) {
      plugin_set_error("invalid-oem", "An 'ephemeris' $OEM does not verify.");
      return 3;
    }
    const OEM* oem = GetOEM(payload);
    const auto* blocks = oem->EPHEMERIS_DATA_BLOCK();
    if (blocks == nullptr) continue;
    uint32_t block_index = 0;
    for (const ephemerisDataBlock* blk : *blocks) {
      ++block_index;
      xpt::tess::FitGridScope fit_grids;
      // the block's center: Earth (the theories here are geocentric; a Moon-centered or heliocentric block is
      // refused by name, never read as geocentric)
      if (blk->CENTER_NAME() != nullptr && blk->CENTER_NAME()->size() > 0 && !oem::same_text(blk->CENTER_NAME()->c_str(), "EARTH")) {
        plugin_set_error("unsupported-center", "An 'ephemeris' block is not centered on the Earth (CENTER_NAME); fit (SGP4XP) is geocentric.");
        return 3;
      }
      // the block's declared axes: the enumeration, the coordinate system or REFERENCE_FRAME.NAME; never assumed
      const oem::Axes axes = oem::axes_of(blk->REFERENCE_FRAME());
      if (axes == oem::Axes::Undeclared) {
        plugin_set_error("reference-frame-undeclared",
                         "An 'ephemeris' block declares no REFERENCE_FRAME (enumeration, coordinate system or NAME); the fit assumes none.");
        return 3;
      }
      if (axes == oem::Axes::Conflict) {
        plugin_set_error("reference-frame-conflict", "An 'ephemeris' block's REFERENCE_FRAME enumeration and NAME disagree.");
        return 3;
      }
      if (axes == oem::Axes::Other) {
        plugin_set_error("unsupported-frame",
                         "TEME, GCRF (ICRF), EME2000 (J2000) and Earth-fixed (ITRF, ECEF, WGS84) ephemerides are fitted.");
        return 3;
      }
      const bool earth_fixed = axes == oem::Axes::EarthFixed;
      const bool eme2000 = axes == oem::Axes::Eme2000;
      const bool gcrf = axes == oem::Axes::Gcrf || eme2000;
      double bias[3][3];
      if (eme2000) frames::frame_bias(bias);
      if (blk->TIME_SYSTEM() != timingStandard_UTC) {
        plugin_set_error("unsupported-time-system", "Only UTC ephemerides are fitted.");
        return 3;
      }
      const auto* lines = blk->EPHEMERIS_DATA_LINES();
      const uint32_t n = lines == nullptr ? 0 : lines->size();
      if (n < 8) {
        plugin_set_error("too-few-states", "A block needs at least 8 states.");
        return 3;
      }
      std::vector<fitoem::Sample> all(n);
      for (uint32_t k = 0; k < n; ++k) {
        const ephemerisDataLine* L = lines->Get(k);
        fitoem::Sample& s = all[k];
        if (!fitoem::text_epoch(L->EPOCH(), s.whole, s.frac)) {
          plugin_set_error("invalid-oem", "A state has no readable EPOCH.");
          return 3;
        }
        s.r[0] = L->X(); s.r[1] = L->Y(); s.r[2] = L->Z();
        s.v[0] = L->X_DOT(); s.v[1] = L->Y_DOT(); s.v[2] = L->Z_DOT();
        s.has_v = s.v[0] != 0.0 || s.v[1] != 0.0 || s.v[2] != 0.0;
        if (eme2000) {
          // GCRF = B^T EME2000 (the IAU 2006 frame bias), then as GCRF
          const double r0[3] = {s.r[0], s.r[1], s.r[2]}, v0[3] = {s.v[0], s.v[1], s.v[2]};
          frames::apply_transpose(bias, r0, s.r);
          frames::apply_transpose(bias, v0, s.v);
        }
        if (gcrf) {
          // TEME = R3(GAST06 - GMST82) NPB06 GCRF (gcrf.inc; IAU 2006/2000A through the pinned ERFA).
          double m[3][3];
          if (frames::gcrf_to_teme(s.whole, s.frac, m) < 0) {
            plugin_set_error("invalid-oem", "A GCRF state's UTC is outside ERFA's calendar.");
            return 3;
          }
          const double r0[3] = {s.r[0], s.r[1], s.r[2]}, v0[3] = {s.v[0], s.v[1], s.v[2]};
          frames::apply(m, r0, s.r);
          frames::apply(m, v0, s.v);
        } else if (earth_fixed) {
          // TEME = R3(-GMST82) (pseudo-)Earth-fixed; UT1 = UTC and the pole at its mean position, as without $EOP.
          const double th = gmst(s.whole, s.frac);
          const double c = std::cos(th), sn = std::sin(th);
          const double x = s.r[0], y = s.r[1];
          const double vx = s.v[0] - kEarthRotationRate * y, vy = s.v[1] + kEarthRotationRate * x;
          s.r[0] = c * x - sn * y;
          s.r[1] = sn * x + c * y;
          s.v[0] = c * vx - sn * vy;
          s.v[1] = sn * vx + c * vy;
        }
      }
      // fit interval
      double us_w = all[0].whole, us_f = all[0].frac, ue_w = all[n - 1].whole, ue_f = all[n - 1].frac;
      bool held_out_rule = false;
      const bool start_given = blk->USEABLE_START_TIME() != nullptr && fitoem::text_epoch(blk->USEABLE_START_TIME(), us_w, us_f);
      if (blk->USEABLE_STOP_TIME() != nullptr) held_out_rule = fitoem::text_epoch(blk->USEABLE_STOP_TIME(), ue_w, ue_f);
      if (po.has_holdout) {
        // $PCF FIT.HOLDOUT_HOURS: the fit ends that long before the data does (the block's own USEABLE_STOP_TIME
        // would say otherwise: refused by name)
        if (held_out_rule) return pcf::refuse("FIT.HOLDOUT_HOURS", "the ephemeris block gives its USEABLE_STOP_TIME");
        ue_w = all[n - 1].whole;
        ue_f = all[n - 1].frac - po.holdout_h / 24.0;
        held_out_rule = po.holdout_h > 0.0;
      }
      // DESIGN 2e.3 fit span, the documented rule: USEABLE_START_TIME to the end of the useable interval when it is
      // given; otherwise the latest 48 h, extended to 72 h and then 120 h while the drag is stable, judged on the
      // data: an extension is kept when its fit RMS is at most max(1.2 x, 0.02 km more than) the 48 h fit's (one
      // set of drag parameters holds over the longer arc); the first that is not, or that the data cannot cover,
      // ends the extension. Measured: 48 / 72 / 120 h arcs cut the laser-ranged spheres' day 3 from 0.30 (24 h) to
      // 0.12 / 0.11 / 0.07 km and Starlink's 72-96 h error from 0.96 to 0.225 / 0.122 km.
      uint32_t last_useable = n - 1;
      while (held_out_rule && last_useable > 0 &&
             fitoem::minutes_between(ue_w, ue_f, all[last_useable].whole, all[last_useable].frac) > 0.0) --last_useable;
      struct Pass {
        std::vector<double> t_fit, r_fit, t_out, r_out;
        uint32_t first = 0;
        fitoem::Sample e0{};
        ElementRow row{};
        fit::Options opt{};
        fit::Result res{};
        int iterations = 0;
        double first_pass_rms = 0.0;
        double fit_begin_min = 0.0, fit_end_min = 0.0;  ///< the fit interval's first and last state, minutes from the epoch
        pcf::Prior srp{};                                ///< AGOM's prior as used (SPEC 12.1 short-arc rule)
        bool wide_band = false;                          ///< BTERM on the 800-1400 km band default (SPEC 12.8)
      };
      const bool eccentric = fitoem::eccentric_block(blk, po.eccentricity_threshold);
      pcf::Prior used_drag = po.drag_prior;
      // span_minutes ending at all[end_index]; the states after it held out (the validation tail)
      auto run_pass = [&](double span_minutes, Pass& P, uint32_t end_index, int placement_override = -1,
                          const pcf::Prior* drag_override = nullptr, const pcf::Prior* srp_override = nullptr) -> int {
        const double saved_w = ue_w, saved_f = ue_f;
        const bool saved_rule = held_out_rule;
        if (end_index < last_useable) {
          ue_w = all[end_index].whole;
          ue_f = all[end_index].frac;
          held_out_rule = true;
        }
        struct Restore {
          double& w; double& f; bool& r; double w0, f0; bool r0;
          ~Restore() { w = w0; f = f0; r = r0; }
        } restore{ue_w, ue_f, held_out_rule, saved_w, saved_f, saved_rule};
        if (!start_given) {
          us_w = all[end_index].whole;
          us_f = all[end_index].frac - span_minutes / kMinutesPerDay;
        }
        uint32_t first = 0;
        while (first < n && fitoem::minutes_between(us_w, us_f, all[first].whole, all[first].frac) < (start_given ? 0.0 : -1e-6)) ++first;
        if (atm::active() != nullptr && first < n) {
          atm::active()->min_driver_mjd =
              static_cast<int32_t>(std::floor((all[first].whole - kJd1950) + all[first].frac + 33281.0)) - 1;
        }
        std::vector<double> t_fit, r_fit, t_out, r_out;
        // the epoch: the first state of the fit interval (diagnostic placements: the state nearest its middle, or its last;
        // short-span < 24 h fits anchor at last_useable when fitoem::epoch_placement() is at its default 0)
        const int placement = placement_override >= 0 ? placement_override
                              : (po.default_span_h < 24.0 && !eccentric && fitoem::epoch_placement() == 0 ? 2
                                                                                                           : fitoem::epoch_placement());
        uint32_t epoch_index = first < n ? first : 0;
        if (placement != 0 && first < n) {
          uint32_t last = first;
          for (uint32_t k = first; k < n; ++k)
            if (!held_out_rule || fitoem::minutes_between(ue_w, ue_f, all[k].whole, all[k].frac) <= 0.0) last = k;
          epoch_index = last;
          if (placement == 1) {
            const double half = 0.5 * fitoem::minutes_between(all[first].whole, all[first].frac, all[last].whole, all[last].frac);
            double best = 1e300;
            for (uint32_t k = first; k <= last; ++k) {
              const double d = std::fabs(fitoem::minutes_between(all[first].whole, all[first].frac, all[k].whole, all[k].frac) - half);
              if (d < best) { best = d; epoch_index = k; }
            }
          }
        }
        fitoem::Sample e0 = all[epoch_index];
        e0.frac = std::round(e0.frac * 1e8) / 1e8;  // the two-line text's epoch resolution
        for (uint32_t k = first; k < n; ++k) {
          const double t = fitoem::minutes_between(e0.whole, e0.frac, all[k].whole, all[k].frac);
          const bool in_fit = !held_out_rule || fitoem::minutes_between(ue_w, ue_f, all[k].whole, all[k].frac) <= 0.0;
          std::vector<double>& tt = in_fit ? t_fit : t_out;
          std::vector<double>& rr = in_fit ? r_fit : r_out;
          tt.push_back(t);
          rr.insert(rr.end(), all[k].r, all[k].r + 3);
        }
        if (t_fit.size() < 8) return 1;
        double fit_begin_min = t_fit.front(), fit_end_min = t_fit.back();
        if (placement != 0) {
          // the samples ordered by their distance from the epoch, so that the arc grows about it in both directions
          fit_begin_min = *std::min_element(t_fit.begin(), t_fit.end());
          fit_end_min = *std::max_element(t_fit.begin(), t_fit.end());
          std::vector<size_t> order(t_fit.size());
          for (size_t k = 0; k < order.size(); ++k) order[k] = k;
          std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return std::fabs(t_fit[a]) < std::fabs(t_fit[b]); });
          std::vector<double> t2(t_fit.size()), r2(r_fit.size());
          for (size_t k = 0; k < order.size(); ++k) {
            t2[k] = t_fit[order[k]];
            for (int j = 0; j < 3; ++j) r2[3 * k + j] = r_fit[3 * order[k] + j];
          }
          t_fit.swap(t2);
          r_fit.swap(r2);
        }
        auto reach = [&](double t) { return placement != 0 ? std::fabs(t) : t; };
        // starting set from the epoch state (velocity from the neighbors when absent)
        fitoem::Sample s0 = e0;
        if (!s0.has_v && epoch_index + 1 < n) {
          const fitoem::Sample& s1 = all[epoch_index + 1];
          const double dt = fitoem::minutes_between(s0.whole, s0.frac, s1.whole, s1.frac) * 60.0;
          for (int j = 0; j < 3; ++j) s0.v[j] = (s1.r[j] - s0.r[j]) / dt;
        }
        ElementRow row{};
        row.epoch_jd_whole = e0.whole;
        row.epoch_jd_frac = e0.frac;
        row.theory = kTheorySgp4Xp;
        fitoem::start_row(s0, row);
        pcf::Prior eff_drag = drag_override != nullptr ? *drag_override : po.drag_prior;
        // SPEC 12.1: an arc shorter than pcf::kShortArcHours with FIT.SRP_PRIOR unset takes the Space Force wrapper's
        // AGOM prior, 0 +- 0.1 m^2/kg
        const pcf::Prior eff_srp = srp_override != nullptr ? *srp_override
                                   : !po.srp_prior_given && fit_end_min - fit_begin_min < pcf::kShortArcHours * 60.0
                                       ? pcf::kSrpPriorShortArc
                                       : po.srp_prior;
        // SPEC 12.8: FIT.DRAG_PRIOR unset under NRLMSISE-00 or a < 24 h minimum span takes its median by mean altitude
        // (above e 0.3 the perigee's), and under NRLMSISE-00 at 800 to 1400 km the wide sigma of the log; a stated prior
        // is fitted as given
        bool wide_band = false;
        if (drag_override == nullptr && !po.drag_prior_given && (po.forces.msis || po.minimum_span_h < 24.0) &&
            row.mean_motion_rev_day > 0.0) {
          const double n_rad_min = row.mean_motion_rev_day * kTwoPi / kMinutesPerDay;
          const double a_km = std::pow(xpt::kKe / n_rad_min, kX2o3) * xpt::kRe;
          const double h_km = (row.eccentricity > xpt::tess::kWideE ? a_km * (1.0 - row.eccentricity) : a_km) - xpt::kRe;
          if (h_km >= 800.0) eff_drag.mean = 0.0005;
          else if (h_km >= 600.0) eff_drag.mean = 0.002;
          if (po.forces.msis && h_km >= 800.0 && h_km < 1400.0) {
            eff_drag.sigma = pcf::kDragPriorWideLogSigma;
            wide_band = true;
          }
        }
        if (drag_override == nullptr) used_drag = eff_drag;
        // a LOG_NORMAL term starts at its prior's median and stays > 0: the 2-revolution stage holds BTERM there, and
        // every stage before the last holds AGOM there
        if (eff_drag.form == pcfPriorForm_LOG_NORMAL) row.bterm = eff_drag.mean;
        else if (drag_override != nullptr) row.bterm = eff_drag.mean;
        if (eff_srp.form == pcfPriorForm_LOG_NORMAL) row.agom = eff_srp.mean;
        else if (srp_override != nullptr) row.agom = eff_srp.mean;
        // the arc grown from two revolutions to the whole fit interval
        struct FallbackScope {
          bool prev;
          explicit FallbackScope(bool on) : prev(fit::jacobian_fallback()) { fit::jacobian_fallback() = on; }
          ~FallbackScope() { fit::jacobian_fallback() = prev; }
        } fallback_scope{eccentric || placement != 0 || span_minutes < 1440.0 || fitoem::jacobian_always() != 0};
        fit::Options opt{};
        opt.max_iterations = 40;
        fit::Result res{};
        int iterations = 0;
        const double period = kMinutesPerDay / row.mean_motion_rev_day;
        size_t short_n = 0;
        while (short_n < t_fit.size() && reach(t_fit[short_n]) <= 2.0 * period) ++short_n;
        if (short_n >= 8 && short_n < t_fit.size()) {
          res = fit::run(row, t_fit.data(), r_fit.data(), static_cast<int>(short_n), opt);
          iterations += res.iterations;
        }
        opt.fit_drag = 1;
        // SGP4XP: the $PCF FIT.DRAG_PRIOR on BTERM (default LOG_NORMAL on ln BTERM, median 0.01 m^2/kg, sigma of the log ln 10)
        fitoem::set_prior(eff_drag, opt.drag_log, opt.drag_prior, opt.drag_sigma);
        // grown by threes in between (2, 6, 18 ... revolutions), each stage from the last: from a drag-free start the
        // whole arc of a fast decay lies far outside the linear range (an e 0.03 orbit at 175 km loses 15 km of a in
        // 48 h, some 2,000 km along-track), and the single jump stalled on a wrong minimum (fit RMS 7 to 9 km)
        for (double span = 6.0 * period;; span *= 3.0) {
          size_t k = 0;
          while (k < t_fit.size() && reach(t_fit[k]) <= span) ++k;
          if (k >= t_fit.size()) break;
          if (k < 8) continue;
          ElementRow trial = row;
          const fit::Result stage = fit::run(trial, t_fit.data(), r_fit.data(), static_cast<int>(k), opt);
          iterations += stage.iterations;
          if (stage.status >= 0) row = trial;
        }
        res = fit::run(row, t_fit.data(), r_fit.data(), static_cast<int>(t_fit.size()), opt);
        iterations += res.iterations;
        const double first_pass_rms = res.rms_km;
        opt.fit_agom = 1;
        // the $PCF FIT.SRP_PRIOR on AGOM (default 0 +- 0.05 m^2/kg, 0 +- 0.1 on a short arc; LOG_NORMAL on ln AGOM)
        fitoem::set_prior(eff_srp, opt.agom_log, opt.agom_prior, opt.agom_sigma);
        res = fit::run(row, t_fit.data(), r_fit.data(), static_cast<int>(t_fit.size()), opt);
        iterations += res.iterations;
        if (res.status < 0) return 2;
        P.t_fit = std::move(t_fit);
        P.r_fit = std::move(r_fit);
        P.t_out = std::move(t_out);
        P.r_out = std::move(r_out);
        P.first = first;
        P.e0 = e0;
        P.row = row;
        P.opt = opt;
        P.res = res;
        P.iterations = iterations;
        P.first_pass_rms = first_pass_rms;
        P.fit_begin_min = fit_begin_min;
        P.fit_end_min = fit_end_min;
        P.srp = eff_srp;
        P.wide_band = wide_band;
        return 0;
      };
      // the default span: 48 h; 24 h for eccentric orbits (e > 0.5: the lane's THEMIS and Chandra windows lost
      // 0.31 / 1.37 / 2.38 -> 0.51 / 1.72 / 2.98 km at 48 h), a longer span there only when it predicts the tail
      // at least 30 % better (10 % for the others)
      // ($PCF FIT: DEFAULT_SPAN_HOURS, ECCENTRICITY_THRESHOLD, ECCENTRIC_DEFAULT_SPAN_HOURS, CANDIDATE_SPANS_HOURS,
      // EXTENSION_MARGIN, ECCENTRIC_EXTENSION_MARGIN, ECCENTRIC_MAXIMUM_PERIOD_HOURS, TAIL_HOURS)
      const double default_span = (eccentric ? po.eccentric_default_span_h : po.default_span_h) * 60.0;
      Pass chosen;
      {
        const int rc = run_pass(default_span, chosen, last_useable);
        if (rc == 1) {
          plugin_set_error("too-few-states", "The fit interval holds fewer than 8 states.");
          return 3;
        }
        if (rc == 2) {
          plugin_set_error("fit-failed", "The fit did not converge on the block.");
          return 3;
        }
      }
      double span_used = start_given ? -1.0 : default_span;
      // SPEC 12.8: above e 0.3 with the perigee in the drag and no stated drag prior, the longest arc the ephemeris holds
      // up to 7 days, ending at the latest useable state
      const bool high_e_drag = fitoem::high_e_drag_block(blk);
      const bool long_arc = !start_given && high_e_drag && !po.drag_prior_given;
      if (long_arc) {
        const double span = std::fmin(fitoem::kHighEDragArcMinutes,
                                      fitoem::minutes_between(all[0].whole, all[0].frac, all[last_useable].whole, all[last_useable].frac));
        if (span > default_span + 1e-6) {
          const bool saved_before = atm::active() != nullptr && atm::active()->before_rows;
          Pass f;
          if (run_pass(span, f, last_useable) == 0 && !(atm::active() != nullptr && atm::active()->before_rows && !saved_before)) {
            chosen = std::move(f);
            span_used = span;
          } else if (atm::active() != nullptr) {
            atm::active()->before_rows = saved_before;
          }
        }
      } else if (!start_given) {
        // the extension validated on the data: each span (48, 72, 120 h) fitted to the data before the latest
        // tail_minutes() and scored on that tail; the span with the smallest tail error (a longer one only when it is
        // at least 10 % better than the best shorter one) is refitted on all the data
        const double data_minutes =
            fitoem::minutes_between(all[0].whole, all[0].frac, all[last_useable].whole, all[last_useable].frac);
        uint32_t tail_start = last_useable;
        while (tail_start > 0 && fitoem::minutes_between(all[tail_start].whole, all[tail_start].frac, all[last_useable].whole,
                                                         all[last_useable].frac) < fitoem::tail_minutes()) --tail_start;
        double best_err = 1e300, best_span = default_span;
        double spans[9];
        int nspans = 0;
        if (po.candidate_count > 0) {
          for (int k = 0; k < po.candidate_count; ++k) spans[nspans++] = po.candidate_spans_h[k] * 60.0;
        } else if (eccentric || po.default_span_h >= 24.0) {
          if (eccentric) spans[nspans++] = 24.0 * 60.0;
          for (const double h : {48.0, 72.0, 120.0}) spans[nspans++] = h * 60.0;
        }
        // an eccentric orbit of more than 36 h (Chandra's 64 h: a 24 h tail is under half a revolution, and the lane's
        // and this module's Chandra windows are best at 24 h) keeps its default span
        if (eccentric && fitoem::period_minutes(blk) > po.eccentric_maximum_period_h * 60.0)
          while (nspans > 0 && spans[nspans - 1] > default_span + 1e-6) --nspans;
        for (int si = 0; si < nspans; ++si) {
          const double span = spans[si];
          if (data_minutes < span + fitoem::tail_minutes() - 1e-6) break;
          const bool saved_before = atm::active() != nullptr && atm::active()->before_rows;
          Pass v;
          if (run_pass(span, v, tail_start) != 0 || v.t_out.empty() ||
              (atm::active() != nullptr && atm::active()->before_rows && !saved_before)) {
            if (atm::active() != nullptr) atm::active()->before_rows = saved_before;
            break;
          }
          std::vector<double> rr(v.r_out.size());
          if (!fit::residuals(v.row, v.t_out.data(), v.r_out.data(), static_cast<int>(v.t_out.size()), rr.data())) break;
          double ss = 0.0;
          for (double x : rr) ss += x * x;
          const double err = std::sqrt(ss / static_cast<double>(v.t_out.size()));
          if (err < (eccentric ? po.eccentric_extension_margin : po.extension_margin) * best_err || best_err >= 1e300) {
            best_err = err;
            best_span = span;
          }
        }
        if (best_span > default_span) {
          const bool saved_before = atm::active() != nullptr && atm::active()->before_rows;
          Pass f;
          if (run_pass(best_span, f, last_useable) == 0 &&
              !(atm::active() != nullptr && atm::active()->before_rows && !saved_before)) {
            chosen = std::move(f);
            span_used = best_span;
          } else if (atm::active() != nullptr) {
            atm::active()->before_rows = saved_before;
          }
        }
      }
      // a fit beyond the implausibility bound on that span (a decaying object's element-set pseudo-observations, an
      // arc across a burn): the latest half of the span, down to FIT.MINIMUM_SPAN_HOURS, before refusing
      if (!start_given) {
        for (double span = span_used / 2.0; !(chosen.res.rms_km <= po.implausible_rms_km) && span >= po.minimum_span_h * 60.0 - 1e-6; span /= 2.0) {
          Pass f;
          if (run_pass(span, f, last_useable) == 0) {
            chosen = std::move(f);
            span_used = span;
          }
        }
      }
      // SPEC 12.8: the drag prior's fall-back (fitoem::kFallback*), judged on the band default's fit; the drag path is
      // stated (in the record's OD COMMENT) only where the rule is judged
      const bool band_judged = chosen.wide_band;
      bool fell_back = false;
      if (chosen.wide_band && chosen.res.rms_km <= po.implausible_rms_km &&
          (chosen.fit_end_min - chosen.fit_begin_min) / 60.0 >= fitoem::kFallbackArcHours) {
        cov::Set first_cov;
        double first_ng = 0.0;
        const bool first_have = cov::of_fit(chosen.row, chosen.opt, chosen.t_fit.data(), chosen.r_fit.data(),
                                            static_cast<int>(chosen.t_fit.size()), chosen.fit_end_min, first_cov, first_ng);
        const double sl = first_have ? first_cov.log_sigma[0] : 0.0;
        const fitoem::ArcCheck first_arc =
            fitoem::arc_check(chosen.row, chosen.t_fit.data(), chosen.r_fit.data(), static_cast<int>(chosen.t_fit.size()));
        const double moved = sl > 0.0 && chosen.row.bterm > 0.0 ? std::fabs(std::log(chosen.row.bterm / fitoem::kBandMedianBterm)) / sl : 0.0;
        const bool wide = !(sl > 0.0) || sl > fitoem::kFallbackSigmaLog;
        const bool rough = moved > fitoem::kFallbackMovedSigmas && chosen.res.rms_km > fitoem::kFallbackRmsRatio * fitoem::kBandMedianRmsKm;
        if (wide || rough || first_arc.gap || first_arc.step) {
          const pcf::Prior band = {fitoem::kBandMedianBterm, pcf::kDragPriorDefault.sigma, pcfPriorForm_LOG_NORMAL};
          Pass f;
          if (run_pass(span_used > 0.0 ? span_used : default_span, f, last_useable, -1, &band) == 0 && f.res.rms_km <= po.implausible_rms_km) {
            fell_back = true;
            used_drag = band;
            chosen = std::move(f);
          }
        }
      }
      // Two-stage decoupled fit (R17): when FIT.MINIMUM_SPAN_HOURS < 24 h (e.g. 17.1 h, the 12 h order-2 tesseral
      // resonance null) and FIT.DEFAULT_SPAN_HOURS >= 24 h on a non-eccentric orbit, Stage 1 above solved BTERM and AGOM
      // over the long drag span; Stage 2 pins BTERM and AGOM to Stage 1's solution and fits the 6 Brouwer mean elements
      // over the trailing MINIMUM_SPAN_HOURS window with the epoch placed at the cutoff (last_useable).
      if (!start_given && !eccentric && po.minimum_span_h < 24.0 && po.default_span_h >= 24.0 &&
          chosen.res.rms_km <= po.implausible_rms_km) {
        const double bterm_s1 = chosen.row.bterm;
        const double agom_s1 = chosen.row.agom;
        const pcf::Prior pinned_drag = {bterm_s1, std::fmax(std::fabs(bterm_s1) * 1e-6, 1e-10), pcfPriorForm_GAUSSIAN_SIGNED};
        const pcf::Prior pinned_srp = {agom_s1, std::fmax(std::fabs(agom_s1) * 1e-6, 1e-10), pcfPriorForm_GAUSSIAN_SIGNED};
        Pass stage2;
        if (run_pass(po.minimum_span_h * 60.0, stage2, last_useable, 2, &pinned_drag, &pinned_srp) == 0 &&
            stage2.res.rms_km <= po.implausible_rms_km) {
          stage2.iterations += chosen.iterations;
          stage2.first_pass_rms = std::fmin(chosen.first_pass_rms, stage2.first_pass_rms);
          stage2.opt.drag_log = chosen.opt.drag_log;
          stage2.opt.drag_prior = chosen.opt.drag_prior;
          stage2.opt.drag_sigma = chosen.opt.drag_sigma;
          stage2.opt.agom_log = chosen.opt.agom_log;
          stage2.opt.agom_prior = chosen.opt.agom_prior;
          stage2.opt.agom_sigma = chosen.opt.agom_sigma;
          stage2.srp = chosen.srp;
          chosen = std::move(stage2);
        }
      }
      std::vector<double>& t_fit = chosen.t_fit;
      std::vector<double>& r_fit = chosen.r_fit;
      std::vector<double>& t_out = chosen.t_out;
      std::vector<double>& r_out = chosen.r_out;
      const uint32_t first = chosen.first;
      const fitoem::Sample& e0 = chosen.e0;
      ElementRow& row = chosen.row;
      fit::Options& opt = chosen.opt;
      fit::Result& res = chosen.res;
      const int iterations = chosen.iterations;
      const double fit_begin_min = chosen.fit_begin_min, fit_end_min = chosen.fit_end_min;
      // SGP4XP: the set the library reads, at the two-line text's digits searched on their lattice. An AP set (SPEC 16.1,
      // marked as 16.5 states) flies on AP only and keeps the solution's full precision (16.9).
      const bool lattice = po.forces.tesseral == 0 && po.forces.zonal == 0;
      if (lattice) {
        const fit::Result lat = fit::tle_lattice(row, t_fit.data(), r_fit.data(), static_cast<int>(t_fit.size()), opt);
        res.rms_km = lat.rms_km;
        res.max_km = lat.max_km;
      }
      // SPEC 12: the fit's covariance at its solution (at the two-line digits), its epoch image the $OMM's COVARIANCE
      cov::Set fit_cov;
      double ng_rate = 0.0;
      const bool have_cov = cov::of_fit(row, opt, t_fit.data(), r_fit.data(), static_cast<int>(t_fit.size()), fit_end_min, fit_cov, ng_rate);
      // SPEC 12.8: above e 0.3 with the perigee in the drag, on an arc shorter than 7 days, the residual is the theory's,
      // not noise, and the arc does not separate BTERM from it: the arc's width on BTERM is the offset whose signature over
      // the arc equals the RMS floor (the formal information over the residual components), combined with the prior's;
      // BTERM's row and column of the covariance take the ratio of the widths
      const double arc_hours = (fit_end_min - fit_begin_min) / 60.0;
      double floor_scale = 1.0;
      if (have_cov && high_e_drag && arc_hours < fitoem::kHighEDragArcMinutes / 60.0 - 1e-6) {
        int kind[fit::kMaxParams];
        const int np = cov::kinds_of(fit_cov.o, kind);
        for (int a = 6; a < np; ++a) {
          if (kind[a] != cov::kKindDrag) continue;
          const double var_b = fit_cov.C[a * np + a];
          if (!(var_b > 0.0) || !(row.mean_motion_rev_day > 0.0)) break;
          const bool lg = used_drag.form == pcfPriorForm_LOG_NORMAL;
          const double var_f = lg ? fit_cov.log_sigma[0] * fit_cov.log_sigma[0] : var_b;
          const double var_p = used_drag.sigma * used_drag.sigma;
          const double components = 3.0 * static_cast<double>(t_fit.size());
          const double info_arc = std::fmax(0.0, 1.0 / var_f - (var_p > 0.0 ? 1.0 / var_p : 0.0));
          if (!(info_arc * var_f > 1e-6)) break;  // a prior that pins BTERM (drag off, a pinned coefficient): as fitted
          const double var_h = 1.0 / (info_arc / components + (var_p > 0.0 ? 1.0 / var_p : 0.0));
          floor_scale = std::sqrt(var_h / var_f);
          for (int j = 0; j < np; ++j) {
            fit_cov.C[a * np + j] *= floor_scale;
            fit_cov.C[j * np + a] *= floor_scale;  // the diagonal takes the square
          }
          if (lg) fit_cov.log_sigma[0] *= floor_scale;
          break;
        }
      }
      // held-out score: RMS, largest error, and by day after the arc
      double held_rms = 0.0, held_max = 0.0, held_stop = fit_end_min;
      std::vector<double> day_ss;
      std::vector<uint32_t> day_n;
      if (!t_out.empty()) {
        std::vector<double> rr(r_out.size());
        if (fit::residuals(row, t_out.data(), r_out.data(), static_cast<int>(t_out.size()), rr.data())) {
          double ss = 0.0;
          for (size_t k = 0; k < t_out.size(); ++k) {
            const double e2 = rr[3 * k] * rr[3 * k] + rr[3 * k + 1] * rr[3 * k + 1] + rr[3 * k + 2] * rr[3 * k + 2];
            ss += e2;
            held_max = std::fmax(held_max, std::sqrt(e2));
            held_stop = std::fmax(held_stop, t_out[k]);
            const size_t day = static_cast<size_t>(std::max(1.0, std::ceil((t_out[k] - fit_end_min) / kMinutesPerDay)));
            if (day > day_ss.size()) { day_ss.resize(day, 0.0); day_n.resize(day, 0); }
            day_ss[day - 1] += e2;
            ++day_n[day - 1];
          }
          held_rms = std::sqrt(ss / static_cast<double>(t_out.size()));
        }
      }
      if (!(res.rms_km <= po.implausible_rms_km)) {
        // the theory does not hold across the arc (a burn, a transfer, a hand-off between centers): no set is
        // better than one that cannot propagate (the lane's Artemis II window: 38,030 km)
        char why[200];
        std::snprintf(why, sizeof why, "The fit's RMS is %.3f km, beyond the %.0f km bound of an Earth set (FIT.IMPLAUSIBLE_RMS_KM): the arc does not hold one set.", res.rms_km,
                      po.implausible_rms_km);
        plugin_set_error("fit-implausible", why);
        return 3;
      }
      // the weather the record carries (SPEC 15): one row per UTC day from the day before the arc's first through the
      // later of the arc's last and the epoch's plus FIT.WEATHER_HORIZON_DAYS; a missing day is refused by name
      ocm::Weather weather;
      const atm::Atmosphere* call_atm = atm::active();
      if (po.forces.weather_source == pcfWeatherSource_RECORDS && call_atm != nullptr) {
        auto mjd_at = [&](double minutes) { return static_cast<int32_t>(std::floor((e0.whole - 2400000.5) + e0.frac + minutes / kMinutesPerDay)); };
        const int32_t first_day = mjd_at(fit_begin_min) - 1;
        const int32_t last_day = std::max(mjd_at(fit_end_min), mjd_at(0.0) + static_cast<int32_t>(po.weather_horizon_days));
        size_t k = 0;
        const std::vector<atm::SpwDay>& days = call_atm->days;
        for (int32_t d = first_day; d <= last_day; ++d) {
          while (k < days.size() && days[k].mjd < d) ++k;
          if (k >= days.size() || days[k].mjd != d) {
            char day[16];
            atm::date_of_mjd(d, day, sizeof day);
            return atm::fail_day("weather-rows-short", day,
                                 "The 'space_weather' rows miss a day the record carries: the day before the fit arc through the later of its last day and the epoch's plus FIT.WEATHER_HORIZON_DAYS.");
          }
          weather.rows.push_back(days[k]);
        }
        weather.source_id = call_atm->source_id;
        if (po.forces.dca) {
          // the nodes from the last at or before the start of the first row's day through the last published
          const int64_t start_ms = static_cast<int64_t>(first_day - 40587) * 86400000LL;
          size_t i0 = 0;
          for (size_t i = 0; i < call_atm->dca_ms.size(); ++i)
            if (call_atm->dca_ms[i] <= start_ms) i0 = i;
          weather.node_ms.assign(call_atm->dca_ms.begin() + static_cast<std::ptrdiff_t>(i0), call_atm->dca_ms.end());
          weather.node_s.assign(call_atm->dca_s.begin() + static_cast<std::ptrdiff_t>(i0), call_atm->dca_s.end());
          weather.dcl_cid = call_atm->dcl_cid;
        }
      }
      // the fit's position errors in the model's radial, in-track and cross-track axes
      double uvw_ss[3] = {};
      {
        xpt::XpSat* xs = static_cast<xpt::XpSat*>(std::malloc(sizeof(xpt::XpSat)));
        if (xs != nullptr && xpt::xp_init(elements_of(row), *xs) == kPropOk) {
          for (size_t k = 0; k < t_fit.size(); ++k) {
            double rm[3], vm[3], u[3];
            if (xpt::xp_propagate(*xs, t_fit[k], rm, vm) != kPropOk) break;
            const double e[3] = {rm[0] - r_fit[3 * k], rm[1] - r_fit[3 * k + 1], rm[2] - r_fit[3 * k + 2]};
            cov::to_uvw(rm, vm, e, u);
            for (int j = 0; j < 3; ++j) uvw_ss[j] += u[j] * u[j];
          }
          xpt::xp_release(*xs);
        }
        std::free(xs);
      }
      // $OCM
      flatbuffers::FlatBufferBuilder fbb(4096);
      char epoch_text[48], start_text[48], stop_text[48], held_text[48];
      oem::iso_text(row.epoch_jd_whole, row.epoch_jd_frac, 0.0, epoch_text, sizeof epoch_text);
      oem::iso_text(e0.whole, e0.frac, fit_begin_min, start_text, sizeof start_text);
      oem::iso_text(e0.whole, e0.frac, fit_end_min, stop_text, sizeof stop_text);
      oem::iso_text(e0.whole, e0.frac, held_stop, held_text, sizeof held_text);
      const double fitted = static_cast<double>(t_fit.size());
      std::vector<flatbuffers::Offset<OCMHeldOutDay>> held_days;
      for (size_t d = 0; d < day_n.size(); ++d)
        if (day_n[d] > 0) held_days.push_back(CreateOCMHeldOutDay(fbb, static_cast<uint16_t>(d + 1), day_n[d], std::sqrt(day_ss[d] / day_n[d])));
      const auto s_held_days = held_days.empty() ? 0 : fbb.CreateVector(held_days);
      const auto s_pcf_cid = fbb.CreateString(fitoem::configuration_cid());
      const auto s_fit_start = fbb.CreateString(start_text);
      const auto s_fit_stop = fbb.CreateString(stop_text);
      const auto s_held_stop = t_out.empty() ? 0 : fbb.CreateString(held_text);
      OCMFitStatisticsBuilder fs(fbb);
      fs.add_FIT_STATES(static_cast<uint32_t>(t_fit.size()));
      fs.add_FIT_RMS_KM(res.rms_km);
      fs.add_FIT_MAX_KM(res.max_km);
      fs.add_FIT_RADIAL_RMS_KM(std::sqrt(uvw_ss[0] / fitted));
      fs.add_FIT_IN_TRACK_RMS_KM(std::sqrt(uvw_ss[1] / fitted));
      fs.add_FIT_CROSS_TRACK_RMS_KM(std::sqrt(uvw_ss[2] / fitted));
      fs.add_ITERATIONS(static_cast<uint32_t>(iterations));
      fs.add_CONVERGED(res.status == 0);
      if (!t_out.empty()) {
        fs.add_HELD_OUT_STOP(s_held_stop);
        fs.add_HELD_OUT_STATES(static_cast<uint32_t>(t_out.size()));
        fs.add_HELD_OUT_RMS_KM(held_rms);
        fs.add_HELD_OUT_MAX_KM(held_max);
        if (!s_held_days.IsNull()) fs.add_HELD_OUT_DAYS(s_held_days);
      }
      fs.add_PCF_CID(s_pcf_cid);
      fs.add_FIT_START(s_fit_start);
      fs.add_FIT_STOP(s_fit_stop);
      const auto statistics = fs.Finish();
      // the dynamical parameters: BTERM and AGOM, by their prwDynamicParameter
      std::vector<flatbuffers::Offset<OCMDynamicParameter>> dyn = {
          CreateOCMDynamicParameterDirect(fbb, "DRAG_AREA_OVER_MASS", row.bterm, "m**2/kg", opt.fit_drag != 0, prwDynamicParameter_DRAG_AREA_OVER_MASS),
          CreateOCMDynamicParameterDirect(fbb, "SRP_AREA_OVER_MASS", row.agom, "m**2/kg", opt.fit_agom != 0, prwDynamicParameter_SRP_AREA_OVER_MASS)};
      const auto s_dyn = fbb.CreateVector(dyn);
      std::vector<std::string> estimated = {"MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY"};
      if (opt.fit_drag) estimated.push_back("DRAG_AREA_OVER_MASS");
      if (opt.fit_agom) estimated.push_back("SRP_AREA_OVER_MASS");
      const auto s_estimated = fbb.CreateVectorOfStrings(estimated);
      std::vector<std::string> comment;
      comment.push_back(start_given ? "fit arc: the ephemeris block's useable interval"
                        : long_arc && span_used > default_span ? "fit arc: the longest arc the ephemeris holds, an eccentric orbit with its perigee in the drag"
                        : span_used > default_span ? "fit arc: extended, better on the latest tail"
                        : span_used < default_span ? "fit arc: shortened, the default span held no plausible set"
                        : eccentric ? "fit arc: the default span of an eccentric orbit" : "fit arc: the default span");
      if (band_judged) comment.push_back(fell_back ? "drag prior: fall-back to the band median's prior" : "drag prior: the band default, no fall-back");
      if (lattice) comment.push_back("elements at the two-line text's digits");
      // SPEC 18: the forecast the record carries ($PCF OUTPUT.START_TIME to STOP_TIME), its span and end jumps in COMMENT
      flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<PPEPositionRecord>>> forecast = 0;
      if (po.has_start && po.has_stop)
        if (const int rc = carried::build(fbb, row, ocm::epoch_frame(po.forces), all, gcrf, po.start_w, po.start_f, po.stop_w, po.stop_f, forecast, comment)) return rc;
      const auto s_comment = fbb.CreateVectorOfStrings(comment);
      const auto s_od_method = fbb.CreateString("BATCH LEAST SQUARES");
      const auto s_od_algorithm = fbb.CreateString("LEVENBERG-MARQUARDT ON TEME POSITION RESIDUALS, UNIT WEIGHTS");
      const auto s_od_weighting = fbb.CreateString(fitoem::kWeighting);
      const auto s_od_epoch = fbb.CreateString(epoch_text);
      OrbitDeterminationBuilder od(fbb);
      od.add_OD_ALGORITHM(s_od_algorithm);
      od.add_OD_METHOD(s_od_method);
      od.add_OD_EPOCH(s_od_epoch);
      od.add_OD_OBSERVATIONS_USED(static_cast<int32_t>(t_fit.size()));
      od.add_OD_EST_PARAMETERS(s_estimated);
      od.add_OD_ESTIMATOR(estimatorCategory_BatchLeastSquares);
      od.add_OD_DATA_WEIGHTING(s_od_weighting);
      od.add_OD_DYNAMIC_PARAMETERS(s_dyn);
      // SPEC 17.3: WEIGHTED_RMS, the post-fit RMS of the position components over the a priori sigma the fit weighted
      // them with; SEDR from the fitted non-gravitational n-dot (written with the covariance that states it)
      od.add_WEIGHTED_RMS(fitoem::weighted_rms(res.rms_km));
      if (have_cov) od.add_SEDR(fitoem::sedr(row, ng_rate));
      // CCSDS elapsed counts from the epoch back to the first and last observation, written when not negative
      if (-fit_begin_min >= 0.0) od.add_DAYS_SINCE_FIRST_OBS(-fit_begin_min / kMinutesPerDay);
      if (-fit_end_min >= 0.0) od.add_DAYS_SINCE_LAST_OBS(-fit_end_min / kMinutesPerDay);
      od.add_ACTUAL_OD_SPAN((fit_end_min - fit_begin_min) / kMinutesPerDay);
      od.add_COMMENT(s_comment);
      od.add_FIT_STATISTICS(statistics);
      ocm::Extras extras;
      extras.od = od.Finish();
      extras.forecast = forecast;
      if (source != nullptr) {
        extras.provenance = ocm::copy_pvn(fbb, source, true);
        extras.carried = true;
      }
      if (have_cov) {
        // SPEC 12: the epoch covariance, LTM of the state block (the floor included) and the parameter rows as fitted
        int kind[fit::kMaxParams];
        const int np = cov::kinds_of(fit_cov.o, kind);
        std::vector<double> ltm;
        for (int i = 0; i < np; ++i)
          for (int j = 0; j <= i; ++j) ltm.push_back(fit_cov.C[i * np + j]);
        std::vector<std::string> names, units = {"km", "km", "km", "km/s", "km/s", "km/s"};
        std::vector<uint8_t> kinds;
        for (int a = 6; a < np; ++a) {
          names.push_back(cov::consider_name(kind[a]));
          kinds.push_back(static_cast<uint8_t>(cov::consider_kind(kind[a])));
          units.push_back(cov::consider_units(kind[a]));
        }
        if (const char* code = ocm::covariance_refusal(np, names, kinds, units)) {
          plugin_set_error(code, "The fit's covariance rows are not the solved parameters in the fixed order (SPEC 17.3): never emitted.");
          return 3;
        }
        extras.covariance = fbb.CreateVector(ltm);
        extras.cov_frame = ocm::frame_of(fbb, ocm::epoch_frame(po.forces));
        extras.cov_size = static_cast<uint8_t>(np);
        if (!names.empty()) {
          extras.cov_parameters = fbb.CreateVectorOfStrings(names);
          extras.cov_kinds = fbb.CreateVector(kinds);
        }
        extras.cov_units = fbb.CreateVectorOfStrings(units);
        extras.cov_propagation = CreateOCMCovariancePropagation(fbb, fit_cov.floor[0], fit_cov.floor[1], fit_cov.floor[2], fit_cov.floor[3], fit_cov.floor[4],
                                                                fit_cov.floor[5], fit_cov.noise[0], fit_cov.noise[1], fit_cov.noise[2], fit_cov.noise[3],
                                                                fit_cov.noise[4], fit_cov.share, fit_cov.ng_rate);
        const auto s_model = fbb.CreateString(cov::noise_model_id());
        const auto s_regime = fbb.CreateString(cov::regime_name(fit_cov.regime));
        CVRBuilder cr(fbb);
        cr.add_RULE(covarianceRule_SourceModel);
        cr.add_MODEL_ID(s_model);
        cr.add_REGIME(s_regime);
        cr.add_CALIBRATION(covarianceCalibration_Uncalibrated);
        const std::vector<flatbuffers::Offset<CVR>> realism = {cr.Finish()};
        extras.cov_realism = fbb.CreateVector(realism);
      }
      const CAT* object = blk->OBJECT();
      ocm::Identity id;
      id.norad = object != nullptr ? object->NORAD_CAT_ID() : 0;
      if (object != nullptr && object->OBJECT_ID() != nullptr) id.object_id = object->OBJECT_ID()->str();
      if (object != nullptr && object->OBJECT_NAME() != nullptr) id.object_name = object->OBJECT_NAME()->str();
      id.originator = oem->ORIGINATOR() != nullptr ? oem->ORIGINATOR()->str() : "SDN";
      ocm::build(fbb, row, po.forces, &weather, id, extras);
      if (plugin_push_output("elements", "OCM.fbs", "$OCM", fbb.GetBufferPointer(), fbb.GetSize()) < 0) {
        plugin_set_error("output-failed", "The $OCM could not be emitted.");
        return 3;
      }
      // SPEC 17.4: the fit's residual record, one $ODR per fit on 'residuals': a row per state of the block, in order
      // (the input identifier <ephemeris frame>.<block>.<state>, from 1), its UTC epoch, POSITION_VECTOR, the observed
      // and computed geocentric distance (km; the fitted set at the state's time), the weight 1 / sigma^2 the fit gave
      // its components (0 outside the fit arc), ACCEPTED within the fit arc (REASON BEFORE FIT ARC, HELD OUT), the
      // normalized residual (observed minus computed over sigma) and the set's theory as the model code
      {
        const std::string ocm_cid = sdn_cid::cid_v1_raw_sha256(fbb.GetBufferPointer(), fbb.GetSize());
        const char* model_code = ocm::theory_of(row.theory, po.forces) == meanElementSource_SGP4XP ? "SGP4XP" : "AP";
        flatbuffers::FlatBufferBuilder rb(1024 + 160u * n);
        std::vector<flatbuffers::Offset<ODREditedObservation>> edited;
        edited.reserve(n);
        xpt::XpSat* xs = static_cast<xpt::XpSat*>(std::malloc(sizeof(xpt::XpSat)));
        bool ok = xs != nullptr && xpt::xp_init(elements_of(row), *xs) == kPropOk;
        for (uint32_t k = 0; ok && k < n; ++k) {
          const double t = fitoem::minutes_between(e0.whole, e0.frac, all[k].whole, all[k].frac);
          double rm[3], vm[3];
          if (xpt::xp_propagate(*xs, t, rm, vm) != kPropOk) { ok = false; break; }
          const double observed = std::sqrt(all[k].r[0] * all[k].r[0] + all[k].r[1] * all[k].r[1] + all[k].r[2] * all[k].r[2]);
          const double computed = std::sqrt(rm[0] * rm[0] + rm[1] * rm[1] + rm[2] * rm[2]);
          const bool accepted = t >= fit_begin_min && t <= fit_end_min;
          char id[48], epoch_k[48];
          std::snprintf(id, sizeof id, "%u.%u.%u", static_cast<unsigned>(ephemeris_index), static_cast<unsigned>(block_index), static_cast<unsigned>(k + 1));
          oem::iso_text(all[k].whole, all[k].frac, 0.0, epoch_k, sizeof epoch_k);
          const auto s_id = rb.CreateString(id);
          const auto s_reason = accepted ? flatbuffers::Offset<flatbuffers::String>(0) : rb.CreateString(t < fit_begin_min ? "BEFORE FIT ARC" : "HELD OUT");
          const auto s_epoch_k = rb.CreateString(epoch_k);
          const auto s_code = rb.CreateString(model_code);
          ODREditedObservationBuilder eb(rb);
          eb.add_OBSERVATION_ID(s_id);
          eb.add_NORMALIZED_RESIDUAL((observed - computed) / fitoem::kMeasurementSigmaKm);
          if (!s_reason.IsNull()) eb.add_REASON(s_reason);
          eb.add_EPOCH(s_epoch_k);
          eb.add_OBSERVATION_TYPE(memMeasurementType_POSITION_VECTOR);
          eb.add_OBSERVED_VALUE(observed);
          eb.add_COMPUTED_VALUE(computed);
          eb.add_WEIGHT(accepted ? 1.0 / (fitoem::kMeasurementSigmaKm * fitoem::kMeasurementSigmaKm) : 0.0);
          eb.add_ACCEPTED(accepted);
          eb.add_PERTURBATION_MODEL_CODE(s_code);
          edited.push_back(eb.Finish());
        }
        if (xs != nullptr) xpt::xp_release(*xs);
        std::free(xs);
        if (!ok) {
          plugin_set_error("fit-failed", "The fitted set does not reach a state of the block: no residual record.");
          return 3;
        }
        const auto s_edited = rb.CreateVector(edited);
        const auto s_run = rb.CreateString(ocm_cid);
        const auto s_content = rb.CreateString(ocm_cid);
        ODRBuilder ob(rb);
        ob.add_RUN_ID(s_run);
        ob.add_CONVERGENCE_REASON(res.status == 0 ? odrConvergenceReason_CONVERGED : odrConvergenceReason_MAXIMUM_ITERATIONS);
        ob.add_EDITED_OBSERVATIONS(s_edited);
        ob.add_OCM_CONTENT_ID(s_content);
        FinishODRBuffer(rb, ob.Finish());
        if (plugin_push_output("residuals", "ODR.fbs", "$ODR", rb.GetBufferPointer(), rb.GetSize()) < 0) {
          plugin_set_error("output-failed", "The $ODR could not be emitted.");
          return 3;
        }
      }
      ++blocks_done;
    }
  }
  if (blocks_done == 0) {
    plugin_set_error("missing-oem", "An 'ephemeris' $OEM with a data block is required.");
    return 3;
  }
  return 0;
}

/// The fit: $PCF THEORY UNSPECIFIED, SGP4XP or AP; the FORCES decide the theory written (stock: SGP4XP at the two-line
/// digits; otherwise AP).
extern "C" int fit(void) {
  plugin_reset_output_state();
  if (const int rc = sdnap::pcf::read(sdnap::pcf::kFit)) return rc;
  if (const int rc = sdnap::atm::prepare()) return rc;  // SPEC 15: the drag atmosphere the call selects
  sdnap::atm::Scope scope;
  return fit_blocks();
}

// Diagnostic (the fit-design study): where the fitted set's epoch sits in the fit interval, 0 its first state (the
// module's), 1 the state nearest its middle, 2 its last state; < 0 leaves it. Returns the previous.
SDNAP_EXPORT("sdnap_fit_epoch_diagnostic")
int32_t sdnap_fit_epoch_diagnostic(int32_t placement) {
  const int32_t previous = sdnap::fitoem::epoch_placement();
  if (placement >= 0 && placement <= 2) sdnap::fitoem::epoch_placement() = placement;
  return previous;
}

// Diagnostic (the fit-design study): 1 takes the element and drag Jacobian columns by finite differences of the
// theory where the analytic ones stop lowering the cost, in every fit (0, the default: eccentric orbits only); < 0
// leaves it. Returns the previous.
SDNAP_EXPORT("sdnap_fit_jacobian_diagnostic")
int32_t sdnap_fit_jacobian_diagnostic(int32_t always) {
  const int32_t previous = sdnap::fitoem::jacobian_always();
  if (always == 0 || always == 1) sdnap::fitoem::jacobian_always() = always;
  return previous;
}

// Diagnostic: the span rule's validation tail (minutes; <= 0 leaves it); returns the previous.
SDNAP_EXPORT("sdnap_span_tail_minutes")
double sdnap_span_tail_minutes(double minutes) {
  const double previous = sdnap::fitoem::tail_minutes();
  if (minutes > 0.0) sdnap::fitoem::tail_minutes() = minutes;
  return previous;
}
