#pragma once
// The end of a propagated trajectory.
//
// A trajectory ends where it descends below the Karman line,
// REENTRY_ALTITUDE_KM above the WGS84 ellipsoid: below it the object is
// reentering, and a cannonball with a fixed drag coefficient no longer
// describes its flight (integrated further, the trajectory reaches the
// Earth's interior, where the gravity field diverges). A non-finite state
// ends it the same way.
//
// Every propagation path (the state, the transition matrix, finite burns)
// tests each state its integrator evaluates (stopAt, from the derivative).
// The first such state is recorded as the propagation's stop; the derivative
// is zero from then on, the RKF78 run accepts no further step, and the
// integration reports failure. The PRW methods report the stop as the named
// error `reentry` (or `invalid-state`) with its UTC epoch and, on the resident
// path, the object. This is a flag, not a C++ exception: unwinding through the
// module is not identical in every runtime.
//
// The height is taken about the GCRF pole, not the Earth-fixed one. The two
// differ by the CIP's offset from the GCRF pole, under 0.4 degrees this
// century, which moves the height by at most about 0.2 km; the test needs no
// Earth orientation and is the same on every path.
#include "astrodynamics.h"
#include <cmath>
#include <cstdio>
#include <string>

namespace astro {

constexpr double REENTRY_ALTITUDE_KM = 100.0;

struct PropagationStop {
    bool active = false;
    const char* code = "";   // "reentry" or "invalid-state"
    double jd = 0;           // the integration clock at the state (TDB Julian date)
    double heightKm = 0;     // the state's height above the ellipsoid (reentry)
    const char* detail = nullptr;
};

/// The current integration's stop. Each integration clears it when it starts
/// (clearPropagationStop) and fails when it is set at the end.
inline PropagationStop& propagationStop() {
    static PropagationStop stop;
    return stop;
}
inline void clearPropagationStop() { propagationStop() = PropagationStop(); }
/// The first stop since the module call began (clearCallStop), whatever
/// integrations followed it: what the PRW methods report.
inline PropagationStop& callStop() {
    static PropagationStop stop;
    return stop;
}
inline void clearCallStop() { callStop() = PropagationStop(); clearPropagationStop(); }

// EH-free typed consumers fail through the same per-call stop channel as
// reentry. Never turn an unsupported force into a successful zero force.
inline void flagForceFailure() {
    propagationStop() = PropagationStop{true, "invalid-force", 0, NAN};
    if (!callStop().active) callStop() = propagationStop();
}

// Numerical/configuration failures share the explicit stop channel. Static
// messages survive until the caller copies the diagnostic into its response.
inline void flagIntegrationFailure(const char* detail) {
    if (!propagationStop().active)
        propagationStop() = PropagationStop{true, "propagation-failed", 0, NAN, detail};
    if (!callStop().active) callStop() = propagationStop();
}

/// Records the stop at a state y (GCRF position km, velocity km/s) at the
/// integration clock jd (TDB Julian date) below the Karman line or not finite.
/// True once the integration has stopped: the derivative is then zero.
inline bool stopAt(const double* y, const timesys::Instant& instant) {
    const double jd = instant.jdTdb(); // stop label only
    PropagationStop& stop = propagationStop();
    if (stop.active) return true;
    const double r2 = y[0] * y[0] + y[1] * y[1] + y[2] * y[2];
    if (!std::isfinite(r2) || !std::isfinite(y[3]) || !std::isfinite(y[4]) || !std::isfinite(y[5])) {
        stop = PropagationStop{true, "invalid-state", jd, NAN};
        if (!callStop().active) callStop() = stop;
        return true;
    }
    constexpr double clear = RE_EARTH + REENTRY_ALTITUDE_KM;   // above the line at every latitude
    if (r2 >= clear * clear) return false;
    double latitude, longitude, height;
    ecefToGeodetic(Vec3(y[0], y[1], y[2]), latitude, longitude, height);
    if (height >= REENTRY_ALTITUDE_KM) return false;
    stop = PropagationStop{true, "reentry", jd, height};
    if (!callStop().active) callStop() = stop;
    return true;
}

/// A stop as text (the integrators' error message): its code and, for a
/// reentry, the height and the integration clock.
inline std::string propagationStopMessage(const PropagationStop& stop = propagationStop()) {
    if (stop.detail) return std::string(stop.code) + ": " + stop.detail;
    char text[200];
    if (std::string(stop.code) == "reentry")
        std::snprintf(text, sizeof text, "reentry: the trajectory descends below %.0f km geodetic altitude (%.1f km) at TDB JD %.6f; "
                      "FFM ends it there.", REENTRY_ALTITUDE_KM, stop.heightKm, stop.jd);
    else if (std::string(stop.code) == "invalid-force")
        std::snprintf(text, sizeof text, "invalid-force: unsupported or singular force evaluation.");
    else
        std::snprintf(text, sizeof text, "invalid-state: the integration produced a non-finite state at TDB JD %.6f.", stop.jd);
    return text;
}

} // namespace astro
