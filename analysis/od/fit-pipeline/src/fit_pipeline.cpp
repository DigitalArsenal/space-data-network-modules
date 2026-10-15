/*
 * fit_pipeline.cpp - OD fit pipeline on typed contracts (1.0).
 *
 * On a TimerTick, reads the stored operator ephemerides ($OEM records) through the typed storage.query hostcall,
 * fits SGP4 supplemental-GP mean elements per object with analysis/od's own fitter, and emits the fits as SDS
 * records: $OMM on "omm" and $OBD on "obd", built by analysis/od's own builders (the bytes analysis/od's `fit` emits
 * for the same states and settings). Every record it does not fit is a FlowNotice on "status", with a per-provider
 * summary. Storing and publishing the fits is the flow's job (hostcap/storage-ingest), not this module's.
 *
 *   tick (TICK) -> storage.query(SCHEMA, LIMIT): records_meta (StoredRecordMeta) + records (size-prefixed bytes)
 *     -> od::read_oem_flatbuffer           (analysis/od: frame / time / center rules, TEME)
 *     -> od::fit_sgp4_series               (analysis/od: the one OD fit)
 *     -> od::build_omm_flatbuffer / build_obd_flatbuffer -> omm / obd
 *
 * Config (plugin.getConfig, one ModuleConfig): querySchema ("OEM"), queryLimit (500), providers (a list of
 * {sourceName, dataSource, requireConverged, fit: {maxIterations, fitWindowSec, subsample, convergenceTol}}; when
 * given it replaces the compiled set), idRegistry ({<OBJECT_NAME>: {NORAD_CAT_ID, OBJECT_ID}}, empty by default).
 * A host that cannot answer plugin.getConfig leaves the compiled set (spacex-starlink / SpaceX-E and iss / ISS-E,
 * 50 iterations each).
 */
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

#include "od/obd_fb_builder.h"
#include "od/oem_fb_reader.h"
#include "od/omm_fb_builder.h"
#include "od/sgp4_fitter.h"
#include "od/state_series.h"

#include "space_data_module_invoke.h"
#include "FlowNotice_generated.h"
#include "TimerTick_generated.h"
#include "typedHostcall.hpp"

