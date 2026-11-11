// -----------------------------------------------------------------------------
// The pool: wasi-threads over the module's shared memory, for the batch
// entries. A batch is cut into fixed chunks of objects; the threads and the
// calling thread take chunks by an atomic counter and write only their own
// objects' rows, so every row holds the same bytes whichever thread (and
// however many threads) computed it. The calling thread never executes
// atomic.wait (a browser main thread may not block): when the chunks run
// out it spins on the done counter. Without threads (none started, or none
// could be spawned) the calling thread computes every chunk itself.
//
// Growth and the threads' views of the memory (stack #487, SPEC 9). A thread's
// view of the memory's size can lag another thread's growth: its memory.size
// reads the older size, and a bulk fill or copy it makes of a block in the
// new pages traps (memory access out of bounds) against that size. Neither a
// host call nor a grow of zero pages by the thread brought the view up to
// date on demand; it came up to date a few yields later. So no thread uses
// pages another thread grew until its own view covers them (await_view):
// - the memory grows on the calling thread only, apart from a worker's
//   once-per-thread caches as it starts: sbrk refuses every growth while a
//   threaded batch runs, a set refused its caches flies on the thread's, and
//   a row that needed a refused block is computed again by the calling thread
//   after the batch (run_chunk's deferral);
// - the calling thread makes room before it wakes the workers (run's
//   reserve) and publishes the memory's size (Job::pages) before the batch's
//   chunk total; a worker that has claimed a chunk has read that total, so
//   it reads that size, and it waits until its own view covers it before it
//   runs the chunk;
// - a worker starting waits for the size the calling thread published before
//   creating it, makes its caches, and publishes its own size; the calling
//   thread waits until its own view covers that before it goes on.
// A view that never comes up to date stops chunks completing, which the
// calling thread's timer turns into kBatchPoolDead, not a trap.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace pool {

constexpr int32_t kMaxThreads = 16;
constexpr uint32_t kChunk = 512;
/// A batch whose pool thread died (it trapped, or stopped answering): the batch's return and every row's status. A
/// thread that completes no chunk for `dead_seconds()` of wall time while the calling thread waits is taken for dead;
/// the pool is then not used again (later batches run on the calling thread).
constexpr int32_t kBatchPoolDead = -20;
constexpr int32_t kRowPoolDead = 9;
constexpr double kDeadSecondsDefault = 30.0;

enum JobKind : int32_t { kJobNone = 0, kJobJd = 1, kJobMinutes = 2 };

struct Job {
  int32_t generation;
  int32_t threads;
  int32_t next;
  int32_t done;
  int32_t total;
  int32_t active;  ///< threads inside run_chunks
  int32_t kind;
  int32_t warmed;  ///< threads that have made their caches (thread_main, before any batch)
  int32_t dead;    ///< a thread was taken for dead: the pool is not used again
  int32_t pages;   ///< the memory's size (pages) as the thread that last grew it saw it: no thread uses less (await_view)
  // arguments
  double jd_whole, jd_frac;
  const double* minutes;
  uint32_t first, count, frame;
  double* out;
  int32_t* status;
  // rows a refused growth stopped, for the calling thread after the batch (room for `count`, made before it)
  uint32_t* deferred;
  int32_t deferred_n;
  // per-time terms shared by every object of a batch at one time
  xpt::Bodies bodies;
  double theta;
};

inline Job& job() {
  static Job instance{};
  return instance;
}

inline int32_t load(const int32_t* word) { return __atomic_load_n(word, __ATOMIC_SEQ_CST); }

/// The wall time a waiting caller allows a batch to complete no chunk before it takes a thread for dead (seconds;
/// default 30, sdnap_pool_stats reads it; test builds set it through a hook).
inline double& dead_seconds() {
  static double s = kDeadSecondsDefault;
  return s;
}
inline double wall_seconds() {
  struct timespec ts {};
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<double>(ts.tv_sec) + 1e-9 * static_cast<double>(ts.tv_nsec);
}

/// The memory's size (pages) as this thread sees it.
inline int32_t view_pages() { return static_cast<int32_t>(__builtin_wasm_memory_size(0)); }

/// Waits, yielding, until this thread sees the memory at least `pages` long, at most `limit` seconds (a negative limit:
/// no limit). Returns whether it does. Observed on Node 25.4.0 (stack #487): after another thread's growth this thread's
/// memory.size read the older size, and its bulk fill of a block in the new pages trapped; the size it reads is the one
/// its bulk operations are checked against (the trapping thread had read a size short of its block, which lay inside the
/// memory). The wait reads that size and assumes nothing about when the engine updates it. Counted in BatchStats.
inline bool await_view(int32_t pages, double limit = -1.0) {
  if (view_pages() >= pages) return true;
  const double t0 = wall_seconds();
  uint64_t yields = 0;
  bool seen = true;
  while (view_pages() < pages) {
    sched_yield();
    ++yields;
    if (limit >= 0.0 && (yields & 63u) == 0 && wall_seconds() - t0 > limit) {
      seen = false;
      break;
    }
  }
  xpt::batch_view_waited(yields, wall_seconds() - t0);
  return seen;
}

