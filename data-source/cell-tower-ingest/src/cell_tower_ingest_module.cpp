/*
 * data-source/cell-tower-ingest (graph task `mod-cell-tower-ingest-flow`) — typed contracts 1.0: FlatBuffers only,
 * no JSON and no base64 between modules.
 *
 * The INGEST half of the cellular program. `cell-tower-source` is the REQUEST-scoped aggregate: one $HTQ in, one
 * deconflicted $TBS stream straight back to the caller, `capabilities: []`, nothing persisted. That is the right shape
 * for the demo and the wrong shape for ingest, so the ingest-only decisions live here, in a separate plugin, exactly
 * as the credential lane was split into `cell-tower-credentials`. This plugin REUSES `cell-tower-source`'s `parse` and
 * `deconflict` unchanged: decoding a provider body and merging sites are the same operations whether the answer is
 * served or stored, and forking them would fork the deconfliction rules.
 *
 * Methods (every frame a FlatBuffer):
 *   mark_query      TimerTick                              -> $FSO   (read the newest $IRM resume marks)
 *   ingest_plan     TimerTick + $FSB (marks)               -> HttpRequest: ONE ranged chunk; CONTEXT = a size-prefixed
 *                                                             stream [$APR run contract, $IRM job]
 *   ingest_meta     $TBS + HttpResponse + $IRM resume?     -> IngestRequest + $TBS (forwarded) + candidate $IRM
 *                                                          -> FlowNotice Unchanged ONLY on HTTP 304
 *   publish_request IngestResult + IngestRequest + $IRM    -> durable $IRM (storage-write) + publication POST
 *   cache_plan      $HTQ                                   -> $HTQ forwarded (passthrough / tile) or $FSO x2 + $APR
 *   cache_freshness $APR + $FSB (rows) + $FSB (marks)      -> $APR decision + $DAV + $TBS records
 *   tile_plan       $HTQ                                   -> $FSO queries + $APR jobs, or an $APR refusal
 *   tile_meta/tile  $APR + $FSB                            -> $QRP decision + $QRP projection page
 *
 * WHY THE FETCH IS CHUNKED. The Go server host caps an http response body at 4 MiB (hostcap/http-request), so a bulk
 * export is read by HTTP Range strictly under that ceiling, one chunk per tick; the loop's state lives in the durable
 * $IRM mark, never in a guest instance a restart erases.
 *
 * WHY THE MARK ADVANCES WHERE IT DOES. `publish_request` writes the mark from the STORAGE RESULT — never at dispatch:
 * a mark advanced when a chunk is requested turns a crash between fetch and store into permanently skipped rows.
 *
 * NEXT_OFFSET IS A RECORD BOUNDARY. A ranged read ends mid-row; `ingest_meta` corrects backwards to the byte after the
 * last newline in the chunk (a compressed lane takes the decoder's own resume point instead, from parse's `resume`).
 *
 * HTTP 304 NOT MODIFIED IS A SUCCESSFUL RUN WITH NOTHING NEW: one FlowNotice on `unchanged` and nothing on
 * meta/records, so hostcap/storage-ingest never fires, no batch is stored and the mark does not move.
 *
 * FAIL LOUDLY ON THE SILENT NOP: INSERTED 0 for a chunk that carried records is byte-identical to a healthy empty
 * tail, so it is checked against the chunk's own record count and stops the run instead of advancing the mark.
 */

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <string>
#include <string_view>
#include <sys/time.h>
#include <utility>
#include <vector>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"
#include "IngestRequest_generated.h"
#include "IngestResult_generated.h"
#include "FlowNotice_generated.h"

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

namespace {

namespace R = sdn::runtime;
namespace A = sdn::runtime::Aligned;
namespace H = sdn::http;

using Bytes = std::vector<uint8_t>;

// The Go host caps an http response body at 4 MiB; 3 MiB leaves headroom.
constexpr long kDefaultChunkBytes = 3L * 1024L * 1024L;
constexpr long kMaxChunkBytes = 4L * 1024L * 1024L;
constexpr long kDefaultTimeoutMs = 90000;
constexpr const char* kSchemaName = "TBS.fbs";
constexpr const char* kTargetStandard = "$TBS";
constexpr const char* kIngestorId = "cell-tower-ingest-wasm/v1";
constexpr const char* kParser = "cell-tower-ingest-wasm-v1";
constexpr const char* kParserVersion = "0.2.0";
// The shared decode-context literals (cell-tower-source parse is the authority on the decoder they describe).
constexpr const char* kDecodeFormat = "text/csv";
constexpr const char* kDecoderStateFormat = "cell-tower-source/tinfl-v1";

// THE ENGINE-ROUTED READ FORMS: every embedded standard is served through a generated FlatSQL unified view named by
// its SDS CODE over `_data`/`_rowid` (owner law 2026-08-25).
constexpr const char* kDefaultMarkSql = "SELECT _data FROM IRM ORDER BY _rowid DESC LIMIT ?";
constexpr long kDefaultMarkScanRows = 32;
constexpr const char* kDefaultCacheSql = "SELECT _data FROM TBS ORDER BY _rowid DESC LIMIT ?";
constexpr long kDefaultCacheMaxRows = 5000;

// ── the density-tile contract (graph tasks sdn-cellular-density-tiles / upstream-modules-2) ─────────────────────────
constexpr const char* kTileScheme = "xyz";
constexpr long kTileMinZoom = 0;
constexpr long kTileMaxZoom = 18;
constexpr long kTileThreshold = 2048;  // count <= threshold -> every point
constexpr long kTileBudget = 4096;     // count <= budget -> a deterministic sample; above -> a density grid
constexpr long kTileDensityN = 16;
constexpr double kTileLatClamp = 85.05112878;
constexpr double kTileIndexEpsilon = 1e-9;  // the client's TILE_INDEX_EPSILON verbatim
constexpr const char* kDefaultTileRelation = "TBS";
// THE ROW BUDGET IS THE GUEST'S MEMORY BUDGET: 100,000 whole $TBS rows exceeded a 2048-page mount on the first tile
// request (host-01, 2026-08-27); 25,000 fits.
constexpr long kDefaultTileMaxRows = 25000;
constexpr const char* kTileDataset = "cellular-base-stations";
constexpr const char* kTileNoEpoch = "1970-01-01T00:00:00Z";
constexpr const char* kTileUrlTemplate = "/api/v1/cellular/tiles/{z}/{x}/{y}";
constexpr const char* kTileDeconfliction =
    "Tiles are pre-deconflicted on the node: sites are merged across provider registries before storage, so a tile "
    "never carries the same site twice.";

// ---------------------------------------------------------------------------------------------------------------------
// Time.
// ---------------------------------------------------------------------------------------------------------------------

int64_t now_unix_ms() {
    struct timeval tv;
    if (gettimeofday(&tv, nullptr) != 0) return 0;
    return static_cast<int64_t>(tv.tv_sec) * 1000 + static_cast<int64_t>(tv.tv_usec / 1000);
}

// RFC 3339 UTC fixed-millisecond, as $IRM asks for its timestamps.
std::string iso_ms(int64_t ms) {
    const time_t seconds = static_cast<time_t>(ms / 1000);
    struct tm g;
    gmtime_r(&seconds, &g);
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", g.tm_year + 1900, g.tm_mon + 1, g.tm_mday,
                  g.tm_hour, g.tm_min, g.tm_sec, static_cast<int>(ms % 1000));
    return buf;
}

int64_t days_from_civil(int64_t y, unsigned m, unsigned d) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + static_cast<int64_t>(doe) - 719468;
}

