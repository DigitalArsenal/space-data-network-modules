/**
 * Collision Probability Methods — Cross-Validation Tests
 *
 * Strategy:
 *   1. Known analytical cases (head-on, zero miss, large miss)
 *   2. Cross-method consistency (all methods should agree within bounds)
 *   3. Alfano always ≥ all other methods (it's the maximum)
 *   4. Convergence: high-resolution methods match each other
 *   5. Edge cases: degenerate covariance, circular covariance
 */

#include "conjunction/conjunction_assessment.h"
#include "conjunction/pc_method.h"
#include <cstdio>
#include <cmath>
#include <fstream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

static int tests_passed = 0;
static int tests_failed = 0;

#define CHECK(cond, msg) do { \
    if (!(cond)) { printf("  FAIL: %s\n", msg); tests_failed++; } \
    else { printf("  PASS: %s\n", msg); tests_passed++; } \
} while(0)

#define CHECK_TOL(val, expected, tol, msg) do { \
    double _v = (val), _e = (expected), _t = (tol); \
    if (std::abs(_v - _e) > _t) { \
        printf("  FAIL: %s (got %.6e, expected %.6e)\n", msg, _v, _e); \
        tests_failed++; \
    } else { \
        printf("  PASS: %s\n", msg); tests_passed++; \
    } \
} while(0)

using namespace conjunction;

static std::string read_fixture_text(const std::string& relative_path) {
    const std::string path = std::string(CONJUNCTION_TEST_FIXTURE_DIR) + "/" + relative_path;
    std::ifstream file(path);
    if (!file) {
        throw std::runtime_error("Unable to read fixture: " + path);
    }
    std::ostringstream buffer;
    buffer << file.rdbuf();
    return buffer.str();
}

// ── Test 1: All methods on a standard case ──

void test_standard_case() {
    printf("\n=== Test 1: Standard Case (1 km miss, 10m radius, 100m/300m/100m cov) ===\n");

    BPlaneGeometry bp;
    bp.xi = 0.7;    // 0.7 km miss in X
    bp.zeta = 0.7;  // 0.7 km miss in Z → ~1 km total miss
    bp.sigma_xx = 0.1 * 0.1 + 0.1 * 0.1;  // combined: 2 × (100m)² in km²
    bp.sigma_xz = 0;
    bp.sigma_zz = 0.3 * 0.3 + 0.3 * 0.3;  // combined: 2 × (300m)² in km²
    bp.combined_radius = 0.01;  // 10m

    printf("  Miss: %.3f km, Radius: %.3f km\n", bp.miss_distance(), bp.combined_radius);
    printf("  Cov eigenvalues: σ_xx=%.4f, σ_zz=%.4f km²\n", bp.sigma_xx, bp.sigma_zz);

    auto alfano = std::make_unique<AlfanoMaxPc>();
    auto foster = std::make_unique<Foster2D>();
    auto patera = std::make_unique<Patera2001>(256);
    auto chan = std::make_unique<Chan1997>();
    auto alfriend = std::make_unique<Alfriend2D>(64, 128);

    auto r_alf = alfano->compute(bp);
    auto r_fos = foster->compute(bp);
    auto r_pat = patera->compute(bp);
    auto r_cha = chan->compute(bp);
    auto r_afr = alfriend->compute(bp);

    printf("  Alfano:   %.6e\n", r_alf.probability);
    printf("  Foster:   %.6e\n", r_fos.probability);
    printf("  Patera:   %.6e\n", r_pat.probability);
    printf("  Chan:     %.6e\n", r_cha.probability);
    printf("  Alfriend: %.6e\n", r_afr.probability);

    // Alfano must be >= all others (it's the maximum probability)
    CHECK(r_alf.probability >= r_fos.probability * 0.99, "Alfano ≥ Foster");
    CHECK(r_alf.probability >= r_pat.probability * 0.99, "Alfano ≥ Patera");
    CHECK(r_alf.probability >= r_cha.probability * 0.99, "Alfano ≥ Chan");
    CHECK(r_alf.probability >= r_afr.probability * 0.99, "Alfano ≥ Alfriend");

    // Chan and Alfriend should agree closely (both do 2D numerical integration)
    if (r_cha.probability > 1e-30 && r_afr.probability > 1e-30) {
        double ratio_ca = r_cha.probability / r_afr.probability;
        printf("  Chan/Alfriend ratio: %.4f\n", ratio_ca);
        CHECK(ratio_ca > 0.9 && ratio_ca < 1.1, "Chan ≈ Alfriend within 10%");
    }

    // All should be non-zero
    CHECK(r_fos.probability > 0, "Foster > 0");
    CHECK(r_pat.probability > 0, "Patera > 0");
    CHECK(r_cha.probability > 0, "Chan > 0");
    CHECK(r_afr.probability > 0, "Alfriend > 0");
}

