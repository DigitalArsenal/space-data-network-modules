#ifndef OD_PLUGIN_RUNTIME_H
#define OD_PLUGIN_RUNTIME_H

#include <string>
#include <string_view>

namespace od {

struct PluginFitResult {
    bool ok = false;
    std::string json;
    std::string error_code;
    std::string error_message;
};

PluginFitResult fit_meme_payload(
    std::string_view meme_content,
    std::string_view options_json = {});

}  // namespace od

#endif  // OD_PLUGIN_RUNTIME_H
