// -----------------------------------------------------------------------------
// Frames (SPEC 19): short Chebyshev cells of AP's own states, served by entries of their own.
// A cell holds six polynomials (position, velocity; position alone with the position-only flag) over one window of a grid anchored at its
// record's epoch. A window that cannot be served is stored as a tombstone: a header-only cell with the reason. The store of cells is a slab
// allocated at sdnap_frames_open through the counted allocator; a refill row allocates only its cold set, released inside the row (the first
// row on a thread also makes that thread's caches, kept: SPEC 9). Nothing here is written to a record, and no export of the epoch store
// reads a cell; the only write to the store is its short-day scratch field, which every export sets before it reads it (rows_cover).
// One host thread: frames and refills are called one after the other, never during a batch of the pool.
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
constexpr double kEndGap = 1.0e-6;           ///< minutes: the last instant of a window that is checked and tested against the weather rows (a window ends where the next begins; a UTC midnight is the end of the rows)
constexpr double kMaxAheadSeconds = kBaseMinutes * 60.0;  ///< refill clamps `ahead` to one base window
constexpr uint32_t kHeaderBytes = 24;        ///< mid, half-span (doubles, minutes); np, nv, hp, hv (bytes); holder (u32: series << 1 | slot)
constexpr uint32_t kClassBytes = 64;         ///< cells are cut in classes of this many bytes
constexpr uint32_t kClasses = 65;            ///< class c holds c * kClassBytes bytes, c in [1, 49] (the largest cell is 3,096 bytes); the table is sized 65
constexpr int kDenseMult = 8;                ///< sets that need the dense check: the check has this many times the points
constexpr double kLimit3D = 8.0e-6;          ///< km: no served state is farther than this (3-D) from AP's at a check point (2 mm under the 1 cm a dense scan allows between points)
constexpr double kLimitVel3D = 8.0e-8;       ///< km/s: the same in velocity (3-D), beside the 5e-5 m/s of each axis
constexpr double kDenseLineKm = 500.0;       ///< a set whose perigee height is under this at BTERM 0.01 m^2/kg has output that steps (SPEC 19.5): it takes the dense check
constexpr double kDenseKmPerDecade = 80.0;   ///< the line moves up by this much for each decade of BTERM above 0.01 (measured from 0.001 to 1), and down for each below
constexpr double kDenseMinKm = 300.0, kDenseMaxKm = 800.0;  ///< the line's limits (a set without drag has no steps: BTERM 0 takes the lower)
constexpr uint32_t kMaxCellBytes = kHeaderBytes + 2 * 24 * kNodes;  ///< a cell with every coefficient in doubles
constexpr uint32_t kFlagPositionOnly = 1;    ///< open: no velocity at all; frames_at writes three planes
constexpr uint8_t kFreeMark = 0xFF;          ///< byte 16 of a cell on a free list (byte 17: its class)

/// Statuses a frame states (one per object).
constexpr int32_t kServed = 0;
constexpr int32_t kNoSegment = 1;       ///< no cell holds this time (a window not attempted): the host calls refill
constexpr int32_t kNotServedHere = 2;   ///< this entry never serves the object (wide, several sets, a forecast, not AP, a hand-over set)
constexpr int32_t kApRefuses = 3;       ///< AP itself refuses the object in the window holding this time (decay, weather rows short) or at all (the set cannot be made)
constexpr int32_t kBuilderFails = 4;    ///< no window of 3 minutes holds the tolerance here

/// Return codes of the entries.
constexpr int32_t kBadArgument = -1;
constexpr int32_t kOutOfMemory = -2;    ///< a counted allocation failed (stats[11]: the bytes asked)
constexpr int32_t kBudgetTooSmall = -3; ///< the budget cannot hold the table and one largest cell (stats[11]: the bytes needed)
constexpr int32_t kStoreChanged = -4;   ///< a load replaced the store since open: every status is kNoSegment, and a refill reads the store again
constexpr int32_t kNotOpen = -5;
constexpr int32_t kReopen = -6;         ///< the store holds more series than open's table: open again

struct Obj {
  double ew = 0, ef = 0;       ///< the record's epoch, split Julian date
  uint32_t cur = 0, nxt = 0;   ///< slab offsets of the current and the following cell (0: none)
  uint8_t kind = 0;            ///< 0 served by this entry; kNotServedHere; kApRefuses: the set cannot be made
  uint8_t pad[7] = {};
};

struct Sweep {
  bool valid = false;
  double w = 0, f = 0, ahead = 0;
  int pass = 0;                ///< 0: the cells `now` needs, 1: the cells `now + ahead` needs, 2: done
  uint32_t k = 0;              ///< the place in the sequence that follows the last one visited (the priority list, then the objects in index order)
  uint32_t pc = 0;             ///< the priority list's length and its hash: a sweep belongs to one list
  uint64_t ph = 0;
  double w0 = 0, f0 = 0;       ///< the clock at which pass 0 began (again, after its one rerun)
  bool rerun = false;          ///< pass 0 has been run again for a clock that advanced while it ran
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
  size_t block_bytes = 0, table_bytes = 0, slab_bytes = 0, used = 0, free_bytes = 0;  ///< free_bytes: the bytes of the cells on the free lists
  uint32_t free_head[kClasses] = {};
  double needed = 0;
  Sweep sweep;
  uint64_t rows = 0, rows_oom = 0, stored = 0, split = 0, full = 0, live = 0, live_bytes = 0;
  uint64_t tomb_ap = 0, tomb_builder = 0, compactions = 0, moved = 0, visits = 0;
};

