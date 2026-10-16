#ifndef CONJUNCTION_PC_USAGE_H
#define CONJUNCTION_PC_USAGE_H

#include <array>
#include <string>

namespace conjunction {

// All states/covariances share an inertial frame and epoch. Position is km,
// velocity km/s; covariance is row-major (position first, velocity second).
struct PcEncounter {
    double epoch_jd = 0; // common Julian date UTC; propagation uses elapsed SI s
    std::array<double, 6> primary{}, secondary{};
    std::array<double, 36> covariance_primary{}, covariance_secondary{};
    double combined_radius = 0.01;
    double gravitational_parameter = 398600.4418; // km^3/s^2; zero = rectilinear
    bool has_velocity_covariance = false;
    // Cov(primary, secondary), generally asymmetric; off unless requested.
    bool apply_cross_correlation = false;
    std::array<double, 36> cross_covariance{};
};

struct PcUsageResult {
    bool violated = false;
    bool fully_evaluated = false; // False when engine routing skips curvature.
    bool low_relative_speed = false;
    bool covariance_repaired = false;
    bool cross_correlation_applied = false;
    double covariance_trace_change = 0; // km^2, corrected minus independent
    double time_center = 0;            // seconds relative to supplied epoch
    double time_sigma = 0;
    double time_start = 0, time_end = 0;
    double extended = 0;               // CARA duration/min(orbital periods)
    double offset = 0;                 // CARA max(abs(time bounds))/period
    double inaccurate = 0;             // CARA 1-exp(-abs(log Nc/Pc correction))
    double relative_velocity_uncertainty = 0; // sigma speed / relative speed
    std::string reason;
};

enum class PcUsageEvaluation {
    Full,
    // The velocity-uncertainty safeguard alone establishes a violation. Keep
    // rectilinear times/flags and report skipped curvature; expensive fallback
    // integrators still request Full to obtain their own integration bounds.
    StopOnRectilinearViolation
};

// CARA duration/offset and three-point Q(t) curvature diagnostics with
// equinoctial peak-overlap propagation, plus a separate velocity-uncertainty
// safeguard. Non-convergent curvature analyses are explicitly flagged.
PcUsageResult assess_pc_usage(const PcEncounter& encounter,
    PcUsageEvaluation evaluation = PcUsageEvaluation::Full);

// Relative-state covariance includes -C12-C12^T only when explicitly enabled.
std::array<double, 36> relative_pc_covariance(const PcEncounter& encounter);

} // namespace conjunction
#endif
