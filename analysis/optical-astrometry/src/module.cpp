// analysis/optical-astrometry: the module's method.
//
// reduce   frames ($FIL: FITS or PGM, in time order), element sets ($OMM),
//          Earth orientation ($EOP) and the GP error model ($ERM) ->
//          propagation_requests ($PRW WINDOW_REQUEST) on the first pass;
//          with the answers ($OEM on propagation): catalog_requests ($SKQ
//          CONE) until the reference stars on catalog ($SKT tiles or $STR
//          rows, or $SKT tiles on sky_tiles) cover the field's path; then the products: observations
//          ($TDM), optical_observations ($EOO), plates ($SKI), orbit ($OCM),
//          orbit_trajectory ($OEM), and on every pass a report (FNTC).
//
// The method is stateless: every pass recomputes from its inputs and either
// asks for what is missing or finishes, so every runtime gives the same bytes
// for the same inputs. The host answers the requests and calls again with
// the answers added (the pluggable-propagation contract of
// analysis/maneuver-detection and analysis/rpo-history; catalog cones from
// any star service, e.g. Gaia DR3).
//
// Options are the node configuration's `optical` table (keys optical.*):
//   calibrator             catalog number of the object whose orbit is known (required): the site and timing come from it
//   targets                catalog numbers to identify and fit (number or list)
//   site_latitude_deg, site_longitude_deg, site_height_m   a known site (WGS-84); without it the site is estimated
//   site_sigma_m           a known site's 1-sigma (30)
//   search_latitude_deg, search_longitude_deg   [min, max] box for an estimated site ([-90, 90], [-180, 180])
//   search_step_deg        site search grid (1)
//   catalog_mag_limit      depth of the cones asked for (13.5), catalog_band (G)
//   time_reference         tag (overlay times, bias solved), or start / mid / end for FITS DATE-OBS
//   overlay_format         the burnt-in time's layout (YYYY-MM-DD hh:mm:ss.fff)
//   calibrator_sigma_rtn_km  the calibrator's ephemeris 1-sigma R, T, N ([0.2, 1.0, 0.2])
//   prior_sigma_rtn        a target prior's 1-sigma R, T, N km and R, T, N km/s without an error model ([1, 6, 1, 0.006, 0.001, 0.001])
//   prior_created_before   a target's prior is its newest set with EPOCH at or before the first frame created before this (ISO 8601)
//   trajectory_minutes     the orbit trajectory's half span (45), trajectory_step_seconds (10)
//   sensor_id, originator, image_set_id, creation_date, propagator_port_id
//   min_elevation_deg (3), max_site_candidates (24)
namespace oa {
namespace mod {

std::string g_error;
int fail(const std::string& message) {
  g_error = message;
  plugin_set_error("invalid-optical-reduction", g_error.c_str());
  return 1;
}

const char* port_of(const plugin_input_frame_t* f) { return f && f->port_id ? f->port_id : ""; }

struct Options {
  uint32_t calibrator = 0;
  std::vector<uint32_t> targets;
  bool site_known = false;
  double lat = kNaN, lon = kNaN, h = kNaN, site_sigma = 30;
  double lat0 = -90, lat1 = 90, lon0 = -180, lon1 = 180, step = 1.0;
  double mag_limit = 13.5;
  std::string band = "G", time_reference = "tag", overlay_format;
  double cal_sigma[3] = {0.2, 1.0, 0.2};
  double prior_sigma[6] = {1.0, 6.0, 1.0, 6e-3, 1e-3, 1e-3};
  double prior_created_before = kNaN;
  double trajectory_minutes = 45, trajectory_step = 10;
  std::string sensor_id = "OPTICAL", originator = "SDN", image_set, creation, propagator_port;
  double min_elevation = 3;
  int max_candidates = 24;
};

bool number_list(const sdm_piv::ConfigTable& t, const char* key, size_t n, double* out, std::string* err) {
  if (!t.has(key)) return true;
  const auto v = t.numbers(key);
  if (v.size() != n) { *err = std::string("optical.") + key + " must be a list of " + std::to_string(n) + " numbers"; return false; }
  for (size_t i = 0; i < n; ++i) out[i] = v.data()[i];
  return true;
}

bool read_options(Options* o, std::string* err) {
  const sdm_piv::Config config = sdm_piv::get_config();
  if (!config.ok()) { *err = "plugin.getConfig failed: " + config.error_message(); return false; }
  if (!config.has("optical")) { *err = "option table optical is required (optical.calibrator)"; return false; }
  const sdm_piv::ConfigTable t = config.table("optical");
  if (!t) { *err = "option optical must be one table (keys optical.*)"; return false; }
  static const char* known[] = {"calibrator", "targets", "site_latitude_deg", "site_longitude_deg", "site_height_m", "site_sigma_m",
                                "search_latitude_deg", "search_longitude_deg", "search_step_deg", "catalog_mag_limit", "catalog_band",
                                "time_reference", "overlay_format", "calibrator_sigma_rtn_km", "prior_sigma_rtn", "prior_created_before",
                                "trajectory_minutes", "trajectory_step_seconds", "sensor_id", "originator", "image_set_id", "creation_date",
                                "propagator_port_id", "min_elevation_deg", "max_site_candidates"};
  for (const auto* e : *t.entries()) {
    const std::string key = rec::text(e->KEY());
    bool ok = false;
    for (const char* k : known) ok = ok || key == k;
    if (!ok) { *err = "unknown option optical." + key; return false; }
  }
  o->calibrator = static_cast<uint32_t>(t.number("calibrator", 0));
  if (!o->calibrator) { *err = "optical.calibrator (a catalog number) is required"; return false; }
  if (t.kind("targets") == sdn::runtime::configValueKind_Number) o->targets.push_back(static_cast<uint32_t>(t.number("targets")));
  else for (double v : t.numbers("targets")) o->targets.push_back(static_cast<uint32_t>(v));
  for (uint32_t id : o->targets) if (!id || id == o->calibrator) { *err = "optical.targets must be catalog numbers other than the calibrator"; return false; }
  const int site_keys = t.has("site_latitude_deg") + t.has("site_longitude_deg") + t.has("site_height_m");
  if (site_keys == 3) {
    o->site_known = true;
    o->lat = t.number("site_latitude_deg");
    o->lon = t.number("site_longitude_deg");
    o->h = t.number("site_height_m");
    if (!(std::fabs(o->lat) <= 90 && std::fabs(o->lon) <= 360 && o->h > -500 && o->h < 10000)) { *err = "optical.site_* is out of range"; return false; }
  } else if (site_keys != 0) {
    *err = "a known site needs optical.site_latitude_deg, site_longitude_deg and site_height_m";
    return false;
  }
  o->site_sigma = t.number("site_sigma_m", o->site_sigma);
  double box[2];
  box[0] = o->lat0; box[1] = o->lat1;
  if (!number_list(t, "search_latitude_deg", 2, box, err)) return false;
  o->lat0 = box[0]; o->lat1 = box[1];
  box[0] = o->lon0; box[1] = o->lon1;
  if (!number_list(t, "search_longitude_deg", 2, box, err)) return false;
  o->lon0 = box[0]; o->lon1 = box[1];
  if (!(o->lat0 < o->lat1 && o->lon0 < o->lon1 && o->lat0 >= -90 && o->lat1 <= 90)) { *err = "optical.search_* must be [min, max]"; return false; }
  o->step = t.number("search_step_deg", o->step);
  if (!(o->step >= 0.05 && o->step <= 10)) { *err = "optical.search_step_deg must be from 0.05 to 10"; return false; }
  o->mag_limit = t.number("catalog_mag_limit", o->mag_limit);
  if (!(o->mag_limit > 3 && o->mag_limit < 22)) { *err = "optical.catalog_mag_limit must be from 3 to 22"; return false; }
  if (t.has("catalog_band")) o->band = std::string(t.string("catalog_band"));
  if (t.has("time_reference")) o->time_reference = std::string(t.string("time_reference"));
  if (!(o->time_reference == "tag" || o->time_reference == "start" || o->time_reference == "mid" || o->time_reference == "end")) {
    *err = "optical.time_reference must be tag, start, mid or end";
    return false;
  }
  if (t.has("overlay_format")) o->overlay_format = std::string(t.string("overlay_format"));
  if (!number_list(t, "calibrator_sigma_rtn_km", 3, o->cal_sigma, err) || !number_list(t, "prior_sigma_rtn", 6, o->prior_sigma, err)) return false;
  for (double v : o->cal_sigma) if (!(v > 0)) { *err = "optical.calibrator_sigma_rtn_km must be positive"; return false; }
  for (double v : o->prior_sigma) if (!(v > 0)) { *err = "optical.prior_sigma_rtn must be positive"; return false; }
  if (t.has("prior_created_before") && !parse_iso_utc_seconds(std::string(t.string("prior_created_before")), &o->prior_created_before)) {
    *err = "optical.prior_created_before must be ISO 8601 UTC";
    return false;
  }
  o->trajectory_minutes = t.number("trajectory_minutes", o->trajectory_minutes);
  if (!(o->trajectory_minutes >= 1 && o->trajectory_minutes <= 180)) { *err = "optical.trajectory_minutes must be from 1 to 180"; return false; }
  o->trajectory_step = t.number("trajectory_step_seconds", o->trajectory_step);
  if (!(o->trajectory_step >= 1 && o->trajectory_step <= 60)) { *err = "optical.trajectory_step_seconds must be from 1 to 60"; return false; }
  if (t.has("sensor_id")) o->sensor_id = std::string(t.string("sensor_id"));
  if (t.has("originator")) o->originator = std::string(t.string("originator"));
  if (t.has("image_set_id")) o->image_set = std::string(t.string("image_set_id"));
  if (t.has("creation_date")) {
    double c;
    if (!parse_iso_utc_seconds(std::string(t.string("creation_date")), &c)) { *err = "optical.creation_date must be ISO 8601 UTC"; return false; }
    o->creation = iso_utc(c, 3);
  }
  if (t.has("propagator_port_id")) o->propagator_port = std::string(t.string("propagator_port_id"));
  o->min_elevation = t.number("min_elevation_deg", o->min_elevation);
  o->max_candidates = static_cast<int>(t.number("max_site_candidates", o->max_candidates));
  if (!(o->max_candidates >= 1 && o->max_candidates <= 200)) { *err = "optical.max_site_candidates must be from 1 to 200"; return false; }
  return true;
}

bool push(const char* port, const char* schema, const char* ident, const char* root, const std::vector<uint8_t>& bytes) {
  if (bytes.empty()) return true;
  return plugin_push_output_ex(port, schema, ident, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, bytes.data(), bytes.size()) >= 0;
}

bool notice(const std::string& reason, uint64_t count, std::vector<std::string> items) {
  sdn::runtime::FlowNoticeT n;
  n.KIND = sdn::runtime::flowNoticeKind_Info;
  n.SCHEMA = "$TDM";
  n.SOURCE_NAME = "optical-astrometry reduce";
  n.COUNT = count;
  n.REASON = reason;
  n.ITEMS = std::move(items);
  flatbuffers::FlatBufferBuilder b(4096);
  sdn::runtime::FinishFlowNoticeBuffer(b, sdn::runtime::FlowNotice::Pack(b, &n));
  return plugin_push_output_ex("report", "FlowNotice.fbs", sdn::runtime::FlowNoticeIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                               "FlowNotice", 0, 0, b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) >= 0;
}

std::string f3(double v) { return rec::fmt(v, "%.3f"); }
std::string rtn_text(const double v[3], const char* f = "%.3f") { return rec::fmt(v[0], f) + "," + rec::fmt(v[1], f) + "," + rec::fmt(v[2], f); }

// Frame numbers as ranges: "113-182,184-187".
std::string ranges(const std::vector<int>& v) {
  std::string s;
  for (size_t i = 0; i < v.size();) {
    size_t j = i;
    while (j + 1 < v.size() && v[j + 1] == v[j] + 1) ++j;
    if (!s.empty()) s += ",";
    s += std::to_string(v[i]) + (j > i ? "-" + std::to_string(v[j]) : "");
    i = j + 1;
  }
  return s.empty() ? "none" : s;
}

// The quadratic form d^T S^-1 d of a 3-vector with a 3x3 covariance.
double mahalanobis2(const double d[3], const std::vector<double>& s3) {
  std::vector<double> x(d, d + 3);
  if (!cholesky_solve(s3, 3, &x, nullptr)) return kNaN;
  return d[0] * x[0] + d[1] * x[1] + d[2] * x[2];
}

std::vector<double> position_block(const std::vector<double>& c6) {
  std::vector<double> p(9);
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) p[i * 3 + j] = c6[i * 6 + j];
  return p;
}

// RTN components of a position difference in a state's axes.
void in_rtn(const double x[6], V3 d, double out[3]) {
  V3 ax3[3];
  rtn_axes(x, ax3);
  for (int i = 0; i < 3; ++i) out[i] = dot(d, ax3[i]);
}

// The fitted orbit at times t: the prior's trajectory plus the fit's
// deviation at t0 through the transition matrix (the fit's own model).
bool fitted_states(const Trajectory& ref, const OdResult& od, const std::vector<double>& times, std::vector<std::array<double, 6>>* out) {
  V3 r0, v0;
  if (!ref.at(od.t0, &r0, &v0)) return false;
  const double dx[6] = {od.x[0] - r0.x, od.x[1] - r0.y, od.x[2] - r0.z, od.x[3] - v0.x, od.x[4] - v0.y, od.x[5] - v0.z};
  std::vector<std::array<double, 36>> phi;
  if (!transition_matrices(ref, od.t0, times, &phi)) return false;
  out->clear();
  for (size_t k = 0; k < times.size(); ++k) {
    V3 r, v;
    if (!ref.at(times[k], &r, &v)) return false;
    std::array<double, 6> s{r.x, r.y, r.z, v.x, v.y, v.z};
    for (int i = 0; i < 6; ++i)
      for (int j = 0; j < 6; ++j) s[i] += phi[k][i * 6 + j] * dx[j];
    out->push_back(s);
  }
  return true;
}

int reduce_method() {
  Options o;
  std::string err;
  if (!read_options(&o, &err)) return fail(err);

  // ── inputs ──
  std::vector<const FIL*> files;
  std::vector<const OMM*> omms;
  std::vector<const OEM*> answers;
  std::vector<const ERM*> models;
  Clock clock;
  Catalog cat;
  bool saw_propagation = false;
  int catalog_frames = 0;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    const std::string port = port_of(f);
    if (port.empty()) return fail("an input frame has no port");
    if (!f->payload || f->payload_length == 0) continue;
    bool ok = true;
    if (port == "frames")
      ok = rec::records<FIL>(f->payload, f->payload_length, FILIdentifier(), VerifyFILBuffer, VerifySizePrefixedFILBuffer, GetFIL, GetSizePrefixedFIL,
                             &files, "frames", &err);
    else if (port == "element_sets")
      ok = rec::records<OMM>(f->payload, f->payload_length, OMMIdentifier(), VerifyOMMBuffer, VerifySizePrefixedOMMBuffer, GetOMM, GetSizePrefixedOMM,
                             &omms, "element_sets", &err);
    else if (port == "propagation") {
      saw_propagation = true;
      ok = rec::records<OEM>(f->payload, f->payload_length, OEMIdentifier(), VerifyOEMBuffer, VerifySizePrefixedOEMBuffer, GetOEM, GetSizePrefixedOEM,
                             &answers, "propagation", &err);
    } else if (port == "error_model")
      ok = rec::records<ERM>(f->payload, f->payload_length, ERMIdentifier(), VerifyERMBuffer, VerifySizePrefixedERMBuffer, GetERM, GetSizePrefixedERM,
                             &models, "error_model", &err);
    else if (port == "earth_orientation") {
      const std::string m = ax::eop::addPayload(f->payload, f->payload_length, clock.rows);
      if (!m.empty()) return fail("earth_orientation: " + m);
    } else if (port == "catalog") {
      ++catalog_frames;
      if (!(f->payload_length >= 8 && flatbuffers::BufferHasIdentifier(f->payload, STRIdentifier(), true)))
        return fail("catalog frames must be size-prefixed $STR rows");
      ok = read_star_rows(f->payload, f->payload_length, &cat, &err);
    } else if (port == "sky_tiles") {
      ++catalog_frames;
      if (!(f->payload_length >= 8 && flatbuffers::BufferHasIdentifier(f->payload, SKTIdentifier(), true)))
        return fail("sky_tiles frames must be size-prefixed $SKT tiles");
      ok = read_sky_tiles(f->payload, f->payload_length, &cat, &err);
    } else
      return fail("unknown input port " + port);
    if (!ok) return fail(port + ": " + err);
  }
  clock.have_eop = !clock.rows.empty();
  if (files.size() < 2) return fail("at least two frames ($FIL) on frames are required");
  if (omms.empty()) return fail("element sets ($OMM) on element_sets are required");
  if (models.size() > 1) return fail("at most one $ERM model on error_model");
  rec::ErrorModel model;
  if (!models.empty() && !rec::load_error_model(models[0], &model, &err)) return fail("error_model: " + err);
  // One star per catalog place (overlapping cones repeat stars).
  std::sort(cat.stars.begin(), cat.stars.end(), [](const Star& a, const Star& b) { return a.ra < b.ra || (a.ra == b.ra && a.dec < b.dec); });
  cat.stars.erase(std::unique(cat.stars.begin(), cat.stars.end(), [](const Star& a, const Star& b) { return a.ra == b.ra && a.dec == b.dec; }),
                  cat.stars.end());

