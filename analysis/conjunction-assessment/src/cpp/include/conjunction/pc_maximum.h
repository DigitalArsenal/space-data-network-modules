#ifndef CONJUNCTION_PC_MAXIMUM_H
#define CONJUNCTION_PC_MAXIMUM_H

#include "conjunction/pc_method.h"

namespace conjunction {

struct ShapeScaledMaximum {
    // probability is the best evaluated value; upper_probability is the
    // interval envelope, within a 1e-9 relative optimization budget when
    // converged. Both retain the underlying quadrature's numerical error.
    PcResult pc;
    // Multiplier of the covariance, not of its standard deviations. Zero
    // denotes the limiting supremum as covariance tends to zero.
    double covariance_scale = 1.0;
};

// Maximize the disk integral over C -> scale*C, holding covariance aspect
// ratio, orientation, miss vector and HBR fixed. This is a shape-conditioned
// maximum; it is not a bound over arbitrary unknown covariance shapes.
ShapeScaledMaximum shape_scaled_maximum(const BPlaneGeometry& geometry);

class ShapeScaledMaxPc : public PcMethod {
public:
    PcResult compute(const BPlaneGeometry& geometry) const override;
    std::string name() const override { return "PC2D-SHAPE-SCALED-MAX"; }
};

enum class FrisbeeRegion { Circle, EqualAreaSquare, CircumscribedSquare };

// NASA CARA's Frisbee single-known-covariance prescription. The input
// covariance must be that of the one known object in the encounter plane.
// CARA adds a rank-one covariance along the miss direction and integrates
// over the selected HBR region. Its finite-HBR result is a prescription,
// not the exact maximum over all possible unknown object covariances.
class FrisbeeMaxPc : public PcMethod {
public:
    explicit FrisbeeMaxPc(FrisbeeRegion region = FrisbeeRegion::Circle)
        : region_(region) {}
    PcResult compute(const BPlaneGeometry& geometry) const override;
    std::string name() const override;
private:
    FrisbeeRegion region_;
};

} // namespace conjunction
#endif
