// The SDS boundary: the records the reduction reads and writes.
//
// In:  frames ($FIL CONTENT: FITS or PGM), reference stars ($SKT tiles or
//      $STR rows), element sets ($OMM), the propagator's answers ($OEM, one
//      block per query), Earth orientation ($EOP) and the GP error model
//      ($ERM MODEL, analysis/gp-error-model) for the targets' priors.
// Out: propagation queries ($PRW WINDOW_REQUEST, the contract of
//      analysis/maneuver-detection and analysis/rpo-history), catalog cones
//      ($SKQ CONE), angles ($TDM, CCSDS 503.0-B-2: RADEC, one segment per
//      object), the same observations one by one with their uncertainties
//      ($EOO), the plate solutions ($SKI), the orbit ($OCM state and
//      covariance) and its trajectory ($OEM).
namespace oa {
namespace rec {

using StrOff = flatbuffers::Offset<flatbuffers::String>;

inline std::string text(const flatbuffers::String* s) { return s ? s->str() : std::string(); }

inline std::string fmt(double v, const char* f = "%.6g") {
  char b[64];
  std::snprintf(b, sizeof b, f, v);
  return b;
}

// Every record of one input frame: a plain buffer, or a stream of
// size-prefixed records (zero-length prefixes are padding).
template <typename Root>
inline bool records(const uint8_t* bytes, size_t length, const char* ident, bool (*verify)(flatbuffers::Verifier&),
                    bool (*verify_prefixed)(flatbuffers::Verifier&), const Root* (*get)(const void*),
                    const Root* (*get_prefixed)(const void*), std::vector<const Root*>* out, const char* what, std::string* err) {
  flatbuffers::Verifier::Options vo;
  vo.max_depth = 128;
  vo.max_tables = 50000000;
  vo.check_alignment = false;
  if (length >= 8 && flatbuffers::BufferHasIdentifier(bytes, ident, false) && !flatbuffers::BufferHasIdentifier(bytes, ident, true)) {
    flatbuffers::Verifier v(bytes, length, vo);
    if (!verify(v)) { *err = std::string("a ") + what + " frame is not a valid " + ident + " record"; return false; }
    out->push_back(get(bytes));
    return true;
  }
  size_t at = 0;
  while (at < length) {
    if (length - at < 4) { *err = std::string("a ") + what + " frame ends in a truncated record"; return false; }
    const uint32_t len = flatbuffers::ReadScalar<uint32_t>(bytes + at);
    if (len == 0) { at += 4; continue; }
    if (len > length - at - 4 || len < 4) { *err = std::string("a ") + what + " frame ends in a truncated record"; return false; }
    const uint8_t* r = bytes + at;
    flatbuffers::Verifier v(r, size_t(len) + 4, vo);
    if (!flatbuffers::BufferHasIdentifier(r, ident, true) || !verify_prefixed(v)) {
      *err = std::string("a ") + what + " frame holds a record that is not a valid size-prefixed " + ident;
      return false;
    }
    out->push_back(get_prefixed(r));
    at += 4 + size_t(len);
  }
  return true;
}

// ── element sets ───────────────────────────────────────────────────────────
struct ElementSet {
  size_t record = 0;            // index over every element_sets record, in input order
  uint32_t norad = 0;
  std::string name, object_id;
  double epoch = kNaN;          // UTC Unix s
  double created = kNaN;        // CREATION_DATE, when given
  double eccentricity = kNaN;
  double altitude = kNaN;       // mean altitude, km (WGS-72 mean motion, the error model's regimes)
  std::string label() const {
    return (name.empty() ? "NORAD " + std::to_string(norad) : name + " (" + std::to_string(norad) + ")") + " EPOCH " + iso_utc(epoch, 6);
  }
};

inline bool element_sets(const std::vector<const OMM*>& in, std::vector<ElementSet>* out, std::string* err) {
  for (size_t i = 0; i < in.size(); ++i) {
    const OMM* o = in[i];
    ElementSet s;
    s.record = i;
    s.norad = o->NORAD_CAT_ID();
    s.name = text(o->OBJECT_NAME());
    s.object_id = text(o->OBJECT_ID());
    if (!parse_iso_utc_seconds(text(o->EPOCH()), &s.epoch)) { *err = "element set " + std::to_string(i) + ": EPOCH is not ISO 8601 UTC"; return false; }
    double c;
    if (parse_iso_utc_seconds(text(o->CREATION_DATE()), &c)) s.created = c;
    s.eccentricity = o->ECCENTRICITY();
    const double n = o->MEAN_MOTION() * kTwoPi / 86400.0;
    if (n > 0) s.altitude = std::cbrt(398600.8 / (n * n)) - 6378.135;
    out->push_back(s);
  }
  return true;
}

// ── the GP error model ─────────────────────────────────────────────────────
// A stratum gives a 6x6 RTN covariance (lower triangle, row-major: RR, TR,
// TT, NR, NT, NN, dR R, ...; km and km/s) for element sets of one orbit
// regime at one prediction age: the clipped covariance when the stratum has
// one, else the sample covariance, times the stratum's per-axis scale
// factors when it was scaled (the reading analysis/rpo-history makes of the
// same model).
struct Regime {
  std::string id;
  double alt0 = 0, alt1 = 0, e0 = 0, e1 = 0;
};
struct Stratum {
  uint32_t regime = 0;
  double age0 = 0, age1 = 0;
  bool last = false, clipped = false;
  std::array<double, 21> lower{};
};
struct ErrorModel {
  bool present = false;
  std::string id, basis;
  std::vector<Regime> regimes;
  std::vector<Stratum> strata;
  int regime_of(double alt, double e) const {
    for (size_t i = 0; i < regimes.size(); ++i)
      if (alt >= regimes[i].alt0 && alt < regimes[i].alt1 && e >= regimes[i].e0 && e < regimes[i].e1) return static_cast<int>(i);
    return -1;
  }
  const Stratum* at(int regime, double age_days) const {
    if (regime < 0 || !(age_days >= 0)) return nullptr;
    for (const Stratum& s : strata)
      if (s.regime == uint32_t(regime) && age_days >= s.age0 && (age_days < s.age1 || (s.last && age_days <= s.age1))) return &s;
    return nullptr;
  }
};

inline bool load_error_model(const ERM* erm, ErrorModel* out, std::string* err) {
  const ERMModel* m = erm->MODEL();
  if (!m) { *err = "the error_model $ERM carries no MODEL"; return false; }
  out->present = true;
  out->id = text(m->ID());
  if (out->id.empty()) out->id = text(m->LABEL());
  out->basis = text(m->BASIS_TEXT());
  const ERMStrataSettings* settings = m->STRATA_SETTINGS() ? m->STRATA_SETTINGS() : erm->STRATA_SETTINGS();
  if (!settings || !settings->REGIMES() || settings->REGIMES()->size() == 0) { *err = "the error model names no regimes"; return false; }
  for (const auto* r : *settings->REGIMES())
    out->regimes.push_back({text(r->ID()), r->ALTITUDE_MIN_KM(), r->ALTITUDE_MAX_KM(), r->ECCENTRICITY_MIN(), r->ECCENTRICITY_MAX()});
  if (!m->STRATA()) { *err = "the error model has no STRATA"; return false; }
  std::map<uint32_t, double> last_age;
  for (const auto* s : *m->STRATA()) {
    const flatbuffers::Vector<double>* lower = nullptr;
    Stratum t;
    if (s->CLIPPED() && s->CLIPPED()->COVARIANCE() && s->CLIPPED()->COVARIANCE()->size() >= 21) { lower = s->CLIPPED()->COVARIANCE(); t.clipped = true; }
    else if (s->COVARIANCE() && s->COVARIANCE()->size() >= 21) lower = s->COVARIANCE();
    if (!lower) continue;
    t.regime = s->REGIME_INDEX();
    if (t.regime >= out->regimes.size()) continue;
    t.age0 = s->AGE_MIN_DAYS();
    t.age1 = s->AGE_MAX_DAYS();
    if (!(t.age1 > t.age0) && settings->AGE_BINS() && s->AGE_INDEX() < settings->AGE_BINS()->size()) {
      t.age0 = settings->AGE_BINS()->Get(s->AGE_INDEX())->MIN_DAYS();
      t.age1 = settings->AGE_BINS()->Get(s->AGE_INDEX())->MAX_DAYS();
    }
    if (!(t.age1 > t.age0)) continue;
    for (size_t i = 0; i < 21; ++i) t.lower[i] = lower->Get(flatbuffers::uoffset_t(i));
    if (s->SCALE() && s->SCALE()->FACTORS() && s->SCALE()->FACTORS()->size() >= 3) {
      const double f[3] = {s->SCALE()->FACTORS()->Get(0), s->SCALE()->FACTORS()->Get(1), s->SCALE()->FACTORS()->Get(2)};
      for (int i = 0; i < 6; ++i)
        for (int j = 0; j <= i; ++j) t.lower[size_t(i * (i + 1) / 2 + j)] *= f[i % 3] * f[j % 3];
    }
    bool finite = true;
    for (double v : t.lower) finite = finite && std::isfinite(v);
    if (!finite || !(t.lower[0] > 0 && t.lower[2] > 0 && t.lower[5] > 0 && t.lower[9] > 0 && t.lower[14] > 0 && t.lower[20] > 0)) continue;
    last_age[t.regime] = std::max(last_age.count(t.regime) ? last_age[t.regime] : 0.0, t.age1);
    out->strata.push_back(t);
  }
  for (Stratum& s : out->strata) s.last = s.age1 >= last_age[s.regime];
  if (out->strata.empty()) { *err = "the error model has no stratum with a full 6x6 covariance"; return false; }
  return true;
}

// The model's 6x6 RTN covariance (row-major, km, km/s) of a set at an age
// (|age|: a set issued after the arc is as uncertain at the arc as one
// issued as long before it).
inline bool model_covariance(const ErrorModel& m, const ElementSet& s, double age_days, std::vector<double>* out, std::string* label) {
  const int g = m.regime_of(s.altitude, s.eccentricity);
  const Stratum* st = m.at(g, std::fabs(age_days));
  if (!st) return false;
  out->assign(36, 0.0);
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j <= i; ++j) (*out)[i * 6 + j] = (*out)[j * 6 + i] = st->lower[size_t(i * (i + 1) / 2 + j)];
  *label = m.id + ": " + m.regimes[st->regime].id + ", age " + fmt(st->age0, "%g") + "-" + fmt(st->age1, "%g") + " d" + (st->clipped ? ", clipped" : "");
  return true;
}

// ── propagator answers ─────────────────────────────────────────────────────
inline bool is_refusal(const ephemerisDataBlock* b) {
  const bool empty = (!b->EPHEMERIS_DATA() || b->EPHEMERIS_DATA()->size() == 0) && (!b->EPHEMERIS_DATA_LINES() || b->EPHEMERIS_DATA_LINES()->size() == 0);
  return empty && b->COMMENT() && b->COMMENT()->str().rfind("REFUSED", 0) == 0;
}

inline std::string upper(std::string s) {
  for (char& c : s) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
  return s;
}

// One answer block: UTC, km, km/s, TEME (rotated to GCRS by the caller) or
// GCRF / ICRF / EME2000 axes (taken as GCRS: the frame bias, 23 mas, is
// below the measurements).
inline bool load_block(const ephemerisDataBlock* b, Trajectory* tr, bool* teme, std::string* err) {
  if (b->TIME_SYSTEM() != timingStandard::UTC) { *err = "answer blocks must be TIME_SYSTEM UTC"; return false; }
  std::string frame;
  if (const auto* c = b->REFERENCE_FRAME() ? b->REFERENCE_FRAME()->REFERENCE_FRAME_as_CelestialFrameWrapper() : nullptr) {
    switch (c->frame()) {
      case CelestialFrame::TEMEOFDATE: frame = "TEME"; break;
      case CelestialFrame::GCRF: case CelestialFrame::ICRF: case CelestialFrame::EME2000: case CelestialFrame::J2000: frame = "GCRF"; break;
      default: break;
    }
  }
  if (frame.empty() && b->REFERENCE_FRAME() && b->REFERENCE_FRAME()->NAME()) {
    const std::string n = upper(b->REFERENCE_FRAME()->NAME()->str());
    if (n == "TEME" || n == "TEMEOFDATE") frame = "TEME";
    else if (n == "GCRF" || n == "ICRF" || n == "EME2000" || n == "J2000") frame = "GCRF";
  }
  if (frame.empty()) { *err = "answer blocks must be in TEME, GCRF, ICRF or EME2000 axes"; return false; }
  *teme = frame == "TEME";
  if (b->CENTER_NAME() && upper(b->CENTER_NAME()->str()) != "EARTH") { *err = "answer blocks must be centered on EARTH"; return false; }
  std::vector<std::pair<double, std::array<double, 6>>> rows;
  if (b->STEP_SIZE() > 0 && b->EPHEMERIS_DATA() && b->EPHEMERIS_DATA()->size() > 0) {
    const unsigned w = b->STATE_VECTOR_SIZE();
    if (!(w == 6 || w == 9) || b->EPHEMERIS_DATA()->size() % w != 0) { *err = "compact answer data is not whole states"; return false; }
    double start;
    if (!parse_iso_utc_seconds(text(b->START_TIME()), &start)) { *err = "compact answer data needs START_TIME"; return false; }
    const auto* d = b->EPHEMERIS_DATA();
    for (size_t i = 0; i * w < d->size(); ++i) {
      std::array<double, 6> st;
      for (int k = 0; k < 6; ++k) st[k] = d->Get(flatbuffers::uoffset_t(i * w + k));
      rows.push_back({start + double(i) * b->STEP_SIZE(), st});
    }
  } else if (b->EPHEMERIS_DATA_LINES()) {
    for (const auto* l : *b->EPHEMERIS_DATA_LINES()) {
      double t;
      if (!parse_iso_utc_seconds(text(l->EPOCH()), &t)) { *err = "an answer line EPOCH is not ISO 8601 UTC"; return false; }
      rows.push_back({t, {l->X(), l->Y(), l->Z(), l->X_DOT(), l->Y_DOT(), l->Z_DOT()}});
    }
  }
  std::stable_sort(rows.begin(), rows.end(), [](const auto& a, const auto& c) { return a.first < c.first; });
  for (const auto& r : rows) {
    for (double v : r.second) if (!std::isfinite(v)) { *err = "an answer state is not finite"; return false; }
    if (!tr->t.empty() && r.first == tr->t.back()) continue;
    tr->t.push_back(r.first);
    tr->s.push_back(r.second);
  }
  if (tr->t.size() < 4) { *err = "an answer block needs at least four states"; return false; }
  if (b->OBJECT()) {
    if (!tr->norad) tr->norad = b->OBJECT()->NORAD_CAT_ID();
    if (tr->object_id.empty()) tr->object_id = text(b->OBJECT()->OBJECT_ID());
  }
  return true;
}

// ── requests out ───────────────────────────────────────────────────────────
inline flatbuffers::Offset<TIMInstant> instant(flatbuffers::FlatBufferBuilder& fb, double t) {
  const auto s = fb.CreateString(iso_utc(t, 3));
  TIMInstantBuilder b(fb);
  b.add_TIME_SYSTEM(timingStandard::UTC);
  b.add_EPOCH_FORMAT(timEpochRepresentation::ISO8601);
  b.add_ISO8601(s);
  return b.Finish();
}

inline std::vector<uint8_t> window_request(const std::vector<PropagationQuery>& queries, const std::vector<ElementSet>& sets,
                                           const std::string& port) {
  flatbuffers::FlatBufferBuilder fb(1024 + queries.size() * 256);
  std::vector<flatbuffers::Offset<PRWWindowQuery>> list;
  for (size_t i = 0; i < queries.size(); ++i) {
    const PropagationQuery& q = queries[i];
    const ElementSet& s = sets[q.set];
    const auto key = fb.CreateString(std::to_string(s.norad));
    const auto oid = s.object_id.empty() ? StrOff() : fb.CreateString(s.object_id);
    const auto epoch = instant(fb, s.epoch), start = instant(fb, q.start), stop = instant(fb, q.stop);
    PRWWindowQueryBuilder b(fb);
    b.add_SEQUENCE(uint32_t(i));
    b.add_SET_INDEX(uint32_t(s.record));
    b.add_OBJECT_KEY(key);
    b.add_NORAD_CAT_ID(s.norad);
    if (!oid.IsNull()) b.add_OBJECT_ID(oid);
    b.add_SOURCE_EPOCH(epoch);
    b.add_START(start);
    b.add_STOP(stop);
    b.add_STEP_SECONDS(q.step);
    list.push_back(b.Finish());
  }
  const auto qv = fb.CreateVector(list);
  const auto p = port.empty() ? StrOff() : fb.CreateString(port);
  const auto ins = fb.CreateString(
      "One $OEM data block per query, in SEQUENCE order: the set's trajectory from START to STOP every STEP_SECONDS or less, UTC, km and "
      "km/s, TEME or GCRF axes. A set the propagator refuses: an empty block whose COMMENT begins REFUSED.");
  PRWWindowRequestBuilder b(fb);
  b.add_QUERIES(qv);
  if (!p.IsNull()) b.add_PROPAGATOR_PORT_ID(p);
  b.add_NEIGHBOUR_SETS(0);  // us-spelling-ok: the SDS $PRW field name
  b.add_INSTRUCTIONS(ins);
  const auto arm = b.Finish();
  PRWBuilder m(fb);
  m.add_WINDOW_REQUEST(arm);
  FinishPRWBuffer(fb, m.Finish());
  return std::vector<uint8_t>(fb.GetBufferPointer(), fb.GetBufferPointer() + fb.GetSize());
}

// Catalog cones the reduction needs, one size-prefixed $SKQ each:
// catalog places (ICRS at the catalog epoch), to a magnitude limit.
inline std::vector<uint8_t> cone_requests(const std::vector<Cone>& cones, double mag_limit, const std::string& band, double jd_tt) {
  std::vector<uint8_t> out;
  for (size_t i = 0; i < cones.size(); ++i) {
    double ra, dec;
    unit_to_radec(cones[i].center, &ra, &dec);
    flatbuffers::FlatBufferBuilder fb(256);
    const auto id = fb.CreateString("CONE:" + std::to_string(i));
    const auto bd = fb.CreateString(band);
    SKQBuilder b(fb);
    b.add_QUERY_ID(id);
    b.add_QUERY_KIND(skqQueryKind::CONE);
    b.add_EPOCH_JD_TT(jd_tt);
    b.add_PLACE(sktPlaceKind::CATALOG);
    b.add_BAND_ID(bd);
    b.add_MAG_LIMIT(static_cast<float>(mag_limit));
    b.add_RA_DEG(ra / kDeg);
    b.add_DEC_DEG(dec / kDeg);
    b.add_RADIUS_DEG(cones[i].radius / kDeg);
    FinishSizePrefixedSKQBuffer(fb, b.Finish());
    out.insert(out.end(), fb.GetBufferPointer(), fb.GetBufferPointer() + fb.GetSize());
  }
  return out;
}

// ── products out ───────────────────────────────────────────────────────────
// What every product shares: the sensor, the site and timing, the creation.
struct Context {
  std::string sensor_id, originator, creation, image_set;
  Site site;
  bool site_estimated = false;
  double sigma_n = 0, sigma_e = 0, sigma_u = 0;   // m
  double dt = 0, sigma_dt = 0;                    // s
  double exposure = kNaN;                         // s
  int frames = 0;
  std::string timing;                             // how the frames were timed
};

inline flatbuffers::Offset<RFM> celestial(flatbuffers::FlatBufferBuilder& fb, CelestialFrame f, const char* name) {
  const auto w = CreateCelestialFrameWrapper(fb, f);
  const auto n = fb.CreateString(name);
  return CreateRFM(fb, RFMUnion::CelestialFrameWrapper, w.Union(), 0, n);
}

// The published direction: geometric (the site's aberration removed) from
// the site to the object at the receive time, light time not removed, GCRS
// axes; the per-point 1-sigma along east and north and their correlation
// (centroid through the plate, plus the plate model).
struct Point {
  double t = 0;             // receive time, UTC Unix s (tag + bias)
  double ra = 0, dec = 0;   // rad
  double se = 0, sn = 0, rho = 0;  // rad, rad, -
  double mag = kNaN, snr = 0;
  int frame = -1;
};

inline std::vector<Point> points_of(const ReduceResult& r, const ObjectTrack& t) {
  std::vector<Point> out;
  for (const TrackPoint& p : t.points) {
    if (!p.valid) continue;
    Point q;
    q.frame = p.frame;
    q.t = r.frames[p.frame].t + r.calib.dt;
    unit_to_radec(p.geometric, &q.ra, &q.dec);
    q.se = std::sqrt(std::max(0.0, p.c[0][0]));
    q.sn = std::sqrt(std::max(0.0, p.c[1][1]));
    q.rho = q.se > 0 && q.sn > 0 ? p.c[0][1] / (q.se * q.sn) : 0;
    q.mag = p.mag;
    q.snr = p.snr;
    out.push_back(q);
  }
  return out;
}

inline std::string object_label(const ObjectTrack& t) {
  return (t.name.empty() ? std::string("NORAD ") : t.name + " NORAD ") + std::to_string(t.norad);
}

inline std::vector<uint8_t> tdm(const ReduceResult& r, const Context& c, const std::vector<const ObjectTrack*>& tracks) {
  flatbuffers::FlatBufferBuilder fb(4096 + 256 * r.frames.size() * tracks.size());
  std::vector<flatbuffers::Offset<TDMSegment>> segs;
  double start = kNaN, stop = kNaN;
  for (const ObjectTrack* t : tracks) {
    const std::vector<Point> pts = points_of(r, *t);
    if (pts.empty()) continue;
    std::vector<flatbuffers::Offset<TDMObservation>> obs;
    std::vector<double> se, sn;
    for (const Point& p : pts) {
      const auto e1 = fb.CreateString(iso_utc(p.t, 6));
      const auto k1 = fb.CreateString("ANGLE_1");
      obs.push_back(CreateTDMObservation(fb, k1, e1, p.ra / kDeg));
      const auto e2 = fb.CreateString(iso_utc(p.t, 6));
      const auto k2 = fb.CreateString("ANGLE_2");
      obs.push_back(CreateTDMObservation(fb, k2, e2, p.dec / kDeg));
      se.push_back(p.se / kArcsec);
      sn.push_back(p.sn / kArcsec);
    }
    start = std::isfinite(start) ? std::min(start, pts.front().t) : pts.front().t;
    stop = std::isfinite(stop) ? std::max(stop, pts.back().t) : pts.back().t;
    std::vector<StrOff> com;
    com.push_back(fb.CreateString("Angles of " + object_label(*t) + (t->calibrator ? " (the calibrator)" : "") +
                                  ": geometric topocentric RA and declination, GCRF axes, at the receive time (light time not removed); "
                                  "stellar aberration by the site's velocity removed; reduced against apparent places of the catalog."));
    com.push_back(fb.CreateString("Per-point 1-sigma (centroid and plate), arcsec: east median " + fmt(median(se), "%.2f") + ", north median " +
                                  fmt(median(sn), "%.2f") + "; per point in the $EOO records. Common to all points: time bias " + fmt(c.dt, "%.4f") +
                                  " +- " + fmt(c.sigma_dt, "%.4f") + " s (applied); site 1-sigma N " + fmt(c.sigma_n, "%.0f") + " m, E " +
                                  fmt(c.sigma_e, "%.0f") + " m, U " + fmt(c.sigma_u, "%.0f") + " m."));
    const auto comv = fb.CreateVector(com);
    const auto ts = fb.CreateString("UTC");
    const auto st = fb.CreateString(iso_utc(pts.front().t, 6)), sp = fb.CreateString(iso_utc(pts.back().t, 6));
    const auto p1 = fb.CreateString(c.sensor_id), p2 = fb.CreateString(std::to_string(t->norad));
    const auto mode = fb.CreateString("SEQUENTIAL"), path = fb.CreateString("2,1");
    const auto iref = fb.CreateString("MIDDLE"), tref = fb.CreateString("RECEIVE"), at = fb.CreateString("RADEC");
    const auto rf = fb.CreateString("GCRF"), dq = fb.CreateString("VALIDATED"), dtp = fb.CreateString("ANGLE_1,ANGLE_2");
    const auto ov = fb.CreateVector(obs);
    TDMSegmentBuilder b(fb);
    b.add_COMMENT(comv);
    b.add_TIME_SYSTEM(ts);
    b.add_START_TIME(st);
    b.add_STOP_TIME(sp);
    b.add_PARTICIPANT_1(p1);
    b.add_PARTICIPANT_2(p2);
    b.add_MODE(mode);
    b.add_PATH(path);
    if (std::isfinite(c.exposure)) b.add_INTEGRATION_INTERVAL(c.exposure);
    b.add_INTEGRATION_REF(iref);
    b.add_TIMETAG_REF(tref);
    b.add_ANGLE_TYPE(at);
    b.add_REFERENCE_FRAME(rf);
    b.add_DATA_QUALITY(dq);
    b.add_DATA_TYPES(dtp);
    b.add_OBSERVATIONS(ov);
    segs.push_back(b.Finish());
  }
  // The site, ITRF meters.
  double xyz[3];
  eraGd2gc(1, c.site.lon, c.site.lat, c.site.h, xyz);
  const auto sv = fb.CreateVector(segs);
  const auto oid = fb.CreateString(c.sensor_id);
  const auto opf = [&]() {
    const auto n = fb.CreateString("ITRF");
    RFMBuilder b(fb);
    b.add_NAME(n);
    return b.Finish();
  }();
  const auto vers = fb.CreateString("2.0"), cre = fb.CreateString(c.creation), org = fb.CreateString(c.originator);
  std::vector<StrOff> com{fb.CreateString("Optical angles from " + std::to_string(c.frames) + " frames (" + c.timing + "); site " +
                                          std::string(c.site_estimated ? "ESTIMATED from the calibrator (an assumption with the stated 1-sigma)" : "given") +
                                          ": geodetic WGS-84 latitude " + fmt(c.site.lat / kDeg, "%.5f") + " deg, longitude " +
                                          fmt(c.site.lon / kDeg, "%.5f") + " deg, height " + fmt(c.site.h, "%.0f") + " m; OBSERVER_X/Y/Z ITRF, m.")};
  const auto comv = fb.CreateVector(com);
  const auto ts = fb.CreateString("UTC"), tref = fb.CreateString("RECEIVE"), at = fb.CreateString("RADEC"), rf = fb.CreateString("GCRF");
  const auto st = fb.CreateString(std::isfinite(start) ? iso_utc(start, 6) : ""), sp = fb.CreateString(std::isfinite(stop) ? iso_utc(stop, 6) : "");
  TDMBuilder b(fb);
  b.add_OBSERVER_ID(oid);
  b.add_OBSERVER_X(xyz[0]);
  b.add_OBSERVER_Y(xyz[1]);
  b.add_OBSERVER_Z(xyz[2]);
  b.add_OBSERVER_POSITION_REFERENCE_FRAME(opf);
  b.add_CCSDS_TDM_VERS(vers);
  b.add_COMMENT(comv);
  b.add_CREATION_DATE(cre);
  b.add_ORIGINATOR(org);
  b.add_TIME_SYSTEM(ts);
  b.add_START_TIME(st);
  b.add_STOP_TIME(sp);
  b.add_TIMETAG_REF(tref);
  b.add_ANGLE_TYPE(at);
  b.add_REFERENCE_FRAME(rf);
  b.add_SEGMENTS(sv);
  FinishTDMBuffer(fb, b.Finish());
  return std::vector<uint8_t>(fb.GetBufferPointer(), fb.GetBufferPointer() + fb.GetSize());
}

inline std::string eoo_id(const Context& c, uint32_t norad, int frame) {
  return c.image_set + ":" + std::to_string(norad) + ":" + std::to_string(frame);
}

// One $EOO per observation, size-prefixed. RA_UNC is the right ascension's
// own 1-sigma (east / cos dec); the east-north correlation is in DESCRIPTOR.
inline std::vector<uint8_t> eoo(const ReduceResult& r, const Context& c, const std::vector<const ObjectTrack*>& tracks) {
  std::vector<uint8_t> out;
  for (const ObjectTrack* t : tracks) {
    const std::vector<Point> pts = points_of(r, *t);
    for (size_t i = 0; i < pts.size(); ++i) {
      const Point& p = pts[i];
      flatbuffers::FlatBufferBuilder fb(768);
      const auto id = fb.CreateString(eoo_id(c, t->norad, p.frame));
      const auto obt = fb.CreateString(iso_utc(p.t, 6));
      const auto sen = fb.CreateString(c.sensor_id);
      const auto set = fb.CreateString(c.image_set);
      const auto oid = t->object_id.empty() ? StrOff() : fb.CreateString(t->object_id);
      const auto desc = fb.CreateString("east-north correlation " + fmt(p.rho, "%.3f") + "; SNR " + fmt(p.snr, "%.1f") +
                                        (t->calibrator ? "; the calibrator (site and timing estimated from it)" : ""));
      const auto src = fb.CreateString(c.originator);
      const auto frame = celestial(fb, CelestialFrame::GCRF, "GCRF");
      EOOBuilder b(fb);
      b.add_ID(id);
      b.add_OB_TIME(obt);
      b.add_SENSOR_ID(sen);
      b.add_COLLECT_METHOD(CollectMethod::RATE_TRACK);
      b.add_NORAD_CAT_ID(int32_t(t->norad));
      b.add_IMAGE_SET_ID(set);
      b.add_IMAGE_SET_LENGTH(c.frames);
      b.add_SEQUENCE_ID(p.frame);
      b.add_OB_POSITION(i == 0 ? ObservationPosition::FIRST : i + 1 == pts.size() ? ObservationPosition::LAST : ObservationPosition::IN);
      if (!oid.IsNull()) b.add_ORIG_OBJECT_ID(oid);
      b.add_UCT(false);
      b.add_RA(float(p.ra / kDeg));
      b.add_RA_UNC(float(p.se / std::max(1e-9, std::cos(p.dec)) / kDeg));
      b.add_DECLINATION(float(p.dec / kDeg));
      b.add_DECLINATION_UNC(float(p.sn / kDeg));
      b.add_SENLAT(float(c.site.lat / kDeg));
      b.add_SENLON(float(c.site.lon / kDeg));
      b.add_SENALT(float(c.site.h / 1000.0));
      if (std::isfinite(c.exposure)) b.add_EXP_DURATION(float(c.exposure));
      if (std::isfinite(p.mag)) b.add_MAG(float(p.mag));
      b.add_TIMING_BIAS(float(c.dt));
      b.add_DESCRIPTOR(desc);
      b.add_SOURCE(src);
      b.add_DATA_MODE(DataMode::REAL);
      b.add_REFERENCE_FRAME(frame);
      b.add_RA_MEASURED(true);
      b.add_DECLINATION_MEASURED(true);
      FinishSizePrefixedEOOBuffer(fb, b.Finish());
      out.insert(out.end(), fb.GetBufferPointer(), fb.GetBufferPointer() + fb.GetSize());
    }
  }
  return out;
}

// One $SKI per plate-solved frame, size-prefixed: the exposure, the field
// and the plate solution's statistics; EO_OBSERVATIONS names its $EOO.
inline std::vector<uint8_t> ski(const ReduceResult& r, const Context& c, const std::vector<std::string>& names,
                                const std::vector<const ObjectTrack*>& tracks) {
  std::vector<uint8_t> out;
  for (size_t i = 0; i < r.frames.size(); ++i) {
    const FrameState& f = r.frames[i];
    if (!f.solved) continue;
    flatbuffers::FlatBufferBuilder fb(1024);
    std::vector<StrOff> ids;
    for (const ObjectTrack* t : tracks)
      for (const TrackPoint& p : t->points)
        if (p.valid && p.frame == static_cast<int>(i)) ids.push_back(fb.CreateString(eoo_id(c, t->norad, p.frame)));
    const auto idv = fb.CreateVector(ids);
    const auto id = fb.CreateString(c.image_set + ":" + std::to_string(i));
    const auto sen = fb.CreateString(c.sensor_id);
    const double mid = f.t + c.dt, half = std::isfinite(c.exposure) ? 0.5 * c.exposure : 0.0;
    const auto t0 = fb.CreateString(iso_utc(mid - half, 6)), t1 = fb.CreateString(iso_utc(mid + half, 6));
    const auto set = fb.CreateString(c.image_set);
    const auto fname = fb.CreateString(i < names.size() ? names[i] : "");
    double ra, dec;
    unit_to_radec(f.wcs.pixel_to_sky(f.width / 2.0, f.height / 2.0), &ra, &dec);
    const auto desc = fb.CreateString(
        "plate solution (" + std::string(f.solve_method == 1 ? "blind" : "tracked from a neighboring frame") + ", TAN " +
        (f.wcs.order >= 2 ? "quadratic" : "linear") + "): center RA " + fmt(ra / kDeg, "%.5f") + " deg, Dec " + fmt(dec / kDeg, "%.5f") +
        " deg, scale " + fmt(f.wcs.pixel_scale() / kArcsec, "%.4f") + " arcsec/px; " + std::to_string(f.fit.used) + " stars, " +
        std::to_string(f.fit.outliers) + " outliers; residual median " + fmt(f.fit.median_arcsec, "%.2f") + " arcsec, rms " +
        fmt(f.fit.rms_arcsec, "%.2f") + ", 90th percentile " + fmt(f.fit.p90_arcsec, "%.2f") + "; reduced chi-square " +
        fmt(f.fit.reduced_chi2, "%.2f") + (std::isfinite(f.zero_point) ? "; G zero point " + fmt(f.zero_point, "%.2f") : ""));
    SKIBuilder b(fb);
    b.add_ID(id);
    b.add_ID_SENSOR(sen);
    b.add_SENLAT(c.site.lat / kDeg);
    b.add_SENLON(c.site.lon / kDeg);
    b.add_SENALT(c.site.h / 1000.0);
    b.add_IMAGE_TYPE(imageCategory::VISIBLE);
    b.add_EXP_START_TIME(t0);
    b.add_EXP_END_TIME(t1);
    b.add_IMAGE_SET_ID(set);
    b.add_IMAGE_SET_LENGTH(uint16_t(c.frames));
    b.add_SEQUENCE_ID(uint16_t(i));
    b.add_FRAME_FOVWIDTH(f.width * f.wcs.pixel_scale() / kDeg);
    b.add_FRAME_FOVHEIGHT(f.height * f.wcs.pixel_scale() / kDeg);
    b.add_PIXEL_FOVWIDTH(f.wcs.pixel_scale() / kDeg);
    b.add_PIXEL_FOVHEIGHT(f.wcs.pixel_scale() / kDeg);
    b.add_FRAME_WIDTH_PIXELS(uint16_t(f.width));
    b.add_FRAME_HEIGHT_PIXELS(uint16_t(f.height));
    b.add_FILENAME(fname);
    b.add_DESCRIPTION(desc);
    b.add_EO_OBSERVATIONS(idv);
    FinishSizePrefixedSKIBuffer(fb, b.Finish());
    out.insert(out.end(), fb.GetBufferPointer(), fb.GetBufferPointer() + fb.GetSize());
  }
  return out;
}

inline std::vector<double> lower21(const std::vector<double>& m) {
  std::vector<double> l;
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j <= i; ++j) l.push_back(m[i * 6 + j]);
  return l;
}

