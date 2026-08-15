/*
 * data-source/geonames-source — the PURE half of the GeoNames gazetteer lane
 * (graph task `geonames-ingest-flow`).
 *
 * This plugin performs NO I/O. `capabilities: []`, runtime targets browser +
 * wasmedge, every method a single-pass transform over the frames the flow hands
 * it. Every byte it decodes was fetched by `com.digitalarsenal.hostcap.http-
 * request` and every record it emits is persisted by
 * `com.digitalarsenal.hostcap.storage-ingest`. The split mirrors
 * cell-tower-source / cell-tower-ingest exactly: parsing a gazetteer dump and
 * orchestrating a scheduled ingest of it are different jobs with different
 * blast radii, and folding them together would make the parser un-runnable in a
 * browser.
 *
 * Methods:
 *   inflate       job + response          -> text, report
 *   parse_lookups job + admin1/2/country  -> tables
 *   parse_places  job + text + tables?    -> records ($GNP stream), decision
 *   parse_deletes job + text              -> tombstones
 *
 * WHY THE INFLATE IS IN-GUEST.
 *
 * The seed edition ships as `cities15000.zip` — one ZIP holding one 19-column
 * tab-separated file. There is NO host unzip capability and none may be added
 * (owner law: all functionality is WASM over the existing generic hooks). So
 * miniz 3.1.2 is vendored under vendor/miniz-3.1.2 (MIT, Rich Geldreich /
 * Tenacious Software / RAD Game Tools; LICENSE carried verbatim beside the
 * sources, SHA-256 pinned and re-verified on every build by miniz-source.mjs)
 * and the central directory is walked by hand — the same vendored copy and the
 * same sanctioned pattern data-source/cell-tower-source already uses for the
 * four national bulk archives, deliberately reused rather than hand-rolling a
 * second inflate in this repo.
 *
 * WHY THE ADMIN/COUNTRY TABLES ARE A SEPARATE METHOD.
 *
 * $GNP requires RESOLVED NAMES beside the codes ("Carried beside the code so a
 * consumer need not hold the division tables to render a place"). GeoNames
 * publishes those names in three separate plain-text files. Joining them at
 * parse time is the only place the join can happen without a consumer holding
 * the tables, and they are decoded by their own method because they arrive on
 * their own fetches and change on their own cadence.
 *
 * NOTHING IS INVENTED. A column GeoNames leaves empty is left UNSET on the
 * record rather than defaulted: FlatBuffers omits default-valued fields, which
 * is what keeps "the gazetteer did not publish an elevation" distinguishable
 * from "the gazetteer published zero" — the distinction $GNP's
 * ELEVATION_PUBLISHED exists to carry. Time-zone UTC offsets are NOT in this
 * file, so they are never written; a consumer resolves TIME_ZONE_ID against a
 * tz database, exactly as the IDL instructs.
 */

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <map>
#include <string>
#include <sys/time.h>
#include <vector>

#include "space_data_module_invoke.h"

namespace {

// ── tiny JSON readers (the intra-flow control frames are all flat JSON) ─────

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
// "bodyB64" (browser harness dialect) or "body" with body_encoding base64 (the
// Go host dialect). Both are read; a plain-text body is taken verbatim.
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

// Content-Length as the ORIGIN stated it, so a body the host truncated at its
// 4 MiB response cap can be told from a file that is genuinely that short. The
// difference matters: a truncated division table silently drops the names of
// every division after the cut, and a place then carries a code with no name
// while the run reports success.
bool declared_content_length(const std::string& response, long* out) {
    const size_t h = response.find("\"headers\"");
    if (h == std::string::npos) return false;
    const size_t open = response.find('{', h);
    if (open == std::string::npos) return false;
    int depth = 0;
    size_t i = open;
    for (; i < response.size(); i++) {
        if (response[i] == '{') depth++;
        else if (response[i] == '}' && --depth == 0) break;
    }
    if (i >= response.size()) return false;
    const std::string headers = response.substr(open, i - open + 1);
    std::string value;
    if (!json_string_field(headers, "content-length", &value) &&
        !json_string_field(headers, "Content-Length", &value)) {
        return false;
    }
    const long parsed = std::atol(value.c_str());
    if (parsed <= 0) return false;
    *out = parsed;
    return true;
}

// ── frame helpers ──────────────────────────────────────────────────────────

std::string input_text(const char* port_id) {
    const int32_t idx = plugin_find_input_index(port_id, 0);
    if (idx < 0) return std::string();
    const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(idx));
    if (!f || !f->payload) return std::string();
    return std::string(reinterpret_cast<const char*>(f->payload), f->payload_length);
}

int push_json(const char* port, const std::string& json) {
    return plugin_push_output_ex(port, nullptr, nullptr,
                                 PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                                 reinterpret_cast<const uint8_t*>(json.data()),
                                 static_cast<uint32_t>(json.size()));
}

int push_gnp_stream(const char* port, const std::vector<uint8_t>& bytes) {
    return plugin_push_output_ex(port, "GNP.fbs", "$GNP", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "GNP", 0, 0, bytes.data(), static_cast<uint32_t>(bytes.size()));
}

// SURPLUS-FRAME REFUSAL. The compiled flow runtime drains a node's queue
// PORT-BLIND up to a budget of 64; maxStreams/maxBatch/drainPolicy are purely
// declarative there. A guest that reads ordinal 0 and returns therefore
// destroys every other frame it was handed, with nothing re-delivering them and
// nothing logging the loss (the live P1 that produced
// `modules-guest-nodes-drop-batched-frames`). Every input port here is
// single-stream BY CONTRACT, so a surplus is refused by name.
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

bool refuse_batched(void) {
    char message[384];
    if (!find_batched_input_port(message, sizeof(message))) return false;
    plugin_set_error("batched-input-frames", message);
    return true;
}

