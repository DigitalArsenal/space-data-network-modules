// -----------------------------------------------------------------------------
// The pool: wasi-threads over the module's shared memory, for the batch
// entries. A batch is cut into fixed chunks of objects; the threads and the
// calling thread take chunks by an atomic counter and write only their own
// objects' rows, so every row holds the same bytes whichever thread (and
// however many threads) computed it. The calling thread never executes
// atomic.wait (a browser main thread may not block): when the chunks run
// out it spins on the done counter. Without threads (none started, or none
// could be spawned) the calling thread computes every chunk itself.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace pool {

constexpr int32_t kMaxThreads = 16;
constexpr uint32_t kChunk = 512;

enum JobKind : int32_t { kJobNone = 0, kJobJd = 1, kJobMinutes = 2 };

struct Job {
  int32_t generation;
  int32_t threads;
  int32_t next;
  int32_t done;
  int32_t total;
  int32_t active;  ///< threads inside run_chunks
  int32_t kind;
  // arguments
  double jd_whole, jd_frac;
  const double* minutes;
  uint32_t first, count, frame;
  double* out;
  int32_t* status;
  // per-time terms shared by every object of a batch at one time
  xpt::Bodies bodies;
  double theta;
};

inline Job& job() {
  static Job instance{};
  return instance;
}

inline int32_t load(const int32_t* word) { return __atomic_load_n(word, __ATOMIC_SEQ_CST); }

void run_chunk(const Job& j, int32_t chunk);

// A chunk is claimed by compare-and-swap against the job's total, so a
// thread that wakes late (or reads the counters across a job boundary)
// never claims a chunk that is not in the current job.
inline void run_chunks() {
  Job& j = job();
  for (;;) {
    int32_t index = load(&j.next);
    if (index >= load(&j.total)) return;
    if (!__atomic_compare_exchange_n(&j.next, &index, index + 1, false, __ATOMIC_SEQ_CST,
                                     __ATOMIC_SEQ_CST))
      continue;
    run_chunk(j, index);
    __atomic_add_fetch(&j.done, 1, __ATOMIC_SEQ_CST);
  }
}

inline void* thread_main(void*) {
  Job& j = job();
  int32_t seen = 0;
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

inline int32_t start(int32_t requested) {
  Job& j = job();
  const int32_t wanted = requested < 0 ? 0 : (requested > kMaxThreads ? kMaxThreads : requested);
  while (j.threads < wanted) {
    pthread_t id;
    if (pthread_create(&id, nullptr, thread_main, nullptr) != 0) break;
    pthread_detach(id);
    j.threads += 1;
  }
  return j.threads;
}

/// Runs the job already written into job(): every chunk, on the threads and
/// the calling thread, and returns when all are done.
inline void run(uint32_t count) {
  Job& j = job();
  const int32_t chunks = static_cast<int32_t>((count + kChunk - 1) / kChunk);
  __atomic_store_n(&j.done, 0, __ATOMIC_SEQ_CST);
  __atomic_store_n(&j.next, 0, __ATOMIC_SEQ_CST);
  __atomic_store_n(&j.total, chunks, __ATOMIC_SEQ_CST);
  if (j.threads > 0 && chunks > 1) {
    __atomic_add_fetch(&j.generation, 1, __ATOMIC_SEQ_CST);
    __builtin_wasm_memory_atomic_notify(&j.generation, ~0u);
  }
  run_chunks();
  // Done when every chunk is done and no thread can still hold a claim.
  while (load(&j.done) < chunks || load(&j.active) > 0) {
  }
  __atomic_store_n(&j.total, 0, __ATOMIC_SEQ_CST);
}

}  // namespace pool
}  // namespace sdnap
