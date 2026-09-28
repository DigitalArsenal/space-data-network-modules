/*
 * data-source/celestrak-reference (fbcs-06b).
 *
 * One self-contained CelesTrak reference module: request builders AND parsers
 * for the two reference lanes that make the CelesTrak dataset set definitive:
 *
 *   gp_groups              tick -> N request frames (port "request") + ONE job
 *                          frame (port "job") for the 47 GP GROUP queries and
 *                          the 2 SPECIAL queries (gpz, gpz-plus).
 *   parse_gp_groups        (job, N responses) -> one $EGP per group
 *                          (egp_meta / egp_records / raw), optional OMM
 *                          re-emission (omm_meta / omm_records), and an
 *                          "unchanged" frame for groups that answered 304.
 *   satcat_reference       tick -> two request/job pairs (launch sites,
 *                          owners/sources tables).
 *   parse_satcat_reference (job, response) -> $SIT rows (launch sites) or
 *                          $LCC rows (owner codes) from the HTML tables.
 *
 * Helpers (config, JSON, base64, sha256, csv, civil time, frame IO) are copied
 * from data-source/celestrak-request and data-source/celestrak-parser, which
 * are single-file modules and stay untouched by this module.
 *
 * JOB CONTRACT (shared with the other CelesTrak lanes): every job JSON carries
 * source_url, source_name, provider_id, archive_source/archive_name,
 * origin_id "celestrak.org", origin_name "CelesTrak", dataset_id and
 * license/license_url/citation; every ingest meta carries schema, provider_id,
 * source_name, source_url, batch_id, content_key_id, source_peer, reconcile,
 * license, license_url, citation, origin_id, origin_name, dataset_id, archive
 * and provenance (the parser's build_provenance_json shape, warnings[]
 * included).
 *
 * ONE JOB FRAME FOR N GROUPS. The compiled flow runtime hands a node at most
 * 64 frames per invocation (space_data_module_runtime_begin_node_invocation,
 * kMaxInvocationFrames) and pops them port-blind. N job frames + N response
 * frames for the 49 default groups would be 98 frames, so the parser would
 * always see a partial batch and, being fail-closed on count mismatch, would
 * never land a batch. The job therefore carries the ordered group list once
 * (1 + 49 = 50 frames); hostcap/http-request answers one response per request
 * in request order, so response ordinal i is group i. The list is capped at
 * 63 entries for the same reason.
 */

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <vector>

#include <sys/time.h>

#include "space_data_module_invoke.h"

extern "C" {

__attribute__((import_module("space_data_module_host"), import_name("call")))
int32_t sdm_host_call(const uint8_t* op_ptr, int32_t op_len,
                      const uint8_t* payload_ptr, int32_t payload_len);
__attribute__((import_module("space_data_module_host"), import_name("response_len")))
int32_t sdm_host_response_len(void);
__attribute__((import_module("space_data_module_host"), import_name("read_response")))
int32_t sdm_host_read_response(uint8_t* dst_ptr, int32_t dst_len);

}  // extern "C"

