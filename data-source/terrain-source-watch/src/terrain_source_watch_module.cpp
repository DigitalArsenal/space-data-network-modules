/*
 * data-source/terrain-source-watch - the monthly source check of the terrain refresh flow (typed contracts 1.0:
 * FlatBuffers only, every hostcall an SDS $PIV invocation through sdm_piv).
 *
 * OWNER 2026-10-21: terrain updates run on SDN nodes as modules and flows, not as Mac scripts. Monthly, a source check
 * diffs each source's listing (size, ETag, Last-Modified) against the raw/<naif>/<product>/ mirror; a quarterly rebuild
 * re-encodes what changed.
 *
 * WHAT IT DOES. For one body (config `body`: moon | mars) it asks every source file the terrain walk reads (the table
 * the walk itself uses, src/watch_sources.hpp, generated from terrain-ingest's body_plan.hpp and held to it by
 * `node tools/generate-sources.mjs --check`) for the first byte of the file - a one-byte ranged GET, because the Go
 * node's http connector fails a HEAD answered with a Content-Length - which answers the file's ETag, Last-Modified and
 * total size in one exchange, and lists the mirror (`raw/<naif>/`) through storage/object-s3. The diff is a $QRP
 * projection page, stored beside the mirror (`<report_prefix>/<naif>/<yyyy-mm-dd>.qrp`) and summarized in one FlowNotice.
 *
 * It never touches the network: it builds requests for hostcap/http-request and reads their answers, and builds the
 * list / put tasks for storage/object-s3. It holds the clock only.
 *
 * METHODS
 *   plan  tick (TimerTick) -> probes (HttpRequest x N) + list ($APR, object-s3 sign) + status (FlowNotice, a refusal)
 *   diff  probes (HttpResponse x N) + mirror ($FIL) + mirror_result ($APR) -> report ($QRP page) + put ($APR, object-s3
 *         sign) + status (FlowNotice)
 *
 * STATES, per source file
 *   current          the live ETag is the pinned one and the mirror holds the same number of bytes
 *   source-changed   the live ETag is not the one the walk is pinned to: the publisher reprocessed the product; every
 *                    unit that reads it must be re-encoded
 *   source-newer     no pin, but the source was modified after the mirror was written
 *   size-changed     the mirrored object is not the source's size
 *   not-mirrored     the source answers and nothing is mirrored (the walk reads these from the publisher)
 *   probe-failed     the source did not answer a ranged read
 * refresh-needed = source-changed | source-newer | size-changed.
 *
 * CONFIG (plugin.getConfig): body; store, endpoint, bucket, region (the object-s3 lane the mirror is read through);
 * report_prefix (default "watch"); timeout_ms; pins ("off": compare size and Last-Modified only).
 */

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"
#include "FlowNotice_generated.h"
#include "watch_sources.hpp"

namespace {

namespace R = sdn::runtime;

constexpr const char* kNoValidator = "\"sdn-terrain-source-watch\"";  // see storage/object-s3: the Go node's remembered validators
constexpr uint32_t kProbeTimeoutMs = 120000;

std::vector<const plugin_input_frame_t*> frames_on(const char* port) {
    std::vector<const plugin_input_frame_t*> out;
    for (uint32_t ordinal = 0;; ordinal++) {
        const int32_t idx = plugin_find_input_index(port, ordinal);
        if (idx < 0) break;
        const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(idx));
        if (f) out.push_back(f);
    }
    return out;
}

bool verify_unaligned(const uint8_t* p, size_t n, bool (*verify)(flatbuffers::Verifier&)) {
    flatbuffers::Verifier::Options options;
    options.check_alignment = false;
    flatbuffers::Verifier verifier(p, n, options);
    return verify(verifier);
}
bool has_identifier(const uint8_t* p, size_t n, const char* id) { return n >= 8 && std::memcmp(p + 4, id, 4) == 0; }
bool verify_apr(flatbuffers::Verifier& v) { return VerifyAPRBuffer(v); }
bool verify_fil(flatbuffers::Verifier& v) { return VerifyFILBuffer(v); }
bool verify_hrsp(flatbuffers::Verifier& v) { return R::VerifyHttpResponseBuffer(v); }

