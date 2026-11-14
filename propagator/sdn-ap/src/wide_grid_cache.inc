/// Grids held by exact key: each counted, freed when its last holder drops it, the kGridIdle most recently dropped kept until other
/// grids are built (a grid a fit built is freed at once).
struct GridSlot {
  WideGrid* g;
  int cls, refs;
  uint32_t stamp;  // when it last became idle
  bool transient;  // built inside a fit: freed when its last holder drops it, never kept idle
};
/// Idle grids kept: a catalog refresh finds its objects' grids; the least recently used goes first. kGridSlots bounds every grid
/// held. SPEC 16.11 (stack #497): the cache is also bounded by bytes, live and idle together (kGridCacheBytes by default,
/// sdnap_wide_grid_budget sets it): an idle grid is freed while the cache's bytes, with the grid about to be built, exceed the
/// bound; a grid in use is never freed. A grid at the tesseral cap (12 above the switch) on 128 anomalies is at most
/// kGridMaxBytes. The bound changes which grids are kept, never a grid's bytes: a grid is a pure function of its key.
constexpr int kGridIdle = 128, kGridSlots = 256;
constexpr size_t kGridCacheBytes = static_cast<size_t>(512) << 20;
static_assert(kGridMaxBytes * 64 <= kGridCacheBytes, "the cache's default bound holds at least 64 of the largest grids");
struct GridCache {
  int32_t word;
  int count;
  uint32_t clock;
  size_t bytes;                     // the held grids' allocated bytes (WideGrid::alloc_bytes), live and idle
  size_t budget = kGridCacheBytes;  // the bound on them (sdnap_wide_grid_budget, under the lock)
  GridSlot slot[kGridSlots];
};
/// Frees the least recently used idle grid while more than `keep` are idle or the held bytes with `extra` more exceed the
/// budget (the cache's lock held).
inline void evict_idle(struct GridCache& c, int keep, size_t extra = 0);
inline GridCache& grid_cache() {
  static GridCache c{};
  return c;
}
inline void cache_lock(int32_t* w) {
  int32_t expected = 0;
  while (!__atomic_compare_exchange_n(w, &expected, 1, false, __ATOMIC_ACQUIRE, __ATOMIC_RELAXED)) expected = 0;
}
inline void cache_unlock(int32_t* w) { __atomic_store_n(w, 0, __ATOMIC_RELEASE); }
inline void free_grid(WideGrid* g) {
  wide_grid_release(*g);
  std::free(g);
}

/// The fit's scope (SPEC 16.11): while a FitGridScope lives on a thread, a grid built by a set initialized there (a fit's nominal,
/// trial steps and copies, all made on the fit's calling thread; the pool's threads serve batch flights only) is freed when its last
/// holder drops it, never kept idle. Nesting counts; the guard clears on every exit from its scope.
inline thread_local int32_t g_fit_grid_depth = 0;
inline int32_t& fit_grid_depth() {
  return g_fit_grid_depth;
}
struct FitGridScope {
  FitGridScope() { ++fit_grid_depth(); }
  ~FitGridScope() { --fit_grid_depth(); }
  FitGridScope(const FitGridScope&) = delete;
  FitGridScope& operator=(const FitGridScope&) = delete;
};
inline bool fit_grids_now() { return fit_grid_depth() > 0; }

/// Grid lookups since the last reset: [0] by sets outside a fit, [1] by a fit's sets (SPEC 16.11; read by sdnap_wide_grid_stats).
inline int64_t* grid_counts() {
  static int64_t counts[3] = {0, 0, 0};  // [2] the grids built since the instance began
  return counts;
}

struct GridCache;
inline GridCache& grid_cache();
inline void cache_contents(double& slots, double& bytes);

/// SPEC 16.11: out[0] the grids the cache holds, out[1] their bytes and out[2] the grids built since the instance began.
extern "C" __attribute__((export_name("sdnap_wide_grid_cache"))) int32_t sdnap_wide_grid_cache(double* out) {
  cache_contents(out[0], out[1]);
  out[2] = static_cast<double>(__atomic_load_n(&grid_counts()[2], __ATOMIC_RELAXED));
  return 0;
}

/// SPEC 16.11: out[0] the grid lookups by sets outside a fit and out[1] those by a fit's sets since the last reset; reset != 0
/// zeroes them after reading.
extern "C" __attribute__((export_name("sdnap_wide_grid_stats"))) int32_t sdnap_wide_grid_stats(int32_t reset, double* out) {
  int64_t* c = grid_counts();
  out[0] = static_cast<double>(__atomic_load_n(&c[0], __ATOMIC_RELAXED));
  out[1] = static_cast<double>(__atomic_load_n(&c[1], __ATOMIC_RELAXED));
  if (reset != 0) {
    __atomic_store_n(&c[0], 0, __ATOMIC_RELAXED);
    __atomic_store_n(&c[1], 0, __ATOMIC_RELAXED);
  }
  return 0;
}

