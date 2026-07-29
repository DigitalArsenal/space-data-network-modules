#include "combo.hpp"
#include "encounter.hpp"
#include "ephemeris.hpp"
#include "filter.hpp"
#include "flyby.hpp"
#include "leg.hpp"
#include "pipeline.hpp"
#include "problem_text.hpp"

#include <cstdio>
#include <cstdlib>
#include <limits>

namespace {

int failures = 0;

#define CHECK(condition)                                                                            \
    do {                                                                                            \
        if (!(condition)) {                                                                         \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);              \
            ++failures;                                                                             \
        }                                                                                           \
    } while (false)

bool read_file(const char* path, void** bytes, std::size_t* size) {
    std::FILE* stream = std::fopen(path, "rb");
    if (stream == nullptr || std::fseek(stream, 0, SEEK_END) != 0) {
        return false;
    }
    const long length = std::ftell(stream);
    if (length <= 0 || std::fseek(stream, 0, SEEK_SET) != 0) {
        std::fclose(stream);
        return false;
    }
    *bytes = std::malloc(static_cast<std::size_t>(length));
    *size = static_cast<std::size_t>(length);
    const bool ok = *bytes != nullptr && std::fread(*bytes, 1U, *size, stream) == *size;
    std::fclose(stream);
    return ok;
}

}  // namespace

