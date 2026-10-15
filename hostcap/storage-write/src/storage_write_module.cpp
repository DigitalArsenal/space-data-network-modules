/*
 * hostcap/storage-write — the host storage.write connector (typed contracts 1.0; graph tasks
 * mod-cell-tower-ingest-flow / upstream-modules-2).
 *
 * Capability node wrapping the host `storage.write` hostcall — the SCHEMA-TYPED single-record write lane. One method:
 *
 *   write_record — input:
 *     "record" ONE SDS record (a FlatBuffer root buffer carrying its own file identifier). The port is typed, so it
 *              names the standard it takes: $IRM (Ingest Resume Mark), the record every in-repo flow writes here.
 *   output:
 *     "result" ONE $PNM (Publish Notification Message, an existing SDS standard): CID = the content id the host
 *              assigned, FILE_NAME = the standard the record was filed under (e.g. "IRM.fbs").
 *
 * The hostcall is an SDS $PIV invocation of storage.write: the StorageWriteParams aligned record (SCHEMA) + raw "data"
 * (the record verbatim), answered with the StorageWriteResult aligned record (CID). No JSON and no base64.
 *
 * WHY THIS NODE HAD TO EXIST. `mod-cell-tower-ingest-flow` shipped a chunked bulk-ingest flow whose resume mark had
 * NOWHERE DURABLE TO GO: hostcap/flatsql-store is wasi-threads (the flow compiler refuses to link it into a
 * single-thread flow) and admits only $OMM/$OCM/$OBD; hostcap/file has no Go host handler; storage.write was exactly
 * right but schema-typed. Themis minted $IRM (spacedatastandards.org 1.196.0), so the lane was built — generically:
 * nothing here knows what $IRM is.
 *
 * THE TYPE AND THE BYTES MUST AGREE, AND THAT IS CHECKED. `storage.write` files the bytes under whatever schema it is
 * told, and a record in the wrong type's table is indistinguishable from one never written. The JSON lane took a
 * declared type on an optional meta frame; on the typed lane the declared type is the frame's own type reference (its
 * file identifier), and the intrinsic type is the record's file identifier (bytes 4..7). When both are present and
 * DISAGREE, the write is REFUSED — neither is preferred, neither is coerced. A record with neither is refused too.
 *
 * POLICY IS THE HOST'S. `storage.write` is gated by the dedicated `storage_write` capability grant, which
 * `storage_query` explicitly does NOT imply. This node moves bytes and refuses contradictions.
 */

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"

namespace {

namespace A = sdn::runtime::Aligned;

const plugin_input_frame_t* frame_for(const char* port) {
    const int32_t idx = plugin_find_input_index(port, 0);
    if (idx < 0) return nullptr;
    return plugin_get_input_frame(static_cast<uint32_t>(idx));
}

// SURPLUS-FRAME REFUSAL. The compiled flow runtime drains a node's queue PORT-BLIND up to a budget of 64;
// maxStreams/maxBatch/drainPolicy are purely declarative there. A guest that reads ordinal 0 and returns destroys every
// other frame it was handed (live P1 `cellular-multiprovider-returns-only-first-provider`). `write_record` persists ONE
// record and answers with ONE cid, so a surplus cannot be merged into a correct answer — a second record silently
// dropped is a mark that was never durable, which is precisely the failure this lane exists to fix.
bool find_batched_input_port(char* message, size_t message_len) {
    const uint32_t count = plugin_get_input_count();
    for (uint32_t i = 0; i < count; i++) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        if (!frame || !frame->port_id) continue;
        for (uint32_t j = 0; j < i; j++) {
            const plugin_input_frame_t* earlier = plugin_get_input_frame(j);
            if (!earlier || !earlier->port_id) continue;
            if (std::strcmp(earlier->port_id, frame->port_id) != 0) continue;
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

bool is_code(std::string_view code) {
    if (code.size() != 3) return false;
    for (const char c : code) {
        if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))) return false;
    }
    return true;
}

