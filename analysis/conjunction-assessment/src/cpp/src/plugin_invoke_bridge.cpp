#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <thread>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <flatbuffers/flatbuffers.h>

#include "conjunction/conjunction_assessment.h"
#include "conjunction/conjunction_engine.h"
#include "conjunction/ephemeris_source.h"
#include "conjunction/generated/all_generated.h"
#include "conjunction/gp_json.h"
#include "conjunction/pc_method.h"
#include "conjunction/resident_screening_index.h"
#include "conjunction/screening.h"
#include "conjunction/screening_internal.h"
#include "OMM_generated.h"
#include "PluginInvokeRequest_generated.h"
#include "PluginInvokeResponse_generated.h"
#include "TypedArenaBuffer_generated.h"
#include "orbpro/generated/PropagatorTrajectorySegments_generated.h"
#include "orbpro/generated/StateVector_generated.h"
#include "space_data_module_invoke.h"

extern "C" int invoke(void);
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
  uint32_t backlog_remaining = 0;
  bool yielded = false;
  int32_t status_code = 0;
  std::string error_code{};
  std::string error_message{};
};

static const PortRequirement kMethod_invoke_input_ports[] = {
  { "request", true },
};
static const PortRequirement kMethod_pair_request_input_ports[] = {
  { "request", true },
};
static const PortRequirement kMethod_screen_catalog_input_ports[] = {
  { "request", true },
  { "catalog", false },
};
static const PortRequirement kMethod_prepare_screening_index_input_ports[] = {
  { "request", true },
  { "sources", true },
};
static const PortRequirement kMethod_prepare_segment_screening_index_input_ports[] = {
  { "request", true },
  { "sources", true },
  { "segments", true },
};
static const PortRequirement kMethod_prepare_sample_screening_index_input_ports[] = {
  { "request", true },
  { "sources", true },
  { "samples", true },
};
static const PortRequirement kMethod_destroy_screening_index_input_ports[] = {
  { "request", true },
};
static const PortRequirement kMethod_screen_window_input_ports[] = {
  { "request", true },
};
static const char *kMethod_invoke_output_ports[] = {
  "response",
};
static const char *kMethod_result_output_ports[] = {
  "result",
};
static const char *kMethod_screen_catalog_output_ports[] = {
  "result",
  "cdm",
};
static const char *kMethod_cdm_output_ports[] = {
  "cdm",
};

static int HandleAssessConjunction(void);
static int HandleEmitCdm(void);
static int HandleFindTca(void);
static int HandleAlfanoMaxProbability(void);
static int HandleComputePc(void);
static int HandleScreenCatalog(void);
static int HandlePrepareScreeningIndex(void);
static int HandlePrepareSegmentScreeningIndex(void);
static int HandlePrepareSampleScreeningIndex(void);
static int HandleDestroyScreeningIndex(void);
static int HandleScreenWindow(void);
static int HandleScreenSegmentWindow(void);

