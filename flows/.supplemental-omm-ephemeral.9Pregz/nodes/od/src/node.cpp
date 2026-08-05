#include "space_data_module_invoke.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <iterator>
#include <map>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <flatbuffers/flatbuffers.h>

#include "FSB/main_generated.h"
#include "OEM_generated.h"
#include "FSB/main_aligned.h"
#include "FSO/main_FSO.h"
#include "od_batch_fit.hpp"
#include "oem_fb_builder.hpp"
#include "result_schema_idl.h"
#include "sds_cid.hpp"

namespace {

constexpr const char* kFsbSchemaName = "FSB.fbs";
constexpr const char* kFsbFileIdentifier = "$FSB";
constexpr const char* kFsbRootType = "FSB";
constexpr uint32_t kFsbAlignedSize = 1'048'744;
constexpr uint16_t kFsbAlignment = 8;
constexpr size_t kFsbSchemaNameCapacity = 64;
constexpr size_t kFsbFileIdentifierCapacity = 4;
constexpr size_t kFsbDataCapacity = 1'048'576;
constexpr size_t kFsbSha256Capacity = 32;
constexpr size_t kMaxOutputStreamBytes = 128u * 1024u * 1024u;
constexpr const char* kFsoSchemaName = "FSO.fbs";
constexpr const char* kFsoFileIdentifier = "$FSO";
constexpr const char* kFsoRootType = "FSO";
constexpr uint32_t kFsoAlignedSize = 361'648;
constexpr uint16_t kFsoAlignment = 8;
constexpr uint32_t kAlignedFsoDatabaseOffset = 16;
constexpr uint32_t kAlignedFsoSchemaOffset = 148;
constexpr uint32_t kAlignedFsoBindingsOffset = 262'296;
constexpr uint32_t kAlignedFsoBindingStride = 135;
constexpr uint32_t kAlignedFsoStatusOffset = 357'392;
constexpr uint32_t kAlignedFsoAffectedRecordsOffset = 357'400;
constexpr uint32_t kAlignedFsoResultBytesOffset = 357'408;
constexpr uint32_t kAlignedFsoErrorCodeOffset = 357'416;
constexpr uint32_t kAlignedFsoMessageOffset = 357'548;
constexpr size_t kFsoErrorCodeCapacity = 128;
constexpr size_t kFsoMessageCapacity = 4'096;
constexpr size_t kMaxNativeResponseBytes = 64u * 1024u * 1024u;
constexpr size_t kMaxStarlinkNativeResponseBytes = 4u * 1024u * 1024u;
constexpr size_t kGuestTransientBudgetBytes = 256u * 1024u * 1024u;
constexpr size_t kMaxIncompleteAssemblies = 64;
constexpr size_t kMaxIncompleteAssemblyDeclaredBytes =
    256u * 1024u * 1024u;
constexpr size_t kMaxIncompleteAssemblyBytes = 128u * 1024u * 1024u;
constexpr size_t kMaxQueuedStorageBytes = 192u * 1024u * 1024u;
constexpr size_t kMaxPendingFitObjects = 64;
constexpr size_t kMaxPendingFitBytes = 128u * 1024u * 1024u;
constexpr size_t kMaxFittedFitObjects = 16;
constexpr size_t kMaxFittedFitBytes = 8u * 1024u * 1024u;
constexpr size_t kMaxFitBatchObjects = 16;
constexpr size_t kMaxFitBatchBytes = 64u * 1024u * 1024u;
constexpr size_t kMaxNativeStatesPerObject = 20000;
constexpr size_t kMaxNativeObjectsPerResponse = 64;
constexpr double kMaxNativeEpochSpanSeconds = 14.0 * 24.0 * 60.0 * 60.0;
constexpr size_t kInputEnvelopeFixedBytes = 1u * 1024u * 1024u;
constexpr size_t kInputFrameMetadataBytes = 4u * 1024u;
constexpr size_t kNativeParseFixedWorkspaceBytes = 2u * 1024u * 1024u;
constexpr size_t kStarlinkNativeParseExpansionFactor = 32;
constexpr size_t kGenericNativeParseExpansionFactor = 64;
constexpr size_t kFitInputExpansionFactor = 16;
constexpr size_t kFitWorkerWorkspaceBytes = 2u * 1024u * 1024u;
constexpr size_t kOutputFixedWorkspaceBytes = 4u * 1024u * 1024u;
constexpr int kFitWorkerThreads = 16;
constexpr int kMaxFitIterations = 60;
constexpr double kMaxFitRmsKm = 12.0;
constexpr std::string_view kFitOptions =
    R"json({"maxIterations":60,"convergenceTolerance":0.001,"multiEpochSpacingSeconds":21600,"multiEpochWindowSeconds":28800})json";
constexpr std::string_view kDerivedTransactionIdDomain =
    "sdn:supplemental-omm:od:derived-transaction:v1";
constexpr std::string_view kFlatSqlTransactionIdDomain =
    "sdn:supplemental-omm:od:flatsql-transaction:v1";
constexpr std::string_view kFlatSqlRecordStreamIdDomain =
    "sdn:supplemental-omm:od:flatsql-record-stream:v1";
constexpr const char* kRecordPortOrder[] = {"omm", "ocm"};

enum class Provider : uint8_t {
  Starlink,
  Glonass,
  Intelsat,
  Cpf,
  Iss,
};

struct ProviderPort {
  const char* port_id;
  Provider provider;
};

constexpr ProviderPort kProviderPorts[] = {
    {"starlink", Provider::Starlink},
    {"glonass", Provider::Glonass},
    {"intelsat", Provider::Intelsat},
    {"cpf", Provider::Cpf},
    {"iss", Provider::Iss},
};

struct Chunk {
  uint64_t request_id = 0;
  uint32_t sequence = 0;
  bool final = false;
  uint64_t total_bytes = 0;
  uint64_t record_count = 0;
  std::string schema_name;
  std::string file_identifier;
  std::vector<uint8_t> data;
  std::vector<uint8_t> sha256;
  uint32_t wire_format = PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER;
};

struct AssemblyKey {
  Provider provider;
  uint64_t request_id;

