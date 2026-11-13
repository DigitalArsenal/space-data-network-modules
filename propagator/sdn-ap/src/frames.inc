// -----------------------------------------------------------------------------
// Frames (SPEC 19): short Chebyshev segments of AP's own states, served by entries of their own.
// A segment ("cell") holds six polynomials (position, velocity) over one window of a grid anchored at its record's epoch. The
// store of cells is a slab allocated at sdnap_frames_open through the counted allocator; nothing is allocated afterwards
// except what one refill row needs for its cold set, released inside the row. Nothing here is written to a record, and no
// export of the epoch store reads a cell.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace frames {

constexpr double kBaseMinutes = 48.0;        ///< the base window of the grid
constexpr double kMinWindowMinutes = 3.0;    ///< the shortest window (48 halved four times)
constexpr int kNodes = 64;                   ///< Chebyshev sample points of a window
constexpr int kChecks = 96;                  ///< check points of a window, independent of the sample points
constexpr double kTolPos = 5.0e-6;           ///< km: the build tolerance in position
constexpr double kTolVel = 5.0e-8;           ///< km/s: the build tolerance in velocity
constexpr double kTailShare = 0.6;           ///< a truncation's dropped tail is under this share of the tolerance
constexpr double kFloatRel = 6.0e-8;         ///< the relative rounding of a float32 coefficient (2^-24 is 5.96e-8)
constexpr double kTailLimPos = 3.0e-8;       ///< km: the float32 tail's rounding bound in position (3e-5 m)
constexpr double kTailLimVel = 3.0e-10;      ///< km/s: the same in velocity (3e-7 m/s)
constexpr uint32_t kHeaderBytes = 24;
constexpr uint32_t kClassBytes = 64;         ///< cells are cut in classes of this many bytes
constexpr uint32_t kClasses = 65;            ///< class c holds c * kClassBytes bytes, c in [1, 64]
constexpr uint32_t kMinCellBytes = 256;      ///< what open assumes at least one cell of a served object takes
constexpr uint32_t kFlagPositionOnly = 1;    ///< open: no velocity polynomial; the velocity planes are the position polynomial's derivative

/// Statuses a frame states (one per object).
constexpr int32_t kServed = 0;
constexpr int32_t kNoSegment = 1;       ///< no cell for this time: the host calls refill
constexpr int32_t kNotServedHere = 2;   ///< this entry never serves the object (wide, several sets, a forecast, not AP, a hand-over set)
constexpr int32_t kApRefuses = 3;       ///< not served from this time: AP itself refuses the object (decay, rows short)
constexpr int32_t kBuilderFails = 4;    ///< not served from this time: no window of 3 minutes holds the tolerance

/// Return codes of the entries.
constexpr int32_t kBadArgument = -1;
constexpr int32_t kOutOfMemory = -2;    ///< a counted allocation failed (stats[11]: the bytes asked)
constexpr int32_t kBudgetTooSmall = -3; ///< the budget cannot hold the table and a minimum cell for each served object (stats[11]: the bytes needed)
constexpr int32_t kStoreChanged = -4;   ///< a load replaced the store since open: every status is kNoSegment until refill; refill re-reads the store
constexpr int32_t kNotOpen = -5;
constexpr int32_t kReopen = -6;         ///< the store holds more series than open's table: open again

struct Obj {
  double ew = 0, ef = 0;       ///< the record's epoch, split Julian date
  double fail_from = HUGE_VAL; ///< minutes from the epoch from which the object is not served (fail_kind)
  uint32_t cur = 0, nxt = 0;   ///< slab offsets of the current and the next cell (0: none)
  uint8_t kind = 0;            ///< 0 served by this entry, kNotServedHere otherwise
  uint8_t fail_kind = 0;
  uint8_t pad[6] = {};
};

