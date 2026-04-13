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
#include "space_data_module_invoke.h"

extern "C" int licensing_server_configure_runtime(void);
extern "C" int licensing_server_publish_module(void);
extern "C" int licensing_server_handle_message(void);
extern "C" int licensing_client_request_grant(void);
extern "C" int licensing_client_fetch_and_decrypt(void);
extern "C" int licensing_decrypt_and_verify(void);

namespace {

struct PortRequirement {
  const char *port_id;
  bool required;
};

struct MethodDescriptor {
  const char *method_id;
  int (*handler)(void);
  const PortRequirement *input_ports;
  size_t input_port_count;
  const char *const *output_ports;
  size_t output_port_count;
  bool raw_shortcut_allowed;
  const char *raw_input_port_id;
  const char *raw_output_port_id;
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
  const MethodDescriptor *method = nullptr;
  std::vector<InputFrameOwned> inputs{};
  std::vector<OutputFrameOwned> outputs{};
  uint32_t backlog_remaining = 0;
  bool yielded = false;
  int32_t status_code = 0;
  std::string error_code{};
  std::string error_message{};
};

static const PortRequirement kMethod_server_configure_runtime_input_ports[] = {
  { "config", true },
};
static const char *kMethod_server_configure_runtime_output_ports[] = {
  "status",
};

static const PortRequirement kMethod_server_publish_module_input_ports[] = {
  { "module_descriptor", true },
  { "protected_content", true },
  { "content_key", true },
};
static const char *kMethod_server_publish_module_output_ports[] = {
  "response",
};

static const PortRequirement kMethod_server_handle_message_input_ports[] = {
  { "request", true },
};
static const char *kMethod_server_handle_message_output_ports[] = {
  "response",
};

static const PortRequirement kMethod_client_request_grant_input_ports[] = {
  { "request", true },
  { "requester_signing_seed", true },
};
static const char *kMethod_client_request_grant_output_ports[] = {
  "response",
};

static const PortRequirement kMethod_client_fetch_and_decrypt_input_ports[] = {
  { "grant_response", true },
  { "protected_content", false },
};
static const char *kMethod_client_fetch_and_decrypt_output_ports[] = {
  "plaintext",
};

static const PortRequirement kMethod_decrypt_and_verify_input_ports[] = {
  { "protected_content", true },
  { "dek", true },
  { "signer_key", true },
};
static const char *kMethod_decrypt_and_verify_output_ports[] = {
  "plaintext",
};

static const MethodDescriptor kMethodTable[] = {
  {
    "server_configure_runtime",
    &licensing_server_configure_runtime,
    kMethod_server_configure_runtime_input_ports,
    1u,
    kMethod_server_configure_runtime_output_ports,
    1u,
    true,
    "config",
    "status"
  },
  {
    "server_publish_module",
    &licensing_server_publish_module,
    kMethod_server_publish_module_input_ports,
    3u,
    kMethod_server_publish_module_output_ports,
    1u,
    true,
    "request",
    "response"
  },
  {
    "server_handle_message",
    &licensing_server_handle_message,
    kMethod_server_handle_message_input_ports,
    1u,
    kMethod_server_handle_message_output_ports,
    1u,
    true,
    "request",
    "response"
  },
  {
    "client_request_grant",
    &licensing_client_request_grant,
    kMethod_client_request_grant_input_ports,
    2u,
    kMethod_client_request_grant_output_ports,
    1u,
    true,
    "request",
    "response"
  },
  {
    "client_fetch_and_decrypt",
    &licensing_client_fetch_and_decrypt,
    kMethod_client_fetch_and_decrypt_input_ports,
    2u,
    kMethod_client_fetch_and_decrypt_output_ports,
    1u,
    false,
    nullptr,
    nullptr
  },
  {
    "decrypt_and_verify",
    &licensing_decrypt_and_verify,
    kMethod_decrypt_and_verify_input_ports,
    3u,
    kMethod_decrypt_and_verify_output_ports,
    1u,
    false,
    nullptr,
    nullptr
  },
};

static InvokeContext g_invoke_context;

static uintptr_t PtrFromU32(uint32_t value) {
  return static_cast<uintptr_t>(value);
}

static uint8_t *MutablePtr(uint32_t value) {
  return reinterpret_cast<uint8_t *>(PtrFromU32(value));
}

static const uint8_t *ConstPtr(uint32_t value) {
  return reinterpret_cast<const uint8_t *>(PtrFromU32(value));
}

static uint32_t *MutableU32Ptr(uint32_t value) {
  return reinterpret_cast<uint32_t *>(PtrFromU32(value));
}

static const MethodDescriptor *FindMethod(std::string_view method_id) {
  for (const auto &method : kMethodTable) {
    if (method_id == method.method_id) {
      return &method;
    }
  }
  return nullptr;
}

static bool MethodDeclaresOutputPort(const MethodDescriptor *method, const char *port_id) {
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

static void ResetInvokeContext(const MethodDescriptor *method) {
  g_invoke_context = InvokeContext{};
  g_invoke_context.method = method;
}

static void SetError(const char *code, const std::string &message) {
  g_invoke_context.error_code = code ? code : "invoke-error";
  g_invoke_context.error_message = message;
}

static std::string ReadCString(const char *value) {
  return value ? std::string(value) : std::string();
}

static uint32_t AlignOffset(uint32_t offset, uint32_t alignment) {
  if (alignment <= 1u) {
    return offset;
  }
  const uint32_t remainder = offset % alignment;
  return remainder == 0u ? offset : offset + alignment - remainder;
}

static bool LoadInputsFromRequest(const orbpro::invoke::PluginInvokeRequestT &request) {
  g_invoke_context.inputs.clear();
  g_invoke_context.inputs.reserve(request.input_frames.size());

  for (const auto &frame_ptr : request.input_frames) {
    if (!frame_ptr) {
      continue;
    }

    const auto &frame = *frame_ptr;
    const auto payload_offset = static_cast<size_t>(frame.offset);
    const auto payload_size = static_cast<size_t>(frame.size);
    if (payload_offset + payload_size > request.payload_arena.size()) {
      SetError("invalid-request-frame", "Input frame payload range exceeds request payload arena.");
      return false;
    }

    g_invoke_context.inputs.emplace_back();
    auto &owned = g_invoke_context.inputs.back();
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

static bool ValidateRequiredInputs(const MethodDescriptor *method) {
  if (!method) {
    return false;
  }
  for (size_t port_index = 0; port_index < method->input_port_count; port_index += 1) {
    const auto &port = method->input_ports[port_index];
    if (!port.required) {
      continue;
    }
    bool present = false;
    for (const auto &frame : g_invoke_context.inputs) {
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

static orbpro::invoke::PluginInvokeResponseT BuildResponseObject() {
  orbpro::invoke::PluginInvokeResponseT response{};
  response.status_code = g_invoke_context.status_code;
  response.yielded = g_invoke_context.yielded;
  response.backlog_remaining = g_invoke_context.backlog_remaining;
  response.error_code = g_invoke_context.error_code;
  response.error_message = g_invoke_context.error_message;

  uint32_t arena_offset = 0;
  for (const auto &output : g_invoke_context.outputs) {
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

static std::vector<uint8_t> SerializeResponse(const orbpro::invoke::PluginInvokeResponseT &response) {
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
  const char *error_code,
  const std::string &error_message
) {
  orbpro::invoke::PluginInvokeResponseT response{};
  response.status_code = status_code;
  response.error_code = error_code ? error_code : "invoke-error";
  response.error_message = error_message;
  return SerializeResponse(response);
}

static std::vector<uint8_t> DispatchRequestObject(
  const orbpro::invoke::PluginInvokeRequestT &request,
  bool *runtime_error
) {
  const auto *method = FindMethod(request.method_id);
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

  g_invoke_context.status_code = method->handler ? method->handler() : -1;
  return SerializeResponse(BuildResponseObject());
}

static std::vector<uint8_t> DispatchRequestBytes(
  const uint8_t *request_bytes,
  size_t request_len,
  bool *runtime_error
) {
  if (!request_bytes || request_len == 0u) {
    if (runtime_error) {
      *runtime_error = true;
    }
    return SerializeErrorResponse(400, "invalid-request", "Invoke request bytes are empty.");
  }

  ::flatbuffers::Verifier verifier(request_bytes, request_len);
  if (!orbpro::invoke::VerifyPluginInvokeRequestBuffer(verifier)) {
    if (runtime_error) {
      *runtime_error = true;
    }
    return SerializeErrorResponse(400, "invalid-request", "Invoke request FlatBuffer verification failed.");
  }

  const auto *request = orbpro::invoke::GetPluginInvokeRequest(request_bytes);
  auto request_object = std::unique_ptr<orbpro::invoke::PluginInvokeRequestT>(request->UnPack());
  return DispatchRequestObject(*request_object, runtime_error);
}

static bool ReadAllStdin(std::vector<uint8_t> *bytes_out) {
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

static bool WriteAllStdout(const uint8_t *bytes, size_t length) {
  if (!bytes && length > 0u) {
    return false;
  }
  if (length == 0u) {
    return std::fflush(stdout) == 0;
  }
  return std::fwrite(bytes, 1, length, stdout) == length && std::fflush(stdout) == 0;
}

static bool BuildRawShortcutRequest(
  const MethodDescriptor *method,
  const std::vector<uint8_t> &stdin_bytes,
  orbpro::invoke::PluginInvokeRequestT *request
) {
  if (!method || !method->raw_shortcut_allowed || !request) {
    return false;
  }
  request->method_id = method->method_id;
  request->payload_arena = stdin_bytes;

  auto frame = std::make_unique<orbpro::stream::TypedArenaBufferT>();
  frame->port_id = method->raw_input_port_id ? method->raw_input_port_id : "";
  frame->alignment = 1;
  frame->offset = 0;
  frame->size = static_cast<uint32_t>(stdin_bytes.size());
  request->input_frames.emplace_back(std::move(frame));
  return true;
}

}  // namespace

extern "C" uint32_t plugin_get_input_count(void) {
  return static_cast<uint32_t>(g_invoke_context.inputs.size());
}

extern "C" const plugin_input_frame_t *plugin_get_input_frame(uint32_t index) {
  if (index >= g_invoke_context.inputs.size()) {
    return nullptr;
  }
  return &g_invoke_context.inputs[index].view;
}

extern "C" int32_t plugin_find_input_index(const char *port_id, uint32_t ordinal) {
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

extern "C" void plugin_reset_output_state(void) {
  g_invoke_context.outputs.clear();
  g_invoke_context.backlog_remaining = 0;
  g_invoke_context.yielded = false;
  g_invoke_context.error_code.clear();
  g_invoke_context.error_message.clear();
}

extern "C" int32_t plugin_push_output(
  const char *port_id,
  const char *schema_name,
  const char *file_identifier,
  const uint8_t *payload_ptr,
  uint32_t payload_length
) {
  return plugin_push_output_ex(
    port_id,
    schema_name,
    file_identifier,
    static_cast<uint32_t>(orbpro::stream::PayloadWireFormat_Flatbuffer),
    nullptr,
    0,
    0,
    payload_ptr,
    payload_length
  );
}

extern "C" int32_t plugin_push_output_typed(
  const char *port_id,
  const char *schema_name,
  const char *file_identifier,
  uint32_t wire_format,
  const char *root_type_name,
  uint16_t fixed_string_length,
  uint32_t byte_length,
  uint16_t required_alignment,
  const uint8_t *payload_ptr,
  uint32_t payload_length
) {
  if (!port_id || !port_id[0]) {
    SetError("invalid-output-port", "Output frames must declare a non-empty port id.");
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

extern "C" int32_t plugin_push_output_ex(
  const char *port_id,
  const char *schema_name,
  const char *file_identifier,
  uint32_t wire_format,
  const char *root_type_name,
  uint16_t fixed_string_length,
  uint16_t required_alignment,
  const uint8_t *payload_ptr,
  uint32_t payload_length
) {
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

extern "C" void plugin_set_yielded(int32_t yielded) {
  g_invoke_context.yielded = yielded != 0;
}

extern "C" void plugin_set_backlog_remaining(uint32_t backlog_remaining) {
  g_invoke_context.backlog_remaining = backlog_remaining;
}

extern "C" void plugin_set_error(const char *error_code, const char *error_message) {
  g_invoke_context.error_code = error_code ? error_code : "";
  g_invoke_context.error_message = error_message ? error_message : "";
}

extern "C" uint32_t plugin_alloc(uint32_t size) {
  const auto allocation_size = size > 0u ? size : 1u;
  void *ptr = std::malloc(allocation_size);
  return ptr ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(ptr)) : 0u;
}

extern "C" void plugin_free(uint32_t ptr, uint32_t size) {
  (void)size;
  if (ptr != 0u) {
    std::free(reinterpret_cast<void *>(PtrFromU32(ptr)));
  }
}

extern "C" uint32_t plugin_invoke_stream(
  uint32_t request_ptr,
  uint32_t request_len,
  uint32_t response_len_out_ptr
) {
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

int main(int argc, char **argv) {
  const char *shortcut_method = nullptr;
  for (int index = 1; index < argc; index += 1) {
    if (std::strcmp(argv[index], "--method") == 0) {
      if (index + 1 >= argc) {
        std::fprintf(stderr, "--method requires a method id argument.\n");
        return 64;
      }
      shortcut_method = argv[++index];
      continue;
    }
    std::fprintf(stderr, "Unknown argument: %s\n", argv[index]);
    return 64;
  }

  std::vector<uint8_t> stdin_bytes;
  if (!ReadAllStdin(&stdin_bytes)) {
    std::fprintf(stderr, "Failed to read stdin.\n");
    return 74;
  }

  if (shortcut_method) {
    const auto *method = FindMethod(shortcut_method);
    if (!method || !method->raw_shortcut_allowed) {
      std::fprintf(
        stderr,
        "Method %s does not support raw stdin/stdout shortcut mode.\n",
        shortcut_method
      );
      return 64;
    }

    orbpro::invoke::PluginInvokeRequestT shortcut_request{};
    if (!BuildRawShortcutRequest(method, stdin_bytes, &shortcut_request)) {
      std::fprintf(stderr, "Failed to construct raw shortcut request.\n");
      return 64;
    }

    bool runtime_error = false;
    const auto response_bytes = DispatchRequestObject(shortcut_request, &runtime_error);
    ::flatbuffers::Verifier verifier(response_bytes.data(), response_bytes.size());
    if (!orbpro::invoke::VerifyPluginInvokeResponseBuffer(verifier)) {
      std::fprintf(stderr, "Shortcut response verification failed.\n");
      return 70;
    }

    auto response = std::unique_ptr<orbpro::invoke::PluginInvokeResponseT>(
      orbpro::invoke::GetPluginInvokeResponse(response_bytes.data())->UnPack()
    );
    if (runtime_error || response->status_code != 0 || !response->error_code.empty()) {
      if (!response->error_message.empty()) {
        std::fprintf(stderr, "%s\n", response->error_message.c_str());
      }
      return 1;
    }
    if (response->output_frames.size() > 1u) {
      std::fprintf(stderr, "Raw shortcut mode produced more than one output frame.\n");
      return 65;
    }
    if (response->output_frames.empty()) {
      return 0;
    }

    const auto &frame = *response->output_frames[0];
    const auto payload_offset = static_cast<size_t>(frame.offset);
    const auto payload_size = static_cast<size_t>(frame.size);
    if (payload_offset + payload_size > response->payload_arena.size()) {
      std::fprintf(stderr, "Raw shortcut output frame exceeds response payload arena.\n");
      return 70;
    }
    if (!WriteAllStdout(response->payload_arena.data() + payload_offset, payload_size)) {
      std::fprintf(stderr, "Failed to write stdout.\n");
      return 74;
    }
    return 0;
  }

  bool runtime_error = false;
  const auto response_bytes = DispatchRequestBytes(
    stdin_bytes.empty() ? nullptr : stdin_bytes.data(),
    stdin_bytes.size(),
    &runtime_error
  );
  if (!WriteAllStdout(
        response_bytes.empty() ? nullptr : response_bytes.data(),
        response_bytes.size()
      )) {
    std::fprintf(stderr, "Failed to write stdout.\n");
    return 74;
  }
  return runtime_error ? 1 : 0;
}