std::string iso_now() {
    struct timeval tv;
    if (gettimeofday(&tv, nullptr) != 0) return std::string("1970-01-01T00:00:00.000Z");
    const time_t secs = static_cast<time_t>(tv.tv_sec);
    struct tm utc;
    if (gmtime_r(&secs, &utc) == nullptr) return std::string("1970-01-01T00:00:00.000Z");
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", utc.tm_year + 1900,
                  utc.tm_mon + 1, utc.tm_mday, utc.tm_hour, utc.tm_min, utc.tm_sec,
                  static_cast<int>(tv.tv_usec / 1000));
    return std::string(buf);
}

// ── ZIP member lookup ──────────────────────────────────────────────────────
//
// miniz is compiled with MINIZ_NO_ARCHIVE_APIS (see miniz-source.mjs), which
// removes mz_zip_*; the central directory is therefore walked by hand. tinfl_*
// survives that define (it is gated by MINIZ_NO_INFLATE_APIS, which is NOT
// set). Adapted from cell_tower_source_module.cpp's zip_find_member, with one
// change: an EMPTY `want` selects the archive's FIRST member, because the
// GeoNames dumps hold exactly one file each and pinning its name would break
// the lane on a rename the publisher is free to make.
struct ZipEntry {
    size_t data_offset = 0;
    uint32_t compressed_size = 0;
    uint32_t uncompressed_size = 0;
    uint16_t method = 0;  // 0 = stored, 8 = deflate
    std::string name;
    bool found = false;
};

uint16_t le16(const std::string& b, size_t at) {
    return static_cast<uint16_t>(static_cast<uint8_t>(b[at])) |
           (static_cast<uint16_t>(static_cast<uint8_t>(b[at + 1])) << 8);
}

uint32_t le32(const std::string& b, size_t at) {
    return static_cast<uint32_t>(static_cast<uint8_t>(b[at])) |
           (static_cast<uint32_t>(static_cast<uint8_t>(b[at + 1])) << 8) |
           (static_cast<uint32_t>(static_cast<uint8_t>(b[at + 2])) << 16) |
           (static_cast<uint32_t>(static_cast<uint8_t>(b[at + 3])) << 24);
}

// The CENTRAL DIRECTORY is the authority for the sizes, never the local header:
// a ZIP written with a data descriptor (general-purpose flag bit 3) carries
// zeroes for both sizes in the local header, and reading those would inflate
// zero bytes and report an empty gazetteer — a parse-to-nothing that is
// indistinguishable from a day on which nothing changed.
ZipEntry zip_find_member(const std::string& body, const std::string& want) {
    ZipEntry e;
    if (body.size() < 22) return e;
    // Scan BACKWARDS for the end-of-central-directory over the permitted 64 KiB
    // comment. Searching forward is wrong — "PK\x05\x06" occurs inside
    // compressed data.
    const size_t floor_at = body.size() > 66000 ? body.size() - 66000 : 0;
    size_t eocd = std::string::npos;
    for (size_t i = body.size() - 22 + 1; i-- > floor_at;) {
        if (body[i] == 'P' && body[i + 1] == 'K' &&
            static_cast<uint8_t>(body[i + 2]) == 0x05 &&
            static_cast<uint8_t>(body[i + 3]) == 0x06) {
            eocd = i;
            break;
        }
    }
    if (eocd == std::string::npos || eocd + 22 > body.size()) return e;

    const uint16_t entries = le16(body, eocd + 10);
    const uint32_t cd_offset = le32(body, eocd + 16);
    if (cd_offset == 0xFFFFFFFFu) return e;  // ZIP64: refused, never guessed
    size_t p = cd_offset;

    for (uint16_t n = 0; n < entries; ++n) {
        if (p + 46 > body.size()) return e;
        if (!(body[p] == 'P' && body[p + 1] == 'K' &&
              static_cast<uint8_t>(body[p + 2]) == 0x01 &&
              static_cast<uint8_t>(body[p + 3]) == 0x02)) {
            return e;
        }
        const uint16_t flags = le16(body, p + 8);
        const uint16_t method = le16(body, p + 10);
        const uint32_t csize = le32(body, p + 20);
        const uint32_t usize = le32(body, p + 24);
        const uint16_t name_len = le16(body, p + 28);
        const uint16_t extra_len = le16(body, p + 30);
        const uint16_t comment_len = le16(body, p + 32);
        const uint32_t local_at = le32(body, p + 42);
        if (p + 46 + name_len > body.size()) return e;
        const std::string name = body.substr(p + 46, name_len);
        p += 46u + name_len + extra_len + comment_len;

        if (!want.empty() && name != want) continue;
        if (flags & 0x0001) return e;  // encrypted: refused, never decoded to noise
        if (csize == 0xFFFFFFFFu || usize == 0xFFFFFFFFu || local_at == 0xFFFFFFFFu) return e;
        if (method != 0 && method != 8) return e;
        if (local_at + 30 > body.size()) return e;
        if (!(body[local_at] == 'P' && body[local_at + 1] == 'K' &&
              static_cast<uint8_t>(body[local_at + 2]) == 0x03 &&
              static_cast<uint8_t>(body[local_at + 3]) == 0x04)) {
            return e;
        }
        const uint16_t l_name = le16(body, local_at + 26);
        const uint16_t l_extra = le16(body, local_at + 28);
        const size_t data_at = local_at + 30u + l_name + l_extra;
        if (data_at + csize > body.size()) return e;
        e.data_offset = data_at;
        e.compressed_size = csize;
        e.uncompressed_size = usize;
        e.method = method;
        e.name = name;
        e.found = true;
        return e;
    }
    return e;
}