struct State {
  bool open = false;
  uint32_t flags = 0;
  uint32_t generation = 0;        ///< the epoch store's, at the last sync
  uint32_t objects = 0, eligible = 0;
  uint32_t cap_objects = 0;       ///< the table's size
  uint8_t* block = nullptr;       ///< table, then slab
  Obj* obj = nullptr;
  uint8_t* slab = nullptr;
  size_t table_bytes = 0, slab_bytes = 0, used = 0;
  uint32_t free_head[kClasses] = {};
  double st[16] = {};             ///< the statistics of sdnap_frames_stats that are counters
  double needed = 0;
  uint64_t rows = 0, rows_oom = 0, stored = 0, split = 0, full = 0, live = 0, live_bytes = 0;
};

inline State& state() {
  static State s;
  return s;
}

alignas(8) inline uint8_t g_cell[4096];  ///< the cell under construction

inline uint32_t bytes_of_cell(int np, int nv, int hp, int hv) {
  auto grp = [](int n, int h) { return static_cast<uint32_t>(24 * h + 12 * (n - h) + 7) & ~7u; };
  return kHeaderBytes + grp(np, hp) + grp(nv, hv);
}
inline double cell_mid(const uint8_t* c) { double d; std::memcpy(&d, c, 8); return d; }
inline double cell_half(const uint8_t* c) { double d; std::memcpy(&d, c + 8, 8); return d; }

/// Three Chebyshev series (coefficients k-major, three axes a k): the head k < h in doubles, the tail in float32.
inline void clen3(const double* head, const float* tail, int h, int n, double u, double o[3]) {
  const double u2 = 2.0 * u;
  double a0 = 0, a1 = 0, a2 = 0, p0 = 0, p1 = 0, p2 = 0;
  for (int k = n - 1; k >= h && k >= 1; --k) {
    const float* ck = tail + (k - h) * 3;
    const double t0 = static_cast<double>(ck[0]) + u2 * a0 - p0, t1 = static_cast<double>(ck[1]) + u2 * a1 - p1, t2 = static_cast<double>(ck[2]) + u2 * a2 - p2;
    p0 = a0; p1 = a1; p2 = a2; a0 = t0; a1 = t1; a2 = t2;
  }
  for (int k = (h < n ? h : n) - 1; k >= 1; --k) {
    const double* ck = head + k * 3;
    const double t0 = ck[0] + u2 * a0 - p0, t1 = ck[1] + u2 * a1 - p1, t2 = ck[2] + u2 * a2 - p2;
    p0 = a0; p1 = a1; p2 = a2; a0 = t0; a1 = t1; a2 = t2;
  }
  if (n <= 0) { o[0] = o[1] = o[2] = 0.0; return; }
  if (h >= 1) { o[0] = head[0] + u * a0 - p0; o[1] = head[1] + u * a1 - p1; o[2] = head[2] + u * a2 - p2; }
  else { o[0] = static_cast<double>(tail[0]) + u * a0 - p0; o[1] = static_cast<double>(tail[1]) + u * a1 - p1; o[2] = static_cast<double>(tail[2]) + u * a2 - p2; }
}

/// The groups of a cell: position at the header's end, velocity after it (8-byte aligned).
struct Groups {
  const double* ph; const float* pt; const double* vh; const float* vt;
  int np, nv, hp, hv;
};
inline Groups groups_of(const uint8_t* c) {
  Groups g{};
  g.np = c[16]; g.nv = c[17]; g.hp = c[18]; g.hv = c[19];
  g.ph = reinterpret_cast<const double*>(c + kHeaderBytes);
  g.pt = reinterpret_cast<const float*>(c + kHeaderBytes + 24 * g.hp);
  const uint32_t pos = (24u * g.hp + 12u * (g.np - g.hp) + 7u) & ~7u;
  g.vh = reinterpret_cast<const double*>(c + kHeaderBytes + pos);
  g.vt = reinterpret_cast<const float*>(c + kHeaderBytes + pos + 24 * g.hv);
  return g;
}

