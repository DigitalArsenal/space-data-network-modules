/*
 * data-source/geonames-ingest (graph task `geonames-ingest-flow`), on the typed contracts (1.0): FlatBuffers only
 * between modules, no JSON and no base64.
 *
 * The ORCHESTRATION half of the GeoNames gazetteer lane. `geonames-source` is the request-scoped decoder — a dump in, a
 * $GNP stream out, `capabilities: []`, nothing persisted — which is the right shape for a browser and the wrong shape for
 * a scheduled ingest, and the two cannot be one plugin. So the ingest-only decisions live here, mirroring the
 * cell-tower-source / cell-tower-ingest split.
 *
 * Methods:
 *   mark_query      tick (TICK)                         -> query ($FSO)              (read the mark)
 *   ingest_plan     tick (TICK) + mark ($FSB chunks)?   -> request(s) (HREQ)         (seed | delta | no-op)
 *   ingest_meta     records ($GNP) + response (HRSP)    -> meta (INGQ), records ($GNP)  (storage-ingest input)
 *   publish_request result (INGR) + meta (INGQ)         -> mark ($IRM), request (HREQ)?  (advance + announce)
 *
 * THE JOB TRAVELS AS HttpRequest.CONTEXT. Every fetch ingest_plan emits carries ONE size-prefixed $GNP HEADER RECORD
 * (no place): ID = the id prefix records are minted under, NAME = the text the job decodes (the archive member of the
 * seed .zip; the file itself otherwise), SOURCE = the dataset contract every record is published under (DATASET_ID,
 * DATASET_NAME, DATASET_URL, DATASET_EPOCH, SOURCE_URL, SOURCE_QUERY = the file selection, LICENSE, LICENSE_URL,
 * ATTRIBUTION, SHARE_ALIKE, NON_COMMERCIAL_ONLY). hostcap/http-request echoes it in the HttpResponse; geonames-source
 * decodes against it and ingest_meta reads it back from the main fetch's response. It replaces the JSON job frame.
 *
 * THE SCHEDULE, AND WHY ONE TICK IS ONE BOUNDED UNIT OF WORK. The flow's single trigger is a 24 h `host-cron` timer,
 * the gazetteer's own publication cadence: GeoNames cuts `modifications-YYYY-MM-DD.txt` and `deletes-YYYY-MM-DD.txt`
 * once a day. The FIRST tick has no mark and runs the SEED: `cities15000.zip` plus the three division/country files.
 * Every later tick runs the DELTA for the tick's own UTC date. The loop's state lives in the durable mark instead of in a
 * guest instance a restart erases, and an overrun tick is naturally skipped because the next one re-derives the same date
 * and finds the mark already there.
 *
 * THE MARK IS AN $IRM AND IT IS ALSO THE SAME-DATA LEDGER. The mark carries the upstream ETag (SOURCE.ENTITY_TAG),
 * Last-Modified and the edition last ingested (SOURCE.SOURCE_VERSION = the DATASET_EPOCH), so
 *   * a tick whose date already appears on the mark emits NOTHING — no fetch at all;
 *   * every fetch it does make carries `if-none-match` from the mark, so an unchanged file costs one conditional request
 *     and comes back 304, which `geonames-source::inflate` ends the run on without an error.
 * The mark used to be a JSON row read with `SELECT * FROM geonames_ingest_mark WHERE dataset_id = ?` — a relation no
 * node has (every embedded standard is served through a FlatSQL view named by its SDS CODE over `_data`/`_rowid`). It is
 * now the $IRM (Ingest Resume Mark, SDS 1.196.0) record this lane authors, read back with
 * `SELECT _data FROM IRM ORDER BY _rowid DESC LIMIT ?` through hostcap/flatsql-query and picked by JOB_ID
 * ("geonames-ingest/<dataset id>"), highest SEQUENCE winning.
 *
 * WHY THE RESUME MARK ADVANCES WHERE IT DOES. The mark is authored by `publish_request`, from the STORAGE RESULT —
 * never by `ingest_plan` at dispatch. A mark advanced when an edition is REQUESTED turns a crash between fetch and store
 * into a permanently skipped day. The flow lands the $IRM on egress; persisting it is hostcap/storage-write's job (an
 * $IRM `record` in, a $PNM out) under the storage_write grant, which this flow does not (yet) wire.
 *
 * THE SEED IS RANGED BECAUSE THE HOST CAPS THE BODY. The Go server host caps an http response body at 4 MiB. The seed
 * archive was measured at 3,306,445 bytes on 2026-08-15, so it fits — but "fits today" is not a design. The request
 * carries an explicit Range under that ceiling and `ingest_meta` REFUSES the run when Content-Range's denominator proves
 * the object is larger, rather than inflating a truncated archive into a plausible short gazetteer.
 */

#include <algorithm>
#include <cctype>
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
#include "TimerTick_generated.h"
#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"
#include "IngestRequest_generated.h"
#include "IngestResult_generated.h"
#include "GNP_generated.h"  // spacedatastandards.org lib/cpp/GNP/main_generated.h, inlined by build.mjs
#include "IRM_generated.h"  // spacedatastandards.org lib/cpp/IRM/main_generated.h, inlined by build.mjs
#include "FSO_generated.h"  // spacedatastandards.org lib/cpp/FSO/main_generated.h, inlined by build.mjs
#include "FSB_generated.h"  // spacedatastandards.org lib/cpp/FSB/main_generated.h, inlined by build.mjs

