/*
 * data-source/celestrak-parser (loop C.8a).
 *
 * Pure provider-parser flow nodes: the WASM port of sdn-server's
 * internal/ingest CelesTrak parsers (GP CSV -> OMM + MPE, SATCAT txt/csv ->
 * CAT, SW-All.csv -> SPW), built on the spacedatastandards.org GENERATED C++
 * code (OMM/MPE/CAT/SPW main_generated.h inlined by build.mjs — never
 * hand-written bindings).
 *
 * Contract per method (parse_gp / parse_satcat / parse_spw):
 *   inputs:
 *     "job"      UTF-8 JSON from the request-builder node:
 *                {"source_url","source_name","provider_id"?,
 *                 "archive_source"?,"archive_name"?,"reconcile"?}
 *   "response"   UTF-8 JSON from hostcap/http-request:
 *                {"status":N,"headers":{...},"bodyB64":"..."}
 *   outputs (per produced schema):
 *     "<x>_meta"    UTF-8 JSON — the full storage.ingest_with_source meta
 *                   (schema, provider/source/url/batch attribution,
 *                   content_key_id, source_peer, reconcile mode, archive
 *                   naming, provenance record) MINUS the binary segments.
 *     "<x>_records" size-prefixed FlatBuffer record stream
 *                   ([u32le len][record bytes], records unprefixed inside).
 *     "raw"         the decoded source payload (for raw archiving by the
 *                   ingest capability node; emitted once per fetch).
 *     "unchanged"   ONLY on HTTP 304: one JSON notice
 *                   {"status":304,"unchanged":true,"source_name","source_url",
 *                   "dataset_id"}; no meta/records/raw frames are emitted.
 *   The job also carries origin_id/origin_name/dataset_id and
 *   license/license_url/citation; every ingest meta forwards them.
 *
 * Behavior parity with the Go runner is FIELD-EXACT and, for the record
 * bytes, aims byte-exact: builders replicate internal/sds builder defaults
 * and add-order (OMM: TEST-SAT/EARTH/SDN-TEST defaults; CAT: ISS defaults)
 * and internal/ingest parsing rules (valueOr fallbacks, parseFloat guards,
 * duplicate-SATCAT-NORAD error, SPW staleness gate, batch id = sha256 of
 * the fetched payload).
 */

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <map>
#include <string>
#include <vector>

#include <sys/time.h>

#include "space_data_module_invoke.h"

namespace {

constexpr const char* kDefaultProviderID = "space-data-network-02";
constexpr const char* kSourcePeer = "source:celestrak";
constexpr const char* kContentKeyID = "public";
constexpr int64_t kStaleThresholdSeconds = 7 * 24 * 3600;  // runner sourceTimestampStaleThreshold

// ---------------------------------------------------------------------------
// Small string / JSON helpers (control metadata only — same style as the
// other node modules).
// ---------------------------------------------------------------------------

bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

std::string trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && is_ws(s[b])) b++;
    while (e > b && is_ws(s[e - 1])) e--;
    return s.substr(b, e - b);
}

std::string upper(const std::string& s) {
    std::string out = s;
    for (char& c : out) {
        if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
    }
    return out;
}

std::string lower(const std::string& s) {
    std::string out = s;
    for (char& c : out) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return out;
}

// Go normalizeKey: upper, trim, spaces and dashes to underscores.
std::string normalize_key(const std::string& raw) {
    std::string s = upper(trim(raw));
    for (char& c : s) {
        if (c == ' ' || c == '-') c = '_';
    }
    return s;
}

bool json_string_field(const std::string& json, const std::string& key, std::string* out) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
    while (i < json.size() && is_ws(json[i])) i++;
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
    while (i < json.size() && is_ws(json[i])) i++;
    if (i >= json.size()) return false;
    const char c = json[i];
    if (c != '-' && (c < '0' || c > '9')) return false;
    char* end = nullptr;
    const double value = strtod(json.c_str() + i, &end);
    if (end == json.c_str() + i) return false;
    *out = value;
    return true;
}

std::string json_object_slice(const std::string& json, const std::string& key) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return std::string();
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return std::string();
    size_t i = colon + 1;
    while (i < json.size() && is_ws(json[i])) i++;
    if (i >= json.size() || json[i] != '{') return std::string();
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
        else if (c == '{') depth++;
        else if (c == '}') {
            depth--;
            if (depth == 0) return json.substr(start, i - start + 1);
        }
    }
    return std::string();
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
// Base64 (standard alphabet).
// ---------------------------------------------------------------------------

const char kB64Alphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64_encode(const uint8_t* data, size_t length) {
    std::string out;
    out.reserve(((length + 2) / 3) * 4);
    size_t i = 0;
    while (i + 3 <= length) {
        const uint32_t v = (static_cast<uint32_t>(data[i]) << 16) |
                           (static_cast<uint32_t>(data[i + 1]) << 8) | data[i + 2];
        out.push_back(kB64Alphabet[(v >> 18) & 0x3f]);
        out.push_back(kB64Alphabet[(v >> 12) & 0x3f]);
        out.push_back(kB64Alphabet[(v >> 6) & 0x3f]);
        out.push_back(kB64Alphabet[v & 0x3f]);
        i += 3;
    }
    const size_t remain = length - i;
    if (remain == 1) {
        const uint32_t v = static_cast<uint32_t>(data[i]) << 16;
        out.push_back(kB64Alphabet[(v >> 18) & 0x3f]);
        out.push_back(kB64Alphabet[(v >> 12) & 0x3f]);
        out.push_back('=');
        out.push_back('=');
    } else if (remain == 2) {
        const uint32_t v = (static_cast<uint32_t>(data[i]) << 16) |
                           (static_cast<uint32_t>(data[i + 1]) << 8);
        out.push_back(kB64Alphabet[(v >> 18) & 0x3f]);
        out.push_back(kB64Alphabet[(v >> 12) & 0x3f]);
        out.push_back(kB64Alphabet[(v >> 6) & 0x3f]);
        out.push_back('=');
    }
    return out;
}

int b64_value(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

bool base64_decode(const std::string& text, std::vector<uint8_t>* out) {
    out->clear();
    out->reserve((text.size() / 4) * 3);
    uint32_t acc = 0;
    int bits = 0;
    for (const char c : text) {
        if (c == '=' || c == '\n' || c == '\r') continue;
        const int v = b64_value(c);
        if (v < 0) return false;
        acc = (acc << 6) | static_cast<uint32_t>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out->push_back(static_cast<uint8_t>((acc >> bits) & 0xff));
        }
    }
    return true;
}

// ---------------------------------------------------------------------------
// SHA-256 (batch ids = sha256 of the fetched payload, runner sourceSHA256).
// ---------------------------------------------------------------------------

struct Sha256 {
    uint32_t h[8];
    uint64_t total = 0;
    uint8_t buf[64];
    size_t buf_len = 0;