/// The cell's state at t (minutes from the record's epoch): km and km/s. A cell without a velocity polynomial gives the position polynomial's derivative.
inline void eval_cell(const uint8_t* c, double t, double r[3], double v[3]) {
  const double half = cell_half(c), u = (t - cell_mid(c)) / half;
  const Groups g = groups_of(c);
  clen3(g.ph, g.pt, g.hp, g.np, u, r);
  if (g.nv > 0) { clen3(g.vh, g.vt, g.hv, g.nv, u, v); return; }
  // the derivative of the position series: d_{k-1} = d_{k+1} + 2 k c_k (k = n-1 .. 1), p' = d_0 / 2 + sum_{j >= 1} d_j T_j
  double c3[kNodes][3], d[kNodes + 2][3];
  for (int k = 0; k < g.np; ++k)
    for (int a = 0; a < 3; ++a) c3[k][a] = k < g.hp ? g.ph[k * 3 + a] : static_cast<double>(g.pt[(k - g.hp) * 3 + a]);
  for (int k = 0; k < g.np + 2; ++k) d[k][0] = d[k][1] = d[k][2] = 0.0;
  for (int k = g.np - 1; k >= 1; --k)
    for (int a = 0; a < 3; ++a) d[k - 1][a] = d[k + 1][a] + 2.0 * k * c3[k][a];
  for (int a = 0; a < 3; ++a) {
    double T0 = 1.0, T1 = u, s = 0.5 * d[0][a];
    if (g.np > 2) s += d[1][a] * T1;
    for (int j = 2; j < g.np - 1; ++j) { const double T2 = 2.0 * u * T1 - T0; s += d[j][a] * T2; T0 = T1; T1 = T2; }
    v[a] = s / half / 60.0;
  }
}

inline bool covers_cell(const uint8_t* c, double t) { const double m = cell_mid(c), h = cell_half(c); return t >= m - h && t < m + h; }
inline const uint8_t* cell_at(const State& s, uint32_t off) { return off != 0 ? s.slab + off : nullptr; }

// ---- the slab ----
inline uint32_t class_of(uint32_t bytes) { return (bytes + kClassBytes - 1) / kClassBytes; }
inline uint32_t slab_alloc(State& s, uint32_t bytes) {
  const uint32_t c = class_of(bytes);
  if (s.free_head[c] != 0) {
    const uint32_t off = s.free_head[c];
    std::memcpy(&s.free_head[c], s.slab + off, 4);
    return off;
  }
  const size_t need = static_cast<size_t>(c) * kClassBytes;
  if (s.used + need > s.slab_bytes) return 0;
  const uint32_t off = static_cast<uint32_t>(s.used);
  s.used += need;
  return off;
}
inline void slab_free(State& s, uint32_t off) {
  if (off == 0) return;
  const uint32_t bytes = bytes_of_cell(s.slab[off + 16], s.slab[off + 17], s.slab[off + 18], s.slab[off + 19]), c = class_of(bytes);
  std::memcpy(s.slab + off, &s.free_head[c], 4);
  s.free_head[c] = off;
  --s.live;
  s.live_bytes -= bytes;
}

inline void release_state(State& s) {
  std::free(s.block);
  s = State{};
}

/// Eligibility: an AP set alone in its series, flying its theory (no forecast, no hand-over), not wide.
inline bool eligible_entry(const epochs::Series& se, const epochs::Entry& en) {
  if (se.count != 1 || en.track || en.handover != HUGE_VAL || en.row.theory != kTheorySgp4Xp) return false;
  if (!(en.forces.tesseral > 0 || en.forces.zonal > 0)) return false;
  if (((en.branch >> 16) & 0xffu) != 0) return false;
  return std::isfinite(en.row.epoch_jd_whole) && std::isfinite(en.row.epoch_jd_frac);
}

