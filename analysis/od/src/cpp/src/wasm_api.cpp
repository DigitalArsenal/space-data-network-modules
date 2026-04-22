/**
 * WASM API for SGP4 fitter
 *
 * C-ABI exports for use from JavaScript via Emscripten.
 * Provides parse/fit pipeline for MEME ephemeris data.
 */

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

#include "od/meme_parser.h"
#include "od/plugin_runtime.h"
#include "od/sgp4_fitter.h"
#include <cstdlib>
#include <cstring>
#include <string>
#include <unordered_map>

static int next_handle = 1;
static std::unordered_map<int, od::MEMEFile> meme_store;
static std::string last_result;

extern "C" {

EMSCRIPTEN_KEEPALIVE
void* wasm_malloc(int size) {
    return std::malloc(size);
}

EMSCRIPTEN_KEEPALIVE
void wasm_free(void* ptr) {
    std::free(ptr);
}

EMSCRIPTEN_KEEPALIVE
int wasm_parse(const char* meme_content, int len) {
    std::string content(meme_content, len);
    try {
        od::MEMEFile meme = od::parse_meme(content);
        if (meme.points.empty()) return -1;
        int handle = next_handle++;
        meme_store[handle] = std::move(meme);
        return handle;
    } catch (...) {
        return -1;
    }
}

EMSCRIPTEN_KEEPALIVE
const char* wasm_fit(int handle) {
    auto it = meme_store.find(handle);
    if (it == meme_store.end()) {
        last_result = "{\"error\":\"invalid handle\"}";
        return last_result.c_str();
    }

    od::FitterConfig config;
    auto result = od::fit_sgp4_meme(it->second, config);
    last_result = od::elements_to_json(result.elements);

    // Clean up stored MEME data
    meme_store.erase(it);

    return last_result.c_str();
}

EMSCRIPTEN_KEEPALIVE
const char* wasm_parse_and_fit(const char* meme_content, int len) {
    const auto result = od::fit_meme_payload(std::string_view(meme_content, len));
    last_result = result.json;
    return last_result.c_str();
}

}  // extern "C"
