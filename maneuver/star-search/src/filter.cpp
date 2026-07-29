#include "filter.hpp"

#include <cstdint>
#include <limits>

namespace star_search {
namespace {

Status membership_size(std::int64_t maximum, std::size_t* size) {
    if (size == nullptr || maximum < 0) {
        return Status::InvalidInput;
    }
    const std::uint64_t unsigned_maximum = static_cast<std::uint64_t>(maximum);
    if (unsigned_maximum >= static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
        return Status::InvalidInput;
    }
    *size = static_cast<std::size_t>(unsigned_maximum) + 1U;
    return Status::Ok;
}

Status filter_leg_by_flyby(
    LegDB* leg,
    const FlybyDB& flyby,
    bool use_incoming_column,
    MemoryBudget* budget,
    std::size_t* removed) {
    if (leg == nullptr || budget == nullptr || removed == nullptr) {
        return Status::InvalidInput;
    }
    *removed = 0U;
    if (leg->rows.empty()) {
        return Status::Ok;
    }

    std::int64_t maximum_il = -1;
    for (std::size_t row = 0U; row < leg->rows.size(); ++row) {
        const std::int64_t il = leg->rows[row].IL;
        if (il < 0) {
            return Status::InternalError;
        }
        if (il > maximum_il) {
            maximum_il = il;
        }
    }

    std::size_t mask_size = 0U;
    Status status = membership_size(maximum_il, &mask_size);
    if (status != Status::Ok) {
        return status;
    }
    Buffer<std::uint8_t> keep;
    status = keep.resize(mask_size, budget);
    if (status != Status::Ok) {
        return status;
    }
    for (std::size_t row = 0U; row < flyby.rows.size(); ++row) {
        const std::int64_t il =
            use_incoming_column ? flyby.rows[row].IL_in : flyby.rows[row].IL_out;
        if (il >= 0 && static_cast<std::uint64_t>(il) < static_cast<std::uint64_t>(mask_size)) {
            keep[static_cast<std::size_t>(il)] = 1U;
        }
    }

    const std::size_t before = leg->rows.size();
    std::size_t write = 0U;
    for (std::size_t read = 0U; read < before; ++read) {
        const LegRow& candidate = leg->rows[read];
        if (keep[static_cast<std::size_t>(candidate.IL)] != 0U) {
            if (write != read) {
                leg->rows[write] = candidate;
            }
            ++write;
        }
    }
    status = leg->rows.resize(write, budget);
    if (status != Status::Ok) {
        return status;
    }
    *removed = before - write;
    return Status::Ok;
}

Status filter_flyby_by_leg(
    FlybyDB* flyby,
    const LegDB& leg,
    bool use_incoming_column,
    MemoryBudget* budget,
    std::size_t* removed) {
    if (flyby == nullptr || budget == nullptr || removed == nullptr) {
        return Status::InvalidInput;
    }
    *removed = 0U;
    if (flyby->rows.empty()) {
        return Status::Ok;
    }

    std::int64_t maximum_il = -1;
    for (std::size_t row = 0U; row < leg.rows.size(); ++row) {
        if (leg.rows[row].IL < 0) {
            return Status::InternalError;
        }
        if (leg.rows[row].IL > maximum_il) {
            maximum_il = leg.rows[row].IL;
        }
    }
    if (maximum_il < 0) {
        *removed = flyby->rows.size();
        flyby->rows.clear();
        return Status::Ok;
    }

    std::size_t mask_size = 0U;
    Status status = membership_size(maximum_il, &mask_size);
    if (status != Status::Ok) {
        return status;
    }
    Buffer<std::uint8_t> keep;
    status = keep.resize(mask_size, budget);
    if (status != Status::Ok) {
        return status;
    }
    for (std::size_t row = 0U; row < leg.rows.size(); ++row) {
        keep[static_cast<std::size_t>(leg.rows[row].IL)] = 1U;
    }

    const std::size_t before = flyby->rows.size();
    std::size_t write = 0U;
    for (std::size_t read = 0U; read < before; ++read) {
        const FlybyRow& candidate = flyby->rows[read];
        const std::int64_t il = use_incoming_column ? candidate.IL_in : candidate.IL_out;
        if (il >= 0 &&
            static_cast<std::uint64_t>(il) < static_cast<std::uint64_t>(mask_size) &&
            keep[static_cast<std::size_t>(il)] != 0U) {
            if (write != read) {
                flyby->rows[write] = candidate;
            }
            ++write;
        }
    }
    status = flyby->rows.resize(write, budget);
    if (status != Status::Ok) {
        return status;
    }
    *removed = before - write;
    return Status::Ok;
}

Status filter_encounters_for_stages(
    EncounterDB* encounters,
    LegDB* leg_dbs[kMaxStages],
    std::uint32_t leg_count,
    const bool stages_to_filter[kMaxStages],
    MemoryBudget* budget,
    std::size_t* removed) {
    if (encounters == nullptr || leg_dbs == nullptr || budget == nullptr || removed == nullptr ||
        stages_to_filter == nullptr) {
        return Status::InvalidInput;
    }
    *removed = 0U;
    if (encounters->rows.empty()) {
        return Status::Ok;
    }

    std::int64_t maximum_ie = -1;
    for (std::size_t row = 0U; row < encounters->rows.size(); ++row) {
        if (encounters->rows[row].IE < 0) {
            return Status::InternalError;
        }
        if (encounters->rows[row].IE > maximum_ie) {
            maximum_ie = encounters->rows[row].IE;
        }
    }
    std::size_t mask_size = 0U;
    Status status = membership_size(maximum_ie, &mask_size);
    if (status != Status::Ok) {
        return status;
    }
    Buffer<std::uint8_t> used;
    status = used.resize(mask_size, budget);
    if (status != Status::Ok) {
        return status;
    }

    for (std::uint32_t leg_stage = 0U; leg_stage < leg_count; ++leg_stage) {
        const LegDB* leg = leg_dbs[leg_stage];
        if (leg == nullptr) {
            continue;
        }
        for (std::size_t row = 0U; row < leg->rows.size(); ++row) {
            if (stages_to_filter[leg_stage]) {
                const std::int64_t ie = leg->rows[row].ID;
                if (ie < 0 ||
                    static_cast<std::uint64_t>(ie) >= static_cast<std::uint64_t>(mask_size)) {
                    return Status::InternalError;
                }
                used[static_cast<std::size_t>(ie)] = 1U;
            }
            const std::uint32_t arrival_stage = leg_stage + 1U;
            if (stages_to_filter[arrival_stage]) {
                const std::int64_t ie = leg->rows[row].IA;
                if (ie < 0 ||
                    static_cast<std::uint64_t>(ie) >= static_cast<std::uint64_t>(mask_size)) {
                    return Status::InternalError;
                }
                used[static_cast<std::size_t>(ie)] = 1U;
            }
        }
    }

    const std::size_t before = encounters->rows.size();
    std::size_t write = 0U;
    for (std::size_t read = 0U; read < before; ++read) {
        const EncounterRow& candidate = encounters->rows[read];
        const std::uint32_t stage = static_cast<std::uint32_t>(candidate.stage_id);
        const bool prune = stage <= leg_count && stages_to_filter[stage];
        if (!prune || used[static_cast<std::size_t>(candidate.IE)] != 0U) {
            if (write != read) {
                encounters->rows[write] = candidate;
            }
            ++write;
        }
    }
    status = encounters->rows.resize(write, budget);
    if (status != Status::Ok) {
        return status;
    }
    *removed = before - write;
    return Status::Ok;
}

Status filter_encounters_for_leg_stage(
    EncounterDB* encounters,
    LegDB* leg_dbs[kMaxStages],
    std::uint32_t leg_count,
    std::uint32_t changed_leg_stage,
    MemoryBudget* budget,
    std::size_t* removed) {
    if (changed_leg_stage >= leg_count) {
        return Status::InvalidInput;
    }
    bool stages_to_filter[kMaxStages]{};
    stages_to_filter[changed_leg_stage] = true;
    stages_to_filter[changed_leg_stage + 1U] = true;
    return filter_encounters_for_stages(
        encounters,
        leg_dbs,
        leg_count,
        stages_to_filter,
        budget,
        removed);
}

Status run_incoming_filter(
    std::uint32_t start,
    EncounterDB* encounters,
    LegDB* leg_dbs[kMaxStages],
    FlybyDB* flyby_dbs[kMaxStages],
    std::uint32_t leg_count,
    MemoryBudget* budget,
    std::size_t* removed_total) {
    std::uint32_t current = start;
    for (;;) {
        if (current == 0U || current >= leg_count || flyby_dbs[current] == nullptr ||
            leg_dbs[current - 1U] == nullptr) {
            return Status::Ok;
        }
        std::size_t removed = 0U;
        Status status = filter_leg_by_flyby(
            leg_dbs[current - 1U],
            *flyby_dbs[current],
            true,
            budget,
            &removed);
        if (status != Status::Ok) {
            return status;
        }
        *removed_total += removed;
        if (removed == 0U) {
            return Status::Ok;
        }

        status = filter_encounters_for_leg_stage(
            encounters,
            leg_dbs,
            leg_count,
            current - 1U,
            budget,
            &removed);
        if (status != Status::Ok) {
            return status;
        }
        *removed_total += removed;

        if (current <= 1U || flyby_dbs[current - 1U] == nullptr) {
            return Status::Ok;
        }
        status = filter_flyby_by_leg(
            flyby_dbs[current - 1U],
            *leg_dbs[current - 1U],
            false,
            budget,
            &removed);
        if (status != Status::Ok) {
            return status;
        }
        *removed_total += removed;
        --current;
    }
}

Status run_outgoing_filter(
    std::uint32_t start,
    EncounterDB* encounters,
    LegDB* leg_dbs[kMaxStages],
    FlybyDB* flyby_dbs[kMaxStages],
    std::uint32_t leg_count,
    MemoryBudget* budget,
    std::size_t* removed_total) {
    std::uint32_t current = start;
    for (;;) {
        if (current == 0U || current >= leg_count || flyby_dbs[current] == nullptr ||
            leg_dbs[current] == nullptr) {
            return Status::Ok;
        }
        std::size_t removed = 0U;
        Status status = filter_leg_by_flyby(
            leg_dbs[current],
            *flyby_dbs[current],
            false,
            budget,
            &removed);
        if (status != Status::Ok) {
            return status;
        }
        *removed_total += removed;
        if (removed == 0U) {
            return Status::Ok;
        }

        status = filter_encounters_for_leg_stage(
            encounters,
            leg_dbs,
            leg_count,
            current,
            budget,
            &removed);
        if (status != Status::Ok) {
            return status;
        }
        *removed_total += removed;

        if (current + 1U >= leg_count || flyby_dbs[current + 1U] == nullptr) {
            return Status::Ok;
        }
        status = filter_flyby_by_leg(
            flyby_dbs[current + 1U],
            *leg_dbs[current],
            true,
            budget,
            &removed);
        if (status != Status::Ok) {
            return status;
        }
        *removed_total += removed;
        ++current;
    }
}

}  // namespace

Status filter_encounter_stages_from_active_legs(
    EncounterDB* encounters,
    LegDB* leg_dbs[kMaxStages],
    std::uint32_t leg_count,
    const bool stages_to_filter[kMaxStages],
    MemoryBudget* budget,
    std::size_t* removed_rows) {
    if (leg_count == 0U || leg_count >= kMaxStages) {
        return Status::InvalidInput;
    }
    return filter_encounters_for_stages(
        encounters,
        leg_dbs,
        leg_count,
        stages_to_filter,
        budget,
        removed_rows);
}

Status run_leg_filter_fixpoint(
    EncounterDB* encounters,
    LegDB* leg_dbs[kMaxStages],
    FlybyDB* flyby_dbs[kMaxStages],
    std::uint32_t leg_count,
    MemoryBudget* budget,
    std::size_t* passes,
    std::size_t* removed_rows) {
    if (encounters == nullptr || leg_dbs == nullptr || flyby_dbs == nullptr ||
        leg_count == 0U || leg_count >= kMaxStages || budget == nullptr || passes == nullptr ||
        removed_rows == nullptr) {
        return Status::InvalidInput;
    }
    *passes = 0U;
    *removed_rows = 0U;

    std::uint32_t first_flyby = leg_count;
    std::uint32_t last_flyby = 0U;
    std::size_t flyby_count = 0U;
    for (std::uint32_t stage = 1U; stage < leg_count; ++stage) {
        if (flyby_dbs[stage] != nullptr) {
            if (first_flyby == leg_count) {
                first_flyby = stage;
            }
            last_flyby = stage;
            ++flyby_count;
        }
    }
    if (flyby_count == 0U) {
        return Status::Ok;
    }

    const std::size_t maximum_passes = 2U * flyby_count + 2U;
    for (std::size_t pass = 1U; pass <= maximum_passes; ++pass) {
        std::size_t removed_this_pass = 0U;
        Status status = run_incoming_filter(
            last_flyby,
            encounters,
            leg_dbs,
            flyby_dbs,
            leg_count,
            budget,
            &removed_this_pass);
        if (status != Status::Ok) {
            return status;
        }
        status = run_outgoing_filter(
            first_flyby,
            encounters,
            leg_dbs,
            flyby_dbs,
            leg_count,
            budget,
            &removed_this_pass);
        if (status != Status::Ok) {
            return status;
        }
        *passes = pass;
        *removed_rows += removed_this_pass;
        if (removed_this_pass == 0U) {
            return Status::Ok;
        }
    }
    return Status::InternalError;
}

}  // namespace star_search