inline State& state() {
  static State s;
  return s;
}

struct RowOut {
  alignas(8) uint8_t cell[4096];
  uint32_t bytes = 0, splits = 0;
  int result = 0;
  uint8_t tomb = 0;
};

constexpr uint32_t kBatchRows = 32;
struct Candidate {
  uint32_t index, place;
  double t;
  RowOut out;
};
struct Batch {
  Candidate rows[kBatchRows];
  RowOut retry;
  uint32_t count = 0, end = 0;
  bool pos_only = false, pooled = false;
};
inline Batch* g_batch = nullptr;
inline uint32_t g_identity_failures = 0;
/// Diagnostic builds: select allocation failures by object and physical attempt.
inline void (*g_attempt_hook)(uint32_t index, bool pooled) = nullptr;

inline bool is_tombstone(const uint8_t* c) { return c[16] == 0; }
inline uint32_t bytes_of_cell(int np, int nv, int hp, int hv) {
  if (np == 0) return kHeaderBytes;  // a tombstone
  auto grp = [](int n, int h) { return static_cast<uint32_t>(24 * h + 12 * (n - h) + 7) & ~7u; };
  return kHeaderBytes + grp(np, hp) + grp(nv, hv);
}
inline uint32_t cell_bytes(const uint8_t* c) { return bytes_of_cell(c[16], c[17], c[18], c[19]); }
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

/// The cell's state at t (minutes from the record's epoch): km and, when the cell has a velocity polynomial, km/s (v is untouched otherwise).
inline void eval_cell(const uint8_t* c, double t, double r[3], double v[3]) {
  const double u = (t - cell_mid(c)) / cell_half(c);
  const int np = c[16], nv = c[17], hp = c[18], hv = c[19];
  const double* ph = reinterpret_cast<const double*>(c + kHeaderBytes);
  const float* pt = reinterpret_cast<const float*>(c + kHeaderBytes + 24 * hp);
  clen3(ph, pt, hp, np, u, r);
  if (nv > 0) {
    const uint32_t pos = (24u * hp + 12u * (np - hp) + 7u) & ~7u;
    clen3(reinterpret_cast<const double*>(c + kHeaderBytes + pos), reinterpret_cast<const float*>(c + kHeaderBytes + pos + 24 * hv), hv, nv, u, v);
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
    s.free_bytes -= static_cast<size_t>(c) * kClassBytes;
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
  const uint32_t bytes = cell_bytes(s.slab + off), c = class_of(bytes);
  std::memcpy(s.slab + off, &s.free_head[c], 4);
  s.slab[off + 16] = kFreeMark;
  s.slab[off + 17] = static_cast<uint8_t>(c);
  s.free_head[c] = off;
  s.free_bytes += static_cast<size_t>(c) * kClassBytes;
  --s.live;
  s.live_bytes -= bytes;
}
/// The live cells slid down over the free ones, in slab order, each holder's offset rewritten: only a slab full after this is full.
inline void compact(State& s) {
  size_t src = kClassBytes, dst = kClassBytes;
  while (src < s.used) {
    uint8_t* c = s.slab + src;
    if (c[16] == kFreeMark) { src += static_cast<size_t>(c[17]) * kClassBytes; continue; }
    const size_t size = static_cast<size_t>(class_of(cell_bytes(c))) * kClassBytes;
    if (dst != src) {
      std::memmove(s.slab + dst, c, size);
      uint32_t owner;
      std::memcpy(&owner, s.slab + dst + 20, 4);
      Obj& o = s.obj[owner >> 1];
      ((owner & 1u) ? o.nxt : o.cur) = static_cast<uint32_t>(dst);
      s.moved += size;
    }
    dst += size;
    src += size;
  }
  for (uint32_t c = 0; c < kClasses; ++c) s.free_head[c] = 0;
  s.used = dst;
  s.free_bytes = 0;
  ++s.compactions;
}

inline void release_state(State& s) {
  std::free(s.block);
  s = State{};
}

/// Eligibility: an AP set alone in its series (one set), without a carried forecast (SPEC 18) and without a hand-over, with gravity terms in its forces,
/// not on the wide branch.
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
  s.free_bytes = 0;
  s.live = 0;
  s.live_bytes = 0;
  s.sweep = Sweep{};
}

inline double minutes_from(const Obj& o, double whole, double frac) { return ((whole - o.ew) + (frac - o.ef)) * kMinutesPerDay; }

// ---- the builder ----
struct Built {
  double coef[6][kNodes];
  int np, nv;
};

/// Whether the set's output steps (AP's baked coefficients change at the parts of a bracket), so that a window must be checked at many points: a function of the
/// record alone, its perigee height against a line that moves with BTERM (SPEC 19.5 has the measured table).
inline bool needs_dense_check(const epochs::Entry& en) {
  const double n = en.row.mean_motion_rev_day * kTwoPi / 86400.0;  // rad/s
  if (!(n > 0.0)) return false;
  const double a = std::cbrt(398600.4418 / (n * n));
  const double bt = en.row.bterm;
  double line = bt > 0.0 ? kDenseLineKm + kDenseKmPerDecade * std::log10(bt / 0.01) : kDenseMinKm;
  line = std::fmin(std::fmax(line, kDenseMinKm), kDenseMaxKm);
  return a * (1.0 - en.row.eccentricity) - 6378.137 < line;
}

