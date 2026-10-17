#include "atmosphere_winds.h"

#include "astrodynamics.h"
#include "hwm14.hpp"

#include <cmath>
#include <stdexcept>

namespace astro {

namespace {

// The model is immutable after construction and its methods are const and
// stateless, so one shared instance serves every thread.
const hwm14::Model& model() {
    static const hwm14::Model instance;
    return instance;
}

}  // namespace

void HorizontalWindNorthEast(double latDeg, double lonDeg, double altKm, double jdUtc,
                             const SpaceWeatherData& weather, bool disturbance,
                             double* northMs, double* eastMs) {
    int year = 0, doy = 1;
    double sec = 0.0;
    jdToYearDoySec(jdUtc, year, doy, sec);
    // HWM14 reads only the day of year from IYD (yyddd).
    const int iyd = (((year % 100) + 100) % 100) * 1000 + doy;
    float quiet[2];
    const float noAp[2] = {0.0f, -1.0f};
    const float lat = static_cast<float>(latDeg), lon = static_cast<float>(lonDeg);
    const float alt = static_cast<float>(std::max(altKm, 0.0));
    const float ut = static_cast<float>(sec);
    model().hwmqt(iyd, ut, alt, lat, lon, 0.0f, 0.0f, 0.0f, noAp, quiet);
    double north = quiet[0], east = quiet[1];
    if (disturbance) {
        if (!(weather.kp3h >= 0.0 && weather.kp3h <= 9.0)) {
            throw std::invalid_argument(
                "HWM14 disturbance winds need the 3-hour Kp of the epoch (SpaceWeatherData.kp3h); "
                "supply it or request quiet-time winds only");
        }
        float dw[2];
        model().dwm07kp(iyd, ut, alt, lat, lon, static_cast<float>(weather.kp3h), dw);
        // HWM14 adds the two in real(4).
        north = static_cast<float>(quiet[0] + dw[0]);
        east = static_cast<float>(quiet[1] + dw[1]);
    }
    *northMs = north;
    *eastMs = east;
}

void HorizontalWindFromAp(double latDeg, double lonDeg, double altKm, int year, int doy,
                          double sec, double ap3h, double* northMs, double* eastMs) {
    const int iyd = (((year % 100) + 100) % 100) * 1000 + doy;
    const float ap[2] = {0.0f, static_cast<float>(ap3h)};
    float w[2];
    model().hwm14(iyd, static_cast<float>(sec), static_cast<float>(std::max(altKm, 0.0)),
                  static_cast<float>(latDeg), static_cast<float>(lonDeg), 0.0f, 0.0f, 0.0f, ap, w);
    *northMs = w[0];
    *eastMs = w[1];
}

double KpFromAp(double ap3h) {
    return hwm14::Model::ap2kp(static_cast<float>(ap3h));
}

Vec3 HorizontalWindEarthFixed(const Vec3& earthFixed, double jdUtc, const SpaceWeatherData& weather,
                              bool disturbance) {
    double lat = 0.0, lon = 0.0, alt = 0.0;
    ecefToGeodetic(earthFixed, lat, lon, alt);  // rad, rad, km
    double north = 0.0, east = 0.0;
    HorizontalWindNorthEast(lat * 180.0 / PI, lon * 180.0 / PI, alt, jdUtc, weather, disturbance, &north,
                            &east);
    const double sl = std::sin(lat), cl = std::cos(lat), so = std::sin(lon), co = std::cos(lon);
    // Local east (-sin lon, cos lon, 0) and geodetic north
    // (-sin lat cos lon, -sin lat sin lon, cos lat), m/s -> km/s.
    return Vec3((-so * east - sl * co * north) * 1e-3, (co * east - sl * so * north) * 1e-3,
                (cl * north) * 1e-3);
}

}  // namespace astro
