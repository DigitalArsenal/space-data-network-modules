#include <array>
#include <atomic>
#include <limits>
#include <pthread.h>
#include <sched.h>
#include <time.h>
#include <unordered_set>
#include <utility>

namespace {

using namespace provider_node;

constexpr const char* kDefaultManifestUrl =
    "https://api.starlink.com/public-files/ephemerides/MANIFEST.txt";
constexpr const char* kDefaultEphemerisBase =
    "https://api.starlink.com/public-files/ephemerides/";
constexpr uint32_t kMaxFetchConcurrency = 64;
constexpr uint32_t kDefaultFetchConcurrency = 64;
constexpr uint32_t kDefaultBatchSize = 64;
constexpr uint64_t kThreadBarrierTimeoutNanoseconds =
    600ull * 1'000'000'000ull;
// Probe 64 files in parallel and admit as many complete GETs as fit the signed
// per-activation byte ceiling. This still saturates the link for small files,
// while bounding parsing and hashing below WasmEdge's scheduled fuel ceiling.
constexpr size_t kMaxDurableFilesPerInvocation = 16;
constexpr uint64_t kMaxDurableBytesPerInvocation = 32ull * 1024 * 1024;
constexpr uint32_t kMaxDownstreamObjectsPerInvocation = 1;
constexpr size_t kMaxStarlinkFileBytes = 64 * 1024 * 1024;
constexpr uint64_t kMaxFetchWaveBytesPerInvocation =
    64ull * 1024 * 1024;
constexpr uint64_t kMaxRetainedWaveBytes = 288ull * 1024 * 1024;
constexpr uint64_t kReservedTransientBytes = 384ull * 1024 * 1024;
constexpr uint64_t kWasmMemoryCeilingBytes = 1024ull * 1024 * 1024;
constexpr size_t kMaxManifestBytes = 8 * 1024 * 1024;
static_assert(kMaxStarlinkFileBytes <= kMaxRetainedWaveBytes);
static_assert(kMaxFetchWaveBytesPerInvocation <= kMaxRetainedWaveBytes);
static_assert(2 * kMaxRetainedWaveBytes + kReservedTransientBytes <
              kWasmMemoryCeilingBytes);

constexpr const char* kCheckpointNamespace = "primary";
constexpr const char* kCheckpointKey = "starlink.active.v1";
constexpr size_t kOpaqueChunkBytes = 1024 * 1024;
constexpr uint8_t kCompressedChunkMagic[8] = {
    'S', 'L', 'C', 'M', 'P', '0', '0', '1'};
constexpr size_t kCompressedChunkHeaderBytes = 16;
constexpr size_t kMaxCheckpointBytes = 1024 * 1024;
constexpr uint32_t kMaxStorageSegments = 1;
constexpr size_t kMaxHttpMetaBytes = 64 * 1024;
constexpr size_t kMaxStorageJsonOverheadBytes = 64 * 1024;
constexpr size_t kMaxBase64CheckpointBytes =
    ((kMaxCheckpointBytes + 2) / 3) * 4;
constexpr size_t kMaxStorageMetaBytes =
    kMaxBase64CheckpointBytes + kMaxStorageJsonOverheadBytes;
constexpr size_t kMaxStorageResponseBytes = kMaxStorageMetaBytes + 8;
constexpr size_t kMaxStorageErrorMessageBytes = 512;
static_assert(kMaxStorageResponseBytes <=
              static_cast<size_t>(std::numeric_limits<int32_t>::max()));
constexpr uint32_t kMaxManifestEntries = 100'000;
constexpr uint32_t kMaxCatalogUnits = 100'000;
// The live Starlink manifest produces thousands of selected identities. Keep
// manifest fetch/selection/checkpointing in its own scheduled activation so a
// complete parallel file wave starts with a fresh WasmEdge fuel allowance.
constexpr size_t kManifestPlanYieldThreshold = 4'096;
constexpr size_t kMaxEndpointBytes = 2048;
constexpr size_t kMaxFilenameBytes = 512;
constexpr size_t kMaxIdentityBytes = 64;
constexpr uint8_t kCheckpointMagic[8] = {'S', 'L', 'S', 'P', 'O', 'O', 'L', '1'};
constexpr uint16_t kCheckpointVersion = 4;

enum class Phase : uint8_t {
  kDownloading = 1,
  kDraining = 2,
};

struct Config {
  std::string manifest_url = kDefaultManifestUrl;
  std::string ephemeris_base = kDefaultEphemerisBase;
  uint32_t fetch_concurrency = kDefaultFetchConcurrency;
  uint32_t batch_size = kDefaultBatchSize;
  uint32_t object_cap = 0;
};

struct PlannedUnit {
  std::string filename;
  std::string url;
  std::string identity;
  uint64_t byte_length = 0;
  uint32_t chunk_count = 0;
  uint64_t epoch_count = 0;
  std::array<uint8_t, 32> digest{};
};

struct State {
  Config config;
  std::vector<PlannedUnit> units;
  std::array<uint8_t, 32> generation{};
  uint32_t downloaded_count = 0;
  uint32_t drain_index = 0;
  uint64_t downloaded_bytes = 0;
  Phase phase = Phase::kDownloading;
  bool cleanup_pending = false;
  bool active = false;
};

struct DownloadMetadata {
  uint64_t byte_length = 0;
  uint64_t epoch_count = 0;
  std::array<uint8_t, 32> digest{};
  bool valid = false;
};

struct ValidatedDownload {
  provider_node::HttpResult response;
  DownloadMetadata metadata;
};

State g_state;
std::vector<ValidatedDownload> g_pending_wave;
uint32_t g_pending_wave_begin = 0;
bool g_emitted_transient = false;
bool g_progress_emitted_transient = false;
uint64_t g_trusted_emission_epoch_count = 0;

Config parse_config(std::string_view json) {
  Config config;
  std::string value;
  int64_t number = 0;
  if (json_string(json, "manifestUrl", &value) && !value.empty()) {
    config.manifest_url = value;
  }
  if (json_string(json, "ephemerisBase", &value) && !value.empty()) {
    config.ephemeris_base = value;
  }
  if (json_int64(json, "fetchConcurrency", &number) && number > 0) {
    config.fetch_concurrency = static_cast<uint32_t>(
        std::min<int64_t>(number, kMaxFetchConcurrency));
  }
  if (json_int64(json, "batchSize", &number) && number > 0) {
    config.batch_size = static_cast<uint32_t>(
        std::min<int64_t>(number, kMaxFetchConcurrency));
  }
  if (json_int64(json, "objectCap", &number) && number > 0) {
    config.object_cap = static_cast<uint32_t>(
        std::min<int64_t>(number, kMaxCatalogUnits));
  }
  return config;
}

std::string trim(std::string_view input) {
  size_t begin = 0;
  while (begin < input.size() &&
         (input[begin] == ' ' || input[begin] == '\t' || input[begin] == '\r')) {
    ++begin;
  }
  size_t end = input.size();
  while (end > begin &&
         (input[end - 1] == ' ' || input[end - 1] == '\t' ||
          input[end - 1] == '\r')) {
    --end;
  }
  return std::string(input.substr(begin, end - begin));
}

std::string meme_identity(std::string_view filename) {
  const size_t first = filename.find('_');
  const size_t second = first == std::string_view::npos
                            ? first
                            : filename.find('_', first + 1);
  const size_t third = second == std::string_view::npos
                           ? second
                           : filename.find('_', second + 1);
  if (first == std::string_view::npos || second == std::string_view::npos ||
      third == std::string_view::npos || filename.substr(0, first) != "MEME") {
    return {};
  }
  std::string identity = "MEME:";
  identity.append(filename.substr(first + 1, second - first - 1));
  identity.push_back(':');
  identity.append(filename.substr(second + 1, third - second - 1));
  if (identity.size() > kMaxIdentityBytes) return {};
  return identity;
}

bool meme_generation(std::string_view filename, uint64_t* generation) {
  constexpr std::string_view suffix = "_UNCLASSIFIED.txt";
  if (!generation || filename.size() <= suffix.size() ||
      filename.substr(filename.size() - suffix.size()) != suffix) {
    return false;
  }
  const size_t end = filename.size() - suffix.size();
  const size_t separator = filename.rfind('_', end - 1);
  if (separator == std::string_view::npos || separator + 1 == end) {
    return false;
  }
  uint64_t value = 0;
  for (size_t index = separator + 1; index < end; ++index) {
    const char digit = filename[index];
    if (digit < '0' || digit > '9' ||
        value > (std::numeric_limits<uint64_t>::max() -
                 static_cast<uint64_t>(digit - '0')) /
                    10) {
      return false;
    }
    value = value * 10 + static_cast<uint64_t>(digit - '0');
  }
  *generation = value;
  return true;
}

struct ManifestCandidate {
  PlannedUnit unit;
  uint64_t generation = 0;
  size_t manifest_position = 0;
};

std::vector<PlannedUnit> plan_units(const std::vector<uint8_t>& manifest,
                                    const Config& config,
                                    bool* exceeded_limit) {
  if (exceeded_limit) *exceeded_limit = false;
  std::vector<ManifestCandidate> candidates;
  size_t manifest_position = 0;
  for (const std::string_view raw_line : lines(manifest)) {
    const size_t candidate_position = manifest_position++;
    const std::string filename = trim(raw_line);
    if (filename.rfind("MEME_", 0) != 0 ||
        filename.size() > kMaxFilenameBytes ||
        filename.find('/') != std::string::npos ||
        filename.find('\\') != std::string::npos) {
      continue;
    }
    const std::string identity = meme_identity(filename);
    uint64_t generation = 0;
    if (identity.empty() || !meme_generation(filename, &generation)) continue;
    if (candidates.size() >= kMaxManifestEntries) {
      if (exceeded_limit) *exceeded_limit = true;
      return {};
    }
    candidates.push_back({
        {filename, join_url(config.ephemeris_base, filename), identity},
        generation,
        candidate_position,
    });
  }
  std::sort(candidates.begin(), candidates.end(),
            [](const ManifestCandidate& left,
               const ManifestCandidate& right) {
              if (left.unit.identity != right.unit.identity) {
                return left.unit.identity < right.unit.identity;
              }
              if (left.generation != right.generation) {
                return left.generation > right.generation;
              }
              return left.unit.filename > right.unit.filename;
            });

  std::vector<ManifestCandidate> winners;
  winners.reserve(candidates.size());
  std::string selected_identity;
  for (ManifestCandidate& candidate : candidates) {
    if (!winners.empty() && selected_identity == candidate.unit.identity) {
      continue;
    }
    if (winners.size() >= kMaxCatalogUnits) {
      if (exceeded_limit) *exceeded_limit = true;
      return {};
    }
    selected_identity = candidate.unit.identity;
    winners.push_back(std::move(candidate));
  }
  std::sort(winners.begin(), winners.end(),
            [](const ManifestCandidate& left,
               const ManifestCandidate& right) {
              return left.manifest_position < right.manifest_position;
            });
  std::vector<PlannedUnit> units;
  units.reserve(winners.size());
  for (ManifestCandidate& winner : winners) {
    units.push_back(std::move(winner.unit));
  }
  if (config.object_cap > 0 && units.size() > config.object_cap) {
    units.resize(config.object_cap);
  }
  return units;
}

struct ProbeResult {
  uint64_t byte_length = 0;
  bool valid = false;
};

struct ProbeCarry {
  size_t begin = 0;
  std::vector<ProbeResult> probes;
};

ProbeCarry g_probe_carry;

struct DownloadPageContext {
  const std::vector<PlannedUnit>* units = nullptr;
  size_t begin = 0;
  size_t end = 0;
  std::atomic<size_t> probe_next{0};
  std::atomic<size_t> fetch_next{0};
  std::vector<ProbeResult>* probes = nullptr;
  std::vector<ValidatedDownload>* responses = nullptr;
  std::atomic<size_t> probes_completed{0};
  size_t admitted_count = 0;
  std::atomic<bool> admission_ready{false};
  bool probe_invalid = false;
  std::atomic<bool> synchronization_failed{false};
  std::atomic<size_t> worker_ready_count{0};
  std::atomic<size_t> release_worker_count{0};
  std::atomic<bool> release_all_workers{false};
};

struct DownloadPageWorker {
  DownloadPageContext* context = nullptr;
  size_t index = 0;
};

struct DownloadPage {
  std::vector<ValidatedDownload> responses;
  size_t next_probe_begin = 0;
  std::vector<ProbeResult> carried_probes;
  bool probes_valid = false;
  bool responses_valid = false;
  bool synchronization_valid = false;
};

bool validate_meme_file(const std::vector<uint8_t>& bytes,
                        uint64_t* epoch_count);

bool monotonic_now_nanoseconds(uint64_t* value) {
  if (!value) return false;
  timespec now{};
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0 || now.tv_sec < 0 ||
      now.tv_nsec < 0 || now.tv_nsec >= 1'000'000'000L) {
    return false;
  }
  const uint64_t seconds = static_cast<uint64_t>(now.tv_sec);
  const uint64_t nanoseconds = static_cast<uint64_t>(now.tv_nsec);
  if (seconds >
      (std::numeric_limits<uint64_t>::max() - nanoseconds) /
          1'000'000'000ull) {
    return false;
  }
  *value = seconds * 1'000'000'000ull + nanoseconds;
  return true;
}

