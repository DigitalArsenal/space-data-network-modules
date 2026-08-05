#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <stdlib.h>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <flatbuffers/flatbuffers.h>

#include "sds/PIV/main_generated.h"
#include "space_data_module_invoke.h"

extern "C" int append_records(void);
extern "C" int query_records(void);
extern "C" int configure_index(void);
extern "C" int upsert_view(void);
extern "C" int compact(void);
extern "C" int configure_retention(void);
extern "C" int snapshot(void);
extern "C" int reload(void);

namespace {

constexpr payloadWireFormat kPayloadWireFormatFlatbuffer =
  static_cast<payloadWireFormat>(0);
constexpr payloadWireFormat kPayloadWireFormatAlignedBinary =
  static_cast<payloadWireFormat>(1);
constexpr bufferMutability kBufferMutabilityImmutable =
  static_cast<bufferMutability>(0);
constexpr bufferMutability kBufferMutabilitySingleWriterMutable =
  static_cast<bufferMutability>(1);
constexpr bufferMutability kBufferMutabilityAppendOnly =
  static_cast<bufferMutability>(2);
constexpr bufferOwnership kBufferOwnershipHostOwned =
  static_cast<bufferOwnership>(0);
constexpr bufferOwnership kBufferOwnershipPluginOwned =
  static_cast<bufferOwnership>(1);
constexpr bufferOwnership kBufferOwnershipTransferred =
  static_cast<bufferOwnership>(2);
constexpr pivStatus kPivStatusOk = static_cast<pivStatus>(0);
constexpr pivStatus kPivStatusNotFound = static_cast<pivStatus>(1);
constexpr pivStatus kPivStatusYielded = static_cast<pivStatus>(2);
constexpr pivStatus kPivStatusFailed = static_cast<pivStatus>(3);

struct AcceptedTypeRef {
  bool accepts_any_flatbuffer;
  const char *schema_name;
  const char *file_identifier;
  uint32_t wire_format;
  bool has_wire_format;
  const char *root_type_name;
  const char *schema_version;
  const uint8_t *schema_hash;
  uint32_t schema_hash_length;
  uint16_t fixed_string_length;
  uint32_t byte_length;
  uint16_t required_alignment;
};

struct PortRequirement {
  const char *port_id;
  bool required;
  const AcceptedTypeRef *accepted_types;
  size_t accepted_type_count;
};

struct MethodDescriptor {
  const char *method_id;
  int (*handler)(void);
  const PortRequirement *input_ports;
  size_t input_port_count;
  const PortRequirement *output_ports;
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
  std::string schema_version{};
  std::vector<uint8_t> schema_hash{};
  uint32_t type_wire_format = 0;
  // Owned storage is only used for the raw stdin shortcut path; the direct
  // invoke path points views straight into the (8-aligned) request arena.
  std::vector<uint8_t> payload{};
  const uint8_t *external_payload = nullptr;
  uint32_t external_payload_length = 0;
};

// Alignment guaranteed for every FlatBuffer base crossing the host<->module
// boundary: the host-allocated request region, the module-returned response
// pointer, and the payload arena inside each invoke envelope.
constexpr uint32_t kInvokeArenaAlignment = 8u;
// plugin_alloc hands out 16-aligned regions so frames declaring
// required_alignment up to 16 (e.g. SIMD/aligned-binary state vectors) hold
// as absolute addresses in linear memory.
constexpr uint32_t kInvokeAllocAlignment = 16u;

struct OutputFrameOwned {
  std::string port_id{};
  std::string schema_name{};
  std::string file_identifier{};
  std::string root_type_name{};
  std::string schema_version{};
  std::vector<uint8_t> schema_hash{};
  uint32_t wire_format = 0;
  uint16_t fixed_string_length = 0;
  uint32_t byte_length = 0;
  uint16_t required_alignment = 0;
  uint16_t alignment = 8;
  uint32_t generation = 0;
  bool has_frame_id = false;
  uint64_t frame_id = 0;
  uint32_t stream_id = 0;
  uint64_t sequence = 0;
  bool end_of_stream = false;
  const uint8_t *payload_ptr = nullptr;
  uint32_t payload_length = 0;
  std::vector<uint8_t> payload{};
};

struct InvokeContext {
  const MethodDescriptor *method = nullptr;
  std::vector<InputFrameOwned> inputs{};
  std::vector<OutputFrameOwned> outputs{};
  uint64_t trace_id = 0;
  uint32_t backlog_remaining = 0;
  bool yielded = false;
  bool direct_external_arena_outputs = false;
  int32_t status_code = 0;
  std::string error_code{};
  std::string error_message{};
};

struct AllocationRecord {
  uint32_t ptr = 0;
  uint32_t size = 0;
};

static const uint8_t kMethod_append_records_input_port_0_type_0_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const uint8_t kMethod_append_records_input_port_0_type_1_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const AcceptedTypeRef kMethod_append_records_input_port_0_accepted_types[] = {
  { false, "FSO.fbs", "$FSO", 0u, true, "FSO", "1.158.2", kMethod_append_records_input_port_0_type_0_schema_hash, 32u, 0u, 0u, 0u },
  { false, "FSO.fbs", "$FSO", 1u, true, "FSO", "1.158.2", kMethod_append_records_input_port_0_type_1_schema_hash, 32u, 0u, 361648u, 8u },
};
static const uint8_t kMethod_append_records_input_port_1_type_0_schema_hash[] = { 0x0b, 0x23, 0xaa, 0x63, 0xd0, 0xe3, 0xf1, 0x7d, 0x82, 0x8f, 0xc8, 0x4d, 0xd4, 0x33, 0x60, 0x5c, 0x27, 0x94, 0xcb, 0x81, 0xad, 0xe7, 0xc0, 0x43, 0xcb, 0x20, 0x0e, 0x95, 0x4c, 0x84, 0xe9, 0x45 };
static const uint8_t kMethod_append_records_input_port_1_type_1_schema_hash[] = { 0x0b, 0x23, 0xaa, 0x63, 0xd0, 0xe3, 0xf1, 0x7d, 0x82, 0x8f, 0xc8, 0x4d, 0xd4, 0x33, 0x60, 0x5c, 0x27, 0x94, 0xcb, 0x81, 0xad, 0xe7, 0xc0, 0x43, 0xcb, 0x20, 0x0e, 0x95, 0x4c, 0x84, 0xe9, 0x45 };
static const AcceptedTypeRef kMethod_append_records_input_port_1_accepted_types[] = {
  { false, "FSB.fbs", "$FSB", 0u, true, "FSB", "1.158.1", kMethod_append_records_input_port_1_type_0_schema_hash, 32u, 0u, 0u, 0u },
  { false, "FSB.fbs", "$FSB", 1u, true, "FSB", "1.158.1", kMethod_append_records_input_port_1_type_1_schema_hash, 32u, 0u, 1048744u, 8u },
};
static const PortRequirement kMethod_append_records_input_ports[] = {
  { "control", false, kMethod_append_records_input_port_0_accepted_types, 2u },
  { "records", false, kMethod_append_records_input_port_1_accepted_types, 2u },
};
static const uint8_t kMethod_append_records_output_port_0_type_0_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const uint8_t kMethod_append_records_output_port_0_type_1_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const AcceptedTypeRef kMethod_append_records_output_port_0_accepted_types[] = {
  { false, "FSO.fbs", "$FSO", 0u, true, "FSO", "1.158.2", kMethod_append_records_output_port_0_type_0_schema_hash, 32u, 0u, 0u, 0u },
  { false, "FSO.fbs", "$FSO", 1u, true, "FSO", "1.158.2", kMethod_append_records_output_port_0_type_1_schema_hash, 32u, 0u, 361648u, 8u },
};
static const PortRequirement kMethod_append_records_output_ports[] = {
  { "status", true, kMethod_append_records_output_port_0_accepted_types, 2u },
};

static const uint8_t kMethod_query_records_input_port_0_type_0_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const uint8_t kMethod_query_records_input_port_0_type_1_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const AcceptedTypeRef kMethod_query_records_input_port_0_accepted_types[] = {
  { false, "FSO.fbs", "$FSO", 0u, true, "FSO", "1.158.2", kMethod_query_records_input_port_0_type_0_schema_hash, 32u, 0u, 0u, 0u },
  { false, "FSO.fbs", "$FSO", 1u, true, "FSO", "1.158.2", kMethod_query_records_input_port_0_type_1_schema_hash, 32u, 0u, 361648u, 8u },
};
static const PortRequirement kMethod_query_records_input_ports[] = {
  { "query", true, kMethod_query_records_input_port_0_accepted_types, 2u },
};
static const uint8_t kMethod_query_records_output_port_0_type_0_schema_hash[] = { 0x0b, 0x23, 0xaa, 0x63, 0xd0, 0xe3, 0xf1, 0x7d, 0x82, 0x8f, 0xc8, 0x4d, 0xd4, 0x33, 0x60, 0x5c, 0x27, 0x94, 0xcb, 0x81, 0xad, 0xe7, 0xc0, 0x43, 0xcb, 0x20, 0x0e, 0x95, 0x4c, 0x84, 0xe9, 0x45 };
static const uint8_t kMethod_query_records_output_port_0_type_1_schema_hash[] = { 0x0b, 0x23, 0xaa, 0x63, 0xd0, 0xe3, 0xf1, 0x7d, 0x82, 0x8f, 0xc8, 0x4d, 0xd4, 0x33, 0x60, 0x5c, 0x27, 0x94, 0xcb, 0x81, 0xad, 0xe7, 0xc0, 0x43, 0xcb, 0x20, 0x0e, 0x95, 0x4c, 0x84, 0xe9, 0x45 };
static const AcceptedTypeRef kMethod_query_records_output_port_0_accepted_types[] = {
  { false, "FSB.fbs", "$FSB", 0u, true, "FSB", "1.158.1", kMethod_query_records_output_port_0_type_0_schema_hash, 32u, 0u, 0u, 0u },
  { false, "FSB.fbs", "$FSB", 1u, true, "FSB", "1.158.1", kMethod_query_records_output_port_0_type_1_schema_hash, 32u, 0u, 1048744u, 8u },
};
static const uint8_t kMethod_query_records_output_port_1_type_0_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const uint8_t kMethod_query_records_output_port_1_type_1_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const AcceptedTypeRef kMethod_query_records_output_port_1_accepted_types[] = {
  { false, "FSO.fbs", "$FSO", 0u, true, "FSO", "1.158.2", kMethod_query_records_output_port_1_type_0_schema_hash, 32u, 0u, 0u, 0u },
  { false, "FSO.fbs", "$FSO", 1u, true, "FSO", "1.158.2", kMethod_query_records_output_port_1_type_1_schema_hash, 32u, 0u, 361648u, 8u },
};
static const PortRequirement kMethod_query_records_output_ports[] = {
  { "records", false, kMethod_query_records_output_port_0_accepted_types, 2u },
  { "status", true, kMethod_query_records_output_port_1_accepted_types, 2u },
};

static const uint8_t kMethod_configure_index_input_port_0_type_0_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const uint8_t kMethod_configure_index_input_port_0_type_1_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const AcceptedTypeRef kMethod_configure_index_input_port_0_accepted_types[] = {
  { false, "FSO.fbs", "$FSO", 0u, true, "FSO", "1.158.2", kMethod_configure_index_input_port_0_type_0_schema_hash, 32u, 0u, 0u, 0u },
  { false, "FSO.fbs", "$FSO", 1u, true, "FSO", "1.158.2", kMethod_configure_index_input_port_0_type_1_schema_hash, 32u, 0u, 361648u, 8u },
};
static const PortRequirement kMethod_configure_index_input_ports[] = {
  { "control", true, kMethod_configure_index_input_port_0_accepted_types, 2u },
};
static const uint8_t kMethod_configure_index_output_port_0_type_0_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const uint8_t kMethod_configure_index_output_port_0_type_1_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const AcceptedTypeRef kMethod_configure_index_output_port_0_accepted_types[] = {
  { false, "FSO.fbs", "$FSO", 0u, true, "FSO", "1.158.2", kMethod_configure_index_output_port_0_type_0_schema_hash, 32u, 0u, 0u, 0u },
  { false, "FSO.fbs", "$FSO", 1u, true, "FSO", "1.158.2", kMethod_configure_index_output_port_0_type_1_schema_hash, 32u, 0u, 361648u, 8u },
};
static const PortRequirement kMethod_configure_index_output_ports[] = {
  { "status", true, kMethod_configure_index_output_port_0_accepted_types, 2u },
};

static const uint8_t kMethod_upsert_view_input_port_0_type_0_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const uint8_t kMethod_upsert_view_input_port_0_type_1_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const AcceptedTypeRef kMethod_upsert_view_input_port_0_accepted_types[] = {
  { false, "FSO.fbs", "$FSO", 0u, true, "FSO", "1.158.2", kMethod_upsert_view_input_port_0_type_0_schema_hash, 32u, 0u, 0u, 0u },
  { false, "FSO.fbs", "$FSO", 1u, true, "FSO", "1.158.2", kMethod_upsert_view_input_port_0_type_1_schema_hash, 32u, 0u, 361648u, 8u },
};
static const PortRequirement kMethod_upsert_view_input_ports[] = {
  { "control", true, kMethod_upsert_view_input_port_0_accepted_types, 2u },
};
static const uint8_t kMethod_upsert_view_output_port_0_type_0_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const uint8_t kMethod_upsert_view_output_port_0_type_1_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const AcceptedTypeRef kMethod_upsert_view_output_port_0_accepted_types[] = {
  { false, "FSO.fbs", "$FSO", 0u, true, "FSO", "1.158.2", kMethod_upsert_view_output_port_0_type_0_schema_hash, 32u, 0u, 0u, 0u },
  { false, "FSO.fbs", "$FSO", 1u, true, "FSO", "1.158.2", kMethod_upsert_view_output_port_0_type_1_schema_hash, 32u, 0u, 361648u, 8u },
};
static const PortRequirement kMethod_upsert_view_output_ports[] = {
  { "status", true, kMethod_upsert_view_output_port_0_accepted_types, 2u },
};

static const uint8_t kMethod_compact_input_port_0_type_0_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const uint8_t kMethod_compact_input_port_0_type_1_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const AcceptedTypeRef kMethod_compact_input_port_0_accepted_types[] = {
  { false, "FSO.fbs", "$FSO", 0u, true, "FSO", "1.158.2", kMethod_compact_input_port_0_type_0_schema_hash, 32u, 0u, 0u, 0u },
  { false, "FSO.fbs", "$FSO", 1u, true, "FSO", "1.158.2", kMethod_compact_input_port_0_type_1_schema_hash, 32u, 0u, 361648u, 8u },
};
static const PortRequirement kMethod_compact_input_ports[] = {
  { "control", true, kMethod_compact_input_port_0_accepted_types, 2u },
};
static const uint8_t kMethod_compact_output_port_0_type_0_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const uint8_t kMethod_compact_output_port_0_type_1_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const AcceptedTypeRef kMethod_compact_output_port_0_accepted_types[] = {
  { false, "FSO.fbs", "$FSO", 0u, true, "FSO", "1.158.2", kMethod_compact_output_port_0_type_0_schema_hash, 32u, 0u, 0u, 0u },
  { false, "FSO.fbs", "$FSO", 1u, true, "FSO", "1.158.2", kMethod_compact_output_port_0_type_1_schema_hash, 32u, 0u, 361648u, 8u },
};
static const PortRequirement kMethod_compact_output_ports[] = {
  { "status", true, kMethod_compact_output_port_0_accepted_types, 2u },
};

static const uint8_t kMethod_configure_retention_input_port_0_type_0_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const uint8_t kMethod_configure_retention_input_port_0_type_1_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const AcceptedTypeRef kMethod_configure_retention_input_port_0_accepted_types[] = {
  { false, "FSO.fbs", "$FSO", 0u, true, "FSO", "1.158.2", kMethod_configure_retention_input_port_0_type_0_schema_hash, 32u, 0u, 0u, 0u },
  { false, "FSO.fbs", "$FSO", 1u, true, "FSO", "1.158.2", kMethod_configure_retention_input_port_0_type_1_schema_hash, 32u, 0u, 361648u, 8u },
};
static const PortRequirement kMethod_configure_retention_input_ports[] = {
  { "control", true, kMethod_configure_retention_input_port_0_accepted_types, 2u },
};
static const uint8_t kMethod_configure_retention_output_port_0_type_0_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const uint8_t kMethod_configure_retention_output_port_0_type_1_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const AcceptedTypeRef kMethod_configure_retention_output_port_0_accepted_types[] = {
  { false, "FSO.fbs", "$FSO", 0u, true, "FSO", "1.158.2", kMethod_configure_retention_output_port_0_type_0_schema_hash, 32u, 0u, 0u, 0u },
  { false, "FSO.fbs", "$FSO", 1u, true, "FSO", "1.158.2", kMethod_configure_retention_output_port_0_type_1_schema_hash, 32u, 0u, 361648u, 8u },
};
static const PortRequirement kMethod_configure_retention_output_ports[] = {
  { "status", true, kMethod_configure_retention_output_port_0_accepted_types, 2u },
};

static const uint8_t kMethod_snapshot_input_port_0_type_0_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const uint8_t kMethod_snapshot_input_port_0_type_1_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const AcceptedTypeRef kMethod_snapshot_input_port_0_accepted_types[] = {
  { false, "FSO.fbs", "$FSO", 0u, true, "FSO", "1.158.2", kMethod_snapshot_input_port_0_type_0_schema_hash, 32u, 0u, 0u, 0u },
  { false, "FSO.fbs", "$FSO", 1u, true, "FSO", "1.158.2", kMethod_snapshot_input_port_0_type_1_schema_hash, 32u, 0u, 361648u, 8u },
};
static const PortRequirement kMethod_snapshot_input_ports[] = {
  { "control", true, kMethod_snapshot_input_port_0_accepted_types, 2u },
};
static const uint8_t kMethod_snapshot_output_port_0_type_0_schema_hash[] = { 0x0b, 0x23, 0xaa, 0x63, 0xd0, 0xe3, 0xf1, 0x7d, 0x82, 0x8f, 0xc8, 0x4d, 0xd4, 0x33, 0x60, 0x5c, 0x27, 0x94, 0xcb, 0x81, 0xad, 0xe7, 0xc0, 0x43, 0xcb, 0x20, 0x0e, 0x95, 0x4c, 0x84, 0xe9, 0x45 };
static const uint8_t kMethod_snapshot_output_port_0_type_1_schema_hash[] = { 0x0b, 0x23, 0xaa, 0x63, 0xd0, 0xe3, 0xf1, 0x7d, 0x82, 0x8f, 0xc8, 0x4d, 0xd4, 0x33, 0x60, 0x5c, 0x27, 0x94, 0xcb, 0x81, 0xad, 0xe7, 0xc0, 0x43, 0xcb, 0x20, 0x0e, 0x95, 0x4c, 0x84, 0xe9, 0x45 };
static const AcceptedTypeRef kMethod_snapshot_output_port_0_accepted_types[] = {
  { false, "FSB.fbs", "$FSB", 0u, true, "FSB", "1.158.1", kMethod_snapshot_output_port_0_type_0_schema_hash, 32u, 0u, 0u, 0u },
  { false, "FSB.fbs", "$FSB", 1u, true, "FSB", "1.158.1", kMethod_snapshot_output_port_0_type_1_schema_hash, 32u, 0u, 1048744u, 8u },
};
static const uint8_t kMethod_snapshot_output_port_1_type_0_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const uint8_t kMethod_snapshot_output_port_1_type_1_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const AcceptedTypeRef kMethod_snapshot_output_port_1_accepted_types[] = {
  { false, "FSO.fbs", "$FSO", 0u, true, "FSO", "1.158.2", kMethod_snapshot_output_port_1_type_0_schema_hash, 32u, 0u, 0u, 0u },
  { false, "FSO.fbs", "$FSO", 1u, true, "FSO", "1.158.2", kMethod_snapshot_output_port_1_type_1_schema_hash, 32u, 0u, 361648u, 8u },
};
static const PortRequirement kMethod_snapshot_output_ports[] = {
  { "snapshot", true, kMethod_snapshot_output_port_0_accepted_types, 2u },
  { "status", true, kMethod_snapshot_output_port_1_accepted_types, 2u },
};

static const uint8_t kMethod_reload_input_port_0_type_0_schema_hash[] = { 0x0b, 0x23, 0xaa, 0x63, 0xd0, 0xe3, 0xf1, 0x7d, 0x82, 0x8f, 0xc8, 0x4d, 0xd4, 0x33, 0x60, 0x5c, 0x27, 0x94, 0xcb, 0x81, 0xad, 0xe7, 0xc0, 0x43, 0xcb, 0x20, 0x0e, 0x95, 0x4c, 0x84, 0xe9, 0x45 };
static const uint8_t kMethod_reload_input_port_0_type_1_schema_hash[] = { 0x0b, 0x23, 0xaa, 0x63, 0xd0, 0xe3, 0xf1, 0x7d, 0x82, 0x8f, 0xc8, 0x4d, 0xd4, 0x33, 0x60, 0x5c, 0x27, 0x94, 0xcb, 0x81, 0xad, 0xe7, 0xc0, 0x43, 0xcb, 0x20, 0x0e, 0x95, 0x4c, 0x84, 0xe9, 0x45 };
static const AcceptedTypeRef kMethod_reload_input_port_0_accepted_types[] = {
  { false, "FSB.fbs", "$FSB", 0u, true, "FSB", "1.158.1", kMethod_reload_input_port_0_type_0_schema_hash, 32u, 0u, 0u, 0u },
  { false, "FSB.fbs", "$FSB", 1u, true, "FSB", "1.158.1", kMethod_reload_input_port_0_type_1_schema_hash, 32u, 0u, 1048744u, 8u },
};
static const PortRequirement kMethod_reload_input_ports[] = {
  { "snapshot", true, kMethod_reload_input_port_0_accepted_types, 2u },
};
static const uint8_t kMethod_reload_output_port_0_type_0_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const uint8_t kMethod_reload_output_port_0_type_1_schema_hash[] = { 0xa2, 0x98, 0xef, 0x96, 0xaf, 0x29, 0x62, 0x40, 0x73, 0xed, 0xf7, 0x49, 0x84, 0x8e, 0x8f, 0xf1, 0xe5, 0xb8, 0xf4, 0x5e, 0x56, 0x96, 0x6c, 0x2e, 0x21, 0x0c, 0xb7, 0x19, 0xf3, 0xc5, 0xe8, 0x21 };
static const AcceptedTypeRef kMethod_reload_output_port_0_accepted_types[] = {
  { false, "FSO.fbs", "$FSO", 0u, true, "FSO", "1.158.2", kMethod_reload_output_port_0_type_0_schema_hash, 32u, 0u, 0u, 0u },
  { false, "FSO.fbs", "$FSO", 1u, true, "FSO", "1.158.2", kMethod_reload_output_port_0_type_1_schema_hash, 32u, 0u, 361648u, 8u },
};
static const PortRequirement kMethod_reload_output_ports[] = {
  { "status", true, kMethod_reload_output_port_0_accepted_types, 2u },
};

static const MethodDescriptor kMethodTable[] = {
  {
    "append_records",
    &append_records,
    kMethod_append_records_input_ports,
    2u,
    kMethod_append_records_output_ports,
    1u,
    false,
    nullptr,
    nullptr
  },
  {
    "query_records",
    &query_records,
    kMethod_query_records_input_ports,
    1u,
    kMethod_query_records_output_ports,
    2u,
    false,
    nullptr,
    nullptr
  },
  {
    "configure_index",
    &configure_index,
    kMethod_configure_index_input_ports,
    1u,
    kMethod_configure_index_output_ports,
    1u,
    true,
    "control",
    "status"
  },
  {
    "upsert_view",
    &upsert_view,
    kMethod_upsert_view_input_ports,
    1u,
    kMethod_upsert_view_output_ports,
    1u,
    true,
    "control",
    "status"
  },
  {
    "compact",
    &compact,
    kMethod_compact_input_ports,
    1u,
    kMethod_compact_output_ports,
    1u,
    true,
    "control",
    "status"
  },
  {
    "configure_retention",
    &configure_retention,
    kMethod_configure_retention_input_ports,
    1u,
    kMethod_configure_retention_output_ports,
    1u,
    true,
    "control",
    "status"
  },
  {
    "snapshot",
    &snapshot,
    kMethod_snapshot_input_ports,
    1u,
    kMethod_snapshot_output_ports,
    2u,
    false,
    nullptr,
    nullptr
  },
  {
    "reload",
    &reload,
    kMethod_reload_input_ports,
    1u,
    kMethod_reload_output_ports,
    1u,
    true,
    "snapshot",
    "status"
  },
};

static InvokeContext g_invoke_context;
static std::vector<AllocationRecord> g_allocations{};
static bool g_direct_invoke_stream = false;

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

static bool U32RangeExceeds(uint32_t offset, uint32_t size, uint32_t arena_size) {
  return offset > arena_size || size > arena_size - offset;
}

static bool AllocationContains(uint32_t ptr, uint32_t length) {
  if (length == 0u) {
    return true;
  }
  if (ptr == 0u) {
    return false;
  }
  for (const auto &allocation : g_allocations) {
    if (ptr < allocation.ptr) {
      continue;
    }
    const uint32_t offset = ptr - allocation.ptr;
    if (!U32RangeExceeds(offset, length, allocation.size)) {
      return true;
    }
  }
  return false;
}

static void TrackAllocation(uint32_t ptr, uint32_t size) {
  if (ptr != 0u) {
    g_allocations.push_back(AllocationRecord{ptr, size});
  }
}

static bool UntrackAllocation(uint32_t ptr) {
  if (ptr == 0u) {
    return false;
  }
  const auto before = g_allocations.size();
  g_allocations.erase(
    std::remove_if(
      g_allocations.begin(),
      g_allocations.end(),
      [ptr](const AllocationRecord &allocation) {
        return allocation.ptr == ptr;
      }
    ),
    g_allocations.end()
  );
  return g_allocations.size() != before;
}

static const MethodDescriptor *FindMethod(std::string_view method_id) {
  for (const auto &method : kMethodTable) {
    if (method_id == method.method_id) {
      return &method;
    }
  }
  return nullptr;
}

static bool CStringExactlyMatches(const char *expected, const std::string &actual) {
  return actual == (expected ? expected : "");
}

static bool SchemaHashExactlyMatches(
  const AcceptedTypeRef &accepted,
  const std::vector<uint8_t> &actual
) {
  if (accepted.schema_hash_length != actual.size()) {
    return false;
  }
  if (accepted.schema_hash_length == 0u) {
    return true;
  }
  if (!accepted.schema_hash) {
    return false;
  }
  return std::equal(
    accepted.schema_hash,
    accepted.schema_hash + accepted.schema_hash_length,
    actual.begin()
  );
}

static bool IsPowerOfTwo(uint32_t value) {
  return value > 0u && (value & (value - 1u)) == 0u;
}

static const PortRequirement *FindInputPort(const MethodDescriptor *method, const std::string &port_id) {
  if (!method) {
    return nullptr;
  }
  for (size_t index = 0; index < method->input_port_count; index += 1) {
    const auto &port = method->input_ports[index];
    if (port.port_id && port_id == port.port_id) {
      return &port;
    }
  }
  return nullptr;
}

static bool InputTypeMatches(const AcceptedTypeRef &accepted, const InputFrameOwned &frame) {
  if (accepted.accepts_any_flatbuffer) {
    return frame.view.wire_format == static_cast<uint32_t>(kPayloadWireFormatFlatbuffer);
  }
  if (accepted.has_wire_format && frame.view.wire_format != accepted.wire_format) {
    return false;
  }
  if (!accepted.has_wire_format &&
      frame.view.wire_format != static_cast<uint32_t>(kPayloadWireFormatFlatbuffer)) {
    return false;
  }
  if (frame.type_wire_format != frame.view.wire_format) {
    return false;
  }
  if (
    !CStringExactlyMatches(accepted.schema_name, frame.schema_name) ||
    !CStringExactlyMatches(accepted.file_identifier, frame.file_identifier) ||
    !CStringExactlyMatches(accepted.root_type_name, frame.root_type_name) ||
    !CStringExactlyMatches(accepted.schema_version, frame.schema_version) ||
    !SchemaHashExactlyMatches(accepted, frame.schema_hash)
  ) {
    return false;
  }
  if (
    frame.view.fixed_string_length != accepted.fixed_string_length ||
    frame.view.byte_length != accepted.byte_length ||
    frame.view.required_alignment != accepted.required_alignment
  ) {
    return false;
  }
  if (frame.view.wire_format == static_cast<uint32_t>(kPayloadWireFormatAlignedBinary)) {
    if (
      accepted.byte_length == 0u ||
      frame.view.size != accepted.byte_length ||
      accepted.required_alignment == 0u ||
      !IsPowerOfTwo(frame.view.alignment) ||
      frame.view.alignment < accepted.required_alignment
    ) {
      return false;
    }
  }
  return true;
}

static bool InputTypeAllowed(const PortRequirement &port, const InputFrameOwned &frame) {
  if (port.accepted_type_count == 0u) {
    return true;
  }
  for (size_t index = 0; index < port.accepted_type_count; index += 1) {
    if (InputTypeMatches(port.accepted_types[index], frame)) {
      return true;
    }
  }
  return false;
}

static const AcceptedTypeRef *FindCanonicalInputType(const PortRequirement &port) {
  for (size_t index = 0; index < port.accepted_type_count; index += 1) {
    const auto &accepted = port.accepted_types[index];
    if (
      accepted.wire_format == static_cast<uint32_t>(kPayloadWireFormatFlatbuffer) &&
      !accepted.accepts_any_flatbuffer
    ) {
      return &accepted;
    }
  }
  return nullptr;
}

static const PortRequirement *FindOutputPort(
  const MethodDescriptor *method,
  const char *port_id
) {
  if (!method || !port_id || !port_id[0]) {
    return nullptr;
  }
  for (size_t index = 0; index < method->output_port_count; index += 1) {
    const auto &port = method->output_ports[index];
    if (port.port_id && std::strcmp(port.port_id, port_id) == 0) {
      return &port;
    }
  }
  return nullptr;
}

static bool OptionalCStringMatches(const char *actual, const char *expected) {
  return !actual || !actual[0] || std::strcmp(actual, expected ? expected : "") == 0;
}

static bool OutputTypeMatches(
  const AcceptedTypeRef &accepted,
  const char *schema_name,
  const char *file_identifier,
  uint32_t wire_format,
  const char *root_type_name,
  uint16_t fixed_string_length,
  uint32_t byte_length,
  uint16_t required_alignment,
  uint32_t payload_length
) {
  if (accepted.accepts_any_flatbuffer) {
    return wire_format == static_cast<uint32_t>(kPayloadWireFormatFlatbuffer);
  }
  if (
    !schema_name || !schema_name[0] ||
    !file_identifier || !file_identifier[0] ||
    std::strcmp(schema_name, accepted.schema_name ? accepted.schema_name : "") != 0 ||
    std::strcmp(file_identifier, accepted.file_identifier ? accepted.file_identifier : "") != 0 ||
    !OptionalCStringMatches(root_type_name, accepted.root_type_name)
  ) {
    return false;
  }
  const uint32_t accepted_wire_format = accepted.has_wire_format
    ? accepted.wire_format
    : static_cast<uint32_t>(kPayloadWireFormatFlatbuffer);
  if (wire_format != accepted_wire_format) {
    return false;
  }
  if (wire_format == static_cast<uint32_t>(kPayloadWireFormatAlignedBinary)) {
    return
      fixed_string_length == accepted.fixed_string_length &&
      byte_length == accepted.byte_length &&
      required_alignment == accepted.required_alignment &&
      accepted.byte_length > 0u &&
      payload_length == accepted.byte_length &&
      accepted.required_alignment > 0u;
  }
  return fixed_string_length == 0u && byte_length == 0u && required_alignment == 0u;
}

static const AcceptedTypeRef *ResolveOutputType(
  const PortRequirement &port,
  const char *schema_name,
  const char *file_identifier,
  uint32_t wire_format,
  const char *root_type_name,
  uint16_t fixed_string_length,
  uint32_t byte_length,
  uint16_t required_alignment,
  uint32_t payload_length
) {
  const AcceptedTypeRef *match = nullptr;
  for (size_t index = 0; index < port.accepted_type_count; index += 1) {
    const auto &accepted = port.accepted_types[index];
    if (!OutputTypeMatches(
          accepted,
          schema_name,
          file_identifier,
          wire_format,
          root_type_name,
          fixed_string_length,
          byte_length,
          required_alignment,
          payload_length)) {
      continue;
    }
    if (match) {
      return nullptr;
    }
    match = &accepted;
  }
  return match;
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

static bool AlignOffsetChecked(size_t offset, uint32_t alignment, size_t *aligned_offset) {
  if (!aligned_offset) {
    return false;
  }
  if (alignment <= 1u) {
    *aligned_offset = offset;
    return true;
  }
  const size_t remainder = offset % static_cast<size_t>(alignment);
  const size_t padding = remainder == 0u ? 0u : static_cast<size_t>(alignment) - remainder;
  if (padding > std::numeric_limits<size_t>::max() - offset) {
    return false;
  }
  *aligned_offset = offset + padding;
  return true;
}

static std::string FlatBufferStringValue(const ::flatbuffers::String *value) {
  return value ? std::string(value->c_str(), value->size()) : std::string();
}

static uint64_t DecodeSdsFrameSequence(uint64_t frame_id) {
  return frame_id >> 1u;
}

static bool DecodeSdsFrameEndOfStream(uint64_t frame_id) {
  return (frame_id & 1u) != 0u;
}

static uint64_t EncodeSdsFrameId(uint64_t sequence, bool end_of_stream) {
  return (sequence << 1u) | (end_of_stream ? 1u : 0u);
}

static bool FrameRangeExceedsArena(
  size_t payload_offset,
  size_t payload_size,
  size_t arena_size
) {
  return payload_offset > arena_size || payload_size > arena_size - payload_offset;
}

static void PopulateInputView(InputFrameOwned *owned) {
  if (!owned) {
    return;
  }
  owned->view.port_id = owned->port_id.empty() ? nullptr : owned->port_id.c_str();
  owned->view.schema_name = owned->schema_name.empty() ? nullptr : owned->schema_name.c_str();
  owned->view.file_identifier = owned->file_identifier.empty() ? nullptr : owned->file_identifier.c_str();
  owned->view.root_type_name = owned->root_type_name.empty() ? nullptr : owned->root_type_name.c_str();
  owned->view.schema_version = owned->schema_version.empty() ? nullptr : owned->schema_version.c_str();
  owned->view.schema_hash = owned->schema_hash.empty() ? nullptr : owned->schema_hash.data();
  owned->view.schema_hash_length = static_cast<uint32_t>(owned->schema_hash.size());
  owned->view.frame_id = owned->view.trace_id;
  if (owned->external_payload && owned->external_payload_length > 0u) {
    owned->view.payload = owned->external_payload;
    owned->view.payload_length = owned->external_payload_length;
  } else {
    owned->view.payload = owned->payload.empty() ? nullptr : owned->payload.data();
    owned->view.payload_length = static_cast<uint32_t>(owned->payload.size());
  }
}

static bool LoadInputsFromPivRequest(const PIVRequest &request) {
  g_invoke_context.inputs.clear();

  const auto *input_frames = request.INPUTS();
  const auto *payload_arena = request.PAYLOAD_ARENA();
  const size_t input_count = input_frames ? input_frames->size() : 0u;
  const size_t arena_size = payload_arena ? payload_arena->size() : 0u;
  g_invoke_context.inputs.reserve(input_count);

  for (size_t index = 0; index < input_count; index += 1) {
    const auto *frame = input_frames->Get(static_cast<::flatbuffers::uoffset_t>(index));
    if (!frame) {
      continue;
    }

    const auto payload_offset = static_cast<size_t>(frame->OFFSET());
    const auto payload_size = static_cast<size_t>(frame->SIZE());
    const uint32_t frame_alignment = frame->ALIGNMENT() > 0u ? frame->ALIGNMENT() : 1u;
    if (frame_alignment > std::numeric_limits<uint16_t>::max()) {
      SetError("invalid-request-frame", "SDS PIV TAB alignment exceeds the module ABI limit.");
      return false;
    }
    const uint8_t *payload_ptr = nullptr;
    if (payload_size > 0u && arena_size == 0u) {
      if (
        payload_offset > std::numeric_limits<uint32_t>::max() ||
        payload_size > std::numeric_limits<uint32_t>::max() ||
        !AllocationContains(
          static_cast<uint32_t>(payload_offset),
          static_cast<uint32_t>(payload_size)
        )
      ) {
        SetError(
          "invalid-request-pointer",
          "SDS PIV external arena TAB payload range is not owned by the module SDK allocator."
        );
        return false;
      }
      payload_ptr = ConstPtr(static_cast<uint32_t>(payload_offset));
    } else if (FrameRangeExceedsArena(payload_offset, payload_size, arena_size)) {
      SetError("invalid-request-frame", "Input frame payload range exceeds request payload arena.");
      return false;
    } else if (payload_size > 0u && payload_arena) {
      payload_ptr = payload_arena->data() + static_cast<std::ptrdiff_t>(payload_offset);
    }
    if (
      payload_ptr &&
      frame_alignment > 1u &&
      (reinterpret_cast<uintptr_t>(payload_ptr) % frame_alignment) != 0u
    ) {
      SetError("misaligned-input-frame", "SDS PIV TAB payload violates its declared alignment.");
      return false;
    }

    g_invoke_context.inputs.emplace_back();
    auto &owned = g_invoke_context.inputs.back();
    owned = InputFrameOwned{};
    owned.port_id = FlatBufferStringValue(frame->PORT_ID());
    const auto *type_ref = frame->TYPE_REF();
    if (type_ref) {
      owned.schema_name = FlatBufferStringValue(type_ref->SCHEMA_NAME());
      owned.file_identifier = FlatBufferStringValue(type_ref->FILE_IDENTIFIER());
      owned.root_type_name = FlatBufferStringValue(type_ref->ROOT_TYPE());
      owned.schema_version = FlatBufferStringValue(type_ref->SCHEMA_VERSION());
      if (const auto *schema_hash = type_ref->SCHEMA_HASH()) {
        owned.schema_hash.assign(schema_hash->begin(), schema_hash->end());
      }
      owned.type_wire_format = static_cast<uint32_t>(type_ref->WIRE_FORMAT());
      if (owned.type_wire_format == static_cast<uint32_t>(kPayloadWireFormatFlatbuffer)) {
        owned.view.fixed_string_length = 0u;
        owned.view.byte_length = 0u;
        owned.view.required_alignment = 0u;
      } else {
        owned.view.fixed_string_length = type_ref->FIXED_STRING_LENGTH();
        owned.view.byte_length = type_ref->BYTE_LENGTH();
        owned.view.required_alignment = type_ref->REQUIRED_ALIGNMENT();
      }
    }
    owned.external_payload = payload_ptr;
    owned.external_payload_length = static_cast<uint32_t>(payload_size);

    owned.view.wire_format = static_cast<uint32_t>(frame->WIRE_FORMAT());
    owned.view.alignment = static_cast<uint16_t>(frame_alignment);
    owned.view.size = frame->SIZE();
    owned.view.generation = 0;
    const auto frame_id = frame->FRAME_ID();
    owned.view.trace_id = frame_id;
    owned.view.stream_id = 0;
    owned.view.sequence = DecodeSdsFrameSequence(frame_id);
    owned.view.end_of_stream = DecodeSdsFrameEndOfStream(frame_id) ? 1 : 0;
    owned.view.ownership = static_cast<uint32_t>(frame->OWNERSHIP());
    owned.view.mutability = static_cast<uint32_t>(frame->MUTABILITY());
    PopulateInputView(&owned);

    // A host may use an exact empty, untyped canonical frame solely to wake a
    // method whose target port is optional.  The token selects the method and
    // port in the signed parent graph but carries no application data, so do
    // not expose it as a typed guest input.  Non-empty, typed, mutable, or
    // required-port frames continue through strict SDS identity validation.
    const bool untyped_signal =
      (!type_ref || !type_ref->ACCEPTS_ANY_FLATBUFFER()) &&
      owned.schema_name.empty() &&
      owned.file_identifier.empty() &&
      owned.root_type_name.empty() &&
      owned.schema_version.empty() &&
      owned.schema_hash.empty() &&
      owned.type_wire_format == static_cast<uint32_t>(kPayloadWireFormatFlatbuffer) &&
      owned.view.fixed_string_length == 0u &&
      owned.view.byte_length == 0u &&
      owned.view.required_alignment == 0u;
    const auto *input_port = FindInputPort(g_invoke_context.method, owned.port_id);
    if (
      untyped_signal &&
      payload_size == 0u &&
      input_port &&
      !input_port->required &&
      owned.view.wire_format == static_cast<uint32_t>(kPayloadWireFormatFlatbuffer) &&
      IsPowerOfTwo(owned.view.alignment) &&
      owned.view.ownership == static_cast<uint32_t>(kBufferOwnershipHostOwned) &&
      owned.view.mutability == static_cast<uint32_t>(kBufferMutabilityImmutable)
    ) {
      g_invoke_context.inputs.pop_back();
    }
  }

  return true;
}

static bool PivRequestUsesExternalPayloadArena(const PIVRequest &request) {
  const auto *payload_arena = request.PAYLOAD_ARENA();
  if (payload_arena && payload_arena->size() > 0u) {
    return false;
  }
  const auto *input_frames = request.INPUTS();
  if (!input_frames) {
    return false;
  }
  for (size_t index = 0; index < input_frames->size(); index += 1) {
    const auto *frame = input_frames->Get(
      static_cast<::flatbuffers::uoffset_t>(index)
    );
    if (frame && frame->SIZE() > 0u) {
      return true;
    }
  }
  return false;
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

static bool InputBufferContractAllowed(const plugin_input_frame_t &frame) {
  const bool known_ownership =
    frame.ownership == static_cast<uint32_t>(kBufferOwnershipHostOwned) ||
    frame.ownership == static_cast<uint32_t>(kBufferOwnershipPluginOwned) ||
    frame.ownership == static_cast<uint32_t>(kBufferOwnershipTransferred);
  const bool immutable =
    frame.mutability == static_cast<uint32_t>(kBufferMutabilityImmutable);
  const bool mutable_or_append_only =
    frame.mutability == static_cast<uint32_t>(kBufferMutabilitySingleWriterMutable) ||
    frame.mutability == static_cast<uint32_t>(kBufferMutabilityAppendOnly);
  if (!known_ownership || (!immutable && !mutable_or_append_only)) {
    return false;
  }
  return immutable ||
    frame.ownership == static_cast<uint32_t>(kBufferOwnershipTransferred);
}

static bool ValidateInputFrames(const MethodDescriptor *method) {
  if (!method) {
    return false;
  }
  for (const auto &frame : g_invoke_context.inputs) {
    const auto *port = FindInputPort(method, frame.port_id);
    if (!port) {
      SetError(
        "unknown-input-port",
        std::string("Input frame uses undeclared port: ") + frame.port_id
      );
      return false;
    }
    if (!InputBufferContractAllowed(frame.view)) {
      SetError(
        "incompatible-input-buffer-contract",
        std::string("Input frame ownership/mutability is incompatible with port: ") +
          frame.port_id
      );
      return false;
    }
    if (!InputTypeAllowed(*port, frame)) {
      SetError(
        "unsupported-input-type",
        std::string("Input frame type is not accepted by port: ") + frame.port_id
      );
      return false;
    }
  }
  return ValidateRequiredInputs(method);
}

static pivStatus ResolvePivStatus(
  int32_t status_code,
  bool yielded,
  const std::string &error_code
) {
  if (yielded) {
    return kPivStatusYielded;
  }
  if (status_code == 404) {
    return kPivStatusNotFound;
  }
  if (status_code != 0 || !error_code.empty()) {
    return kPivStatusFailed;
  }
  return kPivStatusOk;
}

static std::vector<uint8_t> SerializePivResponse(
  int32_t status_code,
  bool yielded,
  uint32_t backlog_remaining,
  const std::vector<OutputFrameOwned> &outputs,
  const std::string &error_code,
  const std::string &error_message,
  uint64_t trace_id = 0,
  bool external_payload_descriptors = false
) {
  struct PackedOutputFrame {
    const OutputFrameOwned *output = nullptr;
    uint32_t offset = 0;
    uint32_t size = 0;
    uint32_t alignment = 1;
    bufferOwnership ownership = kBufferOwnershipHostOwned;
  };

  std::vector<uint8_t> payload_arena{};
  std::vector<PackedOutputFrame> packed_outputs{};
  size_t arena_offset = 0;
  for (const auto &output : outputs) {
    const uint32_t alignment = std::max<uint32_t>(
      1u,
      output.required_alignment > 0 ? output.required_alignment : output.alignment
    );
    if (external_payload_descriptors) {
      if (!output.payload_ptr && output.payload_length > 0u) {
        return SerializePivResponse(
          500,
          false,
          0,
          {},
          "invalid-output-payload",
          "Direct output descriptor payload pointer is null but payload length is non-zero.",
          trace_id,
          false
        );
      }
      const uintptr_t payload_address = reinterpret_cast<uintptr_t>(output.payload_ptr);
      if (
        payload_address > std::numeric_limits<uint32_t>::max() ||
        output.payload_length >
          static_cast<uint32_t>(std::numeric_limits<uint32_t>::max() - payload_address)
      ) {
        return SerializePivResponse(
          500,
          false,
          0,
          {},
          "output-pointer-overflow",
          "Direct output descriptor exceeds the 32-bit SDS TAB offset range.",
          trace_id,
          false
        );
      }
      packed_outputs.push_back(PackedOutputFrame{
        &output,
        static_cast<uint32_t>(payload_address),
        output.payload_length,
        alignment,
        kBufferOwnershipPluginOwned,
      });
      continue;
    }

    size_t aligned_offset = 0;
    if (
      !AlignOffsetChecked(arena_offset, alignment, &aligned_offset) ||
      aligned_offset > std::numeric_limits<uint32_t>::max() ||
      output.payload.size() >
        static_cast<size_t>(std::numeric_limits<uint32_t>::max()) - aligned_offset
    ) {
      return SerializePivResponse(
        500,
        false,
        0,
        {},
        "output-arena-overflow",
        "Output payload arena exceeds the 32-bit SDS TAB offset range.",
        trace_id,
        false
      );
    }
    payload_arena.resize(aligned_offset, 0);
    payload_arena.insert(
      payload_arena.end(),
      output.payload.begin(),
      output.payload.end()
    );
    arena_offset = aligned_offset + output.payload.size();
    packed_outputs.push_back(PackedOutputFrame{
      &output,
      static_cast<uint32_t>(aligned_offset),
      static_cast<uint32_t>(output.payload.size()),
      alignment,
      kBufferOwnershipHostOwned,
    });
  }

  ::flatbuffers::FlatBufferBuilder builder(1024);
  std::vector<::flatbuffers::Offset<TAB>> output_frames{};
  output_frames.reserve(packed_outputs.size());
  for (const auto &packed : packed_outputs) {
    const auto *output = packed.output;
    const auto wire_format =
      output && output->wire_format == static_cast<uint32_t>(kPayloadWireFormatAlignedBinary)
        ? kPayloadWireFormatAlignedBinary
        : kPayloadWireFormatFlatbuffer;
    const auto type_ref = CreateFlatBufferTypeRefDirect(
      builder,
      output && !output->schema_name.empty() ? output->schema_name.c_str() : nullptr,
      output && !output->file_identifier.empty() ? output->file_identifier.c_str() : nullptr,
      output && !output->schema_version.empty() ? output->schema_version.c_str() : nullptr,
      output && !output->root_type_name.empty() ? output->root_type_name.c_str() : nullptr,
      output && !output->schema_hash.empty() ? &output->schema_hash : nullptr,
      false,
      wire_format,
      output ? output->fixed_string_length : 0u,
      output ? output->byte_length : 0u,
      output ? output->required_alignment : 0u
    );
    output_frames.push_back(CreateTABDirect(
      builder,
      packed.offset,
      packed.size,
      packed.alignment,
      wire_format,
      type_ref,
      kBufferMutabilityImmutable,
      packed.ownership,
      output && output->has_frame_id ? output->frame_id : 0,
      output && !output->port_id.empty() ? output->port_id.c_str() : nullptr
    ));
  }

  const auto output_vector = builder.CreateVector(output_frames);
  size_t arena_alignment = static_cast<size_t>(kInvokeArenaAlignment);
  for (const auto &packed : packed_outputs) {
    if (static_cast<size_t>(packed.alignment) > arena_alignment) {
      arena_alignment = static_cast<size_t>(packed.alignment);
    }
  }
  builder.ForceVectorAlignment(
    payload_arena.size(),
    sizeof(uint8_t),
    arena_alignment
  );
  const auto arena_vector = builder.CreateVector(payload_arena);
  const auto error_code_offset =
    error_code.empty() ? 0 : builder.CreateString(error_code);
  const auto error_message_offset =
    error_message.empty() ? 0 : builder.CreateString(error_message);
  const auto response = CreatePIVResponse(
    builder,
    status_code,
    ResolvePivStatus(status_code, yielded, error_code),
    yielded,
    backlog_remaining,
    output_vector,
    arena_vector,
    error_code_offset,
    error_message_offset,
    trace_id
  );
  const auto root = CreatePIV(builder, 0, response);
  FinishPIVBuffer(builder, root);
  if (!payload_arena.empty()) {
    const auto *serialized =
      GetPIV(builder.GetBufferPointer());
    const auto *response_table = serialized ? serialized->RESPONSE() : nullptr;
    const auto *serialized_arena = response_table ? response_table->PAYLOAD_ARENA() : nullptr;
    if (!serialized_arena) {
      std::abort();
    }
    const auto arena_offset = static_cast<size_t>(
      serialized_arena->data() - builder.GetBufferPointer()
    );
    if (arena_offset % arena_alignment != 0u) {
      std::abort();
    }
  }

  return std::vector<uint8_t>(
    builder.GetBufferPointer(),
    builder.GetBufferPointer() + builder.GetSize()
  );
}

static std::vector<uint8_t> SerializeErrorResponse(
  int32_t status_code,
  const char *error_code,
  const std::string &error_message,
  uint64_t trace_id = 0
) {
  return SerializePivResponse(
    status_code,
    false,
    0,
    {},
    error_code ? error_code : "invoke-error",
    error_message,
    trace_id
  );
}

static std::vector<uint8_t> SerializeContextResponse() {
  return SerializePivResponse(
    g_invoke_context.status_code,
    g_invoke_context.yielded,
    g_invoke_context.backlog_remaining,
    g_invoke_context.outputs,
    g_invoke_context.error_code,
    g_invoke_context.error_message,
    g_invoke_context.trace_id,
    g_invoke_context.direct_external_arena_outputs
  );
}

static std::vector<uint8_t> DispatchLoadedContext(
  const MethodDescriptor *method,
  bool inputs_loaded,
  bool *runtime_error
) {
  if (!inputs_loaded || !ValidateInputFrames(method)) {
    if (runtime_error) {
      *runtime_error = true;
    }
    if (g_invoke_context.status_code == 0) {
      g_invoke_context.status_code = 400;
    }
    return SerializeContextResponse();
  }

  g_invoke_context.status_code = method->handler ? method->handler() : -1;
  return SerializeContextResponse();
}

static std::vector<uint8_t> DispatchPivRequestObject(
  const PIVRequest &request,
  bool *runtime_error
) {
  const auto method_id = FlatBufferStringValue(request.METHOD_ID());
  const auto trace_id = request.TRACE_ID();
  const auto *method = FindMethod(method_id);
  if (!method) {
    if (runtime_error) {
      *runtime_error = true;
    }
    return SerializeErrorResponse(
      404,
      "unknown-method",
      std::string("Unknown method: ") + method_id,
      trace_id
    );
  }

  ResetInvokeContext(method);
  g_invoke_context.trace_id = trace_id;
  g_invoke_context.direct_external_arena_outputs =
    g_direct_invoke_stream && PivRequestUsesExternalPayloadArena(request);
  return DispatchLoadedContext(
    method,
    LoadInputsFromPivRequest(request),
    runtime_error
  );
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

  if (request_len < 8u || !PIVBufferHasIdentifier(request_bytes)) {
    if (runtime_error) {
      *runtime_error = true;
    }
    return SerializeErrorResponse(400, "invalid-request", "Invoke request must be an SDS PIV envelope.");
  }

  ::flatbuffers::Verifier verifier(request_bytes, request_len);
  if (!VerifyPIVBuffer(verifier)) {
    if (runtime_error) {
      *runtime_error = true;
    }
    return SerializeErrorResponse(400, "invalid-request", "SDS PIV invoke envelope verification failed.");
  }

  const auto *envelope = GetPIV(request_bytes);
  const auto *request = envelope ? envelope->REQUEST() : nullptr;
  if (!request) {
    if (runtime_error) {
      *runtime_error = true;
    }
    return SerializeErrorResponse(400, "invalid-request", "SDS PIV invoke envelope does not contain a request.");
  }
  return DispatchPivRequestObject(*request, runtime_error);
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

static bool LoadRawShortcutInput(
  const MethodDescriptor *method,
  const std::vector<uint8_t> &stdin_bytes
) {
  if (!method || !method->raw_shortcut_allowed) {
    return false;
  }
  g_invoke_context.inputs.clear();
  g_invoke_context.inputs.emplace_back();
  auto &owned = g_invoke_context.inputs.back();
  owned = InputFrameOwned{};
  if (method->input_port_count != 1u) {
    return false;
  }
  const auto *accepted = FindCanonicalInputType(method->input_ports[0]);
  if (!accepted) {
    return false;
  }
  owned.port_id = method->raw_input_port_id ? method->raw_input_port_id : "";
  owned.schema_name = accepted->schema_name ? accepted->schema_name : "";
  owned.file_identifier = accepted->file_identifier ? accepted->file_identifier : "";
  owned.root_type_name = accepted->root_type_name ? accepted->root_type_name : "";
  owned.schema_version = accepted->schema_version ? accepted->schema_version : "";
  if (accepted->schema_hash && accepted->schema_hash_length > 0u) {
    owned.schema_hash.assign(
      accepted->schema_hash,
      accepted->schema_hash + accepted->schema_hash_length
    );
  }
  owned.type_wire_format = accepted->wire_format;
  owned.payload = stdin_bytes;
  owned.view.wire_format = static_cast<uint32_t>(kPayloadWireFormatFlatbuffer);
  owned.view.fixed_string_length = accepted->fixed_string_length;
  owned.view.byte_length = accepted->byte_length;
  owned.view.required_alignment = accepted->required_alignment;
  owned.view.alignment = 1;
  owned.view.size = static_cast<uint32_t>(stdin_bytes.size());
  owned.view.generation = 0;
  owned.view.trace_id = 0;
  owned.view.stream_id = 0;
  owned.view.sequence = 0;
  owned.view.end_of_stream = 0;
  owned.view.ownership = static_cast<uint32_t>(kBufferOwnershipHostOwned);
  owned.view.mutability = static_cast<uint32_t>(kBufferMutabilityImmutable);
  PopulateInputView(&owned);
  return true;
}

static std::vector<uint8_t> DispatchRawShortcut(
  const MethodDescriptor *method,
  const std::vector<uint8_t> &stdin_bytes,
  bool *runtime_error
) {
  ResetInvokeContext(method);
  g_invoke_context.trace_id = 0;
  return DispatchLoadedContext(
    method,
    LoadRawShortcutInput(method, stdin_bytes),
    runtime_error
  );
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
    static_cast<uint32_t>(kPayloadWireFormatFlatbuffer),
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
  const PortRequirement *output_port = FindOutputPort(g_invoke_context.method, port_id);
  if (!output_port) {
    SetError(
      "unknown-output-port",
      std::string("Output port is not declared on the active method: ") + port_id
    );
    return -1;
  }
  if (!payload_ptr && payload_length > 0u) {
    SetError("invalid-output-payload", "Output payload pointer is null but payload length is non-zero.");
    return -1;
  }
  const AcceptedTypeRef *accepted_type = output_port->accepted_type_count > 0u
    ? ResolveOutputType(
        *output_port,
        schema_name,
        file_identifier,
        wire_format,
        root_type_name,
        fixed_string_length,
        byte_length,
        required_alignment,
        payload_length)
    : nullptr;
  if (output_port->accepted_type_count > 0u && !accepted_type) {
    SetError(
      "unsupported-output-type",
      std::string("Output frame does not match a declared type on port: ") + port_id
    );
    return -1;
  }

  OutputFrameOwned frame{};
  frame.port_id = ReadCString(port_id);
  frame.schema_name = accepted_type
    ? ReadCString(accepted_type->schema_name)
    : ReadCString(schema_name);
  frame.file_identifier = accepted_type
    ? ReadCString(accepted_type->file_identifier)
    : ReadCString(file_identifier);
  frame.root_type_name = accepted_type
    ? ReadCString(accepted_type->root_type_name)
    : ReadCString(root_type_name);
  frame.schema_version = accepted_type
    ? ReadCString(accepted_type->schema_version)
    : std::string{};
  if (accepted_type && accepted_type->schema_hash && accepted_type->schema_hash_length > 0u) {
    frame.schema_hash.assign(
      accepted_type->schema_hash,
      accepted_type->schema_hash + accepted_type->schema_hash_length
    );
  }
  frame.wire_format = accepted_type && accepted_type->has_wire_format
    ? accepted_type->wire_format
    : wire_format;
  const bool aligned_binary =
    frame.wire_format == static_cast<uint32_t>(kPayloadWireFormatAlignedBinary);
  frame.fixed_string_length = aligned_binary
    ? (accepted_type ? accepted_type->fixed_string_length : fixed_string_length)
    : 0u;
  frame.byte_length = aligned_binary
    ? (accepted_type
        ? accepted_type->byte_length
        : (byte_length > 0u ? byte_length : payload_length))
    : 0u;
  frame.required_alignment = aligned_binary
    ? (accepted_type ? accepted_type->required_alignment : required_alignment)
    : 0u;
  frame.alignment = aligned_binary && frame.required_alignment > 0
    ? frame.required_alignment
    : 8;
  frame.payload_ptr = payload_ptr;
  frame.payload_length = payload_length;
  bool payload_is_sdk_owned = false;
  if (payload_ptr && payload_length > 0u) {
    const uintptr_t payload_address = reinterpret_cast<uintptr_t>(payload_ptr);
    payload_is_sdk_owned =
      payload_address <= std::numeric_limits<uint32_t>::max() &&
      AllocationContains(static_cast<uint32_t>(payload_address), payload_length);
  }
  if (
    payload_ptr &&
    payload_length > 0u &&
    (!g_invoke_context.direct_external_arena_outputs || !payload_is_sdk_owned)
  ) {
    frame.payload.insert(frame.payload.end(), payload_ptr, payload_ptr + payload_length);
  }

  g_invoke_context.outputs.emplace_back(std::move(frame));
  OutputFrameOwned &stored_frame = g_invoke_context.outputs.back();
  if (
    g_invoke_context.direct_external_arena_outputs &&
    !stored_frame.payload.empty()
  ) {
    stored_frame.payload_ptr = stored_frame.payload.data();
    stored_frame.payload_length = static_cast<uint32_t>(stored_frame.payload.size());
  }
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
    wire_format == static_cast<uint32_t>(kPayloadWireFormatAlignedBinary)
      ? payload_length
      : 0u,
    required_alignment,
    payload_ptr,
    payload_length
  );
}

extern "C" int32_t plugin_set_output_frame_id(uint32_t output_index, uint64_t frame_id) {
  if (output_index >= g_invoke_context.outputs.size()) {
    SetError("invalid-output-frame", "Output frame index is out of range.");
    return -1;
  }
  auto &frame = g_invoke_context.outputs[output_index];
  frame.has_frame_id = true;
  frame.frame_id = frame_id;
  frame.sequence = DecodeSdsFrameSequence(frame_id);
  frame.end_of_stream = DecodeSdsFrameEndOfStream(frame_id);
  return 0;
}

extern "C" int32_t plugin_set_output_stream_frame(
  uint32_t output_index,
  uint64_t sequence,
  int32_t end_of_stream
) {
  return plugin_set_output_frame_id(
    output_index,
    EncodeSdsFrameId(sequence, end_of_stream != 0)
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
  // Every region handed across the host boundary is 8-byte aligned so the
  // FlatBuffer arena base stays aligned end-to-end. malloc already returns
  // >=8-aligned blocks on wasm32; this asserts the invariant (fail hard, no
  // realignment fallback) and rounds the size so allocator metadata cannot
  // shrink the guarantee.
  const uint32_t requested = size > 0u ? size : 1u;
  const uint32_t allocation_size =
    (requested + (kInvokeAllocAlignment - 1u)) & ~(kInvokeAllocAlignment - 1u);
  void *ptr = nullptr;
  if (posix_memalign(&ptr, static_cast<size_t>(kInvokeAllocAlignment), allocation_size) != 0) {
    return 0u;
  }
  if ((reinterpret_cast<uintptr_t>(ptr) % kInvokeAllocAlignment) != 0u) {
    std::free(ptr);
    return 0u;
  }
  const uint32_t result = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(ptr));
  TrackAllocation(result, allocation_size);
  return result;
}

extern "C" void plugin_free(uint32_t ptr, uint32_t size) {
  (void)size;
  if (ptr != 0u && UntrackAllocation(ptr)) {
    std::free(reinterpret_cast<void *>(PtrFromU32(ptr)));
  }
}

extern "C" uint32_t plugin_invoke_stream(
  uint32_t request_ptr,
  uint32_t request_len,
  uint32_t response_len_out_ptr
) {
  if (response_len_out_ptr != 0u && !AllocationContains(response_len_out_ptr, 4u)) {
    return 0u;
  }
  if (response_len_out_ptr != 0u) {
    *MutableU32Ptr(response_len_out_ptr) = 0u;
  }

  bool runtime_error = false;
  std::vector<uint8_t> response_bytes;
  if (request_len > 0u && !AllocationContains(request_ptr, request_len)) {
    runtime_error = true;
    response_bytes = SerializeErrorResponse(
      400,
      "invalid-request-pointer",
      "Direct invoke request pointer range is not owned by the module SDK allocator."
    );
  } else if (request_ptr != 0u && (request_ptr % kInvokeArenaAlignment) != 0u) {
    runtime_error = true;
    response_bytes = SerializeErrorResponse(
      400,
      "misaligned-request",
      "Invoke request buffer base is not 8-byte aligned."
    );
  } else {
    const bool previous_direct_invoke_stream = g_direct_invoke_stream;
    g_direct_invoke_stream = true;
    response_bytes = DispatchRequestBytes(
      ConstPtr(request_ptr),
      static_cast<size_t>(request_len),
      &runtime_error
    );
    g_direct_invoke_stream = previous_direct_invoke_stream;
  }
  if (response_bytes.size() > std::numeric_limits<uint32_t>::max()) {
    return 0u;
  }

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