namespace {

namespace R = sdn::runtime;
namespace A = sdn::runtime::Aligned;

// -- per-provider fit configuration (data-driven) ------------------------------------------------------------------

struct ProviderFit {
    std::string source_name;  // the stored record's SOURCE_NAME (grouping key)
    std::string data_source;  // labels the fit ($OBD SENSORS[0].SENSOR_ID), e.g. "SpaceX-E"
    int max_iterations = 0;   // 0 = solver default; clamped 1..300 as analysis/od's fit does
    double fit_window_sec = 11520.0;
    int subsample = 0;        // 0 = the fitter's default
    double convergence_tol = 0.0002;
    bool require_converged = true;
};

struct IdRegistryEntry {
    std::string key;  // the record's OBJECT_NAME (slot / name / PRN)
    int norad = 0;
    std::string object_id;
};

struct PipelineConfig {
    std::string query_schema = "OEM";
    uint32_t query_limit = 500;
    std::vector<ProviderFit> providers;
    std::vector<IdRegistryEntry> id_registry;
};

PipelineConfig default_config() {
    PipelineConfig c;
    ProviderFit sx;
    sx.source_name = "spacex-starlink";
    sx.data_source = "SpaceX-E";
    sx.max_iterations = 50;
    c.providers.push_back(sx);
    ProviderFit iss;
    iss.source_name = "iss";
    iss.data_source = "ISS-E";
    iss.max_iterations = 50;
    c.providers.push_back(iss);
    return c;
}

void read_provider(const sdm_piv::ConfigTable& t, ProviderFit* p) {
    p->source_name = std::string(t.string("sourceName"));
    p->data_source = std::string(t.string("dataSource"));
    const sdm_piv::ConfigTable fit = t.table("fit");
    if (fit) {
        double d = fit.number("maxIterations", 0);
        if (d > 0) p->max_iterations = static_cast<int>(d);
        d = fit.number("fitWindowSec", 0);
        if (d > 0) p->fit_window_sec = d;
        d = fit.number("subsample", -1);
        if (d >= 0) p->subsample = static_cast<int>(d);
        d = fit.number("convergenceTol", 0);
        if (d > 0) p->convergence_tol = d;
    }
    p->require_converged = t.boolean("requireConverged", true);
}

PipelineConfig resolve_config() {
    PipelineConfig cfg = default_config();
    const sdm_piv::Config config = sdm_piv::get_config();
    if (!config.ok()) return cfg;  // no node config: the compiled set
    const std::string_view schema = config.string("querySchema");
    if (!schema.empty()) cfg.query_schema = std::string(schema);
    const double limit = config.number("queryLimit", 0);
    if (limit > 0) cfg.query_limit = static_cast<uint32_t>(std::min(limit, 4294967295.0));
    const size_t n = config.tables("providers");
    if (n > 0) {
        std::vector<ProviderFit> providers;
        for (size_t i = 0; i < n; ++i) {
            ProviderFit p;
            read_provider(config.table("providers", i), &p);
            if (!p.source_name.empty()) providers.push_back(p);
        }
        if (!providers.empty()) cfg.providers = providers;
    }
    // idRegistry: one nested table per OBJECT_NAME key; it REPLACES the (empty) default.
    const sdm_piv::ConfigTable registry = config.table("idRegistry");
    if (registry && registry.entries()) {
        for (const auto* entry : *registry.entries()) {
            if (!entry->KEY() || entry->KIND() != R::configValueKind_TableList || !entry->TABLES() ||
                entry->TABLES()->size() != 1) {
                continue;
            }
            const sdm_piv::ConfigTable value(entry->TABLES()->Get(0)->ENTRIES());
            IdRegistryEntry e;
            e.key = entry->KEY()->str();
            e.norad = static_cast<int>(value.number("NORAD_CAT_ID", 0));
            e.object_id = std::string(value.string("OBJECT_ID"));
            if (!e.key.empty() && (e.norad != 0 || !e.object_id.empty())) cfg.id_registry.push_back(e);
        }
    }
    return cfg;
}

const IdRegistryEntry* id_registry_lookup(const PipelineConfig& cfg, const std::string& key) {
    if (key.empty()) return nullptr;
    for (const IdRegistryEntry& e : cfg.id_registry) {
        if (e.key == key) return &e;
    }
    return nullptr;
}

// -- the store's records -------------------------------------------------------------------------------------------

struct StoredRecord {
    std::string cid;
    std::string provider_id;
    std::string source_name;
    const uint8_t* data = nullptr;  // the $OEM FlatBuffer (root, not size-prefixed), in the hostcall response
    size_t size = 0;
};

std::string aligned_string(const flatbuffers::aligned_runtime::AlignedString<128>& s) { return s.str(); }

// storage.query: one StoredRecordMeta per record on list "records_meta", the records on raw "records" as
// [u32le length][bytes] runs in the same order. A stored record may itself be size-prefixed; either form is read.
bool storage_query(const PipelineConfig& cfg, sdm_piv::Response* response, std::vector<StoredRecord>* out,
                   std::string* error) {
    A::StorageQueryParams params{};
    if (!sdm_piv::put(params.SCHEMA, cfg.query_schema)) {
        *error = "querySchema \"" + cfg.query_schema + "\" is longer than storage.query takes";
        return false;
    }
    params.set_has_SCHEMA(true);
    params.LIMIT = cfg.query_limit;
    *response = sdm_piv::call("storage.query", "StorageQueryParams", params);
    if (!response->ok()) {
        *error = response->error_message();
        if (error->empty()) *error = response->error_code();
        if (error->empty()) *error = "storage.query failed";
        return false;
    }
    const auto [meta, count] = response->list<A::StoredRecordMeta>("records_meta");
    const std::string_view raw = response->raw("records");
    size_t at = 0;
    for (size_t i = 0; i < count; ++i) {
        if (at + 4 > raw.size()) break;
        uint32_t len = 0;
        std::memcpy(&len, raw.data() + at, 4);
        at += 4;
        if (at + len > raw.size()) break;
        StoredRecord r;
        r.cid = aligned_string(meta[i].CID);
        r.provider_id = aligned_string(meta[i].PROVIDER_ID);
        r.source_name = aligned_string(meta[i].SOURCE_NAME);
        r.data = reinterpret_cast<const uint8_t*>(raw.data() + at);
        r.size = len;
        if (r.size >= 12 && !od::is_oem_flatbuffer(r.data, r.size) && od::is_oem_flatbuffer(r.data + 4, r.size - 4)) {
            uint32_t inner = 0;
            std::memcpy(&inner, r.data, 4);
            if (inner == r.size - 4) {
                r.data += 4;
                r.size -= 4;
            }
        }
        at += len;
        out->push_back(r);
    }
    return true;
}

// The record is read in place from the hostcall response; FlatBuffers wants its root 4-aligned.
std::vector<uint8_t> aligned_copy(const StoredRecord& r) { return std::vector<uint8_t>(r.data, r.data + r.size); }

// -- outputs -------------------------------------------------------------------------------------------------------

uint64_t g_at_ms = 0;  // the tick's FIRED_MS (0 without a tick)

bool push_record(const char* port, const char* schema, const char* file_id, const char* root,
                 const std::vector<uint8_t>& bytes) {
    if (bytes.empty() ||
        plugin_push_output_ex(port, schema, file_id, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, root, 0, 8, bytes.data(),
                              static_cast<uint32_t>(bytes.size())) < 0) {
        plugin_set_error("emit-failed", (std::string("Failed to emit the ") + file_id + " frame.").c_str());
        return false;
    }
    return true;
}

bool push_notice(R::flowNoticeKind kind, const std::string& schema, const std::string& provider_id,
                 const std::string& source_name, uint64_t count, const std::string& reason,
                 const std::vector<std::string>& items) {
    flatbuffers::FlatBufferBuilder b(256 + reason.size());
    std::vector<flatbuffers::Offset<flatbuffers::String>> item_offsets;
    for (const std::string& item : items) item_offsets.push_back(b.CreateString(item));
    const auto items_vector = item_offsets.empty() ? 0 : b.CreateVector(item_offsets);
    const auto schema_s = b.CreateString(schema);
    const auto provider_s = provider_id.empty() ? 0 : b.CreateString(provider_id);
    const auto source_s = source_name.empty() ? 0 : b.CreateString(source_name);
    const auto reason_s = b.CreateString(reason);
    R::FlowNoticeBuilder n(b);
    n.add_KIND(kind);
    n.add_SCHEMA(schema_s);
    if (!provider_id.empty()) n.add_PROVIDER_ID(provider_s);
    if (!source_name.empty()) n.add_SOURCE_NAME(source_s);
    n.add_COUNT(count);
    n.add_REASON(reason_s);
    if (!items.empty()) n.add_ITEMS(items_vector);
    n.add_AT_MS(g_at_ms);
    R::FinishFlowNoticeBuffer(b, n.Finish());
    if (plugin_push_output_ex("status", "FlowNotice.fbs", R::FlowNoticeIdentifier(),
                              PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "FlowNotice", 0, 0, b.GetBufferPointer(),
                              static_cast<uint32_t>(b.GetSize())) < 0) {
        plugin_set_error("emit-failed", "Failed to emit a FlowNotice.");
        return false;
    }
    return true;
}

// -- the pipeline --------------------------------------------------------------------------------------------------

struct ProviderStats {
    long candidates = 0, fitted = 0, id_mapped = 0, id_unmapped = 0, skipped = 0;
    std::vector<std::string> fitted_cids;  // in the order of the omm / obd records
};

constexpr size_t kMinSamples = 8;

int run_pipeline() {
    // The tick is optional (a direct invoke needs none); its FIRED_MS stamps the notices.
    g_at_ms = 0;
    const uint32_t inputs = plugin_get_input_count();
    for (uint32_t i = 0; i < inputs; ++i) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        if (!frame || !frame->port_id || std::strcmp(frame->port_id, "tick") != 0 || !frame->payload) continue;
        flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
        if (R::VerifyTimerTickBuffer(verifier)) g_at_ms = R::GetTimerTick(frame->payload)->FIRED_MS();
    }

