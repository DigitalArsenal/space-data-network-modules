/*
 * hostcap/node-activity — the host node_activity_read connector (typed contracts 1.0).
 *
 *   activity — "decision": ONE $APR (SDS API Request) from foundation/http-route route_node_activity.
 *              Served only when ROUTE is "activity" and STATUS is 0: the APR's "limit" parameter (route-clamped;
 *              re-clamped here to [1, 256], default 50 - this node never trusts the clamp blindly) goes to
 *              node_activity_read.activity (SDS $PIV: NodeActivityParams{LIMIT}; list "events" NodeActivityEvent,
 *              newest first), node.peerId (raw "value": NEV.NODE_ID) and clock.now (TimeValue: NEV.GENERATED_AT_MS;
 *              0 when the host clock is unavailable)
 *              -> "decision": the input $APR verbatim, and "activity": ONE $NEV (SDS Node Event).
 *              Event kinds: peer_connected PeerConnected, peer_disconnected PeerDisconnected, pnm_publication
 *              PublicationSent, record_stored RecordsStored, grant_issued GrantIssued; any other kind is Other with
 *              DETAIL "<kind>: <detail>" so nothing the host said is lost.
 *              A refused decision (STATUS set upstream, e.g. 405) passes through untouched with no hostcall and no
 *              body; a ROUTE this method does not own is answered 404 "no-route". A node_activity_read.activity
 *              failure answers the $APR with STATUS 503 "activity-unavailable" and the host's message.
 *
 * No JSON anywhere: foundation/http-respond renders the $NEV (verbatim, or as JSON when the APR's ACCEPT asks).
 */

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <string_view>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "APR_generated.h"  // spacedatastandards.org lib/cpp/APR/main_generated.h, inlined by build.mjs
#include "NEV_generated.h"  // spacedatastandards.org lib/cpp/NEV/main_generated.h, inlined by build.mjs

namespace {

namespace A = sdn::runtime::Aligned;

constexpr long kDefaultLimit = 50;
constexpr long kMaxLimit = 256;

// SURPLUS-FRAME REFUSAL (graph task modules-guest-nodes-drop-batched-frames): the compiled flow runtime drains a
// node's queue port-blind, so a second frame on the single-stream "decision" port would otherwise be destroyed
// silently. One decision answers one HTTP exchange; a surplus is refused by name.
bool find_batched_input_port(char* message, size_t message_len) {
    const uint32_t count = plugin_get_input_count();
    for (uint32_t i = 0; i < count; i++) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        if (!frame || !frame->port_id) continue;
        for (uint32_t j = 0; j < i; j++) {
            const plugin_input_frame_t* earlier = plugin_get_input_frame(j);
            if (!earlier || !earlier->port_id || std::strcmp(earlier->port_id, frame->port_id) != 0) continue;
            uint32_t on_port = 0;
            for (uint32_t k = 0; k < count; k++) {
                const plugin_input_frame_t* f = plugin_get_input_frame(k);
                if (f && f->port_id && std::strcmp(f->port_id, frame->port_id) == 0) on_port++;
            }
            std::snprintf(message, message_len,
                          "This invocation carries %u frames on single-stream input port \"%s\" "
                          "(the compiled flow runtime drains a node's whole queue port-blind; "
                          "maxStreams is declarative only). The surplus frames are refused "
                          "rather than silently discarded.",
                          on_port, frame->port_id);
            return true;
        }
    }
    return false;
}

int push_apr(const uint8_t* data, size_t size) {
    return plugin_push_output_ex("decision", "APR.fbs", APRIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "APR", 0, 0,
                                 data, static_cast<uint32_t>(size)) < 0 ? 500 : 0;
}

// The decision answered with STATUS / ERROR_CODE / ERROR_MESSAGE; every other field kept.
int refuse(const APR& apr, uint16_t status, const char* code, const std::string& message) {
    APRT copy;
    apr.UnPackTo(&copy);
    copy.STATUS = status;
    copy.ERROR_CODE = code;
    copy.ERROR_MESSAGE = message;
    flatbuffers::FlatBufferBuilder b(512);
    FinishAPRBuffer(b, APR::Pack(b, &copy));
    return push_apr(b.GetBufferPointer(), b.GetSize());
}