// ── tab-separated row splitting ────────────────────────────────────────────
//
// GeoNames dumps are TAB-separated with NO quoting: a field ends at the next
// tab, full stop. So this is a split and not a CSV parse, and treating a quote
// as significant would corrupt names that legitimately contain one.
std::vector<std::string> split_tabs(const std::string& line) {
    std::vector<std::string> out;
    size_t start = 0;
    for (size_t i = 0; i <= line.size(); ++i) {
        if (i == line.size() || line[i] == '\t') {
            out.push_back(line.substr(start, i - start));
            start = i + 1;
        }
    }
    return out;
}

std::vector<std::string> split_commas(const std::string& value) {
    std::vector<std::string> out;
    if (value.empty()) return out;
    size_t start = 0;
    for (size_t i = 0; i <= value.size(); ++i) {
        if (i == value.size() || value[i] == ',') {
            const std::string piece = value.substr(start, i - start);
            if (!piece.empty()) out.push_back(piece);
            start = i + 1;
        }
    }
    return out;
}

// Feature class letters as GeoNames publishes them, mapped onto the enum $GNP
// models. An unmodelled letter falls to UNSPECIFIED and the letter itself still
// rides verbatim in FEATURE_CLASS_CODE, so nothing is lost — that is exactly
// what the IDL says the code field is for.
gnpFeatureClass feature_class_of(const std::string& code) {
    if (code.size() != 1) return gnpFeatureClass_UNSPECIFIED;
    switch (code[0]) {
        case 'A': return gnpFeatureClass_ADMINISTRATIVE;
        case 'H': return gnpFeatureClass_HYDROGRAPHIC;
        case 'L': return gnpFeatureClass_AREA;
        case 'P': return gnpFeatureClass_POPULATED_PLACE;
        case 'R': return gnpFeatureClass_TRANSPORT;
        case 'S': return gnpFeatureClass_SPOT;
        case 'T': return gnpFeatureClass_HYPSOGRAPHIC;
        case 'U': return gnpFeatureClass_UNDERSEA;
        case 'V': return gnpFeatureClass_VEGETATION;
        default: return gnpFeatureClass_UNSPECIFIED;
    }
}

// A lookup table frame, as parse_lookups writes it and parse_places reads it.
// Kept as flat JSON objects rather than a bespoke binary layout because it is
// an INTRA-FLOW control frame: no SDS record models "the admin1 division
// names", and inventing one to move a join table between two nodes of one flow
// is not this lane's call to make.
struct Lookups {
    std::map<std::string, std::string> admin1;
    std::map<std::string, std::string> admin2;
    std::map<std::string, std::string> country;
};

// Reads one flat {"k":"v",...} object out of `json` under `key`.
void read_lookup_object(const std::string& json, const char* key,
                        std::map<std::string, std::string>* out) {
    const std::string needle = std::string("\"") + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return;
    size_t i = json.find('{', k + needle.size());
    if (i == std::string::npos) return;
    i++;
    while (i < json.size()) {
        while (i < json.size() && (is_ws(json[i]) || json[i] == ',')) i++;
        if (i >= json.size() || json[i] == '}') return;
        if (json[i] != '"') return;
        i++;
        std::string mapkey;
        while (i < json.size() && json[i] != '"') {
            if (json[i] == '\\' && i + 1 < json.size()) { mapkey.push_back(json[i + 1]); i += 2; }
            else { mapkey.push_back(json[i]); i++; }
        }
        i++;  // closing quote
        while (i < json.size() && is_ws(json[i])) i++;
        if (i >= json.size() || json[i] != ':') return;
        i++;
        while (i < json.size() && is_ws(json[i])) i++;
        if (i >= json.size() || json[i] != '"') return;
        i++;
        std::string value;
        while (i < json.size() && json[i] != '"') {
            if (json[i] == '\\' && i + 1 < json.size()) {
                const char esc = json[i + 1];
                if (esc == 'n') value.push_back('\n');
                else if (esc == 't') value.push_back('\t');
                else value.push_back(esc);
                i += 2;
            } else { value.push_back(json[i]); i++; }
        }
        i++;
        (*out)[mapkey] = value;
    }
}

Lookups read_lookups(const std::string& json) {
    Lookups l;
    if (json.empty()) return l;
    read_lookup_object(json, "admin1", &l.admin1);
    read_lookup_object(json, "admin2", &l.admin2);
    read_lookup_object(json, "country", &l.country);
    return l;
}

std::string lookup_or_empty(const std::map<std::string, std::string>& table,
                            const std::string& key) {
    if (key.empty()) return std::string();
    const auto it = table.find(key);
    return it == table.end() ? std::string() : it->second;
}

// Iterate the lines of a buffer without copying the whole thing again.
template <typename OnLine>
void for_each_line(const std::string& text, OnLine on_line) {
    size_t start = 0;
    while (start <= text.size()) {
        size_t nl = text.find('\n', start);
        if (nl == std::string::npos) {
            size_t tail = text.size();
            if (tail > start && text[tail - 1] == '\r') tail--;
            if (tail > start) on_line(text.substr(start, tail - start));
            return;
        }
        size_t end = nl;
        if (end > start && text[end - 1] == '\r') end--;
        if (end > start) {
            if (!on_line(text.substr(start, end - start))) return;
        }
        start = nl + 1;
    }
}

// ── the dataset contract carried on every job frame ─────────────────────────
//
// $GNP.SOURCE requires DATASET_ID, DATASET_EPOCH, RETRIEVED_AT, LICENSE and
// NATIVE_ID on EVERY record: "a redistributed place whose dataset, epoch, and
// licence are unstated is not publishable". Four of those five come from the
// job frame (the orchestrator owns dataset identity), RETRIEVED_AT is stamped
// here, and NATIVE_ID is the gazetteer's own row id. A job that cannot supply
// the dataset identity is REFUSED rather than defaulted — a record published
// under a guessed epoch is worse than none, because it is comparable to the
// wrong bytes.
struct DatasetContract {
    std::string dataset_id;
    std::string dataset_name;
    std::string dataset_url;
    std::string dataset_epoch;
    std::string dataset_cid;
    std::string source_url;
    std::string source_query;
    std::string license;
    std::string license_url;
    std::string attribution;
    std::string dem_model;
    std::string id_prefix;
    bool share_alike = false;
    bool non_commercial_only = false;
};