/// 0: stored in cell (size in `bytes`); 1: AP refuses somewhere in the window; 2: the tolerance is not held.
/// Samples and checks are taken ascending in time for a window after the epoch and descending for a window before it: the set is flown from the epoch toward the window.
inline int build_window(xpt::XpSat& xp, epochs::Store& st, const epochs::Entry& en, double a, double b, bool pos_only, uint8_t (&cell)[4096], uint32_t& bytes) {
  const double mid = 0.5 * (a + b), half = 0.5 * (b - a);
  // The order of the flight is the one that is right on every build: a window lies on one side of the epoch (the grid is anchored on it), a row's cold set is
  // flown toward the window from the epoch (ascending after it, descending before it), and no row's flight crosses the epoch within one set. A flight that
  // crosses its set's epoch is asked on the bracket before it and then on the one after, and a build that keeps one cache for both can answer from a stale one.
  const bool down = b <= 0.0;
  const bool dense = needs_dense_check(en);
  const int nchk = dense ? kChecks * kDenseMult : kChecks;
  // the rows of the record's weather must hold every day between the epoch and the window's far end (the end of a window is the next window's first instant)
  if (epochs::rows_cover(st, en, en.epoch + std::fmin(a, 0.0)) != 0 || epochs::rows_cover(st, en, en.epoch + (std::fmax(b, 0.0) - kEndGap)) != 0) return 1;
  // the window's two edges: its first instant and the last before the next window's. The edge nearer the epoch is asked before the nodes, the far one after
  // them (the flight's own order), and neither is a point of the nodes or of the checks
  const double edge_near = down ? b - kEndGap : a, edge_far = down ? a : b - kEndGap;
  double er[2][3], ev[2][3];
  if (xpt::xp_propagate(xp, edge_near, er[0], ev[0]) != kPropOk) return 1;
  double u[kNodes], f[6][kNodes];
  for (int j = 0; j < kNodes; ++j) {
    // node j (ascending in u) is Chebyshev point kNodes-1-j; a window before the epoch takes them descending
    const int jj = down ? kNodes - 1 - j : j;
    u[jj] = std::cos(kPi * (static_cast<double>(kNodes - 1 - jj) + 0.5) / kNodes);
    double r[3], v[3];
    if (xpt::xp_propagate(xp, mid + half * u[jj], r, v) != kPropOk) return 1;
    for (int c = 0; c < 3; ++c) { f[c][jj] = r[c]; f[3 + c][jj] = v[c]; }
  }
  if (xpt::xp_propagate(xp, edge_far, er[1], ev[1]) != kPropOk) return 1;
  Built bt;
  const int groups = 6;  // velocity is built and checked in a position-only build too: both modes halve alike, and drop it from storage only
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
  bt.nv = cut(3, kTolVel);
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
  const int hp = head_of(0, bt.np, kTailLimPos), hv = head_of(3, bt.nv, kTailLimVel);
  bytes = bytes_of_cell(bt.np, bt.nv, hp, hv);
  if (bytes > sizeof cell) return 2;
  std::memset(cell, 0, bytes);
  std::memcpy(cell, &mid, 8);
  std::memcpy(cell + 8, &half, 8);
  cell[16] = static_cast<uint8_t>(bt.np); cell[17] = static_cast<uint8_t>(bt.nv); cell[18] = static_cast<uint8_t>(hp); cell[19] = static_cast<uint8_t>(hv);
  {
    double* ph = reinterpret_cast<double*>(cell + kHeaderBytes);
    float* pt = reinterpret_cast<float*>(cell + kHeaderBytes + 24 * hp);
    for (int k = 0; k < bt.np; ++k) for (int a2 = 0; a2 < 3; ++a2) { if (k < hp) ph[k * 3 + a2] = bt.coef[a2][k]; else pt[(k - hp) * 3 + a2] = static_cast<float>(bt.coef[a2][k]); }
    if (bt.nv > 0) {
      const uint32_t pos = (24u * hp + 12u * (bt.np - hp) + 7u) & ~7u;
      double* vh = reinterpret_cast<double*>(cell + kHeaderBytes + pos);
      float* vt = reinterpret_cast<float*>(cell + kHeaderBytes + pos + 24 * hv);
      for (int k = 0; k < bt.nv; ++k) for (int a2 = 0; a2 < 3; ++a2) { if (k < hv) vh[k * 3 + a2] = bt.coef[3 + a2][k]; else vt[(k - hv) * 3 + a2] = static_cast<float>(bt.coef[3 + a2][k]); }
    }
  }
  // the check: the stored cell against AP at points that are not the sample points, in the direction of the flight, and at the window's two edges. Every set,
  // at every point: each axis within 5 mm and the 3-D distance within 8 mm; velocity each axis within 5e-5 m/s and 3-D within 8e-5 m/s. A set that needs the dense
  // check (needs_dense_check) has 8 times the points of the other, 96. The dense points are a uniform grid offset from the 96-point grid, not a superset of it.
  auto check_values = [&](double t, const double r[3], const double v[3]) -> int {
    double rc[3], vc[3];
    eval_cell(cell, t, rc, vc);
    const double dx = rc[0] - r[0], dy = rc[1] - r[1], dz = rc[2] - r[2], wx = vc[0] - v[0], wy = vc[1] - v[1], wz = vc[2] - v[2];
    if (!(std::fabs(dx) <= kTolPos && std::fabs(dy) <= kTolPos && std::fabs(dz) <= kTolPos && std::sqrt(dx * dx + dy * dy + dz * dz) <= kLimit3D)) return 2;
    if (!(std::fabs(wx) <= kTolVel && std::fabs(wy) <= kTolVel && std::fabs(wz) <= kTolVel && std::sqrt(wx * wx + wy * wy + wz * wz) <= kLimitVel3D)) return 2;
    return 0;
  };
  for (int e = 0; e < 2; ++e) {
    const int rc = check_values(e == 0 ? edge_near : edge_far, er[e], ev[e]);
    if (rc != 0) return rc;
  }
  for (int q = 0; q < nchk; ++q) {
    const int j = down ? nchk - 1 - q : q;
    const double t = mid + half * (-0.98 + 1.96 * (static_cast<double>(j) + 0.31) / nchk);
    double r[3], v[3];
    if (xpt::xp_propagate(xp, t, r, v) != kPropOk) return 1;
    const int rc = check_values(t, r, v);
    if (rc != 0) return rc;
  }
  if (pos_only) {  // the velocity group was built and checked; the cell keeps positions alone
    cell[17] = 0; cell[19] = 0;
    bytes = bytes_of_cell(bt.np, 0, hp, 0);
  }
  return 0;
}

