#ifndef SGP4_PROP_PLUGIN_RUNTIME_H
#define SGP4_PROP_PLUGIN_RUNTIME_H

#include <string>
#include <string_view>

namespace sgp4_prop {

struct PluginInvokeResult {
    bool ok = false;
    std::string json;
    std::string error_code;
    std::string error_message;
};

PluginInvokeResult invoke_json_request(std::string_view request_json);

}  // namespace sgp4_prop

#endif  // SGP4_PROP_PLUGIN_RUNTIME_H
