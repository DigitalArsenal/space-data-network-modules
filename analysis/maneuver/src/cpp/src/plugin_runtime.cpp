#include "maneuver/plugin_runtime.h"

#include "maneuver/approach.h"
#include "maneuver/classical.h"
#include "maneuver/constants.h"
#include "maneuver/math.h"
#include "maneuver/propagation.h"
#include "maneuver/rendezvous.h"
#include "maneuver/stm.h"
#include "maneuver/targeting.h"
#include "maneuver/transforms.h"
#include "maneuver/types.h"

#include <nlohmann/json.hpp>

#include <cmath>
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

json roe_to_json(const ROEVector& roe) {
    return json::array({roe[0], roe[1], roe[2], roe[3], roe[4], roe[5]});
}

json stm6_to_json(const STM6& stm) {
    json rows = json::array();
    for (const auto& row : stm) {
        rows.push_back(json::array(
            {row[0], row[1], row[2], row[3], row[4], row[5]}));
    }
    return rows;
}

json trajectory_to_json(const std::vector<TrajectoryPoint>& trajectory) {
    json out = json::array();
    for (const auto& point : trajectory) {
        out.push_back({
            {"time", point.time},
            {"position", vec3_to_json(point.position)},
            {"velocity", vec3_to_json(point.velocity)},
        });
    }
    return out;
}

json maneuver_to_json(const Maneuver& maneuver) {
    return json({
        {"deltaV", vec3_to_json(maneuver.deltaV)},
        {"magnitude", maneuver.magnitude},
        {"chief", {
            {"semiMajorAxis", maneuver.chief.semiMajorAxis},
            {"eccentricity", maneuver.chief.eccentricity},
            {"inclination", maneuver.chief.inclination},
            {"raan", maneuver.chief.raan},
            {"argumentOfPerigee", maneuver.chief.argumentOfPerigee},
            {"meanAnomaly", maneuver.chief.meanAnomaly},
            {"mu", maneuver.chief.gravitationalParameter},
        }},
    });
}

json leg_to_json(const ManeuverLeg& leg, int index) {
    return json({
        {"index", index},
        {"from", vec3_to_json(leg.from)},
        {"to", vec3_to_json(leg.to)},
        {"targetVelocity", vec3_to_json(leg.targetVelocity)},
        {"tof", leg.tof},
        {"burn1", maneuver_to_json(leg.burn1)},
        {"burn2", maneuver_to_json(leg.burn2)},
        {"totalDeltaV", leg.totalDeltaV},
        {"converged", leg.converged},
        {"iterations", leg.iterations},
        {"positionError", leg.positionError},
    });
}

ClassicalOrbitalElements json_to_chief(const json& j) {
    ClassicalOrbitalElements chief{};
    chief.semiMajorAxis = j.at("semiMajorAxis").get<double>();
    chief.eccentricity = j.value("eccentricity", 0.0);
    chief.inclination = j.value("inclination", 0.0);
    chief.raan = j.value("raan", 0.0);
    chief.argumentOfPerigee = j.value("argumentOfPerigee", 0.0);
    chief.meanAnomaly = j.value("meanAnomaly", 0.0);
    chief.gravitationalParameter = j.value("mu", MU_EARTH);
    chief.angularMomentum = j.value(
        "angularMomentum",
        std::sqrt(chief.gravitationalParameter * chief.semiMajorAxis *
                  (1.0 - chief.eccentricity * chief.eccentricity)));
    return chief;
}

ROEVector json_to_roe_vector(const json& j) {
    return {
        j[0].get<double>(),
        j[1].get<double>(),
        j[2].get<double>(),
        j[3].get<double>(),
        j[4].get<double>(),
        j[5].get<double>(),
    };
}

TargetingOptions json_to_targeting_options(const json& j) {
    TargetingOptions options{};
    options.includeJ2 = j.value("includeJ2", true);
    options.includeDrag = j.value("includeDrag", false);
    options.maxIterations = j.value("maxIterations", 50);
    options.positionTolerance = j.value("positionTolerance", 1.0);
    options.velocityTolerance = j.value("velocityTolerance", 0.001);
    options.tofMinOrbits = j.value("tofMinOrbits", 0.5);
    options.tofMaxOrbits = j.value("tofMaxOrbits", 3.0);
    if (j.contains("targetVelocity")) {
        options.targetVelocity = json_to_vec3(j.at("targetVelocity"));
    }
    if (j.contains("dragConfig")) {
        const auto& drag = j.at("dragConfig");
        const auto type = drag.value("type", std::string("eccentric"));
        options.dragConfig.type =
            type == "arbitrary" ? DragType::ARBITRARY : DragType::ECCENTRIC;
        options.dragConfig.daDotDrag = drag.value("daDotDrag", 0.0);
        options.dragConfig.dexDotDrag = drag.value("dexDotDrag", 0.0);
        options.dragConfig.deyDotDrag = drag.value("deyDotDrag", 0.0);
    }
    return options;
}

