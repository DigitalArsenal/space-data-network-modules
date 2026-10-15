/*
 * data-source/sigmf-captures — public raw-IQ archives -> SDS $IQC pointer
 * records.
 *
 * PROGRAM: rf-data-suite-program wave 2a (owner 2026-08-04). Task:
 * graph/tasks/sdn-raw-iq-sigmf-sources.md.
 *
 * ─── WHAT THIS IS, AND WHAT IT IS NOT ───────────────────────────────────────
 * $IQC is a POINTER RECORD. This module ingests the METADATA of raw
 * complex-baseband recordings that live in public archives and emits one $IQC
 * per recording carrying WHERE the samples are, HOW LARGE they are, and WHAT
 * THEY HASH TO. It NEVER mirrors samples. `IQCPayloadRef.CUSTODY` stays at its
 * `UPSTREAM_ONLY` default on every record this module writes; `PINNED` is a
 * deliberate per-capture decision made elsewhere, never a bulk mirror.
 *
 * ─── SOURCE-ADAPTER SEAM ────────────────────────────────────────────────────
 * The owner named five archives (IQEngine, SigidWiki, IEEE DataPort, the
 * SDRangel IQ database, Zenodo). Each publishes a different envelope around
 * the same SigMF-shaped facts, so the parser is split:
 *
 *   adapter  = decodes ONE archive's response envelope into IQCInput values
 *   encoder  = turns IQCInput into $IQC bytes (shared, archive-agnostic)
 *
 * `kAdapters` below is the registry. The `job` frame names the adapter, and an
 * unrecognised name FAILS CLOSED naming the registered ids.
 *
 * EXACTLY ONE ADAPTER SHIPS TODAY: `iqengine-bulk-meta`, verified against the
 * live public endpoint (below). A stub adapter that fabricates data is
 * forbidden, so the other four archives are absent from this registry until
 * someone verifies their anonymous read surface the same way. What was probed
 * and what it returned is recorded in the graph task, not guessed at here.
 *
 * ─── ADAPTER `iqengine-bulk-meta`, VERIFIED LIVE 2026-08-04 ─────────────────
 *   GET https://www.iqengine.org/api/datasources
 *       -> 200, one PUBLIC datasource: account "local", container "local"
 *   GET https://www.iqengine.org/api/datasources/local/local/meta
 *       -> 200, 31,413,709 bytes, a JSON ARRAY of 36,636 SigMF documents
 *          ({global, captures, annotations}), anonymous, no token
 *   GET https://www.iqengine.org/api/datasources/local/local/<path>.sigmf-meta
 *   GET https://www.iqengine.org/api/datasources/local/local/<path>.sigmf-data
 *       -> 200 anonymously; the payload URLs written into IQCPayloadRef
 *
 * ONE bulk request per cycle, never a 36,636-request crawl of the per-file
 * `/meta` endpoint.
 *
 * ─── THE THEMIS $IQC RULINGS THIS ENCODER OBEYS (SDS >= 1.177.0) ────────────
 * 1. HERTZ, not MHz. `SAMPLE_RATE_HZ`, `CENTER_FREQ_HZ`, `FREQ_LOWER_EDGE_HZ`,
 *    `FREQ_UPPER_EDGE_HZ` and `IQCSegment.CENTER_FREQ_HZ` take the SigMF value
 *    UNCONVERTED. ($RFB is MHz; a consumer joining the two divides by 1e6 at
 *    the join. Nothing here rescales.)
 * 2. `DATATYPE` is the SigMF token VERBATIM (`cf32_le`, `ci16_le`, `ci8`).
 *    Never re-spelled, never normalized.
 * 3. `GEOLOCATION` is a nested table and is OMITTED ENTIRELY when the source
 *    published no position. 0,0 is never written.
 * 4. Empty `LICENSE` means UNKNOWN TERMS. `core:license` is carried verbatim;
 *    a recording without one gets NO licence fields, which is not a grant to
 *    redistribute. Licence is per RECORDING (IQEngine hosts third-party
 *    recordings), never per site — so there is no module-level licence
 *    constant, unlike the CC-BY-SA SatNOGS lane.
 * 5. SigMF fidelity: SEGMENTS (retunes/hopping), ANNOTATIONS including
 *    GENERATOR so a classifier label is distinguishable from a human one,
 *    EXTENSIONS, and HARDWARE.DESCRIPTION = `core:hw` VERBATIM — free text is
 *    never split into manufacturer/model by guessing.
 * 6. `BAND` is left at its default. The standard says a publisher encodes the
 *    designation ITS SOURCE STATES and never a re-derivation from
 *    CENTER_FREQ_HZ. SigMF has no band field, so this module states none.
 *
 * ─── HONEST GAPS (recorded, never guessed) ──────────────────────────────────
 * - `IQCPayloadRef.RETRIEVED_AT` is ABSENT on every payload. That field means
 *   "time at which URL was last CONFIRMED retrievable", and this module reads
 *   the metadata index, not the payloads. The record's own top-level
 *   RETRIEVED_AT (when the metadata was fetched) is set, because that IS
 *   confirmed.
 * - `BYTE_LENGTH` is 0 (= the source did not publish a size). It is NOT
 *   back-computed from SAMPLE_COUNT x sizeof(DATATYPE): that product is an
 *   inference, and 0 already has a defined meaning.
 * - `SAMPLE_COUNT` takes IQEngine's `traceability:sample_length`, which the
 *   archive states. Verified empirically 2026-08-04: `pulsed_ASK` publishes
 *   sample_length 25,100,544 with datatype cf32_le (8 bytes/complex sample)
 *   and its `.sigmf-data` answers Content-Length 200,804,352 = 25,100,544 x 8
 *   exactly, so the field is complex samples, not bytes.
 * - `DURATION_SECONDS` is written only when SAMPLE_COUNT and SAMPLE_RATE_HZ
 *   are both present — "exactly derivable" per the field's own contract.
 *   `CAPTURE_STOP` is left ABSENT: the sources do not state it.
 * - `TITLE`, `SIGNAL_NAME`, `MODULATION`, `ATTRIBUTION`, `LABELS`,
 *   `NORAD_CAT_ID`, `OBJECT_ID`, `EMITTER_ID`, `RFB_ID` are absent. SigMF
 *   states none of them; binding a capture to a catalogued spacecraft is a
 *   separate, evidence-bearing step, not a filename guess.
 * - A capture object with the misspelled key `core::datetime` (present in the
 *   live corpus) yields NO datetime. Treating a misspelled key as the real one
 *   would be inventing a timestamp the source never validly stated.
 * - A `core:geolocation` whose latitude/longitude fall outside WGS-84 range is
 *   REFUSED (GEOLOCATION omitted) and counted in the batch provenance. The
 *   live corpus contains one such record (`iridium_cf32`, coordinates
 *   [35.14, -106.51], i.e. lat/lon transposed by the contributor). Silently
 *   swapping them would be fabricating a position.
 *
 * ─── FLOW-NODE SHAPE (typed contracts 1.0: FlatBuffers only) ──────────────
 * Two pure flow nodes, `capabilities: []`. This guest performs NO I/O: the
 * fetch is the generic hostcap/http-request connector and the store is the
 * generic hostcap/storage-ingest connector. Every frame is a FlatBuffer:
 * module-sdk runtime types for the host contract, $IQC for the records.
 * Nothing module-to-module is JSON or base64; the archive's metadata index is
 * the one JSON document, parsed here.
 *
 *   request : "tick" TimerTick (TICK) -> "request" ONE HttpRequest (HREQ, GET)
 *             whose CONTEXT is the parse job: ONE size-prefixed IngestRequest
 *             (INGQ) skeleton - SCHEMA IQC.fbs, TAGS (PROVIDER_ID,
 *             SOURCE_NAME = the adapter's source name, SOURCE_URL), RECONCILE
 *             None, ARCHIVE (sigmf, <adapter>-meta.json) - echoed verbatim by
 *             the host in the HttpResponse.
 *   parse   : "response" HttpResponse (HRSP; the job in CONTEXT)
 *             -> "iqc_meta"    IngestRequest (INGQ): the job completed with
 *                              BATCH_ID and PROVENANCE
 *                "iqc_records" size-prefixed $IQC stream
 *                "raw"         the HttpResponse verbatim (its BODY is the
 *                              document storage-ingest archives)
 *                "unchanged"   ONLY on HTTP 304: one FlowNotice (FNTC)
 *                              Unchanged, REASON "not-modified", ITEMS the
 *                              source URL; no meta/records/raw frames.
 *             The adapter is resolved from the job's TAGS.SOURCE_NAME through
 *             the registry (unknown fails closed); its base URL, account and
 *             container are read from node CONFIG (iqengine_base_url /
 *             iqengine_account / iqengine_container, the same keys and
 *             defaults request used: both nodes share the flow service's
 *             config).
 *
 * Node CONFIG arrives through the builtin plugin.getConfig hostcall as an SDS
 * $PIV invocation (typedHostcall.hpp): one ModuleConfig FlatBuffer on raw "config".
 */

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <algorithm>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <sys/time.h>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "TimerTick_generated.h"
#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"
#include "IngestRequest_generated.h"
#include "FlowNotice_generated.h"
// $LKS, $RFB and $IQC (spacedatastandards.org lib/cpp/<CODE>/main_generated.h) are inlined ahead of this file by
// build.mjs.