/// The table from the resident store; every cell dropped.
inline void fill_table(State& s) {
  const epochs::Store& st = epochs::resident();
  s.objects = static_cast<uint32_t>(st.series.size());
  s.eligible = 0;
  s.generation = st.generation;
  for (uint32_t i = 0; i < s.objects; ++i) {
    const epochs::Series& se = st.series[i];
    const epochs::Entry& en = st.entries[se.first];
    Obj o;
    o.kind = eligible_entry(se, en) ? 0 : static_cast<uint8_t>(kNotServedHere);
    if (o.kind == 0) { o.ew = en.row.epoch_jd_whole; o.ef = en.row.epoch_jd_frac; ++s.eligible; }
    s.obj[i] = o;
  }
  for (uint32_t c = 0; c < kClasses; ++c) s.free_head[c] = 0;
  s.used = kClassBytes;
  s.live = 0;
  s.live_bytes = 0;
}

inline double minutes_from(const Obj& o, double whole, double frac) { return ((whole - o.ew) + (frac - o.ef)) * kMinutesPerDay; }

// ---- the builder ----
struct Built {
  double coef[6][kNodes];
  int np, nv;
};

/// 0: stored in g_cell (size in bytes); 1: AP refuses; 2: the tolerance is not held.
inline int build_window(xpt::XpSat& xp, epochs::Store& st, const epochs::Entry& en, double a, double b, bool pos_only, uint32_t& bytes) {
  const double mid = 0.5 * (a + b), half = 0.5 * (b - a);
  // the rows of the record's weather must hold every day the window flies through
  if (epochs::rows_cover(st, en, en.epoch + std::fmin(a, 0.0)) != 0 || epochs::rows_cover(st, en, en.epoch + std::fmax(b, 0.0)) != 0) return 1;
  double u[kNodes], f[6][kNodes];
  for (int j = 0; j < kNodes; ++j) {
    // ascending in time: node index kNodes-1-j has the j-th smallest u
    u[j] = std::cos(kPi * (static_cast<double>(kNodes - 1 - j) + 0.5) / kNodes);
    double r[3], v[3];
    if (xpt::xp_propagate(xp, mid + half * u[j], r, v) != kPropOk) return 1;
    for (int c = 0; c < 3; ++c) { f[c][j] = r[c]; f[3 + c][j] = v[c]; }
  }
  Built bt;
  const int groups = pos_only ? 3 : 6;
  for (int c = 0; c < groups; ++c) for (int k = 0; k < kNodes; ++k) bt.coef[c][k] = 0.0;
  for (int j = 0; j < kNodes; ++j) {
    double T0 = 1.0, T1 = u[j];
    for (int c = 0; c < groups; ++c) { bt.coef[c][0] += f[c][j]; bt.coef[c][1] += f[c][j] * T1; }
    for (int k = 2; k < kNodes; ++k) {
      const double T2 = 2.0 * u[j] * T1 - T0;
      for (int c = 0; c < groups; ++c) bt.coef[c][k] += f[c][j] * T2;
      T0 = T1; T1 = T2;
    }
  }
  for (int c = 0; c < groups; ++c) for (int k = 0; k < kNodes; ++k) bt.coef[c][k] *= (k == 0 ? 1.0 : 2.0) / kNodes;
  auto cut = [&](int c0, double tol) {
    for (int n = 1; n <= kNodes; ++n) {
      bool ok = true;
      for (int c = c0; c < c0 + 3 && ok; ++c) { double s = 0; for (int k = n; k < kNodes; ++k) s += std::fabs(bt.coef[c][k]); ok = s <= kTailShare * tol; }
      if (ok) return n;
    }
    return kNodes;
  };
  bt.np = cut(0, kTolPos);
  bt.nv = pos_only ? 0 : cut(3, kTolVel);
  // the head in doubles, the tail in float32: from the first k where the rest's magnitudes times the float's rounding stay under the limit
  auto head_of = [&](int c0, int n, double lim) {
    int h = n;
    for (int k = n - 1; k >= 0; --k) {
      bool ok = true;
      for (int c = c0; c < c0 + 3 && ok; ++c) { double s = 0; for (int q = k; q < n; ++q) s += std::fabs(bt.coef[c][q]); ok = s * kFloatRel < lim; }
      if (!ok) break;
      h = k;
    }
    // the rounding of the tail, summed, asserted under the limit (it is by construction; a group that fails it is kept in doubles)
    for (int c = c0; c < c0 + 3; ++c) {
      double s = 0;
      for (int q = h; q < n; ++q) s += std::fabs(bt.coef[c][q] - static_cast<double>(static_cast<float>(bt.coef[c][q])));
      if (s >= lim) return n;
    }
    return h;
  };
  const int hp = head_of(0, bt.np, kTailLimPos), hv = bt.nv > 0 ? head_of(3, bt.nv, kTailLimVel) : 0;
  bytes = bytes_of_cell(bt.np, bt.nv, hp, hv);
  if (bytes > sizeof g_cell) return 2;
  std::memset(g_cell, 0, bytes);
  std::memcpy(g_cell, &mid, 8);
  std::memcpy(g_cell + 8, &half, 8);
  g_cell[16] = static_cast<uint8_t>(bt.np); g_cell[17] = static_cast<uint8_t>(bt.nv); g_cell[18] = static_cast<uint8_t>(hp); g_cell[19] = static_cast<uint8_t>(hv);
  {
    double* ph = reinterpret_cast<double*>(g_cell + kHeaderBytes);
    float* pt = reinterpret_cast<float*>(g_cell + kHeaderBytes + 24 * hp);
    for (int k = 0; k < bt.np; ++k) for (int a2 = 0; a2 < 3; ++a2) { if (k < hp) ph[k * 3 + a2] = bt.coef[a2][k]; else pt[(k - hp) * 3 + a2] = static_cast<float>(bt.coef[a2][k]); }
    if (bt.nv > 0) {
      const uint32_t pos = (24u * hp + 12u * (bt.np - hp) + 7u) & ~7u;
      double* vh = reinterpret_cast<double*>(g_cell + kHeaderBytes + pos);
      float* vt = reinterpret_cast<float*>(g_cell + kHeaderBytes + pos + 24 * hv);
      for (int k = 0; k < bt.nv; ++k) for (int a2 = 0; a2 < 3; ++a2) { if (k < hv) vh[k * 3 + a2] = bt.coef[3 + a2][k]; else vt[(k - hv) * 3 + a2] = static_cast<float>(bt.coef[3 + a2][k]); }
    }
  }
  // the check: the stored cell against AP at points that are not the sample points
  for (int j = 0; j < kChecks; ++j) {
    const double uj = -0.98 + 1.96 * (static_cast<double>(j) + 0.31) / kChecks, t = mid + half * uj;
    double r[3], v[3], rc[3], vc[3];
    if (xpt::xp_propagate(xp, t, r, v) != kPropOk) return 1;
    eval_cell(g_cell, t, rc, vc);
    for (int c = 0; c < 3; ++c) {
      if (!(std::fabs(rc[c] - r[c]) <= kTolPos)) return 2;
      if (!pos_only && !(std::fabs(vc[c] - v[c]) <= kTolVel)) return 2;
    }
  }
  return 0;
}

