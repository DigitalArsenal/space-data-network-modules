// -----------------------------------------------------------------------------
// The epoch store (SPEC 14): many element sets per object over a window of days, the set that answers a request time
// chosen by index, and a blend across each handover so the state stays continuous.
// - `load_epochs` replaces the store with a snapshot: 'ocm' frames of size-prefixed $OCM records end to end (the
//   element-sync module's $OCM lane; a frame of one plain or size-prefixed record also reads), with the optional $PCF
//   EPOCH_STORE table. A series is one (NORAD_CAT_ID, INTERNATIONAL_DESIGNATOR, MEAN_ELEMENT_THEORY, HEADER.ORIGINATOR);
//   its sets are kept by MEAN_ELEMENTS.EPOCH: CACHE_DAYS back from the newest epoch of the load (not the wall clock: the
//   store depends on its input alone), at most MAX_SETS_PER_OBJECT (the newest), THEORIES (empty: SGP4, SGP4XP and AP).
//   Sets not centered on the Earth are counted and not stored. Each set flies its own record's forces, rows and nodes;
//   a set whose forces (ATMOSPHERIC_MODEL, WEATHER_SOURCE, DENSITY_CORRECTION, the two caps) differ from its series'
//   first is refused (series-forces-differ); rows and nodes are data, not forces, and identical row series and node
//   vectors are held once (interned by content).
// - Selection (SELECTION): NEAREST, the set whose epoch is nearest the request (the switch between consecutive sets at
//   their midpoint), or LATEST_BEFORE, the latest set at or before it (the switch at the later set's epoch; before the
//   first set, the first). O(log n) per series.
// - Blend (BLEND_WINDOW_SECONDS, BLEND_SHAPE): across a window centered on each switch time, half-width
//   min(BLEND_WINDOW_SECONDS / 2, half of each adjacent spacing), the two sets' propagated states are combined.
//   SMOOTHSTEP: w = 3 s^2 - 2 s^3 over the window, r = (1 - w) r_a + w r_b, v = (1 - w) v_a + w v_b + w' (r_b - r_a), so
//   r and v are continuous (w' = 0 at both edges). HERMITE: set a's state plus a cubic Hermite correction that is zero
//   with a zero rate at the window's start and reaches set b's position and velocity at its end. Covariance: the two-component mixture (1 - w) P_a + w P_b + w (1 - w) d d^T
//   (d = x_b - x_a; the smoothstep weight for both shapes), for sets that carry COVARIANCE (SPEC 12). Two AP sets on
//   different branches (SPEC 16.7: class, the 1,100-minute regime, the eccentricity switches) are different orbits and
//   are never blended, nor a carried forecast with a theory state (SPEC 18): their switch is a step, sdnap_epochs_select
//   reports b = -2 (branches) or -3 (carried and theory) in its window and propagate_epochs names its time in the block's
//   COMMENT (SPEC 14.3).
// - Calls: the resident exports sdnap_epochs_* over the loaded store, and `propagate_epochs`, the same on a grid for a
//   snapshot given with the call (stateless).
// - A set whose record carries a forecast (SPEC 18) returns it inside the forecast's span: selection first takes a set
//   whose span holds t (the latest by epoch), unblended (sdnap_epochs_select b = -3 where that overrides a blend);
//   elsewhere selection and blend as above, a blend joining two forecasts or two theory states only. Sets of one epoch
//   with different spans (records split by day) are both kept. Every state's source is labeled (SPEC 18.8).
// -----------------------------------------------------------------------------

namespace sdnap {
namespace epochs {

/// Contiguous storage with an explicit, counted allocation refusal (SPEC 1.6).
/// Callers reserve before inserting; insertion never allocates.
template <class T> class Array {
  T* p_ = nullptr;
  size_t size_ = 0, capacity_ = 0;
 public:
  Array() = default;
  Array(const Array&) = delete;
  Array& operator=(const Array&) = delete;
  ~Array() { clear(); std::free(p_); }
  bool reserve(size_t n) {
    if (n <= capacity_) return true;
    if (n > SIZE_MAX / sizeof(T)) { mem::note_failure(SIZE_MAX); return false; }
    T* p = static_cast<T*>(mem::malloc(n * sizeof(T)));
    if (p == nullptr) return false;
    for (size_t k = 0; k < size_; ++k) { new (p + k) T(std::move(p_[k])); p_[k].~T(); }
    std::free(p_); p_ = p; capacity_ = n;
    return true;
  }
  bool push_back(T value) {
    if (size_ == capacity_) { mem::note_failure((size_ + 1) * sizeof(T)); return false; }
    new (p_ + size_++) T(std::move(value)); return true;
  }
  void clear() { while (size_) p_[--size_].~T(); }
  void pop_back() { p_[--size_].~T(); }
  size_t size() const { return size_; }
  bool empty() const { return size_ == 0; }
  T* data() { return p_; }
  const T* data() const { return p_; }
  T* begin() { return p_; }
  T* end() { return size_ ? p_ + size_ : p_; }
  const T* begin() const { return p_; }
  const T* end() const { return size_ ? p_ + size_ : p_; }
  T& operator[](size_t k) { return p_[k]; }
  const T& operator[](size_t k) const { return p_[k]; }
  T& back() { return p_[size_ - 1]; }
};

struct Config {
  double cache_days = 7.0;
  uint32_t max_sets = 0;
  int selection = 0;          ///< 0 NEAREST, 1 LATEST_BEFORE
  double blend_seconds = 3600.0;
  int shape = 0;              ///< 0 SMOOTHSTEP, 1 HERMITE
  uint32_t theories = 0;      ///< bit per theory (SGP4 1, SGP4XP 2, AP 4); 0: all
};

/// One kept set: the row, its forces and the atmosphere they read (interned; nullptr: the theory's own flux model), and
/// its covariance when the record carries one.
struct Entry {
  ElementRow row;
  double epoch;               ///< minutes from J2000 (JD 2451545.0), UTC
  cov::Set* cov = nullptr;
  Forces forces{};
  const atm::Atmosphere* atmosphere = nullptr;
  int32_t first_day = 0, last_day = 0;  ///< RECORDS: the MJDs it flies through (its first row's day + 1, its last row's day)
  xpt::Branch branch{};                 ///< an AP set's branch (SPEC 14.3, 16.7); every other set the default
  std::shared_ptr<const carried::Track> track;  ///< the forecast the record carries (SPEC 18), or none: read as flown
  double handover = HUGE_VAL;  ///< a hand-over set: the time it serves from, minutes from J2000 (SPEC 18.7); else HUGE_VAL
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
  int32_t theory = 0;         ///< sdnap::Theory (the record family)
  int32_t met = 0;            ///< MEAN_ELEMENT_THEORY
  uint32_t first = 0, count = 0;  ///< into Store::entries, by epoch
  bool carried = false;           ///< a set carries a forecast (SPEC 18.3: selection prefers a span holding t)
  Slot slots[2];
  uint32_t next = 0;              ///< the slot replaced next
};

struct Stats {
  double records = 0, kept = 0, aged = 0, capped = 0, theory = 0, other_center = 0, duplicate = 0;
};

struct Store {
  Config cfg;
  Array<Entry> entries;
  Array<Series> series;
  Stats stats;
  Array<std::unique_ptr<atm::Atmosphere>> atmospheres;  ///< the distinct row series and node vectors of the load
  int32_t short_day = 0;                                      ///< the day a request found no row for (weather-rows-short)
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
  st.atmospheres.clear();
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
        else if (v8 == pcfTheory_AP) c.theories |= 4;
        else return pcf::refuse("EPOCH_STORE.THEORIES", "SGP4, SGP4XP and AP sets are stored");
      }
    }
    return 0;
  }
  return 0;
}

