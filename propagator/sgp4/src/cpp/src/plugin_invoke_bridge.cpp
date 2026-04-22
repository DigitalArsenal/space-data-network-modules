// SPDX-License-Identifier: Apache-2.0
//
// SDK 0.8.0 invoke bridge for the OrbPro SGP4 propagator.
//
// This file implements the canonical space-data-module-sdk 0.8.0 invoke
// surface (`plugin_invoke_stream`, `plugin_get_input_frame`,
// `plugin_push_output_typed`, etc.) and dispatches SDK requests onto the
// OrbPro sgp4 plugin's native `plugin_stream_invoke` entrypoint.
//
// Method routing mirrors OrbPro's native manifest: ingest_omm, upsert_cat,
// propagate_state, propagate_path, catalog_query.
//
// For each SDK invoke:
//   1. Parse the incoming SDK PluginInvokeRequest
//   2. Materialize each input frame's payload into plugin-owned memory
//      (so its address is a valid wasm pointer)
//   3. Rebuild the inputs as an OrbPro StreamInvokeRequest where each
//      TypedArenaBuffer.offset carries the raw pointer address
//   4. Call OrbPro's `plugin_stream_invoke`
//   5. Parse the returned OrbPro StreamInvokeResponse, read each output
//      payload from its pointer, and emit as SDK output frames through
//      `plugin_push_output_typed`
//
// The thick direct-call exports (plugin_init, plugin_propagate, …) already
// emitted by sgp4_plugin.cpp continue to be exposed unmodified for the
// OrbPro JS runtime, which drives them via cwrap/ccall.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <flatbuffers/flatbuffers.h>

#include "PluginInvokeRequest_generated.h"
#include "PluginInvokeResponse_generated.h"
#include "TypedArenaBuffer_generated.h"
#include "PluginMessage_generated.h"
#include "plugin_manifest_bytes.h"
#include "space_data_module_invoke.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

// Thin C surface into the native OrbPro sgp4 plugin.
extern "C" uint8_t* plugin_stream_invoke(
  const uint8_t* request_data,
  size_t request_size,
  uint32_t* response_size_out
);

// wasm-ld emits `__wasm_call_ctors` to run the LLVM global initializers. The
// Emscripten `_start` entry point calls it before `main()`, but the SDK 0.8.0
// browser harness uses the WASI "reactor" convention and instead calls an
// exported `_initialize` once after instantiation. We bridge the two by
// exposing our own `_initialize` that delegates to the linker-generated
// constructor chain. The ctor chain is idempotent-safe to call twice because
// wasm-ld wraps it with a one-shot guard, so it's harmless if both surfaces
// wind up invoked.
extern "C" void __wasm_call_ctors(void);

