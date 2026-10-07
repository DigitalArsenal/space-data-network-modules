/*
 * data-source/imager-observation-parser.
 *
 * A pure parser flow node (capabilities: none) for geostationary imager observations: each fetched NetCDF4 file of a
 * GOES ABI L1b/L2 product (NOAA Open Data Dissemination, anonymous public buckets) becomes its field's world product -
 * the area mean of the native pixels in each cell of a 4096 x 2048 latitude/longitude grid (cells no pixel centre falls
 * into take the field sampled at the cell centre; cloud phase the pixel nearest the cell centre), at 4096, 2048 and
 * 1024 wide - as size-prefixed $WXF records, one per 64-row band, quantized at the instrument's precision and coded as
 * SDS 1.238 defines (InlineEncodedChunk: delta, zigzag, shuffle; InlineQuantizedUint16 / InlineQuantizedUint8). One
 * satellite's fields, unblended (owner 2026-10-07: SDN carries raw per-satellite fields; the display derives the rest).
 *
 * The world product, quantization and codecs are the reference producer's (DigitalArsenal/Cesium_Weather
 * orbpro-gaussian-clouds/tools/raw_satellite.py), ported formula for formula: on full-disk GOES-18 and GOES-19 files of
 * every field the ported code and the reference agree in every float and every code (native/imagerworld/
 * compare_reference.py there); tests/ hold the reference's output for real mesoscale files.
 *
 * The file is read by hdf5mini (vendored; superblocks 0-3, dense and compact groups and attributes, chunked layouts,
 * deflate via the vendored miniz, shuffle), the values as netCDF4's mask-and-scale gives them, chunk by chunk.
 *
 * Method:
 *   parse : jobs[k] + responses[k] -> wxf_meta + wxf_records
 *       Paired by position (the request builder emitted them in the same order); a count mismatch is refused. A file
 *       fetched as byte ranges arrives as consecutive parts 0 .. n-1 and is joined before it is read. All files of the
 *       invocation make one ingest batch: one meta frame and one record stream.
 */
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <map>
#include <string>
#include <vector>

#include <sys/time.h>

#include "space_data_module_invoke.h"

