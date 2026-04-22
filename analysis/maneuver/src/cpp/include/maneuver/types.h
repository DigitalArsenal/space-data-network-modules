#ifndef MANEUVER_TYPES_H
#define MANEUVER_TYPES_H

#include <array>
#include <string>
#include <vector>

namespace maneuver {

// ---------------------------------------------------------------------------
// vectors.ts
// ---------------------------------------------------------------------------

/// 3D vector (position or velocity), units: meters or m/s
using Vector3 = std::array<double, 3>;

/// Relative position and velocity between two spacecraft
struct RelativeState {
    Vector3 position{};
    Vector3 velocity{};
};

/// Quasi-nonsingular relative orbital elements (6-element)
/// Order: da, dlambda, dex, dey, dix, diy
using ROEVector = std::array<double, 6>;

/// Augmented ROE with drag term daDotDrag (7-element)
/// Order: da, dlambda, dex, dey, dix, diy, daDotDrag
using ROEVector7 = std::array<double, 7>;

/// Augmented ROE with drag terms (9-element)
/// Order: da, dlambda, dex, dey, dix, diy, daDotDrag, dexDotDrag, deyDotDrag
using ROEVector9 = std::array<double, 9>;

// ---------------------------------------------------------------------------
// matrices.ts
// ---------------------------------------------------------------------------

/// Row types for state transition matrices
using Row6 = std::array<double, 6>;
using Row7 = std::array<double, 7>;
using Row9 = std::array<double, 9>;

/// 6x6 state transition matrix
using STM6 = std::array<Row6, 6>;

/// 7x7 state transition matrix (with drag augmentation)
using STM7 = std::array<Row7, 7>;

/// 9x9 state transition matrix (with full drag augmentation)
using STM9 = std::array<Row9, 9>;

/// Single row of drag coupling columns (3 elements)
using DragRow3 = std::array<double, 3>;

/// Drag coupling columns appended to the 6-state STM (6 rows x 3 columns)
using DragColumns6x3 = std::array<DragRow3, 6>;

// ---------------------------------------------------------------------------
// orbital-elements.ts
// ---------------------------------------------------------------------------

/// Classical (Keplerian) orbital elements
struct ClassicalOrbitalElements {
    double eccentricity          = 0.0;
    double angularMomentum       = 0.0;
    double gravitationalParameter = 0.0;
    double semiMajorAxis         = 0.0;
    double inclination           = 0.0;  // radians
    double raan                  = 0.0;  // radians
    double argumentOfPerigee     = 0.0;  // radians
    double meanAnomaly           = 0.0;  // radians
};

/// Quasi-nonsingular relative orbital elements (named fields)
struct QuasiNonsingularROE {
    double da       = 0.0;
    double dlambda  = 0.0;
    double dex      = 0.0;
    double dey      = 0.0;
    double dix      = 0.0;
    double diy      = 0.0;
};

/// Intermediate orbital factors used in ROE propagation
struct OrbitalFactors {
    double eta = 0.0;
    double P   = 0.0;
    double Q   = 0.0;
    double R   = 0.0;
    double S   = 0.0;
    double T   = 0.0;
    double E   = 0.0;
    double F   = 0.0;
    double G   = 0.0;
};

/// Apsidal rotation state for J2-perturbed propagation
struct ApsidalState {
    double omegaDot = 0.0;
    double omega_f  = 0.0;
    double ex_i     = 0.0;
    double ey_i     = 0.0;
    double ex_f     = 0.0;
    double ey_f     = 0.0;
    double cos_wt   = 0.0;
    double sin_wt   = 0.0;
};

// ---------------------------------------------------------------------------
// config.ts
// ---------------------------------------------------------------------------

/// Drag model type
enum class DragType {
    ECCENTRIC,   // simplified eccentric drag model
    ARBITRARY    // arbitrary differential drag model
};

/// Differential drag configuration
struct DragConfig {
    DragType type      = DragType::ECCENTRIC;
    double daDotDrag   = 0.0;   // m/s   differential semi-major axis drag rate
    double dexDotDrag  = 0.0;   // 1/s   differential eccentricity-x drag rate
    double deyDotDrag  = 0.0;   // 1/s   differential eccentricity-y drag rate
};

/// Options for ROE propagation
struct ROEPropagationOptions {
    bool       includeJ2             = true;
    bool       includeDrag           = false;
    DragConfig dragConfig            = {};
    double     chiefAbsoluteDaDot    = 0.0;   // m/s
    bool       hasChiefAbsoluteDaDot = false;
};

// ---------------------------------------------------------------------------
// targeting.ts
// ---------------------------------------------------------------------------

/// 6x3 control-influence matrix  (6 ROE rows, 3 delta-v columns: R/T/N)
using ControlMatrix6x3 = std::array<std::array<double, 3>, 6>;

/// 3x6 matrix (e.g. pseudo-inverse of control matrix)
using Matrix3x6 = std::array<std::array<double, 6>, 3>;

/// 3x3 matrix
using Matrix3x3 = std::array<Vector3, 3>;

/// A target waypoint in relative motion
struct Waypoint {
    Vector3 position    = {};
    Vector3 velocity    = {};
    double  tofHint     = 0.0;    // seconds
    bool    hasTofHint  = false;
    bool    hasVelocity = false;
};

/// A single impulsive maneuver
struct Maneuver {
    Vector3                  deltaV    = {};
    double                   magnitude = 0.0;   // m/s
    ClassicalOrbitalElements chief     = {};
};

/// One leg of a multi-burn trajectory
struct ManeuverLeg {
    Vector3  from           = {};
    Vector3  to             = {};
    Vector3  targetVelocity = {};
    double   tof            = 0.0;    // seconds
    Maneuver burn1          = {};
    Maneuver burn2          = {};
    double   totalDeltaV    = 0.0;    // m/s
    bool     converged      = false;
    int      iterations     = 0;
    double   positionError  = 0.0;    // meters
};

/// Complete mission plan composed of maneuver legs
struct MissionPlan {
    std::vector<ManeuverLeg> legs       = {};
    double                   totalDeltaV = 0.0;   // m/s
    double                   totalTime   = 0.0;   // seconds
    bool                     converged   = false;
};

/// Options for the Lambert / shooting targeting solver
struct TargetingOptions {
    bool       includeJ2          = true;
    bool       includeDrag        = false;
    DragConfig dragConfig         = {};
    int        maxIterations      = 50;
    double     positionTolerance  = 1.0;     // meters
    double     velocityTolerance  = 0.001;   // m/s
    Vector3    targetVelocity     = {0.0, 0.0, 0.0};
    double     tofMinOrbits       = 0.5;
    double     tofMaxOrbits       = 3.0;
};

/// A single point along a propagated trajectory
struct TrajectoryPoint {
    double  time     = 0.0;   // seconds
    Vector3 position = {};
    Vector3 velocity = {};
};

/// Validation result codes for targeting inputs
enum class TargetingValidationCode {
    VALID,
    INVALID_CHIEF_ELEMENTS,
    INVALID_RELATIVE_STATE,
    INVALID_WAYPOINT,
    INVALID_TOF,
    INVALID_TOLERANCE,
    INVALID_MAX_ITERATIONS,
    DIVERGED,
    GENERAL_ERROR
};

/// Result of validating targeting inputs
struct TargetingValidationResult {
    bool                     valid      = false;
    TargetingValidationCode  code       = TargetingValidationCode::VALID;
    std::string              message    = {};
    std::string              suggestion = {};
};

}  // namespace maneuver

#endif  // MANEUVER_TYPES_H