namespace {

struct PortRequirement {
  const char* port_id;
  bool required;
};

struct MethodDescriptor {
  const char* method_id;                        // SDK & OrbPro method id (identical)
  const PortRequirement* input_ports;
  size_t input_port_count;
  const char* const* output_ports;
  size_t output_port_count;
  const char* output_schema_name;               // emitted on every output frame
  const char* output_file_identifier;           // emitted on every output frame
  const char* output_root_type_name;            // emitted on every output frame
  uint16_t output_required_alignment;
  uint32_t output_wire_format;                  // orbpro::stream::PayloadWireFormat
};

struct InputFrameOwned {
  plugin_input_frame_t view{};
  std::string port_id{};
  std::string schema_name{};
  std::string file_identifier{};
  std::string root_type_name{};
  std::vector<uint8_t> payload{};
};

struct OutputFrameOwned {
  std::string port_id{};
  std::string schema_name{};
  std::string file_identifier{};
  std::string root_type_name{};
  uint32_t wire_format = 0;
  uint16_t fixed_string_length = 0;
  uint32_t byte_length = 0;
  uint16_t required_alignment = 0;
  uint16_t alignment = 8;
  uint32_t generation = 0;
  uint64_t trace_id = 0;
  uint32_t stream_id = 0;
  uint64_t sequence = 0;
  bool end_of_stream = false;
  std::vector<uint8_t> payload{};
};

struct InvokeContext {
  const MethodDescriptor* method = nullptr;
  std::vector<InputFrameOwned> inputs{};
  std::vector<OutputFrameOwned> outputs{};
  uint32_t backlog_remaining = 0;
  bool yielded = false;
  int32_t status_code = 0;
  std::string error_code{};
  std::string error_message{};
};

// Port requirement tables ------------------------------------------------------

static const PortRequirement kMethod_ingest_omm_input_ports[] = {
  { "omm", true },
};
static const char* const kMethod_ingest_omm_output_ports[] = {};

static const PortRequirement kMethod_upsert_cat_input_ports[] = {
  { "catalog", true },
};
static const char* const kMethod_upsert_cat_output_ports[] = {};

static const PortRequirement kMethod_propagate_state_input_ports[] = {
  { "request", true },
};
static const char* const kMethod_propagate_state_output_ports[] = {
  "state",
};

static const PortRequirement kMethod_propagate_path_input_ports[] = {
  { "request", true },
};
static const char* const kMethod_propagate_path_output_ports[] = {
  "samples",
};

static const PortRequirement kMethod_catalog_query_input_ports[] = {
  { "request", true },
};
static const char* const kMethod_catalog_query_output_ports[] = {
  "results",
};

static const MethodDescriptor kMethodTable[] = {
  {
    "ingest_omm",
    kMethod_ingest_omm_input_ports,
    1u,
    nullptr,
    0u,
    "",
    "",
    "",
    0u,
    static_cast<uint32_t>(orbpro::stream::PayloadWireFormat_Flatbuffer),
  },
  {
    "upsert_cat",
    kMethod_upsert_cat_input_ports,
    1u,
    nullptr,
    0u,
    "",
    "",
    "",
    0u,
    static_cast<uint32_t>(orbpro::stream::PayloadWireFormat_Flatbuffer),
  },
  {
    "propagate_state",
    kMethod_propagate_state_input_ports,
    1u,
    kMethod_propagate_state_output_ports,
    1u,
    "orbpro.plugins.PropagatorState",
    "PRST",
    "PropagatorState",
    8u,
    static_cast<uint32_t>(orbpro::stream::PayloadWireFormat_AlignedBinary),
  },
  {
    "propagate_path",
    kMethod_propagate_path_input_ports,
    1u,
    kMethod_propagate_path_output_ports,
    1u,
    "orbpro.flatbuffer.any",
    "",
    "",
    8u,
    static_cast<uint32_t>(orbpro::stream::PayloadWireFormat_AlignedBinary),
  },
  {
    "catalog_query",
    kMethod_catalog_query_input_ports,
    1u,
    kMethod_catalog_query_output_ports,
    1u,
    "orbpro.query.CatalogQueryResult",
    "CQRS",
    "CatalogQueryResult",
    8u,
    static_cast<uint32_t>(orbpro::stream::PayloadWireFormat_AlignedBinary),
  },
};

static InvokeContext g_invoke_context;

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

static const MethodDescriptor* FindMethod(std::string_view method_id) {
  for (const auto& method : kMethodTable) {
    if (method_id == method.method_id) {
      return &method;
    }
  }
  return nullptr;
}

static bool MethodDeclaresOutputPort(const MethodDescriptor* method,
                                     const char* port_id) {
  if (!method || !port_id || !port_id[0]) {
    return false;
  }
  for (size_t index = 0; index < method->output_port_count; index += 1) {
    if (std::strcmp(method->output_ports[index], port_id) == 0) {
      return true;
    }
  }
  return false;
}

static void ResetInvokeContext(const MethodDescriptor* method) {
  g_invoke_context = InvokeContext{};
  g_invoke_context.method = method;
}

static void SetError(const char* code, const std::string& message) {
  g_invoke_context.error_code = code ? code : "invoke-error";
  g_invoke_context.error_message = message;
}

static std::string ReadCString(const char* value) {
  return value ? std::string(value) : std::string();
}

static uint32_t AlignOffset(uint32_t offset, uint32_t alignment) {
  if (alignment <= 1u) {
    return offset;
  }
  const uint32_t remainder = offset % alignment;
  return remainder == 0u ? offset : offset + alignment - remainder;
}

static bool LoadInputsFromRequest(
    const orbpro::invoke::PluginInvokeRequestT& request) {
  g_invoke_context.inputs.clear();
  g_invoke_context.inputs.reserve(request.input_frames.size());

  for (const auto& frame_ptr : request.input_frames) {
    if (!frame_ptr) {
      continue;
    }

    const auto& frame = *frame_ptr;
    const auto payload_offset = static_cast<size_t>(frame.offset);
    const auto payload_size = static_cast<size_t>(frame.size);
    if (payload_offset + payload_size > request.payload_arena.size()) {
      SetError("invalid-request-frame",
               "Input frame payload range exceeds request payload arena.");
      return false;
    }

    g_invoke_context.inputs.emplace_back();
    auto& owned = g_invoke_context.inputs.back();
    owned = InputFrameOwned{};
    owned.port_id = frame.port_id;
    if (frame.type_ref) {
      owned.schema_name = frame.type_ref->schema_name;
      owned.file_identifier = frame.type_ref->file_identifier;
      owned.root_type_name = frame.type_ref->root_type_name;
    }
    owned.payload.insert(
      owned.payload.end(),
      request.payload_arena.begin() + static_cast<std::ptrdiff_t>(payload_offset),
      request.payload_arena.begin() + static_cast<std::ptrdiff_t>(payload_offset + payload_size)
    );

    owned.view.port_id = owned.port_id.empty() ? nullptr : owned.port_id.c_str();
    owned.view.schema_name = owned.schema_name.empty() ? nullptr : owned.schema_name.c_str();
    owned.view.file_identifier = owned.file_identifier.empty() ? nullptr : owned.file_identifier.c_str();
    owned.view.wire_format =
      frame.type_ref
        ? static_cast<uint32_t>(frame.type_ref->wire_format)
        : static_cast<uint32_t>(orbpro::stream::PayloadWireFormat_Flatbuffer);
    owned.view.root_type_name = owned.root_type_name.empty() ? nullptr : owned.root_type_name.c_str();
    owned.view.fixed_string_length = frame.type_ref ? frame.type_ref->fixed_string_length : 0;
    owned.view.byte_length = frame.type_ref ? frame.type_ref->byte_length : static_cast<uint32_t>(payload_size);
    owned.view.required_alignment = frame.type_ref ? frame.type_ref->required_alignment : 0;
    owned.view.alignment = frame.alignment;
    owned.view.size = frame.size;
    owned.view.generation = frame.generation;
    owned.view.trace_id = frame.trace_id;
    owned.view.stream_id = frame.stream_id;
    owned.view.sequence = frame.sequence;
    owned.view.end_of_stream = frame.end_of_stream ? 1 : 0;
    owned.view.payload = owned.payload.empty() ? nullptr : owned.payload.data();
    owned.view.payload_length = static_cast<uint32_t>(owned.payload.size());
  }

  return true;
}

static bool ValidateRequiredInputs(const MethodDescriptor* method) {
  if (!method) {
    return false;
  }
  for (size_t port_index = 0; port_index < method->input_port_count; port_index += 1) {
    const auto& port = method->input_ports[port_index];
    if (!port.required) {
      continue;
    }
    bool present = false;
    for (const auto& frame : g_invoke_context.inputs) {
      if (frame.port_id == port.port_id) {
        present = true;
        break;
      }
    }
    if (!present) {
      SetError(
        "missing-required-input",
        std::string("Missing required input port: ") + port.port_id
      );
      return false;
    }
  }
  return true;
}

// Forwards the loaded SDK inputs to the native OrbPro stream invoke and
// emits outputs through plugin_push_output_typed.
static int32_t DispatchToOrbProStreamInvoke(const MethodDescriptor* method) {
  // 1. Build the native OrbPro StreamInvokeRequest carrying pointer offsets
  //    into the loaded SDK input payload buffers.
  flatbuffers::FlatBufferBuilder builder(1024);
  const auto method_id_offset = builder.CreateString(method->method_id);

  std::vector<flatbuffers::Offset<orbpro::stream::TypedArenaBuffer>> native_inputs;
  native_inputs.reserve(g_invoke_context.inputs.size());

  for (const auto& input : g_invoke_context.inputs) {
    const uint32_t byte_length = static_cast<uint32_t>(input.payload.size());
    const uint32_t required_alignment =
      input.view.required_alignment > 0 ? input.view.required_alignment : 8;
    const uint32_t wire_format = input.view.wire_format;

    const auto type_ref = orbpro::stream::CreateFlatBufferTypeRefDirect(
      builder,
      input.schema_name.empty() ? nullptr : input.schema_name.c_str(),
      input.file_identifier.empty() ? nullptr : input.file_identifier.c_str(),
      nullptr,
      input.schema_name.empty(),
      static_cast<orbpro::stream::PayloadWireFormat>(wire_format),
      input.root_type_name.empty() ? nullptr : input.root_type_name.c_str(),
      input.view.fixed_string_length,
      byte_length,
      static_cast<uint16_t>(required_alignment)
    );

    const uint64_t payload_ptr = static_cast<uint64_t>(
      reinterpret_cast<uintptr_t>(input.payload.data())
    );
    native_inputs.push_back(orbpro::stream::CreateTypedArenaBufferDirect(
      builder,
      type_ref,
      input.port_id.c_str(),
      static_cast<uint16_t>(input.view.alignment > 0 ? input.view.alignment : required_alignment),
      payload_ptr,
      byte_length,
      orbpro::stream::BufferOwnership_BORROWED,
      0,
      orbpro::stream::BufferMutability_IMMUTABLE,
      input.view.trace_id,
      input.view.stream_id,
      input.view.sequence,
      input.view.end_of_stream != 0
    ));
  }

  const auto inputs_vector = builder.CreateVector(native_inputs);
  const auto native_request = orbpro::plugin::CreateStreamInvokeRequest(
    builder,
    method_id_offset,
    inputs_vector,
    0,
    orbpro::manifest::DrainPolicy_DRAIN_UNTIL_YIELD
  );
  builder.Finish(native_request);

  // 2. Invoke the native OrbPro plugin.
  uint32_t response_size = 0;
  uint8_t* response_bytes = plugin_stream_invoke(
    builder.GetBufferPointer(),
    static_cast<size_t>(builder.GetSize()),
    &response_size
  );

  if (response_bytes == nullptr || response_size == 0u) {
    SetError("stream-invoke-failed",
             "OrbPro plugin_stream_invoke returned no response.");
    if (response_bytes != nullptr) {
      std::free(response_bytes);
    }
    return -1;
  }

  // 3. Parse the native StreamInvokeResponse and emit each output frame.
  flatbuffers::Verifier verifier(response_bytes, response_size);
  if (!verifier.VerifyBuffer<orbpro::plugin::StreamInvokeResponse>(nullptr)) {
    std::free(response_bytes);
    SetError("invalid-stream-invoke-response",
             "OrbPro StreamInvokeResponse failed FlatBuffer verification.");
    return -1;
  }

  const auto* response =
    flatbuffers::GetRoot<orbpro::plugin::StreamInvokeResponse>(response_bytes);

  int32_t status = 0;
  if (response->error_code() != 0) {
    status = response->error_code();
    const char* msg = response->error_message() ? response->error_message()->c_str() : "";
    SetError("stream-invoke-error",
             msg && msg[0] ? std::string(msg) : std::string("OrbPro plugin_stream_invoke failed."));
  }

  const auto* outputs = response->outputs();
  if (outputs != nullptr) {
    for (flatbuffers::uoffset_t i = 0; i < outputs->size(); i += 1) {
      const auto* frame = outputs->Get(i);
      if (!frame || frame->size() == 0 || frame->offset() == 0) {
        continue;
      }
      uint8_t* payload_bytes = reinterpret_cast<uint8_t*>(
        static_cast<uintptr_t>(frame->offset())
      );
      const uint32_t payload_size = frame->size();
      const char* port_id = frame->port_id() ? frame->port_id()->c_str() : nullptr;

      const char* schema_name = method->output_schema_name;
      const char* file_identifier = method->output_file_identifier;
      const char* root_type_name = method->output_root_type_name;
      uint16_t required_alignment = method->output_required_alignment;
      uint32_t wire_format = method->output_wire_format;

      if (frame->type_ref() != nullptr) {
        if (frame->type_ref()->schema_name() != nullptr && frame->type_ref()->schema_name()->size() > 0) {
          schema_name = frame->type_ref()->schema_name()->c_str();
        }
        if (frame->type_ref()->file_identifier() != nullptr && frame->type_ref()->file_identifier()->size() > 0) {
          file_identifier = frame->type_ref()->file_identifier()->c_str();
        }
        if (frame->type_ref()->root_type_name() != nullptr && frame->type_ref()->root_type_name()->size() > 0) {
          root_type_name = frame->type_ref()->root_type_name()->c_str();
        }
        if (frame->type_ref()->required_alignment() > 0) {
          required_alignment = frame->type_ref()->required_alignment();
        }
        wire_format = static_cast<uint32_t>(frame->type_ref()->wire_format());
      }

      plugin_push_output_typed(
        port_id,
        schema_name,
        file_identifier,
        wire_format,
        root_type_name,
        /*fixed_string_length=*/0,
        payload_size,
        required_alignment,
        payload_bytes,
        payload_size
      );

      // OrbPro owns the payload allocation via malloc/free; release it.
      std::free(payload_bytes);
    }
  }

  g_invoke_context.backlog_remaining = response->backlog_remaining();
  g_invoke_context.yielded = response->yielded();

  std::free(response_bytes);
  return status;
}

static orbpro::invoke::PluginInvokeResponseT BuildResponseObject() {
  orbpro::invoke::PluginInvokeResponseT response{};
  response.status_code = g_invoke_context.status_code;
  response.yielded = g_invoke_context.yielded;
  response.backlog_remaining = g_invoke_context.backlog_remaining;
  response.error_code = g_invoke_context.error_code;
  response.error_message = g_invoke_context.error_message;

  uint32_t arena_offset = 0;
  for (const auto& output : g_invoke_context.outputs) {
    const uint32_t alignment = std::max<uint32_t>(
      1u,
      output.required_alignment > 0 ? output.required_alignment : output.alignment
    );
    const uint32_t aligned_offset = AlignOffset(arena_offset, alignment);
    response.payload_arena.resize(aligned_offset, 0);
    response.payload_arena.insert(
      response.payload_arena.end(),
      output.payload.begin(),
      output.payload.end()
    );
    arena_offset = aligned_offset + static_cast<uint32_t>(output.payload.size());

    auto type_ref = std::make_unique<orbpro::stream::FlatBufferTypeRefT>();
    type_ref->schema_name = output.schema_name;
    type_ref->file_identifier = output.file_identifier;
    type_ref->wire_format =
      static_cast<orbpro::stream::PayloadWireFormat>(output.wire_format);
    type_ref->root_type_name = output.root_type_name;
    type_ref->fixed_string_length = output.fixed_string_length;
    type_ref->byte_length =
      output.byte_length > 0 ? output.byte_length : static_cast<uint32_t>(output.payload.size());
    type_ref->required_alignment = output.required_alignment;

    auto frame = std::make_unique<orbpro::stream::TypedArenaBufferT>();
    frame->type_ref = std::move(type_ref);
    frame->port_id = output.port_id;
    frame->alignment = static_cast<uint16_t>(alignment);
    frame->offset = aligned_offset;
    frame->size = static_cast<uint32_t>(output.payload.size());
    frame->generation = output.generation;
    frame->trace_id = output.trace_id;
    frame->stream_id = output.stream_id;
    frame->sequence = output.sequence;
    frame->end_of_stream = output.end_of_stream;
    response.output_frames.emplace_back(std::move(frame));
  }

  return response;
}

static std::vector<uint8_t> SerializeResponse(
    const orbpro::invoke::PluginInvokeResponseT& response) {
  ::flatbuffers::FlatBufferBuilder builder(1024);
  const auto root = orbpro::invoke::CreatePluginInvokeResponse(builder, &response);
  orbpro::invoke::FinishPluginInvokeResponseBuffer(builder, root);
  return std::vector<uint8_t>(
    builder.GetBufferPointer(),
    builder.GetBufferPointer() + builder.GetSize()
  );
}

static std::vector<uint8_t> SerializeErrorResponse(
    int32_t status_code,
    const char* error_code,
    const std::string& error_message) {
  orbpro::invoke::PluginInvokeResponseT response{};
  response.status_code = status_code;
  response.error_code = error_code ? error_code : "invoke-error";
  response.error_message = error_message;
  return SerializeResponse(response);
}

static std::vector<uint8_t> DispatchRequestObject(
    const orbpro::invoke::PluginInvokeRequestT& request,
    bool* runtime_error) {
  const auto* method = FindMethod(request.method_id);
  if (!method) {
    if (runtime_error) {
      *runtime_error = true;
    }
    return SerializeErrorResponse(
      404,
      "unknown-method",
      std::string("Unknown method: ") + request.method_id
    );
  }

  ResetInvokeContext(method);
  if (!LoadInputsFromRequest(request) || !ValidateRequiredInputs(method)) {
    if (runtime_error) {
      *runtime_error = true;
    }
    if (g_invoke_context.status_code == 0) {
      g_invoke_context.status_code = 400;
    }
    return SerializeResponse(BuildResponseObject());
  }

  g_invoke_context.status_code = DispatchToOrbProStreamInvoke(method);
  return SerializeResponse(BuildResponseObject());
}

static std::vector<uint8_t> DispatchRequestBytes(
    const uint8_t* request_bytes,
    size_t request_len,
    bool* runtime_error) {
  if (!request_bytes || request_len == 0u) {
    if (runtime_error) {
      *runtime_error = true;
    }
    return SerializeErrorResponse(400, "invalid-request",
                                  "Invoke request bytes are empty.");
  }

  ::flatbuffers::Verifier verifier(request_bytes, request_len);
  if (!orbpro::invoke::VerifyPluginInvokeRequestBuffer(verifier)) {
    if (runtime_error) {
      *runtime_error = true;
    }
    return SerializeErrorResponse(400, "invalid-request",
                                  "Invoke request FlatBuffer verification failed.");
  }

  const auto* request = orbpro::invoke::GetPluginInvokeRequest(request_bytes);
  auto request_object =
    std::unique_ptr<orbpro::invoke::PluginInvokeRequestT>(request->UnPack());
  return DispatchRequestObject(*request_object, runtime_error);
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
  // SDK 0.8.0 browser harness calls `_initialize` after instantiation on
  // standalone WASI artifacts (reactor convention). Trigger wasm-ld's global
  // constructor chain so C++ globals (std::map, std::vector, etc.) become
  // live before any invoke path runs.
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
  return static_cast<uint32_t>(g_invoke_context.inputs.size());
}

EMSCRIPTEN_KEEPALIVE
const plugin_input_frame_t* plugin_get_input_frame(uint32_t index) {
  if (index >= g_invoke_context.inputs.size()) {
    return nullptr;
  }
  return &g_invoke_context.inputs[index].view;
}

EMSCRIPTEN_KEEPALIVE
int32_t plugin_find_input_index(const char* port_id, uint32_t ordinal) {
  if (!port_id || !port_id[0]) {
    return -1;
  }
  uint32_t seen = 0;
  for (size_t index = 0; index < g_invoke_context.inputs.size(); index += 1) {
    if (g_invoke_context.inputs[index].port_id != port_id) {
      continue;
    }
    if (seen == ordinal) {
      return static_cast<int32_t>(index);
    }
    seen += 1;
  }
  return -1;
}

EMSCRIPTEN_KEEPALIVE
void plugin_reset_output_state(void) {
  g_invoke_context.outputs.clear();
  g_invoke_context.backlog_remaining = 0;
  g_invoke_context.yielded = false;
  g_invoke_context.error_code.clear();
  g_invoke_context.error_message.clear();
}

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
  if (!port_id || !port_id[0]) {
    SetError("invalid-output-port",
             "Output frames must declare a non-empty port id.");
    return -1;
  }
  if (!MethodDeclaresOutputPort(g_invoke_context.method, port_id)) {
    SetError(
      "unknown-output-port",
      std::string("Output port is not declared on the active method: ") + port_id
    );
    return -1;
  }

