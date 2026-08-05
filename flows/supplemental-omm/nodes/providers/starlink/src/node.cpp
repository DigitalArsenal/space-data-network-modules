#include <array>
#include <atomic>
#include <iterator>
#include <limits>
#include <pthread.h>
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
constexpr int64_t kThreadPollParkNanoseconds = 1'000'000ll;
// Read the first two MiB of 64 files in parallel and admit as many complete
// bodies as fit the signed per-activation byte ceiling. Every admitted body is
// validated, emitted to OD in this invocation, and released on return.
constexpr size_t kInitialRangeBytes = 2 * 1024 * 1024;
constexpr size_t kMaxStarlinkFileBytes = 64 * 1024 * 1024;
constexpr uint64_t kMaxFetchWaveBytesPerInvocation =
    128ull * 1024 * 1024;
constexpr uint64_t kMaxRetainedWaveBytes = 288ull * 1024 * 1024;
constexpr uint32_t kMaxStreamingOutputFramesPerInvocation = 256;
constexpr uint32_t kMaxAcknowledgementFramesPerInvocation = 64;
constexpr uint64_t kReservedTransientBytes = 384ull * 1024 * 1024;
constexpr uint64_t kWasmMemoryCeilingBytes = 1024ull * 1024 * 1024;
constexpr size_t kMaxManifestBytes = 8 * 1024 * 1024;
static_assert(kMaxStarlinkFileBytes <= kMaxRetainedWaveBytes);
static_assert(kMaxFetchWaveBytesPerInvocation <= kMaxRetainedWaveBytes);
static_assert(kInitialRangeBytes * kMaxFetchConcurrency +
                  kMaxFetchWaveBytesPerInvocation <=
              kMaxRetainedWaveBytes);
static_assert(2 * kMaxRetainedWaveBytes + kReservedTransientBytes <
              kWasmMemoryCeilingBytes);

constexpr const char* kCheckpointNamespace = "primary";
constexpr const char* kCheckpointKey = "starlink.cursor.v1";
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
constexpr uint8_t kCheckpointMagic[8] = {'S', 'L', 'C', 'U', 'R', 'S', '0', '1'};
constexpr uint16_t kCheckpointVersion = 1;
constexpr std::string_view kPlanIdentityDomain =
    "supplemental-omm.starlink-plan.v1";
constexpr std::string_view kRunIdentityDomain =
    "supplemental-omm.starlink-run.v1";
constexpr std::string_view kSourceIdentityDomain =
    "supplemental-omm.starlink-source.v1";

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
};

