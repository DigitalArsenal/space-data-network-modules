/*
 * SDN data retrieval module (loop C.2).
 *
 * Two methods over the host FlatSQL engine-native retrieval ops:
 *
 *   omm_bulk   — resolves a per-standard epoch query profile and calls
 *                storage.flatsql_epoch_stream. The ALIGNED size-prefixed
 *                $OMM FlatBuffer stream returned as hostcall binary
 *                segment 0 passes through VERBATIM to the "stream" port.
 *   data_query — extracts {sql, params} from an SDS CAQ request frame and
 *                calls storage.flatsql_query_stream; the aligned result
 *                stream passes through verbatim to the "rows" port.
 *
 * Profile resolution order for omm_bulk (per user directive, defaults are
 * config-driven, not hard-coded):
 *   request frame (CAQRequest.QUERY JSON / MAX_COUNT)
 *     > module config (plugin.getConfig -> {"profiles":{"OMM.fbs":{...}}})
 *       > compiled fallback (profile "nearest", epoch = clock.now, limit 50000)
 *
 * Hostcall ABI (space_data_module_host, sync guest subset):
 *   call(op_ptr, op_len, payload_ptr, payload_len) -> i32 status
 *   response_len() -> i32
 *   read_response(dst_ptr, dst_len) -> i32 (bytes copied)
 * Request payloads and responses use the hostcall wire envelope
 * ([u32le metaLen][meta JSON][u32le segCount]([u32le segLen][seg])...);
 * see space-data-module-sdk/src/host/hostcallWire.js and the Go bridge in
 * sdn-server/internal/modulert/hostbridge.go. The SDK does not ship C-side
 * hostcall helpers (the generated invoke glue covers method dispatch only),
 * so the small envelope helpers below follow the same pattern as the
 * spacex-starlink-source module.
 *
 * The SDS CAQ/ETM generated C++ headers are prepended by build.mjs; this
 * file only contains the method bodies plus hostcall helpers.
 */

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

extern "C" {

__attribute__((import_module("space_data_module_host"), import_name("call")))
int32_t sdm_host_call(const uint8_t* op_ptr, int32_t op_len,
                      const uint8_t* payload_ptr, int32_t payload_len);
__attribute__((import_module("space_data_module_host"), import_name("response_len")))
int32_t sdm_host_response_len(void);
__attribute__((import_module("space_data_module_host"), import_name("read_response")))
int32_t sdm_host_read_response(uint8_t* dst_ptr, int32_t dst_len);

}  // extern "C"

