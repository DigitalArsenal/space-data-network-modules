/*
 * data-source/mlab-starlink-connectivity — M-Lab NDT statistics -> SDS $CNP.
 *
 * PROGRAM: rf-data-suite-program wave 2a (owner 2026-08-04). Task:
 * graph/tasks/sdn-starlink-connectivity-rates.md, whose owner ruling is
 * "ok my call is to create a module and include the data, it's open and free".
 *
 * ─── THE SOURCE, VERIFIED LIVE (2026-08-04) ─────────────────────────────────
 * M-Lab's statistics pipeline publishes per-ASN daily aggregates as plain JSON
 * over anonymous HTTPS. NO BigQuery, no auth, no API key:
 *
 *   GET https://statistics.measurementlab.net/v0/asn/14593/2024/histogram_daily_stats.json
 *       -> HTTP 200, 529,144 bytes, 688 rows, 86 distinct dates
 *
 * (Same bytes are served from the underlying public bucket at
 *  https://storage.googleapis.com/statistics-mlab-oti/v0/asn/... — the
 *  statistics.measurementlab.net host is the documented front door and is what
 *  this module fetches.)
 *
 * AS14593 is SpaceX's Starlink user network; `client.Network.ASNumber` is the
 * column the upstream query groups by, so filtering "Starlink" IS the ASN key
 * — this module never guesses a constellation from a throughput number.
 *
 * ─── WHAT ONE ROW IS, AND WHY WE COLLAPSE THEM ──────────────────────────────
 * Each row is a (date, log-space throughput bucket) tuple. The BUCKET columns
 * (bucket_min/bucket_max/dl_frac_bucket/dl_samples_bucket) vary within a date;
 * the DAILY columns (download_MIN/Q25/MED/AVG/Q75/MAX, upload_*, *_minRTT_MED,
 * *_samples_day) are identical on every one of the 8 bucket rows of a date.
 * $CNP is keyed by a closed window, so one record = one DATE, built from the
 * daily columns. The histogram itself is NOT encoded: `cnpReduction` has no
 * member that means "fraction of samples in [a,b)", and inventing one by
 * mapping a bucket to a PERCENTILE would be a fabricated statistic.
 *
 * Deliberately DROPPED for the same reason (recorded here, not silently):
 *   dl_LOG_AVG_rnd1/rnd2, ul_LOG_AVG_rnd1/rnd2, dl_minRTT_LOG_AVG_rnd*,
 *   ul_minRTT_LOG_AVG_rnd* are GEOMETRIC means (10^avg(log10 x)). `cnpReduction`
 *   has MEAN, MEDIAN, PERCENTILE, MINIMUM, MAXIMUM, STANDARD_DEVIATION and
 *   COUNT — none of which is a geometric mean. Encoding one as MEAN would be a
 *   different number wearing the wrong label.
 *
 * ─── THE THEMIS $CNP RULINGS THIS ENCODER OBEYS (SDS >= 1.177.0) ────────────
 * 1. A quantity exists ONLY as a CNPMetric, and CNPMetric requires
 *    `UNITS: string` and `PROVENANCE: CNPProvenance`. Every metric here names
 *    its unit, SOURCE, SOURCE_DATASET, a replayable SOURCE_QUERY, RETRIEVED_AT,
 *    METHOD and MEASUREMENT_SERVER.
 * 2. CNPMetric has NO scalar VALUE. Each metric carries a STATISTICS list of
 *    CNPStatistic. Throughput publishes six entries (MINIMUM, PERCENTILE 25,
 *    MEDIAN, MEAN, PERCENTILE 75, MAXIMUM); minimum-RTT publishes exactly one
 *    (MEDIAN), because that is all the source publishes.
 * 3. Units are never silently converted. The upstream column is
 *    `a.MeanThroughputMbps`, so UNITS is "Mbps" verbatim; MinRTT is
 *    milliseconds, so UNITS is "ms".
 * 4. Absent means unpublished, never zero. CLIENT_COUNT is left at 0 on every
 *    metric (see the note on *_samples_day below) and REGION is OMITTED
 *    ENTIRELY — the per-ASN export carries no geographic key at all, which is
 *    a different fact from `GLOBAL`.
 * 5. Licence rides per source. M-Lab test data is CC0 (verified live at
 *    https://www.measurementlab.net/data/ 2026-08-04: "available to the public
 *    without restriction under a No Rights Reserved Creative Commons Zero
 *    Waiver"), so NON_COMMERCIAL_ONLY is false on this lane. The Cloudflare
 *    Radar cross-check (CC BY-NC 4.0) is a SEPARATE lane and is NOT in this
 *    module; that is exactly why the flag is per-source.
 * 6. cnpMethod.MODELED is never used here — every number is measured.
 *
 * ─── HONEST GAPS (recorded, never guessed) ──────────────────────────────────
 * - METHOD is NDT7 per the Themis ruling. The upstream views are
 *   `measurement-lab.ndt.unified_downloads` / `unified_uploads`, which union
 *   NDT5 and NDT7 rows; SOURCE_DATASET names the exact view so the mix stays
 *   auditable rather than hidden behind the enum.
 * - The minimum-RTT metrics take KIND `RTT`, not LATENCY_IDLE and not
 *   LATENCY_LOADED_DOWNLOAD. `download_minRTT_MED` is the MINIMUM round trip
 *   observed while the download test ran: calling it loaded latency would
 *   overstate it, and calling it idle latency would claim an unloaded path the
 *   source never measured. `RTT` plus SOURCE_METRIC_NAME is the honest pair.
 * - SAMPLE_COUNT takes *_samples_day, which the upstream query defines as one
 *   randomly chosen test per client IP per day. CLIENT_COUNT stays 0
 *   (= unpublished): distinct IPs are not distinct terminals under CGNAT, and
 *   M-Lab publishes no terminal count.
 * - AS_NAME is ABSENT: the statistics export publishes the ASN number only.
 *   CONSTELLATION/OPERATOR are filled ONLY for ASNs in the tiny table below,
 *   because they are the record's own join key, not a measured quantity.
 * - SUPERSEDES_CNP_CID is absent; superseding is a store-level decision.
 *
 * ─── FLOW-NODE SHAPE ────────────────────────────────────────────────────────
 * Two pure flow nodes, `capabilities: []`, exactly like data-source/
 * satnogs-source: this guest performs NO I/O. The fetch is the generic
 * hostcap/http-request connector and the store is the generic
 * hostcap/storage-ingest connector. All decisions live in wasm.
 *
 *   request : timer tick   -> "request" (hostcap/http-request GET JSON)
 *                             "job"     (attribution JSON for parse)
 *   parse   : job+response -> "cnp_meta"    (storage.ingest_with_source meta)
 *                             "cnp_records" (size-prefixed $CNP stream)
 *                             "raw"         (decoded payload, for archiving)
 */

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <algorithm>
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

