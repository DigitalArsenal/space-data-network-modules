/**
 * SupGP Pipeline Test
 *
 * Tests the full pipeline:
 *   1. Parse SpaceX MEME ephemeris
 *   2. Fit SGP4 elements via Levenberg-Marquardt
 *   3. Compare fit quality (RMS) to CelesTrak SupGP reference
 *
 * Test data: real MEME file downloaded from SpaceX API
 */

#include "od/meme_parser.h"
#include "od/sgp4_fitter.h"

#include <iostream>
#include <fstream>
#include <cmath>
#include <sstream>

using namespace od;

static int tests_passed = 0;
static int tests_failed = 0;

#define CHECK(cond, msg) do { \
    if (cond) { tests_passed++; std::cout << "  ✓ " << msg << std::endl; } \
    else { tests_failed++; std::cout << "  ✗ " << msg << std::endl; } \
} while(0)

// ── Test: MEME timestamp parsing ──

void test_timestamp_parsing() {
    std::cout << "\n--- Test: MEME Timestamp Parsing ---" << std::endl;

    // 2026-03-10 20:16:42 UTC → DOY 069
    double jd = meme_timestamp_to_jd("2026069201642.000");
    CHECK(jd > 2460000, "JD is reasonable (>" + std::to_string(jd) + ")");

    // Check roundtrip
    std::string iso = jd_to_iso_supgp(jd);
    std::cout << "    MEME: 2026069201642.000 → JD: " << std::fixed << jd
              << " → ISO: " << iso << std::endl;

    CHECK(iso.find("2026-03-10") != std::string::npos, "Date roundtrip correct");
    CHECK(iso.find("20:16:42") != std::string::npos, "Time roundtrip correct");

    // ISO parsing
    double jd2 = iso_to_jd("2026-03-10 20:16:42 UTC");
    CHECK(std::abs(jd - jd2) < 1e-6, "ISO and MEME timestamps match (Δ=" +
          std::to_string(std::abs(jd - jd2) * 86400) + "s)");
}

// ── Test: MEME filename parsing ──

void test_filename_parsing() {
    std::cout << "\n--- Test: MEME Filename Parsing ---" << std::endl;

    auto h = parse_meme_filename(
        "MEME_51878_STARLINK-3575_0692016_Operational_1457468220_UNCLASSIFIED.txt");

    CHECK(h.norad_cat_id == 51878, "NORAD ID = 51878");
    CHECK(h.object_name == "STARLINK-3575", "Name = STARLINK-3575");
    CHECK(h.cospar_id == "0692016", "COSPAR = 0692016");
    CHECK(h.status == "Operational", "Status = Operational");
    CHECK(h.unix_timestamp == 1457468220, "Unix timestamp correct");
}

// ── Test: MEME file parsing ──

