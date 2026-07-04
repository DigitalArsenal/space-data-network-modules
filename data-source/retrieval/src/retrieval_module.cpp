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

#ifdef SDN_FLATSQL_LINKED
#include <sys/time.h>
#endif

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

#ifdef SDN_FLATSQL_LINKED
// ---------------------------------------------------------------------------
// Direct engine linkage (loop C.7). This variant is compiled into the
// guest-link-linked object the flow compiler uses for engineLinkage:
// "flatsql" flows: query SUBMISSION becomes a direct in-wasm call into the
// live store engine through the flow runtime template's linked helpers
// (SDK src/flow/runtime-src/flow_runtime.cpp) — the storage.flatsql_*
// hostcall bridge is fully retired for both delivery shapes:
//   deliver:"ref"  -> the aligned stream STAYS in engine memory; only an
//                     engine body-ref token descriptor enters this module
//   byte delivery  -> the stream is copied engine->flow memory in-wasm
//                     (json branch, field extraction downstream)
// The struct layout and symbols are the flow runtime's linked ABI.
// ---------------------------------------------------------------------------

struct SdnFlatsqlLinkedResult {
    uint64_t generation;
    uint64_t fnv1a64;
    uint64_t token;
    uint32_t engine_ptr;
    uint32_t size;
    int32_t rows;
    int32_t cols;
    int32_t cache_hit;
    int32_t frames;
};

extern "C" int32_t sdn_flatsql_linked_query_raw_stream(
    const char* sql, uint32_t sql_len, const uint8_t* params_tlv, uint32_t tlv_len,
    uint32_t param_count, int32_t want_ref, SdnFlatsqlLinkedResult* out);
extern "C" int32_t sdn_flatsql_linked_read(uint8_t* dst, uint32_t engine_ptr, uint32_t len);
extern "C" const char* sdn_flatsql_linked_error(void);
extern "C" uint32_t sdn_flatsql_linked_available(void);
#endif  // SDN_FLATSQL_LINKED

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
#ifdef SDN_FLATSQL_LINKED
    // Module config is static per instance: fetch it ONCE and reuse — with
    // query submission linked, this removes the remaining per-request
    // hostcall from the hot path (loop C.7).
    static bool config_cached = false;
    static std::string cached_meta;
    if (!config_cached) {
        cached_meta = envelope_meta_json(hostcall("plugin.getConfig", "{}"));
        config_cached = true;
    }
    const std::string& meta = cached_meta;
#else
    const std::vector<uint8_t> env = hostcall("plugin.getConfig", "{}");
    const std::string meta = envelope_meta_json(env);
#endif
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

#ifdef SDN_FLATSQL_LINKED
// ---------------------------------------------------------------------------
// Linked-mode query execution (loop C.7).
// ---------------------------------------------------------------------------

// Engine-native epoch profile SQL over the unified OMM view. MUST stay
// byte-identical to sdn-server internal/storage/engine_records.go — same
// engine query-cache identity, same results. Positional params: ?1 source
// shadow name ('' = all), ?2 epoch unix seconds, ?3 limit (-1 = unlimited).
constexpr const char* kEpochNearestSQL =
    "SELECT _data FROM (SELECT _data, ROW_NUMBER() OVER (PARTITION BY NORAD_CAT_ID ORDER BY "
    "ABS(USER_DEFINED_EPOCH_TIMESTAMP - ?2)) rn FROM OMM WHERE (?1 = '' OR _source = ?1)) WHERE "
    "rn = 1 LIMIT ?3";
constexpr const char* kEpochAsOfSQL =
    "SELECT _data FROM (SELECT _data, ROW_NUMBER() OVER (PARTITION BY NORAD_CAT_ID ORDER BY "
    "USER_DEFINED_EPOCH_TIMESTAMP DESC) rn FROM OMM WHERE (?1 = '' OR _source = ?1) AND "
    "USER_DEFINED_EPOCH_TIMESTAMP <= ?2) WHERE rn = 1 LIMIT ?3";
constexpr const char* kEpochForwardSQL =
    "SELECT _data FROM (SELECT _data, ROW_NUMBER() OVER (PARTITION BY NORAD_CAT_ID ORDER BY "
    "USER_DEFINED_EPOCH_TIMESTAMP ASC) rn FROM OMM WHERE (?1 = '' OR _source = ?1) AND "
    "USER_DEFINED_EPOCH_TIMESTAMP >= ?2) WHERE rn = 1 LIMIT ?3";

const char* epoch_profile_sql(const std::string& profile) {
    std::string p = profile;
    if (p.rfind("epoch.", 0) == 0) p = p.substr(6);
    if (p == "nearest") return kEpochNearestSQL;
    if (p == "as_of") return kEpochAsOfSQL;
    if (p == "forward") return kEpochForwardSQL;
    return nullptr;
}

