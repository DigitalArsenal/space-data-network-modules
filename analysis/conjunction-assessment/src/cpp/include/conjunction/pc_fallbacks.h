#ifndef CONJUNCTION_PC_FALLBACKS_H
#define CONJUNCTION_PC_FALLBACKS_H

#include "conjunction/pc_method.h"
#include "conjunction/pc_usage.h"
#include <cstdint>

namespace conjunction {

inline constexpr std::uint64_t kDefaultScreeningPcSampleCap = 49152;
inline constexpr std::uint64_t kDefaultScreeningPcPropagationBudget = 3000000;

struct PcFallbackOptions {
    PcGrade grade = PcGrade::Reference;
    // Finite observation interval, seconds from the supplied common epoch.
    // Both zero selects the CARA duration estimate; if no duration exists,
    // uses +/- half the shorter orbital period (or +/-3600s when unbound).
    double time_start = 0, time_end = 0;
    double relative_tolerance = 1e-4;
    unsigned angular_order = 32;
    unsigned time_intervals = 128;
    std::uint64_t samples = 65536;
    // Screening only: deterministic sample-prefix stopping after both the
    // minimum sample count and hit target; samples remains the hard cap.
    std::uint64_t minimum_samples = 32768;
    std::uint64_t target_hits = 30;
    std::uint64_t seed = 0x53444e5043ULL;
    bool two_body = true;
    // Total finite-window collision probability includes overlap at t_start.
    // False exposes the first-entry convention used by CARA's published MC.
    bool include_initial_overlap = true;
    // Screening only: checkpoint after each complete sampled trajectory.
    // Counts individual object propagations, not elapsed time. Reaching the
    // budget overrides minimum_samples and an explicit samples cap; the last
    // complete sample may exceed the checkpoint. Zero selects the default.
    // Reference ignores this setting and preserves its sampling policy.
    std::uint64_t screening_propagation_budget = kDefaultScreeningPcPropagationBudget;
};

struct PcFallbackResult {
    PcResult pc;
    PcUsageResult usage;
    std::uint64_t samples = 0, hits = 0;
    std::uint64_t initial_hits = 0, entry_hits = 0;
    double time_start = 0, time_end = 0;
    double expected_collisions = 0;
    bool covariance_repaired = false;
    bool invalid_inputs = false;
    // Numerical Nc convergence is distinct from applicability as a total
    // collision probability (initial occupancy / possible repeated entries).
    bool requires_monte_carlo = false;
    std::string limitation;
    // Screening work diagnostics. A complete trajectory can add at most
    // 2*(1+4096*(1+48)) propagations beyond a checkpoint (initial state, the
    // bounded pericenter grid and bounded minimum-search bisections).
    // Reference leaves these zero; its calculation is not instrumented.
    std::uint64_t propagation_evaluations = 0, propagation_budget = 0;
    bool work_limited = false;
};

// Hall/Coppola collision-sphere inward flux, with Cartesian Gaussian
// covariance propagation. Honest names distinguish the model from CARA's
// equinoctial peak-overlap Hall implementation.
// An optional usage result reuses a full assessment of this same encounter;
// callers must not substitute the engine's short-circuit routing diagnostics.
PcFallbackResult pc_3d_nc_cartesian(const PcEncounter&, const PcFallbackOptions& = {}, const PcUsageResult* = nullptr);
PcFallbackResult pc_2d_nc_cartesian(const PcEncounter&, const PcFallbackOptions& = {}, const PcUsageResult* = nullptr);
// Equinoctial Gaussian propagation and iterative peak-overlap linearization
// following Hall/CARA, validated against all 12 published Alfano 3D cases.
// Check requires_monte_carlo before interpreting Nc as total finite-window Pc.
PcFallbackResult pc_3d_nc_hall(const PcEncounter&, const PcFallbackOptions& = {}, const PcUsageResult* = nullptr);
PcFallbackResult pc_2d_nc_hall(const PcEncounter&, const PcFallbackOptions& = {}, const PcUsageResult* = nullptr);

// SDMC-style sampling of full correlated position/velocity states, including
// optional between-object covariance. Explicit SplitMix64 + Box-Muller gives
// a reproducible stream independent of C++ standard-library RNG distribution.
PcFallbackResult pc_monte_carlo(const PcEncounter&, const PcFallbackOptions& = {}, const PcUsageResult* = nullptr);

} // namespace conjunction
#endif
