#ifndef SGP4_PROPAGATOR_PLUGIN_H
#define SGP4_PROPAGATOR_PLUGIN_H

/**
 * SGP4 Propagator SDN Plugin
 *
 * Standalone SGP4/SDP4 propagation:
 *   Input:  GP/OMM JSON (CelesTrak format)
 *   Output: OEM FlatBuffers (aligned binary, $OEM file identifier)
 *
 * Two propagation paths:
 *   1. GP JSON → direct OrbitalElements → SGP4 (integer NORAD IDs, no limit)
 *   2. TLE text → SGP4 (legacy, Alpha-5 up to 339999)
 *
 * Uses dnwrnr/sgp4 (Apache 2.0) as the propagation engine.
 */

#include <cstdint>
#include <string>
#include <vector>

namespace sgp4_prop {

// ─── GP Element (parsed from CelesTrak JSON) ───

struct GPElement {
    std::string object_name;
    std::string object_id;        // International designator
    int norad_cat_id = 0;         // Integer — no format limit
    std::string classification;
    std::string epoch;            // ISO 8601
    double epoch_jd = 0.0;        // Julian date (computed)

    double mean_motion = 0.0;     // rev/day
    double eccentricity = 0.0;
    double inclination = 0.0;     // degrees
    double ra_of_asc_node = 0.0;  // degrees
    double arg_of_pericenter = 0.0; // degrees
    double mean_anomaly = 0.0;    // degrees

    double bstar = 0.0;
    double mean_motion_dot = 0.0;
    double mean_motion_ddot = 0.0;

    int ephemeris_type = 0;
    int element_set_no = 0;
    int rev_at_epoch = 0;
};

// ─── Propagation Config ───

struct PropagationConfig {
    double start_jd = 0.0;        // Start time (JD). 0 = use epoch
    double end_jd = 0.0;          // End time (JD). 0 = epoch + duration_days
    double duration_days = 7.0;   // Default 7-day lookahead
    double step_seconds = 60.0;   // Output step size
};

// ─── State Vector ───

struct StateVector {
    double epoch_jd;
    double x, y, z;       // km (TEME)
    double vx, vy, vz;    // km/s (TEME)
};

// ─── Core API ───

/**
 * Parse GP JSON array into GPElement vector.
 * Accepts CelesTrak GP JSON format (array of objects).
 */
std::vector<GPElement> parse_gp_json(const std::string& json);

/**
 * Propagate a single GP element over a time range.
 * Returns state vectors at each step.
 */
std::vector<StateVector> propagate(const GPElement& gp, const PropagationConfig& config);

/**
 * Propagate and output as OEM FlatBuffers binary.
 * Returns bytes written (>=0 success, <0 error).
 */
int32_t propagate_to_oem(const GPElement& gp,
                          const PropagationConfig& config,
                          uint8_t* output, uint32_t output_capacity);

/**
 * Batch propagate multiple GP elements to OEM collection.
 */
int32_t propagate_batch_to_oem(const std::vector<GPElement>& gps,
                                const PropagationConfig& config,
                                uint8_t* output, uint32_t output_capacity);

/**
 * Propagate to a single epoch (point propagation).
 * Used by CA plugin and OD plugin for fast single-point queries.
 */
StateVector propagate_to_epoch(const GPElement& gp, double target_jd);

// ─── Utility ───

double epoch_to_jd(const std::string& epoch_str);

}  // namespace sgp4_prop

#endif  // SGP4_PROPAGATOR_PLUGIN_H
