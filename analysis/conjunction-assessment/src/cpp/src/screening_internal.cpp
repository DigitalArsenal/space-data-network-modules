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

RadialSample radial_sample(double x, double y, double z,
                           double vx, double vy, double vz,
                           double half_window_sec) {
    // Taylor about t_k: | |r(t)| - |r_k| | <= |rdot_k| h + M h^2 / 2 for
    // |t - t_k| <= h, with M >= |d^2|r|/dt^2| on that span, and
    // d^2|r|/dt^2 = (|v|^2 - rdot^2) / |r| + rhat . a <= |v|^2 / |r| + |a|.
    // The lower bound on |r| is the Earth's equatorial radius R_E, not one
    // derived from the sample: every state the screen uses is at least R_E from
    // the centre (propagate_sgp4 refuses a state below it as decayed, as the
    // pair methods do), and R_E needs no bound on the motion it would serve, so
    // the bound is not circular. It costs a little reach against a bound from
    // |r_k|. |a| <= A = 1.05 mu / R_E^2, the natural-motion bound
    // (ephemeris_source.cpp: 5 % over two-body covers J2 and drag) at that
    // radius, and so |v(t)| <= |v_k| + A h.
    constexpr double MU_KM3_S2 = 398600.8;         // SGP4 (WGS 72), as natural motion
    constexpr double NATURAL_MOTION_MARGIN = 1.05;
    constexpr double EARTH_EQUATORIAL_RADIUS_KM = 6378.137;
    const double h = std::max(0.0, half_window_sec);
    const double r = std::sqrt(x * x + y * y + z * z);
    const double v = std::sqrt(vx * vx + vy * vy + vz * vz);
    const double rdot = r > 0.0 ? (x * vx + y * vy + z * vz) / r : v;
    const double a_max = NATURAL_MOTION_MARGIN * MU_KM3_S2 /
                         (EARTH_EQUATORIAL_RADIUS_KM * EARTH_EQUATORIAL_RADIUS_KM);
    const double v_max = v + a_max * h;
    const double m = v_max * v_max / EARTH_EQUATORIAL_RADIUS_KM + a_max;
    return {r, std::abs(rdot) * h + 0.5 * m * h * h};
}

double radial_gate_half_window_sec(int32_t step, int32_t last_step,
                                   double step_sec, double window_sec) {
    const double half_step = 0.5 * step_sec;
    const double before = step > 0 ? half_step : 0.0;
    const double after = step < last_step
        ? half_step
        : std::max(0.0, window_sec - static_cast<double>(step) * step_sec);
    return std::max(before, after);
}

} // namespace conjunction
