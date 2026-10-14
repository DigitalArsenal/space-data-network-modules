/*
 * SDN record retention module (typed contracts 1.0).
 *
 * One method, `expire`: keeps a rolling window of records on the node and
 * deletes what has fallen out of it. Each configured target names a standard
 * and its lane (provider and/or sources); the node's storage.expire host op
 * deletes the lane's records that arrived on the node before now - window_hours
 * (the store's own arrival time, for every standard alike), paging the store's
 * record index - every stored record, not only the engine's resident hot
 * window that module SQL sees.
 *
 * Owner 2026-10-12, the weather node: "we only need to keep a rolling window
 * of 3 days, we should NOT be archiving more than that (configurable in the
 * module but the default is 3 days)".
 *
 *   in   "tick"    optional TimerTick (TICK, module-sdk runtime type); its payload is not read.
 *   out  "report"  FlowNotice (FNTC) frames, one per lane pass:
 *                  KIND Expired - SCHEMA / PROVIDER_ID / SOURCE_NAME the lane, COUNT the records deleted, AT_MS the
 *                  cutoff, REASON the window (and "max_deletes reached" when the pass was capped);
 *                  KIND Missing - COUNT the records the index listed that were no longer stored (only when any);
 *                  KIND Skipped - a lane not visited because the pass's max_deletes was spent.
 *
 * Node CONFIG (plugin.getConfig, one ModuleConfig on raw "config"; nested values read by dotted path), every key
 * optional:
 *   window_hours (72), batch (500), max_deletes (100000),
 *   targets.<i>.schema ("WXF.fbs"), targets.<i>.provider_id, targets.<i>.sources.<j>
 * The compiled default target: WXF from provider noaa-ncep, 72 hours. A target
 * names a provider, sources, or both (the host refuses a whole standard).
 *
 * Hostcalls are SDS $PIV invocations (typedHostcall.hpp): plugin.getConfig, clock.now, storage.expire
 * (StorageExpireParams -> StorageExpireResult). No JSON anywhere.
 */

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <optional>
#include <string_view>
#include <utility>
#include <string>
#include <string_view>
#include <vector>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "FlowNotice_generated.h"

namespace {

namespace A = sdn::runtime::Aligned;
namespace R = sdn::runtime;

// ---------------------------------------------------------------------------
// Node CONFIG: plugin.getConfig answers with one ModuleConfig FlatBuffer (MCFG) on raw "config", read in place through
// sdm_piv::get_config(); nested tables and lists are read by dotted path ("targets.0.provider_id", "targets.0.sources.1"). A host that provides
// no config (or fails the call) leaves every key at its compiled default.
// ---------------------------------------------------------------------------

struct ConfigValue {
    R::configValueKind kind = R::configValueKind_String;
    std::string text;
    double number = 0;
    bool flag = false;
};

class NodeConfig {
 public:
    static NodeConfig load() { return NodeConfig(sdm_piv::get_config()); }
    // The list index a dotted path ends in ("key.3" -> 3).
    static size_t index_of(const std::string& key) { return static_cast<size_t>(std::strtoull(key.c_str() + key.rfind('.') + 1, nullptr, 10)); }
    // One value read in place from the ModuleConfig: a String, Number or Bool at a key or dotted path, or one item of a
    // StringList / NumberList ("key.0"). A list or table itself reads as absent (callers walk "key.0", "key.1", ...).
    std::optional<ConfigValue> find(const std::string& key) const {
        const R::ConfigEntry* e = config_.entry(key);
        if (!e) return std::nullopt;
        const std::string_view name = e->KEY() ? std::string_view(e->KEY()->c_str(), e->KEY()->size()) : std::string_view();
        const bool item = !(key == name || (key.size() > name.size() && key[key.size() - name.size() - 1] == '.' &&
                                            std::string_view(key).substr(key.size() - name.size()) == name));
        ConfigValue v;
        switch (e->KIND()) {
            case R::configValueKind_String: if (item) return std::nullopt; v.text = std::string(config_.string(key)); return v;
            case R::configValueKind_Number: if (item) return std::nullopt; v.kind = R::configValueKind_Number; v.number = e->NUMBER_VALUE(); return v;
            case R::configValueKind_Bool: if (item) return std::nullopt; v.kind = R::configValueKind_Bool; v.flag = e->BOOL_VALUE(); return v;
            case R::configValueKind_StringList:
                if (!item || !e->STRINGS() || index_of(key) >= e->STRINGS()->size()) return std::nullopt;
                v.text = std::string(config_.string(key));
                return v;
            case R::configValueKind_NumberList:
                if (!item || !e->NUMBERS() || index_of(key) >= e->NUMBERS()->size()) return std::nullopt;
                v.kind = R::configValueKind_Number;
                v.number = config_.number(key);
                return v;
            default: return std::nullopt;
        }
    }
    bool has(const std::string& key) const { return find(key).has_value(); }
    // A number, or a String holding one (operators quote numbers).
    bool number(const std::string& key, double* out) const {
        const auto v = find(key);
        if (!v) return false;
        if (v->kind == R::configValueKind_Number) { *out = v->number; return true; }
        if (v->kind == R::configValueKind_String && !v->text.empty()) {
            char* end = nullptr;
            const double d = std::strtod(v->text.c_str(), &end);
            if (end == v->text.c_str()) return false;
            *out = d;
            return true;
        }
        return false;
    }
    bool text(const std::string& key, std::string* out) const {
        const auto v = find(key);
        if (!v || v->kind != R::configValueKind_String) return false;
        *out = v->text;
        return true;
    }
    // The values of a list ("key.0", "key.1", ... in index order).
    std::vector<std::string> strings(const std::string& key) const {
        std::vector<std::string> out;
        for (size_t i = 0;; i++) {
            const auto v = find(key + "." + std::to_string(i));
            if (!v) break;
            out.push_back(v->text);
        }
        return out;
    }

