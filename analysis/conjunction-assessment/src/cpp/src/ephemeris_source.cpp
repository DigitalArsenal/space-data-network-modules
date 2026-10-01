#include "conjunction/error_status.h"
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

constexpr double EPHEMERIS_EARTH_RADIUS_KM = 6378.137;
constexpr double EPHEMERIS_MU_EARTH_KM3_S2 = 398600.4418;
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
        EPHEMERIS_MU_EARTH_KM3_S2 / (mean_motion_rad_sec * mean_motion_rad_sec));
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
        resolved_semi_major_axis_km <= EPHEMERIS_EARTH_RADIUS_KM) {
        return sigmas;
    }

    const double altitude_km =
        std::max(0.0, resolved_semi_major_axis_km - EPHEMERIS_EARTH_RADIUS_KM);
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
        set_error("Empty ephemeris"); return {};
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


// ── Natural motion bound ──

double natural_motion_deviation_bound_km(const StateVector& state, double half_step_sec) {
    constexpr double MU_KM3_S2 = 398600.8;          // SGP4 (WGS 72)
    constexpr double MARGIN = 1.05;
    constexpr double RADIUS_FLOOR_KM = 6000.0;
    const double r = std::sqrt(state.x * state.x + state.y * state.y + state.z * state.z);
    const double v = std::sqrt(state.vx * state.vx + state.vy * state.vy + state.vz * state.vz);
    const double r_min = std::max(r - v * half_step_sec, RADIUS_FLOOR_KM);
    return 0.5 * MARGIN * MU_KM3_S2 / (r_min * r_min) * half_step_sec * half_step_sec;
}

// ── Chebyshev polynomial ephemeris ──

namespace {

// Midpoint +/- half-span and a parsed endpoint may differ by up to two
// binary64 representable Julian dates (about 80 microseconds near 2026).
double epoch_rounding(double jd) {
    return 2 * (std::nextafter(jd, std::numeric_limits<double>::infinity()) - jd);
}

double chebyshev(const std::vector<double>& c, double x) {
    double b1 = 0, b2 = 0;
    for (size_t i = c.size(); i-- > 1;) {
        const double b = 2 * x * b1 - b2 + c[i];
        b2 = b1;
        b1 = b;
    }
    return c.empty() ? 0.0 : x * b1 - b2 + c[0];
}

// Coefficients of d/dx sum c_k T_k(x).
std::vector<double> chebyshev_derivative(const std::vector<double>& c) {
    const size_t n = c.size();
    if (n < 2) return {};
    std::vector<double> d(n - 1, 0.0);
    for (size_t k = n - 1; k-- > 0;) {
        d[k] = (k + 2 < n - 1 ? d[k + 2] : 0.0) + 2.0 * static_cast<double>(k + 1) * c[k + 1];
    }
    d[0] *= 0.5;
    return d;
}

// max over [-1, 1] of |d^2/dx^2 sum c_k T_k|: |T_k''| <= k^2 (k^2 - 1) / 3.
double chebyshev_second_derivative_bound(const std::vector<double>& c) {
    double bound = 0;
    for (size_t k = 2; k < c.size(); ++k) {
        const double kk = static_cast<double>(k) * static_cast<double>(k);
        bound += std::abs(c[k]) * kk * (kk - 1.0) / 3.0;
    }
    return bound;
}

double vector_norm(double x, double y, double z) { return std::sqrt(x * x + y * y + z * z); }

// Position (km) and its time derivative (km/s) of an interval at x in
// [-1, 1]; rate holds the derivative series of x, y, z.
void position_and_rate(const PolynomialRecord& r, const std::array<std::vector<double>, 3>& rate,
                       double x, double p[3], double v[3]) {
    for (int k = 0; k < 3; ++k) {
        p[k] = chebyshev(r.c[k], x);
        v[k] = chebyshev(rate[k], x) / r.half;
    }
}

} // namespace