  bool operator<(const AssemblyKey& other) const {
    if (provider != other.provider) {
      return static_cast<uint8_t>(provider) <
             static_cast<uint8_t>(other.provider);
    }
    return request_id < other.request_id;
  }
};

struct Assembly {
  uint32_t next_sequence = 0;
  uint64_t total_bytes = 0;
  uint64_t record_count = 0;
  uint32_t wire_format = PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER;
  std::string schema_name;
  std::string file_identifier;
  std::vector<uint8_t> sha256;
  std::vector<uint8_t> bytes;
};

struct RecordStreamAccumulator {
  const char* port_id = nullptr;
  const char* schema_name = nullptr;
  const char* file_identifier = nullptr;
  uint32_t wire_format = PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER;
  uint64_t record_count = 0;
  std::vector<uint8_t> data;
};

struct OutputStreamRequestIdentity {
  const RecordStreamAccumulator* stream = nullptr;
  std::array<uint8_t, 32> digest{};
  uint64_t request_id = 0;
};

struct OutputRequestIdentity {
  std::array<uint8_t, 32> transaction_digest{};
  uint64_t configuration_request_id = 0;
  std::vector<OutputStreamRequestIdentity> streams;
};

struct NativeState {
  std::string epoch;
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double vx = 0.0;
  double vy = 0.0;
  double vz = 0.0;
};

struct PendingFitObject {
  od::BatchObject object;
  uint32_t wire_format = PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER;
  uint64_t transaction_id = 0;
  std::string identity;
};

struct FittedFitObject {
  od::BatchResult result;
  uint32_t wire_format = PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER;
  uint64_t transaction_id = 0;
  std::string identity;
  od::BatchRunStats stats;
  size_t batch_object_count = 0;
};

std::map<AssemblyKey, Assembly> g_assemblies;
std::deque<PendingFitObject> g_pending_fit_objects;
std::deque<FittedFitObject> g_fitted_fit_objects;
size_t g_current_input_envelope_bytes = 0;
alignas(8) Aligned::FSB g_aligned_output{};
alignas(8) uint8_t g_aligned_control[kFsoAlignedSize]{};

bool add_within(size_t* total, size_t value, size_t limit) {
  if (!total || *total > limit || value > limit - *total) return false;
  *total += value;
  return true;
}

bool add_product_within(size_t* total, size_t count, size_t item_bytes,
                        size_t limit) {
  if (item_bytes != 0 && count > limit / item_bytes) return false;
  return add_within(total, count * item_bytes, limit);
}

size_t incomplete_assembly_declared_bytes() {
  size_t total = 0;
  for (const auto& entry : g_assemblies) {
    if (!add_within(&total, static_cast<size_t>(entry.second.total_bytes),
                    kMaxIncompleteAssemblyDeclaredBytes)) {
      return kMaxIncompleteAssemblyDeclaredBytes + 1;
    }
  }
  return total;
}

size_t incomplete_assembly_bytes() {
  size_t total = 0;
  for (const auto& entry : g_assemblies) {
    if (!add_within(&total, entry.second.bytes.size(),
                    kMaxIncompleteAssemblyBytes)) {
      return kMaxIncompleteAssemblyBytes + 1;
    }
  }
  return total;
}

size_t incomplete_assembly_storage_bytes() {
  size_t total = 0;
  for (const auto& entry : g_assemblies) {
    if (!add_within(&total, entry.second.bytes.capacity(),
                    kMaxQueuedStorageBytes)) {
      return kMaxQueuedStorageBytes + 1;
    }
  }
  return total;
}

size_t pending_object_storage_bytes(const PendingFitObject& pending) {
  size_t total = pending.object.oem.capacity();
  if (!add_within(&total, pending.object.fit_options.capacity(),
                  kGuestTransientBudgetBytes) ||
      !add_within(&total, pending.identity.capacity(),
                  kGuestTransientBudgetBytes)) {
    return kGuestTransientBudgetBytes + 1;
  }
  return total;
}

size_t pending_fit_bytes() {
  size_t total = 0;
  for (const PendingFitObject& pending : g_pending_fit_objects) {
    if (!add_within(&total, pending_object_storage_bytes(pending),
                    kMaxPendingFitBytes)) {
      return kMaxPendingFitBytes + 1;
    }
  }
  return total;
}

size_t batch_result_storage_bytes(const od::BatchResult& result) {
  size_t total = result.omm.capacity();
  if (!add_within(&total, result.ocm.capacity(),
                  kGuestTransientBudgetBytes) ||
      !add_within(&total, result.error_code.capacity(),
                  kGuestTransientBudgetBytes) ||
      !add_within(&total, result.error_message.capacity(),
                  kGuestTransientBudgetBytes) ||
      !add_product_within(&total, result.additional_epochs.capacity(),
                          sizeof(od::BatchEpochResult),
                          kGuestTransientBudgetBytes)) {
    return kGuestTransientBudgetBytes + 1;
  }
  for (const od::BatchEpochResult& epoch : result.additional_epochs) {
    if (!add_within(&total, epoch.omm.capacity(),
                    kGuestTransientBudgetBytes) ||
        !add_within(&total, epoch.ocm.capacity(),
                    kGuestTransientBudgetBytes)) {
      return kGuestTransientBudgetBytes + 1;
    }
  }
  return total;
}

size_t fitted_object_storage_bytes(const FittedFitObject& fitted) {
  size_t total = batch_result_storage_bytes(fitted.result);
  if (!add_within(&total, fitted.identity.capacity(),
                  kGuestTransientBudgetBytes)) {
    return kGuestTransientBudgetBytes + 1;
  }
  return total;
}

size_t fitted_fit_bytes() {
  size_t total = 0;
  for (const FittedFitObject& fitted : g_fitted_fit_objects) {
    if (!add_within(&total, fitted_object_storage_bytes(fitted),
                    kMaxFittedFitBytes)) {
      return kMaxFittedFitBytes + 1;
    }
  }
  return total;
}

size_t queued_storage_bytes() {
  size_t total = incomplete_assembly_storage_bytes();
  if (!add_within(&total, pending_fit_bytes(), kMaxQueuedStorageBytes) ||
      !add_within(&total, fitted_fit_bytes(), kMaxQueuedStorageBytes)) {
    return kMaxQueuedStorageBytes + 1;
  }
  return total;
}

size_t scaled_workspace_bytes(size_t fixed_bytes, size_t input_bytes,
                              size_t expansion_factor) {
  size_t total = fixed_bytes;
  if (expansion_factor != 0 &&
      input_bytes >
          (kGuestTransientBudgetBytes - std::min(
               fixed_bytes, kGuestTransientBudgetBytes)) /
              expansion_factor) {
    return kGuestTransientBudgetBytes + 1;
  }
  if (!add_within(&total, input_bytes * expansion_factor,
                  kGuestTransientBudgetBytes)) {
    return kGuestTransientBudgetBytes + 1;
  }
  return total;
}

size_t current_input_envelope_bytes() {
  size_t total = kInputEnvelopeFixedBytes;
  for (uint32_t index = 0; index < plugin_get_input_count(); ++index) {
    const plugin_input_frame_t* frame = plugin_get_input_frame(index);
    if (!add_within(&total, kInputFrameMetadataBytes,
                    kGuestTransientBudgetBytes) ||
        (frame &&
         !add_within(&total, frame->payload_length,
                     kGuestTransientBudgetBytes))) {
      return kGuestTransientBudgetBytes + 1;
    }
  }
  return total;
}

bool transient_budget_allows(size_t workspace_bytes) {
  size_t total = g_current_input_envelope_bytes;
  const size_t queued_bytes = queued_storage_bytes();
  if (queued_bytes > kMaxQueuedStorageBytes ||
      !add_within(&total, queued_bytes, kGuestTransientBudgetBytes)) {
    return false;
  }
  return add_within(&total, workspace_bytes, kGuestTransientBudgetBytes);
}

bool transient_budget_allows_after_releasing(size_t workspace_bytes,
                                             size_t released_queued_bytes) {
  const size_t queued_bytes = queued_storage_bytes();
  if (queued_bytes > kMaxQueuedStorageBytes ||
      released_queued_bytes > queued_bytes) {
    return false;
  }
  size_t total = g_current_input_envelope_bytes;
  if (!add_within(&total, queued_bytes - released_queued_bytes,
                  kGuestTransientBudgetBytes)) {
    return false;
  }
  return add_within(&total, workspace_bytes, kGuestTransientBudgetBytes);
}

size_t native_parse_workspace_bytes(Provider provider,
                                    const Assembly& completed,
                                    size_t decoded_chunk_bytes) {
  const size_t expansion_factor =
      provider == Provider::Starlink
          ? kStarlinkNativeParseExpansionFactor
          : kGenericNativeParseExpansionFactor;
  size_t total = completed.bytes.capacity();
  if (!add_within(&total, decoded_chunk_bytes,
                  kGuestTransientBudgetBytes)) {
    return kGuestTransientBudgetBytes + 1;
  }
  const size_t expansion = scaled_workspace_bytes(
      kNativeParseFixedWorkspaceBytes, completed.bytes.size(),
      expansion_factor);
  if (!add_within(&total, expansion, kGuestTransientBudgetBytes)) {
    return kGuestTransientBudgetBytes + 1;
  }
  return total;
}

size_t fit_workspace_bytes(size_t admitted_storage_bytes,
                           size_t batch_oem_bytes,
                           size_t batch_object_count) {
  size_t total = admitted_storage_bytes;
  const size_t expanded_inputs =
      scaled_workspace_bytes(0, batch_oem_bytes, kFitInputExpansionFactor);
  if (!add_within(&total, expanded_inputs, kGuestTransientBudgetBytes) ||
      batch_object_count >
          kGuestTransientBudgetBytes / kFitWorkerWorkspaceBytes ||
      !add_within(&total,
                  batch_object_count * kFitWorkerWorkspaceBytes,
                  kGuestTransientBudgetBytes)) {
    return kGuestTransientBudgetBytes + 1;
  }
  return total;
}

size_t output_workspace_bytes(size_t fitted_storage_bytes) {
  return scaled_workspace_bytes(kOutputFixedWorkspaceBytes,
                                fitted_storage_bytes, 7);
}

bool pending_head_fit_reserve_allows_after_releasing(
    size_t additional_queued_bytes, size_t released_fitted_storage_bytes,
    const PendingFitObject* first_additional = nullptr) {
  const PendingFitObject* head =
      !g_pending_fit_objects.empty() ? &g_pending_fit_objects.front()
                                     : first_additional;
  if (!head) return true;
  const size_t head_storage_bytes = pending_object_storage_bytes(*head);
  const size_t head_workspace = fit_workspace_bytes(
      head_storage_bytes, head->object.oem.size(), 1);
  const size_t queued_bytes = queued_storage_bytes();
  size_t total = g_current_input_envelope_bytes;
  if (head_storage_bytes > kGuestTransientBudgetBytes ||
      head_workspace > kGuestTransientBudgetBytes ||
      queued_bytes > kMaxQueuedStorageBytes ||
      released_fitted_storage_bytes > kMaxFittedFitBytes ||
      released_fitted_storage_bytes > queued_bytes ||
      !add_within(&total,
                  queued_bytes - released_fitted_storage_bytes,
                  kGuestTransientBudgetBytes) ||
      !add_within(&total, additional_queued_bytes,
                  kGuestTransientBudgetBytes) ||
      head_storage_bytes > total) {
    return false;
  }
  total -= head_storage_bytes;
  return add_within(&total, head_workspace, kGuestTransientBudgetBytes);
}

bool pending_head_fit_reserve_allows(
    size_t additional_queued_bytes,
    const PendingFitObject* first_additional = nullptr) {
  return pending_head_fit_reserve_allows_after_releasing(
      additional_queued_bytes, 0, first_additional);
}

bool pending_head_fit_is_runnable() {
  return pending_head_fit_reserve_allows(0);
}

bool fitted_head_output_reserve_allows(size_t additional_queued_bytes) {
  if (g_fitted_fit_objects.empty()) return true;
  const size_t head_storage_bytes =
      fitted_object_storage_bytes(g_fitted_fit_objects.front());
  const size_t head_workspace = output_workspace_bytes(head_storage_bytes);
  const size_t queued_bytes = queued_storage_bytes();
  size_t total = g_current_input_envelope_bytes;
  if (head_storage_bytes > kGuestTransientBudgetBytes ||
      head_workspace > kGuestTransientBudgetBytes ||
      queued_bytes > kMaxQueuedStorageBytes ||
      !add_within(&total, queued_bytes, kGuestTransientBudgetBytes) ||
      !add_within(&total, additional_queued_bytes,
                  kGuestTransientBudgetBytes) ||
      head_storage_bytes > total) {
    return false;
  }
  total -= head_storage_bytes;
  return add_within(&total, head_workspace, kGuestTransientBudgetBytes);
}

bool active_head_work_reserve_allows(
    size_t additional_queued_bytes,
    const PendingFitObject* first_additional = nullptr) {
  if (!g_fitted_fit_objects.empty()) {
    if (!fitted_head_output_reserve_allows(additional_queued_bytes)) {
      return false;
    }
    return pending_head_fit_reserve_allows_after_releasing(
        additional_queued_bytes, fitted_fit_bytes(), first_additional);
  }
  return pending_head_fit_reserve_allows(additional_queued_bytes,
                                         first_additional);
}

void append_u32_be(std::vector<uint8_t>* output, uint32_t value) {
  output->push_back(static_cast<uint8_t>((value >> 24) & 0xff));
  output->push_back(static_cast<uint8_t>((value >> 16) & 0xff));
  output->push_back(static_cast<uint8_t>((value >> 8) & 0xff));
  output->push_back(static_cast<uint8_t>(value & 0xff));
}

void append_u64_be(std::vector<uint8_t>* output, uint64_t value) {
  for (int shift = 56; shift >= 0; shift -= 8) {
    output->push_back(static_cast<uint8_t>((value >> shift) & 0xff));
  }
}

void append_text(std::vector<uint8_t>* output, std::string_view value) {
  append_u32_be(output, static_cast<uint32_t>(value.size()));
  output->insert(output->end(), value.begin(), value.end());
}

void append_domain(std::vector<uint8_t>* output, std::string_view domain) {
  output->insert(output->end(), domain.begin(), domain.end());
  output->push_back(0);
}

uint64_t project_nonzero_request_id(const uint8_t digest[32]) {
  uint64_t request_id = 0;
  for (size_t index = 0; index < sizeof(uint64_t); ++index) {
    request_id = (request_id << 8) | digest[index];
  }
  return request_id == 0 ? 1 : request_id;
}

bool request_id_is_used(const OutputRequestIdentity& identity,
                        uint64_t request_id,
                        const OutputStreamRequestIdentity* excluded) {
  if (identity.configuration_request_id == request_id) return true;
  return std::any_of(
      identity.streams.begin(), identity.streams.end(),
      [request_id, excluded](const OutputStreamRequestIdentity& stream) {
        return &stream != excluded && stream.request_id == request_id;
      });
}

bool derive_output_request_identity(
    const std::vector<RecordStreamAccumulator>& streams,
    uint64_t transaction_id,
    OutputRequestIdentity* identity) {
  if (!identity || transaction_id == 0 ||
      streams.empty() || streams.size() > std::size(kRecordPortOrder)) {
    return false;
  }
  identity->streams.clear();
  identity->streams.reserve(streams.size());
  identity->configuration_request_id = transaction_id;

  std::vector<uint8_t> transaction_preimage;
  append_domain(&transaction_preimage, kFlatSqlTransactionIdDomain);
  append_u64_be(&transaction_preimage, transaction_id);
  append_u32_be(&transaction_preimage,
                static_cast<uint32_t>(streams.size()));
  for (const char* port_id : kRecordPortOrder) {
    auto found = std::find_if(
        streams.begin(), streams.end(),
        [port_id](const RecordStreamAccumulator& stream) {
          return std::strcmp(stream.port_id, port_id) == 0;
        });
    if (found == streams.end()) continue;
    if (found->data.empty() || found->record_count == 0 ||
        std::find_if(std::next(found), streams.end(),
                     [port_id](const RecordStreamAccumulator& stream) {
                       return std::strcmp(stream.port_id, port_id) == 0;
                     }) != streams.end()) {
      return false;
    }
    OutputStreamRequestIdentity stream_identity;
    stream_identity.stream = &*found;
    sdn_cid::sha256_raw(found->data.data(), found->data.size(),
                        stream_identity.digest.data());
    append_text(&transaction_preimage, found->port_id);
    append_text(&transaction_preimage, found->schema_name);
    append_text(&transaction_preimage, found->file_identifier);
    append_u64_be(&transaction_preimage, found->record_count);
    append_u64_be(&transaction_preimage,
                  static_cast<uint64_t>(found->data.size()));
    transaction_preimage.insert(transaction_preimage.end(),
                                stream_identity.digest.begin(),
                                stream_identity.digest.end());
    identity->streams.push_back(stream_identity);
  }
  if (identity->streams.size() != streams.size()) return false;

  sdn_cid::sha256_raw(transaction_preimage.data(),
                      transaction_preimage.size(),
                      identity->transaction_digest.data());

  for (OutputStreamRequestIdentity& stream_identity : identity->streams) {
    const RecordStreamAccumulator& stream = *stream_identity.stream;
    std::vector<uint8_t> base_preimage;
    append_domain(&base_preimage, kFlatSqlRecordStreamIdDomain);
    base_preimage.insert(base_preimage.end(),
                         identity->transaction_digest.begin(),
                         identity->transaction_digest.end());
    append_text(&base_preimage, stream.port_id);
    append_text(&base_preimage, stream.schema_name);
    append_text(&base_preimage, stream.file_identifier);
    append_u64_be(&base_preimage, stream.record_count);
    append_u64_be(&base_preimage,
                  static_cast<uint64_t>(stream.data.size()));
    base_preimage.insert(base_preimage.end(), stream_identity.digest.begin(),
                         stream_identity.digest.end());
    uint32_t collision_salt = 0;
    do {
      std::vector<uint8_t> preimage = base_preimage;
      if (collision_salt != 0) append_u32_be(&preimage, collision_salt);
      std::array<uint8_t, 32> digest{};
      sdn_cid::sha256_raw(preimage.data(), preimage.size(), digest.data());
      stream_identity.request_id = project_nonzero_request_id(digest.data());
      ++collision_salt;
    } while (request_id_is_used(*identity, stream_identity.request_id,
                                &stream_identity));
  }
  return true;
}

std::string_view trim_view(std::string_view input) {
  const size_t start = input.find_first_not_of(" \t\r\n");
  if (start == std::string_view::npos) return {};
  const size_t end = input.find_last_not_of(" \t\r\n");
  return input.substr(start, end - start + 1);
}

template <size_t TokenCapacity>
struct TokenViews {
  std::array<std::string_view, TokenCapacity> values{};
  size_t count = 0;

