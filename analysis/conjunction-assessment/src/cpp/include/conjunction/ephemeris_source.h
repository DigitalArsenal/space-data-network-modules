#ifndef CONJUNCTION_EPHEMERIS_SOURCE_H
#define CONJUNCTION_EPHEMERIS_SOURCE_H

/**
 * EphemerisSource — Propagator-agnostic state provider
 *
 * Any propagator (SGP4, HPOP, tabulated OEM, external API) implements
 * this interface. The conjunction assessment engine only sees states.
 *
 * Implementations:
 *   SGP4EphemerisSource     — from TLE/GP elements
 *   OEMEphemerisSource      — from OEM ephemeris (interpolated)
 *   StateEphemerisSource    — from pre-computed state vector (two-body)
 *   CallbackEphemerisSource — from user-supplied function pointer
 */

#include "conjunction/sgp4_propagator.h"  // for StateVector
#include "conjunction/gp_json.h"          // for GPElement
#include <array>
#include <cmath>
#include <memory>
#include <string>
#include <vector>
#include <functional>

namespace conjunction {

/// Who an object is, as conjunction results report it.
struct ObjectIdentity {
    std::string object_id;
    std::string name;
    int norad_cat_id = 0;
    double epoch_jd = 0.0;   // epoch of the underlying data (days-since-epoch)
};

struct RtnCovarianceSigmas {
    double radial_km = 0.0;
    double along_track_km = 0.0;
    double cross_track_km = 0.0;
};

// ── Abstract Interface ──

class EphemerisSource {
public:
    virtual ~EphemerisSource() = default;

    /// Get state at Julian Date. Returns position (km) + velocity (km/s).
    virtual StateVector state_at(double jd) const = 0;

    /// Epoch JD of the underlying data (for DSE computation)
    virtual double epoch_jd() const = 0;

    /// Object identifier (NORAD ID, name, etc.)
    virtual std::string object_id() const { return ""; }
    virtual std::string object_name() const { return ""; }
    virtual int norad_id() const { return 0; }
    virtual ObjectIdentity identity() const {
        return {object_id(), object_name(), norad_id(), epoch_jd()};
    }

    /// Valid time range [start_jd, end_jd]. 0 = unlimited.
    virtual double valid_start_jd() const { return 0; }
    virtual double valid_end_jd() const { return 0; }

    /// Whether path_deviation_bound_km is available: what all-vs-all
    /// screening (screening_tight.h) needs to discard a pair between samples.
    virtual bool bounds_path_deviation() const { return false; }

    /// A bound (km) on how far the path strays from the straight line through
    /// a sample: for every |tau| <= half_step_sec,
    ///   |r(jd + tau) - state.r - state.v tau| <= bound_km,
    /// where state is this source's state at jd. False when it has none.
    virtual bool path_deviation_bound_km(double jd, const StateVector& state,
                                         double half_step_sec, double& bound_km) const {
        (void)jd; (void)state; (void)half_step_sec; (void)bound_km;
        return false;
    }

    /// A bound (km/s^2) on the acceleration of the path within half_window_sec
    /// of jd, where state is this source's state at jd, for a path whose
    /// velocity is continuous there. False when it has none.
    virtual bool acceleration_bound_km_s2(double jd, const StateVector& state,
                                          double half_window_sec, double& bound) const {
        (void)jd; (void)state; (void)half_window_sec; (void)bound;
        return false;
    }

    /// Optional RTN 1-sigma position covariance prior (km) evaluated at jd.
    /// Implementations return false when no source-specific covariance is available.
    virtual bool covariance_rtn_sigma_at(
        double jd, RtnCovarianceSigmas& sigmas) const {
        (void)jd;
        sigmas = {};
        return false;
    }
};

/// Acceleration bound for natural (unpowered) Earth-orbit motion within
/// half_window_sec of state: A = 1.05 mu / r_min^2, r_min = |r| - |v| h floored
/// at 6000 km. The 5 % covers J2 (0.16 % at the surface) and drag. SGP4 motion
/// is natural.
double natural_motion_acceleration_bound_km_s2(const StateVector& state, double half_window_sec);
/// Deviation bound for natural motion: 1/2 A h^2.
double natural_motion_deviation_bound_km(const StateVector& state, double half_step_sec);

// ── SGP4 from TLE ──

class SGP4EphemerisSource : public EphemerisSource {
public:
    explicit SGP4EphemerisSource(const TLE& tle) : tle_(tle) {}

    StateVector state_at(double jd) const override {
        return propagate_sgp4(tle_, jd);
    }

    double epoch_jd() const override { return tle_.epoch_jd; }
    std::string object_id() const override { return tle_.object_id.empty() ? std::to_string(tle_.norad_cat_id) : tle_.object_id; }
    std::string object_name() const override { return tle_.name; }
    int norad_id() const override { return tle_.norad_cat_id; }
    ObjectIdentity identity() const override {
        return {tle_.object_id, tle_.name, tle_.norad_cat_id, tle_.epoch_jd};
    }
    bool bounds_path_deviation() const override { return true; }
    bool path_deviation_bound_km(double, const StateVector& state, double half_step_sec,
                                 double& bound_km) const override {
        bound_km = natural_motion_deviation_bound_km(state, half_step_sec);
        return std::isfinite(bound_km);
    }
    bool acceleration_bound_km_s2(double, const StateVector& state, double half_window_sec,
                                  double& bound) const override {
        bound = natural_motion_acceleration_bound_km_s2(state, half_window_sec);
        return std::isfinite(bound);
    }
    bool covariance_rtn_sigma_at(
        double jd, RtnCovarianceSigmas& sigmas) const override;

private:
    TLE tle_;
};

// ── SGP4 from GP/OMM elements ──

class GPEphemerisSource : public EphemerisSource {
public:
    // The element set is converted once, so its SGP4 initialization is kept
    // (propagate_sgp4_gp converts and initializes on every call).
    explicit GPEphemerisSource(const GPElement& gp) : gp_(gp), tle_(gp_to_tle(gp)) {}

