/*
 * data-source/weathernext-parser.
 *
 * Pure parser flow nodes for a machine-learned global ensemble weather
 * forecast source, built on the spacedatastandards.org GENERATED C++ code
 * (WXF + TCT main_generated.h inlined by build.mjs — never hand-written
 * bindings). The .ts reference under src/reference/ is normative for the
 * decoded VALUES; this file reproduces its constants for the "bytes" codec
 * and the cyclone CSV.
 *
 * Methods:
 *   parse_cloud_chunks : jobs[k] + responses[k] -> wxf_meta + wxf_records
 *       One $WXF tile per Zarr v3 chunk. Jobs and responses are paired BY
 *       POSITION (the request builder emitted them in the same order); a
 *       count mismatch is refused, never guessed.
 *   parse_cyclone_tracks : job + response -> tct_meta + tct_records + raw
 *       One $TCT per (storm, member) group of CSV rows, points sorted by
 *       valid time.
 *
 * Codec scope of this build: "bytes" (float32 / float16, little endian).
 * A "zstd" stage reports codec-unsupported — vendoring a zstd decoder is the
 * documented follow-up; the .ts reference already decodes it via node:zlib.
 *
 * Nothing about the upstream bucket layout is hardcoded: chunk shape, codec
 * chain, dimension order, dtype and the global grid ride the job JSON and are
 * validated here by size (product(chunk_shape) * itemsize).
 */

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include <sys/time.h>

#include "space_data_module_invoke.h"

namespace {

constexpr const char* kContentKeyID = "public";
constexpr const char* kParserVersionClouds = "weathernext-zarr-wasm/v1";
constexpr const char* kParserVersionCyclones = "weathernext-cyclone-wasm/v1";
constexpr const char* kLicenseIdHistorical = "CC-BY-4.0";
constexpr const char* kLicenseIdRealTime = "LicenseRef-WeatherNext-RealTime-Experimental";
constexpr uint32_t kMaxInlineCells = 1048576u;
constexpr double kKtToMs = 1852.0 / 3600.0;
constexpr double kNmiToKm = 1.852;

// ---------------------------------------------------------------------------
// Small string / JSON helpers (control metadata only).
// ---------------------------------------------------------------------------

bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

std::string trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && is_ws(s[b])) b++;
    while (e > b && is_ws(s[e - 1])) e--;
    return s.substr(b, e - b);
}

std::string lower(const std::string& s) {
    std::string out = s;
    for (char& c : out) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return out;
}

std::string upper(const std::string& s) {
    std::string out = s;
    for (char& c : out) {
        if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
    }
    return out;
}

// Position just past the colon of "key": at the first occurrence, or npos.
size_t json_value_start(const std::string& json, const std::string& key) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return std::string::npos;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return std::string::npos;
    size_t i = colon + 1;
    while (i < json.size() && is_ws(json[i])) i++;
    return i;
}