bool monotonic_deadline(uint64_t timeout_nanoseconds, uint64_t* deadline) {
  uint64_t now = 0;
  if (!deadline || !monotonic_now_nanoseconds(&now) ||
      now > std::numeric_limits<uint64_t>::max() - timeout_nanoseconds) {
    return false;
  }
  *deadline = now + timeout_nanoseconds;
  return true;
}

bool deadline_expired(uint64_t deadline) {
  uint64_t now = 0;
  return !monotonic_now_nanoseconds(&now) || now >= deadline;
}

bool thread_poll_pause() {
  return sched_yield() == 0;
}

void fail_download_synchronization(DownloadPageContext* context) {
  context->synchronization_failed.store(true, std::memory_order_release);
  context->release_all_workers.store(true, std::memory_order_release);
}

bool wait_for_flag(const std::atomic<bool>& flag,
                   const std::atomic<bool>& cancelled) {
  uint64_t deadline = 0;
  if (!monotonic_deadline(kThreadBarrierTimeoutNanoseconds, &deadline)) {
    return false;
  }
  for (;;) {
    if (flag.load(std::memory_order_acquire)) return true;
    if (cancelled.load(std::memory_order_acquire)) return false;
    if (deadline_expired(deadline) || !thread_poll_pause()) return false;
  }
}

bool wait_for_count(const std::atomic<size_t>& value, size_t expected,
                    const std::atomic<bool>& cancelled) {
  uint64_t deadline = 0;
  if (!monotonic_deadline(kThreadBarrierTimeoutNanoseconds, &deadline)) {
    return false;
  }
  for (;;) {
    if (value.load(std::memory_order_acquire) >= expected) return true;
    if (cancelled.load(std::memory_order_acquire)) return false;
    if (deadline_expired(deadline) || !thread_poll_pause()) return false;
  }
}

bool wait_for_worker_release(const DownloadPageContext* context,
                             size_t worker_index) {
  uint64_t deadline = 0;
  if (!monotonic_deadline(kThreadBarrierTimeoutNanoseconds, &deadline)) {
    return false;
  }
  for (;;) {
    if (context->release_all_workers.load(std::memory_order_acquire) ||
        context->release_worker_count.load(std::memory_order_acquire) >
            worker_index) {
      return true;
    }
    if (deadline_expired(deadline) || !thread_poll_pause()) return false;
  }
}

bool join_worker(pthread_t worker) {
  return pthread_join(worker, nullptr) == 0;
}

struct RawHttpResult {
  int64_t status = 0;
  std::vector<uint8_t> body;
  std::string meta;
};

bool json_object_field(std::string_view json, std::string_view key,
                       std::string_view* object) {
  if (!object) return false;
  const size_t begin = json_value_position(json, key);
  if (begin == std::string_view::npos || begin >= json.size() ||
      json[begin] != '{') {
    return false;
  }
  size_t depth = 0;
  bool in_string = false;
  bool escaped = false;
  for (size_t cursor = begin; cursor < json.size(); ++cursor) {
    const char value = json[cursor];
    if (in_string) {
      if (escaped) {
        escaped = false;
      } else if (value == '\\') {
        escaped = true;
      } else if (value == '"') {
        in_string = false;
      }
      continue;
    }
    if (value == '"') {
      in_string = true;
    } else if (value == '{') {
      ++depth;
    } else if (value == '}' && --depth == 0) {
      *object = json.substr(begin, cursor - begin + 1);
      return true;
    }
  }
  return false;
}

bool validate_http_envelope_layout(const std::vector<uint8_t>& envelope,
                                   size_t max_body_bytes) {
  if (envelope.size() < 8) return false;
  size_t cursor = 0;
  const uint32_t meta_length = read_u32le(envelope.data());
  cursor += 4;
  if (meta_length > kMaxHttpMetaBytes ||
      meta_length > envelope.size() - cursor - 4) {
    return false;
  }
  cursor += meta_length;
  const uint32_t segment_count = read_u32le(envelope.data() + cursor);
  cursor += 4;
  if (segment_count > 1 || segment_count > (envelope.size() - cursor) / 4) {
    return false;
  }
  for (uint32_t index = 0; index < segment_count; ++index) {
    if (cursor + 4 > envelope.size()) return false;
    const uint32_t length = read_u32le(envelope.data() + cursor);
    cursor += 4;
    if (length > max_body_bytes || length > envelope.size() - cursor) {
      return false;
    }
    cursor += length;
  }
  return cursor == envelope.size();
}

RawHttpResult http_request(std::string_view url, size_t max_body_bytes,
                           bool size_probe) {
  RawHttpResult result;
  if (max_body_bytes == 0 || max_body_bytes > kMaxResponseBytes) return result;
  const std::string params =
      "{\"method\":\"GET\",\"url\":\"" + json_escape(url) +
      "\",\"responseType\":\"bytes\"" +
      (size_probe ? ",\"headers\":{\"Range\":\"bytes=0-0\"}" : "") +
      ",\"max_bytes\":" +
      std::to_string(max_body_bytes) + "}";
  std::vector<uint8_t> request;
  request.reserve(params.size() + 8);
  append_u32le(&request, static_cast<uint32_t>(params.size()));
  request.insert(request.end(), params.begin(), params.end());
  append_u32le(&request, 0);

  sdm_host_clear_response();
  constexpr std::string_view operation = "http.request";
  const int32_t call_result = sdm_host_call(
      operation.data(), static_cast<int32_t>(operation.size()),
      reinterpret_cast<const char*>(request.data()),
      static_cast<int32_t>(request.size()));
  const int32_t status_code = sdm_host_last_status_code();
  const int32_t response_length = sdm_host_response_len();
  const size_t max_envelope_bytes =
      max_body_bytes + kMaxHttpMetaBytes + 12;
  if (call_result != 0 || status_code != 0 || response_length < 8 ||
      static_cast<size_t>(response_length) > max_envelope_bytes) {
    sdm_host_clear_response();
    return result;
  }
  std::vector<uint8_t> response(static_cast<size_t>(response_length));
  const int32_t copied = sdm_host_read_response(
      reinterpret_cast<char*>(response.data()), response_length);
  sdm_host_clear_response();
  if (copied != response_length ||
      !validate_http_envelope_layout(response, max_body_bytes)) {
    return result;
  }

  std::vector<std::vector<uint8_t>> segments;
  if (!parse_envelope(response, &result.meta, &segments) ||
      result.meta.find("\"ok\":true") == std::string::npos ||
      !json_int64(result.meta, "status", &result.status)) {
    result.status = 0;
    return result;
  }
  size_t segment_index = 0;
  if (binary_field_index(result.meta, "body", &segment_index)) {
    if (segment_index < segments.size() &&
        segments[segment_index].size() <= max_body_bytes) {
      result.body = std::move(segments[segment_index]);
    }
    return result;
  }
  std::string body;
  if (!json_string(result.meta, "body", &body)) return result;
  std::string encoding;
  json_string(result.meta, "body_encoding", &encoding);
  if (encoding == "base64") {
    result.body = base64_decode(body);
  } else {
    result.body.assign(body.begin(), body.end());
  }
  if (result.body.size() > max_body_bytes) {
    result.body.clear();
    result.status = 0;
  }
  return result;
}

provider_node::HttpResult http_get_complete(std::string_view url,
                                            size_t expected_bytes) {
  provider_node::HttpResult result;
  RawHttpResult raw = http_request(url, expected_bytes, false);
  result.status = raw.status;
  if (raw.status == 200 && raw.body.size() == expected_bytes) {
    result.body = std::move(raw.body);
  } else {
    result.status = 0;
  }
  return result;
}

ProbeResult probe_complete_size(std::string_view url) {
  RawHttpResult raw = http_request(url, 1, true);
  ProbeResult result;
  if (raw.status != 206 || raw.body.size() != 1) return result;
  std::string_view result_object;
  std::string_view headers_object;
  if (!json_object_field(raw.meta, "result", &result_object) ||
      !json_object_field(result_object, "headers", &headers_object)) {
    return result;
  }
  std::string content_range;
  if (!json_string(headers_object, "Content-Range", &content_range) &&
      !json_string(headers_object, "content-range", &content_range)) {
    return result;
  }
  constexpr std::string_view prefix = "bytes 0-0/";
  if (content_range.rfind(prefix, 0) != 0 ||
      content_range.size() == prefix.size()) {
    return result;
  }
  uint64_t value = 0;
  for (size_t index = prefix.size(); index < content_range.size(); ++index) {
    const char digit = content_range[index];
    if (digit < '0' || digit > '9' ||
        value > (std::numeric_limits<uint64_t>::max() -
                 static_cast<uint64_t>(digit - '0')) /
                    10) {
      return result;
    }
    value = value * 10 + static_cast<uint64_t>(digit - '0');
  }
  if (value == 0 || value > kMaxStarlinkFileBytes) return result;
  result.byte_length = value;
  result.valid = true;
  return result;
}

void finalize_download_admission(DownloadPageContext* context) {
  const size_t count = context->end - context->begin;
  uint64_t retained_bytes = 0;
  bool accepting = true;
  for (size_t local = 0; local < count; ++local) {
    const ProbeResult& probe = (*context->probes)[local];
    if (!probe.valid) {
      context->probe_invalid = true;
      accepting = false;
      continue;
    }
    if (accepting && probe.byte_length <=
                         kMaxFetchWaveBytesPerInvocation - retained_bytes) {
      retained_bytes += probe.byte_length;
      ++context->admitted_count;
    } else {
      accepting = false;
    }
  }
  if (context->probe_invalid) {
    context->admitted_count = 0;
  }
  context->admission_ready.store(true, std::memory_order_release);
}

