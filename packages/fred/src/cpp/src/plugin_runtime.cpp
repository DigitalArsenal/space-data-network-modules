#include "fred/plugin_runtime.h"

#include "fred/types.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <stdexcept>
#include <string>

namespace fred {

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

json record_to_json(const Record& record) {
    return {
        {"timestamp", record.timestamp},
        {"latitude", record.latitude},
        {"longitude", record.longitude},
        {"value", record.value},
        {"sourceId", record.source_id},
        {"category", record.category},
        {"description", record.description},
    };
}

std::string validate_json_payload(const json& params) {
    const auto input = params.at("input").get<std::string>();
    return json({
        {"valid", validate(input)},
    }).dump();
}

std::string parse_json_payload(const json& params) {
    const auto input = params.at("input").get<std::string>();
    const auto dataset = parse_json(input);
    json output{};
    output["version"] = dataset.version;
    output["fetchTimestamp"] = dataset.fetch_timestamp;
    output["recordCount"] = dataset.records.size();
    output["records"] = json::array();
    const size_t limit = std::min<size_t>(dataset.records.size(), 3);
    for (size_t index = 0; index < limit; ++index) {
        output["records"].push_back(record_to_json(dataset.records[index]));
    }
    return output.dump();
}

std::string dispatch_operation(const std::string& operation, const json& params) {
    if (operation == "version") {
        return json({{"version", version()}}).dump();
    }
    if (operation == "validate") {
        return validate_json_payload(params);
    }
    if (operation == "parseJson") {
        return parse_json_payload(params);
    }

    throw std::runtime_error("Unknown fred operation: " + operation);
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

}  // namespace fred
