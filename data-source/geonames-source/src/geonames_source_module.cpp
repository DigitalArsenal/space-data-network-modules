/*
 * data-source/geonames-source — the PURE half of the GeoNames gazetteer lane (graph task `geonames-ingest-flow`),
 * on the typed contracts (1.0): FlatBuffers only between modules, no JSON and no base64.
 *
 * This plugin performs NO I/O. `capabilities: []`, runtime targets browser + wasmedge, every method a single-pass
 * transform over the frames the flow hands it; its one hostcall is the builtin plugin.getConfig (SDS $PIV) for the
 * operator's record cap. Every byte it decodes was fetched by `com.digitalarsenal.hostcap.http-request` (an
 * HttpResponse, HRSP) and every record it emits is persisted by `com.digitalarsenal.hostcap.storage-ingest`. The split
 * mirrors cell-tower-source / cell-tower-ingest: parsing a gazetteer dump and orchestrating a scheduled ingest of it are
 * different jobs with different blast radii, and folding them together would make the parser un-runnable in a browser.
 *
 * Methods:
 *   inflate       response (HRSP)                          -> text (HRSP, BODY = the decoded text), report (FNTC)
 *   parse_places  text (HRSP) + admin1/admin2/country (HRSP) -> records ($GNP stream), decision (FNTC)
 *   parse_deletes text (HRSP)                              -> tombstones (FNTC)
 *
 * THE JOB TRAVELS AS HttpRequest.CONTEXT. geonames-ingest puts ONE size-prefixed $GNP HEADER RECORD (no position, no
 * place) in the CONTEXT of every fetch it plans; hostcap/http-request echoes it in the HttpResponse, inflate copies it
 * into the text frame, and the decoders read it as the run contract:
 *   ID                     the id prefix every record is minted under ("<ID>:<geonameid>"; empty reads as "geonames")
 *   NAME                   the gazetteer text the job decodes: the archive MEMBER for a .zip edition (empty = the
 *                          archive's first member), else the plain file's own name
 *   DEM_MODEL              the model DEM_ELEVATION_M was sampled from, when stated
 *   SOURCE (GNPProvenance) the DATASET CONTRACT every record is published under: DATASET_ID, DATASET_NAME, DATASET_URL,
 *                          DATASET_EPOCH, DATASET_CID, SOURCE_URL, SOURCE_QUERY (the file selection: a ".zip" selection
 *                          is an archive inflated in-guest, anything else is served plain), LICENSE, LICENSE_URL,
 *                          ATTRIBUTION, NON_COMMERCIAL_ONLY, SHARE_ALIKE. RETRIEVED_AT and NATIVE_ID are per record
 *                          and are empty on the header.
 * This replaces the JSON job frame and its lane/container/member keys, which were all functions of the file selection.
 *
 * WHY THE INFLATE IS IN-GUEST. The seed edition ships as `cities15000.zip` — one ZIP holding one 19-column
 * tab-separated file. There is NO host unzip capability and none may be added, so miniz 3.1.2 is vendored under
 * vendor/miniz-3.1.2 (MIT; LICENSE carried verbatim, SHA-256 pinned and re-verified on every build by miniz-source.mjs)
 * and the central directory is walked by hand — the same vendored copy data-source/cell-tower-source uses.
 *
 * WHY THE ADMIN/COUNTRY FILES ARE INPUTS OF parse_places. $GNP requires RESOLVED NAMES beside the codes ("Carried
 * beside the code so a consumer need not hold the division tables to render a place"); GeoNames publishes them in three
 * plain-text files. They used to be folded by a parse_lookups method into a JSON join table for parse_places; no SDS
 * record models a code-to-name join table, so on the typed contracts the three HttpResponses go to parse_places itself
 * and the join is built and applied in one pass. A file the flow did not fetch contributes nothing and the affected
 * places carry their codes with the name UNSET — a missing name is recoverable, a wrong one is not.
 *
 * NOTHING IS INVENTED. A column GeoNames leaves empty is left UNSET on the record rather than defaulted: FlatBuffers
 * omits default-valued fields, which is what keeps "no elevation published" distinguishable from "an elevation of zero"
 * — the distinction $GNP's ELEVATION_PUBLISHED exists to carry. Time-zone UTC offsets are NOT in this file, so they are
 * never written.
 */

#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <map>
#include <string>
#include <sys/time.h>
#include <vector>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "HttpResponse_generated.h"
#include "FlowNotice_generated.h"
// $GNP (spacedatastandards.org lib/cpp/GNP/main_generated.h) and miniz 3.1.2 are inlined ahead of this file by build.mjs.

