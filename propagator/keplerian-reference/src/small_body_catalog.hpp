// propagator/keplerian-reference — the small-body catalog surface (pthreads).
//
// One module instance holds a whole small-body catalog (owner 2026-10-13:
// "For the WASM, we should be using shared array buffers and pthreads"): its
// linear memory is a SharedArrayBuffer the host reads in place, and a pool of
// pthreads started once computes every snapshot, row ranges split between
// them. The host never copies a snapshot or a record table: it reads the
// snapshot rows, the numbers, magnitudes, diameters and names through views of
// this memory (zero-copy), and talks to the pool through control words in it
// (no postMessage, no JSON).
//
// THE CALLING THREAD NEVER WAITS. A browser's main thread may not block
// (memory.atomic.wait traps there), so a job is begun (kepler_catalog_*_begin)
// and its completion read from a control word the host watches
// (Atomics.waitAsync, or a poll). The pool threads wait; the caller does not.
// Nothing a job runs allocates: the rows, the display arrays, the snapshot
// and the job inputs are reserved by kepler_catalog_init before any job, so
// the caller's own allocations never meet a pool thread on the allocator's
// lock. Each planet-place cache is per thread (thread_local).
//
// SINGLE-THREAD PATH. Where the host cannot start threads (no cross-origin
// isolation, a runtime without thread-spawn) pthread_create fails and a job
// runs on the calling thread inside the *_begin call; its control words read
// the same.
//
// INTERNAL LAYOUT, NOT A STANDARD (engine-module buffers; no SDS schema):
// kepler_catalog_init returns the address of a table of uint32 slots, `Slot`
// below; index constants are mirrored in OrbPro's
// orbpro-integration/small-bodies/catalogLayout.js. The records themselves are
// SDS $SBD (the standard on the network); this surface only reads them.

#include <atomic>
#include <pthread.h>

namespace small_catalog {

enum Slot : uint32_t {
  S_VERSION = 0,
  S_CAPACITY,     // rows reserved
  S_COUNT,        // rows committed (the host reads rows [0, count))
  S_THREADS,      // pool threads running (0: jobs run on the caller)
  S_CONTROL,      // int32[8] control words (Control)
  S_PARAMS,       // double[32] job inputs
  S_SNAPSHOT,     // float32[4 * capacity]: x, y, z, V per row
  S_NUMBERS,      // uint32[capacity]
  S_HGD,          // float32[3 * capacity]: H, G, DIAMETER (km)
  S_NAME_OFFSETS, // uint32[capacity + 1]
  S_NAMES,        // uint8[name capacity]
  S_NAME_CAPACITY,
  S_VALIDITY,     // double[2]: the epochs between which every committed row is valid
  S_RESULTS,      // int32[64]: search results (row indices)
  S_QUERY,        // uint8[256]: a search query (lower-case folded in place)
  S_PROMOTED,     // the promoted rows' area (internal)
  S_COUNT_SLOTS
};

enum Control : int32_t {
  C_JOB_SEQ = 0,   // incremented by the caller for each job (the pool waits on it)
  C_DONE_SEQ = 1,  // set to the job's sequence when it is done (the host waits on it)
  C_REMAINING = 2, // pool threads still on the job
  C_RESULT = 3,    // the job's result (failed rows, rows added, or a negative code)
  C_KIND = 4,      // 1 snapshot, 2 ingest
  C_STOP = 5,      // 1: the pool threads leave
};

enum Param : int {
  P_ET = 0,
  P_OBSERVER = 1,      // 10 doubles
  P_OBSERVER_COUNT = 11,
  P_DATA = 12,         // ingest: address of the shard bytes
  P_LENGTH = 13,
  P_CLASS_MASK = 14,
  P_H_MIN = 15,
  P_H_MAX = 16,
  P_EXCLUDE = 17,      // address of a number bitmap (0: none)
  P_EXCLUDE_BITS = 18,
};

constexpr int kMaxThreads = 16;
constexpr int kPromoted = 16;
constexpr int kMaxResults = 64;

struct Catalog {
  uint32_t table[S_COUNT_SLOTS] = {};
  std::atomic<int32_t> control[8];
  double params[32] = {};
  float* snapshot = nullptr;
  uint32_t* numbers = nullptr;
  float* hgd = nullptr;
  uint32_t* nameOffsets = nullptr;
  uint8_t* names = nullptr;
  uint32_t nameCapacity = 0;
  uint32_t capacity = 0;
  double validity[2] = {-INFINITY, INFINITY};
  int32_t results[kMaxResults] = {};
  uint8_t query[256] = {};
  SmallBody promoted[kPromoted];
  int threads = 0;
  pthread_t pool[kMaxThreads];
};

Catalog* g_catalog = nullptr;

inline uint32_t addr(const void* p) { return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(p)); }

