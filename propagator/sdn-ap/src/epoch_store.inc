// -----------------------------------------------------------------------------
// The epoch store (SPEC 14): many element sets per object over a window of days, the set that answers a request time
// chosen by index, and a blend across each handover so the state stays continuous.
// - `load_epochs` replaces the store with a snapshot: 'omm' frames of size-prefixed $OMM records end to end (the
//   element-sync module's output; a frame of one plain or size-prefixed record also reads), with the $PCF
//   EPOCH_STORE table (SDS 1.270.0). A series is one (NORAD_CAT_ID, OBJECT_ID, theory, ORIGINATOR); its sets are kept by
//   epoch: CACHE_DAYS back from the newest epoch of the load (not the wall clock: the store depends on its input
//   alone), at most MAX_SETS_PER_OBJECT (the newest), THEORIES (empty: SGP4 and SGP4XP). Sets not centered on the Earth
//   are counted and not stored.
// - Selection (SELECTION): NEAREST, the set whose epoch is nearest the request (the switch between consecutive sets at
//   their midpoint), or LATEST_BEFORE, the latest set at or before it (the switch at the later set's epoch; before the
//   first set, the first). O(log n) per series.
// - Blend (BLEND_WINDOW_SECONDS, BLEND_SHAPE): across a window centered on each switch time, half-width
//   min(BLEND_WINDOW_SECONDS / 2, half of each adjacent spacing), the two sets' propagated states are combined.
//   SMOOTHSTEP: w = 3 s^2 - 2 s^3 over the window, r = (1 - w) r_a + w r_b, v = (1 - w) v_a + w v_b + w' (r_b - r_a), so
//   r and v are continuous (w' = 0 at both edges). HERMITE: set a's state plus a cubic Hermite correction that is zero
//   with a zero rate at the window's start and reaches set b's position and velocity at its end. Covariance: the two-component mixture (1 - w) P_a + w P_b + w (1 - w) d d^T
//   (d = x_b - x_a; the smoothstep weight for both shapes), for sets that carry COVARIANCE (SPEC 12).
// - Calls: the resident exports sdnap_epochs_* over the loaded store, and `propagate_epochs`, the same on a grid for a
//   snapshot given with the call (stateless).
// -----------------------------------------------------------------------------

namespace sdnap {
namespace epochs {

struct Config {
  double cache_days = 7.0;
  uint32_t max_sets = 0;
  int selection = 0;          ///< 0 NEAREST, 1 LATEST_BEFORE
  double blend_seconds = 3600.0;
  int shape = 0;              ///< 0 SMOOTHSTEP, 1 HERMITE
  uint32_t theories = 0;      ///< bit per pcfTheory (SGP4 1, SGP4XP 2); 0: both
};

/// One kept set: the row and its covariance when the record carries one.
struct Entry {
  ElementRow row;
  double epoch;               ///< minutes from J2000 (JD 2451545.0), UTC
  cov::Set* cov = nullptr;
};

/// An initialized record of one set (the lazy cache: two per series).
struct Slot {
  int32_t index = -1;         ///< the series' set index held, -1 none
  xpt::XpSat* xp = nullptr;
  Sat* sat = nullptr;
  double* nodes = nullptr;
  cov::Propagator* cp = nullptr;
  int32_t error = 0;
};

struct Series {
  uint32_t norad = 0;
  std::string object_id, originator, name;
  int32_t theory = 0;
  uint32_t first = 0, count = 0;  ///< into Store::entries, by epoch
  Slot slots[2];
  uint32_t next = 0;              ///< the slot replaced next
};

struct Stats {
  double records = 0, kept = 0, aged = 0, capped = 0, theory = 0, other_center = 0, duplicate = 0;
};

struct Store {
  Config cfg;
  std::vector<Entry> entries;
  std::vector<Series> series;
  Stats stats;
};

inline void release(Slot& s) {
  if (s.xp != nullptr) xpt::xp_release(*s.xp);
  std::free(s.xp);
  std::free(s.sat);
  std::free(s.nodes);
  delete s.cp;
  s = Slot{};
}

inline void clear(Store& st) {
  for (Series& s : st.series)
    for (Slot& q : s.slots) release(q);
  for (Entry& e : st.entries) delete e.cov;
  st.entries.clear();
  st.series.clear();
  st.stats = Stats{};
}

inline Store& resident() {
  static Store s;
  return s;
}

inline double minutes_of(double whole, double frac) { return ((whole - 2451545.0) + frac) * kMinutesPerDay; }

/// The EPOCH_STORE table of the call's $PCF (pcf::read has verified the record). 0, or 3 with a named refusal.
inline int read_config(Config& c) {
  c = Config{};
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f == nullptr || f->port_id == nullptr || std::strcmp(f->port_id, "configuration") != 0) continue;
    const uint8_t* p = f->payload;
    size_t len = f->payload_length;
    flatbuffers::Verifier v(p, len);
    if (!VerifyPCFBuffer(v)) { p += 4; len -= 4; }
    const PCFEpochStore* t = GetPCF(p)->EPOCH_STORE();
    if (t == nullptr) return 0;
    c.cache_days = t->CACHE_DAYS();
    c.max_sets = t->MAX_SETS_PER_OBJECT();
    c.selection = t->SELECTION();
    c.blend_seconds = t->BLEND_WINDOW_SECONDS();
    c.shape = t->BLEND_SHAPE();
    if (!(c.cache_days > 0.0) || !std::isfinite(c.cache_days)) return pcf::refuse("EPOCH_STORE.CACHE_DAYS", "a positive number of days");
    if (c.selection != pcfEpochSelection_NEAREST && c.selection != pcfEpochSelection_LATEST_BEFORE)
      return pcf::refuse("EPOCH_STORE.SELECTION", "NEAREST or LATEST_BEFORE");
    if (!(c.blend_seconds >= 0.0) || !std::isfinite(c.blend_seconds)) return pcf::refuse("EPOCH_STORE.BLEND_WINDOW_SECONDS", "zero or a positive number of seconds");
    if (c.shape != pcfBlendShape_SMOOTHSTEP && c.shape != pcfBlendShape_HERMITE) return pcf::refuse("EPOCH_STORE.BLEND_SHAPE", "SMOOTHSTEP or HERMITE");
    if (const auto* th = t->THEORIES()) {
      for (uint32_t k = 0; k < th->size(); ++k) {
        const int v8 = th->Get(k);
        if (v8 == pcfTheory_SGP4) c.theories |= 1;
        else if (v8 == pcfTheory_SGP4XP) c.theories |= 2;
        else return pcf::refuse("EPOCH_STORE.THEORIES", "SGP4 and SGP4XP sets are stored");
      }
    }
    return 0;
  }
  return 0;
}

