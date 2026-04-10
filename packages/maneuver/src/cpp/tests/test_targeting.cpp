#include "maneuver/targeting.h"
#include "maneuver/transforms.h"
#include "maneuver/propagation.h"
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

// ===== Control Matrix =====

void testControlMatrixStructure() {
    auto chief = issChief();
    auto B = maneuver::computeControlMatrix(chief);

    // Row 0: da only from in-track (col 1)
    assertNear(B[0][0], 0.0, TOL, "B_00_zero");
    assert(std::abs(B[0][1]) > 1e-10);  // dvI affects da
    assertNear(B[0][2], 0.0, TOL, "B_02_zero");

    // Row 1: dlambda only from radial (col 0)
    assert(std::abs(B[1][0]) > 1e-10);  // dvR affects dlambda
    assertNear(B[1][1], 0.0, TOL, "B_11_zero");
    assertNear(B[1][2], 0.0, TOL, "B_12_zero");

    // Rows 4,5: dix, diy only from cross-track (col 2)
    assertNear(B[4][0], 0.0, TOL, "B_40_zero");
    assertNear(B[4][1], 0.0, TOL, "B_41_zero");
    assertNear(B[5][0], 0.0, TOL, "B_50_zero");
    assertNear(B[5][1], 0.0, TOL, "B_51_zero");

    std::cout << "  Control matrix structure verified\n";
}

void testApplyDeltaVRoundTrip() {
    auto chief = issChief();
    maneuver::ROEVector roe = {1e-5, 0, 0, 0, 0, 0};
    maneuver::Vector3 dv = {0.0, 0.1, 0.0};  // 0.1 m/s in-track

    auto modified = maneuver::applyDeltaV(roe, dv, chief);

    // da should change (in-track burn changes energy)
    assert(std::abs(modified[0] - roe[0]) > 1e-10);
    // dix, diy should NOT change (in-track burn)
    assertNear(modified[4], roe[4], TOL, "applyDv_dix_unchanged");
    assertNear(modified[5], roe[5], TOL, "applyDv_diy_unchanged");

    std::cout << "  applyDeltaV: da changed by " << (modified[0] - roe[0]) << "\n";
}

// ===== ROE <-> RIC Round Trip =====

void testROERICRoundTrip() {
    auto chief = issChief();

    // Start with known ROE
    maneuver::QuasiNonsingularROE roe = {1e-5, 2e-5, 3e-6, 4e-6, 5e-6, 6e-6};

    // Convert to RIC
    auto ric = maneuver::roeToRIC(chief, roe);

    // Convert back to ROE
    auto roeBack = maneuver::ricToROE(chief, ric);

    assertNear(roeBack.da, roe.da, 1e-10, "roundtrip_da");
    assertNear(roeBack.dlambda, roe.dlambda, 1e-10, "roundtrip_dlambda");
    assertNear(roeBack.dex, roe.dex, 1e-10, "roundtrip_dex");
    assertNear(roeBack.dey, roe.dey, 1e-10, "roundtrip_dey");
    assertNear(roeBack.dix, roe.dix, 1e-10, "roundtrip_dix");
    assertNear(roeBack.diy, roe.diy, 1e-10, "roundtrip_diy");

    std::cout << "  ROE<->RIC round trip verified\n";
}

// ===== Two-Burn Rendezvous =====

void testRendezvousConvergence() {
    auto chief = issChief();

    // Deputy starts 100m behind and 50m below chief
    maneuver::RelativeState initialState;
    initialState.position = {0.0, -100.0, 0.0};  // 100m behind in-track
    initialState.velocity = {0.0, 0.0, 0.0};

    // Target: origin (rendezvous with chief)
    maneuver::Vector3 target = {0.0, 0.0, 0.0};

    // Use 1 orbit as TOF
    double n = maneuver::meanMotion(chief.semiMajorAxis,
                                     chief.gravitationalParameter);
    double period = maneuver::TWO_PI / n;
    double tof = period;

    maneuver::TargetingOptions opts;
    opts.includeJ2 = true;
    opts.positionTolerance = 1.0;  // 1 meter

    auto leg = maneuver::solveRendezvous(initialState, target, chief, tof, opts);

    std::cout << "  Rendezvous: converged=" << leg.converged
              << " iterations=" << leg.iterations
              << " posError=" << leg.positionError << "m"
              << " totalDV=" << leg.totalDeltaV << "m/s\n";

    assert(leg.converged);
    assert(leg.positionError < 1.0);  // Within tolerance
    assert(leg.totalDeltaV > 0.0);
    assert(leg.totalDeltaV < 10.0);   // Should be small for 100m at ISS
}

