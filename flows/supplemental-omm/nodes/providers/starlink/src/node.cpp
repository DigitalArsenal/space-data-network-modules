#include <atomic>
#include <cerrno>
#include <ctime>
#include <pthread.h>
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
constexpr uint32_t kMaxDownstreamObjectsPerInvocation = 1;
constexpr time_t kFetchWorkerIdleTimeoutSeconds = 45;

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
  std::vector<HttpResult> pending;
  size_t next = 0;
  size_t pending_begin = 0;
  size_t pending_next = 0;
  bool active = false;
};

State g_state;

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
    config.object_cap = static_cast<uint32_t>(number);
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
  if (identity.size() > 64) identity.resize(64);
  return identity;
}

std::vector<PlannedUnit> plan_units(const std::vector<uint8_t>& manifest,
                                    const Config& config) {
  std::vector<PlannedUnit> units;
  for (const std::string_view raw_line : lines(manifest)) {
    const std::string filename = trim(raw_line);
    if (filename.rfind("MEME_", 0) != 0 || filename.find('/') != std::string::npos ||
        filename.find('\\') != std::string::npos) {
      continue;
    }
    const std::string identity = meme_identity(filename);
    if (identity.empty()) continue;
    units.push_back(
        {filename, join_url(config.ephemeris_base, filename), identity});
    if (config.object_cap > 0 && units.size() >= config.object_cap) break;
  }
  return units;
}

struct FetchPageContext {
  const std::vector<PlannedUnit>* units = nullptr;
  size_t begin = 0;
  size_t end = 0;
  std::atomic<size_t> next{0};
  std::vector<HttpResult>* results = nullptr;
};

struct FetchWorker {
  size_t index = 0;
  uint64_t generation = 0;
  pthread_t thread{};
};

struct FetchWorkerPool {
  pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
  pthread_cond_t work_ready{};
  pthread_cond_t page_done = PTHREAD_COND_INITIALIZER;
  FetchPageContext* context = nullptr;
  uint64_t generation = 0;
  size_t worker_count = 0;
  size_t active_worker_count = 0;
  size_t completed_worker_count = 0;
  size_t exited_worker_count = 0;
  bool retire_requested = false;
  bool work_ready_initialized = false;
  bool disabled = false;
  bool disable_requested = false;
  FetchWorker workers[kMaxFetchConcurrency - 1]{};
};

FetchWorkerPool g_fetch_pool;
pthread_once_t g_fetch_pool_once = PTHREAD_ONCE_INIT;

void initialize_fetch_worker_pool() {
  pthread_condattr_t attributes{};
  if (pthread_condattr_init(&attributes) != 0) return;
  const bool initialized =
      pthread_condattr_setclock(&attributes, CLOCK_MONOTONIC) == 0 &&
      pthread_cond_init(&g_fetch_pool.work_ready, &attributes) == 0;
  pthread_condattr_destroy(&attributes);
  g_fetch_pool.work_ready_initialized = initialized;
  g_fetch_pool.disabled = !initialized;
}

bool fetch_worker_pool_available() {
  pthread_once(&g_fetch_pool_once, initialize_fetch_worker_pool);
  return g_fetch_pool.work_ready_initialized && !g_fetch_pool.disabled;
}

void fetch_page_worker(FetchPageContext* context) {
  for (;;) {
    const size_t local = context->next.fetch_add(1, std::memory_order_relaxed);
    const size_t index = context->begin + local;
    if (index >= context->end) break;
    (*context->results)[local] = http_get((*context->units)[index].url);
  }
}

bool fetch_worker_idle_deadline(timespec* deadline) {
  if (!deadline || clock_gettime(CLOCK_MONOTONIC, deadline) != 0) return false;
  deadline->tv_sec += kFetchWorkerIdleTimeoutSeconds;
  return true;
}

