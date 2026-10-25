/*
 * data-source/terrain-source — the PURE half of the terrain serving lane
 * (graph task `sdn-terrain-serving-module`).
 *
 * This plugin performs NO I/O. `capabilities: []`, runtime targets browser +
 * wasmedge, every method a single-pass transform over the frames the flow
 * hands it. Every DEM byte it decodes was fetched by
 * `com.digitalarsenal.hostcap.http-request`; scheduling, pyramid walking and
 * persistence live in the sibling terrain-ingest module, exactly as
 * geonames-source / geonames-ingest are split.
 *
 * Methods:
 *   tile       plan + dem granule responses -> records ($DTT stream), report
 *   layer_json plan                         -> response ($HTR envelope)
 *
 * WHY THE TIFF READER AND THE INFLATE ARE IN-GUEST.
 *
 * The source granules are DEFLATE-compressed Cloud-Optimized GeoTIFFs
 * (single-band Float32, tiled or strip layout, predictor 1 or the
 * floating-point predictor 3). There is no host GeoTIFF or inflate capability
 * and none may be added (owner law: all functionality is WASM over the
 * existing generic hooks), so miniz 3.1.2 is vendored (MIT, SHA-256 pinned,
 * re-verified every build by miniz-source.mjs — the same copy geonames-source
 * and cell-tower-source use) and a minimal little-endian TIFF/BigTIFF reader
 * lives here. Only the tags the granules actually carry are modelled; an
 * unsupported layout is REFUSED, never guessed at.
 *
 * VERTICAL DATUM — STATED, NEVER CONVERTED. The source dataset publishes
 * geoid-referenced heights (EGM2008). This encoder redistributes them AS
 * PUBLISHED: VERTICAL_DATUM = GEOID, VERTICAL_DATUM_NAME verbatim from the
 * plan. A quantized-mesh consumer that treats them as above-ellipsoid accepts
 * a bounded (<~100 m) error; the record's REMARKS and the report both state
 * it, so the parity floor is a stated decision rather than silent drift.
 *
 * NOTHING IS INVENTED. Dataset identity, epoch, retrieval time and licence
 * come verbatim from the plan frame and a plan that cannot state them is
 * refused — a tile published under a guessed epoch is comparable to the wrong
 * bytes, which is worse than no tile at all.
 */

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <map>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "HttpResponse_generated.h"
#include "FlowNotice_generated.h"
#include "ModuleConfig_generated.h"
// $DTT, $FSO and $FSB (spacedatastandards.org lib/cpp/<CODE>/main_generated.h) and the SDK's $HTQ / $HTR envelope
// headers are inlined ahead of this file by source.mjs.

namespace {

// ── tiny JSON readers (intra-flow control frames are all flat JSON) ─────────

bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

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
            const char esc = json[i + 1];
            if (esc == 'n') value.push_back('\n');
            else if (esc == 't') value.push_back('\t');
            else if (esc == 'r') value.push_back('\r');
            else value.push_back(esc);
            i += 2;
        } else {
            value.push_back(json[i]);
            i++;
        }
    }
    *out = value;
    return true;
}

std::string json_string(const std::string& json, const char* key, const char* fallback) {
    std::string v;
    if (json_string_field(json, key, &v)) return v;
    return fallback;
}

double json_number(const std::string& json, const char* key, double fallback) {
    const std::string needle = std::string("\"") + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return fallback;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return fallback;
    size_t i = colon + 1;
    while (i < json.size() && is_ws(json[i])) i++;
    if (i >= json.size()) return fallback;
    const char c = json[i];
    if (c != '-' && (c < '0' || c > '9')) return fallback;
    char* end = nullptr;
    const double v = strtod(json.c_str() + i, &end);
    return end == json.c_str() + i ? fallback : v;
}

bool json_bool(const std::string& json, const char* key, bool fallback) {
    const std::string needle = std::string("\"") + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return fallback;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return fallback;
    size_t i = colon + 1;
    while (i < json.size() && is_ws(json[i])) i++;
    if (json.compare(i, 4, "true") == 0) return true;
    if (json.compare(i, 5, "false") == 0) return false;
    return fallback;
}

// Extracts the RAW JSON value (object/array/scalar) under `key`, verbatim.
// Used for the plan's nested objects (provenance, waterMask) and for the
// availability index, which layer_json must pass through untouched: the
// orchestrator's knowledge is never re-serialized here.
bool json_raw_value(const std::string& json, const char* key, std::string* out) {
    const std::string needle = std::string("\"") + key + "\"";
    size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    size_t i = json.find(':', k + needle.size());
    if (i == std::string::npos) return false;
    i++;
    while (i < json.size() && is_ws(json[i])) i++;
    if (i >= json.size()) return false;
    if (json[i] == '{' || json[i] == '[') {
        const char open = json[i];
        const char close = open == '{' ? '}' : ']';
        int depth = 0;
        bool in_string = false;
        for (size_t j = i; j < json.size(); j++) {
            const char c = json[j];
            if (in_string) {
                if (c == '\\') j++;
                else if (c == '"') in_string = false;
                continue;
            }
            if (c == '"') in_string = true;
            else if (c == open) depth++;
            else if (c == close && --depth == 0) {
                *out = json.substr(i, j - i + 1);
                return true;
            }
        }
        return false;
    }
    size_t j = i;
    if (json[i] == '"') {
        for (j = i + 1; j < json.size(); j++) {
            if (json[j] == '\\') j++;
            else if (json[j] == '"') { j++; break; }
        }
    } else {
        while (j < json.size() && json[j] != ',' && json[j] != '}' && json[j] != ']' &&
               !is_ws(json[j])) {
            j++;
        }
    }
    *out = json.substr(i, j - i);
    return !out->empty();
}

std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
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

// ── base64 (the http connector hands bodies base64-encoded) ────────────────

int b64_value(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

std::string base64_decode(const std::string& in) {
    std::string out;
    out.reserve((in.size() / 4) * 3);
    uint32_t acc = 0;
    int bits = 0;
    for (const char c : in) {
        const int v = b64_value(c);
        if (v < 0) continue;
        acc = (acc << 6) | static_cast<uint32_t>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<char>((acc >> bits) & 0xff));
        }
    }
    return out;
}

// The http connector's response frame carries the body base64-encoded under
// "bodyB64" (browser harness dialect) or "body" with body_encoding base64
// (the Go host dialect). Both are read; a plain-text body is taken verbatim.
std::string response_body(const std::string& response) {
    std::string b64;
    if (json_string_field(response, "bodyB64", &b64) && !b64.empty()) return base64_decode(b64);
    std::string encoding = json_string(response, "body_encoding", "");
    std::string body;
    if (!json_string_field(response, "body", &body)) return std::string();
    if (encoding == "base64") return base64_decode(body);
    return body;
}

long response_status(const std::string& response) {
    return static_cast<long>(json_number(response, "status", 0));
}

// ── frame helpers ──────────────────────────────────────────────────────────

std::string input_text_at(const char* port_id, uint32_t ordinal) {
    const int32_t idx = plugin_find_input_index(port_id, ordinal);
    if (idx < 0) return std::string();
    const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(idx));
    if (!f || !f->payload) return std::string();
    return std::string(reinterpret_cast<const char*>(f->payload), f->payload_length);
}

std::string input_text(const char* port_id) { return input_text_at(port_id, 0); }

int push_json(const char* port, const std::string& json) {
    return plugin_push_output_ex(port, nullptr, nullptr,
                                 PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                                 reinterpret_cast<const uint8_t*>(json.data()),
                                 static_cast<uint32_t>(json.size()));
}

int push_dtt_stream(const char* port, const std::vector<uint8_t>& bytes) {
    return plugin_push_output_ex(port, "DTT.fbs", "$DTT", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "DTT", 0, 0, bytes.data(), static_cast<uint32_t>(bytes.size()));
}

// SURPLUS-FRAME REFUSAL. The compiled flow runtime drains a node's queue
// PORT-BLIND up to a budget of 64; maxStreams/maxBatch/drainPolicy are purely
// declarative there. A guest that reads ordinal 0 and returns therefore
// destroys every other frame it was handed (the live P1 that produced
// `modules-guest-nodes-drop-batched-frames`). The "dem" and "water" ports
// legitimately carry up to FOUR frames each — the corner granules of an extent
// that straddles a 2x2 granule neighbourhood — so their budget is 4; every
// other port is single-stream by contract.
constexpr uint32_t kBodyDemFrames = 16u;

uint32_t port_stream_budget(const char* port_id) {
    // A body plan reads up to 8 files of a product, a label and a range each (kBodyDemFrames); an Earth plan's
    // granules stay at four, checked where they are read.
    if (std::strcmp(port_id, "dem") == 0) return kBodyDemFrames;
    if (std::strcmp(port_id, "water") == 0) return 4u;
    // respond's "records": the store's result as ordered $FSB chunks of at most 1 MiB, one invocation's worth.
    if (std::strcmp(port_id, "records") == 0) return 64u;
    return 1u;
}

bool find_batched_input_port(char* message, size_t message_len) {
    const uint32_t count = plugin_get_input_count();
    for (uint32_t i = 0; i < count; i++) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        if (!frame || !frame->port_id) continue;
        uint32_t on_port = 0;
        for (uint32_t k = 0; k < count; k++) {
            const plugin_input_frame_t* f = plugin_get_input_frame(k);
            if (f && f->port_id && std::strcmp(f->port_id, frame->port_id) == 0) on_port++;
        }
        if (on_port <= port_stream_budget(frame->port_id)) continue;
        std::snprintf(message, message_len,
                      "This invocation carries %u frames on input port \"%s\" whose contract "
                      "admits %u (the compiled flow runtime drains a node's whole queue "
                      "port-blind; maxStreams is declarative only). The surplus frames are "
                      "refused rather than silently discarded.",
                      on_port, frame->port_id, port_stream_budget(frame->port_id));
        return true;
    }
    return false;
}

bool refuse_batched(void) {
    char message[384];
    if (!find_batched_input_port(message, sizeof(message))) return false;
    plugin_set_error("batched-input-frames", message);
    return true;
}

std::string fmt_double(double v) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.9g", v);
    return std::string(buf);
}

// ── SHA-256 (record DIGEST and ETag) ───────────────────────────────────────
//
// Themis: DIGEST and SIZE_BYTES are stated over the GZIPPED bytes — the bytes
// a cache actually stores and a client actually receives — and DIGEST is a
// lowercase-hex MULTIHASH, so the sha2-256 prefix 0x12 0x20 is part of the
// string. There is no host hashing capability and none may be added, so the
// digest is computed here.

struct Sha256 {
    uint32_t h[8] = {0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
                     0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u};
    uint8_t block[64] = {0};
    size_t block_len = 0;
    uint64_t total_bits = 0;

    static uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

    void compress(const uint8_t* p) {
        static const uint32_t k[64] = {
            0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,
            0x923f82a4u,0xab1c5ed5u,0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,
            0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,0xe49b69c1u,0xefbe4786u,
            0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
            0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,
            0x06ca6351u,0x14292967u,0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,
            0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,0xa2bfe8a1u,0xa81a664bu,
            0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
            0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,
            0x5b9cca4fu,0x682e6ff3u,0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,
            0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u};
        uint32_t w[64];
        for (int i = 0; i < 16; i++) {
            w[i] = (static_cast<uint32_t>(p[i * 4]) << 24) |
                   (static_cast<uint32_t>(p[i * 4 + 1]) << 16) |
                   (static_cast<uint32_t>(p[i * 4 + 2]) << 8) |
                   static_cast<uint32_t>(p[i * 4 + 3]);
        }
        for (int i = 16; i < 64; i++) {
            const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
            const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3];
        uint32_t e = h[4], f = h[5], g = h[6], hh = h[7];
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
        total_bits += static_cast<uint64_t>(len) * 8u;
        while (len > 0) {
            const size_t take = std::min(len, static_cast<size_t>(64) - block_len);
            std::memcpy(block + block_len, data, take);
            block_len += take;
            data += take;
            len -= take;
            if (block_len == 64) { compress(block); block_len = 0; }
        }
    }

    // Lowercase-hex sha2-256 MULTIHASH: 0x12 (sha2-256), 0x20 (32 bytes), digest.
    std::string multihash_hex() {
        const uint64_t bits = total_bits;
        uint8_t pad = 0x80;
        update(&pad, 1);
        total_bits = bits;  // the padding is not message length
        pad = 0x00;
        while (block_len != 56) { update(&pad, 1); total_bits = bits; }
        uint8_t tail[8];
        for (int i = 0; i < 8; i++) tail[i] = static_cast<uint8_t>((bits >> (56 - 8 * i)) & 0xff);
        std::memcpy(block + block_len, tail, 8);
        compress(block);
        block_len = 0;
        static const char* hex = "0123456789abcdef";
        std::string out = "1220";
        for (int i = 0; i < 8; i++) {
            for (int b = 3; b >= 0; b--) {
                const uint8_t byte = static_cast<uint8_t>((h[i] >> (8 * b)) & 0xff);
                out.push_back(hex[byte >> 4]);
                out.push_back(hex[byte & 0x0f]);
            }
        }
        return out;
    }
};

std::string sha256_multihash(const std::vector<uint8_t>& bytes) {
    Sha256 sha;
    if (!bytes.empty()) sha.update(bytes.data(), bytes.size());
    return sha.multihash_hex();
}

// ── decode byte budget ─────────────────────────────────────────────────────
//
// A source granule at the dataset's native post spacing is 3600x3600 float32 =
// 51.8 MB, and a tile whose corner spans four granules holds 207 MB of raster
// if each is decoded WHOLE. That is exactly what the first cut of this module
// did, and it sat flat at 235 MiB of guest memory on every invoke.
//
// Two DIFFERENT mechanisms answer that, and conflating them is how the first
// cut went wrong:
//
//   * WINDOWING (decode_geotiff_window, below) inflates only the internal
//     chunks that intersect the requested extent, so the resident raster is
//     proportional to the OUTPUT rather than to the granule. It is what keeps
//     the ordinary case small — it is not a safety property, because a large
//     enough extent still asks for a large window.
//   * kDecodeByteBudget IS the safety property: a named in-guest ceiling,
//     checked before ANY raster allocation and again before each subsequent
//     granule against the RUNNING total. A plan whose union extent would cross
//     it is REFUSED by name. A guest that instead traps on allocation takes
//     its pooled flow instance down with it and that instance never runs work
//     again — the live failure this ceiling exists to prevent.
// 512 MiB: an LDEM_512 run (the Moon's level 10, one 45-degree run of a block row with the halo) decodes a
// 270 MB window; the flows that run it give their guest 1 GiB of linear memory (host-config.py memory_pages).
constexpr size_t kDecodeByteBudget = 512u * 1024u * 1024u;  // 512 MiB

struct DecodeBudget {
    size_t used = 0;
    // Overflow-safe by construction: `used + bytes` is never formed.
    bool admit(size_t bytes) {
        if (bytes > kDecodeByteBudget || used > kDecodeByteBudget - bytes) return false;
        used += bytes;
        return true;
    }
};

void set_decode_budget_error(uint64_t requested, size_t used) {
    char message[384];
    std::snprintf(message, sizeof(message),
                  "this granule window needs %llu bytes on top of the %llu already resident, "
                  "past the %llu-byte in-guest decode budget. The plan is REFUSED rather than "
                  "decoded: a guest that traps on allocation takes its pooled flow instance "
                  "with it and that instance never runs work again. Split the plan into "
                  "smaller tile blocks.",
                  static_cast<unsigned long long>(requested),
                  static_cast<unsigned long long>(used),
                  static_cast<unsigned long long>(kDecodeByteBudget));
    plugin_set_error("decode-budget-exceeded", message);
}

// ── minimal little-endian TIFF / BigTIFF reader ────────────────────────────
//
// Models EXACTLY the shape the source COG granules use: little-endian, one
// sample per pixel, 32-bit IEEE float, tile or strip layout, compression 1
// (none) or 8 (DEFLATE, zlib-wrapped, via the vendored tinfl), predictor 1
// (none) or 3 (floating-point). Anything else is REFUSED with a reason —
// decoding an unmodelled layout to plausible heights would be fabricated
// terrain.

struct TiffTag {
    uint16_t id = 0;
    uint16_t type = 0;
    uint64_t count = 0;
    uint64_t value_or_offset = 0;  // inline when it fits, else file offset
    bool value_inline = false;
};

uint16_t rd16(const std::string& b, size_t at) {
    return static_cast<uint16_t>(static_cast<uint8_t>(b[at])) |
           (static_cast<uint16_t>(static_cast<uint8_t>(b[at + 1])) << 8);
}

uint32_t rd32(const std::string& b, size_t at) {
    return static_cast<uint32_t>(static_cast<uint8_t>(b[at])) |
           (static_cast<uint32_t>(static_cast<uint8_t>(b[at + 1])) << 8) |
           (static_cast<uint32_t>(static_cast<uint8_t>(b[at + 2])) << 16) |
           (static_cast<uint32_t>(static_cast<uint8_t>(b[at + 3])) << 24);
}

uint64_t rd64(const std::string& b, size_t at) {
    return static_cast<uint64_t>(rd32(b, at)) |
           (static_cast<uint64_t>(rd32(b, at + 4)) << 32);
}

size_t tiff_type_size(uint16_t type) {
    switch (type) {
        case 1: case 2: case 6: case 7: return 1;   // BYTE/ASCII/SBYTE/UNDEF
        case 3: case 8: return 2;                   // SHORT/SSHORT
        case 4: case 9: case 11: return 4;          // LONG/SLONG/FLOAT
        case 5: case 10: case 12: return 8;         // RATIONAL/SRATIONAL/DOUBLE
        case 16: case 17: return 8;                 // LONG8/SLONG8
        default: return 0;
    }
}

#include "body_geotiff.hpp"
#include "body_insets.hpp"

struct DemGrid {
    std::shared_ptr<BodyInset> inset;
    // The decoded WINDOW, not the granule: width/height are the sub-raster's.
    uint32_t width = 0;
    uint32_t height = 0;
    std::vector<float> samples;    // float32 elevation posts, row-major
    std::vector<uint8_t> classes;  // uint8 categorical samples (water-body mask)
    bool is_mask = false;
    // ── GEOREFERENCE OF THE WHOLE GRANULE, NEVER OF THE WINDOW ──────────────
    //
    // origin_lon/origin_lat are the model coordinate of the FULL raster's pixel
    // (0,0), and off_x/off_y are the window's integer pixel offset inside it.
    // Every sample index is therefore computed in FULL-granule coordinates and
    // only then shifted by an integer — which is exact — so the index a
    // coordinate resolves to is a pure function of that coordinate and the
    // granule file, identical in every invoke.
    //
    // It used to store the WINDOW's own origin (full_origin + wx0*scale). That
    // recomputation is NOT exact in doubles, and the window differs per invoke,
    // so two neighbouring tiles asking for the SAME global post could round a
    // half-post tie the opposite way: measured on the real regional pyramid,
    // 3 of 8,885 tile adjacencies disagreed on exactly one shared water-mask
    // byte, purely from this. The mask lattice is shared by construction
    // (lattice_lat/lattice_lon); the SAMPLE it resolves to must be too.
    double origin_lon = 0.0;
    double origin_lat = 0.0;
    long off_x = 0;  // window's first column in the full raster
    long off_y = 0;  // window's first row in the full raster
    double scale_lon = 0.0;  // positive eastward
    double scale_lat = 0.0;  // positive (subtracted going south)
    bool covers = false;     // the requested extent intersected this granule
    bool budget_refused = false;  // the error is already set; do not overwrite it
    bool ok = false;
    std::string error;
    // ── A BODY'S PDS PRODUCT (pds_img.hpp); unused by GeoTIFF granules ─────
    // proj 0 is the linear lon/lat georeference above; 1 is polar
    // stereographic, addressed in the product's own (sample, line) grid with
    // off_x/off_y the window's offset in it. full_rows is the product's line
    // count; the pole heights are the means of the first/last line.
    int proj = 0;
    long full_rows = 0;
    bool ps_south = false;
    double ps_center = 0.0, ps_scale_m = 0.0, ps_radius_m = 0.0;
    bool has_north_pole = false, has_south_pole = false;
    double north_pole_m = 0.0, south_pole_m = 0.0;
    size_t resident_bytes() const { return samples.size() * 4u + classes.size(); }
};

// Undo the TIFF floating-point predictor (3) for one decoded chunk of
// `rows` x `width` float32 samples: per row, cumulative-sum the byte stream,
// then de-interleave the big-endian byte planes back into little-endian
// floats. Predictor 1 needs nothing.
bool undo_predictor3(std::vector<uint8_t>* data, uint32_t width, uint32_t rows) {
    const size_t row_bytes = static_cast<size_t>(width) * 4;
    if (data->size() < row_bytes * rows) return false;
    std::vector<uint8_t> row(row_bytes);
    for (uint32_t r = 0; r < rows; r++) {
        uint8_t* p = data->data() + static_cast<size_t>(r) * row_bytes;
        for (size_t i = 1; i < row_bytes; i++) p[i] = static_cast<uint8_t>(p[i] + p[i - 1]);
        std::memcpy(row.data(), p, row_bytes);
        for (uint32_t i = 0; i < width; i++) {
            // Byte planes are stored most-significant first; floats here are
            // little-endian, so the planes reverse.
            p[static_cast<size_t>(i) * 4 + 0] = row[static_cast<size_t>(width) * 3 + i];
            p[static_cast<size_t>(i) * 4 + 1] = row[static_cast<size_t>(width) * 2 + i];
            p[static_cast<size_t>(i) * 4 + 2] = row[static_cast<size_t>(width) * 1 + i];
            p[static_cast<size_t>(i) * 4 + 3] = row[i];
        }
    }
    return true;
}

// Undo the TIFF horizontal predictor (2) for one chunk of 8-bit samples.
bool undo_predictor2_u8(std::vector<uint8_t>* data, uint32_t width, uint32_t rows) {
    if (data->size() < static_cast<size_t>(width) * rows) return false;
    for (uint32_t r = 0; r < rows; r++) {
        uint8_t* p = data->data() + static_cast<size_t>(r) * width;
        for (uint32_t i = 1; i < width; i++) p[i] = static_cast<uint8_t>(p[i] + p[i - 1]);
    }
    return true;
}

// ── WINDOWED GeoTIFF decode ────────────────────────────────────────────────
//
// Decodes ONLY the internal chunks (tiles or strips) that intersect
// [west,east] x [south,north], into a sub-raster of exactly that extent plus a
// one-pixel margin so every bilinear corner is resident. Peak memory is the
// window plus ONE chunk of scratch, which is what makes a four-granule tile
// cost megabytes instead of the 207 MB a whole-granule decode holds.
//
// `expect_mask` selects the categorical 8-bit lane (the water-body granule);
// otherwise the single-band Float32 elevation lane. An unmodelled layout is
// REFUSED, never guessed at: decoding it to plausible values would be
// fabricated terrain.
DemGrid decode_geotiff_window(const std::string& body, double west, double east, double south,
                              double north, bool expect_mask, DecodeBudget* budget) {
    DemGrid g;
    g.is_mask = expect_mask;
    if (body.size() < 16) { g.error = "body too short to be a TIFF"; return g; }
    if (!(body[0] == 'I' && body[1] == 'I')) {
        g.error = "not a little-endian TIFF (big-endian granules are refused, not byte-guessed)";
        return g;
    }
    const uint16_t magic = rd16(body, 2);
    bool big = false;
    size_t first_ifd = 0;
    if (magic == 42) {
        first_ifd = rd32(body, 4);
    } else if (magic == 43) {
        if (rd16(body, 4) != 8 || rd16(body, 6) != 0) { g.error = "malformed BigTIFF header"; return g; }
        big = true;
        first_ifd = static_cast<size_t>(rd64(body, 8));
    } else {
        g.error = "not a TIFF (bad magic)";
        return g;
    }

    // ── read the first IFD ──────────────────────────────────────────────────
    std::vector<TiffTag> tags;
    {
        const size_t entry_size = big ? 20 : 12;
        const size_t count_size = big ? 8 : 2;
        if (first_ifd + count_size > body.size()) { g.error = "IFD offset out of range"; return g; }
        const uint64_t n = big ? rd64(body, first_ifd) : rd16(body, first_ifd);
        size_t p = first_ifd + count_size;
        if (p + n * entry_size > body.size()) { g.error = "IFD runs past the file"; return g; }
        const size_t inline_room = big ? 8 : 4;
        for (uint64_t e = 0; e < n; e++, p += entry_size) {
            TiffTag t;
            t.id = rd16(body, p);
            t.type = rd16(body, p + 2);
            t.count = big ? rd64(body, p + 4) : rd32(body, p + 4);
            const size_t value_at = p + (big ? 12 : 8);
            const size_t byte_len = tiff_type_size(t.type) * static_cast<size_t>(t.count);
            if (byte_len != 0 && byte_len <= inline_room) {
                t.value_inline = true;
                t.value_or_offset = value_at;  // position of the inline bytes
            } else {
                t.value_or_offset = big ? rd64(body, value_at) : rd32(body, value_at);
            }
            tags.push_back(t);
        }
    }

    auto find_tag = [&](uint16_t id) -> const TiffTag* {
        for (const TiffTag& t : tags) if (t.id == id) return &t;
        return nullptr;
    };
    auto read_uint = [&](const TiffTag& t, uint64_t index, uint64_t* out) -> bool {
        const size_t esz = tiff_type_size(t.type);
        if (esz == 0 || index >= t.count) return false;
        const size_t at = static_cast<size_t>(t.value_or_offset) + index * esz;
        if (at + esz > body.size()) return false;
        if (t.type == 1) *out = static_cast<uint8_t>(body[at]);
        else if (t.type == 3) *out = rd16(body, at);
        else if (t.type == 4) *out = rd32(body, at);
        else if (t.type == 16) *out = rd64(body, at);
        else return false;
        return true;
    };
    auto read_double = [&](const TiffTag& t, uint64_t index, double* out) -> bool {
        if (t.type != 12 || index >= t.count) return false;
        const size_t at = static_cast<size_t>(t.value_or_offset) + index * 8;
        if (at + 8 > body.size()) return false;
        uint64_t bits = rd64(body, at);
        double v;
        std::memcpy(&v, &bits, 8);
        *out = v;
        return true;
    };
    auto uint_of = [&](uint16_t id, uint64_t fallback) -> uint64_t {
        const TiffTag* t = find_tag(id);
        uint64_t v = fallback;
        if (t) read_uint(*t, 0, &v);
        return v;
    };

    const uint64_t width = uint_of(256, 0);
    const uint64_t height = uint_of(257, 0);
    const uint64_t bits = uint_of(258, expect_mask ? 8 : 1);
    const uint64_t compression = uint_of(259, 1);
    const uint64_t samples_per_pixel = uint_of(277, 1);
    const uint64_t predictor = uint_of(317, 1);
    const uint64_t sample_format = uint_of(339, 1);

    if (width == 0 || height == 0 || width > 200000 || height > 200000) {
        g.error = "missing or implausible ImageWidth/ImageLength";
        return g;
    }
    if (expect_mask) {
        if (bits != 8 || samples_per_pixel != 1) {
            g.error = "water-body granule is not single-band 8-bit; an unmodelled sample "
                      "layout is refused, never reinterpreted as coastline";
            return g;
        }
        if (predictor != 1 && predictor != 2) {
            g.error = "water-body granule predictor is neither none (1) nor horizontal (2)";
            return g;
        }
    } else {
        if (bits != 32 || sample_format != 3 || samples_per_pixel != 1) {
            g.error = "granule is not single-band Float32 (BitsPerSample 32, SampleFormat 3); "
                      "an unmodelled sample layout is refused, never reinterpreted";
            return g;
        }
        if (predictor != 1 && predictor != 3) {
            g.error = "granule predictor is neither none (1) nor floating-point (3)";
            return g;
        }
    }
    if (compression != 1 && compression != 8) {
        g.error = "granule compression is neither none (1) nor DEFLATE (8)";
        return g;
    }

    // ── georeference: ModelTiepoint + ModelPixelScale ───────────────────────
    const TiffTag* tiepoint = find_tag(33922);
    const TiffTag* pixel_scale = find_tag(33550);
    if (!tiepoint || !pixel_scale || tiepoint->count < 6 || pixel_scale->count < 2) {
        g.error = "granule carries no ModelTiepoint/ModelPixelScale georeference";
        return g;
    }
    double tp_i = 0, tp_j = 0, tp_x = 0, tp_y = 0, sx = 0, sy = 0;
    if (!read_double(*tiepoint, 0, &tp_i) || !read_double(*tiepoint, 1, &tp_j) ||
        !read_double(*tiepoint, 3, &tp_x) || !read_double(*tiepoint, 4, &tp_y) ||
        !read_double(*pixel_scale, 0, &sx) || !read_double(*pixel_scale, 1, &sy) ||
        sx <= 0 || sy <= 0) {
        g.error = "malformed georeference tags";
        return g;
    }
    const double full_origin_lon = tp_x - tp_i * sx;
    const double full_origin_lat = tp_y + tp_j * sy;

    // ── the WINDOW: pixel rectangle covering the extent, one-pixel margin ────
    const double fx0 = (west - full_origin_lon) / sx;
    const double fx1 = (east - full_origin_lon) / sx;
    const double fy0 = (full_origin_lat - north) / sy;
    const double fy1 = (full_origin_lat - south) / sy;
    long wx0 = static_cast<long>(std::floor(fx0)) - 1;
    long wx1 = static_cast<long>(std::ceil(fx1)) + 1;
    long wy0 = static_cast<long>(std::floor(fy0)) - 1;
    long wy1 = static_cast<long>(std::ceil(fy1)) + 1;
    if (wx0 < 0) wx0 = 0;
    if (wy0 < 0) wy0 = 0;
    if (wx1 > static_cast<long>(width) - 1) wx1 = static_cast<long>(width) - 1;
    if (wy1 > static_cast<long>(height) - 1) wy1 = static_cast<long>(height) - 1;
    if (wx1 < wx0 || wy1 < wy0) {
        // The granule does not intersect the requested extent at all. That is
        // not an error and costs nothing: NOTHING is inflated.
        g.ok = true;
        g.covers = false;
        return g;
    }

    const uint32_t ww = static_cast<uint32_t>(wx1 - wx0 + 1);
    const uint32_t wh = static_cast<uint32_t>(wy1 - wy0 + 1);
    const size_t sample_bytes = expect_mask ? 1u : 4u;
    // Computed in 64 bits DELIBERATELY: size_t is 32-bit in this target, and a
    // declared geometry large enough to wrap it would wrap into a small,
    // admissible number. The budget must refuse the real figure.
    const uint64_t need64 =
        static_cast<uint64_t>(ww) * static_cast<uint64_t>(wh) * sample_bytes;
    // THE CEILING, checked BEFORE the assign and against the RUNNING total.
    if (need64 > kDecodeByteBudget || !budget->admit(static_cast<size_t>(need64))) {
        set_decode_budget_error(need64, budget->used);
        g.budget_refused = true;
        return g;
    }
    const size_t need = static_cast<size_t>(need64);

    g.width = ww;
    g.height = wh;
    if (expect_mask) g.classes.assign(need, 0);
    else g.samples.assign(static_cast<size_t>(ww) * wh, 0.0f);
    // THE FULL granule's origin, plus the window's integer offset. Never the
    // window's own recomputed origin — see the DemGrid comment.
    g.origin_lon = full_origin_lon;
    g.origin_lat = full_origin_lat;
    g.off_x = wx0;
    g.off_y = wy0;
    g.scale_lon = sx;
    g.scale_lat = sy;

    const TiffTag* tile_offsets = find_tag(324);
    const TiffTag* tile_counts = find_tag(325);
    const TiffTag* strip_offsets = find_tag(273);
    const TiffTag* strip_counts = find_tag(279);

    auto decode_chunk = [&](size_t at, size_t len, uint32_t chunk_w, uint32_t chunk_rows,
                            std::vector<uint8_t>* out) -> bool {
        if (at + len > body.size()) return false;
        const size_t expect = static_cast<size_t>(chunk_w) * chunk_rows * sample_bytes;
        if (compression == 1) {
            if (len < expect) return false;
            out->assign(body.begin() + at, body.begin() + at + expect);
        } else {
            size_t out_len = 0;
            void* raw = tinfl_decompress_mem_to_heap(body.data() + at, len, &out_len,
                                                     TINFL_FLAG_PARSE_ZLIB_HEADER);
            if (!raw) return false;
            out->assign(static_cast<uint8_t*>(raw), static_cast<uint8_t*>(raw) + out_len);
            mz_free(raw);
            if (out->size() < expect) return false;
        }
        if (!expect_mask && predictor == 3 && !undo_predictor3(out, chunk_w, chunk_rows)) return false;
        if (expect_mask && predictor == 2 && !undo_predictor2_u8(out, chunk_w, chunk_rows)) return false;
        return true;
    };

    // Copy one decoded chunk's overlap with the window into the sub-raster.
    auto blit = [&](const std::vector<uint8_t>& chunk, uint32_t chunk_w, long x_start,
                    long y_start, long y_last) {
        const long oy0 = std::max(y_start, wy0);
        const long oy1 = std::min(y_last, wy1);
        const long ox0 = std::max(x_start, wx0);
        const long ox1 = std::min(x_start + static_cast<long>(chunk_w) - 1, wx1);
        if (oy1 < oy0 || ox1 < ox0) return;
        const size_t run = static_cast<size_t>(ox1 - ox0 + 1);
        for (long r = oy0; r <= oy1; r++) {
            const size_t src =
                (static_cast<size_t>(r - y_start) * chunk_w + static_cast<size_t>(ox0 - x_start)) *
                sample_bytes;
            const size_t dst =
                static_cast<size_t>(r - wy0) * ww + static_cast<size_t>(ox0 - wx0);
            if (src + run * sample_bytes > chunk.size()) continue;
            if (expect_mask) std::memcpy(&g.classes[dst], chunk.data() + src, run);
            else std::memcpy(&g.samples[dst], chunk.data() + src, run * 4);
        }
    };

    std::vector<uint8_t> chunk;
    if (tile_offsets && tile_counts) {
        const uint64_t tw = uint_of(322, 0);
        const uint64_t th = uint_of(323, 0);
        if (tw == 0 || th == 0) { g.error = "tiled layout without TileWidth/TileLength"; return g; }
        const uint64_t across = (width + tw - 1) / tw;
        const uint64_t down = (height + th - 1) / th;
        for (uint64_t ty = 0; ty < down; ty++) {
            const long y_start = static_cast<long>(ty * th);
            const long y_last = y_start + static_cast<long>(th) - 1;
            if (y_last < wy0 || y_start > wy1) continue;  // WINDOW: never inflated
            for (uint64_t tx = 0; tx < across; tx++) {
                const long x_start = static_cast<long>(tx * tw);
                if (x_start + static_cast<long>(tw) - 1 < wx0 || x_start > wx1) continue;
                const uint64_t n = ty * across + tx;
                uint64_t at = 0, len = 0;
                if (!read_uint(*tile_offsets, n, &at) || !read_uint(*tile_counts, n, &len)) {
                    g.error = "tile offset/count tables shorter than the tile grid";
                    return g;
                }
                if (!decode_chunk(static_cast<size_t>(at), static_cast<size_t>(len),
                                  static_cast<uint32_t>(tw), static_cast<uint32_t>(th), &chunk)) {
                    g.error = "a tile failed to inflate; a partial raster is refused";
                    return g;
                }
                blit(chunk, static_cast<uint32_t>(tw), x_start, y_start, y_last);
            }
        }
    } else if (strip_offsets && strip_counts) {
        const uint64_t rows_per_strip = uint_of(278, height);
        if (rows_per_strip == 0) { g.error = "strip layout with RowsPerStrip 0"; return g; }
        const uint64_t strips = (height + rows_per_strip - 1) / rows_per_strip;
        for (uint64_t s = 0; s < strips; s++) {
            const long y_start = static_cast<long>(s * rows_per_strip);
            const uint64_t rows =
                std::min<uint64_t>(rows_per_strip, height - s * rows_per_strip);
            const long y_last = y_start + static_cast<long>(rows) - 1;
            if (y_last < wy0 || y_start > wy1) continue;  // WINDOW: never inflated
            uint64_t at = 0, len = 0;
            if (!read_uint(*strip_offsets, s, &at) || !read_uint(*strip_counts, s, &len)) {
                g.error = "strip offset/count tables shorter than the strip count";
                return g;
            }
            if (!decode_chunk(static_cast<size_t>(at), static_cast<size_t>(len),
                              static_cast<uint32_t>(width), static_cast<uint32_t>(rows), &chunk)) {
                g.error = "a strip failed to inflate; a partial raster is refused";
                return g;
            }
            blit(chunk, static_cast<uint32_t>(width), 0, y_start, y_last);
        }
    } else {
        g.error = "granule has neither tile nor strip layout tables";
        return g;
    }

    g.ok = true;
    g.covers = true;
    return g;
}

// ── DEM sampling ───────────────────────────────────────────────────────────

constexpr float kNoData = -32767.0f;

// ── FULL-GRANULE PIXEL COORDINATES ─────────────────────────────────────────
//
// The one place a geographic coordinate becomes a pixel index. It is expressed
// against the WHOLE granule's georeference, so it does not depend on which
// window this invoke happened to decode; the window's integer offset is
// subtracted afterwards, and subtracting an integer from a double of this
// magnitude is exact. Two invokes with different windows therefore resolve the
// same coordinate to the same post, including on an exact half-post tie.
double full_ix(const DemGrid& g, double lon) { return (lon - g.origin_lon) / g.scale_lon; }
double full_iy(const DemGrid& g, double lat) { return (g.origin_lat - lat) / g.scale_lat; }
double full_lon(const DemGrid& g, double ix) { return g.origin_lon + ix * g.scale_lon; }
double full_lat(const DemGrid& g, double iy) { return g.origin_lat - iy * g.scale_lat; }

// Does this granule window hold the position at all (half a post of slack at
// the edges, which is where a granule's own lattice ends)?
bool granule_holds(const DemGrid& g, double lon, double lat, double* px, double* py) {
    *px = full_ix(g, lon) - static_cast<double>(g.off_x);
    *py = full_iy(g, lat) - static_cast<double>(g.off_y);
    return !(*px < -0.5 || *py < -0.5 || *px > g.width - 0.5 || *py > g.height - 0.5);
}

// ONE POST, addressed by its geographic coordinate, from whichever granule of
// the set holds it. Posts sit at exact multiples of the granule's pixel scale
// from its origin, so a coordinate generated on one granule's lattice lands on
// an integer index in a neighbour that shares that lattice; a neighbour on a
// DIFFERENT lattice (Copernicus widens its longitude spacing at every
// latitude band boundary) does not, and is reported here as not holding the
// post. `band_sample` below is what answers those.
bool post_sample(const std::vector<DemGrid>& granules, double lon, double lat, float* out) {
    for (const DemGrid& g : granules) {
        if (!g.covers || g.samples.empty()) continue;
        const double fi = full_ix(g, lon);
        const double fj = full_iy(g, lat);
        const double ri = std::floor(fi + 0.5) - static_cast<double>(g.off_x);
        const double rj = std::floor(fj + 0.5) - static_cast<double>(g.off_y);
        if (std::fabs(fi - std::floor(fi + 0.5)) > 1e-3 ||
            std::fabs(fj - std::floor(fj + 0.5)) > 1e-3) {
            continue;
        }
        if (ri < 0 || rj < 0 || ri > g.width - 1 || rj > g.height - 1) continue;
        *out = g.samples[static_cast<size_t>(rj) * g.width + static_cast<size_t>(ri)];
        return true;
    }
    return false;
}

// ── THE LATITUDE-BAND BOUNDARY, WHERE THE LATTICE ITSELF CHANGES ───────────
//
// Copernicus GLO-30 keeps 1" of LATITUDE everywhere and widens its LONGITUDE
// spacing by band: 1" below 50 degrees, 1.5" to 60, 2" to 70, 3" to 80, 5" to
// 85 and 10" above. Two granules meeting across such a boundary therefore do
// NOT share a post lattice — N49_00_E009 is 3600x3600 at 1" while N50_00_E009
// is 2400x3600 at 1.5" — so post_sample rejects every stencil probe that
// crosses it and sample_dem fell back to the clamp the stencil exists to
// avoid. Measured on the real georeference with a 24-degree plane: the ENTIRE
// grid row nearest 50N clamped (65 posts of a z11 tile), displaced 0.0001252
// degrees = 13.9 m of ground, worth 6.331 m of vertical error there against
// <0.1 m on every other row — and INVISIBLE to the record's own
// VERTICAL_ACCURACY_M, because that probe compares the mesh against this same
// sampler. At z11 the post lattice lands 0.549 posts from the boundary at
// +/-50 and +/-85, i.e. across southern England, Belgium, Germany, Poland,
// Ukraine, the Canada-US border and Kamchatka.
//
// A post the OTHER band holds is not missing — it is on a different lattice,
// and the honest value there is that granule's own bilinear at the requested
// coordinate. It is a genuine interpolation of published posts, not a
// displacement of one, so it is used rather than counted as a clamp; the clamp
// stays for the case it was written for, a neighbour that is genuinely ABSENT.
bool granule_bilinear(const DemGrid& g, double lon, double lat, float* out) {
    double px = 0, py = 0;
    if (!granule_holds(g, lon, lat, &px, &py)) return false;
    const double cx = std::min(std::max(px, 0.0), static_cast<double>(g.width - 1));
    const double cy = std::min(std::max(py, 0.0), static_cast<double>(g.height - 1));
    const uint32_t x0 = static_cast<uint32_t>(cx);
    const uint32_t y0 = static_cast<uint32_t>(cy);
    const uint32_t x1 = std::min(x0 + 1, g.width - 1);
    const uint32_t y1 = std::min(y0 + 1, g.height - 1);
    const double gx = cx - x0;
    const double gy = cy - y0;
    const float s00 = g.samples[static_cast<size_t>(y0) * g.width + x0];
    const float s10 = g.samples[static_cast<size_t>(y0) * g.width + x1];
    const float s01 = g.samples[static_cast<size_t>(y1) * g.width + x0];
    const float s11 = g.samples[static_cast<size_t>(y1) * g.width + x1];
    if (s00 == kNoData || s10 == kNoData || s01 == kNoData || s11 == kNoData) {
        *out = kNoData;  // propagated; sample_dem reports it as no-data, not as height
        return true;
    }
    *out = static_cast<float>((1 - gy) * ((1 - gx) * s00 + gx * s10) +
                              gy * ((1 - gx) * s01 + gx * s11));
    return true;
}

// The stencil probe that post_sample could not place on any granule's lattice,
// answered by the granule that CONTAINS it, on that granule's own lattice.
bool band_sample(const std::vector<DemGrid>& granules, double lon, double lat, float* out) {
    for (const DemGrid& g : granules) {
        if (!g.covers || g.samples.empty()) continue;
        if (granule_bilinear(g, lon, lat, out)) return true;
    }
    return false;
}

// Bilinear sample of the DEM AS ONE CONTINUOUS POST LATTICE ACROSS GRANULES.
//
// It is not a per-granule sample any more, and that is the point. A granule's
// posts stop half a spacing short of its own east and south boundaries (the
// next post along belongs to the NEIGHBOUR granule), and the previous version
// CLAMPED there instead of reaching across: a post lying between the last post
// of one granule and the first of the next was served the edge post verbatim,
// a horizontal displacement of up to half a post (~15 m). Measured on the real
// regional pyramid that put a systematic crease along every whole-degree
// meridian in steep terrain — p50 3.28 m and max 11.56 m of vertical error on
// straddling z13 tiles against 0.018 m on interior ones, which BREACHES the
// z13 error bound (9.41 m) on tiles that are otherwise exact.
//
// The stencil's four posts are therefore fetched by geographic coordinate from
// whichever granule holds each. Where a neighbour is genuinely absent (an
// ocean 404, the edge of the fetched set, or a granule on a different
// longitude lattice) the old clamp is kept — but it is COUNTED, not silent.
bool sample_dem(const std::vector<DemGrid>& granules, double lon, double lat, double* out,
                bool* nodata, bool* clamped, bool* band_bridged = nullptr) {
    const DemGrid* home = nullptr;
    double px = 0, py = 0;
    for (const DemGrid& g : granules) {
        if (!g.covers || g.samples.empty()) continue;
        double cx = 0, cy = 0;
        if (granule_holds(g, lon, lat, &cx, &cy)) { home = &g; px = cx; py = cy; break; }
    }
    if (!home) return false;

    const double i0 = std::floor(px);
    const double j0 = std::floor(py);
    const double fx = px - i0;
    const double fy = py - j0;
    float s[4];
    bool complete = true;
    for (int k = 0; k < 4 && complete; k++) {
        const double di = k & 1 ? 1.0 : 0.0;
        const double dj = k & 2 ? 1.0 : 0.0;
        const double plon = full_lon(*home, static_cast<double>(home->off_x) + i0 + di);
        const double plat = full_lat(*home, static_cast<double>(home->off_y) + j0 + dj);
        complete = post_sample(granules, plon, plat, &s[k]);
        if (!complete && band_sample(granules, plon, plat, &s[k])) {
            complete = true;
            if (band_bridged) *band_bridged = true;
        }
    }
    if (!complete) {
        // No neighbour holds the missing post: clamp inside the home granule,
        // exactly as before, and say so.
        *clamped = true;
        const double cx = std::min(std::max(px, 0.0), static_cast<double>(home->width - 1));
        const double cy = std::min(std::max(py, 0.0), static_cast<double>(home->height - 1));
        const uint32_t x0 = static_cast<uint32_t>(cx);
        const uint32_t y0 = static_cast<uint32_t>(cy);
        const uint32_t x1 = std::min(x0 + 1, home->width - 1);
        const uint32_t y1 = std::min(y0 + 1, home->height - 1);
        const double gx = cx - x0;
        const double gy = cy - y0;
        s[0] = home->samples[static_cast<size_t>(y0) * home->width + x0];
        s[1] = home->samples[static_cast<size_t>(y0) * home->width + x1];
        s[2] = home->samples[static_cast<size_t>(y1) * home->width + x0];
        s[3] = home->samples[static_cast<size_t>(y1) * home->width + x1];
        if (s[0] == kNoData || s[1] == kNoData || s[2] == kNoData || s[3] == kNoData) {
            *nodata = true;
            *out = 0.0;
            return true;
        }
        *nodata = false;
        *out = (1 - gy) * ((1 - gx) * s[0] + gx * s[1]) + gy * ((1 - gx) * s[2] + gx * s[3]);
        return true;
    }
    if (s[0] == kNoData || s[1] == kNoData || s[2] == kNoData || s[3] == kNoData) {
        *nodata = true;
        *out = 0.0;
        return true;
    }
    *nodata = false;
    *out = (1 - fy) * ((1 - fx) * s[0] + fx * s[1]) + fy * ((1 - fx) * s[2] + fx * s[3]);
    return true;
}

// NEAREST-NEIGHBOUR sample of the categorical water-body lattice, across the
// granule set for the same reason the DEM is. A land/water class is never
// interpolated: averaging category ordinals invents a class the source never
// stated. But the NEAREST post to a position near a granule boundary often
// belongs to the neighbour, and clamping to the edge post instead is the same
// half-post displacement the DEM had — visible as a coastline that steps at
// every whole degree.
bool post_class(const std::vector<DemGrid>& granules, double lon, double lat, uint8_t* out) {
    for (const DemGrid& g : granules) {
        if (!g.covers || g.classes.empty()) continue;
        const double fi = full_ix(g, lon);
        const double fj = full_iy(g, lat);
        const double ri = std::floor(fi + 0.5) - static_cast<double>(g.off_x);
        const double rj = std::floor(fj + 0.5) - static_cast<double>(g.off_y);
        if (std::fabs(fi - std::floor(fi + 0.5)) > 1e-3 ||
            std::fabs(fj - std::floor(fj + 0.5)) > 1e-3) {
            continue;
        }
        if (ri < 0 || rj < 0 || ri > g.width - 1 || rj > g.height - 1) continue;
        *out = g.classes[static_cast<size_t>(rj) * g.width + static_cast<size_t>(ri)];
        return true;
    }
    return false;
}

bool sample_water(const std::vector<DemGrid>& granules, double lon, double lat, uint8_t* out) {
    const DemGrid* home = nullptr;
    double px = 0, py = 0;
    for (const DemGrid& g : granules) {
        if (!g.covers || g.classes.empty()) continue;
        double cx = 0, cy = 0;
        if (granule_holds(g, lon, lat, &cx, &cy)) { home = &g; px = cx; py = cy; break; }
    }
    if (!home) return false;
    const double ri = std::floor(px + 0.5);
    const double rj = std::floor(py + 0.5);
    if (ri >= 0 && rj >= 0 && ri <= home->width - 1 && rj <= home->height - 1) {
        *out = home->classes[static_cast<size_t>(rj) * home->width + static_cast<size_t>(ri)];
        return true;
    }
    // The nearest post is over a granule boundary: ask the set for it before
    // falling back to the home granule's edge post.
    const double plon = full_lon(*home, static_cast<double>(home->off_x) + ri);
    const double plat = full_lat(*home, static_cast<double>(home->off_y) + rj);
    if (post_class(granules, plon, plat, out)) return true;
    // ACROSS A LATITUDE-BAND BOUNDARY the neighbour is on a different
    // longitude lattice, so the post above does not exist there. The neighbour
    // still CONTAINS the position, and its own nearest post is the class the
    // source states for that ground — a category is chosen, never averaged.
    for (const DemGrid& g : granules) {
        if (!g.covers || g.classes.empty() || &g == home) continue;
        double bx = 0, by = 0;
        if (!granule_holds(g, plon, plat, &bx, &by)) continue;
        long nx = static_cast<long>(std::floor(bx + 0.5));
        long ny = static_cast<long>(std::floor(by + 0.5));
        if (nx < 0) nx = 0;
        if (ny < 0) ny = 0;
        if (nx > static_cast<long>(g.width) - 1) nx = static_cast<long>(g.width) - 1;
        if (ny > static_cast<long>(g.height) - 1) ny = static_cast<long>(g.height) - 1;
        *out = g.classes[static_cast<size_t>(ny) * g.width + static_cast<size_t>(nx)];
        return true;
    }
    long x = static_cast<long>(ri), y = static_cast<long>(rj);
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x > static_cast<long>(home->width) - 1) x = static_cast<long>(home->width) - 1;
    if (y > static_cast<long>(home->height) - 1) y = static_cast<long>(home->height) - 1;
    *out = home->classes[static_cast<size_t>(y) * home->width + static_cast<size_t>(x)];
    return true;
}

// ── body geometry: radii, ECEF, horizon occlusion (body_shape.hpp) ─────────

#include "body_shape.hpp"
#include "oct_normals.hpp"

// ── little-endian byte emitters ────────────────────────────────────────────

void put_u8(std::vector<uint8_t>* out, uint8_t v) { out->push_back(v); }

void put_u16(std::vector<uint8_t>* out, uint16_t v) {
    out->push_back(static_cast<uint8_t>(v & 0xff));
    out->push_back(static_cast<uint8_t>(v >> 8));
}

void put_u32(std::vector<uint8_t>* out, uint32_t v) {
    for (int i = 0; i < 4; i++) out->push_back(static_cast<uint8_t>((v >> (8 * i)) & 0xff));
}

void put_f32(std::vector<uint8_t>* out, float v) {
    uint32_t bits;
    std::memcpy(&bits, &v, 4);
    put_u32(out, bits);
}

void put_f64(std::vector<uint8_t>* out, double v) {
    uint64_t bits;
    std::memcpy(&bits, &v, 8);
    for (int i = 0; i < 8; i++) out->push_back(static_cast<uint8_t>((bits >> (8 * i)) & 0xff));
}

uint16_t zigzag16(int32_t delta) {
    return static_cast<uint16_t>(((delta << 1) ^ (delta >> 31)) & 0xffff);
}

// ── gzip via the vendored deflate ──────────────────────────────────────────
//
// miniz is compiled with MINIZ_NO_ZLIB_APIS, which removes the mz_deflate zlib
// wrapper but leaves tdefl_* and mz_crc32. gzip is therefore assembled by
// hand: 10-byte header, RAW deflate stream (no zlib header flag), CRC-32 and
// size trailer.
bool gzip_compress(const std::vector<uint8_t>& in, std::vector<uint8_t>* out) {
    size_t deflated_len = 0;
    void* deflated = tdefl_compress_mem_to_heap(in.data(), in.size(), &deflated_len,
                                                TDEFL_DEFAULT_MAX_PROBES);
    if (!deflated) return false;
    out->clear();
    out->reserve(deflated_len + 18);
    const uint8_t header[10] = {0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff};
    out->insert(out->end(), header, header + 10);
    out->insert(out->end(), static_cast<uint8_t*>(deflated),
                static_cast<uint8_t*>(deflated) + deflated_len);
    mz_free(deflated);
    const uint32_t crc =
        static_cast<uint32_t>(mz_crc32(MZ_CRC32_INIT, in.data(), in.size()));
    put_u32(out, crc);
    put_u32(out, static_cast<uint32_t>(in.size() & 0xffffffffu));
    return true;
}

// The reverse, for the one case the serving lane owes a client: bytes stored
// gzipped, asked for by something that stated it does not accept gzip. The
// header is only accepted in the exact shape gzip_compress writes — 10 bytes,
// no optional fields — because this is not a general gzip reader and guessing
// at a header shape this module never produces would be inventing a decoder.
bool gzip_decompress(const uint8_t* data, size_t length, std::vector<uint8_t>* out) {
    if (!data || length < 18) return false;
    if (data[0] != 0x1f || data[1] != 0x8b || data[2] != 8 || data[3] != 0) return false;
    const uint32_t isize = static_cast<uint32_t>(data[length - 4]) |
                           (static_cast<uint32_t>(data[length - 3]) << 8) |
                           (static_cast<uint32_t>(data[length - 2]) << 16) |
                           (static_cast<uint32_t>(data[length - 1]) << 24);
    // A tile's uncompressed mesh is bounded by the encoder's own ceiling; a
    // stated ISIZE past that is refused rather than allocated.
    if (isize == 0 || isize > 8u * 1024u * 1024u) return false;
    size_t inflated_len = 0;
    void* inflated = tinfl_decompress_mem_to_heap(data + 10, length - 18, &inflated_len, 0);
    if (!inflated) return false;
    const bool ok = inflated_len == isize;
    if (ok) {
        out->assign(static_cast<uint8_t*>(inflated),
                    static_cast<uint8_t*>(inflated) + inflated_len);
    }
    mz_free(inflated);
    return ok;
}

// Does this Accept-Encoding permit gzip? Token scan with the q-value read, so
// `gzip;q=0` and `identity` both correctly mean NO, and `*` means yes unless
// it is itself weighted zero.
bool accept_encoding_allows_gzip(const std::string& value) {
    bool star_allows = false, star_seen = false;
    size_t i = 0;
    while (i <= value.size()) {
        const size_t comma = value.find(',', i);
        const std::string field =
            value.substr(i, comma == std::string::npos ? std::string::npos : comma - i);
        i = comma == std::string::npos ? value.size() + 1 : comma + 1;
        size_t a = field.find_first_not_of(" \t");
        if (a == std::string::npos) continue;
        size_t b = field.find_first_of("; \t", a);
        std::string token = field.substr(a, b == std::string::npos ? std::string::npos : b - a);
        for (char& c : token) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        bool weighted_zero = false;
        const size_t q = field.find("q=");
        if (q != std::string::npos) {
            const double weight = std::atof(field.c_str() + q + 2);
            weighted_zero = weight <= 0.0;
        }
        if (token == "gzip") return !weighted_zero;
        if (token == "*") { star_seen = true; star_allows = !weighted_zero; }
    }
    return star_seen ? star_allows : false;
}

// ── the dataset contract carried on every plan frame ───────────────────────
//
// DTTProvenance requires DATASET_ID, DATASET_EPOCH, RETRIEVED_AT and LICENSE
// on EVERY record. All four come verbatim from the plan frame (the
// orchestrator owns dataset identity and made the fetch) and are never
// defaulted here.
struct DatasetContract {
    std::string dataset_id;
    std::string dataset_name;
    std::string dataset_epoch;
    std::string retrieved_at;
    std::string license;
    std::string license_url;
    std::string attribution;
    std::string source_url;
    std::string native_id;  // the source's own identifier for the product (a PDS LIDVID); stated when given
    bool complete() const {
        return !dataset_id.empty() && !dataset_epoch.empty() && !retrieved_at.empty() &&
               !license.empty();
    }
};

DatasetContract contract_of(const std::string& provenance_json) {
    DatasetContract c;
    c.dataset_id = json_string(provenance_json, "datasetId", "");
    c.dataset_name = json_string(provenance_json, "datasetName", "");
    c.dataset_epoch = json_string(provenance_json, "datasetEpoch", "");
    c.retrieved_at = json_string(provenance_json, "retrievedAt", "");
    c.license = json_string(provenance_json, "license", "");
    c.license_url = json_string(provenance_json, "licenseUrl", "");
    c.attribution = json_string(provenance_json, "attribution", "");
    c.source_url = json_string(provenance_json, "sourceUrl", "");
    return c;
}

// The same contract, read off a plan header's DTTProvenance (typed contracts 1.0).
DatasetContract contract_of(const DTTProvenance* p) {
    DatasetContract c;
    if (!p) return c;
    const auto text = [](const flatbuffers::String* v) { return v ? v->str() : std::string(); };
    c.dataset_id = text(p->DATASET_ID());
    c.dataset_name = text(p->DATASET_NAME());
    c.dataset_epoch = text(p->DATASET_EPOCH());
    c.retrieved_at = text(p->RETRIEVED_AT());
    c.license = text(p->LICENSE());
    c.license_url = text(p->LICENSE_URL());
    c.attribution = text(p->ATTRIBUTION());
    c.source_url = text(p->SOURCE_URL());
    c.native_id = text(p->NATIVE_ID());
    return c;
}

flatbuffers::Offset<DTTProvenance> build_provenance(flatbuffers::FlatBufferBuilder& b,
                                                    const DatasetContract& c) {
    const auto p_id = b.CreateString(c.dataset_id);
    const auto p_epoch = b.CreateString(c.dataset_epoch);
    const auto p_retrieved = b.CreateString(c.retrieved_at);
    const auto p_license = b.CreateString(c.license);
    const auto p_name = c.dataset_name.empty() ? 0 : b.CreateString(c.dataset_name);
    const auto p_license_url = c.license_url.empty() ? 0 : b.CreateString(c.license_url);
    const auto p_attribution = c.attribution.empty() ? 0 : b.CreateString(c.attribution);
    const auto p_source_url = c.source_url.empty() ? 0 : b.CreateString(c.source_url);
    const auto p_native_id = c.native_id.empty() ? 0 : b.CreateString(c.native_id);
    DTTProvenanceBuilder pb(b);
    pb.add_DATASET_ID(p_id);
    pb.add_DATASET_EPOCH(p_epoch);
    pb.add_RETRIEVED_AT(p_retrieved);
    pb.add_LICENSE(p_license);
    if (p_name.o) pb.add_DATASET_NAME(p_name);
    if (p_license_url.o) pb.add_LICENSE_URL(p_license_url);
    if (p_attribution.o) pb.add_ATTRIBUTION(p_attribution);
    if (p_source_url.o) pb.add_SOURCE_URL(p_source_url);
    if (p_native_id.o) pb.add_NATIVE_ID(p_native_id);
    return pb.Finish();
}

// ── serving lane helpers (route / respond) ─────────────────────────────────

// ── THE NODE CONFIG, TYPED ─────────────────────────────────────────────────
//
// plugin.getConfig is an SDS $PIV hostcall (typedHostcall.hpp) answering one ModuleConfig FlatBuffer (MCFG) on raw
// "config"; sdm_piv::get_config() verifies it and reads it in place. A frame on an optional "config" port (route /
// layer_json / respond) is the same ModuleConfig. The serving config is read from either through ONE reader,
// build_serving_config(const sdm_piv::ConfigTable&): scalars by key, and the availability index - the one large value -
// as a NumberList read as a span in place (see parse_availability). Nothing JSON ever crosses a port.
//
// The encoder's "options" frame (tile) is a handful of scalars; it is still folded into the small config object its
// readers were written against (module_config_object).
//
// TERRAIN_SOURCE_NO_HOST_BRIDGE compiles the hostcall OUT. It exists for ONE reason: the SDK's tri-runtime parity
// lane cannot execute a module that imports space_data_module_host at all (the wasmedge lanes run `wasmedge
// module.wasm` with no host module to link against). The SHIPPED artifact keeps the bridge; the parity artifact
// (npm run build:parity) answers every config read empty, and its callers hand the config in on the "config" port.
struct ConfigValue {
    std::string key;
    std::string json;  // the value as a JSON literal
};

std::string config_number_literal(double v) {
    char buf[40];
    if (std::isfinite(v) && v == std::floor(v) && std::fabs(v) < 1e15) {
        std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(v));
        return buf;
    }
    std::snprintf(buf, sizeof(buf), "%.17g", v);
    return buf;
}

struct ConfigNode {
    std::string name;
    bool leaf = false;
    std::string json;
    std::vector<ConfigNode> kids;
};

void config_insert(ConfigNode* root, const std::string& key, const std::string& json) {
    ConfigNode* node = root;
    size_t start = 0;
    while (true) {
        const size_t dot = key.find('.', start);
        const std::string part = key.substr(start, dot == std::string::npos ? std::string::npos : dot - start);
        ConfigNode* next = nullptr;
        for (ConfigNode& kid : node->kids) {
            if (kid.name == part) { next = &kid; break; }
        }
        if (!next) {
            node->kids.push_back(ConfigNode());
            node->kids.back().name = part;
            next = &node->kids.back();
        }
        node = next;
        if (dot == std::string::npos) break;
        start = dot + 1;
    }
    node->leaf = true;
    node->json = json;
}

bool config_all_digits(const std::string& s) {
    if (s.empty()) return false;
    for (const char c : s) if (c < '0' || c > '9') return false;
    return true;
}

std::string config_render(const ConfigNode& node) {
    if (node.leaf && node.kids.empty()) return node.json;
    bool array = !node.kids.empty();
    for (const ConfigNode& kid : node.kids) array = array && config_all_digits(kid.name);
    if (array) {
        std::vector<const ConfigNode*> ordered;
        for (const ConfigNode& kid : node.kids) ordered.push_back(&kid);
        std::sort(ordered.begin(), ordered.end(), [](const ConfigNode* a, const ConfigNode* b) {
            return std::strtoull(a->name.c_str(), nullptr, 10) < std::strtoull(b->name.c_str(), nullptr, 10);
        });
        // A flattened list cannot state an EMPTY element (it has no entries to flatten), so its index is simply
        // absent: the gap is restored as an empty element of its siblings' shape - a level with no availability
        // rectangles stays a level, and the levels after it keep their indices.
        std::string filler = "null";
        for (const ConfigNode* kid : ordered) {
            const std::string rendered = config_render(*kid);
            if (!rendered.empty() && rendered[0] == '[') { filler = "[]"; break; }
            if (!rendered.empty() && rendered[0] == '{') { filler = "{}"; break; }
        }
        std::string out = "[";
        size_t next = 0;
        for (const ConfigNode* kid : ordered) {
            const size_t index = static_cast<size_t>(std::strtoull(kid->name.c_str(), nullptr, 10));
            if (index > next + 100000) break;  // a sparse index is not a list; refuse to inflate it
            for (; next < index; next++) out += (next ? "," : "") + filler;
            out += (next ? "," : "") + config_render(*kid);
            next = index + 1;
        }
        return out + "]";
    }
    std::string out = "{";
    for (size_t i = 0; i < node.kids.size(); i++) {
        out += (i ? ",\"" : "\"") + json_escape(node.kids[i].name) + "\":" + config_render(node.kids[i]);
    }
    return out + "}";
}

std::string config_object(const std::vector<ConfigValue>& values) {
    ConfigNode root;
    for (const ConfigValue& v : values) {
        if (!v.key.empty()) config_insert(&root, v.key, v.json);
    }
    return root.kids.empty() ? std::string("{}") : config_render(root);
}

// One ModuleConfig entry (and, for its list kinds, its elements under dotted keys).
void module_config_values(const sdn::runtime::ConfigEntry* e, const std::string& prefix, std::vector<ConfigValue>* out) {
    if (!e || !e->KEY()) return;
    const std::string key = prefix + e->KEY()->str();
    switch (e->KIND()) {
        case sdn::runtime::configValueKind_String:
            out->push_back({key, "\"" + json_escape(e->STRING_VALUE() ? e->STRING_VALUE()->str() : std::string()) + "\""});
            break;
        case sdn::runtime::configValueKind_Number:
            out->push_back({key, config_number_literal(e->NUMBER_VALUE())});
            break;
        case sdn::runtime::configValueKind_Bool:
            out->push_back({key, e->BOOL_VALUE() ? "true" : "false"});
            break;
        case sdn::runtime::configValueKind_StringList:
            if (e->STRINGS())
                for (uint32_t i = 0; i < e->STRINGS()->size(); i++)
                    out->push_back({key + "." + std::to_string(i), "\"" + json_escape(e->STRINGS()->Get(i)->str()) + "\""});
            break;
        case sdn::runtime::configValueKind_NumberList:
            if (e->NUMBERS())
                for (uint32_t i = 0; i < e->NUMBERS()->size(); i++)
                    out->push_back({key + "." + std::to_string(i), config_number_literal(e->NUMBERS()->Get(i))});
            break;
        case sdn::runtime::configValueKind_TableList:
            if (e->TABLES())
                for (uint32_t i = 0; i < e->TABLES()->size(); i++) {
                    const auto* table = e->TABLES()->Get(i);
                    if (!table || !table->ENTRIES()) continue;
                    for (const auto* inner : *table->ENTRIES())
                        module_config_values(inner, key + "." + std::to_string(i) + ".", out);
                }
            break;
        default:
            break;
    }
}

// A ModuleConfig (MCFG) frame as the config object; `ok` false when the bytes are not one.
std::string module_config_object(const uint8_t* data, size_t length, bool* ok) {
    ::flatbuffers::Verifier verifier(data, length);
    if (!data || length < 8 || !sdn::runtime::VerifyModuleConfigBuffer(verifier)) {
        *ok = false;
        return "{}";
    }
    *ok = true;
    std::vector<ConfigValue> values;
    const auto* config = sdn::runtime::GetModuleConfig(data);
    if (config->ENTRIES())
        for (const auto* e : *config->ENTRIES()) module_config_values(e, "", &values);
    return config_object(values);
}

// ── THE SERVING CONFIG IS FETCHED ONCE PER INSTANCE, NOT ONCE PER REQUEST ──
//
// route() called plugin.getConfig on EVERY invoke, and at the configuration
// ruled for ship — a global z11 availability index — that single call is
// megabytes crossing the host boundary before anything about the request has
// been looked at. Measured warm on one instance, same address, p50 over 300
// invokes (60 above 408 KB): 0.054 ms at a 45-byte index, 0.210 ms at 11 KB,
// 4.668 ms at 408 KB, 66.264 ms at 5.9 MB, 104.553 ms at 9.3 MB. Caching the
// PARSE of the availability index (which this module already did) moved that
// by ~5%, because the parse was never the cost: an A/B at 4.4 MB with the same
// bytes parked in a key nothing reads still cost 5.96 ms/request — pure
// transfer plus the scans that walk past the value looking for later keys.
// At ship scale that is 15-18 tile requests/second per instance, against an
// acceptance bound of dozens of tiles per camera pose per client.
//
// So the config is read ONCE and kept. That is not an optimisation with a
// staleness risk bolted on, it is what the host contract already says: a
// mount's config block is materialised at MOUNT CONSTRUCTION
// (flowrt.mountNodeContext copies the map into the node context the mount's
// pool sees) and the pool's instances live as long as the mount, so the bytes
// plugin.getConfig returns cannot change under a running instance. An operator
// editing config edits the daemon's YAML and restarts the daemon, which
// rebuilds the mounts and the pools with them — the same restart the deploy
// recipe already requires.
//
// Per-request cost after this is one branch. Measured in
// tests/route-cost.test.mjs across 45 B / 9.7 KB / 318 KB / 6.9 MB indices,
// which is the gate: the spread across four orders of magnitude of index size
// must stay inside the noise of the smallest.
// (serving_config() below is that once-per-instance read.)

struct HeaderEntry {
    std::string name;
    std::string value;
};

int push_htr(uint16_t status, const std::vector<HeaderEntry>& headers, const uint8_t* body,
             size_t body_length) {
    flatbuffers::FlatBufferBuilder builder(body_length + 512);
    std::vector<::flatbuffers::Offset<sdn::http::HttpHeader>> header_offsets;
    header_offsets.reserve(headers.size());
    for (const auto& h : headers) {
        header_offsets.push_back(sdn::http::CreateHttpHeader(
            builder, builder.CreateString(h.name), builder.CreateString(h.value)));
    }
    const auto headers_vector =
        header_offsets.empty()
            ? ::flatbuffers::Offset<
                  ::flatbuffers::Vector<::flatbuffers::Offset<sdn::http::HttpHeader>>>(0)
            : builder.CreateVectorOfSortedTables<sdn::http::HttpHeader>(&header_offsets);
    const auto body_vector =
        body && body_length > 0
            ? builder.CreateVector<uint8_t>(body, body_length)
            : ::flatbuffers::Offset<::flatbuffers::Vector<uint8_t>>(0);
    const auto response =
        sdn::http::CreateHttpResponse(builder, status, headers_vector, body_vector, 0, 0);
    sdn::http::FinishHttpResponseBuffer(builder, response);
    const int32_t pushed = plugin_push_output_ex(
        "response", "HttpResponseAbi.fbs", "$HTR", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
        "HttpResponse", 0, 0, builder.GetBufferPointer(), builder.GetSize());
    return pushed < 0 ? 500 : 0;
}

// ── EVERY RESPONSE THIS MODULE EMITS CARRIES THE SAME MIME POLICY ──────────
//
// A tile and layer.json both carry x-content-type-options: nosniff; the JSON
// errors did not, and the 404 is the ONE response whose body REFLECTS
// client-controlled text (the requested path, bounded to 160 bytes and JSON
// escaped, but still attacker-chosen bytes). A same-origin response that echoes
// attacker bytes and declines to forbid MIME sniffing is the exact combination
// nosniff exists for, and this one is publicly cacheable for 300 s on the
// origin the console shares. Coordinator resolution 2026-08-27 (5): all JSON
// error responses carry nosniff AND an explicit cache policy, like tiles.
//
// `cache_control` is therefore no longer optional. A response with no cache
// policy is a response whose caching is decided by whatever sits in front of
// it, which is not a policy, and every caller already had one to state.
int push_htr_json(uint16_t status, const std::string& body, const char* cache_control) {
    std::vector<HeaderEntry> headers = {
        {"content-type", "application/json"},
        {"x-content-type-options", "nosniff"},
        {"cache-control", cache_control && *cache_control ? cache_control : "no-store"},
    };
    return push_htr(status, headers,
                    reinterpret_cast<const uint8_t*>(body.data()), body.size());
}

// A cheap, honest, CACHEABLE 404: the client's own upsampling relies on
// layer.json availability, so a miss below the published pyramid is normal
// traffic and must never surface as an error or a cache-buster.
//
// The detail is TRUNCATED to a fixed budget. It routinely carries the request
// path, which is client-controlled and (with the host's 1 MiB request-line
// default) can be ~1 MB; a 404 body that tracks the request turns every junk
// URL into a megabyte-scale PUBLICLY CACHEABLE entry. 160 bytes names the
// address a person needs and nothing more.
constexpr size_t kNotFoundDetailBytes = 160;

// ── ONE TILE, ONE URL — ON THE 404s TOO ────────────────────────────────────
//
// The cache-key discipline this module closed twice on 200s (leading-zero
// addresses, the mount search fallback) was left open on 404s: every miss
// answered `public, max-age=300` with the request path echoed in the body, so
// /api/v1/terrain/1/1/<anything>.terrain was an unbounded family of distinct,
// publicly cacheable keys — junk an anonymous client could park in edge cache
// 200 bytes at a time, for five minutes each, and the echo made every one a
// different body.
//
// A 404 is PUBLICLY CACHEABLE ONLY WHEN THE REQUEST NAMED A REAL ADDRESS: it
// parsed as a canonical z/x/y (parse_tile_path already refuses every
// non-canonical spelling), the address exists at that level, and the level is
// inside the tileset's own depth — `maxLevel`, carried on the serve context
// from the same config layer.json declares maxzoom from, and fail-closed when
// the context does not state it. That is the honest cacheable miss — a tile
// outside availability that nobody was promised — and its key family is
// bounded by the pyramid's address space rather than by what a caller can
// type. Everything else is a REFUSAL, not a miss: `no-store`, and a fixed
// body that echoes nothing back, so a malformed request costs one small
// response and leaves nothing behind it.
int push_htr_not_found(const std::string& detail, bool cacheable) {
    if (!cacheable) {
        return push_htr_json(404,
                             "{\"error\":\"not found\",\"detail\":\"not a tile address in "
                             "this tileset\"}",
                             "no-store");
    }
    std::string bounded = detail;
    if (bounded.size() > kNotFoundDetailBytes) {
        bounded.resize(kNotFoundDetailBytes);
        bounded += "...";
    }
    return push_htr_json(404,
                         std::string("{\"error\":\"not found\",\"detail\":\"") +
                             json_escape(bounded) + "\"}",
                         "public, max-age=300");
}

// Parse "<z>/<x>/<y>.terrain" (all decimal, nothing else) after the mount.
//
// ONE ADDRESS, ONE URL — including the spelling of its digits. A LEADING ZERO
// is refused: "8", "08", "008" and "000000008" all parsed to 8, so a single
// tile was reachable at 9x7x7 = 441 distinct publicly-cacheable URLs, each one
// a separate cache key costing a full store query and ~9 KB of cache for the
// identical bytes. There is exactly one canonical decimal spelling of a tile
// index and this accepts only that one; "0" itself is canonical and stays.
bool parse_tile_path(const std::string& rest, uint32_t* z, uint32_t* x, uint32_t* y) {
    const size_t suffix = rest.rfind(".terrain");
    if (suffix == std::string::npos || suffix + 8 != rest.size()) return false;
    const std::string zxy = rest.substr(0, suffix);
    const size_t s1 = zxy.find('/');
    if (s1 == std::string::npos) return false;
    const size_t s2 = zxy.find('/', s1 + 1);
    if (s2 == std::string::npos || zxy.find('/', s2 + 1) != std::string::npos) return false;
    const std::string parts[3] = {zxy.substr(0, s1), zxy.substr(s1 + 1, s2 - s1 - 1),
                                  zxy.substr(s2 + 1)};
    uint32_t vals[3];
    for (int i = 0; i < 3; i++) {
        if (parts[i].empty() || parts[i].size() > 9) return false;
        if (parts[i].size() > 1 && parts[i][0] == '0') return false;
        uint64_t v = 0;
        for (const char c : parts[i]) {
            if (c < '0' || c > '9') return false;
            v = v * 10 + static_cast<uint64_t>(c - '0');
        }
        if (v > 0xffffffffull) return false;
        vals[i] = static_cast<uint32_t>(v);
    }
    *z = vals[0];
    *x = vals[1];
    *y = vals[2];
    return true;
}

// ── amortization + serving constants ───────────────────────────────────────
//
// PER-TILE GZIPPED CEILING, enforced at ENCODE time. The serving lane's own
// bound (Hermes): a tile past it is refused where it is produced, not
// discovered later by a client that already paid for the transfer.
constexpr size_t kTileGzipCeilingBytes = 32u * 1024u;  // 32 KiB

// The water-mask raster geometry this encoder cuts. N stays 256 at EVERY
// level (Atlas): a mask whose resolution changed with depth would make the
// shared-edge identity below untestable.
constexpr uint32_t kMaskSize = 256;

// Split a JSON array of objects into its depth-0 members.
std::vector<std::string> split_json_objects(const std::string& array_json) {
    std::vector<std::string> out;
    int depth = 0;
    bool in_string = false;
    size_t start = 0;
    for (size_t i = 0; i < array_json.size(); i++) {
        const char c = array_json[i];
        if (in_string) {
            if (c == '\\') i++;
            else if (c == '"') in_string = false;
            continue;
        }
        if (c == '"') in_string = true;
        else if (c == '{') { if (depth++ == 0) start = i; }
        else if (c == '}') { if (--depth == 0) out.push_back(array_json.substr(start, i - start + 1)); }
    }
    return out;
}

// ── the http response lane ─────────────────────────────────────────────────
//
// Janus (e): com.digitalarsenal.hostcap.http-request is the ONLY fetch hook for both the elevation and the water-body
// granules. Typed contracts 1.0: every response is an HttpResponse (HRSP, module-sdk runtime type) whose BODY is the
// granule verbatim - no base64, no JSON dialect, no $HRB side lane. STATUS 0 is the connector's own failure (ERROR says
// why): it is neither a granule nor open ocean, so it is refused like any other non-2xx.
struct HttpFrame {
    bool present = false;
    bool invalid = false;
    long status = 0;
    std::string body;
    std::string error;
    std::string content_type;
    std::string content_range;  // a body's PDS product is read by whole-line ranges
};

HttpFrame http_input_at(const char* port_id, uint32_t ordinal) {
    HttpFrame f;
    const int32_t idx = plugin_find_input_index(port_id, ordinal);
    if (idx < 0) return f;
    const plugin_input_frame_t* frame = plugin_get_input_frame(static_cast<uint32_t>(idx));
    if (!frame) return f;
    f.present = true;
    ::flatbuffers::Verifier verifier(frame->payload ? frame->payload : reinterpret_cast<const uint8_t*>(""),
                                     frame->payload ? frame->payload_length : 0);
    if (!frame->payload || frame->payload_length < 8 || !sdn::runtime::VerifyHttpResponseBuffer(verifier)) {
        f.invalid = true;
        return f;
    }
    const sdn::runtime::HttpResponse* r = sdn::runtime::GetHttpResponse(frame->payload);
    f.status = r->STATUS();
    if (r->BODY()) f.body.assign(reinterpret_cast<const char*>(r->BODY()->data()), r->BODY()->size());
    if (r->ERROR()) f.error = r->ERROR()->str();
    if (r->HEADERS()) {
        for (const auto* h : *r->HEADERS()) {
            if (!h || !h->NAME() || !h->VALUE()) continue;
            std::string name = h->NAME()->str();
            for (char& c : name) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
            if (name == "content-range") f.content_range = h->VALUE()->str();
            if (name == "content-type") f.content_type = h->VALUE()->str();
        }
    }
    return f;
}

// ── one tile of the plan ───────────────────────────────────────────────────

struct TileJob {
    uint32_t level = 0;
    uint32_t x = 0;
    uint32_t y = 0;
    uint32_t child_availability = 0;
};

struct TileStats {
    uint64_t nodata = 0;
    uint64_t uncovered = 0;
    // Mask posts no water granule classified. `mask_from_absence` is the
    // honest ocean inference (no elevation granule covers the post either);
    // `mask_unclassified` is a gap in the mask lane over terrain that DOES
    // have elevation, which is a defect in the plan, not data.
    uint64_t mask_from_absence = 0;
    uint64_t mask_unclassified = 0;
    // Posts whose bilinear stencil could not be completed across the granule
    // set and fell back to the home granule's edge post. Reported, never
    // silent: it is the residual of the cross-granule sampling fix and the
    // signal that a neighbour granule is missing from the plan.
    uint64_t edge_clamped = 0;
    // Posts whose bilinear stencil crossed a LATITUDE-BAND BOUNDARY, where the
    // source changes longitude spacing and the neighbour granule has no post
    // at the requested coordinate. Interpolated on that granule's own lattice
    // rather than clamped — reported so the two cases stay distinguishable.
    uint64_t band_bridged = 0;
    // The mesh's own measured departure from the source between posts, metres,
    // and how many probes it is a maximum over. Stated on the record as
    // VERTICAL_ACCURACY_M; 0 probes means the figure is not stated at all.
    double vertical_accuracy_m = 0;
    uint64_t accuracy_probes = 0;
    // The density the adaptive search settled on, the target it was aiming at
    // (2 x 77067/2^level m, coordinator 2026-08-27), and whether the 32 KiB
    // ceiling — not the target — is what stopped it. `at_ceiling` is the tile
    // saying out loud that it is as accurate as the cap allows and no more.
    uint32_t grid = 0;
    double error_target_m = 0;
    bool at_ceiling = false;
    double coverage = 0;
    double min_h = 0;
    double max_h = 0;
    size_t mesh_bytes = 0;
    size_t payload_bytes = 0;
    std::string water_kind;
    std::string digest;
    bool skipped_ocean = false;
    // Set only when the SOURCE POSTS decided the skip and the interpolated
    // lattice did not — the coastal all-water case. Counted separately so a
    // run can show the arm firing rather than asserting that it would.
    bool ocean_from_source = false;
};

struct TileExtent {
    double west, east, south, north;
};

// ── a body's PDS products (pds_img.hpp), read by whole-line ranges ─────────

#include "pds_img.hpp"
#include "body_fill.hpp"
#include "body_despike.hpp"
#include "body_destripe.hpp"
#include "body_inset_decode.hpp"

struct BodyFill {
    const BodyRasterPixels* raster = nullptr;
    bool active = false, fill_edges = true, primary_datum = false, fill_datum = false;
    double lat_min = -90, lat_max = 90, band_m = 0, radius_m = 0;
    std::vector<DemGrid> grids, datum;
    const std::vector<DemGrid>* datum_source = nullptr;
    std::unique_ptr<BodyFill> backing;

    bool surface(const std::vector<DemGrid>& source, bool add_datum, double lon, double lat,
                 double* h, bool* nodata, bool* clamped) const {
        if (!body_sample(source, lon, lat, h, nodata, clamped)) return false;
        if (!add_datum || *nodata) return true;
        double offset = 0; bool dn = false, dc = false;
        if (!body_sample(datum_source ? *datum_source : datum, lon, lat, &offset, &dn, &dc) || dn || dc) return false;
        *h += offset;
        return true;
    }
    BodyInvalidDistance invalid;
    BodyInsetMask inset_mask;

    bool sample(const std::vector<DemGrid>& primary, double lon, double lat, double* h,
                bool* nodata, bool* clamped, BodyFillStats* stats = nullptr) const {
        if (raster) { uint8_t mask=0; *nodata=false; *clamped=false; return raster->sample(lon,lat,h,&mask); }
        if (!active) return surface(primary, primary_datum, lon, lat, h, nodata, clamped);
        double p = 0, f = 0;
        bool pn = false, pc = false, fn = false, fc = false;
        const bool valid_p = surface(primary, primary_datum, lon, lat, &p, &pn, &pc) && !pn && !pc && std::isfinite(p);
        double d = band_m;
        if (fill_edges && lat_min > -90) d = std::min(d, std::max(0.0, lat - lat_min) * radius_m * kPolarPi / 180);
        if (fill_edges && lat_max < 90) d = std::min(d, std::max(0.0, lat_max - lat) * radius_m * kPolarPi / 180);
        if (valid_p && !primary.empty() && primary[0].inset)
            d=std::min(d,inset_mask.distance(lon,lat,band_m));
        if (valid_p && !primary.empty() && !primary[0].inset) {
            const DemGrid& g = primary[0];
            double x = 0, y = 0;
            const double spacing = g.proj == kProjPolarStereo ? g.ps_scale_m : radius_m * kPolarPi / 180 * g.scale_lat;
            if (g.proj == kProjPolarStereo) {
                polar_pixel(g, lat, lon, &x, &y);
                // The actual image boundary is absent too; a decoded WINDOW boundary is not.
                d = std::min(d, std::max(0.0, std::min({x + 1, y + 1, g.width - x, g.full_rows - y})) * spacing);
            } else {
                x = full_ix(g, lon); y = full_iy(g, lat);
            }
            if (!invalid.squared.empty()) {
                const double limit = band_m / spacing;
                const double pixels = invalid.distance(x, y, limit);
                if (pixels < limit) d = std::min(d, pixels * spacing);
            }
        }
        // Avoid even reading fill outside the band: the original double is returned verbatim.
        const bool need_fill = !valid_p || d < band_m;
        const bool valid_f = need_fill && (backing ? backing->sample(grids, lon, lat, &f, &fn, &fc) :
                                           surface(grids, fill_datum, lon, lat, &f, &fn, &fc)) && !fn && !fc && std::isfinite(f);
        *nodata = false; *clamped = pc || (need_fill && fc);
        return body_blend(p, valid_p, f, valid_f, d, band_m, h, stats);
    }
};

// GEOGRAPHIC_WGS84: level z has 2^(z+1) x 2^z tiles of (180/2^z) degrees, row
// 0 at the SOUTH edge (TMS).
bool tile_extent(const TileJob& job, TileExtent* out) {
    const double span = 180.0 / static_cast<double>(1u << job.level);
    const uint32_t tiles_x = 2u << job.level;
    const uint32_t tiles_y = 1u << job.level;
    if (job.x >= tiles_x || job.y >= tiles_y) return false;
    out->west = -180.0 + job.x * span;
    out->east = out->west + span;
    out->south = -90.0 + job.y * span;
    out->north = out->south + span;
    return true;
}

// ── ONE GLOBAL POST LATTICE, for every sampled grid ────────────────────────
//
// At level z with an N-post grid the whole ellipsoid carries
// (2^(z+1)*(N-1) + 1) x (2^z*(N-1) + 1) posts, and tile (x, y) takes the
// contiguous block starting at (x*(N-1), y*(N-1)). Column N-1 of tile x IS
// column 0 of tile x+1 and row N-1 of tile y IS row 0 of the tile north of it
// — the SAME GLOBAL INDEX, so the same double, so the same sample and the same
// byte.
//
// The coordinate is computed from that integer index and never from per-tile
// extent arithmetic. `north - r*dlat` and `south' + (N-1-r)*dlat'` are equal in
// exact arithmetic and NOT always equal in doubles when the span does not
// divide by N-1 in binary (mask spans over 255 never do): measured on the real
// pyramid, 3 of 4,446 vertically adjacent tile pairs disagreed on shared mask
// posts purely because std::lround saw the two expressions differently. Under
// one lattice the identity is structural rather than lucky.
double lattice_lat(uint32_t level, uint32_t y, uint32_t row_from_south, uint32_t grid) {
    const double step = 180.0 / (static_cast<double>(1u << level) * (grid - 1));
    return -90.0 + static_cast<double>(static_cast<uint64_t>(y) * (grid - 1) + row_from_south) *
                       step;
}

double lattice_lon(uint32_t level, uint32_t x, uint32_t col, uint32_t grid) {
    const double step = 360.0 / (static_cast<double>(2u << level) * (grid - 1));
    return -180.0 + static_cast<double>(static_cast<uint64_t>(x) * (grid - 1) + col) * step;
}

// ── the water mask, cut from ONE GLOBAL CELL GRID (AREA REGISTRATION) ──────
//
// THE MASK IS AN IMAGE, NOT A POST LATTICE, because that is how the consumer
// reads it. Cesium uploads the 256x256 mask as a LUMINANCE texture with a
// LINEAR / CLAMP_TO_EDGE sampler (GlobeSurfaceTile.js:1077-1090) and samples
// it at the tile's own texture coordinates (GlobeFS.glsl:399), so texel c
// COVERS [c/256, (c+1)/256] of the tile and its centre sits at (c+0.5)/256.
// This encoder used to cut it as 256 POSTS at c/255, edge post to edge post:
// the served coastline was stretched by ~0.39% of a tile width and displaced
// by up to half a texel, zero at the tile centre and worst at both edges
// (~19 m at z11, ~5 m at z13). The classification of the source was exact —
// measured against an independent decode of the real WBM granule, 0 of 65,536
// bytes differ from the post-lattice truth — so the defect was the lattice
// CONVENTION, and only the convention changes here.
//
// The cells still come from ONE GLOBAL GRID: at level z the ellipsoid carries
// 2^(z+1)*N x 2^z*N cells and tile (x, y) takes the contiguous block starting
// at (x*N, y*N), so a texel's class is a pure function of its ground extent
// and no seam fix-up exists anywhere. Under AREA registration adjacent tiles
// no longer share an edge texel — cell N-1 of tile x and cell 0 of tile x+1
// cover DIFFERENT ground and are equal only when the coastline says so — so
// the property that is tested is the one that is actually true: the two tiles'
// texels tile the ground contiguously, with no gap, no overlap and no
// duplication, which is exactly what a single 2N-wide cut of the global grid
// across the pair reproduces.
//
// Source classes are categorical (0 = no water, non-zero = a water body), so
// the sample is NEAREST-NEIGHBOUR at the cell CENTRE: averaging class ordinals
// would invent a class the source never stated. Output is the served
// convention: 255 water, 0 land, row 0 the NORTH edge.
double mask_cell_lon(uint32_t level, uint32_t x, uint32_t col, uint32_t cells) {
    const double step = 360.0 / (static_cast<double>(2u << level) * cells);
    return -180.0 +
           (static_cast<double>(static_cast<uint64_t>(x) * cells + col) + 0.5) * step;
}

double mask_cell_lat(uint32_t level, uint32_t y, uint32_t row_from_south, uint32_t cells) {
    const double step = 180.0 / (static_cast<double>(1u << level) * cells);
    return -90.0 +
           (static_cast<double>(static_cast<uint64_t>(y) * cells + row_from_south) + 0.5) *
               step;
}

// THE FALLBACK IS PER POST, NEVER PER BLOCK.
//
// It used to be `dem_absent ? water : land` where dem_absent was a flag over
// the WHOLE granule set (`granules.empty()`). Copernicus publishes NO object
// over open ocean, so a 1-degree cell out at sea is a 404 for both the DEM and
// the water mask; when such a cell shared a 2x2 block with a land cell the flag
// was false and every unclassifiable post in it was written 0x00 = LAND.
// Measured on the real regional pyramid that fabricated 40,527 LAND samples
// over the open Ligurian Sea — hard-edged rectangles exactly the shape of the
// missing granule footprint, on tiles that are flat at 0 m and kilometres deep.
// The client renders them as non-reflective blocks in the middle of the water,
// the ocean-skip rule never fires on them, and the pyramid verifier could not
// see it because those tiles are RASTER rather than UNIFORM_WATER.
//
// So absence is now evaluated AT THE POST. A post no water granule classifies
// and no elevation granule covers is open ocean by the dataset's own
// publication pattern. A post no water granule classifies but an elevation
// granule DOES cover is a genuine gap in the mask lane: it stays LAND (the
// safe direction — a missing mask never invents reflective ocean over
// measured terrain) and is counted SEPARATELY so a run cannot hide it.
void classify_water_mask(const TileJob& job, const std::vector<DemGrid>& water_granules,
                         const std::vector<DemGrid>& dem_granules, std::vector<uint8_t>* raster,
                         uint64_t* from_absence, uint64_t* unclassified) {
    raster->assign(static_cast<size_t>(kMaskSize) * kMaskSize, 0);
    for (uint32_t r = 0; r < kMaskSize; r++) {
        // row 0 = NORTH, so row r is cell (kMaskSize - 1 - r) from the south.
        const double lat = mask_cell_lat(job.level, job.y, kMaskSize - 1 - r, kMaskSize);
        for (uint32_t c = 0; c < kMaskSize; c++) {
            const double lon = mask_cell_lon(job.level, job.x, c, kMaskSize);
            uint8_t cls = 0;
            uint8_t value;
            if (sample_water(water_granules, lon, lat, &cls)) {
                value = cls != 0 ? 0xff : 0x00;
            } else {
                bool dem_here = false;
                for (const DemGrid& g : dem_granules) {
                    if (!g.covers || g.samples.empty()) continue;
                    double px = 0, py = 0;
                    if (granule_holds(g, lon, lat, &px, &py)) { dem_here = true; break; }
                }
                if (dem_here) {
                    (*unclassified)++;
                    value = 0x00;
                } else {
                    (*from_absence)++;
                    value = 0xff;
                }
            }
            (*raster)[static_cast<size_t>(r) * kMaskSize + c] = value;
        }
    }
}

#include "tile_mesh.hpp"

// ── THE quantized-mesh encoder ─────────────────────────────────────────────
//
// `heights` is one height in metres per vertex of `tile_mesh`, in its vertex
// order. `water_raster` is either empty (a uniform mask, whose single byte
// `uniform_water` picks) or exactly kMaskSize^2 bytes.
//
// It lives here rather than inline in tile() because respond() must be able to
// synthesize a tile the store does not hold, and two encoders for one wire
// format is two encoders to keep in agreement.
//
// `body` says what the mesh is cut ON and what rides with it beyond the heights:
// the body's radii, oct-encoded vertex normals (extension 1, two bytes per
// vertex in the same order as `heights`) and whether the water-mask extension
// (2) is written at all. The default is Earth exactly as before - WGS84, no
// normals, the mask extension always present - so an Earth tile's bytes do not
// change.
struct MeshBody {
    BodyShape shape = kEarthShape;
    const std::vector<uint8_t>* oct_normals = nullptr;
    bool water_extension = true;
    const std::vector<uint8_t>* source_mask = nullptr;
};

// Quantized-mesh topology serialization, shared by the mesh writer and lossless reconstruction.
void write_mesh_indices(std::vector<uint8_t>& mesh, const std::vector<uint16_t>& qu,
                        const std::vector<uint16_t>& qv, const std::vector<uint32_t>& indices) {
    const uint32_t n_verts = static_cast<uint32_t>(qu.size());
    const bool wide = n_verts > 65536;
    // Padding before the index data: 2-byte alignment for 16-bit indices,
    // 4-byte for 32-bit, per the spec.
    const size_t align = wide ? 4 : 2;
    while (mesh.size() % align != 0) put_u8(&mesh, 0);
    put_u32(&mesh, static_cast<uint32_t>(indices.size() / 3));
    {
        uint32_t highest = 0;
        for (const uint32_t idx : indices) {
            const uint32_t code = highest - idx;
            if (wide) put_u32(&mesh, code); else put_u16(&mesh, static_cast<uint16_t>(code));
            if (code == 0) highest++;
        }
    }
    auto put_edge = [&](bool (*is_edge)(uint16_t, uint16_t)) {
        std::vector<uint32_t> edge;
        for (uint32_t v = 0; v < n_verts; v++) {
            if (is_edge(qu[v], qv[v])) edge.push_back(v);
        }
        put_u32(&mesh, static_cast<uint32_t>(edge.size()));
        for (const uint32_t v : edge) {
            if (wide) put_u32(&mesh, v); else put_u16(&mesh, static_cast<uint16_t>(v));
        }
    };
    put_edge([](uint16_t u, uint16_t) { return u == 0; });          // west
    put_edge([](uint16_t, uint16_t v) { return v == 0; });          // south
    put_edge([](uint16_t u, uint16_t) { return u == 32767; });      // east
    put_edge([](uint16_t, uint16_t v) { return v == 32767; });      // north

}

// Body payload layout D: topology descriptor, zigzag-height byte planes, then extensions.
// The descriptor is only topology; neither the source product nor the height field participates.
constexpr const char* kEdgeMatchedPlanes = "qm-edge-matched-planes-v1";
uint32_t planes_u32(const uint8_t* p) {
    return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
uint32_t planes_u16(const uint8_t* p) { return uint32_t(p[0]) | uint32_t(p[1]) << 8; }

void append_byte_planes(const uint8_t* data, size_t count, bool decode, std::vector<uint8_t>* out) {
    const size_t at = out->size();
    out->resize(at + 2 * count);
    for (size_t i = 0; i < count; i++) {
        if (decode) { (*out)[at + 2 * i] = data[i]; (*out)[at + 2 * i + 1] = data[count + i]; }
        else { (*out)[at + i] = data[2 * i]; (*out)[at + count + i] = data[2 * i + 1]; }
    }
}

bool append_planes_extensions(const uint8_t* data, size_t length, uint32_t nv, bool decode,
                              std::vector<uint8_t>* out) {
    for (size_t at = 0; at < length;) {
        if (length - at < 5) return false;
        const uint8_t id = data[at];
        const size_t size = planes_u32(data + at + 1);
        if (size > length - at - 5 || (id == 1 && size != 2u * nv)) return false;
        out->insert(out->end(), data + at, data + at + 5);
        if (id == 1) append_byte_planes(data + at + 5, nv, decode, out);
        else out->insert(out->end(), data + at + 5, data + at + 5 + size);
        at += 5 + size;
    }
    return true;
}

bool decode_edge_matched_planes(const uint8_t* data, size_t length, std::vector<uint8_t>* out) {
    if (!data || length < 104) return false;
    const uint32_t n = planes_u16(data + 88), cand = planes_u16(data + 90);
    const uint32_t nv = planes_u32(data + 100);
    if (n < 4 || n > 4097 || cand < 4 || cand > n || (n - 1) % (cand - 1) ||
        nv > 1024u * 1024u || nv > (length - 104) / 2) return false;
    std::array<std::vector<uint32_t>, 4> edges;
    uint32_t expected = (cand - 2) * (cand - 2);
    for (size_t k = 0; k < 4; k++) {
        const uint32_t count = planes_u16(data + 92 + 2 * k);
        if (count < 2 || count > n || (n - 1) % (count - 1)) return false;
        expected += count - 1;
        const uint32_t stride = (n - 1) / (count - 1);
        for (uint32_t i = 0; i < count; i++) edges[k].push_back(i * stride);
    }
    if (expected != nv) return false;
    const auto mesh = edge_matched_mesh(n, cand, edges);
    if (mesh.size() != nv) return false;
    const auto remap = mesh_first_appearance(mesh);
    std::vector<uint16_t> qu(nv), qv(nv);
    for (uint32_t v = 0; v < nv; v++) {
        if (remap[v] == UINT32_MAX) return false;
        qu[remap[v]] = static_cast<uint16_t>(32767ull * mesh.col[v] / (n - 1));
        qv[remap[v]] = static_cast<uint16_t>(32767ull * mesh.row[v] / (n - 1));
    }
    auto indices = mesh.indices;
    for (auto& idx : indices) idx = remap[idx];
    out->assign(data, data + 88);
    put_u32(out, nv);
    for (const auto* axis : {&qu, &qv}) {
        int32_t prev = 0;
        for (const uint16_t value : *axis) { put_u16(out, zigzag16(int32_t(value) - prev)); prev = value; }
    }
    append_byte_planes(data + 104, nv, true, out);
    write_mesh_indices(*out, qu, qv, indices);
    return append_planes_extensions(data + 104 + 2 * nv, length - 104 - 2 * nv, nv, true, out);
}

bool encode_edge_matched_planes(const std::vector<uint8_t>& qm, const TileMesh& shape, uint32_t cand,
                                const std::array<std::vector<uint32_t>, 4>& edges, std::vector<uint8_t>* out) {
    const uint32_t nv = static_cast<uint32_t>(shape.size());
    if (shape.n > 65535 || cand > 65535 || qm.size() < 92u + 6u * nv) return false;
    out->assign(qm.begin(), qm.begin() + 88);
    put_u16(out, static_cast<uint16_t>(shape.n));
    put_u16(out, static_cast<uint16_t>(cand));
    size_t edge_posts = 0;
    for (const auto& edge : edges) {
        if (edge.size() > 65535) return false;
        put_u16(out, static_cast<uint16_t>(edge.size()));
        edge_posts += edge.size();
    }
    put_u32(out, nv);
    append_byte_planes(qm.data() + 92 + 4 * nv, nv, false, out);
    const size_t index_size = nv > 65536 ? 4 : 2;
    const size_t vertex_end = 92 + 6 * nv;
    const size_t ext = (vertex_end + index_size - 1) / index_size * index_size +
                       4 + shape.indices.size() * index_size + 16 + edge_posts * index_size;
    if (ext > qm.size() || !append_planes_extensions(qm.data() + ext, qm.size() - ext, nv, false, out)) return false;
    std::vector<uint8_t> restored;
    return decode_edge_matched_planes(out->data(), out->size(), &restored) && restored == qm;
}

void encode_mesh(const TileJob& job, const TileMesh& tile_mesh, const std::vector<double>& heights_in,
                 const std::vector<uint8_t>& water_raster, bool uniform_water, std::vector<uint8_t>* out,
                 const MeshBody& body = MeshBody()) {
    const uint32_t n = tile_mesh.n;
    const uint32_t n_verts = static_cast<uint32_t>(tile_mesh.size());
    const bool with_normals = body.oct_normals && body.oct_normals->size() == static_cast<size_t>(n_verts) * 2;
    std::vector<double> heights = heights_in;
    std::vector<double> lats(n_verts), lons(n_verts);
    for (uint32_t v = 0; v < n_verts; v++) {
        lats[v] = lattice_lat(job.level, job.y, tile_mesh.row[v], n);
        lons[v] = lattice_lon(job.level, job.x, tile_mesh.col[v], n);
    }
    double min_h = heights[0], max_h = heights[0];
    for (const double h : heights) {
        min_h = std::min(min_h, h);
        max_h = std::max(max_h, h);
    }

    std::vector<uint16_t> qu(n_verts), qv(n_verts), qh(n_verts);
    const double h_range = max_h - min_h;
    for (uint32_t v = 0; v < n_verts; v++) {
        qu[v] = static_cast<uint16_t>((32767ull * tile_mesh.col[v]) / (n - 1));
        qv[v] = static_cast<uint16_t>((32767ull * tile_mesh.row[v]) / (n - 1));
        qh[v] = h_range > 0 ? static_cast<uint16_t>(std::lround(32767.0 * (heights[v] - min_h) / h_range)) : 0;
    }
    std::vector<uint32_t> indices = tile_mesh.indices;

    std::vector<uint8_t> source_mask;
    std::vector<uint8_t> normals;  // in the renumbered vertex order, when the body carries them

    // HIGH-WATER-MARK PRECONDITION: a vertex's first appearance in the index
    // stream must land exactly when it becomes the highest index seen, so the
    // vertices are renumbered by first appearance and every array permuted to
    // match. The decode loop (`index = highest - code; if (code == 0)
    // ++highest`) then reproduces the stream exactly.
    {
        const auto remap = mesh_first_appearance(tile_mesh);
        std::vector<uint16_t> pu(n_verts), pv(n_verts), ph(n_verts);
        std::vector<double> ph_m(n_verts), plat(n_verts), plon(n_verts);
        for (uint32_t v = 0; v < n_verts; v++) {
            const uint32_t nv = remap[v];
            pu[nv] = qu[v]; pv[nv] = qv[v]; ph[nv] = qh[v];
            ph_m[nv] = heights[v]; plat[nv] = lats[v]; plon[nv] = lons[v];
        }
        if (with_normals) {
            const std::vector<uint8_t>& lattice = *body.oct_normals;
            normals.resize(static_cast<size_t>(n_verts) * 2);
            for (uint32_t v = 0; v < n_verts; v++) {
                normals[static_cast<size_t>(remap[v]) * 2] = lattice[static_cast<size_t>(v) * 2];
                normals[static_cast<size_t>(remap[v]) * 2 + 1] = lattice[static_cast<size_t>(v) * 2 + 1];
            }
        }
        if(body.source_mask && body.source_mask->size()==n_verts) {
            source_mask.resize(n_verts);
            for(uint32_t v=0;v<n_verts;v++)source_mask[remap[v]]=(*body.source_mask)[v];
        }
        qu.swap(pu); qv.swap(pv); qh.swap(ph);
        heights.swap(ph_m); lats.swap(plat); lons.swap(plon);
        for (uint32_t& idx : indices) idx = remap[idx];
    }

    // ── header geometry (ECEF, metres, real heights) ────────────────────────
    std::vector<Vec3> positions(n_verts);
    for (uint32_t v = 0; v < n_verts; v++) {
        positions[v] = geodetic_to_ecef(body.shape, lats[v], lons[v], heights[v]);
    }
    Vec3 centroid;
    for (const Vec3& p : positions) { centroid.x += p.x; centroid.y += p.y; centroid.z += p.z; }
    centroid.x /= n_verts; centroid.y /= n_verts; centroid.z /= n_verts;
    double radius = 0.0;
    for (const Vec3& p : positions) {
        const double dx = p.x - centroid.x, dy = p.y - centroid.y, dz = p.z - centroid.z;
        radius = std::max(radius, std::sqrt(dx * dx + dy * dy + dz * dz));
    }
    const Vec3 occlusion = horizon_occlusion_point(body.shape, positions, centroid);

    std::vector<uint8_t>& mesh = *out;
    mesh.clear();
    mesh.reserve(n_verts * 6 + indices.size() * 2 + water_raster.size() + 256);
    put_f64(&mesh, centroid.x); put_f64(&mesh, centroid.y); put_f64(&mesh, centroid.z);
    put_f32(&mesh, static_cast<float>(min_h)); put_f32(&mesh, static_cast<float>(max_h));
    put_f64(&mesh, centroid.x); put_f64(&mesh, centroid.y); put_f64(&mesh, centroid.z);
    put_f64(&mesh, radius);
    put_f64(&mesh, occlusion.x); put_f64(&mesh, occlusion.y); put_f64(&mesh, occlusion.z);

    put_u32(&mesh, n_verts);
    auto put_zigzag_array = [&](const std::vector<uint16_t>& vals) {
        int32_t prev = 0;
        for (const uint16_t v : vals) {
            put_u16(&mesh, zigzag16(static_cast<int32_t>(v) - prev));
            prev = static_cast<int32_t>(v);
        }
    };
    put_zigzag_array(qu);
    put_zigzag_array(qv);
    put_zigzag_array(qh);

    write_mesh_indices(mesh, qu, qv, indices);

    // Oct-encoded vertex normals (extensionId 1): two bytes per vertex, in
    // vertex order.
    if (with_normals) {
        put_u8(&mesh, 1);
        put_u32(&mesh, static_cast<uint32_t>(normals.size()));
        mesh.insert(mesh.end(), normals.begin(), normals.end());
    }
    if(!source_mask.empty()) {
        // Quantized-mesh's standard metadata extension (id 4), UTF-8 JSON.
        // One ASCII flag per FINAL vertex: 0 sphere, 1 source, 2 feather.
        std::string flags;flags.reserve(source_mask.size());for(auto v:source_mask)flags+=char('0'+v);
        const std::string metadata="{\"sourcePixelMask\":\""+flags+"\",\"sourcePixelMaskLegend\":\"0=sphere,1=source,2=feather\"}";
        put_u8(&mesh,4);put_u32(&mesh,metadata.size()+4);put_u32(&mesh,metadata.size());
        mesh.insert(mesh.end(),metadata.begin(),metadata.end());
    }
    if (!body.water_extension) return;
    // Watermask extension (extensionId 2): one byte uniform, or the raster.
    put_u8(&mesh, 2);
    if (!water_raster.empty()) {
        put_u32(&mesh, static_cast<uint32_t>(water_raster.size()));
        mesh.insert(mesh.end(), water_raster.begin(), water_raster.end());
    } else {
        put_u32(&mesh, 1);
        put_u8(&mesh, uniform_water ? 0xff : 0x00);
    }
}

// The regular grid*grid mesh (heights SOUTH-row-major), as every Earth tile has
// always been cut.
void encode_quantized_mesh(const TileJob& job, uint32_t grid, const TileExtent& ext,
                           const std::vector<double>& heights, const std::vector<uint8_t>& water_raster,
                           bool uniform_water, std::vector<uint8_t>* out, const MeshBody& body = MeshBody()) {
    (void)ext;
    encode_mesh(job, regular_mesh(grid), heights, water_raster, uniform_water, out, body);
}

// ── THE TILE MEASURES ITS OWN VERTICAL ACCURACY, AT THE SOURCE POSTS ───────
//
// $DTT.VERTICAL_ACCURACY_M is the one field a consumer reads to reason about
// exactly the quantity the pyramid is judged on, and the SAME number selects
// the density ladder. So where the probe looks is the whole measurement, and
// this lane has now got it wrong twice in two different ways:
//
//   1. THREE COLLINEAR POSITIONS PER CELL (du == dv == {1/2, 1/3, 2/3}) — all
//      of them on the split diagonal, while the comment claimed "the centre and
//      both triangle centroids". The interior of both triangles was never
//      looked at. Re-measured against the source, that pattern stated 4.496 m
//      on a tile whose true worst departure is 290.5 m.
//
//   2. THE ENCODER'S OWN RESAMPLED LATTICE AS THE TRUTH. The fix for (1) walked
//      every post of the finest lattice the plan sampled (`maxGridSize`) —
//      honest about the mesh against THAT lattice, and silently optimistic
//      about the dataset, because a lattice coarser than the source cannot see
//      relief finer than its own spacing. At z10 a tile edge carries 633
//      GLO-30 posts against a 217-post lattice (2.9x under-resolved) and at z11
//      316 against 217 (1.5x); measured over the whole regional store, that
//      understated VERTICAL_ACCURACY_M by more than 5% on 48.9% of z10 tiles
//      and 43.4% of z11 tiles, worst 1.56x — and, because the ladder reads the
//      same number, it stopped the climb on tiles with bytes still to spare.
//
// COORDINATOR RESOLUTION 2026-08-27 (1) SETTLES IT: accuracy is measured at the
// SOURCE POSTS — every post the granule set carries inside the tile bounds,
// with the MESH interpolated at the post — never against a resample of the
// source and never against a reference that does not resolve it. That is what
// this does. It is not an approximation of the source; the values are the
// granule's own float32 samples, read straight out of the decoded window at
// their own indices, so there is no interpolation on the truth side at all.
//
// It is also CHEAPER than it sounds, for two reasons:
//   * nothing is sampled. The posts are already resident (the decode window is
//     the tile's own extent), so the walk is a strided read of a float array
//     plus ~10 flops per post;
//   * a candidate that has ALREADY missed the target does not need its exact
//     error, only the fact that it missed. `abort_above` stops the walk at the
//     first post past the target, which is what the ladder asks 90% of the
//     time. The tile that SHIPS is always measured by a COMPLETE walk — the
//     ladder re-runs the chosen candidate with the abort off when it settled at
//     the cap — so no record ever states a number that stopped early.
//
// Posts the source marks NO-DATA are skipped: comparing against a substituted
// 0 would report the substitution, not the mesh. Posts no granule covers are
// never enumerated, so an absent neighbour cannot inflate or deflate the
// figure; `coverageFraction` is where that shows up. Where two granules of the
// fetched set both hold a post it is walked twice, which a maximum does not
// care about and which the probe count reflects honestly.
struct SourcePostProbe {
    double worst = 0.0;
    uint64_t probes = 0;
    // The sum of squared departures (RMS = sqrt(sum_sq / probes)) and, when the
    // caller asks, their histogram in whole metres (bin k counts [k, k+1) m,
    // the last bin everything beyond). A body's tiles report both, so a level's
    // RMS and percentiles are exact sums over its tiles.
    double sum_sq = 0.0;
    std::vector<uint64_t>* histogram = nullptr;
    // False only when `abort_above` stopped the walk. A record's stated
    // accuracy is never taken from an incomplete walk.
    bool complete = true;
};

// WHICH OF A GRANULE WINDOW'S POSTS LIE INSIDE A TILE'S EXTENT.
//
// Shared by the accuracy probe and the source-side ocean test below, so the
// two cannot drift apart on what "inside the tile" means: the accuracy a
// record STATES and the decision to ship the record AT ALL are then judgements
// over the same post set. Computed in full-granule coordinates and shifted by
// the window's integer offset, exactly as full_ix/full_iy do, so a post this
// resolves is the post sample_dem would have resolved. Returns false when the
// tile and this window share no post at all.
struct PostWindow {
    long x0 = 0, x1 = -1, y0 = 0, y1 = -1;
};

bool tile_post_window(const DemGrid& g, double west, double east, double south, double north,
                      PostWindow* out) {
    if (!g.covers || g.samples.empty() || g.is_mask) return false;
    if (!(g.scale_lon > 0) || !(g.scale_lat > 0)) return false;
    const double ix_lo = full_ix(g, west) - static_cast<double>(g.off_x);
    const double ix_hi = full_ix(g, east) - static_cast<double>(g.off_x);
    const double iy_lo = full_iy(g, north) - static_cast<double>(g.off_y);
    const double iy_hi = full_iy(g, south) - static_cast<double>(g.off_y);
    long x0 = static_cast<long>(std::ceil(ix_lo - 1e-9));
    long x1 = static_cast<long>(std::floor(ix_hi + 1e-9));
    long y0 = static_cast<long>(std::ceil(iy_lo - 1e-9));
    long y1 = static_cast<long>(std::floor(iy_hi + 1e-9));
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > static_cast<long>(g.width) - 1) x1 = static_cast<long>(g.width) - 1;
    if (y1 > static_cast<long>(g.height) - 1) y1 = static_cast<long>(g.height) - 1;
    if (x1 < x0 || y1 < y0) return false;
    out->x0 = x0;
    out->x1 = x1;
    out->y0 = y0;
    out->y1 = y1;
    return true;
}

// The surface the encoder renders, evaluated where a source post lies.
//
// RegularGridSurface is the cand x cand grid of encode_quantized_mesh: (bl, br,
// tr) below each cell's split diagonal, (bl, tr, tl) above it, kept here so the
// measurement and the mesh cannot drift apart. BodyMeshSurface is any
// TileMesh (a body's edge-matched mesh) through MeshSurface. Both take a
// longitude/latitude inside the tile's bounds.
struct RegularGridSurface {
    double west, south, u_per_deg, v_per_deg, span;
    uint32_t cand;
    const std::vector<double>* heights;

    double at(double lon, double lat) const {
        double vv = (lat - south) * v_per_deg;
        if (vv < 0) vv = 0;
        if (vv > span) vv = span;
        uint32_t cj = static_cast<uint32_t>(vv);
        if (cj > cand - 2) cj = cand - 2;
        const double dv = vv - static_cast<double>(cj);
        double uu = (lon - west) * u_per_deg;
        if (uu < 0) uu = 0;
        if (uu > span) uu = span;
        uint32_t ci = static_cast<uint32_t>(uu);
        if (ci > cand - 2) ci = cand - 2;
        const double du = uu - static_cast<double>(ci);
        const double* row_lo = &(*heights)[static_cast<size_t>(cj) * cand];
        const double* row_hi = row_lo + cand;
        const double h_bl = row_lo[ci], h_br = row_lo[ci + 1];
        const double h_tl = row_hi[ci], h_tr = row_hi[ci + 1];
        return dv <= du ? h_bl + du * (h_br - h_bl) + dv * (h_tr - h_br)
                        : h_bl + dv * (h_tl - h_bl) + du * (h_tr - h_tl);
    }
};

struct BodyMeshSurface {
    double west, south, u_per_deg, v_per_deg;
    const MeshSurface* surface;

    double at(double lon, double lat) const {
        return surface->at((lon - west) * u_per_deg, (lat - south) * v_per_deg);
    }
};

// One source post's departure from the rendered surface; false when
// `abort_above` stops the walk.
bool probe_post(double rendered, double truth, double abort_above, SourcePostProbe* out) {
    const double delta = std::fabs(rendered - static_cast<double>(truth));
    out->probes++;
    out->sum_sq += delta * delta;
    if (out->histogram) {
        const size_t bin = static_cast<size_t>(std::min(delta, static_cast<double>(out->histogram->size() - 1)));
        (*out->histogram)[bin]++;
    }
    if (delta > out->worst) {
        out->worst = delta;
        if (abort_above > 0 && out->worst > abort_above) {
            out->complete = false;
            return false;
        }
    }
    return true;
}

// The same walk over a POLAR STEREOGRAPHIC product: its posts are regular in
// the projected grid, not in latitude and longitude, so the posts inside the
// tile are found from the tile's footprint in that grid and each is taken back
// to latitude/longitude before the mesh is interpolated at it. False when
// `abort_above` stopped the walk.
template <class Surface>
bool measure_polar_accuracy(const DemGrid& g, double west, double east, double south, double north,
                            const Surface& surface, double abort_above, SourcePostProbe* out,
                            const std::vector<DemGrid>& granules, const BodyFill* fill) {
    if (!g.covers || g.samples.empty()) return true;
    double s_lo = 0, s_hi = 0, l_lo = 0, l_hi = 0;
    if (!polar_stereo_footprint(polar_of(g), west, east, south, north, &s_lo, &s_hi, &l_lo, &l_hi)) return true;
    const long x0 = std::max<long>(0, static_cast<long>(std::floor(s_lo)) - 1 - g.off_x);
    const long x1 = std::min<long>(static_cast<long>(g.width) - 1, static_cast<long>(std::ceil(s_hi)) + 1 - g.off_x);
    const long y0 = std::max<long>(0, static_cast<long>(std::floor(l_lo)) - 1 - g.off_y);
    const long y1 = std::min<long>(static_cast<long>(g.height) - 1, static_cast<long>(std::ceil(l_hi)) + 1 - g.off_y);
    for (long iy = y0; iy <= y1; iy++) {
        for (long ix = x0; ix <= x1; ix++) {
            double truth = g.samples[static_cast<size_t>(iy) * g.width + static_cast<size_t>(ix)];
            if (truth == kNoData && !fill) continue;
            double lat = 0, lon = 0;
            polar_lat_lon(g, static_cast<double>(ix + g.off_x), static_cast<double>(iy + g.off_y), &lat, &lon);
            if (lat < south || lat > north || lon < west || lon > east) continue;
            if (fill) {
                bool nd = false, cl = false;
                if (!fill->sample(granules, lon, lat, &truth, &nd, &cl) || nd || cl) continue;
            }
            if (!probe_post(surface.at(lon, lat), truth, abort_above, out)) return false;
        }
    }
    return true;
}

template <class Surface>
SourcePostProbe measure_surface_accuracy(const std::vector<DemGrid>& granules, double west, double east,
                                         double south, double north, const Surface& surface,
                                         double abort_above, std::vector<uint64_t>* histogram, const BodyFill* fill = nullptr) {
    SourcePostProbe out;
    out.histogram = histogram;
    for (const DemGrid& g : granules) {
        if (g.proj == kProjPolarStereo) {
            if (!measure_polar_accuracy(g, west, east, south, north, surface, abort_above, &out, granules, fill)) return out;
            continue;
        }
        PostWindow w;
        if (!tile_post_window(g, west, east, south, north, &w)) continue;
        for (long iy = w.y0; iy <= w.y1; iy++) {
            const double lat = full_lat(g, static_cast<double>(g.off_y + iy));
            const float* src = &g.samples[static_cast<size_t>(iy) * g.width];
            for (long ix = w.x0; ix <= w.x1; ix++) {
                double truth = src[ix];
                if (truth == kNoData && !fill) continue;
                const double lon = full_lon(g, static_cast<double>(g.off_x + ix));
                if (fill) {
                    bool nd = false, cl = false;
                    if (!fill->sample(granules, lon, lat, &truth, &nd, &cl) || nd || cl) continue;
                }
                if (!probe_post(surface.at(lon, lat), truth, abort_above, &out)) return out;
            }
        }
    }
    return out;
}

// The regular cand x cand candidate (Earth's, and the measurement of record
// for it).
SourcePostProbe measure_mesh_accuracy(const std::vector<DemGrid>& granules, const TileJob& job,
                                      uint32_t cand, const std::vector<double>& cand_heights,
                                      bool enabled, double abort_above,
                                      std::vector<uint64_t>* histogram = nullptr) {
    SourcePostProbe out;
    out.histogram = histogram;
    if (!enabled || cand < 2 || cand_heights.size() < static_cast<size_t>(cand) * cand) return out;
    // The tile's own bounds, from the SAME global lattice the vertices were cut
    // from, so a post exactly on a vertex evaluates to that vertex.
    const double west = lattice_lon(job.level, job.x, 0, cand);
    const double east = lattice_lon(job.level, job.x, cand - 1, cand);
    const double south = lattice_lat(job.level, job.y, 0, cand);
    const double north = lattice_lat(job.level, job.y, cand - 1, cand);
    if (!(east > west) || !(north > south)) return out;
    const double span = static_cast<double>(cand - 1);
    const RegularGridSurface surface{west, south, span / (east - west), span / (north - south), span, cand, &cand_heights};
    return measure_surface_accuracy(granules, west, east, south, north, surface, abort_above, histogram);
}

// Any TileMesh with one height per vertex (a body's edge-matched candidate).
SourcePostProbe measure_body_mesh_accuracy(const std::vector<DemGrid>& granules, const TileJob& job,
                                           const TileMesh& mesh, const std::vector<double>& mesh_heights,
                                           uint32_t cand, double abort_above,
                                           std::vector<uint64_t>* histogram = nullptr, const BodyFill* fill = nullptr) {
    const uint32_t n = mesh.n;
    const double west = lattice_lon(job.level, job.x, 0, n);
    const double east = lattice_lon(job.level, job.x, n - 1, n);
    const double south = lattice_lat(job.level, job.y, 0, n);
    const double north = lattice_lat(job.level, job.y, n - 1, n);
    if (!(east > west) || !(north > south)) {
        SourcePostProbe out;
        out.histogram = histogram;
        return out;
    }
    const MeshSurface lookup(mesh, mesh_heights, cand - 1);
    const double span = static_cast<double>(n - 1);
    const BodyMeshSurface surface{west, south, span / (east - west), span / (north - south), &lookup};
    return measure_surface_accuracy(granules, west, east, south, north, surface, abort_above, histogram, fill);
}

// ── IS THIS TILE OCEAN ACCORDING TO THE SOURCE, NOT THE MESH? ──────────────
//
// The ocean test that decides whether a tile is stored at all used to read the
// tile's own resampled LATTICE — `min_h == 0 && max_h == 0` over the posts the
// encoder interpolated — and that is the wrong side of the question for every
// tile whose extent touches a coast.
//
// MEASURED on the regional store, tile 12/4300/3057 in the open Ligurian Sea:
// the WBM calls it water at all 25,122 of its samples, the GLO-30 source is
// exactly 0.0 at all 25,122 posts inside its extent with no post marked
// no-data, and yet its lattice reports max 0.684 m — because the NE corner
// VERTEX sits 0.04 arcsec south of a post row that climbs to 3-5 m on the far
// side of the tile boundary, and a corner vertex is shared with the tile that
// owns that coastline. The mesh is FAITHFUL there (the shipped corner matches
// the bilinear source to 1e-6 m), so the vertex is not the defect. The defect
// is that a test reading the interpolated lattice can NEVER call an all-water
// tile ocean if a coast lies anywhere near its boundary — and at global scale
// those are precisely the tiles the store budget is spent on, since the open
// ocean far from any coast is already skipped by the lattice arm.
//
// So the classification moves to the SOURCE POSTS INSIDE THE EXTENT — the same
// posts measure_mesh_accuracy judges the mesh against, through the same
// tile_post_window. A tile every one of whose covered posts is exactly sea
// level is a tile the client synthesizes exactly, and storing it buys nothing.
//
// NO-DATA DISQUALIFIES rather than being skipped: an unmeasured post is not
// evidence of sea level, and the accuracy probe's reason for skipping them
// (comparing against a substituted 0 would report the substitution) is a reason
// to distrust them here too. A tile no elevation granule covers returns
// `posts == 0` and is left to the absence path, which classifies it from the
// mask alone.
struct SourceExtremes {
    double min_h = 0.0;
    double max_h = 0.0;
    // Posts walked that carry a real measurement, and posts the source marks
    // no-data. `posts == 0` means no granule of the set covers this tile.
    uint64_t posts = 0;
    uint64_t nodata = 0;
};

SourceExtremes measure_source_extremes(const std::vector<DemGrid>& granules,
                                       const TileExtent& ext) {
    SourceExtremes out;
    for (const DemGrid& g : granules) {
        PostWindow w;
        if (!tile_post_window(g, ext.west, ext.east, ext.south, ext.north, &w)) continue;
        for (long iy = w.y0; iy <= w.y1; iy++) {
            const float* src = &g.samples[static_cast<size_t>(iy) * g.width];
            for (long ix = w.x0; ix <= w.x1; ix++) {
                const float truth = src[ix];
                if (truth == kNoData) {
                    out.nodata++;
                    continue;
                }
                const double h = static_cast<double>(truth);
                if (out.posts == 0) {
                    out.min_h = h;
                    out.max_h = h;
                } else {
                    out.min_h = std::min(out.min_h, h);
                    out.max_h = std::max(out.max_h, h);
                }
                out.posts++;
            }
        }
    }
    return out;
}

// ── the availability index, read the way the client reads it ───────────────
//
// layer.json `available` is an array indexed by LEVEL, each entry an array of
// {startX,startY,endX,endY} rectangles. It is the contract the client plans
// its requests against: everything inside it will be answered, everything
// outside it is never asked for. That makes it the exact test for whether a
// store miss is normal traffic or a broken promise.
struct AvailabilityRect {
    double sx, sy, ex, ey;
};

// ── THE INDEX IS PARSED ONCE PER INSTANCE, NOT ONCE PER REQUEST ────────────
//
// route() consulted this on EVERY tile request, and consulting it meant
// splitting the whole `terrain_available` array into a fresh std::string per
// level and a fresh std::string per rectangle before testing one of them.
// Measured warm on one instance, same address, 300 invokes: 0.065 ms/req on
// the 45-byte default, 0.264 ms on this lane's 9.7 KB regional index, 5.374 ms
// on a 318 KB index and 110.665 ms on a 6.9 MB one — cost linear in the size of
// an index the SHIP PLAN makes far larger than the regional one, paid before
// the store is even touched, on a four-instance pool.
//
// Caching the PARSE against its own bytes was the first fix and it moved the
// number by ~5%, because the parse was never the cost. An independent A/B at
// 4.4 MB of config settled it: the same bytes parked in a key NOTHING reads
// still cost 5.96 ms per request. The cost is the config crossing the host
// boundary on every invoke, the four or five whole-buffer scans that walk past
// the value looking for later keys, and the memcmp that keyed the cache — all
// of it linear in a quantity that has nothing to do with the request.
//
// So nothing here is per-request any more. This is a pure parse, called ONCE
// from serving_config() below, and what route() holds afterwards is the parsed
// rectangles. See the ServingConfig comment for why once-per-instance is the
// CORRECT lifetime and not merely a fast one.
struct AvailabilityIndex {
    std::vector<std::vector<AvailabilityRect>> levels;
};

// THE INDEX ON THE WIRE IS ONE NumberList, read IN PLACE. `terrain_available` is a flat run of 5-tuples
// [level, startX, startY, endX, endY] - one per rectangle, in layer.json order (tools/terrain-pyramid writes it with
// availabilityNumbers()). A ModuleConfig has no list-of-lists kind, and the layer.json shape as tables cost a table
// and four keyed entries per rectangle; as numbers it is 40 bytes a rectangle, verified once and walked once here
// straight out of the host's response, never copied element by element. A level with no rectangles is an empty level
// (the levels after it keep their indices). A tuple that is not whole non-negative integers, or a level past 63, is
// dropped as the JSON reader dropped a malformed rectangle; a list whose length is not a multiple of 5 is refused
// (false) and the default roots answer.
constexpr uint32_t kMaxAvailabilityLevels = 64;
bool parse_availability(sdm_piv::Span<double> numbers, AvailabilityIndex* index) {
    index->levels.clear();
    if (numbers.empty() || numbers.size() % 5 != 0) return false;
    auto whole = [](double v) { return std::isfinite(v) && v >= 0 && v == std::floor(v) && v < 9.0e15; };
    for (size_t at = 0; at < numbers.size(); at += 5) {
        const double level = numbers[at];
        if (!whole(level) || level >= kMaxAvailabilityLevels) continue;
        const AvailabilityRect r{numbers[at + 1], numbers[at + 2], numbers[at + 3], numbers[at + 4]};
        if (!whole(r.sx) || !whole(r.sy) || !whole(r.ex) || !whole(r.ey)) continue;
        const size_t z = static_cast<size_t>(level);
        if (index->levels.size() <= z) index->levels.resize(z + 1);
        index->levels[z].push_back(r);
    }
    return !index->levels.empty();
}

// layer.json `available`, rendered from the parsed index: the array-of-levels-of-rectangles the client reads.
std::string availability_json(const AvailabilityIndex& index) {
    std::string out = "[";
    char buf[128];
    for (size_t z = 0; z < index.levels.size(); z++) {
        out += z ? ",[" : "[";
        const std::vector<AvailabilityRect>& rects = index.levels[z];
        for (size_t i = 0; i < rects.size(); i++) {
            const AvailabilityRect& r = rects[i];
            std::snprintf(buf, sizeof(buf), "%s{\"startX\":%.0f,\"startY\":%.0f,\"endX\":%.0f,\"endY\":%.0f}",
                          i ? "," : "", r.sx, r.sy, r.ex, r.ey);
            out += buf;
        }
        out += "]";
    }
    return out + "]";
}

// ── AVAILABILITY, AS THE CLIENT COMPUTES IT ────────────────────────────────
//
// A native terrain provider does NOT ask "is (level,x,y) listed at level".
// Cesium's TileAvailability.isTileAvailable is
//
//     computeMaximumLevelAtPosition(centre of the tile) >= level
//
// (Core/TileAvailability.js:195-208), whose own comment states the assumption
// this index has to satisfy: "if a tile at level n exists, then all its parent
// tiles back to level 0 exist too". A per-level membership test therefore
// answered a DIFFERENT question from the one the client asks, and the gap was
// not hypothetical: on the regional pyramid, whose `available` is empty at
// levels 1-7 and populated at 8-13, the client computed 14 shallow addresses
// as available (2 at z6, 12 at z7) whose centres fall inside the deep
// rectangles. Every one of them was a store miss the module answered 404 —
// straight to the browser, against Atlas's rule that a store-miss 404 must
// never get there and against the zero-4xx acceptance bound.
//
// This is now the client's own rule, evaluated on the client's own scheme
// (two roots, TMS row order — which is the order layer.json `available` is
// written in; CesiumTerrainProvider flips it to its internal north-origin rows
// when it loads the index). An address the client will ask for is inside
// availability here, so respond() synthesizes it instead of 404-ing it.
bool address_available_to_client(const AvailabilityIndex& index, uint32_t level, uint32_t x,
                                 uint32_t y) {
    if (index.levels.empty() || level >= 32u) return false;

    // Centre of (level, x, y): longitude over 2^(level+1) columns from -180,
    // latitude over 2^level rows from -90 (row 0 = SOUTH).
    const double lon =
        -180.0 + (static_cast<double>(x) + 0.5) * 360.0 / std::ldexp(1.0, static_cast<int>(level) + 1);
    const double lat =
        -90.0 + (static_cast<double>(y) + 0.5) * 180.0 / std::ldexp(1.0, static_cast<int>(level));

    const size_t deepest = index.levels.size() - 1;
    for (size_t L = deepest + 1; L-- > static_cast<size_t>(level);) {
        if (L >= 32u) continue;
        const double cols = std::ldexp(1.0, static_cast<int>(L) + 1);
        const double rows = std::ldexp(1.0, static_cast<int>(L));
        double lx = std::floor((lon + 180.0) * cols / 360.0);
        double ly = std::floor((lat + 90.0) * rows / 180.0);
        if (lx < 0) lx = 0;
        if (ly < 0) ly = 0;
        if (lx > cols - 1) lx = cols - 1;
        if (ly > rows - 1) ly = rows - 1;
        for (const AvailabilityRect& r : index.levels[L]) {
            if (lx >= r.sx && lx <= r.ex && ly >= r.sy && ly <= r.ey) return true;
        }
    }
    return false;
}

// ── THE SERVING CONFIG, READ ONCE AND KEPT ─────────────────────────────────
//
// Every serving decision this module makes is a function of the mount's config
// block and the request. The config half used to be re-read, re-scanned and
// re-concatenated on EVERY invoke, which made route()'s cost linear in the
// size of the availability index — a quantity that has nothing to do with the
// request being answered. At the configuration ruled for ship (a global z11
// index, 4-6 MB) that was 66-105 ms per tile request, i.e. 15-18 requests per
// second per instance, against an acceptance bound of dozens of tiles per
// camera pose per client.
//
// ONCE PER INSTANCE IS THE CORRECT LIFETIME, not merely the fast one. A
// mount's config block is materialised at MOUNT CONSTRUCTION — flowrt copies
// the map into the node context the mount's pool sees — and a pool's instances
// live as long as the mount, so the bytes plugin.getConfig returns cannot
// change under a running instance. An operator editing config edits the
// daemon's YAML and restarts the daemon, which rebuilds the mounts and their
// pools; that restart is already what the deploy recipe requires. Off-node,
// tests construct a fresh harness per config, which is the same lifetime.
//
// What is derived here is derived ONCE too, because it is a pure function of
// the same bytes: the parsed availability rectangles, the layer_plan frame
// route hands to layer_json, and the accepted query token. After this,
// answering a tile request is a fixed number of small-string operations plus
// the availability walk, whose cost is set by the DEPTH of the pyramid (at
// most 32 levels) and not by the byte size of the index.
//
// tests/route-cost.test.mjs is the gate: p50 route() cost measured at 45 B,
// 9.7 KB, 318 KB and 6.9 MB of index must stay flat across all four.
struct ServingConfig {
    std::string tileset_id;
    std::string mount_prefix;
    std::string version;
    std::string layer_plan;  // the frame route pushes for the layer.json path
    // A short content-derived name for layer_plan, so the downstream renderer
    // can key its own cache on O(1) bytes instead of memcmp-ing megabytes.
    std::string layer_plan_token;
    AvailabilityIndex availability;
    double ocean_synth_min_level = -1;  // < 0 = no level is authoritative
    uint32_t synth_grid = 65;
    // ── WHERE THE TILES ACTUALLY ARE (owner 2026-08-27) ─────────────────────
    //
    // The pyramid is PUBLISHED as a content-addressed IPFS directory and the
    // clients fetch from the gateway, so the one thing they cannot know on
    // their own is WHICH directory is current. That is this mount's job: the
    // CID of the tileset epoch this node is serving, rendered as a catalogue
    // document at the mount root. Rendered, never hardcoded in a client — a
    // client that hardcodes a CID is pinned to a dead epoch the day the
    // dataset is recut.
    //
    // It is CONFIGURED, exactly as `terrain_available` is and for the same
    // reason: which epoch a node serves is the orchestrator's knowledge, not
    // something to aggregate out of the store per request. The durable form of
    // that knowledge is the $DTT catalogue record the builder emits and the
    // dataset lane publishes (tools/terrain-pyramid/IPFS-DELIVERY.md states
    // the field mapping); this key is that record's CID field, installed.
    std::string tileset_cid;
    std::string gateway_path = "/ipfs/";
    std::string gateway_origin;
    std::string dataset_epoch;
    std::string attribution;
    long maxzoom = 0;
    // The $DTT catalogue projection's provenance fields. Optional: a mount
    // that configures none still answers a truthful record, it just carries
    // less lineage than the builder's own tileset-catalogue.json.
    double tileset_size_bytes = 0;  // 0 = not configured, PAYLOAD.SIZE_BYTES omitted
    std::string dataset_id;
    std::string dataset_name;
    std::string license;
    std::string license_url;
    // DTTProvenance.RETRIEVED_AT is `required` in schema/DTT/main.fbs, so a
    // projection that omits it is not a $DTT at all — the builder cannot
    // serialize it (`FlatBuffers: field 18 must be set`). It was omitted, and
    // nothing in the suite ever built the projection through the SDS builder,
    // so an unbuildable record answered 200 for the whole lane. Carried now,
    // and tests/catalogue.test.mjs round-trips the body through the published
    // builder so the same omission cannot recur silently.
    std::string dataset_retrieved_at;
    // ── ONE FIELD NAMES THE TILESET DIRECTORY, AND IT IS PAYLOAD.CID ────────
    //
    // PAYLOAD.CID is the tileset epoch: the content-addressed DIRECTORY that
    // holds layer.json and every {z}/{x}/{y}.terrain. Both clients read that
    // field and only that field (console globeSurfaces.tilesetCid, root app
    // terrainTileset.readTilesetRecord).
    //
    // PROVENANCE.DATASET_CID is a DIFFERENT thing and the IDL says so:
    // "content identifier of the exact dataset artifact, when the publisher
    // distributes one" — the SOURCE DEM this pyramid was cut from, not the
    // pyramid. This module used to copy the tileset CID into it as well, so
    // the two readers agreed only by accident; the day a provenance-complete
    // record put the real Copernicus artifact there, a client reading
    // DATASET_CID would have pointed a terrain provider at a DEM archive and
    // 404-ed every tile from a perfectly valid record. It is now its OWN
    // config key and is emitted only when an operator states one.
    std::string source_dataset_cid;
    // ── THE DATUM TRAVELS WITH THE TILESET, NOT ONLY WITH THE TILES ────────
    //
    // Every per-tile $DTT states VERTICAL_DATUM = GEOID and VERTICAL_DATUM_NAME
    // (see the file header). The IPFS delivery path publishes layer.json and
    // the .terrain bytes and NOT the per-tile records, so the catalogue record
    // and layer.json are the only two documents a client on that path ever
    // reads — and both used to drop the datum, leaving it wire-defaulted to
    // UNSPECIFIED ("heights are not comparable across tiles"). A consumer then
    // renders EGM2008 orthometric heights as WGS84 ellipsoidal ones and sits
    // low by the local undulation (~48 m in Liguria; the encoder's own remark
    // bounds it at <~100 m). Both documents carry it now.
    std::string vertical_datum_name;
    // The tileset's own bounding extent, when the orchestrator states one.
    // NOT derived from LEVEL/X/Y: the catalogue record is not a tile (see the
    // TILING_SCHEME note on the route), so its address says nothing and the
    // extent has to stand on its own or be absent.
    bool has_extent = false;
    double west_deg = 0, south_deg = 0, east_deg = 0, north_deg = 0;
};

// The serving config's scalar readers over a ModuleConfig table: a String (fallback when absent or another kind, as
// the JSON reader's json_string), a Number (a numeric String tolerated, as an operator config always allowed).
std::string cfg_string(const sdm_piv::ConfigTable& c, const char* key, const char* fallback) {
    if (c.kind(key, sdn::runtime::configValueKind_Number) != sdn::runtime::configValueKind_String) return fallback;
    return std::string(c.string(key));
}
double cfg_number(const sdm_piv::ConfigTable& c, const char* key, double fallback) {
    if (!c.has(key)) return fallback;
    if (c.kind(key) == sdn::runtime::configValueKind_Number) return c.number(key, fallback);
    if (c.kind(key) == sdn::runtime::configValueKind_String) {
        const std::string text(c.string(key));
        char* end = nullptr;
        const double v = strtod(text.c_str(), &end);
        if (end != text.c_str()) return v;
    }
    return fallback;
}

ServingConfig build_serving_config(const sdm_piv::ConfigTable& config) {
    ServingConfig sc;
    sc.tileset_id = cfg_string(config, "terrain_tileset_id", "spaceaware-terrain");
    sc.mount_prefix = cfg_string(config, "terrain_mount_path", "/api/v1/terrain/");
    if (sc.mount_prefix.empty() || sc.mount_prefix.back() != '/') sc.mount_prefix += '/';
    sc.version = cfg_string(config, "terrain_version", "1.0.0");

    // Default: the two level-0 roots of the two-root geographic scheme. Honest exactly when maxzoom is 0; a deeper
    // pyramid MUST configure terrain_available.
    if (!parse_availability(config.numbers("terrain_available"), &sc.availability)) {
        static const double kRoots[5] = {0, 0, 0, 1, 0};
        parse_availability(sdm_piv::Span<double>(kRoots, 5), &sc.availability);
    }
    const std::string available = availability_json(sc.availability);

    const long maxzoom = static_cast<long>(cfg_number(config, "terrain_maxzoom", 0));

    sc.layer_plan = std::string("{\"tilesetId\":\"") + json_escape(sc.tileset_id) + "\"" +
                    ",\"maxzoom\":" + std::to_string(maxzoom) + ",\"attribution\":\"" +
                    json_escape(cfg_string(config, "terrain_attribution", "")) + "\"" +
                    ",\"description\":\"" +
                    json_escape(cfg_string(config, "terrain_description", "")) + "\"" +
                    ",\"version\":\"" + json_escape(sc.version) + "\"" +
                    ",\"tiles\":\"" +
                    json_escape(cfg_string(config, "terrain_tiles_template",
                                            "{z}/{x}/{y}.terrain?v={version}")) + "\"" +
                    // The datum rides into layer.json, which is the ONLY
                    // metadata document a client on the IPFS path reads
                    // besides the catalogue record. See
                    // ServingConfig::vertical_datum_name.
                    ",\"verticalDatum\":\"GEOID\",\"verticalDatumName\":\"" +
                    json_escape(cfg_string(config, "terrain_vertical_datum_name",
                                            "EGM2008")) + "\"" +
                    ",\"available\":" + available + "}";

    sc.layer_plan_token = sha256_multihash(
        std::vector<uint8_t>(sc.layer_plan.begin(), sc.layer_plan.end()));

    sc.tileset_cid = cfg_string(config, "terrain_tileset_cid", "");
    sc.gateway_path = cfg_string(config, "terrain_gateway_path", "/ipfs/");
    if (sc.gateway_path.empty() || sc.gateway_path.back() != '/') sc.gateway_path += '/';
    sc.gateway_origin = cfg_string(config, "terrain_gateway_origin", "");
    while (!sc.gateway_origin.empty() && sc.gateway_origin.back() == '/')
        sc.gateway_origin.pop_back();
    sc.dataset_epoch = cfg_string(config, "terrain_dataset_epoch", "");
    sc.attribution = cfg_string(config, "terrain_attribution", "");
    sc.maxzoom = maxzoom;
    sc.tileset_size_bytes = cfg_number(config, "terrain_tileset_size_bytes", 0);
    sc.dataset_id = cfg_string(config, "terrain_dataset_id", "");
    sc.dataset_name = cfg_string(config, "terrain_dataset_name", "");
    sc.license = cfg_string(config, "terrain_license", "");
    sc.license_url = cfg_string(config, "terrain_license_url", "");
    sc.dataset_retrieved_at = cfg_string(config, "terrain_dataset_retrieved_at", "");
    // NOT terrain_tileset_cid. See ServingConfig::source_dataset_cid: the
    // tileset directory is PAYLOAD.CID and nothing else may be read as it.
    sc.source_dataset_cid = cfg_string(config, "terrain_source_dataset_cid", "");
    sc.vertical_datum_name = cfg_string(config, "terrain_vertical_datum_name", "EGM2008");
    {
        sc.has_extent = config.has("terrain_west_deg") && config.has("terrain_south_deg") &&
                        config.has("terrain_east_deg") && config.has("terrain_north_deg");
        if (sc.has_extent) {
            sc.west_deg = cfg_number(config, "terrain_west_deg", 0);
            sc.south_deg = cfg_number(config, "terrain_south_deg", 0);
            sc.east_deg = cfg_number(config, "terrain_east_deg", 0);
            sc.north_deg = cfg_number(config, "terrain_north_deg", 0);
        }
    }

    sc.ocean_synth_min_level = cfg_number(config, "terrain_ocean_synth_min_level", -1);
    const double synth = cfg_number(config, "terrain_synth_grid_size", 65);
    sc.synth_grid = static_cast<uint32_t>(synth < 2 || synth > 255 ? 65 : synth);
    return sc;
}

const ServingConfig& serving_config() {
    static ServingConfig* cached = nullptr;
    if (!cached) {
#ifdef TERRAIN_SOURCE_NO_HOST_BRIDGE
        cached = new ServingConfig(build_serving_config(sdm_piv::ConfigTable()));
#else
        // The host's response is kept only while the config is read: the availability index is walked in place
        // out of it, and what the instance holds afterwards is the parsed rectangles.
        const sdm_piv::Config config = sdm_piv::get_config();
        cached = new ServingConfig(build_serving_config(config.ok() ? static_cast<const sdm_piv::ConfigTable&>(config)
                                                                    : sdm_piv::ConfigTable()));
#endif
    }
    return *cached;
}

// The dttSourceClass member names, by wire ordinal. Matched EXACTLY: a name
// this table does not hold is refused, never mapped to a neighbour.
dttSourceClass parse_source_class(const std::string& name) {
    static const struct { const char* name; dttSourceClass value; } kClasses[] = {
        {"UNSPECIFIED", dttSourceClass_UNSPECIFIED},
        {"SPACEBORNE_RADAR_INTERFEROMETRIC", dttSourceClass_SPACEBORNE_RADAR_INTERFEROMETRIC},
        {"SPACEBORNE_OPTICAL_STEREO", dttSourceClass_SPACEBORNE_OPTICAL_STEREO},
        {"SPACEBORNE_ALTIMETRIC", dttSourceClass_SPACEBORNE_ALTIMETRIC},
        {"AIRBORNE_LIDAR", dttSourceClass_AIRBORNE_LIDAR},
        {"AIRBORNE_RADAR", dttSourceClass_AIRBORNE_RADAR},
        {"PHOTOGRAMMETRIC", dttSourceClass_PHOTOGRAMMETRIC},
        {"GROUND_SURVEY", dttSourceClass_GROUND_SURVEY},
        {"BATHYMETRIC_SOUNDING", dttSourceClass_BATHYMETRIC_SOUNDING},
        {"CARTOGRAPHIC_CONTOUR", dttSourceClass_CARTOGRAPHIC_CONTOUR},
        {"FUSED_MULTI_SOURCE", dttSourceClass_FUSED_MULTI_SOURCE},
        {"SYNTHETIC", dttSourceClass_SYNTHETIC},
    };
    for (const auto& entry : kClasses) {
        if (name == entry.name) return entry.value;
    }
    return dttSourceClass_UNSPECIFIED;
}

// ── A BODY OTHER THAN EARTH (GEOGRAPHIC_TWO_ROOT_BODY) ──────────────────────
//
// The same two-root geographic addressing as GEOGRAPHIC_WGS84 (tile_extent and
// the lattice are unchanged), on the body the plan NAMES: CENTER_NAME (never
// EARTH, whose tiles keep the WGS84 scheme), REFERENCE_RADII_M with ONE radius
// (a reference sphere; a spheroid or triaxial body is refused, see
// body_shape.hpp) and heights above that sphere (VERTICAL_DATUM
// REFERENCE_SPHERE, or UNSPECIFIED read as it). Its source is a PDS product
// (pds_img.hpp), its tiles carry oct-encoded normals and no water mask, and its
// record states the body, the radii and the horizontal datum the plan gives.
struct BodyPlan {
    bool active = false;
    BodyShape shape = kEarthShape;
    std::string center_name;
    std::string horizontal_datum;
    std::string remarks;
};

// A body tile's extra report facts: whether it is OVER CAP (the 32 KiB ceiling
// stopped its density climb before it met its error target), its RMS
// departure from the source posts, and the non-empty
// bins of its departure histogram as "bin:count" pairs (bin k = [k, k+1) m,
// the last bin, kResidualHistogramBins - 1, everything beyond). The range runs
// to 8 km so a coarse level's percentiles are values, not the floor of an
// overflow bin (level 0's target alone is 1.9 km).
constexpr size_t kResidualHistogramBins = 8193;
std::string body_tile_items(bool over_cap, double rms_m, const std::vector<uint64_t>& histogram) {
    std::string out = std::string(" overCap=") + (over_cap ? "true" : "false") + " rmsM=" + fmt_double(rms_m);
    std::string bins;
    for (size_t k = 0; k < histogram.size(); k++) {
        if (!histogram[k]) continue;
        if (!bins.empty()) bins += ",";
        bins += std::to_string(k) + ":" + std::to_string(histogram[k]);
    }
    return out + " residualHistogramM=" + bins;
}

// 0 = not a body plan; otherwise the HTTP status of the refusal (error set).
int parse_body_plan(const std::vector<const DTT*>& headers, BodyPlan* body) {
    const DTT& head = *headers[0];
    if (head.TILING_SCHEME() != dttTilingScheme_GEOGRAPHIC_TWO_ROOT_BODY) return 0;
    const std::string center = head.CENTER_NAME() ? head.CENTER_NAME()->str() : std::string();
    std::string upper = center;
    for (char& c : upper) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    if (center.empty() || upper == "EARTH") {
        plugin_set_error("bad-body-plan",
                         "GEOGRAPHIC_TWO_ROOT_BODY needs CENTER_NAME naming a body other than EARTH "
                         "(Earth's tiles are GEOGRAPHIC_WGS84).");
        return 400;
    }
    const auto* radii = head.REFERENCE_RADII_M();
    if (!radii || radii->size() == 0) {
        plugin_set_error("bad-body-plan", "a body plan must state REFERENCE_RADII_M.");
        return 400;
    }
    if (radii->size() != 1) {
        plugin_set_error("unsupported-reference-body",
                         "only a reference SPHERE (one REFERENCE_RADII_M value) is modelled: on a spheroid "
                         "planetocentric and geodetic latitude differ and that conversion is not done here, so "
                         "a two- or three-radius body is refused rather than mis-posted.");
        return 422;
    }
    const double r = radii->Get(0);
    if (!(r > 0) || !std::isfinite(r)) {
        plugin_set_error("bad-body-plan", "REFERENCE_RADII_M must be a positive finite radius in metres.");
        return 400;
    }
    if (head.VERTICAL_DATUM() != dttVerticalDatum_REFERENCE_SPHERE &&
        head.VERTICAL_DATUM() != dttVerticalDatum_UNSPECIFIED) {
        plugin_set_error("bad-body-plan",
                         "a body's heights are above its reference sphere: VERTICAL_DATUM must be "
                         "REFERENCE_SPHERE (or UNSPECIFIED, read as it).");
        return 400;
    }
    for (const DTT* h : headers) {
        const auto* hr = h->REFERENCE_RADII_M();
        if (h->TILING_SCHEME() != head.TILING_SCHEME() || !h->CENTER_NAME() || h->CENTER_NAME()->str() != center ||
            !hr || hr->size() != 1 || hr->Get(0) != r || h->VERTICAL_DATUM() != head.VERTICAL_DATUM()) {
            plugin_set_error("mixed-body-plan",
                             "every header record of one body plan must state the same scheme, CENTER_NAME, "
                             "REFERENCE_RADII_M and VERTICAL_DATUM.");
            return 400;
        }
    }
    body->active = true;
    body->shape = BodyShape{r, r};
    body->center_name = center;
    body->horizontal_datum = head.HORIZONTAL_DATUM_NAME() ? head.HORIZONTAL_DATUM_NAME()->str() : std::string();
    body->remarks = head.REMARKS() && head.REMARKS()->size()
                        ? head.REMARKS()->str()
                        : std::string("Heights are metres above the body's reference sphere (VERTICAL_DATUM "
                                      "REFERENCE_SPHERE, radius REFERENCE_RADII_M) as the source product publishes "
                                      "them; no geoid is applied.");
    return 0;
}

// A post of the GLOBAL lattice by its global row/column, with the one-post
// halo beyond a tile folded back onto the body: a row past a pole is the row
// the same distance on the other side of it, half way round; a column past the
// antimeridian wraps. The doubles are the ones lattice_lat/lattice_lon give the
// same post from the tile that owns it.
void body_lattice_post(uint32_t level, uint32_t grid, int64_t row, int64_t col, double* lat, double* lon) {
    const int64_t rows = static_cast<int64_t>(1u << level) * (grid - 1);   // pole to pole
    const int64_t cols = static_cast<int64_t>(2u << level) * (grid - 1);   // once round
    if (row < 0) { row = -row; col += cols / 2; }
    if (row > rows) { row = 2 * rows - row; col += cols / 2; }
    col %= cols;
    if (col < 0) col += cols;
    const double lat_step = 180.0 / (static_cast<double>(1u << level) * (grid - 1));
    const double lon_step = 360.0 / (static_cast<double>(2u << level) * (grid - 1));
    *lat = -90.0 + static_cast<double>(row) * lat_step;
    *lon = -180.0 + static_cast<double>(col) * lon_step;
}

constexpr const char* kGeoidRemark =
    "Heights are geoid-referenced as the source dataset publishes them (VERTICAL_DATUM "
    "GEOID); no geoid-to-ellipsoid conversion is applied at this parity floor. A consumer "
    "rendering them as above-ellipsoid accepts a bounded (<~100 m) vertical offset.";

// The offline parent lane accepts only this module's regular-grid mesh codec.
// It is a bounded binary transform, not a general mesh repair/import facility.
constexpr uint32_t kParentGrid = 65;
constexpr size_t kParentRecordLimit = 2u * 1024u * 1024u;
constexpr size_t kParentStreamLimit = 4u * (kParentRecordLimit + 4u);
constexpr const char* kParentProcessor =
    "com.digitalarsenal.data-source.terrain-source/reduce_parent@0.1.1";
constexpr const char* kParentBound = "child-cell-parent-cell-envelope-v1";

std::string parent_string(const flatbuffers::String* s) { return s ? s->str() : ""; }

struct ParentMesh {
    uint32_t grid = 0;
    std::vector<double> axis, heights;
    std::vector<uint8_t> water;
};

struct ParentChild {
    std::vector<uint8_t> record;
    const DTT* tile = nullptr;
    ParentMesh mesh;
    std::string digest;
};

// Inflate into the declared, capped allocation. Heap-growing inflate followed
// by an ISIZE check would allow a hostile stream to allocate before refusal.
bool parent_payload(const DTTPayloadRef* ref, size_t limit, const char* media,
                    std::vector<uint8_t>* out) {
    if (!ref || !ref->BYTES() || ref->BYTES()->size() == 0 ||
        ref->BYTES()->size() > kParentRecordLimit ||
        ref->SIZE_BYTES() != ref->BYTES()->size() ||
        parent_string(ref->MEDIA_TYPE()) != media) return false;
    const std::vector<uint8_t> stored(ref->BYTES()->begin(), ref->BYTES()->end());
    if (parent_string(ref->DIGEST()) != sha256_multihash(stored)) return false;
    const auto encoding = parent_string(ref->CONTENT_ENCODING());
    if (encoding.empty()) {
        if (stored.size() > limit) return false;
        *out = stored;
        return true;
    }
    if (encoding != "gzip" || stored.size() < 18 || stored[0] != 31 ||
        stored[1] != 139 || stored[2] != 8 || stored[3] != 0) return false;
    const auto little = [&](size_t p) {
        return uint32_t(stored[p]) | uint32_t(stored[p + 1]) << 8 |
               uint32_t(stored[p + 2]) << 16 | uint32_t(stored[p + 3]) << 24;
    };
    const uint32_t length = little(stored.size() - 4);
    if (length == 0 || length > limit) return false;
    out->resize(length);
    const size_t actual = tinfl_decompress_mem_to_mem(
        out->data(), out->size(), stored.data() + 10, stored.size() - 18, 0);
    return actual == length &&
           uint32_t(mz_crc32(MZ_CRC32_INIT, out->data(), out->size())) ==
               little(stored.size() - 8);
}

bool parent_decode_mesh(const DTT* tile, ParentMesh* out) {
    std::vector<uint8_t> bytes;
    if (!parent_payload(tile->PAYLOAD(), 8u * 1024u * 1024u,
                        "application/vnd.quantized-mesh", &bytes) || bytes.size() < 92)
        return false;
    size_t at = 0;
    bool good = true;
    auto integer = [&](size_t width) -> uint32_t {
        if (at + width > bytes.size()) { good = false; return 0; }
        uint32_t value = 0;
        for (size_t i = 0; i < width; ++i) value |= uint32_t(bytes[at++]) << (8 * i);
        return value;
    };
    float min_h, max_h;
    std::memcpy(&min_h, bytes.data() + 24, 4);
    std::memcpy(&max_h, bytes.data() + 28, 4);
    if (!std::isfinite(min_h) || !std::isfinite(max_h) || min_h > max_h ||
        std::fabs(double(min_h) - tile->MIN_HEIGHT_M()) >
            std::max(0.001, std::fabs(double(min_h)) * 0.000001) ||
        std::fabs(double(max_h) - tile->MAX_HEIGHT_M()) >
            std::max(0.001, std::fabs(double(max_h)) * 0.000001)) return false;
    at = 88;
    const uint32_t count = integer(4);
    if (count < 4 || count > 511u * 511u) return false;
    const uint32_t grid = uint32_t(std::sqrt(double(count)));
    if (grid * grid != count || bytes.size() - at < size_t(count) * 6) return false;
    out->grid = grid;
    out->axis.resize(grid);
    std::vector<uint16_t> quant_axis(grid);
    for (uint32_t i = 0; i < grid; ++i) {
        quant_axis[i] = uint16_t(32767ull * i / (grid - 1));
        out->axis[i] = double(quant_axis[i]) / 32767.0;
    }
    std::array<std::vector<uint16_t>, 3> values;
    for (auto& array : values) {
        array.resize(count);
        int32_t value = 0;
        for (uint32_t i = 0; i < count; ++i) {
            const uint32_t code = integer(2);
            value += int32_t(code >> 1) ^ -int32_t(code & 1);
            if (value < 0 || value > 32767) return false;
            array[i] = uint16_t(value);
        }
    }
    out->heights.assign(count, 0);
    std::vector<uint32_t> remap(count);
    std::vector<bool> seen(count, false);
    for (uint32_t i = 0; i < count; ++i) {
        const auto u = std::lower_bound(quant_axis.begin(), quant_axis.end(), values[0][i]);
        const auto v = std::lower_bound(quant_axis.begin(), quant_axis.end(), values[1][i]);
        if (u == quant_axis.end() || v == quant_axis.end() ||
            *u != values[0][i] || *v != values[1][i]) return false;
        const uint32_t index = uint32_t(v - quant_axis.begin()) * grid +
                               uint32_t(u - quant_axis.begin());
        if (seen[index]) return false;
        seen[index] = true;
        remap[i] = index;
        out->heights[index] = double(min_h) +
            (double(max_h) - double(min_h)) * double(values[2][i]) / 32767.0;
    }
    const size_t width = count > 65536 ? 4 : 2;
    at = (at + width - 1) / width * width;
    const uint32_t triangles = integer(4);
    if (triangles != (grid - 1) * (grid - 1) * 2 ||
        size_t(triangles) * 3 * width > bytes.size() - at) return false;
    uint32_t highest = 0;
    std::vector<uint8_t> cells((grid - 1) * (grid - 1), 0);
    for (uint32_t i = 0; i < triangles; ++i) {
        uint32_t ids[3];
        for (auto& id : ids) {
            const uint32_t code = integer(width);
            if (code > highest) return false;
            const uint32_t index = highest - code;
            if (code == 0) ++highest;
            if (index >= count) return false;
            id = remap[index];
        }
        const uint32_t lo = std::min(ids[0], std::min(ids[1], ids[2]));
        const uint32_t x = lo % grid, y = lo / grid;
        if (x >= grid - 1 || y >= grid - 1) return false;
        uint8_t kind = 0;
        for (uint32_t r = 0; r < 3; ++r) {
            if (ids[r] != lo) continue;
            if (ids[(r + 1) % 3] == lo + 1 && ids[(r + 2) % 3] == lo + grid + 1)
                kind = 1;
            if (ids[(r + 1) % 3] == lo + grid + 1 && ids[(r + 2) % 3] == lo + grid)
                kind = 2;
        }
        auto& cell = cells[y * (grid - 1) + x];
        if (!kind || (cell & kind)) return false;
        cell |= kind;
    }
    for (uint8_t cell : cells) if (cell != 3) return false;
    for (uint32_t edge = 0; edge < 4; ++edge) {
        if (integer(4) != grid) return false;
        std::vector<bool> edge_seen(count, false);
        for (uint32_t i = 0; i < grid; ++i) {
            const uint32_t index = integer(width);
            if (!good || index >= count || edge_seen[index]) return false;
            edge_seen[index] = true;
            const uint32_t id = remap[index];
            if ((edge == 0 && id % grid != 0) ||
                (edge == 1 && id / grid != 0) ||
                (edge == 2 && id % grid != grid - 1) ||
                (edge == 3 && id / grid != grid - 1)) return false;
        }
    }
    if (integer(1) != 2) return false;
    const uint32_t mask_length = integer(4);
    if (!good || (mask_length != 1 && mask_length != kMaskSize * kMaskSize) ||
        at + mask_length != bytes.size()) return false;
    out->water.assign(bytes.begin() + at, bytes.end());
    const auto kind = tile->WATER_MASK_KIND();
    if (kind == dttWaterMask_RASTER) {
        std::vector<uint8_t> mask;
        if (mask_length != kMaskSize * kMaskSize ||
            tile->WATER_MASK_WIDTH() != kMaskSize || tile->WATER_MASK_HEIGHT() != kMaskSize ||
            !parent_payload(tile->WATER_MASK(), kMaskSize * kMaskSize,
                            "application/octet-stream", &mask) || mask != out->water) return false;
    } else {
        if (mask_length != 1 || tile->WATER_MASK() || tile->WATER_MASK_WIDTH() ||
            tile->WATER_MASK_HEIGHT() ||
            (kind != dttWaterMask_UNIFORM_LAND && kind != dttWaterMask_UNIFORM_WATER) ||
            out->water[0] != (kind == dttWaterMask_UNIFORM_WATER ? 255 : 0)) return false;
        const uint8_t uniform_coverage = out->water[0];
        out->water.assign(kMaskSize * kMaskSize, uniform_coverage);
    }
    return true;
}

uint32_t parent_cell(const ParentMesh& mesh, double coordinate) {
    const auto found = std::upper_bound(mesh.axis.begin(), mesh.axis.end(), coordinate);
    return std::min(mesh.grid - 2, uint32_t(std::max<ptrdiff_t>(0, found - mesh.axis.begin() - 1)));
}

double parent_sample(const ParentMesh& mesh, double u, double v) {
    const uint32_t x = parent_cell(mesh, u), y = parent_cell(mesh, v), n = mesh.grid;
    const double fu = (u - mesh.axis[x]) / (mesh.axis[x + 1] - mesh.axis[x]);
    const double fv = (v - mesh.axis[y]) / (mesh.axis[y + 1] - mesh.axis[y]);
    const double bl = mesh.heights[y * n + x], br = mesh.heights[y * n + x + 1];
    const double tl = mesh.heights[(y + 1) * n + x], tr = mesh.heights[(y + 1) * n + x + 1];
    return fu >= fv ? bl * (1 - fu) + br * (fu - fv) + tr * fv
                    : bl * (1 - fv) + tr * fu + tl * (fv - fu);
}

// A linear triangle stays inside its vertex height envelope. Each child cell
// overlaps only a bounded set of parent cells; comparing their envelopes is a
// conservative bound everywhere, including triangle crossings between posts.
// Sampling only child vertices would NOT establish this bound.
double parent_difference_bound(const ParentMesh& child, const ParentMesh& parent,
                               uint32_t east, uint32_t north) {
    double bound = 0;
    for (uint32_t y = 0; y + 1 < child.grid; ++y) {
        for (uint32_t x = 0; x + 1 < child.grid; ++x) {
            const double h[] = {child.heights[y * child.grid + x],
                child.heights[y * child.grid + x + 1],
                child.heights[(y + 1) * child.grid + x],
                child.heights[(y + 1) * child.grid + x + 1]};
            const double low = *std::min_element(h, h + 4), high = *std::max_element(h, h + 4);
            const uint32_t x0 = parent_cell(parent, (east + child.axis[x]) / 2);
            const uint32_t x1 = parent_cell(parent, (east + child.axis[x + 1]) / 2);
            const uint32_t y0 = parent_cell(parent, (north + child.axis[y]) / 2);
            const uint32_t y1 = parent_cell(parent, (north + child.axis[y + 1]) / 2);
            for (uint32_t py = y0; py <= y1; ++py) for (uint32_t px = x0; px <= x1; ++px) {
                const double p[] = {parent.heights[py * parent.grid + px],
                    parent.heights[py * parent.grid + px + 1],
                    parent.heights[(py + 1) * parent.grid + px],
                    parent.heights[(py + 1) * parent.grid + px + 1]};
                const double p_low = *std::min_element(p, p + 4), p_high = *std::max_element(p, p + 4);
                bound = std::max(bound, std::max(std::fabs(p_high - low), std::fabs(high - p_low)));
            }
        }
    }
    return bound;
}

bool parent_timestamp(const std::string& s) {
    if (s.size() != 24 || s[4] != '-' || s[7] != '-' || s[10] != 'T' ||
        s[13] != ':' || s[16] != ':' || s[19] != '.' || s[23] != 'Z') return false;
    for (size_t i = 0; i < s.size(); ++i)
        if (i != 4 && i != 7 && i != 10 && i != 13 && i != 16 && i != 19 && i != 23 &&
            (s[i] < '0' || s[i] > '9')) return false;
    const int month = std::atoi(s.substr(5, 2).c_str()), day = std::atoi(s.substr(8, 2).c_str());
    return month >= 1 && month <= 12 && day >= 1 && day <= 31 &&
        std::atoi(s.substr(11, 2).c_str()) <= 23 && std::atoi(s.substr(14, 2).c_str()) <= 59 &&
        std::atoi(s.substr(17, 2).c_str()) <= 59;
}

bool parent_same_provenance(const DTTProvenance* a, const DTTProvenance* b) {
    if (!a || !b) return a == b;
    return parent_string(a->DATASET_ID()) == parent_string(b->DATASET_ID()) &&
        parent_string(a->DATASET_NAME()) == parent_string(b->DATASET_NAME()) &&
        parent_string(a->DATASET_URL()) == parent_string(b->DATASET_URL()) &&
        parent_string(a->DATASET_EPOCH()) == parent_string(b->DATASET_EPOCH()) &&
        parent_string(a->DATASET_CID()) == parent_string(b->DATASET_CID()) &&
        parent_string(a->LICENSE()) == parent_string(b->LICENSE()) &&
        parent_string(a->LICENSE_URL()) == parent_string(b->LICENSE_URL()) &&
        parent_string(a->ATTRIBUTION()) == parent_string(b->ATTRIBUTION()) &&
        a->NON_COMMERCIAL_ONLY() == b->NON_COMMERCIAL_ONLY() && a->SHARE_ALIKE() == b->SHARE_ALIKE();
}

flatbuffers::Offset<DTTProvenance> parent_provenance(flatbuffers::FlatBufferBuilder& b,
    const DTTProvenance* source, const std::string& retrieved, const std::string& query) {
    const auto copy = [&](const flatbuffers::String* s) {
        return s ? b.CreateString(s->str()) : flatbuffers::Offset<flatbuffers::String>(0);
    };
    const auto id = copy(source->DATASET_ID()), name = copy(source->DATASET_NAME());
    const auto url = copy(source->DATASET_URL()), epoch = copy(source->DATASET_EPOCH());
    const auto cid = copy(source->DATASET_CID()), license = copy(source->LICENSE());
    const auto license_url = copy(source->LICENSE_URL()), attribution = copy(source->ATTRIBUTION());
    const auto when = b.CreateString(retrieved), selection = b.CreateString(query);
    const auto processor = b.CreateString(kParentProcessor);
    DTTProvenanceBuilder builder(b);
    builder.add_DATASET_ID(id); builder.add_DATASET_NAME(name); builder.add_DATASET_URL(url);
    builder.add_DATASET_EPOCH(epoch); builder.add_DATASET_CID(cid);
    builder.add_LICENSE(license); builder.add_LICENSE_URL(license_url); builder.add_ATTRIBUTION(attribution);
    builder.add_NON_COMMERCIAL_ONLY(source->NON_COMMERCIAL_ONLY());
    builder.add_SHARE_ALIKE(source->SHARE_ALIKE()); builder.add_RETRIEVED_AT(when);
    builder.add_SOURCE_QUERY(selection); builder.add_PROCESSOR(processor);
    // No invented production timestamp or single-granule URL for a derived tile.
    return builder.Finish();
}

// ── the serving lane's typed frames (route / layer_json / respond) ──────────
//
// Typed contracts 1.0: route forwards the $HTQ it accepted - verbatim - to layer_json ("layer_plan") and to respond
// ("context"), and each re-derives what it needs from that request and the mount's config with the SAME functions route
// uses (mount prefix, the one admitted query token, the tile address, If-None-Match and Accept-Encoding), so the three
// nodes cannot disagree about a request and no bespoke context shape crosses a port. The record-store read is a
// FlatSQL $FSO (QUERY_RECORDS) for hostcap/flatsql-query, answered as $FSB chunks plus one $FSO status.

const sdn::http::HttpRequest* htq_input(const char* port, bool* present) {
    *present = false;
    const int32_t idx = plugin_find_input_index(port, 0);
    const plugin_input_frame_t* frame = idx >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(idx)) : nullptr;
    if (!frame) return nullptr;
    *present = true;
    if (!frame->payload || frame->payload_length < 8) return nullptr;
    ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!sdn::http::VerifyHttpRequestBuffer(verifier)) return nullptr;
    return sdn::http::GetHttpRequest(frame->payload);
}

// CONDITIONAL AND NEGOTIATION STATE. If-None-Match is BOUNDED AT THE DOOR: every ETag this module issues is a quoted
// sha2-256 multihash (71 bytes), so a value past 256 bytes cannot match one and is DROPPED (degrades to a 200).
// Accept-Encoding: absent means anything is acceptable (RFC 9110 12.5.3), so gzip is the default and only an explicit
// refusal changes it; a value past 512 bytes is not a negotiation and reads as "gzip is fine".
struct Negotiation {
    std::string if_none_match;
    bool accepts_gzip = true;
};

Negotiation negotiation_of(const sdn::http::HttpRequest* request) {
    constexpr size_t kMaxIfNoneMatchBytes = 256;
    Negotiation n;
    if (!request || !request->HEADERS()) return n;
    for (const auto* h : *request->HEADERS()) {
        if (!h->NAME() || !h->VALUE()) continue;
        const std::string name = h->NAME()->str();
        if (name == "if-none-match") {
            if (h->VALUE()->size() <= kMaxIfNoneMatchBytes) n.if_none_match = h->VALUE()->str();
            else n.if_none_match.clear();
        } else if (name == "accept-encoding") {
            if (h->VALUE()->size() <= 512) n.accepts_gzip = accept_encoding_allows_gzip(h->VALUE()->str());
        }
    }
    return n;
}

// The serving config for THIS invocation: the optional "config" port's ModuleConfig when one is wired (the parity
// lane, and any caller with no host bridge), cached against its own bytes because a 4.4 MB availability index must
// not be re-parsed per invoke; else the host's, read once per instance (serving_config). nullptr: the frame is not
// a ModuleConfig.
const ServingConfig* invocation_serving_config() {
    static std::string* frame_config_key = new std::string();
    static ServingConfig* frame_config_value = new ServingConfig();
    const int32_t idx = plugin_find_input_index("config", 0);
    const plugin_input_frame_t* frame = idx >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(idx)) : nullptr;
    if (!frame) return &serving_config();
    const size_t length = frame->payload ? frame->payload_length : 0;
    if (length == 0) return nullptr;
    if (frame_config_key->size() == length && std::memcmp(frame_config_key->data(), frame->payload, length) == 0)
        return frame_config_value;
    // Verified and read in place (copied to an 8-aligned buffer only when the frame is not aligned).
    std::vector<uint64_t> aligned;
    const uint8_t* data = frame->payload;
    if (reinterpret_cast<uintptr_t>(data) % 8) {
        aligned.resize((length + 7) / 8);
        std::memcpy(aligned.data(), frame->payload, length);
        data = reinterpret_cast<const uint8_t*>(aligned.data());
    }
    ::flatbuffers::Verifier::Options options;
    options.max_tables = 100000000;
    ::flatbuffers::Verifier verifier(data, length, options);
    if (length < 8 || !sdn::runtime::VerifyModuleConfigBuffer(verifier)) return nullptr;
    *frame_config_value = build_serving_config(sdm_piv::ConfigTable(sdn::runtime::GetModuleConfig(data)->ENTRIES()));
    frame_config_key->assign(reinterpret_cast<const char*>(frame->payload), length);
    return frame_config_value;
}

// The path below the mount, when the request is addressed to it with at most the one admitted query token ("v=" +
// the configured version); false otherwise (route answers those 404).
bool mount_rest_of(const ServingConfig& cfg, const sdn::http::HttpRequest* request, std::string* rest) {
    const std::string path = request && request->PATH() ? request->PATH()->str() : "";
    const std::string raw_query = request && request->QUERY() ? request->QUERY()->str() : "";
    if (path.size() < cfg.mount_prefix.size() || path.compare(0, cfg.mount_prefix.size(), cfg.mount_prefix) != 0)
        return false;
    if (!raw_query.empty() && raw_query != "v=" + cfg.version) return false;
    *rest = path.substr(cfg.mount_prefix.size());
    return true;
}

// The layer_json plan: the mount's layer plan (built once with the config) plus the request's conditional state.
std::string layer_plan_for(const ServingConfig& cfg, const Negotiation& n) {
    std::string plan = cfg.layer_plan;
    plan.insert(plan.size() - 1, std::string(",\"planToken\":\"") + cfg.layer_plan_token + "\"" +
                                     ",\"ifNoneMatch\":\"" + json_escape(n.if_none_match) + "\"" +
                                     ",\"acceptsGzip\":" + (n.accepts_gzip ? "true" : "false"));
    return plan;
}

// respond's serve context for one tile address: the address, its conditional state, and what a miss there means.
std::string serve_context_for(const ServingConfig& cfg, uint32_t z, uint32_t x, uint32_t y, const Negotiation& n) {
    const bool inside = address_available_to_client(cfg.availability, z, x, y);
    const double ocean_min_raw = cfg.ocean_synth_min_level;
    const bool synth_water = ocean_min_raw >= 0 && static_cast<double>(z) >= ocean_min_raw;
    return std::string("{\"tilesetId\":\"") + json_escape(cfg.tileset_id) + "\"" +
           ",\"level\":" + std::to_string(z) + ",\"x\":" + std::to_string(x) + ",\"y\":" + std::to_string(y) +
           ",\"ifNoneMatch\":\"" + json_escape(n.if_none_match) + "\",\"acceptsGzip\":" +
           (n.accepts_gzip ? "true" : "false") + ",\"insideAvailability\":" + (inside ? "true" : "false") +
           ",\"synthWater\":" + (synth_water ? "true" : "false") + ",\"maxLevel\":" + std::to_string(cfg.maxzoom) +
           ",\"synthGridSize\":" + std::to_string(cfg.synth_grid) + "}";
}

// FlatSQL's tagged parameter encoding: [u8 tag][u32le size][bytes] (tags 2 int64, 4 string).
void fso_param_string(std::vector<uint8_t>* out, const std::string& v) {
    out->push_back(4);
    put_u32(out, static_cast<uint32_t>(v.size()));
    out->insert(out->end(), v.begin(), v.end());
}
void fso_param_int(std::vector<uint8_t>* out, int64_t v) {
    out->push_back(2);
    put_u32(out, 8);
    for (int i = 0; i < 8; i++) out->push_back(static_cast<uint8_t>((static_cast<uint64_t>(v) >> (8 * i)) & 0xff));
}

int push_tile_query(const ServingConfig& cfg, uint32_t z, uint32_t x, uint32_t y) {
    const std::string sql =
        "SELECT _data FROM DTT WHERE TILESET_ID = ? AND LEVEL = ? AND X = ? AND Y = ? "
        "ORDER BY _rowid DESC LIMIT 1";
    std::vector<uint8_t> params;
    fso_param_string(&params, cfg.tileset_id);
    fso_param_int(&params, z);
    fso_param_int(&params, x);
    fso_param_int(&params, y);
    ::flatbuffers::FlatBufferBuilder b(512 + sql.size() + params.size());
    const auto query = b.CreateVector(reinterpret_cast<const uint8_t*>(sql.data()), sql.size());
    const auto parameters = b.CreateVector(params);
    FSOBuilder fso(b);
    fso.add_OPERATION(flatSqlNodeOperation_QUERY_RECORDS);
    fso.add_QUERY(query);
    fso.add_PARAMETERS(parameters);
    fso.add_PARAMETER_COUNT(4);
    FinishFSOBuffer(b, fso.Finish());
    return plugin_push_output_ex("query", "FSO.fbs", FSOIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "FSO", 0,
                                 0, b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize()));
}

int push_htq(const char* port, const plugin_input_frame_t* frame) {
    return plugin_push_output_ex(port, "HttpRequestAbi.fbs", "$HTQ", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "HttpRequest", 0, 0, frame->payload, frame->payload_length);
}

}  // namespace

extern "C" {

int reduce_parent(void) {
    const auto fail = [](const char* message) {
        plugin_set_error("invalid-parent-children", message);
        return 400;
    };
    if (plugin_get_input_count() != 1)
        return fail("reduce_parent requires exactly one children stream.");
    const plugin_input_frame_t* input = plugin_get_input_frame(0);
    if (!input || !input->port_id || std::strcmp(input->port_id, "children") ||
        !input->payload || input->payload_length > kParentStreamLimit)
        return fail("The children stream is absent, misaddressed, or exceeds the byte limit.");
    std::array<ParentChild, 4> storage;
    std::array<ParentChild*, 4> children{};
    size_t at = 0;
    for (auto& child : storage) {
        if (at + 4 > input->payload_length) return fail("Four complete DTT records are required.");
        uint32_t size = 0;
        for (uint32_t i = 0; i < 4; ++i) size |= uint32_t(input->payload[at++]) << (8 * i);
        if (size < 8 || size > kParentRecordLimit || size > input->payload_length - at)
            return fail("A child DTT frame has an invalid size.");
        child.record.assign(input->payload + at, input->payload + at + size);
        at += size;
        flatbuffers::Verifier verifier(child.record.data(), child.record.size(), 32, 128);
        if (!VerifyDTTBuffer(verifier)) return fail("A child is not a valid canonical DTT record.");
        child.tile = GetDTT(child.record.data());
        const DTT* t = child.tile;
        if (t->TILING_SCHEME() == dttTilingScheme_GEOGRAPHIC_TWO_ROOT_BODY ||
            (t->PAYLOAD() && parent_string(t->PAYLOAD()->CONTENT_ENCODING()) == kEdgeMatchedPlanes))
            return fail("reduce_parent supports Earth GEOGRAPHIC_WGS84 regular grids only; body tiles are refused before decoding.");
        const auto* p = t->PROVENANCE();
        if (t->LEVEL() < 1 || t->LEVEL() > 24 || t->X() >= (2u << t->LEVEL()) ||
            t->Y() >= (1u << t->LEVEL()) || t->ROW_ORIGIN_NORTH() ||
            t->TILING_SCHEME() != dttTilingScheme_GEOGRAPHIC_WGS84 ||
            t->PAYLOAD_FORMAT() != dttPayloadFormat_QUANTIZED_MESH ||
            parent_string(t->PAYLOAD_FORMAT_VERSION()) != "1.0" ||
            parent_string(t->TILESET_ID()).empty() || !p ||
            parent_string(p->DATASET_ID()).empty() || parent_string(p->LICENSE()).empty() ||
            !parent_timestamp(parent_string(p->DATASET_EPOCH())) ||
            !parent_timestamp(parent_string(p->RETRIEVED_AT())) ||
            !std::isfinite(t->MIN_HEIGHT_M()) || !std::isfinite(t->MAX_HEIGHT_M()) ||
            t->MIN_HEIGHT_M() > t->MAX_HEIGHT_M() ||
            !std::isfinite(t->DATA_COVERAGE_FRACTION()) ||
            t->DATA_COVERAGE_FRACTION() < 0 || t->DATA_COVERAGE_FRACTION() > 1 ||
            !std::isfinite(t->SOURCE_POST_SPACING_M()) || t->SOURCE_POST_SPACING_M() < 0 ||
            t->MAX_LEVEL() < t->LEVEL() || t->VERTICAL_DATUM() == dttVerticalDatum_UNSPECIFIED ||
            parent_string(t->VERTICAL_DATUM_NAME()).empty())
            return fail("Child address, codec, datum, edition, coverage, or provenance is unsupported.");
        const double span = std::ldexp(180.0, -int(t->LEVEL()));
        if (t->WEST_DEG() != -180 + t->X() * span ||
            t->EAST_DEG() != -180 + (t->X() + 1) * span ||
            t->SOUTH_DEG() != -90 + t->Y() * span ||
            t->NORTH_DEG() != -90 + (t->Y() + 1) * span)
            return fail("Child extent disagrees with its geographic TMS address.");
        const uint32_t quadrant = (t->Y() & 1) * 2 + (t->X() & 1);
        if (children[quadrant]) return fail("Duplicate child quadrant.");
        children[quadrant] = &child;
        child.digest = sha256_multihash(child.record);
        if (!parent_decode_mesh(t, &child.mesh))
            return fail("Child mesh or water mask is corrupt, inconsistent, or outside the supported codec.");
    }
    if (at != input->payload_length) return fail("Trailing or excessive child records are refused.");
    const DTT* first = children[0]->tile;
    std::string retrieved, water_retrieved;
    bool inherited_complete = true;
    double coverage = 0, source_spacing = 0;
    for (const ParentChild* child : children) {
        const DTT* t = child->tile;
        if (t->LEVEL() != first->LEVEL() || t->X() / 2 != first->X() / 2 ||
            t->Y() / 2 != first->Y() / 2 || t->MAX_LEVEL() != first->MAX_LEVEL() ||
            parent_string(t->TILESET_ID()) != parent_string(first->TILESET_ID()) ||
            parent_string(t->TILESET_NAME()) != parent_string(first->TILESET_NAME()) ||
            t->VERTICAL_DATUM() != first->VERTICAL_DATUM() ||
            parent_string(t->VERTICAL_DATUM_NAME()) != parent_string(first->VERTICAL_DATUM_NAME()) ||
            parent_string(t->EPOCH()) != parent_string(first->EPOCH()) ||
            t->SOURCE_CLASS() != first->SOURCE_CLASS() ||
            !parent_same_provenance(t->PROVENANCE(), first->PROVENANCE()) ||
            !parent_same_provenance(t->WATER_MASK_PROVENANCE(), first->WATER_MASK_PROVENANCE()))
            return fail("Children must be siblings from one compatible dataset, edition, datum, and licence.");
        retrieved = std::max(retrieved, parent_string(t->PROVENANCE()->RETRIEVED_AT()));
        if (const auto* p = t->WATER_MASK_PROVENANCE()) {
            const auto time = parent_string(p->RETRIEVED_AT());
            if (!parent_timestamp(time) || !parent_timestamp(parent_string(p->DATASET_EPOCH())) ||
                parent_string(p->DATASET_ID()).empty() || parent_string(p->LICENSE()).empty())
                return fail("Incomplete water-mask provenance.");
            water_retrieved = std::max(water_retrieved, time);
        }
        if (!std::isfinite(t->VERTICAL_ACCURACY_M()) || t->VERTICAL_ACCURACY_M() < 0 ||
            t->ACCURACY_CONFIDENCE() != 1.0) inherited_complete = false;
        coverage += t->DATA_COVERAGE_FRACTION() / 4.0;
        source_spacing = std::max(source_spacing, t->SOURCE_POST_SPACING_M());
    }
    TileJob job;
    job.level = first->LEVEL() - 1; job.x = first->X() / 2; job.y = first->Y() / 2;
    const double span = std::ldexp(180.0, -int(job.level));
    TileExtent extent;
    extent.west = -180 + job.x * span; extent.east = extent.west + span;
    extent.south = -90 + job.y * span; extent.north = extent.south + span;
    std::vector<double> heights(kParentGrid * kParentGrid);
    for (uint32_t y = 0; y < kParentGrid; ++y) for (uint32_t x = 0; x < kParentGrid; ++x) {
        const double u = double(x) / (kParentGrid - 1), v = double(y) / (kParentGrid - 1);
        const uint32_t east = u >= 0.5 ? 1 : 0, north = v >= 0.5 ? 1 : 0;
        heights[y * kParentGrid + x] = parent_sample(children[north * 2 + east]->mesh,
                                                       u * 2 - east, v * 2 - north);
    }
    // Mask rows start NORTH, unlike mesh/TMS rows. Values are water coverage
    // (0..255), already classified by the native WBM reader, not category IDs.
    std::vector<uint8_t> water(kMaskSize * kMaskSize);
    for (uint32_t y = 0; y < kMaskSize; ++y) for (uint32_t x = 0; x < kMaskSize; ++x) {
        uint32_t sum = 0;
        for (uint32_t dy = 0; dy < 2; ++dy) for (uint32_t dx = 0; dx < 2; ++dx) {
            const uint32_t mx = x * 2 + dx, my = y * 2 + dy;
            const uint32_t east = mx / kMaskSize, north = 1 - my / kMaskSize;
            sum += children[north * 2 + east]->mesh.water[
                (my % kMaskSize) * kMaskSize + mx % kMaskSize];
        }
        water[y * kMaskSize + x] = uint8_t((sum + 2) / 4);
    }
    const bool uniform = std::all_of(water.begin(), water.end(), [&](uint8_t v) { return v == water[0]; }) &&
                         (water[0] == 0 || water[0] == 255);
    std::vector<uint8_t> mesh, compressed, mask_compressed;
    encode_quantized_mesh(job, kParentGrid, extent, heights,
                          uniform ? std::vector<uint8_t>() : water, water[0] == 255, &mesh);
    if (!gzip_compress(mesh, &compressed) || (!uniform && !gzip_compress(water, &mask_compressed)))
        return fail("Could not encode the bounded parent payload.");
    const double low = *std::min_element(heights.begin(), heights.end());
    const double high = *std::max_element(heights.begin(), heights.end());
    ParentMesh decoded_parent;
    decoded_parent.grid = kParentGrid;
    decoded_parent.axis.resize(kParentGrid);
    decoded_parent.heights.resize(heights.size());
    for (uint32_t i = 0; i < kParentGrid; ++i)
        decoded_parent.axis[i] = double(32767ull * i / (kParentGrid - 1)) / 32767.0;
    for (size_t i = 0; i < heights.size(); ++i) {
        const double q = high > low ? std::lround(32767 * (heights[i] - low) / (high - low)) : 0;
        decoded_parent.heights[i] = double(float(low)) + (double(float(high)) - double(float(low))) * q / 32767;
    }
    double difference = 0, accuracy = 0;
    for (uint32_t q = 0; q < 4; ++q) {
        const double bound = parent_difference_bound(children[q]->mesh, decoded_parent, q % 2, q / 2);
        difference = std::max(difference, bound);
        if (inherited_complete) accuracy = std::max(accuracy, children[q]->tile->VERTICAL_ACCURACY_M());
    }
    // Outward numerical allowance; zero relief remains exactly zero.
    if (difference > 0) difference += std::max(1e-8, difference * 1e-12);
    if (inherited_complete) accuracy += difference;
    if (accuracy > 0) accuracy += std::max(1e-8, accuracy * 1e-12);
    char number[64]; std::snprintf(number, sizeof(number), "%.17g", difference);
    std::string query = "{\"method\":\"reduce_parent\",\"version\":1,\"children\":[";
    for (uint32_t q = 0; q < 4; ++q) {
        const DTT* t = children[q]->tile;
        if (q) query += ",";
        query += "{\"level\":" + std::to_string(t->LEVEL()) + ",\"x\":" + std::to_string(t->X()) +
            ",\"y\":" + std::to_string(t->Y()) + ",\"digest\":\"" + children[q]->digest + "\"}";
    }
    query += std::string("],\"heightBound\":\"") + kParentBound +
        "\",\"waterReduction\":\"coverage-2x2-round-half-up-v1\",\"meshDifferenceBoundM\":" + number +
        ",\"inheritedAccuracyComplete\":" + (inherited_complete ? "true}" : "false}");
    flatbuffers::FlatBufferBuilder b(compressed.size() + mask_compressed.size() + 4096);
    const auto provenance = parent_provenance(b, first->PROVENANCE(), retrieved, query);
    const auto water_provenance = first->WATER_MASK_PROVENANCE()
        ? parent_provenance(b, first->WATER_MASK_PROVENANCE(), water_retrieved, query)
        : flatbuffers::Offset<DTTProvenance>(0);
    const auto payload = [&](const std::vector<uint8_t>& bytes, const char* media) {
        const auto data = b.CreateVector(bytes);
        const auto digest = b.CreateString(sha256_multihash(bytes));
        const auto encoding = b.CreateString("gzip"), content_type = b.CreateString(media);
        DTTPayloadRefBuilder builder(b);
        builder.add_BYTES(data); builder.add_SIZE_BYTES(bytes.size()); builder.add_DIGEST(digest);
        builder.add_CONTENT_ENCODING(encoding); builder.add_MEDIA_TYPE(content_type);
        return builder.Finish();
    };
    const auto mesh_ref = payload(compressed, "application/vnd.quantized-mesh");
    const auto water_ref = uniform ? flatbuffers::Offset<DTTPayloadRef>(0)
                                  : payload(mask_compressed, "application/octet-stream");
    const auto tileset = b.CreateString(parent_string(first->TILESET_ID()));
    const auto tileset_name = first->TILESET_NAME() ? b.CreateString(first->TILESET_NAME()->str()) : 0;
    const auto format = b.CreateString("1.0"), datum = b.CreateString(parent_string(first->VERTICAL_DATUM_NAME()));
    const auto epoch = first->EPOCH() ? b.CreateString(first->EPOCH()->str()) : 0;
    const auto etag = b.CreateString("\"" + sha256_multihash(compressed) + "\"");
    const auto remarks = b.CreateString(
        "Native parent reduction of four recorded siblings; heights retain their stated vertical datum. "
        "Vertical accuracy, when available, is an inherited source-post bound plus a conservative "
        "decoded child-cell/parent-cell envelope bound, not a new source-post measurement. "
        "Water values are rounded 2x2 coverage reductions of recorded child masks; missing children are refused.");
    DTTBuilder builder(b);
    builder.add_TILESET_ID(tileset); builder.add_TILESET_NAME(tileset_name);
    builder.add_TILING_SCHEME(dttTilingScheme_GEOGRAPHIC_WGS84);
    builder.add_LEVEL(job.level); builder.add_X(job.x); builder.add_Y(job.y);
    builder.add_WEST_DEG(extent.west); builder.add_SOUTH_DEG(extent.south);
    builder.add_EAST_DEG(extent.east); builder.add_NORTH_DEG(extent.north);
    builder.add_MIN_HEIGHT_M(low); builder.add_MAX_HEIGHT_M(high);
    builder.add_PAYLOAD_FORMAT(dttPayloadFormat_QUANTIZED_MESH); builder.add_PAYLOAD_FORMAT_VERSION(format);
    builder.add_PAYLOAD(mesh_ref); builder.add_POST_SPACING_M(span / (kParentGrid - 1) * kPi / 180 * 6371008.8);
    builder.add_SOURCE_POST_SPACING_M(source_spacing); builder.add_VERTICAL_DATUM(first->VERTICAL_DATUM());
    builder.add_VERTICAL_DATUM_NAME(datum);
    if (inherited_complete) { builder.add_VERTICAL_ACCURACY_M(accuracy); builder.add_ACCURACY_CONFIDENCE(1); }
    builder.add_DATA_COVERAGE_FRACTION(coverage);
    builder.add_WATER_MASK_KIND(uniform ? (water[0] ? dttWaterMask_UNIFORM_WATER : dttWaterMask_UNIFORM_LAND)
                                       : dttWaterMask_RASTER);
    if (!uniform) {
        builder.add_WATER_MASK(water_ref); builder.add_WATER_MASK_WIDTH(kMaskSize);
        builder.add_WATER_MASK_HEIGHT(kMaskSize);
    }
    builder.add_WATER_MASK_PROVENANCE(water_provenance); builder.add_CHILD_AVAILABILITY(15);
    builder.add_MAX_LEVEL(first->MAX_LEVEL()); builder.add_SOURCE_CLASS(first->SOURCE_CLASS());
    builder.add_PROVENANCE(provenance); builder.add_EPOCH(epoch); builder.add_ETAG(etag); builder.add_REMARKS(remarks);
    FinishDTTBuffer(b, builder.Finish());
    std::vector<uint8_t> stream;
    put_u32(&stream, b.GetSize());
    stream.insert(stream.end(), b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
    return push_dtt_stream("records", stream);
}

// ---------------------------------------------------------------------------
// tile — plan + DEM granule responses (+ optional water-body granule
// responses) -> a size-prefixed $DTT record stream + one report.
//
// AMORTIZED. The plan may address ONE tile (level/x/y) or a BLOCK of them
// (tiles[]). A block decodes its granule set ONCE, over the union extent, and
// emits every tile the set covers. The first cut re-decoded the whole granule
// per tile: 1839 ms/tile, of which about 97% was inflating the same bytes
// again. Decoding is per PLAN now, sampling is per tile, and the per-tile cost
// falls to the encode itself.
//
// The union extent is what bounds memory, so the CALLER sizes the block. A
// block whose union window would cross kDecodeByteBudget is refused by name
// (decode-budget-exceeded), never attempted.
// ---------------------------------------------------------------------------
int tile(void) {
    if (refuse_batched()) return 500;

    // ── THE PLAN: ONE $DTT HEADER RECORD PER TILE ADDRESS ───────────────────
    //
    // Typed contracts 1.0: the plan is a size-prefixed $DTT record stream, one HEADER record per address to build -
    // the record this node will emit, without its mesh (PAYLOAD present and empty, as the IDL requires): TILESET_ID,
    // TILING_SCHEME, LEVEL / X / Y, ROW_ORIGIN_NORTH, GRID_WIDTH (the plan's gridSize), MAX_LEVEL, CHILD_AVAILABILITY,
    // SOURCE_CLASS, VERTICAL_DATUM_NAME, PROVENANCE (the dataset contract every record is published under), and the
    // water-mask DIRECTIVE as WATER_MASK_KIND / WATER_MASK_WIDTH / WATER_MASK_HEIGHT / WATER_MASK_PROVENANCE (NONE: no
    // directive). The block's shared fields are read from the first header; every header must name the same tileset.
    // The encoder's own knobs (maxGridSize, minGridSize, measureAccuracy, skipOceanTiles) are not facts about a tile
    // and ride on the optional "options" port as a ModuleConfig (MCFG); absent, the defaults below.
    const int32_t plan_index = plugin_find_input_index("plan", 0);
    const plugin_input_frame_t* plan_frame =
        plan_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(plan_index)) : nullptr;
    if (!plan_frame || !plan_frame->payload || plan_frame->payload_length == 0) {
        plugin_set_error("missing-plan-frame", "tile requires the plan frame on port \"plan\".");
        return 400;
    }
    std::vector<const DTT*> headers;
    {
        const uint8_t* data = plan_frame->payload;
        const size_t length = plan_frame->payload_length;
        size_t at = 0;
        while (at < length) {
            if (length - at < 4) { at = length + 1; break; }
            const uint32_t size = static_cast<uint32_t>(data[at]) | (static_cast<uint32_t>(data[at + 1]) << 8) |
                                  (static_cast<uint32_t>(data[at + 2]) << 16) |
                                  (static_cast<uint32_t>(data[at + 3]) << 24);
            at += 4;
            if (size == 0) continue;  // alignment padding, as in every record stream
            if (size > length - at) { at = length + 1; break; }
            ::flatbuffers::Verifier verifier(data + at, size);
            if (!DTTBufferHasIdentifier(data + at) || !VerifyDTTBuffer(verifier)) { at = length + 1; break; }
            headers.push_back(GetDTT(data + at));
            at += size;
        }
        if (at != length) {
            plugin_set_error("invalid-plan-frame",
                             "the plan frame is not a size-prefixed stream of $DTT header records.");
            return 400;
        }
    }
    if (headers.empty()) {
        plugin_set_error("empty-tile-block", "the plan carries no $DTT header record, so no address to build.");
        return 400;
    }
    const DTT& head = *headers[0];
    BodyPlan body;
    if (const int refused = parse_body_plan(headers, &body)) return refused;

    // The encoder's options, as the config object the readers below were written against.
    std::string plan = "{}";
    {
        const int32_t options_index = plugin_find_input_index("options", 0);
        const plugin_input_frame_t* options =
            options_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(options_index)) : nullptr;
        if (options) {
            bool ok = false;
            plan = module_config_object(options->payload, options->payload_length, &ok);
            if (!ok) {
                plugin_set_error("invalid-options-frame", "the options frame is not a ModuleConfig (MCFG).");
                return 400;
            }
        }
    }

    const DatasetContract contract = contract_of(head.PROVENANCE());
    if (!contract.complete()) {
        plugin_set_error("incomplete-dataset-contract",
                         "DTTProvenance requires DATASET_ID, DATASET_EPOCH, RETRIEVED_AT and "
                         "LICENSE on every record. The plan's header records supply them verbatim and "
                         "they are never defaulted: a tile published under a guessed epoch is "
                         "comparable to the wrong bytes.");
        return 400;
    }

    const std::string tileset_id = head.TILESET_ID() ? head.TILESET_ID()->str() : std::string();
    if (tileset_id.empty()) {
        plugin_set_error("missing-tileset-id", "the plan's header records must state TILESET_ID.");
        return 400;
    }
    for (const DTT* h : headers) {
        if (!h->TILESET_ID() || h->TILESET_ID()->str() != tileset_id) {
            plugin_set_error("mixed-tileset-plan",
                             "every header record of one plan must name the same TILESET_ID.");
            return 400;
        }
    }
    // GRID_WIDTH 0 is an unstated gridSize: the encoder's default 65, as before.
    const uint32_t grid = head.GRID_WIDTH() == 0 ? 65u : head.GRID_WIDTH();
    const uint32_t max_level = head.MAX_LEVEL();
    if (grid < 2 || grid > 255) {
        plugin_set_error("bad-grid-size", "gridSize must lie in [2, 255].");
        return 400;
    }
    // ── THE DENSEST LATTICE THE PLAN ADMITS ────────────────────────────────
    //
    // The coordinator's ruling is that density adapts to relief INSIDE the
    // 32 KiB cap and that "where the cap cannot meet [the target] the tile
    // ships AT the cap". The cap is therefore what is supposed to stop the
    // climb — so the search has to be able to climb. A ladder whose top was
    // `gridSize` could only ever go COARSER than the plan, which makes the
    // plan's own number the limit and the cap decorative: on the regional run
    // that shipped 8.4 KB tiles (a quarter of the cap) that still missed the
    // target at z10 and z11.
    //
    // `maxGridSize` is the top of the ladder. It DEFAULTS TO gridSize, so a
    // caller that says nothing gets exactly the previous behaviour and no
    // build changes shape by surprise; a pyramid config that wants the cap to
    // be the limit says so. Bounded at 255 like gridSize, because the mask is
    // 256 cells and a mesh denser than its own mask buys nothing a client can
    // see.
    // Bounded at 511 rather than gridSize's 255: what actually limits the
    // climb is the 32 KiB cap, which is hard and is checked per candidate, and
    // a lattice this side of 511 costs a few MB of doubles against the 64 MiB
    // peak Janus bounds the decode at. A number is still needed so a config
    // typo cannot ask for an unbounded allocation.
    const double max_grid_raw = json_number(plan, "maxGridSize", grid);
    uint32_t sample_grid = max_grid_raw < grid ? grid : static_cast<uint32_t>(max_grid_raw);
    if (sample_grid > 511) sample_grid = 511;
    // A body's mesh joins its edges to an interior ring (tile_mesh.hpp), which
    // needs at least four posts a side on every candidate.
    if (body.active && sample_grid < 5) {
        plugin_set_error("bad-grid-size", "a body plan's maxGridSize (or gridSize) must be at least 5.");
        return 400;
    }
    // The self-measurement is on by default and can be turned off for a run that only wants bytes (options
    // measureAccuracy false, or 0); with it off the run ships the plan's gridSize.
    const bool measure_accuracy = json_bool(plan, "measureAccuracy",
                                            json_number(plan, "measureAccuracy", 1) != 0);

    // ── SOURCE_CLASS IS DATA, NOT A COMPILE-TIME CONSTANT ───────────────────
    //
    // It used to be hard-coded to SPACEBORNE_RADAR_INTERFEROMETRIC. Every other
    // provenance field the schema marks required — dataset id, epoch, licence,
    // attribution — is supplied by the plan, so an operator who repoints this
    // module at an optical-stereo or lidar dataset still published records
    // asserting radar interferometry, a production technique the module never
    // verifies and the config surface could not correct. The plan states it by
    // the enum's own name; an unstated class is UNSPECIFIED, which is what
    // ordinal 0 means, rather than a guess.
    const dttSourceClass source_class = head.SOURCE_CLASS();
    if (source_class < dttSourceClass_MIN || source_class > dttSourceClass_MAX) {
        plugin_set_error("unknown-source-class",
                         "SOURCE_CLASS must name a dttSourceClass member (e.g. "
                         "SPACEBORNE_RADAR_INTERFEROMETRIC); an unrecognised ordinal is refused "
                         "rather than published as a different production technique.");
        return 422;
    }
    const std::string source_class_name =
        source_class == dttSourceClass_UNSPECIFIED ? std::string() : std::string(EnumNamedttSourceClass(source_class));
    for (const DTT* h : headers) {
        if (h->ROW_ORIGIN_NORTH()) {
            plugin_set_error("unsupported-row-origin",
                             "this encoder addresses the GEOGRAPHIC_WGS84 pyramid with a TMS "
                             "(south) row origin only; ROW_ORIGIN_NORTH true is refused rather "
                             "than silently flipped.");
            return 400;
        }
        // UNSPECIFIED is an unstated scheme: the only one modelled, as before.
        if (body.active) continue;  // parse_body_plan checked every header's scheme
        if (h->TILING_SCHEME() != dttTilingScheme_GEOGRAPHIC_WGS84 && h->TILING_SCHEME() != dttTilingScheme_UNSPECIFIED) {
            plugin_set_error("unsupported-scheme", "only the GEOGRAPHIC_WGS84 two-root scheme is modelled.");
            return 400;
        }
    }
    // Ocean tiles are NOT STORED (Atlas): the tileset's availability index
    // stays exact, the store holds no tile whose every byte is sea level, and
    // the serving lane synthesizes such an address on demand. Off by default
    // so a single-tile plan still gets the record it asked for.
    const bool skip_ocean = !body.active && json_bool(plan, "skipOceanTiles", false);

    // ── the tile block: one address per header record ──────────────────────
    std::vector<TileJob> jobs;
    for (const DTT* h : headers) {
        TileJob job;
        job.level = h->LEVEL();
        job.x = h->X();
        job.y = h->Y();
        job.child_availability = h->CHILD_AVAILABILITY();
        jobs.push_back(job);
    }

    std::vector<TileExtent> extents(jobs.size());
    for (size_t i = 0; i < jobs.size(); i++) {
        if (!tile_extent(jobs[i], &extents[i])) {
            plugin_set_error("tile-address-out-of-range",
                             "an x/y address in this plan does not exist at its level of the "
                             "two-root geographic pyramid.");
            return 400;
        }
    }
    // The union extent every granule window must cover.
    TileExtent bbox = extents[0];
    for (const TileExtent& e : extents) {
        bbox.west = std::min(bbox.west, e.west);
        bbox.east = std::max(bbox.east, e.east);
        bbox.south = std::min(bbox.south, e.south);
        bbox.north = std::max(bbox.north, e.north);
    }

    // ── decode the granule set ONCE, windowed to the union extent ───────────
    DecodeBudget budget;
    std::vector<DemGrid> granules;
    BodyFill fill;
    BodyRasterPixels raster;
    if (!raster.configure(plan,body.shape.a) || (raster.active && !body.active)) {
        plugin_set_error("invalid-source-pixel-options",raster.error.c_str());return 422;
    }
    uint32_t responses = 0, absent_granules = 0;
    if (raster.active) {
        // All geometry and source byte selection is computed by this guest.
        for(const auto& job:jobs)for(int64_t j=-1;j<=sample_grid;j++) {
            double lat,lon;
            body_lattice_post(job.level,sample_grid,int64_t(job.y)*(sample_grid-1)+j,
                              int64_t(job.x)*(sample_grid-1),&lat,&lon);
            raster.require_lat(lat);
        }
        const auto requests=raster.requests();uint64_t source_bytes=0;
        for(const auto& r:requests)source_bytes+=r.second;
        if(source_bytes>32u*1024u*1024u) {plugin_set_error("source-pixel-budget","split this plan: required source rows exceed 32 MiB");return 413;}
        if(json_bool(plan,"sourcePixelRangesOnly",false)) {
            sdn::runtime::FlowNoticeT notice;notice.KIND=sdn::runtime::flowNoticeKind_Info;
            notice.SOURCE_NAME=tileset_id;notice.REASON="source-pixel-ranges";notice.COUNT=requests.size();
            for(const auto& r:requests)notice.ITEMS.push_back(std::to_string(r.first)+":"+std::to_string(r.second));
            ::flatbuffers::FlatBufferBuilder nb(4096);
            sdn::runtime::FinishFlowNoticeBuffer(nb,sdn::runtime::FlowNotice::Pack(nb,&notice));
            return plugin_push_output_ex("report","FlowNotice.fbs",sdn::runtime::FlowNoticeIdentifier(),
                PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"FlowNotice",0,0,nb.GetBufferPointer(),nb.GetSize())<0?500:0;
        }
        for(uint32_t i=0;i<kBodyDemFrames;i++) {auto f=http_input_at("dem",i);if(!f.present)break;raster.frames.push_back(std::move(f));}
        for(const auto& f:raster.frames)if(!raster.parse_frame(f)){plugin_set_error("source-pixel-ranges",raster.error.c_str());return 422;}
        if(!raster.prepare()){plugin_set_error("source-pixel-ranges",raster.error.c_str());return 422;}
        fill.raster=&raster;responses=raster.frames.size();
    } else if (body.active) {
        // A BODY'S PDS PRODUCT: the "dem" frames are, per file of the product,
        // its PDS3 label and then whole-line ranges of its image (pds_img.hpp),
        // in the order the planner asked for them. The window is the union
        // extent plus one post of the densest lattice, which the normals' halo
        // reads.
        std::vector<HttpFrame> frames;
        for (uint32_t ordinal = 0; ordinal < kBodyDemFrames; ordinal++) {
            HttpFrame f = http_input_at("dem", ordinal);
            if (!f.present) break;
            if (f.invalid) {
                plugin_set_error("invalid-response-frame", "a \"dem\" frame is not an HttpResponse (HRSP).");
                return 400;
            }
            if (f.status < 200 || f.status >= 300) {
                char message[320];
                std::snprintf(message, sizeof(message),
                              "a body product fetch answered HTTP %ld%s%s; a body has no ocean to read a 404 "
                              "as, so every response must succeed.",
                              f.status, f.error.empty() ? "" : " - ", f.error.substr(0, 96).c_str());
                plugin_set_error("upstream-status", message);
                return 502;
            }
            frames.push_back(std::move(f));
        }
        responses = static_cast<uint32_t>(frames.size());
        const auto is_label = [](const HttpFrame& f) { return f.body.rfind("PDS_VERSION_ID", 0) == 0; };
        std::map<size_t,std::shared_ptr<BodyInset>> tiff_headers;
        const std::string tiff_spec=json_string(plan,"bodyTiffLayouts","");
        for(size_t at=0;at<tiff_spec.size();) {
            const size_t eq=tiff_spec.find('=',at),end=tiff_spec.find(';',at);
            if(eq==std::string::npos){plugin_set_error("invalid-tiff-headers","malformed TIFF header map");return 422;}
            const size_t stop=end==std::string::npos?tiff_spec.size():end;
            const size_t index=static_cast<size_t>(std::strtoul(tiff_spec.substr(at,eq-at).c_str(),nullptr,10));
            auto in=std::make_shared<BodyInset>();
            if(index>=frames.size()||!in->parse(tiff_spec.substr(eq+1,stop-eq-1))){plugin_set_error("inset-layout-invalid","invalid arithmetic TIFF layout");return 422;}
            tiff_headers[index]=in;at=stop+1;
        }
        const auto is_header=[&](size_t i){return i<frames.size()&&(is_label(frames[i])||tiff_headers.count(i));};
        if (frames.size() < 2 || !is_header(0)) {
            plugin_set_error("missing-dem-frame",
                             "a body plan needs the product's PDS3 label on \"dem\" frame 0 and at least one "
                             "whole-line range of its image after it.");
            return 400;
        }
        if (http_input_at("water", 0).present) {
            plugin_set_error("unexpected-water-frame", "a body plan carries no water mask; no \"water\" frame is read.");
            return 400;
        }
        std::vector<PdsFile> files, fill_files, backing_files, datum_files;
        std::vector<BodyInsetFile> tiffs,fill_tiffs,backing_tiffs,datum_tiffs,mask_tiffs;
        const size_t mask_frame=static_cast<size_t>(std::max(0.0,json_number(plan,"bodyMaskFrame",0)));
        const size_t backing_frame = static_cast<size_t>(std::max(0.0, json_number(plan, "bodyBackingFrame", 0)));
        const double datum_frame_number = json_number(plan, "bodyDatumFrame", 0);
        const size_t datum_frame = static_cast<size_t>(std::max(0.0, datum_frame_number));
        fill.primary_datum = json_number(plan, "bodyPrimaryDatum", 0) != 0;
        fill.fill_datum = json_number(plan, "bodyFillDatum", 0) != 0;
        if ((fill.primary_datum || fill.fill_datum) &&
            (datum_frame_number != datum_frame || datum_frame < 1 || datum_frame >= frames.size() || !is_label(frames[datum_frame]))) {
            plugin_set_error("invalid-datum-options", "areoid heights need a separate MEGA label/range group"); return 422;
        }
        const double fill_frame_number = json_number(plan, "bodyFillFrame", 0);
        const size_t fill_frame = static_cast<size_t>(std::max(0.0, fill_frame_number));
        fill.active = fill_frame != 0;
        if (fill.active) {
            const double posts = json_number(plan, "featherPosts", 0);
            const double spacing = json_number(plan, "fillSpacingM", 0);
            fill.fill_edges = json_number(plan, "bodyFillEdges", 1) != 0;
            fill.lat_min = json_number(plan, "bodyLatMin", -90);
            fill.lat_max = json_number(plan, "bodyLatMax", 90);
            if (fill_frame_number != fill_frame || fill_frame < 1 || fill_frame >= frames.size() ||
                !is_header(fill_frame) || posts < 1 || posts > 64 || posts != std::floor(posts) ||
                !(spacing > 0) || !std::isfinite(spacing) || fill.lat_min < -90 || fill.lat_max > 90 ||
                !(fill.lat_min < fill.lat_max) || json_string(plan, "bodyFillProduct", "").empty()) {
                plugin_set_error("invalid-fill-options", "fill needs a separate label/range group, band, product and 1..64 posts.");
                return 422;
            }
            fill.band_m = posts * spacing;
            fill.radius_m = body.shape.a;
        }
        std::string error;
        for (size_t i = 0; i < frames.size(); i++) {
            const bool is_mask = mask_frame && i >= mask_frame;
            const bool is_datum = !is_mask && datum_frame && i >= datum_frame;
            const bool is_backing = !is_mask && !is_datum && backing_frame && i >= backing_frame;
            const bool is_fill = !is_mask && !is_datum && !is_backing && fill.active && i >= fill_frame;
            auto& group = is_datum ? datum_files : is_backing ? backing_files : is_fill ? fill_files : files;
            auto& tif_group=is_mask?mask_tiffs:is_datum?datum_tiffs:is_backing?backing_tiffs:is_fill?fill_tiffs:tiffs;
            if(tiff_headers.count(i))tif_group.push_back({tiff_headers[i],{}});
            if(!tif_group.empty()&&!is_label(frames[i])) {
                unsigned long long first=0,last=0,total=0;
                const auto& layout=*tif_group.back().inset;
                if(std::sscanf(frames[i].content_range.c_str(),"bytes %llu-%llu/%llu",&first,&last,&total)!=3||last<first||last-first+1!=frames[i].body.size()||total!=layout.bytes||first<layout.tiff.first_strip||
                   (first-layout.tiff.first_strip)%layout.tiff.row_bytes||frames[i].body.size()%layout.tiff.row_bytes||last>=layout.tiff.first_strip+layout.tiff.height*layout.tiff.row_bytes){
                    plugin_set_error("invalid-tiff-range","TIFF ranges need exact Content-Range");return 422;}
                tif_group.back().ranges.push_back({static_cast<uint64_t>(first),&frames[i].body});continue;
            }
            if (is_label(frames[i])) {
                PdsFile file;
                if (!parse_pds_label(frames[i].body, &file.label, &error)) {
                    plugin_set_error("pds-label-unsupported", error.c_str());
                    return 422;
                }
                const bool add_datum = !is_datum && (is_backing ? json_number(plan,"bodyBackingDatum",0)!=0 : is_fill ? fill.fill_datum : fill.primary_datum);
                if (file.label.areoid != add_datum ||
                    (!file.label.areoid && std::fabs(file.label.a_axis_m - body.shape.a) > 1e-6) ||
                    std::fabs(file.label.datum_m - body.shape.a) > 1e-6 ||
                    (is_datum && file.label.image_name != "MEGA90N000EB.IMG" && file.label.image_name != "mega90n000eb.img")) {
                    plugin_set_error("pds-reference-mismatch",
                                     "the product's sphere (A_AXIS_RADIUS, OFFSET) is not the plan's REFERENCE_RADII_M: "
                                     "its heights would be stated above the wrong surface.");
                    return 422;
                }
                group.push_back(std::move(file));
                continue;
            }
            if (group.empty()) { plugin_set_error("missing-dem-label", "range has no product label"); return 422; }
            PdsBand band;
            if (!pds_band_of(group.back().label, frames[i].content_range, frames[i].body, &band, &error)) {
                plugin_set_error("pds-range-unsupported", error.c_str());
                return 422;
            }
            group.back().bands.push_back(band);
        }
        for (const auto* group : {&files, &fill_files, &backing_files, &datum_files}) for (const PdsFile& f : *group) {
            if (f.bands.empty()) {
                plugin_set_error("missing-dem-frame", "a product label on \"dem\" is followed by no range of its image.");
                return 400;
            }
        }
        const double max_grid = json_number(plan, "maxGridSize", grid);
        const double densest = std::max<double>(grid, std::min(511.0, max_grid));
        uint32_t shallowest = jobs[0].level;
        for (const TileJob& j : jobs) shallowest = std::min(shallowest, j.level);
        const double halo = 180.0 / (std::ldexp(1.0, static_cast<int>(shallowest)) * (densest - 1.0));
        std::vector<TileExtent> boxes;
        for (const TileExtent& e : extents) {
            boxes.push_back(TileExtent{e.west - halo, e.east + halo, std::max(-90.0, e.south - halo),
                                       std::min(90.0, e.north + halo)});
        }
        if (!datum_files.empty()) {
            DemGrid d = decode_pds_files(datum_files, boxes, &budget);
            if (d.budget_refused) return 413;
            if (!d.ok) { plugin_set_error("pds-datum-gap", d.error.c_str()); return 422; }
            if (d.covers) fill.datum.push_back(std::move(d));
        }
        DemGrid g;
        if(!tiffs.empty()) {
            if(!decode_body_insets(tiffs,boxes,&budget,&granules,&error,mask_frame?0:fill.band_m)){plugin_set_error("inset-decode",error.c_str());return 422;}
            g.ok=true;
        } else {
            // A despiked or destriped product decodes the filters' radii more posts round the extent (the plan asks
            // for them): the destripe reads despiked posts, so the radii add.
            const double despike_m = json_number(plan, "bodyDespikeM", 0);
            const bool destripe = json_number(plan, "bodyDestripe", 0) > 0;
            const long despike_r = despike_m > 0 ? kBodyDespikeRadius : 0, destripe_r = destripe ? kBodyDestripeRows : 0;
            const double spacing = files[0].label.a_axis_m * kPolarPi / 180 / files[0].label.ppd;
            g = decode_pds_files(files, boxes, &budget, fill.band_m + (despike_r + destripe_r) * spacing);
            if (g.ok && g.covers && (despike_m > 0 || destripe) && g.proj == kProjLinear) {
                double west = 1e300, east = -1e300;
                for (const TileExtent& b : boxes) { west = std::min(west, b.west); east = std::max(east, b.east); }
                // Stored column k holds global column k + off_x, centred on origin_lon + (k + off_x) * scale_lon.
                const long c0 = static_cast<long>(std::floor((west - g.origin_lon) / g.scale_lon)) - g.off_x - 2;
                const long c1 = static_cast<long>(std::ceil((east - g.origin_lon) / g.scale_lon)) - g.off_x + 3;
                const long rx = destripe ? kBodyDestripeCols : 0;
                if (despike_m > 0) body_despike(&g.samples, g.width, g.height, c0 - rx, c1 + rx, despike_m, kNoData);
                // The destripe reads only posts the despike settled (its rows and columns clear of the window edge).
                const long W = static_cast<long>(g.width), H = static_cast<long>(g.height);
                if (destripe)
                    body_destripe(&g.samples, g.width, g.height, c0, c1, despike_r, H - despike_r,
                                  std::max(despike_r, c0 - rx), std::min(W - despike_r, c1 + rx), kNoData);
            }
        }
        if (g.budget_refused) return 413;
        if (!g.ok) {
            plugin_set_error("pds-band-gap", g.error.c_str());
            return 422;
        }
        if (fill.active) {
            const auto prepare_distance = [&](const DemGrid& g, BodyInvalidDistance* distance) {
            const size_t invalid_count = static_cast<size_t>(std::count(g.samples.begin(), g.samples.end(), kNoData));
            if (invalid_count) {
                const uint64_t edt_bytes = static_cast<uint64_t>(g.samples.size()) * sizeof(double) +
                    static_cast<uint64_t>(invalid_count) * sizeof(uint32_t) * 2 +
                    static_cast<uint64_t>(g.height) * (sizeof(std::vector<uint32_t>) + 2 * sizeof(double) + sizeof(uint32_t));
                if (edt_bytes > kDecodeByteBudget || !budget.admit(static_cast<size_t>(edt_bytes))) {
                    set_decode_budget_error(edt_bytes, budget.used);
                    return false;
                }
                distance->build(g.samples, g.width, g.height, g.off_x, g.off_y, kNoData);
            }
                return true;
            };
            if (!prepare_distance(g, &fill.invalid)) return 413;
            if(!tiffs.empty()) {
                std::vector<DemGrid> masks;
                if(mask_frame&&!decode_body_insets(mask_tiffs,boxes,&budget,&masks,&error,fill.band_m)){plugin_set_error("inset-mask-decode",error.c_str());return 422;}
                if(!fill.inset_mask.build(mask_frame?masks:granules,boxes,fill.band_m,&budget))return 413;
            }
            const double spacing = !fill_tiffs.empty()?fill_tiffs[0].inset->tiff.scale_x:
                fill_files[0].label.projection == "POLAR STEREOGRAPHIC" ? fill_files[0].label.map_scale_m :
                                   fill_files[0].label.datum_m * kPolarPi / 180 / fill_files[0].label.ppd;
            if (std::fabs(spacing - json_number(plan, "fillSpacingM", 0)) > 1e-9 * spacing) {
                plugin_set_error("fill-spacing-mismatch", "fillSpacingM disagrees with the fill product's label.");
                return 422;
            }
            DemGrid f;
            if(!fill_tiffs.empty()) {
                if(!decode_body_insets(fill_tiffs,boxes,&budget,&fill.grids,&error,json_number(plan,"bodyBackingPosts",0)*json_number(plan,"bodyBackingSpacingM",0))){plugin_set_error("inset-fill-decode",error.c_str());return 422;}
                f.ok=true;
            } else f=decode_pds_files(fill_files, boxes, &budget, fill.band_m, /*uncovered_nodata=*/true);
            if (f.budget_refused) return 413;
            if (!f.ok) { plugin_set_error("pds-fill-gap", f.error.c_str()); return 422; }
            if (backing_frame) {
                const double posts = json_number(plan, "bodyBackingPosts", 0);
                const double bs = json_number(plan, "bodyBackingSpacingM", 0);
                if (backing_files.empty() || posts < 1 || posts > 64 || posts != std::floor(posts) || !(bs > 0) ||
                    std::fabs(bs - backing_files[0].label.datum_m * kPolarPi / 180 / backing_files[0].label.ppd) > bs*1e-9) {
                    plugin_set_error("invalid-backing-options", "backing needs a label/range group and measured 1..64 post width"); return 422;
                }
                fill.backing = std::make_unique<BodyFill>();
                auto& b = *fill.backing;
                b.active = true; b.fill_edges = false; b.primary_datum = fill.fill_datum;
                b.fill_datum=json_number(plan,"bodyBackingDatum",0)!=0;
                b.datum_source = &fill.datum; b.radius_m = body.shape.a; b.band_m = posts * bs;
                if (!prepare_distance(f, &b.invalid)) return 413;
                if(!fill_tiffs.empty()&&!b.inset_mask.build(fill.grids,boxes,b.band_m,&budget))return 413;
                DemGrid bg = decode_pds_files(backing_files, boxes, &budget, fill.band_m + b.band_m);
                if (bg.budget_refused) return 413;
                if (!bg.ok) { plugin_set_error("pds-backing-gap", bg.error.c_str()); return 422; }
                if (bg.covers) b.grids.push_back(std::move(bg));
            }
            if (f.covers) fill.grids.push_back(std::move(f));
        }
        if (g.covers) granules.push_back(std::move(g));
    }
    if (!body.active && http_input_at("dem", 4).present) {
        plugin_set_error("batched-input-frames",
                         "an Earth plan's \"dem\" port admits four granules; the surplus frames are refused rather "
                         "than silently discarded.");
        return 500;
    }
    for (uint32_t ordinal = 0; ordinal < 4 && !body.active; ordinal++) {
        const HttpFrame f = http_input_at("dem", ordinal);
        if (!f.present) break;
        responses++;
        // 404 = the dataset publishes no granule here (open ocean). That is
        // DATA — sea level — not a failure.
        if (f.invalid) {
            plugin_set_error("invalid-response-frame", "a \"dem\" frame is not an HttpResponse (HRSP).");
            return 400;
        }
        if (f.status == 404) { absent_granules++; continue; }
        if (f.status < 200 || f.status >= 300) {
            char message[320];
            std::snprintf(message, sizeof(message),
                          "a DEM granule fetch answered HTTP %ld%s%s; a failed fetch and open "
                          "ocean are not the same observation, so this is refused rather "
                          "than encoded as sea level.",
                          f.status, f.error.empty() ? "" : " - ", f.error.substr(0, 96).c_str());
            plugin_set_error("upstream-status", message);
            return 502;
        }
        DemGrid g = decode_geotiff_window(f.body, bbox.west, bbox.east, bbox.south, bbox.north,
                                          false, &budget);
        if (g.budget_refused) return 413;
        if (!g.ok) {
            plugin_set_error("geotiff-undecodable", g.error.c_str());
            return 422;
        }
        if (g.covers) granules.push_back(std::move(g));
    }
    if (responses == 0) {
        plugin_set_error("missing-dem-frame",
                         "tile requires at least one granule response frame on port \"dem\".");
        return 400;
    }

    // The SOURCE raster's native post spacing, metres, read off the granule
    // set that was actually decoded rather than assumed. Latitude spacing is
    // the invariant one: this dataset widens its LONGITUDE spacing above 50
    // degrees, so an east-west figure would describe the latitude band and not
    // the dataset.
    double source_post_spacing = raster.active ? raster.spacing : 0.0;
    // HOW MANY SOURCE POSTS LIE ALONG ONE TILE EDGE, which is the number that
    // says whether `maxGridSize` resolves the dataset or smooths it. It no
    // longer decides what the ACCURACY figure means — that is measured at the
    // source posts themselves (see measure_mesh_accuracy) whatever the lattice
    // does — but it still decides what the density ladder is ABLE to offer, so
    // it is reported on every block frame and carried into every run report.
    // (At z11 with GLO-30's 1" posts a tile edge carries ~316 of them: a
    // maxGridSize of 217 under-resolves by 1.5x, 361 covers it.)
    double source_posts_per_tile_edge = 0.0;
    for (const DemGrid& g : granules) {
        if (g.proj == kProjPolarStereo) {
            source_post_spacing = g.ps_scale_m;
            source_posts_per_tile_edge =
                (180.0 / std::pow(2.0, static_cast<double>(jobs[0].level))) * (kPi / 180.0) * body.shape.a / g.ps_scale_m;
            break;
        }
        if (g.scale_lat > 0) {
            source_post_spacing = g.scale_lat * (kPi / 180.0) * (body.active ? body.shape.a : 6371008.8);
            source_posts_per_tile_edge = (180.0 / std::pow(2.0, static_cast<double>(jobs[0].level))) /
                                         g.scale_lat;
            break;
        }
    }

    // ── the water-body granule set, same lane, same window ──────────────────
    std::vector<DemGrid> water_granules;
    uint32_t water_responses = 0, water_absent = 0;
    for (uint32_t ordinal = 0; ordinal < 4; ordinal++) {
        const HttpFrame f = http_input_at("water", ordinal);
        if (!f.present) break;
        water_responses++;
        if (f.invalid) {
            plugin_set_error("invalid-response-frame", "a \"water\" frame is not an HttpResponse (HRSP).");
            return 400;
        }
        if (f.status == 404) { water_absent++; continue; }
        if (f.status < 200 || f.status >= 300) {
            char message[336];
            std::snprintf(message, sizeof(message),
                          "a water-body granule fetch answered HTTP %ld%s%s; the mask decides "
                          "which of this tile renders as reflective ocean, so a failed fetch "
                          "is refused rather than defaulted to land.",
                          f.status, f.error.empty() ? "" : " - ", f.error.substr(0, 96).c_str());
            plugin_set_error("upstream-status", message);
            return 502;
        }
        DemGrid w = decode_geotiff_window(f.body, bbox.west, bbox.east, bbox.south, bbox.north,
                                          true, &budget);
        if (w.budget_refused) return 413;
        if (!w.ok) {
            plugin_set_error("water-granule-undecodable", w.error.c_str());
            return 422;
        }
        if (w.covers) water_granules.push_back(std::move(w));
    }

    // ── the water-mask DIRECTIVE (Janus (e): kind + geometry + lineage, never
    //    a base64 raster riding inside a JSON control frame) ─────────────────
    // The directive is the header's WATER_MASK_KIND (NONE: none given), its geometry WATER_MASK_WIDTH /
    // WATER_MASK_HEIGHT (0: unstated, the 256x256 this encoder cuts) and its lineage WATER_MASK_PROVENANCE.
    const bool has_directive = head.WATER_MASK_KIND() != dttWaterMask_NONE;
    if (has_directive && head.WATER_MASK_KIND() != dttWaterMask_UNIFORM_LAND &&
        head.WATER_MASK_KIND() != dttWaterMask_UNIFORM_WATER && head.WATER_MASK_KIND() != dttWaterMask_RASTER) {
        plugin_set_error("bad-water-mask-kind",
                         "WATER_MASK_KIND must be UNIFORM_LAND, UNIFORM_WATER or RASTER.");
        return 422;
    }
    const std::string directive_kind =
        has_directive ? std::string(EnumNamedttWaterMask(head.WATER_MASK_KIND())) : std::string();
    if (has_directive) {
        const uint32_t declared_w = head.WATER_MASK_WIDTH() == 0 ? kMaskSize : head.WATER_MASK_WIDTH();
        const uint32_t declared_h = head.WATER_MASK_HEIGHT() == 0 ? kMaskSize : head.WATER_MASK_HEIGHT();
        if (declared_w != kMaskSize || declared_h != kMaskSize) {
            plugin_set_error("water-mask-size-mismatch",
                             "this encoder cuts 256x256 water-mask rasters at every level "
                             "(the shared-edge identity between adjacent tiles depends on it); "
                             "a directive declaring another geometry is refused rather than "
                             "rendered as coastline at the wrong scale.");
            return 422;
        }
    }
    const DatasetContract water_contract = contract_of(head.WATER_MASK_PROVENANCE());

    // ── encode every tile in the block ──────────────────────────────────────
    std::vector<uint8_t> stream;
    std::vector<std::string> tile_items;
    uint32_t emitted = 0, skipped_ocean_count = 0, skipped_ocean_from_source_count = 0;
    // Block-wide totals for the two numbers a run must not be able to hide: a
    // mask post inferred from an absent granule, and one an elevation granule
    // covers but no water granule classifies.
    uint64_t block_mask_from_absence = 0, block_mask_unclassified = 0;
    uint64_t block_at_ceiling = 0, block_band_bridged = 0, block_edge_clamped = 0;
    double block_worst_accuracy_m = 0;
    TileStats first{};

    for (size_t t = 0; t < jobs.size(); t++) {
        const TileJob& job = jobs[t];
        const TileExtent& ext = extents[t];
        TileStats stats;

        // ── sample the FINEST post lattice the plan allows ──────────────────
        //
        // Sampled ONCE, at gridSize, and every coarser candidate the density
        // search below considers is an exact SUBSET of these posts. At level z
        // an N-post lattice puts post j at -90 + (y*(N-1)+j) * 180/(2^z*(N-1)),
        // so post j of an M-post candidate whose (M-1) divides (N-1) is post
        // j*(N-1)/(M-1) here — EXACTLY, in doubles, because the two
        // expressions differ only by a factor that cancels. That is what makes
        // the search cheap (one pass over the source per tile rather than one
        // per candidate) and what keeps every candidate on the SAME global
        // lattice, so two adjacent tiles that settle on different densities
        // still agree on the posts they share.
        BodyFillStats fill_stats;
        const uint32_t n_verts = sample_grid * sample_grid;
        std::vector<double> heights(n_verts, 0.0);
        std::vector<double> lats(n_verts), lons(n_verts);
        // Per-post provenance, kept so the CHOSEN candidate can report the
        // coverage of ITS OWN posts. dataCoverageFraction is read back against
        // the mesh's vertex count, so a fraction measured over a denser
        // lattice than the one that shipped is a number about a mesh nobody
        // has.
        std::vector<uint8_t> post_absent(n_verts, 0), post_nodata(n_verts, 0),
            post_clamped(n_verts, 0), post_bridged(n_verts, 0);
        std::vector<uint8_t> source_mask(n_verts, 0);
        for (uint32_t j = 0; j < sample_grid; j++) {  // j = 0 at the SOUTH edge
            const double lat = lattice_lat(job.level, job.y, j, sample_grid);
            for (uint32_t i = 0; i < sample_grid; i++) {
                const double lon = lattice_lon(job.level, job.x, i, sample_grid);
                const uint32_t v = j * sample_grid + i;
                lats[v] = lat;
                lons[v] = lon;
                double h = 0.0;
                bool nodata = false;
                bool clamped = false;
                bool bridged = false;
                const bool covered = body.active
                                         ? fill.sample(granules, lon, lat, &h, &nodata, &clamped, &fill_stats)
                                         : sample_dem(granules, lon, lat, &h, &nodata, &clamped, &bridged);
                if ((fill.active || fill.primary_datum) && (!covered || nodata)) {
                    plugin_set_error("fill-nodata", "neither primary nor fill supplies a required height-field post.");
                    return 422;
                }
                post_clamped[v] = clamped ? 1 : 0;
                post_bridged[v] = bridged ? 1 : 0;
                if (!covered) {
                    post_absent[v] = 1;
                    h = 0.0;  // absent granule: the dataset states sea level nowhere, so 0
                              // is used and COUNTED, never presented as a measurement
                } else if (nodata) {
                    post_nodata[v] = 1;
                    h = 0.0;
                }
                if(raster.active) {
                    if(!raster.sample(lon,lat,&h,&source_mask[v])){plugin_set_error("source-pixel-gap","required source post missing");return 422;}
                    post_nodata[v]=source_mask[v]==0?1:0;
                }
                heights[v] = h;
            }
        }
        std::string fill_items;
        if (body.active) {
            fill_items = " filled_posts=" + std::to_string(fill_stats.filled_posts) +
                         " feathered_posts=" + std::to_string(fill_stats.feathered_posts) +
                         " max_feather_dev_m=" + fmt_double(fill_stats.max_feather_dev_m);
            if (json_number(plan, "fillDiagnostics", 0) != 0) {
                for (int edge = 0; edge < 4; edge++) {
                    std::vector<uint8_t> bytes;
                    for (uint32_t k = 0; k < sample_grid; k++) {
                        const size_t v = edge == 0 ? k : edge == 1 ? k * sample_grid + sample_grid - 1 :
                                         edge == 2 ? (sample_grid - 1) * sample_grid + k : k * sample_grid;
                        const uint8_t* raw = reinterpret_cast<const uint8_t*>(&heights[v]);
                        bytes.insert(bytes.end(), raw, raw + sizeof(double));
                    }
                    fill_items += " edgeHeight" + std::to_string(edge) + "=" + sha256_multihash(bytes);
                }
            }
        }
        double min_h = heights[0], max_h = heights[0];
        for (const double h : heights) {
            min_h = std::min(min_h, h);
            max_h = std::max(max_h, h);
        }
        uint64_t absent_posts = 0, nodata_posts = 0;
        for (const uint8_t a : post_absent) absent_posts += a;
        for (const uint8_t nd : post_nodata) nodata_posts += nd;
        // Provisional, over the finest lattice: an ocean tile is skipped
        // before the density search runs and still has to report itself.
        stats.min_h = min_h;
        stats.max_h = max_h;
        stats.coverage = 1.0 - static_cast<double>(absent_posts + nodata_posts) / n_verts;

        // ── a body's normals, over the lattice just sampled plus its halo ────
        // (oct_normals.hpp). The ring one post beyond the tile is sampled at the
        // global lattice posts body_lattice_post folds back onto the body.
        std::vector<uint8_t> lattice_normals;
        if (body.active) {
            const uint32_t span = sample_grid + 2;
            std::vector<Vec3> halo(static_cast<size_t>(span) * span);
            const int64_t row0 = static_cast<int64_t>(job.y) * (sample_grid - 1);
            const int64_t col0 = static_cast<int64_t>(job.x) * (sample_grid - 1);
            for (int64_t j = -1; j <= static_cast<int64_t>(sample_grid); j++) {
                for (int64_t i = -1; i <= static_cast<int64_t>(sample_grid); i++) {
                    const size_t at = static_cast<size_t>(j + 1) * span + static_cast<size_t>(i + 1);
                    const bool inside = j >= 0 && i >= 0 && j < static_cast<int64_t>(sample_grid) &&
                                        i < static_cast<int64_t>(sample_grid);
                    if (inside) {
                        const size_t v = static_cast<size_t>(j) * sample_grid + static_cast<size_t>(i);
                        halo[at] = geodetic_to_ecef(body.shape, lats[v], lons[v], heights[v]);
                        continue;
                    }
                    double plat = 0, plon = 0, h = 0;
                    bool nd = false, cl = false;
                    body_lattice_post(job.level, sample_grid, row0 + j, col0 + i, &plat, &plon);
                    if (!fill.sample(granules, plon, plat, &h, &nd, &cl) || nd) {
                        if (fill.active || fill.primary_datum) {
                            plugin_set_error("fill-nodata", "neither primary nor fill supplies a normals halo post.");
                            return 422;
                        }
                        h = 0.0;
                    }
                    halo[at] = geodetic_to_ecef(body.shape, plat, plon, h);
                }
            }
            lattice_oct_normals(halo, sample_grid, &lattice_normals);
        }

        // ── the water mask ──────────────────────────────────────────────────
        std::string water_kind;
        std::vector<uint8_t> water_raster;
        if (body.active) {
            water_kind = "NONE";  // a body carries no water mask at all
        } else if (!water_granules.empty()) {
            classify_water_mask(job, water_granules, granules, &water_raster,
                                &stats.mask_from_absence, &stats.mask_unclassified);
            bool uniform = true;
            const uint8_t first_byte = water_raster[0];
            for (const uint8_t b : water_raster) {
                if (b != first_byte) { uniform = false; break; }
            }
            if (uniform) {
                water_kind = first_byte == 0xff ? "UNIFORM_WATER" : "UNIFORM_LAND";
                water_raster.clear();
            } else {
                water_kind = "RASTER";
            }
        } else if (!directive_kind.empty()) {
            water_kind = directive_kind;
            if (water_kind == "RASTER") {
                plugin_set_error("missing-water-granule",
                                 "the plan directs a RASTER water mask but no water-body "
                                 "granule reached port \"water\"; a mask is classified from "
                                 "source bytes, never fabricated from the directive.");
                return 400;
            }
        } else {
            // No water granule reached this invoke at all, so the tile's OWN
            // elevation coverage is the only evidence left — and it is read
            // per tile, not per block: a tile no elevation granule covers
            // anywhere is open ocean by the dataset's publication pattern,
            // while a tile that has elevation is land as far as this invoke
            // can tell.
            water_kind = absent_posts == n_verts ? "UNIFORM_WATER" : "UNIFORM_LAND";
        }
        stats.water_kind = water_kind;

        // An all-ocean tile is DATA the client can synthesize exactly; storing
        // it would inflate the pyramid with identical flat records.
        //
        // COVERAGE IS NOT PART OF THE TEST, and an earlier cut that required
        // coverage == 0 stored every ocean tile it met. The source dataset
        // publishes real granules over most sea — full of measured 0.0 metres —
        // so a tile in the middle of a bay has coverage 1.0 and is ocean all
        // the same. What makes a tile ocean is what it SAYS: flat at exactly
        // sea level, and water everywhere.
        // THE TEST IS APPLIED TWICE, and it has to be. Here it is over the
        // FULL sampled lattice (plus the SOURCE arm below, which catches the
        // all-water tile whose boundary grazes a coast), which is what makes
        // the skip cheap — a tile that is plainly open ocean never reaches the
        // density search at all.
        // But density adapts, and a tile with a metre of relief across its
        // finest lattice can settle on a candidate whose posts are every one of
        // them exactly 0: what SHIPS is then indistinguishable from a
        // synthesized ocean tile while the full-lattice test said it was not
        // ocean. So the same test runs again against the CHOSEN heights, after
        // the search, and skips there too. (The regional run stored exactly one
        // such tile before this: 11/2164/1519, in the open Ligurian Sea.)
        const auto record_ocean_skip = [&]() {
            stats.skipped_ocean = true;
            skipped_ocean_count++;
            if (stats.ocean_from_source) skipped_ocean_from_source_count++;
            if (t == 0) first = stats;
            block_mask_from_absence += stats.mask_from_absence;
            block_mask_unclassified += stats.mask_unclassified;
            tile_items.push_back(std::to_string(job.level) + "/" + std::to_string(job.x) + "/" +
                                 std::to_string(job.y) + " skippedOcean=true oceanFromSource=" +
                                 (stats.ocean_from_source ? "true" : "false") +
                                 " maskFromAbsenceSamples=" + std::to_string(stats.mask_from_absence) +
                                 " maskUnclassifiedSamples=" + std::to_string(stats.mask_unclassified));
        };
        const bool lattice_says_ocean =
            min_h == 0.0 && max_h == 0.0 && water_kind == "UNIFORM_WATER";
        // THE SOURCE ARM. Only an all-water tile the lattice did NOT already
        // call ocean can reach it, so the extra walk costs nothing on the two
        // common cases (land, and open ocean the lattice settles), and the
        // walk it does is over posts already resident in the decode window.
        if (skip_ocean && !lattice_says_ocean && water_kind == "UNIFORM_WATER") {
            const SourceExtremes src = measure_source_extremes(granules, ext);
            stats.ocean_from_source =
                src.posts > 0 && src.nodata == 0 && src.min_h == 0.0 && src.max_h == 0.0;
        }
        if (skip_ocean && (lattice_says_ocean || stats.ocean_from_source)) {
            record_ocean_skip();
            continue;
        }

        // ── DENSITY ADAPTS TO RELIEF, INSIDE A CAP THAT NEVER MOVES ─────────
        //
        // Coordinator reconciliation 2026-08-27 (a): the mesh is as dense as
        // the tile's own relief requires and no denser, the 32 KiB gzipped
        // ceiling is HARD, and a tile the ceiling cannot make accurate enough
        // ships AT the ceiling STATING what it achieved rather than being
        // refused or silently shipped coarse.
        //
        // A fixed gridSize was wrong in both directions at once: an ocean-flat
        // or gently rolling tile paid 65x65 posts to describe a plane, while a
        // z13 alpine tile could not be made accurate at all because the only
        // lever — a coarser plan-wide gridSize — applied to every tile in the
        // block.
        //
        // The search runs COARSEST FIRST and stops at the first candidate that
        // meets the target, so the common case (most of the planet is not the
        // Alps) is CHEAPER than the fixed grid it replaces, not dearer. Every
        // candidate is a subset of the one lattice sampled above, so the
        // source is read once per tile however many candidates are tried.
        //
        // TWO ADJACENT TILES MAY SETTLE ON DIFFERENT DENSITIES. On Earth the
        // posts both candidates keep come from the same global lattice and agree
        // exactly; where the two strides do not nest (65 and 97 on a 193-post
        // lattice) the edges are two different polylines, and the skirts a
        // client builds from the edge indices close that gap. A body's tiles do
        // not rely on that: each EDGE is chosen from the heights along it alone
        // (matched_edge_posts, tile_mesh.hpp), the same choice in both tiles
        // that share it, so neighbours carry the same edge posts whatever
        // interior density each settles on.
        // `levelZeroErrorM` (options) states the level-0 target for a dataset
        // whose body or resolution the Earth figure does not fit; absent, the
        // Earth expression exactly as it was.
        const bool rms_metric = json_string(plan, "errorMetric", "max") == "rms";
        std::string level_zero_raw;
        const double error_target_m =
            json_raw_value(plan, "levelZeroErrorM", &level_zero_raw)
                ? json_number(plan, "levelZeroErrorM", 0) / std::ldexp(1.0, static_cast<int>(job.level))
                : 2.0 * 77067.0 / std::ldexp(1.0, static_cast<int>(job.level));

        // The candidate ladder: gridSize and every halving of its interval
        // down to the FLOOR, ascending. A gridSize whose interval does not
        // halve (an operator's odd number) yields a one-element ladder, i.e.
        // exactly the fixed-grid behaviour this replaces.
        //
        // `minGridSize` is that floor, and it exists because "as coarse as the
        // measurement allows" is not always what a caller wants: a geometry
        // test asserting where a post LANDS, a deterministic A/B, and a
        // regional inset built to a guaranteed density all need to name the
        // lattice rather than have it inferred. It floors the search only —
        // the 32 KiB ceiling still wins over it, because the ceiling is hard
        // and a floor that could breach it would not be a floor, it would be a
        // second ceiling arguing with the first.
        const double floor_raw = json_number(plan, "minGridSize", 5);
        const uint32_t grid_floor = floor_raw < 5
                                        ? 5u
                                        : (floor_raw > sample_grid ? sample_grid
                                                                   : static_cast<uint32_t>(floor_raw));
        // THE LADDER IS EVERY DIVISOR OF THE SAMPLED LATTICE'S INTERVAL COUNT,
        // ascending — not just its halvings.
        //
        // The subset property is what the whole scheme rests on: candidate M is
        // a subset of the sampled lattice exactly when (M-1) divides
        // (sample_grid-1), and every divisor gives one. Halving only gives the
        // powers of two, and that granularity is not free — measured on the
        // regional run, a tile that needs a little more than 65 posts jumps
        // straight to 129, which is FOUR times the vertices and lands at
        // ~32 KB against ~8 KB. The p99 byte bound and the at-ceiling share
        // bound then pull against each other for no reason but the step size.
        // With 192 intervals the ladder offers 65, 97, 129, 193 and a tile can
        // buy the accuracy it needs rather than the next power of two.
        std::vector<uint32_t> ladder;
        const uint32_t spans = sample_grid - 1;
        for (uint32_t d = 1; d <= spans; d++) {
            if (spans % d != 0) continue;
            const uint32_t cand = d + 1;
            if (cand < grid_floor) continue;
            ladder.push_back(cand);
        }
        if (ladder.empty()) ladder.push_back(sample_grid);

        // A body's four edges (south, east, north, west), each from its own
        // lattice heights against the tile's own target and metric.
        std::array<std::vector<uint32_t>, 4> body_edges;
        if (body.active) {
            const uint32_t n = sample_grid;
            body_edges[0] = matched_edge_posts(heights, n, 0, 1, ladder, error_target_m, rms_metric);
            body_edges[1] = matched_edge_posts(heights, n, n - 1, n, ladder, error_target_m, rms_metric);
            body_edges[2] = matched_edge_posts(heights, n, static_cast<size_t>(n - 1) * n, 1, ladder, error_target_m,
                                               rms_metric);
            body_edges[3] = matched_edge_posts(heights, n, 0, n, ladder, error_target_m, rms_metric);
        }

        uint32_t chosen_grid = 0;
        std::vector<double> chosen_heights;  // per vertex of chosen_shape (a body) or the cand grid (Earth)
        TileMesh chosen_shape;               // a body's chosen mesh
        std::vector<uint8_t> mesh;
        std::vector<uint8_t> payload_bytes;
        bool gzipped = false;
        bool at_ceiling = false;  // shipped at the cap without meeting the target
        bool cap_stopped = false;  // the 32 KiB ceiling, not the ladder's top, ended the climb
        for (size_t c = 0; c < ladder.size(); c++) {
            const uint32_t cand = ladder[c];
            const uint32_t stride = (sample_grid - 1) / (cand - 1);
            std::vector<double> cand_heights(static_cast<size_t>(cand) * cand, 0.0);
            for (uint32_t j = 0; j < cand; j++) {
                for (uint32_t i = 0; i < cand; i++) {
                    cand_heights[static_cast<size_t>(j) * cand + i] =
                        heights[static_cast<size_t>(j * stride) * sample_grid + i * stride];
                }
            }
            std::vector<uint8_t> cand_mesh;
            TileMesh cand_shape;
            if (body.active) {
                cand_shape = edge_matched_mesh(sample_grid, cand, body_edges);
                cand_heights.resize(cand_shape.size());
                std::vector<uint8_t> cand_normals(cand_shape.size() * 2), cand_mask(cand_shape.size());
                for (size_t v = 0; v < cand_shape.size(); v++) {
                    const size_t from = static_cast<size_t>(cand_shape.row[v]) * sample_grid + cand_shape.col[v];
                    cand_heights[v] = heights[from];
                    cand_mask[v] = source_mask[from];
                    cand_normals[v * 2] = lattice_normals[from * 2];
                    cand_normals[v * 2 + 1] = lattice_normals[from * 2 + 1];
                }
                MeshBody mesh_body;
                mesh_body.shape = body.shape;
                mesh_body.oct_normals = &cand_normals;
                mesh_body.water_extension = false;
                if(raster.active)mesh_body.source_mask=&cand_mask;
                encode_mesh(job, cand_shape, cand_heights, water_raster, false, &cand_mesh, mesh_body);
            } else {
                encode_quantized_mesh(job, cand, ext, cand_heights, water_raster,
                                      water_kind == "UNIFORM_WATER", &cand_mesh);
            }
            std::vector<uint8_t> cand_payload;
            const bool cand_gzipped = gzip_compress(cand_mesh, &cand_payload);
            if (!cand_gzipped) cand_payload = cand_mesh;

            if (cand_payload.size() > kTileGzipCeilingBytes) {
                // Past the cap. Anything accepted so far is what ships, and it
                // ships as the densest mesh the ceiling admits.
                at_ceiling = chosen_grid != 0;
                cap_stopped = true;
                break;
            }
            chosen_grid = cand;
            chosen_heights.swap(cand_heights);
            chosen_shape = std::move(cand_shape);
            mesh.swap(cand_mesh);
            payload_bytes.swap(cand_payload);
            gzipped = cand_gzipped;

            if (!measure_accuracy) {
                // NO ERROR SIGNAL, NO COARSENING. With the measurement off
                // there is nothing that could justify shipping fewer posts
                // than the plan asked for, so the search does not choose — it
                // takes the plan's own gridSize, which is exactly the
                // fixed-density behaviour this replaced. (The first cut of
                // this loop broke here on the FIRST candidate, which is the
                // COARSEST one: it shipped 5x5 meshes for every tile whenever
                // the caller turned accuracy measurement off, while the
                // comment claimed the opposite.)
                // The plan's OWN gridSize, not the top of the ladder: with no
                // error signal the honest density is the one that was asked
                // for — resolved to the densest candidate at or below it, since
                // the ladder is not obliged to contain that exact number.
                const bool last_at_or_below_grid =
                    cand <= grid && (c + 1 == ladder.size() || ladder[c + 1] > grid);
                if (!last_at_or_below_grid) continue;
                at_ceiling = false;
                break;
            }
            // MEASURED AT THE SOURCE POSTS (coordinator resolution 1), not
            // against the encoder's own resample of them. `error_target_m` is
            // passed as the abort threshold: a candidate that has already
            // missed does not need its exact error, only the fact that it
            // missed, and the tile that ships is re-measured with the abort off
            // below.
            //
            // `errorMetric` "rms" (options) judges a candidate by its RMS
            // departure over the source posts instead of its worst one - a
            // walk that cannot stop early, so it is never aborted - for a
            // dataset whose acceptance is stated as RMS and a percentile (a
            // body's craters put a few posts hundreds of metres from any mesh
            // the 32 KiB ceiling admits). Absent, the worst, as before.
            const double abort_above = rms_metric ? 0.0 : error_target_m;
            const SourcePostProbe probe =
                body.active ? measure_body_mesh_accuracy(granules, job, chosen_shape, chosen_heights, cand, abort_above, nullptr,
                                               (fill.active || fill.primary_datum) ? &fill : nullptr)
                            : measure_mesh_accuracy(granules, job, cand, chosen_heights, measure_accuracy, abort_above);
            stats.vertical_accuracy_m = probe.worst;
            stats.accuracy_probes = probe.probes;
            const double judged =
                rms_metric ? (probe.probes ? std::sqrt(probe.sum_sq / static_cast<double>(probe.probes)) : 0.0) : probe.worst;
            if (probe.complete && judged <= error_target_m) { at_ceiling = false; break; }
            // Provisional: a denser candidate may still clear the target. If
            // none does, `at_ceiling` is the tile stating that it is as
            // accurate as it was ALLOWED to be — by the byte cap or by the
            // plan's own gridSize — and not as accurate as the target asks.
            at_ceiling = true;
        }

        // THE CEILING IS HARD. If not even the coarsest candidate fits under
        // it, nothing ships: it is the water mask, not the mesh, that can do
        // that, and a tile whose mask alone will not compress under the cap is
        // a plan defect a coarser grid cannot fix.
        if (chosen_grid == 0) {
            char message[320];
            std::snprintf(message, sizeof(message),
                          "tile %u/%u/%u will not encode under the %llu-byte per-tile "
                          "serving ceiling at any mesh density down to %u posts (the water "
                          "mask, not the mesh, dominates it). Refused at encode time: a "
                          "pyramid that stores it has already committed every client to the "
                          "transfer.",
                          job.level, job.x, job.y,
                          static_cast<unsigned long long>(kTileGzipCeilingBytes), ladder[0]);
            plugin_set_error("tile-size-ceiling-exceeded", message);
            return 413;
        }
        // THE NUMBER THE RECORD STATES IS ALWAYS A COMPLETE WALK. Every
        // candidate the ladder rejected was measured with the abort on, so the
        // last figure in `stats` may be the moment the walk gave up rather than
        // the tile's worst post. A tile that settled AT THE CAP is exactly that
        // case — it is the one whose stated accuracy a consumer most needs to
        // trust — so it is re-measured over every source post, once.
        if (measure_accuracy && at_ceiling && !body.active) {
            const SourcePostProbe settled =
                measure_mesh_accuracy(granules, job, chosen_grid, chosen_heights, true, 0.0);
            stats.vertical_accuracy_m = settled.worst;
            stats.accuracy_probes = settled.probes;
        }
        // A BODY'S TILE IS ALWAYS MEASURED BY A COMPLETE WALK, and states its RMS
        // and the histogram of its departures (whole metres) as well as the
        // worst, so a level's RMS and percentiles are exact sums over its tiles.
        std::vector<uint64_t> residual_histogram;
        double rms_m = 0.0;
        if (measure_accuracy && body.active) {
            residual_histogram.assign(kResidualHistogramBins, 0);
            const SourcePostProbe settled = measure_body_mesh_accuracy(granules, job, chosen_shape, chosen_heights,
                                                                       chosen_grid, 0.0, &residual_histogram, (fill.active || fill.primary_datum) ? &fill : nullptr);
            stats.vertical_accuracy_m = settled.worst;
            stats.accuracy_probes = settled.probes;
            rms_m = settled.probes ? std::sqrt(settled.sum_sq / static_cast<double>(settled.probes)) : 0.0;
        }
        stats.grid = chosen_grid;
        stats.error_target_m = error_target_m;
        stats.at_ceiling = at_ceiling;
        stats.mesh_bytes = mesh.size();
        stats.payload_bytes = payload_bytes.size();

        // Coverage, clamps and band bridges are reported over the posts that
        // ACTUALLY SHIPPED: the candidate's own stride, or a body mesh's vertices.
        {
            auto count_post = [&](size_t v) {
                stats.uncovered += post_absent[v];
                stats.nodata += post_nodata[v];
                stats.edge_clamped += post_clamped[v];
                stats.band_bridged += post_bridged[v];
            };
            double shipped_posts = 0;
            if (body.active) {
                for (size_t v = 0; v < chosen_shape.size(); v++)
                    count_post(static_cast<size_t>(chosen_shape.row[v]) * sample_grid + chosen_shape.col[v]);
                shipped_posts = static_cast<double>(chosen_shape.size());
            } else {
                const uint32_t stride = (sample_grid - 1) / (chosen_grid - 1);
                for (uint32_t j = 0; j < chosen_grid; j++) {
                    for (uint32_t i = 0; i < chosen_grid; i++)
                        count_post(static_cast<size_t>(j * stride) * sample_grid + i * stride);
                }
                shipped_posts = static_cast<double>(chosen_grid) * static_cast<double>(chosen_grid);
            }
            stats.coverage =
                1.0 - static_cast<double>(stats.nodata + stats.uncovered) / shipped_posts;
            double cmin = chosen_heights[0], cmax = chosen_heights[0];
            for (const double h : chosen_heights) {
                cmin = std::min(cmin, h);
                cmax = std::max(cmax, h);
            }
            stats.min_h = cmin;
            stats.max_h = cmax;
            min_h = cmin;
            max_h = cmax;
        }

        // The second application of the ocean test; see record_ocean_skip.
        if (skip_ocean && min_h == 0.0 && max_h == 0.0 && water_kind == "UNIFORM_WATER") {
            record_ocean_skip();
            continue;
        }

        if (body.active && !encode_edge_matched_planes(mesh, chosen_shape, chosen_grid, body_edges, &payload_bytes)) {
            plugin_set_error("lossless-topology-mismatch",
                             "body tile refused: edge-matched planes did not reconstruct the chosen quantized mesh byte for byte.");
            return 500;
        }
        // Digest, size and ETag describe the stored bytes, independently of the serving representation.
        const std::string digest = sha256_multihash(payload_bytes);
        stats.digest = digest;
        const std::string etag = "\"" + digest + "\"";

        // ── build the $DTT record ───────────────────────────────────────────
        flatbuffers::FlatBufferBuilder b(payload_bytes.size() + water_raster.size() + 2048);
        const auto provenance = build_provenance(b, contract);
        const auto f_water_provenance =
            water_contract.complete() && water_contract.license != contract.license
                ? build_provenance(b, water_contract)
                : flatbuffers::Offset<DTTProvenance>(0);
        const auto payload_media = b.CreateString("application/vnd.quantized-mesh");
        const auto payload_encoding = body.active ? b.CreateString(kEdgeMatchedPlanes) : (gzipped ? b.CreateString("gzip") : 0);
        const auto payload_digest = b.CreateString(digest);
        const auto payload_vec = b.CreateVector(payload_bytes.data(), payload_bytes.size());
        flatbuffers::Offset<DTTPayloadRef> payload;
        {
            DTTPayloadRefBuilder prb(b);
            prb.add_BYTES(payload_vec);
            prb.add_SIZE_BYTES(payload_bytes.size());
            prb.add_DIGEST(payload_digest);
            prb.add_MEDIA_TYPE(payload_media);
            if (payload_encoding.o) prb.add_CONTENT_ENCODING(payload_encoding);
            payload = prb.Finish();
        }
        flatbuffers::Offset<DTTPayloadRef> water_ref;
        if (water_kind == "RASTER") {
            // THE MASK IS STORED GZIPPED. It is 65,536 bytes of two distinct
            // values, so it deflates to a fraction of that — and the record
            // already carries the same bytes a second time inside the gzipped
            // mesh payload, so storing this copy raw made the mask, not the
            // terrain, the largest thing in a coastal tile. DTTPayloadRef
            // carries CONTENT_ENCODING for exactly this, and SIZE_BYTES and
            // DIGEST are stated over the STORED bytes, as they are for the
            // payload.
            std::vector<uint8_t> mask_bytes;
            const bool mask_gzipped = gzip_compress(water_raster, &mask_bytes);
            if (!mask_gzipped) mask_bytes = water_raster;
            const auto media = b.CreateString("application/octet-stream");
            const auto mask_encoding = mask_gzipped ? b.CreateString("gzip") : 0;
            const auto mask_digest = b.CreateString(sha256_multihash(mask_bytes));
            const auto vec = b.CreateVector(mask_bytes.data(), mask_bytes.size());
            DTTPayloadRefBuilder wrb(b);
            wrb.add_BYTES(vec);
            wrb.add_SIZE_BYTES(mask_bytes.size());
            wrb.add_DIGEST(mask_digest);
            wrb.add_MEDIA_TYPE(media);
            if (mask_encoding.o) wrb.add_CONTENT_ENCODING(mask_encoding);
            water_ref = wrb.Finish();
        }
        const auto f_tileset = b.CreateString(tileset_id);
        const auto f_version = b.CreateString("1.0");
        const auto f_datum_name =
            b.CreateString(head.VERTICAL_DATUM_NAME() && head.VERTICAL_DATUM_NAME()->size()
                               ? head.VERTICAL_DATUM_NAME()->str()
                               : std::string("EGM2008"));
        const auto f_etag = b.CreateString(etag);
        const auto f_remarks = b.CreateString(body.active ? body.remarks : std::string(kGeoidRemark));
        // The SHIPPED lattice's spacing, not the plan's. With density adapting
        // per tile these differ, and a record that states the plan's number
        // describes a mesh nobody has.
        const double post_spacing =
            (ext.north - ext.south) / (chosen_grid - 1) * (kPi / 180.0) * (body.active ? body.shape.a : 6371008.8);
        // A body's identity, copied from the plan only when it states it (absent
        // fields leave an Earth record's bytes as they were).
        const auto f_center = body.active ? b.CreateString(body.center_name) : 0;
        const auto f_radii = body.active ? b.CreateVector(std::vector<double>{body.shape.a})
                                         : flatbuffers::Offset<flatbuffers::Vector<double>>(0);
        const auto f_horizontal = body.active && !body.horizontal_datum.empty() ? b.CreateString(body.horizontal_datum) : 0;

        DTTBuilder db(b);
        db.add_TILESET_ID(f_tileset);
        db.add_TILING_SCHEME(body.active ? dttTilingScheme_GEOGRAPHIC_TWO_ROOT_BODY : dttTilingScheme_GEOGRAPHIC_WGS84);
        db.add_LEVEL(job.level);
        db.add_X(job.x);
        db.add_Y(job.y);
        db.add_WEST_DEG(ext.west);
        db.add_SOUTH_DEG(ext.south);
        db.add_EAST_DEG(ext.east);
        db.add_NORTH_DEG(ext.north);
        db.add_MIN_HEIGHT_M(min_h);
        db.add_MAX_HEIGHT_M(max_h);
        db.add_PAYLOAD_FORMAT(dttPayloadFormat_QUANTIZED_MESH);
        db.add_PAYLOAD_FORMAT_VERSION(f_version);
        db.add_PAYLOAD(payload);
        // GRID_WIDTH/GRID_HEIGHT are for GRIDDED payloads; the schema says
        // "Unset for mesh formats, whose vertex count varies", and this
        // payload is QUANTIZED_MESH. The sampling lattice is not the served
        // geometry, so stating it here would describe the wrong thing; the
        // effective resolution is POST_SPACING_M, which IS stated.
        db.add_POST_SPACING_M(post_spacing);
        // The source raster's own spacing at this latitude, from the granule
        // set that was actually decoded. Unset (0) only when no granule
        // covered the block, which is exactly when there is nothing to state.
        if (source_post_spacing > 0) db.add_SOURCE_POST_SPACING_M(source_post_spacing);
        db.add_VERTICAL_DATUM(body.active ? dttVerticalDatum_REFERENCE_SPHERE : dttVerticalDatum_GEOID);
        db.add_VERTICAL_DATUM_NAME(f_datum_name);
        if (f_horizontal.o) db.add_HORIZONTAL_DATUM_NAME(f_horizontal);
        // Measured, not asserted, and measured AT THE SOURCE POSTS: the
        // largest |mesh - source| over every post the granule set carries
        // inside this tile (coordinator resolution 2026-08-27 (1)). Stated
        // only when the walk actually ran, and only from a COMPLETE walk.
        if (stats.accuracy_probes > 0) {
            db.add_VERTICAL_ACCURACY_M(stats.vertical_accuracy_m);
            db.add_ACCURACY_CONFIDENCE(1.0);
        }
        db.add_DATA_COVERAGE_FRACTION(stats.coverage);
        db.add_NO_DATA_VALUE(kNoData);
        if (!body.active) {
            db.add_WATER_MASK_KIND(water_kind == "UNIFORM_WATER"
                                       ? dttWaterMask_UNIFORM_WATER
                                       : (water_kind == "RASTER" ? dttWaterMask_RASTER
                                                                 : dttWaterMask_UNIFORM_LAND));
        }
        if (water_ref.o) {
            // Themis: WATER_MASK and its two dimensions are set TOGETHER or
            // not at all — a mask whose geometry is unstated is undecodable.
            db.add_WATER_MASK(water_ref);
            db.add_WATER_MASK_WIDTH(kMaskSize);
            db.add_WATER_MASK_HEIGHT(kMaskSize);
        }
        if (f_water_provenance.o) db.add_WATER_MASK_PROVENANCE(f_water_provenance);
        db.add_CHILD_AVAILABILITY(static_cast<uint8_t>(job.child_availability & 0x0f));
        db.add_MAX_LEVEL(max_level);
        if (source_class != dttSourceClass_UNSPECIFIED) db.add_SOURCE_CLASS(source_class);
        db.add_PROVENANCE(provenance);
        db.add_ETAG(f_etag);
        db.add_REMARKS(f_remarks);
        if (f_center.o) db.add_CENTER_NAME(f_center);
        if (f_radii.o) db.add_REFERENCE_RADII_M(f_radii);
        FinishDTTBuffer(b, db.Finish());

        // Size-prefixed record stream: [uint32 LE length][record], per tile.
        const uint32_t len = b.GetSize();
        put_u32(&stream, len);
        stream.insert(stream.end(), b.GetBufferPointer(), b.GetBufferPointer() + len);
        emitted++;
        if (t == 0) first = stats;
        block_mask_from_absence += stats.mask_from_absence;
        block_mask_unclassified += stats.mask_unclassified;
        if (stats.vertical_accuracy_m > block_worst_accuracy_m) {
            block_worst_accuracy_m = stats.vertical_accuracy_m;
        }
        if (stats.at_ceiling) block_at_ceiling++;
        block_band_bridged += stats.band_bridged;
        block_edge_clamped += stats.edge_clamped;

        tile_items.push_back(std::to_string(job.level) + "/" + std::to_string(job.x) + "/" + std::to_string(job.y) +
                             " minHeightM=" + fmt_double(min_h) + " maxHeightM=" + fmt_double(max_h) +
                             " coverageFraction=" + fmt_double(stats.coverage) + " waterMaskKind=" + water_kind +
                             " maskFromAbsenceSamples=" + std::to_string(stats.mask_from_absence) +
                             " maskUnclassifiedSamples=" + std::to_string(stats.mask_unclassified) +
                             " edgeClampedPosts=" + std::to_string(stats.edge_clamped) +
                             " bandBridgedPosts=" + std::to_string(stats.band_bridged) +
                             " gridSize=" + std::to_string(stats.grid) +
                             " errorTargetM=" + fmt_double(stats.error_target_m) +
                             " atCeiling=" + (stats.at_ceiling ? "true" : "false") +
                             " verticalAccuracyM=" + fmt_double(stats.vertical_accuracy_m) +
                             " accuracyProbes=" + std::to_string(stats.accuracy_probes) +
                             " meshBytes=" + std::to_string(stats.mesh_bytes) +
                             " payloadBytes=" + std::to_string(stats.payload_bytes) + " digest=" + digest +
                             (body.active ? body_tile_items(cap_stopped && at_ceiling, rms_m, residual_histogram) + fill_items : std::string()));
    }

    // THE REPORT IS A FlowNotice (FNTC, KIND Info, REASON "tile-block"): COUNT is the records this block emitted
    // (ingest_meta reads it to catch a batch that reports success while storing nothing), ITEMS the block's
    // measurements as "name=value" facts, then one item per address ("z/x/y name=value ..."; an address the ocean
    // test dropped says skippedOcean=true, which is how a runner learns which addresses to DECLARE as ocean).
    std::vector<std::string> items = {
        "tilesetId=" + tileset_id,
        "level=" + std::to_string(jobs[0].level),
        "x=" + std::to_string(jobs[0].x),
        "y=" + std::to_string(jobs[0].y),
        "gridSize=" + std::to_string(grid),
        "maxGridSize=" + std::to_string(sample_grid),
        "tilesAtCeiling=" + std::to_string(block_at_ceiling),
        "bandBridgedPosts=" + std::to_string(block_band_bridged),
        "edgeClampedPosts=" + std::to_string(block_edge_clamped),
        "tileCount=" + std::to_string(jobs.size()),
        "tilesEmitted=" + std::to_string(emitted),
        "recordsOut=" + std::to_string(emitted),
        "tilesSkippedOcean=" + std::to_string(skipped_ocean_count),
        "tilesSkippedOceanFromSource=" + std::to_string(skipped_ocean_from_source_count),
        "granulesDecoded=" + std::to_string(granules.size()),
        "granulesAbsent=" + std::to_string(absent_granules),
        "waterGranulesDecoded=" + std::to_string(water_granules.size()),
        "waterGranulesAbsent=" + std::to_string(water_absent),
        "decodeResidentBytes=" + std::to_string(budget.used),
        "decodeBudgetBytes=" + std::to_string(kDecodeByteBudget),
        "tileGzipCeilingBytes=" + std::to_string(kTileGzipCeilingBytes),
        "sourcePostSpacingM=" + fmt_double(source_post_spacing),
        "sourcePostsPerTileEdge=" + fmt_double(source_posts_per_tile_edge),
        "maskFromAbsenceSamples=" + std::to_string(block_mask_from_absence),
        "maskUnclassifiedSamples=" + std::to_string(block_mask_unclassified),
        "worstVerticalAccuracyM=" + fmt_double(block_worst_accuracy_m),
        "sourceClass=" + source_class_name,
        "noDataSamples=" + std::to_string(first.nodata),
        "uncoveredSamples=" + std::to_string(first.uncovered),
        "coverageFraction=" + fmt_double(first.coverage),
        "minHeightM=" + fmt_double(first.min_h),
        "maxHeightM=" + fmt_double(first.max_h),
        "waterMaskKind=" + first.water_kind,
        "meshBytes=" + std::to_string(first.mesh_bytes),
        "payloadBytes=" + std::to_string(first.payload_bytes),
        "digest=" + first.digest,
        "contentEncoding=gzip",
        body.active ? std::string("verticalDatum=REFERENCE_SPHERE") : std::string("verticalDatum=GEOID"),
        body.active ? "verticalDatumNote=heights are metres above the body's reference sphere (" +
                          fmt_double(body.shape.a) + " m), as the source product states them"
                    : std::string("verticalDatumNote=heights redistributed on the source geoid datum, not converted "
                                  "to ellipsoidal; bounded <~100 m offset if rendered as above-ellipsoid"),
    };
    if (body.active) items.push_back("centerName=" + body.center_name);
    items.insert(items.end(), tile_items.begin(), tile_items.end());

    // A CELL WHOSE EVERY TILE IS OCEAN STILL EMITS A FRAME. Skipping the push
    // leaves the downstream scheduler with no `records` input, its node never
    // runs, the resume mark never advances and the walk STALLS FOREVER on the
    // first open-ocean cell — which is exactly what happened on the first
    // regional run. A single zero-length size prefix is the store's own
    // framing for "no records here" (every reader already treats a zero prefix
    // as alignment padding), so the frame is well-formed and decodes to
    // nothing.
    if (stream.empty()) put_u32(&stream, 0);
    if (push_dtt_stream("records", stream) < 0) return 500;
    sdn::runtime::FlowNoticeT notice;
    notice.KIND = sdn::runtime::flowNoticeKind_Info;
    notice.SCHEMA = "DTT.fbs";
    notice.SOURCE_NAME = tileset_id;
    notice.COUNT = emitted;
    notice.REASON = "tile-block";
    notice.ITEMS = std::move(items);
    ::flatbuffers::FlatBufferBuilder nb(4096);
    sdn::runtime::FinishFlowNoticeBuffer(nb, sdn::runtime::FlowNotice::Pack(nb, &notice));
    return plugin_push_output_ex("report", "FlowNotice.fbs", sdn::runtime::FlowNoticeIdentifier(),
                                 PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "FlowNotice", 0, 0, nb.GetBufferPointer(),
                                 static_cast<uint32_t>(nb.GetSize())) < 0
               ? 500
               : 0;
}

// ---------------------------------------------------------------------------
// layer_json — plan -> the tileset's complete layer.json body, emitted as the
// SDK's canonical $HTR HttpResponse envelope (never a JSON control frame).
// ---------------------------------------------------------------------------
int layer_json(void) {
    if (refuse_batched()) return 500;

    // The request route accepted for ".../layer.json" ($HTQ, verbatim) is the plan: the body is the mount's layer
    // plan (from the config, as route reads it), rendered under this request's If-None-Match / Accept-Encoding.
    bool present = false;
    const sdn::http::HttpRequest* request = htq_input("plan", &present);
    if (!present) {
        plugin_set_error("missing-plan-frame",
                         "layer_json requires the routed $HTQ request on port \"plan\".");
        return 400;
    }
    if (!request) {
        plugin_set_error("invalid-plan-frame", "the plan frame is not a $HTQ HttpRequest.");
        return 400;
    }
    const ServingConfig* cfg_ptr = invocation_serving_config();
    if (!cfg_ptr) {
        plugin_set_error("invalid-config-frame", "the config frame is not a ModuleConfig (MCFG).");
        return 400;
    }
    const std::string plan = layer_plan_for(*cfg_ptr, negotiation_of(request));
    const std::string tileset_id = json_string(plan, "tilesetId", "");
    if (tileset_id.empty()) {
        plugin_set_error("missing-tileset-id", "the plan frame must state tilesetId.");
        return 400;
    }
    const long maxzoom = static_cast<long>(json_number(plan, "maxzoom", -1));
    if (maxzoom < 0) {
        plugin_set_error("missing-maxzoom", "the plan frame must state maxzoom.");
        return 400;
    }
    // The availability index is the ORCHESTRATOR'S knowledge — which tiles it
    // has actually produced — so it rides through verbatim and is never
    // synthesized here.
    std::string available;
    if (!json_raw_value(plan, "available", &available) || available.empty() ||
        available[0] != '[') {
        plugin_set_error("missing-availability",
                         "the plan frame must carry the available-tile index as an array; a "
                         "layer.json that promises tiles nobody produced serves 404s.");
        return 400;
    }

    // ── THE RENDER IS CACHED AGAINST THE PLAN'S OWN NAME ────────────────────
    //
    // layer.json is a pure function of the mount's config, and route() derives
    // a content name for that config once per instance (planToken). So the
    // body, its strong ETag and its gzipped form are produced ONCE and reused
    // until the config — and therefore the token — changes.
    //
    // It matters at the ruled ship configuration: a global z11 availability
    // index renders a 4.4 MB body, and rendering + hashing + gzipping it on
    // every request is 168 ms of guest CPU that one anonymous 40-byte GET can
    // buy. Cached, a revalidation is a token compare and a 304.
    //
    // A plan with NO token (an operator wiring layer_json directly, or an
    // older route) is rendered every time rather than cached under an empty
    // key — a cache that answers for bytes it has not seen is worse than no
    // cache.
    struct RenderedLayer {
        std::string token;
        std::string body;
        std::string etag;
        std::vector<uint8_t> gzipped;  // empty when compression did not help
    };
    static RenderedLayer* cache = new RenderedLayer();

    const std::string token = json_string(plan, "planToken", "");
    if (token.empty() || cache->token != token) {
        cache->body =
            std::string("{\"tilejson\":\"2.1.0\"") + ",\"name\":\"" + json_escape(tileset_id) +
            "\"" + ",\"description\":\"" +
            json_escape(json_string(plan, "description", "")) + "\"" +
            ",\"version\":\"" + json_escape(json_string(plan, "version", "1.0.0")) + "\"" +
            ",\"format\":\"quantized-mesh-1.0\",\"attribution\":\"" +
            json_escape(json_string(plan, "attribution", "")) + "\"" +
            ",\"scheme\":\"tms\",\"tiles\":[\"" +
            json_escape(json_string(plan, "tiles", "{z}/{x}/{y}.terrain?v={version}")) + "\"]" +
            ",\"projection\":\"EPSG:4326\",\"bounds\":[-180,-90,180,90]" +
            ",\"minzoom\":0,\"maxzoom\":" + std::to_string(maxzoom) +
            ",\"extensions\":[\"watermask\"]" +
            // ── THE DATUM IS STATED WHERE THE CLIENT CAN READ IT ────────────
            //
            // The published IPFS directory is layer.json plus the .terrain
            // bytes; the per-tile $DTT records, which DO state the datum, are
            // not in it. So a client on the delivery path the owner made
            // primary had no machine-readable statement of the datum at all,
            // and quantized-mesh heights are interpreted as WGS84 ELLIPSOIDAL
            // by every consumer that does not know better. These two keys are
            // that statement, and they carry the same values the tile records
            // carry (GEOID / the plan's verticalDatumName), so the tileset and
            // its tiles cannot disagree.
            ",\"verticalDatum\":\"" +
            json_escape(json_string(plan, "verticalDatum", "GEOID")) + "\"" +
            ",\"verticalDatumName\":\"" +
            json_escape(json_string(plan, "verticalDatumName", "EGM2008")) + "\"" +
            ",\"available\":" + available + "}";
        cache->gzipped.clear();
        std::vector<uint8_t> compressed;
        if (gzip_compress(std::vector<uint8_t>(cache->body.begin(), cache->body.end()),
                          &compressed) &&
            compressed.size() < cache->body.size()) {
            cache->gzipped.swap(compressed);
        }
        // The IDENTITY representation names the resource; the gzipped one is
        // a second representation of it and gets its own tag below, because a
        // strong ETag names ONE representation and a shared cache holding the
        // other must not answer its revalidation with a 304.
        cache->etag = "\"" + sha256_multihash(std::vector<uint8_t>(cache->body.begin(),
                                                                   cache->body.end())) +
                      "\"";
        cache->token = token;
    }

    // ── layer.json STATES ITS CACHE POLICY, LIKE EVERY OTHER RESPONSE ───────
    //
    // It used to ship with exactly one header — content-type — while the tiles
    // it indexes carried `public, max-age=86400`, a strong ETag and a vary,
    // and even the 404 argued its own max-age in a comment. So the one
    // response every client fetches FIRST, and refetches in full on every
    // session, had no ETag to revalidate against, no freshness an intermediary
    // could reason about, and no compression — 4.4 MB at the ruled ship
    // configuration, against 801 KB gzipped, from a module that gzips its
    // 1.6 KB tiles.
    //
    // max-age is 300, not the tiles' 86400, and the difference is deliberate:
    // a tile at an address is immutable for an edition, but layer.json is the
    // INDEX, and a client holding a stale one asks for tiles that do not exist
    // yet or never learns about the ones that now do. Five minutes bounds that
    // window while still collapsing the burst of a page load; the strong ETag
    // makes every revalidation after it a 304.
    const bool accepts_gzip = json_bool(plan, "acceptsGzip", true);
    const bool serve_gzip = accepts_gzip && !cache->gzipped.empty();
    // Two representations, two tags. The gzipped body's tag is DERIVED from
    // the identity tag rather than hashed separately: gzip is deterministic
    // here, so one is a pure function of the other, and deriving it costs
    // nothing on a cache hit.
    const std::string etag =
        serve_gzip ? "\"gzip-" + cache->etag.substr(1) : cache->etag;

    std::vector<HeaderEntry> headers;
    headers.push_back({"cache-control", "public, max-age=300"});
    headers.push_back({"etag", etag});
    headers.push_back({"vary", "accept-encoding"});
    const std::string if_none_match = json_string(plan, "ifNoneMatch", "");
    if (!if_none_match.empty() && if_none_match == etag) {
        return push_htr(304, headers, nullptr, 0);
    }
    headers.push_back({"content-type", "application/json"});
    headers.push_back({"x-content-type-options", "nosniff"});
    if (serve_gzip) {
        headers.push_back({"content-encoding", "gzip"});
        return push_htr(200, headers, cache->gzipped.data(), cache->gzipped.size());
    }
    return push_htr(200, headers, reinterpret_cast<const uint8_t*>(cache->body.data()),
                    cache->body.size());
}

// ---------------------------------------------------------------------------
// route — one $HTQ HttpRequest -> exactly one of:
//   layer_plan  (path ".../terrain/layer.json")  -> the layer_json node
//   query+context (path ".../terrain/{z}/{x}/{y}.terrain") -> flatsql-query
//   response    (anything else) -> a direct, cacheable $HTR 404
//
// The mount prefix is config-owned (the node mounts this flow at
// /api/v1/terrain/, sdn-server lane), so the router strips up to and
// including the LAST "/terrain/" segment rather than pinning the prefix.
//
// SERVING CONFIG (plugin.getConfig, all optional):
//   terrain_tileset_id   the pyramid served (default "spaceaware-terrain")
//   terrain_maxzoom      layer.json maxzoom (default 0)
//   terrain_available    the availability index as a NumberList of
//                        [level, startX, startY, endX, endY] tuples, rendered
//                        into layer.json `available` (default the two level-0
//                        roots — honest exactly when maxzoom is 0)
//   terrain_attribution / terrain_description / terrain_version
// The availability index is the ORCHESTRATOR'S knowledge; first light takes
// it from config rather than aggregating SQL per request, because layer.json
// is fetched once per client session and the config is updated by the same
// lane that ingests tiles. The SQL-aggregate upgrade is recorded in the
// manifest description, not silently skipped.
// ---------------------------------------------------------------------------
int route(void) {
    if (refuse_batched()) return 500;

    const int32_t request_index = plugin_find_input_index("request", 0);
    const plugin_input_frame_t* frame =
        request_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(request_index))
                           : nullptr;
    if (!frame || !frame->payload || frame->payload_length == 0) {
        plugin_set_error("missing-request-frame",
                         "route requires a $HTQ HttpRequest frame on port \"request\".");
        return 400;
    }
    ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!sdn::http::VerifyHttpRequestBuffer(verifier)) {
        plugin_set_error("invalid-request-frame",
                         "the request frame is not a valid $HTQ HttpRequest envelope.");
        return 400;
    }
    const sdn::http::HttpRequest* request = sdn::http::GetHttpRequest(frame->payload);
    const std::string method = request->METHOD() ? request->METHOD()->str() : "GET";
    if (method != "GET" && method != "HEAD") {
        std::vector<HeaderEntry> headers = {{"allow", "GET, HEAD"},
                                            {"content-type", "application/json"}};
        const std::string body = "{\"error\":\"method not allowed\"}";
        return push_htr(405, headers, reinterpret_cast<const uint8_t*>(body.data()),
                        body.size());
    }
    const std::string path = request->PATH() ? request->PATH()->str() : "";
    const std::string raw_query = request->QUERY() ? request->QUERY()->str() : "";

    // O(1) in the size of the availability index: read once per instance (or, from the optional "config" port's
    // ModuleConfig, once per distinct frame), and everything derived from it derived once with it. See ServingConfig.
    // The config port exists because the CATALOGUE SURFACE HAD NO TRI-RUNTIME COVERAGE: the parity twin is compiled
    // with TERRAIN_SOURCE_NO_HOST_BRIDGE, so plugin.getConfig answers nothing there; with the config on a frame the
    // three parity lanes execute the same record builder over the same bytes.
    const ServingConfig* cfg_ptr = invocation_serving_config();
    if (!cfg_ptr) {
        plugin_set_error("invalid-config-frame", "the config frame is not a ModuleConfig (MCFG).");
        return 400;
    }
    const ServingConfig& cfg = *cfg_ptr;
    const Negotiation negotiation = negotiation_of(request);
    const std::string& if_none_match = negotiation.if_none_match;

    const std::string& mount_prefix = cfg.mount_prefix;
    if (path.size() < mount_prefix.size() ||
        path.compare(0, mount_prefix.size(), mount_prefix) != 0) {
        return push_htr_not_found(path, /*cacheable=*/false);
    }
    const std::string rest = path.substr(mount_prefix.size());

    // ── ONE TILE, ONE URL — INCLUDING THE QUERY STRING ──────────────────────
    //
    // The mount fixes the path half of that promise. The query half was simply
    // never looked at: route() read $HTQ PATH and nothing else, so
    // /api/v1/terrain/8/271/192.terrain?<anything at all> was answered 200
    // `public, max-age=86400` under unboundedly many distinct cache keys — the
    // exact amplifier class this module already closed twice on the path (the
    // leading-zero addresses and the mount search fallback), left open in its
    // unbounded form. The host passes the query separately and intact
    // (flowrt/httpmount stages PATH from EscapedPath and QUERY from RawQuery),
    // so it is readable here and now it is read.
    //
    // It cannot simply be rejected: layer.json states its tiles template as
    // "{z}/{x}/{y}.terrain?v={version}", so a conforming native client sends
    // exactly `v=<the version layer.json declared>` on every tile request.
    // That ONE token is admitted, and it is checked against the configured
    // version rather than accepted for its shape — a stale `v` names a
    // tileset edition this mount is not serving and is not the same resource.
    // Everything else is a 404, which is cheap, cacheable, and cannot be
    // filled with junk keys because there is only one key that answers.
    const std::string accepted_query = "v=" + cfg.version;
    if (!raw_query.empty() && raw_query != accepted_query) {
        return push_htr_not_found(path, /*cacheable=*/false);
    }

    // ── THE CATALOGUE: WHICH TILESET EPOCH THIS NODE IS SERVING ────────────
    //
    // OWNER 2026-08-27: terrain files are requested over IPFS. The pyramid is
    // one content-addressed directory per tileset epoch — layer.json and every
    // {z}/{x}/{y}.terrain inside it — added and pinned through the node's IPFS
    // API by the off-fleet builder, and the clients point a native terrain
    // provider at the gateway path of the CURRENT CID.
    //
    // So this mount stops being the delivery path and becomes the RESOLVER for
    // it: one small document, at the mount root, naming the CID. A client
    // fetches it once, joins `terrainBasePath` against the node origin it
    // already knows, and never learns a hostname or an epoch from its own
    // source (the owner refused a static asset hostname on the same day).
    //
    // The tile and layer.json routes below still answer, unchanged. They are
    // not the delivery path any more; they are what a node with no CID
    // configured falls back to, and what makes a local development node work
    // with no IPFS daemon at all — which is exactly what `delivery` says on
    // the wire, so a client can tell the two apart rather than guess.
    //
    // Keys are lowercase/camelCase: this is an API-synthesized discovery
    // document, not a $DTT rendered as JSON (which takes IDL-exact keys).
    //
    // max-age is 60, not the tiles' 86400 and not layer.json's 300. Everything
    // under a CID is immutable forever; THIS is the one mutable pointer in the
    // lane, and the whole cutover to a new epoch is a client noticing it
    // changed. A minute bounds that; the strong ETag makes every revalidation
    // after the first a 304.
    // ── THE SAME EPOCH AS A $DTT RECORD: /tileset.json ─────────────────────
    //
    // The camelCase document below is an API convenience. THIS is the durable
    // form: the tileset epoch as a $DTT catalogue record, IDL-EXACT KEYS, the
    // same projection the builder writes to `tileset-catalogue.json` and the
    // dataset lane publishes (tools/terrain-pyramid/IPFS-DELIVERY.md holds the
    // field mapping, ratified by Themis — it mints nothing, every field is a
    // $DTT field carrying what schema/DTT/main.fbs says it carries).
    //
    // It exists as its own path because the CLIENTS READ THIS ONE. The console
    // resolves the epoch by fetching `<node>/api/v1/terrain/tileset.json` and
    // pulling `PAYLOAD.CID` out of it — a $DTT field, not a camelCase alias —
    // and refuses anything that is not a syntactically valid CID. Serving the
    // discovery document only under `catalogue.json`, as this module did
    // first, left that fetch answering 404 through the tile parser: the
    // console would report "terrain catalogue answered HTTP 404", keep the
    // ellipsoid by its never-halt rule, and render no terrain at all — while
    // every tile under `/ipfs/` kept answering perfectly. Both sides were
    // green against their own fixtures (the console against its local
    // `terrain-node.mjs` stand-in, this module against its own tests) and
    // incompatible only where they meet, which is the one place neither
    // lane's tests looked.
    //
    // The discriminator against a TILE record is `PAYLOAD.MEDIA_TYPE`: a tile
    // carries one mesh (`application/vnd.quantized-mesh`), the catalogue
    // carries the DIRECTORY those tiles live in (`application/vnd.ipld.dag-pb`).
    // `LEVEL`/`X`/`Y` are 0 and are NOT the discriminator — the builder stores
    // nothing at level 0, so the address is free, but a reader must key on the
    // media type.
    //
    // A node with no CID configured answers a truthful record with no PAYLOAD.
    // A client then finds no `PAYLOAD.CID`, says so, and keeps its ellipsoid —
    // which is the correct outcome for a node that is not serving an IPFS
    // tileset, and is exactly what a development node without a daemon is.
    if (rest == "tileset.json") {
        const bool over_ipfs = !cfg.tileset_cid.empty();

        // ── THE RECORD HAS TO BE BUILDABLE, AND THAT IS NOW CHECKED ─────────
        //
        // This route claimed "IDL-EXACT KEYS" and it kept that claim: every
        // key here is a $DTT field spelled as schema/DTT/main.fbs spells it.
        // What it did NOT keep is the harder half — the document has to be a
        // record, not just a JSON object with the right key names — and it
        // was not one. DTTProvenance marks RETRIEVED_AT `required` and this
        // never emitted it; DTT marks PAYLOAD `required` and this omitted the
        // whole table whenever no CID was configured. Fed to the published
        // builder both projections THROW ("field 18 must be set", "field 34
        // must be set"), so the durable form the dual-format signing law
        // depends on could not exist for either shape. Nothing in the suite
        // had ever built the projection through the builder, which is exactly
        // why an unbuildable record passed 100 tests.
        //
        // So: the four `required` provenance fields are stated or the mount
        // does not publish a catalogue at all. A node that cannot state which
        // dataset edition it redistributes, when it was retrieved, and under
        // what licence has no business publishing redistributed elevation —
        // and an empty string in a required field would satisfy FlatBuffers
        // while telling a consumer nothing, which is worse than refusing.
        // The refusal names the exact config keys, so an operator reads the
        // fix off the wire instead of diffing against this file.
        std::string missing;
        const auto require_configured = [&missing](const char* key, const std::string& value) {
            if (!value.empty()) return;
            if (!missing.empty()) missing += ",";
            missing += std::string("\"") + key + "\"";
        };
        require_configured("terrain_dataset_id", cfg.dataset_id);
        require_configured("terrain_dataset_epoch", cfg.dataset_epoch);
        require_configured("terrain_dataset_retrieved_at", cfg.dataset_retrieved_at);
        require_configured("terrain_license", cfg.license);
        if (!missing.empty()) {
            return push_htr_json(
                503,
                std::string("{\"error\":\"terrain catalogue not configured\",\"detail\":\"the "
                            "$DTT catalogue record cannot be built: schema/DTT/main.fbs marks "
                            "these DTTProvenance fields required and this mount was configured "
                            "with none of them\",\"missingConfigKeys\":[") +
                    missing + "]}",
                "no-store");
        }

        // ── THE ADDRESS AND THE EXTENT NO LONGER CONTRADICT EACH OTHER ──────
        //
        // This used to state TILING_SCHEME GEOGRAPHIC_WGS84 with LEVEL/X/Y
        // 0/0/0 and WEST/EAST -180/180. Under that scheme the IDL defines
        // level 0 as TWO root tiles covering [-180,0] and [0,180], so address
        // (0,0,0) is the WESTERN half and the stated extent was twice what
        // the stated address covers. A consumer doing the ordinary thing with
        // a $DTT — derive the extent from LEVEL/X/Y and TILING_SCHEME — got a
        // different answer from the one the record spelled out.
        //
        // The catalogue is NOT A TILE: it is the DIRECTORY the tiles live in,
        // and it has no address in any tiling scheme. TILING_SCHEME is
        // therefore UNSPECIFIED — the ordinal the IDL reserves at 0 precisely
        // so "an unset field can never be read as a real scheme" — and
        // LEVEL/X/Y are simply not stated. Without a scheme they are not
        // interpretable as an address, which is the truth about this record.
        // The extent stands on its own, from the orchestrator, and is omitted
        // when the mount was told none. The SCHEME OF THE TILES INSIDE is
        // declared by the layer.json in the CID, which is where a terrain
        // provider reads it from anyway.
        std::string body =
            std::string("{\"TILESET_ID\":\"") + json_escape(cfg.tileset_id) + "\"" +
            ",\"TILESET_NAME\":\"" + json_escape(cfg.tileset_id) + "\"" +
            ",\"TILING_SCHEME\":\"UNSPECIFIED\"";
        if (cfg.has_extent) {
            body += ",\"WEST_DEG\":" + fmt_double(cfg.west_deg) +
                    ",\"SOUTH_DEG\":" + fmt_double(cfg.south_deg) +
                    ",\"EAST_DEG\":" + fmt_double(cfg.east_deg) +
                    ",\"NORTH_DEG\":" + fmt_double(cfg.north_deg);
        }
        body += ",\"PAYLOAD_FORMAT\":\"QUANTIZED_MESH\",\"PAYLOAD_FORMAT_VERSION\":\"1.0\"";

        // PAYLOAD is `required`. With a CID it names the content-addressed
        // directory the tiles are served from; without one it is PRESENT AND
        // EMPTY — a payload ref that states nothing, which is the truthful
        // shape for a node serving no IPFS tileset and, unlike omitting the
        // table, is a record the builder can serialize. A client still finds
        // no PAYLOAD.CID, says so, and keeps its ellipsoid: unchanged
        // behaviour, now over a document that is a $DTT.
        body += ",\"PAYLOAD\":{";
        if (over_ipfs) {
            body += "\"CID\":\"" + json_escape(cfg.tileset_cid) + "\"";
            if (cfg.tileset_size_bytes > 0) {
                body += ",\"SIZE_BYTES\":" +
                        std::to_string(static_cast<long long>(cfg.tileset_size_bytes));
            }
            // The discriminator against a TILE record: a tile carries one mesh
            // (application/vnd.quantized-mesh), the catalogue carries the
            // DIRECTORY those tiles live in.
            body += ",\"MEDIA_TYPE\":\"application/vnd.ipld.dag-pb\"";
        }
        body += "}";

        body += ",\"MAX_LEVEL\":" + std::to_string(cfg.maxzoom) +
                ",\"WATER_MASK_KIND\":\"NONE\"";
        // ── THE DATUM, CARRIED NOT DROPPED ──────────────────────────────────
        //
        // Every tile record states GEOID / EGM2008. This record used to state
        // neither, so it wire-defaulted to VERTICAL_DATUM UNSPECIFIED — which
        // the IDL defines as "the datum is not stated; heights are not
        // comparable across tiles" — on the one document both clients read.
        // The tileset and its tiles now say the same thing, and REMARKS
        // carries the encoder's own bounded-offset warning verbatim so a
        // consumer reading only the catalogue still learns the cost of
        // rendering these heights as above-ellipsoid.
        body += ",\"VERTICAL_DATUM\":\"GEOID\",\"VERTICAL_DATUM_NAME\":\"" +
                json_escape(cfg.vertical_datum_name) + "\"" + ",\"REMARKS\":\"" +
                json_escape(kGeoidRemark) + "\"";
        // PROVENANCE carries only what the mount was actually told. A lineage
        // field invented here would be a claim about a dataset this module
        // never read. The four required fields are guaranteed present by the
        // refusal above.
        std::string prov;
        const auto add_prov = [&prov](const char* key, const std::string& value) {
            if (value.empty()) return;
            if (!prov.empty()) prov += ",";
            prov += std::string("\"") + key + "\":\"" + json_escape(value) + "\"";
        };
        add_prov("DATASET_ID", cfg.dataset_id);
        add_prov("DATASET_NAME", cfg.dataset_name);
        add_prov("DATASET_EPOCH", cfg.dataset_epoch);
        add_prov("RETRIEVED_AT", cfg.dataset_retrieved_at);
        add_prov("LICENSE", cfg.license);
        add_prov("LICENSE_URL", cfg.license_url);
        add_prov("ATTRIBUTION", cfg.attribution);
        // NOT cfg.tileset_cid. DATASET_CID names the SOURCE artifact this
        // pyramid was cut from — a different thing from the tileset directory,
        // which is PAYLOAD.CID above and is the only field either client
        // reads for it. This used to be the tileset CID as well, which made
        // two readers of two different fields agree by coincidence; see
        // ServingConfig::source_dataset_cid.
        add_prov("DATASET_CID", cfg.source_dataset_cid);
        body += ",\"PROVENANCE\":{" + prov + "}";
        body += "}";
        const std::string etag =
            "\"" + sha256_multihash(std::vector<uint8_t>(body.begin(), body.end())) + "\"";
        std::vector<HeaderEntry> headers = {{"content-type", "application/json"},
                                            {"cache-control", "public, max-age=60"},
                                            {"etag", etag},
                                            {"access-control-allow-origin", "*"}};
        if (!if_none_match.empty() && if_none_match == etag) {
            return push_htr(304, headers, nullptr, 0);
        }
        return push_htr(200, headers, reinterpret_cast<const uint8_t*>(body.data()),
                        body.size());
    }

    if (rest.empty() || rest == "catalogue.json") {
        const bool over_ipfs = !cfg.tileset_cid.empty();
        const std::string base =
            over_ipfs ? cfg.gateway_path + cfg.tileset_cid + "/" : cfg.mount_prefix;
        std::string body =
            std::string("{\"tilesetId\":\"") + json_escape(cfg.tileset_id) + "\"" +
            ",\"delivery\":\"" + (over_ipfs ? "ipfs" : "mount") + "\"" +
            ",\"cid\":" + (over_ipfs ? "\"" + json_escape(cfg.tileset_cid) + "\"" : "null") +
            ",\"datasetEpoch\":" +
            (cfg.dataset_epoch.empty() ? "null"
                                       : "\"" + json_escape(cfg.dataset_epoch) + "\"") +
            ",\"version\":\"" + json_escape(cfg.version) + "\"" +
            ",\"terrainBasePath\":\"" + json_escape(base) + "\"" +
            ",\"layerJsonPath\":\"" + json_escape(base + "layer.json") + "\"";
        if (!cfg.gateway_origin.empty() && over_ipfs) {
            body += ",\"terrainBaseUrl\":\"" + json_escape(cfg.gateway_origin + base) + "\"";
        }
        body += std::string(",\"format\":\"quantized-mesh-1.0\",\"scheme\":\"tms\"") +
                ",\"projection\":\"EPSG:4326\",\"extensions\":[\"watermask\"]" +
                ",\"maxzoom\":" + std::to_string(cfg.maxzoom) +
                ",\"attribution\":\"" + json_escape(cfg.attribution) + "\"}";
        const std::string etag =
            "\"" + sha256_multihash(std::vector<uint8_t>(body.begin(), body.end())) + "\"";
        std::vector<HeaderEntry> headers = {{"content-type", "application/json"},
                                            {"cache-control", "public, max-age=60"},
                                            {"etag", etag},
                                            {"access-control-allow-origin", "*"}};
        if (!if_none_match.empty() && if_none_match == etag) {
            return push_htr(304, headers, nullptr, 0);
        }
        return push_htr(200, headers, reinterpret_cast<const uint8_t*>(body.data()),
                        body.size());
    }

    if (rest == "layer.json") {
        // The request itself is layer_json's plan: it renders the mount's layer.json under this request's
        // conditional state (layer_plan_for), from the same config.
        return push_htq("layer_plan", frame) < 0 ? 500 : 0;
    }

    uint32_t z = 0, x = 0, y = 0;
    if (!parse_tile_path(rest, &z, &x, &y)) {
        return push_htr_not_found(path, /*cacheable=*/false);
    }

    // The newest stored record for this address wins; the record BLOB is the
    // whole answer ($DTT carries its own payload, encoding and etag).
    //
    // `_rowid`, NOT `rowid`. On a node the relation named `DTT` is not a table:
    // sdn-server registers a source for every ingested record and rebuilds the
    // unified views, and flatsqlrt.CreateUnifiedViews replaces each base table
    // with a UNION ALL VIEW over its per-source shadow tables. A SQLite view
    // has no implicit rowid, so `ORDER BY rowid` is `no such column: rowid` on
    // every real node — and invisible off-node, where the same query runs
    // against the base vtab, which does accept it. `_rowid` is the column the
    // vtab declares and the form the owner's engine-routed law states
    // (2026-08-25); tests/serve.test.mjs executes this SQL against an engine
    // with a registered source so the difference cannot go unmeasured again.
    // The newest stored record for the address wins (_rowid, NOT rowid: on a node DTT is a unified VIEW and a view
    // has no implicit rowid). The request rides on to respond as its context.
    if (push_tile_query(cfg, z, x, y) < 0) return 500;
    return push_htq("context", frame) < 0 ? 500 : 0;
}

// ---------------------------------------------------------------------------
// respond — the flatsql-query stream (aligned size-prefixed $DTT frames) +
// route's context -> one $HTR envelope.
//
//   record found  -> 200, payload BYTES verbatim (already gzipped at encode
//                    time), content-type/content-encoding FROM THE RECORD,
//                    cache-control public max-age=86400, strong ETag
//   etag match    -> 304 (empty body)
//   empty stream  -> a cacheable 404 (an unpublished tile is NORMAL: client
//                    upsampling relies on layer.json availability)
// ---------------------------------------------------------------------------
int respond(void) {
    if (refuse_batched()) return 500;

    // ── THE STORE'S ANSWER: one $FSO status, and the result stream as $FSB chunks ──
    //
    // hostcap/flatsql-query answers a query with its records as ordered $FSB chunks (DATA <= 1 MiB each,
    // CHUNK_SEQUENCE from 0, FINAL on the last; a stored tile record may exceed one chunk) and ONE $FSO status. A
    // query the store refused or failed answers on status alone; that is answered here as a 503 the client may retry,
    // never as a miss (a miss would synthesize terrain over a store that was simply unreachable).
    const int32_t status_index = plugin_find_input_index("status", 0);
    const plugin_input_frame_t* status_frame =
        status_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(status_index)) : nullptr;
    if (!status_frame) {
        plugin_set_error("missing-status-frame",
                         "respond requires the flatsql-query status frame ($FSO) on port \"status\".");
        return 400;
    }
    {
        ::flatbuffers::Verifier verifier(status_frame->payload ? status_frame->payload : reinterpret_cast<const uint8_t*>(""),
                                         status_frame->payload ? status_frame->payload_length : 0);
        if (!status_frame->payload || status_frame->payload_length < 8 || !VerifyFSOBuffer(verifier)) {
            plugin_set_error("invalid-status-frame", "the status frame is not an $FSO.");
            return 400;
        }
        const FSO& status = *GetFSO(status_frame->payload);
        if (status.STATUS() != flatSqlNodeStatus_COMPLETE && status.STATUS() != flatSqlNodeStatus_OK) {
            const std::string code = status.ERROR_CODE() ? status.ERROR_CODE()->str() : std::string("query-failed");
            return push_htr_json(503,
                                 "{\"error\":\"terrain store query failed\",\"code\":\"" + json_escape(code) + "\"}",
                                 "no-store");
        }
    }
    std::vector<uint8_t> stream_bytes;
    {
        std::vector<std::pair<uint32_t, const FSB*>> chunks;
        for (uint32_t ordinal = 0;; ordinal++) {
            const int32_t idx = plugin_find_input_index("records", ordinal);
            if (idx < 0) break;
            const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(idx));
            ::flatbuffers::Verifier verifier(f && f->payload ? f->payload : reinterpret_cast<const uint8_t*>(""),
                                             f && f->payload ? f->payload_length : 0);
            if (!f || !f->payload || f->payload_length < 8 || !VerifyFSBBuffer(verifier)) {
                plugin_set_error("invalid-records-frame", "a records frame is not an $FSB chunk.");
                return 400;
            }
            const FSB* chunk = GetFSB(f->payload);
            chunks.push_back({chunk->CHUNK_SEQUENCE(), chunk});
        }
        std::sort(chunks.begin(), chunks.end(),
                  [](const std::pair<uint32_t, const FSB*>& l, const std::pair<uint32_t, const FSB*>& r) {
                      return l.first < r.first;
                  });
        for (size_t i = 0; i < chunks.size(); i++) {
            if (chunks[i].first != i) {
                plugin_set_error("incomplete-result-stream",
                                 "the $FSB chunks do not run 0..n-1; a tile assembled from a partial stream is "
                                 "refused rather than served.");
                return 400;
            }
            if (const auto* d = chunks[i].second->DATA()) stream_bytes.insert(stream_bytes.end(), d->begin(), d->end());
        }
    }

    // The request route accepted, and the config, give the serve context: the address, the conditional state and
    // what a miss means there. No request: the address is unknown (no synthesis, an uncacheable 404), as before.
    const ServingConfig* cfg_ptr = invocation_serving_config();
    if (!cfg_ptr) {
        plugin_set_error("invalid-config-frame", "the config frame is not a ModuleConfig (MCFG).");
        return 400;
    }
    std::string context;
    {
        bool present = false;
        const sdn::http::HttpRequest* request = htq_input("context", &present);
        if (present && !request) {
            plugin_set_error("invalid-context-frame", "the context frame is not a $HTQ HttpRequest.");
            return 400;
        }
        std::string rest;
        uint32_t z = 0, x = 0, y = 0;
        if (request && mount_rest_of(*cfg_ptr, request, &rest) && parse_tile_path(rest, &z, &x, &y)) {
            context = serve_context_for(*cfg_ptr, z, x, y, negotiation_of(request));
        }
    }


    // Walk the aligned size-prefixed stream, exactly as foundation/omm-json
    // does: zero-length prefixes are alignment padding; frames verify with
    // the size-prefixed accessors first (the store's wire contract counts the
    // 4-byte prefix in internal alignment), plain-anchored as the fallback.
    // ── THE RECORD MUST BE THE RECORD THAT WAS ASKED FOR ────────────────────
    //
    // respond used to serve the FIRST decodable $DTT frame the stream handed
    // it, without ever comparing the record's own LEVEL/X/Y to the address in
    // the serve context. Measured on the shipped module and the real store:
    // GET /api/v1/terrain/11/2155/1530.terrain answered with 13/8632/6112's
    // record returned 200 with that tile's bytes and its strong ETag, cached
    // publicly for a day under the wrong address.
    //
    // Under correct host operation route() builds the query with typed params
    // from a parser that admits nothing but canonical decimals, so the sibling
    // query node cannot return a foreign address — which is exactly why this
    // was invisible. But the binding from an address to its bytes then rests
    // ENTIRELY on that one node, and any record that reaches the store
    // mislabelled (a cross-batch ingest, a re-cut published under a stale plan,
    // a partial replay) is served as the canonical tile for an address it is
    // not. Two integer comparisons close it, so they are made here, on the
    // response side, where the claim is actually published. Coordinator
    // resolution 2026-08-27 (3).
    //
    // A mismatch is SKIPPED, not fatal: the stream may legitimately carry more
    // than one frame, and skipping falls through to the same
    // synthesize-or-404 path an empty stream takes, which is the fail-safe
    // answer. It is counted so it cannot be silent.
    const double want_level = json_number(context, "level", -1);
    const double want_x = json_number(context, "x", -1);
    const double want_y = json_number(context, "y", -1);
    const std::string want_tileset = json_string(context, "tilesetId", "");
    const bool address_known = want_level >= 0 && want_x >= 0 && want_y >= 0;

    const uint8_t* data = stream_bytes.data();
    const size_t length = stream_bytes.size();
    std::vector<uint8_t> scratch;
    const DTT* record = nullptr;
    uint32_t address_mismatches = 0;
    size_t offset = 0;
    while (offset < length && !record) {
        if (length - offset < 4) {
            plugin_set_error("malformed-stream",
                             "trailing bytes after the last size-prefixed $DTT frame.");
            return 400;
        }
        const uint32_t frame_size = static_cast<uint32_t>(data[offset]) |
                                    (static_cast<uint32_t>(data[offset + 1]) << 8) |
                                    (static_cast<uint32_t>(data[offset + 2]) << 16) |
                                    (static_cast<uint32_t>(data[offset + 3]) << 24);
        offset += 4;
        if (frame_size == 0) continue;
        if (frame_size > length - offset) {
            plugin_set_error("malformed-stream",
                             "size-prefixed $DTT frame overruns the stream payload.");
            return 400;
        }
        scratch.assign(data + offset - 4, data + offset + frame_size);
        offset += frame_size;
        const DTT* candidate = nullptr;
        if (frame_size >= 8) {
            ::flatbuffers::Verifier prefixed(scratch.data(), scratch.size());
            if (VerifySizePrefixedDTTBuffer(prefixed)) {
                candidate = GetSizePrefixedDTT(scratch.data());
            } else {
                scratch.erase(scratch.begin(), scratch.begin() + 4);
                ::flatbuffers::Verifier plain(scratch.data(), scratch.size());
                if (DTTBufferHasIdentifier(scratch.data()) && VerifyDTTBuffer(plain)) {
                    candidate = GetDTT(scratch.data());
                }
            }
        }
        if (!candidate) {
            plugin_set_error("invalid-dtt-frame",
                             "stream frame is not a valid $DTT FlatBuffer.");
            return 400;
        }
        if (address_known) {
            const bool same_address =
                static_cast<double>(candidate->LEVEL()) == want_level &&
                static_cast<double>(candidate->X()) == want_x &&
                static_cast<double>(candidate->Y()) == want_y;
            // The tileset is only compared when BOTH sides state one: a store
            // whose records predate TILESET_ID must not become unservable.
            const std::string record_tileset =
                candidate->TILESET_ID() ? candidate->TILESET_ID()->str() : std::string();
            const bool same_tileset = want_tileset.empty() || record_tileset.empty() ||
                                      record_tileset == want_tileset;
            if (!same_address || !same_tileset) {
                address_mismatches++;
                continue;  // scratch is reused; `record` is still null
            }
        }
        record = candidate;
    }

    if (!record) {
        // INSIDE the published availability, a miss is not an error and must
        // not be a 404: the client planned its requests against exactly these
        // rectangles. Synthesize it at height 0 so the client gets the terrain
        // the tileset promised rather than a hole and a console full of failed
        // requests.
        //
        // THE MASK IS NOT ASSUMED. route() decides whether this address sits
        // at a level where the store is authoritative (`synthWater`); only
        // there does "promised but not stored" mean "measured all-ocean and
        // skipped". Everywhere else the tile is flat LAND, because fabricated
        // water renders as specular ocean over whatever is really there.
        if (json_bool(context, "insideAvailability", false)) {
            TileJob job;
            job.level = static_cast<uint32_t>(json_number(context, "level", 0));
            job.x = static_cast<uint32_t>(json_number(context, "x", 0));
            job.y = static_cast<uint32_t>(json_number(context, "y", 0));
            TileExtent ext;
            if (!tile_extent(job, &ext)) {
                return push_htr_not_found("address does not exist at this level",
                                          /*cacheable=*/false);
            }
            uint32_t grid = static_cast<uint32_t>(json_number(context, "synthGridSize", 65));
            if (grid < 2 || grid > 255) grid = 65;

            const bool synth_water = json_bool(context, "synthWater", false);
            const bool accepts_gzip = json_bool(context, "acceptsGzip", true);

            // ── THE WORK A 304 THROWS AWAY IS NOT DONE ──────────────────────
            //
            // The mesh encode, the gzip and the sha256 all used to run BEFORE
            // If-None-Match was compared, so a conditional request answered
            // 304 with an empty body cost 0.752 ms of guest CPU for nothing
            // (measured p50, 2,000 warm invokes on the shipped artifact) — an
            // anonymous, unmemoized, request-shaped amplifier.
            //
            // A synthesized tile is a PURE FUNCTION of the address, the grid,
            // the mask verdict and the coding: same inputs, same bytes, every
            // time, because encode_quantized_mesh is deterministic and the
            // heights are all zero by construction. So the last one produced
            // is kept and reused, keyed by exactly those inputs. ONE slot: a
            // client revalidating the tile it just fetched — the shape that
            // makes the 304 worth having — hits it, and a bounded slot cannot
            // grow into a cache that has to be reasoned about. A synthesized
            // tile is far below the 32 KiB per-tile ceiling, so the slot's
            // footprint is bounded by that ceiling and nothing else.
            struct SynthSlot {
                std::string key;
                std::string etag;
                std::vector<uint8_t> body;
                bool gzipped = false;
            };
            static SynthSlot* slot = new SynthSlot();

            const std::string key = std::to_string(job.level) + "/" + std::to_string(job.x) +
                                    "/" + std::to_string(job.y) + "@" + std::to_string(grid) +
                                    (synth_water ? "w" : "l") + (accepts_gzip ? "z" : "i");
            if (slot->key != key) {
                std::vector<uint8_t> mesh;
                encode_quantized_mesh(job, grid, ext, std::vector<double>(grid * grid, 0.0),
                                      std::vector<uint8_t>(), synth_water, &mesh);
                // The BODY is decided before the ETag, because a strong ETag
                // names one representation: the gzipped and the identity forms
                // of this tile are two, and giving them one tag would let a
                // cache holding the wrong variant answer a revalidation with
                // 304.
                std::vector<uint8_t> body;
                const bool gzipped = accepts_gzip && gzip_compress(mesh, &body);
                if (!gzipped) body = mesh;
                slot->etag = "\"" + sha256_multihash(body) + "\"";
                slot->body.swap(body);
                slot->gzipped = gzipped;
                slot->key = key;
            }
            const std::string& synth_etag = slot->etag;
            const bool gzipped = slot->gzipped;

            std::vector<HeaderEntry> headers;
            headers.push_back({"cache-control", "public, max-age=86400"});
            headers.push_back({"etag", synth_etag});
            headers.push_back({"vary", "accept-encoding"});
            const std::string inm = json_string(context, "ifNoneMatch", "");
            if (!inm.empty() && inm == synth_etag) return push_htr(304, headers, nullptr, 0);
            headers.push_back({"content-type", "application/vnd.quantized-mesh"});
            headers.push_back({"x-content-type-options", "nosniff"});
            if (gzipped) headers.push_back({"content-encoding", "gzip"});
            // Says WHY these bytes exist. A synthesized ocean tile and a
            // measured one are not the same claim, and a cache, a proxy or a
            // person reading the wire is entitled to know which this is.
            headers.push_back(
                {"x-terrain-synthesized", synth_water ? "uniform-water" : "uniform-land"});
            return push_htr(200, headers, slot->body.data(), slot->body.size());
        }
        std::string detail = address_mismatches
                                 ? "no stored tile at this address (" +
                                       std::to_string(address_mismatches) +
                                       " record(s) in the stream are labelled with another "
                                       "address and were not served)"
                                 : std::string("no stored tile at this address");
        if (!context.empty()) {
            detail += " (" + json_string(context, "tilesetId", "?") + " " +
                      fmt_double(json_number(context, "level", -1)) + "/" +
                      fmt_double(json_number(context, "x", -1)) + "/" +
                      fmt_double(json_number(context, "y", -1)) + ")";
        }
        // THE ONE CACHEABLE MISS: a canonical address that exists at its
        // level, inside the tileset's depth, that the store does not hold and
        // availability never promised. Nobody was promised it, the key family
        // is the pyramid's own address space, and a client that asks twice
        // should not cost two store queries.
        //
        // THE DEPTH IS THE TILESET'S, NOT A CONSTANT. This read `miss_level <=
        // 30`, which is not "inside the tileset's own depth" — it is 31 levels
        // of address space regardless of how deep the pyramid goes, and level
        // 30 alone is ~2.3e18 addresses. At the ruled ship configuration
        // (maxzoom 13) levels 14..30 were outside the tileset and still
        // answered `public, max-age=300` with the address echoed into a
        // distinct body: a cacheable key family a caller could type, which is
        // exactly what the rule above forbids. route() carries the tileset's
        // maxzoom in the context; ABSENT IT FAILS CLOSED (no-store), because a
        // context that cannot state the depth cannot show the address is
        // inside it.
        const double max_level = json_number(context, "maxLevel", -1);
        const uint32_t miss_level = static_cast<uint32_t>(json_number(context, "level", 0));
        const double miss_x = json_number(context, "x", -1);
        const double miss_y = json_number(context, "y", -1);
        const bool real_address =
            !context.empty() && max_level >= 0 &&
            static_cast<double>(miss_level) <= max_level && miss_level <= 30 &&
            miss_x >= 0 && miss_y >= 0 &&
            miss_x < static_cast<double>(1ull << (miss_level + 1)) &&
            miss_y < static_cast<double>(1ull << miss_level);
        return push_htr_not_found(detail, real_address);
    }

    const DTTPayloadRef* payload = record->PAYLOAD();
    if (!payload || !payload->BYTES() || payload->BYTES()->size() == 0) {
        // A CID-only record cannot be served inline yet: the dataset-lane
        // fetch is the growth path. Refusing loudly beats serving an empty
        // tile that renders as a hole at sea level.
        plugin_set_error("payload-not-inline",
                         "the stored $DTT record carries no inline BYTES (CID-only); the "
                         "CID resolution lane is not built and a 200 with an empty body "
                         "would render as fabricated terrain.");
        return 500;
    }

    // ETag precedence: the record's own ETAG verbatim; else the payload
    // DIGEST quoted strong; else a weak address+size tag (changes whenever
    // the stored bytes change size — honest, if coarse).
    std::string etag = record->ETAG() ? record->ETAG()->str() : "";
    if (etag.empty() && payload->DIGEST() && payload->DIGEST()->size() > 0) {
        etag = "\"" + payload->DIGEST()->str() + "\"";
    }
    if (etag.empty()) {
        etag = "W/\"dtt-" + std::to_string(record->LEVEL()) + "-" +
               std::to_string(record->X()) + "-" + std::to_string(record->Y()) + "-" +
               std::to_string(payload->BYTES()->size()) + "\"";
    }

    // ── THE REPRESENTATION IS DECIDED BEFORE THE ETAG ───────────────────────
    //
    // The client stated whether it accepts gzip; the stored bytes are gzipped.
    // Serving them to a client that refused the coding is the defect the
    // unconditional `content-encoding: gzip` had, and so is serving two
    // different byte strings under ONE strong ETag, which is what any fix that
    // kept the record's tag for both variants would do — a shared cache
    // holding one variant would answer the other's revalidation with 304.
    const std::string stored_encoding =
        payload->CONTENT_ENCODING() ? payload->CONTENT_ENCODING()->str() : "";
    const bool accepts_gzip = json_bool(context, "acceptsGzip", true);
    if (record->TILING_SCHEME() == dttTilingScheme_GEOGRAPHIC_TWO_ROOT_BODY && stored_encoding != kEdgeMatchedPlanes) {
        plugin_set_error("unsupported-body-encoding", "body records require qm-edge-matched-planes-v1.");
        return 400;
    }
    const bool planes = stored_encoding == kEdgeMatchedPlanes;
    const bool serve_identity = (stored_encoding == "gzip" || planes) && !accepts_gzip;
    if (serve_identity) {
        // ── THE IDENTITY TAG IS DERIVED, NOT RE-HASHED ──────────────────────
        //
        // This used to inflate the stored bytes and sha256 the result BEFORE
        // comparing If-None-Match — so a conditional request that was going to
        // be answered 304 with an empty body still paid the full inflate and
        // hash. Measured p50 on the shipped artifact over 2,000 warm invokes:
        // 0.413 ms for zero bytes out, against 0.075 ms for the gzip 304.
        //
        // gunzip is deterministic, so the identity bytes are a pure FUNCTION of
        // the stored bytes: naming them by the stored representation's own tag
        // under a distinguishing prefix is exact — two identity bodies share a
        // tag exactly when their gzip forms are byte-identical, which is when
        // they are the same bytes — and it is computable without inflating
        // anything. The prefix is what keeps the two representations apart, so
        // a shared cache holding the gzipped variant can never answer the
        // identity variant's revalidation with a 304.
        // The weak form stays weak and the strong form stays strong; only the
        // opaque part is renamed, so validator strength survives the derivation.
        const bool weak = etag.compare(0, 2, "W/") == 0;
        const size_t open_quote = etag.find('"');
        const std::string opaque =
            open_quote == std::string::npos || etag.size() < open_quote + 2
                ? etag
                : etag.substr(open_quote + 1, etag.size() - open_quote - 2);
        etag = (weak ? std::string("W/\"") : std::string("\"")) + "identity-" + opaque + "\"";
    }

    const std::string if_none_match = json_string(context, "ifNoneMatch", "");
    std::vector<HeaderEntry> headers;
    headers.push_back({"cache-control", "public, max-age=86400"});
    headers.push_back({"etag", etag});
    // The body's encoding depends on a REQUEST header, so the cache key has to
    // say so — on the 304 as well as the 200.
    headers.push_back({"vary", "accept-encoding"});
    if (!if_none_match.empty() && if_none_match == etag) {
        return push_htr(304, headers, nullptr, 0);
    }
    headers.push_back({"content-type", payload->MEDIA_TYPE() && payload->MEDIA_TYPE()->size()
                                           ? payload->MEDIA_TYPE()->str()
                                           : "application/vnd.quantized-mesh"});
    headers.push_back({"x-content-type-options", "nosniff"});
    if (planes) {
        std::vector<uint8_t> qm, encoded;
        if (!decode_edge_matched_planes(payload->BYTES()->data(), payload->BYTES()->size(), &qm) ||
            (accepts_gzip && !gzip_compress(qm, &encoded))) {
            plugin_set_error("stored-encoding-undecodable", "the stored edge-matched planes payload could not be reconstructed.");
            return 500;
        }
        if (accepts_gzip) {
            headers.push_back({"content-encoding", "gzip"});
            return push_htr(200, headers, encoded.data(), encoded.size());
        }
        return push_htr(200, headers, qm.data(), qm.size());
    }
    if (serve_identity) {
        // Only now, on a body that is actually going to be sent.
        std::vector<uint8_t> identity;
        if (!gzip_decompress(payload->BYTES()->data(), payload->BYTES()->size(), &identity)) {
            plugin_set_error("stored-encoding-undecodable",
                             "the stored tile is gzipped, the request refused gzip, and the "
                             "stored bytes did not decode; serving them anyway would send a "
                             "coding the client stated it cannot read.");
            return 500;
        }
        return push_htr(200, headers, identity.data(), identity.size());
    }
    if (!stored_encoding.empty()) headers.push_back({"content-encoding", stored_encoding});
    return push_htr(200, headers, payload->BYTES()->data(), payload->BYTES()->size());
}

// ---------------------------------------------------------------------------
// pack - a $DTT record stream -> the lane's published FILES.
//
// A body's tileset is published as files, one $PNM each, fetched by CID (the
// console reads them over SDN; there is no tile server for a body). The tiles
// are grouped so a client fetches a few files, not tens of thousands of tiles:
//   <prefix>/root.dtts.gz          every tile at level <= rootMaxLevel (default 2:
//                               2 + 8 + 32 = 42 tiles)
//   <prefix>/<L>/<X>_<Y>.dtts.gz   one 4x4 block of same-level tiles, X = x >> 2,
//                               Y = y >> 2 (row 0 at the SOUTH, as the tiles)
// Each file is gzip of a size-prefixed $DTT stream - [u32 LE length][record] per
// tile, ordered by (level, y, x) - so no new format exists: a reader walks it
// after inflation. Records are copied byte for byte before whole-file compression.
//
// One "file" frame per file, the file's bytes (itself a $DTT stream, so the
// frame is typed $DTT like every record stream of this lane), and ONE "names"
// frame: a size-prefixed $PNM stream whose k-th record's FILE_NAME names the
// k-th file - the IPFS adapter adds each file and completes its $PNM with the
// CID. The planner hands pack WHOLE blocks (a block's tiles never span two
// plans), so a file is complete when it is emitted.
// ---------------------------------------------------------------------------
int pack(void) {
    if (plugin_get_input_count() > 2) {
        plugin_set_error("batched-input-frames", "pack takes one records stream and at most one options frame.");
        return 500;
    }
    const int32_t records_index = plugin_find_input_index("records", 0);
    const plugin_input_frame_t* records =
        records_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(records_index)) : nullptr;
    if (!records || !records->payload) {
        plugin_set_error("missing-records-frame", "pack needs the $DTT record stream on port \"records\".");
        return 400;
    }
    std::string options = "{}";
    if (const int32_t oi = plugin_find_input_index("options", 0); oi >= 0) {
        const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(oi));
        bool ok = false;
        options = module_config_object(f->payload, f->payload_length, &ok);
        if (!ok) {
            plugin_set_error("invalid-options-frame", "the options frame is not a ModuleConfig (MCFG).");
            return 400;
        }
    }
    const std::string prefix = json_string(options, "pathPrefix", "");
    bool prefix_ok = !prefix.empty() && prefix.size() <= 64 && prefix.front() != '/' && prefix.back() != '/';
    for (const char c : prefix)
        if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '/' || c == '-' || c == '_' || c == '.')) prefix_ok = false;
    if (!prefix_ok || prefix.find("..") != std::string::npos) {
        plugin_set_error("bad-path-prefix",
                         "pack needs options.pathPrefix: a relative path of letters, digits, '-', '_', '.' and '/' "
                         "(no leading or trailing '/', no '..'), at most 64 characters.");
        return 400;
    }
    const double root_raw = json_number(options, "rootMaxLevel", 2);
    if (!(root_raw >= 0 && root_raw <= 4) || root_raw != std::floor(root_raw)) {
        plugin_set_error("bad-root-level", "options.rootMaxLevel must be a whole number in [0, 4].");
        return 400;
    }
    const uint32_t root_max = static_cast<uint32_t>(root_raw);

    struct Entry {
        uint32_t level, x, y;
        size_t at, size;
        std::string file;
    };
    std::vector<Entry> entries;
    std::string tileset;
    const uint8_t* data = records->payload;
    const size_t length = records->payload_length;
    for (size_t at = 0; at < length;) {
        if (length - at < 4) {
            plugin_set_error("invalid-records-frame", "the record stream ends inside a size prefix.");
            return 400;
        }
        const uint32_t size = static_cast<uint32_t>(data[at]) | (static_cast<uint32_t>(data[at + 1]) << 8) |
                              (static_cast<uint32_t>(data[at + 2]) << 16) | (static_cast<uint32_t>(data[at + 3]) << 24);
        at += 4;
        if (size == 0) continue;  // the "no records here" frame and alignment padding
        if (size > length - at) {
            plugin_set_error("invalid-records-frame", "a record's size prefix runs past the stream.");
            return 400;
        }
        ::flatbuffers::Verifier verifier(data + at, size);
        if (!DTTBufferHasIdentifier(data + at) || !VerifyDTTBuffer(verifier)) {
            plugin_set_error("invalid-records-frame", "a record of the stream is not a valid $DTT.");
            return 400;
        }
        const DTT* t = GetDTT(data + at);
        const std::string id = t->TILESET_ID() ? t->TILESET_ID()->str() : std::string();
        if (tileset.empty()) tileset = id;
        if (id.empty() || id != tileset) {
            plugin_set_error("mixed-tileset-records", "every record packed together must name the same TILESET_ID.");
            return 400;
        }
        if (t->TILING_SCHEME() == dttTilingScheme_GEOGRAPHIC_TWO_ROOT_BODY &&
            (!t->PAYLOAD() || parent_string(t->PAYLOAD()->CONTENT_ENCODING()) != kEdgeMatchedPlanes)) {
            plugin_set_error("unsupported-body-encoding", "body records require qm-edge-matched-planes-v1.");
            return 400;
        }
        Entry e{t->LEVEL(), t->X(), t->Y(), at, size, std::string()};
        e.file = e.level <= root_max ? prefix + "/root.dtts.gz"
                                     : prefix + "/" + std::to_string(e.level) + "/" + std::to_string(e.x >> 2) + "_" +
                                           std::to_string(e.y >> 2) + ".dtts.gz";
        entries.push_back(std::move(e));
        at += size;
    }
    std::sort(entries.begin(), entries.end(), [](const Entry& a, const Entry& b) {
        if (a.file != b.file) return a.file < b.file;
        if (a.level != b.level) return a.level < b.level;
        if (a.y != b.y) return a.y < b.y;
        return a.x < b.x;
    });
    for (size_t i = 1; i < entries.size(); i++) {
        if (entries[i].level == entries[i - 1].level && entries[i].x == entries[i - 1].x &&
            entries[i].y == entries[i - 1].y) {
            plugin_set_error("duplicate-tile-address", "the record stream carries one tile address twice.");
            return 400;
        }
    }
    uint32_t files = 0;
    std::vector<uint8_t> names;
    for (size_t i = 0; i < entries.size();) {
        size_t j = i;
        std::vector<uint8_t> frame;
        const std::string& name = entries[i].file;
        for (; j < entries.size() && entries[j].file == name; j++) {
            put_u32(&frame, static_cast<uint32_t>(entries[j].size));
            frame.insert(frame.end(), data + entries[j].at, data + entries[j].at + entries[j].size);
        }
        if (++files > 64) {
            plugin_set_error("too-many-files", "one plan packs into at most 64 files (the adapter's frame budget).");
            return 413;
        }
        std::vector<uint8_t> compressed;
        if (!gzip_compress(frame, &compressed)) {
            plugin_set_error("pack-compression-failed", "the complete DTT file could not be gzipped.");
            return 500;
        }
        if (push_dtt_stream("file", compressed) < 0) return 500;
        flatbuffers::FlatBufferBuilder b(128 + name.size());
        const auto file_name = b.CreateString(name);
        PNMBuilder pb(b);
        pb.add_FILE_NAME(file_name);
        FinishSizePrefixedPNMBuffer(b, pb.Finish());
        names.insert(names.end(), b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
        i = j;
    }
    if (files == 0) {
        plugin_set_error("empty-records-frame", "pack was handed no records, so there is no file to write.");
        return 400;
    }
    return plugin_push_output_ex("names", "PNM.fbs", "$PNM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "PNM", 0, 0,
                                 names.data(), static_cast<uint32_t>(names.size())) < 0
               ? 500
               : 0;
}

}  // extern "C"
