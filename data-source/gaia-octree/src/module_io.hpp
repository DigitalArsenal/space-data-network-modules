// Frames in and out of a method: errors, control frames and typed SDS outputs.
#pragma once
#include <chrono>
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

// A FlowNotice (sdn.runtime, "FNTC") on a control port: flow bookkeeping, never a data record.
int notice(const char* port, sdn::runtime::flowNoticeKind kind, const std::string& source, uint64_t count, const std::string& reason,
           std::vector<std::string> items = {}) {
  sdn::runtime::FlowNoticeT n;
  n.KIND = kind;
  n.SCHEMA = "SKT.fbs";
  n.PROVIDER_ID = "gaia-dr3";
  n.SOURCE_NAME = source;
  n.COUNT = count;
  n.REASON = reason;
  n.ITEMS = std::move(items);
  n.AT_MS = uint64_t(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
  flatbuffers::FlatBufferBuilder b(512);
  sdn::runtime::FinishFlowNoticeBuffer(b, sdn::runtime::FlowNotice::Pack(b, &n));
  return plugin_push_output_ex(port, "FlowNotice.fbs", sdn::runtime::FlowNoticeIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "FlowNotice", 0, 0,
                               b.GetBufferPointer(), b.GetSize()) < 0 ? 1 : 0;
}

int typed(const char* port, const char* schema, const char* ident, const char* root, const std::vector<uint8_t>& bytes) {
  if (bytes.empty()) return 0;
  return plugin_push_output_ex(port, schema, ident, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, bytes.data(), bytes.size()) < 0 ? 1 : 0;
}

}  // namespace
