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
#include "conjunction/screening_tight.h"
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

// A coarse-pass propagation failure excludes that object from the screening
// (see ExcludedObject). Keeps the earliest failing epoch, so the record is the
// same whichever worker saw the failure first.
void record_exclusion(std::map<uint32_t, ExcludedObject>& excluded,
                      uint32_t object_index, double jd, const std::string& reason) {
    auto [it, inserted] = excluded.try_emplace(object_index);
    if (inserted || jd < it->second.first_failure_jd) {
        it->second.index = object_index;
        it->second.first_failure_jd = jd;
        it->second.reason = reason;
    }
}

void merge_exclusions(std::map<uint32_t, ExcludedObject>& into,
                      const std::map<uint32_t, ExcludedObject>& from) {
    for (const auto& [object_index, excluded] : from) {
        record_exclusion(into, object_index, excluded.first_failure_jd, excluded.reason);
    }
}

bool involves_excluded(uint32_t obj1_index, uint32_t obj2_index,
                       const std::map<uint32_t, ExcludedObject>& excluded) {
    return !excluded.empty() &&
           (excluded.count(obj1_index) != 0 || excluded.count(obj2_index) != 0);
}

std::vector<ExcludedObject> excluded_list(
    const std::map<uint32_t, ExcludedObject>& excluded) {
    std::vector<ExcludedObject> out;
    out.reserve(excluded.size());
    for (const auto& [object_index, record] : excluded) out.push_back(record);
    return out;
}

// Coarse hits are kept per encounter, not per pair. An encounter is a maximal
// run of consecutive coarse steps at which the pair is inside its coarse
// radius; the orbits bring a pair together again and again over a window,
// and each encounter is bracketed and refined on its own. (One record per
// pair over the whole window bracketed all encounters together and refined
// one of them, so a multi-day window reported at most one conjunction per
// pair and, refining near the closest coarse sample, often not the real one.)
// A worker scans a contiguous block of steps in increasing order, so a hit
// either extends the pair's open run (its last hit was the previous step) or
// closes that run and opens a new one.
struct CoarseRunCollector {
    std::unordered_map<uint64_t, CoarseHitRecord> open;
    std::vector<CoarseHitRecord> closed;

    void hit(uint32_t lo, uint32_t hi, int32_t step, double distance_km) {
        auto& run = open[coarse_hit_key(lo, hi)];
        if (run.best_step >= 0 && run.latest_step + 1 < step) {
            closed.push_back(run);
            run = CoarseHitRecord{};
        }
        if (run.best_step < 0) {
            run.obj1_index = lo;
            run.obj2_index = hi;
        }
        merge_coarse_hit(run, step, distance_km);
    }

    std::vector<CoarseHitRecord> finish() {
        closed.reserve(closed.size() + open.size());
        for (const auto& [key, run] : open) closed.push_back(run);
        open.clear();
        return std::move(closed);
    }
};

uint64_t encounter_key(const CoarseHitRecord& hit) {
    return coarse_hit_key(hit.obj1_index, hit.obj2_index);
}

// Joins runs of one pair that overlap or touch (runs of neighbouring worker
// blocks or chunks) into maximal encounters, ordered by pair then time. The
// result does not depend on how the steps were split among workers or chunks.
std::vector<CoarseHitRecord> coalesce_encounters(std::vector<CoarseHitRecord> runs) {
    std::sort(runs.begin(), runs.end(),
              [](const CoarseHitRecord& a, const CoarseHitRecord& b) {
                  const uint64_t ka = encounter_key(a);
                  const uint64_t kb = encounter_key(b);
                  if (ka != kb) return ka < kb;
                  if (a.earliest_step != b.earliest_step) {
                      return a.earliest_step < b.earliest_step;
                  }
                  return a.latest_step < b.latest_step;
              });
    size_t encounters = 0;
    for (size_t i = 0; i < runs.size(); ++i) {
        if (encounters > 0 &&
            encounter_key(runs[encounters - 1]) == encounter_key(runs[i]) &&
            runs[i].earliest_step <= runs[encounters - 1].latest_step + 1) {
            merge_coarse_hit_record(runs[encounters - 1], runs[i]);
        } else {
            runs[encounters++] = runs[i];
        }
    }
    runs.resize(encounters);
    return runs;
}

std::vector<CoarseHitRecord> drop_excluded_encounters(
    std::vector<CoarseHitRecord> encounters,
    const std::map<uint32_t, ExcludedObject>& excluded) {
    if (excluded.empty()) return encounters;
    encounters.erase(
        std::remove_if(encounters.begin(), encounters.end(),
                       [&](const CoarseHitRecord& hit) {
                           return involves_excluded(hit.obj1_index, hit.obj2_index, excluded);
                       }),
        encounters.end());
    return encounters;
}