void download_page_tasks(DownloadPageContext* context) {
  const size_t count = context->end - context->begin;
  for (;;) {
    const size_t local =
        context->probe_next.fetch_add(1, std::memory_order_relaxed);
    const size_t index = context->begin + local;
    if (index >= context->end) break;
    const ProbeResult probe =
        probe_complete_size((*context->units)[index].url);

    (*context->probes)[local] = probe;
    if (context->probes_completed.fetch_add(1, std::memory_order_acq_rel) + 1 ==
        count) {
      finalize_download_admission(context);
    }
  }

  if (!wait_for_flag(context->admission_ready,
                     context->synchronization_failed)) {
    fail_download_synchronization(context);
    return;
  }
  const bool synchronized =
      !context->synchronization_failed.load(std::memory_order_acquire);
  const size_t admitted_count = context->admitted_count;
  if (!synchronized) return;

  for (;;) {
    const size_t local =
        context->fetch_next.fetch_add(1, std::memory_order_relaxed);
    if (local >= admitted_count) break;
    const size_t index = context->begin + local;
    ValidatedDownload download;
    download.response = http_get_complete(
        (*context->units)[index].url,
        static_cast<size_t>((*context->probes)[local].byte_length));
    if (download.response.status == 200 && !download.response.body.empty() &&
        download.response.body.size() <= kMaxStarlinkFileBytes) {
      uint64_t epoch_count = 0;
      if (validate_meme_file(download.response.body, &epoch_count)) {
        download.metadata.byte_length = download.response.body.size();
        download.metadata.epoch_count = epoch_count;
        sha256(download.response.body.data(), download.response.body.size(),
               download.metadata.digest.data());
        download.metadata.valid = true;
      }
    }
    (*context->responses)[local] = std::move(download);
  }
}

void* download_page_worker(void* opaque) {
  auto* worker = static_cast<DownloadPageWorker*>(opaque);
  DownloadPageContext* context = worker->context;
  download_page_tasks(context);
  context->worker_ready_count.fetch_add(1, std::memory_order_release);
  if (!wait_for_worker_release(context, worker->index)) {
    fail_download_synchronization(context);
  }
  return nullptr;
}

DownloadPage download_complete_page(
    const std::vector<PlannedUnit>& units, size_t begin, size_t end,
    uint32_t fetch_concurrency,
    const std::vector<ProbeResult>* carried_probes) {
  DownloadPage page;
  const size_t count = end > begin ? end - begin : 0;
  if (count == 0) return page;
  std::vector<ProbeResult> probes(count);
  std::vector<ValidatedDownload> responses(count);
  DownloadPageContext context;
  context.units = &units;
  context.begin = begin;
  context.end = end;
  context.probes = &probes;
  context.responses = &responses;
  size_t carried_count = 0;
  if (carried_probes && carried_probes->size() <= count &&
      std::all_of(carried_probes->begin(), carried_probes->end(),
                  [](const ProbeResult& probe) { return probe.valid; })) {
    carried_count = carried_probes->size();
    std::copy(carried_probes->begin(), carried_probes->end(), probes.begin());
    context.probe_next.store(carried_count, std::memory_order_relaxed);
    context.probes_completed.store(carried_count, std::memory_order_relaxed);
    if (carried_count == count) {
      finalize_download_admission(&context);
    }
  }
  const size_t actionable_worker_count =
      std::max(carried_count, count - carried_count);
  const size_t worker_count = std::min<size_t>(
      actionable_worker_count,
      std::max<uint32_t>(
          1, std::min(fetch_concurrency, kMaxFetchConcurrency)));

  // One page-scoped cohort owns both phases. Every probe completes before the
  // cohort crosses the in-page admission barrier, so the same workers can
  // immediately issue the bounded complete GET wave without an exit/recreate
  // cycle. Atomic polling deliberately avoids WasmEdge's shared-executor
  // futex wake queue: the prior condition-variable protocol lost wakeups in
  // the exact runtime. Completed workers remain alive until the main lane
  // releases and joins them one at a time. No pthread survives this page or
  // depends on an atomic-wait notification to retire.
  std::array<DownloadPageWorker, kMaxFetchConcurrency - 1> worker_arguments{};
  std::vector<pthread_t> workers;
  workers.reserve(worker_count > 0 ? worker_count - 1 : 0);
  for (size_t index = 0; index + 1 < worker_count; ++index) {
    const size_t worker_index = workers.size();
    worker_arguments[worker_index].context = &context;
    worker_arguments[worker_index].index = worker_index;
    pthread_t worker{};
    if (pthread_create(&worker, nullptr, download_page_worker,
                       &worker_arguments[worker_index]) == 0) {
      workers.push_back(worker);
    }
  }
  download_page_tasks(&context);

  if (!wait_for_count(context.worker_ready_count, workers.size(),
                      context.release_all_workers)) {
    fail_download_synchronization(&context);
  }

  bool all_workers_joined = true;
  for (size_t index = 0; index < workers.size(); ++index) {
    context.release_worker_count.store(index + 1, std::memory_order_release);
    if (!join_worker(workers[index])) {
      // Release every later worker and continue attempting to join the whole
      // cohort before trapping. Returning from the page while even one worker
      // may retain its stack context would expose page-local storage.
      fail_download_synchronization(&context);
      all_workers_joined = false;
    }
  }
  if (!all_workers_joined) {
    __builtin_trap();
  }
  page.probes_valid = !context.probe_invalid;
  page.synchronization_valid =
      !context.synchronization_failed.load(std::memory_order_acquire);
  if (page.probes_valid && context.admitted_count <= probes.size()) {
    page.next_probe_begin = begin + context.admitted_count;
    page.carried_probes.assign(probes.begin() + context.admitted_count,
                               probes.end());
  }
  responses.resize(context.admitted_count);
  page.responses_valid =
      !responses.empty() &&
      std::all_of(responses.begin(), responses.end(),
                  [](const ValidatedDownload& download) {
                    return download.metadata.valid;
                  });
  page.responses = std::move(responses);
  return page;
}

bool meme_whitespace(char value) {
  return value == ' ' || value == '\t' || value == '\r' || value == '\v' ||
         value == '\f';
}

std::string_view trim_meme_record(std::string_view record) {
  while (!record.empty() && meme_whitespace(record.front())) {
    record.remove_prefix(1);
  }
  while (!record.empty() && meme_whitespace(record.back())) {
    record.remove_suffix(1);
  }
  return record;
}

bool meme_header_value(std::string_view record, std::string_view prefix) {
  return record.size() > prefix.size() &&
         record.substr(0, prefix.size()) == prefix &&
         !trim_meme_record(record.substr(prefix.size())).empty();
}

bool valid_meme_range_header(std::string_view record) {
  constexpr std::string_view start = "ephemeris_start:";
  constexpr std::string_view stop = " ephemeris_stop:";
  constexpr std::string_view step = " step_size:";
  if (record.substr(0, start.size()) != start) return false;
  const size_t stop_position = record.find(stop, start.size());
  const size_t step_position =
      stop_position == std::string_view::npos
          ? std::string_view::npos
          : record.find(step, stop_position + stop.size());
  return stop_position != std::string_view::npos &&
         step_position != std::string_view::npos &&
         !trim_meme_record(
              record.substr(start.size(), stop_position - start.size()))
              .empty() &&
         !trim_meme_record(record.substr(
              stop_position + stop.size(),
              step_position - (stop_position + stop.size())))
              .empty() &&
         !trim_meme_record(record.substr(step_position + step.size())).empty();
}

bool strict_finite_decimal(std::string_view token) {
  constexpr size_t kMaxNumericTokenBytes = 128;
  if (token.empty() || token.size() > kMaxNumericTokenBytes) return false;
  size_t cursor = 0;
  if (token[cursor] == '+' || token[cursor] == '-') {
    if (++cursor == token.size()) return false;
  }
  size_t integer_digits = 0;
  while (cursor < token.size() && token[cursor] >= '0' &&
         token[cursor] <= '9') {
    ++cursor;
    ++integer_digits;
  }
  size_t fractional_digits = 0;
  if (cursor < token.size() && token[cursor] == '.') {
    ++cursor;
    while (cursor < token.size() && token[cursor] >= '0' &&
           token[cursor] <= '9') {
      ++cursor;
      ++fractional_digits;
    }
  }
  if (integer_digits == 0 && fractional_digits == 0) return false;
  const size_t significand_end = cursor;
  bool exponent_negative = false;
  uint32_t exponent_magnitude = 0;
  if (cursor < token.size() &&
      (token[cursor] == 'e' || token[cursor] == 'E')) {
    ++cursor;
    if (cursor < token.size() &&
        (token[cursor] == '+' || token[cursor] == '-')) {
      exponent_negative = token[cursor] == '-';
      ++cursor;
    }
    const size_t exponent_begin = cursor;
    while (cursor < token.size() && token[cursor] >= '0' &&
           token[cursor] <= '9') {
      constexpr uint32_t kExponentSaturation = 10'000;
      if (exponent_magnitude < kExponentSaturation) {
        const uint32_t digit = static_cast<uint32_t>(token[cursor] - '0');
        exponent_magnitude = std::min(
            kExponentSaturation, exponent_magnitude * 10 + digit);
      }
      ++cursor;
    }
    if (cursor == exponent_begin) return false;
  }
  if (cursor != token.size()) return false;

  size_t digit_ordinal = 0;
  size_t first_nonzero_ordinal = std::numeric_limits<size_t>::max();
  const size_t significand_begin =
      token.front() == '+' || token.front() == '-' ? 1 : 0;
  for (size_t index = significand_begin; index < significand_end; ++index) {
    if (token[index] == '.') continue;
    if (first_nonzero_ordinal == std::numeric_limits<size_t>::max() &&
        token[index] != '0') {
      first_nonzero_ordinal = digit_ordinal;
    }
    ++digit_ordinal;
  }
  if (first_nonzero_ordinal == std::numeric_limits<size_t>::max()) {
    return true;
  }

  const int64_t explicit_exponent =
      exponent_negative ? -static_cast<int64_t>(exponent_magnitude)
                        : static_cast<int64_t>(exponent_magnitude);
  const int64_t normalized_exponent =
      explicit_exponent + static_cast<int64_t>(integer_digits) -
      static_cast<int64_t>(first_nonzero_ordinal) - 1;
  if (normalized_exponent > -308 && normalized_exponent < 308) return true;
  if (normalized_exponent < -308 || normalized_exponent > 308) return false;

  // These prefixes cover every significant digit possible under the token
  // bound and identify the round-to-nearest boundaries between the smallest
  // normal value and the largest subnormal, and between DBL_MAX and overflow.
  // A field at or above the first boundary avoids ERANGE underflow; a field
  // below the second avoids ERANGE overflow. Only decimal digit comparison is
  // needed because this provider forwards the byte-exact MEME record.
  constexpr std::string_view kMinimumNormalRoundingBoundary =
      "2225073858507201136057409796709131975934819546351645648023426109"
      "7248222220210769455165295239081350879141491589130396211068700864";
  constexpr std::string_view kOverflowRoundingBoundary =
      "1797693134862315807937289714053034150799341327100378269361737789"
      "8044496829276475094664901797758720709633028641669288791094655554";
  const auto compare_significand =
      [&](std::string_view boundary) {
        size_t boundary_index = 0;
        bool started = false;
        for (size_t index = significand_begin; index < significand_end;
             ++index) {
          const char digit = token[index];
          if (digit == '.') continue;
          if (!started && digit == '0') continue;
          started = true;
          const char expected =
              boundary_index < boundary.size() ? boundary[boundary_index] : '0';
          if (digit < expected) return -1;
          if (digit > expected) return 1;
          ++boundary_index;
        }
        while (boundary_index < boundary.size()) {
          if (boundary[boundary_index++] != '0') return -1;
        }
        return 0;
      };
  if (normalized_exponent == -308) {
    return compare_significand(kMinimumNormalRoundingBoundary) >= 0;
  }
  return compare_significand(kOverflowRoundingBoundary) < 0;
}

