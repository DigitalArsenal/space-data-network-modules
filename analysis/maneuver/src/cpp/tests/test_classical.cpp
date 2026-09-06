#include "maneuver/classical.h"
#include "maneuver/constants.h"
#include "maneuver/fault.h"
#include "maneuver/math.h"

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
    // The third burn circularizes at the transfer periapsis: it is retrograde.
    // Since 0.5.0 scalars carry their signed in-track components.
    assert(result.dv3 < 0.0);
    assertNear(result.dv3, result.dv3_ric[1], 1e-10, "bielliptic_signed_dv3");

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

// ===== State -> elements, and the phase geometry of a pair =====

/// Build the inertial state of an element set, independently of the recovery
/// under test: perifocal position and velocity rotated by (raan, inc, argp).
/// Written out here rather than reusing the module's own `elementsToState`
/// so that the round trip below compares two DIFFERENT pieces of code.
void stateOf(const maneuver::ClassicalOrbitalElements& oe,
             maneuver::Vector3* position, maneuver::Vector3* velocity) {
    const double mu = oe.gravitationalParameter;
    const double a = oe.semiMajorAxis;
    const double e = oe.eccentricity;
    const double nu = maneuver::trueAnomalyFromMean(oe.meanAnomaly, e);
    const double p = a * (1.0 - e * e);
    const double r = p / (1.0 + e * std::cos(nu));
    const double h = std::sqrt(mu * p);

    const double px = r * std::cos(nu);
    const double py = r * std::sin(nu);
    const double pvx = -(mu / h) * std::sin(nu);
    const double pvy = (mu / h) * (e + std::cos(nu));

    const double cO = std::cos(oe.raan), sO = std::sin(oe.raan);
    const double cw = std::cos(oe.argumentOfPerigee);
    const double sw = std::sin(oe.argumentOfPerigee);
    const double ci = std::cos(oe.inclination), si = std::sin(oe.inclination);

    const double m11 = cO * cw - sO * sw * ci, m12 = -cO * sw - sO * cw * ci;
    const double m21 = sO * cw + cO * sw * ci, m22 = -sO * sw + cO * cw * ci;
    const double m31 = sw * si,                m32 = cw * si;

    *position = {m11 * px + m12 * py, m21 * px + m22 * py, m31 * px + m32 * py};
    *velocity = {m11 * pvx + m12 * pvy, m21 * pvx + m22 * pvy,
                 m31 * pvx + m32 * pvy};
}

maneuver::ClassicalOrbitalElements elementsOf(double a, double e, double inc,
                                              double raan, double argp,
                                              double meanAnomaly) {
    maneuver::ClassicalOrbitalElements oe;
    oe.semiMajorAxis = a;
    oe.eccentricity = e;
    oe.inclination = inc;
    oe.raan = raan;
    oe.argumentOfPerigee = argp;
    oe.meanAnomaly = meanAnomaly;
    oe.gravitationalParameter = maneuver::MU_EARTH;
    oe.angularMomentum = std::sqrt(maneuver::MU_EARTH * a * (1.0 - e * e));
    return oe;
}

void testStateToElementsRoundTrip() {
    const double d2r = maneuver::DEG_TO_RAD;
    const auto oe = elementsOf(7000e3, 0.012, 51.6 * d2r, 40.0 * d2r,
                               70.0 * d2r, 200.0 * d2r);
    maneuver::Vector3 r{}, v{};
    stateOf(oe, &r, &v);

    const auto back = maneuver::stateToClassicalElements(r, v, oe.gravitationalParameter);
    assertNear(back.semiMajorAxis, oe.semiMajorAxis, 1e-6, "rv2coe_sma");
    assertNear(back.eccentricity, oe.eccentricity, 1e-12, "rv2coe_ecc");
    assertNear(back.inclination, oe.inclination, 1e-12, "rv2coe_inc");
    assertNear(back.raan, oe.raan, 1e-12, "rv2coe_raan");
    assertNear(back.argumentOfPerigee, oe.argumentOfPerigee, 1e-12, "rv2coe_argp");
    assertNear(back.meanAnomaly, oe.meanAnomaly, 1e-12, "rv2coe_M");
}