// ── Test 2: Zero miss distance ──

void test_zero_miss() {
    printf("\n=== Test 2: Zero Miss Distance ===\n");

    BPlaneGeometry bp;
    bp.xi = 0; bp.zeta = 0;
    bp.sigma_xx = 0.01; bp.sigma_zz = 0.01;
    bp.combined_radius = 0.01;

    auto foster = std::make_unique<Foster2D>();
    auto chan = std::make_unique<Chan1997>();

    auto r_fos = foster->compute(bp);
    auto r_cha = chan->compute(bp);

    printf("  Foster Pc: %.6e\n", r_fos.probability);
    printf("  Chan Pc:   %.6e\n", r_cha.probability);

    // At zero miss, Pc should be relatively high
    CHECK(r_fos.probability > 1e-6, "Foster: non-negligible Pc at zero miss");
    CHECK(r_cha.probability > 1e-6, "Chan: non-negligible Pc at zero miss");
}

// ── Test 3: Large miss distance ──

void test_large_miss() {
    printf("\n=== Test 3: Large Miss Distance (100 km) ===\n");

    BPlaneGeometry bp;
    bp.xi = 70.71; bp.zeta = 70.71;  // ~100 km miss
    bp.sigma_xx = 0.01; bp.sigma_zz = 0.01;
    bp.combined_radius = 0.01;

    auto foster = std::make_unique<Foster2D>();
    auto alfano = std::make_unique<AlfanoMaxPc>();

    auto r_fos = foster->compute(bp);
    auto r_alf = alfano->compute(bp);

    printf("  Foster Pc: %.6e\n", r_fos.probability);
    printf("  Alfano Pc: %.6e\n", r_alf.probability);

    // Both should be extremely small
    CHECK(r_fos.probability < 1e-20, "Foster: negligible at 100 km miss");
    CHECK(r_alf.probability < 1e-4, "Alfano: small at 100 km miss");
}

// ── Test 4: Circular covariance (Foster exact) ──

void test_circular_cov() {
    printf("\n=== Test 4: Circular Covariance (isotropic, Foster exact) ===\n");

    BPlaneGeometry bp;
    bp.xi = 0.5; bp.zeta = 0;
    bp.sigma_xx = 0.04; bp.sigma_zz = 0.04;  // σ = 200m isotropic
    bp.combined_radius = 0.01;

    auto foster = std::make_unique<Foster2D>();
    auto patera = std::make_unique<Patera2001>(512);
    auto chan = std::make_unique<Chan1997>();
    auto alfriend = std::make_unique<Alfriend2D>(64, 256);

    auto r_fos = foster->compute(bp);
    auto r_pat = patera->compute(bp);
    auto r_cha = chan->compute(bp);
    auto r_afr = alfriend->compute(bp);

    printf("  Foster:   %.10e\n", r_fos.probability);
    printf("  Patera:   %.10e\n", r_pat.probability);
    printf("  Chan:     %.10e\n", r_cha.probability);
    printf("  Alfriend: %.10e\n", r_afr.probability);

    // For circular covariance, all methods should agree closely
    // Use Chan/Alfriend (full integration) as reference
    double ref = r_afr.probability;
    if (ref > 1e-30) {
        CHECK(std::abs(r_fos.probability - ref) / ref < 0.05, "Foster within 5% of Alfriend (circular)");
        CHECK(std::abs(r_cha.probability - ref) / ref < 0.05, "Chan within 5% of Alfriend (circular)");
        CHECK(std::abs(r_pat.probability - ref) / ref < 0.1, "Patera within 10% of Alfriend (circular)");
    }
}

// ── Test 5: Highly elliptical covariance ──