uint32_t meme_timestamp_component(std::string_view token, size_t begin,
                                  size_t length) {
  uint32_t value = 0;
  for (size_t index = begin; index < begin + length; ++index) {
    value = value * 10 + static_cast<uint32_t>(token[index] - '0');
  }
  return value;
}

bool valid_meme_timestamp(std::string_view token) {
  if (token.size() < 15) return false;
  for (size_t index = 0; index < 13; ++index) {
    if (token[index] < '0' || token[index] > '9') return false;
  }
  if (token[13] != '.' || token.size() == 14) return false;
  for (size_t index = 14; index < token.size(); ++index) {
    if (token[index] < '0' || token[index] > '9') return false;
  }
  const uint32_t year = meme_timestamp_component(token, 0, 4);
  const uint32_t day = meme_timestamp_component(token, 4, 3);
  const uint32_t hour = meme_timestamp_component(token, 7, 2);
  const uint32_t minute = meme_timestamp_component(token, 9, 2);
  const uint32_t second = meme_timestamp_component(token, 11, 2);
  const bool leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
  const uint32_t days_in_year = leap ? 366 : 365;
  return year != 0 && day >= 1 && day <= days_in_year && hour <= 23 &&
         minute <= 59 && second <= 60;
}

bool validate_meme_data_record(std::string_view record, bool* epoch) {
  constexpr size_t kMaxFieldsPerRecord = 64;
  if (!epoch) return false;
  *epoch = false;
  std::string_view first;
  size_t field_count = 0;
  size_t cursor = 0;
  while (cursor < record.size()) {
    while (cursor < record.size() && meme_whitespace(record[cursor])) ++cursor;
    if (cursor == record.size()) break;
    const size_t begin = cursor;
    while (cursor < record.size() && !meme_whitespace(record[cursor])) ++cursor;
    const std::string_view field = record.substr(begin, cursor - begin);
    if (!strict_finite_decimal(field)) return false;
    if (field_count == 0) first = field;
    if (++field_count > kMaxFieldsPerRecord) return false;
  }
  if (field_count == 0) return false;

  size_t leading_digits = 0;
  while (leading_digits < first.size() && first[leading_digits] >= '0' &&
         first[leading_digits] <= '9') {
    ++leading_digits;
  }
  if (valid_meme_timestamp(first)) {
    if (field_count != 7) return false;
    *epoch = true;
    return true;
  }
  return leading_digits < 13;
}

bool validate_meme_file(const std::vector<uint8_t>& bytes,
                        uint64_t* epoch_count) {
  if (!epoch_count) return false;
  *epoch_count = 0;
  size_t nonempty_record = 0;
  bool saw_data = false;
  const std::string_view text(reinterpret_cast<const char*>(bytes.data()),
                              bytes.size());
  size_t cursor = 0;
  while (cursor <= text.size()) {
    const size_t newline = text.find('\n', cursor);
    const size_t end =
        newline == std::string_view::npos ? text.size() : newline;
    const std::string_view raw_record = text.substr(cursor, end - cursor);
    const std::string_view record = trim_meme_record(raw_record);
    if (!record.empty()) {
      if (nonempty_record < 4) {
        const bool valid_header =
            (nonempty_record == 0 && meme_header_value(record, "created:")) ||
            (nonempty_record == 1 && valid_meme_range_header(record)) ||
            (nonempty_record == 2 &&
             meme_header_value(record, "ephemeris_source:")) ||
            (nonempty_record == 3 && record == "UVW");
        if (!valid_header) return false;
        ++nonempty_record;
      } else {
        bool epoch = false;
        if (!validate_meme_data_record(record, &epoch)) return false;
        saw_data = true;
        if (epoch) {
          if (*epoch_count == std::numeric_limits<uint64_t>::max()) {
            return false;
          }
          ++*epoch_count;
        }
      }
    }
    if (newline == std::string_view::npos) break;
    cursor = newline + 1;
  }
  return nonempty_record == 4 && saw_data && *epoch_count > 0;
}

uint64_t trusted_meme_epoch_count(const std::vector<uint8_t>&) {
  return g_trusted_emission_epoch_count;
}

void append_u16le(std::vector<uint8_t>* output, uint16_t value) {
  output->push_back(static_cast<uint8_t>(value));
  output->push_back(static_cast<uint8_t>(value >> 8));
}

void append_u64le(std::vector<uint8_t>* output, uint64_t value) {
  for (uint32_t shift = 0; shift < 64; shift += 8) {
    output->push_back(static_cast<uint8_t>(value >> shift));
  }
}

uint16_t read_u16le(const uint8_t* value) {
  return static_cast<uint16_t>(value[0]) |
         static_cast<uint16_t>(static_cast<uint16_t>(value[1]) << 8);
}

uint64_t read_u64le(const uint8_t* value) {
  uint64_t result = 0;
  for (uint32_t shift = 0; shift < 64; shift += 8) {
    result |= static_cast<uint64_t>(value[shift / 8]) << shift;
  }
  return result;
}

bool json_bool(std::string_view json, std::string_view key, bool* output) {
  if (!output) return false;
  const size_t cursor = json_value_position(json, key);
  if (cursor == std::string_view::npos) return false;
  if (json.substr(cursor, 4) == "true") {
    *output = true;
    return true;
  }
  if (json.substr(cursor, 5) == "false") {
    *output = false;
    return true;
  }
  return false;
}

struct StorageResponse {
  std::string meta;
  std::vector<std::vector<uint8_t>> segments;
};

void capture_storage_error_message(std::string_view meta,
                                   std::string* error_message) {
  if (!error_message) return;
  error_message->clear();
  std::string message;
  if (!json_string(meta, "message", &message) || message.empty()) return;
  if (message.size() > kMaxStorageErrorMessageBytes) {
    message.resize(kMaxStorageErrorMessageBytes);
  }
  for (char& value : message) {
    const unsigned char byte = static_cast<unsigned char>(value);
    if (byte < 0x20 || byte == 0x7f) value = ' ';
  }
  *error_message = std::move(message);
}

void set_storage_error(std::string* output, std::string_view context,
                       std::string_view host_detail) {
  if (!output) return;
  output->assign(context);
  if (!host_detail.empty()) {
    output->append(": ");
    output->append(host_detail);
  }
}

bool validate_storage_envelope_layout(
    const std::vector<uint8_t>& envelope) {
  if (envelope.size() < 8) return false;
  size_t cursor = 0;
  const uint32_t meta_length = read_u32le(envelope.data());
  cursor += 4;
  if (meta_length > kMaxStorageMetaBytes ||
      meta_length > envelope.size() - cursor - 4) {
    return false;
  }
  cursor += meta_length;
  const uint32_t segment_count = read_u32le(envelope.data() + cursor);
  cursor += 4;
  if (segment_count > kMaxStorageSegments ||
      segment_count > (envelope.size() - cursor) / 4) {
    return false;
  }
  for (uint32_t index = 0; index < segment_count; ++index) {
    if (cursor + 4 > envelope.size()) return false;
    const uint32_t length = read_u32le(envelope.data() + cursor);
    cursor += 4;
    if (length > kMaxCheckpointBytes || length > envelope.size() - cursor) {
      return false;
    }
    cursor += length;
  }
  return cursor == envelope.size();
}

bool call_storage_bytes(std::string_view operation, const std::string& meta,
                        const uint8_t* segment_data, size_t segment_size,
                        bool has_segment, StorageResponse* response,
                        std::string* error_message = nullptr) {
  if (error_message) error_message->clear();
  if (!response || operation.size() > static_cast<size_t>(INT32_MAX) ||
      meta.size() > static_cast<size_t>(INT32_MAX) ||
      segment_size > static_cast<size_t>(INT32_MAX) ||
      (has_segment && !segment_data) ||
      segment_size > static_cast<size_t>(INT32_MAX) - 12 ||
      meta.size() > static_cast<size_t>(INT32_MAX) - 12 - segment_size) {
    return false;
  }
  std::vector<uint8_t> request;
  request.reserve(8 + meta.size() + (has_segment ? 4 + segment_size : 0));
  append_u32le(&request, static_cast<uint32_t>(meta.size()));
  request.insert(request.end(), meta.begin(), meta.end());
  append_u32le(&request, has_segment ? 1 : 0);
  if (has_segment) {
    append_u32le(&request, static_cast<uint32_t>(segment_size));
    request.insert(request.end(), segment_data, segment_data + segment_size);
  }

  sdm_host_clear_response();
  const int32_t call_result = sdm_host_call(
      operation.data(), static_cast<int32_t>(operation.size()),
      reinterpret_cast<const char*>(request.data()),
      static_cast<int32_t>(request.size()));
  const int32_t status_code = sdm_host_last_status_code();
  const int32_t response_length = sdm_host_response_len();
  if (response_length < 8 ||
      static_cast<size_t>(response_length) > kMaxStorageResponseBytes) {
    sdm_host_clear_response();
    return false;
  }
  std::vector<uint8_t> response_bytes(static_cast<size_t>(response_length));
  const int32_t copied = sdm_host_read_response(
      reinterpret_cast<char*>(response_bytes.data()), response_length);
  sdm_host_clear_response();
  bool ok = false;
  if (copied != response_length ||
      !validate_storage_envelope_layout(response_bytes) ||
      !parse_envelope(response_bytes, &response->meta, &response->segments)) {
    return false;
  }
  if (call_result != 0 || status_code != 0 ||
      !json_bool(response->meta, "ok", &ok) || !ok) {
    capture_storage_error_message(response->meta, error_message);
    return false;
  }
  return true;
}

bool call_storage(std::string_view operation, const std::string& meta,
                  const std::vector<uint8_t>* segment,
                  StorageResponse* response,
                  std::string* error_message = nullptr) {
  return call_storage_bytes(operation, meta,
                            segment ? segment->data() : nullptr,
                            segment ? segment->size() : 0, segment != nullptr,
                            response, error_message);
}

std::string storage_meta(std::string_view namespace_name,
                         std::string_view key, bool has_data = false) {
  std::string meta = "{\"namespace\":\"";
  meta += namespace_name;
  meta += "\"";
  if (!key.empty()) {
    meta += ",\"key\":\"";
    meta += key;
    meta += "\"";
  }
  if (has_data) meta += ",\"data\":{\"$bin\":0}";
  meta += "}";
  return meta;
}

bool read_opaque_value(std::string_view namespace_name,
                       const std::string& key, size_t max_bytes,
                       std::vector<uint8_t>* value, bool* found,
                       std::string* error_message = nullptr) {
  if (!value || !found) return false;
  StorageResponse response;
  if (!call_storage("storage.adapter.opaque.read",
                    storage_meta(namespace_name, key), nullptr, &response,
                    error_message) ||
      !json_bool(response.meta, "found", found)) {
    return false;
  }
  value->clear();
  if (!*found) return true;
  size_t segment_index = 0;
  if (binary_field_index(response.meta, "bytes_b64", &segment_index)) {
    if (segment_index >= response.segments.size() ||
        response.segments[segment_index].size() > max_bytes) {
      return false;
    }
    *value = std::move(response.segments[segment_index]);
    return true;
  }
  std::string encoded;
  if (!json_string(response.meta, "bytes_b64", &encoded) ||
      encoded.size() > ((max_bytes + 2) / 3) * 4 + 4) {
    return false;
  }
  *value = base64_decode(encoded);
  return value->size() <= max_bytes;
}

