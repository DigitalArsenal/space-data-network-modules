#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

#include "hpop/plugin_runtime.h"

#include <cstdlib>
#include <string>

namespace {

std::string g_last_result;

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
void* wasm_malloc(int size) {
    return std::malloc(size > 0 ? static_cast<size_t>(size) : 1u);
}

EMSCRIPTEN_KEEPALIVE
void wasm_free(void* ptr) {
    std::free(ptr);
}

EMSCRIPTEN_KEEPALIVE
const char* wasm_invoke_json(const char* request_json, int len) {
    const auto result = hpop::invoke_json_request(
        std::string_view(request_json, static_cast<size_t>(len)));
    g_last_result = result.json;
    return g_last_result.c_str();
}

}  // extern "C"
