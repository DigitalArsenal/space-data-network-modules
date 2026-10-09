// The Earth's penumbra and umbra boundaries (the conical model of
// lib/shadow.h) as switching functions of the state, for the adaptive step
// loops. Radiation pressure has a kink at each boundary. An embedded error
// estimate sees a kink only through the stages that straddle it, so a long
// step across a boundary can pass the error test with a wrong result (LEO400
// F6 against Orekit: 21 cm after a day at 60 s steps, 9.6 mm at 10 s). A step
// that crosses a boundary is shortened, by the secant on the switching
// function, until it ends within `tolerance` seconds past the boundary, so the
// kink sits on a step boundary whatever the step size. Orekit's eclipse
// detectors on its radiation pressure do the same.
#pragma once

#include <algorithm>
#include <cmath>

#include "astrodynamics.h"
#include "force_models.h"
#include "shadow.h"

namespace astro {
namespace shadow {

class BoundaryEvents {
public:
    // epoch: JD TDB at t = 0 of the loop's clock; y0: the state at t0.
    BoundaryEvents(const ForceModel::ForceModelSet& forces, double epoch, double t0, const double* y0)
        : forces_(&forces), epoch_(epoch),
          active_(forces.useSRP && forces.srp.shadowModel != ShadowModelType::None) {
        if (active_) values(t0, y0, g0_);
    }
    bool active() const { return active_; }

    // A step from t of length h has passed the error test and ends at y1.
    // Returns 0 to take it, or the shorter step to try instead.
    double cut(double t, double h, const double* y1) {
        if (!active_ || h == 0) return 0;
        double g1[2];
        values(t + h, y1, g1);
        double first = 2;
        for (int i = 0; i < 2; ++i)
            if ((g0_[i] < 0) != (g1[i] < 0) && g0_[i] != 0) first = std::min(first, g0_[i] / (g0_[i] - g1[i]));
        if (first > 1) return 0;                                    // no boundary crossed
        if (std::abs(h) * (1 - first) <= tolerance) { crossed_ = true; return 0; }  // ends on it
        if (natural_ == 0) natural_ = std::abs(h);
        return h * first + std::copysign(tolerance / 2, h);
    }
    // The step ending at (t1, y1) was taken.
    void taken(double t1, const double* y1) {
        if (active_) values(t1, y1, g0_);
    }
    // The next step after a taken one: after a step that ended on a boundary,
    // the step proposed before it was shortened, if that is longer.
    double next(double h) {
        if (!crossed_) return h;
        crossed_ = false;
        const double natural = natural_;
        natural_ = 0;
        return std::copysign(std::max(std::abs(h), natural), h);
    }

    double tolerance = 1e-3;  // seconds

private:
    // c - (b + a) and c - (b - a): c the angle between the directions to the
    // Sun's and the Earth's centres, a and b their apparent radii. Positive
    // outside the penumbra and outside the umbra respectively.
    void values(double t, const double* y, double g[2]) const {
        const Vec3 r(y[0], y[1], y[2]);
        const Vec3 s = forces_->sunPositionProvided ? forces_->sunPosition : getSunPosition(epoch_ + t / 86400.0).position;
        const Vec3 d = s - r;
        const double a = std::asin(std::min(1.0, SUN_RADIUS_KM / d.magnitude()));
        const double b = std::asin(std::min(1.0, RE_EARTH / r.magnitude()));
        const double c = std::atan2(r.cross(d).magnitude(), -r.dot(d));
        g[0] = c - (a + b);
        g[1] = c - (b - a);
    }

    const ForceModel::ForceModelSet* forces_;
    double epoch_;
    bool active_;
    double g0_[2] = {1, 1};
    double natural_ = 0;
    bool crossed_ = false;
};

}  // namespace shadow
}  // namespace astro