// ── Provider constants ──────────────────────────────────────────────────────

// The documented front door for the statistics pipeline. One whole-file
// request per cycle: this is a static published artifact, not a paged API.
constexpr const char* kDefaultStatsBaseURL = "https://statistics.measurementlab.net/v0/asn";
// AS14593 = SPACEX-STARLINK. The upstream query groups by
// `client.Network.ASNumber`, so this IS the Starlink filter.
constexpr long kDefaultASN = 14593;
// The last year the statistics pipeline published for this ASN. VERIFIED by
// object listing 2026-08-04: v0/asn/14593/ holds 2020..2024 and the 2024 file
// was last written 2024-03-28T03:00:45Z (86 dates, 2024-01-01..2024-03-26).
// Overridable from node CONFIG the moment M-Lab resumes publishing.
constexpr const char* kDefaultYear = "2024";
// "Sample recent days, don't mirror archives" (owner directive): keep the most
// recent N published dates. 0 in CONFIG means every date in the file.
constexpr long kDefaultMaxDays = 31;

constexpr const char* kDefaultProviderID = "space-data-network-02";
constexpr const char* kSourceName = "mlab-ndt-statistics";
constexpr const char* kSourcePeer = "source:mlab";
constexpr const char* kContentKeyID = "public";
constexpr const char* kParserVersion = "mlab-cnp-wasm/v1";
constexpr const char* kArchiveSource = "mlab";
constexpr const char* kArchiveName = "histogram_daily_stats.json";

// CNPProvenance.SOURCE / LICENSE / ATTRIBUTION.
constexpr const char* kProvenanceSource = "M-Lab";
constexpr const char* kSourceLandingURL = "https://www.measurementlab.net/data/";
constexpr const char* kLicense = "CC0-1.0";
constexpr const char* kLicenseURL = "https://creativecommons.org/publicdomain/zero/1.0/";
// M-Lab's own requested citation shape, verbatim from
// https://www.measurementlab.net/data/ : "The M-Lab <test> Data Set,
// <date range used>. <test URL>". The date range is filled per record.
constexpr const char* kCitationTail = ". https://measurementlab.net/tests/ndt";
constexpr const char* kCitationHead = "The M-Lab NDT Data Set ";
// The aggregate's vantage point. The per-ASN export names no individual
// measurement server: it aggregates every M-Lab site, and saying so is more
// honest than leaving a required-in-practice field blank.
constexpr const char* kMeasurementServer = "M-Lab platform (all sites)";
// The BigQuery views the published statistics were computed from. Named so a
// consumer can see that "NDT7" is the unified NDT5+NDT7 view, not a claim that
// every underlying row was an ndt7 test.
constexpr const char* kDatasetDownload = "measurement-lab.ndt.unified_downloads";
constexpr const char* kDatasetUpload = "measurement-lab.ndt.unified_uploads";
constexpr const char* kStatsExport =
    "m-lab/stats-pipeline statistics/queries/global_asn_histogram.sql";

// Identifying UA, same discipline as every other retriever in this repo.
constexpr const char* kUserAgent =
    "SDN-CatalogEnrichmentBot/0.1 (+https://spacedatanetwork.org; contact tjkoury@gmail.com)";

constexpr long kDefaultTimeoutMs = 120000;
constexpr long kDefaultRecordCap = 5000;

// ---------------------------------------------------------------------------
// Minimal, depth-aware JSON reader.
//
// Deliberately NOT a "find the key anywhere in the blob" scanner: these rows
// are flat, but the same helpers are used by the sibling sigmf-captures module
// on nested documents, and a needle that can match inside a nested object is a
// latent mis-parse. Every lookup here walks the members of ONE object.
// ---------------------------------------------------------------------------

bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

std::string trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && is_ws(s[b])) b++;
    while (e > b && is_ws(s[e - 1])) e--;
    return s.substr(b, e - b);
}

// Advances past one complete JSON value starting at `i`. Returns npos on
// malformed input.
size_t skip_value(const std::string& s, size_t i) {
    while (i < s.size() && is_ws(s[i])) i++;
    if (i >= s.size()) return std::string::npos;
    const char c = s[i];
    if (c == '"') {
        i++;
        while (i < s.size()) {
            if (s[i] == '\\') { i += 2; continue; }
            if (s[i] == '"') return i + 1;
            i++;
        }
        return std::string::npos;
    }
    if (c == '{' || c == '[') {
        int depth = 0;
        bool in_string = false;
        for (; i < s.size(); i++) {
            const char d = s[i];
            if (in_string) {
                if (d == '\\') { i++; continue; }
                if (d == '"') in_string = false;
                continue;
            }
            if (d == '"') { in_string = true; continue; }
            if (d == '{' || d == '[') depth++;
            else if (d == '}' || d == ']') {
                depth--;
                if (depth == 0) return i + 1;
            }
        }
        return std::string::npos;
    }
    // number / true / false / null
    while (i < s.size() && s[i] != ',' && s[i] != '}' && s[i] != ']' && !is_ws(s[i])) i++;
    return i;
}

std::string json_unescape(const std::string& raw) {
    std::string out;
    out.reserve(raw.size());
    for (size_t i = 0; i < raw.size(); i++) {
        if (raw[i] != '\\' || i + 1 >= raw.size()) { out.push_back(raw[i]); continue; }
        const char n = raw[i + 1];
        i++;
        switch (n) {
            case 'n': out.push_back('\n'); break;
            case 't': out.push_back('\t'); break;
            case 'r': out.push_back('\r'); break;
            case 'b': out.push_back('\b'); break;
            case 'f': out.push_back('\f'); break;
            case 'u': {
                // Only the BMP subset these sources actually use; a surrogate
                // pair is copied through unchanged rather than mangled.
                if (i + 4 >= raw.size()) { out.push_back('\\'); out.push_back('u'); break; }
                unsigned cp = 0;
                bool ok = true;
                for (int k = 1; k <= 4; k++) {
                    const char h = raw[i + k];
                    cp <<= 4;
                    if (h >= '0' && h <= '9') cp |= static_cast<unsigned>(h - '0');
                    else if (h >= 'a' && h <= 'f') cp |= static_cast<unsigned>(h - 'a' + 10);
                    else if (h >= 'A' && h <= 'F') cp |= static_cast<unsigned>(h - 'A' + 10);
                    else { ok = false; break; }
                }
                if (!ok) { out.push_back('\\'); out.push_back('u'); break; }
                i += 4;
                if (cp < 0x80) {
                    out.push_back(static_cast<char>(cp));
                } else if (cp < 0x800) {
                    out.push_back(static_cast<char>(0xc0 | (cp >> 6)));
                    out.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
                } else {
                    out.push_back(static_cast<char>(0xe0 | (cp >> 12)));
                    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3f)));
                    out.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
                }
                break;
            }
            default: out.push_back(n); break;
        }
    }
    return out;
}