 private:
    explicit NodeConfig(sdm_piv::Config config) : config_(std::move(config)) {}
    sdm_piv::Config config_;
};

constexpr double kDefaultWindowHours = 72.0;
constexpr long kDefaultBatch = 500;
constexpr long kDefaultMaxDeletes = 100000;

// ---------------------------------------------------------------------------
// Expiry.
// ---------------------------------------------------------------------------

struct Target {
    std::string schema = "WXF.fbs";
    std::string provider = "noaa-ncep";
    std::vector<std::string> sources;  // empty: every source of the provider
};

int push_notice(R::flowNoticeKind kind, const Target& t, const std::string& source, uint64_t count,
                const std::string& reason, uint64_t at_ms) {
    flatbuffers::FlatBufferBuilder b(256);
    R::FinishFlowNoticeBuffer(
        b, R::CreateFlowNoticeDirect(b, kind, t.schema.c_str(), t.provider.empty() ? nullptr : t.provider.c_str(),
                                     source.empty() ? nullptr : source.c_str(), nullptr, count, reason.c_str(), nullptr,
                                     at_ms));
    return plugin_push_output_ex("report", "FlowNotice.fbs", R::FlowNoticeIdentifier(),
                                 PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "FlowNotice", 0, 0, b.GetBufferPointer(),
                                 static_cast<uint32_t>(b.GetSize()));
}

// One aligned string of the StorageExpireParams; a value over its bound is refused, never truncated.
template <size_t N>
bool fit(flatbuffers::aligned_runtime::AlignedString<N>& field, const std::string& value, const char* name) {
    if (sdm_piv::put(field, value)) return true;
    const std::string message = std::string(name) + " \"" + value + "\" is " + std::to_string(value.size()) +
                                " bytes; storage.expire takes at most " + std::to_string(N) + ".";
    plugin_set_error("retention-bad-target", message.c_str());
    return false;
}

}  // namespace

