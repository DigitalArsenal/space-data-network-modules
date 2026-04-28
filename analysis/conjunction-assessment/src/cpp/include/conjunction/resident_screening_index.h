#ifndef CONJUNCTION_RESIDENT_SCREENING_INDEX_H
#define CONJUNCTION_RESIDENT_SCREENING_INDEX_H

#include "conjunction/gp_json.h"
#include "conjunction/generated/ConjunctionCommon_generated.h"
#include "conjunction/screening.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <utility>
#include <vector>

namespace orbpro {
namespace propagator {
struct PropagatorDescribeSourcesBatchResult;
struct PropagatorDescribeTrajectorySegmentsResult;
struct PropagatorSampleTrajectoryStatesResult;
} // namespace propagator
}

namespace conjunction {

static constexpr size_t RESIDENT_CHEBYSHEV_COEFFICIENT_COUNT = 13;

struct ResidentTrajectorySegment {
    uint32_t source_handle = 0;
    double start_jd = 0.0;
    double end_jd = 0.0;
    uint32_t degree = 0;
    uint8_t reference_frame = 0;
    std::array<double, RESIDENT_CHEBYSHEV_COEFFICIENT_COUNT> x_coefficients = {};
    std::array<double, RESIDENT_CHEBYSHEV_COEFFICIENT_COUNT> y_coefficients = {};
    std::array<double, RESIDENT_CHEBYSHEV_COEFFICIENT_COUNT> z_coefficients = {};
    std::array<double, RESIDENT_CHEBYSHEV_COEFFICIENT_COUNT> vx_coefficients = {};
    std::array<double, RESIDENT_CHEBYSHEV_COEFFICIENT_COUNT> vy_coefficients = {};
    std::array<double, RESIDENT_CHEBYSHEV_COEFFICIENT_COUNT> vz_coefficients = {};
    double max_position_error_km = 0.0;
    double max_velocity_error_km_s = 0.0;
};

/// Compact resident screening index.
///
/// Previous representation stored an explicit vector of every candidate
/// pair<uint32_t,uint32_t>.  For N=14,683 active LEO objects that vector
/// alone requires ~800 MB, blowing the 512 MB WASM heap.
///
/// New representation: store per-object perigee/apogee as float arrays
/// (~117 KB for 14,683 objects).  At screening time the KD-tree already
/// provides spatial proximity; we add a 4-float altitude-overlap gate
/// per KD-tree match instead of consulting a precomputed pair list.
struct ResidentScreeningIndex {
    uint32_t screening_index_handle = 0;
    uint32_t catalog_handle = 0;
    uint32_t segment_set_handle = 0;
    uint64_t total_pair_count = 0;
    uint64_t candidate_pair_count = 0;
    uint64_t pairs_prefiltered = 0;
    orbpro::conjunction::ConjunctionScreeningMode screening_mode =
        orbpro::conjunction::ConjunctionScreeningMode::exact_only;

    std::vector<uint32_t> source_handles;
    std::vector<TLE> tles;
    std::vector<std::vector<ResidentTrajectorySegment>> trajectory_segments;

    // Compact altitude index — two floats per object.
    std::vector<float> perigee_km;
    std::vector<float> apogee_km;
    std::vector<float> max_speed_km_s;

    // Conservative sampled-position envelopes for threshold-aware pruning at
    // screen time.
    std::vector<float> sample_min_x_km;
    std::vector<float> sample_max_x_km;
    std::vector<float> sample_min_y_km;
    std::vector<float> sample_max_y_km;
    std::vector<float> sample_min_z_km;
    std::vector<float> sample_max_z_km;
    std::vector<float> sample_motion_margin_km;

    // Primary scoping.  Empty means all objects are primary (active-on-all).
    std::vector<uint8_t> is_primary;

    // Objects that participate in at least one altitude-overlapping pair.
    // Avoids propagating objects that can never produce a candidate.
    // Empty means all objects participate.
    std::vector<uint8_t> participates;
};

struct ResidentScreeningIndexBuildResult {
    uint32_t screening_index_handle = 0;
    uint32_t source_count = 0;
    uint64_t candidate_pair_count = 0;
};

ResidentScreeningIndexBuildResult prepare_resident_screening_index(
    uint32_t catalog_handle,
    const std::vector<uint32_t>& primary_source_handles,
    const orbpro::propagator::PropagatorDescribeSourcesBatchResult* descriptions);

ResidentScreeningIndexBuildResult prepare_resident_segment_screening_index(
    uint32_t catalog_handle,
    uint32_t segment_set_handle,
    const std::vector<uint32_t>& primary_source_handles,
    orbpro::conjunction::ConjunctionScreeningMode screening_mode,
    const orbpro::propagator::PropagatorDescribeSourcesBatchResult* descriptions,
    const orbpro::propagator::PropagatorDescribeTrajectorySegmentsResult* segments);

ResidentScreeningIndexBuildResult prepare_resident_sample_screening_index(
    uint32_t catalog_handle,
    const std::vector<uint32_t>& primary_source_handles,
    orbpro::conjunction::ConjunctionScreeningMode screening_mode,
    const orbpro::propagator::PropagatorDescribeSourcesBatchResult* descriptions,
    const orbpro::propagator::PropagatorSampleTrajectoryStatesResult* samples);

const ResidentScreeningIndex* find_resident_screening_index(
    uint32_t screening_index_handle);

bool destroy_resident_screening_index(uint32_t screening_index_handle);

std::vector<ConjunctionEvent> screen_resident_index_window(
    const ResidentScreeningIndex& index,
    const ScreeningConfig& config,
    ScreeningStats& stats,
    ProgressCallback progress = nullptr);

} // namespace conjunction

#endif // CONJUNCTION_RESIDENT_SCREENING_INDEX_H