namespace {

namespace A = sdn::runtime::Aligned;
namespace R = sdn::runtime;

using Bytes = std::vector<uint8_t>;

// ── node config: plugin.getConfig as an SDS $PIV hostcall (one ModuleConfig FlatBuffer on raw "config") ──────────
//
// Read for ONE key only: geonames_limit, the operator's record cap (0 / absent = no cap). It used to ride on the JSON
// job frame; the job is a $GNP header now and a place record has no field for "how many records", so the cap is read
// from the same node config geonames-ingest reads it from. No config (a browser, a host with no config) = no cap.
double config_number(const char* key, double fallback) {
    const sdm_piv::Config config = sdm_piv::get_config();
    if (!config.ok()) return fallback;
    if (config.kind(key) == sdn::runtime::configValueKind_String) {
        const std::string s(config.string(key));
        char* end = nullptr;
        const double v = strtod(s.c_str(), &end);
        return end != s.c_str() ? v : fallback;
    }
    return config.number(key, fallback);
}

// ── frames ────────────────────────────────────────────────────────────────────────────────────────────────────

const plugin_input_frame_t* frame_for(const char* port_id) {
    const int32_t idx = plugin_find_input_index(port_id, 0);
    if (idx < 0) return nullptr;
    return plugin_get_input_frame(static_cast<uint32_t>(idx));
}

// The HttpResponse on `port`, verified; nullptr when the port carries no frame. *bad is set when it carries a frame
// that is not an HttpResponse.
const R::HttpResponse* response_on(const char* port, bool* bad) {
    const plugin_input_frame_t* f = frame_for(port);
    if (!f || !f->payload || f->payload_length == 0) return nullptr;
    flatbuffers::Verifier verifier(f->payload, f->payload_length);
    if (!R::VerifyHttpResponseBuffer(verifier)) {
        *bad = true;
        return nullptr;
    }
    return R::GetHttpResponse(f->payload);
}

std::string body_of(const R::HttpResponse* r) {
    if (!r || !r->BODY()) return std::string();
    return std::string(reinterpret_cast<const char*>(r->BODY()->data()), r->BODY()->size());
}

// A response header by lower-case name (the connector writes HEADERS sorted by lower-case NAME).
std::string header_of(const R::HttpResponse* r, const char* name) {
    if (!r || !r->HEADERS()) return std::string();
    for (const auto* h : *r->HEADERS()) {
        if (!h || !h->NAME()) continue;
        const std::string n = h->NAME()->str();
        if (n.size() != std::strlen(name)) continue;
        bool same = true;
        for (size_t i = 0; i < n.size() && same; i++) same = std::tolower(static_cast<unsigned char>(n[i])) == name[i];
        if (same) return h->VALUE() ? h->VALUE()->str() : std::string();
    }
    return std::string();
}

int push_notice(const char* port, R::flowNoticeKind kind, const std::string& reason, uint64_t count,
                std::vector<std::string> items, const std::string& source_name = std::string(), uint64_t at_ms = 0) {
    R::FlowNoticeT notice;
    notice.KIND = kind;
    notice.SCHEMA = "GNP.fbs";
    notice.SOURCE_NAME = source_name;
    notice.REASON = reason;
    notice.COUNT = count;
    notice.ITEMS = std::move(items);
    notice.AT_MS = at_ms;
    flatbuffers::FlatBufferBuilder b(512);
    R::FinishFlowNoticeBuffer(b, R::FlowNotice::Pack(b, &notice));
    return plugin_push_output_ex(port, "FlowNotice.fbs", R::FlowNoticeIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "FlowNotice", 0, 0, b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize()));
}

int push_gnp_stream(const char* port, const Bytes& bytes) {
    return plugin_push_output_ex(port, "GNP.fbs", GNPIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "GNP", 0, 0,
                                 bytes.data(), static_cast<uint32_t>(bytes.size()));
}

// SURPLUS-FRAME REFUSAL. The compiled flow runtime drains a node's queue PORT-BLIND up to a budget of 64;
// maxStreams/maxBatch/drainPolicy are purely declarative there. A guest that reads ordinal 0 and returns therefore
// destroys every other frame it was handed, with nothing re-delivering them and nothing logging the loss (the live P1
// that produced `modules-guest-nodes-drop-batched-frames`). Every input port here is single-stream BY CONTRACT, so a
// surplus is refused by name.
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

bool refuse_batched(void) {
    char message[384];
    if (!find_batched_input_port(message, sizeof(message))) return false;
    plugin_set_error("batched-input-frames", message);
    return true;
}

// ── the job: the $GNP header record in the response's CONTEXT ────────────────────────────────────────────────

struct Job {
    bool present = false;
    std::string id_prefix;
    std::string text_name;  // NAME: the archive member (zip) or the plain file
    std::string dem_model;
    std::string dataset_id, dataset_name, dataset_url, dataset_epoch, dataset_cid;
    std::string source_url, source_query;
    std::string license, license_url, attribution;
    bool share_alike = false;
    bool non_commercial_only = false;

    bool zip() const {
        return source_query.size() >= 4 && source_query.compare(source_query.size() - 4, 4, ".zip") == 0;
    }
    // The edition's UTC date, the first ten characters of its RFC 3339 epoch.
    std::string date() const { return dataset_epoch.size() >= 10 ? dataset_epoch.substr(0, 10) : dataset_epoch; }
};

std::string str_of(const flatbuffers::String* s) { return s ? s->str() : std::string(); }

// Unix milliseconds of an RFC 3339 instant's date and time ("YYYY-MM-DDTHH:MM:SS..."); 0 when it is not one.
uint64_t epoch_ms(const std::string& iso) {
    if (iso.size() < 10 || iso[4] != '-' || iso[7] != '-') return 0;
    int64_t y = atoi(iso.substr(0, 4).c_str());
    const int m = atoi(iso.substr(5, 2).c_str()), d = atoi(iso.substr(8, 2).c_str());
    int hh = 0, mm = 0, ss = 0;
    if (iso.size() >= 19 && iso[10] == 'T') {
        hh = atoi(iso.substr(11, 2).c_str());
        mm = atoi(iso.substr(14, 2).c_str());
        ss = atoi(iso.substr(17, 2).c_str());
    }
    if (y < 1970 || m < 1 || m > 12 || d < 1 || d > 31) return 0;
    y -= m <= 2;
    const int64_t era = y / 400;
    const int64_t yoe = y - era * 400;
    const int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    const int64_t days = era * 146097 + doe - 719468;
    return static_cast<uint64_t>(((days * 24 + hh) * 60 + mm) * 60 + ss) * 1000u;
}

// The job a response carries back in CONTEXT; !present when it carries none (or not a $GNP).
Job job_of(const R::HttpResponse* r) {
    Job job;
    if (!r || !r->CONTEXT() || r->CONTEXT()->size() < 8) return job;
    flatbuffers::Verifier verifier(r->CONTEXT()->data(), r->CONTEXT()->size());
    if (!VerifySizePrefixedGNPBuffer(verifier)) return job;
    const GNP* header = GetSizePrefixedGNP(r->CONTEXT()->data());
    const GNPProvenance* source = header->SOURCE();
    if (!source) return job;
    job.present = true;
    job.id_prefix = str_of(header->ID());
    if (job.id_prefix.empty()) job.id_prefix = "geonames";
    job.text_name = str_of(header->NAME());
    job.dem_model = str_of(header->DEM_MODEL());
    job.dataset_id = str_of(source->DATASET_ID());
    job.dataset_name = str_of(source->DATASET_NAME());
    job.dataset_url = str_of(source->DATASET_URL());
    job.dataset_epoch = str_of(source->DATASET_EPOCH());
    job.dataset_cid = str_of(source->DATASET_CID());
    job.source_url = str_of(source->SOURCE_URL());
    job.source_query = str_of(source->SOURCE_QUERY());
    job.license = str_of(source->LICENSE());
    job.license_url = str_of(source->LICENSE_URL());
    job.attribution = str_of(source->ATTRIBUTION());
    job.share_alike = source->SHARE_ALIKE();
    job.non_commercial_only = source->NON_COMMERCIAL_ONLY();
    return job;
}

