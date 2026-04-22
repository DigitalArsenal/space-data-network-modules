#include "conjunction/conjunction_assessment.h"
#include "conjunction/screening.h"
#include "conjunction/screening_internal.h"

#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <stdexcept>

using namespace conjunction;

static int tests_passed = 0;
static int tests_failed = 0;

namespace {

std::string read_file(const std::filesystem::path& path) {
    std::ifstream file(path);
    if (!file.is_open()) {
        throw std::runtime_error("Cannot open: " + path.string());
    }

    std::stringstream buffer;
    buffer << file.rdbuf();
    return buffer.str();
}

std::filesystem::path package_root() {
    return std::filesystem::path(__FILE__)
        .parent_path()   // tests
        .parent_path()   // cpp
        .parent_path()   // src
        .parent_path();  // package root
}

std::vector<TLE> load_fixture_pair() {
    return parse_tle_file(read_file(package_root() / "tests/data/gp_61721,67298.txt"));
}

ScreeningConfig explicit_test_config(double start_jd, double duration_days) {
    ScreeningConfig config;
    config.start_jd = start_jd;
    config.duration_days = duration_days;
    config.threshold_km = 5.0;
    config.coarse_step_sec = 60.0;
    config.combined_radius_m = DEFAULT_RADIUS_M * 2.0;
    config.num_threads = 2;
    config.use_kdtree = false;
    return config;
}

} // namespace

namespace conjunction {
ConjunctionEvent refine_coarse_hit(
    const TLE& obj1,
    const TLE& obj2,
    const CoarseHitRecord& hit,
    double slice_start_jd,
    double slice_end_jd,
    const ScreeningConfig& config,
    const ResidentScreeningIndex* resident_index = nullptr);
} // namespace conjunction

#define CHECK(cond, msg)                                                         \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::printf("FAIL: %s\n", msg);                                      \
            tests_failed++;                                                      \
        } else {                                                                 \
            std::printf("PASS: %s\n", msg);                                      \
            tests_passed++;                                                      \
        }                                                                        \
    } while (0)

void test_single_hit_window() {
    CoarseHitRecord hit{3, 9, 0, 0, 0, 14.5};
    auto window = build_refinement_window(hit, 2460310.5, 2460310.625, 120.0);

    CHECK(window.duration_days() > 0.0, "single hit creates a non-empty window");
    CHECK(window.start_jd == 2460310.5, "single hit clamps at slice start");
    CHECK(window.end_jd <= 2460310.625, "single hit clamps at slice end");
    CHECK(window.hint_jd >= window.start_jd, "single hit keeps hint inside bracket");
}

void test_multi_hit_window() {
    CoarseHitRecord hit{3, 9, 12, 16, 14, 8.25};
    auto window = build_refinement_window(hit, 2460310.5, 2460311.0, 60.0);

    CHECK(window.duration_days() > (4.0 * 60.0 / 86400.0),
          "multi-hit widens beyond raw hit span");
    CHECK(window.start_jd <= window.hint_jd, "multi-hit start is before hint");
    CHECK(window.end_jd >= window.hint_jd, "multi-hit end is after hint");
}

void test_window_clamps_to_slice_end() {
    CoarseHitRecord hit{3, 9, 8, 9, 9, 1.25};
    const double slice_start_jd = 2460310.5;
    const double slice_end_jd = slice_start_jd + (10.0 * 60.0 / 86400.0);
    auto window = build_refinement_window(hit, slice_start_jd, slice_end_jd, 60.0);

    CHECK(window.end_jd == slice_end_jd, "window clamps at slice end");
    CHECK(window.hint_jd <= window.end_jd, "end clamp keeps hint inside bracket");
}

void test_empty_hit_record_returns_empty_window() {
    const double slice_start_jd = 2460310.5;
    const double slice_end_jd = 2460310.625;
    CoarseHitRecord hit;
    auto window = build_refinement_window(hit, slice_start_jd, slice_end_jd, 120.0);

    CHECK(window.duration_days() == 0.0, "empty hit record produces an empty window");
    CHECK(window.start_jd == slice_start_jd, "empty hit window stays at slice start");
    CHECK(window.end_jd == slice_start_jd, "empty hit window has no span");
    CHECK(window.hint_jd == slice_start_jd, "empty hit window keeps hint at slice start");
}