/// THE REASON `nu` IS COMPUTED AS `u - argp`. At e = 1e-9 the eccentricity
/// vector's direction is noise, so `argumentOfPerigee` and `meanAnomaly` are
/// each individually meaningless — but their SUM, the mean argument of
/// latitude, is exact, and it is the only thing a phasing computation reads.
void testNearCircularMeanArgumentOfLatitudeSurvives() {
    const double d2r = maneuver::DEG_TO_RAD;
    const double u = 123.456 * d2r;
    const auto oe = elementsOf(6778137.0, 1e-9, 51.6 * d2r, 40.0 * d2r, 0.0, u);
    maneuver::Vector3 r{}, v{};
    stateOf(oe, &r, &v);

    const auto back = maneuver::stateToClassicalElements(r, v, maneuver::MU_EARTH);
    const double lambda = std::fmod(
        back.argumentOfPerigee + back.meanAnomaly + 4.0 * M_PI, 2.0 * M_PI);
    assertNear(lambda, u, 1e-9, "near_circular_mean_arg_latitude");
}

/// A rectilinear state has no orbital plane. It must REFUSE, not answer.
void testStateToElementsRefusesRectilinear() {
    maneuver::fault::reset();
    const maneuver::Vector3 r{7000e3, 0.0, 0.0};
    const maneuver::Vector3 v{1000.0, 0.0, 0.0};  // parallel to r
    maneuver::stateToClassicalElements(r, v, maneuver::MU_EARTH);
    assert(maneuver::fault::raised());
    maneuver::fault::reset();
}

/// An escape trajectory has no mean anomaly. It must REFUSE.
void testStateToElementsRefusesEscape() {
    maneuver::fault::reset();
    const maneuver::Vector3 r{7000e3, 0.0, 0.0};
    const maneuver::Vector3 v{0.0, 12000.0, 0.0};  // well past escape speed
    maneuver::stateToClassicalElements(r, v, maneuver::MU_EARTH);
    assert(maneuver::fault::raised());
    maneuver::fault::reset();
}

/// THE ADVERSARIAL CASE for the whole operation: two craft on the SAME
/// near-circular orbit whose apsides are 180 degrees apart. Their mean
/// ANOMALIES differ by 180 degrees; their true along-track separation is 30.
/// A derivation that differences mean anomalies gets this exactly wrong.
void testPhaseGeometryIsNotAMeanAnomalyDifference() {
    const double d2r = maneuver::DEG_TO_RAD;
    const auto chaser = elementsOf(6778137.0, 0.001, 51.6 * d2r, 40.0 * d2r,
                                   70.0 * d2r, 10.0 * d2r);
    // argp + M = 80 for the chaser; 110 for the target => 30 degrees of lead,
    // reached with the apsides on opposite sides of the orbit.
    const auto target = elementsOf(6778137.0, 0.001, 51.6 * d2r, 40.0 * d2r,
                                   250.0 * d2r, 220.0 * d2r);

    const auto g = maneuver::computePhaseGeometry(chaser, target);
    assertNear(g.relativePhaseAngle, 30.0 * d2r, 1e-12, "phase_geometry_lead");
    // The mean-anomaly difference is 210 degrees, i.e. -150 wrapped. Nothing
    // like the answer.
    const double meanAnomalyDifference =
        g.targetMeanAnomaly - g.chaserMeanAnomaly;
    assert(std::abs(meanAnomalyDifference - 30.0 * d2r) > 1.0);
    assertNear(g.catchUpAngle, 30.0 * d2r, 1e-12, "phase_geometry_catch_up");
    assertNear(g.fallBehindAngle, -330.0 * d2r, 1e-12, "phase_geometry_fall_behind");
    assertNear(g.planeAngle, 0.0, 1e-12, "phase_geometry_coplanar");
}

/// The RAAN difference enters as an in-plane rotation projected by cos(i) —
/// the quasi-nonsingular ROE `dlambda` this module already uses elsewhere.
void testPhaseGeometryProjectsTheRaanDifference() {
    const double d2r = maneuver::DEG_TO_RAD;
    const double inc = 51.6 * d2r;
    const auto chaser = elementsOf(6778137.0, 0.0, inc, 40.0 * d2r, 0.0, 10.0 * d2r);
    const auto target = elementsOf(6778137.0, 0.0, inc, 40.5 * d2r, 0.0, 30.0 * d2r);
    const auto g = maneuver::computePhaseGeometry(chaser, target);
    const double expected = 20.0 * d2r + 0.5 * d2r * std::cos(inc);
    assertNear(g.relativePhaseAngle, expected, 1e-12, "phase_geometry_raan_projection");
    assertNear(g.raanDifference, 0.5 * d2r, 1e-12, "phase_geometry_raan_difference");
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
    testStateToElementsRoundTrip();
    testNearCircularMeanArgumentOfLatitudeSurvives();
    testStateToElementsRefusesRectilinear();
    testStateToElementsRefusesEscape();
    testPhaseGeometryIsNotAMeanAnomalyDifference();
    testPhaseGeometryProjectsTheRaanDifference();
    std::cout << "All classical maneuver tests passed.\n";
    return 0;
}
