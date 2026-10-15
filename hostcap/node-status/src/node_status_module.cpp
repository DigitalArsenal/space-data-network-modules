/*
 * hostcap/node-status — the host node_status_read connector (typed contracts 1.0).
 *
 *   status — "decision": ONE $APR (SDS API Request) from foundation/http-route route_node_status.
 *            Served only when ROUTE is "status" and STATUS is 0:
 *              node_status_read.status (SDS $PIV: no params; "result" NodeStatusReport, list "bandwidth_history"
 *              NodeBandwidthSample), node.peerId (raw "value": NHS.NODE_ID) and clock.now (TimeValue:
 *              NHS.GENERATED_AT_MS; 0 when the host clock is unavailable - the snapshot is still served)
 *            -> "decision": the input $APR verbatim, and "status": ONE $NHS (SDS Node Health Status).
 *            A refused decision (STATUS set upstream, e.g. 405) passes through untouched with no hostcall and no
 *            body; a ROUTE this method does not own is answered 404 "no-route". A node_status_read.status failure
 *            answers the $APR with STATUS 503 "status-unavailable" and the host's message - never an empty body.
 *
 * No JSON anywhere: foundation/http-respond renders the $NHS (verbatim, or as JSON when the APR's ACCEPT asks).
 */

#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <string_view>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "APR_generated.h"  // spacedatastandards.org lib/cpp/APR/main_generated.h, inlined by build.mjs
#include "NHS_generated.h"  // spacedatastandards.org lib/cpp/NHS/main_generated.h, inlined by build.mjs

namespace {

namespace A = sdn::runtime::Aligned;

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

nhsServiceState state_of(std::string state) {
    for (char& c : state) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (state == "starting") return nhsServiceState_Starting;
    if (state == "running") return nhsServiceState_Running;
    if (state == "degraded") return nhsServiceState_Degraded;
    if (state == "draining") return nhsServiceState_Draining;
    if (state == "stopped") return nhsServiceState_Stopped;
    if (state == "failed") return nhsServiceState_Failed;
    return nhsServiceState_Unknown;
}

}  // namespace

extern "C" {

int status(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const int32_t index = plugin_find_input_index("decision", 0);
    const plugin_input_frame_t* frame = index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
    if (!frame || !frame->payload || frame->payload_length == 0) {
        plugin_set_error("missing-decision-frame", "status requires the $APR decision frame on port \"decision\".");
        return 400;
    }
    flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!APRBufferHasIdentifier(frame->payload) || !VerifyAPRBuffer(verifier)) {
        plugin_set_error("invalid-decision-frame", "the decision frame is not an $APR (SDS API Request).");
        return 400;
    }
    const APR& apr = *GetAPR(frame->payload);

    // Refused upstream (e.g. 405): the decision answers the exchange; nothing to read.
    if (apr.STATUS() != 0) return push_apr(frame->payload, frame->payload_length);
    const std::string route = apr.ROUTE() ? apr.ROUTE()->str() : std::string();
    if (route != "status") {
        return refuse(apr, 404, "no-route", "node status serves route \"status\", not \"" + route + "\"");
    }

    const auto report_response = sdm_piv::call("node_status_read.status");
    const auto* report = report_response.ok() ? report_response.result<A::NodeStatusReport>("NodeStatusReport") : nullptr;
    if (!report) {
        std::string message = report_response.error_message();
        if (message.empty()) message = "node_status_read.status answered without a NodeStatusReport.";
        return refuse(apr, 503, "status-unavailable", message);
    }

    NHST nhs;
    const auto peer = sdm_piv::call("node.peerId");
    if (peer.ok()) nhs.NODE_ID = std::string(peer.raw("value"));
    const auto now = sdm_piv::call("clock.now");
    if (const auto* t = now.ok() ? now.result<A::TimeValue>("TimeValue") : nullptr) {
        nhs.GENERATED_AT_MS = static_cast<int64_t>(t->UNIX_MS);
    }
    nhs.STARTED_AT_MS = static_cast<int64_t>(report->STARTED_MS);
    nhs.UPTIME_S = report->UPTIME_S;
    nhs.SERVICE_STATE = state_of(report->SERVICE_STATE.str());
    nhs.SERVICE_MODE = report->SERVICE_MODE.str();
    nhs.STORAGE_PATH = report->STORAGE_PATH.str();
    nhs.STORE_TOTAL_RECORDS = report->STORE_TOTAL_RECORDS;
    nhs.STORE_TOTAL_BYTES = report->STORE_TOTAL_BYTES;
    nhs.HAS_DISK = report->HAS_DISK;
    nhs.DISK_CAPACITY_BYTES = report->DISK_CAPACITY_BYTES;
    nhs.DISK_FREE_BYTES = report->DISK_FREE_BYTES;
    nhs.DISK_AVAILABLE_BYTES = report->DISK_AVAILABLE_BYTES;
    nhs.HAS_NETWORK = report->HAS_BANDWIDTH;
    nhs.TOTAL_IN_BYTES = report->TOTAL_IN_BYTES;
    nhs.TOTAL_OUT_BYTES = report->TOTAL_OUT_BYTES;
    nhs.RATE_IN_BPS = report->RATE_IN_BPS;
    nhs.RATE_OUT_BPS = report->RATE_OUT_BPS;
    const auto [samples, sample_count] = report_response.list<A::NodeBandwidthSample>("bandwidth_history", "NodeBandwidthSample");
    for (size_t i = 0; samples && i < sample_count; i++) {
        auto sample = std::make_unique<NHSThroughputSampleT>();
        sample->TIME_MS = static_cast<int64_t>(samples[i].TS_MS);
        sample->TOTAL_IN_BYTES = samples[i].TOTAL_IN_BYTES;
        sample->TOTAL_OUT_BYTES = samples[i].TOTAL_OUT_BYTES;
        sample->RATE_IN_BPS = samples[i].RATE_IN_BPS;
        sample->RATE_OUT_BPS = samples[i].RATE_OUT_BPS;
        nhs.THROUGHPUT_HISTORY.push_back(std::move(sample));
    }

    flatbuffers::FlatBufferBuilder b(1024);
    FinishNHSBuffer(b, NHS::Pack(b, &nhs));
    if (plugin_push_output_ex("status", "NHS.fbs", NHSIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "NHS", 0, 0,
                              b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0) {
        return 500;
    }
    return push_apr(frame->payload, frame->payload_length);
}

}  // extern "C"
