/*
 * data-source/retrieval — engine-native FlatSQL retrieval (typed contracts 1.0).
 *
 * Two methods over the host FlatSQL engine-native retrieval ops, both answering the data-retrieval flow's routes
 * with the SDS $QRP (Query Page) contract:
 *
 *   omm_bulk   — "request" (OPTIONAL) one $QRP KIND Request from foundation/http-route (the "/<code>/bulk" route:
 *                SCHEMA_NAME, SOURCE_NAME, TIME_PROFILE, PROFILE_EPOCH_MS, LIMIT, REPRESENTATION, ETAG = If-None-Match)
 *                -> storage.flatsql_epoch_stream (SDS $PIV: EpochStreamParams; the batch on raw "stream")
 *                -> "decision" (the request verbatim, or a synthesized default Request when the invoke carried none;
 *                   a $QRP KIND Error on failure) + "page" (a $QRP page stream: the size-prefixed KIND Page header,
 *                   then the record frames exactly as the host delivered them).
 *   data_query — "query" one $QRP KIND Request (SQL + typed PARAMETERS)
 *                -> storage.flatsql_query_stream (SDS $PIV: SqlStreamParams, raw "sql", raw "params" tagged SQL values)
 *                -> "decision" + "page", as above.
 *
 * Profile resolution for omm_bulk (defaults are config-driven, not hard-coded): the request's stated fields
 *   > module config (plugin.getConfig: one ModuleConfig, dotted paths "profiles.<SCHEMA>.profile|source|limit|epoch")
 *   > compiled fallback (profile "nearest", limit 50000, epoch = clock.now).
 * TIME_PROFILE Unspecified (the $QRP default) means "not stated": config, then "nearest". The engine's epoch profiles
 * are nearest / as_of / forward (storage.flatsql_epoch_stream). All means every record in the window: it is served by
 * storage.flatsql_query_stream selecting _data from the standard's table, filtered by the source shadow
 * ("<CODE>@<source>") and, for $OMM only, by FROM_EPOCH_MS / TO_EPOCH_MS on USER_DEFINED_EPOCH_TIMESTAMP (a window on
 * another standard, or with a per-object profile, is refused 400 window-unsupported). Latest has no engine profile and
 * is refused (400 invalid-profile).
 *
 * Page header: KIND Page, SCHEMA_NAME (standard code), FILE_IDENTIFIER (from the first record frame), RECORD_COUNT
 * (frames that follow, zero-length padding prefixes skipped), ETAG W/"fnv1a64-<16 hex>" over the record stream bytes
 * (word-folded FNV-1a 64, the gateway's shared algorithm), REPRESENTATION and the resolved request echoed.
 *
 * NOTHING IS TRUNCATED: a value over its hostcall bound (SOURCE 128, SCHEMA 64) is refused with
 * a $QRP Error naming it. Host failures answer a $QRP Error (host-failed 502; an SQL error query-failed 400; no clock
 * for a default epoch unavailable 503), each with QRP HTTP_STATUS set; success pages carry HTTP_STATUS 200.
 *
 * Delivery: a request whose REPRESENTATION is not Json asks the host for DELIVER Ref. A host that answers a BodyRef
 * (REF.TOKEN != 0, no raw stream) keeps the bytes for the egress: the page is then the header ALONE with
 * BODY_REF_TOKEN / BODY_REF_SIZE, RECORD_COUNT = REF.FRAMES and ETAG W/"fnv1a64-<REF.FNV1A64>". A host that ignores Ref
 * answers inline as before. Json requests ask Inline: the responder renders the bytes. No JSON anywhere.
 */

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "QRP_generated.h"  // spacedatastandards.org lib/cpp/QRP/main_generated.h, inlined by build.mjs

namespace {

namespace A = sdn::runtime::Aligned;

constexpr const char* kDefaultSchema = "OMM.fbs";
constexpr const char* kDefaultProfile = "nearest";
constexpr uint32_t kDefaultLimit = 50000;

// ---------------------------------------------------------------------------
// SURPLUS-FRAME REFUSAL — graph task `modules-guest-nodes-drop-batched-frames`.
// The compiled flow runtime drains a node's queue PORT-BLIND (maxStreams/maxBatch are declarative only), so a guest
// that reads ordinal 0 of a port destroys every other frame it was handed there. Each method answers ONE request
// with ONE page; a surplus is refused by name rather than silently dropped.
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
                          "maxStreams is declarative only). The surplus frames are refused "
                          "rather than silently discarded.",
                          on_port, frame->port_id);
            return true;
        }
    }
    return false;
}

