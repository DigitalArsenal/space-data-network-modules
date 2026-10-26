// -----------------------------------------------------------------------------
// The invoke surface: `fit` takes $OEM ephemerides (one fit per data block:
// EPHEMERIS_DATA_LINES, TEME or Earth-fixed, UTC, km) and returns one $OMM
// SGP4XP set (BTERM and AGOM fitted, at the two-line text's digits) per
// block, its epoch the first state of the fit interval (USEABLE_START_TIME to
// USEABLE_STOP_TIME, the whole block when neither is stated); later states are
// held out and scored. Statistics go in COMMENT; USER_DEFINED_EARTH_MODEL,
// USER_DEFINED_EPOCH_TIMESTAMP and USER_DEFINED_MICROSECONDS carry the
// theory's Earth model and the epoch.
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

/// The $OBD model text of a fitted term: its prior's form and the values used; under LOG_NORMAL with the covariance, the
/// posterior sigma of the log, the covariance marked prior-limited when that passes 0.5 (the term effectively unobserved:
/// the delta method then stands in poorly for a wide log-normal).
inline void model_text(const char* term, const pcf::Prior& p, double log_sigma, char* out, size_t n) {
  if (p.form != pcfPriorForm_LOG_NORMAL) {
    std::snprintf(out, n, "%s, Gaussian prior %.9g +- %.9g m^2/kg", term, p.mean, p.sigma);
    return;
  }
  const int k = std::snprintf(out, n, "%s, log-normal prior, estimated as its natural log (never <= 0): median %.9g m^2/kg, sigma of the log %.9g",
                              term, p.mean, p.sigma);
  if (log_sigma > 0.0 && k > 0 && static_cast<size_t>(k) < n)
    std::snprintf(out + k, n - static_cast<size_t>(k), "; posterior sigma of the log %.17g%s", log_sigma,
                  log_sigma > 0.5 ? "; covariance prior-limited (posterior sigma of the log > 0.5)" : "");
}

inline bool text_epoch(const flatbuffers::String* s, double& whole, double& frac) {
  return s != nullptr && omm::epoch(s->c_str(), s->size(), whole, frac);
}

inline double minutes_between(double w0, double f0, double w1, double f1) {
  return ((w1 - w0) + (f1 - f0)) * kMinutesPerDay;
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

}  // namespace fitoem
}  // namespace sdnap