bool replace_opaque_value(std::string_view namespace_name,
                          const std::string& key,
                          const std::vector<uint8_t>& value,
                          std::string* error_message = nullptr) {
  StorageResponse response;
  int64_t stored_bytes = -1;
  return call_storage("storage.adapter.opaque.replace",
                      storage_meta(namespace_name, key, true), &value, &response,
                      error_message) &&
         json_int64(response.meta, "stored_bytes", &stored_bytes) &&
         stored_bytes == static_cast<int64_t>(value.size());
}

bool replace_opaque_bytes(std::string_view namespace_name,
                          const std::string& key, const uint8_t* data,
                          size_t byte_length,
                          std::string* error_message = nullptr) {
  if (!data || byte_length == 0 || byte_length > kOpaqueChunkBytes) {
    return false;
  }
  StorageResponse response;
  int64_t stored_bytes = -1;
  return call_storage_bytes("storage.adapter.opaque.replace",
                            storage_meta(namespace_name, key, true), data,
                            byte_length, true, &response, error_message) &&
         json_int64(response.meta, "stored_bytes", &stored_bytes) &&
         stored_bytes == static_cast<int64_t>(byte_length);
}

void write_u32le(uint8_t* output, uint32_t value) {
  output[0] = static_cast<uint8_t>(value);
  output[1] = static_cast<uint8_t>(value >> 8);
  output[2] = static_cast<uint8_t>(value >> 16);
  output[3] = static_cast<uint8_t>(value >> 24);
}

bool encode_opaque_chunk(const uint8_t* raw, size_t raw_length,
                         std::vector<uint8_t>* stored) {
  if (!raw || !stored || raw_length == 0 ||
      raw_length > kOpaqueChunkBytes) {
    return false;
  }
  if (raw_length > kCompressedChunkHeaderBytes) {
    std::vector<uint8_t> candidate(raw_length);
    const int flags = static_cast<int>(
        tdefl_create_comp_flags_from_zip_params(
            MZ_BEST_SPEED, 15, MZ_DEFAULT_STRATEGY));
    const size_t compressed_length = tdefl_compress_mem_to_mem(
        candidate.data() + kCompressedChunkHeaderBytes,
        candidate.size() - kCompressedChunkHeaderBytes, raw, raw_length,
        flags);
    if (compressed_length > 0 &&
        compressed_length + kCompressedChunkHeaderBytes < raw_length) {
      std::copy(std::begin(kCompressedChunkMagic),
                std::end(kCompressedChunkMagic), candidate.begin());
      write_u32le(candidate.data() + 8,
                  static_cast<uint32_t>(raw_length));
      write_u32le(candidate.data() + 12,
                  static_cast<uint32_t>(compressed_length));
      candidate.resize(kCompressedChunkHeaderBytes + compressed_length);
      *stored = std::move(candidate);
      return true;
    }
  }
  stored->assign(raw, raw + raw_length);
  return true;
}

bool decode_opaque_chunk(const std::vector<uint8_t>& stored,
                         size_t expected_raw_length, uint8_t* raw) {
  if (!raw || expected_raw_length == 0 ||
      expected_raw_length > kOpaqueChunkBytes ||
      stored.size() > expected_raw_length) {
    return false;
  }
  if (stored.size() == expected_raw_length) {
    std::memcpy(raw, stored.data(), stored.size());
    return true;
  }
  if (stored.size() <= kCompressedChunkHeaderBytes ||
      !std::equal(std::begin(kCompressedChunkMagic),
                  std::end(kCompressedChunkMagic), stored.begin()) ||
      read_u32le(stored.data() + 8) != expected_raw_length ||
      read_u32le(stored.data() + 12) !=
          stored.size() - kCompressedChunkHeaderBytes) {
    return false;
  }
  const size_t decoded_length = tinfl_decompress_mem_to_mem(
      raw, expected_raw_length,
      stored.data() + kCompressedChunkHeaderBytes,
      stored.size() - kCompressedChunkHeaderBytes,
      TINFL_FLAG_PARSE_ZLIB_HEADER);
  return decoded_length == expected_raw_length;
}

bool delete_opaque_value(std::string_view namespace_name,
                         const std::string& key,
                         std::string* error_message = nullptr) {
  StorageResponse response;
  bool deleted = false;
  return call_storage("storage.adapter.opaque.delete",
                      storage_meta(namespace_name, key), nullptr, &response,
                      error_message) &&
         json_bool(response.meta, "deleted", &deleted) && deleted;
}

bool sync_opaque_state(std::string_view namespace_name,
                       std::string* error_message = nullptr) {
  StorageResponse response;
  bool synced = false;
  return call_storage("storage.adapter.opaque.sync",
                      storage_meta(namespace_name, {}), nullptr, &response,
                      error_message) &&
         json_bool(response.meta, "synced", &synced) && synced;
}

std::string hex_digest(const std::array<uint8_t, 32>& digest) {
  constexpr char alphabet[] = "0123456789abcdef";
  std::string output;
  output.resize(64);
  for (size_t index = 0; index < digest.size(); ++index) {
    output[index * 2] = alphabet[digest[index] >> 4];
    output[index * 2 + 1] = alphabet[digest[index] & 0x0f];
  }
  return output;
}

std::string chunk_namespace(const State& state, uint32_t unit_index) {
  return "starlink." + hex_digest(state.generation) + ".f" +
         std::to_string(unit_index);
}

std::string chunk_key(const State& state, uint32_t unit_index,
                      uint32_t chunk_index) {
  return "catalog." + hex_digest(state.generation) + ".f" +
         std::to_string(unit_index) + ".c" + std::to_string(chunk_index) +
         ".bin";
}

bool all_zero(const std::array<uint8_t, 32>& value) {
  return std::all_of(value.begin(), value.end(),
                     [](uint8_t byte) { return byte == 0; });
}

bool add_without_overflow(uint64_t left, uint64_t right, uint64_t* output) {
  if (!output || right > std::numeric_limits<uint64_t>::max() - left) {
    return false;
  }
  *output = left + right;
  return true;
}

bool filename_core(std::string_view filename, std::string_view* core) {
  constexpr std::string_view prefix = "MEME_";
  constexpr std::string_view suffix = "_UNCLASSIFIED.txt";
  if (!core || filename.size() > kMaxFilenameBytes ||
      filename.size() <= prefix.size() + suffix.size() ||
      filename.substr(0, prefix.size()) != prefix ||
      filename.substr(filename.size() - suffix.size()) != suffix) {
    return false;
  }
  const std::string_view candidate = filename.substr(
      prefix.size(), filename.size() - prefix.size() - suffix.size());
  if (candidate.empty() ||
      candidate.size() > std::numeric_limits<uint16_t>::max() ||
      candidate.find('/') != std::string_view::npos ||
      candidate.find('\\') != std::string_view::npos) {
    return false;
  }
  *core = candidate;
  return true;
}

uint32_t expected_chunk_count(uint64_t byte_length) {
  if (byte_length == 0 || byte_length > kMaxStarlinkFileBytes) return 0;
  return static_cast<uint32_t>(
      ((byte_length - 1) / kOpaqueChunkBytes) + 1);
}

std::vector<uint8_t> encode_checkpoint(const State& state) {
  if (state.config.manifest_url.empty() ||
      state.config.manifest_url.size() > kMaxEndpointBytes ||
      state.config.ephemeris_base.empty() ||
      state.config.ephemeris_base.size() > kMaxEndpointBytes ||
      state.config.fetch_concurrency == 0 ||
      state.config.fetch_concurrency > kMaxFetchConcurrency ||
      state.config.batch_size == 0 ||
      state.config.batch_size > kMaxFetchConcurrency ||
      state.config.object_cap > kMaxCatalogUnits || state.units.empty() ||
      state.units.size() > kMaxCatalogUnits ||
      state.downloaded_count > state.units.size() ||
      state.drain_index > state.units.size() || all_zero(state.generation) ||
      (state.phase != Phase::kDownloading && state.phase != Phase::kDraining) ||
      (state.phase == Phase::kDownloading &&
       (state.drain_index != 0 || state.cleanup_pending)) ||
      (state.cleanup_pending && state.drain_index == 0) ||
      (state.phase == Phase::kDraining &&
       state.downloaded_count != state.units.size())) {
    return {};
  }

  constexpr size_t fixed_header_bytes = 76;
  constexpr size_t fixed_unit_bytes = 42;
  constexpr size_t checksum_bytes = 32;
  constexpr size_t payload_limit = kMaxCheckpointBytes - checksum_bytes;
  size_t payload_size = fixed_header_bytes + state.config.manifest_url.size() +
                        state.config.ephemeris_base.size();
  uint64_t observed_bytes = 0;
  for (size_t index = 0; index < state.units.size(); ++index) {
    const PlannedUnit& unit = state.units[index];
    std::string_view core;
    uint64_t generation = 0;
    if (!filename_core(unit.filename, &core) ||
        !meme_generation(unit.filename, &generation) ||
        meme_identity(unit.filename) != unit.identity ||
        join_url(state.config.ephemeris_base, unit.filename) != unit.url ||
        payload_size > payload_limit ||
        fixed_unit_bytes > payload_limit - payload_size ||
        core.size() > payload_limit - payload_size - fixed_unit_bytes) {
      return {};
    }
    payload_size += fixed_unit_bytes + core.size();
    if (index < state.downloaded_count) {
      if (unit.byte_length == 0 || unit.byte_length > kMaxStarlinkFileBytes ||
          unit.byte_length > std::numeric_limits<uint32_t>::max() ||
          unit.chunk_count != expected_chunk_count(unit.byte_length) ||
          unit.epoch_count == 0 ||
          unit.epoch_count > std::numeric_limits<uint32_t>::max() ||
          all_zero(unit.digest) ||
          !add_without_overflow(observed_bytes, unit.byte_length,
                                &observed_bytes)) {
        return {};
      }
    } else if (unit.byte_length != 0 || unit.chunk_count != 0 ||
               unit.epoch_count != 0 || !all_zero(unit.digest)) {
      return {};
    }
  }
  if (payload_size > payload_limit ||
      observed_bytes != state.downloaded_bytes) {
    return {};
  }

  std::vector<uint8_t> bytes;
  bytes.reserve(payload_size + checksum_bytes);
  bytes.insert(bytes.end(), std::begin(kCheckpointMagic),
               std::end(kCheckpointMagic));
  append_u16le(&bytes, kCheckpointVersion);
  bytes.push_back(static_cast<uint8_t>(state.phase));
  bytes.push_back(state.cleanup_pending ? 1 : 0);
  append_u32le(&bytes, static_cast<uint32_t>(state.units.size()));
  append_u32le(&bytes, state.downloaded_count);
  append_u32le(&bytes, state.drain_index);
  append_u64le(&bytes, state.downloaded_bytes);
  append_u32le(&bytes, state.config.object_cap);
  append_u16le(&bytes, static_cast<uint16_t>(state.config.fetch_concurrency));
  append_u16le(&bytes, static_cast<uint16_t>(state.config.batch_size));
  append_u16le(
      &bytes, static_cast<uint16_t>(state.config.manifest_url.size()));
  append_u16le(
      &bytes, static_cast<uint16_t>(state.config.ephemeris_base.size()));
  bytes.insert(bytes.end(), state.generation.begin(), state.generation.end());
  bytes.insert(bytes.end(), state.config.manifest_url.begin(),
               state.config.manifest_url.end());
  bytes.insert(bytes.end(), state.config.ephemeris_base.begin(),
               state.config.ephemeris_base.end());
  for (const PlannedUnit& unit : state.units) {
    std::string_view core;
    if (!filename_core(unit.filename, &core)) return {};
    append_u16le(&bytes, static_cast<uint16_t>(core.size()));
    append_u32le(&bytes, static_cast<uint32_t>(unit.byte_length));
    append_u32le(&bytes, static_cast<uint32_t>(unit.epoch_count));
    bytes.insert(bytes.end(), unit.digest.begin(), unit.digest.end());
    bytes.insert(bytes.end(), core.begin(), core.end());
  }
  if (bytes.size() != payload_size) return {};
  uint8_t digest[32];
  sha256(bytes.data(), bytes.size(), digest);
  bytes.insert(bytes.end(), digest, digest + sizeof(digest));
  return bytes;
}

