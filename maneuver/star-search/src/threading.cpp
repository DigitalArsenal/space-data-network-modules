#include "threading.hpp"

#include <pthread.h>

namespace star_search {
namespace {

struct RangeJob {
    std::size_t begin;
    std::size_t end;
    RangeFunction function;
    void* context;
};

void* run_job(void* raw) {
    RangeJob* job = static_cast<RangeJob*>(raw);
    job->function(job->begin, job->end, job->context);
    return nullptr;
}

}  // namespace

Status parallel_for_fixed(
    std::size_t row_count,
    const ThreadOptions& options,
    RangeFunction function,
    void* context) {
    if (function == nullptr) {
        return Status::InvalidInput;
    }
    if (row_count == 0U) {
        return Status::Ok;
    }

    std::uint32_t count = options.requested_threads == 0U ? 1U : options.requested_threads;
    if (count > kMaxThreads) {
        count = kMaxThreads;
    }
    if (static_cast<std::size_t>(count) > row_count) {
        count = static_cast<std::uint32_t>(row_count);
    }

    RangeJob jobs[kMaxThreads]{};
    pthread_t threads[kMaxThreads]{};
    bool spawned[kMaxThreads]{};

    const std::size_t rows_per_range = row_count / count;
    const std::size_t extra_ranges = row_count % count;
    for (std::uint32_t range = 0U; range < count; ++range) {
        const std::size_t range_index = static_cast<std::size_t>(range);
        jobs[range].begin =
            rows_per_range * range_index +
            (range_index < extra_ranges ? range_index : extra_ranges);
        jobs[range].end =
            jobs[range].begin + rows_per_range + (range_index < extra_ranges ? 1U : 0U);
        jobs[range].function = function;
        jobs[range].context = context;

        int rc = -1;
        if (!options.force_spawn_failure && count > 1U) {
            rc = pthread_create(&threads[range], nullptr, run_job, &jobs[range]);
        }
        if (rc == 0) {
            spawned[range] = true;
        } else {
            run_job(&jobs[range]);
        }
    }

    Status result = Status::Ok;
    for (std::uint32_t range = 0U; range < count; ++range) {
        if (spawned[range] && pthread_join(threads[range], nullptr) != 0) {
            result = Status::ThreadJoinFailed;
        }
    }
    return result;
}

}  // namespace star_search