namespace {

constexpr const char* kContentKeyID = "public";
constexpr const char* kParserVersion = "imager-observation-parser/v1";

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

// ---------------------------------------------------------------------------
// Imager fields (as the reference producer publishes them: SDS variable and level, units, the step a code holds).
// Steps are the instruments' precision (owner 2026-10-06): brightness temperature 0.1 K, cloud-top height 34 m,
// reflectance 1/1024, optical depth and effective radius 0.25; the smooth fields coded InlineEncodedChunk.
// ---------------------------------------------------------------------------

struct FieldSpec {
    const char* name;
    wxfVariable variable;
    wxfLevelKind level;
    const char* units;
    bool u16;
    double scale, offset;
    bool codecs, categorical, world_mean, fine;
    float divisor;          // rain rate: mm h-1 -> kg m-2 s-1
    double wavelength_um;   // ABI channel the field is measured or retrieved at (0: none)
    const char* model_id;   // "<sensor> <this>"
};

const FieldSpec kFields[] = {
    {"brightness_temperature_10um", wxfVariable_BrightnessTemperature, wxfLevelKind_TopOfAtmosphere, "K", true, 0.1, 150, true, false, false, false, 1.0f, 10.33, "L1b/CMI"},
    {"cloud_top_height", wxfVariable_GeopotentialHeight, wxfLevelKind_CloudTop, "m", true, 34, -500, true, false, false, false, 1.0f, 0, "NOAA L2"},
    {"cloud_mask", wxfVariable_CloudMask, wxfLevelKind_EntireAtmosphere, "1", false, 3.0 / 254, 0, false, true, true, false, 1.0f, 0, "NOAA L2"},
    {"cloud_phase", wxfVariable_CloudPhase, wxfLevelKind_CloudTop, "1", false, 1, 0, false, true, false, false, 1.0f, 0, "NOAA L2"},
    {"cloud_optical_depth", wxfVariable_CloudOpticalDepth, wxfLevelKind_EntireAtmosphere, "1", true, 0.25, 0, true, false, false, false, 1.0f, 0.64, "NOAA L2"},
    {"cloud_effective_radius", wxfVariable_CloudEffectiveRadius, wxfLevelKind_CloudTop, "um", true, 0.25, 0, true, false, false, false, 1.0f, 0, "NOAA L2"},
    {"reflectance_064um", wxfVariable_Reflectance, wxfLevelKind_TopOfAtmosphere, "1", true, 1.0 / 1024, -0.01, true, false, false, true, 1.0f, 0.64, "NOAA L2"},
    {"rain_rate", wxfVariable_PrecipitationRate, wxfLevelKind_Surface, "kg m-2 s-1", true, 0.01 / 3600, 0, false, false, false, false, 3600.0f, 0, "NOAA L2"},
};

const FieldSpec* field_spec(const std::string& name) {
    for (const FieldSpec& f : kFields) if (name == f.name) return &f;
    return nullptr;
}

// ---------------------------------------------------------------------------
// A file job (one per fetched part; a file larger than one response is fetched as consecutive byte ranges).
// ---------------------------------------------------------------------------

struct FileJob {
    std::string satellite, sensor, bucket, key, variable, field, license_id, license_class;
    int64_t frame_time_ms = 0;
    int part = 0, parts = 1;
    std::vector<int> widths;
    Attribution attribution;
};

bool read_file_job(const std::string& json, FileJob* job, std::string* err) {
    json_string_field(json, "satellite", &job->satellite);
    json_string_field(json, "sensor", &job->sensor);
    json_string_field(json, "bucket", &job->bucket);
    json_string_field(json, "key", &job->key);
    json_string_field(json, "variable", &job->variable);
    json_string_field(json, "field", &job->field);
    json_string_field(json, "license", &job->license_id);
    json_string_field(json, "license_class", &job->license_class);
    double v = 0;
    if (json_number_field(json, "frame_time_ms", &v)) job->frame_time_ms = static_cast<int64_t>(v);
    if (json_number_field(json, "part", &v)) job->part = static_cast<int>(v);
    if (json_number_field(json, "parts", &v)) job->parts = static_cast<int>(v);
    std::string widths = "4096,2048,1024";
    json_string_field(json, "widths", &widths);
    for (size_t at = 0; at < widths.size();) {
        const size_t comma = widths.find(',', at);
        const int w = atoi(widths.substr(at, comma == std::string::npos ? std::string::npos : comma - at).c_str());
        if (w != 4096 && w != 2048 && w != 1024) { *err = "widths must be 4096, 2048 and/or 1024"; return false; }
        job->widths.push_back(w);
        if (comma == std::string::npos) break;
        at = comma + 1;
    }
    read_attribution(json, &job->attribution);
    if (job->sensor.empty() || job->bucket.empty() || job->key.empty() || job->variable.empty()) {
        *err = "a file job needs sensor, bucket, key and variable";
        return false;
    }
    if (!field_spec(job->field)) { *err = "unknown field \"" + job->field + "\""; return false; }
    if (job->frame_time_ms <= 0) { *err = "frame_time_ms is required"; return false; }
    if (job->parts < 1 || job->part < 0 || job->part >= job->parts) { *err = "part must be 0 .. parts - 1"; return false; }
    if (job->license_class.empty()) job->license_class = "OpenAttribution";
    return true;
}

// A response body without copying it (raw-body-v1: "$HRB" + int32le status + body); the JSON lane decodes into owned.
struct Body {
    long status = 0;
    const uint8_t* data = nullptr;
    size_t size = 0;
    std::vector<uint8_t> owned;
    HttpResponse response;   // (the JSON lane's headers, for provenance)
};

bool read_body(const plugin_input_frame_t* frame, Body* out, std::string* err) {
    if (frame && frame->payload && frame->payload_length >= 8 && memcmp(frame->payload, "$HRB", 4) == 0) {
        const uint8_t* p = frame->payload;
        out->status = static_cast<int32_t>(static_cast<uint32_t>(p[4]) | (static_cast<uint32_t>(p[5]) << 8) |
                                           (static_cast<uint32_t>(p[6]) << 16) | (static_cast<uint32_t>(p[7]) << 24));
        out->data = p + 8;
        out->size = frame->payload_length - 8;
        out->response.status = out->status;
        return true;
    }
    if (!decode_http_response(frame, &out->response, err)) return false;
    out->status = out->response.status;
    out->owned.swap(out->response.body);
    out->data = out->owned.data();
    out->size = out->owned.size();
    return true;
}

// A NetCDF4 chunk inflated with the vendored miniz (zlib stream, exact size).
bool inflate_miniz(const uint8_t* in, size_t n, uint8_t* out, size_t out_size) {
    const size_t got = tinfl_decompress_mem_to_mem(out, out_size, in, n, TINFL_FLAG_PARSE_ZLIB_HEADER);
    return got != TINFL_DECOMPRESS_MEM_TO_MEM_FAILED && got == out_size;
}

// "..._sYYYYJJJHHMMSSt_eYYYYJJJHHMMSSt_..." (the GOES file-name convention) -> scan start/end, Unix ms (whole seconds,
// as the reference reads them).
bool scan_times(const std::string& key, int64_t* start_ms, int64_t* end_ms) {
    auto stamp = [&](char tag, int64_t* out) {
        const std::string marker = std::string("_") + tag;
        size_t at = key.find(marker);
        while (at != std::string::npos) {
            const std::string digits = key.substr(at + 2, 14);
            if (digits.size() == 14 && std::all_of(digits.begin(), digits.end(), ::isdigit)) {
                const int year = atoi(digits.substr(0, 4).c_str()), doy = atoi(digits.substr(4, 3).c_str());
                const int hh = atoi(digits.substr(7, 2).c_str()), mm = atoi(digits.substr(9, 2).c_str()), ss = atoi(digits.substr(11, 2).c_str());
                *out = (days_from_civil(year, 1, 1) + doy - 1) * 86400000LL + (hh * 3600LL + mm * 60LL + ss) * 1000LL;
                return true;
            }
            at = key.find(marker, at + 1);
        }
        return false;
    };
    return stamp('s', start_ms) && stamp('e', end_ms);
}

// ---------------------------------------------------------------------------
// One band of a world level -> one $WXF record (as raw_satellite.py wxf_record writes it).
// ---------------------------------------------------------------------------

struct Platform { double lon0 = 0, height = 0; int64_t scan_start = 0, scan_end = 0; };

std::vector<uint8_t> build_record(const FileJob& job, const FieldSpec& spec, const Platform& platform, int width,
                                  int band_row, int rows, const float* values, int64_t retrieved_ms) {
    using namespace imagerworld;
    const size_t n = static_cast<size_t>(rows) * static_cast<size_t>(width);
    const double d = 360.0 / width;
    const int height = WORLD_H / (WORLD_W / width);
    imagerworld::Spec q;
    q.u16 = spec.u16; q.scale = spec.scale; q.offset = spec.offset; q.codecs = spec.codecs;
    std::vector<uint16_t> codes;
    const size_t missing = quantize(values, n, q, codes);
    float lo = 0, hi = 0; bool any = false;
    for (size_t i = 0; i < n; i++) {
        if (!std::isfinite(values[i])) continue;
        if (!any || values[i] < lo) lo = values[i];
        if (!any || values[i] > hi) hi = values[i];
        any = true;
    }

    ::flatbuffers::FlatBufferBuilder fbb(1024 + n * 2);
    const auto field_id = fbb.CreateString(job.sensor + ":" + std::to_string(job.frame_time_ms) + ":world" + std::to_string(width) + ":" + spec.name);
    const auto model_id = fbb.CreateString(job.sensor + " " + spec.model_id);
    const auto model_version = fbb.CreateString(kParserVersion);
    const auto variable_name = fbb.CreateString(spec.name);
    const auto units = fbb.CreateString(spec.units);
    const auto sensor = fbb.CreateString(job.sensor);
    const auto origin = fbb.CreateString(job.attribution.origin_id);
    const auto dataset = fbb.CreateString(job.attribution.dataset_id.empty() ? job.bucket : job.attribution.dataset_id);
    const auto source_url = fbb.CreateString("s3://" + job.bucket + "/" + job.key);
    const auto license_url = fbb.CreateString(job.attribution.license_url);
    const auto citation = fbb.CreateString(job.attribution.citation);
    ::flatbuffers::Offset<::flatbuffers::Vector<uint8_t>> u8;
    ::flatbuffers::Offset<::flatbuffers::Vector<uint16_t>> u16;
    ::flatbuffers::Offset<::flatbuffers::String> chunk_dtype;
    ::flatbuffers::Offset<::flatbuffers::Vector<::flatbuffers::Offset<::flatbuffers::String>>> chunk_codecs;
    size_t chunk_bytes = 0;
    if (spec.codecs) {
        const std::vector<uint8_t> chunk = encodeChunk(codes, spec.u16);
        chunk_bytes = chunk.size();
        u8 = fbb.CreateVector(chunk);
        chunk_dtype = fbb.CreateString(spec.u16 ? "uint16" : "uint8");
        chunk_codecs = fbb.CreateVectorOfStrings(std::vector<std::string>{"delta", "zigzag", "shuffle"});
    } else if (spec.u16) {
        u16 = fbb.CreateVector(codes);
    } else {
        std::vector<uint8_t> narrow(codes.begin(), codes.end());
        u8 = fbb.CreateVector(narrow);
    }

    WXFGridBuilder grid(fbb);
    grid.add_KIND(wxfGridKind_RegularLatLon);
    grid.add_LAT0(90 - (band_row + .5) * d);
    grid.add_LON0(-180 + .5 * d);
    grid.add_DLAT(-d);
    grid.add_DLON(d);
    grid.add_NLAT(static_cast<uint32_t>(rows));
    grid.add_NLON(static_cast<uint32_t>(width));
    grid.add_PERIODIC_LON(false);
    const auto grid_off = grid.Finish();

    WXFBuilder b(fbb);
    b.add_FIELD_ID(field_id);
    b.add_MODEL_CLASS(wxfModelClass_Analysis);
    b.add_MODEL_ID(model_id);
    b.add_MODEL_VERSION(model_version);
    b.add_TIME_BASIS(wxfTimeBasis_ValidTimeOnly);
    b.add_VALID_TIME_MS(static_cast<uint64_t>(platform.scan_start ? platform.scan_start : job.frame_time_ms));
    b.add_SCAN_END_TIME_MS(static_cast<uint64_t>(platform.scan_end));
    b.add_MEMBER_KIND(wxfMemberKind_Unspecified);
    b.add_VARIABLE(spec.variable);
    b.add_VARIABLE_NAME(variable_name);
    b.add_UNITS(units);
    b.add_LEVEL_KIND(spec.level);
    b.add_GRID(grid_off);
    b.add_TILE_INDEX(static_cast<uint32_t>(band_row / WORLD_ROWS));
    b.add_TILE_COUNT(static_cast<uint32_t>((height + WORLD_ROWS - 1) / WORLD_ROWS));
    if (spec.codecs) {
        b.add_VALUES_ENCODING(wxfValuesEncoding_InlineEncodedChunk);
        b.add_QUANTIZED_U8(u8);
        b.add_CHUNK_DTYPE(chunk_dtype);
        b.add_CHUNK_CODECS(chunk_codecs);
        b.add_CHUNK_BYTE_LENGTH(static_cast<uint64_t>(chunk_bytes));
    } else if (spec.u16) {
        b.add_VALUES_ENCODING(wxfValuesEncoding_InlineQuantizedUint16);
        b.add_QUANTIZED_U16(u16);
    } else {
        b.add_VALUES_ENCODING(wxfValuesEncoding_InlineQuantizedUint8);
        b.add_QUANTIZED_U8(u8);
    }
    b.add_SCALE_FACTOR(spec.scale);
    b.add_ADD_OFFSET(spec.offset);
    b.add_VALUE_MIN(lo);
    b.add_VALUE_MAX(hi);
    b.add_MISSING_COUNT(static_cast<uint32_t>(missing));
    b.add_SENSOR_ID(sensor);
    b.add_CHANNEL_WAVELENGTH_UM(static_cast<float>(spec.wavelength_um));
    b.add_PLATFORM_LONGITUDE_DEG(platform.lon0);
    b.add_PLATFORM_LATITUDE_DEG(0.0);
    b.add_PLATFORM_HEIGHT_M(platform.height);
    b.add_ORIGIN_ID(origin);
    b.add_DATASET_ID(dataset);
    b.add_SOURCE_URL(source_url);
    b.add_RETRIEVED_AT(static_cast<uint64_t>(retrieved_ms));
    b.add_LICENSE_CLASS(wxfLicenseClass_OpenAttribution);
    b.add_LICENSE_URL(license_url);
    b.add_CITATION(citation);
    const auto root = b.Finish();
    FinishSizePrefixedWXFBuffer(fbb, root);
    return finished_unprefixed(fbb);
}

// One fetched file -> its field's world product, every requested width, 64-row band records appended to the stream.
bool world_records(const FileJob& job, const uint8_t* bytes, size_t size, int64_t retrieved_ms, std::vector<uint8_t>* stream,
                   Sha256* normalized, int* count, std::string* code, std::string* message) {
    using namespace imagerworld;
    const FieldSpec& spec = *field_spec(job.field);
    hdf5mini::File file(bytes, size);
    if (!file.open()) { *code = "netcdf-unreadable"; *message = job.key + ": " + file.error(); return false; }
    Field field;
    std::string err;
    if (!readField(file, inflate_miniz, job.variable, spec.fine ? 4 : 1, spec.divisor, field, err)) {
        *code = "netcdf-unreadable"; *message = job.key + ": " + err; return false;
    }
    Platform platform;
    platform.lon0 = field.grid.lon0;
    platform.height = field.grid.H - field.grid.req;
    scan_times(job.key, &platform.scan_start, &platform.scan_end);
    World world = worldProduct(field, spec.categorical, spec.world_mean);
    field.data.clear(); field.data.shrink_to_fit();
    if (world.r1 <= world.r0) return true;   // (the disc reaches no cell: nothing to publish)
    const bool centre = spec.categorical && !spec.world_mean;
    for (int width : job.widths) {
        const int factor = WORLD_W / width;
        const std::vector<float> level = worldLevel(world.values, world.r1 - world.r0, factor, centre);
        const int l0 = world.r0 / factor, l1 = (world.r1 + factor - 1) / factor;
        for (int b = l0; b < l1; b += WORLD_ROWS) {
            const int rows = std::min(WORLD_ROWS, l1 - b);
            const std::vector<uint8_t> record = build_record(job, spec, platform, width, b, rows,
                                                             &level[static_cast<size_t>(b - l0) * static_cast<size_t>(width)], retrieved_ms);
            append_size_prefixed(stream, record);
            normalized_hash_record(normalized, "WXF.fbs", record);
            (*count)++;
        }
    }
    return true;
}

}  // namespace

