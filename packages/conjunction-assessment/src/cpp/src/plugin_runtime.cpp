#include "conjunction/plugin_runtime.h"

#include "conjunction/conjunction_assessment.h"
#include "conjunction/conjunction_engine.h"
#include "conjunction/gp_json.h"
#include "conjunction/pc_method.h"

#include <nlohmann/json.hpp>

#include <stdexcept>
#include <string>
#include <memory>
#include <vector>

namespace conjunction {

using json = nlohmann::json;

namespace {

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

std::string dispatch_operation(const std::string& operation, const json& params) {
    if (operation == "version") {
        return json({{"version", version()}}).dump();
    }
    if (operation == "assess") {
        return assess_conjunction_json(params);
    }
    if (operation == "screen") {
        return screen_conjunctions_json(params);
    }

    throw std::runtime_error("Unknown conjunction operation: " + operation);
}

}  // namespace

PluginInvokeResult invoke_json_request(std::string_view request_json) {
    try {
        const auto request = json::parse(request_json);

        // Support both "operation" and "type" as the dispatch key.
        std::string operation;
        if (request.contains("operation")) {
            operation = request.at("operation").get<std::string>();
        } else if (request.contains("type")) {
            operation = request.at("type").get<std::string>();
        } else {
            return make_error_result("missing-operation",
                "Request must contain an \"operation\" or \"type\" field.");
        }

        const auto params =
            request.contains("params") ? request.at("params") : json::object();

        PluginInvokeResult result{};
        result.ok = true;
        result.json = dispatch_operation(operation, params);
        return result;
    } catch (const std::exception& ex) {
        return make_error_result("invoke-failed", ex.what());
    } catch (...) {
        return make_error_result("invoke-failed", "Unknown plugin error.");
    }
}

}  // namespace conjunction