void test_merge_rejects_mismatched_pairs() {
    CoarseHitRecord aggregate{3, 9, 12, 16, 14, 8.25};
    const CoarseHitRecord mismatched_update{5, 11, 10, 10, 10, 1.25};

    merge_coarse_hit_record(aggregate, mismatched_update);

    CHECK(aggregate.obj1_index == 3 && aggregate.obj2_index == 9,
          "mismatched merge keeps aggregate pair indices");
    CHECK(aggregate.best_step == 14, "mismatched merge keeps best step");
    CHECK(aggregate.best_distance_km == 8.25, "mismatched merge keeps best distance");
    CHECK(aggregate.earliest_step == 12 && aggregate.latest_step == 16,
          "mismatched merge keeps bracket span");
}

void test_bracketed_refinement_matches_full_window() {
    const auto pair = load_fixture_pair();
    CHECK(pair.size() == 2, "fixture contains exactly one TLE pair");
    if (pair.size() != 2) {
        return;
    }

    const double start_jd = iso_to_jd("2026-03-09T18:00:00Z");
    const double duration_days = 7.0;

    const ScreeningConfig config = explicit_test_config(start_jd, duration_days);

    const auto full = assess_conjunction(pair[0], pair[1], start_jd, duration_days);
    const double coarse_step =
        (full.tca_jd - start_jd) * 86400.0 / config.coarse_step_sec;
    const int32_t best_step = static_cast<int32_t>(std::llround(coarse_step));
    const int32_t earliest_step = std::max(0, best_step - 1);
    const int32_t latest_step = best_step + 1;
    const CoarseHitRecord hit{
        0,
        1,
        earliest_step,
        latest_step,
        best_step,
        full.min_range_km,
    };

    const auto local = refine_coarse_hit(
        pair[0],
        pair[1],
        hit,
        start_jd,
        start_jd + duration_days,
        config);

    CHECK(std::abs(full.tca_jd - local.tca_jd) < 1e-8,
          "explicit path preserves TCA");
    CHECK(std::abs(full.min_range_km - local.min_range_km) < 1e-6,
          "explicit path preserves miss distance");
}

void test_screen_precomputed_tles_matches_full_window() {
    const auto pair = load_fixture_pair();
    CHECK(pair.size() == 2, "explicit screen fixture contains exactly one TLE pair");
    if (pair.size() != 2) {
        return;
    }

    const double start_jd = iso_to_jd("2026-03-09T18:00:00Z");
    const double duration_days = 7.0;
    const ScreeningConfig config = explicit_test_config(start_jd, duration_days);

    ScreeningStats stats;
    const auto events = screen_precomputed_tles(pair, {{0, 1}}, config, stats);
    const auto full = assess_conjunction(pair[0], pair[1], start_jd, duration_days);

    CHECK(events.size() == 1, "explicit screen returns one conjunction event");
    CHECK(stats.kdtree_candidates == 1, "explicit screen aggregates one coarse candidate");
    CHECK(stats.tca_refined == 1, "explicit screen refines one candidate");

    if (events.size() != 1) {
        return;
    }

    const auto& event = events.front();
    CHECK(std::abs(full.tca_jd - event.tca_jd) < 1e-8,
          "explicit screen preserves TCA end-to-end");
    CHECK(std::abs(full.min_range_km - event.min_range_km) < 1e-4,
          "explicit screen preserves miss distance within numeric tolerance");
}

void test_hint_window_refinement_matches_full_window() {
    const auto pair = load_fixture_pair();
    CHECK(pair.size() == 2, "hint-window fixture contains exactly one TLE pair");
    if (pair.size() != 2) {
        return;
    }

    const double start_jd = iso_to_jd("2026-03-09T18:00:00Z");
    const double duration_days = 7.0;
    const auto full = assess_conjunction(pair[0], pair[1], start_jd, duration_days);

    const double search_start_jd = full.tca_jd - (75.0 / 86400.0);
    const double search_end_jd = full.tca_jd + (75.0 / 86400.0);
    const double hint_jd = full.tca_jd + (22.0 / 86400.0);

    const auto local = assess_conjunction_in_window_near_hint(
        pair[0],
        pair[1],
        search_start_jd,
        search_end_jd,
        hint_jd);

    CHECK(std::abs(full.tca_jd - local.tca_jd) < 1e-8,
          "hint-window exact refinement preserves TCA");
    CHECK(std::abs(full.min_range_km - local.min_range_km) < 1e-6,
          "hint-window exact refinement preserves miss distance");
}

