// SPDX-License-Identifier: Apache-2.0
//
// SDS PIV ABI wrapper for the OrbPro SGP4 propagator.
//
// The canonical public invoke entrypoint is `plugin_invoke_stream`, which
// consumes and returns SDS PIV envelopes. Method dispatch lives in
// sgp4_plugin.cpp so the invoke path can use the same native SGP4 helpers as
// the direct-call exports without introducing a second FlatBuffer request ABI.

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "plugin_manifest_bytes.h"
#include "space_data_module_invoke.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

extern "C" uint8_t* sgp4_dispatch_piv(
  const uint8_t* request_data,
  size_t request_size,
  uint32_t* response_size_out
);

extern "C" void __wasm_call_ctors(void);

namespace {

static uintptr_t PtrFromU32(uint32_t value) {
  return static_cast<uintptr_t>(value);
}

static uint8_t* MutablePtr(uint32_t value) {
  return reinterpret_cast<uint8_t*>(PtrFromU32(value));
}

static const uint8_t* ConstPtr(uint32_t value) {
  return reinterpret_cast<const uint8_t*>(PtrFromU32(value));
}

static uint32_t* MutableU32Ptr(uint32_t value) {
  return reinterpret_cast<uint32_t*>(PtrFromU32(value));
}

static bool ReadAllStdin(std::vector<uint8_t>* bytes_out) {
  if (!bytes_out) {
    return false;
  }
  bytes_out->clear();

  uint8_t buffer[4096];
  while (true) {
    const size_t read_count = std::fread(buffer, 1, sizeof(buffer), stdin);
    if (read_count > 0u) {
      bytes_out->insert(bytes_out->end(), buffer, buffer + read_count);
    }
    if (read_count < sizeof(buffer)) {
      if (std::ferror(stdin)) {
        return false;
      }
      break;
    }
  }
  return true;
}

static bool WriteAllStdout(const uint8_t* bytes, size_t length) {
  if (!bytes && length > 0u) {
    return false;
  }
  if (length == 0u) {
    return std::fflush(stdout) == 0;
  }
  return std::fwrite(bytes, 1, length, stdout) == length && std::fflush(stdout) == 0;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
void _initialize(void) {
  __wasm_call_ctors();
}

EMSCRIPTEN_KEEPALIVE
const uint8_t* plugin_get_manifest_flatbuffer(void) {
  return sgp4_plugin_manifest_bytes;
}

EMSCRIPTEN_KEEPALIVE
uint32_t plugin_get_manifest_flatbuffer_size(void) {
  return sgp4_plugin_manifest_bytes_len;
}

EMSCRIPTEN_KEEPALIVE
uint32_t plugin_get_input_count(void) {
  return 0;
}

EMSCRIPTEN_KEEPALIVE
const plugin_input_frame_t* plugin_get_input_frame(uint32_t index) {
  (void)index;
  return nullptr;
}

EMSCRIPTEN_KEEPALIVE
int32_t plugin_find_input_index(const char* port_id, uint32_t ordinal) {
  (void)port_id;
  (void)ordinal;
  return -1;
}

EMSCRIPTEN_KEEPALIVE
void plugin_reset_output_state(void) {}

EMSCRIPTEN_KEEPALIVE
int32_t plugin_push_output_typed(
    const char* port_id,
    const char* schema_name,
    const char* file_identifier,
    uint32_t wire_format,
    const char* root_type_name,
    uint16_t fixed_string_length,
    uint32_t byte_length,
    uint16_t required_alignment,
    const uint8_t* payload_ptr,
    uint32_t payload_length) {
  (void)port_id;
  (void)schema_name;
  (void)file_identifier;
  (void)wire_format;
  (void)root_type_name;
  (void)fixed_string_length;
  (void)byte_length;
  (void)required_alignment;
  (void)payload_ptr;
  (void)payload_length;
  return -1;
}

EMSCRIPTEN_KEEPALIVE
int32_t plugin_push_output(
    const char* port_id,
    const char* schema_name,
    const char* file_identifier,
    const uint8_t* payload_ptr,
    uint32_t payload_length) {
  return plugin_push_output_typed(
    port_id,
    schema_name,
    file_identifier,
    PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
    nullptr,
    0,
    payload_length,
    0,
    payload_ptr,
    payload_length
  );
}

EMSCRIPTEN_KEEPALIVE
int32_t plugin_push_output_ex(
    const char* port_id,
    const char* schema_name,
    const char* file_identifier,
    uint32_t wire_format,
    const char* root_type_name,
    uint16_t fixed_string_length,
    uint16_t required_alignment,
    const uint8_t* payload_ptr,
    uint32_t payload_length) {
  return plugin_push_output_typed(
    port_id,
    schema_name,
    file_identifier,
    wire_format,
    root_type_name,
    fixed_string_length,
    payload_length,
    required_alignment,
    payload_ptr,
    payload_length
  );
}

EMSCRIPTEN_KEEPALIVE
void plugin_set_yielded(int32_t yielded) {
  (void)yielded;
}

EMSCRIPTEN_KEEPALIVE
void plugin_set_backlog_remaining(uint32_t backlog_remaining) {
  (void)backlog_remaining;
}

EMSCRIPTEN_KEEPALIVE
void plugin_set_error(const char* error_code, const char* error_message) {
  (void)error_code;
  (void)error_message;
}

EMSCRIPTEN_KEEPALIVE
uint32_t plugin_alloc(uint32_t size) {
  const auto allocation_size = size > 0u ? size : 1u;
  void* ptr = std::malloc(allocation_size);
  return ptr ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(ptr)) : 0u;
}

EMSCRIPTEN_KEEPALIVE
void plugin_free(uint32_t ptr, uint32_t size) {
  (void)size;
  if (ptr != 0u) {
    std::free(reinterpret_cast<void*>(PtrFromU32(ptr)));
  }
}

EMSCRIPTEN_KEEPALIVE
uint32_t plugin_invoke_stream(
    uint32_t request_ptr,
    uint32_t request_len,
    uint32_t response_len_out_ptr) {
  if (response_len_out_ptr != 0u) {
    *MutableU32Ptr(response_len_out_ptr) = 0u;
  }

  uint32_t response_size = 0;
  uint8_t* response = sgp4_dispatch_piv(
    ConstPtr(request_ptr),
    static_cast<size_t>(request_len),
    &response_size
  );
  if (response_len_out_ptr != 0u) {
    *MutableU32Ptr(response_len_out_ptr) = response_size;
  }
  return response ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(response)) : 0u;
}

}  // extern "C"

int main(int argc, char** argv) {
  (void)argc;
  (void)argv;

  std::vector<uint8_t> stdin_bytes;
  if (!ReadAllStdin(&stdin_bytes) || stdin_bytes.empty()) {
    return 0;
  }

  uint32_t response_size = 0;
  uint8_t* response = sgp4_dispatch_piv(
    stdin_bytes.data(),
    stdin_bytes.size(),
    &response_size
  );
  const bool wrote = WriteAllStdout(response, response_size);
  if (response != nullptr) {
    std::free(response);
  }
  if (!wrote) {
    std::fprintf(stderr, "Failed to write stdout.\n");
    return 74;
  }
  return 0;
}
