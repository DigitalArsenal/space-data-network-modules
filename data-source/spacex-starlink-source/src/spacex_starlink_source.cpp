/*
 * SpaceX Starlink data-source module — WASM ABI skeleton (WS5.1).
 *
 * Canonical SDN module ABI. The `pull` method (fetch Starlink ephemeris over
 * HTTP, parse + validate, store, sign a PNM, publish) is driven by the manifest
 * TIMERS entry and lands in WS5.2-5.4 via the space_data_module_host host-cap
 * bridge. This skeleton establishes the exported ABI so the module builds and
 * loads; plugin_invoke_stream currently returns an empty response.
 *
 * plugin_get_manifest_flatbuffer[_size] are provided by the generated
 * manifest-exports.cpp.
 */
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

extern "C" {

// Guest allocator used by the host to pass request/response buffers.
__attribute__((visibility("default")))
uint8_t* plugin_alloc(uint32_t size) {
    return static_cast<uint8_t*>(malloc(size));
}

__attribute__((visibility("default")))
void plugin_free(uint8_t* ptr, uint32_t /*size*/) {
    free(ptr);
}

// Canonical streaming invoke entrypoint. A PIV request frame arrives in
// [req_ptr, req_len); the response length is written to *out_len_ptr and the
// response buffer (guest-allocated) is returned. The skeleton returns an empty
// response (out_len = 0) until the `pull` method is implemented (WS5.2-5.4).
__attribute__((visibility("default")))
uint8_t* plugin_invoke_stream(const uint8_t* req_ptr, uint32_t req_len, uint32_t* out_len_ptr) {
    (void)req_ptr;
    (void)req_len;
    if (out_len_ptr != nullptr) {
        *out_len_ptr = 0;
    }
    return nullptr;
}

}  // extern "C"