/// One refill row: the leaf cell of the dyadic window holding t (minutes from the epoch, before or after it) of object i, from a cold set of its record,
/// released inside the row. A window AP refuses in, or that holds no tolerance, is halved down to 3 minutes; a window of 3 minutes that still fails
/// is a tombstone (its reason in byte 17: kApRefuses or kBuilderFails). All cell bytes and logical counter deltas belong to out.
/// Result: 1 a cell, 2 a tombstone, 0 a counted allocation failed, 3 the set cannot be made.
inline void build_row(epochs::Store& st, uint32_t i, double t, bool pos_only, RowOut& out) {
  out.bytes = 0; out.splits = 0; out.result = 0; out.tomb = 0;
  xpt::g_alloc_refused = 0;
  const epochs::Series& se = st.series[i];
  const epochs::Entry& en = st.entries[se.first];
  const uint32_t mark = mem::thread_failures();
  if (g_attempt_hook != nullptr) g_attempt_hook(i, xpt::batch_running());
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
    if (xpt::g_alloc_refused) {
      out.bytes = 0; out.splits = 0; out.tomb = 0; out.result = 4;
    } else out.result = rc;
  };
  if (mem::thread_failures() != mark) return done(0);
  if (err != kPropOk) { out.tomb = kApRefuses; return done(3); }
  double len = kBaseMinutes;
  for (int level = 0;; ++level, len *= 0.5) {
    const double a = std::floor(t / len) * len, b = a + len;
    const int rc = build_window(*xp, st, en, a, b, pos_only, out.cell, out.bytes);
    if (mem::thread_failures() != mark) return done(0);
    if (rc == 0) return done(1);
    if (len <= kMinWindowMinutes * 1.0001) {
      const double mid = 0.5 * (a + b), half = 0.5 * (b - a);
      std::memset(out.cell, 0, kHeaderBytes);
      std::memcpy(out.cell, &mid, 8);
      std::memcpy(out.cell + 8, &half, 8);
      out.tomb = out.cell[17] = static_cast<uint8_t>(rc == 1 ? kApRefuses : kBuilderFails);
      out.bytes = kHeaderBytes;
      return done(2);
    }
    ++out.splits;
  }
}

/// Applies one logical row's result on the caller, in sweep order.
inline void commit_row(State& s, uint32_t i, const RowOut& out) {
  ++s.rows;
  s.split += out.splits;
  if (out.result == 0) ++s.rows_oom;
  if (out.result == 3) s.obj[i].kind = kApRefuses;
  if (out.tomb == kApRefuses) ++s.tomb_ap;
  if (out.tomb == kBuilderFails) ++s.tomb_builder;
}

inline bool covered(const State& s, const Obj& o, double t) {
  const uint8_t* c = cell_at(s, o.cur);
  if (c != nullptr && covers_cell(c, t)) return true;
  c = cell_at(s, o.nxt);
  return c != nullptr && covers_cell(c, t);
}

/// Collects distinct missing objects without changing the sweep, object table, or slab.
inline void collect(const State& s, const Sweep& sw, double whole, double frac, double ahead,
                    const uint32_t* priority, uint32_t pc, uint32_t limit, Batch& b) {
  b.count = 0; b.end = sw.k; b.pooled = false;
  b.pos_only = (s.flags & kFlagPositionOnly) != 0;
  const uint32_t total = pc + s.objects;
  for (uint32_t k = sw.k; k < total; ++k) {
    const uint32_t i = k < pc ? priority[k] : k - pc;
    bool repeated = false;
    for (uint32_t q = 0; q < b.count; ++q) if (b.rows[q].index == i) repeated = true;
    if (repeated) break;
    b.end = k + 1;
    if (i >= s.objects || s.obj[i].kind != 0) continue;
    const Obj& o = s.obj[i];
    const double t0 = minutes_from(o, whole, frac), t = sw.pass == 0 ? t0 : t0 + ahead;
    const uint8_t* following = cell_at(s, o.nxt);
    const bool promoted = following != nullptr && covers_cell(following, t0);
    const uint8_t* current = cell_at(s, promoted ? o.nxt : o.cur);
    const bool held = (current != nullptr && covers_cell(current, t)) ||
        (sw.pass != 0 && !promoted && following != nullptr && covers_cell(following, t));
    if (held) continue;
    Candidate& row = b.rows[b.count++];
    row.index = i; row.place = k; row.t = t;
    if (b.count == limit) break;
  }
}

