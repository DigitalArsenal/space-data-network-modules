/*
 * data-source/celestrak-reference (typed contracts 1.0: FlatBuffers only, no JSON and no base64).
 *
 * One self-contained CelesTrak reference module: request builders AND parsers for the two reference lanes that make
 * the CelesTrak dataset set definitive:
 *
 *   gp_groups              TimerTick -> one HttpRequest (HREQ) per GP group query on "request" (the 47 GROUP tokens
 *                          and the 2 SPECIAL queries gpz / gpz-plus, or node CONFIG celestrak_gp_groups), each carrying
 *                          its job in CONTEXT.
 *   parse_gp_groups        the groups' HttpResponses (HRSP, paired by CONTEXT, any order) -> one $EGP per group
 *                          (egp_meta IngestRequest / egp_records / raw HttpResponse), optional OMM re-emission
 *                          (omm_meta / omm_records), and a FlowNotice on "unchanged" for groups that answered 304.
 *   satcat_reference       TimerTick -> the launch-site and owners/sources table fetches (request_sites,
 *                          request_owners), each HREQ carrying its job in CONTEXT.
 *   parse_satcat_reference HttpResponse -> $SIT rows (launch sites) or $LCC rows (owner codes) from the HTML tables;
 *                          the job's DATASET_ID decides.
 *
 * JOB CONTRACT (shared with the other CelesTrak lanes): the job travels as HttpRequest.CONTEXT - ONE size-prefixed
 * $ICN (Ingest Connector) record - and hostcap/http-request echoes it verbatim in the HttpResponse, so a response is
 * attributed by what it carries, never by its position. The $ICN names CONNECTOR_ID (the lane's source name; a GP group
 * job: "celestrak-gp-groups/<TOKEN>"), KIND HttpsPull, HTTP_METHOD GET, ENDPOINT_URL, TARGET_SCHEMA, EMITS_SCHEMAS,
 * POST_INGEST_ACTION Archive, ORIGIN_ID celestrak.org, ORIGIN_NAME CelesTrak, DATASET_ID, PROVIDER_ID, SOURCE_NAME and
 * the usage terms LICENSE / LICENSE_URL / CITATION. Each ingest meta is an IngestRequest (INGQ): SCHEMA, TAGS (provider,
 * source, batch, url, content key "public", source peer "source:celestrak", licence identifier, licence url, citation),
 * RECONCILE, ARCHIVE (source "celestrak", the lane's archive name, keyed by the job's DATASET_ID) and PROVENANCE.
 *
 * GROUP PAIRING. parse_gp_groups reads each response's group token from its $ICN CONNECTOR_ID and resolves the group
 * plan from its own node CONFIG exactly as gp_groups does (the flow service gives every node the same config); it
 * refuses the batch unless exactly one response per planned group arrived (group-count-mismatch) and refuses a token
 * outside the plan or a URL other than the plan's (group-url-mismatch). Output order and the batch hash follow the plan.
 * The compiled flow runtime hands a node at most 64 frames per invocation, so the list is capped at 63 groups.
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
#include "typedHostcall.hpp"
#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"
#include "IngestRequest_generated.h"
#include "FlowNotice_generated.h"
// The SDS standards (RFM TIM MET IDM PLD LCC OMM CAT EGP SIT ICN, lib/cpp/<CODE>/main_generated.h) are inlined
// ahead of this file by build.mjs.

namespace {

namespace A = sdn::runtime::Aligned;
namespace R = sdn::runtime;


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
constexpr size_t kMaxGroups = 63;             // 63 responses within the runtime budget of 64 frames

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
// TAGS.LICENSE (an SPDX identifier, at most 64 bytes) when the configured terms are prose, as they are by default.
constexpr const char* kLicenseRef = "LicenseRef-CelesTrak-Usage-Policy";

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

using Bytes = std::vector<uint8_t>;

Bytes finished_bytes(const ::flatbuffers::FlatBufferBuilder& b) {
    return Bytes(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

std::vector<const plugin_input_frame_t*> frames_on(const char* port) {
    std::vector<const plugin_input_frame_t*> out;
    for (uint32_t ordinal = 0;; ordinal++) {
        const int32_t idx = plugin_find_input_index(port, ordinal);
        if (idx < 0) break;
        out.push_back(plugin_get_input_frame(static_cast<uint32_t>(idx)));
    }
    return out;
}

int push_typed(const char* port, const char* schema, const char* identifier, const char* root, const Bytes& bytes) {
    return plugin_push_output_ex(port, schema, identifier, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0,
                                 bytes.data(), static_cast<uint32_t>(bytes.size()));
}

// The record streams declare their concrete SDS identity on the port, so the frame carries it too.
int push_record_stream(const char* port, const char* schema, const char* identifier, const char* root,
                       const Bytes& bytes) {
    return push_typed(port, schema, identifier, root, bytes);
}
int push_request(const char* port, const Bytes& bytes) {
    return push_typed(port, "HttpRequest.fbs", R::HttpRequestIdentifier(), "HttpRequest", bytes);
}
int push_response(const char* port, const uint8_t* data, size_t length) {
    return plugin_push_output_ex(port, "HttpResponse.fbs", R::HttpResponseIdentifier(),
                                 PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "HttpResponse", 0, 0, data,
                                 static_cast<uint32_t>(length));
}
int push_ingest_request(const char* port, const Bytes& bytes) {
    return push_typed(port, "IngestRequest.fbs", R::IngestRequestIdentifier(), "IngestRequest", bytes);
}
int push_notice(const Bytes& bytes) {
    return push_typed("unchanged", "FlowNotice.fbs", R::FlowNoticeIdentifier(), "FlowNotice", bytes);
}

void append_size_prefixed(Bytes* stream, const Bytes& record) {
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
// Node CONFIG: plugin.getConfig as an SDS $PIV hostcall - one ModuleConfig (MCFG) FlatBuffer on raw "config", read in
// place through sdm_piv::get_config(). No config reads as the defaults.
// ---------------------------------------------------------------------------

std::string format_number(double v) {
    char buf[40];
    if (std::fabs(v - std::round(v)) < 1e-9 && std::fabs(v) < 9.0e15) std::snprintf(buf, sizeof(buf), "%.0f", v);
    else std::snprintf(buf, sizeof(buf), "%.17g", v);
    return buf;
}

struct Config {
    sdm_piv::Config cfg;

    using Entry = sdn::runtime::ConfigEntry;
    static std::string str_of(const flatbuffers::String* s) { return s ? s->str() : std::string(); }
    // A scalar's text; a StringList / NumberList joined with commas.
    static std::string text_of(const Entry& e) {
        switch (e.KIND()) {
            case sdn::runtime::configValueKind_String: return str_of(e.STRING_VALUE());
            case sdn::runtime::configValueKind_Number: return format_number(e.NUMBER_VALUE());
            case sdn::runtime::configValueKind_Bool: return e.BOOL_VALUE() ? "true" : "false";
            case sdn::runtime::configValueKind_StringList: {
                std::string joined;
                if (e.STRINGS()) for (flatbuffers::uoffset_t i = 0; i < e.STRINGS()->size(); i++) joined += (i ? "," : "") + str_of(e.STRINGS()->Get(i));
                return joined;
            }
            case sdn::runtime::configValueKind_NumberList: {
                std::string joined;
                if (e.NUMBERS()) for (flatbuffers::uoffset_t i = 0; i < e.NUMBERS()->size(); i++) joined += (i ? "," : "") + format_number(e.NUMBERS()->Get(i));
                return joined;
            }
            default: return std::string();
        }
    }
    // A scalar, or a list joined with commas; `fallback` when absent or empty.
    std::string string(const char* key, const char* fallback) const {
        if (const Entry* e = cfg.entry(key)) {
            const std::string v = text_of(*e);
            return v.empty() ? fallback : v;
        }
        return fallback;
    }
    double number(const char* key, double fallback) const {
        const Entry* e = cfg.entry(key);
        if (!e) return fallback;
        if (e->KIND() == sdn::runtime::configValueKind_Number) return e->NUMBER_VALUE();
        if (e->KIND() == sdn::runtime::configValueKind_String) {
            const std::string s = str_of(e->STRING_VALUE());
            char* end = nullptr;
            const double v = strtod(s.c_str(), &end);
            if (end != s.c_str()) return v;
        }
        return fallback;
    }
    // true / "true" / 1 read as set (the legacy truthy rule).
    bool boolean(const char* key, bool fallback) const {
        const Entry* e = cfg.entry(key);
        if (!e) return fallback;
        if (e->KIND() == sdn::runtime::configValueKind_Bool) return e->BOOL_VALUE();
        if (e->KIND() == sdn::runtime::configValueKind_Number) return e->NUMBER_VALUE() != 0;
        if (e->KIND() != sdn::runtime::configValueKind_String) return fallback;
        const std::string s = str_of(e->STRING_VALUE());
        if (s == "true" || s == "1") return true;
        if (s == "false" || s == "0") return false;
        return fallback;
    }
};

Config load_config() { return Config{sdm_piv::get_config()}; }

long config_timeout_ms(const Config& config) {
    const double v = config.number("celestrak_http_timeout_ms", 0);
    return v > 0 ? static_cast<long>(v) : kDefaultTimeoutMs;
}

struct LaneAttribution {
    std::string provider_id;
    std::string license;
    std::string license_url;
    std::string citation;
};

LaneAttribution lane_attribution(const Config& config) {
    LaneAttribution a;
    a.provider_id = config.string("celestrak_provider_id", kDefaultProviderID);
    a.license = config.string("celestrak_license", kDefaultLicense);
    a.license_url = config.string("celestrak_license_url", kDefaultLicenseURL);
    a.citation = config.string("celestrak_citation", kDefaultCitation);
    return a;
}

std::string group_url(const GroupSpec* spec, const std::string& token) {
    const bool special = spec ? spec->special : false;
    return std::string(kGPBaseURL) + (special ? "?SPECIAL=" : "?GROUP=") + token + "&FORMAT=csv";
}

// ---------------------------------------------------------------------------
// The job: one size-prefixed $ICN record in HttpRequest.CONTEXT.
// ---------------------------------------------------------------------------

struct JobSpec {
    std::string connector_id;
    std::string target_schema;
    std::vector<std::string> emits;
    std::string url;
    std::string source_name;
    std::string dataset_id;
};

Bytes job_record(const JobSpec& spec, const LaneAttribution& a) {
    ::flatbuffers::FlatBufferBuilder b(1024);
    const auto connector_id = b.CreateString(spec.connector_id);
    const auto target_schema = b.CreateString(spec.target_schema);
    const auto endpoint = b.CreateString(spec.url);
    const auto method = b.CreateString("GET");
    const auto origin_id = b.CreateString(kOriginID);
    const auto origin_name = b.CreateString(kOriginName);
    const auto dataset_id = b.CreateString(spec.dataset_id);
    const auto provider_id = b.CreateString(a.provider_id);
    const auto source_name = b.CreateString(spec.source_name);
    const auto license = b.CreateString(a.license);
    const auto license_url = b.CreateString(a.license_url);
    const auto citation = b.CreateString(a.citation);
    const auto emits = b.CreateVectorOfStrings(spec.emits);
    ICNBuilder icn(b);
    icn.add_CONNECTOR_ID(connector_id);
    icn.add_KIND(icnConnectorKind_HttpsPull);
    icn.add_TARGET_SCHEMA(target_schema);
    icn.add_ENDPOINT_URL(endpoint);
    icn.add_HTTP_METHOD(method);
    icn.add_POST_INGEST_ACTION(icnPostIngestAction_Archive);
    icn.add_ORIGIN_ID(origin_id);
    icn.add_ORIGIN_NAME(origin_name);
    icn.add_DATASET_ID(dataset_id);
    icn.add_PROVIDER_ID(provider_id);
    icn.add_SOURCE_NAME(source_name);
    icn.add_LICENSE(license);
    icn.add_LICENSE_URL(license_url);
    icn.add_CITATION(citation);
    icn.add_EMITS_SCHEMAS(emits);
    FinishSizePrefixedICNBuffer(b, icn.Finish());
    return finished_bytes(b);
}

// A GET HttpRequest (no headers: the host presents its recorded validators), its job in CONTEXT.
Bytes http_get(const std::string& url, long timeout_ms, long max_bytes, const Bytes& context) {
    ::flatbuffers::FlatBufferBuilder b(512 + context.size());
    R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, "GET", url.c_str(), nullptr, nullptr,
                                                             static_cast<uint32_t>(timeout_ms),
                                                             static_cast<uint64_t>(max_bytes), &context));
    return finished_bytes(b);
}

struct JobContext {
    std::string connector_id;
    std::string source_url;   // the $ICN ENDPOINT_URL
    std::string source_name;
    std::string provider_id;
    std::string dataset_id;
    std::string origin_id;
    std::string origin_name;
    std::string license;
    std::string license_url;
    std::string citation;
};

std::string text_of(const ::flatbuffers::String* s) { return s ? s->str() : std::string(); }

// The job a response carries back in CONTEXT; false (with a plugin error) when it carries none, or not an $ICN.
bool load_job(const R::HttpResponse& response, size_t index, JobContext* ctx) {
    const auto* context = response.CONTEXT();
    bool ok = context && context->size() >= 8;
    if (ok) {
        ::flatbuffers::Verifier verifier(context->data(), context->size());
        ok = VerifySizePrefixedICNBuffer(verifier);
    }
    if (!ok) {
        const std::string message = "response " + std::to_string(index) + " (" + text_of(response.URL()) +
                                    ") carries no size-prefixed $ICN job in CONTEXT; it cannot be attributed and is "
                                    "refused.";
        plugin_set_error("missing-context", message.c_str());
        return false;
    }
    const ICN* job = GetSizePrefixedICN(context->data());
    ctx->connector_id = text_of(job->CONNECTOR_ID());
    ctx->source_url = text_of(job->ENDPOINT_URL());
    ctx->source_name = text_of(job->SOURCE_NAME());
    ctx->provider_id = text_of(job->PROVIDER_ID());
    ctx->dataset_id = text_of(job->DATASET_ID());
    ctx->origin_id = text_of(job->ORIGIN_ID());
    ctx->origin_name = text_of(job->ORIGIN_NAME());
    ctx->license = text_of(job->LICENSE());
    ctx->license_url = text_of(job->LICENSE_URL());
    ctx->citation = text_of(job->CITATION());
    if (ctx->provider_id.empty()) ctx->provider_id = kDefaultProviderID;
    if (ctx->origin_id.empty()) ctx->origin_id = kOriginID;
    if (ctx->origin_name.empty()) ctx->origin_name = kOriginName;
    if (ctx->source_name.empty()) {
        plugin_set_error("missing-source-name", "the $ICN job must carry SOURCE_NAME.");
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Responses.
// ---------------------------------------------------------------------------

struct Fetched {
    long status = 0;
    std::string etag;
    std::string last_modified;
    std::string content_type;
    std::string response_date;
    std::vector<uint8_t> body;
    std::string sha256;
    int64_t retrieved_unix = 0;   // the Date header, else the wasm clock (legacy retrieved_at)
    uint64_t retrieved_ms = 0;    // the host's RETRIEVED_MS
};

// One HttpResponse frame, verified; nullptr with a plugin error otherwise.
const R::HttpResponse* response_of(const plugin_input_frame_t* frame, size_t index) {
    bool ok = frame && frame->payload && frame->payload_length > 0;
    if (ok) {
        ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
        ok = R::VerifyHttpResponseBuffer(verifier);
    }
    if (!ok) {
        const std::string message = "response " + std::to_string(index) + " is not an HttpResponse (HRSP).";
        plugin_set_error("invalid-response-frame", message.c_str());
        return nullptr;
    }
    return R::GetHttpResponse(frame->payload);
}

// Header NAMEs are lower-cased by the connector (a FlatBuffers key).
std::string header_of(const R::HttpResponse& r, const char* name) {
    if (const auto* headers = r.HEADERS())
        for (const auto* h : *headers)
            if (h && h->NAME() && h->NAME()->str() == name) return text_of(h->VALUE());
    return std::string();
}

Fetched decode_response(const R::HttpResponse& r) {
    Fetched out;
    out.status = r.STATUS();
    out.etag = header_of(r, "etag");
    out.last_modified = header_of(r, "last-modified");
    out.content_type = header_of(r, "content-type");
    out.response_date = header_of(r, "date");
    int64_t date_unix = 0;
    out.retrieved_unix = !out.response_date.empty() && parse_http_date(out.response_date, &date_unix)
                             ? date_unix
                             : now_unix_seconds();
    out.retrieved_ms = r.RETRIEVED_MS();
    if (r.BODY()) out.body.assign(r.BODY()->data(), r.BODY()->data() + r.BODY()->size());
    out.sha256 = sha256_hex(out.body.data(), out.body.size());
    return out;
}

// ---------------------------------------------------------------------------
// The IngestRequest (INGQ) meta and the FlowNotice.
// ---------------------------------------------------------------------------

// Archive naming: the request builder's constants, keyed by the job's DATASET_ID (never configurable).
const char* archive_name_for(const std::string& dataset_id) {
    if (dataset_id == kDatasetGPGroups) return "gp-groups.csv";
    if (dataset_id == kDatasetLaunchSites) return "launchsites.html";
    if (dataset_id == kDatasetOwners) return "sources.html";
    return nullptr;
}

// TAGS.LICENSE is an SPDX identifier (storage-ingest bounds it to 64 bytes and refuses a longer one): an
// identifier-shaped value is used as is; the verbatim usage terms are named by this LicenseRef (they stay in the
// $ICN job and in the $EGP PROVENANCE.LICENSE).
std::string license_identifier(const std::string& license) {
    bool identifier = !license.empty() && license.size() <= 64;
    for (const char c : license)
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') identifier = false;
    return identifier ? license : std::string(kLicenseRef);
}

struct ProvenanceSpec {
    std::string source_url;
    long status = 0;
    std::string etag, last_modified, content_type;
    int64_t retrieved_unix = 0;
    std::string parser_version;   // legacy "<parser>/<version>"
    std::string source_sha256, normalized_sha256;
    uint64_t normalized_count = 0;
    std::vector<std::pair<std::string, uint64_t>> schema_counts;
    std::vector<std::string> warnings;
};

R::reconcileMode reconcile_mode(const std::string& reconcile) {
    if (reconcile == "current") return R::reconcileMode_Current;
    if (reconcile == "none") return R::reconcileMode_None;
    return R::reconcileMode_Duplicates;
}

Bytes build_ingest_request(const JobContext& ctx, const char* schema, const std::string& batch_id,
                           const std::string& reconcile, bool with_archive, const ProvenanceSpec* p) {
    ::flatbuffers::FlatBufferBuilder b(2048);
    const auto opt = [](const std::string& s) { return s.empty() ? nullptr : s.c_str(); };
    ::flatbuffers::Offset<R::Provenance> provenance = 0;
    if (p) {
        const size_t slash = p->parser_version.find('/');
        const std::string parser = p->parser_version.substr(0, slash);
        const std::string version = slash == std::string::npos ? std::string() : p->parser_version.substr(slash + 1);
        std::vector<::flatbuffers::Offset<::flatbuffers::String>> schemas, warnings;
        std::vector<uint64_t> counts;
        for (const auto& [name, count] : p->schema_counts) {
            schemas.push_back(b.CreateString(name));
            counts.push_back(count);
        }
        for (const std::string& w : p->warnings) warnings.push_back(b.CreateString(w));
        provenance = R::CreateProvenanceDirect(
            b, p->source_url.c_str(), static_cast<int32_t>(p->status), opt(p->etag), opt(p->last_modified),
            opt(p->content_type), static_cast<uint64_t>(p->retrieved_unix) * 1000, parser.c_str(), opt(version),
            p->source_sha256.c_str(), p->normalized_sha256.c_str(), p->normalized_count, &schemas, &counts, &warnings,
            false);
    }
    const std::string license = license_identifier(ctx.license);
    const auto tags = R::CreateSourceTagsDirect(b, ctx.provider_id.c_str(), ctx.source_name.c_str(), batch_id.c_str(),
                                                ctx.source_url.c_str(), kContentKeyID, kSourcePeer, license.c_str(),
                                                opt(ctx.license_url), opt(ctx.citation), false);
    ::flatbuffers::Offset<R::ArchiveTarget> archive = 0;
    const char* archive_name = archive_name_for(ctx.dataset_id);
    if (with_archive && archive_name) archive = R::CreateArchiveTargetDirect(b, kArchiveSource, archive_name);
    R::FinishIngestRequestBuffer(b, R::CreateIngestRequestDirect(b, schema, tags, reconcile_mode(reconcile), archive,
                                                                 provenance));
    return finished_bytes(b);
}

// 304: a FlowNotice Unchanged instead of records.
Bytes build_unchanged(const JobContext& ctx, const char* schema, uint64_t count, const std::vector<std::string>& items) {
    R::FlowNoticeT notice;
    notice.KIND = R::flowNoticeKind_Unchanged;
    notice.SCHEMA = schema;
    notice.PROVIDER_ID = ctx.provider_id;
    notice.SOURCE_NAME = ctx.source_name;
    notice.REASON = "not-modified";
    notice.COUNT = count;
    notice.ITEMS = items;
    ::flatbuffers::FlatBufferBuilder b(256);
    R::FinishFlowNoticeBuffer(b, R::FlowNotice::Pack(b, &notice));
    return finished_bytes(b);
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
    Fetched response;
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

std::vector<GroupPlan> resolve_groups(const Config& config, std::string* err) {
    std::vector<GroupPlan> plan;
    const std::string override_list = config.string("celestrak_gp_groups", "");
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
                      "(one response per group).",
                      plan.size(), kMaxGroups);
        *err = msg;
        return {};
    }
    return plan;
}

std::vector<std::string> gp_group_emits(bool emit_omm) {
    std::vector<std::string> emits{"EGP"};
    if (emit_omm) emits.push_back("OMM");
    return emits;
}

}  // namespace

// ---------------------------------------------------------------------------
// Method entry points.
// ---------------------------------------------------------------------------

extern "C" {

// gp_groups: TimerTick -> one HttpRequest per GP group/special query on "request", each carrying its own $ICN job
// (CONNECTOR_ID "celestrak-gp-groups/<TOKEN>") in CONTEXT. The tick's fields are not read.
int gp_groups(void) {
    char batch_message[384];
    if (find_batched_input_port(nullptr, batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const Config config = load_config();
    std::string err;
    const std::vector<GroupPlan> plan = resolve_groups(config, &err);
    if (plan.empty()) {
        plugin_set_error("invalid-group-list", err.c_str());
        return 400;
    }
    const long timeout = config_timeout_ms(config);
    const LaneAttribution attribution = lane_attribution(config);
    const std::vector<std::string> emits = gp_group_emits(config.boolean("celestrak_gp_groups_emit_omm", false));
    for (const GroupPlan& g : plan) {
        JobSpec spec{std::string(kSourceGPGroups) + "/" + g.token, "EGP.fbs", emits, g.url, kSourceGPGroups,
                     kDatasetGPGroups};
        if (push_request("request", http_get(g.url, timeout, kGroupMaxBytes, job_record(spec, attribution))) < 0)
            return 500;
    }
    return 0;
}

// satcat_reference: TimerTick -> the launch-site and owner/source table fetches, each HttpRequest carrying its $ICN job.
int satcat_reference(void) {
    char batch_message[384];
    if (find_batched_input_port(nullptr, batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const Config config = load_config();
    const long timeout = config_timeout_ms(config);
    const LaneAttribution attribution = lane_attribution(config);
    const std::string sites_url = config.string("celestrak_satcat_launchsites_url", kDefaultLaunchSitesURL);
    const std::string sources_url = config.string("celestrak_satcat_sources_url", kDefaultSourcesURL);
    const JobSpec sites{kSourceLaunchSites, "SIT.fbs", {"SIT"}, sites_url, kSourceLaunchSites, kDatasetLaunchSites};
    const JobSpec owners{kSourceOwners, "LCC.fbs", {"LCC"}, sources_url, kSourceOwners, kDatasetOwners};
    if (push_request("request_sites", http_get(sites_url, timeout, kReferenceMaxBytes, job_record(sites, attribution))) < 0)
        return 500;
    if (push_request("request_owners", http_get(sources_url, timeout, kReferenceMaxBytes, job_record(owners, attribution))) < 0)
        return 500;
    return 0;
}

// parse_gp_groups: the groups' HttpResponses, each naming its group in its $ICN job (CONTEXT) -> one $EGP per group, in
// plan order. 304 groups go to "unchanged"; a group answering anything else than 200/304 fails the batch (CelesTrak
// policy: stop on non-200).
int parse_gp_groups(void) {
    char batch_message[384];
    if (find_batched_input_port("response", batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const std::vector<const plugin_input_frame_t*> frames = frames_on("response");
    if (frames.empty()) {
        plugin_set_error("missing-response-frame", "parse_gp_groups requires the groups' HttpResponses.");
        return 400;
    }
    const Config config = load_config();
    std::string err;
    const std::vector<GroupPlan> plan = resolve_groups(config, &err);
    if (plan.empty()) {
        plugin_set_error("invalid-group-list", err.c_str());
        return 400;
    }
    const bool emit_omm = config.boolean("celestrak_gp_groups_emit_omm", false);

    // Pair every response with its planned group by the CONNECTOR_ID its job carries.
    const std::string prefix = std::string(kSourceGPGroups) + "/";
    std::vector<const R::HttpResponse*> by_plan(plan.size(), nullptr);
    JobContext ctx;
    size_t paired = 0;
    for (size_t k = 0; k < frames.size(); k++) {
        const R::HttpResponse* r = response_of(frames[k], k);
        if (!r) return 400;
        JobContext job;
        if (!load_job(*r, k, &job)) return 400;
        if (k == 0) ctx = job;
        const std::string token = job.connector_id.compare(0, prefix.size(), prefix) == 0
                                      ? job.connector_id.substr(prefix.size())
                                      : std::string();
        size_t at = plan.size();
        for (size_t i = 0; i < plan.size(); i++)
            if (plan[i].token == token) at = i;
        if (at == plan.size() || job.source_url != plan[at].url) {
            const std::string msg = "response " + std::to_string(k) + " answers group \"" + token + "\" (" +
                                    job.source_url + ")" +
                                    (at == plan.size() ? std::string(", which the group plan does not list.")
                                                       : " but the plan expected " + plan[at].url + ".");
            plugin_set_error("group-url-mismatch", msg.c_str());
            return 409;
        }
        if (!by_plan[at]) paired++;
        by_plan[at] = r;
    }
    if (paired != plan.size() || frames.size() != plan.size()) {
        char msg[224];
        std::snprintf(msg, sizeof(msg),
                      "the group plan lists %zu groups but %zu responses arrived for %zu of them; the group "
                      "snapshot is refused rather than published partially.",
                      plan.size(), frames.size(), paired);
        plugin_set_error("group-count-mismatch", msg);
        return 409;
    }
    // The lane: one dataset, its source URL the GP elements index (the legacy lane job's).
    ctx.source_name = kSourceGPGroups;
    ctx.dataset_id = kDatasetGPGroups;
    ctx.source_url = kGPIndexURL;

    std::vector<GroupResult> changed;
    std::vector<std::string> unchanged;
    std::vector<std::string> warnings;
    for (size_t i = 0; i < plan.size(); i++) {
        GroupResult g;
        g.token = plan[i].token;
        g.label = plan[i].label;
        g.url = plan[i].url;
        g.spec = plan[i].spec;
        g.response = decode_response(*by_plan[i]);
        if (g.response.status == 304) {
            unchanged.push_back(g.token);
            continue;
        }
        if (g.response.status != 200) {
            char msg[160];
            std::snprintf(msg, sizeof(msg), "GP group %s returned HTTP status %ld", g.token.c_str(),
                          g.response.status);
            plugin_set_error("fetch-failed", msg);
            return 400;
        }
        std::vector<std::string> header;
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
            if (!parse_uint32(row_value(row, {"NORAD_CAT_ID", "NORAD_CAT_NUM"}), &norad) || norad == 0) {
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
        if (push_notice(build_unchanged(ctx, "EGP.fbs", unchanged.size(), unchanged)) < 0) return 500;
    }
    if (changed.empty()) return 0;

    // batch id = sha256 of the concatenated group payloads in plan order; the raw archive is that same concatenation.
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
                std::string row_err;
                if (!gp_row_to_omm(row, &omm, &row_err)) {
                    if (!row_err.empty()) {
                        plugin_set_error("gp-group-parse-failed", ("GP group " + g.token + ": " + row_err).c_str());
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

    ProvenanceSpec p;
    const Fetched& primary = changed[0].response;
    p.source_url = ctx.source_url;
    p.status = primary.status;
    p.etag = primary.etag;
    p.last_modified = primary.last_modified;
    p.content_type = primary.content_type;
    p.retrieved_unix = primary.retrieved_unix;
    p.parser_version = "celestrak-gp-groups-wasm/v1";
    p.source_sha256 = batch_id;
    p.normalized_sha256 = normalized.hex_digest();
    p.normalized_count = static_cast<uint64_t>(count_egp + count_omm);
    p.schema_counts.push_back({"EGP.fbs", static_cast<uint64_t>(count_egp)});
    if (emit_omm) p.schema_counts.push_back({"OMM.fbs", static_cast<uint64_t>(count_omm)});
    p.warnings = warnings;

    // A complete snapshot (every group answered 200) supersedes the lane; a partial refresh (some groups unchanged) is
    // appended, and $EGP's latest-UPDATED_AT-per-GROUP_ID rule picks the current version.
    const std::string reconcile = unchanged.empty() ? "current" : "duplicates";
    if (push_ingest_request("egp_meta", build_ingest_request(ctx, "EGP.fbs", batch_id, reconcile, true, &p)) < 0)
        return 500;
    if (push_record_stream("egp_records", "EGP.fbs", "$EGP", "EGP", egp_stream) < 0) return 500;
    // The raw document the batch was made from: the concatenated payloads, as one HttpResponse naming the index.
    ::flatbuffers::FlatBufferBuilder rb(256 + raw.size());
    R::FinishHttpResponseBuffer(rb, R::CreateHttpResponseDirect(rb, kGPIndexURL, 200, nullptr, &raw, nullptr, nullptr,
                                                                changed[0].response.retrieved_ms));
    if (push_response("raw", rb.GetBufferPointer(), rb.GetSize()) < 0) return 500;
    if (emit_omm && count_omm > 0) {
        if (push_ingest_request("omm_meta", build_ingest_request(ctx, "OMM.fbs", batch_id, "duplicates", false, nullptr)) < 0)
            return 500;
        if (push_record_stream("omm_records", "OMM.fbs", "$OMM", "OMM", omm_stream) < 0) return 500;
    }
    return 0;
}

// parse_satcat_reference: one HttpResponse -> $SIT rows for the launch-site table or $LCC rows for the owner/source
// table; the $ICN job's DATASET_ID decides.
int parse_satcat_reference(void) {
    char batch_message[384];
    if (find_batched_input_port(nullptr, batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const std::vector<const plugin_input_frame_t*> frames = frames_on("response");
    if (frames.empty()) {
        plugin_set_error("missing-response-frame", "parser requires the HttpResponse frame.");
        return 400;
    }
    const R::HttpResponse* r = response_of(frames[0], 0);
    if (!r) return 400;
    JobContext ctx;
    if (!load_job(*r, 0, &ctx)) return 400;
    const Fetched response = decode_response(*r);

    const bool sites = ctx.dataset_id == kDatasetLaunchSites;
    const bool owners = ctx.dataset_id == kDatasetOwners;
    if (!sites && !owners) {
        plugin_set_error("unknown-reference-dataset",
                         ("dataset_id \"" + ctx.dataset_id + "\" is not a SATCAT reference table.").c_str());
        return 400;
    }
    const char* schema = sites ? "SIT.fbs" : "LCC.fbs";
    if (response.status == 304) {
        return push_notice(build_unchanged(ctx, schema, 1, {ctx.source_url})) < 0 ? 500 : 0;
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
            const std::vector<uint8_t> lcc = build_lcc_record(owner, description, ctx.source_url, retrieved_at);
            append_size_prefixed(&stream, lcc);
            normalized_hash_record(&normalized, "LCC.fbs", lcc);
            count++;
        }
    }
    if (count == 0) {
        plugin_set_error("reference-parse-failed", sites ? "no launch-site rows parsed" : "no owner rows parsed");
        return 422;
    }

    ProvenanceSpec p;
    p.source_url = ctx.source_url;
    p.status = response.status;
    p.etag = response.etag;
    p.last_modified = response.last_modified;
    p.content_type = response.content_type;
    p.retrieved_unix = response.retrieved_unix;
    p.parser_version = "celestrak-satcat-reference-wasm/v1";
    p.source_sha256 = response.sha256;
    p.normalized_sha256 = normalized.hex_digest();
    p.normalized_count = static_cast<uint64_t>(count);
    p.schema_counts.push_back({schema, static_cast<uint64_t>(count)});
    p.warnings = warnings;
    if (push_ingest_request(sites ? "sit_meta" : "lcc_meta",
                            build_ingest_request(ctx, schema, response.sha256, "current", true, &p)) < 0)
        return 500;
    if (sites) {
        if (push_record_stream("sit_records", "SIT.fbs", "$SIT", "SIT", stream) < 0) return 500;
    } else {
        if (push_record_stream("lcc_records", "LCC.fbs", "$LCC", "LCC", stream) < 0) return 500;
    }
    // raw: the HttpResponse the batch was made from, verbatim.
    if (push_response("raw", frames[0]->payload, frames[0]->payload_length) < 0) return 500;
    return 0;
}

}  // extern "C"