inline void wait_while_equal(std::atomic<int32_t>* word, int32_t value) {
  while (word->load(std::memory_order_acquire) == value) {
    __builtin_wasm_memory_atomic_wait32(reinterpret_cast<int*>(word), value, -1);
  }
}
inline void notify_all(std::atomic<int32_t>* word) {
  __builtin_wasm_memory_atomic_notify(reinterpret_cast<int*>(word), 0xFFFFFFFFu);
}

/* ---- the jobs -------------------------------------------------------------- */

/* Rows [first, first + count) of a snapshot at the job's epoch. */
inline int32_t snapshot_range(Catalog& c, uint32_t first, uint32_t count) {
  SmallStore& store = small_bodies();
  const double et = c.params[P_ET];
  const double* observer = c.params + P_OBSERVER;
  const bool apparent = c.params[P_OBSERVER_COUNT] >= 10.0;
  double at[9];
  if (apparent) small_observer_at(observer, et, at);
  int32_t failed = 0;
  for (uint32_t i = first; i < first + count; ++i) {
    small_rebase_valid(store[i], et);
    const bool ok = apparent ? small_apparent_row(store[i], et, at, c.snapshot + 4 * i)
                             : small_snapshot_row(store[i], et, observer, c.snapshot + 4 * i);
    if (!ok) ++failed;
  }
  return failed;
}

/* A shard of size-prefixed $SBD records: the selection made in place, the
 * rows decoded into the reserved store, their display fields beside them,
 * then committed. All or nothing. */
inline int32_t ingest(Catalog& c) {
  uint8_t* data = reinterpret_cast<uint8_t*>(static_cast<uintptr_t>(c.params[P_DATA]));
  uint32_t length = static_cast<uint32_t>(c.params[P_LENGTH]);
  const uint32_t mask = static_cast<uint32_t>(c.params[P_CLASS_MASK]);
  const double hMin = c.params[P_H_MIN], hMax = c.params[P_H_MAX];
  const uint8_t* exclude = reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(c.params[P_EXCLUDE]));
  const uint32_t bits = static_cast<uint32_t>(c.params[P_EXCLUDE_BITS]);
  if (mask != 0 || !std::isnan(hMin) || !std::isnan(hMax) || exclude != nullptr) {
    const int32_t kept =
        kepler_small_select_sbd_stream(data, length, mask, hMin, hMax, exclude, exclude ? bits : 0, data, length);
    if (kept < 0) return kept;
    length = static_cast<uint32_t>(kept);
  }
  SmallStore& store = small_bodies();
  const uint32_t before = static_cast<uint32_t>(store.size());
  /* count the records first: the store and the display arrays are reserved */
  uint32_t records = 0;
  for (uint32_t off = 0; off + 4 <= length;) {
    uint32_t size = 0;
    std::memcpy(&size, data + off, 4);
    off += 4 + size;
    ++records;
  }
  if (before + records > c.capacity) return kErrBadEntityIndex;
  const int32_t added = length == 0 ? 0 : ingest_small_stream(data, length);
  if (added < 0) return added;
  const uint32_t nameBase = c.nameOffsets[before];
  const int32_t described = length == 0 ? 0
      : kepler_small_describe_sbd_stream(data, length, static_cast<uint32_t>(added), c.numbers + before,
                                         c.hgd + 3 * before, c.nameOffsets + before, c.names + nameBase,
                                         c.nameCapacity - nameBase);
  if (described != added) {
    store.truncate(before);
    return described < 0 ? described : kErrBadInput;
  }
  for (int32_t i = 0; i <= added; ++i) c.nameOffsets[before + i] += nameBase;
  for (uint32_t i = before; i < before + static_cast<uint32_t>(added); ++i) {
    const SmallBody& b = store[i];
    c.validity[0] = std::max(c.validity[0], b.epoch_et - g_small_validity);
    c.validity[1] = std::min(c.validity[1], b.epoch_et + g_small_validity);
  }
  c.table[S_COUNT] = before + static_cast<uint32_t>(added);
  return added;
}

inline void finish(Catalog& c, int32_t seq) {
  c.control[C_DONE_SEQ].store(seq, std::memory_order_release);
  notify_all(&c.control[C_DONE_SEQ]);
}

/* A pool thread: waits for a job, does its part, and the last one out marks
 * the job done. */