inline size_t batch_reserve(const Batch& b) {
  if (pool::g_reserve_off) return 0;
  const auto& st = epochs::resident();
  int degree = 0;
  for (uint32_t q = 0; q < b.count; ++q)
    degree = std::max(degree, st.entries[st.series[b.rows[q].index].first].forces.tesseral);
  degree = std::min(degree, xpt::tess::kFastCap);
  const int extra = xpt::tess::kShallowMax;
  const uint64_t table = static_cast<uint64_t>(xpt::tess::sp_comb_bound(degree, false, extra)) * sizeof(xpt::tess::SpCombCoef) +
      (xpt::keep_sp_raw() ? static_cast<uint64_t>(xpt::tess::sp_bound(degree, false, extra)) * sizeof(xpt::tess::SpCoef) : 0);
  const uint32_t builders = std::min(b.count, static_cast<uint32_t>(pool::job().threads + 1));
  return static_cast<size_t>((8u << 20) + builders * ((64u << 10) + table + sizeof(xpt::tess::SpTermsScratch)));
}

/// Publishes bounded private outputs; placement and logical counters remain on the caller.
inline int run_batch(Batch& b, double whole, double frac) {
  b.pooled = false;
  if (b.count < 2 || !pool::warm_thread()) {
    b.count = 1; b.end = b.rows[0].place + 1;
    return 0;
  }
  (void)drag::table();
  (void)xpt::tess::egm_tables();
  double tt1, tt2;
  (void)utc_to_tt(whole, frac, tt1, tt2);
  size_t reserve;
  while (!pool::reserve_room(reserve = batch_reserve(b))) {
    b.count = (b.count + 1) / 2;
    b.end = b.rows[b.count - 1].place + 1;
    if (b.count < 2) return 0;
  }
  pool::Job& j = pool::job();
  j.kind = pool::kJobFrames;
  j.frames = &b;
  j.count = b.count;
  j.deferred = nullptr;
  b.pooled = true;
  return pool::run(b.count, reserve, true);
}

/// Every held cell that covers neither time of a call goes back to the slab: the room a stalled row needs. Returns the cells freed.
inline uint32_t reclaim(State& s, double now_whole, double now_frac, double ahead_minutes) {
  uint32_t freed = 0;
  for (uint32_t i = 0; i < s.objects; ++i) {
    Obj& o = s.obj[i];
    if (o.kind != 0) continue;
    const double t0 = minutes_from(o, now_whole, now_frac), ta = t0 + ahead_minutes;
    for (int slot = 0; slot < 2; ++slot) {
      uint32_t& off = slot == 0 ? o.cur : o.nxt;
      const uint8_t* c = cell_at(s, off);
      if (c != nullptr && !covers_cell(c, t0) && !covers_cell(c, ta)) { slab_free(s, off); off = 0; ++freed; }
    }
  }
  return freed;
}

/// Stores cell (`bytes`) as object i's slot `slot` (0 current, 1 following). `droppable`: the held cells (bit 0 current, bit 1 following) that cover
/// neither time of the call; they go back to the slab after the new cell is stored, or earlier when the slab is full without them. A plain allocation is
/// tried first, a compaction only when it fails and the free bytes and the bump's remainder hold the cell. 0: no room (counted: stats[12]); the held cells are
/// untouched unless they were droppable and the room was needed.
inline bool place(State& s, uint32_t i, int slot, const uint8_t* cell, uint32_t bytes, int droppable) {
  const size_t need = static_cast<size_t>(class_of(bytes)) * kClassBytes;
  auto recoverable = [&]() { return (s.slab_bytes - s.used) + s.free_bytes >= need; };  // compaction can make room only if the free bytes and the bump's remainder hold the cell
  uint32_t at = slab_alloc(s, bytes);
  if (at == 0 && recoverable()) { compact(s); at = slab_alloc(s, bytes); }
  if (at == 0 && droppable != 0) {
    Obj& o = s.obj[i];
    if (droppable & 1) { slab_free(s, o.cur); o.cur = 0; }
    if (droppable & 2) { slab_free(s, o.nxt); o.nxt = 0; }
    droppable = 0;
    at = slab_alloc(s, bytes);  // the room the early frees made, by plain reuse; a compaction only if that fails and can help
    if (at == 0 && recoverable()) { compact(s); at = slab_alloc(s, bytes); }
  }
  if (at == 0) { ++s.full; return false; }
  std::memcpy(s.slab + at, cell, bytes);
  const uint32_t owner = (i << 1) | static_cast<uint32_t>(slot);
  std::memcpy(s.slab + at + 20, &owner, 4);
  ++s.live; ++s.stored;
  s.live_bytes += bytes;
  Obj& o = s.obj[i];
  if (droppable & 1) { slab_free(s, o.cur); o.cur = 0; }
  if (droppable & 2) { slab_free(s, o.nxt); o.nxt = 0; }
  if (slot == 0) o.cur = at; else o.nxt = at;
  return true;
}

}  // namespace frames
namespace pool {
void run_frames_row(const Job& j, uint32_t i) {
  frames::Candidate& row = j.frames->rows[i];
  frames::build_row(epochs::resident(), row.index, row.t, j.frames->pos_only, row.out);
}
}  // namespace pool
}  // namespace sdnap