void test_elliptical_cov() {
    printf("\n=== Test 5: Highly Elliptical Covariance (10:1 ratio) ===\n");

    BPlaneGeometry bp;
    bp.xi = 0.3; bp.zeta = 0.1;
    bp.sigma_xx = 0.001;   // σ = 31.6 m (tight)
    bp.sigma_zz = 0.1;     // σ = 316 m (wide) → 10:1 ratio
    bp.combined_radius = 0.01;

    auto foster = std::make_unique<Foster2D>();
    auto patera = std::make_unique<Patera2001>(512);
    auto alfriend = std::make_unique<Alfriend2D>(64, 256);

    auto r_fos = foster->compute(bp);
    auto r_pat = patera->compute(bp);
    auto r_afr = alfriend->compute(bp);

    printf("  Foster:   %.10e\n", r_fos.probability);
    printf("  Patera:   %.10e\n", r_pat.probability);
    printf("  Alfriend: %.10e\n", r_afr.probability);

    // All numerical methods should agree within an order of magnitude
    // for highly elliptical cases (exact values differ due to quadrature resolution)
    if (r_afr.probability > 1e-30 && r_pat.probability > 1e-30) {
        double ratio = r_pat.probability / r_afr.probability;
        printf("  Patera/Alfriend ratio: %.3f\n", ratio);
        CHECK(ratio > 0.1 && ratio < 10.0, "Patera ≈ Alfriend within 1 order of magnitude (elliptical)");
    }
}

// ── Test 6: Orekit authoritative probability vectors ──

void test_orekit_patera2005_vectors() {
    printf("\n=== Test 6: Orekit Patera2005Test scalar probability vectors ===\n");

    struct OrekitPateraVector {
        const char* label;
        double xm;
        double ym;
        double sigma_x;
        double sigma_y;
        double radius;
        double expected_pc;
        double tolerance;
    };

    // Source: Orekit 13.1
    // org.orekit.ssa.collision.shorttermencounter.probability.twod.Patera2005Test.
    // Orekit expresses the encounter-plane miss coordinates, covariance
    // sigmas, and hard-body radius in a common length unit. The probability is
    // unitless, so this test keeps the same numeric length scale.
    const OrekitPateraVector vectors[] = {
        {"Chan test case 01", 0.0, 10.0, 25.0, 50.0, 5.0, 9.741e-3, 1.0e-6},
        {"Chan test case 02", 10.0, 0.0, 25.0, 50.0, 5.0, 9.181e-3, 1.0e-6},
        {"Chan test case 03", 0.0, 10.0, 25.0, 75.0, 5.0, 6.571e-3, 1.0e-6},
        {"Chan test case 04", 10.0, 0.0, 25.0, 75.0, 5.0, 6.125e-3, 1.0e-6},
        {"Chan test case 05", 0.0, 1000.0, 1000.0, 3000.0, 10.0, 1.577e-5, 1.0e-8},
        {"Chan test case 06", 1000.0, 0.0, 1000.0, 3000.0, 10.0, 1.011e-5, 1.0e-8},
        {"Chan test case 07", 0.0, 10000.0, 1000.0, 3000.0, 10.0, 6.443e-8, 1.0e-11},
        {"Chan test case 08", 10000.0, 0.0, 1000.0, 3000.0, 10.0, 3.219e-27, 1.0e-30},
        {"CSM test case 1", 84.875546, 60.583685, 57.918666, 152.8814468, 10.3, 1.9002e-3, 1.0e-7},
        {"CSM test case 2", -81.618369, 115.055899, 15.988242, 5756.840725, 1.3, 2.0553e-11, 1.0e-15},
        {"CSM test case 3", 102.177247, 693.405893, 94.230921, 643.409272, 5.3, 7.2003e-5, 1.0e-9},
        {"CDM test case 1", -752.672701, 644.939441, 445.859950, 6095.858688, 3.5, 5.3904e-7, 1.0e-11},
        {"CDM test case 2", -692.362272, 4475.456261, 193.454603, 562.027293, 13.2, 2.2795e-20, 1.0e-24},
    };

    Patera2001 patera(512);
    for (const auto& vector : vectors) {
        BPlaneGeometry bp;
        bp.xi = vector.xm;
        bp.zeta = vector.ym;
        bp.sigma_xx = vector.sigma_x * vector.sigma_x;
        bp.sigma_xz = 0.0;
        bp.sigma_zz = vector.sigma_y * vector.sigma_y;
        bp.combined_radius = vector.radius;

        const auto result = patera.compute(bp);
        CHECK_TOL(result.probability, vector.expected_pc, vector.tolerance, vector.label);
    }
}

// ── Test 7: Orekit Chan1997 authoritative probability vectors ──