  size_t size() const { return count; }
  bool empty() const { return count == 0; }
  std::string_view operator[](size_t index) const { return values[index]; }
};

template <size_t TokenCapacity>
TokenViews<TokenCapacity> split_ws(std::string_view line) {
  TokenViews<TokenCapacity> tokens;
  size_t cursor = 0;
  while (cursor < line.size()) {
    while (cursor < line.size() &&
           std::isspace(static_cast<unsigned char>(line[cursor]))) {
      ++cursor;
    }
    const size_t start = cursor;
    while (cursor < line.size() &&
           !std::isspace(static_cast<unsigned char>(line[cursor]))) {
      ++cursor;
    }
    if (cursor > start) {
      if (tokens.count == TokenCapacity) break;
      tokens.values[tokens.count++] = line.substr(start, cursor - start);
    }
  }
  return tokens;
}

template <size_t Capacity = 96>
bool token_c_string(std::string_view token, std::array<char, Capacity>* buffer) {
  if (!buffer || token.empty() || token.size() >= Capacity) return false;
  std::memcpy(buffer->data(), token.data(), token.size());
  (*buffer)[token.size()] = '\0';
  return true;
}

long parse_long(std::string_view token) {
  std::array<char, 96> buffer{};
  if (!token_c_string(token, &buffer)) return 0;
  return std::strtol(buffer.data(), nullptr, 10);
}

unsigned long parse_unsigned_long(std::string_view token) {
  std::array<char, 96> buffer{};
  if (!token_c_string(token, &buffer)) return 0;
  return std::strtoul(buffer.data(), nullptr, 10);
}

double parse_double(std::string_view token) {
  std::array<char, 96> buffer{};
  if (!token_c_string(token, &buffer)) return 0.0;
  return std::strtod(buffer.data(), nullptr);
}

template <typename Callback>
void for_each_line(std::string_view content, Callback callback) {
  size_t cursor = 0;
  while (cursor <= content.size()) {
    const size_t newline = content.find('\n', cursor);
    const size_t end = newline == std::string::npos ? content.size() : newline;
    callback(content.substr(cursor, end - cursor));
    if (newline == std::string::npos) break;
    cursor = newline + 1;
  }
}

void append_two_digits(std::string* output, int value) {
  output->push_back(static_cast<char>('0' + ((value / 10) % 10)));
  output->push_back(static_cast<char>('0' + (value % 10)));
}

std::string calendar_iso(int year, int month, int day, int hour, int minute,
                         double seconds) {
  int whole_seconds = static_cast<int>(seconds);
  int millis = static_cast<int>((seconds - whole_seconds) * 1000.0 + 0.5);
  if (millis >= 1000) {
    ++whole_seconds;
    millis -= 1000;
  }
  char buffer[48];
  std::snprintf(buffer, sizeof(buffer),
                "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", year, month, day,
                hour, minute, whole_seconds, millis);
  return buffer;
}

std::string day_of_year_iso(int year, int day_of_year, int hour, int minute,
                            double seconds) {
  const bool leap =
      (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
  const int month_days[] = {31, leap ? 29 : 28, 31, 30, 31, 30,
                            31, 31, 30, 31, 30, 31};
  int month = 1;
  int day = day_of_year;
  while (month <= 12 && day > month_days[month - 1]) {
    day -= month_days[month - 1];
    ++month;
  }
  if (month > 12 || day <= 0) return {};
  return calendar_iso(year, month, day, hour, minute, seconds);
}

int64_t days_from_civil(int year, unsigned month, unsigned day) {
  year -= month <= 2;
  const int era = (year >= 0 ? year : year - 399) / 400;
  const unsigned year_of_era =
      static_cast<unsigned>(year - era * 400);
  const unsigned adjusted_month = month > 2 ? month - 3 : month + 9;
  const unsigned day_of_year =
      (153 * adjusted_month + 2) / 5 + day - 1;
  const unsigned day_of_era =
      year_of_era * 365 + year_of_era / 4 - year_of_era / 100 +
      day_of_year;
  return static_cast<int64_t>(era) * 146097 +
         static_cast<int64_t>(day_of_era) - 719468;
}

bool iso_epoch_seconds(std::string_view epoch, double* seconds) {
  if (!seconds || epoch.size() < 20 || epoch[4] != '-' || epoch[7] != '-' ||
      epoch[10] != 'T' || epoch[13] != ':' || epoch[16] != ':') {
    return false;
  }
  const int year = static_cast<int>(parse_long(epoch.substr(0, 4)));
  const unsigned month =
      static_cast<unsigned>(parse_long(epoch.substr(5, 2)));
  const unsigned day =
      static_cast<unsigned>(parse_long(epoch.substr(8, 2)));
  const int hour = static_cast<int>(parse_long(epoch.substr(11, 2)));
  const int minute = static_cast<int>(parse_long(epoch.substr(14, 2)));
  const double second = parse_double(epoch.substr(17));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 ||
      hour > 23 || minute < 0 || minute > 59 || !std::isfinite(second) ||
      second < 0.0 || second >= 61.0) {
    return false;
  }
  *seconds = static_cast<double>(days_from_civil(year, month, day)) *
                 86400.0 +
             static_cast<double>(hour * 3600 + minute * 60) + second;
  return std::isfinite(*seconds);
}

void append_native_state_bounded(std::vector<NativeState>* states,
                                 NativeState state) {
  if (!states || states->size() >= kMaxNativeStatesPerObject) return;
  states->push_back(std::move(state));
}

bool native_states_within_bounds(const std::vector<NativeState>& states) {
  if (states.size() < 3 || states.size() > kMaxNativeStatesPerObject) {
    return false;
  }
  double first = 0.0;
  if (!iso_epoch_seconds(states.front().epoch, &first)) return false;
  double minimum = first;
  double maximum = first;
  for (const NativeState& state : states) {
    double epoch = 0.0;
    if (!iso_epoch_seconds(state.epoch, &epoch)) return false;
    minimum = std::min(minimum, epoch);
    maximum = std::max(maximum, epoch);
  }
  return maximum - minimum <= kMaxNativeEpochSpanSeconds;
}

std::string meme_epoch_iso(std::string_view token) {
  if (token.size() < 13) return {};
  for (size_t index = 0; index < 13; ++index) {
    if (!std::isdigit(static_cast<unsigned char>(token[index]))) return {};
  }
  const int year = static_cast<int>(parse_long(token.substr(0, 4)));
  const int day = static_cast<int>(parse_long(token.substr(4, 3)));
  const int hour = static_cast<int>(parse_long(token.substr(7, 2)));
  const int minute = static_cast<int>(parse_long(token.substr(9, 2)));
  const double seconds = parse_double(token.substr(11));
  return day_of_year_iso(year, day, hour, minute, seconds);
}

std::string julian_iso(double julian_date) {
  const double shifted = julian_date + 0.5;
  const int z = static_cast<int>(shifted);
  const double fraction = shifted - static_cast<double>(z);
  int a = z;
  if (z >= 2299161) {
    const int alpha = static_cast<int>((z - 1867216.25) / 36524.25);
    a = z + 1 + alpha - alpha / 4;
  }
  const int b = a + 1524;
  const int c = static_cast<int>((b - 122.1) / 365.25);
  const int d = static_cast<int>(365.25 * c);
  const int e = static_cast<int>((b - d) / 30.6001);
  const int day = b - d - static_cast<int>(30.6001 * e);
  const int month = e < 14 ? e - 1 : e - 13;
  const int year = month > 2 ? c - 4716 : c - 4715;
  const double hours_value = fraction * 24.0;
  const int hour = static_cast<int>(hours_value);
  const double minutes_value = (hours_value - hour) * 60.0;
  const int minute = static_cast<int>(minutes_value);
  const double seconds = (minutes_value - minute) * 60.0;
  return calendar_iso(year, month, day, hour, minute, seconds);
}

std::string normalize_iss_epoch(std::string_view raw_value) {
  std::string value(trim_view(raw_value));
  if (!value.empty() && value.back() != 'Z') value.push_back('Z');
  return value;
}

bool parse_starlink_identity(const std::string& schema_name,
                             uint32_t* norad,
                             std::string* object_name) {
  constexpr const char* prefix = "MEME:";
  if (schema_name.compare(0, std::strlen(prefix), prefix) != 0) return false;
  const size_t id_start = std::strlen(prefix);
  const size_t separator = schema_name.find(':', id_start);
  if (separator == std::string::npos) return false;
  *norad = static_cast<uint32_t>(
      std::strtoul(schema_name.substr(id_start, separator - id_start).c_str(),
                   nullptr, 10));
  *object_name = schema_name.substr(separator + 1);
  return *norad != 0 && !object_name->empty();
}

std::vector<uint8_t> build_custom_oem(const std::string& object_name,
                                      const std::string& object_id,
                                      uint32_t norad,
                                      CustomFrame frame,
                                      timingStandard time_system,
                                      const std::vector<NativeState>& states) {
  if (!native_states_within_bounds(states)) return {};
  const oem_fb::Identity identity{object_name.c_str(), object_id.c_str(), norad};
  return oem_fb::build_oem_flatbuffer(
      identity, frame, "EARTH", time_system, states.data(),
      static_cast<int>(states.size()));
}

std::vector<uint8_t> build_celestial_oem(
    const std::string& object_name, const std::string& object_id,
    uint32_t norad, CelestialFrame frame, timingStandard time_system,
    const std::vector<NativeState>& states) {
  if (!native_states_within_bounds(states)) return {};
  const oem_fb::Identity identity{object_name.c_str(), object_id.c_str(), norad};
  return oem_fb::build_oem_flatbuffer(
      identity, frame, "EARTH", time_system, states.data(),
      static_cast<int>(states.size()));
}

std::vector<od::BatchObject> parse_starlink_meme(
    std::string_view content, const std::string& schema_name) {
  uint32_t norad = 0;
  std::string object_name = "STARLINK";
  parse_starlink_identity(schema_name, &norad, &object_name);
  std::vector<NativeState> states;
  for_each_line(content, [&](std::string_view line) {
    const TokenViews<8> tokens = split_ws<8>(line);
    if (tokens.size() < 7) return;
    const std::string epoch = meme_epoch_iso(tokens[0]);
    if (epoch.empty()) return;
    NativeState state;
    state.epoch = epoch;
    state.x = parse_double(tokens[1]);
    state.y = parse_double(tokens[2]);
    state.z = parse_double(tokens[3]);
    state.vx = parse_double(tokens[4]);
    state.vy = parse_double(tokens[5]);
    state.vz = parse_double(tokens[6]);
    append_native_state_bounded(&states, std::move(state));
  });
  // Starlink Modified ITC position/velocity states are EME2000, irrespective
  // of the covariance-frame token on header line four:
  // https://docs.space-safety.starlink.com/docs/tutorial-basics/trajectories/
  std::vector<uint8_t> oem = build_celestial_oem(
      object_name, "", norad, CelestialFrame::EME2000,
      timingStandard::UTC, states);
  if (oem.empty()) return {};
  return {{std::move(oem)}};
}

std::vector<od::BatchObject> parse_glonass_sp3(std::string_view content) {
  struct Satellite {
    std::string id;
    std::vector<NativeState> states;
  };
  std::vector<Satellite> satellites;
  bool object_capacity_exceeded = false;
  std::string epoch;
  for_each_line(content, [&](std::string_view line) {
    const TokenViews<8> tokens = split_ws<8>(line);
    if (tokens.empty()) return;
    if (tokens[0] == "*" && tokens.size() >= 7) {
      epoch = calendar_iso(
          static_cast<int>(parse_long(tokens[1])),
          static_cast<int>(parse_long(tokens[2])),
          static_cast<int>(parse_long(tokens[3])),
          static_cast<int>(parse_long(tokens[4])),
          static_cast<int>(parse_long(tokens[5])),
          parse_double(tokens[6]));
      return;
    }
    if (tokens[0].size() < 3 || tokens[0][0] != 'P' ||
        tokens[0][1] != 'R' || tokens.size() < 4 || epoch.empty()) {
      return;
    }
    const std::string id(tokens[0].substr(1));
    Satellite* satellite = nullptr;
    for (Satellite& candidate : satellites) {
      if (candidate.id == id) {
        satellite = &candidate;
        break;
      }
    }
    if (!satellite) {
      if (satellites.size() >= kMaxNativeObjectsPerResponse) {
        object_capacity_exceeded = true;
        return;
      }
      satellites.push_back({id, {}});
      satellite = &satellites.back();
    }
    NativeState state;
    state.epoch = epoch;
    state.x = parse_double(tokens[1]);
    state.y = parse_double(tokens[2]);
    state.z = parse_double(tokens[3]);
    if (state.x != 0.0 || state.y != 0.0 || state.z != 0.0) {
      append_native_state_bounded(&satellite->states, std::move(state));
    }
  });
  if (object_capacity_exceeded) return {};
  std::vector<od::BatchObject> objects;
  objects.reserve(satellites.size());
  for (const Satellite& satellite : satellites) {
    std::vector<uint8_t> oem = build_custom_oem(
        "GLONASS " + satellite.id, "", 0, CustomFrame::ECEF,
        timingStandard::GPS, satellite.states);
    if (!oem.empty()) objects.push_back({std::move(oem)});
  }
  return objects;
}

std::vector<od::BatchObject> parse_intelsat_ecf(std::string_view content) {
  std::string object_name = "INTELSAT";
  std::vector<NativeState> states;
  bool first_line = true;
  for_each_line(content, [&](std::string_view line) {
    if (first_line) {
      first_line = false;
      const std::string marker = "Intelsat ";
      const size_t start = line.find(marker);
      if (start != std::string::npos) {
        const size_t name_start = start + marker.size();
        const size_t name_end = line.find_first_of(" \t/", name_start);
        object_name.assign(line.substr(name_start, name_end - name_start));
      }
      return;
    }
    const TokenViews<6> tokens = split_ws<6>(line);
    if (tokens.size() < 5 || tokens[0].size() < 10 || tokens[0][4] != '/' ||
        tokens[0][7] != '/') {
      return;
    }
    NativeState state;
    state.epoch.assign(tokens[0]);
    std::replace(state.epoch.begin(), state.epoch.end(), '/', '-');
    state.epoch += "T";
    state.epoch.append(tokens[1]);
    state.epoch += "Z";
    state.x = parse_double(tokens[2]) / 1000.0;
    state.y = parse_double(tokens[3]) / 1000.0;
    state.z = parse_double(tokens[4]) / 1000.0;
    append_native_state_bounded(&states, std::move(state));
  });
  std::vector<uint8_t> oem = build_custom_oem(
      object_name, "", 0, CustomFrame::ECEF, timingStandard::UTC, states);
  if (oem.empty()) return {};
  return {{std::move(oem)}};
}

std::vector<od::BatchObject> parse_cpf(std::string_view content) {
  std::string object_name = "CPF OBJECT";
  std::string object_id;
  uint32_t norad = 0;
  long frame_code = 0;
  std::vector<NativeState> states;
  for_each_line(content, [&](std::string_view line) {
    const TokenViews<24> tokens = split_ws<24>(line);
    if (tokens.empty()) return;
    if (tokens[0] == "H1" && tokens.size() >= 11) {
      object_name.assign(tokens[10]);
      return;
    }
    if (tokens[0] == "H2") {
      if (tokens.size() >= 4) {
        object_id.assign(tokens[1]);
        norad = static_cast<uint32_t>(
            parse_unsigned_long(tokens[3]));
      }
      if (tokens.size() >= 20) {
        frame_code = parse_long(tokens[19]);
      }
      return;
    }
    if (tokens[0] != "10" || tokens.size() < 8) return;
    const long mjd = parse_long(tokens[2]);
    const double seconds = parse_double(tokens[3]);
    NativeState state;
    state.epoch = julian_iso(static_cast<double>(mjd) + 2'400'000.5 +
                             seconds / 86'400.0);
    state.x = parse_double(tokens[5]) / 1000.0;
    state.y = parse_double(tokens[6]) / 1000.0;
    state.z = parse_double(tokens[7]) / 1000.0;
    append_native_state_bounded(&states, std::move(state));
  });
  std::vector<uint8_t> oem;
  if (frame_code == 2) {
    oem = build_celestial_oem(object_name, object_id, norad,
                              CelestialFrame::EME2000, timingStandard::UTC,
                              states);
  } else if (frame_code == 0) {
    oem = build_custom_oem(object_name, object_id, norad, CustomFrame::ECEF,
                           timingStandard::UTC, states);
  }
  if (oem.empty()) return {};
  return {{std::move(oem)}};
}

bool kvn_value(std::string_view line, const char* key, std::string* value) {
  const std::string_view normalized = trim_view(line);
  const size_t key_length = std::strlen(key);
  if (normalized.compare(0, key_length, key) != 0) return false;
  size_t cursor = key_length;
  while (cursor < normalized.size() &&
         std::isspace(static_cast<unsigned char>(normalized[cursor]))) {
    ++cursor;
  }
  if (cursor >= normalized.size() || normalized[cursor] != '=') return false;
  value->assign(trim_view(normalized.substr(cursor + 1)));
  return true;
}

std::vector<od::BatchObject> parse_iss_oem(std::string_view content) {
  std::string object_name = "ISS";
  std::string object_id = "1998-067A";
  std::vector<NativeState> states;
  for_each_line(content, [&](std::string_view line) {
    std::string value;
    if (kvn_value(line, "OBJECT_NAME", &value)) {
      object_name = value;
      return;
    }
    if (kvn_value(line, "OBJECT_ID", &value)) {
      object_id = value;
      return;
    }
    const TokenViews<8> tokens = split_ws<8>(line);
    if (tokens.size() < 7 || tokens[0].size() < 11 ||
        tokens[0].find('T') == std::string::npos ||
        tokens[0].find('=') != std::string::npos) {
      return;
    }
    NativeState state;
    state.epoch = normalize_iss_epoch(tokens[0]);
    state.x = parse_double(tokens[1]);
    state.y = parse_double(tokens[2]);
    state.z = parse_double(tokens[3]);
    state.vx = parse_double(tokens[4]);
    state.vy = parse_double(tokens[5]);
    state.vz = parse_double(tokens[6]);
    append_native_state_bounded(&states, std::move(state));
  });
  std::vector<uint8_t> oem = build_celestial_oem(
      object_name, object_id, 25544, CelestialFrame::EME2000,
      timingStandard::UTC, states);
  if (oem.empty()) return {};
  return {{std::move(oem)}};
}

std::vector<od::BatchObject> parse_native_response(
    Provider provider, const Assembly& assembly) {
  const std::string_view content(
      reinterpret_cast<const char*>(assembly.bytes.data()),
      assembly.bytes.size());
  switch (provider) {
    case Provider::Starlink:
      return parse_starlink_meme(content, assembly.schema_name);
    case Provider::Glonass:
      return parse_glonass_sp3(content);
    case Provider::Intelsat:
      return parse_intelsat_ecf(content);
    case Provider::Cpf:
      return parse_cpf(content);
    case Provider::Iss:
      return parse_iss_oem(content);
  }
  return {};
}

std::string describe_batch_object(const od::BatchObject& object) {
  if (object.oem.size() < 8 || !OEMBufferHasIdentifier(object.oem.data())) {
    return {};
  }
  flatbuffers::Verifier verifier(object.oem.data(), object.oem.size());
  if (!VerifyOEMBuffer(verifier)) return {};
  const OEM* oem = GetOEM(object.oem.data());
  const auto* blocks = oem ? oem->EPHEMERIS_DATA_BLOCK() : nullptr;
  if (!blocks) return {};
  for (flatbuffers::uoffset_t index = 0; index < blocks->size(); ++index) {
    const ephemerisDataBlock* block = blocks->Get(index);
    const CAT* identity = block ? block->OBJECT() : nullptr;
    if (!identity) continue;
    const std::string name = identity->OBJECT_NAME()
                                 ? identity->OBJECT_NAME()->str()
                                 : std::string{};
    const std::string object_id = identity->OBJECT_ID()
                                      ? identity->OBJECT_ID()->str()
                                      : std::string{};
    const uint32_t norad = identity->NORAD_CAT_ID();
    const std::string label = !name.empty() ? name : object_id;
    if (!label.empty() && norad > 0) {
      return label + " (NORAD " + std::to_string(norad) + ")";
    }
    if (!label.empty()) return label;
    if (norad > 0) return "NORAD " + std::to_string(norad);
  }
  return {};
}

uint64_t derive_provider_transaction_id(
    uint64_t parent_transaction_id,
    Provider provider,
    size_t child_index,
    std::string_view identity,
    const od::BatchObject& object,
    std::set<uint64_t>* used_ids) {
  std::array<uint8_t, 32> oem_digest{};
  if (!object.oem.empty()) {
    sdn_cid::sha256_raw(object.oem.data(), object.oem.size(),
                        oem_digest.data());
  }
  std::vector<uint8_t> base_preimage;
  append_domain(&base_preimage, kDerivedTransactionIdDomain);
  append_u64_be(&base_preimage, parent_transaction_id);
  append_u32_be(&base_preimage, static_cast<uint32_t>(provider));
  append_u64_be(&base_preimage, static_cast<uint64_t>(child_index));
  append_text(&base_preimage, identity);
  base_preimage.insert(base_preimage.end(), oem_digest.begin(),
                       oem_digest.end());

  uint32_t collision_salt = 0;
  for (;;) {
    std::vector<uint8_t> preimage = base_preimage;
    if (collision_salt != 0) append_u32_be(&preimage, collision_salt);
    std::array<uint8_t, 32> digest{};
    sdn_cid::sha256_raw(preimage.data(), preimage.size(), digest.data());
    const uint64_t candidate = project_nonzero_request_id(digest.data());
    if (candidate != parent_transaction_id &&
        (!used_ids || used_ids->insert(candidate).second)) {
      return candidate;
    }
    ++collision_salt;
  }
}

bool decode_chunk(const plugin_input_frame_t* frame, Chunk* chunk,
                  std::string* error) {
  if (!frame || !chunk || !frame->payload || frame->payload_length == 0 ||
      !frame->file_identifier ||
      std::strcmp(frame->file_identifier, kFsbFileIdentifier) != 0) {
    *error = "OD requires a typed $FSB input frame";
    return false;
  }
  chunk->wire_format = frame->wire_format;
  if (frame->wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER) {
    flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!VerifyFSBBuffer(verifier)) {
      *error = "invalid canonical FSB chunk";
      return false;
    }
    const FSB* stream = GetFSB(frame->payload);
    if ((stream->SCHEMA_NAME() &&
         stream->SCHEMA_NAME()->size() > kFsbSchemaNameCapacity) ||
        (stream->FILE_IDENTIFIER() &&
         stream->FILE_IDENTIFIER()->size() > kFsbFileIdentifierCapacity) ||
        (stream->DATA() && stream->DATA()->size() > kFsbDataCapacity) ||
        (stream->SHA256() &&
         stream->SHA256()->size() > kFsbSha256Capacity)) {
      *error = "canonical FSB field length exceeds fixed capacity";
      return false;
    }
    chunk->request_id = stream->REQUEST_ID();
    chunk->sequence = stream->CHUNK_SEQUENCE();
    chunk->final = stream->FINAL();
    chunk->total_bytes = stream->TOTAL_BYTES();
    chunk->record_count = stream->RECORD_COUNT();
    if (stream->SCHEMA_NAME()) chunk->schema_name = stream->SCHEMA_NAME()->str();
    if (stream->FILE_IDENTIFIER()) {
      chunk->file_identifier = stream->FILE_IDENTIFIER()->str();
    }
    if (stream->DATA()) {
      chunk->data.assign(stream->DATA()->begin(), stream->DATA()->end());
    }
    if (stream->SHA256()) {
      chunk->sha256.assign(stream->SHA256()->begin(), stream->SHA256()->end());
    }
    return true;
  }
  if (frame->wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY) {
    if (frame->payload_length != kFsbAlignedSize ||
        reinterpret_cast<uintptr_t>(frame->payload) % kFsbAlignment != 0) {
      *error = "invalid aligned FSB bounds or alignment";
      return false;
    }
    const auto* stream = reinterpret_cast<const Aligned::FSB*>(frame->payload);
    if ((stream->has_SCHEMA_NAME() &&
         stream->SCHEMA_NAME.length > kFsbSchemaNameCapacity) ||
        (stream->has_FILE_IDENTIFIER() &&
         stream->FILE_IDENTIFIER.length > kFsbFileIdentifierCapacity) ||
        (stream->has_DATA() && stream->DATA.length > kFsbDataCapacity) ||
        (stream->has_SHA256() &&
         stream->SHA256.length > kFsbSha256Capacity)) {
      *error = "aligned FSB field length exceeds fixed capacity";
      return false;
    }
    chunk->request_id = stream->REQUEST_ID;
    chunk->sequence = stream->CHUNK_SEQUENCE;
    chunk->final = stream->FINAL;
    chunk->total_bytes = stream->TOTAL_BYTES;
    chunk->record_count = stream->RECORD_COUNT;
    if (stream->has_SCHEMA_NAME()) chunk->schema_name = stream->SCHEMA_NAME.str();
    if (stream->has_FILE_IDENTIFIER()) {
      chunk->file_identifier = stream->FILE_IDENTIFIER.str();
    }
    if (stream->has_DATA()) {
      chunk->data.assign(stream->DATA.values,
                         stream->DATA.values + stream->DATA.size());
    }
    if (stream->has_SHA256()) {
      chunk->sha256.assign(stream->SHA256.values,
                           stream->SHA256.values + stream->SHA256.size());
    }
    return true;
  }
  *error = "unsupported FSB wire format";
  return false;
}

bool verify_checksum(const Assembly& assembly) {
  if (assembly.sha256.empty()) return true;
  if (assembly.sha256.size() != 32) return false;
  uint8_t digest[32];
  sdn_cid::sha256_raw(assembly.bytes.data(), assembly.bytes.size(), digest);
  return std::memcmp(digest, assembly.sha256.data(), sizeof(digest)) == 0;
}

bool append_chunk(Provider provider, const Chunk& chunk, Assembly* completed,
                  std::string* error) {
  const size_t provider_response_bound =
      provider == Provider::Starlink ? kMaxStarlinkNativeResponseBytes
                                     : kMaxNativeResponseBytes;
  if (chunk.total_bytes == 0 ||
      chunk.total_bytes > provider_response_bound) {
    *error = "native response TOTAL_BYTES is outside the OD bound";
    return false;
  }
  const AssemblyKey key{provider, chunk.request_id};
  auto found = g_assemblies.find(key);
  if (chunk.sequence == 0) {
    if (found != g_assemblies.end()) g_assemblies.erase(found);
    if (g_assemblies.size() >= kMaxIncompleteAssemblies) {
      *error = "capacity: incomplete assembly count exceeds OD bound";
      return false;
    }
    const size_t declared_bytes = incomplete_assembly_declared_bytes();
    if (declared_bytes > kMaxIncompleteAssemblyDeclaredBytes ||
        static_cast<size_t>(chunk.total_bytes) >
            kMaxIncompleteAssemblyDeclaredBytes - declared_bytes) {
      *error = "capacity: declared incomplete assembly bytes exceed OD bound";
      return false;
    }
    Assembly fresh;
    fresh.total_bytes = chunk.total_bytes;
    fresh.record_count = chunk.record_count;
    fresh.wire_format = chunk.wire_format;
    fresh.schema_name = chunk.schema_name;
    fresh.file_identifier = chunk.file_identifier;
    fresh.sha256 = chunk.sha256;
    found = g_assemblies.emplace(key, std::move(fresh)).first;
  }
  if (found == g_assemblies.end()) {
    *error = "native response chunk arrived without sequence zero";
    return false;
  }
  Assembly& assembly = found->second;
  if (chunk.sequence != assembly.next_sequence ||
      chunk.total_bytes != assembly.total_bytes ||
      chunk.wire_format != assembly.wire_format ||
      chunk.schema_name != assembly.schema_name ||
      chunk.file_identifier != assembly.file_identifier ||
      (!assembly.sha256.empty() && chunk.sha256 != assembly.sha256)) {
    g_assemblies.erase(found);
    *error = "native response chunk metadata or ordering mismatch";
    return false;
  }
  if (assembly.bytes.size() + chunk.data.size() > assembly.total_bytes) {
    g_assemblies.erase(found);
    *error = "native response chunks exceed TOTAL_BYTES";
    return false;
  }
  const size_t new_size = assembly.bytes.size() + chunk.data.size();
  const size_t actual_bytes = incomplete_assembly_bytes();
  if (actual_bytes < assembly.bytes.size() ||
      actual_bytes - assembly.bytes.size() >
          kMaxIncompleteAssemblyBytes ||
      new_size > kMaxIncompleteAssemblyBytes -
                     (actual_bytes - assembly.bytes.size())) {
    g_assemblies.erase(found);
    *error = "capacity: actual incomplete assembly bytes exceed OD bound";
    return false;
  }
  const size_t queued_bytes = queued_storage_bytes();
  if (queued_bytes < assembly.bytes.capacity() ||
      queued_bytes - assembly.bytes.capacity() > kMaxQueuedStorageBytes ||
      new_size >
          kMaxQueuedStorageBytes -
              (queued_bytes - assembly.bytes.capacity())) {
    g_assemblies.erase(found);
    *error = "capacity: queued OD storage exceeds transient bound";
    return false;
  }
  if (assembly.bytes.capacity() < new_size) {
    size_t append_workspace_bytes = chunk.data.capacity();
    if (!add_within(&append_workspace_bytes, new_size,
                    kGuestTransientBudgetBytes) ||
        !transient_budget_allows(append_workspace_bytes)) {
      g_assemblies.erase(found);
      *error =
          "capacity: native chunk reallocation exceeds guest transient bound";
      return false;
    }
    std::vector<uint8_t> replacement(new_size);
    if (replacement.capacity() != new_size) {
      g_assemblies.erase(found);
      *error =
          "capacity: pinned vector allocation did not preserve exact capacity";
      return false;
    }
    std::copy(assembly.bytes.begin(), assembly.bytes.end(),
              replacement.begin());
    std::copy(chunk.data.begin(), chunk.data.end(),
              replacement.begin() +
                  static_cast<std::ptrdiff_t>(assembly.bytes.size()));
    assembly.bytes.swap(replacement);
  } else if (!transient_budget_allows(chunk.data.capacity())) {
    g_assemblies.erase(found);
    *error = "capacity: native chunk copy exceeds guest transient bound";
    return false;
  }
  if (assembly.bytes.size() < new_size) {
    assembly.bytes.insert(assembly.bytes.end(), chunk.data.begin(),
                          chunk.data.end());
  }
  if (!active_head_work_reserve_allows(0)) {
    g_assemblies.erase(found);
    *error =
        "capacity: native assembly would consume the pending-head fit reserve";
    return false;
  }
  ++assembly.next_sequence;
  if (!chunk.final) return true;
  if (assembly.bytes.size() != assembly.total_bytes || !verify_checksum(assembly)) {
    g_assemblies.erase(found);
    *error = "final native response length or SHA256 mismatch";
    return false;
  }
  *completed = std::move(assembly);
  g_assemblies.erase(found);
  return true;
}

int32_t push_canonical_stream_chunk(
    const RecordStreamAccumulator& records, uint64_t request_id,
    uint32_t sequence, bool final, const uint8_t digest[32],
    const uint8_t* chunk_data, size_t chunk_size) {
  flatbuffers::FlatBufferBuilder builder(chunk_size + 256);
  const auto schema = builder.CreateString(records.schema_name);
  const auto identifier = builder.CreateString(records.file_identifier);
  const auto data = builder.CreateVector(chunk_data, chunk_size);
  const auto checksum = builder.CreateVector(digest, 32);
  FSBBuilder stream_builder(builder);
  stream_builder.add_REQUEST_ID(request_id);
  stream_builder.add_KIND(flatSqlByteStreamKind_RECORD_STREAM);
  stream_builder.add_CHUNK_SEQUENCE(sequence);
  stream_builder.add_FINAL(final);
  stream_builder.add_TOTAL_BYTES(records.data.size());
  stream_builder.add_RECORD_COUNT(records.record_count);
  stream_builder.add_SCHEMA_NAME(schema);
  stream_builder.add_FILE_IDENTIFIER(identifier);
  stream_builder.add_DATA(data);
  stream_builder.add_SHA256(checksum);
  const auto root = stream_builder.Finish();
  FinishFSBBuffer(builder, root);
  return plugin_push_output_typed(
      records.port_id, kFsbSchemaName, kFsbFileIdentifier,
      PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, kFsbRootType, 0, 0, 0,
      builder.GetBufferPointer(), static_cast<uint32_t>(builder.GetSize()));
}

int32_t push_aligned_stream_chunk(
    const RecordStreamAccumulator& stream, uint64_t request_id,
    uint32_t sequence, bool final, const uint8_t digest[32],
    const uint8_t* chunk_data, size_t chunk_size) {
  if (chunk_size > kFsbDataCapacity) return -1;
  std::memset(&g_aligned_output, 0, sizeof(g_aligned_output));
  g_aligned_output.REQUEST_ID = request_id;
  g_aligned_output.KIND = flatSqlByteStreamKind_RECORD_STREAM;
  g_aligned_output.CHUNK_SEQUENCE = sequence;
  g_aligned_output.FINAL = final;
  g_aligned_output.TOTAL_BYTES = stream.data.size();
  g_aligned_output.RECORD_COUNT = stream.record_count;
  g_aligned_output.SCHEMA_NAME.set(stream.schema_name);
  g_aligned_output.set_has_SCHEMA_NAME(true);
  g_aligned_output.FILE_IDENTIFIER.set(stream.file_identifier);
  g_aligned_output.set_has_FILE_IDENTIFIER(true);
  g_aligned_output.DATA.set_length(static_cast<uint32_t>(chunk_size));
  std::memcpy(g_aligned_output.DATA.values, chunk_data, chunk_size);
  g_aligned_output.set_has_DATA(true);
  g_aligned_output.SHA256.set_length(32);
  std::memcpy(g_aligned_output.SHA256.values, digest, 32);
  g_aligned_output.set_has_SHA256(true);
  return plugin_push_output_typed(
      stream.port_id, kFsbSchemaName, kFsbFileIdentifier,
      PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, kFsbRootType, 0,
      kFsbAlignedSize, kFsbAlignment,
      reinterpret_cast<const uint8_t*>(&g_aligned_output), kFsbAlignedSize);
}

int32_t push_record_stream(const RecordStreamAccumulator& stream,
                           uint64_t request_id,
                           const std::array<uint8_t, 32>& digest) {
  if (stream.data.empty() || stream.record_count == 0) return 0;
  size_t offset = 0;
  uint32_t sequence = 0;
  while (offset < stream.data.size()) {
    const size_t chunk_size =
        std::min(kFsbDataCapacity, stream.data.size() - offset);
    const bool final = offset + chunk_size == stream.data.size();
    const int32_t status =
        stream.wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY
            ? push_aligned_stream_chunk(stream, request_id, sequence, final,
                                        digest.data(),
                                        stream.data.data() + offset,
                                        chunk_size)
            : push_canonical_stream_chunk(stream, request_id, sequence, final,
                                          digest.data(),
                                          stream.data.data() + offset,
                                          chunk_size);
    if (status < 0) return status;
    offset += chunk_size;
    ++sequence;
  }
  return 0;
}

bool append_record(std::vector<RecordStreamAccumulator>* streams,
                   const char* port_id, const char* schema_name,
                   const char* file_identifier,
                   const std::vector<uint8_t>& record,
                   uint32_t wire_format) {
  if (!streams) return false;
  if (record.empty()) return true;
  auto found = std::find_if(
      streams->begin(), streams->end(),
      [port_id, wire_format](const RecordStreamAccumulator& stream) {
        return stream.wire_format == wire_format &&
               std::strcmp(stream.port_id, port_id) == 0;
      });
  if (found == streams->end()) {
    streams->push_back({port_id, schema_name, file_identifier, wire_format});
    found = std::prev(streams->end());
  }
  if (record.size() > kMaxOutputStreamBytes - found->data.size()) return false;
  found->data.insert(found->data.end(), record.begin(), record.end());
  ++found->record_count;
  return true;
}

int32_t push_canonical_configuration(uint64_t request_id) {
  flatbuffers::FlatBufferBuilder builder(std::strlen(kResultSchemaIdl) + 1024);
  const auto database_name = builder.CreateString("supplemental-omm");
  const auto schema_idl = builder.CreateVector(
      reinterpret_cast<const uint8_t*>(kResultSchemaIdl),
      std::strlen(kResultSchemaIdl));
  std::vector<flatbuffers::Offset<FTB>> bindings;
  bindings.push_back(CreateFTBDirect(builder, "$OMM", "OMM"));
  bindings.push_back(CreateFTBDirect(builder, "$OCM", "OCM"));
  const auto table_bindings = builder.CreateVector(bindings);
  FSOBuilder control(builder);
  control.add_OPERATION(flatSqlNodeOperation_CONFIGURE_INDEX);
  control.add_REQUEST_ID(request_id);
  control.add_DATABASE_NAME(database_name);
  control.add_SCHEMA_IDL(schema_idl);
  control.add_TABLE_BINDINGS(table_bindings);
  const auto root = control.Finish();
  FinishFSOBuffer(builder, root);
  return plugin_push_output_typed(
      "control", kFsoSchemaName, kFsoFileIdentifier,
      PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, kFsoRootType, 0, 0, 0,
      builder.GetBufferPointer(), static_cast<uint32_t>(builder.GetSize()));
}

void write_aligned_u32(uint32_t offset, uint32_t value) {
  std::memcpy(g_aligned_control + offset, &value, sizeof(value));
}

void write_aligned_u64(uint32_t offset, uint64_t value) {
  std::memcpy(g_aligned_control + offset, &value, sizeof(value));
}

bool write_aligned_string(uint32_t offset, size_t capacity,
                          const char* value) {
  const size_t length = std::strlen(value);
  if (length > capacity || length > 255) return false;
  g_aligned_control[offset] = static_cast<uint8_t>(length);
  std::memcpy(g_aligned_control + offset + 1, value, length);
  return true;
}

bool write_aligned_binding(uint32_t index, const char* file_identifier,
                           const char* table_name) {
  const uint32_t base = kAlignedFsoBindingsOffset + 4 +
                        index * kAlignedFsoBindingStride;
  g_aligned_control[base] = 3;
  return write_aligned_string(base + 1, 4, file_identifier) &&
         write_aligned_string(base + 6, 128, table_name);
}

int32_t push_canonical_status(uint64_t request_id,
                              flatSqlNodeStatus status,
                              uint64_t affected_records,
                              uint64_t result_bytes,
                              const std::string& error_code,
                              const std::string& message) {
  flatbuffers::FlatBufferBuilder builder(message.size() + 512);
  const auto encoded_error = error_code.empty()
                                 ? flatbuffers::Offset<flatbuffers::String>{}
                                 : builder.CreateString(error_code);
  const auto encoded_message = message.empty()
                                   ? flatbuffers::Offset<
                                         flatbuffers::Vector<uint8_t>>{}
                                   : builder.CreateVector(
                                         reinterpret_cast<const uint8_t*>(
                                             message.data()),
                                         message.size());
  FSOBuilder status_builder(builder);
  status_builder.add_REQUEST_ID(request_id);
  status_builder.add_STATUS(status);
  status_builder.add_AFFECTED_RECORDS(affected_records);
  status_builder.add_RESULT_BYTES(result_bytes);
  if (!error_code.empty()) status_builder.add_ERROR_CODE(encoded_error);
  if (!message.empty()) status_builder.add_MESSAGE(encoded_message);
  const auto root = status_builder.Finish();
  FinishFSOBuffer(builder, root);
  return plugin_push_output_typed(
      "status", kFsoSchemaName, kFsoFileIdentifier,
      PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, kFsoRootType, 0, 0, 0,
      builder.GetBufferPointer(), static_cast<uint32_t>(builder.GetSize()));
}

int32_t push_aligned_status(uint64_t request_id, flatSqlNodeStatus status,
                            uint64_t affected_records, uint64_t result_bytes,
                            const std::string& error_code,
                            const std::string& message) {
  std::memset(g_aligned_control, 0, sizeof(g_aligned_control));
  write_aligned_u64(8, request_id);
  g_aligned_control[kAlignedFsoStatusOffset] =
      static_cast<uint8_t>(status);
  write_aligned_u64(kAlignedFsoAffectedRecordsOffset, affected_records);
  write_aligned_u64(kAlignedFsoResultBytesOffset, result_bytes);
  if (!error_code.empty()) {
    g_aligned_control[1] |= 4;
    if (!write_aligned_string(kAlignedFsoErrorCodeOffset,
                              kFsoErrorCodeCapacity,
                              error_code.c_str())) {
      return -1;
    }
  }
  if (!message.empty()) {
    g_aligned_control[1] |= 8;
    write_aligned_u32(kAlignedFsoMessageOffset,
                      static_cast<uint32_t>(message.size()));
    std::memcpy(g_aligned_control + kAlignedFsoMessageOffset + 4,
                message.data(), message.size());
  }
  return plugin_push_output_typed(
      "status", kFsoSchemaName, kFsoFileIdentifier,
      PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, kFsoRootType, 0,
      kFsoAlignedSize, kFsoAlignment, g_aligned_control, kFsoAlignedSize);
}

int32_t push_status(uint32_t wire_format, uint64_t request_id,
                    flatSqlNodeStatus status, uint64_t affected_records,
                    uint64_t result_bytes, std::string error_code,
                    std::string message) {
  if (error_code.size() > kFsoErrorCodeCapacity) {
    error_code.resize(kFsoErrorCodeCapacity);
  }
  if (message.size() > kFsoMessageCapacity) {
    message.resize(kFsoMessageCapacity);
  }
  if (wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY) {
    return push_aligned_status(request_id, status, affected_records,
                               result_bytes, error_code, message);
  }
  return push_canonical_status(request_id, status, affected_records,
                               result_bytes, error_code, message);
}

int32_t push_aligned_configuration(uint64_t request_id) {
  const size_t schema_length = std::strlen(kResultSchemaIdl);
  if (schema_length > 262'144) return -1;
  std::memset(g_aligned_control, 0, sizeof(g_aligned_control));
  g_aligned_control[0] = 7;  // DATABASE_NAME, SCHEMA_IDL, TABLE_BINDINGS.
  g_aligned_control[2] =
      static_cast<uint8_t>(flatSqlNodeOperation_CONFIGURE_INDEX);
  write_aligned_u64(8, request_id);
  if (!write_aligned_string(kAlignedFsoDatabaseOffset, 128,
                            "supplemental-omm")) {
    return -1;
  }
  write_aligned_u32(kAlignedFsoSchemaOffset,
                    static_cast<uint32_t>(schema_length));
  std::memcpy(g_aligned_control + kAlignedFsoSchemaOffset + 4,
              kResultSchemaIdl, schema_length);
  write_aligned_u32(kAlignedFsoBindingsOffset, 2);
  if (!write_aligned_binding(0, "$OMM", "OMM") ||
      !write_aligned_binding(1, "$OCM", "OCM")) {
    return -1;
  }
  return plugin_push_output_typed(
      "control", kFsoSchemaName, kFsoFileIdentifier,
      PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, kFsoRootType, 0,
      kFsoAlignedSize, kFsoAlignment, g_aligned_control, kFsoAlignedSize);
}

int32_t push_configuration(uint32_t wire_format, uint64_t request_id) {
  if (wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY) {
    return push_aligned_configuration(request_id);
  }
  return push_canonical_configuration(request_id);
}

bool append_result(std::vector<RecordStreamAccumulator>* streams,
                   const od::BatchResult& result, uint32_t wire_format) {
  bool accepted =
      append_record(streams, "omm", "OMM", "$OMM", result.omm,
                    wire_format) &&
      append_record(streams, "ocm", "OCM", "$OCM", result.ocm,
                    wire_format);
  for (const od::BatchEpochResult& additional : result.additional_epochs) {
    accepted =
        accepted &&
        append_record(streams, "omm", "OMM", "$OMM", additional.omm,
                      wire_format) &&
        append_record(streams, "ocm", "OCM", "$OCM", additional.ocm,
                      wire_format);
  }
  return accepted;
}

bool fitted_epoch_passes_quality_gate(
    const std::vector<uint8_t>& omm, const std::vector<uint8_t>& ocm,
    double rms_km, bool converged, size_t epoch_index,
    std::string* error) {
  if (omm.empty() || ocm.empty()) {
    *error = "epoch " + std::to_string(epoch_index) +
             " has an incomplete OMM/OCM pair";
    return false;
  }
  if (!std::isfinite(rms_km) || rms_km >= kMaxFitRmsKm) {
    *error = "epoch " + std::to_string(epoch_index) +
             " RMS=" + std::to_string(rms_km) +
             " km is not finite and below 12 km";
    return false;
  }
  if (!converged) {
    *error = "epoch " + std::to_string(epoch_index) +
             " converged=false";
    return false;
  }
  return true;
}

bool fitted_result_passes_quality_gate(const od::BatchResult& result,
                                       std::string* error) {
  if (result.terminal_reentry_ocm_only) {
    if (!error || !result.omm.empty() || result.ocm.empty() ||
        !result.additional_epochs.empty()) {
      if (error) {
        *error =
            "terminal reentry must contain exactly one OCM and no OMM";
      }
      return false;
    }
    return true;
  }
  if (!error ||
      !fitted_epoch_passes_quality_gate(
          result.omm, result.ocm, result.rms_km, result.converged, 0, error)) {
    return false;
  }
  for (size_t index = 0; index < result.additional_epochs.size(); ++index) {
    const od::BatchEpochResult& epoch = result.additional_epochs[index];
    if (!fitted_epoch_passes_quality_gate(
            epoch.omm, epoch.ocm, epoch.rms_km, epoch.converged,
            index + 1, error)) {
      return false;
    }
  }
  return true;
}

bool provider_for_port(const char* port_id, Provider* provider) {
  if (!port_id || !provider) return false;
  for (const ProviderPort& candidate : kProviderPorts) {
    if (std::strcmp(port_id, candidate.port_id) == 0) {
      *provider = candidate.provider;
      return true;
    }
  }
  return false;
}

void publish_pending_fit_state() {
  const size_t total_backlog =
      g_pending_fit_objects.size() + g_fitted_fit_objects.size();
  const uint32_t backlog = static_cast<uint32_t>(
      std::min<size_t>(total_backlog, UINT32_MAX));
  plugin_set_backlog_remaining(backlog);
  plugin_set_yielded(backlog > 0 ? 1 : 0);
}

}  // namespace

extern "C" int fit(void) {
  plugin_reset_output_state();
  g_current_input_envelope_bytes = current_input_envelope_bytes();
  std::string error;
  if (g_current_input_envelope_bytes > kGuestTransientBudgetBytes ||
      !transient_budget_allows(0)) {
    plugin_set_error("od-capacity",
                     "PIV input and queued storage exceed guest transient bound");
    publish_pending_fit_state();
    return 413;
  }
  if (!active_head_work_reserve_allows(0)) {
    plugin_set_error(
        "od-capacity",
        "current PIV input would consume the pending-head fit reserve");
    publish_pending_fit_state();
    return 413;
  }

  for (uint32_t index = 0; index < plugin_get_input_count(); ++index) {
    const plugin_input_frame_t* frame = plugin_get_input_frame(index);
    Provider provider;
    if (!frame || !provider_for_port(frame->port_id, &provider)) continue;
    Chunk chunk;
    if (!decode_chunk(frame, &chunk, &error)) {
      plugin_set_error("od-chunk-invalid", error.c_str());
      publish_pending_fit_state();
      return 400;
    }
    Assembly completed;
    if (!append_chunk(provider, chunk, &completed, &error)) {
      const bool capacity_error = error.rfind("capacity:", 0) == 0;
      plugin_set_error(capacity_error ? "od-capacity" : "od-chunk-invalid",
                       error.c_str());
      publish_pending_fit_state();
      return capacity_error ? 413 : 400;
    }
    if (!chunk.final) continue;
    const size_t parse_workspace_bytes =
        native_parse_workspace_bytes(provider, completed,
                                     chunk.data.capacity());
    if (!transient_budget_allows(parse_workspace_bytes)) {
      plugin_set_error(
          "od-capacity",
          "native parse workspace exceeds guest transient bound");
      publish_pending_fit_state();
      return 413;
    }
    std::vector<od::BatchObject> parsed =
        parse_native_response(provider, completed);
    std::vector<uint8_t>().swap(completed.bytes);
    if (parsed.empty()) {
      const std::string parse_error =
          "complete provider response had fewer than three usable states";
      plugin_set_error("od-native-parse", parse_error.c_str());
      std::string message = parse_error;
      if (!completed.schema_name.empty()) {
        message += ": " + completed.schema_name;
      }
      if (push_status(completed.wire_format, chunk.request_id,
                      flatSqlNodeStatus_INVALID_ARGUMENT, 0, 0,
                      "od-native-parse", message) < 0) {
        plugin_set_error("od-output", "unable to emit OD parse status");
        publish_pending_fit_state();
        return 500;
      }
      continue;
    }
    const size_t available_pending_objects =
        kMaxPendingFitObjects -
        std::min(g_pending_fit_objects.size(), kMaxPendingFitObjects);
    if (parsed.size() > kMaxNativeObjectsPerResponse ||
        parsed.size() > available_pending_objects) {
      plugin_set_error(
          "od-capacity",
          "parsed native fanout exceeds the pending object bound");
      publish_pending_fit_state();
      return 413;
    }
    std::set<uint64_t> fanout_transaction_ids;
    std::vector<PendingFitObject> pending;
    pending.reserve(parsed.size());
    for (size_t child_index = 0; child_index < parsed.size(); ++child_index) {
      od::BatchObject& object = parsed[child_index];
      std::string identity = describe_batch_object(object);
      const bool preserve_source_transaction =
          provider == Provider::Starlink && parsed.size() == 1 &&
          chunk.request_id != 0;
      const uint64_t transaction_id =
          preserve_source_transaction
              ? chunk.request_id
              : derive_provider_transaction_id(
                    chunk.request_id, provider, child_index, identity, object,
                    &fanout_transaction_ids);
      object.fit_options.assign(kFitOptions.data(), kFitOptions.size());
      pending.push_back({std::move(object), completed.wire_format,
                         transaction_id, std::move(identity)});
    }
    size_t candidate_bytes = 0;
    for (const PendingFitObject& candidate : pending) {
      if (candidate.object.oem.size() > kMaxFitBatchBytes) {
        plugin_set_error("od-capacity",
                         "one parsed OEM exceeds the fit batch byte bound");
        publish_pending_fit_state();
        return 413;
      }
      if (!add_within(&candidate_bytes,
                      pending_object_storage_bytes(candidate),
                      kMaxPendingFitBytes)) {
        plugin_set_error("od-capacity",
                         "pending OD bytes exceed transient bound");
        publish_pending_fit_state();
        return 413;
      }
    }
    const size_t existing_pending_bytes = pending_fit_bytes();
    const size_t existing_queued_bytes = queued_storage_bytes();
    if (existing_pending_bytes > kMaxPendingFitBytes ||
        candidate_bytes >
            kMaxPendingFitBytes - existing_pending_bytes ||
        existing_queued_bytes > kMaxQueuedStorageBytes ||
        candidate_bytes > kMaxQueuedStorageBytes - existing_queued_bytes) {
      plugin_set_error("od-capacity",
                       "pending OD bytes exceed transient bound");
      publish_pending_fit_state();
      return 413;
    }
    if (!active_head_work_reserve_allows(
            candidate_bytes, pending.empty() ? nullptr : &pending.front())) {
      plugin_set_error(
          "od-capacity",
          "pending OD admission would consume the head-fit reserve");
      publish_pending_fit_state();
      return 413;
    }
    for (PendingFitObject& candidate : pending) {
      g_pending_fit_objects.push_back(std::move(candidate));
    }
  }

  if (g_fitted_fit_objects.empty() && !g_pending_fit_objects.empty()) {
    std::vector<PendingFitObject> admitted;
    std::vector<od::BatchObject> batch_objects;
    size_t batch_bytes = 0;
    size_t admitted_storage_bytes = 0;
    admitted.reserve(kMaxFitBatchObjects);
    batch_objects.reserve(kMaxFitBatchObjects);
    while (!g_pending_fit_objects.empty() &&
           batch_objects.size() < kMaxFitBatchObjects) {
      const size_t object_bytes =
          g_pending_fit_objects.front().object.oem.size();
      if (object_bytes > kMaxFitBatchBytes ||
          batch_bytes >= kMaxFitBatchBytes ||
          object_bytes > kMaxFitBatchBytes - batch_bytes) {
        if (batch_objects.empty()) {
          g_pending_fit_objects.pop_front();
          plugin_set_error(
              "od-capacity",
              "one pending OEM cannot fit the bounded OD batch");
          publish_pending_fit_state();
          return 413;
        }
        break;
      }
      const size_t candidate_storage_bytes =
          pending_object_storage_bytes(g_pending_fit_objects.front());
      size_t prospective_admitted_storage_bytes = admitted_storage_bytes;
      if (!add_within(&prospective_admitted_storage_bytes,
                      candidate_storage_bytes,
                      kGuestTransientBudgetBytes)) {
        if (batch_objects.empty()) {
          g_pending_fit_objects.pop_front();
          plugin_set_error(
              "od-capacity",
              "one pending OEM exceeds the guest transient bound");
          publish_pending_fit_state();
          return 413;
        }
        break;
      }
      const size_t prospective_batch_bytes = batch_bytes + object_bytes;
      const size_t prospective_fit_workspace = fit_workspace_bytes(
          prospective_admitted_storage_bytes, prospective_batch_bytes,
          batch_objects.size() + 1);
      if (!transient_budget_allows_after_releasing(
              prospective_fit_workspace, candidate_storage_bytes)) {
        if (batch_objects.empty()) {
          const size_t intrinsic_head_workspace = fit_workspace_bytes(
              candidate_storage_bytes, object_bytes, 1);
          if (intrinsic_head_workspace > kGuestTransientBudgetBytes) {
            g_pending_fit_objects.pop_front();
            plugin_set_error(
                "od-capacity",
                "one pending OEM intrinsically exceeds the fit bound");
          } else {
            plugin_set_error(
                "od-capacity",
                "contextual queue pressure blocked the preserved pending head");
          }
          publish_pending_fit_state();
          return 413;
        }
        break;
      }
      PendingFitObject pending =
          std::move(g_pending_fit_objects.front());
      g_pending_fit_objects.pop_front();
      admitted_storage_bytes = prospective_admitted_storage_bytes;
      batch_bytes = prospective_batch_bytes;
      batch_objects.push_back(std::move(pending.object));
      admitted.push_back(std::move(pending));
    }
    if (batch_objects.empty()) {
      plugin_set_error("od-capacity",
                       "OD fit admission produced an empty batch");
      publish_pending_fit_state();
      return 413;
    }

    od::BatchRunStats stats{};
    std::vector<od::BatchResult> results =
        od::run_batch_fit(batch_objects, kFitWorkerThreads, &stats);
    const size_t fitted_batch_size = batch_objects.size();
    std::vector<od::BatchObject>().swap(batch_objects);
    if (results.size() != admitted.size()) {
      plugin_set_error("od-batch-result-count",
                       "OD batch fitter returned the wrong result count");
      publish_pending_fit_state();
      return 500;
    }
    if (g_fitted_fit_objects.size() > kMaxFittedFitObjects ||
        results.size() >
            kMaxFittedFitObjects - g_fitted_fit_objects.size()) {
      plugin_set_error("od-capacity",
                       "fitted OD object count exceeds transient bound");
      publish_pending_fit_state();
      return 413;
    }
    size_t result_bytes = 0;
    for (const od::BatchResult& result : results) {
      if (!add_within(&result_bytes, batch_result_storage_bytes(result),
                      kMaxFittedFitBytes)) {
        plugin_set_error("od-capacity",
                         "fitted OD bytes exceed transient bound");
        publish_pending_fit_state();
        return 413;
      }
    }
    const size_t existing_fitted_bytes = fitted_fit_bytes();
    const size_t existing_queued_bytes = queued_storage_bytes();
    if (existing_fitted_bytes > kMaxFittedFitBytes ||
        result_bytes > kMaxFittedFitBytes - existing_fitted_bytes ||
        existing_queued_bytes > kMaxQueuedStorageBytes ||
        result_bytes > kMaxQueuedStorageBytes - existing_queued_bytes) {
      plugin_set_error("od-capacity",
                       "fitted OD bytes exceed transient bound");
      publish_pending_fit_state();
      return 413;
    }
    for (size_t index = 0; index < results.size(); ++index) {
      g_fitted_fit_objects.push_back(
          {std::move(results[index]), admitted[index].wire_format,
           admitted[index].transaction_id, std::move(admitted[index].identity),
           stats, fitted_batch_size});
    }
  }

  if (g_fitted_fit_objects.empty()) {
    publish_pending_fit_state();
    return 0;
  }

  const size_t fitted_storage_bytes =
      fitted_object_storage_bytes(g_fitted_fit_objects.front());
  const size_t output_workspace =
      output_workspace_bytes(fitted_storage_bytes);
  if (!transient_budget_allows_after_releasing(
          output_workspace, fitted_storage_bytes)) {
    plugin_set_error("od-capacity",
                     "OD output workspace exceeds guest transient bound");
    publish_pending_fit_state();
    return 413;
  }
  FittedFitObject fitted = std::move(g_fitted_fit_objects.front());
  g_fitted_fit_objects.pop_front();
  const od::BatchResult& result = fitted.result;
  std::vector<RecordStreamAccumulator> streams;
  if (!result.ok) {
    const std::string fit_error =
        result.error_message.empty() ? "OD produced no complete record set"
                                     : result.error_message;
    plugin_set_error("od-fit", fit_error.c_str());
    std::string message = "OD fit failed";
    if (!fitted.identity.empty()) message += ": " + fitted.identity;
    message += ": " + fit_error;
    if (push_status(
            fitted.wire_format, fitted.transaction_id,
            flatSqlNodeStatus_INTERNAL_ERROR, 0, 0,
            result.error_code.empty() ? "od-fit" : result.error_code,
            message) < 0) {
      plugin_set_error("od-output", "unable to emit OD fit failure status");
      publish_pending_fit_state();
      return 500;
    }
    publish_pending_fit_state();
    return 0;
  }
  std::string quality_error;
  if (!fitted_result_passes_quality_gate(result, &quality_error)) {
    plugin_set_error("od-quality-gate", quality_error.c_str());
    std::string message = "OD fit rejected";
    if (!fitted.identity.empty()) message += ": " + fitted.identity;
    message += ": " + quality_error;
    if (push_status(fitted.wire_format, fitted.transaction_id,
                    flatSqlNodeStatus_INTERNAL_ERROR, 0, 0,
                    "od-quality-gate", message) < 0) {
      plugin_set_error("od-output",
                       "unable to emit OD quality-gate failure status");
      publish_pending_fit_state();
      return 500;
    }
    publish_pending_fit_state();
    return 0;
  }
  if (!append_result(&streams, result, fitted.wire_format)) {
    plugin_set_error("od-output-too-large",
                     "one fitted schema stream exceeds 128 MiB");
    publish_pending_fit_state();
    return 413;
  }
  OutputRequestIdentity output_identity;
  if (!derive_output_request_identity(streams, fitted.transaction_id,
                                      &output_identity)) {
    plugin_set_error("od-output-identity",
                     "unable to derive complete fitted output identity");
    publish_pending_fit_state();
    return 500;
  }
  if (push_configuration(fitted.wire_format,
                         output_identity.configuration_request_id) < 0) {
    plugin_set_error("od-output", "unable to emit FlatSQL CONFIGURE_INDEX control");
    publish_pending_fit_state();
    return 500;
  }
  for (const OutputStreamRequestIdentity& stream_identity :
       output_identity.streams) {
    if (push_record_stream(*stream_identity.stream, stream_identity.request_id,
                           stream_identity.digest) < 0) {
      plugin_set_error("od-output", "unable to emit fitted FSB record stream");
      publish_pending_fit_state();
      return 500;
    }
  }
  uint64_t affected_records = 0;
  uint64_t result_bytes = 0;
  for (const RecordStreamAccumulator& stream : streams) {
    result_bytes += static_cast<uint64_t>(stream.data.size());
    if (std::strcmp(stream.port_id, "omm") == 0 ||
        (result.terminal_reentry_ocm_only &&
         std::strcmp(stream.port_id, "ocm") == 0)) {
      affected_records = stream.record_count;
    }
  }
  std::string message = result.terminal_reentry_ocm_only
                            ? "Terminal reentry OCM complete"
                            : "OD fit complete";
  if (!fitted.identity.empty()) message += ": " + fitted.identity;
  message += "; batch_objects=" + std::to_string(fitted.batch_object_count);
  message += "; workers=" + std::to_string(fitted.stats.worker_count);
  message += "; distinct_threads=" +
             std::to_string(fitted.stats.distinct_thread_ids);
  if (push_status(fitted.wire_format, fitted.transaction_id,
                  flatSqlNodeStatus_COMPLETE, affected_records,
                  result_bytes, "", message) < 0) {
    plugin_set_error("od-output", "unable to emit OD completion status");
    publish_pending_fit_state();
    return 500;
  }
  publish_pending_fit_state();
  return 0;
}
