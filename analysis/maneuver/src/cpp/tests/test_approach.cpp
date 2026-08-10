#include "maneuver/approach.h"
#include "maneuver/math.h"
#include "maneuver/constants.h"

#include <cassert>
#include <cmath>
#include <iostream>
#include <string>

namespace {

constexpr double TOL = 1e-6;

void assertNear(double actual, double expected, double tol,
                const std::string& label) {
    if (std::abs(actual - expected) > tol) {
        std::cerr << "FAIL [" << label << "]: expected " << expected
                  << ", got " << actual
                  << " (diff=" << std::abs(actual - expected) << ")\n";
        assert(false);
    }
}

maneuver::ClassicalOrbitalElements issChief() {
    maneuver::ClassicalOrbitalElements c;
    c.semiMajorAxis = 6778e3;
    c.eccentricity = 0.001;
    c.inclination = 51.6 * maneuver::DEG_TO_RAD;
    c.raan = 0.0;
    c.argumentOfPerigee = 0.0;
    c.meanAnomaly = 0.0;
    c.gravitationalParameter = maneuver::MU_EARTH;
    c.angularMomentum = std::sqrt(maneuver::MU_EARTH * c.semiMajorAxis *
                                   (1.0 - c.eccentricity * c.eccentricity));
    return c;
}

// ===== V-bar Approach =====

void testVbarApproach() {
    auto chief = issChief();
    maneuver::RelativeState initialState;
    initialState.position = {0.0, -500.0, 0.0};  // 500m behind
    initialState.velocity = {0.0, 0.0, 0.0};

    maneuver::ApproachConfig config;
    config.axis = maneuver::ApproachAxis::V_BAR;
    config.targetPosition = {0.0, 0.0, 0.0};
    config.approachSpeed = 0.1;
    config.safetyCorridorWidth = 50.0;
    config.includeJ2 = true;

    auto result = maneuver::computeApproach(initialState, chief, config);

    std::cout << "  V-bar approach: converged=" << result.leg.converged
              << " totalDV=" << result.leg.totalDeltaV << "m/s"
              << " corridorDev=" << result.corridorDeviation << "m"
              << " withinCorridor=" << result.withinCorridor << "\n";

    assert(result.leg.converged);
    assert(result.leg.totalDeltaV > 0.0);
    assert(result.axis == maneuver::ApproachAxis::V_BAR);
}

// ===== R-bar Approach =====

void testRbarApproach() {
    auto chief = issChief();
    maneuver::RelativeState initialState;
    initialState.position = {-200.0, 0.0, 0.0};  // 200m below
    initialState.velocity = {0.0, 0.0, 0.0};

    maneuver::ApproachConfig config;
    config.axis = maneuver::ApproachAxis::R_BAR;
    config.targetPosition = {0.0, 0.0, 0.0};
    config.approachSpeed = 0.05;
    config.safetyCorridorWidth = 30.0;

    auto result = maneuver::computeApproach(initialState, chief, config);

    std::cout << "  R-bar approach: converged=" << result.leg.converged
              << " totalDV=" << result.leg.totalDeltaV << "m/s"
              << " corridorDev=" << result.corridorDeviation << "m\n";

    assert(result.leg.converged);
    assert(result.axis == maneuver::ApproachAxis::R_BAR);
}

// ===== NMC / Football Orbit =====

void testNMCComputation() {
    auto chief = issChief();

    maneuver::NMCConfig config;
    config.radialAmplitude = 100.0;       // 100m radial
    config.crossTrackAmplitude = 50.0;    // 50m cross-track
    config.phaseAngle = 0.0;

    auto roe = maneuver::computeNMCROE(chief, config);

    // da should be 0 (no drift)
    assertNear(roe.da, 0.0, 1e-15, "nmc_da_zero");

    // dex, dey should give |de| = radialAmplitude / a
    double de_mag = std::sqrt(roe.dex * roe.dex + roe.dey * roe.dey);
    assertNear(de_mag, 100.0 / chief.semiMajorAxis, 1e-15, "nmc_de_mag");

    // dix, diy should give |di| = crossTrackAmplitude / a
    double di_mag = std::sqrt(roe.dix * roe.dix + roe.diy * roe.diy);
    assertNear(di_mag, 50.0 / chief.semiMajorAxis, 1e-15, "nmc_di_mag");

    std::cout << "  NMC ROE computed: de=" << de_mag << " di=" << di_mag << "\n";
}

void testNMCTrajectory() {
    auto chief = issChief();

    maneuver::NMCConfig config;
    config.radialAmplitude = 200.0;
    config.crossTrackAmplitude = 100.0;

    auto trajectory = maneuver::generateNMCTrajectory(chief, config, 1, 36);

    assert(trajectory.size() == 37);  // 36 points + initial
    assert(trajectory[0].time == 0.0);

    // Trajectory should be bounded (football orbit)
    double maxR = 0.0, maxI = 0.0, maxC = 0.0;
    for (const auto& pt : trajectory) {
        maxR = std::max(maxR, std::abs(pt.position[0]));
        maxI = std::max(maxI, std::abs(pt.position[1]));
        maxC = std::max(maxC, std::abs(pt.position[2]));
    }

    std::cout << "  NMC trajectory: maxR=" << maxR
              << " maxI=" << maxI << " maxC=" << maxC << "\n";

    // Radial should be ~200m, in-track ~400m (2:1), cross-track ~100m
    assert(maxR > 50.0 && maxR < 500.0);
    assert(maxI > 100.0 && maxI < 1000.0);
}

// ===== CAM =====

void testCAMAlreadySafe() {
    auto chief = issChief();
    maneuver::RelativeState state;
    state.position = {5000.0, 0.0, 0.0};  // 5km away
    state.velocity = {0.0, 0.0, 0.0};

    maneuver::CAMConfig config;
    config.minMissDistance = 1000.0;
    config.timeToTCA = 3600.0;

    auto result = maneuver::computeCAM(state, chief, config);

    assert(result.feasible);
    assertNear(result.magnitude, 0.0, 1e-10, "cam_already_safe");
    std::cout << "  CAM (already safe): dv=0 ✓\n";
}

void testCAMRequired() {
    auto chief = issChief();
    maneuver::RelativeState state;
    state.position = {100.0, 0.0, 0.0};  // 100m, dangerously close
    state.velocity = {0.0, 0.0, 0.0};

    maneuver::CAMConfig config;
    config.minMissDistance = 1000.0;
    config.timeToTCA = 3600.0;
    config.maxDeltaV = 10.0;

    auto result = maneuver::computeCAM(state, chief, config);

    assert(result.magnitude > 0.0);
    assert(result.achievedMiss >= config.minMissDistance - 1.0);

    std::cout << "  CAM (required): dv=" << result.magnitude
              << "m/s achievedMiss=" << result.achievedMiss
              << "m feasible=" << result.feasible << "\n";
}

// ===== Phasing =====

void testPhasingManeuver() {
    double r = maneuver::R_EARTH + 400e3;  // ISS altitude
    double phaseAngle = 10.0 * maneuver::DEG_TO_RAD;  // 10 degrees ahead

    auto result = maneuver::computePhasingManeuver(r, phaseAngle, 1);

    assert(result.totalDeltaV > 0.0);
    assert(result.phasingSMA > 0.0);
    assert(result.phasingSMA < r);  // Lower orbit (faster) to get ahead
    assert(result.numRevs == 1);

    std::cout << "  Phasing (10deg, 1rev): dv=" << result.totalDeltaV
              << "m/s phasingSMA=" << result.phasingSMA / 1e3
              << "km time=" << result.totalTime / 3600.0 << "h\n";

    // Multi-rev should use less dv
    auto result3 = maneuver::computePhasingManeuver(r, phaseAngle, 3);
    assert(result3.totalDeltaV < result.totalDeltaV);

    std::cout << "  Phasing (10deg, 3rev): dv=" << result3.totalDeltaV
              << "m/s (less than 1-rev ✓)\n";
}

// ===== Phasing derived from a target spacecraft =====

maneuver::ClassicalOrbitalElements coOrbital(double meanArgumentOfLatitude,
                                             double argumentOfPerigee = 0.0,
                                             double raan = 40.0 *
                                                           maneuver::DEG_TO_RAD) {
    maneuver::ClassicalOrbitalElements oe;
    oe.semiMajorAxis = 6778137.0;
    oe.eccentricity = 0.0;
    oe.inclination = 51.6 * maneuver::DEG_TO_RAD;
    oe.raan = raan;
    oe.argumentOfPerigee = argumentOfPerigee;
    oe.meanAnomaly = meanArgumentOfLatitude - argumentOfPerigee;
    oe.gravitationalParameter = maneuver::MU_EARTH;
    oe.angularMomentum = std::sqrt(maneuver::MU_EARTH * oe.semiMajorAxis);
    return oe;
}

/// The op must reproduce the FROZEN `phasingManeuver` conformance numbers when
/// it is handed a pair whose separation is the same 30 degrees, with the same
/// radius and the same revolution count. This is what ties the derived angle
/// to a solution the vectors already pin.
void testPhasingFromTargetStateMatchesTheTypedAngle() {
    const double d2r = maneuver::DEG_TO_RAD;
    const auto chaser = coOrbital(10.0 * d2r);
    const auto target = coOrbital(40.0 * d2r);

    maneuver::PhasingFromStateOptions options;
    options.numRevs = 3;
    const auto derived = maneuver::computePhasingFromTargetState(chaser, target, options);
    const auto typed = maneuver::computePhasingManeuver(
        6778137.0, 30.0 * d2r, 3, maneuver::MU_EARTH);

    assertNear(derived.geometry.relativePhaseAngle, 30.0 * d2r, 1e-12,
               "from_state_angle");
    assertNear(derived.plan.dv1, typed.dv1, 0.0, "from_state_dv1_exact");
    assertNear(derived.plan.dv2, typed.dv2, 0.0, "from_state_dv2_exact");
    assertNear(derived.plan.totalDeltaV, typed.totalDeltaV, 0.0,
               "from_state_total_exact");
    assertNear(derived.plan.phasingSMA, typed.phasingSMA, 0.0,
               "from_state_sma_exact");
    assert(derived.revsFromCaller);
    assert(derived.coplanar);
    assert(derived.nearCircular);
    assert(derived.coOrbital);
    assertNear(derived.phasingRadius, 6778137.0, 0.0, "from_state_radius");

    std::cout << "  Phasing from state (+30deg, 3rev): dv="
              << derived.plan.totalDeltaV << "m/s == typed "
              << typed.totalDeltaV << "m/s\n";
}

/// CATCH S/C and FALL BEHIND are different cards and must be different
/// answers. Forcing the long way round must cost more and must not be
/// silently replaced by the short one.
void testPhasingFromTargetStateHonoursBothDirections() {
    const double d2r = maneuver::DEG_TO_RAD;
    const auto chaser = coOrbital(10.0 * d2r);
    const auto target = coOrbital(40.0 * d2r);   // target leads by 30 degrees

    maneuver::PhasingFromStateOptions options;
    options.numRevs = 3;

    options.direction = maneuver::PhasingDirection::CATCH_UP;
    const auto catchUp = maneuver::computePhasingFromTargetState(chaser, target, options);
    options.direction = maneuver::PhasingDirection::FALL_BEHIND;
    const auto fallBehind = maneuver::computePhasingFromTargetState(chaser, target, options);

    assertNear(catchUp.plan.phaseAngle, 30.0 * d2r, 1e-12, "direction_catch_up");
    assertNear(fallBehind.plan.phaseAngle, -330.0 * d2r, 1e-12,
               "direction_fall_behind");
    // Catching up drops to a LOWER orbit; falling behind rises to a higher one.
    assert(catchUp.plan.phasingSMA < 6778137.0);
    assert(fallBehind.plan.phasingSMA > 6778137.0);
    // Going the long way round is the expensive way.
    assert(fallBehind.plan.totalDeltaV > catchUp.plan.totalDeltaV);
    // BOTH summaries are present under either direction, and they agree with
    // the plans the two forced runs produced.
    assertNear(catchUp.fallBehind.totalDeltaV, fallBehind.plan.totalDeltaV, 0.0,
               "summary_matches_forced_fall_behind");
    assertNear(fallBehind.catchUp.totalDeltaV, catchUp.plan.totalDeltaV, 0.0,
               "summary_matches_forced_catch_up");

    std::cout << "  Directions (3rev): catchUp=" << catchUp.plan.totalDeltaV
              << "m/s fallBehind=" << fallBehind.plan.totalDeltaV << "m/s\n";
}

/// The revolution count is the knob that trades time for delta-v. Asked for a
/// separation that one revolution cannot buy without flying through the Earth,
/// the recommendation must climb until the plan is both unclamped and inside
/// the budget.
void testPhasingFromTargetStateRecommendsRevolutions() {
    const double d2r = maneuver::DEG_TO_RAD;
    const auto chaser = coOrbital(0.0);
    const auto target = coOrbital(170.0 * d2r);

    const auto one = maneuver::computePhasingManeuver(6778137.0, 170.0 * d2r, 1,
                                                      maneuver::MU_EARTH);
    assert(one.clampedToEarthFloor);  // the premise of the test

    const auto derived = maneuver::computePhasingFromTargetState(chaser, target);
    assert(!derived.revsFromCaller);
    assert(derived.recommendedRevs > 1);
    assert(!derived.plan.clampedToEarthFloor);
    assert(derived.metDeltaVBudget);
    assert(derived.plan.totalDeltaV <= derived.deltaVBudget);
    // The recommendation is the SMALLEST count that qualifies: one fewer must
    // fail one of the two conditions.
    const auto justBelow = maneuver::computePhasingManeuver(
        6778137.0, 170.0 * d2r, derived.recommendedRevs - 1, maneuver::MU_EARTH);
    assert(justBelow.clampedToEarthFloor ||
           justBelow.totalDeltaV > derived.deltaVBudget);

    std::cout << "  Recommendation (+170deg): revs=" << derived.recommendedRevs
              << " dv=" << derived.plan.totalDeltaV << "m/s budget="
              << derived.deltaVBudget << "m/s\n";
}

/// A target in another plane is not a phasing problem, and the operation says
/// so rather than answering as if it were.
void testPhasingFromTargetStateReportsNonCoplanar() {
    const double d2r = maneuver::DEG_TO_RAD;
    auto chaser = coOrbital(10.0 * d2r);
    chaser.inclination = 97.4 * d2r;   // the polar DROID of the owner report
    const auto target = coOrbital(40.0 * d2r);  // 51.6 degrees

    const auto derived = maneuver::computePhasingFromTargetState(chaser, target);
    assert(!derived.coplanar);
    assertNear(derived.geometry.inclinationDifference, -45.8 * d2r, 1e-12,
               "non_coplanar_inclination_difference");
    assert(derived.geometry.planeAngle > 45.0 * d2r);
    // It still ANSWERS — a refusal here would deny the composed rendezvous its
    // stage 2 after the plane change has already been planned.
    assert(derived.plan.totalDeltaV > 0.0);

    std::cout << "  Non-coplanar: planeAngle="
              << derived.geometry.planeAngle * maneuver::RAD_TO_DEG << "deg\n";
}

/// maxRevs is CLAMPED, never trapped on, and the clamp is reported.
void testPhasingFromTargetStateClampsMaxRevs() {
    const double d2r = maneuver::DEG_TO_RAD;
    const auto chaser = coOrbital(0.0);
    const auto target = coOrbital(1.0 * d2r);

    maneuver::PhasingFromStateOptions options;
    options.maxRevs = 2000000000;
    const auto derived = maneuver::computePhasingFromTargetState(chaser, target, options);
    assert(derived.maxRevsApplied == maneuver::kMaxPhasingRevs);
    assert(derived.recommendedRevs >= 1);

    maneuver::PhasingFromStateOptions floor;
    floor.maxRevs = -5;
    const auto low = maneuver::computePhasingFromTargetState(chaser, target, floor);
    assert(low.maxRevsApplied == 1);
}

/// Two craft at the same place is a zero-delta-v answer, not a singularity.
void testPhasingFromTargetStateCoLocated() {
    const auto chaser = coOrbital(1.0);
    const auto target = coOrbital(1.0);
    const auto derived = maneuver::computePhasingFromTargetState(chaser, target);
    assertNear(derived.geometry.relativePhaseAngle, 0.0, 1e-12, "co_located_angle");
    assertNear(derived.plan.totalDeltaV, 0.0, 1e-9, "co_located_dv");
    assert(derived.recommendedRevs == 1);
    // Both named directions are a full lap, which is the truth.
    assertNear(derived.geometry.catchUpAngle, 2.0 * M_PI, 1e-12, "co_located_catch_up");
    assertNear(derived.geometry.fallBehindAngle, -2.0 * M_PI, 1e-12,
               "co_located_fall_behind");
}

// ===== Plane Change =====

void testPlaneChange() {
    double r = maneuver::R_EARTH + 400e3;
    double v = std::sqrt(maneuver::MU_EARTH / r);
    double di = 1.0 * maneuver::DEG_TO_RAD;  // 1 degree

    auto result = maneuver::computePlaneChange(r, v, di);

    // For small angles: dv ≈ v * di
    double expected = v * std::abs(di);
    assertNear(result.dv, expected, 10.0, "plane_change_1deg");

    // Should be purely cross-track
    assertNear(result.dv_ric[0], 0.0, TOL, "plane_change_radial");
    assertNear(result.dv_ric[1], 0.0, TOL, "plane_change_intrack");
    assert(std::abs(result.dv_ric[2]) > 0.0);

    std::cout << "  Plane change (1deg): dv=" << result.dv
              << "m/s (expected ~" << expected << ")\n";
}

void testCombinedManeuver() {
    double r1 = maneuver::R_EARTH + 400e3;
    double r2 = maneuver::R_EARTH + 35786e3;
    double di = 28.5 * maneuver::DEG_TO_RAD;  // typical LEO→GEO inclination change

    auto result = maneuver::computeCombinedManeuver(r1, r2, di);

    // Combined should be less than Hohmann + separate plane change
    auto hohmann = maneuver::computeHohmannTransfer(r1, r2);
    double v_geo = std::sqrt(maneuver::MU_EARTH / r2);
    double separate_plane_dv = 2.0 * v_geo * std::sin(di / 2.0);
    double separate_total = hohmann.totalDeltaV + separate_plane_dv;

    std::cout << "  Combined (LEO→GEO+28.5deg): total=" << result.totalDeltaV
              << "m/s (separate=" << separate_total << "m/s, saves "
              << separate_total - result.totalDeltaV << "m/s)\n";

    assert(result.totalDeltaV < separate_total);
}

// ===== Lambert Solver =====

void testLambertSimple() {
    // Simple test: LEO to LEO, 180 degree transfer (should match Hohmann)
    double r = maneuver::R_EARTH + 400e3;

    maneuver::Vector3 r1 = {r, 0.0, 0.0};
    maneuver::Vector3 r2 = {-r, 0.0, 0.0};

    // TOF for 180-degree transfer at this altitude
    double a_transfer = r;  // circular orbit
    double tof = M_PI * std::sqrt(r * r * r / maneuver::MU_EARTH);

    auto result = maneuver::solveLambert(r1, r2, tof, maneuver::MU_EARTH, true, 0);

    // EXACTLY 180 degrees has no unique Lambert solution: r1 and r2 are
    // antiparallel, so every plane containing the line is a valid transfer
    // plane and the orbit is not determined by the boundary conditions. The
    // universal-variable formulation says so algebraically — A = sin(dtheta) *
    // sqrt(...) is identically zero — and the honest answer is a refusal.
    //
    // 0.1.0 answered `converged: true` here, which is what this assertion used
    // to check. It was checking that the solver lied.
    assert(!result.converged);
    assert(std::string(result.status) == "degenerate-geometry");
    std::cout << "  Lambert (180deg): correctly refused, status=" << result.status
              << "\n";
}

void testLambertEarthMars() {
    // Earth to Mars positions (simplified, coplanar)
    double r_earth = 1.496e11;  // 1 AU
    double r_mars = 2.279e11;

    maneuver::Vector3 r1 = {r_earth, 0.0, 0.0};
    // Mars at ~44 degrees ahead (typical for Hohmann window)
    double theta = 44.0 * maneuver::DEG_TO_RAD;
    maneuver::Vector3 r2 = {r_mars * std::cos(M_PI + theta),
                            r_mars * std::sin(M_PI + theta), 0.0};

    // ~259 day transfer
    double tof = 259.0 * maneuver::SECONDS_PER_DAY;

    auto result = maneuver::solveLambert(r1, r2, tof, maneuver::MU_SUN, true, 0);

    std::cout << "  Lambert (Earth→Mars): v1=" << maneuver::norm3(result.v1) / 1e3
              << "km/s v2=" << maneuver::norm3(result.v2) / 1e3
              << "km/s converged=" << result.converged << "\n";

    assert(result.converged);
}

}  // namespace

int main() {
    std::cout << "=== test_approach ===\n";
    testVbarApproach();
    testRbarApproach();
    testNMCComputation();
    testNMCTrajectory();
    testCAMAlreadySafe();
    testCAMRequired();
    testPhasingManeuver();
    testPhasingFromTargetStateMatchesTheTypedAngle();
    testPhasingFromTargetStateHonoursBothDirections();
    testPhasingFromTargetStateRecommendsRevolutions();
    testPhasingFromTargetStateReportsNonCoplanar();
    testPhasingFromTargetStateClampsMaxRevs();
    testPhasingFromTargetStateCoLocated();
    testPlaneChange();
    testCombinedManeuver();
    testLambertSimple();
    testLambertEarthMars();
    std::cout << "All approach/maneuver tests passed.\n";
    return 0;
}
