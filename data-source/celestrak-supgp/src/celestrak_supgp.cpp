/*
 * CelesTrak SupGP (multi-provider supplemental OMM) data-source module (A2.9), on the typed contracts (1.0):
 * FlatBuffers only, no JSON between modules and no base64.
 *
 * OWNER DIRECTIVE ("we should have more providers than this"): grow the catalog's honest coverage for the A2.1
 * providers whose RAW operator ephemeris is NOT public, by ingesting CelesTrak's PUBLISHED Supplemental GP (SupGP)
 * OMM sets.
 *
 * ─── WHAT THIS IS (and just as importantly, what it is NOT) ──────────────────
 * ONE generic, token-parameterized source driven by a data-driven SOURCE-token registry (below; node config may
 * name one token instead). Two flow nodes:
 *   request: the flow's TimerTick (TICK) -> one GET HttpRequest (HREQ) per registry token, for hostcap/http-request,
 *            https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=<token>&FORMAT=<JSON|CSV>
 *            Each request's CONTEXT is the parse job: ONE size-prefixed SDS $ICN record (endpoint, the provider's
 *            source name, the token as DATASET_ID supgp-<token>, CelesTrak origin and usage terms), echoed by
 *            hostcap/http-request in its HttpResponse.
 *   parse:   one HttpResponse (HRSP) -> the token's batch for hostcap/storage-ingest: an IngestRequest (INGQ) on
 *            omm_meta, the size-prefixed $OMM record stream on omm_records, the response itself on raw (the
 *            archived document). A 304 is a FlowNotice Unchanged; a transport error or another status is a
 *            FlowNotice Missing (supgp-unavailable). A response without the $ICN job is refused (missing-context).
 * Storing, signing and publishing are the flow's (hostcap/storage-ingest and the flow's publication step); this
 * module performs no I/O. Its only hostcall is plugin.getConfig (sdm_piv, one ModuleConfig read in place).
 *
 * HONESTY MODEL (critical). These OMMs are CELESTRAK-FITTED mean elements, NOT our OD and NOT the operator's raw
 * product. Every record is marked NON-INDEPENDENT so catalog synthesis and the status board keep them in their own
 * lane and they NEVER count as "our OD":
 *   - SourceTags.SOURCE_NAME = the provider registry token's source name (ses / planet / iridium / telesat /
 *     kuiper / ast-spacemobile / css) — distinct per provider, and distinct from every Tier-1 adapter's.
 *   - USER_DEFINED SDN_DATA_SOURCE = "CelesTrak SupGP", SDN_INDEPENDENT = "false" (the NON-INDEPENDENT flag).
 *   - the COMMENT states the same in prose.
 *   - CelesTrak's own fit residual (RMS) and DATA_SOURCE token are kept as USER_DEFINED SDN_CELESTRAK_RMS /
 *     SDN_CELESTRAK_DATA_SOURCE (they are not OMM keywords, so they are USER_DEFINED parameters).
 * SYNTHESIS CONFIG (data, not code — owned by analysis/catalog-synthesis): each source name must be listed in its
 * config/provider-gate-status.json at a NON-hard-pass level so it is published but NEVER outranks Space-Track GP.
 *
 * FRAME/TIME. SupGP OMMs are SGP4 mean elements by construction — TEME / UTC / EARTH, MEAN_ELEMENT_THEORY SGP4,
 * declared explicitly; element VALUES are copied faithfully at full double precision, EPOCH as the feed writes it.
 *
 * POLITENESS (analysis/conjunction-assessment/scripts/CELESTRAK_FETCH_POLICY.md): one token = one query per cycle
 * (the registry is de-duplicated); the flow's trigger sets the cadence (SupGP refreshes every 2 h). The legacy
 * in-module loop halted the remaining tokens on a non-200; the typed requests go out together and a failed token is
 * a FlowNotice Missing on its own.
 */

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"
#include "IngestRequest_generated.h"
#include "FlowNotice_generated.h"
// The SDS standards (RFM, TIM, MET, CVR, PVN, OMM, ICN: spacedatastandards.org lib/cpp/<CODE>/main_generated.h) are
// inlined ahead of this file by build.mjs.

