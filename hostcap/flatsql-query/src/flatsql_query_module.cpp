/*
 * hostcap/flatsql-query — the host FlatSQL query connector (typed contracts 1.0).
 *
 *   query — the FlatSQL node's query_records contract (flatsql cpp/src/sdn_node.cpp), served over the host bridge:
 *           "query"   ONE $FSO control frame: OPERATION QUERY_RECORDS, QUERY (SQL bytes), PARAMETERS in FlatSQL's
 *                     tagged encoding ([u8 tag][u32le size][bytes] x PARAMETER_COUNT; tags 0 null, 1 bool, 2 int64,
 *                     3 float64, 4 string, 5 bytes), REQUEST_ID.
 *        -> storage.flatsql_query_stream (SDS $PIV: SqlStreamParams{DELIVER Inline}, raw "sql", raw "params" = the
 *           validated PARAMETERS verbatim, FlatSQL's own tagged encoding) -> StreamResult{ROWS, COLUMNS} + raw "stream"
 *           (the aligned size-prefixed result stream).
 *        -> "records" $FSB chunks (KIND QUERY_RESULT, DATA <= 1 MiB each, CHUNK_SEQUENCE 0.., FINAL on the last, at
 *           least one chunk), then "status" ONE $FSO (STATUS COMPLETE, AFFECTED_RECORDS rows, RESULT_BYTES). A
 *           database-semantics failure (bad control frame, a malformed parameter, a refused or failed
 *           query) answers on "status" alone, invoke status 0 — exactly as the FlatSQL node does.
 *
 *   sandbox_query — the PUBLIC /api/v1/query surface:
 *           "query"   a QRP Request (SQL + PARAMETERS, SORT_FIELD/SORT_DESC, LIMIT, or a TIME_PROFILE over the unified
 *                     OMM view with PROFILE_EPOCH_MS / SOURCE_NAME), or
 *           "surface" a QRP Request for the queryable-surface listing. Exactly one carries a frame.
 *        -> storage.query_sandboxed (READ-ONLY; the engine enforces the sandbox in-wasm) / storage.query_surface
 *        -> "decision" the QRP request verbatim (or a QRP Error) + "page" one QRP-headed size-prefixed stream: the
 *           page header then the record frames verbatim (KIND Stream), a projection page (COLUMNS + ROWS) or the
 *           surface page (TABLES + MAX_*). Composition of the effective SQL (profile SQL, sort/limit wrap) happens
 *           HERE, never on the host. TIME_PROFILE Unspecified = no profile (SQL required); Nearest / AsOf / Forward =
 *           the engine-native per-object profiles; All = every unified-OMM-view record of the source, optionally in the
 *           FROM_EPOCH_MS / TO_EPOCH_MS window (a window anywhere else is refused 400 window-unsupported). Every QRP
 *           Error carries HTTP_STATUS; pages carry 200. Delivery: a non-Json request asks DELIVER Ref; a host BodyRef
 *           answer makes the page the header ALONE with BODY_REF_TOKEN / BODY_REF_SIZE (the egress resolves it), a
 *           host that ignores Ref answers inline; Json requests ask Inline (the responder renders the bytes).
 *
 * No JSON and no base64 anywhere.
 */

#include <algorithm>
#include <cstdint>
#include <memory>
#include <cstdio>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "FSO_generated.h"  // spacedatastandards.org lib/cpp/FSO/main_generated.h, inlined by build.mjs
#include "FSB_generated.h"  // spacedatastandards.org lib/cpp/FSB/main_generated.h, inlined by build.mjs
#include "QRP_generated.h"  // spacedatastandards.org lib/cpp/QRP/main_generated.h, inlined by build.mjs

namespace {

namespace A = sdn::runtime::Aligned;

constexpr size_t kFsbChunkCapacity = 1024u * 1024u;  // FSB.DATA aligned_max_count, as the FlatSQL node chunks

const plugin_input_frame_t* frame_for(const char* port) {
    const int32_t idx = plugin_find_input_index(port, 0);
    return idx < 0 ? nullptr : plugin_get_input_frame(static_cast<uint32_t>(idx));
}

// SURPLUS-FRAME REFUSAL — graph task `modules-guest-nodes-drop-batched-frames`. The compiled flow runtime fills an
// invocation by popping the node's queue PORT-BLIND (drain budget 64); maxStreams is declarative only. Each method
// here answers ONE request, so a second frame on a port is refused by name rather than silently destroyed.
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

uint32_t read_u32le(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) | (static_cast<uint32_t>(p[2]) << 16) |
           (static_cast<uint32_t>(p[3]) << 24);
}

