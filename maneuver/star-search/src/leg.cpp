#include "leg.hpp"

#include <algorithm>
#include <cmath>

namespace star_search {
namespace {

struct StageRef {
    std::size_t row_index;
    double epoch;
    std::int64_t IE;
};

struct PairMeta {
    std::size_t dep_row;
    std::size_t arr_row;
};

Status collect_stage(
    const EncounterDB& encounters,
    std::uint32_t stage,
    MemoryBudget* budget,
    Buffer<StageRef>* output) {
    output->clear();
    for (std::size_t row = 0U; row < encounters.rows.size(); ++row) {
        if (encounters.rows[row].stage_id == static_cast<std::int32_t>(stage)) {
            const StageRef reference{row, encounters.rows[row].t_et_s, encounters.rows[row].IE};
            Status status = output->push_back(reference, encounters.rows.size(), budget);
            if (status != Status::Ok) {
                return status;
            }
        }
    }
    if (output->empty()) {
        return Status::InvalidInput;
    }
    std::sort(
        output->data(),
        output->data() + output->size(),
        [](const StageRef& left, const StageRef& right) {
            return left.epoch < right.epoch ||
                   (left.epoch == right.epoch && left.IE < right.IE);
        });
    return Status::Ok;
}

std::size_t lower_bound_epoch(const Buffer<StageRef>& rows, double value, bool strict) {
    std::size_t low = 0U;
    std::size_t high = rows.size();
    while (low < high) {
        const std::size_t middle = low + (high - low) / 2U;
        const bool before = strict ? rows[middle].epoch <= value : rows[middle].epoch < value;
        if (before) {
            low = middle + 1U;
        } else {
            high = middle;
        }
    }
    return low;
}

Status process_chunk(
    const Problem& problem,
    const EncounterDB& encounters,
    std::uint32_t leg_stage,
    const ThreadOptions& thread_options,
    Buffer<LambertInput>* inputs,
    const Buffer<PairMeta>& pairs,
    MemoryBudget* budget,
    Buffer<LambertSolution>* solutions,
    LegDB* output) {
    if (inputs->empty()) {
        return Status::Ok;
    }
    Status status = lambert_batch(
        inputs->data(),
        inputs->size(),
        problem.central_mu_km3_s2,
        problem.lambert_nrev_max[leg_stage],
        true,
        0.0,
        2e-2,
        1e-6,
        thread_options,
        problem.row_cap,
        budget,
        solutions);
    if (status != Status::Ok) {
        return status;
    }
    const double dep_min = problem.stages[leg_stage].vinf_min_km_s;
    const double dep_max = problem.stages[leg_stage].vinf_max_km_s;
    const double arr_min = problem.stages[leg_stage + 1U].vinf_min_km_s;
    const double arr_max = problem.stages[leg_stage + 1U].vinf_max_km_s;
    for (std::size_t solution_row = 0U; solution_row < solutions->size(); ++solution_row) {
        const LambertSolution& solution = (*solutions)[solution_row];
        if (solution.input_index >= pairs.size()) {
            return Status::InternalError;
        }
        const PairMeta& pair = pairs[solution.input_index];
        const EncounterRow& departure = encounters.rows[pair.dep_row];
        const EncounterRow& arrival = encounters.rows[pair.arr_row];
        const Vec3 vinf_d = subtract(solution.v1_km_s, departure.v_km_s);
        const Vec3 vinf_a = subtract(solution.v2_km_s, arrival.v_km_s);
        const double dep_sq = dot(vinf_d, vinf_d);
        const double arr_sq = dot(vinf_a, vinf_a);
        bool keep =
            std::isfinite(vinf_d.x) && std::isfinite(vinf_d.y) && std::isfinite(vinf_d.z) &&
            std::isfinite(vinf_a.x) && std::isfinite(vinf_a.y) && std::isfinite(vinf_a.z);
        if (std::isfinite(dep_min)) {
            keep = keep && dep_sq >= dep_min * dep_min;
        }
        if (std::isfinite(dep_max)) {
            keep = keep && dep_sq <= dep_max * dep_max;
        }
        if (std::isfinite(arr_min)) {
            keep = keep && arr_sq >= arr_min * arr_min;
        }
        if (std::isfinite(arr_max)) {
            keep = keep && arr_sq <= arr_max * arr_max;
        }
        if (!keep) {
            continue;
        }
        const LegRow row{
            static_cast<std::int64_t>(output->rows.size()),
            departure.IE,
            arrival.IE,
            vinf_d,
            vinf_a,
            static_cast<std::int32_t>(solution.nrev_signed),
            0.0,
            0.5,
        };
        status = output->rows.push_back(row, problem.row_cap, budget);
        if (status != Status::Ok) {
            return status;
        }
    }
    inputs->clear();
    return Status::Ok;
}

}  // namespace

Status build_leg_database(
    const Problem& problem,
    const EncounterDB& encounters,
    std::uint32_t leg_stage,
    const ThreadOptions& thread_options,
    MemoryBudget* budget,
    LegDB* output) {
    if (output == nullptr || budget == nullptr || leg_stage >= problem.leg_count ||
        problem.work_chunk_rows == 0U || problem.row_cap == 0U) {
        return Status::InvalidInput;
    }
    if (problem.null_legs[leg_stage]) {
        return Status::UnsupportedNullLeg;
    }
    if (problem.resonant_legs[leg_stage]) {
        return Status::UnsupportedResonant;
    }
    if (problem.dv_lev_max_km_s[leg_stage] != 0.0) {
        return Status::UnsupportedDsm;
    }
    const double tof_min = problem.tof_min_s[leg_stage][leg_stage + 1U];
    const double tof_max = problem.tof_max_s[leg_stage][leg_stage + 1U];
    if (std::isfinite(tof_min) && std::isfinite(tof_max) && tof_max < tof_min) {
        return Status::InvalidInput;
    }
    if (problem.lambert_hz[leg_stage] < -1 || problem.lambert_hz[leg_stage] > 1 ||
        problem.lambert_nrev_max[leg_stage] < 0) {
        return Status::InvalidInput;
    }

    output->stage_id = static_cast<std::int32_t>(leg_stage);
    output->rows.clear();
    Buffer<StageRef> departures;
    Buffer<StageRef> arrivals;
    Status status = collect_stage(encounters, leg_stage, budget, &departures);
    if (status != Status::Ok) {
        return status;
    }
    status = collect_stage(encounters, leg_stage + 1U, budget, &arrivals);
    if (status != Status::Ok) {
        return status;
    }

    Buffer<LambertInput> inputs;
    Buffer<PairMeta> pairs;
    Buffer<LambertSolution> solutions;
    status = inputs.reserve(problem.work_chunk_rows, budget);
    if (status != Status::Ok) {
        return status;
    }
    status = pairs.reserve(problem.work_chunk_rows, budget);
    if (status != Status::Ok) {
        return status;
    }

    constexpr double positive_tolerance = 1e-6;
    const double lower =
        std::isfinite(tof_min) ? std::max(positive_tolerance, tof_min) : positive_tolerance;
    const bool lower_strict = !std::isfinite(tof_min) || tof_min <= positive_tolerance;
    for (std::size_t dep_index = 0U; dep_index < departures.size(); ++dep_index) {
        const StageRef& dep_ref = departures[dep_index];
        const double lower_epoch = dep_ref.epoch + lower;
        const std::size_t first = lower_bound_epoch(arrivals, lower_epoch, lower_strict);
        const std::size_t last = std::isfinite(tof_max)
                                     ? lower_bound_epoch(arrivals, dep_ref.epoch + tof_max, true)
                                     : arrivals.size();
        for (std::size_t arr_index = first; arr_index < last; ++arr_index) {
            const EncounterRow& dep = encounters.rows[dep_ref.row_index];
            const EncounterRow& arr = encounters.rows[arrivals[arr_index].row_index];
            const LambertInput input{
                dep.r_km,
                arr.r_km,
                arr.t_et_s - dep.t_et_s,
                problem.lambert_hz[leg_stage],
            };
            const PairMeta pair{dep_ref.row_index, arrivals[arr_index].row_index};
            status = inputs.push_back(input, problem.work_chunk_rows, budget);
            if (status != Status::Ok) {
                return status;
            }
            status = pairs.push_back(pair, problem.work_chunk_rows, budget);
            if (status != Status::Ok) {
                return status;
            }
            if (inputs.size() == problem.work_chunk_rows) {
                status = process_chunk(
                    problem,
                    encounters,
                    leg_stage,
                    thread_options,
                    &inputs,
                    pairs,
                    budget,
                    &solutions,
                    output);
                if (status != Status::Ok) {
                    return status;
                }
                pairs.clear();
            }
        }
    }
    return process_chunk(
        problem,
        encounters,
        leg_stage,
        thread_options,
        &inputs,
        pairs,
        budget,
        &solutions,
        output);
}

}  // namespace star_search