    const PipelineConfig cfg = resolve_config();
    sdm_piv::Response response(std::vector<uint8_t>{});
    std::vector<StoredRecord> records;
    std::string query_error;
    if (!storage_query(cfg, &response, &records, &query_error)) {
        return push_notice(R::flowNoticeKind_Missing, cfg.query_schema, "", "", 0,
                           "storage-query-failed: " + query_error, {})
                   ? 0
                   : 500;
    }

    std::vector<ProviderStats> stats(cfg.providers.size());
    std::vector<std::string> unconfigured;

    for (const StoredRecord& rec : records) {
        // The provider a record belongs to: its SOURCE_NAME; an untagged record goes to the one provider of a
        // single-provider configuration.
        const ProviderFit* prov = nullptr;
        if (!rec.source_name.empty()) {
            for (const ProviderFit& p : cfg.providers) {
                if (p.source_name == rec.source_name) prov = &p;
            }
        } else if (cfg.providers.size() == 1) {
            prov = &cfg.providers[0];
        }
        if (!prov) {
            unconfigured.push_back(rec.cid);
            continue;
        }
        ProviderStats& st = stats[static_cast<size_t>(prov - cfg.providers.data())];
        st.candidates++;
        auto skip = [&](const std::string& reason) {
            st.skipped++;
            return push_notice(R::flowNoticeKind_Skipped, cfg.query_schema, rec.provider_id, prov->source_name, 1,
                               reason, {rec.cid});
        };

        const std::vector<uint8_t> bytes = aligned_copy(rec);
        od::OEMParseResult parsed = od::read_oem_flatbuffer(bytes.data(), bytes.size());
        if (!parsed.ok) {
            if (!skip(parsed.error_code + ": " + parsed.error_message)) return 500;
            continue;
        }
        od::StateSeries series = std::move(parsed.series);
        if (series.samples.size() < kMinSamples) {
            if (!skip("too-few-samples:" + std::to_string(series.samples.size()))) return 500;
            continue;
        }
        series.meta.data_source = prov->data_source;

        // IDs: the source's NORAD wins; otherwise the owner registry by OBJECT_NAME; otherwise honest-empty IDs
        // (NORAD 0, OBJECT_ID ""), fitted anyway. Never fabricated.
        bool unmapped = false;
        if (series.meta.norad_cat_id <= 0) {
            if (const IdRegistryEntry* e = id_registry_lookup(cfg, series.meta.object_name)) {
                series.meta.norad_cat_id = e->norad;
                if (!e->object_id.empty()) series.meta.object_id = e->object_id;
                st.id_mapped++;
            } else {
                unmapped = true;
                st.id_unmapped++;
            }
        }

        od::FitterConfig fc;
        if (prov->max_iterations > 0) fc.max_iterations = std::clamp(prov->max_iterations, 1, 300);
        fc.fit_window_sec = prov->fit_window_sec;
        if (prov->subsample > 0) fc.subsample = prov->subsample;
        fc.convergence_tol = prov->convergence_tol;

        od::FitResult fit = od::fit_sgp4_series(series, fc);
        if (unmapped) {
            fit.elements.norad_cat_id = 0;
            fit.elements.object_id.clear();
        }
        if (prov->require_converged && !fit.converged) {
            char reason[96];
            std::snprintf(reason, sizeof(reason), "%d:fit-not-converged:rms=%.3f", series.meta.norad_cat_id,
                          fit.rms_km);
            if (!skip(reason)) return 500;
            continue;
        }

        const double fit_span_days =
            series.samples.size() >= 2 ? series.samples.back().epoch_jd - series.samples.front().epoch_jd : 0.0;
        if (!push_record("omm", "OMM.fbs", "$OMM", "OMM", od::build_omm_flatbuffer(fit.elements)) ||
            !push_record("obd", "OBD.fbs", "$OBD", "OBD", od::build_obd_flatbuffer(fit.elements, fit_span_days))) {
            return 500;
        }
        st.fitted++;
        st.fitted_cids.push_back(rec.cid);
    }

    if (!unconfigured.empty() &&
        !push_notice(R::flowNoticeKind_Skipped, cfg.query_schema, "", "", unconfigured.size(), "unconfigured",
                     unconfigured)) {
        return 500;
    }
    // One summary per provider: COUNT = records fitted, ITEMS = their source CIDs in the order of the omm records.
    for (size_t i = 0; i < cfg.providers.size(); ++i) {
        const ProviderStats& st = stats[i];
        const std::string reason = "fitted " + std::to_string(st.fitted) + " of " + std::to_string(st.candidates) +
                                   " (skipped " + std::to_string(st.skipped) + "; ids registry-mapped " +
                                   std::to_string(st.id_mapped) + ", unmapped " + std::to_string(st.id_unmapped) +
                                   "; " + std::to_string(records.size()) + " records read)";
        if (!push_notice(R::flowNoticeKind_Info, cfg.query_schema, "", cfg.providers[i].source_name,
                         static_cast<uint64_t>(st.fitted), reason, st.fitted_cids)) {
            return 500;
        }
    }
    return 0;
}

}  // namespace

extern "C" int fit_pipeline(void) {
    plugin_reset_output_state();
    return run_pipeline();
}
