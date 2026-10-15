/*
 * data-source/satnogs-source — SatNOGS DB -> SDS $RFB transmitter records.
 *
 * OWNER DIRECTIVE 2026-08-03: "we need to make sure that we have deployed
 * modules that convert data from the RF data providers we are researching into
 * space data standards messages and publish them on SDN."
 *
 * SatNOGS DB (Libre Space Foundation, https://db.satnogs.org) is the ONLY
 * source of per-object payload/beacon frequencies in this stack: ~4,994
 * transmitter rows over ~2,620 distinct NORAD-catalogued spacecraft, anonymous
 * bulk JSON, no auth. HERMES ruled it PERMITTED on 2026-07-29 with the licence
 * obligation recorded in data-source/enrichment/source-policy.json.
 *
 * ─── FLOW-NODE SHAPE (typed contracts 1.0: FlatBuffers only) ──────────────
 * Two pure flow nodes composed into flows/satnogs-rf-ingest.flow.json. Every
 * frame is a FlatBuffer: module-sdk runtime types for the host contract, $RFB
 * for the records. Nothing module-to-module is JSON or base64; the SatNOGS
 * transmitters body is the one JSON document, parsed here.
 *
 *   request : "tick" TimerTick (TICK) -> "request" ONE HttpRequest (HREQ, GET)
 *             whose CONTEXT is the parse job: ONE size-prefixed IngestRequest
 *             (INGQ) skeleton - SCHEMA RFB.fbs, TAGS (PROVIDER_ID,
 *             SOURCE_NAME satnogs-db, SOURCE_URL), RECONCILE None, ARCHIVE
 *             (satnogs, transmitters.json) - echoed verbatim by the host in
 *             the HttpResponse, so request and job are never paired by
 *             position.
 *   parse   : "response" HttpResponse (HRSP; the job in CONTEXT)
 *             -> "rfb_meta"    IngestRequest (INGQ): the job completed with
 *                              BATCH_ID, the CC-BY-SA-4.0 licence tags
 *                              (SHARE_ALIKE, CITATION) and PROVENANCE
 *                "rfb_records" size-prefixed $RFB stream
 *                "raw"         the HttpResponse verbatim (its BODY is the
 *                              document storage-ingest archives)
 *                "unchanged"   ONLY on HTTP 304: one FlowNotice (FNTC)
 *                              Unchanged, REASON "not-modified", ITEMS the
 *                              source URL; no meta/records/raw frames.
 *
 * Node CONFIG arrives through the builtin plugin.getConfig hostcall as an SDS
 * $PIV invocation (typedHostcall.hpp): one ModuleConfig FlatBuffer on raw "config".
 *
 * This module performs NO I/O of its own: the http fetch is the generic
 * hostcap/http-request connector node and the store is the generic
 * hostcap/storage-ingest connector node. No new host capability exists or is
 * needed. All decisions (what to fetch, what a record means, what licence it
 * carries) are in-wasm, which is the standing architecture law.
 *
 * ─── THE THREE THEMIS RULINGS THIS PARSER ENCODES (SDS 1.168.0+) ────────────
 * 1. Hz -> MHz is NORMATIVE (schema/RFB/main.fbs:42-45). SatNOGS ships HERTZ
 *    (downlink_low: 136658500). Every frequency field written here is
 *    value / 1e6. BAUD is baud, never kilobaud. "Encoding a Hz value into a
 *    MHz field is a defect, not a rounding choice."
 * 2. ONE RFB record = ONE LINK_DIRECTION. A SatNOGS Transceiver/Transponder
 *    becomes TWO records (UPLINK + DOWNLINK) sharing ID_TRANSMITTER (the
 *    SatNOGS transmitter UUID), each with its own MODE and FREQ_*. Emitting
 *    one record per SatNOGS row would be lossy.
 * 3. Provenance carries the LICENCE. SatNOGS DB is CC-BY-SA-4.0 — a real
 *    share-alike obligation. Every record carries CITATION verbatim, and the
 *    batch provenance carries license / license_url / citation so the
 *    obligation survives republication (source-policy.json shape (a): the RF
 *    records are their own licence-marked batch, separable from the CC-BY and
 *    public-domain catalogue fields).
 *
 * ─── HONEST GAPS (recorded, never guessed) ──────────────────────────────────
 * - POLARIZATION is written EXPLICITLY as UNKNOWN. SatNOGS does not publish
 *   polarization, and the FlatBuffer default for rfPolarization is LHCP — so
 *   leaving the field unset would silently assert left-hand circular on 5,289
 *   records. An explicit UNKNOWN is the only honest encoding.
 * - rfBandDesignation has no VHF/HF/MF/LF value, but most amateur downlinks
 *   are VHF (145 MHz). BAND therefore takes OTHER below 300 MHz while NAME
 *   carries the full-resolution designation string ("VHF"), which is exactly
 *   what NAME is for ("Band name or designation"). Nothing is lost and nothing
 *   is mislabelled. The missing enum values are a LACK for Themis.
 * - ERP/EIRP/PEAK_GAIN/EDGE_GAIN/BEAMWIDTH/PURPOSE are not published by
 *   SatNOGS and are left ABSENT (FlatBuffers omits default-valued fields, so
 *   absent is distinguishable from "0 dBW").
 * - BAUD and INVERT are single per-device values in SatNOGS with no direction,
 *   so they bind to the DOWNLINK record when one exists, else to the UPLINK
 *   record. Never duplicated onto both — that would assert a measurement the
 *   source never made.
 * - SatNOGS's per-row `citation` (often the "CITATION NEEDED" xkcd placeholder)
 *   is contributor provenance, NOT the licence attribution, so it stays in the
 *   batch provenance and never overwrites the record's CITATION.
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
// $RFB (spacedatastandards.org lib/cpp/RFB/main_generated.h) is inlined ahead of this file by build.mjs.

namespace {

namespace A = sdn::runtime::Aligned;
namespace R = sdn::runtime;

// ── Provider constants ──────────────────────────────────────────────────────

// Bulk, not crawl (source-policy.json crawlPolicy): ONE whole-table request.
// "No pagination walk, no per-object requests." Anonymous GET is sufficient.
constexpr const char* kDefaultTransmittersURL =
    "https://db.satnogs.org/api/transmitters/?format=json";
constexpr const char* kDefaultProviderID = "space-data-network-02";
// Fit-pipeline / catalogue grouping key. Distinct from every celestrak lane.
constexpr const char* kSourceName = "satnogs-db";
constexpr const char* kSourcePeer = "source:satnogs";
constexpr const char* kContentKeyID = "public";
constexpr const char* kParserName = "satnogs-source";
constexpr const char* kParserVersion = "satnogs-rfb-wasm/v1";
constexpr const char* kArchiveSource = "satnogs";
constexpr const char* kArchiveName = "transmitters.json";

// The attribution the CC-BY-SA-4.0 licence requires every derived record to
// carry downstream, verbatim from data-source/enrichment/source-policy.json
// (sources[id=satnogs-db].citationText). This is the value of RFB.CITATION.
constexpr const char* kCitation =
    "SatNOGS DB, Libre Space Foundation, https://db.satnogs.org/ (CC BY-SA 4.0)";
constexpr const char* kLicense = "CC-BY-SA-4.0";
constexpr const char* kLicenseURL = "https://creativecommons.org/licenses/by-sa/4.0/";

// source-policy.json fetchDiscipline.userAgent — identify yourself, never
// fetch anonymously or with a browser-impersonating UA.
constexpr const char* kUserAgent =
    "SDN-CatalogEnrichmentBot/0.1 (+https://spacedatanetwork.org; contact tjkoury@gmail.com)";

// The SatNOGS table is ~3.5 MB and their API answers in ~4 s; a volunteer-run
// catalogue deserves a generous client timeout rather than a retry storm.
constexpr long kDefaultTimeoutMs = 120000;

// Blast-radius cap: emit at most this many RFB records per cycle. The live
// table yields ~5,289 (4,991 downlink + 298 uplink); the cap is headroom, and
// is overridable DOWN for tests.
constexpr long kDefaultRecordCap = 50000;

// ---------------------------------------------------------------------------
// Small string / JSON helpers (control metadata only — same style as the
// other node modules; see data-source/celestrak-parser).
// ---------------------------------------------------------------------------

bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

std::string trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && is_ws(s[b])) b++;
    while (e > b && is_ws(s[e - 1])) e--;
    return s.substr(b, e - b);
}

std::string lower(const std::string& s) {
    std::string out = s;
    for (char& c : out) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return out;
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
    // `null` (SatNOGS's absent-value encoding) is NOT a number: report absent.
    if (c != '-' && (c < '0' || c > '9')) return false;
    char* end = nullptr;
    const double value = strtod(json.c_str() + i, &end);
    if (end == json.c_str() + i) return false;
    *out = value;
    return true;
}

// JSON boolean field: true/false. Returns false when absent or null.
bool json_bool_field(const std::string& json, const std::string& key, bool* out) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
    while (i < json.size() && is_ws(json[i])) i++;
    if (json.compare(i, 4, "true") == 0) { *out = true; return true; }
    if (json.compare(i, 5, "false") == 0) { *out = false; return true; }
    return false;
}

// Splits a JSON array of objects into per-object substrings. String- and
// escape-aware, and depth-tracked, so the nested `itu_notification` object can
// never mis-split a row.
std::vector<std::string> split_json_objects(const std::string& s) {
    std::vector<std::string> objs;
    int depth = 0;
    bool in_string = false, escaped = false;
    size_t start = std::string::npos;
    for (size_t i = 0; i < s.size(); i++) {
        const char c = s[i];
        if (in_string) {
            if (escaped) escaped = false;
            else if (c == '\\') escaped = true;
            else if (c == '"') in_string = false;
            continue;
        }
        if (c == '"') { in_string = true; continue; }
        if (c == '{') { if (depth == 0) start = i; depth++; }
        else if (c == '}') {
            if (depth > 0) {
                depth--;
                if (depth == 0 && start != std::string::npos) {
                    objs.push_back(s.substr(start, i - start + 1));
                    start = std::string::npos;
                }
            }
        }
    }
    return objs;
}

// ---------------------------------------------------------------------------
// SHA-256 (batch ids = sha256 of the fetched payload — the runner's
// sourceSHA256 convention, shared with data-source/celestrak-parser).
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
        total -= 9;  // total is unused after this; keeps the semantics simple
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

// Streaming hasher mirroring the runner's writeNormalizedHashRecord:
// sha256 over (schemaName, 0x00, record bytes, 0x00) per record.
void normalized_hash_record(Sha256* h, const char* schema, const std::vector<uint8_t>& record) {
    h->update(reinterpret_cast<const uint8_t*>(schema), std::strlen(schema));
    const uint8_t z = 0;
    h->update(&z, 1);
    h->update(record.data(), record.size());
    h->update(&z, 1);
}

// ---------------------------------------------------------------------------
// Civil time (RFC3339 output + HTTP-date parsing) — Howard Hinnant's algorithm,
// UTC only. Same implementation as data-source/celestrak-parser.
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

// The $RFB record stream declares its concrete SDS identity on the port, so the
// frame must carry it too (schema name, file identifier and root type).
int push_rfb_stream(const char* port, const std::vector<uint8_t>& bytes) {
    return push_typed(port, "RFB.fbs", "$RFB", "RFB", bytes.data(), bytes.size());
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
// The hostcall is an SDS $PIV invocation (typedHostcall.hpp): the host answers
// one ModuleConfig (MCFG) FlatBuffer on raw "config", read in place through
// sdm_piv::get_config(). A host that answers no config, or an error, reads as
// "no config" - every key then takes its default, exactly as before.
// ---------------------------------------------------------------------------

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
    // A number value (false when absent or not a number: a string is never
    // read as a number, as the JSON config never was).
    bool number(const char* key, double* out) const {
        const sdn::runtime::ConfigEntry* e = find(key);
        if (!e || e->KIND() != sdn::runtime::configValueKind_Number) return false;
        *out = e->NUMBER_VALUE();
        return true;
    }
};

Config load_config() { return Config{sdm_piv::get_config()}; }

std::string config_string(const Config& config, const char* key, const char* fallback) {
    std::string value;
    if (config.text(key, &value) && !value.empty()) return value;
    return fallback;
}

long config_long(const Config& config, const char* key, long fallback) {
    double v = 0;
    if (config.number(key, &v) && v > 0) return static_cast<long>(v);
    return fallback;
}

// ---------------------------------------------------------------------------
// Band designation.
//
// BAND is the rfBandDesignation enum, which covers only the IEEE radar bands
// (UHF and above). NAME carries the full designation string so VHF/HF/MF/LF —
// where most amateur satellite downlinks actually live — are not lost.
// ---------------------------------------------------------------------------

struct BandLabel {
    const char* name;               // full-resolution designation string
    rfBandDesignation designation;  // enum projection (OTHER where none exists)
};

// Boundaries in MHz, IEEE radar-band convention.
BandLabel classify_band(double center_mhz) {
    if (center_mhz <= 0) return {"", rfBandDesignation_OTHER};
    if (center_mhz < 0.03) return {"VLF", rfBandDesignation_OTHER};
    if (center_mhz < 0.3) return {"LF", rfBandDesignation_OTHER};
    if (center_mhz < 3.0) return {"MF", rfBandDesignation_OTHER};
    if (center_mhz < 30.0) return {"HF", rfBandDesignation_OTHER};
    if (center_mhz < 300.0) return {"VHF", rfBandDesignation_OTHER};
    if (center_mhz < 1000.0) return {"UHF", rfBandDesignation_UHF};
    if (center_mhz < 2000.0) return {"L", rfBandDesignation_L};
    if (center_mhz < 4000.0) return {"S", rfBandDesignation_S};
    if (center_mhz < 8000.0) return {"C", rfBandDesignation_C};
    if (center_mhz < 12000.0) return {"X", rfBandDesignation_X};
    if (center_mhz < 18000.0) return {"Ku", rfBandDesignation_KU};
    if (center_mhz < 27000.0) return {"K", rfBandDesignation_K};
    if (center_mhz < 40000.0) return {"Ka", rfBandDesignation_KA};
    if (center_mhz < 75000.0) return {"V", rfBandDesignation_V};
    if (center_mhz < 110000.0) return {"W", rfBandDesignation_W};
    return {"EHF", rfBandDesignation_EHF};
}

// SatNOGS transmitter status -> rfTransmitterState. Anything the source does
// not say is UNKNOWN; nothing is inferred from `alive`.
rfTransmitterState map_status(const std::string& status) {
    const std::string s = lower(trim(status));
    if (s == "active") return rfTransmitterState_ACTIVE;
    if (s == "inactive") return rfTransmitterState_INACTIVE;
    if (s == "invalid") return rfTransmitterState_INVALID;
    return rfTransmitterState_UNKNOWN;
}

// ---------------------------------------------------------------------------
// One SatNOGS transmitter row, decoded.
// ---------------------------------------------------------------------------

struct Transmitter {
    std::string uuid;
    std::string description;
    std::string type;              // Transmitter | Transceiver | Transponder
    std::string mode;              // downlink modulation
    std::string uplink_mode;       // uplink modulation (often absent)
    std::string sat_id;            // SatNOGS satellite identifier
    std::string status;
    std::string service;
    std::string iaru_coordination;
    std::string row_citation;       // contributor provenance, NOT the licence
    uint32_t norad_cat_id = 0;
    bool has_norad = false;
    bool invert = false;
    bool has_invert = false;
    double baud = 0;
    bool has_baud = false;
    double downlink_low = 0, downlink_high = 0;
    bool has_downlink_low = false, has_downlink_high = false;
    double uplink_low = 0, uplink_high = 0;
    bool has_uplink_low = false, has_uplink_high = false;
};

Transmitter decode_transmitter(const std::string& obj) {
    Transmitter t;
    json_string_field(obj, "uuid", &t.uuid);
    json_string_field(obj, "description", &t.description);
    json_string_field(obj, "type", &t.type);
    json_string_field(obj, "mode", &t.mode);
    json_string_field(obj, "uplink_mode", &t.uplink_mode);
    json_string_field(obj, "sat_id", &t.sat_id);
    json_string_field(obj, "status", &t.status);
    json_string_field(obj, "service", &t.service);
    json_string_field(obj, "iaru_coordination", &t.iaru_coordination);
    json_string_field(obj, "citation", &t.row_citation);

    double v = 0;
    if (json_number_field(obj, "norad_cat_id", &v) && v > 0) {
        t.norad_cat_id = static_cast<uint32_t>(v);
        t.has_norad = true;
    }
    if (json_number_field(obj, "baud", &v) && v > 0) { t.baud = v; t.has_baud = true; }
    if (json_number_field(obj, "downlink_low", &v) && v > 0) {
        t.downlink_low = v; t.has_downlink_low = true;
    }
    if (json_number_field(obj, "downlink_high", &v) && v > 0) {
        t.downlink_high = v; t.has_downlink_high = true;
    }
    if (json_number_field(obj, "uplink_low", &v) && v > 0) {
        t.uplink_low = v; t.has_uplink_low = true;
    }
    if (json_number_field(obj, "uplink_high", &v) && v > 0) {
        t.uplink_high = v; t.has_uplink_high = true;
    }
    bool b = false;
    if (json_bool_field(obj, "invert", &b)) { t.invert = b; t.has_invert = true; }
    return t;
}

// ---------------------------------------------------------------------------
// $RFB record builder.
// ---------------------------------------------------------------------------

std::vector<uint8_t> finished_copy(::flatbuffers::FlatBufferBuilder& fbb) {
    return std::vector<uint8_t>(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
}

// Builds ONE RFB record for ONE link direction (Themis ruling 2).
//
// low_hz/high_hz are the SatNOGS HERTZ values for THIS direction; every
// frequency written to the buffer is divided by 1e6 (Themis ruling 1: units
// are normative and every RFB frequency field is MHz).
std::vector<uint8_t> build_rfb_record(const Transmitter& t, linkCategory direction,
                                      double low_hz, double high_hz, bool has_high,
                                      const std::string& mode, bool carry_device_scalars) {
    const double freq_min_mhz = low_hz / 1e6;
    const double freq_max_mhz = has_high ? (high_hz / 1e6) : freq_min_mhz;
    const double center_mhz = (freq_min_mhz + freq_max_mhz) / 2.0;
    // BANDWIDTH is only knowable when the source gives a passband; a single
    // published frequency says nothing about occupied bandwidth, so the field
    // stays absent (0 == FlatBuffers default == not written).
    const double bandwidth_mhz = has_high ? (freq_max_mhz - freq_min_mhz) : 0.0;

    const BandLabel band = classify_band(center_mhz);

    const char* direction_suffix =
        direction == linkCategory_UPLINK ? ":UPLINK" : ":DOWNLINK";
    const std::string id = "satnogs:" + t.uuid + direction_suffix;

    using StrOff = ::flatbuffers::Offset<::flatbuffers::String>;

    ::flatbuffers::FlatBufferBuilder fbb(1024);
    const StrOff id_off = fbb.CreateString(id);
    const StrOff entity_off = t.sat_id.empty() ? StrOff() : fbb.CreateString(t.sat_id);
    const StrOff name_off = band.name[0] == '\0' ? StrOff() : fbb.CreateString(band.name);
    const StrOff mode_off = mode.empty() ? StrOff() : fbb.CreateString(mode);
    const StrOff transmitter_off = t.uuid.empty() ? StrOff() : fbb.CreateString(t.uuid);
    const StrOff service_off = t.service.empty() ? StrOff() : fbb.CreateString(t.service);
    const StrOff iaru_off =
        t.iaru_coordination.empty() ? StrOff() : fbb.CreateString(t.iaru_coordination);
    const StrOff citation_off = fbb.CreateString(kCitation);

    RFBBuilder b(fbb);
    b.add_ID(id_off);
    if (!entity_off.IsNull()) b.add_ID_ENTITY(entity_off);
    if (!name_off.IsNull()) b.add_NAME(name_off);
    b.add_BAND(band.designation);
    if (!mode_off.IsNull()) b.add_MODE(mode_off);
    // PURPOSE (TT&C / PAYLOAD / BEACON) is not published by SatNOGS: absent.
    b.add_FREQ_MIN(freq_min_mhz);
    b.add_FREQ_MAX(freq_max_mhz);
    b.add_CENTER_FREQ(center_mhz);
    if (bandwidth_mhz > 0) b.add_BANDWIDTH(bandwidth_mhz);
    // PEAK_GAIN / EDGE_GAIN / BEAMWIDTH / ERP / EIRP: not published, absent.
    //
    // POLARIZATION is written EXPLICITLY. rfPolarization's zero value is LHCP,
    // so an unset field would assert left-hand circular on every record.
    b.add_POLARIZATION(rfPolarization_UNKNOWN);
    if (t.has_norad) b.add_NORAD_CAT_ID(t.norad_cat_id);
    if (!transmitter_off.IsNull()) b.add_ID_TRANSMITTER(transmitter_off);
    b.add_LINK_DIRECTION(direction);
    // BAUD/INVERT are per-device in SatNOGS with no direction; they bind to the
    // record the source's own UI associates them with (downlink when present).
    if (carry_device_scalars && t.has_baud) b.add_BAUD(t.baud);
    if (!service_off.IsNull()) b.add_SERVICE(service_off);
    b.add_XMT_STATUS(map_status(t.status));
    if (carry_device_scalars && t.has_invert && t.invert) b.add_INVERT(true);
    if (!iaru_off.IsNull()) b.add_IARU_COORDINATION(iaru_off);
    b.add_CITATION(citation_off);
    const auto root = b.Finish();
    FinishRFBBuffer(fbb, root);
    return finished_copy(fbb);
}

// ---------------------------------------------------------------------------
// The parse job (HttpRequest.CONTEXT) and the fetch context.
// ---------------------------------------------------------------------------

// The job: ONE size-prefixed IngestRequest skeleton - the ingest attribution
// parse completes (schema, provider, source name and URL, reconcile mode,
// archive naming). It rides the request's CONTEXT and comes back verbatim in
// the HttpResponse.
std::vector<uint8_t> build_job(const std::string& source_url, const std::string& provider) {
    R::IngestRequestT job;
    job.SCHEMA = "RFB.fbs";
    job.TAGS = std::make_unique<R::SourceTagsT>();
    job.TAGS->PROVIDER_ID = provider;
    job.TAGS->SOURCE_NAME = kSourceName;
    job.TAGS->SOURCE_URL = source_url;
    // None, deliberately. The host's indexed-duplicates reconcile partitions on
    // orbital identity keys that an RF emitter record does not have; replay
    // idempotence comes from content-addressed CID dedupe alone (identical
    // bytes -> identical CID -> no duplicate row).
    job.RECONCILE = R::reconcileMode_None;
    job.ARCHIVE = std::make_unique<R::ArchiveTargetT>();
    job.ARCHIVE->SOURCE = kArchiveSource;
    job.ARCHIVE->NAME = kArchiveName;
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
    if (str_of(job.SCHEMA()) != "RFB.fbs") {
        plugin_set_error("invalid-job", "the job's SCHEMA is not RFB.fbs.");
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
        plugin_set_error("missing-source-name", "job must carry TAGS.SOURCE_NAME.");
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
// completed with the batch id and provenance. TAGS.LICENSE / LICENSE_URL /
// CITATION / SHARE_ALIKE are the enforcement point for the CC-BY-SA-4.0
// share-alike obligation: a batch without them is not republishable.
std::vector<uint8_t> build_ingest_meta(const FetchContext& ctx, int record_count,
                                       const std::string& normalized_sha256) {
    int64_t retrieved_unix = 0;
    if (ctx.response_date.empty() || !parse_http_date(ctx.response_date, &retrieved_unix)) {
        retrieved_unix = ctx.retrieved_ms > 0 ? ctx.retrieved_ms / 1000 : now_unix_seconds();
    }
    R::IngestRequestT q;
    q.SCHEMA = "RFB.fbs";
    q.TAGS = std::make_unique<R::SourceTagsT>();
    q.TAGS->PROVIDER_ID = ctx.provider_id;
    q.TAGS->SOURCE_NAME = ctx.source_name;
    q.TAGS->BATCH_ID = ctx.batch_id;
    q.TAGS->SOURCE_URL = ctx.source_url;
    q.TAGS->CONTENT_KEY_ID = kContentKeyID;
    q.TAGS->SOURCE_PEER = kSourcePeer;
    q.TAGS->LICENSE = kLicense;
    q.TAGS->LICENSE_URL = kLicenseURL;
    q.TAGS->CITATION = kCitation;
    q.TAGS->SHARE_ALIKE = true;
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
    p.RETRIEVED_MS = static_cast<uint64_t>(retrieved_unix) * 1000u;
    p.PARSER = kParserName;
    p.PARSER_VERSION = kParserVersion;
    p.SOURCE_SHA256 = ctx.batch_id;
    p.NORMALIZED_SHA256 = normalized_sha256;
    p.NORMALIZED_COUNT = static_cast<uint64_t>(record_count);
    p.SCHEMAS = {"RFB.fbs"};
    p.SCHEMA_COUNTS = {static_cast<uint64_t>(record_count)};
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
// ports stay empty), so nothing is stored and no batch is announced; the
// notice reaches the flow's egress sink so the operator can see the pull
// happened and found nothing new.
int emit_unchanged(const FetchContext& ctx) {
    R::FlowNoticeT notice;
    notice.KIND = R::flowNoticeKind_Unchanged;
    notice.SCHEMA = "RFB.fbs";
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
// request: TimerTick -> the SatNOGS transmitters fetch request, its job in CONTEXT.
//
// ONE whole-table request per cycle (source-policy.json: "bulkNotCrawl ... No
// pagination walk, no per-object requests"), with the identifying UA the same
// policy mandates, and conditional-request headers so an unchanged table costs
// the volunteer operator a 304 instead of 3.5 MB.
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
    const std::string url =
        config_string(config, "satnogs_transmitters_url", kDefaultTransmittersURL);
    const long timeout_ms = config_long(config, "satnogs_http_timeout_ms", kDefaultTimeoutMs);
    const std::string provider = config_string(config, "satnogs_provider_id", kDefaultProviderID);

    std::vector<std::pair<std::string, std::string>> headers = {
        {"user-agent", kUserAgent},
        {"accept", "application/json"},
    };
    // Conditional re-fetch: node CONFIG may carry the previous cycle's
    // validators. Absent = the host presents the ones it recorded.
    std::string etag, last_modified;
    if (config.text("satnogs_if_none_match", &etag) && !etag.empty()) headers.push_back({"if-none-match", etag});
    if (config.text("satnogs_if_modified_since", &last_modified) && !last_modified.empty()) {
        headers.push_back({"if-modified-since", last_modified});
    }

    const std::vector<uint8_t> request =
        build_http_get(url, std::move(headers), static_cast<uint32_t>(timeout_ms), build_job(url, provider));
    if (push_typed("request", "HttpRequest.fbs", R::HttpRequestIdentifier(), "HttpRequest",
                   request.data(), request.size()) < 0) {
        return 500;
    }
    return 0;
}

// ---------------------------------------------------------------------------
// parse: HttpResponse (job in CONTEXT) -> $RFB record stream + IngestRequest
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

    const std::string body(reinterpret_cast<const char*>(ctx.body.data()), ctx.body.size());
    const std::vector<std::string> rows = split_json_objects(body);
    if (rows.empty()) {
        plugin_set_error("satnogs-parse-failed",
                         "SatNOGS transmitters payload decoded to zero objects.");
        return 422;
    }

    const Config config = load_config();
    const long record_cap = config_long(config, "satnogs_record_cap", kDefaultRecordCap);

    std::vector<uint8_t> stream;
    stream.reserve(rows.size() * 320);
    Sha256 normalized;
    int emitted = 0, downlinks = 0, uplinks = 0, unbound = 0;

    for (const std::string& obj : rows) {
        if (emitted >= record_cap) break;
        const Transmitter t = decode_transmitter(obj);
        // A row with no uuid is not a transmitter record; skip rather than
        // mint an identifier the source never issued.
        if (t.uuid.empty()) continue;
        if (!t.has_norad) unbound++;

        // Themis ruling 2: one record per LINK_DIRECTION. The downlink carries
        // the per-device BAUD/INVERT scalars when it exists.
        const bool downlink_carries_scalars = t.has_downlink_low;

        if (t.has_downlink_low) {
            const std::vector<uint8_t> rec =
                build_rfb_record(t, linkCategory_DOWNLINK, t.downlink_low, t.downlink_high,
                                 t.has_downlink_high, t.mode, /*carry_device_scalars=*/true);
            append_size_prefixed(&stream, rec);
            normalized_hash_record(&normalized, "RFB.fbs", rec);
            emitted++;
            downlinks++;
        }
        if (emitted >= record_cap) break;
        if (t.has_uplink_low) {
            // No uplink_mode means the source does not say what the uplink
            // modulation is; falling back to the downlink `mode` would be a
            // guess, so MODE stays absent.
            const std::vector<uint8_t> rec =
                build_rfb_record(t, linkCategory_UPLINK, t.uplink_low, t.uplink_high,
                                 t.has_uplink_high, t.uplink_mode,
                                 /*carry_device_scalars=*/!downlink_carries_scalars);
            append_size_prefixed(&stream, rec);
            normalized_hash_record(&normalized, "RFB.fbs", rec);
            emitted++;
            uplinks++;
        }
    }

    if (emitted == 0) {
        plugin_set_error("satnogs-parse-failed",
                         "no SatNOGS transmitter row carried a usable frequency.");
        return 422;
    }

    // downlinks / uplinks / unbound rows were reported in the legacy JSON
    // provenance only; the typed Provenance has no field for them.
    (void)downlinks;
    (void)uplinks;
    (void)unbound;
    const std::vector<uint8_t> meta = build_ingest_meta(ctx, emitted, normalized.hex_digest());

    if (push_typed("rfb_meta", "IngestRequest.fbs", R::IngestRequestIdentifier(), "IngestRequest",
                   meta.data(), meta.size()) < 0) {
        return 500;
    }
    if (push_rfb_stream("rfb_records", stream) < 0) return 500;
    // The response verbatim: storage-ingest archives its BODY under the
    // request's ARCHIVE naming.
    if (push_typed("raw", "HttpResponse.fbs", R::HttpResponseIdentifier(), "HttpResponse",
                   ctx.response_frame->payload, ctx.response_frame->payload_length) < 0) {
        return 500;
    }
    return 0;
}

}  // extern "C"