namespace {

constexpr const char* kDefaultSchema = "OMM.fbs";
constexpr const char* kDefaultProfile = "nearest";
constexpr long kDefaultLimit = 50000;

// ---------------------------------------------------------------------------
// Hostcall wire envelope helpers.
// ---------------------------------------------------------------------------

void write_u32le(uint8_t* dst, uint32_t value) {
    dst[0] = static_cast<uint8_t>(value & 0xff);
    dst[1] = static_cast<uint8_t>((value >> 8) & 0xff);
    dst[2] = static_cast<uint8_t>((value >> 16) & 0xff);
    dst[3] = static_cast<uint8_t>((value >> 24) & 0xff);
}

uint32_t read_u32le(const uint8_t* src) {
    return static_cast<uint32_t>(src[0]) | (static_cast<uint32_t>(src[1]) << 8) |
           (static_cast<uint32_t>(src[2]) << 16) | (static_cast<uint32_t>(src[3]) << 24);
}

// Invoke a host op with a JSON params document. The request payload is a
// hostcall envelope with the JSON as meta and zero binary segments; the
// returned bytes are the full response envelope.
std::vector<uint8_t> hostcall(const char* op, const std::string& payload_json) {
    std::vector<uint8_t> req(4 + payload_json.size() + 4, 0);
    write_u32le(req.data(), static_cast<uint32_t>(payload_json.size()));
    std::memcpy(req.data() + 4, payload_json.data(), payload_json.size());
    // Trailing 4 zero bytes = segment count 0.
    sdm_host_call(reinterpret_cast<const uint8_t*>(op),
                  static_cast<int32_t>(std::strlen(op)),
                  req.data(), static_cast<int32_t>(req.size()));
    const int32_t len = sdm_host_response_len();
    std::vector<uint8_t> buf(len > 0 ? static_cast<size_t>(len) : 0);
    if (len > 0) {
        sdm_host_read_response(buf.data(), len);
    }
    return buf;
}

// Extract the JSON meta document from a response envelope.
std::string envelope_meta_json(const std::vector<uint8_t>& env) {
    if (env.size() < 4) return std::string();
    const uint32_t meta_len = read_u32le(env.data());
    if (env.size() < 4u + meta_len) return std::string();
    return std::string(reinterpret_cast<const char*>(env.data() + 4), meta_len);
}

// Locate binary segment 0 of a response envelope without copying. Returns
// false when the envelope carries no segments.
bool envelope_first_segment(const std::vector<uint8_t>& env,
                            const uint8_t** seg_out, uint32_t* seg_len_out) {
    *seg_out = nullptr;
    *seg_len_out = 0;
    if (env.size() < 4) return false;
    const uint32_t meta_len = read_u32le(env.data());
    size_t off = 4u + meta_len;
    if (off + 4 > env.size()) return false;
    const uint32_t seg_count = read_u32le(env.data() + off);
    off += 4;
    if (seg_count == 0 || off + 4 > env.size()) return false;
    const uint32_t seg_len = read_u32le(env.data() + off);
    off += 4;
    if (off + seg_len > env.size()) return false;
    *seg_out = env.data() + off;
    *seg_len_out = seg_len;
    return true;
}

bool meta_ok(const std::string& meta) {
    return meta.find("\"ok\":true") != std::string::npos;
}

// ---------------------------------------------------------------------------
// Minimal JSON field extraction (control metadata only — binary payloads
// never round-trip through JSON).
// ---------------------------------------------------------------------------

bool is_json_ws(char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

// Extract "key":"..." string values. Handles simple escapes.
bool json_string_field(const std::string& json, const std::string& key, std::string* out) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
    while (i < json.size() && is_json_ws(json[i])) i++;
    if (i >= json.size() || json[i] != '"') return false;
    i++;
    std::string value;
    while (i < json.size() && json[i] != '"') {
        if (json[i] == '\\' && i + 1 < json.size()) {
            const char n = json[i + 1];
            if (n == 'n') value.push_back('\n');
            else if (n == 't') value.push_back('\t');
            else if (n == 'r') value.push_back('\r');
            else value.push_back(n);
            i += 2;
        } else {
            value.push_back(json[i]);
            i++;
        }
    }
    *out = value;
    return true;
}

// Extract "key":<number> values.
bool json_number_field(const std::string& json, const std::string& key, double* out) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
    while (i < json.size() && is_json_ws(json[i])) i++;
    if (i >= json.size()) return false;
    const char c = json[i];
    if (c != '-' && (c < '0' || c > '9')) return false;
    char* end = nullptr;
    const double value = strtod(json.c_str() + i, &end);
    if (end == json.c_str() + i) return false;
    *out = value;
    return true;
}

// Slice "key": <open>...<close> blocks (objects or arrays), string-aware.
std::string json_block_slice(const std::string& json, const std::string& key,
                             char open, char close) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return std::string();
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return std::string();
    size_t i = colon + 1;
    while (i < json.size() && is_json_ws(json[i])) i++;
    if (i >= json.size() || json[i] != open) return std::string();
    const size_t start = i;
    int depth = 0;
    bool in_string = false;
    for (; i < json.size(); i++) {
        const char c = json[i];
        if (in_string) {
            if (c == '\\') i++;
            else if (c == '"') in_string = false;
            continue;
        }
        if (c == '"') in_string = true;
        else if (c == open) depth++;
        else if (c == close) {
            depth--;
            if (depth == 0) return json.substr(start, i - start + 1);
        }
    }
    return std::string();
}