// Returns the RAW slice of `key`'s value inside the JSON object `obj`
// (including quotes for a string), or an empty string when the key is absent.
// Walks members at the object's own depth only.
std::string json_member(const std::string& obj, const std::string& key) {
    size_t i = obj.find('{');
    if (i == std::string::npos) return std::string();
    i++;
    while (i < obj.size()) {
        while (i < obj.size() && (is_ws(obj[i]) || obj[i] == ',')) i++;
        if (i >= obj.size() || obj[i] == '}') break;
        if (obj[i] != '"') return std::string();
        const size_t key_end = skip_value(obj, i);
        if (key_end == std::string::npos) return std::string();
        const std::string member_key = obj.substr(i + 1, key_end - i - 2);
        size_t j = key_end;
        while (j < obj.size() && is_ws(obj[j])) j++;
        if (j >= obj.size() || obj[j] != ':') return std::string();
        j++;
        while (j < obj.size() && is_ws(obj[j])) j++;
        const size_t val_end = skip_value(obj, j);
        if (val_end == std::string::npos) return std::string();
        if (member_key == key) return obj.substr(j, val_end - j);
        i = val_end;
    }
    return std::string();
}

// A JSON string member, unescaped. False when absent, null, or not a string.
bool json_string_field(const std::string& obj, const std::string& key, std::string* out) {
    const std::string raw = json_member(obj, key);
    if (raw.size() < 2 || raw.front() != '"' || raw.back() != '"') return false;
    *out = json_unescape(raw.substr(1, raw.size() - 2));
    return true;
}

