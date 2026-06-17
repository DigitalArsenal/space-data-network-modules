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

#include "TypedArenaBuffer_generated.h"
#include "generated/PluginMessage_generated.h"
#include "PIV_generated.h"
#include "space_data_module_invoke.h"

extern "C" int invoke(void);
extern "C" uint8_t *plugin_stream_invoke(
  const uint8_t *requestPtr,
  uint32_t requestSize,
  uint32_t *responseSizeOut
);

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
  uint64_t trace_id = 0;
  uint32_t backlog_remaining = 0;
  bool yielded = false;
  int32_t status_code = 0;
  std::string error_code{};
  std::string error_message{};
};

static const PortRequirement kMethod_invoke_input_ports[] = {
  { "request", true },
};
static const char *kMethod_invoke_output_ports[] = {
  "response",
};

static const PortRequirement kMethod_state_input_ports[] = {
  { "state", true },
};
static const PortRequirement kMethod_request_input_ports[] = {
  { "request", true },
};
static const char *kMethod_state_output_ports[] = {
  "state",
};
static const char *kMethod_result_output_ports[] = {
  "result",
};

static int DispatchNativeStreamMethod(void);

static const MethodDescriptor kMethodTable[] = {
  {
    "invoke",
    &invoke,
    kMethod_invoke_input_ports,
    1u,
    kMethod_invoke_output_ports,
    1u,
    false,
    "request",
    "response"
  },
  {
    "ingest_state",
    &DispatchNativeStreamMethod,
    kMethod_state_input_ports,
    1u,
    nullptr,
    0u,
    false,
    nullptr,
    nullptr
  },
  {
    "propagate_state",
    &DispatchNativeStreamMethod,
    kMethod_request_input_ports,
    1u,
    kMethod_state_output_ports,
    1u,
    false,
    nullptr,
    nullptr
  },
  {
    "prepare_trajectory_segments",
    &DispatchNativeStreamMethod,
    kMethod_request_input_ports,
    1u,
    kMethod_result_output_ports,
    1u,
    false,
    nullptr,
    nullptr
  },
  {
    "describe_trajectory_segments",
    &DispatchNativeStreamMethod,
    kMethod_request_input_ports,
    1u,
    kMethod_result_output_ports,
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

static std::string StringValue(const ::flatbuffers::String *value) {
  return value ? value->str() : std::string();
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

static bool ResolvePivPayload(
  const PIVRequest *request,
  const TAB *frame,
  const uint8_t **payload_out,
  uint32_t *payload_size_out
) {
  if (!payload_out || !payload_size_out) {
    return false;
  }
  *payload_out = nullptr;
  *payload_size_out = 0u;
  if (!request || !frame) {
    return false;
  }

  const uint32_t payload_size = frame->SIZE();
  const uint32_t payload_offset = frame->OFFSET();
  const auto *arena = request->PAYLOAD_ARENA();
  if (payload_size == 0u) {
    *payload_size_out = 0u;
    return true;
  }
  if (arena && arena->size() > 0u) {
    const uint64_t end_offset =
      static_cast<uint64_t>(payload_offset) + static_cast<uint64_t>(payload_size);
    if (end_offset > arena->size()) {
      SetError("invalid-request-frame", "PIV input frame payload range exceeds request payload arena.");
      return false;
    }
    *payload_out = arena->Data() + payload_offset;
    *payload_size_out = payload_size;
    return true;
  }

  const uintptr_t pointer = static_cast<uintptr_t>(payload_offset);
  if (pointer == 0u) {
    SetError("invalid-request-frame", "PIV input frame uses an external payload pointer of zero.");
    return false;
  }
  *payload_out = reinterpret_cast<const uint8_t *>(pointer);
  *payload_size_out = payload_size;
  return true;
}

static bool LoadInputsFromPivRequest(const PIVRequest *request) {
  g_invoke_context.inputs.clear();
  const auto *frames = request ? request->INPUTS() : nullptr;
  if (!frames) {
    return true;
  }
  g_invoke_context.inputs.reserve(frames->size());

  for (::flatbuffers::uoffset_t index = 0; index < frames->size(); index += 1) {
    const TAB *frame = frames->Get(index);
    if (!frame) {
      continue;
    }

    const uint8_t *payload_ptr = nullptr;
    uint32_t payload_size = 0;
    if (!ResolvePivPayload(request, frame, &payload_ptr, &payload_size)) {
      return false;
    }

    g_invoke_context.inputs.emplace_back();
    auto &owned = g_invoke_context.inputs.back();
    owned = InputFrameOwned{};
    owned.port_id = StringValue(frame->PORT_ID());
    const FlatBufferTypeRef *type_ref = frame->TYPE_REF();
    if (type_ref) {
      owned.schema_name = StringValue(type_ref->SCHEMA_NAME());
      owned.file_identifier = StringValue(type_ref->FILE_IDENTIFIER());
      owned.root_type_name = StringValue(type_ref->ROOT_TYPE());
    }
    if (payload_ptr && payload_size > 0u) {
      owned.payload.insert(owned.payload.end(), payload_ptr, payload_ptr + payload_size);
    }

    owned.view.port_id = owned.port_id.empty() ? nullptr : owned.port_id.c_str();
    owned.view.schema_name = owned.schema_name.empty() ? nullptr : owned.schema_name.c_str();
    owned.view.file_identifier = owned.file_identifier.empty() ? nullptr : owned.file_identifier.c_str();
    owned.view.wire_format = static_cast<uint32_t>(frame->WIRE_FORMAT());
    owned.view.root_type_name = owned.root_type_name.empty() ? nullptr : owned.root_type_name.c_str();
    owned.view.fixed_string_length = 0;
    owned.view.byte_length = payload_size;
    owned.view.required_alignment = static_cast<uint16_t>(frame->ALIGNMENT());
    owned.view.alignment = static_cast<uint16_t>(frame->ALIGNMENT());
    owned.view.size = payload_size;
    owned.view.generation = 0;
    owned.view.trace_id = frame->FRAME_ID();
    owned.view.stream_id = 0;
    owned.view.sequence = 0;
    owned.view.end_of_stream = 1;
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

static pivStatus PivStatusForContext() {
  if (!g_invoke_context.error_code.empty() || !g_invoke_context.error_message.empty()) {
    return pivStatus::FAILED;
  }
  if (g_invoke_context.status_code != 0) {
    return pivStatus::FAILED;
  }
  if (g_invoke_context.yielded || g_invoke_context.backlog_remaining > 0u) {
    return pivStatus::YIELDED;
  }
  return pivStatus::OK;
}

static std::vector<uint8_t> SerializePivResponse() {
  ::flatbuffers::FlatBufferBuilder builder(1024);
  std::vector<uint8_t> payload_arena;
  std::vector<::flatbuffers::Offset<TAB>> outputs;
  payload_arena.reserve(1024);
  outputs.reserve(g_invoke_context.outputs.size());

  for (const auto &output : g_invoke_context.outputs) {
    const uint32_t alignment = std::max<uint32_t>(
      1u,
      output.required_alignment > 0u ? output.required_alignment : output.alignment
    );
    const uint32_t aligned_offset = AlignOffset(
      static_cast<uint32_t>(payload_arena.size()),
      alignment
    );
    payload_arena.resize(aligned_offset, 0);
    if (!output.payload.empty()) {
      payload_arena.insert(
        payload_arena.end(),
        output.payload.begin(),
        output.payload.end()
      );
    }

    const auto type_ref = CreateFlatBufferTypeRefDirect(
      builder,
      output.schema_name.empty() ? nullptr : output.schema_name.c_str(),
      output.file_identifier.empty() ? nullptr : output.file_identifier.c_str(),
      nullptr,
      output.root_type_name.empty() ? nullptr : output.root_type_name.c_str()
    );
    outputs.push_back(CreateTABDirect(
      builder,
      aligned_offset,
      static_cast<uint32_t>(output.payload.size()),
      alignment,
      static_cast<payloadWireFormat>(output.wire_format),
      type_ref,
      bufferMutability::IMMUTABLE,
      bufferOwnership::HOST_OWNED,
      output.trace_id,
      output.port_id.empty() ? nullptr : output.port_id.c_str()
    ));
  }

  const auto response = CreatePIVResponseDirect(
    builder,
    g_invoke_context.status_code,
    PivStatusForContext(),
    g_invoke_context.yielded,
    g_invoke_context.backlog_remaining,
    outputs.empty() ? nullptr : &outputs,
    payload_arena.empty() ? nullptr : &payload_arena,
    g_invoke_context.error_code.empty() ? nullptr : g_invoke_context.error_code.c_str(),
    g_invoke_context.error_message.empty() ? nullptr : g_invoke_context.error_message.c_str(),
    g_invoke_context.trace_id
  );
  const auto envelope = CreatePIV(builder, 0, response);
  FinishPIVBuffer(builder, envelope);
  return std::vector<uint8_t>(
    builder.GetBufferPointer(),
    builder.GetBufferPointer() + builder.GetSize()
  );
}

static std::vector<uint8_t> SerializePivErrorResponse(
  int32_t status_code,
  pivStatus status,
  const char *error_code,
  const std::string &error_message,
  uint64_t trace_id = 0
) {
  ResetInvokeContext(nullptr);
  g_invoke_context.trace_id = trace_id;
  g_invoke_context.status_code = status_code;
  g_invoke_context.error_code = error_code ? error_code : "invoke-error";
  g_invoke_context.error_message = error_message;
  if (status == pivStatus::NOT_FOUND) {
    g_invoke_context.error_code = error_code ? error_code : "unknown-method";
  }
  ::flatbuffers::FlatBufferBuilder builder(512);
  const auto response = CreatePIVResponseDirect(
    builder,
    status_code,
    status,
    false,
    0,
    nullptr,
    nullptr,
    g_invoke_context.error_code.c_str(),
    g_invoke_context.error_message.c_str(),
    trace_id
  );
  const auto envelope = CreatePIV(builder, 0, response);
  FinishPIVBuffer(builder, envelope);
  return std::vector<uint8_t>(
    builder.GetBufferPointer(),
    builder.GetBufferPointer() + builder.GetSize()
  );
}

static ::flatbuffers::Offset<orbpro::stream::TypedArenaBuffer> BuildNativeInputFrame(
  ::flatbuffers::FlatBufferBuilder &builder,
  const InputFrameOwned &input
) {
  const auto type_ref = orbpro::stream::CreateFlatBufferTypeRefDirect(
    builder,
    input.schema_name.empty() ? nullptr : input.schema_name.c_str(),
    input.file_identifier.empty() ? nullptr : input.file_identifier.c_str(),
    nullptr,
    false,
    static_cast<orbpro::stream::PayloadWireFormat>(input.view.wire_format),
    input.root_type_name.empty() ? nullptr : input.root_type_name.c_str(),
    input.view.fixed_string_length,
    input.view.byte_length > 0u ? input.view.byte_length : input.view.payload_length,
    input.view.required_alignment
  );

  return orbpro::stream::CreateTypedArenaBufferDirect(
    builder,
    type_ref,
    input.port_id.empty() ? nullptr : input.port_id.c_str(),
    input.view.alignment > 0u ? input.view.alignment : 8u,
    static_cast<uint32_t>(reinterpret_cast<uintptr_t>(input.payload.data())),
    static_cast<uint32_t>(input.payload.size()),
    orbpro::stream::BufferOwnership_BORROWED,
    input.view.generation,
    orbpro::stream::BufferMutability_IMMUTABLE,
    input.view.trace_id,
    input.view.stream_id,
    input.view.sequence,
    input.view.end_of_stream != 0
  );
}

static std::vector<uint8_t> BuildNativeStreamRequestBytes() {
  ::flatbuffers::FlatBufferBuilder builder(1024);
  std::vector<::flatbuffers::Offset<orbpro::stream::TypedArenaBuffer>> inputs;
  inputs.reserve(g_invoke_context.inputs.size());
  for (const auto &input : g_invoke_context.inputs) {
    inputs.push_back(BuildNativeInputFrame(builder, input));
  }

  const auto request = orbpro::plugin::CreateStreamInvokeRequestDirect(
    builder,
    g_invoke_context.method ? g_invoke_context.method->method_id : nullptr,
    &inputs,
    65535u,
    orbpro::manifest::DrainPolicy_DRAIN_UNTIL_YIELD
  );
  builder.Finish(request);
  return std::vector<uint8_t>(
    builder.GetBufferPointer(),
    builder.GetBufferPointer() + builder.GetSize()
  );
}

static int CopyNativeStreamResponse(const uint8_t *response_ptr, uint32_t response_size) {
  if (!response_ptr || response_size == 0u) {
    SetError("native-stream-error", "Native HPOP stream method returned an empty response.");
    return 500;
  }

  ::flatbuffers::Verifier verifier(response_ptr, response_size);
  const auto *native_response =
    ::flatbuffers::GetRoot<orbpro::plugin::StreamInvokeResponse>(response_ptr);
  if (!native_response || !native_response->Verify(verifier)) {
    SetError("native-stream-error", "Native HPOP stream response verification failed.");
    return 500;
  }

  if (native_response->error_code() != 0) {
    SetError(
      "native-stream-error",
      native_response->error_message()
        ? native_response->error_message()->str()
        : "Native HPOP stream method failed."
    );
    return native_response->error_code();
  }

  g_invoke_context.backlog_remaining = native_response->backlog_remaining();
  g_invoke_context.yielded = native_response->yielded();

  const auto *outputs = native_response->outputs();
  if (!outputs) {
    return 0;
  }

  g_invoke_context.outputs.reserve(g_invoke_context.outputs.size() + outputs->size());
  for (::flatbuffers::uoffset_t index = 0; index < outputs->size(); index += 1) {
    const auto *native_frame = outputs->Get(index);
    if (!native_frame) {
      continue;
    }

    const auto *native_type_ref = native_frame->type_ref();
    OutputFrameOwned output{};
    output.port_id = native_frame->port_id() ? native_frame->port_id()->str() : "";
    output.schema_name =
      native_type_ref && native_type_ref->schema_name()
        ? native_type_ref->schema_name()->str()
        : "";
    output.file_identifier =
      native_type_ref && native_type_ref->file_identifier()
        ? native_type_ref->file_identifier()->str()
        : "";
    output.root_type_name =
      native_type_ref && native_type_ref->root_type_name()
        ? native_type_ref->root_type_name()->str()
        : "";
    output.wire_format =
      native_type_ref
        ? static_cast<uint32_t>(native_type_ref->wire_format())
        : static_cast<uint32_t>(orbpro::stream::PayloadWireFormat_Flatbuffer);
    output.fixed_string_length =
      native_type_ref ? native_type_ref->fixed_string_length() : 0u;
    output.byte_length = native_type_ref ? native_type_ref->byte_length() : 0u;
    output.required_alignment =
      native_type_ref ? native_type_ref->required_alignment() : 0u;
    output.alignment = native_frame->alignment();
    output.generation = native_frame->generation();
    output.trace_id = native_frame->trace_id();
    output.stream_id = native_frame->stream_id();
    output.sequence = native_frame->sequence();
    output.end_of_stream = native_frame->end_of_stream();

    const auto payload_size = native_frame->size();
    const auto *payload_ptr = reinterpret_cast<const uint8_t *>(
      static_cast<uintptr_t>(native_frame->offset())
    );
    if (payload_ptr && payload_size > 0u) {
      output.payload.insert(output.payload.end(), payload_ptr, payload_ptr + payload_size);
    }

    g_invoke_context.outputs.emplace_back(std::move(output));
  }

  return 0;
}

static int DispatchNativeStreamMethod(void) {
  const auto native_request = BuildNativeStreamRequestBytes();
  uint32_t native_response_size = 0;
  uint8_t *native_response = plugin_stream_invoke(
    native_request.data(),
    static_cast<uint32_t>(native_request.size()),
    &native_response_size
  );
  const int status = CopyNativeStreamResponse(native_response, native_response_size);
  if (native_response) {
    std::free(native_response);
  }
  return status;
}

static std::vector<uint8_t> DispatchPivRequest(
  const PIVRequest *request,
  bool *runtime_error
) {
  if (!request) {
    if (runtime_error) {
      *runtime_error = true;
    }
    return SerializePivErrorResponse(400, pivStatus::FAILED, "invalid-request", "PIV envelope does not contain a request.");
  }

  const std::string method_id = StringValue(request->METHOD_ID());
  const auto *method = FindMethod(method_id);
  if (!method) {
    if (runtime_error) {
      *runtime_error = true;
    }
    return SerializePivErrorResponse(
      404,
      pivStatus::NOT_FOUND,
      "unknown-method",
      std::string("Unknown method: ") + method_id,
      request->TRACE_ID()
    );
  }

  ResetInvokeContext(method);
  g_invoke_context.trace_id = request->TRACE_ID();
  if (!LoadInputsFromPivRequest(request) || !ValidateRequiredInputs(method)) {
    if (runtime_error) {
      *runtime_error = true;
    }
    if (g_invoke_context.status_code == 0) {
      g_invoke_context.status_code = 400;
    }
    return SerializePivResponse();
  }

  g_invoke_context.status_code = method->handler ? method->handler() : -1;
  return SerializePivResponse();
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
    return SerializePivErrorResponse(400, pivStatus::FAILED, "invalid-request", "Invoke request bytes are empty.");
  }

  if (request_len >= 8u && PIVBufferHasIdentifier(request_bytes)) {
    ::flatbuffers::Verifier piv_verifier(request_bytes, request_len);
    if (!VerifyPIVBuffer(piv_verifier)) {
      if (runtime_error) {
        *runtime_error = true;
      }
      return SerializePivErrorResponse(400, pivStatus::FAILED, "invalid-request", "PIV request FlatBuffer verification failed.");
    }
    const auto *envelope = GetPIV(request_bytes);
    if (!envelope || !envelope->REQUEST()) {
      if (runtime_error) {
        *runtime_error = true;
      }
      return SerializePivErrorResponse(400, pivStatus::FAILED, "invalid-request", "PIV envelope does not contain a request.");
    }
    return DispatchPivRequest(envelope->REQUEST(), runtime_error);
  }

  if (runtime_error) {
    *runtime_error = true;
  }
  return SerializePivErrorResponse(
    400,
    pivStatus::FAILED,
    "invalid-request",
    "Invoke request must be an SDS PIV envelope."
  );
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
    std::fprintf(
      stderr,
      "--method raw shortcut mode was removed; pass an SDS PIV envelope on stdin.\n"
    );
    return 64;
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