std::string json_object_slice(const std::string& json, const std::string& key) {
    return json_block_slice(json, key, '{', '}');
}

std::string json_array_slice(const std::string& json, const std::string& key) {
    return json_block_slice(json, key, '[', ']');
}

std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (const char c : s) {
        if (c == '"' || c == '\\') { out.push_back('\\'); out.push_back(c); }
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else out.push_back(c);
    }
    return out;
}

// ---------------------------------------------------------------------------
// omm_bulk profile resolution.
// ---------------------------------------------------------------------------

struct EpochQuery {
    std::string schema = kDefaultSchema;
    std::string source;
    std::string profile;
    double epoch = 0.0;
    bool has_epoch = false;
    long limit = -1;
};

// Apply {source,profile,epoch,limit} fields from a JSON object onto a query.
void apply_json_overrides(const std::string& json, EpochQuery* query) {
    if (json.empty()) return;
    std::string s;
    if (json_string_field(json, "source", &s)) query->source = s;
    if (json_string_field(json, "profile", &s) && !s.empty()) query->profile = s;
    double d = 0.0;
    if (json_number_field(json, "epoch", &d)) {
        query->epoch = d;
        query->has_epoch = true;
    }
    if (json_number_field(json, "limit", &d) && d > 0) query->limit = static_cast<long>(d);
}

// Read the module config through the built-in plugin.getConfig hostcall and
// apply the per-standard profile entry for query->schema, if any. Config
// shape: {"profiles":{"OMM.fbs":{"profile":"nearest","limit":50000,...}}}.
void apply_config_profile(EpochQuery* query) {
    const std::vector<uint8_t> env = hostcall("plugin.getConfig", "{}");
    const std::string meta = envelope_meta_json(env);
    if (!meta_ok(meta)) return;  // Config absent -> compiled fallbacks apply.
    const std::string result = json_object_slice(meta, "result");
    if (result.empty()) return;
    const std::string profiles = json_object_slice(result, "profiles");
    if (profiles.empty()) return;
    const std::string entry = json_object_slice(profiles, query->schema);
    apply_json_overrides(entry, query);
}

// Modules have no clock: default the epoch through the built-in clock.now
// hostcall (unix milliseconds). Returns false when the host clock fails.
bool default_epoch_to_now(EpochQuery* query) {
    const std::vector<uint8_t> env = hostcall("clock.now", "{}");
    const std::string meta = envelope_meta_json(env);
    double now_ms = 0.0;
    if (!meta_ok(meta) || !json_number_field(meta, "result", &now_ms)) {
        return false;
    }
    query->epoch = now_ms / 1000.0;
    query->has_epoch = true;
    return true;
}

std::string format_number(double value) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.6f", value);
    return std::string(buf);
}

// Fail the current invoke with the host error message from a response meta.
int fail_from_meta(const char* code, const std::string& meta, const char* fallback) {
    std::string message;
    json_string_field(meta, "message", &message);
    plugin_set_error(code, message.empty() ? fallback : message.c_str());
    return 502;
}

// Body-reference delivery (loop C.5c): when the request carries
// "deliver":"ref", the host MAY answer with result.ref =
// {"token":..,"size":..,"frames":..,"fnv1a64":"<16 hex>"} and NO stream
// segment — the stream bytes then never enter this module's memory; they are
// substituted by the host at the egress sink ($HTR BODY_REF_TOKEN/SIZE).
// This module passes the reference through as a small JSON descriptor frame
// {"$sdnbodyref":1,...ref fields...} on the same output port the stream
// bytes would have used. Hosts that ignore "deliver" keep returning segment
// bytes, and this module falls back to verbatim byte passthrough.
std::string body_ref_descriptor(const std::string& meta) {
    const std::string result = json_object_slice(meta, "result");
    if (result.empty()) return std::string();
    const std::string ref = json_object_slice(result, "ref");
    if (ref.empty() || ref[0] != '{') return std::string();
    return "{\"$sdnbodyref\":1," + ref.substr(1);
}

