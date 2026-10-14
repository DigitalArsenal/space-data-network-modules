/*
 * foundation/http-respond — the HTTP edge's responder (typed contracts 1.0).
 *
 * A typed decision plus the typed answer in, exactly one $HTR HttpResponse envelope out. Pure compute: no
 * capabilities, no hostcalls.
 *
 *   respond        "decision" $APR (foundation/http-route discover / route_node_status / route_node_activity, passed on
 *                  by the serving node) + at most one body: "status" $NHS, "activity" $NEV, "peers" $NST, "notices"
 *                  $PNV, or "availability" $DAV with the dataset's records on its standard's "<code>_records" port.
 *   respond_query  "decision" $QRP (the request passed on by the serving node, or a KIND Error from the router or the
 *                  serving node) + "page": the $QRP page stream (a size-prefixed QRP Page header followed by its record
 *                  frames, or a projection / query-surface header alone).
 *
 * The answer, in order:
 *   1. A refusal - $APR STATUS set, or a $QRP KIND Error (its HTTP_STATUS, or one derived from ERROR_CODE / STATUS
 *      when the deciding node left it 0) - answers that status. With a body beside it (an $APR 503 with the $DAV of an
 *      unavailable dataset) the body is the answer; otherwise the refusal record itself is (FlatBuffer), or
 *      {"error":ERROR_MESSAGE,"code":ERROR_CODE} (Json).
 *   2. If-None-Match ($APR IF_NONE_MATCH / the $QRP request's ETAG) equal to the answer's entity tag (the page header's
 *      ETAG, the $DAV ETAG) -> 304 with the etag header and no body.
 *   3. 200, in the representation the decision names ($APR ACCEPT / $QRP REPRESENTATION):
 *      FlatBuffer / Default -> the FlatBuffers verbatim: one record (application/x-flatbuffers, x-sdn-file-identifier)
 *        or a size-prefixed stream (application/vnd.sdn.flatbuffers.stream, x-sdn-record-count): the page stream as
 *        the serving node produced it, or the $DAV followed by the dataset's records.
 *      Json -> the external client representation, rendered HERE and nowhere else: one object per record with the
 *        standard's IDL field names exactly (json-schema-capitalization-rule), enums by name, byte vectors as lower-case
 *        hex; a projection page as a bare array of {COLUMN: value} objects; whole-record pages and datasets as a bare
 *        array of records ($OMM only: another standard's records answer 406 rather than be mis-rendered); the query
 *        surface as {"TABLES":[...], "MAX_ELAPSED_MS", "MAX_ROWS", "MAX_BYTES"}.
 *      Csv / Text -> 406.
 *
 * Out-of-band delivery: a $QRP page header or a $DAV carrying BODY_REF_TOKEN answers the $HTR with BODY_REF_TOKEN /
 * BODY_REF_SIZE and no inline body; the host egress substitutes the record stream it holds under the token.
 * $APR RESPONSE_HEADERS are added to the answer (narrowly: see append_response_headers).
 *
 * Response headers are lower-cased and sorted by NAME (an $HTR key field). The SDK HTTP ABI headers and the SDS
 * headers (APR QRP NHS NEV NST PNV DAV, and OMM with RFM TIM MET CVR PVN) are inlined by build.mjs.
 */

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

#include "space_data_module_invoke.h"

namespace {

constexpr const char* kContentTypeStream = "application/vnd.sdn.flatbuffers.stream";
constexpr const char* kContentTypeFlatBuffer = "application/x-flatbuffers";
constexpr const char* kContentTypeJson = "application/json";

// The standards a dataset's records may arrive in (one typed port each), in manifest order.
constexpr const char* kRecordPorts[] = {"omm_records", "mpe_records", "cat_records", "spw_records", "eop_records", "csm_records",
                                        "egp_records", "sit_records", "lcc_records", "tbs_records", "gnp_records", "wxf_records",
                                        "cnp_records", "rfb_records", "iqc_records", "tct_records", "dtt_records"};

uint32_t read_u32le(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) | (static_cast<uint32_t>(p[2]) << 16) |
           (static_cast<uint32_t>(p[3]) << 24);
}

const plugin_input_frame_t* find_input(const char* port) {
    const int32_t index = plugin_find_input_index(port, 0);
    const plugin_input_frame_t* frame = index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
    return frame && frame->payload && frame->payload_length > 0 ? frame : nullptr;
}