inline uint32_t theory_bit(int32_t theory) { return theory == kTheorySgp4 ? 1u : 2u; }

/// One record of a snapshot, decoded. 1 kept, 0 skipped (not centered on the Earth), -1 not a decodable $OMM.
struct Record {
  ElementRow row{};
  uint32_t norad = 0;
  std::string object_id, originator, name;
  cov::Set* cov = nullptr;
};
inline int decode_record(const uint8_t* p, uint32_t n, Record& r) {
  r = Record{};
  if (!omm::decode(p, n, r.row)) return omm::center_refused() ? 0 : -1;
  const uint8_t* q = p;
  uint32_t m = n;
  if (!plain_view(q, m, "$OMM")) return -1;
  flatbuffers::Verifier::Options vopt;
  vopt.check_alignment = false;  // a record cut from a size-prefixed stream is aligned to its prefix, not to its own start
  flatbuffers::Verifier ver(q, m, vopt);
  if (!VerifyOMMBuffer(ver)) return -1;
  const OMM* o = GetOMM(q);
  r.norad = o->NORAD_CAT_ID();
  if (o->OBJECT_ID() != nullptr) r.object_id = o->OBJECT_ID()->str();
  if (o->ORIGINATOR() != nullptr) r.originator = o->ORIGINATOR()->str();
  if (o->OBJECT_NAME() != nullptr) r.name = o->OBJECT_NAME()->str();
  if (r.row.theory != kTheorySgp4) {
    cov::Set s;
    const int cr = cov::read(p, n, r.row, s);
    if (cr < 0) return -1;
    if (cr == 1) r.cov = new cov::Set(s);
  }
  return 1;
}

/// Calls `fn(p, n)` for each record of a frame: size-prefixed records end to end, or one plain record. False when the
/// frame is neither.
template <class Fn>
inline bool each_record(const uint8_t* p, uint32_t n, Fn fn) {
  if (n >= 8 && std::memcmp(p + 4, "$OMM", 4) == 0) return fn(p, n);
  for (uint32_t off = 0; off < n;) {
    if (n - off < 12) return false;
    uint32_t len;
    std::memcpy(&len, p + off, 4);
    if (len > n - off - 4 || std::memcmp(p + off + 8, "$OMM", 4) != 0) return false;
    if (!fn(p + off, len + 4)) return false;
    off += 4 + len;
  }
  return true;
}

