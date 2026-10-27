/*
 * data-source/spacex-starlink-source (typed contracts 1.0: FlatBuffers only, no JSON and no base64).
 *
 * SpaceX Starlink operator ephemeris (the public MEME files at api.starlink.com) as SDS $OEM, in memory only, for the
 * OD flow. No credentials and no capabilities beyond the node config: the http connector (hostcap/http-request) does
 * the fetching.
 *
 *   plan           : TimerTick (TICK) -> one HttpRequest (HREQ): GET the ephemeris MANIFEST.txt.
 *   select_objects : the manifest's HttpResponse (HRSP) -> one HttpRequest per MEME file in the window
 *                    [offset, offset + count) of the first objectCap entries (default: the whole manifest), each a
 *                    leading byte range (rangeBytes, default 128 KiB: the fit window, ~2-3 orbits; 0 = the whole
 *                    file), 16 per invocation, the rest yielded as backlog. probe = true: a FlowNotice Info
 *                    ("object-count", COUNT the objects the pull would cover) and no requests.
 *   emit           : the MEME files' HttpResponses -> one SDS $OEM per object on "oem" (explicit state epochs and supplied covariance,
 *                    CelestialFrame EME2000, UTC). An object answered other than 200/206, empty, or without a state is
 *                    a FlowNotice Missing; nothing is stored, signed or published (the OD-flow invariant).
 *
 * JOB STATE TRAVELS AS HttpRequest.CONTEXT: one size-prefixed $OEM HEADER RECORD per object (one ephemeris data block
 * whose OBJECT names it - OBJECT_NAME and NORAD_CAT_ID from the MEME filename - and no states), built by
 * select_objects, echoed by the http connector, read by emit as the object's identity. Pairing is by CONTEXT, never by
 * position or URL.
 *
 * Node CONFIG through plugin.getConfig (SDS $PIV: one ModuleConfig on raw "config", read through
 * sdm_piv::get_config()): manifestUrl, objectCap (<= 0: unlimited), offset, count, rangeBytes, probe, timeoutMs.
 */
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"
#include "FlowNotice_generated.h"

#define MEME_OEM_TYPES_INLINED 1
#define MEME_OEM_FRAME CelestialFrame_EME2000
#define MEME_OEM_TIME_SYSTEM timingStandard_UTC
#define MEME_OEM_COV_ORBIT_FRAME OrbitFrame_RSW_INERTIAL
#include "meme_oem.hpp"

namespace {

namespace R = sdn::runtime;
using Bytes = std::vector<uint8_t>;

constexpr const char* kBaseURL = "https://api.starlink.com/public-files/ephemerides/";
constexpr const char* kDefaultManifestURL = "https://api.starlink.com/public-files/ephemerides/MANIFEST.txt";
constexpr const char* kProviderID = "spacex-starlink";
constexpr double kDefaultRangeBytes = 131072;   // ~270 states, ~2.8 orbits of a Starlink MEME file
constexpr uint32_t kRequestBatch = 16;          // object requests handed out per select_objects invocation

// ---- frames -------------------------------------------------------------------------------------------------------

std::vector<const plugin_input_frame_t*> frames_on(const char* port) {
    std::vector<const plugin_input_frame_t*> out;
    for (uint32_t ordinal = 0;; ordinal++) {
        const int32_t idx = plugin_find_input_index(port, ordinal);
        if (idx < 0) break;
        out.push_back(plugin_get_input_frame(static_cast<uint32_t>(idx)));
    }
    return out;
}

const R::HttpResponse* response_of(const plugin_input_frame_t* frame) {
    if (!frame || !frame->payload || frame->payload_length == 0) return nullptr;
    flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    return R::VerifyHttpResponseBuffer(verifier) ? R::GetHttpResponse(frame->payload) : nullptr;
}

Bytes http_get(const std::string& url, long range_bytes, uint32_t timeout_ms, const Bytes* context) {
    flatbuffers::FlatBufferBuilder b(512 + (context ? context->size() : 0));
    std::vector<flatbuffers::Offset<R::Header>> headers;
    if (range_bytes > 0)
        headers.push_back(R::CreateHeaderDirect(b, "range", ("bytes=0-" + std::to_string(range_bytes - 1)).c_str()));
    R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, "GET", url.c_str(), &headers, nullptr, timeout_ms, 0, context));
    return Bytes(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

int push_request(const Bytes& request) {
    return plugin_push_output_ex("requests", "HttpRequest.fbs", R::HttpRequestIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "HttpRequest", 0, 0, request.data(), static_cast<uint32_t>(request.size()));
}

int push_notice(R::flowNoticeKind kind, const std::string& reason, uint64_t count = 0, std::vector<std::string> items = {}) {
    R::FlowNoticeT notice;
    notice.KIND = kind;
    notice.SCHEMA = "OEM.fbs";
    notice.PROVIDER_ID = kProviderID;
    notice.REASON = reason;
    notice.COUNT = count;
    notice.ITEMS = std::move(items);
    flatbuffers::FlatBufferBuilder b(256);
    R::FinishFlowNoticeBuffer(b, R::FlowNotice::Pack(b, &notice));
    return plugin_push_output_ex("status", "FlowNotice.fbs", R::FlowNoticeIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "FlowNotice", 0, 0, b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize()));
}

