#include "space_data_module_invoke.h"
#include <chrono>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
using Json = nlohmann::json;

// Host side of the site-registry flow: the flow's configuration
// (plugin.getConfig) and the run's start time and producer, read once when
// the timer fires, so every stage of the run cites the same time and the
// output of a run is determined by its answers alone. Parsing, the rules and
// the records stay in the portable module.

extern "C" {
__attribute__((import_module("space_data_module_host"), import_name("call")))
int32_t sr_host_call(const uint8_t*, int32_t, const uint8_t*, int32_t);
__attribute__((import_module("space_data_module_host"), import_name("response_len")))
int32_t sr_response_len();
__attribute__((import_module("space_data_module_host"), import_name("read_response")))
int32_t sr_read_response(uint8_t*, int32_t);
}

namespace {
int fail(const char* message) { plugin_set_error("site-registry-host-adapter", message); return 1; }
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
  sr_host_call(reinterpret_cast<const uint8_t*>(op), int32_t(std::strlen(op)), request.data(), int32_t(request.size()));
  const int32_t length = sr_response_len();
  if (length < 4) return Json();
  std::vector<uint8_t> bytes(static_cast<size_t>(length));
  sr_read_response(bytes.data(), length);
  uint32_t size;
  std::memcpy(&size, bytes.data(), 4);
  if (size > bytes.size() - 4) return Json();
  return Json::parse(bytes.data() + 4, bytes.data() + 4 + size, nullptr, false);
}
Json configuration() {
  const Json result = hostcall("plugin.getConfig", "{}");
  if (!result.is_object() || (result.contains("ok") && result["ok"] != true)) return Json();
  return result.contains("result") ? result["result"] : result;
}
}  // namespace

extern "C" int prepare_scheduled() {
  CHECK(plugin_get_input_count() == 1 && frames("tick").size() == 1, "Exactly one timer tick is required.");
  const auto cfg = configuration();
  CHECK(cfg.is_object(), "Host configuration unavailable.");
  if (!(cfg.contains("site_registry_enabled") && cfg["site_registry_enabled"] == true)) return output("status", {{"skipped", "disabled"}}) < 0 ? 1 : 0;
  CHECK(text(cfg, "site_registry_producer_peer_id") && !cfg["site_registry_producer_peer_id"].get<std::string>().empty(), "Producer peer ID is required before fetching.");
  CHECK(cfg.contains("site_registry_source") && cfg["site_registry_source"].is_object(), "Site registry source configuration missing.");
  Json source = cfg["site_registry_source"];
  CHECK(text(source, "access") && source["access"] == "anonymous", "The site registry reads public sources only; set site_registry_source.access to anonymous.");
  const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  source["run_at_ms"] = now;
  source["producer_peer_id"] = cfg["site_registry_producer_peer_id"];
  return output("config", source) < 0 ? 1 : 0;
}