namespace {

namespace R = sdn::runtime;

constexpr const char* kDefaultBaseUrl = "https://celestrak.org/NORAD/elements/supplemental/sup-gp.php";
constexpr const char* kDefaultFormat = "JSON";
constexpr long kDefaultObjectCap = 2000;
constexpr const char* kDataSource = "CelesTrak SupGP";  // the NON-INDEPENDENT lane label
constexpr const char* kDatasetPrefix = "supgp-";        // DATASET_ID = supgp-<token>

// Upstream origin and its usage terms, as data-source/celestrak-request names them (quoted verbatim from
// https://celestrak.org/usage-policy.php; an operator overrides them through node config).
constexpr const char* kOriginID = "celestrak.org";
constexpr const char* kOriginName = "CelesTrak";
constexpr const char* kDefaultProviderID = "space-data-network-02";
constexpr const char* kSourcePeer = "source:celestrak";
constexpr const char* kContentKeyID = "public";
constexpr const char* kArchiveSource = "celestrak";
constexpr const char* kDefaultLicense =
    "Only download the data you need, when you are going to use it, and only download data "
    "once per update.";
constexpr const char* kDefaultLicenseURL = "https://celestrak.org/usage-policy.php";
constexpr const char* kDefaultCitation =
    "CelesTrak Usage Policy, by Dr. T.S. Kelso, https://celestrak.org/usage-policy.php";

struct RegistryEntry {
    const char* token;        // CelesTrak SOURCE token
    const char* source_name;  // SDN provider source name (distinct per provider)
};

const RegistryEntry kRegistry[] = {
    {"SES-E", "ses"},       {"Planet", "planet"},     {"Iridium", "iridium"},       {"Telesat", "telesat"},
    {"Kuiper-E", "kuiper"}, {"AST", "ast-spacemobile"}, {"CSS-E", "css"},
};

using Bytes = std::vector<uint8_t>;

// ── small text helpers ──────────────────────────────────────────────────────

bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

std::string trim(const std::string& in) {
    size_t a = 0, b = in.size();
    while (a < b && is_ws(in[a])) a++;
    while (b > a && is_ws(in[b - 1])) b--;
    return in.substr(a, b - a);
}

std::string to_lower(const std::string& in) {
    std::string s = in;
    for (char& c : s) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    return s;
}

std::vector<std::string> split_char(const std::string& s, char sep) {
    std::vector<std::string> out;
    size_t start = 0;
    for (size_t i = 0; i <= s.size(); ++i) {
        if (i == s.size() || s[i] == sep) {
            out.push_back(s.substr(start, i - start));
            start = i + 1;
        }
    }
    return out;
}

// ── the SupGP feed (external JSON or CSV, read as text) ─────────────────────

// A string field of a flat JSON object ("KEY":"value"), JSON escapes resolved for \" \\ \/.
bool json_string_field(const std::string& obj, const std::string& key, std::string* out) {
    const std::string needle = "\"" + key + "\"";
    size_t k = obj.find(needle);
    if (k == std::string::npos) return false;
    size_t i = obj.find(':', k + needle.size());
    if (i == std::string::npos) return false;
    i++;
    while (i < obj.size() && is_ws(obj[i])) i++;
    if (i >= obj.size() || obj[i] != '"') return false;
    std::string v;
    for (i++; i < obj.size() && obj[i] != '"'; i++) {
        if (obj[i] == '\\' && i + 1 < obj.size()) i++;
        v.push_back(obj[i]);
    }
    *out = v;
    return true;
}

double json_double_field(const std::string& obj, const std::string& key, double fallback) {
    const std::string needle = "\"" + key + "\"";
    size_t k = obj.find(needle);
    if (k == std::string::npos) return fallback;
    size_t colon = obj.find(':', k + needle.size());
    if (colon == std::string::npos) return fallback;
    size_t i = colon + 1;
    while (i < obj.size() && (is_ws(obj[i]) || obj[i] == '"')) i++;  // tolerate a quoted number
    return strtod(obj.c_str() + i, nullptr);
}

long json_long_field(const std::string& obj, const std::string& key, long fallback) {
    const std::string needle = "\"" + key + "\"";
    size_t k = obj.find(needle);
    if (k == std::string::npos) return fallback;
    size_t colon = obj.find(':', k + needle.size());
    if (colon == std::string::npos) return fallback;
    size_t i = colon + 1;
    while (i < obj.size() && (is_ws(obj[i]) || obj[i] == '"')) i++;
    char* end = nullptr;
    const long v = strtol(obj.c_str() + i, &end, 10);
    return end == obj.c_str() + i ? fallback : v;
}

std::vector<std::string> split_json_objects(const std::string& s) {
    std::vector<std::string> objs;
    int depth = 0;
    bool instr = false, esc = false;
    size_t start = std::string::npos;
    for (size_t i = 0; i < s.size(); ++i) {
        const char c = s[i];
        if (instr) {
            if (esc) esc = false;
            else if (c == '\\') esc = true;
            else if (c == '"') instr = false;
            continue;
        }
        if (c == '"') { instr = true; continue; }
        if (c == '{') { if (depth == 0) start = i; depth++; }
        else if (c == '}' && depth > 0) {
            depth--;
            if (depth == 0 && start != std::string::npos) {
                objs.push_back(s.substr(start, i - start + 1));
                start = std::string::npos;
            }
        }
    }
    return objs;
}

struct Omm {
    std::string object_name, object_id, epoch, classification_type;
    std::string rms;          // CelesTrak fit residual (a string in the feed)
    std::string data_source;  // CelesTrak DATA_SOURCE token (e.g. SES-E, AST-E)
    double mean_motion = 0, eccentricity = 0, inclination = 0;
    double raan = 0, argp = 0, mean_anomaly = 0;
    double bstar = 0, mm_dot = 0, mm_ddot = 0;
    long ephemeris_type = 0, norad_cat_id = 0, element_set_no = 0, rev_at_epoch = 0;
    bool valid = false;
};

Omm parse_json_object(const std::string& obj) {
    Omm o;
    json_string_field(obj, "OBJECT_NAME", &o.object_name);
    json_string_field(obj, "OBJECT_ID", &o.object_id);
    json_string_field(obj, "EPOCH", &o.epoch);
    json_string_field(obj, "CLASSIFICATION_TYPE", &o.classification_type);
    json_string_field(obj, "RMS", &o.rms);
    json_string_field(obj, "DATA_SOURCE", &o.data_source);
    o.mean_motion = json_double_field(obj, "MEAN_MOTION", 0);
    o.eccentricity = json_double_field(obj, "ECCENTRICITY", 0);
    o.inclination = json_double_field(obj, "INCLINATION", 0);
    o.raan = json_double_field(obj, "RA_OF_ASC_NODE", 0);
    o.argp = json_double_field(obj, "ARG_OF_PERICENTER", 0);
    o.mean_anomaly = json_double_field(obj, "MEAN_ANOMALY", 0);
    o.bstar = json_double_field(obj, "BSTAR", 0);
    o.mm_dot = json_double_field(obj, "MEAN_MOTION_DOT", 0);
    o.mm_ddot = json_double_field(obj, "MEAN_MOTION_DDOT", 0);
    o.ephemeris_type = json_long_field(obj, "EPHEMERIS_TYPE", 0);
    o.norad_cat_id = json_long_field(obj, "NORAD_CAT_ID", 0);
    o.element_set_no = json_long_field(obj, "ELEMENT_SET_NO", 0);
    o.rev_at_epoch = json_long_field(obj, "REV_AT_EPOCH", 0);
    o.valid = !o.epoch.empty() && o.mean_motion > 0.0 && !o.object_name.empty();
    return o;
}

std::vector<Omm> parse_csv(const std::string& body) {
    std::vector<Omm> out;
    const std::vector<std::string> lines = split_char(body, '\n');
    size_t hdr = 0;
    while (hdr < lines.size() && trim(lines[hdr]).empty()) hdr++;
    if (hdr >= lines.size()) return out;
    const std::vector<std::string> header = split_char(trim(lines[hdr]), ',');
    auto col = [&](const char* name) -> int {
        for (size_t i = 0; i < header.size(); ++i) if (trim(header[i]) == name) return static_cast<int>(i);
        return -1;
    };
    const int c_name = col("OBJECT_NAME"), c_id = col("OBJECT_ID"), c_epoch = col("EPOCH");
    const int c_mm = col("MEAN_MOTION"), c_ecc = col("ECCENTRICITY"), c_incl = col("INCLINATION");
    const int c_raan = col("RA_OF_ASC_NODE"), c_argp = col("ARG_OF_PERICENTER"), c_ma = col("MEAN_ANOMALY");
    const int c_et = col("EPHEMERIS_TYPE"), c_ct = col("CLASSIFICATION_TYPE"), c_norad = col("NORAD_CAT_ID");
    const int c_esn = col("ELEMENT_SET_NO"), c_rev = col("REV_AT_EPOCH"), c_bstar = col("BSTAR");
    const int c_mmd = col("MEAN_MOTION_DOT"), c_mmdd = col("MEAN_MOTION_DDOT");
    const int c_rms = col("RMS"), c_ds = col("DATA_SOURCE");
    for (size_t li = hdr + 1; li < lines.size(); ++li) {
        const std::string line = trim(lines[li]);
        if (line.empty()) continue;
        const std::vector<std::string> f = split_char(line, ',');
        auto sv = [&](int i) { return (i >= 0 && i < static_cast<int>(f.size())) ? trim(f[i]) : std::string(); };
        auto dv = [&](int i) { const std::string s = sv(i); return s.empty() ? 0.0 : strtod(s.c_str(), nullptr); };
        auto lv = [&](int i) { const std::string s = sv(i); return s.empty() ? 0L : strtol(s.c_str(), nullptr, 10); };
        Omm o;
        o.object_name = sv(c_name);
        o.object_id = sv(c_id);
        o.epoch = sv(c_epoch);
        o.classification_type = sv(c_ct);
        o.rms = sv(c_rms);
        o.data_source = sv(c_ds);
        o.mean_motion = dv(c_mm);
        o.eccentricity = dv(c_ecc);
        o.inclination = dv(c_incl);
        o.raan = dv(c_raan);
        o.argp = dv(c_argp);
        o.mean_anomaly = dv(c_ma);
        o.bstar = dv(c_bstar);
        o.mm_dot = dv(c_mmd);
        o.mm_ddot = dv(c_mmdd);
        o.ephemeris_type = lv(c_et);
        o.norad_cat_id = lv(c_norad);
        o.element_set_no = lv(c_esn);
        o.rev_at_epoch = lv(c_rev);
        o.valid = !o.epoch.empty() && o.mean_motion > 0.0 && !o.object_name.empty();
        out.push_back(o);
    }
    return out;
}

// JSON when the body opens with '[' or '{', else CSV (the feed's two FORMATs).
std::vector<Omm> parse_supgp(const std::string& body, const char** format_out) {
    const std::string t = trim(body);
    if (!t.empty() && (t[0] == '[' || t[0] == '{')) {
        *format_out = "JSON";
        std::vector<Omm> out;
        for (const std::string& obj : split_json_objects(t)) out.push_back(parse_json_object(obj));
        return out;
    }
    *format_out = "CSV";
    return parse_csv(body);
}

// ── SHA-256 (BATCH_ID = sha256 of the payload, as data-source/celestrak-parser) ──

struct Sha256 {
    uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    uint64_t total = 0;
    uint8_t buf[64];
    size_t buf_len = 0;