uint64_t distinct_encounter_pairs(const std::vector<CoarseHitRecord>& encounters) {
    uint64_t pairs = 0;
    for (size_t i = 0; i < encounters.size(); ++i) {
        if (i == 0 || encounter_key(encounters[i]) != encounter_key(encounters[i - 1])) ++pairs;
    }
    return pairs;
}

// Worker thread_id of total_threads scans the contiguous block [begin, end)
// of the steps first_step..last_step; the blocks cover them in order.
std::pair<int32_t, int32_t> worker_step_block(
    int32_t first_step, int32_t last_step, int thread_id, int total_threads) {
    const int64_t count =
        std::max<int64_t>(0, static_cast<int64_t>(last_step) - first_step + 1);
    const int64_t workers = std::max(1, total_threads);
    const int64_t worker = std::min<int64_t>(std::max(0, thread_id), workers - 1);
    return {static_cast<int32_t>(first_step + count * worker / workers),
            static_cast<int32_t>(first_step + count * (worker + 1) / workers)};
}

// A conjunction belongs to the window that holds its TCA. A refined TCA can
// leave the window by up to the one-second golden-section bracket. If the pair
// is strictly closer out there than at the window edge, the approach goes on
// past the edge: the TCA lies in the neighbouring window, which reports it.
// If it is not closer (a range that is flat across the edge, as for two
// objects on one element set), the conjunction holds at the edge and is
// reported there. The refinement tolerance keeps a TCA that close to an edge
// in both windows rather than in neither.
std::optional<ConjunctionSolution> solution_in_screening_window(
    const TLE& obj1, const TLE& obj2, const ConjunctionSolution& solution,
    double start_jd, double end_jd, double fine_tol_sec) {
    const double tolerance_days = std::max(0.001, fine_tol_sec) / 86400.0;
    if (!std::isfinite(solution.tca_jd)) return std::nullopt;
    if (solution.tca_jd >= start_jd - tolerance_days &&
        solution.tca_jd <= end_jd + tolerance_days) {
        return solution;
    }
    const double edge_jd = solution.tca_jd < start_jd ? start_jd : end_jd;
    const auto at_edge = assess_conjunction_solution_in_window_near_hint(
        obj1, obj2, edge_jd, edge_jd, edge_jd);
    if (has_error() || solution.min_range_km < at_edge.min_range_km) {
        return std::nullopt;
    }
    return at_edge;
}

// Highest probability first; equal probabilities in TCA order, then by pair,
// so the order does not depend on the order in which encounters were refined.
void sort_conjunction_events(std::vector<ConjunctionEvent>& events) {
    std::sort(events.begin(), events.end(),
              [](const ConjunctionEvent& a, const ConjunctionEvent& b) {
                  if (a.max_probability != b.max_probability) {
                      return a.max_probability > b.max_probability;
                  }
                  if (a.tca_jd != b.tca_jd) return a.tca_jd < b.tca_jd;
                  if (a.obj1.norad_cat_id != b.obj1.norad_cat_id) {
                      return a.obj1.norad_cat_id < b.obj1.norad_cat_id;
                  }
                  return a.obj2.norad_cat_id < b.obj2.norad_cat_id;
              });
}

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

std::vector<ExactSolvedHit> solve_encounter_exact(
    const TLE& obj1,
    const TLE& obj2,
    uint32_t obj1_index,
    uint32_t obj2_index,
    const CoarseHitRecord& hit,
    double slice_start_jd,
    double slice_end_jd,
    const ScreeningConfig& config);

// Conjunctions of refined encounters, unsorted, with the object indices of
// each event and of each encounter whose refinement failed (so a caller can
// drop those of objects excluded afterwards).
struct RefinedEncounters {
    std::vector<ConjunctionEvent> events;
    std::vector<std::pair<uint32_t, uint32_t>> event_objects;
    std::vector<std::pair<uint32_t, uint32_t>> failed_objects;
};

