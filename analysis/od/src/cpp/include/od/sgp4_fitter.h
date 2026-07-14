#ifndef OD_SGP4_FITTER_H
#define OD_SGP4_FITTER_H

/**
 * SGP4 Differential Correction (Element Fitting) — Equinoctial Formulation
 *
 * Given truth ephemeris data, fit SGP4 mean elements that minimize
 * position RMS over the fit span. Produces SupGP/OMM records.
 *
 * Method: Levenberg-Marquardt with equinoctial elements (Vallado AIAA 2008-6770)
 *   - Parameters: [af, ag, a, L, pe, qe, B*] (7 parameters)
 *   - Observations: position vectors from operator ephemeris
 *   - Jacobian: forward finite differences with uniform percentchg
 *   - SVD solve for numerical stability
 *
 * Reference: "Revisiting Spacetrack Report #3" (AIAA 2006-6753)
 *            Vallado, Crawford, Hujsak, Kelso
 *            "SGP4 Orbit Determination" (AIAA 2008-6770)
 */

#include "meme_parser.h"
#include "state_series.h"
#include <cstdint>
#include <string>
#include <vector>
#include <array>

namespace od {

/// SGP4 mean elements (OMM/GP format) — classical output
struct SGP4Elements {
    double epoch_jd;           // Epoch (Julian Date)
    std::string epoch_iso;     // Epoch (ISO 8601)

    double mean_motion;        // rev/day
    double eccentricity;       // dimensionless
    double inclination;        // degrees
    double ra_of_asc_node;     // degrees (RAAN/Ω)
    double arg_of_pericenter;  // degrees (ω)
    double mean_anomaly;       // degrees (M)
    double bstar;              // B* drag term (1/earth radii)
    double mean_motion_dot;    // rev/day² (ṅ, NOT ndot/2)
    double mean_motion_ddot;   // rev/day³ (n̈, usually 0)

    // Metadata
    int norad_cat_id = 0;
    std::string object_name;
    std::string object_id;     // International designator (e.g., "2019-074B")
    int element_set_no = 69;   // CelesTrak SupGP convention
    int rev_at_epoch = 1;      // SupGP convention
    char classification = 'C'; // 'C' for CelesTrak supplemental
    int ephemeris_type = 0;

    // Fit quality
    double rms_km = 0.0;       // RMS of fit (km)
    int iterations = 0;
    int max_iterations = 0;
    bool converged = false;
    std::string data_source;   // "SpaceX-E", etc.

    // A2.4d same-ephemeris reference RMS (OWNER RULING 2026-07-13 "same
    // ephemeris"). When a reference element set is supplied to the fit (a
    // captured CelesTrak SupGP OMM), the fitter ALSO propagates THOSE elements
    // via the SAME SGP4 over the SAME winning fit_points and records their RMS
    // here — enabling the beatsCelestrakSameEphemeris gate (our rms_km <=
    // reference_rms_km on identical states). Absent by default; only emitted to
    // JSON when has_reference_rms is true, so every non-reference fit is
    // byte-for-byte unchanged.
    bool has_reference_rms = false;
    double reference_rms_km = 0.0;
};

/// Fitting configuration
struct FitterConfig {
    // 0 means use each solver phase's production default. Positive values cap
    // every iterative phase for interactive/UI-bounded fits.
    int max_iterations = 0;
    double convergence_tol = 0.0002; // Relative sigma change threshold (Vallado)

    // Fit window (seconds from epoch)
    double fit_window_sec = 11520.0; // ~192 min = 2 orbital periods for LEO

    // Subsample: target ~144 points over fit window
    int subsample = 1;

    // B* bounds
    double bstar_max = 1.0;
    double bstar_min = -1.0;

    // Position-only sources (SP3/CPF/ECF, STATE_VECTOR_SIZE 3) carry no
    // velocities. When true, the initial-guess velocity is estimated from the
    // input positions (a documented quadratic finite-difference initializer, see
    // estimate_velocity_from_positions in sgp4_fitter.cpp) instead of reading the
    // sample velocities; the fit itself remains position-residual only, so the
    // fitted velocity comes from the SGP4 dynamics, not from differencing the
    // input. DEFAULT false keeps every full-state path (MEME/OEM w/ velocities)
    // byte-for-byte unchanged. fit_sgp4_series sets this from series.meta.
    bool position_only = false;

    // A2.4d same-ephemeris reference scoring (OWNER RULING 2026-07-13). When
    // has_reference is true, the fitter propagates reference_elements via the
    // SAME SGP4 over the SAME winning fit_points our fit used and reports
    // reference_rms_km on the result (the beatsCelestrakSameEphemeris gate:
    // our RMS <= theirs on identical states). Reusable by any provider manifest
    // (GLONASS/CPF/Intelsat may adopt it once their arcs upgrade). Default false
    // => no reference scoring, every existing fit byte-for-byte identical.
    bool has_reference = false;
    SGP4Elements reference_elements{};
};

/// Fit result
struct FitResult {
    SGP4Elements elements;
    std::vector<double> residuals_km;  // Per-point residuals
    double rms_km;
    int iterations;
    bool converged;
};

/// Fit SGP4 elements to ephemeris data
FitResult fit_sgp4(
    const std::vector<EphemerisPoint>& points,
    const FitterConfig& config = {});

/// Fit SGP4 elements to a common state-vector series and label the result from
/// the series metadata (data_source flows from the caller/manifest;
/// OBJECT_NAME/OBJECT_ID/NORAD flow from the parsed ephemeris when present).
/// This is the format-neutral entry point both the MEME and OEM paths use.
FitResult fit_sgp4_series(
    const StateSeries& series,
    const FitterConfig& config = {});

/// Fit SGP4 elements from a MEME file. `data_source` is the provider/source
/// token supplied by the caller/manifest (empty = unlabeled); it is NOT
/// hardcoded to any operator.
FitResult fit_sgp4_meme(
    const MEMEFile& meme,
    const FitterConfig& config = {},
    const std::string& data_source = std::string());

/// Convert Cartesian state → Keplerian elements (initial guess)
/// Returns [a(km), e, i(rad), Ω(rad), ω(rad), M(rad)]
std::array<double, 6> cartesian_to_keplerian(
    double x, double y, double z,
    double vx, double vy, double vz);

/// Convert Keplerian elements → SGP4 mean elements
SGP4Elements keplerian_to_mean(
    const std::array<double, 6>& kepler,
    double epoch_jd);

/// Format SupGP record as CSV line
std::string elements_to_csv(const SGP4Elements& el);

/// Format SupGP record as JSON object
std::string elements_to_json(const SGP4Elements& el);

/// Format as TLE lines (2 or 3 lines including line 0)
std::string elements_to_tle(const SGP4Elements& el);

}  // namespace od

#endif  // OD_SGP4_FITTER_H