    static uint32_t rotr(uint32_t x, uint32_t n) { return (x >> n) | (x << (32 - n)); }

    void block(const uint8_t* p) {
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
        for (int i = 0; i < 16; i++)
            w[i] = (static_cast<uint32_t>(p[i * 4]) << 24) | (static_cast<uint32_t>(p[i * 4 + 1]) << 16) |
                   (static_cast<uint32_t>(p[i * 4 + 2]) << 8) | p[i * 4 + 3];
        for (int i = 16; i < 64; i++) {
            const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
            const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (int i = 0; i < 64; i++) {
            const uint32_t t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i];
            const uint32_t t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
            hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }

    void update(const uint8_t* data, size_t len) {
        total += len;
        while (len > 0) {
            const size_t take = std::min(len, sizeof(buf) - buf_len);
            std::memcpy(buf + buf_len, data, take);
            buf_len += take; data += take; len -= take;
            if (buf_len == 64) { block(buf); buf_len = 0; }
        }
    }

    std::string hex_digest() {
        const uint64_t bit_len = total * 8;
        const uint8_t pad = 0x80, zero = 0;
        update(&pad, 1);
        while (buf_len != 56) update(&zero, 1);
        uint8_t len_be[8];
        for (int i = 0; i < 8; i++) len_be[i] = static_cast<uint8_t>(bit_len >> (56 - i * 8));
        update(len_be, 8);
        static const char* hexd = "0123456789abcdef";
        std::string out;
        for (int i = 0; i < 8; i++)
            for (int b = 24; b >= 0; b -= 8) {
                const uint8_t byte = static_cast<uint8_t>(h[i] >> b);
                out.push_back(hexd[byte >> 4]);
                out.push_back(hexd[byte & 0xf]);
            }
        return out;
    }
};

std::string sha256_hex(const uint8_t* data, size_t len) {
    Sha256 s;
    s.update(data, len);
    return s.hex_digest();
}

// ── node config (plugin.getConfig through sdm_piv, one ModuleConfig read in place) ──

std::string config_text(const sdm_piv::Config& config, const char* key, const char* fallback) {
    const std::string_view v = config.string(key);
    return v.empty() ? std::string(fallback) : std::string(v);
}

// ── frames ──────────────────────────────────────────────────────────────────

int fail(const char* code, const std::string& message) {
    plugin_set_error(code, message.c_str());
    return 1;
}

int push_typed(const char* port, const char* schema, const char* identifier, const char* root, const uint8_t* bytes,
               size_t size) {
    return plugin_push_output_ex(port, schema, identifier, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, bytes,
                                 static_cast<uint32_t>(size));
}

void append_size_prefixed(Bytes* stream, const Bytes& record) {
    const uint32_t len = static_cast<uint32_t>(record.size());
    for (int i = 0; i < 4; i++) stream->push_back(static_cast<uint8_t>((len >> (8 * i)) & 0xff));
    stream->insert(stream->end(), record.begin(), record.end());
}

// A single-stream input port carrying more than one frame is refused by name, never silently drained (graph task
// modules-guest-nodes-drop-batched-frames: the compiled flow runtime drains a node's queue port-blind).
bool refuse_batched(const char* port) {
    uint32_t on_port = 0;
    for (uint32_t i = 0; i < plugin_get_input_count(); i++) {
        const plugin_input_frame_t* f = plugin_get_input_frame(i);
        if (f && f->port_id && std::strcmp(f->port_id, port) == 0) on_port++;
    }
    if (on_port <= 1) return false;
    char msg[256];
    std::snprintf(msg, sizeof(msg),
                  "This invocation carries %u frames on single-stream input port \"%s\"; the surplus frames are "
                  "refused rather than silently discarded.",
                  on_port, port);
    plugin_set_error("batched-input-frames", msg);
    return true;
}

// The parse job: one size-prefixed $ICN record (mirrors data-source/celestrak-request's job).
Bytes icn_job(const sdm_piv::Config& config, const std::string& url, const std::string& token,
              const std::string& source_name) {
    flatbuffers::FlatBufferBuilder b(1024);
    const auto connector_id = b.CreateString("celestrak-supgp-" + token);
    const auto target = b.CreateString("OMM.fbs");
    const auto endpoint = b.CreateString(url);
    const auto method = b.CreateString("GET");
    const auto origin_id = b.CreateString(kOriginID);
    const auto origin_name = b.CreateString(kOriginName);
    const auto dataset = b.CreateString(kDatasetPrefix + token);
    const auto provider = b.CreateString(config_text(config, "providerId", kDefaultProviderID));
    const auto source = b.CreateString(source_name);
    const auto license = b.CreateString(config_text(config, "license", kDefaultLicense));
    const auto license_url = b.CreateString(config_text(config, "licenseUrl", kDefaultLicenseURL));
    const auto citation = b.CreateString(config_text(config, "citation", kDefaultCitation));
    std::vector<flatbuffers::Offset<flatbuffers::String>> codes{b.CreateString("OMM.fbs")};
    const auto emits = b.CreateVector(codes);
    ICNBuilder r(b);
    r.add_CONNECTOR_ID(connector_id);
    r.add_KIND(icnConnectorKind_HttpsPull);
    r.add_TARGET_SCHEMA(target);
    r.add_ENDPOINT_URL(endpoint);
    r.add_HTTP_METHOD(method);
    r.add_POST_INGEST_ACTION(icnPostIngestAction_Archive);
    r.add_ORIGIN_ID(origin_id);
    r.add_ORIGIN_NAME(origin_name);
    r.add_DATASET_ID(dataset);
    r.add_PROVIDER_ID(provider);
    r.add_SOURCE_NAME(source);
    r.add_LICENSE(license);
    r.add_LICENSE_URL(license_url);
    r.add_CITATION(citation);
    r.add_EMITS_SCHEMAS(emits);
    FinishSizePrefixedICNBuffer(b, r.Finish());
    return Bytes(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

int push_get(const std::string& url, const Bytes& job) {
    flatbuffers::FlatBufferBuilder b(512 + url.size() + job.size());
    R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, "GET", url.c_str(), nullptr, nullptr, 0, 0, &job));
    return push_typed("requests", "HttpRequest.fbs", R::HttpRequestIdentifier(), "HttpRequest", b.GetBufferPointer(),
                      b.GetSize());
}

// ── the parse job, read back from the HttpResponse's CONTEXT ────────────────

struct Job {
    const plugin_input_frame_t* frame = nullptr;
    const R::HttpResponse* response = nullptr;
    std::string url, token, source_name, provider_id, license, license_url, citation;
};

std::string str_of(const flatbuffers::String* s) { return s ? s->str() : std::string(); }

std::string header_value(const R::HttpResponse& r, const char* name) {
    if (!r.HEADERS()) return std::string();
    for (const R::Header* h : *r.HEADERS())
        if (h && h->NAME() && to_lower(h->NAME()->str()) == name) return str_of(h->VALUE());
    return std::string();
}

// TAGS.LICENSE is an SPDX identifier (at most 64 bytes, no spaces); the usage-policy sentence is not one, so the lane
// names it by reference and its text stays in the job (as data-source/celestrak-parser).
std::string license_identifier(const std::string& license) {
    if (license.empty()) return std::string();
    bool identifier = license.size() <= 64;
    for (char c : license) if (is_ws(c)) identifier = false;
    return identifier ? license : std::string("LicenseRef-CelesTrak-Usage-Policy");
}

bool load_job(Job* job) {
    const int32_t index = plugin_find_input_index("response", 0);
    const plugin_input_frame_t* f = index < 0 ? nullptr : plugin_get_input_frame(static_cast<uint32_t>(index));
    if (!f || !f->payload || !f->payload_length) {
        fail("missing-response-frame", "parse requires the HttpResponse frame on 'response'.");
        return false;
    }
    flatbuffers::Verifier verifier(f->payload, f->payload_length, 64, 1000000, false);
    if (!R::VerifyHttpResponseBuffer(verifier)) {
        fail("invalid-response-frame", "the 'response' frame is not an HttpResponse (HRSP).");
        return false;
    }
    job->frame = f;
    job->response = R::GetHttpResponse(f->payload);
    const auto* context = job->response->CONTEXT();
    const ICN* icn = nullptr;
    if (context && context->size() >= 8) {
        flatbuffers::Verifier job_verifier(context->data(), context->size());
        if (VerifySizePrefixedICNBuffer(job_verifier)) icn = GetSizePrefixedICN(context->data());
    }
    const std::string dataset = icn ? str_of(icn->DATASET_ID()) : std::string();
    if (!icn || dataset.compare(0, std::strlen(kDatasetPrefix), kDatasetPrefix) != 0 || str_of(icn->SOURCE_NAME()).empty()) {
        fail("missing-context",
             "the HttpResponse carries no SupGP $ICN job in CONTEXT (DATASET_ID supgp-<token>, SOURCE_NAME); it cannot be "
             "attributed and is refused.");
        return false;
    }
    job->url = str_of(icn->ENDPOINT_URL());
    job->token = dataset.substr(std::strlen(kDatasetPrefix));
    job->source_name = str_of(icn->SOURCE_NAME());
    job->provider_id = str_of(icn->PROVIDER_ID());
    if (job->provider_id.empty()) job->provider_id = kDefaultProviderID;
    job->license = str_of(icn->LICENSE());
    job->license_url = str_of(icn->LICENSE_URL());
    job->citation = str_of(icn->CITATION());
    return true;
}

int push_notice(const char* port, R::flowNoticeKind kind, const Job& job, const std::string& reason,
                const std::vector<std::string>& items) {
    R::FlowNoticeT notice;
    notice.KIND = kind;
    notice.SCHEMA = "OMM.fbs";
    notice.PROVIDER_ID = job.provider_id;
    notice.SOURCE_NAME = job.source_name;
    notice.REASON = reason;
    notice.COUNT = 1;
    notice.ITEMS = items;
    flatbuffers::FlatBufferBuilder b(256);
    R::FinishFlowNoticeBuffer(b, R::FlowNotice::Pack(b, &notice));
    return push_typed(port, "FlowNotice.fbs", R::FlowNoticeIdentifier(), "FlowNotice", b.GetBufferPointer(), b.GetSize()) < 0
               ? 1
               : 0;
}

// ── $OMM ────────────────────────────────────────────────────────────────────

const char* const kComment[] = {
    "CelesTrak Supplemental GP (SupGP) OMM re-published by SDN — App 2 A2.9.",
    "NON-INDEPENDENT: these are CelesTrak-FITTED SGP4 mean elements, NOT an SDN OD solution and NOT the operator's raw "
    "ephemeris.",
    "data_source=CelesTrak SupGP; must never count as our OD; never outranks Space-Track GP in synthesis.",
};

// One $OMM (not size-prefixed): the legacy record's keywords, typed; the SDN lane keywords as USER_DEFINED parameters.
Bytes build_omm(const Omm& o, const std::string& source_name) {
    std::string comment;
    for (const char* line : kComment) { comment += line; comment += '\n'; }
    comment += "SOURCE_NAME=" + source_name + " CELESTRAK_DATA_SOURCE=" + o.data_source + " CELESTRAK_RMS=" + o.rms;

    flatbuffers::FlatBufferBuilder b(2048);
    const auto comment_off = b.CreateString(comment);
    const auto name_off = b.CreateString(o.object_name);
    const auto id_off = b.CreateString(o.object_id);
    const auto center_off = b.CreateString("EARTH");
    const auto frame_off =
        CreateRFM(b, RFMUnion_CelestialFrameWrapper, CreateCelestialFrameWrapper(b, CelestialFrame_TEMEOFDATE).Union());
    const auto epoch_off = b.CreateString(o.epoch);
    const auto class_off = b.CreateString(o.classification_type);
    const std::pair<const char*, std::string> params[] = {
        {"SDN_SOURCE_NAME", source_name},
        {"SDN_DATA_SOURCE", kDataSource},
        {"SDN_INDEPENDENT", "false"},
        {"SDN_CELESTRAK_DATA_SOURCE", o.data_source},
        {"SDN_CELESTRAK_RMS", o.rms},
    };
    std::vector<flatbuffers::Offset<OMMUserDefinedParameter>> param_offsets;
    for (const auto& [name, value] : params)
        param_offsets.push_back(CreateOMMUserDefinedParameterDirect(b, name, value.c_str()));
    const auto params_off = b.CreateVector(param_offsets);

    OMMBuilder r(b);
    r.add_CCSDS_OMM_VERS(2.0);
    r.add_COMMENT(comment_off);
    r.add_OBJECT_NAME(name_off);
    r.add_OBJECT_ID(id_off);
    r.add_CENTER_NAME(center_off);
    r.add_REFERENCE_FRAME(frame_off);
    r.add_TIME_SYSTEM(timingStandard_UTC);
    r.add_MEAN_ELEMENT_THEORY(meanElementSource_SGP4);
    r.add_EPOCH(epoch_off);
    r.add_MEAN_MOTION(o.mean_motion);
    r.add_ECCENTRICITY(o.eccentricity);
    r.add_INCLINATION(o.inclination);
    r.add_RA_OF_ASC_NODE(o.raan);
    r.add_ARG_OF_PERICENTER(o.argp);
    r.add_MEAN_ANOMALY(o.mean_anomaly);
    r.add_EPHEMERIS_TYPE(static_cast<ephemerisFormat>(o.ephemeris_type));
    r.add_CLASSIFICATION_TYPE(class_off);
    r.add_NORAD_CAT_ID(static_cast<uint32_t>(o.norad_cat_id));
    r.add_ELEMENT_SET_NO(static_cast<uint32_t>(o.element_set_no));
    r.add_REV_AT_EPOCH(static_cast<double>(o.rev_at_epoch));
    r.add_BSTAR(o.bstar);
    r.add_MEAN_MOTION_DOT(o.mm_dot);
    r.add_MEAN_MOTION_DDOT(o.mm_ddot);
    r.add_USER_DEFINED_PARAMETERS(params_off);
    FinishOMMBuffer(b, r.Finish());
    return Bytes(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

// The batch's IngestRequest: source tags, archive naming (celestrak/celestrak_supgp_<token>.<json|csv>) and provenance.
Bytes build_ingest_request(const Job& job, const std::string& batch_id, const char* format, size_t records,
                           const std::string& normalized_sha256) {
    const R::HttpResponse& r = *job.response;
    flatbuffers::FlatBufferBuilder b(2048);
    const auto opt = [](const std::string& s) { return s.empty() ? nullptr : s.c_str(); };
    const std::string etag = header_value(r, "etag"), last_modified = header_value(r, "last-modified"),
                      content_type = header_value(r, "content-type");
    std::vector<flatbuffers::Offset<flatbuffers::String>> schemas{b.CreateString("OMM.fbs")};
    std::vector<uint64_t> counts{static_cast<uint64_t>(records)};
    std::vector<flatbuffers::Offset<flatbuffers::String>> warnings;
    std::vector<flatbuffers::Offset<R::Header>> attributes{
        R::CreateHeaderDirect(b, "celestrak_token", job.token.c_str()),
        R::CreateHeaderDirect(b, "format", format),
        R::CreateHeaderDirect(b, "data_source", kDataSource),
        R::CreateHeaderDirect(b, "independent", "false"),
    };
    const auto provenance = R::CreateProvenanceDirect(
        b, job.url.c_str(), r.STATUS(), opt(etag), opt(last_modified), opt(content_type), r.RETRIEVED_MS(),
        "celestrak-supgp", "1.1.0", batch_id.c_str(), normalized_sha256.c_str(), static_cast<uint64_t>(records),
        &schemas, &counts, &warnings, false, &attributes);
    const std::string license = license_identifier(job.license);
    const auto tags = R::CreateSourceTagsDirect(b, job.provider_id.c_str(), job.source_name.c_str(), batch_id.c_str(),
                                                job.url.c_str(), kContentKeyID, kSourcePeer, opt(license),
                                                opt(job.license_url), opt(job.citation), false);
    const std::string archive_name = "celestrak_supgp_" + job.token + "." + to_lower(format);
    const auto archive = R::CreateArchiveTargetDirect(b, kArchiveSource, archive_name.c_str());
    R::FinishIngestRequestBuffer(b, R::CreateIngestRequestDirect(b, "OMM.fbs", tags, R::reconcileMode_Duplicates, archive,
                                                                 provenance));
    return Bytes(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

}  // namespace

extern "C" {

// request: one TimerTick (its fields are not read) -> one GET per SupGP registry token (de-duplicated), or the one
// token node config names, each with its $ICN parse job in CONTEXT.
int request(void) {
    if (refuse_batched("tick")) return 1;
    const sdm_piv::Config config = sdm_piv::get_config();
    const std::string base_url = config_text(config, "baseUrl", kDefaultBaseUrl);
    const std::string format = config_text(config, "format", kDefaultFormat);
    struct Entry { std::string token, source_name, url; };
    std::vector<Entry> entries;
    const std::string token = config_text(config, "token", "");
    if (!token.empty()) {
        entries.push_back({token, config_text(config, "sourceName", to_lower(token).c_str()), config_text(config, "sourceUrl", "")});
    } else {
        for (const RegistryEntry& e : kRegistry) {
            bool seen = false;
            for (const Entry& u : entries) seen = seen || u.token == e.token;
            if (!seen) entries.push_back({e.token, e.source_name, std::string()});
        }
    }
    for (const Entry& e : entries) {
        const std::string url = e.url.empty() ? base_url + "?SOURCE=" + e.token + "&FORMAT=" + format : e.url;
        if (push_get(url, icn_job(config, url, e.token, e.source_name)) < 0) return fail("emit-failed", "Failed to emit an HttpRequest.");
    }
    return 0;
}

// parse: the HttpResponse of one token's GET -> its OMM batch (meta, records, raw), a FlowNotice Unchanged (304) or
// a FlowNotice Missing (transport error, another status, nothing valid in the body).
int parse(void) {
    if (refuse_batched("response")) return 1;
    Job job;
    if (!load_job(&job)) return 1;
    const R::HttpResponse& r = *job.response;
    if (r.ERROR() && r.ERROR()->size())
        return push_notice("status", R::flowNoticeKind_Missing, job, "supgp-unavailable: " + r.ERROR()->str(), {job.url});
    if (r.STATUS() == 304) return push_notice("unchanged", R::flowNoticeKind_Unchanged, job, "not-modified", {job.url});
    if (r.STATUS() != 200)
        return push_notice("status", R::flowNoticeKind_Missing, job,
                           "supgp-unavailable: HTTP status " + std::to_string(r.STATUS()), {job.url});
    if (!r.BODY() || r.BODY()->size() == 0)
        return push_notice("status", R::flowNoticeKind_Missing, job, "supgp-empty", {job.url});

    const sdm_piv::Config config = sdm_piv::get_config();
    const double cap_value = config.number("objectCap", 0);
    const long object_cap = cap_value > 0 ? static_cast<long>(cap_value) : kDefaultObjectCap;

    const std::string body(reinterpret_cast<const char*>(r.BODY()->data()), r.BODY()->size());
    const char* format = "";
    const std::vector<Omm> objs = parse_supgp(body, &format);
    Bytes stream;
    Sha256 normalized;
    size_t records = 0;
    for (const Omm& o : objs) {
        if (!o.valid) continue;
        if (static_cast<long>(records) >= object_cap) break;
        const Bytes omm = build_omm(o, job.source_name);
        append_size_prefixed(&stream, omm);
        normalized.update(reinterpret_cast<const uint8_t*>("OMM.fbs"), 8);  // schema name and its NUL
        normalized.update(omm.data(), omm.size());
        const uint8_t z = 0;
        normalized.update(&z, 1);
        records++;
    }
    if (records == 0) return push_notice("status", R::flowNoticeKind_Missing, job, "supgp-no-records", {job.url});

    const std::string batch_id = sha256_hex(r.BODY()->data(), r.BODY()->size());
    const Bytes meta = build_ingest_request(job, batch_id, format, records, normalized.hex_digest());
    if (push_typed("omm_meta", "IngestRequest.fbs", R::IngestRequestIdentifier(), "IngestRequest", meta.data(), meta.size()) < 0 ||
        push_typed("omm_records", "OMM.fbs", "$OMM", "OMM", stream.data(), stream.size()) < 0 ||
        push_typed("raw", "HttpResponse.fbs", R::HttpResponseIdentifier(), "HttpResponse", job.frame->payload,
                   job.frame->payload_length) < 0)
        return fail("emit-failed", "Failed to emit the batch frames.");
    return 0;
}

}  // extern "C"
