/**
 * EphemerisSource — OEM interpolation implementation
 */

#include "conjunction/ephemeris_source.h"
#include <stdexcept>
#include <algorithm>
#include <cmath>
#include <limits>

namespace conjunction {

namespace {

constexpr double EARTH_RADIUS_KM = 6378.137;
constexpr double MU_EARTH_KM3_S2 = 398600.4418;
constexpr double TWO_PI = 2.0 * M_PI;
constexpr double SECONDS_PER_DAY = 86400.0;

double clamp_covariance_value(double value, double minimum, double maximum) {
    return std::min(maximum, std::max(minimum, value));
}

double semi_major_axis_from_mean_motion(double mean_motion_rev_day) {
    if (!std::isfinite(mean_motion_rev_day) || mean_motion_rev_day <= 0.0) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    const double mean_motion_rad_sec =
        mean_motion_rev_day * TWO_PI / SECONDS_PER_DAY;
    return std::cbrt(
        MU_EARTH_KM3_S2 / (mean_motion_rad_sec * mean_motion_rad_sec));
}

RtnCovarianceSigmas estimate_tle_rtn_covariance_sigmas(
    double epoch_jd,
    double jd,
    double mean_motion_rev_day,
    double eccentricity,
    double bstar,
    double semi_major_axis_km) {
    RtnCovarianceSigmas sigmas;

    const double resolved_semi_major_axis_km =
        std::isfinite(semi_major_axis_km) && semi_major_axis_km > 0.0
            ? semi_major_axis_km
            : semi_major_axis_from_mean_motion(mean_motion_rev_day);
    if (!std::isfinite(resolved_semi_major_axis_km) ||
        resolved_semi_major_axis_km <= EARTH_RADIUS_KM) {
        return sigmas;
    }

    const double altitude_km =
        std::max(0.0, resolved_semi_major_axis_km - EARTH_RADIUS_KM);
    const double regime_scale =
        std::sqrt(std::max(0.25, 1.0 + altitude_km / 500.0));
    const double shape_scale =
        1.0 + clamp_covariance_value(std::abs(eccentricity) * 8.0, 0.0, 4.0);
    const double drag_scale =
        1.0 + clamp_covariance_value(std::abs(bstar) * 25000.0, 0.0, 6.0);
    const double dse_days =
        std::abs(jd - epoch_jd);

    const double radial_base_m = 45.0 * regime_scale * shape_scale;
    const double along_base_m = 135.0 * regime_scale * shape_scale;
    const double cross_base_m = 55.0 * regime_scale * shape_scale;
    const double radial_growth_m_day = 70.0 * regime_scale * drag_scale;
    const double along_growth_m_day = 240.0 * regime_scale * drag_scale;
    const double cross_growth_m_day =
        85.0 * regime_scale * std::sqrt(drag_scale);

    sigmas.radial_km =
        clamp_covariance_value(
            std::hypot(radial_base_m, radial_growth_m_day * dse_days),
            10.0,
            50000.0) /
        1000.0;
    sigmas.along_track_km =
        clamp_covariance_value(
            std::hypot(along_base_m, along_growth_m_day * dse_days),
            30.0,
            150000.0) /
        1000.0;
    sigmas.cross_track_km =
        clamp_covariance_value(
            std::hypot(cross_base_m, cross_growth_m_day * dse_days),
            10.0,
            80000.0) /
        1000.0;
    return sigmas;
}

} // namespace

// ── OEM Hermite Interpolation ──

StateVector OEMEphemerisSource::state_at(double jd) const {
    if (points_.empty()) {
        throw std::runtime_error("Empty ephemeris");
    }

    // Clamp to valid range (extrapolate to nearest point)
    if (jd <= points_.front().jd) {
        const auto& p = points_.front();
        return {p.jd, p.x, p.y, p.z, p.vx, p.vy, p.vz};
    }
    if (jd >= points_.back().jd) {
        const auto& p = points_.back();
        return {p.jd, p.x, p.y, p.z, p.vx, p.vy, p.vz};
    }

    // Binary search for bracketing interval
    size_t lo = 0, hi = points_.size() - 1;
    while (hi - lo > 1) {
        size_t mid = (lo + hi) / 2;
        if (points_[mid].jd <= jd) lo = mid;
        else hi = mid;
    }

    // Hermite interpolation between points_[lo] and points_[hi]
    const auto& p0 = points_[lo];
    const auto& p1 = points_[hi];

    double dt = p1.jd - p0.jd;
    if (dt < 1e-15) {
        return {jd, p0.x, p0.y, p0.z, p0.vx, p0.vy, p0.vz};
    }

    double t = (jd - p0.jd) / dt;  // normalized [0,1]
    double t2 = t * t;
    double t3 = t2 * t;

    // Hermite basis functions
    double h00 = 2*t3 - 3*t2 + 1;
    double h10 = t3 - 2*t2 + t;
    double h01 = -2*t3 + 3*t2;
    double h11 = t3 - t2;

    // dt in seconds for velocity scaling
    double dt_sec = dt * 86400.0;

    StateVector sv;
    sv.epoch_jd = jd;

    // Position interpolation
    sv.x = h00 * p0.x + h10 * p0.vx * dt_sec + h01 * p1.x + h11 * p1.vx * dt_sec;
    sv.y = h00 * p0.y + h10 * p0.vy * dt_sec + h01 * p1.y + h11 * p1.vy * dt_sec;
    sv.z = h00 * p0.z + h10 * p0.vz * dt_sec + h01 * p1.z + h11 * p1.vz * dt_sec;

    // Velocity from Hermite derivative
    double dh00 = 6*t2 - 6*t;
    double dh10 = 3*t2 - 4*t + 1;
    double dh01 = -6*t2 + 6*t;
    double dh11 = 3*t2 - 2*t;

    sv.vx = (dh00 * p0.x + dh10 * p0.vx * dt_sec + dh01 * p1.x + dh11 * p1.vx * dt_sec) / dt_sec;
    sv.vy = (dh00 * p0.y + dh10 * p0.vy * dt_sec + dh01 * p1.y + dh11 * p1.vy * dt_sec) / dt_sec;
    sv.vz = (dh00 * p0.z + dh10 * p0.vz * dt_sec + dh01 * p1.z + dh11 * p1.vz * dt_sec) / dt_sec;

    return sv;
}

bool SGP4EphemerisSource::covariance_rtn_sigma_at(
    double jd, RtnCovarianceSigmas& sigmas) const {
    sigmas = estimate_tle_rtn_covariance_sigmas(
        tle_.epoch_jd,
        jd,
        tle_.mean_motion,
        tle_.eccentricity,
        tle_.bstar,
        semi_major_axis_from_mean_motion(tle_.mean_motion));
    return sigmas.radial_km > 0.0 &&
           sigmas.along_track_km > 0.0 &&
           sigmas.cross_track_km > 0.0;
}

bool GPEphemerisSource::covariance_rtn_sigma_at(
    double jd, RtnCovarianceSigmas& sigmas) const {
    sigmas = estimate_tle_rtn_covariance_sigmas(
        gp_.epoch_jd,
        jd,
        gp_.mean_motion,
        gp_.eccentricity,
        gp_.bstar,
        gp_.semi_major_axis_km);
    return sigmas.radial_km > 0.0 &&
           sigmas.along_track_km > 0.0 &&
           sigmas.cross_track_km > 0.0;
}

} // namespace conjunction