void test_meme_parsing() {
    std::cout << "\n--- Test: MEME Content Parsing ---" << std::endl;

    // Minimal MEME content
    std::string meme_content =
        "created:2026-03-10 20:32:53 UTC\n"
        "ephemeris_start:2026-03-10 20:16:42 UTC ephemeris_stop:2026-03-13 20:16:42 UTC step_size:60\n"
        "ephemeris_source:blend\n"
        "UVW\n"
        "2026069201642.000 2331.2303823166 -3812.9956790343 -5288.3093377396 7.1279396227 1.8278970842 1.8252801029\n"
        "5.0574356535e-07 -4.0409074495e-07 7.9867014315e-07 -1.5244353051e-10 2.2405205309e-10 1.3019804582e-06 8.6964446628e-10\n"
        "-9.2645027173e-10 -1.4154697945e-12 2.0332016107e-12 -4.8806160534e-10 4.2160627916e-10 1.9653622789e-12 -8.4753151771e-13\n"
        "5.2167151149e-13 -3.5430236412e-13 -1.9835853617e-13 1.7374846904e-09 -6.5771401381e-16 2.6012134046e-15 5.4232564737e-12\n"
        "2026069201742.000 2753.5753612189 -3695.1830223004 -5167.4424341778 6.9451594823 2.0977895841 2.2021774396\n"
        "5.5877928873e-07 -4.7375264519e-07 9.1102189897e-07 -2.1752319120e-10 4.1022000836e-10 1.5237983513e-06 9.7534909273e-10\n"
        "-1.0742139295e-09 -1.7844400970e-12 2.2539013390e-12 -5.4098450089e-10 4.9252228263e-10 2.2865893169e-12 -9.5425673314e-13\n"
        "5.7442159873e-13 -5.2862580271e-13 2.2079571161e-13 1.9544407278e-09 -1.3018409197e-15 3.0161098392e-15 5.1863337220e-12\n"
        "2026069201842.000 3164.0497097397 -3561.4406046759 -5024.2367974268 6.7323931239 2.3586995247 2.5696384902\n"
        "6.1526243750e-07 -5.5175648026e-07 1.0420883160e-06 -2.9911207274e-10 6.5538787474e-10 1.7697659451e-06 1.0887857305e-09\n"
        "-1.2415650564e-09 -2.2403173610e-12 2.4917480116e-12 -5.9748245532e-10 5.7189693440e-10 2.6325665880e-12 -1.0690003735e-12\n"
        "6.3090290772e-13 -7.1251333042e-13 6.7782739014e-13 2.1394109823e-09 -1.9784042803e-15 3.3732085227e-15 4.9203888241e-12\n";

    auto meme = parse_meme(meme_content);

    CHECK(meme.header.step_size_sec == 60, "Step size = 60s");
    CHECK(meme.header.reference_frame == "UVW", "Frame = UVW");
    CHECK(meme.header.ephemeris_source == "blend", "Source = blend");
    CHECK(meme.points.size() == 3, "Parsed 3 data points");

    if (meme.points.size() >= 1) {
        auto& p = meme.points[0];
        CHECK(std::abs(p.x - 2331.23) < 1.0, "First point X ≈ 2331 km");
        CHECK(std::abs(p.y - (-3812.99)) < 1.0, "First point Y ≈ -3813 km");
        CHECK(std::abs(p.z - (-5288.30)) < 1.0, "First point Z ≈ -5288 km");
        CHECK(p.has_covariance, "Has covariance data");

        double r = std::sqrt(p.x*p.x + p.y*p.y + p.z*p.z);
        double alt = r - 6378.137;
        std::cout << "    |r| = " << r << " km, alt = " << alt << " km" << std::endl;
        CHECK(alt > 300 && alt < 600, "Altitude in Starlink range (300-600 km)");
    }

    if (meme.points.size() >= 2) {
        double dt = (meme.points[1].epoch_jd - meme.points[0].epoch_jd) * 86400;
        CHECK(std::abs(dt - 60.0) < 0.1, "Time step = 60s (got " +
              std::to_string(dt) + "s)");
    }
}

// ── Test: Cartesian → Keplerian conversion ──

void test_cartesian_to_keplerian() {
    std::cout << "\n--- Test: Cartesian → Keplerian ---" << std::endl;

    // ISS-like orbit: ~408 km altitude, ~51.6° inclination
    double x = 6678.0, y = 0.0, z = 0.0;    // km (at ascending node)
    double vx = 0.0, vy = 5.38, vz = 5.94;  // km/s (~51.6° inc)

    auto kep = cartesian_to_keplerian(x, y, z, vx, vy, vz);
    double a = kep[0], e = kep[1], inc = kep[2] * 180.0/M_PI;

    std::cout << "    a = " << a << " km, e = " << e
              << ", i = " << inc << "°" << std::endl;

    CHECK(a > 6500 && a < 7500, "Semi-major axis in LEO range");
    CHECK(e < 0.1, "Near-circular orbit");
    CHECK(inc > 40 && inc < 65, "Inclination ~51°");
}

// ── Test: SGP4 element fitting (synthetic) ──

