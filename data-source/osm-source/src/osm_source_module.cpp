// osm-source: the OSM context epoch record, served.
//
// One method, route(): a $HTQ HttpRequest in, one $HTR HttpResponse out.
// The epoch bytes (the FlatGeobuf files) never pass through here — clients
// range-read them from the node's IPFS gateway under the CID this module
// names. So this module's whole job is to answer ONE question truthfully:
// which epoch is this node serving, and where do its files live relative to
// this origin.
//
// Config: one ModuleConfig (MCFG) - plugin.getConfig over the SDS $PIV hostcall
// (sdm_piv::get_config(), typedHostcall.hpp), or the optional "config" input
// frame, the same ModuleConfig. Read in place, once per instance (per distinct
// frame):
//   osm_mount_path     the mount prefix (default "/api/v1/osm/")
//   osm_gateway_path   the node's gateway path (default "/ipfs/")
//   osm_epoch_cid      the pinned epoch directory's CID (required for a record)
//   osm_epoch_record   the record build-fgb.mjs wrote (osm-context.fgb.json),
//                      as an OBJECT (a TableList of one table in the
//                      ModuleConfig; required for a record)
//   osm_attribution    discovery-document attribution
//                      (default "© OpenStreetMap contributors")
//
// The helpers (SHA-256 multihash ETag, the $HTR push, the batched-frame
// refusal) are the ones terrain-source
// carries, trimmed to what a record route needs; the comments there say why
// each exists and are not repeated here.

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "ModuleConfig_generated.h"
// The SDK's $HTQ / $HTR envelope headers are inlined ahead of this file by source.mjs.

namespace {

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

// Every port here is single-stream; a surplus frame is refused, not dropped
// (the compiled flow runtime drains a node's queue port-blind).
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
        if (on_port <= 1u) continue;
        std::snprintf(message, message_len,
                      "This invocation carries %u frames on input port \"%s\" whose contract "
                      "admits 1 (the compiled flow runtime drains a node's whole queue "
                      "port-blind; maxStreams is declarative only). The surplus frames are "
                      "refused rather than silently discarded.",
                      on_port, frame->port_id);
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

// ── SHA-256 as a lowercase-hex multihash (the ETag) ────────────────────────
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

