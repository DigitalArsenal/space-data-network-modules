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

void configure_integrator(
    const json& params,
    astro::IntegratorConfig& config) {
    if (!params.contains("integrator")) {
        return;
    }

    const auto& integrator = params.at("integrator");
    if (integrator.contains("initialStep")) {
        config.initialStep = integrator.at("initialStep").get<double>();
    }
    if (integrator.contains("minStep")) {
        config.minStep = integrator.at("minStep").get<double>();
    }
    if (integrator.contains("maxStep")) {
        config.maxStep = integrator.at("maxStep").get<double>();
    }
    if (integrator.contains("absTolerance")) {
        config.absTolerance = integrator.at("absTolerance").get<double>();
    }
    if (integrator.contains("relTolerance")) {
        config.relTolerance = integrator.at("relTolerance").get<double>();
    }
    if (integrator.contains("tolerance")) {
        const double tolerance = integrator.at("tolerance").get<double>();
        config.absTolerance = tolerance;
        config.relTolerance = tolerance;
    }
    if (integrator.contains("maxSteps")) {
        config.maxSteps = integrator.at("maxSteps").get<uint32_t>();
    }
}

double read_optional_double(
    const json& value,
    const char* first_key,
    const char* second_key,
    double fallback) {
    if (value.contains(first_key)) {
        return value.at(first_key).get<double>();
    }
    if (second_key != nullptr && value.contains(second_key)) {
        return value.at(second_key).get<double>();
    }
    return fallback;
}

bool read_optional_bool(
    const json& value,
    const char* first_key,
    const char* second_key,
    bool fallback) {
    if (value.contains(first_key)) {
        return value.at(first_key).get<bool>();
    }
    if (second_key != nullptr && value.contains(second_key)) {
        return value.at(second_key).get<bool>();
    }
    return fallback;
}

void configure_force_models(
    const json& params,
    double epoch_jd,
    astro::ForceModel::ForceModelSet& forces) {
    using namespace astro;

    forces.usePointMass = true;
    forces.mu = MU_EARTH;
    forces.useSphericalHarmonics = true;
    forces.sphericalHarmonics.includeJ2 = true;
    forces.sphericalHarmonics.includeJ3 = false;
    forces.sphericalHarmonics.includeJ4 = false;
    forces.weather.epoch = epoch_jd;

    double mass = 1000.0;
    double area = 10.0;
    if (params.contains("spacecraft")) {
        const auto& spacecraft = params.at("spacecraft");
        mass = read_optional_double(spacecraft, "massKg", "mass", mass);
        area = read_optional_double(spacecraft, "areaM2", "area", area);
    }

    if (!params.contains("forces")) {
        forces.srp.mass = mass;
        forces.srp.area = area;
        forces.drag.mass = mass;
        forces.drag.area = area;
        return;
    }

    const auto& requested = params.at("forces");

    forces.usePointMass =
        read_optional_bool(requested, "centralBody", "pointMass", forces.usePointMass);
    forces.mu = read_optional_double(requested, "mu", nullptr, forces.mu);

    const bool use_j2 = read_optional_bool(requested, "j2", nullptr, true);
    const bool use_j3 = read_optional_bool(requested, "j3", nullptr, false);
    const bool use_j4 = read_optional_bool(requested, "j4", nullptr, false);
    forces.useSphericalHarmonics = use_j2 || use_j3 || use_j4;
    forces.sphericalHarmonics.includeJ2 = use_j2;
    forces.sphericalHarmonics.includeJ3 = use_j3;
    forces.sphericalHarmonics.includeJ4 = use_j4;
    if (requested.contains("maxDegree")) {
        forces.sphericalHarmonics.maxDegree =
            requested.at("maxDegree").get<uint16_t>();
    }
    if (requested.contains("maxOrder")) {
        forces.sphericalHarmonics.maxOrder =
            requested.at("maxOrder").get<uint16_t>();
    }

    forces.useThirdBody =
        read_optional_bool(requested, "thirdBody", nullptr, forces.useThirdBody);
    forces.thirdBody.includeSun =
        read_optional_bool(requested, "thirdBodySun", "sun", forces.thirdBody.includeSun);
    forces.thirdBody.includeMoon =
        read_optional_bool(requested, "thirdBodyMoon", "moon", forces.thirdBody.includeMoon);

    forces.useSRP = read_optional_bool(requested, "srp", nullptr, forces.useSRP);
    forces.useDrag = read_optional_bool(requested, "drag", nullptr, forces.useDrag);

    mass = read_optional_double(requested, "massKg", "mass", mass);
    area = read_optional_double(requested, "areaM2", "area", area);

    forces.srp.mass = mass;
    forces.srp.area = area;
    forces.srp.Cr = read_optional_double(requested, "cr", "Cr", forces.srp.Cr);

    forces.drag.mass = mass;
    forces.drag.area = area;
    forces.drag.Cd = read_optional_double(requested, "cd", "Cd", forces.drag.Cd);
}

void configure_weather(
    const json& params,
    double epoch_jd,
    astro::ForceModel::ForceModelSet& forces) {
    forces.weather.epoch = epoch_jd;
    if (!params.contains("weather")) {
        return;
    }

    const auto& weather = params.at("weather");
    forces.weather.F107 = read_optional_double(weather, "F107", "f107", forces.weather.F107);
    forces.weather.F107a = read_optional_double(weather, "F107a", "f107a", forces.weather.F107a);
    forces.weather.Ap = read_optional_double(weather, "Ap", "ap", forces.weather.Ap);
    forces.weather.Kp = read_optional_double(weather, "Kp", "kp", forces.weather.Kp);
}

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

    IntegratorConfig config;
    configure_integrator(params, config);

    ForceModel::ForceModelSet forces;
    configure_force_models(params, epoch_jd, forces);
    configure_weather(params, epoch_jd, forces);

    const double dt_sec = (target_jd - epoch_jd) * 86400.0;
    if (std::abs(dt_sec) < 1e-12) {
        return json({
            {"epochJD", target_jd},
            {"position", {sv.position.x, sv.position.y, sv.position.z}},
            {"velocity", {sv.velocity.x, sv.velocity.y, sv.velocity.z}},
            {"propagatedDeltaSeconds", 0.0},
            {"integrationSteps", 0},
        }).dump();
    }

    double y0[6] = {
        sv.position.x, sv.position.y, sv.position.z,
        sv.velocity.x, sv.velocity.y, sv.velocity.z
    };

    IntegratorState istate = integratorInit(config, y0, 0.0);
    bool ok = integratorPropagate(
        istate, config,
        ForceModel::ForceModelDerivative,
        &forces,
        dt_sec
    );

    if (!ok) {
        throw std::runtime_error("Integration failed to reach target epoch.");
    }

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
