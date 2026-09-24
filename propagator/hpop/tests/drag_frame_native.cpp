// Drag density frame: the force set integrates GCRF, and the geodetic density
// models need Earth-fixed longitude.
//
// Independent anchors:
// - GMST at J2000.0 (JD 2451545.0 UT1) = 280.46061837 deg (Vallado,
//   Fundamentals of Astrodynamics and Applications, 4th ed., Eq. 3-47; IAU-82).
// - Local solar time = UT hours + east longitude / 15 (nrlmsise-00.h, notes on
//   input variables).
// A satellite is placed by geodetic latitude, longitude and height; its GCRF
// position is that Earth-fixed vector rotated by -GMST about z, using the
// published GMST rather than the code under test.

#include "astrodynamics.h"
#include "atmosphere.h"
#include "force_models.h"
#include "time_convert.h"

#include <cmath>
#include <cstdio>
#include <stdexcept>

using namespace astro;

namespace {

int failures = 0;
int cases = 0;

void check(bool ok, const char* name, double value) {
    ++cases;
    if (!ok) {
        ++failures;
        std::printf("FAIL %s value=%.12g\n", name, value);
    }
}

constexpr double kPi = 3.14159265358979323846;
constexpr double kDeg = kPi / 180.0;
constexpr double kJ2000 = 2451545.0;
constexpr double kGmstJ2000 = 280.46061837 * kDeg;

Vec3 inertialFromEarthFixed(const Vec3& r, double theta) {
    const double c = std::cos(theta), s = std::sin(theta);
    return Vec3(c * r.x - s * r.y, s * r.x + c * r.y, r.z);
}

}  // namespace

int main() {
    check(std::fabs(timesys::ut1ToGmst(kJ2000) - kGmstJ2000) < 1e-9,
          "gmst_at_J2000_matches_published", timesys::ut1ToGmst(kJ2000) / kDeg);

    // 30 N, 100 W, 400 km at 2000-01-01 12:00 UT: local solar time
    // 12 + (-100 / 15) = 5.3333 h.
    const Vec3 earthFixed = geodeticToECEF(30.0 * kDeg, -100.0 * kDeg, 400.0);
    const Vec3 gcrf = inertialFromEarthFixed(earthFixed, kGmstJ2000);

    SpaceWeatherData weather;
    weather.epoch = kJ2000;
    weather.F107 = 150.0;
    weather.F107a = 150.0;
    weather.Ap = 4.0;

    const AtmosphericDensity fromForceLayer =
        ForceModel::NRLMSISE00Density(gcrf, kJ2000, weather);
    astro::AtmosphereConfig config;
    config.model = astro::AtmosphereModelType::NRLMSISE00;
    const AtmosphericDensity fromEarthFixed =
        computeNRLMSISE00(earthFixed, kJ2000, weather, config);

    check(std::fabs(fromForceLayer.localSolarTime - (12.0 - 100.0 / 15.0)) < 1e-3,
          "local_solar_time_from_earth_fixed_longitude", fromForceLayer.localSolarTime);
    check(std::fabs(fromForceLayer.longitude - (-100.0 * kDeg)) < 1e-9,
          "earth_fixed_longitude", fromForceLayer.longitude / kDeg);
    check(std::fabs(fromForceLayer.density / fromEarthFixed.density - 1.0) < 1e-9,
          "gcrf_density_equals_earth_fixed_density",
          fromForceLayer.density / fromEarthFixed.density);

    // Sensitivity: reading the GCRF vector as if it were Earth-fixed (the old
    // behavior) moves the sample 280 deg in longitude, about 18.7 h of local
    // time, and changes the density.
    const AtmosphericDensity unrotated = computeNRLMSISE00(gcrf, kJ2000, weather, config);
    check(std::fabs(unrotated.density / fromEarthFixed.density - 1.0) > 0.05,
          "test_detects_unrotated_evaluation", unrotated.density / fromEarthFixed.density);

    // Drag through AtmosphericDrag (computeDragAcceleration) returns to GCRF:
    // it opposes the atmosphere-relative velocity v - w x r there.
    ForceModel::DragForceConfig drag;
    drag.model = ForceModel::DragModelType::NRLMSISE00;
    const Vec3 v = Vec3(-gcrf.y, gcrf.x, 0.0).normalized() * 7.67;
    const Vec3 a = ForceModel::AtmosphericDrag(gcrf, v, kJ2000, weather, drag);
    const Vec3 vRel = v - Vec3(-OMEGA_EARTH * gcrf.y, OMEGA_EARTH * gcrf.x, 0.0);
    const double cosine = a.dot(vRel) / (a.magnitude() * vRel.magnitude());
    check(a.magnitude() > 0.0 && std::fabs(cosine + 1.0) < 1e-12,
          "atmospheric_drag_opposes_gcrf_relative_velocity", cosine);
    const Vec3 aNrl = ForceModel::NRLMSISE00(gcrf, v, kJ2000, weather, drag);
    check((a - aNrl).magnitude() <= 1e-12 * aNrl.magnitude(),
          "atmospheric_drag_matches_nrlmsise_force", (a - aNrl).magnitude());

    // No validated wind model: winds are refused, never invented.
    GeoPosition position{30.0 * kDeg, -100.0 * kDeg, 400000.0};
    AtmosphereEpoch epoch{2000, 1, 43200.0};
    WindVector wind{1.0, 1.0, 1.0};
    check(atmosphere_get_wind(&position, &epoch, &wind) == ATMOSPHERE_ERROR_INVALID_MODEL &&
              wind.north == 0.0 && wind.east == 0.0 && wind.down == 0.0,
          "wind_query_refused", wind.east);
    drag.includeWinds = true;
    bool refused = false;
    try {
        ForceModel::NRLMSISE00(gcrf, v, kJ2000, weather, drag);
    } catch (const std::invalid_argument&) {
        refused = true;
    }
    check(refused, "drag_with_winds_refused", refused ? 1.0 : 0.0);
    refused = false;
    try {
        ForceModel::AtmosphericDrag(gcrf, v, kJ2000, weather, drag);
    } catch (const std::invalid_argument&) {
        refused = true;
    }
    check(refused, "shared_drag_with_winds_refused", refused ? 1.0 : 0.0);

    std::printf("%s drag frame cases=%d failures=%d\n", failures == 0 ? "PASS" : "FAIL", cases, failures);
    return failures == 0 ? 0 : 1;
}
