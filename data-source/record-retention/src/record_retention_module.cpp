/*
 * SDN record retention module.
 *
 * One method, `expire`: keeps a rolling window of records on the node and
 * deletes what has fallen out of it. Each configured target names a standard
 * and its lane (provider and/or sources); the node's storage.expire host op
 * deletes the lane's records whose own indexed time (WXF VALID_TIME_MS, OMM/MPE
 * EPOCH, ...) is older than now - window_hours, paging the store's record
 * index - every stored record, not only the engine's resident hot window that
 * module SQL sees.
 *
 * Owner 2026-10-12, the weather node: "we only need to keep a rolling window
 * of 3 days, we should NOT be archiving more than that (configurable in the
 * module but the default is 3 days)".
 *
 * Config (plugin.getConfig), every field optional:
 *   {"window_hours":72,"batch":500,"max_deletes":100000,
 *    "targets":[{"schema":"WXF.fbs","provider_id":"noaa-ncep","sources":["gfs-0p25-sea"]}]}
 * The compiled default target: WXF from provider noaa-ncep, 72 hours. A target
 * names a provider, sources, or both (the host refuses a whole standard).
 *
 * Hostcall ABI and envelope helpers follow data-source/retrieval (the SDK
 * ships no C-side hostcall helpers).
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

constexpr double kDefaultWindowHours = 72.0;
constexpr long kDefaultBatch = 500;
constexpr long kDefaultMaxDeletes = 100000;

// ---------------------------------------------------------------------------
// Hostcall wire envelope ([u32le metaLen][meta JSON][u32le segCount]...).
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
    sdm_host_call(reinterpret_cast<const uint8_t*>(op), static_cast<int32_t>(std::strlen(op)),
                  req.data(), static_cast<int32_t>(req.size()));
    const int32_t len = sdm_host_response_len();
    std::vector<uint8_t> buf(len > 0 ? static_cast<size_t>(len) : 0);
    if (len > 0) sdm_host_read_response(buf.data(), len);
    return buf;
}

std::string envelope_meta_json(const std::vector<uint8_t>& env) {
    if (env.size() < 4) return std::string();
    const uint32_t meta_len = read_u32le(env.data());
    if (env.size() < 4u + meta_len) return std::string();
    return std::string(reinterpret_cast<const char*>(env.data() + 4), meta_len);
}

bool meta_ok(const std::string& meta) { return meta.find("\"ok\":true") != std::string::npos; }

// ---------------------------------------------------------------------------
// Minimal JSON reading (control metadata only).
// ---------------------------------------------------------------------------

bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

size_t value_start(const std::string& json, const std::string& key) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return std::string::npos;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return std::string::npos;
    size_t i = colon + 1;
    while (i < json.size() && is_ws(json[i])) i++;
    return i < json.size() ? i : std::string::npos;
}

bool json_string(const std::string& json, const std::string& key, std::string* out) {
    size_t i = value_start(json, key);
    if (i == std::string::npos || json[i] != '"') return false;
    std::string v;
    for (i++; i < json.size() && json[i] != '"'; i++) {
        if (json[i] == '\\' && i + 1 < json.size()) i++;
        v.push_back(json[i]);
    }
    *out = v;
    return true;
}

bool json_number(const std::string& json, const std::string& key, double* out) {
    const size_t i = value_start(json, key);
    if (i == std::string::npos) return false;
    char* end = nullptr;
    const double v = std::strtod(json.c_str() + i, &end);
    if (end == json.c_str() + i) return false;
    *out = v;
    return true;
}

std::string json_block(const std::string& json, const std::string& key, char open, char close) {
    size_t i = value_start(json, key);
    if (i == std::string::npos || json[i] != open) return std::string();
    const size_t start = i;
    int depth = 0;
    bool in_string = false;
    for (; i < json.size(); i++) {
        const char c = json[i];
        if (in_string) { if (c == '\\') i++; else if (c == '"') in_string = false; continue; }
        if (c == '"') in_string = true;
        else if (c == open) depth++;
        else if (c == close && --depth == 0) return json.substr(start, i - start + 1);
    }
    return std::string();
}

// Split a JSON array of objects or strings into its elements (string-aware).
std::vector<std::string> json_array_items(const std::string& array) {
    std::vector<std::string> items;
    if (array.size() < 2) return items;
    size_t i = 1, start = std::string::npos;
    int depth = 0;
    bool in_string = false;
    for (; i + 1 < array.size(); i++) {
        const char c = array[i];
        if (start == std::string::npos && !is_ws(c) && c != ',') start = i;
        if (in_string) { if (c == '\\') i++; else if (c == '"') in_string = false; continue; }
        if (c == '"') in_string = true;
        else if (c == '{' || c == '[') depth++;
        else if (c == '}' || c == ']') depth--;
        else if (c == ',' && depth == 0 && start != std::string::npos) {
            items.push_back(array.substr(start, i - start));
            start = std::string::npos;
        }
    }
    if (start != std::string::npos) {
        size_t end = array.size() - 1;
        while (end > start && is_ws(array[end - 1])) end--;
        items.push_back(array.substr(start, end - start));
    }
    return items;
}

std::string json_escape(const std::string& s) {
    std::string out;
    for (const char c : s) {
        if (c == '"' || c == '\\') { out.push_back('\\'); out.push_back(c); }
        else if (c == '\n') out += "\\n";
        else out.push_back(c);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Expiry.
// ---------------------------------------------------------------------------

struct Target {
    std::string schema = "WXF.fbs";
    std::string provider = "noaa-ncep";
    std::vector<std::string> sources;  // empty: every source of the provider
};

struct Totals {
    long deleted = 0;
    long missing = 0;  // listed by the index, no longer stored
    bool capped = false;
};

// One lane's pass through storage.expire. Returns false on a host refusal or
// failure (error already set).
bool expire_lane(const Target& t, const std::string& source, double cutoff_ms, long batch, long max_deletes,
                 Totals* totals) {
    char nums[160];
    std::snprintf(nums, sizeof(nums), ",\"before_ms\":%.0f,\"batch\":%ld,\"max_deletes\":%ld}", cutoff_ms, batch,
                  max_deletes - totals->deleted);
    std::string payload = "{\"schema\":\"" + json_escape(t.schema) + "\"";
    if (!t.provider.empty()) payload += ",\"provider_id\":\"" + json_escape(t.provider) + "\"";
    if (!source.empty()) payload += ",\"source_name\":\"" + json_escape(source) + "\"";
    payload += nums;
    const std::string meta = envelope_meta_json(hostcall("storage.expire", payload));
    if (!meta_ok(meta)) {
        std::string message;
        json_string(meta, "message", &message);
        plugin_set_error("retention-expire-failed", message.empty() ? "storage.expire failed" : message.c_str());
        return false;
    }
    const std::string result = json_block(meta, "result", '{', '}');
    double d = 0.0;
    if (json_number(result, "deleted", &d)) totals->deleted += static_cast<long>(d);
    if (json_number(result, "missing", &d)) totals->missing += static_cast<long>(d);
    if (result.find("\"capped\":true") != std::string::npos) totals->capped = true;
    return true;
}

}  // namespace

extern "C" {

// expire: delete every configured target's records older than the window.
// Status 0 with nothing to do as well; 502 when the host refuses or fails.
int expire(void) {
    double window_hours = kDefaultWindowHours, d = 0.0;
    long batch = kDefaultBatch, max_deletes = kDefaultMaxDeletes;
    std::vector<Target> targets;

    const std::string meta = envelope_meta_json(hostcall("plugin.getConfig", "{}"));
    const std::string config = meta_ok(meta) ? json_block(meta, "result", '{', '}') : std::string();
    if (!config.empty()) {
        if (json_number(config, "window_hours", &d) && d > 0) window_hours = d;
        if (json_number(config, "batch", &d) && d >= 1) batch = static_cast<long>(d);
        if (json_number(config, "max_deletes", &d) && d >= 1) max_deletes = static_cast<long>(d);
        for (const std::string& item : json_array_items(json_block(config, "targets", '[', ']'))) {
            Target t;
            std::string s;
            if (json_string(item, "schema", &s)) t.schema = s;
            t.provider.clear();
            if (json_string(item, "provider_id", &s)) t.provider = s;
            for (const std::string& src : json_array_items(json_block(item, "sources", '[', ']'))) {
                if (src.size() >= 2 && src.front() == '"') t.sources.push_back(src.substr(1, src.size() - 2));
            }
            targets.push_back(t);
        }
    }
    if (targets.empty()) targets.push_back(Target());

    const std::string now_meta = envelope_meta_json(hostcall("clock.now", "{}"));
    double now_ms = 0.0;
    if (!meta_ok(now_meta) || !json_number(now_meta, "result", &now_ms) || now_ms <= 0) {
        plugin_set_error("retention-clock-failed", "clock.now hostcall failed.");
        return 502;
    }
    const double cutoff_ms = now_ms - window_hours * 3600e3;

    Totals totals;
    for (const Target& t : targets) {
        if (t.provider.empty() && t.sources.empty()) {
            plugin_set_error("retention-bad-target", "a target names provider_id, sources, or both.");
            return 400;
        }
        const std::vector<std::string> lanes = t.sources.empty() ? std::vector<std::string>{std::string()} : t.sources;
        for (const std::string& source : lanes) {
            if (totals.deleted >= max_deletes) { totals.capped = true; break; }
            if (!expire_lane(t, source, cutoff_ms, batch, max_deletes, &totals)) return 502;
        }
    }
    // The report (an intra-flow control frame, JSON): what this pass did.
    char report[256];
    const int n = std::snprintf(report, sizeof(report),
        "{\"window_hours\":%.6g,\"cutoff_ms\":%.0f,\"deleted\":%ld,\"not_held\":%ld,\"capped\":%s}",
        window_hours, cutoff_ms, totals.deleted, totals.missing, totals.capped ? "true" : "false");
    if (n > 0 && plugin_push_output_ex("report", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                                       reinterpret_cast<const uint8_t*>(report), static_cast<uint32_t>(n)) < 0) {
        return 500;
    }
    return 0;
}

}  // extern "C"