/// Builds `st` from the call's 'omm' frames under `cfg`. 0, or 3 with a named error.
inline int build(Store& st, const Config& cfg) {
  clear(st);
  st.cfg = cfg;
  std::vector<Record> recs;
  bool bad = false;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f == nullptr || f->port_id == nullptr || std::strcmp(f->port_id, "omm") != 0) continue;
    const bool ok = each_record(f->payload, f->payload_length, [&](const uint8_t* p, uint32_t n) {
      Record r;
      const int d = decode_record(p, n, r);
      ++st.stats.records;
      if (d < 0) { bad = true; return false; }
      if (d == 0) { ++st.stats.other_center; return true; }
      if (cfg.theories != 0 && (cfg.theories & theory_bit(r.row.theory)) == 0) { ++st.stats.theory; delete r.cov; return true; }
      recs.push_back(std::move(r));
      return true;
    });
    if (!ok || bad) {
      for (Record& r : recs) delete r.cov;
      plugin_set_error("invalid-omm", "An 'omm' frame is neither size-prefixed $OMM records end to end nor one $OMM record of an SGP4 or SGP4XP set.");
      return 3;
    }
  }
  // the series: (NORAD, OBJECT_ID, theory, ORIGINATOR), each by epoch (a later record of the same epoch replaces)
  std::vector<uint32_t> order(recs.size());
  for (uint32_t k = 0; k < order.size(); ++k) order[k] = k;
  auto epoch_of = [&](const Record& r) { return minutes_of(r.row.epoch_jd_whole, r.row.epoch_jd_frac); };
  std::stable_sort(order.begin(), order.end(), [&](uint32_t a, uint32_t b) {
    const Record &x = recs[a], &y = recs[b];
    if (x.norad != y.norad) return x.norad < y.norad;
    if (x.object_id != y.object_id) return x.object_id < y.object_id;
    if (x.row.theory != y.row.theory) return x.row.theory < y.row.theory;
    if (x.originator != y.originator) return x.originator < y.originator;
    return epoch_of(x) < epoch_of(y);
  });
  double newest = -HUGE_VAL;
  for (const Record& r : recs) newest = std::fmax(newest, epoch_of(r));
  const double oldest_kept = newest - cfg.cache_days * kMinutesPerDay;
  for (uint32_t k = 0; k < order.size();) {
    uint32_t e = k;
    const Record& head = recs[order[k]];
    while (e < order.size() && recs[order[e]].norad == head.norad && recs[order[e]].object_id == head.object_id &&
           recs[order[e]].row.theory == head.row.theory && recs[order[e]].originator == head.originator)
      ++e;
    std::vector<uint32_t> keep;
    for (uint32_t q = k; q < e; ++q) {
      Record& r = recs[order[q]];
      if (epoch_of(r) < oldest_kept) { ++st.stats.aged; delete r.cov; r.cov = nullptr; continue; }
      if (!keep.empty() && epoch_of(recs[keep.back()]) == epoch_of(r)) {
        ++st.stats.duplicate;
        delete recs[keep.back()].cov;
        recs[keep.back()].cov = nullptr;
        keep.back() = order[q];
        continue;
      }
      keep.push_back(order[q]);
    }
    if (cfg.max_sets > 0 && keep.size() > cfg.max_sets) {
      const size_t drop = keep.size() - cfg.max_sets;
      for (size_t q = 0; q < drop; ++q) { delete recs[keep[q]].cov; recs[keep[q]].cov = nullptr; }
      st.stats.capped += static_cast<double>(drop);
      keep.erase(keep.begin(), keep.begin() + static_cast<std::ptrdiff_t>(drop));
    }
    if (!keep.empty()) {
      Series s;
      s.norad = head.norad;
      s.object_id = head.object_id;
      s.originator = head.originator;
      s.theory = head.row.theory;
      s.name = recs[keep.back()].name;
      s.first = static_cast<uint32_t>(st.entries.size());
      s.count = static_cast<uint32_t>(keep.size());
      for (uint32_t q : keep) {
        Entry en;
        en.row = recs[q].row;
        en.epoch = epoch_of(recs[q]);
        en.cov = recs[q].cov;
        recs[q].cov = nullptr;
        st.entries.push_back(en);
      }
      st.series.push_back(std::move(s));
    }
    k = e;
  }
  st.stats.kept = static_cast<double>(st.entries.size());
  return 0;
}