    Sha256() {
        static const uint32_t init[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                         0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
        std::memcpy(h, init, sizeof(init));
    }

    static uint32_t rotr(uint32_t x, uint32_t n) { return (x >> n) | (x << (32 - n)); }

    void block(const uint8_t* p) {
        static const uint32_t k[64] = {
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
            0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
            0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
            0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
            0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
            0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
            0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
            0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
            0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
        uint32_t w[64];
        for (int i = 0; i < 16; i++) {
            w[i] = (static_cast<uint32_t>(p[i * 4]) << 24) |
                   (static_cast<uint32_t>(p[i * 4 + 1]) << 16) |
                   (static_cast<uint32_t>(p[i * 4 + 2]) << 8) | p[i * 4 + 3];
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
        h[0] += a; h[1] += b; h[2] += c; h[3] += d;
        h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }

    void update(const uint8_t* data, size_t len) {
        total += len;
        while (len > 0) {
            const size_t take = std::min(len, sizeof(buf) - buf_len);
            std::memcpy(buf + buf_len, data, take);
            buf_len += take;
            data += take;
            len -= take;
            if (buf_len == 64) {
                block(buf);
                buf_len = 0;
            }
        }
    }

    std::string hex_digest() {
        const uint64_t bit_len = total * 8;
        uint8_t pad = 0x80;
        update(&pad, 1);
        const uint8_t zero = 0;
        while (buf_len != 56) update(&zero, 1);
        uint8_t len_be[8];
        for (int i = 0; i < 8; i++) len_be[i] = static_cast<uint8_t>(bit_len >> (56 - i * 8));
        // update() adds to total but the length bytes are already captured.
        total -= 9;  // keep semantics simple; total is unused after this
        update(len_be, 8);
        static const char* hexd = "0123456789abcdef";
        std::string out;
        out.reserve(64);
        for (int i = 0; i < 8; i++) {
            for (int b = 24; b >= 0; b -= 8) {
                const uint8_t byte = static_cast<uint8_t>(h[i] >> b);
                out.push_back(hexd[byte >> 4]);
                out.push_back(hexd[byte & 0xf]);
            }
        }
        return out;
    }
};

std::string sha256_hex(const uint8_t* data, size_t len) {
    Sha256 s;
    s.update(data, len);
    return s.hex_digest();
}

// Streaming hasher mirroring the runner's writeNormalizedHashRecord:
// sha256 over (schemaName, 0x00, record bytes, 0x00) per record.
void normalized_hash_record(Sha256* h, const char* schema, const std::vector<uint8_t>& record) {
    h->update(reinterpret_cast<const uint8_t*>(schema), std::strlen(schema));
    const uint8_t z = 0;
    h->update(&z, 1);
    h->update(record.data(), record.size());
    h->update(&z, 1);
}

// ---------------------------------------------------------------------------
// Value parsing (mirrors internal/ingest parse helpers).
// ---------------------------------------------------------------------------

bool parse_float(const std::string& raw, double* out) {
    const std::string s = trim(raw);
    if (s.empty()) return false;
    char* end = nullptr;
    const double v = strtod(s.c_str(), &end);
    if (end != s.c_str() + s.size()) return false;
    *out = v;
    return true;
}

double parse_float_or_zero(const std::string& raw) {
    double v = 0;
    return parse_float(raw, &v) ? v : 0;
}

int32_t parse_int32_or_zero(const std::string& raw) {
    const std::string s = trim(raw);
    if (s.empty()) return 0;
    char* end = nullptr;
    const long long v = strtoll(s.c_str(), &end, 10);
    if (end != s.c_str() + s.size()) return 0;
    if (v > INT32_MAX || v < INT32_MIN) return 0;
    return static_cast<int32_t>(v);
}

int32_t parse_kp_tenths_or_zero(const std::string& raw) {
    const std::string s = trim(raw);
    if (s.empty()) return 0;
    if (s.find('.') != std::string::npos) {
        double f = 0;
        if (parse_float(s, &f)) return static_cast<int32_t>(std::llround(f * 10));
        return 0;
    }
    return parse_int32_or_zero(s);
}

bool parse_uint32(const std::string& raw, uint32_t* out) {
    const std::string s = trim(raw);
    if (s.empty()) return false;
    char* end = nullptr;
    const unsigned long long v = strtoull(s.c_str(), &end, 10);
    if (end != s.c_str() + s.size()) return false;
    if (v > 0xffffffffull) return false;
    *out = static_cast<uint32_t>(v);
    return true;
}

bool parse_truthy(const std::string& raw) {
    const std::string s = lower(trim(raw));
    return s == "1" || s == "y" || s == "yes" || s == "true" || s == "t" || s == "m";
}

// ---------------------------------------------------------------------------
// Civil time (epoch parsing/formatting; mirrors internal/ingest parseEpoch's
// accepted layouts and RFC3339 output).
// ---------------------------------------------------------------------------

// days from civil algorithm (Howard Hinnant) — UTC only.
int64_t days_from_civil(int64_t y, int m, int d) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);
    const unsigned doy = (153u * static_cast<unsigned>(m + (m > 2 ? -3 : 9)) + 2u) / 5u +
                         static_cast<unsigned>(d) - 1u;
    const unsigned doe = yoe * 365u + yoe / 4u - yoe / 100u + doy;
    return era * 146097 + static_cast<int64_t>(doe) - 719468;
}

void civil_from_days(int64_t z, int* y_out, int* m_out, int* d_out) {
    z += 719468;
    const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const unsigned doe = static_cast<unsigned>(z - era * 146097);
    const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const int64_t y = static_cast<int64_t>(yoe) + era * 400;
    const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const unsigned mp = (5 * doy + 2) / 153;
    const unsigned d = doy - (153 * mp + 2) / 5 + 1;
    const unsigned m = mp + (mp < 10 ? 3 : -9);
    *y_out = static_cast<int>(y + (m <= 2));
    *m_out = static_cast<int>(m);
    *d_out = static_cast<int>(d);
}

struct ParsedEpoch {
    int64_t unix_seconds = 0;
    bool valid = false;
};

// Accepts: YYYY-MM-DD[ T]HH:MM:SS[.fraction][Z] and bare YYYY-MM-DD (runner
// layouts; numeric-unix fallback intentionally included).
ParsedEpoch parse_epoch(const std::string& raw_in) {
    ParsedEpoch out;
    const std::string raw = trim(raw_in);
    if (raw.empty()) return out;
    int y = 0, mo = 0, d = 0, hh = 0, mm = 0;
    double ss = 0;
    // Full timestamp
    if (raw.size() >= 19 && raw[4] == '-' && raw[7] == '-' && (raw[10] == 'T' || raw[10] == ' ') &&
        raw[13] == ':' && raw[16] == ':') {
        y = atoi(raw.substr(0, 4).c_str());
        mo = atoi(raw.substr(5, 2).c_str());
        d = atoi(raw.substr(8, 2).c_str());
        hh = atoi(raw.substr(11, 2).c_str());
        mm = atoi(raw.substr(14, 2).c_str());
        ss = strtod(raw.substr(17).c_str(), nullptr);
        // Trailing Z / offsets: RFC3339 offsets other than Z are rare in the
        // sources; Z and no-suffix both parse as UTC (runner layouts).
    } else if (raw.size() == 10 && raw[4] == '-' && raw[7] == '-') {
        y = atoi(raw.substr(0, 4).c_str());
        mo = atoi(raw.substr(5, 2).c_str());
        d = atoi(raw.substr(8, 2).c_str());
    } else {
        // Numeric unix-seconds fallback (runner parseEpoch tail).
        double f = 0;
        if (parse_float(raw, &f) && f > 0) {
            out.unix_seconds = static_cast<int64_t>(f);
            out.valid = true;
        }
        return out;
    }
    if (y < 1600 || mo < 1 || mo > 12 || d < 1 || d > 31) return out;
    out.unix_seconds = days_from_civil(y, mo, d) * 86400 + hh * 3600 + mm * 60 +
                       static_cast<int64_t>(ss);
    out.valid = true;
    return out;
}

// RFC3339 seconds-precision UTC (Go time.RFC3339 for UTC times).
std::string format_rfc3339(int64_t unix_seconds) {
    const int64_t days = unix_seconds >= 0 ? unix_seconds / 86400
                                           : (unix_seconds - 86399) / 86400;
    int64_t rem = unix_seconds - days * 86400;
    int y, m, d;
    civil_from_days(days, &y, &m, &d);
    const int hh = static_cast<int>(rem / 3600);
    rem -= static_cast<int64_t>(hh) * 3600;
    const int mm = static_cast<int>(rem / 60);
    const int ss = static_cast<int>(rem - mm * 60);
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02dZ", y, m, d, hh, mm, ss);
    return std::string(buf);
}

std::string format_date(int64_t unix_seconds) {
    const int64_t days = unix_seconds >= 0 ? unix_seconds / 86400
                                           : (unix_seconds - 86399) / 86400;
    int y, m, d;
    civil_from_days(days, &y, &m, &d);
    char buf[16];
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02d", y, m, d);
    return std::string(buf);
}

int64_t now_unix_seconds() {
    struct timeval tv;
    if (gettimeofday(&tv, nullptr) != 0) return 0;
    return static_cast<int64_t>(tv.tv_sec);
}

// HTTP-date (RFC1123: "Mon, 02 Jan 2006 15:04:05 GMT") — for Last-Modified.
bool parse_http_date(const std::string& raw, int64_t* out) {
    static const char* months[12] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
    const std::string s = trim(raw);
    const size_t comma = s.find(',');
    if (comma == std::string::npos || s.size() < comma + 21) return false;
    const std::string rest = trim(s.substr(comma + 1));
    int d = 0, y = 0, hh = 0, mm = 0, ss = 0;
    char mon[4] = {0};
    if (std::sscanf(rest.c_str(), "%d %3s %d %d:%d:%d", &d, mon, &y, &hh, &mm, &ss) != 6) {
        return false;
    }
    int m = 0;
    for (int i = 0; i < 12; i++) {
        if (std::strncmp(mon, months[i], 3) == 0) { m = i + 1; break; }
    }
    if (m == 0) return false;
    *out = days_from_civil(y, m, d) * 86400 + hh * 3600 + mm * 60 + ss;
    return true;
}

// ---------------------------------------------------------------------------
// CSV parsing (RFC4180-ish, mirrors encoding/csv usage with TrimLeadingSpace
// + per-cell TrimSpace + normalized header keys + BOM strip).
// ---------------------------------------------------------------------------

using Row = std::map<std::string, std::string>;

std::string row_value(const Row& row, std::initializer_list<const char*> keys) {
    for (const char* key : keys) {
        auto it = row.find(normalize_key(key));
        if (it != row.end()) {
            const std::string v = trim(it->second);
            if (!v.empty()) return v;
        }
    }
    return std::string();
}

std::string value_or(const std::string& v, const std::string& fallback) {
    return trim(v).empty() ? fallback : v;
}

bool parse_csv(const std::vector<uint8_t>& content, std::vector<Row>* rows_out,
               std::vector<std::string>* header_out, std::string* err) {
    rows_out->clear();
    std::vector<std::vector<std::string>> lines;
    std::vector<std::string> cells;
    std::string cell;
    bool in_quotes = false;
    bool cell_started = false;
    const size_t n = content.size();
    auto end_cell = [&]() {
        cells.push_back(trim(cell));
        cell.clear();
        cell_started = false;
    };
    auto end_line = [&]() {
        if (cell_started || !cell.empty() || !cells.empty()) {
            end_cell();
            // skip fully empty lines
            bool any = false;
            for (const auto& c : cells) {
                if (!c.empty()) { any = true; break; }
            }
            if (any || cells.size() > 1) lines.push_back(cells);
            cells.clear();
        }
    };
    for (size_t i = 0; i < n; i++) {
        const char c = static_cast<char>(content[i]);
        if (in_quotes) {
            if (c == '"') {
                if (i + 1 < n && content[i + 1] == '"') {
                    cell.push_back('"');
                    i++;
                } else {
                    in_quotes = false;
                }
            } else {
                cell.push_back(c);
            }
            continue;
        }
        switch (c) {
            case '"':
                in_quotes = true;
                cell_started = true;
                break;
            case ',':
                end_cell();
                cell_started = true;  // next cell exists even if empty
                break;
            case '\r':
                break;
            case '\n':
                end_line();
                break;
            default:
                cell.push_back(c);
                cell_started = true;
                break;
        }
    }
    end_line();

    if (lines.empty()) {
        *err = "empty CSV payload";
        return false;
    }
    std::vector<std::string> header = lines[0];
    if (!header.empty() && header[0].size() >= 3 &&
        static_cast<uint8_t>(header[0][0]) == 0xEF &&
        static_cast<uint8_t>(header[0][1]) == 0xBB &&
        static_cast<uint8_t>(header[0][2]) == 0xBF) {
        header[0] = header[0].substr(3);
    }
    std::vector<std::string> normalized;
    normalized.reserve(header.size());
    for (const auto& hcell : header) normalized.push_back(normalize_key(hcell));
    if (header_out) *header_out = normalized;

    for (size_t li = 1; li < lines.size(); li++) {
        Row row;
        const auto& cells_in = lines[li];
        for (size_t ci = 0; ci < normalized.size() && ci < cells_in.size(); ci++) {
            row[normalized[ci]] = cells_in[ci];
        }
        rows_out->push_back(std::move(row));
    }
    return true;
}

bool require_csv_column(const std::vector<std::string>& header,
                        std::initializer_list<const char*> any_of) {
    for (const char* key : any_of) {
        const std::string norm = normalize_key(key);
        for (const auto& hcell : header) {
            if (hcell == norm) return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Frame IO helpers.
// ---------------------------------------------------------------------------

bool read_json_frame(const char* port, std::string* out) {
    const int32_t idx = plugin_find_input_index(port, 0);
    if (idx < 0) return false;
    const plugin_input_frame_t* frame = plugin_get_input_frame(static_cast<uint32_t>(idx));
    if (!frame || !frame->payload || frame->payload_length == 0) return false;
    out->assign(reinterpret_cast<const char*>(frame->payload), frame->payload_length);
    return true;
}

int push_json(const char* port, const std::string& json) {
    return plugin_push_output_ex(port, nullptr, nullptr,
                                 PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                                 reinterpret_cast<const uint8_t*>(json.data()),
                                 static_cast<uint32_t>(json.size()));
}

int push_bytes(const char* port, const std::vector<uint8_t>& bytes) {
    return plugin_push_output_ex(port, nullptr, nullptr,
                                 PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                                 bytes.data(), static_cast<uint32_t>(bytes.size()));
}

void append_size_prefixed(std::vector<uint8_t>* stream, const std::vector<uint8_t>& record) {
    const uint32_t len = static_cast<uint32_t>(record.size());
    stream->push_back(static_cast<uint8_t>(len & 0xff));
    stream->push_back(static_cast<uint8_t>((len >> 8) & 0xff));
    stream->push_back(static_cast<uint8_t>((len >> 16) & 0xff));
    stream->push_back(static_cast<uint8_t>((len >> 24) & 0xff));
    stream->insert(stream->end(), record.begin(), record.end());
}

// Shared job/response decode: returns the decoded body bytes or sets a
// plugin error (non-200s and malformed frames fail the node, matching the
// runner's fetch error handling).
struct FetchContext {
    std::string job_json;
    std::string response_json;
    std::string source_url;
    std::string source_name;
    std::string provider_id;
    std::string archive_source;
    std::string archive_name;
    std::string reconcile;
    // Upstream origin + licence, carried from the request-builder job into
    // the ingest meta (the host records the licence against the batch and
    // feeds the origin keys to its $ICN connector ledger).
    std::string origin_id;
    std::string origin_name;
    std::string dataset_id;
    std::string license;
    std::string license_url;
    std::string citation;
    std::string etag;
    std::string last_modified;
    std::string content_type;
    std::string response_date;
    long status = 0;
    // HTTP 304 Not Modified: the host sent the validators it recorded from
    // the previous pull (If-None-Match / If-Modified-Since) and the origin
    // answered that nothing changed. No body, no batch — the parser emits one
    // "unchanged" notice and no record ports.
    bool not_modified = false;
    std::vector<uint8_t> body;
    std::string batch_id;
};

bool load_fetch_context(FetchContext* ctx) {
    if (!read_json_frame("job", &ctx->job_json)) {
        plugin_set_error("missing-job-frame", "parser requires the job JSON frame.");
        return false;
    }
    if (!read_json_frame("response", &ctx->response_json)) {
        plugin_set_error("missing-response-frame", "parser requires the http response JSON frame.");
        return false;
    }
    json_string_field(ctx->job_json, "source_url", &ctx->source_url);
    json_string_field(ctx->job_json, "source_name", &ctx->source_name);
    json_string_field(ctx->job_json, "provider_id", &ctx->provider_id);
    json_string_field(ctx->job_json, "archive_source", &ctx->archive_source);
    json_string_field(ctx->job_json, "archive_name", &ctx->archive_name);
    json_string_field(ctx->job_json, "reconcile", &ctx->reconcile);
    json_string_field(ctx->job_json, "origin_id", &ctx->origin_id);
    json_string_field(ctx->job_json, "origin_name", &ctx->origin_name);
    json_string_field(ctx->job_json, "dataset_id", &ctx->dataset_id);
    json_string_field(ctx->job_json, "license", &ctx->license);
    json_string_field(ctx->job_json, "license_url", &ctx->license_url);
    json_string_field(ctx->job_json, "citation", &ctx->citation);
    if (ctx->provider_id.empty()) ctx->provider_id = kDefaultProviderID;
    if (ctx->source_name.empty()) {
        plugin_set_error("missing-source-name", "job must carry source_name.");
        return false;
    }

    double status = 0;
    if (!json_number_field(ctx->response_json, "status", &status)) {
        plugin_set_error("missing-status", "http response frame carries no status.");
        return false;
    }
    ctx->status = static_cast<long>(status);
    if (ctx->status != 200 && ctx->status != 304) {
        char msg[96];
        std::snprintf(msg, sizeof(msg), "source fetch returned HTTP status %ld", ctx->status);
        plugin_set_error("fetch-failed", msg);
        return false;
    }
    const std::string headers = json_object_slice(ctx->response_json, "headers");
    // Header names as the hosts spell them: the SDK JS hosts lower-case
    // (fetch Headers), the Go host uses net/http canonical keys ("Etag",
    // "Last-Modified", "Content-Type", "Date"). Exact-key lookups, every
    // spelling tried, so the validators are captured on every host.
    json_string_field(headers, "etag", &ctx->etag);
    if (ctx->etag.empty()) json_string_field(headers, "Etag", &ctx->etag);
    if (ctx->etag.empty()) json_string_field(headers, "ETag", &ctx->etag);
    json_string_field(headers, "last-modified", &ctx->last_modified);
    if (ctx->last_modified.empty()) json_string_field(headers, "Last-Modified", &ctx->last_modified);
    json_string_field(headers, "content-type", &ctx->content_type);
    if (ctx->content_type.empty()) json_string_field(headers, "Content-Type", &ctx->content_type);
    json_string_field(headers, "date", &ctx->response_date);
    if (ctx->response_date.empty()) json_string_field(headers, "Date", &ctx->response_date);

    if (ctx->status == 304) {
        // Nothing changed upstream: no body is expected and no batch exists.
        ctx->not_modified = true;
        ctx->body.clear();
        return true;
    }

    std::string body_b64;
    if (!json_string_field(ctx->response_json, "bodyB64", &body_b64) || body_b64.empty()) {
        plugin_set_error("empty-body", "http response frame carries no body.");
        return false;
    }
    if (!base64_decode(body_b64, &ctx->body)) {
        plugin_set_error("invalid-body", "http response bodyB64 is not valid base64.");
        return false;
    }
    ctx->batch_id = sha256_hex(ctx->body.data(), ctx->body.size());
    return true;
}

// Builds the storage.ingest_with_source meta JSON for one schema. archive
// naming is attached only when with_archive is set (once per fetch — the
// runner archives the payload once, not per schema).
std::string build_ingest_meta(const FetchContext& ctx, const char* schema,
                              const std::string& reconcile_default, bool with_archive,
                              const std::string& provenance_source,
                              const std::string& provenance_json) {
    std::string reconcile = ctx.reconcile.empty() ? reconcile_default : ctx.reconcile;
    std::string meta = std::string("{\"schema\":\"") + schema + "\"" +
                       ",\"provider_id\":\"" + json_escape(ctx.provider_id) + "\"" +
                       ",\"source_name\":\"" + json_escape(ctx.source_name) + "\"" +
                       ",\"source_url\":\"" + json_escape(ctx.source_url) + "\"" +
                       ",\"batch_id\":\"" + ctx.batch_id + "\"" +
                       ",\"content_key_id\":\"" + kContentKeyID + "\"" +
                       ",\"source_peer\":\"" + kSourcePeer + "\"" +
                       ",\"reconcile\":\"" + json_escape(reconcile) + "\"";
    // Licence carriage (the host records it against the batch via
    // SourceTags and binds it into the publication) and the upstream origin
    // (host $ICN connector ledger: ORIGIN_ID/ORIGIN_NAME/DATASET_ID). Keys
    // are emitted only when the job declared them; an empty value is never
    // a declaration.
    if (!ctx.license.empty()) meta += ",\"license\":\"" + json_escape(ctx.license) + "\"";
    if (!ctx.license_url.empty())
        meta += ",\"license_url\":\"" + json_escape(ctx.license_url) + "\"";
    if (!ctx.citation.empty()) meta += ",\"citation\":\"" + json_escape(ctx.citation) + "\"";
    if (!ctx.origin_id.empty()) meta += ",\"origin_id\":\"" + json_escape(ctx.origin_id) + "\"";
    if (!ctx.origin_name.empty())
        meta += ",\"origin_name\":\"" + json_escape(ctx.origin_name) + "\"";
    if (!ctx.dataset_id.empty())
        meta += ",\"dataset_id\":\"" + json_escape(ctx.dataset_id) + "\"";
    if (with_archive && !ctx.archive_source.empty() && !ctx.archive_name.empty()) {
        meta += ",\"archive\":{\"source\":\"" + json_escape(ctx.archive_source) +
                "\",\"name\":\"" + json_escape(ctx.archive_name) + "\"}";
    }
    if (!provenance_json.empty()) {
        meta += ",\"provenance\":{\"source\":\"" + json_escape(provenance_source) +
                "\",\"json\":\"" +
                base64_encode(reinterpret_cast<const uint8_t*>(provenance_json.data()),
                              provenance_json.size()) +
                "\"}";
    }
    meta += "}";
    return meta;
}

// Provenance JSON mirroring the runner's ingestBatchProvenance shape (the
// wasm side authors it; the host only places the file).
std::string build_provenance_json(const FetchContext& ctx, const char* parser_version,
                                  const std::string& normalized_sha256, int normalized_count,
                                  const std::string& schema_counts_json) {
    std::string retrieved_at;
    int64_t date_unix = 0;
    if (!ctx.response_date.empty() && parse_http_date(ctx.response_date, &date_unix)) {
        retrieved_at = format_rfc3339(date_unix);
    } else {
        retrieved_at = format_rfc3339(now_unix_seconds());
    }
    char status_buf[16];
    std::snprintf(status_buf, sizeof(status_buf), "%ld", ctx.status);
    std::string out = std::string("{\"source_url\":\"") + json_escape(ctx.source_url) + "\"" +
                      ",\"http_status\":" + status_buf;
    if (!ctx.etag.empty()) out += ",\"etag\":\"" + json_escape(ctx.etag) + "\"";
    if (!ctx.last_modified.empty())
        out += ",\"last_modified\":\"" + json_escape(ctx.last_modified) + "\"";
    if (!ctx.content_type.empty())
        out += ",\"content_type\":\"" + json_escape(ctx.content_type) + "\"";
    char count_buf[16];
    std::snprintf(count_buf, sizeof(count_buf), "%d", normalized_count);
    out += std::string(",\"retrieved_at\":\"") + retrieved_at + "\"" +
           ",\"parser_version\":\"" + parser_version + "\"" +
           ",\"source_sha256\":\"" + ctx.batch_id + "\"" +
           ",\"normalized_sha256\":\"" + normalized_sha256 + "\"" +
           ",\"normalized_count\":" + count_buf +
           ",\"schema_counts\":" + schema_counts_json +
           ",\"warnings\":[],\"from_cache\":false}";
    return out;
}

// HTTP 304: one notice frame on the "unchanged" port, nothing on the record
// ports. The ingest nodes never become ready (their required meta/records
// ports stay empty), so nothing is stored and no batch is announced; the
// notice reaches the flow's egress sink so the operator can see the pull
// happened and found nothing new.
int emit_unchanged(const FetchContext& ctx) {
    const std::string notice = std::string("{\"status\":304,\"unchanged\":true") +
                               ",\"source_name\":\"" + json_escape(ctx.source_name) + "\"" +
                               ",\"source_url\":\"" + json_escape(ctx.source_url) + "\"" +
                               ",\"dataset_id\":\"" + json_escape(ctx.dataset_id) + "\"}";
    return push_json("unchanged", notice) < 0 ? 500 : 0;
}

// ---------------------------------------------------------------------------
// Record builders (byte-parity targets: internal/sds builders + the runner's
// conditional field population).
// ---------------------------------------------------------------------------

std::vector<uint8_t> finished_copy(::flatbuffers::FlatBufferBuilder& fbb) {
    return std::vector<uint8_t>(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
}

// normalizeEphemerisType (internal/ingest/runner.go): TLE numeric code 0-4
// or CCSDS enum name -> ephemerisFormat. valid=false means "leave the schema
// default" (Go skips the add; the generated adders omit the 0 default, so an
// unconditional add of SGP is byte-identical).
struct EphemerisType {
    bool valid = false;
    ephemerisFormat value = ephemerisFormat_SGP;
};

EphemerisType normalize_ephemeris_type(const std::string& raw) {
    std::string v = normalize_key(raw);
    EphemerisType out;
    if (v == "0" || v == "SGP") {
        out.valid = true;
        out.value = ephemerisFormat_SGP;
    } else if (v == "1" || v == "SGP4") {
        out.valid = true;
        out.value = ephemerisFormat_SGP4;
    } else if (v == "2" || v == "SDP4") {
        out.valid = true;
        out.value = ephemerisFormat_SDP4;
    } else if (v == "3" || v == "SGP8") {
        out.valid = true;
        out.value = ephemerisFormat_SGP8;
    } else if (v == "4" || v == "SDP8") {
        out.valid = true;
        out.value = ephemerisFormat_SDP8;
    }
    return out;
}

// internal/sds OMMBuilder.Build() — identical string-creation and add order;
// records are size-prefixed in the builder and the prefix is stripped for the
// stream (the store takes unprefixed record bytes; the stream re-prefixes).
// SGP4 propagation terms + element-set identity follow CLASSIFICATION_TYPE in
// the Go add order; zero values are slot defaults and are omitted, matching
// the Go builder's unconditional adds of zero-initialized fields.
std::vector<uint8_t> build_omm_record(const std::string& object_name, const std::string& object_id,
                                      uint32_t norad, const std::string& epoch_rfc3339,
                                      double mean_motion, double eccentricity, double inclination,
                                      double raan, double argp, double mean_anomaly,
                                      const std::string& creation_date,
                                      const std::string& originator,
                                      const std::string& classification, double bstar,
                                      double mean_motion_dot, double mean_motion_ddot,
                                      uint32_t element_set_no, double rev_at_epoch,
                                      EphemerisType ephemeris_type) {
    ::flatbuffers::FlatBufferBuilder fbb(1024);
    const auto object_name_off = fbb.CreateString(object_name);
    const auto object_id_off = fbb.CreateString(object_id);
    const auto epoch_off = fbb.CreateString(epoch_rfc3339);
    const auto center_name_off = fbb.CreateString("EARTH");
    const auto creation_date_off = fbb.CreateString(creation_date);
    // Honest CCSDS ORIGINATOR (runner parity: gpOriginatorForSource) — the
    // sds test-builder default "SDN-TEST" must never reach production bytes.
    const auto originator_off = fbb.CreateString(originator);
    // WithClassificationType: empty is normalized to "U" (builder default).
    const auto classification_off = fbb.CreateString(classification.empty() ? "U" : classification);

    OMMBuilder builder(fbb);
    builder.add_OBJECT_NAME(object_name_off);
    builder.add_OBJECT_ID(object_id_off);
    builder.add_NORAD_CAT_ID(norad);
    builder.add_EPOCH(epoch_off);
    builder.add_MEAN_MOTION(mean_motion);
    builder.add_ECCENTRICITY(eccentricity);
    builder.add_INCLINATION(inclination);
    builder.add_RA_OF_ASC_NODE(raan);
    builder.add_ARG_OF_PERICENTER(argp);
    builder.add_MEAN_ANOMALY(mean_anomaly);
    builder.add_CENTER_NAME(center_name_off);
    builder.add_CREATION_DATE(creation_date_off);
    builder.add_ORIGINATOR(originator_off);
    builder.add_CLASSIFICATION_TYPE(classification_off);
    builder.add_BSTAR(bstar);
    builder.add_MEAN_MOTION_DOT(mean_motion_dot);
    builder.add_MEAN_MOTION_DDOT(mean_motion_ddot);
    builder.add_ELEMENT_SET_NO(element_set_no);
    builder.add_REV_AT_EPOCH(rev_at_epoch);
    if (ephemeris_type.valid) builder.add_EPHEMERIS_TYPE(ephemeris_type.value);
    const auto omm = builder.Finish();
    FinishSizePrefixedOMMBuffer(fbb, omm);
    auto bytes = finished_copy(fbb);
    return std::vector<uint8_t>(bytes.begin() + 4, bytes.end());
}

// internal/ingest buildMPE — conditional adds on non-zero values.
std::vector<uint8_t> build_mpe_record(const std::string& entity_id, int64_t epoch_unix,
                                      double mean_motion, double ecc, double incl, double raan,
                                      double argp, double mean_anomaly, double bstar) {
    ::flatbuffers::FlatBufferBuilder fbb(256);
    const auto entity_id_off = fbb.CreateString(entity_id);
    MPEBuilder builder(fbb);
    builder.add_ENTITY_ID(entity_id_off);
    if (epoch_unix > 0) builder.add_EPOCH(static_cast<double>(epoch_unix));
    if (mean_motion != 0) builder.add_MEAN_MOTION(mean_motion);
    if (ecc != 0) builder.add_ECCENTRICITY(ecc);
    if (incl != 0) builder.add_INCLINATION(incl);
    if (raan != 0) builder.add_RA_OF_ASC_NODE(raan);
    if (argp != 0) builder.add_ARG_OF_PERICENTER(argp);
    if (mean_anomaly != 0) builder.add_MEAN_ANOMALY(mean_anomaly);
    if (bstar != 0) builder.add_BSTAR(bstar);
    const auto mpe = builder.Finish();
    FinishSizePrefixedMPEBuffer(fbb, mpe);
    auto bytes = finished_copy(fbb);
    return std::vector<uint8_t>(bytes.begin() + 4, bytes.end());
}

std::string normalize_cat_enum(const std::string& value) { return normalize_key(value); }

spaceObjectClass cat_object_type(const std::string& value) {
    const std::string v = normalize_cat_enum(value);
    if (v == "PAYLOAD" || v == "PAYLOAD_STATUS") return spaceObjectClass_PAYLOAD;
    if (v == "ROCKET_BODY" || v == "ROCKET" || v == "ROCKETBODY") return spaceObjectClass_ROCKET_BODY;
    if (v == "DEBRIS") return spaceObjectClass_DEBRIS;
    return spaceObjectClass_UNKNOWN;
}

operationalState cat_ops_status(const std::string& value) {
    const std::string v = normalize_cat_enum(value);
    if (v == "OPERATIONAL" || v == "+") return operationalState_OPERATIONAL;
    if (v == "NONOPERATIONAL" || v == "NON_OPERATIONAL" || v == "-")
        return operationalState_NONOPERATIONAL;
    if (v == "PARTIALLY_OPERATIONAL" || v == "PARTIAL" || v == "P")
        return operationalState_PARTIALLY_OPERATIONAL;
    if (v == "BACKUP_STANDBY" || v == "BACKUP" || v == "B") return operationalState_BACKUP_STANDBY;
    if (v == "SPARE" || v == "S") return operationalState_SPARE;
    if (v == "EXTENDED_MISSION" || v == "EXTENDED" || v == "X")
        return operationalState_EXTENDED_MISSION;
    if (v == "DECAYED" || v == "D") return operationalState_DECAYED;
    return operationalState_UNKNOWN;
}

// normalizeSatcatObjectType (runner) — CSV OBJECT_TYPE values.
std::string normalize_satcat_object_type(const std::string& value) {
    const std::string v = normalize_key(value);
    if (v == "PAYLOAD" || v == "P") return "PAYLOAD";
    if (v == "ROCKET_BODY" || v == "ROCKETBODY" || v == "ROCKET" || v == "R/B" || v == "RB")
        return "ROCKET_BODY";
    if (v == "DEBRIS" || v == "DEB") return "DEBRIS";
    return "UNKNOWN";
}

std::string normalize_satcat_ops_status(const std::string& value) {
    const std::string u = upper(trim(value));
    if (u == "+") return "OPERATIONAL";
    if (u == "-") return "NONOPERATIONAL";
    if (u == "P") return "PARTIALLY_OPERATIONAL";
    if (u == "B") return "BACKUP_STANDBY";
    if (u == "S") return "SPARE";
    if (u == "X") return "EXTENDED_MISSION";
    if (u == "D") return "DECAYED";
    const std::string key = normalize_key(value);
    if (key == "OPERATIONAL" || key == "NONOPERATIONAL" || key == "NON_OPERATIONAL" ||
        key == "PARTIALLY_OPERATIONAL" || key == "BACKUP_STANDBY" || key == "SPARE" ||
        key == "EXTENDED_MISSION" || key == "DECAYED") {
        return key;
    }
    return "UNKNOWN";
}

// CelesTrak's CSV OWNER values are canonical legacyCountryCode labels. Keep
// this mapping deliberately strict: a source value must exactly match a label
// in the generated SDS enum. Do not substitute names, ISO codes, or values
// from a separate country catalog.
legacyCountryCode satcat_owner_code(const std::string& value) {
    const std::string owner = trim(value);
    const auto& values = EnumValueslegacyCountryCode();
    const char* const* names = EnumNameslegacyCountryCode();
    for (size_t i = 0; i <= static_cast<size_t>(legacyCountryCode_MAX); ++i) {
        if (owner == names[i]) return values[i];
    }
    // OWNER is optional in CSV and unavailable in fixed-width SATCAT. Encode
    // UNK explicitly: omitting the field would silently decode as AB, which
    // is Arab Satellite Communications Organization rather than "unknown".
    return legacyCountryCode_UNK;
}

// internal/sds CATBuilder.Build() with the runner's population rules.
std::vector<uint8_t> build_cat_record(const Row& row, uint32_t norad) {
    // Builder defaults (NewCATBuilder) that the runner leaves in place.
    std::string object_name = value_or(row_value(row, {"OBJECT_NAME", "SATNAME", "NAME"}),
                                       "SAT-" + std::to_string(norad));
    std::string object_id = value_or(row_value(row, {"OBJECT_ID", "INTLDES", "INTERNATIONAL_DESIGNATOR"}),
                                     "NORAD-" + std::to_string(norad));
    std::string object_type = normalize_satcat_object_type(row_value(row, {"OBJECT_TYPE"}));
    std::string ops_status =
        normalize_satcat_ops_status(row_value(row, {"OPS_STATUS_CODE", "OPS_STATUS", "STATUS"}));
    const legacyCountryCode owner = satcat_owner_code(row_value(row, {"OWNER"}));
    std::string launch_date = row_value(row, {"LAUNCH_DATE", "LAUNCH"});
    if (launch_date.empty()) launch_date = "1998-11-20";  // NewCATBuilder default (runner parity)

    const double period = parse_float_or_zero(row_value(row, {"PERIOD"}));
    const double inclination = parse_float_or_zero(row_value(row, {"INCLINATION", "INCL"}));
    const double apogee = parse_float_or_zero(row_value(row, {"APOGEE", "APOGEE_KM"}));
    const double perigee = parse_float_or_zero(row_value(row, {"PERIGEE", "PERIGEE_KM"}));

    double mass = 0;
    {
        double v = 0;
        if (parse_float(row_value(row, {"MASS", "MASS_KG"}), &v)) mass = v;
    }
    double size_v = 0;
    {
        double v = 0;
        if (parse_float(row_value(row, {"SIZE", "SIZE_M"}), &v)) size_v = v;
    }
    double rcs = 0;
    {
        double v = 0;
        if (parse_float(row_value(row, {"RCS"}), &v)) rcs = v;
    }
    bool maneuverable = false;
    {
        const std::string v = trim(row_value(row, {"MANEUVERABLE", "MAN"}));
        if (!v.empty()) maneuverable = parse_truthy(v);
    }

    ::flatbuffers::FlatBufferBuilder fbb(1024);
    const auto object_name_off = fbb.CreateString(object_name);
    const auto object_id_off = fbb.CreateString(object_id);
    const auto launch_date_off = fbb.CreateString(launch_date);
    const auto launch_site_off = fbb.CreateString("TYMSC");  // NewCATBuilder default
    const auto decay_date_off = fbb.CreateString("");
    const auto orbit_center_off = fbb.CreateString("EARTH");

    CATBuilder builder(fbb);
    builder.add_OBJECT_NAME(object_name_off);
    builder.add_OBJECT_ID(object_id_off);
    builder.add_NORAD_CAT_ID(norad);
    builder.add_OBJECT_TYPE(cat_object_type(object_type));
    builder.add_OPS_STATUS_CODE(cat_ops_status(ops_status));
    builder.add_OWNER(owner);
    builder.add_LAUNCH_DATE(launch_date_off);
    builder.add_LAUNCH_SITE(launch_site_off);
    builder.add_DECAY_DATE(decay_date_off);
    builder.add_PERIOD(period);
    builder.add_INCLINATION(inclination);
    builder.add_APOGEE(apogee);
    builder.add_PERIGEE(perigee);
    builder.add_RCS(rcs);
    builder.add_ORBIT_CENTER(orbit_center_off);
    builder.add_MANEUVERABLE(maneuverable);
    builder.add_SIZE(size_v);
    builder.add_MASS(mass);
    const auto cat = builder.Finish();
    FinishSizePrefixedCATBuffer(fbb, cat);
    auto bytes = finished_copy(fbb);
    return std::vector<uint8_t>(bytes.begin() + 4, bytes.end());
}

F107DataType parse_f107_data_type(const std::string& raw) {
    const std::string u = upper(trim(raw));
    if (u == "INT") return F107DataType_INT;
    if (u == "PRD") return F107DataType_PRD;
    if (u == "PRM") return F107DataType_PRM;
    return F107DataType_OBS;
}

// internal/ingest buildSPW — full field set, same add order.
std::vector<uint8_t> build_spw_record(const Row& row, const std::string& spw_date) {
    ::flatbuffers::FlatBufferBuilder fbb(256);
    const auto date_off = fbb.CreateString(spw_date);

    SPWBuilder builder(fbb);
    builder.add_DATE(date_off);
    builder.add_BSRN(parse_int32_or_zero(row_value(row, {"BSRN"})));
    builder.add_ND(parse_int32_or_zero(row_value(row, {"ND"})));
    builder.add_KP1(parse_kp_tenths_or_zero(row_value(row, {"KP1"})));
    builder.add_KP2(parse_kp_tenths_or_zero(row_value(row, {"KP2"})));
    builder.add_KP3(parse_kp_tenths_or_zero(row_value(row, {"KP3"})));
    builder.add_KP4(parse_kp_tenths_or_zero(row_value(row, {"KP4"})));
    builder.add_KP5(parse_kp_tenths_or_zero(row_value(row, {"KP5"})));
    builder.add_KP6(parse_kp_tenths_or_zero(row_value(row, {"KP6"})));
    builder.add_KP7(parse_kp_tenths_or_zero(row_value(row, {"KP7"})));
    builder.add_KP8(parse_kp_tenths_or_zero(row_value(row, {"KP8"})));
    builder.add_KP_SUM(parse_kp_tenths_or_zero(row_value(row, {"KP_SUM"})));
    builder.add_AP1(parse_int32_or_zero(row_value(row, {"AP1"})));
    builder.add_AP2(parse_int32_or_zero(row_value(row, {"AP2"})));
    builder.add_AP3(parse_int32_or_zero(row_value(row, {"AP3"})));
    builder.add_AP4(parse_int32_or_zero(row_value(row, {"AP4"})));
    builder.add_AP5(parse_int32_or_zero(row_value(row, {"AP5"})));
    builder.add_AP6(parse_int32_or_zero(row_value(row, {"AP6"})));
    builder.add_AP7(parse_int32_or_zero(row_value(row, {"AP7"})));
    builder.add_AP8(parse_int32_or_zero(row_value(row, {"AP8"})));
    builder.add_AP_AVG(parse_int32_or_zero(row_value(row, {"AP_AVG"})));
    builder.add_CP(static_cast<float>(parse_float_or_zero(row_value(row, {"CP"}))));
    builder.add_C9(parse_int32_or_zero(row_value(row, {"C9"})));
    builder.add_ISN(parse_int32_or_zero(row_value(row, {"ISN"})));
    builder.add_F107_OBS(static_cast<float>(parse_float_or_zero(row_value(row, {"F10.7_OBS", "F107_OBS"}))));
    builder.add_F107_ADJ(static_cast<float>(parse_float_or_zero(row_value(row, {"F10.7_ADJ", "F107_ADJ"}))));
    builder.add_F107_DATA_TYPE(parse_f107_data_type(row_value(row, {"F10.7_DATA_TYPE", "F107_DATA_TYPE"})));
    builder.add_F107_OBS_CENTER81(
        static_cast<float>(parse_float_or_zero(row_value(row, {"F10.7_OBS_CENTER81", "F107_OBS_CENTER81"}))));
    builder.add_F107_OBS_LAST81(
        static_cast<float>(parse_float_or_zero(row_value(row, {"F10.7_OBS_LAST81", "F107_OBS_LAST81"}))));
    builder.add_F107_ADJ_CENTER81(
        static_cast<float>(parse_float_or_zero(row_value(row, {"F10.7_ADJ_CENTER81", "F107_ADJ_CENTER81"}))));
    builder.add_F107_ADJ_LAST81(
        static_cast<float>(parse_float_or_zero(row_value(row, {"F10.7_ADJ_LAST81", "F107_ADJ_LAST81"}))));
    const auto spw = builder.Finish();
    FinishSizePrefixedSPWBuffer(fbb, spw);
    auto bytes = finished_copy(fbb);
    return std::vector<uint8_t>(bytes.begin() + 4, bytes.end());
}

// ---------------------------------------------------------------------------
// SATCAT fixed-width (runner parseSatcatFixedWidth; 1-based inclusive cols).
// ---------------------------------------------------------------------------

std::string satcat_column(const std::string& line, size_t start, size_t end) {
    if (start < 1 || end < start) return std::string();
    if (line.size() < start) return std::string();
    if (end > line.size()) end = line.size();
    return trim(line.substr(start - 1, end - start + 1));
}

std::string infer_fixed_width_object_type(const std::string& object_name) {
    const std::string name = upper(trim(object_name));
    if (name.find(" DEB") != std::string::npos || name.find("DEBRIS") != std::string::npos ||
        (name.size() >= 3 && name.compare(name.size() - 3, 3, "DEB") == 0)) {
        return "DEBRIS";
    }
    if (name.find("R/B") != std::string::npos || name.find("ROCKET BODY") != std::string::npos) {
        return "ROCKET_BODY";
    }
    if (!name.empty()) return "PAYLOAD";
    return "UNKNOWN";
}

bool parse_satcat_rows(const std::vector<uint8_t>& content, std::vector<Row>* rows,
                       std::vector<std::string>* header, std::string* err) {
    // First non-empty line decides the format (comma => CSV).
    std::string first_line;
    {
        std::string line;
        for (size_t i = 0; i <= content.size(); i++) {
            if (i == content.size() || content[i] == '\n') {
                const std::string t = trim(line);
                if (!t.empty()) { first_line = t; break; }
                line.clear();
            } else if (content[i] != '\r') {
                line.push_back(static_cast<char>(content[i]));
            }
        }
    }
    if (first_line.empty()) {
        *err = "empty SATCAT payload";
        return false;
    }
    if (first_line.find(',') != std::string::npos) {
        return parse_csv(content, rows, header, err);
    }

    rows->clear();
    std::string line;
    for (size_t i = 0; i <= content.size(); i++) {
        const bool eol = (i == content.size()) || content[i] == '\n';
        if (!eol) {
            line.push_back(static_cast<char>(content[i]));
            continue;
        }
        while (!line.empty() && line.back() == '\r') line.pop_back();
        if (!trim(line).empty()) {
            Row row;
            row[normalize_key("OBJECT_ID")] = satcat_column(line, 1, 11);
            row[normalize_key("NORAD_CAT_ID")] = satcat_column(line, 14, 18);
            row[normalize_key("OPS_STATUS")] = satcat_column(line, 22, 22);
            row[normalize_key("OBJECT_NAME")] = satcat_column(line, 24, 47);
            row[normalize_key("LAUNCH_DATE")] = satcat_column(line, 57, 66);
            row[normalize_key("LAUNCH_SITE")] = satcat_column(line, 69, 73);
            row[normalize_key("DECAY_DATE")] = satcat_column(line, 76, 85);
            row[normalize_key("PERIOD")] = satcat_column(line, 88, 94);
            row[normalize_key("INCLINATION")] = satcat_column(line, 97, 101);
            row[normalize_key("APOGEE")] = satcat_column(line, 104, 109);
            row[normalize_key("PERIGEE")] = satcat_column(line, 112, 117);
            row[normalize_key("RCS")] = satcat_column(line, 120, 127);
            row[normalize_key("OBJECT_TYPE")] =
                infer_fixed_width_object_type(row[normalize_key("OBJECT_NAME")]);
            // The public fixed-width SATCAT layout has no OWNER column. The
            // builder explicitly encodes UNK; never infer ownership from a
            // launch site or object identity.
            rows->push_back(std::move(row));
        }
        line.clear();
    }
    if (rows->empty()) {
        *err = "no SATCAT rows parsed";
        return false;
    }
    if (header) header->clear();
    return true;
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
// Each parse method pairs ONE job contract with ONE fetched response and emits
// one frame per output port. The `response` port is fed by hostcap/http-request,
// which since the multi-provider fix emits one response frame PER REQUEST frame
// it was handed - so if this flow's `req` node ever fanned out more than one
// descriptor, this node would receive several responses and parse only the
// first, publishing a catalog silently missing the rest. That is exactly the
// failure mode this class was filed for.
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

// ---------------------------------------------------------------------------
// Method entry points.
// ---------------------------------------------------------------------------

extern "C" {

// parse_gp: CelesTrak GP CSV -> OMM + MPE record streams + ingest metas.
int parse_gp(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    FetchContext ctx;
    if (!load_fetch_context(&ctx)) return 400;
    if (ctx.not_modified) return emit_unchanged(ctx);

    std::vector<Row> rows;
    std::vector<std::string> header;
    std::string err;
    if (!parse_csv(ctx.body, &rows, &header, &err)) {
        plugin_set_error("gp-parse-failed", err.c_str());
        return 422;
    }
    if (!require_csv_column(header, {"NORAD_CAT_ID", "NORAD_CAT_NUM"})) {
        plugin_set_error("gp-parse-failed", "GP payload is missing required column NORAD_CAT_ID.");
        return 422;
    }
    if (!require_csv_column(header, {"EPOCH", "EPOCH_UTC"})) {
        plugin_set_error("gp-parse-failed", "GP payload is missing required column EPOCH.");
        return 422;
    }

    std::vector<uint8_t> omm_stream, mpe_stream;
    Sha256 normalized;
    int count_omm = 0, count_mpe = 0;

    for (const Row& row : rows) {
        uint32_t norad = 0;
        if (!parse_uint32(row_value(row, {"NORAD_CAT_ID", "NORAD_CAT_NUM"}), &norad) || norad == 0) {
            continue;
        }
        const std::string raw_epoch = row_value(row, {"EPOCH", "EPOCH_UTC"});
        ParsedEpoch epoch;
        if (!trim(raw_epoch).empty()) {
            epoch = parse_epoch(raw_epoch);
            if (!epoch.valid) {
                char msg[96];
                std::snprintf(msg, sizeof(msg), "malformed EPOCH for NORAD_CAT_ID=%u", norad);
                plugin_set_error("gp-parse-failed", msg);
                return 422;
            }
        }

        const std::string object_name = value_or(row_value(row, {"OBJECT_NAME", "SATNAME", "NAME"}),
                                                 "SAT-" + std::to_string(norad));
        const std::string object_id =
            value_or(row_value(row, {"OBJECT_ID", "INTLDES", "INTERNATIONAL_DESIGNATOR"}),
                     "NORAD-" + std::to_string(norad));

        // deterministicOMMCreationDate: CREATION_DATE column, else epoch
        // RFC3339, else "".
        std::string creation_date = trim(row_value(row, {"CREATION_DATE"}));
        std::string epoch_rfc3339;
        if (epoch.valid) epoch_rfc3339 = format_rfc3339(epoch.unix_seconds);
        if (creation_date.empty() && epoch.valid) creation_date = epoch_rfc3339;

        // NewOMMBuilder defaults survive when parseFloat fails (runner parity).
        double mean_motion = 15.5, ecc = 0.0001, incl = 51.6, raan = 180.0, argp = 90.0, ma = 0.0;
        double v = 0;
        if (parse_float(row_value(row, {"MEAN_MOTION", "N"}), &v)) mean_motion = v;
        if (parse_float(row_value(row, {"ECCENTRICITY", "ECC"}), &v)) ecc = v;
        if (parse_float(row_value(row, {"INCLINATION", "INC"}), &v)) incl = v;
        if (parse_float(row_value(row, {"RA_OF_ASC_NODE", "RAAN"}), &v)) raan = v;
        if (parse_float(row_value(row, {"ARG_OF_PERICENTER", "ARGP"}), &v)) argp = v;
        if (parse_float(row_value(row, {"MEAN_ANOMALY", "MA"}), &v)) ma = v;
        // SGP4 propagation terms + element-set identity (runner parity: field
        // stays zero-initialized when the cell is absent or unparsable).
        double bstar = 0, mm_dot = 0, mm_ddot = 0, rev_at_epoch = 0;
        uint32_t element_set_no = 0;
        if (parse_float(row_value(row, {"BSTAR", "B_STAR"}), &v)) bstar = v;
        if (parse_float(row_value(row, {"MEAN_MOTION_DOT", "N_DOT", "NDOT"}), &v)) mm_dot = v;
        if (parse_float(row_value(row, {"MEAN_MOTION_DDOT", "N_DDOT", "NDDOT"}), &v)) mm_ddot = v;
        uint32_t u = 0;
        if (parse_uint32(row_value(row, {"ELEMENT_SET_NO", "ELSET_NO"}), &u)) element_set_no = u;
        if (parse_float(row_value(row, {"REV_AT_EPOCH", "REV"}), &v)) rev_at_epoch = v;
        const std::string classification = trim(row_value(row, {"CLASSIFICATION_TYPE", "CLASSIFICATION"}));
        const EphemerisType ephemeris_type =
            normalize_ephemeris_type(row_value(row, {"EPHEMERIS_TYPE"}));
        // gpOriginatorForSource("source:celestrak") parity: a row ORIGINATOR
        // wins; the CelesTrak GP CSV has no such column, so "CELESTRAK".
        const std::string originator = value_or(row_value(row, {"ORIGINATOR"}), "CELESTRAK");

        // The builder default epoch is time.Now() in Go — the runner ALWAYS
        // overrides it when the row has an epoch (required column). Rows with
        // an empty-but-present EPOCH keep a "now" epoch in Go; here we use
        // the same RFC3339 of now for that edge (no such rows in practice).
        std::string epoch_field = epoch_rfc3339;
        if (epoch_field.empty()) epoch_field = format_rfc3339(now_unix_seconds());

        const std::vector<uint8_t> omm =
            build_omm_record(object_name, object_id, norad, epoch_field, mean_motion, ecc, incl,
                             raan, argp, ma, creation_date, originator, classification, bstar,
                             mm_dot, mm_ddot, element_set_no, rev_at_epoch, ephemeris_type);
        append_size_prefixed(&omm_stream, omm);
        normalized_hash_record(&normalized, "OMM.fbs", omm);
        count_omm++;

        const int64_t epoch_unix = epoch.valid ? epoch.unix_seconds : 0;
        const std::vector<uint8_t> mpe = build_mpe_record(
            object_id, epoch_unix, parse_float_or_zero(row_value(row, {"MEAN_MOTION", "N"})),
            parse_float_or_zero(row_value(row, {"ECCENTRICITY", "ECC"})),
            parse_float_or_zero(row_value(row, {"INCLINATION", "INC"})),
            parse_float_or_zero(row_value(row, {"RA_OF_ASC_NODE", "RAAN"})),
            parse_float_or_zero(row_value(row, {"ARG_OF_PERICENTER", "ARGP"})),
            parse_float_or_zero(row_value(row, {"MEAN_ANOMALY", "MA"})),
            parse_float_or_zero(row_value(row, {"BSTAR", "B_STAR"})));
        append_size_prefixed(&mpe_stream, mpe);
        normalized_hash_record(&normalized, "MPE.fbs", mpe);
        count_mpe++;
    }

    if (count_omm == 0) {
        plugin_set_error("gp-parse-failed", "no OMM rows parsed");
        return 422;
    }

    const std::string normalized_hex = normalized.hex_digest();
    char counts[96];
    std::snprintf(counts, sizeof(counts), "{\"OMM.fbs\":%d,\"MPE.fbs\":%d}", count_omm, count_mpe);
    const std::string provenance =
        build_provenance_json(ctx, "celestrak-gp-wasm/v2", normalized_hex, count_omm + count_mpe,
                              counts);

    const std::string omm_meta =
        build_ingest_meta(ctx, "OMM.fbs", "duplicates", /*with_archive=*/true,
                          ctx.source_name, provenance);
    const std::string mpe_meta =
        build_ingest_meta(ctx, "MPE.fbs", "duplicates", /*with_archive=*/false,
                          ctx.source_name, std::string());

    if (push_json("omm_meta", omm_meta) < 0) return 500;
    if (push_bytes("omm_records", omm_stream) < 0) return 500;
    if (push_json("mpe_meta", mpe_meta) < 0) return 500;
    if (push_bytes("mpe_records", mpe_stream) < 0) return 500;
    if (push_bytes("raw", ctx.body) < 0) return 500;
    return 0;
}

// parse_satcat: CelesTrak SATCAT (fixed-width txt OR csv) -> CAT records.
int parse_satcat(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    FetchContext ctx;
    if (!load_fetch_context(&ctx)) return 400;
    if (ctx.not_modified) return emit_unchanged(ctx);

    std::vector<Row> rows;
    std::vector<std::string> header;
    std::string err;
    if (!parse_satcat_rows(ctx.body, &rows, &header, &err)) {
        plugin_set_error("satcat-parse-failed", err.c_str());
        return 422;
    }

    std::vector<uint8_t> cat_stream;
    Sha256 normalized;
    int count = 0;
    std::map<uint32_t, bool> seen;
    for (const Row& row : rows) {
        uint32_t norad = 0;
        if (!parse_uint32(row_value(row, {"NORAD_CAT_ID", "NORAD_CAT_NUM", "NORAD"}), &norad) ||
            norad == 0) {
            continue;
        }
        if (seen.count(norad)) {
            char msg[64];
            std::snprintf(msg, sizeof(msg), "duplicate SATCAT NORAD_CAT_ID %u", norad);
            plugin_set_error("satcat-parse-failed", msg);
            return 422;
        }
        seen[norad] = true;
        const std::vector<uint8_t> cat = build_cat_record(row, norad);
        append_size_prefixed(&cat_stream, cat);
        normalized_hash_record(&normalized, "CAT.fbs", cat);
        count++;
    }
    if (count == 0) {
        plugin_set_error("satcat-parse-failed", "no CAT rows parsed");
        return 422;
    }

    const std::string normalized_hex = normalized.hex_digest();
    char counts[48];
    std::snprintf(counts, sizeof(counts), "{\"CAT.fbs\":%d}", count);
    const std::string provenance = build_provenance_json(
        ctx, "celestrak-satcat-wasm/v1", normalized_hex, count, counts);

    // SATCAT is a snapshot source — only the newest batch is meaningful
    // (runner reconcileCelestrakCurrentSourceBatch).
    const std::string cat_meta = build_ingest_meta(ctx, "CAT.fbs", "current",
                                                   /*with_archive=*/true, ctx.source_name,
                                                   provenance);
    if (push_json("cat_meta", cat_meta) < 0) return 500;
    if (push_bytes("cat_records", cat_stream) < 0) return 500;
    if (push_bytes("raw", ctx.body) < 0) return 500;
    return 0;
}

// parse_spw: CelesTrak SW-All.csv -> SPW records (with the runner's
// stale-source gate on the DATE column).
int parse_spw(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    FetchContext ctx;
    if (!load_fetch_context(&ctx)) return 400;
    if (ctx.not_modified) return emit_unchanged(ctx);

    std::vector<Row> rows;
    std::vector<std::string> header;
    std::string err;
    if (!parse_csv(ctx.body, &rows, &header, &err)) {
        plugin_set_error("spw-parse-failed", err.c_str());
        return 422;
    }
    if (!require_csv_column(header, {"DATE"})) {
        plugin_set_error("spw-parse-failed", "SPW payload is missing required column DATE.");
        return 422;
    }

    // Stale-source validation (runner validateFreshSourceTimestamp): the
    // newest DATE must not lag the reference (Last-Modified, else now) by
    // more than 7 days.
    int64_t latest = 0;
    for (const Row& row : rows) {
        const std::string raw = row_value(row, {"DATE"});
        if (trim(raw).empty()) continue;
        const ParsedEpoch parsed = parse_epoch(raw);
        if (!parsed.valid) {
            plugin_set_error("spw-parse-failed", ("malformed DATE " + raw).c_str());
            return 422;
        }
        if (parsed.unix_seconds > latest) latest = parsed.unix_seconds;
    }
    int64_t reference = 0;
    if (ctx.last_modified.empty() || !parse_http_date(ctx.last_modified, &reference)) {
        reference = now_unix_seconds();
    }
    if (latest != 0 && reference != 0 && latest < reference - kStaleThresholdSeconds) {
        plugin_set_error("spw-stale-source",
                         ("stale source timestamp for " + ctx.source_name + ": latest=" +
                          format_rfc3339(latest) + " reference=" + format_rfc3339(reference))
                             .c_str());
        return 422;
    }

    std::vector<uint8_t> spw_stream;
    Sha256 normalized;
    int count = 0;
    for (const Row& row : rows) {
        const std::string raw_date = row_value(row, {"DATE"});
        if (trim(raw_date).empty()) continue;
        const ParsedEpoch parsed = parse_epoch(raw_date);
        if (!parsed.valid) {
            plugin_set_error("spw-parse-failed", ("malformed DATE " + raw_date).c_str());
            return 422;
        }
        const std::vector<uint8_t> spw = build_spw_record(row, format_date(parsed.unix_seconds));
        append_size_prefixed(&spw_stream, spw);
        normalized_hash_record(&normalized, "SPW.fbs", spw);
        count++;
    }
    if (count == 0) {
        plugin_set_error("spw-parse-failed", "no SPW rows parsed");
        return 422;
    }

    const std::string normalized_hex = normalized.hex_digest();
    char counts[48];
    std::snprintf(counts, sizeof(counts), "{\"SPW.fbs\":%d}", count);
    const std::string provenance = build_provenance_json(
        ctx, "celestrak-space-weather-wasm/v1", normalized_hex, count, counts);

    // Runner parity: syncCelestrakSpaceWeather performs NO source-batch
    // reconcile (SPW rows carry no indexed identity key — the duplicates
    // reconcile would collapse them; replay idempotence comes from
    // content-addressed CID dedupe alone).
    const std::string spw_meta = build_ingest_meta(ctx, "SPW.fbs", "none",
                                                   /*with_archive=*/true, ctx.source_name,
                                                   provenance);
    if (push_json("spw_meta", spw_meta) < 0) return 500;
    if (push_bytes("spw_records", spw_stream) < 0) return 500;
    if (push_bytes("raw", ctx.body) < 0) return 500;
    return 0;
}

}  // extern "C"
