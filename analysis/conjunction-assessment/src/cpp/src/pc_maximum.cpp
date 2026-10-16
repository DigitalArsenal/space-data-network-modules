#include "conjunction/pc_maximum.h"
#include "conjunction/pc_integral.h"

#include <array>
#include <limits>
#include <queue>

namespace conjunction {
namespace pc_maximum_detail {
constexpr double pi = 3.14159265358979323846;

bool valid_geometry(const BPlaneGeometry& geometry, double& large, double& small) {
    geometry.eigenvalues(large, small);
    return std::isfinite(geometry.xi) && std::isfinite(geometry.zeta) &&
        std::isfinite(geometry.combined_radius) && geometry.combined_radius >= 0 &&
        std::isfinite(large) && std::isfinite(small) && large > 0 && small > 0;
}

PcResult invalid_result(const std::string& name) {
    PcResult result;
    result.method = name;
    result.max_method = name;
    result.converged = false;
    result.failure_reason = "Maximum Pc requires a finite positive-definite covariance shape and nonnegative HBR";
    result.probability = std::numeric_limits<double>::quiet_NaN();
    return result;
}

double normal_interval(double low, double high) {
    constexpr double sqrt2 = 1.4142135623730950488;
    if (low > 0) return 0.5 * (std::erfc(low / sqrt2) - std::erfc(high / sqrt2));
    if (high < 0) return 0.5 * (std::erfc(-high / sqrt2) - std::erfc(-low / sqrt2));
    return 0.5 * (std::erf(high / sqrt2) - std::erf(low / sqrt2));
}

struct ScaleInterval {
    double a, b, pa, pb, upper;
    bool operator<(const ScaleInterval& other) const { return upper < other.upper; }
};

ScaleInterval bound_interval(double a, double b, double pa, double pb) {
    // beta = 1/scale. Pc(beta)/beta is a positive Laplace transform,
    // whose logarithm is convex (Holder's inequality). The line joining
    // endpoint log(Pc/beta) values bounds the whole interval from above.
    // Normalize beta by exp(-a) to avoid large inverse-scale magnitudes.
    const double width = b - a;
    if (width == 0) return {a, b, pa, pb, std::max(pa, pb)};
    const double ratio = std::exp(-width);
    const double log_pa = std::log(std::max(pa, std::numeric_limits<double>::denorm_min()));
    const double log_pb = std::log(std::max(pb, std::numeric_limits<double>::denorm_min()));
    const double slope = (log_pb - log_pa + width) / std::expm1(-width);
    const double z = slope < 0 ? std::clamp(-1 / slope, ratio, 1.0) : 1.0;
    const double upper = std::exp(log_pa + std::log(z) + slope * (z - 1));
    return {a, b, pa, pb, std::max({pa, pb, upper})};
}
} // namespace pc_maximum_detail

ShapeScaledMaximum shape_scaled_maximum(const BPlaneGeometry& geometry) {
    ShapeScaledMaximum result;
    result.pc.method = "PC2D-SHAPE-SCALED-MAX";
    result.pc.max_method = result.pc.method;
    double large, small;
    if (!pc_maximum_detail::valid_geometry(geometry, large, small)) {
        result.pc = pc_maximum_detail::invalid_result(result.pc.method);
        return result;
    }
    const double distance = geometry.miss_distance();
    const double radius = geometry.combined_radius;
    result.pc.mahalanobis_2d = geometry.mahalanobis_distance();
    if (radius == 0) return result;
    if (distance <= radius) {
        // An interior point approaches unit probability as scale -> 0.
        // On the boundary, the disk lies within a tangent half-plane and
        // approaches its probability 1/2 as scale -> 0.
        result.covariance_scale = 0;
        result.pc.probability = distance < radius ? 1.0 : 0.5;
        result.pc.max_probability = result.pc.probability;
        result.pc.upper_probability = result.pc.probability;
        return result;
    }

    // For every point in the HBR disk, q=(x-m)' C^-1 (x-m) lies between
    // (d-R)^2/lambda_max and (d+R)^2/lambda_min. The density derivative
    // under C -> t*C has sign(q-2*t), so no maximum lies outside these
    // positive scale bounds. Work with logs to retain extreme shapes.
    const double left = 2 * std::log(distance - radius) - std::log(2 * large);
    const double right = 2 * std::log(distance + radius) - std::log(2 * small);
    auto evaluate = [&](double log_scale) {
        BPlaneGeometry scaled = geometry;
        const double scale = std::exp(log_scale);
        scaled.sigma_xx *= scale;
        scaled.sigma_xz *= scale;
        scaled.sigma_zz *= scale;
        const PcResult value = gaussian_disk_integral(scaled, false);
        ++result.pc.iterations;
        result.pc.converged = result.pc.converged && value.converged;
        if (value.probability > result.pc.probability) {
            result.pc.probability = value.probability;
            result.covariance_scale = scale;
        }
        return value.probability;
    };

    // Every scale interval has an analytic probability envelope. Refine
    // the highest envelope until the global numerical upper bound is
    // within the probability budget; no unimodality assumption is needed.
    constexpr int nodes = 128;
    std::array<double, nodes + 1> values{};
    const double step = (right - left) / nodes;
    for (int i = 0; i <= nodes; ++i) values[i] = evaluate(left + step * i);
    std::priority_queue<pc_maximum_detail::ScaleInterval> intervals;
    for (int i = 0; i < nodes; ++i)
        intervals.push(pc_maximum_detail::bound_interval(left + step * i, left + step * (i + 1), values[i], values[i + 1]));
    constexpr double relative_budget = 1e-9;
    while (intervals.top().upper > result.pc.probability * (1 + relative_budget) &&
           intervals.top().upper > std::numeric_limits<double>::denorm_min()) {
        if (result.pc.iterations >= 32768) {
            result.pc.converged = false;
            result.pc.failure_reason = "Covariance-scale maximum exceeded interval refinement budget";
            break;
        }
        const auto interval = intervals.top();
        intervals.pop();
        const double midpoint = (interval.a + interval.b) / 2;
        if (midpoint == interval.a || midpoint == interval.b) {
            intervals.push(interval);
            break;
        }
        const double value = evaluate(midpoint);
        intervals.push(pc_maximum_detail::bound_interval(interval.a, midpoint, interval.pa, value));
        intervals.push(pc_maximum_detail::bound_interval(midpoint, interval.b, value, interval.pb));
    }
    result.pc.upper_probability = std::min(1.0, intervals.top().upper);
    result.pc.max_probability = result.pc.probability;
    return result;
}

PcResult ShapeScaledMaxPc::compute(const BPlaneGeometry& geometry) const {
    return shape_scaled_maximum(geometry).pc;
}

std::string FrisbeeMaxPc::name() const {
    if (region_ == FrisbeeRegion::EqualAreaSquare) return "FRISBEE-SINGLE-COV-EQUAL-AREA-SQUARE";
    if (region_ == FrisbeeRegion::CircumscribedSquare) return "FRISBEE-SINGLE-COV-CIRCUMSCRIBED-SQUARE";
    return "FRISBEE-SINGLE-COV-MAX";
}

PcResult FrisbeeMaxPc::compute(const BPlaneGeometry& geometry) const {
    double large, small;
    if (!pc_maximum_detail::valid_geometry(geometry, large, small))
        return pc_maximum_detail::invalid_result(name());
    BPlaneGeometry combined = geometry;
    double u, v;
    geometry.rotated_miss(u, v);
    const double md2 = u * u / large + v * v / small;
    if (md2 > 1) {
        // CARA FrisbeeMaxPc.m: Vc = |r|^2*(1-1/Ka^2), covariance of
        // missing object = Vc*(r/|r|)*(r/|r|)'. Algebra cancels |r|^2.
        const double factor = 1 - 1 / md2;
        combined.sigma_xx += factor * geometry.xi * geometry.xi;
        combined.sigma_xz += factor * geometry.xi * geometry.zeta;
        combined.sigma_zz += factor * geometry.zeta * geometry.zeta;
    }
    PcResult result;
    if (region_ == FrisbeeRegion::Circle) {
        result = Foster2D().compute(combined);
    } else {
        combined.eigenvalues(large, small);
        combined.rotated_miss(u, v);
        // CARA PcCircle aligns either square with the covariance axes.
        const double half_width = geometry.combined_radius *
            (region_ == FrisbeeRegion::EqualAreaSquare ? std::sqrt(pc_maximum_detail::pi / 4) : 1.0);
        const double floor = std::pow(1e-4 * geometry.combined_radius, 2);
        const double sx = std::sqrt(std::max(large, floor));
        const double sz = std::sqrt(std::max(small, floor));
        result.probability = pc_maximum_detail::normal_interval((u - half_width) / sx, (u + half_width) / sx) *
            pc_maximum_detail::normal_interval((v - half_width) / sz, (v + half_width) / sz);
    }
    result.method = name();
    result.max_method = name();
    result.mahalanobis_2d = std::sqrt(md2);
    // This field reports the Frisbee prescription, not a proven finite-HBR bound.
    result.max_probability = result.probability;
    return result;
}
} // namespace conjunction
