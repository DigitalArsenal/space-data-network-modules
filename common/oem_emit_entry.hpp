// Shared guest-link EMIT helper for OD-flow data-source nodes.
//
// Every provider source (spacex-starlink / glonass / intelsat / cpf / iss) has a
// `std::string run_pull(const uint8_t*, uint32_t)` that fetches (via ps::http_get
// over the sdm_host_call boundary), parses its native format, builds a
// non-size-prefixed SDS $OEM per object, and returns them as an in-memory framed
// stream: [u32le count] then count x ( [u32le len][$OEM] ). This helper decodes
// that stream and pushes each $OEM as an ALIGNED_BINARY frame on the "oem" output
// port — turning any provider into a flow guest-link node whose emit reuses the
// provider's fetch/parse verbatim.
//
// Fetch (ps::http_get) and the emit ABI (plugin_push_output_ex) stay UNDEFINED
// here — bake-resolved. $OEM is in-memory only; nothing is stored, signed, or
// published (the OD-flow invariant).
#ifndef SDN_OEM_EMIT_ENTRY_HPP
#define SDN_OEM_EMIT_ENTRY_HPP

#include <cstddef>
#include <cstdint>
#include <string>

// Minimal guest-link emit/consume ABI (a SUBSET of space_data_module_invoke.h).
// Declared locally — NOT via that header — so this TU does not pull in the
// header's plugin_alloc/plugin_free/plugin_invoke_stream declarations, which each
// provider .cpp already DEFINES with its own (different) signatures. The frame
// struct MUST match the real ABI layout byte-for-byte (payload/payload_length are
// near the end). These symbols stay UNDEFINED in the object — bake-resolved.
extern "C" {
enum { PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY = 1 };
typedef struct plugin_input_frame_t {
  const char* port_id;
  const char* schema_name;
  const char* file_identifier;
  uint32_t wire_format;
  const char* root_type_name;
  uint16_t fixed_string_length;
  uint32_t byte_length;
  uint16_t required_alignment;
  uint16_t alignment;
  uint32_t size;
  uint32_t generation;
  uint64_t trace_id;
  uint32_t stream_id;
  uint64_t sequence;
  int32_t end_of_stream;
  const uint8_t* payload;
  uint32_t payload_length;
} plugin_input_frame_t;
const plugin_input_frame_t* plugin_get_input_frame(uint32_t index);
int32_t plugin_find_input_index(const char* port_id, uint32_t ordinal);
void plugin_reset_output_state(void);
int32_t plugin_push_output_ex(const char* port_id, const char* schema_name,
                              const char* file_identifier, uint32_t wire_format,
                              const char* root_type_name, uint16_t fixed_string_length,
                              uint16_t required_alignment, const uint8_t* payload_ptr,
                              uint32_t payload_length);
void plugin_set_error(const char* error_code, const char* error_message);
}  // extern "C"

namespace od_flow {

inline uint32_t rd_u32le(const std::string& s, std::size_t at) {
  return static_cast<uint32_t>(static_cast<uint8_t>(s[at])) |
         (static_cast<uint32_t>(static_cast<uint8_t>(s[at + 1])) << 8) |
         (static_cast<uint32_t>(static_cast<uint8_t>(s[at + 2])) << 16) |
         (static_cast<uint32_t>(static_cast<uint8_t>(s[at + 3])) << 24);
}

// Run a provider's fetch+parse and emit each produced $OEM on the "oem" port.
inline int emit_via(std::string (*run_pull)(const uint8_t*, uint32_t)) {
  plugin_reset_output_state();

  // Optional per-node CONFIG (endpoints / target / objectCap / offset / count)
  // from a "config" input frame — the flow node's CONFIG. Default provider
  // endpoints when absent.
  const uint8_t* cfg = nullptr;
  uint32_t clen = 0;
  int32_t ci = plugin_find_input_index("config", 0);
  if (ci >= 0) {
    const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(ci));
    if (f != nullptr && f->payload != nullptr && f->payload_length != 0) {
      cfg = f->payload;
      clen = f->payload_length;
    }
  }

  const std::string s = run_pull(cfg, clen);
  if (s.size() < 4) {
    plugin_set_error("fetch-empty", "provider produced no $OEM stream");
    return 1;
  }

  const uint32_t count = rd_u32le(s, 0);
  std::size_t off = 4;
  uint32_t emitted = 0;
  for (uint32_t i = 0; i < count; ++i) {
    if (off + 4 > s.size()) break;
    const uint32_t len = rd_u32le(s, off);
    off += 4;
    if (len == 0 || off + len > s.size()) break;
    const int32_t rc = plugin_push_output_ex(
        "oem", "OEM.fbs", "$OEM", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "OEM",
        /*fixed_string_length=*/0, /*required_alignment=*/8,
        reinterpret_cast<const uint8_t*>(s.data()) + off, len);
    off += len;
    if (rc < 0) return rc;
    ++emitted;
  }
  if (emitted == 0) {
    plugin_set_error("fetch-empty", "no fittable $OEM objects from provider");
    return 1;
  }
  return 0;
}

}  // namespace od_flow

#endif  // SDN_OEM_EMIT_ENTRY_HPP
