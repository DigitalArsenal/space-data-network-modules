#include "maneuver/approach.h"
#include "maneuver/constants.h"
#include "maneuver/fault.h"
#include "maneuver/math.h"
#include "maneuver/targeting.h"
#include "maneuver/transforms.h"
#include "maneuver/propagation.h"
#ifndef LAMBERT_IZZO_SOLVER_HPP
#include "../../../../lambert-izzo/include/lambert_izzo/solver.hpp"
#endif

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
        return fault::fail<PhasingResult>(fault_code::INVALID_PARAMETER,
            "[phasing]: Orbit radius must be positive");
    }
    if (numRevs < 1) {
        return fault::fail<PhasingResult>(fault_code::INVALID_PARAMETER,
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

    // ---------------------------------------------------------------------
    // EARTH-COLLISION FLOOR.
    //
    // The burn point stays at `currentRadius`, so the phasing orbit's OTHER
    // apse is `2*a - r`. Nothing above constrains it: at +170 deg in one
    // revolution the unclamped solution puts that apse ~4,300 km BELOW the
    // surface and 0.1.0 returned it with no error and no flag (graph:
    // modules-maneuver-planner-rebuild-batch item 2).
    //
    // The floor is Re + 100 km on the WGS-84 equatorial radius, matching the
    // command-card spec (maneuver-command-cards.md section 4.8) and the
    // conformance model the parity vectors pin. The clamp is REPORTED rather
    // than silent: a caller that asked for a phase shift it cannot have in the
    // revolutions it offered needs to know that what came back is a different
    // maneuver, so it can tell an operator to use more revolutions.
    // ---------------------------------------------------------------------
    const double a_floor = (PHASING_FLOOR_RADIUS + currentRadius) / 2.0;
    bool clamped = false;
    double requested_a = a_phasing;
    double requested_T = T_phasing;
    if (a_phasing < a_floor) {
        clamped = true;
        a_phasing = a_floor;
        T_phasing = TWO_PI * std::sqrt(
            a_phasing * a_phasing * a_phasing / mu);
    }

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
    // Signed in-track scalars (gmat-01-defect-burn-down): a catch-up phasing
    // orbit is entered by braking (dv1 < 0) and left by accelerating, and the
    // pair is symmetric, so std::abs() erased the only thing that told the two
    // burns apart. The budget stays a magnitude sum.
    result.dv1 = dv1;
    result.dv2 = dv2;
    result.totalDeltaV = std::abs(dv1) + std::abs(dv2);
    result.phasingPeriod = T_phasing;
    result.phasingSMA = a_phasing;
    result.numRevs = numRevs;
    result.totalTime = totalTime;
    result.phaseAngle = phaseAngle;
    result.dv1_ric = {0.0, dv1, 0.0};
    result.dv2_ric = {0.0, dv2, 0.0};
    result.clampedToEarthFloor = clamped;
    result.farApse = 2.0 * a_phasing - currentRadius;
    result.earthFloorRadius = PHASING_FLOOR_RADIUS;
    result.requestedPhasingSMA = requested_a;
    result.requestedPhasingPeriod = requested_T;
    // The phase shift the CLAMPED orbit actually delivers over numRevs. Equal
    // to the request when nothing was clamped; the honest number to show an
    // operator when something was.
    result.achievedPhaseAngle =
        clamped ? (1.0 - T_phasing / T_current) * TWO_PI * numRevs : phaseAngle;
    return result;
}

// ===========================================================================
// Phasing derived from a TARGET SPACECRAFT
// ===========================================================================

namespace {

/// The phase angle the requested direction actually asks for.
///
/// Both directions reach the SAME rendezvous. `catchUp` is the chaser gaining
/// phase (a positive shift, a lower and faster orbit); `fallBehind` is the
/// chaser losing it. Which one is cheaper depends entirely on the sign of the
/// separation, and a module that silently returned only the short one would
/// hide the card the operator actually pressed — /beta has BOTH a CATCH S/C
/// card and a FALL BEHIND card, and each means its own direction literally.
double angleForDirection(const PhaseGeometry& geometry,
                         PhasingDirection direction) {
    switch (direction) {
        case PhasingDirection::CATCH_UP:    return geometry.catchUpAngle;
        case PhasingDirection::FALL_BEHIND: return geometry.fallBehindAngle;
        case PhasingDirection::SHORT:       break;
    }
    return geometry.relativePhaseAngle;
}

PhasingBranchSummary summarise(const PhasingResult& plan, double budget) {
    PhasingBranchSummary summary;
    summary.phaseAngle = plan.phaseAngle;
    summary.numRevs = plan.numRevs;
    summary.totalDeltaV = plan.totalDeltaV;
    summary.totalTime = plan.totalTime;
    summary.phasingSMA = plan.phasingSMA;
    summary.clampedToEarthFloor = plan.clampedToEarthFloor;
    summary.metDeltaVBudget =
        !plan.clampedToEarthFloor && plan.totalDeltaV <= budget;
    return summary;
}

/// The smallest revolution count in [1, maxRevs] that both clears the Earth
/// floor without clamping AND comes in under the delta-v budget.
///
/// Both conditions are MONOTONE in the revolution count — more revolutions
/// means a phasing orbit closer to the original, which is both higher (for a
/// catch-up) and cheaper — so the first hit is the answer and the scan never
/// has to rank. Ties cannot arise: the scan is ascending and returns on the
/// first success, so the result depends on the integer order and never on
/// floating-point comparison order.
///
/// When nothing in range qualifies, `maxRevs` is returned: delta-v is
/// monotonically decreasing, so the ceiling is the best available answer, and
/// `*metBudget` says plainly that it is not the answer that was asked for.
int recommendRevs(double radius, double phaseAngle, double mu, int maxRevs,
                  double budget, bool* metBudget) {
    *metBudget = false;
    for (int revs = 1; revs <= maxRevs; ++revs) {
        const PhasingResult trial =
            computePhasingManeuver(radius, phaseAngle, revs, mu);
        if (fault::raised()) return revs;
        if (trial.clampedToEarthFloor) continue;
        if (trial.totalDeltaV <= budget) {
            *metBudget = true;
            return revs;
        }
    }
    return maxRevs;
}

}  // namespace

PhasingFromStateResult computePhasingFromTargetState(
    const ClassicalOrbitalElements& chaser,
    const ClassicalOrbitalElements& target,
    const PhasingFromStateOptions& options) {
    if (!(options.mu > 0.0)) {
        return fault::fail<PhasingFromStateResult>(
            fault_code::INVALID_PARAMETER,
            "[phasing-from-state]: mu must be positive");
    }
    if (!(chaser.semiMajorAxis > 0.0) || !(target.semiMajorAxis > 0.0)) {
        return fault::fail<PhasingFromStateResult>(
            fault_code::INVALID_PARAMETER,
            "[phasing-from-state]: both craft need a positive semi-major axis");
    }

    PhasingFromStateResult result;
    result.geometry = computePhaseGeometry(chaser, target);

    // The phasing model is circular and its period comes from the semi-major
    // axis; see the note on `phasingRadius` in the header.
    const double radius = chaser.semiMajorAxis;
    result.phasingRadius = radius;

    const double circularSpeed = std::sqrt(options.mu / radius);
    result.deltaVBudget = options.deltaVBudget > 0.0
                              ? options.deltaVBudget
                              : options.deltaVBudgetFraction * circularSpeed;

    // maxRevs is CLAMPED, never refused: a typo must not become a long loop,
    // and a clamp that is reported is not a lie.
    int maxRevs = options.maxRevs;
    if (maxRevs < 1) maxRevs = 1;
    if (maxRevs > kMaxPhasingRevs) maxRevs = kMaxPhasingRevs;
    result.maxRevsApplied = maxRevs;

    const double phaseAngle = angleForDirection(result.geometry, options.direction);
    result.phaseAngleFlown = phaseAngle;

    bool metBudget = false;
    const int recommended = recommendRevs(radius, phaseAngle, options.mu,
                                          maxRevs, result.deltaVBudget,
                                          &metBudget);
    if (fault::raised()) return {};
    result.recommendedRevs = recommended;
    result.metDeltaVBudget = metBudget;

    int revs = recommended;
    if (options.numRevs >= 1) {
        revs = options.numRevs > kMaxPhasingRevs ? kMaxPhasingRevs
                                                 : options.numRevs;
        result.revsFromCaller = true;
    } else if (options.numRevs < 0) {
        return fault::fail<PhasingFromStateResult>(
            fault_code::INVALID_PARAMETER,
            "[phasing-from-state]: numRevs must be >= 1 when it is given at "
            "all; omit it to have the revolution count recommended");
    }

    result.plan = computePhasingManeuver(radius, phaseAngle, revs, options.mu);
    if (fault::raised()) return {};
    result.metDeltaVBudget =
        !result.plan.clampedToEarthFloor &&
        result.plan.totalDeltaV <= result.deltaVBudget;

    // BOTH directions, always — even when the caller forced one. The summary
    // of the road not taken is what lets a console show an operator that
    // falling behind 330 degrees costs eleven times what catching up 30 does.
    for (int pass = 0; pass < 2; ++pass) {
        const double branchAngle = pass == 0 ? result.geometry.catchUpAngle
                                             : result.geometry.fallBehindAngle;
        bool branchMet = false;
        const int branchRevs =
            options.numRevs >= 1
                ? revs
                : recommendRevs(radius, branchAngle, options.mu, maxRevs,
                                result.deltaVBudget, &branchMet);
        if (fault::raised()) return {};
        const PhasingResult branchPlan =
            computePhasingManeuver(radius, branchAngle, branchRevs, options.mu);
        if (fault::raised()) return {};
        (pass == 0 ? result.catchUp : result.fallBehind) =
            summarise(branchPlan, result.deltaVBudget);
    }

    result.coplanarTolerance = options.coplanarTolerance;
    result.eccentricityTolerance = options.eccentricityTolerance;
    result.coOrbitalToleranceMetres = options.coOrbitalTolerance * radius;
    result.coplanar = result.geometry.planeAngle <= options.coplanarTolerance;
    result.nearCircular =
        result.geometry.chaserEccentricity <= options.eccentricityTolerance &&
        result.geometry.targetEccentricity <= options.eccentricityTolerance;
    result.coOrbital = std::abs(result.geometry.semiMajorAxisDifference) <=
                       result.coOrbitalToleranceMetres;
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

    // dv1 is purely in-track and therefore SIGNED. dv2 is the law-of-cosines
    // norm of a two-component (in-track + cross-track) burn: a scalar sign is
    // not defined for it, so it stays a magnitude and dv2_ric carries the
    // direction.
    return {dv1, dv2,
            std::abs(dv1) + dv2,
            tof, aTransfer,
            {0.0, dv1, 0.0},
            {0.0, dv2_I, dv2_C}};
}

// ===========================================================================
// Lambert Solver — delegated to the shared analysis/lambert-izzo kernel.
// ===========================================================================

namespace {

lambert_izzo::Vector3 toIzzoVector(const Vector3& value) {
    return {value[0], value[1], value[2]};
}

Vector3 fromIzzoVector(const lambert_izzo::Vector3& value) {
    return {value.x, value.y, value.z};
}

/// Fill the transfer arc's conic block from the shared solver's departure
/// state. The solver owns the trajectory; this planner-only adapter reports the
/// existing maneuver JSON diagnostics.
void fillTransferConic(LambertResult& result, const Vector3& r1, double mu) {
    const double rMag = norm3(r1);
    const double vMag = norm3(result.v1);
    const Vector3 angularMomentum = {
        r1[1] * result.v1[2] - r1[2] * result.v1[1],
        r1[2] * result.v1[0] - r1[0] * result.v1[2],
        r1[0] * result.v1[1] - r1[1] * result.v1[0],
    };
    const double h = norm3(angularMomentum);
    if (!(rMag > 0.0) || !std::isfinite(vMag) || !std::isfinite(h)) return;

    const double energy = 0.5 * vMag * vMag - mu / rMag;
    const double p = h * h / mu;
    double eSquared = 1.0 + 2.0 * energy * h * h / (mu * mu);
    if (!(eSquared > 0.0)) eSquared = 0.0;
    const double e = std::sqrt(eSquared);
    const double rPerigee = p / (1.0 + e);
    if (!std::isfinite(e) || !std::isfinite(rPerigee)) return;

    result.hasTransferConic = true;
    result.transferEccentricity = e;
    result.perigeeRadius = rPerigee;

    const double a = -mu / (2.0 * energy);
    if (energy < 0.0) {
        result.transferConicType = ConicType::ELLIPTIC;
        if (std::isfinite(a)) {
            result.hasTransferSemiMajorAxis = true;
            result.transferSemiMajorAxis = a;
            const double rApogee = a * (1.0 + e);
            if (std::isfinite(rApogee)) {
                result.hasApogeeRadius = true;
                result.apogeeRadius = rApogee;
            }
        } else {
            result.transferConicType = ConicType::PARABOLIC;
        }
    } else if (energy > 0.0) {
        result.transferConicType = ConicType::HYPERBOLIC;
        if (std::isfinite(a)) {
            result.hasTransferSemiMajorAxis = true;
            result.transferSemiMajorAxis = a;
        }
    } else {
        result.transferConicType = ConicType::PARABOLIC;
    }
}

}  // anonymous namespace

LambertResult solveLambert(
    const Vector3& r1, const Vector3& r2, double tof,
    double mu, bool prograde, int nRevs, LambertBranch branch) {

    LambertResult result;
    result.tof = tof;
    result.revolutions = nRevs;
    result.branch = branch;
    result.converged = false;

    if (nRevs < 0 || nRevs > 32) {
        result.status = "invalid-input";
        return result;
    }

    const Vector3 crossR = {
        r1[1] * r2[2] - r1[2] * r2[1],
        r1[2] * r2[0] - r1[0] * r2[2],
        r1[0] * r2[1] - r1[1] * r2[0],
    };
    const bool shortWay = prograde ? (crossR[2] >= 0.0) : (crossR[2] < 0.0);
    const lambert_izzo::Request request{
        toIzzoVector(r1),
        toIzzoVector(r2),
        tof,
        mu,
        !shortWay,
        static_cast<uint16_t>(nRevs),
    };
    const lambert_izzo::Result solved = lambert_izzo::solve(request);
    if (solved.status != lambert_izzo::Status::Ok) {
        switch (solved.status) {
            case lambert_izzo::Status::InvalidInput:
                result.status = "invalid-input";
                break;
            case lambert_izzo::Status::DegenerateGeometry:
                result.status = "degenerate-geometry";
                break;
            default:
                result.status = "no-solution";
                break;
        }
        return result;
    }

    const lambert_izzo::Solution* selected = &solved.single;
    if (nRevs > 0) {
        selected = nullptr;
        for (const auto& pair : solved.multi) {
            if (pair.revolutions != nRevs) continue;
            // The maneuver API follows hapsira's lowpath naming. Izzo's
            // left/right roots are named by period in the standalone record:
            // lowpath is the short-period root and highpath the long-period
            // root for this parameterization.
            selected = branch == LambertBranch::LOW
                           ? &pair.short_period
                           : &pair.long_period;
            break;
        }
        if (selected == nullptr) {
            result.status = "no-solution";
            return result;
        }
    }

    result.v1 = fromIzzoVector(selected->v1);
    result.v2 = fromIzzoVector(selected->v2);
    result.z = selected->x;
    result.iterations = static_cast<int>(selected->iterations);
    result.residual = selected->residual;
    result.residualBudget = 1e-8;
    result.converged =
        std::isfinite(selected->residual) && selected->residual <= result.residualBudget;
    result.status = result.converged ? "converged" : "residual-not-met";
    result.v1Magnitude = norm3(result.v1);
    result.v2Magnitude = norm3(result.v2);
    if (result.converged) fillTransferConic(result, r1, mu);
    return result;
}

LambertResult solveLambertMinDV(
    const Vector3& r1, const Vector3& r2, double tof,
    double mu, bool prograde, int maxRevs,
    bool haveEndpoints, const Vector3& vDepart, const Vector3& vArrive,
    const LambertBranch* restrictBranch) {

    // WHY THIS SIGNATURE CHANGED.
    //
    // 0.1.0 ranked revolution counts by `|v1| + |v2|` — the sum of the TRANSFER
    // SPEEDS, which is not a cost of anything. Minimising it selects an arc for
    // no reason connected to propellant. Real delta-v needs the velocities of
    // the orbits being departed and arrived at, so the caller must state them;
    // without them there is nothing to minimise and this refuses rather than
    // pretending. (The `catch (...)` that used to wrap the loop was dead code
    // in the shipped artifact anyway: exceptions are compiled out, so a trap
    // inside killed the call instead of skipping a revolution count.)
    LambertResult best;
    best.converged = false;
    best.status = "no-solution";
    if (!haveEndpoints) {
        best.status = "endpoint-velocities-required";
        return best;
    }

    // WHY THE LOOP GAINED AN INNER ONE.
    //
    // Every revolution count from 1 up has TWO arcs, and 0.2.0 could only ever
    // see the first — so it minimised over half its own domain and presented
    // the winner as a global answer. The difference is not academic: on Der's
    // Molniya geometry the two one-revolution branches differ by 1.03 km/s in
    // departure speed alone, and there are geometries where the branch 0.2.0
    // could not reach is the cheaper one by a factor of thirty-six.
    //
    // `restrictBranch` narrows the set on an explicit caller request. Absent —
    // the default, and what every existing caller sends — it ranks over
    // everything (graph:
    // modules-maneuver-lambert-multi-rev-exposes-one-branch-of-two).
    std::vector<LambertCandidate> ranked;
    double bestCost = std::numeric_limits<double>::infinity();
    for (int rev = 0; rev >= 0 && rev <= maxRevs; ++rev) {
        // Canonical order: revolutions ascending, LOW before HIGH. At zero
        // revolutions the root is unique, so there is one arc and no branch.
        const LambertBranch branches[2] = {LambertBranch::LOW, LambertBranch::HIGH};
        const int branchCount = (rev == 0) ? 1 : 2;
        for (int b = 0; b < branchCount; ++b) {
            if (rev > 0 && restrictBranch != nullptr && branches[b] != *restrictBranch) {
                continue;
            }
            LambertResult candidate =
                solveLambert(r1, r2, tof, mu, prograde, rev, branches[b]);
            if (!candidate.converged) continue;
            const Vector3 dv1 = sub3(candidate.v1, vDepart);
            const Vector3 dv2 = sub3(vArrive, candidate.v2);
            candidate.dv1 = norm3(dv1);
            candidate.dv2 = norm3(dv2);
            candidate.totalDeltaV = candidate.dv1 + candidate.dv2;
            candidate.dv1_vec = dv1;
            candidate.dv2_vec = dv2;
            candidate.hasDeltaV = true;
            ranked.push_back({rev, branches[b], candidate.dv1, candidate.dv2,
                              candidate.totalDeltaV});
            if (candidate.totalDeltaV < bestCost) {
                bestCost = candidate.totalDeltaV;
                best = candidate;
            }
        }
    }
    // Assigned last: `best` is overwritten wholesale by each new winner, so the
    // candidate set can only be attached once the winner is final.
    best.ranked = ranked;
    return best;
}

}  // namespace maneuver