void test_sgp4_fitting_synthetic() {
    std::cout << "\n--- Test: SGP4 Fitting (Synthetic) ---" << std::endl;

    // Create synthetic ephemeris from a known SGP4 propagation
    // Then fit back and check RMS

    // Start with a Starlink-like orbit
    SGP4Elements truth;
    truth.epoch_jd = 2460784.5;  // Some epoch
    truth.mean_motion = 15.31;   // ~94 min period → ~475 km alt
    truth.eccentricity = 0.0001;
    truth.inclination = 53.16;
    truth.ra_of_asc_node = 175.0;
    truth.arg_of_pericenter = 80.0;
    truth.mean_anomaly = 25.0;
    truth.bstar = -3.8e-5;
    truth.mean_motion_dot = -1.2e-5;
    truth.mean_motion_ddot = 0.0;

    // Generate ephemeris points (every 60s for 8 hours = 480 points)
    // Use a simulated circular orbit (~475 km alt, 53° inc)
    std::vector<EphemerisPoint> points;
    double period_sec = 86400.0 / truth.mean_motion;
    double omega = 2.0 * M_PI / period_sec;
    double r = 6378.137 + 475.0;

    for (int i = 0; i < 480; i++) {
        double dt = i * 60.0;
        double t = truth.epoch_jd + dt / 86400.0;

        EphemerisPoint pt;
        pt.epoch_jd = t;
        pt.x = r * std::cos(omega * dt) * std::cos(53.16 * M_PI/180);
        pt.y = r * std::sin(omega * dt);
        pt.z = r * std::cos(omega * dt) * std::sin(53.16 * M_PI/180);
        pt.vx = -r * omega * std::sin(omega * dt) * std::cos(53.16 * M_PI/180);
        pt.vy = r * omega * std::cos(omega * dt);
        pt.vz = -r * omega * std::sin(omega * dt) * std::sin(53.16 * M_PI/180);
        points.push_back(pt);
    }

    FitterConfig config;
    config.max_iterations = 30;
    config.fit_window_sec = 28800;  // 8 hours
    config.subsample = 5;           // Every 5th point for speed

    auto result = fit_sgp4(points, config);

    std::cout << "    RMS: " << result.rms_km << " km" << std::endl;
    std::cout << "    Iterations: " << result.iterations << std::endl;
    std::cout << "    Converged: " << (result.converged ? "yes" : "no") << std::endl;
    std::cout << "    Fitted n: " << result.elements.mean_motion << " rev/day" << std::endl;
    std::cout << "    Fitted e: " << result.elements.eccentricity << std::endl;
    std::cout << "    Fitted i: " << result.elements.inclination << "°" << std::endl;

    CHECK(result.iterations > 0, "Ran at least 1 iteration");
    CHECK(result.rms_km < 100.0, "RMS < 100 km (synthetic)");

    // Test output formatting
    std::string csv = elements_to_csv(result.elements);
    std::string json = elements_to_json(result.elements);
    CHECK(!csv.empty(), "CSV output generated");
    CHECK(json.find("MEAN_MOTION") != std::string::npos, "JSON has MEAN_MOTION field");
    CHECK(json.find("RMS") != std::string::npos, "JSON has RMS field");

    std::cout << "    CSV: " << csv.substr(0, 80) << "..." << std::endl;
}

// ── Test: Real MEME file (if available) ──