/// One refill row: the cell of the dyadic window holding t (minutes from the epoch) of object i, built from a cold set of its record and released.
/// Returns 1 stored (cell offset in `off`), 0 nothing changed (out of memory, or no room: counted), 2 the object is marked not served from the window's start.
inline int row(State& s, uint32_t i, double t, uint32_t& off) {
  epochs::Store& st = epochs::resident();
  const epochs::Series& se = st.series[i];
  const epochs::Entry& en = st.entries[se.first];
  Obj& o = s.obj[i];
  const uint32_t mark = mem::failures();
  ++s.rows;
  xpt::XpSat* xp = nullptr;
  int32_t err = kPropOk;
  {
    ocm::Bind bind(en.forces, en.atmosphere);  // the set's own forces, rows and nodes, as slot_of binds them
    const Elements e = elements_of(en.row);
    drag::table();
    xp = static_cast<xpt::XpSat*>(mem::calloc(1, sizeof(xpt::XpSat)));
    err = xp == nullptr ? kPropRefused : xpt::xp_init(e, *xp);  // never xp_set_pooled: the set's caches are the thread's
  }
  auto done = [&](int rc) {
    if (xp != nullptr) { xpt::xp_release(*xp); std::free(xp); }
    return rc;
  };
  if (mem::failures() != mark) { ++s.rows_oom; return done(0); }
  if (err != kPropOk) { o.fail_from = -HUGE_VAL; o.fail_kind = static_cast<uint8_t>(kApRefuses); return done(2); }
  const bool pos_only = (s.flags & kFlagPositionOnly) != 0;
  double len = kBaseMinutes;
  for (int level = 0;; ++level, len *= 0.5) {
    const double a = std::floor(t / len) * len, b = a + len;
    uint32_t bytes = 0;
    const int rc = build_window(*xp, st, en, a, b, pos_only, bytes);
    if (mem::failures() != mark) { ++s.rows_oom; return done(0); }
    if (rc == 0) {
      const uint32_t at = slab_alloc(s, bytes);
      if (at == 0) { ++s.full; return done(0); }
      std::memcpy(s.slab + at, g_cell, bytes);
      ++s.live; ++s.stored; s.live_bytes += bytes;
      off = at;
      return done(1);
    }
    if (rc == 1) { o.fail_from = std::fmin(o.fail_from, a); o.fail_kind = static_cast<uint8_t>(kApRefuses); return done(2); }
    if (len <= kMinWindowMinutes * 1.0001) { o.fail_from = std::fmin(o.fail_from, a); o.fail_kind = static_cast<uint8_t>(kBuilderFails); return done(2); }
    ++s.split;
  }
}