    std::string multihash_hex() {
        const uint64_t bits = total_bits;
        uint8_t pad = 0x80;
        update(&pad, 1);
        total_bits = bits;
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

std::string sha256_multihash(const std::string& bytes) {
    Sha256 sha;
    if (!bytes.empty()) sha.update(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size());
    return sha.multihash_hex();
}

}  // namespace

namespace {

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

// Every JSON response carries nosniff and an explicit cache policy.
int push_htr_json(uint16_t status, const std::string& body, const char* cache_control) {
    std::vector<HeaderEntry> headers = {
        {"content-type", "application/json"},
        {"x-content-type-options", "nosniff"},
        {"cache-control", cache_control && *cache_control ? cache_control : "no-store"},
    };
    return push_htr(status, headers,
                    reinterpret_cast<const uint8_t*>(body.data()), body.size());
}

// A public, cacheable, conditional JSON document: the two mutable pointers of
// this lane (the record and the discovery document) both answer this way.
int push_public_json(const std::string& body, const std::string& if_none_match) {
    const std::string etag = "\"" + sha256_multihash(body) + "\"";
    std::vector<HeaderEntry> headers = {{"content-type", "application/json"},
                                        {"x-content-type-options", "nosniff"},
                                        {"cache-control", "public, max-age=60"},
                                        {"etag", etag},
                                        {"access-control-allow-origin", "*"}};
    if (!if_none_match.empty() && if_none_match == etag) {
        return push_htr(304, headers, nullptr, 0);
    }
    return push_htr(200, headers, reinterpret_cast<const uint8_t*>(body.data()), body.size());
}

// ── the record, rendered from the typed config ─────────────────────────────
//
// The ModuleConfig keeps every value the record holds (strings, numbers,
// booleans, lists, nested objects as TableLists) but neither JSON's key order
// nor its nulls: entries are sorted by KEY and a null is left out (Go node and
// SDK alike). The record is served in the builder's own key order
// (tools/osm-context/build-fgb.mjs, FORMAT osm-context-fgb/1), the keys it always
// writes as null (FILES[].WHERE, PROVENANCE.OCEAN) answered as null when absent,
// and any key the builder does not write appended after them in KEY order, so
// nothing configured is dropped.

std::string json_number(double v) {
    char buf[40];
    if (v == static_cast<double>(static_cast<int64_t>(v)) && v > -1e18 && v < 1e18) {
        std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(v));
        return buf;
    }
    for (int precision = 15; precision <= 17; precision++) {
        std::snprintf(buf, sizeof(buf), "%.*g", precision, v);
        if (std::strtod(buf, nullptr) == v) break;
    }
    return buf;
}

std::string json_string_value(std::string_view s) { return "\"" + json_escape(std::string(s)) + "\""; }

struct KeyOrder {
    const char* key;
    bool null_when_absent;
};

// The builder's key orders, per nested table of the record.
const KeyOrder kFileOrder[] = {{"NAME", false},  {"CATEGORY", false},      {"KIND", false},
                               {"MEDIA_TYPE", false}, {"BYTES", false},    {"SHA256", false},
                               {"FEATURE_COUNT", false}, {"LAYER", false}, {"WHERE", true}};
const KeyOrder kProvenanceOrder[] = {{"SOURCE", false},    {"SOURCE_URL", false}, {"RETRIEVED_AT", false},
                                     {"PROCESSOR", false}, {"LICENSE", false},    {"SHARE_ALIKE", false},
                                     {"ATTRIBUTION", false}, {"OCEAN", true}};
const KeyOrder kOceanOrder[] = {{"SOURCE_URL", false}, {"SHA256", false}, {"FILES_DATED", false}, {"LICENSE", false}};

std::string render_table(const sdm_piv::ConfigTable& table, const KeyOrder* order, size_t order_count);

// Which nested values are objects (one table) and which are lists of objects;
// a TableList cannot say, the record's format does.
bool is_object_key(std::string_view key) { return key == "PAYLOAD" || key == "PROVENANCE" || key == "OCEAN"; }

std::string render_entry(const sdn::runtime::ConfigEntry* e) {
    const std::string_view key = e->KEY() ? std::string_view(e->KEY()->c_str(), e->KEY()->size()) : std::string_view();
    switch (e->KIND()) {
        case sdn::runtime::configValueKind_String:
            return json_string_value(e->STRING_VALUE() ? e->STRING_VALUE()->string_view() : std::string_view());
        case sdn::runtime::configValueKind_Number:
            return json_number(e->NUMBER_VALUE());
        case sdn::runtime::configValueKind_Bool:
            return e->BOOL_VALUE() ? "true" : "false";
        case sdn::runtime::configValueKind_StringList: {
            std::string out = "[";
            if (e->STRINGS()) {
                for (const auto* item : *e->STRINGS()) {
                    if (out.size() > 1) out += ",";
                    out += json_string_value(item ? item->string_view() : std::string_view());
                }
            }
            return out + "]";
        }
        case sdn::runtime::configValueKind_NumberList: {
            std::string out = "[";
            if (e->NUMBERS()) {
                for (const double item : *e->NUMBERS()) {
                    if (out.size() > 1) out += ",";
                    out += json_number(item);
                }
            }
            return out + "]";
        }
        case sdn::runtime::configValueKind_TableList: {
            const KeyOrder* order = nullptr;
            size_t order_count = 0;
            if (key == "FILES") { order = kFileOrder; order_count = sizeof(kFileOrder) / sizeof(kFileOrder[0]); }
            else if (key == "PROVENANCE") { order = kProvenanceOrder; order_count = sizeof(kProvenanceOrder) / sizeof(kProvenanceOrder[0]); }
            else if (key == "OCEAN") { order = kOceanOrder; order_count = sizeof(kOceanOrder) / sizeof(kOceanOrder[0]); }
            const auto* tables = e->TABLES();
            if (is_object_key(key) && tables && tables->size() == 1) {
                return render_table(sdm_piv::ConfigTable(tables->Get(0)->ENTRIES()), order, order_count);
            }
            std::string out = "[";
            if (tables) {
                for (const auto* t : *tables) {
                    if (out.size() > 1) out += ",";
                    out += render_table(sdm_piv::ConfigTable(t ? t->ENTRIES() : nullptr), order, order_count);
                }
            }
            return out + "]";
        }
        default:
            return "null";
    }
}

std::string render_table(const sdm_piv::ConfigTable& table, const KeyOrder* order, size_t order_count) {
    std::string out = "{";
    auto add = [&](std::string_view key, const std::string& value) {
        if (out.size() > 1) out += ",";
        out += json_string_value(key) + ":" + value;
    };
    for (size_t i = 0; i < order_count; i++) {
        const sdn::runtime::ConfigEntry* e = nullptr;
        if (table.entries()) {
            for (const auto* candidate : *table.entries()) {
                if (candidate->KEY() && candidate->KEY()->string_view() == order[i].key) { e = candidate; break; }
            }
        }
        if (e) add(order[i].key, render_entry(e));
        else if (order[i].null_when_absent) add(order[i].key, "null");
    }
    if (table.entries()) {
        for (const auto* e : *table.entries()) {
            if (!e->KEY()) continue;
            const std::string_view key = e->KEY()->string_view();
            bool ordered = false;
            for (size_t i = 0; i < order_count && !ordered; i++) ordered = key == order[i].key;
            if (!ordered) add(key, render_entry(e));
        }
    }
    return out + "}";
}

// The nested table's entry by exact key (no dotted-path resolution: record keys
// never contain dots, and an exact lookup cannot wander into a neighbour).
const sdn::runtime::ConfigEntry* exact_entry(const sdm_piv::ConfigTable& table, const char* key) {
    if (!table.entries()) return nullptr;
    for (const auto* e : *table.entries()) {
        if (e->KEY() && e->KEY()->string_view() == key) return e;
    }
    return nullptr;
}

std::string table_string(const sdm_piv::ConfigTable& table, const char* key) {
    const auto* e = exact_entry(table, key);
    return e && e->KIND() == sdn::runtime::configValueKind_String && e->STRING_VALUE() ? e->STRING_VALUE()->str()
                                                                                     : std::string();
}

std::string ensure_trailing_slash(std::string s) {
    if (s.empty() || s.back() != '/') s.push_back('/');
    return s;
}

struct ServingConfig {
    std::string mount_prefix = "/api/v1/osm/";
    std::string gateway_path = "/ipfs/";
    std::string epoch_cid;
    bool has_record = false;
    std::string record_body;    // the record as served (rendered once; empty without one or a CID)
    std::string epoch_id;       // the record's TILESET_ID
    std::string dataset_epoch;  // the record's DATASET_EPOCH
    std::string attribution = "© OpenStreetMap contributors";
};

bool looks_like_cid(const std::string& cid);
std::string render_record(const sdm_piv::ConfigTable& record, const ServingConfig& cfg);

// Everything the route needs, copied out of the ModuleConfig (so the host's
// response is held only while it is read).
ServingConfig build_serving_config(const sdm_piv::ConfigTable& config) {
    ServingConfig sc;
    sc.mount_prefix = ensure_trailing_slash(std::string(config.string("osm_mount_path", "/api/v1/osm/")));
    sc.gateway_path = ensure_trailing_slash(std::string(config.string("osm_gateway_path", "/ipfs/")));
    sc.epoch_cid = std::string(config.string("osm_epoch_cid", ""));
    sc.attribution = std::string(config.string("osm_attribution", "© OpenStreetMap contributors"));
    const auto* record_entry = exact_entry(config, "osm_epoch_record");
    if (record_entry && record_entry->KIND() == sdn::runtime::configValueKind_TableList && record_entry->TABLES() &&
        record_entry->TABLES()->size() == 1) {
        const sdm_piv::ConfigTable record(record_entry->TABLES()->Get(0)->ENTRIES());
        sc.has_record = true;
        sc.epoch_id = table_string(record, "TILESET_ID");
        sc.dataset_epoch = table_string(record, "DATASET_EPOCH");
        if (looks_like_cid(sc.epoch_cid)) sc.record_body = render_record(record, sc);
    }
    return sc;
}

const ServingConfig& serving_config() {
    static ServingConfig* cached = nullptr;
    if (!cached) {
        const sdm_piv::Config config = sdm_piv::get_config();
        cached = new ServingConfig(build_serving_config(config.ok() ? static_cast<const sdm_piv::ConfigTable&>(config)
                                                                    : sdm_piv::ConfigTable()));
    }
    return *cached;
}

// A CID is base58btc (Qm..., 46 chars) or base32 lower-case (b..., >= 59).
bool looks_like_cid(const std::string& cid) {
    if (cid.size() == 46 && cid[0] == 'Q' && cid[1] == 'm') {
        for (const char c : cid) {
            if (!((c >= '1' && c <= '9') || (c >= 'A' && c <= 'H') || (c >= 'J' && c <= 'N') ||
                  (c >= 'P' && c <= 'Z') || (c >= 'a' && c <= 'k') || (c >= 'm' && c <= 'z'))) {
                return false;
            }
        }
        return true;
    }
    if (cid.size() >= 59 && cid[0] == 'b') {
        for (const char c : cid) {
            if (!((c >= 'a' && c <= 'z') || (c >= '2' && c <= '7'))) return false;
        }
        return true;
    }
    return false;
}

// The record as served: the builder's document with PAYLOAD.CID set to the
// pinned CID and EPOCH_BASE_PATH added, the rest rendered from the typed config
// in the builder's key order (see render_table).
std::string render_record(const sdm_piv::ConfigTable& r, const ServingConfig& cfg) {
    std::string out = "{";
    const char* copied[] = {"FORMAT", "TILESET_ID", "REGION", "CRS"};
    for (const char* key : copied) {
        if (const auto* e = exact_entry(r, key)) out += std::string("\"") + key + "\":" + render_entry(e) + ",";
    }
    std::string size_bytes = "0";
    std::string media_type = "\"application/vnd.ipld.dag-pb\"";
    const auto* payload = exact_entry(r, "PAYLOAD");
    if (payload && payload->KIND() == sdn::runtime::configValueKind_TableList && payload->TABLES() &&
        payload->TABLES()->size() == 1) {
        const sdm_piv::ConfigTable p(payload->TABLES()->Get(0)->ENTRIES());
        if (const auto* e = exact_entry(p, "SIZE_BYTES")) size_bytes = render_entry(e);
        if (const auto* e = exact_entry(p, "MEDIA_TYPE")) media_type = render_entry(e);
    }
    out += "\"PAYLOAD\":{\"CID\":\"" + json_escape(cfg.epoch_cid) + "\",\"SIZE_BYTES\":" +
           size_bytes + ",\"MEDIA_TYPE\":" + media_type + "},";
    out += "\"EPOCH_BASE_PATH\":\"" + json_escape(cfg.gateway_path + cfg.epoch_cid + "/") + "\",";
    const char* tail[] = {"FILES", "DATASET_EPOCH", "PROVENANCE"};
    for (const char* key : tail) {
        if (const auto* e = exact_entry(r, key)) out += std::string("\"") + key + "\":" + render_entry(e) + ",";
    }
    if (out.back() == ',') out.pop_back();
    out += "}";
    return out;
}

}  // namespace