// FNV-1a 64, word-folded (8-byte little-endian words, then the tail bytes) — the gateway's entity-tag algorithm
// (legacy foundation/decision-gate and discovery-shape), so equal streams carry equal tags everywhere.
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
    std::snprintf(buf, sizeof(buf), "W/\"fnv1a64-%016llx\"", static_cast<unsigned long long>(hash));
    return buf;
}

// ---------------------------------------------------------------------------------------------------------------------
// query: FSO in, FSB chunks + FSO status out.
// ---------------------------------------------------------------------------------------------------------------------

int push_status(uint64_t request_id, flatSqlNodeStatus status, uint64_t affected, uint64_t result_bytes,
                const char* error_code, const std::string& message) {
    flatbuffers::FlatBufferBuilder b(256 + message.size());
    const auto code = error_code && error_code[0] ? b.CreateString(error_code) : flatbuffers::Offset<flatbuffers::String>();
    const auto msg = message.empty() ? flatbuffers::Offset<flatbuffers::Vector<uint8_t>>()
                                     : b.CreateVector(reinterpret_cast<const uint8_t*>(message.data()), message.size());
    FSOBuilder fso(b);
    fso.add_OPERATION(flatSqlNodeOperation_QUERY_RECORDS);
    fso.add_REQUEST_ID(request_id);
    fso.add_STATUS(status);
    fso.add_AFFECTED_RECORDS(affected);
    fso.add_RESULT_BYTES(result_bytes);
    if (!code.IsNull()) fso.add_ERROR_CODE(code);
    if (!msg.IsNull()) fso.add_MESSAGE(msg);
    FinishFSOBuffer(b, fso.Finish());
    const int32_t pushed = plugin_push_output_ex("status", "FSO.fbs", FSOIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                                 "FSO", 0, 0, b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize()));
    return pushed < 0 ? 500 : 0;
}

bool push_chunk(uint64_t request_id, uint32_t sequence, bool final, uint64_t total_bytes, uint64_t rows, uint32_t columns,
                const uint8_t* data, size_t size) {
    flatbuffers::FlatBufferBuilder b(size + 256);
    const auto body = size ? b.CreateVector(data, size) : flatbuffers::Offset<flatbuffers::Vector<uint8_t>>();
    FSBBuilder fsb(b);
    fsb.add_REQUEST_ID(request_id);
    fsb.add_KIND(flatSqlByteStreamKind_QUERY_RESULT);
    fsb.add_CHUNK_SEQUENCE(sequence);
    fsb.add_FINAL(final);
    fsb.add_TOTAL_BYTES(total_bytes);
    fsb.add_RECORD_COUNT(rows);
    fsb.add_COLUMN_COUNT(columns);
    if (!body.IsNull()) fsb.add_DATA(body);
    FinishFSBBuffer(b, fsb.Finish());
    return plugin_push_output_ex("records", "FSB.fbs", FSBIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "FSB", 0, 0,
                                 b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) >= 0;
}

// FlatSQL's tagged parameter encoding, validated as the FlatSQL node does: PARAMETER_COUNT values, each a known tag with
// its fixed payload size, and nothing left over. The bytes then travel verbatim on raw "params" (text and bytes of any
// length). `code` names a refusal.
bool validate_tagged(const flatbuffers::Vector<uint8_t>* data, uint32_t count, std::string* code, std::string* why) {
    const size_t length = data ? data->size() : 0;
    const uint8_t* p = data ? data->data() : nullptr;
    if (count == 0) {
        if (length != 0) { *code = "invalid-control-frame"; *why = "PARAMETERS carries bytes but PARAMETER_COUNT is 0"; return false; }
        return true;
    }
    size_t at = 0;
    for (uint32_t i = 0; i < count; i++) {
        if (length - at < 5) { *code = "invalid-control-frame"; *why = "Malformed query parameter payload"; return false; }
        const uint8_t tag = p[at];
        const uint32_t size = read_u32le(p + at + 1);
        at += 5;
        if (length - at < size) { *code = "invalid-control-frame"; *why = "Malformed query parameter payload"; return false; }
        switch (tag) {
            case sdm_piv::kSqlNull:
                if (size != 0) { *code = "invalid-control-frame"; *why = "NULL parameter payload must be empty"; return false; }
                break;
            case sdm_piv::kSqlBool:
                if (size != 1) { *code = "invalid-control-frame"; *why = "Boolean parameter payload must be 1 byte"; return false; }
                break;
            case sdm_piv::kSqlI64:
                if (size != 8) { *code = "invalid-control-frame"; *why = "Integer parameter payload must be 8 bytes"; return false; }
                break;
            case sdm_piv::kSqlF64:
                if (size != 8) { *code = "invalid-control-frame"; *why = "Float parameter payload must be 8 bytes"; return false; }
                break;
            case sdm_piv::kSqlStr:
            case sdm_piv::kSqlBytes:
                break;
            default:
                *code = "invalid-control-frame";
                *why = "Unsupported query parameter tag";
                return false;
        }
        at += size;
    }
    if (at != length) { *code = "invalid-control-frame"; *why = "Malformed query parameter payload"; return false; }
    return true;
}

