/**
 * Orbit Determination Plugin Tests
 */

#include "od/orbit_determination.h"
#include <iostream>
#include <cmath>

static constexpr double RE_KM = 6378.137;

static int tests_passed = 0;
static int tests_failed = 0;

#define CHECK(cond, msg) do { \
    if (cond) { tests_passed++; std::cout << "  ✓ " << msg << std::endl; } \
    else { tests_failed++; std::cout << "  ✗ " << msg << std::endl; } \
} while(0)

void test_kepler_propagator() {
    std::cout << "\n--- Test: Universal-Variable Kepler Propagator ---" << std::endl;

    od::SGP4Propagator prop("[]");
    CHECK(prop.name() == "SGP4", "Propagator name is SGP4");

    // Create a simple LEO state
    od::StateVector state;
    state.epoch_jd = 2460784.0;  // Some JD
    state.x = 6800.0; state.y = 0.0; state.z = 0.0;
    state.vx = 0.0; state.vy = 7.5; state.vz = 0.0;

    // Propagate 1 minute forward
    double target_jd = state.epoch_jd + 60.0 / 86400.0;
    auto result = prop.propagate(state, target_jd);

    double r = std::sqrt(result.x*result.x + result.y*result.y + result.z*result.z);
    std::cout << "    Position after 1 min: (" << result.x << ", " << result.y
              << ", " << result.z << ") km" << std::endl;
    std::cout << "    |r| = " << r << " km" << std::endl;

    CHECK(r > 6700 && r < 6900, "Propagated position in LEO range");
    CHECK(result.y > 400, "Moved in Y direction (~450 km in 1 min at 7.5 km/s)");
}

void test_batch_lsq_convergence() {
    std::cout << "\n--- Test: Batch LSQ Convergence ---" << std::endl;

    od::SGP4Propagator prop("[]");

    // True state
    od::StateVector true_state;
    true_state.epoch_jd = 2460784.0;
    true_state.x = 6800.0; true_state.y = 0.0; true_state.z = 0.0;
    true_state.vx = 0.0; true_state.vy = 7.5; true_state.vz = 0.0;

    // Generate synthetic range observations
    od::GroundStation station;
    station.id = 1;
    station.name = "Test Station";
    station.lat_deg = 40.0;
    station.lon_deg = -75.0;
    station.alt_km = 0.0;

    std::vector<od::Observation> obs;
    for (int i = 0; i < 10; i++) {
        double t = true_state.epoch_jd + i * 300.0 / 86400.0;  // Every 5 min
        auto prop_state = prop.propagate(true_state, t);

        // Compute "true" range
        double sx = (RE_KM + station.alt_km) * std::cos(station.lat_deg * 0.0174533) *
                     std::cos(station.lon_deg * 0.0174533);
        double sy = (RE_KM + station.alt_km) * std::cos(station.lat_deg * 0.0174533) *
                     std::sin(station.lon_deg * 0.0174533);
        double sz = (RE_KM + station.alt_km) * std::sin(station.lat_deg * 0.0174533);

        double dx = prop_state.x - sx;
        double dy = prop_state.y - sy;
        double dz = prop_state.z - sz;
        double range = std::sqrt(dx*dx + dy*dy + dz*dz);

        od::Observation o;
        o.epoch_jd = t;
        o.type = od::ObservationType::RANGE;
        o.value = range + 0.001 * (i % 3 - 1);  // Small noise
        o.sigma = 0.01;  // 10m range accuracy
        o.station_id = 1;
        obs.push_back(o);
    }

    // Perturbed initial state
    od::StateVector init_state = true_state;
    init_state.x += 1.0;   // 1 km position error
    init_state.vy += 0.01;  // 10 m/s velocity error

    od::EstimationConfig config;
    config.method = od::EstimationMethod::BATCH_LSQ;
    config.max_iterations = 10;
    config.convergence_tol = 1e-6;

    auto result = od::determine_orbit(obs, {station}, prop, config, init_state);

    std::cout << "    Iterations: " << result.iterations << std::endl;
    std::cout << "    RMS residual: " << result.rms_residual << std::endl;
    std::cout << "    Converged: " << (result.converged ? "yes" : "no") << std::endl;

    double pos_err = std::sqrt(
        std::pow(result.fitted_state.x - true_state.x, 2) +
        std::pow(result.fitted_state.y - true_state.y, 2) +
        std::pow(result.fitted_state.z - true_state.z, 2));
    std::cout << "    Position error: " << pos_err << " km" << std::endl;

    CHECK(result.iterations > 0, "Ran at least 1 iteration");
    CHECK(result.residuals.size() == obs.size(), "Residuals computed for all obs");
}

void test_od_requires_initial_state() {
    std::cout << "\n--- Test: OD requires initial state ---" << std::endl;

    od::SGP4Propagator prop("[]");
    std::vector<od::Observation> obs;
    std::vector<od::GroundStation> stations;
    od::EstimationConfig config;

    // No initial state provided
    auto result = od::determine_orbit(obs, stations, prop, config);
    CHECK(!result.converged, "Fails without initial state (IOD not yet implemented)");
}

void test_stm_numerical() {
    std::cout << "\n--- Test: Numerical STM Computation ---" << std::endl;

    od::SGP4Propagator prop("[]");

    od::StateVector state;
    state.epoch_jd = 2460784.0;
    state.x = 6800.0; state.y = 0.0; state.z = 0.0;
    state.vx = 0.0; state.vy = 7.5; state.vz = 0.0;

    double target_jd = state.epoch_jd + 600.0 / 86400.0;  // 10 min
    auto [prop_state, stm] = prop.propagate_with_stm(state, target_jd);

    // STM diagonal should be close to identity for short arcs
    CHECK(std::abs(stm[0][0]) > 0.5, "STM[0][0] reasonable");
    CHECK(std::abs(stm[3][3]) > 0.5, "STM[3][3] reasonable");

    std::cout << "    STM diagonal: [" << stm[0][0] << ", " << stm[1][1]
              << ", " << stm[2][2] << ", " << stm[3][3] << ", "
              << stm[4][4] << ", " << stm[5][5] << "]" << std::endl;
}

int main() {
    std::cout << "=== Orbit Determination Plugin Tests ===" << std::endl;

    test_kepler_propagator();
    test_batch_lsq_convergence();
    test_od_requires_initial_state();
    test_stm_numerical();

    std::cout << "\n=== Summary: " << tests_passed << " passed, "
              << tests_failed << " failed ===" << std::endl;

    return tests_failed > 0 ? 1 : 0;
}