extern "C" {

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
                                            {"content-type", "application/json"},
                                            {"x-content-type-options", "nosniff"},
                                            {"cache-control", "no-store"}};
        const std::string body = "{\"error\":\"method not allowed\"}";
        return push_htr(405, headers, reinterpret_cast<const uint8_t*>(body.data()),
                        body.size());
    }
    const std::string path = request->PATH() ? request->PATH()->str() : "";

    // The optional "config" frame: a ModuleConfig, the same entries
    // plugin.getConfig answers (built once per distinct frame). Absent, the
    // config is read over the hostcall once per instance.
    static std::string* frame_config_key = new std::string();
    static ServingConfig* frame_config_value = new ServingConfig();
    const int32_t config_index = plugin_find_input_index("config", 0);
    const plugin_input_frame_t* config_frame =
        config_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(config_index)) : nullptr;
    const bool framed = config_frame && config_frame->payload && config_frame->payload_length > 0;
    if (framed) {
        const std::string bytes(reinterpret_cast<const char*>(config_frame->payload), config_frame->payload_length);
        if (*frame_config_key != bytes) {
            ::flatbuffers::Verifier config_verifier(config_frame->payload, config_frame->payload_length);
            if (config_frame->payload_length < 8 || !sdn::runtime::VerifyModuleConfigBuffer(config_verifier)) {
                plugin_set_error("invalid-config-frame", "the config frame is not a ModuleConfig (MCFG).");
                return 400;
            }
            *frame_config_value = build_serving_config(
                sdm_piv::ConfigTable(sdn::runtime::GetModuleConfig(config_frame->payload)->ENTRIES()));
            *frame_config_key = bytes;
        }
    }
    const ServingConfig& cfg = framed ? *frame_config_value : serving_config();

    // If-None-Match, bounded at the door (every ETag here is 71 bytes).
    constexpr size_t kMaxIfNoneMatchBytes = 256;
    std::string if_none_match;
    if (request->HEADERS()) {
        for (const auto* h : *request->HEADERS()) {
            if (!h->NAME() || !h->VALUE()) continue;
            std::string name = h->NAME()->str();
            for (auto& c : name) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
            if (name == "if-none-match" && h->VALUE()->size() <= kMaxIfNoneMatchBytes) {
                if_none_match = h->VALUE()->str();
            }
        }
    }

    const std::string& mount_prefix = cfg.mount_prefix;
    if (path.size() < mount_prefix.size() ||
        path.compare(0, mount_prefix.size(), mount_prefix) != 0) {
        return push_htr_json(404, "{\"error\":\"not found\",\"detail\":\"outside the OSM context mount\"}",
                             "no-store");
    }
    const std::string rest = path.substr(mount_prefix.size());
    const bool configured = cfg.has_record && looks_like_cid(cfg.epoch_cid);

    if (rest == "tileset.json") {
        if (!configured) {
            std::string missing;
            if (!cfg.has_record) missing += "\"osm_epoch_record\"";
            if (!looks_like_cid(cfg.epoch_cid)) {
                if (!missing.empty()) missing += ",";
                missing += "\"osm_epoch_cid\"";
            }
            return push_htr_json(
                503,
                "{\"error\":\"osm context epoch not configured\",\"detail\":\"this node has "
                "no pinned FlatGeobuf epoch to name; set the missing flow config keys and "
                "restart\",\"missingConfigKeys\":[" + missing + "]}",
                "no-store");
        }
        return push_public_json(cfg.record_body, if_none_match);
    }

    if (rest.empty() || rest == "catalogue.json") {
        const std::string epoch_id = configured ? cfg.epoch_id : std::string();
        const std::string dataset_epoch =
            configured ? cfg.dataset_epoch : std::string();
        const std::string base = configured ? cfg.gateway_path + cfg.epoch_cid + "/" : "";
        std::string body = "{\"epochId\":" +
                           (epoch_id.empty() ? std::string("null") : "\"" + json_escape(epoch_id) + "\"") +
                           ",\"delivery\":\"" + (configured ? "ipfs" : "none") + "\"" +
                           ",\"cid\":" + (configured ? "\"" + json_escape(cfg.epoch_cid) + "\"" : "null") +
                           ",\"datasetEpoch\":" +
                           (dataset_epoch.empty() ? std::string("null") : "\"" + json_escape(dataset_epoch) + "\"") +
                           ",\"epochBasePath\":" + (configured ? "\"" + json_escape(base) + "\"" : "null") +
                           ",\"recordPath\":\"" + json_escape(mount_prefix + "tileset.json") + "\"" +
                           ",\"format\":\"osm-context-fgb/1\"" +
                           ",\"attribution\":\"" + json_escape(cfg.attribution) + "\"}";
        return push_public_json(body, if_none_match);
    }

    return push_htr_json(404, "{\"error\":\"not found\",\"detail\":\"not an OSM context route\"}",
                         "no-store");
}

}  // extern "C"
