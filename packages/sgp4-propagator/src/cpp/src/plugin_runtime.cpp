#include "sgp4_prop/plugin_runtime.h"

#include "sgp4_prop/lambert_stm.h"
#include "sgp4_prop/propagator.h"

#include <nlohmann/json.hpp>

#include <stdexcept>
#include <string>

namespace sgp4_prop {

using json = nlohmann::json;

namespace {

std::string version() { return "0.1.0"; }

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

json state_vector_to_json(const StateVector& state) {
    return {
        {"epochJd", state.epoch_jd},
        {"x", state.x},
        {"y", state.y},
        {"z", state.z},
        {"vx", state.vx},
        {"vy", state.vy},
        {"vz", state.vz},
    };
}

std::string epoch_to_jd_json(const json& params) {
    const auto epoch = params.at("epoch").get<std::string>();
    return json({{"julianDate", epoch_to_jd(epoch)}}).dump();
}

std::string propagate_to_epoch_json(const json& params) {
    const auto gp_json = params.at("gp").dump();
    const auto gps = parse_gp_json("[" + gp_json + "]");
    if (gps.empty()) {
        throw std::runtime_error("No GP element parsed.");
    }

    const double target_jd = params.at("targetJd").get<double>();
    return state_vector_to_json(propagate_to_epoch(gps.front(), target_jd)).dump();
}

std::string propagate_gp_json(const json& params) {
    const auto gp_json = params.at("gpJson").get<std::string>();
    const auto gps = parse_gp_json(gp_json);
    if (gps.empty()) {
        throw std::runtime_error("No GP element parsed.");
    }

    PropagationConfig config{};
    config.duration_days = params.value("durationDays", 1.0);
    config.step_seconds = params.value("stepSeconds", 600.0);
    config.start_jd = params.value("startJd", 0.0);
    config.end_jd = params.value("endJd", 0.0);

    const auto states = propagate(gps.front(), config);

    json output{};
    output["objectName"] = gps.front().object_name;
    output["noradId"] = gps.front().norad_cat_id;
    output["numStates"] = states.size();
    output["states"] = json::array();
    for (const auto& state : states) {
        output["states"].push_back(state_vector_to_json(state));
    }
    return output.dump();
}

std::string solve_lambert_json(const json& params) {
    const auto r1_json = params.at("r1");
    const auto r2_json = params.at("r2");
    double r1[3] = {
        r1_json.at(0).get<double>(),
        r1_json.at(1).get<double>(),
        r1_json.at(2).get<double>(),
    };
    double r2[3] = {
        r2_json.at(0).get<double>(),
        r2_json.at(1).get<double>(),
        r2_json.at(2).get<double>(),
    };

    const auto solution = solve_lambert(
        r1,
        r2,
        params.at("tofSeconds").get<double>());

    return json({
        {"converged", solution.converged},
        {"iterations", solution.iterations},
        {"v1", json::array({solution.v1[0], solution.v1[1], solution.v1[2]})},
        {"v2", json::array({solution.v2[0], solution.v2[1], solution.v2[2]})},
    }).dump();
}

std::string dispatch_operation(const std::string& operation, const json& params) {
    if (operation == "version") {
        return json({{"version", version()}}).dump();
    }
    if (operation == "epochToJd") {
        return epoch_to_jd_json(params);
    }
    if (operation == "propagateToEpoch") {
        return propagate_to_epoch_json(params);
    }
    if (operation == "propagateGP") {
        return propagate_gp_json(params);
    }
    if (operation == "solveLambert") {
        return solve_lambert_json(params);
    }

    throw std::runtime_error("Unknown sgp4 operation: " + operation);
}

}  // namespace

PluginInvokeResult invoke_json_request(std::string_view request_json) {
    try {
        const auto request = json::parse(request_json);
        const auto operation = request.at("operation").get<std::string>();
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

}  // namespace sgp4_prop
