#ifndef CONJUNCTION_SGP4_PROPAGATOR_H
#define CONJUNCTION_SGP4_PROPAGATOR_H

/**
 * SGP4 Propagator — Lightweight wrapper around Tudat's TLE/SGP4 implementation.
 *
 * Source: DigitalArsenal/tudat (fork of tudat-team/tudat)
 * Files:
 *   - include/tudat/astro/ephemerides/tleEphemeris.h
 *   - src/astro/ephemerides/tleEphemeris.cpp
 *   - include/tudat/astro/basic_astro/tleElementsConversions.h
 *
 * For WASM build, we extract only the SGP4 propagation code from Tudat
 * to avoid pulling in the full Tudat dependency tree.
 */

#include <string>
#include <vector>
#include <cstdint>
#include <atomic>
#include <memory>

namespace conjunction {

struct Sgp4PropagationCache;
struct TLE;

/// An element set's initialized SGP4 state: created on first use, then read
/// with one atomic load (no lock, no reference count), as every screening
/// thread samples every object. Copies share it.
class Sgp4CacheSlot {
public:
    Sgp4CacheSlot() = default;
    Sgp4CacheSlot(const Sgp4CacheSlot& other);
    Sgp4CacheSlot& operator=(const Sgp4CacheSlot& other);
    /// The state for tle, created on first use; nullptr if SGP4 rejects it.
    const Sgp4PropagationCache* get_or_create(const TLE& tle) const;

private:
    mutable std::shared_ptr<const Sgp4PropagationCache> owner_;
    mutable std::atomic<const Sgp4PropagationCache*> ready_{nullptr};
};

/// State vector: position (km) + velocity (km/s) in J2000/TEME
struct StateVector {
    double epoch_jd;   // Julian Date
    double x, y, z;    // Position (km)
    double vx, vy, vz; // Velocity (km/s)
};

/// Two-Line Element set
struct TLE {
    std::string name;
    std::string line1;
    std::string line2;
    std::string object_id;
    std::string epoch_iso;

    // Parsed fields
    int norad_cat_id = 0;
    double epoch_jd = 0.0;      // Julian Date of epoch
    double bstar = 0.0;
    double inclination = 0.0;   // degrees
    double raan = 0.0;          // degrees
    double eccentricity = 0.0;
    double arg_perigee = 0.0;   // degrees
    double mean_anomaly = 0.0;  // degrees
    double mean_motion = 0.0;   // rev/day
    double mean_motion_dot = 0.0;   // rev/day^2
    double mean_motion_ddot = 0.0;  // rev/day^3
    int ephemeris_type = 0;
    char classification_type = 'U';
    int element_set_no = 0;
    int rev_at_epoch = 0;
    Sgp4CacheSlot cache;
};

// Forward declaration
struct GPElement;

/// Parse a TLE from 3 lines (name + line1 + line2)
TLE parse_tle(const std::string& name, const std::string& line1, const std::string& line2);

/// Parse all TLEs from a multi-line string
std::vector<TLE> parse_tle_file(const std::string& data);

/// Propagate a TLE to a given Julian Date using SGP4
/// Returns state in TEME frame (km, km/s)
StateVector propagate_sgp4(const TLE& tle, double target_jd);

/// Propagate directly from GP/OMM elements (no TLE text intermediary)
/// Supports any NORAD catalog ID (integer, no 5-digit limit)
StateVector propagate_sgp4_gp(const GPElement& gp, double target_jd);

/// Convert Julian Date to ISO 8601 string
std::string jd_to_iso(double jd);

/// Convert ISO 8601 string to Julian Date
double iso_to_jd(const std::string& iso);

/// Get Julian Date for a year + fractional day of year
double epoch_to_jd(int year, double day_of_year);

} // namespace conjunction

#endif // CONJUNCTION_SGP4_PROPAGATOR_H