std::string lower(std::string_view s) {
    std::string out(s);
    std::transform(out.begin(), out.end(), out.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return out;
}

// ── config ──────────────────────────────────────────────────────────────────────────────────────────────────────
struct Cfg {
    std::string body = "moon", store = "r2", endpoint, bucket = "spaceaware", region = "auto", report_prefix = "watch";
    uint32_t timeout_ms = kProbeTimeoutMs;
    bool use_pins = true;  // config pins: "off" compares size and Last-Modified only (a product added without a pin)
    std::string error;
};
Cfg load_config() {
    Cfg c;
    const sdm_piv::Config config = sdm_piv::get_config();
    if (!config.ok()) { c.error = "plugin.getConfig: " + config.error_message(); return c; }
    auto text = [&](const char* key, std::string* out) { const std::string_view v = config.string(key); if (!v.empty()) *out = std::string(v); };
    text("body", &c.body); text("store", &c.store); text("endpoint", &c.endpoint); text("bucket", &c.bucket);
    text("region", &c.region); text("report_prefix", &c.report_prefix);
    c.use_pins = config.string("pins") != "off";
    const double timeout = config.number("timeout_ms", 0);
    if (timeout >= 1000) c.timeout_ms = static_cast<uint32_t>(timeout);
    if (c.body != "moon" && c.body != "mars") c.error = "config body is moon or mars";
    else if (c.endpoint.empty()) c.error = "config endpoint (the mirror store's https://host) is required";
    return c;
}

// ── outputs ─────────────────────────────────────────────────────────────────────────────────────────────────────
int push_status(R::flowNoticeKind kind, const std::string& reason, uint64_t count, const std::vector<std::string>& items) {
    R::FlowNoticeT notice;
    notice.KIND = kind;
    notice.SCHEMA = "QRP.fbs";
    notice.SOURCE_NAME = "terrain-source-watch";
    notice.REASON = reason;
    notice.COUNT = count;
    notice.ITEMS = items;
    flatbuffers::FlatBufferBuilder b(512);
    R::FinishFlowNoticeBuffer(b, R::FlowNotice::Pack(b, &notice));
    return plugin_push_output_ex("status", "FlowNotice.fbs", R::FlowNoticeIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "FlowNotice", 0, 0, b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0 ? 500 : 0;
}

std::unique_ptr<APRParameterT> parameter(const std::string& name, const std::string& value) {
    auto p = std::make_unique<APRParameterT>();
    p->NAME = name;
    p->VALUE = value;
    return p;
}

int push_apr(const char* port, const APRT& apr) {
    flatbuffers::FlatBufferBuilder b(1024 + apr.BODY.size());
    FinishAPRBuffer(b, APR::Pack(b, &apr));
    return plugin_push_output_ex(port, "APR.fbs", APRIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "APR", 0, 8,
                                 b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0 ? 500 : 0;
}

// ── plan ────────────────────────────────────────────────────────────────────────────────────────────────────────
int run_plan() {
    const auto ticks = frames_on("tick");
    if (ticks.empty()) return 0;
    const Cfg cfg = load_config();
    if (!cfg.error.empty()) return push_status(R::flowNoticeKind_Missing, "unconfigured: " + cfg.error, 0, {});
    std::string naif;
    uint32_t count = 0;
    for (unsigned i = 0; i < kWatchSourceCount; ++i) {
        const WatchSource& s = kWatchSources[i];
        if (cfg.body != s.body) continue;
        naif = s.naif;
        APRT context;
        context.REQUEST_ID = std::to_string(i);
        context.ROUTE = "probe";
        flatbuffers::FlatBufferBuilder cb(128);
        FinishAPRBuffer(cb, APR::Pack(cb, &context));

        R::HttpRequestT request;
        request.METHOD = "GET";
        request.URL = s.url;
        for (const auto& [name, value] : std::vector<std::pair<std::string, std::string>>{{"if-none-match", kNoValidator}, {"range", "bytes=0-0"}}) {
            auto h = std::make_unique<R::HeaderT>();
            h->NAME = name;
            h->VALUE = value;
            request.HEADERS.push_back(std::move(h));
        }
        request.TIMEOUT_MS = cfg.timeout_ms;
        request.MAX_BYTES = 1024 * 1024;
        request.CONTEXT.assign(cb.GetBufferPointer(), cb.GetBufferPointer() + cb.GetSize());
        flatbuffers::FlatBufferBuilder b(512);
        R::FinishHttpRequestBuffer(b, R::HttpRequest::Pack(b, &request));
        if (plugin_push_output_ex("probes", "HttpRequest.fbs", R::HttpRequestIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                  "HttpRequest", 0, 8, b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0) {
            return 500;
        }
        ++count;
    }
    // the mirror's listing: every key under raw/<naif>/ (one page: the mirror holds far fewer than 1000 keys)
    APRT list;
    list.REQUEST_ID = "watch-list";
    list.ROUTE = "list";
    for (const auto& [k, v] : std::vector<std::pair<std::string, std::string>>{
             {"store", cfg.store}, {"endpoint", cfg.endpoint}, {"bucket", cfg.bucket}, {"region", cfg.region},
             {"prefix", "raw/" + naif + "/"}, {"maxKeys", "1000"}}) {
        list.PARAMETERS.push_back(parameter(k, v));
    }
    if (push_apr("list", list) != 0) return 500;
    return 0;
}

// ── diff ────────────────────────────────────────────────────────────────────────────────────────────────────────
struct Probe {
    bool answered = false;
    int status = 0;
    std::string etag, last_modified, error;
    int64_t size = -1;
};
struct Mirrored {
    uint64_t size = 0;
    int64_t modified_ms = 0;
};

std::string header_of(const R::HttpResponse* r, const char* name) {
    if (!r->HEADERS()) return std::string();
    for (const auto* h : *r->HEADERS())
        if (h && h->NAME() && lower(h->NAME()->string_view()) == name) return h->VALUE() ? h->VALUE()->str() : std::string();
    return std::string();
}

// "Wed, 21 Oct 2026 18:12:34 GMT" -> unix ms; 0 when it does not parse.
int64_t days_from_civil(int64_t y, unsigned m, unsigned d) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + static_cast<int64_t>(doe) - 719468;
}
int64_t parse_http_date_ms(const std::string& s) {
    static const char* months[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
    int day = 0, year = 0, hh = 0, mm = 0, ss = 0;
    char mon[4] = {0};
    if (std::sscanf(s.c_str(), "%*3s, %d %3s %d %d:%d:%d", &day, mon, &year, &hh, &mm, &ss) != 6) return 0;
    for (unsigned m = 0; m < 12; ++m)
        if (std::strncmp(mon, months[m], 3) == 0)
            return (((days_from_civil(year, m + 1, static_cast<unsigned>(day)) * 24 + hh) * 60 + mm) * 60 + ss) * 1000;
    return 0;
}

std::unique_ptr<QRPColumnT> column(const char* name, const char* type) {
    auto c = std::make_unique<QRPColumnT>();
    c->NAME = name;
    c->TYPE = type;
    return c;
}
std::unique_ptr<QRPValueT> text_cell(const std::string& v) {
    auto c = std::make_unique<QRPValueT>();
    if (v.empty()) return c;  // Null
    c->KIND = qrpValueKind_Text;
    c->TEXT_VALUE = v;
    return c;
}
std::unique_ptr<QRPValueT> number_cell(int64_t v) {
    auto c = std::make_unique<QRPValueT>();
    if (v < 0) return c;
    c->KIND = qrpValueKind_Int;
    c->INT_VALUE = v;
    return c;
}

int run_diff() {
    const auto probes = frames_on("probes");
    const auto mirrors = frames_on("mirror");
    const auto results = frames_on("mirror_result");
    if (probes.empty() && mirrors.empty() && results.empty()) return 0;
    const Cfg cfg = load_config();
    if (!cfg.error.empty()) return push_status(R::flowNoticeKind_Missing, "unconfigured: " + cfg.error, 0, {});

    // the date
    std::string now_iso;
    {
        const auto now = sdm_piv::call("clock.nowIso");
        if (now.ok()) now_iso = std::string(now.raw("value"));
    }
    if (now_iso.size() < 10) return push_status(R::flowNoticeKind_Missing, "no clock: the report is dated", 0, {});
    const std::string day = now_iso.substr(0, 10);

    // the probes, by table index
    std::map<unsigned, Probe> probe;
    for (const auto* frame : probes) {
        if (!frame->payload || !has_identifier(frame->payload, frame->payload_length, "HRSP") ||
            !verify_unaligned(frame->payload, frame->payload_length, verify_hrsp)) {
            plugin_set_error("invalid-response-frame", "a probes frame is not an HttpResponse (HRSP)");
            return 400;
        }
        const R::HttpResponse* r = R::GetHttpResponse(frame->payload);
        if (!r->CONTEXT() || !has_identifier(r->CONTEXT()->data(), r->CONTEXT()->size(), "$APR")) continue;
        const APR* ctx = GetAPR(r->CONTEXT()->data());
        if (!ctx->REQUEST_ID()) continue;
        const unsigned index = static_cast<unsigned>(std::strtoul(ctx->REQUEST_ID()->c_str(), nullptr, 10));
        if (index >= kWatchSourceCount) continue;
        Probe p;
        p.answered = true;
        p.status = r->STATUS();
        p.error = r->ERROR() ? r->ERROR()->str() : std::string();
        p.etag = header_of(r, "etag");
        p.last_modified = header_of(r, "last-modified");
        const std::string range = header_of(r, "content-range");
        const size_t slash = range.find('/');
        if (slash != std::string::npos) p.size = static_cast<int64_t>(std::strtoll(range.c_str() + slash + 1, nullptr, 10));
        else if (r->STATUS() == 200 && !header_of(r, "content-length").empty()) p.size = std::strtoll(header_of(r, "content-length").c_str(), nullptr, 10);
        probe[index] = p;
    }

    // the mirror
    std::map<std::string, Mirrored> mirror;
    bool mirror_listed = false;
    for (const auto* frame : mirrors) {
        if (!frame->payload || !has_identifier(frame->payload, frame->payload_length, "$FIL") ||
            !verify_unaligned(frame->payload, frame->payload_length, verify_fil)) continue;
        const FIL* listing = GetFIL(frame->payload);
        mirror_listed = true;
        if (listing->ENTRIES())
            for (const auto* e : *listing->ENTRIES())
                if (e && e->NAME() && e->KIND() == filEntryKind_File) mirror[e->NAME()->str()] = Mirrored{e->SIZE(), e->MODIFIED_AT_MS()};
    }
    std::string mirror_error;
    for (const auto* frame : results) {
        if (!frame->payload || !has_identifier(frame->payload, frame->payload_length, "$APR") ||
            !verify_unaligned(frame->payload, frame->payload_length, verify_apr)) continue;
        const APR* a = GetAPR(frame->payload);
        if (a->STATUS() != 200) mirror_error = (a->ERROR_CODE() ? a->ERROR_CODE()->str() : std::string("error")) + " " + std::to_string(a->STATUS());
    }

    QRPT page;
    page.KIND = qrpKind_Page;
    page.STATUS = qrpStatus_Ok;
    for (const char* name : {"body", "naif", "product", "file", "state", "source_url", "serves"}) page.COLUMNS.push_back(column(name, "string"));
    for (const char* name : {"source_etag", "pinned_etag", "source_last_modified", "mirror_key"}) page.COLUMNS.push_back(column(name, "string"));
    for (const char* name : {"source_size", "mirror_size", "mirror_modified_ms"}) page.COLUMNS.push_back(column(name, "int"));
    page.COLUMNS.push_back(column("probe_error", "string"));

    std::map<std::string, uint64_t> counts;
    std::vector<std::string> changed;
    std::string naif;
    for (unsigned i = 0; i < kWatchSourceCount; ++i) {
        const WatchSource& s = kWatchSources[i];
        if (cfg.body != s.body) continue;
        naif = s.naif;
        const Probe p = probe.count(i) ? probe[i] : Probe{};
        const std::string key = std::string("raw/") + s.naif + "/" + s.product + "/" + s.file;
        const auto m = mirror.find(key);
        const bool mirrored = m != mirror.end();
        const std::string pinned = cfg.use_pins ? std::string(s.pinned_etag) : std::string();
        std::string state, why;
        const bool answered = p.answered && (p.status == 206 || p.status == 200);
        if (!answered) {
            state = "probe-failed";
            why = !p.answered ? "no answer" : !p.error.empty() ? p.error : "HTTP " + std::to_string(p.status);
        } else if (!pinned.empty() && !p.etag.empty() && p.etag != pinned) {
            state = "source-changed";
        } else if (mirrored && p.size >= 0 && static_cast<uint64_t>(p.size) != m->second.size) {
            state = "size-changed";
        } else if (mirrored && pinned.empty() && m->second.modified_ms > 0 && parse_http_date_ms(p.last_modified) > m->second.modified_ms) {
            state = "source-newer";
        } else if (!mirrored && mirror_listed) {
            state = "not-mirrored";
        } else {
            state = "current";
        }
        ++counts[state];
        if (state == "source-changed" || state == "source-newer" || state == "size-changed") changed.push_back(std::string(s.product) + "/" + s.file + "=" + state);

        auto row = std::make_unique<QRPRowT>();
        for (const std::string& v : {std::string(s.body), std::string(s.naif), std::string(s.product), std::string(s.file), state, std::string(s.url), std::string(s.serves),
                                     p.etag, pinned, p.last_modified, key}) {
            row->CELLS.push_back(text_cell(v));
        }
        row->CELLS.push_back(number_cell(answered ? p.size : -1));
        row->CELLS.push_back(number_cell(mirrored ? static_cast<int64_t>(m->second.size) : -1));
        row->CELLS.push_back(number_cell(mirrored ? m->second.modified_ms : -1));
        row->CELLS.push_back(text_cell(why));
        page.ROWS.push_back(std::move(row));
    }

    flatbuffers::FlatBufferBuilder b(4096);
    FinishSizePrefixedQRPBuffer(b, QRP::Pack(b, &page));
    if (plugin_push_output_ex("report", "QRP.fbs", QRPIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "QRP", 0, 8,
                              b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0) {
        return 500;
    }
    // stored beside the mirror
    if (!mirror_error.empty() || !mirror_listed) {
        // the mirror could not be read (no credential, store refused): the report is still the source half; do not store a page
        // that claims the mirror is empty
        std::vector<std::string> items = changed;
        items.push_back("mirror=" + (mirror_error.empty() ? std::string("not listed") : mirror_error));
        return push_status(R::flowNoticeKind_Info, "terrain source check, mirror unreadable", page.ROWS.size(), items);
    }
    APRT put;
    put.REQUEST_ID = "watch-put";
    put.ROUTE = "put";
    for (const auto& [k, v] : std::vector<std::pair<std::string, std::string>>{
             {"store", cfg.store}, {"endpoint", cfg.endpoint}, {"bucket", cfg.bucket}, {"region", cfg.region},
             {"key", cfg.report_prefix + "/" + naif + "/" + day + ".qrp"}, {"contentType", "application/x-flatbuffers"}}) {
        put.PARAMETERS.push_back(parameter(k, v));
    }
    put.BODY.assign(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
    if (push_apr("put", put) != 0) return 500;
    std::string summary = "terrain source check " + cfg.body + " " + day + ":";
    for (const auto& [state, n] : counts) summary += " " + state + "=" + std::to_string(n);
    return push_status(changed.empty() ? R::flowNoticeKind_Unchanged : R::flowNoticeKind_Info, summary, page.ROWS.size(), changed);
}

}  // namespace

extern "C" {

int plan(void) { return run_plan(); }
int diff(void) { return run_diff(); }

}  // extern "C"