void test_orekit_chan1997_vectors() {
    printf("\n=== Test 7: Orekit Chan1997Test scalar probability vectors ===\n");

    struct OrekitChanVector {
        const char* label;
        double xm;
        double ym;
        double sigma_x;
        double sigma_y;
        double radius;
        double expected_pc;
        double tolerance;
    };

    // Source: Orekit 13.1
    // org.orekit.ssa.collision.shorttermencounter.probability.twod.Chan1997Test.
    const OrekitChanVector vectors[] = {
        {"Chan test case 01", 0.0, 10.0, 25.0, 50.0, 5.0, 9.754e-3, 1.0e-6},
        {"Chan test case 02", 10.0, 0.0, 25.0, 50.0, 5.0, 9.189e-3, 1.0e-6},
        {"Chan test case 03", 0.0, 10.0, 25.0, 75.0, 5.0, 6.586e-3, 1.0e-6},
        {"Chan test case 04", 10.0, 0.0, 25.0, 75.0, 5.0, 6.135e-3, 1.0e-6},
        {"Chan test case 05", 0.0, 1000.0, 1000.0, 3000.0, 10.0, 1.577e-5, 1.0e-8},
        {"Chan test case 06", 1000.0, 0.0, 1000.0, 3000.0, 10.0, 1.011e-5, 1.0e-8},
        {"Chan test case 07", 0.0, 10000.0, 1000.0, 3000.0, 10.0, 6.443e-8, 1.0e-11},
        {"Chan test case 08", 10000.0, 0.0, 1000.0, 3000.0, 10.0, 3.216e-27, 1.0e-30},
        {"Chan test case 09", 0.0, 10000.0, 1000.0, 10000.0, 10.0, 3.033e-6, 1.0e-9},
        {"Chan test case 10", 10000.0, 0.0, 1000.0, 10000.0, 10.0, 9.645e-28, 1.0e-31},
        {"Chan test case 11", 0.0, 5000.0, 1000.0, 3000.0, 50.0, 1.039e-4, 1.0e-7},
        {"Chan test case 12", 5000.0, 0.0, 1000.0, 3000.0, 50.0, 1.556e-9, 1.0e-12},
        {"CSM test case 1", 84.875546, 60.583685, 57.918666, 152.8814468, 10.3, 1.8934e-3, 1.0e-7},
        {"CSM test case 2", -81.618369, 115.055899, 15.988242, 5756.840725, 1.3, 2.0135e-11, 1.0e-15},
        {"CSM test case 3", 102.177247, 693.405893, 94.230921, 643.409272, 5.3, 7.2000e-5, 1.0e-9},
        {"CDM test case 1", -752.672701, 644.939441, 445.859950, 6095.858688, 3.5, 5.3903e-7, 1.0e-11},
        {"CDM test case 2", -692.362272, 4475.456261, 193.454603, 562.027293, 13.2, 2.2880e-20, 1.0e-24},
        {"Alfano test case 3", -3.8872073, 0.1591646, 1.4101830, 114.2585190, 15.0, 3.1264e-2, 1.0e-6},
        {"Alfano test case 5", -1.2217895, 2.1230067, 0.0373279, 177.8109003, 10.0, 1.7346e-202, 1.0e-206},
    };

    auto method = create_pc_method("chan");
    CHECK(method->name() == "CHAN-1997", "Factory: chan maps to Orekit Chan1997");
    for (const auto& vector : vectors) {
        BPlaneGeometry bp;
        bp.xi = vector.xm;
        bp.zeta = vector.ym;
        bp.sigma_xx = vector.sigma_x * vector.sigma_x;
        bp.sigma_xz = 0.0;
        bp.sigma_zz = vector.sigma_y * vector.sigma_y;
        bp.combined_radius = vector.radius;

        const auto result = method->compute(bp);
        CHECK_TOL(result.probability, vector.expected_pc, vector.tolerance, vector.label);
    }
}

// ── Test 8: Orekit Alfriend1999 authoritative probability vectors ──

void test_orekit_alfriend1999_vectors() {
    printf("\n=== Test 8: Orekit Alfriend1999Test scalar Armellin vectors ===\n");

    // Source: Orekit 13.1
    // org.orekit.ssa.collision.shorttermencounter.probability.twod.Alfriend1999Test
    // and Alfriend1999MaxTest. The scalar values are the encounter-plane
    // coordinates reconstructed in the derivative tests from the Armellin
    // appendix case. Coordinates, sigmas, and hard-body radius are meters;
    // probabilities are unitless.
    BPlaneGeometry bp;
    bp.xi = 20.711983607206943;
    bp.zeta = -37.87548026356126;
    bp.sigma_xx = 26.841611626440486 * 26.841611626440486;
    bp.sigma_xz = 0.0;
    bp.sigma_zz = 72.06451864988387 * 72.06451864988387;
    bp.combined_radius = 29.71;

    auto alfriend = create_pc_method("ALFRIEND-1999");
    CHECK(alfriend->name() == "ALFRIEND-1999", "Factory: ALFRIEND-1999");
    CHECK_TOL(alfriend->compute(bp).probability, 0.147559, 1.0e-6,
              "Alfriend1999 Armellin appendix probability");

    auto alfriend_max = create_pc_method("ALFRIEND-1999-MAX");
    CHECK(alfriend_max->name() == "ALFRIEND-1999-MAX", "Factory: ALFRIEND-1999-MAX");
    CHECK_TOL(alfriend_max->compute(bp).probability, 1.9259e-1, 1.0e-6,
              "Alfriend1999Max Armellin appendix maximum probability");
}

