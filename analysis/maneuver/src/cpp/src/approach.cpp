#include "maneuver/approach.h"
#include "maneuver/math.h"
#include "maneuver/targeting.h"
#include "maneuver/transforms.h"
#include "maneuver/propagation.h"

#include <cmath>
#include <algorithm>
#include <stdexcept>
#include <limits>

namespace maneuver {

// ===========================================================================
// Constrained Approach (V-bar / R-bar / H-bar)
// ===========================================================================

ApproachResult computeApproach(
    const RelativeState& initialState,
    const ClassicalOrbitalElements& chief,
    const ApproachConfig& config) {

    Vector3 target = config.targetPosition;

    // Set up targeting with velocity constraint along approach axis
    TargetingOptions opts;
    opts.includeJ2 = config.includeJ2;
    opts.maxIterations = config.maxIterations;
    opts.positionTolerance = config.positionTolerance;

    // Set target velocity along approach axis
    double speed = config.approachSpeed;
    switch (config.axis) {
        case ApproachAxis::V_BAR:
            // Approach along in-track: target velocity = [0, ±speed, 0]
            // Sign: positive if coming from behind (y < target_y)
            opts.targetVelocity = {0.0,
                (initialState.position[1] < target[1]) ? speed : -speed,
                0.0};
            break;
        case ApproachAxis::R_BAR:
            // Approach along radial: target velocity = [±speed, 0, 0]
            opts.targetVelocity = {
                (initialState.position[0] < target[0]) ? speed : -speed,
                0.0, 0.0};
            break;
        case ApproachAxis::H_BAR:
            // Approach along cross-track: target velocity = [0, 0, ±speed]
            opts.targetVelocity = {0.0, 0.0,
                (initialState.position[2] < target[2]) ? speed : -speed};
            break;
    }

    // Use TOF optimizer to find best transfer
    ManeuverLeg leg = optimizeTOF(initialState, target, chief, opts);

    // Evaluate corridor deviation by generating dense trajectory
    // and checking max lateral deviation from the approach axis
    double maxDeviation = 0.0;
    constexpr int NUM_CHECK_POINTS = 50;
    ROEPropagationOptions propOpts;
    propOpts.includeJ2 = config.includeJ2;

    ROEVector initialROE = roeToVector(ricToROE(chief, initialState));
    ROEVector roeAfterDv1 = applyDeltaV(initialROE, leg.burn1.deltaV, chief);

    double dt = leg.tof / NUM_CHECK_POINTS;
    for (int i = 1; i < NUM_CHECK_POINTS; ++i) {
        double t = i * dt;
        auto result = propagateROEWithChief(vectorToROE(roeAfterDv1), chief, t, propOpts);
        RelativeState ric = roeToRIC(result.chief, result.roe);

        // Compute lateral deviation based on approach axis
        double deviation = 0.0;
        switch (config.axis) {
            case ApproachAxis::V_BAR:
                // Lateral = radial + cross-track
                deviation = std::sqrt(ric.position[0] * ric.position[0] +
                                      ric.position[2] * ric.position[2]);
                break;
            case ApproachAxis::R_BAR:
                deviation = std::sqrt(ric.position[1] * ric.position[1] +
                                      ric.position[2] * ric.position[2]);
                break;
            case ApproachAxis::H_BAR:
                deviation = std::sqrt(ric.position[0] * ric.position[0] +
                                      ric.position[1] * ric.position[1]);
                break;
        }
        maxDeviation = std::max(maxDeviation, deviation);
    }

    ApproachResult result;
    result.leg = leg;
    result.axis = config.axis;
    result.corridorDeviation = maxDeviation;
    result.withinCorridor = (maxDeviation <= config.safetyCorridorWidth);
    return result;
}

// ===========================================================================
// Natural Motion Circumnavigation (NMC) / Football Orbit
// ===========================================================================

QuasiNonsingularROE computeNMCROE(
    const ClassicalOrbitalElements& chief,
    const NMCConfig& config) {
    double a = chief.semiMajorAxis;

    // NMC bounded relative motion requires:
    //   da = 0 (no along-track drift)
    //   dlambda = free (sets center of relative orbit)
    //   dex, dey set the in-plane relative eccentricity vector
    //   dix, diy set the cross-track oscillation
    //
    // In-plane: relative motion is 2:1 ellipse
    //   radial amplitude = ae * |de| * a
    //   in-track amplitude = 2 * ae * |de| * a
    //   where |de| = sqrt(dex^2 + dey^2)
    //
    // Cross-track: oscillation amplitude = a * |di|
    //   where |di| = sqrt(dix^2 + diy^2)

    double phase = config.phaseAngle;

    // In-plane: radial amp = a * |de|, along-track amp = 2 * a * |de|
    // User specifies amplitudes; we derive ROE from that
    double inPlaneAmp = config.radialAmplitude;
    if (inPlaneAmp <= 0.0) {
        inPlaneAmp = config.alongTrackAmplitude / 2.0;
    }
    double de_mag = inPlaneAmp / a;
    double dex = de_mag * std::cos(phase);
    double dey = de_mag * std::sin(phase);

    // Cross-track
    double di_mag = config.crossTrackAmplitude / a;
    double dix = di_mag * std::cos(phase);
    double diy = di_mag * std::sin(phase);

    return {0.0, 0.0, dex, dey, dix, diy};
}

ManeuverLeg computeNMCEntry(
    const RelativeState& initialState,
    const ClassicalOrbitalElements& chief,
    const NMCConfig& config,
    const TargetingOptions& options) {

    QuasiNonsingularROE targetROE = computeNMCROE(chief, config);
    RelativeState targetRIC = roeToRIC(chief, targetROE);

    double n = meanMotion(chief.semiMajorAxis, chief.gravitationalParameter);
    double period = TWO_PI / n;
    double tof = period;  // Use one orbit as default TOF

    // Target the position of the NMC at phase = 0
    return solveRendezvous(initialState, targetRIC.position, chief, tof, options);
}

std::vector<TrajectoryPoint> generateNMCTrajectory(
    const ClassicalOrbitalElements& chief,
    const NMCConfig& config,
    int numOrbits,
    int pointsPerOrbit) {

    QuasiNonsingularROE roe = computeNMCROE(chief, config);
    double n = meanMotion(chief.semiMajorAxis, chief.gravitationalParameter);
    double period = TWO_PI / n;
    double totalTime = numOrbits * period;
    int totalPoints = numOrbits * pointsPerOrbit;

    ROEPropagationOptions propOpts;
    propOpts.includeJ2 = true;

    std::vector<TrajectoryPoint> trajectory;
    trajectory.reserve(totalPoints);

    double dt = totalTime / totalPoints;
    ClassicalOrbitalElements currentChief = chief;
    QuasiNonsingularROE currentROE = roe;

    for (int i = 0; i <= totalPoints; ++i) {
        double t = i * dt;
        if (i == 0) {
            RelativeState ric = roeToRIC(chief, roe);
            trajectory.push_back({0.0, ric.position, ric.velocity});
        } else {
            auto result = propagateROEWithChief(roe, chief, t, propOpts);
            RelativeState ric = roeToRIC(result.chief, result.roe);
            trajectory.push_back({t, ric.position, ric.velocity});
        }
    }

    return trajectory;
}

// ===========================================================================
// Collision Avoidance Maneuver (CAM)
// ===========================================================================

CAMResult computeCAM(
    const RelativeState& initialState,
    const ClassicalOrbitalElements& chief,
    const CAMConfig& config) {

    double n = meanMotion(chief.semiMajorAxis, chief.gravitationalParameter);
    double tca = config.timeToTCA;

    // Use CW equations to find optimal burn direction
    // The miss vector at TCA is approximately:
    //   dr(tca) = Phi(tca) * [0; 0; 0; dvR; dvI; dvC]
    //
    // For CW:
    //   dx(t) = (2/n)(1-cos(nt)) * dvI + sin(nt)/n * dvR
    //   dy(t) = (4sin(nt)-3nt)/n * dvI - 2(1-cos(nt))/n * dvR
    //   dz(t) = sin(nt)/n * dvC
    //
    // The miss distance increase from a unit burn in each direction:

    double nt = n * tca;
    double snt = std::sin(nt);
    double cnt = std::cos(nt);

    // Sensitivity of miss distance to delta-v components (CW)
    // Position change per unit delta-v
    double dxR = snt / n;
    double dxI = (2.0 / n) * (1.0 - cnt);
    double dyR = -2.0 * (1.0 - cnt) / n;
    double dyI = (4.0 * snt - 3.0 * nt) / n;
    double dzC = snt / n;

    // Position change magnitude per unit dv in each direction
    double sensR = std::sqrt(dxR * dxR + dyR * dyR);
    double sensI = std::sqrt(dxI * dxI + dyI * dyI);
    double sensC = std::abs(dzC);

    // Current miss distance (position magnitude)
    double currentMiss = norm3(initialState.position);
    double requiredAdditional = config.minMissDistance - currentMiss;

    CAMResult result;

    if (requiredAdditional <= 0.0) {
        // Already safe
        result.deltaV = {0.0, 0.0, 0.0};
        result.magnitude = 0.0;
        result.achievedMiss = currentMiss;
        result.feasible = true;
        result.optimalBurnTime = 0.0;
        return result;
    }

    // Choose optimal burn direction (maximum sensitivity)
    if (config.preferRadial || sensR >= sensI) {
        // Radial burn preferred or optimal
        if (sensR > 1e-15) {
            double dvMag = requiredAdditional / sensR;
            // Burn direction: maximize miss (away from conjunction point)
            double sign = (initialState.position[0] >= 0) ? 1.0 : -1.0;
            result.deltaV = {sign * dvMag, 0.0, 0.0};
            result.magnitude = dvMag;
            result.achievedMiss = currentMiss + sensR * dvMag;
        }
    } else if (sensI >= sensC) {
        // In-track burn optimal
        double dvMag = requiredAdditional / sensI;
        double sign = (initialState.position[1] >= 0) ? 1.0 : -1.0;
        result.deltaV = {0.0, sign * dvMag, 0.0};
        result.magnitude = dvMag;
        result.achievedMiss = currentMiss + sensI * dvMag;
    } else {
        // Cross-track burn optimal
        double dvMag = requiredAdditional / sensC;
        double sign = (initialState.position[2] >= 0) ? 1.0 : -1.0;
        result.deltaV = {0.0, 0.0, sign * dvMag};
        result.magnitude = dvMag;
        result.achievedMiss = currentMiss + sensC * dvMag;
    }

    result.feasible = (result.magnitude <= config.maxDeltaV);
    result.optimalBurnTime = tca;  // Simplified: burn immediately
    return result;
}

// ===========================================================================
// Phasing Orbit
// ===========================================================================

PhasingResult computePhasingManeuver(
    double currentRadius, double phaseAngle, int numRevs, double mu) {
    if (currentRadius <= 0.0) {
        throw std::runtime_error(
            "[phasing]: Orbit radius must be positive");
    }
    if (numRevs < 1) {
        throw std::runtime_error(
            "[phasing]: Number of revolutions must be >= 1");
    }

    // Current orbital period
    double T_current = TWO_PI * std::sqrt(
        currentRadius * currentRadius * currentRadius / mu);

    // Required phasing orbit period:
    // In numRevs revolutions, the target moves numRevs * T_current
    // We need our spacecraft to arrive phaseAngle ahead/behind
    // T_phasing * numRevs = T_current * numRevs - phaseAngle / (2*pi) * T_current
    double T_phasing = T_current - (phaseAngle / (TWO_PI * numRevs)) * T_current;

    // Phasing orbit SMA from period
    double a_phasing = std::pow(mu * T_phasing * T_phasing /
                                (4.0 * M_PI * M_PI), 1.0 / 3.0);

    // Delta-v: transfer to/from phasing orbit (Hohmann-like)
    double v_current = std::sqrt(mu / currentRadius);

    // The phasing orbit touches the current orbit at the burn point
    // If phaseAngle > 0 (need to get ahead): lower orbit (faster period)
    // If phaseAngle < 0 (need to fall back): higher orbit (slower period)
    double v_phasing = std::sqrt(mu * (2.0 / currentRadius - 1.0 / a_phasing));

    double dv1 = v_phasing - v_current;
    double dv2 = v_current - v_phasing;  // return to original orbit

    double totalTime = T_phasing * numRevs;

    PhasingResult result;
    result.dv1 = std::abs(dv1);
    result.dv2 = std::abs(dv2);
    result.totalDeltaV = result.dv1 + result.dv2;
    result.phasingPeriod = T_phasing;
    result.phasingSMA = a_phasing;
    result.numRevs = numRevs;
    result.totalTime = totalTime;
    result.phaseAngle = phaseAngle;
    result.dv1_ric = {0.0, dv1, 0.0};
    result.dv2_ric = {0.0, dv2, 0.0};
    return result;
}

// ===========================================================================
// Plane Change
// ===========================================================================

PlaneChangeResult computePlaneChange(
    double orbitalRadius, double velocity, double deltaInclination) {
    // Pure plane change delta-v:
    // dv = 2 * v * sin(di/2)
    double dv = 2.0 * velocity * std::sin(std::abs(deltaInclination) / 2.0);

    // Optimal location: at ascending/descending node
    // For inclination increase: burn at ascending node
    // For inclination decrease: burn at descending node
    double optimalTA = (deltaInclination >= 0) ? 0.0 : M_PI;

    // Delta-v is purely cross-track
    double sign = (deltaInclination >= 0) ? 1.0 : -1.0;

    return {dv, optimalTA, {0.0, 0.0, sign * dv}};
}

HohmannResult computeCombinedManeuver(
    double r1, double r2, double di, double mu) {
    // Combined plane change + altitude change at the optimal point
    // Most efficient when done at the highest point in the transfer

    // First compute the Hohmann transfer
    double aTransfer = (r1 + r2) / 2.0;

    double v1_circ = std::sqrt(mu / r1);
    double v2_circ = std::sqrt(mu / r2);

    double v1_transfer = std::sqrt(mu * (2.0 / r1 - 1.0 / aTransfer));
    double v2_transfer = std::sqrt(mu * (2.0 / r2 - 1.0 / aTransfer));

    // First burn: pure in-plane (no plane change at lower altitude)
    double dv1 = v1_transfer - v1_circ;

    // Second burn: combined circularization + plane change at higher altitude
    // Use law of cosines: dv2 = sqrt(v2_circ^2 + v2_transfer^2 - 2*v2_circ*v2_transfer*cos(di))
    double dv2 = std::sqrt(v2_circ * v2_circ + v2_transfer * v2_transfer -
                           2.0 * v2_circ * v2_transfer * std::cos(di));

    double tof = M_PI * std::sqrt(aTransfer * aTransfer * aTransfer / mu);

    // Decompose dv2 into RIC
    double dv2_I = v2_circ * std::cos(di) - v2_transfer;
    double dv2_C = v2_circ * std::sin(di);

    return {std::abs(dv1), dv2,
            std::abs(dv1) + dv2,
            tof, aTransfer,
            {0.0, dv1, 0.0},
            {0.0, dv2_I, dv2_C}};
}

// ===========================================================================
// Lambert Solver (Izzo's method)
// ===========================================================================

namespace {

// Stumpff functions for universal variable formulation
double stumpffC(double psi) {
    if (std::abs(psi) < 1e-6) return 1.0 / 6.0;
    if (psi > 0) return (1.0 - std::cos(std::sqrt(psi))) / psi;
    return (std::cosh(std::sqrt(-psi)) - 1.0) / (-psi);
}

double stumpffS(double psi) {
    if (std::abs(psi) < 1e-6) return 1.0 / 120.0;
    if (psi > 0) {
        double sqrtPsi = std::sqrt(psi);
        return (sqrtPsi - std::sin(sqrtPsi)) / (sqrtPsi * sqrtPsi * sqrtPsi);
    }
    double sqrtNPsi = std::sqrt(-psi);
    return (std::sinh(sqrtNPsi) - sqrtNPsi) / (sqrtNPsi * sqrtNPsi * sqrtNPsi);
}

// Cross product for 3-vectors
Vector3 cross3(const Vector3& a, const Vector3& b) {
    return {a[1]*b[2] - a[2]*b[1],
            a[2]*b[0] - a[0]*b[2],
            a[0]*b[1] - a[1]*b[0]};
}

// Scale a 3-vector
Vector3 scale3(const Vector3& v, double s) {
    return {v[0]*s, v[1]*s, v[2]*s};
}

}  // anonymous namespace

LambertResult solveLambert(
    const Vector3& r1, const Vector3& r2, double tof,
    double mu, bool prograde, int nRevs) {

    double r1_mag = norm3(r1);
    double r2_mag = norm3(r2);

    // Cross product to determine transfer direction
    Vector3 cross = cross3(r1, r2);
    double dot = r1[0]*r2[0] + r1[1]*r2[1] + r1[2]*r2[2];

    // Transfer angle
    double cosTheta = dot / (r1_mag * r2_mag);
    cosTheta = std::max(-1.0, std::min(1.0, cosTheta));
    double theta = std::acos(cosTheta);

    // Adjust for prograde/retrograde
    if (prograde) {
        if (cross[2] < 0) theta = TWO_PI - theta;
    } else {
        if (cross[2] >= 0) theta = TWO_PI - theta;
    }

    // Add full revolutions
    theta += nRevs * TWO_PI;

    // Universal variable Lambert solver (Bate, Mueller, White)
    double A = std::sin(theta) * std::sqrt(r1_mag * r2_mag / (1.0 - cosTheta));

    if (std::abs(A) < 1e-15) {
        return {{}, {}, 0, 0, 0, tof, false, nRevs};
    }

    // Newton-Raphson iteration on universal variable z
    double z = 0.0;
    if (nRevs > 0) {
        z = 4.0 * M_PI * M_PI;  // Start above first revolution
    }

    constexpr int MAX_ITER = 200;
    constexpr double TOL = 1e-10;

    for (int iter = 0; iter < MAX_ITER; ++iter) {
        double C = stumpffC(z);
        double S = stumpffS(z);

        double y = r1_mag + r2_mag + A * (z * S - 1.0) / std::sqrt(C);

        if (y < 0.0) {
            // Adjust z to make y positive
            z = z + 0.1;
            continue;
        }

        double chi = std::sqrt(y / C);
        double F = chi * chi * chi * S + A * std::sqrt(y) - std::sqrt(mu) * tof;

        // Derivative dF/dz
        double dF;
        if (std::abs(z) < 1e-6) {
            dF = (std::sqrt(2.0) / 40.0) * y * y * y *
                 std::sqrt(y) + (A / 8.0) * (std::sqrt(y) + A * std::sqrt(1.0 / (2.0 * y)));
        } else {
            dF = (chi * chi * chi * (S - 3.0 * S * z / (2.0 * C) +
                  1.0 / (2.0 * C)) + (A / 8.0) * (3.0 * S * std::sqrt(y) / C +
                  A * std::sqrt(C / y)));
        }

        if (std::abs(dF) < 1e-30) break;

        double z_new = z - F / dF;
        if (std::abs(z_new - z) < TOL) {
            z = z_new;
            break;
        }
        z = z_new;
    }

    // Compute Lagrange coefficients
    double C = stumpffC(z);
    double S = stumpffS(z);
    double y = r1_mag + r2_mag + A * (z * S - 1.0) / std::sqrt(C);

    double f = 1.0 - y / r1_mag;
    double g_dot = 1.0 - y / r2_mag;
    double g = A * std::sqrt(y / mu);

    // Velocities
    Vector3 v1_vec = scale3(sub3(r2, scale3(r1, f)), 1.0 / g);
    Vector3 v2_vec = scale3(sub3(scale3(r2, g_dot), r1), 1.0 / g);

    LambertResult result;
    result.v1 = v1_vec;
    result.v2 = v2_vec;
    result.tof = tof;
    result.converged = true;
    result.revolutions = nRevs;
    // Note: dv1 and dv2 require initial/final velocities to compute
    // Here we return the transfer velocities; the user subtracts their initial/final
    result.dv1 = norm3(v1_vec);
    result.dv2 = norm3(v2_vec);
    result.totalDV = result.dv1 + result.dv2;
    return result;
}

LambertResult solveLambertMinDV(
    const Vector3& r1, const Vector3& r2, double tof,
    double mu, bool prograde, int maxRevs) {

    LambertResult best;
    best.totalDV = std::numeric_limits<double>::infinity();

    for (int rev = 0; rev <= maxRevs; ++rev) {
        try {
            auto result = solveLambert(r1, r2, tof, mu, prograde, rev);
            if (result.converged && result.totalDV < best.totalDV) {
                best = result;
            }
        } catch (...) {
            continue;
        }
    }

    return best;
}

}  // namespace maneuver