void* pool_main(void* arg) {
  const int index = static_cast<int>(reinterpret_cast<intptr_t>(arg));
  Catalog& c = *g_catalog;
  // Jobs are numbered from 1: a thread that starts after the first job was
  // begun still takes it (the caller begins the next only when every pool
  // thread has finished this one).
  int32_t seen = 0;
  for (;;) {
    wait_while_equal(&c.control[C_JOB_SEQ], seen);
    if (c.control[C_STOP].load(std::memory_order_acquire) != 0) return nullptr;
    seen = c.control[C_JOB_SEQ].load(std::memory_order_acquire);
    const int32_t kind = c.control[C_KIND].load(std::memory_order_acquire);
    int32_t result = 0;
    if (kind == 1) {
      const uint32_t n = c.table[S_COUNT];
      const uint32_t per = (n + c.threads - 1) / c.threads;
      const uint32_t first = std::min(n, per * static_cast<uint32_t>(index));
      const uint32_t last = std::min(n, first + per);
      result = snapshot_range(c, first, last - first);
      c.control[C_RESULT].fetch_add(result, std::memory_order_acq_rel);
    } else if (kind == 2 && index == 0) {
      c.control[C_RESULT].store(ingest(c), std::memory_order_release);
    }
    if (c.control[C_REMAINING].fetch_sub(1, std::memory_order_acq_rel) == 1) finish(c, seen);
  }
}

/* Begins a job: the pool takes it, or (no pool) it runs here and now. */
inline int32_t begin(Catalog& c, int32_t kind) {
  const int32_t seq = c.control[C_JOB_SEQ].load(std::memory_order_acquire) + 1;
  c.control[C_KIND].store(kind, std::memory_order_release);
  c.control[C_RESULT].store(0, std::memory_order_release);
  if (c.threads == 0) {
    c.control[C_JOB_SEQ].store(seq, std::memory_order_release);
    const int32_t result = kind == 1 ? snapshot_range(c, 0, c.table[S_COUNT]) : ingest(c);
    c.control[C_RESULT].store(result, std::memory_order_release);
    finish(c, seq);
    return seq;
  }
  c.control[C_REMAINING].store(c.threads, std::memory_order_release);
  c.control[C_JOB_SEQ].store(seq, std::memory_order_release);
  notify_all(&c.control[C_JOB_SEQ]);
  return seq;
}

/* ---- search -------------------------------------------------------------- */

inline uint8_t fold(uint8_t b) { return (b >= 'A' && b <= 'Z') ? static_cast<uint8_t>(b + 32) : b; }

/* Rows whose number equals the query, then whose name starts with it, then
 * whose name contains it (ASCII case folded), up to `limit`, in row order. */
inline int32_t search(Catalog& c, uint32_t length, uint32_t limit) {
  if (limit > kMaxResults) limit = kMaxResults;
  uint8_t* q = c.query;
  for (uint32_t i = 0; i < length; ++i) q[i] = fold(q[i]);
  const uint32_t n = c.table[S_COUNT];
  int32_t count = 0;
  bool digits = length > 0;
  uint64_t number = 0;
  for (uint32_t i = 0; i < length; ++i) {
    if (q[i] < '0' || q[i] > '9') {
      digits = false;
      break;
    }
    number = number * 10 + (q[i] - '0');
  }
  int32_t numbered = -1;
  if (digits && length < 11) {
    for (uint32_t i = 0; i < n; ++i)
      if (c.numbers[i] == number) {
        numbered = static_cast<int32_t>(i);
        break;
      }
    if (numbered >= 0) c.results[count++] = numbered;
  }
  if (length == 0) return count;
  /* prefixes first, then inner matches, each in row order */
  int32_t prefix[kMaxResults];
  int32_t prefixCount = 0;
  static thread_local int32_t inner[4 * kMaxResults];
  int32_t innerCount = 0;
  for (uint32_t i = 0; i < n && prefixCount < static_cast<int32_t>(limit) && innerCount < 4 * static_cast<int32_t>(limit); ++i) {
    const uint8_t* name = c.names + c.nameOffsets[i];
    const uint32_t nl = c.nameOffsets[i + 1] - c.nameOffsets[i];
    if (nl < length) continue;
    for (uint32_t at = 0; at + length <= nl; ++at) {
      uint32_t k = 0;
      while (k < length && fold(name[at + k]) == q[k]) ++k;
      if (k == length) {
        if (at == 0) prefix[prefixCount++] = static_cast<int32_t>(i);
        else inner[innerCount++] = static_cast<int32_t>(i);
        break;
      }
    }
  }
  auto add = [&](int32_t row) {
    if (count >= static_cast<int32_t>(limit) || row == numbered) return;
    c.results[count++] = row;
  };
  for (int32_t i = 0; i < prefixCount; ++i) add(prefix[i]);
  for (int32_t i = 0; i < innerCount; ++i) add(inner[i]);
  return count;
}

}  // namespace small_catalog