struct State {
  Config config;
  std::vector<PlannedUnit> units;
  std::array<uint8_t, 32> manifest_hash{};
  std::array<uint8_t, 32> plan_identity{};
  std::array<uint8_t, 32> run_id{};
  uint32_t acknowledged_count = 0;
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

struct InflightUnit {
  uint32_t unit_index = 0;
  uint64_t request_id = 0;
  bool acknowledged = false;
};

State g_state;
std::vector<InflightUnit> g_inflight;
bool g_plan_verified = false;
bool g_plan_yield_pending = false;
uint64_t g_session_downloaded_bytes = 0;
uint64_t g_trusted_emission_epoch_count = 0;
alignas(4) int32_t g_thread_poll_sentinel = 0;

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
  std::vector<uint8_t> body;
  bool complete = false;
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
  constexpr int32_t kAtomicWaitTimedOut = 2;
  return g_thread_poll_sentinel == 0 &&
         __builtin_wasm_memory_atomic_wait32(
             &g_thread_poll_sentinel, 0, kThreadPollParkNanoseconds) ==
             kAtomicWaitTimedOut &&
         g_thread_poll_sentinel == 0;
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
                           bool initial_range) {
  RawHttpResult result;
  if (max_body_bytes == 0 || max_body_bytes > kMaxResponseBytes) return result;
  const std::string params =
      "{\"method\":\"GET\",\"url\":\"" + json_escape(url) +
      "\",\"responseType\":\"bytes\"" +
      (initial_range
           ? ",\"headers\":{\"Range\":\"bytes=0-" +
                 std::to_string(kInitialRangeBytes - 1) + "\"}"
           : "") +
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

bool parse_range_uint64(std::string_view value, size_t begin, size_t end,
                        uint64_t* parsed) {
  if (!parsed || begin >= end || end > value.size()) return false;
  uint64_t number = 0;
  for (size_t index = begin; index < end; ++index) {
    const char digit = value[index];
    if (digit < '0' || digit > '9' ||
        number > (std::numeric_limits<uint64_t>::max() -
                  static_cast<uint64_t>(digit - '0')) /
                     10) {
      return false;
    }
    number = number * 10 + static_cast<uint64_t>(digit - '0');
  }
  *parsed = number;
  return true;
}

bool parse_content_range(std::string_view value, uint64_t* start,
                         uint64_t* end, uint64_t* total) {
  constexpr std::string_view prefix = "bytes ";
  if (!start || !end || !total || value.rfind(prefix, 0) != 0) return false;
  const size_t dash = value.find('-', prefix.size());
  const size_t slash =
      dash == std::string_view::npos ? dash : value.find('/', dash + 1);
  return dash != std::string_view::npos &&
         slash != std::string_view::npos &&
         parse_range_uint64(value, prefix.size(), dash, start) &&
         parse_range_uint64(value, dash + 1, slash, end) &&
         parse_range_uint64(value, slash + 1, value.size(), total);
}

ProbeResult probe_complete_size(std::string_view url) {
  RawHttpResult raw = http_request(url, kInitialRangeBytes, true);
  ProbeResult result;
  if (raw.status != 206 || raw.body.empty()) return result;
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
  uint64_t start = 0;
  uint64_t end = 0;
  uint64_t total = 0;
  if (!parse_content_range(content_range, &start, &end, &total) ||
      start != 0 || total == 0 || total > kMaxStarlinkFileBytes ||
      end >= total ||
      end + 1 != std::min<uint64_t>(total, kInitialRangeBytes) ||
      raw.body.size() != end - start + 1) {
    return result;
  }
  result.complete = end + 1 == total;
  if (result.complete) result.body = std::move(raw.body);
  result.byte_length = total;
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
    ProbeResult probe = probe_complete_size((*context->units)[index].url);

    (*context->probes)[local] = std::move(probe);
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
    ProbeResult& probe = (*context->probes)[local];
    if (probe.complete) {
      download.response.status = 200;
      download.response.body = std::move(probe.body);
    } else {
      download.response = http_get_complete(
          (*context->units)[index].url,
          static_cast<size_t>(probe.byte_length));
    }
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
    std::vector<ProbeResult>* carried_probes) {
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
    for (size_t index = 0; index < carried_count; ++index) {
      probes[index] = std::move((*carried_probes)[index]);
    }
    carried_probes->clear();
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
    page.carried_probes.assign(
        std::make_move_iterator(probes.begin() + context.admitted_count),
        std::make_move_iterator(probes.end()));
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
  size_t digit_ordinal = 0;
  size_t first_nonzero_ordinal = std::numeric_limits<size_t>::max();
  size_t integer_digits = 0;
  while (cursor < token.size() && token[cursor] >= '0' &&
         token[cursor] <= '9') {
    if (first_nonzero_ordinal == std::numeric_limits<size_t>::max() &&
        token[cursor] != '0') {
      first_nonzero_ordinal = digit_ordinal;
    }
    ++cursor;
    ++digit_ordinal;
    ++integer_digits;
  }
  size_t fractional_digits = 0;
  if (cursor < token.size() && token[cursor] == '.') {
    ++cursor;
    while (cursor < token.size() && token[cursor] >= '0' &&
           token[cursor] <= '9') {
      if (first_nonzero_ordinal == std::numeric_limits<size_t>::max() &&
          token[cursor] != '0') {
        first_nonzero_ordinal = digit_ordinal;
      }
      ++cursor;
      ++digit_ordinal;
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

  const size_t significand_begin =
      token.front() == '+' || token.front() == '-' ? 1 : 0;
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

bool sync_opaque_state(std::string_view namespace_name,
                       std::string* error_message = nullptr) {
  StorageResponse response;
  bool synced = false;
  return call_storage("storage.adapter.opaque.sync",
                      storage_meta(namespace_name, {}), nullptr, &response,
                      error_message) &&
         json_bool(response.meta, "synced", &synced) && synced;
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

void append_identity_component(std::vector<uint8_t>* output,
                               std::string_view value) {
  append_u32le(output, static_cast<uint32_t>(value.size()));
  output->insert(output->end(), value.begin(), value.end());
}

std::array<uint8_t, 32> compute_plan_identity(
    const Config& config,
    const std::vector<PlannedUnit>& units) {
  std::vector<uint8_t> material;
  material.reserve(kPlanIdentityDomain.size() +
                   config.ephemeris_base.size() + units.size() * 64);
  material.insert(material.end(), kPlanIdentityDomain.begin(),
                  kPlanIdentityDomain.end());
  append_identity_component(&material, config.ephemeris_base);
  append_u32le(&material, config.object_cap);
  append_u32le(&material, static_cast<uint32_t>(units.size()));
  for (const PlannedUnit& unit : units) {
    append_identity_component(&material, unit.filename);
  }
  std::array<uint8_t, 32> digest{};
  sha256(material.data(), material.size(), digest.data());
  return digest;
}

std::array<uint8_t, 32> compute_run_id(
    const std::array<uint8_t, 32>& manifest_hash,
    const std::array<uint8_t, 32>& plan_identity) {
  std::vector<uint8_t> material;
  material.reserve(kRunIdentityDomain.size() + 64);
  material.insert(material.end(), kRunIdentityDomain.begin(),
                  kRunIdentityDomain.end());
  material.insert(material.end(), manifest_hash.begin(), manifest_hash.end());
  material.insert(material.end(), plan_identity.begin(), plan_identity.end());
  std::array<uint8_t, 32> digest{};
  sha256(material.data(), material.size(), digest.data());
  return digest;
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
      state.acknowledged_count > state.units.size() ||
      all_zero(state.manifest_hash) || all_zero(state.plan_identity) ||
      all_zero(state.run_id) ||
      compute_plan_identity(state.config, state.units) !=
          state.plan_identity ||
      compute_run_id(state.manifest_hash, state.plan_identity) !=
          state.run_id) {
    return {};
  }

  constexpr size_t fixed_header_bytes = 132;
  constexpr size_t fixed_unit_bytes = 2;
  constexpr size_t checksum_bytes = 32;
  constexpr size_t payload_limit = kMaxCheckpointBytes - checksum_bytes;
  const std::string_view acknowledged_identity =
      state.acknowledged_count == 0
          ? std::string_view{}
          : std::string_view(
                state.units[state.acknowledged_count - 1].identity);
  if (acknowledged_identity.size() > kMaxIdentityBytes) return {};
  size_t payload_size = fixed_header_bytes + state.config.manifest_url.size() +
                        state.config.ephemeris_base.size() +
                        acknowledged_identity.size();
  std::unordered_set<std::string> identities;
  identities.reserve(state.units.size());
  for (const PlannedUnit& unit : state.units) {
    std::string_view core;
    uint64_t generation = 0;
    if (!filename_core(unit.filename, &core) ||
        !meme_generation(unit.filename, &generation) ||
        meme_identity(unit.filename) != unit.identity ||
        join_url(state.config.ephemeris_base, unit.filename) != unit.url ||
        !identities.insert(unit.identity).second ||
        payload_size > payload_limit ||
        fixed_unit_bytes > payload_limit - payload_size ||
        core.size() > payload_limit - payload_size - fixed_unit_bytes) {
      return {};
    }
    payload_size += fixed_unit_bytes + core.size();
  }
  if (payload_size > payload_limit) return {};

  std::vector<uint8_t> bytes;
  bytes.reserve(payload_size + checksum_bytes);
  bytes.insert(bytes.end(), std::begin(kCheckpointMagic),
               std::end(kCheckpointMagic));
  append_u16le(&bytes, kCheckpointVersion);
  append_u16le(&bytes, 0);
  append_u32le(&bytes, static_cast<uint32_t>(state.units.size()));
  append_u32le(&bytes, state.acknowledged_count);
  append_u32le(&bytes, state.config.object_cap);
  append_u16le(&bytes, static_cast<uint16_t>(state.config.fetch_concurrency));
  append_u16le(&bytes, static_cast<uint16_t>(state.config.batch_size));
  append_u16le(
      &bytes, static_cast<uint16_t>(state.config.manifest_url.size()));
  append_u16le(
      &bytes, static_cast<uint16_t>(state.config.ephemeris_base.size()));
  append_u16le(&bytes, static_cast<uint16_t>(acknowledged_identity.size()));
  append_u16le(&bytes, 0);
  bytes.insert(bytes.end(), state.manifest_hash.begin(),
               state.manifest_hash.end());
  bytes.insert(bytes.end(), state.plan_identity.begin(),
               state.plan_identity.end());
  bytes.insert(bytes.end(), state.run_id.begin(), state.run_id.end());
  bytes.insert(bytes.end(), state.config.manifest_url.begin(),
               state.config.manifest_url.end());
  bytes.insert(bytes.end(), state.config.ephemeris_base.begin(),
               state.config.ephemeris_base.end());
  bytes.insert(bytes.end(), acknowledged_identity.begin(),
               acknowledged_identity.end());
  for (const PlannedUnit& unit : state.units) {
    std::string_view core;
    if (!filename_core(unit.filename, &core)) return {};
    append_u16le(&bytes, static_cast<uint16_t>(core.size()));
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
  if (!state || bytes.size() < 166 || bytes.size() > kMaxCheckpointBytes) {
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
  if (!consume_bytes(bytes, payload_end, &cursor, 2, &value) ||
      read_u16le(value) != 0) {
    return fail("opaque Starlink cursor flags are invalid");
  }
  if (!consume_bytes(bytes, payload_end, &cursor, 4, &value)) return fail("checkpoint unit count is truncated");
  const uint32_t unit_count = read_u32le(value);
  if (!consume_bytes(bytes, payload_end, &cursor, 4, &value)) return fail("checkpoint acknowledgement cursor is truncated");
  const uint32_t acknowledged_count = read_u32le(value);
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
  if (!consume_bytes(bytes, payload_end, &cursor, 2, &value)) return fail("checkpoint acknowledged identity length is truncated");
  const uint16_t acknowledged_identity_length = read_u16le(value);
  if (!consume_bytes(bytes, payload_end, &cursor, 2, &value) ||
      read_u16le(value) != 0) {
    return fail("opaque Starlink cursor reserved field is invalid");
  }

  if (unit_count == 0 || unit_count > kMaxCatalogUnits ||
      acknowledged_count > unit_count ||
      object_cap > kMaxCatalogUnits ||
      fetch_concurrency == 0 || fetch_concurrency > kMaxFetchConcurrency ||
      batch_size == 0 || batch_size > kMaxFetchConcurrency ||
      manifest_url_length == 0 || manifest_url_length > kMaxEndpointBytes ||
      ephemeris_base_length == 0 ||
      ephemeris_base_length > kMaxEndpointBytes ||
      acknowledged_identity_length > kMaxIdentityBytes ||
      (acknowledged_count == 0 && acknowledged_identity_length != 0) ||
      (acknowledged_count != 0 && acknowledged_identity_length == 0)) {
    return fail("opaque Starlink checkpoint header fields are invalid");
  }

  State parsed;
  parsed.acknowledged_count = acknowledged_count;
  parsed.config.object_cap = object_cap;
  parsed.config.fetch_concurrency = fetch_concurrency;
  parsed.config.batch_size = batch_size;
  if (!consume_bytes(bytes, payload_end, &cursor,
                     parsed.manifest_hash.size(),
                     &value)) {
    return fail("opaque Starlink cursor manifest hash is truncated");
  }
  std::copy(value, value + parsed.manifest_hash.size(),
            parsed.manifest_hash.begin());
  if (!consume_bytes(bytes, payload_end, &cursor,
                     parsed.plan_identity.size(), &value)) {
    return fail("opaque Starlink cursor plan identity is truncated");
  }
  std::copy(value, value + parsed.plan_identity.size(),
            parsed.plan_identity.begin());
  if (!consume_bytes(bytes, payload_end, &cursor, parsed.run_id.size(),
                     &value)) {
    return fail("opaque Starlink cursor run identifier is truncated");
  }
  std::copy(value, value + parsed.run_id.size(), parsed.run_id.begin());
  if (all_zero(parsed.manifest_hash) || all_zero(parsed.plan_identity) ||
      all_zero(parsed.run_id)) {
    return fail("opaque Starlink cursor identities are invalid");
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
  std::string acknowledged_identity;
  if (!consume_bytes(bytes, payload_end, &cursor,
                     acknowledged_identity_length, &value)) {
    return fail("opaque Starlink cursor acknowledged identity is truncated");
  }
  acknowledged_identity.assign(reinterpret_cast<const char*>(value),
                               acknowledged_identity_length);
  parsed.units.reserve(unit_count);
  std::unordered_set<std::string> identities;
  identities.reserve(unit_count);
  for (uint32_t index = 0; index < unit_count; ++index) {
    if (!consume_bytes(bytes, payload_end, &cursor, 2, &value)) return fail("checkpoint filename core length is truncated");
    const uint16_t core_length = read_u16le(value);
    PlannedUnit unit;
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
    parsed.units.push_back(std::move(unit));
  }
  if (cursor != payload_end ||
      (acknowledged_count == 0
           ? !acknowledged_identity.empty()
           : acknowledged_identity !=
                 parsed.units[acknowledged_count - 1].identity) ||
      compute_plan_identity(parsed.config, parsed.units) !=
          parsed.plan_identity ||
      compute_run_id(parsed.manifest_hash, parsed.plan_identity) !=
          parsed.run_id) {
    return fail("opaque Starlink cursor plan fields are invalid");
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
  progress.add_STATUS(g_state.acknowledged_count == g_state.units.size()
                          ? dssSyncState_SYNCED
                          : dssSyncState_SYNCING);
  progress.add_SYNCED_ROWS(g_state.acknowledged_count);
  progress.add_TOTAL_ROWS(g_state.units.size());
  progress.add_LOCAL_ROWS(g_state.acknowledged_count);
  progress.add_MISSING_ROWS(g_state.units.size() -
                            g_state.acknowledged_count);
  progress.add_CACHED_BYTES(0);
  progress.add_DOWNLOADED_BYTES(g_session_downloaded_bytes);
  const auto root = progress.Finish();
  FinishSizePrefixedDSSBuffer(builder, root);
  const std::vector<uint8_t> canonical(
      builder.GetBufferPointer(),
      builder.GetBufferPointer() + builder.GetSize());
  return emit_single_fsb("progress", canonical, "DSS.fbs", "$DSS", 1);
}

void reset_state() {
  g_state = State{};
  g_inflight.clear();
  g_probe_carry = ProbeCarry{};
  g_plan_verified = false;
  g_plan_yield_pending = false;
  g_session_downloaded_bytes = 0;
  g_trusted_emission_epoch_count = 0;
}

uint32_t work_remaining() {
  const uint64_t remaining =
      g_state.units.size() - g_state.acknowledged_count;
  return static_cast<uint32_t>(std::min<uint64_t>(
      remaining, std::numeric_limits<uint32_t>::max()));
}

bool fetch_catalog_plan(
    const Config& config,
    std::vector<PlannedUnit>* units,
    std::array<uint8_t, 32>* manifest_hash,
    std::array<uint8_t, 32>* plan_identity,
    std::array<uint8_t, 32>* run_id,
    std::string* error) {
  if (!units || !manifest_hash || !plan_identity || !run_id) return false;
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
  std::vector<PlannedUnit> planned =
      plan_units(manifest.body, config, &exceeded_limit);
  if (exceeded_limit || planned.empty()) {
    if (error) {
      *error = exceeded_limit
                   ? "Starlink manifest exceeds the signed object bound"
                   : "Starlink manifest contained no fetch units";
    }
    return false;
  }

  sha256(manifest.body.data(), manifest.body.size(), manifest_hash->data());
  *plan_identity = compute_plan_identity(config, planned);
  *run_id = compute_run_id(*manifest_hash, *plan_identity);
  *units = std::move(planned);
  return true;
}

bool install_catalog_plan(
    const Config& config,
    std::vector<PlannedUnit> units,
    const std::array<uint8_t, 32>& manifest_hash,
    const std::array<uint8_t, 32>& plan_identity,
    const std::array<uint8_t, 32>& run_id,
    std::string* error) {
  State next;
  next.config = config;
  next.units = std::move(units);
  next.manifest_hash = manifest_hash;
  next.plan_identity = plan_identity;
  next.run_id = run_id;
  next.active = true;
  if (encode_checkpoint(next).empty()) {
    if (error) *error = "Starlink plan cannot fit the signed cursor bound";
    return false;
  }
  g_state = std::move(next);
  g_inflight.clear();
  g_probe_carry = ProbeCarry{};
  g_plan_verified = true;
  g_plan_yield_pending =
      g_state.units.size() > kManifestPlanYieldThreshold;
  g_session_downloaded_bytes = 0;
  std::string host_error;
  if (!persist_checkpoint(&host_error)) {
    set_storage_error(
        error, "opaque Starlink plan cursor commit failed",
        host_error);
    reset_state();
    return false;
  }
  return true;
}

bool begin_catalog(const Config& config, std::string* error) {
  std::vector<PlannedUnit> units;
  std::array<uint8_t, 32> manifest_hash{};
  std::array<uint8_t, 32> plan_identity{};
  std::array<uint8_t, 32> run_id{};
  return fetch_catalog_plan(config, &units, &manifest_hash, &plan_identity,
                            &run_id, error) &&
         install_catalog_plan(config, std::move(units), manifest_hash,
                              plan_identity, run_id, error);
}

uint64_t source_request_id(
    const PlannedUnit& unit,
    const std::array<uint8_t, 32>& digest) {
  std::vector<uint8_t> material;
  material.reserve(kSourceIdentityDomain.size() +
                   g_state.plan_identity.size() + unit.identity.size() +
                   digest.size());
  material.insert(material.end(), kSourceIdentityDomain.begin(),
                  kSourceIdentityDomain.end());
  material.insert(material.end(), g_state.plan_identity.begin(),
                  g_state.plan_identity.end());
  material.insert(material.end(), unit.identity.begin(), unit.identity.end());
  material.insert(material.end(), digest.begin(), digest.end());
  std::array<uint8_t, 32> identity{};
  sha256(material.data(), material.size(), identity.data());
  const uint64_t request_id = read_u64le(identity.data());
  return request_id == 0 ? 1 : request_id;
}

bool emit_download_page(
    size_t begin,
    const std::vector<ValidatedDownload>& responses,
    std::string* error) {
  if (responses.empty() || begin != g_state.acknowledged_count ||
      begin > g_state.units.size() ||
      responses.size() > g_state.units.size() - begin ||
      !g_inflight.empty()) {
    if (error) *error = "Starlink streaming wave bounds are invalid";
    return false;
  }
  uint64_t page_bytes = 0;
  uint32_t output_frames = 0;
  std::vector<uint64_t> request_ids;
  request_ids.reserve(responses.size());
  for (size_t local = 0; local < responses.size(); ++local) {
    const ValidatedDownload& download = responses[local];
    const provider_node::HttpResult& response = download.response;
    const DownloadMetadata& metadata = download.metadata;
    if (!metadata.valid || response.status != 200 || response.body.empty() ||
        response.body.size() > kMaxStarlinkFileBytes ||
        metadata.byte_length != response.body.size() ||
        metadata.epoch_count == 0 ||
        !add_without_overflow(page_bytes, metadata.byte_length,
                              &page_bytes)) {
      if (error) *error = "Starlink worker metadata is invalid";
      return false;
    }
    const uint32_t frames = output_frame_count(response.body.size());
    if (frames == 0 ||
        frames > kMaxStreamingOutputFramesPerInvocation - output_frames) {
      if (error) *error = "Starlink streaming wave exceeds its frame bound";
      return false;
    }
    output_frames += frames;
    const uint64_t request_id = source_request_id(
        g_state.units[begin + local], metadata.digest);
    if (std::find(request_ids.begin(), request_ids.end(), request_id) !=
        request_ids.end()) {
      if (error) *error = "Starlink source transaction identity collided";
      return false;
    }
    request_ids.push_back(request_id);
  }
  if (page_bytes > kMaxRetainedWaveBytes ||
      g_session_downloaded_bytes >
          std::numeric_limits<uint64_t>::max() - page_bytes) {
    if (error) *error = "Starlink streaming byte count overflowed";
    return false;
  }

  for (size_t local = 0; local < responses.size(); ++local) {
    const ValidatedDownload& download = responses[local];
    const PlannedUnit& unit = g_state.units[begin + local];
    g_trusted_emission_epoch_count = download.metadata.epoch_count;
    const int emitted = emit_complete_response_with_request_id(
        download.response.body, unit.identity, "MEME",
        trusted_meme_epoch_count, request_ids[local],
        download.metadata.digest.data());
    g_trusted_emission_epoch_count = 0;
    if (emitted < 0 ||
        static_cast<uint32_t>(emitted) !=
            output_frame_count(download.response.body.size())) {
      if (error) *error = "unable to emit a bounded Starlink FSB stream";
      return false;
    }
    g_inflight.push_back({
        static_cast<uint32_t>(begin + local),
        request_ids[local],
        false,
    });
  }
  g_session_downloaded_bytes += page_bytes;
  return true;
}

struct StoreAcknowledgement {
  flatSqlNodeOperation operation = flatSqlNodeOperation_NONE;
  uint64_t request_id = 0;
  flatSqlNodeStatus status = flatSqlNodeStatus_UNSPECIFIED;
};

bool read_store_acknowledgement(
    const plugin_input_frame_t* frame,
    StoreAcknowledgement* acknowledgement,
    std::string* error) {
  if (!frame || !acknowledgement || !frame->payload ||
      !frame->file_identifier ||
      std::strcmp(frame->file_identifier, "$FSO") != 0) {
    if (error) *error = "ack must carry an FSO payload";
    return false;
  }
  if (frame->wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER) {
    flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!VerifyFSOBuffer(verifier)) {
      if (error) *error = "ack contains an invalid canonical FSO";
      return false;
    }
    const FSO* status = GetFSO(frame->payload);
    acknowledgement->operation = status->OPERATION();
    acknowledgement->request_id = status->REQUEST_ID();
    acknowledgement->status = status->STATUS();
    return true;
  }
  if (frame->wire_format != PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY ||
      frame->payload_length != Aligned::FSO_SIZE ||
      frame->byte_length != Aligned::FSO_SIZE ||
      frame->required_alignment != Aligned::FSO_ALIGN ||
      reinterpret_cast<uintptr_t>(frame->payload) %
              Aligned::FSO_ALIGN !=
          0) {
    if (error) *error = "ack contains an invalid aligned FSO";
    return false;
  }
  const auto* status = Aligned::FSO::fromBytes(frame->payload);
  acknowledgement->operation = status->OPERATION;
  acknowledgement->request_id = status->REQUEST_ID;
  acknowledgement->status = status->STATUS;
  return true;
}

bool configs_equal(const Config& left, const Config& right) {
  return left.manifest_url == right.manifest_url &&
         left.ephemeris_base == right.ephemeris_base &&
         left.fetch_concurrency == right.fetch_concurrency &&
         left.batch_size == right.batch_size &&
         left.object_cap == right.object_cap;
}

bool refresh_completed_catalog(
    const Config& config,
    bool* installed,
    std::string* error) {
  if (!installed || !g_state.active ||
      g_state.acknowledged_count != g_state.units.size()) {
    if (error) *error = "Starlink completed-run refresh state is invalid";
    return false;
  }
  *installed = false;
  std::vector<PlannedUnit> units;
  std::array<uint8_t, 32> manifest_hash{};
  std::array<uint8_t, 32> plan_identity{};
  std::array<uint8_t, 32> run_id{};
  if (!fetch_catalog_plan(config, &units, &manifest_hash,
                          &plan_identity, &run_id, error)) {
    return false;
  }
  const bool units_match =
      units.size() == g_state.units.size() &&
      std::equal(
          units.begin(), units.end(), g_state.units.begin(),
          [](const PlannedUnit& left, const PlannedUnit& right) {
            return left.filename == right.filename &&
                   left.identity == right.identity &&
                   left.url == right.url;
          });
  if (units_match && manifest_hash == g_state.manifest_hash &&
      plan_identity == g_state.plan_identity && run_id == g_state.run_id) {
    g_plan_verified = true;
    g_plan_yield_pending = false;
    return true;
  }
  if (!install_catalog_plan(
          config, std::move(units), manifest_hash, plan_identity, run_id,
          error)) {
    return false;
  }
  *installed = true;
  return true;
}

bool verify_loaded_plan(std::string* error) {
  std::vector<PlannedUnit> units;
  std::array<uint8_t, 32> manifest_hash{};
  std::array<uint8_t, 32> plan_identity{};
  std::array<uint8_t, 32> run_id{};
  if (!fetch_catalog_plan(g_state.config, &units, &manifest_hash,
                          &plan_identity, &run_id, error)) {
    return false;
  }
  const bool units_match =
      units.size() == g_state.units.size() &&
      std::equal(
          units.begin(), units.end(), g_state.units.begin(),
          [](const PlannedUnit& left, const PlannedUnit& right) {
            return left.filename == right.filename &&
                   left.identity == right.identity &&
                   left.url == right.url;
          });
  if (!units_match || manifest_hash != g_state.manifest_hash ||
      plan_identity != g_state.plan_identity || run_id != g_state.run_id) {
    if (error) {
      *error =
          "Starlink manifest cannot reproduce the persisted ordered plan";
    }
    return false;
  }
  g_plan_verified = true;
  g_plan_yield_pending =
      g_state.units.size() > kManifestPlanYieldThreshold;
  return true;
}

bool consume_store_acknowledgements(
    bool* cursor_advanced,
    std::string* error) {
  if (!cursor_advanced) return false;
  *cursor_advanced = false;
  if (plugin_find_input_index(
          "ack", kMaxAcknowledgementFramesPerInvocation) >= 0) {
    if (error) {
      *error =
          "Starlink acknowledgement batch exceeds the 64-frame guest limit";
    }
    return false;
  }
  for (uint32_t ordinal = 0;
       ordinal < kMaxAcknowledgementFramesPerInvocation; ++ordinal) {
    const int32_t input_index = plugin_find_input_index("ack", ordinal);
    if (input_index < 0) break;
    StoreAcknowledgement acknowledgement;
    if (!read_store_acknowledgement(
            plugin_get_input_frame(static_cast<uint32_t>(input_index)),
            &acknowledgement, error)) {
      return false;
    }
    if (acknowledgement.operation !=
            flatSqlNodeOperation_APPEND_RECORDS ||
        acknowledgement.status != flatSqlNodeStatus_COMPLETE ||
        acknowledgement.request_id == 0) {
      continue;
    }
    for (InflightUnit& unit : g_inflight) {
      if (unit.request_id == acknowledgement.request_id) {
        unit.acknowledged = true;
        break;
      }
    }
  }

  const uint32_t previous = g_state.acknowledged_count;
  for (;;) {
    const auto next = std::find_if(
        g_inflight.begin(), g_inflight.end(),
        [](const InflightUnit& unit) {
          return unit.unit_index == g_state.acknowledged_count;
        });
    if (next == g_inflight.end() || !next->acknowledged) break;
    ++g_state.acknowledged_count;
  }
  if (g_state.acknowledged_count == previous) return true;

  std::string host_error;
  if (!persist_checkpoint(&host_error)) {
    set_storage_error(error, "opaque Starlink acknowledged cursor commit failed",
                      host_error);
    reset_state();
    return false;
  }
  g_inflight.erase(
      std::remove_if(
          g_inflight.begin(), g_inflight.end(),
          [](const InflightUnit& unit) {
            return unit.unit_index < g_state.acknowledged_count;
          }),
      g_inflight.end());
  *cursor_advanced = true;
  return true;
}

int fail_invocation(const char* code, const std::string& message,
                    int status_code) {
  reset_state();
  plugin_set_error(code, message.c_str());
  return status_code;
}

int run_streaming_phase() {
  if (!g_inflight.empty()) {
    if (!emit_progress()) {
      return fail_invocation(
          "progress-output", "unable to emit Starlink progress snapshot", 500);
    }
    plugin_set_backlog_remaining(work_remaining());
    plugin_set_yielded(1);
    return 0;
  }
  const size_t begin = g_state.acknowledged_count;
  if (begin == g_state.units.size()) {
    if (!emit_progress()) {
      return fail_invocation(
          "progress-output", "unable to emit Starlink completion snapshot",
          500);
    }
    plugin_set_backlog_remaining(0);
    plugin_set_yielded(0);
    return 0;
  }
  const size_t candidate_end = std::min(
      g_state.units.size(),
      begin + static_cast<size_t>(g_state.config.batch_size));
  if (begin >= candidate_end) {
    return fail_invocation(
        "cursor-invalid", "Starlink acknowledged cursor cannot advance", 422);
  }
  std::vector<ProbeResult>* carried_probes = nullptr;
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
        "memory-bound", "Starlink transient download wave cannot fit", 413);
  }
  if (!page.responses_valid) {
    return fail_invocation(
        "ephemeris-validate",
        "a complete Starlink ephemeris response is not valid MEME", 502);
  }
  g_probe_carry.begin = page.next_probe_begin;
  g_probe_carry.probes = std::move(page.carried_probes);
  std::string error;
  if (!emit_download_page(begin, page.responses, &error)) {
    return fail_invocation("output-failed", error, 500);
  }
  if (!emit_progress()) {
    return fail_invocation(
        "progress-output", "unable to emit Starlink progress snapshot", 500);
  }
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

  const Config invocation_config = parse_config(config_json);
  bool loaded_checkpoint = false;
  std::string error;
  if (!g_state.active) {
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
      if (!begin_catalog(invocation_config, &error)) {
        return fail_invocation("manifest-fetch", error, 502);
      }
    } else {
      loaded_checkpoint = true;
    }
  }

  const bool completed_before_config =
      g_state.acknowledged_count == g_state.units.size();
  if (config_present && completed_before_config) {
    bool installed = false;
    if (!refresh_completed_catalog(
            invocation_config, &installed, &error)) {
      return fail_invocation("manifest-refresh", error, 502);
    }
    loaded_checkpoint = false;
  } else {
    if (config_present &&
        !configs_equal(invocation_config, g_state.config)) {
      return fail_invocation(
          "cursor-plan-mismatch",
          "Starlink config cannot resume a different persisted plan", 409);
    }
    if (loaded_checkpoint && !verify_loaded_plan(&error)) {
      return fail_invocation("cursor-plan-mismatch", error, 409);
    }
  }

  bool cursor_advanced = false;
  if (!consume_store_acknowledgements(&cursor_advanced, &error)) {
    const bool storage_failure =
        error.find("cursor commit failed") != std::string::npos;
    return fail_invocation(
        storage_failure ? "cursor-write" : "invalid-ack", error,
        storage_failure ? 503 : 400);
  }
  if (config_present && !g_inflight.empty()) {
    g_inflight.clear();
    g_probe_carry = ProbeCarry{};
  }
  if (g_plan_yield_pending) {
    g_plan_yield_pending = false;
    plugin_set_backlog_remaining(work_remaining());
    plugin_set_yielded(1);
    return 0;
  }
  return run_streaming_phase();
}
