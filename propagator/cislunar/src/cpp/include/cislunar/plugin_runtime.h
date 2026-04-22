#ifndef CISLUNAR_PLUGIN_RUNTIME_H
#define CISLUNAR_PLUGIN_RUNTIME_H

#include <string>
#include <string_view>

namespace cislunar {

struct PluginInvokeResult {
    bool ok = false;
    std::string json;
    std::string error_code;
    std::string error_message;
};

PluginInvokeResult invoke_json_request(std::string_view request_json);

}  // namespace cislunar

#endif  // CISLUNAR_PLUGIN_RUNTIME_H