void* fetch_page_worker_loop(void* opaque) {
  auto* worker = static_cast<FetchWorker*>(opaque);
  for (;;) {
    pthread_mutex_lock(&g_fetch_pool.mutex);
    while (!g_fetch_pool.retire_requested &&
           worker->generation == g_fetch_pool.generation) {
      timespec deadline{};
      if (!fetch_worker_idle_deadline(&deadline)) {
        g_fetch_pool.disable_requested = true;
        g_fetch_pool.retire_requested = true;
        pthread_cond_broadcast(&g_fetch_pool.work_ready);
        break;
      }
      const int wait_status = pthread_cond_timedwait(
          &g_fetch_pool.work_ready, &g_fetch_pool.mutex, &deadline);
      if (wait_status != 0 && wait_status != EINTR &&
          worker->generation == g_fetch_pool.generation) {
        // Retire the pool as one generation. The next page reaps every old
        // pthread before creating replacements, so libc never sees a mixture
        // of stale and live worker handles.
        g_fetch_pool.retire_requested = true;
        pthread_cond_broadcast(&g_fetch_pool.work_ready);
      }
    }
    if (g_fetch_pool.retire_requested) {
      ++g_fetch_pool.exited_worker_count;
      pthread_cond_broadcast(&g_fetch_pool.page_done);
      pthread_mutex_unlock(&g_fetch_pool.mutex);
      return nullptr;
    }
    worker->generation = g_fetch_pool.generation;
    FetchPageContext* context = g_fetch_pool.context;
    const bool active = worker->index < g_fetch_pool.active_worker_count;
    pthread_mutex_unlock(&g_fetch_pool.mutex);

    if (active && context) fetch_page_worker(context);

    pthread_mutex_lock(&g_fetch_pool.mutex);
    ++g_fetch_pool.completed_worker_count;
    if (g_fetch_pool.completed_worker_count == g_fetch_pool.worker_count) {
      pthread_cond_signal(&g_fetch_pool.page_done);
    }
    pthread_mutex_unlock(&g_fetch_pool.mutex);
  }
  return nullptr;
}

void retire_fetch_workers() {
  if (!fetch_worker_pool_available()) return;
  pthread_t threads[kMaxFetchConcurrency - 1]{};
  size_t worker_count = 0;

  pthread_mutex_lock(&g_fetch_pool.mutex);
  worker_count = g_fetch_pool.worker_count;
  if (worker_count == 0) {
    g_fetch_pool.retire_requested = false;
    g_fetch_pool.exited_worker_count = 0;
    pthread_mutex_unlock(&g_fetch_pool.mutex);
    return;
  }
  g_fetch_pool.retire_requested = true;
  pthread_cond_broadcast(&g_fetch_pool.work_ready);
  while (g_fetch_pool.exited_worker_count < worker_count) {
    pthread_cond_wait(&g_fetch_pool.page_done, &g_fetch_pool.mutex);
  }
  for (size_t index = 0; index < worker_count; ++index) {
    threads[index] = g_fetch_pool.workers[index].thread;
  }
  pthread_mutex_unlock(&g_fetch_pool.mutex);

  bool joined = true;
  for (size_t index = 0; index < worker_count; ++index) {
    if (pthread_join(threads[index], nullptr) != 0) joined = false;
  }

  pthread_mutex_lock(&g_fetch_pool.mutex);
  g_fetch_pool.context = nullptr;
  g_fetch_pool.worker_count = 0;
  g_fetch_pool.active_worker_count = 0;
  g_fetch_pool.completed_worker_count = 0;
  g_fetch_pool.exited_worker_count = 0;
  g_fetch_pool.retire_requested = false;
  if (!joined || g_fetch_pool.disable_requested) g_fetch_pool.disabled = true;
  g_fetch_pool.disable_requested = false;
  pthread_mutex_unlock(&g_fetch_pool.mutex);
}