namespace {

// ---------------------------------------------------------------------------
// Lane constants.
// ---------------------------------------------------------------------------

constexpr const char* kDefaultProviderID = "space-data-network-02";
constexpr const char* kSourcePeer = "source:celestrak";
constexpr const char* kContentKeyID = "public";
constexpr const char* kOriginID = "celestrak.org";
constexpr const char* kOriginName = "CelesTrak";
constexpr const char* kArchiveSource = "celestrak";
constexpr long kDefaultTimeoutMs = 90000;  // runner HTTPTimeout default (90 s)

constexpr const char* kGPBaseURL = "https://celestrak.org/NORAD/elements/gp.php";
constexpr const char* kGPIndexURL = "https://celestrak.org/NORAD/elements/";
constexpr const char* kDefaultLaunchSitesURL = "https://celestrak.org/satcat/launchsites.php";
constexpr const char* kDefaultSourcesURL = "https://celestrak.org/satcat/sources.php";

constexpr long kGroupMaxBytes = 8388608;      // 8 MiB per GP group payload
constexpr long kReferenceMaxBytes = 2097152;  // 2 MiB per reference page
constexpr size_t kMaxGroups = 63;             // 1 job + 63 responses = runtime budget

constexpr const char* kSourceGPGroups = "celestrak-gp-groups";
constexpr const char* kDatasetGPGroups = "gp-groups";
constexpr const char* kSourceLaunchSites = "celestrak-satcat-launch-sites";
constexpr const char* kDatasetLaunchSites = "satcat-launch-sites";
constexpr const char* kSourceOwners = "celestrak-satcat-owners";
constexpr const char* kDatasetOwners = "satcat-owners";

// CelesTrak terms, quoted verbatim from https://celestrak.org/usage-policy.php
// ("CelesTrak Usage Policy", updated 2026 May 22), read once. Overridable via
// node CONFIG celestrak_license / celestrak_license_url / celestrak_citation.
constexpr const char* kDefaultLicense =
    "CelesTrak Usage Policy (2026 May 22): \"Only download the data you need, when you are "
    "going to use it, and only download data once per update.\" \"M2M (machine-to-machine) "
    "software should immediately stop querying when it receives any non-HTTP 200 responses "
    "and report the results to a human for investigation.\"";
constexpr const char* kDefaultLicenseURL = "https://celestrak.org/usage-policy.php";
constexpr const char* kDefaultCitation = "CelesTrak, Dr. T.S. Kelso, https://celestrak.org/";

// ---------------------------------------------------------------------------
// Compiled GP group registry: the 47 GROUP tokens and 2 SPECIAL tokens listed
// on https://celestrak.org/NORAD/elements/ (enumerated once, 2026-09-04), in
// page order, with the page's human labels. Tag facets are added only where
// the token itself names a constellation or an orbital regime.
// ---------------------------------------------------------------------------

struct GroupSpec {
    const char* token;
    bool special;
    const char* label;
    const char* constellation;  // nullptr when the token names none
    const char* regime;         // nullptr when the token names none
};

const GroupSpec kGroups[] = {
    {"last-30-days", false, "Last 30 Days' Launches", nullptr, nullptr},
    {"stations", false, "Space Stations", nullptr, nullptr},
    {"visual", false, "100 (or so) Brightest", nullptr, nullptr},
    {"active", false, "Active Satellites", nullptr, nullptr},
    {"analyst", false, "Analyst Satellites", nullptr, nullptr},
    {"fengyun-1c-debris", false, "Chinese ASAT Test Debris (FENGYUN 1C)", nullptr, nullptr},
    {"iridium-33-debris", false, "IRIDIUM 33 Debris", nullptr, nullptr},
    {"cosmos-2251-debris", false, "COSMOS 2251 Debris", nullptr, nullptr},
    {"weather", false, "Weather", nullptr, nullptr},
    {"resource", false, "Earth Resources", nullptr, nullptr},
    {"sar", false, "Synthetic Aperture Radar", nullptr, nullptr},
    {"sarsat", false, "Search & Rescue (SARSAT)", nullptr, nullptr},
    {"dmc", false, "Disaster Monitoring", nullptr, nullptr},
    {"tdrss", false, "Tracking and Data Relay Satellite System (TDRSS)", "tdrss", nullptr},
    {"argos", false, "ARGOS Data Collection System", nullptr, nullptr},
    {"planet", false, "Planet", "planet", nullptr},
    {"spire", false, "Spire", "spire", nullptr},
    {"geo", false, "Active Geosynchronous", nullptr, "geo"},
    {"gpz", true, "GEO Protected Zone", nullptr, "geo"},
    {"gpz-plus", true, "GEO Protected Zone Plus", nullptr, "geo"},
    {"intelsat", false, "Intelsat", "intelsat", nullptr},
    {"ses", false, "SES", "ses", nullptr},
    {"eutelsat", false, "Eutelsat", "eutelsat", nullptr},
    {"telesat", false, "Telesat", "telesat", nullptr},
    {"starlink", false, "Starlink", "starlink", nullptr},
    {"oneweb", false, "OneWeb", "oneweb", nullptr},
    {"qianfan", false, "Qianfan", "qianfan", nullptr},
    {"hulianwang", false, "Hulianwang Digui", "hulianwang", nullptr},
    {"kuiper", false, "Kuiper", "kuiper", nullptr},
    {"iridium-NEXT", false, "Iridium NEXT", "iridium-next", nullptr},
    {"orbcomm", false, "Orbcomm", "orbcomm", nullptr},
    {"globalstar", false, "Globalstar", "globalstar", nullptr},
    {"amateur", false, "Amateur Radio", nullptr, nullptr},
    {"satnogs", false, "SatNOGS", nullptr, nullptr},
    {"x-comm", false, "Experimental Comm", nullptr, nullptr},
    {"other-comm", false, "Other Comm", nullptr, nullptr},
    {"gnss", false, "GNSS", nullptr, nullptr},
    {"gps-ops", false, "GPS Operational", "gps", nullptr},
    {"glo-ops", false, "GLONASS Operational", "glonass", nullptr},
    {"galileo", false, "Galileo", "galileo", nullptr},
    {"beidou", false, "Beidou", "beidou", nullptr},
    {"sbas", false, "Satellite-Based Augmentation System (WAAS/EGNOS/MSAS)", nullptr, nullptr},
    {"science", false, "Space & Earth Science", nullptr, nullptr},
    {"geodetic", false, "Geodetic", nullptr, nullptr},
    {"engineering", false, "Engineering", nullptr, nullptr},
    {"education", false, "Education", nullptr, nullptr},
    {"military", false, "Miscellaneous Military", nullptr, nullptr},
    {"radar", false, "Radar Calibration", nullptr, nullptr},
    {"cubesat", false, "CubeSats", nullptr, nullptr},
};
constexpr size_t kGroupCount = sizeof(kGroups) / sizeof(kGroups[0]);

const GroupSpec* find_group(const std::string& token) {
    for (size_t i = 0; i < kGroupCount; i++) {
        if (token == kGroups[i].token) return &kGroups[i];
    }
    return nullptr;
}

// ---------------------------------------------------------------------------
// Small string / JSON helpers (copied from celestrak-parser).
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

// true / "true" / 1 all read as set.
bool json_truthy_field(const std::string& json, const std::string& key) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
    while (i < json.size() && is_ws(json[i])) i++;
    if (i >= json.size()) return false;
    if (json.compare(i, 4, "true") == 0) return true;
    if (json[i] == '1') return true;
    if (json[i] == '"') {
        std::string v;
        if (json_string_field(json, key, &v)) {
            const std::string l = lower(trim(v));
            return l == "true" || l == "1" || l == "yes";
        }
    }
    return false;
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

// The objects of a JSON array field, each returned as its own "{...}" slice.
std::vector<std::string> json_array_objects(const std::string& json, const std::string& key) {
    std::vector<std::string> out;
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return out;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return out;
    size_t i = colon + 1;
    while (i < json.size() && is_ws(json[i])) i++;
    if (i >= json.size() || json[i] != '[') return out;
    i++;
    int depth = 0;
    bool in_string = false;
    size_t start = std::string::npos;
    for (; i < json.size(); i++) {
        const char c = json[i];
        if (in_string) {
            if (c == '\\') i++;
            else if (c == '"') in_string = false;
            continue;
        }
        if (c == '"') in_string = true;
        else if (c == '{') {
            if (depth == 0) start = i;
            depth++;
        } else if (c == '}') {
            depth--;
            if (depth == 0 && start != std::string::npos) {
                out.push_back(json.substr(start, i - start + 1));
                start = std::string::npos;
            }
        } else if (c == ']' && depth == 0) {
            break;
        }
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
        else out.push_back(c);
    }
    return out;
}

std::string json_string_array(const std::vector<std::string>& values) {
    std::string out = "[";
    for (size_t i = 0; i < values.size(); i++) {
        if (i) out += ",";
        out += "\"" + json_escape(values[i]) + "\"";
    }
    out += "]";
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
// SHA-256 (batch ids = sha256 of the fetched payload bytes).
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
        total -= 9;
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

// sha256 over (schemaName, 0x00, record bytes, 0x00) per record (runner
// writeNormalizedHashRecord parity).
void normalized_hash_record(Sha256* h, const char* schema, const std::vector<uint8_t>& record) {
    h->update(reinterpret_cast<const uint8_t*>(schema), std::strlen(schema));
    const uint8_t z = 0;
    h->update(&z, 1);
    h->update(record.data(), record.size());
    h->update(&z, 1);
}

// ---------------------------------------------------------------------------
// Value parsing.
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

// ---------------------------------------------------------------------------
// Civil time (UTC only).
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

struct ParsedEpoch {
    int64_t unix_seconds = 0;
    bool valid = false;
};

// Accepts: YYYY-MM-DD[ T]HH:MM:SS[.fraction][Z] and bare YYYY-MM-DD.
ParsedEpoch parse_epoch(const std::string& raw_in) {
    ParsedEpoch out;
    const std::string raw = trim(raw_in);
    if (raw.empty()) return out;
    int y = 0, mo = 0, d = 0, hh = 0, mm = 0;
    double ss = 0;
    if (raw.size() >= 19 && raw[4] == '-' && raw[7] == '-' && (raw[10] == 'T' || raw[10] == ' ') &&
        raw[13] == ':' && raw[16] == ':') {
        y = atoi(raw.substr(0, 4).c_str());
        mo = atoi(raw.substr(5, 2).c_str());
        d = atoi(raw.substr(8, 2).c_str());
        hh = atoi(raw.substr(11, 2).c_str());
        mm = atoi(raw.substr(14, 2).c_str());
        ss = strtod(raw.substr(17).c_str(), nullptr);
    } else if (raw.size() == 10 && raw[4] == '-' && raw[7] == '-') {
        y = atoi(raw.substr(0, 4).c_str());
        mo = atoi(raw.substr(5, 2).c_str());
        d = atoi(raw.substr(8, 2).c_str());
    } else {
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

// RFC3339 seconds-precision UTC (provenance JSON, LCC RETRIEVED_AT).
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

// RFC3339 fixed-millisecond UTC (the $EGP timestamp form).
std::string format_rfc3339_ms(int64_t unix_seconds) {
    std::string s = format_rfc3339(unix_seconds);
    s.insert(s.size() - 1, ".000");
    return s;
}

int64_t now_unix_seconds() {
    struct timeval tv;
    if (gettimeofday(&tv, nullptr) != 0) return 0;
    return static_cast<int64_t>(tv.tv_sec);
}

// HTTP-date (RFC1123: "Mon, 02 Jan 2006 15:04:05 GMT").
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
// CSV parsing (copied from celestrak-parser).
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
// Minimal HTML table scanner (reference pages): the first <table>, its <tr>
// rows, their <td> cells with tags stripped and entities decoded.
// ---------------------------------------------------------------------------

std::string html_lower_ascii(const std::string& s) { return lower(s); }

// Finds the next "<tag" (case-insensitive) at or after pos.
size_t find_tag(const std::string& lower_html, const char* tag, size_t pos) {
    const std::string needle = std::string("<") + tag;
    size_t i = pos;
    while ((i = lower_html.find(needle, i)) != std::string::npos) {
        const size_t after = i + needle.size();
        if (after >= lower_html.size()) return std::string::npos;
        const char c = lower_html[after];
        if (c == '>' || is_ws(c) || c == '/') return i;
        i = after;
    }
    return std::string::npos;
}

size_t find_close_tag(const std::string& lower_html, const char* tag, size_t pos) {
    const std::string needle = std::string("</") + tag;
    size_t i = pos;
    while ((i = lower_html.find(needle, i)) != std::string::npos) {
        const size_t after = i + needle.size();
        if (after >= lower_html.size()) return std::string::npos;
        const char c = lower_html[after];
        if (c == '>' || is_ws(c)) return i;
        i = after;
    }
    return std::string::npos;
}

void append_utf8(std::string* out, uint32_t cp) {
    if (cp < 0x80) {
        out->push_back(static_cast<char>(cp));
    } else if (cp < 0x800) {
        out->push_back(static_cast<char>(0xC0 | (cp >> 6)));
        out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
        out->push_back(static_cast<char>(0xE0 | (cp >> 12)));
        out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
        out->push_back(static_cast<char>(0xF0 | (cp >> 18)));
        out->push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
        out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
}

struct NamedEntity {
    const char* name;
    uint32_t cp;
};

// The five XML entities plus the named entities the live reference pages use.
const NamedEntity kNamedEntities[] = {
    {"amp", '&'},       {"lt", '<'},        {"gt", '>'},        {"quot", '"'},
    {"apos", '\''},     {"nbsp", 0x00A0},   {"mdash", 0x2014},  {"ndash", 0x2013},
    {"rsquo", 0x2019},  {"lsquo", 0x2018},  {"rdquo", 0x201D},  {"ldquo", 0x201C},
    {"hellip", 0x2026}, {"copy", 0x00A9},   {"reg", 0x00AE},    {"deg", 0x00B0},
    {"oslash", 0x00F8}, {"Oslash", 0x00D8}, {"uuml", 0x00FC},   {"Uuml", 0x00DC},
    {"ouml", 0x00F6},   {"Ouml", 0x00D6},   {"auml", 0x00E4},   {"Auml", 0x00C4},
    {"eacute", 0x00E9}, {"Eacute", 0x00C9}, {"egrave", 0x00E8}, {"ecirc", 0x00EA},
    {"aacute", 0x00E1}, {"agrave", 0x00E0}, {"acirc", 0x00E2},  {"atilde", 0x00E3},
    {"iacute", 0x00ED}, {"oacute", 0x00F3}, {"otilde", 0x00F5}, {"uacute", 0x00FA},
    {"ntilde", 0x00F1}, {"ccedil", 0x00E7}, {"Ccedil", 0x00C7}, {"szlig", 0x00DF},
    {"aring", 0x00E5},  {"Aring", 0x00C5},  {"aelig", 0x00E6},  {"AElig", 0x00C6},
};

std::string decode_entities(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size(); i++) {
        if (s[i] != '&') {
            out.push_back(s[i]);
            continue;
        }
        const size_t semi = s.find(';', i + 1);
        if (semi == std::string::npos || semi - i > 12) {
            out.push_back('&');
            continue;
        }
        const std::string name = s.substr(i + 1, semi - i - 1);
        if (!name.empty() && name[0] == '#') {
            uint32_t cp = 0;
            bool ok = false;
            if (name.size() > 2 && (name[1] == 'x' || name[1] == 'X')) {
                char* end = nullptr;
                cp = static_cast<uint32_t>(strtoul(name.c_str() + 2, &end, 16));
                ok = end == name.c_str() + name.size();
            } else if (name.size() > 1) {
                char* end = nullptr;
                cp = static_cast<uint32_t>(strtoul(name.c_str() + 1, &end, 10));
                ok = end == name.c_str() + name.size();
            }
            if (ok && cp > 0 && cp <= 0x10FFFF) {
                append_utf8(&out, cp);
                i = semi;
                continue;
            }
            out.push_back('&');
            continue;
        }
        bool matched = false;
        for (const NamedEntity& e : kNamedEntities) {
            if (name == e.name) {
                append_utf8(&out, e.cp);
                matched = true;
                break;
            }
        }
        if (matched) {
            i = semi;
        } else {
            out.push_back('&');  // unknown named entity stays verbatim
        }
    }
    return out;
}

// Tags stripped (<br> becomes a space), entities decoded, whitespace collapsed.
std::string cell_text(const std::string& fragment) {
    std::string stripped;
    stripped.reserve(fragment.size());
    for (size_t i = 0; i < fragment.size(); i++) {
        if (fragment[i] == '<') {
            const size_t close = fragment.find('>', i);
            if (close == std::string::npos) break;
            const std::string tag = lower(fragment.substr(i + 1, close - i - 1));
            if (tag.compare(0, 2, "br") == 0 || tag.compare(0, 1, "p") == 0) stripped.push_back(' ');
            i = close;
            continue;
        }
        stripped.push_back(fragment[i]);
    }
    const std::string decoded = decode_entities(stripped);
    std::string collapsed;
    collapsed.reserve(decoded.size());
    bool pending_space = false;
    for (const char c : decoded) {
        if (is_ws(c)) {
            pending_space = true;
            continue;
        }
        if (pending_space && !collapsed.empty()) collapsed.push_back(' ');
        pending_space = false;
        collapsed.push_back(c);
    }
    return collapsed;
}

// Rows of the first <table> as vectors of decoded <td> texts (header rows made
// of <th> yield no cells and are dropped by the caller's cell-count rule).
bool scan_html_table(const std::vector<uint8_t>& content,
                     std::vector<std::vector<std::string>>* rows, std::string* err) {
    rows->clear();
    const std::string html(reinterpret_cast<const char*>(content.data()), content.size());
    const std::string lo = html_lower_ascii(html);
    const size_t table_open = find_tag(lo, "table", 0);
    if (table_open == std::string::npos) {
        *err = "reference page carries no table";
        return false;
    }
    size_t table_close = find_close_tag(lo, "table", table_open);
    if (table_close == std::string::npos) table_close = lo.size();
    size_t pos = table_open;
    while (true) {
        const size_t tr = find_tag(lo, "tr", pos);
        if (tr == std::string::npos || tr >= table_close) break;
        size_t tr_end = find_close_tag(lo, "tr", tr);
        const size_t next_tr = find_tag(lo, "tr", tr + 3);
        if (tr_end == std::string::npos || (next_tr != std::string::npos && next_tr < tr_end)) {
            tr_end = next_tr == std::string::npos ? table_close : next_tr;
        }
        if (tr_end > table_close) tr_end = table_close;
        std::vector<std::string> cells;
        size_t cpos = tr;
        while (true) {
            const size_t td = find_tag(lo, "td", cpos);
            if (td == std::string::npos || td >= tr_end) break;
            const size_t td_open_end = lo.find('>', td);
            if (td_open_end == std::string::npos || td_open_end >= tr_end) break;
            size_t td_close = find_close_tag(lo, "td", td_open_end);
            const size_t next_td = find_tag(lo, "td", td_open_end);
            if (td_close == std::string::npos || td_close > tr_end ||
                (next_td != std::string::npos && next_td < td_close)) {
                td_close = next_td != std::string::npos && next_td < tr_end ? next_td : tr_end;
            }
            cells.push_back(cell_text(html.substr(td_open_end + 1, td_close - td_open_end - 1)));
            cpos = td_close;
        }
        if (!cells.empty()) rows->push_back(std::move(cells));
        pos = tr_end;
    }
    if (rows->empty()) {
        *err = "reference table carries no rows";
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Frame IO helpers.
// ---------------------------------------------------------------------------

bool read_json_frame_at(const char* port, uint32_t ordinal, std::string* out) {
    const int32_t idx = plugin_find_input_index(port, ordinal);
    if (idx < 0) return false;
    const plugin_input_frame_t* frame = plugin_get_input_frame(static_cast<uint32_t>(idx));
    if (!frame || !frame->payload || frame->payload_length == 0) return false;
    out->assign(reinterpret_cast<const char*>(frame->payload), frame->payload_length);
    return true;
}

bool read_json_frame(const char* port, std::string* out) {
    return read_json_frame_at(port, 0, out);
}

uint32_t frames_on_port(const char* port) {
    uint32_t n = 0;
    while (plugin_find_input_index(port, n) >= 0) n++;
    return n;
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

// SURPLUS-FRAME REFUSAL (graph task modules-guest-nodes-drop-batched-frames):
// the compiled runtime drains a node's queue port-blind, so a single-stream
// port that received several frames is refused by name rather than answered
// from whichever frame came first. `multi_port` names the one port (if any)
// this method reads in full.
bool find_batched_input_port(const char* multi_port, char* message, size_t message_len) {
    const uint32_t count = plugin_get_input_count();
    for (uint32_t i = 0; i < count; i++) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        if (!frame || !frame->port_id) continue;
        if (multi_port && std::strcmp(frame->port_id, multi_port) == 0) continue;
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

// ---------------------------------------------------------------------------
// Node CONFIG (builtin plugin.getConfig hostcall; copied from celestrak-request).
// ---------------------------------------------------------------------------

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
    sdm_host_call(reinterpret_cast<const uint8_t*>(op),
                  static_cast<int32_t>(std::strlen(op)), req.data(),
                  static_cast<int32_t>(req.size()));
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

std::string config_string(const std::string& config, const char* key, const char* fallback) {
    std::string value;
    if (json_string_field(config, key, &value) && !value.empty()) return value;
    return fallback;
}

long config_timeout_ms(const std::string& config) {
    double v = 0;
    if (json_number_field(config, "celestrak_http_timeout_ms", &v) && v > 0) {
        return static_cast<long>(v);
    }
    return kDefaultTimeoutMs;
}

struct LaneAttribution {
    std::string provider_id;
    std::string license;
    std::string license_url;
    std::string citation;
};

LaneAttribution lane_attribution(const std::string& config) {
    LaneAttribution a;
    a.provider_id = config_string(config, "celestrak_provider_id", kDefaultProviderID);
    a.license = config_string(config, "celestrak_license", kDefaultLicense);
    a.license_url = config_string(config, "celestrak_license_url", kDefaultLicenseURL);
    a.citation = config_string(config, "celestrak_citation", kDefaultCitation);
    return a;
}

// {"method":"GET","url":...,"timeoutMs":N,"maxBytes":N}
std::string build_request_json(const std::string& url, long timeout_ms, long max_bytes) {
    char timeout_buf[24];
    std::snprintf(timeout_buf, sizeof(timeout_buf), "%ld", timeout_ms);
    char max_buf[24];
    std::snprintf(max_buf, sizeof(max_buf), "%ld", max_bytes);
    return std::string("{\"method\":\"GET\",\"url\":\"") + json_escape(url) +
           "\",\"timeoutMs\":" + timeout_buf + ",\"maxBytes\":" + max_buf + "}";
}

// The shared job JSON, opened so callers can append lane-specific fields.
std::string job_json_fields(const LaneAttribution& a, const std::string& url,
                            const char* source_name, const char* archive_name,
                            const char* dataset_id) {
    return std::string("\"source_url\":\"") + json_escape(url) + "\"" +
           ",\"source_name\":\"" + source_name + "\"" +
           ",\"provider_id\":\"" + json_escape(a.provider_id) + "\"" +
           ",\"archive_source\":\"" + kArchiveSource + "\"" +
           ",\"archive_name\":\"" + archive_name + "\"" +
           ",\"origin_id\":\"" + kOriginID + "\"" +
           ",\"origin_name\":\"" + kOriginName + "\"" +
           ",\"dataset_id\":\"" + dataset_id + "\"" +
           ",\"license\":\"" + json_escape(a.license) + "\"" +
           ",\"license_url\":\"" + json_escape(a.license_url) + "\"" +
           ",\"citation\":\"" + json_escape(a.citation) + "\"";
}

std::string group_url(const GroupSpec* spec, const std::string& token) {
    const bool special = spec ? spec->special : false;
    return std::string(kGPBaseURL) + (special ? "?SPECIAL=" : "?GROUP=") + token + "&FORMAT=csv";
}

// ---------------------------------------------------------------------------
// Fetch context: job + one http response, shared by the reference parsers.
// ---------------------------------------------------------------------------

struct JobContext {
    std::string job_json;
    std::string source_url;
    std::string source_name;
    std::string provider_id;
    std::string archive_source;
    std::string archive_name;
    std::string reconcile;
    std::string dataset_id;
    std::string origin_id;
    std::string origin_name;
    std::string license;
    std::string license_url;
    std::string citation;
};

bool load_job(JobContext* ctx) {
    if (!read_json_frame("job", &ctx->job_json)) {
        plugin_set_error("missing-job-frame", "parser requires the job JSON frame.");
        return false;
    }
    json_string_field(ctx->job_json, "source_url", &ctx->source_url);
    json_string_field(ctx->job_json, "source_name", &ctx->source_name);
    json_string_field(ctx->job_json, "provider_id", &ctx->provider_id);
    json_string_field(ctx->job_json, "archive_source", &ctx->archive_source);
    json_string_field(ctx->job_json, "archive_name", &ctx->archive_name);
    json_string_field(ctx->job_json, "reconcile", &ctx->reconcile);
    json_string_field(ctx->job_json, "dataset_id", &ctx->dataset_id);
    json_string_field(ctx->job_json, "origin_id", &ctx->origin_id);
    json_string_field(ctx->job_json, "origin_name", &ctx->origin_name);
    json_string_field(ctx->job_json, "license", &ctx->license);
    json_string_field(ctx->job_json, "license_url", &ctx->license_url);
    json_string_field(ctx->job_json, "citation", &ctx->citation);
    if (ctx->provider_id.empty()) ctx->provider_id = kDefaultProviderID;
    if (ctx->origin_id.empty()) ctx->origin_id = kOriginID;
    if (ctx->origin_name.empty()) ctx->origin_name = kOriginName;
    if (ctx->source_name.empty()) {
        plugin_set_error("missing-source-name", "job must carry source_name.");
        return false;
    }
    return true;
}

struct HttpResponse {
    long status = 0;
    std::string etag;
    std::string last_modified;
    std::string content_type;
    std::string response_date;
    std::string request_url;  // present only when the connector echoes it
    std::vector<uint8_t> body;
    std::string sha256;
    int64_t retrieved_unix = 0;
};

// Decodes one hostcap/http-request response JSON. Returns false with a plugin
// error set for malformed frames; non-200/304 statuses are the caller's call.
bool decode_response(const std::string& response_json, HttpResponse* out) {
    double status = 0;
    if (!json_number_field(response_json, "status", &status)) {
        plugin_set_error("missing-status", "http response frame carries no status.");
        return false;
    }
    out->status = static_cast<long>(status);
    const std::string headers = json_object_slice(response_json, "headers");
    json_string_field(headers, "etag", &out->etag);
    if (out->etag.empty()) json_string_field(headers, "ETag", &out->etag);
    json_string_field(headers, "last-modified", &out->last_modified);
    if (out->last_modified.empty()) json_string_field(headers, "Last-Modified", &out->last_modified);
    json_string_field(headers, "content-type", &out->content_type);
    if (out->content_type.empty()) json_string_field(headers, "Content-Type", &out->content_type);
    json_string_field(headers, "date", &out->response_date);
    if (out->response_date.empty()) json_string_field(headers, "Date", &out->response_date);
    json_string_field(response_json, "url", &out->request_url);
    if (out->request_url.empty()) json_string_field(response_json, "requestUrl", &out->request_url);

    int64_t date_unix = 0;
    if (!out->response_date.empty() && parse_http_date(out->response_date, &date_unix)) {
        out->retrieved_unix = date_unix;
    } else {
        out->retrieved_unix = now_unix_seconds();
    }

    std::string body_b64;
    json_string_field(response_json, "bodyB64", &body_b64);
    if (!body_b64.empty()) {
        if (!base64_decode(body_b64, &out->body)) {
            plugin_set_error("invalid-body", "http response bodyB64 is not valid base64.");
            return false;
        }
    }
    out->sha256 = sha256_hex(out->body.data(), out->body.size());
    return true;
}

// {"status":304,"unchanged":true,...} — emitted instead of records when the
// source answered Not Modified.
std::string build_unchanged_json(const JobContext& ctx, const std::vector<std::string>& groups,
                                 int changed_count) {
    char changed_buf[16];
    std::snprintf(changed_buf, sizeof(changed_buf), "%d", changed_count);
    std::string out = std::string("{\"status\":304,\"unchanged\":true") +
                      ",\"source_name\":\"" + json_escape(ctx.source_name) + "\"" +
                      ",\"source_url\":\"" + json_escape(ctx.source_url) + "\"" +
                      ",\"provider_id\":\"" + json_escape(ctx.provider_id) + "\"" +
                      ",\"dataset_id\":\"" + json_escape(ctx.dataset_id) + "\"" +
                      ",\"origin_id\":\"" + json_escape(ctx.origin_id) + "\"" +
                      ",\"origin_name\":\"" + json_escape(ctx.origin_name) + "\"";
    if (!groups.empty()) out += ",\"groups\":" + json_string_array(groups);
    out += std::string(",\"changed_count\":") + changed_buf + "}";
    return out;
}

// storage.ingest_with_source meta for one schema (the parser's shape plus the
// origin/licence keys every CelesTrak lane now carries).
std::string build_ingest_meta(const JobContext& ctx, const char* schema,
                              const std::string& batch_id, const std::string& reconcile_default,
                              bool with_archive, const std::string& provenance_source,
                              const std::string& provenance_json) {
    const std::string reconcile = ctx.reconcile.empty() ? reconcile_default : ctx.reconcile;
    std::string meta = std::string("{\"schema\":\"") + schema + "\"" +
                       ",\"provider_id\":\"" + json_escape(ctx.provider_id) + "\"" +
                       ",\"source_name\":\"" + json_escape(ctx.source_name) + "\"" +
                       ",\"source_url\":\"" + json_escape(ctx.source_url) + "\"" +
                       ",\"batch_id\":\"" + batch_id + "\"" +
                       ",\"content_key_id\":\"" + kContentKeyID + "\"" +
                       ",\"source_peer\":\"" + kSourcePeer + "\"" +
                       ",\"reconcile\":\"" + json_escape(reconcile) + "\"" +
                       ",\"license\":\"" + json_escape(ctx.license) + "\"" +
                       ",\"license_url\":\"" + json_escape(ctx.license_url) + "\"" +
                       ",\"citation\":\"" + json_escape(ctx.citation) + "\"" +
                       ",\"origin_id\":\"" + json_escape(ctx.origin_id) + "\"" +
                       ",\"origin_name\":\"" + json_escape(ctx.origin_name) + "\"" +
                       ",\"dataset_id\":\"" + json_escape(ctx.dataset_id) + "\"";
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

// Provenance JSON in the parser's build_provenance_json shape, with warnings.
std::string build_provenance_json(const JobContext& ctx, const HttpResponse& primary,
                                  const std::string& source_url, const std::string& source_sha256,
                                  const char* parser_version,
                                  const std::string& normalized_sha256, int normalized_count,
                                  const std::string& schema_counts_json,
                                  const std::vector<std::string>& warnings,
                                  const std::string& extra_fields) {
    char status_buf[16];
    std::snprintf(status_buf, sizeof(status_buf), "%ld", primary.status);
    std::string out = std::string("{\"source_url\":\"") + json_escape(source_url) + "\"" +
                      ",\"http_status\":" + status_buf;
    if (!primary.etag.empty()) out += ",\"etag\":\"" + json_escape(primary.etag) + "\"";
    if (!primary.last_modified.empty())
        out += ",\"last_modified\":\"" + json_escape(primary.last_modified) + "\"";
    if (!primary.content_type.empty())
        out += ",\"content_type\":\"" + json_escape(primary.content_type) + "\"";
    char count_buf[16];
    std::snprintf(count_buf, sizeof(count_buf), "%d", normalized_count);
    out += std::string(",\"retrieved_at\":\"") + format_rfc3339(primary.retrieved_unix) + "\"" +
           ",\"parser_version\":\"" + parser_version + "\"" +
           ",\"source_sha256\":\"" + source_sha256 + "\"" +
           ",\"normalized_sha256\":\"" + normalized_sha256 + "\"" +
           ",\"normalized_count\":" + count_buf +
           ",\"schema_counts\":" + schema_counts_json +
           ",\"origin_id\":\"" + json_escape(ctx.origin_id) + "\"" +
           ",\"origin_name\":\"" + json_escape(ctx.origin_name) + "\"" +
           ",\"dataset_id\":\"" + json_escape(ctx.dataset_id) + "\"" +
           ",\"license\":\"" + json_escape(ctx.license) + "\"" +
           ",\"license_url\":\"" + json_escape(ctx.license_url) + "\"" +
           ",\"citation\":\"" + json_escape(ctx.citation) + "\"";
    if (!extra_fields.empty()) out += "," + extra_fields;
    out += ",\"warnings\":" + json_string_array(warnings) + ",\"from_cache\":false}";
    return out;
}

// ---------------------------------------------------------------------------
// Record builders.
// ---------------------------------------------------------------------------

std::vector<uint8_t> finished_copy(::flatbuffers::FlatBufferBuilder& fbb) {
    return std::vector<uint8_t>(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
}

std::vector<uint8_t> strip_prefix(const std::vector<uint8_t>& bytes) {
    return std::vector<uint8_t>(bytes.begin() + 4, bytes.end());
}

struct GroupMember {
    std::string record_id;
    uint32_t norad = 0;
};

struct GroupResult {
    std::string token;
    std::string label;
    std::string url;
    const GroupSpec* spec = nullptr;
    HttpResponse response;
    std::vector<Row> rows;
    std::vector<GroupMember> members;
};

std::vector<std::string> group_tags(const GroupSpec* spec) {
    std::set<std::string> tags;
    tags.insert("class:query");
    tags.insert(std::string("provisioner:") + kOriginID);
    tags.insert("status:active");
    if (spec && spec->constellation) tags.insert(std::string("constellation:") + spec->constellation);
    if (spec && spec->regime) tags.insert(std::string("regime:") + spec->regime);
    return std::vector<std::string>(tags.begin(), tags.end());  // std::set = sorted + deduped
}

// One $EGP for a GP group: QUERY_SNAPSHOT membership over the group's rows.
std::vector<uint8_t> build_egp_record(const GroupResult& group, const JobContext& ctx) {
    ::flatbuffers::FlatBufferBuilder fbb(4096);
    const std::string retrieved = format_rfc3339_ms(group.response.retrieved_unix);

    std::vector<::flatbuffers::Offset<EGPMember>> members;
    members.reserve(group.members.size());
    for (const GroupMember& m : group.members) {
        const auto standard = fbb.CreateString("$OMM");
        const auto record_id = fbb.CreateString(m.record_id);
        EGPMemberBuilder mb(fbb);
        mb.add_STANDARD(standard);
        mb.add_RECORD_ID(record_id);
        mb.add_NORAD_CAT_ID(m.norad);
        members.push_back(mb.Finish());
    }
    const auto members_off = fbb.CreateVector(members);

    std::vector<::flatbuffers::Offset<::flatbuffers::String>> tag_offs;
    for (const std::string& tag : group_tags(group.spec)) tag_offs.push_back(fbb.CreateString(tag));
    const auto tags_off = fbb.CreateVector(tag_offs);

    const auto q_dialect = fbb.CreateString("https");
    const auto q_text = fbb.CreateString(group.url);
    const auto q_evaluated = fbb.CreateString(retrieved);
    EGPQueryBuilder qb(fbb);
    qb.add_DIALECT(q_dialect);
    qb.add_TEXT(q_text);
    qb.add_EVALUATED_AT(q_evaluated);
    qb.add_RESULT_COUNT(static_cast<uint32_t>(group.members.size()));
    const auto query_off = qb.Finish();

    const auto p_source = fbb.CreateString(kOriginName);
    const auto p_dataset = fbb.CreateString("GP group " + group.token);
    const auto p_url = fbb.CreateString(group.url);
    const auto p_retrieved = fbb.CreateString(retrieved);
    const auto p_sha = fbb.CreateString(group.response.sha256);
    const auto p_license = fbb.CreateString(ctx.license);
    const auto p_attribution = fbb.CreateString(ctx.citation);
    EGPProvenanceBuilder pb(fbb);
    pb.add_SOURCE(p_source);
    pb.add_SOURCE_DATASET(p_dataset);
    pb.add_SOURCE_URL(p_url);
    pb.add_RETRIEVED_AT(p_retrieved);
    pb.add_SOURCE_SHA256(p_sha);
    pb.add_LICENSE(p_license);
    pb.add_ATTRIBUTION(p_attribution);
    std::vector<::flatbuffers::Offset<EGPProvenance>> provenance;
    provenance.push_back(pb.Finish());
    const auto provenance_off = fbb.CreateVector(provenance);

    const auto group_id = fbb.CreateString(std::string(kOriginID) + "/gp/" + group.token);
    const auto name = fbb.CreateString(group.token);
    const auto description = fbb.CreateString(group.label.empty() ? group.token : group.label);
    const auto created_at = fbb.CreateString(retrieved);
    const auto updated_at = fbb.CreateString(retrieved);

    EGPBuilder builder(fbb);
    builder.add_GROUP_ID(group_id);
    builder.add_NAME(name);
    builder.add_DESCRIPTION(description);
    builder.add_TAGS(tags_off);
    builder.add_MEMBERSHIP_MODE(egpMembershipMode_QUERY_SNAPSHOT);
    builder.add_MEMBERS(members_off);
    builder.add_QUERY(query_off);
    builder.add_CREATED_AT(created_at);
    builder.add_UPDATED_AT(updated_at);
    builder.add_PROVENANCE(provenance_off);
    const auto egp = builder.Finish();
    FinishSizePrefixedEGPBuffer(fbb, egp);
    return strip_prefix(finished_copy(fbb));
}

// --- OMM row builder (copied from celestrak-parser; optional re-emission) ---

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
    // CelesTrak GP elements are SGP4 mean elements in TEME of date: the GP
    // product defines them that way, and CelesTrak's own OMM KVN/XML for the
    // same data states REF_FRAME = TEME. The frame is the source's contract,
    // not an inference, so every GP-group OMM declares it, exactly as
    // celestrak-parser's parse_gp does.
    const auto reference_frame_off = CreateRFM(
        fbb, RFMUnion_CelestialFrameWrapper,
        CreateCelestialFrameWrapper(fbb, CelestialFrame_TEMEOFDATE).Union());
    const auto creation_date_off = fbb.CreateString(creation_date);
    const auto originator_off = fbb.CreateString(originator);
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
    builder.add_REFERENCE_FRAME(reference_frame_off);
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
    return strip_prefix(finished_copy(fbb));
}

// A GP CSV row -> OMM record (parse_gp rules); false when the row has no
// usable NORAD id, error text when the EPOCH is malformed.
bool gp_row_to_omm(const Row& row, std::vector<uint8_t>* out, std::string* err) {
    uint32_t norad = 0;
    if (!parse_uint32(row_value(row, {"NORAD_CAT_ID", "NORAD_CAT_NUM"}), &norad) || norad == 0) {
        return false;
    }
    const std::string raw_epoch = row_value(row, {"EPOCH", "EPOCH_UTC"});
    ParsedEpoch epoch;
    if (!trim(raw_epoch).empty()) {
        epoch = parse_epoch(raw_epoch);
        if (!epoch.valid) {
            char msg[96];
            std::snprintf(msg, sizeof(msg), "malformed EPOCH for NORAD_CAT_ID=%u", norad);
            *err = msg;
            return false;
        }
    }
    const std::string object_name = value_or(row_value(row, {"OBJECT_NAME", "SATNAME", "NAME"}),
                                             "SAT-" + std::to_string(norad));
    const std::string object_id =
        value_or(row_value(row, {"OBJECT_ID", "INTLDES", "INTERNATIONAL_DESIGNATOR"}),
                 "NORAD-" + std::to_string(norad));
    std::string creation_date = trim(row_value(row, {"CREATION_DATE"}));
    std::string epoch_rfc3339;
    if (epoch.valid) epoch_rfc3339 = format_rfc3339(epoch.unix_seconds);
    if (creation_date.empty() && epoch.valid) creation_date = epoch_rfc3339;

    double mean_motion = 15.5, ecc = 0.0001, incl = 51.6, raan = 180.0, argp = 90.0, ma = 0.0;
    double v = 0;
    if (parse_float(row_value(row, {"MEAN_MOTION", "N"}), &v)) mean_motion = v;
    if (parse_float(row_value(row, {"ECCENTRICITY", "ECC"}), &v)) ecc = v;
    if (parse_float(row_value(row, {"INCLINATION", "INC"}), &v)) incl = v;
    if (parse_float(row_value(row, {"RA_OF_ASC_NODE", "RAAN"}), &v)) raan = v;
    if (parse_float(row_value(row, {"ARG_OF_PERICENTER", "ARGP"}), &v)) argp = v;
    if (parse_float(row_value(row, {"MEAN_ANOMALY", "MA"}), &v)) ma = v;
    double bstar = 0, mm_dot = 0, mm_ddot = 0, rev_at_epoch = 0;
    uint32_t element_set_no = 0;
    if (parse_float(row_value(row, {"BSTAR", "B_STAR"}), &v)) bstar = v;
    if (parse_float(row_value(row, {"MEAN_MOTION_DOT", "N_DOT", "NDOT"}), &v)) mm_dot = v;
    if (parse_float(row_value(row, {"MEAN_MOTION_DDOT", "N_DDOT", "NDDOT"}), &v)) mm_ddot = v;
    uint32_t u = 0;
    if (parse_uint32(row_value(row, {"ELEMENT_SET_NO", "ELSET_NO"}), &u)) element_set_no = u;
    if (parse_float(row_value(row, {"REV_AT_EPOCH", "REV"}), &v)) rev_at_epoch = v;
    const std::string classification = trim(row_value(row, {"CLASSIFICATION_TYPE", "CLASSIFICATION"}));
    const EphemerisType ephemeris_type = normalize_ephemeris_type(row_value(row, {"EPHEMERIS_TYPE"}));
    const std::string originator = value_or(row_value(row, {"ORIGINATOR"}), "CELESTRAK");
    std::string epoch_field = epoch_rfc3339;
    if (epoch_field.empty()) epoch_field = format_rfc3339(now_unix_seconds());

    *out = build_omm_record(object_name, object_id, norad, epoch_field, mean_motion, ecc, incl,
                            raan, argp, ma, creation_date, originator, classification, bstar,
                            mm_dot, mm_ddot, element_set_no, rev_at_epoch, ephemeris_type);
    return true;
}

// --- $SIT / $LCC ---

std::vector<uint8_t> build_sit_record(const std::string& code, const std::string& description) {
    ::flatbuffers::FlatBufferBuilder fbb(512);
    const auto id_off = fbb.CreateString(code);
    const auto name_off = fbb.CreateString(description);
    const auto abbreviation_off = fbb.CreateString(code);
    const auto description_off = fbb.CreateString(description);
    const auto source_off = fbb.CreateString(kOriginName);

    SITBuilder builder(fbb);
    builder.add_ID(id_off);
    builder.add_NAME(name_off);
    builder.add_ABBREVIATION(abbreviation_off);
    builder.add_SITE_TYPE(SiteType_LAUNCH_SITE);
    builder.add_LATITUDE(0.0f);
    builder.add_LONGITUDE(0.0f);
    builder.add_DESCRIPTION(description_off);
    builder.add_SOURCE(source_off);
    const auto sit = builder.Finish();
    FinishSizePrefixedSITBuffer(fbb, sit);
    return strip_prefix(finished_copy(fbb));
}

// Strict legacyCountryCode label lookup (copied from celestrak-parser
// satcat_owner_code): a source value must exactly match a generated enum
// label; nothing is substituted, remapped or guessed.
bool satcat_owner_code(const std::string& value, legacyCountryCode* out) {
    const std::string owner = trim(value);
    const auto& values = EnumValueslegacyCountryCode();
    const char* const* names = EnumNameslegacyCountryCode();
    for (size_t i = 0; i <= static_cast<size_t>(legacyCountryCode_MAX); ++i) {
        if (owner == names[i]) {
            *out = values[i];
            return true;
        }
    }
    return false;
}

std::vector<uint8_t> build_lcc_record(legacyCountryCode owner, const std::string& description,
                                      const std::string& source_url,
                                      const std::string& retrieved_at) {
    ::flatbuffers::FlatBufferBuilder fbb(512);
    const auto name_off = fbb.CreateString(description);
    const auto description_off = fbb.CreateString(description);
    const auto source_url_off = fbb.CreateString(source_url);
    const auto retrieved_off = fbb.CreateString(retrieved_at);

    LCCBuilder builder(fbb);
    builder.add_OWNER(owner);
    builder.add_NAME(name_off);
    builder.add_DESCRIPTION(description_off);
    builder.add_ACTIVE(true);
    builder.add_SOURCE_URL(source_url_off);
    builder.add_RETRIEVED_AT(retrieved_off);
    const auto lcc = builder.Finish();
    FinishSizePrefixedLCCBuffer(fbb, lcc);
    return strip_prefix(finished_copy(fbb));
}

// ---------------------------------------------------------------------------
// Group list resolution (compiled registry, node CONFIG override).
// ---------------------------------------------------------------------------

struct GroupPlan {
    std::string token;
    std::string label;
    std::string url;
    const GroupSpec* spec;
};

std::vector<GroupPlan> resolve_groups(const std::string& config, std::string* err) {
    std::vector<GroupPlan> plan;
    std::string override_list;
    json_string_field(config, "celestrak_gp_groups", &override_list);
    std::vector<std::string> tokens;
    if (!trim(override_list).empty()) {
        std::string current;
        for (size_t i = 0; i <= override_list.size(); i++) {
            if (i == override_list.size() || override_list[i] == ',') {
                const std::string t = trim(current);
                if (!t.empty()) tokens.push_back(t);
                current.clear();
            } else {
                current.push_back(override_list[i]);
            }
        }
    } else {
        for (size_t i = 0; i < kGroupCount; i++) tokens.push_back(kGroups[i].token);
    }
    std::set<std::string> seen;
    for (const std::string& token : tokens) {
        if (!seen.insert(token).second) continue;
        for (const char c : token) {
            const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                            (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.';
            if (!ok) {
                *err = "group token \"" + token + "\" carries characters outside [A-Za-z0-9._-].";
                return {};
            }
        }
        GroupPlan g;
        g.token = token;
        g.spec = find_group(token);
        g.label = g.spec ? g.spec->label : token;
        g.url = group_url(g.spec, token);
        plan.push_back(g);
    }
    if (plan.empty()) {
        *err = "the GP group list is empty.";
        return {};
    }
    if (plan.size() > kMaxGroups) {
        char msg[160];
        std::snprintf(msg, sizeof(msg),
                      "the GP group list carries %zu entries; at most %zu fit one flow invocation "
                      "(one job frame plus one response per group).",
                      plan.size(), kMaxGroups);
        *err = msg;
        return {};
    }
    return plan;
}

}  // namespace

// ---------------------------------------------------------------------------
// Method entry points.
// ---------------------------------------------------------------------------

extern "C" {

// gp_groups: timer tick -> N request frames (one per GP group/special query)
// on "request" and ONE job frame carrying the ordered group list on "job".
int gp_groups(void) {
    char batch_message[384];
    if (find_batched_input_port(nullptr, batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const std::string config = load_config();
    std::string err;
    const std::vector<GroupPlan> plan = resolve_groups(config, &err);
    if (plan.empty()) {
        plugin_set_error("invalid-group-list", err.c_str());
        return 400;
    }
    const long timeout = config_timeout_ms(config);
    const LaneAttribution attribution = lane_attribution(config);

    std::string groups_json = "[";
    for (size_t i = 0; i < plan.size(); i++) {
        if (push_json("request", build_request_json(plan[i].url, timeout, kGroupMaxBytes)) < 0) {
            return 500;
        }
        if (i) groups_json += ",";
        groups_json += std::string("{\"token\":\"") + json_escape(plan[i].token) + "\"" +
                       ",\"kind\":\"" + (plan[i].spec && plan[i].spec->special ? "SPECIAL" : "GROUP") +
                       "\"" + ",\"label\":\"" + json_escape(plan[i].label) + "\"" +
                       ",\"url\":\"" + json_escape(plan[i].url) + "\"}";
    }
    groups_json += "]";
    char count_buf[16];
    std::snprintf(count_buf, sizeof(count_buf), "%zu", plan.size());
    const std::string job = "{" +
                            job_json_fields(attribution, kGPIndexURL, kSourceGPGroups,
                                            "gp-groups.csv", kDatasetGPGroups) +
                            ",\"group_count\":" + count_buf + ",\"groups\":" + groups_json + "}";
    return push_json("job", job) < 0 ? 500 : 0;
}

// satcat_reference: timer tick -> the launch-site and owner/source table
// fetches, each as a request/job pair.
int satcat_reference(void) {
    char batch_message[384];
    if (find_batched_input_port(nullptr, batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const std::string config = load_config();
    const long timeout = config_timeout_ms(config);
    const LaneAttribution attribution = lane_attribution(config);
    const std::string sites_url =
        config_string(config, "celestrak_satcat_launchsites_url", kDefaultLaunchSitesURL);
    const std::string sources_url =
        config_string(config, "celestrak_satcat_sources_url", kDefaultSourcesURL);

    if (push_json("request_sites", build_request_json(sites_url, timeout, kReferenceMaxBytes)) < 0)
        return 500;
    if (push_json("job_sites", "{" + job_json_fields(attribution, sites_url, kSourceLaunchSites,
                                                     "launchsites.html", kDatasetLaunchSites) +
                                   "}") < 0)
        return 500;
    if (push_json("request_owners", build_request_json(sources_url, timeout, kReferenceMaxBytes)) < 0)
        return 500;
    if (push_json("job_owners", "{" + job_json_fields(attribution, sources_url, kSourceOwners,
                                                      "sources.html", kDatasetOwners) +
                                    "}") < 0)
        return 500;
    return 0;
}

// parse_gp_groups: (job with N groups, N responses in request order) -> one
// $EGP per group. 304 groups go to "unchanged"; a group answering anything
// else than 200/304 fails the batch (CelesTrak policy: stop on non-200).
int parse_gp_groups(void) {
    char batch_message[384];
    if (find_batched_input_port("response", batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    JobContext ctx;
    if (!load_job(&ctx)) return 400;
    if (ctx.dataset_id.empty()) ctx.dataset_id = kDatasetGPGroups;

    const std::vector<std::string> group_objects = json_array_objects(ctx.job_json, "groups");
    const uint32_t response_count = frames_on_port("response");
    if (group_objects.empty()) {
        plugin_set_error("missing-group-list", "the gp-groups job carries no groups.");
        return 400;
    }
    if (response_count != group_objects.size()) {
        char msg[192];
        std::snprintf(msg, sizeof(msg),
                      "the job lists %zu groups but %u responses arrived; the group snapshot is "
                      "refused rather than published partially.",
                      group_objects.size(), response_count);
        plugin_set_error("group-count-mismatch", msg);
        return 409;
    }

    std::vector<GroupResult> changed;
    std::vector<std::string> unchanged;
    std::vector<std::string> warnings;
    const bool emit_omm = json_truthy_field(load_config(), "celestrak_gp_groups_emit_omm");

    for (uint32_t i = 0; i < response_count; i++) {
        GroupResult g;
        json_string_field(group_objects[i], "token", &g.token);
        json_string_field(group_objects[i], "label", &g.label);
        json_string_field(group_objects[i], "url", &g.url);
        g.spec = find_group(g.token);
        if (g.token.empty() || g.url.empty()) {
            plugin_set_error("invalid-group-entry", "every job group needs token and url.");
            return 400;
        }
        std::string response_json;
        if (!read_json_frame_at("response", i, &response_json)) {
            plugin_set_error("missing-response-frame", "a response frame is empty.");
            return 400;
        }
        if (!decode_response(response_json, &g.response)) return 400;
        if (!g.response.request_url.empty() && g.response.request_url != g.url) {
            const std::string msg = "response " + std::to_string(i) + " answers " +
                                    g.response.request_url + " but the job expected " + g.url + ".";
            plugin_set_error("group-url-mismatch", msg.c_str());
            return 409;
        }
        if (g.response.status == 304) {
            unchanged.push_back(g.token);
            continue;
        }
        if (g.response.status != 200) {
            char msg[160];
            std::snprintf(msg, sizeof(msg), "GP group %s returned HTTP status %ld",
                          g.token.c_str(), g.response.status);
            plugin_set_error("fetch-failed", msg);
            return 400;
        }
        std::vector<std::string> header;
        std::string err;
        if (!parse_csv(g.response.body, &g.rows, &header, &err)) {
            plugin_set_error("gp-group-parse-failed", ("GP group " + g.token + ": " + err).c_str());
            return 422;
        }
        if (!require_csv_column(header, {"NORAD_CAT_ID", "NORAD_CAT_NUM"})) {
            plugin_set_error("gp-group-parse-failed",
                             ("GP group " + g.token + " is missing column NORAD_CAT_ID.").c_str());
            return 422;
        }
        for (const Row& row : g.rows) {
            uint32_t norad = 0;
            if (!parse_uint32(row_value(row, {"NORAD_CAT_ID", "NORAD_CAT_NUM"}), &norad) ||
                norad == 0) {
                warnings.push_back("GP group " + g.token + ": row without NORAD_CAT_ID skipped");
                continue;
            }
            GroupMember m;
            m.norad = norad;
            m.record_id = value_or(row_value(row, {"OBJECT_ID", "INTLDES", "INTERNATIONAL_DESIGNATOR"}),
                                   "NORAD-" + std::to_string(norad));
            g.members.push_back(m);
        }
        changed.push_back(std::move(g));
    }

    if (!unchanged.empty()) {
        if (push_json("unchanged", build_unchanged_json(ctx, unchanged,
                                                        static_cast<int>(changed.size()))) < 0) {
            return 500;
        }
    }
    if (changed.empty()) return 0;

    // batch id = sha256 of the concatenated group payloads in list order; the
    // raw archive is that same concatenation.
    Sha256 batch_hash;
    std::vector<uint8_t> raw;
    for (const GroupResult& g : changed) {
        batch_hash.update(g.response.body.data(), g.response.body.size());
        raw.insert(raw.end(), g.response.body.begin(), g.response.body.end());
    }
    const std::string batch_id = batch_hash.hex_digest();

    std::vector<uint8_t> egp_stream;
    Sha256 normalized;
    int count_egp = 0;
    for (const GroupResult& g : changed) {
        const std::vector<uint8_t> egp = build_egp_record(g, ctx);
        append_size_prefixed(&egp_stream, egp);
        normalized_hash_record(&normalized, "EGP.fbs", egp);
        count_egp++;
    }

    std::vector<uint8_t> omm_stream;
    int count_omm = 0;
    if (emit_omm) {
        std::set<std::string> seen;  // (NORAD, EPOCH) pairs across groups
        for (const GroupResult& g : changed) {
            for (const Row& row : g.rows) {
                const std::string key = row_value(row, {"NORAD_CAT_ID", "NORAD_CAT_NUM"}) + "@" +
                                        row_value(row, {"EPOCH", "EPOCH_UTC"});
                if (!seen.insert(key).second) continue;
                std::vector<uint8_t> omm;
                std::string err;
                if (!gp_row_to_omm(row, &omm, &err)) {
                    if (!err.empty()) {
                        plugin_set_error("gp-group-parse-failed",
                                         ("GP group " + g.token + ": " + err).c_str());
                        return 422;
                    }
                    continue;
                }
                append_size_prefixed(&omm_stream, omm);
                normalized_hash_record(&normalized, "OMM.fbs", omm);
                count_omm++;
            }
        }
    }

    const std::string normalized_hex = normalized.hex_digest();
    char counts[96];
    if (emit_omm) {
        std::snprintf(counts, sizeof(counts), "{\"EGP.fbs\":%d,\"OMM.fbs\":%d}", count_egp, count_omm);
    } else {
        std::snprintf(counts, sizeof(counts), "{\"EGP.fbs\":%d}", count_egp);
    }
    std::vector<std::string> group_tokens, group_urls;
    for (const GroupResult& g : changed) {
        group_tokens.push_back(g.token);
        group_urls.push_back(g.url);
    }
    const std::string extra = "\"groups\":" + json_string_array(group_tokens) +
                              ",\"group_urls\":" + json_string_array(group_urls) +
                              ",\"unchanged_groups\":" + json_string_array(unchanged);
    const std::string provenance = build_provenance_json(
        ctx, changed[0].response, ctx.source_url, batch_id, "celestrak-gp-groups-wasm/v1",
        normalized_hex, count_egp + count_omm, counts, warnings, extra);

    // A complete snapshot (every group answered 200) supersedes the lane;
    // a partial refresh (some groups unchanged) is appended, and $EGP's
    // latest-UPDATED_AT-per-GROUP_ID rule picks the current version.
    const std::string reconcile = unchanged.empty() ? "current" : "duplicates";
    const std::string egp_meta = build_ingest_meta(ctx, "EGP.fbs", batch_id, reconcile,
                                                   /*with_archive=*/true, ctx.source_name,
                                                   provenance);
    if (push_json("egp_meta", egp_meta) < 0) return 500;
    if (push_record_stream("egp_records", "EGP.fbs", "$EGP", "EGP", egp_stream) < 0) return 500;
    if (push_bytes("raw", raw) < 0) return 500;
    if (emit_omm && count_omm > 0) {
        const std::string omm_meta = build_ingest_meta(ctx, "OMM.fbs", batch_id, "duplicates",
                                                       /*with_archive=*/false, ctx.source_name,
                                                       std::string());
        if (push_json("omm_meta", omm_meta) < 0) return 500;
        if (push_record_stream("omm_records", "OMM.fbs", "$OMM", "OMM", omm_stream) < 0) return 500;
    }
    return 0;
}

// parse_satcat_reference: (job, response) -> $SIT rows for the launch-site
// table or $LCC rows for the owner/source table; the job's dataset_id decides.
int parse_satcat_reference(void) {
    char batch_message[384];
    if (find_batched_input_port(nullptr, batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    JobContext ctx;
    if (!load_job(&ctx)) return 400;
    std::string response_json;
    if (!read_json_frame("response", &response_json)) {
        plugin_set_error("missing-response-frame", "parser requires the http response JSON frame.");
        return 400;
    }
    HttpResponse response;
    if (!decode_response(response_json, &response)) return 400;

    const bool sites = ctx.dataset_id == kDatasetLaunchSites;
    const bool owners = ctx.dataset_id == kDatasetOwners;
    if (!sites && !owners) {
        plugin_set_error("unknown-reference-dataset",
                         ("dataset_id \"" + ctx.dataset_id + "\" is not a SATCAT reference table.")
                             .c_str());
        return 400;
    }
    if (response.status == 304) {
        return push_json("unchanged", build_unchanged_json(ctx, {}, 0)) < 0 ? 500 : 0;
    }
    if (response.status != 200) {
        char msg[96];
        std::snprintf(msg, sizeof(msg), "source fetch returned HTTP status %ld", response.status);
        plugin_set_error("fetch-failed", msg);
        return 400;
    }
    if (response.body.empty()) {
        plugin_set_error("empty-body", "http response frame carries no body.");
        return 400;
    }

    std::vector<std::vector<std::string>> rows;
    std::string err;
    if (!scan_html_table(response.body, &rows, &err)) {
        plugin_set_error("reference-parse-failed", err.c_str());
        return 422;
    }

    std::vector<uint8_t> stream;
    Sha256 normalized;
    std::vector<std::string> warnings;
    int count = 0;
    std::set<std::string> seen_codes;
    const std::string retrieved_at = format_rfc3339(response.retrieved_unix);
    for (const auto& cells : rows) {
        if (cells.size() < 2) continue;  // header, footer notes, spacer rows
        const std::string code = trim(cells[0]);
        const std::string description = trim(cells[1]);
        if (code.empty() || description.empty()) continue;
        if (!seen_codes.insert(code).second) {
            warnings.push_back("duplicate code " + code + " skipped");
            continue;
        }
        if (sites) {
            const std::vector<uint8_t> sit = build_sit_record(code, description);
            append_size_prefixed(&stream, sit);
            normalized_hash_record(&normalized, "SIT.fbs", sit);
            count++;
        } else {
            legacyCountryCode owner = legacyCountryCode_UNK;
            if (!satcat_owner_code(code, &owner)) {
                warnings.push_back("unknown owner code " + code);
                continue;
            }
            const std::vector<uint8_t> lcc =
                build_lcc_record(owner, description, ctx.source_url, retrieved_at);
            append_size_prefixed(&stream, lcc);
            normalized_hash_record(&normalized, "LCC.fbs", lcc);
            count++;
        }
    }
    if (count == 0) {
        plugin_set_error("reference-parse-failed",
                         sites ? "no launch-site rows parsed" : "no owner rows parsed");
        return 422;
    }

    const char* schema = sites ? "SIT.fbs" : "LCC.fbs";
    const std::string normalized_hex = normalized.hex_digest();
    char counts[48];
    std::snprintf(counts, sizeof(counts), "{\"%s\":%d}", schema, count);
    const std::string provenance = build_provenance_json(
        ctx, response, ctx.source_url, response.sha256, "celestrak-satcat-reference-wasm/v1",
        normalized_hex, count, counts, warnings, std::string());
    const std::string meta = build_ingest_meta(ctx, schema, response.sha256, "current",
                                               /*with_archive=*/true, ctx.source_name,
                                               provenance);
    if (push_json(sites ? "sit_meta" : "lcc_meta", meta) < 0) return 500;
    if (sites) {
        if (push_record_stream("sit_records", "SIT.fbs", "$SIT", "SIT", stream) < 0) return 500;
    } else {
        if (push_record_stream("lcc_records", "LCC.fbs", "$LCC", "LCC", stream) < 0) return 500;
    }
    if (push_bytes("raw", response.body) < 0) return 500;
    return 0;
}

}  // extern "C"
