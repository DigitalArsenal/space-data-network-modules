#include "maneuver/approach.h"
#include "maneuver/constants.h"
#include "maneuver/fault.h"
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

    return {std::abs(dv1), dv2,
            std::abs(dv1) + dv2,
            tof, aTransfer,
            {0.0, dv1, 0.0},
            {0.0, dv2_I, dv2_C}};
}

// ===========================================================================
// Lambert Solver — Bate-Mueller-White / Curtis Algorithm 5.2 universal variable
//
// 0.1.0's version of this function was section-headed "Izzo's method" (it is
// not Izzo's) and returned departure velocities that do not fly from r1 to r2,
// while reporting `converged: true` on every path — 50 of 52 sampled prograde
// LEO geometries plus every hyperbolic, retrograde and near-pi case
// (graph: modules-maneuver-lambert-returns-non-solutions). Four things were
// wrong and all four are fixed here:
//
//   1. The small-|z| derivative was (sqrt(2)/40)*y^3.5 where BMW/Curtis give
//      y^1.5. At y ~ 1e7 that is too large by y^2 ~ 1e14, so the Newton step
//      out of the z = 0 start was effectively zero and the solver returned its
//      starting guess.
//   2. The z != 0 derivative was also not the Curtis expression.
//   3. `converged` was the literal `true`, assigned on every path including
//      MAX_ITER exhaustion and the y < 0 bail-out.
//   4. The residual was never re-evaluated after the loop.
//
// Two conditioning choices here are not in the textbook and are load-bearing:
//
//   * The transfer angle's sine comes from |r1 x r2| and its "1 - cos" from a
//     unit-vector CHORD, never from sin(acos(.)). acos has an infinite
//     derivative at +-1, which is exactly the near-pi geometry the solver has
//     to survive; going through it costs five orders of magnitude of arrival
//     accuracy on Tudat's 179.999-degree case (4.5e-6 -> 3.0e-11 of |r2|).
//   * The root is BRACKETED and then found by Newton safeguarded with
//     bisection, rather than by unguarded Newton from a fixed start. F(z) is
//     monotone on the zero-revolution branch, so the bracket is exact; a
//     multi-revolution branch is not monotone and is scanned instead. This is
//     also what makes "no solution" a REPORTABLE answer rather than a silent
//     wrong one: a geometry with no N-revolution arc returns converged=false.
// ===========================================================================

namespace {

// Stumpff functions. The near-zero branches are SERIES, not constants: the
// 0.1.0 code returned the leading term only (1/6, 1/120 — themselves the
// z -> 0 limits of the OTHER function), which is both wrong by a factor of 3
// and non-continuous with the branches on either side.
double stumpffC(double z) {
    if (z > 1e-6) {
        return (1.0 - std::cos(std::sqrt(z))) / z;
    }
    if (z < -1e-6) {
        return (std::cosh(std::sqrt(-z)) - 1.0) / (-z);
    }
    return 0.5 - z / 24.0 + (z * z) / 720.0 - (z * z * z) / 40320.0;
}

double stumpffS(double z) {
    if (z > 1e-6) {
        const double s = std::sqrt(z);
        return (s - std::sin(s)) / (s * s * s);
    }
    if (z < -1e-6) {
        const double s = std::sqrt(-z);
        return (std::sinh(s) - s) / (s * s * s);
    }
    return 1.0 / 6.0 - z / 120.0 + (z * z) / 5040.0 - (z * z * z) / 362880.0;
}

// Cross product for 3-vectors
Vector3 lambertCross3(const Vector3& a, const Vector3& b) {
    return {a[1]*b[2] - a[2]*b[1],
            a[2]*b[0] - a[0]*b[2],
            a[0]*b[1] - a[1]*b[0]};
}

// Scale a 3-vector
Vector3 lambertScale3(const Vector3& v, double s) {
    return {v[0]*s, v[1]*s, v[2]*s};
}

/// The universal-variable problem for one (geometry, tof) pair.
struct LambertProblem {
    double r1n = 0.0;
    double r2n = 0.0;
    double A = 0.0;
    double sqrtMu = 0.0;
    double tof = 0.0;

