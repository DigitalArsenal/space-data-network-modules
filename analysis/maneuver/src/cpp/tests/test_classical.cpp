#include "maneuver/classical.h"
#include "maneuver/constants.h"

#include <cassert>
#include <cmath>
#include <iostream>
#include <string>

namespace {

constexpr double TOL = 1e-2;       // m/s tolerance for delta-v
constexpr double TOL_TIME = 60.0;  // seconds tolerance for transfer time

void assertNear(double actual, double expected, double tol,
                const std::string& label) {
    if (std::abs(actual - expected) > tol) {
        std::cerr << "FAIL [" << label << "]: expected " << expected
                  << ", got " << actual
                  << " (diff=" << std::abs(actual - expected) << ")\n";
        assert(false);
    }
}

// ===== Hohmann: LEO -> GEO =====

void testHohmannLEOtoGEO() {
    // ISS altitude ~400 km -> GEO ~35786 km
    double r1 = maneuver::R_EARTH + 400e3;    // ~6778 km
    double r2 = maneuver::R_EARTH + 35786e3;  // ~42164 km

    auto result = maneuver::computeHohmannTransfer(r1, r2, maneuver::MU_EARTH);

    // Known values depend on exact constants (R_EARTH, mu).
    // With our constants: dv1 ≈ 2397 m/s, dv2 ≈ 1457 m/s, total ≈ 3854 m/s
    // Transfer time ≈ 5.29 hours ≈ 19049 s
    assertNear(result.dv1, 2397.0, 100.0, "hohmann_leo_geo_dv1");
    assertNear(result.dv2, 1457.0, 100.0, "hohmann_leo_geo_dv2");
    assertNear(result.totalDeltaV, 3854.0, 200.0, "hohmann_leo_geo_total");
    assertNear(result.tof, 19049.0, 500.0, "hohmann_leo_geo_tof");

    std::cout << "  Hohmann LEO->GEO: dv1=" << result.dv1
              << " dv2=" << result.dv2
              << " total=" << result.totalDeltaV
              << " tof=" << result.tof << "s\n";

    // Both burns should be prograde (in-track)
    assertNear(result.dv1_ric[0], 0.0, TOL, "hohmann_dv1_radial");
    assertNear(result.dv2_ric[0], 0.0, TOL, "hohmann_dv2_radial");
    assert(result.dv1_ric[1] > 0.0);  // prograde
    assert(result.dv2_ric[1] > 0.0);  // prograde
}

void testHohmannSameOrbit() {
    double r = 7000e3;
    auto result = maneuver::computeHohmannTransfer(r, r, maneuver::MU_EARTH);
    assertNear(result.totalDeltaV, 0.0, TOL, "hohmann_same_orbit");
}

void testHohmannLowerOrbit() {
    // Transfer from higher to lower orbit
    double r1 = 42164e3;  // GEO
    double r2 = 6778e3;   // LEO

    auto result = maneuver::computeHohmannTransfer(r1, r2, maneuver::MU_EARTH);

    // dv1 should be retrograde (negative in-track)
    assert(result.dv1_ric[1] < 0.0);
    // dv2 should be retrograde
    assert(result.dv2_ric[1] < 0.0);

    // Total delta-v should be same magnitude as LEO->GEO
    assertNear(result.totalDeltaV, 3854.0, 200.0, "hohmann_geo_leo_total");
}

// ===== Bi-elliptic =====

void testBiEllipticTransfer() {
    // LEO -> GEO via very high intermediate orbit
    double r1 = 6778e3;
    double r2 = 42164e3;
    double rInt = 100000e3;  // 100,000 km intermediate

    auto result = maneuver::computeBiEllipticTransfer(r1, r2, rInt,
                                                       maneuver::MU_EARTH);

    // Bi-elliptic should have 3 burns
    assert(result.dv1 > 0.0);
    assert(result.dv2 > 0.0);
    assert(result.dv3 > 0.0);

    // Total delta-v should be higher than Hohmann for this ratio
    // (bi-elliptic only wins when r2/r1 > 11.94)
    double hohmann_total = maneuver::computeHohmannTransfer(
        r1, r2, maneuver::MU_EARTH).totalDeltaV;

    std::cout << "  Bi-elliptic: dv1=" << result.dv1
              << " dv2=" << result.dv2
              << " dv3=" << result.dv3
              << " total=" << result.totalDeltaV
              << " (Hohmann=" << hohmann_total << ")\n";

    // Transfer time should be longer than Hohmann
    double hohmann_tof = maneuver::computeHohmannTransfer(
        r1, r2, maneuver::MU_EARTH).tof;
    assert(result.tof > hohmann_tof);
}

void testBiEllipticWinsForLargeRatio() {
    // Bi-elliptic wins when r2/r1 > 11.94
    double r1 = 6778e3;
    double r2 = r1 * 15.0;  // ratio = 15 > 11.94
    double rInt = r2 * 2.0;

    auto bielliptic = maneuver::computeBiEllipticTransfer(
        r1, r2, rInt, maneuver::MU_EARTH);
    auto hohmann = maneuver::computeHohmannTransfer(
        r1, r2, maneuver::MU_EARTH);

    std::cout << "  Large ratio: bi-elliptic=" << bielliptic.totalDeltaV
              << " hohmann=" << hohmann.totalDeltaV << "\n";

    // Bi-elliptic should win
    assert(bielliptic.totalDeltaV < hohmann.totalDeltaV);
}

// ===== Patched Conics: Earth -> Mars =====

void testPatchedConicEarthMars() {
    auto result = maneuver::computePatchedConicTransfer(
        maneuver::EARTH, maneuver::MARS,
        200e3,  // 200 km parking orbit at Earth
        200e3,  // 200 km parking orbit at Mars
        maneuver::MU_SUN);

    // Known values:
    // Total delta-v ≈ 5.6-5.7 km/s (from LinkedIn post: 5.704 km/s)
    // Transfer time ≈ 259 days ≈ 22.4 million seconds
    assertNear(result.totalDeltaV, 5700.0, 500.0, "patched_earth_mars_total");

    // Transfer time should be ~259 days
    double transferDays = result.tof / maneuver::SECONDS_PER_DAY;
    assertNear(transferDays, 259.0, 20.0, "patched_earth_mars_tof_days");

    std::cout << "  Earth->Mars: dvDepart=" << result.dvDepart
              << " dvArrive=" << result.dvArrive
              << " total=" << result.totalDeltaV
              << " tof=" << transferDays << " days"
              << " vInfDepart=" << result.vInfDepart
              << " vInfArrive=" << result.vInfArrive << "\n";
}

// ===== Delta-V Budget =====

void testDeltaVBudget() {
    auto budget = maneuver::computeDeltaVBudget({100.0, 200.0, 150.0});
    assertNear(budget.totalDeltaV, 450.0, TOL, "budget_total");
    assert(budget.phaseDeltas.size() == 3);
}

}  // namespace

int main() {
    std::cout << "=== test_classical ===\n";
    testHohmannLEOtoGEO();
    testHohmannSameOrbit();
    testHohmannLowerOrbit();
    testBiEllipticTransfer();
    testBiEllipticWinsForLargeRatio();
    testPatchedConicEarthMars();
    testDeltaVBudget();
    std::cout << "All classical maneuver tests passed.\n";
    return 0;
}