std::string iso_now() {
    struct timeval tv;
    if (gettimeofday(&tv, nullptr) != 0) return std::string("1970-01-01T00:00:00.000Z");
    const time_t secs = static_cast<time_t>(tv.tv_sec);
    struct tm utc;
    if (gmtime_r(&secs, &utc) == nullptr) return std::string("1970-01-01T00:00:00.000Z");
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", utc.tm_year + 1900,
                  utc.tm_mon + 1, utc.tm_mday, utc.tm_hour, utc.tm_min, utc.tm_sec,
                  static_cast<int>(tv.tv_usec / 1000));
    return std::string(buf);
}

// ── ZIP member lookup ──────────────────────────────────────────────────────
//
// miniz is compiled with MINIZ_NO_ARCHIVE_APIS (see miniz-source.mjs), which
// removes mz_zip_*; the central directory is therefore walked by hand. tinfl_*
// survives that define (it is gated by MINIZ_NO_INFLATE_APIS, which is NOT
// set). Adapted from cell_tower_source_module.cpp's zip_find_member, with one
// change: an EMPTY `want` selects the archive's FIRST member, because the
// GeoNames dumps hold exactly one file each and pinning its name would break
// the lane on a rename the publisher is free to make.
struct ZipEntry {
    size_t data_offset = 0;
    uint32_t compressed_size = 0;
    uint32_t uncompressed_size = 0;
    uint16_t method = 0;  // 0 = stored, 8 = deflate
    std::string name;
    bool found = false;
};

uint16_t le16(const std::string& b, size_t at) {
    return static_cast<uint16_t>(static_cast<uint8_t>(b[at])) |
           (static_cast<uint16_t>(static_cast<uint8_t>(b[at + 1])) << 8);
}

uint32_t le32(const std::string& b, size_t at) {
    return static_cast<uint32_t>(static_cast<uint8_t>(b[at])) |
           (static_cast<uint32_t>(static_cast<uint8_t>(b[at + 1])) << 8) |
           (static_cast<uint32_t>(static_cast<uint8_t>(b[at + 2])) << 16) |
           (static_cast<uint32_t>(static_cast<uint8_t>(b[at + 3])) << 24);
}

// The CENTRAL DIRECTORY is the authority for the sizes, never the local header:
// a ZIP written with a data descriptor (general-purpose flag bit 3) carries
// zeroes for both sizes in the local header, and reading those would inflate
// zero bytes and report an empty gazetteer — a parse-to-nothing that is
// indistinguishable from a day on which nothing changed.
ZipEntry zip_find_member(const std::string& body, const std::string& want) {
    ZipEntry e;
    if (body.size() < 22) return e;
    // Scan BACKWARDS for the end-of-central-directory over the permitted 64 KiB
    // comment. Searching forward is wrong — "PK\x05\x06" occurs inside
    // compressed data.
    const size_t floor_at = body.size() > 66000 ? body.size() - 66000 : 0;
    size_t eocd = std::string::npos;
    for (size_t i = body.size() - 22 + 1; i-- > floor_at;) {
        if (body[i] == 'P' && body[i + 1] == 'K' &&
            static_cast<uint8_t>(body[i + 2]) == 0x05 &&
            static_cast<uint8_t>(body[i + 3]) == 0x06) {
            eocd = i;
            break;
        }
    }
    if (eocd == std::string::npos || eocd + 22 > body.size()) return e;

    const uint16_t entries = le16(body, eocd + 10);
    const uint32_t cd_offset = le32(body, eocd + 16);
    if (cd_offset == 0xFFFFFFFFu) return e;  // ZIP64: refused, never guessed
    size_t p = cd_offset;

    for (uint16_t n = 0; n < entries; ++n) {
        if (p + 46 > body.size()) return e;
        if (!(body[p] == 'P' && body[p + 1] == 'K' &&
              static_cast<uint8_t>(body[p + 2]) == 0x01 &&
              static_cast<uint8_t>(body[p + 3]) == 0x02)) {
            return e;
        }
        const uint16_t flags = le16(body, p + 8);
        const uint16_t method = le16(body, p + 10);
        const uint32_t csize = le32(body, p + 20);
        const uint32_t usize = le32(body, p + 24);
        const uint16_t name_len = le16(body, p + 28);
        const uint16_t extra_len = le16(body, p + 30);
        const uint16_t comment_len = le16(body, p + 32);
        const uint32_t local_at = le32(body, p + 42);
        if (p + 46 + name_len > body.size()) return e;
        const std::string name = body.substr(p + 46, name_len);
        p += 46u + name_len + extra_len + comment_len;

        if (!want.empty() && name != want) continue;
        if (flags & 0x0001) return e;  // encrypted: refused, never decoded to noise
        if (csize == 0xFFFFFFFFu || usize == 0xFFFFFFFFu || local_at == 0xFFFFFFFFu) return e;
        if (method != 0 && method != 8) return e;
        if (local_at + 30 > body.size()) return e;
        if (!(body[local_at] == 'P' && body[local_at + 1] == 'K' &&
              static_cast<uint8_t>(body[local_at + 2]) == 0x03 &&
              static_cast<uint8_t>(body[local_at + 3]) == 0x04)) {
            return e;
        }
        const uint16_t l_name = le16(body, local_at + 26);
        const uint16_t l_extra = le16(body, local_at + 28);
        const size_t data_at = local_at + 30u + l_name + l_extra;
        if (data_at + csize > body.size()) return e;
        e.data_offset = data_at;
        e.compressed_size = csize;
        e.uncompressed_size = usize;
        e.method = method;
        e.name = name;
        e.found = true;
        return e;
    }
    return e;
}

