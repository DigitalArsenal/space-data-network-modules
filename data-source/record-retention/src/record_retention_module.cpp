/*
 * SDN record retention module.
 *
 * One method, `expire`: keeps a rolling window of records on the node and
 * deletes what has fallen out of it. Each configured target names a standard,
 * its FlatSQL relation, the record's own time column and the sources it
 * applies to; records whose time is older than now - window_hours are read
 * with storage.flatsql_query_stream (SELECT _data ...), their content IDs
 * computed here exactly as the node computes them (raw CIDv1, sha2-256 of the
 * bare record bytes, base32 multibase "b"), and deleted with storage.delete.
 *
 * Owner 2026-10-12, the weather node: "we only need to keep a rolling window
 * of 3 days, we should NOT be archiving more than that (configurable in the
 * module but the default is 3 days)".
 *
 * Config (plugin.getConfig), every field optional:
 *   {"window_hours":72,"batch":2000,"max_deletes":200000,
 *    "targets":[{"schema":"WXF.fbs","table":"WXF","time_column":"VALID_TIME_MS",
 *                "time_unit":"ms","sources":["gfs-0p25-sea"]}]}
 * The compiled default is that target: the weather fields (WXF) of every
 * source, 72 hours by their valid time. An empty or absent "sources" means
 * every source of the standard.
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
constexpr long kDefaultBatch = 2000;
constexpr long kDefaultMaxDeletes = 200000;

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

bool envelope_first_segment(const std::vector<uint8_t>& env, const uint8_t** seg, uint32_t* seg_len) {
    *seg = nullptr;
    *seg_len = 0;
    if (env.size() < 4) return false;
    size_t off = 4u + read_u32le(env.data());
    if (off + 4 > env.size()) return false;
    const uint32_t count = read_u32le(env.data() + off);
    off += 4;
    if (count == 0 || off + 4 > env.size()) return false;
    const uint32_t len = read_u32le(env.data() + off);
    off += 4;
    if (off + len > env.size()) return false;
    *seg = env.data() + off;
    *seg_len = len;
    return true;
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

// Relation and column names are spliced into SQL: identifiers only.
bool is_identifier(const std::string& s) {
    if (s.empty() || s.size() > 64) return false;
    for (const char c : s) {
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_')) return false;
    }
    return !(s[0] >= '0' && s[0] <= '9');
}

// ---------------------------------------------------------------------------
// Content ID: raw CIDv1 (multicodec 0x55), sha2-256 multihash (0x12, 32
// bytes), base32 lower-case without padding, multibase prefix "b" — the
// node's CID of a stored record (bare FlatBuffer bytes).
// ---------------------------------------------------------------------------

struct Sha256 {
    uint32_t h[8];
    uint64_t length = 0;
    uint8_t block[64];
    size_t used = 0;

    static uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

    Sha256() {
        static const uint32_t init[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                         0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
        std::memcpy(h, init, sizeof(h));
    }

    void compress(const uint8_t* p) {
        static const uint32_t k[64] = {
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
        uint32_t w[64];
        for (int i = 0; i < 16; i++) {
            w[i] = (static_cast<uint32_t>(p[4 * i]) << 24) | (static_cast<uint32_t>(p[4 * i + 1]) << 16) |
                   (static_cast<uint32_t>(p[4 * i + 2]) << 8) | static_cast<uint32_t>(p[4 * i + 3]);
        }
        for (int i = 16; i < 64; i++) {
            const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
            const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (int i = 0; i < 64; i++) {
            const uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const uint32_t ch = (e & f) ^ (~e & g);
            const uint32_t t1 = hh + S1 + ch + k[i] + w[i];
            const uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
            const uint32_t t2 = S0 + maj;
            hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }

    void update(const uint8_t* data, size_t n) {
        length += n;
        while (n > 0) {
            const size_t take = (64 - used) < n ? (64 - used) : n;
            std::memcpy(block + used, data, take);
            used += take; data += take; n -= take;
            if (used == 64) { compress(block); used = 0; }
        }
    }

    void finish(uint8_t out[32]) {
        const uint64_t bits = length * 8;
        const uint8_t one = 0x80, zero = 0;
        update(&one, 1);
        while (used != 56) update(&zero, 1);
        uint8_t len_be[8];
        for (int i = 0; i < 8; i++) len_be[i] = static_cast<uint8_t>(bits >> (56 - 8 * i));
        update(len_be, 8);
        for (int i = 0; i < 8; i++) {
            out[4 * i] = static_cast<uint8_t>(h[i] >> 24); out[4 * i + 1] = static_cast<uint8_t>(h[i] >> 16);
            out[4 * i + 2] = static_cast<uint8_t>(h[i] >> 8); out[4 * i + 3] = static_cast<uint8_t>(h[i]);
        }
    }
};

std::string raw_cid(const uint8_t* data, size_t n) {
    uint8_t bytes[36] = {0x01, 0x55, 0x12, 0x20};
    Sha256 sha;
    sha.update(data, n);
    sha.finish(bytes + 4);
    static const char* alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    std::string out = "b";
    uint32_t buffer = 0;
    int bits = 0;
    for (const uint8_t byte : bytes) {
        buffer = (buffer << 8) | byte;
        bits += 8;
        while (bits >= 5) { out.push_back(alphabet[(buffer >> (bits - 5)) & 31]); bits -= 5; }
    }
    if (bits > 0) out.push_back(alphabet[(buffer << (5 - bits)) & 31]);
    return out;
}

// ---------------------------------------------------------------------------
// Expiry.
// ---------------------------------------------------------------------------

struct Target {
    std::string schema = "WXF.fbs";
    std::string table = "WXF";
    std::string time_column = "VALID_TIME_MS";
    double unit_ms = 1.0;  // the column's unit in milliseconds ("ms" 1, "s" 1000)
    std::vector<std::string> sources;  // empty: every source
};

struct Totals {
    long deleted = 0;
    long missing = 0;  // a computed CID the store did not hold (nothing deleted)
    long failed = 0;
};

// Expire one source (or every source, source empty) of one target. Returns
// false on a host failure (error already set).
bool expire_source(const Target& t, const std::string& source, double cutoff_ms, long batch,
                   long max_deletes, Totals* totals) {
    const double cutoff = cutoff_ms / t.unit_ms;
    char cutoff_buf[48], limit_buf[32];
    std::snprintf(cutoff_buf, sizeof(cutoff_buf), "%.0f", cutoff);
    std::snprintf(limit_buf, sizeof(limit_buf), "%ld", batch);
    std::string sql = "SELECT _data FROM " + t.table + " WHERE ";
    std::string params = "[";
    if (!source.empty()) {
        // (the relation's source tag is "<TYPE>@<source_name>")
        sql += "_source = ?1 AND " + t.time_column + " < ?2 LIMIT ?3";
        params += "{\"t\":\"str\",\"v\":\"" + json_escape(t.table + "@" + source) + "\"},";
    } else {
        sql += t.time_column + " < ?1 LIMIT ?2";
    }
    params += std::string("{\"t\":\"i64\",\"v\":") + cutoff_buf + "},{\"t\":\"i64\",\"v\":" + limit_buf + "}]";
    const std::string payload = "{\"sql\":\"" + json_escape(sql) + "\",\"params\":" + params + "}";

    // Each pass reads the oldest batch still present: deleted records leave the
    // relation, so the same query advances. A pass that deletes nothing stops.
    while (totals->deleted < max_deletes) {
        const std::vector<uint8_t> env = hostcall("storage.flatsql_query_stream", payload);
        const std::string meta = envelope_meta_json(env);
        if (!meta_ok(meta)) {
            std::string message;
            json_string(meta, "message", &message);
            plugin_set_error("retention-query-failed",
                             message.empty() ? "storage.flatsql_query_stream failed" : message.c_str());
            return false;
        }
        const uint8_t* seg = nullptr;
        uint32_t len = 0;
        envelope_first_segment(env, &seg, &len);
        long frames = 0, deleted_now = 0;
        for (uint32_t off = 0; seg && off + 4 <= len;) {
            const uint32_t size = read_u32le(seg + off);
            if (off + 4 + size > len) break;
            const std::string cid = raw_cid(seg + off + 4, size);
            off += 4 + size;
            frames++;
            const std::string del = envelope_meta_json(hostcall(
                "storage.delete", "{\"schema\":\"" + json_escape(t.schema) + "\",\"cid\":\"" + cid + "\"}"));
            if (meta_ok(del)) { totals->deleted++; deleted_now++; }
            else if (del.find("not found") != std::string::npos) totals->missing++;
            else totals->failed++;
            if (totals->deleted >= max_deletes) break;
        }
        if (frames < batch || deleted_now == 0) break;
    }
    return true;
}

}  // namespace

extern "C" {

// expire: delete every configured target's records older than the window.
// Status 0 with nothing to do as well; 502 when the host refuses a query.
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
            if (json_string(item, "table", &s)) t.table = s;
            if (json_string(item, "time_column", &s)) t.time_column = s;
            if (json_string(item, "time_unit", &s)) t.unit_ms = s == "s" ? 1000.0 : 1.0;
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
        if (!is_identifier(t.table) || !is_identifier(t.time_column)) {
            plugin_set_error("retention-bad-target", "table and time_column must be plain identifiers.");
            return 400;
        }
        if (t.sources.empty()) {
            if (!expire_source(t, std::string(), cutoff_ms, batch, max_deletes, &totals)) return 502;
        } else {
            for (const std::string& source : t.sources) {
                if (!expire_source(t, source, cutoff_ms, batch, max_deletes, &totals)) return 502;
            }
        }
    }
    // The report (an intra-flow control frame, JSON): what this pass did.
    char report[256];
    const int n = std::snprintf(report, sizeof(report),
        "{\"window_hours\":%.6g,\"cutoff_ms\":%.0f,\"deleted\":%ld,\"not_held\":%ld,\"refused\":%ld,\"capped\":%s}",
        window_hours, cutoff_ms, totals.deleted, totals.missing, totals.failed, totals.deleted >= max_deletes ? "true" : "false");
    if (n > 0 && plugin_push_output_ex("report", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                                       reinterpret_cast<const uint8_t*>(report), static_cast<uint32_t>(n)) < 0) {
        return 500;
    }
    if (totals.failed > 0) {
        char message[160];
        std::snprintf(message, sizeof(message), "%ld deleted, %ld not held, %ld deletes refused by the host",
                      totals.deleted, totals.missing, totals.failed);
        plugin_set_error("retention-deletes-refused", message);
        return 502;
    }
    return 0;
}

}  // extern "C"
