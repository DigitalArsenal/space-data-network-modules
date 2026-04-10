#include "maneuver/maneuver_plugin.h"

#include <cmath>
#include <stdexcept>
#include <string>

namespace maneuver {

namespace {

/// Convert a StateVector (km, km/s) to ClassicalOrbitalElements (m, m/s).
/// Uses vis-viva and standard Cartesian→Keplerian conversion.
ClassicalOrbitalElements stateToElements(const StateVector& sv, double mu) {
    // Convert km -> m
    double x = sv.x * 1e3, y = sv.y * 1e3, z = sv.z * 1e3;
    double vx = sv.vx * 1e3, vy = sv.vy * 1e3, vz = sv.vz * 1e3;

    double r_mag = std::sqrt(x * x + y * y + z * z);
    double v_mag = std::sqrt(vx * vx + vy * vy + vz * vz);

    // Specific angular momentum h = r x v
    double hx = y * vz - z * vy;
    double hy = z * vx - x * vz;
    double hz = x * vy - y * vx;
    double h_mag = std::sqrt(hx * hx + hy * hy + hz * hz);

    // Node vector n = z_hat x h
    double nx = -hy;
    double ny = hx;
    double n_mag = std::sqrt(nx * nx + ny * ny);

    // Eccentricity vector e = (v x h)/mu - r_hat
    double rdot = (x * vx + y * vy + z * vz) / r_mag;
    double ex = (1.0 / mu) * ((v_mag * v_mag - mu / r_mag) * x - r_mag * rdot * vx);
    double ey = (1.0 / mu) * ((v_mag * v_mag - mu / r_mag) * y - r_mag * rdot * vy);
    double ez = (1.0 / mu) * ((v_mag * v_mag - mu / r_mag) * z - r_mag * rdot * vz);
    double e_mag = std::sqrt(ex * ex + ey * ey + ez * ez);

    // Semi-major axis (vis-viva)
    double energy = v_mag * v_mag / 2.0 - mu / r_mag;
    double a = -mu / (2.0 * energy);

    // Inclination
    double inc = std::acos(hz / h_mag);

    // RAAN
    double raan = 0.0;
    if (n_mag > 1e-12) {
        raan = std::acos(nx / n_mag);
        if (ny < 0.0) raan = TWO_PI - raan;
    }

    // Argument of perigee
    double omega = 0.0;
    if (n_mag > 1e-12 && e_mag > 1e-12) {
        double dot_ne = nx * ex + ny * ey;
        omega = std::acos(dot_ne / (n_mag * e_mag));
        if (ez < 0.0) omega = TWO_PI - omega;
    }

    // True anomaly
    double nu = 0.0;
    if (e_mag > 1e-12) {
        double dot_er = ex * x + ey * y + ez * z;
        nu = std::acos(dot_er / (e_mag * r_mag));
        if (rdot < 0.0) nu = TWO_PI - nu;
    }

    // Mean anomaly from true anomaly
    // E = atan2(sqrt(1-e^2)*sin(nu), e+cos(nu))
    double E_anom = std::atan2(std::sqrt(1.0 - e_mag * e_mag) * std::sin(nu),
                               e_mag + std::cos(nu));
    double M = E_anom - e_mag * std::sin(E_anom);
    if (M < 0.0) M += TWO_PI;

    ClassicalOrbitalElements oe;
    oe.semiMajorAxis = a;
    oe.eccentricity = e_mag;
    oe.inclination = inc;
    oe.raan = raan;
    oe.argumentOfPerigee = omega;
    oe.meanAnomaly = M;
    oe.gravitationalParameter = mu;
    oe.angularMomentum = h_mag;
    return oe;
}

/// Convert ClassicalOrbitalElements (m, m/s) to a StateVector (km, km/s)
/// at the current mean anomaly.
StateVector elementsToState(const ClassicalOrbitalElements& oe, double epoch_jd) {
    double mu = oe.gravitationalParameter;
    double a = oe.semiMajorAxis;
    double e = oe.eccentricity;
    double inc = oe.inclination;
    double raan_val = oe.raan;
    double omega = oe.argumentOfPerigee;
    double M = oe.meanAnomaly;

    double nu = trueAnomalyFromMean(M, e);

    // Perifocal coordinates
    double r = orbitalRadius(a, e, nu);
    double p_x = r * std::cos(nu);
    double p_y = r * std::sin(nu);

    double h = std::sqrt(mu * a * (1.0 - e * e));
    double pv_x = -(mu / h) * std::sin(nu);
    double pv_y = (mu / h) * (e + std::cos(nu));

    // Rotation matrix perifocal -> ECI
    double cO = std::cos(raan_val), sO = std::sin(raan_val);
    double cw = std::cos(omega), sw = std::sin(omega);
    double ci = std::cos(inc), si = std::sin(inc);

    // Row 1 of rotation matrix
    double r11 = cO * cw - sO * sw * ci;
    double r12 = -cO * sw - sO * cw * ci;
    // Row 2
    double r21 = sO * cw + cO * sw * ci;
    double r22 = -sO * sw + cO * cw * ci;
    // Row 3
    double r31 = sw * si;
    double r32 = cw * si;

    // Position and velocity in ECI (meters, m/s)
    double x_m = r11 * p_x + r12 * p_y;
    double y_m = r21 * p_x + r22 * p_y;
    double z_m = r31 * p_x + r32 * p_y;
    double vx_m = r11 * pv_x + r12 * pv_y;
    double vy_m = r21 * pv_x + r22 * pv_y;
    double vz_m = r31 * pv_x + r32 * pv_y;

    StateVector sv;
    sv.epoch_jd = epoch_jd;
    sv.x = x_m * 1e-3;  // m -> km
    sv.y = y_m * 1e-3;
    sv.z = z_m * 1e-3;
    sv.vx = vx_m * 1e-3;
    sv.vy = vy_m * 1e-3;
    sv.vz = vz_m * 1e-3;
    return sv;
}

}  // anonymous namespace

// ===========================================================================
// Plugin entry point
// ===========================================================================

ManeuverPluginResult executeManeuverPlugin(const StateVector& initialState,
                                           const ManeuverPluginConfig& config) {
    ManeuverPluginResult result;

    try {
        double mu = MU_EARTH;
        ClassicalOrbitalElements oe = stateToElements(initialState, mu);

        switch (config.mode) {
            case ManeuverPluginConfig::Mode::HOHMANN: {
                double r1 = oe.semiMajorAxis;  // already in meters
                double r2 = config.targetRadius;
                if (r2 <= 0.0) {
                    result.errorMessage = "Target radius must be positive";
                    return result;
                }

                auto h = computeHohmannTransfer(r1, r2, mu);

                // Generate burn events
                BurnEvent b1;
                b1.epoch_jd = initialState.epoch_jd;
                b1.dv_v = h.dv1_ric[1] * 1e-3;  // m/s -> km/s
                b1.dv_mag = h.dv1 * 1e-3;

                BurnEvent b2;
                b2.epoch_jd = initialState.epoch_jd + h.tof / 86400.0;
                b2.dv_v = h.dv2_ric[1] * 1e-3;
                b2.dv_mag = h.dv2 * 1e-3;

                result.burns = {b1, b2};
                result.totalDeltaV = h.totalDeltaV * 1e-3;

                // Generate post-maneuver ephemeris points
                result.ephemeris.push_back(initialState);
                ClassicalOrbitalElements finalOE = oe;
                finalOE.semiMajorAxis = r2;
                finalOE.eccentricity = 0.0;
                result.ephemeris.push_back(
                    elementsToState(finalOE, b2.epoch_jd));

                result.success = true;
                break;
            }

            case ManeuverPluginConfig::Mode::BI_ELLIPTIC: {
                double r1 = oe.semiMajorAxis;
                double r2 = config.targetRadius;
                double rInt = config.intermediateR;

                auto be = computeBiEllipticTransfer(r1, r2, rInt, mu);

                BurnEvent b1;
                b1.epoch_jd = initialState.epoch_jd;
                b1.dv_v = be.dv1_ric[1] * 1e-3;
                b1.dv_mag = be.dv1 * 1e-3;

                BurnEvent b2;
                double tof1 = M_PI * std::sqrt(
                    be.aTransfer1 * be.aTransfer1 * be.aTransfer1 / mu);
                b2.epoch_jd = initialState.epoch_jd + tof1 / 86400.0;
                b2.dv_v = be.dv2_ric[1] * 1e-3;
                b2.dv_mag = be.dv2 * 1e-3;

                BurnEvent b3;
                b3.epoch_jd = initialState.epoch_jd + be.tof / 86400.0;
                b3.dv_v = be.dv3_ric[1] * 1e-3;
                b3.dv_mag = be.dv3 * 1e-3;

                result.burns = {b1, b2, b3};
                result.totalDeltaV = be.totalDeltaV * 1e-3;
                result.ephemeris.push_back(initialState);
                result.success = true;
                break;
            }

            case ManeuverPluginConfig::Mode::PATCHED_CONIC: {
                auto pc = computePatchedConicTransfer(
                    config.departurePlanet, config.arrivalPlanet,
                    config.parkingAltDepart, config.parkingAltArrive);

                BurnEvent b1;
                b1.epoch_jd = initialState.epoch_jd;
                b1.dv_v = pc.dvDepart * 1e-3;
                b1.dv_mag = pc.dvDepart * 1e-3;

                BurnEvent b2;
                b2.epoch_jd = initialState.epoch_jd + pc.tof / 86400.0;
                b2.dv_v = -pc.dvArrive * 1e-3;  // retrograde capture
                b2.dv_mag = pc.dvArrive * 1e-3;

                result.burns = {b1, b2};
                result.totalDeltaV = pc.totalDeltaV * 1e-3;
                result.ephemeris.push_back(initialState);
                result.success = true;
                break;
            }

            case ManeuverPluginConfig::Mode::ROE_RENDEZVOUS: {
                if (config.waypoints.empty()) {
                    result.errorMessage = "At least one waypoint required";
                    return result;
                }

                // Initial state as relative state (zero = co-located)
                RelativeState initRel = {ZERO_VECTOR3, ZERO_VECTOR3};

                auto plan = planMission(initRel, config.waypoints, oe,
                                        config.targetingOptions);

                // Convert burn events
                double timeOffset = 0.0;
                for (const auto& leg : plan.legs) {
                    BurnEvent b1;
                    b1.epoch_jd =
                        initialState.epoch_jd + timeOffset / 86400.0;
                    b1.dv_u = leg.burn1.deltaV[0] * 1e-3;
                    b1.dv_v = leg.burn1.deltaV[1] * 1e-3;
                    b1.dv_w = leg.burn1.deltaV[2] * 1e-3;
                    b1.dv_mag = leg.burn1.magnitude * 1e-3;
                    result.burns.push_back(b1);

                    BurnEvent b2;
                    b2.epoch_jd = initialState.epoch_jd +
                                  (timeOffset + leg.tof) / 86400.0;
                    b2.dv_u = leg.burn2.deltaV[0] * 1e-3;
                    b2.dv_v = leg.burn2.deltaV[1] * 1e-3;
                    b2.dv_w = leg.burn2.deltaV[2] * 1e-3;
                    b2.dv_mag = leg.burn2.magnitude * 1e-3;
                    result.burns.push_back(b2);

                    timeOffset += leg.tof;
                }

                result.totalDeltaV = plan.totalDeltaV * 1e-3;
                result.ephemeris.push_back(initialState);
                result.success = plan.converged;
                break;
            }

            case ManeuverPluginConfig::Mode::ROE_MISSION_PLAN: {
                RelativeState initRel = {ZERO_VECTOR3, ZERO_VECTOR3};
                auto plan = planMission(initRel, config.waypoints, oe,
                                        config.targetingOptions);

                double timeOffset = 0.0;
                for (const auto& leg : plan.legs) {
                    BurnEvent b1;
                    b1.epoch_jd =
                        initialState.epoch_jd + timeOffset / 86400.0;
                    b1.dv_u = leg.burn1.deltaV[0] * 1e-3;
                    b1.dv_v = leg.burn1.deltaV[1] * 1e-3;
                    b1.dv_w = leg.burn1.deltaV[2] * 1e-3;
                    b1.dv_mag = leg.burn1.magnitude * 1e-3;
                    result.burns.push_back(b1);

                    BurnEvent b2;
                    b2.epoch_jd = initialState.epoch_jd +
                                  (timeOffset + leg.tof) / 86400.0;
                    b2.dv_u = leg.burn2.deltaV[0] * 1e-3;
                    b2.dv_v = leg.burn2.deltaV[1] * 1e-3;
                    b2.dv_w = leg.burn2.deltaV[2] * 1e-3;
                    b2.dv_mag = leg.burn2.magnitude * 1e-3;
                    result.burns.push_back(b2);

                    timeOffset += leg.tof;
                }

                result.totalDeltaV = plan.totalDeltaV * 1e-3;
                result.ephemeris.push_back(initialState);
                result.success = plan.converged;
                break;
            }

            case ManeuverPluginConfig::Mode::GENERAL_TRANSFER: {
                ClassicalOrbitalElements oe2 = oe;
                oe2.semiMajorAxis = config.targetRadius;
                auto gt = computeGeneralTransfer(oe, oe2, 0.0);

                BurnEvent b1;
                b1.epoch_jd = initialState.epoch_jd;
                b1.dv_u = gt.dv_ric[0] * 1e-3;
                b1.dv_v = gt.dv_ric[1] * 1e-3;
                b1.dv_w = gt.dv_ric[2] * 1e-3;
                b1.dv_mag = gt.dv * 1e-3;

                result.burns = {b1};
                result.totalDeltaV = gt.dv * 1e-3;
                result.ephemeris.push_back(initialState);
                result.success = true;
                break;
            }
        }
    } catch (const std::exception& ex) {
        result.errorMessage = ex.what();
        result.success = false;
    }

    return result;
}

}  // namespace maneuver