// The orbit of one target: its GCRF state at the arc's middle and the total
// covariance (noise, prior and the calibration as consider parameters),
// with the fit's statistics and the checks as user-defined parameters.
inline std::vector<uint8_t> ocm(const Context& c, const ObjectTrack& t, const OdResult& od, const std::vector<std::pair<std::string, std::string>>& params,
                                const std::string& prior_label) {
  flatbuffers::FlatBufferBuilder fb(4096);
  const auto vers = fb.CreateString("3.0"), cre = fb.CreateString(c.creation), org = fb.CreateString(c.originator);
  const auto msg = fb.CreateString("OD:" + c.image_set + ":" + std::to_string(t.norad));
  HeaderBuilder hb(fb);
  hb.add_CCSDS_OCM_VERS(vers);
  hb.add_CREATION_DATE(cre);
  hb.add_ORIGINATOR(org);
  hb.add_MESSAGE_ID(msg);
  const auto head = hb.Finish();
  std::vector<StrOff> com{fb.CreateString("Angles-only orbit of " + object_label(t) + " from " + std::to_string(od.used) +
                                          " observations: Gooding initial orbit, then batch least squares with the a priori element set (" +
                                          prior_label + "); covariance with the site and timing as consider parameters.")};
  const auto comv = fb.CreateVector(com);
  const auto name = fb.CreateString(t.name), intl = fb.CreateString(t.object_id), des = fb.CreateString(std::to_string(t.norad));
  const auto ts = fb.CreateString("UTC"), t0 = fb.CreateString(iso_utc(od.t0, 6));
  MetadataBuilder mb(fb);
  mb.add_COMMENT(comv);
  mb.add_OBJECT_NAME(name);
  mb.add_INTERNATIONAL_DESIGNATOR(intl);
  mb.add_OBJECT_DESIGNATOR(des);
  mb.add_TIME_SYSTEM(ts);
  mb.add_START_TIME(t0);
  mb.add_STOP_TIME(t0);
  const auto meta = mb.Finish();
  const std::vector<double> state(od.x, od.x + 6);
  const auto sd = fb.CreateVector(state);
  const auto cov = fb.CreateVector(lower21(od.cov_total));
  const auto epochs = fb.CreateVector(std::vector<StrOff>{fb.CreateString(iso_utc(od.t0, 6))});
  const auto center = fb.CreateString("EARTH");
  const auto frame = celestial(fb, CelestialFrame::GCRF, "GCRF");
  const auto cframe = celestial(fb, CelestialFrame::GCRF, "GCRF");
  const auto ctype = fb.CreateString("CARTPV");
  const auto cunits = fb.CreateVector(std::vector<StrOff>{fb.CreateString("km**2"), fb.CreateString("km**2/s"), fb.CreateString("km**2/s**2")});
  std::vector<flatbuffers::Offset<UserDefinedParameters>> up;
  for (const auto& kv : params) {
    const auto k = fb.CreateString(kv.first), v = fb.CreateString(kv.second);
    up.push_back(CreateUserDefinedParameters(fb, k, v));
  }
  const auto upv = fb.CreateVector(up);
  const auto odid = fb.CreateString("OD:" + std::to_string(t.norad) + ":" + iso_utc(od.t0, 3));
  const auto alg = fb.CreateString("Gooding angles-only initial orbit; weighted batch least squares with a priori information");
  const auto meth = fb.CreateString("BWLS");
  const auto ep = fb.CreateString(iso_utc(od.t0, 6));
  const auto otype = fb.CreateVector(std::vector<StrOff>{fb.CreateString("RADEC")});
  const auto est = fb.CreateVector(std::vector<StrOff>{fb.CreateString("X"), fb.CreateString("Y"), fb.CreateString("Z"),
                                                       fb.CreateString("X_DOT"), fb.CreateString("Y_DOT"), fb.CreateString("Z_DOT")});
  const auto apr = fb.CreateString(prior_label);
  const auto cons = fb.CreateString("site latitude, longitude, height; time bias");
  const auto sens = fb.CreateString(c.sensor_id);
  OrbitDeterminationBuilder ob(fb);
  ob.add_OD_ID(odid);
  ob.add_OD_ALGORITHM(alg);
  ob.add_OD_METHOD(meth);
  ob.add_OD_EPOCH(ep);
  ob.add_OD_OBSERVATIONS_TYPE(otype);
  ob.add_OD_OBSERVATIONS_USED(od.used);
  ob.add_OD_TRACKS_USED(1);
  ob.add_OD_EST_PARAMETERS(est);
  ob.add_OD_APRIORI_DATA(apr);
  ob.add_OD_ESTIMATOR(estimatorCategory::BatchLeastSquares);
  ob.add_OD_RESIDUAL_RMS(od.rms_arcsec);
  ob.add_WEIGHTED_RMS(std::sqrt(od.chi2 / std::max(1, od.dof)));
  ob.add_SOLVE_N(6);
  ob.add_CONSIDER_N(4);
  ob.add_CONSIDER_PARAMS(cons);
  ob.add_SENSORS_N(1);
  ob.add_SENSORS(sens);
  const auto odb = ob.Finish();
  OCMBuilder b(fb);
  b.add_HEADER(head);
  b.add_METADATA(meta);
  b.add_TRAJ_TYPE(trajectoryType::CARTESIAN_PV);
  b.add_STATE_VECTOR_SIZE(6);
  b.add_STATE_DATA(sd);
  b.add_STATE_EPOCHS(epochs);
  b.add_COVARIANCE_DATA(cov);
  b.add_COV_TYPE(ctype);
  b.add_COV_ORDERING(covarianceOrdering::LTM);
  b.add_COV_SIZE(6);
  b.add_COV_UNITS(cunits);
  b.add_COV_REF_FRAME(cframe);
  b.add_ORBIT_DETERMINATION(odb);
  b.add_USER_DEFINED_PARAMETERS(upv);
  b.add_CENTER_NAME(center);
  b.add_TRAJ_REF_FRAME(frame);
  FinishSizePrefixedOCMBuffer(fb, b.Finish());
  return std::vector<uint8_t>(fb.GetBufferPointer(), fb.GetBufferPointer() + fb.GetSize());
}