namespace {

namespace A = sdn::runtime::Aligned;
namespace R = sdn::runtime;

// ── Adapter + provider constantsnamespace {

// ── Adapter + provider constants ────────────────────────────────────────────

constexpr const char* kAdapterIQEngine = "iqengine-bulk-meta";

constexpr const char* kIQEngineBaseURL = "https://www.iqengine.org";
constexpr const char* kIQEngineAccount = "local";
constexpr const char* kIQEngineContainer = "local";
constexpr const char* kIQEngineSourceName = "IQEngine";

constexpr const char* kDefaultProviderID = "space-data-network-02";
constexpr const char* kSourcePeer = "source:sigmf";
constexpr const char* kContentKeyID = "public";
constexpr const char* kParserName = "sigmf-captures";
constexpr const char* kParserVersion = "sigmf-iqc-wasm/v1";
constexpr const char* kArchiveSource = "sigmf";

constexpr const char* kUserAgent =
    "SDN-CatalogEnrichmentBot/0.1 (+https://spacedatanetwork.org; contact tjkoury@gmail.com)";

// The bulk metadata document is ~31 MB and served by a free community
// deployment: give it room rather than retry-storming.
constexpr long kDefaultTimeoutMs = 300000;
// The live corpus is 36,636 recordings; the cap is headroom and is overridable
// DOWN so a first deploy can stage a slice. `sigmf_record_cap` bounds the
// records ONE cycle emits: the first N capture documents of the index, in
// index order, and the batch provenance says how many rows it left unread.
constexpr long kDefaultRecordCap = 50000;

// ---------------------------------------------------------------------------
// Minimal, depth-aware JSON reader.
//
// These documents are NESTED ({global:{...},captures:[...],annotations:[...]}
// where an annotation carries the same `core:sample_start` key as a capture),
// so a "find the key anywhere" scanner would mis-parse. Every lookup walks the
// members of ONE object at its own depth.
// ---------------------------------------------------------------------------

bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

std::string trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && is_ws(s[b])) b++;
    while (e > b && is_ws(s[e - 1])) e--;
    return s.substr(b, e - b);
}

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

bool json_string_field(const std::string& obj, const std::string& key, std::string* out) {
    const std::string raw = json_member(obj, key);
    if (raw.size() < 2 || raw.front() != '"' || raw.back() != '"') return false;
    *out = json_unescape(raw.substr(1, raw.size() - 2));
    return true;
}

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

bool json_bool_field(const std::string& obj, const std::string& key, bool* out) {
    const std::string raw = trim(json_member(obj, key));
    if (raw == "true") { *out = true; return true; }
    if (raw == "false") { *out = false; return true; }
    return false;
}

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