inline bool covered(const State& s, const Obj& o, double t) {
  const uint8_t* c = cell_at(s, o.cur);
  if (c != nullptr && covers_cell(c, t)) return true;
  c = cell_at(s, o.nxt);
  return c != nullptr && covers_cell(c, t);
}

}  // namespace frames
}  // namespace sdnap

/// Opens the frames over the resident store: one table entry for each series, and a slab of `budget_bytes` less the table for
/// the cells. 0, or a refusal code (kOutOfMemory, kBudgetTooSmall: sdnap_frames_stats[11] holds the bytes asked or needed).
SDNAP_EXPORT("sdnap_frames_open")
int32_t sdnap_frames_open(double budget_bytes, uint32_t flags) {
  using namespace sdnap::frames;
  State& s = state();
  release_state(s);
  const sdnap::epochs::Store& st = sdnap::epochs::resident();
  if (!(budget_bytes >= 0.0) || budget_bytes > 4.0e9 || (flags & ~kFlagPositionOnly) != 0) return kBadArgument;
  const uint32_t n = static_cast<uint32_t>(st.series.size());
  uint32_t eligible = 0;
  for (uint32_t i = 0; i < n; ++i) if (eligible_entry(st.series[i], st.entries[st.series[i].first])) ++eligible;
  const double table = static_cast<double>(n) * sizeof(Obj);
  const double need = table + kClassBytes + static_cast<double>(eligible) * kMinCellBytes;
  if (budget_bytes < need) { state().needed = need; return kBudgetTooSmall; }
  const size_t total = static_cast<size_t>(budget_bytes);
  uint8_t* block = static_cast<uint8_t*>(sdnap::mem::calloc(1, total > 0 ? total : 1));
  if (block == nullptr) { state().needed = budget_bytes; return kOutOfMemory; }
  s.block = block;
  s.obj = reinterpret_cast<Obj*>(block);
  s.table_bytes = static_cast<size_t>(table);
  s.slab = block + ((s.table_bytes + 63u) & ~static_cast<size_t>(63u));
  s.slab_bytes = total - static_cast<size_t>(s.slab - block);
  s.cap_objects = n;
  s.flags = flags;
  s.open = true;
  fill_table(s);
  return 0;
}