  std::vector<FrameInput> frames;
  std::vector<std::string> names;
  for (const FIL* f : files) {
    if (!f->CONTENT() || f->CONTENT()->size() == 0) return fail("a frame ($FIL) has no CONTENT");
    frames.push_back({f->CONTENT()->data(), f->CONTENT()->size(), rec::text(f->NAME())});
    names.push_back(rec::text(f->NAME()));
  }

  // ── frames: times, sources, drift ──
  ReduceOptions ro;
  if (!o.overlay_format.empty()) ro.overlay.format = o.overlay_format;
  ro.calibrator = o.calibrator;
  ro.targets = o.targets;
  ro.site_known = o.site_known;
  if (o.site_known) { ro.site.lat = o.lat * kDeg; ro.site.lon = o.lon * kDeg; ro.site.h = o.h; }
  ro.site_sigma_m = o.site_sigma;
  for (int i = 0; i < 3; ++i) ro.prior.sigma_rtn[i] = o.cal_sigma[i];
  ro.catalog_mag_limit = o.mag_limit;
  ro.search_lat0 = o.lat0; ro.search_lat1 = o.lat1; ro.search_lon0 = o.lon0; ro.search_lon1 = o.lon1; ro.search_step = o.step;
  ro.max_candidates = o.max_candidates;
  ro.time_reference = o.time_reference;
  ro.min_elevation_deg = o.min_elevation;
  Reduction red(ro, clock);
  ReduceResult r;
  if (!red.measure_frames(frames, &r)) return fail("frames: " + r.error);
  double t_first = kNaN, t_last = kNaN, t_sum = 0;
  int timed = 0;
  for (const FrameState& f : r.frames)
    if (f.time_ok) {
      t_first = std::isfinite(t_first) ? std::min(t_first, f.t) : f.t;
      t_last = std::isfinite(t_last) ? std::max(t_last, f.t) : f.t;
      t_sum += f.t;
      ++timed;
    }
  if (timed < 2) return fail("fewer than two frames are timed");
  const double t_mid = t_sum / timed;