PolynomialEphemerisSource::PolynomialEphemerisSource(std::vector<PolynomialRecord> records)
    : records_(std::move(records)) {
    for (const auto& r : records_) {
        starts_.push_back(r.mid - r.half / 86400.0);
        rates_.push_back({chebyshev_derivative(r.c[0]), chebyshev_derivative(r.c[1]), chebyshev_derivative(r.c[2])});
        acceleration_km_s2_.push_back(
            vector_norm(chebyshev_second_derivative_bound(r.c[0]),
                  chebyshev_second_derivative_bound(r.c[1]),
                  chebyshev_second_derivative_bound(r.c[2])) / (r.half * r.half));
    }
    for (size_t i = 0; i + 1 < records_.size(); ++i) {
        double p0[3], v0[3], p1[3], v1[3];
        position_and_rate(records_[i], rates_[i], 1.0, p0, v0);
        position_and_rate(records_[i + 1], rates_[i + 1], -1.0, p1, v1);
        position_jump_km_.push_back(vector_norm(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]));
        velocity_jump_km_s_.push_back(vector_norm(v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]));
    }
}

double PolynomialEphemerisSource::valid_start_jd() const {
    return records_.empty() ? 0 : starts_.front();
}

double PolynomialEphemerisSource::valid_end_jd() const {
    return records_.empty() ? 0 : records_.back().mid + records_.back().half / 86400.0;
}

size_t PolynomialEphemerisSource::record_at(double jd) const {
    const auto it = std::upper_bound(starts_.begin(), starts_.end(), jd);
    return it == starts_.begin() ? 0 : static_cast<size_t>(it - starts_.begin()) - 1;
}

StateVector PolynomialEphemerisSource::state_at(double jd) const {
    const double nan = std::numeric_limits<double>::quiet_NaN();
    if (records_.empty() || !(jd >= valid_start_jd() - epoch_rounding(jd)) ||
        !(jd <= valid_end_jd() + epoch_rounding(jd))) {
        return {jd, nan, nan, nan, nan, nan, nan};
    }
    const auto& r = records_[record_at(jd)];
    const double x = std::clamp((jd - r.mid) * 86400.0 / r.half, -1.0, 1.0);
    return {jd, chebyshev(r.c[0], x), chebyshev(r.c[1], x), chebyshev(r.c[2], x),
            chebyshev(r.c[3], x), chebyshev(r.c[4], x), chebyshev(r.c[5], x)};
}

// Over |tau| <= h, r(jd + tau) - r(jd) - r'(jd) tau is at most 1/2 A tau^2
// within an interval, plus |dv| |tau| and |dr| at each interval boundary
// crossed; the sample's velocity v differs from r'(jd) by |r'(jd) - v|.
bool PolynomialEphemerisSource::path_deviation_bound_km(
    double jd, const StateVector& state, double half_step_sec, double& bound_km) const {
    if (records_.empty()) return false;
    const double h_days = half_step_sec / 86400.0;
    const size_t first = record_at(std::max(jd - h_days, valid_start_jd()));
    const size_t last = record_at(std::min(jd + h_days, valid_end_jd()));
    const size_t at = record_at(jd);
    double acceleration = 0, position_jumps = 0, velocity_jumps = 0;
    for (size_t i = first; i <= last; ++i) acceleration = std::max(acceleration, acceleration_km_s2_[i]);
    for (size_t i = first; i < last; ++i) {
        position_jumps += position_jump_km_[i];
        velocity_jumps += velocity_jump_km_s_[i];
    }
    const auto& r = records_[at];
    double p[3], rate[3];
    position_and_rate(r, rates_[at], std::clamp((jd - r.mid) * 86400.0 / r.half, -1.0, 1.0), p, rate);
    const double velocity_mismatch =
        vector_norm(rate[0] - state.vx, rate[1] - state.vy, rate[2] - state.vz);
    bound_km = 0.5 * acceleration * half_step_sec * half_step_sec +
               (velocity_jumps + velocity_mismatch) * half_step_sec + position_jumps;
    return std::isfinite(bound_km);
}

} // namespace conjunction