    double y(double z) const {
        const double C = stumpffC(z);
        if (!(C > 0.0)) return -1.0;
        return r1n + r2n + A * (z * stumpffS(z) - 1.0) / std::sqrt(C);
    }

    /// F(z) = (y/C)^1.5 * S + A*sqrt(y) - sqrt(mu)*tof. Zero at the solution.
    /// Returns NaN outside the domain (y <= 0) so callers can treat "no value
    /// here" and "value with the wrong sign" differently.
    double F(double z) const {
        const double C = stumpffC(z);
        const double S = stumpffS(z);
        if (!(C > 0.0)) return std::numeric_limits<double>::quiet_NaN();
        const double yy = r1n + r2n + A * (z * S - 1.0) / std::sqrt(C);
        if (!(yy > 0.0)) return std::numeric_limits<double>::quiet_NaN();
        return std::pow(yy / C, 1.5) * S + A * std::sqrt(yy) - sqrtMu * tof;
    }

    /// dF/dz, Curtis eq. 5.43. Both branches, both correct.
    double dF(double z) const {
        const double C = stumpffC(z);
        const double S = stumpffS(z);
        const double yy = y(z);
        if (!(yy > 0.0) || !(C > 0.0)) {
            return std::numeric_limits<double>::quiet_NaN();
        }
        if (std::abs(z) < 1e-6) {
            return (std::sqrt(2.0) / 40.0) * std::pow(yy, 1.5) +
                   (A / 8.0) * (std::sqrt(yy) + A * std::sqrt(1.0 / (2.0 * yy)));
        }
        return std::pow(yy / C, 1.5) *
                   ((1.0 / (2.0 * z)) * (C - 3.0 * S / (2.0 * C)) +
                    3.0 * S * S / (4.0 * C)) +
               (A / 8.0) * (3.0 * S * std::sqrt(yy) / C + A * std::sqrt(C / yy));
    }
};

constexpr int LAMBERT_MAX_ITER = 200;
/// Residual gate, relative to the natural scale of F (which carries units of
/// sqrt(mu)*time). This is what `converged` now MEANS.
constexpr double LAMBERT_RESIDUAL_TOL = 1e-10;

/// Fill the transfer arc's conic block from the departure state the solve just
/// produced. Three lines of textbook algebra over quantities already in hand;
/// see the block comment on LambertResult for why the module owes a caller
/// this rather than a refusal.
///
/// The eccentricity comes from `e^2 = 1 + 2 E h^2 / mu^2`, which is finite and
/// correct for every conic INCLUDING the parabolic limit — unlike any form that
/// divides by `1 - e^2`. The perigee comes from `p / (1 + e)`, which is well
/// conditioned everywhere; only the apoapsis and the semi-major axis can fail
/// to exist, and each says so with its own flag instead of emitting a
/// non-finite number the JSON writer would have to reject.
void fillTransferConic(LambertResult& result, const Vector3& r1, double mu) {
    const double rMag = norm3(r1);
    const double vMag = norm3(result.v1);
    const double h = norm3(lambertCross3(r1, result.v1));
    if (!(rMag > 0.0) || !std::isfinite(vMag) || !std::isfinite(h)) return;

    const double energy = 0.5 * vMag * vMag - mu / rMag;
    const double p = h * h / mu;
    double eSquared = 1.0 + 2.0 * energy * h * h / (mu * mu);
    if (!(eSquared > 0.0)) eSquared = 0.0;  // round-off below a circular arc
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
            // A bound arc so nearly parabolic that its semi-major axis
            // overflows a double. It has an apoapsis in principle and no
            // representable one in fact; saying nothing is the only honest
            // answer, and `transferConicType` still tells the caller which
            // conic it is looking at.
            result.transferConicType = ConicType::PARABOLIC;
        }
    } else if (energy > 0.0) {
        result.transferConicType = ConicType::HYPERBOLIC;
        if (std::isfinite(a)) {
            result.hasTransferSemiMajorAxis = true;
            result.transferSemiMajorAxis = a;  // negative, by construction
        }
        // No apoapsis: the arc never returns.
    } else {
        // Exactly parabolic. `a` is infinite and there is no apoapsis.
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

    const double r1_mag = norm3(r1);
    const double r2_mag = norm3(r2);
    if (!(r1_mag > 0.0) || !(r2_mag > 0.0) || !(mu > 0.0) || !(tof > 0.0) ||
        nRevs < 0) {
        result.status = "invalid-input";
        return result;
    }

    // Unit position vectors: every angular quantity below is derived from
    // these, which is what keeps the near-pi geometry conditioned.
    const Vector3 u1 = lambertScale3(r1, 1.0 / r1_mag);
    const Vector3 u2 = lambertScale3(r2, 1.0 / r2_mag);
    double cosdt = u1[0]*u2[0] + u1[1]*u2[1] + u1[2]*u2[2];
    cosdt = std::max(-1.0, std::min(1.0, cosdt));

    // 1 - cos, taken from whichever half-angle chord keeps full precision:
    // |u1 - u2|^2 = 2(1 - cos) is accurate for SMALL angles, |u1 + u2|^2 =
    // 2(1 + cos) for angles near pi. Computing 1 - cos directly loses the
    // significant digits at exactly the ends where the solver is hardest.
    const Vector3 chordMinus = sub3(u1, u2);
    const Vector3 chordPlus = {u1[0]+u2[0], u1[1]+u2[1], u1[2]+u2[2]};
    const double dMinus = norm3(chordMinus);
    const double dPlus = norm3(chordPlus);
    const double oneMinusCos =
        (cosdt > 0.0) ? (dMinus * dMinus) / 2.0 : 2.0 - (dPlus * dPlus) / 2.0;

    // |sin| from the cross product, NEVER from sin(acos(cos)).
    const Vector3 crossU = lambertCross3(u1, u2);
    const double sinMag = norm3(crossU);
    // Direction: the "short way" is the one whose angular momentum agrees with
    // the requested sense. r1 x r2 pointing +z is a prograde (counterclockwise)
    // sweep of less than pi.
    const Vector3 crossR = lambertCross3(r1, r2);
    const bool shortWay = prograde ? (crossR[2] >= 0.0) : (crossR[2] < 0.0);
    const double sindt = shortWay ? sinMag : -sinMag;

    if (!(oneMinusCos > 0.0)) {
        // r1 and r2 are collinear and same-sense: the transfer plane is
        // undefined. This is a real "no solution", not a failure to find one.
        result.status = "degenerate-geometry";
        return result;
    }

    LambertProblem problem;
    problem.r1n = r1_mag;
    problem.r2n = r2_mag;
    problem.A = sindt * std::sqrt(r1_mag * r2_mag / oneMinusCos);
    problem.sqrtMu = std::sqrt(mu);
    problem.tof = tof;

    if (!(std::abs(problem.A) > 0.0)) {
        result.status = "degenerate-geometry";
        return result;
    }

    // -----------------------------------------------------------------------
    // Bracket the root.
    // -----------------------------------------------------------------------
    const double zCeiling = TWO_PI * (nRevs + 1) * TWO_PI * (nRevs + 1);
    double a = 0.0;
    double b = 0.0;
    double fa = 0.0;
    bool bracketed = false;

    if (nRevs == 0) {
        // The zero-revolution branch is monotone in z (tof -> 0 as z -> -inf,
        // tof -> +inf as z -> (2*pi)^2), so MARCH from z = 0 in the direction
        // F(0) points instead of scanning. Scanning a huge interval is not
        // merely slower: at z ~ -1500 the two terms of F are each ~1e14 and
        // cancel to pure round-off, and a scan over that region brackets noise.
        double z0 = 0.0;
        double f0 = problem.F(0.0);
        if (!std::isfinite(f0)) {
            // y(0) < 0: climb until the domain opens.
            for (int guard = 0; guard < 4000 && !std::isfinite(f0); ++guard) {
                z0 += 0.05 * zCeiling;
                if (z0 >= zCeiling) break;
                f0 = problem.F(z0);
            }
            if (!std::isfinite(f0)) {
                result.status = "empty-domain";
                return result;
            }
        }
        if (f0 <= 0.0) {
            a = z0;
            fa = f0;
            for (int i = 0; i < 200; ++i) {
                const double hi = zCeiling - (zCeiling - z0) * std::pow(0.5, i + 1);
                const double f = problem.F(hi);
                if (std::isfinite(f) && f > 0.0) {
                    b = hi;
                    bracketed = true;
                    break;
                }
            }
        } else {
            // -----------------------------------------------------------
            // MARCHING DOWN, WITH THE DOMAIN BOUNDARY RESPECTED.
            //
            // Below z0 the branch runs out: `y(z)` decreases monotonically
            // and at some `z_boundary` it reaches zero, past which `F` has no
            // value at all. The root, when there is one, lies strictly
            // between that boundary and z0 — as `y -> 0+`, `F -> -sqrt(mu)*tof`,
            // which is negative, so a positive `F(z0)` guarantees a crossing
            // inside the domain.
            //
            // 0.2.0 marched `step = 1, 2, 4, ...` and gave up the moment a
            // probe came back non-finite, which is a probe that landed OUTSIDE
            // the domain rather than one that proved anything. For Curtis
            // example 5.3 the boundary is at z = -0.398 and the root at
            // z = -0.173, so the very first probe at z = -1 fell off the end
            // and every later one fell further, and a geometry hapsira solves
            // came back `no-solution` (graph:
            // modules-maneuver-lambert-refuses-a-solvable-arc). The class lost
            // was short-transfer-angle hyperbolic arcs — the ones whose domain
            // boundary sits close to zero — and it was large: of 3,320
            // forward-constructed hyperbolic arcs, 1,544 were refused.
            //
            // The repair keeps a BRACKET IN STEP SPACE. `stepInside` is the
            // deepest step known to land inside the domain and `stepOutside`
            // the shallowest known to land outside; a non-finite probe
            // bisects toward the boundary instead of doubling away from it,
            // and a finite-but-still-positive probe doubles outward exactly as
            // before while no boundary is known. That makes the search
            // converge ON the boundary rather than stepping over it, and it is
            // a repair to the SEARCH only: every expression evaluated here is
            // unchanged, the bracket handed to Newton has the same meaning,
            // and a geometry 0.2.0 solved is solved identically (verified over
            // the 72-geometry LEO sweep and every Lambert vector).
            //
            // NOT the 0.1.0 `if (y < 0) { z += 0.1; continue; }` recovery,
            // which walked the wrong way for hyperbolic arcs and was one of the
            // four defects modules-maneuver-lambert-returns-non-solutions
            // closed.
            // -----------------------------------------------------------
            b = z0;
            double stepInside = 0.0;
            double stepOutside = std::numeric_limits<double>::infinity();
            double step = std::max(1.0, std::abs(z0));
            for (int i = 0; i < 200; ++i) {
                const double lo = z0 - step;
                const double f = problem.F(lo);
                if (std::isfinite(f)) {
                    if (f < 0.0) {
                        a = lo;
                        fa = f;
                        bracketed = true;
                        break;
                    }
                    // Inside the domain and still above the root: go deeper.
                    stepInside = step;
                    if (std::isfinite(stepOutside)) {
                        step = 0.5 * (stepInside + stepOutside);
                    } else if (step >= 1e6) {
                        // No boundary found within the conditioning limit and
                        // no sign change either. Beyond this the two terms of F
                        // are ~1e14 apiece and cancel to round-off, so a probe
                        // there brackets noise rather than a root.
                        break;
                    } else {
                        step = std::min(step * 2.0, 1e6);
                    }
                } else {
                    // Outside the domain. The boundary — and with it the root
                    // — is shallower than this.
                    stepOutside = step;
                    step = 0.5 * (stepInside + stepOutside);
                }
                if (!(step > stepInside) || step >= stepOutside) break;
            }
        }
    } else {
        // A multi-revolution branch lives on ((2*pi*N)^2, (2*pi*(N+1))^2) and
        // is NOT monotone there — it dips to a minimum and rises, so a given
        // tof has TWO solutions or none. The interval is bounded and
        // well-conditioned, so scan it and take the crossing the caller asked
        // for: the first (LOW, the default and 0.2.0's only answer) or the
        // second (HIGH).
        //
        // Crossings are counted by SIGN CLASSIFICATION rather than by the
        // product `prevF * f <= 0`, which double-counts a scan node that lands
        // exactly on the root — harmless when the loop stopped at the first
        // crossing, and an off-by-one in the branch index now that it does not.
        const double zFloor = TWO_PI * nRevs * TWO_PI * nRevs;
        constexpr int SCAN = 2048;
        const int wanted = (branch == LambertBranch::HIGH) ? 2 : 1;
        int seen = 0;
        double prevZ = zFloor;
        double prevF = problem.F(zFloor);
        for (int i = 1; i <= SCAN; ++i) {
            const double z = zFloor + (zCeiling - zFloor) * i / SCAN;
            const double f = problem.F(z);
            if (std::isfinite(prevF) && std::isfinite(f) &&
                ((prevF < 0.0) != (f < 0.0))) {
                ++seen;
                if (seen == wanted) {
                    a = prevZ;
                    b = z;
                    fa = prevF;
                    bracketed = true;
                    break;
                }
            }
            prevZ = z;
            prevF = f;
        }
    }

    if (!bracketed) {
        // There is no arc of this revolution count that flies this geometry in
        // this time. Saying so is the whole point of this task.
        result.status = "no-solution";
        return result;
    }

    // -----------------------------------------------------------------------
    // Safeguarded Newton: take the Newton step when it stays inside the
    // bracket, bisect when it does not. Cannot diverge, cannot leave the
    // domain, and terminates.
    // -----------------------------------------------------------------------
    double z = 0.5 * (a + b);
    int iterations = 0;
    for (; iterations < LAMBERT_MAX_ITER; ++iterations) {
        const double f = problem.F(z);
        if (!std::isfinite(f)) {
            z = 0.5 * (a + b);
            continue;
        }
        if (f * fa > 0.0) {
            a = z;
            fa = f;
        } else {
            b = z;
        }
        const double df = problem.dF(z);
        double next = (std::isfinite(df) && df != 0.0) ? z - f / df
                                                       : std::numeric_limits<double>::quiet_NaN();
        const double lo = std::min(a, b);
        const double hi = std::max(a, b);
        if (!std::isfinite(next) || next <= lo || next >= hi) {
            next = 0.5 * (a + b);
        }
        const double step = std::abs(next - z);
        z = next;
        if (step <= 1e-14 * std::max(1.0, std::abs(z))) {
            ++iterations;
            break;
        }
    }

    const double y = problem.y(z);
    const double residual = std::abs(problem.F(z));
    const double budget = LAMBERT_RESIDUAL_TOL * problem.sqrtMu * std::abs(tof);

    if (!(y > 0.0) || !std::isfinite(residual)) {
        result.status = "empty-domain";
        return result;
    }

    const double f_lagrange = 1.0 - y / r1_mag;
    const double g_dot = 1.0 - y / r2_mag;
    const double g = problem.A * std::sqrt(y / mu);
    if (!std::isfinite(g) || g == 0.0) {
        result.status = "degenerate-geometry";
        return result;
    }

    const Vector3 v1_vec = lambertScale3(sub3(r2, lambertScale3(r1, f_lagrange)), 1.0 / g);
    const Vector3 v2_vec = lambertScale3(sub3(lambertScale3(r2, g_dot), r1), 1.0 / g);
    if (!std::isfinite(v1_vec[0]) || !std::isfinite(v1_vec[1]) ||
        !std::isfinite(v1_vec[2]) || !std::isfinite(v2_vec[0]) ||
        !std::isfinite(v2_vec[1]) || !std::isfinite(v2_vec[2])) {
        result.status = "non-finite-solution";
        return result;
    }

    result.v1 = v1_vec;
    result.v2 = v2_vec;
    result.z = z;
    result.iterations = iterations;
    result.residual = residual;
    result.residualBudget = budget;
    // `converged` is now a MEASUREMENT, not a literal.
    result.converged = residual <= budget;
    result.status = result.converged ? "converged" : "residual-not-met";
    result.v1Magnitude = norm3(v1_vec);
    result.v2Magnitude = norm3(v2_vec);
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