// The APR's "limit" parameter: full-string integer validation (garbage falls back to the default, never a partial
// parse), clamped to [1, 256].
uint32_t limit_of(const APR& apr) {
    long limit = kDefaultLimit;
    if (const auto* params = apr.PARAMETERS()) {
        for (const auto* p : *params) {
            if (!p || !p->NAME() || p->NAME()->str() != "limit" || !p->VALUE()) continue;
            const std::string value = p->VALUE()->str();
            char* end = nullptr;
            const long parsed = std::strtol(value.c_str(), &end, 10);
            if (end != value.c_str() && end && *end == '\0') limit = parsed;
            break;
        }
    }
    if (limit < 1) limit = 1;
    if (limit > kMaxLimit) limit = kMaxLimit;
    return static_cast<uint32_t>(limit);
}

nevEventKind kind_of(const std::string& kind) {
    if (kind == "peer_connected") return nevEventKind_PeerConnected;
    if (kind == "peer_disconnected") return nevEventKind_PeerDisconnected;
    if (kind == "pnm_publication") return nevEventKind_PublicationSent;
    if (kind == "record_stored") return nevEventKind_RecordsStored;
    if (kind == "grant_issued") return nevEventKind_GrantIssued;
    return nevEventKind_Other;
}

}  // namespace

extern "C" {

int activity(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const int32_t index = plugin_find_input_index("decision", 0);
    const plugin_input_frame_t* frame = index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
    if (!frame || !frame->payload || frame->payload_length == 0) {
        plugin_set_error("missing-decision-frame", "activity requires the $APR decision frame on port \"decision\".");
        return 400;
    }
    flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!APRBufferHasIdentifier(frame->payload) || !VerifyAPRBuffer(verifier)) {
        plugin_set_error("invalid-decision-frame", "the decision frame is not an $APR (SDS API Request).");
        return 400;
    }
    const APR& apr = *GetAPR(frame->payload);

    if (apr.STATUS() != 0) return push_apr(frame->payload, frame->payload_length);
    const std::string route = apr.ROUTE() ? apr.ROUTE()->str() : std::string();
    if (route != "activity") {
        return refuse(apr, 404, "no-route", "node activity serves route \"activity\", not \"" + route + "\"");
    }

    A::NodeActivityParams params{};
    params.LIMIT = limit_of(apr);
    const auto read = sdm_piv::call("node_activity_read.activity", "NodeActivityParams", params);
    if (!read.ok()) {
        std::string message = read.error_message();
        if (message.empty()) message = "node_activity_read.activity hostcall failed.";
        return refuse(apr, 503, "activity-unavailable", message);
    }

    NEVT nev;
    const auto peer = sdm_piv::call("node.peerId");
    if (peer.ok()) nev.NODE_ID = std::string(peer.raw("value"));
    const auto now = sdm_piv::call("clock.now");
    if (const auto* t = now.ok() ? now.result<A::TimeValue>("TimeValue") : nullptr) {
        nev.GENERATED_AT_MS = static_cast<int64_t>(t->UNIX_MS);
    }
    const auto [events, count] = read.list<A::NodeActivityEvent>("events", "NodeActivityEvent");
    for (size_t i = 0; events && i < count; i++) {
        auto event = std::make_unique<NEVEventT>();
        const std::string kind = events[i].KIND.str();
        event->TIME_MS = static_cast<int64_t>(events[i].TS_MS);
        event->KIND = kind_of(kind);
        event->PEER_ID = events[i].PEER_ID.str();
        event->DETAIL = events[i].DETAIL.str();
        if (event->KIND == nevEventKind_Other && !kind.empty()) event->DETAIL = kind + ": " + event->DETAIL;
        nev.EVENTS.push_back(std::move(event));
    }

    flatbuffers::FlatBufferBuilder b(1024);
    FinishNEVBuffer(b, NEV::Pack(b, &nev));
    if (plugin_push_output_ex("activity", "NEV.fbs", NEVIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "NEV", 0, 0,
                              b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0) {
        return 500;
    }
    return push_apr(frame->payload, frame->payload_length);
}

}  // extern "C"
