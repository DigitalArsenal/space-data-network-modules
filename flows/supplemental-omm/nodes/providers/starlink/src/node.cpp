#include <array>
#include <atomic>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <limits>
#include <pthread.h>
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
// Keep 64 requests in flight to saturate the link, but bound parsing, opaque
// writes, hashing, and checkpoint serialization in any one guest invocation.
// WasmEdge grants each independently signed child a finite scheduled fuel
// budget; retaining the rest of the fetched wave in this node's own memory
// lets the flow yield and resume without downloading those files twice.
constexpr size_t kMaxDurableFilesPerInvocation = 16;
constexpr uint64_t kMaxDurableBytesPerInvocation = 32ull * 1024 * 1024;
constexpr uint32_t kMaxDownstreamObjectsPerInvocation = 1;
constexpr size_t kMaxStarlinkFileBytes = 64 * 1024 * 1024;
constexpr uint64_t kMaxRetainedWaveBytes = 288ull * 1024 * 1024;
constexpr uint64_t kReservedTransientBytes = 384ull * 1024 * 1024;
constexpr uint64_t kWasmMemoryCeilingBytes = 1024ull * 1024 * 1024;
constexpr size_t kMaxManifestBytes = 8 * 1024 * 1024;
static_assert(kMaxStarlinkFileBytes <= kMaxRetainedWaveBytes);
static_assert(2 * kMaxRetainedWaveBytes + kReservedTransientBytes <
              kWasmMemoryCeilingBytes);

constexpr const char* kOpaqueNamespace = "primary";
constexpr const char* kCheckpointKey = "starlink.active.v1";
constexpr size_t kOpaqueChunkBytes = 1024 * 1024;
constexpr size_t kMaxCheckpointBytes = 8 * 1024 * 1024;
constexpr uint32_t kMaxStorageSegments = 1;
constexpr size_t kMaxHttpMetaBytes = 64 * 1024;
constexpr size_t kMaxStorageJsonOverheadBytes = 64 * 1024;
constexpr size_t kMaxBase64CheckpointBytes =
    ((kMaxCheckpointBytes + 2) / 3) * 4;
constexpr size_t kMaxStorageMetaBytes =
    kMaxBase64CheckpointBytes + kMaxStorageJsonOverheadBytes;
constexpr size_t kMaxStorageResponseBytes = kMaxStorageMetaBytes + 8;
static_assert(kMaxStorageResponseBytes <=
              static_cast<size_t>(std::numeric_limits<int32_t>::max()));
constexpr uint32_t kMaxManifestEntries = 100'000;
constexpr uint32_t kMaxCatalogUnits = 100'000;
constexpr size_t kMaxEndpointBytes = 2048;
constexpr size_t kMaxFilenameBytes = 512;
constexpr size_t kMaxIdentityBytes = 64;
constexpr uint8_t kCheckpointMagic[8] = {'S', 'L', 'S', 'P', 'O', 'O', 'L', '1'};
constexpr uint16_t kCheckpointVersion = 2;

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

State g_state;
std::vector<provider_node::HttpResult> g_pending_wave;
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

struct FetchPageContext {
  const std::vector<PlannedUnit>* units = nullptr;
  size_t begin = 0;
  size_t end = 0;
  std::atomic<size_t> next{0};
  const std::vector<uint64_t>* expected_sizes = nullptr;
  std::vector<provider_node::HttpResult>* results = nullptr;
};

struct ProbeResult {
  uint64_t byte_length = 0;
  bool valid = false;
};

struct ProbePageContext {
  const std::vector<PlannedUnit>* units = nullptr;
  size_t begin = 0;
  size_t end = 0;
  std::atomic<size_t> next{0};
  std::vector<ProbeResult>* results = nullptr;
};

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

void fetch_page_tasks(FetchPageContext* context) {
  for (;;) {
    const size_t local = context->next.fetch_add(1, std::memory_order_relaxed);
    const size_t index = context->begin + local;
    if (index >= context->end) break;
    (*context->results)[local] =
        http_get_complete((*context->units)[index].url,
                          static_cast<size_t>((*context->expected_sizes)[local]));
  }
}

