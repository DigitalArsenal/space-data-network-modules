#ifndef CONJUNCTION_SCREENING_INTERNAL_H
#define CONJUNCTION_SCREENING_INTERNAL_H

#include <algorithm>
#include <cstdint>
#include <limits>

namespace conjunction {

struct CoarseHitRecord {
    uint32_t obj1_index = 0;
    uint32_t obj2_index = 0;
    int32_t earliest_step = std::numeric_limits<int32_t>::max();
    int32_t latest_step = -1;
    int32_t best_step = -1;
    double best_distance_km = std::numeric_limits<double>::infinity();
};

struct RefinementWindow {
    double start_jd = 0.0;
    double end_jd = 0.0;
    double hint_jd = 0.0;

    double duration_days() const { return std::max(0.0, end_jd - start_jd); }
};

uint64_t coarse_hit_key(uint32_t obj1_index, uint32_t obj2_index);
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

} // namespace conjunction

#endif // CONJUNCTION_SCREENING_INTERNAL_H