DatasetContract contract_of(const std::string& job) {
    DatasetContract c;
    c.dataset_id = json_string(job, "dataset_id", "");
    c.dataset_name = json_string(job, "dataset_name", "");
    c.dataset_url = json_string(job, "dataset_url", "");
    c.dataset_epoch = json_string(job, "dataset_epoch", "");
    c.dataset_cid = json_string(job, "dataset_cid", "");
    c.source_url = json_string(job, "source_url", "");
    c.source_query = json_string(job, "source_query", "");
    c.license = json_string(job, "license", "");
    c.license_url = json_string(job, "license_url", "");
    c.attribution = json_string(job, "attribution", "");
    c.dem_model = json_string(job, "dem_model", "");
    c.id_prefix = json_string(job, "id_prefix", "geonames");
    c.share_alike = json_bool(job, "share_alike", false);
    c.non_commercial_only = json_bool(job, "non_commercial_only", false);
    return c;
}

// GeoNames' 19 columns, by ordinal. Named rather than indexed inline so a
// column drift shows up as one edit and not nineteen.
enum GeoNameColumn {
    COL_GEONAMEID = 0,
    COL_NAME = 1,
    COL_ASCIINAME = 2,
    COL_ALTERNATENAMES = 3,
    COL_LATITUDE = 4,
    COL_LONGITUDE = 5,
    COL_FEATURE_CLASS = 6,
    COL_FEATURE_CODE = 7,
    COL_COUNTRY_CODE = 8,
    COL_CC2 = 9,
    COL_ADMIN1 = 10,
    COL_ADMIN2 = 11,
    COL_ADMIN3 = 12,
    COL_ADMIN4 = 13,
    COL_POPULATION = 14,
    COL_ELEVATION = 15,
    COL_DEM = 16,
    COL_TIMEZONE = 17,
    COL_MODIFICATION_DATE = 18,
    GEONAME_COLUMNS = 19,
};

}  // namespace