/// The slot holding set `k` of series `s`, initialized on first use (the older of the two slots replaced).
inline Slot& slot_of(Store& st, Series& s, uint32_t k, bool with_cov) {
  for (Slot& q : s.slots)
    if (q.index == static_cast<int32_t>(k)) {
      if (with_cov && q.cp == nullptr && st.entries[s.first + k].cov != nullptr && q.error == 0) {
        q.cp = new cov::Propagator();
        if (cov::prepare(*st.entries[s.first + k].cov, *q.cp) != 0) { delete q.cp; q.cp = nullptr; }
      }
      return q;
    }
  Slot& q = s.slots[s.next];
  s.next ^= 1u;
  release(q);
  q.index = static_cast<int32_t>(k);
  const Entry& en = st.entries[s.first + k];
  const Elements e = elements_of(en.row);
  if (en.row.theory == kTheorySgp4Xp) {
    drag::table();
    q.xp = static_cast<xpt::XpSat*>(std::calloc(1, sizeof(xpt::XpSat)));
    q.error = q.xp == nullptr ? kPropRefused : xpt::xp_init(e, *q.xp);
  } else {
    q.sat = static_cast<Sat*>(std::calloc(1, sizeof(Sat)));
    q.error = q.sat == nullptr ? kPropRefused : sat_init(e, gravity_wgs72(), *q.sat);
    if (q.error == kPropOk && q.sat->deep.iresfl != 0) {
      q.nodes = static_cast<double*>(std::malloc(sizeof(double) * 4u * kCheckpointNodes));
      if (q.nodes != nullptr) {
        q.sat->checkpoint_count = kCheckpointNodes;
        fill_checkpoints(*q.sat, q.nodes, kCheckpointNodes);
      }
    }
  }
  if (with_cov && q.error == kPropOk && en.cov != nullptr) {
    q.cp = new cov::Propagator();
    if (cov::prepare(*en.cov, *q.cp) != 0) { delete q.cp; q.cp = nullptr; }
  }
  return q;
}

/// Set k of series s at t (minutes from J2000): TEME state, and the covariance when `P` is given (false: none).
inline int32_t state_of(Store& st, Series& s, uint32_t k, double t, double* r, double* v, double* P, bool& have_p) {
  Slot& q = slot_of(st, s, k, P != nullptr);
  have_p = false;
  if (q.error != 0) return q.error;
  const double dt = t - st.entries[s.first + k].epoch;
  const int32_t e = q.xp != nullptr ? xpt::xp_propagate(*q.xp, dt, r, v) : sat_propagate(*q.sat, q.nodes, dt, r, v);
  if (e != kPropOk) return e;
  if (P != nullptr && q.cp != nullptr) {
    double rr[3], vv[3];
    have_p = cov::eval(*q.cp, dt, rr, vv, P);
  }
  return kPropOk;
}

/// The selection at t: sets a (and b, the next, with weight w and the window when blending; b = -1 otherwise).
struct Choice {
  int32_t a = 0, b = -1;
  double t0 = 0, t1 = 0;      ///< the blend window
};
inline Choice choose(const Store& st, const Series& s, double t) {
  Choice c;
  const Entry* E = st.entries.data() + s.first;
  const uint32_t n = s.count;
  if (n == 1) return c;
  // k = the first set with epoch > t
  uint32_t lo = 0, hi = n;
  while (lo < hi) { const uint32_t mid = (lo + hi) >> 1; if (E[mid].epoch <= t) lo = mid + 1; else hi = mid; }
  const uint32_t k = lo;
  auto switch_time = [&](uint32_t i) { return st.cfg.selection == 0 ? 0.5 * (E[i].epoch + E[i + 1].epoch) : E[i + 1].epoch; };
  auto half_width = [&](uint32_t i) {
    double h = st.cfg.blend_seconds / 120.0;  // minutes
    if (st.cfg.selection == 0) h = std::fmin(h, 0.5 * (E[i + 1].epoch - E[i].epoch));
    else {
      if (i + 2 < n) h = std::fmin(h, 0.5 * (E[i + 2].epoch - E[i + 1].epoch));
      h = std::fmin(h, 0.5 * (E[i + 1].epoch - E[i].epoch));
    }
    return h;
  };
  // the set chosen without a blend
  int32_t j;
  if (st.cfg.selection == 0) {
    if (k == 0) j = 0;
    else if (k == n) j = static_cast<int32_t>(n - 1);
    else j = (t - E[k - 1].epoch) < (E[k].epoch - t) ? static_cast<int32_t>(k - 1) : static_cast<int32_t>(k);
  } else {
    j = k == 0 ? 0 : static_cast<int32_t>(k - 1);
  }
  c.a = j;
  if (!(st.cfg.blend_seconds > 0.0)) return c;
  // the switch nearest t: between j - 1 and j, or j and j + 1
  for (int32_t i = j - 1; i <= j; ++i) {
    if (i < 0 || i + 1 >= static_cast<int32_t>(n)) continue;
    const double tau = switch_time(static_cast<uint32_t>(i)), h = half_width(static_cast<uint32_t>(i));
    if (h > 0.0 && t > tau - h && t < tau + h) {
      c.a = i;
      c.b = i + 1;
      c.t0 = tau - h;
      c.t1 = tau + h;
      return c;
    }
  }
  return c;
}

