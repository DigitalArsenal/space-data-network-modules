#include "space_data_module_invoke.h"
#include <chrono>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
using Json = nlohmann::json;

// Host side of the 3D dust map retrieval flow: the flow's configuration
// (plugin.getConfig; keys dust_map_3d_enabled, dust_map_3d_producer_peer_id,
// dust_map_3d_source) and the retrieval receipt (clock + producer). Range
// planning, resampling and the $PCE rows stay in the portable core; the node's
// storage ingest and auto-publisher announce the rows.

extern "C" {
__attribute__((import_module("space_data_module_host"), import_name("call")))
int32_t dust_host_call(const uint8_t*, int32_t, const uint8_t*, int32_t);
__attribute__((import_module("space_data_module_host"), import_name("response_len")))
int32_t dust_response_len();
__attribute__((import_module("space_data_module_host"), import_name("read_response")))
int32_t dust_read_response(uint8_t*, int32_t);
}

namespace {
constexpr size_t maxControlBytes = 1u << 20;
int fail(const char* message) { plugin_set_error("dust-map-3d-host-adapter", message); return 1; }
#define CHECK(condition, message) do { if (!(condition)) return fail(message); } while (0)
bool text(const Json& j, const char* key) { return j.is_object() && j.contains(key) && j[key].is_string(); }

std::vector<const plugin_input_frame_t*> frames(const char* port) {
  std::vector<const plugin_input_frame_t*> out;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (f && f->port_id && std::strcmp(f->port_id, port) == 0) out.push_back(f);
  }
  return out;
}
int output(const char* port, const Json& j) {
  const auto bytes = j.dump();
  return plugin_push_output_ex(port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                               reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size());
}
// One host call: [u32 meta length][meta JSON][u32 0 segments] -> [u32 n][JSON].
Json hostcall(const char* op, const std::string& meta) {
  std::vector<uint8_t> request(4 + meta.size() + 4, 0);
  const uint32_t n = uint32_t(meta.size());
  std::memcpy(request.data(), &n, 4);
  std::memcpy(request.data() + 4, meta.data(), meta.size());
  dust_host_call(reinterpret_cast<const uint8_t*>(op), int32_t(std::strlen(op)), request.data(), int32_t(request.size()));
  const int32_t responseLength = dust_response_len();
  if (responseLength < 4 || size_t(responseLength) > maxControlBytes) return Json();
  std::vector<uint8_t> bytes(static_cast<size_t>(responseLength));
  dust_read_response(bytes.data(), responseLength);
  uint32_t length;
  std::memcpy(&length, bytes.data(), 4);
  if (length > bytes.size() - 4) return Json();
  return Json::parse(bytes.data() + 4, bytes.data() + 4 + length, nullptr, false);
}
Json configuration() {
  const Json result = hostcall("plugin.getConfig", "{}");
  if (!result.is_object() || (result.contains("ok") && result["ok"] != true)) return Json();
  return result.contains("result") ? result["result"] : result;
}
bool enabled(const Json& cfg) { return cfg.is_object() && cfg.contains("dust_map_3d_enabled") && cfg["dust_map_3d_enabled"] == true; }
}  // namespace

extern "C" int prepare_scheduled() {
  CHECK(plugin_get_input_count() == 1 && frames("tick").size() == 1, "Exactly one timer tick is required.");
  const auto cfg = configuration();
  CHECK(cfg.is_object(), "Host configuration unavailable.");
  if (!enabled(cfg)) return output("status", {{"skipped", "disabled"}}) < 0 ? 1 : 0;
  CHECK(text(cfg, "dust_map_3d_producer_peer_id") && !cfg["dust_map_3d_producer_peer_id"].get<std::string>().empty(),
        "Producer peer ID is required before fetching.");
  CHECK(cfg.contains("dust_map_3d_source") && cfg["dust_map_3d_source"].is_object(), "3D dust source configuration missing.");
  const auto& source = cfg["dust_map_3d_source"];
  CHECK(text(source, "access") && source["access"] == "anonymous",
        "The Edenhofer et al. 2024 map is anonymous public data (CC BY 4.0); set dust_map_3d_source.access to anonymous.");
  return output("config", source) < 0 ? 1 : 0;
}

// The cycle's configuration -> its receipt: retrieved_at_ms and this node's peer ID.
extern "C" int receipt_scheduled() {
  CHECK(frames("config").size() == 1, "Exactly one cycle configuration is required.");
  const auto cfg = configuration();
  CHECK(enabled(cfg) && text(cfg, "dust_map_3d_producer_peer_id"), "Producer configuration missing or disabled.");
  const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  return output("receipt", {{"retrieved_at_ms", now}, {"producer_peer_id", cfg["dust_map_3d_producer_peer_id"]}}) < 0 ? 1 : 0;
}