void testRendezvousLargerSeparation() {
    auto chief = issChief();

    // 1 km along-track separation
    maneuver::RelativeState initialState;
    initialState.position = {0.0, -1000.0, 0.0};
    initialState.velocity = {0.0, 0.0, 0.0};

    maneuver::Vector3 target = {0.0, 0.0, 0.0};

    double n = maneuver::meanMotion(chief.semiMajorAxis,
                                     chief.gravitationalParameter);
    double tof = 1.5 * maneuver::TWO_PI / n;

    maneuver::TargetingOptions opts;
    opts.includeJ2 = true;
    opts.positionTolerance = 5.0;

    auto leg = maneuver::solveRendezvous(initialState, target, chief, tof, opts);

    std::cout << "  Large rendezvous: converged=" << leg.converged
              << " iterations=" << leg.iterations
              << " posError=" << leg.positionError << "m"
              << " totalDV=" << leg.totalDeltaV << "m/s\n";

    assert(leg.converged);
    assert(leg.positionError < 5.0);
}

// ===== Propagation =====

void testPropagateROEConsistency() {
    auto chief = issChief();
    maneuver::QuasiNonsingularROE roe = {1e-5, 0, 1e-6, 2e-6, 3e-6, 4e-6};

    double n = maneuver::meanMotion(chief.semiMajorAxis,
                                     chief.gravitationalParameter);
    double period = maneuver::TWO_PI / n;

    // Propagate for one orbit
    auto result = maneuver::propagateROEWithChief(roe, chief, period);

    // da should be preserved (no drag)
    assertNear(result.roe.da, roe.da, 1e-10, "prop_da_preserved");

    // Chief mean anomaly should advance by 2pi (modulo)
    double expectedM = maneuver::normalizeAngle(chief.meanAnomaly + n * period);
    assertNear(result.chief.meanAnomaly, expectedM, 1e-6, "prop_chief_M");

    std::cout << "  Propagation consistency verified\n";
}

// ===== Validation =====

void testValidation() {
    auto chief = issChief();
    auto result = maneuver::validateTargetingConfig(chief);
    assert(result.valid);

    // Invalid: negative SMA
    auto badChief = chief;
    badChief.semiMajorAxis = -1000.0;
    result = maneuver::validateTargetingConfig(badChief);
    assert(!result.valid);

    // Invalid: eccentricity >= 1
    badChief = chief;
    badChief.eccentricity = 1.5;
    result = maneuver::validateTargetingConfig(badChief);
    assert(!result.valid);

    // Invalid: equatorial orbit
    badChief = chief;
    badChief.inclination = 0.0;
    result = maneuver::validateTargetingConfig(badChief);
    assert(!result.valid);

    std::cout << "  Validation tests passed\n";
}

// ===== Multi-waypoint Mission =====

void testMissionPlanTwoWaypoints() {
    auto chief = issChief();

    maneuver::RelativeState initialState;
    initialState.position = {0.0, -200.0, 0.0};
    initialState.velocity = {0.0, 0.0, 0.0};

    double n = maneuver::meanMotion(chief.semiMajorAxis,
                                     chief.gravitationalParameter);
    double period = maneuver::TWO_PI / n;

    // Two waypoints: first at 100m behind, then origin
    maneuver::Waypoint wp1;
    wp1.position = {0.0, -100.0, 0.0};
    wp1.tofHint = period;
    wp1.hasTofHint = true;

    maneuver::Waypoint wp2;
    wp2.position = {0.0, 0.0, 0.0};
    wp2.tofHint = period;
    wp2.hasTofHint = true;

    maneuver::TargetingOptions opts;
    opts.includeJ2 = true;
    opts.positionTolerance = 5.0;

    auto plan = maneuver::planMission(initialState, {wp1, wp2}, chief, opts);

    std::cout << "  Mission plan: legs=" << plan.legs.size()
              << " totalDV=" << plan.totalDeltaV << "m/s"
              << " totalTime=" << plan.totalTime << "s"
              << " converged=" << plan.converged << "\n";

    assert(plan.legs.size() == 2);
    assert(plan.totalDeltaV > 0.0);
    assert(plan.totalTime > 0.0);
}

}  // namespace

int main() {
    std::cout << "=== test_targeting ===\n";
    testControlMatrixStructure();
    testApplyDeltaVRoundTrip();
    testROERICRoundTrip();
    testRendezvousConvergence();
    testRendezvousLargerSeparation();
    testPropagateROEConsistency();
    testValidation();
    testMissionPlanTwoWaypoints();
    std::cout << "All targeting tests passed.\n";
    return 0;
}
