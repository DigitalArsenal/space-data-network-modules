// Control frames follow hostcap/http-request; no network or physics in the host
// adapter.
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"
namespace eop_wire {
using Json = nlohmann::json;
struct Source {
  const char* name;
  const char* url;
  const char* format;
};
static const Source sources[] = {
    {"IERS finals2000A Bulletin A columns",
     "https://datacenter.iers.org/data/9/finals2000A.all", "finals2000a"},
    {"IERS EOP 20 C04",
     "https://hpiers.obspm.fr/iers/eop/eopc04/eopc04.1962-now", "c04"},
    {"Paris Observatory EOP 20 C04 legacy IAU2000 format",
     "https://hpiers.obspm.fr/iers/eop/eopc04/eopc04_IAU2000.62-now", "paris"}};
inline const plugin_input_frame_t* frame(const char* port) {
  int i = plugin_find_input_index(port, 0);
  return i < 0 ? nullptr : plugin_get_input_frame(i);
}
inline int error(const char* message) {
  plugin_set_error("invalid-eop-input", message);
  return 3;
}
inline bool unique_inputs() {
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    auto a = plugin_get_input_frame(i);
    for (uint32_t j = 0; j < i; ++j)
      if (std::strcmp(a->port_id, plugin_get_input_frame(j)->port_id) == 0)
        return false;
  }
  return true;
}
inline Json json(const plugin_input_frame_t* f) {
  if (!f || !f->payload) return Json::object();
  return Json::parse(f->payload, f->payload + f->payload_length, nullptr,
                     false);
}
inline int push(const char* port, const Json& value) {
  auto s = value.dump();
  return plugin_push_output_ex(
      port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,
      nullptr, 0, 1, reinterpret_cast<const uint8_t*>(s.data()), s.size());
}
}  // namespace eop_wire