ROEPropagationOptions json_to_propagation_options(const json& j) {
    ROEPropagationOptions options{};
    options.includeJ2 = j.value("includeJ2", true);
    options.includeDrag = j.value("includeDrag", false);
    if (j.contains("dragConfig")) {
        const auto& drag = j.at("dragConfig");
        const auto type = drag.value("type", std::string("eccentric"));
        options.dragConfig.type =
            type == "arbitrary" ? DragType::ARBITRARY : DragType::ECCENTRIC;
        options.dragConfig.daDotDrag = drag.value("daDotDrag", 0.0);
        options.dragConfig.dexDotDrag = drag.value("dexDotDrag", 0.0);
        options.dragConfig.deyDotDrag = drag.value("deyDotDrag", 0.0);
    }
    return options;
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

std::string compute_roe_state_transition_json(const std::string& input) {
    const auto j = json::parse(input);
    const auto chief = json_to_chief(j.at("chief"));
    const double delta_time = j.at("deltaTime").get<double>();
    const auto model = j.value("model", std::string("j2"));

    STM6 stm{};
    json extras = json::object();
    if (model == "keplerian") {
        stm = computeKeplerianSTM(chief, delta_time);
    } else if (model == "j2") {
        stm = computeJ2STM(chief, delta_time);
    } else if (model == "j2-drag-eccentric") {
        const auto result = computeJ2DragSTMEccentric(chief, delta_time);
        for (int r = 0; r < 6; ++r) {
            for (int c = 0; c < 6; ++c) {
                stm[r][c] = result.stm[r][c];
            }
        }
        extras["dragColumn"] = roe_to_json(result.dragColumn);
    } else if (model == "j2-drag-arbitrary") {
        const auto result = computeJ2DragSTMArbitrary(chief, delta_time);
        for (int r = 0; r < 6; ++r) {
            for (int c = 0; c < 6; ++c) {
                stm[r][c] = result.stm[r][c];
            }
        }
        json columns = json::array();
        for (const auto& row : result.dragColumns) {
            columns.push_back(json::array({row[0], row[1], row[2]}));
        }
        extras["dragColumns"] = columns;
    } else {
        throw std::runtime_error("Unsupported ROE STM model: " + model);
    }

    json response({
        {"reference", "Koenig-Guffanti-D'Amico ROE STM"},
        {"model", model},
        {"deltaTime", delta_time},
        {"stm", stm6_to_json(stm)},
    });

    if (j.contains("initialRoe")) {
        const auto initial_roe = json_to_roe_vector(j.at("initialRoe"));
        const auto options = json_to_propagation_options(j);
        const auto propagated =
            propagateROE(vectorToROE(initial_roe), chief, delta_time, options);
        response["initialRoe"] = roe_to_json(initial_roe);
        response["propagatedRoe"] = roe_to_json(roeToVector(propagated));
    }

    for (auto it = extras.begin(); it != extras.end(); ++it) {
        response[it.key()] = it.value();
    }
    return response.dump();
}

std::string plan_relative_waypoint_mission_json(const std::string& input) {
    const auto j = json::parse(input);

    RelativeState state{};
    state.position = json_to_vec3(j.at("initialState").at("position"));
    state.velocity = json_to_vec3(j.at("initialState").at("velocity"));

    const auto chief = json_to_chief(j.at("chief"));
    const auto options_json =
        j.contains("options") ? j.at("options") : json::object();
    const auto options = json_to_targeting_options(options_json);
    const int points_per_leg = options_json.value("pointsPerLeg", 48);

    std::vector<Waypoint> waypoints;
    for (const auto& item : j.at("waypoints")) {
        Waypoint waypoint{};
        waypoint.position = json_to_vec3(item.at("position"));
        if (item.contains("velocity")) {
            waypoint.velocity = json_to_vec3(item.at("velocity"));
            waypoint.hasVelocity = true;
        }
        if (item.contains("tof")) {
            waypoint.tofHint = item.at("tof").get<double>();
            waypoint.hasTofHint = true;
        }
        waypoints.push_back(waypoint);
    }

    const auto plan = planMission(state, waypoints, chief, options);
    const auto trajectory = generateMissionTrajectory(
        plan,
        chief,
        state.position,
        state.velocity,
        options,
        points_per_leg);

    json legs = json::array();
    for (size_t index = 0; index < plan.legs.size(); ++index) {
        legs.push_back(leg_to_json(plan.legs[index], static_cast<int>(index)));
    }

    return json({
        {"reference", "Koenig-Guffanti-D'Amico ROE STM"},
        {"model", options.includeJ2 ? "j2" : "keplerian"},
        {"includeDrag", options.includeDrag},
        {"converged", plan.converged},
        {"totalDeltaV", plan.totalDeltaV},
        {"totalTime", plan.totalTime},
        {"legs", legs},
        {"trajectory", trajectory_to_json(trajectory)},
    }).dump();
}

std::string compute_cam_json(const std::string& input) {
    const auto j = json::parse(input);

    RelativeState state{};
    state.position = json_to_vec3(j.at("initialState").at("position"));
    state.velocity = json_to_vec3(j.at("initialState").at("velocity"));

    const auto chief = json_to_chief(j.at("chief"));

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

    const auto chief = json_to_chief(j.at("chief"));

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

const char* phase_name(RendezvousPhase phase) {
    switch (phase) {
        case RendezvousPhase::DRIFT: return "drift";
        case RendezvousPhase::BRAKE: return "brake";
        case RendezvousPhase::HOLD: return "hold";
    }
    return "unknown";
}

std::string simulate_rendezvous_json(const std::string& input) {
    const auto j = json::parse(input);
    const auto chief = json_to_chief(j.at("chief"));

    RendezvousConfig config{};
    config.initialPosition = json_to_vec3(j.at("initialPosition"));
    if (j.contains("initialVelocity")) {
        config.initialVelocity = json_to_vec3(j.at("initialVelocity"));
        config.solveInitialVelocity = false;
    }
    config.solveInitialVelocity =
        j.value("solveInitialVelocity", config.solveInitialVelocity);
    config.brakePoint = json_to_vec3(j.at("brakePoint"));
    config.holdPoint = json_to_vec3(j.at("holdPoint"));
    config.driftDuration = j.at("driftDuration").get<double>();
    config.brakeDuration = j.at("brakeDuration").get<double>();
    config.holdDuration = j.value("holdDuration", 0.0);

    if (j.contains("control")) {
        const auto& control = j.at("control");
        config.controlBandwidth = control.value("bandwidth", 0.0);
        config.dampingRatio = control.value("dampingRatio", 1.0);
        config.kp = control.value("kp", 0.0);
        config.kd = control.value("kd", 0.0);
        config.useFeedforward = control.value("useFeedforward", true);
        config.compensateCoriolis =
            control.value("compensateCoriolis", true);
        config.compensateGravityGradient =
            control.value("compensateGravityGradient", true);
        config.maxAccel = control.value("maxAccel", 0.0);
    }
    if (j.contains("integration")) {
        const auto& integration = j.at("integration");
        config.timeStep = integration.value("timeStep", 1.0);
        config.outputEvery = integration.value("outputEvery", 10);
        config.includeJ2 = integration.value("includeJ2", false);
    }

    const auto result = simulateRendezvous(config, chief);
    if (!result.valid) {
        throw std::runtime_error(result.message);
    }

    json trajectory = json::array();
    for (const auto& sample : result.trajectory) {
        trajectory.push_back({
            {"time", sample.time},
            {"phase", phase_name(sample.phase)},
            {"position", vec3_to_json(sample.position)},
            {"velocity", vec3_to_json(sample.velocity)},
            {"referencePosition", vec3_to_json(sample.referencePosition)},
            {"referenceVelocity", vec3_to_json(sample.referenceVelocity)},
            {"referenceAcceleration",
             vec3_to_json(sample.referenceAcceleration)},
            {"controlAccel", vec3_to_json(sample.controlAccel)},
            {"positionError", sample.positionError},
            {"velocityError", sample.velocityError},
        });
    }

    return json({
        {"reference",
         "HCW combined-case drift + quintic brake + feedback-linearized PD"},
        {"meanMotion", result.meanMotion},
        {"solvedInitialVelocity", vec3_to_json(result.solvedInitialVelocity)},
        {"gains", {
            {"kp", vec3_to_json(result.gainKp)},
            {"kd", vec3_to_json(result.gainKd)},
        }},
        {"phases", {
            {"driftEnd", result.driftEnd},
            {"brakeEnd", result.brakeEnd},
            {"totalTime", result.totalTime},
        }},
        {"metrics", {
            {"totalDeltaV", result.metrics.totalDeltaV},
            {"maxControlAccel", result.metrics.maxControlAccel},
            {"saturatedSteps", result.metrics.saturatedSteps},
            {"maxPositionError", result.metrics.maxPositionError},
            {"rmsPositionError", result.metrics.rmsPositionError},
            {"maxPositionErrorDrift", result.metrics.maxPositionErrorDrift},
            {"maxPositionErrorBrake", result.metrics.maxPositionErrorBrake},
            {"maxPositionErrorHold", result.metrics.maxPositionErrorHold},
            {"finalPositionError", result.metrics.finalPositionError},
            {"finalVelocityError", result.metrics.finalVelocityError},
        }},
        {"trajectory", trajectory},
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
    if (operation == "computeRoeStateTransition") {
        return compute_roe_state_transition_json(payload);
    }
    if (operation == "planRelativeWaypointMission") {
        return plan_relative_waypoint_mission_json(payload);
    }
    if (operation == "computeCAM") {
        return compute_cam_json(payload);
    }
    if (operation == "computeApproach") {
        return compute_approach_json(payload);
    }
    if (operation == "simulateRendezvous") {
        return simulate_rendezvous_json(payload);
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
