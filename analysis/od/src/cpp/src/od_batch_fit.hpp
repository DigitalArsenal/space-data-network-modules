// od_batch_fit — the threaded batch OD fit core (the ONE place std::thread fans
// objects across workers). Mirrors the analysis/conjunction-assessment
// std::thread work-stealing fan-out (src/cpp/src/plugin_invoke_bridge.cpp): a
// std::atomic next-index hands each worker the next object; each worker runs the
// SACRED per-object fit (od::fit_ephemeris_fb) over an in-memory $OEM and emits
// $OMM + $OBD + $OCM. Results are indexed by INPUT ORDER so the batch output is
// byte-identical regardless of worker count (RMS bit-parity is preserved:
// per-object fits are independent and deterministic).
//
// This is the isomorphic-pthreads unit: built with the wasi-threads toolchain it
// imports wasi.thread-spawn / exports wasi_thread_start and threads under WasmEdge
// (and, via a SharedArrayBuffer/Worker shim, the browser). $OEM is INPUT ONLY —
// held in memory for the fit and never persisted; only the fitted result records
// leave here.
#ifndef OD_BATCH_FIT_HPP
#define OD_BATCH_FIT_HPP

#include <cstdint>
#include <string>
#include <vector>

namespace od {

struct BatchObject {
    std::vector<uint8_t> oem;  // one in-memory $OEM FlatBuffer (non-size-prefixed)
};

struct BatchResult {
    bool ok = false;
    std::vector<uint8_t> omm;   // size-prefixed $OMM
    std::vector<uint8_t> obd;   // size-prefixed $OBD
    std::vector<uint8_t> ocm;   // size-prefixed $OCM (STATE + real fit COVARIANCE)
    double rms_km = 0.0;
    bool converged = false;
    std::string error_code;
    std::string error_message;
    unsigned long long worker_tid = 0;  // OS thread id (hashed) that ran this fit
};

struct BatchRunStats {
    int threads_requested = 0;
    int worker_count = 0;
    std::size_t distinct_thread_ids = 0;  // distinct OS threads observed across fits
};

// Default worker-thread count for the auto path (num_threads <= 0). CRITICAL:
// std::thread::hardware_concurrency() returns 1 under wasm32-wasip1-threads
// (wasi-libc exposes no CPU-count source; WasmEdge 0.14.1 and V8 both report 1),
// so relying on it single-threads the pool and NO std::thread ever spawns. This
// fixed positive default guarantees the bounded work-stealing pool actually
// spawns workers; run_batch_fit clamps it down to the object count, so a batch of
// one still degenerates to a single fit. 8 gives real parallelism on the 2-vCPU
// prod node plus the observable >1-thread spawn proof, without a
// one-thread-per-object blow-up on the ~11k-object catalog (work-stealing churns
// the full set across the 8 workers).
inline constexpr int kOdFitDefaultThreads = 8;

// Fit an entire batch. worker_count = clamp(num_threads>0 ? num_threads :
// (hardware_concurrency()>=2 ? hardware_concurrency() : kOdFitDefaultThreads), 1,
// objs.size()). Deterministic: results[i] is the fit of objs[i] regardless of
// thread count (per-object fits are independent; RMS bit-parity preserved).
std::vector<BatchResult> run_batch_fit(const std::vector<BatchObject>& objs,
                                       int num_threads,
                                       BatchRunStats* stats);

}  // namespace od

#endif  // OD_BATCH_FIT_HPP