bool json_string_field(const std::string& json, const std::string& key, std::string* out) {
    size_t i = json_value_start(json, key);
    if (i == std::string::npos || i >= json.size() || json[i] != '"') return false;
    i++;
    std::string value;
    while (i < json.size() && json[i] != '"') {
        if (json[i] == '\\' && i + 1 < json.size()) {
            const char n = json[i + 1];
            if (n == 'n') value.push_back('\n');
            else if (n == 't') value.push_back('\t');
            else if (n == 'r') value.push_back('\r');
            else if (n == 'u' && i + 5 < json.size()) {
                const long cp = std::strtol(json.substr(i + 2, 4).c_str(), nullptr, 16);
                value.push_back(cp < 0x80 ? static_cast<char>(cp) : '?');
                i += 4;
            } else value.push_back(n);
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
    const size_t i = json_value_start(json, key);
    if (i == std::string::npos || i >= json.size()) return false;
    const char c = json[i];
    if (c != '-' && (c < '0' || c > '9')) return false;
    char* end = nullptr;
    const double value = strtod(json.c_str() + i, &end);
    if (end == json.c_str() + i) return false;
    *out = value;
    return true;
}

bool json_bool_field(const std::string& json, const std::string& key, bool* out) {
    const size_t i = json_value_start(json, key);
    if (i == std::string::npos || i >= json.size()) return false;
    if (json.compare(i, 4, "true") == 0) { *out = true; return true; }
    if (json.compare(i, 5, "false") == 0) { *out = false; return true; }
    return false;
}

std::string json_bracketed_slice(const std::string& json, const std::string& key, char open, char close) {
    size_t i = json_value_start(json, key);
    if (i == std::string::npos || i >= json.size() || json[i] != open) return std::string();
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
    return json_bracketed_slice(json, key, '{', '}');
}

std::string json_array_slice(const std::string& json, const std::string& key) {
    return json_bracketed_slice(json, key, '[', ']');
}

// Numbers of a flat JSON array slice "[1, 2, 3]".
std::vector<double> json_number_array(const std::string& slice) {
    std::vector<double> out;
    size_t i = 0;
    while (i < slice.size()) {
        const char c = slice[i];
        if (c == '-' || (c >= '0' && c <= '9')) {
            char* end = nullptr;
            const double v = strtod(slice.c_str() + i, &end);
            const size_t consumed = static_cast<size_t>(end - (slice.c_str() + i));
            if (consumed == 0) break;
            out.push_back(v);
            i += consumed;
        } else {
            i++;
        }
    }
    return out;
}

// Strings of a flat JSON array slice "[\"a\", \"b\"]".
std::vector<std::string> json_string_array(const std::string& slice) {
    std::vector<std::string> out;
    for (size_t i = 0; i < slice.size(); i++) {
        if (slice[i] != '"') continue;
        std::string value;
        size_t j = i + 1;
        while (j < slice.size() && slice[j] != '"') {
            if (slice[j] == '\\' && j + 1 < slice.size()) {
                value.push_back(slice[j + 1]);
                j += 2;
            } else {
                value.push_back(slice[j]);
                j++;
            }
        }
        out.push_back(value);
        i = j;
    }
    return out;
}

std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (const char c : s) {
        if (c == '"' || c == '\\') { out.push_back('\\'); out.push_back(c); }
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else if (static_cast<unsigned char>(c) < 0x20) {
            char buf[8];
            std::snprintf(buf, sizeof(buf), "\\u%04x", c);
            out += buf;
        } else out.push_back(c);
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
// SHA-256 (batch ids = sha256 of the fetched payload(s)).
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

// sha256 over (schemaName, 0x00, record bytes, 0x00) per record, in order.
void normalized_hash_record(Sha256* h, const char* schema, const std::vector<uint8_t>& record) {
    h->update(reinterpret_cast<const uint8_t*>(schema), std::strlen(schema));
    const uint8_t z = 0;
    h->update(&z, 1);
    h->update(record.data(), record.size());
    h->update(&z, 1);
}

// ---------------------------------------------------------------------------
// Civil time — UTC only. Epochs are Unix milliseconds throughout.
// ---------------------------------------------------------------------------

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

// ISO 8601 UTC: YYYY-MM-DD[T ]HH:MM[:SS[.fff]][Z] or bare YYYY-MM-DD.
bool parse_iso_ms(const std::string& raw_in, int64_t* out_ms) {
    const std::string raw = trim(raw_in);
    if (raw.size() < 10 || raw[4] != '-' || raw[7] != '-') return false;
    const int y = atoi(raw.substr(0, 4).c_str());
    const int mo = atoi(raw.substr(5, 2).c_str());
    const int d = atoi(raw.substr(8, 2).c_str());
    int hh = 0, mm = 0;
    double ss = 0;
    if (raw.size() >= 16 && (raw[10] == 'T' || raw[10] == ' ') && raw[13] == ':') {
        hh = atoi(raw.substr(11, 2).c_str());
        mm = atoi(raw.substr(14, 2).c_str());
        if (raw.size() >= 19 && raw[16] == ':') ss = strtod(raw.substr(17).c_str(), nullptr);
    } else if (raw.size() != 10) {
        return false;
    }
    if (y < 1600 || mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    const int64_t seconds = days_from_civil(y, mo, d) * 86400 + hh * 3600 + mm * 60;
    *out_ms = seconds * 1000 + static_cast<int64_t>(std::llround(ss * 1000.0));
    return true;
}

std::string format_iso_seconds(int64_t unix_ms) {
    const int64_t unix_seconds = unix_ms >= 0 ? unix_ms / 1000 : (unix_ms - 999) / 1000;
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

int64_t now_unix_ms() {
    struct timeval tv;
    if (gettimeofday(&tv, nullptr) != 0) return 0;
    return static_cast<int64_t>(tv.tv_sec) * 1000 + static_cast<int64_t>(tv.tv_usec / 1000);
}

// HTTP-date (RFC 1123: "Mon, 02 Jan 2006 15:04:05 GMT").
bool parse_http_date(const std::string& raw, int64_t* out_ms) {
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
    *out_ms = (days_from_civil(y, m, d) * 86400 + hh * 3600 + mm * 60 + ss) * 1000;
    return true;
}

std::string format_number(double v) {
    if (std::isfinite(v) && v == std::floor(v) && std::fabs(v) < 1e15) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(v));
        return buf;
    }
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.15g", v);
    if (strtod(buf, nullptr) != v) std::snprintf(buf, sizeof(buf), "%.17g", v);
    return buf;
}

// ---------------------------------------------------------------------------
// CSV (RFC 4180-ish; lower-cased header keys; blank cell = "").
// ---------------------------------------------------------------------------

using Row = std::map<std::string, std::string>;

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
            bool any = false;
            for (const auto& c : cells) {
                if (!c.empty()) { any = true; break; }
            }
            if (any || cells.size() > 1) lines.push_back(cells);
            cells.clear();
        }
    };
    size_t start = 0;
    if (n >= 3 && content[0] == 0xEF && content[1] == 0xBB && content[2] == 0xBF) start = 3;
    for (size_t i = start; i < n; i++) {
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
                cell_started = true;
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
    std::vector<std::string> header;
    header.reserve(lines[0].size());
    for (const auto& hcell : lines[0]) header.push_back(lower(trim(hcell)));
    if (header_out) *header_out = header;
    for (size_t li = 1; li < lines.size(); li++) {
        Row row;
        const auto& cells_in = lines[li];
        for (size_t ci = 0; ci < header.size(); ci++) {
            row[header[ci]] = ci < cells_in.size() ? cells_in[ci] : std::string();
        }
        rows_out->push_back(std::move(row));
    }
    return true;
}

bool has_column(const std::vector<std::string>& header, const char* name) {
    for (const auto& h : header) {
        if (h == name) return true;
    }
    return false;
}

std::string row_cell(const Row& row, const char* key) {
    auto it = row.find(key);
    return it == row.end() ? std::string() : trim(it->second);
}

bool parse_double(const std::string& raw, double* out) {
    const std::string s = trim(raw);
    if (s.empty()) return false;
    char* end = nullptr;
    const double v = strtod(s.c_str(), &end);
    if (end != s.c_str() + s.size()) return false;
    *out = v;
    return true;
}

// ---------------------------------------------------------------------------
// Frame IO helpers.
// ---------------------------------------------------------------------------

const plugin_input_frame_t* frame_at(const char* port, uint32_t ordinal) {
    const int32_t idx = plugin_find_input_index(port, ordinal);
    if (idx < 0) return nullptr;
    return plugin_get_input_frame(static_cast<uint32_t>(idx));
}

std::vector<const plugin_input_frame_t*> frames_on(const char* port) {
    std::vector<const plugin_input_frame_t*> out;
    for (uint32_t ordinal = 0;; ordinal++) {
        const plugin_input_frame_t* frame = frame_at(port, ordinal);
        if (!frame) break;
        out.push_back(frame);
    }
    return out;
}

std::string frame_text(const plugin_input_frame_t* frame) {
    if (!frame || !frame->payload || frame->payload_length == 0) return std::string();
    return std::string(reinterpret_cast<const char*>(frame->payload), frame->payload_length);
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

// The record streams declare their concrete SDS identity on the port, so the
// frame must carry it too (schema name, file identifier and root type).
int push_record_stream(const char* port, const char* schema, const char* identifier,
                       const char* root, const std::vector<uint8_t>& bytes) {
    return plugin_push_output_ex(port, schema, identifier, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 root, 0, 0, bytes.data(), static_cast<uint32_t>(bytes.size()));
}

void append_size_prefixed(std::vector<uint8_t>* stream, const std::vector<uint8_t>& record) {
    const uint32_t len = static_cast<uint32_t>(record.size());
    stream->push_back(static_cast<uint8_t>(len & 0xff));
    stream->push_back(static_cast<uint8_t>((len >> 8) & 0xff));
    stream->push_back(static_cast<uint8_t>((len >> 16) & 0xff));
    stream->push_back(static_cast<uint8_t>((len >> 24) & 0xff));
    stream->insert(stream->end(), record.begin(), record.end());
}

// A decoded hostcap/http-request response: the default JSON lane
// {status, headers, bodyB64} or the raw-body-v1 lane
// ("$HRB" + int32le status + body, no headers).
struct HttpResponse {
    long status = 0;
    std::string etag;
    std::string last_modified;
    std::string content_type;
    std::string date;
    std::vector<uint8_t> body;
};

void read_header(const std::string& headers, const char* lower_name, const char* title_name,
                 std::string* out) {
    if (json_string_field(headers, lower_name, out) && !out->empty()) return;
    json_string_field(headers, title_name, out);
}

bool decode_http_response(const plugin_input_frame_t* frame, HttpResponse* out, std::string* err) {
    if (!frame || !frame->payload || frame->payload_length == 0) {
        *err = "http response frame is empty.";
        return false;
    }
    const uint8_t* p = frame->payload;
    if (frame->payload_length >= 8 && p[0] == '$' && p[1] == 'H' && p[2] == 'R' && p[3] == 'B') {
        const uint32_t raw_status = static_cast<uint32_t>(p[4]) | (static_cast<uint32_t>(p[5]) << 8) |
                                    (static_cast<uint32_t>(p[6]) << 16) |
                                    (static_cast<uint32_t>(p[7]) << 24);
        out->status = static_cast<int32_t>(raw_status);
        out->body.assign(p + 8, p + frame->payload_length);
        return true;
    }
    const std::string json = frame_text(frame);
    double status = 0;
    if (!json_number_field(json, "status", &status)) {
        *err = "http response frame carries no status.";
        return false;
    }
    out->status = static_cast<long>(status);
    const std::string headers = json_object_slice(json, "headers");
    read_header(headers, "etag", "ETag", &out->etag);
    read_header(headers, "last-modified", "Last-Modified", &out->last_modified);
    read_header(headers, "content-type", "Content-Type", &out->content_type);
    read_header(headers, "date", "Date", &out->date);
    std::string body_b64;
    if (json_string_field(json, "bodyB64", &body_b64) && !body_b64.empty()) {
        if (!base64_decode(body_b64, &out->body)) {
            *err = "http response bodyB64 is not valid base64.";
            return false;
        }
    }
    return true;
}

int64_t retrieved_at_ms(const HttpResponse& response) {
    int64_t ms = 0;
    if (!response.date.empty() && parse_http_date(response.date, &ms)) return ms;
    return now_unix_ms();
}

// ---------------------------------------------------------------------------
// Ingest meta + provenance (storage.ingest_with_source contract).
// ---------------------------------------------------------------------------

struct Attribution {
    std::string provider_id;
    std::string source_name;
    std::string source_url;
    std::string origin_id;
    std::string dataset_id;
    std::string license_class;
    std::string license_url;
    std::string citation;
    std::string archive_source;
    std::string archive_name;
};

void read_attribution(const std::string& job, Attribution* out) {
    json_string_field(job, "provider_id", &out->provider_id);
    json_string_field(job, "source_name", &out->source_name);
    json_string_field(job, "source_url", &out->source_url);
    json_string_field(job, "origin_id", &out->origin_id);
    json_string_field(job, "dataset_id", &out->dataset_id);
    json_string_field(job, "license_class", &out->license_class);
    json_string_field(job, "license_url", &out->license_url);
    json_string_field(job, "citation", &out->citation);
    json_string_field(job, "archive_source", &out->archive_source);
    json_string_field(job, "archive_name", &out->archive_name);
}

const char* license_id_for(const std::string& license_class) {
    return license_class == "Historical" ? kLicenseIdHistorical : kLicenseIdRealTime;
}

wxfLicenseClass license_class_for(const std::string& license_class) {
    return license_class == "Historical" ? wxfLicenseClass_Historical
                                         : wxfLicenseClass_RealTimeExperimental;
}

wxfModelClass model_class_for(const std::string& name) {
    if (name == "MachineLearnedGlobalEnsemble") return wxfModelClass_MachineLearnedGlobalEnsemble;
    if (name == "NumericalGlobalEnsemble") return wxfModelClass_NumericalGlobalEnsemble;
    if (name == "NumericalGlobalDeterministic") return wxfModelClass_NumericalGlobalDeterministic;
    if (name == "NumericalRegional") return wxfModelClass_NumericalRegional;
    if (name == "Reanalysis") return wxfModelClass_Reanalysis;
    if (name == "Analysis") return wxfModelClass_Analysis;
    if (name == "Other") return wxfModelClass_Other;
    return wxfModelClass_Unspecified;
}

wxfMemberKind member_kind_for(const std::string& name) {
    if (name == "Control") return wxfMemberKind_Control;
    if (name == "Deterministic") return wxfMemberKind_Deterministic;
    if (name == "Mean") return wxfMemberKind_Mean;
    if (name == "Median") return wxfMemberKind_Median;
    if (name == "StandardDeviation") return wxfMemberKind_StandardDeviation;
    if (name == "Minimum") return wxfMemberKind_Minimum;
    if (name == "Maximum") return wxfMemberKind_Maximum;
    if (name == "Percentile") return wxfMemberKind_Percentile;
    if (name == "ProbabilityAboveThreshold") return wxfMemberKind_ProbabilityAboveThreshold;
    if (name == "ProbabilityBelowThreshold") return wxfMemberKind_ProbabilityBelowThreshold;
    return wxfMemberKind_Member;
}

wxfVariable variable_for_array(const std::string& array) {
    if (array == "low_cloud_cover") return wxfVariable_LowCloudCover;
    if (array == "medium_cloud_cover") return wxfVariable_MediumCloudCover;
    if (array == "high_cloud_cover") return wxfVariable_HighCloudCover;
    if (array == "total_cloud_cover") return wxfVariable_TotalCloudCover;
    return wxfVariable_Unspecified;
}

std::string build_provenance_json(const char* parser_version, const std::string& source_url,
                                  long status, const HttpResponse& response,
                                  const std::string& source_sha256,
                                  const std::string& normalized_sha256, int normalized_count,
                                  const std::string& schema_counts_json, int64_t retrieved_ms) {
    std::string out = std::string("{\"source_url\":\"") + json_escape(source_url) + "\"" +
                      ",\"http_status\":" + std::to_string(status);
    if (!response.etag.empty()) out += ",\"etag\":\"" + json_escape(response.etag) + "\"";
    if (!response.last_modified.empty())
        out += ",\"last_modified\":\"" + json_escape(response.last_modified) + "\"";
    if (!response.content_type.empty())
        out += ",\"content_type\":\"" + json_escape(response.content_type) + "\"";
    out += std::string(",\"retrieved_at\":\"") + format_iso_seconds(retrieved_ms) + "\"" +
           ",\"parser_version\":\"" + parser_version + "\"" +
           ",\"source_sha256\":\"" + source_sha256 + "\"" +
           ",\"normalized_sha256\":\"" + normalized_sha256 + "\"" +
           ",\"normalized_count\":" + std::to_string(normalized_count) +
           ",\"schema_counts\":" + schema_counts_json +
           ",\"warnings\":[],\"from_cache\":false}";
    return out;
}

std::string build_ingest_meta(const char* schema, const Attribution& attribution,
                              const std::string& source_url, const std::string& batch_id,
                              bool with_archive, const std::string& provenance_json) {
    std::string meta = std::string("{\"schema\":\"") + schema + "\"" +
                       ",\"provider_id\":\"" + json_escape(attribution.provider_id) + "\"" +
                       ",\"source_name\":\"" + json_escape(attribution.source_name) + "\"" +
                       ",\"source_url\":\"" + json_escape(source_url) + "\"" +
                       ",\"batch_id\":\"" + batch_id + "\"" +
                       ",\"content_key_id\":\"" + kContentKeyID + "\"" +
                       ",\"source_peer\":\"source:" + json_escape(attribution.origin_id) + "\"" +
                       ",\"reconcile\":\"duplicates\"" +
                       ",\"license\":\"" + license_id_for(attribution.license_class) + "\"" +
                       ",\"license_url\":\"" + json_escape(attribution.license_url) + "\"" +
                       ",\"citation\":\"" + json_escape(attribution.citation) + "\"";
    if (with_archive && !attribution.archive_source.empty() && !attribution.archive_name.empty()) {
        meta += ",\"archive\":{\"source\":\"" + json_escape(attribution.archive_source) +
                "\",\"name\":\"" + json_escape(attribution.archive_name) + "\"}";
    }
    meta += ",\"provenance\":{\"source\":\"" + json_escape(attribution.source_name) +
            "\",\"json\":\"" +
            base64_encode(reinterpret_cast<const uint8_t*>(provenance_json.data()),
                          provenance_json.size()) +
            "\"}}";
    return meta;
}

std::vector<uint8_t> finished_unprefixed(::flatbuffers::FlatBufferBuilder& fbb) {
    // The builder wrote [u32 size][record]; the stream re-prefixes, so strip
    // the four bytes (the identifier then sits at bytes 4..8 of the record).
    const uint8_t* p = fbb.GetBufferPointer();
    return std::vector<uint8_t>(p + 4, p + fbb.GetSize());
}

// ---------------------------------------------------------------------------
// Zarr chunk decode ("bytes" codec; float32 / float16 little endian).
// ---------------------------------------------------------------------------

float half_to_float(uint16_t half) {
    const double sign = (half & 0x8000) ? -1.0 : 1.0;
    const int exponent = (half >> 10) & 0x1f;
    const int mantissa = half & 0x03ff;
    if (exponent == 0) return static_cast<float>(sign * mantissa * std::ldexp(1.0, -24));
    if (exponent == 0x1f) {
        return mantissa == 0 ? static_cast<float>(sign * INFINITY) : NAN;
    }
    return static_cast<float>(sign * (1.0 + mantissa / 1024.0) * std::ldexp(1.0, exponent - 15));
}

struct ChunkJob {
    std::string json;
    Attribution attribution;
    std::string array;
    std::string model_id;
    std::string model_version;
    std::string model_class;
    std::string member_kind;
    int64_t init_time_ms = 0;
    double lead_hours = 0;
    double horizon_hours = 0;
    double member_index = 0;
    double ensemble_size = 0;
    std::string dtype;
    std::vector<std::string> codecs;
    std::vector<double> chunk_shape;
    std::vector<double> chunk_index;
    std::vector<std::string> dims;
    double lat0 = 0, lon0 = 0, dlat = 0, dlon = 0, nlat = 0, nlon = 0;
    bool periodic_lon = false;
};

bool read_chunk_job(const std::string& json, ChunkJob* job, std::string* err) {
    job->json = json;
    read_attribution(json, &job->attribution);
    json_string_field(json, "array", &job->array);
    json_string_field(json, "model_id", &job->model_id);
    json_string_field(json, "model_version", &job->model_version);
    json_string_field(json, "model_class", &job->model_class);
    json_string_field(json, "member_kind", &job->member_kind);
    if (job->member_kind.empty()) job->member_kind = "Member";
    double v = 0;
    if (!json_number_field(json, "init_time_ms", &v)) { *err = "job carries no init_time_ms"; return false; }
    job->init_time_ms = static_cast<int64_t>(v);
    if (!json_number_field(json, "lead_hours", &job->lead_hours)) { *err = "job carries no lead_hours"; return false; }
    json_number_field(json, "horizon_hours", &job->horizon_hours);
    json_number_field(json, "member_index", &job->member_index);
    json_number_field(json, "ensemble_size", &job->ensemble_size);
    json_string_field(json, "dtype", &job->dtype);
    if (job->dtype.empty()) job->dtype = "float32";
    job->codecs = json_string_array(json_array_slice(json, "codecs"));
    job->chunk_shape = json_number_array(json_array_slice(json, "chunk_shape"));
    job->chunk_index = json_number_array(json_array_slice(json, "chunk_index"));
    job->dims = json_string_array(json_array_slice(json, "dims"));
    const std::string grid = json_object_slice(json, "grid");
    if (grid.empty()) { *err = "job carries no grid"; return false; }
    json_number_field(grid, "lat0", &job->lat0);
    json_number_field(grid, "lon0", &job->lon0);
    json_number_field(grid, "dlat", &job->dlat);
    json_number_field(grid, "dlon", &job->dlon);
    json_number_field(grid, "nlat", &job->nlat);
    json_number_field(grid, "nlon", &job->nlon);
    json_bool_field(grid, "periodic_lon", &job->periodic_lon);
    if (job->array.empty()) { *err = "job carries no array name"; return false; }
    if (job->chunk_shape.empty() || job->chunk_shape.size() != job->chunk_index.size() ||
        job->chunk_shape.size() != job->dims.size()) {
        *err = "job chunk_shape, chunk_index and dims must have the same length";
        return false;
    }
    if (job->nlat <= 0 || job->nlon <= 0) { *err = "job grid nlat/nlon must be positive"; return false; }
    return true;
}

std::string lead_label(double lead_hours) { return format_number(lead_hours) + "h"; }

// One tile: NLAT x NLON real cells cut from the chunk (padding past the grid
// edge dropped), statistics over the non-missing cells.
struct Tile {
    std::vector<float> values;
    uint32_t nlat = 0, nlon = 0;
    double lat0 = 0, lon0 = 0;
    uint32_t tile_index = 0, tile_count = 0;
    float value_min = 0, value_max = 0;
    uint32_t missing = 0;
    bool periodic_lon = false;
};

// Decodes the chunk body and cuts the tile; sets the error code on failure.
bool decode_tile(const ChunkJob& job, const std::vector<uint8_t>& body, Tile* tile,
                 std::string* code, std::string* message) {
    if (job.codecs.empty() || job.codecs[0] != "bytes") {
        *code = "codec-unsupported";
        *message = "codec chain must start with \"bytes\"; declared: " +
                   (job.codecs.empty() ? std::string("(none)") : job.codecs[0]);
        return false;
    }
    for (size_t i = job.codecs.size(); i-- > 1;) {
        *code = "codec-unsupported";
        *message = "codec \"" + job.codecs[i] + "\" is not decoded by this build" +
                   (job.codecs[i] == "zstd" ? " (zstd decoder vendoring is a documented follow-up; the reference parser decodes it)" : "");
        return false;
    }
    size_t item_size = 0;
    if (job.dtype == "float32") item_size = 4;
    else if (job.dtype == "float16") item_size = 2;
    else {
        *code = "dtype-unsupported";
        *message = "chunk data type \"" + job.dtype + "\" is not float32 or float16";
        return false;
    }
    uint64_t cells = 1;
    for (const double dim : job.chunk_shape) {
        if (dim < 1) { *code = "chunk-shape-invalid"; *message = "chunk_shape holds a non-positive extent"; return false; }
        cells *= static_cast<uint64_t>(dim);
    }
    if (body.size() != cells * item_size) {
        *code = "chunk-size-mismatch";
        *message = "decoded " + std::to_string(body.size()) + " bytes, expected " +
                   std::to_string(cells) + " x " + std::to_string(item_size);
        return false;
    }
    std::vector<float> all(static_cast<size_t>(cells));
    if (item_size == 4) {
        for (size_t i = 0; i < cells; i++) {
            uint32_t bits = static_cast<uint32_t>(body[i * 4]) | (static_cast<uint32_t>(body[i * 4 + 1]) << 8) |
                            (static_cast<uint32_t>(body[i * 4 + 2]) << 16) |
                            (static_cast<uint32_t>(body[i * 4 + 3]) << 24);
            float f;
            std::memcpy(&f, &bits, 4);
            all[i] = f;
        }
    } else {
        for (size_t i = 0; i < cells; i++) {
            const uint16_t half = static_cast<uint16_t>(body[i * 2] | (body[i * 2 + 1] << 8));
            all[i] = half_to_float(half);
        }
    }

    int lat_dim = -1, lon_dim = -1;
    for (size_t i = 0; i < job.dims.size(); i++) {
        if (job.dims[i] == "latitude") lat_dim = static_cast<int>(i);
        if (job.dims[i] == "longitude") lon_dim = static_cast<int>(i);
    }
    if (lat_dim < 0 || lon_dim < 0) {
        *code = "dims-invalid";
        *message = "dims must name latitude and longitude";
        return false;
    }
    const uint64_t chunk_lat = static_cast<uint64_t>(job.chunk_shape[lat_dim]);
    const uint64_t chunk_lon = static_cast<uint64_t>(job.chunk_shape[lon_dim]);
    const uint64_t i0 = static_cast<uint64_t>(job.chunk_index[lat_dim]) * chunk_lat;
    const uint64_t j0 = static_cast<uint64_t>(job.chunk_index[lon_dim]) * chunk_lon;
    const uint64_t grid_nlat = static_cast<uint64_t>(job.nlat);
    const uint64_t grid_nlon = static_cast<uint64_t>(job.nlon);
    if (i0 >= grid_nlat || j0 >= grid_nlon) {
        *code = "chunk-index-invalid";
        *message = "chunk index lies outside the declared grid";
        return false;
    }
    const uint64_t nlat = std::min<uint64_t>(chunk_lat, grid_nlat - i0);
    const uint64_t nlon = std::min<uint64_t>(chunk_lon, grid_nlon - j0);
    if (nlat * nlon > kMaxInlineCells) {
        *code = "tile-too-large";
        *message = "tile exceeds the inline cell limit";
        return false;
    }
    const uint64_t lat_stride = lat_dim < lon_dim ? chunk_lon : 1;
    const uint64_t lon_stride = lat_dim < lon_dim ? 1 : chunk_lat;
    tile->values.assign(static_cast<size_t>(nlat * nlon), 0.0f);
    float vmin = INFINITY, vmax = -INFINITY;
    uint32_t missing = 0;
    for (uint64_t li = 0; li < nlat; li++) {
        for (uint64_t lj = 0; lj < nlon; lj++) {
            const float v = all[static_cast<size_t>(li * lat_stride + lj * lon_stride)];
            tile->values[static_cast<size_t>(li * nlon + lj)] = v;
            if (std::isnan(v)) missing++;
            else {
                if (v < vmin) vmin = v;
                if (v > vmax) vmax = v;
            }
        }
    }
    if (missing == nlat * nlon) { vmin = 0; vmax = 0; }
    const uint64_t tiles_per_row = (grid_nlon + chunk_lon - 1) / chunk_lon;
    const uint64_t tile_rows = (grid_nlat + chunk_lat - 1) / chunk_lat;
    tile->nlat = static_cast<uint32_t>(nlat);
    tile->nlon = static_cast<uint32_t>(nlon);
    tile->lat0 = job.lat0 + static_cast<double>(i0) * job.dlat;
    tile->lon0 = job.lon0 + static_cast<double>(j0) * job.dlon;
    tile->tile_index = static_cast<uint32_t>(static_cast<uint64_t>(job.chunk_index[lat_dim]) * tiles_per_row +
                                             static_cast<uint64_t>(job.chunk_index[lon_dim]));
    tile->tile_count = static_cast<uint32_t>(tile_rows * tiles_per_row);
    tile->value_min = vmin;
    tile->value_max = vmax;
    tile->missing = missing;
    tile->periodic_lon = job.periodic_lon && nlon == grid_nlon;
    return true;
}

std::vector<uint8_t> build_wxf_record(const ChunkJob& job, const Tile& tile, int64_t retrieved_ms) {
    ::flatbuffers::FlatBufferBuilder fbb(1024 + tile.values.size() * 4);
    const std::string field_id = job.model_id + "|" + format_iso_seconds(job.init_time_ms) + "|" +
                                 job.member_kind + format_number(job.member_index) + "|" + job.array +
                                 "|" + lead_label(job.lead_hours);
    const auto field_id_off = fbb.CreateString(field_id);
    const auto model_id_off = fbb.CreateString(job.model_id);
    const auto model_version_off = fbb.CreateString(job.model_version);
    const auto variable_name_off = fbb.CreateString(job.array);
    const auto units_off = fbb.CreateString("1");
    const auto values_off = fbb.CreateVector<float>(tile.values.data(), tile.values.size());
    const auto origin_off = fbb.CreateString(job.attribution.origin_id);
    const auto dataset_off = fbb.CreateString(job.attribution.dataset_id);
    const auto source_url_off = fbb.CreateString(job.attribution.source_url);
    const auto license_url_off = fbb.CreateString(job.attribution.license_url);
    const auto citation_off = fbb.CreateString(job.attribution.citation);
    const auto peer_off = fbb.CreateString("");

    WXFGridBuilder grid(fbb);
    grid.add_KIND(wxfGridKind_RegularLatLon);
    grid.add_LAT0(tile.lat0);
    grid.add_LON0(tile.lon0);
    grid.add_DLAT(job.dlat);
    grid.add_DLON(job.dlon);
    grid.add_NLAT(tile.nlat);
    grid.add_NLON(tile.nlon);
    grid.add_PERIODIC_LON(tile.periodic_lon);
    const auto grid_off = grid.Finish();

    const uint64_t valid_ms = static_cast<uint64_t>(job.init_time_ms) +
                              static_cast<uint64_t>(std::llround(job.lead_hours * 3600000.0));

    WXFBuilder b(fbb);
    b.add_FIELD_ID(field_id_off);
    b.add_MODEL_CLASS(model_class_for(job.model_class));
    b.add_MODEL_ID(model_id_off);
    b.add_MODEL_VERSION(model_version_off);
    b.add_INIT_TIME_MS(static_cast<uint64_t>(job.init_time_ms));
    b.add_LEAD_HOURS(static_cast<float>(job.lead_hours));
    b.add_VALID_TIME_MS(valid_ms);
    b.add_HORIZON_HOURS(static_cast<uint16_t>(job.horizon_hours));
    b.add_MEMBER_KIND(member_kind_for(job.member_kind));
    b.add_MEMBER_INDEX(static_cast<uint16_t>(job.member_index));
    b.add_ENSEMBLE_SIZE(static_cast<uint16_t>(job.ensemble_size));
    b.add_VARIABLE(variable_for_array(job.array));
    b.add_VARIABLE_NAME(variable_name_off);
    b.add_UNITS(units_off);
    b.add_LEVEL_KIND(wxfLevelKind_EntireAtmosphere);
    b.add_LEVEL_VALUE(0.0f);
    b.add_TEMPORAL_KIND(wxfTemporalKind_Instantaneous);
    b.add_ACCUMULATION_HOURS(0.0f);
    b.add_GRID(grid_off);
    b.add_TILE_INDEX(tile.tile_index);
    b.add_TILE_COUNT(tile.tile_count);
    b.add_VALUES_ENCODING(wxfValuesEncoding_InlineFloat32);
    b.add_VALUES(values_off);
    b.add_VALUE_MIN(tile.value_min);
    b.add_VALUE_MAX(tile.value_max);
    b.add_MISSING_COUNT(tile.missing);
    b.add_ORIGIN_ID(origin_off);
    b.add_DATASET_ID(dataset_off);
    b.add_SOURCE_URL(source_url_off);
    b.add_RETRIEVED_AT(static_cast<uint64_t>(retrieved_ms));
    b.add_LICENSE_CLASS(license_class_for(job.attribution.license_class));
    b.add_LICENSE_URL(license_url_off);
    b.add_CITATION(citation_off);
    b.add_PRODUCER_PEER_ID(peer_off);
    const auto root = b.Finish();
    FinishSizePrefixedWXFBuffer(fbb, root);
    return finished_unprefixed(fbb);
}

// Longest common prefix of the chunk URLs cut back to the last '/', or the
// single URL itself: the meta's source_url names the store the batch came from.
std::string common_source_url(const std::vector<ChunkJob>& jobs) {
    if (jobs.size() == 1) return jobs[0].attribution.source_url;
    std::string prefix = jobs[0].attribution.source_url;
    for (const ChunkJob& job : jobs) {
        const std::string& url = job.attribution.source_url;
        size_t k = 0;
        while (k < prefix.size() && k < url.size() && prefix[k] == url[k]) k++;
        prefix.resize(k);
    }
    const size_t slash = prefix.rfind('/');
    return slash == std::string::npos ? prefix : prefix.substr(0, slash + 1);
}

// ---------------------------------------------------------------------------
// Cyclone tracks.
// ---------------------------------------------------------------------------

tctBasin basin_for(const std::string& code) {
    const std::string c = upper(trim(code));
    if (c == "NA") return tctBasin_NorthAtlantic;
    if (c == "EP") return tctBasin_EastPacific;
    if (c == "CP") return tctBasin_CentralPacific;
    if (c == "WP") return tctBasin_WestPacific;
    if (c == "NI") return tctBasin_NorthIndian;
    if (c == "SI") return tctBasin_SouthIndian;
    if (c == "SP") return tctBasin_SouthPacific;
    if (c == "SA") return tctBasin_SouthAtlantic;
    return tctBasin_Other;
}

tctIntensityCategory category_for(float vmax_ms) {
    if (vmax_ms < 17) return tctIntensityCategory_TropicalDepression;
    if (vmax_ms < 33) return tctIntensityCategory_TropicalStorm;
    if (vmax_ms < 43) return tctIntensityCategory_Category1;
    if (vmax_ms < 50) return tctIntensityCategory_Category2;
    if (vmax_ms < 58) return tctIntensityCategory_Category3;
    if (vmax_ms < 70) return tctIntensityCategory_Category4;
    return tctIntensityCategory_Category5;
}

double normalise_longitude(double lon) {
    double v = lon;
    while (v >= 180) v -= 360;
    while (v < -180) v += 360;
    return v;
}

// Blank -> -1 (not reported); otherwise the value scaled, rounded to float.
float scaled_or_negative(const std::string& cell, double scale, bool* ok) {
    const std::string s = trim(cell);
    if (s.empty()) return -1.0f;
    double v = 0;
    if (!parse_double(s, &v)) { *ok = false; return -1.0f; }
    return static_cast<float>(v * scale);
}

struct CyclonePoint {
    int64_t valid_ms = 0;
    const Row* row = nullptr;
};

bool build_point(::flatbuffers::FlatBufferBuilder& fbb, const Row& row, int64_t valid_ms,
                 ::flatbuffers::Offset<TCTPoint>* out, std::string* err) {
    double lead = 0, lat = 0, lon = 0, vmax_kt = 0, pmin_hpa = 0;
    if (!parse_double(row_cell(row, "lead_hours"), &lead)) { *err = "malformed or missing lead_hours"; return false; }
    if (!parse_double(row_cell(row, "latitude"), &lat)) { *err = "malformed or missing latitude"; return false; }
    if (!parse_double(row_cell(row, "longitude"), &lon)) { *err = "malformed or missing longitude"; return false; }
    if (!parse_double(row_cell(row, "max_sustained_wind_kt"), &vmax_kt)) { *err = "malformed or missing max_sustained_wind_kt"; return false; }
    if (!parse_double(row_cell(row, "min_central_pressure_hpa"), &pmin_hpa)) { *err = "malformed or missing min_central_pressure_hpa"; return false; }
    bool ok = true;
    const float vmax_ms = static_cast<float>(vmax_kt * 1852.0 / 3600.0);
    const float rmw_km = scaled_or_negative(row_cell(row, "radius_max_wind_nmi"), kNmiToKm, &ok);

    static const int kThresholds[3] = {34, 50, 64};
    std::vector<::flatbuffers::Offset<TCTRadii>> radii;
    for (const int kt : kThresholds) {
        const std::string prefix = "r" + std::to_string(kt) + "_";
        const float ne = scaled_or_negative(row_cell(row, (prefix + "ne_nmi").c_str()), kNmiToKm, &ok);
        const float se = scaled_or_negative(row_cell(row, (prefix + "se_nmi").c_str()), kNmiToKm, &ok);
        const float sw = scaled_or_negative(row_cell(row, (prefix + "sw_nmi").c_str()), kNmiToKm, &ok);
        const float nw = scaled_or_negative(row_cell(row, (prefix + "nw_nmi").c_str()), kNmiToKm, &ok);
        TCTRadiiBuilder rb(fbb);
        rb.add_THRESHOLD_WIND_MS(static_cast<float>(kt * 1852.0 / 3600.0));
        rb.add_NE_KM(ne);
        rb.add_SE_KM(se);
        rb.add_SW_KM(sw);
        rb.add_NW_KM(nw);
        radii.push_back(rb.Finish());
    }
    if (!ok) { *err = "malformed wind radius cell"; return false; }
    const auto radii_off = fbb.CreateVector(radii);

    float existence = 1.0f;
    {
        const std::string cell = row_cell(row, "existence_probability");
        double v = 0;
        if (!cell.empty()) {
            if (!parse_double(cell, &v)) { *err = "malformed existence_probability"; return false; }
            existence = static_cast<float>(v);
        }
    }

    TCTPointBuilder pb(fbb);
    pb.add_VALID_TIME_MS(static_cast<uint64_t>(valid_ms));
    pb.add_LEAD_HOURS(static_cast<float>(lead));
    pb.add_LATITUDE(lat);
    pb.add_LONGITUDE(normalise_longitude(lon));
    pb.add_MAX_SUSTAINED_WIND_MS(vmax_ms);
    pb.add_MIN_CENTRAL_PRESSURE_PA(static_cast<float>(pmin_hpa * 100.0));
    pb.add_RADIUS_MAX_WIND_KM(rmw_km);
    pb.add_RADII(radii_off);
    pb.add_CATEGORY(category_for(vmax_ms));
    pb.add_EXISTENCE_PROBABILITY(existence);
    pb.add_MOTION_DIRECTION_DEG(-1.0f);
    pb.add_MOTION_SPEED_MS(-1.0f);
    *out = pb.Finish();
    return true;
}

struct CycloneJob {
    Attribution attribution;
    std::string model_id;
    std::string model_version;
    std::string model_class;
    double ensemble_size = 0;
    double wind_averaging_period_s = 0;
};

bool build_tct_record(const CycloneJob& job, std::vector<CyclonePoint>& points, int64_t retrieved_ms,
                      std::vector<uint8_t>* out, std::string* err) {
    std::stable_sort(points.begin(), points.end(),
                     [](const CyclonePoint& a, const CyclonePoint& b) { return a.valid_ms < b.valid_ms; });
    const Row& first = *points[0].row;
    int64_t init_ms = 0;
    if (!parse_iso_ms(row_cell(first, "init_time"), &init_ms)) { *err = "malformed init_time"; return false; }
    double member = 0;
    if (!parse_double(row_cell(first, "member"), &member)) { *err = "malformed member"; return false; }

    ::flatbuffers::FlatBufferBuilder fbb(2048);
    const auto storm_id_off = fbb.CreateString(row_cell(first, "storm_id"));
    const auto storm_name_off = fbb.CreateString(row_cell(first, "storm_name"));
    const auto model_id_off = fbb.CreateString(job.model_id);
    const auto model_version_off = fbb.CreateString(job.model_version);
    std::vector<::flatbuffers::Offset<TCTPoint>> point_offs;
    point_offs.reserve(points.size());
    for (const CyclonePoint& point : points) {
        ::flatbuffers::Offset<TCTPoint> off;
        if (!build_point(fbb, *point.row, point.valid_ms, &off, err)) return false;
        point_offs.push_back(off);
    }
    const auto points_off = fbb.CreateVector(point_offs);
    const auto origin_off = fbb.CreateString(job.attribution.origin_id);
    const auto dataset_off = fbb.CreateString(job.attribution.dataset_id);
    const auto source_url_off = fbb.CreateString(job.attribution.source_url);
    const auto license_url_off = fbb.CreateString(job.attribution.license_url);
    const auto citation_off = fbb.CreateString(job.attribution.citation);
    const auto peer_off = fbb.CreateString("");

    TCTBuilder b(fbb);
    b.add_STORM_ID(storm_id_off);
    b.add_STORM_NAME(storm_name_off);
    b.add_BASIN(basin_for(row_cell(first, "basin")));
    b.add_TRACK_KIND(tctTrackKind_Forecast);
    b.add_TRACK_ORIGIN(lower(row_cell(first, "track_origin")) == "genesis" ? tctTrackOrigin_Genesis
                                                                            : tctTrackOrigin_ExistingSystem);
    b.add_MODEL_CLASS(model_class_for(job.model_class));
    b.add_MODEL_ID(model_id_off);
    b.add_MODEL_VERSION(model_version_off);
    b.add_INIT_TIME_MS(static_cast<uint64_t>(init_ms));
    b.add_MEMBER_KIND(wxfMemberKind_Member);
    b.add_MEMBER_INDEX(static_cast<uint16_t>(member));
    b.add_ENSEMBLE_SIZE(static_cast<uint16_t>(job.ensemble_size));
    b.add_WIND_AVERAGING_PERIOD_S(static_cast<uint16_t>(job.wind_averaging_period_s));
    b.add_POINTS(points_off);
    b.add_ORIGIN_ID(origin_off);
    b.add_DATASET_ID(dataset_off);
    b.add_SOURCE_URL(source_url_off);
    b.add_RETRIEVED_AT(static_cast<uint64_t>(retrieved_ms));
    b.add_LICENSE_CLASS(license_class_for(job.attribution.license_class));
    b.add_LICENSE_URL(license_url_off);
    b.add_CITATION(citation_off);
    b.add_PRODUCER_PEER_ID(peer_off);
    const auto root = b.Finish();
    FinishSizePrefixedTCTBuffer(fbb, root);
    *out = finished_unprefixed(fbb);
    return true;
}

// ---------------------------------------------------------------------------
// SURPLUS-FRAME REFUSAL — graph task `modules-guest-nodes-drop-batched-frames`.
// The compiled runtime drains a node's queue PORT-BLIND up to a budget of 64;
// maxStreams is declarative. parse_cyclone_tracks pairs ONE job with ONE
// response, so a surplus on either port is refused by name rather than
// silently discarded (a partial answer is indistinguishable from an honest
// one). parse_cloud_chunks is multi-stream by contract and pairs by position.
// ---------------------------------------------------------------------------
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

// parse_cloud_chunks: jobs[k] + responses[k] -> $WXF tiles + ingest meta.
int parse_cloud_chunks(void) {
    const std::vector<const plugin_input_frame_t*> job_frames = frames_on("jobs");
    const std::vector<const plugin_input_frame_t*> response_frames = frames_on("responses");
    if (job_frames.empty()) {
        plugin_set_error("missing-job-frame", "parse_cloud_chunks requires at least one chunk job frame.");
        return 400;
    }
    if (job_frames.size() != response_frames.size()) {
        std::string msg = "parse_cloud_chunks received " + std::to_string(job_frames.size()) +
                          " job frames but " + std::to_string(response_frames.size()) +
                          " response frames; jobs and responses pair by position, so a mismatch "
                          "cannot be attributed and is refused.";
        plugin_set_error("job-response-count-mismatch", msg.c_str());
        return 400;
    }

    std::vector<ChunkJob> jobs(job_frames.size());
    std::vector<HttpResponse> responses(response_frames.size());
    for (size_t k = 0; k < job_frames.size(); k++) {
        std::string err;
        if (!read_chunk_job(frame_text(job_frames[k]), &jobs[k], &err)) {
            plugin_set_error("invalid-chunk-job", ("chunk job " + std::to_string(k) + ": " + err).c_str());
            return 400;
        }
        if (!decode_http_response(response_frames[k], &responses[k], &err)) {
            plugin_set_error("invalid-response-frame", ("chunk " + std::to_string(k) + ": " + err).c_str());
            return 400;
        }
        if (responses[k].status != 200) {
            std::string msg = "chunk " + std::to_string(k) + " (" + jobs[k].attribution.source_url +
                              ") fetch returned HTTP status " + std::to_string(responses[k].status);
            plugin_set_error("fetch-failed", msg.c_str());
            return 502;
        }
    }

    Sha256 batch;
    Sha256 normalized;
    std::vector<uint8_t> stream;
    int count = 0;
    for (size_t k = 0; k < jobs.size(); k++) {
        batch.update(responses[k].body.data(), responses[k].body.size());
        Tile tile;
        std::string code, message;
        if (!decode_tile(jobs[k], responses[k].body, &tile, &code, &message)) {
            plugin_set_error(code.c_str(), ("chunk " + std::to_string(k) + ": " + message).c_str());
            return 422;
        }
        const std::vector<uint8_t> record = build_wxf_record(jobs[k], tile, retrieved_at_ms(responses[k]));
        append_size_prefixed(&stream, record);
        normalized_hash_record(&normalized, "WXF.fbs", record);
        count++;
    }

    const std::string batch_id = batch.hex_digest();
    const std::string source_url = common_source_url(jobs);
    const std::string provenance = build_provenance_json(
        kParserVersionClouds, source_url, 200, responses[0], batch_id, normalized.hex_digest(), count,
        "{\"WXF.fbs\":" + std::to_string(count) + "}", retrieved_at_ms(responses[0]));
    const std::string meta = build_ingest_meta("WXF.fbs", jobs[0].attribution, source_url, batch_id,
                                               /*with_archive=*/false, provenance);
    if (push_json("wxf_meta", meta) < 0) return 500;
    if (push_record_stream("wxf_records", "WXF.fbs", "$WXF", "WXF", stream) < 0) return 500;
    return 0;
}

// parse_cyclone_tracks: cyclone CSV -> $TCT per (storm, member) + meta + raw.
int parse_cyclone_tracks(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    const std::string job_json = frame_text(frame_at("job", 0));
    if (job_json.empty()) {
        plugin_set_error("missing-job-frame", "parse_cyclone_tracks requires the job JSON frame.");
        return 400;
    }
    HttpResponse response;
    std::string err;
    if (!decode_http_response(frame_at("response", 0), &response, &err)) {
        plugin_set_error("missing-response-frame", err.c_str());
        return 400;
    }
    if (response.status != 200) {
        plugin_set_error("fetch-failed",
                         ("cyclone track fetch returned HTTP status " + std::to_string(response.status)).c_str());
        return 502;
    }

    CycloneJob job;
    read_attribution(job_json, &job.attribution);
    json_string_field(job_json, "model_id", &job.model_id);
    json_string_field(job_json, "model_version", &job.model_version);
    json_string_field(job_json, "model_class", &job.model_class);
    json_number_field(job_json, "ensemble_size", &job.ensemble_size);
    json_number_field(job_json, "wind_averaging_period_s", &job.wind_averaging_period_s);
    if (job.attribution.source_name.empty()) {
        plugin_set_error("missing-source-name", "job must carry source_name.");
        return 400;
    }

    std::vector<Row> rows;
    std::vector<std::string> header;
    if (!parse_csv(response.body, &rows, &header, &err)) {
        plugin_set_error("cyclone-parse-failed", err.c_str());
        return 422;
    }
    for (const char* column : {"storm_id", "member", "valid_time", "latitude", "longitude", "max_sustained_wind_kt"}) {
        if (!has_column(header, column)) {
            plugin_set_error("cyclone-parse-failed",
                             (std::string("cyclone CSV is missing required column ") + column).c_str());
            return 422;
        }
    }

    // Group by (storm_id, member) in FIRST-APPEARANCE order.
    std::vector<std::string> order;
    std::map<std::string, std::vector<CyclonePoint>> groups;
    for (const Row& row : rows) {
        const std::string storm_id = row_cell(row, "storm_id");
        if (storm_id.empty()) continue;
        double member = 0;
        if (!parse_double(row_cell(row, "member"), &member)) {
            plugin_set_error("cyclone-parse-failed", ("malformed member for storm " + storm_id).c_str());
            return 422;
        }
        int64_t valid_ms = 0;
        if (!parse_iso_ms(row_cell(row, "valid_time"), &valid_ms)) {
            plugin_set_error("cyclone-parse-failed", ("malformed valid_time for storm " + storm_id).c_str());
            return 422;
        }
        const std::string key = storm_id + "|" + format_number(member);
        if (groups.find(key) == groups.end()) order.push_back(key);
        CyclonePoint point;
        point.valid_ms = valid_ms;
        point.row = &row;
        groups[key].push_back(point);
    }
    if (order.empty()) {
        plugin_set_error("cyclone-parse-failed", "no cyclone track rows parsed");
        return 422;
    }

    const int64_t retrieved_ms = retrieved_at_ms(response);
    Sha256 normalized;
    std::vector<uint8_t> stream;
    int count = 0;
    for (const std::string& key : order) {
        std::vector<uint8_t> record;
        if (!build_tct_record(job, groups[key], retrieved_ms, &record, &err)) {
            plugin_set_error("cyclone-parse-failed", (key + ": " + err).c_str());
            return 422;
        }
        append_size_prefixed(&stream, record);
        normalized_hash_record(&normalized, "TCT.fbs", record);
        count++;
    }

    Sha256 batch;
    batch.update(response.body.data(), response.body.size());
    const std::string batch_id = batch.hex_digest();
    const std::string provenance = build_provenance_json(
        kParserVersionCyclones, job.attribution.source_url, response.status, response, batch_id,
        normalized.hex_digest(), count, "{\"TCT.fbs\":" + std::to_string(count) + "}", retrieved_ms);
    const std::string meta = build_ingest_meta("TCT.fbs", job.attribution, job.attribution.source_url,
                                               batch_id, /*with_archive=*/true, provenance);
    if (push_json("tct_meta", meta) < 0) return 500;
    if (push_record_stream("tct_records", "TCT.fbs", "$TCT", "TCT", stream) < 0) return 500;
    if (push_bytes("raw", response.body) < 0) return 500;
    return 0;
}

}  // extern "C"