// The SDS type a FlatBuffer declares about ITSELF: bytes 4..7 of a root buffer are "$XXX". "" when absent — never
// guessed.
std::string type_from_file_identifier(const uint8_t* data, uint32_t length) {
    if (!data || length < 8 || data[4] != '$') return std::string();
    const std::string_view code(reinterpret_cast<const char*>(data + 5), 3);
    return is_code(code) ? std::string(code) : std::string();
}

// The type the frame was handed in as: its type reference's file identifier ("$IRM"), or its schema name ("IRM.fbs").
std::string type_from_frame(const plugin_input_frame_t& frame) {
    if (frame.file_identifier && frame.file_identifier[0] == '$' && is_code(frame.file_identifier + 1)) {
        return std::string(frame.file_identifier + 1);
    }
    if (frame.schema_name) {
        const std::string_view name(frame.schema_name);
        if (name.size() == 7 && name.substr(3) == ".fbs" && is_code(name.substr(0, 3))) return std::string(name.substr(0, 3));
    }
    return std::string();
}

// A $PNM (spacedatastandards.org PNM/main.fbs) carrying CID (field 2) and FILE_NAME (field 3). Built directly: the
// table has only string fields, and the SDK stages no generated header for SDS standards beyond PIV/TAB.
std::vector<uint8_t> publish_notice(const std::string& cid, const std::string& file_name) {
    flatbuffers::FlatBufferBuilder b(256);
    const auto cid_offset = b.CreateString(cid);
    const auto name_offset = b.CreateString(file_name);
    const auto start = b.StartTable();
    b.AddOffset(8, cid_offset);    // CID
    b.AddOffset(10, name_offset);  // FILE_NAME
    const flatbuffers::Offset<void> root(b.EndTable(start));
    b.Finish(root, "$PNM");
    return std::vector<uint8_t>(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

}  // namespace

extern "C" {

int write_record(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    const plugin_input_frame_t* record = frame_for("record");
    if (!record || !record->payload || record->payload_length == 0) {
        plugin_set_error("missing-record-frame", "write requires the record FlatBuffer frame.");
        return 400;
    }

    const std::string declared = type_from_frame(*record);
    const std::string intrinsic = type_from_file_identifier(record->payload, record->payload_length);

    // THE CONTRADICTION IS REFUSED, NOT RESOLVED. Preferring either value would file the bytes under a type the other
    // half of the system will not look for.
    if (!declared.empty() && !intrinsic.empty() && declared != intrinsic) {
        char message[320];
        std::snprintf(message, sizeof(message),
                      "the record frame is typed \"$%s\" but the record's own file identifier is "
                      "\"$%s\". The write is refused rather than filed under either: a record "
                      "written to the wrong type's table is indistinguishable from one that was "
                      "never written.",
                      declared.c_str(), intrinsic.c_str());
        plugin_set_error("record-type-disagreement", message);
        return 400;
    }
    const std::string type = declared.empty() ? intrinsic : declared;
    if (type.empty()) {
        plugin_set_error("missing-record-type",
                         "write needs an SDS type: a record frame typed with its standard, or a record that carries "
                         "its own file identifier.");
        return 400;
    }

    const std::string schema = type + ".fbs";
    A::StorageWriteParams params{};
    sdm_piv::put(params.SCHEMA, schema);  // "XXX.fbs" always fits the 64-byte field
    params.set_has_SCHEMA(true);
    const auto response = sdm_piv::call("storage.write", "StorageWriteParams", params,
                                        {sdm_piv::raw("data", record->payload, record->payload_length)});
    if (!response.ok()) {
        std::string message = response.error_message();
        if (message.empty()) message = "storage.write hostcall failed.";
        message = response.error_code() + ": " + message;
        plugin_set_error("write-failed", message.c_str());
        return 502;
    }
    const auto* written = response.result<A::StorageWriteResult>("StorageWriteResult");
    if (!written || written->CID.length == 0) {
        plugin_set_error("write-failed", "storage.write answered without a CID.");
        return 502;
    }

    const std::vector<uint8_t> notice = publish_notice(written->CID.str(), schema);
    const int32_t pushed = plugin_push_output_ex("result", "PNM.fbs", "$PNM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                                 "PNM", 0, 0, notice.data(), static_cast<uint32_t>(notice.size()));
    return pushed < 0 ? 500 : 0;
}

}  // extern "C"
