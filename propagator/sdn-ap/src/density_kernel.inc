// -----------------------------------------------------------------------------
// SDN-AP 2a.4: the catalog-shared density kernel. The atmosphere at a time is
// the same for every object, so NRLMSISE-00 x exp(s) is a value of a grid of
// geocentric-radius spheres (100-2500 km above the equatorial radius),
// geocentric latitudes and local solar times for each kernel time, and every
// object's drag nodes interpolate it: log rho linear in radius, four-point
// Lagrange in latitude and (periodic) in local time, linear in time between
// kernel times (3-hourly in UT). A kernel time's grid depends on that time and
// the environment only, so results do not depend on which object asked first.
// A grid cell is evaluated when a drag node first reads it, not when its
// kernel time is first asked for: an orbit reads about a tenth of a grid, and
// an orbit above the grid's top (2500 km) reads none, while the whole grid of
// every 3 hours of a propagation used to be evaluated (0.55 s a day of span,
// whatever the orbit). A cell's value is the same call whoever evaluates it
// and whenever, so the results are the same bytes as with every cell evaluated
// at once, at any thread count.
// The direct path (sdnap_drag_rates with the kernel off) is the reference.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace kernel {

constexpr int kLevels = 79;   // 100-400 km every 10, 420-1000 every 20, 1050-1500 every 50, 1600-2500 every 100
constexpr int kLats = 13;     // -90..90 every 15 deg (geocentric)
constexpr int kTimes = 16;    // local solar time every 1.5 h
constexpr int kCells = kLevels * kLats * kTimes;
constexpr int kSlots = 252;   // grids held at once (9 per day: eight 3-hourly and one late; 28 days)
constexpr double kStepDays = 0.125;
constexpr double kReKm = 6378.1363;  // SPEC 1.3

inline double level_height(int k) {
  if (k <= 30) return 100.0 + 10.0 * k;
  if (k <= 59) return 400.0 + 20.0 * (k - 30);
  if (k <= 68) return 1000.0 + 50.0 * (k - 59);
  return 1500.0 + 100.0 * (k - 68);
}

/// Index of the level at or below h (clamped so that k + 1 exists).
inline int level_below(double h) {
  int k;
  if (h < 400.0) k = static_cast<int>(std::floor((h - 100.0) / 10.0));
  else if (h < 1000.0) k = 30 + static_cast<int>(std::floor((h - 400.0) / 20.0));
  else if (h < 1500.0) k = 59 + static_cast<int>(std::floor((h - 1000.0) / 50.0));
  else k = 68 + static_cast<int>(std::floor((h - 1500.0) / 100.0));
  if (k < 0) k = 0;
  if (k > kLevels - 2) k = kLevels - 2;
  return k;
}

/// A cell not yet evaluated (the bits of a NaN: an evaluated cell is a finite log).
constexpr uint32_t kEmpty = 0xFFFFFFFFu;

struct Slot {
  int64_t key;      ///< 2 x kernel time index (floor(d50 / step)) + 1 for a late slot; -1 empty
  int32_t pins;     ///< readers holding the slot
  int32_t doy;      ///< the kernel time's day of year
  double sec;       ///< UT seconds of its day
  sdn::Environment env;  ///< the drivers its cells are evaluated under, taken when the slot is keyed
  uint32_t* logrho; ///< kCells float bit patterns, [level][lat][time]; kEmpty until a node reads the cell; null until a node reads any cell of the slot
};

struct Cache {
  int32_t lock;
  int32_t eval_lock;  ///< one NRLMSISE-00 evaluation at a time (its port keeps state in static storage)
  int32_t ready;
  uint64_t clock;
  Slot slot[kSlots];
  uint64_t used[kSlots];
};

inline Cache& cache() {
  static Cache c{};
  return c;
}

/// The slots (at the first SDN-AP ingest), none holding a grid yet: a slot's 64 KiB is allocated the first time a node
/// reads a cell of it and kept, so the memory is that of the span a drag regime propagated (64 KiB per 3 hours), up to
/// kSlots; an orbit above the grid's top allocates nothing.
inline bool prepare() {
  Cache& c = cache();
  if (c.ready) return true;
  for (int j = 0; j < kSlots; ++j) {
    c.slot[j].key = -1;
    c.slot[j].pins = 0;
    c.slot[j].logrho = nullptr;
    c.used[j] = 0;
  }
  c.ready = 1;
  return true;
}