SDNAP_EXPORT("sdnap_frames_close")
void sdnap_frames_close(void) {
  using namespace sdnap::frames;
  State& s = state();
  const double needed = s.needed;
  release_state(s);
  s.needed = needed;
}

/// The frame of objects [first, first + count) at one split Julian date: six planes of `count` doubles (x, y, z, vx, vy, vz), frame 0 TEME (km, km/s) or 3
/// Earth-fixed (m, m/s); one status each in `status` (0 served, 1 no segment, 2 not served by this entry, 3 AP refuses from this time, 4 the builder fails
/// from this time); the planes of an object not served are NaN. A pure read: it evaluates polynomials and never flies AP. 0, or a negative code.
SDNAP_EXPORT("sdnap_frames_at")
int32_t sdnap_frames_at(double jd_whole, double jd_frac, uint32_t first, uint32_t count, int32_t frame, double* out, int32_t* status) {
  using namespace sdnap::frames;
  State& s = state();
  const double nan = std::numeric_limits<double>::quiet_NaN();
  if (!s.open) return kNotOpen;
  if (out == nullptr || status == nullptr || (frame != 0 && frame != 3) || first > s.objects || count > s.objects - first) return kBadArgument;
  const bool stale = sdnap::epochs::resident().generation != s.generation;
  const double theta = frame == 3 ? sdnap::gmst(jd_whole, jd_frac) : 0.0;
  for (uint32_t k = 0; k < count; ++k) {
    const Obj& o = s.obj[first + k];
    int32_t code = kNoSegment;
    double r[3] = {nan, nan, nan}, v[3] = {nan, nan, nan};
    if (!stale) {
      if (o.kind != 0) code = kNotServedHere;
      else {
        const double t = minutes_from(o, jd_whole, jd_frac);
        if (t >= o.fail_from) code = o.fail_kind;
        else {
          const uint8_t* c = cell_at(s, o.cur);
          if (c == nullptr || !covers_cell(c, t)) c = cell_at(s, o.nxt);
          if (c != nullptr && covers_cell(c, t)) { eval_cell(c, t, r, v); code = kServed; }
        }
      }
    }
    status[k] = code;
    if (code == kServed && frame == 3) { double ro[3], vo[3]; sdnap::teme_to_ecef_m(theta, r, v, ro, vo); for (int q = 0; q < 3; ++q) { r[q] = ro[q]; v[q] = vo[q]; } }
    for (int c = 0; c < 3; ++c) { out[c * count + k] = r[c]; out[(3 + c) * count + k] = v[c]; }
  }
  return stale ? kStoreChanged : 0;
}