RefinedEncounters refine_encounters(
    const std::vector<TLE>& tles,
    const std::vector<CoarseHitRecord>& encounters,
    const ScreeningConfig& config,
    ProgressCallback progress,
    const ResidentScreeningIndex* resident_index);

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
// workers. Longer windows run their coarse pass in chunks of this many steps;
// encounters are joined across chunks and refined once, as in one window.
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

    CoarseRunCollector runs;

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
    // Objects this worker has already excluded; their pairs are dropped after
    // the merge, so they are not propagated again here.
    std::vector<uint8_t> excluded_here(tles.size(), 0);
    const auto [block_begin, block_end] =
        worker_step_block(0, total_steps, thread_id, total_threads);

    for (int step = block_begin; step < block_end; ++step) {
        double jd = start_jd + step * step_days;
        std::vector<KDPoint> cached_points(tles.size());
        std::vector<uint8_t> has_state(tles.size(), 0);
        std::vector<KDPoint> secondary_points;
        secondary_points.reserve(secondary_ids.size());

        for (uint32_t secondary_id : secondary_ids) {
            if (excluded_here[secondary_id]) continue;
            {
                const auto state = propagate_sgp4(tles[secondary_id], jd);
                if (has_error()) {
                    record_exclusion(work.excluded, secondary_id, jd, error_message());
                    clear_error();
                    excluded_here[secondary_id] = 1;
                    continue;
                }
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
                    if (excluded_here[primary_id]) continue;
                    {
                        const auto state = propagate_sgp4(tles[primary_id], jd);
                        if (has_error()) {
                            record_exclusion(work.excluded, primary_id, jd, error_message());
                            clear_error();
                            excluded_here[primary_id] = 1;
                            continue;
                        }
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
                    runs.hit(obj1, obj2, step, dist);
                }
            }
        } else {
            for (uint32_t primary_id : primary_ids) {
                if (!has_state[primary_id]) {
                    if (excluded_here[primary_id]) continue;
                    {
                        const auto state = propagate_sgp4(tles[primary_id], jd);
                        if (has_error()) {
                            record_exclusion(work.excluded, primary_id, jd, error_message());
                            clear_error();
                            excluded_here[primary_id] = 1;
                            continue;
                        }
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
                        runs.hit(obj1, obj2, step, dist);
                    }
                }
            }
        }
    }

    work.coarse_hits = runs.finish();
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

    // Merge exclusions first (worker order is fixed), then the encounters of
    // every pair whose objects both propagated over the window.
    std::map<uint32_t, ExcludedObject> excluded;
    for (const auto& tw : thread_results) {
        if (!tw.error.empty()) { set_error(tw.error); return {}; }
        merge_exclusions(excluded, tw.excluded);
    }
    stats.excluded_objects = excluded_list(excluded);
    std::vector<CoarseHitRecord> runs;
    for (auto& tw : thread_results) {
        stats.propagations += tw.propagations;
        runs.insert(runs.end(), tw.coarse_hits.begin(), tw.coarse_hits.end());
        tw.coarse_hits = {};
    }
    const auto encounters = drop_excluded_encounters(
        coalesce_encounters(std::move(runs)), excluded);

    if (progress) progress(0.7, "Deduplicating candidates...");

    stats.kdtree_candidates = distinct_encounter_pairs(encounters);

    auto refined = refine_encounters(tles, encounters, config, progress, nullptr);
    auto events = std::move(refined.events);
    stats.failed_pairs = refined.failed_objects.size();
    stats.tca_refined = encounters.size();
    stats.conjunctions_found = events.size();
    sort_conjunction_events(events);

    auto t_end = std::chrono::high_resolution_clock::now();
    stats.elapsed_ms = std::chrono::duration<double, std::milli>(t_end - t_start).count();

    if (progress) progress(1.0, "Done");

    return events;
}

// ============================================================================
// Implicit-pair screening (no materialized pair list)
// ============================================================================

// Scans the coarse steps first_step..last_step of the window starting at
// start_jd (step k is at start_jd + k * step_sec), this worker taking its
// contiguous block of them. Step numbers are the window's, whatever the range.
ScreeningThreadWork process_time_steps_implicit(
    const ScreeningConfig& config,
    const std::vector<TLE>& tles,
    const std::vector<float>& perigee_km,
    const std::vector<float>& apogee_km,
    const std::vector<uint8_t>& is_primary,
    const std::vector<uint8_t>& participates,
    double start_jd, int32_t first_step, int32_t last_step, double step_sec,
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

    // One record per encounter (a run of consecutive coarse hits of a pair):
    // memory is O(encounters), and each encounter keeps its own bracket.
    CoarseRunCollector runs;

    // Reusable per-step buffers to avoid repeated allocation.
    std::vector<KDPoint> points;
    std::vector<uint32_t> neighbor_indexes;
    std::vector<KDPoint> cached_points(n);
    std::vector<uint8_t> has_state(n, 0);
    std::vector<size_t> segment_cursors(n, 0);
    // Objects this worker has already excluded (see ExcludedObject).
    std::vector<uint8_t> excluded_here(n, 0);

    const auto [block_begin, block_end] =
        worker_step_block(first_step, last_step, thread_id, total_threads);
    for (int step = block_begin; step < block_end; ++step) {
        const double jd = start_jd + step * step_days;

        // Propagate all active objects.
        points.clear();
        points.reserve(active_ids.size());
        std::fill(has_state.begin(), has_state.end(), 0);

        for (uint32_t obj_id : active_ids) {
            if (excluded_here[obj_id]) continue;
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
                    if (has_error()) {
                        record_exclusion(work.excluded, obj_id, jd, error_message());
                        clear_error();
                        excluded_here[obj_id] = 1;
                        continue;
                    }
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
                    runs.hit(lo, hi, step, dist);
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
                    runs.hit(lo, hi, step, dist);
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
                        runs.hit(lo, hi, step, dist);
                    }
                }
            }
        }
    }

    work.coarse_hits = runs.finish();
    return work;
}

