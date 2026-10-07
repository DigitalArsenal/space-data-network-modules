/*
 * data-source/nwp-grib2-parser.
 *
 * A pure parser flow node (capabilities: none) for numerical-weather-prediction model fields in GRIB2 (NOAA/NCEP GFS
 * and GEFS from NOAA Open Data Dissemination's public buckets, fetched message by message through the .idx inventory):
 * each instantaneous field becomes $WXF record(s) carrying the GRIB2 packing's own integers - value = (R + X 2^E) /
 * 10^D, so SCALE_FACTOR = 2^E / 10^D and ADD_OFFSET = R / 10^D (times 1/100 for a percentage, the fraction $WXF
 * defines) - exactly, delta/zigzag/shuffle coded (InlineEncodedChunk). Rows south to north, longitude from 0 east,
 * every `stride`-th point (GEFS 0.5 deg spread at the 1 deg points), whole or in `band_rows` bands. Raw: nothing is
 * resampled or derived (owner 2026-10-02: SDN carries raw feeds; the display derives).
 *
 * GRIB2 is read by grib2mini (vendored; grid 3.0, product 4.0/4.1/4.2, packing 5.0/5.2/5.3, bitmaps), checked against
 * ecCodes on NOAA's own files. Interval statistics (4.8/4.11/4.12), other grids or packings, parameters it does not map
 * and integers wider than 16 bits are refused by name.
 *
 * Method:
 *   parse : jobs[k] + responses[k] -> wxf_meta + wxf_records
 *       Paired by position; each response is whole GRIB2 messages of one byte range. One batch per invocation.
 */
#include <algorithm>
#include <cctype>
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
constexpr const char* kParserVersion = "nwp-grib2-parser/v1";

// ---------------------------------------------------------------------------
// String / JSON / base64 / SHA-256 / date helpers, frame IO and the hostcap/http-request response decoder: the same
// code as data-source/weathernext-parser (control metadata only; record bodies never pass through JSON).
// ---------------------------------------------------------------------------


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


std::string build_ingest_meta(const char* schema, const Attribution& attribution, const std::string& license_id,
                              const std::string& source_url, const std::string& batch_id,
                              const std::string& provenance_json) {
    return std::string("{\"schema\":\"") + schema + "\"" +
           ",\"provider_id\":\"" + json_escape(attribution.provider_id) + "\"" +
           ",\"source_name\":\"" + json_escape(attribution.source_name) + "\"" +
           ",\"source_url\":\"" + json_escape(source_url) + "\"" +
           ",\"batch_id\":\"" + batch_id + "\"" +
           ",\"content_key_id\":\"" + kContentKeyID + "\"" +
           ",\"source_peer\":\"source:" + json_escape(attribution.origin_id) + "\"" +
           ",\"reconcile\":\"duplicates\"" +
           ",\"license\":\"" + json_escape(license_id) + "\"" +
           ",\"license_url\":\"" + json_escape(attribution.license_url) + "\"" +
           ",\"citation\":\"" + json_escape(attribution.citation) + "\"" +
           ",\"provenance\":{\"source\":\"" + json_escape(attribution.source_name) + "\",\"json\":\"" +
           base64_encode(reinterpret_cast<const uint8_t*>(provenance_json.data()), provenance_json.size()) + "\"}}";
}

std::vector<uint8_t> finished_unprefixed(::flatbuffers::FlatBufferBuilder& fbb) {
    // The builder wrote [u32 size][record]; the stream re-prefixes, so strip
    // the four bytes (the identifier then sits at bytes 4..8 of the record).
    const uint8_t* p = fbb.GetBufferPointer();
    return std::vector<uint8_t>(p + 4, p + fbb.GetSize());
}