  // ── element sets: the calibrator's nearest the arc, each target's prior
  //    (newest at or before the first frame) and its other sets after it ──
  std::vector<rec::ElementSet> sets;
  if (!rec::element_sets(omms, &sets, &err)) return fail(err);
  int calib_set = -1;
  for (size_t i = 0; i < sets.size(); ++i)
    if (sets[i].norad == o.calibrator && (calib_set < 0 || std::fabs(sets[i].epoch - t_mid) < std::fabs(sets[size_t(calib_set)].epoch - t_mid)))
      calib_set = static_cast<int>(i);
  if (calib_set < 0) return fail("no element set of the calibrator " + std::to_string(o.calibrator));
  std::map<uint32_t, int> prior_set;
  std::vector<int> later;
  for (uint32_t id : o.targets) {
    int best = -1;
    for (size_t i = 0; i < sets.size(); ++i) {
      const rec::ElementSet& s = sets[i];
      if (s.norad != id || s.epoch > t_first) continue;
      if (std::isfinite(o.prior_created_before) && !(std::isfinite(s.created) && s.created <= o.prior_created_before)) continue;
      if (best < 0 || s.epoch > sets[size_t(best)].epoch) best = static_cast<int>(i);
    }
    if (best < 0) return fail("no prior element set of target " + std::to_string(id) + " (EPOCH at or before the first frame" +
                              std::string(std::isfinite(o.prior_created_before) ? ", created before optical.prior_created_before)" : ")"));
    prior_set[id] = best;
    std::vector<int> mine;
    for (size_t i = 0; i < sets.size(); ++i)
      if (sets[i].norad == id && static_cast<int>(i) != best && sets[i].epoch > sets[size_t(best)].epoch) mine.push_back(static_cast<int>(i));
    std::sort(mine.begin(), mine.end(), [&](int a, int b) { return sets[size_t(a)].epoch < sets[size_t(b)].epoch; });
    // Republished sets (epochs within a second) count once: the later record.
    for (int i : mine) {
      if (!later.empty() && sets[size_t(later.back())].norad == id && std::fabs(sets[size_t(later.back())].epoch - sets[size_t(i)].epoch) < 1.0) later.back() = i;
      else later.push_back(i);
    }
  }
  const double pad = o.trajectory_minutes * 60.0 + 6.0;
  std::vector<PropagationQuery> queries;
  queries.push_back({size_t(calib_set), std::floor(t_first) - 6.0, std::ceil(t_last) + 6.0, 1.0});
  for (uint32_t id : o.targets) queries.push_back({size_t(prior_set[id]), std::floor(t_first) - pad, std::ceil(t_last) + pad, 1.0});
  for (int i : later) queries.push_back({size_t(i), std::floor(t_first) - 6.0, std::ceil(t_last) + 6.0, 1.0});