namespace {

namespace A = sdn::runtime::Aligned;
namespace R = sdn::runtime;

using Bytes = std::vector<uint8_t>;

// The Go host caps an http response body at 4 MiB (hostcap/http-request manifest). The seed archive measured 3,306,445
// bytes on 2026-08-15.
constexpr long kHostBodyCapBytes = 4L * 1024L * 1024L;
constexpr long kDefaultTimeoutMs = 90000;
constexpr const char* kSchema = "GNP.fbs";
constexpr const char* kTargetStandard = "$GNP";
constexpr const char* kIngestorId = "com.digitalarsenal.data-source.geonames-ingest";
constexpr const char* kJobPrefix = "geonames-ingest/";
constexpr const char* kParser = "geonames-ingest-wasm";
constexpr const char* kParserVersion = "v1";
constexpr const char* kDefaultMarkSql = "SELECT _data FROM IRM ORDER BY _rowid DESC LIMIT ?";
constexpr double kDefaultMarkScanRows = 32;
constexpr const char* kDefaultBaseUrl = "https://download.geonames.org/export/dump/";
constexpr const char* kDefaultSeedDataset = "cities15000";
constexpr const char* kDefaultDatasetId = "geonames";
constexpr const char* kDefaultProviderId = "geonames";
constexpr const char* kDefaultSourceName = "geonames-gazetteer";
// CC BY 4.0 is the licence GeoNames publishes these dumps under. It is carried verbatim into $GNP.SOURCE.LICENSE /
// ATTRIBUTION on EVERY record, which is where the obligation is actually discharged — the standard names no gazetteer,
// so the credit line has to ride in the data.
constexpr const char* kDefaultLicense = "CC BY 4.0";
constexpr const char* kDefaultLicenseUrl = "https://creativecommons.org/licenses/by/4.0/";
constexpr const char* kDefaultAttribution = "GeoNames (CC BY 4.0)";

// ── node config: plugin.getConfig as an SDS $PIV hostcall (one ModuleConfig FlatBuffer on raw "config") ──────────

namespace RK = sdn::runtime;

struct Config {
    sdm_piv::Config mcfg;  // read in place; a failed call (no config) answers every default

    // A string value; `fallback` when absent or empty (an empty value never overrides a default).
    std::string string(const char* key, const char* fallback) const {
        if (!mcfg.ok() || mcfg.kind(key, RK::configValueKind_Number) != RK::configValueKind_String) return fallback;
        const std::string_view v = mcfg.string(key);
        return v.empty() ? std::string(fallback) : std::string(v);
    }
    // A number (a numeric string is tolerated, as the operator config always allowed).
    double number(const char* key, double fallback) const {
        if (!mcfg.ok() || !mcfg.has(key)) return fallback;
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
    bool boolean(const char* key, bool fallback) const {
        if (!mcfg.ok() || !mcfg.has(key)) return fallback;
        const RK::configValueKind kind = mcfg.kind(key);
        if (kind == RK::configValueKind_Bool) return mcfg.boolean(key, fallback);
        if (kind == RK::configValueKind_Number) return mcfg.number(key, 0) != 0;
        if (kind != RK::configValueKind_String) return fallback;
        const std::string_view s = mcfg.string(key);
        if (s == "true" || s == "1") return true;
        if (s == "false" || s == "0") return false;
        return fallback;
    }
};

Config load_config() { return Config{sdm_piv::get_config()}; }

long config_timeout_ms(const Config& config) {
    const long v = static_cast<long>(config.number("geonames_http_timeout_ms", static_cast<double>(kDefaultTimeoutMs)));
    return v > 0 ? v : kDefaultTimeoutMs;
}

// The seed byte budget is CLAMPED, not merely defaulted. An operator who sets 64 MiB "so the whole file fits" would get
// a silently truncated body from the host and an archive that either fails to inflate or inflates short.
long config_seed_max_bytes(const Config& config) {
    const long v = static_cast<long>(config.number("geonames_seed_max_bytes", static_cast<double>(kHostBodyCapBytes)));
    if (v <= 0 || v > kHostBodyCapBytes) return kHostBodyCapBytes;
    return v;
}

std::string job_id_of(const std::string& dataset) { return std::string(kJobPrefix) + dataset; }

// ── frames ────────────────────────────────────────────────────────────────────────────────────────────────────

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

template <typename T, typename VerifyFn>
const T* verified(const plugin_input_frame_t* f, VerifyFn verify, const T* (*get)(const void*)) {
    if (!f || !f->payload || f->payload_length == 0) return nullptr;
    flatbuffers::Verifier verifier(f->payload, f->payload_length);
    if (!verify(verifier)) return nullptr;
    return get(f->payload);
}

Bytes finished(const flatbuffers::FlatBufferBuilder& b) { return Bytes(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize()); }

// An HttpRequest (HREQ). Headers are given lower-cased; the vector is written sorted by NAME (a FlatBuffers key).
Bytes http_request(const char* method, const std::string& url, std::vector<std::pair<std::string, std::string>> headers,
                   const Bytes* body, uint32_t timeout_ms, const Bytes* context) {
    flatbuffers::FlatBufferBuilder b(512 + (body ? body->size() : 0) + (context ? context->size() : 0));
    std::sort(headers.begin(), headers.end());
    std::vector<flatbuffers::Offset<R::Header>> header_offsets;
    for (const auto& [name, value] : headers) header_offsets.push_back(R::CreateHeaderDirect(b, name.c_str(), value.c_str()));
    R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, method, url.c_str(), &header_offsets, body, timeout_ms, 0, context));
    return finished(b);
}

int push_request(const char* port, const Bytes& request) {
    return plugin_push_output_ex(port, "HttpRequest.fbs", R::HttpRequestIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "HttpRequest", 0, 0, request.data(), static_cast<uint32_t>(request.size()));
}