void* fetch_page_worker(void* opaque) {
  fetch_page_tasks(static_cast<FetchPageContext*>(opaque));
  return nullptr;
}

std::vector<provider_node::HttpResult> fetch_complete_page(
    const std::vector<PlannedUnit>& units, size_t begin, size_t end,
    uint32_t fetch_concurrency, const std::vector<uint64_t>& expected_sizes) {
  const size_t count = end > begin ? end - begin : 0;
  std::vector<provider_node::HttpResult> results(count);
  if (count == 0 || expected_sizes.size() != count) return results;
  const size_t worker_count = std::min<size_t>(
      count,
      std::max<uint32_t>(
          1, std::min(fetch_concurrency, kMaxFetchConcurrency)));
  FetchPageContext context;
  context.units = &units;
  context.begin = begin;
  context.end = end;
  context.expected_sizes = &expected_sizes;
  context.results = &results;

  // Workers are scoped to this one complete-file page. No pthread remains
  // resident while the flow schedules progress, OD, or another node.
  std::vector<pthread_t> workers;
  workers.reserve(worker_count > 0 ? worker_count - 1 : 0);
  for (size_t index = 0; index + 1 < worker_count; ++index) {
    pthread_t worker{};
    if (pthread_create(&worker, nullptr, fetch_page_worker, &context) == 0) {
      workers.push_back(worker);
    }
  }
  fetch_page_tasks(&context);
  for (pthread_t worker : workers) {
    if (pthread_join(worker, nullptr) != 0) {
      // Returning would release a page context that a worker may still use.
      __builtin_trap();
    }
  }
  return results;
}

void probe_page_tasks(ProbePageContext* context) {
  for (;;) {
    const size_t local = context->next.fetch_add(1, std::memory_order_relaxed);
    const size_t index = context->begin + local;
    if (index >= context->end) break;
    (*context->results)[local] =
        probe_complete_size((*context->units)[index].url);
  }
}

void* probe_page_worker(void* opaque) {
  probe_page_tasks(static_cast<ProbePageContext*>(opaque));
  return nullptr;
}