// ── tab-separated row splitting ────────────────────────────────────────────
//
// GeoNames dumps are TAB-separated with NO quoting: a field ends at the next
// tab, full stop. So this is a split and not a CSV parse, and treating a quote
// as significant would corrupt names that legitimately contain one.
std::vector<std::string> split_tabs(const std::string& line) {
    std::vector<std::string> out;
    size_t start = 0;
    for (size_t i = 0; i <= line.size(); ++i) {
        if (i == line.size() || line[i] == '\t') {
            out.push_back(line.substr(start, i - start));
            start = i + 1;
        }
    }
    return out;
}

std::vector<std::string> split_commas(const std::string& value) {
    std::vector<std::string> out;
    if (value.empty()) return out;
    size_t start = 0;
    for (size_t i = 0; i <= value.size(); ++i) {
        if (i == value.size() || value[i] == ',') {
            const std::string piece = value.substr(start, i - start);
            if (!piece.empty()) out.push_back(piece);
            start = i + 1;
        }
    }
    return out;
}

// Feature class letters as GeoNames publishes them, mapped onto the enum $GNP
// models. An unmodelled letter falls to UNSPECIFIED and the letter itself still
// rides verbatim in FEATURE_CLASS_CODE, so nothing is lost — that is exactly
// what the IDL says the code field is for.
gnpFeatureClass feature_class_of(const std::string& code) {
    if (code.size() != 1) return gnpFeatureClass_UNSPECIFIED;
    switch (code[0]) {
        case 'A': return gnpFeatureClass_ADMINISTRATIVE;
        case 'H': return gnpFeatureClass_HYDROGRAPHIC;
        case 'L': return gnpFeatureClass_AREA;
        case 'P': return gnpFeatureClass_POPULATED_PLACE;
        case 'R': return gnpFeatureClass_TRANSPORT;
        case 'S': return gnpFeatureClass_SPOT;
        case 'T': return gnpFeatureClass_HYPSOGRAPHIC;
        case 'U': return gnpFeatureClass_UNDERSEA;
        case 'V': return gnpFeatureClass_VEGETATION;
        default: return gnpFeatureClass_UNSPECIFIED;
    }
}


template <typename OnLine>
void for_each_line(const std::string& text, OnLine on_line) {
    size_t start = 0;
    while (start <= text.size()) {
        size_t nl = text.find('\n', start);
        if (nl == std::string::npos) {
            size_t tail = text.size();
            if (tail > start && text[tail - 1] == '\r') tail--;
            if (tail > start) on_line(text.substr(start, tail - start));
            return;
        }
        size_t end = nl;
        if (end > start && text[end - 1] == '\r') end--;
        if (end > start) {
            if (!on_line(text.substr(start, end - start))) return;
        }
        start = nl + 1;
    }
}


enum GeoNameColumn {
    COL_GEONAMEID = 0,
    COL_NAME = 1,
    COL_ASCIINAME = 2,
    COL_ALTERNATENAMES = 3,
    COL_LATITUDE = 4,
    COL_LONGITUDE = 5,
    COL_FEATURE_CLASS = 6,
    COL_FEATURE_CODE = 7,
    COL_COUNTRY_CODE = 8,
    COL_CC2 = 9,
    COL_ADMIN1 = 10,
    COL_ADMIN2 = 11,
    COL_ADMIN3 = 12,
    COL_ADMIN4 = 13,
    COL_POPULATION = 14,
    COL_ELEVATION = 15,
    COL_DEM = 16,
    COL_TIMEZONE = 17,
    COL_MODIFICATION_DATE = 18,
    GEONAME_COLUMNS = 19,
};


// The gazetteer text as an HttpResponse: the fetched response with its BODY replaced by `text` and everything else
// (URL, STATUS, HEADERS, the job in CONTEXT, RETRIEVED_MS) carried verbatim, so the decoders read the job the fetch
// was planned with and nothing downstream needs to know whether the edition arrived compressed.
int push_text(const R::HttpResponse& response, const std::string& text) {
    R::HttpResponseT t;
    response.UnPackTo(&t);
    t.BODY.assign(text.begin(), text.end());
    flatbuffers::FlatBufferBuilder b(text.size() + (response.CONTEXT() ? response.CONTEXT()->size() : 0) + 1024);
    R::FinishHttpResponseBuffer(b, R::HttpResponse::Pack(b, &t));
    return plugin_push_output_ex("text", "HttpResponse.fbs", R::HttpResponseIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "HttpResponse", 0, 0, b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize()));
}

struct Lookups {
    std::map<std::string, std::string> admin1;
    std::map<std::string, std::string> admin2;
    std::map<std::string, std::string> country;
};

std::string lookup_or_empty(const std::map<std::string, std::string>& table, const std::string& key) {
    if (key.empty()) return std::string();
    const auto it = table.find(key);
    return it == table.end() ? std::string() : it->second;
}

}  // namespace

