#include "conjunction/resident_screening_index.h"
#include "conjunction/sgp4_propagator.h"
#include "orbpro/generated/PropagatorTrajectorySegments_generated.h"
#include "orbpro/generated/StateVector_generated.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <limits>
#include <numeric>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>

namespace conjunction {

namespace {

constexpr int CHEBY_N = 12;
constexpr int CHEBY_NPTS = CHEBY_N + 1;
constexpr double EARTH_RADIUS_KM = 6378.137;
constexpr double MU_EARTH_KM3_S2 = 398600.4418;

std::atomic<uint32_t> g_next_screening_index_handle{1};
std::unordered_map<uint32_t, ResidentScreeningIndex> g_resident_screening_indexes;

double compute_conservative_speed_bound_km_s(const GPElement& gp) {
    const double perigee_radius_km =
        EARTH_RADIUS_KM + std::max(0.0, gp.perigee_km);
    const double semi_major_axis_km =
        gp.semi_major_axis_km > EARTH_RADIUS_KM
            ? gp.semi_major_axis_km
            : EARTH_RADIUS_KM +
                  std::max(0.0, (gp.perigee_km + gp.apogee_km) * 0.5);
    if (!(perigee_radius_km > 0.0) ||
        !(semi_major_axis_km >= perigee_radius_km)) {
        return 0.0;
    }
    const double vis_viva_term =
        MU_EARTH_KM3_S2 *
        ((2.0 / perigee_radius_km) - (1.0 / semi_major_axis_km));
    return vis_viva_term > 0.0 ? std::sqrt(vis_viva_term) : 0.0;
}

GPElement decode_source_description(
    const orbpro::propagator::PropagatorSourceDescription& source) {
    GPElement gp;
    gp.object_name =
        source.objectName() != nullptr ? source.objectName()->str() : std::string();
    gp.object_id =
        source.objectId() != nullptr ? source.objectId()->str() : std::string();
    gp.epoch_jd = source.epochJd();
    gp.epoch_iso = gp.epoch_jd > 0.0 ? jd_to_iso(gp.epoch_jd) : std::string();
    gp.mean_motion = source.meanMotionRevPerDay();
    gp.eccentricity = source.eccentricity();
    gp.inclination = source.inclinationDeg();
    gp.ra_of_asc_node = source.raOfAscNodeDeg();
    gp.arg_of_pericenter = source.argOfPericenterDeg();
    gp.mean_anomaly = source.meanAnomalyDeg();
    gp.ephemeris_type = source.ephemerisType();
    const std::string classification =
        source.classificationType() != nullptr
            ? source.classificationType()->str()
            : std::string("U");
    gp.classification_type = classification.empty() ? 'U' : classification.front();
    gp.norad_cat_id = static_cast<int>(source.noradCatId());
    gp.element_set_no = static_cast<int>(source.elementSetNo());
    gp.rev_at_epoch = static_cast<int>(source.revAtEpoch());
    gp.bstar = source.bstar();
    gp.mean_motion_dot = source.meanMotionDotRevPerDay2();
    gp.mean_motion_ddot = source.meanMotionDdotRevPerDay3();
    compute_derived(gp);
    gp.perigee_km = source.perigeeKm() > 0.0 ? source.perigeeKm() : gp.perigee_km;
    gp.apogee_km = source.apogeeKm() > 0.0 ? source.apogeeKm() : gp.apogee_km;
    return gp;
}

void chebyshev_fit(
    const std::array<double, CHEBY_NPTS>& values,
    std::array<double, RESIDENT_CHEBYSHEV_COEFFICIENT_COUNT>& coefficients_out) {
    coefficients_out.fill(0.0);
    for (int j = 0; j <= CHEBY_N; j++) {
        double sum = 0.0;
        for (int k = 0; k <= CHEBY_N; k++) {
            const double weight = (k == 0 || k == CHEBY_N) ? 0.5 : 1.0;
            sum +=
                weight *
                values[static_cast<size_t>(k)] *
                std::cos(j * k * M_PI / CHEBY_N);
        }
        coefficients_out[static_cast<size_t>(j)] =
            2.0 * sum / static_cast<double>(CHEBY_N);
    }
    coefficients_out[0] *= 0.5;
    coefficients_out[CHEBY_N] *= 0.5;
}

void copy_coefficients(
    const flatbuffers::Vector<double>* values,
    std::array<double, RESIDENT_CHEBYSHEV_COEFFICIENT_COUNT>& coefficients_out) {
    coefficients_out.fill(0.0);
    if (values == nullptr) {
        return;
    }
    const size_t count = std::min(
        static_cast<size_t>(values->size()),
        RESIDENT_CHEBYSHEV_COEFFICIENT_COUNT);
    for (size_t index = 0; index < count; index++) {
        coefficients_out[index] = values->Get(index);
    }
}

ResidentTrajectorySegment decode_trajectory_segment(
    const orbpro::propagator::PropagatorTrajectorySegment& segment) {
    ResidentTrajectorySegment decoded;
    decoded.source_handle = segment.sourceHandle();
    decoded.start_jd = segment.startJd();
    decoded.end_jd = segment.endJd();
    decoded.degree = segment.degree();
    decoded.reference_frame = static_cast<uint8_t>(segment.referenceFrame());
    copy_coefficients(segment.xCoefficients(), decoded.x_coefficients);
    copy_coefficients(segment.yCoefficients(), decoded.y_coefficients);
    copy_coefficients(segment.zCoefficients(), decoded.z_coefficients);
    copy_coefficients(segment.vxCoefficients(), decoded.vx_coefficients);
    copy_coefficients(segment.vyCoefficients(), decoded.vy_coefficients);
    copy_coefficients(segment.vzCoefficients(), decoded.vz_coefficients);
    decoded.max_position_error_km = segment.maxPositionErrorKm();
    decoded.max_velocity_error_km_s = segment.maxVelocityErrorKmS();
    return decoded;
}

ResidentTrajectorySegment build_sampled_resident_segment(
    uint32_t source_handle,
    double start_jd,
    double end_jd,
    orbpro::propagator::ReferenceFrame reference_frame,
    const std::array<orbpro::propagator::StateVector, CHEBY_NPTS>& samples) {
    std::array<double, CHEBY_NPTS> component_samples[6];
    for (size_t sample_index = 0; sample_index < CHEBY_NPTS; sample_index++) {
        const auto& sample = samples[sample_index];
        component_samples[0][sample_index] = sample.position().x();
        component_samples[1][sample_index] = sample.position().y();
        component_samples[2][sample_index] = sample.position().z();
        component_samples[3][sample_index] = sample.velocity().x();
        component_samples[4][sample_index] = sample.velocity().y();
        component_samples[5][sample_index] = sample.velocity().z();
    }

    ResidentTrajectorySegment segment = {};
    segment.source_handle = source_handle;
    segment.start_jd = start_jd;
    segment.end_jd = end_jd;
    segment.degree = CHEBY_N;
    segment.reference_frame = static_cast<uint8_t>(reference_frame);
    chebyshev_fit(component_samples[0], segment.x_coefficients);
    chebyshev_fit(component_samples[1], segment.y_coefficients);
    chebyshev_fit(component_samples[2], segment.z_coefficients);
    chebyshev_fit(component_samples[3], segment.vx_coefficients);
    chebyshev_fit(component_samples[4], segment.vy_coefficients);
    chebyshev_fit(component_samples[5], segment.vz_coefficients);
    segment.max_position_error_km = 0.0;
    segment.max_velocity_error_km_s = 0.0;
    return segment;
}

/// Count candidate pairs and mark participating objects WITHOUT materializing
/// the pair list.  Uses the same perigee-sorted sweep as before but only
/// increments counters and sets participation flags.
uint64_t count_candidate_pairs_and_mark(
    const std::vector<float>& perigee,
    const std::vector<float>& apogee,
    const std::vector<uint8_t>& is_primary,
    std::vector<uint8_t>& participates,
    uint64_t* total_pair_count_out) {

    const size_t n = perigee.size();
    const bool all_primary = is_primary.empty();

    // Total possible pairs (for stats)
    if (total_pair_count_out != nullptr) {
        if (n < 2) {
            *total_pair_count_out = 0;
        } else if (all_primary) {
            *total_pair_count_out =
                (static_cast<uint64_t>(n) * (static_cast<uint64_t>(n) - 1)) / 2;
        } else {
            uint64_t primary_count = 0;
            for (size_t i = 0; i < n; i++) {
                if (is_primary[i]) primary_count++;
            }
            uint64_t secondary_count = n - primary_count;
            *total_pair_count_out =
                primary_count * secondary_count +
                (primary_count * (primary_count - 1)) / 2;
        }
    }

    if (n < 2) {
        return 0;
    }

    // Sort by perigee
    std::vector<uint32_t> order(n);
    std::iota(order.begin(), order.end(), 0);
    std::sort(order.begin(), order.end(),
        [&](uint32_t a, uint32_t b) { return perigee[a] < perigee[b]; });

    const float margin = 50.0f;
    uint64_t candidate_count = 0;

    for (size_t ii = 0; ii < n; ii++) {
        const uint32_t idx = order[ii];
        const float high = apogee[idx] + margin;

        for (size_t jj = ii + 1; jj < n; jj++) {
            const uint32_t other = order[jj];
            if (perigee[other] - margin > high) {
                break;
            }

            // Check primary scoping
            if (!all_primary &&
                !is_primary[idx] && !is_primary[other]) {
                continue;
            }

            // Full altitude overlap check
            const float lo1 = perigee[idx] - margin;
            const float hi1 = apogee[idx] + margin;
            const float lo2 = perigee[other] - margin;
            const float hi2 = apogee[other] + margin;
            if (lo1 <= hi2 && lo2 <= hi1) {
                candidate_count++;
                participates[idx] = 1;
                participates[other] = 1;
            }
        }
    }

    return candidate_count;
}

} // namespace

ResidentScreeningIndexBuildResult build_resident_screening_index(
    uint32_t catalog_handle,
    uint32_t segment_set_handle,
    const std::vector<uint32_t>& primary_source_handles,
    orbpro::conjunction::ConjunctionScreeningMode screening_mode,
    const orbpro::propagator::PropagatorDescribeSourcesBatchResult* descriptions,
    const orbpro::propagator::PropagatorDescribeTrajectorySegmentsResult* segments) {
    if (descriptions == nullptr || descriptions->sources() == nullptr) {
        throw std::runtime_error(
            "prepare_screening_index requires PropagatorDescribeSourcesBatchResult source metadata.");
    }

    ResidentScreeningIndex index;
    index.screening_index_handle = g_next_screening_index_handle.fetch_add(1);
    index.catalog_handle = catalog_handle;
    index.segment_set_handle = segment_set_handle;
    index.screening_mode = screening_mode;

    const auto source_count = descriptions->sources()->size();
    const bool require_segment_coverage =
        segments != nullptr &&
        screening_mode != orbpro::conjunction::ConjunctionScreeningMode::exact_only;
    std::unordered_set<uint32_t> covered_source_handles;
    if (segments != nullptr && segments->segments() != nullptr) {
        covered_source_handles.reserve(segments->segments()->size());
        for (flatbuffers::uoffset_t segment_index = 0;
             segment_index < segments->segments()->size();
             segment_index++) {
            const auto* segment = segments->segments()->Get(segment_index);
            if (segment == nullptr) {
                continue;
            }
            covered_source_handles.insert(segment->sourceHandle());
        }
    }
    index.source_handles.reserve(source_count);
    index.tles.reserve(source_count);
    index.perigee_km.reserve(source_count);
    index.apogee_km.reserve(source_count);
    index.max_speed_km_s.reserve(source_count);

    std::unordered_map<uint32_t, uint32_t> source_handle_to_index;

    for (flatbuffers::uoffset_t source_index = 0;
         source_index < source_count;
         source_index++) {
        const auto* source = descriptions->sources()->Get(source_index);
        if (source == nullptr) {
            continue;
        }
        if (source->sourceKind() != orbpro::propagator::PropagatorSourceKind_SGP4) {
            throw std::runtime_error(
                "prepare_screening_index currently supports only SGP4 resident sources.");
        }
        if (
            require_segment_coverage &&
            covered_source_handles.find(source->sourceHandle()) ==
                covered_source_handles.end()) {
            continue;
        }

        GPElement gp = decode_source_description(*source);
        index.source_handles.push_back(source->sourceHandle());
        index.perigee_km.push_back(static_cast<float>(gp.perigee_km));
        index.apogee_km.push_back(static_cast<float>(gp.apogee_km));
        index.max_speed_km_s.push_back(
            static_cast<float>(compute_conservative_speed_bound_km_s(gp)));
        index.tles.push_back(gp_to_tle(gp));
        source_handle_to_index[source->sourceHandle()] =
            static_cast<uint32_t>(index.tles.size() - 1);
    }
    index.trajectory_segments.resize(index.source_handles.size());

    if (segments != nullptr && segments->segments() != nullptr) {
        for (flatbuffers::uoffset_t segment_index = 0;
             segment_index < segments->segments()->size();
             segment_index++) {
            const auto* segment = segments->segments()->Get(segment_index);
            if (segment == nullptr) {
                continue;
            }
            const auto found = source_handle_to_index.find(segment->sourceHandle());
            if (found == source_handle_to_index.end()) {
                continue;
            }
            index.trajectory_segments[found->second].push_back(
                decode_trajectory_segment(*segment));
        }
    }

    const uint32_t n = static_cast<uint32_t>(index.tles.size());

    // Build primary scoping flags.
    std::unordered_set<uint32_t> primary_handle_set(
        primary_source_handles.begin(),
        primary_source_handles.end());
    const bool all_primary =
        primary_handle_set.empty() || primary_handle_set.size() >= n;

    if (!all_primary) {
        index.is_primary.resize(n, 0);
        for (uint32_t handle : primary_handle_set) {
            const auto found = source_handle_to_index.find(handle);
            if (found != source_handle_to_index.end()) {
                index.is_primary[found->second] = 1;
            }
        }
    }

    // Count candidate pairs and mark participating objects.
    index.participates.resize(n, 0);
    index.candidate_pair_count = count_candidate_pairs_and_mark(
        index.perigee_km,
        index.apogee_km,
        index.is_primary,
        index.participates,
        &index.total_pair_count);
    index.pairs_prefiltered =
        index.total_pair_count >= index.candidate_pair_count
            ? index.total_pair_count - index.candidate_pair_count
            : 0;

    // If all objects participate, clear the vector to save a trivial amount
    // of memory and simplify the "all participate" fast path.
    bool all_participate = true;
    for (size_t i = 0; i < n && all_participate; i++) {
        if (!index.participates[i]) all_participate = false;
    }
    if (all_participate) {
        index.participates.clear();
    }

    const uint32_t handle = index.screening_index_handle;
    const uint64_t candidate_pair_count = index.candidate_pair_count;
    g_resident_screening_indexes[handle] = std::move(index);

    return {
        handle,
        n,
        candidate_pair_count,
    };
}

ResidentScreeningIndexBuildResult prepare_resident_screening_index(
    uint32_t catalog_handle,
    const std::vector<uint32_t>& primary_source_handles,
    const orbpro::propagator::PropagatorDescribeSourcesBatchResult* descriptions) {
    return build_resident_screening_index(
        catalog_handle,
        0,
        primary_source_handles,
        orbpro::conjunction::ConjunctionScreeningMode::exact_only,
        descriptions,
        nullptr);
}

ResidentScreeningIndexBuildResult prepare_resident_segment_screening_index(
    uint32_t catalog_handle,
    uint32_t segment_set_handle,
    const std::vector<uint32_t>& primary_source_handles,
    orbpro::conjunction::ConjunctionScreeningMode screening_mode,
    const orbpro::propagator::PropagatorDescribeSourcesBatchResult* descriptions,
    const orbpro::propagator::PropagatorDescribeTrajectorySegmentsResult* segments) {
    if (segments == nullptr) {
        throw std::runtime_error(
            "prepare_segment_screening_index requires PropagatorDescribeTrajectorySegmentsResult segment metadata.");
    }
    return build_resident_screening_index(
        catalog_handle,
        segment_set_handle,
        primary_source_handles,
        screening_mode,
        descriptions,
        segments);
}

ResidentScreeningIndexBuildResult prepare_resident_sample_screening_index(
    uint32_t catalog_handle,
    const std::vector<uint32_t>& primary_source_handles,
    orbpro::conjunction::ConjunctionScreeningMode screening_mode,
    const orbpro::propagator::PropagatorDescribeSourcesBatchResult* descriptions,
    const orbpro::propagator::PropagatorSampleTrajectoryStatesResult* samples) {
    if (screening_mode == orbpro::conjunction::ConjunctionScreeningMode::exact_only) {
        return prepare_resident_screening_index(
            catalog_handle,
            primary_source_handles,
            descriptions);
    }
    if (
        samples == nullptr ||
        samples->sourceHandles() == nullptr ||
        samples->states() == nullptr) {
        throw std::runtime_error(
            "prepare_sample_screening_index requires PropagatorSampleTrajectoryStatesResult sample metadata.");
    }

    const auto* sample_handles = samples->sourceHandles();
    const auto* sample_states = samples->states();
    const auto* sample_jds = samples->sampleJds();
    const size_t sample_count =
        sample_jds != nullptr ? sample_jds->size() : 0;
    if (sample_count == 0 || sample_count % CHEBY_NPTS != 0) {
        throw std::runtime_error(
            "prepare_sample_screening_index requires sampled states in 13-sample Chebyshev chunks.");
    }
    if (sample_states->size() != sample_handles->size() * sample_count) {
        throw std::runtime_error(
            "prepare_sample_screening_index received a malformed sampled state grid.");
    }
    const size_t segment_count = sample_count / CHEBY_NPTS;
    double max_half_sample_gap_sec = 0.0;
    for (size_t sample_index = 1; sample_index < sample_count; sample_index++) {
        const double sample_gap_days =
            sample_jds->Get(sample_index) - sample_jds->Get(sample_index - 1);
        max_half_sample_gap_sec = std::max(
            max_half_sample_gap_sec,
            std::max(0.0, sample_gap_days) * 86400.0 * 0.5);
    }

    ResidentScreeningIndex index;
    index.screening_index_handle = g_next_screening_index_handle.fetch_add(1);
    index.catalog_handle = catalog_handle;
    index.segment_set_handle = 0;
    index.screening_mode = screening_mode;

    std::unordered_set<uint32_t> covered_source_handles;
    covered_source_handles.reserve(sample_handles->size());
    for (flatbuffers::uoffset_t handle_index = 0;
         handle_index < sample_handles->size();
         handle_index++) {
        covered_source_handles.insert(sample_handles->Get(handle_index));
    }

    const auto source_count =
        descriptions != nullptr && descriptions->sources() != nullptr
            ? descriptions->sources()->size()
            : 0;
    if (source_count == 0) {
        throw std::runtime_error(
            "prepare_sample_screening_index requires PropagatorDescribeSourcesBatchResult source metadata.");
    }

    index.source_handles.reserve(source_count);
    index.tles.reserve(source_count);
    index.perigee_km.reserve(source_count);
    index.apogee_km.reserve(source_count);
    index.max_speed_km_s.reserve(source_count);
    std::vector<float> conservative_motion_margin_km;
    conservative_motion_margin_km.reserve(source_count);

    std::unordered_map<uint32_t, uint32_t> source_handle_to_index;
    for (flatbuffers::uoffset_t source_index = 0;
         source_index < source_count;
         source_index++) {
        const auto* source = descriptions->sources()->Get(source_index);
        if (source == nullptr) {
            continue;
        }
        if (source->sourceKind() != orbpro::propagator::PropagatorSourceKind_SGP4) {
            throw std::runtime_error(
                "prepare_sample_screening_index currently supports only SGP4 resident sources.");
        }
        if (
            covered_source_handles.find(source->sourceHandle()) ==
            covered_source_handles.end()) {
            continue;
        }

        GPElement gp = decode_source_description(*source);
        index.source_handles.push_back(source->sourceHandle());
        index.perigee_km.push_back(static_cast<float>(gp.perigee_km));
        index.apogee_km.push_back(static_cast<float>(gp.apogee_km));
        index.max_speed_km_s.push_back(0.0f);
        index.tles.push_back(gp_to_tle(gp));
        conservative_motion_margin_km.push_back(0.0f);
        source_handle_to_index[source->sourceHandle()] =
            static_cast<uint32_t>(index.tles.size() - 1);
    }
    index.trajectory_segments.resize(index.source_handles.size());
    index.sample_min_x_km.assign(
        index.source_handles.size(),
        std::numeric_limits<float>::max());
    index.sample_max_x_km.assign(
        index.source_handles.size(),
        std::numeric_limits<float>::lowest());
    index.sample_min_y_km.assign(
        index.source_handles.size(),
        std::numeric_limits<float>::max());
    index.sample_max_y_km.assign(
        index.source_handles.size(),
        std::numeric_limits<float>::lowest());
    index.sample_min_z_km.assign(
        index.source_handles.size(),
        std::numeric_limits<float>::max());
    index.sample_max_z_km.assign(
        index.source_handles.size(),
        std::numeric_limits<float>::lowest());
    index.sample_motion_margin_km = std::move(conservative_motion_margin_km);

    for (flatbuffers::uoffset_t handle_index = 0;
         handle_index < sample_handles->size();
         handle_index++) {
        const uint32_t source_handle = sample_handles->Get(handle_index);
        const auto found = source_handle_to_index.find(source_handle);
        if (found == source_handle_to_index.end()) {
            continue;
        }

        const size_t base_index =
            static_cast<size_t>(handle_index) * sample_count;
        for (size_t segment_index = 0; segment_index < segment_count; segment_index++) {
            const size_t segment_sample_offset = segment_index * CHEBY_NPTS;
            std::array<orbpro::propagator::StateVector, CHEBY_NPTS> source_samples = {};
            double segment_start_jd = sample_jds->Get(segment_sample_offset);
            double segment_end_jd = segment_start_jd;
            for (size_t sample_index = 0; sample_index < CHEBY_NPTS; sample_index++) {
                const double sample_jd =
                    sample_jds->Get(segment_sample_offset + sample_index);
                segment_start_jd = std::min(segment_start_jd, sample_jd);
                segment_end_jd = std::max(segment_end_jd, sample_jd);
                source_samples[sample_index] =
                    *sample_states->Get(
                        base_index + segment_sample_offset + sample_index);
                const auto& sample_state = source_samples[sample_index];
                const double sample_speed_km_s = std::sqrt(
                    sample_state.velocity().x() * sample_state.velocity().x() +
                    sample_state.velocity().y() * sample_state.velocity().y() +
                    sample_state.velocity().z() * sample_state.velocity().z());
                if (std::isfinite(sample_speed_km_s)) {
                    index.max_speed_km_s[found->second] = std::max(
                        index.max_speed_km_s[found->second],
                        static_cast<float>(sample_speed_km_s));
                }
                index.sample_min_x_km[found->second] = std::min(
                    index.sample_min_x_km[found->second],
                    static_cast<float>(sample_state.position().x()));
                index.sample_max_x_km[found->second] = std::max(
                    index.sample_max_x_km[found->second],
                    static_cast<float>(sample_state.position().x()));
                index.sample_min_y_km[found->second] = std::min(
                    index.sample_min_y_km[found->second],
                    static_cast<float>(sample_state.position().y()));
                index.sample_max_y_km[found->second] = std::max(
                    index.sample_max_y_km[found->second],
                    static_cast<float>(sample_state.position().y()));
                index.sample_min_z_km[found->second] = std::min(
                    index.sample_min_z_km[found->second],
                    static_cast<float>(sample_state.position().z()));
                index.sample_max_z_km[found->second] = std::max(
                    index.sample_max_z_km[found->second],
                    static_cast<float>(sample_state.position().z()));
            }
            index.trajectory_segments[found->second].push_back(
                build_sampled_resident_segment(
                    source_handle,
                    segment_start_jd,
                    segment_end_jd,
                    samples->referenceFrame(),
                    source_samples));
        }
    }
    for (size_t object_index = 0; object_index < index.max_speed_km_s.size();
         object_index++) {
        index.sample_motion_margin_km[object_index] =
            static_cast<float>(
                static_cast<double>(index.max_speed_km_s[object_index]) *
                max_half_sample_gap_sec);
    }

    const uint32_t n = static_cast<uint32_t>(index.tles.size());
    std::unordered_set<uint32_t> primary_handle_set(
        primary_source_handles.begin(),
        primary_source_handles.end());
    const bool all_primary =
        primary_handle_set.empty() || primary_handle_set.size() >= n;
    if (!all_primary) {
        index.is_primary.resize(n, 0);
        for (uint32_t handle : primary_handle_set) {
            const auto found = source_handle_to_index.find(handle);
            if (found != source_handle_to_index.end()) {
                index.is_primary[found->second] = 1;
            }
        }
    }

    index.participates.resize(n, 0);
    index.candidate_pair_count = count_candidate_pairs_and_mark(
        index.perigee_km,
        index.apogee_km,
        index.is_primary,
        index.participates,
        &index.total_pair_count);
    index.pairs_prefiltered =
        index.total_pair_count >= index.candidate_pair_count
            ? index.total_pair_count - index.candidate_pair_count
            : 0;

    bool all_participate = true;
    for (size_t i = 0; i < n && all_participate; i++) {
        if (!index.participates[i]) all_participate = false;
    }
    if (all_participate) {
        index.participates.clear();
    }

    const uint32_t handle = index.screening_index_handle;
    const uint64_t candidate_pair_count = index.candidate_pair_count;
    g_resident_screening_indexes[handle] = std::move(index);

    return {
        handle,
        n,
        candidate_pair_count,
    };
}

const ResidentScreeningIndex* find_resident_screening_index(
    uint32_t screening_index_handle) {
    auto found = g_resident_screening_indexes.find(screening_index_handle);
    return found != g_resident_screening_indexes.end() ? &found->second : nullptr;
}

bool destroy_resident_screening_index(uint32_t screening_index_handle) {
    return g_resident_screening_indexes.erase(screening_index_handle) > 0;
}

std::vector<ConjunctionEvent> screen_resident_index_window(
    const ResidentScreeningIndex& index,
    const ScreeningConfig& config,
    ScreeningStats& stats,
    ProgressCallback progress) {
    stats = {};
    stats.total_objects = index.tles.size();
    stats.pairs_screened = index.candidate_pair_count;
    stats.pairs_prefiltered = index.pairs_prefiltered;
    auto events = screen_precomputed_tles_implicit(
        index.tles,
        index.perigee_km,
        index.apogee_km,
        index.is_primary,
        index.participates,
        config,
        stats,
        progress,
        &index);
    return events;
}

} // namespace conjunction