// CHUNK_CODECS ["delta", "zigzag", "shuffle"] over uint16 codes (SDS 1.238 InlineEncodedChunk).
std::vector<uint8_t> encode_chunk_u16(const std::vector<uint16_t>& codes) {
    const size_t n = codes.size();
    std::vector<uint8_t> out(n * 2);
    uint16_t prev = 0;
    for (size_t i = 0; i < n; i++) {
        const int16_t d = static_cast<int16_t>(static_cast<uint16_t>(i ? codes[i] - prev : codes[i]));
        prev = codes[i];
        const uint16_t z = static_cast<uint16_t>(d >= 0 ? 2 * int32_t(d) : -2 * int32_t(d) - 1);
        out[i] = static_cast<uint8_t>(z & 0xff);
        out[n + i] = static_cast<uint8_t>(z >> 8);
    }
    return out;
}

// ---------------------------------------------------------------------------
// GRIB2 parameter + level -> the record's name, SDS variable and level, units and unit factor (as the reference
// encoders name them: Cesium_Weather tools/fetch-motion-wxf.mjs, fetch-model-clouds-wxf.mjs, src/voxel/
// atmosphereColumns.js). The factor turns the field's units into the record's (percent -> the fraction $WXF defines).
// ---------------------------------------------------------------------------

struct Mapped {
    std::string name;
    wxfVariable variable = wxfVariable_Unspecified;
    wxfLevelKind level = wxfLevelKind_Surface;
    float level_value = 0;     // Pa (pressure levels), m (heights above ground)
    const char* units = "";
    double factor = 1;
};

std::string format_level_number(double v) {
    char buf[32];
    if (v == std::floor(v)) std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(v));
    else std::snprintf(buf, sizeof(buf), "%g", v);
    return buf;
}