flatSqlNodeStatus status_for_host_error(const std::string& code) {
    if (code == "timeout" || code == "too-large") return flatSqlNodeStatus_RESOURCE_EXHAUSTED;
    if (code == "invalid-params" || code == "sandbox" || code == "refused" || code == "not-authorized") return flatSqlNodeStatus_INVALID_ARGUMENT;
    return flatSqlNodeStatus_INTERNAL_ERROR;
}

// ---------------------------------------------------------------------------------------------------------------------
// sandbox_query: QRP in, QRP decision + QRP page stream out.
// ---------------------------------------------------------------------------------------------------------------------

// Engine-native epoch profile SQL over the unified OMM view — byte-identical to sdn-server
// internal/storage/engine_records.go and data-source/retrieval. ?1 source shadow ('' = all), ?2 epoch unix seconds,
// ?3 limit.
constexpr const char* kPQEpochNearestSQL =
    "SELECT _data FROM (SELECT _data, ROW_NUMBER() OVER (PARTITION BY NORAD_CAT_ID ORDER BY "
    "ABS(USER_DEFINED_EPOCH_TIMESTAMP - ?2)) rn FROM OMM WHERE (?1 = '' OR _source = ?1)) WHERE "
    "rn = 1 LIMIT ?3";
constexpr const char* kPQEpochAsOfSQL =
    "SELECT _data FROM (SELECT _data, ROW_NUMBER() OVER (PARTITION BY NORAD_CAT_ID ORDER BY "
    "USER_DEFINED_EPOCH_TIMESTAMP DESC) rn FROM OMM WHERE (?1 = '' OR _source = ?1) AND "
    "USER_DEFINED_EPOCH_TIMESTAMP <= ?2) WHERE rn = 1 LIMIT ?3";
constexpr const char* kPQEpochForwardSQL =
    "SELECT _data FROM (SELECT _data, ROW_NUMBER() OVER (PARTITION BY NORAD_CAT_ID ORDER BY "
    "USER_DEFINED_EPOCH_TIMESTAMP ASC) rn FROM OMM WHERE (?1 = '' OR _source = ?1) AND "
    "USER_DEFINED_EPOCH_TIMESTAMP >= ?2) WHERE rn = 1 LIMIT ?3";
constexpr int64_t kPQDefaultProfileLimit = 50000;

bool valid_sort_column(const std::string& col) {
    if (col.empty()) return false;
    for (char c : col) {
        const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '@';
        if (!ok) return false;
    }
    return true;
}

struct QrpContext {
    qrpRepresentation representation = qrpRepresentation_Default;
    std::string etag;
};