void keep_fetch_workers_alive() {
  if (!fetch_worker_pool_available()) return;
  pthread_mutex_lock(&g_fetch_pool.mutex);
  if (g_fetch_pool.worker_count > 0 && !g_fetch_pool.retire_requested) {
    // A condition wake with the same page generation only renews each
    // worker's bounded idle deadline; it cannot dispatch duplicate work.
    pthread_cond_broadcast(&g_fetch_pool.work_ready);
  }
  pthread_mutex_unlock(&g_fetch_pool.mutex);
}

bool ensure_fetch_workers(size_t worker_count) {
  if (!fetch_worker_pool_available()) return false;
  const size_t desired = worker_count > 0 ? worker_count - 1 : 0;
  for (;;) {
    pthread_mutex_lock(&g_fetch_pool.mutex);
    if (g_fetch_pool.retire_requested) {
      pthread_mutex_unlock(&g_fetch_pool.mutex);
      retire_fetch_workers();
      if (!fetch_worker_pool_available()) return false;
      continue;
    }
    while (g_fetch_pool.worker_count < desired) {
      const size_t index = g_fetch_pool.worker_count;
      FetchWorker& worker = g_fetch_pool.workers[index];
      worker.index = index;
      worker.generation = g_fetch_pool.generation;
      if (pthread_create(&worker.thread, nullptr, fetch_page_worker_loop,
                         &worker) != 0) {
        break;
      }
      ++g_fetch_pool.worker_count;
    }
    const bool available = g_fetch_pool.worker_count > 0;
    pthread_mutex_unlock(&g_fetch_pool.mutex);
    return available;
  }
}

std::vector<HttpResult> fetch_complete_page(
    const std::vector<PlannedUnit>& units, size_t begin, size_t end,
    uint32_t fetch_concurrency) {
  const size_t count = end > begin ? end - begin : 0;
  std::vector<HttpResult> results(count);
  if (count == 0) return results;
  const size_t worker_count = std::min<size_t>(
      count, std::max<uint32_t>(1, std::min(fetch_concurrency, kMaxFetchConcurrency)));
  FetchPageContext context;
  context.units = &units;
  context.begin = begin;
  context.end = end;
  context.results = &results;
  if (worker_count == 1) {
    fetch_page_worker(&context);
    return results;
  }

  for (;;) {
    if (!ensure_fetch_workers(worker_count)) {
      fetch_page_worker(&context);
      return results;
    }
    pthread_mutex_lock(&g_fetch_pool.mutex);
    if (g_fetch_pool.retire_requested) {
      pthread_mutex_unlock(&g_fetch_pool.mutex);
      retire_fetch_workers();
      continue;
    }
    // The final retirement check and page publication are one transaction.
    // An idle worker therefore either retires before this lock is acquired or
    // observes this new generation and participates in the page.
    g_fetch_pool.context = &context;
    g_fetch_pool.active_worker_count =
        std::min(g_fetch_pool.worker_count, worker_count - 1);
    g_fetch_pool.completed_worker_count = 0;
    ++g_fetch_pool.generation;
    pthread_cond_broadcast(&g_fetch_pool.work_ready);
    pthread_mutex_unlock(&g_fetch_pool.mutex);
    break;
  }

  fetch_page_worker(&context);

  pthread_mutex_lock(&g_fetch_pool.mutex);
  while (g_fetch_pool.completed_worker_count < g_fetch_pool.worker_count) {
    pthread_cond_wait(&g_fetch_pool.page_done, &g_fetch_pool.mutex);
  }
  g_fetch_pool.context = nullptr;
  pthread_mutex_unlock(&g_fetch_pool.mutex);
  return results;
}

uint64_t count_meme_epochs(const std::vector<uint8_t>& bytes) {
  uint64_t count = 0;
  for (const std::string_view line : lines(bytes)) {
    size_t digits = 0;
    while (digits < line.size() && line[digits] >= '0' && line[digits] <= '9') {
      ++digits;
    }
    if (digits >= 13 && digits < line.size() &&
        (line[digits] == '.' || line[digits] == ' ' || line[digits] == '\t')) {
      ++count;
    }
  }
  return count;
}