void test_real_meme() {
    std::cout << "\n--- Test: Real MEME File ---" << std::endl;

    // Try to load test MEME file from various paths
    std::string path = "tests/data/test_meme.txt";
    std::ifstream f(path);
    if (!f.is_open()) { path = "../tests/data/test_meme.txt"; f.open(path); }
    if (!f.is_open()) { path = "src/cpp/tests/data/test_meme.txt"; f.open(path); }
    if (!f.is_open()) { path = "../src/cpp/tests/data/test_meme.txt"; f.open(path); }

    if (!f.is_open()) {
        std::cout << "  ⚠ No test MEME file found (tests/data/test_meme.txt)" << std::endl;
        std::cout << "    Download one with:" << std::endl;
        std::cout << "    curl -o tests/data/test_meme.txt \\" << std::endl;
        std::cout << "      'https://api.starlink.com/public-files/ephemerides/MEME_51878_STARLINK-3575_0692016_Operational_1457468220_UNCLASSIFIED.txt'"
                  << std::endl;
        return;
    }

    std::string content((std::istreambuf_iterator<char>(f)),
                         std::istreambuf_iterator<char>());

    auto meme = parse_meme(content);
    CHECK(meme.points.size() > 100, "Parsed " + std::to_string(meme.points.size()) + " ephemeris points");

    if (meme.points.size() < 10) return;

    // Check data quality
    double r0 = std::sqrt(meme.points[0].x * meme.points[0].x +
                           meme.points[0].y * meme.points[0].y +
                           meme.points[0].z * meme.points[0].z);
    double alt0 = r0 - 6378.137;
    std::cout << "    First point: r=" << r0 << " km, alt=" << alt0 << " km" << std::endl;
    CHECK(alt0 > 200 && alt0 < 700, "Altitude in Starlink range");

    // Fit SGP4 elements
    FitterConfig config;
    config.max_iterations = 50;
    config.fit_window_sec = 28800;  // 8 hours
    config.subsample = 10;          // Every 10th point (every 10 min)

    auto result = fit_sgp4_meme(meme, config);

    std::cout << "    Fit RMS:     " << result.rms_km << " km" << std::endl;
    std::cout << "    Iterations:  " << result.iterations << std::endl;
    std::cout << "    Converged:   " << (result.converged ? "yes" : "no") << std::endl;
    std::cout << "    Mean motion: " << result.elements.mean_motion << " rev/day" << std::endl;
    std::cout << "    Eccentr.:    " << result.elements.eccentricity << std::endl;
    std::cout << "    Inclination: " << result.elements.inclination << "°" << std::endl;
    std::cout << "    RAAN:        " << result.elements.ra_of_asc_node << "°" << std::endl;
    std::cout << "    Arg peri:    " << result.elements.arg_of_pericenter << "°" << std::endl;
    std::cout << "    Mean anom:   " << result.elements.mean_anomaly << "°" << std::endl;
    std::cout << "    B*:          " << result.elements.bstar << std::endl;

    CHECK(result.rms_km < 10.0, "RMS < 10 km (CelesTrak target: < 1 km)");

    // Compare to CelesTrak target (~0.247 km for this satellite)
    if (result.rms_km < 1.0) {
        std::cout << "    ★ RMS < 1 km — competitive with CelesTrak!" << std::endl;
    }

    // Output formatted record
    std::cout << "\n    SupGP JSON:" << std::endl;
    std::cout << "    " << elements_to_json(result.elements) << std::endl;
}

// ── Test: MANIFEST parsing ──

void test_manifest_parsing() {
    std::cout << "\n--- Test: MANIFEST.txt Parsing ---" << std::endl;

    std::string manifest =
        "MEME_51878_STARLINK-3575_0692016_Operational_1457468220_UNCLASSIFIED.txt\n"
        "MEME_65701_STARLINK-35046_0691818_Operational_1457461140_UNCLASSIFIED.txt\n"
        "MEME_60907_STARLINK-11226_0691934_Operational_1457465700_UNCLASSIFIED.txt\n";

    auto files = parse_manifest(manifest);
    CHECK(files.size() == 3, "Parsed 3 filenames");

    if (files.size() >= 1) {
        auto h = parse_meme_filename(files[0]);
        CHECK(h.norad_cat_id == 51878, "First file NORAD = 51878");
    }
}

int main() {
    std::cout << "=== SupGP Pipeline Tests ===" << std::endl;

    test_timestamp_parsing();
    test_filename_parsing();
    test_meme_parsing();
    test_cartesian_to_keplerian();
    test_manifest_parsing();
    test_sgp4_fitting_synthetic();
    test_real_meme();

    std::cout << "\n=== Summary: " << tests_passed << " passed, "
              << tests_failed << " failed ===" << std::endl;

    return tests_failed > 0 ? 1 : 0;
}