const plugin_input_frame_t* frame_for(const char* port) {
    const int32_t idx = plugin_find_input_index(port, 0);
    return idx < 0 ? nullptr : plugin_get_input_frame(static_cast<uint32_t>(idx));
}

uint32_t read_u32le(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) | (static_cast<uint32_t>(p[2]) << 16) |
           (static_cast<uint32_t>(p[3]) << 24);
}

std::string fnv1a64_etag(const uint8_t* data, size_t length) {
    constexpr uint64_t kPrime = 1099511628211ull;
    uint64_t hash = 1469598103934665603ull;
    size_t i = 0;
    for (; i + 8 <= length; i += 8) {
        uint64_t word;
        std::memcpy(&word, data + i, 8);
        hash ^= word;
        hash *= kPrime;
    }
    for (; i < length; i++) {
        hash ^= data[i];
        hash *= kPrime;
    }
    char buf[40];
    std::snprintf(buf, sizeof buf, "W/\"fnv1a64-%016llx\"", static_cast<unsigned long long>(hash));
    return buf;
}

// Walk a size-prefixed record stream: frame count (zero-length padding prefixes skipped) and the first frame's file
// identifier (bytes 4..8 of the record). False when the framing does not parse.
bool scan_stream(std::string_view stream, uint32_t* count, std::string* identifier) {
    *count = 0;
    identifier->clear();
    const auto* data = reinterpret_cast<const uint8_t*>(stream.data());
    size_t at = 0;
    while (at < stream.size()) {
        if (stream.size() - at < 4) return false;
        const uint32_t size = read_u32le(data + at);
        at += 4;
        if (size == 0) continue;
        if (size > stream.size() - at) return false;
        if (*count == 0 && size >= 8) identifier->assign(reinterpret_cast<const char*>(data + at + 4), 4);
        at += size;
        ++*count;
    }
    return true;
}

// "omm.fbs", "$OMM", "OMM" -> "OMM".
std::string code_of(std::string_view schema) {
    if (!schema.empty() && schema.front() == '$') schema.remove_prefix(1);
    if (schema.size() > 4 && schema.substr(schema.size() - 4) == ".fbs") schema.remove_suffix(4);
    std::string out(schema);
    for (char& c : out) if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
    return out;
}

int push_qrp(const char* port, const uint8_t* data, size_t size) {
    return plugin_push_output_ex(port, "QRP.fbs", QRPIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "QRP", 0, 0,
                                 data, static_cast<uint32_t>(size));
}

uint16_t http_status_of(const std::string& code) {
    if (code == "no-route" || code == "not-found") return 404;
    if (code == "method-not-allowed") return 405;
    if (code == "not-acceptable") return 406;
    if (code == "timeout" || code == "too-large") return 422;
    if (code == "host-failed") return 502;
    if (code == "unavailable") return 503;
    return 400;
}

// A $QRP KIND Error on "decision": the request's REPRESENTATION and ETAG carried so the responder can render.
int refuse(const QRPT* request, const char* code, const std::string& message, qrpStatus status = qrpStatus_Error) {
    QRPT error;
    error.KIND = qrpKind_Error;
    error.STATUS = status;
    error.ERROR_CODE = code;
    error.MESSAGE = message;
    error.HTTP_STATUS = http_status_of(code);
    if (request) {
        error.REPRESENTATION = request->REPRESENTATION;
        error.ETAG = request->ETAG;
        error.SCHEMA_NAME = request->SCHEMA_NAME;
    }
    flatbuffers::FlatBufferBuilder b(256 + message.size());
    FinishQRPBuffer(b, QRP::Pack(b, &error));
    return push_qrp("decision", b.GetBufferPointer(), b.GetSize()) < 0 ? 500 : 0;
}