bool consume_bytes(const std::vector<uint8_t>& bytes, size_t payload_end,
                   size_t* cursor, size_t length, const uint8_t** output) {
  if (!cursor || length > payload_end || *cursor > payload_end - length) {
    return false;
  }
  if (output) *output = bytes.data() + *cursor;
  *cursor += length;
  return true;
}

bool parse_checkpoint(const std::vector<uint8_t>& bytes, State* state,
                      std::string* error) {
  const auto fail = [&](const char* message) {
    if (error) *error = message;
    return false;
  };
  if (!state || bytes.size() < 153 || bytes.size() > kMaxCheckpointBytes) {
    return fail("opaque Starlink checkpoint violates size bounds");
  }
  const size_t payload_end = bytes.size() - 32;
  uint8_t checksum[32];
  sha256(bytes.data(), payload_end, checksum);
  if (std::memcmp(checksum, bytes.data() + payload_end, 32) != 0) {
    return fail("opaque Starlink checkpoint hash is invalid");
  }
  size_t cursor = 0;
  const uint8_t* value = nullptr;
  if (!consume_bytes(bytes, payload_end, &cursor, 8, &value) ||
      std::memcmp(value, kCheckpointMagic, 8) != 0) {
    return fail("opaque Starlink checkpoint identifier is invalid");
  }
  if (!consume_bytes(bytes, payload_end, &cursor, 2, &value) ||
      read_u16le(value) != kCheckpointVersion) {
    return fail("opaque Starlink checkpoint version is unsupported");
  }
  if (!consume_bytes(bytes, payload_end, &cursor, 2, &value)) {
    return fail("opaque Starlink checkpoint phase is truncated");
  }
  const Phase phase = static_cast<Phase>(value[0]);
  const uint8_t flags = value[1];
  const bool cleanup_pending = (flags & 1) != 0;
  if ((phase != Phase::kDownloading && phase != Phase::kDraining) ||
      (flags & ~static_cast<uint8_t>(1)) != 0) {
    return fail("opaque Starlink checkpoint phase is invalid");
  }
  if (!consume_bytes(bytes, payload_end, &cursor, 4, &value)) return fail("checkpoint unit count is truncated");
  const uint32_t unit_count = read_u32le(value);
  if (!consume_bytes(bytes, payload_end, &cursor, 4, &value)) return fail("checkpoint download cursor is truncated");
  const uint32_t downloaded_count = read_u32le(value);
  if (!consume_bytes(bytes, payload_end, &cursor, 4, &value)) return fail("checkpoint drain cursor is truncated");
  const uint32_t drain_index = read_u32le(value);
  if (!consume_bytes(bytes, payload_end, &cursor, 8, &value)) return fail("checkpoint byte count is truncated");
  const uint64_t downloaded_bytes = read_u64le(value);
  if (!consume_bytes(bytes, payload_end, &cursor, 4, &value)) return fail("checkpoint object cap is truncated");
  const uint32_t object_cap = read_u32le(value);
  if (!consume_bytes(bytes, payload_end, &cursor, 2, &value)) return fail("checkpoint concurrency is truncated");
  const uint16_t fetch_concurrency = read_u16le(value);
  if (!consume_bytes(bytes, payload_end, &cursor, 2, &value)) return fail("checkpoint batch size is truncated");
  const uint16_t batch_size = read_u16le(value);
  if (!consume_bytes(bytes, payload_end, &cursor, 2, &value)) return fail("checkpoint manifest URL length is truncated");
  const uint16_t manifest_url_length = read_u16le(value);
  if (!consume_bytes(bytes, payload_end, &cursor, 2, &value)) return fail("checkpoint ephemeris URL length is truncated");
  const uint16_t ephemeris_base_length = read_u16le(value);

  if (unit_count == 0 || unit_count > kMaxCatalogUnits ||
      downloaded_count > unit_count || drain_index > unit_count ||
      object_cap > kMaxCatalogUnits ||
      fetch_concurrency == 0 || fetch_concurrency > kMaxFetchConcurrency ||
      batch_size == 0 || batch_size > kMaxFetchConcurrency ||
      manifest_url_length == 0 || manifest_url_length > kMaxEndpointBytes ||
      ephemeris_base_length == 0 ||
      ephemeris_base_length > kMaxEndpointBytes ||
      (phase == Phase::kDownloading &&
       (drain_index != 0 || cleanup_pending)) ||
      (cleanup_pending && drain_index == 0) ||
      (phase == Phase::kDraining && downloaded_count != unit_count)) {
    return fail("opaque Starlink checkpoint header fields are invalid");
  }

  State parsed;
  parsed.phase = phase;
  parsed.downloaded_count = downloaded_count;
  parsed.drain_index = drain_index;
  parsed.downloaded_bytes = downloaded_bytes;
  parsed.cleanup_pending = cleanup_pending;
  parsed.config.object_cap = object_cap;
  parsed.config.fetch_concurrency = fetch_concurrency;
  parsed.config.batch_size = batch_size;
  if (!consume_bytes(bytes, payload_end, &cursor, parsed.generation.size(),
                     &value)) {
    return fail("opaque Starlink checkpoint generation is truncated");
  }
  std::copy(value, value + parsed.generation.size(), parsed.generation.begin());
  if (all_zero(parsed.generation)) {
    return fail("opaque Starlink checkpoint generation is invalid");
  }
  if (!consume_bytes(bytes, payload_end, &cursor, manifest_url_length,
                     &value)) {
    return fail("opaque Starlink checkpoint manifest URL is truncated");
  }
  parsed.config.manifest_url.assign(
      reinterpret_cast<const char*>(value), manifest_url_length);
  if (!consume_bytes(bytes, payload_end, &cursor, ephemeris_base_length,
                     &value)) {
    return fail("opaque Starlink checkpoint ephemeris URL is truncated");
  }
  parsed.config.ephemeris_base.assign(
      reinterpret_cast<const char*>(value), ephemeris_base_length);
  parsed.units.reserve(unit_count);
  std::unordered_set<std::string> identities;
  identities.reserve(unit_count);
  uint64_t observed_bytes = 0;
  for (uint32_t index = 0; index < unit_count; ++index) {
    if (!consume_bytes(bytes, payload_end, &cursor, 2, &value)) return fail("checkpoint filename core length is truncated");
    const uint16_t core_length = read_u16le(value);
    if (!consume_bytes(bytes, payload_end, &cursor, 4, &value)) return fail("checkpoint object size is truncated");
    const uint32_t byte_length = read_u32le(value);
    if (!consume_bytes(bytes, payload_end, &cursor, 4, &value)) return fail("checkpoint epoch count is truncated");
    const uint32_t epoch_count = read_u32le(value);
    PlannedUnit unit;
    unit.byte_length = byte_length;
    unit.epoch_count = epoch_count;
    if (!consume_bytes(bytes, payload_end, &cursor, unit.digest.size(),
                       &value)) {
      return fail("checkpoint object hash is truncated");
    }
    std::copy(value, value + unit.digest.size(), unit.digest.begin());
    constexpr std::string_view prefix = "MEME_";
    constexpr std::string_view suffix = "_UNCLASSIFIED.txt";
    if (core_length == 0 ||
        core_length > kMaxFilenameBytes - prefix.size() - suffix.size() ||
        !consume_bytes(bytes, payload_end, &cursor, core_length, &value)) {
      return fail("opaque Starlink checkpoint filename core is invalid");
    }
    const std::string_view core(reinterpret_cast<const char*>(value),
                                core_length);
    if (core.find('/') != std::string_view::npos ||
        core.find('\\') != std::string_view::npos) {
      return fail("opaque Starlink checkpoint filename core is invalid");
    }
    unit.filename.reserve(prefix.size() + core.size() + suffix.size());
    unit.filename.append(prefix);
    unit.filename.append(core);
    unit.filename.append(suffix);
    unit.identity = meme_identity(unit.filename);
    uint64_t filename_generation = 0;
    if (unit.identity.empty() ||
        !meme_generation(unit.filename, &filename_generation) ||
        !identities.insert(unit.identity).second) {
      return fail("opaque Starlink checkpoint object identity is invalid");
    }
    unit.url = join_url(parsed.config.ephemeris_base, unit.filename);
    if (index < downloaded_count) {
      const uint32_t expected_chunks = expected_chunk_count(byte_length);
      if (byte_length == 0 || byte_length > kMaxStarlinkFileBytes ||
          expected_chunks == 0 || epoch_count == 0 ||
          all_zero(unit.digest) ||
          !add_without_overflow(observed_bytes, byte_length, &observed_bytes)) {
        return fail("opaque Starlink checkpoint object layout is invalid");
      }
      unit.chunk_count = expected_chunks;
    } else if (byte_length != 0 || epoch_count != 0 || !all_zero(unit.digest)) {
      return fail("opaque Starlink checkpoint contains uncommitted object metadata");
    }
    parsed.units.push_back(std::move(unit));
  }
  if (cursor != payload_end || observed_bytes != downloaded_bytes) {
    return fail("opaque Starlink checkpoint totals are invalid");
  }
  parsed.active = true;
  *state = std::move(parsed);
  return true;
}

bool persist_checkpoint(std::string* error_message = nullptr) {
  if (error_message) error_message->clear();
  const std::vector<uint8_t> checkpoint = encode_checkpoint(g_state);
  return !checkpoint.empty() &&
         replace_opaque_value(kCheckpointNamespace, kCheckpointKey,
                              checkpoint, error_message) &&
         sync_opaque_state(kCheckpointNamespace, error_message);
}

enum class CheckpointLoadResult {
  kNotFound,
  kLoaded,
  kError,
};

CheckpointLoadResult load_checkpoint(std::string* error) {
  std::vector<uint8_t> bytes;
  bool found = false;
  std::string host_error;
  if (!read_opaque_value(kCheckpointNamespace, kCheckpointKey,
                         kMaxCheckpointBytes, &bytes, &found, &host_error)) {
    set_storage_error(error, "opaque Starlink checkpoint read failed",
                      host_error);
    return CheckpointLoadResult::kError;
  }
  if (!found) return CheckpointLoadResult::kNotFound;
  State loaded;
  if (!parse_checkpoint(bytes, &loaded, error)) {
    return CheckpointLoadResult::kError;
  }
  if (!sync_opaque_state(kCheckpointNamespace, &host_error)) {
    set_storage_error(error, "opaque Starlink checkpoint reload sync failed",
                      host_error);
    return CheckpointLoadResult::kError;
  }
  g_state = std::move(loaded);
  return CheckpointLoadResult::kLoaded;
}