/// Opens the frames over the resident store: one table row for each series, and a slab of `budget_bytes` less the table for the cells. The block is one
/// counted allocation made before an earlier open is given back: an open refused leaves the earlier frames standing. 0, or a refusal code (kBadArgument,
/// kOutOfMemory, kBudgetTooSmall: sdnap_frames_stats[11] holds the bytes asked or needed).
SDNAP_EXPORT("sdnap_frames_open")
int32_t sdnap_frames_open(double budget_bytes, uint32_t flags) {
  using namespace sdnap::frames;
  State& s = state();
  const sdnap::epochs::Store& st = sdnap::epochs::resident();
  if (sdnap::pool::g_frames_quarantined || st.pool_dead || sdnap::pool::load(&sdnap::pool::job().dead)) return sdnap::pool::kBatchPoolDead;
  if (!(budget_bytes >= 0.0) || budget_bytes > 4.0e9 || (flags & ~kFlagPositionOnly) != 0) return kBadArgument;
  const uint32_t n = static_cast<uint32_t>(st.series.size());
  const size_t table = (static_cast<size_t>(n) * sizeof(Obj) + 63u) & ~static_cast<size_t>(63u);
  const double need = static_cast<double>(table) + kClassBytes + static_cast<double>(class_of(kMaxCellBytes)) * kClassBytes;
  if (budget_bytes < need) { s.needed = need; return kBudgetTooSmall; }
  const size_t total = static_cast<size_t>(budget_bytes);
  uint8_t* block = static_cast<uint8_t*>(sdnap::mem::calloc(1, total));
  if (block == nullptr) { s.needed = budget_bytes; return kOutOfMemory; }
  const double needed = s.needed;
  release_state(s);
  s.needed = needed;
  s.block = block;
  s.obj = reinterpret_cast<Obj*>(block);
  s.block_bytes = total;
  s.table_bytes = static_cast<size_t>(n) * sizeof(Obj);
  s.slab = block + table;
  s.slab_bytes = total - table;
  s.cap_objects = n;
  s.flags = flags;
  s.open = true;
  fill_table(s);
  return 0;
}

SDNAP_EXPORT("sdnap_frames_close")
void sdnap_frames_close(void) {
  using namespace sdnap::frames;
  if (sdnap::pool::g_frames_quarantined) return;
  State& s = state();
  const double needed = s.needed;
  release_state(s);
  s.needed = needed;
}

/// The frame of objects [first, first + count) at one split Julian date: planes of `count` doubles (x, y, z, then vx, vy, vz unless the frames were opened with
/// the position-only flag: three planes, no velocity), frame 0 TEME (km, km/s) or 3 Earth-fixed (m, m/s); one status each in `status` (0 served, 1 no cell for
/// this time, 2 never served by this entry, 3 AP refuses here, 4 the builder fails here); the planes of an object not served are NaN. A pure read: it evaluates
/// polynomials and never flies AP. 0, or a negative code (-4: a load replaced the store, every status is 1).
SDNAP_EXPORT("sdnap_frames_at")
int32_t sdnap_frames_at(double jd_whole, double jd_frac, uint32_t first, uint32_t count, int32_t frame, double* out, int32_t* status) {
  using namespace sdnap::frames;
  State& s = state();
  const double nan = std::numeric_limits<double>::quiet_NaN();
  if (!s.open) return kNotOpen;
  if (out == nullptr || status == nullptr || (frame != 0 && frame != 3) || first > s.objects || count > s.objects - first) return kBadArgument;
  const bool stale = sdnap::epochs::resident().generation != s.generation;
  const bool pos_only = (s.flags & kFlagPositionOnly) != 0;
  const int planes = pos_only ? 3 : 6;
  // the rotation's sine and cosine once for the call; the products are teme_to_ecef_m's, so the bits are the same
  double rc = 1.0, rs = 0.0;
  if (frame == 3) { const double theta = sdnap::gmst(jd_whole, jd_frac); rc = std::cos(theta); rs = std::sin(theta); }
  for (uint32_t k = 0; k < count; ++k) {
    const Obj& o = s.obj[first + k];
    int32_t code = kNoSegment;
    double r[3] = {nan, nan, nan}, v[3] = {nan, nan, nan};
    if (!stale) {
      if (o.kind != 0) code = o.kind;
      else {
        const double t = minutes_from(o, jd_whole, jd_frac);
        const uint8_t* c = cell_at(s, o.cur);
        if (c == nullptr || !covers_cell(c, t)) c = cell_at(s, o.nxt);
        if (c != nullptr && covers_cell(c, t)) {
          if (is_tombstone(c)) code = c[17];
          else { eval_cell(c, t, r, v); code = kServed; }
        }
      }
    }
    status[k] = code;
    if (code == kServed && frame == 3) {
      const double x = (rc * r[0] + rs * r[1]) * 1000.0, y = (-rs * r[0] + rc * r[1]) * 1000.0, z = r[2] * 1000.0;
      r[0] = x; r[1] = y; r[2] = z;
      if (!pos_only) {
        const double vx = (rc * v[0] + rs * v[1]) * 1000.0, vy = (-rs * v[0] + rc * v[1]) * 1000.0;
        v[0] = vx + sdnap::kEarthRotationRate * y; v[1] = vy - sdnap::kEarthRotationRate * x; v[2] = v[2] * 1000.0;
      }
    }
    for (int c = 0; c < 3; ++c) { out[c * count + k] = r[c]; if (!pos_only) out[(3 + c) * count + k] = v[c]; }
  }
  (void)planes;
  return stale ? kStoreChanged : 0;
}