/// Series s at t (minutes from J2000): the TEME state (km, km/s) and, when P is given, the covariance (have_p false
/// when the sets carry none). 0, or the theory's error code.
inline int32_t at(Store& st, Series& s, double t, double* r, double* v, double* P, bool& have_p) {
  const Choice c = choose(st, s, t);
  if (c.b < 0) return state_of(st, s, static_cast<uint32_t>(c.a), t, r, v, P, have_p);
  double ra[3], va[3], rb[3], vb[3], Pa[36], Pb[36];
  bool ha = false, hb = false;
  const double sfrac = (t - c.t0) / (c.t1 - c.t0);
  const double w = sfrac * sfrac * (3.0 - 2.0 * sfrac);
  if (st.cfg.shape == 0) {
    if (const int32_t e = state_of(st, s, static_cast<uint32_t>(c.a), t, ra, va, P != nullptr ? Pa : nullptr, ha)) return e;
    if (const int32_t e = state_of(st, s, static_cast<uint32_t>(c.b), t, rb, vb, P != nullptr ? Pb : nullptr, hb)) return e;
    const double wdot = 6.0 * sfrac * (1.0 - sfrac) / ((c.t1 - c.t0) * 60.0);  // per second
    for (int i = 0; i < 3; ++i) {
      r[i] = (1.0 - w) * ra[i] + w * rb[i];
      v[i] = (1.0 - w) * va[i] + w * vb[i] + wdot * (rb[i] - ra[i]);
    }
  } else {
    // set a plus a cubic Hermite correction c(t): c(t0) = 0, c'(t0) = 0, c(t1) = x_b(t1) - x_a(t1), c'(t1) = v_b(t1) - v_a(t1),
    // so the state leaves set a with its position and velocity and arrives on set b with its own, following the orbit
    double r1a[3], v1a[3], r1b[3], v1b[3];
    bool hd;
    if (const int32_t e = state_of(st, s, static_cast<uint32_t>(c.a), t, ra, va, P != nullptr ? Pa : nullptr, ha)) return e;
    if (const int32_t e = state_of(st, s, static_cast<uint32_t>(c.a), c.t1, r1a, v1a, nullptr, hd)) return e;
    if (const int32_t e = state_of(st, s, static_cast<uint32_t>(c.b), c.t1, r1b, v1b, nullptr, hd)) return e;
    const double T = (c.t1 - c.t0) * 60.0, uu = sfrac;  // seconds
    const double h01 = uu * uu * (3.0 - 2.0 * uu), h11 = uu * uu * (uu - 1.0);
    const double d01 = 6.0 * uu * (1.0 - uu) / T, d11 = uu * (3.0 * uu - 2.0);
    for (int i = 0; i < 3; ++i) {
      const double d = r1b[i] - r1a[i], dv = v1b[i] - v1a[i];
      r[i] = ra[i] + h01 * d + h11 * T * dv;
      v[i] = va[i] + d01 * d + d11 * dv;
    }
    if (P != nullptr)
      if (const int32_t e = state_of(st, s, static_cast<uint32_t>(c.b), t, rb, vb, Pb, hb)) return e;
  }
  have_p = false;
  if (P != nullptr && ha && hb) {
    const double d[6] = {rb[0] - ra[0], rb[1] - ra[1], rb[2] - ra[2], vb[0] - va[0], vb[1] - va[1], vb[2] - va[2]};
    for (int i = 0; i < 6; ++i)
      for (int j = 0; j < 6; ++j) P[i * 6 + j] = (1.0 - w) * Pa[i * 6 + j] + w * Pb[i * 6 + j] + w * (1.0 - w) * d[i] * d[j];
    have_p = true;
  }
  return kPropOk;
}

inline uint64_t bytes_of(const Store& st) {
  uint64_t b = st.entries.size() * sizeof(Entry) + st.series.size() * sizeof(Series);
  for (const Entry& e : st.entries) b += e.cov != nullptr ? sizeof(cov::Set) : 0;
  for (const Series& s : st.series) {
    b += s.object_id.capacity() + s.originator.capacity() + s.name.capacity();
    for (const Slot& q : s.slots) b += (q.xp ? sizeof(xpt::XpSat) : 0) + (q.sat ? sizeof(Sat) : 0) + (q.nodes ? 32u * kCheckpointNodes : 0) + (q.cp ? sizeof(cov::Propagator) : 0);
  }
  return b;
}

}  // namespace epochs
}  // namespace sdnap