// Push either the body-reference descriptor (ref delivery) or binary segment
// 0 verbatim (byte delivery) on the given port. Returns the invoke status.
int push_stream_or_ref(const char* port, const char* schema, const char* file_id,
                       const char* root_type, const std::vector<uint8_t>& env,
                       const std::string& meta, bool deliver_ref) {
    if (deliver_ref) {
        const std::string descriptor = body_ref_descriptor(meta);
        if (!descriptor.empty()) {
            const int32_t pushed = plugin_push_output_ex(
                port, nullptr, nullptr,
                PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr,
                0, 1,
                reinterpret_cast<const uint8_t*>(descriptor.data()),
                static_cast<uint32_t>(descriptor.size()));
            return pushed < 0 ? 500 : 0;
        }
        // Host ignored "deliver":"ref" — fall through to segment bytes.
    }
    const uint8_t* seg = nullptr;
    uint32_t seg_len = 0;
    envelope_first_segment(env, &seg, &seg_len);  // Zero rows -> empty stream.
    const int32_t pushed = plugin_push_output_ex(
        port, schema, file_id,
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, root_type,
        0, 8, seg, seg_len);
    return pushed < 0 ? 500 : 0;
}

}  // namespace

extern "C" {

// omm_bulk: resolve {schema, source, profile, epoch, limit} (request frame >
// config > fallback defaults), call storage.flatsql_epoch_stream, and pass
// the aligned size-prefixed $OMM stream (binary segment 0) through verbatim.
int omm_bulk(void) {
    // Optional request frame: an SDS CAQ envelope. CAQRequest.QUERY carries a
    // JSON override object {schema,source,profile,epoch,limit}; MAX_COUNT > 0
    // overrides the row limit when the QUERY JSON does not set one.
    std::string frame_overrides;
    uint32_t frame_max_count = 0;
    if (plugin_get_input_count() > 0) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(0);
        if (frame && frame->payload && frame->payload_length >= 8) {
            ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
            if (!CAQBufferHasIdentifier(frame->payload) || !VerifyCAQBuffer(verifier)) {
                plugin_set_error("invalid-request-frame",
                                 "omm_bulk request frame is not a valid SDS CAQ buffer.");
                return 400;
            }
            const CAQ* envelope = GetCAQ(frame->payload);
            const CAQRequest* request = envelope ? envelope->REQUEST() : nullptr;
            if (request) {
                if (request->QUERY()) {
                    frame_overrides.assign(request->QUERY()->c_str(), request->QUERY()->size());
                }
                frame_max_count = request->MAX_COUNT();
            }
        }
    }

    EpochQuery query;
    // Schema override first: the config profile lookup is keyed by schema.
    {
        std::string s;
        if (!frame_overrides.empty() && json_string_field(frame_overrides, "schema", &s) &&
            !s.empty()) {
            query.schema = s;
        }
    }
    // Config-driven per-standard defaults (plugin.getConfig).
    apply_config_profile(&query);
    // Request frame fields win over config, per call.
    apply_json_overrides(frame_overrides, &query);
    {
        double d = 0.0;
        const bool frame_has_limit = !frame_overrides.empty() &&
                                     json_number_field(frame_overrides, "limit", &d) && d > 0;
        if (!frame_has_limit && frame_max_count > 0) {
            query.limit = static_cast<long>(frame_max_count);
        }
    }
    // Compiled fallback defaults apply only when neither frame nor config set
    // the field: OMM -> nearest, epoch = now, limit 50000.
    if (query.profile.empty()) query.profile = kDefaultProfile;
    if (query.limit <= 0) query.limit = kDefaultLimit;
    if (!query.has_epoch && !default_epoch_to_now(&query)) {
        plugin_set_error("clock-unavailable",
                         "clock.now hostcall failed while defaulting the query epoch.");
        return 500;
    }

    // Reference delivery is requested by the caller (the flow's gate injects
    // "deliver":"ref" on the flatbuffer branch); never invented here.
    std::string deliver;
    if (!frame_overrides.empty()) {
        json_string_field(frame_overrides, "deliver", &deliver);
    }
    const bool deliver_ref = deliver == "ref";

    char limit_buf[32];
    std::snprintf(limit_buf, sizeof(limit_buf), "%ld", query.limit);
    const std::string payload = std::string("{\"schema\":\"") + json_escape(query.schema) +
                                "\",\"source\":\"" + json_escape(query.source) +
                                "\",\"profile\":\"" + json_escape(query.profile) +
                                "\",\"epoch\":" + format_number(query.epoch) +
                                ",\"limit\":" + limit_buf +
                                (deliver_ref ? ",\"deliver\":\"ref\"" : "") + "}";

    const std::vector<uint8_t> env = hostcall("storage.flatsql_epoch_stream", payload);
    const std::string meta = envelope_meta_json(env);
    if (!meta_ok(meta)) {
        return fail_from_meta("flatsql-epoch-stream-failed", meta,
                              "storage.flatsql_epoch_stream hostcall failed.");
    }

    return push_stream_or_ref("stream", "OMM.fbs", "$OMM", "OMM", env, meta, deliver_ref);
}

