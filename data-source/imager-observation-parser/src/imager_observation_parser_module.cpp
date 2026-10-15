/*
 * data-source/imager-observation-parser.
 *
 * The imager observation flow's parser and fetch engine (capabilities: none - every byte comes through the flow's http
 * connector node). Each work job of imager-observation-source becomes its fields' world products - the area mean of
 * the native pixels in each cell of a 4096 x 2048 latitude/longitude grid (cells no pixel centre falls into take the
 * field sampled at the cell centre; categorical fields the pixel nearest the cell centre), at 4096, 2048 and/or 1024
 * wide - as size-prefixed $WXF records, one per 64-row band, quantized at the instrument's precision and coded as SDS
 * 1.238 defines (InlineEncodedChunk: delta, zigzag, shuffle; InlineQuantizedUint16 / InlineQuantizedUint8). One
 * satellite's fields, unblended (owner 2026-10-07: SDN carries raw per-satellite fields; the display derives the rest).
 *
 *   GOES ABI      one L1b/L2 NetCDF4 file a field, fetched whole (byte ranges appended, one per round)
 *   Himawari AHI  a band's 88 ISatSS tiles (NetCDF4) assembled into the disc; the L2 cloud files (HDF5, hundreds of MB)
 *                 read by byte range: the header, the variable's chunk B-tree, its chunks
 *   EUMETSAT view Meteosat-12 / Meteosat-9 IODC / Metop-B/C WMS imagery: temperature from the grey, mask and top
 *                 height from the contrast with the clear-sky temperature (GFS skin temperature, fetched by range)
 *
 * The world product, quantization and codecs are the reference producer's (DigitalArsenal/Cesium_Weather
 * orbpro-gaussian-clouds/tools/raw_satellite.py), ported formula for formula (imagerworld, fixedgridread, viewimagery).
 * Files are read by hdf5mini (vendored; inflate via the vendored miniz), GFS by grib2mini (vendored).
 *
 * Method:
 *   parse : work (jobs) + responses (the http connector's answers to this node's requests, in order) ->
 *           requests, wxf_meta + wxf_records (one batch per invocation), notices (landed marks found, view frames
 *           missing), status. ONE job is fetched at a time (the module holds one file's or one band's bytes); before a
 *           GOES or Himawari job is fetched, each field's landed mark is probed (imager-observation-source
 *           publish_request: a field the node already holds answers 304 and is skipped).
 */
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <deque>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include <sys/time.h>

#include "space_data_module_invoke.h"

namespace {

constexpr const char* kContentKeyID = "public";
constexpr const char* kParserVersion = "imager-observation-parser/v2";

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
    double wl_abi, wl_ahi, wl_view;   // the channel the field is measured or retrieved at (0: none)
    const char* model_id;   // "<sensor> <this>" (view imagery: "<sensor> imagery-derived estimate")
};

const FieldSpec kFields[] = {
    {"brightness_temperature_10um", wxfVariable_BrightnessTemperature, wxfLevelKind_TopOfAtmosphere, "K", true, 0.1, 150, true, false, false, false, 1.0f, 10.33, 10.41, 10.5, "L1b/CMI"},
    {"cloud_top_height", wxfVariable_GeopotentialHeight, wxfLevelKind_CloudTop, "m", true, 34, -500, true, false, false, false, 1.0f, 0, 0, 0, "NOAA L2"},
    {"cloud_mask", wxfVariable_CloudMask, wxfLevelKind_EntireAtmosphere, "1", false, 3.0 / 254, 0, false, true, true, false, 1.0f, 0, 0, 0, "NOAA L2"},
    {"cloud_phase", wxfVariable_CloudPhase, wxfLevelKind_CloudTop, "1", false, 1, 0, false, true, false, false, 1.0f, 0, 0, 0, "NOAA L2"},
    {"cloud_optical_depth", wxfVariable_CloudOpticalDepth, wxfLevelKind_EntireAtmosphere, "1", true, 0.25, 0, true, false, false, false, 1.0f, 0.64, 0.64, 0, "NOAA L2"},
    {"cloud_effective_radius", wxfVariable_CloudEffectiveRadius, wxfLevelKind_CloudTop, "um", true, 0.25, 0, true, false, false, false, 1.0f, 0, 0, 0, "NOAA L2"},
    {"reflectance_064um", wxfVariable_Reflectance, wxfLevelKind_TopOfAtmosphere, "1", true, 1.0 / 1024, -0.01, true, false, false, true, 1.0f, 0.64, 0.64, 0.64, "NOAA L2"},
    {"rain_rate", wxfVariable_PrecipitationRate, wxfLevelKind_Surface, "kg m-2 s-1", true, 0.01 / 3600, 0, false, false, false, false, 3600.0f, 0, 0, 0, "NOAA L2"},
    {"cloud_top_emissivity", wxfVariable_CloudEmissivity, wxfLevelKind_CloudTop, "1", false, 1.0 / 254, 0, false, false, false, false, 1.0f, 0, 11.2, 0, "NOAA L2"},
};

const FieldSpec* field_spec(const std::string& name) {
    for (const FieldSpec& f : kFields) if (name == f.name) return &f;
    return nullptr;
}

// ---------------------------------------------------------------------------
// A work job (from imager-observation-source: select_files, or plan for view imagery) and its attribution.
// ---------------------------------------------------------------------------

enum WorkKind { kWorkABI, kWorkAHITiles, kWorkAHIH5, kWorkView };

struct Work {
    WorkKind kind = kWorkABI;
    std::string satellite, sensor, bucket, license_id, license_class, identity;
    Attribution attribution;
    int64_t frame_ms = 0;
    std::vector<int> widths;
    long timeout_ms = 300000;
    double max_part = 64.0 * 1024 * 1024;
    // abi / ahi-h5
    std::string key, variable, field;
    double size = 0;
    // ahi-tiles
    std::vector<std::string> keys;
    std::vector<double> sizes;
    int band = 0;
    int behind = 0;   // hours behind the satellite's newest frame when planned (0: the newest)
    // ahi-h5 / view
    std::vector<std::string> fields, variables;
};

bool read_work(const std::string& json, Work* w, std::string* err) {
    std::string kind;
    json_string_field(json, "kind", &kind);
    if (kind == "abi") w->kind = kWorkABI;
    else if (kind == "ahi-tiles") w->kind = kWorkAHITiles;
    else if (kind == "ahi-h5") w->kind = kWorkAHIH5;
    else if (kind == "view") w->kind = kWorkView;
    else { *err = "unknown work kind \"" + kind + "\""; return false; }
    json_string_field(json, "satellite", &w->satellite);
    json_string_field(json, "sensor", &w->sensor);
    json_string_field(json, "bucket", &w->bucket);
    json_string_field(json, "license", &w->license_id);
    json_string_field(json, "license_class", &w->license_class);
    json_string_field(json, "key", &w->key);
    json_string_field(json, "variable", &w->variable);
    json_string_field(json, "field", &w->field);
    double v = 0;
    if (json_number_field(json, "frame_time_ms", &v)) w->frame_ms = static_cast<int64_t>(v);
    if (json_number_field(json, "size", &v)) w->size = v;
    if (json_number_field(json, "timeout_ms", &v) && v > 0) w->timeout_ms = static_cast<long>(v);
    if (json_number_field(json, "max_part_bytes", &v) && v >= 1024 * 1024) w->max_part = v;
    if (json_number_field(json, "band", &v)) w->band = static_cast<int>(v);
    if (json_number_field(json, "behind", &v)) w->behind = static_cast<int>(v);
    w->keys = json_string_array(json_array_slice(json, "keys"));
    w->sizes = json_number_array(json_array_slice(json, "sizes"));
    w->fields = json_string_array(json_array_slice(json, "fields"));
    w->variables = json_string_array(json_array_slice(json, "variables"));
    std::string widths = "4096,2048,1024";
    json_string_field(json, "widths", &widths);
    for (size_t at = 0; at < widths.size();) {
        const size_t comma = widths.find(',', at);
        const int width = atoi(widths.substr(at, comma == std::string::npos ? std::string::npos : comma - at).c_str());
        if (width != 4096 && width != 2048 && width != 1024) { *err = "widths must be 4096, 2048 and/or 1024"; return false; }
        w->widths.push_back(width);
        if (comma == std::string::npos) break;
        at = comma + 1;
    }
    read_attribution(json, &w->attribution);
    if (w->license_class.empty()) w->license_class = "OpenAttribution";
    if (w->satellite.empty() || w->sensor.empty() || w->frame_ms <= 0) { *err = "a work job needs satellite, sensor and frame_time_ms"; return false; }
    const std::string frame = std::to_string(w->frame_ms);
    switch (w->kind) {
        case kWorkABI:
            if (w->bucket.empty() || w->key.empty() || w->variable.empty() || !field_spec(w->field) || w->size <= 0) { *err = "an abi job needs bucket, key, size, variable and a known field"; return false; }
            w->identity = "abi|" + w->satellite + "|" + frame + "|" + w->field;
            break;
        case kWorkAHITiles:
            if (w->bucket.empty() || w->keys.empty() || w->keys.size() != w->sizes.size() || !field_spec(w->field) || (w->band != 3 && w->band != 13)) {
                *err = "an ahi-tiles job needs bucket, keys and sizes, band 3 or 13 and a known field"; return false;
            }
            w->identity = "tiles|" + w->satellite + "|" + frame + "|" + w->field;
            break;
        case kWorkAHIH5:
            if (w->bucket.empty() || w->key.empty() || w->size <= 0 || w->fields.empty() || w->fields.size() != w->variables.size()) {
                *err = "an ahi-h5 job needs bucket, key, size and fields with their variables"; return false;
            }
            for (const std::string& f : w->fields) if (!field_spec(f)) { *err = "unknown field \"" + f + "\""; return false; }
            w->identity = "h5|" + w->satellite + "|" + frame + "|" + w->key;
            break;
        case kWorkView:
            if (w->fields.empty()) { *err = "a view job needs fields"; return false; }
            for (const std::string& f : w->fields) if (!field_spec(f)) { *err = "unknown field \"" + f + "\""; return false; }
            w->identity = "view|" + w->satellite + "|" + frame;
            break;
    }
    return true;
}

