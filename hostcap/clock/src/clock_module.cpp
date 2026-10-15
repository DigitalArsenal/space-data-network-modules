/*
 * hostcap/clock — the host clock connector (typed contracts 1.0).
 *
 *   now — an optional "trigger" frame, a TimerTick (TICK, module-sdk runtime type; its payload is not read)
 *         -> clock.now (SDS $PIV: no params, "result" TimeValue record, UNIX_MS)
 *            and clock.nowIso (SDS $PIV: no params, raw "value" = the host's RFC3339 text)
 *         -> one "time" frame, a $TIM (SDS standard TIM): TIME_SYSTEM UTC and INSTANT
 *            {TIME_SYSTEM UTC, EPOCH_FORMAT UNIX_SECONDS, SECONDS = whole Unix seconds,
 *             SUBSECOND_NANOS = the millisecond remainder in nanoseconds, ISO8601 = clock.nowIso verbatim}.
 *
 * SECONDS + SUBSECOND_NANOS carry clock.now's Unix milliseconds exactly (no double rounding of the
 * millisecond count); ISO8601 is the host's own reading, sampled right after.
 *
 * Periodic emission is a flow TRIGGER concern (the timer trigger kind), not this node: the node samples the
 * clock once per invoke. No JSON anywhere.
 */

#include <cstdint>
#include <string>
#include <string_view>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "TIM_generated.h"  // spacedatastandards.org lib/cpp/TIM/main_generated.h, inlined by build.mjs

namespace {

namespace A = sdn::runtime::Aligned;

int fail(const sdm_piv::Response& response, const char* fallback) {
    const std::string message = response.error_message();
    plugin_set_error("clock-unavailable", message.empty() ? fallback : message.c_str());
    return 502;
}

}  // namespace

extern "C" {

// now: sample clock.now (unix ms) + clock.nowIso (RFC3339) and emit one "time" frame, a $TIM.
int now(void) {
    const auto now_response = sdm_piv::call("clock.now");
    const auto* now_value = now_response.ok() ? now_response.result<A::TimeValue>("TimeValue") : nullptr;
    if (!now_value) return fail(now_response, "clock.now hostcall failed.");
    const uint64_t unix_ms = now_value->UNIX_MS;

    const auto iso_response = sdm_piv::call("clock.nowIso");
    if (!iso_response.ok()) return fail(iso_response, "clock.nowIso hostcall failed.");
    const std::string iso(iso_response.raw("value"));
    if (iso.empty()) {
        plugin_set_error("clock-unavailable", "clock.nowIso answered without a \"value\" frame.");
        return 502;
    }

    flatbuffers::FlatBufferBuilder b(256);
    const auto instant = CreateTIMInstantDirect(
        b, timingStandard_UTC, timEpochRepresentation_UNIX_SECONDS, 0.0,
        static_cast<double>(unix_ms / 1000u), iso.c_str(), static_cast<int32_t>((unix_ms % 1000u) * 1000000u));
    FinishTIMBuffer(b, CreateTIM(b, timingStandard_UTC, instant));
    const int32_t pushed = plugin_push_output_ex("time", "TIM.fbs", TIMIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                                 "TIM", 0, 0, b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize()));
    return pushed < 0 ? 500 : 0;
}

}  // extern "C"
