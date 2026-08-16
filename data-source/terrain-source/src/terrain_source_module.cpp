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

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

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
// `modules-guest-nodes-drop-batched-frames`). The "dem" port legitimately
// carries up to FOUR frames — the corner granules of a granule-spanning tile —
// so its budget is 4; every other port is single-stream by contract.
uint32_t port_stream_budget(const char* port_id) {
    return std::strcmp(port_id, "dem") == 0 ? 4u : 1u;
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

struct DemGrid {
    uint32_t width = 0;
    uint32_t height = 0;
    std::vector<float> samples;  // row-major from the top-left pixel
    // Georeference: geographic coordinate of pixel (0,0), degree per pixel.
    double origin_lon = 0.0;
    double origin_lat = 0.0;
    double scale_lon = 0.0;  // positive eastward
    double scale_lat = 0.0;  // positive (subtracted going south)
    bool ok = false;
    std::string error;
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

DemGrid decode_geotiff(const std::string& body) {
    DemGrid g;
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
    auto value_base = [&](const TiffTag& t) -> size_t {
        return t.value_inline ? static_cast<size_t>(t.value_or_offset)
                              : static_cast<size_t>(t.value_or_offset);
    };
    auto read_uint = [&](const TiffTag& t, uint64_t index, uint64_t* out) -> bool {
        const size_t esz = tiff_type_size(t.type);
        if (esz == 0 || index >= t.count) return false;
        const size_t at = value_base(t) + index * esz;
        if (at + esz > body.size()) return false;
        if (t.type == 3) *out = rd16(body, at);
        else if (t.type == 4) *out = rd32(body, at);
        else if (t.type == 16) *out = rd64(body, at);
        else return false;
        return true;
    };
    auto read_double = [&](const TiffTag& t, uint64_t index, double* out) -> bool {
        if (t.type != 12 || index >= t.count) return false;
        const size_t at = value_base(t) + index * 8;
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
    const uint64_t bits = uint_of(258, 1);
    const uint64_t compression = uint_of(259, 1);
    const uint64_t samples_per_pixel = uint_of(277, 1);
    const uint64_t predictor = uint_of(317, 1);
    const uint64_t sample_format = uint_of(339, 1);

    if (width == 0 || height == 0 || width > 20000 || height > 20000) {
        g.error = "missing or implausible ImageWidth/ImageLength";
        return g;
    }
    if (bits != 32 || sample_format != 3 || samples_per_pixel != 1) {
        g.error = "granule is not single-band Float32 (BitsPerSample 32, SampleFormat 3); "
                  "an unmodelled sample layout is refused, never reinterpreted";
        return g;
    }
    if (compression != 1 && compression != 8) {
        g.error = "granule compression is neither none (1) nor DEFLATE (8)";
        return g;
    }
    if (predictor != 1 && predictor != 3) {
        g.error = "granule predictor is neither none (1) nor floating-point (3)";
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
    g.origin_lon = tp_x - tp_i * sx;
    g.origin_lat = tp_y + tp_j * sy;
    g.scale_lon = sx;
    g.scale_lat = sy;

    // ── decode chunks (tiles or strips) into the full raster ────────────────
    g.width = static_cast<uint32_t>(width);
    g.height = static_cast<uint32_t>(height);
    g.samples.assign(static_cast<size_t>(width) * height, 0.0f);

    const TiffTag* tile_offsets = find_tag(324);
    const TiffTag* tile_counts = find_tag(325);
    const TiffTag* strip_offsets = find_tag(273);
    const TiffTag* strip_counts = find_tag(279);

    auto decode_chunk = [&](size_t at, size_t len, uint32_t chunk_w, uint32_t chunk_rows,
                            std::vector<uint8_t>* out) -> bool {
        if (at + len > body.size()) return false;
        const size_t expect = static_cast<size_t>(chunk_w) * chunk_rows * 4;
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
        if (predictor == 3 && !undo_predictor3(out, chunk_w, chunk_rows)) return false;
        return true;
    };

    std::vector<uint8_t> chunk;
    if (tile_offsets && tile_counts) {
        const uint64_t tw = uint_of(322, 0);
        const uint64_t th = uint_of(323, 0);
        if (tw == 0 || th == 0) { g.error = "tiled layout without TileWidth/TileLength"; return g; }
        const uint64_t across = (width + tw - 1) / tw;
        const uint64_t down = (height + th - 1) / th;
        for (uint64_t ty = 0; ty < down; ty++) {
            for (uint64_t tx = 0; tx < across; tx++) {
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
                const uint64_t copy_w = std::min<uint64_t>(tw, width - tx * tw);
                const uint64_t copy_h = std::min<uint64_t>(th, height - ty * th);
                for (uint64_t r = 0; r < copy_h; r++) {
                    std::memcpy(&g.samples[(ty * th + r) * width + tx * tw],
                                &chunk[static_cast<size_t>(r) * tw * 4],
                                static_cast<size_t>(copy_w) * 4);
                }
            }
        }
    } else if (strip_offsets && strip_counts) {
        const uint64_t rows_per_strip = uint_of(278, height);
        const uint64_t strips = (height + rows_per_strip - 1) / rows_per_strip;
        for (uint64_t s = 0; s < strips; s++) {
            uint64_t at = 0, len = 0;
            if (!read_uint(*strip_offsets, s, &at) || !read_uint(*strip_counts, s, &len)) {
                g.error = "strip offset/count tables shorter than the strip count";
                return g;
            }
            const uint64_t rows = std::min<uint64_t>(rows_per_strip, height - s * rows_per_strip);
            if (!decode_chunk(static_cast<size_t>(at), static_cast<size_t>(len),
                              static_cast<uint32_t>(width), static_cast<uint32_t>(rows), &chunk)) {
                g.error = "a strip failed to inflate; a partial raster is refused";
                return g;
            }
            std::memcpy(&g.samples[s * rows_per_strip * width], chunk.data(),
                        static_cast<size_t>(rows) * width * 4);
        }
    } else {
        g.error = "granule has neither tile nor strip layout tables";
        return g;
    }

    g.ok = true;
    return g;
}

// ── DEM sampling ───────────────────────────────────────────────────────────

constexpr float kNoData = -32767.0f;

// Bilinear sample of one granule at a geographic position; false when the
// position lies outside the granule. NO_DATA corners poison the sample.
bool sample_granule(const DemGrid& g, double lon, double lat, double* out, bool* nodata) {
    const double px = (lon - g.origin_lon) / g.scale_lon;
    const double py = (g.origin_lat - lat) / g.scale_lat;
    if (px < -0.5 || py < -0.5 || px > g.width - 0.5 || py > g.height - 0.5) return false;
    const double cx = std::min(std::max(px, 0.0), static_cast<double>(g.width - 1));
    const double cy = std::min(std::max(py, 0.0), static_cast<double>(g.height - 1));
    const uint32_t x0 = static_cast<uint32_t>(cx);
    const uint32_t y0 = static_cast<uint32_t>(cy);
    const uint32_t x1 = std::min(x0 + 1, g.width - 1);
    const uint32_t y1 = std::min(y0 + 1, g.height - 1);
    const double fx = cx - x0;
    const double fy = cy - y0;
    const float s00 = g.samples[static_cast<size_t>(y0) * g.width + x0];
    const float s10 = g.samples[static_cast<size_t>(y0) * g.width + x1];
    const float s01 = g.samples[static_cast<size_t>(y1) * g.width + x0];
    const float s11 = g.samples[static_cast<size_t>(y1) * g.width + x1];
    if (s00 == kNoData || s10 == kNoData || s01 == kNoData || s11 == kNoData) {
        *nodata = true;
        *out = 0.0;
        return true;
    }
    *nodata = false;
    *out = (1 - fy) * ((1 - fx) * s00 + fx * s10) + fy * ((1 - fx) * s01 + fx * s11);
    return true;
}

// ── WGS 84 / quantized-mesh math ───────────────────────────────────────────

constexpr double kPi = 3.14159265358979323846;
constexpr double kSemiMajor = 6378137.0;
constexpr double kSemiMinor = 6356752.3142451793;

struct Vec3 {
    double x = 0, y = 0, z = 0;
};

Vec3 geodetic_to_ecef(double lat_deg, double lon_deg, double height_m) {
    const double lat = lat_deg * kPi / 180.0;
    const double lon = lon_deg * kPi / 180.0;
    const double e2 = 1.0 - (kSemiMinor * kSemiMinor) / (kSemiMajor * kSemiMajor);
    const double sin_lat = std::sin(lat);
    const double n = kSemiMajor / std::sqrt(1.0 - e2 * sin_lat * sin_lat);
    Vec3 v;
    v.x = (n + height_m) * std::cos(lat) * std::cos(lon);
    v.y = (n + height_m) * std::cos(lat) * std::sin(lon);
    v.z = (n * (1.0 - e2) + height_m) * sin_lat;
    return v;
}

// Horizon occlusion point per the quantized-mesh spec (Cesium's
// EllipsoidalOccluder.computeHorizonCullingPoint): work in ellipsoid-scaled
// space, take the max occlusion magnitude along the scaled direction to the
// tile centre over every vertex, and unscale.
Vec3 horizon_occlusion_point(const std::vector<Vec3>& positions, const Vec3& center) {
    Vec3 scaled_center{center.x / kSemiMajor, center.y / kSemiMajor, center.z / kSemiMinor};
    const double c_mag =
        std::sqrt(scaled_center.x * scaled_center.x + scaled_center.y * scaled_center.y +
                  scaled_center.z * scaled_center.z);
    Vec3 dir{0, 0, 1};
    if (c_mag > 0) dir = {scaled_center.x / c_mag, scaled_center.y / c_mag, scaled_center.z / c_mag};
    double max_magnitude = 0.0;
    for (const Vec3& p : positions) {
        Vec3 sp{p.x / kSemiMajor, p.y / kSemiMajor, p.z / kSemiMinor};
        double mag_sq = sp.x * sp.x + sp.y * sp.y + sp.z * sp.z;
        double mag = std::sqrt(mag_sq);
        Vec3 unit = mag > 0 ? Vec3{sp.x / mag, sp.y / mag, sp.z / mag} : Vec3{0, 0, 0};
        mag_sq = std::max(1.0, mag_sq);
        mag = std::max(1.0, mag);
        const double cos_alpha = unit.x * dir.x + unit.y * dir.y + unit.z * dir.z;
        const Vec3 cross{unit.y * dir.z - unit.z * dir.y, unit.z * dir.x - unit.x * dir.z,
                         unit.x * dir.y - unit.y * dir.x};
        const double sin_alpha =
            std::sqrt(cross.x * cross.x + cross.y * cross.y + cross.z * cross.z);
        const double cos_beta = 1.0 / mag;
        const double sin_beta = std::sqrt(mag_sq - 1.0) * cos_beta;
        const double denom = cos_alpha * cos_beta - sin_alpha * sin_beta;
        if (denom <= 0) continue;  // point occludes the whole horizon direction
        max_magnitude = std::max(max_magnitude, 1.0 / denom);
    }
    return {dir.x * max_magnitude * kSemiMajor, dir.y * max_magnitude * kSemiMajor,
            dir.z * max_magnitude * kSemiMinor};
}

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
    DTTProvenanceBuilder pb(b);
    pb.add_DATASET_ID(p_id);
    pb.add_DATASET_EPOCH(p_epoch);
    pb.add_RETRIEVED_AT(p_retrieved);
    pb.add_LICENSE(p_license);
    if (p_name.o) pb.add_DATASET_NAME(p_name);
    if (p_license_url.o) pb.add_LICENSE_URL(p_license_url);
    if (p_attribution.o) pb.add_ATTRIBUTION(p_attribution);
    if (p_source_url.o) pb.add_SOURCE_URL(p_source_url);
    return pb.Finish();
}

// ── serving lane helpers (route / respond) ─────────────────────────────────

// The sync hostcall bridge, used for exactly ONE operation: plugin.getConfig.
// Same import surface the tests already admit (space_data_module_host) and the
// same precedent geonames-ingest set: reading the flow's host-provided config
// is not a capability, it is the module asking who it was deployed as.
extern "C" {
__attribute__((import_module("space_data_module_host"), import_name("call")))
int32_t sdm_host_call(const uint8_t* op_ptr, int32_t op_len,
                      const uint8_t* payload_ptr, int32_t payload_len);
__attribute__((import_module("space_data_module_host"), import_name("response_len")))
int32_t sdm_host_response_len(void);
__attribute__((import_module("space_data_module_host"), import_name("read_response")))
int32_t sdm_host_read_response(uint8_t* dst_ptr, int32_t dst_len);
}

std::string load_config() {
    static const char* op = "plugin.getConfig";
    const std::string payload_json = "{}";
    std::vector<uint8_t> req(4 + payload_json.size() + 4, 0);
    const uint32_t meta_len = static_cast<uint32_t>(payload_json.size());
    req[0] = static_cast<uint8_t>(meta_len & 0xff);
    req[1] = static_cast<uint8_t>((meta_len >> 8) & 0xff);
    req[2] = static_cast<uint8_t>((meta_len >> 16) & 0xff);
    req[3] = static_cast<uint8_t>((meta_len >> 24) & 0xff);
    std::memcpy(req.data() + 4, payload_json.data(), payload_json.size());
    sdm_host_call(reinterpret_cast<const uint8_t*>(op), static_cast<int32_t>(std::strlen(op)),
                  req.data(), static_cast<int32_t>(req.size()));
    const int32_t len = sdm_host_response_len();
    if (len <= 4) return "{}";
    std::vector<uint8_t> buf(static_cast<size_t>(len));
    sdm_host_read_response(buf.data(), len);
    const uint32_t rlen = static_cast<uint32_t>(buf[0]) | (static_cast<uint32_t>(buf[1]) << 8) |
                          (static_cast<uint32_t>(buf[2]) << 16) |
                          (static_cast<uint32_t>(buf[3]) << 24);
    if (buf.size() < 4u + rlen) return "{}";
    return std::string(reinterpret_cast<const char*>(buf.data() + 4), rlen);
}

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

int push_htr_json(uint16_t status, const std::string& body, const char* cache_control) {
    std::vector<HeaderEntry> headers = {{"content-type", "application/json"}};
    if (cache_control) headers.push_back({"cache-control", cache_control});
    return push_htr(status, headers,
                    reinterpret_cast<const uint8_t*>(body.data()), body.size());
}

// A cheap, honest, CACHEABLE 404: the client's own upsampling relies on
// layer.json availability, so a miss below the published pyramid is normal
// traffic and must never surface as an error or a cache-buster.
int push_htr_not_found(const std::string& detail) {
    return push_htr_json(404,
                         std::string("{\"error\":\"not found\",\"detail\":\"") +
                             json_escape(detail) + "\"}",
                         "public, max-age=300");
}

// Parse "<z>/<x>/<y>.terrain" (all decimal, nothing else) after the mount.
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

constexpr const char* kGeoidRemark =
    "Heights are geoid-referenced as the source dataset publishes them (VERTICAL_DATUM "
    "GEOID); no geoid-to-ellipsoid conversion is applied at this parity floor. A consumer "
    "rendering them as above-ellipsoid accepts a bounded (<~100 m) vertical offset.";

}  // namespace

extern "C" {

// ---------------------------------------------------------------------------
// tile — DEM granule responses + plan -> one $DTT record (quantized-mesh
// payload inline) + report.
// ---------------------------------------------------------------------------
int tile(void) {
    if (refuse_batched()) return 500;

    const std::string plan = input_text("plan");
    if (plan.empty()) {
        plugin_set_error("missing-plan-frame", "tile requires the plan frame on port \"plan\".");
        return 400;
    }

    std::string provenance_json;
    json_raw_value(plan, "provenance", &provenance_json);
    const DatasetContract contract = contract_of(provenance_json);
    if (!contract.complete()) {
        plugin_set_error("incomplete-dataset-contract",
                         "DTTProvenance requires DATASET_ID, DATASET_EPOCH, RETRIEVED_AT and "
                         "LICENSE on every record. The plan frame supplies them verbatim and "
                         "they are never defaulted: a tile published under a guessed epoch is "
                         "comparable to the wrong bytes.");
        return 400;
    }

    const std::string tileset_id = json_string(plan, "tilesetId", "");
    if (tileset_id.empty()) {
        plugin_set_error("missing-tileset-id", "the plan frame must state tilesetId.");
        return 400;
    }
    const uint32_t level = static_cast<uint32_t>(json_number(plan, "level", 0));
    const uint32_t tx = static_cast<uint32_t>(json_number(plan, "x", 0));
    const uint32_t ty = static_cast<uint32_t>(json_number(plan, "y", 0));
    const uint32_t grid = static_cast<uint32_t>(json_number(plan, "gridSize", 65));
    const uint32_t max_level = static_cast<uint32_t>(json_number(plan, "maxLevel", 0));
    const uint32_t child_availability =
        static_cast<uint32_t>(json_number(plan, "childAvailability", 0));
    if (grid < 2 || grid > 255) {
        plugin_set_error("bad-grid-size", "gridSize must lie in [2, 255].");
        return 400;
    }
    if (json_bool(plan, "rowOriginNorth", false)) {
        plugin_set_error("unsupported-row-origin",
                         "this encoder addresses the GEOGRAPHIC_WGS84 pyramid with a TMS "
                         "(south) row origin only; rowOriginNorth true is refused rather "
                         "than silently flipped.");
        return 400;
    }
    const std::string scheme = json_string(plan, "scheme", "GEOGRAPHIC_WGS84");
    if (scheme != "GEOGRAPHIC_WGS84") {
        plugin_set_error("unsupported-scheme",
                         "only the GEOGRAPHIC_WGS84 two-root scheme is modelled.");
        return 400;
    }

    // GEOGRAPHIC_WGS84: level z has 2^(z+1) x 2^z tiles of (180/2^z) degrees,
    // row 0 at the SOUTH edge (TMS).
    const double span = 180.0 / static_cast<double>(1u << level);
    const uint32_t tiles_x = 2u << level;
    const uint32_t tiles_y = 1u << level;
    if (tx >= tiles_x || ty >= tiles_y) {
        plugin_set_error("tile-address-out-of-range",
                         "the x/y address does not exist at this level of the two-root "
                         "geographic pyramid.");
        return 400;
    }
    const double west = -180.0 + tx * span;
    const double east = west + span;
    const double south = -90.0 + ty * span;
    const double north = south + span;

    // ── decode every granule frame ──────────────────────────────────────────
    std::vector<DemGrid> granules;
    uint32_t responses = 0, absent_granules = 0;
    for (uint32_t ordinal = 0; ordinal < 4; ordinal++) {
        const std::string response = input_text_at("dem", ordinal);
        if (response.empty()) break;
        responses++;
        const long status = response_status(response);
        // 404 = the dataset publishes no granule here (open ocean). That is
        // DATA — sea level — not a failure.
        if (status == 404) { absent_granules++; continue; }
        if (status != 0 && (status < 200 || status >= 300)) {
            char message[192];
            std::snprintf(message, sizeof(message),
                          "a DEM granule fetch answered HTTP %ld; a failed fetch and open "
                          "ocean are not the same observation, so this is refused rather "
                          "than encoded as sea level.",
                          status);
            plugin_set_error("upstream-status", message);
            return 502;
        }
        DemGrid g = decode_geotiff(response_body(response));
        if (!g.ok) {
            plugin_set_error("geotiff-undecodable", g.error.c_str());
            return 422;
        }
        granules.push_back(std::move(g));
    }
    if (responses == 0) {
        plugin_set_error("missing-dem-frame",
                         "tile requires at least one granule response frame on port \"dem\".");
        return 400;
    }
    const bool all_ocean = granules.empty();

    // ── sample the post lattice ─────────────────────────────────────────────
    const uint32_t n_verts = grid * grid;
    std::vector<double> heights(n_verts, 0.0);
    std::vector<double> lats(n_verts), lons(n_verts);
    uint64_t nodata_count = 0, uncovered_count = 0;
    for (uint32_t j = 0; j < grid; j++) {  // j = 0 at the SOUTH edge
        const double lat = south + (north - south) * j / (grid - 1);
        for (uint32_t i = 0; i < grid; i++) {
            const double lon = west + (east - west) * i / (grid - 1);
            const uint32_t v = j * grid + i;
            lats[v] = lat;
            lons[v] = lon;
            double h = 0.0;
            bool nodata = false;
            bool covered = false;
            for (const DemGrid& g : granules) {
                if (sample_granule(g, lon, lat, &h, &nodata)) { covered = true; break; }
            }
            if (!covered) {
                uncovered_count++;
                h = 0.0;  // absent granule ground truth: the dataset states sea level nowhere,
                          // so 0 is used and COUNTED, never presented as a measurement
            } else if (nodata) {
                nodata_count++;
                h = 0.0;
            }
            heights[v] = h;
        }
    }
    double min_h = heights[0], max_h = heights[0];
    for (const double h : heights) {
        min_h = std::min(min_h, h);
        max_h = std::max(max_h, h);
    }
    const double coverage =
        1.0 - static_cast<double>(nodata_count + uncovered_count) / n_verts;

    // ── water mask directive ────────────────────────────────────────────────
    std::string water_json;
    json_raw_value(plan, "waterMask", &water_json);
    std::string water_kind = json_string(water_json, "kind", "");
    std::string water_raster;
    uint32_t water_w = 0, water_h = 0;
    if (water_kind.empty()) {
        // A tile whose every granule is absent is open ocean by the dataset's
        // own publication pattern — unless the plan states otherwise.
        water_kind = all_ocean ? "UNIFORM_WATER" : "UNIFORM_LAND";
    }
    if (water_kind == "RASTER") {
        water_raster = base64_decode(json_string(water_json, "bodyB64", ""));
        water_w = static_cast<uint32_t>(json_number(water_json, "width", 256));
        water_h = static_cast<uint32_t>(json_number(water_json, "height", 256));
        if (water_raster.size() != static_cast<size_t>(water_w) * water_h) {
            plugin_set_error("water-mask-size-mismatch",
                             "the plan's raster water mask does not carry width*height bytes; "
                             "a truncated mask is refused rather than rendered as coastline.");
            return 422;
        }
    } else if (water_kind != "UNIFORM_LAND" && water_kind != "UNIFORM_WATER") {
        plugin_set_error("bad-water-mask-kind",
                         "waterMask.kind must be UNIFORM_LAND, UNIFORM_WATER or RASTER.");
        return 422;
    }

    // ── quantize + triangulate ──────────────────────────────────────────────
    std::vector<uint16_t> qu(n_verts), qv(n_verts), qh(n_verts);
    const double h_range = max_h - min_h;
    for (uint32_t j = 0; j < grid; j++) {
        for (uint32_t i = 0; i < grid; i++) {
            const uint32_t v = j * grid + i;
            qu[v] = static_cast<uint16_t>((32767ull * i) / (grid - 1));
            qv[v] = static_cast<uint16_t>((32767ull * j) / (grid - 1));
            qh[v] = h_range > 0
                        ? static_cast<uint16_t>(
                              std::lround(32767.0 * (heights[v] - min_h) / h_range))
                        : 0;
        }
    }
    // Regular-grid triangulation, CCW in the u-v plane.
    std::vector<uint32_t> indices;
    indices.reserve(static_cast<size_t>(grid - 1) * (grid - 1) * 6);
    for (uint32_t j = 0; j + 1 < grid; j++) {
        for (uint32_t i = 0; i + 1 < grid; i++) {
            const uint32_t bl = j * grid + i;
            const uint32_t br = bl + 1;
            const uint32_t tl = bl + grid;
            const uint32_t tr = tl + 1;
            indices.push_back(bl); indices.push_back(br); indices.push_back(tr);
            indices.push_back(bl); indices.push_back(tr); indices.push_back(tl);
        }
    }

    // HIGH-WATER-MARK PRECONDITION: a vertex's first appearance in the index
    // stream must land exactly when it becomes the highest index seen, so the
    // vertices are renumbered by first appearance and every array permuted to
    // match. The decode loop (`index = highest - code; if (code == 0) ++highest`)
    // then reproduces the stream exactly.
    std::vector<uint32_t> remap(n_verts, UINT32_MAX);
    {
        uint32_t next = 0;
        for (uint32_t& idx : indices) {
            if (remap[idx] == UINT32_MAX) remap[idx] = next++;
        }
        // A regular grid triangulation touches every vertex.
        std::vector<uint16_t> pu(n_verts), pv(n_verts), ph(n_verts);
        std::vector<double> ph_m(n_verts), plat(n_verts), plon(n_verts);
        for (uint32_t v = 0; v < n_verts; v++) {
            const uint32_t nv = remap[v];
            pu[nv] = qu[v]; pv[nv] = qv[v]; ph[nv] = qh[v];
            ph_m[nv] = heights[v]; plat[nv] = lats[v]; plon[nv] = lons[v];
        }
        qu.swap(pu); qv.swap(pv); qh.swap(ph);
        heights.swap(ph_m); lats.swap(plat); lons.swap(plon);
        for (uint32_t& idx : indices) idx = remap[idx];
    }

    // ── header geometry (ECEF, metres, real heights) ────────────────────────
    std::vector<Vec3> positions(n_verts);
    for (uint32_t v = 0; v < n_verts; v++) {
        positions[v] = geodetic_to_ecef(lats[v], lons[v], heights[v]);
    }
    Vec3 centroid;
    for (const Vec3& p : positions) { centroid.x += p.x; centroid.y += p.y; centroid.z += p.z; }
    centroid.x /= n_verts; centroid.y /= n_verts; centroid.z /= n_verts;
    double radius = 0.0;
    for (const Vec3& p : positions) {
        const double dx = p.x - centroid.x, dy = p.y - centroid.y, dz = p.z - centroid.z;
        radius = std::max(radius, std::sqrt(dx * dx + dy * dy + dz * dz));
    }
    const Vec3 occlusion = horizon_occlusion_point(positions, centroid);

    // ── serialize quantized-mesh-1.0 ────────────────────────────────────────
    std::vector<uint8_t> mesh;
    mesh.reserve(n_verts * 6 + indices.size() * 2 + 256);
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

    // Watermask extension (extensionId 2): one byte uniform, or the raster.
    put_u8(&mesh, 2);
    if (water_kind == "RASTER") {
        put_u32(&mesh, static_cast<uint32_t>(water_raster.size()));
        mesh.insert(mesh.end(), water_raster.begin(), water_raster.end());
    } else {
        put_u32(&mesh, 1);
        put_u8(&mesh, water_kind == "UNIFORM_WATER" ? 0xff : 0x00);
    }

    // ── gzip the payload (CONTENT_ENCODING states it; a failed compress is
    //    served uncompressed rather than failing the tile) ───────────────────
    std::vector<uint8_t> payload_bytes;
    bool gzipped = gzip_compress(mesh, &payload_bytes);
    if (!gzipped) payload_bytes = mesh;

    // ── build the $DTT record ───────────────────────────────────────────────
    flatbuffers::FlatBufferBuilder b(payload_bytes.size() + 2048);
    const auto provenance = build_provenance(b, contract);
    const auto payload_media = b.CreateString("application/vnd.quantized-mesh");
    const auto payload_encoding = gzipped ? b.CreateString("gzip") : 0;
    const auto payload_vec = b.CreateVector(payload_bytes.data(), payload_bytes.size());
    flatbuffers::Offset<DTTPayloadRef> payload;
    {
        DTTPayloadRefBuilder prb(b);
        prb.add_BYTES(payload_vec);
        prb.add_SIZE_BYTES(payload_bytes.size());
        prb.add_MEDIA_TYPE(payload_media);
        if (payload_encoding.o) prb.add_CONTENT_ENCODING(payload_encoding);
        payload = prb.Finish();
    }
    flatbuffers::Offset<DTTPayloadRef> water_ref;
    if (water_kind == "RASTER") {
        const auto media = b.CreateString("application/octet-stream");
        const auto vec = b.CreateVector(reinterpret_cast<const uint8_t*>(water_raster.data()),
                                        water_raster.size());
        DTTPayloadRefBuilder wrb(b);
        wrb.add_BYTES(vec);
        wrb.add_SIZE_BYTES(water_raster.size());
        wrb.add_MEDIA_TYPE(media);
        water_ref = wrb.Finish();
    }
    const auto f_tileset = b.CreateString(tileset_id);
    const auto f_version = b.CreateString("1.0");
    const auto f_datum_name = b.CreateString(json_string(plan, "verticalDatumName", "EGM2008"));
    const auto f_remarks = b.CreateString(kGeoidRemark);
    const double post_spacing =
        (north - south) / (grid - 1) * (kPi / 180.0) * 6371008.8;

    DTTBuilder db(b);
    db.add_TILESET_ID(f_tileset);
    db.add_TILING_SCHEME(dttTilingScheme_GEOGRAPHIC_WGS84);
    db.add_LEVEL(level);
    db.add_X(tx);
    db.add_Y(ty);
    db.add_WEST_DEG(west);
    db.add_SOUTH_DEG(south);
    db.add_EAST_DEG(east);
    db.add_NORTH_DEG(north);
    db.add_MIN_HEIGHT_M(min_h);
    db.add_MAX_HEIGHT_M(max_h);
    db.add_PAYLOAD_FORMAT(dttPayloadFormat_QUANTIZED_MESH);
    db.add_PAYLOAD_FORMAT_VERSION(f_version);
    db.add_PAYLOAD(payload);
    db.add_GRID_WIDTH(grid);
    db.add_GRID_HEIGHT(grid);
    db.add_POST_SPACING_M(post_spacing);
    db.add_VERTICAL_DATUM(dttVerticalDatum_GEOID);
    db.add_VERTICAL_DATUM_NAME(f_datum_name);
    db.add_DATA_COVERAGE_FRACTION(coverage);
    db.add_NO_DATA_VALUE(kNoData);
    db.add_WATER_MASK_KIND(water_kind == "UNIFORM_WATER"
                               ? dttWaterMask_UNIFORM_WATER
                               : (water_kind == "RASTER" ? dttWaterMask_RASTER
                                                         : dttWaterMask_UNIFORM_LAND));
    if (water_ref.o) {
        db.add_WATER_MASK(water_ref);
        db.add_WATER_MASK_WIDTH(water_w);
        db.add_WATER_MASK_HEIGHT(water_h);
    }
    db.add_CHILD_AVAILABILITY(static_cast<uint8_t>(child_availability & 0x0f));
    db.add_MAX_LEVEL(max_level);
    db.add_SOURCE_CLASS(dttSourceClass_SPACEBORNE_RADAR_INTERFEROMETRIC);
    db.add_PROVENANCE(provenance);
    db.add_REMARKS(f_remarks);
    FinishDTTBuffer(b, db.Finish());

    // Size-prefixed record stream: [uint32 LE length][record], one tile here.
    std::vector<uint8_t> stream;
    const uint32_t len = b.GetSize();
    put_u32(&stream, len);
    stream.insert(stream.end(), b.GetBufferPointer(), b.GetBufferPointer() + len);

    const std::string report =
        std::string("{\"tilesetId\":\"") + json_escape(tileset_id) + "\"" +
        ",\"level\":" + std::to_string(level) + ",\"x\":" + std::to_string(tx) +
        ",\"y\":" + std::to_string(ty) + ",\"gridSize\":" + std::to_string(grid) +
        ",\"granulesDecoded\":" + std::to_string(granules.size()) +
        ",\"granulesAbsent\":" + std::to_string(absent_granules) +
        ",\"noDataSamples\":" + std::to_string(nodata_count) +
        ",\"uncoveredSamples\":" + std::to_string(uncovered_count) +
        ",\"coverageFraction\":" + fmt_double(coverage) +
        ",\"minHeightM\":" + fmt_double(min_h) + ",\"maxHeightM\":" + fmt_double(max_h) +
        ",\"waterMaskKind\":\"" + json_escape(water_kind) + "\"" +
        ",\"meshBytes\":" + std::to_string(mesh.size()) +
        ",\"payloadBytes\":" + std::to_string(payload_bytes.size()) +
        ",\"contentEncoding\":\"" + (gzipped ? "gzip" : "") + "\"" +
        ",\"verticalDatum\":\"GEOID\",\"verticalDatumNote\":\"heights redistributed on the "
        "source geoid datum, not converted to ellipsoidal; bounded <~100 m offset if "
        "rendered as above-ellipsoid\"}";

    if (push_dtt_stream("records", stream) < 0) return 500;
    return push_json("report", report) < 0 ? 500 : 0;
}

// ---------------------------------------------------------------------------
// layer_json — plan -> the tileset's complete layer.json body, emitted as the
// SDK's canonical $HTR HttpResponse envelope (never a JSON control frame).
// ---------------------------------------------------------------------------
int layer_json(void) {
    if (refuse_batched()) return 500;

    const std::string plan = input_text("plan");
    if (plan.empty()) {
        plugin_set_error("missing-plan-frame",
                         "layer_json requires the plan frame on port \"plan\".");
        return 400;
    }
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

    const std::string body =
        std::string("{\"tilejson\":\"2.1.0\"") + ",\"name\":\"" + json_escape(tileset_id) +
        "\"" + ",\"description\":\"" +
        json_escape(json_string(plan, "description", "")) + "\"" +
        ",\"version\":\"" + json_escape(json_string(plan, "version", "1.0.0")) + "\"" +
        ",\"format\":\"quantized-mesh-1.0\",\"attribution\":\"" +
        json_escape(json_string(plan, "attribution", "")) + "\"" +
        ",\"scheme\":\"tms\",\"tiles\":[\"{z}/{x}/{y}.terrain?v={version}\"]" +
        ",\"projection\":\"EPSG:4326\",\"bounds\":[-180,-90,180,90]" +
        ",\"minzoom\":0,\"maxzoom\":" + std::to_string(maxzoom) +
        ",\"extensions\":[\"watermask\"]" + ",\"available\":" + available + "}";

    // The canonical $HTR envelope: the host is a dumb pipe and streams this
    // back verbatim, so the content-type decision lives here.
    flatbuffers::FlatBufferBuilder builder(body.size() + 512);
    std::vector<::flatbuffers::Offset<sdn::http::HttpHeader>> headers;
    headers.push_back(sdn::http::CreateHttpHeader(builder,
                                                  builder.CreateString("content-type"),
                                                  builder.CreateString("application/json")));
    const auto headers_vector =
        builder.CreateVectorOfSortedTables<sdn::http::HttpHeader>(&headers);
    const auto body_vector = builder.CreateVector(
        reinterpret_cast<const uint8_t*>(body.data()), body.size());
    const auto response =
        sdn::http::CreateHttpResponse(builder, 200, headers_vector, body_vector, 0, 0);
    sdn::http::FinishHttpResponseBuffer(builder, response);

    const int32_t pushed = plugin_push_output_ex(
        "response", "HttpResponseAbi.fbs", "$HTR", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
        "HttpResponse", 0, 0, builder.GetBufferPointer(), builder.GetSize());
    return pushed < 0 ? 500 : 0;
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
//   terrain_available    layer.json availability array VERBATIM (default the
//                        two level-0 roots — honest exactly when maxzoom is 0)
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

    // Strip up to and including the LAST "/terrain/". A path without the
    // segment is not this flow's to answer creatively.
    const size_t mount = path.rfind("/terrain/");
    if (mount == std::string::npos) return push_htr_not_found(path);
    const std::string rest = path.substr(mount + 9);

    const std::string config = load_config();
    const std::string tileset_id =
        json_string(config, "terrain_tileset_id", "spaceaware-terrain");

    if (rest == "layer.json") {
        const long maxzoom = static_cast<long>(json_number(config, "terrain_maxzoom", 0));
        std::string available;
        if (!json_raw_value(config, "terrain_available", &available) || available.empty() ||
            available[0] != '[') {
            // Default: the two level-0 roots of the two-root geographic
            // scheme. Honest exactly when maxzoom is 0; a deeper pyramid MUST
            // configure terrain_available.
            available = "[[{\"startX\":0,\"startY\":0,\"endX\":1,\"endY\":0}]]";
        }
        const std::string plan =
            std::string("{\"tilesetId\":\"") + json_escape(tileset_id) + "\"" +
            ",\"maxzoom\":" + std::to_string(maxzoom) + ",\"attribution\":\"" +
            json_escape(json_string(config, "terrain_attribution", "")) + "\"" +
            ",\"description\":\"" +
            json_escape(json_string(config, "terrain_description", "")) + "\"" +
            ",\"version\":\"" + json_escape(json_string(config, "terrain_version", "1.0.0")) +
            "\"" + ",\"available\":" + available + "}";
        return push_json("layer_plan", plan) < 0 ? 500 : 0;
    }

    uint32_t z = 0, x = 0, y = 0;
    if (!parse_tile_path(rest, &z, &x, &y)) return push_htr_not_found(path);

    // The newest stored record for this address wins; the record BLOB is the
    // whole answer ($DTT carries its own payload, encoding and etag).
    const std::string sql =
        "SELECT _data FROM DTT WHERE TILESET_ID = ? AND LEVEL = ? AND X = ? AND Y = ? "
        "ORDER BY rowid DESC LIMIT 1";
    const std::string query =
        std::string("{\"sql\":\"") + sql + "\",\"params\":[{\"t\":\"str\",\"v\":\"" +
        json_escape(tileset_id) + "\"},{\"t\":\"i64\",\"v\":" + std::to_string(z) +
        "},{\"t\":\"i64\",\"v\":" + std::to_string(x) + "},{\"t\":\"i64\",\"v\":" +
        std::to_string(y) + "}]}";
    if (push_json("query", query) < 0) return 500;

    // Conditional-request state for respond: the client's If-None-Match.
    std::string if_none_match;
    if (request->HEADERS()) {
        for (const auto* h : *request->HEADERS()) {
            if (h->NAME() && h->NAME()->str() == "if-none-match" && h->VALUE()) {
                if_none_match = h->VALUE()->str();
            }
        }
    }
    const std::string context =
        std::string("{\"tilesetId\":\"") + json_escape(tileset_id) + "\"" +
        ",\"level\":" + std::to_string(z) + ",\"x\":" + std::to_string(x) +
        ",\"y\":" + std::to_string(y) + ",\"ifNoneMatch\":\"" + json_escape(if_none_match) +
        "\"}";
    return push_json("context", context) < 0 ? 500 : 0;
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

    const int32_t stream_index = plugin_find_input_index("stream", 0);
    const plugin_input_frame_t* frame =
        stream_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(stream_index))
                          : nullptr;
    if (!frame) {
        plugin_set_error("missing-stream-frame",
                         "respond requires the flatsql-query stream frame on port \"stream\".");
        return 400;
    }
    const std::string context = input_text("context");

    // Walk the aligned size-prefixed stream, exactly as foundation/omm-json
    // does: zero-length prefixes are alignment padding; frames verify with
    // the size-prefixed accessors first (the store's wire contract counts the
    // 4-byte prefix in internal alignment), plain-anchored as the fallback.
    const uint8_t* data = frame->payload;
    const size_t length = data ? static_cast<size_t>(frame->payload_length) : 0u;
    std::vector<uint8_t> scratch;
    const DTT* record = nullptr;
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
        if (frame_size >= 8) {
            ::flatbuffers::Verifier prefixed(scratch.data(), scratch.size());
            if (VerifySizePrefixedDTTBuffer(prefixed)) {
                record = GetSizePrefixedDTT(scratch.data());
            } else {
                scratch.erase(scratch.begin(), scratch.begin() + 4);
                ::flatbuffers::Verifier plain(scratch.data(), scratch.size());
                if (DTTBufferHasIdentifier(scratch.data()) && VerifyDTTBuffer(plain)) {
                    record = GetDTT(scratch.data());
                }
            }
        }
        if (!record) {
            plugin_set_error("invalid-dtt-frame",
                             "stream frame is not a valid $DTT FlatBuffer.");
            return 400;
        }
    }

    if (!record) {
        std::string detail = "no stored tile at this address";
        if (!context.empty()) {
            detail += " (" + json_string(context, "tilesetId", "?") + " " +
                      fmt_double(json_number(context, "level", -1)) + "/" +
                      fmt_double(json_number(context, "x", -1)) + "/" +
                      fmt_double(json_number(context, "y", -1)) + ")";
        }
        return push_htr_not_found(detail);
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

    const std::string if_none_match = json_string(context, "ifNoneMatch", "");
    std::vector<HeaderEntry> headers;
    headers.push_back({"cache-control", "public, max-age=86400"});
    headers.push_back({"etag", etag});
    if (!if_none_match.empty() && if_none_match == etag) {
        return push_htr(304, headers, nullptr, 0);
    }
    headers.push_back({"content-type", payload->MEDIA_TYPE() && payload->MEDIA_TYPE()->size()
                                           ? payload->MEDIA_TYPE()->str()
                                           : "application/vnd.quantized-mesh"});
    if (payload->CONTENT_ENCODING() && payload->CONTENT_ENCODING()->size() > 0) {
        headers.push_back({"content-encoding", payload->CONTENT_ENCODING()->str()});
    }
    return push_htr(200, headers, payload->BYTES()->data(), payload->BYTES()->size());
}

}  // extern "C"
