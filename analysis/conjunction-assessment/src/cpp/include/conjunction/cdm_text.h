#pragma once
#include <string>
namespace conjunction {
// Normalize module algorithm labels only. Received standard CDMs keep their
// original method names, including genuine externally calculated PATERA-2001.
std::string cdm_probability_method_name(const std::string& module_method);
// The module's own method name for a name this module writes (the inverse above).
std::string cdm_internal_probability_method_name(const std::string& cdm_method);
}
