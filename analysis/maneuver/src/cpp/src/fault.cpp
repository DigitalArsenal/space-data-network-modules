#include "maneuver/fault.h"

#include <utility>

namespace maneuver {
namespace fault {
namespace {

bool g_raised = false;
const char* g_code = "";
std::string g_message;

}  // namespace

void reset() {
    g_raised = false;
    g_code = "";
    g_message.clear();
}

void raise(const char* code, std::string message) {
    if (g_raised) {
        // First raise wins: the deepest cause, not the last symptom.
        return;
    }
    g_raised = true;
    g_code = (code != nullptr) ? code : fault_code::INVALID_PARAMETER;
    g_message = std::move(message);
}

bool raised() { return g_raised; }

const char* code() { return g_code; }

const std::string& message() { return g_message; }

}  // namespace fault
}  // namespace maneuver
