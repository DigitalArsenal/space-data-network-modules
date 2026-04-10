#ifndef MANEUVER_PLUGIN_RUNTIME_H
#define MANEUVER_PLUGIN_RUNTIME_H

#include <string>
#include <string_view>

namespace maneuver {

struct PluginInvokeResult {
    bool ok = false;
    std::string json;
    std::string error_code;
    std::string error_message;
};

PluginInvokeResult invoke_json_request(std::string_view request_json);

}  // namespace maneuver

#endif  // MANEUVER_PLUGIN_RUNTIME_H