// "decision" (the request) + "page" (size-prefixed header + the record stream verbatim).
int answer(const uint8_t* decision, size_t decision_size, QRPT& header, std::string_view stream) {
    uint32_t count = 0;
    std::string identifier;
    if (!scan_stream(stream, &count, &identifier)) {
        return refuse(&header, "host-failed", "the host answered a record stream whose size-prefixed framing does not parse");
    }
    header.KIND = qrpKind_Page;
    header.STATUS = qrpStatus_Ok;
    header.ERROR_CODE.clear();
    header.MESSAGE.clear();
    if (!identifier.empty()) header.FILE_IDENTIFIER = identifier;
    if (header.SCHEMA_NAME.empty() && !identifier.empty()) header.SCHEMA_NAME = code_of(identifier);
    header.RECORD_COUNT = count;
    header.ETAG = fnv1a64_etag(reinterpret_cast<const uint8_t*>(stream.data()), stream.size());
    header.SQL.clear();
    header.PARAMETERS.clear();
    header.HTTP_STATUS = 200;

    flatbuffers::FlatBufferBuilder b(512);
    FinishSizePrefixedQRPBuffer(b, QRP::Pack(b, &header));
    std::vector<uint8_t> page(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
    if (page.size() % 8) page.resize(page.size() + 4, 0);  // a zero-length prefix: padding, skipped by readers
    page.insert(page.end(), stream.begin(), stream.end());

    if (push_qrp("decision", decision, decision_size) < 0) return 500;
    return push_qrp("page", page.data(), page.size()) < 0 ? 500 : 0;
}

// The host kept the bytes (DELIVER Ref): "decision" + "page" = the header ALONE carrying the reference.
int answer_ref(const uint8_t* decision, size_t decision_size, QRPT& header, const A::BodyRef& ref) {
    header.KIND = qrpKind_Page;
    header.STATUS = qrpStatus_Ok;
    header.ERROR_CODE.clear();
    header.MESSAGE.clear();
    header.SQL.clear();
    header.PARAMETERS.clear();
    header.HTTP_STATUS = 200;
    header.BODY_REF_TOKEN = ref.TOKEN;
    header.BODY_REF_SIZE = ref.SIZE;
    if (ref.FRAMES >= 0) header.RECORD_COUNT = static_cast<uint32_t>(ref.FRAMES);
    if (ref.has_FNV1A64() && ref.FNV1A64.length) header.ETAG = "W/\"fnv1a64-" + ref.FNV1A64.str() + "\"";
    flatbuffers::FlatBufferBuilder b(512);
    FinishSizePrefixedQRPBuffer(b, QRP::Pack(b, &header));
    if (push_qrp("decision", decision, decision_size) < 0) return 500;
    return push_qrp("page", b.GetBufferPointer(), b.GetSize()) < 0 ? 500 : 0;
}

// A stream answer: by reference when the host kept the bytes, else inline.
int answer_stream(const uint8_t* decision, size_t decision_size, QRPT& header, const sdm_piv::Response& response) {
    const std::string_view stream = response.raw("stream");
    const auto* result = response.result<A::StreamResult>("StreamResult");
    if (stream.empty() && result && result->has_REF() && result->REF.TOKEN != 0) {
        return answer_ref(decision, decision_size, header, result->REF);
    }
    return answer(decision, decision_size, header, stream);
}

A::deliverMode deliver_for(const QRPT& request) {
    return request.REPRESENTATION == qrpRepresentation_Json ? A::deliverMode_Inline : A::deliverMode_Ref;
}

bool sql_error(const sdm_piv::Response& response) {
    return response.error_code() == "invalid-params" || response.error_message().find("SQL error") != std::string::npos;
}

// ---------------------------------------------------------------------------
// omm_bulk profile resolution.
// ---------------------------------------------------------------------------

struct EpochQuery {
    std::string schema = kDefaultSchema;
    std::string source;
    bool has_source = false;
    std::string profile;
    double epoch = 0.0;
    bool has_epoch = false;
    uint32_t limit = 0;
};

// plugin.getConfig: one ModuleConfig (MCFG), read in place by dotted path. The schema name itself carries a dot
// ("OMM.fbs"); the SDK's lookup tries the longest key before each dot first, so "profiles.OMM.fbs.profile" resolves
// whether the host nests {"profiles": {"OMM.fbs": {...}}} or keeps the flattened key.
void apply_config(EpochQuery* q, bool stated_profile, bool stated_source, bool stated_limit, bool stated_epoch) {
    const sdm_piv::Config config = sdm_piv::get_config();
    if (!config.ok()) return;  // config absent -> compiled fallbacks
    using K = sdn::runtime::configValueKind;
    const std::string prefix = "profiles." + q->schema + ".";
    const auto is = [&](const char* field, K kind) {
        const std::string key = prefix + field;
        return config.has(key) && config.kind(key) == kind;
    };
    if (!stated_profile && is("profile", sdn::runtime::configValueKind_String)) {
        const std::string_view v = config.string(prefix + "profile");
        if (!v.empty()) q->profile = std::string(v);
    }
    if (!stated_source && is("source", sdn::runtime::configValueKind_String)) {
        q->source = std::string(config.string(prefix + "source"));
        q->has_source = true;
    }
    if (!stated_limit && is("limit", sdn::runtime::configValueKind_Number)) {
        const double n = config.number(prefix + "limit");
        if (n > 0) q->limit = n >= 4294967295.0 ? 4294967295u : static_cast<uint32_t>(n);
    }
    if (!stated_epoch && is("epoch", sdn::runtime::configValueKind_Number)) {
        q->epoch = config.number(prefix + "epoch");
        q->has_epoch = true;
    }
}

const char* profile_name(qrpTimeProfile p) {
    switch (p) {
        case qrpTimeProfile_Nearest: return "nearest";
        case qrpTimeProfile_AsOf: return "as_of";
        case qrpTimeProfile_Forward: return "forward";
        default: return nullptr;
    }
}
qrpTimeProfile profile_enum(const std::string& name) {
    std::string p = name.rfind("epoch.", 0) == 0 ? name.substr(6) : name;
    if (p == "nearest") return qrpTimeProfile_Nearest;
    if (p == "as_of") return qrpTimeProfile_AsOf;
    if (p == "forward") return qrpTimeProfile_Forward;
    if (p == "latest") return qrpTimeProfile_Latest;
    if (p == "all") return qrpTimeProfile_All;
    return qrpTimeProfile_Unspecified;
}

// A request frame on `port`: verified and unpacked; nullptr (with the error set) when it is not a $QRP Request.
bool read_request(const plugin_input_frame_t* frame, QRPT* out, const char* method) {
    flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!QRPBufferHasIdentifier(frame->payload) || !VerifyQRPBuffer(verifier)) {
        const std::string m = std::string(method) + ": the input frame is not a $QRP buffer.";
        plugin_set_error("invalid-request-frame", m.c_str());
        return false;
    }
    GetQRP(frame->payload)->UnPackTo(out);
    return true;
}

}  // namespace

