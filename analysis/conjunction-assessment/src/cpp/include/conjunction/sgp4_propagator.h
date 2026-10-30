#ifndef CONJUNCTION_SGP4_PROPAGATOR_H
#define CONJUNCTION_SGP4_PROPAGATOR_H

/**
 * SGP4 mean element sets and their propagation.
 *
 * SGP4/SDP4 is the clean-room base foundation/sgp4-str3 (Spacetrack Report No. 3
 * with the corrections AIAA 2006-6753 documents), WGS-72, in AFSPC mode, the
 * operational code's. An OMM's elements are propagated as published, with no
 * text in between; a TLE's are its fields as printed, read by parse_tle. Time
 * since epoch is formed from the epoch split exactly (its day at 0h UTC and the
 * fraction of that day) and the target split the same way.
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

/// One SGP4 mean element set: an OMM's values as published, or a TLE's fields.
struct TLE {
    std::string name;
    std::string object_id;
    std::string epoch_iso;      // the epoch as UTC ISO 8601 text (a TLE's, exact to the microsecond)

    int norad_cat_id = 0;
    double epoch_jd = 0.0;        // Julian Date of epoch (UTC), one double
    double epoch_jd_whole = 0.0;  // the epoch's day: the Julian Date of its 0h UTC (integer + 0.5)
    double epoch_jd_frac = 0.0;   // the epoch's fraction of that day
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

/// Read a TLE's fields from its two lines (the fixed columns of the two-line
/// element set; Alpha-5 catalog numbers). The epoch is kept exactly, as UTC
/// text to the microsecond. Sets the error status where the lines are not a TLE.
TLE parse_tle(const std::string& name, const std::string& line1, const std::string& line2);

/// Parse all TLEs from a multi-line string
std::vector<TLE> parse_tle_file(const std::string& data);

/// Propagate an element set to a given Julian Date (UTC) with SGP4/SDP4.
/// Returns state in TEME frame (km, km/s)
StateVector propagate_sgp4(const TLE& tle, double target_jd);

/// Propagate directly from GP/OMM elements (no TLE text intermediary)
/// Supports any NORAD catalog ID (integer, no 5-digit limit)
StateVector propagate_sgp4_gp(const GPElement& gp, double target_jd);

/// Convert Julian Date to ISO 8601 string
std::string jd_to_iso(double jd);

/// Convert ISO 8601 string to Julian Date
double iso_to_jd(const std::string& iso);

/// A UTC ISO 8601 calendar timestamp (iso_to_jd's grammar) split exactly: the
/// Julian Date of its day's 0h (integer + 0.5) and the fraction of that day.
/// False, with the error status set, where the text is not such a timestamp.
bool split_utc_epoch(const std::string& iso, double& jd_whole, double& jd_frac);

/// Get Julian Date for a year + fractional day of year
double epoch_to_jd(int year, double day_of_year);

} // namespace conjunction

#endif // CONJUNCTION_SGP4_PROPAGATOR_H