extern "C" {

// ---------------------------------------------------------------------------
// inflate — the ZIP/deflate assembly step.
//
// Takes the fetched HttpResponse and hands the next node the PLAIN TEXT as an HttpResponse (BODY = the text, CONTEXT =
// the job, verbatim), so parse_places never has to know whether the edition arrived compressed. The job's file
// selection decides the treatment:
//
//   SOURCE_QUERY "*.zip" — walk the central directory, select the member the job's NAME names (or the FIRST member
//                          when it names none), inflate it whole.
//   anything else        — the daily modifications/deletes and the lookup files, served uncompressed; the body passes
//                          through verbatim. A response with no job is plain.
//
// A non-2xx status (or a fetch that failed outright, STATUS 0) is an ERROR rather than an empty text frame: an empty
// gazetteer and a failed fetch must never be the same observation.
// ---------------------------------------------------------------------------
int inflate(void) {
    if (refuse_batched()) return 500;

    bool bad = false;
    const R::HttpResponse* response = response_on("response", &bad);
    if (bad) {
        plugin_set_error("invalid-response-frame", "the frame on port \"response\" is not an HttpResponse (HRSP).");
        return 400;
    }
    if (!response) {
        plugin_set_error("missing-response-frame", "inflate requires the http response frame on port \"response\".");
        return 400;
    }
    const Job job = job_of(response);
    const std::string container = job.zip() ? "zip" : "plain";
    const long status = response->STATUS();
    // 304 NOT MODIFIED is the SAME-DATA LEDGER paying off, not a failure. geonames-ingest attaches If-None-Match from
    // the resume mark, so an unchanged upstream file costs one conditional request. Nothing is pushed on `text`, so
    // parse_places never becomes ready and the run ends quietly; the report still records the tick (an Unchanged
    // notice) so a no-op is observable rather than indistinguishable from a flow that never fired.
    if (status == 304) {
        return push_notice("report", R::flowNoticeKind_Unchanged, "not-modified", 0,
                           {"container=" + container, "member=", "bytes_in=0", "bytes_out=0", "status=304"},
                           job.dataset_id, epoch_ms(job.dataset_epoch)) < 0 ? 500 : 0;
    }
    if (status < 200 || status >= 300) {
        char message[384];
        std::snprintf(message, sizeof(message),
                      "the gazetteer fetch answered HTTP %ld%s%s; an empty edition and a failed fetch are not the same "
                      "observation, so this is refused rather than decoded to zero places.",
                      status, response->ERROR() && response->ERROR()->size() ? ": " : "",
                      response->ERROR() ? response->ERROR()->c_str() : "");
        plugin_set_error("upstream-status", message);
        return 502;
    }

    const std::string body = body_of(response);
    std::string text;
    std::string member_name;
    if (job.zip()) {
        const ZipEntry entry = zip_find_member(body, job.text_name);
        if (!entry.found) {
            plugin_set_error("zip-member-not-found",
                             "no readable member in the archive (ZIP64, an encrypted member, an "
                             "unsupported compression method and a truncated body all land "
                             "here; none is decoded to a partial answer).");
            return 422;
        }
        member_name = entry.name;
        if (entry.method == 0) {
            text.assign(body, entry.data_offset, entry.compressed_size);
        } else {
            size_t out_len = 0;
            // flags 0 == RAW deflate: a ZIP member carries no zlib header.
            void* out = tinfl_decompress_mem_to_heap(body.data() + entry.data_offset, entry.compressed_size, &out_len, 0);
            if (!out) {
                plugin_set_error("inflate-failed",
                                 "the archive member did not inflate; a partial inflate is "
                                 "refused rather than parsed as a short gazetteer.");
                return 422;
            }
            text.assign(static_cast<const char*>(out), out_len);
            mz_free(out);
            // The central directory states the member's uncompressed size. A disagreement means the inflate stopped
            // early, which would parse to a plausible short place set with no error anywhere.
            if (entry.uncompressed_size != 0 && text.size() != static_cast<size_t>(entry.uncompressed_size)) {
                char message[224];
                std::snprintf(message, sizeof(message),
                              "inflated %zu bytes but the central directory states %u for "
                              "member \"%s\"; a short inflate is refused, never parsed.",
                              text.size(), entry.uncompressed_size, member_name.c_str());
                plugin_set_error("inflate-short", message);
                return 422;
            }
        }
    } else {
        text = body;
    }

    if (push_text(*response, text) < 0) return 500;
    return push_notice("report", R::flowNoticeKind_Info, "inflated", text.size(),
                       {"container=" + container, "member=" + member_name, "bytes_in=" + std::to_string(body.size()),
                        "bytes_out=" + std::to_string(text.size()), "status=" + std::to_string(status)},
                       job.dataset_id, epoch_ms(job.dataset_epoch)) < 0 ? 500 : 0;
}

// ---------------------------------------------------------------------------
// parse_places — 19-column geoname rows -> a size-prefixed $GNP record stream, the division and country NAMES joined
// from the three lookup files (when the flow fetched them).
//
// The SAME row shape serves both lanes, which is what makes the daily delta free: `modifications-YYYY-MM-DD.txt` is a
// file of FULL geoname rows, verified live 2026-08-15, so a modification is simply an upsert of the same record the
// seed would have produced. There is no second decoder and no second record shape to keep in step.
//
// The lookup files:
//   admin1CodesASCII.txt : "CC.A1"       TAB name TAB asciiname TAB geonameid
//   admin2Codes.txt      : "CC.A1.A2"    TAB name TAB asciiname TAB geonameid
//   countryInfo.txt      : ISO TAB ISO3 TAB numeric TAB fips TAB Country TAB ...
//                          (# comment lines, including the column header, skipped)
// ---------------------------------------------------------------------------
int parse_places(void) {
    if (refuse_batched()) return 500;

    bool bad = false;
    const R::HttpResponse* text_frame = response_on("text", &bad);
    if (bad) {
        plugin_set_error("invalid-text-frame", "the frame on port \"text\" is not an HttpResponse (HRSP).");
        return 400;
    }
    if (!text_frame) {
        plugin_set_error("missing-text-frame", "parse_places requires the decoded gazetteer text on port \"text\".");
        return 400;
    }
    const Job job = job_of(text_frame);
    if (!job.present || job.dataset_id.empty() || job.dataset_epoch.empty() || job.license.empty()) {
        plugin_set_error("incomplete-dataset-contract",
                         "$GNP.SOURCE requires DATASET_ID, DATASET_EPOCH and LICENSE on every "
                         "record. The job ($GNP header in the text frame's CONTEXT) supplies them and they are never "
                         "defaulted: a place published under a guessed epoch is comparable to the wrong "
                         "bytes, which is worse than not publishing it.");
        return 400;
    }

    // TRUNCATION IS AN ERROR, NOT A SMALLER TABLE. Checked before a single row is folded in, for all three files,
    // because a half-read division table produces places whose codes resolve to nothing while every count in the run
    // still reads as a success. Content-Length is the length the ORIGIN stated.
    const char* lookup_ports[3] = {"admin1", "admin2", "country"};
    const R::HttpResponse* lookups[3] = {nullptr, nullptr, nullptr};
    for (int i = 0; i < 3; i++) {
        lookups[i] = response_on(lookup_ports[i], &bad);
        if (bad) {
            plugin_set_error("invalid-lookup-frame",
                             (std::string("the frame on port \"") + lookup_ports[i] + "\" is not an HttpResponse (HRSP).").c_str());
            return 400;
        }
        if (!lookups[i]) continue;
        const long declared = std::atol(header_of(lookups[i], "content-length").c_str());
        if (declared <= 0) continue;
        const long actual = lookups[i]->BODY() ? static_cast<long>(lookups[i]->BODY()->size()) : 0;
        if (actual < declared) {
            char message[256];
            std::snprintf(message, sizeof(message),
                          "the \"%s\" lookup body is %ld bytes but the origin declared %ld; a "
                          "truncated division table resolves later codes to nothing while the "
                          "run still reports success, so it is refused rather than folded in.",
                          lookup_ports[i], actual, declared);
            plugin_set_error("lookup-truncated", message);
            return 502;
        }
    }

    Lookups tables;
    for_each_line(body_of(lookups[0]), [&](const std::string& line) -> bool {
        if (line.empty() || line[0] == '#') return true;
        const std::vector<std::string> cols = split_tabs(line);
        if (cols.size() < 2 || cols[0].empty() || cols[1].empty()) return true;
        tables.admin1[cols[0]] = cols[1];
        return true;
    });
    for_each_line(body_of(lookups[1]), [&](const std::string& line) -> bool {
        if (line.empty() || line[0] == '#') return true;
        const std::vector<std::string> cols = split_tabs(line);
        if (cols.size() < 2 || cols[0].empty() || cols[1].empty()) return true;
        tables.admin2[cols[0]] = cols[1];
        return true;
    });
    for_each_line(body_of(lookups[2]), [&](const std::string& line) -> bool {
        if (line.empty() || line[0] == '#') return true;
        const std::vector<std::string> cols = split_tabs(line);
        if (cols.size() < 5 || cols[0].empty() || cols[4].empty()) return true;
        tables.country[cols[0]] = cols[4];
        return true;
    });

    const long limit = static_cast<long>(config_number("geonames_limit", 0));
    const std::string retrieved_at = iso_now();
    const std::string text = body_of(text_frame);

    Bytes stream;
    long rows_in = 0, written = 0, skipped_short = 0, skipped_position = 0, skipped_identity = 0;
    bool truncated = false;

    for_each_line(text, [&](const std::string& line) -> bool {
        if (line.empty() || line[0] == '#') return true;
        rows_in++;
        if (limit > 0 && written >= limit) { truncated = true; return false; }

        const std::vector<std::string> c = split_tabs(line);
        if (c.size() < GEONAME_COLUMNS) { skipped_short++; return true; }
        if (c[COL_GEONAMEID].empty() || c[COL_NAME].empty()) { skipped_identity++; return true; }

        // A position outside the WGS 84 domain is DROPPED, never clamped: a clamped place is a place in the wrong
        // location, silently.
        char* lat_end = nullptr;
        char* lon_end = nullptr;
        const double lat = strtod(c[COL_LATITUDE].c_str(), &lat_end);
        const double lon = strtod(c[COL_LONGITUDE].c_str(), &lon_end);
        if (lat_end == c[COL_LATITUDE].c_str() || lon_end == c[COL_LONGITUDE].c_str() ||
            lat < -90.0 || lat > 90.0 || lon < -180.0 || lon > 180.0) {
            skipped_position++;
            return true;
        }

        flatbuffers::FlatBufferBuilder b(2048);

        // ── provenance ──────────────────────────────────────────────────────
        // NATIVE_ID is the gazetteer's own row id, verbatim and never re-minted; the join key back to the source
        // belongs in SOURCE.NATIVE_ID by the IDL's own instruction.
        const auto p_dataset_id = b.CreateString(job.dataset_id);
        const auto p_dataset_epoch = b.CreateString(job.dataset_epoch);
        const auto p_retrieved_at = b.CreateString(retrieved_at);
        const auto p_license = b.CreateString(job.license);
        const auto p_native_id = b.CreateString(c[COL_GEONAMEID]);
        const auto p_dataset_name = job.dataset_name.empty() ? 0 : b.CreateString(job.dataset_name);
        const auto p_dataset_url = job.dataset_url.empty() ? 0 : b.CreateString(job.dataset_url);
        const auto p_dataset_cid = job.dataset_cid.empty() ? 0 : b.CreateString(job.dataset_cid);
        const auto p_source_url = job.source_url.empty() ? 0 : b.CreateString(job.source_url);
        const auto p_source_query = job.source_query.empty() ? 0 : b.CreateString(job.source_query);
        const auto p_license_url = job.license_url.empty() ? 0 : b.CreateString(job.license_url);
        const auto p_attribution = job.attribution.empty() ? 0 : b.CreateString(job.attribution);
        const auto p_native_modified =
            c[COL_MODIFICATION_DATE].empty() ? 0 : b.CreateString(c[COL_MODIFICATION_DATE]);

        GNPProvenanceBuilder pb(b);
        pb.add_DATASET_ID(p_dataset_id);
        pb.add_DATASET_EPOCH(p_dataset_epoch);
        pb.add_RETRIEVED_AT(p_retrieved_at);
        pb.add_LICENSE(p_license);
        pb.add_NATIVE_ID(p_native_id);
        if (p_dataset_name.o) pb.add_DATASET_NAME(p_dataset_name);
        if (p_dataset_url.o) pb.add_DATASET_URL(p_dataset_url);
        if (p_dataset_cid.o) pb.add_DATASET_CID(p_dataset_cid);
        if (p_source_url.o) pb.add_SOURCE_URL(p_source_url);
        if (p_source_query.o) pb.add_SOURCE_QUERY(p_source_query);
        if (p_license_url.o) pb.add_LICENSE_URL(p_license_url);
        if (p_attribution.o) pb.add_ATTRIBUTION(p_attribution);
        if (p_native_modified.o) pb.add_NATIVE_MODIFIED(p_native_modified);
        if (job.share_alike) pb.add_SHARE_ALIKE(true);
        if (job.non_commercial_only) pb.add_NON_COMMERCIAL_ONLY(true);
        const auto provenance = pb.Finish();

        // ── alternate names ─────────────────────────────────────────────────
        // The dump publishes them as one comma-joined list with no language tags, so LANGUAGE and every flag are
        // left UNSET. Guessing a language from a script would be a fabricated attribute on a required-verbatim field.
        std::vector<flatbuffers::Offset<GNPName>> alternates;
        for (const std::string& alt : split_commas(c[COL_ALTERNATENAMES])) {
            const auto alt_name = b.CreateString(alt);
            GNPNameBuilder nb(b);
            nb.add_NAME(alt_name);
            alternates.push_back(nb.Finish());
        }
        flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<GNPName>>> alternates_vec;
        if (!alternates.empty()) alternates_vec = b.CreateVector(alternates);

        std::vector<flatbuffers::Offset<flatbuffers::String>> cc2;
        for (const std::string& code : split_commas(c[COL_CC2])) cc2.push_back(b.CreateString(code));
        flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<flatbuffers::String>>> cc2_vec;
        if (!cc2.empty()) cc2_vec = b.CreateVector(cc2);

        const std::string record_id = job.id_prefix + ":" + c[COL_GEONAMEID];
        const std::string admin1_key = c[COL_COUNTRY_CODE].empty() || c[COL_ADMIN1].empty()
                                           ? std::string()
                                           : c[COL_COUNTRY_CODE] + "." + c[COL_ADMIN1];
        const std::string admin2_key =
            admin1_key.empty() || c[COL_ADMIN2].empty() ? std::string() : admin1_key + "." + c[COL_ADMIN2];
        const std::string admin1_name = lookup_or_empty(tables.admin1, admin1_key);
        const std::string admin2_name = lookup_or_empty(tables.admin2, admin2_key);
        const std::string country_name = lookup_or_empty(tables.country, c[COL_COUNTRY_CODE]);

        const auto f_id = b.CreateString(record_id);
        const auto f_name = b.CreateString(c[COL_NAME]);
        const auto f_ascii = c[COL_ASCIINAME].empty() ? 0 : b.CreateString(c[COL_ASCIINAME]);
        const auto f_class_code = c[COL_FEATURE_CLASS].empty() ? 0 : b.CreateString(c[COL_FEATURE_CLASS]);
        const auto f_feature_code = c[COL_FEATURE_CODE].empty() ? 0 : b.CreateString(c[COL_FEATURE_CODE]);
        const auto f_country_code = c[COL_COUNTRY_CODE].empty() ? 0 : b.CreateString(c[COL_COUNTRY_CODE]);
        const auto f_country_name = country_name.empty() ? 0 : b.CreateString(country_name);
        const auto f_admin1_code = c[COL_ADMIN1].empty() ? 0 : b.CreateString(c[COL_ADMIN1]);
        const auto f_admin1_name = admin1_name.empty() ? 0 : b.CreateString(admin1_name);
        const auto f_admin2_code = c[COL_ADMIN2].empty() ? 0 : b.CreateString(c[COL_ADMIN2]);
        const auto f_admin2_name = admin2_name.empty() ? 0 : b.CreateString(admin2_name);
        const auto f_admin3_code = c[COL_ADMIN3].empty() ? 0 : b.CreateString(c[COL_ADMIN3]);
        const auto f_admin4_code = c[COL_ADMIN4].empty() ? 0 : b.CreateString(c[COL_ADMIN4]);
        const auto f_timezone = c[COL_TIMEZONE].empty() ? 0 : b.CreateString(c[COL_TIMEZONE]);
        const auto f_dem_model =
            job.dem_model.empty() || c[COL_DEM].empty() ? 0 : b.CreateString(job.dem_model);

        GNPBuilder gb(b);
        gb.add_ID(f_id);
        gb.add_NAME(f_name);
        if (f_ascii.o) gb.add_ASCII_NAME(f_ascii);
        if (!alternates.empty()) gb.add_ALTERNATE_NAMES(alternates_vec);
        gb.add_LATITUDE(lat);
        gb.add_LONGITUDE(lon);
        // ELEVATION_PUBLISHED is the whole point of the field: an unpublished elevation is zero-and-false, a surveyed
        // sea-level place is zero-and-TRUE, and the two are never the same record.
        if (!c[COL_ELEVATION].empty()) {
            gb.add_ELEVATION_M(strtod(c[COL_ELEVATION].c_str(), nullptr));
            gb.add_ELEVATION_PUBLISHED(true);
        }
        // The DEM sample is kept in its own field, never substituted for a survey: "a model sample is not a survey".
        if (!c[COL_DEM].empty()) gb.add_DEM_ELEVATION_M(strtod(c[COL_DEM].c_str(), nullptr));
        if (f_dem_model.o) gb.add_DEM_MODEL(f_dem_model);
        gb.add_FEATURE_CLASS(feature_class_of(c[COL_FEATURE_CLASS]));
        if (f_class_code.o) gb.add_FEATURE_CLASS_CODE(f_class_code);
        if (f_feature_code.o) gb.add_FEATURE_CODE(f_feature_code);
        if (f_country_code.o) gb.add_COUNTRY_CODE(f_country_code);
        if (f_country_name.o) gb.add_COUNTRY_NAME(f_country_name);
        if (!cc2.empty()) gb.add_ALTERNATE_COUNTRY_CODES(cc2_vec);
        if (f_admin1_code.o) gb.add_ADMIN1_CODE(f_admin1_code);
        if (f_admin1_name.o) gb.add_ADMIN1_NAME(f_admin1_name);
        if (f_admin2_code.o) gb.add_ADMIN2_CODE(f_admin2_code);
        if (f_admin2_name.o) gb.add_ADMIN2_NAME(f_admin2_name);
        if (f_admin3_code.o) gb.add_ADMIN3_CODE(f_admin3_code);
        if (f_admin4_code.o) gb.add_ADMIN4_CODE(f_admin4_code);
        if (!c[COL_POPULATION].empty()) {
            gb.add_POPULATION(static_cast<int64_t>(strtoll(c[COL_POPULATION].c_str(), nullptr, 10)));
        }
        if (f_timezone.o) gb.add_TIME_ZONE_ID(f_timezone);
        gb.add_SOURCE(provenance);
        FinishGNPBuffer(b, gb.Finish());

        const uint32_t len = b.GetSize();
        stream.push_back(static_cast<uint8_t>(len & 0xff));
        stream.push_back(static_cast<uint8_t>((len >> 8) & 0xff));
        stream.push_back(static_cast<uint8_t>((len >> 16) & 0xff));
        stream.push_back(static_cast<uint8_t>((len >> 24) & 0xff));
        stream.insert(stream.end(), b.GetBufferPointer(), b.GetBufferPointer() + len);
        written++;
        return true;
    });

    if (push_gnp_stream("records", stream) < 0) return 500;
    // THE RUN SUMMARY, as a FlowNotice (KIND Info, COUNT = records out, SOURCE_NAME = the dataset, AT_MS = its epoch).
    // A CROPPED ANSWER MUST SAY SO: REASON "places-cropped" (and truncated=true) is the difference between "the
    // gazetteer published this many places" and "we stopped counting".
    return push_notice("decision", R::flowNoticeKind_Info, truncated ? "places-cropped" : "places-decoded",
                       static_cast<uint64_t>(written),
                       {std::string("lane=") + (job.zip() ? "seed" : "delta"), "rows_in=" + std::to_string(rows_in),
                        "records_out=" + std::to_string(written), "skipped_short_row=" + std::to_string(skipped_short),
                        "skipped_no_identity=" + std::to_string(skipped_identity),
                        "skipped_out_of_range=" + std::to_string(skipped_position),
                        std::string("truncated=") + (truncated ? "true" : "false"), "dataset_id=" + job.dataset_id,
                        "dataset_epoch=" + job.dataset_epoch, "retrieved_at=" + retrieved_at,
                        "admin1_resolved=" + std::to_string(tables.admin1.size()),
                        "admin2_resolved=" + std::to_string(tables.admin2.size()),
                        "countries_resolved=" + std::to_string(tables.country.size())},
                       job.dataset_id, epoch_ms(job.dataset_epoch)) < 0 ? 500 : 0;
}

// ---------------------------------------------------------------------------
// parse_deletes — `deletes-YYYY-MM-DD.txt` -> the tombstone list.
//
// Three tab-separated columns: geonameid TAB name TAB reason (verified live 2026-08-15). The reason is carried verbatim
// because it is the only record of WHY a place left the gazetteer — "duplicate" and "not a real place" are different
// facts about the same id.
//
// THIS METHOD EMITS A LIST, NOT A DELETION. No host capability removes a stored row (storage-ingest offers ingest only,
// flatsql-query is read-only) and inventing one would be a new host capability this lane may not add, so the tombstones
// ride out of the flow on their own port — ONE FlowNotice (KIND Info, REASON "tombstones", COUNT = tombstones,
// SOURCE_NAME = the dataset, AT_MS = its epoch) whose ITEMS are "<record ID>\t<name>\t<reason>", the record ID being the
// one the stored place carries ("<prefix>:<geonameid>"). No SDS record models a gazetteer tombstone. Rows that are not
// tombstones are counted on a second notice (REASON "deletes-rows-skipped") only when there are any.
// ---------------------------------------------------------------------------
int parse_deletes(void) {
    if (refuse_batched()) return 500;

    bool bad = false;
    const R::HttpResponse* frame = response_on("text", &bad);
    if (bad) {
        plugin_set_error("invalid-text-frame", "the frame on port \"text\" is not an HttpResponse (HRSP).");
        return 400;
    }
    if (!frame) {
        plugin_set_error("missing-text-frame", "parse_deletes requires the deletes text on port \"text\".");
        return 400;
    }
    const Job job = job_of(frame);
    const std::string prefix = job.present ? job.id_prefix : "geonames";
    const std::string text = body_of(frame);

    std::vector<std::string> entries;
    long rows_in = 0, skipped = 0;
    for_each_line(text, [&](const std::string& line) -> bool {
        if (line.empty() || line[0] == '#') return true;
        rows_in++;
        const std::vector<std::string> c = split_tabs(line);
        if (c.empty() || c[0].empty()) { skipped++; return true; }
        // A row whose first column is not an id is not a tombstone. GeoNames serves an HTML 404 body for a day it no
        // longer retains, and decoding that to "delete everything named <html>" is precisely the class of failure
        // this guard exists for.
        for (const char ch : c[0]) {
            if (ch < '0' || ch > '9') { skipped++; return true; }
        }
        entries.push_back(prefix + ":" + c[0] + "\t" + (c.size() > 1 ? c[1] : std::string()) + "\t" +
                          (c.size() > 2 ? c[2] : std::string()));
        return true;
    });

    const uint64_t tombstones = entries.size();
    if (push_notice("tombstones", R::flowNoticeKind_Info, "tombstones", tombstones, std::move(entries), job.dataset_id,
                    epoch_ms(job.dataset_epoch)) < 0) {
        return 500;
    }
    if (skipped > 0 &&
        push_notice("tombstones", R::flowNoticeKind_Info, "deletes-rows-skipped", static_cast<uint64_t>(skipped),
                    {"rows_in=" + std::to_string(rows_in)}, job.dataset_id, epoch_ms(job.dataset_epoch)) < 0) {
        return 500;
    }
    return 0;
}

}  // extern "C"