inline uint32_t theory_bit(int32_t met) { return met == meanElementSource_SGP4 ? 1u : met == meanElementSource_SGP4XP ? 2u : 4u; }

/// One record of a snapshot, decoded. 1 kept, 0 skipped (not centered on the Earth), -1 refused by name (the error set).
struct Record {
  ElementRow row{};
  int32_t met = 0;
  uint32_t norad = 0;
  std::string object_id, originator, name;
  cov::Set* cov = nullptr;
  Forces forces{};
  ocm::Weather weather;
  const atm::Atmosphere* atmosphere = nullptr;
  std::shared_ptr<carried::Track> track;  ///< reading the call's bytes until the record is kept (carried::keep)
  double handover = HUGE_VAL;
};
inline int decode_record(const uint8_t* p, uint32_t n, Record& r) {
  r = Record{};
  // verified once: a record not centered on the Earth is skipped, any other decoded from the same view
  const OCM* o = ocm::view(p, n);
  if (o == nullptr) return ocm::refuse("invalid-ocm", "An 'ocm' payload is not a verifiable SDS $OCM."), -1;
  if (o->CENTER_NAME() != nullptr && o->CENTER_NAME()->size() > 0 && !oem::same_text(o->CENTER_NAME()->c_str(), "EARTH")) return 0;
  ocm::Set s;
  if (ocm::decode_view(o, s) != 0) return -1;
  r.row = s.row;
  r.met = s.theory;
  r.norad = s.id.norad;
  r.object_id = s.id.object_id;
  r.originator = s.id.originator;
  r.name = s.id.object_name;
  r.forces = s.forces;
  r.weather = std::move(s.weather);
  {
    auto track = std::make_shared<carried::Track>();
    if (carried::read(s.record, r.row, p, n, *track) != 0) return -1;
    if (!track->empty()) r.track = std::move(track);
    double from = 0.0;
    if (carried::handover_from(s.record, from)) r.handover = from;
  }
  if (r.row.theory != kTheorySgp4) {
    cov::Set c;
    const int cr = cov::read(s.record, r.row, c);
    // SPEC 12.4: an AP record whose floor is at its writer's theory state is stored without its covariance (cr -4)
    if (cr < 0 && cr != -4)
      return ocm::refuse(cr == -2 ? "cov-parameter-kind-unspecified" : cr == -3 ? "cov-propagation-invariant" : "invalid-covariance",
                         "A set's COVARIANCE_DATA, COV_PARAMETER_KINDS or COV_PROPAGATION are malformed."), -1;
    if (cr == 1) {
      r.cov = mem::counted(new (std::nothrow) cov::Set(c));
      if (r.cov == nullptr || r.cov->C.size() != c.C.size()) {
        delete r.cov; r.cov = nullptr;
        return mem::refuse_if_out_of_memory(), -1;
      }
    }
  }
  return 1;
}

/// The store's one copy of a record's atmosphere (its rows and nodes, by content), or nullptr on the theory's own flux
/// model.
inline const atm::Atmosphere* intern(Store& st, Record& r) {
  if (r.forces.weather_source != pcfWeatherSource_RECORDS) return nullptr;
  const auto model = r.forces.msis ? atm::kNrlmsise00 : atm::kJacchia70;
  auto same_rows = [](const atm::SpwDay& x, const atm::SpwDay& y) {
    return x.mjd == y.mjd && x.f107_obs == y.f107_obs && x.f107_center81 == y.f107_center81 && x.ap_avg == y.ap_avg && x.data_type == y.data_type &&
           std::strcmp(x.date, y.date) == 0;
  };
  for (const auto& held : st.atmospheres) {
    if (held->model != model || held->days.size() != r.weather.rows.size() || held->dca_ms != r.weather.node_ms || held->dca_s != r.weather.node_s) continue;
    bool same = true;
    for (size_t k = 0; same && k < r.weather.rows.size(); ++k) same = same_rows(held->days[k], r.weather.rows[k]);
    if (same) return held.get();
  }
  std::unique_ptr<atm::Atmosphere> a(mem::counted(new (std::nothrow) atm::Atmosphere{}));
  if (!a) return nullptr;
  a->model = model;
  a->measured = true;
  a->days = std::move(r.weather.rows);
  a->dca_ms = std::move(r.weather.node_ms);
  a->dca_s = std::move(r.weather.node_s);
  for (int64_t ms : a->dca_ms) a->dca_d50.push_back(static_cast<double>(ms) / 86400000.0 + 7306.0);
  if (!st.atmospheres.reserve(st.atmospheres.size() + 1)) return nullptr;
  st.atmospheres.push_back(std::move(a));
  return st.atmospheres.back().get();
}

/// Calls `fn(p, n)` for each record of a frame: size-prefixed records end to end, or one plain record. False when the
/// frame is neither.
template <class Fn>
inline bool each_record(const uint8_t* p, uint32_t n, Fn fn) {
  if (n >= 8 && std::memcmp(p + 4, "$OCM", 4) == 0) return fn(p, n);
  if (n >= 12 && std::memcmp(p + 8, "$OCM", 4) == 0) {
    uint32_t len;
    std::memcpy(&len, p, 4);
    if (len + 4 == n) return fn(p, n);
  }
  for (uint32_t off = 0; off < n;) {
    if (n - off < 12) return false;
    uint32_t len;
    std::memcpy(&len, p + off, 4);
    if (len > n - off - 4 || std::memcmp(p + off + 8, "$OCM", 4) != 0) return false;
    if (!fn(p + off, len + 4)) return false;
    off += 4 + len;
  }
  return true;
}