extern "C" {

// expire: delete every configured target's records older than the window.
// Status 0 with nothing to do as well; 400 for a target naming no lane (or a
// name over the hostcall's bound); 502 when the host refuses or fails.
int expire(void) {
    double window_hours = kDefaultWindowHours, d = 0.0;
    long batch = kDefaultBatch, max_deletes = kDefaultMaxDeletes;
    std::vector<Target> targets;

    const NodeConfig config = NodeConfig::load();
    if (config.number("window_hours", &d) && d > 0) window_hours = d;
    if (config.number("batch", &d) && d >= 1) batch = static_cast<long>(d);
    if (config.number("max_deletes", &d) && d >= 1) max_deletes = static_cast<long>(d);
    for (size_t i = 0;; i++) {
        const std::string prefix = "targets." + std::to_string(i);
        bool any = false;
        Target t;
        std::string s;
        if (config.text(prefix + ".schema", &s)) { t.schema = s; any = true; }
        t.provider.clear();
        if (config.text(prefix + ".provider_id", &s)) { t.provider = s; any = true; }
        if (config.has(prefix + ".provider_id")) any = true;
        t.sources = config.strings(prefix + ".sources");
        if (!t.sources.empty()) any = true;
        if (!any) break;
        targets.push_back(t);
    }
    if (targets.empty()) targets.push_back(Target());

    const auto now = sdm_piv::call("clock.now");
    const auto* now_value = now.ok() ? now.result<A::TimeValue>("TimeValue") : nullptr;
    if (!now_value || now_value->UNIX_MS == 0) {
        plugin_set_error("retention-clock-failed", "clock.now hostcall failed.");
        return 502;
    }
    const double cutoff = static_cast<double>(now_value->UNIX_MS) - window_hours * 3600e3;
    const uint64_t cutoff_ms = cutoff > 0 ? static_cast<uint64_t>(std::llround(cutoff)) : 0;
    char window[64];
    std::snprintf(window, sizeof(window), "rolling window %.6g h", window_hours);

    for (const Target& t : targets) {
        if (t.provider.empty() && t.sources.empty()) {
            plugin_set_error("retention-bad-target", "a target names provider_id, sources, or both.");
            return 400;
        }
    }

    long deleted = 0;
    for (const Target& t : targets) {
        const std::vector<std::string> lanes = t.sources.empty() ? std::vector<std::string>{std::string()} : t.sources;
        for (const std::string& source : lanes) {
            if (deleted >= max_deletes) {
                if (push_notice(R::flowNoticeKind_Skipped, t, source, 0, "max_deletes reached; the lane waits for the next pass", cutoff_ms) < 0) return 500;
                continue;
            }
            A::StorageExpireParams params{};
            if (!fit(params.SCHEMA, t.schema, "schema")) return 400;
            params.set_has_SCHEMA(true);
            if (!t.provider.empty()) {
                if (!fit(params.PROVIDER_ID, t.provider, "provider_id")) return 400;
                params.set_has_PROVIDER_ID(true);
            }
            if (!source.empty()) {
                if (!fit(params.SOURCE_NAME, source, "source_name")) return 400;
                params.set_has_SOURCE_NAME(true);
            }
            params.BEFORE_MS = cutoff_ms;
            params.BATCH = static_cast<uint32_t>(batch);
            params.MAX_DELETES = static_cast<uint32_t>(max_deletes - deleted);
            const auto response = sdm_piv::call("storage.expire", "StorageExpireParams", params);
            if (!response.ok()) {
                const std::string message = response.error_message();
                plugin_set_error("retention-expire-failed", message.empty() ? "storage.expire failed" : message.c_str());
                return 502;
            }
            const auto* result = response.result<A::StorageExpireResult>("StorageExpireResult");
            const uint64_t lane_deleted = result ? result->DELETED : 0;
            const uint64_t lane_missing = result ? result->MISSING : 0;
            deleted += static_cast<long>(lane_deleted);
            const std::string reason = std::string(window) + (result && result->CAPPED ? "; max_deletes reached" : "");
            if (push_notice(R::flowNoticeKind_Expired, t, source, lane_deleted, reason, cutoff_ms) < 0) return 500;
            if (lane_missing > 0 &&
                push_notice(R::flowNoticeKind_Missing, t, source, lane_missing, "listed by the record index, no longer stored", cutoff_ms) < 0) {
                return 500;
            }
        }
    }
    return 0;
}

}  // extern "C"
