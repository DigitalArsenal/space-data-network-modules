// -----------------------------------------------------------------------------
// SDN-AP 2a.4: the catalog-shared density kernel. The atmosphere at a time is
// the same for every object, so NRLMSISE-00 x exp(s) is evaluated once per
// kernel time on a grid of geocentric-radius spheres (100-2500 km above the
// equatorial radius), geocentric latitudes and local solar times, and every
// object's drag nodes interpolate it: log rho linear in radius, four-point
// Lagrange in latitude and (periodic) in local time, linear in time between
// kernel times (3-hourly in UT). A kernel time's grid depends on that time and
// the environment only, so results do not depend on which object asked first.
// The direct path (sdnap_drag_rates with the kernel off) is the reference.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace kernel {

constexpr int kLevels = 79;   // 100-400 km every 10, 420-1000 every 20, 1050-1500 every 50, 1600-2500 every 100
constexpr int kLats = 13;     // -90..90 every 15 deg (geocentric)
constexpr int kTimes = 16;    // local solar time every 1.5 h
constexpr int kCells = kLevels * kLats * kTimes;
constexpr int kSlots = 96;    // grids held at once (9 per day: eight 3-hourly and one late; 10.7 days)
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

struct Slot {
  int64_t key;      ///< 2 x kernel time index (floor(d50 / step)) + 1 for a late slot; -1 empty
  int32_t pins;     ///< readers holding the slot
  int32_t pad;
  float* logrho;    ///< kCells values, [level][lat][time]
};

struct Cache {
  int32_t lock;
  int32_t ready;
  uint64_t clock;
  Slot slot[kSlots];
  uint64_t used[kSlots];
  float* storage;
};

inline Cache& cache() {
  static Cache c{};
  return c;
}

/// One allocation for every slot (at the first SDN-AP ingest); nothing grows after.
inline bool prepare() {
  Cache& c = cache();
  if (c.ready) return true;
  c.storage = static_cast<float*>(std::malloc(sizeof(float) * kCells * kSlots));
  if (c.storage == nullptr) return false;
  for (int j = 0; j < kSlots; ++j) {
    c.slot[j].key = -1;
    c.slot[j].pins = 0;
    c.slot[j].logrho = c.storage + static_cast<size_t>(j) * kCells;
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

/// Fills a slot's grid for kernel time index `key`.
inline void build(Slot& s, int64_t key) {
  const double d50 = static_cast<double>(key >> 1) * kStepDays;
  // a late slot (0 UT) carries the environment of the day that ends there
  const sdn::Environment env = sdn::environment_at((key & 1) ? d50 - 1e-7 : d50);
  double D, N;
  drag::day_of_year(d50, D, N);
  const int doy = static_cast<int>(std::floor(D)) + 1;
  const double sec = (d50 - std::floor(d50)) * 86400.0;
  for (int k = 0; k < kLevels; ++k) {
    const double r = 1.0 + level_height(k) / kReKm;
    for (int a = 0; a < kLats; ++a) {
      const double latc = (-90.0 + 15.0 * a) * kDeg;
      double sl, cl;
      fm::sincos(latc, sl, cl);
      for (int b = 0; b < kTimes; ++b) {
        const double lst = 1.5 * b;
        const double lon = (lst - sec / 3600.0) * 15.0 * kDeg;
        double phi, h;
        drag::geodetic(r * cl, 0.0, r * sl, phi, h);
        const double rho = sdn::msis_raw(phi, lon, h, doy, sec, env);
        s.logrho[(k * kLats + a) * kTimes + b] = static_cast<float>(std::log(rho > 1e-300 ? rho : 1e-300));
      }
    }
  }
  s.key = key;
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
inline double sample(const Slot& s, double h, double latc, double lst) {
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
    const float* base = s.logrho + (k + lev) * kLats * kTimes;
    double acc = 0.0;
    for (int i = 0; i < 4; ++i) {
      const float* row = base + (a - 1 + i) * kTimes;
      double accb = 0.0;
      for (int j = 0; j < 4; ++j) accb += wb[j] * row[(b - 1 + j + kTimes) % kTimes];
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