// Engine TLV parameter encoding: per param [u8 tag][u32le len][payload]
// (tags 0=null 1=bool 2=int64 3=float64 4=string 5=bytes — the same blob
// flatsqlrt EncodeParams / standalone.js encodeQueryParams produce).
void tlv_append(std::vector<uint8_t>* out, uint8_t tag, const uint8_t* payload, uint32_t len) {
    out->push_back(tag);
    uint8_t hdr[4];
    write_u32le(hdr, len);
    out->insert(out->end(), hdr, hdr + 4);
    if (payload != nullptr && len > 0) out->insert(out->end(), payload, payload + len);
}

void tlv_append_string(std::vector<uint8_t>* out, const std::string& s) {
    tlv_append(out, 4, reinterpret_cast<const uint8_t*>(s.data()),
               static_cast<uint32_t>(s.size()));
}

void tlv_append_i64(std::vector<uint8_t>* out, int64_t v) {
    uint8_t payload[8];
    std::memcpy(payload, &v, 8);
    tlv_append(out, 2, payload, 8);
}

void tlv_append_f64(std::vector<uint8_t>* out, double v) {
    uint8_t payload[8];
    std::memcpy(payload, &v, 8);
    tlv_append(out, 3, payload, 8);
}

bool base64_decode(const std::string& in, std::vector<uint8_t>* out) {
    static const char* alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    int8_t lookup[256];
    std::memset(lookup, -1, sizeof(lookup));
    for (int i = 0; i < 64; i++) lookup[static_cast<uint8_t>(alphabet[i])] = static_cast<int8_t>(i);
    uint32_t buf = 0;
    int bits = 0;
    for (char c : in) {
        if (c == '=') break;
        const int8_t v = lookup[static_cast<uint8_t>(c)];
        if (v < 0) continue;
        buf = (buf << 6) | static_cast<uint32_t>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out->push_back(static_cast<uint8_t>((buf >> bits) & 0xff));
        }
    }
    return true;
}

// Encode a {t,v} typed-params JSON array ('[{"t":"i64","v":25544}, ...]')
// into the engine TLV blob. Returns the param count, or -1 on a malformed
// entry (error text in *err).
int tlv_from_params_json(const std::string& params_json, std::vector<uint8_t>* out,
                         std::string* err) {
    int count = 0;
    size_t i = 0;
    while (i < params_json.size()) {
        const size_t start = params_json.find('{', i);
        if (start == std::string::npos) break;
        // Slice the object (string-aware brace matching).
        int depth = 0;
        bool in_string = false;
        size_t end = start;
        for (; end < params_json.size(); end++) {
            const char c = params_json[end];
            if (in_string) {
                if (c == '\\') end++;
                else if (c == '"') in_string = false;
                continue;
            }
            if (c == '"') in_string = true;
            else if (c == '{') depth++;
            else if (c == '}') {
                depth--;
                if (depth == 0) break;
            }
        }
        if (end >= params_json.size()) break;
        const std::string entry = params_json.substr(start, end - start + 1);
        i = end + 1;

        std::string tag;
        json_string_field(entry, "t", &tag);
        if (tag == "null") {
            tlv_append(out, 0, nullptr, 0);
        } else if (tag == "bool") {
            const uint8_t v = entry.find("\"v\":true") != std::string::npos ? 1 : 0;
            tlv_append(out, 1, &v, 1);
        } else if (tag == "i64") {
            double d = 0.0;
            if (!json_number_field(entry, "v", &d)) { *err = "i64 param value missing"; return -1; }
            tlv_append_i64(out, static_cast<int64_t>(d));
        } else if (tag == "f64") {
            double d = 0.0;
            if (!json_number_field(entry, "v", &d)) { *err = "f64 param value missing"; return -1; }
            tlv_append_f64(out, d);
        } else if (tag == "str") {
            std::string s;
            if (!json_string_field(entry, "v", &s)) { *err = "str param value missing"; return -1; }
            tlv_append_string(out, s);
        } else if (tag == "bytes") {
            std::string s;
            if (!json_string_field(entry, "v", &s)) { *err = "bytes param value missing"; return -1; }
            std::vector<uint8_t> decoded;
            base64_decode(s, &decoded);
            tlv_append(out, 5, decoded.data(), static_cast<uint32_t>(decoded.size()));
        } else {
            *err = "unknown param tag \"" + tag + "\"";
            return -1;
        }
        count++;
    }
    return count;
}

