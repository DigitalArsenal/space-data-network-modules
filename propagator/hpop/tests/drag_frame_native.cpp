// Drag density frame and HWM14 winds: the force set integrates GCRF, and the
// geodetic density and wind models need Earth-fixed longitude.
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
#include "atmosphere_winds.h"
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

    // HWM14 winds. Anchor: NRL's published HWM14 test output
    // (third_party/hwm14/nrl/Check/gfortran.txt, height profile) at day 150,
    // 12:00 UT, 45 S, 85 W, 250 km, ap = 80: quiet (-4.150, -68.595) m/s and
    // total (40.408, -87.560) m/s (meridional, zonal), printed to 1 mm/s.
    {
        const double jd = 2449868.0;  // 1995-05-30 12:00 UT = day 150
        int year = 0, doy = 0;
        double sec = 0.0;
        jdToYearDoySec(jd, year, doy, sec);
        check(year == 1995 && doy == 150 && std::fabs(sec - 43200.0) < 1e-6, "anchor_epoch_is_day_150_noon", doy);
        SpaceWeatherData w;
        w.kp3h = KpFromAp(80.0);
        double n = 0.0, e = 0.0;
        HorizontalWindNorthEast(-45.0, -85.0, 250.0, jd, w, true, &n, &e);
        check(std::fabs(n - 40.408) < 6e-4 && std::fabs(e + 87.560) < 6e-4, "hwm14_total_matches_nrl_check", n);
        HorizontalWindNorthEast(-45.0, -85.0, 250.0, jd, w, false, &n, &e);
        check(std::fabs(n + 4.150) < 6e-4 && std::fabs(e + 68.595) < 6e-4, "hwm14_quiet_matches_nrl_check", n);

        // The plugin query: refused until solar activity is supplied, then
        // HWM14 with Ap[1]; a negative Ap[1] gives the quiet-time wind.
        GeoPosition position{-45.0 * kDeg, -85.0 * kDeg, 250000.0};
        AtmosphereEpoch epoch{1995, 150, 43200.0};
        WindVector wind{1.0, 1.0, 1.0};
        check(atmosphere_get_wind(&position, &epoch, &wind) == ATMOSPHERE_ERROR_NOT_INITIALIZED &&
                  wind.north == 0.0 && wind.east == 0.0,
              "wind_query_needs_supplied_solar_activity", wind.east);
        SolarActivity solar{150.0, 150.0, {15.0, 80.0, 15.0, 15.0, 15.0, 15.0, 15.0}};
        atmosphere_set_solar_activity(&solar);
        check(atmosphere_get_wind(&position, &epoch, &wind) == ATMOSPHERE_OK &&
                  std::fabs(wind.north - 40.408) < 6e-4 && std::fabs(wind.east + 87.560) < 6e-4 && wind.down == 0.0,
              "wind_query_total_matches_nrl_check", wind.north);
        solar.Ap[1] = -1.0;
        atmosphere_set_solar_activity(&solar);
        check(atmosphere_get_wind(&position, &epoch, &wind) == ATMOSPHERE_OK &&
                  std::fabs(wind.north + 4.150) < 6e-4 && std::fabs(wind.east + 68.595) < 6e-4,
              "wind_query_quiet_matches_nrl_check", wind.north);
    }

    // Drag with winds opposes v - w x r - wind, the wind rebuilt here from
    // its north/east components with an independent local basis and the
    // published GMST at J2000.
    {
        weather.kp3h = 3.0;
        double n = 0.0, e = 0.0;
        HorizontalWindNorthEast(30.0, -100.0, 400.0, kJ2000, weather, true, &n, &e);
        const double lat = 30.0 * kDeg, lon = -100.0 * kDeg;
        const Vec3 east(-std::sin(lon), std::cos(lon), 0.0);
        const Vec3 north(-std::sin(lat) * std::cos(lon), -std::sin(lat) * std::sin(lon), std::cos(lat));
        const Vec3 windGcrf = inertialFromEarthFixed(east * (e * 1e-3) + north * (n * 1e-3), kGmstJ2000);
        check(windGcrf.magnitude() > 1e-3, "wind_is_nonzero_at_400_km", windGcrf.magnitude());
        drag.includeWinds = true;
        const Vec3 aw = ForceModel::NRLMSISE00(gcrf, v, kJ2000, weather, drag);
        const Vec3 vRelW = vRel - windGcrf;
        const double cosineW = aw.dot(vRelW) / (aw.magnitude() * vRelW.magnitude());
        check(std::fabs(cosineW + 1.0) < 1e-10, "drag_with_winds_opposes_air_relative_velocity", cosineW);
        check((aw - aNrl).magnitude() > 1e-6 * aNrl.magnitude(), "winds_change_drag", (aw - aNrl).magnitude());
        const Vec3 awShared = ForceModel::AtmosphericDrag(gcrf, v, kJ2000, weather, drag);
        check((awShared - aw).magnitude() <= 1e-10 * aw.magnitude(), "earth_fixed_drag_path_matches_with_winds",
              (awShared - aw).magnitude());

        // Disturbance winds without a supplied Kp are refused; quiet-time
        // winds need none.
        SpaceWeatherData noKp = weather;
        noKp.kp3h = -1.0;
        bool refused = false;
        try {
            ForceModel::NRLMSISE00(gcrf, v, kJ2000, noKp, drag);
        } catch (const std::invalid_argument&) {
            refused = true;
        }
        check(refused, "disturbance_winds_without_kp_refused", refused ? 1.0 : 0.0);
        drag.windDisturbance = false;
        bool quietOk = true;
        try {
            ForceModel::NRLMSISE00(gcrf, v, kJ2000, noKp, drag);
        } catch (...) {
            quietOk = false;
        }
        check(quietOk, "quiet_winds_need_no_kp", quietOk ? 1.0 : 0.0);
        drag.windDisturbance = true;
    }

    std::printf("%s drag frame cases=%d failures=%d\n", failures == 0 ? "PASS" : "FAIL", cases, failures);
    return failures == 0 ? 0 : 1;
}