/// `load_epochs`: replaces the resident store with the call's snapshot (SPEC 14).
extern "C" int load_epochs(void) {
  using namespace sdnap;
  plugin_reset_output_state();
  if (const int rc = pcf::read(pcf::kEpochs)) return rc;
  epochs::Config cfg;
  if (const int rc = epochs::read_config(cfg)) return rc;
  return epochs::build(epochs::resident(), cfg);
}

/// `propagate_epochs`: the store of the call's own snapshot on the call's grid ('grid' $OEM, as propagate reads it):
/// one $OEM per series, the blended TEME / GCRF / EME2000 states and, for series whose sets carry COVARIANCE, a
/// covariance line per state.
extern "C" int propagate_epochs(void) {
  using namespace sdnap;
  plugin_reset_output_state();
  if (const int rc = pcf::read(pcf::kEpochs)) return rc;
  epochs::Config cfg;
  if (const int rc = epochs::read_config(cfg)) return rc;
  epochs::Store st;
  struct Scope { epochs::Store& s; ~Scope() { epochs::clear(s); } } scope{st};
  if (const int rc = epochs::build(st, cfg)) return rc;
  if (st.series.empty()) { plugin_set_error("missing-omm", "propagate_epochs keeps no set of the 'omm' snapshot."); return 3; }
  std::vector<oem::Grid> grids;
  if (const int rc = oem::read_grids(grids)) return rc;
  if (grids.empty()) {
    plugin_set_error("missing-grid", "propagate_epochs takes a 'grid' $OEM (explicit EPOCHs or START_TIME / STOP_TIME / STEP_SIZE).");
    return 3;
  }
  size_t budget = pcf::options().maximum_states;
  char text[48], start[48], stop[48], why[200];
  for (epochs::Series& s : st.series) {
    flatbuffers::FlatBufferBuilder fbb(1 << 16);
    std::vector<flatbuffers::Offset<ephemerisDataBlock>> blocks;
    for (const oem::Grid& g : grids) {
      std::vector<double> tw, tf;
      if (g.explicit_times) { tw = g.whole; tf = g.frac; }
      else {
        if (!g.has_start || !g.has_stop) { plugin_set_error("bad-grid", "A propagate_epochs grid names its START_TIME and STOP_TIME (or explicit EPOCHs)."); return 3; }
        const double span = ((g.stop_w - g.start_w) + (g.stop_f - g.start_f)) * 86400.0;
        if (!(span >= 0.0) || !(g.step > 0.0)) { plugin_set_error("bad-grid", "The grid's span or step is not positive."); return 3; }
        const double cnt = std::floor(span / g.step + 1e-9) + 1.0;
        if (cnt > static_cast<double>(budget)) { plugin_set_error("too-many-states", "The request asks for more than OUTPUT.MAXIMUM_STATES states."); return 3; }
        for (size_t k = 0; k < static_cast<size_t>(cnt); ++k) { tw.push_back(g.start_w); tf.push_back(g.start_f + static_cast<double>(k) * g.step / 86400.0); }
      }
      if (tw.empty()) { plugin_set_error("bad-grid", "The grid holds no epochs."); return 3; }
      if (tw.size() > budget) { plugin_set_error("too-many-states", "The request asks for more than OUTPUT.MAXIMUM_STATES states."); return 3; }
      budget -= tw.size();
      std::vector<flatbuffers::Offset<ephemerisDataLine>> lines;
      std::vector<flatbuffers::Offset<covarianceMatrixLine>> cov_lines;
      double bias[3][3];
      if (g.axes == oem::Axes::Eme2000) frames::frame_bias(bias);
      bool any_cov = false;
      for (size_t k = 0; k < tw.size(); ++k) {
        double r[3], v[3], P[36];
        bool have_p = false;
        const int32_t e = epochs::at(st, s, epochs::minutes_of(tw[k], tf[k]), r, v, P, have_p);
        oem::iso_text(tw[k], tf[k], 0.0, text, sizeof text);
        if (e != kPropOk) {
          std::snprintf(why, sizeof why, "NORAD %u does not propagate to %s (code %d).", s.norad, text, static_cast<int>(e));
          plugin_set_error("propagation-failed", why);
          return 3;
        }
        double axes[3][3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
        if (g.axes != oem::Axes::Teme) {
          double m[3][3];
          if (frames::gcrf_to_teme(tw[k], tf[k], m) < 0) { std::snprintf(why, sizeof why, "No GCRF axes at %s.", text); plugin_set_error("frame-failed", why); return 3; }
          for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j) {
              double a = 0.0;
              if (g.axes == oem::Axes::Eme2000) for (int q = 0; q < 3; ++q) a += bias[i][q] * m[j][q];
              else a = m[j][i];
              axes[i][j] = a;
            }
          double ro[3], vo[3];
          frames::apply(axes, r, ro);
          frames::apply(axes, v, vo);
          std::memcpy(r, ro, sizeof r);
          std::memcpy(v, vo, sizeof v);
        }
        lines.push_back(CreateephemerisDataLineDirect(fbb, text, r[0], r[1], r[2], v[0], v[1], v[2]));
        if (have_p) {
          any_cov = true;
          double C[36];
          for (int i = 0; i < 6; ++i)
            for (int j = 0; j < 6; ++j) {
              double a = 0.0;
              for (int p = 0; p < 3; ++p)
                for (int q = 0; q < 3; ++q) a += axes[i % 3][p] * P[((i / 3) * 3 + p) * 6 + (j / 3) * 3 + q] * axes[j % 3][q];
              C[i * 6 + j] = a;
            }
          auto c = [&](int i, int j) { return 0.5 * (C[i * 6 + j] + C[j * 6 + i]); };
          cov_lines.push_back(CreatecovarianceMatrixLineDirect(fbb, text, c(0, 0), c(1, 0), c(1, 1), c(2, 0), c(2, 1), c(2, 2), c(3, 0), c(3, 1), c(3, 2), c(3, 3),
                                                                c(4, 0), c(4, 1), c(4, 2), c(4, 3), c(4, 4), c(5, 0), c(5, 1), c(5, 2), c(5, 3), c(5, 4), c(5, 5)));
        }
      }
      if (any_cov && cov_lines.size() != lines.size()) cov_lines.clear();  // a covariance on every state or on none
      oem::iso_text(tw.front(), tf.front(), 0.0, start, sizeof start);
      oem::iso_text(tw.back(), tf.back(), 0.0, stop, sizeof stop);
      const auto frame = oem::rfm_of(fbb, g.axes);
      const bool with_cov = !cov_lines.empty();
      const auto cov_frame = with_cov ? oem::rfm_of(fbb, g.axes) : flatbuffers::Offset<RFM>(0);
      flatbuffers::Offset<CAT> object = 0;
      {
        const auto s_name = s.name.empty() ? 0 : fbb.CreateString(s.name);
        const auto s_id = s.object_id.empty() ? 0 : fbb.CreateString(s.object_id);
        CATBuilder cb(fbb);
        if (s.norad != 0) cb.add_NORAD_CAT_ID(s.norad);
        if (!s_name.IsNull()) cb.add_OBJECT_NAME(s_name);
        if (!s_id.IsNull()) cb.add_OBJECT_ID(s_id);
        object = cb.Finish();
      }
      blocks.push_back(CreateephemerisDataBlockDirect(fbb, nullptr, object, "EARTH", frame, nullptr, cov_frame, timingStandard_UTC, start, nullptr, nullptr,
                                                      stop, nullptr, 0, g.explicit_times ? 0.0 : g.step, 6, nullptr, &lines, with_cov ? &cov_lines : nullptr));
    }
    const auto root = CreateOEMDirect(fbb, nullptr, 3.0, nullptr, s.originator.empty() ? "SDN" : s.originator.c_str(), &blocks);
    FinishOEMBuffer(fbb, root);
    if (plugin_push_output("ephemeris", "OEM.fbs", "$OEM", fbb.GetBufferPointer(), fbb.GetSize()) < 0) {
      plugin_set_error("output-failed", "The $OEM could not be emitted.");
      return 3;
    }
  }
  return 0;
}