bool emit_single_fsb(std::string_view port, const std::vector<uint8_t>& bytes,
                     std::string_view native_schema,
                     std::string_view native_identifier,
                     uint64_t record_count) {
  if (bytes.empty() || bytes.size() > kFsbDataCapacity ||
      (g_aligned_output_requested &&
       (native_schema.size() > 64 || native_identifier.size() > 4))) {
    return false;
  }
  uint8_t digest[32];
  sha256(bytes.data(), bytes.size(), digest);
  const uint64_t request_id = ++g_next_request_id;
  int32_t pushed = -1;
  if (g_aligned_output_requested) {
    std::memset(&g_aligned_output, 0, sizeof(g_aligned_output));
    g_aligned_output.REQUEST_ID = request_id;
    g_aligned_output.KIND = flatSqlByteStreamKind_RECORD_STREAM;
    g_aligned_output.CHUNK_SEQUENCE = 0;
    g_aligned_output.FINAL = true;
    g_aligned_output.TOTAL_BYTES = bytes.size();
    g_aligned_output.RECORD_COUNT = record_count;
    g_aligned_output.SCHEMA_NAME.set(std::string(native_schema));
    g_aligned_output.set_has_SCHEMA_NAME(true);
    g_aligned_output.FILE_IDENTIFIER.set(std::string(native_identifier));
    g_aligned_output.set_has_FILE_IDENTIFIER(true);
    g_aligned_output.DATA.set_length(static_cast<uint32_t>(bytes.size()));
    std::memcpy(g_aligned_output.DATA.values, bytes.data(), bytes.size());
    g_aligned_output.set_has_DATA(true);
    g_aligned_output.SHA256.set_length(sizeof(digest));
    std::memcpy(g_aligned_output.SHA256.values, digest, sizeof(digest));
    g_aligned_output.set_has_SHA256(true);
    pushed = plugin_push_output_typed(
        port.data(), kFsbSchemaName, kFsbFileIdentifier,
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, kFsbRootType, 0,
        kFsbAlignedSize, kFsbAlignment,
        reinterpret_cast<const uint8_t*>(&g_aligned_output), kFsbAlignedSize);
  } else {
    flatbuffers::FlatBufferBuilder builder(bytes.size() + 512);
    const auto schema_name =
        builder.CreateString(native_schema.data(), native_schema.size());
    const auto file_identifier = builder.CreateString(
        native_identifier.data(), native_identifier.size());
    const auto data = builder.CreateVector(bytes);
    const auto hash = builder.CreateVector(digest, sizeof(digest));
    FSBBuilder stream(builder);
    stream.add_REQUEST_ID(request_id);
    stream.add_KIND(flatSqlByteStreamKind_RECORD_STREAM);
    stream.add_CHUNK_SEQUENCE(0);
    stream.add_FINAL(true);
    stream.add_TOTAL_BYTES(bytes.size());
    stream.add_RECORD_COUNT(record_count);
    stream.add_SCHEMA_NAME(schema_name);
    stream.add_FILE_IDENTIFIER(file_identifier);
    stream.add_DATA(data);
    stream.add_SHA256(hash);
    const auto root = stream.Finish();
    FinishFSBBuffer(builder, root);
    pushed = plugin_push_output_typed(
        port.data(), kFsbSchemaName, kFsbFileIdentifier,
        PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, kFsbRootType, 0, 0, 0,
        builder.GetBufferPointer(), static_cast<uint32_t>(builder.GetSize()));
  }
  return pushed >= 0;
}

bool emit_progress() {
  flatbuffers::FlatBufferBuilder builder(512);
  DSSBuilder progress(builder);
  progress.add_STATUS(g_state.downloaded_count == g_state.units.size()
                          ? dssSyncState_SYNCED
                          : dssSyncState_SYNCING);
  progress.add_SYNCED_ROWS(g_state.downloaded_count);
  progress.add_TOTAL_ROWS(g_state.units.size());
  progress.add_LOCAL_ROWS(g_state.downloaded_count);
  progress.add_MISSING_ROWS(g_state.units.size() - g_state.downloaded_count);
  progress.add_CACHED_BYTES(g_state.downloaded_bytes);
  progress.add_DOWNLOADED_BYTES(g_state.downloaded_bytes);
  const auto root = progress.Finish();
  FinishSizePrefixedDSSBuffer(builder, root);
  const std::vector<uint8_t> canonical(
      builder.GetBufferPointer(),
      builder.GetBufferPointer() + builder.GetSize());
  return emit_single_fsb("progress", canonical, "DSS.fbs", "$DSS", 1);
}

void reset_state() {
  g_state = State{};
  g_pending_wave.clear();
  g_pending_wave_begin = 0;
  g_probe_carry = ProbeCarry{};
  g_emitted_transient = false;
  g_progress_emitted_transient = false;
  g_trusted_emission_epoch_count = 0;
}

uint32_t work_remaining() {
  uint64_t remaining = 0;
  if (g_state.phase == Phase::kDownloading) {
    remaining = static_cast<uint64_t>(g_state.units.size() -
                                      g_state.downloaded_count) +
                g_state.units.size() + 1;
  } else {
    remaining = static_cast<uint64_t>(g_state.units.size() -
                                      g_state.drain_index) +
                1;
    if (g_emitted_transient && remaining > 0) --remaining;
  }
  return static_cast<uint32_t>(std::min<uint64_t>(
      remaining, std::numeric_limits<uint32_t>::max()));
}

bool begin_catalog(const Config& config, std::string* error) {
  if (config.manifest_url.empty() || config.ephemeris_base.empty() ||
      config.manifest_url.size() > kMaxEndpointBytes ||
      config.ephemeris_base.size() > kMaxEndpointBytes) {
    if (error) *error = "Starlink endpoint configuration violates bounds";
    return false;
  }
  const RawHttpResult manifest =
      http_request(config.manifest_url, kMaxManifestBytes, false);
  if (manifest.status != 200 || manifest.body.empty() ||
      manifest.body.size() > kMaxManifestBytes) {
    if (error) *error = "unable to fetch the complete Starlink manifest";
    return false;
  }
  bool exceeded_limit = false;
  std::vector<PlannedUnit> units =
      plan_units(manifest.body, config, &exceeded_limit);
  if (exceeded_limit || units.empty()) {
    if (error) {
      *error = exceeded_limit
                   ? "Starlink manifest exceeds the signed object bound"
                   : "Starlink manifest contained no fetch units";
    }
    return false;
  }

  std::vector<uint8_t> generation_material = manifest.body;
  generation_material.insert(generation_material.end(),
                             config.ephemeris_base.begin(),
                             config.ephemeris_base.end());
  uint8_t generation[32];
  sha256(generation_material.data(), generation_material.size(), generation);

  g_state = State{};
  g_state.config = config;
  g_state.units = std::move(units);
  g_probe_carry = ProbeCarry{};
  std::copy(generation, generation + sizeof(generation),
            g_state.generation.begin());
  if (encode_checkpoint(g_state).empty()) {
    g_state = State{};
    if (error) {
      *error = "Starlink catalog cannot fit the signed checkpoint bound";
    }
    return false;
  }
  g_state.active = true;
  g_emitted_transient = false;
  g_progress_emitted_transient = false;
  std::string host_error;
  if (!persist_checkpoint(&host_error)) {
    g_state = State{};
    set_storage_error(
        error, "opaque Starlink zero-download checkpoint commit failed",
        host_error);
    return false;
  }
  return true;
}

bool stage_download_page(
    size_t begin,
    const std::vector<ValidatedDownload>& responses,
    size_t response_offset,
    size_t response_count,
    bool sync_wave_chunks,
    std::string* error) {
  if (response_count == 0 ||
      response_count > kMaxDurableFilesPerInvocation ||
      response_offset > responses.size() ||
      response_count > responses.size() - response_offset ||
      begin != g_state.downloaded_count ||
      begin > g_state.units.size() ||
      response_count > g_state.units.size() - begin) {
    if (error) *error = "Starlink durable slice bounds are invalid";
    return false;
  }
  uint64_t page_bytes = 0;
  for (size_t local = 0; local < response_count; ++local) {
    const ValidatedDownload& download = responses[response_offset + local];
    const provider_node::HttpResult& response = download.response;
    const DownloadMetadata& metadata = download.metadata;
    if (!metadata.valid || response.status != 200 || response.body.empty() ||
        response.body.size() > kMaxStarlinkFileBytes ||
        metadata.byte_length != response.body.size() ||
        metadata.epoch_count == 0) {
      if (error) *error = "Starlink worker metadata is invalid";
      return false;
    }
    if (metadata.byte_length > kMaxRetainedWaveBytes ||
        page_bytes > kMaxRetainedWaveBytes - metadata.byte_length ||
        !add_without_overflow(page_bytes, metadata.byte_length, &page_bytes)) {
      if (error) *error = "Starlink page byte count overflowed";
      return false;
    }
  }
  if (response_count > 1 && page_bytes > kMaxDurableBytesPerInvocation) {
    if (error) *error = "Starlink durable slice exceeds its byte bound";
    return false;
  }

  for (size_t local = 0; local < response_count; ++local) {
    const ValidatedDownload& download = responses[response_offset + local];
    const provider_node::HttpResult& response = download.response;
    const DownloadMetadata& metadata = download.metadata;
    PlannedUnit& unit = g_state.units[begin + local];
    unit.byte_length = metadata.byte_length;
    unit.chunk_count = static_cast<uint32_t>(
        (metadata.byte_length + kOpaqueChunkBytes - 1) / kOpaqueChunkBytes);
    unit.epoch_count = metadata.epoch_count;
    unit.digest = metadata.digest;
    for (uint32_t chunk = 0; chunk < unit.chunk_count; ++chunk) {
      const size_t offset = static_cast<size_t>(chunk) * kOpaqueChunkBytes;
      const size_t length =
          std::min(kOpaqueChunkBytes, response.body.size() - offset);
      std::vector<uint8_t> stored;
      if (!encode_opaque_chunk(response.body.data() + offset, length,
                               &stored)) {
        if (error) *error = "opaque Starlink chunk encoding failed";
        return false;
      }
      std::string host_error;
      if (!replace_opaque_bytes(
              chunk_namespace(g_state,
                              static_cast<uint32_t>(begin + local)),
              chunk_key(g_state, static_cast<uint32_t>(begin + local), chunk),
              stored.data(), stored.size(), &host_error)) {
        set_storage_error(error, "opaque Starlink chunk write failed",
                          host_error);
        return false;
      }
    }
  }
  if (sync_wave_chunks) {
    const size_t wave_end = begin + response_count;
    if (g_pending_wave_begin > begin || wave_end > g_state.units.size()) {
      if (error) *error = "opaque Starlink wave scope bounds are invalid";
      return false;
    }
    for (size_t index = g_pending_wave_begin; index < wave_end; ++index) {
      std::string host_error;
      if (!sync_opaque_state(chunk_namespace(
              g_state, static_cast<uint32_t>(index)), &host_error)) {
        set_storage_error(error, "opaque Starlink wave chunk sync failed",
                          host_error);
        return false;
      }
    }
  }
  uint64_t next_bytes = 0;
  if (!add_without_overflow(g_state.downloaded_bytes, page_bytes, &next_bytes)) {
    if (error) *error = "Starlink catalog byte count overflowed";
    return false;
  }
  g_state.downloaded_bytes = next_bytes;
  g_state.downloaded_count = static_cast<uint32_t>(begin + response_count);
  return true;
}

bool delete_unit_chunks(uint32_t unit_index, std::string* error) {
  if (unit_index >= g_state.units.size()) {
    if (error) *error = "Starlink cleanup cursor is out of bounds";
    return false;
  }
  const PlannedUnit& unit = g_state.units[unit_index];
  for (uint32_t chunk = 0; chunk < unit.chunk_count; ++chunk) {
    std::string host_error;
    if (!delete_opaque_value(chunk_namespace(g_state, unit_index),
                             chunk_key(g_state, unit_index, chunk),
                             &host_error)) {
      set_storage_error(error, "opaque Starlink chunk cleanup failed",
                        host_error);
      return false;
    }
  }
  std::string host_error;
  if (!sync_opaque_state(chunk_namespace(g_state, unit_index), &host_error)) {
    set_storage_error(error, "opaque Starlink cleanup sync failed",
                      host_error);
    return false;
  }
  return true;
}

