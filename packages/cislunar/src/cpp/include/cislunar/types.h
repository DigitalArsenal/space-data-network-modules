#ifndef CISLUNAR_TYPES_H
#define CISLUNAR_TYPES_H

#include <array>
#include <vector>
#include <string>

namespace cislunar {

// ---------------------------------------------------------------------------
// Fundamental types
// ---------------------------------------------------------------------------

using Vector3 = std::array<double, 3>;
using Vector6 = std::array<double, 6>;  // [x, y, z, vx, vy, vz]
using Matrix6x6 = std::array<std::array<double, 6>, 6>;

// ---------------------------------------------------------------------------
// CR3BP (Circular Restricted Three-Body Problem)
// ---------------------------------------------------------------------------

/// CR3BP system parameters
struct CR3BPSystem {
    double mu         = 0.0;   // mass ratio: m2 / (m1 + m2)
    double l_star     = 0.0;   // characteristic length [m] (distance between primaries)
    double t_star     = 0.0;   // characteristic time [s]
    double m1         = 0.0;   // mass of primary body [kg]
    double m2         = 0.0;   // mass of secondary body [kg]
    std::string name  = {};
};

/// State in the CR3BP rotating frame (non-dimensional)
struct CR3BPState {
    double x  = 0.0;
    double y  = 0.0;
    double z  = 0.0;
    double vx = 0.0;
    double vy = 0.0;
    double vz = 0.0;
};

/// Lagrange point identifier
enum class LagrangePoint { L1, L2, L3, L4, L5 };

/// Lagrange point result
struct LagrangePointResult {
    LagrangePoint point;
    Vector3       position = {};   // non-dimensional rotating frame
    double        jacobi   = 0.0;  // Jacobi constant at this point
};

/// Stability eigenvalues at a Lagrange point
struct StabilityResult {
    std::array<double, 6> eigenvalues_real = {};
    std::array<double, 6> eigenvalues_imag = {};
    bool                  stable           = false;
};

// ---------------------------------------------------------------------------
// Periodic Orbits
// ---------------------------------------------------------------------------

/// Orbit family type
enum class OrbitFamily {
    HALO_NORTH,       // Northern halo orbit
    HALO_SOUTH,       // Southern halo orbit
    LYAPUNOV,         // Planar Lyapunov orbit
    VERTICAL_LYAPUNOV,// Vertical Lyapunov orbit
    NRHO,             // Near-Rectilinear Halo Orbit
    DRO,              // Distant Retrograde Orbit
    BUTTERFLY          // Butterfly orbit
};

/// Configuration for periodic orbit computation
struct PeriodicOrbitConfig {
    OrbitFamily family    = OrbitFamily::HALO_NORTH;
    LagrangePoint point   = LagrangePoint::L2;
    double amplitude      = 0.0;   // non-dimensional amplitude (Az for halo)
    int    maxIterations  = 100;
    double tolerance      = 1e-12;
};

/// Result of periodic orbit differential correction
struct PeriodicOrbitResult {
    CR3BPState            initialState = {};
    double                period       = 0.0;   // non-dimensional
    double                jacobi       = 0.0;   // Jacobi constant
    Matrix6x6             monodromy    = {};     // monodromy matrix
    std::vector<Vector6>  trajectory   = {};     // state history
    bool                  converged    = false;
    int                   iterations   = 0;
    OrbitFamily           family       = OrbitFamily::HALO_NORTH;
};

/// NRHO-specific parameters (Gateway orbit)
struct NRHOConfig {
    LagrangePoint point = LagrangePoint::L2;
    double perilune_km  = 3500.0;   // perilune altitude [km]
    double apolune_km   = 70000.0;  // apolune altitude [km]
    int    maxIterations = 100;
    double tolerance     = 1e-12;
};

// ---------------------------------------------------------------------------
// Transfer trajectories
// ---------------------------------------------------------------------------

/// Transfer type
enum class TransferType {
    HOHMANN_LIKE,      // Direct two-body patched conic
    LOW_ENERGY,        // WSB / ballistic capture
    FREE_RETURN,       // Lunar free-return trajectory
    POWERED_FLYBY,     // Powered gravity assist at Moon
    WEAK_STABILITY,    // Weak stability boundary transfer
    DIRECT_INSERTION   // Direct lunar orbit insertion
};

/// Transfer configuration
struct TransferConfig {
    TransferType type   = TransferType::LOW_ENERGY;
    double parkingAlt   = 200e3;     // Earth parking orbit altitude [m]
    double targetAlt    = 100e3;     // Lunar orbit altitude [m]
    double inclination  = 0.0;       // transfer plane inclination [rad]
    int    maxIterations = 200;
    double tolerance     = 1e-10;
};

/// Transfer result
struct TransferResult {
    std::vector<Vector6> trajectory = {};   // ECI state history
    std::vector<double>  times      = {};   // epoch offsets [s]
    Vector3              dvDepart   = {};   // departure delta-v [m/s]
    Vector3              dvArrive   = {};   // arrival delta-v [m/s]
    double               dvTotal   = 0.0;  // total delta-v [m/s]
    double               tof       = 0.0;  // time of flight [s]
    bool                 converged = false;
    TransferType         type      = TransferType::LOW_ENERGY;
};

// ---------------------------------------------------------------------------
// Station-keeping
// ---------------------------------------------------------------------------

/// Station-keeping strategy
enum class SKStrategy {
    X_AXIS_CROSSING,   // Correct at each x-axis crossing
    TARGET_POINT,      // Target a reference point on the periodic orbit
    FLOQUET_MODE       // Suppress unstable Floquet mode
};

/// Station-keeping configuration
struct StationKeepingConfig {
    SKStrategy strategy    = SKStrategy::X_AXIS_CROSSING;
    double     navError    = 1.0;    // navigation error [km]
    double     maneuverError = 0.01; // maneuver execution error [fraction]
    int        numCycles   = 12;     // number of SK cycles to simulate
};

/// Station-keeping result
struct StationKeepingResult {
    double annualDV      = 0.0;    // annual delta-v budget [m/s]
    double meanCycleDV   = 0.0;    // mean delta-v per cycle [m/s]
    double maxCycleDV    = 0.0;    // worst-case delta-v per cycle [m/s]
    std::vector<double> cycleDVs = {};  // delta-v per cycle [m/s]
    bool   stable        = false;  // remains bounded over simulation
};

// ---------------------------------------------------------------------------
// Propagation
// ---------------------------------------------------------------------------

/// CR3BP propagation options
struct CR3BPPropOptions {
    double   duration   = 0.0;    // non-dimensional time
    double   stepSize   = 0.001;  // integration step (non-dimensional)
    int      outputPoints = 1000;
    bool     computeSTM = false;  // also propagate 6x6 STM
};

/// CR3BP propagation result
struct CR3BPPropResult {
    std::vector<Vector6>  states = {};    // state history
    std::vector<double>   times  = {};    // time history
    std::vector<Matrix6x6> stms = {};     // STM history (if requested)
    double                jacobi = 0.0;   // Jacobi constant (should be conserved)
};

}  // namespace cislunar

#endif  // CISLUNAR_TYPES_H
