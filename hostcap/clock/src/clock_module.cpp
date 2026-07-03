/*
 * hostcap/clock (loop C.3c2).
 *
 * Capability node for the host clock hostcall group. One method:
 *
 *   now — no input; calls clock.now (unix milliseconds) and clock.nowIso
 *         (RFC3339 string) and emits a single "time" frame of UTF-8 JSON
 *         bytes {"unixMs":N,"iso":"..."}.
 *
 * Periodic emission is a flow TRIGGER concern (timer trigger kind), not
 * this node — the node samples the clock once per invoke.
 *
 * Hostcall ABI (space_data_module_host, sync guest subset) and the wire
 * envelope helpers below follow the data-source/retrieval pattern; see
 * space-data-module-sdk/src/host/hostcallWire.js and
 * sdn-server/internal/modulert/hostbridge.go.
 */

#include <cstdint>
#include <cstdio>
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

// ---------------------------------------------------------------------------
// Hostcall wire envelope helpers ([u32le metaLen][meta JSON][u32le segCount]
// ([u32le segLen][seg])...).
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

std::vector<uint8_t> hostcall(const char* op, const std::string& payload_json) {
    std::vector<uint8_t> req(4 + payload_json.size() + 4, 0);
    write_u32le(req.data(), static_cast<uint32_t>(payload_json.size()));
    std::memcpy(req.data() + 4, payload_json.data(), payload_json.size());
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

std::string envelope_meta_json(const std::vector<uint8_t>& env) {
    if (env.size() < 4) return std::string();
    const uint32_t meta_len = read_u32le(env.data());
    if (env.size() < 4u + meta_len) return std::string();
    return std::string(reinterpret_cast<const char*>(env.data() + 4), meta_len);
}

bool meta_ok(const std::string& meta) {
    return meta.find("\"ok\":true") != std::string::npos;
}

// ---------------------------------------------------------------------------
// Minimal JSON field extraction (control metadata only).
// ---------------------------------------------------------------------------

bool is_json_ws(char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

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

int fail_from_meta(const char* code, const std::string& meta, const char* fallback) {
    std::string message;
    json_string_field(meta, "message", &message);
    plugin_set_error(code, message.empty() ? fallback : message.c_str());
    return 502;
}

int push_json(const char* port, const std::string& json) {
    return plugin_push_output_ex(
        port, nullptr, nullptr,
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr,
        0, 1,
        reinterpret_cast<const uint8_t*>(json.data()),
        static_cast<uint32_t>(json.size()));
}

}  // namespace

extern "C" {

// now: sample clock.now (unix ms) + clock.nowIso (RFC3339) and emit one
// "time" JSON frame {"unixMs":N,"iso":"..."}.
int now(void) {
    const std::vector<uint8_t> now_env = hostcall("clock.now", "{}");
    const std::string now_meta = envelope_meta_json(now_env);
    double unix_ms = 0.0;
    if (!meta_ok(now_meta) || !json_number_field(now_meta, "result", &unix_ms)) {
        return fail_from_meta("clock-unavailable", now_meta, "clock.now hostcall failed.");
    }

    const std::vector<uint8_t> iso_env = hostcall("clock.nowIso", "{}");
    const std::string iso_meta = envelope_meta_json(iso_env);
    std::string iso;
    if (!meta_ok(iso_meta) || !json_string_field(iso_meta, "result", &iso)) {
        return fail_from_meta("clock-unavailable", iso_meta, "clock.nowIso hostcall failed.");
    }

    char ms_buf[32];
    std::snprintf(ms_buf, sizeof(ms_buf), "%lld", static_cast<long long>(unix_ms));
    const std::string time_json =
        std::string("{\"unixMs\":") + ms_buf + ",\"iso\":\"" + json_escape(iso) + "\"}";
    const int32_t pushed = push_json("time", time_json);
    return pushed < 0 ? 500 : 0;
}

}  // extern "C"