/// Builds the cells the time `now` needs (objects with none for it, `priority` first, in its order, then the others in index order), then the cells that
/// `now + ahead_seconds` needs (`ahead` clamped to 48 minutes), at most `max_rows` rows (one row: one cold set, one cell or tombstone; the module imports no
/// clock). A call resumes the sweep the last call left when `ahead`, the priority list (length and contents) and the store are the same and `now` is the same
/// or has advanced by at most a minute while the sweep is not done, so a full fill in slices of any size visits each object once; any other call starts a
/// sweep. When pass 0 ends and the clock has advanced since it began, pass 0 runs once more (a covered object costs a skip). A cell that holds this call's `now` is
/// never freed. A row that cannot be stored (the slab cannot hold the cell even after a reclaim pass over all objects and a compaction) is skipped and reported,
/// and the later objects are still visited; a counted allocation that failed ends the call. `result`, 7 int32: [0] places of the sequence left to visit for
/// `now`, [1] for `now + ahead`, [2] cells stored, [3] tombstones stored, [4] rows that could not be stored, [5] places visited, [6] the index of the last object
/// whose row could not be stored, or -1. Returns 0, or -1 (bad argument: a non-finite time, a negative `ahead`, `max_rows` under 1, more priority entries than
/// objects), -5 (not open), -6 (open again).
SDNAP_EXPORT("sdnap_frames_refill")
int32_t sdnap_frames_refill(double now_whole, double now_frac, double ahead_seconds, uint32_t max_rows, const uint32_t* priority, uint32_t priority_count, int32_t* result) {
  using namespace sdnap::frames;
  State& s = state();
  if (sdnap::pool::g_frames_quarantined || sdnap::epochs::resident().pool_dead || sdnap::pool::load(&sdnap::pool::job().dead)) return sdnap::pool::kBatchPoolDead;
  if (!s.open) return kNotOpen;
  if (!std::isfinite(now_whole) || !std::isfinite(now_frac) || !std::isfinite(ahead_seconds) || ahead_seconds < 0.0 || result == nullptr || max_rows < 1 ||
      (priority == nullptr && priority_count != 0))
    return kBadArgument;
  const sdnap::epochs::Store& st = sdnap::epochs::resident();
  if (st.generation != s.generation) {  // a load replaced the store: every cell is dropped, the table read again (before the list is checked against the series)
    if (st.series.size() > s.cap_objects) return kReopen;
    fill_table(s);
  }
  if (priority_count > s.objects) return kBadArgument;
  const double ahead = std::fmin(ahead_seconds, kMaxAheadSeconds);
  Sweep& sw = s.sweep;
  // the key of a sweep: the length and the contents (FNV-1a) of the priority list, `ahead`, and the store; `now` too, except that a sweep not yet done goes on
  // from its place when only `now` has advanced, by at most a minute (a display asks with a new time every frame): the cells stored do not depend on the order
  // the objects are visited in, only on the record and the time of the window
  uint64_t hash = 1469598103934665603ull;
  for (uint32_t k = 0; k < priority_count; ++k) { hash ^= priority[k]; hash *= 1099511628211ull; }
  const double advance = ((now_whole - sw.w) + (now_frac - sw.f)) * 86400.0;
  const bool same_clock = sw.w == now_whole && sw.f == now_frac;
  const bool goes_on = sw.valid && sw.pass < 2 && advance >= 0.0 && advance <= 60.0;
  if (!sw.valid || sw.ahead != ahead || sw.pc != priority_count || sw.ph != hash || !(same_clock || goes_on)) {
    sw = Sweep{}; sw.valid = true; sw.ahead = ahead; sw.pc = priority_count; sw.ph = hash; sw.w0 = now_whole; sw.f0 = now_frac;
  }
  sw.w = now_whole; sw.f = now_frac;
  const uint32_t total = priority_count + s.objects;
  const double ahead_min = ahead / 60.0;
  uint32_t rows = 0, stored = 0, tombs = 0, unstored = 0, visits = 0;
  int32_t stalled = -1;
  int32_t failure = 0;
  bool stop = false;
  uint32_t batch_end = sw.k, batch_row = 0;
  Batch* batch = nullptr;
  if (sdnap::pool::job().threads > 0 && sdnap::pool::load(&sdnap::pool::job().dead) == 0) {
    if (g_batch == nullptr) {
      void* memory = std::malloc(sizeof(Batch));
      if (memory != nullptr) g_batch = new (memory) Batch;
    }
    batch = g_batch;
  }
  auto holds = [&](uint32_t off, double t) { const uint8_t* c = cell_at(s, off); return c != nullptr && covers_cell(c, t); };
  while (sw.pass < 2 && !stop) {
    while (sw.k < total) {
      if (batch != nullptr && sw.k >= batch_end && rows < max_rows) {
        collect(s, sw, now_whole, now_frac, ahead_min, priority, priority_count, std::min(kBatchRows, max_rows - rows), *batch);
        batch_row = 0;
        if (batch->count > 0) {
          const int rc = run_batch(*batch, now_whole, now_frac);
          if (rc != 0) {
            sdnap::pool::g_frames_quarantined = true;
            sdnap::epochs::resident().pool_dead = 1;
            failure = rc; stop = true;
            break;
          }
        }
        batch_end = batch->end;
      }
      const uint32_t i = sw.k < priority_count ? priority[sw.k] : sw.k - priority_count;
      Obj& o = s.obj[i < s.objects ? i : 0];
      if (i >= s.objects || o.kind != 0) { ++sw.k; ++visits; continue; }
      const double t0 = minutes_from(o, now_whole, now_frac), ta = t0 + ahead_min, t = sw.pass == 0 ? t0 : ta;
      // the following cell is the current one when it holds this call's `now` (in either pass: a resumed sweep can meet it in the second)
      if (holds(o.nxt, t0)) {
        slab_free(s, o.cur);
        o.cur = o.nxt; o.nxt = 0;
        const uint32_t ow = (i << 1);
        std::memcpy(s.slab + o.cur + 20, &ow, 4);
      }
      if (sw.pass == 0 ? holds(o.cur, t0) : (holds(o.cur, ta) || holds(o.nxt, ta))) { ++sw.k; ++visits; continue; }
      // the cells a stored replacement may free: those that hold neither time of the call
      const int slot = sw.pass == 0 ? 0 : 1;
      const int droppable = ((o.cur != 0 && !holds(o.cur, t0) && !holds(o.cur, ta)) ? 1 : 0) | ((o.nxt != 0 && !holds(o.nxt, t0) && !holds(o.nxt, ta)) ? 2 : 0);
      if (rows >= max_rows) { stop = true; break; }
      RowOut serial;
      const bool pooled = batch != nullptr && batch->pooled;
      if (pooled && (batch_row >= batch->count || batch->rows[batch_row].index != i)) {
        ++g_identity_failures;
        sdnap::pool::g_frames_quarantined = true;
        sdnap::epochs::resident().pool_dead = 1;
        failure = sdnap::pool::kBatchPoolDead; stop = true;
        break;
      }
      ++rows;
      RowOut* built = pooled ? &batch->rows[batch_row++].out : &serial;
      if (pooled && built->result == 4) {
        built = &batch->retry;
        ++sdnap::xpt::batch_stats().deferred;
        build_row(sdnap::epochs::resident(), i, t, (s.flags & kFlagPositionOnly) != 0, *built);
      } else if (!pooled) build_row(sdnap::epochs::resident(), i, t, (s.flags & kFlagPositionOnly) != 0, *built);
      RowOut& out = *built;
      commit_row(s, i, out);
      const int rc = out.result;
      if (rc == 0) { ++unstored; stalled = static_cast<int32_t>(i); stop = true; break; }  // a counted allocation failed: the memory, not this object
      if (rc == 3) { ++sw.k; ++visits; continue; }
      bool put = place(s, i, slot, out.cell, out.bytes, droppable);
      if (!put && reclaim(s, now_whole, now_frac, ahead_min) > 0) put = place(s, i, slot, out.cell, out.bytes, droppable);  // one reclaim pass over all objects, one retry
      if (!put) { ++unstored; stalled = static_cast<int32_t>(i); ++sw.k; ++visits; continue; }  // skipped and reported: the later objects are still visited
      if (rc == 1) ++stored; else ++tombs;
      ++sw.k; ++visits;
    }
    if (stop) break;
    batch_end = 0;
    if (sw.pass == 0 && !sw.rerun && (sw.w0 != now_whole || sw.f0 != now_frac)) {  // the clock advanced while pass 0 ran: once more, a covered object costs a skip
      sw.rerun = true; sw.w0 = now_whole; sw.f0 = now_frac; sw.k = 0;
      continue;
    }
    ++sw.pass;
    sw.k = 0;
  }
  s.visits += visits;
  result[0] = sw.pass == 0 ? static_cast<int32_t>(total - sw.k) : 0;
  result[1] = sw.pass == 0 ? static_cast<int32_t>(total) : sw.pass == 1 ? static_cast<int32_t>(total - sw.k) : 0;
  result[2] = static_cast<int32_t>(stored);
  result[3] = static_cast<int32_t>(tombs);
  result[4] = static_cast<int32_t>(unstored);
  result[5] = static_cast<int32_t>(visits);
  result[6] = stalled;
  return failure;
}

