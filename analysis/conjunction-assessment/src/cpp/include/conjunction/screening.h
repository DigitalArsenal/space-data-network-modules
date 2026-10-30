#ifndef CONJUNCTION_SCREENING_H
#define CONJUNCTION_SCREENING_H

/**
 * High-Performance Conjunction Screening Engine
 *
 * Architecture:
 *   1. Perigee/apogee prefilter (O(n) per pair — eliminate impossible pairs)
 *   2. Coarse propagation at ~60s steps with KD-tree spatial indexing
 *   3. Dynamic windowing: adapt step size based on closing rate
 *   4. Fine TCA search with golden section for candidates within threshold
 *   5. Full conjunction assessment for confirmed close approaches
 *
 * Threading (pthreads):
 *   - Time steps are divided among threads
 *   - Each thread propagates all objects for its assigned time steps
 *   - KD-tree built per time step (owned by thread)
 *   - Candidate pairs merged with mutex-free per-thread collection
 *   - TCA refinement parallelized per candidate pair
 *
 * For WASM (SDK wasi-threads):
 *   - wasm32-wasip1-threads -pthread
 *   - wasi.thread-spawn and wasi_thread_start
 *   - shared memory and atomics
 *   - SharedArrayBuffer required in browser (COOP/COEP headers)
 */

#include "conjunction/conjunction_assessment.h"
#include "conjunction/kdtree.h"
#include "conjunction/gp_json.h"
#include "conjunction/screening_internal.h"
#include <cstdint>
#include <vector>
#include <functional>
#include <atomic>
#include <map>
#include <string>

namespace conjunction {

struct ResidentScreeningIndex;

/// Trajectory sources by catalog index: what encounter refinement evaluates.
using SourceRefs = std::vector<const EphemerisSource*>;

/// SGP4 sources for a TLE catalog, one per element set, index for index.
struct Sgp4Sources {
    explicit Sgp4Sources(const std::vector<TLE>& tles) {
        owned.reserve(tles.size());
        for (const auto& tle : tles) owned.emplace_back(tle);
        for (const auto& source : owned) refs.push_back(&source);
    }
    Sgp4Sources(const Sgp4Sources&) = delete;
    Sgp4Sources& operator=(const Sgp4Sources&) = delete;
    std::vector<SGP4EphemerisSource> owned;
    SourceRefs refs;
};

/// Screening configuration
struct ScreeningConfig {
    double start_jd = 0.0;          // Start of screening window
    double duration_days = 7.0;     // Screening duration
    double threshold_km = 5.0;      // Miss distance threshold
    double coarse_step_sec = 60.0;  // Base coarse step size
    double fine_tol_sec = 0.001;    // TCA refinement tolerance
    double combined_radius_m = 10.0; // Combined hard-body radius
    // Each object's hard-body radius (m) and the caller's code for where it
    // came from, by source index. Absent entries are half combined_radius_m
    // with basis 0.
    std::vector<double> hard_body_radius_m;
    std::vector<uint8_t> radius_basis;
    int num_threads = 4;            // Thread pool size
    bool use_kdtree = true;         // Use KD-tree (vs brute force)
    bool use_dynamic_window = true; // Adaptive step size
    bool use_perigee_filter = true; // Prefilter by altitude overlap

    // Progress reporting — 0 disables, >0 fires every N simulated seconds.
    double progress_interval_sec = 0.0;