extern "C" {

int omm_bulk(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof batch_message)) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    QRPT request;
    const plugin_input_frame_t* frame = frame_for("request");
    const bool has_request = frame && frame->payload && frame->payload_length > 0;
    if (has_request && !read_request(frame, &request, "omm_bulk")) return 400;
    if (has_request && request.KIND != qrpKind_Request) {
        // A refusal routed here is passed on untouched: the responder answers it.
        return push_qrp("decision", frame->payload, frame->payload_length) < 0 ? 500 : 0;
    }

    EpochQuery q;
    if (!request.SCHEMA_NAME.empty()) q.schema = code_of(request.SCHEMA_NAME) + ".fbs";
    const bool stated_source = !request.SOURCE_NAME.empty();
    if (stated_source) { q.source = request.SOURCE_NAME; q.has_source = true; }
    const bool stated_profile = request.TIME_PROFILE != qrpTimeProfile_Unspecified;
    if (request.TIME_PROFILE == qrpTimeProfile_Latest) {
        return refuse(&request, "invalid-profile",
                      "TIME_PROFILE Latest has no engine epoch profile (nearest, as_of or forward)");
    }
    if (stated_profile) q.profile = request.TIME_PROFILE == qrpTimeProfile_All ? "all" : profile_name(request.TIME_PROFILE);
    const bool stated_epoch = request.PROFILE_EPOCH_MS != 0;
    if (stated_epoch) { q.epoch = static_cast<double>(request.PROFILE_EPOCH_MS) / 1000.0; q.has_epoch = true; }
    const bool stated_limit = request.LIMIT > 0;
    if (stated_limit) q.limit = request.LIMIT;

    apply_config(&q, stated_profile, stated_source, stated_limit, stated_epoch);
    if (q.profile.empty()) q.profile = kDefaultProfile;
    if (q.limit == 0) q.limit = kDefaultLimit;
    const qrpTimeProfile resolved_profile = profile_enum(q.profile);
    if (resolved_profile == qrpTimeProfile_Unspecified || resolved_profile == qrpTimeProfile_Latest) {
        return refuse(&request, "invalid-profile",
                      "configured profile \"" + q.profile + "\" is not an engine epoch profile (nearest, as_of, forward or all)");
    }
    const bool windowed = request.FROM_EPOCH_MS != 0 || request.TO_EPOCH_MS != 0;
    const std::string code = code_of(q.schema);
    if (windowed && (resolved_profile != qrpTimeProfile_All || code != "OMM")) {
        return refuse(&request, "window-unsupported",
                      resolved_profile != qrpTimeProfile_All
                          ? "an epoch window (FROM_EPOCH_MS / TO_EPOCH_MS) selects with TIME_PROFILE All, not a per-object profile"
                          : "an epoch window is served for $OMM only (USER_DEFINED_EPOCH_TIMESTAMP); " + code + " has no epoch column here");
    }

    // The decision: the request verbatim, or the default Request this invoke resolved when none came.
    QRPT header;
    if (has_request) GetQRP(frame->payload)->UnPackTo(&header);
    header.SCHEMA_NAME = code;
    header.FILE_IDENTIFIER = "$" + code;
    header.TIME_PROFILE = resolved_profile;
    header.LIMIT = q.limit;
    header.SOURCE_NAME = q.source;
    flatbuffers::FlatBufferBuilder synthesized(256);
    const uint8_t* decision = has_request ? frame->payload : nullptr;
    size_t decision_size = has_request ? frame->payload_length : 0;
    const auto synthesize = [&]() {
        if (has_request) return;
        QRPT stated;
        stated.KIND = qrpKind_Request;
        stated.SCHEMA_NAME = header.SCHEMA_NAME;
        stated.FILE_IDENTIFIER = header.FILE_IDENTIFIER;
        stated.SOURCE_NAME = header.SOURCE_NAME;
        stated.TIME_PROFILE = header.TIME_PROFILE;
        stated.PROFILE_EPOCH_MS = header.PROFILE_EPOCH_MS;
        stated.LIMIT = header.LIMIT;
        FinishQRPBuffer(synthesized, QRP::Pack(synthesized, &stated));
        decision = synthesized.GetBufferPointer();
        decision_size = synthesized.GetSize();
    };

    if (resolved_profile == qrpTimeProfile_All) {
        // Every record of the lane in the window: the standard's table, filtered by the source shadow.
        std::string sql = "SELECT _data FROM \"" + code + "\" WHERE (?1 = '' OR _source = ?1)";
        const std::string shadow = q.source.empty() ? std::string() : code + "@" + q.source;
        sdm_piv::SqlValues values;
        values.str(shadow);
        int next = 2;
        if (request.FROM_EPOCH_MS != 0) {
            sql += " AND USER_DEFINED_EPOCH_TIMESTAMP >= ?" + std::to_string(next++);
            values.f64(static_cast<double>(request.FROM_EPOCH_MS) / 1000.0);
        }
        if (request.TO_EPOCH_MS != 0) {
            sql += " AND USER_DEFINED_EPOCH_TIMESTAMP <= ?" + std::to_string(next++);
            values.f64(static_cast<double>(request.TO_EPOCH_MS) / 1000.0);
        }
        sql += " LIMIT ?" + std::to_string(next);
        values.i64(q.limit);

        A::SqlStreamParams params{};
        params.DELIVER = deliver_for(request);
        const std::vector<sdm_piv::Frame> frames{
            {"params", reinterpret_cast<const uint8_t*>(&params), sizeof params, "SqlStreamParams",
             static_cast<uint32_t>(sizeof params), static_cast<uint16_t>(alignof(A::SqlStreamParams))},
            sdm_piv::raw("sql", sql),
            values.frame(),
        };
        const auto response = sdm_piv::call_frames("storage.flatsql_query_stream", frames);
        if (!response.ok()) {
            std::string message = response.error_message();
            if (message.empty()) message = "storage.flatsql_query_stream hostcall failed";
            if (sql_error(response)) return refuse(&request, "query-failed", message);
            return refuse(&request, "host-failed", response.error_code() + ": " + message);
        }
        header.PROFILE_EPOCH_MS = 0;
        synthesize();
        return answer_stream(decision, decision_size, header, response);
    }

    if (!q.has_epoch) {
        const auto now = sdm_piv::call("clock.now");
        const auto* value = now.ok() ? now.result<A::TimeValue>("TimeValue") : nullptr;
        if (!value) {
            return refuse(&request, "unavailable", "clock.now failed while defaulting the query epoch: " + now.error_message());
        }
        q.epoch = static_cast<double>(value->UNIX_MS) / 1000.0;
        q.has_epoch = true;
    }

    A::EpochStreamParams params{};
    const auto over = [&](const char* field, size_t size, size_t bound) {
        return refuse(&request, "invalid-parameter",
                      std::string(field) + " is " + std::to_string(size) + " bytes; storage.flatsql_epoch_stream holds at most " +
                          std::to_string(bound) + " - refused rather than truncated");
    };
    if (!sdm_piv::put(params.SCHEMA, q.schema)) return over("SCHEMA", q.schema.size(), 64);
    params.set_has_SCHEMA(true);
    if (!q.source.empty()) {
        if (!sdm_piv::put(params.SOURCE, q.source)) return over("SOURCE_NAME", q.source.size(), 128);
        params.set_has_SOURCE(true);
    }
    sdm_piv::put(params.PROFILE, q.profile);
    params.set_has_PROFILE(true);
    params.EPOCH = q.epoch;
    params.LIMIT = q.limit;
    params.DELIVER = deliver_for(request);

    const auto response = sdm_piv::call("storage.flatsql_epoch_stream", "EpochStreamParams", params);
    if (!response.ok()) {
        std::string message = response.error_message();
        if (message.empty()) message = "storage.flatsql_epoch_stream hostcall failed";
        return refuse(&request, "host-failed", response.error_code() + ": " + message);
    }

    header.PROFILE_EPOCH_MS = static_cast<int64_t>(std::llround(q.epoch * 1000.0));
    synthesize();
    return answer_stream(decision, decision_size, header, response);
}

