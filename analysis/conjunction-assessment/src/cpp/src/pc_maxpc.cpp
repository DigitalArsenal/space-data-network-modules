#include "conjunction/pc_method.h"
#include <limits>
#include <cstdint>
#include <cstring>

namespace conjunction {

PcResult AlfanoMaxPc::compute(const BPlaneGeometry& bp) const {
    PcResult r;
    r.method = "ALFANO-SPHERICAL-SMALL-HBR-MAX";
    r.mahalanobis_2d = bp.mahalanobis_distance();

    double d = bp.miss_distance();
    double Rc = bp.combined_radius;

    if (d < 1e-15 || Rc >= d) {
        r.probability = 1.0;
        r.max_probability = 1.0;
        return r;
    }

    // P_max = (Rc/d)² × e⁻¹
    r.probability = (Rc * Rc) / (d * d) * std::exp(-1.0);
    r.probability = std::min(r.probability, 1.0);
    r.max_probability = r.probability;
    return r;
}

PcResult Alfriend1999Max::compute(const BPlaneGeometry& bp) const {
    PcResult r;
    r.method = "ALFRIEND-1999-MAX";
    r.max_method = r.method;
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

    if (md2 <= 1e-30) {
        r.probability = 1.0;
    } else {
        const double pc = Rc * Rc / (md2 * sqrt_det * std::exp(1.0));
        r.probability = std::min(std::max(pc, 0.0), 1.0);
    }
    r.max_probability = r.probability;

    return r;
}

} // namespace conjunction
