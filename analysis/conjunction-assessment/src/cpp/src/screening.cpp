#include "conjunction/error_status.h"
/**
 * High-Performance Conjunction Screening Engine
 *
 * Pipeline:
 *   1. Perigee/apogee prefilter (eliminate impossible pairs)
 *   2. Convert GP → TLE for SGP4 propagation
 *   3. Parallel time-step propagation with KD-tree spatial indexing
 *   4. Dynamic windowing (adaptive step based on closing rate)
 *   5. Fine TCA refinement for candidates
 *   6. Full conjunction assessment for confirmed events
 *
 * Threading: pthreads with per-thread work queues
 * Memory: shared read-only TLE array, per-thread candidate lists
 */

#include "conjunction/screening.h"
#include "conjunction/ephemeris_source.h"
#include "conjunction/resident_screening_index.h"
#ifndef CONJUNCTION_SINGLE_THREAD
#include <thread>
#include <mutex>
#include <atomic>
#include <condition_variable>
#endif
#include <chrono>
#include <cmath>
#include <exception>
#include <cstdio>
#include <set>
#include <unordered_map>
#include <unordered_set>
#include <algorithm>
#include <numeric>
#include <map>
#include <optional>
#include <iostream>
#include <stdexcept>

namespace conjunction {

namespace {

constexpr size_t MAX_PAIRWISE_PRIMARY_SCAN_COUNT = 64;
constexpr size_t MAX_PAIRWISE_CANDIDATE_SCAN_COUNT = 250000;
constexpr size_t MIN_EXPLICIT_PAIRS_FOR_KDTREE = 8192;
constexpr uint64_t MIN_IMPLICIT_ALL_VS_ALL_PAIR_ESTIMATE = 250000;
constexpr double MAX_RESIDENT_SPEED_BOUND_KM_S = 16.0;

#ifndef CONJUNCTION_SINGLE_THREAD
class ReusableBarrier {
public:
    explicit ReusableBarrier(size_t participant_count)
        : threshold_(participant_count),
          count_(participant_count),
          generation_(0)
    {
        if (participant_count == 0) {
            set_error("ReusableBarrier requires participants"); return;
        }
    }