// SURPLUS-FRAME REFUSAL — see the long note in cell_tower_ingest_module.cpp. The compiled flow runtime drains a node's
// queue PORT-BLIND up to a budget of 64 while maxStreams/maxBatch/drainPolicy are declarative only, so a guest that reads
// ordinal 0 and returns destroys every other frame it was handed. `multi` names the one port that legitimately carries
// several frames (the flatsql-query result's $FSB chunks), which are all read.
bool find_batched_input_port(char* message, size_t message_len, const char* multi) {
    const uint32_t count = plugin_get_input_count();
    for (uint32_t i = 0; i < count; i++) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        if (!frame || !frame->port_id) continue;
        if (multi && std::strcmp(frame->port_id, multi) == 0) continue;
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

bool refuse_batched(const char* multi = nullptr) {
    char message[384];
    if (!find_batched_input_port(message, sizeof(message), multi)) return false;
    plugin_set_error("batched-input-frames", message);
    return true;
}

std::string str_of(const flatbuffers::String* s) { return s ? s->str() : std::string(); }

// A response header by lower-case name (the connector writes HEADERS sorted by lower-case NAME).
std::string header_of(const R::HttpResponse& r, const char* name) {
    if (!r.HEADERS()) return std::string();
    for (const auto* h : *r.HEADERS()) {
        if (!h || !h->NAME()) continue;
        const std::string n = h->NAME()->str();
        if (n.size() != std::strlen(name)) continue;
        bool same = true;
        for (size_t i = 0; i < n.size() && same; i++) same = std::tolower(static_cast<unsigned char>(n[i])) == name[i];
        if (same) return str_of(h->VALUE());
    }
    return std::string();
}

// Content-Range: "bytes 0-3145727/3306445" -> the total after the slash. The DENOMINATOR is the only authority on the
// object's size: Content-Length on a 206 describes the CHUNK.
bool total_from_content_range(const std::string& value, long* total) {
    const size_t slash = value.rfind('/');
    if (slash == std::string::npos || slash + 1 >= value.size()) return false;
    if (value[slash + 1] == '*') return false;  // unknown total; not an answer
    const long parsed = std::atol(value.c_str() + slash + 1);
    if (parsed <= 0) return false;
    *total = parsed;
    return true;
}

// ── civil time (UTC) ──────────────────────────────────────────────────────────────────────────────────────────

int64_t days_from_civil(int64_t y, int m, int d) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);
    const unsigned doy = (153u * static_cast<unsigned>(m + (m > 2 ? -3 : 9)) + 2u) / 5u + static_cast<unsigned>(d) - 1u;
    const unsigned doe = yoe * 365u + yoe / 4u - yoe / 100u + doy;
    return era * 146097 + static_cast<int64_t>(doe) - 719468;
}

std::string iso_of_ms(uint64_t ms, bool date_only) {
    const int64_t days = static_cast<int64_t>(ms / 86400000u);
    const int64_t z = days + 719468, era = (z >= 0 ? z : z - 146096) / 146097, doe = z - era * 146097;
    const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365, doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const int64_t mp = (5 * doy + 2) / 153, d = doy - (153 * mp + 2) / 5 + 1, m = mp < 10 ? mp + 3 : mp - 9;
    const int64_t y = yoe + era * 400 + (m <= 2);
    const uint64_t in_day = ms % 86400000u;
    char buf[40];
    if (date_only) {
        std::snprintf(buf, sizeof(buf), "%04lld-%02lld-%02lld", static_cast<long long>(y), static_cast<long long>(m), static_cast<long long>(d));
    } else {
        std::snprintf(buf, sizeof(buf), "%04lld-%02lld-%02lldT%02u:%02u:%02u.%03uZ", static_cast<long long>(y),
                      static_cast<long long>(m), static_cast<long long>(d), static_cast<unsigned>(in_day / 3600000u),
                      static_cast<unsigned>(in_day / 60000u % 60u), static_cast<unsigned>(in_day / 1000u % 60u),
                      static_cast<unsigned>(in_day % 1000u));
    }
    return buf;
}

std::string iso_now() {
    struct timeval tv;
    if (gettimeofday(&tv, nullptr) != 0) return "1970-01-01T00:00:00.000Z";
    return iso_of_ms(static_cast<uint64_t>(tv.tv_sec) * 1000u + static_cast<uint64_t>(tv.tv_usec / 1000), false);
}

// "YYYY-MM-DD" -> days since 1970-01-01, or -1.
int64_t day_number(const std::string& date) {
    if (date.size() < 10 || date[4] != '-' || date[7] != '-') return -1;
    const int y = std::atoi(date.substr(0, 4).c_str()), m = std::atoi(date.substr(5, 2).c_str()), d = std::atoi(date.substr(8, 2).c_str());
    if (y < 1970 || m < 1 || m > 12 || d < 1 || d > 31) return -1;
    return days_from_civil(y, m, d);
}

// ── the job: a $GNP header record (ingest_plan writes it into each request's CONTEXT; ingest_meta reads it back) ──

struct JobSpec {
    std::string id_prefix, name, dataset_id, dataset_name, dataset_url, dataset_epoch, source_url, source_query;
    std::string license, license_url, attribution;
    bool share_alike = false, non_commercial_only = false;
};

Bytes job_header(const JobSpec& j) {
    flatbuffers::FlatBufferBuilder b(1024);
    const auto empty = b.CreateString("");
    const auto dataset_id = b.CreateString(j.dataset_id);
    const auto dataset_name = b.CreateString(j.dataset_name);
    const auto dataset_url = b.CreateString(j.dataset_url);
    const auto dataset_epoch = b.CreateString(j.dataset_epoch);
    const auto source_url = b.CreateString(j.source_url);
    const auto source_query = b.CreateString(j.source_query);
    const auto license = b.CreateString(j.license);
    const auto license_url = b.CreateString(j.license_url);
    const auto attribution = b.CreateString(j.attribution);
    GNPProvenanceBuilder pb(b);
    pb.add_DATASET_ID(dataset_id);
    pb.add_DATASET_NAME(dataset_name);
    pb.add_DATASET_URL(dataset_url);
    pb.add_DATASET_EPOCH(dataset_epoch);
    pb.add_SOURCE_URL(source_url);
    pb.add_SOURCE_QUERY(source_query);
    pb.add_LICENSE(license);
    pb.add_LICENSE_URL(license_url);
    pb.add_ATTRIBUTION(attribution);
    if (j.share_alike) pb.add_SHARE_ALIKE(true);
    if (j.non_commercial_only) pb.add_NON_COMMERCIAL_ONLY(true);
    // per record: stamped at decode / the row's own id; empty on the header
    pb.add_RETRIEVED_AT(empty);
    pb.add_NATIVE_ID(empty);
    const auto source = pb.Finish();
    const auto id = b.CreateString(j.id_prefix);
    const auto name = b.CreateString(j.name);
    GNPBuilder gb(b);
    gb.add_ID(id);
    gb.add_NAME(name);
    gb.add_SOURCE(source);
    FinishSizePrefixedGNPBuffer(b, gb.Finish());
    return finished(b);
}

