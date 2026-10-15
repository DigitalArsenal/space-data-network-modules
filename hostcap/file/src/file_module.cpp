/*
 * hostcap/file — the host filesystem connector (typed contracts 1.0).
 *
 *   read_file  — "request" $FIL (SDS standard FIL) naming PATH
 *                -> filesystem.readFile (SDS $PIV: raw "path" in, the bytes on raw "data")
 *                   and filesystem.stat (raw "path" in, "result" FsStat) for MODIFIED_AT_MS when the host has it
 *                -> one "file" frame, a $FIL: PATH, NAME, KIND File, SIZE, CONTENT verbatim, MODIFIED_AT_MS.
 *   write_file — "file" $FIL with PATH, CONTENT and APPEND
 *                -> filesystem.writeFile, or filesystem.appendFile when APPEND (raw "path" + raw "data")
 *                   and clock.now for the write time
 *                -> one "result" frame, a $FIL: PATH, NAME, KIND File, SIZE = the bytes written, APPEND,
 *                   WRITTEN_AT_MS; no CONTENT.
 *
 * The methodIds are read_file/write_file (not read/write): the SDK invoke glue binds each methodId to an identically
 * named extern "C" symbol, and `read`/`write` collide with the POSIX declarations in the wasi/emscripten sysroot.
 *
 * Host support: the SDK NodeHost serves filesystem.* against a sandboxed root; the SDK BrowserHost only with a
 * filesystem adapter. The Go server host has no filesystem handler today, so server-side invokes fail closed with the
 * host's error. filesystem.stat is best effort (MODIFIED_AT_MS 0 = unknown when it fails); clock.now likewise
 * (WRITTEN_AT_MS 0 when the host clock is not granted) - the write itself has already succeeded. No JSON anywhere.
 */

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <string_view>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "FIL_generated.h"  // spacedatastandards.org lib/cpp/FIL/main_generated.h, inlined by build.mjs

namespace {

namespace A = sdn::runtime::Aligned;

int fail(const char* code, const sdm_piv::Response& response, const char* fallback) {
    const std::string message = response.error_message();
    plugin_set_error(code, message.empty() ? fallback : message.c_str());
    return 502;
}

// The one $FIL frame on `port`, verified, with a non-empty PATH; sets the plugin error and returns nullptr otherwise.
const FIL* input_file(const char* method, const char* port) {
    const int32_t index = plugin_find_input_index(port, 0);
    const plugin_input_frame_t* frame = index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
    if (!frame || !frame->payload) {
        plugin_set_error("missing-path", (std::string(method) + " requires a $FIL frame naming PATH on \"" + port + "\".").c_str());
        return nullptr;
    }
    flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!VerifyFILBuffer(verifier)) {
        plugin_set_error("invalid-request", (std::string(method) + ": the \"" + port + "\" frame is not a $FIL (File).").c_str());
        return nullptr;
    }
    const FIL* file = GetFIL(frame->payload);
    if (!file->PATH() || file->PATH()->size() == 0) {
        plugin_set_error("missing-path", (std::string(method) + " requires a $FIL frame naming PATH on \"" + port + "\".").c_str());
        return nullptr;
    }
    return file;
}

std::string base_name(const std::string& path) {
    const size_t slash = path.find_last_of('/');
    return slash == std::string::npos ? path : path.substr(slash + 1);
}

int push_file(const char* port, flatbuffers::FlatBufferBuilder& b) {
    return plugin_push_output_ex(port, "FIL.fbs", FILIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "FIL", 0, 0,
                                 b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize()));
}