int push_qrp(const char* port, flatbuffers::FlatBufferBuilder& b) {
    return plugin_push_output_ex(port, "QRP.fbs", QRPIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "QRP", 0, 0,
                                 b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0 ? 500 : 0;
}

// The request could not be served: one QRP Error on "decision" (REPRESENTATION and ETAG carried over for the
// responder), no page.
uint16_t http_status_of(const std::string& code) {
    if (code == "no-route" || code == "not-found") return 404;
    if (code == "method-not-allowed") return 405;
    if (code == "not-acceptable") return 406;
    if (code == "timeout" || code == "too-large" || code == "row-cap" || code == "byte-cap") return 422;
    if (code == "host-failed") return 502;
    if (code == "unavailable") return 503;
    return 400;
}

int refuse(const QrpContext& ctx, const std::string& code, const std::string& message) {
    QRPT err;
    err.HTTP_STATUS = http_status_of(code);
    err.KIND = qrpKind_Error;
    err.STATUS = qrpStatus_Error;
    err.ERROR_CODE = code;
    err.MESSAGE = message;
    err.REPRESENTATION = ctx.representation;
    err.ETAG = ctx.etag;
    flatbuffers::FlatBufferBuilder b(256 + message.size());
    FinishQRPBuffer(b, QRP::Pack(b, &err));
    return push_qrp("decision", b);
}

// The page stream: the size-prefixed QRP header frame (padded to 8 bytes with a zero-length prefix when needed), then
// `records` verbatim.
int push_page(const QRPT& header, const uint8_t* records, size_t records_length) {
    flatbuffers::FlatBufferBuilder b(1024);
    FinishSizePrefixedQRPBuffer(b, QRP::Pack(b, &header));
    std::vector<uint8_t> stream(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
    while (stream.size() % 8) stream.push_back(0);  // zero-length prefix = padding (size is a multiple of 4)
    if (records_length) stream.insert(stream.end(), records, records + records_length);
    return plugin_push_output_ex("page", "QRP.fbs", QRPIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "QRP", 0, 0,
                                 stream.data(), static_cast<uint32_t>(stream.size())) < 0 ? 500 : 0;
}

// The ETag of a header-only page (projection, surface): FNV over the header built without an ETag (no timestamps, so
// equal answers carry equal tags).
std::string header_etag(const QRPT& header) {
    flatbuffers::FlatBufferBuilder b(1024);
    FinishQRPBuffer(b, QRP::Pack(b, &header));
    return fnv1a64_etag(b.GetBufferPointer(), b.GetSize());
}

int push_decision_verbatim(const plugin_input_frame_t* frame) {
    return plugin_push_output_ex("decision", "QRP.fbs", QRPIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "QRP", 0, 0,
                                 frame->payload, frame->payload_length) < 0 ? 500 : 0;
}

// Count the size-prefixed frames of a record stream (zero-length prefixes are padding); the first frame's file
// identifier comes back in `identifier`.
uint32_t count_frames(const uint8_t* data, size_t length, std::string* identifier) {
    uint32_t count = 0;
    size_t at = 0;
    while (length - at >= 4) {
        const uint32_t size = read_u32le(data + at);
        at += 4;
        if (size == 0) continue;
        if (size > length - at) break;
        if (count == 0 && size >= 8 && identifier) identifier->assign(reinterpret_cast<const char*>(data + at + 4), 4);
        at += size;
        count++;
    }
    return count;
}

std::unique_ptr<QRPValueT> value_of(const sdm_piv::SqlValue& cell) {
    auto v = std::make_unique<QRPValueT>();
    switch (cell.tag) {
        case sdm_piv::kSqlBool: v->KIND = qrpValueKind_Bool; v->BOOL_VALUE = cell.as_bool(); break;
        case sdm_piv::kSqlI64: v->KIND = qrpValueKind_Int; v->INT_VALUE = cell.as_i64(); break;
        case sdm_piv::kSqlF64: v->KIND = qrpValueKind_Float; v->FLOAT_VALUE = cell.as_f64(); break;
        case sdm_piv::kSqlStr: v->KIND = qrpValueKind_Text; v->TEXT_VALUE = std::string(cell.payload); break;
        case sdm_piv::kSqlBytes:
            v->KIND = qrpValueKind_Bytes;
            v->BYTES_VALUE.assign(reinterpret_cast<const uint8_t*>(cell.payload.data()),
                                  reinterpret_cast<const uint8_t*>(cell.payload.data()) + cell.payload.size());
            break;
        default: v->KIND = qrpValueKind_Null; break;
    }
    return v;
}

// QRPValue -> the tagged SQL value (any kind, any length).
void sql_value_of(const QRPValue& in, sdm_piv::SqlValues* out) {
    switch (in.KIND()) {
        case qrpValueKind_Bool: out->boolean(in.BOOL_VALUE()); break;
        case qrpValueKind_Int: out->i64(in.INT_VALUE()); break;
        case qrpValueKind_Float: out->f64(in.FLOAT_VALUE()); break;
        case qrpValueKind_Text: out->str(in.TEXT_VALUE() ? in.TEXT_VALUE()->string_view() : std::string_view()); break;
        case qrpValueKind_Bytes:
            if (in.BYTES_VALUE()) out->bytes(in.BYTES_VALUE()->data(), in.BYTES_VALUE()->size());
            else out->bytes(nullptr, 0);
            break;
        default: out->null(); break;
    }
}

int serve_surface(const plugin_input_frame_t* frame, const QRP& request, const QrpContext& ctx) {
    const auto response = sdm_piv::call("storage.query_surface");
    if (!response.ok()) {
        const std::string message = response.error_message();
        return refuse(ctx, "host-failed", message.empty() ? "query surface unavailable" : message);
    }
    const auto* limits = response.result<A::QuerySurfaceLimits>("QuerySurfaceLimits");
    const auto [tables, table_count] = response.list<A::SurfaceTable>("tables", "SurfaceTable");
    const auto [columns, column_count] = response.list<A::SurfaceColumn>("columns", "SurfaceColumn");

    QRPT page;
    page.KIND = qrpKind_Page;
    page.HTTP_STATUS = 200;
    page.REPRESENTATION = request.REPRESENTATION();
    if (limits) {
        page.MAX_ELAPSED_MS = limits->TIMEOUT_MS;
        page.MAX_ROWS = limits->MAX_ROWS;
        page.MAX_BYTES = limits->MAX_BYTES;
    }
    for (size_t t = 0; t < table_count; t++) {
        auto table = std::make_unique<QRPTableT>();
        table->NAME = tables[t].NAME.str();
        table->KIND = tables[t].KIND.str();
        table->SOURCE = tables[t].SOURCE.str();
        table->RECORDS = tables[t].RECORDS;
        for (size_t c = 0; c < column_count; c++) {
            if (columns[c].TABLE.str() != table->NAME) continue;
            // A PLACEHOLDER column exists only for the engine's >=1-column invariant (a one-byte read of slot 0, never
            // the field's value). QRPColumn cannot mark it, so it is not advertised: `_data` is the honest column.
            if (columns[c].PLACEHOLDER) continue;
            auto column = std::make_unique<QRPColumnT>();
            column->NAME = columns[c].NAME.str();
            table->COLUMNS.push_back(std::move(column));
        }
        page.TABLES.push_back(std::move(table));
    }
    page.ETAG = header_etag(page);
    if (push_decision_verbatim(frame) != 0) return 500;
    return push_page(page, nullptr, 0);
}

int serve_query(const plugin_input_frame_t* frame, const QRP& request, const QrpContext& ctx) {
    const std::string sql = request.SQL() ? request.SQL()->str() : std::string();
    const qrpTimeProfile profile = request.TIME_PROFILE();
    std::string effective_sql;
    sdm_piv::SqlValues params;
    size_t param_count = 0;
    double epoch_s = 0;

    const bool windowed = request.FROM_EPOCH_MS() != 0 || request.TO_EPOCH_MS() != 0;
    const bool every_record = profile == qrpTimeProfile_All;
    const bool per_object = !every_record && profile != qrpTimeProfile_Unspecified;
    if (windowed && !(every_record && sql.empty())) {
        return refuse(ctx, "window-unsupported",
                      "an epoch window (FROM_EPOCH_MS / TO_EPOCH_MS) selects with TIME_PROFILE All over the unified OMM view, "
                      "not with SQL or a per-object profile");
    }
    if (every_record) {
        // Every unified-OMM-view record of the source, in the window when one is stated.
        if (!sql.empty()) return refuse(ctx, "ambiguous-query", "request carries both sql and profile — send one");
        const std::string source = request.SOURCE_NAME() ? request.SOURCE_NAME()->str() : std::string();
        const std::string shadow = source.empty() ? std::string() : "OMM@" + source;
        params.str(shadow);
        param_count = 1;
        effective_sql = "SELECT _data FROM OMM WHERE (?1 = '' OR _source = ?1)";
        if (request.FROM_EPOCH_MS() != 0) {
            params.f64(static_cast<double>(request.FROM_EPOCH_MS()) / 1000.0);
            effective_sql += " AND USER_DEFINED_EPOCH_TIMESTAMP >= ?" + std::to_string(++param_count);
        }
        if (request.TO_EPOCH_MS() != 0) {
            params.f64(static_cast<double>(request.TO_EPOCH_MS()) / 1000.0);
            effective_sql += " AND USER_DEFINED_EPOCH_TIMESTAMP <= ?" + std::to_string(++param_count);
        }
        params.i64(request.LIMIT() > 0 ? static_cast<int64_t>(request.LIMIT()) : kPQDefaultProfileLimit);
        effective_sql += " LIMIT ?" + std::to_string(++param_count);
    } else if (per_object) {
        const char* profile_sql = profile == qrpTimeProfile_Nearest ? kPQEpochNearestSQL
                                  : profile == qrpTimeProfile_AsOf  ? kPQEpochAsOfSQL
                                  : profile == qrpTimeProfile_Forward ? kPQEpochForwardSQL
                                                                      : nullptr;
        if (!profile_sql) {
            return refuse(ctx, "invalid-profile",
                          std::string("unsupported profile: ") + EnumNameqrpTimeProfile(profile) + " (nearest | as_of | forward)");
        }
        if (!sql.empty()) return refuse(ctx, "ambiguous-query", "request carries both sql and profile — send one");
        epoch_s = static_cast<double>(request.PROFILE_EPOCH_MS()) / 1000.0;
        if (request.PROFILE_EPOCH_MS() == 0) {
            const auto now = sdm_piv::call("clock.now");
            const auto* value = now.ok() ? now.result<A::TimeValue>("TimeValue") : nullptr;
            if (!value) return refuse(ctx, "host-failed", "clock unavailable for default epoch: " + now.error_message());
            epoch_s = static_cast<double>(value->UNIX_MS) / 1000.0;
        }
        const std::string source = request.SOURCE_NAME() ? request.SOURCE_NAME()->str() : std::string();
        // ?1 is the source SHADOW-TABLE name: the unified view's _source carries "OMM@<source>".
        const std::string shadow = source.empty() ? std::string() : "OMM@" + source;
        params.str(shadow).f64(epoch_s).i64(request.LIMIT() > 0 ? static_cast<int64_t>(request.LIMIT()) : kPQDefaultProfileLimit);
        param_count = 3;
        effective_sql = profile_sql;
    } else {
        if (sql.empty()) return refuse(ctx, "missing-sql", "public query requires sql or profile");
        if (const auto* in = request.PARAMETERS()) {
            for (flatbuffers::uoffset_t i = 0; i < in->size(); i++) sql_value_of(*in->Get(i), &params);
            param_count = in->size();
        }
        effective_sql = sql;
        const std::string sort = request.SORT_FIELD() ? request.SORT_FIELD()->str() : std::string();
        if (!sort.empty() || request.LIMIT() > 0) {
            effective_sql = "SELECT * FROM (" + sql + ")";
            if (!sort.empty()) {
                if (!valid_sort_column(sort)) {
                    return refuse(ctx, "invalid-sort", "invalid sort: expected \"COLUMN [ASC|DESC]\" (column chars A-Za-z0-9_@)");
                }
                effective_sql += " ORDER BY \"" + sort + "\"";
                if (request.SORT_DESC()) effective_sql += " DESC";
            }
            if (request.LIMIT() > 0) effective_sql += " LIMIT " + std::to_string(request.LIMIT());
        }
    }

    const bool want_json = request.REPRESENTATION() == qrpRepresentation_Json;
    A::SandboxQueryParams sp{};
    sp.WANT = want_json ? A::sandboxWant_Auto : A::sandboxWant_Stream;
    sp.DELIVER = want_json ? A::deliverMode_Inline : A::deliverMode_Ref;
    std::vector<sdm_piv::Frame> frames{
        {"params", reinterpret_cast<const uint8_t*>(&sp), sizeof sp, "SandboxQueryParams", static_cast<uint32_t>(sizeof sp),
         static_cast<uint16_t>(alignof(A::SandboxQueryParams))},
        sdm_piv::raw("sql", effective_sql),
    };
    if (param_count) frames.push_back(params.frame());
    const auto response = sdm_piv::call_frames("storage.query_sandboxed", frames);

    if (!response.ok()) {
        const std::string code = response.error_code();
        std::string message = response.error_message();
        if (message.empty()) message = "sandboxed query failed";
        if (code == "timeout") return refuse(ctx, "timeout", message);
        if (code == "too-large") return refuse(ctx, "too-large", message);
        // The engine's own rejection code: the node answers every sandbox rejection with the hostcall code "sandbox"
        // and its engine message "sandbox: <code>: <detail>" (flatsqlrt.SandboxError). That code is the public one:
        // timeout and row-cap / byte-cap are 422, the statement refusals (not-authorized, multi-statement,
        // empty-statement, read-only, not-select, params) are 400.
        if (code == "sandbox") {
            const std::string_view prefix = "sandbox: ";
            const size_t colon = message.rfind(prefix, 0) == 0 ? message.find(':', prefix.size()) : std::string::npos;
            const std::string engine_code = colon == std::string::npos ? std::string() : message.substr(prefix.size(), colon - prefix.size());
            if (engine_code == "timeout" || engine_code == "row-cap" || engine_code == "byte-cap" || engine_code == "not-authorized" ||
                engine_code == "multi-statement" || engine_code == "empty-statement" || engine_code == "read-only" ||
                engine_code == "not-select" || engine_code == "params") {
                return refuse(ctx, engine_code, message);
            }
        }
        if (message.find("not-a-record-stream") != std::string::npos) {
            return refuse(ctx, "not-acceptable", message + " — request format=json for projection results");
        }
        if (code == "sandbox" || code == "invalid-params" || code == "refused" || code == "not-authorized" ||
            message.find("SQL error") != std::string::npos) {
            return refuse(ctx, "query-failed", message);
        }
        return refuse(ctx, "host-failed", message);
    }
    const auto* result = response.result<A::SandboxQueryResult>("SandboxQueryResult");

    QRPT page;
    page.KIND = qrpKind_Page;
    page.HTTP_STATUS = 200;
    page.REPRESENTATION = request.REPRESENTATION();
    page.TIME_PROFILE = profile;
    if (request.SOURCE_NAME()) page.SOURCE_NAME = request.SOURCE_NAME()->str();
    page.LIMIT = request.LIMIT();
    page.FROM_EPOCH_MS = request.FROM_EPOCH_MS();
    page.TO_EPOCH_MS = request.TO_EPOCH_MS();
    if (per_object) page.PROFILE_EPOCH_MS = static_cast<int64_t>(epoch_s * 1000.0 + 0.5);
    if ((per_object || every_record) && page.LIMIT == 0) page.LIMIT = static_cast<uint32_t>(kPQDefaultProfileLimit);

    if (result && result->KIND == A::sandboxWant_Rows) {
        const auto [names, name_count] = response.list<A::TextValue>("columns", "TextValue");
        std::vector<sdm_piv::SqlValue> cells;
        if (!sdm_piv::read_sql_values(response.raw("cells"), cells)) {
            return refuse(ctx, "host-failed", "storage.query_sandboxed answered malformed raw \"cells\" (tagged SQL values)");
        }
        const size_t cell_count = cells.size();
        for (size_t c = 0; c < name_count; c++) {
            auto column = std::make_unique<QRPColumnT>();
            column->NAME = names[c].VALUE.str();
            page.COLUMNS.push_back(std::move(column));
        }
        const size_t width = name_count ? name_count : (result->COLUMNS ? result->COLUMNS : 1);
        for (size_t at = 0; at + width <= cell_count; at += width) {
            auto row = std::make_unique<QRPRowT>();
            for (size_t c = 0; c < width; c++) row->CELLS.push_back(value_of(cells[at + c]));
            page.ROWS.push_back(std::move(row));
        }
        page.TOTAL_COUNT = page.ROWS.size();
        page.ETAG = header_etag(page);
        if (push_decision_verbatim(frame) != 0) return 500;
        return push_page(page, nullptr, 0);
    }

    const std::string_view stream = response.raw("stream");
    if (stream.empty() && result && result->has_REF() && result->REF.TOKEN != 0) {
        // The host kept the bytes for the egress (DELIVER Ref): the page is the header alone, carrying the reference.
        const A::BodyRef& ref = result->REF;
        page.BODY_REF_TOKEN = ref.TOKEN;
        page.BODY_REF_SIZE = ref.SIZE;
        if (ref.FRAMES >= 0) page.RECORD_COUNT = static_cast<uint32_t>(ref.FRAMES);
        if (ref.has_FNV1A64() && ref.FNV1A64.length) page.ETAG = "W/\"fnv1a64-" + ref.FNV1A64.str() + "\"";
        if (per_object || every_record) {
            page.FILE_IDENTIFIER = "$OMM";
            page.SCHEMA_NAME = "OMM";
        }
        page.TOTAL_COUNT = result->ROWS;
        if (push_decision_verbatim(frame) != 0) return 500;
        return push_page(page, nullptr, 0);
    }
    const auto* bytes = reinterpret_cast<const uint8_t*>(stream.data());
    std::string identifier;
    page.RECORD_COUNT = count_frames(bytes, stream.size(), &identifier);
    if (!identifier.empty()) {
        page.FILE_IDENTIFIER = identifier;
        page.SCHEMA_NAME = identifier[0] == '$' ? identifier.substr(1) : identifier;
    } else if (per_object || every_record) {
        page.FILE_IDENTIFIER = "$OMM";
        page.SCHEMA_NAME = "OMM";
    }
    page.TOTAL_COUNT = result ? result->ROWS : page.RECORD_COUNT;
    page.ETAG = fnv1a64_etag(bytes, stream.size());
    if (push_decision_verbatim(frame) != 0) return 500;
    return push_page(page, bytes, stream.size());
}

}  // namespace

extern "C" {

int query(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const plugin_input_frame_t* frame = frame_for("query");
    if (!frame || !frame->payload || frame->payload_length == 0) return push_status(0, flatSqlNodeStatus_INVALID_ARGUMENT, 0, 0, "invalid-control-frame", "missing FSO control payload");
    flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!VerifyFSOBuffer(verifier)) return push_status(0, flatSqlNodeStatus_INVALID_ARGUMENT, 0, 0, "invalid-control-frame", "invalid canonical FSO control payload");
    const FSO& control = *GetFSO(frame->payload);
    const uint64_t request_id = control.REQUEST_ID();
    if (control.OPERATION() != flatSqlNodeOperation_QUERY_RECORDS) {
        return push_status(request_id, flatSqlNodeStatus_INVALID_ARGUMENT, 0, 0, "invalid-control-frame", "query_records requires QUERY_RECORDS operation");
    }
    const auto* query_bytes = control.QUERY();
    if (!query_bytes || query_bytes->size() == 0) {
        return push_status(request_id, flatSqlNodeStatus_INVALID_ARGUMENT, 0, 0, "invalid-control-frame", "query_records requires SQL bytes");
    }
    std::string code, why;
    if (!validate_tagged(control.PARAMETERS(), control.PARAMETER_COUNT(), &code, &why)) {
        return push_status(request_id, flatSqlNodeStatus_INVALID_ARGUMENT, 0, 0, code.c_str(), why);
    }

    A::SqlStreamParams sp{};
    sp.DELIVER = A::deliverMode_Inline;
    std::vector<sdm_piv::Frame> frames{
        {"params", reinterpret_cast<const uint8_t*>(&sp), sizeof sp, "SqlStreamParams", static_cast<uint32_t>(sizeof sp),
         static_cast<uint16_t>(alignof(A::SqlStreamParams))},
        sdm_piv::raw("sql", query_bytes->data(), query_bytes->size()),
    };
    if (control.PARAMETER_COUNT() && control.PARAMETERS()) {
        frames.push_back(sdm_piv::raw("params", control.PARAMETERS()->data(), control.PARAMETERS()->size()));
    }
    const auto response = sdm_piv::call_frames("storage.flatsql_query_stream", frames);
    if (!response.ok()) {
        std::string message = response.error_message();
        if (message.empty()) message = "storage.flatsql_query_stream hostcall failed";
        const std::string host_code = response.error_code();
        return push_status(request_id, status_for_host_error(host_code), 0, 0, "query-failed", host_code + ": " + message);
    }
    const auto* result = response.result<A::StreamResult>("StreamResult");
    const uint64_t rows = result ? result->ROWS : 0;
    const uint32_t columns = result ? result->COLUMNS : 0;
    const std::string_view stream = response.raw("stream");
    const auto* data = reinterpret_cast<const uint8_t*>(stream.data());
    const size_t chunks = stream.empty() ? 1 : (stream.size() + kFsbChunkCapacity - 1) / kFsbChunkCapacity;
    for (size_t i = 0; i < chunks; i++) {
        const size_t offset = i * kFsbChunkCapacity;
        const size_t size = stream.empty() ? 0 : std::min(kFsbChunkCapacity, stream.size() - offset);
        if (!push_chunk(request_id, static_cast<uint32_t>(i), i + 1 == chunks, stream.size(), rows, columns,
                        size ? data + offset : nullptr, size)) {
            return 500;
        }
    }
    return push_status(request_id, flatSqlNodeStatus_COMPLETE, rows, stream.size(), nullptr, "FlatSQL query complete");
}

int sandbox_query(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const plugin_input_frame_t* query_frame = frame_for("query");
    const plugin_input_frame_t* surface_frame = frame_for("surface");
    if ((query_frame != nullptr) == (surface_frame != nullptr)) {
        plugin_set_error(query_frame ? "ambiguous-request" : "missing-request-frame",
                         "sandbox_query takes exactly one QRP Request, on \"query\" or on \"surface\".");
        return 400;
    }
    const plugin_input_frame_t* frame = query_frame ? query_frame : surface_frame;
    flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!frame->payload || !VerifyQRPBuffer(verifier)) {
        plugin_set_error("invalid-request-frame", "the request frame is not a $QRP.");
        return 400;
    }
    const QRP& request = *GetQRP(frame->payload);
    QrpContext ctx;
    ctx.representation = request.REPRESENTATION();
    if (request.ETAG()) ctx.etag = request.ETAG()->str();
    if (request.KIND() != qrpKind_Request) {
        plugin_set_error("invalid-request-frame", "sandbox_query serves QRP KIND Request frames only.");
        return 400;
    }
    return surface_frame ? serve_surface(frame, request, ctx) : serve_query(frame, request, ctx);
}

}  // extern "C"