// ---------------------------------------------------------------------------
// Method entry point.
// ---------------------------------------------------------------------------

extern "C" {

// parse: jobs[k] + responses[k] (paired by position; a file's byte-range parts consecutive) -> wxf_meta + wxf_records.
int parse(void) {
    const std::vector<const plugin_input_frame_t*> job_frames = frames_on("jobs");
    const std::vector<const plugin_input_frame_t*> response_frames = frames_on("responses");
    if (job_frames.empty()) {
        plugin_set_error("missing-job-frame", "parse requires at least one file job frame.");
        return 400;
    }
    if (job_frames.size() != response_frames.size()) {
        const std::string msg = "parse received " + std::to_string(job_frames.size()) + " job frames but " +
                                std::to_string(response_frames.size()) +
                                " response frames; jobs and responses pair by position, so a mismatch cannot be attributed and is refused.";
        plugin_set_error("job-response-count-mismatch", msg.c_str());
        return 400;
    }
    std::vector<FileJob> jobs(job_frames.size());
    std::vector<Body> bodies(response_frames.size());
    for (size_t k = 0; k < jobs.size(); k++) {
        std::string err;
        if (!read_file_job(frame_text(job_frames[k]), &jobs[k], &err)) {
            plugin_set_error("invalid-file-job", ("file job " + std::to_string(k) + ": " + err).c_str());
            return 400;
        }
        if (!read_body(response_frames[k], &bodies[k], &err)) {
            plugin_set_error("invalid-response-frame", ("response " + std::to_string(k) + ": " + err).c_str());
            return 400;
        }
        const bool ranged = jobs[k].parts > 1;
        if (bodies[k].status != 200 && !(ranged && bodies[k].status == 206)) {
            const std::string msg = jobs[k].key + " part " + std::to_string(jobs[k].part) + " fetch returned HTTP status " +
                                    std::to_string(bodies[k].status);
            plugin_set_error("fetch-failed", msg.c_str());
            return 502;
        }
    }

    Sha256 batch, normalized;
    std::vector<uint8_t> stream;
    int count = 0;
    for (size_t k = 0; k < jobs.size();) {
        // a file: its parts 0 .. parts - 1, consecutive
        const FileJob& job = jobs[k];
        if (job.part != 0 || k + job.parts > jobs.size()) {
            plugin_set_error("incomplete-file", (job.key + ": its byte-range parts must arrive together, in order").c_str());
            return 400;
        }
        for (int p = 1; p < job.parts; p++) {
            if (jobs[k + p].key != job.key || jobs[k + p].part != p || jobs[k + p].parts != job.parts) {
                plugin_set_error("incomplete-file", (job.key + ": its byte-range parts must arrive together, in order").c_str());
                return 400;
            }
        }
        const uint8_t* bytes = bodies[k].data;
        size_t size = bodies[k].size;
        std::vector<uint8_t> joined;
        if (job.parts > 1) {
            for (int p = 0; p < job.parts; p++) size += p ? bodies[k + p].size : 0;
            joined.reserve(size);
            for (int p = 0; p < job.parts; p++) joined.insert(joined.end(), bodies[k + p].data, bodies[k + p].data + bodies[k + p].size);
            bytes = joined.data();
        }
        batch.update(bytes, size);
        std::string code, message;
        if (!world_records(job, bytes, size, retrieved_at_ms(bodies[k].response), &stream, &normalized, &count, &code, &message)) {
            plugin_set_error(code.c_str(), message.c_str());
            return 422;
        }
        k += static_cast<size_t>(job.parts);
    }

    const std::string batch_id = batch.hex_digest();
    const FileJob& first = jobs[0];
    const std::string source_url = "s3://" + first.bucket + "/" + first.key;
    const int64_t retrieved = retrieved_at_ms(bodies[0].response);
    const std::string provenance = build_provenance_json(kParserVersion, source_url, 200, bodies[0].response, batch_id,
                                                         normalized.hex_digest(), count,
                                                         "{\"WXF.fbs\":" + std::to_string(count) + "}", retrieved);
    const std::string meta = build_ingest_meta("WXF.fbs", first.attribution, first.license_id, source_url, batch_id, provenance);
    if (push_json("wxf_meta", meta) < 0) return 500;
    if (push_record_stream("wxf_records", "WXF.fbs", "$WXF", "WXF", stream) < 0) return 500;
    return 0;
}

}  // extern "C"