// ---------------------------------------------------------------------------
// SURPLUS-FRAME REFUSAL — graph task `modules-guest-nodes-drop-batched-frames`.
//
// `space_data_module_runtime_begin_node_invocation` (module-SDK
// src/flow/runtime-src/flow_runtime.cpp) fills an invocation by popping the
// node's queue `while (count < budget && !queue.empty())`: PORT-BLIND, with a
// drain budget of 64. `maxStreams`, `maxBatch` and `drainPolicy` are purely
// DECLARATIVE in the compiled runtime — enforced at compose time and in the
// JS-only reference runtime, never by the baked runtime.wasm. So a guest that
// reads ordinal 0 of a port and returns DESTROYS every other frame it was
// handed on that port: they are already dequeued, nothing re-delivers them,
// and nothing logs the loss.
//
// That is measured, not hypothetical. It was a live P1
// (`cellular-multiprovider-returns-only-first-provider`) that survived four
// passes precisely because a partial answer is indistinguishable from an
// honest one: a two-provider request performed exactly ONE outbound fetch and
// returned the first provider's records, byte-identical to that provider run
// alone, with no error anywhere.
//
// `read_file` performs ONE read per request frame and `write_file` ONE write per
// file frame. Silently reading the first path of two, or writing the first of two
// files, are both unrecoverable and both invisible at the output.
//
// So a surplus is REFUSED rather than silently dropped — a named node error
// the flow surfaces, instead of an answer assembled from whichever frame the
// queue happened to hold first (queue order is not semantic order, so such an
// answer is arbitrary AND indistinguishable from a correct one). This costs
// nothing while the contract holds: one frame per port is what every deployed
// flow delivers today.
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

}  // namespace

extern "C" {

// read_file: "request" $FIL {PATH} -> filesystem.readFile (+ filesystem.stat) -> "file" $FIL with CONTENT.
int read_file(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const FIL* request = input_file("read_file", "request");
    if (!request) return 400;
    const std::string path = request->PATH()->str();

    const auto read = sdm_piv::call("filesystem.readFile", {sdm_piv::raw("path", path)});
    if (!read.ok()) return fail("file-read-failed", read, "filesystem.readFile hostcall failed.");
    const std::string_view data = read.raw("data");

    int64_t modified_ms = 0;
    const auto stat = sdm_piv::call("filesystem.stat", {sdm_piv::raw("path", path)});
    if (const auto* st = stat.ok() ? stat.result<A::FsStat>("FsStat") : nullptr) modified_ms = static_cast<int64_t>(st->MTIME_MS);

    flatbuffers::FlatBufferBuilder b(data.size() + 256);
    const auto content = b.CreateVector(reinterpret_cast<const uint8_t*>(data.data()), data.size());
    const auto path_offset = b.CreateString(path);
    const auto name_offset = b.CreateString(base_name(path));
    FILBuilder fil(b);
    fil.add_PATH(path_offset);
    fil.add_NAME(name_offset);
    fil.add_KIND(filEntryKind_File);
    fil.add_SIZE(data.size());
    fil.add_MODIFIED_AT_MS(modified_ms);
    fil.add_CONTENT(content);
    FinishFILBuffer(b, fil.Finish());
    return push_file("file", b) < 0 ? 500 : 0;
}

// write_file: "file" $FIL {PATH, CONTENT, APPEND} -> filesystem.writeFile / appendFile -> "result" $FIL (no CONTENT).
int write_file(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const FIL* file = input_file("write_file", "file");
    if (!file) return 400;
    const std::string path = file->PATH()->str();
    const auto* content = file->CONTENT();
    const uint8_t* data = content ? content->data() : reinterpret_cast<const uint8_t*>("");
    const size_t size = content ? content->size() : 0;
    const bool append = file->APPEND();

    const char* op = append ? "filesystem.appendFile" : "filesystem.writeFile";
    const auto written = sdm_piv::call(op, {sdm_piv::raw("path", path), sdm_piv::raw("data", data, size)});
    if (!written.ok()) return fail("file-write-failed", written, append ? "filesystem.appendFile hostcall failed." : "filesystem.writeFile hostcall failed.");

    const auto now = sdm_piv::call("clock.now");
    const auto* now_value = now.ok() ? now.result<A::TimeValue>("TimeValue") : nullptr;

    flatbuffers::FlatBufferBuilder b(256);
    FinishFILBuffer(b, CreateFILDirect(b, path.c_str(), base_name(path).c_str(), filEntryKind_File, nullptr, size, 0, 0,
                                       filDigestAlgorithm_None, nullptr, nullptr, append,
                                       now_value ? static_cast<int64_t>(now_value->UNIX_MS) : 0));
    return push_file("result", b) < 0 ? 500 : 0;
}

}  // extern "C"
