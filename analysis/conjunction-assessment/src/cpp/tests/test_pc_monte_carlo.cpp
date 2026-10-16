/**
 * NASA CARA Alfano-2009 published Monte Carlo reference comparisons.
 * Source, inertial frame, epoch, km/km/s covariance units and time limits are
 * retained in fixtures/cara_hall.csv; see fixtures/NOTICE.md for provenance.
 *
 * This is a statistical consistency test, not a reproduction of the upstream
 * 100-million-trial precision. Before observing any output we choose 32768
 * samples per case, except rare case 7 (262144, about 42 expected hits).
 * Bernstein's Bernoulli concentration bound gives a 1% family-wise error
 * budget over 12 comparisons, conditional on the published 95% reference
 * interval. The acceptance interval includes that reference uncertainty.
 * The reported 95% Wilson interval is checked for valid probability bounds and printed.
 */
#include "conjunction/pc_fallbacks.h"
#include "../src/pc_math.h"
#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <vector>

using namespace conjunction;
using namespace conjunction::pc_detail;
namespace {
int passed = 0, failed = 0;
void check(bool condition, const std::string& label) {
    if (condition) ++passed;
    else { ++failed; std::cout << "FAIL: " << label << '\n'; }
}
struct Case {
    std::string name;
    PcEncounter encounter;
    double begin, end, reference, reference_lo, reference_hi;
    double relative_tolerance = 0;
};
std::vector<Case> read_cases() {
    std::ifstream input(std::string(CONJUNCTION_TEST_FIXTURE_DIR) + "/cara_hall.csv");
    if (!input) throw std::runtime_error("Missing cara_hall.csv");
    std::string line;
    std::getline(input, line);
    std::vector<Case> result;
    while (std::getline(input, line)) {
        std::stringstream stream(line);
        std::vector<std::string> row;
        for (std::string value; std::getline(stream, value, ',');) row.push_back(value);
        if (row.size() != 95) throw std::runtime_error("Malformed Hall reference row");
        Case c;
        c.name = row[0];
        size_t k = 1;
        for (double& value : c.encounter.primary) value = std::stod(row[k++]);
        for (double& value : c.encounter.secondary) value = std::stod(row[k++]);
        for (double& value : c.encounter.covariance_primary) value = std::stod(row[k++]);
        for (double& value : c.encounter.covariance_secondary) value = std::stod(row[k++]);
        c.encounter.combined_radius = std::stod(row[85]);
        c.encounter.has_velocity_covariance = true;
        c.begin = std::stod(row[88]); c.end = std::stod(row[89]);
        c.reference = std::stod(row[90]);
        c.reference_lo = std::stod(row[91]); c.reference_hi = std::stod(row[92]);
        result.push_back(c);
    }
    return result;
}
std::vector<Case> read_original_unit_cases() {
    std::ifstream input(std::string(CONJUNCTION_TEST_FIXTURE_DIR) + "/cara_monte_carlo_unit.csv");
    if (!input) throw std::runtime_error("Missing cara_monte_carlo_unit.csv");
    std::string line;
    std::getline(input, line);
    std::vector<Case> result;
    while (std::getline(input, line)) {
        std::stringstream stream(line);
        std::vector<std::string> row;
        for (std::string value; std::getline(stream, value, ',');) row.push_back(value);
        if (row.size() != 92) throw std::runtime_error("Malformed original Monte Carlo unit-test row");
        Case c;
        c.name = row[0];
        size_t k = 1;
        for (double& value : c.encounter.primary) value = std::stod(row[k++]);
        for (double& value : c.encounter.secondary) value = std::stod(row[k++]);
        for (double& value : c.encounter.covariance_primary) value = std::stod(row[k++]);
        for (double& value : c.encounter.covariance_secondary) value = std::stod(row[k++]);
        c.encounter.combined_radius = std::stod(row[85]);
        c.encounter.has_velocity_covariance = true;
        c.reference = std::stod(row[86]); c.relative_tolerance = std::stod(row[87]);
        c.begin = std::stod(row[88]); c.end = std::stod(row[89]);
        result.push_back(c);
    }
    return result;
}
void dynamics_tests() {
    // Independent circular two-body solution in inertial km/km/s, relative t=0.
    // T/4 rotates (r,0,0;0,v,0) to (0,r,0;-v,0,0). Tolerances cover double
    // universal-variable iteration without relaxing a physics expectation.
    constexpr double radius = 7000, mu = 398600.4418;
    const double speed = std::sqrt(mu / radius);
    V6 initial{radius, 0, 0, 0, speed, 0}, actual{};
    const double quarter = .5 * pi * std::sqrt(radius * radius * radius / mu);
    check(propagate(initial, quarter, mu, actual), "circular quarter-orbit converged");
    const V6 expected{0, radius, 0, -speed, 0, 0};
    for (int i = 0; i < 6; ++i)
        check(std::abs(actual[i] - expected[i]) < (i < 3 ? 1e-8 : 1e-10),
              "circular quarter-orbit component " + std::to_string(i));

    // Exact rectilinear covariance P(t)=Phi P0 Phi^T, Phi=[I,tI;0,I].
    // Position/velocity blocks use km², km²/s and km²/s². No orbital epoch.
    M6 covariance{}, output{}, transition{};
    for (int i = 0; i < 6; ++i) covariance[i * 6 + i] = (i + 1) * 1e-6;
    for (int i = 0; i < 3; ++i) covariance[i * 6 + i + 3] = covariance[(i + 3) * 6 + i] = 1e-7;
    constexpr double time = 37;
    check(propagate_covariance(initial, covariance, time, 0, actual, output, &transition),
          "rectilinear covariance propagation converged");
    for (int i = 0; i < 3; ++i) {
        const double pp = covariance[i * 6 + i] + 2 * time * 1e-7 + time * time * covariance[(i + 3) * 6 + i + 3];
        const double pv = 1e-7 + time * covariance[(i + 3) * 6 + i + 3];
        check(std::abs(output[i * 6 + i] - pp) < 1e-15, "rectilinear position variance");
        check(std::abs(output[i * 6 + i + 3] - pv) < 1e-15, "rectilinear cross covariance");
    }
}
PcEncounter simple_encounter() {
    PcEncounter e;
    e.gravitational_parameter = 0;
    e.secondary[4] = .1;
    e.has_velocity_covariance = true;
    for (int i = 0; i < 3; ++i) e.covariance_primary[i * 6 + i] = .01;
    return e;
}
void invalid_input_tests() {
    PcFallbackOptions options;
    options.two_body = false; options.samples = 128;
    options.time_start = -1; options.time_end = 1;
    auto valid = simple_encounter();
    for (int kind = 0; kind < 5; ++kind) {
        auto e = valid;
        if (kind == 0) e.secondary[0] = std::numeric_limits<double>::quiet_NaN();
        if (kind == 1) e.combined_radius = std::numeric_limits<double>::infinity();
        if (kind == 2) e.gravitational_parameter = std::numeric_limits<double>::quiet_NaN();
        if (kind == 3) e.covariance_primary[21] = std::numeric_limits<double>::quiet_NaN();
        if (kind == 4) e.combined_radius = -1;
        check(!pc_monte_carlo(e, options).pc.converged, "invalid MC input rejected " + std::to_string(kind));
    }
    auto invalid_window = options;
    invalid_window.time_start = 2; invalid_window.time_end = 1;
    check(!pc_monte_carlo(valid, invalid_window).pc.converged, "reversed MC window rejected");
    auto first = pc_monte_carlo(valid, options), second = pc_monte_carlo(valid, options);
    check(first.pc.converged && first.hits == second.hits &&
          first.pc.lower_probability == second.pc.lower_probability,
          "fixed seed reproduces hits and interval");

    // Non-positive conditional covariance must never be silently treated as
    // a valid Gaussian. Explicitly reported NPD remediation is allowed.
    auto e = valid;
    for (int i = 0; i < 3; ++i) {
        e.covariance_primary[(i + 3) * 6 + i + 3] = .01;
        e.covariance_primary[(i + 3) * 6 + i] = e.covariance_primary[i * 6 + i + 3] = .02;
    }
    options.time_start = 0; options.time_end = .1;
    options.angular_order = 8; options.time_intervals = 16;
    auto repaired = pc_3d_nc_cartesian(e, options);
    check(!repaired.pc.converged || repaired.covariance_repaired,
          "invalid conditional covariance rejected or explicitly repaired");
}
void compare_cases(int selected, std::uint64_t samples_override) {
    auto rows = read_cases();
    check(rows.size() == 12, "all 12 CARA published MC cases present");
    std::cout << "CARA two-body Monte Carlo: first-entry statistical comparison\n"
              << "case reference entry_estimate entry_hits/trials initial_hits Wilson95lo Wilson95hi allowable_delta seconds\n";
    for (size_t i = 0; i < rows.size(); ++i) {
        if (selected && selected != static_cast<int>(i + 1)) continue;
        const auto& c = rows[i];
        PcFallbackOptions options;
        options.time_start = c.begin; options.time_end = c.end;
        options.include_initial_overlap = false; // CARA Pc_att excludes Nc_0, without renormalization.
        options.samples = samples_override ? samples_override : (i == 6 ? 262144 : 32768);
        options.seed = 0x434152410000ULL + i + 1;
        const auto start = std::chrono::steady_clock::now();
        auto result = pc_monte_carlo(c.encounter, options);
        const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
        const double n = static_cast<double>(options.samples);
        // For Bernoulli mean p, Bernstein: error <= sqrt(2 p(1-p)L/n)
        // + 2L/(3n), where each two-sided failure probability <=2 exp(-L).
        // Maximize variance over the published probability interval.
        const double variance_p = std::clamp(.5, c.reference_lo, c.reference_hi);
        const double logarithm = std::log(2 * 12 / .01);
        const double delta = std::sqrt(2 * variance_p * (1 - variance_p) * logarithm / n) + 2 * logarithm / (3 * n);
        std::cout << c.name << ' ' << c.reference << ' ' << result.pc.probability << ' '
                  << result.hits << '/' << result.samples << ' ' << result.initial_hits << ' '
                  << result.pc.lower_probability << ' ' << result.pc.upper_probability << ' '
                  << delta << ' ' << elapsed << std::endl;
        check(result.pc.converged, c.name + " sampled trajectories converged: " + result.limitation);
        check(result.samples == options.samples, c.name + " requested sample count");
        check(result.pc.method == "SDMC-TWO-BODY-ENTRY-ONLY", c.name + " honest method identity");
        check(result.pc.probability >= c.reference_lo - delta &&
              result.pc.probability <= c.reference_hi + delta,
              c.name + " published MC statistical consistency");
        check(result.hits == result.entry_hits, c.name + " entry-only count is not renormalized");
        if (i == 11) {
            // Upstream MC excludes initial overlaps (separate Nc_0); the
            // application's default finite-window probability includes them.
            auto total_options = options;
            total_options.include_initial_overlap = true;
            const auto total = pc_monte_carlo(c.encounter, total_options);
            check(total.pc.converged && total.hits == result.initial_hits + result.entry_hits &&
                  total.initial_hits == result.initial_hits && total.entry_hits == result.entry_hits,
                  c.name + " default total equals disjoint initial plus entry counts");
            std::cout << c.name << " default_total=" << total.pc.probability
                      << " initial_probability=" << static_cast<double>(result.initial_hits) / n
                      << " entry_probability=" << result.pc.probability << std::endl;
        }
        // Confidence metadata must remain useful to consumers, particularly
        // when no sampled collision occurred: zero hits cannot imply a zero
        // upper risk bound. The published-reference test above checks the
        // estimator independently rather than duplicating its CI formula.
        check(std::isfinite(result.pc.lower_probability) &&
              std::isfinite(result.pc.upper_probability) &&
              result.pc.lower_probability >= 0 && result.pc.upper_probability <= 1 &&
              result.pc.lower_probability <= result.pc.probability &&
              result.pc.upper_probability >= result.pc.probability &&
              result.pc.upper_probability > 0,
              c.name + " valid confidence interval accompanies estimate");
    }
}
void compare_original_unit_cases() {
    const auto rows = read_original_unit_cases();
    check(rows.size() == 8, "all eight original CARA Monte Carlo unit cases present");
    std::cout << "CARA Pc_MC_Kep2body_parallel_UnitTest original expectations/tolerances\n"
              << "Cartesian Gaussian SDMC-style states; two-body dynamics; first-entry counting\n"
              << "case reference estimate relerr original_rtol entry_hits/trials initial_hits Wilson95lo Wilson95hi seconds\n";
    double maximum_relative_error = 0;
    for (size_t i = 0; i < rows.size(); ++i) {
        const auto& c = rows[i];
        PcFallbackOptions options;
        options.time_start = c.begin; options.time_end = c.end;
        options.include_initial_overlap = false;
        // Chosen before observing outputs: at least 1600 expected hits gives
        // about a four-sigma margin inside the unchanged 10% tolerance.
        // Upper limit bounds CI runtime; the smallest published p here still
        // obtains the full target. Units/ECI frame/UTC epoch/source lines are
        // recorded per fixture. Sampling remains Cartesian, whereas the
        // upstream test samples equinoctial elements: this test checks that
        // any resulting model difference fits its original tolerance.
        options.samples = std::clamp<std::uint64_t>(
            static_cast<std::uint64_t>(std::ceil(1600 / c.reference)), 32768, 1048576);
        options.seed = 0x4341524155540000ULL + i + 1;
        const auto start = std::chrono::steady_clock::now();
        const auto result = pc_monte_carlo(c.encounter, options);
        const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
        const double error = std::abs(result.pc.probability / c.reference - 1);
        maximum_relative_error = std::max(maximum_relative_error, error);
        std::cout << c.name << ' ' << c.reference << ' ' << result.pc.probability << ' '
                  << error << ' ' << c.relative_tolerance << ' ' << result.entry_hits << '/'
                  << result.samples << ' ' << result.initial_hits << ' '
                  << result.pc.lower_probability << ' ' << result.pc.upper_probability << ' '
                  << elapsed << std::endl;
        check(result.pc.converged, c.name + " original-unit sampled trajectories converged: " + result.limitation);
        check(result.samples == options.samples && result.hits == result.entry_hits,
              c.name + " original-unit sample and first-entry counts");
        check(error <= c.relative_tolerance, c.name + " original unmodified unit-test relative tolerance");
    }
    std::cout << "CARA original MC unit-test max relative error=" << maximum_relative_error << '\n';
}
} // namespace
int main(int argc, char** argv) {
    int selected = 0;
    std::uint64_t samples = 0;
    bool original_only = false;
    for (int i = 1; i < argc; ++i) {
        const std::string argument = argv[i];
        if (argument == "--case" && i + 1 < argc) selected = std::stoi(argv[++i]);
        else if (argument == "--samples" && i + 1 < argc) samples = std::stoull(argv[++i]);
        else if (argument == "--original-only") original_only = true;
        else { std::cerr << "Usage: test_pc_monte_carlo [--case 1..12] [--samples N] [--original-only]\n"; return 2; }
    }
    std::cout << std::scientific << std::setprecision(10);
    try {
        if (!original_only) { dynamics_tests(); invalid_input_tests(); compare_cases(selected, samples); }
        if (original_only || (!selected && !samples)) compare_original_unit_cases();
    }
    catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
    std::cout << "Monte Carlo assertions: " << passed << " passed, " << failed << " failed\n";
    return failed ? 1 : 0;
}