/// Builds `st` from the call's 'ocm' frames under `cfg`. 0, or 3 with a named error.
inline int build(Store& st, const Config& cfg) {
  clear(st);
  st.cfg = cfg;
  // Count framing without decoding. Malformed input is still diagnosed in the original decode order.
  size_t count = 0;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f != nullptr && f->port_id != nullptr && std::strcmp(f->port_id, "ocm") == 0)
      each_record(f->payload, f->payload_length, [&](const uint8_t*, uint32_t) { ++count; return true; });
  }
  Array<Record> recs;
  if (!recs.reserve(count) || !st.entries.reserve(count) || !st.series.reserve(count))
    return mem::refuse_if_out_of_memory(), 3;
  bool refused = false;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f == nullptr || f->port_id == nullptr || std::strcmp(f->port_id, "ocm") != 0) continue;
    const bool ok = each_record(f->payload, f->payload_length, [&](const uint8_t* p, uint32_t n) {
      Record r;
      const int d = decode_record(p, n, r);
      ++st.stats.records;
      if (d < 0) { refused = true; return false; }
      if (d == 0) { ++st.stats.other_center; return true; }
      if (cfg.theories != 0 && (cfg.theories & theory_bit(r.met)) == 0) { ++st.stats.theory; delete r.cov; return true; }
      r.atmosphere = intern(st, r);
      if (mem::refuse_if_out_of_memory()) { delete r.cov; refused = true; return false; }
      r.weather = ocm::Weather{};
      recs.push_back(std::move(r));
      return true;
    });
    if (!ok || refused) {
      for (Record& r : recs) delete r.cov;
      if (refused) return 3;
      plugin_set_error("invalid-ocm", "An 'ocm' frame is neither size-prefixed $OCM records end to end nor one $OCM record.");
      return 3;
    }
  }
  // the series: (NORAD_CAT_ID, INTERNATIONAL_DESIGNATOR, MEAN_ELEMENT_THEORY, ORIGINATOR), each by epoch (a later record
  // of the same epoch replaces)
  Array<uint32_t> order, keep;
  if (!order.reserve(recs.size()) || !keep.reserve(recs.size())) {
    for (Record& r : recs) delete r.cov;
    return mem::refuse_if_out_of_memory(), 3;
  }
  for (uint32_t k = 0; k < recs.size(); ++k) order.push_back(k);
  auto epoch_of = [&](const Record& r) { return minutes_of(r.row.epoch_jd_whole, r.row.epoch_jd_frac); };
  if (!order.empty()) std::sort(order.begin(), order.end(), [&](uint32_t a, uint32_t b) {
    const Record &x = recs[a], &y = recs[b];
    if (x.norad != y.norad) return x.norad < y.norad;
    if (x.object_id != y.object_id) return x.object_id < y.object_id;
    if (x.met != y.met) return x.met < y.met;
    if (x.originator != y.originator) return x.originator < y.originator;
    if (epoch_of(x) != epoch_of(y)) return epoch_of(x) < epoch_of(y);
    // SPEC 18.3: sets of one epoch carrying different spans (records split by day) by their span's start
    const double xs = x.track ? x.track->start : -HUGE_VAL, ys = y.track ? y.track->start : -HUGE_VAL;
    return xs != ys ? xs < ys : a < b;  // original input position preserves stable ties without a sort allocation
  });
  // a series flies one force model: its sets' forces equal its first's
  for (uint32_t k = 1; k < order.size(); ++k) {
    const Record &x = recs[order[k - 1]], &y = recs[order[k]];
    if (x.norad == y.norad && x.object_id == y.object_id && x.met == y.met && x.originator == y.originator && !x.forces.same(y.forces)) {
      for (Record& r : recs) delete r.cov;
      char why[200];
      std::snprintf(why, sizeof why, "NORAD %u: two sets of one series state different forces (ATMOSPHERIC_MODEL, WEATHER_SOURCE, DENSITY_CORRECTION or a gravity cap).", x.norad);
      plugin_set_error("series-forces-differ", why);
      return 3;
    }
  }
  double newest = -HUGE_VAL;
  for (const Record& r : recs) newest = std::fmax(newest, epoch_of(r));
  const double oldest_kept = newest - cfg.cache_days * kMinutesPerDay;
  for (uint32_t k = 0; k < order.size();) {
    uint32_t e = k;
    const Record& head = recs[order[k]];
    while (e < order.size() && recs[order[e]].norad == head.norad && recs[order[e]].object_id == head.object_id &&
           recs[order[e]].met == head.met && recs[order[e]].originator == head.originator)
      ++e;
    keep.clear();
    for (uint32_t q = k; q < e; ++q) {
      Record& r = recs[order[q]];
      if (epoch_of(r) < oldest_kept) { ++st.stats.aged; delete r.cov; r.cov = nullptr; continue; }
      // a later record of the same epoch replaces, unless the two carry different spans (records split by day)
      auto same_span = [](const Record& a, const Record& b) {
        return !a.track == !b.track && (!a.track || (a.track->start == b.track->start && a.track->stop == b.track->stop));
      };
      if (!keep.empty() && epoch_of(recs[keep.back()]) == epoch_of(r) && same_span(recs[keep.back()], r)) {
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
      for (size_t q = drop; q < keep.size(); ++q) keep[q - drop] = keep[q];
      for (size_t q = 0; q < drop; ++q) keep.pop_back();
    }
    if (!keep.empty()) {
      Series s;
      s.norad = head.norad;
      s.object_id = head.object_id;
      s.originator = head.originator;
      s.theory = head.row.theory;
      s.met = head.met;
      s.name = recs[keep.back()].name;
      s.first = static_cast<uint32_t>(st.entries.size());
      s.count = static_cast<uint32_t>(keep.size());
      for (uint32_t q : keep) {
        Entry en;
        en.row = recs[q].row;
        en.epoch = epoch_of(recs[q]);
        en.cov = recs[q].cov;
        if (recs[q].track) {
          carried::keep(*recs[q].track);  // a kept record's bytes, copied once (the call's are freed after it)
          en.track = recs[q].track;
          s.carried = true;
        }
        en.handover = recs[q].handover;
        en.forces = recs[q].forces;
        en.atmosphere = recs[q].atmosphere;
        if (en.atmosphere != nullptr && !en.atmosphere->days.empty()) {
          en.first_day = en.atmosphere->days.front().mjd + 1;
          en.last_day = en.atmosphere->days.back().mjd;
        }
        if (en.row.theory == kTheorySgp4Xp) {
          ocm::Bind bind(en.forces, en.atmosphere);  // the set's own selection decides whether AP's switches exist
          if (ap_selected()) en.branch = row_branch(en.row);
        }
        recs[q].cov = nullptr;
        st.entries.push_back(en);
      }
      st.series.push_back(std::move(s));
    }
    k = e;
  }
  // Only atmospheres referenced by retained sets belong to the snapshot.
  size_t used = 0;
  for (size_t k = 0; k < st.atmospheres.size(); ++k) {
    bool live = false;
    for (const Entry& en : st.entries) if (en.atmosphere == st.atmospheres[k].get()) { live = true; break; }
    if (live) { if (used != k) st.atmospheres[used] = std::move(st.atmospheres[k]); ++used; }
  }
  while (st.atmospheres.size() > used) st.atmospheres.pop_back();
  st.stats.kept = static_cast<double>(st.entries.size());
  return 0;
}