/// Reserves a catalog of `capacity` rows (names `name_bytes` per row on
/// average) and starts `threads` pool threads (0: every job runs on the
/// caller). Returns the address of the layout table, or 0 out of memory.
ORBPRO_ABI_EXPORT("kepler_catalog_init")
uint32_t kepler_catalog_init(uint32_t capacity, uint32_t name_bytes, uint32_t threads) {
  using namespace small_catalog;
  if (g_catalog != nullptr) return addr(g_catalog->table);
  Catalog* c = new Catalog();
  for (auto& w : c->control) w.store(0);
  c->capacity = capacity;
  c->nameCapacity = std::max<uint32_t>(capacity * name_bytes, 64);
  c->snapshot = new float[4 * static_cast<size_t>(std::max<uint32_t>(capacity, 1))];
  c->numbers = new uint32_t[std::max<uint32_t>(capacity, 1)];
  c->hgd = new float[3 * static_cast<size_t>(std::max<uint32_t>(capacity, 1))];
  c->nameOffsets = new uint32_t[capacity + 1]();
  c->names = new uint8_t[c->nameCapacity];
  for (size_t i = 0; i < 4 * static_cast<size_t>(capacity); ++i) c->snapshot[i] = NAN;
  small_bodies().reserve(capacity);
  g_catalog = c;
  uint32_t* t = c->table;
  t[S_VERSION] = 1;
  t[S_CAPACITY] = capacity;
  t[S_COUNT] = 0;
  t[S_CONTROL] = addr(c->control);
  t[S_PARAMS] = addr(c->params);
  t[S_SNAPSHOT] = addr(c->snapshot);
  t[S_NUMBERS] = addr(c->numbers);
  t[S_HGD] = addr(c->hgd);
  t[S_NAME_OFFSETS] = addr(c->nameOffsets);
  t[S_NAMES] = addr(c->names);
  t[S_NAME_CAPACITY] = c->nameCapacity;
  t[S_VALIDITY] = addr(c->validity);
  t[S_RESULTS] = addr(c->results);
  t[S_QUERY] = addr(c->query);
  t[S_PROMOTED] = addr(c->promoted);
  const int wanted = static_cast<int>(std::min<uint32_t>(threads, kMaxThreads));
  for (int i = 0; i < wanted; ++i) {
    if (pthread_create(&c->pool[i], nullptr, pool_main, reinterpret_cast<void*>(static_cast<intptr_t>(i))) != 0) break;
    pthread_detach(c->pool[i]);
    ++c->threads;
  }
  t[S_THREADS] = static_cast<uint32_t>(c->threads);
  return addr(t);
}

/// Begins a snapshot of every committed row at params[P_ET] from the
/// observer in params (10 doubles, or 3 for geometric rows). Returns the job's
/// sequence; control[C_DONE_SEQ] reaches it when the rows are in place.
ORBPRO_ABI_EXPORT("kepler_catalog_snapshot_begin")
int32_t kepler_catalog_snapshot_begin(void) {
  if (small_catalog::g_catalog == nullptr) return kErrNotInitialized;
  return small_catalog::begin(*small_catalog::g_catalog, 1);
}

/// Begins ingesting the shard at params[P_DATA] (params[P_LENGTH] bytes,
/// selection in params). Returns the job's sequence; control[C_RESULT] is the
/// rows added (or a negative code) once it is done. The host frees the shard
/// bytes afterwards.
ORBPRO_ABI_EXPORT("kepler_catalog_ingest_begin")
int32_t kepler_catalog_ingest_begin(void) {
  if (small_catalog::g_catalog == nullptr) return kErrNotInitialized;
  return small_catalog::begin(*small_catalog::g_catalog, 2);
}

/// Searches the committed rows for the query in the query area (`length`
/// bytes): results into the results area; returns their count.
ORBPRO_ABI_EXPORT("kepler_catalog_search")
int32_t kepler_catalog_search(uint32_t length, uint32_t limit) {
  if (small_catalog::g_catalog == nullptr || length > 255) return 0;
  return small_catalog::search(*small_catalog::g_catalog, length, limit);
}

