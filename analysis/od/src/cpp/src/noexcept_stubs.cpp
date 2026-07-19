// Exception-ABI stubs for the wasi-threads (wasm32-wasip1-threads) build.
//
// The wasi-sdk threads libc++ is built exception-free, so it ships NO C++
// exception runtime (__cxa_throw / __cxa_allocate_exception / personality). The
// OD sources are compiled -fignore-exceptions (which lets their try/catch/throw
// compile without emitting exnref that WasmEdge's AOT cannot parse), but an
// explicit `throw` still emits a call to __cxa_throw. Those paths are ERROR paths
// only (malformed input) and NEVER fire on the fit path, so routing them to
// std::abort() — a clean, host-visible trap — is correct and keeps the module
// link-complete. NOT used by the Emscripten browser build (that libc++ provides
// the real runtime); this TU is only linked into the wasi-threads artifact.
#include <cstdlib>

// WEAK so this TU is composable: the standalone module.wasm links it as the sole
// definition, and a baked flow that partial-links MANY guest-link objects (each
// carrying these stubs) resolves to a single weak def with no duplicate-symbol
// conflict — and a stronger runtime-provided def (if any) still wins.
#define OD_WEAK __attribute__((weak))
extern "C" {
OD_WEAK void* __cxa_allocate_exception(unsigned long) { std::abort(); }
OD_WEAK void __cxa_free_exception(void*) {}
OD_WEAK void __cxa_throw(void*, void*, void*) { std::abort(); }
OD_WEAK void __cxa_rethrow() { std::abort(); }
OD_WEAK void* __cxa_begin_catch(void*) { std::abort(); }
OD_WEAK void __cxa_end_catch() {}
OD_WEAK void __cxa_call_unexpected(void*) { std::abort(); }
OD_WEAK void __cxa_pure_virtual() { std::abort(); }
OD_WEAK int __gxx_personality_v0(int, int, unsigned long long, void*, void*) { std::abort(); }
OD_WEAK void _Unwind_Resume(void*) { std::abort(); }
}
