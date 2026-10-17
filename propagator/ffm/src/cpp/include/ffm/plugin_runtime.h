#ifndef FFM_PLUGIN_RUNTIME_H
#define FFM_PLUGIN_RUNTIME_H

#include <string>
#include <string_view>

namespace ffm {

struct PluginInvokeResult {
    bool ok = false;
    std::string json;
    std::string error_code;
    std::string error_message;
};

PluginInvokeResult invoke_json_request(std::string_view request_json);

}  // namespace ffm

#endif  // FFM_PLUGIN_RUNTIME_H