static const MethodDescriptor kMethodTable[] = {
  {
    "invoke",
    &invoke,
    kMethod_invoke_input_ports,
    1u,
    kMethod_invoke_output_ports,
    1u,
    true,
    "request",
    "response"
  },
  {
    "assess_conjunction",
    &HandleAssessConjunction,
    kMethod_pair_request_input_ports,
    1u,
    kMethod_result_output_ports,
    1u,
    false,
    nullptr,
    nullptr
  },
  {
    "emit_cdm",
    &HandleEmitCdm,
    kMethod_pair_request_input_ports,
    1u,
    kMethod_cdm_output_ports,
    1u,
    false,
    nullptr,
    nullptr
  },
  {
    "find_tca",
    &HandleFindTca,
    kMethod_pair_request_input_ports,
    1u,
    kMethod_result_output_ports,
    1u,
    false,
    nullptr,
    nullptr
  },
  {
    "alfano_max_probability",
    &HandleAlfanoMaxProbability,
    kMethod_pair_request_input_ports,
    1u,
    kMethod_result_output_ports,
    1u,
    false,
    nullptr,
    nullptr
  },
  {
    "compute_pc",
    &HandleComputePc,
    kMethod_pair_request_input_ports,
    1u,
    kMethod_result_output_ports,
    1u,
    false,
    nullptr,
    nullptr
  },
  {
    "screen_catalog",
    &HandleScreenCatalog,
    kMethod_screen_catalog_input_ports,
    2u,
    kMethod_screen_catalog_output_ports,
    2u,
    false,
    nullptr,
    nullptr
  },
  {
    "prepare_screening_index",
    &HandlePrepareScreeningIndex,
    kMethod_prepare_screening_index_input_ports,
    2u,
    kMethod_result_output_ports,
    1u,
    false,
    nullptr,
    nullptr
  },
  {
    "prepare_segment_screening_index",
    &HandlePrepareSegmentScreeningIndex,
    kMethod_prepare_segment_screening_index_input_ports,
    3u,
    kMethod_result_output_ports,
    1u,
    false,
    nullptr,
    nullptr
  },
  {
    "prepare_sample_screening_index",
    &HandlePrepareSampleScreeningIndex,
    kMethod_prepare_sample_screening_index_input_ports,
    3u,
    kMethod_result_output_ports,
    1u,
    false,
    nullptr,
    nullptr
  },
  {
    "destroy_screening_index",
    &HandleDestroyScreeningIndex,
    kMethod_destroy_screening_index_input_ports,
    1u,
    nullptr,
    0u,
    false,
    nullptr,
    nullptr
  },
  {
    "screen_window",
    &HandleScreenWindow,
    kMethod_screen_window_input_ports,
    1u,
    kMethod_result_output_ports,
    1u,
    false,
    nullptr,
    nullptr
  },
  {
    "screen_segment_window",
    &HandleScreenSegmentWindow,
    kMethod_screen_window_input_ports,
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

static constexpr uint16_t kAlignedBinaryAlignment = 8;

static const InputFrameOwned *FindInputFrame(const char *port_id, uint32_t ordinal = 0u) {
  if (!port_id || !port_id[0]) {
    return nullptr;
  }
  uint32_t seen = 0u;
  for (const auto &frame : g_invoke_context.inputs) {
    if (frame.port_id != port_id) {
      continue;
    }
    if (seen == ordinal) {
      return &frame;
    }
    seen += 1u;
  }
  return nullptr;
}

template <typename Table>
static const Table *DecodeFlatbufferInput(
  const InputFrameOwned *frame,
  const char *port_id,
  const char *expected_file_identifier,
  const char *friendly_name
) {
  if (!frame) {
    SetError(
      "missing-required-input",
      std::string("Missing required input port: ") + (port_id ? port_id : "<unknown>")
    );
    return nullptr;
  }
  if (frame->payload.empty()) {
    SetError(
      "invalid-request-frame",
      std::string(friendly_name ? friendly_name : "input payload") + " is empty."
    );
    return nullptr;
  }
  if (expected_file_identifier &&
      expected_file_identifier[0] &&
      !frame->file_identifier.empty() &&
      frame->file_identifier != expected_file_identifier) {
    SetError(
      "invalid-request-frame",
      std::string(friendly_name ? friendly_name : "input payload") +
        " expected file identifier " + expected_file_identifier +
        " but received " + frame->file_identifier + "."
    );
    return nullptr;
  }

  ::flatbuffers::Verifier verifier(frame->payload.data(), frame->payload.size());
  if (!verifier.template VerifyBuffer<Table>(expected_file_identifier)) {
    SetError(
      "invalid-request-frame",
      std::string("FlatBuffer verification failed for ") +
        (friendly_name ? friendly_name : "input payload") + "."
    );
    return nullptr;
  }
  return ::flatbuffers::GetRoot<Table>(frame->payload.data());
}

static bool PushAlignedBinaryOutput(
  const char *port_id,
  const char *schema_name,
  const char *file_identifier,
  const char *root_type_name,
  const ::flatbuffers::FlatBufferBuilder &builder
) {
  return plugin_push_output_typed(
           port_id,
           schema_name,
           file_identifier,
           static_cast<uint32_t>(orbpro::stream::PayloadWireFormat_AlignedBinary),
           root_type_name,
           0,
           static_cast<uint32_t>(builder.GetSize()),
           kAlignedBinaryAlignment,
           builder.GetBufferPointer(),
           static_cast<uint32_t>(builder.GetSize())
         ) >= 0;
}

static conjunction::TLE DecodeTleRecord(const orbpro::conjunction::TleRecord *record) {
  return conjunction::parse_tle(
    record && record->name() ? record->name()->str() : std::string(),
    record && record->line1() ? record->line1()->str() : std::string(),
    record && record->line2() ? record->line2()->str() : std::string()
  );
}

static std::shared_ptr<conjunction::EphemerisSource> DecodePropagatedTrack(
  const orbpro::conjunction::PropagatedTrack *track
) {
  if (!track || !track->samples()) {
    return nullptr;
  }

  std::vector<conjunction::EphemerisPoint> points;
  points.reserve(track->samples()->size());
  for (const auto *sample : *track->samples()) {
    if (!sample) {
      continue;
    }
    points.push_back(
      conjunction::EphemerisPoint{
        sample->jd(),
        sample->xKm(),
        sample->yKm(),
        sample->zKm(),
        sample->vxKmS(),
        sample->vyKmS(),
        sample->vzKmS(),
      }
    );
  }
  if (points.size() < 2u) {
    return nullptr;
  }

  return std::make_shared<conjunction::OEMEphemerisSource>(
    std::move(points),
    track->objectName() ? track->objectName()->str() : std::string(),
    track->objectId() ? track->objectId()->str() : std::string(),
    track->noradCatId()
  );
}

static std::string ReadFlatbufferString(const ::flatbuffers::String *value) {
  return value ? value->str() : std::string();
}

static conjunction::GPElement DecodeGpRecord(const orbpro::conjunction::GpRecord *record) {
  if (!record) {
    throw std::runtime_error("Conjunction screen_catalog request is missing a GP record.");
  }

  conjunction::GPElement gp{};
  gp.object_name = ReadFlatbufferString(record->objectName());
  gp.object_id = ReadFlatbufferString(record->objectId());
  gp.epoch_iso = ReadFlatbufferString(record->epoch());
  gp.epoch_jd = gp.epoch_iso.empty() ? 0.0 : conjunction::iso_to_jd(gp.epoch_iso);
  gp.mean_motion = record->meanMotion();
  gp.eccentricity = record->eccentricity();
  gp.inclination = record->inclination();
  gp.ra_of_asc_node = record->raOfAscNode();
  gp.arg_of_pericenter = record->argOfPericenter();
  gp.mean_anomaly = record->meanAnomaly();
  gp.ephemeris_type = record->ephemerisType();
  const auto classification = ReadFlatbufferString(record->classificationType());
  gp.classification_type = classification.empty() ? 'U' : classification.front();
  gp.norad_cat_id = record->noradCatId();
  gp.element_set_no = record->elementSetNo();
  gp.rev_at_epoch = record->revAtEpoch();
  gp.bstar = record->bstar();
  gp.mean_motion_dot = record->meanMotionDot();
  gp.mean_motion_ddot = record->meanMotionDdot();
  conjunction::compute_derived(gp);
  return gp;
}

static conjunction::GPElement DecodeTleRecordAsGp(
  const orbpro::conjunction::TleRecord *record
) {
  const auto tle = DecodeTleRecord(record);
  conjunction::GPElement gp{};
  gp.object_name = tle.name;
  gp.epoch_jd = tle.epoch_jd;
  gp.epoch_iso = tle.epoch_jd > 0.0 ? conjunction::jd_to_iso(tle.epoch_jd) : std::string();
  gp.mean_motion = tle.mean_motion;
  gp.eccentricity = tle.eccentricity;
  gp.inclination = tle.inclination;
  gp.ra_of_asc_node = tle.raan;
  gp.arg_of_pericenter = tle.arg_perigee;
  gp.mean_anomaly = tle.mean_anomaly;
  gp.ephemeris_type = 0;
  gp.classification_type =
    (tle.line1.size() > 7 && std::isspace(static_cast<unsigned char>(tle.line1[7])) == 0)
      ? tle.line1[7]
      : 'U';
  gp.norad_cat_id = tle.norad_cat_id;
  gp.bstar = tle.bstar;
  conjunction::compute_derived(gp);
  return gp;
}

static conjunction::GPElement DecodeOmmRecord(const OMM *record) {
  if (!record) {
    throw std::runtime_error("Conjunction screen_catalog request is missing an OMM record.");
  }

  conjunction::GPElement gp{};
  gp.object_name = ReadFlatbufferString(record->OBJECT_NAME());
  gp.object_id = ReadFlatbufferString(record->OBJECT_ID());
  gp.epoch_iso = ReadFlatbufferString(record->EPOCH());
  gp.epoch_jd = gp.epoch_iso.empty() ? 0.0 : conjunction::iso_to_jd(gp.epoch_iso);
  gp.mean_motion = record->MEAN_MOTION();
  gp.eccentricity = record->ECCENTRICITY();
  gp.inclination = record->INCLINATION();
  gp.ra_of_asc_node = record->RA_OF_ASC_NODE();
  gp.arg_of_pericenter = record->ARG_OF_PERICENTER();
  gp.mean_anomaly = record->MEAN_ANOMALY();
  gp.ephemeris_type = static_cast<int>(record->EPHEMERIS_TYPE());
  const auto classification = ReadFlatbufferString(record->CLASSIFICATION_TYPE());
  gp.classification_type = classification.empty() ? 'U' : classification.front();
  gp.norad_cat_id = static_cast<int>(record->NORAD_CAT_ID());
  gp.element_set_no = static_cast<int>(record->ELEMENT_SET_NO());
  gp.rev_at_epoch = static_cast<int>(record->REV_AT_EPOCH());
  gp.bstar = record->BSTAR();
  gp.mean_motion_dot = record->MEAN_MOTION_DOT();
  gp.mean_motion_ddot = record->MEAN_MOTION_DDOT();
  conjunction::compute_derived(gp);
  return gp;
}

static bool AppendOmmPayload(
  const uint8_t *payload,
  size_t payload_size,
  std::vector<conjunction::GPElement> *catalog
) {
  if (!payload || payload_size == 0u || !catalog) {
    return false;
  }
  if (payload_size < sizeof(flatbuffers::uoffset_t) + flatbuffers::kFileIdentifierLength ||
      !OMMBufferHasIdentifier(payload)) {
    if (payload_size < (sizeof(flatbuffers::uoffset_t) * 2u) + flatbuffers::kFileIdentifierLength ||
        !SizePrefixedOMMBufferHasIdentifier(payload)) {
      return false;
    }
    {
      ::flatbuffers::Verifier verifier(payload, payload_size);
      if (VerifySizePrefixedOMMBuffer(verifier)) {
        catalog->push_back(DecodeOmmRecord(GetSizePrefixedOMM(payload)));
        return true;
      }
    }
    const uint8_t *inner_payload = payload + sizeof(flatbuffers::uoffset_t);
    const size_t inner_size = payload_size - sizeof(flatbuffers::uoffset_t);
    ::flatbuffers::Verifier verifier(inner_payload, inner_size);
    if (OMMBufferHasIdentifier(inner_payload) && VerifyOMMBuffer(verifier)) {
      catalog->push_back(DecodeOmmRecord(GetOMM(inner_payload)));
      return true;
    }
    return false;
  }
  ::flatbuffers::Verifier verifier(payload, payload_size);
  if (!VerifyOMMBuffer(verifier)) {
    return false;
  }
  catalog->push_back(DecodeOmmRecord(GetOMM(payload)));
  return true;
}

static uint32_t ReadUint32LengthPrefix(const uint8_t *bytes, bool big_endian) {
  if (big_endian) {
    return (static_cast<uint32_t>(bytes[0]) << 24u) |
           (static_cast<uint32_t>(bytes[1]) << 16u) |
           (static_cast<uint32_t>(bytes[2]) << 8u) |
           static_cast<uint32_t>(bytes[3]);
  }
  return static_cast<uint32_t>(bytes[0]) |
         (static_cast<uint32_t>(bytes[1]) << 8u) |
         (static_cast<uint32_t>(bytes[2]) << 16u) |
         (static_cast<uint32_t>(bytes[3]) << 24u);
}

static bool DecodeOmmLengthPrefixedStream(
  const uint8_t *bytes,
  size_t size,
  bool big_endian,
  std::vector<conjunction::GPElement> *catalog
) {
  if (!bytes || size == 0u || !catalog) {
    return false;
  }

  std::vector<conjunction::GPElement> decoded;
  size_t offset = 0u;
  while (offset + sizeof(uint32_t) <= size) {
    const uint32_t payload_size =
      ReadUint32LengthPrefix(bytes + offset, big_endian);
    offset += sizeof(uint32_t);
    if (payload_size == 0u || offset + payload_size > size) {
      return false;
    }
    if (!AppendOmmPayload(bytes + offset, payload_size, &decoded)) {
      return false;
    }
    offset += payload_size;
  }

  if (offset != size || decoded.empty()) {
    return false;
  }

  catalog->swap(decoded);
  return true;
}

static bool DecodeOmmCatalogFrame(
  const InputFrameOwned *frame,
  std::vector<conjunction::GPElement> *catalog
) {
  if (!frame || frame->payload.empty() || !catalog) {
    SetError("missing-catalog-input", "screen_catalog direct catalog mode requires a catalog input frame.");
    return false;
  }

  const auto *bytes = frame->payload.data();
  const size_t size = frame->payload.size();
  catalog->clear();

  if (AppendOmmPayload(bytes, size, catalog)) {
    return true;
  }

  if (DecodeOmmLengthPrefixedStream(bytes, size, false, catalog) ||
      DecodeOmmLengthPrefixedStream(bytes, size, true, catalog)) {
    return true;
  }

  SetError(
    "invalid-catalog-frame",
    "screen_catalog catalog frame did not contain OMM payloads in single-buffer, uint32le stream, or uint32be SDN data API stream format."
  );
  return false;
}

static void AppendGpRecords(
  std::vector<conjunction::GPElement> *target,
  const flatbuffers::Vector<flatbuffers::Offset<orbpro::conjunction::GpRecord>> *records
) {
  if (!target || !records) {
    return;
  }
  target->reserve(target->size() + records->size());
  for (const auto *record : *records) {
    target->push_back(DecodeGpRecord(record));
  }
}

static void AppendTleRecordsAsGps(
  std::vector<conjunction::GPElement> *target,
  const flatbuffers::Vector<flatbuffers::Offset<orbpro::conjunction::TleRecord>> *records
) {
  if (!target || !records) {
    return;
  }
  target->reserve(target->size() + records->size());
  for (const auto *record : *records) {
    target->push_back(DecodeTleRecordAsGp(record));
  }
}

static void AppendTrackSources(
  std::vector<std::shared_ptr<conjunction::EphemerisSource>> *target,
  const flatbuffers::Vector<flatbuffers::Offset<orbpro::conjunction::PropagatedTrack>> *tracks
) {
  if (!target || !tracks) {
    return;
  }
  target->reserve(target->size() + tracks->size());
  for (const auto *track : *tracks) {
    auto source = DecodePropagatedTrack(track);
    if (source) {
      target->push_back(std::move(source));
    }
  }
}

static void AppendGpSources(
  std::vector<std::shared_ptr<conjunction::EphemerisSource>> *target,
  const std::vector<conjunction::GPElement> &records
) {
  if (!target) {
    return;
  }
  target->reserve(target->size() + records.size());
  for (const auto &record : records) {
    target->push_back(std::make_shared<conjunction::GPEphemerisSource>(record));
  }
}

static void AppendOrderedCatalogRange(
  std::vector<conjunction::GPElement> *target,
  const std::vector<conjunction::GPElement> &catalog,
  const flatbuffers::Vector<uint32_t> *ordered_indices,
  uint32_t start,
  uint32_t end
) {
  if (!target || !ordered_indices || catalog.empty()) {
    return;
  }
  const uint32_t clamped_start = std::min<uint32_t>(start, ordered_indices->size());
  const uint32_t clamped_end = std::max<uint32_t>(
    clamped_start,
    std::min<uint32_t>(end, ordered_indices->size())
  );
  target->reserve(target->size() + (clamped_end - clamped_start));
  for (uint32_t order_index = clamped_start; order_index < clamped_end; order_index += 1u) {
    const uint32_t catalog_index = ordered_indices->Get(order_index);
    if (catalog_index < catalog.size()) {
      target->push_back(catalog[catalog_index]);
    }
  }
}

static conjunction::ScreeningConfig DecodeScreeningConfig(
  const orbpro::conjunction::ConjunctionScreenCatalogRequest *request
) {
  conjunction::ScreeningConfig config{};
  config.start_jd = request->startJd();
  config.duration_days = request->durationDays();
  config.threshold_km = request->thresholdKm();
  config.coarse_step_sec = request->coarseStepSec();
  config.fine_tol_sec = request->fineTolSec();
  config.combined_radius_m = request->combinedRadiusM();
  config.num_threads = std::max(1, request->numThreads());
  config.use_kdtree = request->useKdTree();
  config.use_dynamic_window = request->useDynamicWindow();
  config.use_perigee_filter = request->usePerigeeFilter();
  return config;
}

static void ScreenEphemerisSourceRange(
  const std::vector<std::shared_ptr<conjunction::EphemerisSource>> &primaries,
  const std::vector<std::shared_ptr<conjunction::EphemerisSource>> &secondaries,
  const conjunction::ScreeningConfig &config,
  std::atomic<size_t> *next_primary_index,
  std::vector<conjunction::ConjunctionEvent2> *events_out,
  uint64_t *pairs_screened_out
) {
  conjunction::ConjunctionEngine engine;
  std::vector<conjunction::ConjunctionEvent2> local_events;
  uint64_t local_pairs_screened = 0u;

  while (true) {
    const size_t primary_index = next_primary_index->fetch_add(1u, std::memory_order_relaxed);
    if (primary_index >= primaries.size()) {
      break;
    }
    const auto &primary = primaries[primary_index];
    if (!primary) {
      continue;
    }

    if (secondaries.empty()) {
      for (size_t secondary_index = primary_index + 1u;
           secondary_index < primaries.size();
           secondary_index += 1u) {
        const auto &secondary = primaries[secondary_index];
        if (!secondary) {
          continue;
        }
        local_pairs_screened += 1u;
        try {
          const auto event = engine.assess(
            *primary,
            *secondary,
            config.start_jd,
            config.duration_days
          );
          if (conjunction::is_conjunction_within_threshold(
                event.miss_distance_km,
                config.threshold_km)) {
            local_events.push_back(event);
          }
        } catch (...) {
        }
      }
    } else {
      for (const auto &secondary : secondaries) {
        if (!secondary) {
          continue;
        }
        if (primary->norad_id() != 0 && primary->norad_id() == secondary->norad_id()) {
          continue;
        }
        local_pairs_screened += 1u;
        try {
          const auto event = engine.assess(
            *primary,
            *secondary,
            config.start_jd,
            config.duration_days
          );
          if (conjunction::is_conjunction_within_threshold(
                event.miss_distance_km,
                config.threshold_km)) {
            local_events.push_back(event);
          }
        } catch (...) {
        }
      }
    }
  }

  if (events_out) {
    *events_out = std::move(local_events);
  }
  if (pairs_screened_out) {
    *pairs_screened_out = local_pairs_screened;
  }
}

static std::vector<conjunction::ConjunctionEvent2> ScreenEphemerisSources(
  const std::vector<std::shared_ptr<conjunction::EphemerisSource>> &primaries,
  const std::vector<std::shared_ptr<conjunction::EphemerisSource>> &secondaries,
  const conjunction::ScreeningConfig &config,
  conjunction::ScreeningStats *stats_out
) {
  const auto start_time = std::chrono::high_resolution_clock::now();
  std::vector<conjunction::ConjunctionEvent2> events;
  uint64_t pairs_screened = 0u;

  const size_t schedulable_primary_count = primaries.size();
  if (schedulable_primary_count > 0u) {
    const int requested_threads = std::max(1, config.num_threads);
    const int worker_count =
#ifdef CONJUNCTION_SINGLE_THREAD
      1;
#else
      std::max(
        1,
        std::min(
          requested_threads,
          static_cast<int>(schedulable_primary_count)
        )
      );
#endif
    std::atomic<size_t> next_primary_index{0u};
    std::vector<std::vector<conjunction::ConjunctionEvent2>> thread_events(worker_count);
    std::vector<uint64_t> thread_pair_counts(worker_count, 0u);

#ifdef CONJUNCTION_SINGLE_THREAD
    ScreenEphemerisSourceRange(
      primaries,
      secondaries,
      config,
      &next_primary_index,
      &thread_events[0],
      &thread_pair_counts[0]
    );
#else
    std::vector<std::thread> threads;
    threads.reserve(static_cast<size_t>(worker_count));
    for (int worker_index = 0; worker_index < worker_count; worker_index += 1) {
      threads.emplace_back([&, worker_index]() {
        ScreenEphemerisSourceRange(
          primaries,
          secondaries,
          config,
          &next_primary_index,
          &thread_events[worker_index],
          &thread_pair_counts[worker_index]
        );
      });
    }
    for (auto &thread : threads) {
      thread.join();
    }
#endif

    size_t event_count = 0u;
    for (int worker_index = 0; worker_index < worker_count; worker_index += 1) {
      pairs_screened += thread_pair_counts[worker_index];
      event_count += thread_events[worker_index].size();
    }
    events.reserve(event_count);
    for (auto &worker_events : thread_events) {
      events.insert(
        events.end(),
        std::make_move_iterator(worker_events.begin()),
        std::make_move_iterator(worker_events.end())
      );
    }
  }

  std::sort(
    events.begin(),
    events.end(),
    [](const conjunction::ConjunctionEvent2 &left,
       const conjunction::ConjunctionEvent2 &right) {
      return left.pc.max_probability > right.pc.max_probability;
    }
  );

  if (stats_out) {
    const auto end_time = std::chrono::high_resolution_clock::now();
    stats_out->total_objects = primaries.size() + secondaries.size();
    stats_out->pairs_screened = pairs_screened;
    stats_out->pairs_prefiltered = 0u;
    stats_out->kdtree_candidates = pairs_screened;
    stats_out->tca_refined = pairs_screened;
    stats_out->conjunctions_found = events.size();
    stats_out->propagations = 0u;
    stats_out->elapsed_ms =
      std::chrono::duration<double, std::milli>(end_time - start_time).count();
  }

  return events;
}

static std::unique_ptr<orbpro::conjunction::ConjunctionEventT> ToFlatbufferEvent(
  const conjunction::ConjunctionEvent &event
) {
  auto output = std::make_unique<orbpro::conjunction::ConjunctionEventT>();
  output->obj1Name = event.obj1.name;
  output->obj1Id =
    event.obj1.norad_cat_id > 0 ? std::to_string(event.obj1.norad_cat_id) : std::string();
  output->obj1Norad = event.obj1.norad_cat_id;
  output->obj2Name = event.obj2.name;
  output->obj2Id =
    event.obj2.norad_cat_id > 0 ? std::to_string(event.obj2.norad_cat_id) : std::string();
  output->obj2Norad = event.obj2.norad_cat_id;
  output->tcaJd = event.tca_jd;
  output->tcaIso = event.tca_iso.empty() ? conjunction::jd_to_iso(event.tca_jd) : event.tca_iso;
  output->minRangeKm = event.min_range_km;
  output->relSpeedKms = event.rel_speed_kms;
  output->maxProbability = event.max_probability;
  output->dilutionThresholdKm = event.dilution_threshold_km;
  output->probabilityMethod = event.probability_method;
  output->relPosR = event.rel_pos_r;
  output->relPosT = event.rel_pos_t;
  output->relPosN = event.rel_pos_n;
  output->relVelR = event.rel_vel_r;
  output->relVelT = event.rel_vel_t;
  output->relVelN = event.rel_vel_n;
  output->covR1 = event.cov_r1;
  output->covT1 = event.cov_t1;
  output->covN1 = event.cov_n1;
  output->covR2 = event.cov_r2;
  output->covT2 = event.cov_t2;
  output->covN2 = event.cov_n2;
  output->dse1 = event.dse1;
  output->dse2 = event.dse2;
  return output;
}

static std::unique_ptr<orbpro::conjunction::ConjunctionEventT> ToFlatbufferEvent(
  const conjunction::ConjunctionEvent2 &event
) {
  auto output = std::make_unique<orbpro::conjunction::ConjunctionEventT>();
  output->obj1Name = event.obj1_name;
  output->obj1Id = event.obj1_id;
  output->obj1Norad = event.obj1_norad;
  output->obj2Name = event.obj2_name;
  output->obj2Id = event.obj2_id;
  output->obj2Norad = event.obj2_norad;
  output->tcaJd = event.tca_jd;
  output->tcaIso = event.tca_iso.empty() ? conjunction::jd_to_iso(event.tca_jd) : event.tca_iso;
  output->minRangeKm = event.miss_distance_km;
  output->relSpeedKms = event.relative_speed_kms;
  output->maxProbability = event.pc.max_probability;
  output->dilutionThresholdKm = 0.0;
  output->probabilityMethod = event.pc.method;
  output->relPosR = event.rel_r;
  output->relPosT = event.rel_t;
  output->relPosN = event.rel_n;
  output->relVelR = event.rel_vr;
  output->relVelT = event.rel_vt;
  output->relVelN = event.rel_vn;
  output->covR1 = std::sqrt(std::max(0.0, event.cov1.data[0])) * 1000.0;
  output->covT1 = std::sqrt(std::max(0.0, event.cov1.data[4])) * 1000.0;
  output->covN1 = std::sqrt(std::max(0.0, event.cov1.data[8])) * 1000.0;
  output->covR2 = std::sqrt(std::max(0.0, event.cov2.data[0])) * 1000.0;
  output->covT2 = std::sqrt(std::max(0.0, event.cov2.data[4])) * 1000.0;
  output->covN2 = std::sqrt(std::max(0.0, event.cov2.data[8])) * 1000.0;
  output->dse1 = event.dse1;
  output->dse2 = event.dse2;
  return output;
}

static std::unique_ptr<orbpro::conjunction::ScreeningStatsT> ToFlatbufferStats(
  const conjunction::ScreeningStats &stats
) {
  auto output = std::make_unique<orbpro::conjunction::ScreeningStatsT>();
  output->totalObjects = static_cast<uint32_t>(stats.total_objects);
  output->pairsScreened = static_cast<uint32_t>(stats.pairs_screened);
  output->pairsPrefiltered = static_cast<uint32_t>(stats.pairs_prefiltered);
  output->kdtreeCandidates = static_cast<uint32_t>(stats.kdtree_candidates);
  output->tcaRefined = static_cast<uint32_t>(stats.tca_refined);
  output->conjunctionsFound = static_cast<uint32_t>(stats.conjunctions_found);
  output->propagations = static_cast<uint32_t>(stats.propagations);
  output->elapsedMs = stats.elapsed_ms;
  return output;
}

static ::flatbuffers::FlatBufferBuilder BuildEventPayload(
  const conjunction::ConjunctionEvent &event
) {
  ::flatbuffers::FlatBufferBuilder builder(1024);
  const auto event_offset = orbpro::conjunction::ConjunctionEvent::Pack(
    builder,
    ToFlatbufferEvent(event).get()
  );
  builder.Finish(event_offset, "CAEV");
  return builder;
}

static ::flatbuffers::FlatBufferBuilder BuildEventPayload(
  const conjunction::ConjunctionEvent2 &event
) {
  ::flatbuffers::FlatBufferBuilder builder(1024);
  const auto event_offset = orbpro::conjunction::ConjunctionEvent::Pack(
    builder,
    ToFlatbufferEvent(event).get()
  );
  builder.Finish(event_offset, "CAEV");
  return builder;
}

static ::flatbuffers::FlatBufferBuilder BuildFindTcaPayload(double tca_jd, const std::string &tca_iso) {
  ::flatbuffers::FlatBufferBuilder builder(256);
  const auto root = orbpro::conjunction::CreateConjunctionFindTcaResultDirect(
    builder,
    tca_jd,
    tca_iso.c_str()
  );
  builder.Finish(root, "CATR");
  return builder;
}

static ::flatbuffers::FlatBufferBuilder BuildAlfanoPayload(const conjunction::ProbResult &result) {
  ::flatbuffers::FlatBufferBuilder builder(256);
  const auto root = orbpro::conjunction::CreateConjunctionAlfanoResult(
    builder,
    result.max_probability,
    result.dilution_threshold_km,
    result.sigma_star_km
  );
  builder.Finish(root, "CAAL");
  return builder;
}

static ::flatbuffers::FlatBufferBuilder BuildPcPayload(const conjunction::PcResult &result) {
  ::flatbuffers::FlatBufferBuilder builder(256);
  const auto method = builder.CreateString(result.method);
  const auto root = orbpro::conjunction::CreateConjunctionPcResult(
    builder,
    result.probability,
    method,
    result.converged,
    result.iterations,
    result.max_probability,
    result.mahalanobis_2d
  );
  builder.Finish(root, "CAPC");
  return builder;
}

static ::flatbuffers::FlatBufferBuilder BuildPrepareScreeningIndexPayload(
  const conjunction::ResidentScreeningIndexBuildResult &result
) {
  ::flatbuffers::FlatBufferBuilder builder(256);
  const auto root = orbpro::conjunction::CreateConjunctionPrepareScreeningIndexResult(
    builder,
    result.screening_index_handle,
    result.source_count,
    result.candidate_pair_count
  );
  builder.Finish(root, "CSPR");
  return builder;
}

static ::flatbuffers::FlatBufferBuilder BuildScreenCatalogResultPayload(
  uint32_t objects_parsed,
  const std::vector<conjunction::ConjunctionEvent> &events,
  const conjunction::ScreeningStats &stats
) {
  orbpro::conjunction::ConjunctionScreenCatalogResultT result{};
  result.objectsParsed = objects_parsed;
  result.conjunctionsFound = static_cast<uint32_t>(events.size());
  result.stats = ToFlatbufferStats(stats);
  result.conjunctions.reserve(events.size());
  for (const auto &event : events) {
    result.conjunctions.emplace_back(ToFlatbufferEvent(event));
  }

  ::flatbuffers::FlatBufferBuilder builder(4096);
  const auto root = orbpro::conjunction::ConjunctionScreenCatalogResult::Pack(
    builder,
    &result
  );
  builder.Finish(root, "CASS");
  return builder;
}

static ::flatbuffers::FlatBufferBuilder BuildScreenCatalogResultPayload(
  uint32_t objects_parsed,
  const std::vector<conjunction::ConjunctionEvent2> &events,
  const conjunction::ScreeningStats &stats
) {
  orbpro::conjunction::ConjunctionScreenCatalogResultT result{};
  result.objectsParsed = objects_parsed;
  result.conjunctionsFound = static_cast<uint32_t>(events.size());
  result.stats = ToFlatbufferStats(stats);
  result.conjunctions.reserve(events.size());
  for (const auto &event : events) {
    result.conjunctions.emplace_back(ToFlatbufferEvent(event));
  }

  ::flatbuffers::FlatBufferBuilder builder(4096);
  const auto root = orbpro::conjunction::ConjunctionScreenCatalogResult::Pack(
    builder,
    &result
  );
  builder.Finish(root, "CASS");
  return builder;
}

static const orbpro::conjunction::ConjunctionPairRequest *DecodePairRequest(void) {
  return DecodeFlatbufferInput<orbpro::conjunction::ConjunctionPairRequest>(
    FindInputFrame("request"),
    "request",
    "CAPQ",
    "ConjunctionPairRequest"
  );
}

static int HandleAssessConjunction(void) {
  try {
    const auto *request = DecodePairRequest();
    if (!request) {
      return 400;
    }

    if (request->primaryTrack() && request->secondaryTrack()) {
      auto primary = DecodePropagatedTrack(request->primaryTrack());
      auto secondary = DecodePropagatedTrack(request->secondaryTrack());
      if (!primary || !secondary) {
        SetError("invalid-track", "Propagated conjunction requests require at least two samples per track.");
        return 400;
      }

      conjunction::ConjunctionEngine engine;
      engine.set_pc_method("alfano");
      engine.set_combined_radius_m(request->radius1M(), request->radius2M());
      const auto event = engine.assess(
        *primary,
        *secondary,
        request->startJd(),
        request->durationDays()
      );

      const auto payload = BuildEventPayload(event);
      if (!PushAlignedBinaryOutput(
            "result",
            "orbpro.conjunction.ConjunctionEvent",
            "CAEV",
            "ConjunctionEvent",
            payload
          )) {
        SetError("output-failed", "Failed to push conjunction event output.");
        return 500;
      }
      return 0;
    }

    const auto event = conjunction::assess_conjunction(
      DecodeTleRecord(request->tle1()),
      DecodeTleRecord(request->tle2()),
      request->startJd(),
      request->durationDays(),
      request->radius1M(),
      request->radius2M()
    );
    const auto payload = BuildEventPayload(event);
    if (!PushAlignedBinaryOutput(
          "result",
          "orbpro.conjunction.ConjunctionEvent",
          "CAEV",
          "ConjunctionEvent",
          payload
        )) {
      SetError("output-failed", "Failed to push conjunction event output.");
      return 500;
    }
    return 0;
  } catch (const std::exception &ex) {
    SetError("assess-conjunction-failed", ex.what());
    return 500;
  }
}

static int HandleEmitCdm(void) {
  try {
    const auto *request = DecodePairRequest();
    if (!request) {
      return 400;
    }
    if (request->primaryTrack() || request->secondaryTrack()) {
      SetError("unsupported-request", "emit_cdm currently requires TLE-backed conjunction requests.");
      return 400;
    }

    const auto event = conjunction::assess_conjunction(
      DecodeTleRecord(request->tle1()),
      DecodeTleRecord(request->tle2()),
      request->startJd(),
      request->durationDays(),
      request->radius1M(),
      request->radius2M()
    );

    std::vector<uint8_t> payload(4096u);
    int32_t written = conjunction::conjunction_to_cdm(
      event,
      payload.data(),
      static_cast<uint32_t>(payload.size())
    );
    while (written == -2) {
      payload.resize(payload.size() * 2u);
      written = conjunction::conjunction_to_cdm(
        event,
        payload.data(),
        static_cast<uint32_t>(payload.size())
      );
    }
    if (written < 0) {
      SetError("emit-cdm-failed", "Failed to serialize conjunction event as CDM.");
      return 500;
    }
    payload.resize(static_cast<size_t>(written));

    if (plugin_push_output_typed(
          "cdm",
          "CDM.fbs",
          "$CDM",
          static_cast<uint32_t>(orbpro::stream::PayloadWireFormat_AlignedBinary),
          "CDM",
          0,
          static_cast<uint32_t>(payload.size()),
          kAlignedBinaryAlignment,
          payload.data(),
          static_cast<uint32_t>(payload.size())
        ) < 0) {
      SetError("output-failed", "Failed to push CDM output.");
      return 500;
    }
    return 0;
  } catch (const std::exception &ex) {
    SetError("emit-cdm-failed", ex.what());
    return 500;
  }
}

static int HandleFindTca(void) {
  try {
    const auto *request = DecodePairRequest();
    if (!request) {
      return 400;
    }

    double tca_jd = 0.0;
    if (request->primaryTrack() && request->secondaryTrack()) {
      auto primary = DecodePropagatedTrack(request->primaryTrack());
      auto secondary = DecodePropagatedTrack(request->secondaryTrack());
      if (!primary || !secondary) {
        SetError("invalid-track", "Propagated conjunction requests require at least two samples per track.");
        return 400;
      }
      conjunction::ConjunctionEngine engine;
      tca_jd = engine.find_tca(
        *primary,
        *secondary,
        request->startJd(),
        request->durationDays(),
        request->coarseStepSec()
      );
    } else {
      tca_jd = conjunction::find_tca(
        DecodeTleRecord(request->tle1()),
        DecodeTleRecord(request->tle2()),
        request->startJd(),
        request->durationDays(),
        request->coarseStepSec(),
        request->fineTolSec()
      );
    }

    const auto payload = BuildFindTcaPayload(tca_jd, conjunction::jd_to_iso(tca_jd));
    if (!PushAlignedBinaryOutput(
          "result",
          "orbpro.conjunction.ConjunctionFindTcaResult",
          "CATR",
          "ConjunctionFindTcaResult",
          payload
        )) {
      SetError("output-failed", "Failed to push find_tca output.");
      return 500;
    }
    return 0;
  } catch (const std::exception &ex) {
    SetError("find-tca-failed", ex.what());
    return 500;
  }
}

static int HandleAlfanoMaxProbability(void) {
  try {
    const auto *request = DecodeFlatbufferInput<orbpro::conjunction::ConjunctionAlfanoRequest>(
      FindInputFrame("request"),
      "request",
      "CAAR",
      "ConjunctionAlfanoRequest"
    );
    if (!request) {
      return 400;
    }

    const auto result = conjunction::alfano_max_probability(
      request->missDistanceKm(),
      request->combinedRadiusKm()
    );
    const auto payload = BuildAlfanoPayload(result);
    if (!PushAlignedBinaryOutput(
          "result",
          "orbpro.conjunction.ConjunctionAlfanoResult",
          "CAAL",
          "ConjunctionAlfanoResult",
          payload
        )) {
      SetError("output-failed", "Failed to push alfano_max_probability output.");
      return 500;
    }
    return 0;
  } catch (const std::exception &ex) {
    SetError("alfano-max-probability-failed", ex.what());
    return 500;
  }
}

static int HandleComputePc(void) {
  try {
    const auto *request = DecodeFlatbufferInput<orbpro::conjunction::ConjunctionPcRequest>(
      FindInputFrame("request"),
      "request",
      "CAPR",
      "ConjunctionPcRequest"
    );
    if (!request || !request->bplane()) {
      SetError("invalid-request-frame", "ConjunctionPcRequest requires a B-plane geometry payload.");
      return 400;
    }

    conjunction::BPlaneGeometry bplane{};
    bplane.xi = request->bplane()->xi();
    bplane.zeta = request->bplane()->zeta();
    bplane.sigma_xx = request->bplane()->sigmaXx();
    bplane.sigma_xz = request->bplane()->sigmaXz();
    bplane.sigma_zz = request->bplane()->sigmaZz();
    bplane.combined_radius = request->bplane()->combinedRadius();

    const auto method_name =
      request->method() ? request->method()->str() : std::string("foster");
    auto method = conjunction::create_pc_method(method_name);
    const auto result = method->compute(bplane);
    const auto payload = BuildPcPayload(result);
    if (!PushAlignedBinaryOutput(
          "result",
          "orbpro.conjunction.ConjunctionPcResult",
          "CAPC",
          "ConjunctionPcResult",
          payload
        )) {
      SetError("output-failed", "Failed to push compute_pc output.");
      return 500;
    }
    return 0;
  } catch (const std::exception &ex) {
    SetError("compute-pc-failed", ex.what());
    return 500;
  }
}

static int HandleScreenCatalog(void) {
  try {
    const auto *request = DecodeFlatbufferInput<orbpro::conjunction::ConjunctionScreenCatalogRequest>(
      FindInputFrame("request"),
      "request",
      "CASQ",
      "ConjunctionScreenCatalogRequest"
    );
    if (!request) {
      return 400;
    }

    std::vector<conjunction::GPElement> primary_gps;
    std::vector<conjunction::GPElement> secondary_gps;
    std::vector<std::shared_ptr<conjunction::EphemerisSource>> primary_sources;
    std::vector<std::shared_ptr<conjunction::EphemerisSource>> secondary_sources;
    uint32_t objects_parsed = 0u;

    const auto *catalog_frame = FindInputFrame("catalog");
    if (catalog_frame && !catalog_frame->payload.empty()) {
      std::vector<conjunction::GPElement> catalog;
      if (!DecodeOmmCatalogFrame(catalog_frame, &catalog)) {
        return 400;
      }
      objects_parsed = static_cast<uint32_t>(catalog.size());

      const auto *ordered_indices = request->orderedCatalogIndices();
      if (ordered_indices && ordered_indices->size() > 0u) {
        const uint32_t order_count = ordered_indices->size();
        const uint32_t start = std::min<uint32_t>(request->startOrderIndex(), order_count);
        const uint32_t requested_end =
          request->endOrderIndex() > start ? request->endOrderIndex() : order_count;
        const uint32_t end = std::min<uint32_t>(requested_end, order_count);
        AppendOrderedCatalogRange(&primary_gps, catalog, ordered_indices, start, end);
        const uint32_t secondary_start = std::min<uint32_t>(start + 1u, order_count);
        AppendOrderedCatalogRange(&secondary_gps, catalog, ordered_indices, secondary_start, order_count);
      } else {
        primary_gps = catalog;
      }
    } else {
      const uint32_t primary_count =
        (request->primaryGps() ? request->primaryGps()->size() : 0u) +
        (request->primaryTles() ? request->primaryTles()->size() : 0u) +
        (request->primaryTracks() ? request->primaryTracks()->size() : 0u);
      const uint32_t secondary_count =
        (request->secondaryGps() ? request->secondaryGps()->size() : 0u) +
        (request->secondaryTles() ? request->secondaryTles()->size() : 0u) +
        (request->secondaryTracks() ? request->secondaryTracks()->size() : 0u);
      objects_parsed = primary_count + secondary_count;

      AppendGpRecords(&primary_gps, request->primaryGps());
      AppendGpRecords(&secondary_gps, request->secondaryGps());
      AppendTleRecordsAsGps(&primary_gps, request->primaryTles());
      AppendTleRecordsAsGps(&secondary_gps, request->secondaryTles());
      AppendTrackSources(&primary_sources, request->primaryTracks());
      AppendTrackSources(&secondary_sources, request->secondaryTracks());

      if (primary_count == 0u && (!secondary_gps.empty() || !secondary_sources.empty())) {
        primary_gps = secondary_gps;
        secondary_gps.clear();
        primary_sources = std::move(secondary_sources);
        secondary_sources.clear();
      }
    }

    if (objects_parsed == 0u) {
      SetError("invalid-request-frame", "screen_catalog requires at least one OMM, GP, or TLE object.");
      return 400;
    }

    conjunction::ScreeningStats stats{};
    const auto config = DecodeScreeningConfig(request);
    if (!primary_sources.empty() || !secondary_sources.empty()) {
      AppendGpSources(&primary_sources, primary_gps);
      AppendGpSources(&secondary_sources, secondary_gps);
      std::vector<conjunction::ConjunctionEvent2> source_events;
      if (primary_sources.size() > 1u || (!primary_sources.empty() && !secondary_sources.empty())) {
        source_events = ScreenEphemerisSources(primary_sources, secondary_sources, config, &stats);
      }
      stats.total_objects = objects_parsed;
      stats.conjunctions_found = source_events.size();
      const auto payload = BuildScreenCatalogResultPayload(objects_parsed, source_events, stats);
      if (!PushAlignedBinaryOutput(
            "result",
            "orbpro.conjunction.ConjunctionScreenCatalogResult",
            "CASS",
            "ConjunctionScreenCatalogResult",
            payload
          )) {
        SetError("output-failed", "Failed to push screen_catalog result.");
        return 500;
      }
      return 0;
    }

    std::vector<conjunction::ConjunctionEvent> events;
    if (primary_gps.size() > 1u || (!primary_gps.empty() && !secondary_gps.empty())) {
      conjunction::ConjunctionScreener screener(config);
      events = secondary_gps.empty()
        ? screener.screen(primary_gps)
        : screener.screen(primary_gps, secondary_gps);
      stats = screener.stats();
    }
    stats.total_objects = objects_parsed;
    stats.conjunctions_found = events.size();

    const auto payload = BuildScreenCatalogResultPayload(objects_parsed, events, stats);
    if (!PushAlignedBinaryOutput(
          "result",
          "orbpro.conjunction.ConjunctionScreenCatalogResult",
          "CASS",
          "ConjunctionScreenCatalogResult",
          payload
        )) {
      SetError("output-failed", "Failed to push screen_catalog result.");
      return 500;
    }
    return 0;
  } catch (const std::exception &ex) {
    SetError("screen-catalog-failed", ex.what());
    return 500;
  }
}

static int HandlePrepareScreeningIndex(void) {
  try {
    const auto *request = DecodeFlatbufferInput<orbpro::conjunction::ConjunctionPrepareScreeningIndexRequest>(
      FindInputFrame("request"),
      "request",
      "CSPI",
      "ConjunctionPrepareScreeningIndexRequest"
    );
    const auto *descriptions = DecodeFlatbufferInput<orbpro::propagator::PropagatorDescribeSourcesBatchResult>(
      FindInputFrame("sources"),
      "sources",
      nullptr,
      "PropagatorDescribeSourcesBatchResult"
    );
    if (!request || !descriptions) {
      return 400;
    }

    std::vector<uint32_t> primary_source_handles;
    if (request->sourceHandles()) {
      primary_source_handles.assign(
        request->sourceHandles()->begin(),
        request->sourceHandles()->end()
      );
    }

    const auto result = conjunction::prepare_resident_screening_index(
      request->catalogHandle(),
      primary_source_handles,
      descriptions
    );
    const auto payload = BuildPrepareScreeningIndexPayload(result);
    if (!PushAlignedBinaryOutput(
          "result",
          "orbpro.conjunction.ConjunctionPrepareScreeningIndexResult",
          "CSPR",
          "ConjunctionPrepareScreeningIndexResult",
          payload
        )) {
      SetError("output-failed", "Failed to push prepare_screening_index output.");
      return 500;
    }
    return 0;
  } catch (const std::exception &ex) {
    SetError("prepare-screening-index-failed", ex.what());
    return 500;
  }
}

static int HandlePrepareSegmentScreeningIndex(void) {
  try {
    const auto *request = DecodeFlatbufferInput<orbpro::conjunction::ConjunctionPrepareSegmentScreeningIndexRequest>(
      FindInputFrame("request"),
      "request",
      "CSSI",
      "ConjunctionPrepareSegmentScreeningIndexRequest"
    );
    const auto *descriptions = DecodeFlatbufferInput<orbpro::propagator::PropagatorDescribeSourcesBatchResult>(
      FindInputFrame("sources"),
      "sources",
      nullptr,
      "PropagatorDescribeSourcesBatchResult"
    );
    const auto *segments = DecodeFlatbufferInput<orbpro::propagator::PropagatorDescribeTrajectorySegmentsResult>(
      FindInputFrame("segments"),
      "segments",
      nullptr,
      "PropagatorDescribeTrajectorySegmentsResult"
    );
    if (!request || !descriptions || !segments) {
      return 400;
    }

    std::vector<uint32_t> primary_source_handles;
    if (request->primarySourceHandles()) {
      primary_source_handles.assign(
        request->primarySourceHandles()->begin(),
        request->primarySourceHandles()->end()
      );
    }

    const auto result = conjunction::prepare_resident_segment_screening_index(
      request->catalogHandle(),
      request->segmentSetHandle(),
      primary_source_handles,
      request->screeningMode(),
      descriptions,
      segments
    );
    const auto payload = BuildPrepareScreeningIndexPayload(result);
    if (!PushAlignedBinaryOutput(
          "result",
          "orbpro.conjunction.ConjunctionPrepareScreeningIndexResult",
          "CSPR",
          "ConjunctionPrepareScreeningIndexResult",
          payload
        )) {
      SetError("output-failed", "Failed to push prepare_segment_screening_index output.");
      return 500;
    }
    return 0;
  } catch (const std::exception &ex) {
    SetError("prepare-segment-screening-index-failed", ex.what());
    return 500;
  }
}

static int HandlePrepareSampleScreeningIndex(void) {
  try {
    const auto *request = DecodeFlatbufferInput<orbpro::conjunction::ConjunctionPrepareSampleScreeningIndexRequest>(
      FindInputFrame("request"),
      "request",
      "CSSM",
      "ConjunctionPrepareSampleScreeningIndexRequest"
    );
    const auto *descriptions = DecodeFlatbufferInput<orbpro::propagator::PropagatorDescribeSourcesBatchResult>(
      FindInputFrame("sources"),
      "sources",
      nullptr,
      "PropagatorDescribeSourcesBatchResult"
    );
    const auto *samples = DecodeFlatbufferInput<orbpro::propagator::PropagatorSampleTrajectoryStatesResult>(
      FindInputFrame("samples"),
      "samples",
      nullptr,
      "PropagatorSampleTrajectoryStatesResult"
    );
    if (!request || !descriptions || !samples) {
      return 400;
    }

    std::vector<uint32_t> primary_source_handles;
    if (request->primarySourceHandles()) {
      primary_source_handles.assign(
        request->primarySourceHandles()->begin(),
        request->primarySourceHandles()->end()
      );
    }

    const auto result = conjunction::prepare_resident_sample_screening_index(
      request->catalogHandle(),
      primary_source_handles,
      request->screeningMode(),
      descriptions,
      samples
    );
    const auto payload = BuildPrepareScreeningIndexPayload(result);
    if (!PushAlignedBinaryOutput(
          "result",
          "orbpro.conjunction.ConjunctionPrepareScreeningIndexResult",
          "CSPR",
          "ConjunctionPrepareScreeningIndexResult",
          payload
        )) {
      SetError("output-failed", "Failed to push prepare_sample_screening_index output.");
      return 500;
    }
    return 0;
  } catch (const std::exception &ex) {
    SetError("prepare-sample-screening-index-failed", ex.what());
    return 500;
  }
}

static int HandleDestroyScreeningIndex(void) {
  try {
    const auto *request = DecodeFlatbufferInput<orbpro::conjunction::ConjunctionDestroyScreeningIndexRequest>(
      FindInputFrame("request"),
      "request",
      "CSDI",
      "ConjunctionDestroyScreeningIndexRequest"
    );
    if (!request) {
      return 400;
    }
    if (!conjunction::destroy_resident_screening_index(request->screeningIndexHandle())) {
      SetError("unknown-screening-index", "unknown screeningIndexHandle");
      return 404;
    }
    return 0;
  } catch (const std::exception &ex) {
    SetError("destroy-screening-index-failed", ex.what());
    return 500;
  }
}

static int HandleResidentScreenWindow(bool segment_window) {
  (void)segment_window;
  try {
    const auto *request = DecodeFlatbufferInput<orbpro::conjunction::ConjunctionScreenWindowRequest>(
      FindInputFrame("request"),
      "request",
      "CSWN",
      "ConjunctionScreenWindowRequest"
    );
    if (!request) {
      return 400;
    }

    const auto *resident_index =
      conjunction::find_resident_screening_index(request->screeningIndexHandle());
    if (!resident_index) {
      SetError("unknown-screening-index", "unknown screeningIndexHandle");
      return 404;
    }

    conjunction::ScreeningConfig config{};
    config.start_jd = request->startJd();
    config.duration_days = request->durationDays();
    config.threshold_km = request->thresholdKm();
    config.num_threads = request->numThreads();
    config.coarse_step_sec = request->coarseStepSec();
    config.fine_tol_sec = request->fineTolSec();
    config.combined_radius_m = request->combinedRadiusM();
    config.progress_interval_sec = request->progressIntervalSec();

    conjunction::ScreeningStats stats{};
    const auto events = conjunction::screen_resident_index_window(
      *resident_index,
      config,
      stats
    );
    const auto payload = BuildScreenCatalogResultPayload(
      resident_index->tles.size(),
      events,
      stats
    );
    if (!PushAlignedBinaryOutput(
          "result",
          "orbpro.conjunction.ConjunctionScreenCatalogResult",
          "CASS",
          "ConjunctionScreenCatalogResult",
          payload
        )) {
      SetError("output-failed", "Failed to push resident screening result.");
      return 500;
    }
    return 0;
  } catch (const std::exception &ex) {
    SetError("screen-window-failed", ex.what());
    return 500;
  }
}

static int HandleScreenWindow(void) {
  return HandleResidentScreenWindow(false);
}

static int HandleScreenSegmentWindow(void) {
  return HandleResidentScreenWindow(true);
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