inline void spin_lock(int32_t* w) {
  int32_t expected = 0;
  while (!__atomic_compare_exchange_n(w, &expected, 1, false, __ATOMIC_ACQUIRE, __ATOMIC_RELAXED)) expected = 0;
}
inline void spin_unlock(int32_t* w) { __atomic_store_n(w, 0, __ATOMIC_RELEASE); }

/// Keys a slot for kernel time index `key`: the time's drivers, no cell evaluated.
inline void build(Slot& s, int64_t key) {
  const double d50 = static_cast<double>(key >> 1) * kStepDays;
  // a late slot (0 UT) carries the environment of the day that ends there
  s.env = sdn::environment_at((key & 1) ? d50 - 1e-7 : d50);
  double D, N;
  drag::day_of_year(d50, D, N);
  s.doy = static_cast<int>(std::floor(D)) + 1;
  s.sec = (d50 - std::floor(d50)) * 86400.0;
  if (s.logrho != nullptr) std::memset(s.logrho, 0xFF, sizeof(uint32_t) * kCells);
  s.key = key;
}

/// log rho of cell (level k, latitude a, local-time b) of a slot, evaluated now if no node has read it yet. One thread
/// evaluates at a time (NRLMSISE-00 keeps state in static storage, as when the whole grid was built under the cache's
/// lock); a thread that waited for the lock finds the cell filled by the one before it, the same bits whoever fills it.
inline float cell(Slot& s, int k, int a, int b) {
  const int at = (k * kLats + a) * kTimes + b;
  uint32_t* grid = __atomic_load_n(&s.logrho, __ATOMIC_ACQUIRE);
  uint32_t bits = grid != nullptr ? __atomic_load_n(grid + at, __ATOMIC_RELAXED) : kEmpty;
  if (bits == kEmpty) {
    Cache& c = cache();
    spin_lock(&c.eval_lock);
    grid = s.logrho;
    if (grid == nullptr) {
      grid = static_cast<uint32_t*>(std::malloc(sizeof(uint32_t) * kCells));
      if (grid != nullptr) {
        std::memset(grid, 0xFF, sizeof(uint32_t) * kCells);
        __atomic_store_n(&s.logrho, grid, __ATOMIC_RELEASE);
      }
    }
    bits = grid != nullptr ? __atomic_load_n(grid + at, __ATOMIC_RELAXED) : kEmpty;
    if (bits == kEmpty) {
      const double r = 1.0 + level_height(k) / kReKm;
      const double latc = (-90.0 + 15.0 * a) * kDeg;
      double sl, cl;
      fm::sincos(latc, sl, cl);
      const double lst = 1.5 * b;
      const double lon = (lst - s.sec / 3600.0) * 15.0 * kDeg;
      double phi, h;
      drag::geodetic(r * cl, 0.0, r * sl, phi, h);
      const double rho = sdn::msis_raw(phi, lon, h, s.doy, s.sec, s.env);
      const float v = static_cast<float>(std::log(rho > 1e-300 ? rho : 1e-300));
      std::memcpy(&bits, &v, sizeof bits);
      if (grid != nullptr) __atomic_store_n(grid + at, bits, __ATOMIC_RELAXED);  // no grid to keep it in: the value is still the call's
    }
    spin_unlock(&c.eval_lock);
  }
  float v;
  std::memcpy(&v, &bits, sizeof v);
  return v;
}

/// The slot of kernel time index `key`, built if absent, pinned for reading.
inline Slot* acquire(int64_t key) {
  Cache& c = cache();
  spin_lock(&c.lock);
  int found = -1;
  for (int j = 0; j < kSlots; ++j)
    if (c.slot[j].key == key) { found = j; break; }
  if (found < 0) {
    uint64_t oldest = ~0ull;
    for (int j = 0; j < kSlots; ++j)
      if (c.slot[j].pins == 0 && c.used[j] < oldest) { oldest = c.used[j]; found = j; }
    if (found < 0) { spin_unlock(&c.lock); return nullptr; }
    build(c.slot[found], key);
  }
  c.slot[found].pins += 1;
  c.used[found] = ++c.clock;
  spin_unlock(&c.lock);
  return &c.slot[found];
}