/// The row of an asteroid number, or -1.
ORBPRO_ABI_EXPORT("kepler_catalog_find_number")
int32_t kepler_catalog_find_number(uint32_t number) {
  auto* c = small_catalog::g_catalog;
  if (c == nullptr) return -1;
  for (uint32_t i = 0; i < c->table[small_catalog::S_COUNT]; ++i)
    if (c->numbers[i] == number) return static_cast<int32_t>(i);
  return -1;
}

/// A bitmap of the committed rows' numbers (bit n = number n) into `out`
/// (`capacity` bytes). Returns the bytes it needs (call with 0 to size it).
ORBPRO_ABI_EXPORT("kepler_catalog_number_bitmap")
uint32_t kepler_catalog_number_bitmap(uint8_t* out, uint32_t capacity) {
  auto* c = small_catalog::g_catalog;
  if (c == nullptr) return 0;
  const uint32_t n = c->table[small_catalog::S_COUNT];
  uint32_t largest = 0;
  for (uint32_t i = 0; i < n; ++i) largest = std::max(largest, c->numbers[i]);
  const uint32_t need = (largest >> 3) + 1;
  if (out == nullptr || capacity < need) return need;
  std::memset(out, 0, need);
  for (uint32_t i = 0; i < n; ++i) out[c->numbers[i] >> 3] |= static_cast<uint8_t>(1u << (c->numbers[i] & 7));
  return need;
}

/// Copies committed row `index` into promoted slot `slot` (0..15) for
/// double-precision evaluation on the caller's thread. Call between jobs (a
/// snapshot moves rows on).
ORBPRO_ABI_EXPORT("kepler_catalog_promote")
int32_t kepler_catalog_promote(uint32_t index, uint32_t slot) {
  auto* c = small_catalog::g_catalog;
  if (c == nullptr) return kErrNotInitialized;
  if (index >= c->table[small_catalog::S_COUNT] || slot >= small_catalog::kPromoted) return kErrBadEntityIndex;
  c->promoted[slot] = small_bodies()[index];
  return kOk;
}

/// A promoted row's state at `et` (position m, velocity m/s, heliocentric ICRF).
ORBPRO_ABI_EXPORT("kepler_catalog_state")
int32_t kepler_catalog_state(double et, uint32_t slot, double* out) {
  auto* c = small_catalog::g_catalog;
  if (c == nullptr || out == nullptr) return kErrNullOutput;
  if (slot >= small_catalog::kPromoted) return kErrBadEntityIndex;
  SmallBody& b = c->promoted[slot];
  if (!small_in_validity(b, et)) return kErrOutsideValidity;
  small_rebase(b, et);
  return small_position(b, et, out, out + 3) ? kOk : kErrNotConverged;
}

/// The conic drawing a promoted row at `et_osc`, evaluated at any `et`.
/// Heliocentric ICRF position (m), velocity (m/s), and bound period (s).
ORBPRO_ABI_EXPORT("kepler_catalog_conic_state")
int32_t kepler_catalog_conic_state(double et_osc, double et, uint32_t slot, double* out7) {
  auto* c = small_catalog::g_catalog;
  if (c == nullptr || out7 == nullptr) return kErrNullOutput;
  if (slot >= small_catalog::kPromoted) return kErrBadEntityIndex;
  SmallBody& b = c->promoted[slot];
  if (!small_in_validity(b, et_osc)) return kErrOutsideValidity;
  small_rebase(b, et_osc);
  Conic conic;
  conic_of(b, conic);
  if (!small_conic(conic, et, out7, out7 + 3)) return kErrNotConverged;
  out7[6] = conic.e < 1.0 ? kTwoPi / conic.n : NAN;
  return kOk;
}

/// A promoted row's light-time and aberration shift (m, ICRF), the observer
/// as for kepler_small_snapshot_apparent.
ORBPRO_ABI_EXPORT("kepler_catalog_apparent_offset")
int32_t kepler_catalog_apparent_offset(double et, uint32_t slot, const double* observer, double* out) {
  auto* c = small_catalog::g_catalog;
  if (c == nullptr || out == nullptr || observer == nullptr) return kErrNullOutput;
  if (slot >= small_catalog::kPromoted) return kErrBadEntityIndex;
  SmallBody& b = c->promoted[slot];
  if (!small_in_validity(b, et)) return kErrOutsideValidity;
  double seen[3], geometric[3], r[3], at[9];
  small_observer_at(observer, et, at);
  small_rebase(b, et);
  if (!small_apparent_place(b, et, at, seen, geometric, r)) return kErrNotConverged;
  for (int k = 0; k < 3; ++k) out[k] = seen[k] - geometric[k];
  return kOk;
}