// SURPLUS-FRAME REFUSAL — graph task `modules-guest-nodes-drop-batched-frames`. The compiled flow runtime drains a
// node's queue PORT-BLIND (budget 64; maxStreams is declarative only). This node answers exactly ONE HTTP exchange, so
// two frames on one port have no honest reading: answering from whichever the queue held first is arbitrary and looks
// correct. Flows that wire two producers into one port (a router's refusal and a serving node's decision) rely on the
// producers being mutually exclusive; if that ever breaks, the invocation is refused by name instead.
bool find_batched_input_port(char* message, size_t message_len) {
    const uint32_t count = plugin_get_input_count();
    for (uint32_t i = 0; i < count; i++) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        if (!frame || !frame->port_id) continue;
        for (uint32_t j = 0; j < i; j++) {
            const plugin_input_frame_t* earlier = plugin_get_input_frame(j);
            if (!earlier || !earlier->port_id || std::strcmp(earlier->port_id, frame->port_id) != 0) continue;
            uint32_t on_port = 0;
            for (uint32_t k = 0; k < count; k++) {
                const plugin_input_frame_t* f = plugin_get_input_frame(k);
                if (f && f->port_id && std::strcmp(f->port_id, frame->port_id) == 0) on_port++;
            }
            std::snprintf(message, message_len,
                          "This invocation carries %u frames on single-stream input port \"%s\" "
                          "(the compiled flow runtime drains a node's whole queue port-blind; "
                          "maxStreams is declarative only). respond answers exactly one HTTP "
                          "exchange, so the surplus frames are refused rather than silently "
                          "discarded.",
                          on_port, frame->port_id);
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// JSON output (the client representation only)
// ---------------------------------------------------------------------------

void json_escape_into(std::string* out, std::string_view s) {
    out->push_back('"');
    for (const char c : s) {
        if (c == '"' || c == '\\') { out->push_back('\\'); out->push_back(c); }
        else if (c == '\n') *out += "\\n";
        else if (c == '\r') *out += "\\r";
        else if (c == '\t') *out += "\\t";
        else if (static_cast<unsigned char>(c) < 0x20) {
            char buf[8];
            std::snprintf(buf, sizeof buf, "\\u%04x", static_cast<unsigned char>(c));
            *out += buf;
        } else out->push_back(c);
    }
    out->push_back('"');
}

class JsonOut {
 public:
    std::string s;
    void begin_object() { value_prefix(); s.push_back('{'); first_.push_back(true); }
    void end_object() { s.push_back('}'); first_.pop_back(); }
    void begin_array() { value_prefix(); s.push_back('['); first_.push_back(true); }
    void end_array() { s.push_back(']'); first_.pop_back(); }
    void key(const char* k) {
        comma();
        json_escape_into(&s, k);
        s.push_back(':');
        after_key_ = true;
    }
    void str(const flatbuffers::String* v) { if (v) str(v->string_view()); else null(); }
    void str(std::string_view v) { value_prefix(); json_escape_into(&s, v); }
    void null() { value_prefix(); s += "null"; }
    void boolean(bool v) { value_prefix(); s += v ? "true" : "false"; }
    void i64(int64_t v) { value_prefix(); s += std::to_string(v); }
    void u64(uint64_t v) { value_prefix(); s += std::to_string(v); }
    void f64(double v) {
        value_prefix();
        if (!std::isfinite(v)) { s += "null"; return; }  // JSON has no NaN / Infinity
        char buf[40];
        std::snprintf(buf, sizeof buf, "%.17g", v);
        s += buf;
    }
    void hex(const flatbuffers::Vector<uint8_t>* v) {
        if (!v) { null(); return; }
        static const char* kHex = "0123456789abcdef";
        std::string h;
        h.reserve(v->size() * 2);
        for (const uint8_t b : *v) { h.push_back(kHex[b >> 4]); h.push_back(kHex[b & 15]); }
        str(h);
    }
    void base64(const flatbuffers::Vector<uint8_t>* v) {
        if (!v) { null(); return; }
        static const char* kB64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        std::string out;
        size_t i = 0;
        for (; i + 2 < v->size(); i += 3) {
            const uint32_t n = (v->Get(i) << 16) | (v->Get(i + 1) << 8) | v->Get(i + 2);
            out += kB64[(n >> 18) & 63]; out += kB64[(n >> 12) & 63]; out += kB64[(n >> 6) & 63]; out += kB64[n & 63];
        }
        if (i + 1 == v->size()) {
            const uint32_t n = v->Get(i) << 16;
            out += kB64[(n >> 18) & 63]; out += kB64[(n >> 12) & 63]; out += "==";
        } else if (i + 2 == v->size()) {
            const uint32_t n = (v->Get(i) << 16) | (v->Get(i + 1) << 8);
            out += kB64[(n >> 18) & 63]; out += kB64[(n >> 12) & 63]; out += kB64[(n >> 6) & 63]; out += '=';
        }
        str(out);
    }
    void strings(const flatbuffers::Vector<flatbuffers::Offset<flatbuffers::String>>* v) {
        if (!v) { null(); return; }
        begin_array();
        for (const auto* item : *v) str(item);
        end_array();
    }

 private:
    void comma() {
        if (!first_.empty()) {
            if (!first_.back()) s.push_back(',');
            first_.back() = false;
        }
    }
    void value_prefix() {
        if (after_key_) { after_key_ = false; return; }
        comma();
    }
    std::vector<bool> first_;
    bool after_key_ = false;
};

// IDL-exact keys: #FIELD stringizes the generated accessor, which IS the schema field name.
#define J_STR(j, r, FIELD) do { (j).key(#FIELD); (j).str((r)->FIELD()); } while (0)
#define J_I64(j, r, FIELD) do { (j).key(#FIELD); (j).i64(static_cast<int64_t>((r)->FIELD())); } while (0)
#define J_U64(j, r, FIELD) do { (j).key(#FIELD); (j).u64(static_cast<uint64_t>((r)->FIELD())); } while (0)
#define J_F64(j, r, FIELD) do { (j).key(#FIELD); (j).f64(static_cast<double>((r)->FIELD())); } while (0)
#define J_BOOL(j, r, FIELD) do { (j).key(#FIELD); (j).boolean((r)->FIELD()); } while (0)
#define J_ENUM(j, r, FIELD, NAME_FN) do { (j).key(#FIELD); (j).str(NAME_FN((r)->FIELD())); } while (0)
#define J_HEX(j, r, FIELD) do { (j).key(#FIELD); (j).hex((r)->FIELD()); } while (0)
#define J_STRS(j, r, FIELD) do { (j).key(#FIELD); (j).strings((r)->FIELD()); } while (0)

void render_nhs(JsonOut& j, const NHS* r) {
    j.begin_object();
    J_STR(j, r, NODE_ID); J_I64(j, r, GENERATED_AT_MS); J_I64(j, r, STARTED_AT_MS); J_U64(j, r, UPTIME_S);
    J_ENUM(j, r, SERVICE_STATE, EnumNamenhsServiceState); J_STR(j, r, SERVICE_MODE); J_STR(j, r, SOFTWARE_VERSION);
    J_STR(j, r, STORAGE_PATH); J_U64(j, r, STORE_TOTAL_RECORDS); J_U64(j, r, STORE_TOTAL_BYTES);
    J_BOOL(j, r, HAS_DISK); J_U64(j, r, DISK_CAPACITY_BYTES); J_U64(j, r, DISK_FREE_BYTES); J_U64(j, r, DISK_AVAILABLE_BYTES);
    J_BOOL(j, r, HAS_NETWORK); J_U64(j, r, TOTAL_IN_BYTES); J_U64(j, r, TOTAL_OUT_BYTES); J_F64(j, r, RATE_IN_BPS); J_F64(j, r, RATE_OUT_BPS);
    j.key("THROUGHPUT_HISTORY");
    j.begin_array();
    if (const auto* history = r->THROUGHPUT_HISTORY()) {
        for (const auto* s : *history) {
            j.begin_object();
            J_I64(j, s, TIME_MS); J_U64(j, s, TOTAL_IN_BYTES); J_U64(j, s, TOTAL_OUT_BYTES); J_F64(j, s, RATE_IN_BPS); J_F64(j, s, RATE_OUT_BPS);
            j.end_object();
        }
    }
    j.end_array();
    J_BOOL(j, r, HAS_COMPUTE); J_F64(j, r, CPU_LOAD); J_U64(j, r, CPU_CORES); J_U64(j, r, MEMORY_USED_BYTES); J_U64(j, r, MEMORY_TOTAL_BYTES);
    J_U64(j, r, CONNECTION_COUNT); J_STRS(j, r, NOTES);
    j.end_object();
}

void render_nev(JsonOut& j, const NEV* r) {
    j.begin_object();
    J_STR(j, r, NODE_ID); J_I64(j, r, GENERATED_AT_MS);
    j.key("EVENTS");
    j.begin_array();
    if (const auto* events = r->EVENTS()) {
        for (const auto* e : *events) {
            j.begin_object();
            J_I64(j, e, TIME_MS); J_ENUM(j, e, KIND, EnumNamenevEventKind); J_STR(j, e, PEER_ID); J_STR(j, e, SUBJECT);
            J_U64(j, e, COUNT); J_STR(j, e, DETAIL);
            j.end_object();
        }
    }
    j.end_array();
    J_U64(j, r, TOTAL_EVENTS); J_I64(j, r, OLDEST_TIME_MS);
    j.end_object();
}

void render_nst(JsonOut& j, const NST* r) {
    j.begin_object();
    j.key("NODES");
    j.begin_array();
    if (const auto* nodes = r->NODES()) {
        for (const auto* n : *nodes) {
            j.begin_object();
            J_STR(j, n, PEER_ID); J_STR(j, n, DN); J_STR(j, n, ORGANIZATION); J_STR(j, n, TRUST_LEVEL); J_STR(j, n, ROLE);
            J_STR(j, n, AGENT_VERSION); J_STRS(j, n, MULTIFORMAT_ADDRESS); J_I64(j, n, LAST_SEEN); J_BOOL(j, n, IS_ONLINE);
            J_F64(j, n, LATENCY_MS); J_STR(j, n, VCARD); J_F64(j, n, LAT); J_F64(j, n, LON); J_STR(j, n, GEO_COUNTRY);
            J_STR(j, n, GEO_CITY); J_BOOL(j, n, IS_SELF); J_I64(j, n, UPTIME_S); J_STR(j, n, SUITE_VERSION);
            J_STR(j, n, STANDARDS_VERSION); J_STR(j, n, SOURCE); J_BOOL(j, n, PINNED); J_STR(j, n, PIN_NOTE);
            J_STRS(j, n, CONNECTED_PEER_IDS); J_STR(j, n, SIGNING_PUBLIC_KEY); J_STR(j, n, ENCRYPTION_PUBLIC_KEY);
            J_STR(j, n, EPM_CID); J_STR(j, n, STORAGE_DAEMON_VERSION); J_STR(j, n, ONION_ADDRESS); J_STRS(j, n, STANDARDS);
            j.end_object();
        }
    }
    j.end_array();
    J_I64(j, r, GENERATED_AT); J_STR(j, r, SOURCE_PEER_ID); J_STR(j, r, ETAG);
    j.end_object();
}

void render_pnv(JsonOut& j, const PNV* r) {
    j.begin_object();
    J_STR(j, r, VERIFIER_PEER_ID); J_I64(j, r, GENERATED_AT_MS);
    j.key("ENTRIES");
    j.begin_array();
    if (const auto* entries = r->ENTRIES()) {
        for (const auto* e : *entries) {
            j.begin_object();
            J_STR(j, e, PNM_CID); J_STR(j, e, PUBLISHER_PEER_ID); J_STR(j, e, RECEIVED_FROM_PEER_ID); J_STR(j, e, STANDARD);
            J_STR(j, e, SCHEMA_NAME); J_STR(j, e, FILE_ID); J_STR(j, e, FILE_NAME); J_STR(j, e, CID);
            J_I64(j, e, PUBLISHED_AT_MS); J_I64(j, e, RECEIVED_AT_MS); J_STR(j, e, SIGNATURE_TYPE); J_HEX(j, e, SIGNATURE);
            J_BOOL(j, e, SIGNATURE_VERIFIED); J_ENUM(j, e, ATTRIBUTION, EnumNamepnvAttribution); J_HEX(j, e, PUBLISHER_KEY);
            J_ENUM(j, e, KEY_SOURCE, EnumNamepnvKeySource); J_STR(j, e, REASON); J_HEX(j, e, PNM);
            j.end_object();
        }
    }
    j.end_array();
    J_STR(j, r, ETAG);
    j.end_object();
}

void render_dav(JsonOut& j, const DAV* r) {
    j.begin_object();
    J_STR(j, r, STANDARD); J_STR(j, r, SCHEMA_NAME); J_STR(j, r, PROVIDER_ID); J_STR(j, r, SOURCE_NAME);
    J_BOOL(j, r, KNOWN); J_BOOL(j, r, AVAILABLE); J_ENUM(j, r, UNAVAILABLE_REASON, EnumNamedavUnavailableReason);
    J_BOOL(j, r, SELF_PUBLISHED); J_BOOL(j, r, PINNED); J_BOOL(j, r, FRESH); J_STR(j, r, BATCH_ID);
    J_U64(j, r, RECORD_COUNT); J_U64(j, r, BYTE_COUNT); J_U64(j, r, PARTS); J_I64(j, r, PUBLISHED_AT_MS);
    J_STR(j, r, PNM_CID); J_STR(j, r, PNM_FILE_ID); J_I64(j, r, PNM_PUBLISHED_AT_MS); J_BOOL(j, r, PNM_SIGNATURE_VERIFIED);
    J_STR(j, r, PUBLISHER_PEER_ID); J_STR(j, r, ETAG);
    j.end_object();
}

// The full $OMM record as foundation/omm-json rendered it (the same field set and order: existing consumers initialize
// SGP4 from it). REFERENCE_FRAME / COV_REFERENCE_FRAME (RFM tables), USER_DEFINED_PARAMETERS, PROVENANCE and
// COV_REALISM are nested tables no ingest path populates for the bulk surface; they are omitted, as before.
void render_omm(JsonOut& j, const OMM* r) {
    j.begin_object();
    J_U64(j, r, NORAD_CAT_ID); J_STR(j, r, OBJECT_NAME); J_STR(j, r, OBJECT_ID); J_STR(j, r, EPOCH);
    J_F64(j, r, MEAN_MOTION); J_F64(j, r, ECCENTRICITY); J_F64(j, r, INCLINATION);
    J_F64(j, r, RA_OF_ASC_NODE); J_F64(j, r, ARG_OF_PERICENTER); J_F64(j, r, MEAN_ANOMALY); J_F64(j, r, BSTAR);
    J_F64(j, r, MEAN_MOTION_DOT); J_F64(j, r, MEAN_MOTION_DDOT); J_U64(j, r, ELEMENT_SET_NO); J_F64(j, r, REV_AT_EPOCH);
    J_STR(j, r, CLASSIFICATION_TYPE); J_ENUM(j, r, EPHEMERIS_TYPE, EnumNameephemerisFormat); J_F64(j, r, CCSDS_OMM_VERS);
    J_STR(j, r, CREATION_DATE); J_STR(j, r, ORIGINATOR); J_STR(j, r, CENTER_NAME); J_STR(j, r, REFERENCE_FRAME_EPOCH);
    J_ENUM(j, r, TIME_SYSTEM, EnumNametimingStandard); J_ENUM(j, r, MEAN_ELEMENT_THEORY, EnumNamemeanElementSource);
    J_STR(j, r, COMMENT); J_F64(j, r, SEMI_MAJOR_AXIS); J_F64(j, r, GM); J_F64(j, r, MASS); J_F64(j, r, SOLAR_RAD_AREA);
    J_F64(j, r, SOLAR_RAD_COEFF); J_F64(j, r, DRAG_AREA); J_F64(j, r, DRAG_COEFF);
    if (const auto* cov = r->COVARIANCE()) {
        j.key("COVARIANCE");
        j.begin_array();
        for (const double v : *cov) j.f64(v);
        j.end_array();
    }
    J_U64(j, r, USER_DEFINED_BIP_0044_TYPE); J_STR(j, r, USER_DEFINED_OBJECT_DESIGNATOR); J_STR(j, r, USER_DEFINED_EARTH_MODEL);
    J_F64(j, r, USER_DEFINED_EPOCH_TIMESTAMP); J_F64(j, r, USER_DEFINED_MICROSECONDS);
    j.end_object();
}

// ---------------------------------------------------------------------------
// Size-prefixed streams
// ---------------------------------------------------------------------------

struct Frame {
    size_t at;     // offset of the u32 prefix
    uint32_t size; // frame bytes after the prefix
};

// The frames of a size-prefixed stream from `offset`; zero-length prefixes are padding. False when the framing is
// malformed.
bool frames_of(const uint8_t* data, size_t length, size_t offset, std::vector<Frame>* out) {
    while (offset < length) {
        if (length - offset < 4) return false;
        const uint32_t size = read_u32le(data + offset);
        if (size == 0) { offset += 4; continue; }
        if (size > length - offset - 4) return false;
        out->push_back({offset, size});
        offset += 4 + static_cast<size_t>(size);
    }
    return true;
}

// The 4-character file identifier of a stream frame (a FlatBuffer built size-prefixed carries it at prefix+8, i.e.
// frame byte 4; one built plain and then prefixed carries it at frame byte 4 too).
std::string identifier_of(const uint8_t* data, const Frame& f) {
    if (f.size < 8) return std::string();
    return std::string(reinterpret_cast<const char*>(data + f.at + 8), 4);
}

// A stream frame copied into aligned scratch, as a T root: size-prefixed first (the store's wire contract: internal
// alignment counts the 4-byte prefix), else re-anchored as a plain buffer.
template <typename T, bool (*VerifyPrefixed)(flatbuffers::Verifier&), bool (*VerifyPlain)(flatbuffers::Verifier&),
          const T* (*GetPrefixed)(const void*), const T* (*GetPlain)(const void*)>
const T* frame_root(const uint8_t* data, const Frame& f, std::vector<uint8_t>* scratch) {
    scratch->assign(data + f.at, data + f.at + 4 + f.size);
    flatbuffers::Verifier prefixed(scratch->data(), scratch->size());
    if (VerifyPrefixed(prefixed)) return GetPrefixed(scratch->data());
    scratch->erase(scratch->begin(), scratch->begin() + 4);
    flatbuffers::Verifier plain(scratch->data(), scratch->size());
    return VerifyPlain(plain) ? GetPlain(scratch->data()) : nullptr;
}
const OMM* omm_frame(const uint8_t* data, const Frame& f, std::vector<uint8_t>* scratch) {
    return frame_root<OMM, VerifySizePrefixedOMMBuffer, VerifyOMMBuffer, GetSizePrefixedOMM, GetOMM>(data, f, scratch);
}
const QRP* qrp_frame(const uint8_t* data, const Frame& f, std::vector<uint8_t>* scratch) {
    return frame_root<QRP, VerifySizePrefixedQRPBuffer, VerifyQRPBuffer, GetSizePrefixedQRP, GetQRP>(data, f, scratch);
}

// Records as a bare JSON array. Only $OMM records have a JSON rendering here; another standard is not-acceptable.
bool render_records(const uint8_t* data, const std::vector<Frame>& frames, size_t first, JsonOut& j, std::string* why) {
    std::vector<uint8_t> scratch;
    j.begin_array();
    for (size_t i = first; i < frames.size(); i++) {
        const std::string id = identifier_of(data, frames[i]);
        if (id != "$OMM") {
            *why = "json encoding is not available for " + (id.empty() ? std::string("these records") : id + " records") + "; request format=flatbuffer";
            return false;
        }
        const OMM* omm = omm_frame(data, frames[i], &scratch);
        if (!omm) { *why = "a record frame is not a valid $OMM FlatBuffer"; return false; }
        render_omm(j, omm);
    }
    j.end_array();
    return true;
}

// ---------------------------------------------------------------------------
// The $HTR
// ---------------------------------------------------------------------------

struct Header {
    std::string name;
    std::string value;
};

int push_response(uint16_t status, const std::vector<Header>& headers, const uint8_t* body, size_t body_length,
                  uint64_t body_ref_token = 0, uint64_t body_ref_size = 0) {
    flatbuffers::FlatBufferBuilder b(1024 + body_length);
    std::vector<flatbuffers::Offset<sdn::http::HttpHeader>> offsets;
    for (const auto& h : headers) {
        offsets.push_back(sdn::http::CreateHttpHeader(b, b.CreateString(h.name), b.CreateString(h.value)));
    }
    const auto headers_vector = offsets.empty() ? flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<sdn::http::HttpHeader>>>(0)
                                                : b.CreateVectorOfSortedTables<sdn::http::HttpHeader>(&offsets);
    const auto body_vector = body && body_length ? b.CreateVector<uint8_t>(body, body_length) : flatbuffers::Offset<flatbuffers::Vector<uint8_t>>(0);
    sdn::http::FinishHttpResponseBuffer(b, sdn::http::CreateHttpResponse(b, status, headers_vector, body_vector, body_ref_token, body_ref_size));
    return plugin_push_output_ex("response", "HttpResponseAbi.fbs", "$HTR", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "HttpResponse", 0, 0,
                                 b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0 ? 500 : 0;
}
int push_response(uint16_t status, const std::vector<Header>& headers, const std::string& body) {
    return push_response(status, headers, reinterpret_cast<const uint8_t*>(body.data()), body.size());
}

int push_json(uint16_t status, const std::string& body, std::vector<Header> extra = {}) {
    extra.push_back({"content-type", kContentTypeJson});
    return push_response(status, extra, body);
}

int push_json_error(uint16_t status, const std::string& message, const std::string& code) {
    JsonOut j;
    j.begin_object();
    j.key("error");
    j.str(message);
    if (!code.empty()) { j.key("code"); j.str(code); }
    j.end_object();
    return push_json(status, j.s);
}

// One FlatBuffer record verbatim.
int push_record(uint16_t status, const plugin_input_frame_t* frame, const char* identifier, std::vector<Header> extra = {}) {
    extra.push_back({"content-type", kContentTypeFlatBuffer});
    extra.push_back({"x-sdn-file-identifier", identifier});
    return push_response(status, extra, frame->payload, frame->payload_length);
}

const char* reason_of(uint16_t status) {
    switch (status) {
        case 400: return "bad request";
        case 404: return "not found";
        case 405: return "method not allowed";
        case 406: return "not acceptable";
        case 422: return "unprocessable";
        case 502: return "bad gateway";
        case 503: return "service unavailable";
        default: return "error";
    }
}

// The HTTP status of a $QRP refusal: HTTP_STATUS when the deciding node set it, else derived from the stable ERROR_CODE.
uint16_t status_of(const QRP* q) {
    if (q->HTTP_STATUS() >= 400 && q->HTTP_STATUS() <= 599) return q->HTTP_STATUS();  // the deciding node said
    if (q->STATUS() == qrpStatus_Busy || q->STATUS() == qrpStatus_Cold) return 503;
    const std::string code = q->ERROR_CODE() ? q->ERROR_CODE()->str() : std::string();
    if (code == "no-route" || code == "not-found") return 404;
    if (code == "method-not-allowed") return 405;
    if (code == "not-acceptable") return 406;
    if (code == "timeout" || code == "too-large") return 422;
    if (code == "host-failed") return 502;
    if (code == "unavailable") return 503;
    return 400;
}

template <typename T, bool (*Verify)(flatbuffers::Verifier&), const T* (*Get)(const void*)>
const T* verified(const plugin_input_frame_t* frame, std::vector<uint8_t>* scratch) {
    if (!frame) return nullptr;
    scratch->assign(frame->payload, frame->payload + frame->payload_length);  // aligned copy for the verifier
    flatbuffers::Verifier verifier(scratch->data(), scratch->size());
    return Verify(verifier) ? Get(scratch->data()) : nullptr;
}

// The answer's own entity tag equals the client's -> 304.
bool not_modified(const flatbuffers::String* client_tag, const flatbuffers::String* etag) {
    return client_tag && etag && etag->size() > 0 && client_tag->string_view() == etag->string_view();
}

// APR RESPONSE_HEADERS: headers a serving stage asks the answer to carry (cache freshness, last-modified, ...).
// Deliberately narrow: names lower-cased, CR/LF stripped from name and value (no header or body injection), the names
// this node computes itself refused rather than overridden, at most 16, values cut at 1 KiB.
void append_response_headers(const APR* apr, std::vector<Header>* out) {
    const auto* list = apr->RESPONSE_HEADERS();
    if (!list) return;
    size_t added = 0;
    for (const auto* h : *list) {
        if (added >= 16) break;
        if (!h || !h->NAME()) continue;
        std::string name, value;
        for (const char c : h->NAME()->string_view()) {
            if (c == '\r' || c == '\n' || c == ':') continue;
            name.push_back(c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c);
        }
        if (h->VALUE()) for (const char c : h->VALUE()->string_view()) {
            if (c == '\r' || c == '\n') continue;
            if (value.size() >= 1024) break;
            value.push_back(c);
        }
        if (name.empty() || name == "content-type" || name == "etag" || name == "x-sdn-record-count" || name == "x-sdn-file-identifier" ||
            name == "retry-after") continue;
        out->push_back({name, value});
        added++;
    }
}

int push_not_modified(const std::string& etag) { return push_response(304, {{"etag", etag}}, nullptr, 0); }

}  // namespace

extern "C" {

// respond: $APR decision (+ at most one typed body) -> one $HTR.
int respond(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof batch_message)) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    std::vector<uint8_t> decision_scratch;
    const plugin_input_frame_t* decision_frame = find_input("decision");
    const APR* apr = verified<APR, VerifyAPRBuffer, GetAPR>(decision_frame, &decision_scratch);
    if (!apr) {
        plugin_set_error(decision_frame ? "invalid-decision-frame" : "missing-decision-frame",
                         "respond requires an $APR decision on port \"decision\".");
        return 400;
    }

    // The body: one record, or a dataset (its $DAV and the records on its standard's port).
    struct Body { const char* port; const char* identifier; };
    static const Body kBodies[] = {{"status", "$NHS"}, {"activity", "$NEV"}, {"peers", "$NST"}, {"notices", "$PNV"}, {"availability", "$DAV"}};
    const Body* body = nullptr;
    const plugin_input_frame_t* body_frame = nullptr;
    for (const Body& candidate : kBodies) {
        if (const plugin_input_frame_t* f = find_input(candidate.port)) {
            if (body_frame) {
                plugin_set_error("ambiguous-body", "respond received bodies on more than one port; one decision has one answer.");
                return 500;
            }
            body = &candidate;
            body_frame = f;
        }
    }
    const plugin_input_frame_t* records_frame = nullptr;
    for (const char* port : kRecordPorts) {
        if (const plugin_input_frame_t* f = find_input(port)) {
            if (records_frame) {
                plugin_set_error("ambiguous-body", "respond received record streams on more than one *_records port.");
                return 500;
            }
            records_frame = f;
        }
    }
    if (records_frame && (!body || std::strcmp(body->port, "availability") != 0)) {
        plugin_set_error("records-without-availability", "a dataset's records arrive with its $DAV on \"availability\".");
        return 500;
    }

    const aprRepresentation accept = apr->ACCEPT();
    const bool json = accept == aprRepresentation_Json;
    const uint16_t refused = apr->STATUS();
    const std::string error_code = apr->ERROR_CODE() ? apr->ERROR_CODE()->str() : std::string();
    const std::string error_message = apr->ERROR_MESSAGE() && apr->ERROR_MESSAGE()->size()
                                          ? apr->ERROR_MESSAGE()->str() : std::string(reason_of(refused ? refused : 502));

    if (accept != aprRepresentation_Default && accept != aprRepresentation_FlatBuffer && !json) {
        return push_json_error(406, std::string("representation ") + EnumNameaprRepresentation(accept) +
                                        " is not available; request format=json or format=flatbuffer", "not-acceptable");
    }

    // 1. A refusal without a body answers itself.
    if (refused && !body_frame) {
        std::vector<Header> extra;
        append_response_headers(apr, &extra);
        if (json) {
            JsonOut j;
            j.begin_object();
            j.key("error"); j.str(error_message);
            if (!error_code.empty()) { j.key("code"); j.str(error_code); }
            j.end_object();
            return push_json(refused, j.s, extra);
        }
        return push_record(refused, decision_frame, "$APR", extra);
    }
    if (!body_frame) {
        if (json) return push_json_error(502, "the serving node answered without a body", "missing-body");
        APRT copy;
        apr->UnPackTo(&copy);
        copy.STATUS = 502;
        copy.ERROR_CODE = "missing-body";
        copy.ERROR_MESSAGE = "the serving node answered without a body";
        flatbuffers::FlatBufferBuilder b(512);
        FinishAPRBuffer(b, APR::Pack(b, &copy));
        return push_response(502, {{"content-type", kContentTypeFlatBuffer}, {"x-sdn-file-identifier", "$APR"}}, b.GetBufferPointer(), b.GetSize());
    }
    const uint16_t status = refused ? refused : 200;

    // Decode (and verify) the body.
    std::vector<uint8_t> scratch;
    const NHS* nhs = nullptr; const NEV* nev = nullptr; const NST* nst = nullptr; const PNV* pnv = nullptr; const DAV* dav = nullptr;
    const std::string port = body->port;
    if (port == "status") nhs = verified<NHS, VerifyNHSBuffer, GetNHS>(body_frame, &scratch);
    else if (port == "activity") nev = verified<NEV, VerifyNEVBuffer, GetNEV>(body_frame, &scratch);
    else if (port == "peers") nst = verified<NST, VerifyNSTBuffer, GetNST>(body_frame, &scratch);
    else if (port == "notices") pnv = verified<PNV, VerifyPNVBuffer, GetPNV>(body_frame, &scratch);
    else dav = verified<DAV, VerifyDAVBuffer, GetDAV>(body_frame, &scratch);
    if (!nhs && !nev && !nst && !pnv && !dav) {
        const std::string message = std::string("the \"") + body->port + "\" frame is not a valid " + body->identifier + ".";
        plugin_set_error("invalid-body-frame", message.c_str());
        return 400;
    }

    // 2. Conditional request: the answer's own entity tag ($NST / $PNV / $DAV ETAG).
    std::vector<Header> headers;
    append_response_headers(apr, &headers);
    const flatbuffers::String* etag = nst ? nst->ETAG() : pnv ? pnv->ETAG() : dav ? dav->ETAG() : nullptr;
    if (etag && etag->size()) {
        if (!refused && not_modified(apr->IF_NONE_MATCH(), etag)) return push_not_modified(etag->str());
        headers.push_back({"etag", etag->str()});
    }

    // A dataset the serving node holds out of band: the $HTR names the host's body reference, no inline body.
    if (dav && dav->BODY_REF_TOKEN() && !refused) {
        if (records_frame) {
            plugin_set_error("ambiguous-body", "a dataset is either a body reference or inline records, not both.");
            return 500;
        }
        if (json) return push_json_error(502, "the dataset was delivered by reference and cannot be rendered as JSON", "body-ref-unrenderable");
        headers.push_back({"content-type", kContentTypeStream});
        headers.push_back({"x-sdn-record-count", std::to_string(dav->RECORD_COUNT())});
        return push_response(200, headers, nullptr, 0, dav->BODY_REF_TOKEN(), dav->BODY_REF_SIZE());
    }

    // 3. The answer.
    if (json) {
        JsonOut j;
        if (nhs) render_nhs(j, nhs);
        else if (nev) render_nev(j, nev);
        else if (nst) render_nst(j, nst);
        else if (pnv) render_pnv(j, pnv);
        else if (!records_frame) render_dav(j, dav);
        else {
            std::vector<Frame> frames;
            if (!frames_of(records_frame->payload, records_frame->payload_length, 0, &frames)) {
                plugin_set_error("malformed-stream", "the dataset's record stream framing does not parse.");
                return 400;
            }
            std::string why;
            if (!render_records(records_frame->payload, frames, 0, j, &why)) return push_json_error(406, why, "not-acceptable");
            headers.push_back({"x-sdn-record-count", std::to_string(frames.size())});
        }
        return push_json(status, j.s, headers);
    }
    if (!records_frame) return push_record(status, body_frame, body->identifier, headers);

    // A dataset as one stream: its $DAV (re-finished size-prefixed, padded to 8) followed by its records verbatim.
    std::vector<Frame> frames;
    const bool counted = frames_of(records_frame->payload, records_frame->payload_length, 0, &frames);
    DAVT availability;
    dav->UnPackTo(&availability);
    flatbuffers::FlatBufferBuilder b(512);
    FinishSizePrefixedDAVBuffer(b, DAV::Pack(b, &availability));
    std::vector<uint8_t> stream(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
    while (stream.size() % 8) stream.insert(stream.end(), {0, 0, 0, 0});
    stream.insert(stream.end(), records_frame->payload, records_frame->payload + records_frame->payload_length);
    headers.push_back({"content-type", kContentTypeStream});
    if (counted) headers.push_back({"x-sdn-record-count", std::to_string(frames.size())});
    return push_response(status, headers, stream.data(), stream.size());
}

// respond_query: $QRP decision (+ the $QRP page stream) -> one $HTR.
int respond_query(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof batch_message)) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    std::vector<uint8_t> decision_scratch;
    const plugin_input_frame_t* decision_frame = find_input("decision");
    const QRP* decision = verified<QRP, VerifyQRPBuffer, GetQRP>(decision_frame, &decision_scratch);
    if (!decision) {
        plugin_set_error(decision_frame ? "invalid-decision-frame" : "missing-decision-frame",
                         "respond_query requires a $QRP decision on port \"decision\".");
        return 400;
    }
    const bool json = decision->REPRESENTATION() == qrpRepresentation_Json;

    const auto refusal = [&](const QRP* q, const plugin_input_frame_t* as_frame, const uint8_t* bytes, size_t length) {
        const uint16_t status = status_of(q);
        std::vector<Header> headers;
        if (q->RETRY_AFTER_MS()) headers.push_back({"retry-after", std::to_string((q->RETRY_AFTER_MS() + 999) / 1000)});
        if (json) {
            const std::string message = q->MESSAGE() && q->MESSAGE()->size() ? q->MESSAGE()->str() : std::string(reason_of(status));
            JsonOut j;
            j.begin_object();
            j.key("error"); j.str(message);
            if (q->ERROR_CODE() && q->ERROR_CODE()->size()) { j.key("code"); j.str(q->ERROR_CODE()->string_view()); }
            j.end_object();
            return push_json(status, j.s, headers);
        }
        if (as_frame) return push_record(status, as_frame, "$QRP", headers);
        headers.push_back({"content-type", kContentTypeStream});
        return push_response(status, headers, bytes, length);
    };

    // 1. A refusal from the router or the serving node.
    if (decision->KIND() == qrpKind_Error) return refusal(decision, decision_frame, nullptr, 0);

    const plugin_input_frame_t* page_frame = find_input("page");
    if (!page_frame) {
        if (json) return push_json_error(502, "the serving node answered without a page", "missing-page");
        QRPT error;
        decision->UnPackTo(&error);
        error.KIND = qrpKind_Error;
        error.STATUS = qrpStatus_Error;
        error.ERROR_CODE = "host-failed";
        error.MESSAGE = "the serving node answered without a page";
        flatbuffers::FlatBufferBuilder b(512);
        FinishQRPBuffer(b, QRP::Pack(b, &error));
        return push_response(502, {{"content-type", kContentTypeFlatBuffer}, {"x-sdn-file-identifier", "$QRP"}}, b.GetBufferPointer(), b.GetSize());
    }
    const uint8_t* data = page_frame->payload;
    const size_t length = page_frame->payload_length;
    std::vector<Frame> frames;
    std::vector<uint8_t> header_scratch;
    const QRP* header = frames_of(data, length, 0, &frames) && !frames.empty() ? qrp_frame(data, frames[0], &header_scratch) : nullptr;
    if (!header) {
        plugin_set_error("invalid-page", "the page is not a size-prefixed stream headed by a $QRP frame.");
        return 400;
    }
    if (header->KIND() == qrpKind_Error) return refusal(header, nullptr, data, length);

    // 2. Conditional request.
    std::vector<Header> headers;
    if (header->ETAG() && header->ETAG()->size()) {
        if (not_modified(decision->ETAG(), header->ETAG())) return push_not_modified(header->ETAG()->str());
        headers.push_back({"etag", header->ETAG()->str()});
    }
    // What the page carries: the query surface (tables / serving limits), a projection (columns + rows), or records.
    // Records held out of band by the serving node: the $HTR names the reference, no inline body.
    if (header->BODY_REF_TOKEN()) {
        if (json) return push_json_error(502, "the page was delivered by reference and cannot be rendered as JSON", "body-ref-unrenderable");
        headers.push_back({"content-type", kContentTypeStream});
        headers.push_back({"x-sdn-record-count", std::to_string(header->RECORD_COUNT())});
        return push_response(200, headers, nullptr, 0, header->BODY_REF_TOKEN(), header->BODY_REF_SIZE());
    }
    const bool surface = (header->TABLES() && header->TABLES()->size()) || header->MAX_ROWS() || header->MAX_BYTES() || header->MAX_ELAPSED_MS();
    const bool projection = !surface && header->COLUMNS() && header->COLUMNS()->size();
    const size_t record_frames = frames.size() - 1;

    // 3. FlatBuffer: the page stream verbatim.
    if (!json) {
        const size_t count = surface ? (header->TABLES() ? header->TABLES()->size() : 0)
                           : projection ? (header->ROWS() ? header->ROWS()->size() : 0) : record_frames;
        headers.push_back({"content-type", kContentTypeStream});
        headers.push_back({"x-sdn-record-count", std::to_string(count)});
        return push_response(200, headers, data, length);
    }

    // 3. Json.
    JsonOut j;
    if (surface) {
        j.begin_object();
        j.key("TABLES");
        j.begin_array();
        if (const auto* tables = header->TABLES()) {
            for (const auto* t : *tables) {
                j.begin_object();
                J_STR(j, t, NAME); J_STR(j, t, KIND); J_STR(j, t, SOURCE); J_I64(j, t, RECORDS);
                j.key("COLUMNS");
                j.begin_array();
                if (const auto* columns = t->COLUMNS()) {
                    for (const auto* c : *columns) {
                        j.begin_object();
                        J_STR(j, c, NAME); J_STR(j, c, TYPE); J_STR(j, c, UNIT); J_BOOL(j, c, SORTABLE); J_BOOL(j, c, INDEXED);
                        j.end_object();
                    }
                }
                j.end_array();
                j.end_object();
            }
        }
        j.end_array();
        J_U64(j, header, MAX_ELAPSED_MS); J_U64(j, header, MAX_ROWS); J_U64(j, header, MAX_BYTES);
        j.end_object();
        return push_json(200, j.s, headers);
    }
    if (projection) {
        const auto* columns = header->COLUMNS();
        std::vector<std::string> names;
        for (const auto* c : *columns) names.push_back(c && c->NAME() ? c->NAME()->str() : std::string());
        size_t rows = 0;
        j.begin_array();
        if (const auto* row_list = header->ROWS()) {
            for (const auto* row : *row_list) {
                j.begin_object();
                const auto* cells = row ? row->CELLS() : nullptr;
                for (size_t c = 0; c < names.size(); c++) {
                    j.key(names[c].c_str());
                    const QRPValue* v = cells && c < cells->size() ? cells->Get(static_cast<flatbuffers::uoffset_t>(c)) : nullptr;
                    switch (v ? v->KIND() : qrpValueKind_Null) {
                        case qrpValueKind_Bool: j.boolean(v->BOOL_VALUE()); break;
                        case qrpValueKind_Int: j.i64(v->INT_VALUE()); break;
                        case qrpValueKind_Float: j.f64(v->FLOAT_VALUE()); break;
                        case qrpValueKind_Text: j.str(v->TEXT_VALUE()); break;
                        case qrpValueKind_Bytes: j.base64(v->BYTES_VALUE()); break;
                        default: j.null(); break;
                    }
                }
                j.end_object();
                rows++;
            }
        }
        j.end_array();
        headers.push_back({"x-sdn-record-count", std::to_string(rows)});
        return push_json(200, j.s, headers);
    }
    std::string why;
    if (!render_records(data, frames, 1, j, &why)) return push_json_error(406, why, "not-acceptable");
    headers.push_back({"x-sdn-record-count", std::to_string(record_frames)});
    return push_json(200, j.s, headers);
}

}  // extern "C"
