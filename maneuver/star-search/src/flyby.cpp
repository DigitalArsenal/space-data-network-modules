#include "flyby.hpp"

#include <algorithm>
#include <cmath>

namespace star_search {
namespace {

struct LegIndexRef {
    std::int64_t IE;
    std::int64_t IL;
    std::size_t row;
};

struct PairTask {
    std::size_t incoming_row;
    std::size_t outgoing_row;
    std::size_t encounter_row;
};

struct PairResult {
    bool valid;
    double dv_km_s;
};

const EncounterRow* find_encounter(const EncounterDB& encounters, std::int64_t IE) {
    std::size_t low = 0U;
    std::size_t high = encounters.rows.size();
    while (low < high) {
        const std::size_t middle = low + (high - low) / 2U;
        if (encounters.rows[middle].IE < IE) {
            low = middle + 1U;
        } else {
            high = middle;
        }
    }
    return low < encounters.rows.size() && encounters.rows[low].IE == IE
               ? &encounters.rows[low]
               : nullptr;
}

Status build_index(
    const LegDB& leg,
    bool use_arrival,
    MemoryBudget* budget,
    Buffer<LegIndexRef>* output) {
    Status status = output->resize(leg.rows.size(), budget);
    if (status != Status::Ok) {
        return status;
    }
    for (std::size_t row = 0U; row < leg.rows.size(); ++row) {
        (*output)[row] = LegIndexRef{
            use_arrival ? leg.rows[row].IA : leg.rows[row].ID,
            leg.rows[row].IL,
            row,
        };
    }
    std::sort(
        output->data(),
        output->data() + output->size(),
        [](const LegIndexRef& left, const LegIndexRef& right) {
            return left.IE < right.IE || (left.IE == right.IE && left.IL < right.IL);
        });
    return Status::Ok;
}

std::size_t lower_ie(const Buffer<LegIndexRef>& index, std::int64_t IE) {
    std::size_t low = 0U;
    std::size_t high = index.size();
    while (low < high) {
        const std::size_t middle = low + (high - low) / 2U;
        if (index[middle].IE < IE) {
            low = middle + 1U;
        } else {
            high = middle;
        }
    }
    return low;
}

struct WorkerContext {
    const Problem* problem;
    const EncounterDB* encounters;
    const LegDB* incoming;
    const LegDB* outgoing;
    const PairTask* tasks;
    PairResult* results;
    std::uint32_t stage;
};

void evaluate_range(std::size_t begin, std::size_t end, void* raw) {
    WorkerContext* context = static_cast<WorkerContext*>(raw);
    constexpr double eps = 1e-12;
    const FlybyStageConfig& config = context->problem->flybys[context->stage];
    for (std::size_t task_row = begin; task_row < end; ++task_row) {
        PairResult& result = context->results[task_row];
        result.valid = false;
        const PairTask& task = context->tasks[task_row];
        const LegRow& incoming = context->incoming->rows[task.incoming_row];
        const LegRow& outgoing = context->outgoing->rows[task.outgoing_row];
        const EncounterRow& encounter = context->encounters->rows[task.encounter_row];
        const EncounterRow* departure = find_encounter(*context->encounters, incoming.ID);
        const EncounterRow* arrival = find_encounter(*context->encounters, outgoing.IA);
        if (departure == nullptr || arrival == nullptr) {
            continue;
        }
        const double trip_tof = arrival->t_et_s - departure->t_et_s;
        if ((std::isfinite(config.trip_tof_min_s) && trip_tof < config.trip_tof_min_s) ||
            (std::isfinite(config.trip_tof_max_s) && trip_tof > config.trip_tof_max_s)) {
            continue;
        }
        const double vin = norm(incoming.vinfA_km_s);
        const double vout = norm(outgoing.vinfD_km_s);
        if (!(vin > eps) || !(vout > eps) || !(encounter.mu_km3_s2 > eps) ||
            !(encounter.rmin_km > eps)) {
            continue;
        }
        const double cap = config.dv_patch_max_km_s;
        const double cap_with_eps = cap + eps;
        if (std::isfinite(cap) && std::abs(vin - vout) > cap_with_eps) {
            continue;
        }
        const double cosine =
            std::max(-1.0, std::min(1.0, dot(incoming.vinfA_km_s, outgoing.vinfD_km_s) /
                                                   (vin * vout)));
        const double theta = std::acos(cosine);
        double delta_max = 0.0;
        if (encounter.mu_km3_s2 >= 1.0) {
            const double minimum_vinf = std::min(vin, vout);
            const double bend =
                std::max(
                    -1.0,
                    std::min(
                        1.0,
                        1.0 /
                            (1.0 +
                             minimum_vinf * minimum_vinf *
                                 (encounter.rmin_km / encounter.mu_km3_s2))));
            delta_max = 2.0 * std::asin(bend);
        }
        const double beta = std::max(0.0, theta - delta_max);
        const double dv_squared =
            (vin - vout) * (vin - vout) +
            2.0 * (1.0 - std::cos(beta)) * vin * vout;
        const double dv = std::sqrt(std::max(0.0, dv_squared));
        if (!std::isfinite(dv) || (std::isfinite(cap) && dv > cap_with_eps)) {
            continue;
        }
        result.valid = true;
        result.dv_km_s = dv;
    }
}

Status process_pairs(
    const Problem& problem,
    const EncounterDB& encounters,
    const LegDB& incoming,
    const LegDB& outgoing,
    std::uint32_t stage,
    std::int64_t if_start,
    const ThreadOptions& thread_options,
    Buffer<PairTask>* tasks,
    MemoryBudget* budget,
    Buffer<PairResult>* results,
    FlybyDB* output) {
    if (tasks->empty()) {
        return Status::Ok;
    }
    Status status = results->resize(tasks->size(), budget);
    if (status != Status::Ok) {
        return status;
    }
    WorkerContext context{
        &problem,
        &encounters,
        &incoming,
        &outgoing,
        tasks->data(),
        results->data(),
        stage,
    };
    status = parallel_for_fixed(tasks->size(), thread_options, evaluate_range, &context);
    if (status != Status::Ok) {
        return status;
    }
    for (std::size_t row = 0U; row < tasks->size(); ++row) {
        if (!(*results)[row].valid) {
            continue;
        }
        const PairTask& task = (*tasks)[row];
        const FlybyRow output_row{
            if_start + static_cast<std::int64_t>(output->rows.size()),
            encounters.rows[task.encounter_row].IE,
            incoming.rows[task.incoming_row].IL,
            outgoing.rows[task.outgoing_row].IL,
            (*results)[row].dv_km_s,
        };
        status = output->rows.push_back(output_row, problem.row_cap, budget);
        if (status != Status::Ok) {
            return status;
        }
    }
    tasks->clear();
    return Status::Ok;
}

}  // namespace

double compute_parabolic_escape_dv(double vinf, double mu, double rmin) {
    if (!std::isfinite(vinf) || !std::isfinite(mu) || !std::isfinite(rmin) || vinf < 0.0 ||
        mu <= 0.0 || rmin <= 0.0) {
        return 0.0;
    }
    const double base = 2.0 * mu / rmin;
    if (base <= 0.0) {
        return 0.0;
    }
    return std::sqrt(vinf * vinf + base) - std::sqrt(base);
}

Status build_flyby_database(
    const Problem& problem,
    const EncounterDB& encounters,
    const LegDB& incoming,
    const LegDB& outgoing,
    std::uint32_t stage,
    std::int64_t if_start,
    const ThreadOptions& thread_options,
    MemoryBudget* budget,
    FlybyDB* output) {
    if (budget == nullptr || output == nullptr || stage == 0U ||
        stage + 1U >= problem.stage_count || incoming.stage_id != static_cast<std::int32_t>(stage - 1U) ||
        outgoing.stage_id != static_cast<std::int32_t>(stage) || if_start < 0 ||
        problem.row_cap == 0U || problem.work_chunk_rows == 0U) {
        return Status::InvalidInput;
    }
    const FlybyStageConfig& config = problem.flybys[stage];
    if (std::isfinite(config.trip_tof_min_s) && std::isfinite(config.trip_tof_max_s) &&
        config.trip_tof_max_s < config.trip_tof_min_s) {
        return Status::InvalidInput;
    }
    if (std::isnan(config.dv_patch_max_km_s) || config.dv_patch_max_km_s < 0.0) {
        return Status::InvalidInput;
    }
    output->stage_id = static_cast<std::int32_t>(stage);
    output->rows.clear();

    Buffer<LegIndexRef> incoming_index;
    Buffer<LegIndexRef> outgoing_index;
    Status status = build_index(incoming, true, budget, &incoming_index);
    if (status != Status::Ok) {
        return status;
    }
    status = build_index(outgoing, false, budget, &outgoing_index);
    if (status != Status::Ok) {
        return status;
    }
    Buffer<PairTask> tasks;
    Buffer<PairResult> results;
    status = tasks.reserve(problem.work_chunk_rows, budget);
    if (status != Status::Ok) {
        return status;
    }

    for (std::size_t encounter_row = 0U; encounter_row < encounters.rows.size(); ++encounter_row) {
        const EncounterRow& encounter = encounters.rows[encounter_row];
        if (encounter.stage_id != static_cast<std::int32_t>(stage)) {
            continue;
        }
        const std::size_t in_begin = lower_ie(incoming_index, encounter.IE);
        std::size_t in_end = in_begin;
        while (in_end < incoming_index.size() && incoming_index[in_end].IE == encounter.IE) {
            ++in_end;
        }
        const std::size_t out_begin = lower_ie(outgoing_index, encounter.IE);
        std::size_t out_end = out_begin;
        while (out_end < outgoing_index.size() && outgoing_index[out_end].IE == encounter.IE) {
            ++out_end;
        }
        if (in_begin == in_end || out_begin == out_end) {
            continue;
        }
        for (std::size_t in_row = in_begin; in_row < in_end; ++in_row) {
            for (std::size_t out_row = out_begin; out_row < out_end; ++out_row) {
                const PairTask task{
                    incoming_index[in_row].row,
                    outgoing_index[out_row].row,
                    encounter_row,
                };
                status = tasks.push_back(task, problem.work_chunk_rows, budget);
                if (status != Status::Ok) {
                    return status;
                }
                if (tasks.size() == problem.work_chunk_rows) {
                    status = process_pairs(
                        problem,
                        encounters,
                        incoming,
                        outgoing,
                        stage,
                        if_start,
                        thread_options,
                        &tasks,
                        budget,
                        &results,
                        output);
                    if (status != Status::Ok) {
                        return status;
                    }
                }
            }
        }
    }
    return process_pairs(
        problem,
        encounters,
        incoming,
        outgoing,
        stage,
        if_start,
        thread_options,
        &tasks,
        budget,
        &results,
        output);
}

}  // namespace star_search