    StateVector state_at(double jd) const override {
        return propagate_sgp4(tle_, jd);
    }

    double epoch_jd() const override { return gp_.epoch_jd; }
    std::string object_id() const override { return gp_.object_id.empty() ? std::to_string(gp_.norad_cat_id) : gp_.object_id; }
    std::string object_name() const override { return gp_.object_name; }
    int norad_id() const override { return gp_.norad_cat_id; }
    bool bounds_path_deviation() const override { return true; }
    bool path_deviation_bound_km(double, const StateVector& state, double half_step_sec,
                                 double& bound_km) const override {
        bound_km = natural_motion_deviation_bound_km(state, half_step_sec);
        return std::isfinite(bound_km);
    }
    bool acceleration_bound_km_s2(double, const StateVector& state, double half_window_sec,
                                  double& bound) const override {
        bound = natural_motion_acceleration_bound_km_s2(state, half_window_sec);
        return std::isfinite(bound);
    }
    bool covariance_rtn_sigma_at(
        double jd, RtnCovarianceSigmas& sigmas) const override;

private:
    GPElement gp_;
    TLE tle_;
};

// ── Tabulated OEM (Hermite interpolation) ──

struct EphemerisPoint {
    double jd;
    double x, y, z;
    double vx, vy, vz;
};

class OEMEphemerisSource : public EphemerisSource {
public:
    OEMEphemerisSource(std::vector<EphemerisPoint> points,
                        std::string name = "", std::string object_id = "",
                        int norad = 0)
        : points_(std::move(points)),
          name_(std::move(name)),
          object_id_(std::move(object_id)),
          norad_(norad) {
        if (!points_.empty()) {
            epoch_jd_ = points_.front().jd;
        }
    }

    StateVector state_at(double jd) const override;

    double epoch_jd() const override { return epoch_jd_; }
    std::string object_id() const override { return object_id_; }
    std::string object_name() const override { return name_; }
    int norad_id() const override { return norad_; }
    double valid_start_jd() const override {
        return points_.empty() ? 0 : points_.front().jd;
    }
    double valid_end_jd() const override {
        return points_.empty() ? 0 : points_.back().jd;
    }

private:
    std::vector<EphemerisPoint> points_;
    double epoch_jd_ = 0;
    std::string name_;
    std::string object_id_;
    int norad_ = 0;
};

// ── Chebyshev polynomial ephemeris (PPE) ──

/// One PPE interval: Chebyshev coefficients of x, y, z (km) and vx, vy, vz
/// (km/s) over [mid - half, mid + half], half in seconds.
struct PolynomialRecord {
    double mid = 0, half = 0;
    std::array<std::vector<double>, 6> c;
};

/// A trajectory as contiguous Chebyshev intervals, from any propagator.
/// Its deviation bound comes from the coefficients alone (the second
/// derivative of the position series, plus position and velocity jumps where
/// intervals meet), so it holds for any force model, thrust included.
class PolynomialEphemerisSource final : public EphemerisSource {
public:
    explicit PolynomialEphemerisSource(std::vector<PolynomialRecord> records);

    StateVector state_at(double jd) const override;
    double epoch_jd() const override { return valid_start_jd(); }
    double valid_start_jd() const override;
    double valid_end_jd() const override;
    std::string object_id() const override { return id; }
    std::string object_name() const override { return name; }
    int norad_id() const override { return norad; }
    bool bounds_path_deviation() const override { return !records_.empty(); }
    bool path_deviation_bound_km(double jd, const StateVector& state, double half_step_sec,
                                 double& bound_km) const override;
    const std::vector<PolynomialRecord>& records() const { return records_; }

    std::string id, name;
    int norad = 0;
    std::string generator;   // the propagator that produced it, as it names itself

private:
    size_t record_at(double jd) const;   // the interval holding jd (clamped)

    std::vector<PolynomialRecord> records_;
    std::vector<double> starts_;           // interval start JDs
    std::vector<std::array<std::vector<double>, 3>> rates_;   // d/dx series of x, y, z
    std::vector<double> acceleration_km_s2_;   // per interval: bound on |r''|
    std::vector<double> position_jump_km_;     // per boundary k|k+1
    std::vector<double> velocity_jump_km_s_;
};

// ── Callback-based (user-supplied function) ──

using EphemerisCallback = std::function<StateVector(double jd)>;

class CallbackEphemerisSource : public EphemerisSource {
public:
    CallbackEphemerisSource(EphemerisCallback cb, double epoch = 0,
                             std::string name = "", int norad = 0)
        : cb_(std::move(cb)), epoch_(epoch), name_(std::move(name)), norad_(norad) {}

    StateVector state_at(double jd) const override { return cb_(jd); }
    double epoch_jd() const override { return epoch_; }
    std::string object_name() const override { return name_; }
    int norad_id() const override { return norad_; }

private:
    EphemerisCallback cb_;
    double epoch_;
    std::string name_;
    int norad_;
};

} // namespace conjunction

#endif // CONJUNCTION_EPHEMERIS_SOURCE_H