std::vector<ProbeResult> probe_complete_page(
    const std::vector<PlannedUnit>& units, size_t begin, size_t end,
    uint32_t fetch_concurrency) {
  const size_t count = end > begin ? end - begin : 0;
  std::vector<ProbeResult> results(count);
  if (count == 0) return results;
  const size_t worker_count = std::min<size_t>(
      count,
      std::max<uint32_t>(
          1, std::min(fetch_concurrency, kMaxFetchConcurrency)));
  ProbePageContext context;
  context.units = &units;
  context.begin = begin;
  context.end = end;
  context.results = &results;

  std::vector<pthread_t> workers;
  workers.reserve(worker_count > 0 ? worker_count - 1 : 0);
  for (size_t index = 0; index + 1 < worker_count; ++index) {
    pthread_t worker{};
    if (pthread_create(&worker, nullptr, probe_page_worker, &context) == 0) {
      workers.push_back(worker);
    }
  }
  probe_page_tasks(&context);
  for (pthread_t worker : workers) {
    if (pthread_join(worker, nullptr) != 0) __builtin_trap();
  }
  return results;
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
  if (cursor < token.size() &&
      (token[cursor] == 'e' || token[cursor] == 'E')) {
    ++cursor;
    if (cursor < token.size() &&
        (token[cursor] == '+' || token[cursor] == '-')) {
      ++cursor;
    }
    const size_t exponent_begin = cursor;
    while (cursor < token.size() && token[cursor] >= '0' &&
           token[cursor] <= '9') {
      ++cursor;
    }
    if (cursor == exponent_begin) return false;
  }
  if (cursor != token.size()) return false;
  char owned[kMaxNumericTokenBytes + 1];
  std::memcpy(owned, token.data(), token.size());
  owned[token.size()] = '\0';
  char* parsed_end = nullptr;
  errno = 0;
  const double value = std::strtod(owned, &parsed_end);
  return errno != ERANGE && parsed_end == owned + token.size() &&
         std::isfinite(value);
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

bool call_storage(std::string_view operation, const std::string& meta,
                  const std::vector<uint8_t>* segment,
                  StorageResponse* response) {
  if (!response || meta.size() > static_cast<size_t>(INT32_MAX) ||
      (segment && segment->size() > static_cast<size_t>(INT32_MAX))) {
    return false;
  }
  std::vector<uint8_t> request;
  request.reserve(8 + meta.size() + (segment ? 4 + segment->size() : 0));
  append_u32le(&request, static_cast<uint32_t>(meta.size()));
  request.insert(request.end(), meta.begin(), meta.end());
  append_u32le(&request, segment ? 1 : 0);
  if (segment) {
    append_u32le(&request, static_cast<uint32_t>(segment->size()));
    request.insert(request.end(), segment->begin(), segment->end());
  }

  sdm_host_clear_response();
  const int32_t call_result = sdm_host_call(
      operation.data(), static_cast<int32_t>(operation.size()),
      reinterpret_cast<const char*>(request.data()),
      static_cast<int32_t>(request.size()));
  const int32_t status_code = sdm_host_last_status_code();
  const int32_t response_length = sdm_host_response_len();
  if (call_result != 0 || status_code != 0 || response_length < 8 ||
      static_cast<size_t>(response_length) > kMaxStorageResponseBytes) {
    sdm_host_clear_response();
    return false;
  }
  std::vector<uint8_t> response_bytes(static_cast<size_t>(response_length));
  const int32_t copied = sdm_host_read_response(
      reinterpret_cast<char*>(response_bytes.data()), response_length);
  sdm_host_clear_response();
  bool ok = false;
  return copied == response_length &&
         validate_storage_envelope_layout(response_bytes) &&
         parse_envelope(response_bytes, &response->meta, &response->segments) &&
         json_bool(response->meta, "ok", &ok) && ok;
}

std::string storage_meta(std::string_view key, bool has_data = false) {
  std::string meta = "{\"namespace\":\"";
  meta += kOpaqueNamespace;
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

bool read_opaque_value(const std::string& key, size_t max_bytes,
                       std::vector<uint8_t>* value, bool* found) {
  if (!value || !found) return false;
  StorageResponse response;
  if (!call_storage("storage.adapter.opaque.read", storage_meta(key), nullptr,
                    &response) ||
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

bool replace_opaque_value(const std::string& key,
                          const std::vector<uint8_t>& value) {
  StorageResponse response;
  int64_t stored_bytes = -1;
  return call_storage("storage.adapter.opaque.replace",
                      storage_meta(key, true), &value, &response) &&
         json_int64(response.meta, "stored_bytes", &stored_bytes) &&
         stored_bytes == static_cast<int64_t>(value.size());
}

bool delete_opaque_value(const std::string& key) {
  StorageResponse response;
  bool deleted = false;
  return call_storage("storage.adapter.opaque.delete", storage_meta(key),
                      nullptr, &response) &&
         json_bool(response.meta, "deleted", &deleted) && deleted;
}

bool sync_opaque_state() {
  StorageResponse response;
  bool synced = false;
  return call_storage("storage.adapter.opaque.sync", storage_meta({}), nullptr,
                      &response) &&
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

std::vector<uint8_t> encode_checkpoint(const State& state) {
  if (state.config.manifest_url.empty() ||
      state.config.manifest_url.size() > kMaxEndpointBytes ||
      state.config.ephemeris_base.empty() ||
      state.config.ephemeris_base.size() > kMaxEndpointBytes ||
      state.units.empty() || state.units.size() > kMaxCatalogUnits) {
    return {};
  }
  std::vector<uint8_t> bytes;
  bytes.reserve(108 + state.config.manifest_url.size() +
                state.config.ephemeris_base.size() +
                state.units.size() * 136);
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
    if (unit.filename.empty() || unit.filename.size() > kMaxFilenameBytes ||
        unit.identity.empty() || unit.identity.size() > kMaxIdentityBytes) {
      return {};
    }
    append_u16le(&bytes, static_cast<uint16_t>(unit.filename.size()));
    append_u16le(&bytes, static_cast<uint16_t>(unit.identity.size()));
    append_u64le(&bytes, unit.byte_length);
    append_u32le(&bytes, unit.chunk_count);
    append_u64le(&bytes, unit.epoch_count);
    bytes.insert(bytes.end(), unit.digest.begin(), unit.digest.end());
    bytes.insert(bytes.end(), unit.filename.begin(), unit.filename.end());
    bytes.insert(bytes.end(), unit.identity.begin(), unit.identity.end());
  }
  if (bytes.size() > kMaxCheckpointBytes - 32) return {};
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
    if (!consume_bytes(bytes, payload_end, &cursor, 2, &value)) return fail("checkpoint filename length is truncated");
    const uint16_t filename_length = read_u16le(value);
    if (!consume_bytes(bytes, payload_end, &cursor, 2, &value)) return fail("checkpoint identity length is truncated");
    const uint16_t identity_length = read_u16le(value);
    if (!consume_bytes(bytes, payload_end, &cursor, 8, &value)) return fail("checkpoint object size is truncated");
    const uint64_t byte_length = read_u64le(value);
    if (!consume_bytes(bytes, payload_end, &cursor, 4, &value)) return fail("checkpoint chunk count is truncated");
    const uint32_t chunk_count = read_u32le(value);
    if (!consume_bytes(bytes, payload_end, &cursor, 8, &value)) return fail("checkpoint epoch count is truncated");
    const uint64_t epoch_count = read_u64le(value);
    PlannedUnit unit;
    unit.byte_length = byte_length;
    unit.chunk_count = chunk_count;
    unit.epoch_count = epoch_count;
    if (!consume_bytes(bytes, payload_end, &cursor, unit.digest.size(),
                       &value)) {
      return fail("checkpoint object hash is truncated");
    }
    std::copy(value, value + unit.digest.size(), unit.digest.begin());
    if (filename_length == 0 || filename_length > kMaxFilenameBytes ||
        identity_length == 0 || identity_length > kMaxIdentityBytes ||
        !consume_bytes(bytes, payload_end, &cursor, filename_length, &value)) {
      return fail("opaque Starlink checkpoint filename is invalid");
    }
    unit.filename.assign(reinterpret_cast<const char*>(value), filename_length);
    if (!consume_bytes(bytes, payload_end, &cursor, identity_length, &value)) {
      return fail("opaque Starlink checkpoint identity is truncated");
    }
    unit.identity.assign(reinterpret_cast<const char*>(value), identity_length);
    uint64_t filename_generation = 0;
    if (unit.filename.find('/') != std::string::npos ||
        unit.filename.find('\\') != std::string::npos ||
        !meme_generation(unit.filename, &filename_generation) ||
        meme_identity(unit.filename) != unit.identity ||
        !identities.insert(unit.identity).second) {
      return fail("opaque Starlink checkpoint object identity is invalid");
    }
    unit.url = join_url(parsed.config.ephemeris_base, unit.filename);
    if (index < downloaded_count) {
      const uint64_t expected_chunks =
          byte_length == 0 ? 0 : ((byte_length - 1) / kOpaqueChunkBytes) + 1;
      if (byte_length == 0 || byte_length > kMaxStarlinkFileBytes ||
          expected_chunks > std::numeric_limits<uint32_t>::max() ||
          chunk_count != expected_chunks || epoch_count == 0 ||
          all_zero(unit.digest) ||
          !add_without_overflow(observed_bytes, byte_length, &observed_bytes)) {
        return fail("opaque Starlink checkpoint object layout is invalid");
      }
    } else if (byte_length != 0 || chunk_count != 0 || epoch_count != 0 ||
               !all_zero(unit.digest)) {
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

bool persist_checkpoint() {
  const std::vector<uint8_t> checkpoint = encode_checkpoint(g_state);
  return !checkpoint.empty() &&
         replace_opaque_value(kCheckpointKey, checkpoint) &&
         sync_opaque_state();
}

enum class CheckpointLoadResult {
  kNotFound,
  kLoaded,
  kError,
};

CheckpointLoadResult load_checkpoint(std::string* error) {
  std::vector<uint8_t> bytes;
  bool found = false;
  if (!read_opaque_value(kCheckpointKey, kMaxCheckpointBytes, &bytes, &found)) {
    if (error) *error = "opaque Starlink checkpoint read failed";
    return CheckpointLoadResult::kError;
  }
  if (!found) return CheckpointLoadResult::kNotFound;
  State loaded;
  if (!parse_checkpoint(bytes, &loaded, error)) {
    return CheckpointLoadResult::kError;
  }
  if (!sync_opaque_state()) {
    if (error) *error = "opaque Starlink checkpoint reload sync failed";
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
  if (!persist_checkpoint()) {
    g_state = State{};
    if (error) {
      *error = "opaque Starlink zero-download checkpoint commit failed";
    }
    return false;
  }
  return true;
}

bool stage_download_page(
    size_t begin,
    const std::vector<provider_node::HttpResult>& responses,
    size_t response_offset,
    size_t response_count,
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
  std::vector<uint64_t> epoch_counts;
  epoch_counts.reserve(response_count);
  for (size_t local = 0; local < response_count; ++local) {
    const provider_node::HttpResult& response =
        responses[response_offset + local];
    if (response.status != 200 || response.body.empty() ||
        response.body.size() > kMaxStarlinkFileBytes) {
      if (error) *error = "a complete Starlink ephemeris fetch failed";
      return false;
    }
    uint64_t epochs = 0;
    if (!validate_meme_file(response.body, &epochs)) {
      if (error) *error = "a Starlink ephemeris response is not valid MEME";
      return false;
    }
    if (response.body.size() > kMaxRetainedWaveBytes ||
        page_bytes > kMaxRetainedWaveBytes - response.body.size() ||
        !add_without_overflow(page_bytes, response.body.size(), &page_bytes)) {
      if (error) *error = "Starlink page byte count overflowed";
      return false;
    }
    epoch_counts.push_back(epochs);
  }
  if (response_count > 1 && page_bytes > kMaxDurableBytesPerInvocation) {
    if (error) *error = "Starlink durable slice exceeds its byte bound";
    return false;
  }

  for (size_t local = 0; local < response_count; ++local) {
    const provider_node::HttpResult& response =
        responses[response_offset + local];
    PlannedUnit& unit = g_state.units[begin + local];
    unit.byte_length = response.body.size();
    unit.chunk_count = static_cast<uint32_t>(
        (response.body.size() + kOpaqueChunkBytes - 1) / kOpaqueChunkBytes);
    unit.epoch_count = epoch_counts[local];
    sha256(response.body.data(), response.body.size(), unit.digest.data());
    for (uint32_t chunk = 0; chunk < unit.chunk_count; ++chunk) {
      const size_t offset = static_cast<size_t>(chunk) * kOpaqueChunkBytes;
      const size_t length =
          std::min(kOpaqueChunkBytes, response.body.size() - offset);
      const std::vector<uint8_t> bytes(
          response.body.begin() + static_cast<std::ptrdiff_t>(offset),
          response.body.begin() + static_cast<std::ptrdiff_t>(offset + length));
      if (!replace_opaque_value(
              chunk_key(g_state, static_cast<uint32_t>(begin + local), chunk),
              bytes)) {
        if (error) *error = "opaque Starlink chunk write failed";
        return false;
      }
    }
  }
  if (!sync_opaque_state()) {
    if (error) *error = "opaque Starlink chunk sync failed";
    return false;
  }
  uint64_t next_bytes = 0;
  if (!add_without_overflow(g_state.downloaded_bytes, page_bytes, &next_bytes)) {
    if (error) *error = "Starlink catalog byte count overflowed";
    return false;
  }
  g_state.downloaded_bytes = next_bytes;
  g_state.downloaded_count = static_cast<uint32_t>(begin + response_count);
  if (!persist_checkpoint()) {
    if (error) *error = "opaque Starlink checkpoint commit failed";
    return false;
  }
  return true;
}

bool delete_unit_chunks(uint32_t unit_index, std::string* error) {
  if (unit_index >= g_state.units.size()) {
    if (error) *error = "Starlink cleanup cursor is out of bounds";
    return false;
  }
  const PlannedUnit& unit = g_state.units[unit_index];
  for (uint32_t chunk = 0; chunk < unit.chunk_count; ++chunk) {
    if (!delete_opaque_value(chunk_key(g_state, unit_index, chunk))) {
      if (error) *error = "opaque Starlink chunk cleanup failed";
      return false;
    }
  }
  if (!sync_opaque_state()) {
    if (error) *error = "opaque Starlink cleanup sync failed";
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
    const size_t expected = static_cast<size_t>(std::min<uint64_t>(
        kOpaqueChunkBytes, unit.byte_length - body->size()));
    if (!read_opaque_value(chunk_key(g_state, unit_index, chunk),
                           kOpaqueChunkBytes, &bytes, &found) ||
        !found || bytes.size() != expected) {
      if (error) *error = "opaque Starlink object is missing or truncated";
      return false;
    }
    body->insert(body->end(), bytes.begin(), bytes.end());
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
  uint64_t observed_epochs = 0;
  if (!validate_meme_file(*body, &observed_epochs) ||
      observed_epochs != unit.epoch_count) {
    if (error) *error = "opaque Starlink object epoch count is invalid";
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
  if (response_offset == g_pending_wave.size()) {
    g_pending_wave.clear();
    g_pending_wave_begin = 0;
  } else {
    size_t count = 0;
    uint64_t slice_bytes = 0;
    while (count < kMaxDurableFilesPerInvocation &&
           response_offset + count < g_pending_wave.size()) {
      const size_t body_bytes =
          g_pending_wave[response_offset + count].body.size();
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
    if (!stage_download_page(
            begin, g_pending_wave, response_offset, count, &error)) {
      return fail_invocation("spool-write", error, 503);
    }
    if (response_offset + count == g_pending_wave.size()) {
      g_pending_wave.clear();
      g_pending_wave_begin = 0;
    }
  }
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
  if (begin > 0 && !g_progress_emitted_transient) {
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
    g_state.phase = Phase::kDraining;
    if (!persist_checkpoint()) {
      return fail_invocation(
          "checkpoint-write",
          "opaque Starlink drain-transition checkpoint failed", 503);
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
  const std::vector<ProbeResult> probes = probe_complete_page(
      g_state.units, begin, candidate_end, g_state.config.fetch_concurrency);
  if (probes.size() != candidate_end - begin ||
      std::any_of(probes.begin(), probes.end(),
                  [](const ProbeResult& probe) { return !probe.valid; })) {
    return fail_invocation(
        "size-probe", "Starlink complete-file size preflight failed", 502);
  }
  uint64_t retained_bytes = 0;
  size_t end = begin;
  std::vector<uint64_t> expected_sizes;
  expected_sizes.reserve(probes.size());
  for (const ProbeResult& probe : probes) {
    if (retained_bytes > kMaxRetainedWaveBytes - probe.byte_length) break;
    retained_bytes += probe.byte_length;
    expected_sizes.push_back(probe.byte_length);
    ++end;
  }
  if (end == begin || expected_sizes.empty()) {
    return fail_invocation(
        "memory-bound", "Starlink retained download wave cannot fit", 413);
  }
  g_pending_wave_begin = static_cast<uint32_t>(begin);
  g_pending_wave = fetch_complete_page(
      g_state.units, begin, end, g_state.config.fetch_concurrency,
      expected_sizes);
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
    if (!persist_checkpoint()) {
      return fail_invocation(
          "checkpoint-write",
          "opaque Starlink cleanup-pending checkpoint failed", 503);
    }
    g_emitted_transient = false;
  }

  if (g_state.cleanup_pending) {
    if (g_state.drain_index == 0 ||
        !delete_unit_chunks(g_state.drain_index - 1, &error)) {
      return fail_invocation("spool-cleanup", error, 503);
    }
    g_state.cleanup_pending = false;
    if (!persist_checkpoint()) {
      return fail_invocation(
          "checkpoint-write",
          "opaque Starlink cleanup-complete checkpoint failed", 503);
    }
  }

  if (g_state.drain_index == g_state.units.size()) {
    if (!delete_opaque_value(kCheckpointKey) || !sync_opaque_state()) {
      return fail_invocation(
          "spool-cleanup", "opaque Starlink checkpoint cleanup failed", 503);
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
      body, unit.identity, "MEME", trusted_meme_epoch_count);
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
    }
  }

  if (g_state.phase == Phase::kDownloading) return run_download_phase();
  if (g_state.phase == Phase::kDraining) return run_drain_phase();
  return fail_invocation("checkpoint-invalid",
                         "Starlink checkpoint phase is invalid", 422);
}
