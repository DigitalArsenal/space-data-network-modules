#ifndef CONJUNCTION_PLUGIN_RUNTIME_H
#define CONJUNCTION_PLUGIN_RUNTIME_H

#include <string>
#include <string_view>

namespace conjunction {

struct PluginInvokeResult {
    bool ok = false;
    std::string json;
    std::string error_code;
    std::string error_message;
};

PluginInvokeResult invoke_json_request(std::string_view request_json);

}  // namespace conjunction

#endif  // CONJUNCTION_PLUGIN_RUNTIME_H
