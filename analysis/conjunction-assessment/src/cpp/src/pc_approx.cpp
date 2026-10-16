#include "conjunction/pc_method.h"
#include <limits>
#include <cstdint>
#include <cstring>

namespace conjunction {

PcResult SmallHbrApprox::compute(const BPlaneGeometry& bp) const {
    PcResult r;
    r.method = "PC2D-SMALL-HBR-APPROX";
    r.mahalanobis_2d = bp.mahalanobis_distance();
    double s1, s2;
    bp.eigen_sigmas(s1, s2);

    if (s1 < 1e-30 || s2 < 1e-30) {
        // Degenerate covariance — fall back to Alfano
        AlfanoMaxPc alfano;
        return alfano.compute(bp);
    }

    // Rotate miss vector to principal axes
    double u, v;
    bp.rotated_miss(u, v);

    double Rc = bp.combined_radius;

    // P_c = (Rc² / (2σ₁σ₂)) × exp(-½(u²/σ₁² + v²/σ₂²))
    double Pc = (Rc * Rc) / (2.0 * s1 * s2) *
                std::exp(-0.5 * (u * u / (s1 * s1) + v * v / (s2 * s2)));

    r.probability = std::min(Pc, 1.0);

    // Also compute Alfano bound
    AlfanoMaxPc alfano;
    r.max_probability = alfano.compute(bp).probability;

    return r;
}

PcResult Chan1997::compute(const BPlaneGeometry& bp) const {
    PcResult r;
    r.method = "CHAN-1997";
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

    // Orekit Chan1997 terms:
    //   u = R² / (σx σy)
    //   v = xm² / σx² + ym² / σy²
    // with the term count M recommended by Chan.
    const double chan_u = Rc * Rc / (s1 * s2);
    const double chan_v = (u * u / (s1 * s1)) + (v * v / (s2 * s2));
    int M;
    if (max_terms_ > 0) {
        M = max_terms_;
    } else if (chan_u <= 0.01 || chan_v <= 1.0) {
        M = 3;
    } else if ((chan_u > 0.01 && chan_u <= 1.0) ||
               (chan_v > 1.0 && chan_v <= 9.0)) {
        M = 10;
    } else if ((chan_u > 1.0 && chan_u <= 25.0) ||
               (chan_v > 9.0 && chan_v <= 25.0)) {
        M = 20;
    } else {
        M = 60;
    }

    double t = 1.0;
    double s = 1.0;
    double series_sum = 1.0;
    const double exp_v = std::exp(-0.5 * chan_v);
    const double exp_uv = std::exp(-0.5 * (chan_u + chan_v));

    double value = exp_v * t - exp_uv * t * series_sum;
    for (int i = 1; i < M; i++) {
        t *= (0.5 * chan_v) / static_cast<double>(i);
        s *= (0.5 * chan_u) / static_cast<double>(i);
        series_sum += s;
        value += exp_v * t - exp_uv * t * series_sum;
    }

    r.probability = std::min(std::max(value, 0.0), 1.0);
    r.converged = true;
    r.iterations = M;

    AlfanoMaxPc alfano;
    r.max_probability = alfano.compute(bp).probability;

    return r;
}

PcResult Alfriend1999::compute(const BPlaneGeometry& bp) const {
    PcResult r;
    r.method = "ALFRIEND-1999";
    r.mahalanobis_2d = bp.mahalanobis_distance();

    double s1, s2;
    bp.eigen_sigmas(s1, s2);

    if (s1 < 1e-30 || s2 < 1e-30) {
        AlfanoMaxPc alfano;
        return alfano.compute(bp);
    }

    double u, v;
    bp.rotated_miss(u, v);
    const double md2 = (u * u / (s1 * s1)) + (v * v / (s2 * s2));
    const double sqrt_det = s1 * s2;
    const double Rc = bp.combined_radius;

    const double pc = std::exp(-0.5 * md2) * Rc * Rc / (2.0 * sqrt_det);
    r.probability = std::min(std::max(pc, 0.0), 1.0);

    Alfriend1999Max max_method;
    r.max_probability = max_method.compute(bp).probability;
    r.max_method = max_method.name();

    return r;
}

} // namespace conjunction