    void wait()
    {
        std::unique_lock<std::mutex> lock(mutex_);
        const size_t generation = generation_;
        if (--count_ == 0) {
            generation_++;
            count_ = threshold_;
            condition_.notify_all();
            return;
        }
        condition_.wait(lock, [&]() { return generation != generation_; });
    }

private:
    std::mutex mutex_;
    std::condition_variable condition_;
    const size_t threshold_;
    size_t count_;
    size_t generation_;
};
#endif

double evaluate_chebyshev_coefficients(
    const std::array<double, RESIDENT_CHEBYSHEV_COEFFICIENT_COUNT>& coefficients,
    uint32_t degree,
    double tau)
{
    const size_t coefficient_count = std::min(
        static_cast<size_t>(degree) + 1,
        coefficients.size());
    if (coefficient_count == 0) {
        return 0.0;
    }
    double b_k_plus_one = 0.0;
    double b_k_plus_two = 0.0;
    for (int i = static_cast<int>(coefficient_count) - 1; i >= 1; i--) {
        const double b_k = 2.0 * tau * b_k_plus_one - b_k_plus_two + coefficients[static_cast<size_t>(i)];
        b_k_plus_two = b_k_plus_one;
        b_k_plus_one = b_k;
    }
    return tau * b_k_plus_one - b_k_plus_two + coefficients[0];
}

const ResidentTrajectorySegment* find_resident_trajectory_segment(
    const std::vector<ResidentTrajectorySegment>& segments,
    double jd)
{
    for (const auto& segment : segments) {
        if (jd >= segment.start_jd - 1e-12 && jd <= segment.end_jd + 1e-12) {
            return &segment;
        }
    }
    return nullptr;
}

const ResidentTrajectorySegment* find_resident_trajectory_segment_with_cursor(
    const std::vector<ResidentTrajectorySegment>& segments,
    double jd,
    size_t& cursor)
{
    if (segments.empty()) {
        return nullptr;
    }
    if (cursor >= segments.size()) {
        cursor = 0;
    }

    while (cursor > 0 && jd < segments[cursor].start_jd - 1e-12) {
        cursor--;
    }
    while (cursor + 1 < segments.size() && jd > segments[cursor].end_jd + 1e-12) {
        cursor++;
    }

    if (jd >= segments[cursor].start_jd - 1e-12 &&
        jd <= segments[cursor].end_jd + 1e-12) {
        return &segments[cursor];
    }

    return find_resident_trajectory_segment(segments, jd);
}

bool evaluate_resident_polynomial_state(
    const ResidentScreeningIndex& resident_index,
    uint32_t object_index,
    double jd,
    StateVector& state_out)
{
    if (object_index >= resident_index.trajectory_segments.size()) {
        return false;
    }
    const ResidentTrajectorySegment* segment =
        find_resident_trajectory_segment(resident_index.trajectory_segments[object_index], jd);
    if (segment == nullptr) {
        return false;
    }

    const double half_span = (segment->end_jd - segment->start_jd) * 0.5;
    const double mid = (segment->start_jd + segment->end_jd) * 0.5;
    const double tau = half_span > 0.0 ? (jd - mid) / half_span : 0.0;

    state_out.epoch_jd = jd;
    state_out.x = evaluate_chebyshev_coefficients(segment->x_coefficients, segment->degree, tau);
    state_out.y = evaluate_chebyshev_coefficients(segment->y_coefficients, segment->degree, tau);
    state_out.z = evaluate_chebyshev_coefficients(segment->z_coefficients, segment->degree, tau);
    state_out.vx = evaluate_chebyshev_coefficients(segment->vx_coefficients, segment->degree, tau);
    state_out.vy = evaluate_chebyshev_coefficients(segment->vy_coefficients, segment->degree, tau);
    state_out.vz = evaluate_chebyshev_coefficients(segment->vz_coefficients, segment->degree, tau);
    return true;
}

bool sampled_bounds_may_overlap(
    const ResidentScreeningIndex& resident_index,
    uint32_t primary_index,
    uint32_t secondary_index,
    double coarse_threshold_km)
{
    if (resident_index.sample_min_x_km.size() <= primary_index ||
        resident_index.sample_min_x_km.size() <= secondary_index ||
        resident_index.sample_motion_margin_km.size() <= primary_index ||
        resident_index.sample_motion_margin_km.size() <= secondary_index) {
        return true;
    }

    const double margin_km =
        coarse_threshold_km +
        static_cast<double>(resident_index.sample_motion_margin_km[primary_index]) +
        static_cast<double>(resident_index.sample_motion_margin_km[secondary_index]);

    if (static_cast<double>(resident_index.sample_min_x_km[primary_index]) >
            static_cast<double>(resident_index.sample_max_x_km[secondary_index]) +
                margin_km ||
        static_cast<double>(resident_index.sample_min_x_km[secondary_index]) >
            static_cast<double>(resident_index.sample_max_x_km[primary_index]) +
                margin_km) {
        return false;
    }
    if (static_cast<double>(resident_index.sample_min_y_km[primary_index]) >
            static_cast<double>(resident_index.sample_max_y_km[secondary_index]) +
                margin_km ||
        static_cast<double>(resident_index.sample_min_y_km[secondary_index]) >
            static_cast<double>(resident_index.sample_max_y_km[primary_index]) +
                margin_km) {
        return false;
    }
    if (static_cast<double>(resident_index.sample_min_z_km[primary_index]) >
            static_cast<double>(resident_index.sample_max_z_km[secondary_index]) +
                margin_km ||
        static_cast<double>(resident_index.sample_min_z_km[secondary_index]) >
            static_cast<double>(resident_index.sample_max_z_km[primary_index]) +
                margin_km) {
        return false;
    }
    return true;
}

double resident_object_speed_bound_km_s(
    const ResidentScreeningIndex* resident_index,
    uint32_t object_index)
{
    if (resident_index == nullptr ||
        resident_index->max_speed_km_s.size() <= object_index) {
        return 0.0;
    }
    return std::max(
        0.0,
        std::min(
            static_cast<double>(resident_index->max_speed_km_s[object_index]),
            MAX_RESIDENT_SPEED_BOUND_KM_S));
}

double conservative_pair_coarse_radius_km(
    const ScreeningConfig& config,
    const ResidentScreeningIndex* resident_index,
    uint32_t obj1_index,
    uint32_t obj2_index)
{
    if (resident_index == nullptr ||
        resident_index->max_speed_km_s.size() <= obj1_index ||
        resident_index->max_speed_km_s.size() <= obj2_index) {
        return config.threshold_km * 200.0;
    }

    return conservative_coarse_radius_km(
        config.threshold_km,
        resident_object_speed_bound_km_s(resident_index, obj1_index),
        resident_object_speed_bound_km_s(resident_index, obj2_index),
        config.coarse_step_sec);
}

double conservative_primary_query_radius_for_catalog_km(
    const ScreeningConfig& config,
    const ResidentScreeningIndex* resident_index,
    uint32_t primary_index,
    double max_other_speed_km_s)
{
    if (resident_index == nullptr ||
        resident_index->max_speed_km_s.size() <= primary_index) {
        return config.threshold_km * 200.0;
    }

    return conservative_primary_query_radius_km(
        config.threshold_km,
        resident_object_speed_bound_km_s(resident_index, primary_index),
        max_other_speed_km_s,
        config.coarse_step_sec);
}

bool evaluate_resident_polynomial_state(
    const ResidentScreeningIndex& resident_index,
    uint32_t object_index,
    double jd,
    size_t& segment_cursor,
    StateVector& state_out)
{
    if (object_index >= resident_index.trajectory_segments.size()) {
        return false;
    }
    const auto& segments = resident_index.trajectory_segments[object_index];
    const ResidentTrajectorySegment* segment =
        find_resident_trajectory_segment_with_cursor(segments, jd, segment_cursor);
    if (segment == nullptr) {
        return false;
    }

    const double half_span = (segment->end_jd - segment->start_jd) * 0.5;
    const double mid = (segment->start_jd + segment->end_jd) * 0.5;
    const double tau = half_span > 0.0 ? (jd - mid) / half_span : 0.0;

    state_out.epoch_jd = jd;
    state_out.x = evaluate_chebyshev_coefficients(segment->x_coefficients, segment->degree, tau);
    state_out.y = evaluate_chebyshev_coefficients(segment->y_coefficients, segment->degree, tau);
    state_out.z = evaluate_chebyshev_coefficients(segment->z_coefficients, segment->degree, tau);
    state_out.vx = evaluate_chebyshev_coefficients(segment->vx_coefficients, segment->degree, tau);
    state_out.vy = evaluate_chebyshev_coefficients(segment->vy_coefficients, segment->degree, tau);
    state_out.vz = evaluate_chebyshev_coefficients(segment->vz_coefficients, segment->degree, tau);
    return true;
}

double resident_polynomial_distance_at_jd(
    const ResidentScreeningIndex& resident_index,
    uint32_t obj1_index,
    uint32_t obj2_index,
    double jd)
{
    StateVector state1 = {};
    StateVector state2 = {};
    if (!evaluate_resident_polynomial_state(resident_index, obj1_index, jd, state1) ||
        !evaluate_resident_polynomial_state(resident_index, obj2_index, jd, state2)) {
        set_error("Polynomial trajectory coverage is incomplete for the requested TCA refinement window."); return std::numeric_limits<double>::quiet_NaN();
    }

    const double dx = state1.x - state2.x;
    const double dy = state1.y - state2.y;
    const double dz = state1.z - state2.z;
    return std::sqrt(dx * dx + dy * dy + dz * dz);
}

std::vector<std::pair<double, double>> find_all_polynomial_minima(
    const ResidentScreeningIndex& resident_index,
    uint32_t obj1_index,
    uint32_t obj2_index,
    double start_jd,
    double end_jd,
    double step_sec)
{
    std::vector<std::pair<double, double>> minima;
    const double step_days = std::max(0.05, step_sec) / 86400.0;
    double prev_prev = std::numeric_limits<double>::max();
    double prev = std::numeric_limits<double>::max();
    double prev_jd = start_jd;

    for (double jd = start_jd; jd <= end_jd + step_days * 0.5; jd += step_days) {
        const double dist = resident_polynomial_distance_at_jd(
            resident_index,
            obj1_index,
            obj2_index,
            std::min(jd, end_jd));
        if (dist > prev && prev <= prev_prev) {
            minima.emplace_back(prev_jd, prev);
        }
        prev_prev = prev;
        prev = dist;
        prev_jd = std::min(jd, end_jd);
    }
    return minima;
}

double refine_polynomial_minimum(
    const ResidentScreeningIndex& resident_index,
    uint32_t obj1_index,
    uint32_t obj2_index,
    double center_jd,
    double window_days,
    double fine_tol_sec)
{
    double a = center_jd - window_days;
    double b = center_jd + window_days;
    const double tol_days = std::max(0.001, fine_tol_sec) / 86400.0;
    const double inv_phi = (std::sqrt(5.0) - 1.0) * 0.5;

    while ((b - a) > tol_days) {
        const double c = b - (b - a) * inv_phi;
        const double d = a + (b - a) * inv_phi;
        const double fc = resident_polynomial_distance_at_jd(
            resident_index, obj1_index, obj2_index, c);
        const double fd = resident_polynomial_distance_at_jd(
            resident_index, obj1_index, obj2_index, d);
        if (fc < fd) {
            b = d;
        } else {
            a = c;
        }
    }

    return (a + b) * 0.5;
}

double find_polynomial_tca(
    const ResidentScreeningIndex& resident_index,
    uint32_t obj1_index,
    uint32_t obj2_index,
    double start_jd,
    double duration_days,
    double coarse_step_sec,
    double fine_tol_sec)
{
    const double end_jd = start_jd + duration_days;
    auto minima = find_all_polynomial_minima(
        resident_index,
        obj1_index,
        obj2_index,
        start_jd,
        end_jd,
        5.0);
    if (minima.empty()) {
        minima = find_all_polynomial_minima(
            resident_index,
            obj1_index,
            obj2_index,
            start_jd,
            end_jd,
            coarse_step_sec);
    }
    if (minima.empty()) {
        return start_jd;
    }

    std::sort(
        minima.begin(),
        minima.end(),
        [](const auto& lhs, const auto& rhs) { return lhs.second < rhs.second; });

    const int refine_count = std::min(static_cast<int>(minima.size()), 30);
    double best_jd = minima.front().first;
    double best_distance = std::numeric_limits<double>::max();
    for (int i = 0; i < refine_count; i++) {
        const double center = minima[static_cast<size_t>(i)].first;
        double subscan_best_jd = center;
        double subscan_best_dist = minima[static_cast<size_t>(i)].second;
        const double subscan_step = 0.05 / 86400.0;
        const double subscan_window = std::max(10.0, coarse_step_sec) / 86400.0;
        const double subscan_start = std::max(start_jd, center - subscan_window);
        const double subscan_stop = std::min(end_jd, center + subscan_window);

        for (double jd = subscan_start;
             jd <= subscan_stop + subscan_step * 0.5;
             jd += subscan_step) {
            const double distance = resident_polynomial_distance_at_jd(
                resident_index,
                obj1_index,
                obj2_index,
                std::min(jd, end_jd));
            if (distance < subscan_best_dist) {
                subscan_best_dist = distance;
                subscan_best_jd = std::min(jd, end_jd);
            }
        }

        const double refined_jd = refine_polynomial_minimum(
            resident_index,
            obj1_index,
            obj2_index,
            subscan_best_jd,
            1.0 / 86400.0,
            fine_tol_sec);
        const double refined_distance = resident_polynomial_distance_at_jd(
            resident_index,
            obj1_index,
            obj2_index,
            refined_jd);
        if (refined_distance < best_distance) {
            best_distance = refined_distance;
            best_jd = refined_jd;
        }
    }

    return best_jd;
}

ConjunctionEvent assess_conjunction_polynomial(
    const ResidentScreeningIndex& resident_index,
    uint32_t obj1_index,
    uint32_t obj2_index,
    double start_jd,
    double duration_days,
    const ScreeningConfig& config,
    double radius1_m,
    double radius2_m)
{
    ConjunctionEvent event;
    event.obj1 = resident_index.tles[obj1_index];
    event.obj2 = resident_index.tles[obj2_index];
    event.tca_jd = find_polynomial_tca(
        resident_index,
        obj1_index,
        obj2_index,
        start_jd,
        duration_days,
        config.coarse_step_sec,
        config.fine_tol_sec);
    event.tca_iso = jd_to_iso(event.tca_jd);

    if (!evaluate_resident_polynomial_state(resident_index, obj1_index, event.tca_jd, event.state1) ||
        !evaluate_resident_polynomial_state(resident_index, obj2_index, event.tca_jd, event.state2)) {
        set_error("Polynomial trajectory coverage is incomplete at the solved TCA."); return {};
    }

    const double dx = event.state1.x - event.state2.x;
    const double dy = event.state1.y - event.state2.y;
    const double dz = event.state1.z - event.state2.z;
    event.min_range_km = std::sqrt(dx * dx + dy * dy + dz * dz);

    const double dvx = event.state1.vx - event.state2.vx;
    const double dvy = event.state1.vy - event.state2.vy;
    const double dvz = event.state1.vz - event.state2.vz;
    event.rel_speed_kms = std::sqrt(dvx * dvx + dvy * dvy + dvz * dvz);

    inertial_to_rtn(
        event.state1,
        event.state2,
        event.rel_pos_r,
        event.rel_pos_t,
        event.rel_pos_n,
        event.rel_vel_r,
        event.rel_vel_t,
        event.rel_vel_n);

    event.dse1 = event.tca_jd - event.obj1.epoch_jd;
    event.dse2 = event.tca_jd - event.obj2.epoch_jd;

    const SGP4EphemerisSource primary_source(event.obj1);
    const SGP4EphemerisSource secondary_source(event.obj2);
    RtnCovarianceSigmas primary_sigmas;
    RtnCovarianceSigmas secondary_sigmas;
    if (primary_source.covariance_rtn_sigma_at(event.tca_jd, primary_sigmas)) {
        event.cov_r1 = primary_sigmas.radial_km * 1000.0;
        event.cov_t1 = primary_sigmas.along_track_km * 1000.0;
        event.cov_n1 = primary_sigmas.cross_track_km * 1000.0;
    } else {
        event.cov_r1 = DEFAULT_COV_R_M;
        event.cov_t1 = DEFAULT_COV_T_M;
        event.cov_n1 = DEFAULT_COV_N_M;
    }
    if (secondary_source.covariance_rtn_sigma_at(event.tca_jd, secondary_sigmas)) {
        event.cov_r2 = secondary_sigmas.radial_km * 1000.0;
        event.cov_t2 = secondary_sigmas.along_track_km * 1000.0;
        event.cov_n2 = secondary_sigmas.cross_track_km * 1000.0;
    } else {
        event.cov_r2 = DEFAULT_COV_R_M;
        event.cov_t2 = DEFAULT_COV_T_M;
        event.cov_n2 = DEFAULT_COV_N_M;
    }

    const double combined_radius_km = (radius1_m + radius2_m) / 1000.0;
    const auto probability = alfano_max_probability(event.min_range_km, combined_radius_km);
    event.max_probability = probability.max_probability;
    event.dilution_threshold_km = probability.dilution_threshold_km;
    return event;
}

} // namespace

struct ExactSolvedHit {
    uint32_t obj1_index = 0;
    uint32_t obj2_index = 0;
    double tca_jd = 0.0;
};

std::optional<ExactSolvedHit> solve_coarse_hit_if_within_threshold_exact(
    const TLE& obj1,
    const TLE& obj2,
    uint32_t obj1_index,
    uint32_t obj2_index,
    const CoarseHitRecord& hit,
    double slice_start_jd,
    double slice_end_jd,
    const ScreeningConfig& config);

ConjunctionSolution refine_exact_window_locally(
    const TLE& obj1,
    const TLE& obj2,
    const RefinementWindow& window,
    const ScreeningConfig& config);

ConjunctionEvent refine_coarse_hit(
    const TLE& obj1,
    const TLE& obj2,
    const CoarseHitRecord& hit,
    double slice_start_jd,
    double slice_end_jd,
    const ScreeningConfig& config,
    const ResidentScreeningIndex* resident_index)
{
    const double radius_m = config.combined_radius_m / 2.0;
    const auto window = build_refinement_window(
        hit,
        slice_start_jd,
        slice_end_jd,
        config.coarse_step_sec);

    if (window.duration_days() <= 0.0) {
        if (resident_index != nullptr &&
            resident_index->screening_mode !=
                ScreeningMode::exact_only) {
            auto event = assess_conjunction_polynomial(
                *resident_index,
                hit.obj1_index,
                hit.obj2_index,
                slice_start_jd,
                std::max(0.0, slice_end_jd - slice_start_jd),
                config,
                radius_m,
                radius_m);
            if (resident_index->screening_mode ==
                ScreeningMode::polynomial_plus_exact_polish) {
                return assess_conjunction_in_window_near_hint(
                    obj1,
                    obj2,
                    slice_start_jd,
                    slice_end_jd,
                    event.tca_jd,
                    radius_m,
                    radius_m);
            }
            return event;
        }
        return assess_conjunction(
            obj1,
            obj2,
            slice_start_jd,
            std::max(0.0, slice_end_jd - slice_start_jd),
            radius_m,
            radius_m);
    }

    if (resident_index != nullptr &&
        resident_index->screening_mode !=
            ScreeningMode::exact_only) {
        auto event = assess_conjunction_polynomial(
            *resident_index,
            hit.obj1_index,
            hit.obj2_index,
            window.start_jd,
            window.duration_days(),
            config,
            radius_m,
            radius_m);
        if (resident_index->screening_mode ==
            ScreeningMode::polynomial_plus_exact_polish) {
            return assess_conjunction_in_window_near_hint(
                obj1,
                obj2,
                window.start_jd,
                window.end_jd,
                event.tca_jd,
                radius_m,
                radius_m);
        }
        return event;
    }

    return assess_conjunction(
        obj1,
        obj2,
        window.start_jd,
        window.duration_days(),
        radius_m,
        radius_m);
}

std::optional<ConjunctionEvent> refine_coarse_hit_if_within_threshold(
    const TLE& obj1,
    const TLE& obj2,
    const CoarseHitRecord& hit,
    double slice_start_jd,
    double slice_end_jd,
    const ScreeningConfig& config,
    const ResidentScreeningIndex* resident_index)
{
    const double radius_m = config.combined_radius_m / 2.0;
    const auto window = build_refinement_window(
        hit,
        slice_start_jd,
        slice_end_jd,
        config.coarse_step_sec);

    auto materialize_if_within_threshold =
        [&](const ConjunctionSolution& solution) -> std::optional<ConjunctionEvent> {
            if (!is_conjunction_within_threshold(solution.min_range_km, config.threshold_km)) {
                return std::nullopt;
            }
            auto event = assess_conjunction_at_tca(
                obj1,
                obj2,
                solution.tca_jd,
                radius_m,
                radius_m);
            if (has_error()) return std::nullopt;
            if (!is_conjunction_within_threshold(event.min_range_km, config.threshold_km)) {
                return std::nullopt;
            }
            return event;
        };

    if (window.duration_days() <= 0.0) {
        if (resident_index != nullptr &&
            resident_index->screening_mode !=
                ScreeningMode::exact_only) {
            auto event = assess_conjunction_polynomial(
                *resident_index,
                hit.obj1_index,
                hit.obj2_index,
                slice_start_jd,
                std::max(0.0, slice_end_jd - slice_start_jd),
                config,
                radius_m,
                radius_m);
            if (!is_conjunction_within_threshold(event.min_range_km, config.threshold_km)) {
                return std::nullopt;
            }
            if (resident_index->screening_mode ==
                ScreeningMode::polynomial_plus_exact_polish) {
                auto polished_event = assess_conjunction_in_window_near_hint(
                    obj1,
                    obj2,
                    slice_start_jd,
                    slice_end_jd,
                    event.tca_jd,
                    radius_m,
                    radius_m);
                if (!is_conjunction_within_threshold(polished_event.min_range_km, config.threshold_km)) {
                    return std::nullopt;
                }
                return polished_event;
            }
            return event;
        }

        return materialize_if_within_threshold(
            assess_conjunction_solution(
                obj1,
                obj2,
                slice_start_jd,
                std::max(0.0, slice_end_jd - slice_start_jd)));
    }

    if (resident_index != nullptr &&
        resident_index->screening_mode !=
            ScreeningMode::exact_only) {
        auto event = assess_conjunction_polynomial(
            *resident_index,
            hit.obj1_index,
            hit.obj2_index,
            window.start_jd,
            window.duration_days(),
            config,
            radius_m,
            radius_m);
        if (!is_conjunction_within_threshold(event.min_range_km, config.threshold_km)) {
            return std::nullopt;
        }
        if (resident_index->screening_mode ==
            ScreeningMode::polynomial_plus_exact_polish) {
            auto polished_event = assess_conjunction_in_window_near_hint(
                obj1,
                obj2,
                window.start_jd,
                window.end_jd,
                event.tca_jd,
                radius_m,
                radius_m);
            if (!is_conjunction_within_threshold(polished_event.min_range_km, config.threshold_km)) {
                return std::nullopt;
            }
            return polished_event;
        }
        return event;
    }

    return materialize_if_within_threshold(
        assess_conjunction_solution_in_window_near_hint(
            obj1,
            obj2,
            window.start_jd,
            window.end_jd,
            window.hint_jd));
}

namespace {

// Maximum coarse steps processed in a single threaded window. Keep browser
// pthread screening in one native window where possible; repeated native chunks
// can exhaust Emscripten's pthread worker pool before the JS event loop recycles
// workers.
constexpr int MAX_IMPLICIT_COARSE_STEPS_PER_CHUNK = 10000;

void reset_implicit_stats(ScreeningStats& stats) {
    const uint64_t total_objects = stats.total_objects;
    const uint64_t pairs_screened = stats.pairs_screened;
    const uint64_t pairs_prefiltered = stats.pairs_prefiltered;
    stats = {};
    stats.total_objects = total_objects;
    stats.pairs_screened = pairs_screened;
    stats.pairs_prefiltered = pairs_prefiltered;
}

bool event_in_nominal_chunk_window(
    const ConjunctionEvent& event,
    double chunk_start_jd,
    double nominal_end_jd,
    bool include_nominal_end)
{
    if (!(event.tca_jd >= chunk_start_jd)) {
        return false;
    }
    if (include_nominal_end) {
        return event.tca_jd <= nominal_end_jd;
    }
    return event.tca_jd < nominal_end_jd;
}

std::vector<ConjunctionEvent> dedupe_chunked_events(
    std::vector<ConjunctionEvent> events)
{
    if (events.size() < 2) {
        return events;
    }

    std::vector<ConjunctionEvent> deduped;
    deduped.reserve(events.size());
    for (auto& event : events) {
        bool merged = false;
        for (auto& existing : deduped) {
            const int existing_lo =
                std::min(existing.obj1.norad_cat_id, existing.obj2.norad_cat_id);
            const int existing_hi =
                std::max(existing.obj1.norad_cat_id, existing.obj2.norad_cat_id);
            const int event_lo =
                std::min(event.obj1.norad_cat_id, event.obj2.norad_cat_id);
            const int event_hi =
                std::max(event.obj1.norad_cat_id, event.obj2.norad_cat_id);
            if (existing_lo != event_lo || existing_hi != event_hi) {
                continue;
            }

            if (event.min_range_km < existing.min_range_km ||
                (event.min_range_km == existing.min_range_km &&
                 event.max_probability > existing.max_probability)) {
                existing = std::move(event);
            }
            merged = true;
            break;
        }

        if (!merged) {
            deduped.push_back(std::move(event));
        }
    }
    return deduped;
}

} // namespace

// ============================================================================
// Perigee/Apogee Prefilter
// ============================================================================

bool altitude_overlap(const GPElement& gp1, const GPElement& gp2, double margin_km) {
    // Objects can only conjunct if their altitude ranges overlap
    // Perigee1-margin .. Apogee1+margin overlaps with Perigee2-margin .. Apogee2+margin
    double lo1 = gp1.perigee_km - margin_km;
    double hi1 = gp1.apogee_km + margin_km;
    double lo2 = gp2.perigee_km - margin_km;
    double hi2 = gp2.apogee_km + margin_km;

    return lo1 <= hi2 && lo2 <= hi1;
}

std::vector<std::pair<uint32_t, uint32_t>> ConjunctionScreener::prefilter_pairs(
    const std::vector<GPElement>& catalog)
{
    std::vector<std::pair<uint32_t, uint32_t>> pairs;

    if (!config_.use_perigee_filter) {
        // No prefilter: return all pairs
        for (uint32_t i = 0; i < catalog.size(); i++) {
            for (uint32_t j = i + 1; j < catalog.size(); j++) {
                pairs.push_back({i, j});
            }
        }
        return pairs;
    }

    // Sort by perigee for sweep-line approach
    std::vector<uint32_t> indices(catalog.size());
    std::iota(indices.begin(), indices.end(), 0);
    std::sort(indices.begin(), indices.end(),
              [&catalog](uint32_t a, uint32_t b) {
                  return catalog[a].perigee_km < catalog[b].perigee_km;
              });

    // Sweep line: for each object, only check objects whose perigee
    // is within [perigee - margin, apogee + margin]
    const double margin = 50.0; // km
    for (size_t ii = 0; ii < indices.size(); ii++) {
        uint32_t i = indices[ii];
        double hi = catalog[i].apogee_km + margin;

        for (size_t jj = ii + 1; jj < indices.size(); jj++) {
            uint32_t j = indices[jj];
            if (catalog[j].perigee_km - margin > hi) break; // No more overlap

            if (altitude_overlap(catalog[i], catalog[j], margin)) {
                uint32_t a = std::min(i, j), b = std::max(i, j);
                pairs.push_back({a, b});
            }
        }
    }

    return pairs;
}

std::vector<std::pair<uint32_t, uint32_t>> ConjunctionScreener::prefilter_cross_pairs(
    const std::vector<GPElement>& catalog,
    const std::vector<uint32_t>& primary_indices,
    const std::vector<uint32_t>& secondary_indices,
    uint64_t* total_pairs_out)
{
    std::vector<std::pair<uint32_t, uint32_t>> pairs;
    std::unordered_set<uint64_t> seen_pairs;
    const double margin = 50.0;

    if (total_pairs_out != nullptr) {
        *total_pairs_out = 0;
    }

    for (uint32_t primary_index : primary_indices) {
        if (primary_index >= catalog.size()) {
            continue;
        }
        for (uint32_t secondary_index : secondary_indices) {
            if (secondary_index >= catalog.size() || secondary_index == primary_index) {
                continue;
            }

            const uint32_t a = std::min(primary_index, secondary_index);
            const uint32_t b = std::max(primary_index, secondary_index);
            const uint64_t key =
                (static_cast<uint64_t>(a) << 32) | static_cast<uint64_t>(b);
            if (!seen_pairs.insert(key).second) {
                continue;
            }

            if (total_pairs_out != nullptr) {
                (*total_pairs_out)++;
            }

            if (!config_.use_perigee_filter ||
                altitude_overlap(catalog[a], catalog[b], margin)) {
                pairs.push_back({a, b});
            }
        }
    }

    return pairs;
}

// ============================================================================
// Dynamic Windowing
// ============================================================================

double ConjunctionScreener::adaptive_step(double distance_km, double closing_rate_kms) const {
    if (!config_.use_dynamic_window) return config_.coarse_step_sec;

    // When objects are far apart and separating, use max step
    if (distance_km > config_.close_threshold_km * 2 || closing_rate_kms <= 0) {
        return config_.max_step_sec;
    }

    // When closing fast and nearby, reduce step
    // Step = max(min_step, distance / closing_rate / safety_factor)
    // This ensures we don't skip over the TCA
    if (closing_rate_kms > 0.01 && distance_km < config_.close_threshold_km) {
        double time_to_close = distance_km / closing_rate_kms; // seconds
        double step = time_to_close / 10.0; // Safety: 10 samples before potential TCA
        return std::max(config_.min_step_sec, std::min(step, config_.max_step_sec));
    }

    // Linear interpolation between min and max step based on distance
    double frac = std::min(1.0, distance_km / config_.close_threshold_km);
    return config_.min_step_sec + frac * (config_.max_step_sec - config_.min_step_sec);
}

// ============================================================================
// Worker Thread
// ============================================================================

ScreeningThreadWork process_time_steps(
    const ScreeningConfig& config,
    const std::vector<TLE>& tles,
    const std::vector<std::pair<uint32_t, uint32_t>>& valid_pairs,
    double start_jd, double end_jd, double step_sec,
    int thread_id, int total_threads)
{
    ScreeningThreadWork work;
    clear_error();
    if (valid_pairs.empty()) {
        return work;
    }

    std::unordered_map<uint64_t, CoarseHitRecord> coarse_hits;

    std::vector<std::vector<uint32_t>> allowed_secondaries(tles.size());
    std::vector<uint32_t> primary_ids;
    std::vector<uint32_t> secondary_ids;
    std::vector<uint8_t> seen_primary(tles.size(), 0);
    std::vector<uint8_t> seen_secondary(tles.size(), 0);

    for (const auto& [primary_index, secondary_index] : valid_pairs) {
        if (primary_index >= tles.size() || secondary_index >= tles.size()) {
            continue;
        }
        allowed_secondaries[primary_index].push_back(secondary_index);
        if (!seen_primary[primary_index]) {
            seen_primary[primary_index] = 1;
            primary_ids.push_back(primary_index);
        }
        if (!seen_secondary[secondary_index]) {
            seen_secondary[secondary_index] = 1;
            secondary_ids.push_back(secondary_index);
        }
    }

    for (auto& secondaries : allowed_secondaries) {
        std::sort(secondaries.begin(), secondaries.end());
    }

    double step_days = step_sec / 86400.0;
    int total_steps = static_cast<int>((end_jd - start_jd) / step_days);

    for (int step = thread_id; step <= total_steps; step += total_threads) {
        double jd = start_jd + step * step_days;
        std::vector<KDPoint> cached_points(tles.size());
        std::vector<uint8_t> has_state(tles.size(), 0);
        std::vector<KDPoint> secondary_points;
        secondary_points.reserve(secondary_ids.size());

        for (uint32_t secondary_id : secondary_ids) {
            {
                const auto state = propagate_sgp4(tles[secondary_id], jd);
                if (has_error()) { work.error = error_message(); clear_error(); return work; }
                const KDPoint point{state.x, state.y, state.z, secondary_id, static_cast<uint32_t>(step)};
                cached_points[secondary_id] = point;
                has_state[secondary_id] = 1;
                secondary_points.push_back(point);
                work.propagations++;
            }
        }

        const double coarse_threshold = config.threshold_km * 200.0;

        const bool use_kdtree_for_explicit_pairs =
            config.use_kdtree &&
            secondary_points.size() > 50 &&
            valid_pairs.size() > MIN_EXPLICIT_PAIRS_FOR_KDTREE;

        if (use_kdtree_for_explicit_pairs) {
            KDTree tree;
            tree.build(secondary_points);
            std::vector<uint32_t> neighbor_indexes;

            for (uint32_t primary_id : primary_ids) {
                if (!has_state[primary_id]) {
                    {
                        const auto state = propagate_sgp4(tles[primary_id], jd);
                if (has_error()) { work.error = error_message(); clear_error(); return work; }
                        cached_points[primary_id] = {
                            state.x,
                            state.y,
                            state.z,
                            primary_id,
                            static_cast<uint32_t>(step),
                        };
                        has_state[primary_id] = 1;
                        work.propagations++;
                    }
                }

                const auto& primary_point = cached_points[primary_id];
                const auto& allowed = allowed_secondaries[primary_id];
                if (allowed.empty()) {
                    continue;
                }

                neighbor_indexes.clear();
                tree.range_query(primary_point, coarse_threshold, neighbor_indexes);
                for (uint32_t neighbor_index : neighbor_indexes) {
                    const auto& secondary_point = secondary_points[neighbor_index];
                    if (!std::binary_search(
                            allowed.begin(),
                            allowed.end(),
                            secondary_point.obj_index)) {
                        continue;
                    }

                    double dx = primary_point.x - secondary_point.x;
                    double dy = primary_point.y - secondary_point.y;
                    double dz = primary_point.z - secondary_point.z;
                    double dist = std::sqrt(dx * dx + dy * dy + dz * dz);
                    const uint32_t obj1 = std::min(primary_id, secondary_point.obj_index);
                    const uint32_t obj2 = std::max(primary_id, secondary_point.obj_index);
                    auto& hit = coarse_hits[coarse_hit_key(obj1, obj2)];
                    if (hit.best_step < 0) {
                        hit.obj1_index = obj1;
                        hit.obj2_index = obj2;
                    }
                    merge_coarse_hit(hit, step, dist);
                }
            }
        } else {
            for (uint32_t primary_id : primary_ids) {
                if (!has_state[primary_id]) {
                    {
                        const auto state = propagate_sgp4(tles[primary_id], jd);
                if (has_error()) { work.error = error_message(); clear_error(); return work; }
                        cached_points[primary_id] = {
                            state.x,
                            state.y,
                            state.z,
                            primary_id,
                            static_cast<uint32_t>(step),
                        };
                        has_state[primary_id] = 1;
                        work.propagations++;
                    }
                }

                const auto& primary_point = cached_points[primary_id];
                for (uint32_t secondary_id : allowed_secondaries[primary_id]) {
                    if (!has_state[secondary_id]) {
                        continue;
                    }
                    const auto& secondary_point = cached_points[secondary_id];
                    double dx = primary_point.x - secondary_point.x;
                    double dy = primary_point.y - secondary_point.y;
                    double dz = primary_point.z - secondary_point.z;
                    // Smart Sieve single-axis rejection: if one axis already
                    // exceeds the coarse bound, the 3D miss distance cannot
                    // fall inside the coarse screening sphere.
                    if (std::abs(dx) > coarse_threshold ||
                        std::abs(dy) > coarse_threshold ||
                        std::abs(dz) > coarse_threshold) {
                        continue;
                    }
                    double dist = std::sqrt(dx * dx + dy * dy + dz * dz);
                    if (dist <= coarse_threshold) {
                        const uint32_t obj1 = std::min(primary_id, secondary_id);
                        const uint32_t obj2 = std::max(primary_id, secondary_id);
                        auto& hit = coarse_hits[coarse_hit_key(obj1, obj2)];
                        if (hit.best_step < 0) {
                            hit.obj1_index = obj1;
                            hit.obj2_index = obj2;
                        }
                        merge_coarse_hit(hit, step, dist);
                    }
                }
            }
        }
    }

    work.coarse_hits.reserve(coarse_hits.size());
    for (auto& [key, hit] : coarse_hits) {
        work.coarse_hits.push_back(std::move(hit));
    }

    return work;
}

// ============================================================================
// Main Screening
// ============================================================================

std::vector<ConjunctionEvent> screen_precomputed_tles(
    const std::vector<TLE>& tles,
    const std::vector<std::pair<uint32_t, uint32_t>>& valid_pairs,
    const ScreeningConfig& config,
    ScreeningStats& stats,
    ProgressCallback progress)
{
    auto t_start = std::chrono::high_resolution_clock::now();
    stats.kdtree_candidates = 0;
    stats.tca_refined = 0;
    stats.conjunctions_found = 0;
    stats.propagations = 0;
    stats.elapsed_ms = 0.0;
    stats.failed_pairs = 0;

    double start_jd = config.start_jd;
    double end_jd = start_jd + config.duration_days;

    if (progress) progress(0.15, "Propagating and screening...");

    // Step 3: Propagation + KD-tree screening
    int num_threads = std::max(1, config.num_threads);
    std::vector<ScreeningThreadWork> thread_results(num_threads);
#ifdef CONJUNCTION_SINGLE_THREAD
    num_threads = 1;
    thread_results[0] = process_time_steps(
        config,
        tles, valid_pairs,
        start_jd, end_jd, config.coarse_step_sec,
        0, 1);
#else
    if (num_threads <= 1) {
        thread_results[0] = process_time_steps(
            config,
            tles, valid_pairs,
            start_jd, end_jd, config.coarse_step_sec,
            0, 1);
    } else {
        std::vector<std::thread> threads;
        for (int t = 0; t < num_threads; t++) {
            threads.emplace_back([&, t]() {
                thread_results[t] = process_time_steps(
                    config,
                    tles, valid_pairs,
                    start_jd, end_jd, config.coarse_step_sec,
                    t, num_threads);
            });
        }

        for (auto& t : threads) t.join();
    }
#endif

    // Merge coarse-hit aggregates from all threads.
    std::map<uint64_t, CoarseHitRecord> unique_pairs;
    for (const auto& tw : thread_results) {
        if (!tw.error.empty()) { set_error(tw.error); return {}; }
        stats.propagations += tw.propagations;
        for (const auto& hit : tw.coarse_hits) {
            const uint64_t key = coarse_hit_key(hit.obj1_index, hit.obj2_index);
            auto& aggregate = unique_pairs[key];
            if (aggregate.best_step < 0) {
                aggregate.obj1_index = hit.obj1_index;
                aggregate.obj2_index = hit.obj2_index;
            }
            merge_coarse_hit_record(aggregate, hit);
        }
    }

    if (progress) progress(0.7, "Deduplicating candidates...");

    stats.kdtree_candidates = unique_pairs.size();

    if (progress) progress(0.75, "Refining TCA...");

    // Step 4: Fine TCA refinement for each candidate pair
    std::vector<ConjunctionEvent> events;
    std::vector<ExactSolvedHit> solved_hits;
    std::atomic<uint64_t> failed_pairs{0};
    std::vector<std::pair<uint64_t, CoarseHitRecord>> pair_list(
        unique_pairs.begin(), unique_pairs.end());
    const double radius_m = config.combined_radius_m / 2.0;
#ifdef CONJUNCTION_SINGLE_THREAD
    for (const auto& [key, hit] : pair_list) {
        {
            auto solved = solve_coarse_hit_if_within_threshold_exact(
                tles[hit.obj1_index],
                tles[hit.obj2_index],
                hit.obj1_index,
                hit.obj2_index,
                hit,
                start_jd,
                end_jd,
                config);
                if (has_error()) { ++failed_pairs; clear_error(); continue; }
            if (solved.has_value()) {
                solved_hits.push_back(std::move(*solved));
            }
        }
    }
#else
    if (num_threads <= 1) {
        for (const auto& [key, hit] : pair_list) {
            {
                auto solved = solve_coarse_hit_if_within_threshold_exact(
                    tles[hit.obj1_index],
                    tles[hit.obj2_index],
                    hit.obj1_index,
                    hit.obj2_index,
                    hit,
                    start_jd,
                    end_jd,
                    config);
                if (has_error()) { ++failed_pairs; clear_error(); continue; }
                if (solved.has_value()) {
                    solved_hits.push_back(std::move(*solved));
                }
            }
        }
    } else {
        std::mutex solved_hits_mutex;

        // Parallel TCA refinement
        auto refine_range = [&](size_t from, size_t to) {
            std::vector<ExactSolvedHit> local_solved_hits;
            for (size_t i = from; i < to; i++) {
                const auto& [key, hit] = pair_list[i];
                {
                    auto solved = solve_coarse_hit_if_within_threshold_exact(
                        tles[hit.obj1_index],
                        tles[hit.obj2_index],
                        hit.obj1_index,
                        hit.obj2_index,
                        hit,
                        start_jd,
                        end_jd,
                        config);
                if (has_error()) { ++failed_pairs; clear_error(); continue; }
                    if (solved.has_value()) {
                        local_solved_hits.push_back(std::move(*solved));
                    }
                }
            }

            std::lock_guard<std::mutex> lock(solved_hits_mutex);
            solved_hits.insert(
                solved_hits.end(),
                local_solved_hits.begin(),
                local_solved_hits.end());
        };

        std::vector<std::thread> threads;
        size_t chunk = (pair_list.size() + num_threads - 1) / num_threads;
        for (int t = 0; t < num_threads; t++) {
            size_t from = t * chunk;
            size_t to = std::min(from + chunk, pair_list.size());
            if (from < to) {
                threads.emplace_back(refine_range, from, to);
            }
        }
        for (auto& t : threads) t.join();
    }
#endif

    events.reserve(solved_hits.size());
    for (const auto& solved : solved_hits) {
        {
            auto event = assess_conjunction_at_tca(
                tles[solved.obj1_index],
                tles[solved.obj2_index],
                solved.tca_jd,
                radius_m,
                radius_m);
                if (has_error()) { ++failed_pairs; clear_error(); continue; }
            if (is_conjunction_within_threshold(event.min_range_km, config.threshold_km)) {
                events.push_back(std::move(event));
            }
        }
    }

    stats.failed_pairs = failed_pairs.load();
    stats.tca_refined = pair_list.size();
    stats.conjunctions_found = events.size();

    // Sort by max probability descending
    std::sort(events.begin(), events.end(),
              [](const ConjunctionEvent& a, const ConjunctionEvent& b) {
                  return a.max_probability > b.max_probability;
              });

    auto t_end = std::chrono::high_resolution_clock::now();
    stats.elapsed_ms = std::chrono::duration<double, std::milli>(t_end - t_start).count();

    if (progress) progress(1.0, "Done");

    return events;
}

// ============================================================================
// Implicit-pair screening (no materialized pair list)
// ============================================================================

ScreeningThreadWork process_time_steps_implicit(
    const ScreeningConfig& config,
    const std::vector<TLE>& tles,
    const std::vector<float>& perigee_km,
    const std::vector<float>& apogee_km,
    const std::vector<uint8_t>& is_primary,
    const std::vector<uint8_t>& participates,
    double start_jd, double end_jd, double step_sec,
    int thread_id, int total_threads,
    const ResidentScreeningIndex* resident_index)
{
    ScreeningThreadWork work;
    clear_error();
    const size_t n = tles.size();
    if (n < 2) {
        return work;
    }

    const bool all_primary = is_primary.empty();
    const bool all_participate = participates.empty();
    const float altitude_margin = 50.0f;
    const double fallback_coarse_threshold = config.threshold_km * 200.0;
    const bool has_resident_speed_bounds =
        resident_index != nullptr &&
        resident_index->max_speed_km_s.size() == n;
    double catalog_max_speed_km_s = 0.0;
    if (has_resident_speed_bounds) {
        for (size_t object_index = 0; object_index < n; object_index++) {
            catalog_max_speed_km_s = std::max(
                catalog_max_speed_km_s,
                resident_object_speed_bound_km_s(
                    resident_index,
                    static_cast<uint32_t>(object_index)));
        }
    }

    // Identify which active objects are primaries (for pair dedup direction).
    std::vector<uint8_t> active_is_primary;
    if (!all_primary) {
        active_is_primary.resize(n, 0);
        for (uint32_t i = 0; i < static_cast<uint32_t>(n); i++) {
            if (is_primary[i]) active_is_primary[i] = 1;
        }
    }

    std::vector<uint32_t> active_ids;
    std::vector<uint32_t> primary_ids;
    if (!all_primary) {
        primary_ids.reserve(n);
        for (uint32_t i = 0; i < static_cast<uint32_t>(n); i++) {
            if (active_is_primary[i]) {
                primary_ids.push_back(i);
            }
        }
    }

    const bool use_sampled_bounds_filter =
        resident_index != nullptr &&
        !all_primary &&
        !primary_ids.empty() &&
        resident_index->sample_min_x_km.size() == n &&
        resident_index->sample_max_x_km.size() == n &&
        resident_index->sample_min_y_km.size() == n &&
        resident_index->sample_max_y_km.size() == n &&
        resident_index->sample_min_z_km.size() == n &&
        resident_index->sample_max_z_km.size() == n &&
        resident_index->sample_motion_margin_km.size() == n;

    // Build list of objects to propagate.
    active_ids.reserve(n);
    if (use_sampled_bounds_filter) {
        std::vector<uint8_t> included(n, 0);
        for (uint32_t primary_id : primary_ids) {
            active_ids.push_back(primary_id);
            included[primary_id] = 1;
        }
        for (uint32_t candidate_id = 0; candidate_id < static_cast<uint32_t>(n);
             candidate_id++) {
            if (included[candidate_id]) {
                continue;
            }
            if (!all_participate && !participates[candidate_id]) {
                continue;
            }
            bool overlaps_primary = false;
            for (uint32_t primary_id : primary_ids) {
                const double sampled_bounds_threshold_km =
                    has_resident_speed_bounds
                        ? conservative_primary_query_radius_for_catalog_km(
                              config,
                              resident_index,
                              primary_id,
                              catalog_max_speed_km_s)
                        : fallback_coarse_threshold;
                if (!sampled_bounds_may_overlap(
                        *resident_index,
                        primary_id,
                        candidate_id,
                        sampled_bounds_threshold_km)) {
                    continue;
                }
                overlaps_primary = true;
                break;
            }
            if (overlaps_primary) {
                active_ids.push_back(candidate_id);
            }
        }
    } else {
        for (uint32_t i = 0; i < static_cast<uint32_t>(n); i++) {
            if (all_participate || participates[i]) {
                active_ids.push_back(i);
            }
        }
    }
    if (active_ids.size() < 2) {
        return work;
    }

    if (!all_primary) {
        primary_ids.erase(
            std::remove_if(
                primary_ids.begin(),
                primary_ids.end(),
                [&](uint32_t primary_id) {
                    return std::find(
                               active_ids.begin(),
                               active_ids.end(),
                               primary_id) == active_ids.end();
                }),
            primary_ids.end());
    }

    double active_max_speed_km_s = catalog_max_speed_km_s;
    if (has_resident_speed_bounds) {
        active_max_speed_km_s = 0.0;
        for (uint32_t object_id : active_ids) {
            active_max_speed_km_s = std::max(
                active_max_speed_km_s,
                resident_object_speed_bound_km_s(resident_index, object_id));
        }
    }

    std::vector<std::vector<uint32_t>> allowed_secondaries;
    uint64_t pairwise_candidate_count = 0;
    bool use_pairwise_primary_scan =
        !all_primary &&
        !primary_ids.empty() &&
        primary_ids.size() <= MAX_PAIRWISE_PRIMARY_SCAN_COUNT;
    if (use_pairwise_primary_scan) {
        allowed_secondaries.resize(n);
        for (uint32_t primary_id : primary_ids) {
            const float pri_lo = perigee_km[primary_id] - altitude_margin;
            const float pri_hi = apogee_km[primary_id] + altitude_margin;
            auto& secondaries = allowed_secondaries[primary_id];
            for (uint32_t secondary_id : active_ids) {
                if (secondary_id == primary_id) {
                    continue;
                }
                if (active_is_primary[secondary_id] && secondary_id < primary_id) {
                    continue;
                }
                const float sec_lo = perigee_km[secondary_id] - altitude_margin;
                const float sec_hi = apogee_km[secondary_id] + altitude_margin;
                if (pri_lo > sec_hi || sec_lo > pri_hi) {
                    continue;
                }
                secondaries.push_back(secondary_id);
            }
            pairwise_candidate_count += secondaries.size();
        }
        if (pairwise_candidate_count > MAX_PAIRWISE_CANDIDATE_SCAN_COUNT) {
            allowed_secondaries.clear();
            pairwise_candidate_count = 0;
            use_pairwise_primary_scan = false;
        }
    }

    const double step_days = step_sec / 86400.0;
    const int total_steps = static_cast<int>((end_jd - start_jd) / step_days);

    // Running per-thread coarse-hit aggregation bounds memory to
    // O(unique_coarse_pairs) while preserving the bracket span needed for
    // local refinement.
    std::unordered_map<uint64_t, CoarseHitRecord> coarse_hits;

    // Reusable per-step buffers to avoid repeated allocation.
    std::vector<KDPoint> points;
    std::vector<uint32_t> neighbor_indexes;
    std::vector<KDPoint> cached_points(n);
    std::vector<uint8_t> has_state(n, 0);
    std::vector<size_t> segment_cursors(n, 0);

    for (int step = thread_id; step <= total_steps; step += total_threads) {
        const double jd = start_jd + step * step_days;

        // Propagate all active objects.
        points.clear();
        points.reserve(active_ids.size());
        std::fill(has_state.begin(), has_state.end(), 0);

        for (uint32_t obj_id : active_ids) {
            {
                StateVector state = {};
                const bool requires_resident_polynomial =
                    resident_index != nullptr &&
                    resident_index->screening_mode !=
                        ScreeningMode::exact_only;
                bool has_polynomial_state =
                    requires_resident_polynomial &&
                    evaluate_resident_polynomial_state(
                        *resident_index,
                        obj_id,
                        jd,
                        segment_cursors[obj_id],
                        state);
                if (!has_polynomial_state) {
                    if (requires_resident_polynomial) {
                        work.error = "Polynomial trajectory coverage is incomplete during coarse screening";
                        return work;
                    }
                    state = propagate_sgp4(tles[obj_id], jd);
                if (has_error()) { work.error = error_message(); clear_error(); return work; }
                    work.propagations++;
                }
                if (!std::isfinite(state.x) || !std::isfinite(state.y) || !std::isfinite(state.z) ||
                    !std::isfinite(state.vx) || !std::isfinite(state.vy) || !std::isfinite(state.vz)) {
                    work.error = "Non-finite coarse screening state"; return work;
                }
                const KDPoint point = {
                    state.x, state.y, state.z,
                    obj_id, static_cast<uint32_t>(step),
                };
                cached_points[obj_id] = point;
                has_state[obj_id] = 1;
                points.push_back(point);
            }
        }

        if (points.size() < 2) {
            continue;
        }

        if (use_pairwise_primary_scan) {
            for (uint32_t primary_id : primary_ids) {
                if (!has_state[primary_id]) {
                    continue;
                }
                const auto& primary_point = cached_points[primary_id];
                for (uint32_t secondary_id : allowed_secondaries[primary_id]) {
                    if (!has_state[secondary_id]) {
                        continue;
                    }
                    const auto& secondary_point = cached_points[secondary_id];
                    const double pair_radius_km = has_resident_speed_bounds
                        ? conservative_pair_coarse_radius_km(
                              config,
                              resident_index,
                              primary_id,
                              secondary_id)
                        : fallback_coarse_threshold;
                    const double dx = primary_point.x - secondary_point.x;
                    const double dy = primary_point.y - secondary_point.y;
                    const double dz = primary_point.z - secondary_point.z;
                    if (std::abs(dx) > pair_radius_km ||
                        std::abs(dy) > pair_radius_km ||
                        std::abs(dz) > pair_radius_km) {
                        continue;
                    }
                    const double dist = std::sqrt(dx * dx + dy * dy + dz * dz);
                    if (dist > pair_radius_km) {
                        continue;
                    }

                    const uint32_t lo = std::min(primary_id, secondary_id);
                    const uint32_t hi = std::max(primary_id, secondary_id);
                    auto& hit = coarse_hits[coarse_hit_key(lo, hi)];
                    if (hit.best_step < 0) {
                        hit.obj1_index = lo;
                        hit.obj2_index = hi;
                    }
                    merge_coarse_hit(hit, step, dist);
                }
            }
        } else if (config.use_kdtree && points.size() > 50) {
            KDTree tree;
            tree.build(points);

            for (size_t pi = 0; pi < points.size(); pi++) {
                const auto& primary_point = points[pi];
                const uint32_t primary_id = primary_point.obj_index;

                if (!all_primary && !active_is_primary[primary_id]) {
                    continue;
                }

                const float pri_lo = perigee_km[primary_id] - altitude_margin;
                const float pri_hi = apogee_km[primary_id] + altitude_margin;
                const double primary_query_radius_km = has_resident_speed_bounds
                    ? conservative_primary_query_radius_for_catalog_km(
                          config,
                          resident_index,
                          primary_id,
                          active_max_speed_km_s)
                    : fallback_coarse_threshold;

                neighbor_indexes.clear();
                tree.range_query(
                    primary_point,
                    primary_query_radius_km,
                    neighbor_indexes);

                for (uint32_t ni : neighbor_indexes) {
                    const auto& sec_point = points[ni];
                    const uint32_t sec_id = sec_point.obj_index;

                    if (sec_id == primary_id) continue;
                    if (all_primary) {
                        if (sec_id < primary_id) continue;
                    } else {
                        if (active_is_primary[sec_id] && sec_id < primary_id) {
                            continue;
                        }
                    }

                    // Altitude overlap gate.
                    const float sec_lo = perigee_km[sec_id] - altitude_margin;
                    const float sec_hi = apogee_km[sec_id] + altitude_margin;
                    if (pri_lo > sec_hi || sec_lo > pri_hi) {
                        continue;
                    }

                    const double dx = primary_point.x - sec_point.x;
                    const double dy = primary_point.y - sec_point.y;
                    const double dz = primary_point.z - sec_point.z;
                    const double pair_radius_km = has_resident_speed_bounds
                        ? conservative_pair_coarse_radius_km(
                              config,
                              resident_index,
                              primary_id,
                              sec_id)
                        : fallback_coarse_threshold;
                    if (std::abs(dx) > pair_radius_km ||
                        std::abs(dy) > pair_radius_km ||
                        std::abs(dz) > pair_radius_km) {
                        continue;
                    }
                    const double dist = std::sqrt(dx * dx + dy * dy + dz * dz);
                    if (dist > pair_radius_km) {
                        continue;
                    }

                    const uint32_t lo = std::min(primary_id, sec_id);
                    const uint32_t hi = std::max(primary_id, sec_id);
                    auto& hit = coarse_hits[coarse_hit_key(lo, hi)];
                    if (hit.best_step < 0) {
                        hit.obj1_index = lo;
                        hit.obj2_index = hi;
                    }
                    merge_coarse_hit(hit, step, dist);
                }
            }
        } else {
            // Brute-force path for small catalogs.
            for (size_t pi = 0; pi < points.size(); pi++) {
                const auto& p1 = points[pi];
                const uint32_t id1 = p1.obj_index;
                if (!all_primary && !active_is_primary[id1]) {
                    continue;
                }

                const float lo1 = perigee_km[id1] - altitude_margin;
                const float hi1 = apogee_km[id1] + altitude_margin;

                for (size_t si = pi + 1; si < points.size(); si++) {
                    const auto& p2 = points[si];
                    const uint32_t id2 = p2.obj_index;

                    if (!all_primary && !active_is_primary[id1] && !active_is_primary[id2]) {
                        continue;
                    }

                    const float lo2 = perigee_km[id2] - altitude_margin;
                    const float hi2 = apogee_km[id2] + altitude_margin;
                    if (lo1 > hi2 || lo2 > hi1) continue;

                    const double dx = p1.x - p2.x;
                    const double dy = p1.y - p2.y;
                    const double dz = p1.z - p2.z;
                    const double pair_radius_km = has_resident_speed_bounds
                        ? conservative_pair_coarse_radius_km(
                              config,
                              resident_index,
                              id1,
                              id2)
                        : fallback_coarse_threshold;
                    if (std::abs(dx) > pair_radius_km ||
                        std::abs(dy) > pair_radius_km ||
                        std::abs(dz) > pair_radius_km) {
                        continue;
                    }
                    const double dist = std::sqrt(dx * dx + dy * dy + dz * dz);
                    if (dist <= pair_radius_km) {
                        const uint32_t lo = std::min(id1, id2);
                        const uint32_t hi = std::max(id1, id2);
                        auto& hit = coarse_hits[coarse_hit_key(lo, hi)];
                        if (hit.best_step < 0) {
                            hit.obj1_index = lo;
                            hit.obj2_index = hi;
                        }
                        merge_coarse_hit(hit, step, dist);
                    }
                }
            }
        }
    }

    work.coarse_hits.reserve(coarse_hits.size());
    for (auto& [key, hit] : coarse_hits) {
        work.coarse_hits.push_back(std::move(hit));
    }

    return work;
}

struct ImplicitCoarseHitWindowResult {
    std::unordered_map<uint64_t, CoarseHitRecord> coarse_hits;
    ScreeningStats stats;
};

ConjunctionSolution refine_exact_window_locally(
    const TLE& obj1,
    const TLE& obj2,
    const RefinementWindow& window,
    const ScreeningConfig& config)
{
    auto distance_at_jd = [&](double jd) -> double {
        const auto state1 = propagate_sgp4(obj1, jd);
        const auto state2 = propagate_sgp4(obj2, jd);
        const double dx = state1.x - state2.x;
        const double dy = state1.y - state2.y;
        const double dz = state1.z - state2.z;
        return std::sqrt(dx * dx + dy * dy + dz * dz);
    };

    const double fine_tol_days =
        std::max(0.001, config.fine_tol_sec) / 86400.0;
    const double max_half_step_days =
        std::max(1.0, config.coarse_step_sec) * 0.5 / 86400.0;

    double ts = std::clamp(window.hint_jd, window.start_jd, window.end_jd);
    double h = std::min(
        std::max(0.0, (window.end_jd - window.start_jd) * 0.5),
        max_half_step_days);
    if (!(h > 0.0)) {
        h = fine_tol_days;
    }

    ConjunctionSolution solution;
    solution.tca_jd = ts;
    solution.min_range_km = std::numeric_limits<double>::max();

    for (int iter = 0; iter < 64 && h >= fine_tol_days; iter++) {
        const double dist = distance_at_jd(ts);
        if (dist < solution.min_range_km) {
            solution.min_range_km = dist;
            solution.tca_jd = ts;
        }

        const double prev_jd = std::max(window.start_jd, ts - h);
        const double next_jd = std::min(window.end_jd, ts + h);
        const double dist_prev = distance_at_jd(prev_jd);
        const double dist_next = distance_at_jd(next_jd);

        if (dist_prev < dist && dist_prev <= dist_next && prev_jd < ts) {
            ts = prev_jd;
            continue;
        }
        if (dist_next < dist && next_jd > ts) {
            ts = next_jd;
            continue;
        }

        h *= 0.5;
    }

    return solution;
}

std::optional<ExactSolvedHit> solve_coarse_hit_if_within_threshold_exact(
    const TLE& obj1,
    const TLE& obj2,
    uint32_t obj1_index,
    uint32_t obj2_index,
    const CoarseHitRecord& hit,
    double slice_start_jd,
    double slice_end_jd,
    const ScreeningConfig& config)
{
    const auto window = build_refinement_window(
        hit,
        slice_start_jd,
        slice_end_jd,
        config.coarse_step_sec);

    const bool use_local_gate =
        hit.earliest_step != std::numeric_limits<int32_t>::max() &&
        hit.latest_step >= hit.earliest_step &&
        (hit.latest_step - hit.earliest_step) <= 2;

    ConjunctionSolution coarse_solution;
    if (use_local_gate) {
        const double local_half_window_days =
            std::max(10.0, config.coarse_step_sec) / 86400.0;
        const RefinementWindow local_window{
            std::max(window.start_jd, window.hint_jd - local_half_window_days),
            std::min(window.end_jd, window.hint_jd + local_half_window_days),
            std::clamp(window.hint_jd, window.start_jd, window.end_jd),
        };

        coarse_solution = refine_exact_window_locally(
            obj1,
            obj2,
            local_window.duration_days() > 0.0
                ? local_window
                : RefinementWindow{
                      slice_start_jd,
                      slice_end_jd,
                      0.5 * (slice_start_jd + slice_end_jd),
                  },
            config);

        if (!is_conjunction_within_threshold(coarse_solution.min_range_km, config.threshold_km)) {
            return std::nullopt;
        }
    }

    ConjunctionSolution solution;
    if (window.duration_days() <= 0.0) {
        solution = assess_conjunction_solution_in_window_near_hint(
            obj1,
            obj2,
            slice_start_jd,
            slice_end_jd,
            use_local_gate
                ? coarse_solution.tca_jd
                : 0.5 * (slice_start_jd + slice_end_jd));
    } else {
        if (use_local_gate) {
            solution = assess_conjunction_solution_in_window_near_hint(
                obj1,
                obj2,
                window.start_jd,
                window.end_jd,
                coarse_solution.tca_jd);
        } else {
            solution = assess_conjunction_solution(
                obj1,
                obj2,
                window.start_jd,
                window.duration_days());
        }
    }

    if (!is_conjunction_within_threshold(solution.min_range_km, config.threshold_km)) {
        return std::nullopt;
    }

    return ExactSolvedHit{
        obj1_index,
        obj2_index,
        solution.tca_jd,
    };
}

ImplicitCoarseHitWindowResult collect_precomputed_tles_implicit_window(
    const std::vector<TLE>& tles,
    const std::vector<float>& perigee_km,
    const std::vector<float>& apogee_km,
    const std::vector<uint8_t>& is_primary,
    const std::vector<uint8_t>& participates,
    const ScreeningConfig& config,
    ProgressCallback progress,
    const ResidentScreeningIndex* resident_index)
{
    ImplicitCoarseHitWindowResult result;
    auto& stats = result.stats;
    auto t_start = std::chrono::high_resolution_clock::now();
    reset_implicit_stats(stats);

    const double start_jd = config.start_jd;
    const double end_jd = start_jd + config.duration_days;

    if (progress) progress(0.05, "Propagating and screening...");

    int num_threads = std::max(1, config.num_threads);
    std::vector<ScreeningThreadWork> thread_results(num_threads);

    // Determine batching from progress_interval_sec.
    const double interval_days =
        (config.progress_interval_sec > 0.0)
            ? config.progress_interval_sec / 86400.0
            : config.duration_days;
    const int num_batches = std::max(
        1, static_cast<int>(std::ceil(config.duration_days / interval_days)));

    auto merge_thread_results = [&]() {
        size_t incoming_hits = 0;
        for (const auto& tw : thread_results) {
            incoming_hits += tw.coarse_hits.size();
        }
        result.coarse_hits.reserve(result.coarse_hits.size() + incoming_hits);
        for (const auto& tw : thread_results) {
            if (!tw.error.empty()) { set_error(tw.error); return; }
            stats.propagations += tw.propagations;
            for (const auto& hit : tw.coarse_hits) {
                const uint64_t key = coarse_hit_key(hit.obj1_index, hit.obj2_index);
                auto& aggregate = result.coarse_hits[key];
                if (aggregate.best_step < 0) {
                    aggregate.obj1_index = hit.obj1_index;
                    aggregate.obj2_index = hit.obj2_index;
                }
                merge_coarse_hit_record(aggregate, hit);
            }
        }
    };

#ifdef CONJUNCTION_SINGLE_THREAD
    // Single-threaded: process each batch sequentially, fire progress between.
    num_threads = 1;
    for (int b = 0; b < num_batches; b++) {
        const double batch_start = start_jd + interval_days * b;
        const double batch_end = std::min(end_jd, batch_start + interval_days);
        thread_results[0] = process_time_steps_implicit(
            config, tles, perigee_km, apogee_km, is_primary, participates,
            batch_start, batch_end, config.coarse_step_sec, 0, 1, resident_index);
        merge_thread_results();
        if (progress) {
            const double frac = 0.05 + 0.65 * static_cast<double>(b + 1)
                                              / static_cast<double>(num_batches);
            progress(frac, "Screening...");
        }
    }
#else
    if (num_threads <= 1) {
        for (int b = 0; b < num_batches; b++) {
            const double batch_start = start_jd + interval_days * b;
            const double batch_end = std::min(end_jd, batch_start + interval_days);
            thread_results[0] = process_time_steps_implicit(
                config, tles, perigee_km, apogee_km, is_primary, participates,
                batch_start, batch_end, config.coarse_step_sec, 0, 1, resident_index);
            merge_thread_results();
            if (progress) {
                const double frac = 0.05 + 0.65 * static_cast<double>(b + 1)
                                                  / static_cast<double>(num_batches);
                progress(frac, "Screening...");
            }
        }
    } else if (num_batches <= 1) {
        // Single batch — simple create/join, no barriers needed.
        std::vector<std::thread> threads;
        for (int t = 0; t < num_threads; t++) {
            threads.emplace_back([&, t]() {
                {
                    thread_results[t] = process_time_steps_implicit(
                        config, tles, perigee_km, apogee_km, is_primary, participates,
                        start_jd, end_jd, config.coarse_step_sec, t, num_threads, resident_index);
                }
            });
        }
        for (auto& t : threads) t.join();
        merge_thread_results();
        if (progress) progress(0.7, "Screening complete...");
    } else {
        // Multiple batches: reuse threads across batches with a portable barrier.
        ReusableBarrier barrier(static_cast<size_t>(num_threads + 1));
        std::atomic<int> current_batch{0};
        std::atomic<bool> shutdown{false};

        std::vector<std::thread> threads;
        for (int t = 0; t < num_threads; t++) {
            threads.emplace_back([&, t]() {
                while (true) {
                    barrier.wait(); // wait for batch signal
                    if (shutdown.load(std::memory_order_acquire)) return;
                    const int b = current_batch.load(std::memory_order_acquire);
                    const double batch_start = start_jd + interval_days * b;
                    const double batch_end =
                        std::min(end_jd, batch_start + interval_days);
                    thread_results[t] = process_time_steps_implicit(
                        config, tles, perigee_km, apogee_km,
                        is_primary, participates,
                        batch_start, batch_end, config.coarse_step_sec,
                        t, num_threads, resident_index);
                    barrier.wait(); // signal batch done
                }
            });
        }

        for (int b = 0; b < num_batches; b++) {
            current_batch.store(b, std::memory_order_release);
            barrier.wait(); // release threads
            barrier.wait(); // wait for threads to finish
            merge_thread_results();
            if (progress) {
                const double frac = 0.05 + 0.65
                    * static_cast<double>(b + 1)
                    / static_cast<double>(num_batches);
                progress(frac, "Screening...");
            }
        }

        shutdown.store(true, std::memory_order_release);
        barrier.wait(); // release threads to exit
        for (auto& t : threads) t.join();
    }
#endif

    if (progress) progress(0.7, "Deduplicating candidates...");
    stats.kdtree_candidates = result.coarse_hits.size();

    auto t_end = std::chrono::high_resolution_clock::now();
    stats.elapsed_ms = std::chrono::duration<double, std::milli>(t_end - t_start).count();
    return result;
}

std::vector<ConjunctionEvent> screen_precomputed_tles_implicit_window(
    const std::vector<TLE>& tles,
    const std::vector<float>& perigee_km,
    const std::vector<float>& apogee_km,
    const std::vector<uint8_t>& is_primary,
    const std::vector<uint8_t>& participates,
    const ScreeningConfig& config,
    ScreeningStats& stats,
    ProgressCallback progress,
    const ResidentScreeningIndex* resident_index)
{
    const auto require_full_size =
        [expected_size = tles.size()](const auto& values, const char* name) {
            if (values.size() != expected_size) {
                set_error(
                    std::string("screen_precomputed_tles_implicit: ") +
                    name +
                    " must be exactly tles.size()"); return;
                }
        };
    const auto require_optional_size =
        [expected_size = tles.size()](const auto& values, const char* name) {
            if (!values.empty() && values.size() != expected_size) {
                set_error(
                    std::string("screen_precomputed_tles_implicit: ") +
                    name +
                    " must be empty or exactly tles.size()"); return;
            }
        };
    require_full_size(perigee_km, "perigee_km");
    require_full_size(apogee_km, "apogee_km");
    require_optional_size(is_primary, "is_primary");
    require_optional_size(participates, "participates");
    if (has_error()) return {};
    auto t_start = std::chrono::high_resolution_clock::now();
    auto window_result = collect_precomputed_tles_implicit_window(
        tles,
        perigee_km,
        apogee_km,
        is_primary,
        participates,
        config,
        progress,
        resident_index);
    if (has_error()) return {};
    stats = window_result.stats;
    stats.total_objects = tles.size();

    const double start_jd = config.start_jd;
    const double end_jd = start_jd + config.duration_days;

    if (progress) progress(0.75, "Refining TCA...");

    std::vector<ConjunctionEvent> events;
    std::vector<ExactSolvedHit> solved_hits;
    std::atomic<uint64_t> failed_pairs{0};
    std::vector<std::pair<uint64_t, CoarseHitRecord>> pair_list(
        window_result.coarse_hits.begin(), window_result.coarse_hits.end());
    const bool use_exact_solution_path =
        resident_index == nullptr ||
        resident_index->screening_mode ==
            ScreeningMode::exact_only;
    const double radius_m = config.combined_radius_m / 2.0;

    {
    const size_t refine_total = pair_list.size();
    const int num_refine_threads =
#ifdef CONJUNCTION_SINGLE_THREAD
        1;
#else
        std::max(1, config.num_threads);
#endif

    if (refine_total > 0 && num_refine_threads > 1) {
#ifndef CONJUNCTION_SINGLE_THREAD
        // Parallel refinement with barrier-based batching for progress.
        // Split pairs into batches; each batch uses N threads via barrier,
        // then the main thread fires progress and starts the next batch.
        const size_t REFINE_BATCH_SIZE = 500;
        const size_t num_refine_batches =
            (refine_total + REFINE_BATCH_SIZE - 1) / REFINE_BATCH_SIZE;

        std::vector<std::vector<ConjunctionEvent>> thread_events(num_refine_threads);
        std::vector<std::vector<ExactSolvedHit>> thread_solved(num_refine_threads);

        ReusableBarrier refine_barrier(static_cast<size_t>(num_refine_threads + 1));
        std::atomic<size_t> batch_start{0};
        std::atomic<size_t> batch_end{0};
        std::atomic<bool> refine_shutdown{false};

        std::vector<std::thread> threads;
        for (int t = 0; t < num_refine_threads; t++) {
            threads.emplace_back([&, t]() {
                while (true) {
                    refine_barrier.wait();
                    if (refine_shutdown.load(std::memory_order_acquire)) return;
                    const size_t b_start = batch_start.load(std::memory_order_acquire);
                    const size_t b_end = batch_end.load(std::memory_order_acquire);
                    const size_t span = b_end - b_start;
                    const size_t chunk = (span + num_refine_threads - 1)
                                         / num_refine_threads;
                    const size_t from = b_start + static_cast<size_t>(t) * chunk;
                    const size_t to = std::min(from + chunk, b_end);
                    for (size_t i = from; i < to; i++) {
                        const auto& [key, hit] = pair_list[i];
                        {
                            if (use_exact_solution_path) {
                                auto solved = solve_coarse_hit_if_within_threshold_exact(
                                    tles[hit.obj1_index], tles[hit.obj2_index],
                                    hit.obj1_index, hit.obj2_index,
                                    hit, start_jd, end_jd, config);
                if (has_error()) { ++failed_pairs; clear_error(); continue; }
                                if (solved.has_value())
                                    thread_solved[t].push_back(std::move(*solved));
                            } else {
                                auto event = refine_coarse_hit_if_within_threshold(
                                    tles[hit.obj1_index], tles[hit.obj2_index],
                                    hit, start_jd, end_jd, config, resident_index);
                                if (has_error()) { ++failed_pairs; clear_error(); continue; }
                                if (event.has_value())
                                    thread_events[t].push_back(std::move(*event));
                            }
                        }
                    }
                    refine_barrier.wait();
                }
            });
        }

        for (size_t b = 0; b < num_refine_batches; b++) {
            batch_start.store(b * REFINE_BATCH_SIZE, std::memory_order_release);
            batch_end.store(
                std::min((b + 1) * REFINE_BATCH_SIZE, refine_total),
                std::memory_order_release);
            refine_barrier.wait();
            refine_barrier.wait();
            if (progress) {
                progress(0.75 + 0.25 * static_cast<double>(b + 1)
                                      / static_cast<double>(num_refine_batches),
                         "Refining TCA...");
            }
        }

        refine_shutdown.store(true, std::memory_order_release);
        refine_barrier.wait();
        for (auto& t : threads) t.join();

        for (auto& te : thread_events)
            events.insert(events.end(),
                std::make_move_iterator(te.begin()),
                std::make_move_iterator(te.end()));
        for (auto& ts : thread_solved)
            solved_hits.insert(solved_hits.end(),
                std::make_move_iterator(ts.begin()),
                std::make_move_iterator(ts.end()));
#endif
    } else {
        // Single-threaded refinement with progress.
        size_t refine_index = 0;
        for (const auto& [key, hit] : pair_list) {
            {
                if (use_exact_solution_path) {
                    auto solved = solve_coarse_hit_if_within_threshold_exact(
                        tles[hit.obj1_index], tles[hit.obj2_index],
                        hit.obj1_index, hit.obj2_index,
                        hit, start_jd, end_jd, config);
                if (has_error()) { ++failed_pairs; clear_error(); continue; }
                    if (solved.has_value()) solved_hits.push_back(std::move(*solved));
                } else {
                    auto event = refine_coarse_hit_if_within_threshold(
                        tles[hit.obj1_index], tles[hit.obj2_index],
                        hit, start_jd, end_jd, config, resident_index);
                                if (has_error()) { ++failed_pairs; clear_error(); continue; }
                    if (event.has_value()) events.push_back(std::move(*event));
                }
            }
            ++refine_index;
            if (progress && refine_total > 0 &&
                (refine_index % 100 == 0 || refine_index == refine_total)) {
                progress(0.75 + 0.25 * static_cast<double>(refine_index)
                                      / static_cast<double>(refine_total),
                         "Refining TCA...");
            }
        }
    }
    }

    if (use_exact_solution_path) {
        events.reserve(events.size() + solved_hits.size());
        for (const auto& solved : solved_hits) {
            {
                auto event = assess_conjunction_at_tca(
                    tles[solved.obj1_index],
                    tles[solved.obj2_index],
                    solved.tca_jd,
                    radius_m,
                    radius_m);
                if (has_error()) { ++failed_pairs; clear_error(); continue; }
                if (is_conjunction_within_threshold(event.min_range_km, config.threshold_km)) {
                    events.push_back(std::move(event));
                }
            }
        }
    }

    stats.failed_pairs = failed_pairs.load();
    stats.tca_refined = pair_list.size();
    stats.conjunctions_found = events.size();

    // Sort by max probability descending
    std::sort(events.begin(), events.end(),
              [](const ConjunctionEvent& a, const ConjunctionEvent& b) {
                  return a.max_probability > b.max_probability;
              });

    auto t_end = std::chrono::high_resolution_clock::now();
    stats.elapsed_ms = std::chrono::duration<double, std::milli>(t_end - t_start).count();

    if (progress) progress(1.0, "Done");

    return events;
}

std::vector<ConjunctionEvent> screen_precomputed_tles_implicit(
    const std::vector<TLE>& tles,
    const std::vector<float>& perigee_km,
    const std::vector<float>& apogee_km,
    const std::vector<uint8_t>& is_primary,
    const std::vector<uint8_t>& participates,
    const ScreeningConfig& config,
    ScreeningStats& stats,
    ProgressCallback progress,
    const ResidentScreeningIndex* resident_index)
{
    const auto require_full_size =
        [expected_size = tles.size()](const auto& values, const char* name) {
            if (values.size() != expected_size) {
                set_error(
                    std::string("screen_precomputed_tles_implicit: ") +
                    name +
                    " must be exactly tles.size()"); return;
            }
        };
    const auto require_optional_size =
        [expected_size = tles.size()](const auto& values, const char* name) {
            if (!values.empty() && values.size() != expected_size) {
                set_error(
                    std::string("screen_precomputed_tles_implicit: ") +
                    name +
                    " must be empty or exactly tles.size()"); return;
            }
        };
    require_full_size(perigee_km, "perigee_km");
    require_full_size(apogee_km, "apogee_km");
    require_optional_size(is_primary, "is_primary");
    require_optional_size(participates, "participates");
    if (has_error()) return {};
    const double step_sec = std::max(1.0, config.coarse_step_sec);
    const double step_days = step_sec / 86400.0;
    const double start_jd = config.start_jd;
    const double end_jd = start_jd + config.duration_days;
    const int total_steps =
        static_cast<int>((end_jd - start_jd) / step_days);

    if (total_steps <= MAX_IMPLICIT_COARSE_STEPS_PER_CHUNK) {
        return screen_precomputed_tles_implicit_window(
            tles,
            perigee_km,
            apogee_km,
            is_primary,
            participates,
            config,
            stats,
            progress,
            resident_index);
    }

    auto t_start = std::chrono::high_resolution_clock::now();
    reset_implicit_stats(stats);

    std::map<uint64_t, CoarseHitRecord> carry_hits;
    std::vector<ConjunctionEvent> events;
    const int chunk_steps = MAX_IMPLICIT_COARSE_STEPS_PER_CHUNK;
    const int overlap_steps = 1;

    const auto globalize_hit =
        [](const CoarseHitRecord& hit, int step_offset) -> CoarseHitRecord {
            CoarseHitRecord global_hit = hit;
            if (global_hit.earliest_step != std::numeric_limits<int32_t>::max()) {
                global_hit.earliest_step += step_offset;
            }
            if (global_hit.latest_step >= 0) {
                global_hit.latest_step += step_offset;
            }
            if (global_hit.best_step >= 0) {
                global_hit.best_step += step_offset;
            }
            return global_hit;
        };
    const auto refine_and_store_hit =
        [&](const CoarseHitRecord& hit) {
            {
                auto event = refine_coarse_hit_if_within_threshold(
                    tles[hit.obj1_index],
                    tles[hit.obj2_index],
                    hit,
                    start_jd,
                    end_jd,
                    config,
                    resident_index);
                if (has_error()) { ++stats.failed_pairs; clear_error(); return; }
                stats.tca_refined += 1;
                if (event.has_value()) {
                    events.push_back(std::move(*event));
                }
            }
        };

    for (int chunk_start_step = 0; chunk_start_step <= total_steps;
         chunk_start_step += chunk_steps) {
        const int nominal_end_step =
            std::min(total_steps, chunk_start_step + chunk_steps);
        const bool is_final_chunk = nominal_end_step >= total_steps;
        const int screen_end_step = is_final_chunk
            ? nominal_end_step
            : std::min(total_steps, nominal_end_step + overlap_steps);

        ScreeningConfig chunk_config = config;
        chunk_config.start_jd =
            start_jd + static_cast<double>(chunk_start_step) * step_days;
        chunk_config.duration_days = std::max(
            0.0,
            static_cast<double>(screen_end_step - chunk_start_step) * step_days);

        auto chunk_result = collect_precomputed_tles_implicit_window(
            tles,
            perigee_km,
            apogee_km,
            is_primary,
            participates,
            chunk_config,
            nullptr,
            resident_index);

        if (has_error()) return {};
        for (const auto& [key, hit] : chunk_result.coarse_hits) {
            auto global_hit = globalize_hit(hit, chunk_start_step);
            auto& aggregate = carry_hits[key];
            if (aggregate.best_step < 0) {
                aggregate.obj1_index = global_hit.obj1_index;
                aggregate.obj2_index = global_hit.obj2_index;
            }
            merge_coarse_hit_record(aggregate, global_hit);
        }

        std::vector<uint64_t> finalized_keys;
        finalized_keys.reserve(carry_hits.size());
        for (const auto& [key, hit] : carry_hits) {
            if (is_final_chunk || hit.latest_step < nominal_end_step) {
                finalized_keys.push_back(key);
            }
        }
        for (uint64_t key : finalized_keys) {
            const auto found = carry_hits.find(key);
            if (found == carry_hits.end()) {
                continue;
            }
            refine_and_store_hit(found->second);
            carry_hits.erase(found);
        }

        stats.kdtree_candidates += chunk_result.stats.kdtree_candidates;
        stats.propagations += chunk_result.stats.propagations;

        if (progress) {
            const double fraction =
                std::min(1.0,
                         static_cast<double>(nominal_end_step) /
                             static_cast<double>(std::max(1, total_steps)));
            progress(fraction, "Streaming resident screening...");
        }

        if (is_final_chunk) {
            break;
        }
    }

    std::sort(events.begin(), events.end(),
              [](const ConjunctionEvent& a, const ConjunctionEvent& b) {
                  return a.max_probability > b.max_probability;
              });
    events = dedupe_chunked_events(std::move(events));
    stats.conjunctions_found = events.size();
    auto t_end = std::chrono::high_resolution_clock::now();
    stats.elapsed_ms = std::chrono::duration<double, std::milli>(t_end - t_start).count();

    if (progress) {
        progress(1.0, "Done");
    }

    return events;
}

std::vector<ConjunctionEvent> ConjunctionScreener::screen(
    const std::vector<GPElement>& catalog,
    ProgressCallback progress)
{
    const uint64_t pair_estimate =
        catalog.size() < 2
            ? 0u
            : (static_cast<uint64_t>(catalog.size()) *
               static_cast<uint64_t>(catalog.size() - 1u)) / 2u;
    if (pair_estimate >= MIN_IMPLICIT_ALL_VS_ALL_PAIR_ESTIMATE) {
        stats_ = {};
        stats_.total_objects = catalog.size();
        if (progress) progress(0.1, "Converting GP to TLE...");

        std::vector<TLE> tles;
        std::vector<float> perigee_km;
        std::vector<float> apogee_km;
        tles.reserve(catalog.size());
        perigee_km.reserve(catalog.size());
        apogee_km.reserve(catalog.size());
        for (const auto& gp : catalog) {
            {
                tles.push_back(gp_to_tle(gp));
                if (has_error()) return {};
            }
            perigee_km.push_back(static_cast<float>(gp.perigee_km));
            apogee_km.push_back(static_cast<float>(gp.apogee_km));
        }

        if (progress) progress(0.15, "Screening large catalog...");
        auto events = screen_precomputed_tles_implicit(
            tles,
            perigee_km,
            apogee_km,
            {},
            {},
            config_,
            stats_,
            progress,
            nullptr);
        stats_.total_objects = catalog.size();
        if (stats_.pairs_screened == 0) {
            stats_.pairs_screened = pair_estimate;
        }
        return events;
    }
    return screen(catalog, catalog, progress);
}

std::vector<ConjunctionEvent> ConjunctionScreener::screen(
    const std::vector<GPElement>& primaries,
    const std::vector<GPElement>& secondaries,
    ProgressCallback progress)
{
    stats_ = {};

    // Merge catalogs (dedup by NORAD ID)
    std::vector<GPElement> catalog;
    std::unordered_set<int> seen;
    std::vector<uint32_t> primary_indices;
    std::vector<uint32_t> secondary_indices;
    for (const auto& gp : primaries) {
        if (seen.insert(gp.norad_cat_id).second) {
            primary_indices.push_back(static_cast<uint32_t>(catalog.size()));
            catalog.push_back(gp);
            continue;
        }

        auto existing = std::find_if(
            catalog.begin(),
            catalog.end(),
            [&](const GPElement& candidate) {
                return candidate.norad_cat_id == gp.norad_cat_id;
            });
        if (existing != catalog.end()) {
            primary_indices.push_back(
                static_cast<uint32_t>(std::distance(catalog.begin(), existing)));
        }
    }
    for (const auto& gp : secondaries) {
        if (seen.insert(gp.norad_cat_id).second) {
            secondary_indices.push_back(static_cast<uint32_t>(catalog.size()));
            catalog.push_back(gp);
            continue;
        }

        auto existing = std::find_if(
            catalog.begin(),
            catalog.end(),
            [&](const GPElement& candidate) {
                return candidate.norad_cat_id == gp.norad_cat_id;
            });
        if (existing != catalog.end()) {
            secondary_indices.push_back(
                static_cast<uint32_t>(std::distance(catalog.begin(), existing)));
        }
    }

    std::sort(primary_indices.begin(), primary_indices.end());
    primary_indices.erase(
        std::unique(primary_indices.begin(), primary_indices.end()),
        primary_indices.end());
    std::sort(secondary_indices.begin(), secondary_indices.end());
    secondary_indices.erase(
        std::unique(secondary_indices.begin(), secondary_indices.end()),
        secondary_indices.end());

    stats_.total_objects = catalog.size();
    if (progress) progress(0.1, "Converting GP to TLE...");

    std::vector<TLE> tles;
    tles.reserve(catalog.size());
    for (const auto& gp : catalog) {
        {
            tles.push_back(gp_to_tle(gp));
                if (has_error()) return {};
        }
    }

    const bool all_vs_all =
        primary_indices.size() == catalog.size() &&
        secondary_indices.size() == catalog.size() &&
        std::equal(
            primary_indices.begin(),
            primary_indices.end(),
            secondary_indices.begin());
    const uint64_t pair_estimate =
        catalog.size() < 2
            ? 0u
            : (static_cast<uint64_t>(catalog.size()) *
               static_cast<uint64_t>(catalog.size() - 1u)) / 2u;

    if (all_vs_all && pair_estimate >= MIN_IMPLICIT_ALL_VS_ALL_PAIR_ESTIMATE) {
        std::vector<float> perigee_km;
        std::vector<float> apogee_km;
        perigee_km.reserve(catalog.size());
        apogee_km.reserve(catalog.size());
        for (const auto& gp : catalog) {
            perigee_km.push_back(static_cast<float>(gp.perigee_km));
            apogee_km.push_back(static_cast<float>(gp.apogee_km));
        }

        if (progress) progress(0.15, "Screening large catalog...");
        auto events = screen_precomputed_tles_implicit(
            tles,
            perigee_km,
            apogee_km,
            {},
            {},
            config_,
            stats_,
            progress,
            nullptr);
        stats_.total_objects = catalog.size();
        if (stats_.pairs_screened == 0) {
            stats_.pairs_screened = pair_estimate;
        }
        return events;
    }

    if (progress) progress(0.15, "Prefiltering pairs by altitude...");

    uint64_t total_cross_pairs = 0;
    auto valid_pairs = prefilter_cross_pairs(
        catalog,
        primary_indices,
        secondary_indices,
        &total_cross_pairs);
    stats_.pairs_prefiltered =
        total_cross_pairs >= valid_pairs.size()
            ? total_cross_pairs - valid_pairs.size()
            : 0;
    stats_.pairs_screened = valid_pairs.size();

    return screen_precomputed_tles(tles, valid_pairs, config_, stats_, progress);
}

} // namespace conjunction
