#include "combo.hpp"

#include <cmath>
#include <cstdint>
#include <cstdlib>

namespace star_search {
namespace {

struct JoinRef {
    std::int64_t il;
    std::size_t row;
};

struct JoinGroup {
    std::int64_t il;
    std::size_t first_row;
};

struct PreemptiveSortRow {
    std::int64_t right_il;
    std::int64_t dep_bin;
    std::int64_t arr_bin;
    double dv;
    std::int64_t parent;
    std::int64_t leg0;
    std::int64_t dep_ie;
    std::int64_t flyby_if;
    std::size_t row;
};

struct TfilterSortRow {
    std::int32_t bodies[kMaxStages];
    std::uint32_t body_count;
    std::int64_t dep_bin;
    std::int64_t arr_bin;
    double dv;
    std::size_t row;
};

int compare_i64(std::int64_t left, std::int64_t right) {
    return left < right ? -1 : (left > right ? 1 : 0);
}

int compare_size(std::size_t left, std::size_t right) {
    return left < right ? -1 : (left > right ? 1 : 0);
}

int compare_double(double left, double right) {
    return left < right ? -1 : (left > right ? 1 : 0);
}

bool floor_to_i64(double value, std::int64_t* result) {
    if (result == nullptr || !std::isfinite(value)) {
        return false;
    }
    const double floored = std::floor(value);
    const double i64_limit = std::ldexp(1.0, 63);
    if (floored < -i64_limit || floored >= i64_limit) {
        return false;
    }
    *result = static_cast<std::int64_t>(floored);
    return true;
}

int compare_join_ref(const void* left_raw, const void* right_raw) {
    const JoinRef& left = *static_cast<const JoinRef*>(left_raw);
    const JoinRef& right = *static_cast<const JoinRef*>(right_raw);
    const int il_order = compare_i64(left.il, right.il);
    return il_order != 0 ? il_order : compare_size(left.row, right.row);
}

int compare_join_group(const void* left_raw, const void* right_raw) {
    const JoinGroup& left = *static_cast<const JoinGroup*>(left_raw);
    const JoinGroup& right = *static_cast<const JoinGroup*>(right_raw);
    return compare_size(left.first_row, right.first_row);
}

int compare_preemptive(const void* left_raw, const void* right_raw) {
    const PreemptiveSortRow& left = *static_cast<const PreemptiveSortRow*>(left_raw);
    const PreemptiveSortRow& right = *static_cast<const PreemptiveSortRow*>(right_raw);
    int order = compare_i64(left.right_il, right.right_il);
    if (order == 0) {
        order = compare_i64(left.dep_bin, right.dep_bin);
    }
    if (order == 0) {
        order = compare_i64(left.arr_bin, right.arr_bin);
    }
    if (order == 0) {
        order = compare_double(left.dv, right.dv);
    }
    if (order == 0) {
        order = compare_i64(left.parent, right.parent);
    }
    if (order == 0) {
        order = compare_i64(left.leg0, right.leg0);
    }
    if (order == 0) {
        order = compare_i64(left.dep_ie, right.dep_ie);
    }
    if (order == 0) {
        order = compare_i64(left.flyby_if, right.flyby_if);
    }
    return order != 0 ? order : compare_size(left.row, right.row);
}

int compare_tfilter(const void* left_raw, const void* right_raw) {
    const TfilterSortRow& left = *static_cast<const TfilterSortRow*>(left_raw);
    const TfilterSortRow& right = *static_cast<const TfilterSortRow*>(right_raw);
    const std::uint32_t count =
        left.body_count < right.body_count ? left.body_count : right.body_count;
    for (std::uint32_t index = 0U; index < count; ++index) {
        if (left.bodies[index] < right.bodies[index]) {
            return -1;
        }
        if (left.bodies[index] > right.bodies[index]) {
            return 1;
        }
    }
    if (left.body_count != right.body_count) {
        return left.body_count < right.body_count ? -1 : 1;
    }
    int order = compare_i64(left.dep_bin, right.dep_bin);
    if (order == 0) {
        order = compare_i64(left.arr_bin, right.arr_bin);
    }
    if (order == 0) {
        order = compare_double(left.dv, right.dv);
    }
    return order != 0 ? order : compare_size(left.row, right.row);
}

const EncounterRow* find_encounter(const EncounterDB& database, std::int64_t ie) {
    std::size_t low = 0U;
    std::size_t high = database.rows.size();
    while (low < high) {
        const std::size_t middle = low + (high - low) / 2U;
        if (database.rows[middle].IE < ie) {
            low = middle + 1U;
        } else {
            high = middle;
        }
    }
    if (low >= database.rows.size() || database.rows[low].IE != ie) {
        return nullptr;
    }
    return &database.rows[low];
}

const LegRow* find_leg(const LegDB& database, std::int64_t il) {
    std::size_t low = 0U;
    std::size_t high = database.rows.size();
    while (low < high) {
        const std::size_t middle = low + (high - low) / 2U;
        if (database.rows[middle].IL < il) {
            low = middle + 1U;
        } else {
            high = middle;
        }
    }
    if (low >= database.rows.size() || database.rows[low].IL != il) {
        return nullptr;
    }
    return &database.rows[low];
}

const FlybyRow* find_flyby(const FlybyDB& database, std::int64_t flyby_if) {
    std::size_t low = 0U;
    std::size_t high = database.rows.size();
    while (low < high) {
        const std::size_t middle = low + (high - low) / 2U;
        if (database.rows[middle].IF < flyby_if) {
            low = middle + 1U;
        } else {
            high = middle;
        }
    }
    if (low >= database.rows.size() || database.rows[low].IF != flyby_if) {
        return nullptr;
    }
    return &database.rows[low];
}

std::size_t lower_join_ref(const Buffer<JoinRef>& refs, std::int64_t il) {
    std::size_t low = 0U;
    std::size_t high = refs.size();
    while (low < high) {
        const std::size_t middle = low + (high - low) / 2U;
        if (refs[middle].il < il) {
            low = middle + 1U;
        } else {
            high = middle;
        }
    }
    return low;
}

std::size_t upper_join_ref(const Buffer<JoinRef>& refs, std::int64_t il) {
    std::size_t low = 0U;
    std::size_t high = refs.size();
    while (low < high) {
        const std::size_t middle = low + (high - low) / 2U;
        if (refs[middle].il <= il) {
            low = middle + 1U;
        } else {
            high = middle;
        }
    }
    return low;
}

Status build_join_refs_from_combo(
    const Buffer<ComboStageRow>& rows,
    MemoryBudget* budget,
    Buffer<JoinRef>* refs) {
    Status status = refs->resize(rows.size(), budget);
    if (status != Status::Ok) {
        return status;
    }
    for (std::size_t row = 0U; row < rows.size(); ++row) {
        (*refs)[row] = JoinRef{rows[row].right_leg_il, row};
    }
    std::qsort(refs->data(), refs->size(), sizeof(JoinRef), compare_join_ref);
    return Status::Ok;
}

Status build_join_refs_and_groups_from_flyby(
    const FlybyDB& flyby,
    MemoryBudget* budget,
    Buffer<JoinRef>* refs,
    Buffer<JoinGroup>* groups) {
    Status status = refs->resize(flyby.rows.size(), budget);
    if (status != Status::Ok) {
        return status;
    }
    for (std::size_t row = 0U; row < flyby.rows.size(); ++row) {
        (*refs)[row] = JoinRef{flyby.rows[row].IL_in, row};
    }
    std::qsort(refs->data(), refs->size(), sizeof(JoinRef), compare_join_ref);
    for (std::size_t row = 0U; row < refs->size();) {
        const std::int64_t il = (*refs)[row].il;
        const std::size_t first_row = (*refs)[row].row;
        std::size_t end = row + 1U;
        std::size_t minimum_row = first_row;
        while (end < refs->size() && (*refs)[end].il == il) {
            if ((*refs)[end].row < minimum_row) {
                minimum_row = (*refs)[end].row;
            }
            ++end;
        }
        status = groups->push_back(
            JoinGroup{il, minimum_row},
            flyby.rows.size(),
            budget);
        if (status != Status::Ok) {
            return status;
        }
        row = end;
    }
    std::qsort(groups->data(), groups->size(), sizeof(JoinGroup), compare_join_group);
    return Status::Ok;
}

bool combo_bounds_keep(const Problem& problem, double dv_total_km_s) {
    if (!std::isfinite(dv_total_km_s) || dv_total_km_s < 0.0) {
        return false;
    }
    return !std::isfinite(problem.dv_total_max_km_s) ||
           dv_total_km_s <= problem.dv_total_max_km_s;
}

Status preemptive_tfilter_stage_rows(
    const Problem& problem,
    std::uint32_t stage,
    const EncounterDB& encounters,
    const LegDB& right_leg,
    MemoryBudget* budget,
    Buffer<ComboStageRow>* rows) {
    if (!problem.tfilter_preemptive || rows->empty()) {
        return Status::Ok;
    }
    const double dep_dt = problem.tfilter_dt_s[0];
    const double arr_dt = problem.tfilter_dt_s[stage + 1U];
    if (!std::isfinite(dep_dt) || dep_dt <= 0.0 || !std::isfinite(arr_dt) || arr_dt <= 0.0) {
        return Status::InvalidInput;
    }

    Buffer<PreemptiveSortRow> sortable;
    Status status = sortable.reserve(rows->size(), budget);
    if (status != Status::Ok) {
        return status;
    }
    for (std::size_t row = 0U; row < rows->size(); ++row) {
        const ComboStageRow& candidate = (*rows)[row];
        const LegRow* leg = find_leg(right_leg, candidate.right_leg_il);
        const EncounterRow* dep = find_encounter(encounters, candidate.dep_ie);
        const EncounterRow* arr = leg == nullptr ? nullptr : find_encounter(encounters, leg->IA);
        if (leg == nullptr || dep == nullptr || arr == nullptr ||
            !std::isfinite(candidate.dv_total_km_s)) {
            continue;
        }
        std::int64_t dep_bin = 0;
        std::int64_t arr_bin = 0;
        if (!floor_to_i64(dep->t_et_s / dep_dt, &dep_bin) ||
            !floor_to_i64(arr->t_et_s / arr_dt, &arr_bin)) {
            return Status::InvalidInput;
        }
        const PreemptiveSortRow sort_row{
            candidate.right_leg_il,
            dep_bin,
            arr_bin,
            candidate.dv_total_km_s,
            candidate.parent_row,
            candidate.leg0_il,
            candidate.dep_ie,
            candidate.flyby_if,
            row,
        };
        status = sortable.push_back(sort_row, problem.row_cap, budget);
        if (status != Status::Ok) {
            return status;
        }
    }
    std::qsort(
        sortable.data(),
        sortable.size(),
        sizeof(PreemptiveSortRow),
        compare_preemptive);

    Buffer<ComboStageRow> filtered;
    status = filtered.reserve(sortable.size(), budget);
    if (status != Status::Ok) {
        return status;
    }
    for (std::size_t index = 0U; index < sortable.size(); ++index) {
        if (index > 0U &&
            sortable[index].right_il == sortable[index - 1U].right_il &&
            sortable[index].dep_bin == sortable[index - 1U].dep_bin &&
            sortable[index].arr_bin == sortable[index - 1U].arr_bin) {
            continue;
        }
        status = filtered.push_back(
            (*rows)[sortable[index].row],
            problem.row_cap,
            budget);
        if (status != Status::Ok) {
            return status;
        }
    }
    *rows = static_cast<Buffer<ComboStageRow>&&>(filtered);
    return Status::Ok;
}

Status seed_first_stage(
    const Problem& problem,
    const EncounterDB& encounters,
    const LegDB& leg0,
    const LegDB& leg1,
    const FlybyDB& flyby,
    MemoryBudget* budget,
    Buffer<ComboStageRow>* spool) {
    for (std::size_t row = 0U; row < flyby.rows.size(); ++row) {
        const FlybyRow& flyby_row = flyby.rows[row];
        const LegRow* incoming = find_leg(leg0, flyby_row.IL_in);
        const LegRow* outgoing = find_leg(leg1, flyby_row.IL_out);
        if (incoming == nullptr || outgoing == nullptr) {
            return Status::InternalError;
        }
        const EncounterRow* dep = find_encounter(encounters, incoming->ID);
        const EncounterRow* arr = find_encounter(encounters, outgoing->IA);
        if (dep == nullptr || arr == nullptr) {
            return Status::InternalError;
        }
        double dv = flyby_row.dv_patch_km_s + incoming->dv_lev_km_s;
        dv += outgoing->dv_lev_km_s;
        if (dv < 0.0 && dv > -1e-12) {
            dv = 0.0;
        }
        if (!combo_bounds_keep(problem, dv)) {
            continue;
        }
        const ComboStageRow candidate{
            incoming->IL,
            incoming->ID,
            outgoing->IL,
            flyby_row.IF,
            dv,
            -1,
        };
        const Status status = spool->push_back(candidate, problem.row_cap, budget);
        if (status != Status::Ok) {
            return status;
        }
    }
    return Status::Ok;
}

Status attach_stage(
    const Problem& problem,
    const Buffer<ComboStageRow>& current,
    const LegDB& outgoing_leg,
    const FlybyDB& flyby,
    MemoryBudget* budget,
    Buffer<ComboStageRow>* next) {
    Buffer<JoinRef> current_refs;
    Buffer<JoinRef> flyby_refs;
    Buffer<JoinGroup> flyby_groups;
    Status status = build_join_refs_from_combo(current, budget, &current_refs);
    if (status != Status::Ok) {
        return status;
    }
    status = build_join_refs_and_groups_from_flyby(
        flyby,
        budget,
        &flyby_refs,
        &flyby_groups);
    if (status != Status::Ok) {
        return status;
    }

    for (std::size_t group_index = 0U; group_index < flyby_groups.size(); ++group_index) {
        const std::int64_t join_il = flyby_groups[group_index].il;
        const std::size_t left_begin = lower_join_ref(current_refs, join_il);
        const std::size_t left_end = upper_join_ref(current_refs, join_il);
        if (left_begin == left_end) {
            continue;
        }
        const std::size_t fly_begin = lower_join_ref(flyby_refs, join_il);
        const std::size_t fly_end = upper_join_ref(flyby_refs, join_il);
        for (std::size_t left = left_begin; left < left_end; ++left) {
            const std::size_t parent_row = current_refs[left].row;
            const ComboStageRow& parent = current[parent_row];
            for (std::size_t fly = fly_begin; fly < fly_end; ++fly) {
                const FlybyRow& flyby_row = flyby.rows[flyby_refs[fly].row];
                const LegRow* outgoing = find_leg(outgoing_leg, flyby_row.IL_out);
                if (outgoing == nullptr) {
                    return Status::InternalError;
                }
                double dv = parent.dv_total_km_s + flyby_row.dv_patch_km_s;
                dv += outgoing->dv_lev_km_s;
                if (dv < 0.0 && dv > -1e-12) {
                    dv = 0.0;
                }
                if (!combo_bounds_keep(problem, dv)) {
                    continue;
                }
                const ComboStageRow child{
                    parent.leg0_il,
                    parent.dep_ie,
                    outgoing->IL,
                    flyby_row.IF,
                    dv,
                    static_cast<std::int64_t>(parent_row),
                };
                status = next->push_back(child, problem.row_cap, budget);
                if (status != Status::Ok) {
                    return status;
                }
            }
        }
    }
    return Status::Ok;
}

Status assemble_output_row(
    std::size_t final_row,
    std::uint32_t leg_count,
    const Buffer<ComboStageRow> spools[kMaxStages],
    const EncounterDB& encounters,
    LegDB* const leg_dbs[kMaxStages],
    FlybyDB* const flyby_dbs[kMaxStages],
    OutputRow* output) {
    if (output == nullptr) {
        return Status::InvalidInput;
    }
    OutputRow row{};
    row.traj_id = static_cast<std::int64_t>(final_row);
    row.leg_count = leg_count;
    row.encounter_count = leg_count + 1U;

    std::int64_t parent = static_cast<std::int64_t>(final_row);
    for (std::uint32_t stage = leg_count - 1U; stage > 0U; --stage) {
        if (parent < 0 ||
            static_cast<std::uint64_t>(parent) >=
                static_cast<std::uint64_t>(spools[stage].size())) {
            return Status::InternalError;
        }
        const ComboStageRow& combo = spools[stage][static_cast<std::size_t>(parent)];
        row.flyby_ifs[stage - 1U] = combo.flyby_if;
        row.leg_ils[stage] = combo.right_leg_il;
        if (stage == 1U) {
            row.leg_ils[0] = combo.leg0_il;
        }
        parent = combo.parent_row;
    }

    for (std::uint32_t stage = 0U; stage < leg_count; ++stage) {
        if (leg_dbs[stage] == nullptr) {
            return Status::InternalError;
        }
        const LegRow* leg = find_leg(*leg_dbs[stage], row.leg_ils[stage]);
        if (leg == nullptr) {
            return Status::InternalError;
        }
        if (stage == 0U) {
            row.encounter_ies[0] = leg->ID;
        } else if (leg->ID != row.encounter_ies[stage]) {
            return Status::InternalError;
        }
        row.encounter_ies[stage + 1U] = leg->IA;
        row.vinfD_km_s[stage] = leg->vinfD_km_s;
        row.vinfA_km_s[stage] = leg->vinfA_km_s;
        row.dv_lev_km_s[stage] = leg->dv_lev_km_s;
        row.eta_lev[stage] = leg->eta_lev;
    }

    for (std::uint32_t encounter = 0U; encounter <= leg_count; ++encounter) {
        const EncounterRow* node = find_encounter(encounters, row.encounter_ies[encounter]);
        if (node == nullptr) {
            return Status::InternalError;
        }
        row.t_et_s[encounter] = node->t_et_s;
        row.body_ids[encounter] = node->body_id;
    }
    for (std::uint32_t stage = 1U; stage < leg_count; ++stage) {
        if (flyby_dbs[stage] == nullptr) {
            return Status::InternalError;
        }
        const FlybyRow* flyby = find_flyby(*flyby_dbs[stage], row.flyby_ifs[stage - 1U]);
        if (flyby == nullptr) {
            return Status::InternalError;
        }
        row.dv_patch_km_s[stage - 1U] = flyby->dv_patch_km_s;
    }

    const ComboStageRow& final_combo = spools[leg_count - 1U][final_row];
    row.dv_total_km_s = final_combo.dv_total_km_s;
    row.tof_total_s = row.t_et_s[leg_count] - row.t_et_s[0];
    const EncounterRow* dep = find_encounter(encounters, row.encounter_ies[0]);
    const EncounterRow* arr = find_encounter(encounters, row.encounter_ies[leg_count]);
    if (dep == nullptr || arr == nullptr) {
        return Status::InternalError;
    }
    row.dv_escape_km_s = compute_parabolic_escape_dv(
        norm(row.vinfD_km_s[0]),
        dep->mu_km3_s2,
        dep->rmin_km);
    row.dv_insertion_km_s = compute_parabolic_escape_dv(
        norm(row.vinfA_km_s[leg_count - 1U]),
        arr->mu_km3_s2,
        arr->rmin_km);
    *output = row;
    return Status::Ok;
}

bool same_tfilter_bin(const TfilterSortRow& left, const TfilterSortRow& right) {
    if (left.body_count != right.body_count || left.dep_bin != right.dep_bin ||
        left.arr_bin != right.arr_bin) {
        return false;
    }
    for (std::uint32_t index = 0U; index < left.body_count; ++index) {
        if (left.bodies[index] != right.bodies[index]) {
            return false;
        }
    }
    return true;
}

}  // namespace

Status run_combo(
    const Problem& problem,
    const EncounterDB& encounters,
    LegDB* const leg_dbs[kMaxStages],
    FlybyDB* const flyby_dbs[kMaxStages],
    MemoryBudget* budget,
    OutputDB* output,
    StageCounts* counts) {
    if (problem.leg_count < 2U || problem.leg_count >= kMaxStages || leg_dbs == nullptr ||
        flyby_dbs == nullptr || budget == nullptr || output == nullptr || counts == nullptr ||
        problem.row_cap == 0U) {
        return Status::InvalidInput;
    }
    output->rows.clear();
    Buffer<ComboStageRow> spools[kMaxStages];

    if (leg_dbs[0] == nullptr || leg_dbs[1] == nullptr || flyby_dbs[1] == nullptr) {
        return Status::InvalidInput;
    }
    Status status = seed_first_stage(
        problem,
        encounters,
        *leg_dbs[0],
        *leg_dbs[1],
        *flyby_dbs[1],
        budget,
        &spools[1]);
    if (status != Status::Ok) {
        return status;
    }
    status = preemptive_tfilter_stage_rows(
        problem,
        1U,
        encounters,
        *leg_dbs[1],
        budget,
        &spools[1]);
    if (status != Status::Ok) {
        return status;
    }
    counts->combo_rows[1] = spools[1].size();

    for (std::uint32_t stage = 2U; stage < problem.leg_count; ++stage) {
        if (leg_dbs[stage] == nullptr || flyby_dbs[stage] == nullptr) {
            return Status::InvalidInput;
        }
        status = attach_stage(
            problem,
            spools[stage - 1U],
            *leg_dbs[stage],
            *flyby_dbs[stage],
            budget,
            &spools[stage]);
        if (status != Status::Ok) {
            return status;
        }
        status = preemptive_tfilter_stage_rows(
            problem,
            stage,
            encounters,
            *leg_dbs[stage],
            budget,
            &spools[stage]);
        if (status != Status::Ok) {
            return status;
        }
        counts->combo_rows[stage] = spools[stage].size();
    }

    const Buffer<ComboStageRow>& final_spool = spools[problem.leg_count - 1U];
    status = output->rows.reserve(final_spool.size(), budget);
    if (status != Status::Ok) {
        return status;
    }
    for (std::size_t final_row = 0U; final_row < final_spool.size(); ++final_row) {
        OutputRow row{};
        status = assemble_output_row(
            final_row,
            problem.leg_count,
            spools,
            encounters,
            leg_dbs,
            flyby_dbs,
            &row);
        if (status != Status::Ok) {
            return status;
        }
        status = output->rows.push_back(row, problem.row_cap, budget);
        if (status != Status::Ok) {
            return status;
        }
    }
    counts->final_rows = output->rows.size();
    return Status::Ok;
}

Status tfilter_output_db(
    const Problem& problem,
    MemoryBudget* budget,
    OutputDB* output,
    std::size_t* num_bins) {
    if (budget == nullptr || output == nullptr || num_bins == nullptr ||
        problem.stage_count == 0U || problem.stage_count > kMaxStages) {
        return Status::InvalidInput;
    }
    *num_bins = 0U;
    if (output->rows.empty()) {
        return Status::Ok;
    }
    const double dep_dt = problem.tfilter_dt_s[0];
    const double arr_dt = problem.tfilter_dt_s[problem.stage_count - 1U];
    if (!std::isfinite(dep_dt) || dep_dt <= 0.0 || !std::isfinite(arr_dt) || arr_dt <= 0.0) {
        return Status::InvalidInput;
    }

    double dep_reference = INFINITY;
    double arr_reference = INFINITY;
    for (std::size_t row = 0U; row < output->rows.size(); ++row) {
        const OutputRow& candidate = output->rows[row];
        bool valid = std::isfinite(candidate.dv_total_km_s);
        for (std::uint32_t encounter = 0U; encounter < candidate.encounter_count; ++encounter) {
            valid = valid && std::isfinite(candidate.t_et_s[encounter]);
        }
        if (!valid) {
            continue;
        }
        if (candidate.t_et_s[0] < dep_reference) {
            dep_reference = candidate.t_et_s[0];
        }
        if (candidate.t_et_s[candidate.encounter_count - 1U] < arr_reference) {
            arr_reference = candidate.t_et_s[candidate.encounter_count - 1U];
        }
    }
    if (!std::isfinite(dep_reference) || !std::isfinite(arr_reference)) {
        output->rows.clear();
        return Status::Ok;
    }

    Buffer<TfilterSortRow> sortable;
    Status status = sortable.reserve(output->rows.size(), budget);
    if (status != Status::Ok) {
        return status;
    }
    for (std::size_t row = 0U; row < output->rows.size(); ++row) {
        const OutputRow& candidate = output->rows[row];
        bool valid = std::isfinite(candidate.dv_total_km_s);
        for (std::uint32_t encounter = 0U; encounter < candidate.encounter_count; ++encounter) {
            valid = valid && std::isfinite(candidate.t_et_s[encounter]);
        }
        if (!valid) {
            continue;
        }
        TfilterSortRow sort_row{};
        sort_row.body_count = candidate.encounter_count;
        for (std::uint32_t encounter = 0U; encounter < candidate.encounter_count; ++encounter) {
            sort_row.bodies[encounter] = candidate.body_ids[encounter];
        }
        if (!floor_to_i64(
                (candidate.t_et_s[0] - dep_reference) / dep_dt,
                &sort_row.dep_bin) ||
            !floor_to_i64(
                (candidate.t_et_s[candidate.encounter_count - 1U] - arr_reference) / arr_dt,
                &sort_row.arr_bin)) {
            return Status::InvalidInput;
        }
        sort_row.dv = candidate.dv_total_km_s;
        sort_row.row = row;
        status = sortable.push_back(sort_row, problem.row_cap, budget);
        if (status != Status::Ok) {
            return status;
        }
    }
    std::qsort(sortable.data(), sortable.size(), sizeof(TfilterSortRow), compare_tfilter);

    Buffer<OutputRow> filtered;
    status = filtered.reserve(sortable.size(), budget);
    if (status != Status::Ok) {
        return status;
    }
    for (std::size_t index = 0U; index < sortable.size(); ++index) {
        if (index > 0U && same_tfilter_bin(sortable[index], sortable[index - 1U])) {
            continue;
        }
        status = filtered.push_back(
            output->rows[sortable[index].row],
            problem.row_cap,
            budget);
        if (status != Status::Ok) {
            return status;
        }
    }
    *num_bins = filtered.size();
    output->rows = static_cast<Buffer<OutputRow>&&>(filtered);
    return Status::Ok;
}

}  // namespace star_search
