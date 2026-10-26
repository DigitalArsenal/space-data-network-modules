#pragma once
// Smooth force branches for GJ ghost history. All force values come from the
// authoritative module; only branch selection and event quadrature are local.
#include "force_models.h"
#include "shadow.h"
#include "time_convert.h"
#include "reentry.h"
#include "ffm_interp.inc"
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>

namespace ffm_fast::gjforces {
using astro::Vec3;
using Forces = astro::ForceModel::ForceModelSet;

inline bool supported(const Forces& f) {
    // Other atmosphere/SRP families retain the standard adaptive integrator.
    return (!f.useDrag || (f.dragModel == astro::ForceModel::DragModelType::NRLMSISE00 && !f.drag.includeWinds)) &&
        (!f.useSRP || (f.srp.model == astro::ForceModel::SRPModelType::Cannonball &&
                      f.srp.shadowModel == astro::ShadowModelType::Conical && !f.srp.ecom2.enabled));
}
inline int64_t calendarDay(const timesys::Instant& at) { return int64_t(std::floor(at.utc().jd() + .5)); }

// Preserve two-part TT for every physical call. Only the atmosphere's integer
// UTC calendar branch is extended. Axes, weather, spacecraft coefficients,
// and UTC time of day remain those of the actual history point.
inline Vec3 calendarCorrection(const Forces& original, const Vec3& r, const Vec3& v,
                               const timesys::Instant& at, int64_t desiredDay) {
    if (!original.useDrag || original.dragModel != astro::ForceModel::DragModelType::NRLMSISE00) return {};
    const double utc = at.utc().jd();
    const int64_t shift = desiredDay - int64_t(std::floor(utc + .5));
    if (!shift) return {};
    Forces f;
    f.usePointMass = false;
    f.useDrag = true;
    f.dragModel = original.dragModel;
    f.drag = astro::ForceModel::DragAt(at, original);
    f.nrlmsise00 = original.nrlmsise00;
    f.explicitEpochContract = original.explicitEpochContract;
    f.weather = astro::ForceModel::WeatherAt(utc, original);
    std::array<double, 9> matrix{};
    double m[3][3];
    astro::ForceModel::GcrfToEarthFixed(at, original, m);
    for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) matrix[3*i+j] = m[i][j];
    f.centralBodyFixedRotation = [matrix](const timesys::Instant&, double out[3][3]) {
        for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) out[i][j] = matrix[3*i+j];
    };
    const auto shifted = timesys::Instant::fromUtc(utc + double(shift));
    return astro::ForceModel::ComputeTotalAcceleration(r, v, shifted, f) -
           astro::ForceModel::ComputeTotalAcceleration(r, v, at, f);
}
// The Sun of the force evaluation itself (force_models.cpp reads it through
// ffm_time::sun): the environment's time-only interpolant when the force set
// carries one, else the exact source. The switching functions, the conical
// radiation pressure they gate and the SRP this file cancels then see one Sun.
inline Vec3 sun(const Forces& f, const timesys::Instant& at) {
    if (f.sunPositionProvided) return f.sunPosition;
    return ffm_interp::body(at, f, 0, [](const timesys::Instant& t) { return astro::getSunPosition(t); }).position;
}
struct ShadowValues {
    double penumbra = 1, umbra = 1, midpoint = 1;
    double operator[](int i) const { return i == 0 ? penumbra : i == 1 ? umbra : midpoint; }
};
inline ShadowValues shadowValues(const Forces& f, const timesys::Instant& at, const Vec3& r) {
    if (!f.useSRP) return {};
    const auto d = sun(f, at) - r;
    const double a = std::asin(std::min(1.0, astro::shadow::SUN_RADIUS_KM / d.magnitude()));
    const double b = std::asin(std::min(1.0, astro::RE_EARTH / r.magnitude()));
    const double angle = std::atan2(r.cross(d).magnitude(), -r.dot(d));
    return {angle - (a+b), angle - (b-a), angle - b};
}
// Cannonball's dispatcher hardcodes conical shadow. The FlatPlate fallback
// honors None but uses area*1e-6 rather than Cannonball's area*1e-3. This
// adapter compensates that documented unit difference without copying SRP.
inline astro::ForceModel::SRPForceConfig fullSunConfig(const Forces& f) {
    auto config = f.srp;
    config.model = astro::ForceModel::SRPModelType::FlatPlate;
    config.shadowModel = astro::ShadowModelType::None;
    config.area *= 1000;
    return config;
}
// Selected smooth branch minus actual conical radiation pressure.
inline Vec3 srpCorrection(const Forces& f, const timesys::Instant& at,
                          const Vec3& r, const Vec3& v, bool sunlit) {
    if (!f.useSRP) return {};
    const auto s = sun(f, at);
    const auto actual = astro::ForceModel::SolarRadiation(r, v, s, f.srp);
    return (sunlit ? astro::ForceModel::SolarRadiation(r, v, s, fullSunConfig(f)) : Vec3{}) - actual;
}
} // namespace ffm_fast::gjforces