// ── Test 9: Orekit Alfano2005 authoritative probability vectors ──

void test_orekit_alfano2005_vectors() {
    printf("\n=== Test 9: Orekit Alfano2005Test scalar probability vectors ===\n");

    struct OrekitAlfano2005Vector {
        const char* label;
        double xm;
        double ym;
        double sigma_x;
        double sigma_y;
        double radius;
        double expected_pc;
        double tolerance;
    };

    // Source: Orekit 13.1
    // org.orekit.ssa.collision.shorttermencounter.probability.twod.Alfano2005Test.
    const OrekitAlfano2005Vector vectors[] = {
        {"Chan test case 01", 0.0, 10.0, 25.0, 50.0, 5.0, 9.742e-3, 1.0e-6},
        {"Chan test case 02", 10.0, 0.0, 25.0, 50.0, 5.0, 9.181e-3, 1.0e-6},
        {"Chan test case 03", 0.0, 10.0, 25.0, 75.0, 5.0, 6.571e-3, 1.0e-6},
        {"Chan test case 04", 10.0, 0.0, 25.0, 75.0, 5.0, 6.125e-3, 1.0e-6},
        {"Chan test case 05", 0.0, 1000.0, 1000.0, 3000.0, 10.0, 1.577e-5, 1.0e-8},
        {"Chan test case 06", 1000.0, 0.0, 1000.0, 3000.0, 10.0, 1.011e-5, 1.0e-8},
        {"Chan test case 07", 0.0, 10000.0, 1000.0, 3000.0, 10.0, 6.443e-8, 1.0e-11},
        {"Chan test case 08", 10000.0, 0.0, 1000.0, 3000.0, 10.0, 3.219e-27, 1.0e-30},
        {"Chan test case 09", 0.0, 10000.0, 1000.0, 10000.0, 10.0, 3.033e-6, 1.0e-9},
        {"Chan test case 10", 10000.0, 0.0, 1000.0, 10000.0, 10.0, 9.656e-28, 1.0e-31},
        {"Chan test case 11", 0.0, 5000.0, 1000.0, 3000.0, 50.0, 1.039e-4, 1.0e-7},
        {"Chan test case 12", 5000.0, 0.0, 1000.0, 3000.0, 50.0, 1.564e-9, 1.0e-12},
        {"CSM test case 1", 84.875546, 60.583685, 57.918666, 152.8814468, 10.3, 1.9002e-3, 1.0e-7},
        {"CSM test case 2", -81.618369, 115.055899, 15.988242, 5756.840725, 1.3, 2.0553e-11, 1.0e-15},
        {"CSM test case 3", 102.177247, 693.405893, 94.230921, 643.409272, 5.3, 7.2004e-5, 1.0e-9},
        {"CDM test case 1", -752.672701, 644.939441, 445.859950, 6095.858688, 3.5, 5.3904e-7, 1.0e-11},
        {"CDM test case 2", -692.362272, 4475.456261, 193.454603, 562.027293, 13.2, 2.1652e-20, 1.0e-24},
        {"Alfano test case 3", -3.8872073, 0.1591646, 1.4101830, 114.2585190, 15.0, 1.0038e-1, 1.0e-5},
        {"Alfano test case 5", -1.2217895, 2.1230067, 0.0373279, 177.8109003, 10.0, 4.4510e-2, 1.0e-6},
    };

    auto method = create_pc_method("ALFANO-2005");
    CHECK(method->name() == "ALFANO-2005", "Factory: ALFANO-2005");
    for (const auto& vector : vectors) {
        BPlaneGeometry bp;
        bp.xi = vector.xm;
        bp.zeta = vector.ym;
        bp.sigma_xx = vector.sigma_x * vector.sigma_x;
        bp.sigma_xz = 0.0;
        bp.sigma_zz = vector.sigma_y * vector.sigma_y;
        bp.combined_radius = vector.radius;

        const auto result = method->compute(bp);
        CHECK_TOL(result.probability, vector.expected_pc, vector.tolerance, vector.label);
    }
}

// ── Test 10: Orekit Laas2015 authoritative probability vectors ──

