/*
 * hostcap/random — the host CSPRNG connector (typed contracts 1.0).
 *
 *   bytes — an optional "request" frame, a $RND (SDS standard RND) stating LENGTH (0 or absent = 32)
 *           -> random.bytes (SDS $PIV: "params" RandomBytesParams {LENGTH}, the bytes on raw "data")
 *              and clock.now (SDS $PIV: "result" TimeValue, UNIX_MS) for the generation time
 *           -> one "bytes" frame, a $RND: LENGTH, BYTES (the host's bytes verbatim), SOURCE SystemCsprng,
 *              GENERATED_AT_MS.
 *
 * LENGTH is 1..8192 (HostOps.fbs RandomBytesParams; the Go node refuses more as too-large): a larger request is
 * refused here with "invalid-length" before any hostcall. A request asking for a SOURCE other than Unspecified or
 * SystemCsprng is refused ("unsupported-source"): the host offers only its system CSPRNG. A host answer whose byte
 * count differs from LENGTH is refused, never passed on short. No JSON anywhere.
 */

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <string_view>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "RND_generated.h"  // spacedatastandards.org lib/cpp/RND/main_generated.h, inlined by build.mjs

namespace {

namespace A = sdn::runtime::Aligned;

constexpr uint32_t kDefaultLength = 32;
constexpr uint32_t kMaxLength = 8192;

int fail(const char* code, const sdm_piv::Response& response, const char* fallback) {
    const std::string message = response.error_message();
    plugin_set_error(code, message.empty() ? fallback : message.c_str());
    return 502;
}

}  // namespace

extern "C" {

// bytes: the optional $RND request -> random.bytes + clock.now -> one "bytes" frame, a $RND.
int bytes(void) {
    uint32_t length = kDefaultLength;
    const plugin_input_frame_t* request = nullptr;
    const uint32_t input_count = plugin_get_input_count();
    for (uint32_t i = 0; i < input_count; i++) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        if (!frame || !frame->port_id || std::strcmp(frame->port_id, "request") != 0) continue;
        if (request) {
            // Single-stream port: a surplus request is refused, never silently dropped.
            plugin_set_error("batched-input-frames",
                             "bytes takes at most one $RND frame on \"request\"; the surplus frames are refused.");
            return 400;
        }
        request = frame;
    }
    if (request) {
        flatbuffers::Verifier verifier(request->payload, request->payload_length);
        if (!request->payload || !VerifyRNDBuffer(verifier)) {
            plugin_set_error("invalid-request", "the request frame is not a $RND (Random Data).");
            return 400;
        }
        const RND* rnd = GetRND(request->payload);
        if (rnd->SOURCE() != rndSource_Unspecified && rnd->SOURCE() != rndSource_SystemCsprng) {
            plugin_set_error("unsupported-source", "the host offers only its system CSPRNG (SOURCE SystemCsprng).");
            return 400;
        }
        if (rnd->LENGTH() != 0) length = rnd->LENGTH();
    }
    if (length < 1 || length > kMaxLength) {
        plugin_set_error("invalid-length", "random bytes length must be between 1 and 8192.");
        return 400;
    }

    A::RandomBytesParams params{};
    params.LENGTH = length;
    const auto random = sdm_piv::call("random.bytes", "RandomBytesParams", params);
    if (!random.ok()) return fail("random-unavailable", random, "random.bytes hostcall failed.");
    const std::string_view data = random.raw("data");
    if (data.size() != length) {
        char message[128];
        std::snprintf(message, sizeof message, "random.bytes answered %zu bytes for a request of %u.", data.size(),
                      static_cast<unsigned>(length));
        plugin_set_error("random-unavailable", message);
        return 502;
    }

    const auto now = sdm_piv::call("clock.now");
    const auto* now_value = now.ok() ? now.result<A::TimeValue>("TimeValue") : nullptr;
    if (!now_value) return fail("clock-unavailable", now, "clock.now hostcall failed.");

    flatbuffers::FlatBufferBuilder b(length + 128);
    const auto bytes_offset = b.CreateVector(reinterpret_cast<const uint8_t*>(data.data()), data.size());
    FinishRNDBuffer(b, CreateRND(b, length, bytes_offset, rndSource_SystemCsprng,
                                 static_cast<int64_t>(now_value->UNIX_MS)));
    const int32_t pushed = plugin_push_output_ex("bytes", "RND.fbs", RNDIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                                 "RND", 0, 0, b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize()));
    return pushed < 0 ? 500 : 0;
}

}  // extern "C"