bool refuse_batched(const char* port) {
    const std::vector<const plugin_input_frame_t*> frames = frames_on(port);
    if (frames.size() <= 1) return false;
    char message[320];
    std::snprintf(message, sizeof(message),
                  "This invocation carries %u frames on single-stream input port \"%s\" (the compiled flow runtime drains a "
                  "node's whole queue port-blind; maxStreams is declarative only). The surplus frames are refused rather "
                  "than silently discarded.",
                  static_cast<unsigned>(frames.size()), port);
    plugin_set_error("batched-input-frames", message);
    return true;
}

// ---- config -------------------------------------------------------------------------------------------------------

struct PullConfig {
    std::string manifest_url = kDefaultManifestURL;
    long object_cap = 0;     // <= 0: unlimited (the whole constellation)
    long offset = -1;        // < 0: from the first entry
    long count = -1;         // < 0: to the end of [0, total)
    long range_bytes = static_cast<long>(kDefaultRangeBytes);   // 0: the whole file, no range header
    bool probe = false;
    uint32_t timeout_ms = 0; // 0: the connector's default
};

PullConfig load_config() {
    const sdm_piv::Config c = sdm_piv::get_config();
    PullConfig p;
    const std::string url(c.string("manifestUrl", ""));
    if (!url.empty()) p.manifest_url = url;
    const double cap = c.number("objectCap", -1);
    if (cap > 0) p.object_cap = static_cast<long>(cap);
    const double off = c.number("offset", -1);
    if (off >= 0) p.offset = static_cast<long>(off);
    const double cnt = c.number("count", -1);
    if (cnt >= 0) p.count = static_cast<long>(cnt);
    const double rb = c.number("rangeBytes", -1);
    if (rb >= 0) p.range_bytes = static_cast<long>(rb);
    p.probe = c.boolean("probe", false);
    const double timeout = c.number("timeoutMs", 0);
    if (timeout > 0) p.timeout_ms = static_cast<uint32_t>(timeout);
    return p;
}

// ---- the manifest -------------------------------------------------------------------------------------------------

// One trimmed MEME filename per non-empty line that names one.
std::vector<std::string> manifest_entries(const R::HttpResponse& r) {
    std::vector<std::string> lines;
    if (!r.BODY()) return lines;
    const std::string s(reinterpret_cast<const char*>(r.BODY()->data()), r.BODY()->size());
    size_t start = 0;
    while (start <= s.size()) {
        const size_t nl = s.find('\n', start);
        const std::string line = s.substr(start, (nl == std::string::npos ? s.size() : nl) - start);
        const size_t a = line.find_first_not_of(" \t\r");
        const size_t b = line.find_last_not_of(" \t\r");
        if (a != std::string::npos) {
            const std::string t = line.substr(a, b - a + 1);
            if (t.find("MEME_") != std::string::npos) lines.push_back(t);
        }
        if (nl == std::string::npos) break;
        start = nl + 1;
    }
    return lines;
}

