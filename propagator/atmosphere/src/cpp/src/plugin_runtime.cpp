#include "atmosphere/plugin_runtime.h"

#include "atmosphere/models.h"
#include "atmosphere/types.h"

#include <nlohmann/json.hpp>

#include <cmath>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>

namespace atmosphere {

using json = nlohmann::json;

namespace {

// The WASM build has no C++ exception catching, so request handling reports
// problems as values: a thrown exception would trap instead of answering.
struct RequestStatus {
    bool ok = true;
    std::string code;
    std::string message;
};

RequestStatus request_error(std::string code, std::string message) {
    return RequestStatus{false, std::move(code), std::move(message)};
}

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

// An absent model means US76; an unknown name is refused, never replaced.
RequestStatus parse_model(const json& params, Model& model) {
    model = Model::US76;
    if (!params.contains("model")) {
        return {};
    }
    const auto& name = params.at("model");
    if (name.is_string() && name.get<std::string>() == "US76") {
        return {};
    }
    if (name.is_string() && name.get<std::string>() == "NRLMSISE00") {
        model = Model::NRLMSISE00;
        return {};
    }
    return {false, "unsupported-atmosphere-model", "model must be \"US76\" or \"NRLMSISE00\"."};
}


bool read_number(const json& object, const char* key, double& value) {
    if (!object.is_object() || !object.contains(key) || !object.at(key).is_number()) {
        return false;
    }
    value = object.at(key).get<double>();
    return std::isfinite(value);
}

RequestStatus required_number(const json& object, const char* key, const char* context, double& value) {
    if (!read_number(object, key, value)) {
        return request_error(
            "missing-nrlmsise-input",
            std::string(context) + "." + key + " is required for NRLMSISE00 and must be a finite number.");
    }
    return {};
}

RequestStatus check_altitude(double altitude_m, Model model) {
    if (!std::isfinite(altitude_m)) {
        return request_error("invalid-altitude", "altitudeM must be finite.");
    }
    if (model == Model::NRLMSISE00 && (altitude_m < 0.0 || altitude_m > NRLMSISE_MAX_ALT)) {
        return request_error(
            "altitude-out-of-range",
            "NRLMSISE00 altitudeM (geodetic height) must be within 0 to 1000000 m.");
    }
    return {};
}

// NRLMSISE-00 has no neutral defaults: space weather, geodetic position and
// UTC epoch all change the answer, so each must be supplied.
RequestStatus state_for_model(double altitude_m, Model model, const json& params, State& state) {
    if (auto status = check_altitude(altitude_m, model); !status.ok) {
        return status;
    }
    if (model != Model::NRLMSISE00) {
        state = us76(altitude_m);
        return {};
    }

    if (!params.contains("solar") || !params.at("solar").is_object()) {
        return request_error("missing-nrlmsise-input", "solar is required for NRLMSISE00.");
    }
    const auto& solar_json = params.at("solar");
    SolarActivity solar{};
    // Observed flux at Earth distance: previous-day daily value and the
    // 81-day centered mean (nrlmsise-00.h, notes on input variables).
    if (auto status = required_number(solar_json, "F107", "solar", solar.F107); !status.ok) {
        return status;
    }
    if (auto status = required_number(solar_json, "F107A", "solar", solar.F107A); !status.ok) {
        return status;
    }
    if (solar.F107 <= 0.0 || solar.F107A <= 0.0) {
        return request_error("invalid-nrlmsise-input", "solar.F107 and solar.F107A must be positive.");
    }
    const bool history = params.contains("apHistory") && params.at("apHistory").is_boolean() &&
                         params.at("apHistory").get<bool>();
    solar.geomagnetic = history ? GeomagneticInput::ApHistory : GeomagneticInput::DailyAp;
    if (!solar_json.contains("Ap") || !solar_json.at("Ap").is_array()) {
        return request_error("missing-nrlmsise-input", "solar.Ap is required for NRLMSISE00.");
    }
    const auto& ap = solar_json.at("Ap");
    const size_t needed = history ? 7 : 1;
    if (ap.size() < needed || ap.size() > 7) {
        return request_error(
            "invalid-nrlmsise-input",
            history ? "solar.Ap must hold the 7-element ap history when apHistory is true."
                    : "solar.Ap must hold the daily Ap first (1 to 7 elements).");
    }
    for (size_t index = 0; index < ap.size(); ++index) {
        if (!ap.at(index).is_number()) {
            return request_error("invalid-nrlmsise-input", "solar.Ap values must be numbers.");
        }
        const double value = ap.at(index).get<double>();
        if (!std::isfinite(value) || value < 0.0 || value > 400.0) {
            return request_error("invalid-nrlmsise-input", "solar.Ap values must be finite within 0-400.");
        }
        solar.Ap[index] = value;
    }
    for (size_t index = ap.size(); index < 7; ++index) {
        solar.Ap[index] = solar.Ap[0];
    }

    if (!params.contains("position")) {
        return request_error("missing-nrlmsise-input", "position is required for NRLMSISE00.");
    }
    if (!params.contains("epoch")) {
        return request_error("missing-nrlmsise-input", "epoch is required for NRLMSISE00.");
    }
    constexpr double RAD = M_PI / 180.0;
    const auto& p = params.at("position");
    double latitude_deg = 0.0;
    double longitude_deg = 0.0;
    if (auto status = required_number(p, "latitudeDeg", "position", latitude_deg); !status.ok) {
        return status;
    }
    if (auto status = required_number(p, "longitudeDeg", "position", longitude_deg); !status.ok) {
        return status;
    }
    if (latitude_deg < -90.0 || latitude_deg > 90.0) {
        return request_error("invalid-nrlmsise-input", "position.latitudeDeg must be within -90 to 90.");
    }
    GeoPos pos{latitude_deg * RAD, longitude_deg * RAD, altitude_m};

    const auto& e = params.at("epoch");
    double year = 0.0;
    double day_of_year = 0.0;
    Epoch epoch{};
    if (auto status = required_number(e, "year", "epoch", year); !status.ok) {
        return status;
    }
    if (auto status = required_number(e, "dayOfYear", "epoch", day_of_year); !status.ok) {
        return status;
    }
    if (auto status = required_number(e, "secondOfDay", "epoch", epoch.secondOfDay); !status.ok) {
        return status;
    }
    if (day_of_year < 1.0 || day_of_year > 366.0 ||
        epoch.secondOfDay < 0.0 || epoch.secondOfDay >= 86401.0) {
        return request_error(
            "invalid-nrlmsise-input",
            "epoch.dayOfYear must be 1-366 and epoch.secondOfDay within the UTC day.");
    }
    epoch.year = static_cast<int32_t>(year);
    epoch.dayOfYear = static_cast<int32_t>(day_of_year);

    // Optional explicit local apparent solar time (hours, [0,24)). The
    // canonical published NRLMSISE-00 test vectors use an lst
    // deliberately inconsistent with UT/longitude, so tests need this
    // override. Negative or absent -> derive from UT and longitude.
    double lst = -1.0;
    if (params.contains("localSolarTimeHours")) {
        if (!read_number(params, "localSolarTimeHours", lst) || lst >= 24.0) {
            return request_error(
                "invalid-nrlmsise-input",
                "localSolarTimeHours must be within [0, 24), or negative to derive it.");
        }
    }
    state = nrlmsise00(pos, epoch, solar, lst);
    return {};
}

std::string model_name(Model model) {
    return model == Model::NRLMSISE00 ? "NRLMSISE00" : "US76";
}

RequestStatus query_altitude_json(const json& params, json& out) {
    Model model = Model::US76;
    if (auto status = parse_model(params, model); !status.ok) {
        return status;
    }
    double altitude_m = 0.0;
    if (!read_number(params, "altitudeM", altitude_m)) {
        return request_error("invalid-altitude", "altitudeM is required and must be finite.");
    }
    State state{};
    if (auto status = state_for_model(altitude_m, model, params, state); !status.ok) {
        return status;
    }
    out = json({
        {"altitudeM", altitude_m},
        {"model", model_name(model)},
        {"state", state_to_json(state)},
    });
    return {};
}

RequestStatus query_altitudes_json(const json& params, json& out) {
    Model model = Model::US76;
    if (auto status = parse_model(params, model); !status.ok) {
        return status;
    }
    if (!params.contains("altitudesM") || !params.at("altitudesM").is_array()) {
        return request_error("invalid-altitude", "altitudesM must be an array.");
    }
    json results = json::array();
    for (const auto& altitude_json : params.at("altitudesM")) {
        if (!altitude_json.is_number()) {
            return request_error("invalid-altitude", "altitudesM entries must be numbers.");
        }
        json query = params;
        query.erase("altitudesM");
        query["altitudeM"] = altitude_json.get<double>();
        query["model"] = model_name(model);
        json result;
        if (auto status = query_altitude_json(query, result); !status.ok) {
            return status;
        }
        results.push_back(std::move(result));
    }
    out = json({
        {"count", results.size()},
        {"results", results},
    });
    return {};
}

RequestStatus query_atmosphere_state_batch_json(const json& params, json& out) {
    Model model = Model::US76;
    if (auto status = parse_model(params, model); !status.ok) {
        return status;
    }
    json states = json::array();
    const json samples = params.contains("samples") && params.at("samples").is_array()
        ? params.at("samples")
        : json::array();

    for (size_t index = 0; index < samples.size(); ++index) {
        const auto& sample = samples.at(index);
        if (!sample.is_object()) {
            return request_error("invalid-sample", "samples entries must be objects.");
        }
        std::string id = "sample-" + std::to_string(index);
        if (sample.contains("id") && sample.at("id").is_string()) {
            id = sample.at("id").get<std::string>();
        }
        double altitude_m = 0.0;
        if (!read_number(sample, "altitudeM", altitude_m)) {
            return request_error("invalid-altitude", "samples[].altitudeM is required and must be finite.");
        }
        State state{};
        if (auto status = state_for_model(altitude_m, model, params, state); !status.ok) {
            return status;
        }
        states.push_back(state_to_provider_json(state, id, altitude_m));
    }

    if (states.empty() && params.contains("altitudesM") && params.at("altitudesM").is_array()) {
        const auto& altitudes = params.at("altitudesM");
        for (size_t index = 0; index < altitudes.size(); ++index) {
            if (!altitudes.at(index).is_number()) {
                return request_error("invalid-altitude", "altitudesM entries must be numbers.");
            }
            const double altitude_m = altitudes.at(index).get<double>();
            State state{};
            if (auto status = state_for_model(altitude_m, model, params, state); !status.ok) {
                return status;
            }
            states.push_back(state_to_provider_json(
                state,
                std::string("altitude-") + std::to_string(index),
                altitude_m));
        }
    }

    out = json({
        {"provider", "atmosphere-model"},
        {"model", model_name(model)},
        {"count", states.size()},
        {"states", states},
    });
    return {};
}

// {"operation":"queryWind","params":{"altitudeM", "position":{latitudeDeg,
// longitudeDeg}, "epoch":{year, dayOfYear, secondOfDay}, "ap3h"}}: HWM14
// horizontal wind. ap3h is the 3-hour ap of the epoch and is required; a
// negative value asks for the quiet-time wind only (HWM14's convention).
RequestStatus query_wind_json(const json& params, json& out) {
    double altitude_m = 0.0, latitude_deg = 0.0, longitude_deg = 0.0;
    double year = 0.0, day_of_year = 0.0, ap3h = 0.0;
    Epoch epoch{};
    if (auto status = required_number(params, "altitudeM", "params", altitude_m); !status.ok) return status;
    if (!params.contains("position") || !params.contains("epoch")) {
        return request_error("missing-wind-input", "position and epoch are required for queryWind.");
    }
    const auto& p = params.at("position");
    const auto& e = params.at("epoch");
    if (auto status = required_number(p, "latitudeDeg", "position", latitude_deg); !status.ok) return status;
    if (auto status = required_number(p, "longitudeDeg", "position", longitude_deg); !status.ok) return status;
    if (auto status = required_number(e, "year", "epoch", year); !status.ok) return status;
    if (auto status = required_number(e, "dayOfYear", "epoch", day_of_year); !status.ok) return status;
    if (auto status = required_number(e, "secondOfDay", "epoch", epoch.secondOfDay); !status.ok) return status;
    if (auto status = required_number(params, "ap3h", "params", ap3h); !status.ok) return status;
    if (altitude_m < 0.0 || latitude_deg < -90.0 || latitude_deg > 90.0 || day_of_year < 1.0 ||
        day_of_year > 366.0 || epoch.secondOfDay < 0.0 || epoch.secondOfDay >= 86401.0 || ap3h > 400.0) {
        return request_error("invalid-wind-input",
                             "queryWind needs altitudeM >= 0, latitudeDeg within -90 to 90, dayOfYear 1-366, "
                             "secondOfDay within the UTC day and ap3h <= 400 (negative for quiet time).");
    }
    epoch.year = static_cast<int32_t>(year);
    epoch.dayOfYear = static_cast<int32_t>(day_of_year);
    constexpr double RAD = M_PI / 180.0;
    const GeoPos pos{latitude_deg * RAD, longitude_deg * RAD, altitude_m};
    const WindVec wind = getWind(pos, epoch, ap3h);
    out = json({
        {"model", std::string(windModelRelease()) + (ap3h >= 0.0 ? " quiet time + DWM07 disturbance" : " quiet time only")},
        {"northMps", wind.north},
        {"eastMps", wind.east},
        {"downMps", 0.0},
    });
    return {};
}

RequestStatus dispatch_operation(const std::string& operation, const json& params, json& out) {
    if (operation == "version") {
        out = json({{"version", version()}});
        return {};
    }
    if (operation == "queryAltitude") {
        return query_altitude_json(params, out);
    }
    if (operation == "queryAltitudes") {
        return query_altitudes_json(params, out);
    }
    if (operation == "queryAtmosphereStateBatch") {
        return query_atmosphere_state_batch_json(params, out);
    }
    if (operation == "queryWind") {
        return query_wind_json(params, out);
    }
    return request_error("unknown-operation", "Unknown atmosphere operation: " + operation);
}

}  // namespace

PluginInvokeResult invoke_json_request(std::string_view request_json) {
    const auto request = json::parse(request_json.begin(), request_json.end(), nullptr, false);
    if (request.is_discarded() || !request.is_object()) {
        return make_error_result("invalid-json", "Request is not a JSON object.");
    }
    if (!request.contains("operation") || !request.at("operation").is_string()) {
        return make_error_result("missing-operation", "Request operation must be a string.");
    }
    const auto operation = request.at("operation").get<std::string>();
    const json params = request.contains("params") && request.at("params").is_object()
        ? request.at("params")
        : json::object();

    json out;
    const auto status = dispatch_operation(operation, params, out);
    if (!status.ok) {
        return make_error_result(status.code, status.message);
    }
    PluginInvokeResult result{};
    result.ok = true;
    result.json = out.dump();
    return result;
}

}  // namespace atmosphere
