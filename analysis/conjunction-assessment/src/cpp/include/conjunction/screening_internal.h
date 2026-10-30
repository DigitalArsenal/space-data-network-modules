#ifndef CONJUNCTION_SCREENING_INTERNAL_H
#define CONJUNCTION_SCREENING_INTERNAL_H

#include <algorithm>
#include <cstdint>
#include <limits>
#include <cmath>

namespace conjunction {

struct CoarseHitRecord {
    uint32_t obj1_index = 0;
    uint32_t obj2_index = 0;
    int32_t earliest_step = std::numeric_limits<int32_t>::max();
    int32_t latest_step = -1;
    int32_t best_step = -1;
    double best_distance_km = std::numeric_limits<double>::max();
};

struct RefinementWindow {
    double start_jd = 0.0;
    double end_jd = 0.0;
    double hint_jd = 0.0;

    double duration_days() const { return std::max(0.0, end_jd - start_jd); }
};

uint64_t coarse_hit_key(uint32_t obj1_index, uint32_t obj2_index);
bool is_conjunction_within_threshold(double miss_distance_km, double threshold_km);
void merge_coarse_hit(CoarseHitRecord& aggregate, int32_t step, double distance_km);
void merge_coarse_hit_record(CoarseHitRecord& aggregate, const CoarseHitRecord& update);
RefinementWindow build_refinement_window(
    const CoarseHitRecord& hit,
    double slice_start_jd,
    double slice_end_jd,
    double coarse_step_sec);

double conservative_coarse_radius_km(
    double threshold_km,
    double obj1_speed_km_s,
    double obj2_speed_km_s,
    double coarse_step_sec);

double conservative_primary_query_radius_km(
    double threshold_km,
    double primary_speed_km_s,
    double max_other_speed_km_s,
    double coarse_step_sec);

/// An object's distance from the Earth's centre at a coarse sample, and how far
/// that distance can move within the half window either side of the sample: what
/// the radial gate compares (radially_reachable).
struct RadialSample {
    double radius_km = 0.0;
    double reach_km = 0.0;
};

/// The radial gate's sample from a propagated state (km, km/s) at t_k, for
/// |t - t_k| <= half_window_sec.
RadialSample radial_sample(double x, double y, double z,
                           double vx, double vy, double vz,
                           double half_window_sec);

/// Whether two objects sampled at the same instant can come within threshold_km
/// of each other within the half windows around it. Two positions within
/// threshold_km have distances from the centre within threshold_km of each other
/// (reverse triangle inequality), and each distance stays within its reach of
/// its sample, so a pair this refuses cannot come that close there.
inline bool radially_reachable(const RadialSample& a, const RadialSample& b, double threshold_km) {
    return std::abs(a.radius_km - b.radius_km) <= threshold_km + a.reach_km + b.reach_km;
}

/// The radial gate's half window at coarse step `step` of a window of
/// window_sec seconds scanned at steps 0..last_step, step_sec apart: every time
/// of the window lies within it of the step nearest that time. Half a step on
/// either side, nothing before the first step, and after the last step the
/// rest of the window.
double radial_gate_half_window_sec(int32_t step, int32_t last_step,
                                   double step_sec, double window_sec);

} // namespace conjunction

#endif // CONJUNCTION_SCREENING_INTERNAL_H