// The job: a size-prefixed $OEM with one ephemeris data block naming the object, no states.
Bytes object_header(const meme_oem::MemeMeta& m) {
    flatbuffers::FlatBufferBuilder b(256);
    const auto name = b.CreateString(m.object_name);
    CATBuilder cat(b);
    cat.add_OBJECT_NAME(name);
    cat.add_NORAD_CAT_ID(static_cast<uint32_t>(m.norad_cat_id));
    const auto object = cat.Finish();
    ephemerisDataBlockBuilder block(b);
    block.add_OBJECT(object);
    const std::vector<flatbuffers::Offset<ephemerisDataBlock>> blocks{block.Finish()};
    const auto blocks_vec = b.CreateVector(blocks);
    OEMBuilder oem(b);
    oem.add_EPHEMERIS_DATA_BLOCK(blocks_vec);
    FinishSizePrefixedOEMBuffer(b, oem.Finish());
    return Bytes(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

const CAT* job_of(const R::HttpResponse& r) {
    const auto* context = r.CONTEXT();
    if (!context || context->size() < 8) return nullptr;
    flatbuffers::Verifier verifier(context->data(), context->size());
    if (!VerifySizePrefixedOEMBuffer(verifier)) return nullptr;
    const OEM* header = GetSizePrefixedOEM(context->data());
    if (!header->EPHEMERIS_DATA_BLOCK() || header->EPHEMERIS_DATA_BLOCK()->size() != 1) return nullptr;
    const CAT* object = header->EPHEMERIS_DATA_BLOCK()->Get(0)->OBJECT();
    return object && object->OBJECT_NAME() ? object : nullptr;
}

// ---- backlog ------------------------------------------------------------------------------------------------------

std::vector<Bytes> g_backlog;
size_t g_next = 0;

int emit_backlog() {
    uint32_t emitted = 0;
    while (g_next < g_backlog.size() && emitted < kRequestBatch) {
        if (push_request(g_backlog[g_next++]) < 0) return 500;
        emitted++;
    }
    const uint32_t remaining = static_cast<uint32_t>(g_backlog.size() - g_next);
    if (remaining == 0) { g_backlog.clear(); g_next = 0; }
    plugin_set_backlog_remaining(remaining);
    plugin_set_yielded(remaining > 0 ? 1 : 0);
    return 0;
}

}  // namespace

extern "C" {

int plan(void) {
    if (refuse_batched("tick")) return 500;
    if (frames_on("tick").empty()) { plugin_set_error("missing-tick", "plan requires a TimerTick on \"tick\"."); return 400; }
    const PullConfig cfg = load_config();
    return push_request(http_get(cfg.manifest_url, 0, cfg.timeout_ms, nullptr)) < 0 ? 500 : 0;
}

int select_objects(void) {
    if (plugin_get_input_count() == 0) return emit_backlog();
    if (refuse_batched("manifest")) return 500;
    const R::HttpResponse* r = response_of(frames_on("manifest").empty() ? nullptr : frames_on("manifest")[0]);
    if (!r) { plugin_set_error("invalid-response-frame", "the manifest frame is not an HttpResponse (HRSP)."); return 400; }
    const PullConfig cfg = load_config();
    if (r->STATUS() != 200) {
        const std::string url = r->URL() ? r->URL()->str() : cfg.manifest_url;
        return push_notice(R::flowNoticeKind_Missing, "manifest-unavailable", 1,
                           {url + ": HTTP " + std::to_string(r->STATUS()) +
                            (r->ERROR() && r->ERROR()->size() ? " (" + r->ERROR()->str() + ")" : std::string())}) < 0 ? 500 : 0;
    }
    const std::vector<std::string> entries = manifest_entries(*r);
    long total = static_cast<long>(entries.size());
    if (cfg.object_cap > 0 && total > cfg.object_cap) total = cfg.object_cap;
    if (cfg.probe) return push_notice(R::flowNoticeKind_Info, "object-count", static_cast<uint64_t>(total)) < 0 ? 500 : 0;
    long start = cfg.offset >= 0 ? cfg.offset : 0;
    long end = cfg.count >= 0 ? start + cfg.count : total;
    if (start > total) start = total;
    if (end > total) end = total;
    for (long i = start; i < end; ++i) {
        const std::string& filename = entries[static_cast<size_t>(i)];
        meme_oem::MemeMeta m;
        meme_oem::parse_meme_filename(filename, &m);
        const Bytes header = object_header(m);
        g_backlog.push_back(http_get(std::string(kBaseURL) + filename, cfg.range_bytes, cfg.timeout_ms, &header));
    }
    if (g_backlog.size() == g_next) return push_notice(R::flowNoticeKind_Skipped, "nothing-to-fetch") < 0 ? 500 : 0;
    return emit_backlog();
}

int emit(void) {
    const std::vector<const plugin_input_frame_t*> frames = frames_on("ephemerides");
    std::vector<std::string> missing;
    for (size_t k = 0; k < frames.size(); k++) {
        const R::HttpResponse* r = response_of(frames[k]);
        if (!r) {
            plugin_set_error("invalid-response-frame", ("ephemeris " + std::to_string(k) + " is not an HttpResponse (HRSP)").c_str());
            return 400;
        }
        const CAT* job = job_of(*r);
        const std::string url = r->URL() ? r->URL()->str() : std::string();
        if (!job) {
            plugin_set_error("missing-context", ("ephemeris " + std::to_string(k) + " (" + url +
                                                 ") carries no $OEM object header in CONTEXT; it cannot be attributed and is refused.").c_str());
            return 400;
        }
        const std::string label = job->OBJECT_NAME()->str() + " (" + std::to_string(job->NORAD_CAT_ID()) + ")";
        // Range servers answer 206 (the prefix), others 200 (the whole file).
        if ((r->STATUS() != 200 && r->STATUS() != 206) || !r->BODY() || r->BODY()->size() == 0) {
            missing.push_back(label + ": HTTP " + std::to_string(r->STATUS()) +
                              (r->ERROR() && r->ERROR()->size() ? " (" + r->ERROR()->str() + ")" : std::string()));
            continue;
        }
        meme_oem::MemeMeta m;
        m.norad_cat_id = job->NORAD_CAT_ID();
        m.object_name = job->OBJECT_NAME()->str();
        meme_oem::Document document;
        std::string why;
        const std::string content(reinterpret_cast<const char*>(r->BODY()->data()), r->BODY()->size());
        if (!meme_oem::parse_document(content, m, r->STATUS() == 206, &document, &why)) {
            missing.push_back(label + ": " + why); continue;
        }
        const Bytes oem = meme_oem::build_oem_fb(document);
        if (oem.empty()) { missing.push_back(label + ": no state vectors"); continue; }
        if (plugin_push_output_ex("oem", "OEM.fbs", OEMIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "OEM", 0, 0, oem.data(),
                                  static_cast<uint32_t>(oem.size())) < 0)
            return 500;
    }
    if (!missing.empty() && push_notice(R::flowNoticeKind_Missing, "objects-unavailable", missing.size(), missing) < 0) return 500;
    return 0;
}

}  // extern "C"