// false: a parameter / level this parser does not publish (refused by name, never guessed)
bool map_field(const grib2mini::Message& m, Mapped* out, std::string* why) {
    const int d = m.discipline, c = m.category, n = m.number, lt = m.levelType;
    const double lv = double(m.levelValue) / std::pow(10.0, m.levelScale);
    struct Quantity { int d, c, n; const char* stem; wxfVariable variable; const char* units; double factor; };
    static const Quantity kQuantities[] = {
        {0, 0, 0, "air_temperature", wxfVariable_Temperature, "K", 1},
        {0, 0, 6, "dew_point_temperature", wxfVariable_Unspecified, "K", 1},
        {0, 3, 5, "geopotential_height", wxfVariable_GeopotentialHeight, "gpm", 1},
        {0, 2, 2, "wind_east", wxfVariable_WindU, "m s-1", 1},
        {0, 2, 3, "wind_north", wxfVariable_WindV, "m s-1", 1},
        {0, 1, 1, "relative_humidity", wxfVariable_RelativeHumidity, "1", 0.01},
        {0, 2, 8, "vertical_velocity", wxfVariable_VerticalVelocity, "Pa s-1", 1},
        {0, 6, 1, "cloud_cover_total", wxfVariable_TotalCloudCover, "1", 0.01},
        {0, 6, 3, "cloud_cover_low", wxfVariable_LowCloudCover, "1", 0.01},
        {0, 6, 4, "cloud_cover_mid", wxfVariable_MediumCloudCover, "1", 0.01},
        {0, 6, 5, "cloud_cover_high", wxfVariable_HighCloudCover, "1", 0.01},
        {0, 3, 196, "boundary_layer_height", wxfVariable_Unspecified, "m", 1},
        {0, 7, 6, "convective_available_potential_energy", wxfVariable_Unspecified, "J kg-1", 1},
        {0, 3, 1, "mean_sea_level_pressure", wxfVariable_MeanSeaLevelPressure, "Pa", 1},
    };
    const Quantity* q = nullptr;
    for (const Quantity& k : kQuantities) if (k.d == d && k.c == c && k.n == n) q = &k;
    if (!q) { *why = "parameter " + std::to_string(d) + "." + std::to_string(c) + "." + std::to_string(n); return false; }
    out->variable = q->variable; out->units = q->units; out->factor = q->factor;
    const std::string stem = q->stem;
    if (lt == 100) {                                   // isobaric surface (Pa)
        out->level = wxfLevelKind_PressureLevel; out->level_value = static_cast<float>(lv);
        out->name = stem + "_" + format_level_number(lv / 100.0) + "hPa";
    } else if (lt == 7) {                              // tropopause
        out->level = wxfLevelKind_Tropopause; out->name = stem + "_tropopause";
    } else if (lt == 103) {                            // height above ground (m)
        out->level = wxfLevelKind_HeightAboveGround; out->level_value = static_cast<float>(lv);
        out->name = stem + "_" + format_level_number(lv) + "m";
        if (stem == "air_temperature" && lv == 2) out->variable = wxfVariable_Temperature2m;
        if (stem == "dew_point_temperature" && lv == 2) out->variable = wxfVariable_DewpointTemperature2m;
        if (stem == "wind_east" && lv == 10) out->variable = wxfVariable_WindU10m;
        if (stem == "wind_north" && lv == 10) out->variable = wxfVariable_WindV10m;
    } else if (lt == 1) {                              // ground or water surface
        out->level = wxfLevelKind_Surface; out->name = stem + "_surface";
    } else if (lt == 101) {                            // mean sea level
        out->level = wxfLevelKind_MeanSeaLevel; out->name = stem;
    } else if (lt == 10 || lt == 200 || lt == 214 || lt == 224 || lt == 234) {   // entire atmosphere; low/middle/high cloud layer
        out->level = wxfLevelKind_EntireAtmosphere; out->name = stem;
    } else {
        *why = stem + " at level type " + std::to_string(lt);
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// A GRIB2 job: one byte range of one product file (whole messages), as the source's select node emitted it.
// ---------------------------------------------------------------------------

struct GribJob {
    std::string url, product, model_key, model_id, model_class, run;
    int64_t lead = 0;
    int stride = 1, band_rows = 0, ensemble_size = 0;
    bool spread = false;
    std::string license_id;
    Attribution attribution;
};

bool read_grib_job(const std::string& json, GribJob* job, std::string* err) {
    json_string_field(json, "url", &job->url);
    json_string_field(json, "product", &job->product);
    json_string_field(json, "model_key", &job->model_key);
    json_string_field(json, "model_id", &job->model_id);
    json_string_field(json, "model_class", &job->model_class);
    json_string_field(json, "run", &job->run);
    json_string_field(json, "license", &job->license_id);
    double v = 0;
    if (json_number_field(json, "lead", &v)) job->lead = static_cast<int64_t>(v);
    if (json_number_field(json, "stride", &v)) job->stride = static_cast<int>(v);
    if (json_number_field(json, "band_rows", &v)) job->band_rows = static_cast<int>(v);
    if (json_number_field(json, "ensemble_size", &v)) job->ensemble_size = static_cast<int>(v);
    json_bool_field(json, "spread", &job->spread);
    read_attribution(json, &job->attribution);
    if (job->url.empty() || job->product.empty() || job->model_key.empty() || job->run.empty()) { *err = "a GRIB job needs url, product, model_key and run"; return false; }
    if (job->stride < 1 || job->stride > 8) { *err = "stride must be 1..8"; return false; }
    if (job->band_rows < 0) { *err = "band_rows must be 0 (whole field) or a row count"; return false; }
    return true;
}

wxfModelClass model_class_named(const std::string& name) {
    if (name == "NumericalGlobalEnsemble") return wxfModelClass_NumericalGlobalEnsemble;
    if (name == "NumericalGlobalDeterministic") return wxfModelClass_NumericalGlobalDeterministic;
    return wxfModelClass_Other;
}

// ---------------------------------------------------------------------------
// One message -> its record(s): the packing integers, rows south to north, every `stride`-th point, whole or in bands.
// ---------------------------------------------------------------------------

bool message_records(const GribJob& job, const uint8_t* bytes, const grib2mini::Message& m, const grib2mini::Message* previous_bitmap,
                     int64_t retrieved_ms, std::vector<uint8_t>* stream, Sha256* normalized, int* count, std::string* code, std::string* message) {
    Mapped f;
    std::string why;
    if (!map_field(m, &f, &why)) { *code = "unsupported-field"; *message = job.url + ": " + why + " is not one this parser publishes"; return false; }
    if (m.productTemplate == 8 || m.productTemplate == 11 || m.productTemplate == 12) {
        *code = "statistical-field-unsupported";
        *message = job.url + ": " + f.name + " is an interval statistic (product template 4." + std::to_string(m.productTemplate) + "); only instantaneous fields are published";
        return false;
    }
    if (m.scanMode != 0 || m.ni == 0 || m.nj < 2) { *code = "grid-unsupported"; *message = job.url + ": " + f.name + ": scan mode " + std::to_string(m.scanMode) + " (only +i, -j)"; return false; }
    std::vector<uint32_t> X;
    std::string err;
    if (!grib2mini::unpack(bytes, m, previous_bitmap, X, err)) { *code = "grib2-unreadable"; *message = job.url + ": " + f.name + ": " + err; return false; }
    // the grid: GRIB rows north to south from La1; the record south to north from the southernmost row, lon from Lo1
    const double dlat = m.dj * job.stride, dlon = m.di * job.stride;
    const uint32_t nj = (m.nj - 1) / static_cast<uint32_t>(job.stride) + 1, ni = (m.ni + static_cast<uint32_t>(job.stride) - 1) / static_cast<uint32_t>(job.stride);
    const double lat0 = m.la1 - (m.nj - 1) * m.dj;   // southernmost row
    if (std::fabs(m.la1 - 90) > 1e-6 || std::fabs(lat0 + 90) > 1e-6 || std::fabs(m.lo1) > 1e-6) {
        *code = "grid-unsupported"; *message = job.url + ": " + f.name + ": only global grids from 90 N, 0 E are published"; return false;
    }
    const bool periodic = std::fabs(m.ni * m.di - 360.0) < 1e-6;
    std::vector<uint16_t> codes(static_cast<size_t>(ni) * nj);
    double lo = 0, hi = 0; bool any = false; uint32_t missing = 0;
    const double scale = std::ldexp(1.0, m.E) / std::pow(10.0, m.D) * f.factor, offset = double(m.R) / std::pow(10.0, m.D) * f.factor;
    for (uint32_t j = 0; j < nj; j++) {
        const uint32_t src_row = m.nj - 1 - j * static_cast<uint32_t>(job.stride);   // (record row j from the south)
        for (uint32_t i = 0; i < ni; i++) {
            const uint32_t x = X[static_cast<size_t>(src_row) * m.ni + static_cast<size_t>(i) * static_cast<uint32_t>(job.stride)];
            uint16_t c;
            if (x == grib2mini::MISSING) { c = 65535; missing++; }
            else if (x > 65534) { *code = "packing-too-wide"; *message = job.url + ": " + f.name + ": a packing integer (" + std::to_string(x) + ") does not fit 16 bits"; return false; }
            else {
                c = static_cast<uint16_t>(x);
                const double v = offset + scale * x;
                if (!any || v < lo) lo = v;
                if (!any || v > hi) hi = v;
                any = true;
            }
            codes[static_cast<size_t>(j) * ni + i] = c;
        }
    }
    const int64_t init_ms = m.referenceTimeMs, lead = m.forecastHours();
    if (lead < 0) { *code = "grib2-unreadable"; *message = job.url + ": " + f.name + ": time unit " + std::to_string(m.timeUnit) + " unsupported"; return false; }
    const std::string name = f.name + (job.spread ? "_spread" : "");
    const uint32_t band = job.band_rows > 0 ? static_cast<uint32_t>(job.band_rows) : nj;
    const uint32_t bands = (nj + band - 1) / band;
    for (uint32_t b = 0; b < bands; b++) {
        const uint32_t r0 = b * band, rows = std::min(band, nj - r0);
        std::vector<uint16_t> part(codes.begin() + static_cast<ptrdiff_t>(r0) * ni, codes.begin() + static_cast<ptrdiff_t>(r0 + rows) * ni);
        double plo = 0, phi = 0; bool pany = false; uint32_t pmiss = 0;
        for (uint16_t c : part) {
            if (c == 65535) { pmiss++; continue; }
            const double v = offset + scale * c;
            if (!pany || v < plo) plo = v;
            if (!pany || v > phi) phi = v;
            pany = true;
        }
        const std::vector<uint8_t> chunk = encode_chunk_u16(part);
        ::flatbuffers::FlatBufferBuilder fbb(1024 + chunk.size());
        const auto field_id = fbb.CreateString(job.model_key + ":" + job.run + ":f" + std::to_string(lead) + ":" + name);
        const auto model_id = fbb.CreateString(job.model_id);
        const auto model_version = fbb.CreateString(kParserVersion);
        const auto variable_name = fbb.CreateString(name);
        const auto units = fbb.CreateString(f.units);
        const auto values = fbb.CreateVector(chunk);
        const auto chunk_dtype = fbb.CreateString("uint16");
        const auto chunk_codecs = fbb.CreateVectorOfStrings(std::vector<std::string>{"delta", "zigzag", "shuffle"});
        const auto origin = fbb.CreateString(job.attribution.origin_id);
        const auto dataset = fbb.CreateString(job.attribution.dataset_id);
        const auto source_url = fbb.CreateString(job.url);
        const auto license_url = fbb.CreateString(job.attribution.license_url);
        const auto citation = fbb.CreateString(job.attribution.citation);
        WXFGridBuilder grid(fbb);
        grid.add_KIND(wxfGridKind_RegularLatLon);
        grid.add_LAT0(lat0 + r0 * dlat);
        grid.add_LON0(m.lo1);
        grid.add_DLAT(dlat);
        grid.add_DLON(dlon);
        grid.add_NLAT(rows);
        grid.add_NLON(ni);
        grid.add_PERIODIC_LON(periodic);
        const auto grid_off = grid.Finish();
        WXFBuilder r(fbb);
        r.add_FIELD_ID(field_id);
        r.add_MODEL_CLASS(model_class_named(job.model_class));
        r.add_MODEL_ID(model_id);
        r.add_MODEL_VERSION(model_version);
        r.add_TIME_BASIS(wxfTimeBasis_Initialization);
        r.add_INIT_TIME_MS(static_cast<uint64_t>(init_ms));
        r.add_LEAD_HOURS(static_cast<float>(lead));
        r.add_VALID_TIME_MS(static_cast<uint64_t>(init_ms + lead * 3600000));
        r.add_MEMBER_KIND(job.spread ? wxfMemberKind_StandardDeviation : wxfMemberKind_Unspecified);
        if (job.ensemble_size > 0) r.add_ENSEMBLE_SIZE(static_cast<uint16_t>(job.ensemble_size));
        r.add_VARIABLE(f.variable);
        r.add_VARIABLE_NAME(variable_name);
        r.add_UNITS(units);
        r.add_LEVEL_KIND(f.level);
        r.add_LEVEL_VALUE(f.level_value);
        r.add_TEMPORAL_KIND(wxfTemporalKind_Instantaneous);
        r.add_GRID(grid_off);
        r.add_TILE_INDEX(b);
        r.add_TILE_COUNT(bands);
        r.add_VALUES_ENCODING(wxfValuesEncoding_InlineEncodedChunk);
        r.add_QUANTIZED_U8(values);
        r.add_CHUNK_DTYPE(chunk_dtype);
        r.add_CHUNK_CODECS(chunk_codecs);
        r.add_CHUNK_BYTE_LENGTH(static_cast<uint64_t>(chunk.size()));
        r.add_SCALE_FACTOR(scale);
        r.add_ADD_OFFSET(offset);
        r.add_VALUE_MIN(static_cast<float>(plo));
        r.add_VALUE_MAX(static_cast<float>(phi));
        r.add_MISSING_COUNT(pmiss);
        r.add_ORIGIN_ID(origin);
        r.add_DATASET_ID(dataset);
        r.add_SOURCE_URL(source_url);
        r.add_RETRIEVED_AT(static_cast<uint64_t>(retrieved_ms));
        r.add_LICENSE_CLASS(wxfLicenseClass_OpenAttribution);
        r.add_LICENSE_URL(license_url);
        r.add_CITATION(citation);
        const auto root = r.Finish();
        FinishSizePrefixedWXFBuffer(fbb, root);
        const std::vector<uint8_t> record = finished_unprefixed(fbb);
        append_size_prefixed(stream, record);
        normalized_hash_record(normalized, "WXF.fbs", record);
        (*count)++;
    }
    (void)missing; (void)lo; (void)hi; (void)any;
    return true;
}

}  // namespace

// ---------------------------------------------------------------------------
// Method entry point.
// ---------------------------------------------------------------------------

extern "C" {

// parse: jobs[k] + responses[k] (paired by position; each response whole GRIB2 messages of one byte range) ->
// wxf_meta + wxf_records (one batch for the invocation).
int parse(void) {
    const std::vector<const plugin_input_frame_t*> job_frames = frames_on("jobs");
    const std::vector<const plugin_input_frame_t*> response_frames = frames_on("responses");
    if (job_frames.empty()) {
        plugin_set_error("missing-job-frame", "parse requires at least one GRIB job frame.");
        return 400;
    }
    if (job_frames.size() != response_frames.size()) {
        const std::string msg = "parse received " + std::to_string(job_frames.size()) + " job frames but " + std::to_string(response_frames.size()) +
                                " response frames; jobs and responses pair by position, so a mismatch cannot be attributed and is refused.";
        plugin_set_error("job-response-count-mismatch", msg.c_str());
        return 400;
    }
    std::vector<GribJob> jobs(job_frames.size());
    std::vector<HttpResponse> responses(response_frames.size());
    for (size_t k = 0; k < jobs.size(); k++) {
        std::string err;
        if (!read_grib_job(frame_text(job_frames[k]), &jobs[k], &err)) {
            plugin_set_error("invalid-grib-job", ("GRIB job " + std::to_string(k) + ": " + err).c_str());
            return 400;
        }
        if (!decode_http_response(response_frames[k], &responses[k], &err)) {
            plugin_set_error("invalid-response-frame", ("response " + std::to_string(k) + ": " + err).c_str());
            return 400;
        }
        if (responses[k].status != 200 && responses[k].status != 206) {
            plugin_set_error("fetch-failed", (jobs[k].url + " returned HTTP status " + std::to_string(responses[k].status)).c_str());
            return 502;
        }
    }
    Sha256 batch, normalized;
    std::vector<uint8_t> stream;
    int count = 0;
    for (size_t k = 0; k < jobs.size(); k++) {
        const std::vector<uint8_t>& body = responses[k].body;
        batch.update(body.data(), body.size());
        std::vector<grib2mini::Message> messages;
        std::string err;
        if (!grib2mini::parse(body.data(), body.size(), messages, err)) {
            plugin_set_error("grib2-unreadable", (jobs[k].url + ": " + err).c_str());
            return 422;
        }
        if (messages.empty()) {
            plugin_set_error("grib2-unreadable", (jobs[k].url + ": the range holds no GRIB2 message").c_str());
            return 422;
        }
        const grib2mini::Message* previous_bitmap = nullptr;
        for (const grib2mini::Message& m : messages) {
            std::string code, message;
            if (!message_records(jobs[k], body.data(), m, previous_bitmap, retrieved_at_ms(responses[k]), &stream, &normalized, &count, &code, &message)) {
                plugin_set_error(code.c_str(), message.c_str());
                return 422;
            }
            if (m.bitmapIndicator == 0) previous_bitmap = &m;
        }
    }
    const std::string batch_id = batch.hex_digest();
    const GribJob& first = jobs[0];
    const int64_t retrieved = retrieved_at_ms(responses[0]);
    const std::string provenance = build_provenance_json(kParserVersion, first.url, responses[0].status, responses[0], batch_id, normalized.hex_digest(), count,
                                                         "{\"WXF.fbs\":" + std::to_string(count) + "}", retrieved);
    const std::string meta = build_ingest_meta("WXF.fbs", first.attribution, first.license_id, first.url, batch_id, provenance);
    if (push_json("wxf_meta", meta) < 0) return 500;
    if (push_record_stream("wxf_records", "WXF.fbs", "$WXF", "WXF", stream) < 0) return 500;
    return 0;
}

}  // extern "C"