// ---- The resident store's exports ------------------------------------------------------------------------------------

/// Series in the resident store (load_epochs).
SDNAP_EXPORT("sdnap_epochs_count")
uint32_t sdnap_epochs_count(void) { return static_cast<uint32_t>(sdnap::epochs::resident().series.size()); }

/// The last load's counts, 8 doubles: records read, sets kept, dropped by CACHE_DAYS, by MAX_SETS_PER_OBJECT, by
/// THEORIES, sets not centered on the Earth skipped, same-epoch duplicates replaced, and the store's bytes.
SDNAP_EXPORT("sdnap_epochs_stats")
void sdnap_epochs_stats(double* out) {
  const auto& st = sdnap::epochs::resident();
  const auto& s = st.stats;
  const double v[8] = {s.records, s.kept, s.aged, s.capped, s.theory, s.other_center, s.duplicate, static_cast<double>(sdnap::epochs::bytes_of(st))};
  for (int k = 0; k < 8; ++k) out[k] = v[k];
}

/// Series i: out[0] NORAD_CAT_ID, [1] theory (sdnap::Theory), [2] sets, then the sets' epochs as split Julian dates
/// (2 doubles each) when `epochs` has room for `capacity` of them. 0, or -1 for an unknown series.
SDNAP_EXPORT("sdnap_epochs_series")
int32_t sdnap_epochs_series(uint32_t i, double* out, double* epochs, uint32_t capacity) {
  auto& st = sdnap::epochs::resident();
  if (i >= st.series.size() || out == nullptr) return -1;
  const auto& s = st.series[i];
  out[0] = s.norad;
  out[1] = s.theory;
  out[2] = s.count;
  for (uint32_t k = 0; epochs != nullptr && k < s.count && k < capacity; ++k) {
    const double m = st.entries[s.first + k].epoch / sdnap::kMinutesPerDay;
    const double whole = std::floor(m + 0.5) - 0.5;  // the integer + 0.5 part from J2000's
    epochs[2 * k] = 2451545.0 + whole;
    epochs[2 * k + 1] = m - whole;
  }
  return 0;
}

