#include "conjunction/pc_maximum.h"

#include <cstdio>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <vector>

using namespace conjunction;
namespace {
int passed = 0, failed = 0;
void check(bool condition, const char* message) {
    if (condition) ++passed;
    else { ++failed; std::printf("FAIL: %s\n", message); }
}

std::vector<std::vector<std::string>> csv(const char* name) {
    std::ifstream input(std::string(CONJUNCTION_TEST_FIXTURE_DIR) + "/" + name);
    if (!input) throw std::runtime_error(std::string("Missing fixture ") + name);
    std::string line;
    std::getline(input, line);
    std::vector<std::vector<std::string>> rows;
    while (std::getline(input, line)) {
        std::istringstream stream(line);
        std::vector<std::string> row;
        std::string value;
        while (std::getline(stream, value, ',')) row.push_back(value);
        rows.push_back(row);
    }
    return rows;
}

BPlaneGeometry geometry(const std::vector<std::string>& row, int start) {
    BPlaneGeometry result;
    result.xi = std::stod(row[start]);
    result.zeta = std::stod(row[start + 1]);
    result.sigma_xx = std::stod(row[start + 2]);
    result.sigma_xz = std::stod(row[start + 3]);
    result.sigma_zz = std::stod(row[start + 4]);
    result.combined_radius = std::stod(row[start + 5]);
    return result;
}

void cara_frisbee() {
    // Source, epoch, frames, units, tolerances and rationale for every row
    // are in cara_frisbee.csv and fixtures/NOTICE-frisbee.md.
    double max_relative = 0, max_python_relative = 0;
    std::printf("CARA Frisbee case, expected, actual, relative error, acceptance tolerance\n");
    for (const auto& row : csv("cara_frisbee.csv")) {
        auto region = row[7] == "circle" ? FrisbeeRegion::Circle : FrisbeeRegion::EqualAreaSquare;
        auto result = FrisbeeMaxPc(region).compute(geometry(row, 1));
        const double expected = std::stod(row[8]);
        const double abs_tol = std::stod(row[9]), rel_tol = std::stod(row[10]);
        const double relative = std::abs(result.probability / expected - 1);
        const double python_reference = std::stod(row[11]);
        max_relative = std::max(max_relative, relative);
        max_python_relative = std::max(max_python_relative,
            std::abs(result.probability / python_reference - 1));
        check(result.converged, "Frisbee integral converges");
        check(std::abs(result.probability - expected) <= std::max(abs_tol, rel_tol * expected),
              row[0].c_str());
        check(std::abs(result.probability / python_reference - 1) <= 1e-7,
              "Frisbee matches independent Python math port");
        if (region == FrisbeeRegion::Circle) {
            check(std::abs(result.probability / std::stod(row[12]) - 1) <= 1e-4,
                  "Frisbee populated-secondary integral CARA relative tolerance");
        }
        std::printf("%s, %.12g, %.12g, %.6g, %g %s\n", row[0].c_str(), expected,
            result.probability, relative, abs_tol > 0 ? abs_tol : rel_tol, abs_tol > 0 ? "abs" : "rel");
    }
    std::printf("CARA Frisbee max relative error: %.12g; vs independent Python: %.12g\n",
                max_relative, max_python_relative);
}

void scaled_maximum() {
    // Source: independent SciPy normal integral and scalar optimization,
    // synthetic km/km² encounter geometries at arbitrary common epoch;
    // tolerance rationale is in fixtures/NOTICE-frisbee.md.
    std::printf("Shape maximum case, max Pc, scipy Pc, scale, scan maximum, spherical ratio\n");
    double max_reference_error = 0;
    for (const auto& row : csv("pc_scaled_maximum_reference.csv")) {
        const auto bp = geometry(row, 2);
        const auto result = shape_scaled_maximum(bp);
        const double expected = std::stod(row[8]);
        const double reference_error = std::abs(result.pc.probability / expected - 1);
        max_reference_error = std::max(max_reference_error, reference_error);
        check(result.pc.converged, "Shape maximum converges");
        check(reference_error <= 1e-7, "Shape maximum matches independent SciPy");
        check(result.pc.upper_probability >= expected * (1 - 1e-9),
              "Global scale-interval envelope bounds independent SciPy maximum");
        check(result.pc.upper_probability <= result.pc.probability * (1 + 1.01e-9),
              "Global maximum interval closes to relative probability budget");
        // Scan a much wider interval than the expected peak; this checks
        // that the reported maximum bounds all sampled covariance scales.
        double scanned_max = 0;
        for (int i = 0; i <= 1600; ++i) {
            const double scale = std::exp(-16 + 32.0 * i / 1600);
            BPlaneGeometry scaled = bp;
            scaled.sigma_xx *= scale; scaled.sigma_xz *= scale; scaled.sigma_zz *= scale;
            scanned_max = std::max(scanned_max, Foster2D().compute(scaled).probability);
        }
        check(result.pc.probability >= scanned_max * (1 - 1e-6), "Shape maximum bounds brute-force scale scan");
        const double spherical = AlfanoMaxPc().compute(bp).probability;
        check(result.pc.probability > spherical, "Elliptical maximum exceeds spherical estimate");
        std::printf("%s, %.12g, %.12g, %.9g, %.12g, %.9g\n", row[0].c_str(),
            result.pc.probability, expected, result.covariance_scale, scanned_max,
            result.pc.probability / spherical);
    }
    std::printf("Shape maximum max relative error vs SciPy: %.12g\n", max_reference_error);

    // Closed-form convex-disk limits under C -> 0: inside = 1,
    // tangent boundary = 1/2; km, abstract encounter frame, timeless.
    BPlaneGeometry inside;
    inside.sigma_xx = 1; inside.sigma_zz = 0.25;
    inside.combined_radius = 0.01;
    check(ShapeScaledMaxPc().compute(inside).probability == 1, "Interior limiting maximum is one");
    inside.xi = inside.combined_radius;
    check(ShapeScaledMaxPc().compute(inside).probability == 0.5, "Boundary limiting maximum is one half");
    inside.sigma_zz = -1;
    check(!ShapeScaledMaxPc().compute(inside).converged, "Invalid shape rejected");

    // CARA Ka<=1 branch leaves the known covariance unchanged. The two
    // calls are deliberately compared here to verify branch semantics.
    inside.xi = 0.001; inside.sigma_zz = 0.25;
    check(FrisbeeMaxPc().compute(inside).probability == Foster2D().compute(inside).probability,
          "Frisbee Ka<=1 preserves known covariance");
}
} // namespace

int main() {
    cara_frisbee();
    scaled_maximum();
    std::printf("Maximum Pc tests: %d passed, %d failed\n", passed, failed);
    return failed ? 1 : 0;
}