std::string object_url(const Work& w, const std::string& key) { return "https://" + w.bucket + ".s3.amazonaws.com/" + key; }

// The field's landed mark (imager-observation-source publish_request fetches it once the batch is stored).
std::string landed_mark(const Work& w, const std::string& key, const std::string& field) {
    return object_url(w, key) + "?sdn-ingest=landed&field=" + field;
}

// ---------------------------------------------------------------------------
// Requests to the http connector (hostcap/http-request, raw-body-v1 responses).
// ---------------------------------------------------------------------------

constexpr const char* kNoValidators = "\"If-Modified-Since\":\"Thu, 01 Jan 1970 00:00:00 GMT\"";

std::string get_request(const std::string& url, const std::string& headers, long timeout_ms) {
    return "{\"method\":\"GET\",\"url\":\"" + json_escape(url) + "\",\"headers\":{" + headers + "}" +
           ",\"timeoutMs\":" + std::to_string(timeout_ms) + ",\"responseWire\":\"raw-body-v1\"}";
}
std::string range_header(uint64_t first, uint64_t last) {
    return ",\"Range\":\"bytes=" + std::to_string(first) + "-" + std::to_string(last) + "\"";
}
// The probe of a landed mark: NO validators of its own, so the host adds the ones its ledger holds for the URL (the
// mark's ETag once the field landed: S3 answers 304), and a range past any object (416 otherwise - not a 2xx, so the
// host books no validators for it).
std::string probe_request(const std::string& mark, long timeout_ms) {
    return get_request(mark, "\"Range\":\"bytes=1099511627776-\"", timeout_ms);
}

// ---------------------------------------------------------------------------
// A world product as $WXF records: one per 64-row band per width, as raw_satellite.py wxf_record writes them.
// ---------------------------------------------------------------------------

struct Platform { double lon0 = 0, height = 0; int64_t scan_start = 0, scan_end = 0; };

struct RecordInfo {
    const Work* work = nullptr;
    const FieldSpec* spec = nullptr;
    Platform platform;
    std::string model_id, source_url;
    double wavelength = 0;
    int64_t retrieved_ms = 0;
};

std::vector<uint8_t> build_record(const RecordInfo& info, int width, int band_row, int rows, const float* values) {
    using namespace imagerworld;
    const Work& job = *info.work;
    const FieldSpec& spec = *info.spec;
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
    const auto field_id = fbb.CreateString(job.sensor + ":" + std::to_string(job.frame_ms) + ":world" + std::to_string(width) + ":" + spec.name);
    const auto model_id = fbb.CreateString(info.model_id);
    const auto model_version = fbb.CreateString(kParserVersion);
    const auto variable_name = fbb.CreateString(spec.name);
    const auto units = fbb.CreateString(spec.units);
    const auto sensor = fbb.CreateString(job.sensor);
    const auto origin = fbb.CreateString(job.attribution.origin_id);
    const auto dataset = fbb.CreateString(job.attribution.dataset_id.empty() ? job.bucket : job.attribution.dataset_id);
    const auto source_url = fbb.CreateString(info.source_url);
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
    b.add_VALID_TIME_MS(static_cast<uint64_t>(info.platform.scan_start ? info.platform.scan_start : job.frame_ms));
    b.add_SCAN_END_TIME_MS(static_cast<uint64_t>(info.platform.scan_end));
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
    b.add_CHANNEL_WAVELENGTH_UM(static_cast<float>(info.wavelength));
    b.add_PLATFORM_LONGITUDE_DEG(info.platform.lon0);
    b.add_PLATFORM_LATITUDE_DEG(0.0);
    b.add_PLATFORM_HEIGHT_M(info.platform.height);
    b.add_ORIGIN_ID(origin);
    b.add_DATASET_ID(dataset);
    b.add_SOURCE_URL(source_url);
    b.add_RETRIEVED_AT(static_cast<uint64_t>(info.retrieved_ms));
    b.add_LICENSE_CLASS(wxfLicenseClass_OpenAttribution);
    b.add_LICENSE_URL(license_url);
    b.add_CITATION(citation);
    const auto root = b.Finish();
    FinishSizePrefixedWXFBuffer(fbb, root);
    return finished_unprefixed(fbb);
}

// One batch for storage-ingest: one field's world product at every requested width.
struct OutBatch { std::string meta; std::vector<uint8_t> stream; int records = 0; };

