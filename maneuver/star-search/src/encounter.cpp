#include "encounter.hpp"

#include <cmath>

namespace star_search {

Status make_time_grid_count(
    double t_min_et_s,
    double t_max_et_s,
    double dt_et_s,
    std::size_t row_cap,
    std::size_t* count) {
    if (count == nullptr || !std::isfinite(t_min_et_s) || !std::isfinite(t_max_et_s) ||
        !std::isfinite(dt_et_s) || !(dt_et_s > 0.0) || t_max_et_s < t_min_et_s ||
        row_cap == 0U) {
        return Status::InvalidInput;
    }
    const double k_max_double =
        std::floor((t_max_et_s - t_min_et_s) / dt_et_s + 1e-12);
    if (k_max_double < 0.0 ||
        k_max_double > static_cast<double>(static_cast<std::size_t>(-1) - 1U)) {
        return Status::InvalidInput;
    }
    const std::size_t candidate_count = static_cast<std::size_t>(k_max_double) + 1U;
    if (candidate_count > row_cap) {
        return Status::RowLimitExceeded;
    }
    std::size_t retained = 0U;
    for (std::size_t k = 0U; k < candidate_count; ++k) {
        const double epoch = t_min_et_s + dt_et_s * static_cast<double>(k);
        if (epoch <= t_max_et_s + 1e-9) {
            ++retained;
        }
    }
    *count = retained;
    return Status::Ok;
}

Status build_encounter_database(
    const Problem& problem,
    const Ephemeris& ephemeris,
    std::size_t row_cap,
    MemoryBudget* budget,
    EncounterDB* output) {
    if (output == nullptr || budget == nullptr || problem.stage_count < 2U ||
        problem.stage_count > kMaxStages || row_cap == 0U) {
        return Status::InvalidInput;
    }
    output->rows.clear();
    std::int64_t next_ie = 0;
    for (std::uint32_t stage_id = 0U; stage_id < problem.stage_count; ++stage_id) {
        const StageConfig& stage = problem.stages[stage_id];
        if (stage.body_count == 0U || stage.body_count > kMaxBodiesPerStage) {
            return Status::InvalidInput;
        }
        std::size_t epoch_count = 0U;
        Status status = make_time_grid_count(
            stage.t_min_et_s,
            stage.t_max_et_s,
            stage.dt_et_s,
            row_cap,
            &epoch_count);
        if (status != Status::Ok) {
            return status;
        }
        std::size_t stage_row_count = 0U;
        std::size_t total_row_count = 0U;
        if (!checked_multiply(
                epoch_count,
                static_cast<std::size_t>(stage.body_count),
                &stage_row_count) ||
            !checked_add(output->rows.size(), stage_row_count, &total_row_count) ||
            total_row_count > row_cap) {
            return Status::RowLimitExceeded;
        }
        for (std::uint32_t body_index = 0U; body_index < stage.body_count; ++body_index) {
            const std::int32_t body_id = stage.bodies[body_index];
            double gm = 0.0;
            double radius = 0.0;
            status = ephemeris_body_constants(ephemeris, body_id, &gm, &radius);
            if (status != Status::Ok) {
                return status;
            }
            for (std::size_t k = 0U; k < epoch_count; ++k) {
                const double epoch =
                    stage.t_min_et_s + stage.dt_et_s * static_cast<double>(k);
                if (!(epoch <= stage.t_max_et_s + 1e-9)) {
                    continue;
                }
                State6 state{};
                status = query_ephemeris(ephemeris, body_id, epoch, &state);
                if (status != Status::Ok) {
                    return status;
                }
                const EncounterRow row{
                    next_ie,
                    static_cast<std::int32_t>(stage_id),
                    epoch,
                    body_id,
                    state.position_km,
                    state.velocity_km_s,
                    gm,
                    radius + stage.altitude_km[body_index],
                };
                status = output->rows.push_back(row, row_cap, budget);
                if (status != Status::Ok) {
                    return status;
                }
                ++next_ie;
            }
        }
    }
    return Status::Ok;
}

}  // namespace star_search
