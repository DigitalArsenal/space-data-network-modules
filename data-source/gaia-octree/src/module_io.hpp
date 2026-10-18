// Frames in and out of a method: errors, control frames and typed SDS outputs.
#pragma once
#include <cstring>
#include <string>
#include <vector>

namespace {
constexpr const char* kModule = "gaia-octree";

int fail(const std::string& message) { plugin_set_error(kModule, message.c_str()); return 1; }

size_t framesOn(const char* port) {
  size_t n = 0;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (f && f->port_id && std::strcmp(f->port_id, port) == 0) ++n;
  }
  return n;
}

int control(const char* port, const std::string& json) {
  return plugin_push_output_ex(port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                               reinterpret_cast<const uint8_t*>(json.data()), json.size()) < 0 ? 1 : 0;
}

int typed(const char* port, const char* schema, const char* ident, const char* root, const std::vector<uint8_t>& bytes) {
  if (bytes.empty()) return 0;
  return plugin_push_output_ex(port, schema, ident, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, bytes.data(), bytes.size()) < 0 ? 1 : 0;
}

}  // namespace