/// The code a set's state takes when its rows do not hold a day the request flies it through (Store::short_day).
constexpr int32_t kRowsShort = 90;

/// 0, or kRowsShort with st.short_day the first missing day: set k of series s flown from its epoch to t (minutes from
/// J2000) reads the rows of every UTC day between, and the day before the first.
inline int32_t rows_cover(Store& st, const Entry& en, double t) {
  if (en.atmosphere == nullptr) return 0;
  const double w = 2451545.0, f0 = en.epoch / kMinutesPerDay, f1 = t / kMinutesPerDay;
  const int32_t a = ocm::mjd_of(w, std::fmin(f0, f1)), b = ocm::mjd_of(w, std::fmax(f0, f1));
  const std::vector<atm::SpwDay>& d = en.atmosphere->days;
  int32_t one_a_day = __atomic_load_n(&en.atmosphere->one_a_day, __ATOMIC_RELAXED);
  if (one_a_day < 0) {
    one_a_day = d.empty() ? 0 : 1;
    for (size_t q = 1; one_a_day && q < d.size(); ++q) one_a_day = d[q].mjd == d[q - 1].mjd + 1 ? 1 : 0;
    __atomic_store_n(&en.atmosphere->one_a_day, one_a_day, __ATOMIC_RELAXED);
  }
  if (one_a_day) {
    // every day from the first row's to the last's: the first day of a - 1 .. b without a row is before the first or after the last
    const int32_t first = d.front().mjd, last = d.back().mjd;
    if (a - 1 < first) {
      st.short_day = a - 1;
      return kRowsShort;
    }
    if (b > last) {
      st.short_day = a - 1 > last + 1 ? a - 1 : last + 1;
      return kRowsShort;
    }
    return 0;
  }
  size_t k = 0;
  for (int32_t day = a - 1; day <= b; ++day) {
    while (k < d.size() && d[k].mjd < day) ++k;
    if (k >= d.size() || d[k].mjd != day) {
      st.short_day = day;
      return kRowsShort;
    }
  }
  return 0;
}