// Execute a linked engine query and push the result: engine body-ref
// descriptor (deliver_ref — bytes never enter this module) or verbatim bytes
// copied engine->flow in-wasm. Mirrors push_stream_or_ref's port shapes.
int linked_query_and_push(const char* port, const char* schema, const char* file_id,
                          const char* root_type, const std::string& sql,
                          const std::vector<uint8_t>& tlv, uint32_t param_count,
                          bool deliver_ref, const char* fail_code) {
    SdnFlatsqlLinkedResult result;
    const int32_t status = sdn_flatsql_linked_query_raw_stream(
        sql.data(), static_cast<uint32_t>(sql.size()), tlv.data(),
        static_cast<uint32_t>(tlv.size()), param_count, deliver_ref ? 1 : 0, &result);
    if (status != 0) {
        plugin_set_error(fail_code, sdn_flatsql_linked_error());
        return 502;
    }

    if (deliver_ref) {
        char descriptor[192];
        std::snprintf(descriptor, sizeof(descriptor),
                      "{\"$sdnbodyref\":1,\"token\":%llu,\"size\":%u,\"frames\":%d,"
                      "\"fnv1a64\":\"%016llx\"}",
                      static_cast<unsigned long long>(result.token), result.size, result.frames,
                      static_cast<unsigned long long>(result.fnv1a64));
        const int32_t pushed = plugin_push_output_ex(
            port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
            reinterpret_cast<const uint8_t*>(descriptor),
            static_cast<uint32_t>(std::strlen(descriptor)));
        return pushed < 0 ? 500 : 0;
    }

    std::vector<uint8_t> bytes(result.size);
    if (result.size > 0) {
        sdn_flatsql_linked_read(bytes.data(), result.engine_ptr, result.size);
    }
    const int32_t pushed = plugin_push_output_ex(
        port, schema, file_id, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, root_type, 0, 8,
        bytes.data(), static_cast<uint32_t>(bytes.size()));
    return pushed < 0 ? 500 : 0;
}

// Linked mode defaults the epoch through the WASI realtime clock (both hosts
// provide clock_time_get) instead of the clock.now hostcall: the last
// per-request hostcall on the hot path goes away.
bool default_epoch_wasi_clock(EpochQuery* query) {
    struct timeval tv;
    if (gettimeofday(&tv, nullptr) != 0) return false;
    query->epoch = static_cast<double>(tv.tv_sec) + static_cast<double>(tv.tv_usec) / 1e6;
    query->has_epoch = true;
    return true;
}
#endif  // SDN_FLATSQL_LINKED

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
#ifdef SDN_FLATSQL_LINKED
    if (!query.has_epoch && !default_epoch_wasi_clock(&query)) {
        plugin_set_error("clock-unavailable",
                         "WASI clock_time_get failed while defaulting the query epoch.");
        return 500;
    }
#else
    if (!query.has_epoch && !default_epoch_to_now(&query)) {
        plugin_set_error("clock-unavailable",
                         "clock.now hostcall failed while defaulting the query epoch.");
        return 500;
    }
#endif

    // Reference delivery is requested by the caller (the flow's gate injects
    // "deliver":"ref" on the flatbuffer branch); never invented here.
    std::string deliver;
    if (!frame_overrides.empty()) {
        json_string_field(frame_overrides, "deliver", &deliver);
    }
    const bool deliver_ref = deliver == "ref";

#ifdef SDN_FLATSQL_LINKED
    // Direct in-wasm query submission (loop C.7): the profile resolves to the
    // engine-native SQL here — identical text to the server's
    // QueryEpochRawStream — and executes against the LIVE store engine via
    // the linked imports. No storage.flatsql_* hostcall exists on this path.
    const char* sql = epoch_profile_sql(query.profile);
    if (sql == nullptr) {
        const std::string message = "unsupported engine epoch profile \"" + query.profile +
                                    "\" (want nearest, as_of, or forward)";
        plugin_set_error("unsupported-profile", message.c_str());
        return 400;
    }
    const std::string source_shadow =
        query.source.empty() ? std::string() : ("OMM@" + query.source);
    std::vector<uint8_t> tlv;
    tlv_append_string(&tlv, source_shadow);
    tlv_append_f64(&tlv, query.epoch);
    tlv_append_i64(&tlv, query.limit <= 0 ? -1 : static_cast<int64_t>(query.limit));
    return linked_query_and_push("stream", "OMM.fbs", "$OMM", "OMM", sql, tlv, 3, deliver_ref,
                                 "flatsql-linked-epoch-failed");
#else
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
#endif
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

#ifdef SDN_FLATSQL_LINKED
    std::vector<uint8_t> tlv;
    int param_count = 0;
    if (params_json != "[]") {
        std::string tlv_err;
        param_count = tlv_from_params_json(params_json, &tlv, &tlv_err);
        if (param_count < 0) {
            plugin_set_error("invalid-params", tlv_err.c_str());
            return 400;
        }
    }
    return linked_query_and_push("rows", nullptr, nullptr, nullptr, sql, tlv,
                                 static_cast<uint32_t>(param_count), deliver_ref,
                                 "flatsql-linked-query-failed");
#else
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
#endif
}

}  // extern "C"
