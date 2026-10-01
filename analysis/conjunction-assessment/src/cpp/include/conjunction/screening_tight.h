#pragma once
// Tight all-vs-all screening: a candidate test that can be evaluated on a GPU
// and is exact about what it may discard.
//
// Over a coarse interval [t_k - h, t_k + h] (h = half the coarse step) an
// object's true path stays within 1/2 A tau^2 of the straight line from its
// sampled state, where A bounds its acceleration over the interval. So a pair
// can come within the threshold inside the interval only if the straight-line
// relative path does within threshold + 1/2 (A_1 + A_2) h^2. Pairs that pass
// are joined into encounters and refined exactly as screen_catalog refines
// its coarse encounters. This header is the authoritative form of the test;
// the GPU kernel (gpu/screen_kernel.wgsl) applies it in f32 with a slack and
// only proposes candidates, which refine_candidates re-tests here in f64.

#include <cstdint>
#include <map>
#include <vector>

#include "conjunction/screening.h"
#include "conjunction/sgp4_propagator.h"

namespace conjunction {

/// Bound on an SGP4 object's acceleration over +-half_step_sec of a sample,
/// km/s^2: 1.05 mu / r_min^2 with r_min = |r| - |v| h (floored at 6000 km).
/// The 5 % covers J2 (0.16 % at the surface) and drag.
double tight_acceleration_bound_km_s2(const StateVector& state, double half_step_sec);

/// Straight-line closest approach of the pair over [-h, h] (km) and whether it
/// is within threshold + 1/2 (A_1 + A_2) h^2.
bool tight_pair_may_close(const StateVector& a, double accel_a_km_s2,
                          const StateVector& b, double accel_b_km_s2,
                          double threshold_km, double half_step_sec,
                          double* closest_km = nullptr);

/// One block of coarse steps of the window, in the GPU layout: for step s of
/// the block and object n, states[(s * objects + n) * 8 + 0..7] =
/// (x, y, z, A, vx, vy, vz, 0) in km, km/s^2 and km/s (TEME, f32), and
/// bands[n * 2 + 0..1] = the object's radius range over the block +-50 km.
/// An excluded object's states and band are NaN.
struct CoarseGridBlock {
    int32_t first_step = 0;
    int32_t step_count = 0;
    uint32_t objects = 0;
    std::vector<float> states;
    std::vector<float> bands;
    /// Objects that SGP4 cannot propagate at a coarse epoch of this block,
    /// with the earliest such epoch (the screen_catalog exclusion rule).
    std::map<uint32_t, ExcludedObject> excluded;
};

/// Propagates every object at steps [first_step, first_step + step_count) of
/// the window (step k at config.start_jd + k * coarse_step_sec) on
/// config.num_threads workers. Objects in already_excluded are written NaN.
CoarseGridBlock tight_coarse_grid_block(const std::vector<TLE>& tles,
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

/// Re-tests candidates in f64 (or, when candidates is null, scans every pair
/// at every coarse step of the window), joins the passing steps of each pair
/// into encounters, drops pairs with an excluded object, and refines them as
/// screen_catalog does. excluded is completed with the scan's own exclusions
/// (CPU scan) and copied into stats.excluded_objects.
std::vector<ConjunctionEvent> screen_tight_candidates(
    const std::vector<TLE>& tles,
    const ScreeningConfig& config,
    const std::vector<TightCandidate>* candidates,
    std::map<uint32_t, ExcludedObject> excluded,
    ScreeningStats& stats);

} // namespace conjunction