struct Job {
    bool present = false;
    std::string dataset_id, dataset_epoch, source_url, source_query;
    bool seed() const { return source_query.size() >= 4 && source_query.compare(source_query.size() - 4, 4, ".zip") == 0; }
    std::string date() const { return dataset_epoch.size() >= 10 ? dataset_epoch.substr(0, 10) : dataset_epoch; }
};

Job job_of(const R::HttpResponse& r) {
    Job job;
    if (!r.CONTEXT() || r.CONTEXT()->size() < 8) return job;
    flatbuffers::Verifier verifier(r.CONTEXT()->data(), r.CONTEXT()->size());
    if (!VerifySizePrefixedGNPBuffer(verifier)) return job;
    const GNPProvenance* source = GetSizePrefixedGNP(r.CONTEXT()->data())->SOURCE();
    if (!source) return job;
    job.present = true;
    job.dataset_id = str_of(source->DATASET_ID());
    job.dataset_epoch = str_of(source->DATASET_EPOCH());
    job.source_url = str_of(source->SOURCE_URL());
    job.source_query = str_of(source->SOURCE_QUERY());
    return job;
}

// ── the mark: $IRM records in the flatsql-query result ($FSB chunks of the aligned size-prefixed stream) ─────────

struct Mark {
    bool found = false;
    bool seeded = false;
    uint64_t sequence = 0;
    std::string date;  // the edition last ingested (SOURCE.SOURCE_VERSION, its UTC date)
    std::string etag;  // SOURCE.ENTITY_TAG
};

// The $FSB chunks on `port`, reassembled by CHUNK_SEQUENCE. *bad names the problem when a frame is not an $FSB.
bool reassemble(const char* port, std::string* stream, std::string* bad) {
    std::vector<const FSB*> chunks;
    for (const plugin_input_frame_t* f : frames_on(port)) {
        const FSB* chunk = verified<FSB>(f, [](flatbuffers::Verifier& v) { return VerifyFSBBuffer(v); }, &GetFSB);
        if (!chunk) {
            *bad = "a frame on port \"" + std::string(port) + "\" is not an $FSB";
            return false;
        }
        chunks.push_back(chunk);
    }
    std::sort(chunks.begin(), chunks.end(), [](const FSB* a, const FSB* b) { return a->CHUNK_SEQUENCE() < b->CHUNK_SEQUENCE(); });
    for (size_t i = 0; i < chunks.size(); i++) {
        if (chunks[i]->CHUNK_SEQUENCE() != i) {
            *bad = "the $FSB chunks on port \"" + std::string(port) + "\" are not a complete sequence from 0";
            return false;
        }
        if (const auto* data = chunks[i]->DATA()) stream->append(reinterpret_cast<const char*>(data->data()), data->size());
    }
    return true;
}

// Walk the aligned size-prefixed record stream the engine returns (zero-length prefixes are alignment padding; a frame
// verifies with the size-prefixed accessors first, plain-anchored as the fallback) and pick this job's newest mark.
// Frames that are not $IRM, and $IRM records of other jobs, are skipped: one relation holds every lane's marks.
Mark read_mark(const std::string& stream, const std::string& want_job) {
    Mark best;
    const uint8_t* data = reinterpret_cast<const uint8_t*>(stream.data());
    const size_t length = stream.size();
    std::vector<uint8_t> scratch;
    size_t offset = 0;
    while (length - offset >= 4) {
        const uint32_t size = static_cast<uint32_t>(data[offset]) | (static_cast<uint32_t>(data[offset + 1]) << 8) |
                              (static_cast<uint32_t>(data[offset + 2]) << 16) | (static_cast<uint32_t>(data[offset + 3]) << 24);
        offset += 4;
        if (size == 0) continue;
        if (size > length - offset) break;
        scratch.assign(data + offset - 4, data + offset + size);
        offset += size;
        const IRM* irm = nullptr;
        flatbuffers::Verifier prefixed(scratch.data(), scratch.size());
        if (size >= 8 && VerifySizePrefixedIRMBuffer(prefixed)) {
            irm = GetSizePrefixedIRM(scratch.data());
        } else {
            scratch.erase(scratch.begin(), scratch.begin() + 4);
            flatbuffers::Verifier plain(scratch.data(), scratch.size());
            if (scratch.size() >= 8 && IRMBufferHasIdentifier(scratch.data()) && VerifyIRMBuffer(plain)) irm = GetIRM(scratch.data());
        }
        if (!irm || str_of(irm->JOB_ID()) != want_job) continue;
        // highest SEQUENCE wins; the stream is newest-first, so a tie keeps the first (newest) one
        if (best.found && irm->SEQUENCE() <= best.sequence) continue;
        best.found = true;
        best.sequence = irm->SEQUENCE();
        best.seeded = irm->STATE() == irmJobState_COMPLETE;
        const IRMSource* source = irm->SOURCE();
        const std::string version = source ? str_of(source->SOURCE_VERSION()) : std::string();
        best.date = version.size() >= 10 ? version.substr(0, 10) : version;
        best.etag = source ? str_of(source->ENTITY_TAG()) : std::string();
    }
    return best;
}