void test_hint_window_solution_matches_full_window() {
    const auto pair = load_fixture_pair();
    CHECK(pair.size() == 2, "hint-window solution fixture contains exactly one TLE pair");
    if (pair.size() != 2) {
        return;
    }

    const double start_jd = iso_to_jd("2026-03-09T18:00:00Z");
    const double duration_days = 7.0;
    const auto full = assess_conjunction(pair[0], pair[1], start_jd, duration_days);

    const double search_start_jd = full.tca_jd - (75.0 / 86400.0);
    const double search_end_jd = full.tca_jd + (75.0 / 86400.0);
    const double hint_jd = full.tca_jd + (22.0 / 86400.0);

    const auto solution = assess_conjunction_solution_in_window_near_hint(
        pair[0],
        pair[1],
        search_start_jd,
        search_end_jd,
        hint_jd);

    CHECK(std::abs(full.tca_jd - solution.tca_jd) < 1e-8,
          "hint-window solution preserves TCA");
    CHECK(std::abs(full.min_range_km - solution.min_range_km) < 1e-6,
          "hint-window solution preserves miss distance");
}

void test_implicit_size_contract_rejects_empty_altitude_vectors() {
    const auto pair = load_fixture_pair();
    CHECK(pair.size() == 2, "implicit size-contract fixture contains exactly one TLE pair");
    if (pair.empty()) {
        return;
    }

    const std::vector<TLE> one_tle{pair.front()};
    const ScreeningConfig config = explicit_test_config(
        iso_to_jd("2026-03-09T18:00:00Z"),
        7.0);
    ScreeningStats stats;

    const auto expect_invalid_argument =
        [&](const std::vector<float>& perigee,
            const std::vector<float>& apogee,
            const char* expected_name,
            const char* message) {
            bool threw = false;
            std::string error_message;
            try {
                (void)screen_precomputed_tles_implicit(
                    one_tle,
                    perigee,
                    apogee,
                    {},
                    {},
                    config,
                    stats);
            } catch (const std::invalid_argument& error) {
                threw = true;
                error_message = error.what();
            }

            CHECK(threw, message);
            CHECK(error_message.find(expected_name) != std::string::npos,
                  "implicit size-contract error names the offending vector");
        };

    expect_invalid_argument(
        {},
        {700.0f},
        "perigee_km",
        "implicit screen rejects empty perigee_km");
    expect_invalid_argument(
        {500.0f},
        {},
        "apogee_km",
        "implicit screen rejects empty apogee_km");

    bool optional_masks_allowed = true;
    try {
        (void)screen_precomputed_tles_implicit(
            one_tle,
            {500.0f},
            {700.0f},
            {},
            {},
            config,
            stats);
    } catch (...) {
        optional_masks_allowed = false;
    }
    CHECK(optional_masks_allowed,
          "implicit screen still allows empty optional mask vectors");
}

void test_conservative_coarse_radius_uses_half_step_motion_budget() {
    const double radius_km = conservative_coarse_radius_km(
        10.0,
        7.5,
        8.0,
        120.0);

    CHECK(std::abs(radius_km - 940.0) < 1e-9,
          "coarse radius uses threshold plus half-step pair motion");
}

void test_primary_query_radius_tracks_primary_and_catalog_speeds() {
    const double radius_km = conservative_primary_query_radius_km(
        10.0,
        7.5,
        8.0,
        120.0);

    CHECK(std::abs(radius_km - 940.0) < 1e-9,
          "primary query radius uses threshold plus half-step primary and max-secondary motion");
}

int main() {
    test_single_hit_window();
    test_multi_hit_window();
    test_window_clamps_to_slice_end();
    test_empty_hit_record_returns_empty_window();
    test_merge_rejects_mismatched_pairs();
    test_bracketed_refinement_matches_full_window();
    test_screen_precomputed_tles_matches_full_window();
    test_hint_window_refinement_matches_full_window();
    test_hint_window_solution_matches_full_window();
    test_implicit_size_contract_rejects_empty_altitude_vectors();
    test_conservative_coarse_radius_uses_half_step_motion_budget();
    test_primary_query_radius_tracks_primary_and_catalog_speeds();
    std::printf("passed=%d failed=%d\n", tests_passed, tests_failed);
    return tests_failed == 0 ? 0 : 1;
}
