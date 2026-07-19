#include "od_batch_fit.hpp"

#include "od/plugin_runtime.h"

#include <atomic>
#include <functional>
#include <set>
#include <thread>

namespace od {

namespace {

// Run the SACRED per-object fit for one $OEM and package its result records.
BatchResult fit_one(const BatchObject& obj) {
    BatchResult r;
    PluginFitFBResult fr = fit_ephemeris_fb(
        obj.oem.empty() ? nullptr : obj.oem.data(), obj.oem.size(), std::string_view{});
    if (!fr.ok) {
        r.ok = false;
        r.error_code = fr.error_code;
        r.error_message = fr.error_message;
        return r;
    }
    r.ok = true;
    r.omm = std::move(fr.omm);
    r.obd = std::move(fr.obd);
    r.ocm = std::move(fr.ocm);
    r.rms_km = fr.rms_km;
    r.converged = fr.converged;
    return r;
}

}  // namespace

std::vector<BatchResult> run_batch_fit(const std::vector<BatchObject>& objs,
                                       int num_threads,
                                       BatchRunStats* stats) {
    const std::size_t n = objs.size();
    std::vector<BatchResult> results(n);
    if (n == 0) {
        if (stats) { stats->threads_requested = num_threads; stats->worker_count = 0; stats->distinct_thread_ids = 0; }
        return results;
    }

    int requested = num_threads;
    if (requested <= 0) {
        // hardware_concurrency() returns 1 under wasm32-wasip1-threads (wasi-libc
        // has no CPU-count source), which would single-thread the pool and spawn
        // ZERO std::threads. Trust it only when it actually reports parallelism
        // (>=2, e.g. a native build); otherwise fall back to the fixed positive
        // default so the bounded work-stealing pool still spawns real workers.
        unsigned hc = std::thread::hardware_concurrency();
        requested = hc >= 2 ? static_cast<int>(hc) : kOdFitDefaultThreads;
    }
    int worker_count = requested;
    if (worker_count < 1) worker_count = 1;
    if (static_cast<std::size_t>(worker_count) > n) worker_count = static_cast<int>(n);

    std::atomic<std::size_t> next_index{0};

    // work-stealing worker: grab the next object index atomically and fit it.
    auto worker = [&]() {
        for (;;) {
            std::size_t idx = next_index.fetch_add(1, std::memory_order_relaxed);
            if (idx >= n) break;
            BatchResult r = fit_one(objs[idx]);
            r.worker_tid = static_cast<unsigned long long>(
                std::hash<std::thread::id>{}(std::this_thread::get_id()));
            results[idx] = std::move(r);
        }
    };

    if (worker_count <= 1) {
        worker();  // single-thread path (identical results — the RMS-parity control)
    } else {
        std::vector<std::thread> threads;
        threads.reserve(static_cast<std::size_t>(worker_count));
        for (int w = 0; w < worker_count; ++w) threads.emplace_back(worker);
        for (auto& t : threads) t.join();
    }

    if (stats) {
        std::set<unsigned long long> ids;
        for (const auto& r : results) if (r.worker_tid != 0) ids.insert(r.worker_tid);
        stats->threads_requested = num_threads;
        stats->worker_count = worker_count;
        stats->distinct_thread_ids = ids.size();
    }
    return results;
}

}  // namespace od
