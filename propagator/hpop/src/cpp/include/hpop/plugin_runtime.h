#ifndef HPOP_PLUGIN_RUNTIME_H
#define HPOP_PLUGIN_RUNTIME_H

#include <string>
#include <string_view>

namespace hpop {

struct PluginInvokeResult {
    bool ok = false;
    std::string json;
    std::string error_code;
    std::string error_message;
};

PluginInvokeResult invoke_json_request(std::string_view request_json);

}  // namespace hpop

#endif  // HPOP_PLUGIN_RUNTIME_H
