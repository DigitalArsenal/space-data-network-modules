#pragma once
// Tight all-vs-all screening: a candidate test that can be evaluated on a GPU
// and is exact about what it may discard, for trajectories from any
// propagator.
//
// Each source bounds how far its path strays, over a coarse interval
// [t_k - h, t_k + h] (h = half the coarse step), from the straight line through
// its sample: D (EphemerisSource::path_deviation_bound_km). So a pair can come
// within the threshold inside the interval only if the straight-line relative
// path does within threshold + D_1 + D_2. Pairs that pass are joined into
// encounters and refined exactly as screen_catalog refines its coarse
// encounters. This header is the authoritative form of the test; the GPU
// kernel (gpu/screen_kernel.wgsl) applies it in f32 with a slack and only
// proposes candidates, which refine_candidates re-tests here in f64.

#include <cstdint>
#include <map>
#include <utility>
#include <string>
#include <vector>

#include "conjunction/screening.h"

namespace conjunction {

/// The source's state at jd and its deviation bound over +-half_step_sec.
/// False (with the reason) when the source cannot be evaluated there; the
/// screening then excludes the object, as screen_catalog excludes an object
/// SGP4 cannot propagate.
bool tight_sample(const EphemerisSource& source, double jd, double half_step_sec,
                  StateVector& state, double& deviation_km, std::string& failure);

/// Straight-line closest approach of the pair over [-h, h] (km) and whether it
/// is within threshold + deviation_a + deviation_b.
bool tight_pair_may_close(const StateVector& a, double deviation_a_km,
                          const StateVector& b, double deviation_b_km,
                          double threshold_km, double half_step_sec,
                          double* closest_km = nullptr);

/// Reusable buffers for tight_box_pairs (one per worker).
struct TightGridScratch {
    std::vector<double> boxes;                       // [object][lo x, y, z, hi x, y, z]
    std::vector<std::pair<uint64_t, uint32_t>> cells;   // (cell key, object)
    std::vector<uint32_t> big;                       // objects spanning many cells
};

/// The pairs (i < j) of one coarse step that may close: those whose swept
/// boxes overlap. An object's box encloses its straight-line segment over
/// [-h, h] widened by threshold/2 + its deviation bound, so every pair the
/// tight test can pass is returned; pairs whose boxes are apart cannot close.
/// A uniform grid (cell size from the box edges) finds them in about linear
/// time; a pair is reported once, in the cell holding the low corner of the
/// two boxes' overlap. ok[i] = 0 skips object i.
void tight_box_pairs(const std::vector<StateVector>& states, const std::vector<double>& deviation_km,
                     const std::vector<uint8_t>& ok, double threshold_km, double half_step_sec,
                     TightGridScratch& scratch, std::vector<std::pair<uint32_t, uint32_t>>& pairs);

/// One block of coarse steps of the window, in the GPU layout: for step s of
/// the block and object n, states[(s * objects + n) * 8 + 0..7] =
/// (x, y, z, D, vx, vy, vz, 0) in km and km/s (evaluation frame, f32), and
/// bands[n * 2 + 0..1] = bounds on the object's radius over the block's
/// intervals (each |r + v tau| range widened by D). A pair whose bands are
/// more than the threshold apart cannot close.
/// An excluded object's states and band are NaN.
struct CoarseGridBlock {
    int32_t first_step = 0;
    int32_t step_count = 0;
    uint32_t objects = 0;
    std::vector<float> states;
    std::vector<float> bands;
    /// Objects that cannot be evaluated at a coarse epoch of this block, with
    /// the earliest such epoch (the screen_catalog exclusion rule).
    std::map<uint32_t, ExcludedObject> excluded;
};

/// Samples every source at steps [first_step, first_step + step_count) of
/// the window (step k at config.start_jd + k * coarse_step_sec) on
/// config.num_threads workers. Objects in already_excluded are written NaN.
CoarseGridBlock tight_coarse_grid_block(const SourceRefs& sources,
                                        const ScreeningConfig& config,
                                        int32_t first_step, int32_t step_count,
                                        const std::vector<uint8_t>& already_excluded);

/// Last coarse step of the window (steps are 0..this, inclusive).
int32_t tight_last_coarse_step(const ScreeningConfig& config);

/// A pair (obj1 < obj2) proposed at a coarse step.
struct TightCandidate {
    uint32_t obj1 = 0;
    uint32_t obj2 = 0;
    int32_t step = 0;
};

/// The candidates of steps [first_step, first_step + step_count): every pair
/// tight_box_pairs returns that passes the tight test, on config.num_threads
/// workers, with the objects that cannot be evaluated (earliest epoch each).
/// The CPU counterpart of coarse_grid plus the GPU kernel.
struct TightSearch {
    std::vector<TightCandidate> candidates;
    std::map<uint32_t, ExcludedObject> excluded;
    uint64_t samples = 0;
};
TightSearch tight_search_block(const SourceRefs& sources, const ScreeningConfig& config,
                               int32_t first_step, int32_t step_count);

/// Re-tests candidates in f64 (or, when candidates is null, searches every
/// coarse step of the window itself with tight_box_pairs: no GPU needed), joins the passing steps of each pair
/// into encounters, drops pairs with an excluded object, and refines them as
/// screen_catalog does. excluded is completed with the scan's own exclusions
/// (CPU scan) and copied into stats.excluded_objects.
std::vector<ConjunctionEvent> screen_tight_candidates(
    const SourceRefs& sources,
    const ScreeningConfig& config,
    const std::vector<TightCandidate>* candidates,
    std::map<uint32_t, ExcludedObject> excluded,
    ScreeningStats& stats);

} // namespace conjunction
