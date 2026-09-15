#ifndef CONJUNCTION_ERROR_STATUS_H
#define CONJUNCTION_ERROR_STATUS_H

#include <string>
#include <cstdio>

namespace conjunction {
// The canonical WASI threads profile has no C++ exception runtime. Each worker
// owns its status; public invokes clear it on entry and check it before emitting
// scientific output. Preserve the first cause until explicitly consumed.
inline thread_local char evaluation_error[1024] = {};
inline void set_error(const std::string& message) {
    if (!evaluation_error[0]) std::snprintf(evaluation_error, sizeof(evaluation_error), "%s", message.c_str());
}
inline bool has_error() { return evaluation_error[0] != 0; }
inline const char* error_message() { return evaluation_error; }
inline void clear_error() { evaluation_error[0] = 0; }
} // namespace conjunction

#endif
