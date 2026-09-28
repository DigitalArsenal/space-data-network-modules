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
 * ─── FLOW-NODE SHAPE ────────────────────────────────────────────────────────
 * Two pure flow nodes, `capabilities: []`. This guest performs NO I/O: the
 * fetch is the generic hostcap/http-request connector and the store is the
 * generic hostcap/storage-ingest connector.
 *
 *   request : timer tick   -> "request" (hostcap/http-request GET JSON)
 *                             "job"     (adapter + attribution JSON)
 *   parse   : job+response -> "iqc_meta"    (storage.ingest_with_source meta)
 *                             "iqc_records" (size-prefixed $IQC stream)
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

// ── Adapter + provider constants ────────────────────────────────────────────

constexpr const char* kAdapterIQEngine = "iqengine-bulk-meta";

constexpr const char* kIQEngineBaseURL = "https://www.iqengine.org";
constexpr const char* kIQEngineAccount = "local";
constexpr const char* kIQEngineContainer = "local";
constexpr const char* kIQEngineSourceName = "IQEngine";

constexpr const char* kDefaultProviderID = "space-data-network-02";
constexpr const char* kSourceName = "sigmf-captures";
constexpr const char* kSourcePeer = "source:sigmf";
constexpr const char* kContentKeyID = "public";
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