inline void release(Slot* s) {
  Cache& c = cache();
  spin_lock(&c.lock);
  s->pins -= 1;
  spin_unlock(&c.lock);
}

/// Four-point Lagrange weights at fractional position q in [0, 1) between
/// nodes 1 and 2 of the stencil (nodes at -1, 0, 1, 2).
inline void lagrange4(double q, double w[4]) {
  w[0] = -q * (q - 1.0) * (q - 2.0) / 6.0;
  w[1] = (q + 1.0) * (q - 1.0) * (q - 2.0) / 2.0;
  w[2] = -(q + 1.0) * q * (q - 2.0) / 2.0;
  w[3] = (q + 1.0) * q * (q - 1.0) / 6.0;
}

/// log rho in one slot at height h above the equatorial radius, geocentric
/// latitude latc, local solar time lst (hours).
inline double sample(Slot& s, double h, double latc, double lst) {
  const int k = level_below(h);
  const double h0 = level_height(k), h1 = level_height(k + 1);
  const double qr = (h - h0) / (h1 - h0);
  double fa = (latc / kDeg + 90.0) / 15.0;
  int a = static_cast<int>(std::floor(fa));
  if (a < 1) a = 1;
  if (a > kLats - 3) a = kLats - 3;
  const double qa = fa - a;
  double wa[4];
  lagrange4(qa, wa);
  double fb = lst / 1.5;
  fb -= kTimes * std::floor(fb / kTimes);
  const int b = static_cast<int>(std::floor(fb));
  double wb[4];
  lagrange4(fb - b, wb);
  double out[2];
  for (int lev = 0; lev < 2; ++lev) {
    double acc = 0.0;
    for (int i = 0; i < 4; ++i) {
      double accb = 0.0;
      for (int j = 0; j < 4; ++j) accb += wb[j] * cell(s, k + lev, a - 1 + i, (b - 1 + j + kTimes) % kTimes);
      acc += wa[i] * accb;
    }
    out[lev] = acc;
  }
  return out[0] * (1.0 - qr) + out[1] * qr;
}

/// The two kernel times around d50, pinned for one rate evaluation.
struct Pair {
  Slot* s0;
  Slot* s1;
  double q;    ///< weight of s1
  double sec;  ///< UT seconds of day at d50
  double scale;  ///< exp(s(d50)), the density correction at the query time
};

inline bool acquire_pair(double d50, Pair& p) {
  const int64_t key = static_cast<int64_t>(std::floor(d50 / kStepDays));
  p.q = d50 / kStepDays - static_cast<double>(key);
  p.sec = (d50 - std::floor(d50)) * 86400.0;  // d50 counts from 1950 January 0.0 UTC
  p.scale = std::exp(sdn::dca_scale(d50, sdn::environment().s));
  const int64_t next = key + 1;
  p.s0 = acquire(2 * key);
  p.s1 = acquire(2 * next + ((next % 8) == 0 ? 1 : 0));  // 8 kernel times a day: 0 UT ends the day
  if (p.s0 == nullptr || p.s1 == nullptr) {
    if (p.s0 != nullptr) release(p.s0);
    if (p.s1 != nullptr) release(p.s1);
    p.s0 = p.s1 = nullptr;
    return false;
  }
  return true;
}

inline void release_pair(Pair& p) {
  if (p.s0 != nullptr) release(p.s0);
  if (p.s1 != nullptr) release(p.s1);
  p.s0 = p.s1 = nullptr;
}

/// Density (kg/m^3) at geocentric radius r (ER), geocentric latitude latc and
/// Earth-fixed longitude lon (rad) at the pair's time; 0 above the grid.
inline double density(const Pair& p, double r, double latc, double lon) {
  const double h = (r - 1.0) * kReKm;
  if (h > 2500.0) return 0.0;
  double lst = p.sec / 3600.0 + lon / kDeg / 15.0;
  lst -= 24.0 * std::floor(lst / 24.0);
  // local solar time is the frame: the same lst in both kernel times
  const double lr = sample(*p.s0, h, latc, lst) * (1.0 - p.q) + sample(*p.s1, h, latc, lst) * p.q;
  return std::exp(lr) * p.scale;
}

}  // namespace kernel
}  // namespace sdnap
