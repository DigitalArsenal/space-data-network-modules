#ifndef CONJUNCTION_ASSESSMENT_H
#define CONJUNCTION_ASSESSMENT_H

/**
 * Conjunction Assessment Engine
 *
 * Pipeline: TLE pairs → SGP4 propagation → find TCA → B-plane projection
 *           → Alfano maximum collision probability → CDM output
 *
 * Collision probability method: Alfano (AAS 03-548)
 *   "Relating Position Uncertainty to Maximum Conjunction Probability"
 *   PDF: https://celestrak.org/SOCRATES/AIAA-03-548.pdf
 *
 * Validation target: CelesTrak SOCRATES Plus
 *   https://celestrak.org/SOCRATES/
 *   Method: SGP4 propagator, 5km threshold, 7-day lookahead
 *   Default RTN covariance: 100m R, 300m T, 100m N
 *
 * Covariance source:
 *   - Default: SOCRATES-style fixed RTN (100m, 300m, 100m)
 *   - OD from OEM: via Tudat's OrbitDeterminationManager + fitOrbitToEphemeris
 *     Source: DigitalArsenal/tudat-wasm
 *     Files: src/tudatpy_wasm/estimation/estimation_analysis/
 *   - Propagated: via Tudat's propagateCovarianceRsw()
 */

#include "sgp4_propagator.h"
#include "conjunction/ephemeris_source.h"
#include "conjunction/pc_method.h"
#include <optional>
#include <vector>
#include <string>

namespace conjunction {

/// Default hard-body radii (meters) — SOCRATES uses combined ~10m for LEO objects
constexpr double DEFAULT_RADIUS_M = 5.0;

/// Screening threshold (km)
constexpr double DEFAULT_THRESHOLD_KM = 5.0;

/// Conjunction event
struct ConjunctionEvent {
    // Object identifiers
    ObjectIdentity obj1;
    ObjectIdentity obj2;

    // Time of closest approach
    double tca_jd = 0.0;
    std::string tca_iso;

    // At TCA
    double min_range_km = 0.0;
    double rel_speed_kms = 0.0;

    // States at TCA (TEME)
    StateVector state1;
    StateVector state2;

    // Relative position/velocity at TCA (RTN frame)
    double rel_pos_r = 0.0, rel_pos_t = 0.0, rel_pos_n = 0.0;
    double rel_vel_r = 0.0, rel_vel_t = 0.0, rel_vel_n = 0.0;

    // Collision probability: the Alfano maximum (no covariance needed) unless
    // has_covariance, when covariance_probability is the probability method's
    // result from the covariance the sources supplied.
    double max_probability = 0.0;
    double dilution_threshold_km = 0.0;
    std::string probability_method = "ALFANO-MAXPROB";
    bool has_covariance = false;
    double covariance_probability = 0.0;

    // One-sigma RTN position uncertainty (metres) of each object, from the
    // supplied covariance; meaningful only when has_covariance. No source
    // covariance means none is reported: a TLE carries none.
    double cov_r1 = 0.0, cov_t1 = 0.0, cov_n1 = 0.0;  // Object 1
    double cov_r2 = 0.0, cov_t2 = 0.0, cov_n2 = 0.0;  // Object 2