struct ImplicitCoarseHitWindowResult {
    // Joined encounters of the scanned steps; excluded objects already dropped.
    std::vector<CoarseHitRecord> encounters;
    ScreeningStats stats;
    std::map<uint32_t, ExcludedObject> excluded;
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

std::vector<ExactSolvedHit> solve_encounter_exact(
    const TLE& obj1,
    const TLE& obj2,
    uint32_t obj1_index,
    uint32_t obj2_index,
    const CoarseHitRecord& hit,
    double slice_start_jd,
    double slice_end_jd,
    const ScreeningConfig& config)
{
    std::vector<ExactSolvedHit> solved;
    const auto keep = [&](const ConjunctionSolution& solution) {
        if (has_error() ||
            !is_conjunction_within_threshold(solution.min_range_km, config.threshold_km)) {
            return;
        }
        const auto in_window = solution_in_screening_window(
            obj1, obj2, solution, slice_start_jd, slice_end_jd, config.fine_tol_sec);
        if (in_window.has_value() &&
            is_conjunction_within_threshold(in_window->min_range_km, config.threshold_km)) {
            solved.push_back(ExactSolvedHit{obj1_index, obj2_index, in_window->tca_jd});
        }
    };

    const auto window = build_refinement_window(
        hit,
        slice_start_jd,
        slice_end_jd,
        config.coarse_step_sec);

    // At most three consecutive coarse hits: one fast pass, gated by a local
    // descent from the closest coarse sample.
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
            return solved;
        }
    }

    if (window.duration_days() <= 0.0) {
        keep(assess_conjunction_solution_in_window_near_hint(
            obj1,
            obj2,
            slice_start_jd,
            slice_end_jd,
            use_local_gate
                ? coarse_solution.tca_jd
                : 0.5 * (slice_start_jd + slice_end_jd)));
    } else if (use_local_gate) {
        keep(assess_conjunction_solution_in_window_near_hint(
            obj1,
            obj2,
            window.start_jd,
            window.end_jd,
            coarse_solution.tca_jd));
    } else {
        // A longer encounter is a slower pass, and a slow pair can close in
        // more than once while it stays inside the coarse radius: every local
        // minimum of the range within the threshold is its own conjunction.
        for (const auto& solution : assess_conjunction_solutions_within_threshold(
                 obj1,
                 obj2,
                 window.start_jd,
                 window.duration_days(),
                 config.threshold_km,
                 config.fine_tol_sec)) {
            keep(solution);
        }
    }
    return solved;
}

