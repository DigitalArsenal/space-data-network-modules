#include "conjunction/plugin_runtime.h"

#include "conjunction/conjunction_assessment.h"
#include "conjunction/conjunction_engine.h"
#include "conjunction/ephemeris_source.h"
#include "conjunction/gp_json.h"
#include "conjunction/pc_method.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace conjunction {

using json = nlohmann::json;

namespace {

struct ParsedTrackSource {
    std::shared_ptr<EphemerisSource> source;
    std::string error_message;
};

std::string version() { return "0.2.0"; }

PluginInvokeResult make_error_result(
    std::string error_code,
    std::string error_message) {
    PluginInvokeResult result{};
    result.ok = false;
    result.error_code = std::move(error_code);
    result.error_message = std::move(error_message);
    result.json = json({
        {"error", result.error_message},
        {"errorCode", result.error_code},
    }).dump();
    return result;
}

PluginInvokeResult make_success_result(std::string response_json) {
    PluginInvokeResult result{};
    result.ok = true;
    result.json = std::move(response_json);
    return result;
}

const json* find_member(const json& object, const char* key) {
    if (!object.is_object()) {
        return nullptr;
    }
    const auto it = object.find(key);
    return it == object.end() ? nullptr : &(*it);
}

double finite_or_default(double value, double fallback) {
    return std::isfinite(value) ? value : fallback;
}

bool read_number_value(const json& value, double& output) {
    if (!value.is_number()) {
        return false;
    }
    output = value.get<double>();
    return std::isfinite(output);
}

bool read_number_member(
    const json& object,
    std::initializer_list<const char*> keys,
    double& output) {
    for (const char* key : keys) {
        const json* member = find_member(object, key);
        if (member != nullptr && read_number_value(*member, output)) {
            return true;
        }
    }
    return false;
}

double number_member_or(
    const json& object,
    std::initializer_list<const char*> keys,
    double fallback) {
    double value = fallback;
    return read_number_member(object, keys, value) ? value : fallback;
}

std::string string_member_or(
    const json& object,
    std::initializer_list<const char*> keys,
    std::string fallback = "") {
    for (const char* key : keys) {
        const json* member = find_member(object, key);
        if (member != nullptr && member->is_string()) {
            return member->get<std::string>();
        }
    }
    return fallback;
}

int int_member_or(
    const json& object,
    std::initializer_list<const char*> keys,
    int fallback) {
    double value = 0.0;
    if (!read_number_member(object, keys, value)) {
        return fallback;
    }
    return static_cast<int>(std::llround(value));
}

json state_vector_to_json(const StateVector& sv) {
    return {
        {"x", sv.x}, {"y", sv.y}, {"z", sv.z},
        {"vx", sv.vx}, {"vy", sv.vy}, {"vz", sv.vz},
    };
}

json conjunction_event_to_json(const ConjunctionEvent& event) {
    return {
        {"tca_jd", event.tca_jd},
        {"tca_iso", event.tca_iso},
        {"min_range_km", event.min_range_km},
        {"rel_speed_kms", event.rel_speed_kms},
        {"max_probability", event.max_probability},
        {"probability_method", event.probability_method},
        {"dilution_threshold_km", event.dilution_threshold_km},
        {"state1", state_vector_to_json(event.state1)},
        {"state2", state_vector_to_json(event.state2)},
        {"rel_pos_rtn", {event.rel_pos_r, event.rel_pos_t, event.rel_pos_n}},
        {"rel_vel_rtn", {event.rel_vel_r, event.rel_vel_t, event.rel_vel_n}},
        {"dse1", event.dse1},
        {"dse2", event.dse2},
        {"obj1_name", event.obj1.name},
        {"obj2_name", event.obj2.name},
        {"obj1_norad", event.obj1.norad_cat_id},
        {"obj2_norad", event.obj2.norad_cat_id},
    };
}

json conjunction_event2_to_json(const ConjunctionEvent2& event) {
    return {
        {"tca_jd", event.tca_jd},
        {"tca_iso", event.tca_iso},
        {"min_range_km", event.miss_distance_km},
        {"rel_speed_kms", event.relative_speed_kms},
        {"probability", event.pc.probability},
        {"max_probability", event.pc.max_probability},
        {"probability_method", event.pc.method},
        {"state1", state_vector_to_json(event.state1)},
        {"state2", state_vector_to_json(event.state2)},
        {"rel_pos_rtn", {event.rel_r, event.rel_t, event.rel_n}},
        {"rel_vel_rtn", {event.rel_vr, event.rel_vt, event.rel_vn}},
        {"dse1", event.dse1},
        {"dse2", event.dse2},
        {"obj1_name", event.obj1_name},
        {"obj2_name", event.obj2_name},
        {"obj1_id", event.obj1_id},
        {"obj2_id", event.obj2_id},
        {"obj1_norad", event.obj1_norad},
        {"obj2_norad", event.obj2_norad},
        {"mahalanobis_2d", event.mahalanobis_2d},
        {"mahalanobis_3d", event.mahalanobis_3d},
        {"combined_radius_km", event.combined_radius_km},
    };
}

TLE parse_tle_from_json(const json& obj) {
    TLE tle{};
    if (obj.contains("line1") && obj.contains("line2")) {
        tle = parse_tle(obj.value("name", std::string()),
                        obj.at("line1").get<std::string>(),
                        obj.at("line2").get<std::string>());
    }
    if (obj.contains("name")) {
        tle.name = obj.at("name").get<std::string>();
    }
    return tle;
}

std::string assess_conjunction_json(const json& params) {
    const auto tle1 = parse_tle_from_json(params.at("object1"));
    const auto tle2 = parse_tle_from_json(params.at("object2"));

    const double start_jd = params.value("start_jd", tle1.epoch_jd);
    const double duration_days = params.value("duration_days", 7.0);
    const double radius1_m = params.value("radius1_m", DEFAULT_RADIUS_M);
    const double radius2_m = params.value("radius2_m", DEFAULT_RADIUS_M);

    const auto event = assess_conjunction(tle1, tle2, start_jd, duration_days,
                                          radius1_m, radius2_m);

    return conjunction_event_to_json(event).dump();
}

bool parse_ephemeris_point(const json& sample_json, EphemerisPoint& point) {
    if (!sample_json.is_object()) {
        return false;
    }

    double epoch_jd = 0.0;
    double x_km = 0.0;
    double y_km = 0.0;
    double z_km = 0.0;
    double vx_km_s = 0.0;
    double vy_km_s = 0.0;
    double vz_km_s = 0.0;

    if (!read_number_member(sample_json, {"epochJD", "epoch_jd", "jd"}, epoch_jd) ||
        !read_number_member(sample_json, {"x_km", "x"}, x_km) ||
        !read_number_member(sample_json, {"y_km", "y"}, y_km) ||
        !read_number_member(sample_json, {"z_km", "z"}, z_km) ||
        !read_number_member(sample_json, {"vx_km_s", "vx"}, vx_km_s) ||
        !read_number_member(sample_json, {"vy_km_s", "vy"}, vy_km_s) ||
        !read_number_member(sample_json, {"vz_km_s", "vz"}, vz_km_s)) {
        return false;
    }

    point = {epoch_jd, x_km, y_km, z_km, vx_km_s, vy_km_s, vz_km_s};
    return true;
}

ParsedTrackSource parse_track_source(const json& track_json, const char* label) {
    ParsedTrackSource parsed{};
    if (!track_json.is_object()) {
        parsed.error_message = std::string(label) + " must be a JSON object.";
        return parsed;
    }

    const json* samples_json = find_member(track_json, "samples");
    if (samples_json == nullptr || !samples_json->is_array()) {
        parsed.error_message =
            std::string(label) + " must contain a samples array.";
        return parsed;
    }
    if (samples_json->size() < 2) {
        parsed.error_message =
            std::string(label) + " must contain at least two samples.";
        return parsed;
    }

    std::vector<EphemerisPoint> points;
    points.reserve(samples_json->size());
    double previous_jd = -std::numeric_limits<double>::infinity();

    for (size_t index = 0; index < samples_json->size(); ++index) {
        EphemerisPoint point{};
        if (!parse_ephemeris_point((*samples_json)[index], point)) {
            parsed.error_message =
                std::string(label) + ".samples[" + std::to_string(index) +
                "] is missing a finite epoch/state vector.";
            return parsed;
        }
        if (!(point.jd > previous_jd)) {
            parsed.error_message =
                std::string(label) + ".samples must be strictly increasing by epochJD.";
            return parsed;
        }
        previous_jd = point.jd;
        points.push_back(point);
    }

    std::string object_name =
        string_member_or(track_json, {"object_name", "objectName"});
    std::string object_id =
        string_member_or(track_json, {"object_id", "objectId"});
    const int norad_cat_id =
        int_member_or(track_json, {"norad_cat_id", "norad_id", "noradId"}, 0);
    if (object_id.empty() && norad_cat_id > 0) {
        object_id = std::to_string(norad_cat_id);
    }

    parsed.source = std::make_shared<OEMEphemerisSource>(
        std::move(points),
        std::move(object_name),
        std::move(object_id),
        norad_cat_id);
    return parsed;
}

PluginInvokeResult assess_tracks_json(const json& params) {
    const json* primary_track = find_member(params, "primary_track");
    const json* secondary_track = find_member(params, "secondary_track");
    if (primary_track == nullptr) {
        return make_error_result(
            "missing-primary-track",
            "Track assessment requires params.primary_track.");
    }
    if (secondary_track == nullptr) {
        return make_error_result(
            "missing-secondary-track",
            "Track assessment requires params.secondary_track.");
    }

    const ParsedTrackSource primary = parse_track_source(*primary_track, "primary_track");
    if (!primary.source) {
        return make_error_result("invalid-track", primary.error_message);
    }
    const ParsedTrackSource secondary = parse_track_source(*secondary_track, "secondary_track");
    if (!secondary.source) {
        return make_error_result("invalid-track", secondary.error_message);
    }

    const double overlap_start_jd =
        std::max(primary.source->valid_start_jd(), secondary.source->valid_start_jd());
    const double overlap_end_jd =
        std::min(primary.source->valid_end_jd(), secondary.source->valid_end_jd());
    if (!(overlap_end_jd > overlap_start_jd)) {
        return make_error_result(
            "invalid-track-window",
            "primary_track and secondary_track do not overlap in time.");
    }

    double search_start_jd = overlap_start_jd;
    double search_end_jd = overlap_end_jd;

    double tca_hint_jd = 0.0;
    if (read_number_member(params, {"tca_hint_jd"}, tca_hint_jd)) {
        const double window_hours =
            std::max(1.0 / 3600.0, number_member_or(params, {"window_hours"}, 2.0));
        const double half_window_days = window_hours / 24.0;
        search_start_jd = std::max(overlap_start_jd, tca_hint_jd - half_window_days);
        search_end_jd = std::min(overlap_end_jd, tca_hint_jd + half_window_days);
    }

    if (!(search_end_jd > search_start_jd)) {
        return make_error_result(
            "invalid-track-window",
            "The requested track search window does not intersect the sampled tracks.");
    }

    ConjunctionEngine engine;
    engine.set_pc_method("alfano");
    engine.set_combined_radius_m(
        finite_or_default(number_member_or(params, {"radius1_m"}, DEFAULT_RADIUS_M),
                          DEFAULT_RADIUS_M),
        finite_or_default(number_member_or(params, {"radius2_m"}, DEFAULT_RADIUS_M),
                          DEFAULT_RADIUS_M));

    const auto event = engine.assess(
        *primary.source,
        *secondary.source,
        search_start_jd,
        search_end_jd - search_start_jd);
    return make_success_result(conjunction_event2_to_json(event).dump());
}

std::string screen_conjunctions_json(const json& params) {
    std::vector<TLE> primaries;
    std::vector<TLE> secondaries;

    for (const auto& obj : params.at("primaries")) {
        primaries.push_back(parse_tle_from_json(obj));
    }
    for (const auto& obj : params.at("secondaries")) {
        secondaries.push_back(parse_tle_from_json(obj));
    }

    const double start_jd = params.value("start_jd", primaries.empty() ? 0.0 : primaries[0].epoch_jd);
    const double duration_days = params.value("duration_days", 7.0);
    const double threshold_km = params.value("threshold_km", DEFAULT_THRESHOLD_KM);

    const auto events = screen_conjunctions(primaries, secondaries,
                                            start_jd, duration_days, threshold_km);

    json results = json::array();
    for (const auto& event : events) {
        results.push_back(conjunction_event_to_json(event));
    }
    return json({
        {"count", results.size()},
        {"conjunctions", results},
    }).dump();
}

PluginInvokeResult dispatch_operation(const std::string& operation, const json& params) {
    if (operation == "version") {
        return make_success_result(json({{"version", version()}}).dump());
    }
    if (operation == "assess") {
        return make_success_result(assess_conjunction_json(params));
    }
    if (operation == "screen") {
        return make_success_result(screen_conjunctions_json(params));
    }
    if (operation == "assessTracks" || operation == "assess_tracks") {
        return assess_tracks_json(params);
    }
    return make_error_result(
        "unknown-operation",
        "Unknown conjunction operation: " + operation);
}

}  // namespace

PluginInvokeResult invoke_json_request(std::string_view request_json) {
    try {
        const auto request = json::parse(
            request_json.begin(),
            request_json.end(),
            nullptr,
            false);
        if (request.is_discarded()) {
            return make_error_result(
                "invalid-json",
                "Request payload is not valid JSON.");
        }
        if (!request.is_object()) {
            return make_error_result(
                "invalid-request",
                "Request payload must be a JSON object.");
        }

        // Support both "operation" and "type" as the dispatch key.
        const std::string operation =
            string_member_or(request, {"operation", "type"});
        if (operation.empty()) {
            return make_error_result("missing-operation",
                "Request must contain an \"operation\" or \"type\" field.");
        }

        const json empty_params = json::object();
        const json* params = find_member(request, "params");
        const json& effective_params = params == nullptr ? empty_params : *params;
        if (!effective_params.is_object()) {
            return make_error_result(
                "invalid-params",
                "\"params\" must be a JSON object.");
        }

        return dispatch_operation(operation, effective_params);
    } catch (const std::exception& ex) {
        return make_error_result("invoke-failed", ex.what());
    } catch (...) {
        return make_error_result("invoke-failed", "Unknown plugin error.");
    }
}

}  // namespace conjunction
