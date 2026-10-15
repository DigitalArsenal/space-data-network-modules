#ifndef MANEUVER_PLUGIN_RUNTIME_H
#define MANEUVER_PLUGIN_RUNTIME_H

#include "json_lite.h"

#include <string>

namespace maneuver {

struct PluginInvokeResult {
    bool ok = false;
    std::string json;
    std::string error_code;
    std::string error_message;
};

/// Run one named operation on an already-built parameter tree. `json` is the
/// operation's internal answer document (SI units), read back by mpl_bridge.
PluginInvokeResult invoke_operation(const std::string& operation,
                                    const json_lite::Value& params);

/// The module version, equal to plugin-manifest.json's `version`.
const char* module_version();

}  // namespace maneuver

#endif  // MANEUVER_PLUGIN_RUNTIME_H