void test_orekit_laas2015_vectors() {
    printf("\n=== Test 10: Orekit Laas2015Test scalar probability vectors ===\n");

    struct OrekitLaas2015Vector {
        const char* label;
        double xm;
        double ym;
        double sigma_x;
        double sigma_y;
        double radius;
        double expected_pc;
        double probability_tolerance;
        double expected_lower;
        double expected_upper;
        double bound_tolerance;
        bool has_bounds;
    };

    // Source: Orekit 13.1
    // org.orekit.ssa.collision.shorttermencounter.probability.twod.Laas2015Test.
    const OrekitLaas2015Vector vectors[] = {
        {"Chan test case 01", 0.0, 10.0, 25.0, 50.0, 5.0, 9.742e-3, 1.0e-6, 9.704e-3, 9.742e-3, 1.0e-6, true},
        {"Chan test case 02", 10.0, 0.0, 25.0, 50.0, 5.0, 9.181e-3, 1.0e-6, 9.139e-3, 9.182e-3, 1.0e-6, true},
        {"Chan test case 03", 0.0, 10.0, 25.0, 75.0, 5.0, 6.571e-3, 1.0e-6, 6.542e-3, 6.572e-3, 1.0e-6, true},
        {"Chan test case 04", 10.0, 0.0, 25.0, 75.0, 5.0, 6.125e-3, 1.0e-6, 6.09e-3, 6.13e-3, 1.0e-5, true},
        {"Chan test case 05", 0.0, 1000.0, 1000.0, 3000.0, 10.0, 1.577e-5, 1.0e-8, 1.576561e-5, 1.576576e-5, 1.0e-9, true},
        {"Chan test case 06", 1000.0, 0.0, 1000.0, 3000.0, 10.0, 1.011e-5, 1.0e-8, 1.010860e-5, 1.010883e-5, 1.0e-11, true},
        {"Chan test case 07", 0.0, 10000.0, 1000.0, 3000.0, 10.0, 6.443e-8, 1.0e-11, 6.44304e-8, 6.44321e-8, 1.0e-13, true},
        {"Chan test case 08", 10000.0, 0.0, 1000.0, 3000.0, 10.0, 3.219e-27, 1.0e-30, 3.2145e-27, 3.2186e-27, 1.0e-31, true},
        {"Chan test case 09", 0.0, 10000.0, 1000.0, 10000.0, 10.0, 3.033e-6, 1.0e-9, 3.03258e-6, 3.03261e-6, 1.0e-11, true},
        {"Chan test case 10", 10000.0, 0.0, 1000.0, 10000.0, 10.0, 9.656e-28, 1.0e-31, 9.643e-28, 9.656e-28, 1.0e-31, true},
        {"Chan test case 11", 0.0, 5000.0, 1000.0, 3000.0, 50.0, 1.039e-4, 1.0e-7, 1.03831e-4, 1.03871e-4, 1.0e-9, true},
        {"Chan test case 12", 5000.0, 0.0, 1000.0, 3000.0, 50.0, 1.564e-9, 1.0e-12, 1.552e-9, 1.565e-9, 1.0e-12, true},
        {"CSM test case 1", 84.875546, 60.583685, 57.918666, 152.8814468, 10.3, 1.9002e-3, 1.0e-7, 1.878e-3, 1.900e-3, 1.0e-6, true},
        {"CSM test case 2", -81.618369, 115.055899, 15.988242, 5756.840725, 1.3, 2.0553e-11, 1.0e-15, 2.0101e-11, 2.0557e-11, 1.0e-15, true},
        {"CSM test case 3", 102.177247, 693.405893, 94.230921, 643.409272, 5.3, 7.2003e-5, 1.0e-9, 7.194e-5, 7.200e-5, 1.0e-8, true},
        {"CDM test case 1", -752.672701, 644.939441, 445.859950, 6095.858688, 3.5, 5.3904e-7, 1.0e-11, 5.3902e-7, 5.3904e-7, 1.0e-11, true},
        {"CDM test case 2", -692.362272, 4475.456261, 193.454603, 562.027293, 13.2, 2.2796e-20, 1.0e-24, 2.2517e-20, 2.2797e-20, 1.0e-24, true},
        {"Alfano test case 3", -3.8872073, 0.1591646, 1.4101830, 114.2585190, 15.0, 1.0038e-1, 1.0e-5, 0.0, 0.0, 0.0, false},
        {"Alfano test case 5", -1.2217895, 2.1230067, 0.0373279, 177.8109003, 10.0, 4.4507e-2, 1.0e-6, 0.0, 0.0, 0.0, false},
    };

    auto method = create_pc_method("LAAS-2015");
    CHECK(method->name() == "LAAS-2015", "Factory: LAAS-2015");
    for (const auto& vector : vectors) {
        BPlaneGeometry bp;
        bp.xi = vector.xm;
        bp.zeta = vector.ym;
        bp.sigma_xx = vector.sigma_x * vector.sigma_x;
        bp.sigma_xz = 0.0;
        bp.sigma_zz = vector.sigma_y * vector.sigma_y;
        bp.combined_radius = vector.radius;

        const auto result = method->compute(bp);
        CHECK_TOL(result.probability, vector.expected_pc, vector.probability_tolerance, vector.label);
        if (vector.has_bounds) {
            CHECK_TOL(result.lower_probability, vector.expected_lower, vector.bound_tolerance, vector.label);
            CHECK_TOL(result.upper_probability, vector.expected_upper, vector.bound_tolerance, vector.label);
        }
    }
}