// The world product (rows world.r0 .. r1 at 4096) -> its records at every width, and the batch's ingest meta. The batch
// id is the SHA-256 of the field name and the source bytes it was computed from (several fields come from one file).
void world_batch(const RecordInfo& info, const imagerworld::World& world, const std::string& source_digest_hex,
                 const std::string& mark, OutBatch* out) {
    using namespace imagerworld;
    const Work& job = *info.work;
    const FieldSpec& spec = *info.spec;
    Sha256 normalized;
    out->stream.clear();
    out->records = 0;
    if (world.r1 > world.r0) {
        const bool centre = spec.categorical && !spec.world_mean;
        for (int width : job.widths) {
            const int factor = WORLD_W / width;
            const std::vector<float> level = worldLevel(world.values, world.r1 - world.r0, factor, centre);
            const int l0 = world.r0 / factor, l1 = (world.r1 + factor - 1) / factor;
            for (int b = l0; b < l1; b += WORLD_ROWS) {
                const int rows = std::min(WORLD_ROWS, l1 - b);
                const std::vector<uint8_t> record = build_record(info, width, b, rows, &level[static_cast<size_t>(b - l0) * static_cast<size_t>(width)]);
                append_size_prefixed(&out->stream, record);
                normalized_hash_record(&normalized, "WXF.fbs", record);
                out->records++;
            }
        }
    }
    Sha256 id;
    const std::string name = spec.name;
    id.update(reinterpret_cast<const uint8_t*>(name.data()), name.size());
    id.update(reinterpret_cast<const uint8_t*>(source_digest_hex.data()), source_digest_hex.size());
    const std::string batch_id = id.hex_digest();
    HttpResponse none;
    none.status = 200;
    const std::string provenance = build_provenance_json(kParserVersion, info.source_url, 200, none, source_digest_hex,
                                                         normalized.hex_digest(), out->records,
                                                         "{\"WXF.fbs\":" + std::to_string(out->records) + "}", info.retrieved_ms);
    std::string meta = build_ingest_meta("WXF.fbs", job.attribution, job.license_id, info.source_url, batch_id, provenance);
    // (read by imager-observation-source publish_request: the field landed, and its landed mark; the host reads only
    // the keys it knows)
    meta.pop_back();
    meta += ",\"satellite\":\"" + json_escape(job.satellite) + "\",\"field\":\"" + spec.name + "\",\"frame_time_ms\":" +
            std::to_string(job.frame_ms) + (mark.empty() ? std::string() : ",\"landed_mark\":\"" + json_escape(mark) + "\"") + "}";
    out->meta = meta;
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

// "..._sYYYYMMDDHHMMSSt_eYYYYMMDDHHMMSSt_..." (the AHI L2 cloud product names) -> scan start/end (whole seconds).
bool scan_times_ymd(const std::string& key, int64_t* start_ms, int64_t* end_ms) {
    auto stamp = [&](char tag, int64_t* out) {
        const size_t at = key.find(std::string("_") + tag);
        if (at == std::string::npos) return false;
        const std::string digits = key.substr(at + 2, 14);
        if (digits.size() != 14 || !std::all_of(digits.begin(), digits.end(), ::isdigit)) return false;
        *out = days_from_civil(atoi(digits.substr(0, 4).c_str()), atoi(digits.substr(4, 2).c_str()), atoi(digits.substr(6, 2).c_str())) * 86400000LL +
               (atoi(digits.substr(8, 2).c_str()) * 3600LL + atoi(digits.substr(10, 2).c_str()) * 60LL + atoi(digits.substr(12, 2).c_str())) * 1000LL;
        return true;
    };
    return stamp('s', start_ms) && stamp('e', end_ms);
}
// ---------------------------------------------------------------------------
// The fetch engine. Work jobs queue here; ONE job is active at a time (so the module holds one file's or one band's
// bytes, never more), and it fetches through the flow's http connector node: parse pushes requests on "requests", the
// connector's responses come back on "responses" (a sanctioned, bounded feedback cycle: flows/imager-observation-
// ingest.flow.json allowCycles), matched to the requests in order. A job's finished fields leave as batches, one per
// invocation (one meta and one record stream for storage-ingest at a time); while work remains without a request in
// flight the node yields, so the runtime resumes it after ingest and publication have run.
// ---------------------------------------------------------------------------

enum Tag { kTagProbe, kTagPart, kTagTile, kTagH5Prefix, kTagH5Node, kTagH5Chunk, kTagView, kTagGfsIdx, kTagGfsMsg };
struct Outstanding { int tag; size_t index; };

struct Response { long status = 0; const uint8_t* data = nullptr; size_t size = 0; };

struct Job;   // a work job being fetched (per kind below)
using JobPtr = std::unique_ptr<Job>;

std::vector<Work> g_queue;                  // queued, in arrival order
std::vector<std::string> g_known;           // identities queued or active (a re-planned job is not queued twice)
JobPtr g_active;
std::vector<Outstanding> g_outstanding;     // requests in flight, in push order
size_t g_outstanding_next = 0;
std::vector<OutBatch> g_out;                // finished batches, emitted one per invocation
std::vector<std::string> g_side;            // notices / status frames to emit ("n:" / "s:" + JSON)
int g_landed_before = 0, g_failures = 0;
std::string g_last_failure;

struct Job {
    Work w;
    std::vector<std::string> requests;   // requests to push now (paired with `pending`)
    std::vector<Outstanding> pending;
    bool done = false;
    Sha256 digest;                       // the source bytes, in fetch order
    int64_t retrieved_ms = 0;
    virtual ~Job() {}
    // advance: push requests, finish batches, or finish; false: the job failed (error set)
    virtual bool step(std::string* err) = 0;
    virtual bool on_response(const Outstanding& o, const Response& r, std::string* err) = 0;
    void request(const std::string& req, int tag, size_t index) { requests.push_back(req); pending.push_back({tag, index}); }
    void feed(const Response& r) { digest.update(r.data, r.size); if (!retrieved_ms) retrieved_ms = now_unix_ms(); }
};

void notice(const Work& w, const std::string& field, const char* state) {
    g_side.push_back(std::string("n:{\"satellite\":\"") + json_escape(w.satellite) + "\",\"frame_time_ms\":" + std::to_string(w.frame_ms) +
                     ",\"field\":\"" + field + "\",\"state\":\"" + state + "\"}");
}
void status(const std::string& json) { g_side.push_back("s:" + json); }

// ---- landed-mark probes (ABI, AHI): fields the node already holds are dropped from the job ----
struct Probing {
    std::vector<std::string> fields, marks;
    std::vector<bool> landed;
    bool sent = false;
    void send(Job& job, long timeout) {
        landed.assign(fields.size(), false);
        for (size_t k = 0; k < fields.size(); k++) job.request(probe_request(marks[k], timeout), kTagProbe, k);
        sent = true;
    }
    void on(const Outstanding& o, const Response& r) { if (r.status == 304) landed[o.index] = true; }
    // the fields left to fetch (the landed ones noticed and counted)
    std::vector<std::string> left(const Work& w) {
        std::vector<std::string> out;
        for (size_t k = 0; k < fields.size(); k++) {
            if (landed[k]) { notice(w, fields[k], "landed"); g_landed_before++; } else out.push_back(fields[k]);
        }
        return out;
    }
};

// ---------------------------------------------------------------------------
// ABI: one NetCDF4 file, fetched whole (byte ranges of at most max_part, one per round, appended), then its field's
// world product (fixedgridread + imagerworld: the reference producer's formulas).
// ---------------------------------------------------------------------------

struct AbiJob : Job {
    Probing probe;
    std::vector<uint8_t> file;
    int parts = 1, next = 0, stage = 0;
    bool step(std::string* err) override {
        if (stage == 0) {
            probe.fields = {w.field};
            probe.marks = {landed_mark(w, w.key, w.field)};
            probe.send(*this, w.timeout_ms);
            stage = 1;
            return true;
        }
        if (stage == 1) {
            if (probe.left(w).empty()) { done = true; return true; }
            parts = w.size > w.max_part ? static_cast<int>(std::ceil(w.size / w.max_part)) : 1;
            file.reserve(static_cast<size_t>(w.size));
            stage = 2;
        }
        if (stage == 2 && next < parts) {
            std::string range;
            if (parts > 1) {
                const uint64_t a = static_cast<uint64_t>(std::floor(w.size * next / parts));
                const uint64_t b = static_cast<uint64_t>(std::floor(w.size * (next + 1) / parts)) - 1;
                range = range_header(a, b);
            }
            request(get_request(object_url(w, w.key), std::string(kNoValidators) + range, w.timeout_ms), kTagPart, static_cast<size_t>(next));
            return true;
        }
        // whole: the field's world product
        using namespace imagerworld;
        const FieldSpec& spec = *field_spec(w.field);
        hdf5mini::File h(file.data(), file.size());
        if (!h.open()) { *err = w.key + ": " + h.error(); return false; }
        Field field;
        std::string e;
        if (!readField(h, inflate_miniz, w.variable, spec.fine ? 4 : 1, spec.divisor, field, e)) { *err = w.key + ": " + e; return false; }
        RecordInfo info;
        info.work = &w; info.spec = &spec;
        info.platform.lon0 = field.grid.lon0;
        info.platform.height = field.grid.H - field.grid.req;
        scan_times(w.key, &info.platform.scan_start, &info.platform.scan_end);
        info.model_id = w.sensor + " " + spec.model_id;
        info.source_url = "s3://" + w.bucket + "/" + w.key;
        info.wavelength = spec.wl_abi;
        info.retrieved_ms = retrieved_ms;
        std::vector<uint8_t>().swap(file);
        const World world = worldProduct(field, spec.categorical, spec.world_mean);
        std::vector<float>().swap(field.data);
        OutBatch batch;
        world_batch(info, world, digest.hex_digest(), landed_mark(w, w.key, w.field), &batch);
        if (batch.records) g_out.push_back(std::move(batch));
        done = true;
        return true;
    }
    bool on_response(const Outstanding& o, const Response& r, std::string* err) override {
        if (o.tag == kTagProbe) { probe.on(o, r); return true; }
        const bool ok = r.status == 200 || (parts > 1 && r.status == 206);
        if (!ok) { *err = w.key + " part " + std::to_string(o.index) + " answered HTTP " + std::to_string(r.status); return false; }
        feed(r);
        file.insert(file.end(), r.data, r.data + r.size);
        next++;
        return true;
    }
};
// ---------------------------------------------------------------------------
// AHI (Himawari-9). NOAA's sectorized CMI tiles of a band (ISatSS: 88 tiles of the full disc, NetCDF4) assembled into
// the field on the imager's fixed grid - the 0.5 km band as 2 km block means, chunk rows as they come, never the full
// resolution array (raw_satellite.py ahi_fields, split_fine, block_mean) - and NOAA's L2 cloud retrievals (HDF5, read
// by byte range: the file's header, its chunk B-tree, the variable's chunks).
// ---------------------------------------------------------------------------

// The AHI full disc's 2 km fixed grid, as the reference producer derives it from the band 13 tiles (a least-squares
// line through the tiles' x / y, here exactly linear: x = -153719.917308 + 55.887990 c microradians, the same in every
// tile; measured on the 2026-10-14 18:00 frame): the grid of the L2 retrievals, which carry no coordinates.
constexpr double kAhiX0 = -0.15371991730803733, kAhiDX = 5.588799029559618e-05;
constexpr double kAhiY0 = 0.15371991730803733, kAhiDY = -5.588799029559618e-05;
constexpr double kAhiLon0 = 140.7, kAhiHeight = 35785831.0;
constexpr int kAhiRows = 5500;

imagerworld::FixedGrid ahi_grid(int n, int k) {
    imagerworld::FixedGrid g;
    g.lon0 = kAhiLon0; g.H = kAhiHeight + g.req; g.sweepX = false;
    g.x.resize(size_t(n)); g.y.resize(size_t(n));
    for (int i = 0; i < n; i++) {
        double sx = 0, sy = 0;
        for (int j = 0; j < k; j++) { sx += kAhiDX / k * (i * k + j) + kAhiX0; sy += kAhiDY / k * (i * k + j) + kAhiY0; }
        g.x[size_t(i)] = sx / k; g.y[size_t(i)] = sy / k;
    }
    return g;
}

// A NetCDF4 integer variable scaled as netCDF4-python's set_auto_maskandscale gives it with float64 attributes (the
// ISatSS tiles): the masked fill (the type's default -32767 when none is set) NaN, then raw * scale + offset in
// float64, as float32.
struct Scale64 { double scale = 1, offset = 0, fill = -32767; bool hasFill = true; };
Scale64 scale64(const hdf5mini::Dataset& d) {
    Scale64 s;
    s.scale = hdf5mini::File::attrNumber(d, "scale_factor", 1);
    s.offset = hdf5mini::File::attrNumber(d, "add_offset", 0);
    bool found = false;
    const double fill = hdf5mini::File::attrNumber(d, "_FillValue", 0, &found);
    if (found) s.fill = fill;
    return s;
}
int64_t int_at(const uint8_t* p, size_t es, bool isSigned) {
    uint64_t u = 0; memcpy(&u, p, es);
    if (isSigned && es < 8 && (u >> (8 * es - 1)) & 1) u |= ~uint64_t(0) << (8 * es);
    return isSigned ? int64_t(u) : int64_t(u);
}

struct AhiTilesJob : Job {
    Probing probe;
    int stage = 0, k = 1, n = 0, rows = 0;
    size_t next = 0, received = 0, in_flight = 0;
    imagerworld::Field field;
    std::vector<double> total;   // band 3: a band of block rows being summed (per tile: block means of 4 x 4)
    bool step(std::string* err) override {
        if (stage == 0) {
            probe.fields = {w.field};
            probe.marks = {landed_mark(w, w.keys[0], w.field)};
            probe.send(*this, w.timeout_ms);
            stage = 1;
            return true;
        }
        if (stage == 1) {
            if (probe.left(w).empty()) { done = true; return true; }
            rows = w.band == 3 ? 4 * kAhiRows : kAhiRows;
            k = w.band == 3 ? 4 : 1;
            n = rows / k;
            field.w = field.h = n;
            field.data.assign(size_t(n) * size_t(n), imagerworld::nanf());
            stage = 2;   // (the grid: from the first tile's x / y, below)
        }
        if (received < w.keys.size()) {
            if (in_flight) return true;
            // a few tiles a round (band 13 tiles ~0.3 MB, band 3 ~3 MB)
            const size_t per_round = w.band == 3 ? 4 : 11;
            for (size_t t = 0; t < per_round && next < w.keys.size(); t++, next++, in_flight++)
                request(get_request(object_url(w, w.keys[next]), kNoValidators, w.timeout_ms), kTagTile, next);
            return true;
        }
        const FieldSpec& spec = *field_spec(w.field);
        RecordInfo info;
        info.work = &w; info.spec = &spec;
        info.platform.lon0 = kAhiLon0; info.platform.height = kAhiHeight;
        // (the tiles name the scan's start; a full-disc scan takes ten minutes)
        int64_t start = 0, end = 0;
        if (scan_times(w.keys[0] + "_e00000000000000", &start, &end)) { info.platform.scan_start = start; info.platform.scan_end = start + 600000; }
        info.model_id = w.sensor + " " + spec.model_id;
        info.source_url = "s3://" + w.bucket + "/" + w.keys[0].substr(0, w.keys[0].rfind('/') + 1) + "*-M1C" + (w.band < 10 ? "0" : "") + std::to_string(w.band) + "-*";
        info.wavelength = spec.wl_ahi;
        info.retrieved_ms = retrieved_ms;
        const imagerworld::World world = imagerworld::worldProduct(field, spec.categorical, spec.world_mean);
        std::vector<float>().swap(field.data);
        OutBatch batch;
        world_batch(info, world, digest.hex_digest(), landed_mark(w, w.keys[0], w.field), &batch);
        if (batch.records) g_out.push_back(std::move(batch));
        done = true;
        return true;
    }
    bool on_response(const Outstanding& o, const Response& r, std::string* err) override {
        if (o.tag == kTagProbe) { probe.on(o, r); return true; }
        in_flight--;
        received++;
        const std::string& key = w.keys[o.index];
        if (r.status != 200) { *err = key + " answered HTTP " + std::to_string(r.status); return false; }
        feed(r);
        hdf5mini::File h(r.data, r.size);
        if (!h.open()) { *err = key + ": " + h.error(); return false; }
        const hdf5mini::Dataset* cmi = h.find("/Sectorized_CMI");
        const hdf5mini::Dataset* xs = h.find("/x");
        const hdf5mini::Dataset* ys = h.find("/y");
        if (!cmi || !xs || !ys || cmi->dims.size() != 2 || cmi->type.cls != 0) { *err = key + ": no 2-D integer Sectorized_CMI with x and y"; return false; }
        std::vector<uint8_t> raw, rx, ry;
        if (!h.read(*cmi, inflate_miniz, raw) || !h.read(*xs, inflate_miniz, rx) || !h.read(*ys, inflate_miniz, ry)) { *err = key + ": " + h.error(); return false; }
        const int th = int(cmi->dims[0]), tw = int(cmi->dims[1]);
        // the tile's place: x and y are stored as column / row indexes of the product (one add_offset and scale for the
        // whole disc), so the first of each is the tile's offset
        const int64_t c0 = int_at(rx.data(), xs->type.size, xs->type.isSigned), r0 = int_at(ry.data(), ys->type.size, ys->type.isSigned);
        if (c0 < 0 || r0 < 0 || c0 + tw > rows || r0 + th > rows || c0 % k || r0 % k || tw % k || th % k) { *err = key + ": tile outside the product grid"; return false; }
        if (field.grid.x.empty() && k == 1) field.grid = ahi_grid(n, 1);   // (the reference's least-squares line, exactly)
        if (field.grid.x.empty()) {
            // the band's fixed grid: x and y scale the column / row index the same way in every tile (one add_offset and
            // scale for the disc, microradians); the 0.5 km band's 2 km grid: the means of 4 (raw_satellite.py block_mean)
            const Scale64 gx = scale64(*xs), gy = scale64(*ys);
            const hdf5mini::Dataset* proj = h.find("/fixedgrid_projection");
            imagerworld::FixedGrid& g = field.grid;
            g.lon0 = proj ? hdf5mini::File::attrNumber(*proj, "longitude_of_projection_origin", kAhiLon0) : kAhiLon0;
            g.H = (proj ? hdf5mini::File::attrNumber(*proj, "perspective_point_height", kAhiHeight) : kAhiHeight) + g.req;
            g.sweepX = false;
            g.x.resize(size_t(n)); g.y.resize(size_t(n));
            for (int i = 0; i < n; i++) {
                double sx = 0, sy = 0;
                for (int j = 0; j < k; j++) { sx += (gx.offset + gx.scale * (i * k + j)) * 1e-6; sy += (gy.offset + gy.scale * (i * k + j)) * 1e-6; }
                g.x[size_t(i)] = sx / k; g.y[size_t(i)] = sy / k;
            }
        }
        const Scale64 s = scale64(*cmi);
        const size_t es = cmi->type.size;
        auto value = [&](int64_t i, int64_t j) -> double {
            const int64_t v = int_at(raw.data() + (size_t(i) * size_t(tw) + size_t(j)) * es, es, cmi->type.isSigned);
            if (s.hasFill && double(v) == s.fill) return std::nan("");
            return double(float(double(v) * s.scale + s.offset));
        };
        for (int i = 0; i < th / k; i++)
            for (int j = 0; j < tw / k; j++) {
                float out;
                if (k == 1) out = float(value(i, j));
                else {
                    // float64 block sum in numpy's order (the block's rows left to right, then the rows in turn)
                    double t = 0; int c = 0;
                    for (int a = 0; a < k; a++) {
                        double row = 0;
                        for (int b = 0; b < k; b++) { const double v = value(i * k + a, j * k + b); if (std::isfinite(v)) { row += v; c++; } }
                        t = a ? t + row : row;
                    }
                    out = c ? float(t / c) : imagerworld::nanf();
                }
                field.data[size_t(r0 / k + i) * size_t(n) + size_t(c0 / k + j)] = out;
            }
        return true;
    }
};

// ---- the L2 cloud retrievals: HDF5 read by byte range ----

struct H5Chunk { uint64_t address = 0, size = 0; uint32_t mask = 0; uint64_t row = 0, col = 0; };

struct AhiH5Job : Job {
    Probing probe;
    std::vector<std::string> fields, variables;   // still to fetch
    size_t fi = 0;                                // the field being fetched
    int stage = 0;
    std::deque<std::pair<uint64_t, std::vector<uint8_t>>> pieces;   // the header's bytes: the prefix, and blocks it points past
    int header_rounds = 0;
    std::vector<uint64_t> node_queue;
    size_t nodes_in_flight = 0;
    std::vector<H5Chunk> chunks;
    size_t chunk_next = 0, chunks_in_flight = 0;
    const hdf5mini::Dataset* ds = nullptr;
    std::unique_ptr<hdf5mini::File> head;
    imagerworld::Scaling scaling;
    imagerworld::Field field;
    static constexpr uint64_t kPrefix = 1 << 20;       // the header: every object header of these files is in it
    static constexpr uint64_t kNodeBytes = 8192;       // a chunk B-tree node (64 entries of 40 bytes)

    bool start_field(std::string* err) {
        ds = head->find("/" + variables[fi]);
        if (!ds || ds->dims.size() != 2 || ds->layout != 2 || ds->layoutVersion != 3 || ds->chunk.size() != 2) {
            *err = w.key + ": " + variables[fi] + " is not a 2-D chunked dataset with a version 1 B-tree"; return false;
        }
        if (ds->dims[0] != uint64_t(kAhiRows) || ds->dims[1] != uint64_t(kAhiRows)) { *err = w.key + ": " + variables[fi] + " is not on the 5500 x 5500 grid"; return false; }
        scaling = imagerworld::scalingOf(*ds);
        node_queue = {ds->address};
        chunks.clear(); chunk_next = 0;
        field.w = field.h = kAhiRows;
        field.data.assign(size_t(kAhiRows) * kAhiRows, imagerworld::nanf());
        field.grid = ahi_grid(kAhiRows, 1);
        stage = 3;
        return true;
    }
    bool step(std::string* err) override {
        if (stage == 0) {
            probe.fields = w.fields;
            for (const std::string& f : w.fields) probe.marks.push_back(landed_mark(w, w.key, f));
            probe.send(*this, w.timeout_ms);
            stage = 1;
            return true;
        }
        if (stage == 1) {
            for (const std::string& f : probe.left(w)) {
                fields.push_back(f);
                variables.push_back(w.variables[size_t(std::find(w.fields.begin(), w.fields.end(), f) - w.fields.begin())]);
            }
            if (fields.empty()) { done = true; return true; }
            request(get_request(object_url(w, w.key), std::string(kNoValidators) + range_header(0, std::min<uint64_t>(kPrefix, uint64_t(w.size)) - 1), w.timeout_ms), kTagH5Prefix, 0);
            stage = 2;
            return true;
        }
        if (stage == 2) {
            std::vector<hdf5mini::Segment> segs;
            for (const auto& pc : pieces) segs.push_back({pc.first, pc.second.data(), uint64_t(pc.second.size())});
            head.reset(new hdf5mini::File(segs));
            if (!head->open()) {
                // a header message past the bytes held (a continuation block, a heap): those bytes, then open again
                const uint64_t miss = head->missingAt();
                if (miss == UINT64_MAX || miss >= uint64_t(w.size) || ++header_rounds > 24) { *err = w.key + " header: " + head->error(); return false; }
                const uint64_t a = miss & ~uint64_t(65535), b = std::min<uint64_t>(a + 262144, uint64_t(w.size)) - 1;
                request(get_request(object_url(w, w.key), std::string(kNoValidators) + range_header(a, b), w.timeout_ms), kTagH5Prefix, size_t(a));
                return true;
            }
            if (!start_field(err)) return false;
        }
        if (stage == 3) {   // the chunk B-tree, a level a round
            if (nodes_in_flight) return true;
            if (!node_queue.empty()) {
                for (size_t q = 0; q < node_queue.size(); q++) {
                    const uint64_t a = node_queue[q], b = std::min<uint64_t>(a + kNodeBytes, uint64_t(w.size)) - 1;
                    request(get_request(object_url(w, w.key), std::string(kNoValidators) + range_header(a, b), w.timeout_ms), kTagH5Node, size_t(a));
                    nodes_in_flight++;
                }
                node_queue.clear();
                return true;
            }
            std::sort(chunks.begin(), chunks.end(), [](const H5Chunk& a, const H5Chunk& b) { return a.address < b.address; });
            stage = 4;
        }
        if (stage == 4) {   // the variable's chunks, 64 a round
            if (chunks_in_flight) return true;
            if (chunk_next < chunks.size()) {
                for (size_t c = 0; c < 64 && chunk_next < chunks.size(); c++, chunk_next++) {
                    const H5Chunk& ch = chunks[chunk_next];
                    request(get_request(object_url(w, w.key), std::string(kNoValidators) + range_header(ch.address, ch.address + ch.size - 1), w.timeout_ms), kTagH5Chunk, chunk_next);
                    chunks_in_flight++;
                }
                return true;
            }
            // the field whole: its world product
            const FieldSpec& spec = *field_spec(fields[fi]);
            RecordInfo info;
            info.work = &w; info.spec = &spec;
            info.platform.lon0 = kAhiLon0; info.platform.height = kAhiHeight;
            scan_times_ymd(w.key, &info.platform.scan_start, &info.platform.scan_end);
            info.model_id = w.sensor + " " + spec.model_id;
            info.source_url = "s3://" + w.bucket + "/" + w.key + "#" + variables[fi];
            info.wavelength = spec.wl_ahi;
            info.retrieved_ms = retrieved_ms;
            const imagerworld::World world = imagerworld::worldProduct(field, spec.categorical, spec.world_mean);
            std::vector<float>().swap(field.data);
            OutBatch batch;
            world_batch(info, world, digest.hex_digest(), landed_mark(w, w.key, fields[fi]), &batch);
            if (batch.records) g_out.push_back(std::move(batch));
            if (++fi < fields.size()) return start_field(err);
            done = true;
        }
        return true;
    }
    bool on_response(const Outstanding& o, const Response& r, std::string* err) override {
        if (o.tag == kTagProbe) { probe.on(o, r); return true; }
        if (r.status != 206 && r.status != 200) { *err = w.key + " answered HTTP " + std::to_string(r.status); return false; }
        feed(r);
        if (o.tag == kTagH5Prefix) {
            // held as contiguous runs (a message across two fetched blocks reads from one)
            pieces.emplace_back(uint64_t(o.index), std::vector<uint8_t>(r.data, r.data + r.size));
            std::sort(pieces.begin(), pieces.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
            std::deque<std::pair<uint64_t, std::vector<uint8_t>>> merged;
            for (auto& pc : pieces) {
                if (!merged.empty() && pc.first <= merged.back().first + merged.back().second.size()) {
                    auto& m = merged.back();
                    const uint64_t end = m.first + m.second.size(), pend = pc.first + pc.second.size();
                    if (pend > end) m.second.insert(m.second.end(), pc.second.begin() + long(end - pc.first), pc.second.end());
                } else merged.push_back(std::move(pc));
            }
            pieces.swap(merged);
            return true;
        }
        if (o.tag == kTagH5Node) {
            nodes_in_flight--;
            // a version 1 B-tree node of chunk type: "TREE", type 1, level, entries, siblings; then key, child, key, ...
            const uint8_t* p = r.data;
            const uint64_t at = uint64_t(o.index);
            if (r.size < 24 || memcmp(p, "TREE", 4) || p[4] != 1) { *err = w.key + ": no chunk B-tree node at " + std::to_string(at); return false; }
            const int level = p[5], entries = int(p[6] | (p[7] << 8));
            const size_t rank = ds->dims.size(), keySize = 8 + 8 * (rank + 1), need = 24 + size_t(entries) * (keySize + 8) + keySize;
            if (need > r.size) {   // a larger node than asked for: ask for all of it
                request(get_request(object_url(w, w.key), std::string(kNoValidators) + range_header(at, at + need - 1), w.timeout_ms), kTagH5Node, size_t(at));
                nodes_in_flight++;
                return true;
            }
            auto le = [&](size_t off, int bytes) { uint64_t v = 0; for (int i = 0; i < bytes; i++) v |= uint64_t(p[off + i]) << (8 * i); return v; };
            size_t q = 24;
            for (int e = 0; e < entries; e++) {
                const size_t key = q;
                const uint64_t child = le(q + keySize, 8);
                if (level > 0) node_queue.push_back(child);
                else {
                    H5Chunk ch;
                    ch.size = le(key, 4); ch.mask = uint32_t(le(key + 4, 4));
                    ch.row = le(key + 8, 8); ch.col = le(key + 16, 8); ch.address = child;
                    if (ch.size) chunks.push_back(ch);
                }
                q += keySize + 8;
            }
            return true;
        }
        // a chunk: the filters undone (deflate, shuffle), its elements scaled into the field
        chunks_in_flight--;
        const H5Chunk& ch = chunks[o.index];
        if (r.size != ch.size) { *err = w.key + ": chunk at " + std::to_string(ch.address) + " came back " + std::to_string(r.size) + " bytes, not " + std::to_string(ch.size); return false; }
        const size_t es = ds->type.size, cr = size_t(ds->chunk[0]), cc = size_t(ds->chunk[1]), bytes = cr * cc * es;
        std::vector<uint8_t> stage_bytes(r.data, r.data + r.size), raw(bytes), tmp;
        for (size_t f = ds->filters.size(); f-- > 0;) {
            if (ch.mask & (1u << f)) continue;
            const int id = ds->filters[f].id;
            if (id == 1) { if (!inflate_miniz(stage_bytes.data(), stage_bytes.size(), raw.data(), bytes)) { *err = w.key + ": inflate failed"; return false; } stage_bytes.assign(raw.begin(), raw.end()); }
            else if (id == 2) { const size_t m = stage_bytes.size() / es; tmp.resize(stage_bytes.size()); for (size_t i = 0; i < m; i++) for (size_t b = 0; b < es; b++) tmp[i * es + b] = stage_bytes[b * m + i]; stage_bytes.swap(tmp); }
            else { *err = w.key + ": filter " + std::to_string(id) + " unsupported"; return false; }
        }
        if (stage_bytes.size() < bytes) { *err = w.key + ": short chunk"; return false; }
        if (ds->type.bigEndian && es > 1) for (size_t i = 0; i + es <= bytes; i += es) std::reverse(stage_bytes.begin() + long(i), stage_bytes.begin() + long(i + es));
        for (size_t i = 0; i < cr; i++) {
            const uint64_t row = ch.row + i;
            if (row >= uint64_t(kAhiRows)) break;
            for (size_t j = 0; j < cc; j++) {
                const uint64_t col = ch.col + j;
                if (col >= uint64_t(kAhiRows)) break;
                field.data[size_t(row) * kAhiRows + size_t(col)] = imagerworld::scaled(scaling, stage_bytes.data() + (i * cc + j) * es);
            }
        }
        return true;
    }
};
// ---------------------------------------------------------------------------
// View imagery (EUMETSAT's public view service, WMS GetMap PNG): Meteosat-12 FCI and Meteosat-9 SEVIRI (IODC) discs,
// Metop-B/C AVHRR polar caps - raw_satellite.py mtgview_fields / polarview_fields / imagery_cloud on the WMS rendering
// (the WCS coverages the reference read are no longer served, 2026-10-14). Fields: the 10.x um brightness temperature
// from the grey; a cloud mask and top height from its contrast with the clear-sky temperature (the warmest nearby,
// capped by the GFS skin temperature); by day (Meteosat-12) a reflectance from the GeoColour image.
// ---------------------------------------------------------------------------

constexpr const char* kViewWms = "https://view.eumetsat.int/geoserver/wms";
constexpr const char* kGfsAws = "https://noaa-gfs-bdp-pds.s3.amazonaws.com";

struct GreyPoint { double grey, kelvin; };
// grey -> temperature tables matched to the MTG temperatures (raw_satellite.py IODC_GREY, METOP_GREY)
const GreyPoint kIodcGrey[] = {{0, 300.5}, {.9, 298.5}, {12.7, 295.2}, {19.4, 293.0}, {23.6, 290.9}, {29.1, 289.0}, {34.3, 287.2}, {40.7, 284.7}, {47.4, 282.4},
    {54.9, 280.5}, {61.0, 278.9}, {68.4, 276.8}, {77.3, 274.3}, {85.4, 271.0}, {96.5, 266.3}, {109.5, 260.4}, {124.4, 253.8},
    {143.4, 246.7}, {156.0, 242.4}, {173.6, 236.6}, {195.4, 228.3}, {243.1, 210.8}, {255, 206.4}};
const GreyPoint kMetopGrey[] = {{0, 305.0}, {48.1, 293.8}, {58.6, 289.1}, {64.5, 287.2}, {71.2, 284.9}, {77.5, 282.8}, {82.2, 280.9}, {87.7, 278.5}, {93.4, 276.4},
    {99.3, 274.9}, {106.7, 273.0}, {114.0, 270.5}, {123.0, 265.8}, {131.5, 262.3}, {139.3, 257.8}, {149.2, 253.8}, {160.7, 250.0},
    {172.4, 246.3}, {186.2, 241.7}, {206.4, 235.1}, {240.3, 224.3}, {255, 219.2}};

template <size_t N>
float interp_table(double g, const GreyPoint (&t)[N]) {
    if (g <= t[0].grey) return float(t[0].kelvin);
    for (size_t i = 1; i < N; i++) if (g <= t[i].grey) return float(t[i - 1].kelvin + (g - t[i - 1].grey) * (t[i].kelvin - t[i - 1].kelvin) / (t[i].grey - t[i - 1].grey));
    return float(t[N - 1].kelvin);
}

struct ViewSat {
    const char* id; bool polar; const char* layer; const char* layer2; const char* colour;
    double west, east, extent, step, lon0;
    int grey;   // 0: MTG WMS rendering, 1: IODC table, 2: Metop table
};
const ViewSat kViewSats[] = {
    {"meteosat", false, "mtg_fd:ir105_hrfi", nullptr, "mtg_fd:rgb_geocolour", -70, 70, 70, .02, 0.0, 0},
    {"meteosat-iodc", false, "msg_iodc:ir108", nullptr, nullptr, -30, 118, 76, .04, 45.5, 1},
    {"metop", true, "eps:m01_ir108", "eps:m03_ir108", nullptr, -180, 180, 90, .04, 0.0, 2},
};
constexpr double kPolarCap = 50, kOrbitMinutes = 101;

// The MTG FCI 10.5 um layer as the WMS renders it: the WCS legend (193.15 K at grey 0, 303.15 K at 255) inverted, and
// 0.644 K warmer than that inversion - matched to the reference's WCS temperatures over 104k world cells of the
// 2026-10-06 06 UTC frame (two 20-degree blocks; residual median 0.03 K). Grey 255 is the space round the disc.
float mtg_kelvin(int grey) { return float(303.15 + 0.644 - grey * 110.0 / 255.0); }

std::string iso_minute(int64_t ms) {
    const std::string s = format_iso_seconds(ms);   // YYYY-MM-DDTHH:MM:SSZ
    return s.substr(0, 16) + ":00.000Z";
}

struct ViewBlock { double south, west, north, east; int w, h, r0, c0; bool day; };

struct ViewJob : Job {
    const ViewSat* vs = nullptr;
    int stage = 0, nx = 0, ny = 0;
    std::vector<ViewBlock> blocks;
    // per window (polar: the latest orbit, then the one before for the blocks it left unseen)
    struct Get { size_t block; int layer; bool colour; int tries = 0; };   // layer 0/1; colour: the GeoColour image
    std::vector<Get> gets;
    size_t get_next = 0, in_flight = 0;
    int window = 0;
    std::string range;                     // the time (geo: the slot; polar: start/end of the orbit window)
    std::string windows_note;
    // geo: grey (0xffff missing), colour min channel (0xffff missing); polar: temperature sums and counts
    std::vector<uint16_t> grey, colour;
    std::vector<float> total, bt;
    std::vector<uint16_t> count;
    std::vector<float> local;              // the clear-sky temperature estimate, full size
    std::vector<float> skin; int sni = 0, snj = 0; double slat0 = 0, slon0 = 0, sdlat = 0, sdlon = 0;
    std::string skin_url, skin_range;
    int64_t time_ms = 0, scan0 = 0, scan1 = 0;
    bool any_ir = false;
    std::string missing_reason;

    // the sun's height over a block (every 4th pixel, and the last row and column)
    double day_mu(const ViewBlock& b) const {
        const viewimagery::Sun sun(time_ms + 300000);
        double m = -1;
        for (int r = 0; r < b.h; r = (r + 4 < b.h || r == b.h - 1) ? r + 4 : b.h - 1)
            for (int c = 0; c < b.w; c = (c + 4 < b.w || c == b.w - 1) ? c + 4 : b.w - 1) {
                const double v = sun.at(vs->extent - (b.r0 + r + .5) * vs->step, vs->west + (b.c0 + c + .5) * vs->step);
                if (v > m) m = v;
                if (c == b.w - 1) break;
            }
        return m;
    }
    void plan_blocks() {
        blocks.clear();
        if (!vs->polar) {
            const double block = 20;
            nx = int(std::lround((vs->east - vs->west) / vs->step)); ny = int(std::lround(2 * vs->extent / vs->step));
            for (double north = vs->extent; north > -vs->extent + 1e-9; north -= block)
                for (double west = vs->west; west < vs->east - 1e-9; west += block) {
                    ViewBlock b; b.north = north; b.south = std::max(-vs->extent, north - block); b.west = west; b.east = std::min(vs->east, west + block);
                    b.w = int(std::lround((b.east - b.west) / vs->step)); b.h = int(std::lround((b.north - b.south) / vs->step));
                    b.r0 = int(std::lround((vs->extent - b.north) / vs->step)); b.c0 = int(std::lround((b.west - vs->west) / vs->step));
                    b.day = vs->colour && day_mu(b) > .02;
                    blocks.push_back(b);
                }
        } else {
            nx = int(std::lround(360 / vs->step)); ny = int(std::lround(180 / vs->step));
            const double bands[2][2] = {{kPolarCap, 90}, {-90, -kPolarCap}};
            for (const auto& band : bands)
                for (double s0 = band[0]; s0 < band[1] - 1e-9; s0 += 20)
                    for (double w0 = -180; w0 < 180 - 1e-9; w0 += 60) {
                        ViewBlock b; b.south = s0; b.north = std::min(90.0, s0 + 20); b.west = w0; b.east = w0 + 60;
                        b.w = int(std::lround(60 / vs->step)); b.h = int(std::lround((b.north - b.south) / vs->step));
                        b.r0 = int(std::lround((90 - b.north) / vs->step)); b.c0 = int(std::lround((w0 + 180) / vs->step)); b.day = false;
                        blocks.push_back(b);
                    }
        }
    }
    std::string wms_url(const ViewBlock& b, const char* layer) const {
        return std::string(kViewWms) + "?service=WMS&version=1.3.0&request=GetMap&layers=" + layer + "&styles=&crs=EPSG:4326&bbox=" +
               format_number(b.south) + "," + format_number(b.west) + "," + format_number(b.north) + "," + format_number(b.east) +
               "&width=" + std::to_string(b.w) + "&height=" + std::to_string(b.h) + "&format=image/png&time=" + range;
    }
    void start_window(const std::vector<size_t>& which) {
        gets.clear(); get_next = 0;
        for (size_t k : which) {
            gets.push_back({k, 0, false, 0});
            if (vs->layer2) gets.push_back({k, 1, false, 0});
            if (blocks[k].day) gets.push_back({k, 0, true, 0});
        }
    }
    bool step(std::string* err) override {
        if (stage == 0) {
            for (const ViewSat& v : kViewSats) if (w.satellite == v.id) vs = &v;
            if (!vs) { *err = "no view imagery for satellite " + w.satellite; return false; }
            time_ms = w.frame_ms;
            plan_blocks();
            const size_t cells = size_t(nx) * size_t(ny);
            if (vs->polar) { total.assign(cells, 0.f); count.assign(cells, 0); }
            else { grey.assign(cells, 0xffff); if (vs->colour) colour.assign(cells, 0xffff); }
            // the GFS skin temperature valid at the frame: the cycle at least 4 hours before it
            int64_t cycle = time_ms - 4 * 3600000LL; cycle -= ((cycle % 21600000) + 21600000) % 21600000;
            const int lead = int(std::llround(double(time_ms - cycle) / 3600000.0));
            const std::string c = format_iso_seconds(cycle);   // YYYY-MM-DDTHH
            const std::string ymd = c.substr(0, 4) + c.substr(5, 2) + c.substr(8, 2), hh = c.substr(11, 2);
            std::string l = std::to_string(lead); while (l.size() < 3) l = "0" + l;
            skin_url = std::string(kGfsAws) + "/gfs." + ymd + "/" + hh + "/atmos/gfs.t" + hh + "z.pgrb2.0p25.f" + l;
            request(get_request(skin_url + ".idx", kNoValidators, w.timeout_ms), kTagGfsIdx, 0);
            stage = 1;
            return true;
        }
        if (stage == 1) {
            if (skin_range.empty()) { *err = skin_url + ".idx: no TMP:surface message"; return false; }
            request(get_request(skin_url, std::string(kNoValidators) + skin_range, w.timeout_ms), kTagGfsMsg, 0);
            stage = 2;
            return true;
        }
        if (stage == 2) {
            if (!vs->polar) range = iso_minute(time_ms);
            else range = iso_minute(time_ms - int64_t(kOrbitMinutes * 60000)) + "/" + iso_minute(time_ms);
            std::vector<size_t> all(blocks.size());
            for (size_t k = 0; k < all.size(); k++) all[k] = k;
            start_window(all);
            stage = 3;
        }
        if (stage == 3) {
            if (!missing_reason.empty()) { notice(w, w.fields[0], "missing"); for (size_t k = 1; k < w.fields.size(); k++) notice(w, w.fields[k], "missing");
                status("{\"missing\":[{\"satellite\":\"" + w.satellite + "\",\"frame_time_ms\":" + std::to_string(w.frame_ms) + ",\"why\":\"" + json_escape(missing_reason) +
                       "\"}],\"status\":304,\"unchanged\":true}");
                done = true; return true; }
            if (get_next < gets.size()) {
                for (size_t q = 0; q < 8 && get_next < gets.size(); q++, get_next++) {
                    const Get& g = gets[get_next];
                    request(get_request(wms_url(blocks[g.block], g.colour ? vs->colour : g.layer ? vs->layer2 : vs->layer), "", w.timeout_ms), kTagView, get_next);
                }
                return true;
            }
            if (vs->polar) {
                if (window == 0) {
                    // the blocks the latest orbit window left partly unseen: the window before, only there
                    std::vector<size_t> open;
                    for (size_t k = 0; k < blocks.size(); k++) {
                        const ViewBlock& b = blocks[k]; bool full = true;
                        for (int r = 0; r < b.h && full; r++) for (int c = 0; c < b.w; c++) if (!count[size_t(b.r0 + r) * nx + size_t(b.c0 + c)]) { full = false; break; }
                        if (!full) open.push_back(k);
                    }
                    bt.assign(total.size(), imagerworld::nanf());
                    for (size_t i = 0; i < total.size(); i++) if (count[i]) bt[i] = total[i] / float(count[i]);
                    scan0 = time_ms - int64_t(kOrbitMinutes * 60000); scan1 = time_ms;
                    windows_note = "latest orbit in [" + iso_minute(time_ms - int64_t(kOrbitMinutes * 60000)) + ", " + iso_minute(time_ms) + "]";
                    window = 1;
                    if (!open.empty()) {
                        const int64_t end = time_ms - int64_t(kOrbitMinutes * 60000);
                        range = iso_minute(end - int64_t(kOrbitMinutes * 60000)) + "/" + iso_minute(end);
                        windows_note += ", gaps from [" + iso_minute(end - int64_t(kOrbitMinutes * 60000)) + ", " + iso_minute(end) + "]";
                        scan0 = time_ms - 2 * int64_t(kOrbitMinutes * 60000);
                        std::fill(total.begin(), total.end(), 0.f); std::fill(count.begin(), count.end(), 0);
                        start_window(open);
                        return true;
                    }
                } else if (window == 1) {
                    for (size_t i = 0; i < bt.size(); i++) if (!std::isfinite(bt[i]) && count[i]) bt[i] = total[i] / float(count[i]);
                    window = 2;
                }
                std::vector<float>().swap(total); std::vector<uint16_t>().swap(count);
            } else { scan0 = time_ms; scan1 = time_ms + (std::string(vs->id) == "meteosat" ? 10 : 15) * 60000LL; }
            if (!any_ir) { missing_reason = "the view service served no imagery for " + range; return true; }
            compute_and_emit();
            done = true;
        }
        return true;
    }
    float bt_at(int r, int c) const {
        const size_t i = size_t(r) * nx + size_t(c);
        if (vs->polar) return bt[i];
        const uint16_t g = grey[i];
        if (g == 0xffff) return imagerworld::nanf();
        return vs->grey == 0 ? mtg_kelvin(g) : interp_table(double(g), kIodcGrey);
    }
    float skin_at(double la, double lo) const {
        double fy = (la - slat0) / sdlat; fy = fy < 0 ? 0 : fy > snj - 1 ? snj - 1 : fy;
        const double fx = imagerworld::pymod(lo - slon0, 360) / sdlon;
        const int y0 = int(std::floor(fy)), x0 = int(std::floor(fx)) % sni, y1 = std::min(y0 + 1, snj - 1), x1 = (x0 + 1) % sni;
        const double ty = fy - y0, tx = fx - std::floor(fx);
        auto f = [&](int y, int x) { return double(skin[size_t(y) * sni + size_t(x)]); };
        return float((f(y0, x0) * (1 - tx) + f(y0, x1) * tx) * (1 - ty) + (f(y1, x0) * (1 - tx) + f(y1, x1) * tx) * ty);
    }
    void compute_and_emit() {
        using namespace viewimagery;
        const bool wrap = vs->polar;
        // the clear-sky estimate (imagery_cloud): the warmest nearby of a 4x subsample, smoothed, enlarged back
        const int sh = (ny + 3) / 4, sw = (nx + 3) / 4;
        std::vector<float> small(size_t(sh) * sw);
        for (int r = 0; r < sh; r++) for (int c = 0; c < sw; c++) { const float v = bt_at(4 * r, 4 * c); small[size_t(r) * sw + c] = std::isfinite(v) ? v : 0.f; }
        uniform(small, sh, sw, 3, wrap); maximum(small, sh, sw, 19, wrap); uniform(small, sh, sw, 9, wrap);
        if (wrap) {   // enlarged with the first column after the last, so the dateline columns interpolate across it
            std::vector<float> ext(size_t(sh) * (sw + 1));
            for (int r = 0; r < sh; r++) { memcpy(&ext[size_t(r) * (sw + 1)], &small[size_t(r) * sw], size_t(sw) * 4); ext[size_t(r) * (sw + 1) + sw] = small[size_t(r) * sw]; }
            std::vector<float> big = resize(ext, sh, sw + 1, ny, nx + 4);
            local.assign(size_t(ny) * nx, 0.f);
            for (int r = 0; r < ny; r++) memcpy(&local[size_t(r) * nx], &big[size_t(r) * (nx + 4)], size_t(nx) * 4);
        } else local = resize(small, sh, sw, ny, nx);
        LatLon g;
        g.nx = nx; g.ny = ny; g.dx = vs->step; g.dy = -vs->step; g.polar = vs->polar;
        g.x0 = vs->west + .5 * vs->step; g.y0 = vs->extent - .5 * vs->step;
        if (!vs->polar) { g.view.lon0 = vs->lon0; g.view.H = 35786000.0 + g.view.req; g.view.sweepX = true; }
        g.precompute();
        const Sun sun(time_ms + 300000);
        auto contrast = [&](int r, int c, float b) {
            const float l = local[size_t(r) * nx + size_t(c)];
            const float clear = std::min(l > 150.f ? l : 400.f, skin_at(g.lat(r), g.lon(c)) - 1.f);
            return clear - b;
        };
        auto mask_of = [&](int r, int c) -> float {
            const float b = bt_at(r, c);
            if (!std::isfinite(b)) return imagerworld::nanf();
            float k = (contrast(r, c, b) - 2.f) / 10.f; k = k < 0 ? 0 : k > 1 ? 1 : k;
            return 3.f * k * k * (3.f - 2.f * k);
        };
        auto height_of = [&](int r, int c) -> float {
            const float b = bt_at(r, c);
            if (!std::isfinite(b)) return imagerworld::nanf();
            const float ct = contrast(r, c, b);
            float k = (ct - 2.f) / 10.f; k = k < 0 ? 0 : k > 1 ? 1 : k;
            if (!(3.f * k * k * (3.f - 2.f * k) > 1.5f)) return imagerworld::nanf();
            float h = ct / .0065f; return h < 0 ? 0 : h > 17000 ? 17000 : h;
        };
        auto refl_of = [&](int r, int c) -> float {
            const uint16_t v = colour[size_t(r) * nx + size_t(c)];
            if (v == 0xffff) return imagerworld::nanf();
            const float mu = float(sun.at(g.lat(r), g.lon(c)));
            if (!(mu > .02f)) return imagerworld::nanf();
            float cl = float(v) / 255.f; cl = cl < 0 ? 0 : cl > 1 ? 1 : cl;
            return std::pow(cl, 2.2f) * mu;
        };
        const std::string source_ir = std::string(kViewWms) + " " + vs->layer + (vs->layer2 ? std::string("+") + vs->layer2 : std::string()) + " " +
                                      (vs->polar ? windows_note : iso_minute(time_ms));
        for (const std::string& f : w.fields) {
            const FieldSpec& spec = *field_spec(f);
            RecordInfo info;
            info.work = &w; info.spec = &spec;
            info.platform.lon0 = vs->lon0; info.platform.height = vs->polar ? 817000.0 : 35786000.0;
            info.platform.scan_start = scan0; info.platform.scan_end = scan1;
            info.model_id = w.sensor + " imagery-derived estimate";
            info.source_url = f == "reflectance_064um" ? std::string(kViewWms) + " " + (vs->colour ? vs->colour : "") + " " + iso_minute(time_ms) : source_ir;
            info.wavelength = vs->polar ? 0 : spec.wl_view;
            info.retrieved_ms = retrieved_ms;
            imagerworld::World world;
            if (f == "brightness_temperature_10um") world = worldProduct(g, [&](int r, int c) { return bt_at(r, c); }, false, false);
            else if (f == "cloud_mask") world = worldProduct(g, mask_of, spec.categorical, spec.world_mean);
            else if (f == "cloud_top_height") world = worldProduct(g, height_of, false, false);
            else if (f == "reflectance_064um") {
                if (colour.empty()) continue;
                bool any = false;
                for (int r = 0; r < ny && !any; r += 7) for (int c = 0; c < nx; c += 7) if (std::isfinite(refl_of(r, c))) { any = true; break; }
                if (!any) continue;   // night over the disc: no reflectance (the reference publishes none)
                world = worldProduct(g, refl_of, false, false);
            } else continue;
            OutBatch batch;
            world_batch(info, world, digest.hex_digest(), "", &batch);
            if (batch.records) g_out.push_back(std::move(batch));
        }
    }
    bool on_response(const Outstanding& o, const Response& r, std::string* err) override {
        if (o.tag == kTagGfsIdx) {
            if (r.status != 200) { *err = skin_url + ".idx answered HTTP " + std::to_string(r.status); return false; }
            const std::string idx(reinterpret_cast<const char*>(r.data), r.size);
            size_t at = idx.find(":TMP:surface:");
            if (at == std::string::npos) return true;
            const size_t line = idx.rfind('\n', at) == std::string::npos ? 0 : idx.rfind('\n', at) + 1;
            const size_t next = idx.find('\n', at);
            const size_t c1 = idx.find(':', line);
            const long long start = atoll(idx.substr(c1 + 1).c_str());
            long long stop = -1;
            if (next != std::string::npos && next + 1 < idx.size()) { const size_t c2 = idx.find(':', next + 1); stop = atoll(idx.substr(c2 + 1).c_str()) - 1; }
            skin_range = stop > start ? range_header(uint64_t(start), uint64_t(stop)) : ",\"Range\":\"bytes=" + std::to_string(start) + "-\"";
            return true;
        }
        if (o.tag == kTagGfsMsg) {
            if (r.status != 206 && r.status != 200) { *err = skin_url + " answered HTTP " + std::to_string(r.status); return false; }
            feed(r);
            std::vector<grib2mini::Message> ms; std::string e;
            if (!grib2mini::parse(r.data, r.size, ms, e) || ms.empty()) { *err = skin_url + ": " + e; return false; }
            const grib2mini::Message& m = ms[0];
            std::vector<uint32_t> X;
            if (!grib2mini::unpack(r.data, m, nullptr, X, e)) { *err = skin_url + ": " + e; return false; }
            sni = int(m.ni); snj = int(m.nj); slat0 = m.la1; slon0 = m.lo1;
            sdlat = m.dj * ((m.scanMode & 0x40) ? 1 : -1); sdlon = m.di;
            skin.resize(X.size());
            const double p2 = std::pow(2.0, m.E), p10 = std::pow(10.0, m.D);
            for (size_t i = 0; i < X.size(); i++) skin[i] = X[i] == grib2mini::MISSING ? imagerworld::nanf() : float((double(m.R) + double(X[i]) * p2) / p10);
            return true;
        }
        // a WMS block
        const Get& gt = gets[o.index];
        const ViewBlock& b = blocks[gt.block];
        viewimagery::Image im; std::string e;
        // the public service answers 5xx (and 429) under load: the block again, later in the queue (raw_satellite.py
        // retried 8 times with a back-off; here the other blocks are the back-off)
        if ((r.status >= 500 || r.status == 429 || r.status == 0) && gt.tries < 7) {
            Get again = gt; again.tries++;
            gets.push_back(again);
            return true;
        }
        if (r.status != 200 || r.size < 8 || memcmp(r.data, "\x89PNG", 4)) {
            // (an OGC exception - the time not served yet - or a refusal: the frame is missing, tried again later)
            if (missing_reason.empty()) missing_reason = std::string(gt.colour ? vs->colour : gt.layer ? vs->layer2 : vs->layer) + " " + range + ": HTTP " + std::to_string(r.status) +
                                                         (r.size ? " " + std::string(reinterpret_cast<const char*>(r.data), std::min<size_t>(r.size, 160)) : "");
            return true;
        }
        feed(r);
        if (!viewimagery::decodePng(r.data, r.size, inflate_miniz, im, e)) { *err = "view block: " + e; return false; }
        if (im.w != b.w || im.h != b.h) { *err = "view block came back " + std::to_string(im.w) + " x " + std::to_string(im.h); return false; }
        if (gt.colour) {
            for (int y = 0; y < b.h; y++) for (int x = 0; x < b.w; x++) {
                const uint8_t* p = &im.rgba[(size_t(y) * b.w + x) * 4];
                colour[size_t(b.r0 + y) * nx + size_t(b.c0 + x)] = p[3] > 127 ? std::min(p[0], std::min(p[1], p[2])) : 0xffff;
            }
            return true;
        }
        if (!vs->polar) {
            for (int y = 0; y < b.h; y++) for (int x = 0; x < b.w; x++) {
                const uint8_t* p = &im.rgba[(size_t(y) * b.w + x) * 4];
                // no data: transparent; MTG's space (grey 255, the WCS's 0) and the tables' grey 0 (raw_satellite: a <= 0)
                const bool none = p[3] == 0 || (vs->grey == 0 ? p[0] == 255 : p[0] == 0);
                if (!none) any_ir = true;
                grey[size_t(b.r0 + y) * nx + size_t(b.c0 + x)] = none ? 0xffff : p[0];
            }
            return true;
        }
        // polar: pixels within 3 of the service's no-data are erratic (not at the block's own border) - left out
        std::vector<uint8_t> seen(size_t(b.w) * b.h);
        for (size_t i = 0; i < seen.size(); i++) seen[i] = im.rgba[i * 4 + 3] != 0 && im.rgba[i * 4] > 0;
        viewimagery::erode(seen, b.h, b.w, 3);
        for (int y = 0; y < b.h; y++) for (int x = 0; x < b.w; x++) {
            const size_t i = size_t(y) * b.w + x;
            if (!seen[i]) continue;
            any_ir = true;
            const size_t cell = size_t(b.r0 + y) * nx + size_t(b.c0 + x);
            total[cell] += interp_table(double(im.rgba[i * 4]), kMetopGrey); count[cell]++;
        }
        return true;
    }
};
JobPtr make_job(const Work& w) {
    JobPtr j;
    switch (w.kind) {
        case kWorkABI: j.reset(new AbiJob()); break;
        case kWorkAHITiles: j.reset(new AhiTilesJob()); break;
        case kWorkAHIH5: j.reset(new AhiH5Job()); break;
        case kWorkView: j.reset(new ViewJob()); break;
    }
    j->w = w;
    return j;
}

void forget(const std::string& identity) { g_known.erase(std::remove(g_known.begin(), g_known.end(), identity), g_known.end()); }

void fail_active(const std::string& err) {
    g_failures++;
    g_last_failure = err;
    status("{\"failed\":{\"satellite\":\"" + json_escape(g_active->w.satellite) + "\",\"frame_time_ms\":" + std::to_string(g_active->w.frame_ms) +
           ",\"job\":\"" + json_escape(g_active->w.identity) + "\",\"error\":\"" + json_escape(err) + "\"}}");
    forget(g_active->w.identity);
    g_active.reset();
    // (responses still in flight for it are dropped as they come)
}

int emit_side() {
    for (const std::string& s : g_side) {
        if (push_json(s[0] == 'n' ? "notices" : "status", s.substr(2)) < 0) return 500;
    }
    g_side.clear();
    return 0;
}

void set_yield(bool more) {
    plugin_set_backlog_remaining(more ? 1u : 0u);
    plugin_set_yielded(more ? 1 : 0);
}

int g_emitted = 0;   // batches this busy spell (since the engine was last idle)

// The engine: emit a finished batch (one a call), wait for responses, or advance the active job; idle when no work is
// left - then the spell's summary: the node's unchanged notice when it only found fields the node already holds, a
// refusal naming the last failure when a job failed.
int run() {
    for (int guard = 0; guard < 100000; guard++) {
        if (!g_out.empty()) {
            OutBatch b = std::move(g_out.front());
            g_out.erase(g_out.begin());
            if (emit_side() != 0) return 500;
            if (push_json("wxf_meta", b.meta) < 0) return 500;
            if (push_record_stream("wxf_records", "WXF.fbs", "$WXF", "WXF", b.stream) < 0) return 500;
            g_emitted++;
            const bool more = !g_out.empty() || (g_outstanding.empty() && (g_active || !g_queue.empty()));
            set_yield(more);
            return 0;
        }
        if (!g_outstanding.empty()) { set_yield(false); return emit_side(); }
        if (!g_active) {
            if (g_queue.empty()) {
                set_yield(false);
                if (g_landed_before && !g_emitted) status("{\"landed_before\":" + std::to_string(g_landed_before) + ",\"status\":304,\"unchanged\":true}");
                const int failures = g_failures;
                const std::string last = g_last_failure;
                g_landed_before = 0; g_failures = 0; g_last_failure.clear(); g_emitted = 0;
                if (emit_side() != 0) return 500;
                if (failures) {
                    const std::string msg = std::to_string(failures) + " imager job(s) failed; the last: " + last;
                    plugin_set_error("imager-job-failed", msg.c_str());
                    return 422;
                }
                return 0;
            }
            // each satellite's newest frame first, then the newest frames (a backfill never holds back the hour that just
            // came out, nor a satellite whose newest hour is late - Metop's arrives hours after it is flown)
            size_t pick = 0;
            for (size_t q = 1; q < g_queue.size(); q++) {
                const Work& a = g_queue[q];
                const Work& b = g_queue[pick];
                if (a.behind < b.behind || (a.behind == b.behind && a.frame_ms > b.frame_ms)) pick = q;
            }
            g_active = make_job(g_queue[pick]);
            g_queue.erase(g_queue.begin() + long(pick));
        }
        std::string err;
        if (!g_active->step(&err)) { fail_active(err); continue; }
        if (!g_active->requests.empty()) {
            for (size_t k = 0; k < g_active->requests.size(); k++) {
                if (push_json("requests", g_active->requests[k]) < 0) return 500;
                g_outstanding.push_back(g_active->pending[k]);
            }
            g_active->requests.clear();
            g_active->pending.clear();
            continue;
        }
        if (g_active->done) { forget(g_active->w.identity); g_active.reset(); }
    }
    plugin_set_error("imager-engine-stalled", "the imager job engine made no progress");
    return 500;
}

}  // namespace

extern "C" {

// parse: work jobs (imager-observation-source) and the http connector's responses to this node's own requests ->
// requests, $WXF batches (wxf_meta + wxf_records, one per invocation), notices and status. Resumed without input while
// it has work that needs no response.
int parse(void) {
    for (const plugin_input_frame_t* f : frames_on("work")) {
        Work w;
        std::string err;
        if (!read_work(frame_text(f), &w, &err)) { g_failures++; g_last_failure = err; status("{\"failed\":{\"error\":\"" + json_escape(err) + "\"}}"); continue; }
        if (std::find(g_known.begin(), g_known.end(), w.identity) != g_known.end()) continue;   // queued or active already
        g_known.push_back(w.identity);
        g_queue.push_back(std::move(w));
    }
    const std::vector<const plugin_input_frame_t*> responses = frames_on("responses");
    for (const plugin_input_frame_t* f : responses) {
        if (g_outstanding_next >= g_outstanding.size()) {
            plugin_set_error("unexpected-response", "a response arrived with no request of this node in flight; responses pair with requests in order.");
            return 400;
        }
        const Outstanding o = g_outstanding[g_outstanding_next++];
        Response r;
        if (f && f->payload && f->payload_length >= 8 && memcmp(f->payload, "$HRB", 4) == 0) {
            r.status = static_cast<int32_t>(static_cast<uint32_t>(f->payload[4]) | (static_cast<uint32_t>(f->payload[5]) << 8) |
                                            (static_cast<uint32_t>(f->payload[6]) << 16) | (static_cast<uint32_t>(f->payload[7]) << 24));
            r.data = f->payload + 8;
            r.size = f->payload_length - 8;
        }
        if (!g_active) continue;   // (a failed job's late responses)
        std::string err;
        if (!g_active->on_response(o, r, &err)) fail_active(err);
    }
    if (g_outstanding_next >= g_outstanding.size()) { g_outstanding.clear(); g_outstanding_next = 0; }
    return run();
}

}  // extern "C"