  std::vector<std::string> items;
  items.push_back("frames=" + std::to_string(r.frames.size()) + " timed=" + std::to_string(timed) + " first=" + iso_utc(t_first, 3) +
                  " last=" + iso_utc(t_last, 3));
  if (!saw_propagation) {
    for (size_t k = 0; k < queries.size(); ++k)
      items.push_back("query " + std::to_string(k) + ": " + sets[queries[k].set].label() + " from " + iso_utc(queries[k].start, 0) + " to " +
                      iso_utc(queries[k].stop, 0));
    if (!push("propagation_requests", "PRW.fbs", "$PRW", "PRW", rec::window_request(queries, sets, o.propagator_port))) return 1;
    return notice("need-propagation", queries.size(), items) ? 0 : 1;
  }

  // ── answers ──
  std::vector<const ephemerisDataBlock*> blocks;
  for (const OEM* oem : answers)
    if (oem->EPHEMERIS_DATA_BLOCK()) for (const auto* b : *oem->EPHEMERIS_DATA_BLOCK()) blocks.push_back(b);
  if (blocks.size() != queries.size())
    return fail("the propagation port holds " + std::to_string(blocks.size()) + " answer blocks for " + std::to_string(queries.size()) +
                " queries; answer every query, in order");
  std::vector<Trajectory> trajs(queries.size());
  std::vector<bool> refused(queries.size(), false);
  for (size_t k = 0; k < queries.size(); ++k) {
    const rec::ElementSet& s = sets[queries[k].set];
    const std::string where = "answer " + std::to_string(k) + " (" + s.label() + ")";
    if (rec::is_refusal(blocks[k])) {
      if (k <= o.targets.size()) return fail(where + " was refused: " + rec::text(blocks[k]->COMMENT()));
      refused[k] = true;
      items.push_back(where + " refused: " + rec::text(blocks[k]->COMMENT()));
      continue;
    }
    Trajectory& tr = trajs[k];
    bool teme = false;
    if (!rec::load_block(blocks[k], &tr, &teme, &err)) return fail(where + ": " + err);
    if (tr.norad && tr.norad != s.norad) return fail(where + " is for NORAD " + std::to_string(tr.norad) + "; answers must follow the queries' order");
    tr.norad = s.norad;
    tr.name = s.name;
    tr.object_id = s.object_id;
    if (tr.t.front() > queries[k].start + 1e-3 || tr.t.back() < queries[k].stop - 1e-3) return fail(where + " does not cover its query's span");
    if (teme && !trajectory_to_gcrs(&tr, clock, &err)) return fail(where + ": " + err);
  }