// ── Test 11: Orekit file-backed real CDM probability vectors ──

void test_orekit_file_backed_cdm_probability() {
    printf("\n=== Test 11: Orekit file-backed real CDM probability vectors ===\n");

    // Source: Orekit 13.1 ccsds/cdm/ION_SCV8_vs_STARLINK_1233.txt and
    // Patera2005Test/Laas2015Test testComputeProbabilityFromACdm.
    const std::string cdm_text = read_fixture_text("orekit/cdm/ION_SCV8_vs_STARLINK_1233.txt");

    uint8_t cdm_buffer[32768];
    const int32_t cdm_size = cdm_kvn_to_sds(
        cdm_text.data(),
        static_cast<uint32_t>(cdm_text.size()),
        cdm_buffer,
        sizeof(cdm_buffer));
    CHECK(cdm_size > 0, "Orekit ION/Starlink CDM fixture parses to SDS $CDM");
    if (cdm_size <= 0) {
        return;
    }

    const PcResult patera = compute_pc_from_cdm(
        cdm_buffer,
        static_cast<uint32_t>(cdm_size),
        "PATERA-2001",
        0.01);
    CHECK_TOL(patera.probability, 0.003496517644384083, 1.0e-9,
              "Patera2005 real CDM file probability");

    const PcResult laas = compute_pc_from_cdm(
        cdm_buffer,
        static_cast<uint32_t>(cdm_size),
        "LAAS-2015",
        0.01);
    CHECK_TOL(laas.probability, 0.0034965176443840897, 1.0e-10,
              "Laas2015 real CDM file probability");
}

// ── Test 12: Factory ──

void test_factory() {
    printf("\n=== Test 12: Method Factory ===\n");

    auto m1 = create_pc_method("alfano");
    CHECK(m1->name() == "ALFANO-MAXPROB", "Factory: alfano");

    auto m2 = create_pc_method("foster");
    CHECK(m2->name() == "FOSTER-2D", "Factory: foster");

    auto m3 = create_pc_method("patera");
    CHECK(m3->name() == "PATERA-2001", "Factory: patera");

    auto m4 = create_pc_method("chan");
    CHECK(m4->name() == "CHAN-1997", "Factory: chan");

    auto m5 = create_pc_method("alfriend");
    CHECK(m5->name() == "ALFRIEND-2D", "Factory: alfriend");

    auto m5b = create_pc_method("alfriend1999");
    CHECK(m5b->name() == "ALFRIEND-1999", "Factory: alfriend1999");

    auto m5c = create_pc_method("alfriend1999max");
    CHECK(m5c->name() == "ALFRIEND-1999-MAX", "Factory: alfriend1999max");

    auto m5d = create_pc_method("alfano2005");
    CHECK(m5d->name() == "ALFANO-2005", "Factory: alfano2005");

    auto m5e = create_pc_method("laas2015");
    CHECK(m5e->name() == "LAAS-2015", "Factory: laas2015");

    auto m6 = create_pc_method("unknown");
    CHECK(m6->name() == "FOSTER-2D", "Factory: unknown → default Foster");
}

// ── Test 13: Mahalanobis Distance ──