/// The selection of series i at a split Julian date: out[0] set a, out[1] set b (-1 without a blend), out[2] the
/// blend weight of b (0 without one). 0, or -1 for an unknown series.
SDNAP_EXPORT("sdnap_epochs_select")
int32_t sdnap_epochs_select(uint32_t i, double jd_whole, double jd_frac, double* out) {
  auto& st = sdnap::epochs::resident();
  if (i >= st.series.size() || out == nullptr) return -1;
  const double t = sdnap::epochs::minutes_of(jd_whole, jd_frac);
  const auto c = sdnap::epochs::choose(st, st.series[i], t);
  out[0] = c.a;
  out[1] = c.b;
  double w = 0.0;
  if (c.b >= 0) { const double s = (t - c.t0) / (c.t1 - c.t0); w = s * s * (3.0 - 2.0 * s); }
  out[2] = w;
  return 0;
}

/// Series [first, first + count) at one split Julian date (UTC): six planes of `count` doubles (x, y, z, vx, vy, vz),
/// frame 0 TEME (km, km/s) or 3 Earth-fixed (m, m/s); `status` (optional) one code per series (0 ok); `cov`
/// (optional) 36 doubles per series, the TEME covariance row-major (NaN for series without one). 0, or -1.
SDNAP_EXPORT("sdnap_epochs_at")
int32_t sdnap_epochs_at(double jd_whole, double jd_frac, uint32_t first, uint32_t count, int32_t frame, double* out, int32_t* status, double* cov) {
  auto& st = sdnap::epochs::resident();
  if (out == nullptr || first > st.series.size() || count > st.series.size() - first || (frame != 0 && frame != 3)) return -1;
  const double t = sdnap::epochs::minutes_of(jd_whole, jd_frac);
  const double theta = frame == 3 ? sdnap::gmst(jd_whole, jd_frac) : 0.0;
  for (uint32_t k = 0; k < count; ++k) {
    double r[3], v[3], P[36];
    bool have_p = false;
    const int32_t e = sdnap::epochs::at(st, st.series[first + k], t, r, v, cov != nullptr ? P : nullptr, have_p);
    if (status != nullptr) status[k] = e;
    double ro[3] = {r[0], r[1], r[2]}, vo[3] = {v[0], v[1], v[2]};
    if (e == sdnap::kPropOk && frame == 3) sdnap::teme_to_ecef_m(theta, r, v, ro, vo);
    for (int c = 0; c < 3; ++c) {
      out[c * count + k] = e == sdnap::kPropOk ? ro[c] : std::numeric_limits<double>::quiet_NaN();
      out[(3 + c) * count + k] = e == sdnap::kPropOk ? vo[c] : std::numeric_limits<double>::quiet_NaN();
    }
    if (cov != nullptr)
      for (int q = 0; q < 36; ++q) cov[36 * k + q] = e == sdnap::kPropOk && have_p ? P[q] : std::numeric_limits<double>::quiet_NaN();
  }
  return 0;
}

/// Set k of series i (its index in the series, by epoch) at a split Julian date, without selection or blend: the TEME
/// state (6 doubles: km, km/s). 0, -1 for an unknown series or set, or the theory's error code.
SDNAP_EXPORT("sdnap_epochs_set_at")
int32_t sdnap_epochs_set_at(uint32_t i, uint32_t k, double jd_whole, double jd_frac, double* out) {
  auto& st = sdnap::epochs::resident();
  if (i >= st.series.size() || out == nullptr || k >= st.series[i].count) return -1;
  bool have_p = false;
  return sdnap::epochs::state_of(st, st.series[i], k, sdnap::epochs::minutes_of(jd_whole, jd_frac), out, out + 3, nullptr, have_p);
}