// Percent-encodes a path segment run for a URL. `/` is preserved because the
// archives' identifiers ARE paths ("space/Dwingeloo Radio Telescope/...").
std::string url_encode_path(const std::string& s) {
    static const char* hexd = "0123456789ABCDEF";
    std::string out;
    out.reserve(s.size() + 8);
    for (const unsigned char c : s) {
        const bool unreserved = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                                (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_' ||
                                c == '~' || c == '/';
        if (unreserved) {
            out.push_back(static_cast<char>(c));
        } else {
            out.push_back('%');
            out.push_back(hexd[c >> 4]);
            out.push_back(hexd[c & 0xf]);
        }
    }
    return out;
}

std::string basename_of(const std::string& path) {
    const size_t slash = path.find_last_of('/');
    return slash == std::string::npos ? path : path.substr(slash + 1);
}

// ---------------------------------------------------------------------------
// SHA-256.
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

std::string sha256_hex_str(const std::string& s) {
    return sha256_hex(reinterpret_cast<const uint8_t*>(s.data()), s.size());
}

void normalized_hash_record(Sha256* h, const char* schema, const std::vector<uint8_t>& record) {
    h->update(reinterpret_cast<const uint8_t*>(schema), std::strlen(schema));
    const uint8_t z = 0;
    h->update(&z, 1);
    h->update(record.data(), record.size());
    h->update(&z, 1);
}

// ---------------------------------------------------------------------------
// Civil time.
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

// ---------------------------------------------------------------------------
// Frame IO helpers (typed contracts 1.0).
// ---------------------------------------------------------------------------

// The first frame on `port` (port-filtered: never a port-blind frame-0 read).
const plugin_input_frame_t* frame_for(const char* port) {
    const int32_t idx = plugin_find_input_index(port, 0);
    if (idx < 0) return nullptr;
    return plugin_get_input_frame(static_cast<uint32_t>(idx));
}

int push_typed(const char* port, const char* schema, const char* identifier, const char* root,
               const uint8_t* data, size_t size) {
    return plugin_push_output_ex(port, schema, identifier, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 root, 0, 0, data, static_cast<uint32_t>(size));
}

int push_iqc_stream(const char* port, const std::vector<uint8_t>& bytes) {
    return push_typed(port, "IQC.fbs", "$IQC", "IQC", bytes.data(), bytes.size());
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
// Node CONFIG (builtin plugin.getConfig hostcall).
//
// The hostcall is an SDS $PIV invocation (typedHostcall.hpp): the host answers
// one ModuleConfig (MCFG) FlatBuffer on raw "config", read in place through
// sdm_piv::get_config(). A host that answers no config, or an error, reads as
// "no config" - every key then takes its default, exactly as before.
// ---------------------------------------------------------------------------

std::string format_config_number(double v) {
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%.17g", v);
    return buf;
}

struct Config {
    sdm_piv::Config cfg;

    const sdn::runtime::ConfigEntry* find(const char* key) const { return cfg.entry(key); }
    // A string value (false when absent or not a string).
    bool text(const char* key, std::string* out) const {
        const sdn::runtime::ConfigEntry* e = find(key);
        if (!e || e->KIND() != sdn::runtime::configValueKind_String) return false;
        *out = e->STRING_VALUE() ? e->STRING_VALUE()->str() : std::string();
        return true;
    }
};

Config load_config() { return Config{sdm_piv::get_config()}; }

std::string config_string(const Config& config, const char* key, const char* fallback) {
    std::string value;
    if (config.text(key, &value) && !value.empty()) return value;
    return fallback;
}

// A positive integer from node CONFIG. The node serves its YAML config block
// verbatim, so an operator's `sigmf_record_cap: "2000"` arrives as a STRING
// entry, not a number: both spellings are the same value. Absent means the
// default. Anything else present — "2k", 0, -5, 2.5, true — is REFUSED rather
// than read as the default: host-02 staged a 2,000-record cap as a quoted
// string and the module silently ingested all 36,636.
enum class ConfigInteger { kAbsent, kValue, kInvalid };

ConfigInteger config_positive_long(const Config& config, const char* key, long* out, std::string* shown) {
    const sdn::runtime::ConfigEntry* e = config.find(key);
    if (!e) return ConfigInteger::kAbsent;
    std::string digits;
    if (e->KIND() == sdn::runtime::configValueKind_String) {
        const std::string text = e->STRING_VALUE() ? e->STRING_VALUE()->str() : std::string();
        digits = trim(text);
        *shown = "\"" + text + "\"";
    } else if (e->KIND() == sdn::runtime::configValueKind_Number) {
        const double v = e->NUMBER_VALUE();
        *shown = format_config_number(v);
        // wasm32 `long` is 32 bits: nine digits always fit.
        if (!(v > 0) || v != static_cast<double>(static_cast<long long>(v)) || v > 999999999.0) {
            return ConfigInteger::kInvalid;
        }
        *out = static_cast<long>(v);
        return ConfigInteger::kValue;
    } else {
        *shown = e->KIND() == sdn::runtime::configValueKind_Bool ? (e->BOOL_VALUE() ? "true" : "false") : "a list";
        return ConfigInteger::kInvalid;
    }
    if (digits.empty() || digits.size() > 9) return ConfigInteger::kInvalid;
    long value = 0;
    for (const char c : digits) {
        if (c < '0' || c > '9') return ConfigInteger::kInvalid;
        value = value * 10 + (c - '0');
    }
    if (value <= 0) return ConfigInteger::kInvalid;
    *out = value;
    return ConfigInteger::kValue;
}

// config_positive_long with the default applied; false (and the flow error
// already set) when the key is present but not a positive integer.
bool config_positive_long_or(const Config& config, const char* key, long fallback, long* out) {
    long value = fallback;
    std::string shown;
    if (config_positive_long(config, key, &value, &shown) == ConfigInteger::kInvalid) {
        const std::string msg = std::string(key) + " must be a positive integer (a number or a " +
                                "decimal string); got " + shown;
        plugin_set_error("invalid-config", msg.c_str());
        return false;
    }
    *out = value;
    return true;
}

// ---------------------------------------------------------------------------
// The archive-agnostic input the encoder consumes.
//
// Every field mirrors an $IQC field one-for-one and every one carries an
// explicit `has_` flag where the standard distinguishes absent from zero.
// An adapter's ONLY job is to fill this from its archive's envelope.
// ---------------------------------------------------------------------------

struct Segment {
    uint64_t sample_start = 0;
    bool has_global_index = false;
    uint64_t global_index = 0;
    bool has_header_bytes = false;
    uint64_t header_bytes = 0;
    bool has_center_freq = false;
    double center_freq_hz = 0;
    std::string datetime;
};

struct Annotation {
    uint64_t sample_start = 0;
    bool has_sample_count = false;
    uint64_t sample_count = 0;
    bool has_lower = false;
    double freq_lower_edge_hz = 0;
    bool has_upper = false;
    double freq_upper_edge_hz = 0;
    std::string label;
    std::string comment;
    std::string generator;
    std::string uuid;
};

struct Extension {
    std::string name;
    std::string version;
    bool is_optional = false;
};

struct PayloadRef {
    iqcPayloadRole role = iqcPayloadRole_OTHER;
    std::string url;
    std::string file_name;
    std::string media_type;
    std::string sha512;
};

struct CaptureInput {
    std::string id;
    std::string capture_id;
    std::string source_name;
    std::string source_url;
    std::string source_record_id;
    std::string source_sha256;

    std::string description;
    std::string author;
    std::string sigmf_version;
    std::string collection;
    std::vector<Extension> extensions;

    std::string datatype;
    bool has_sample_rate = false;
    double sample_rate_hz = 0;
    bool has_num_channels = false;
    uint32_t num_channels = 0;
    bool has_center_freq = false;
    double center_freq_hz = 0;
    bool has_freq_lower = false;
    double freq_lower_edge_hz = 0;
    bool has_freq_upper = false;
    double freq_upper_edge_hz = 0;
    bool has_sample_count = false;
    uint64_t sample_count = 0;
    bool has_sample_offset = false;
    uint64_t sample_offset = 0;
    bool metadata_only = false;
    bool has_trailing_bytes = false;
    uint64_t trailing_bytes = 0;

    std::string capture_start;
    std::vector<Segment> segments;
    std::vector<Annotation> annotations;

    bool has_geolocation = false;
    double latitude_deg = 0;
    double longitude_deg = 0;
    bool has_altitude = false;
    double altitude_m = 0;

    std::string hw_description;
    std::string recorder;

    std::string license;
    std::string license_url;
    std::string meta_doi;
    std::string data_doi;

    std::vector<PayloadRef> payloads;
};

// Per-batch counters for the provenance document: what was refused and why.
struct DecodeStats {
    int rows = 0;
    int emitted = 0;
    long record_cap = 0;
    // Capture documents the cycle never read because the record cap was met.
    int rows_unread_record_cap = 0;
    int skipped_no_identity = 0;
    int geolocation_present = 0;
    int geolocation_refused_out_of_range = 0;
    int with_license = 0;
    int with_annotations = 0;
    int with_multiple_segments = 0;
};

// ---------------------------------------------------------------------------
// Adapter: IQEngine bulk `/meta`.
// ---------------------------------------------------------------------------

struct IQEngineContext {
    std::string base_url;
    std::string account;
    std::string container;
};

// SigMF `core:geolocation` is an RFC 7946 GeoJSON Point:
// coordinates = [longitude, latitude, (altitude)]. The live corpus also
// contains single-element ARRAYS wrapping the Point; both are accepted because
// the intent is unambiguous and nothing is invented either way.
void decode_geolocation(const std::string& raw, CaptureInput* out, DecodeStats* stats) {
    std::string point = trim(raw);
    if (point.empty()) return;
    if (point.front() == '[') {
        const std::vector<std::string> wrapped = json_array_elements(point);
        if (wrapped.size() != 1) return;
        point = trim(wrapped[0]);
    }
    if (point.empty() || point.front() != '{') return;
    const std::string coords = json_member(point, "coordinates");
    const std::vector<std::string> ordinates = json_array_elements(coords);
    if (ordinates.size() < 2) return;
    char* end = nullptr;
    const double lon = strtod(ordinates[0].c_str(), &end);
    if (end == ordinates[0].c_str()) return;
    end = nullptr;
    const double lat = strtod(ordinates[1].c_str(), &end);
    if (end == ordinates[1].c_str()) return;
    // A contributor who transposed lat/lon produces an impossible latitude.
    // REFUSE it: swapping would fabricate a position the source never stated,
    // and writing |lat|>90 would publish a coordinate that cannot exist.
    if (lat < -90.0 || lat > 90.0 || lon < -180.0 || lon > 180.0) {
        stats->geolocation_refused_out_of_range++;
        return;
    }
    out->has_geolocation = true;
    out->latitude_deg = lat;
    out->longitude_deg = lon;
    if (ordinates.size() >= 3) {
        end = nullptr;
        const double alt = strtod(ordinates[2].c_str(), &end);
        if (end != ordinates[2].c_str()) {
            out->has_altitude = true;
            out->altitude_m = alt;
        }
    }
    stats->geolocation_present++;
}

bool decode_iqengine_record(const std::string& row, const IQEngineContext& ctx,
                            CaptureInput* out, DecodeStats* stats) {
    const std::string global = json_member(row, "global");
    if (global.empty()) return false;
    const std::string origin = json_member(global, "traceability:origin");
    std::string file_path;
    if (!json_string_field(origin, "file_path", &file_path) || file_path.empty()) {
        // No archive identifier: there is no stable thing to point AT, and
        // minting one would be inventing an identity the archive never issued.
        stats->skipped_no_identity++;
        return false;
    }
    std::string origin_type, account, container;
    json_string_field(origin, "type", &origin_type);
    json_string_field(origin, "account", &account);
    json_string_field(origin, "container", &container);
    if (account.empty()) account = ctx.account;
    if (container.empty()) container = ctx.container;

    const std::string encoded_path = url_encode_path(file_path);
    const std::string api_base =
        ctx.base_url + "/api/datasources/" + url_encode_path(account) + "/" +
        url_encode_path(container) + "/" + encoded_path;

    out->capture_id = file_path;
    out->id = "iqengine:" + account + "/" + container + "/" + file_path;
    out->source_name = kIQEngineSourceName;
    // The archive's own landing page route: /view/:type/:account/:container/:filePath
    out->source_url = ctx.base_url + "/view/" +
                      url_encode_path(origin_type.empty() ? std::string("api") : origin_type) +
                      "/" + url_encode_path(account) + "/" + url_encode_path(container) + "/" +
                      encoded_path;
    out->source_sha256 = sha256_hex_str(row);

    json_string_field(global, "core:description", &out->description);
    json_string_field(global, "core:author", &out->author);
    json_string_field(global, "core:version", &out->sigmf_version);
    json_string_field(global, "core:collection", &out->collection);
    // DATATYPE verbatim — never re-spelled.
    json_string_field(global, "core:datatype", &out->datatype);
    json_string_field(global, "core:hw", &out->hw_description);
    json_string_field(global, "core:recorder", &out->recorder);
    json_string_field(global, "core:meta_doi", &out->meta_doi);
    json_string_field(global, "core:data_doi", &out->data_doi);

    // Licence is per RECORDING. `core:license` is carried VERBATIM; when it is
    // itself a URL it is additionally carried as LICENSE_URL. A recording
    // without one gets neither field: empty LICENSE means UNKNOWN TERMS.
    std::string license;
    if (json_string_field(global, "core:license", &license) && !license.empty()) {
        out->license = license;
        if (license.compare(0, 7, "http://") == 0 || license.compare(0, 8, "https://") == 0) {
            out->license_url = license;
        }
        stats->with_license++;
    }

    double v = 0;
    if (json_number_field(global, "core:sample_rate", &v)) {
        out->has_sample_rate = true;
        out->sample_rate_hz = v;  // HERTZ, unconverted.
    }
    if (json_number_field(global, "core:num_channels", &v) && v >= 0) {
        out->has_num_channels = true;
        out->num_channels = static_cast<uint32_t>(v);
    }
    if (json_number_field(global, "core:offset", &v) && v >= 0) {
        out->has_sample_offset = true;
        out->sample_offset = static_cast<uint64_t>(v);
    }
    if (json_number_field(global, "core:trailing_bytes", &v) && v >= 0) {
        out->has_trailing_bytes = true;
        out->trailing_bytes = static_cast<uint64_t>(v);
    }
    json_bool_field(global, "core:metadata_only", &out->metadata_only);
    // IQEngine states the recording's complex-sample count. Verified against a
    // live Content-Length (see the header comment) — not back-computed here.
    if (json_number_field(global, "traceability:sample_length", &v) && v >= 0) {
        out->has_sample_count = true;
        out->sample_count = static_cast<uint64_t>(v);
    }

    const std::string geo_raw = json_member(global, "core:geolocation");
    if (!geo_raw.empty()) decode_geolocation(geo_raw, out, stats);

    for (const std::string& ext : json_array_elements(json_member(global, "core:extensions"))) {
        Extension e;
        json_string_field(ext, "name", &e.name);
        json_string_field(ext, "version", &e.version);
        json_bool_field(ext, "optional", &e.is_optional);
        if (!e.name.empty()) out->extensions.push_back(e);
    }

    for (const std::string& cap : json_array_elements(json_member(row, "captures"))) {
        Segment s;
        if (json_number_field(cap, "core:sample_start", &v) && v >= 0) {
            s.sample_start = static_cast<uint64_t>(v);
        }
        if (json_number_field(cap, "core:global_index", &v) && v >= 0) {
            s.has_global_index = true;
            s.global_index = static_cast<uint64_t>(v);
        }
        if (json_number_field(cap, "core:header_bytes", &v) && v >= 0) {
            s.has_header_bytes = true;
            s.header_bytes = static_cast<uint64_t>(v);
        }
        if (json_number_field(cap, "core:frequency", &v)) {
            s.has_center_freq = true;
            s.center_freq_hz = v;  // HERTZ, unconverted.
        }
        // NOTE: a misspelled `core::datetime` (present upstream) does not match
        // and correctly yields no timestamp.
        json_string_field(cap, "core:datetime", &s.datetime);
        out->segments.push_back(s);
    }
    if (!out->segments.empty()) {
        if (out->segments.front().has_center_freq) {
            out->has_center_freq = true;
            out->center_freq_hz = out->segments.front().center_freq_hz;
        }
        out->capture_start = out->segments.front().datetime;
        if (out->segments.size() > 1) stats->with_multiple_segments++;
    }

    bool any_annotation_edge = false;
    for (const std::string& ann : json_array_elements(json_member(row, "annotations"))) {
        Annotation a;
        if (json_number_field(ann, "core:sample_start", &v) && v >= 0) {
            a.sample_start = static_cast<uint64_t>(v);
        }
        if (json_number_field(ann, "core:sample_count", &v) && v >= 0) {
            a.has_sample_count = true;
            a.sample_count = static_cast<uint64_t>(v);
        }
        if (json_number_field(ann, "core:freq_lower_edge", &v)) {
            a.has_lower = true;
            a.freq_lower_edge_hz = v;
        }
        if (json_number_field(ann, "core:freq_upper_edge", &v)) {
            a.has_upper = true;
            a.freq_upper_edge_hz = v;
        }
        json_string_field(ann, "core:label", &a.label);
        json_string_field(ann, "core:comment", &a.comment);
        // GENERATOR: how a consumer tells a classifier's label from a human's.
        json_string_field(ann, "core:generator", &a.generator);
        json_string_field(ann, "core:uuid", &a.uuid);
        // The record-level occupied band is bounded by its annotations, which
        // the standard explicitly sanctions ("when the source states it or its
        // annotations bound it").
        if (a.has_lower) {
            if (!any_annotation_edge || a.freq_lower_edge_hz < out->freq_lower_edge_hz) {
                out->freq_lower_edge_hz = a.freq_lower_edge_hz;
            }
            out->has_freq_lower = true;
        }
        if (a.has_upper) {
            if (!any_annotation_edge || a.freq_upper_edge_hz > out->freq_upper_edge_hz) {
                out->freq_upper_edge_hz = a.freq_upper_edge_hz;
            }
            out->has_freq_upper = true;
        }
        if (a.has_lower || a.has_upper) any_annotation_edge = true;
        out->annotations.push_back(a);
    }
    if (!out->annotations.empty()) stats->with_annotations++;

    const std::string leaf = basename_of(file_path);
    PayloadRef data_ref;
    data_ref.role = iqcPayloadRole_DATA;
    data_ref.url = api_base + ".sigmf-data";
    data_ref.file_name = leaf + ".sigmf-data";
    data_ref.media_type = "application/octet-stream";
    // SigMF publishes SHA-512 over the DATASET file; $IQC carries it in its own
    // field rather than converting or discarding it.
    json_string_field(global, "core:sha512", &data_ref.sha512);
    out->payloads.push_back(data_ref);

    PayloadRef meta_ref;
    meta_ref.role = iqcPayloadRole_METADATA;
    meta_ref.url = api_base + ".sigmf-meta";
    meta_ref.file_name = leaf + ".sigmf-meta";
    meta_ref.media_type = "application/json";
    out->payloads.push_back(meta_ref);

    return true;
}

// ---------------------------------------------------------------------------
// The adapter registry. ONE entry: the only archive whose anonymous read
// surface has been verified live. Adding an archive means adding a decoder
// here AND a live smoke test that proves the endpoint answers.
// ---------------------------------------------------------------------------

typedef bool (*AdapterDecodeFn)(const std::string& row, const IQEngineContext& ctx,
                                CaptureInput* out, DecodeStats* stats);

struct SourceAdapter {
    const char* id;
    const char* source_name;
    AdapterDecodeFn decode;
};

const SourceAdapter kAdapters[] = {
    {kAdapterIQEngine, kIQEngineSourceName, &decode_iqengine_record},
};

const SourceAdapter* lookup_adapter(const std::string& id) {
    for (const SourceAdapter& a : kAdapters) {
        if (id == a.id) return &a;
    }
    return nullptr;
}

const SourceAdapter* lookup_adapter_by_source_name(const std::string& source_name) {
    for (const SourceAdapter& a : kAdapters) {
        if (source_name == a.source_name) return &a;
    }
    return nullptr;
}

std::string registered_adapter_ids() {
    std::string out;
    for (const SourceAdapter& a : kAdapters) {
        if (!out.empty()) out += ",";
        out += a.id;
    }
    return out;
}

// ---------------------------------------------------------------------------
// $IQC record builder (archive-agnostic).
// ---------------------------------------------------------------------------

std::vector<uint8_t> finished_copy(::flatbuffers::FlatBufferBuilder& fbb) {
    return std::vector<uint8_t>(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
}

std::vector<uint8_t> build_iqc_record(const CaptureInput& in, const std::string& retrieved_at,
                                      const std::string& created_at) {
    using StrOff = ::flatbuffers::Offset<::flatbuffers::String>;
    ::flatbuffers::FlatBufferBuilder fbb(2048);

    std::vector<::flatbuffers::Offset<IQCExtension>> extension_offsets;
    for (const Extension& e : in.extensions) {
        const StrOff name = fbb.CreateString(e.name);
        const StrOff version = e.version.empty() ? StrOff() : fbb.CreateString(e.version);
        IQCExtensionBuilder b(fbb);
        b.add_NAME(name);
        if (!version.IsNull()) b.add_VERSION(version);
        b.add_IS_OPTIONAL(e.is_optional);
        extension_offsets.push_back(b.Finish());
    }

    std::vector<::flatbuffers::Offset<IQCSegment>> segment_offsets;
    for (const Segment& s : in.segments) {
        const StrOff datetime = s.datetime.empty() ? StrOff() : fbb.CreateString(s.datetime);
        IQCSegmentBuilder b(fbb);
        b.add_SAMPLE_START(s.sample_start);
        if (s.has_global_index) b.add_GLOBAL_INDEX(s.global_index);
        if (s.has_header_bytes) b.add_HEADER_BYTES(s.header_bytes);
        if (s.has_center_freq) b.add_CENTER_FREQ_HZ(s.center_freq_hz);
        if (!datetime.IsNull()) b.add_DATETIME(datetime);
        segment_offsets.push_back(b.Finish());
    }

    std::vector<::flatbuffers::Offset<IQCAnnotation>> annotation_offsets;
    for (const Annotation& a : in.annotations) {
        const StrOff label = a.label.empty() ? StrOff() : fbb.CreateString(a.label);
        const StrOff comment = a.comment.empty() ? StrOff() : fbb.CreateString(a.comment);
        const StrOff generator = a.generator.empty() ? StrOff() : fbb.CreateString(a.generator);
        const StrOff uuid = a.uuid.empty() ? StrOff() : fbb.CreateString(a.uuid);
        IQCAnnotationBuilder b(fbb);
        b.add_SAMPLE_START(a.sample_start);
        if (a.has_sample_count) b.add_SAMPLE_COUNT(a.sample_count);
        if (a.has_lower) b.add_FREQ_LOWER_EDGE_HZ(a.freq_lower_edge_hz);
        if (a.has_upper) b.add_FREQ_UPPER_EDGE_HZ(a.freq_upper_edge_hz);
        if (!label.IsNull()) b.add_LABEL(label);
        if (!comment.IsNull()) b.add_COMMENT(comment);
        if (!generator.IsNull()) b.add_GENERATOR(generator);
        if (!uuid.IsNull()) b.add_UUID(uuid);
        annotation_offsets.push_back(b.Finish());
    }

    std::vector<::flatbuffers::Offset<IQCPayloadRef>> payload_offsets;
    for (const PayloadRef& p : in.payloads) {
        const StrOff url = p.url.empty() ? StrOff() : fbb.CreateString(p.url);
        const StrOff file_name = p.file_name.empty() ? StrOff() : fbb.CreateString(p.file_name);
        const StrOff media_type = p.media_type.empty() ? StrOff() : fbb.CreateString(p.media_type);
        const StrOff sha512 = p.sha512.empty() ? StrOff() : fbb.CreateString(p.sha512);
        IQCPayloadRefBuilder b(fbb);
        b.add_ROLE(p.role);
        if (!url.IsNull()) b.add_URL(url);
        if (!file_name.IsNull()) b.add_FILE_NAME(file_name);
        if (!media_type.IsNull()) b.add_MEDIA_TYPE(media_type);
        // BYTE_LENGTH stays 0 (= size not published upstream); it is never
        // back-computed from SAMPLE_COUNT x sizeof(DATATYPE).
        if (!sha512.IsNull()) b.add_BYTE_SHA512(sha512);
        // CUSTODY keeps its UPSTREAM_ONLY default: this network mirrors nothing.
        // RETRIEVED_AT stays ABSENT: this module confirmed the METADATA index,
        // not the payload URL.
        payload_offsets.push_back(b.Finish());
    }

    ::flatbuffers::Offset<IQCGeolocation> geolocation;
    if (in.has_geolocation) {
        IQCGeolocationBuilder b(fbb);
        b.add_LATITUDE_DEG(in.latitude_deg);
        b.add_LONGITUDE_DEG(in.longitude_deg);
        if (in.has_altitude) b.add_ALTITUDE_M(in.altitude_m);
        // METHOD absent: SigMF states no positioning method.
        geolocation = b.Finish();
    }

    ::flatbuffers::Offset<IQCHardware> hardware;
    const bool has_hardware = !in.hw_description.empty() || !in.recorder.empty();
    if (has_hardware) {
        const StrOff description =
            in.hw_description.empty() ? StrOff() : fbb.CreateString(in.hw_description);
        const StrOff recorder = in.recorder.empty() ? StrOff() : fbb.CreateString(in.recorder);
        IQCHardwareBuilder b(fbb);
        // core:hw VERBATIM. MANUFACTURER/MODEL/ANTENNA stay absent: splitting
        // free text into them by guessing is a defect.
        if (!description.IsNull()) b.add_DESCRIPTION(description);
        if (!recorder.IsNull()) b.add_RECORDER(recorder);
        hardware = b.Finish();
    }

    const auto extensions_vec =
        extension_offsets.empty() ? ::flatbuffers::Offset<::flatbuffers::Vector<
                                        ::flatbuffers::Offset<IQCExtension>>>()
                                  : fbb.CreateVector(extension_offsets);
    const auto segments_vec =
        segment_offsets.empty() ? ::flatbuffers::Offset<::flatbuffers::Vector<
                                      ::flatbuffers::Offset<IQCSegment>>>()
                                : fbb.CreateVector(segment_offsets);
    const auto annotations_vec =
        annotation_offsets.empty() ? ::flatbuffers::Offset<::flatbuffers::Vector<
                                         ::flatbuffers::Offset<IQCAnnotation>>>()
                                   : fbb.CreateVector(annotation_offsets);
    const auto payloads_vec =
        payload_offsets.empty() ? ::flatbuffers::Offset<::flatbuffers::Vector<
                                      ::flatbuffers::Offset<IQCPayloadRef>>>()
                                : fbb.CreateVector(payload_offsets);

    const StrOff id_off = fbb.CreateString(in.id);
    const StrOff capture_id_off = fbb.CreateString(in.capture_id);
    const StrOff source_name_off = fbb.CreateString(in.source_name);
    const StrOff source_url_off = in.source_url.empty() ? StrOff() : fbb.CreateString(in.source_url);
    const StrOff source_record_id_off =
        in.source_record_id.empty() ? StrOff() : fbb.CreateString(in.source_record_id);
    const StrOff source_sha_off =
        in.source_sha256.empty() ? StrOff() : fbb.CreateString(in.source_sha256);
    const StrOff retrieved_off = fbb.CreateString(retrieved_at);
    const StrOff description_off =
        in.description.empty() ? StrOff() : fbb.CreateString(in.description);
    const StrOff author_off = in.author.empty() ? StrOff() : fbb.CreateString(in.author);
    const StrOff sigmf_version_off =
        in.sigmf_version.empty() ? StrOff() : fbb.CreateString(in.sigmf_version);
    const StrOff collection_off = in.collection.empty() ? StrOff() : fbb.CreateString(in.collection);
    const StrOff datatype_off = in.datatype.empty() ? StrOff() : fbb.CreateString(in.datatype);
    const StrOff capture_start_off =
        in.capture_start.empty() ? StrOff() : fbb.CreateString(in.capture_start);
    const StrOff license_off = in.license.empty() ? StrOff() : fbb.CreateString(in.license);
    const StrOff license_url_off =
        in.license_url.empty() ? StrOff() : fbb.CreateString(in.license_url);
    const StrOff meta_doi_off = in.meta_doi.empty() ? StrOff() : fbb.CreateString(in.meta_doi);
    const StrOff data_doi_off = in.data_doi.empty() ? StrOff() : fbb.CreateString(in.data_doi);
    const StrOff created_off = fbb.CreateString(created_at);

    IQCBuilder b(fbb);
    b.add_ID(id_off);
    b.add_CAPTURE_ID(capture_id_off);
    b.add_SOURCE_NAME(source_name_off);
    if (!source_url_off.IsNull()) b.add_SOURCE_URL(source_url_off);
    if (!source_record_id_off.IsNull()) b.add_SOURCE_RECORD_ID(source_record_id_off);
    if (!source_sha_off.IsNull()) b.add_SOURCE_SHA256(source_sha_off);
    b.add_RETRIEVED_AT(retrieved_off);
    // TITLE absent: SigMF publishes none.
    if (!description_off.IsNull()) b.add_DESCRIPTION(description_off);
    if (!author_off.IsNull()) b.add_AUTHOR(author_off);
    if (!sigmf_version_off.IsNull()) b.add_SIGMF_VERSION(sigmf_version_off);
    if (!collection_off.IsNull()) b.add_COLLECTION(collection_off);
    if (!extension_offsets.empty()) b.add_EXTENSIONS(extensions_vec);
    if (!datatype_off.IsNull()) b.add_DATATYPE(datatype_off);
    if (in.has_sample_rate) b.add_SAMPLE_RATE_HZ(in.sample_rate_hz);
    if (in.has_num_channels) b.add_NUM_CHANNELS(in.num_channels);
    if (in.has_center_freq) b.add_CENTER_FREQ_HZ(in.center_freq_hz);
    if (in.has_freq_lower) b.add_FREQ_LOWER_EDGE_HZ(in.freq_lower_edge_hz);
    if (in.has_freq_upper) b.add_FREQ_UPPER_EDGE_HZ(in.freq_upper_edge_hz);
    if (in.has_sample_count) b.add_SAMPLE_COUNT(in.sample_count);
    // DURATION_SECONDS only when EXACTLY derivable from stated values.
    if (in.has_sample_count && in.has_sample_rate && in.sample_rate_hz > 0) {
        b.add_DURATION_SECONDS(static_cast<double>(in.sample_count) / in.sample_rate_hz);
    }
    if (in.has_sample_offset) b.add_SAMPLE_OFFSET(in.sample_offset);
    if (in.metadata_only) b.add_METADATA_ONLY(true);
    if (in.has_trailing_bytes) b.add_TRAILING_BYTES(in.trailing_bytes);
    if (!capture_start_off.IsNull()) b.add_CAPTURE_START(capture_start_off);
    // CAPTURE_STOP absent: not stated upstream.
    if (!segment_offsets.empty()) b.add_SEGMENTS(segments_vec);
    if (!annotation_offsets.empty()) b.add_ANNOTATIONS(annotations_vec);
    // LABELS absent: these archives publish no record-level tag list.
    if (in.has_geolocation) b.add_GEOLOCATION(geolocation);
    if (has_hardware) b.add_HARDWARE(hardware);
    // SIGNAL_NAME / MODULATION absent: never inferred from the samples.
    // BAND left at its default: the source states no designation, and the
    // standard forbids re-deriving it from CENTER_FREQ_HZ.
    // NORAD_CAT_ID / OBJECT_ID / EMITTER_ID / RFB_ID absent: unbound.
    if (!license_off.IsNull()) b.add_LICENSE(license_off);
    if (!license_url_off.IsNull()) b.add_LICENSE_URL(license_url_off);
    // ATTRIBUTION absent unless the recording states one.
    if (!meta_doi_off.IsNull()) b.add_META_DOI(meta_doi_off);
    if (!data_doi_off.IsNull()) b.add_DATA_DOI(data_doi_off);
    if (!payload_offsets.empty()) b.add_PAYLOADS(payloads_vec);
    b.add_CREATED_AT(created_off);
    b.add_UPDATED_AT(created_off);
    const auto root = b.Finish();
    FinishIQCBuffer(fbb, root);
    return finished_copy(fbb);
}

// ---------------------------------------------------------------------------
// The parse job (HttpRequest.CONTEXT) and the fetch context.
// ---------------------------------------------------------------------------

// The job: ONE size-prefixed IngestRequest skeleton - the ingest attribution
// parse completes (schema, provider, the adapter's source name, source URL,
// reconcile mode, archive naming). It rides the request's CONTEXT and comes
// back verbatim in the HttpResponse.
std::vector<uint8_t> build_job(const std::string& source_url, const std::string& source_name,
                               const std::string& provider, const std::string& archive_name) {
    R::IngestRequestT job;
    job.SCHEMA = "IQC.fbs";
    job.TAGS = std::make_unique<R::SourceTagsT>();
    job.TAGS->PROVIDER_ID = provider;
    job.TAGS->SOURCE_NAME = source_name;
    job.TAGS->SOURCE_URL = source_url;
    // None (the legacy default): $IQC carries no orbital identity for the
    // host's indexed reconcile; replay idempotence is content-address dedupe.
    job.RECONCILE = R::reconcileMode_None;
    job.ARCHIVE = std::make_unique<R::ArchiveTargetT>();
    job.ARCHIVE->SOURCE = kArchiveSource;
    job.ARCHIVE->NAME = archive_name;
    ::flatbuffers::FlatBufferBuilder b(512);
    R::FinishSizePrefixedIngestRequestBuffer(b, R::IngestRequest::Pack(b, &job));
    return std::vector<uint8_t>(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

// An HttpRequest (HREQ). Headers are lower-cased and written sorted by NAME
// (a FlatBuffers key).
std::vector<uint8_t> build_http_get(const std::string& url,
                                    std::vector<std::pair<std::string, std::string>> headers,
                                    uint32_t timeout_ms, const std::vector<uint8_t>& context) {
    ::flatbuffers::FlatBufferBuilder b(1024 + context.size());
    std::sort(headers.begin(), headers.end());
    std::vector<::flatbuffers::Offset<R::Header>> header_offsets;
    for (const auto& [name, value] : headers) {
        header_offsets.push_back(R::CreateHeaderDirect(b, name.c_str(), value.c_str()));
    }
    R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, "GET", url.c_str(), &header_offsets,
                                                             nullptr, timeout_ms, 0, &context));
    return std::vector<uint8_t>(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

std::string header_of(const R::HttpResponse& r, const char* lower_name) {
    if (!r.HEADERS()) return std::string();
    for (const R::Header* h : *r.HEADERS()) {
        if (h && h->NAME() && h->NAME()->str() == lower_name) {
            return h->VALUE() ? h->VALUE()->str() : std::string();
        }
    }
    return std::string();
}

std::string str_of(const ::flatbuffers::String* s) { return s ? s->str() : std::string(); }

struct FetchContext {
    std::string source_url;
    std::string source_name;
    std::string provider_id;
    std::string archive_source;
    std::string archive_name;
    R::reconcileMode reconcile = R::reconcileMode_None;
    std::string etag;
    std::string last_modified;
    std::string content_type;
    std::string response_date;
    long status = 0;
    int64_t retrieved_ms = 0;  // the host's receive time (HttpResponse.RETRIEVED_MS)
    // HTTP 304 Not Modified: the host sent the validators it recorded from
    // the previous pull (If-None-Match / If-Modified-Since) and the origin
    // answered that nothing changed. No body, no batch — the parser emits one
    // "unchanged" notice and no record ports.
    bool not_modified = false;
    std::vector<uint8_t> body;
    std::string batch_id;
    const plugin_input_frame_t* response_frame = nullptr;
};

bool load_fetch_context(FetchContext* ctx) {
    const plugin_input_frame_t* frame = frame_for("response");
    if (!frame || !frame->payload || frame->payload_length == 0) {
        plugin_set_error("missing-response-frame", "parse requires the HttpResponse (HRSP) frame on \"response\".");
        return false;
    }
    ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!R::VerifyHttpResponseBuffer(verifier)) {
        plugin_set_error("invalid-response-frame", "the response frame is not an HttpResponse (HRSP).");
        return false;
    }
    ctx->response_frame = frame;
    const R::HttpResponse& response = *R::GetHttpResponse(frame->payload);

    // The job, echoed in CONTEXT.
    const auto* context = response.CONTEXT();
    if (!context || context->size() < 8) {
        plugin_set_error("missing-job", "the HttpResponse carries no job in CONTEXT (a size-prefixed IngestRequest).");
        return false;
    }
    ::flatbuffers::Verifier job_verifier(context->data(), context->size());
    if (!R::VerifySizePrefixedIngestRequestBuffer(job_verifier)) {
        plugin_set_error("invalid-job", "the response's CONTEXT is not a size-prefixed IngestRequest (INGQ).");
        return false;
    }
    const R::IngestRequest& job = *R::GetSizePrefixedIngestRequest(context->data());
    if (str_of(job.SCHEMA()) != "IQC.fbs") {
        plugin_set_error("invalid-job", "the job's SCHEMA is not IQC.fbs.");
        return false;
    }
    if (const R::SourceTags* tags = job.TAGS()) {
        ctx->source_url = str_of(tags->SOURCE_URL());
        ctx->source_name = str_of(tags->SOURCE_NAME());
        ctx->provider_id = str_of(tags->PROVIDER_ID());
    }
    if (const R::ArchiveTarget* archive = job.ARCHIVE()) {
        ctx->archive_source = str_of(archive->SOURCE());
        ctx->archive_name = str_of(archive->NAME());
    }
    ctx->reconcile = job.RECONCILE();
    if (ctx->provider_id.empty()) ctx->provider_id = kDefaultProviderID;
    if (ctx->source_name.empty()) {
        plugin_set_error("missing-source-name", "job must carry TAGS.SOURCE_NAME (the adapter's source name).");
        return false;
    }

    ctx->status = response.STATUS();
    if (ctx->status != 200 && ctx->status != 304) {
        std::string msg = "source fetch returned HTTP status " + std::to_string(ctx->status);
        if (response.ERROR() && response.ERROR()->size() > 0) msg += " (" + response.ERROR()->str() + ")";
        plugin_set_error("fetch-failed", msg.c_str());
        return false;
    }
    // Header names arrive lower-cased (RuntimeCommon Header.NAME).
    ctx->etag = header_of(response, "etag");
    ctx->last_modified = header_of(response, "last-modified");
    ctx->content_type = header_of(response, "content-type");
    ctx->response_date = header_of(response, "date");
    ctx->retrieved_ms = static_cast<int64_t>(response.RETRIEVED_MS());

    if (ctx->status == 304) {
        // Nothing changed upstream: no body is expected and no batch exists.
        ctx->not_modified = true;
        ctx->body.clear();
        return true;
    }

    if (!response.BODY() || response.BODY()->size() == 0) {
        plugin_set_error("empty-body", "http response carries no body.");
        return false;
    }
    ctx->body.assign(response.BODY()->data(), response.BODY()->data() + response.BODY()->size());
    ctx->batch_id = sha256_hex(ctx->body.data(), ctx->body.size());
    return true;
}

// The ingest request (IngestRequest, INGQ) for storage-ingest: the job
// completed with the batch id and the batch provenance. No batch LICENSE:
// licence is PER RECORDING here ($IQC LICENSE from core:license), never per
// site, so the batch tags name none (as the legacy meta named none).
std::vector<uint8_t> build_ingest_meta(const FetchContext& ctx, int64_t retrieved_ms,
                                       const DecodeStats& stats, const std::string& normalized_sha256) {
    R::IngestRequestT q;
    q.SCHEMA = "IQC.fbs";
    q.TAGS = std::make_unique<R::SourceTagsT>();
    q.TAGS->PROVIDER_ID = ctx.provider_id;
    q.TAGS->SOURCE_NAME = ctx.source_name;
    q.TAGS->BATCH_ID = ctx.batch_id;
    q.TAGS->SOURCE_URL = ctx.source_url;
    q.TAGS->CONTENT_KEY_ID = kContentKeyID;
    q.TAGS->SOURCE_PEER = kSourcePeer;
    q.RECONCILE = ctx.reconcile;
    if (!ctx.archive_source.empty() && !ctx.archive_name.empty()) {
        q.ARCHIVE = std::make_unique<R::ArchiveTargetT>();
        q.ARCHIVE->SOURCE = ctx.archive_source;
        q.ARCHIVE->NAME = ctx.archive_name;
    }
    q.PROVENANCE = std::make_unique<R::ProvenanceT>();
    R::ProvenanceT& p = *q.PROVENANCE;
    p.SOURCE_URL = ctx.source_url;
    p.HTTP_STATUS = static_cast<int32_t>(ctx.status);
    p.ETAG = ctx.etag;
    p.LAST_MODIFIED = ctx.last_modified;
    p.CONTENT_TYPE = ctx.content_type;
    p.RETRIEVED_MS = static_cast<uint64_t>(retrieved_ms);
    p.PARSER = kParserName;
    p.PARSER_VERSION = kParserVersion;
    p.SOURCE_SHA256 = ctx.batch_id;
    p.NORMALIZED_SHA256 = normalized_sha256;
    p.NORMALIZED_COUNT = static_cast<uint64_t>(stats.emitted);
    p.SCHEMAS = {"IQC.fbs"};
    p.SCHEMA_COUNTS = {static_cast<uint64_t>(stats.emitted)};
    // Recorded, not silently discarded: what the batch did NOT encode.
    if (stats.rows_unread_record_cap > 0) {
        p.WARNINGS.push_back("sigmf_record_cap " + std::to_string(stats.record_cap) + " reached: " +
                             std::to_string(stats.rows_unread_record_cap) + " of " +
                             std::to_string(stats.rows) + " capture documents not read");
    }
    if (stats.skipped_no_identity > 0) {
        p.WARNINGS.push_back("capture documents skipped, no archive identity: " +
                             std::to_string(stats.skipped_no_identity) + " of " + std::to_string(stats.rows));
    }
    if (stats.geolocation_refused_out_of_range > 0) {
        p.WARNINGS.push_back("geolocation refused, outside WGS-84 range: " +
                             std::to_string(stats.geolocation_refused_out_of_range));
    }
    p.FROM_CACHE = false;
    ::flatbuffers::FlatBufferBuilder b(2048);
    R::FinishIngestRequestBuffer(b, R::IngestRequest::Pack(b, &q));
    return std::vector<uint8_t>(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
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
// `request` turns ONE timer tick into one request (its job in CONTEXT); `parse`
// reads ONE fetched response with the job it echoes. The `response` port is fed by
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

// HTTP 304: one FlowNotice (Unchanged) on the "unchanged" port, nothing on the
// record ports. The ingest node never becomes ready (its required meta/records
// ports stay empty), so nothing is stored and no batch is announced; every
// fleet retrieval lane answers a conditional GET the same way.
int emit_unchanged(const FetchContext& ctx) {
    R::FlowNoticeT notice;
    notice.KIND = R::flowNoticeKind_Unchanged;
    notice.SCHEMA = "IQC.fbs";
    notice.PROVIDER_ID = ctx.provider_id;
    notice.SOURCE_NAME = ctx.source_name;
    notice.REASON = "not-modified";
    notice.ITEMS = {ctx.source_url};
    notice.AT_MS = static_cast<uint64_t>(ctx.retrieved_ms);
    ::flatbuffers::FlatBufferBuilder b(256);
    R::FinishFlowNoticeBuffer(b, R::FlowNotice::Pack(b, &notice));
    return push_typed("unchanged", "FlowNotice.fbs", R::FlowNoticeIdentifier(), "FlowNotice",
                      b.GetBufferPointer(), b.GetSize()) < 0 ? 500 : 0;
}

}  // namespace

extern "C" {

// ---------------------------------------------------------------------------
// request: TimerTick -> the archive bulk-metadata fetch request, its job in
// CONTEXT.
// ---------------------------------------------------------------------------
int request(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const plugin_input_frame_t* tick = frame_for("tick");
    if (!tick || !tick->payload || tick->payload_length == 0) {
        plugin_set_error("missing-tick", "request requires one TimerTick (TICK) frame on \"tick\".");
        return 400;
    }
    ::flatbuffers::Verifier tick_verifier(tick->payload, tick->payload_length);
    if (!R::VerifyTimerTickBuffer(tick_verifier)) {
        plugin_set_error("invalid-tick", "the tick frame is not a TimerTick (TICK).");
        return 400;
    }

    const Config config = load_config();
    const std::string adapter_id = config_string(config, "sigmf_adapter", kAdapterIQEngine);
    const SourceAdapter* adapter = lookup_adapter(adapter_id);
    if (!adapter) {
        const std::string msg = "unknown source adapter '" + adapter_id + "'; registered: " +
                                registered_adapter_ids();
        plugin_set_error("unknown-adapter", msg.c_str());
        return 400;
    }

    const std::string base = config_string(config, "iqengine_base_url", kIQEngineBaseURL);
    const std::string account = config_string(config, "iqengine_account", kIQEngineAccount);
    const std::string container = config_string(config, "iqengine_container", kIQEngineContainer);
    long timeout_ms = kDefaultTimeoutMs;
    if (!config_positive_long_or(config, "sigmf_http_timeout_ms", kDefaultTimeoutMs, &timeout_ms)) {
        return 400;
    }
    const std::string provider = config_string(config, "sigmf_provider_id", kDefaultProviderID);

    // ONE bulk request per cycle. The per-file /meta route exists but walking
    // it would be a 36,636-request crawl of a community-run service.
    std::string url;
    if (!config.text("sigmf_source_url", &url) || url.empty()) {
        url = base + "/api/datasources/" + url_encode_path(account) + "/" +
              url_encode_path(container) + "/meta";
    }

    std::vector<std::pair<std::string, std::string>> headers = {
        {"user-agent", kUserAgent},
        {"accept", "application/json"},
    };
    std::string etag, last_modified;
    if (config.text("sigmf_if_none_match", &etag) && !etag.empty()) headers.push_back({"if-none-match", etag});
    if (config.text("sigmf_if_modified_since", &last_modified) && !last_modified.empty()) {
        headers.push_back({"if-modified-since", last_modified});
    }

    const std::vector<uint8_t> request = build_http_get(
        url, std::move(headers), static_cast<uint32_t>(timeout_ms),
        build_job(url, adapter->source_name, provider, adapter_id + "-meta.json"));
    if (push_typed("request", "HttpRequest.fbs", R::HttpRequestIdentifier(), "HttpRequest",
                   request.data(), request.size()) < 0) {
        return 500;
    }
    return 0;
}

// ---------------------------------------------------------------------------
// parse: HttpResponse (job in CONTEXT) -> $IQC record stream + IngestRequest
// + the response verbatim for archiving.
// ---------------------------------------------------------------------------
int parse(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    FetchContext ctx;
    if (!load_fetch_context(&ctx)) return 400;
    if (ctx.not_modified) return emit_unchanged(ctx);

    // The adapter, from the job's source name through the registry. An
    // unknown one fails closed: no stub adapter ever fabricates data.
    const SourceAdapter* adapter = lookup_adapter_by_source_name(ctx.source_name);
    if (!adapter) {
        const std::string msg = "unknown source adapter for source name '" + ctx.source_name +
                                "'; registered: " + registered_adapter_ids();
        plugin_set_error("unknown-adapter", msg.c_str());
        return 400;
    }

    const std::string body(reinterpret_cast<const char*>(ctx.body.data()), ctx.body.size());
    const std::vector<std::string> rows = json_array_elements(body);
    if (rows.empty()) {
        plugin_set_error("sigmf-parse-failed",
                         "archive metadata payload decoded to zero capture documents.");
        return 422;
    }

    const Config config = load_config();
    long record_cap = kDefaultRecordCap;
    if (!config_positive_long_or(config, "sigmf_record_cap", kDefaultRecordCap, &record_cap)) {
        return 400;
    }

    // The archive coordinates request used: the same CONFIG keys and defaults.
    IQEngineContext adapter_ctx;
    adapter_ctx.base_url = config_string(config, "iqengine_base_url", kIQEngineBaseURL);
    adapter_ctx.account = config_string(config, "iqengine_account", kIQEngineAccount);
    adapter_ctx.container = config_string(config, "iqengine_container", kIQEngineContainer);

    // The records' retrieval time: the publisher's Date header, else the
    // host's receive time, else the clock.
    int64_t retrieved_unix = 0;
    if (ctx.response_date.empty() || !parse_http_date(ctx.response_date, &retrieved_unix)) {
        retrieved_unix = ctx.retrieved_ms > 0 ? ctx.retrieved_ms / 1000 : now_unix_seconds();
    }
    const std::string retrieved_at = format_rfc3339(retrieved_unix);
    const std::string created_at = format_rfc3339(now_unix_seconds());

    DecodeStats stats;
    stats.rows = static_cast<int>(rows.size());
    stats.record_cap = record_cap;
    std::vector<uint8_t> stream;
    stream.reserve(rows.size() * 512);
    Sha256 normalized;

    for (size_t index = 0; index < rows.size(); ++index) {
        if (stats.emitted >= record_cap) {
            stats.rows_unread_record_cap = static_cast<int>(rows.size() - index);
            break;
        }
        const std::string& row = rows[index];
        CaptureInput input;
        if (!adapter->decode(row, adapter_ctx, &input, &stats)) continue;
        const std::vector<uint8_t> rec = build_iqc_record(input, retrieved_at, created_at);
        append_size_prefixed(&stream, rec);
        normalized_hash_record(&normalized, "IQC.fbs", rec);
        stats.emitted++;
    }

    if (stats.emitted == 0) {
        plugin_set_error("sigmf-parse-failed",
                         "no archive capture document carried a usable identity.");
        return 422;
    }

    const std::vector<uint8_t> meta =
        build_ingest_meta(ctx, retrieved_unix * 1000, stats, normalized.hex_digest());

    if (push_typed("iqc_meta", "IngestRequest.fbs", R::IngestRequestIdentifier(), "IngestRequest",
                   meta.data(), meta.size()) < 0) {
        return 500;
    }
    if (push_iqc_stream("iqc_records", stream) < 0) return 500;
    // The response verbatim: storage-ingest archives its BODY under the
    // request's ARCHIVE naming.
    if (push_typed("raw", "HttpResponse.fbs", R::HttpResponseIdentifier(), "HttpResponse",
                   ctx.response_frame->payload, ctx.response_frame->payload_length) < 0) {
        return 500;
    }
    return 0;
}

}  // extern "C"