// The FlatSQL tagged parameter encoding: [u8 tag][u32le size][bytes]; tag 2 = int64.
void put_i64_param(Bytes* out, int64_t v) {
    out->push_back(2);
    const uint32_t size = 8;
    for (int i = 0; i < 4; i++) out->push_back(static_cast<uint8_t>((size >> (8 * i)) & 0xff));
    for (int i = 0; i < 8; i++) out->push_back(static_cast<uint8_t>((static_cast<uint64_t>(v) >> (8 * i)) & 0xff));
}

}  // namespace

extern "C" {

// mark_query: the daily timer tick -> the $FSO that reads the resume marks back. A SEPARATE node from ingest_plan on
// purpose: the plan takes the mark as an INPUT, and a node that emitted its own input would be a cycle in the flow graph.
// The engine-routed read form: the newest geonames_mark_scan_rows (32) $IRM records of the code-named view, from which
// ingest_plan picks this dataset's by JOB_ID; geonames_mark_sql overrides the SQL (one int64 parameter, the row count).
int mark_query(void) {
    if (refuse_batched()) return 500;
    const Config config = load_config();
    const std::string sql = config.string("geonames_mark_sql", kDefaultMarkSql);
    double rows = config.number("geonames_mark_scan_rows", kDefaultMarkScanRows);
    if (rows <= 0) rows = kDefaultMarkScanRows;
    Bytes params;
    put_i64_param(&params, static_cast<int64_t>(rows));
    flatbuffers::FlatBufferBuilder b(256 + sql.size());
    const auto query = b.CreateVector(reinterpret_cast<const uint8_t*>(sql.data()), sql.size());
    const auto parameters = b.CreateVector(params);
    FSOBuilder fso(b);
    fso.add_OPERATION(flatSqlNodeOperation_QUERY_RECORDS);
    fso.add_QUERY(query);
    fso.add_PARAMETERS(parameters);
    fso.add_PARAMETER_COUNT(1);
    FinishFSOBuffer(b, fso.Finish());
    return plugin_push_output_ex("query", "FSO.fbs", FSOIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "FSO", 0, 0,
                                 b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0 ? 500 : 0;
}

// ingest_plan: tick (+ the resume marks, when the store has any) -> the fetches for THIS tick, each carrying its job.
//
// Three outcomes, and only three:
//   SEED   (no mark for this dataset, or one that never completed) — the archive plus the three division/country files.
//   DELTA  (seeded) — the tick's own UTC day: modifications + deletes, both plain text, both full geoname/tombstone rows.
//   NO-OP  (the mark already carries this date) — NOTHING is emitted, the http nodes never become ready and the run ends
//          without a fetch. A day already ingested is not an error.
int ingest_plan(void) {
    if (refuse_batched("mark")) return 500;

    const Config config = load_config();
    const std::string base = config.string("geonames_base_url", kDefaultBaseUrl);
    const std::string dataset = config.string("geonames_dataset_id", kDefaultDatasetId);
    const std::string seed_name = config.string("geonames_seed_dataset", kDefaultSeedDataset);
    const uint32_t timeout = static_cast<uint32_t>(config_timeout_ms(config));

    // The UTC date this tick is ingesting is taken from the TICK, never from a clock read inside the guest: two nodes of
    // one flow reading the clock a millisecond apart across midnight would plan one date and store another, and the mark
    // would then skip a day forever.
    const plugin_input_frame_t* tick_frame = frame_for("tick");
    const R::TimerTick* tick = verified<R::TimerTick>(tick_frame, [](flatbuffers::Verifier& v) { return R::VerifyTimerTickBuffer(v); }, &R::GetTimerTick);
    if (tick_frame && tick_frame->payload_length && !tick) {
        plugin_set_error("invalid-tick-frame", "the frame on port \"tick\" is not a TimerTick (TICK).");
        return 400;
    }
    const uint64_t fired = tick ? (tick->FIRED_MS() ? tick->FIRED_MS() : tick->SCHEDULED_MS()) : 0;
    const std::string date = fired ? iso_of_ms(fired, true) : std::string();

    Mark mark;
    std::string stream, bad;
    if (!reassemble("mark", &stream, &bad)) {
        plugin_set_error("invalid-mark-frame", bad.c_str());
        return 400;
    }
    // A mark belonging to a DIFFERENT dataset is never resumed from (it is another JOB_ID): resuming dataset A from
    // dataset B's date would skip A's seed and never report it.
    if (!stream.empty()) mark = read_mark(stream, job_id_of(dataset));

    // LEDGERED NO-OP. The cheapest possible tick: the day this tick would fetch is already on the mark, so nothing is
    // requested at all. This is what makes an overrun tick harmless and a restart free.
    if (mark.seeded && !date.empty() && date == mark.date) return 0;

    if (date.empty()) {
        // $GNP.SOURCE.DATASET_EPOCH is REQUIRED on every record and the epoch is the EDITION boundary, so it comes from
        // the tick and is never guessed.
        plugin_set_error("missing-tick-date",
                         "ingest_plan needs the tick's FIRED_MS (or SCHEDULED_MS) to date this edition; "
                         "$GNP.SOURCE.DATASET_EPOCH is required on every record and an epoch "
                         "guessed in-guest would make two editions falsely comparable.");
        return 400;
    }
    const bool seeded = mark.seeded;
    const std::string epoch = date + "T00:00:00.000Z";

    JobSpec job;
    job.id_prefix = config.string("geonames_id_prefix", kDefaultDatasetId);
    job.dataset_id = dataset;
    job.dataset_name = config.string("geonames_dataset_name", "GeoNames gazetteer");
    job.dataset_url = base;
    job.dataset_epoch = epoch;
    job.license = config.string("geonames_license", kDefaultLicense);
    job.license_url = config.string("geonames_license_url", kDefaultLicenseUrl);
    job.attribution = config.string("geonames_attribution", kDefaultAttribution);
    job.share_alike = config.boolean("geonames_share_alike", false);
    job.non_commercial_only = config.boolean("geonames_non_commercial_only", false);
    // A fetch's job: the dataset contract, plus the file this fetch selects and the text it decodes.
    auto job_for = [&](const std::string& file, const std::string& text) {
        JobSpec j = job;
        j.source_url = base + file;
        j.source_query = file;
        j.name = text;
        return job_header(j);
    };

    if (seeded) {
        // DELTA: the day's modifications (the mark's ETag rides out as if-none-match, so an unchanged file costs one
        // conditional request) and the tombstone lane. A seed edition IS the gazetteer's current state and has nothing
        // to remove, so only the delta has deletes.
        const std::string mods = "modifications-" + date + ".txt", dels = "deletes-" + date + ".txt";
        const Bytes mods_job = job_for(mods, mods), dels_job = job_for(dels, dels);
        std::vector<std::pair<std::string, std::string>> headers;
        if (!mark.etag.empty()) headers.push_back({"if-none-match", mark.etag});
        if (push_request("request", http_request("GET", base + mods, headers, nullptr, timeout, &mods_job)) < 0) return 500;
        return push_request("request_deletes", http_request("GET", base + dels, {}, nullptr, timeout, &dels_job)) < 0 ? 500 : 0;
    }

    // SEED: the archive carries an explicit Range under the host's 4 MiB response-body cap; the division and country
    // tables are fetched only with the seed, because $GNP needs them to resolve names and they change on the
    // gazetteer's own slow cadence, not daily.
    char range[48];
    std::snprintf(range, sizeof(range), "bytes=0-%ld", config_seed_max_bytes(config) - 1);
    std::vector<std::pair<std::string, std::string>> headers{{"range", range}};
    if (!mark.etag.empty()) headers.push_back({"if-none-match", mark.etag});
    const Bytes seed_job = job_for(seed_name + ".zip", seed_name + ".txt");
    if (push_request("request", http_request("GET", base + seed_name + ".zip", headers, nullptr, timeout, &seed_job)) < 0) return 500;
    const struct { const char* port; const char* file; } lookups[] = {
        {"request_admin1", "admin1CodesASCII.txt"}, {"request_admin2", "admin2Codes.txt"}, {"request_country", "countryInfo.txt"}};
    for (const auto& l : lookups) {
        const Bytes lookup_job = job_for(l.file, l.file);
        if (push_request(l.port, http_request("GET", base + l.file, {}, nullptr, timeout, &lookup_job)) < 0) return 500;
    }
    return 0;
}

// ingest_meta: the $GNP record stream and the main fetch's HttpResponse (its job in CONTEXT) -> the
// hostcap/storage-ingest IngestRequest and the records, forwarded untouched.
//
// This node exists to author the attribution the storage lane cannot invent — dataset, source, batch — and to read the
// three facts only the RESPONSE carries: Content-Range's total, the ETag and Last-Modified the ledger turns on (they
// travel on as the IngestRequest's PROVENANCE, with the record count, for publish_request).
int ingest_meta(void) {
    if (refuse_batched()) return 500;

    const plugin_input_frame_t* records = frame_for("records");
    if (!records || !records->payload) {
        plugin_set_error("missing-records-frame", "ingest_meta requires the decoded $GNP record stream.");
        return 400;
    }
    // The record count this tick actually produced: the stream's own frames. publish_request needs it to tell a
    // genuinely empty day from a stored-nothing refusal.
    uint64_t records_in = 0;
    for (size_t at = 0; at < records->payload_length;) {
        if (records->payload_length - at < 4) { plugin_set_error("invalid-records-frame", "trailing bytes after the last size-prefixed $GNP record."); return 400; }
        const uint8_t* p = records->payload + at;
        const uint32_t size = static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) | (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
        if (size > records->payload_length - at - 4) { plugin_set_error("invalid-records-frame", "a size-prefixed $GNP record overruns the stream."); return 400; }
        at += 4u + size;
        if (size) records_in++;
    }

    const plugin_input_frame_t* response_frame = frame_for("response");
    const R::HttpResponse* response =
        verified<R::HttpResponse>(response_frame, [](flatbuffers::Verifier& v) { return R::VerifyHttpResponseBuffer(v); }, &R::GetHttpResponse);
    if (!response) {
        plugin_set_error(response_frame ? "invalid-response-frame" : "missing-response-frame",
                         "ingest_meta requires the main fetch's HttpResponse (HRSP), which carries the job in CONTEXT.");
        return 400;
    }
    const Job job = job_of(*response);
    if (job.dataset_id.empty() || job.source_url.empty() || job.dataset_epoch.empty()) {
        plugin_set_error("incomplete-job-attribution",
                         "ingest_meta needs DATASET_ID, SOURCE_URL and DATASET_EPOCH on the job ($GNP header in the "
                         "response's CONTEXT); storage cannot invent the edition a record belongs to.");
        return 400;
    }

    const Config config = load_config();
    const std::string etag = header_of(*response, "etag");
    const std::string last_modified = header_of(*response, "last-modified");
    long total_bytes = 0;
    total_from_content_range(header_of(*response, "content-range"), &total_bytes);

    // THE SEED MUST NOT BE SILENTLY TRUNCATED. The host caps a response body at 4 MiB; if Content-Range's denominator
    // proves the archive is larger than the range that was asked for, the bytes in hand are a PREFIX of a ZIP.
    const long seed_max = config_seed_max_bytes(config);
    if (job.seed() && total_bytes > seed_max) {
        char message[288];
        std::snprintf(message, sizeof(message),
                      "the seed archive is %ld bytes but the host caps a response body at %ld; "
                      "the bytes in hand are a PREFIX of the archive. Decoding a prefix would "
                      "report a gazetteer that is merely missing places, so the run stops here. "
                      "Split the seed across ticks or select a smaller edition.",
                      total_bytes, seed_max);
        plugin_set_error("seed-exceeds-host-body-cap", message);
        return 502;
    }

    // ONE BATCH PER EDITION. The batch id is the dataset and the epoch's date, so re-running a day is idempotent at the
    // storage lane and two days never collide; publish_request reads the edition back from it.
    const std::string batch_id = job.dataset_id + "@" + job.date();

    R::IngestRequestT meta;
    meta.SCHEMA = kSchema;
    meta.TAGS = std::make_unique<R::SourceTagsT>();
    meta.TAGS->PROVIDER_ID = config.string("geonames_provider_id", kDefaultProviderId);
    meta.TAGS->SOURCE_NAME = config.string("geonames_source_name", kDefaultSourceName);
    meta.TAGS->BATCH_ID = batch_id;
    meta.TAGS->SOURCE_URL = job.source_url;
    // NOT a source-batch reconcile, for BOTH lanes: the delta is an upsert of a few thousand rows and not the
    // gazetteer's complete set, so retiring older batches on it would delete the entire rest of the world; the seed is
    // stored as given for symmetry (the JSON lane's "append").
    meta.RECONCILE = R::reconcileMode_None;
    meta.PROVENANCE = std::make_unique<R::ProvenanceT>();
    meta.PROVENANCE->SOURCE_URL = job.source_url;
    meta.PROVENANCE->HTTP_STATUS = response->STATUS();
    meta.PROVENANCE->ETAG = etag;
    meta.PROVENANCE->LAST_MODIFIED = last_modified;
    meta.PROVENANCE->CONTENT_TYPE = header_of(*response, "content-type");
    meta.PROVENANCE->RETRIEVED_MS = response->RETRIEVED_MS();
    meta.PROVENANCE->PARSER = kParser;
    meta.PROVENANCE->PARSER_VERSION = kParserVersion;
    meta.PROVENANCE->NORMALIZED_COUNT = records_in;
    meta.PROVENANCE->SCHEMAS = {kSchema};
    meta.PROVENANCE->SCHEMA_COUNTS = {records_in};
    flatbuffers::FlatBufferBuilder b(1024);
    R::FinishIngestRequestBuffer(b, R::IngestRequest::Pack(b, &meta));
    if (plugin_push_output_ex("meta", "IngestRequest.fbs", R::IngestRequestIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                              "IngestRequest", 0, 0, b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0) {
        return 500;
    }
    return plugin_push_output_ex("records", "GNP.fbs", GNPIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "GNP", 0, 0,
                                 records->payload, records->payload_length) < 0 ? 500 : 0;
}

// publish_request: the storage-ingest IngestResult joined with the IngestRequest that produced it -> the advanced
// resume mark ($IRM), and (only when configured) the dataset-publication POST that announces the epoch, its BODY the
// IngestResult naming the stored batch.
//
// The epoch announce mints NO new record type: DATASET_EPOCH and DATASET_CID already ride in $GNP.SOURCE on every stored
// record, so the announcement is the node's normal per-(provider, standard) publication of the batch. The mark is NOT
// gated on the publish URL: a node that stores without publishing must still make progress.
int publish_request(void) {
    if (refuse_batched()) return 500;

    const plugin_input_frame_t* result_frame = frame_for("result");
    const plugin_input_frame_t* meta_frame = frame_for("meta");
    if (!result_frame || !result_frame->payload || result_frame->payload_length == 0) {
        plugin_set_error("missing-result-frame", "publish_request requires the storage-ingest result frame.");
        return 400;
    }
    if (!meta_frame || !meta_frame->payload || meta_frame->payload_length == 0) {
        plugin_set_error("missing-meta-frame", "publish_request requires the ingest meta frame.");
        return 400;
    }
    const R::IngestResult* result =
        verified<R::IngestResult>(result_frame, [](flatbuffers::Verifier& v) { return R::VerifyIngestResultBuffer(v); }, &R::GetIngestResult);
    if (!result) { plugin_set_error("invalid-result-frame", "the result frame is not an IngestResult (INGR)."); return 400; }
    const R::IngestRequest* meta =
        verified<R::IngestRequest>(meta_frame, [](flatbuffers::Verifier& v) { return R::VerifyIngestRequestBuffer(v); }, &R::GetIngestRequest);
    if (!meta) { plugin_set_error("invalid-meta-frame", "the meta frame is not an IngestRequest (INGQ)."); return 400; }

    const R::SourceTags* tags = meta->TAGS();
    const R::Provenance* provenance = meta->PROVENANCE();
    std::string batch_id = str_of(tags->BATCH_ID());
    if (batch_id.empty()) batch_id = str_of(result->BATCH_ID());

    // A REFUSED batch stored nothing (a value over its aligned bound, a host refusal such as the disk guardrail): the
    // mark does not advance and the ETag is not ledgered, exactly as when the JSON lane's storage node failed.
    if (result->REFUSED() && result->REFUSED()->size()) {
        const std::string message = "storage-ingest refused batch " + batch_id + ": " + result->REFUSED()->str() +
                                    ". The resume mark is NOT advanced and the upstream ETag is NOT ledgered.";
        plugin_set_error("ingest-refused", message.c_str());
        return 502;
    }

    // THE SILENT NOP, CAUGHT. What survives a refusal check is inserted=0, byte-identical to a day on which the
    // gazetteer changed nothing. It is only distinguishable against the count the run actually produced (the
    // IngestRequest's PROVENANCE.NORMALIZED_COUNT), so the mark does NOT advance (and the ETag is NOT ledgered) when
    // records went in and nothing came out.
    const uint64_t inserted = result->INSERTED();
    const int64_t records_in = provenance ? static_cast<int64_t>(provenance->NORMALIZED_COUNT()) : -1;
    if (inserted == 0 && records_in > 0) {
        char message[320];
        std::snprintf(message, sizeof(message),
                      "storage.ingest_with_source reported inserted=0 for an edition carrying %lld records (batch %s). "
                      "The resume mark is NOT advanced and the upstream ETag is NOT ledgered: doing either would make "
                      "every later tick no-op against places that were never stored.",
                      static_cast<long long>(records_in), batch_id.c_str());
        plugin_set_error("ingest-stored-nothing", message);
        return 502;
    }

    // The edition, from the batch id ingest_meta minted ("<dataset id>@<YYYY-MM-DD>").
    const size_t at = batch_id.rfind('@');
    const std::string dataset = at == std::string::npos ? std::string() : batch_id.substr(0, at);
    const std::string date = at == std::string::npos ? std::string() : batch_id.substr(at + 1);
    const int64_t day = day_number(date);
    if (dataset.empty() || day < 0) {
        plugin_set_error("incomplete-mark-identity", ("publish_request cannot read the edition from batch id \"" + batch_id +
                                                      "\" (<dataset id>@<YYYY-MM-DD>).").c_str());
        return 400;
    }
    std::string source_url = str_of(tags->SOURCE_URL());
    if (source_url.empty() && provenance) source_url = str_of(provenance->SOURCE_URL());
    const bool seed = source_url.size() >= 4 && source_url.compare(source_url.size() - 4, 4, ".zip") == 0;
    const std::string epoch = date + "T00:00:00.000Z";
    const std::string now = iso_now();

    // THE MARK: one $IRM per stored edition. JOB_ID = geonames-ingest/<dataset>, SEQUENCE = the edition's day number
    // (monotonic per job), STATE COMPLETE, SOURCE = the edition (URL, the ETag / Last-Modified the ledger turns on,
    // SOURCE_VERSION = the DATASET_EPOCH), LAST_CHUNK = the stored batch, TAGS date:<day> and lane:<seed|delta>.
    {
        flatbuffers::FlatBufferBuilder b(1024);
        const auto job_id = b.CreateString(job_id_of(dataset));
        const auto provider = b.CreateString(str_of(tags->PROVIDER_ID()));
        const auto ingestor = b.CreateString(kIngestorId);
        const auto url = b.CreateString(source_url);
        const std::string etag = provenance ? str_of(provenance->ETAG()) : std::string();
        const std::string modified = provenance ? str_of(provenance->LAST_MODIFIED()) : std::string();
        const auto etag_off = etag.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateString(etag);
        const auto modified_off = modified.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateString(modified);
        const auto version = b.CreateString(epoch);
        IRMSourceBuilder sb(b);
        sb.add_SOURCE_URL(url);
        if (!etag_off.IsNull()) sb.add_ENTITY_TAG(etag_off);
        if (!modified_off.IsNull()) sb.add_LAST_MODIFIED(modified_off);
        sb.add_SOURCE_VERSION(version);
        const auto source = sb.Finish();
        const auto batch = b.CreateString(batch_id);
        const auto committed = b.CreateString(now);
        IRMChunkBuilder cb(b);
        cb.add_BATCH_ID(batch);
        if (records_in >= 0) cb.add_RECORDS_DECODED(static_cast<uint32_t>(records_in));
        cb.add_RECORDS_STORED(static_cast<uint32_t>(inserted));
        cb.add_COMMITTED_AT(committed);
        const auto chunk = cb.Finish();
        const auto target = b.CreateString(kTargetStandard);
        const auto reconcile = b.CreateString("none");
        const auto updated = b.CreateString(now);
        const auto tag_list = b.CreateVectorOfStrings({"date:" + date, std::string("lane:") + (seed ? "seed" : "delta")});
        IRMBuilder ib(b);
        ib.add_JOB_ID(job_id);
        ib.add_SEQUENCE(static_cast<uint64_t>(day));
        ib.add_PROVIDER_ID(provider);
        ib.add_INGESTOR_ID(ingestor);
        ib.add_SOURCE(source);
        ib.add_STATE(irmJobState_COMPLETE);
        ib.add_LAST_CHUNK(chunk);
        ib.add_CHUNKS_COMMITTED(1);
        ib.add_RECORDS_COMMITTED(inserted);
        ib.add_TARGET_STANDARD(target);
        ib.add_RECONCILE_MODE(reconcile);
        ib.add_UPDATED_AT(updated);
        ib.add_COMPLETED_AT(updated);
        ib.add_TAGS(tag_list);
        FinishIRMBuffer(b, ib.Finish());
        if (plugin_push_output_ex("mark", "IRM.fbs", IRMIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "IRM", 0, 0,
                                  b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0) {
            return 500;
        }
    }

    const Config config = load_config();
    const std::string publish_url = config.string("geonames_publish_url", "");
    // Fail-closed. Absence of configuration is not permission to publish.
    if (publish_url.empty()) return 0;

    std::string schema = str_of(result->SCHEMA());
    if (schema.empty()) schema = str_of(meta->SCHEMA());
    const std::string provider = str_of(tags->PROVIDER_ID()), source = str_of(tags->SOURCE_NAME());
    if (schema.empty() || batch_id.empty() || provider.empty() || source.empty()) {
        plugin_set_error("incomplete-publication-identity", "publish_request needs schema, batchId, providerId and sourceName.");
        return 400;
    }
    flatbuffers::FlatBufferBuilder b(512);
    R::FinishIngestResultBuffer(b, R::CreateIngestResultDirect(b, schema.c_str(), provider.c_str(), source.c_str(), batch_id.c_str(), inserted,
                                                               result->RECONCILED_DUPLICATES(), result->RECONCILED_OLD_BATCHES(),
                                                               result->ARCHIVED() && result->ARCHIVED()->size() ? result->ARCHIVED()->c_str() : nullptr,
                                                               nullptr));
    const Bytes body = finished(b);
    return push_request("request", http_request("POST", publish_url, {{"content-type", "application/octet-stream"}}, &body,
                                                static_cast<uint32_t>(config_timeout_ms(config)), nullptr)) < 0 ? 500 : 0;
}

}  // extern "C"
