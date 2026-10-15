#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

// The module's methods are the typed SDK methods in src/plugin_entrypoints.cpp;
// this file keeps the Emscripten keep-alive helpers only.

#include <cstdlib>

extern "C" {

EMSCRIPTEN_KEEPALIVE
void* wasm_malloc(int size) {
    return std::malloc(size > 0 ? static_cast<size_t>(size) : 1u);
}

EMSCRIPTEN_KEEPALIVE
void wasm_free(void* ptr) {
    std::free(ptr);
}

}  // extern "C"