  // ── the targets' priors: the GP error model at the prior set's age ──
  std::map<uint32_t, std::string> prior_label;
  std::map<uint32_t, std::vector<double>> prior_rtn;
  for (uint32_t id : o.targets) {
    const rec::ElementSet& s = sets[size_t(prior_set[id])];
    std::vector<double> c;
    std::string label;
    if (model.present && rec::model_covariance(model, s, (t_mid - s.epoch) / 86400.0, &c, &label)) {
      prior_rtn[id] = c;
      prior_label[id] = s.label() + "; covariance " + label;
    } else {
      c.assign(36, 0.0);
      for (int i = 0; i < 6; ++i) c[i * 6 + i] = o.prior_sigma[i] * o.prior_sigma[i];
      prior_rtn[id] = c;
      prior_label[id] = s.label() + "; covariance optical.prior_sigma_rtn" +
                        std::string(model.present ? " (the error model has no stratum for this set)" : " (no error model)");
    }
    red.options().prior_rtn[id] = prior_rtn[id];
  }

  // ── the reduction ──
  std::vector<Trajectory> used;
  for (size_t k = 0; k <= o.targets.size(); ++k) used.push_back(trajs[k]);
  red.reduce(used, cat, &r);
  if (r.stage == ReduceResult::FAILED) return fail(r.error);
  for (const std::string& n : r.notes) items.push_back("note: " + n);
  if (r.stage == ReduceResult::NEED_CATALOG) {
    ax::Epoch e;
    ax::EarthOrientation eo;
    double jd_tt = kNaN;
    if (clock.at(t_mid, &e, &eo, &err)) jd_tt = e.tt1 + e.tt2;
    items.push_back("catalog stars held=" + std::to_string(cat.stars.size()) + " from " + std::to_string(catalog_frames) + " frames; cones asked=" +
                    std::to_string(r.cones.size()) + " to " + o.band + " " + rec::fmt(o.mag_limit, "%.1f"));
    if (!push("catalog_requests", "SKQ.fbs", "$SKQ", "SKQ", rec::cone_requests(r.cones, o.mag_limit, o.band, jd_tt))) return 1;
    return notice("need-catalog", r.cones.size(), items) ? 0 : 1;
  }