/// The fit of every 'ephemeris' block: SGP4XP (theory 4).
static int fit_blocks() {
  using namespace sdnap;
  plugin_reset_output_state();
  const pcf::Options& po = pcf::options();
  const uint32_t frames = plugin_get_input_count();
  uint32_t blocks_done = 0;
  for (uint32_t fi = 0; fi < frames; ++fi) {
    const plugin_input_frame_t* f = plugin_get_input_frame(fi);
    if (f == nullptr || f->port_id == nullptr || std::strcmp(f->port_id, "ephemeris") != 0) continue;
    const uint8_t* payload = f->payload;
    uint32_t payload_length = f->payload_length;
    if (!plain_view(payload, payload_length, "$OEM")) {
      plugin_set_error("invalid-oem", "An 'ephemeris' payload is not an SDS $OEM (plain or size-prefixed).");
      return 3;
    }
    flatbuffers::Verifier verifier(payload, payload_length);
    if (!VerifyOEMBuffer(verifier)) {
      plugin_set_error("invalid-oem", "An 'ephemeris' $OEM does not verify.");
      return 3;
    }
    const OEM* oem = GetOEM(payload);
    const auto* blocks = oem->EPHEMERIS_DATA_BLOCK();
    if (blocks == nullptr) continue;
    for (const ephemerisDataBlock* blk : *blocks) {
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
      };
      // span_minutes ending at all[end_index]; the states after it held out (the validation tail)
      auto run_pass = [&](double span_minutes, Pass& P, uint32_t end_index) -> int {
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
        std::vector<double> t_fit, r_fit, t_out, r_out;
        // the epoch: the first state of the fit interval (diagnostic placements: the state nearest its middle, or its last)
        const int placement = fitoem::epoch_placement();
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
        // a LOG_NORMAL term starts at its prior's median and stays > 0: the 2-revolution stage holds BTERM there, and
        // every stage before the last holds AGOM there
        if (po.drag_prior.form == pcfPriorForm_LOG_NORMAL) row.bterm = po.drag_prior.mean;
        if (po.srp_prior.form == pcfPriorForm_LOG_NORMAL) row.agom = po.srp_prior.mean;
        // the arc grown from two revolutions to the whole fit interval
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
        // SGP4XP: the $PCF FIT.DRAG_PRIOR on BTERM (default a weak prior about zero, 0 +- 0.05 m^2/kg; LOG_NORMAL on ln BTERM)
        fitoem::set_prior(po.drag_prior, opt.drag_log, opt.drag_prior, opt.drag_sigma);
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
        // the $PCF FIT.SRP_PRIOR on AGOM (default 0 +- 0.05 m^2/kg; LOG_NORMAL on ln AGOM)
        fitoem::set_prior(po.srp_prior, opt.agom_log, opt.agom_prior, opt.agom_sigma);
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
        return 0;
      };
      // the default span: 48 h; 24 h for eccentric orbits (e > 0.5: the lane's THEMIS and Chandra windows lost
      // 0.31 / 1.37 / 2.38 -> 0.51 / 1.72 / 2.98 km at 48 h), a longer span there only when it predicts the tail
      // at least 30 % better (10 % for the others)
      // ($PCF FIT: DEFAULT_SPAN_HOURS, ECCENTRICITY_THRESHOLD, ECCENTRIC_DEFAULT_SPAN_HOURS, CANDIDATE_SPANS_HOURS,
      // EXTENSION_MARGIN, ECCENTRIC_EXTENSION_MARGIN, ECCENTRIC_MAXIMUM_PERIOD_HOURS, TAIL_HOURS)
      const bool eccentric = fitoem::eccentric_block(blk, po.eccentricity_threshold);
      const double default_span = (eccentric ? po.eccentric_default_span_h : po.default_span_h) * 60.0;
      // an eccentric orbit's fits take the finite-difference columns where the analytic ones stall (fit::run)
      struct FallbackScope {
        bool prev;
        explicit FallbackScope(bool on) : prev(fit::jacobian_fallback()) { fit::jacobian_fallback() = on; }
        ~FallbackScope() { fit::jacobian_fallback() = prev; }
      } fallback_scope{eccentric || fitoem::jacobian_always() != 0};
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
      if (!start_given) {
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
        } else {
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
          Pass v;
          if (run_pass(span, v, tail_start) != 0 || v.t_out.empty()) break;
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
          Pass f;
          if (run_pass(best_span, f, last_useable) == 0) {
            chosen = std::move(f);
            span_used = best_span;
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
      const double first_pass_rms = chosen.first_pass_rms;
      const double fit_begin_min = chosen.fit_begin_min, fit_end_min = chosen.fit_end_min;
      // SGP4XP: the set the library reads, at the two-line text's digits searched on their lattice
      double best_pass_rms = std::fmin(first_pass_rms, res.rms_km);
      const fit::Result lat = fit::tle_lattice(row, t_fit.data(), r_fit.data(), static_cast<int>(t_fit.size()), opt);
      best_pass_rms = std::fmin(best_pass_rms, lat.rms_km);
      res.rms_km = lat.rms_km;
      res.max_km = lat.max_km;
      // SPEC 12: the fit's covariance at its solution (at the two-line digits), its epoch image the $OMM's COVARIANCE
      cov::Set fit_cov;
      double ng_rate = 0.0;
      const bool have_cov = cov::of_fit(row, opt, t_fit.data(), r_fit.data(), static_cast<int>(t_fit.size()), fit_end_min, fit_cov, ng_rate);
      // held-out score
      double held_rms = 0.0, held_lead_days = 0.0;
      for (double t : t_out) held_lead_days += (t - fit_end_min) / kMinutesPerDay;
      if (!t_out.empty()) held_lead_days /= static_cast<double>(t_out.size());
      if (!t_out.empty()) {
        std::vector<double> rr(r_out.size());
        if (fit::residuals(row, t_out.data(), r_out.data(), static_cast<int>(t_out.size()), rr.data())) {
          double ss = 0.0;
          for (size_t k = 0; k < t_out.size(); ++k) ss += rr[3 * k] * rr[3 * k] + rr[3 * k + 1] * rr[3 * k + 1] + rr[3 * k + 2] * rr[3 * k + 2];
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
      // $OMM
      flatbuffers::FlatBufferBuilder fbb(1024);
      char epoch_text[48];
      oem::iso_text(row.epoch_jd_whole, row.epoch_jd_frac, 0.0, epoch_text, sizeof epoch_text);
      char comment[400];
      std::snprintf(comment, sizeof comment,
                    "SDN-AP fit: theory SGP4XP, two-line digits; %u states fitted, %u held out; fit RMS %.6f km, max %.6f km; held-out RMS %.6f km; %d iterations; span %.3f h (%s)%s",
                    static_cast<unsigned>(t_fit.size()), static_cast<unsigned>(t_out.size()), res.rms_km, res.max_km, held_rms,
                    iterations, (fitoem::epoch_placement() == 0 ? fit_end_min : fit_end_min - fit_begin_min) / 60.0, start_given ? "USEABLE_START_TIME" : span_used > default_span ? "extended: better on the latest tail" : span_used < default_span ? "shortened: the default span held no plausible set" : eccentric ? "default for an eccentric orbit (FIT.ECCENTRIC_DEFAULT_SPAN_HOURS)" : "default (FIT.DEFAULT_SPAN_HOURS)",
                    "");
      const auto s_epoch = fbb.CreateString(epoch_text);
      const auto s_comment = fbb.CreateString(comment);
      const auto s_center = fbb.CreateString("EARTH");
      const auto s_model = fbb.CreateString("EGM-96");
      const auto s_orig = oem->ORIGINATOR() != nullptr ? fbb.CreateString(oem->ORIGINATOR()->c_str()) : fbb.CreateString("SDN");
      const auto s_frame = CreateRFMDirect(fbb, RFMUnion_NONE, 0, 0, "TEME");
      const CAT* object = blk->OBJECT();
      const uint32_t norad = object != nullptr ? object->NORAD_CAT_ID() : 0;
      const auto s_object_id = object != nullptr && object->OBJECT_ID() != nullptr ? fbb.CreateString(object->OBJECT_ID()->c_str()) : 0;
      const auto s_object_name = object != nullptr && object->OBJECT_NAME() != nullptr ? fbb.CreateString(object->OBJECT_NAME()->c_str()) : 0;
      const double unix_seconds = ((row.epoch_jd_whole - 2440587.5) + row.epoch_jd_frac) * 86400.0;
      const double whole_seconds = std::floor(unix_seconds);
      // the covariance rows (SPEC 12) as USER_DEFINED_x
      flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<OMMUserDefinedParameter>>> s_user = 0;
      if (have_cov) {
        std::vector<flatbuffers::Offset<OMMUserDefinedParameter>> ps;
        char v[64];
        auto put = [&](const char* name, double value) {
          std::snprintf(v, sizeof v, "%.17g", value);
          ps.push_back(CreateOMMUserDefinedParameterDirect(fbb, name, v));
        };
        if (have_cov) {
          auto put_list = [&](const char* name, const double* values, int count) {
            std::string text;
            char one[32];
            for (int k = 0; k < count; ++k) {
              std::snprintf(one, sizeof one, k == 0 ? "%.17g" : " %.17g", values[k]);
              text += one;
            }
            ps.push_back(CreateOMMUserDefinedParameterDirect(fbb, name, text.c_str()));
          };
          int kind[fit::kMaxParams];
          const int np = cov::kinds_of(fit_cov.o, kind);
          for (int a = 6; a < np; ++a) {
            double values[fit::kMaxParams];
            for (int j = 0; j <= a; ++j) values[j] = fit_cov.C[a * np + j];
            put_list(cov::consider_name(kind[a]), values, a + 1);
          }
          put_list("SDNAP_COV_FLOOR_UVW", fit_cov.floor, 6);
          put_list("SDNAP_COV_NOISE", fit_cov.noise, 5);
          put("SDNAP_COV_NG_RATE", ng_rate);
          ps.push_back(CreateOMMUserDefinedParameterDirect(fbb, "SDNAP_COV_REGIME", fit_cov.regime == 0 ? "DRAG" : "ABOVE"));
        }
        s_user = fbb.CreateVector(ps);
      }
      flatbuffers::Offset<flatbuffers::Vector<double>> s_cov = 0;
      flatbuffers::Offset<RFM> s_cov_frame = 0;
      if (have_cov) {
        double c21[21];
        int k21 = 0;
        for (int i = 0; i < 6; ++i)
          for (int j = 0; j <= i; ++j) c21[k21++] = fit_cov.C[i * fit_cov.np + j];
        s_cov = fbb.CreateVector(c21, 21);
        s_cov_frame = CreateRFMDirect(fbb, RFMUnion_NONE, 0, 0, "TEME");
      }
      OMMBuilder b(fbb);
      b.add_ORIGINATOR(s_orig);
      b.add_CENTER_NAME(s_center);
      b.add_REFERENCE_FRAME(s_frame);
      b.add_TIME_SYSTEM(timingStandard_UTC);
      b.add_MEAN_ELEMENT_THEORY(meanElementSource_SGP4XP);
      if (norad != 0) b.add_NORAD_CAT_ID(norad);
      if (!s_object_id.IsNull()) b.add_OBJECT_ID(s_object_id);
      if (!s_object_name.IsNull()) b.add_OBJECT_NAME(s_object_name);
      b.add_COMMENT(s_comment);
      b.add_EPOCH(s_epoch);
      b.add_MEAN_MOTION(row.mean_motion_rev_day);
      b.add_ECCENTRICITY(row.eccentricity);
      b.add_INCLINATION(row.inclination_deg);
      b.add_RA_OF_ASC_NODE(row.raan_deg);
      b.add_ARG_OF_PERICENTER(row.arg_pericenter_deg);
      b.add_MEAN_ANOMALY(row.mean_anomaly_deg);
      b.add_BSTAR(row.bterm);
      b.add_MEAN_MOTION_DDOT(row.agom);
      b.add_USER_DEFINED_EARTH_MODEL(s_model);
      b.add_USER_DEFINED_EPOCH_TIMESTAMP(whole_seconds);
      b.add_USER_DEFINED_MICROSECONDS(std::round((unix_seconds - whole_seconds) * 1e6));
      if (!s_user.IsNull()) b.add_USER_DEFINED_PARAMETERS(s_user);
      if (have_cov) {
        b.add_COV_REFERENCE_FRAME(s_cov_frame);
        b.add_COVARIANCE(s_cov);
      }
      FinishOMMBuffer(fbb, b.Finish());
      if (plugin_push_output("elements", "OMM.fbs", "$OMM", fbb.GetBufferPointer(), fbb.GetSize()) < 0) {
        plugin_set_error("output-failed", "The $OMM could not be emitted.");
        return 3;
      }
      // $OBD: the determination behind the set
      {
        flatbuffers::FlatBufferBuilder ob(512);
        char start_text[48], end_text[48];
        const fitoem::Sample& fs = all[first < n ? first : 0];  // the fit interval's first state
        oem::iso_text(fs.whole, fs.frac, 0.0, start_text, sizeof start_text);
        oem::iso_text(e0.whole, e0.frac, fit_end_min, end_text, sizeof end_text);
        const auto o_start = ob.CreateString(start_text);
        const auto o_end = ob.CreateString(end_text);
        const auto o_from = ob.CreateString(epoch_text);
        const auto o_source = ob.CreateString("sdn-ap-propagator fit: Levenberg-Marquardt on TEME position residuals, unit weights, km; theory SGP4XP at the two-line text's digits");
        char bmodel[400], amodel[400];
        fitoem::model_text("BTERM (SGP4XP)", po.drag_prior, have_cov ? fit_cov.log_sigma[0] : 0.0, bmodel, sizeof bmodel);
        fitoem::model_text("AGOM (SGP4XP)", po.srp_prior, have_cov ? fit_cov.log_sigma[1] : 0.0, amodel, sizeof amodel);
        const auto o_bmodel = ob.CreateString(bmodel);
        const auto o_amodel = ob.CreateString(amodel);
        const auto o_object = object != nullptr && object->OBJECT_ID() != nullptr ? ob.CreateString(object->OBJECT_ID()->c_str()) : 0;
        const auto o_types = ob.CreateVectorOfStrings(std::vector<std::string>{"POSITION"});
        OBDBuilder d(ob);
        if (norad != 0) d.add_SAT_NO(norad);
        if (!o_object.IsNull()) d.add_ORIG_OBJECT_ID(o_object);
        d.add_START_TIME(o_start);
        d.add_END_TIME(o_end);
        d.add_METHOD(odMethod_BATCH_LEAST_SQUARES);
        d.add_METHOD_SOURCE(o_source);
        d.add_TIME_SPAN(fitoem::minutes_between(all[0].whole, all[0].frac, all[n - 1].whole, all[n - 1].frac) / kMinutesPerDay);
        d.add_FIT_SPAN((fit_end_min - fit_begin_min) / kMinutesPerDay);
        d.add_EFFECTIVE_FROM(o_from);
        d.add_WRMS(res.rms_km);
        d.add_FIRST_PASS_WRMS(first_pass_rms);
        d.add_BEST_PASS_WRMS(best_pass_rms);
        if (!t_out.empty() && held_lead_days > 0.0) d.add_ERROR_GROWTH_RATE(std::fmax(0.0, held_rms - res.rms_km) / held_lead_days);
        d.add_BALLISTIC_COEFF_EST(true);
        d.add_BALLISTIC_COEFF_MODEL(o_bmodel);
        d.add_AGOM_EST(true);
        d.add_AGOM_MODEL(o_amodel);
        d.add_RMS_CONVERGENCE_CRITERIA(1e-10);
        d.add_NUM_ITERATIONS(static_cast<uint16_t>(iterations > 65535 ? 65535 : iterations));
        d.add_NUM_ACCEPTED_OBS(static_cast<uint32_t>(t_fit.size()));
        d.add_NUM_REJECTED_OBS(0);
        d.add_ACCEPTED_OB_TYPS(o_types);
        FinishOBDBuffer(ob, d.Finish());
        if (plugin_push_output("determination", "OBD.fbs", "$OBD", ob.GetBufferPointer(), ob.GetSize()) < 0) {
          plugin_set_error("output-failed", "The $OBD could not be emitted.");
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

/// The fit: $PCF THEORY UNSPECIFIED or SGP4XP fits SGP4XP sets (the two-line digits).
extern "C" int fit(void) {
  plugin_reset_output_state();
  if (const int rc = sdnap::pcf::read(sdnap::pcf::kFit)) return rc;
  if (const int rc = sdnap::atm::prepare()) return rc;  // SPEC 15: the drag atmosphere the call selects
  sdnap::atm::Scope scope;
  if (const int rc = fit_blocks()) return rc;
  return sdnap::atm::coverage();
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