int main() {
    using namespace star_search;

    Problem problem{};
    CHECK(harness::parse_problem_file("tests/vectors/test2_EMEJ.problem", &problem) == Status::Ok);
    CHECK(problem.stage_count == 4U);
    CHECK(problem.leg_count == 3U);
    CHECK(problem.tfilter_enabled);
    Problem malformed_problem{};
    CHECK(harness::parse_problem_file(
              "tests/vectors/malformed_missing.problem",
              &malformed_problem) == Status::InvalidFormat);
    std::size_t grid_count = 0U;
    CHECK(make_time_grid_count(0.0, 1.0, 0.1, 100U, &grid_count) == Status::Ok);
    CHECK(grid_count == 11U);
    CHECK(make_time_grid_count(
              0.0,
              1.0e9,
              1.0e-6,
              100U,
              &grid_count) == Status::RowLimitExceeded);

    void* raw = nullptr;
    std::size_t byte_count = 0U;
    CHECK(read_file("tests/vectors/test2_EMEJ.ephem", &raw, &byte_count));
    MemoryBudget budget(problem.memory_cap_bytes);
    Ephemeris ephemeris;
    CHECK(decode_ephemeris(
              static_cast<const std::uint8_t*>(raw),
              byte_count,
              10000U,
              &budget,
              &ephemeris) == Status::Ok);
    std::free(raw);

    EncounterDB encounters;
    CHECK(build_encounter_database(
              problem,
              ephemeris,
              problem.row_cap,
              &budget,
              &encounters) == Status::Ok);
    CHECK(encounters.rows.size() == 6227U);
    if (encounters.rows.size() == 6227U) {
        CHECK(encounters.rows[0].IE == 0);
        CHECK(encounters.rows[0].stage_id == 0);
        CHECK(encounters.rows[0].body_id == 399);
        CHECK(encounters.rows[0].t_et_s == 631108869.18390727);
        CHECK(encounters.rows[6226U].IE == 6226);
        CHECK(encounters.rows[6226U].stage_id == 3);
        CHECK(encounters.rows[6226U].body_id == 599);
    }

    ThreadOptions thread_options{};
    thread_options.requested_threads = 1U;
    LegDB leg0;
    CHECK(build_leg_database(
              problem,
              encounters,
              0U,
              thread_options,
              &budget,
              &leg0) == Status::Ok);
    CHECK(leg0.rows.size() == 114294U);
    if (!leg0.rows.empty()) {
        CHECK(leg0.rows[0].IL == 0);
        CHECK(leg0.rows[leg0.rows.size() - 1U].IL ==
              static_cast<std::int64_t>(leg0.rows.size() - 1U));
        CHECK(leg0.rows[0].dv_lev_km_s == 0.0);
        CHECK(leg0.rows[0].eta_lev == 0.5);
    }

    LegDB leg1;
    CHECK(build_leg_database(
              problem,
              encounters,
              1U,
              thread_options,
              &budget,
              &leg1) == Status::Ok);
    CHECK(leg1.rows.size() == 301979U);

    FlybyDB flyby1;
    CHECK(build_flyby_database(
              problem,
              encounters,
              leg0,
              leg1,
              1U,
              0,
              thread_options,
              &budget,
              &flyby1) == Status::Ok);
    CHECK(flyby1.rows.size() == 20111U);
    if (!flyby1.rows.empty()) {
        CHECK(flyby1.rows[0].IF == 0);
        CHECK(flyby1.rows[flyby1.rows.size() - 1U].IF == 20110);
    }

    LegDB* legs[kMaxStages]{};
    FlybyDB* flybys[kMaxStages]{};
    legs[0] = &leg0;
    legs[1] = &leg1;
    flybys[1] = &flyby1;
    std::size_t local_passes = 0U;
    std::size_t local_removed = 0U;
    CHECK(run_leg_filter_fixpoint(
              &encounters,
              legs,
              flybys,
              problem.leg_count,
              &budget,
              &local_passes,
              &local_removed) == Status::Ok);
    CHECK(local_passes >= 1U);
    CHECK(local_removed > 0U);

    LegDB leg2;
    CHECK(build_leg_database(
              problem,
              encounters,
              2U,
              thread_options,
              &budget,
              &leg2) == Status::Ok);
    CHECK(leg2.rows.size() == 52289U);
    legs[2] = &leg2;

    FlybyDB flyby2;
    CHECK(build_flyby_database(
              problem,
              encounters,
              leg1,
              leg2,
              2U,
              20111,
              thread_options,
              &budget,
              &flyby2) == Status::Ok);
    CHECK(flyby2.rows.size() == 90U);
    flybys[2] = &flyby2;

    std::size_t second_passes = 0U;
    std::size_t second_removed = 0U;
    CHECK(run_leg_filter_fixpoint(
              &encounters,
              legs,
              flybys,
              problem.leg_count,
              &budget,
              &second_passes,
              &second_removed) == Status::Ok);
    CHECK(second_passes >= 1U);
    CHECK(second_removed > 0U);

    std::size_t final_passes = 0U;
    std::size_t final_removed = 99U;
    CHECK(run_leg_filter_fixpoint(
              &encounters,
              legs,
              flybys,
              problem.leg_count,
              &budget,
              &final_passes,
              &final_removed) == Status::Ok);
    CHECK(final_passes == 1U);
    CHECK(final_removed == 0U);

    OutputDB output;
    StageCounts counts{};
    CHECK(run_combo(
              problem,
              encounters,
              legs,
              flybys,
              &budget,
              &output,
              &counts) == Status::Ok);
    CHECK(counts.combo_rows[1] == 10U);
    CHECK(counts.combo_rows[2] == 90U);
    CHECK(counts.final_rows == 90U);
    CHECK(output.rows.size() == 90U);

    std::size_t num_bins = 0U;
    CHECK(tfilter_output_db(problem, &budget, &output, &num_bins) == Status::Ok);
    CHECK(num_bins == 33U);
    CHECK(output.rows.size() == 33U);
    if (!output.rows.empty()) {
        CHECK(output.rows[0].traj_id == 2);
        CHECK(output.rows[0].leg_ils[0] == 50503);
        CHECK(output.rows[0].leg_ils[1] == 143429);
        CHECK(output.rows[0].leg_ils[2] == 30135);
        CHECK(output.rows[0].flyby_ifs[0] == 6486);
        CHECK(output.rows[0].flyby_ifs[1] == 20113);
        CHECK(output.rows[output.rows.size() - 1U].traj_id == 88);
    }

    Problem unsupported = problem;
    unsupported.dv_lev_max_km_s[0] = 0.1;
    LegDB rejected_leg;
    CHECK(build_leg_database(
              unsupported,
              encounters,
              0U,
              thread_options,
              &budget,
              &rejected_leg) == Status::UnsupportedDsm);
    unsupported = problem;
    unsupported.resonant_legs[0] = true;
    CHECK(build_leg_database(
              unsupported,
              encounters,
              0U,
              thread_options,
              &budget,
              &rejected_leg) == Status::UnsupportedResonant);
    unsupported = problem;
    unsupported.null_legs[0] = true;
    CHECK(build_leg_database(
              unsupported,
              encounters,
              0U,
              thread_options,
              &budget,
              &rejected_leg) == Status::UnsupportedNullLeg);

    Problem no_tfilter = problem;
    no_tfilter.tfilter_enabled = false;
    MemoryBudget no_tfilter_budget(no_tfilter.memory_cap_bytes);
    OutputDB no_tfilter_output;
    StageCounts no_tfilter_counts{};
    CHECK(run_star_search(
              no_tfilter,
              ephemeris,
              thread_options,
              &no_tfilter_budget,
              &no_tfilter_output,
              &no_tfilter_counts) == Status::Ok);
    CHECK(no_tfilter_counts.final_rows == 90U);
    CHECK(no_tfilter_counts.tfilter_bins == 0U);
    CHECK(no_tfilter_counts.output_rows == 90U);
    CHECK(no_tfilter_output.rows.size() == 90U);

    Problem invalid_tfilter = problem;
    invalid_tfilter.tfilter_dt_s[0] = std::numeric_limits<double>::denorm_min();
    std::size_t invalid_bins = 0U;
    CHECK(tfilter_output_db(
              invalid_tfilter,
              &budget,
              &output,
              &invalid_bins) == Status::InvalidInput);
    CHECK(output.rows.size() == 33U);

    MemoryBudget oversized_budget(problem.memory_cap_bytes + 1U);
    OutputDB rejected_output;
    StageCounts rejected_counts{};
    CHECK(run_star_search(
              problem,
              ephemeris,
              thread_options,
              &oversized_budget,
              &rejected_output,
              &rejected_counts) == Status::InvalidInput);

    if (failures != 0) {
        std::fprintf(stderr, "%d failure(s)\n", failures);
        return 1;
    }
    std::puts("test_pipeline: phase-1 stage counts + fixpoint PASS");
    return 0;
}