  // ── products ──
  rec::Context c;
  c.sensor_id = o.sensor_id;
  c.originator = o.originator;
  c.creation = o.creation.empty() ? iso_utc(t_last, 3) : o.creation;
  c.image_set = o.image_set.empty() ? o.sensor_id + ":" + iso_utc(t_first, 3) : o.image_set;
  c.site = r.calib.site;
  c.site_estimated = r.site_estimated;
  c.sigma_n = r.calib.sigma_north_m;
  c.sigma_e = r.calib.sigma_east_m;
  c.sigma_u = r.calib.sigma_up_m;
  c.dt = r.calib.dt;
  c.sigma_dt = r.calib.sigma_dt;
  c.exposure = r.exposure_s;
  if (!r.timing_from_overlay) {
    std::vector<double> ex;
    for (const FrameState& f : r.frames) if (std::isfinite(f.exptime)) ex.push_back(f.exptime);
    if (!ex.empty()) c.exposure = median(ex);
  }
  c.frames = static_cast<int>(r.frames.size());
  c.timing = r.timing_from_overlay ? "times read from the burnt-in overlay, bias solved" : "FITS DATE-OBS (" + o.time_reference + ")";

  // Timing and plates.
  if (r.timing_from_overlay) {
    int decoded = 0, outliers = 0, duplicates = 0;
    for (const FrameTime& ft : r.timing.frames) { decoded += ft.decoded; outliers += ft.outlier; duplicates += ft.duplicate; }
    items.push_back("timing=overlay decoded=" + std::to_string(decoded) + "/" + std::to_string(r.frames.size()) + " outliers=" + std::to_string(outliers) +
                    " duplicates=" + std::to_string(duplicates) + " cadence_s=" + rec::fmt(r.timing.cadence, "%.6f") + "+-" +
                    rec::fmt(r.timing.cadence_sigma, "%.6f") + " jitter_rms_ms=" + rec::fmt(r.timing.jitter_rms * 1e3, "%.2f") + " overlay_box_px=" +
                    std::to_string(r.timing.text_x0) + "," + std::to_string(r.timing.text_y0) + "," + std::to_string(r.timing.text_x1) + "," +
                    std::to_string(r.timing.text_y1));
  } else {
    items.push_back("timing=" + c.timing);
  }
  items.push_back("exposure_s=" + rec::fmt(c.exposure, "%.3f"));
  std::vector<double> med;
  std::vector<int> unsolved;
  int stars_used = 0;
  for (size_t i = 0; i < r.frames.size(); ++i) {
    if (r.frames[i].solved) { med.push_back(r.frames[i].fit.median_arcsec); stars_used += r.frames[i].fit.used; }
    else unsolved.push_back(static_cast<int>(i));
  }
  const double plate_median = med.empty() ? kNaN : median(med);
  items.push_back("plates solved=" + std::to_string(med.size()) + "/" + std::to_string(r.frames.size()) + " median_residual_arcsec=" +
                  rec::fmt(plate_median, "%.2f") + " p90_of_frame_medians_arcsec=" + rec::fmt(med.empty() ? kNaN : quantile(med, 0.9), "%.2f") +
                  " worst_frame_median_arcsec=" + rec::fmt(med.empty() ? kNaN : *std::max_element(med.begin(), med.end()), "%.2f") +
                  " stars_matched=" + std::to_string(stars_used) + " scale_arcsec_per_px=" + rec::fmt(r.plate_scale_arcsec, "%.3f") +
                  " reference_frame=" + std::to_string(r.reference_frame) + " catalog_stars=" + std::to_string(cat.stars.size()));
  items.push_back("unsolved_frames=" + ranges(unsolved));
  items.push_back("site " + std::string(r.site_estimated ? "ESTIMATED" : "given") + " lat_deg=" + rec::fmt(c.site.lat / kDeg, "%.5f") + " lon_deg=" +
                  rec::fmt(c.site.lon / kDeg, "%.5f") + " height_m=" + rec::fmt(c.site.h, "%.0f") + " sigma_north_m=" + rec::fmt(c.sigma_n, "%.0f") +
                  " sigma_east_m=" + rec::fmt(c.sigma_e, "%.0f") + " sigma_up_m=" + rec::fmt(c.sigma_u, "%.0f"));
  items.push_back("time_bias_s=" + rec::fmt(c.dt, "%.4f") + "+-" + rec::fmt(c.sigma_dt, "%.4f") + " (mid-exposure = tag + bias)");