extern "C" {

// ---------------------------------------------------------------------------
// inflate — the ZIP/deflate assembly step.
//
// Takes the raw hostcap/http-request response and hands the next node PLAIN
// TEXT, so parse_places never has to know whether the edition arrived
// compressed. `job.container` selects the treatment:
//
//   "zip"   — walk the central directory, select `job.member` (or the FIRST
//             member when none is named), inflate it whole.
//   "plain" — the daily modifications/deletes and the three lookup files, which
//             are served uncompressed; the body passes through verbatim.
//
// A non-2xx status is an ERROR here rather than an empty text frame: an empty
// gazetteer and a failed fetch must never be the same observation.
// ---------------------------------------------------------------------------
int inflate(void) {
    if (refuse_batched()) return 500;

    const std::string job = input_text("job");
    const std::string response = input_text("response");
    if (response.empty()) {
        plugin_set_error("missing-response-frame",
                         "inflate requires the http response frame on port \"response\".");
        return 400;
    }
    const long status = response_status(response);
    // 304 NOT MODIFIED is the SAME-DATA LEDGER paying off, not a failure.
    // geonames-ingest attaches If-None-Match from the resume mark, so an
    // unchanged upstream file costs one conditional request. Nothing is pushed
    // on `text`, so parse_places never becomes ready and the run ends quietly;
    // the report still records the tick so a no-op is observable rather than
    // indistinguishable from a flow that never fired.
    if (status == 304) {
        const std::string report =
            std::string("{\"container\":\"") + json_escape(json_string(job, "container", "plain")) +
            "\",\"member\":\"\",\"bytesIn\":0,\"bytesOut\":0,\"status\":304"
            ",\"ledgeredNoOp\":true}";
        return push_json("report", report) < 0 ? 500 : 0;
    }
    if (status != 0 && (status < 200 || status >= 300)) {
        char message[192];
        std::snprintf(message, sizeof(message),
                      "the gazetteer fetch answered HTTP %ld; an empty edition and a failed "
                      "fetch are not the same observation, so this is refused rather than "
                      "decoded to zero places.",
                      status);
        plugin_set_error("upstream-status", message);
        return 502;
    }

    const std::string body = response_body(response);
    const std::string container = json_string(job, "container", "plain");

    std::string text;
    std::string member_name;
    if (container == "zip") {
        const std::string want = json_string(job, "member", "");
        const ZipEntry entry = zip_find_member(body, want);
        if (!entry.found) {
            plugin_set_error("zip-member-not-found",
                             "no readable member in the archive (ZIP64, an encrypted member, an "
                             "unsupported compression method and a truncated body all land "
                             "here; none is decoded to a partial answer).");
            return 422;
        }
        member_name = entry.name;
        if (entry.method == 0) {
            text.assign(body, entry.data_offset, entry.compressed_size);
        } else {
            size_t out_len = 0;
            // flags 0 == RAW deflate: a ZIP member carries no zlib header.
            void* out = tinfl_decompress_mem_to_heap(body.data() + entry.data_offset,
                                                     entry.compressed_size, &out_len, 0);
            if (!out) {
                plugin_set_error("inflate-failed",
                                 "the archive member did not inflate; a partial inflate is "
                                 "refused rather than parsed as a short gazetteer.");
                return 422;
            }
            text.assign(static_cast<const char*>(out), out_len);
            mz_free(out);
            // The central directory states the member's uncompressed size. A
            // disagreement means the inflate stopped early, which would parse
            // to a plausible short place set with no error anywhere.
            if (entry.uncompressed_size != 0 &&
                text.size() != static_cast<size_t>(entry.uncompressed_size)) {
                char message[224];
                std::snprintf(message, sizeof(message),
                              "inflated %zu bytes but the central directory states %u for "
                              "member \"%s\"; a short inflate is refused, never parsed.",
                              text.size(), entry.uncompressed_size, member_name.c_str());
                plugin_set_error("inflate-short", message);
                return 422;
            }
        }
    } else {
        text = body;
    }

    const std::string report = std::string("{\"container\":\"") + json_escape(container) + "\"" +
                               ",\"member\":\"" + json_escape(member_name) + "\"" +
                               ",\"bytesIn\":" + std::to_string(body.size()) +
                               ",\"bytesOut\":" + std::to_string(text.size()) +
                               ",\"status\":" + std::to_string(status) + "}";

    if (plugin_push_output_ex("text", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,
                              nullptr, 0, 1, reinterpret_cast<const uint8_t*>(text.data()),
                              static_cast<uint32_t>(text.size())) < 0) {
        return 500;
    }
    return push_json("report", report) < 0 ? 500 : 0;
}

// ---------------------------------------------------------------------------
// parse_lookups — the three plain-text division/country files -> one compact
// lookup-table frame.
//
// admin1CodesASCII.txt : "CC.A1"       TAB name TAB asciiname TAB geonameid
// admin2Codes.txt      : "CC.A1.A2"    TAB name TAB asciiname TAB geonameid
// countryInfo.txt      : ISO TAB ISO3 TAB numeric TAB fips TAB Country TAB ...
//                        (# comment lines, including the column header, skipped)
//
// A file the flow did not fetch simply contributes nothing: the lane must be
// able to run with only the country table (or none), and a place then carries
// its codes without resolved names rather than failing. What it must never do
// is carry a WRONG name, which is why a lookup miss leaves the field unset.
// ---------------------------------------------------------------------------
int parse_lookups(void) {
    if (refuse_batched()) return 500;

    Lookups tables;
    size_t admin1_rows = 0, admin2_rows = 0, country_rows = 0;

    // TRUNCATION IS AN ERROR, NOT A SMALLER TABLE. Checked before a single row
    // is folded in, for all three files, because a half-read division table
    // produces places whose codes resolve to nothing while every count in the
    // run still reads as a success.
    const char* lookup_ports[3] = {"admin1", "admin2", "country"};
    for (const char* port_id : lookup_ports) {
        const std::string raw = input_text(port_id);
        if (raw.empty()) continue;
        long declared = 0;
        if (!declared_content_length(raw, &declared)) continue;
        const long actual = static_cast<long>(response_body(raw).size());
        if (actual < declared) {
            char message[256];
            std::snprintf(message, sizeof(message),
                          "the \"%s\" lookup body is %ld bytes but the origin declared %ld; a "
                          "truncated division table resolves later codes to nothing while the "
                          "run still reports success, so it is refused rather than folded in.",
                          port_id, actual, declared);
            plugin_set_error("lookup-truncated", message);
            return 502;
        }
    }

    const std::string admin1 = response_body(input_text("admin1"));
    for_each_line(admin1, [&](const std::string& line) -> bool {
        if (line.empty() || line[0] == '#') return true;
        const std::vector<std::string> cols = split_tabs(line);
        if (cols.size() < 2 || cols[0].empty() || cols[1].empty()) return true;
        tables.admin1[cols[0]] = cols[1];
        admin1_rows++;
        return true;
    });

    const std::string admin2 = response_body(input_text("admin2"));
    for_each_line(admin2, [&](const std::string& line) -> bool {
        if (line.empty() || line[0] == '#') return true;
        const std::vector<std::string> cols = split_tabs(line);
        if (cols.size() < 2 || cols[0].empty() || cols[1].empty()) return true;
        tables.admin2[cols[0]] = cols[1];
        admin2_rows++;
        return true;
    });

    const std::string country = response_body(input_text("country"));
    for_each_line(country, [&](const std::string& line) -> bool {
        if (line.empty() || line[0] == '#') return true;
        const std::vector<std::string> cols = split_tabs(line);
        if (cols.size() < 5 || cols[0].empty() || cols[4].empty()) return true;
        tables.country[cols[0]] = cols[4];
        country_rows++;
        return true;
    });

    std::string out = "{\"admin1\":{";
    bool first = true;
    for (const auto& kv : tables.admin1) {
        if (!first) out += ",";
        first = false;
        out += "\"" + json_escape(kv.first) + "\":\"" + json_escape(kv.second) + "\"";
    }
    out += "},\"admin2\":{";
    first = true;
    for (const auto& kv : tables.admin2) {
        if (!first) out += ",";
        first = false;
        out += "\"" + json_escape(kv.first) + "\":\"" + json_escape(kv.second) + "\"";
    }
    out += "},\"country\":{";
    first = true;
    for (const auto& kv : tables.country) {
        if (!first) out += ",";
        first = false;
        out += "\"" + json_escape(kv.first) + "\":\"" + json_escape(kv.second) + "\"";
    }
    out += "},\"counts\":{\"admin1\":" + std::to_string(admin1_rows) +
           ",\"admin2\":" + std::to_string(admin2_rows) +
           ",\"country\":" + std::to_string(country_rows) + "}}";

    return push_json("tables", out) < 0 ? 500 : 0;
}

// ---------------------------------------------------------------------------
// parse_places — 19-column geoname rows -> a size-prefixed $GNP record stream.
//
// The SAME row shape serves both lanes, which is what makes the daily delta
// free: `modifications-YYYY-MM-DD.txt` is a file of FULL geoname rows, verified
// live 2026-08-15, so a modification is simply an upsert of the same record the
// seed would have produced. There is no second decoder and no second record
// shape to keep in step.
// ---------------------------------------------------------------------------
int parse_places(void) {
    if (refuse_batched()) return 500;

    const std::string job = input_text("job");
    const DatasetContract contract = contract_of(job);
    if (contract.dataset_id.empty() || contract.dataset_epoch.empty() ||
        contract.license.empty()) {
        plugin_set_error("incomplete-dataset-contract",
                         "$GNP.SOURCE requires DATASET_ID, DATASET_EPOCH and LICENSE on every "
                         "record. The job frame supplies them and they are never defaulted: a "
                         "place published under a guessed epoch is comparable to the wrong "
                         "bytes, which is worse than not publishing it.");
        return 400;
    }

    const int32_t text_index = plugin_find_input_index("text", 0);
    if (text_index < 0) {
        plugin_set_error("missing-text-frame",
                         "parse_places requires the decoded gazetteer text on port \"text\".");
        return 400;
    }
    const plugin_input_frame_t* text_frame =
        plugin_get_input_frame(static_cast<uint32_t>(text_index));
    const std::string text =
        text_frame && text_frame->payload
            ? std::string(reinterpret_cast<const char*>(text_frame->payload),
                          text_frame->payload_length)
            : std::string();

    const Lookups tables = read_lookups(input_text("tables"));
    const long limit = static_cast<long>(json_number(job, "limit", 0));
    const std::string retrieved_at = iso_now();

    std::vector<uint8_t> stream;
    long rows_in = 0, written = 0, skipped_short = 0, skipped_position = 0, skipped_identity = 0;
    bool truncated = false;

    for_each_line(text, [&](const std::string& line) -> bool {
        if (line.empty() || line[0] == '#') return true;
        rows_in++;
        if (limit > 0 && written >= limit) { truncated = true; return false; }

        const std::vector<std::string> c = split_tabs(line);
        if (c.size() < GEONAME_COLUMNS) { skipped_short++; return true; }
        if (c[COL_GEONAMEID].empty() || c[COL_NAME].empty()) { skipped_identity++; return true; }

        // A position outside the WGS 84 domain is DROPPED, never clamped: a
        // clamped place is a place in the wrong location, silently.
        char* lat_end = nullptr;
        char* lon_end = nullptr;
        const double lat = strtod(c[COL_LATITUDE].c_str(), &lat_end);
        const double lon = strtod(c[COL_LONGITUDE].c_str(), &lon_end);
        if (lat_end == c[COL_LATITUDE].c_str() || lon_end == c[COL_LONGITUDE].c_str() ||
            lat < -90.0 || lat > 90.0 || lon < -180.0 || lon > 180.0) {
            skipped_position++;
            return true;
        }

        flatbuffers::FlatBufferBuilder b(2048);

        // ── provenance ──────────────────────────────────────────────────────
        // NATIVE_ID is the gazetteer's own row id, verbatim and never
        // re-minted. It is deliberately NOT a vendor-named field on GNP: the
        // standard names no gazetteer, and the join key back to the source
        // belongs in SOURCE.NATIVE_ID by the IDL's own instruction.
        const auto p_dataset_id = b.CreateString(contract.dataset_id);
        const auto p_dataset_epoch = b.CreateString(contract.dataset_epoch);
        const auto p_retrieved_at = b.CreateString(retrieved_at);
        const auto p_license = b.CreateString(contract.license);
        const auto p_native_id = b.CreateString(c[COL_GEONAMEID]);
        const auto p_dataset_name =
            contract.dataset_name.empty() ? 0 : b.CreateString(contract.dataset_name);
        const auto p_dataset_url =
            contract.dataset_url.empty() ? 0 : b.CreateString(contract.dataset_url);
        const auto p_dataset_cid =
            contract.dataset_cid.empty() ? 0 : b.CreateString(contract.dataset_cid);
        const auto p_source_url =
            contract.source_url.empty() ? 0 : b.CreateString(contract.source_url);
        const auto p_source_query =
            contract.source_query.empty() ? 0 : b.CreateString(contract.source_query);
        const auto p_license_url =
            contract.license_url.empty() ? 0 : b.CreateString(contract.license_url);
        const auto p_attribution =
            contract.attribution.empty() ? 0 : b.CreateString(contract.attribution);
        const auto p_native_modified = c[COL_MODIFICATION_DATE].empty()
                                           ? 0
                                           : b.CreateString(c[COL_MODIFICATION_DATE]);

        GNPProvenanceBuilder pb(b);
        pb.add_DATASET_ID(p_dataset_id);
        pb.add_DATASET_EPOCH(p_dataset_epoch);
        pb.add_RETRIEVED_AT(p_retrieved_at);
        pb.add_LICENSE(p_license);
        pb.add_NATIVE_ID(p_native_id);
        if (p_dataset_name.o) pb.add_DATASET_NAME(p_dataset_name);
        if (p_dataset_url.o) pb.add_DATASET_URL(p_dataset_url);
        if (p_dataset_cid.o) pb.add_DATASET_CID(p_dataset_cid);
        if (p_source_url.o) pb.add_SOURCE_URL(p_source_url);
        if (p_source_query.o) pb.add_SOURCE_QUERY(p_source_query);
        if (p_license_url.o) pb.add_LICENSE_URL(p_license_url);
        if (p_attribution.o) pb.add_ATTRIBUTION(p_attribution);
        if (p_native_modified.o) pb.add_NATIVE_MODIFIED(p_native_modified);
        if (contract.share_alike) pb.add_SHARE_ALIKE(true);
        if (contract.non_commercial_only) pb.add_NON_COMMERCIAL_ONLY(true);
        const auto provenance = pb.Finish();

        // ── alternate names ─────────────────────────────────────────────────
        // The dump publishes them as one comma-joined list with no language
        // tags, so LANGUAGE and every flag are left UNSET. Guessing a language
        // from a script would be a fabricated attribute on a required-verbatim
        // field.
        std::vector<flatbuffers::Offset<GNPName>> alternates;
        for (const std::string& alt : split_commas(c[COL_ALTERNATENAMES])) {
            const auto alt_name = b.CreateString(alt);
            GNPNameBuilder nb(b);
            nb.add_NAME(alt_name);
            alternates.push_back(nb.Finish());
        }
        flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<GNPName>>> alternates_vec;
        if (!alternates.empty()) alternates_vec = b.CreateVector(alternates);

        std::vector<flatbuffers::Offset<flatbuffers::String>> cc2;
        for (const std::string& code : split_commas(c[COL_CC2])) cc2.push_back(b.CreateString(code));
        flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<flatbuffers::String>>> cc2_vec;
        if (!cc2.empty()) cc2_vec = b.CreateVector(cc2);

        const std::string record_id = contract.id_prefix + ":" + c[COL_GEONAMEID];
        const std::string admin1_key =
            c[COL_COUNTRY_CODE].empty() || c[COL_ADMIN1].empty()
                ? std::string()
                : c[COL_COUNTRY_CODE] + "." + c[COL_ADMIN1];
        const std::string admin2_key =
            admin1_key.empty() || c[COL_ADMIN2].empty() ? std::string()
                                                        : admin1_key + "." + c[COL_ADMIN2];
        const std::string admin1_name = lookup_or_empty(tables.admin1, admin1_key);
        const std::string admin2_name = lookup_or_empty(tables.admin2, admin2_key);
        const std::string country_name = lookup_or_empty(tables.country, c[COL_COUNTRY_CODE]);

        const auto f_id = b.CreateString(record_id);
        const auto f_name = b.CreateString(c[COL_NAME]);
        const auto f_ascii = c[COL_ASCIINAME].empty() ? 0 : b.CreateString(c[COL_ASCIINAME]);
        const auto f_class_code =
            c[COL_FEATURE_CLASS].empty() ? 0 : b.CreateString(c[COL_FEATURE_CLASS]);
        const auto f_feature_code =
            c[COL_FEATURE_CODE].empty() ? 0 : b.CreateString(c[COL_FEATURE_CODE]);
        const auto f_country_code =
            c[COL_COUNTRY_CODE].empty() ? 0 : b.CreateString(c[COL_COUNTRY_CODE]);
        const auto f_country_name = country_name.empty() ? 0 : b.CreateString(country_name);
        const auto f_admin1_code = c[COL_ADMIN1].empty() ? 0 : b.CreateString(c[COL_ADMIN1]);
        const auto f_admin1_name = admin1_name.empty() ? 0 : b.CreateString(admin1_name);
        const auto f_admin2_code = c[COL_ADMIN2].empty() ? 0 : b.CreateString(c[COL_ADMIN2]);
        const auto f_admin2_name = admin2_name.empty() ? 0 : b.CreateString(admin2_name);
        const auto f_admin3_code = c[COL_ADMIN3].empty() ? 0 : b.CreateString(c[COL_ADMIN3]);
        const auto f_admin4_code = c[COL_ADMIN4].empty() ? 0 : b.CreateString(c[COL_ADMIN4]);
        const auto f_timezone = c[COL_TIMEZONE].empty() ? 0 : b.CreateString(c[COL_TIMEZONE]);
        const auto f_dem_model = contract.dem_model.empty() || c[COL_DEM].empty()
                                     ? 0
                                     : b.CreateString(contract.dem_model);

        GNPBuilder gb(b);
        gb.add_ID(f_id);
        gb.add_NAME(f_name);
        if (f_ascii.o) gb.add_ASCII_NAME(f_ascii);
        if (!alternates.empty()) gb.add_ALTERNATE_NAMES(alternates_vec);
        gb.add_LATITUDE(lat);
        gb.add_LONGITUDE(lon);
        // ELEVATION_PUBLISHED is the whole point of the field: an unpublished
        // elevation is zero-and-false, a surveyed sea-level place is
        // zero-and-TRUE, and the two are never the same record.
        if (!c[COL_ELEVATION].empty()) {
            gb.add_ELEVATION_M(strtod(c[COL_ELEVATION].c_str(), nullptr));
            gb.add_ELEVATION_PUBLISHED(true);
        }
        // The DEM sample is kept in its own field, never substituted for a
        // survey: "a model sample is not a survey".
        if (!c[COL_DEM].empty()) gb.add_DEM_ELEVATION_M(strtod(c[COL_DEM].c_str(), nullptr));
        if (f_dem_model.o) gb.add_DEM_MODEL(f_dem_model);
        gb.add_FEATURE_CLASS(feature_class_of(c[COL_FEATURE_CLASS]));
        if (f_class_code.o) gb.add_FEATURE_CLASS_CODE(f_class_code);
        if (f_feature_code.o) gb.add_FEATURE_CODE(f_feature_code);
        if (f_country_code.o) gb.add_COUNTRY_CODE(f_country_code);
        if (f_country_name.o) gb.add_COUNTRY_NAME(f_country_name);
        if (!cc2.empty()) gb.add_ALTERNATE_COUNTRY_CODES(cc2_vec);
        if (f_admin1_code.o) gb.add_ADMIN1_CODE(f_admin1_code);
        if (f_admin1_name.o) gb.add_ADMIN1_NAME(f_admin1_name);
        if (f_admin2_code.o) gb.add_ADMIN2_CODE(f_admin2_code);
        if (f_admin2_name.o) gb.add_ADMIN2_NAME(f_admin2_name);
        if (f_admin3_code.o) gb.add_ADMIN3_CODE(f_admin3_code);
        if (f_admin4_code.o) gb.add_ADMIN4_CODE(f_admin4_code);
        if (!c[COL_POPULATION].empty()) {
            gb.add_POPULATION(static_cast<int64_t>(strtoll(c[COL_POPULATION].c_str(), nullptr, 10)));
        }
        if (f_timezone.o) gb.add_TIME_ZONE_ID(f_timezone);
        gb.add_SOURCE(provenance);
        FinishGNPBuffer(b, gb.Finish());

        const uint32_t len = b.GetSize();
        stream.push_back(static_cast<uint8_t>(len & 0xff));
        stream.push_back(static_cast<uint8_t>((len >> 8) & 0xff));
        stream.push_back(static_cast<uint8_t>((len >> 16) & 0xff));
        stream.push_back(static_cast<uint8_t>((len >> 24) & 0xff));
        stream.insert(stream.end(), b.GetBufferPointer(), b.GetBufferPointer() + len);
        written++;
        return true;
    });

    // A CROPPED ANSWER MUST SAY SO. `truncated` is the difference between "the
    // gazetteer published this many places" and "we stopped counting", and a
    // partial edition that reads as a complete one is the failure mode this
    // whole repo keeps re-learning.
    const std::string decision =
        std::string("{\"lane\":\"") + json_escape(json_string(job, "lane", "seed")) + "\"" +
        ",\"format\":\"record-stream\",\"schema\":\"GNP\"" +
        ",\"rowsIn\":" + std::to_string(rows_in) + ",\"recordsOut\":" + std::to_string(written) +
        ",\"skippedShortRow\":" + std::to_string(skipped_short) +
        ",\"skippedNoIdentity\":" + std::to_string(skipped_identity) +
        ",\"skippedOutOfRange\":" + std::to_string(skipped_position) +
        ",\"truncated\":" + (truncated ? "true" : "false") + ",\"datasetId\":\"" +
        json_escape(contract.dataset_id) + "\"" + ",\"datasetEpoch\":\"" +
        json_escape(contract.dataset_epoch) + "\"" + ",\"retrievedAt\":\"" +
        json_escape(retrieved_at) + "\"" + ",\"admin1Resolved\":" +
        std::to_string(tables.admin1.size()) + ",\"admin2Resolved\":" +
        std::to_string(tables.admin2.size()) + ",\"countriesResolved\":" +
        std::to_string(tables.country.size()) + "}";

    if (push_gnp_stream("records", stream) < 0) return 500;
    return push_json("decision", decision) < 0 ? 500 : 0;
}

// ---------------------------------------------------------------------------
// parse_deletes — `deletes-YYYY-MM-DD.txt` -> the tombstone list.
//
// Three tab-separated columns: geonameid TAB name TAB reason (verified live
// 2026-08-15). The reason is carried verbatim because it is the only record of
// WHY a place left the gazetteer — "duplicate" and "not a real place" are
// different facts about the same id, and a consumer reconciling its own copy
// needs to be able to tell them apart.
//
// THIS METHOD EMITS A LIST, NOT A DELETION. There is no host capability that
// removes a stored row: hostcap/storage-ingest offers `ingest` only, and
// hostcap/flatsql-query is read-only. Inventing a delete op would be a new host
// capability, which this lane may not add. So the tombstones ride out of the
// flow on their own port, exactly as the cellular lane's resume mark does, and
// closing that loop needs one durable delete lane — recorded as a gap rather
// than papered over with a fake.
// ---------------------------------------------------------------------------
int parse_deletes(void) {
    if (refuse_batched()) return 500;

    const std::string job = input_text("job");
    const int32_t text_index = plugin_find_input_index("text", 0);
    if (text_index < 0) {
        plugin_set_error("missing-text-frame",
                         "parse_deletes requires the deletes text on port \"text\".");
        return 400;
    }
    const plugin_input_frame_t* frame = plugin_get_input_frame(static_cast<uint32_t>(text_index));
    const std::string text =
        frame && frame->payload ? std::string(reinterpret_cast<const char*>(frame->payload),
                                              frame->payload_length)
                                : std::string();

    const std::string prefix = json_string(job, "id_prefix", "geonames");
    std::string entries;
    long rows_in = 0, written = 0, skipped = 0;
    for_each_line(text, [&](const std::string& line) -> bool {
        if (line.empty() || line[0] == '#') return true;
        rows_in++;
        const std::vector<std::string> c = split_tabs(line);
        if (c.empty() || c[0].empty()) { skipped++; return true; }
        // A row whose first column is not an id is not a tombstone. GeoNames
        // serves an HTML 404 body for a day it no longer retains, and decoding
        // that to "delete everything named <html>" is precisely the class of
        // failure this guard exists for.
        for (const char ch : c[0]) {
            if (ch < '0' || ch > '9') { skipped++; return true; }
        }
        if (written) entries += ",";
        entries += "{\"native_id\":\"" + json_escape(c[0]) + "\",\"id\":\"" +
                   json_escape(prefix + ":" + c[0]) + "\",\"name\":\"" +
                   json_escape(c.size() > 1 ? c[1] : std::string()) + "\",\"reason\":\"" +
                   json_escape(c.size() > 2 ? c[2] : std::string()) + "\"}";
        written++;
        return true;
    });

    const std::string out =
        std::string("{\"lane\":\"deletes\",\"datasetId\":\"") +
        json_escape(json_string(job, "dataset_id", "")) + "\"" + ",\"datasetEpoch\":\"" +
        json_escape(json_string(job, "dataset_epoch", "")) + "\"" +
        ",\"rowsIn\":" + std::to_string(rows_in) + ",\"tombstones\":" + std::to_string(written) +
        ",\"skipped\":" + std::to_string(skipped) + ",\"entries\":[" + entries + "]}";

    return push_json("tombstones", out) < 0 ? 500 : 0;
}

}  // extern "C"