/// The slot holding set `k` of series `s`, initialized on first use (the older of the two slots replaced).
inline Slot& slot_of(Store& st, Series& s, uint32_t k, bool with_cov) {
  const Entry& bound = st.entries[s.first + k];
  ocm::Bind bind(bound.forces, bound.atmosphere);  // the set's own forces, rows and nodes
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
  // SPEC 1.6 (stack #497): a slot whose initialization failed for want of memory is not kept as refused: it answers this
  // call with the failure and is initialized again by the next
  const uint32_t mem_mark = sdnap::mem::failures();
  struct Retry {
    Slot& q;
    uint32_t mark;
    ~Retry() {
      if (q.error != 0 && sdnap::mem::failures() != mark) q.index = -1;
    }
  } retry{q, mem_mark};
  if (en.row.theory == kTheorySgp4Xp) {
    drag::table();
    q.xp = static_cast<xpt::XpSat*>(sdnap::mem::calloc(1, sizeof(xpt::XpSat)));
    q.error = q.xp == nullptr ? kPropRefused : xpt::xp_init(e, *q.xp);
    if (q.error == kPropOk) xpt::xp_set_pooled(*q.xp);
  } else {
    q.sat = static_cast<Sat*>(sdnap::mem::calloc(1, sizeof(Sat)));
    q.error = q.sat == nullptr ? kPropRefused : sat_init(e, gravity_wgs72(), *q.sat);
    if (q.error == kPropOk && q.sat->deep.iresfl != 0) {
      q.nodes = static_cast<double*>(sdnap::mem::malloc(sizeof(double) * 4u * kCheckpointNodes));
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

/// Seconds of t from entry e's epoch as every test of a carried span takes them (SPEC 18.3: one decision per instant):
/// from the split Julian date when the caller has it, else from the minutes. choose(), state_of() and source_at() all
/// use this one expression on the same inputs, so the set chosen for its span flies its forecast there.
inline double span_seconds(const Entry& e, double t, const double* jd) {
  return jd != nullptr ? ((jd[0] - e.row.epoch_jd_whole) + (jd[1] - e.row.epoch_jd_frac)) * 86400.0 : (t - e.epoch) * 60.0;
}

/// SPEC 16.25 (stack #564): the decay crossing (split Julian date, UTC) of the last AP set state_of found a time past, on this
/// thread: propagate_epochs names it in its refusal and its block.
inline thread_local double g_decay_jd[2] = {0.0, 0.0};
inline thread_local bool g_decay_seen = false;
inline thread_local bool g_decay_back = false;  ///< the crossing g_decay_jd names lies before the epoch (the refused time dt < 0)

/// Set k of series s at t (minutes from J2000): TEME state, and the covariance when `P` is given (false: none). `jd` (the
/// split Julian date of t, when the caller has it) times a carried forecast to the microsecond's fraction.
inline int32_t state_of(Store& st, Series& s, uint32_t k, double t, double* r, double* v, double* P, bool& have_p, const double* jd = nullptr,
                        bool start_bank = false) {
  have_p = false;
  if (const int32_t rc = rows_cover(st, st.entries[s.first + k], t)) return rc;
  if (const carried::Track* tr = st.entries[s.first + k].track.get()) {
    // SPEC 18: inside its span the forecast the record carries; the covariance stays the theory's
    const double ts = span_seconds(st.entries[s.first + k], t, jd);
    if (tr->covers(ts)) {
      // a segment read now that does not verify or falls short of the time: the input's fault (malformed record)
      if (const int32_t e = carried::at(*tr, ts, r, v, jd)) return e == carried::kFrame ? kPropRefused : ORBPRO_PROP_BAD_INPUT;
      if (P != nullptr && st.entries[s.first + k].cov != nullptr) {
        Slot& q = slot_of(st, s, k, true);
        if (q.error == 0 && q.cp != nullptr) {
          double rr[3], vv[3];
          have_p = cov::eval(*q.cp, t - st.entries[s.first + k].epoch, rr, vv, P);
        }
      }
      return kPropOk;
    }
  }
  Slot& q = slot_of(st, s, k, P != nullptr || start_bank);
  if (q.error != 0) return q.error;
  // the theory's time from the set's epoch (SPEC 9): an AP set's from the split Julian date when the caller has it, the
  // expression propagate uses, so the store and propagate fly one time (minutes from J2000 round it by up to 1e-7 s
  // today, 1 mm in low orbit); SGP4XP and SGP4 from the minutes, as before 0.6.18 (their output stays bit for bit)
  const Entry& en = st.entries[s.first + k];
  const double dt = jd != nullptr && q.xp != nullptr && xpt::is_ap_ctx(q.xp->ctx)
                        ? ((jd[0] - en.row.epoch_jd_whole) + (jd[1] - en.row.epoch_jd_frac)) * kMinutesPerDay
                        : t - en.epoch;
  const int32_t e = q.xp != nullptr ? xpt::xp_propagate(*q.xp, dt, r, v) : sat_propagate(*q.sat, q.nodes, dt, r, v);
  // SPEC 16.25 (stack #564): an AP set past its decay crossing; the crossing's split Julian date for the call's refusal by name
  // the record's earliest crossing on dt's side: the nominal's and, where a covariance is asked, every started moved set's, each run to dt
  // first (the covariance's own evaluation stops at the first set it refuses), so the name does not depend on what was asked before
  auto earliest = [&](double& first) {
    bool any = false;
    const double sd = dt >= 0.0 ? 1.0 : -1.0;
    double tc = 0.0;
    if (q.xp != nullptr && xpt::decay_crossing(*q.xp, dt, tc)) { first = tc; any = true; }  // under the set's lock: shared
    // the bank when the slot has one (a covariance asked for this call), also for a probe that asks no covariance of its own: the
    // Hermite blend's probe at its window's end must name the record's crossing, not the nominal's
    if (q.cp != nullptr) {
      for (int k = 0; k < q.cp->b.count; ++k) {
        if (!cov::live_slot(q.cp->b, k)) continue;  // only the slots the bank started
        double r2[3], v2[3];
        xpt::xp_propagate(q.cp->b.sats[k], dt, r2, v2);
      }
      for (int k = 0; k < q.cp->b.count; ++k) {
        if (!cov::live_slot(q.cp->b, k) || !xpt::decay_crossing(q.cp->b.sats[k], dt, tc)) continue;
        if (!any || sd * tc < sd * first) first = tc;
        any = true;
      }
    }
    return any;
  };
  double crossing_min = 0.0;
  if (e == kPropDecayed && q.xp != nullptr && xpt::is_ap_ctx(q.xp->ctx) && earliest(crossing_min)) {
    const double c = crossing_min / kMinutesPerDay + en.row.epoch_jd_frac;
    g_decay_jd[0] = en.row.epoch_jd_whole + std::floor(c);
    g_decay_jd[1] = c - std::floor(c);
    g_decay_back = dt < 0.0;
    g_decay_seen = true;
  }
  if (e != kPropOk) return e;
  if (P != nullptr && q.cp != nullptr) {
    double rr[3], vv[3];
    have_p = cov::eval(*q.cp, dt, rr, vv, P);
    // SPEC 16.25: a moved set of the covariance past its decay crossing where the nominal still flies: the epoch is past the record's
    // crossing (the earliest of the nominal's and every moved set's), refused as propagate refuses it, not written without covariance
    if (!have_p && q.xp != nullptr && xpt::is_ap_ctx(q.xp->ctx)) {
      double first = 0.0;
      if (earliest(first)) {
        const double c = first / kMinutesPerDay + en.row.epoch_jd_frac;
        g_decay_jd[0] = en.row.epoch_jd_whole + std::floor(c);
        g_decay_jd[1] = c - std::floor(c);
        g_decay_back = dt < 0.0;
        g_decay_seen = true;
        return kPropDecayed;
      }
    }
  }
  return kPropOk;
}

/// The selection at t: sets a (and b, the next, with weight w and the window when blending; b = -1 otherwise).
/// `unblended` (SPEC 14.3): t lies in the window of a switch that is a step, set a alone, switching at tau: 1 the two sets
/// fly theory on different branches, 2 over the window one gives (or may give) its carried forecast and the other the theory.
struct Choice {
  int32_t a = 0, b = -1;
  double t0 = 0, t1 = 0;      ///< the blend window
  int32_t unblended = 0;
  double tau = 0;             ///< the unblended switch's time (minutes from J2000)
  bool spanned = false;       ///< SPEC 18.3: a carried span holding t took the set where the selection by epoch blends
};
/// What a set gives over the window [t0, t1] (minutes from J2000): 0 the theory throughout, 1 its carried forecast
/// throughout (SPEC 18), 2 both (its span ends or starts inside the window).
inline int window_kind(const Entry& e, double t0, double t1) {
  const carried::Track* tr = e.track.get();
  if (tr == nullptr) return 0;
  const double s0 = (t0 - e.epoch) * 60.0, s1 = (t1 - e.epoch) * 60.0;
  if (tr->covers(s0) && tr->covers(s1)) return 1;
  return s1 < tr->start || s0 > tr->stop ? 0 : 2;
}
inline Choice choose_by_epoch(const Store& st, const Series& s, double t);
/// `jd`: the split Julian date of t when the caller has it; the span test is span_seconds()'s, the one state_of() makes.
inline Choice choose(const Store& st, const Series& s, double t, const double* jd = nullptr) {
  Choice c;
  if (s.count == 1) return c;
  // SPEC 18.3: a set whose carried span holds t flies there, the latest by epoch when more than one does (a fresher
  // forecast), without a blend (`spanned` where the selection by epoch would have blended or stepped there); elsewhere
  // the selection by epoch
  if (s.carried) {
    const Entry* E = st.entries.data() + s.first;
    for (uint32_t k = s.count; k-- > 0;)
      if (E[k].track && E[k].track->covers(span_seconds(E[k], t, jd))) {
        const Choice e = choose_by_epoch(st, s, t);
        c.a = static_cast<int32_t>(k);
        c.spanned = e.b >= 0 || e.unblended != 0;
        return c;
      }
  }
  return choose_by_epoch(st, s, t);
}
/// The selection by epoch (SPEC 14) with 14.3's blend rule.
inline Choice choose_by_epoch(const Store& st, const Series& s, double t) {
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
      // SPEC 14.3: a blend joins two theory states on one branch (16.7: sets on different branches are different orbits;
      // two carried forecasts never reach here, choose flies a span's set first, 18.3); anything else is a step, so every
      // state is one or the other
      const int ka = window_kind(E[i], tau - h, tau + h), kb = window_kind(E[i + 1], tau - h, tau + h);
      const int why = ka != kb || ka == 2 ? 2 : ka == 0 && E[i].branch != E[i + 1].branch ? 1 : 0;
      if (why != 0) {
        c.unblended = why;
        c.tau = tau;
        return c;
      }
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
/// when the sets carry none). 0, or the theory's error code. `jd` (the split Julian date of t, when the caller has it) times
/// a carried forecast (state_of). `unblended` (optional): the switch t was not blended across (SPEC 14.3), its time and
/// why (Choice::unblended), or {NaN, 0}.
inline int32_t at(Store& st, Series& s, double t, double* r, double* v, double* P, bool& have_p, const double* jd = nullptr,
                  double* unblended = nullptr) {
  const Choice c = choose(st, s, t, jd);
  if (unblended != nullptr) {
    unblended[0] = c.unblended ? c.tau : std::numeric_limits<double>::quiet_NaN();
    unblended[1] = c.unblended;
  }
  if (c.b < 0) return state_of(st, s, static_cast<uint32_t>(c.a), t, r, v, P, have_p, jd);
  double ra[3], va[3], rb[3], vb[3], Pa[36], Pb[36];
  bool ha = false, hb = false;
  const double sfrac = (t - c.t0) / (c.t1 - c.t0);
  const double w = sfrac * sfrac * (3.0 - 2.0 * sfrac);
  if (st.cfg.shape == 0) {
    if (const int32_t e = state_of(st, s, static_cast<uint32_t>(c.a), t, ra, va, P != nullptr ? Pa : nullptr, ha, jd)) return e;
    if (const int32_t e = state_of(st, s, static_cast<uint32_t>(c.b), t, rb, vb, P != nullptr ? Pb : nullptr, hb, jd)) return e;
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
    // the probes at the window's end start the call's covariance bank (no evaluation: the blend reads the nominals' states there and
    // nothing of the bank), so a refused probe names the record's earliest crossing, a moved set's included, whichever epoch is
    // asked first, and an epoch before every crossing is answered as it always was
    if (const int32_t e = state_of(st, s, static_cast<uint32_t>(c.a), t, ra, va, P != nullptr ? Pa : nullptr, ha, jd)) return e;
    if (const int32_t e = state_of(st, s, static_cast<uint32_t>(c.a), c.t1, r1a, v1a, nullptr, hd, nullptr, P != nullptr)) return e;
    if (const int32_t e = state_of(st, s, static_cast<uint32_t>(c.b), c.t1, r1b, v1b, nullptr, hd, nullptr, P != nullptr)) return e;
    const double T = (c.t1 - c.t0) * 60.0, uu = sfrac;  // seconds
    const double h01 = uu * uu * (3.0 - 2.0 * uu), h11 = uu * uu * (uu - 1.0);
    const double d01 = 6.0 * uu * (1.0 - uu) / T, d11 = uu * (3.0 * uu - 2.0);
    for (int i = 0; i < 3; ++i) {
      const double d = r1b[i] - r1a[i], dv = v1b[i] - v1a[i];
      r[i] = ra[i] + h01 * d + h11 * T * dv;
      v[i] = va[i] + d01 * d + d11 * dv;
    }
    if (P != nullptr)
      if (const int32_t e = state_of(st, s, static_cast<uint32_t>(c.b), t, rb, vb, Pb, hb, jd)) return e;
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

/// SPEC 18.8: where at() takes series s's state at the split Julian date (w, f) from (carried::Source): 0 the theory, 1
/// the forecast a set carries (inside its span), 2 a blend of two sets' states of different sources, 3 a hand-over set
/// at or after the time it serves from.
inline int32_t source_at(const Store& st, const Series& s, double w, double f) {
  const double t = minutes_of(w, f), jd[2] = {w, f};
  const Choice c = choose(st, s, t, jd);
  auto source = [&](int32_t j) {
    const Entry& en = st.entries[s.first + static_cast<uint32_t>(j)];
    if (en.track && en.track->covers(span_seconds(en, t, jd))) return int32_t{carried::kCarried};
    return en.handover <= t ? int32_t{carried::kHandOver} : int32_t{carried::kTheory};
  };
  const int32_t a = source(c.a);
  if (c.b < 0) return a;
  return a == source(c.b) ? a : int32_t{carried::kBlend};
}
/// Whether a set of series s carries a forecast or is a hand-over set (its states are labeled).
inline bool any_labeled(const Store& st, const Series& s) {
  for (uint32_t k = 0; k < s.count; ++k)
    if (st.entries[s.first + k].track || st.entries[s.first + k].handover < HUGE_VAL) return true;
  return false;
}

inline uint64_t bytes_of(const Store& st) {
  uint64_t b = st.entries.size() * sizeof(Entry) + st.series.size() * sizeof(Series);
  for (const Entry& e : st.entries) b += (e.cov != nullptr ? sizeof(cov::Set) + e.cov->C.size() * sizeof(double) : 0) + (e.track ? e.track->bytes() : 0);
  // the interned rows and nodes, one copy each
  for (const auto& a : st.atmospheres) b += sizeof(atm::Atmosphere) + a->days.size() * sizeof(atm::SpwDay) + a->dca_ms.size() * (sizeof(int64_t) + 2 * sizeof(double));
  for (const Series& s : st.series) {
    b += s.object_id.capacity() + s.originator.capacity() + s.name.capacity();
    // a set: its XpSat, the term tables it owns and its caches from the pool (xp_bytes)
    for (const Slot& q : s.slots) b += (q.xp ? xpt::xp_bytes(*q.xp) : 0) + (q.sat ? sizeof(Sat) : 0) + (q.nodes ? 32u * kCheckpointNodes : 0) + (q.cp ? sizeof(cov::Propagator) + q.cp->s.C.size() * sizeof(double) : 0);
  }
  return b;
}

}  // namespace epochs
}  // namespace sdnap

/// `load_epochs`: replaces the resident store with the call's snapshot (SPEC 14).
static int load_epochs_call(void);
extern "C" int load_epochs(void) {
  sdnap::mem::CallMark call_mark;
  return sdnap::mem::finish(load_epochs_call());
}
static int load_epochs_call(void) {
  using namespace sdnap;
  plugin_reset_output_state();
  uint32_t frames = 0;
  if (const int rc = ocm::admit(frames)) return rc;
  if (const int rc = pcf::read(pcf::kEpochs, true)) return rc;
  epochs::Config cfg;
  if (const int rc = epochs::read_config(cfg)) return rc;
  return epochs::build(epochs::resident(), cfg);
}

/// `propagate_epochs`: the store of the call's own snapshot at the $PCF OUTPUT times (EPOCHS, or START_TIME to STOP_TIME):
/// one $OEM per series, the blended TEME / GCRF / EME2000 states and, for series whose sets carry COVARIANCE, a
/// covariance line per state.
static int propagate_epochs_call(void);
extern "C" int propagate_epochs(void) {
  sdnap::mem::CallMark call_mark;
  return sdnap::mem::finish(propagate_epochs_call());
}
static int propagate_epochs_call(void) {
  using namespace sdnap;
  plugin_reset_output_state();
  uint32_t frames = 0;
  if (const int rc = ocm::admit(frames)) return rc;
  if (const int rc = pcf::read(pcf::kEpochs)) return rc;
  if (pcf::options().epochs_w.empty() && !(pcf::options().has_start && pcf::options().has_stop))
    return pcf::refuse("OUTPUT.START_TIME", "propagate_epochs names its times: OUTPUT.START_TIME and STOP_TIME, or EPOCHS");
  epochs::Config cfg;
  if (const int rc = epochs::read_config(cfg)) return rc;
  epochs::Store st;
  struct Scope { epochs::Store& s; ~Scope() { epochs::clear(s); } } scope{st};
  if (const int rc = epochs::build(st, cfg)) return rc;
  if (st.series.empty()) { plugin_set_error("missing-ocm", "propagate_epochs keeps no set of the 'ocm' snapshot."); return 3; }
  const std::vector<oem::Grid> grids = {oem::output_grid()};
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
      std::vector<std::pair<double, double>> unblended;  // SPEC 14.3: the switches the grid crosses without a blend, and why
      // SPEC 16.25 (stack #564): the epochs past an AP set's decay crossing are refused by name, those before it answered
      std::vector<double> kw, kf;
      size_t past_n = 0;
      double cross_jd[2] = {0.0, 0.0};
      bool cross_back = false;
      for (size_t k = 0; k < tw.size(); ++k) {
        double r[3], v[3], P[36], ub[2];
        bool have_p = false;
        const double jd[2] = {tw[k], tf[k]};
        epochs::g_decay_seen = false;
        const int32_t e = epochs::at(st, s, epochs::minutes_of(tw[k], tf[k]), r, v, P, have_p, jd, ub);
        if (e == kPropDecayed && epochs::g_decay_seen) {
          if (past_n == 0) {  // the first epoch past a crossing names it (the epochs ascend)
            cross_jd[0] = epochs::g_decay_jd[0];
            cross_jd[1] = epochs::g_decay_jd[1];
            cross_back = epochs::g_decay_back;
          }
          ++past_n;
          continue;
        }
        kw.push_back(tw[k]);
        kf.push_back(tf[k]);
        if (ub[0] == ub[0] && (unblended.empty() || unblended.back().first != ub[0])) unblended.emplace_back(ub[0], ub[1]);
        oem::iso_text(tw[k], tf[k], 0.0, text, sizeof text);
        if (e == epochs::kRowsShort) {
          char day[16];
          atm::date_of_mjd(st.short_day, day, sizeof day);
          return atm::fail_day("weather-rows-short", day, "A set's SPACE_WEATHER rows do not reach a day the request flies it through.");
        }
        if (e != kPropOk) {
          if (mem::refuse_if_out_of_memory()) return 3;
          std::snprintf(why, sizeof why, "NORAD %u does not propagate to %s (code %d).", s.norad, text, static_cast<int>(e));
          plugin_set_error("propagation-failed", why);
          return 3;
        }
        double axes[3][3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
        if (g.axes != oem::Axes::Teme) {
          double m[3][3];
          if (frames::gcrf_to_teme_output(tw[k], tf[k], m) < 0) { std::snprintf(why, sizeof why, "No GCRF axes at %s.", text); plugin_set_error("frame-failed", why); return 3; }
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
      char cross_text[48] = {};
      if (past_n > 0) {
        oem::iso_text(cross_jd[0], cross_jd[1], 0.0, cross_text, sizeof cross_text);
        if (kw.empty()) {
          char name[80];
          std::snprintf(name, sizeof name, "decayed:%s", cross_text);
          std::snprintf(why, sizeof why, "NORAD %u decays at %s (SPEC 16.25): every requested epoch is past it.", s.norad, cross_text);
          plugin_set_error(name, why);
          return 3;
        }
        tw = kw;
        tf = kf;
      }
      oem::iso_text(tw.front(), tf.front(), 0.0, start, sizeof start);
      oem::iso_text(tw.back(), tf.back(), 0.0, stop, sizeof stop);
      std::string comment;
      for (const auto& u : unblended) {
        const double d = u.first / kMinutesPerDay, whole = std::floor(d + 0.5) - 0.5;
        char when[48];
        oem::iso_text(2451545.0 + whole, d - whole, 0.0, when, sizeof when);
        comment += comment.empty() ? "Not blended (SPEC 14.3): " : ", ";
        comment += when;
        comment += u.second == 1.0 ? " (sets on different branches)" : " (a carried forecast and the theory)";
      }
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
      // SPEC 18.8: one block per series; a series with a set carrying a forecast or a hand-over set states every state's
      // source in the block's COMMENT (carried::sources_comment), then, after ". ", the switches not blended (14.3);
      // any other series writes 14.3's text alone, or none
      if (epochs::any_labeled(st, s)) {
        std::vector<uint8_t> src(tw.size());
        for (size_t k = 0; k < tw.size(); ++k) src[k] = static_cast<uint8_t>(epochs::source_at(st, s, tw[k], tf[k]));
        comment = comment.empty() ? carried::sources_comment(src, tw, tf) : carried::sources_comment(src, tw, tf) + ". " + comment;
      }
      // SPEC 16.25: a block that stops at a set's decay names it, counts the epochs refused after it, and takes it as its usable limit
      // a crossing before the epoch is the block's usable start whatever is answered; a crossing after it, its usable stop when no epoch
      // is answered after it (a later set of the series may answer epochs past an earlier set's crossing: for a crossing after the
      // epoch the block then states neither limit and its COMMENT names the refused run)
      bool answered_after = false;
      if (past_n > 0 && !cross_back)
        for (size_t q = 0; q < kw.size() && !answered_after; ++q) answered_after = ((kw[q] - cross_jd[0]) + (kf[q] - cross_jd[1])) > 0.0;
      const char* limit_start = past_n > 0 && cross_back ? cross_text : nullptr;
      const char* limit_stop = past_n > 0 && !cross_back && !answered_after ? cross_text : nullptr;
      if (past_n > 0) {
        char note[120];
        std::snprintf(note, sizeof note, "decayed:%s; %zu epochs after it refused", cross_text, past_n);
        comment = comment.empty() ? std::string(note) : comment + ". " + note;
      }
      blocks.push_back(CreateephemerisDataBlockDirect(fbb, comment.empty() ? nullptr : comment.c_str(), object, "EARTH", frame, nullptr, cov_frame, timingStandard_UTC, start,
                                                      limit_start, limit_stop,
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

/// SPEC 16.12 diagnostics: the drag's averaged rates of the resident store's series `index` (load_epochs), its first set, at its mean state at `minutes` against an
/// independent integral (xpt::drag_orbit_check, `samples` Simpson points per pass), each as its change over one period
/// in meters: out[0..5] the rates', out[6..11] the integral's, in the order a (from n), a e_f, a e_g, 2 a chi, 2 a psi,
/// a lambda. ORBPRO_PROP_UNPHYSICAL without drag or a mean state.
SDNAP_EXPORT("sdnap_drag_orbit_check")
int32_t sdnap_drag_orbit_check(uint32_t index, double minutes, int32_t samples, double* out) {
  auto& st = sdnap::epochs::resident();
  if (index >= st.series.size() || out == nullptr) return ORBPRO_PROP_BAD_INPUT;
  auto& slot = sdnap::epochs::slot_of(st, st.series[index], 0, false);
  if (slot.xp == nullptr || slot.error != 0) return ORBPRO_PROP_UNPHYSICAL;
  sdnap::xpt::XpSat& s = *slot.xp;
  using namespace sdnap::xpt;
  double y[6], th[6], ck[6];
  if (!mean_at(s, minutes, y) || !drag_orbit_check(s.ctx, minutes, y, samples, th, ck)) return ORBPRO_PROP_UNPHYSICAL;
  const Frame fr = frame_of(y);
  const double P = sdnap::kTwoPi / fr.n, m = kRe * 1000.0 * fr.a;
  const double* src[2] = {th, ck};
  for (int w = 0; w < 2; ++w) {
    const double* f = src[w];
    double* o = out + 6 * w;
    o[0] = -(2.0 / 3.0) * f[kN] / fr.n * P * m;
    o[1] = f[kAf] * P * m;
    o[2] = f[kAg] * P * m;
    o[3] = 2.0 * f[kChi] * P * m;
    o[4] = 2.0 * f[kPsi] * P * m;
    o[5] = f[kLam] * P * m;
  }
  return ORBPRO_PROP_OK;
}

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

/// The selection of series i at a split Julian date: out[0] set a, out[1] set b (-1 without a blend; -2 inside the
/// window of a switch not blended because its two sets are on different branches, -3 because one gives its carried
/// forecast and the other the theory, or because a carried span holding t took set a there; SPEC 14.3, 18.3), out[2]
/// the blend weight
/// of b (0 without one). 0, or -1 for an unknown series.
SDNAP_EXPORT("sdnap_epochs_select")
int32_t sdnap_epochs_select(uint32_t i, double jd_whole, double jd_frac, double* out) {
  auto& st = sdnap::epochs::resident();
  if (i >= st.series.size() || out == nullptr) return -1;
  const double t = sdnap::epochs::minutes_of(jd_whole, jd_frac), jd[2] = {jd_whole, jd_frac};
  const auto c = sdnap::epochs::choose(st, st.series[i], t, jd);
  out[0] = c.a;
  out[1] = c.unblended == 1 ? -2 : c.unblended == 2 || c.spanned ? -3 : c.b;
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
    const double jd[2] = {jd_whole, jd_frac};
    const int32_t e = sdnap::epochs::at(st, st.series[first + k], t, r, v, cov != nullptr ? P : nullptr, have_p, jd);
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

/// SPEC 18.8: the source of what sdnap_epochs_at returns for series [first, first + count) at one split Julian date
/// (UTC), one code per series: 0 the theory, 1 the forecast a set carries (inside its span), 2 a blend of two sets'
/// states of different sources, 3 a hand-over set at or after the time it serves from (SPEC 18.7). 0, or -1.
SDNAP_EXPORT("sdnap_epochs_source_at")
int32_t sdnap_epochs_source_at(double jd_whole, double jd_frac, uint32_t first, uint32_t count, int32_t* out) {
  auto& st = sdnap::epochs::resident();
  if (out == nullptr || first > st.series.size() || count > st.series.size() - first) return -1;
  for (uint32_t k = 0; k < count; ++k) out[k] = sdnap::epochs::source_at(st, st.series[first + k], jd_whole, jd_frac);
  return 0;
}

/// Set k of series i (its index in the series, by epoch) at a split Julian date, without selection or blend: the TEME
/// state (6 doubles: km, km/s). 0, -1 for an unknown series or set, or the theory's error code.
SDNAP_EXPORT("sdnap_epochs_set_at")
int32_t sdnap_epochs_set_at(uint32_t i, uint32_t k, double jd_whole, double jd_frac, double* out) {
  auto& st = sdnap::epochs::resident();
  if (i >= st.series.size() || out == nullptr || k >= st.series[i].count) return -1;
  bool have_p = false;
  const double jd[2] = {jd_whole, jd_frac};
  return sdnap::epochs::state_of(st, st.series[i], k, sdnap::epochs::minutes_of(jd_whole, jd_frac), out, out + 3, nullptr, have_p, jd);
}