/// The grid keyed by (degree, class, n, e, i), bitwise: a live or idle one with that key, else a new one; nullptr out of memory. A
/// grid is a pure function of its key, so a hit and a rebuild give the same bytes. `transient` (a fit's set): a grid it builds is
/// freed when its last holder drops it, never kept idle.
inline WideGrid* wide_grid_acquire(int degree, int cls, double n, double e, double inc, bool transient = false) {
  __atomic_add_fetch(transient ? &grid_counts()[1] : &grid_counts()[0], 1, __ATOMIC_RELAXED);
  GridCache& c = grid_cache();
  cache_lock(&c.word);
  for (int k = 0; k < c.count; ++k) {
    const WideGrid& g = *c.slot[k].g;
    if (g.degree == degree && c.slot[k].cls == cls && n == g.n && e == g.e && inc == g.i) {
      ++c.slot[k].refs;
      WideGrid* hit = c.slot[k].g;
      cache_unlock(&c.word);
      return hit;
    }
  }
  // a build: the least recently used idle grid goes first beyond kGridIdle - 1, and while the held bytes with this grid's
  // largest size exceed the budget, so a worker holds a bounded number and the instance a bounded size
  evict_idle(c, kGridIdle - 1, wide_grid_bytes_bound(degree));
  cache_unlock(&c.word);
  WideGrid* g = static_cast<WideGrid*>(sdnap::mem::calloc(1, sizeof(WideGrid)));
  if (g == nullptr) return nullptr;
  if (!wide_grid_build(degree, cls, n, e, inc, *g)) { std::free(g); return nullptr; }
  __atomic_add_fetch(&grid_counts()[2], 1, __ATOMIC_RELAXED);
  cache_lock(&c.word);
  if (c.count < kGridSlots) {
    c.slot[c.count++] = GridSlot{g, cls, 1, 0, transient};
    c.bytes += g->alloc_bytes;
    cache_unlock(&c.word);
    return g;
  }
  cache_unlock(&c.word);
  free_grid(g);
  return nullptr;
}

/// SPEC 16.11: the cache's byte bound. bytes of 1 or more sets it (whole bytes, at most the address space: SIZE_MAX); a smaller
/// value only reads. out[0] the bound, out[1] the held bytes, out[2] the grids held, out[3] those idle (held by no set).
extern "C" __attribute__((export_name("sdnap_wide_grid_budget"))) int32_t sdnap_wide_grid_budget(double bytes, double* out) {
  GridCache& c = grid_cache();
  cache_lock(&c.word);
  if (bytes >= 1.0) {
    constexpr double kMax = static_cast<double>(SIZE_MAX);
    c.budget = bytes >= kMax ? SIZE_MAX : static_cast<size_t>(bytes);
    evict_idle(c, kGridIdle);
  }
  if (out != nullptr) {
    int idle = 0;
    for (int k = 0; k < c.count; ++k) idle += c.slot[k].refs == 0 ? 1 : 0;
    out[0] = static_cast<double>(c.budget);
    out[1] = static_cast<double>(c.bytes);
    out[2] = static_cast<double>(c.count);
    out[3] = static_cast<double>(idle);
  }
  cache_unlock(&c.word);
  return 0;
}

/// Adds a holder to a grid already held.
/// A held grid's bytes shared among its holders (a grid of one exact key serves every set that asks for it).
inline double wide_grid_share(const WideGrid* g) {
  if (g == nullptr) return 0.0;
  GridCache& c = grid_cache();
  cache_lock(&c.word);
  int refs = 1;
  for (int k = 0; k < c.count; ++k)
    if (c.slot[k].g == g) { refs = c.slot[k].refs > 0 ? c.slot[k].refs : 1; break; }
  cache_unlock(&c.word);
  return static_cast<double>(sizeof(WideGrid) + wide_grid_bytes(*g)) / refs;
}

inline void wide_grid_ref(WideGrid* g) {
  GridCache& c = grid_cache();
  cache_lock(&c.word);
  for (int k = 0; k < c.count; ++k)
    if (c.slot[k].g == g) { ++c.slot[k].refs; break; }
  cache_unlock(&c.word);
}

/// Drops a holder; the last holder's grid stays idle until the next build.
inline void wide_grid_drop(WideGrid* g) {
  if (g == nullptr) return;
  GridCache& c = grid_cache();
  cache_lock(&c.word);
  for (int k = 0; k < c.count; ++k)
    if (c.slot[k].g == g) {
      if (--c.slot[k].refs == 0) {
        if (c.slot[k].transient) {  // built inside a fit: not kept idle
          c.bytes -= c.slot[k].g->alloc_bytes;
          free_grid(c.slot[k].g);
          c.slot[k] = c.slot[--c.count];
        } else {
          c.slot[k].stamp = ++c.clock;
          evict_idle(c, kGridIdle);
        }
      }
      break;
    }
  cache_unlock(&c.word);
}

inline void cache_contents(double& slots, double& bytes) {
  GridCache& c = grid_cache();
  cache_lock(&c.word);
  slots = c.count;
  bytes = 0.0;
  bytes = static_cast<double>(c.bytes);  // the same count sdnap_wide_grid_budget reports: each grid's allocated bytes
  cache_unlock(&c.word);
}

inline void evict_idle(GridCache& c, int keep, size_t extra) {
  for (;;) {
    int idle = 0, oldest = -1;
    for (int k = 0; k < c.count; ++k)
      if (c.slot[k].refs == 0) {
        ++idle;
        if (oldest < 0 || c.slot[k].stamp < c.slot[oldest].stamp) oldest = k;
      }
    if (oldest < 0 || (idle <= keep && c.bytes + extra <= c.budget)) return;
    c.bytes -= c.slot[oldest].g->alloc_bytes;
    free_grid(c.slot[oldest].g);
    c.slot[oldest] = c.slot[--c.count];
  }
}


