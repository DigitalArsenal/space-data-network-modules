/**
 * SGP4 Propagator Plugin Tests
 */

#include "sgp4_prop/propagator.h"
#include <iostream>
#include <cmath>
#include <cassert>

using namespace sgp4_prop;

static int tests_passed = 0;
static int tests_failed = 0;

#define CHECK(cond, msg) do { \
    if (cond) { tests_passed++; std::cout << "  ✓ " << msg << std::endl; } \
    else { tests_failed++; std::cout << "  ✗ " << msg << std::endl; } \
} while(0)

void test_gp_parsing() {
    std::cout << "\n--- Test: GP JSON Parsing ---" << std::endl;

    std::string json = R"JSON([{
        "OBJECT_NAME": "ISS (ZARYA)",
        "OBJECT_ID": "1998-067A",
        "EPOCH": "2026-03-09T09:20:49.941888",
        "MEAN_MOTION": 15.50099,
        "ECCENTRICITY": 0.0001234,
        "INCLINATION": 51.6435,
        "RA_OF_ASC_NODE": 102.5175,
        "ARG_OF_PERICENTER": 81.5233,
        "MEAN_ANOMALY": 278.5887,
        "EPHEMERIS_TYPE": 0,
        "CLASSIFICATION_TYPE": "U",
        "NORAD_CAT_ID": 25544,
        "ELEMENT_SET_NO": 999,
        "REV_AT_EPOCH": 12345,
        "BSTAR": 0.000045678,
        "MEAN_MOTION_DOT": 0.00012345,
        "MEAN_MOTION_DDOT": 0
    }])JSON";

    auto gps = parse_gp_json(json);
    CHECK(gps.size() == 1, "Parsed 1 GP element");
    CHECK(gps[0].object_name == "ISS (ZARYA)", "Object name correct");
    CHECK(gps[0].norad_cat_id == 25544, "NORAD ID correct");
    CHECK(std::abs(gps[0].mean_motion - 15.50099) < 1e-5, "Mean motion correct");
    CHECK(gps[0].epoch_jd > 2460000, "Epoch JD computed");
}

void test_single_propagation() {
    std::cout << "\n--- Test: Single Epoch Propagation ---" << std::endl;

    GPElement gp;
    gp.object_name = "ISS (ZARYA)";
    gp.object_id = "1998-067A";
    gp.epoch = "2026-03-09T09:20:49.941888";
    gp.mean_motion = 15.50099;
    gp.eccentricity = 0.0001234;
    gp.inclination = 51.6435;
    gp.ra_of_asc_node = 102.5175;
    gp.arg_of_pericenter = 81.5233;
    gp.mean_anomaly = 278.5887;
    gp.bstar = 0.000045678;
    gp.mean_motion_dot = 0.00012345;
    gp.mean_motion_ddot = 0;
    gp.epoch_jd = epoch_to_jd(gp.epoch);

    // Propagate 1 hour forward
    double target_jd = gp.epoch_jd + 1.0 / 24.0;
    auto sv = propagate_to_epoch(gp, target_jd);

    double r = std::sqrt(sv.x*sv.x + sv.y*sv.y + sv.z*sv.z);
    double v = std::sqrt(sv.vx*sv.vx + sv.vy*sv.vy + sv.vz*sv.vz);

    std::cout << "    Position: (" << sv.x << ", " << sv.y << ", " << sv.z << ") km" << std::endl;
    std::cout << "    Velocity: (" << sv.vx << ", " << sv.vy << ", " << sv.vz << ") km/s" << std::endl;
    std::cout << "    |r| = " << r << " km, |v| = " << v << " km/s" << std::endl;

    CHECK(r > 6300 && r < 6900, "Position radius in LEO range (6300-6900 km)");
    CHECK(v > 7.0 && v < 8.0, "Velocity in LEO range (7-8 km/s)");
}