int data_query(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof batch_message)) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const plugin_input_frame_t* frame = frame_for("query");
    if (!frame || !frame->payload || frame->payload_length == 0) {
        plugin_set_error("missing-query-frame", "data_query requires a $QRP Request on port \"query\".");
        return 400;
    }
    QRPT request;
    if (!read_request(frame, &request, "data_query")) return 400;
    if (request.KIND != qrpKind_Request) {
        return push_qrp("decision", frame->payload, frame->payload_length) < 0 ? 500 : 0;
    }
    if (request.SQL.empty()) return refuse(&request, "missing-sql", "data_query requires SQL");

    // QRPValue -> FlatSQL's tagged parameter encoding (raw "params"): text and bytes of any length travel as they are.
    sdm_piv::SqlValues values;
    for (size_t i = 0; i < request.PARAMETERS.size(); i++) {
        const QRPValueT* v = request.PARAMETERS[i].get();
        switch (v ? v->KIND : qrpValueKind_Null) {
            case qrpValueKind_Bool: values.boolean(v->BOOL_VALUE); break;
            case qrpValueKind_Int: values.i64(v->INT_VALUE); break;
            case qrpValueKind_Float: values.f64(v->FLOAT_VALUE); break;
            case qrpValueKind_Text: values.str(v->TEXT_VALUE); break;
            case qrpValueKind_Bytes: values.bytes(v->BYTES_VALUE.data(), v->BYTES_VALUE.size()); break;
            default: values.null(); break;
        }
    }

    A::SqlStreamParams params{};
    params.DELIVER = deliver_for(request);
    std::vector<sdm_piv::Frame> frames{
        {"params", reinterpret_cast<const uint8_t*>(&params), sizeof params, "SqlStreamParams",
         static_cast<uint32_t>(sizeof params), static_cast<uint16_t>(alignof(A::SqlStreamParams))},
        sdm_piv::raw("sql", request.SQL),
    };
    if (!request.PARAMETERS.empty()) frames.push_back(values.frame());
    const auto response = sdm_piv::call_frames("storage.flatsql_query_stream", frames);
    if (!response.ok()) {
        std::string message = response.error_message();
        if (message.empty()) message = "storage.flatsql_query_stream hostcall failed";
        if (sql_error(response)) return refuse(&request, "query-failed", message);
        return refuse(&request, "host-failed", response.error_code() + ": " + message);
    }

    QRPT header;
    GetQRP(frame->payload)->UnPackTo(&header);
    header.SCHEMA_NAME.clear();  // from the first record frame
    return answer_stream(frame->payload, frame->payload_length, header, response);
}

}  // extern "C"