  // The calibrator.
  std::vector<const ObjectTrack*> published;
  const Trajectory& cal_traj = used[0];
  for (const ObjectTrack& t : r.tracks)
    if (t.calibrator) {
      published.push_back(&t);
      std::vector<double> e, n;
      for (const auto& oc : t.oc_arcsec) if (std::isfinite(oc[0])) { e.push_back(oc[0] * oc[0]); n.push_back(oc[1] * oc[1]); }
      const double re = e.empty() ? kNaN : std::sqrt(std::accumulate(e.begin(), e.end(), 0.0) / e.size());
      const double rn = n.empty() ? kNaN : std::sqrt(std::accumulate(n.begin(), n.end(), 0.0) / n.size());
      items.push_back("calibrator NORAD=" + std::to_string(o.calibrator) + " set=" + sets[size_t(calib_set)].label() + " points=" + std::to_string(e.size()) +
                      " fit_rms_arcsec=" + rec::fmt(r.calib.rms_arcsec, "%.2f") + " chi2_per_dof=" + rec::fmt(r.calib.chi2 / std::max(1, r.calib.dof), "%.2f") +
                      " o_minus_c_rms_east_north_arcsec=" + rec::fmt(re, "%.2f") + "," + rec::fmt(rn, "%.2f") + " ephemeris_offset_rtn_km=" +
                      rtn_text(r.calib.rtn) + " ephemeris_sigma_rtn_km=" + rtn_text(o.cal_sigma, "%.2f") + " (assumed)");
    }