// A JSON number member. `null` (the sources' absent-value encoding) is NOT a
// number and reports absent, so a missing value can never become 0.
bool json_number_field(const std::string& obj, const std::string& key, double* out) {
    const std::string raw = trim(json_member(obj, key));
    if (raw.empty()) return false;
    const char c = raw[0];
    if (c != '-' && c != '+' && (c < '0' || c > '9')) return false;
    char* end = nullptr;
    const double v = strtod(raw.c_str(), &end);
    if (end == raw.c_str()) return false;
    *out = v;
    return true;
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

// Top-level elements of a JSON array, raw.
std::vector<std::string> json_array_elements(const std::string& text) {
    std::vector<std::string> out;
    size_t i = text.find('[');
    if (i == std::string::npos) return out;
    i++;
    while (i < text.size()) {
        while (i < text.size() && (is_ws(text[i]) || text[i] == ',')) i++;
        if (i >= text.size() || text[i] == ']') break;
        const size_t end = skip_value(text, i);
        if (end == std::string::npos) break;
        out.push_back(text.substr(i, end - i));
        i = end;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Base64.
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
// SHA-256 (batch ids = sha256 of the fetched payload).
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

std::string sha256_hex(const uint8_t* data, size_t len) {
    Sha256 s;
    s.update(data, len);
    return s.hex_digest();
}

void normalized_hash_record(Sha256* h, const char* schema, const std::vector<uint8_t>& record) {
    h->update(reinterpret_cast<const uint8_t*>(schema), std::strlen(schema));
    const uint8_t z = 0;
    h->update(&z, 1);
    h->update(record.data(), record.size());
    h->update(&z, 1);
}

// ---------------------------------------------------------------------------
// Civil time (RFC3339 output + HTTP-date parsing), UTC only.
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

int64_t now_unix_seconds() {
    struct timeval tv;
    if (gettimeofday(&tv, nullptr) != 0) return 0;
    return static_cast<int64_t>(tv.tv_sec);
}

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

// "YYYY-MM-DD" -> the RFC3339 instants bounding that UTC day. The window is
// [start, stop) exactly as $CNP specifies (inclusive start, exclusive end).
bool day_window(const std::string& date, std::string* start, std::string* stop) {
    if (date.size() != 10 || date[4] != '-' || date[7] != '-') return false;
    int y = 0, m = 0, d = 0;
    if (std::sscanf(date.c_str(), "%4d-%2d-%2d", &y, &m, &d) != 3) return false;
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    const int64_t day0 = days_from_civil(y, m, d);
    *start = format_rfc3339(day0 * 86400);
    *stop = format_rfc3339((day0 + 1) * 86400);
    return true;
}

// ---------------------------------------------------------------------------
// Frame IO helpers.
// ---------------------------------------------------------------------------

bool read_json_frame(const char* port, std::string* out) {
    const int32_t idx = plugin_find_input_index(port, 0);
    if (idx < 0) return false;
    const plugin_input_frame_t* frame = plugin_get_input_frame(static_cast<uint32_t>(idx));
    if (!frame || !frame->payload || frame->payload_length == 0) return false;
    out->assign(reinterpret_cast<const char*>(frame->payload), frame->payload_length);
    return true;
}

int push_json(const char* port, const std::string& json) {
    return plugin_push_output_ex(port, nullptr, nullptr,
                                 PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, nullptr, 0, 0,
                                 reinterpret_cast<const uint8_t*>(json.data()),
                                 static_cast<uint32_t>(json.size()));
}

int push_bytes(const char* port, const std::vector<uint8_t>& bytes) {
    return plugin_push_output_ex(port, nullptr, nullptr,
                                 PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, nullptr, 0, 0,
                                 bytes.data(), static_cast<uint32_t>(bytes.size()));
}

int push_cnp_stream(const char* port, const std::vector<uint8_t>& bytes) {
    return plugin_push_output_ex(port, "CNP.fbs", "$CNP",
                                 PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "CNP", 0, 0,
                                 bytes.data(), static_cast<uint32_t>(bytes.size()));
}

void append_size_prefixed(std::vector<uint8_t>* stream, const std::vector<uint8_t>& record) {
    const uint32_t len = static_cast<uint32_t>(record.size());
    stream->push_back(static_cast<uint8_t>(len & 0xff));
    stream->push_back(static_cast<uint8_t>((len >> 8) & 0xff));
    stream->push_back(static_cast<uint8_t>((len >> 16) & 0xff));
    stream->push_back(static_cast<uint8_t>((len >> 24) & 0xff));
    stream->insert(stream->end(), record.begin(), record.end());
}

// ---------------------------------------------------------------------------
// Node CONFIG (builtin plugin.getConfig hostcall — the host's flow-service
// config block). Never host code, never an env var.
//
// The hostcall ABI answers with a length-prefixed ENVELOPE meta document,
// `{"ok":true,"result":{...}}` (sdn-server internal/modulert/hostbridge.go
// okJSON, and the SDK's createHostcallBridge do the same). The config block is
// the `result` member, so it is unwrapped here rather than relied upon to be
// findable by a needle scan at arbitrary depth.
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
    const std::string envelope(reinterpret_cast<const char*>(buf.data() + 4), rlen);
    // Unwrap the envelope. A host that answers with the config object bare, or
    // an error envelope with no result, both degrade to "no config" rather
    // than to a misread of the envelope's own members.
    const std::string result = trim(json_member(envelope, "result"));
    if (!result.empty() && result.front() == '{') return result;
    const std::string trimmed = trim(envelope);
    if (!trimmed.empty() && trimmed.front() == '{' &&
        json_member(trimmed, "ok").empty() && json_member(trimmed, "result").empty()) {
        return trimmed;
    }
    return "{}";
}

std::string config_string(const std::string& config, const char* key, const char* fallback) {
    std::string value;
    if (json_string_field(config, key, &value) && !value.empty()) return value;
    return fallback;
}

long config_long(const std::string& config, const char* key, long fallback) {
    double v = 0;
    if (json_number_field(config, key, &v) && v > 0) return static_cast<long>(v);
    return fallback;
}

// Non-negative variant: 0 is a meaningful CONFIG value (max_days=0 = "all").
long config_long_nonneg(const std::string& config, const char* key, long fallback) {
    double v = 0;
    if (json_number_field(config, key, &v) && v >= 0) return static_cast<long>(v);
    return fallback;
}

// ---------------------------------------------------------------------------
// ASN identity.
//
// CONSTELLATION/OPERATOR are the RECORD'S OWN join keys, not measured
// quantities, so they are filled from a table of facts rather than inferred
// from the numbers. An ASN not in this table gets NEITHER field — $CNP already
// documents an empty CONSTELLATION as "terrestrial baseline", and asserting a
// constellation we cannot name would be exactly the invention the standard's
// shape exists to prevent.
// ---------------------------------------------------------------------------

struct AsnIdentity {
    uint32_t asn;
    const char* constellation;
    const char* op;
};

const AsnIdentity kAsnIdentities[] = {
    // AS14593 SPACEX-STARLINK — the client ASN M-Lab's
    // `client.Network.ASNumber` reports for Starlink user terminals.
    {14593u, "Starlink", "SpaceX"},
};

const AsnIdentity* lookup_asn(uint32_t asn) {
    for (const AsnIdentity& row : kAsnIdentities) {
        if (row.asn == asn) return &row;
    }
    return nullptr;
}

// ---------------------------------------------------------------------------
// One collapsed day of the M-Lab per-ASN export.
// ---------------------------------------------------------------------------

struct DailyStats {
    std::string date;
    uint32_t asn = 0;

    bool has_download = false;
    double download_min = 0, download_q25 = 0, download_med = 0;
    double download_avg = 0, download_q75 = 0, download_max = 0;
    bool has_dl_minrtt = false;
    double dl_minrtt_med = 0;
    uint64_t dl_samples_day = 0;

    bool has_upload = false;
    double upload_min = 0, upload_q25 = 0, upload_med = 0;
    double upload_avg = 0, upload_q75 = 0, upload_max = 0;
    bool has_ul_minrtt = false;
    double ul_minrtt_med = 0;
    uint64_t ul_samples_day = 0;
};

// The six throughput columns are all-or-nothing in the upstream query (one
// SELECT over one group), so a row missing any of them is not a partial
// distribution — it is a row this parser does not understand, and the metric
// is omitted rather than half-built.
bool decode_daily(const std::string& row, DailyStats* out) {
    if (!json_string_field(row, "date", &out->date) || out->date.size() != 10) return false;
    double v = 0;
    if (json_number_field(row, "asn", &v) && v > 0) out->asn = static_cast<uint32_t>(v);

    const bool dl =
        json_number_field(row, "download_MIN", &out->download_min) &&
        json_number_field(row, "download_Q25", &out->download_q25) &&
        json_number_field(row, "download_MED", &out->download_med) &&
        json_number_field(row, "download_AVG", &out->download_avg) &&
        json_number_field(row, "download_Q75", &out->download_q75) &&
        json_number_field(row, "download_MAX", &out->download_max);
    out->has_download = dl;
    out->has_dl_minrtt = json_number_field(row, "download_minRTT_MED", &out->dl_minrtt_med);
    if (json_number_field(row, "dl_samples_day", &v) && v >= 0) {
        out->dl_samples_day = static_cast<uint64_t>(v);
    }

    const bool ul =
        json_number_field(row, "upload_MIN", &out->upload_min) &&
        json_number_field(row, "upload_Q25", &out->upload_q25) &&
        json_number_field(row, "upload_MED", &out->upload_med) &&
        json_number_field(row, "upload_AVG", &out->upload_avg) &&
        json_number_field(row, "upload_Q75", &out->upload_q75) &&
        json_number_field(row, "upload_MAX", &out->upload_max);
    out->has_upload = ul;
    out->has_ul_minrtt = json_number_field(row, "upload_minRTT_MED", &out->ul_minrtt_med);
    if (json_number_field(row, "ul_samples_day", &v) && v >= 0) {
        out->ul_samples_day = static_cast<uint64_t>(v);
    }
    return out->has_download || out->has_upload || out->has_dl_minrtt || out->has_ul_minrtt;
}

// ---------------------------------------------------------------------------
// $CNP record builder.
// ---------------------------------------------------------------------------

struct StatEntry {
    cnpReduction reduction;
    double percentile_rank;  // only meaningful when reduction == PERCENTILE
    double value;
};

struct ProvenanceInput {
    const char* dataset;
    std::string query;
    std::string record_id;
    std::string source_sha256;
    std::string retrieved_at;
    std::string attribution;
    std::string source_url;
};

::flatbuffers::Offset<CNPProvenance> build_provenance(::flatbuffers::FlatBufferBuilder& fbb,
                                                      const ProvenanceInput& in) {
    const auto source = fbb.CreateString(kProvenanceSource);
    const auto source_url = fbb.CreateString(in.source_url);
    const auto dataset = fbb.CreateString(in.dataset);
    const auto query = fbb.CreateString(in.query);
    const auto record_id = fbb.CreateString(in.record_id);
    const auto sha = fbb.CreateString(in.source_sha256);
    const auto retrieved = fbb.CreateString(in.retrieved_at);
    const auto server = fbb.CreateString(kMeasurementServer);
    const auto license = fbb.CreateString(kLicense);
    const auto license_url = fbb.CreateString(kLicenseURL);
    const auto attribution = fbb.CreateString(in.attribution);

    CNPProvenanceBuilder b(fbb);
    b.add_SOURCE(source);
    b.add_SOURCE_URL(source_url);
    b.add_SOURCE_DATASET(dataset);
    b.add_SOURCE_QUERY(query);
    b.add_SOURCE_RECORD_ID(record_id);
    b.add_SOURCE_SHA256(sha);
    b.add_RETRIEVED_AT(retrieved);
    // The Themis ruling names NDT7 for the M-Lab lane. SOURCE_DATASET carries
    // the unified view so the NDT5/NDT7 union stays visible.
    b.add_METHOD(cnpMethod_NDT7);
    b.add_MEASUREMENT_SERVER(server);
    b.add_LICENSE(license);
    b.add_LICENSE_URL(license_url);
    b.add_ATTRIBUTION(attribution);
    // CC0: no non-commercial restriction on this lane. (The CC BY-NC
    // Cloudflare Radar cross-check is a separate lane and a separate source
    // entry, which is why this flag lives per source.)
    b.add_NON_COMMERCIAL_ONLY(false);
    return b.Finish();
}

::flatbuffers::Offset<CNPMetric> build_metric(::flatbuffers::FlatBufferBuilder& fbb,
                                              cnpMetricKind kind,
                                              const char* source_metric_name,
                                              const char* units,
                                              const std::vector<StatEntry>& stats,
                                              uint64_t sample_count,
                                              const ProvenanceInput& prov) {
    std::vector<::flatbuffers::Offset<CNPStatistic>> stat_offsets;
    stat_offsets.reserve(stats.size());
    for (const StatEntry& s : stats) {
        CNPStatisticBuilder sb(fbb);
        sb.add_STATISTIC(s.reduction);
        // PERCENTILE_RANK is "meaningless otherwise and MUST NOT be set".
        if (s.reduction == cnpReduction_PERCENTILE) sb.add_PERCENTILE_RANK(s.percentile_rank);
        sb.add_VALUE(s.value);
        stat_offsets.push_back(sb.Finish());
    }
    const auto stats_vec = fbb.CreateVector(stat_offsets);
    const auto name = fbb.CreateString(source_metric_name);
    const auto units_off = fbb.CreateString(units);
    const auto provenance = build_provenance(fbb, prov);

    CNPMetricBuilder b(fbb);
    b.add_KIND(kind);
    b.add_SOURCE_METRIC_NAME(name);
    b.add_UNITS(units_off);
    b.add_STATISTICS(stats_vec);
    if (sample_count > 0) b.add_SAMPLE_COUNT(sample_count);
    // CLIENT_COUNT deliberately unset: *_samples_day counts one sampled test
    // per client IP, and an IP is not a terminal. 0 == "the source did not
    // publish a client count", which is the truth.
    b.add_PROVENANCE(provenance);
    return b.Finish();
}

std::vector<uint8_t> finished_copy(::flatbuffers::FlatBufferBuilder& fbb) {
    return std::vector<uint8_t>(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
}

std::vector<uint8_t> build_cnp_record(const DailyStats& day, const std::string& source_url,
                                      const std::string& source_sha256,
                                      const std::string& retrieved_at,
                                      const std::string& created_at) {
    std::string window_start, window_stop;
    day_window(day.date, &window_start, &window_stop);

    // M-Lab's own citation format, with the record's own single-day range.
    const std::string attribution =
        std::string(kCitationHead) + day.date + "–" + day.date + kCitationTail;

    char key_buf[64];
    std::snprintf(key_buf, sizeof(key_buf), "asn=%u;date=%s", day.asn, day.date.c_str());
    const std::string record_key(key_buf);

    ProvenanceInput dl_prov;
    dl_prov.dataset = kDatasetDownload;
    dl_prov.query = "GET " + source_url + " -> row(asn=" + std::to_string(day.asn) +
                    ",date=" + day.date +
                    ") columns download_MIN,download_Q25,download_MED,download_AVG,download_Q75," +
                    "download_MAX,dl_samples_day; upstream " + kStatsExport;
    dl_prov.record_id = record_key;
    dl_prov.source_sha256 = source_sha256;
    dl_prov.retrieved_at = retrieved_at;
    dl_prov.attribution = attribution;
    dl_prov.source_url = source_url;

    ProvenanceInput dl_rtt_prov = dl_prov;
    dl_rtt_prov.query = "GET " + source_url + " -> row(asn=" + std::to_string(day.asn) +
                        ",date=" + day.date + ") column download_minRTT_MED; upstream " +
                        kStatsExport;

    ProvenanceInput ul_prov = dl_prov;
    ul_prov.dataset = kDatasetUpload;
    ul_prov.query = "GET " + source_url + " -> row(asn=" + std::to_string(day.asn) +
                    ",date=" + day.date +
                    ") columns upload_MIN,upload_Q25,upload_MED,upload_AVG,upload_Q75," +
                    "upload_MAX,ul_samples_day; upstream " + kStatsExport;

    ProvenanceInput ul_rtt_prov = ul_prov;
    ul_rtt_prov.query = "GET " + source_url + " -> row(asn=" + std::to_string(day.asn) +
                        ",date=" + day.date + ") column upload_minRTT_MED; upstream " +
                        kStatsExport;

    // The retrieval-level provenance: the provider consulted for this key.
    ProvenanceInput fetch_prov = dl_prov;
    fetch_prov.dataset = "statistics-mlab-oti histogram_daily_stats (per-ASN export)";
    fetch_prov.query = "GET " + source_url;

    ::flatbuffers::FlatBufferBuilder fbb(4096);

    std::vector<::flatbuffers::Offset<CNPMetric>> metrics;
    if (day.has_download) {
        const std::vector<StatEntry> stats = {
            {cnpReduction_MINIMUM, 0, day.download_min},
            {cnpReduction_PERCENTILE, 25, day.download_q25},
            {cnpReduction_MEDIAN, 0, day.download_med},
            {cnpReduction_MEAN, 0, day.download_avg},
            {cnpReduction_PERCENTILE, 75, day.download_q75},
            {cnpReduction_MAXIMUM, 0, day.download_max},
        };
        metrics.push_back(build_metric(fbb, cnpMetricKind_DOWNLOAD_THROUGHPUT,
                                       "download_MIN|Q25|MED|AVG|Q75|MAX", "Mbps", stats,
                                       day.dl_samples_day, dl_prov));
    }
    if (day.has_upload) {
        const std::vector<StatEntry> stats = {
            {cnpReduction_MINIMUM, 0, day.upload_min},
            {cnpReduction_PERCENTILE, 25, day.upload_q25},
            {cnpReduction_MEDIAN, 0, day.upload_med},
            {cnpReduction_MEAN, 0, day.upload_avg},
            {cnpReduction_PERCENTILE, 75, day.upload_q75},
            {cnpReduction_MAXIMUM, 0, day.upload_max},
        };
        metrics.push_back(build_metric(fbb, cnpMetricKind_UPLOAD_THROUGHPUT,
                                       "upload_MIN|Q25|MED|AVG|Q75|MAX", "Mbps", stats,
                                       day.ul_samples_day, ul_prov));
    }
    if (day.has_dl_minrtt) {
        const std::vector<StatEntry> stats = {{cnpReduction_MEDIAN, 0, day.dl_minrtt_med}};
        metrics.push_back(build_metric(fbb, cnpMetricKind_RTT, "download_minRTT_MED", "ms", stats,
                                       day.dl_samples_day, dl_rtt_prov));
    }
    if (day.has_ul_minrtt) {
        const std::vector<StatEntry> stats = {{cnpReduction_MEDIAN, 0, day.ul_minrtt_med}};
        metrics.push_back(build_metric(fbb, cnpMetricKind_RTT, "upload_minRTT_MED", "ms", stats,
                                       day.ul_samples_day, ul_rtt_prov));
    }
    const auto metrics_vec = fbb.CreateVector(metrics);

    std::vector<::flatbuffers::Offset<CNPProvenance>> sources;
    sources.push_back(build_provenance(fbb, fetch_prov));
    const auto sources_vec = fbb.CreateVector(sources);

    using StrOff = ::flatbuffers::Offset<::flatbuffers::String>;
    const AsnIdentity* identity = lookup_asn(day.asn);
    char id_buf[96];
    std::snprintf(id_buf, sizeof(id_buf), "mlab:ndt:asn%u:%s", day.asn, day.date.c_str());
    const StrOff id_off = fbb.CreateString(id_buf);
    const StrOff constellation_off =
        identity ? fbb.CreateString(identity->constellation) : StrOff();
    const StrOff operator_off = identity ? fbb.CreateString(identity->op) : StrOff();
    const StrOff window_start_off = fbb.CreateString(window_start);
    const StrOff window_stop_off = fbb.CreateString(window_stop);
    const StrOff created_off = fbb.CreateString(created_at);

    CNPBuilder b(fbb);
    b.add_ID(id_off);
    if (!constellation_off.IsNull()) b.add_CONSTELLATION(constellation_off);
    if (!operator_off.IsNull()) b.add_OPERATOR(operator_off);
    b.add_ASN(day.asn);
    // AS_NAME: the export publishes the number only. Absent, not invented.
    // SERVICE_TIER: M-Lab does not separate tiers. Absent.
    // REGION: the per-ASN export carries NO geographic key. Omitted entirely —
    // which is a different statement from cnpRegionKind.GLOBAL.
    b.add_WINDOW_START(window_start_off);
    b.add_WINDOW_STOP(window_stop_off);
    b.add_AGGREGATION_PERIOD(cnpPeriod_DAY);
    b.add_METRICS(metrics_vec);
    b.add_SOURCES(sources_vec);
    b.add_CREATED_AT(created_off);
    b.add_UPDATED_AT(created_off);
    const auto root = b.Finish();
    FinishCNPBuffer(fbb, root);
    return finished_copy(fbb);
}

// ---------------------------------------------------------------------------
// Fetch context + ingest meta.
// ---------------------------------------------------------------------------

struct FetchContext {
    std::string source_url;
    std::string source_name;
    std::string provider_id;
    std::string archive_source;
    std::string archive_name;
    std::string reconcile;
    std::string etag;
    std::string last_modified;
    std::string content_type;
    std::string response_date;
    long status = 0;
    std::vector<uint8_t> body;
    std::string batch_id;
};

bool load_fetch_context(FetchContext* ctx) {
    std::string job_json, response_json;
    if (!read_json_frame("job", &job_json)) {
        plugin_set_error("missing-job-frame", "parse requires the job JSON frame.");
        return false;
    }
    if (!read_json_frame("response", &response_json)) {
        plugin_set_error("missing-response-frame", "parse requires the http response JSON frame.");
        return false;
    }
    json_string_field(job_json, "source_url", &ctx->source_url);
    json_string_field(job_json, "source_name", &ctx->source_name);
    json_string_field(job_json, "provider_id", &ctx->provider_id);
    json_string_field(job_json, "archive_source", &ctx->archive_source);
    json_string_field(job_json, "archive_name", &ctx->archive_name);
    json_string_field(job_json, "reconcile", &ctx->reconcile);
    if (ctx->provider_id.empty()) ctx->provider_id = kDefaultProviderID;
    if (ctx->source_name.empty()) {
        plugin_set_error("missing-source-name", "job must carry source_name.");
        return false;
    }

    double status = 0;
    if (!json_number_field(response_json, "status", &status)) {
        plugin_set_error("missing-status", "http response frame carries no status.");
        return false;
    }
    ctx->status = static_cast<long>(status);
    if (ctx->status != 200) {
        char msg[96];
        std::snprintf(msg, sizeof(msg), "source fetch returned HTTP status %ld", ctx->status);
        plugin_set_error("fetch-failed", msg);
        return false;
    }
    const std::string headers = json_member(response_json, "headers");
    json_string_field(headers, "etag", &ctx->etag);
    if (ctx->etag.empty()) json_string_field(headers, "ETag", &ctx->etag);
    json_string_field(headers, "last-modified", &ctx->last_modified);
    if (ctx->last_modified.empty()) json_string_field(headers, "Last-Modified", &ctx->last_modified);
    json_string_field(headers, "content-type", &ctx->content_type);
    if (ctx->content_type.empty()) json_string_field(headers, "Content-Type", &ctx->content_type);
    json_string_field(headers, "date", &ctx->response_date);
    if (ctx->response_date.empty()) json_string_field(headers, "Date", &ctx->response_date);

    std::string body_b64;
    if (!json_string_field(response_json, "bodyB64", &body_b64) || body_b64.empty()) {
        plugin_set_error("empty-body", "http response frame carries no body.");
        return false;
    }
    if (!base64_decode(body_b64, &ctx->body)) {
        plugin_set_error("invalid-body", "http response bodyB64 is not valid base64.");
        return false;
    }
    ctx->batch_id = sha256_hex(ctx->body.data(), ctx->body.size());
    return true;
}

std::string build_provenance_json(const FetchContext& ctx, const std::string& retrieved_at,
                                  int record_count, int row_count, int day_count, int dropped_days,
                                  const std::string& first_date, const std::string& last_date,
                                  const std::string& normalized_sha256) {
    char nbuf[64];
    std::snprintf(nbuf, sizeof(nbuf), "{\"CNP.fbs\":%d}", record_count);
    std::string out = std::string("{\"source_url\":\"") + json_escape(ctx.source_url) + "\"" +
                      ",\"http_status\":" + std::to_string(ctx.status);
    if (!ctx.etag.empty()) out += ",\"etag\":\"" + json_escape(ctx.etag) + "\"";
    if (!ctx.last_modified.empty())
        out += ",\"last_modified\":\"" + json_escape(ctx.last_modified) + "\"";
    if (!ctx.content_type.empty())
        out += ",\"content_type\":\"" + json_escape(ctx.content_type) + "\"";
    out += std::string(",\"retrieved_at\":\"") + retrieved_at + "\"" +
           ",\"parser_version\":\"" + kParserVersion + "\"" +
           ",\"source_sha256\":\"" + ctx.batch_id + "\"" +
           ",\"normalized_sha256\":\"" + normalized_sha256 + "\"" +
           ",\"normalized_count\":" + std::to_string(record_count) +
           ",\"schema_counts\":" + nbuf +
           ",\"license\":\"" + kLicense + "\"" +
           ",\"license_url\":\"" + kLicenseURL + "\"" +
           ",\"license_source\":\"" + kSourceLandingURL + "\"" +
           ",\"non_commercial_only\":false" +
           ",\"method\":\"NDT7\"" +
           ",\"upstream_views\":[\"" + kDatasetDownload + "\",\"" + kDatasetUpload + "\"]" +
           ",\"units\":{\"throughput\":\"Mbps\",\"rtt\":\"ms\"}" +
           ",\"source_units\":{\"throughput\":\"Mbps\",\"rtt\":\"ms\"}" +
           ",\"bucket_rows\":" + std::to_string(row_count) +
           ",\"days_in_payload\":" + std::to_string(day_count) +
           ",\"days_dropped_by_window\":" + std::to_string(dropped_days) +
           ",\"first_date\":\"" + json_escape(first_date) + "\"" +
           ",\"last_date\":\"" + json_escape(last_date) + "\"" +
           // Recorded, not silently discarded: the histogram and the geometric
           // means have no honest CNPStatistic encoding.
           ",\"unencoded_source_columns\":[\"bucket_min\",\"bucket_max\",\"dl_frac_bucket\"," +
           "\"ul_frac_bucket\",\"dl_samples_bucket\",\"ul_samples_bucket\"," +
           "\"dl_LOG_AVG_rnd1\",\"dl_LOG_AVG_rnd2\",\"ul_LOG_AVG_rnd1\",\"ul_LOG_AVG_rnd2\"," +
           "\"dl_minRTT_LOG_AVG_rnd1\",\"dl_minRTT_LOG_AVG_rnd2\"," +
           "\"ul_minRTT_LOG_AVG_rnd1\",\"ul_minRTT_LOG_AVG_rnd2\"]" +
           ",\"warnings\":[],\"from_cache\":false}";
    return out;
}

std::string build_ingest_meta(const FetchContext& ctx, const std::string& provenance_json) {
    // reconcile=none: $CNP has no orbital identity for the host's indexed
    // reconcile to partition on. Replay idempotence comes from content-address
    // dedupe (identical bytes -> identical CID -> no duplicate row).
    const std::string reconcile = ctx.reconcile.empty() ? std::string("none") : ctx.reconcile;
    std::string meta = std::string("{\"schema\":\"CNP.fbs\"") +
                       ",\"provider_id\":\"" + json_escape(ctx.provider_id) + "\"" +
                       ",\"source_name\":\"" + json_escape(ctx.source_name) + "\"" +
                       ",\"source_url\":\"" + json_escape(ctx.source_url) + "\"" +
                       ",\"batch_id\":\"" + ctx.batch_id + "\"" +
                       ",\"content_key_id\":\"" + kContentKeyID + "\"" +
                       ",\"source_peer\":\"" + kSourcePeer + "\"" +
                       ",\"reconcile\":\"" + json_escape(reconcile) + "\"";
    if (!ctx.archive_source.empty() && !ctx.archive_name.empty()) {
        meta += ",\"archive\":{\"source\":\"" + json_escape(ctx.archive_source) +
                "\",\"name\":\"" + json_escape(ctx.archive_name) + "\"}";
    }
    meta += ",\"provenance\":{\"source\":\"" + std::string(kSourceName) + "\",\"json\":\"" +
            base64_encode(reinterpret_cast<const uint8_t*>(provenance_json.data()),
                          provenance_json.size()) +
            "\"}}";
    return meta;
}

// ---------------------------------------------------------------------------
// SURPLUS-FRAME REFUSAL — graph task `modules-guest-nodes-drop-batched-frames`.
//
// `space_data_module_runtime_begin_node_invocation` (module-SDK
// src/flow/runtime-src/flow_runtime.cpp) fills an invocation by popping the
// node's queue `while (count < budget && !queue.empty())`: PORT-BLIND, with a
// drain budget of 64. `maxStreams`, `maxBatch` and `drainPolicy` are purely
// DECLARATIVE in the compiled runtime — enforced at compose time and in the
// JS-only reference runtime, never by the baked runtime.wasm. So a guest that
// reads ordinal 0 of a port and returns DESTROYS every other frame it was
// handed on that port: they are already dequeued, nothing re-delivers them,
// and nothing logs the loss.
//
// That is measured, not hypothetical. It was a live P1
// (`cellular-multiprovider-returns-only-first-provider`) that survived four
// passes precisely because a partial answer is indistinguishable from an
// honest one: a two-provider request performed exactly ONE outbound fetch and
// returned the first provider's records, byte-identical to that provider run
// alone, with no error anywhere.
//
// `request` turns ONE timer tick into one request/job pair; `parse` pairs ONE
// job contract with ONE fetched response. The `response` port is fed by
// hostcap/http-request, which since the multi-provider fix emits one response
// frame PER REQUEST frame it was handed, so a fan-out upstream would deliver
// several responses here and only the first would ever be parsed.
//
// So a surplus is REFUSED rather than silently dropped — a named node error
// the flow surfaces, instead of an answer assembled from whichever frame the
// queue happened to hold first (queue order is not semantic order, so such an
// answer is arbitrary AND indistinguishable from a correct one). This costs
// nothing while the contract holds: one frame per port is what every deployed
// flow delivers today.
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

}  // namespace

extern "C" {

// ---------------------------------------------------------------------------
// request: timer tick -> the M-Lab statistics fetch request + parse job.
// ---------------------------------------------------------------------------
int request(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    const std::string config = load_config();
    const std::string base = config_string(config, "mlab_stats_base_url", kDefaultStatsBaseURL);
    const long asn = config_long(config, "mlab_asn", kDefaultASN);
    const std::string year = config_string(config, "mlab_year", kDefaultYear);
    const long timeout_ms = config_long(config, "mlab_http_timeout_ms", kDefaultTimeoutMs);
    const std::string provider = config_string(config, "mlab_provider_id", kDefaultProviderID);

    // A fully explicit URL wins when CONFIG sets one; otherwise the documented
    // per-ASN path is composed. Either way it is ONE whole-file request.
    std::string url;
    if (!json_string_field(config, "mlab_stats_url", &url) || url.empty()) {
        url = base + "/" + std::to_string(asn) + "/" + year + "/histogram_daily_stats.json";
    }

    std::string headers = std::string("{\"user-agent\":\"") + json_escape(kUserAgent) + "\"" +
                          ",\"accept\":\"application/json\"";
    std::string etag, last_modified;
    if (json_string_field(config, "mlab_if_none_match", &etag) && !etag.empty()) {
        headers += ",\"if-none-match\":\"" + json_escape(etag) + "\"";
    }
    if (json_string_field(config, "mlab_if_modified_since", &last_modified) &&
        !last_modified.empty()) {
        headers += ",\"if-modified-since\":\"" + json_escape(last_modified) + "\"";
    }
    headers += "}";

    const std::string request_json = std::string("{\"method\":\"GET\",\"url\":\"") +
                                     json_escape(url) + "\",\"headers\":" + headers +
                                     ",\"timeoutMs\":" + std::to_string(timeout_ms) + "}";
    const std::string job_json = std::string("{\"source_url\":\"") + json_escape(url) + "\"" +
                                 ",\"source_name\":\"" + kSourceName + "\"" +
                                 ",\"provider_id\":\"" + json_escape(provider) + "\"" +
                                 ",\"archive_source\":\"" + kArchiveSource + "\"" +
                                 ",\"archive_name\":\"" + kArchiveName + "\"}";

    if (push_json("request", request_json) < 0) return 500;
    if (push_json("job", job_json) < 0) return 500;
    return 0;
}

// ---------------------------------------------------------------------------
// parse: (job, response) -> $CNP record stream + ingest meta + raw payload.
// ---------------------------------------------------------------------------
int parse(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    FetchContext ctx;
    if (!load_fetch_context(&ctx)) return 400;

    const std::string body(reinterpret_cast<const char*>(ctx.body.data()), ctx.body.size());
    const std::vector<std::string> rows = json_array_elements(body);
    if (rows.empty()) {
        plugin_set_error("mlab-parse-failed",
                         "M-Lab statistics payload decoded to zero rows.");
        return 422;
    }

    const std::string config = load_config();
    const long record_cap = config_long(config, "mlab_record_cap", kDefaultRecordCap);
    const long max_days = config_long_nonneg(config, "mlab_max_days", kDefaultMaxDays);

    // Collapse the 8 bucket rows of each date into one day. Insertion order is
    // the file's order, which the upstream export sorts by (asn, date,
    // bucket_min); nothing is re-sorted here.
    std::vector<DailyStats> days;
    for (const std::string& row : rows) {
        DailyStats parsed;
        if (!decode_daily(row, &parsed)) continue;
        bool merged = false;
        for (const DailyStats& seen : days) {
            if (seen.date == parsed.date && seen.asn == parsed.asn) { merged = true; break; }
        }
        if (merged) continue;
        days.push_back(parsed);
    }
    if (days.empty()) {
        plugin_set_error("mlab-parse-failed",
                         "no M-Lab statistics row carried a usable daily aggregate.");
        return 422;
    }

    const int total_days = static_cast<int>(days.size());
    int dropped = 0;
    // "Sample recent days, don't mirror archives": keep the LAST max_days
    // entries of the file's own ordering. 0 == keep everything.
    if (max_days > 0 && static_cast<long>(days.size()) > max_days) {
        dropped = static_cast<int>(days.size() - static_cast<size_t>(max_days));
        days.erase(days.begin(), days.begin() + dropped);
    }

    std::string retrieved_at;
    int64_t date_unix = 0;
    if (!ctx.response_date.empty() && parse_http_date(ctx.response_date, &date_unix)) {
        retrieved_at = format_rfc3339(date_unix);
    } else {
        retrieved_at = format_rfc3339(now_unix_seconds());
    }
    const std::string created_at = format_rfc3339(now_unix_seconds());

    std::vector<uint8_t> stream;
    stream.reserve(days.size() * 2048);
    Sha256 normalized;
    int emitted = 0;
    for (const DailyStats& day : days) {
        if (emitted >= record_cap) break;
        const std::vector<uint8_t> rec =
            build_cnp_record(day, ctx.source_url, ctx.batch_id, retrieved_at, created_at);
        append_size_prefixed(&stream, rec);
        normalized_hash_record(&normalized, "CNP.fbs", rec);
        emitted++;
    }
    if (emitted == 0) {
        plugin_set_error("mlab-parse-failed", "record cap left nothing to emit.");
        return 422;
    }

    const std::string provenance = build_provenance_json(
        ctx, retrieved_at, emitted, static_cast<int>(rows.size()), total_days, dropped,
        days.front().date, days.back().date, normalized.hex_digest());
    const std::string meta = build_ingest_meta(ctx, provenance);

    if (push_json("cnp_meta", meta) < 0) return 500;
    if (push_cnp_stream("cnp_records", stream) < 0) return 500;
    if (push_bytes("raw", ctx.body) < 0) return 500;
    return 0;
}

}  // extern "C"