void reset_state() {
  retire_fetch_workers();
  g_state.units.clear();
  g_state.pending.clear();
  g_state.next = 0;
  g_state.pending_begin = 0;
  g_state.pending_next = 0;
  g_state.active = false;
}

}  // namespace

extern "C" int emit(void) {
  plugin_reset_output_state();
  keep_fetch_workers_alive();
  std::string config_json;
  if (!provider_node::read_config_json(&config_json)) {
    reset_state();
    plugin_set_error("invalid-config", "config must be a valid canonical or aligned FSB");
    return 400;
  }
  if (!g_state.active) {
    g_state.config = parse_config(config_json);
    const HttpResult manifest = http_get(g_state.config.manifest_url);
    if (manifest.status != 200 || manifest.body.empty()) {
      reset_state();
      plugin_set_error("manifest-fetch", "unable to fetch the complete Starlink manifest");
      return 502;
    }
    g_state.units = plan_units(manifest.body, g_state.config);
    g_state.next = 0;
    g_state.pending.clear();
    g_state.pending_begin = 0;
    g_state.pending_next = 0;
    g_state.active = !g_state.units.empty();
    if (!g_state.active) {
      reset_state();
      plugin_set_error("manifest-empty", "Starlink manifest contained no fetch units");
      return 422;
    }
  }

  uint32_t emitted_frames = 0;
  uint32_t emitted_objects = 0;
  while (emitted_frames < kMaxOutputFramesPerInvocation &&
         emitted_objects < kMaxDownstreamObjectsPerInvocation) {
    if (g_state.pending_next >= g_state.pending.size()) {
      g_state.pending.clear();
      g_state.pending_next = 0;
      // One bounded download page per invocation keeps continuation visible
      // to the signed flow runtime and prevents one fast catalog from
      // monopolizing a drain cycle.
      if (emitted_frames > 0) break;
      if (g_state.next >= g_state.units.size()) break;
      const size_t begin = g_state.next;
      const size_t end = std::min(
          g_state.units.size(),
          begin + static_cast<size_t>(g_state.config.batch_size));
      std::vector<HttpResult> responses = fetch_complete_page(
          g_state.units, begin, end, g_state.config.fetch_concurrency);
      for (const HttpResult& response : responses) {
        if (response.status != 200 || response.body.empty()) {
          reset_state();
          plugin_set_error(
              "ephemeris-fetch",
              "a complete Starlink ephemeris fetch failed");
          return 502;
        }
      }
      g_state.pending = std::move(responses);
      g_state.pending_begin = begin;
      g_state.next = end;
    }

    const HttpResult& response = g_state.pending[g_state.pending_next];
    const uint32_t response_frames = output_frame_count(response.body.size());
    if (response_frames == 0 ||
        response_frames > kMaxOutputFramesPerInvocation) {
      reset_state();
      plugin_set_error("output-bound", "one Starlink response exceeds the signed frame bound");
      return 413;
    }
    if (emitted_frames > 0 &&
        emitted_frames + response_frames > kMaxOutputFramesPerInvocation) {
      break;
    }
    const PlannedUnit& unit =
        g_state.units[g_state.pending_begin + g_state.pending_next];
    const int emitted = emit_complete_response(
        response.body, unit.identity, "MEME", count_meme_epochs);
    if (emitted < 0 || static_cast<uint32_t>(emitted) != response_frames) {
      reset_state();
      plugin_set_error("output-failed", "unable to emit a bounded FSB chunk");
      return 500;
    }
    emitted_frames += response_frames;
    ++emitted_objects;
    ++g_state.pending_next;
  }

  const size_t pending_backlog =
      g_state.pending.size() - g_state.pending_next;
  const uint32_t backlog = static_cast<uint32_t>(
      pending_backlog + (g_state.units.size() - g_state.next));
  plugin_set_backlog_remaining(backlog);
  plugin_set_yielded(backlog > 0 ? 1 : 0);
  if (backlog == 0) reset_state();
  return 0;
}
