#include "conjunction/screening_internal.h"

#include <cmath>

namespace conjunction {

namespace {

double clamp_to_range(double value, double min_value, double max_value) {
    return std::max(min_value, std::min(value, max_value));
}

bool has_valid_hit_steps(const CoarseHitRecord& hit) {
    return hit.earliest_step != std::numeric_limits<int32_t>::max() ||
           hit.latest_step >= 0 ||
           hit.best_step >= 0;
}

bool has_pair_identity(const CoarseHitRecord& hit) {
    return has_valid_hit_steps(hit) || std::isfinite(hit.best_distance_km);
}

} // namespace

uint64_t coarse_hit_key(uint32_t obj1_index, uint32_t obj2_index) {
    const uint32_t lo = std::min(obj1_index, obj2_index);
    const uint32_t hi = std::max(obj1_index, obj2_index);
    return (static_cast<uint64_t>(lo) << 32) | hi;
}

bool is_conjunction_within_threshold(double miss_distance_km, double threshold_km) {
    return std::isfinite(miss_distance_km) &&
           std::isfinite(threshold_km) &&
           miss_distance_km >= 0.0 &&
           threshold_km >= 0.0 &&
           miss_distance_km <= threshold_km;
}

void merge_coarse_hit(CoarseHitRecord& aggregate, int32_t step, double distance_km) {
    aggregate.earliest_step = std::min(aggregate.earliest_step, step);
    aggregate.latest_step = std::max(aggregate.latest_step, step);
    if (distance_km < aggregate.best_distance_km) {
        aggregate.best_distance_km = distance_km;
        aggregate.best_step = step;
    }
}

void merge_coarse_hit_record(CoarseHitRecord& aggregate, const CoarseHitRecord& update) {
    if (!has_valid_hit_steps(update)) {
        return;
    }

    if (has_pair_identity(aggregate) && has_pair_identity(update) &&
        coarse_hit_key(aggregate.obj1_index, aggregate.obj2_index) !=
            coarse_hit_key(update.obj1_index, update.obj2_index)) {
        return;
    }

    if (!has_pair_identity(aggregate)) {
        aggregate.obj1_index = update.obj1_index;
        aggregate.obj2_index = update.obj2_index;
    }

    if (update.earliest_step != std::numeric_limits<int32_t>::max()) {
        aggregate.earliest_step = std::min(aggregate.earliest_step, update.earliest_step);
    }
    if (update.latest_step >= 0) {
        aggregate.latest_step = std::max(aggregate.latest_step, update.latest_step);
    }
    if (update.best_step >= 0 && update.best_distance_km < aggregate.best_distance_km) {
        aggregate.best_distance_km = update.best_distance_km;
        aggregate.best_step = update.best_step;
    }
}

RefinementWindow build_refinement_window(
    const CoarseHitRecord& hit,
    double slice_start_jd,
    double slice_end_jd,
    double coarse_step_sec) {
    RefinementWindow window;
    if (slice_end_jd < slice_start_jd) {
        window.start_jd = slice_start_jd;
        window.end_jd = slice_start_jd;
        window.hint_jd = slice_start_jd;
        return window;
    }

    if (!has_valid_hit_steps(hit)) {
        window.start_jd = slice_start_jd;
        window.end_jd = slice_start_jd;
        window.hint_jd = slice_start_jd;
        return window;
    }

    if (!(coarse_step_sec > 0.0)) {
        window.start_jd = slice_start_jd;
        window.end_jd = slice_end_jd;
        window.hint_jd = slice_start_jd;
        return window;
    }

    const double step_days = coarse_step_sec / 86400.0;
    const int32_t earliest_step =
        hit.earliest_step != std::numeric_limits<int32_t>::max()
            ? hit.earliest_step
            : std::max(0, hit.best_step);
    const int32_t latest_step =
        hit.latest_step >= 0 ? hit.latest_step : std::max(earliest_step, hit.best_step);
    const int32_t hint_step =
        hit.best_step >= 0 ? hit.best_step : earliest_step;

    const double raw_start_jd =
        slice_start_jd + static_cast<double>(earliest_step - 1) * step_days;
    const double raw_end_jd =
        slice_start_jd + static_cast<double>(latest_step + 1) * step_days;
    const double raw_hint_jd =
        slice_start_jd + static_cast<double>(hint_step) * step_days;

    window.start_jd = clamp_to_range(raw_start_jd, slice_start_jd, slice_end_jd);
    window.end_jd = clamp_to_range(raw_end_jd, window.start_jd, slice_end_jd);
    window.hint_jd = clamp_to_range(raw_hint_jd, window.start_jd, window.end_jd);
    return window;
}

double conservative_coarse_radius_km(
    double threshold_km,
    double obj1_speed_km_s,
    double obj2_speed_km_s,
    double coarse_step_sec) {
    const double safe_threshold_km = std::max(0.0, threshold_km);
    const double safe_obj1_speed_km_s = std::max(0.0, obj1_speed_km_s);
    const double safe_obj2_speed_km_s = std::max(0.0, obj2_speed_km_s);
    const double safe_half_step_sec = std::max(0.0, coarse_step_sec) * 0.5;
    return safe_threshold_km +
           (safe_obj1_speed_km_s + safe_obj2_speed_km_s) * safe_half_step_sec;
}

double conservative_primary_query_radius_km(
    double threshold_km,
    double primary_speed_km_s,
    double max_other_speed_km_s,
    double coarse_step_sec) {
    return conservative_coarse_radius_km(
        threshold_km,
        primary_speed_km_s,
        max_other_speed_km_s,
        coarse_step_sec);
}

} // namespace conjunction