int push_iqc_stream(const char* port, const std::vector<uint8_t>& bytes) {
    return plugin_push_output_ex(port, "IQC.fbs", "$IQC",
                                 PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "IQC", 0, 0,
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
// Node CONFIG (builtin plugin.getConfig hostcall).
//
// The hostcall ABI answers with a length-prefixed ENVELOPE meta document,
// `{"ok":true,"result":{...}}`; the config block is the `result` member and is
// unwrapped here rather than relied upon to be findable by a needle scan at
// arbitrary depth.
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

// A positive integer from node CONFIG. The node serves its YAML config block
// verbatim, so an operator's `sigmf_record_cap: "2000"` arrives as a JSON
// STRING, not a number: both spellings are the same value. Absent (or null)
// means the default. Anything else present — "2k", 0, -5, 2.5, true — is
// REFUSED rather than read as the default: host-02 staged a 2,000-record cap
// as a quoted string and the module silently ingested all 36,636.
enum class ConfigInteger { kAbsent, kValue, kInvalid };

ConfigInteger config_positive_long(const std::string& config, const char* key, long* out) {
    const std::string raw = trim(json_member(config, key));
    if (raw.empty() || raw == "null") return ConfigInteger::kAbsent;
    std::string digits;
    if (raw.front() == '"') {
        std::string value;
        if (!json_string_field(config, key, &value)) return ConfigInteger::kInvalid;
        digits = trim(value);
    } else {
        digits = raw;
    }
    // wasm32 `long` is 32 bits: nine digits always fit.
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
bool config_positive_long_or(const std::string& config, const char* key, long fallback, long* out) {
    long value = fallback;
    if (config_positive_long(config, key, &value) == ConfigInteger::kInvalid) {
        const std::string msg = std::string(key) + " must be a positive integer (a JSON number or a " +
                                "decimal string); got " + trim(json_member(config, key));
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
// Fetch context + ingest meta.
// ---------------------------------------------------------------------------

struct FetchContext {
    std::string adapter;
    std::string source_url;
    std::string source_name;
    std::string provider_id;
    std::string archive_source;
    std::string archive_name;
    std::string reconcile;
    std::string base_url;
    std::string account;
    std::string container;
    std::string dataset_id;
    std::string etag;
    std::string last_modified;
    std::string content_type;
    std::string response_date;
    long status = 0;
    // HTTP 304 Not Modified: the host sent the validators it recorded from
    // the previous pull (If-None-Match / If-Modified-Since) and the origin
    // answered that nothing changed. No body, no batch — the parser emits one
    // "unchanged" notice and no record ports.
    bool not_modified = false;
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
    json_string_field(job_json, "adapter", &ctx->adapter);
    json_string_field(job_json, "source_url", &ctx->source_url);
    json_string_field(job_json, "source_name", &ctx->source_name);
    json_string_field(job_json, "provider_id", &ctx->provider_id);
    json_string_field(job_json, "archive_source", &ctx->archive_source);
    json_string_field(job_json, "archive_name", &ctx->archive_name);
    json_string_field(job_json, "reconcile", &ctx->reconcile);
    json_string_field(job_json, "dataset_id", &ctx->dataset_id);
    json_string_field(job_json, "base_url", &ctx->base_url);
    json_string_field(job_json, "account", &ctx->account);
    json_string_field(job_json, "container", &ctx->container);
    if (ctx->provider_id.empty()) ctx->provider_id = kDefaultProviderID;
    if (ctx->source_name.empty()) {
        plugin_set_error("missing-source-name", "job must carry source_name.");
        return false;
    }
    if (ctx->adapter.empty()) {
        plugin_set_error("missing-adapter", "job must name a source adapter.");
        return false;
    }

    double status = 0;
    if (!json_number_field(response_json, "status", &status)) {
        plugin_set_error("missing-status", "http response frame carries no status.");
        return false;
    }
    ctx->status = static_cast<long>(status);
    if (ctx->status != 200 && ctx->status != 304) {
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

    if (ctx->status == 304) {
        // Nothing changed upstream: no body is expected and no batch exists.
        ctx->not_modified = true;
        ctx->body.clear();
        return true;
    }

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
                                  const DecodeStats& stats, const std::string& normalized_sha256) {
    char nbuf[64];
    std::snprintf(nbuf, sizeof(nbuf), "{\"IQC.fbs\":%d}", stats.emitted);
    std::string warnings;
    if (stats.rows_unread_record_cap > 0) {
        warnings = "\"sigmf_record_cap " + std::to_string(stats.record_cap) + " reached: " +
                   std::to_string(stats.rows_unread_record_cap) + " of " +
                   std::to_string(stats.rows) + " capture documents not read\"";
    }
    std::string out = std::string("{\"source_url\":\"") + json_escape(ctx.source_url) + "\"" +
                      ",\"adapter\":\"" + json_escape(ctx.adapter) + "\"" +
                      ",\"registered_adapters\":\"" + registered_adapter_ids() + "\"" +
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
           ",\"normalized_count\":" + std::to_string(stats.emitted) +
           ",\"schema_counts\":" + nbuf +
           ",\"source_rows\":" + std::to_string(stats.rows) +
           ",\"skipped_no_identity\":" + std::to_string(stats.skipped_no_identity) +
           ",\"records_with_geolocation\":" + std::to_string(stats.geolocation_present) +
           ",\"geolocation_refused_out_of_range\":" +
           std::to_string(stats.geolocation_refused_out_of_range) +
           ",\"records_with_license\":" + std::to_string(stats.with_license) +
           ",\"records_with_annotations\":" + std::to_string(stats.with_annotations) +
           ",\"records_with_multiple_segments\":" +
           std::to_string(stats.with_multiple_segments) +
           ",\"record_cap\":" + std::to_string(stats.record_cap) +
           ",\"rows_unread_record_cap\":" + std::to_string(stats.rows_unread_record_cap) +
           // Licence is PER RECORDING here, never per site: a record with no
           // core:license carries no LICENSE, which means UNKNOWN TERMS.
           ",\"license_model\":\"per-recording\"" +
           ",\"custody\":\"UPSTREAM_ONLY\"" +
           ",\"units\":{\"frequency\":\"Hz\",\"sample_rate\":\"Hz\"}" +
           ",\"source_units\":{\"frequency\":\"Hz\",\"sample_rate\":\"Hz\"}" +
           ",\"warnings\":[" + warnings + "],\"from_cache\":false}";
    return out;
}

std::string build_ingest_meta(const FetchContext& ctx, const std::string& provenance_json) {
    const std::string reconcile = ctx.reconcile.empty() ? std::string("none") : ctx.reconcile;
    std::string meta = std::string("{\"schema\":\"IQC.fbs\"") +
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

// HTTP 304: one notice frame on the "unchanged" port, nothing on the record
// ports. The ingest node never becomes ready (its required meta/records ports
// stay empty), so nothing is stored and no batch is announced. Byte-for-byte
// the celestrak-parser notice; mirrored here so every fleet retrieval lane
// answers a conditional GET the same way.
int emit_unchanged(const FetchContext& ctx) {
    const std::string notice = std::string("{\"status\":304,\"unchanged\":true") +
                               ",\"source_name\":\"" + json_escape(ctx.source_name) + "\"" +
                               ",\"source_url\":\"" + json_escape(ctx.source_url) + "\"" +
                               ",\"dataset_id\":\"" + json_escape(ctx.dataset_id) + "\"}";
    return push_json("unchanged", notice) < 0 ? 500 : 0;
}

}  // namespace

extern "C" {

// ---------------------------------------------------------------------------
// request: timer tick -> the archive bulk-metadata fetch request + parse job.
// ---------------------------------------------------------------------------
int request(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    const std::string config = load_config();
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
    if (!json_string_field(config, "sigmf_source_url", &url) || url.empty()) {
        url = base + "/api/datasources/" + url_encode_path(account) + "/" +
              url_encode_path(container) + "/meta";
    }

    std::string headers = std::string("{\"user-agent\":\"") + json_escape(kUserAgent) + "\"" +
                          ",\"accept\":\"application/json\"";
    std::string etag, last_modified;
    if (json_string_field(config, "sigmf_if_none_match", &etag) && !etag.empty()) {
        headers += ",\"if-none-match\":\"" + json_escape(etag) + "\"";
    }
    if (json_string_field(config, "sigmf_if_modified_since", &last_modified) &&
        !last_modified.empty()) {
        headers += ",\"if-modified-since\":\"" + json_escape(last_modified) + "\"";
    }
    headers += "}";

    const std::string request_json = std::string("{\"method\":\"GET\",\"url\":\"") +
                                     json_escape(url) + "\",\"headers\":" + headers +
                                     ",\"timeoutMs\":" + std::to_string(timeout_ms) + "}";
    const std::string job_json = std::string("{\"adapter\":\"") + json_escape(adapter->id) + "\"" +
                                 ",\"source_url\":\"" + json_escape(url) + "\"" +
                                 ",\"source_name\":\"" + json_escape(adapter->source_name) + "\"" +
                                 ",\"provider_id\":\"" + json_escape(provider) + "\"" +
                                 ",\"base_url\":\"" + json_escape(base) + "\"" +
                                 ",\"account\":\"" + json_escape(account) + "\"" +
                                 ",\"container\":\"" + json_escape(container) + "\"" +
                                 ",\"archive_source\":\"" + kArchiveSource + "\"" +
                                 ",\"archive_name\":\"" + json_escape(adapter_id) + "-meta.json\"}";

    if (push_json("request", request_json) < 0) return 500;
    if (push_json("job", job_json) < 0) return 500;
    return 0;
}

// ---------------------------------------------------------------------------
// parse: (job, response) -> $IQC record stream + ingest meta + raw payload.
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

    const SourceAdapter* adapter = lookup_adapter(ctx.adapter);
    if (!adapter) {
        const std::string msg = "unknown source adapter '" + ctx.adapter + "'; registered: " +
                                registered_adapter_ids();
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

    const std::string config = load_config();
    long record_cap = kDefaultRecordCap;
    if (!config_positive_long_or(config, "sigmf_record_cap", kDefaultRecordCap, &record_cap)) {
        return 400;
    }

    IQEngineContext adapter_ctx;
    adapter_ctx.base_url = ctx.base_url.empty() ? kIQEngineBaseURL : ctx.base_url;
    adapter_ctx.account = ctx.account.empty() ? kIQEngineAccount : ctx.account;
    adapter_ctx.container = ctx.container.empty() ? kIQEngineContainer : ctx.container;

    std::string retrieved_at;
    int64_t date_unix = 0;
    if (!ctx.response_date.empty() && parse_http_date(ctx.response_date, &date_unix)) {
        retrieved_at = format_rfc3339(date_unix);
    } else {
        retrieved_at = format_rfc3339(now_unix_seconds());
    }
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

    const std::string provenance =
        build_provenance_json(ctx, retrieved_at, stats, normalized.hex_digest());
    const std::string meta = build_ingest_meta(ctx, provenance);

    if (push_json("iqc_meta", meta) < 0) return 500;
    if (push_iqc_stream("iqc_records", stream) < 0) return 500;
    if (push_bytes("raw", ctx.body) < 0) return 500;
    return 0;
}

}  // extern "C"