    // Dynamic windowing params
    double min_step_sec = 5.0;      // Minimum step when objects closing fast
    double max_step_sec = 120.0;    // Maximum step when objects far apart
    double close_threshold_km = 100.0; // Distance to start reducing step
};

/// An object's hard-body radius (m) under the config.
inline double object_radius_m(const ScreeningConfig& config, uint32_t index) {
    return index < config.hard_body_radius_m.size() ? config.hard_body_radius_m[index]
                                                    : config.combined_radius_m / 2.0;
}
inline uint8_t object_radius_basis(const ScreeningConfig& config, uint32_t index) {
    return index < config.radius_basis.size() ? config.radius_basis[index] : 0;
}

/// Screening progress callback
using ProgressCallback = std::function<void(double fraction, const std::string& status)>;

/// An object the propagator refuses during the window (for SGP4, an element
/// set that decays or whose eccentricity leaves its range: "SGP4: decayed
/// (the radius is below one Earth radius)", ...). The coarse pass records the
/// earliest coarse epoch it refused, whatever the worker count. An object
/// refused at the window's first epoch is excluded from every pair; one valid
/// for part of the window is screened up to its last valid instant, and its
/// conjunctions before that are kept. Every other pair is screened exactly as
/// it would be without it.
struct ExcludedObject {
    uint32_t index = 0;             // position in the screened TLE vector
    double first_failure_jd = 0.0;  // earliest coarse epoch that failed (UTC JD)
    std::string reason;             // propagator error at that epoch
    // The object's span: the propagator gives its state up to last_valid_jd
    // and refuses it from refused_jd (bisected to the millisecond), the
    // refusal being reason. last_valid_jd 0: refused from the window start,
    // so the object is excluded.
    double last_valid_jd = 0.0;
    double refused_jd = 0.0;
    bool excluded() const { return last_valid_jd == 0.0; }
    // Filled by callers that know where the object came from.
    int input_list = -1;            // ConjunctionScreener: 0 primaries, 1 secondaries
    uint32_t input_index = 0;       // position in that input vector
    uint32_t source_handle = 0;     // resident index source handle, 0 = none
};

/// The span of a source the propagator gives a state at valid_jd and refuses
/// at refused_jd (with refusal): bisected until the two instants are a
/// millisecond apart, into object's last_valid_jd, refused_jd and reason.
void bisect_source_span(const EphemerisSource& source, double valid_jd, double refused_jd,
                        std::string refusal, ExcludedObject& object);

/// A pair whose evaluation failed for a reason no span explains (a numerical
/// failure, or a refusal inside an object's span): it is not screened, and the
/// result names it.
struct FailedPair {
    ObjectIdentity obj1, obj2;
    std::string reason;
};

/// Screening statistics
struct ScreeningStats {
    uint64_t total_objects = 0;
    uint64_t pairs_screened = 0;
    uint64_t pairs_prefiltered = 0;  // Eliminated by perigee/apogee
    uint64_t kdtree_candidates = 0;  // Candidates from KD-tree
    uint64_t tca_refined = 0;        // Pairs with TCA refinement
    uint64_t conjunctions_found = 0; // Final confirmed conjunctions
    uint64_t propagations = 0;       // Total SGP4 propagations
    uint64_t failed_pairs = 0;       // Failed refinement/assessment evaluations
    double elapsed_ms = 0.0;         // Wall clock time
    /// Objects the propagator refuses inside the window, ordered by index:
    /// excluded ones (refused from the start) and ones screened up to their
    /// last valid instant. total_objects still counts them.
    std::vector<ExcludedObject> excluded_objects;
    /// The failed pairs (failed_pairs of them when the path names its pairs).
    std::vector<FailedPair> failed_pair_list;
};

struct ScreeningThreadWork {
    std::string error;
    std::vector<CoarseHitRecord> coarse_hits;
    std::vector<CandidatePair> candidates;
    uint64_t propagations = 0;
    /// Pairs (coarse_hit_key) the epoch altitude bands separate that the
    /// radial gate admitted at some coarse step (screening_internal.h).
    std::vector<uint64_t> radial_admissions;
    /// Per-worker exclusions keyed by object index (earliest failure kept).
    std::map<uint32_t, ExcludedObject> excluded;
};

/// Can objects at these altitudes ever meet?
/// Returns false if perigee/apogee ranges don't overlap
bool altitude_overlap(const GPElement& gp1, const GPElement& gp2,
                      double margin_km = 50.0);

/// Screens valid_pairs. With primary_side and secondary_side (one flag per
/// TLE), valid_pairs are the pairs the epoch altitude bands admit and every
/// other primary-secondary pair is screened too, at each coarse step where the
/// radial gate admits it (screening_internal.h).
std::vector<ConjunctionEvent> screen_precomputed_tles(
    const std::vector<TLE>& tles,
    const std::vector<std::pair<uint32_t, uint32_t>>& valid_pairs,
    const ScreeningConfig& config,
    ScreeningStats& stats,
    ProgressCallback progress = nullptr,
    const std::vector<uint8_t>& primary_side = {},
    const std::vector<uint8_t>& secondary_side = {});

/// Implicit-pair variant: generates pairs on-the-fly from KD-tree spatial
/// proximity gated by per-object altitude overlap, avoiding the need to
/// materialize and store the full candidate pair list.  This is the only
/// path that can handle large active-on-all catalogs (N > ~10 000)
/// within the 512 MB WASM heap.
///
/// perigee_km / apogee_km must each contain exactly one entry per TLE.
/// is_primary / participates: empty vectors mean "all objects"; otherwise
/// they must each contain exactly one entry per TLE.
std::vector<ConjunctionEvent> screen_precomputed_tles_implicit(
    const std::vector<TLE>& tles,
    const std::vector<float>& perigee_km,
    const std::vector<float>& apogee_km,
    const std::vector<uint8_t>& is_primary,
    const std::vector<uint8_t>& participates,
    const ScreeningConfig& config,
    ScreeningStats& stats,
    ProgressCallback progress = nullptr,
    const ResidentScreeningIndex* resident_index = nullptr);

/// High-performance conjunction screener
class ConjunctionScreener {
public:
    explicit ConjunctionScreener(const ScreeningConfig& config)
        : config_(config) {}

    /// Screen a catalog of GP elements for conjunctions
    /// Returns confirmed conjunction events sorted by max probability (desc)
    std::vector<ConjunctionEvent> screen(
        const std::vector<GPElement>& catalog,
        ProgressCallback progress = nullptr);

    /// Screen primary vs secondary catalog
    std::vector<ConjunctionEvent> screen(
        const std::vector<GPElement>& primaries,
        const std::vector<GPElement>& secondaries,
        ProgressCallback progress = nullptr);

    /// Get statistics from the last screening run
    const ScreeningStats& stats() const { return stats_; }

private:
    ScreeningConfig config_;
    ScreeningStats stats_;
    std::atomic<uint64_t> propagation_count_{0};

    /// Prefilter pairs by perigee/apogee overlap
    std::vector<std::pair<uint32_t, uint32_t>> prefilter_pairs(
        const std::vector<GPElement>& catalog);

    /// Prefilter only cross-catalog primary-vs-secondary pairs.
    std::vector<std::pair<uint32_t, uint32_t>> prefilter_cross_pairs(
        const std::vector<GPElement>& catalog,
        const std::vector<uint32_t>& primary_indices,
        const std::vector<uint32_t>& secondary_indices,
        uint64_t* total_pairs_out = nullptr);

    /// Dynamic step size based on closing rate
    double adaptive_step(double distance_km, double closing_rate_kms) const;
};

} // namespace conjunction

#endif // CONJUNCTION_SCREENING_H