// "YYYY-MM-DDTHH:MM:SS[.fff][Z|+HH:MM]" -> Unix ms; false when it is not one.
bool parse_rfc3339_ms(const std::string& s, int64_t* out) {
    int y = 0, mo = 0, d = 0, h = 0, mi = 0, se = 0;
    if (s.size() < 19 || std::sscanf(s.c_str(), "%4d-%2d-%2dT%2d:%2d:%2d", &y, &mo, &d, &h, &mi, &se) != 6) return false;
    size_t at = 19;
    int64_t frac = 0;
    if (at < s.size() && s[at] == '.') {
        int digits = 0;
        for (at++; at < s.size() && s[at] >= '0' && s[at] <= '9'; at++) {
            if (digits < 3) { frac = frac * 10 + (s[at] - '0'); digits++; }
        }
        while (digits < 3) { frac *= 10; digits++; }
    }
    int64_t offset_min = 0;
    if (at < s.size() && (s[at] == '+' || s[at] == '-')) {
        int oh = 0, om = 0;
        if (std::sscanf(s.c_str() + at + 1, "%2d:%2d", &oh, &om) == 2) offset_min = (oh * 60 + om) * (s[at] == '-' ? -1 : 1);
    }
    const int64_t days = days_from_civil(y, static_cast<unsigned>(mo), static_cast<unsigned>(d));
    *out = ((days * 86400 + h * 3600 + mi * 60 + se) - offset_min * 60) * 1000 + frac;
    return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// Node config: plugin.getConfig as an SDS $PIV hostcall - one ModuleConfig FlatBuffer on raw "config", read in place
// (sdm_piv::Config). No config reads as the defaults.
// ---------------------------------------------------------------------------------------------------------------------

std::string format_number(double v) {
    char buf[40];
    if (v == std::floor(v) && std::fabs(v) < 1e15) std::snprintf(buf, sizeof(buf), "%.0f", v);
    else std::snprintf(buf, sizeof(buf), "%.17g", v);
    return buf;
}

struct Config {
    sdm_piv::Config mcfg;

    // A scalar as text, or a list joined with commas (the operator config always allowed either).
    std::string text(const char* key) const {
        namespace RK = sdn::runtime;
        if (!mcfg.ok() || !mcfg.has(key)) return {};
        switch (mcfg.kind(key)) {
            case RK::configValueKind_String: return std::string(mcfg.string(key));
            case RK::configValueKind_Number: return format_number(mcfg.number(key));
            case RK::configValueKind_Bool: return mcfg.boolean(key) ? "true" : "false";
            case RK::configValueKind_NumberList: {
                std::string joined;
                for (double v : mcfg.numbers(key)) joined += (joined.empty() ? "" : ",") + format_number(v);
                return joined;
            }
            case RK::configValueKind_StringList: {
                std::string joined;
                bool first = true;
                for (std::string_view v : mcfg.strings(key)) { if (!first) joined += ","; joined += v; first = false; }
                return joined;
            }
            default: return {};
        }
    }
    std::string string(const char* key, const char* fallback) const {
        const std::string v = text(key);
        return v.empty() ? fallback : v;
    }
    bool has(const char* key) const { return mcfg.ok() && mcfg.has(key); }
    double number(const char* key, double fallback) const {
        namespace RK = sdn::runtime;
        if (!has(key)) return fallback;
        const RK::configValueKind kind = mcfg.kind(key);
        if (kind == RK::configValueKind_Number) return mcfg.number(key, fallback);
        if (kind == RK::configValueKind_String) {
            const std::string s(mcfg.string(key));
            char* end = nullptr;
            const double v = strtod(s.c_str(), &end);
            if (end != s.c_str()) return v;
        }
        return fallback;
    }
};

Config load_config() { return Config{sdm_piv::get_config()}; }

// The configured chunk size is CLAMPED, not merely defaulted: a 64 MiB ask would be truncated by the host and parse to
// a short row set that looks like a clean tail.
long config_chunk_bytes(const Config& c) {
    const long v = static_cast<long>(c.number("cell_ingest_chunk_bytes", static_cast<double>(kDefaultChunkBytes)));
    if (v <= 0) return kDefaultChunkBytes;
    return v > kMaxChunkBytes ? kMaxChunkBytes : v;
}
long config_timeout_ms(const Config& c) {
    const long v = static_cast<long>(c.number("cell_ingest_http_timeout_ms", static_cast<double>(kDefaultTimeoutMs)));
    return v > 0 ? v : kDefaultTimeoutMs;
}
std::string config_provider(const Config& c) { return c.string("cell_ingest_provider_id", "opencellid"); }

// ---------------------------------------------------------------------------------------------------------------------
// Frame IO.
// ---------------------------------------------------------------------------------------------------------------------

const plugin_input_frame_t* frame_for(const char* port_id) {
    const int32_t index = plugin_find_input_index(port_id, 0);
    if (index < 0) return nullptr;
    return plugin_get_input_frame(static_cast<uint32_t>(index));
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

// SURPLUS-FRAME REFUSAL (graph task modules-guest-nodes-drop-batched-frames). The compiled runtime drains a node's
// queue PORT-BLIND; a guest that read ordinal 0 and returned would destroy the rest silently. Single-stream ports
// refuse a surplus by name; the $FSB ports carry one query's result chunks and take every one.
bool refuse_batched(std::initializer_list<const char*> multi = {}) {
    const uint32_t count = plugin_get_input_count();
    for (uint32_t i = 0; i < count; i++) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        if (!frame || !frame->port_id) continue;
        bool exempt = false;
        for (const char* m : multi) exempt = exempt || std::strcmp(m, frame->port_id) == 0;
        if (exempt) continue;
        uint32_t on_port = 0;
        for (uint32_t k = 0; k < count; k++) {
            const plugin_input_frame_t* f = plugin_get_input_frame(k);
            if (f && f->port_id && std::strcmp(f->port_id, frame->port_id) == 0) on_port++;
        }
        if (on_port > 1) {
            char message[384];
            std::snprintf(message, sizeof(message),
                          "This invocation carries %u frames on single-stream input port \"%s\" (the compiled flow "
                          "runtime drains a node's whole queue port-blind; maxStreams is declarative only). The surplus "
                          "frames are refused rather than silently discarded.",
                          on_port, frame->port_id);
            plugin_set_error("batched-input-frames", message);
            return true;
        }
    }
    return false;
}

int fail(int status, const char* code, const std::string& message) {
    plugin_set_error(code, message.c_str());
    return status;
}

int push(const char* port, const char* schema, const char* id, const char* root, const uint8_t* data, size_t size) {
    return plugin_push_output_ex(port, schema, id, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, data,
                                 static_cast<uint32_t>(size));
}
int push_builder(const char* port, const char* schema, const char* id, const char* root,
                 const flatbuffers::FlatBufferBuilder& b) {
    return push(port, schema, id, root, b.GetBufferPointer(), b.GetSize());
}

// A verified, aligned copy of one plain-finished FlatBuffer (a frame need not sit aligned in its payload).
template <typename T>
const T* verified_copy(const uint8_t* data, size_t size, Bytes* scratch, bool (*verify)(flatbuffers::Verifier&),
                       const T* (*get)(const void*)) {
    if (!data || size < 8) return nullptr;
    scratch->assign(data, data + size);
    flatbuffers::Verifier verifier(scratch->data(), scratch->size());
    return verify(verifier) ? get(scratch->data()) : nullptr;
}

// Walk a size-prefixed stream; zero-length prefixes are padding and skipped. False when the framing is broken.
template <typename F>
bool for_each_frame(const uint8_t* data, size_t size, F&& f) {
    size_t at = 0;
    while (at + 4 <= size) {
        const uint32_t n = static_cast<uint32_t>(data[at]) | (static_cast<uint32_t>(data[at + 1]) << 8) |
                           (static_cast<uint32_t>(data[at + 2]) << 16) | (static_cast<uint32_t>(data[at + 3]) << 24);
        at += 4;
        if (n == 0) continue;
        if (n > size - at) return false;
        if (!f(data + at, static_cast<size_t>(n))) return true;
        at += n;
    }
    return at == size;
}

bool has_identifier(const uint8_t* buf, size_t size, const char* id) {
    return size >= 8 && std::memcmp(buf + 4, id, 4) == 0;
}

void append_size_prefixed(Bytes* stream, const flatbuffers::FlatBufferBuilder& b) {
    // Finished with FinishSizePrefixed: the buffer already carries its prefix. Pad to 8 with zero-length prefixes.
    while (stream->size() % 8) stream->insert(stream->end(), {0, 0, 0, 0});
    stream->insert(stream->end(), b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

// hostcap/flatsql-query's $FSB result chunks on one port, reassembled by CHUNK_SEQUENCE: the host's result stream
// verbatim. `present` says whether any chunk arrived; a malformed chunk is refused.
struct FsbResult {
    bool present = false;
    bool ok = true;
    Bytes data;
};
FsbResult fsb_result(const char* port) {
    FsbResult out;
    std::vector<std::pair<uint32_t, Bytes>> chunks;
    for (const plugin_input_frame_t* f : frames_on(port)) {
        if (!f || !f->payload) continue;
        Bytes scratch;
        const FSB* fsb = verified_copy<FSB>(f->payload, f->payload_length, &scratch, VerifyFSBBuffer, GetFSB);
        if (!fsb) { out.ok = false; return out; }
        out.present = true;
        Bytes data;
        if (fsb->DATA()) data.assign(fsb->DATA()->data(), fsb->DATA()->data() + fsb->DATA()->size());
        chunks.emplace_back(fsb->CHUNK_SEQUENCE(), std::move(data));
    }
    std::sort(chunks.begin(), chunks.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
    for (auto& c : chunks) out.data.insert(out.data.end(), c.second.begin(), c.second.end());
    return out;
}

// One $FSO QUERY_RECORDS frame. Parameters in FlatSQL's tagged encoding ([u8 tag][u32le size][bytes]), written by
// sdm_piv::SqlValues - the same encoding the storage hostcalls take on raw "params".
struct SqlParam {
    uint8_t tag;  // sdm_piv::kSqlI64 or kSqlF64
    int64_t i = 0;
    double f = 0;
};
SqlParam p_i64(int64_t v) { SqlParam p{sdm_piv::kSqlI64}; p.i = v; return p; }
SqlParam p_f64(double v) { SqlParam p{sdm_piv::kSqlF64}; p.f = v; return p; }

int push_fso(const char* port, const std::string& sql, const std::vector<SqlParam>& params) {
    sdm_piv::SqlValues values;
    for (const SqlParam& p : params) {
        if (p.tag == sdm_piv::kSqlI64) values.i64(p.i); else values.f64(p.f);
    }
    const std::string_view tagged = values.view();
    flatbuffers::FlatBufferBuilder b(256 + sql.size() + tagged.size());
    const auto query = b.CreateVector(reinterpret_cast<const uint8_t*>(sql.data()), sql.size());
    const auto parameters = b.CreateVector(reinterpret_cast<const uint8_t*>(tagged.data()), tagged.size());
    FSOBuilder fso(b);
    fso.add_OPERATION(flatSqlNodeOperation_QUERY_RECORDS);
    fso.add_REQUEST_ID(0);
    fso.add_QUERY(query);
    fso.add_PARAMETERS(parameters);
    fso.add_PARAMETER_COUNT(static_cast<uint32_t>(params.size()));
    FinishFSOBuffer(b, fso.Finish());
    return push_builder(port, "FSO.fbs", FSOIdentifier(), "FSO", b) < 0 ? 500 : 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// $HTQ, $APR.
// ---------------------------------------------------------------------------------------------------------------------

const H::HttpRequest* read_htq(const plugin_input_frame_t* frame) {
    if (!frame || !frame->payload || frame->payload_length < 8) return nullptr;
    flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!H::HttpRequestBufferHasIdentifier(frame->payload) || !H::VerifyHttpRequestBuffer(verifier)) return nullptr;
    return H::GetHttpRequest(frame->payload);
}

std::string lower(std::string s) {
    for (char& c : s) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    return s;
}
std::string upper(std::string s) {
    for (char& c : s) if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
    return s;
}

std::string htq_header(const H::HttpRequest* r, const char* name) {
    if (!r || !r->HEADERS()) return std::string();
    for (const auto* h : *r->HEADERS())
        if (h && h->NAME() && lower(h->NAME()->str()) == name) return h->VALUE() ? h->VALUE()->str() : std::string();
    return std::string();
}

std::string url_decode(const std::string& in) {
    std::string out;
    for (size_t i = 0; i < in.size(); i++) {
        if (in[i] == '+') out.push_back(' ');
        else if (in[i] == '%' && i + 2 < in.size()) {
            out.push_back(static_cast<char>(std::strtol(in.substr(i + 1, 2).c_str(), nullptr, 16)));
            i += 2;
        } else out.push_back(in[i]);
    }
    return out;
}

bool query_param(const std::string& query, const char* name, std::string* out) {
    size_t at = 0;
    while (at <= query.size()) {
        size_t end = query.find('&', at);
        if (end == std::string::npos) end = query.size();
        const std::string pair = query.substr(at, end - at);
        const size_t eq = pair.find('=');
        if (url_decode(pair.substr(0, eq)) == name) {
            *out = eq == std::string::npos ? std::string() : url_decode(pair.substr(eq + 1));
            return true;
        }
        at = end + 1;
    }
    return false;
}

// Representation exactly as foundation/http-route decides it: ?format wins, then the Accept header.
aprRepresentation representation_of(const H::HttpRequest* r) {
    std::string f;
    if (r && r->QUERY() && query_param(r->QUERY()->str(), "format", &f)) {
        const std::string v = lower(f);
        if (v == "json") return aprRepresentation_Json;
        if (v == "flatbuffer" || v == "flatbuffers" || v == "fb") return aprRepresentation_FlatBuffer;
        if (!v.empty()) return aprRepresentation_Default;
    }
    const std::string accept = lower(htq_header(r, "accept"));
    if (accept.find("flatbuffers") != std::string::npos) return aprRepresentation_FlatBuffer;
    if (accept.find("application/json") != std::string::npos) return aprRepresentation_Json;
    return aprRepresentation_Default;
}

aprMethod method_of(const std::string& m) {
    if (m == "GET") return aprMethod_GET;
    if (m == "HEAD") return aprMethod_HEAD;
    if (m == "POST") return aprMethod_POST;
    if (m == "PUT") return aprMethod_PUT;
    if (m == "PATCH") return aprMethod_PATCH;
    if (m == "DELETE") return aprMethod_DELETE;
    if (m == "OPTIONS") return aprMethod_OPTIONS;
    return aprMethod_Unspecified;
}

// The normalized request of one $HTQ: the base every run contract and refusal starts from.
APRT apr_from(const H::HttpRequest* r, const char* route) {
    APRT apr;
    apr.RECEIVED_AT_MS = now_unix_ms();
    apr.ROUTE = route;
    apr.SCHEMA_NAME = kSchemaName;
    if (r) {
        apr.METHOD = method_of(upper(r->METHOD() ? r->METHOD()->str() : std::string()));
        apr.PATH = r->PATH() ? r->PATH()->str() : std::string();
        apr.ACCEPT = representation_of(r);
        apr.IF_NONE_MATCH = htq_header(r, "if-none-match");
        apr.CONTENT_TYPE = htq_header(r, "content-type");
    }
    return apr;
}

void add_param(std::vector<std::unique_ptr<APRParameterT>>* list, const std::string& name, const std::string& value) {
    auto p = std::make_unique<APRParameterT>();
    p->NAME = name;
    p->VALUE = value;
    list->push_back(std::move(p));
}

std::string apr_param(const APRT& apr, const char* name, const char* fallback = "") {
    for (const auto& p : apr.PARAMETERS)
        if (p && p->NAME == name) return p->VALUE;
    return fallback;
}

int push_apr(const char* port, const APRT& apr) {
    flatbuffers::FlatBufferBuilder b(512);
    FinishAPRBuffer(b, APR::Pack(b, &apr));
    return push_builder(port, "APR.fbs", APRIdentifier(), "APR", b) < 0 ? 500 : 0;
}

// The one $APR on a single-stream port, unpacked; false (node error set) when absent or not an $APR.
bool read_apr(const char* port, APRT* out, int* status) {
    const plugin_input_frame_t* f = frame_for(port);
    Bytes scratch;
    const APR* apr = f && f->payload ? verified_copy<APR>(f->payload, f->payload_length, &scratch, VerifyAPRBuffer, GetAPR) : nullptr;
    if (!apr) {
        *status = fail(400, f ? "invalid-job-frame" : "missing-job-frame",
                       std::string("this node requires an $APR run contract on port \"") + port + "\".");
        return false;
    }
    apr->UnPackTo(out);
    return true;
}

// The client's own JSON request body (the external representation; parsed here, at the edge, and nowhere between
// modules): REFRESH and LIMIT.
bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }
size_t json_value_at(const std::string& json, const char* key) {
    const std::string needle = std::string("\"") + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return std::string::npos;
    size_t i = json.find(':', k + needle.size());
    if (i == std::string::npos) return std::string::npos;
    for (i++; i < json.size() && is_ws(json[i]); i++) {}
    return i;
}
bool json_bool_or(const std::string& json, const char* key, bool fallback) {
    const size_t i = json_value_at(json, key);
    if (i == std::string::npos) return fallback;
    if (json.compare(i, 4, "true") == 0) return true;
    if (json.compare(i, 5, "false") == 0) return false;
    return fallback;
}
double json_number_or(const std::string& json, const char* key, double fallback) {
    const size_t i = json_value_at(json, key);
    if (i == std::string::npos) return fallback;
    char* end = nullptr;
    const double v = strtod(json.c_str() + i, &end);
    return end == json.c_str() + i ? fallback : v;
}

// ---------------------------------------------------------------------------------------------------------------------
// $IRM — the durable resume mark, mirrored field for field so a mark can be read, advanced and re-written without
// losing a field this build does not touch (IRM has no generated object API).
// ---------------------------------------------------------------------------------------------------------------------

std::string str_of(const flatbuffers::String* s) { return s ? s->str() : std::string(); }
Bytes bytes_of(const flatbuffers::Vector<uint8_t>* v) { return v ? Bytes(v->begin(), v->end()) : Bytes(); }

struct Irm {
    std::string job_id, provider_id, ingestor_id, target_standard, reconcile_mode, merge_policy;
    std::string created_at, started_at, updated_at, completed_at, expires_at, notes;
    std::vector<std::string> tags;
    uint64_t sequence = 0, next_offset = 0, chunk_byte_budget = 0, bytes_committed = 0, records_committed = 0;
    uint32_t next_chunk_index = 0, chunks_committed = 0;
    irmJobState state = irmJobState_UNSPECIFIED;
    irmRangeMode range_mode = irmRangeMode_UNSPECIFIED;
    struct Source {
        std::string url, object_id, cid, media_type, entity_tag, last_modified, sha256, version, validated_at;
        uint64_t total_bytes = 0;
        irmValidatorMatch validator_match = irmValidatorMatch_UNSPECIFIED;
    } source;
    bool has_decode = false;
    struct Decode {
        std::string format, header_line, delimiter, quote, escape, line_terminator, charset, compression;
        std::vector<std::string> column_names;
        uint64_t header_byte_length = 0, decoded_offset = 0;
        Bytes decoder_state, window, partial_record;
        std::string state_format, state_version, state_sha256, build_id, state_media_type;
        uint64_t state_byte_length = 0, window_byte_length = 0, window_position = 0;
    } decode;
    bool has_chunk = false;
    struct Chunk {
        uint32_t index = 0, records_decoded = 0, records_stored = 0, records_rejected = 0, attempts = 0;
        std::string batch_id, sha256, committed_at;
        uint64_t first = 0, last = 0, byte_length = 0;
    } chunk;
    bool has_fault = false;
    struct Fault {
        std::string code, message, occurred_at, retry_not_before;
        uint32_t chunk_index = 0, consecutive_failures = 0;
    } fault;

    void clear_decoder() {
        decode.decoder_state.clear(); decode.window.clear(); decode.partial_record.clear();
        decode.state_format.clear(); decode.state_version.clear(); decode.state_sha256.clear();
        decode.build_id.clear(); decode.state_media_type.clear();
        decode.state_byte_length = decode.window_byte_length = decode.window_position = 0;
        decode.compression.clear();
        decode.decoded_offset = 0;
    }
    bool decode_empty() const {
        return decode.header_line.empty() && decode.decoder_state.empty() && decode.window.empty() &&
               decode.partial_record.empty();
    }
};

Irm irm_read(const IRM& m) {
    Irm o;
    o.job_id = str_of(m.JOB_ID()); o.provider_id = str_of(m.PROVIDER_ID()); o.ingestor_id = str_of(m.INGESTOR_ID());
    o.target_standard = str_of(m.TARGET_STANDARD()); o.reconcile_mode = str_of(m.RECONCILE_MODE());
    o.merge_policy = str_of(m.MERGE_POLICY()); o.created_at = str_of(m.CREATED_AT()); o.started_at = str_of(m.STARTED_AT());
    o.updated_at = str_of(m.UPDATED_AT()); o.completed_at = str_of(m.COMPLETED_AT()); o.expires_at = str_of(m.EXPIRES_AT());
    o.notes = str_of(m.NOTES());
    if (m.TAGS()) for (const auto* t : *m.TAGS()) o.tags.push_back(str_of(t));
    o.sequence = m.SEQUENCE(); o.next_offset = m.NEXT_OFFSET(); o.chunk_byte_budget = m.CHUNK_BYTE_BUDGET();
    o.bytes_committed = m.BYTES_COMMITTED(); o.records_committed = m.RECORDS_COMMITTED();
    o.next_chunk_index = m.NEXT_CHUNK_INDEX(); o.chunks_committed = m.CHUNKS_COMMITTED();
    o.state = m.STATE(); o.range_mode = m.RANGE_MODE();
    if (const IRMSource* s = m.SOURCE()) {
        o.source.url = str_of(s->SOURCE_URL()); o.source.object_id = str_of(s->SOURCE_OBJECT_ID());
        o.source.cid = str_of(s->SOURCE_CID()); o.source.media_type = str_of(s->MEDIA_TYPE());
        o.source.entity_tag = str_of(s->ENTITY_TAG()); o.source.last_modified = str_of(s->LAST_MODIFIED());
        o.source.sha256 = str_of(s->SOURCE_SHA256()); o.source.version = str_of(s->SOURCE_VERSION());
        o.source.validated_at = str_of(s->VALIDATED_AT()); o.source.total_bytes = s->TOTAL_BYTES();
        o.source.validator_match = s->VALIDATOR_MATCH();
    }
    if (const IRMDecodeContext* d = m.DECODE_CONTEXT()) {
        o.has_decode = true;
        auto& x = o.decode;
        x.format = str_of(d->FORMAT()); x.header_line = str_of(d->HEADER_LINE()); x.delimiter = str_of(d->DELIMITER());
        x.quote = str_of(d->QUOTE()); x.escape = str_of(d->ESCAPE()); x.line_terminator = str_of(d->LINE_TERMINATOR());
        x.charset = str_of(d->CHARSET()); x.compression = str_of(d->COMPRESSION());
        if (d->COLUMN_NAMES()) for (const auto* c : *d->COLUMN_NAMES()) x.column_names.push_back(str_of(c));
        x.header_byte_length = d->HEADER_BYTE_LENGTH(); x.decoded_offset = d->DECODED_OFFSET();
        x.decoder_state = bytes_of(d->DECODER_STATE()); x.window = bytes_of(d->WINDOW());
        x.partial_record = bytes_of(d->PARTIAL_RECORD());
        x.state_format = str_of(d->DECODER_STATE_FORMAT()); x.state_version = str_of(d->DECODER_STATE_VERSION());
        x.state_sha256 = str_of(d->DECODER_STATE_SHA256()); x.build_id = str_of(d->DECODER_BUILD_ID());
        x.state_media_type = str_of(d->DECODER_STATE_MEDIA_TYPE());
        x.state_byte_length = d->DECODER_STATE_BYTE_LENGTH(); x.window_byte_length = d->WINDOW_BYTE_LENGTH();
        x.window_position = d->WINDOW_POSITION();
    }
    if (const IRMChunk* c = m.LAST_CHUNK()) {
        o.has_chunk = true;
        auto& x = o.chunk;
        x.index = c->CHUNK_INDEX(); x.batch_id = str_of(c->BATCH_ID()); x.first = c->RANGE_FIRST_BYTE();
        x.last = c->RANGE_LAST_BYTE(); x.byte_length = c->BYTE_LENGTH(); x.sha256 = str_of(c->CHUNK_SHA256());
        x.records_decoded = c->RECORDS_DECODED(); x.records_stored = c->RECORDS_STORED();
        x.records_rejected = c->RECORDS_REJECTED(); x.attempts = c->ATTEMPTS(); x.committed_at = str_of(c->COMMITTED_AT());
    }
    if (const IRMFault* f = m.FAULT()) {
        o.has_fault = true;
        o.fault.code = str_of(f->CODE()); o.fault.message = str_of(f->MESSAGE()); o.fault.occurred_at = str_of(f->OCCURRED_AT());
        o.fault.retry_not_before = str_of(f->RETRY_NOT_BEFORE()); o.fault.chunk_index = f->CHUNK_INDEX();
        o.fault.consecutive_failures = f->CONSECUTIVE_FAILURES();
    }
    return o;
}

using SOff = flatbuffers::Offset<flatbuffers::String>;
SOff opt_str(flatbuffers::FlatBufferBuilder& b, const std::string& s) { return s.empty() ? SOff() : b.CreateString(s); }
flatbuffers::Offset<flatbuffers::Vector<uint8_t>> opt_bytes(flatbuffers::FlatBufferBuilder& b, const Bytes& v) {
    return v.empty() ? flatbuffers::Offset<flatbuffers::Vector<uint8_t>>() : b.CreateVector(v);
}

// Finish an $IRM. `size_prefixed` for a frame inside a CONTEXT stream. Required fields always written.
void irm_write(flatbuffers::FlatBufferBuilder& b, const Irm& m, bool size_prefixed) {
    const auto& s = m.source;
    const SOff s_url = b.CreateString(s.url), s_obj = opt_str(b, s.object_id), s_cid = opt_str(b, s.cid),
               s_media = opt_str(b, s.media_type), s_etag = opt_str(b, s.entity_tag), s_lm = opt_str(b, s.last_modified),
               s_sha = opt_str(b, s.sha256), s_ver = opt_str(b, s.version), s_vat = opt_str(b, s.validated_at);
    IRMSourceBuilder sb(b);
    sb.add_SOURCE_URL(s_url);
    if (!s_obj.IsNull()) sb.add_SOURCE_OBJECT_ID(s_obj);
    if (!s_cid.IsNull()) sb.add_SOURCE_CID(s_cid);
    if (!s_media.IsNull()) sb.add_MEDIA_TYPE(s_media);
    sb.add_TOTAL_BYTES(s.total_bytes);
    if (!s_etag.IsNull()) sb.add_ENTITY_TAG(s_etag);
    if (!s_lm.IsNull()) sb.add_LAST_MODIFIED(s_lm);
    if (!s_sha.IsNull()) sb.add_SOURCE_SHA256(s_sha);
    if (!s_ver.IsNull()) sb.add_SOURCE_VERSION(s_ver);
    sb.add_VALIDATOR_MATCH(s.validator_match);
    if (!s_vat.IsNull()) sb.add_VALIDATED_AT(s_vat);
    const auto source = sb.Finish();

    flatbuffers::Offset<IRMDecodeContext> decode;
    if (m.has_decode) {
        const auto& d = m.decode;
        const SOff fmt = b.CreateString(d.format.empty() ? kDecodeFormat : d.format), hl = opt_str(b, d.header_line),
                   del = opt_str(b, d.delimiter), quo = opt_str(b, d.quote), esc = opt_str(b, d.escape),
                   lt = opt_str(b, d.line_terminator), cs = opt_str(b, d.charset), comp = opt_str(b, d.compression),
                   sf = opt_str(b, d.state_format), sv = opt_str(b, d.state_version), ssha = opt_str(b, d.state_sha256),
                   bid = opt_str(b, d.build_id), smt = opt_str(b, d.state_media_type);
        flatbuffers::Offset<flatbuffers::Vector<SOff>> cols;
        if (!d.column_names.empty()) cols = b.CreateVectorOfStrings(d.column_names);
        const auto ds = opt_bytes(b, d.decoder_state), win = opt_bytes(b, d.window), pr = opt_bytes(b, d.partial_record);
        IRMDecodeContextBuilder db(b);
        db.add_FORMAT(fmt);
        if (!hl.IsNull()) db.add_HEADER_LINE(hl);
        db.add_HEADER_BYTE_LENGTH(d.header_byte_length);
        if (!cols.IsNull()) db.add_COLUMN_NAMES(cols);
        if (!del.IsNull()) db.add_DELIMITER(del);
        if (!quo.IsNull()) db.add_QUOTE(quo);
        if (!esc.IsNull()) db.add_ESCAPE(esc);
        if (!lt.IsNull()) db.add_LINE_TERMINATOR(lt);
        if (!cs.IsNull()) db.add_CHARSET(cs);
        if (!comp.IsNull()) db.add_COMPRESSION(comp);
        db.add_DECODED_OFFSET(d.decoded_offset);
        if (!ds.IsNull()) db.add_DECODER_STATE(ds);
        if (!sf.IsNull()) db.add_DECODER_STATE_FORMAT(sf);
        if (!sv.IsNull()) db.add_DECODER_STATE_VERSION(sv);
        db.add_DECODER_STATE_BYTE_LENGTH(d.state_byte_length);
        if (!ssha.IsNull()) db.add_DECODER_STATE_SHA256(ssha);
        if (!bid.IsNull()) db.add_DECODER_BUILD_ID(bid);
        if (!smt.IsNull()) db.add_DECODER_STATE_MEDIA_TYPE(smt);
        if (!win.IsNull()) db.add_WINDOW(win);
        db.add_WINDOW_BYTE_LENGTH(d.window_byte_length);
        db.add_WINDOW_POSITION(d.window_position);
        if (!pr.IsNull()) db.add_PARTIAL_RECORD(pr);
        decode = db.Finish();
    }

    flatbuffers::Offset<IRMChunk> chunk;
    if (m.has_chunk) {
        const auto& c = m.chunk;
        const SOff bid = opt_str(b, c.batch_id), sha = opt_str(b, c.sha256), cat = opt_str(b, c.committed_at);
        IRMChunkBuilder cb(b);
        cb.add_CHUNK_INDEX(c.index);
        if (!bid.IsNull()) cb.add_BATCH_ID(bid);
        cb.add_RANGE_FIRST_BYTE(c.first);
        cb.add_RANGE_LAST_BYTE(c.last);
        cb.add_BYTE_LENGTH(c.byte_length);
        if (!sha.IsNull()) cb.add_CHUNK_SHA256(sha);
        cb.add_RECORDS_DECODED(c.records_decoded);
        cb.add_RECORDS_STORED(c.records_stored);
        cb.add_RECORDS_REJECTED(c.records_rejected);
        cb.add_ATTEMPTS(c.attempts);
        if (!cat.IsNull()) cb.add_COMMITTED_AT(cat);
        chunk = cb.Finish();
    }

    flatbuffers::Offset<IRMFault> fault;
    if (m.has_fault) {
        const auto& f = m.fault;
        const SOff code = b.CreateString(f.code.empty() ? "unspecified" : f.code), msg = opt_str(b, f.message),
                   occ = opt_str(b, f.occurred_at), rnb = opt_str(b, f.retry_not_before);
        IRMFaultBuilder fb(b);
        fb.add_CODE(code);
        if (!msg.IsNull()) fb.add_MESSAGE(msg);
        fb.add_CHUNK_INDEX(f.chunk_index);
        fb.add_CONSECUTIVE_FAILURES(f.consecutive_failures);
        if (!occ.IsNull()) fb.add_OCCURRED_AT(occ);
        if (!rnb.IsNull()) fb.add_RETRY_NOT_BEFORE(rnb);
        fault = fb.Finish();
    }

    const SOff job = b.CreateString(m.job_id), prov = b.CreateString(m.provider_id), ing = opt_str(b, m.ingestor_id),
               tgt = opt_str(b, m.target_standard), rec = opt_str(b, m.reconcile_mode), mp = opt_str(b, m.merge_policy),
               cat = opt_str(b, m.created_at), sat = opt_str(b, m.started_at),
               uat = b.CreateString(m.updated_at.empty() ? iso_ms(now_unix_ms()) : m.updated_at),
               comp = opt_str(b, m.completed_at), exp = opt_str(b, m.expires_at), notes = opt_str(b, m.notes);
    flatbuffers::Offset<flatbuffers::Vector<SOff>> tags;
    if (!m.tags.empty()) tags = b.CreateVectorOfStrings(m.tags);
    IRMBuilder ib(b);
    ib.add_JOB_ID(job);
    ib.add_SEQUENCE(m.sequence);
    ib.add_PROVIDER_ID(prov);
    if (!ing.IsNull()) ib.add_INGESTOR_ID(ing);
    ib.add_SOURCE(source);
    ib.add_STATE(m.state);
    ib.add_RANGE_MODE(m.range_mode);
    ib.add_NEXT_OFFSET(m.next_offset);
    ib.add_NEXT_CHUNK_INDEX(m.next_chunk_index);
    ib.add_CHUNK_BYTE_BUDGET(m.chunk_byte_budget);
    if (!decode.IsNull()) ib.add_DECODE_CONTEXT(decode);
    if (!chunk.IsNull()) ib.add_LAST_CHUNK(chunk);
    ib.add_CHUNKS_COMMITTED(m.chunks_committed);
    ib.add_BYTES_COMMITTED(m.bytes_committed);
    ib.add_RECORDS_COMMITTED(m.records_committed);
    if (!tgt.IsNull()) ib.add_TARGET_STANDARD(tgt);
    if (!rec.IsNull()) ib.add_RECONCILE_MODE(rec);
    if (!mp.IsNull()) ib.add_MERGE_POLICY(mp);
    if (!fault.IsNull()) ib.add_FAULT(fault);
    if (!cat.IsNull()) ib.add_CREATED_AT(cat);
    if (!sat.IsNull()) ib.add_STARTED_AT(sat);
    ib.add_UPDATED_AT(uat);
    if (!comp.IsNull()) ib.add_COMPLETED_AT(comp);
    if (!exp.IsNull()) ib.add_EXPIRES_AT(exp);
    if (!tags.IsNull()) ib.add_TAGS(tags);
    if (!notes.IsNull()) ib.add_NOTES(notes);
    if (size_prefixed) FinishSizePrefixedIRMBuffer(b, ib.Finish());
    else FinishIRMBuffer(b, ib.Finish());
}

int push_irm(const char* port, const Irm& m) {
    flatbuffers::FlatBufferBuilder b(2048 + m.decode.decoder_state.size() + m.decode.window.size() +
                                     m.decode.partial_record.size() + m.decode.header_line.size());
    irm_write(b, m, false);
    return push_builder(port, "IRM.fbs", IRMIdentifier(), "IRM", b) < 0 ? 500 : 0;
}

bool read_irm_port(const char* port, Irm* out, bool* present, int* status) {
    const plugin_input_frame_t* f = frame_for(port);
    *present = f && f->payload && f->payload_length > 0;
    if (!*present) return true;
    Bytes scratch;
    const IRM* irm = verified_copy<IRM>(f->payload, f->payload_length, &scratch, VerifyIRMBuffer, GetIRM);
    if (!irm) {
        *status = fail(400, "invalid-mark-frame", std::string("the \"") + port + "\" frame is not an $IRM.");
        return false;
    }
    *out = irm_read(*irm);
    return true;
}

// An $IRM frame inside a size-prefixed stream: `rec` is the buffer after its 4-byte prefix. A row stored as a plain
// buffer (the prefix prepended by the stream writer) verifies at `rec`; one finished FinishSizePrefixed is aligned at
// its prefix, and the verifier checks alignment relative to the buffer start, so it verifies as a size-prefixed buffer.
const IRM* verified_irm_frame(const uint8_t* rec, size_t n, Bytes* scratch) {
    if (const IRM* irm = verified_copy<IRM>(rec, n, scratch, VerifyIRMBuffer, GetIRM)) return irm;
    scratch->assign(rec - 4, rec + n);
    flatbuffers::Verifier verifier(scratch->data(), scratch->size());
    if (!VerifySizePrefixedIRMBuffer(verifier)) return nullptr;
    return GetSizePrefixedIRM(scratch->data());
}

// The newest durable mark in a store read (the query orders newest first). `want_provider` empty = any provider; a
// mark belonging to a DIFFERENT provider is skipped, never trusted: resuming provider A at provider B's offset skips
// the head of B's file and never reports it. `frames` / `marks` say what the read held, so a reader can tell "no
// mark" from "rows that are not marks".
struct MarkView {
    bool present = false;
    size_t frames = 0;
    size_t marks = 0;
    Irm irm;
};
MarkView read_mark(const Bytes& stream, const std::string& want_provider) {
    MarkView view;
    for_each_frame(stream.data(), stream.size(), [&](const uint8_t* rec, size_t n) {
        view.frames++;
        if (!has_identifier(rec, n, "$IRM")) return true;
        Bytes scratch;
        const IRM* irm = verified_irm_frame(rec, n, &scratch);
        if (!irm) return true;
        view.marks++;
        const std::string provider = str_of(irm->PROVIDER_ID());
        if (!want_provider.empty() && want_provider != provider) return true;
        view.present = true;
        view.irm = irm_read(*irm);
        return false;
    });
    return view;
}

// ---------------------------------------------------------------------------------------------------------------------
// $QRP pages and decisions (tile lane), $DAV (cache lane).
// ---------------------------------------------------------------------------------------------------------------------

qrpRepresentation qrp_representation(aprRepresentation a) {
    if (a == aprRepresentation_Json) return qrpRepresentation_Json;
    if (a == aprRepresentation_FlatBuffer) return qrpRepresentation_FlatBuffer;
    return qrpRepresentation_Default;
}

int push_qrp_decision(const APRT& job) {
    QRPT q;
    q.KIND = qrpKind_Request;
    q.SCHEMA_NAME = "TBS";
    q.REPRESENTATION = qrp_representation(job.ACCEPT);
    q.ETAG = job.IF_NONE_MATCH;
    flatbuffers::FlatBufferBuilder b(256);
    FinishQRPBuffer(b, QRP::Pack(b, &q));
    return push_builder("decision", "QRP.fbs", QRPIdentifier(), "QRP", b) < 0 ? 500 : 0;
}

void add_column(QRPT* q, const char* name, const char* type) {
    auto c = std::make_unique<QRPColumnT>();
    c->NAME = name;
    c->TYPE = type;
    q->COLUMNS.push_back(std::move(c));
}
std::unique_ptr<QRPValueT> v_text(const std::string& s) { auto v = std::make_unique<QRPValueT>(); v->KIND = qrpValueKind_Text; v->TEXT_VALUE = s; return v; }
std::unique_ptr<QRPValueT> v_int(int64_t i) { auto v = std::make_unique<QRPValueT>(); v->KIND = qrpValueKind_Int; v->INT_VALUE = i; return v; }
std::unique_ptr<QRPValueT> v_float(double f) { auto v = std::make_unique<QRPValueT>(); v->KIND = qrpValueKind_Float; v->FLOAT_VALUE = f; return v; }
std::unique_ptr<QRPValueT> v_bool(bool x) { auto v = std::make_unique<QRPValueT>(); v->KIND = qrpValueKind_Bool; v->BOOL_VALUE = x; return v; }

// The page: the size-prefixed QRP header alone (a projection carries its rows in the header).
int push_qrp_page(const QRPT& header) {
    flatbuffers::FlatBufferBuilder b(1024 + header.ROWS.size() * 64);
    FinishSizePrefixedQRPBuffer(b, QRP::Pack(b, &header));
    Bytes stream;
    append_size_prefixed(&stream, b);
    while (stream.size() % 8) stream.insert(stream.end(), {0, 0, 0, 0});
    return push("page", "QRP.fbs", QRPIdentifier(), "QRP", stream.data(), stream.size()) < 0 ? 500 : 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// The tile scheme — byte-for-byte the client's math (cellularTileStream.js lonToTileX / latToTileY / tileBounds).
// ---------------------------------------------------------------------------------------------------------------------

double tile_lat_clamp(double lat) {
    if (lat > kTileLatClamp) return kTileLatClamp;
    if (lat < -kTileLatClamp) return -kTileLatClamp;
    return lat;
}
long tile_n(long z) { return 1L << z; }
long lon_to_tile_x(double lon, long z) {
    const double n = static_cast<double>(tile_n(z));
    long x = static_cast<long>(std::floor(((lon + 180.0) / 360.0) * n + kTileIndexEpsilon));
    if (x < 0) x = 0;
    if (x > tile_n(z) - 1) x = tile_n(z) - 1;
    return x;
}
long lat_to_tile_y(double lat, long z) {
    const double n = static_cast<double>(tile_n(z));
    const double phi = (tile_lat_clamp(lat) * M_PI) / 180.0;
    long y = static_cast<long>(std::floor(((1.0 - std::asinh(std::tan(phi)) / M_PI) / 2.0) * n + kTileIndexEpsilon));
    if (y < 0) y = 0;
    if (y > tile_n(z) - 1) y = tile_n(z) - 1;
    return y;
}
struct TileBounds { double west = 0, south = 0, north = 0, east = 0; };
TileBounds tile_bounds(long z, long x, long y) {
    const double n = static_cast<double>(tile_n(z));
    TileBounds b;
    b.west = (static_cast<double>(x) / n) * 360.0 - 180.0;
    b.east = (static_cast<double>(x + 1) / n) * 360.0 - 180.0;
    b.north = std::atan(std::sinh(M_PI * (1.0 - (2.0 * static_cast<double>(y)) / n))) * 180.0 / M_PI;
    b.south = std::atan(std::sinh(M_PI * (1.0 - (2.0 * static_cast<double>(y + 1)) / n))) * 180.0 / M_PI;
    return b;
}

// $TBS read-only peek: LATITUDE (slot 8) and LONGITUDE (slot 9) only. A field the writer omitted is ABSENT, not
// zero — a record with no position is skipped, never plotted at null island.
struct TbsPeek {
    const uint8_t* buf = nullptr;
    uint32_t len = 0, root = 0, vtable = 0;
    uint16_t vtable_len = 0;
    uint32_t rd32(uint32_t at) const {
        return static_cast<uint32_t>(buf[at]) | (static_cast<uint32_t>(buf[at + 1]) << 8) |
               (static_cast<uint32_t>(buf[at + 2]) << 16) | (static_cast<uint32_t>(buf[at + 3]) << 24);
    }
    uint16_t rd16(uint32_t at) const { return static_cast<uint16_t>(buf[at] | (buf[at + 1] << 8)); }
    bool init(const uint8_t* data, uint32_t size) {
        if (!data || size < 8) return false;
        buf = data; len = size; root = rd32(0);
        if (root + 4 > len) return false;
        const int64_t vt = static_cast<int64_t>(root) - static_cast<int32_t>(rd32(root));
        if (vt < 0 || vt + 4 > static_cast<int64_t>(len)) return false;
        vtable = static_cast<uint32_t>(vt);
        vtable_len = rd16(vtable);
        return vtable_len >= 4;
    }
    bool f64(int index, double* out) const {
        const uint32_t at = vtable + 4 + static_cast<uint32_t>(index) * 2;
        if (at + 2 > vtable + vtable_len || at + 2 > len) return false;
        const uint16_t rel = rd16(at);
        if (!rel || root + rel + 8 > len) return false;
        std::memcpy(out, buf + root + rel, 8);
        return true;
    }
};
struct TilePoint { double lat = 0, lon = 0; };

// Keep the points that fall in ONE tile, by re-deriving each point's own (x, y) with the client's formulas — not a
// rectangle test, which disagrees with the client on the seams.
void collect_tile_points(const Bytes& stream, long z, long x, long y, std::vector<TilePoint>* out, long* scanned,
                         long* malformed) {
    for_each_frame(stream.data(), stream.size(), [&](const uint8_t* rec, size_t n) {
        TbsPeek peek;
        double lat = 0, lon = 0;
        if (!peek.init(rec, static_cast<uint32_t>(n)) || !peek.f64(8, &lat) || !peek.f64(9, &lon) ||
            !(lat >= -90.0 && lat <= 90.0) || !(lon >= -180.0 && lon <= 180.0)) {
            (*malformed)++;
            return true;
        }
        (*scanned)++;
        if (lon_to_tile_x(lon, z) == x && lat_to_tile_y(lat, z) == y) out->push_back({lat, lon});
        return true;
    });
}

// The dataset block every tile and the meta carry, from the resume mark and nothing else.
struct Dataset {
    std::string state = "empty";
    std::string epoch = kTileNoEpoch;
    int64_t epoch_ms = 0;
    long records = 0;
    bool stale = true;
};
Dataset dataset_of(const Bytes& marks) {
    Dataset d;
    const MarkView view = read_mark(marks, std::string());
    if (view.present) {
        d.records = static_cast<long>(view.irm.records_committed);
        const bool complete = view.irm.source.total_bytes > 0 && view.irm.next_offset >= view.irm.source.total_bytes;
        d.state = complete ? "warm" : "ingesting";
        d.stale = !complete;
        if (!view.irm.updated_at.empty()) {
            d.epoch = view.irm.updated_at;
            parse_rfc3339_ms(d.epoch, &d.epoch_ms);
        }
    }
    return d;
}

void stamp_dataset(QRPT* q, const Dataset& d) {
    q->STORED = static_cast<uint64_t>(d.records);
    q->AS_OF_MS = d.epoch_ms;
    q->STALE = d.stale;
}

std::string durable_mark_sql(const Config& c) { return c.string("cell_ingest_mark_sql", kDefaultMarkSql); }
long durable_mark_scan(const Config& c) {
    const long v = static_cast<long>(c.number("cell_ingest_mark_scan_rows", static_cast<double>(kDefaultMarkScanRows)));
    return v > 0 ? v : kDefaultMarkScanRows;
}
int push_mark_query(const char* port, const Config& c) {
    return push_fso(port, durable_mark_sql(c), {p_i64(durable_mark_scan(c))});
}

// The tile path grammar: ".../tiles/meta" or ".../tiles/{z}/{x}/{y}"; false when it is not a tile path at all.
bool split_tile_path(const std::string& path, std::vector<std::string>* segments) {
    const size_t at = path.find("/tiles");
    if (at == std::string::npos) return false;
    size_t i = at + 6;
    if (i < path.size() && path[i] != '/') return false;
    std::string current;
    for (; i <= path.size(); i++) {
        const char c = i < path.size() ? path[i] : '/';
        if (c == '/' || c == '?') {
            if (!current.empty()) segments->push_back(current);
            current.clear();
            if (c == '?') break;
        } else {
            current.push_back(c);
        }
    }
    return true;
}

// Strict non-negative integer parse: a tile index that silently truncates serves a neighbour's tile.
bool parse_index(const std::string& text, long* out) {
    if (text.empty() || text.size() > 10) return false;
    long value = 0;
    for (const char c : text) {
        if (c < '0' || c > '9') return false;
        value = value * 10 + (c - '0');
    }
    *out = value;
    return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// The ingest lane helpers.
// ---------------------------------------------------------------------------------------------------------------------

const char* const kMergeMethodNames[] = {"SINGLE_SOURCE", "HIGHEST_SAMPLE_COUNT", "MOST_RECENT", "AUTHORITY_PRECEDENCE", "CENTROID"};

// MM_HIGHEST_SAMPLE_COUNT by default, never SINGLE_SOURCE: sites arrive from OVERLAPPING registries, and single-source
// is the one mode that guarantees the duplicates survive into storage. The numeric config key is what the merge used
// before; the name key is honoured when it is the only one set.
std::string merge_method_name(const Config& c) {
    if (c.has("cell_ingest_merge_method")) {
        const long m = static_cast<long>(c.number("cell_ingest_merge_method", 1));
        if (m >= 0 && m <= 4) return kMergeMethodNames[m];
    }
    return c.string("cell_ingest_merge_method_name", "HIGHEST_SAMPLE_COUNT");
}

std::string hrsp_header(const R::HttpResponse* r, const char* name) {
    if (!r || !r->HEADERS()) return std::string();
    for (const auto* h : *r->HEADERS())
        if (h && h->NAME() && lower(h->NAME()->str()) == name) return h->VALUE() ? h->VALUE()->str() : std::string();
    return std::string();
}

// Content-Range: "bytes 0-3145727/2147483648" -> the denominator, the only authority on the object's size.
bool total_from_content_range(const std::string& value, uint64_t* total) {
    const size_t slash = value.rfind('/');
    if (slash == std::string::npos || slash + 1 >= value.size() || value[slash + 1] == '*') return false;
    const long long parsed = std::atoll(value.c_str() + slash + 1);
    if (parsed <= 0) return false;
    *total = static_cast<uint64_t>(parsed);
    return true;
}

// The job the HttpResponse carries in CONTEXT: [$APR run contract, $IRM job].
bool context_irm(const R::HttpResponse* r, Irm* out) {
    if (!r || !r->CONTEXT()) return false;
    bool found = false;
    for_each_frame(r->CONTEXT()->data(), r->CONTEXT()->size(), [&](const uint8_t* rec, size_t n) {
        if (!has_identifier(rec, n, "$IRM")) return true;
        Bytes scratch;
        const IRM* irm = verified_irm_frame(rec, n, &scratch);
        if (!irm) return true;
        *out = irm_read(*irm);
        found = true;
        return false;
    });
    return found;
}

size_t count_frames(const uint8_t* data, size_t size) {
    size_t n = 0;
    for_each_frame(data, size, [&](const uint8_t*, size_t) { n++; return true; });
    return n;
}

}  // namespace

extern "C" {

// ---------------------------------------------------------------------------------------------------------------------
// cache_plan — THE CACHE GATE. Owner 2026-08-14: "the cell towers should load almost instantaneously."
// Exactly one lane emits per request: the tile lane, the passthrough to route, or the cache read.
// ---------------------------------------------------------------------------------------------------------------------
int cache_plan(void) {
    if (refuse_batched()) return 500;
    const plugin_input_frame_t* frame = frame_for("request");
    if (!frame || !frame->payload || frame->payload_length == 0)
        return fail(400, "missing-request-frame", "cache_plan requires the $HTQ request frame on port \"request\".");

    // A FORWARD ON EVERY UNCERTAINTY: an unreadable envelope goes to route, which owns the error vocabulary.
    const H::HttpRequest* htq = read_htq(frame);
    const std::string path = htq && htq->PATH() ? htq->PATH()->str() : std::string();
    const std::string verb = upper(htq && htq->METHOD() ? htq->METHOD()->str() : std::string());
    const std::string body = htq && htq->BODY()
                                 ? std::string(reinterpret_cast<const char*>(htq->BODY()->data()), htq->BODY()->size())
                                 : std::string();
    if (htq && path.find("/tiles") != std::string::npos)
        return push("tile", "HttpRequestAbi.fbs", "$HTQ", "HttpRequest", frame->payload, frame->payload_length) < 0 ? 500 : 0;

    const bool is_aggregate = htq && path.find("/providers") == std::string::npos &&
                              path.find("/credentials/") == std::string::npos && (verb == "POST" || verb == "GET");
    // REFRESH is the caller's explicit "go to the providers now"; opt-in, never a default.
    if (!is_aggregate || json_bool_or(body, "REFRESH", false))
        return push("passthrough", "HttpRequestAbi.fbs", "$HTQ", "HttpRequest", frame->payload, frame->payload_length) < 0 ? 500 : 0;

    const Config config = load_config();
    const std::string sql = config.string("cell_cache_sql", kDefaultCacheSql);
    long max_rows = static_cast<long>(config.number("cell_cache_max_rows", static_cast<double>(kDefaultCacheMaxRows)));
    if (max_rows <= 0) max_rows = kDefaultCacheMaxRows;
    long limit = static_cast<long>(json_number_or(body, "LIMIT", 2000));
    if (limit <= 0) limit = 2000;
    if (limit > max_rows) limit = max_rows;
    const std::string provider = config_provider(config);

    if (push_fso("query", sql, {p_i64(limit)})) return 500;
    // The freshness read is a SECOND query: the records answer streams back verbatim and must not carry bookkeeping.
    if (push_mark_query("mark_query", config)) return 500;
    APRT job = apr_from(htq, "aggregate-cache");
    job.SELECTION = sql;
    add_param(&job.PARAMETERS, "LIMIT", std::to_string(limit));
    add_param(&job.PARAMETERS, "maxRows", std::to_string(max_rows));
    add_param(&job.PARAMETERS, "provider", provider);
    return push_apr("job", job);
}

// ---------------------------------------------------------------------------------------------------------------------
// cache_freshness — the honest half of the cache: the cached rows WITH their age, never a stale answer presented as
// a current one.
// ---------------------------------------------------------------------------------------------------------------------
int cache_freshness(void) {
    if (refuse_batched({"records", "mark"})) return 500;
    APRT job;
    int status = 0;
    if (!read_apr("job", &job, &status)) return status;
    const FsbResult rows = fsb_result("records");
    const FsbResult marks = fsb_result("mark");
    if (!rows.ok || !marks.ok) return fail(400, "invalid-fsb-frame", "a result chunk is not an $FSB.");

    const MarkView view = read_mark(marks.data, std::string());
    std::string state = "empty", freshness = "unknown", providers;
    bool stale = true;
    DAVT dav;
    dav.STANDARD = "TBS";
    dav.SCHEMA_NAME = kSchemaName;
    dav.SOURCE_NAME = "cellular-aggregate-cache";
    dav.PROVIDER_ID = apr_param(job, "provider");
    if (view.present) {
        const Irm& m = view.irm;
        state = "warm";
        freshness = (m.source.total_bytes > 0 && m.next_offset >= m.source.total_bytes) ? "complete" : "ingesting";
        stale = freshness != "complete";
        providers = "providerId=" + m.provider_id + ";nextOffset=" + std::to_string(m.next_offset) +
                    ";totalBytes=" + std::to_string(m.source.total_bytes) +
                    ";chunkIndex=" + std::to_string(m.next_chunk_index) + ";state=" + freshness;
        dav.PROVIDER_ID = m.provider_id;
        dav.KNOWN = true;
        dav.AVAILABLE = true;
        dav.FRESH = !stale;
        int64_t ms = 0;
        if (parse_rfc3339_ms(m.updated_at, &ms)) dav.PUBLISHED_AT_MS = ms;
        if (m.has_chunk) dav.BATCH_ID = m.chunk.batch_id;
    } else if (view.frames > 0) {
        // Rows came back but none is an $IRM: a timestamp guessed at here would be a lie with a number on it.
        state = "warm";
        freshness = "unavailable";
        dav.KNOWN = true;
        dav.AVAILABLE = true;
        dav.FRESH = false;
    } else {
        // No mark: the ingest lane has stored nothing. Instant AND empty, and it says so.
        dav.KNOWN = false;
        dav.AVAILABLE = false;
        dav.UNAVAILABLE_REASON = davUnavailableReason_NotPublished;
    }
    if (rows.present) {
        dav.RECORD_COUNT = count_frames(rows.data.data(), rows.data.size());
        dav.BYTE_COUNT = rows.data.size();
    }

    auto header = [&](const char* name, const std::string& value) { add_param(&job.RESPONSE_HEADERS, name, value); };
    header("x-sdn-cache", state);
    header("x-sdn-cache-freshness", freshness);
    header("x-sdn-cache-stale", stale ? "true" : "false");
    header("x-sdn-cache-providers", providers);

    flatbuffers::FlatBufferBuilder b(512);
    FinishDAVBuffer(b, DAV::Pack(b, &dav));
    if (push_builder("availability", "DAV.fbs", DAVIdentifier(), "DAV", b) < 0) return 500;
    if (rows.present &&
        push("records", "TBS.fbs", "$TBS", "TBS", rows.data.data(), rows.data.size()) < 0)
        return 500;
    return push_apr("decision", job);
}

// ---------------------------------------------------------------------------------------------------------------------
// tile_plan — THE TILE ROUTER. BOUNDS ARE REFUSED, NEVER CLAMPED: a clamped index answers 200 with a DIFFERENT
// tile's contents under the requested key.
// ---------------------------------------------------------------------------------------------------------------------
int tile_plan(void) {
    if (refuse_batched()) return 500;
    const plugin_input_frame_t* frame = frame_for("request");
    if (!frame || !frame->payload || frame->payload_length == 0)
        return fail(400, "missing-request-frame", "tile_plan requires the $HTQ request frame on port \"request\".");
    const H::HttpRequest* htq = read_htq(frame);
    const std::string path = htq && htq->PATH() ? htq->PATH()->str() : std::string();

    auto refuse = [&](const char* code, const std::string& why) -> int {
        APRT refusal = apr_from(htq, "tile");
        refusal.STATUS = 400;
        refusal.ERROR_CODE = code;
        refusal.ERROR_MESSAGE = why;
        return push_apr("refusal", refusal);
    };

    std::vector<std::string> segments;
    if (!htq || !split_tile_path(path, &segments))
        return refuse("tile-path", "the tile lane serves /tiles/meta and /tiles/{z}/{x}/{y} only");

    const Config config = load_config();
    const std::string provider = config_provider(config);

    // The meta lane: capability envelope + store honesty from the mark, and NO row scan.
    if (segments.size() == 1 && segments[0] == "meta") {
        if (push_mark_query("meta_mark_query", config)) return 500;
        APRT job = apr_from(htq, "tile-meta");
        add_param(&job.PARAMETERS, "provider", provider);
        return push_apr("meta_job", job);
    }
    if (segments.size() != 3)
        return refuse("tile-path", "a tile request is /tiles/{z}/{x}/{y}; got " + std::to_string(segments.size()) +
                                       " path segment(s) after /tiles");
    long z = 0, x = 0, y = 0;
    if (!parse_index(segments[0], &z) || !parse_index(segments[1], &x) || !parse_index(segments[2], &y))
        return refuse("tile-bounds", "z, x and y must be canonical non-negative integers");
    if (z < kTileMinZoom || z > kTileMaxZoom)
        return refuse("tile-bounds", "zoom " + std::to_string(z) + " is outside [" + std::to_string(kTileMinZoom) + ", " +
                                         std::to_string(kTileMaxZoom) + "]");
    const long n = tile_n(z);
    if (x >= n || y >= n)
        return refuse("tile-bounds", "tile " + std::to_string(z) + "/" + std::to_string(x) + "/" + std::to_string(y) +
                                         " is outside [0, " + std::to_string(n) + ") at this zoom");

    long max_rows = static_cast<long>(config.number("cell_tile_max_rows", static_cast<double>(kDefaultTileMaxRows)));
    if (max_rows <= 0) max_rows = kDefaultTileMaxRows;
    const TileBounds bounds = tile_bounds(z, x, y);
    const std::string configured_sql = config.string("cell_tile_sql", "");
    const bool scoped = configured_sql.empty();
    int rc;
    if (!scoped) {
        // AN OPT-OUT THE ANSWER ADMITS TO: an operator statement cannot carry the tile's rectangle (scoped false).
        rc = push_fso("rows_query", configured_sql, {p_i64(max_rows)});
    } else {
        // THE BBOX IS A PREFILTER, NEVER THE MEMBERSHIP TEST (tile re-derives each point's x/y).
        const std::string relation = config.string("cell_tile_relation", kDefaultTileRelation);
        rc = push_fso("rows_query",
                      "SELECT _data FROM " + relation +
                          " WHERE LATITUDE >= ?1 AND LATITUDE <= ?2 AND LONGITUDE >= ?3 AND LONGITUDE <= ?4"
                          " ORDER BY _rowid DESC LIMIT ?5",
                      {p_f64(bounds.south), p_f64(bounds.north), p_f64(bounds.west), p_f64(bounds.east), p_i64(max_rows)});
    }
    if (rc) return rc;
    if (push_mark_query("tile_mark_query", config)) return 500;
    APRT job = apr_from(htq, "tile");
    add_param(&job.PARAMETERS, "z", std::to_string(z));
    add_param(&job.PARAMETERS, "x", std::to_string(x));
    add_param(&job.PARAMETERS, "y", std::to_string(y));
    add_param(&job.PARAMETERS, "maxRows", std::to_string(max_rows));
    add_param(&job.PARAMETERS, "scoped", scoped ? "true" : "false");
    add_param(&job.PARAMETERS, "provider", provider);
    return push_apr("tile_job", job);
}

// ---------------------------------------------------------------------------------------------------------------------
// tile_meta — the tile layer's capability envelope, one projection row. The client fetches it once and fails hard if
// it drifts; the same constants author every tile.
// ---------------------------------------------------------------------------------------------------------------------
int tile_meta(void) {
    if (refuse_batched({"mark"})) return 500;
    APRT job;
    int status = 0;
    if (!read_apr("job", &job, &status)) return status;
    const FsbResult marks = fsb_result("mark");
    if (!marks.ok) return fail(400, "invalid-fsb-frame", "a result chunk is not an $FSB.");
    const Dataset d = dataset_of(marks.data);

    QRPT page;
    page.KIND = qrpKind_Page;
    page.STATUS = qrpStatus_Ok;
    page.SCHEMA_NAME = "TBS";
    page.REPRESENTATION = qrp_representation(job.ACCEPT);
    page.GENERATED_AT_MS = now_unix_ms();
    stamp_dataset(&page, d);
    const std::pair<const char*, const char*> columns[] = {
        {"scheme", "string"}, {"minZoom", "int64"}, {"maxZoom", "int64"}, {"threshold", "int64"}, {"budget", "int64"},
        {"densityN", "int64"}, {"latClamp", "double"}, {"tileUrlTemplate", "string"}, {"deconfliction", "string"},
        {"dataset", "string"}, {"epoch", "string"}, {"records", "int64"}, {"stale", "bool"}, {"cacheState", "string"}};
    for (const auto& c : columns) add_column(&page, c.first, c.second);
    auto row = std::make_unique<QRPRowT>();
    row->CELLS.push_back(v_text(kTileScheme));
    row->CELLS.push_back(v_int(kTileMinZoom));
    row->CELLS.push_back(v_int(kTileMaxZoom));
    row->CELLS.push_back(v_int(kTileThreshold));
    row->CELLS.push_back(v_int(kTileBudget));
    row->CELLS.push_back(v_int(kTileDensityN));
    row->CELLS.push_back(v_float(kTileLatClamp));
    row->CELLS.push_back(v_text(kTileUrlTemplate));
    row->CELLS.push_back(v_text(kTileDeconfliction));
    row->CELLS.push_back(v_text(kTileDataset));
    row->CELLS.push_back(v_text(d.epoch));
    row->CELLS.push_back(v_int(d.records));
    row->CELLS.push_back(v_bool(d.stale));
    row->CELLS.push_back(v_text(d.state));
    page.ROWS.push_back(std::move(row));
    page.MESSAGE = "tile meta cache " + d.state;
    if (push_qrp_page(page)) return 500;
    return push_qrp_decision(job);
}

// ---------------------------------------------------------------------------------------------------------------------
// tile — ONE bounded tile, and the mode is the SERVER's: count <= 2048 every point, count <= 4096 a DETERMINISTIC
// stride sample, above a 16x16 density grid. TOTAL_COUNT is always the tile's TRUE population. AN EMPTY STORE
// ANSWERS EMPTY, NEVER FABRICATED.
// ---------------------------------------------------------------------------------------------------------------------
int tile(void) {
    if (refuse_batched({"rows", "mark"})) return 500;
    APRT job;
    int status = 0;
    if (!read_apr("job", &job, &status)) return status;
    const auto index = [&](const char* name) {
        long v = -1;
        return parse_index(apr_param(job, name), &v) ? v : -1L;
    };
    const long z = index("z"), x = index("x"), y = index("y");
    if (z < kTileMinZoom || z > kTileMaxZoom || x < 0 || y < 0 || x >= tile_n(z) || y >= tile_n(z))
        return fail(500, "invalid-tile-job", "the tile job does not carry a valid z/x/y.");
    const FsbResult rows = fsb_result("rows");
    const FsbResult marks = fsb_result("mark");
    if (!rows.ok || !marks.ok) return fail(400, "invalid-fsb-frame", "a result chunk is not an $FSB.");
    const Dataset d = dataset_of(marks.data);

    std::vector<TilePoint> points;
    long scanned = 0, malformed = 0;
    collect_tile_points(rows.data, z, x, y, &points, &scanned, &malformed);
    const long count = static_cast<long>(points.size());
    // A CAPPED READ SAYS SO: a tile whose population exceeds the row budget is answered from a prefix.
    long job_max_rows = 0;
    parse_index(apr_param(job, "maxRows"), &job_max_rows);
    const bool truncated = job_max_rows > 0 && scanned >= job_max_rows;
    const bool scoped = apr_param(job, "scoped", "true") != "false";

    QRPT page;
    page.KIND = qrpKind_Page;
    page.STATUS = qrpStatus_Ok;
    page.SCHEMA_NAME = "TBS";
    page.REPRESENTATION = qrp_representation(job.ACCEPT);
    page.GENERATED_AT_MS = now_unix_ms();
    page.TOTAL_COUNT = static_cast<uint64_t>(count);
    page.SCANNED = static_cast<uint64_t>(scanned);
    page.PARTIAL = truncated || !scoped;
    stamp_dataset(&page, d);
    std::string mode;
    if (count > kTileBudget) {
        // DENSITY: a grid linear in degrees inside the tile's own bounds; EMPTY CELLS ARE OMITTED (count > budget
        // guarantees at least one populated cell).
        mode = "density";
        const TileBounds b = tile_bounds(z, x, y);
        const double span_lon = (b.east - b.west) / static_cast<double>(kTileDensityN);
        const double span_lat = (b.north - b.south) / static_cast<double>(kTileDensityN);
        std::vector<long> cells(static_cast<size_t>(kTileDensityN * kTileDensityN), 0);
        for (const TilePoint& p : points) {
            long col = span_lon > 0 ? static_cast<long>(std::floor((p.lon - b.west) / span_lon)) : 0;
            long row = span_lat > 0 ? static_cast<long>(std::floor((p.lat - b.south) / span_lat)) : 0;
            col = std::min(std::max(col, 0L), kTileDensityN - 1);
            row = std::min(std::max(row, 0L), kTileDensityN - 1);
            cells[static_cast<size_t>(row * kTileDensityN + col)]++;
        }
        add_column(&page, "lon", "double");
        add_column(&page, "lat", "double");
        add_column(&page, "count", "int64");
        for (long row = 0; row < kTileDensityN; row++) {
            for (long col = 0; col < kTileDensityN; col++) {
                const long c = cells[static_cast<size_t>(row * kTileDensityN + col)];
                if (c == 0) continue;
                auto r = std::make_unique<QRPRowT>();
                r->CELLS.push_back(v_float(b.west + static_cast<double>(col) * span_lon));
                r->CELLS.push_back(v_float(b.south + static_cast<double>(row) * span_lat));
                r->CELLS.push_back(v_int(c));
                page.ROWS.push_back(std::move(r));
            }
        }
    } else {
        // POINTS, whole or deterministically sampled: stride ceil(count / threshold) over the rows in query order.
        mode = "points";
        long stride = 1;
        if (count > kTileThreshold) {
            stride = (count + kTileThreshold - 1) / kTileThreshold;
            page.TRUNCATED = true;
        }
        add_column(&page, "LATITUDE", "double");
        add_column(&page, "LONGITUDE", "double");
        for (long i = 0; i < count; i += stride) {
            auto r = std::make_unique<QRPRowT>();
            r->CELLS.push_back(v_float(points[static_cast<size_t>(i)].lat));
            r->CELLS.push_back(v_float(points[static_cast<size_t>(i)].lon));
            page.ROWS.push_back(std::move(r));
        }
    }
    page.MESSAGE = "tile " + std::to_string(z) + "/" + std::to_string(x) + "/" + std::to_string(y) + " mode " + mode +
                   " cache " + d.state + " scoped " + (scoped ? "true" : "false") + " malformed " +
                   std::to_string(malformed);
    if (push_qrp_page(page)) return 500;
    return push_qrp_decision(job);
}

// mark_query: timer tick -> the $FSO that reads the newest $IRM resume marks. A SEPARATE node from ingest_plan
// because the plan takes the mark as an input, and a node that emitted its own input would be a cycle.
int mark_query(void) {
    if (refuse_batched()) return 500;
    return push_mark_query("query", load_config());
}

// ingest_plan: tick (+ the resume marks) -> ONE ranged fetch whose CONTEXT is the run: [$APR run contract, $IRM job].
int ingest_plan(void) {
    if (refuse_batched({"mark"})) return 500;
    const Config config = load_config();
    const std::string provider = config_provider(config);
    const std::string url = config.string("cell_ingest_url", "");
    // Fail-closed: inventing a default URL would ingest a provider nobody selected.
    if (url.empty()) return fail(400, "missing-ingest-url", "ingest_plan requires cell_ingest_url in node CONFIG.");
    const FsbResult marks = fsb_result("mark");
    if (!marks.ok) return fail(400, "invalid-fsb-frame", "a result chunk is not an $FSB.");

    const std::string method = merge_method_name(config);
    const long chunk = config_chunk_bytes(config);
    const MarkView view = read_mark(marks.data, provider);
    Irm job;
    if (view.present) {
        job = view.irm;
        // THE DECODE CONTEXT, GATED ON ITS VERSION STAMP: a decoder state this build does not recognise is DISCARDED
        // (the header line and the offset are this flow's and still apply). Handing a foreign blob to the decoder
        // does not fail loudly — it resumes into nonsense that stores cleanly.
        if (job.decode.state_format != kDecoderStateFormat) job.clear_decoder();
        if (job.has_decode && job.decode_empty()) job.has_decode = false;
    } else {
        job.ingestor_id = kIngestorId;
        job.state = irmJobState_IN_PROGRESS;
        job.created_at = iso_ms(now_unix_ms());
    }
    // A finished object is not refetched; the downstream http node never becomes ready.
    if (job.source.total_bytes > 0 && job.next_offset >= job.source.total_bytes) return 0;

    job.job_id = provider + "@" + url;
    job.provider_id = provider;
    job.source.url = url;
    job.range_mode = irmRangeMode_INCLUSIVE_BYTE_RANGE;
    job.chunk_byte_budget = static_cast<uint64_t>(chunk);
    job.merge_policy = method;
    job.target_standard = kTargetStandard;
    job.reconcile_mode = "none";
    if (job.ingestor_id.empty()) job.ingestor_id = kIngestorId;
    if (job.updated_at.empty()) job.updated_at = iso_ms(now_unix_ms());
    if (job.started_at.empty()) job.started_at = iso_ms(now_unix_ms());

    const uint64_t offset = job.next_offset;
    uint64_t last = offset + static_cast<uint64_t>(chunk) - 1;
    if (job.source.total_bytes > 0 && last > job.source.total_bytes - 1) last = job.source.total_bytes - 1;
    char range[80];
    std::snprintf(range, sizeof(range), "bytes=%llu-%llu", static_cast<unsigned long long>(offset),
                  static_cast<unsigned long long>(last));

    // The run contract cell-tower-source parse/deconflict read. THE INGEST LANE DECODES THE WHOLE CHUNK
    // (FULL_POPULATION): a 1,000-row clamp truncated a 127,939-row chunk and left the mark at byte 0 forever.
    APRT run = apr_from(nullptr, "ingest");
    add_param(&run.PARAMETERS, "PROVIDERS", provider);
    add_param(&run.PARAMETERS, "METHOD", method);
    add_param(&run.PARAMETERS, "LIMIT", format_number(config.number("cell_ingest_limit", 1000000)));
    add_param(&run.PARAMETERS, "FULL_POPULATION", "true");
    add_param(&run.PARAMETERS, "provider", provider);
    add_param(&run.PARAMETERS, "fetches", "1");
    add_param(&run.RESPONSE_HEADERS, "x-sdn-providers-consulted", provider);

    Bytes context;
    {
        flatbuffers::FlatBufferBuilder b(512);
        FinishSizePrefixedAPRBuffer(b, APR::Pack(b, &run));
        append_size_prefixed(&context, b);
    }
    {
        flatbuffers::FlatBufferBuilder b(2048 + job.decode.decoder_state.size() + job.decode.window.size());
        irm_write(b, job, true);
        append_size_prefixed(&context, b);
    }
    flatbuffers::FlatBufferBuilder b(1024 + context.size());
    std::vector<flatbuffers::Offset<R::Header>> headers{R::CreateHeaderDirect(b, "range", range)};
    R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, "GET", url.c_str(), &headers, nullptr,
                                                             static_cast<uint32_t>(config_timeout_ms(config)), 0, &context));
    return push_builder("request", "HttpRequest.fbs", R::HttpRequestIdentifier(), "HttpRequest", b) < 0 ? 500 : 0;
}

// ingest_meta: the deconflicted $TBS stream + the chunk's HttpResponse (its CONTEXT the job) + the decoder's own
// resume mark -> the IngestRequest, the records forwarded untouched, and the candidate next $IRM.
int ingest_meta(void) {
    if (refuse_batched()) return 500;
    const plugin_input_frame_t* response_frame = frame_for("response");
    Bytes response_scratch;
    const R::HttpResponse* response =
        response_frame && response_frame->payload
            ? verified_copy<R::HttpResponse>(response_frame->payload, response_frame->payload_length, &response_scratch,
                                             R::VerifyHttpResponseBuffer, R::GetHttpResponse)
            : nullptr;
    if (!response) return fail(400, "missing-response-frame", "ingest_meta requires the chunk's HttpResponse (HRSP).");
    Irm job;
    if (!context_irm(response, &job) || job.provider_id.empty() || job.source.url.empty())
        return fail(400, "missing-context", "the HttpResponse carries no $IRM job (provider and source) in CONTEXT.");
    const Config config = load_config();
    const std::string source_name = config.string("cell_ingest_source_name", "cell-tower-bulk");

    // HTTP 304 IS A SUCCESSFUL FETCH WITH NOTHING NEW: one notice, nothing on meta/records, the mark stays put.
    if (response->STATUS() == 304) {
        R::FlowNoticeT notice;
        notice.KIND = R::flowNoticeKind_Unchanged;
        notice.SCHEMA = kSchemaName;
        notice.PROVIDER_ID = job.provider_id;
        notice.SOURCE_NAME = source_name;
        notice.REASON = "not-modified";
        notice.ITEMS = {job.source.url};
        notice.AT_MS = static_cast<uint64_t>(now_unix_ms());
        flatbuffers::FlatBufferBuilder b(256);
        R::FinishFlowNoticeBuffer(b, R::FlowNotice::Pack(b, &notice));
        return push_builder("unchanged", "FlowNotice.fbs", R::FlowNoticeIdentifier(), "FlowNotice", b) < 0 ? 500 : 0;
    }

    const plugin_input_frame_t* records = frame_for("records");
    if (!records) return fail(400, "missing-records-frame", "ingest_meta requires the deconflicted record stream.");
    Irm resume;
    bool has_resume = false;
    int status = 0;
    if (!read_irm_port("resume", &resume, &has_resume, &status)) return status;

    const uint64_t chunk_offset = job.next_offset;
    const uint32_t chunk_index = job.next_chunk_index;
    const uint64_t chunk_bytes = job.chunk_byte_budget ? job.chunk_byte_budget : static_cast<uint64_t>(kDefaultChunkBytes);
    const size_t records_in = records->payload ? count_frames(records->payload, records->payload_length) : 0;

    // TOTAL from Content-Range's denominator: Content-Length on a 206 describes the CHUNK.
    uint64_t total = job.source.total_bytes;
    total_from_content_range(hrsp_header(response, "content-range"), &total);

    // ROW-BOUNDARY CORRECTION: the next offset is the end of the last COMPLETE row in this chunk, never mid-row. No
    // newline at all = no complete row: the offset does not move.
    uint64_t next_offset = chunk_offset + chunk_bytes;
    std::string header_line;
    const auto* body = response->BODY();
    if (body && body->size()) {
        const std::string_view text(reinterpret_cast<const char*>(body->data()), body->size());
        const size_t nl = text.rfind('\n');
        if (nl != std::string_view::npos) next_offset = chunk_offset + static_cast<uint64_t>(nl) + 1;
        // THE HEADER ROW EXISTS IN CHUNK 0 AND NOWHERE ELSE, and A CSV HEADER ROW IS TEXT: a gzip chunk 0's 0x0A
        // is not a header (printable ASCII plus tabs only).
        if (chunk_offset == 0) {
            const size_t first = text.find('\n');
            if (first != std::string_view::npos) {
                std::string candidate(text.substr(0, first));
                if (!candidate.empty() && candidate.back() == '\r') candidate.pop_back();
                bool textual = !candidate.empty();
                for (const char ch : candidate) {
                    const unsigned char u = static_cast<unsigned char>(ch);
                    if (u == '\t') continue;
                    if (u < 0x20 || u == 0x7f) { textual = false; break; }
                }
                if (textual) header_line = candidate;
            }
        }
    }
    if (header_line.empty()) header_line = job.decode.header_line;

    // THE DECODER'S OWN NEXT BYTE WINS OVER THE NEWLINE CORRECTION: a deflate stream has no row boundaries.
    Irm mark = job;
    bool complete = total > 0 && next_offset >= total;
    if (has_resume) {
        next_offset = resume.next_offset;
        mark.decode = resume.decode;
        mark.has_decode = resume.has_decode;
        complete = resume.state == irmJobState_COMPLETE || (total > 0 && next_offset >= total);
    } else {
        mark.clear_decoder();
    }
    mark.decode.header_line = header_line;
    mark.decode.header_byte_length = header_line.empty() ? 0 : header_line.size();
    if (mark.decode.format.empty()) mark.decode.format = kDecodeFormat;
    mark.has_decode = !mark.decode_empty();

    char batch_buf[160];
    std::snprintf(batch_buf, sizeof(batch_buf), "%s@%llu", job.provider_id.c_str(), static_cast<unsigned long long>(chunk_offset));
    const std::string batch_id = batch_buf;

    mark.source.total_bytes = total;
    mark.next_offset = next_offset;
    mark.state = complete ? irmJobState_COMPLETE : irmJobState_IN_PROGRESS;
    mark.has_chunk = true;
    mark.chunk = Irm::Chunk();
    mark.chunk.index = chunk_index;
    mark.chunk.batch_id = batch_id;
    mark.chunk.first = chunk_offset;
    if (next_offset > chunk_offset) {
        mark.chunk.last = next_offset - 1;
        mark.chunk.byte_length = next_offset - chunk_offset;
    }
    mark.chunk.records_decoded = static_cast<uint32_t>(records_in);
    mark.next_chunk_index = chunk_index + 1;
    mark.sequence = chunk_index + 1;
    mark.chunks_committed = chunk_index + 1;
    mark.bytes_committed = next_offset;
    mark.updated_at = iso_ms(now_unix_ms());

    // The IngestRequest: SCHEMA, attribution, RECONCILE None (this batch is one CHUNK of the provider's set: `current`
    // would delete every earlier chunk, `duplicates` partitions on the satellite index and collapsed six sites to one).
    R::IngestRequestT meta;
    meta.SCHEMA = kSchemaName;
    meta.TAGS = std::make_unique<R::SourceTagsT>();
    meta.TAGS->PROVIDER_ID = job.provider_id;
    meta.TAGS->SOURCE_NAME = source_name;
    meta.TAGS->BATCH_ID = batch_id;
    meta.TAGS->SOURCE_URL = job.source.url;
    meta.RECONCILE = R::reconcileMode_None;
    meta.PROVENANCE = std::make_unique<R::ProvenanceT>();
    meta.PROVENANCE->SOURCE_URL = job.source.url;
    meta.PROVENANCE->HTTP_STATUS = response->STATUS();
    meta.PROVENANCE->ETAG = hrsp_header(response, "etag");
    meta.PROVENANCE->LAST_MODIFIED = hrsp_header(response, "last-modified");
    meta.PROVENANCE->CONTENT_TYPE = hrsp_header(response, "content-type");
    meta.PROVENANCE->RETRIEVED_MS = response->RETRIEVED_MS();
    meta.PROVENANCE->PARSER = kParser;
    meta.PROVENANCE->PARSER_VERSION = kParserVersion;
    meta.PROVENANCE->NORMALIZED_COUNT = records_in;
    flatbuffers::FlatBufferBuilder mb(1024);
    R::FinishIngestRequestBuffer(mb, R::IngestRequest::Pack(mb, &meta));
    if (push_builder("meta", "IngestRequest.fbs", R::IngestRequestIdentifier(), "IngestRequest", mb) < 0) return 500;
    if (push("records", "TBS.fbs", "$TBS", "TBS", records->payload, records->payload_length) < 0) return 500;
    return push_irm("mark", mark);
}

// publish_request: the storage result joined with the IngestRequest and the candidate mark -> the durable mark, and
// (only when configured) the dataset-publication POST. The mark is NOT gated on the publish URL.
int publish_request(void) {
    if (refuse_batched()) return 500;
    const plugin_input_frame_t* result_frame = frame_for("result");
    const plugin_input_frame_t* meta_frame = frame_for("meta");
    Bytes rs, ms;
    const R::IngestResult* result =
        result_frame && result_frame->payload
            ? verified_copy<R::IngestResult>(result_frame->payload, result_frame->payload_length, &rs,
                                             R::VerifyIngestResultBuffer, R::GetIngestResult)
            : nullptr;
    if (!result) return fail(400, "missing-result-frame", "publish_request requires the storage-ingest IngestResult (INGR).");
    const R::IngestRequest* meta =
        meta_frame && meta_frame->payload
            ? verified_copy<R::IngestRequest>(meta_frame->payload, meta_frame->payload_length, &ms,
                                              R::VerifyIngestRequestBuffer, R::GetIngestRequest)
            : nullptr;
    if (!meta || !meta->TAGS()) return fail(400, "missing-meta-frame", "publish_request requires the IngestRequest (INGQ).");
    Irm mark;
    bool has_mark = false;
    int status = 0;
    if (!read_irm_port("mark", &mark, &has_mark, &status)) return status;
    if (!has_mark) return fail(400, "missing-mark-frame", "publish_request requires the candidate $IRM from ingest_meta.");

    const std::string provider = str_of(meta->TAGS()->PROVIDER_ID());
    const std::string batch = str_of(meta->TAGS()->BATCH_ID());
    if (result->REFUSED() && result->REFUSED()->size()) {
        return fail(502, "ingest-refused",
                    "storage.ingest_with_source refused batch " + batch + " (" + result->REFUSED()->str() +
                        "). The resume mark is NOT advanced: nothing was stored.");
    }
    // THE SILENT NOP, CAUGHT: INSERTED 0 for a chunk that carried records is byte-identical to a healthy empty tail.
    const uint64_t inserted = result->INSERTED();
    const uint64_t records_in = meta->PROVENANCE() ? meta->PROVENANCE()->NORMALIZED_COUNT()
                                                   : (mark.has_chunk ? mark.chunk.records_decoded : 0);
    if (inserted == 0 && records_in > 0) {
        char message[320];
        std::snprintf(message, sizeof(message),
                      "storage.ingest_with_source reported ok with inserted=0 for a chunk carrying %llu records "
                      "(provider %s, batch %s). The resume mark is NOT advanced: advancing here would skip these rows "
                      "permanently.",
                      static_cast<unsigned long long>(records_in), provider.c_str(), batch.c_str());
        return fail(502, "ingest-stored-nothing", message);
    }

    // CUMULATIVE, and only what STORAGE confirmed.
    const std::string now = iso_ms(now_unix_ms());
    mark.records_committed += inserted;
    mark.updated_at = now;
    mark.has_chunk = true;
    mark.chunk.records_stored = static_cast<uint32_t>(inserted);
    mark.chunk.committed_at = now;
    if (mark.state == irmJobState_COMPLETE && mark.completed_at.empty()) mark.completed_at = now;
    if (push_irm("mark_record", mark)) return 500;

    const Config config = load_config();
    const std::string publish_url = config.string("cell_ingest_publish_url", "");
    if (publish_url.empty()) return 0;  // fail-closed: absence of configuration is not permission to publish
    std::string schema = str_of(result->SCHEMA());
    if (schema.empty()) schema = str_of(meta->SCHEMA());
    std::string batch_id = str_of(result->BATCH_ID());
    if (batch_id.empty()) batch_id = batch;
    const std::string source = str_of(meta->TAGS()->SOURCE_NAME());
    if (schema.empty() || batch_id.empty() || provider.empty() || source.empty())
        return fail(400, "incomplete-publication-identity", "publish_request needs schema, batchId, providerId and sourceName.");
    flatbuffers::FlatBufferBuilder rb(512);
    R::FinishIngestResultBuffer(rb, R::CreateIngestResultDirect(rb, schema.c_str(), provider.c_str(), source.c_str(), batch_id.c_str(),
                                                                inserted, result->RECONCILED_DUPLICATES(),
                                                                result->RECONCILED_OLD_BATCHES(),
                                                                result->ARCHIVED() && result->ARCHIVED()->size() ? result->ARCHIVED()->c_str() : nullptr,
                                                                nullptr));
    const Bytes body(rb.GetBufferPointer(), rb.GetBufferPointer() + rb.GetSize());
    flatbuffers::FlatBufferBuilder b(1024 + body.size());
    std::vector<flatbuffers::Offset<R::Header>> headers{R::CreateHeaderDirect(b, "content-type", "application/octet-stream")};
    R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, "POST", publish_url.c_str(), &headers, &body,
                                                             static_cast<uint32_t>(config_timeout_ms(config)), 0, nullptr));
    return push_builder("request", "HttpRequest.fbs", R::HttpRequestIdentifier(), "HttpRequest", b) < 0 ? 500 : 0;
}

}  // extern "C"
