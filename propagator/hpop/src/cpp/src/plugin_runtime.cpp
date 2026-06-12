#include "hpop/plugin_runtime.h"

#include "hpop/astrodynamics.h"
#include "hpop/astrodynamics_types.h"
#include "hpop/integrators.h"
#include "hpop/force_models.h"
#include "hpop/coords.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <string>

// Real NRLMSISE-00 (public-domain Brodowski C port, vendored in
// third_party/nrlmsise00/).
extern "C" {
#include "nrlmsise-00.h"
}

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

astro::IntegrationMethod parse_integration_method(const std::string& raw_name) {
    std::string name = raw_name;
    std::transform(
        name.begin(),
        name.end(),
        name.begin(),
        [](unsigned char ch) { return static_cast<char>(std::toupper(ch)); });

    if (name == "RK4") {
        return astro::IntegrationMethod::RK4;
    }
    if (name == "RKF45") {
        return astro::IntegrationMethod::RKF45;
    }
    if (name == "RKF78") {
        return astro::IntegrationMethod::RKF78;
    }
    if (name == "RK78") {
        return astro::IntegrationMethod::RK78;
    }
    if (name == "ABM") {
        return astro::IntegrationMethod::ABM;
    }
    if (name == "BS") {
        return astro::IntegrationMethod::BS;
    }
    if (name == "COWELL") {
        return astro::IntegrationMethod::Cowell;
    }
    if (name == "ENCKE") {
        return astro::IntegrationMethod::Encke;
    }
    if (name == "EQUINOCTIALVOP") {
        return astro::IntegrationMethod::EquinoctialVOP;
    }
    throw std::runtime_error("Unknown integrator method: " + raw_name);
}

void configure_integrator(
    const json& params,
    astro::IntegratorConfig& config) {
    if (!params.contains("integrator")) {
        return;
    }

    const auto& integrator = params.at("integrator");
    if (integrator.contains("method")) {
        config.method =
            parse_integration_method(integrator.at("method").get<std::string>());
    }
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

    const auto result = Integrator::PropagateWithResult(sv, dt_sec, config, forces);
    if (!result.success) {
        throw std::runtime_error(
            result.errorMessage.empty()
                ? "Integration failed to reach target epoch."
                : result.errorMessage);
    }

    json output = {
        {"epochJD", target_jd},
        {"position", {
            result.finalState.position.x,
            result.finalState.position.y,
            result.finalState.position.z,
        }},
        {"velocity", {
            result.finalState.velocity.x,
            result.finalState.velocity.y,
            result.finalState.velocity.z,
        }},
        {"propagatedDeltaSeconds", dt_sec},
        {"integrationSteps", result.steps},
    };

    return output.dump();
}

// Direct atmosphere query against the same model implementations used by the
// HPOP drag force path. Honest model names:
//   "NRLMSISE00"     — real NRLMSISE-00 (vendored Picone/Hedin/Drob C port)
//   "USSA1976"       — US Standard Atmosphere 1976, 0-86 km geometric
//   "EXPONENTIAL"    — Vallado piecewise-exponential model (Table 8-4)
// The simplified JB2008/DTM2020 approximations are intentionally NOT exposed
// here; they are crude approximations, not the published coefficient models.
std::string atmosphere_json(const json& params) {
    const auto model = params.value("model", std::string("NRLMSISE00"));

    if (model == "USSA1976") {
        const double alt_km = params.at("altitudeKm").get<double>();
        const auto atm = astro::computeUSSA1976(alt_km);
        return json({
            {"model", "USSA1976"},
            {"altitudeKm", alt_km},
            {"densityKgM3", atm.density},
            {"temperatureK", atm.temperature},
            {"scaleHeightKm", atm.scaleHeight},
        }).dump();
    }

    if (model == "EXPONENTIAL") {
        const double alt_km = params.at("altitudeKm").get<double>();
        return json({
            {"model", "EXPONENTIAL"},
            {"altitudeKm", alt_km},
            {"densityKgM3", astro::exponentialAtmosphereDensity(alt_km)},
        }).dump();
    }

    if (model != "NRLMSISE00") {
        throw std::runtime_error(
            "Unknown atmosphere model \"" + model +
            "\". Supported: NRLMSISE00, USSA1976, EXPONENTIAL.");
    }

    nrlmsise_input input;
    nrlmsise_flags flags;
    nrlmsise_output output;
    std::memset(&input, 0, sizeof(input));
    std::memset(&flags, 0, sizeof(flags));
    std::memset(&output, 0, sizeof(output));

    flags.switches[0] = 0;
    for (int i = 1; i < 24; ++i) {
        flags.switches[i] = 1;
    }

    input.year = params.value("year", 0);
    input.doy = params.value("dayOfYear", 172);
    input.sec = params.value("secondOfDay", 29000.0);
    input.alt = params.at("altitudeKm").get<double>();
    input.g_lat = params.value("latitudeDeg", 0.0);
    input.g_long = params.value("longitudeDeg", 0.0);
    if (params.contains("localSolarTimeHours")) {
        input.lst = params.at("localSolarTimeHours").get<double>();
    } else {
        // Recommended consistency relation (NRLMSISE-00 package notes).
        double lst = input.sec / 3600.0 + input.g_long / 15.0;
        lst = std::fmod(lst, 24.0);
        if (lst < 0.0) lst += 24.0;
        input.lst = lst;
    }
    input.f107A = params.value("f107a", 150.0);
    input.f107 = params.value("f107", 150.0);
    input.ap = params.value("ap", 4.0);
    input.ap_a = nullptr;

    // gtd7: total mass density excludes anomalous oxygen (canonical test
    // vectors). gtd7d: includes anomalous oxygen (drag-effective density,
    // what the HPOP drag path uses).
    const bool includeAnomalousOxygen = params.value("includeAnomalousOxygen", false);
    if (includeAnomalousOxygen) {
        gtd7d(&input, &flags, &output);
    } else {
        gtd7(&input, &flags, &output);
    }

    return json({
        {"model", "NRLMSISE00"},
        {"variant", includeAnomalousOxygen ? "gtd7d" : "gtd7"},
        {"altitudeKm", input.alt},
        {"densityKgM3", output.d[5] * 1000.0},
        {"densityGCm3", output.d[5]},
        {"temperatureK", output.t[1]},
        {"exosphericTemperatureK", output.t[0]},
        {"numberDensitiesCm3", {
            {"He", output.d[0]},
            {"O", output.d[1]},
            {"N2", output.d[2]},
            {"O2", output.d[3]},
            {"Ar", output.d[4]},
            {"H", output.d[6]},
            {"N", output.d[7]},
            {"anomalousO", output.d[8]},
        }},
    }).dump();
}

std::string dispatch_operation(const std::string& operation, const json& params) {
    if (operation == "version") {
        return json({{"version", version()}, {"plugin", "hpop-propagator"}}).dump();
    }
    if (operation == "propagate") {
        return propagate_json(params);
    }
    if (operation == "atmosphere") {
        return atmosphere_json(params);
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