// data_query: extract {sql, params} from the SDS CAQ request frame and pass
// the storage.flatsql_query_stream result stream through verbatim.
// CAQRequest.QUERY carries either a plain SQL string or a JSON object
// {"sql":"...","params":[{"t":"i64|f64|str|bool|null|bytes","v":...}]} —
// the SDS CAQ schema has no typed parameter vector, so typed params ride in
// the QUERY JSON and forward verbatim to the host op.
int data_query(void) {
    const plugin_input_frame_t* frame = plugin_get_input_frame(0);
    if (!frame || !frame->payload || frame->payload_length < 8) {
        plugin_set_error("missing-query-frame", "data_query requires an SDS CAQ input frame.");
        return 400;
    }
    ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!CAQBufferHasIdentifier(frame->payload) || !VerifyCAQBuffer(verifier)) {
        plugin_set_error("invalid-query-frame",
                         "data_query input frame is not a valid SDS CAQ buffer.");
        return 400;
    }
    const CAQ* envelope = GetCAQ(frame->payload);
    const CAQRequest* request = envelope ? envelope->REQUEST() : nullptr;
    std::string query_text;
    if (request && request->QUERY()) {
        query_text.assign(request->QUERY()->c_str(), request->QUERY()->size());
    }
    if (query_text.empty()) {
        plugin_set_error("missing-query", "data_query requires CAQRequest.QUERY to carry SQL.");
        return 400;
    }

    std::string sql = query_text;
    std::string params_json = "[]";
    std::string deliver;
    if (query_text[0] == '{') {
        std::string s;
        if (json_string_field(query_text, "sql", &s) && !s.empty()) {
            sql = s;
            const std::string params = json_array_slice(query_text, "params");
            if (!params.empty()) params_json = params;
        }
        json_string_field(query_text, "deliver", &deliver);
    }
    const bool deliver_ref = deliver == "ref";

    const std::string payload =
        std::string("{\"sql\":\"") + json_escape(sql) + "\",\"params\":" + params_json +
        (deliver_ref ? ",\"deliver\":\"ref\"" : "") + "}";
    const std::vector<uint8_t> env = hostcall("storage.flatsql_query_stream", payload);
    const std::string meta = envelope_meta_json(env);
    if (!meta_ok(meta)) {
        return fail_from_meta("flatsql-query-stream-failed", meta,
                              "storage.flatsql_query_stream hostcall failed.");
    }

    return push_stream_or_ref("rows", nullptr, nullptr, nullptr, env, meta, deliver_ref);
}

}  // extern "C"
