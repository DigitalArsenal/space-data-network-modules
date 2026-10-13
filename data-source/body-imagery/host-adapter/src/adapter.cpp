#include "space_data_module_invoke.h"
#include <chrono>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
using Json = nlohmann::json;

// Host side of the body imagery retrieval flow: the flow's configuration
// (plugin.getConfig), the retrieval receipt (clock + producer), and adding the
// built imagery files to the node's IPFS through the existing "ipfs" host
// capability (ipfs.add, pinned). Range planning, DAF cutting and the $PNM
// records stay in the portable core.

extern "C" {
__attribute__((import_module("space_data_module_host"), import_name("call")))
int32_t imagery_host_call(const uint8_t*, int32_t, const uint8_t*, int32_t);
__attribute__((import_module("space_data_module_host"), import_name("response_len")))
int32_t imagery_response_len();
__attribute__((import_module("space_data_module_host"), import_name("read_response")))
int32_t imagery_read_response(uint8_t*, int32_t);
}

namespace {
constexpr size_t maxControlBytes = 8u * 1024u * 1024u;
constexpr size_t maxFileBytes = 64u * 1024u * 1024u;
int fail(const char* message) { plugin_set_error("body-imagery-host-adapter", message); return 1; }
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
Json json(const char* port) {
  const auto list = frames(port);
  if (list.size() != 1 || !list[0]->payload || list[0]->payload_length > maxControlBytes) return Json();
  return Json::parse(list[0]->payload, list[0]->payload + list[0]->payload_length, nullptr, false);
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
  imagery_host_call(reinterpret_cast<const uint8_t*>(op), int32_t(std::strlen(op)), request.data(), int32_t(request.size()));
  const int32_t responseLength = imagery_response_len();
  if (responseLength < 4) return Json();
  std::vector<uint8_t> bytes(static_cast<size_t>(responseLength));
  imagery_read_response(bytes.data(), responseLength);
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
bool enabled(const Json& cfg) { return cfg.is_object() && cfg.contains("body_imagery_enabled") && cfg["body_imagery_enabled"] == true; }

std::string b64(const uint8_t* p, size_t n) {
  static const char* t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string s;
  s.reserve((n + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 2 < n; i += 3) {
    const uint32_t v = uint32_t(p[i]) << 16 | uint32_t(p[i + 1]) << 8 | p[i + 2];
    s += t[v >> 18]; s += t[(v >> 12) & 63]; s += t[(v >> 6) & 63]; s += t[v & 63];
  }
  if (i + 1 == n) { const uint32_t v = uint32_t(p[i]) << 16; s += t[v >> 18]; s += t[(v >> 12) & 63]; s += "=="; }
  else if (i + 2 == n) { const uint32_t v = uint32_t(p[i]) << 16 | uint32_t(p[i + 1]) << 8; s += t[v >> 18]; s += t[(v >> 12) & 63]; s += t[(v >> 6) & 63]; s += '='; }
  return s;
}
}  // namespace

extern "C" int prepare_scheduled() {
  CHECK(plugin_get_input_count() == 1 && frames("tick").size() == 1, "Exactly one timer tick is required.");
  const auto cfg = configuration();
  CHECK(cfg.is_object(), "Host configuration unavailable.");
  if (!enabled(cfg)) return output("status", {{"skipped", "disabled"}}) < 0 ? 1 : 0;
  CHECK(text(cfg, "body_imagery_producer_peer_id") && !cfg["body_imagery_producer_peer_id"].get<std::string>().empty(),
        "Producer peer ID is required before fetching.");
  CHECK(cfg.contains("body_imagery_source") && cfg["body_imagery_source"].is_object(), "Imagery source configuration missing.");
  const auto& source = cfg["body_imagery_source"];
  CHECK(text(source, "access") && source["access"] == "anonymous", "NASA and USGS mosaics are anonymous public data; set body_imagery_source.access to anonymous.");
  return output("config", source) < 0 ? 1 : 0;
}

// file frames (u32 name length, name, bytes) -> one "added" frame each:
// {name, cid, bytes}. ipfs.add pins on the node's own Kubo.
extern "C" int publish_files() {
  const auto list = frames("file");
  CHECK(!list.empty(), "At least one imagery file is required.");
  for (const auto* f : list) {
    CHECK(f->payload && f->payload_length >= 4, "An imagery file frame is malformed.");
    uint32_t n;
    std::memcpy(&n, f->payload, 4);
    CHECK(n > 0 && n <= 128 && 4 + n <= f->payload_length, "An imagery file name is malformed.");
    const std::string name(reinterpret_cast<const char*>(f->payload + 4), n);
    const uint8_t* bytes = f->payload + 4 + n;
    const size_t length = f->payload_length - 4 - n;
    CHECK(length > 0 && length <= maxFileBytes, "An imagery file is empty or too large.");
    const Json result = hostcall("ipfs.add", Json({{"base64", b64(bytes, length)}}).dump());
    CHECK(result.is_object() && result.value("ok", false) == true, "ipfs.add refused an imagery file; nothing is announced.");
    const auto& r = result["result"];
    CHECK(text(r, "Hash"), "ipfs.add returned no CID.");
    CHECK(output("added", {{"name", name}, {"cid", r["Hash"]}, {"bytes", length}}) >= 0, "Could not emit an add result.");
  }
  return 0;
}

extern "C" int receipt_scheduled() {
  CHECK(frames("job").size() == 1, "Exactly one build job is required.");
  const auto cfg = configuration();
  CHECK(enabled(cfg) && text(cfg, "body_imagery_producer_peer_id"), "Producer configuration missing or disabled.");
  const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  CHECK(output("job", json("job")) >= 0 && output("receipt", {{"retrieved_at_ms", now}, {"producer_peer_id", cfg["body_imagery_producer_peer_id"]}}) >= 0,
        "Could not emit the receipt.");
  return 0;
}
