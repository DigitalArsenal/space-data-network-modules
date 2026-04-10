#ifndef MANEUVER_PLUGIN_H
#define MANEUVER_PLUGIN_H

#include "types.h"
#include "constants.h"
#include "math.h"
#include "stm.h"
#include "transforms.h"
#include "propagation.h"
#include "targeting.h"
#include "classical.h"
#include "approach.h"

#include <cstdint>
#include <vector>

namespace maneuver {

// ---------------------------------------------------------------------------
// State vector <-> OEM helpers
// ---------------------------------------------------------------------------

/// Cartesian state vector (ECI / J2000)
struct StateVector {
    double epoch_jd = 0.0;   // Julian Date
    double x  = 0.0;         // km
    double y  = 0.0;         // km
    double z  = 0.0;         // km
    double vx = 0.0;         // km/s
    double vy = 0.0;         // km/s
    double vz = 0.0;         // km/s
};

/// Maneuver burn event for MNV output
struct BurnEvent {
    double epoch_jd   = 0.0;  // burn time (Julian Date)
    double dv_u       = 0.0;  // delta-v radial [km/s]
    double dv_v       = 0.0;  // delta-v in-track [km/s]
    double dv_w       = 0.0;  // delta-v cross-track [km/s]
    double dv_mag     = 0.0;  // delta-v magnitude [km/s]
};

/// Plugin configuration for maneuver planning
struct ManeuverPluginConfig {
    // Mode selection
    enum class Mode {
        HOHMANN,
        BI_ELLIPTIC,
        GENERAL_TRANSFER,
        PATCHED_CONIC,
        ROE_RENDEZVOUS,
        ROE_MISSION_PLAN
    };

    Mode mode = Mode::HOHMANN;

    // Classical maneuver parameters
    double targetRadius  = 0.0;   // [m] for Hohmann/bi-elliptic
    double intermediateR = 0.0;   // [m] for bi-elliptic

    // RPO/ROE parameters
    std::vector<Waypoint> waypoints;
    TargetingOptions targetingOptions;

    // Patched conic parameters
    Planet departurePlanet = EARTH;
    Planet arrivalPlanet   = MARS;
    double parkingAltDepart = 200e3;  // [m]
    double parkingAltArrive = 200e3;  // [m]
};

/// Result of the plugin execution
struct ManeuverPluginResult {
    std::vector<StateVector> ephemeris;    // post-maneuver trajectory
    std::vector<BurnEvent>   burns;        // maneuver burn events
    double totalDeltaV = 0.0;              // [km/s]
    bool   success     = false;
    std::string errorMessage;
};

/// Top-level plugin entry point.
/// @param initialState  initial OEM state (position km, velocity km/s)
/// @param config        maneuver planning configuration
ManeuverPluginResult executeManeuverPlugin(
    const StateVector& initialState,
    const ManeuverPluginConfig& config);

}  // namespace maneuver

#endif  // MANEUVER_PLUGIN_H