void run_chunk(const Job& j, int32_t chunk);
/// Test builds only (nullptr in the shipped build): called before each chunk with the chunk and whether a pool thread
/// (not the calling thread) runs it.
inline void (*g_chunk_hook)(int32_t chunk, bool pool_thread) = nullptr;
inline thread_local bool g_pool_thread = false;
/// Test builds only (false in the shipped build): no reserve before a threaded batch, so every growth a batch would
/// need is refused (the refusals' fall-backs and deferrals all taken).
inline bool g_reserve_off = false;
/// The reserve's block, stored before it is freed: a block freed unused is an allocation the compiler removes (seen:
/// `free(malloc(n))` left the memory as it was).
inline void* volatile g_reserve_block = nullptr;

// A chunk is claimed by compare-and-swap against the job's total, so a
// thread that wakes late (or reads the counters across a job boundary)
// never claims a chunk that is not in the current job.
//
// The view (stack #487): run stores the batch's Job::pages before its total
// (both sequentially consistent). A pool thread whose claim read this batch's
// total therefore reads this batch's pages after it, and it runs the chunk
// only once its own view covers them: every block a batch uses lies below
// that size, since nothing grows the memory inside a batch. Before its first
// claim a woken thread touches only the job's counters (static, in the
// module's data) and its own once-per-thread caches (made as it started, in
// pages its view covered then); after its last chunk, the counters again.
inline void run_chunks() {
  Job& j = job();
  for (;;) {
    if (g_pool_thread && load(&j.dead) != 0) return;
    int32_t index = load(&j.next);
    if (index >= load(&j.total)) return;
    if (!__atomic_compare_exchange_n(&j.next, &index, index + 1, false, __ATOMIC_SEQ_CST,
                                     __ATOMIC_SEQ_CST))
      continue;
    if (g_pool_thread) await_view(load(&j.pages));
    if (g_chunk_hook != nullptr) g_chunk_hook(index, g_pool_thread);
    run_chunk(j, index);
    __atomic_add_fetch(&j.done, 1, __ATOMIC_SEQ_CST);
  }
}

/// A thread's once-per-thread caches, made before it computes any row of a batch: the tesseral cache with its storage
/// and grouping scratch, the half-day cache, the covariance's step cache, the drift and GCRF node slots. Made lazily
/// they were made in the batch (stack #487); every one is a pointer test once made.
inline void warm_thread() {
  (void)xpt::tess::sp_thread_cache();
  (void)xpt::tess::sp_build_scratch();
  (void)xpt::tess::half_day_eval_cache();
  (void)xpt::cov_grid_cache();
  (void)frames::drift_node_cache();
  frames::gcrf_node_cache_make();
}

inline void* thread_main(void*) {
  Job& j = job();
  g_pool_thread = true;
  // start publishes the memory's size before it creates this thread: the caches are made in pages this view covers
  await_view(load(&j.pages));
  warm_thread();
  // the one growth a worker makes: published for the calling thread, which waits until its own view covers it
  __atomic_store_n(&j.pages, view_pages(), __ATOMIC_SEQ_CST);
  __atomic_add_fetch(&j.warmed, 1, __ATOMIC_SEQ_CST);
  int32_t seen = load(&j.generation);
  for (;;) {
    int32_t generation;
    while ((generation = load(&j.generation)) == seen)
      __builtin_wasm_memory_atomic_wait32(&j.generation, seen, -1);
    seen = generation;
    __atomic_add_fetch(&j.active, 1, __ATOMIC_SEQ_CST);
    run_chunks();
    __atomic_sub_fetch(&j.active, 1, __ATOMIC_SEQ_CST);
  }
  return nullptr;
}

/// Starts up to `requested` pool threads, one at a time: each makes its caches (growing the memory for them if it must)
/// while every other thread is idle. The calling thread publishes the memory's size before it creates a thread (its
/// stack and thread-local block are this thread's allocations) and, once the thread has made its caches and published
/// its own size, waits until its own view covers that, at most dead_seconds(): a view that never comes up to date takes
/// the pool for dead (no batch uses it) rather than let this thread use pages it does not see.
inline int32_t start(int32_t requested) {
  Job& j = job();
  const int32_t wanted = requested < 0 ? 0 : (requested > kMaxThreads ? kMaxThreads : requested);
  while (j.threads < wanted && load(&j.dead) == 0) {
    const int32_t target = load(&j.warmed) + 1;
    __atomic_store_n(&j.pages, view_pages(), __ATOMIC_SEQ_CST);
    pthread_t id;
    if (pthread_create(&id, nullptr, thread_main, nullptr) != 0) break;
    pthread_detach(id);
    j.threads += 1;
    while (load(&j.warmed) < target) sched_yield();
    if (!await_view(load(&j.pages), dead_seconds())) {
      __atomic_store_n(&j.dead, 1, __ATOMIC_SEQ_CST);
      xpt::batch_stats().dead = 1;
    }
  }
  return j.threads;
}