// Refines every encounter on its own bracket and materializes the
// conjunctions it holds. Used by the explicit-pair, the single-window and the
// chunked paths alike, so an encounter refines to the same TCA and miss
// distance whichever path found it.
RefinedEncounters refine_encounters(
    const std::vector<TLE>& tles,
    const std::vector<CoarseHitRecord>& encounters,
    const ScreeningConfig& config,
    ProgressCallback progress,
    const ResidentScreeningIndex* resident_index)
{
    const double start_jd = config.start_jd;
    const double end_jd = start_jd + config.duration_days;

    if (progress) progress(0.75, "Refining TCA...");

    RefinedEncounters result;
    auto& events = result.events;
    std::vector<ExactSolvedHit> solved_hits;
    const bool use_exact_solution_path =
        resident_index == nullptr ||
        resident_index->screening_mode ==
            ScreeningMode::exact_only;
    const double radius_m = config.combined_radius_m / 2.0;

    // Polynomial-mode events carry their encounter's objects; exact-mode
    // events get theirs from the solved hit when materialized below.
    struct PolynomialEvent {
        ConjunctionEvent event;
        std::pair<uint32_t, uint32_t> objects;
    };
    using FailedObjects = std::vector<std::pair<uint32_t, uint32_t>>;
    const auto refine_one =
        [&](const CoarseHitRecord& hit,
            std::vector<ExactSolvedHit>& solved_out,
            std::vector<PolynomialEvent>& events_out,
            FailedObjects& failed_out) {
            if (use_exact_solution_path) {
                auto solved = solve_encounter_exact(
                    tles[hit.obj1_index], tles[hit.obj2_index],
                    hit.obj1_index, hit.obj2_index,
                    hit, start_jd, end_jd, config);
                if (has_error()) {
                    failed_out.emplace_back(hit.obj1_index, hit.obj2_index);
                    clear_error();
                    return;
                }
                solved_out.insert(solved_out.end(), solved.begin(), solved.end());
            } else {
                auto event = refine_coarse_hit_if_within_threshold(
                    tles[hit.obj1_index], tles[hit.obj2_index],
                    hit, start_jd, end_jd, config, resident_index);
                if (has_error()) {
                    failed_out.emplace_back(hit.obj1_index, hit.obj2_index);
                    clear_error();
                    return;
                }
                if (event.has_value()) {
                    events_out.push_back({std::move(*event), {hit.obj1_index, hit.obj2_index}});
                }
            }
        };
    std::vector<PolynomialEvent> polynomial_events;

    {
    const size_t refine_total = encounters.size();
    const int num_refine_threads =
#ifdef CONJUNCTION_SINGLE_THREAD
        1;
#else
        std::max(1, config.num_threads);
#endif

    if (refine_total > 0 && num_refine_threads > 1) {
#ifndef CONJUNCTION_SINGLE_THREAD
        // Parallel refinement with barrier-based batching for progress.
        // Split encounters into batches; each batch uses N threads via
        // barrier, then the main thread fires progress and starts the next.
        const size_t REFINE_BATCH_SIZE = 500;
        const size_t num_refine_batches =
            (refine_total + REFINE_BATCH_SIZE - 1) / REFINE_BATCH_SIZE;

        std::vector<std::vector<PolynomialEvent>> thread_events(num_refine_threads);
        std::vector<std::vector<ExactSolvedHit>> thread_solved(num_refine_threads);
        std::vector<FailedObjects> thread_failed(num_refine_threads);

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
                        refine_one(encounters[i], thread_solved[t], thread_events[t],
                                   thread_failed[t]);
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
            polynomial_events.insert(polynomial_events.end(),
                std::make_move_iterator(te.begin()),
                std::make_move_iterator(te.end()));
        for (auto& ts : thread_solved)
            solved_hits.insert(solved_hits.end(),
                std::make_move_iterator(ts.begin()),
                std::make_move_iterator(ts.end()));
        for (auto& tf : thread_failed)
            result.failed_objects.insert(result.failed_objects.end(), tf.begin(), tf.end());
#endif
    } else {
        // Single-threaded refinement with progress.
        size_t refine_index = 0;
        for (const auto& hit : encounters) {
            refine_one(hit, solved_hits, polynomial_events, result.failed_objects);
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

    for (auto& polynomial : polynomial_events) {
        events.push_back(std::move(polynomial.event));
        result.event_objects.push_back(polynomial.objects);
    }
    if (use_exact_solution_path) {
        events.reserve(events.size() + solved_hits.size());
        for (const auto& solved : solved_hits) {
            auto event = assess_conjunction_at_tca(
                tles[solved.obj1_index],
                tles[solved.obj2_index],
                solved.tca_jd,
                radius_m,
                radius_m);
            if (has_error()) {
                result.failed_objects.emplace_back(solved.obj1_index, solved.obj2_index);
                clear_error();
                continue;
            }
            if (is_conjunction_within_threshold(event.min_range_km, config.threshold_km)) {
                events.push_back(std::move(event));
                result.event_objects.emplace_back(solved.obj1_index, solved.obj2_index);
            }
        }
    }
    return result;
}

// Refines one window's encounters and records the counts every window path
// reports: failed pairs, encounters refined, conjunctions found. Events are
// returned in the canonical order.
std::vector<ConjunctionEvent> refine_window_encounters(
    const std::vector<TLE>& tles,
    const std::vector<CoarseHitRecord>& encounters,
    const ScreeningConfig& config,
    ScreeningStats& stats,
    ProgressCallback progress,
    const ResidentScreeningIndex* resident_index)
{
    auto refined = refine_encounters(tles, encounters, config, progress, resident_index);
    auto events = std::move(refined.events);
    stats.failed_pairs = refined.failed_objects.size();
    stats.tca_refined = encounters.size();
    stats.conjunctions_found = events.size();
    sort_conjunction_events(events);
    return events;
}

ImplicitCoarseHitWindowResult collect_precomputed_tles_implicit_window(
    const std::vector<TLE>& tles,
    const std::vector<float>& perigee_km,
    const std::vector<float>& apogee_km,
    const std::vector<uint8_t>& is_primary,
    const std::vector<uint8_t>& participates,
    const ScreeningConfig& config,
    int32_t first_step,
    int32_t last_step,
    ProgressCallback progress,
    const ResidentScreeningIndex* resident_index)
{
    ImplicitCoarseHitWindowResult result;
    auto& stats = result.stats;
    auto t_start = std::chrono::high_resolution_clock::now();
    reset_implicit_stats(stats);

    const double start_jd = config.start_jd;

    if (progress) progress(0.05, "Propagating and screening...");

    int num_threads = std::max(1, config.num_threads);
    std::vector<ScreeningThreadWork> thread_results(num_threads);

    // Determine batching from progress_interval_sec, in whole coarse steps of
    // the window, so every batch numbers its steps as the window does.
    const int64_t step_count =
        std::max<int64_t>(0, static_cast<int64_t>(last_step) - first_step + 1);
    int64_t steps_per_batch = std::max<int64_t>(1, step_count);
    if (config.progress_interval_sec > 0.0 && config.coarse_step_sec > 0.0) {
        steps_per_batch = std::max<int64_t>(
            1,
            static_cast<int64_t>(
                std::floor(config.progress_interval_sec / config.coarse_step_sec)));
    }
    const int num_batches = static_cast<int>(std::max<int64_t>(
        1, (step_count + steps_per_batch - 1) / steps_per_batch));
    const auto batch_first = [&](int b) {
        return static_cast<int32_t>(first_step + b * steps_per_batch);
    };
    const auto batch_last = [&](int b) {
        return static_cast<int32_t>(std::min<int64_t>(
            last_step, first_step + (b + 1) * steps_per_batch - 1));
    };

    std::vector<CoarseHitRecord> runs;
    auto merge_thread_results = [&]() {
        for (auto& tw : thread_results) {
            if (!tw.error.empty()) { set_error(tw.error); return; }
            merge_exclusions(result.excluded, tw.excluded);
            stats.propagations += tw.propagations;
            runs.insert(runs.end(), tw.coarse_hits.begin(), tw.coarse_hits.end());
            tw = ScreeningThreadWork{};
        }
    };

#ifdef CONJUNCTION_SINGLE_THREAD
    // Single-threaded: process each batch sequentially, fire progress between.
    num_threads = 1;
    for (int b = 0; b < num_batches; b++) {
        thread_results[0] = process_time_steps_implicit(
            config, tles, perigee_km, apogee_km, is_primary, participates,
            start_jd, batch_first(b), batch_last(b), config.coarse_step_sec, 0, 1,
            resident_index);
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
            thread_results[0] = process_time_steps_implicit(
                config, tles, perigee_km, apogee_km, is_primary, participates,
                start_jd, batch_first(b), batch_last(b), config.coarse_step_sec, 0, 1,
                resident_index);
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
                        start_jd, first_step, last_step, config.coarse_step_sec,
                        t, num_threads, resident_index);
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
                    thread_results[t] = process_time_steps_implicit(
                        config, tles, perigee_km, apogee_km,
                        is_primary, participates,
                        start_jd, batch_first(b), batch_last(b), config.coarse_step_sec,
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
    // Runs of neighbouring workers and batches join into encounters. An object
    // excluded in any batch is excluded from the whole window, including the
    // encounters it had in earlier batches.
    result.encounters = drop_excluded_encounters(
        coalesce_encounters(std::move(runs)), result.excluded);
    stats.excluded_objects = excluded_list(result.excluded);
    stats.kdtree_candidates = distinct_encounter_pairs(result.encounters);

    auto t_end = std::chrono::high_resolution_clock::now();
    stats.elapsed_ms = std::chrono::duration<double, std::milli>(t_end - t_start).count();
    return result;
}

namespace {

// Coarse steps of the window: step k is at start_jd + k * coarse_step_sec,
// k = 0..count.
int32_t window_coarse_steps(const ScreeningConfig& config) {
    const double step_days = config.coarse_step_sec / 86400.0;
    const double end_jd = config.start_jd + config.duration_days;
    return static_cast<int32_t>((end_jd - config.start_jd) / step_days);
}

} // namespace

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
        0,
        window_coarse_steps(config),
        progress,
        resident_index);
    if (has_error()) return {};
    // The coarse pass fills propagations, candidates and exclusions; the pair
    // counts are the caller's (a resident index counts its candidate pairs).
    const uint64_t pairs_screened = stats.pairs_screened;
    const uint64_t pairs_prefiltered = stats.pairs_prefiltered;
    stats = window_result.stats;
    stats.total_objects = tles.size();
    stats.pairs_screened = pairs_screened;
    stats.pairs_prefiltered = pairs_prefiltered;

    auto events = refine_window_encounters(
        tles, window_result.encounters, config, stats, progress, resident_index);

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
    const int32_t total_steps = window_coarse_steps(config);

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

    // The coarse pass runs in chunks of the window's own steps. Encounters
    // that end inside a chunk are refined when it finishes; one still open at
    // the chunk's last step is carried and joined with its continuation, so
    // every encounter is refined once, on the bracket a single window would
    // give it, and only the open encounters outlive a chunk. An object
    // excluded in a later chunk is excluded from the whole window: its
    // earlier events and failed refinements are dropped at the end.
    std::vector<CoarseHitRecord> carry;
    std::map<uint32_t, ExcludedObject> excluded;
    RefinedEncounters refined;
    const int32_t chunk_steps = MAX_IMPLICIT_COARSE_STEPS_PER_CHUNK;
    for (int32_t chunk_first = 0; chunk_first <= total_steps;
         chunk_first += chunk_steps) {
        const int32_t chunk_last =
            std::min(total_steps, chunk_first + chunk_steps - 1);
        const bool is_final_chunk = chunk_last >= total_steps;
        auto chunk_result = collect_precomputed_tles_implicit_window(
            tles,
            perigee_km,
            apogee_km,
            is_primary,
            participates,
            config,
            chunk_first,
            chunk_last,
            nullptr,
            resident_index);

        if (has_error()) return {};
        merge_exclusions(excluded, chunk_result.excluded);
        stats.propagations += chunk_result.stats.propagations;
        stats.kdtree_candidates += chunk_result.stats.kdtree_candidates;

        std::vector<CoarseHitRecord> runs = std::move(chunk_result.encounters);
        runs.insert(runs.end(), carry.begin(), carry.end());
        carry.clear();
        std::vector<CoarseHitRecord> closed;
        for (const auto& encounter : drop_excluded_encounters(
                 coalesce_encounters(std::move(runs)), excluded)) {
            if (is_final_chunk || encounter.latest_step < chunk_last) {
                closed.push_back(encounter);
            } else {
                carry.push_back(encounter);
            }
        }
        stats.tca_refined += closed.size();
        auto batch = refine_encounters(tles, closed, config, nullptr, resident_index);
        refined.events.insert(refined.events.end(),
                              std::make_move_iterator(batch.events.begin()),
                              std::make_move_iterator(batch.events.end()));
        refined.event_objects.insert(refined.event_objects.end(),
                                     batch.event_objects.begin(), batch.event_objects.end());
        refined.failed_objects.insert(refined.failed_objects.end(),
                                      batch.failed_objects.begin(), batch.failed_objects.end());

        if (progress) {
            progress(static_cast<double>(chunk_last + 1) /
                         static_cast<double>(total_steps + 1),
                     "Streaming resident screening...");
        }
    }

    stats.excluded_objects = excluded_list(excluded);
    std::vector<ConjunctionEvent> events;
    events.reserve(refined.events.size());
    for (size_t i = 0; i < refined.events.size(); ++i) {
        if (!involves_excluded(refined.event_objects[i].first,
                               refined.event_objects[i].second, excluded)) {
            events.push_back(std::move(refined.events[i]));
        }
    }
    for (const auto& [obj1_index, obj2_index] : refined.failed_objects) {
        if (!involves_excluded(obj1_index, obj2_index, excluded)) ++stats.failed_pairs;
    }
    stats.conjunctions_found = events.size();
    sort_conjunction_events(events);

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
        for (auto& excluded : stats_.excluded_objects) {
            excluded.input_list = 0;
            excluded.input_index = excluded.index;
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

    // Merge catalogs (dedup by NORAD ID). origin[k] names the input entry the
    // merged object k came from, so exclusions can be reported against it.
    std::vector<GPElement> catalog;
    std::vector<std::pair<int, uint32_t>> origin;
    std::unordered_set<int> seen;
    std::vector<uint32_t> primary_indices;
    std::vector<uint32_t> secondary_indices;
    for (size_t input_index = 0; input_index < primaries.size(); ++input_index) {
        const auto& gp = primaries[input_index];
        if (seen.insert(gp.norad_cat_id).second) {
            primary_indices.push_back(static_cast<uint32_t>(catalog.size()));
            catalog.push_back(gp);
            origin.emplace_back(0, static_cast<uint32_t>(input_index));
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
    for (size_t input_index = 0; input_index < secondaries.size(); ++input_index) {
        const auto& gp = secondaries[input_index];
        if (seen.insert(gp.norad_cat_id).second) {
            secondary_indices.push_back(static_cast<uint32_t>(catalog.size()));
            catalog.push_back(gp);
            origin.emplace_back(1, static_cast<uint32_t>(input_index));
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
        for (auto& excluded : stats_.excluded_objects) {
            excluded.input_list = origin[excluded.index].first;
            excluded.input_index = origin[excluded.index].second;
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

    auto events = screen_precomputed_tles(tles, valid_pairs, config_, stats_, progress);
    for (auto& excluded : stats_.excluded_objects) {
        excluded.input_list = origin[excluded.index].first;
        excluded.input_index = origin[excluded.index].second;
    }
    return events;
}

// Tight all-vs-all screening (see screening_tight.h). Candidates are re-tested
// here in f64, so the GPU only ever proposes; the encounters they form are
// refined by the same refine_window_encounters as the coarse pass, so a pass
// found either way yields the same TCA and miss distance.
std::vector<ConjunctionEvent> screen_tight_candidates(
    const std::vector<TLE>& tles,
    const ScreeningConfig& config,
    const std::vector<TightCandidate>* candidates,
    std::map<uint32_t, ExcludedObject> excluded,
    ScreeningStats& stats)
{
    const auto t_start = std::chrono::high_resolution_clock::now();
    const size_t n = tles.size();
    const double step_days = config.coarse_step_sec / 86400.0;
    const double h = 0.5 * config.coarse_step_sec;
    const int32_t last_step = tight_last_coarse_step(config);
    const int workers = std::max(1, config.num_threads);
    struct Hit { uint32_t lo, hi; int32_t step; double closest_km; };
    std::vector<std::vector<Hit>> hits(workers);
    std::vector<std::map<uint32_t, ExcludedObject>> scan_excluded(workers);
    std::vector<uint64_t> propagations(workers, 0);

    const auto run = [&](auto&& body, int64_t count) {
        const int used = static_cast<int>(std::max<int64_t>(1, std::min<int64_t>(workers, count)));
#ifndef CONJUNCTION_SINGLE_THREAD
        if (used > 1) {
            std::vector<std::thread> threads;
            for (int w = 0; w < used; ++w)
                threads.emplace_back([&, w] { clear_error(); body(w, count * w / used, count * (w + 1) / used); });
            for (auto& t : threads) t.join();
            return;
        }
#endif
        body(0, 0, count);
    };

    if (candidates) {
        run([&](int w, int64_t lo, int64_t hi) {
            for (int64_t c = lo; c < hi; ++c) {
                const auto& k = (*candidates)[c];
                if (k.obj1 >= n || k.obj2 >= n || k.obj1 == k.obj2 || k.step < 0 || k.step > last_step) continue;
                if (excluded.count(k.obj1) || excluded.count(k.obj2)) continue;
                const double jd = config.start_jd + k.step * step_days;
                const StateVector a = propagate_sgp4(tles[k.obj1], jd);
                const StateVector b = propagate_sgp4(tles[k.obj2], jd);
                propagations[w] += 2;
                if (has_error()) { clear_error(); continue; }   // the grid reported the exclusion
                double closest = 0.0;
                if (tight_pair_may_close(a, tight_acceleration_bound_km_s2(a, h),
                                         b, tight_acceleration_bound_km_s2(b, h),
                                         config.threshold_km, h, &closest)) {
                    hits[w].push_back({std::min(k.obj1, k.obj2), std::max(k.obj1, k.obj2), k.step, closest});
                }
            }
        }, static_cast<int64_t>(candidates->size()));
    } else {
        // CPU scan: every pair at every coarse step, the same test.
        run([&](int w, int64_t lo, int64_t hi) {
            std::vector<StateVector> states(n);
            std::vector<double> accel(n);
            std::vector<uint8_t> ok(n);
            std::vector<uint8_t> dead(n, 0);
            for (int64_t step = lo; step < hi; ++step) {
                const double jd = config.start_jd + step * step_days;
                for (size_t i = 0; i < n; ++i) {
                    ok[i] = 0;
                    if (dead[i]) continue;
                    states[i] = propagate_sgp4(tles[i], jd);
                    ++propagations[w];
                    if (has_error()) {
                        record_exclusion(scan_excluded[w], static_cast<uint32_t>(i), jd, error_message());
                        clear_error();
                        dead[i] = 1;
                        continue;
                    }
                    accel[i] = tight_acceleration_bound_km_s2(states[i], h);
                    ok[i] = 1;
                }
                for (size_t i = 0; i < n; ++i) {
                    if (!ok[i]) continue;
                    for (size_t j = i + 1; j < n; ++j) {
                        if (!ok[j]) continue;
                        double closest = 0.0;
                        if (tight_pair_may_close(states[i], accel[i], states[j], accel[j],
                                                 config.threshold_km, h, &closest)) {
                            hits[w].push_back({static_cast<uint32_t>(i), static_cast<uint32_t>(j),
                                               static_cast<int32_t>(step), closest});
                        }
                    }
                }
            }
        }, static_cast<int64_t>(last_step) + 1);
        for (const auto& part : scan_excluded) merge_exclusions(excluded, part);
    }

    // Steps of one pair in increasing order make runs; runs join into encounters.
    std::vector<Hit> all;
    for (auto& part : hits) all.insert(all.end(), part.begin(), part.end());
    std::sort(all.begin(), all.end(), [](const Hit& a, const Hit& b) {
        if (a.lo != b.lo) return a.lo < b.lo;
        if (a.hi != b.hi) return a.hi < b.hi;
        return a.step < b.step;
    });
    CoarseRunCollector runs;
    for (const auto& x : all) runs.hit(x.lo, x.hi, x.step, x.closest_km);
    auto encounters = drop_excluded_encounters(coalesce_encounters(runs.finish()), excluded);

    stats = {};
    stats.total_objects = n;
    stats.pairs_screened = n < 2 ? 0 : static_cast<uint64_t>(n) * (n - 1) / 2;
    stats.kdtree_candidates = all.size();
    for (auto p : propagations) stats.propagations += p;
    auto events = refine_window_encounters(tles, encounters, config, stats, nullptr, nullptr);
    stats.excluded_objects = excluded_list(excluded);
    for (auto& x : stats.excluded_objects) { x.input_list = 0; x.input_index = x.index; }
    stats.elapsed_ms = std::chrono::duration<double, std::milli>(
        std::chrono::high_resolution_clock::now() - t_start).count();
    return events;
}

} // namespace conjunction
