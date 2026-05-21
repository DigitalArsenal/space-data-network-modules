#include "atmosphere/plugin_runtime.h"

#include "atmosphere/models.h"
#include "atmosphere/types.h"

#include <nlohmann/json.hpp>

#include <stdexcept>
#include <string>

namespace atmosphere {

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

json state_to_json(const State& state) {
    return {
        {"density", state.density},
        {"temperature", state.temperature},
        {"pressure", state.pressure},
        {"soundSpeed", state.soundSpeed},
        {"molecularMass", state.molecularMass},
        {"numDensityN2", state.numDensityN2},
        {"numDensityO2", state.numDensityO2},
        {"numDensityO", state.numDensityO},
        {"numDensityHe", state.numDensityHe},
        {"numDensityAr", state.numDensityAr},
        {"numDensityH", state.numDensityH},
        {"numDensityN", state.numDensityN},
        {"exosphericTemp", state.exosphericTemp},
    };
}

json state_to_provider_json(const State& state, const std::string& id, double altitude_m) {
    json result = {
        {"id", id},
        {"altitudeM", altitude_m},
        {"densityKgM3", state.density},
        {"temperatureK", state.temperature},
        {"pressurePa", state.pressure},
        {"soundSpeedMps", state.soundSpeed},
        {"molecularMassKgKmol", state.molecularMass},
        {"exosphericTemperatureK", state.exosphericTemp},
    };
    return result;
}

Model parse_model(const json& params) {
    const auto model = params.value("model", std::string("US76"));
    return model == "NRLMSISE00" ? Model::NRLMSISE00 : Model::US76;
}

State state_for_model(double altitude_m, Model model, const json& params) {
    if (model == Model::NRLMSISE00) {
        SolarActivity solar{};
        if (params.contains("solar")) {
            const auto& solar_json = params.at("solar");
            solar.F107 = solar_json.value("F107", solar.F107);
            solar.F107A = solar_json.value("F107A", solar.F107A);
            if (solar_json.contains("Ap") && solar_json.at("Ap").is_array()) {
                const auto ap = solar_json.at("Ap");
                for (size_t index = 0; index < 7 && index < ap.size(); ++index) {
                    solar.Ap[index] = ap.at(index).get<double>();
                }
            }
        }
        return nrlmsise00_simple(altitude_m, solar);
    }
    return us76(altitude_m);
}

std::string model_name(Model model) {
    return model == Model::NRLMSISE00 ? "NRLMSISE00" : "US76";
}

std::string query_altitude_json(const json& params) {
    const auto model = parse_model(params);
    const double altitude_m = params.at("altitudeM").get<double>();
    const auto state = state_for_model(altitude_m, model, params);

    return json({
        {"altitudeM", altitude_m},
        {"model", model_name(model)},
        {"state", state_to_json(state)},
    }).dump();
}

std::string query_altitudes_json(const json& params) {
    const auto model = parse_model(params);
    const auto altitudes = params.at("altitudesM");
    json results = json::array();
    for (const auto& altitude_json : altitudes) {
        results.push_back(json::parse(query_altitude_json({
            {"altitudeM", altitude_json.get<double>()},
            {"model", model_name(model)},
            {"solar", params.value("solar", json::object())},
        })));
    }
    return json({
        {"count", results.size()},
        {"results", results},
    }).dump();
}

std::string query_atmosphere_state_batch_json(const json& params) {
    const auto model = parse_model(params);
    json states = json::array();
    const auto samples = params.contains("samples")
        ? params.at("samples")
        : json::array();

    for (size_t index = 0; index < samples.size(); ++index) {
        const auto& sample = samples.at(index);
        const auto id = sample.value("id", std::string("sample-") + std::to_string(index));
        const double altitude_m = sample.at("altitudeM").get<double>();
        const auto state = state_for_model(altitude_m, model, params);
        states.push_back(state_to_provider_json(state, id, altitude_m));
    }

    if (states.empty() && params.contains("altitudesM")) {
        const auto altitudes = params.at("altitudesM");
        for (size_t index = 0; index < altitudes.size(); ++index) {
            const double altitude_m = altitudes.at(index).get<double>();
            const auto state = state_for_model(altitude_m, model, params);
            states.push_back(state_to_provider_json(
                state,
                std::string("altitude-") + std::to_string(index),
                altitude_m));
        }
    }

    return json({
        {"provider", "atmosphere-model"},
        {"model", model_name(model)},
        {"count", states.size()},
        {"states", states},
    }).dump();
}

std::string dispatch_operation(const std::string& operation, const json& params) {
    if (operation == "version") {
        return json({{"version", version()}}).dump();
    }
    if (operation == "queryAltitude") {
        return query_altitude_json(params);
    }
    if (operation == "queryAltitudes") {
        return query_altitudes_json(params);
    }
    if (operation == "queryAtmosphereStateBatch") {
        return query_atmosphere_state_batch_json(params);
    }

    throw std::runtime_error("Unknown atmosphere operation: " + operation);
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

}  // namespace atmosphere
