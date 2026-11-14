// Exact keys outlive their payloads. All ownership and LRU changes hold the cache
// lock; a pin protects a published payload while a caller reads it.
constexpr size_t kGridCacheBytes = size_t(192) << 20;
constexpr size_t kGridMinimumBytes = 34 * kGridMaxBytes;
constexpr unsigned kGridBuckets = 2048;
struct GridCache {
  int32_t word;
  WideGrid* bucket[kGridBuckets];
  WideGrid* oldest;
  WideGrid* newest;
  size_t bytes, count, descriptors;
  size_t budget = kGridCacheBytes;
};
inline GridCache& grid_cache() { static GridCache c{}; return c; }
inline void cache_lock(int32_t* word) {
  int32_t expected = 0;
  while (!__atomic_compare_exchange_n(word, &expected, 1, false, __ATOMIC_ACQUIRE, __ATOMIC_RELAXED)) expected = 0;
}
inline void cache_unlock(int32_t* word) { __atomic_store_n(word, 0, __ATOMIC_RELEASE); }
inline unsigned grid_hash(int degree, int cls, double n, double e, double i) {
  uint64_t h = unsigned(degree * 3 + cls);
  for (double x : {n, e, i}) {
    uint64_t bits;
    std::memcpy(&bits, &x, sizeof bits);
    h ^= bits + UINT64_C(0x9e3779b97f4a7c15) + (h << 6) + (h >> 2);
  }
  h ^= h >> 33; h *= UINT64_C(0xff51afd7ed558ccd); h ^= h >> 33;
  return unsigned(h) & (kGridBuckets - 1);
}
inline bool grid_same(double a, double b) { return std::memcmp(&a, &b, sizeof a) == 0; }
inline void grid_unlink(GridCache& c, WideGrid* g) {
  if (g->older) g->older->newer = g->newer; else c.oldest = g->newer;
  if (g->newer) g->newer->older = g->older; else c.newest = g->older;
  g->older = g->newer = nullptr;
}
inline void grid_touch(GridCache& c, WideGrid* g) {
  g->older = c.newest;
  if (c.newest) c.newest->newer = g; else c.oldest = g;
  c.newest = g;
}
inline void grid_delete(GridCache& c, WideGrid* g) {
  WideGrid** at = &c.bucket[grid_hash(g->degree, g->cls, g->n, g->e, g->i)];
  while (*at != g) at = &(*at)->link;
  *at = g->link; --c.descriptors; std::free(g);
}
inline void grid_evict(GridCache& c, WideGrid* g) {
  grid_unlink(c, g);
  c.bytes -= wide_grid_bytes_bound(g->degree); --c.count;
  wide_grid_release(*g);
  if (!g->refs) grid_delete(c, g);
}
inline bool grid_room(GridCache& c, size_t extra) {
  while (extra > c.budget || c.bytes > c.budget - extra) {
    WideGrid* g = c.oldest;
    while (g && (g->pins || g->building)) g = g->newer;
    if (!g) return false;
    grid_evict(c, g);
  }
  return true;
}
inline thread_local int32_t g_fit_grid_depth = 0;
inline int32_t& fit_grid_depth() { return g_fit_grid_depth; }
struct FitGridScope {
  FitGridScope() { ++g_fit_grid_depth; }
  ~FitGridScope() { --g_fit_grid_depth; }
};
inline bool fit_grids_now() { return g_fit_grid_depth > 0; }
inline int64_t* grid_counts() { static int64_t n[3]{}; return n; }
inline WideGrid* wide_grid_acquire(int degree, int cls, double n, double e, double inc, bool transient = false) {
  __atomic_add_fetch(&grid_counts()[transient ? 1 : 0], 1, __ATOMIC_RELAXED);
  if (degree < 2 || degree > kSpCap) return nullptr;
  auto& c = grid_cache(); cache_lock(&c.word);
  const unsigned bucket = grid_hash(degree, cls, n, e, inc);
  for (auto* g = c.bucket[bucket]; g; g = g->link)
    if (g->degree == degree && g->cls == cls && grid_same(n,g->n) && grid_same(e,g->e) && grid_same(inc,g->i)) {
      ++g->refs; cache_unlock(&c.word); return g;
    }
  auto* g = static_cast<WideGrid*>(sdnap::mem::calloc(1, sizeof(WideGrid)));
  if (g) {
    g->degree = degree; g->cls = cls; g->n = n; g->e = e; g->i = inc;
    g->a = std::pow(kKe / n, kX2o3); g->refs = 1; g->transient = transient;
    g->link = c.bucket[bucket]; c.bucket[bucket] = g; ++c.descriptors;
  }
  cache_unlock(&c.word); return g;
}
inline void wide_grid_ref(WideGrid* g) {
  if (!g) return;
  auto& c = grid_cache(); cache_lock(&c.word); ++g->refs; cache_unlock(&c.word);
}
inline void wide_grid_drop(WideGrid* g) {
  if (!g) return;
  auto& c = grid_cache(); cache_lock(&c.word);
  if (--g->refs == 0 && !g->pins) {
    if (!g->v) grid_delete(c, g);
    else if (g->transient) grid_evict(c, g);
  }
  cache_unlock(&c.word);
}
inline bool grid_pin(WideGrid* g) {
  if (!g) return true;
  auto& c = grid_cache();
  for (unsigned waits = 0;;) {
    cache_lock(&c.word);
    if (g->building) {
      cache_unlock(&c.word);
      if (++waits >= 65536 || sdnap::pool::wide_build_cancelled()) {
        sdnap::mem::note_failure(wide_grid_bytes_bound(g->degree)); return false;
      }
      sched_yield();
      continue;
    }
    if (g->v) {
      ++g->pins; grid_unlink(c, g); grid_touch(c, g); cache_unlock(&c.word); return true;
    }
    const size_t bytes = wide_grid_bytes_bound(g->degree);
    if (!grid_room(c, bytes)) { cache_unlock(&c.word); sdnap::mem::note_failure(bytes); return false; }
    g->pins = 1; g->building = true; c.bytes += bytes; ++c.count;
    grid_touch(c, g); cache_unlock(&c.word);
    WideGrid data{};
    const bool ok = wide_grid_build(g->degree, g->cls, g->n, g->e, g->i, data);
    cache_lock(&c.word); g->building = false;
    if (ok) {
      g->count = data.count; g->m = data.m; g->w = data.w; g->v = data.v; g->dv = data.dv;
      g->alloc_bytes = data.alloc_bytes;
      __atomic_add_fetch(&grid_counts()[2], 1, __ATOMIC_RELAXED);
    } else {
      g->pins = 0; grid_unlink(c, g); c.bytes -= bytes; --c.count;
    }
    cache_unlock(&c.word); return ok;
  }
}
inline void grid_unpin(WideGrid* g) {
  if (!g) return;
  auto& c = grid_cache(); cache_lock(&c.word); --g->pins;
  if (!g->refs && !g->pins && g->transient) grid_evict(c, g);
  cache_unlock(&c.word);
}
struct GridPin {
  WideGrid* g;
  bool ok;
  explicit GridPin(const WideGrid* p) : g(const_cast<WideGrid*>(p)), ok(grid_pin(g)) {}
  ~GridPin() { if (ok) grid_unpin(g); }
  GridPin(const GridPin&) = delete;
  GridPin& operator=(const GridPin&) = delete;
};
inline double wide_grid_share(const WideGrid* g) {
  if (!g) return 0;
  auto& c = grid_cache(); cache_lock(&c.word);
  const double bytes = (g->v ? wide_grid_bytes_bound(g->degree) : sizeof(WideGrid)) / double(std::max(g->refs, 1));
  cache_unlock(&c.word); return bytes;
}
inline void cache_contents(double& slots, double& bytes) {
  auto& c = grid_cache(); cache_lock(&c.word); slots = c.count; bytes = c.bytes; cache_unlock(&c.word);
}
extern "C" __attribute__((export_name("sdnap_wide_grid_cache"))) int32_t sdnap_wide_grid_cache(double* out) {
  cache_contents(out[0], out[1]); out[2] = __atomic_load_n(&grid_counts()[2], __ATOMIC_RELAXED); return 0;
}
extern "C" __attribute__((export_name("sdnap_wide_grid_stats"))) int32_t sdnap_wide_grid_stats(int32_t reset, double* out) {
  for (int i = 0; i < 2; ++i) out[i] = reset ? __atomic_exchange_n(&grid_counts()[i], 0, __ATOMIC_RELAXED) : __atomic_load_n(&grid_counts()[i], __ATOMIC_RELAXED);
  return 0;
}
// The minimum holds two maximum-size payloads for each of 16 pool threads and
// the caller. Covariance sigma sets read their grids sequentially within a row.
// Positive requests below the minimum apply the minimum. Pinned payloads are preserved.
extern "C" __attribute__((export_name("sdnap_wide_grid_budget"))) int32_t sdnap_wide_grid_budget(double bytes, double* out) {
  auto& c = grid_cache(); cache_lock(&c.word); int32_t rc = 0;
  if (bytes >= 1.0) {
    if (!std::isfinite(bytes) || bytes > double(SIZE_MAX)) rc = -1;
    else {
      const size_t old = c.budget; c.budget = std::max(kGridMinimumBytes, static_cast<size_t>(bytes));
      if (!grid_room(c, 0)) { c.budget = old; rc = -1; }
    }
  }
  if (out) {
    size_t idle = 0;
    for (auto* g = c.oldest; g; g = g->newer) idle += !g->pins && !g->building;
    out[0] = c.budget; out[1] = c.bytes; out[2] = c.count; out[3] = idle;
  }
  cache_unlock(&c.word); return rc;
}