/// Twenty doubles: [0] objects, [1] objects this entry can serve, [2] cells held (tombstones included), [3] slab bytes, [4] slab bytes used, [5] table bytes,
/// [6] bytes of the block as allocated, [7] refill rows, [8] rows refused for memory, [9] cells stored, [10] windows halved, [11] bytes asked or needed by
/// the last refused open, [12] rows that could not be stored for want of room, [13] windows AP refused in, stored as tombstones (an object whose set cannot be
/// made counts once), [14] windows the builder failed at 3 minutes, stored as tombstones, [15] 1 when the store is the one read last, [16] the bytes the cells
/// held take (their own sizes, before the slab's classes of 64 bytes), [17] compactions of the slab, [18] bytes they moved, [19] places visited by refills.
SDNAP_EXPORT("sdnap_frames_stats")
int32_t sdnap_frames_stats(double* out) {
  using namespace sdnap::frames;
  State& s = state();
  if (out == nullptr) return kBadArgument;
  const double v[20] = {static_cast<double>(s.objects), static_cast<double>(s.eligible), static_cast<double>(s.live), static_cast<double>(s.slab_bytes),
                        static_cast<double>(s.used), static_cast<double>(s.table_bytes), static_cast<double>(s.block_bytes),
                        static_cast<double>(s.rows), static_cast<double>(s.rows_oom), static_cast<double>(s.stored), static_cast<double>(s.split), s.needed,
                        static_cast<double>(s.full), static_cast<double>(s.tomb_ap), static_cast<double>(s.tomb_builder),
                        sdnap::epochs::resident().generation == s.generation ? 1.0 : 0.0, static_cast<double>(s.live_bytes),
                        static_cast<double>(s.compactions), static_cast<double>(s.moved), static_cast<double>(s.visits)};
  for (int k = 0; k < 20; ++k) out[k] = v[k];
  return 0;
}
