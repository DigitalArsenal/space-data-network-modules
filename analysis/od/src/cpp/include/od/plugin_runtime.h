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

/// Fit SupGP/OMM elements from an ephemeris payload. Format is selected by the
/// `inputFormat` option ("meme" | "oem"), or auto-detected from the content.
/// `data_source`, `objectName` and `objectId` may be supplied via the options
/// JSON to label the output (the module never hardcodes an operator). Keeps the
/// module ABI unchanged: format selection is data-level, not a new method/port.
PluginFitResult fit_ephemeris_payload(
    std::string_view ephemeris_content,
    std::string_view options_json = {});

}  // namespace od

#endif  // OD_PLUGIN_RUNTIME_H
