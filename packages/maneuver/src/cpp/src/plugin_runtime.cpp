#include "maneuver/plugin_runtime.h"

#include "maneuver/approach.h"
#include "maneuver/classical.h"
#include "maneuver/constants.h"
#include "maneuver/types.h"

#include <nlohmann/json.hpp>

#include <stdexcept>
#include <string>

namespace maneuver {

using json = nlohmann::json;

namespace {

std::string version() { return "1.0.0"; }

json vec3_to_json(const Vector3& v) {
    return json::array({v[0], v[1], v[2]});
}

Vector3 json_to_vec3(const json& j) {
    return {j[0].get<double>(), j[1].get<double>(), j[2].get<double>()};
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

std::string hohmann_transfer_json(const std::string& input) {
    const auto j = json::parse(input);
    const double r1 = j.at("r1").get<double>();
    const double r2 = j.at("r2").get<double>();
    const double mu = j.value("mu", MU_EARTH);

    const auto result = computeHohmannTransfer(r1, r2, mu);
    return json({
        {"dv1", result.dv1},
        {"dv2", result.dv2},
        {"totalDeltaV", result.totalDeltaV},
        {"tof", result.tof},
        {"aTransfer", result.aTransfer},
        {"dv1_ric", vec3_to_json(result.dv1_ric)},
        {"dv2_ric", vec3_to_json(result.dv2_ric)},
    }).dump();
}

std::string bi_elliptic_transfer_json(const std::string& input) {
    const auto j = json::parse(input);
    const double r1 = j.at("r1").get<double>();
    const double r2 = j.at("r2").get<double>();
    const double r_intermediate = j.at("rIntermediate").get<double>();
    const double mu = j.value("mu", MU_EARTH);

    const auto result = computeBiEllipticTransfer(r1, r2, r_intermediate, mu);
    return json({
        {"dv1", result.dv1},
        {"dv2", result.dv2},
        {"dv3", result.dv3},
        {"totalDeltaV", result.totalDeltaV},
        {"tof", result.tof},
    }).dump();
}

std::string solve_lambert_json(const std::string& input) {
    const auto j = json::parse(input);
    const auto r1 = json_to_vec3(j.at("r1"));
    const auto r2 = json_to_vec3(j.at("r2"));
    const double tof = j.at("tof").get<double>();
    const double mu = j.value("mu", MU_EARTH);
    const bool prograde = j.value("prograde", true);
    const int n_revs = j.value("nRevs", 0);

    const auto result = solveLambert(r1, r2, tof, mu, prograde, n_revs);
    return json({
        {"v1", vec3_to_json(result.v1)},
        {"v2", vec3_to_json(result.v2)},
        {"dv1", result.dv1},
        {"dv2", result.dv2},
        {"totalDV", result.totalDV},
        {"tof", result.tof},
        {"converged", result.converged},
        {"revolutions", result.revolutions},
    }).dump();
}

std::string solve_lambert_min_dv_json(const std::string& input) {
    const auto j = json::parse(input);
    const auto r1 = json_to_vec3(j.at("r1"));
    const auto r2 = json_to_vec3(j.at("r2"));
    const double tof = j.at("tof").get<double>();
    const double mu = j.value("mu", MU_EARTH);
    const bool prograde = j.value("prograde", true);
    const int max_revs = j.value("maxRevs", 5);

    const auto result = solveLambertMinDV(r1, r2, tof, mu, prograde, max_revs);
    return json({
        {"v1", vec3_to_json(result.v1)},
        {"v2", vec3_to_json(result.v2)},
        {"dv1", result.dv1},
        {"dv2", result.dv2},
        {"totalDV", result.totalDV},
        {"converged", result.converged},
        {"revolutions", result.revolutions},
    }).dump();
}

std::string phasing_maneuver_json(const std::string& input) {
    const auto j = json::parse(input);
    const double current_radius = j.at("currentRadius").get<double>();
    const double phase_angle = j.at("phaseAngle").get<double>();
    const int num_revs = j.value("numRevs", 1);
    const double mu = j.value("mu", MU_EARTH);

    const auto result = computePhasingManeuver(
        current_radius, phase_angle, num_revs, mu);
    return json({
        {"dv1", result.dv1},
        {"dv2", result.dv2},
        {"totalDeltaV", result.totalDeltaV},
        {"phasingPeriod", result.phasingPeriod},
        {"phasingSMA", result.phasingSMA},
        {"totalTime", result.totalTime},
        {"numRevs", result.numRevs},
    }).dump();
}

std::string plane_change_json(const std::string& input) {
    const auto j = json::parse(input);
    const double orbital_radius = j.at("orbitalRadius").get<double>();
    const double velocity = j.at("velocity").get<double>();
    const double delta_inclination = j.at("deltaInclination").get<double>();

    const auto result = computePlaneChange(
        orbital_radius, velocity, delta_inclination);
    return json({
        {"dv", result.dv},
        {"optimalTrueAnomaly", result.optimalTrueAnomaly},
        {"dv_ric", vec3_to_json(result.dv_ric)},
    }).dump();
}

std::string combined_maneuver_json(const std::string& input) {
    const auto j = json::parse(input);
    const double r1 = j.at("r1").get<double>();
    const double r2 = j.at("r2").get<double>();
    const double delta_inclination = j.at("deltaInclination").get<double>();
    const double mu = j.value("mu", MU_EARTH);

    const auto result = computeCombinedManeuver(r1, r2, delta_inclination, mu);
    return json({
        {"dv1", result.dv1},
        {"dv2", result.dv2},
        {"totalDeltaV", result.totalDeltaV},
        {"tof", result.tof},
        {"aTransfer", result.aTransfer},
    }).dump();
}

std::string compute_cam_json(const std::string& input) {
    const auto j = json::parse(input);

    RelativeState state{};
    state.position = json_to_vec3(j.at("initialState").at("position"));
    state.velocity = json_to_vec3(j.at("initialState").at("velocity"));

    ClassicalOrbitalElements chief{};
    const auto& chief_json = j.at("chief");
    chief.semiMajorAxis = chief_json.at("semiMajorAxis").get<double>();
    chief.eccentricity = chief_json.value("eccentricity", 0.0);
    chief.inclination = chief_json.value("inclination", 0.0);
    chief.gravitationalParameter = chief_json.value("mu", MU_EARTH);

    CAMConfig config{};
    if (j.contains("config")) {
        const auto& config_json = j.at("config");
        config.minMissDistance = config_json.value("minMissDistance", 1000.0);
        config.timeToTCA = config_json.value("timeToTCA", 0.0);
        config.maxDeltaV = config_json.value("maxDeltaV", 10.0);
        config.preferRadial = config_json.value("preferRadial", false);
    }

    const auto result = computeCAM(state, chief, config);
    return json({
        {"deltaV", vec3_to_json(result.deltaV)},
        {"magnitude", result.magnitude},
        {"achievedMiss", result.achievedMiss},
        {"feasible", result.feasible},
        {"optimalBurnTime", result.optimalBurnTime},
    }).dump();
}

std::string compute_approach_json(const std::string& input) {
    const auto j = json::parse(input);

    RelativeState state{};
    state.position = json_to_vec3(j.at("initialState").at("position"));
    state.velocity = json_to_vec3(j.at("initialState").at("velocity"));

    ClassicalOrbitalElements chief{};
    const auto& chief_json = j.at("chief");
    chief.semiMajorAxis = chief_json.at("semiMajorAxis").get<double>();
    chief.eccentricity = chief_json.value("eccentricity", 0.0);
    chief.inclination = chief_json.value("inclination", 0.0);
    chief.gravitationalParameter = chief_json.value("mu", MU_EARTH);

    ApproachConfig config{};
    if (j.contains("config")) {
        const auto& config_json = j.at("config");
        config.axis = static_cast<ApproachAxis>(config_json.value("axis", 0));
        if (config_json.contains("targetPosition")) {
            config.targetPosition = json_to_vec3(config_json.at("targetPosition"));
        }
        config.approachSpeed = config_json.value("approachSpeed", 0.1);
        config.safetyCorridorWidth =
            config_json.value("safetyCorridorWidth", 10.0);
    }

    const auto result = computeApproach(state, chief, config);
    return json({
        {"corridorDeviation", result.corridorDeviation},
        {"withinCorridor", result.withinCorridor},
        {"axis", static_cast<int>(result.axis)},
        {"leg", {{"totalDeltaV", result.leg.totalDeltaV}}},
    }).dump();
}

std::string dispatch_operation(const std::string& operation, const json& params) {
    const std::string payload = params.dump();

    if (operation == "version") {
        return json({{"version", version()}}).dump();
    }
    if (operation == "hohmannTransfer") {
        return hohmann_transfer_json(payload);
    }
    if (operation == "biEllipticTransfer") {
        return bi_elliptic_transfer_json(payload);
    }
    if (operation == "solveLambert") {
        return solve_lambert_json(payload);
    }
    if (operation == "solveLambertMinDV") {
        return solve_lambert_min_dv_json(payload);
    }
    if (operation == "phasingManeuver") {
        return phasing_maneuver_json(payload);
    }
    if (operation == "planeChange") {
        return plane_change_json(payload);
    }
    if (operation == "combinedManeuver") {
        return combined_maneuver_json(payload);
    }
    if (operation == "computeCAM") {
        return compute_cam_json(payload);
    }
    if (operation == "computeApproach") {
        return compute_approach_json(payload);
    }

    throw std::runtime_error("Unknown maneuver operation: " + operation);
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

}  // namespace maneuver
