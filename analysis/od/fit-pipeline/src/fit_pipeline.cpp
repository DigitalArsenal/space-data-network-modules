/*
 * fit_pipeline.cpp — OD fit pipeline (App 2, task A2.3).
 *
 * A scheduler-driven (TIMERS) module that turns stored operator-ephemeris OEM
 * records into SDN-fitted supplemental GP (SupGP / OMM) records:
 *
 *   storage.query(schema="OEM")            [consumption lane, cap: storage_query]
 *      -> canonical OEM JSON record per object (Starlink compact / ISS verbose)
 *      -> odpipe::oem_record_to_series      [reuse od frame/time machinery]
 *      -> od::fit_sgp4_series               [REUSE the existing OD fit — no fork]
 *      -> schema-exact OMM JSON + provenance COMMENT/lineage
 *      -> storage.write(OMM) -> keyslot.sign(CID) -> schema-exact PNM
 *      -> pubsub.publish(<provider OMM topic>)          [provider_source.hpp]
 *
 * Provider-agnostic: the provider set + per-provider fit config (max iterations —
 * reusing the OD max-iteration cap — fit window, subsample, convergence) are
 * DATA (request payload > plugin.getConfig module config > compiled fallback),
 * never hardcoded per provider. Records that cannot be fitted yet (unsupported
 * frame/time/center, undecodable shells, too few samples, non-converged fit) are
 * SKIPPED WITH AN HONEST REASON in the summary — never silently dropped or wrongly
 * fitted.
 *
 * Cron contract (SDN plugins/manager.go CronMethodSpec): a timer method receives
 * NO input (Input:"none", invoked with nil) and returns JSON — this module needs
 * ZERO Go changes; declaring a `timers` block in the manifest is sufficient. A
 * manual invoke MAY pass a JSON config payload to override the provider set.
 *
 * Hostcall ABI (space_data_module_host): see common/sdm_hostcall_wire.hpp.
 */
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string>
#include <vector>

#include "provider_source.hpp"       // ps:: hostcall/storage_write/keyslot/pubsub/json/sha256/base64
#include "od/sgp4_fitter.h"          // od::fit_sgp4_series, elements_to_json, FitterConfig
#include "od/state_series.h"
#include "oem_record_series.hpp"     // odpipe:: OEM-record -> StateSeries + JSON slicing

namespace ps = provider_source;

extern "C" {
__attribute__((visibility("default")))
uint8_t* plugin_alloc(uint32_t size) { return static_cast<uint8_t*>(malloc(size)); }
__attribute__((visibility("default")))
void plugin_free(uint8_t* ptr, uint32_t /*size*/) { free(ptr); }
}  // extern "C"