void test_range_propagation() {
    std::cout << "\n--- Test: Range Propagation ---" << std::endl;

    GPElement gp;
    gp.object_name = "TEST SAT";
    gp.object_id = "2020-001A";
    gp.epoch = "2026-03-09T00:00:00.000000";
    gp.mean_motion = 15.0;
    gp.eccentricity = 0.001;
    gp.inclination = 45.0;
    gp.ra_of_asc_node = 100.0;
    gp.arg_of_pericenter = 90.0;
    gp.mean_anomaly = 0.0;
    gp.bstar = 0.0001;
    gp.mean_motion_dot = 0.0;
    gp.mean_motion_ddot = 0.0;
    gp.epoch_jd = epoch_to_jd(gp.epoch);

    PropagationConfig config;
    config.duration_days = 1.0;
    config.step_seconds = 600.0;  // 10-minute steps

    auto states = propagate(gp, config);

    int expected = static_cast<int>(1.0 * 86400.0 / 600.0) + 1;
    CHECK(states.size() > 100, "Got >100 state vectors for 1-day prop at 10min steps");
    CHECK(std::abs((int)states.size() - expected) <= 1, "State count matches expected");

    // Check all positions are in LEO
    bool all_leo = true;
    for (const auto& sv : states) {
        double r = std::sqrt(sv.x*sv.x + sv.y*sv.y + sv.z*sv.z);
        if (r < 6300 || r > 7000) { all_leo = false; break; }
    }
    CHECK(all_leo, "All positions in LEO range");
}

void test_large_norad_id() {
    std::cout << "\n--- Test: Large NORAD ID (>99999) ---" << std::endl;

    GPElement gp;
    gp.object_name = "FUTURE SAT";
    gp.object_id = "2030-001A";
    gp.epoch = "2026-03-09T00:00:00.000000";
    gp.norad_cat_id = 500000;  // Beyond Alpha-5
    gp.mean_motion = 14.5;
    gp.eccentricity = 0.002;
    gp.inclination = 53.0;
    gp.ra_of_asc_node = 200.0;
    gp.arg_of_pericenter = 45.0;
    gp.mean_anomaly = 180.0;
    gp.bstar = 0.00005;
    gp.mean_motion_dot = 0.0;
    gp.mean_motion_ddot = 0.0;
    gp.epoch_jd = epoch_to_jd(gp.epoch);

    auto sv = propagate_to_epoch(gp, gp.epoch_jd + 0.5);

    double r = std::sqrt(sv.x*sv.x + sv.y*sv.y + sv.z*sv.z);
    CHECK(r > 6300 && r < 7200, "NORAD 500000 propagates (direct GP path, no TLE)");
    std::cout << "    |r| = " << r << " km" << std::endl;
}

void test_propagation_consistency() {
    std::cout << "\n--- Test: Propagation at Epoch = GP Position ---" << std::endl;

    GPElement gp;
    gp.object_name = "CONSISTENCY TEST";
    gp.object_id = "2025-001A";
    gp.epoch = "2026-03-09T12:00:00.000000";
    gp.mean_motion = 15.2;
    gp.eccentricity = 0.0005;
    gp.inclination = 51.6;
    gp.ra_of_asc_node = 150.0;
    gp.arg_of_pericenter = 90.0;
    gp.mean_anomaly = 0.0;
    gp.bstar = 0.00003;
    gp.mean_motion_dot = 0.0;
    gp.mean_motion_ddot = 0.0;
    gp.epoch_jd = epoch_to_jd(gp.epoch);

    // Propagate to epoch (t=0) — should give consistent result
    auto sv0 = propagate_to_epoch(gp, gp.epoch_jd);
    // Propagate to epoch + 1 second
    auto sv1 = propagate_to_epoch(gp, gp.epoch_jd + 1.0/86400.0);

    double dx = sv1.x - sv0.x;
    double dy = sv1.y - sv0.y;
    double dz = sv1.z - sv0.z;
    double dist = std::sqrt(dx*dx + dy*dy + dz*dz);

    // In 1 second at ~7.5 km/s, should move ~7.5 km
    CHECK(dist > 5.0 && dist < 10.0, "1-second propagation moves ~7.5 km");
    std::cout << "    Δr in 1s = " << dist << " km" << std::endl;
}

int main() {
    std::cout << "=== SGP4 Propagator Plugin Tests ===" << std::endl;

    test_gp_parsing();
    test_single_propagation();
    test_range_propagation();
    test_large_norad_id();
    test_propagation_consistency();

    std::cout << "\n=== Summary: " << tests_passed << " passed, "
              << tests_failed << " failed ===" << std::endl;

    return tests_failed > 0 ? 1 : 0;
}
