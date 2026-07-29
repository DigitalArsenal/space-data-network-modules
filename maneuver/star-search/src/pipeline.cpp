#include "pipeline.hpp"

#include "encounter.hpp"

#include <cmath>

namespace star_search {
namespace {

std::size_t count_stage_encounters(const EncounterDB& encounters, std::uint32_t stage) {
    std::size_t count = 0U;
    for (std::size_t row = 0U; row < encounters.rows.size(); ++row) {
        if (encounters.rows[row].stage_id == static_cast<std::int32_t>(stage)) {
            ++count;
        }
    }
    return count;
}

double leg_weight(
    const Problem& problem,
    const EncounterDB& encounters,
    std::uint32_t leg_stage) {
    double first_time = INFINITY;
    double last_time = -INFINITY;
    for (std::size_t row = 0U; row < encounters.rows.size(); ++row) {
        const std::int32_t stage = encounters.rows[row].stage_id;
        if (stage == static_cast<std::int32_t>(leg_stage)) {
            if (encounters.rows[row].t_et_s < first_time) {
                first_time = encounters.rows[row].t_et_s;
            }
        }
        if (stage == static_cast<std::int32_t>(leg_stage + 1U)) {
            if (encounters.rows[row].t_et_s > last_time) {
                last_time = encounters.rows[row].t_et_s;
            }
        }
    }
    const double tof_window = std::fmax(
        problem.tof_max_s[leg_stage][leg_stage + 1U] -
            problem.tof_min_s[leg_stage][leg_stage + 1U],
        0.0);
    const double time_span = std::fmax(last_time - first_time, 1.0);
    const double lambert_count =
        static_cast<double>(2 * (problem.lambert_nrev_max[leg_stage] + 1));
    double leveraging = 1.0;
    const double delta = problem.delta_dv_lev_km_s[leg_stage];
    const double maximum = problem.dv_lev_max_km_s[leg_stage];
    if (delta > 0.0 && maximum > 0.0) {
        leveraging += 5.0 * maximum / delta;
    }
    return lambert_count * (tof_window / time_span) * leveraging;
}

Status validate_problem(const Problem& problem) {
    if (problem.stage_count < 3U || problem.stage_count > kMaxStages ||
        problem.leg_count + 1U != problem.stage_count || problem.row_cap == 0U ||
        problem.memory_cap_bytes == 0U ||
        problem.memory_cap_bytes > kWasmMaximumMemoryBytes ||
        problem.work_chunk_rows == 0U || !(problem.central_mu_km3_s2 > 0.0) ||
        !std::isfinite(problem.central_mu_km3_s2) ||
        std::isnan(problem.dv_total_max_km_s) || problem.dv_total_max_km_s < 0.0 ||
        (problem.tfilter_preemptive && !problem.tfilter_enabled)) {
        return Status::InvalidInput;
    }
    for (std::uint32_t stage = 0U; stage < problem.stage_count; ++stage) {
        const StageConfig& config = problem.stages[stage];
        if (config.body_count == 0U || config.body_count > kMaxBodiesPerStage ||
            !std::isfinite(config.t_min_et_s) || !std::isfinite(config.t_max_et_s) ||
            config.t_max_et_s < config.t_min_et_s || !(config.dt_et_s > 0.0) ||
            !std::isfinite(config.dt_et_s) || std::isnan(config.vinf_min_km_s) ||
            std::isnan(config.vinf_max_km_s) || config.vinf_min_km_s < 0.0 ||
            config.vinf_max_km_s < config.vinf_min_km_s) {
            return Status::InvalidInput;
        }
        for (std::uint32_t body = 0U; body < config.body_count; ++body) {
            if (!std::isfinite(config.altitude_km[body])) {
                return Status::InvalidInput;
            }
        }
        if (problem.tfilter_enabled &&
            (!(problem.tfilter_dt_s[stage] > 0.0) ||
             !std::isfinite(problem.tfilter_dt_s[stage]))) {
            return Status::InvalidInput;
        }
    }
    for (std::uint32_t leg = 0U; leg < problem.leg_count; ++leg) {
        const double tof_min = problem.tof_min_s[leg][leg + 1U];
        const double tof_max = problem.tof_max_s[leg][leg + 1U];
        if (std::isnan(tof_min) || std::isnan(tof_max) ||
            (std::isfinite(tof_min) && std::isfinite(tof_max) && tof_max < tof_min) ||
            problem.lambert_nrev_max[leg] < 0 || problem.lambert_hz[leg] < -1 ||
            problem.lambert_hz[leg] > 1 || std::isnan(problem.dv_lev_max_km_s[leg]) ||
            problem.dv_lev_max_km_s[leg] < 0.0 ||
            std::isnan(problem.delta_dv_lev_km_s[leg]) ||
            problem.delta_dv_lev_km_s[leg] < 0.0 ||
            std::isnan(problem.vinf_margin_pre_filter_km_s[leg])) {
            return Status::InvalidInput;
        }
        if (problem.null_legs[leg]) {
            return Status::UnsupportedNullLeg;
        }
        if (problem.resonant_legs[leg]) {
            return Status::UnsupportedResonant;
        }
        if (problem.dv_lev_max_km_s[leg] != 0.0) {
            return Status::UnsupportedDsm;
        }
    }
    for (std::uint32_t stage = 1U; stage < problem.leg_count; ++stage) {
        const FlybyStageConfig& flyby = problem.flybys[stage];
        if (std::isnan(flyby.trip_tof_min_s) || std::isnan(flyby.trip_tof_max_s) ||
            (std::isfinite(flyby.trip_tof_min_s) &&
             std::isfinite(flyby.trip_tof_max_s) &&
             flyby.trip_tof_max_s < flyby.trip_tof_min_s) ||
            std::isnan(flyby.dv_patch_max_km_s) || flyby.dv_patch_max_km_s < 0.0) {
            return Status::InvalidInput;
        }
    }
    return Status::Ok;
}

}  // namespace

Status run_star_search(
    const Problem& problem,
    const Ephemeris& ephemeris,
    const ThreadOptions& thread_options,
    MemoryBudget* budget,
    OutputDB* output,
    StageCounts* counts) {
    if (budget == nullptr || output == nullptr || counts == nullptr) {
        return Status::InvalidInput;
    }
    if (budget->limit_bytes() > problem.memory_cap_bytes ||
        budget->limit_bytes() > kWasmMaximumMemoryBytes) {
        return Status::InvalidInput;
    }
    Status status = validate_problem(problem);
    if (status != Status::Ok) {
        return status;
    }
    *counts = StageCounts{};
    output->rows.clear();

    EncounterDB encounters;
    status = build_encounter_database(
        problem,
        ephemeris,
        problem.row_cap,
        budget,
        &encounters);
    if (status != Status::Ok) {
        return status;
    }
    counts->encounter_rows = encounters.rows.size();

    LegDB legs[kMaxStages];
    FlybyDB flybys[kMaxStages];
    LegDB* leg_ptrs[kMaxStages]{};
    FlybyDB* flyby_ptrs[kMaxStages]{};
    bool unbuilt[kMaxStages]{};
    double weights[kMaxStages]{};
    for (std::uint32_t leg = 0U; leg < problem.leg_count; ++leg) {
        unbuilt[leg] = true;
        weights[leg] = leg_weight(problem, encounters, leg);
    }

    std::uint32_t remaining = problem.leg_count;
    std::int64_t next_if = 0;
    while (remaining > 0U) {
        std::uint32_t selected = problem.leg_count;
        double selected_cost = INFINITY;
        for (std::uint32_t leg = 0U; leg < problem.leg_count; ++leg) {
            if (!unbuilt[leg]) {
                continue;
            }
            const double cost =
                static_cast<double>(count_stage_encounters(encounters, leg)) *
                static_cast<double>(count_stage_encounters(encounters, leg + 1U)) *
                weights[leg];
            if (selected == problem.leg_count || cost < selected_cost) {
                selected = leg;
                selected_cost = cost;
            }
        }
        if (selected >= problem.leg_count) {
            return Status::InternalError;
        }

        status = build_leg_database(
            problem,
            encounters,
            selected,
            thread_options,
            budget,
            &legs[selected]);
        if (status != Status::Ok) {
            return status;
        }
        leg_ptrs[selected] = &legs[selected];
        counts->leg_rows[selected] = legs[selected].rows.size();
        unbuilt[selected] = false;
        --remaining;

        bool safe_candidate_stages[kMaxStages]{};
        for (std::uint32_t offset = 0U; offset < 2U; ++offset) {
            const std::uint32_t stage = selected + offset;
            if (stage >= problem.stage_count) {
                continue;
            }
            const bool incoming_ok = stage == 0U || !unbuilt[stage - 1U];
            const bool outgoing_ok =
                stage + 1U == problem.stage_count || !unbuilt[stage];
            safe_candidate_stages[stage] = incoming_ok && outgoing_ok;
        }
        std::size_t safe_removed = 0U;
        status = filter_encounter_stages_from_active_legs(
            &encounters,
            leg_ptrs,
            problem.leg_count,
            safe_candidate_stages,
            budget,
            &safe_removed);
        if (status != Status::Ok) {
            return status;
        }

        for (std::uint32_t candidate_index = 0U; candidate_index < 2U; ++candidate_index) {
            const std::int64_t stage_signed =
                static_cast<std::int64_t>(selected) + static_cast<std::int64_t>(candidate_index);
            if (stage_signed <= 0 ||
                stage_signed >= static_cast<std::int64_t>(problem.leg_count)) {
                continue;
            }
            const std::uint32_t stage = static_cast<std::uint32_t>(stage_signed);
            if (flyby_ptrs[stage] != nullptr || leg_ptrs[stage - 1U] == nullptr ||
                leg_ptrs[stage] == nullptr) {
                continue;
            }
            status = build_flyby_database(
                problem,
                encounters,
                *leg_ptrs[stage - 1U],
                *leg_ptrs[stage],
                stage,
                next_if,
                thread_options,
                budget,
                &flybys[stage]);
            if (status != Status::Ok) {
                return status;
            }
            flyby_ptrs[stage] = &flybys[stage];
            counts->flyby_rows[stage] = flybys[stage].rows.size();
            next_if += static_cast<std::int64_t>(flybys[stage].rows.size());

            std::size_t local_passes = 0U;
            std::size_t local_removed = 0U;
            status = run_leg_filter_fixpoint(
                &encounters,
                leg_ptrs,
                flyby_ptrs,
                problem.leg_count,
                budget,
                &local_passes,
                &local_removed);
            if (status != Status::Ok) {
                return status;
            }

            bool all_safe_stages[kMaxStages]{};
            for (std::uint32_t encounter_stage = 0U;
                 encounter_stage < problem.stage_count;
                 ++encounter_stage) {
                const bool incoming_ok =
                    encounter_stage == 0U || !unbuilt[encounter_stage - 1U];
                const bool outgoing_ok =
                    encounter_stage + 1U == problem.stage_count ||
                    !unbuilt[encounter_stage];
                all_safe_stages[encounter_stage] = incoming_ok && outgoing_ok;
            }
            status = filter_encounter_stages_from_active_legs(
                &encounters,
                leg_ptrs,
                problem.leg_count,
                all_safe_stages,
                budget,
                &safe_removed);
            if (status != Status::Ok) {
                return status;
            }
        }
    }

    status = run_leg_filter_fixpoint(
        &encounters,
        leg_ptrs,
        flyby_ptrs,
        problem.leg_count,
        budget,
        &counts->fixpoint_passes,
        &counts->fixpoint_removed);
    if (status != Status::Ok) {
        return status;
    }

    status = run_combo(
        problem,
        encounters,
        leg_ptrs,
        flyby_ptrs,
        budget,
        output,
        counts);
    if (status != Status::Ok) {
        return status;
    }
    if (problem.tfilter_enabled && !problem.tfilter_preemptive) {
        status = tfilter_output_db(
            problem,
            budget,
            output,
            &counts->tfilter_bins);
        if (status != Status::Ok) {
            return status;
        }
    } else if (problem.tfilter_enabled) {
        counts->tfilter_bins = output->rows.size();
    }
    counts->output_rows = output->rows.size();
    counts->peak_memory_bytes = budget->peak_bytes();
    return Status::Ok;
}

}  // namespace star_search
