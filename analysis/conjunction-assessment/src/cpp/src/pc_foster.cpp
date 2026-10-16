#include "conjunction/pc_integral.h"
#include <array>
#include <vector>
#include <limits>

namespace conjunction {
namespace pc_disk_detail {
constexpr double sqrt_two = 1.4142135623730950488;
constexpr double inv_sqrt_two_pi = 0.39894228040143267794;

// Avoid subtracting two CDF values rounded to one in the positive tail.
double normal_interval(double lo, double hi) {
    if (lo >= hi) return 0;
    if (lo > 0) return 0.5 * (std::erfc(lo / sqrt_two) - std::erfc(hi / sqrt_two));
    if (hi < 0) return 0.5 * (std::erfc(-hi / sqrt_two) - std::erfc(-lo / sqrt_two));
    return 0.5 * (std::erf(hi / sqrt_two) - std::erf(lo / sqrt_two));
}

// Embedded Gauss(7)-Kronrod(15) rule. Split around known Gaussian scales so
// an arbitrarily thin density cannot sit between every quadrature node.
template<class F>
double adaptive(const F& f, double a, double b, int depth, PcResult& result, double& total_error) {
    constexpr double nodes[] = {0.9914553711208126, 0.9491079123427585,
        0.8648644233597691, 0.7415311855993944, 0.5860872354676911,
        0.4058451513773972, 0.2077849550078985, 0.0};
    constexpr double wk[] = {0.02293532201052922, 0.06309209262997855,
        0.1047900103222502, 0.1406532597155259, 0.1690047266392679,
        0.1903505780647854, 0.2044329400752989, 0.2094821410847278};
    constexpr double wg[] = {0.1294849661688697, 0.2797053914892766,
        0.3818300505051189, 0.4179591836734694};
    const double mid = (a + b) * 0.5, half = (b - a) * 0.5;
    const double center = f(mid);
    double k = wk[7] * center, g = wg[3] * center;
    for (int i = 0; i < 7; ++i) {
        double pair = f(mid - half * nodes[i]) + f(mid + half * nodes[i]);
        k += wk[i] * pair;
        if (i % 2) g += wg[i / 2] * pair;
    }
    result.iterations += 15;
    k *= half; g *= half;
    const double err = std::abs(k - g);
    if (err <= 2e-10 * std::abs(k) + 1e-300 || mid == a || mid == b || depth == 0) {
        total_error += err;
        return k;
    }
    return adaptive(f, a, mid, depth - 1, result, total_error) +
           adaptive(f, mid, b, depth - 1, result, total_error);
}
} // namespace pc_disk_detail

PcResult gaussian_disk_integral(const BPlaneGeometry& bp, bool remediate) {
    PcResult result;
    result.method = "FOSTER-2D";
    const double radius = bp.combined_radius;
    const double values[] = {bp.xi, bp.zeta, bp.sigma_xx, bp.sigma_xz, bp.sigma_zz, radius};
    for (double v : values) {
        if (!std::isfinite(v)) {
            result.converged = false;
            result.failure_reason = "Non-finite disk geometry";
            return result;
        }
    }
    if (radius < 0) {
        result.converged = false;
        result.failure_reason = "Negative hard-body radius";
        return result;
    }
    if (radius == 0) return result;
    double high, low;
    bp.eigenvalues(high, low);
    if (!remediate && (!(high > 0) || !(low > 0))) {
        result.converged = false;
        result.failure_reason = "Disk covariance is not positive definite";
        return result;
    }
    if (!std::isfinite(high) || !std::isfinite(low)) {
        result.converged = false;
        result.failure_reason = "Covariance eigenvalues overflowed";
        return result;
    }
    const double floor = remediate ? (1e-4 * radius) * (1e-4 * radius) : 0;
    result.covariance_remediated = low < floor || high < floor;
    high = std::max(high, floor); low = std::max(low, floor);
    const double sx = std::sqrt(low), sy = std::sqrt(high);
    double my, mx;
    bp.rotated_miss(my, mx);
    result.mahalanobis_2d = std::hypot(mx / sx, my / sy);
    // Integrate in standard-normal coordinates along the narrow axis. The
    // omitted normal tails beyond +/-40 are below double's representable range.
    const double a = std::max(-40.0, (-radius - mx) / sx);
    const double b = std::min(40.0, (radius - mx) / sx);
    double total_error = 0;
    if (a < b) {
        auto density = [&](double z) {
            const double x = mx + sx * z;
            const double height = std::sqrt(std::max(0.0, (radius - x) * (radius + x)));
            const double mass = pc_disk_detail::normal_interval((-height - my) / sy, (height - my) / sy);
            return pc_disk_detail::inv_sqrt_two_pi * std::exp(-0.5 * z * z) * mass;
        };
        std::vector<double> points{a, b};
        for (double z : {-32., -24., -16., -12., -8., -4., -2., 0., 2., 4., 8., 12., 16., 24., 32.})
            if (z > a && z < b) points.push_back(z);
        std::sort(points.begin(), points.end());
        for (size_t i = 1; i < points.size(); ++i)
            result.probability += pc_disk_detail::adaptive(density, points[i-1], points[i], 24, result, total_error);
    }
    result.probability = std::clamp(result.probability, 0.0, 1.0);
    // Sum leaf estimates so a depth-limited endpoint is judged against the
    // complete integral, including in very small-probability cases.
    if (total_error > 2e-9 * result.probability + 1e-300) {
        result.converged = false;
        result.failure_reason = "Disk quadrature error exceeds relative budget";
    }
    // This historical spherical approximation is a separately labelled
    // diagnostic, never a bound on an anisotropic probability.
    result.max_probability = AlfanoMaxPc().compute(bp).probability;
    return result;
}

PcResult Foster2D::compute(const BPlaneGeometry& bp) const {
    return gaussian_disk_integral(bp);
}
} // namespace conjunction
