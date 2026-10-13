/*
 * propagator/solar-system-bodies — kernels read on a pthread.
 *
 * A NAIF SPK or binary PCK of a decade is tens of megabytes. Reading it (the
 * DAF summaries the evaluator walks) runs on a loader thread of this module,
 * so the engine's main thread, which draws a frame from this module every
 * few milliseconds, never stops for it (owner 2026-10-13: modules built with
 * pthreads on a SharedArrayBuffer memory). The kernel's bytes are ADOPTED:
 * the host writes them once into a block it allocated here, and the kernel
 * keeps that block (no copy). The kernel joins the loaded set only when the
 * host commits it, on the host's thread, between two frames.
 *
 * THE CALLING THREAD NEVER WAITS: a load is begun, its completion read from a
 * control word (ssb_kernel_job_control), then committed. While a load runs
 * the host allocates nothing here and the per-frame surface allocates
 * nothing at all, so the two never meet on the allocator's lock (a browser's
 * main thread may not wait on it). Without threads (no cross-origin
 * isolation; a runtime without thread-spawn) the read runs inside the begin
 * call. Text kernels (a few kilobytes) are read synchronously by
 * ssb_load_kernel as before.
 */

#ifndef SSB_KERNEL_LOADER_HPP
#define SSB_KERNEL_LOADER_HPP

#include <atomic>
#include <pthread.h>

namespace ssb_loader {

enum Control : int32_t {
    C_JOB_SEQ = 0,  /* incremented by the host for each load */
    C_DONE_SEQ = 1, /* set to the load's sequence when it is read */
    C_RESULT = 2,   /* 0 read, or a negative code */
    C_THREADED = 3, /* 1 when the loader thread runs */
};

struct Loader {
    std::atomic<int32_t> control[4];
    uint8_t* data = nullptr;
    uint32_t length = 0;
    std::unique_ptr<ssb::Kernel> kernel;
    std::string error;
    bool started = false;
    pthread_t thread;
};

inline Loader& loader() {
    static Loader l;
    return l;
}

/* Reads the pending kernel (on the loader thread, or inline). */
inline void read(Loader& l) {
    auto k = std::make_unique<ssb::Kernel>();
    k->adopted = l.data;
    k->adopted_size = l.length;
    l.data = nullptr;
    int32_t result = ssb::Ok;
    const ephem::Status st = daf::read(k->adopted, k->adopted_size, &k->file, false);
    if (st != ephem::Status::Ok) {
        l.error = std::string("DAF read failed: ") + ephem::status_name(st);
        result = ssb::ErrBadKernel;
    } else {
        k->binary_pck = k->file.ni == 5;
        if (!k->binary_pck && k->file.ni != 6) {
            l.error = "DAF is neither an SPK (ND=2, NI=6) nor a binary PCK (ND=2, NI=5)";
            result = ssb::ErrBadKernel;
        }
    }
    l.kernel = std::move(k);
    l.control[C_RESULT].store(result, std::memory_order_release);
}

inline void finish(Loader& l, int32_t seq) {
    l.control[C_DONE_SEQ].store(seq, std::memory_order_release);
    __builtin_wasm_memory_atomic_notify(reinterpret_cast<int*>(&l.control[C_DONE_SEQ]), 0xFFFFFFFFu);
}

void* thread_main(void*) {
    Loader& l = loader();
    int32_t seen = 0;
    for (;;) {
        while (l.control[C_JOB_SEQ].load(std::memory_order_acquire) == seen) {
            __builtin_wasm_memory_atomic_wait32(reinterpret_cast<int*>(&l.control[C_JOB_SEQ]), seen, -1);
        }
        seen = l.control[C_JOB_SEQ].load(std::memory_order_acquire);
        read(l);
        finish(l, seen);
    }
}

}  // namespace ssb_loader

/* The loader's control words (int32[4], see ssb_loader::Control). */
SSB_EXPORT("ssb_kernel_job_control") uint32_t ssb_kernel_job_control(void) {
    return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(ssb_loader::loader().control));
}

/* Begins reading the SPK or binary PCK at `ptr` (`len` bytes, a block from
 * plugin_alloc that the kernel adopts: the host does not free it). Returns
 * the load's sequence, or a negative code. */
SSB_EXPORT("ssb_kernel_job_begin") int32_t ssb_kernel_job_begin(uint8_t* ptr, uint32_t len) {
    using namespace ssb_loader;
    Loader& l = loader();
    if (ptr == nullptr || len < 8) return ssb::ErrBadKernel;
    if (!(std::memcmp(ptr, "DAF/SPK", 7) == 0 || std::memcmp(ptr, "DAF/PCK", 7) == 0 ||
          std::memcmp(ptr, "NAIF/DAF", 8) == 0)) {
        return ssb::ErrBadKernel;
    }
    if (!l.started) {
        l.started = true;
        for (auto& w : l.control) w.store(0);
        if (pthread_create(&l.thread, nullptr, thread_main, nullptr) == 0) {
            pthread_detach(l.thread);
            l.control[C_THREADED].store(1);
        }
    }
    l.data = ptr;
    l.length = len;
    l.error.clear();
    const int32_t seq = l.control[C_JOB_SEQ].load(std::memory_order_acquire) + 1;
    if (l.control[C_THREADED].load() == 0) {
        l.control[C_JOB_SEQ].store(seq, std::memory_order_release);
        read(l);
        finish(l, seq);
        return seq;
    }
    l.control[C_JOB_SEQ].store(seq, std::memory_order_release);
    __builtin_wasm_memory_atomic_notify(reinterpret_cast<int*>(&l.control[C_JOB_SEQ]), 0xFFFFFFFFu);
    return seq;
}

/* Joins the kernel read by the last load to the loaded set (on the host's
 * thread, once control[C_DONE_SEQ] reached its sequence). Returns the number
 * of kernels loaded, or a negative code (ssb_last_error says why). */
SSB_EXPORT("ssb_kernel_job_commit") int32_t ssb_kernel_job_commit(void) {
    using namespace ssb_loader;
    Loader& l = loader();
    const int32_t result = l.control[C_RESULT].load(std::memory_order_acquire);
    if (!l.kernel) return ssb::ErrBadArgument;
    if (result != ssb::Ok) {
        ssb::state().error = l.error;
        l.kernel.reset();
        return result;
    }
    ssb::State& s = ssb::state();
    s.kernels.push_back(std::move(l.kernel));
    return static_cast<int32_t>(s.kernels.size());
}

#endif