  OutputFrameOwned frame{};
  frame.port_id = ReadCString(port_id);
  frame.schema_name = ReadCString(schema_name);
  frame.file_identifier = ReadCString(file_identifier);
  frame.root_type_name = ReadCString(root_type_name);
  frame.wire_format = wire_format;
  frame.fixed_string_length = fixed_string_length;
  frame.byte_length = byte_length > 0u ? byte_length : payload_length;
  frame.required_alignment = required_alignment;
  frame.alignment = required_alignment > 0 ? required_alignment : 8;
  if (payload_ptr && payload_length > 0u) {
    frame.payload.insert(frame.payload.end(), payload_ptr, payload_ptr + payload_length);
  }

  g_invoke_context.outputs.emplace_back(std::move(frame));
  return static_cast<int32_t>(g_invoke_context.outputs.size() - 1u);
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
    static_cast<uint32_t>(orbpro::stream::PayloadWireFormat_Flatbuffer),
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
  g_invoke_context.yielded = yielded != 0;
}

EMSCRIPTEN_KEEPALIVE
void plugin_set_backlog_remaining(uint32_t backlog_remaining) {
  g_invoke_context.backlog_remaining = backlog_remaining;
}

EMSCRIPTEN_KEEPALIVE
void plugin_set_error(const char* error_code, const char* error_message) {
  g_invoke_context.error_code = error_code ? error_code : "";
  g_invoke_context.error_message = error_message ? error_message : "";
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

  bool runtime_error = false;
  const auto response_bytes = DispatchRequestBytes(
    ConstPtr(request_ptr),
    static_cast<size_t>(request_len),
    &runtime_error
  );

  const uint32_t response_ptr = plugin_alloc(static_cast<uint32_t>(response_bytes.size()));
  if (response_ptr == 0u) {
    return 0u;
  }
  if (!response_bytes.empty()) {
    std::memcpy(MutablePtr(response_ptr), response_bytes.data(), response_bytes.size());
  }
  if (response_len_out_ptr != 0u) {
    *MutableU32Ptr(response_len_out_ptr) = static_cast<uint32_t>(response_bytes.size());
  }
  return response_ptr;
}

}  // extern "C"

int main(int argc, char** argv) {
  (void)argc;
  (void)argv;

  // The JavaScript test harness invokes `_start` solely to run the
  // LLVM-generated global constructors, so when stdin is empty (or unreadable)
  // we return cleanly without attempting to dispatch a request. The WasmEdge
  // command surface, by contrast, always pipes a real PluginInvokeRequest in.
  std::vector<uint8_t> stdin_bytes;
  if (!ReadAllStdin(&stdin_bytes)) {
    // Treat read failures as "no request bytes" rather than a fatal error so
    // JS-side callers that invoke `_start()` purely to trigger ctors can keep
    // using the module as a library afterwards.
    return 0;
  }
  if (stdin_bytes.empty()) {
    return 0;
  }

  bool runtime_error = false;
  const auto response_bytes = DispatchRequestBytes(
    stdin_bytes.data(),
    stdin_bytes.size(),
    &runtime_error
  );
  if (!WriteAllStdout(
        response_bytes.empty() ? nullptr : response_bytes.data(),
        response_bytes.size())) {
    std::fprintf(stderr, "Failed to write stdout.\n");
    return 74;
  }
  return runtime_error ? 1 : 0;
}
