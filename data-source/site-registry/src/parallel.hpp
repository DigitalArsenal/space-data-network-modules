// The stages' pure per-item work on worker threads: in the module these are
// pthreads over its shared memory (wasi-threads), in the native build
// std::threads. Each item writes only its own result slot; the stage merges
// the slots in item order afterwards, so the output does not depend on the
// thread count or the schedule.
#pragma once
// SR_THREADS overrides the worker count (a build or a test may pin it).
#ifndef SR_THREADS
#define SR_THREADS 4
#endif
#include <algorithm>
#include <atomic>
#include <cstddef>
#if SR_THREADS > 1
#include <thread>
#endif
#include <vector>

namespace sr {

inline unsigned workerCount() { return SR_THREADS > 0 ? unsigned(SR_THREADS) : 1u; }

template <typename F>
inline void parallelFor(size_t n, F&& item) {
#if SR_THREADS <= 1
  // The one-thread build (build.mjs --flow-host) carries no thread code at all.
  for (size_t i = 0; i < n; ++i) item(i);
#else
  const size_t threads = std::min<size_t>(workerCount(), n);
  if (threads <= 1) {
    for (size_t i = 0; i < n; ++i) item(i);
    return;
  }
  std::atomic<size_t> next{0};
  auto work = [&]() {
    for (size_t i = next.fetch_add(1); i < n; i = next.fetch_add(1)) item(i);
  };
  std::vector<std::thread> pool;
  pool.reserve(threads - 1);
  for (size_t t = 1; t < threads; ++t) pool.emplace_back(work);
  work();
  for (auto& t : pool) t.join();
#endif
}

}  // namespace sr