    // Days since epoch for each object
    double dse1 = 0.0, dse2 = 0.0;
};

/// Lightweight exact conjunction solve result.
/// Use this when screening needs only the solved TCA and miss distance
/// before deciding whether to materialize a full event payload.
struct ConjunctionSolution {
    double tca_jd = 0.0;
    double min_range_km = 0.0;
};

/// Find Time of Closest Approach between two TLEs
/// Searches within [start_jd, start_jd + duration_days]
/// Uses bisection refinement after coarse step search
double find_tca(const TLE& tle1, const TLE& tle2,
                double start_jd, double duration_days = 7.0,
                double coarse_step_sec = 60.0, double fine_tol_sec = 0.001);

/// Solve only for TCA + miss distance, without building the full event payload.
ConjunctionSolution assess_conjunction_solution(
    const TLE& tle1, const TLE& tle2,
    double start_jd, double duration_days = 7.0);

/// Every local minimum of the pair's range inside
/// [start_jd, start_jd + duration_days] whose refined miss distance is within
/// threshold_km, in TCA order: the range is sampled every 5 s, each sample
/// below its neighbours (or a window edge not above its neighbour) brackets
/// a minimum, and golden section refines it to fine_tol_sec.
std::vector<ConjunctionSolution> assess_conjunction_solutions_within_threshold(
    const TLE& tle1, const TLE& tle2,
    double start_jd, double duration_days, double threshold_km,
    double fine_tol_sec = 0.001);

/// Solve only for TCA + miss distance inside an explicit search window,
/// seeded by a nearby TCA hint to avoid rescanning the whole interval.
ConjunctionSolution assess_conjunction_solution_in_window_near_hint(
    const TLE& tle1, const TLE& tle2,
    double search_start_jd,
    double search_end_jd,
    double tca_hint_jd);

/// Materialize the full conjunction payload at a known TCA.
ConjunctionEvent assess_conjunction_at_tca(
    const TLE& tle1, const TLE& tle2,
    double tca_jd,
    double radius1_m = DEFAULT_RADIUS_M,
    double radius2_m = DEFAULT_RADIUS_M);

/// Compute full conjunction assessment for a TLE pair
ConjunctionEvent assess_conjunction(
    const TLE& tle1, const TLE& tle2,
    double start_jd, double duration_days = 7.0,
    double radius1_m = DEFAULT_RADIUS_M,
    double radius2_m = DEFAULT_RADIUS_M);

/// Compute full conjunction assessment near a known TCA
/// Searches ±window_hours around tca_hint_jd
ConjunctionEvent assess_conjunction_near(
    const TLE& tle1, const TLE& tle2,
    double tca_hint_jd, double window_hours = 2.0,
    double radius1_m = DEFAULT_RADIUS_M,
    double radius2_m = DEFAULT_RADIUS_M);

/// Compute full conjunction assessment inside an explicit search window,
/// seeded by a nearby TCA hint to avoid rescanning the whole interval.
ConjunctionEvent assess_conjunction_in_window_near_hint(
    const TLE& tle1, const TLE& tle2,
    double search_start_jd,
    double search_end_jd,
    double tca_hint_jd,
    double radius1_m = DEFAULT_RADIUS_M,
    double radius2_m = DEFAULT_RADIUS_M);

// The same solves for any two trajectory sources (SGP4, OEM, PPE, ...). The
// TLE forms above evaluate each element set with SGP4.
double find_tca(const EphemerisSource& obj1, const EphemerisSource& obj2,
                double start_jd, double duration_days = 7.0,
                double coarse_step_sec = 60.0, double fine_tol_sec = 0.001);
/// find_tca's result, with its range, in a few evaluations when both sources
/// bound their acceleration and the range provably has one minimum on the
/// window (and the second beyond each edge that find_tca also searches);
/// nullopt otherwise, and find_tca scans.
std::optional<ConjunctionSolution> solve_unimodal_conjunction(
    const EphemerisSource& obj1, const EphemerisSource& obj2,
    double start_jd, double end_jd, double fine_tol_sec);
ConjunctionSolution assess_conjunction_solution(
    const EphemerisSource& obj1, const EphemerisSource& obj2,
    double start_jd, double duration_days = 7.0);
std::vector<ConjunctionSolution> assess_conjunction_solutions_within_threshold(
    const EphemerisSource& obj1, const EphemerisSource& obj2,
    double start_jd, double duration_days, double threshold_km,
    double fine_tol_sec = 0.001);
ConjunctionSolution assess_conjunction_solution_in_window_near_hint(
    const EphemerisSource& obj1, const EphemerisSource& obj2,
    double search_start_jd, double search_end_jd, double tca_hint_jd);
ConjunctionEvent assess_conjunction_at_tca(
    const EphemerisSource& obj1, const EphemerisSource& obj2, double tca_jd,
    double radius1_m = DEFAULT_RADIUS_M, double radius2_m = DEFAULT_RADIUS_M);
ConjunctionEvent assess_conjunction(
    const EphemerisSource& obj1, const EphemerisSource& obj2,
    double start_jd, double duration_days = 7.0,
    double radius1_m = DEFAULT_RADIUS_M, double radius2_m = DEFAULT_RADIUS_M);
ConjunctionEvent assess_conjunction_near(
    const EphemerisSource& obj1, const EphemerisSource& obj2,
    double tca_hint_jd, double window_hours = 2.0,
    double radius1_m = DEFAULT_RADIUS_M, double radius2_m = DEFAULT_RADIUS_M);
ConjunctionEvent assess_conjunction_in_window_near_hint(
    const EphemerisSource& obj1, const EphemerisSource& obj2,
    double search_start_jd, double search_end_jd, double tca_hint_jd,
    double radius1_m = DEFAULT_RADIUS_M, double radius2_m = DEFAULT_RADIUS_M);

/// Compute Alfano maximum collision probability
/// d = miss distance (km), Rc = combined hard-body radius (km)
/// Returns {max_probability, dilution_threshold_km}
struct ProbResult {
    double max_probability;
    double dilution_threshold_km;
    double sigma_star_km;
};
ProbResult alfano_max_probability(double miss_distance_km, double combined_radius_km);

/// Compute collision probability with covariance
/// Full B-plane projection method
/// pos1, vel1, pos2, vel2: states in same frame (km, km/s)
/// cov1, cov2: 3x3 position covariance matrices (km²)
/// combined_radius: hard-body radius (km)
double collision_probability(
    const StateVector& state1, const StateVector& state2,
    const double cov1[9], const double cov2[9],
    double combined_radius_km);

/// Screen a set of TLEs for conjunctions
std::vector<ConjunctionEvent> screen_conjunctions(
    const std::vector<TLE>& primary_tles,
    const std::vector<TLE>& secondary_tles,
    double start_jd,
    double duration_days = 7.0,
    double threshold_km = DEFAULT_THRESHOLD_KM);

/// Convert inertial state to RTN frame relative to a reference state
void inertial_to_rtn(const StateVector& ref, const StateVector& target,
                     double& r, double& t, double& n,
                     double& vr, double& vt, double& vn);

/// Serialize a conjunction event to CCSDS CDM FlatBuffers binary ($CDM identifier)
/// Returns bytes written (>=0 success), -2 buffer too small, -1 error
int32_t conjunction_to_cdm(
    const ConjunctionEvent& event,
    uint8_t* output, uint32_t output_capacity,
    const std::string& reference_frame = "TEME");

/// Serialize a conjunction event to SDS CSM FlatBuffers binary ($CSM identifier)
/// Returns bytes written (>=0 success), -2 buffer too small, -1 error
int32_t conjunction_to_csm(
    const ConjunctionEvent& event,
    uint8_t* output, uint32_t output_capacity);

/// Serialize multiple conjunction events as size-prefixed CDM collection
int32_t conjunctions_to_cdm_batch(
    const std::vector<ConjunctionEvent>& events,
    uint8_t* output, uint32_t output_capacity);

/// Parse a CCSDS CDM KVN text message into an SDS CDM FlatBuffer binary.
/// Returns bytes written (>=0 success), -2 buffer too small, -1 parse/error.
int32_t cdm_kvn_to_sds(
    const char* kvn_text, uint32_t kvn_text_size,
    uint8_t* output, uint32_t output_capacity);

/// Whether both objects of an SDS CDM FlatBuffer carry covariance; if not,
/// sets the error saying so. Probability and CCSDS text need it.
bool cdm_has_covariance(const uint8_t* cdm_buffer, uint32_t cdm_buffer_size);

/// Write an SDS CDM FlatBuffer binary as CCSDS CDM KVN text.
/// Returns bytes written (>=0 success), -2 buffer too small, -1 parse/error,
/// -3 an object has no covariance (CCSDS requires it; none is invented).
int32_t cdm_sds_to_kvn(
    const uint8_t* cdm_buffer, uint32_t cdm_buffer_size,
    char* output, uint32_t output_capacity);

/// Parse a CCSDS CDM XML text message into an SDS CDM FlatBuffer binary.
/// Returns bytes written (>=0 success), -2 buffer too small, -1 parse/error.
int32_t cdm_xml_to_sds(
    const char* xml_text, uint32_t xml_text_size,
    uint8_t* output, uint32_t output_capacity);

/// Write an SDS CDM FlatBuffer binary as CCSDS CDM XML text.
/// Returns bytes written (>=0 success), -2 buffer too small, -1 parse/error,
/// -3 an object has no covariance (CCSDS requires it; none is invented).
int32_t cdm_sds_to_xml(
    const uint8_t* cdm_buffer, uint32_t cdm_buffer_size,
    char* output, uint32_t output_capacity);

/// Compute collision probability from an SDS CDM FlatBuffer binary ($CDM identifier).
/// If method_override is empty, COLLISION_PROBABILITY_METHOD from the CDM is used,
/// falling back to FOSTER-2D when the CDM does not name a method.
PcResult compute_pc_from_cdm(
    const uint8_t* cdm_buffer, uint32_t cdm_buffer_size,
    const std::string& method_override = std::string(),
    double combined_radius_km = 0.01);

} // namespace conjunction

#endif // CONJUNCTION_ASSESSMENT_H