bool read_unit_body(uint32_t unit_index, std::vector<uint8_t>* body,
                    std::string* error) {
  if (!body || unit_index >= g_state.units.size()) {
    if (error) *error = "Starlink drain cursor is out of bounds";
    return false;
  }
  const PlannedUnit& unit = g_state.units[unit_index];
  if (unit.byte_length == 0 ||
      unit.byte_length > kMaxStarlinkFileBytes ||
      unit.byte_length > std::numeric_limits<size_t>::max()) {
    if (error) *error = "Starlink cached object size is invalid";
    return false;
  }
  body->clear();
  body->reserve(static_cast<size_t>(unit.byte_length));
  for (uint32_t chunk = 0; chunk < unit.chunk_count; ++chunk) {
    std::vector<uint8_t> bytes;
    bool found = false;
    std::string host_error;
    const size_t expected = static_cast<size_t>(std::min<uint64_t>(
        kOpaqueChunkBytes, unit.byte_length - body->size()));
    if (!read_opaque_value(chunk_namespace(g_state, unit_index),
                           chunk_key(g_state, unit_index, chunk),
                           kOpaqueChunkBytes, &bytes, &found, &host_error) ||
        !found) {
      set_storage_error(error,
                        "opaque Starlink object is missing or truncated",
                        host_error);
      return false;
    }
    const size_t output_offset = body->size();
    body->resize(output_offset + expected);
    if (!decode_opaque_chunk(bytes, expected,
                             body->data() + output_offset)) {
      body->resize(output_offset);
      if (error) *error = "opaque Starlink object chunk is invalid";
      return false;
    }
  }
  if (body->size() != unit.byte_length) {
    if (error) *error = "opaque Starlink object length is invalid";
    return false;
  }
  uint8_t digest[32];
  sha256(body->data(), body->size(), digest);
  if (std::memcmp(digest, unit.digest.data(), sizeof(digest)) != 0) {
    if (error) *error = "opaque Starlink object hash is invalid";
    return false;
  }
  return true;
}

int fail_invocation(const char* code, const std::string& message,
                    int status_code) {
  reset_state();
  plugin_set_error(code, message.c_str());
  return status_code;
}

int run_drain_phase();

int commit_pending_downloads() {
  const size_t begin = g_state.downloaded_count;
  const size_t wave_begin = g_pending_wave_begin;
  if (g_pending_wave.empty() ||
      wave_begin > g_state.units.size() ||
      g_pending_wave.size() > g_state.units.size() - wave_begin ||
      begin < wave_begin ||
      begin - wave_begin > g_pending_wave.size()) {
    return fail_invocation(
        "checkpoint-invalid",
        "Starlink retained download wave does not match its durable cursor",
        422);
  }
  const size_t response_offset = begin - wave_begin;
  bool wave_complete = response_offset == g_pending_wave.size();
  if (!wave_complete) {
    size_t count = 0;
    uint64_t slice_bytes = 0;
    while (count < kMaxDurableFilesPerInvocation &&
           response_offset + count < g_pending_wave.size()) {
      const size_t body_bytes =
          g_pending_wave[response_offset + count].metadata.byte_length;
      if (count > 0 &&
          (body_bytes > kMaxDurableBytesPerInvocation ||
           slice_bytes > kMaxDurableBytesPerInvocation - body_bytes)) {
        break;
      }
      if (!add_without_overflow(slice_bytes, body_bytes, &slice_bytes)) {
        return fail_invocation(
            "spool-write", "Starlink durable slice byte count overflowed",
            503);
      }
      ++count;
    }

    std::string error;
    wave_complete = response_offset + count == g_pending_wave.size();
    if (!stage_download_page(begin, g_pending_wave, response_offset, count,
                             wave_complete, &error)) {
      return fail_invocation("spool-write", error, 503);
    }
  }
  if (!wave_complete) {
    plugin_set_backlog_remaining(work_remaining());
    plugin_set_yielded(1);
    return 0;
  }
  std::string host_error;
  if (!persist_checkpoint(&host_error)) {
    std::string error;
    set_storage_error(&error,
                      "opaque Starlink wave checkpoint commit failed",
                      host_error);
    return fail_invocation("checkpoint-write", error, 503);
  }
  g_pending_wave.clear();
  g_pending_wave_begin = 0;
  if (!emit_progress()) {
    return fail_invocation("progress-output",
                           "unable to emit Starlink progress snapshot", 500);
  }
  g_progress_emitted_transient = true;
  plugin_set_backlog_remaining(work_remaining());
  plugin_set_yielded(1);
  return 0;
}

int run_download_phase() {
  const size_t begin = g_state.downloaded_count;
  if (begin > 0 && g_pending_wave.empty() &&
      !g_progress_emitted_transient) {
    if (!emit_progress()) {
      return fail_invocation(
          "progress-output", "unable to replay Starlink progress snapshot",
          500);
    }
    g_progress_emitted_transient = true;
    plugin_set_backlog_remaining(work_remaining());
    plugin_set_yielded(1);
    return 0;
  }
  if (g_progress_emitted_transient) {
    g_progress_emitted_transient = false;
  }
  if (!g_pending_wave.empty()) return commit_pending_downloads();
  if (begin == g_state.units.size()) {
    g_probe_carry = ProbeCarry{};
    g_state.phase = Phase::kDraining;
    std::string host_error;
    if (!persist_checkpoint(&host_error)) {
      std::string error;
      set_storage_error(
          &error, "opaque Starlink drain-transition checkpoint failed",
          host_error);
      return fail_invocation("checkpoint-write", error, 503);
    }
    return run_drain_phase();
  }
  const size_t candidate_end = std::min(
      g_state.units.size(),
      begin + static_cast<size_t>(g_state.config.batch_size));
  if (begin >= candidate_end) {
    return fail_invocation("checkpoint-invalid",
                           "Starlink download cursor cannot advance", 422);
  }
  const std::vector<ProbeResult>* carried_probes = nullptr;
  if (!g_probe_carry.probes.empty()) {
    if (g_probe_carry.begin == begin) {
      carried_probes = &g_probe_carry.probes;
    } else {
      g_probe_carry = ProbeCarry{};
    }
  }
  DownloadPage page = download_complete_page(
      g_state.units, begin, candidate_end, g_state.config.fetch_concurrency,
      carried_probes);
  if (!page.synchronization_valid) {
    return fail_invocation(
        "thread-sync", "Starlink page-scoped download cohort failed", 503);
  }
  if (!page.probes_valid) {
    return fail_invocation(
        "size-probe", "Starlink complete-file size preflight failed", 502);
  }
  if (page.responses.empty()) {
    return fail_invocation(
        "memory-bound", "Starlink retained download wave cannot fit", 413);
  }
  if (!page.responses_valid) {
    return fail_invocation(
        "ephemeris-validate",
        "a complete Starlink ephemeris response is not valid MEME", 502);
  }
  g_probe_carry.begin = page.next_probe_begin;
  g_probe_carry.probes = std::move(page.carried_probes);
  g_pending_wave_begin = static_cast<uint32_t>(begin);
  g_pending_wave = std::move(page.responses);
  return commit_pending_downloads();
}

int run_drain_phase() {
  std::string error;
  if (g_emitted_transient) {
    if (g_state.cleanup_pending ||
        g_state.drain_index >= g_state.units.size()) {
      return fail_invocation(
          "checkpoint-invalid", "Starlink transient drain state is invalid",
          422);
    }
    ++g_state.drain_index;
    g_state.cleanup_pending = true;
    std::string host_error;
    if (!persist_checkpoint(&host_error)) {
      set_storage_error(
          &error, "opaque Starlink cleanup-pending checkpoint failed",
          host_error);
      return fail_invocation("checkpoint-write", error, 503);
    }
    g_emitted_transient = false;
  }

  if (g_state.cleanup_pending) {
    if (g_state.drain_index == 0 ||
        !delete_unit_chunks(g_state.drain_index - 1, &error)) {
      return fail_invocation("spool-cleanup", error, 503);
    }
    // The cleanup-pending checkpoint already durably advances the acknowledged
    // output cursor. Chunk deletion is idempotent, so retaining that durable
    // flag until the next cursor checkpoint makes a crash repeat only cleanup
    // instead of requiring a second full checkpoint transaction per object.
    g_state.cleanup_pending = false;
  }

  if (g_state.drain_index == g_state.units.size()) {
    std::string host_error;
    if (!delete_opaque_value(kCheckpointNamespace, kCheckpointKey,
                             &host_error) ||
        !sync_opaque_state(kCheckpointNamespace, &host_error)) {
      set_storage_error(&error, "opaque Starlink checkpoint cleanup failed",
                        host_error);
      return fail_invocation("spool-cleanup", error, 503);
    }
    reset_state();
    plugin_set_backlog_remaining(0);
    plugin_set_yielded(0);
    return 0;
  }

  const uint32_t unit_index = g_state.drain_index;
  std::vector<uint8_t> body;
  if (!read_unit_body(unit_index, &body, &error)) {
    return fail_invocation("spool-corrupt", error, 422);
  }
  const PlannedUnit& unit = g_state.units[unit_index];
  const uint32_t response_frames = output_frame_count(body.size());
  if (response_frames == 0 ||
      response_frames > kMaxOutputFramesPerInvocation) {
    return fail_invocation(
        "output-bound", "one Starlink response exceeds the signed frame bound",
        413);
  }
  g_trusted_emission_epoch_count = unit.epoch_count;
  const int emitted = emit_complete_response(
      body, unit.identity, "MEME", trusted_meme_epoch_count,
      unit.digest.data());
  g_trusted_emission_epoch_count = 0;
  if (emitted < 0 || static_cast<uint32_t>(emitted) != response_frames) {
    return fail_invocation(
        "output-failed", "unable to emit a bounded Starlink FSB chunk", 500);
  }

  // The host serializes/routes guest output only after this handler returns.
  // Keep the durable cursor on this file and advance it on the next invocation,
  // whose existence proves that the prior response crossed that boundary.
  g_emitted_transient = true;
  plugin_set_backlog_remaining(work_remaining());
  plugin_set_yielded(1);
  return 0;
}

}  // namespace

extern "C" int emit(void) {
  plugin_reset_output_state();
  const bool config_present = plugin_find_input_index("config", 0) >= 0;
  std::string config_json;
  if (!provider_node::read_config_json(&config_json)) {
    reset_state();
    plugin_set_error("invalid-config",
                     "config must be a valid canonical or aligned FSB");
    return 400;
  }

  if (!g_state.active) {
    std::string error;
    const CheckpointLoadResult loaded = load_checkpoint(&error);
    if (loaded == CheckpointLoadResult::kError) {
      return fail_invocation("checkpoint-read", error, 503);
    }
    if (loaded == CheckpointLoadResult::kNotFound) {
      if (!config_present) {
        plugin_set_backlog_remaining(0);
        plugin_set_yielded(0);
        return 0;
      }
      if (!begin_catalog(parse_config(config_json), &error)) {
        return fail_invocation("manifest-fetch", error, 502);
      }
      if (g_state.units.size() > kManifestPlanYieldThreshold) {
        plugin_set_backlog_remaining(work_remaining());
        plugin_set_yielded(1);
        return 0;
      }
    }
  }

  if (g_state.phase == Phase::kDownloading) return run_download_phase();
  if (g_state.phase == Phase::kDraining) return run_drain_phase();
  return fail_invocation("checkpoint-invalid",
                         "Starlink checkpoint phase is invalid", 422);
}
