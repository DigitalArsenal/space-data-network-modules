#include "conjunction/pc_method.h"
#include <limits>
#include <cstdint>
#include <cstring>

namespace conjunction {

static constexpr double PC_LEGACY_DISK_PI = 3.14159265358979323846;
static constexpr double PC_LEGACY_DISK_TWO_PI = 2.0 * PC_LEGACY_DISK_PI;

PcResult Patera2001::compute(const BPlaneGeometry& bp) const {
    PcResult r;
    r.method = "PATERA-2001";
    r.mahalanobis_2d = bp.mahalanobis_distance();
    double s1, s2;
    bp.eigen_sigmas(s1, s2);

    if (s1 < 1e-30 || s2 < 1e-30) {
        AlfanoMaxPc alfano;
        return alfano.compute(bp);
    }

    double u, v;
    bp.rotated_miss(u, v);

    double Rc = bp.combined_radius;

    // Direct 2D integration over the hard-body disk
    // using polar coordinates centered on the miss vector.
    // P_c = 1/(2πσ₁σ₂) ∫₀^Rc ∫₀^2π exp(-½((u+rcosθ)²/σ₁² + (v+rsinθ)²/σ₂²)) r dr dθ
    int Nr = std::max(8, n_quad_ / 8);
    int Ntheta = n_quad_;

    double sum = 0;
    double dr = Rc / Nr;
    double dtheta = PC_LEGACY_DISK_TWO_PI / Ntheta;

    for (int ir = 0; ir < Nr; ir++) {
        double rc = (ir + 0.5) * dr;
        for (int it = 0; it < Ntheta; it++) {
            double theta = (it + 0.5) * dtheta;
            double px = u + rc * std::cos(theta);
            double py = v + rc * std::sin(theta);
            double md2 = px * px / (s1 * s1) + py * py / (s2 * s2);
            sum += rc * std::exp(-0.5 * md2);
        }
    }

    r.probability = sum * dr * dtheta / (PC_LEGACY_DISK_TWO_PI * s1 * s2);
    r.probability = std::min(r.probability, 1.0);
    r.iterations = Nr * Ntheta;

    AlfanoMaxPc alfano;
    r.max_probability = alfano.compute(bp).probability;

    return r;
}

PcResult Alfriend2D::compute(const BPlaneGeometry& bp) const {
    PcResult r;
    r.method = "ALFRIEND-2D";
    r.mahalanobis_2d = bp.mahalanobis_distance();
    double s1, s2;
    bp.eigen_sigmas(s1, s2);

    if (s1 < 1e-30 || s2 < 1e-30) {
        AlfanoMaxPc alfano;
        return alfano.compute(bp);
    }

    double u, v;
    bp.rotated_miss(u, v);
    double Rc = bp.combined_radius;

    // Direct 2D Gauss-Legendre over the hard-body disk
    // Using polar coordinates centered on the miss vector
    //
    // P_c = 1/(2πσ₁σ₂) ∫₀^Rc ∫₀^2π exp(-½((u+rcosθ)²/σ₁² + (v+rsinθ)²/σ₂²)) r dr dθ

    // Gauss-Legendre nodes for [0, Rc] (transformed from [-1,1])
    // For simplicity, use midpoint rule with sufficient density
    double sum = 0;
    double dr = Rc / n_r_;
    double dtheta = PC_LEGACY_DISK_TWO_PI / n_theta_;

    for (int ir = 0; ir < n_r_; ir++) {
        double rc = (ir + 0.5) * dr;
        for (int it = 0; it < n_theta_; it++) {
            double theta = (it + 0.5) * dtheta;
            double px = u + rc * std::cos(theta);
            double py = v + rc * std::sin(theta);
            double md2 = px * px / (s1 * s1) + py * py / (s2 * s2);
            sum += rc * std::exp(-0.5 * md2);
        }
    }

    r.probability = sum * dr * dtheta / (PC_LEGACY_DISK_TWO_PI * s1 * s2);
    r.probability = std::min(r.probability, 1.0);
    r.iterations = n_r_ * n_theta_;

    AlfanoMaxPc alfano;
    r.max_probability = alfano.compute(bp).probability;

    return r;
}

} // namespace conjunction