/// Runs the job already written into job(): every chunk, on the threads and the calling thread, and returns when all
/// are done: 0, or kBatchPoolDead when a thread completed no chunk for dead_seconds() of wall time (the pool is then
/// not used again). A threaded batch is preceded by `reserve` bytes made free on the calling thread and runs with every
/// growth of the memory refused; the rows a refusal stopped are left in j.deferred for the calling thread.
inline int32_t run(uint32_t count, size_t reserve) {
  Job& j = job();
  const int32_t chunks = static_cast<int32_t>((count + kChunk - 1) / kChunk);
  const bool threaded = j.threads > 0 && chunks > 1 && load(&j.dead) == 0;
  __atomic_store_n(&j.deferred_n, 0, __ATOMIC_SEQ_CST);
  __atomic_store_n(&j.done, 0, __ATOMIC_SEQ_CST);
  __atomic_store_n(&j.next, 0, __ATOMIC_SEQ_CST);
  uint32_t pages = 0;
  if (threaded) {
    warm_thread();  // the calling thread computes chunks too: its caches are made before the batch, as the workers' are
    if (reserve > 0) {
      g_reserve_block = std::malloc(reserve);
      std::free(g_reserve_block);
      g_reserve_block = nullptr;
    }
    xpt::BatchStats& bs = xpt::batch_stats();
    bs.batches += 1;
    bs.reserve = reserve;
    pages = __builtin_wasm_memory_size(0);
    // the memory's size for the workers' views, and the rule that nothing grows, both before the chunk total: a claim
    // that reads this batch's total reads them after it (run_chunks)
    __atomic_store_n(&j.pages, static_cast<int32_t>(pages), __ATOMIC_SEQ_CST);
    __atomic_store_n(&xpt::g_batch_running, 1, __ATOMIC_SEQ_CST);
  }
  __atomic_store_n(&j.total, chunks, __ATOMIC_SEQ_CST);
  if (threaded) {
    __atomic_add_fetch(&j.generation, 1, __ATOMIC_SEQ_CST);
    __builtin_wasm_memory_atomic_notify(&j.generation, ~0u);
  }
  run_chunks();
  int32_t rc = 0;
  if (threaded) {
    // Done when every chunk is done and no thread can still hold a claim; a wall-clock look every 1,024 spins
    int32_t last_done = load(&j.done);
    double last_time = wall_seconds();
    uint32_t spins = 0;
    while (load(&j.done) < chunks || load(&j.active) > 0) {
      if ((++spins & 1023u) != 0) continue;
      const int32_t d = load(&j.done);
      const double now = wall_seconds();
      if (d != last_done) {
        last_done = d;
        last_time = now;
      } else if (now - last_time > dead_seconds()) {
        // no chunk is claimed after this (a claim's compare-and-swap on `next` fails, the total reads 0); a thread only
        // slow, not dead, finishes the chunk it holds after the batch returns, so a dead batch's planes are undefined
        __atomic_store_n(&j.total, 0, __ATOMIC_SEQ_CST);
        __atomic_store_n(&j.next, INT32_MAX, __ATOMIC_SEQ_CST);
        __atomic_store_n(&j.dead, 1, __ATOMIC_SEQ_CST);
        xpt::batch_stats().dead = 1;
        rc = kBatchPoolDead;
        break;
      }
    }
    __atomic_store_n(&xpt::g_batch_running, 0, __ATOMIC_SEQ_CST);
    if (__builtin_wasm_memory_size(0) != pages) xpt::batch_stats().grew += 1;
  } else {
    // after a dead batch the dead thread stays counted active: only the chunks are waited for
    while (load(&j.done) < chunks || (load(&j.dead) == 0 && load(&j.active) > 0)) {
    }
  }
  __atomic_store_n(&j.total, 0, __ATOMIC_SEQ_CST);
  return rc;
}

}  // namespace pool
}  // namespace sdnap

/// wasi-libc's sbrk (the allocator's only way to grow the memory), with the batch's rule: while a threaded batch runs,
/// every growth is refused (ENOMEM), on every thread, and counted; the refusing thread's row is deferred (stack #487).
/// Otherwise it is wasi-libc's: sbrk(0) the memory's end, page-sized growth only, never shrinking.
extern "C" void* sbrk(intptr_t increment) {
  constexpr uintptr_t kPage = 65536;
  if (increment == 0) return reinterpret_cast<void*>(static_cast<uintptr_t>(__builtin_wasm_memory_size(0)) * kPage);
  if (increment < 0 || static_cast<uintptr_t>(increment) % kPage != 0) std::abort();
  if (sdnap::xpt::batch_running()) {
    __atomic_add_fetch(&sdnap::xpt::batch_stats().refused, 1, __ATOMIC_SEQ_CST);
    sdnap::xpt::g_alloc_refused = 1;
    errno = ENOMEM;
    return reinterpret_cast<void*>(static_cast<intptr_t>(-1));
  }
  const uintptr_t old = __builtin_wasm_memory_grow(0, static_cast<uintptr_t>(increment) / kPage);
  if (old == SIZE_MAX) {
    errno = ENOMEM;
    return reinterpret_cast<void*>(static_cast<intptr_t>(-1));
  }
  return reinterpret_cast<void*>(old * kPage);
}