void test_mahalanobis() {
    printf("\n=== Test 13: Mahalanobis Distance ===\n");

    // Case 1: Miss at 1 sigma in isotropic covariance
    BPlaneGeometry bp1;
    bp1.xi = 0.1; bp1.zeta = 0;
    bp1.sigma_xx = 0.01;  // σ = 100m
    bp1.sigma_xz = 0;
    bp1.sigma_zz = 0.01;  // σ = 100m
    bp1.combined_radius = 0.01;

    double md1 = bp1.mahalanobis_distance();
    printf("  100m miss, 100m σ isotropic: Md = %.3f\n", md1);
    CHECK_TOL(md1, 1.0, 0.01, "Md = 1.0 at 1σ miss (isotropic)");

    // Case 2: Miss at 3 sigma
    BPlaneGeometry bp2;
    bp2.xi = 0.3; bp2.zeta = 0;
    bp2.sigma_xx = 0.01; bp2.sigma_zz = 0.01;
    double md2 = bp2.mahalanobis_distance();
    printf("  300m miss, 100m σ: Md = %.3f\n", md2);
    CHECK_TOL(md2, 3.0, 0.01, "Md = 3.0 at 3σ miss");

    // Case 3: Elliptical covariance — miss along minor axis
    BPlaneGeometry bp3;
    bp3.xi = 0.1; bp3.zeta = 0;
    bp3.sigma_xx = 0.01;   // σ_x = 100m (tight)
    bp3.sigma_xz = 0;
    bp3.sigma_zz = 1.0;    // σ_z = 1km (wide)
    double md3 = bp3.mahalanobis_distance();
    printf("  100m miss along tight axis (σ=100m, σ=1km): Md = %.3f\n", md3);
    CHECK_TOL(md3, 1.0, 0.01, "Md = 1.0 along minor axis");

    // Case 4: Same miss along wide axis
    BPlaneGeometry bp4;
    bp4.xi = 0; bp4.zeta = 0.1;  // miss along wide axis
    bp4.sigma_xx = 0.01;
    bp4.sigma_xz = 0;
    bp4.sigma_zz = 1.0;
    double md4 = bp4.mahalanobis_distance();
    printf("  100m miss along wide axis (σ=1km): Md = %.3f\n", md4);
    CHECK(md4 < 0.15, "Md < 0.15 (miss along wide axis, well within 1σ)");

    // Case 5: Zero miss
    BPlaneGeometry bp5;
    bp5.xi = 0; bp5.zeta = 0;
    bp5.sigma_xx = 0.01; bp5.sigma_zz = 0.01;
    double md5 = bp5.mahalanobis_distance();
    CHECK_TOL(md5, 0.0, 1e-10, "Md = 0 at zero miss");

    // Case 6: Mahalanobis stored in PcResult
    auto foster = std::make_unique<Foster2D>();
    auto r = foster->compute(bp1);
    printf("  PcResult.mahalanobis_2d = %.3f\n", r.mahalanobis_2d);
    CHECK_TOL(r.mahalanobis_2d, 1.0, 0.01, "PcResult carries Mahalanobis distance");

    // Case 7: Extreme aspect-ratio covariance keeps the minor eigenvalue.
    BPlaneGeometry bp7;
    bp7.sigma_xx = 0.0373279 * 0.0373279;
    bp7.sigma_xz = 0.0;
    bp7.sigma_zz = 177.8109003 * 177.8109003;
    double lambda_high, lambda_low;
    bp7.eigenvalues(lambda_high, lambda_low);
    CHECK_TOL(std::sqrt(lambda_low), 0.0373279, 1.0e-15,
              "Eigenvalues preserve high aspect-ratio minor axis");
}

// ── Test 14: Overlapping hard bodies ──

void test_overlapping() {
    printf("\n=== Test 14: Overlapping Hard Bodies ===\n");

    BPlaneGeometry bp;
    bp.xi = 0.005; bp.zeta = 0;  // 5m miss
    bp.sigma_xx = 0.01; bp.sigma_zz = 0.01;
    bp.combined_radius = 0.01;  // 10m radius > 5m miss

    auto alfano = std::make_unique<AlfanoMaxPc>();
    auto r = alfano->compute(bp);

    CHECK(r.probability == 1.0, "Alfano: Pc = 1.0 when radius > miss");
}

int main() {
    printf("============================================================\n");
    printf("Collision Probability Methods — Cross-Validation\n");
    printf("============================================================\n");

    test_standard_case();
    test_zero_miss();
    test_large_miss();
    test_circular_cov();
    test_elliptical_cov();
    test_orekit_patera2005_vectors();
    test_orekit_chan1997_vectors();
    test_orekit_alfriend1999_vectors();
    test_orekit_alfano2005_vectors();
    test_orekit_laas2015_vectors();
    test_orekit_file_backed_cdm_probability();
    test_factory();
    test_overlapping();
    test_mahalanobis();

    printf("\n============================================================\n");
    printf("Results: %d passed, %d failed\n", tests_passed, tests_failed);
    printf("============================================================\n");

    return tests_failed > 0 ? 1 : 0;
}
