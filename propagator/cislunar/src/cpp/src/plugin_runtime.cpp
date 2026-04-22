#include "cislunar/plugin_runtime.h"

#include "cislunar/constants.h"
#include "cislunar/cr3bp.h"
#include "cislunar/types.h"

#include <nlohmann/json.hpp>

#include <stdexcept>
#include <string>

namespace cislunar {

using json = nlohmann::json;

namespace {

std::string version() { return "1.0.0"; }

json vec6_to_json(const Vector6& v) {
    return json::array({v[0], v[1], v[2], v[3], v[4], v[5]});
}

Vector6 json_to_vec6(const json& j) {
    Vector6 v{};
    for (int i = 0; i < 6; ++i) {
        v[i] = j.at(i).get<double>();
    }
    return v;
}

json state_to_json(const CR3BPState& state) {
    return {
        {"x", state.x},
        {"y", state.y},
        {"z", state.z},
        {"vx", state.vx},
        {"vy", state.vy},
        {"vz", state.vz},
    };
}

CR3BPState json_to_state(const json& j) {
    CR3BPState state{};
    state.x = j.value("x", 0.0);
    state.y = j.value("y", 0.0);
    state.z = j.value("z", 0.0);
    state.vx = j.value("vx", 0.0);
    state.vy = j.value("vy", 0.0);
    state.vz = j.value("vz", 0.0);
    return state;
}

CR3BPSystem json_to_system(const json& j) {
    CR3BPSystem system{};
    system.mu = j.value("mu", 0.0);
    system.l_star = j.value("l_star", 0.0);
    system.t_star = j.value("t_star", 0.0);
    system.m1 = j.value("m1", 0.0);
    system.m2 = j.value("m2", 0.0);
    system.name = j.value("name", std::string{});
    return system;
}

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

std::string propagate_cr3bp_json(const std::string& input) {
    const auto j = json::parse(input);
    const auto state = json_to_state(j.at("state"));
    const double mu = j.at("mu").get<double>();

    CR3BPPropOptions options{};
    if (j.contains("options")) {
        const auto& options_json = j.at("options");
        options.duration = options_json.value("duration", 0.0);
        options.stepSize = options_json.value("stepSize", 0.001);
        options.outputPoints = options_json.value("outputPoints", 1000);
        options.computeSTM = options_json.value("computeSTM", false);
    }

    const auto result = propagateCR3BP(state, mu, options);

    json output{};
    output["jacobi"] = result.jacobi;
    output["times"] = result.times;
    output["states"] = json::array();
    for (const auto& propagated_state : result.states) {
        output["states"].push_back(vec6_to_json(propagated_state));
    }
    return output.dump();
}

std::string compute_lagrange_points_json(const std::string& input) {
    const auto j = json::parse(input);
    const double mu = j.at("mu").get<double>();
    const auto points = computeLagrangePoints(mu);

    json output = json::array();
    const char* names[] = {"L1", "L2", "L3", "L4", "L5"};
    for (int index = 0; index < 5; ++index) {
        output.push_back({
            {"point", names[index]},
            {"position", {
                points[index].position[0],
                points[index].position[1],
                points[index].position[2],
            }},
            {"jacobi", points[index].jacobi},
        });
    }
    return output.dump();
}

std::string jacobi_constant_json(const std::string& input) {
    const auto j = json::parse(input);
    const auto state = json_to_vec6(j.at("state"));
    const double mu = j.at("mu").get<double>();
    return json({{"jacobi", jacobiConstant(state, mu)}}).dump();
}

std::string compute_periodic_orbit_json(const std::string& input) {
    const auto j = json::parse(input);

    PeriodicOrbitConfig config{};
    const auto& config_json = j.at("config");
    config.family = static_cast<OrbitFamily>(config_json.value("family", 0));
    config.point = static_cast<LagrangePoint>(config_json.value("point", 1));
    config.amplitude = config_json.value("amplitude", 0.0);
    config.maxIterations = config_json.value("maxIterations", 100);
    config.tolerance = config_json.value("tolerance", 1e-12);

    const auto system = json_to_system(j.at("system"));
    const auto result = computePeriodicOrbit(config, system);

    json output{};
    output["converged"] = result.converged;
    output["iterations"] = result.iterations;
    output["period"] = result.period;
    output["jacobi"] = result.jacobi;
    output["initialState"] = state_to_json(result.initialState);
    output["trajectory"] = json::array();
    for (const auto& state : result.trajectory) {
        output["trajectory"].push_back(vec6_to_json(state));
    }
    return output.dump();
}

std::string richardson_halo_guess_json(const std::string& input) {
    const auto j = json::parse(input);
    const double mu = j.at("mu").get<double>();
    const auto point = static_cast<LagrangePoint>(j.value("point", 1));
    const double az = j.at("Az").get<double>();
    const bool northern = j.value("northern", true);

    const auto state = richardsonHaloGuess(mu, point, az, northern);
    return state_to_json(state).dump();
}

std::string compute_nrho_json(const std::string& input) {
    const auto j = json::parse(input);

    NRHOConfig config{};
    const auto& config_json = j.at("config");
    config.point = static_cast<LagrangePoint>(config_json.value("point", 1));
    config.perilune_km = config_json.value("perilune_km", 3500.0);
    config.apolune_km = config_json.value("apolune_km", 70000.0);
    config.maxIterations = config_json.value("maxIterations", 100);
    config.tolerance = config_json.value("tolerance", 1e-12);

    const auto system = json_to_system(j.at("system"));
    const auto result = computeNRHO(config, system);

    return json({
        {"converged", result.converged},
        {"period", result.period},
        {"jacobi", result.jacobi},
        {"initialState", state_to_json(result.initialState)},
    }).dump();
}

std::string compute_transfer_json(const std::string& input) {
    const auto j = json::parse(input);
    const auto system = json_to_system(j.at("system"));

    TransferConfig config{};
    const auto& config_json = j.at("config");
    config.type = static_cast<TransferType>(config_json.value("type", 1));
    config.parkingAlt = config_json.value("parkingAlt", 200e3);
    config.targetAlt = config_json.value("targetAlt", 100e3);
    config.inclination = config_json.value("inclination", 0.0);

    TransferResult result{};
    switch (config.type) {
        case TransferType::FREE_RETURN:
            result = computeFreeReturn(system, config);
            break;
        default:
            result = computeLowEnergyTransfer(system, config);
            break;
    }

    return json({
        {"converged", result.converged},
        {"dvTotal", result.dvTotal},
        {"tof", result.tof},
        {"dvDepart", {
            result.dvDepart[0],
            result.dvDepart[1],
            result.dvDepart[2],
        }},
        {"dvArrive", {
            result.dvArrive[0],
            result.dvArrive[1],
            result.dvArrive[2],
        }},
    }).dump();
}

std::string estimate_station_keeping_json(const std::string& input) {
    const auto j = json::parse(input);
    const double mu = j.at("mu").get<double>();

    PeriodicOrbitResult orbit{};
    orbit.initialState = json_to_state(j.at("orbit").at("initialState"));
    orbit.period = j.at("orbit").at("period").get<double>();
    orbit.jacobi = j.at("orbit").value("jacobi", 0.0);
    orbit.converged = true;

    StationKeepingConfig config{};
    if (j.contains("config")) {
        const auto& config_json = j.at("config");
        config.navError = config_json.value("navError", 1.0);
        config.maneuverError = config_json.value("maneuverError", 0.01);
        config.numCycles = config_json.value("numCycles", 12);
    }

    const auto result = estimateStationKeeping(orbit, mu, config);
    return json({
        {"annualDV", result.annualDV},
        {"meanCycleDV", result.meanCycleDV},
        {"maxCycleDV", result.maxCycleDV},
        {"stable", result.stable},
        {"cycleDVs", result.cycleDVs},
    }).dump();
}

std::string coordinate_transform_json(const std::string& input) {
    const auto j = json::parse(input);
    const auto action = j.at("action").get<std::string>();
    const auto system = json_to_system(j.at("system"));
    const double epoch_seconds = j.value("epoch_s", 0.0);

    if (action == "rotatingToECI") {
        const auto state = json_to_state(j.at("state"));
        return vec6_to_json(rotatingToECI(state, system, epoch_seconds)).dump();
    }
    if (action == "eciToRotating") {
        const auto state = json_to_vec6(j.at("state"));
        return state_to_json(eciToRotating(state, system, epoch_seconds)).dump();
    }

    throw std::runtime_error("Unknown coordinate transform action: " + action);
}

std::string dispatch_operation(const std::string& operation, const json& params) {
    const std::string payload = params.dump();

    if (operation == "version") {
        return json({{"version", version()}}).dump();
    }
    if (operation == "propagateCR3BP") {
        return propagate_cr3bp_json(payload);
    }
    if (operation == "computeLagrangePoints") {
        return compute_lagrange_points_json(payload);
    }
    if (operation == "jacobiConstant") {
        return jacobi_constant_json(payload);
    }
    if (operation == "computePeriodicOrbit") {
        return compute_periodic_orbit_json(payload);
    }
    if (operation == "richardsonHaloGuess") {
        return richardson_halo_guess_json(payload);
    }
    if (operation == "computeNRHO") {
        return compute_nrho_json(payload);
    }
    if (operation == "computeTransfer") {
        return compute_transfer_json(payload);
    }
    if (operation == "estimateStationKeeping") {
        return estimate_station_keeping_json(payload);
    }
    if (operation == "coordinateTransform") {
        return coordinate_transform_json(payload);
    }

    throw std::runtime_error("Unknown cislunar operation: " + operation);
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

}  // namespace cislunar