// The orbit's trajectory, one plain $OEM: GCRF, UTC, km and km/s.
inline std::vector<uint8_t> oem(const Context& c, const ObjectTrack& t, const std::vector<double>& times, const std::vector<std::array<double, 6>>& states,
                                const std::string& comment) {
  flatbuffers::FlatBufferBuilder fb(1024 + times.size() * 120);
  std::vector<flatbuffers::Offset<ephemerisDataLine>> lines;
  for (size_t i = 0; i < times.size(); ++i) {
    const auto e = fb.CreateString(iso_utc(times[i], 6));
    const auto& s = states[i];
    ephemerisDataLineBuilder lb(fb);
    lb.add_EPOCH(e);
    lb.add_X(s[0]); lb.add_Y(s[1]); lb.add_Z(s[2]);
    lb.add_X_DOT(s[3]); lb.add_Y_DOT(s[4]); lb.add_Z_DOT(s[5]);
    lines.push_back(lb.Finish());
  }
  const auto lv = fb.CreateVector(lines);
  const auto oid = fb.CreateString(t.object_id.empty() ? std::to_string(t.norad) : t.object_id);
  const auto oname = fb.CreateString(t.name);
  CATBuilder cb(fb);
  cb.add_OBJECT_ID(oid);
  cb.add_OBJECT_NAME(oname);
  cb.add_NORAD_CAT_ID(t.norad);
  const auto cat = cb.Finish();
  const auto com = fb.CreateString(comment);
  const auto center = fb.CreateString("EARTH");
  const auto frame = celestial(fb, CelestialFrame::GCRF, "GCRF");
  const auto t0 = fb.CreateString(iso_utc(times.front(), 6)), t1 = fb.CreateString(iso_utc(times.back(), 6));
  const auto interp = fb.CreateString("HERMITE");
  ephemerisDataBlockBuilder bb(fb);
  bb.add_COMMENT(com);
  bb.add_OBJECT(cat);
  bb.add_CENTER_NAME(center);
  bb.add_REFERENCE_FRAME(frame);
  bb.add_TIME_SYSTEM(timingStandard::UTC);
  bb.add_START_TIME(t0);
  bb.add_USEABLE_START_TIME(t0);
  bb.add_USEABLE_STOP_TIME(t1);
  bb.add_STOP_TIME(t1);
  bb.add_INTERPOLATION(interp);
  bb.add_INTERPOLATION_DEGREE(3);
  bb.add_STATE_VECTOR_SIZE(6);
  bb.add_EPHEMERIS_DATA_LINES(lv);
  const auto block = bb.Finish();
  const auto blocks = fb.CreateVector(std::vector<flatbuffers::Offset<ephemerisDataBlock>>{block});
  const auto cre = fb.CreateString(c.creation), org = fb.CreateString(c.originator);
  OEMBuilder b(fb);
  b.add_CCSDS_OEM_VERS(3.0);
  b.add_CREATION_DATE(cre);
  b.add_ORIGINATOR(org);
  b.add_EPHEMERIS_DATA_BLOCK(blocks);
  FinishOEMBuffer(fb, b.Finish());
  return std::vector<uint8_t>(fb.GetBufferPointer(), fb.GetBufferPointer() + fb.GetSize());
}

}  // namespace rec
}  // namespace oa