namespace {

// ── per-provider fit + publish configuration (data-driven) ───────────────────

struct ProviderFit {
    std::string source_name;      // SourceTags.SourceName written by the adapter (grouping key)
    std::string data_source;      // CelesTrak-comparable token, e.g. "SpaceX-E" (labels the OMM)
    std::string output_topic;     // pubsub topic for the fitted-OMM PNMs
    std::string signing_slot = "node-signing";
    std::string signature_type = "ed25519";
    std::string file_id_prefix;   // FILE_ID partition prefix (default derived from source_name)
    // Fit config — reuses the OD max-iteration cap (clamped 1..300 by the fitter path).
    int max_iterations = 0;       // 0 = solver default
    double fit_window_sec = 11520.0;
    int subsample = 0;            // 0 = auto (~144 pts over the window)
    double convergence_tol = 0.0002;
    bool require_converged = true;
};

struct PipelineConfig {
    std::string query_schema = "OEM";
    long query_limit = 500;
    std::vector<ProviderFit> providers;
};

// Compiled fallback: the two public Tier-1 adapters (A2.2c). Overridden whenever
// a config is supplied — this only keeps a bare cron tick useful out of the box.
PipelineConfig default_config() {
    PipelineConfig c;
    ProviderFit sx;
    sx.source_name = "spacex-starlink";
    sx.data_source = "SpaceX-E";
    sx.output_topic = "sdn/supgp/spacex-starlink";
    sx.file_id_prefix = "sdn-supgp-spacex-starlink";
    sx.max_iterations = 50;
    c.providers.push_back(sx);
    ProviderFit iss;
    iss.source_name = "iss";
    iss.data_source = "ISS-E";
    iss.output_topic = "sdn/supgp/iss";
    iss.file_id_prefix = "sdn-supgp-iss";
    iss.max_iterations = 50;
    c.providers.push_back(iss);
    return c;
}

void parse_provider(const std::string& obj, ProviderFit* p) {
    std::string s;
    if (odpipe::str_field(obj, "sourceName", &s)) p->source_name = s;
    if (odpipe::str_field(obj, "dataSource", &s)) p->data_source = s;
    if (odpipe::str_field(obj, "outputTopic", &s)) p->output_topic = s;
    if (odpipe::str_field(obj, "signingSlot", &s)) p->signing_slot = s;
    if (odpipe::str_field(obj, "signatureType", &s)) p->signature_type = s;
    if (odpipe::str_field(obj, "fileIdPrefix", &s)) p->file_id_prefix = s;
    std::string fit = odpipe::block_slice(obj, "fit", '{', '}');
    if (!fit.empty()) {
        double d = 0.0;
        if (odpipe::num_field(fit, "maxIterations", &d) && d > 0) p->max_iterations = static_cast<int>(d);
        if (odpipe::num_field(fit, "fitWindowSec", &d) && d > 0) p->fit_window_sec = d;
        if (odpipe::num_field(fit, "subsample", &d) && d >= 0) p->subsample = static_cast<int>(d);
        if (odpipe::num_field(fit, "convergenceTol", &d) && d > 0) p->convergence_tol = d;
    }
    if (obj.find("\"requireConverged\":false") != std::string::npos) p->require_converged = false;
    if (obj.find("\"requireConverged\":true") != std::string::npos) p->require_converged = true;
    if (p->output_topic.empty() && !p->source_name.empty()) p->output_topic = "sdn/supgp/" + p->source_name;
    if (p->file_id_prefix.empty() && !p->source_name.empty()) p->file_id_prefix = "sdn-supgp-" + p->source_name;
}

// Merge a JSON config object (from the request payload or plugin.getConfig) over
// the compiled fallback. A `providers` array, when present, REPLACES the set.
void apply_config_json(const std::string& json, PipelineConfig* cfg) {
    if (json.empty()) return;
    std::string s;
    if (odpipe::str_field(json, "querySchema", &s) && !s.empty()) cfg->query_schema = s;
    double d = 0.0;
    if (odpipe::num_field(json, "queryLimit", &d) && d > 0) cfg->query_limit = static_cast<long>(d);
    std::string providers = odpipe::block_slice(json, "providers", '[', ']');
    if (!providers.empty()) {
        std::vector<std::string> objs = odpipe::split_array_objects(providers);
        if (!objs.empty()) {
            cfg->providers.clear();
            for (const std::string& o : objs) {
                ProviderFit p;
                parse_provider(o, &p);
                if (!p.source_name.empty()) cfg->providers.push_back(p);
            }
        }
    }
}

// Config resolution: request payload > plugin.getConfig module config > fallback.
PipelineConfig resolve_config(const uint8_t* req, uint32_t len) {
    PipelineConfig cfg = default_config();

    // plugin.getConfig — the node's per-instance module config (result object).
    std::vector<uint8_t> env = ps::hostcall("plugin.getConfig", "{}");
    if (ps::cap_ok(env)) {
        std::string meta = ps::envelope_meta_json(env);
        std::string result = odpipe::block_slice(meta, "result", '{', '}');
        if (!result.empty()) apply_config_json(result, &cfg);
    }

    // Request payload (manual invoke) wins last. A cron tick passes nil/empty.
    if (req != nullptr && len > 0) {
        size_t i = 0;
        while (i < len && (req[i] == ' ' || req[i] == '\n' || req[i] == '\t' || req[i] == '\r')) i++;
        if (i < len && req[i] == '{') {
            std::string json(reinterpret_cast<const char*>(req), len);
            apply_config_json(json, &cfg);
        }
    }
    return cfg;
}

// ── consumption lane: storage.query(schema=...) -> record objects ────────────
// Requires the storage_query capability grant. Returns the raw Record JSON
// objects (each carries CID, Data(base64 record bytes), SourceTags{SourceName}).

struct StoredRecord {
    std::string cid;
    std::string source_name;
    std::string oem_json;        // decoded canonical OEM record bytes
    std::string record_sha256;   // SHA-256 of the consumed record bytes (fit lineage)
};

bool storage_query_oem(const std::string& schema, long limit,
                       std::vector<StoredRecord>* out, std::string* err) {
    std::string payload = "{\"schema\":\"" + ps::json_escape(schema) +
                          "\",\"limit\":" + std::to_string(limit) + "}";
    std::vector<uint8_t> env = ps::hostcall("storage.query", payload);
    if (!ps::cap_ok(env)) {
        std::string meta = ps::envelope_meta_json(env);
        std::string msg;
        ps::json_string_field(meta, "message", &msg);
        *err = msg.empty() ? "storage.query failed or storage_query capability not granted" : msg;
        return false;
    }
    std::string meta = ps::envelope_meta_json(env);
    std::string arr = odpipe::block_slice(meta, "result", '[', ']');
    for (const std::string& rec : odpipe::split_array_objects(arr)) {
        StoredRecord r;
        odpipe::str_field(rec, "CID", &r.cid);
        std::string data_b64;
        if (!odpipe::str_field(rec, "Data", &data_b64) || data_b64.empty()) continue;
        std::vector<uint8_t> bytes = ps::base64_decode(data_b64);
        if (bytes.empty()) continue;
        r.oem_json.assign(bytes.begin(), bytes.end());
        r.record_sha256 = ps::sha256_hex(bytes.data(), bytes.size());
        std::string tags = odpipe::block_slice(rec, "SourceTags", '{', '}');
        if (!tags.empty()) odpipe::str_field(tags, "SourceName", &r.source_name);
        out->push_back(std::move(r));
    }
    return true;
}

// ── OMM record construction (schema-exact GP keys + honest provenance) ───────

std::string build_omm_record(const od::FitResult& fit,
                             const ProviderFit& prov,
                             const StoredRecord& src) {
    // od::elements_to_json emits the schema-exact GP/OMM keys (NORAD_CAT_ID,
    // MEAN_MOTION, ECCENTRICITY, INCLINATION, RA_OF_ASC_NODE, ARG_OF_PERICENTER,
    // MEAN_ANOMALY, BSTAR, EPOCH, DATA_SOURCE, RMS, CONVERGED, ...). We augment it
    // with CCSDS-legit COMMENT provenance + USER_DEFINED_* machine-readable
    // lineage back to the source ephemeris (for A2.7 catalog synthesis). The base
    // serializer is reused verbatim (never mutated) so the existing gate is safe.
    std::string omm = od::elements_to_json(fit.elements);
    if (!omm.empty() && omm.back() == '}') omm.pop_back();
    char rmsbuf[48];
    snprintf(rmsbuf, sizeof(rmsbuf), "%.6f", fit.rms_km);
    omm += ",\"COMMENT\":[";
    omm += "\"SDN OD-fitted supplemental GP (SupGP/OMM) — App 2 A2.3 pipeline.\",";
    omm += "\"Fitted from stored SDS OEM record via od::fit_sgp4_series.\",";
    omm += "\"SOURCE_NAME=" + ps::json_escape(prov.source_name) +
           " DATA_SOURCE=" + ps::json_escape(prov.data_source) + "\",";
    omm += "\"SOURCE_CID=" + ps::json_escape(src.cid) + "\",";
    omm += "\"SOURCE_SHA256=" + ps::json_escape(src.record_sha256) + "\",";
    omm += std::string("\"FIT_RMS_KM=") + rmsbuf +
           " ITERATIONS=" + std::to_string(fit.iterations) +
           " CONVERGED=" + (fit.converged ? "true" : "false") + "\"";
    omm += "],";
    // Machine-readable lineage (USER_DEFINED_* is the SDS user-extension convention).
    omm += "\"USER_DEFINED_SDN_SOURCE_CID\":\"" + ps::json_escape(src.cid) + "\",";
    omm += "\"USER_DEFINED_SDN_SOURCE_SHA256\":\"" + ps::json_escape(src.record_sha256) + "\",";
    omm += "\"USER_DEFINED_SDN_SOURCE_NAME\":\"" + ps::json_escape(prov.source_name) + "\"";
    omm += "}";
    return omm;
}

std::string provenance_json(const od::FitResult& fit, const ProviderFit& prov, const StoredRecord& src) {
    char rmsbuf[48];
    snprintf(rmsbuf, sizeof(rmsbuf), "%.6f", fit.rms_km);
    return std::string("{\"SOURCE_NAME\":\"") + ps::json_escape(prov.source_name) + "\"," +
           "\"DATA_SOURCE\":\"" + ps::json_escape(prov.data_source) + "\"," +
           "\"RECORD_SCHEMA\":\"OMM\"," +
           "\"FIT_METHOD\":\"sgp4-differential-correction\"," +
           "\"SOURCE_RECORD_SCHEMA\":\"OEM\"," +
           "\"SOURCE_CID\":\"" + ps::json_escape(src.cid) + "\"," +
           "\"SOURCE_SHA256\":\"" + src.record_sha256 + "\"," +
           "\"NORAD_CAT_ID\":" + std::to_string(fit.elements.norad_cat_id) + "," +
           "\"FIT_RMS_KM\":" + rmsbuf + "," +
           "\"FIT_ITERATIONS\":" + std::to_string(fit.iterations) + "," +
           "\"CONVERGED\":" + (fit.converged ? "true" : "false") + "}";
}

// ── per-provider selection ───────────────────────────────────────────────────

// Choose the provider a stored record belongs to. Grouping key is
// SourceTags.SourceName (set once adapters write via storage.ingest_with_source).
// Fallback: if the record carries no source tag and exactly one provider is
// configured, attribute it to that provider (single-provider deployment); this
// is called out as an honest gap in the module README.
const ProviderFit* select_provider(const PipelineConfig& cfg, const std::string& source_name) {
    if (!source_name.empty()) {
        for (const ProviderFit& p : cfg.providers)
            if (p.source_name == source_name) return &p;
        return nullptr;  // tagged for a provider we are not configured to fit
    }
    if (cfg.providers.size() == 1) return &cfg.providers[0];
    return nullptr;
}

// ── the pipeline method ──────────────────────────────────────────────────────

struct ProviderStats {
    long candidates = 0, fitted = 0, published = 0, signed_ = 0, stored = 0;
    std::vector<std::string> skips;  // "<norad>:<reason>"
};

std::string run_pipeline(const uint8_t* req, uint32_t req_len) {
    PipelineConfig cfg = resolve_config(req, req_len);

    std::vector<StoredRecord> records;
    std::string query_err;
    bool query_ok = storage_query_oem(cfg.query_schema, cfg.query_limit, &records, &query_err);

    // Per-provider tallies, indexed to cfg.providers order.
    std::vector<ProviderStats> stats(cfg.providers.size());
    long unconfigured = 0, skipped_total = 0;

    for (const StoredRecord& rec : records) {
        const ProviderFit* prov = select_provider(cfg, rec.source_name);
        if (prov == nullptr) { unconfigured++; continue; }
        size_t pidx = static_cast<size_t>(prov - &cfg.providers[0]);
        ProviderStats& st = stats[pidx];
        st.candidates++;

        od::StateSeries series;
        std::string skip;
        if (!odpipe::oem_record_to_series(rec.oem_json, prov->data_source, &series, &skip)) {
            st.skips.push_back(skip);
            skipped_total++;
            continue;
        }

        od::FitterConfig fc;
        if (prov->max_iterations > 0) fc.max_iterations = prov->max_iterations;
        fc.fit_window_sec = prov->fit_window_sec;
        if (prov->subsample > 0) fc.subsample = prov->subsample;
        fc.convergence_tol = prov->convergence_tol;

        od::FitResult fit = od::fit_sgp4_series(series, fc);
        if (prov->require_converged && !fit.converged) {
            char b[64];
            snprintf(b, sizeof(b), "%d:fit-not-converged:rms=%.3f", series.meta.norad_cat_id, fit.rms_km);
            st.skips.push_back(b);
            skipped_total++;
            continue;
        }
        st.fitted++;

        std::string omm = build_omm_record(fit, *prov, rec);

        ps::ProviderConfig pcfg;
        pcfg.signing_slot = prov->signing_slot;
        pcfg.publish_topic = prov->output_topic;
        pcfg.signature_type = prov->signature_type;
        pcfg.source_name = prov->source_name;
        pcfg.data_source = prov->data_source;
        pcfg.record_schema = "OMM";

        std::string file_id = prov->file_id_prefix + ":OMM:" +
                              std::to_string(fit.elements.norad_cat_id) + ":" + fit.elements.epoch_iso;
        std::string file_name = std::to_string(fit.elements.norad_cat_id) + "_" +
                                fit.elements.epoch_iso + ".omm.json";
        std::string prov_json = provenance_json(fit, *prov, rec);

        ps::PublishResult r = ps::publish_record(
            pcfg, reinterpret_cast<const uint8_t*>(omm.data()), omm.size(),
            file_name, file_id, fit.elements.epoch_iso, prov_json);
        if (r.stored) st.stored++;
        if (r.signed_) st.signed_++;
        if (r.published) st.published++;
    }

    // ── summary JSON ──
    std::string out = "{\"ok\":true,\"pipeline\":\"od-fit\",";
    out += "\"query_ok\":" + std::string(query_ok ? "true" : "false") + ",";
    if (!query_ok) out += "\"query_error\":\"" + ps::json_escape(query_err) + "\",";
    out += "\"records_seen\":" + std::to_string(records.size()) + ",";
    out += "\"unconfigured\":" + std::to_string(unconfigured) + ",";
    out += "\"skipped_total\":" + std::to_string(skipped_total) + ",";
    out += "\"providers\":[";
    for (size_t i = 0; i < cfg.providers.size(); ++i) {
        if (i) out += ",";
        const ProviderFit& p = cfg.providers[i];
        const ProviderStats& st = stats[i];
        out += "{\"source_name\":\"" + ps::json_escape(p.source_name) + "\",";
        out += "\"data_source\":\"" + ps::json_escape(p.data_source) + "\",";
        out += "\"candidates\":" + std::to_string(st.candidates) + ",";
        out += "\"fitted\":" + std::to_string(st.fitted) + ",";
        out += "\"stored\":" + std::to_string(st.stored) + ",";
        out += "\"signed\":" + std::to_string(st.signed_) + ",";
        out += "\"published\":" + std::to_string(st.published) + ",";
        out += "\"skipped\":[";
        for (size_t k = 0; k < st.skips.size(); ++k) {
            if (k) out += ",";
            out += "\"" + ps::json_escape(st.skips[k]) + "\"";
        }
        out += "]}";
    }
    out += "]}";
    return out;
}

}  // namespace

extern "C" {

// Canonical streaming invoke entrypoint. The TIMERS method (cron: nil input) or a
// manual invoke (optional JSON config payload) triggers one read+fit+publish pass.
__attribute__((visibility("default")))
uint8_t* plugin_invoke_stream(const uint8_t* req_ptr, uint32_t req_len, uint32_t* out_len_ptr) {
    std::string result = run_pipeline(req_ptr, req_len);
    uint8_t* out = static_cast<uint8_t*>(malloc(result.size()));
    if (out != nullptr) {
        for (size_t i = 0; i < result.size(); i++) out[i] = static_cast<uint8_t>(result[i]);
    }
    if (out_len_ptr != nullptr) *out_len_ptr = static_cast<uint32_t>(result.size());
    return out;
}

}  // extern "C"