  // The targets.
  std::vector<std::vector<uint8_t>> ocms, oems;
  int observations = 0;
  for (size_t ti = 0; ti < o.targets.size(); ++ti) {
    const uint32_t id = o.targets[ti];
    const ObjectTrack* track = nullptr;
    for (const ObjectTrack& t : r.tracks) if (t.norad == id) track = &t;
    const auto fit = r.fits.find(id);
    if (!track || fit == r.fits.end() || !fit->second.ok) { items.push_back("target NORAD=" + std::to_string(id) + " not found or not fitted"); continue; }
    published.push_back(track);
    const OdResult& od = fit->second;
    const Trajectory& prior = used[ti + 1];
    std::vector<std::pair<std::string, std::string>> params;
    auto both = [&](const std::string& k, const std::string& v) { params.push_back({k, v}); items.push_back("target " + std::to_string(id) + " " + k + "=" + v); };
    const std::vector<double> cn = to_rtn(od.cov, od.x), ct = to_rtn(od.cov_total, od.x);
    const double sn[3] = {std::sqrt(cn[0]), std::sqrt(cn[7]), std::sqrt(cn[14])}, st[3] = {std::sqrt(ct[0]), std::sqrt(ct[7]), std::sqrt(ct[14])};
    const double svt[3] = {std::sqrt(ct[21]), std::sqrt(ct[28]), std::sqrt(ct[35])};
    double d_prior[3];
    in_rtn(od.x, V3{od.x[0] - od.prior_x[0], od.x[1] - od.prior_x[1], od.x[2] - od.prior_x[2]}, d_prior);
    both("EPOCH", iso_utc(od.t0, 6));
    both("TRACK", std::to_string(track->points.size()) + " points, " + std::to_string(od.used) + " used, " + std::to_string(r.edited[id]) + " edited");
    both("PRIOR", prior_label[id]);
    both("PRIOR_O_MINUS_C_MEDIAN_ARCSEC", rec::fmt(track->prior_oc_arcsec, "%.1f"));
    both("OD_RMS_ARCSEC", rec::fmt(od.rms_arcsec, "%.2f"));
    both("OD_CHI2_PER_DOF", rec::fmt(od.chi2 / std::max(1, od.dof), "%.3f"));
    both("OD_ITERATIONS", std::to_string(od.iterations));
    both("OD_MINUS_PRIOR_RTN_KM", rtn_text(d_prior));
    both("SIGMA_NOISE_RTN_KM", rtn_text(sn));
    both("SIGMA_TOTAL_RTN_KM", rtn_text(st));
    both("SIGMA_TOTAL_VELOCITY_RTN_KM_S", rtn_text(svt, "%.6f"));
    if (od.iod.ok) {
      V3 pr, pv;
      std::vector<std::array<double, 6>> at;
      std::string iod = "Gooding ranges " + rec::fmt(od.iod.rho[0], "%.1f") + "," + rec::fmt(od.iod.rho[1], "%.1f") + "," + rec::fmt(od.iod.rho[2], "%.1f") +
                        " km, " + std::to_string(od.iod.solutions) + " solution(s)";
      if (prior.at(od.iod.t, &pr, &pv)) iod += ", |IOD - prior| " + rec::fmt(norm(od.iod.r - pr), "%.2f") + " km";
      if (fitted_states(prior, od, {od.iod.t}, &at)) iod += ", |IOD - OD| " + rec::fmt(norm(od.iod.r - V3{at[0][0], at[0][1], at[0][2]}), "%.2f") + " km";
      both("IOD", iod);
    } else {
      both("IOD", "not converged: " + od.iod.error);
    }
    // Against the later element sets: the OD and the prior, each with its
    // covariance plus the later set's (the error model at its age).
    const std::vector<double> p_od = position_block(ct);
    const std::vector<double> p_prior = position_block(prior_rtn[id]);
    for (size_t k = o.targets.size() + 1; k < queries.size(); ++k) {
      const rec::ElementSet& s = sets[queries[k].set];
      if (s.norad != id || refused[k]) continue;
      V3 rl, vl;
      if (!trajs[k].at(od.t0, &rl, &vl)) continue;
      double d_od[3], d_pr[3];
      in_rtn(od.x, V3{od.x[0], od.x[1], od.x[2]} - rl, d_od);
      in_rtn(od.x, V3{od.prior_x[0], od.prior_x[1], od.prior_x[2]} - rl, d_pr);
      std::vector<double> cl;
      std::string label;
      std::string check = "OD-set RTN km " + rtn_text(d_od) + " (|d| " + f3(std::sqrt(d_od[0] * d_od[0] + d_od[1] * d_od[1] + d_od[2] * d_od[2])) +
                          "); prior-set RTN km " + rtn_text(d_pr) + " (|d| " + f3(std::sqrt(d_pr[0] * d_pr[0] + d_pr[1] * d_pr[1] + d_pr[2] * d_pr[2])) + ")";
      if (model.present && rec::model_covariance(model, s, (od.t0 - s.epoch) / 86400.0, &cl, &label)) {
        const std::vector<double> pl = position_block(cl);
        std::vector<double> a(9), b(9);
        for (int q = 0; q < 9; ++q) { a[q] = p_od[q] + pl[q]; b[q] = p_prior[q] + pl[q]; }
        check += "; set 1-sigma RTN km " + f3(std::sqrt(pl[0])) + "," + f3(std::sqrt(pl[4])) + "," + f3(std::sqrt(pl[8])) + " (" + label + ")";
        check += "; d2 (3 dof) OD " + rec::fmt(mahalanobis2(d_od, a), "%.3f") + ", prior " + rec::fmt(mahalanobis2(d_pr, b), "%.3f");
      }
      both("CHECK " + s.label() + (std::isfinite(s.created) ? " CREATED " + iso_utc(s.created, 0) : ""), check);
    }
    // From the calibrator at the arc's middle.
    V3 rc, vc;
    if (cal_traj.at(od.t0, &rc, &vc)) {
      const double xc[6] = {rc.x, rc.y, rc.z, vc.x, vc.y, vc.z};
      const V3 d = V3{od.x[0], od.x[1], od.x[2]} - rc;
      double rel[3];
      in_rtn(xc, d, rel);
      const V3 u = unit(d);
      const double ud[3] = {u.x, u.y, u.z};
      double var = 0;
      for (int a = 0; a < 3; ++a)
        for (int b = 0; b < 3; ++b) var += ud[a] * od.cov_total[a * 6 + b] * ud[b];
      const V3 dp = V3{od.prior_x[0], od.prior_x[1], od.prior_x[2]} - rc;
      both("SEPARATION_FROM_CALIBRATOR_KM", f3(norm(d)) + "+-" + f3(std::sqrt(var)) + " (OD; the calibrator's element set " + sets[size_t(calib_set)].label() +
                                                "); prior " + f3(norm(dp)));
      both("RELATIVE_TO_CALIBRATOR_RTN_KM", rtn_text(rel) + " (the calibrator's RTN axes)");
    }
    // The orbit and its trajectory.
    std::vector<double> times;
    const double half = o.trajectory_minutes * 60.0;
    for (double t = std::ceil(od.t0 - half); t <= od.t0 + half + 1e-9; t += o.trajectory_step)
      if (prior.covers(t)) times.push_back(t);
    std::vector<std::array<double, 6>> states;
    if (times.size() >= 4 && fitted_states(prior, od, times, &states))
      oems.push_back(rec::oem(c, *track, times, states,
                              "Orbit of " + rec::object_label(*track) + " from optical angles: the prior element set's trajectory (the propagator's answer) "
                              "plus the batch fit's deviation at " + iso_utc(od.t0, 3) + " through the two-body + J2 transition matrix; GCRF, UTC, km, km/s."));
    ocms.push_back(rec::ocm(c, *track, od, params, prior_label[id]));
  }
  for (const ObjectTrack* t : published) for (const TrackPoint& p : t->points) observations += p.valid;

  if (!push("observations", "TDM.fbs", "$TDM", "TDM", rec::tdm(r, c, published))) return 1;
  if (!push("optical_observations", "EOO.fbs", "$EOO", "EOO", rec::eoo(r, c, published))) return 1;
  if (!push("plates", "SKI.fbs", "$SKI", "SKI", rec::ski(r, c, names, published))) return 1;
  std::vector<uint8_t> stream;
  for (const auto& b : ocms) stream.insert(stream.end(), b.begin(), b.end());
  if (!push("orbit", "OCM.fbs", "$OCM", "OCM", stream)) return 1;
  for (const auto& b : oems) if (!push("orbit_trajectory", "OEM.fbs", "$OEM", "OEM", b)) return 1;
  if (!clock.have_eop) items.push_back("earth orientation: none given (UT1 = UTC, no polar motion)");
  return notice("done", static_cast<uint64_t>(observations), items) ? 0 : 1;
}

}  // namespace mod
}  // namespace oa

extern "C" int reduce() { return oa::mod::reduce_method(); }