/// Builds the cells the time `now` needs (objects with no cell for it, `priority` first in its order, then the rest in index order), then the cells that
/// `now + ahead_seconds` needs, and returns after `max_rows` rows (one row: one cold set, one cell; the module reads no clock, the host counts its time).
/// Returns the objects still due (a cell missing for either time), or a negative code.
SDNAP_EXPORT("sdnap_frames_refill")
int32_t sdnap_frames_refill(double now_whole, double now_frac, double ahead_seconds, uint32_t max_rows, const uint32_t* priority, uint32_t priority_count) {
  using namespace sdnap::frames;
  State& s = state();
  if (!s.open) return kNotOpen;
  if (!(ahead_seconds >= 0.0) || (priority == nullptr && priority_count != 0)) return kBadArgument;
  const sdnap::epochs::Store& st = sdnap::epochs::resident();
  if (st.generation != s.generation) {  // a load replaced the store: every cell is dropped, the table read again
    if (st.series.size() > s.cap_objects) return kReopen;
    fill_table(s);
  }
  uint32_t rows = 0;
  auto order = [&](uint32_t k) { return k < priority_count ? priority[k] : k - priority_count; };
  const uint32_t total = priority_count + s.objects;
  for (int pass = 0; pass < 2; ++pass) {
    for (uint32_t k = 0; k < total && rows < max_rows; ++k) {
      const uint32_t i = order(k);
      if (i >= s.objects) continue;
      Obj& o = s.obj[i];
      if (o.kind != 0) continue;
      const double t0 = minutes_from(o, now_whole, now_frac), t = pass == 0 ? t0 : t0 + ahead_seconds / 60.0;
      if (t >= o.fail_from) continue;
      if (pass == 0) {
        if (const uint8_t* n = cell_at(s, o.nxt); n != nullptr && covers_cell(n, t)) {  // the next cell is the current one now
          slab_free(s, o.cur);
          o.cur = o.nxt; o.nxt = 0;
          continue;
        }
        const uint8_t* c = cell_at(s, o.cur);
        if (c != nullptr && covers_cell(c, t)) continue;
        uint32_t off = 0;
        ++rows;
        // neither held cell covers now: both go back to the slab first, so the new cell can take the room of one of them
        slab_free(s, o.cur); slab_free(s, o.nxt); o.cur = o.nxt = 0;
        if (row(s, i, t, off) == 1) o.cur = off;
      } else {
        if (covered(s, o, t)) continue;
        uint32_t off = 0;
        ++rows;
        slab_free(s, o.nxt); o.nxt = 0;  // a next cell that does not cover the ahead time is replaced
        if (row(s, i, t, off) == 1) o.nxt = off;
      }
    }
  }
  // the objects still due
  int32_t due = 0;
  for (uint32_t i = 0; i < s.objects; ++i) {
    const Obj& o = s.obj[i];
    if (o.kind != 0) continue;
    const double t0 = minutes_from(o, now_whole, now_frac);
    if ((t0 < o.fail_from && !covered(s, o, t0)) || (t0 + ahead_seconds / 60.0 < o.fail_from && !covered(s, o, t0 + ahead_seconds / 60.0))) ++due;
  }
  return due;
}

/// Seventeen doubles: [0] objects, [1] objects this entry can serve, [2] cells held, [3] slab bytes, [4] slab bytes used, [5] table bytes, [6] bytes held in all
/// (the one block), [7] refill rows, [8] rows refused for memory, [9] cells stored, [10] windows halved, [11] bytes asked or needed by the last refused
/// open, [12] rows refused for want of room in the slab, [13] objects not served because AP refuses them, [14] objects not served because the builder
/// fails at 3 minutes, [15] 1 when the store is the one read at open or the last refill, [16] the bytes the cells held take (their own sizes, before the
/// slab's classes of 64 bytes).
SDNAP_EXPORT("sdnap_frames_stats")
int32_t sdnap_frames_stats(double* out) {
  using namespace sdnap::frames;
  State& s = state();
  if (out == nullptr) return kBadArgument;
  double ap = 0, bf = 0;
  for (uint32_t i = 0; s.open && i < s.objects; ++i) {
    if (s.obj[i].kind != 0 || s.obj[i].fail_from == HUGE_VAL) continue;
    (s.obj[i].fail_kind == kApRefuses ? ap : bf) += 1;
  }
  const double v[17] = {static_cast<double>(s.objects), static_cast<double>(s.eligible), static_cast<double>(s.live), static_cast<double>(s.slab_bytes),
                        static_cast<double>(s.used), static_cast<double>(s.table_bytes), s.open ? static_cast<double>(s.table_bytes + s.slab_bytes) : 0.0,
                        static_cast<double>(s.rows), static_cast<double>(s.rows_oom), static_cast<double>(s.stored), static_cast<double>(s.split), s.needed,
                        static_cast<double>(s.full), ap, bf, sdnap::epochs::resident().generation == s.generation ? 1.0 : 0.0, static_cast<double>(s.live_bytes)};
  for (int k = 0; k < 17; ++k) out[k] = v[k];
  return 0;
}
