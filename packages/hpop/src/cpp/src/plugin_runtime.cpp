#include "hpop/plugin_runtime.h"

#include "hpop/astrodynamics.h"
#include "hpop/astrodynamics_types.h"
#include "hpop/integrators.h"
#include "hpop/force_models.h"
#include "hpop/coords.h"

#include <nlohmann/json.hpp>

#include <cmath>
#include <stdexcept>
#include <string>

namespace hpop {

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

// ---------------------------------------------------------------------------
// propagate — basic high-precision orbit propagation
// ---------------------------------------------------------------------------
// Accepts an initial ECI state vector (position km, velocity km/s) with a
// Julian-date epoch and a target Julian-date epoch. Uses the HPOP library
// RK7(8) integrator with a configurable force model set to propagate the
// state and returns the resulting position/velocity.
// ---------------------------------------------------------------------------

std::string propagate_json(const json& params) {
    using namespace astro;

    // Parse initial state
    const double epoch_jd = params.at("epochJD").get<double>();
    const double target_jd = params.at("targetJD").get<double>();

    const auto& pos = params.at("position");
    const auto& vel = params.at("velocity");

    StateVector sv;
    sv.position.x = pos.at(0).get<double>();
    sv.position.y = pos.at(1).get<double>();
    sv.position.z = pos.at(2).get<double>();
    sv.velocity.x = vel.at(0).get<double>();
    sv.velocity.y = vel.at(1).get<double>();
    sv.velocity.z = vel.at(2).get<double>();
    sv.epoch = epoch_jd;

    // Configure integrator
    IntegratorConfig config;
    if (params.contains("integrator")) {
        const auto& integ = params.at("integrator");
        if (integ.contains("minStep")) config.minStep = integ.at("minStep").get<double>();
        if (integ.contains("maxStep")) config.maxStep = integ.at("maxStep").get<double>();
        if (integ.contains("tolerance")) config.tolerance = integ.at("tolerance").get<double>();
    }

    // Configure force model
    ForceModel::ForceModelSet forces;
    forces.enableCentralBody = true;
    forces.enableJ2 = true;

    if (params.contains("forces")) {
        const auto& f = params.at("forces");
        if (f.contains("centralBody")) forces.enableCentralBody = f.at("centralBody").get<bool>();
        if (f.contains("j2")) forces.enableJ2 = f.at("j2").get<bool>();
        if (f.contains("j4")) forces.enableJ4 = f.at("j4").get<bool>();
        if (f.contains("drag")) forces.enableDrag = f.at("drag").get<bool>();
        if (f.contains("srp")) forces.enableSRP = f.at("srp").get<bool>();
        if (f.contains("thirdBodyMoon")) forces.enableThirdBodyMoon = f.at("thirdBodyMoon").get<bool>();
        if (f.contains("thirdBodySun")) forces.enableThirdBodySun = f.at("thirdBodySun").get<bool>();
    }

    // Space weather (optional)
    SpaceWeatherData weather;
    if (params.contains("weather")) {
        const auto& w = params.at("weather");
        if (w.contains("f107")) weather.f107 = w.at("f107").get<double>();
        if (w.contains("f107a")) weather.f107a = w.at("f107a").get<double>();
        if (w.contains("ap")) weather.ap = w.at("ap").get<double>();
    }

    // Propagation time span in seconds
    const double dt_sec = (target_jd - epoch_jd) * 86400.0;

    // Build derivative function parameters
    ForceModel::PropagatorParams propParams;
    propParams.forceSet = &forces;
    propParams.epochJD = epoch_jd;
    propParams.weather = &weather;

    // Initial state array [rx, ry, rz, vx, vy, vz]
    double y0[6] = {
        sv.position.x, sv.position.y, sv.position.z,
        sv.velocity.x, sv.velocity.y, sv.velocity.z
    };

    // Initialize integrator
    IntegratorState istate = integratorInit(config, y0, 0.0);

    // Propagate to target time
    bool ok = integratorPropagate(
        istate, config,
        ForceModel::forceModelDerivative,
        &propParams,
        dt_sec
    );

    if (!ok) {
        throw std::runtime_error("Integration failed to reach target epoch.");
    }

    // Build result
    json result = {
        {"epochJD", target_jd},
        {"position", {istate.y[0], istate.y[1], istate.y[2]}},
        {"velocity", {istate.y[3], istate.y[4], istate.y[5]}},
        {"propagatedDeltaSeconds", dt_sec},
        {"integrationSteps", istate.steps},
    };

    return result.dump();
}

std::string dispatch_operation(const std::string& operation, const json& params) {
    if (operation == "version") {
        return json({{"version", version()}, {"plugin", "hpop-propagator"}}).dump();
    }
    if (operation == "propagate") {
        return propagate_json(params);
    }

    throw std::runtime_error("Unknown HPOP operation: " + operation);
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

}  // namespace hpop
