#include "conjunction/cdm_builder.h"
#include "conjunction/cdm_text.h"
#include "conjunction/conjunction_engine.h"
#include "conjunction/earth_orientation.h"
#include "conjunction/error_status.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <ctime>

namespace conjunction {
namespace cdm_build_detail {
std::string token(std::string value) {
    for (auto& c : value) {
        const auto u = static_cast<unsigned char>(c);
        c = (u >= 'a' && u <= 'z') ? static_cast<char>(u - 'a' + 'A') :
            ((u >= 'A' && u <= 'Z') || (u >= '0' && u <= '9') || u == '_' || u == '-') ? c : '_';
    }
    return value;
}
std::string designator(const ObjectIdentity& identity, const CdmObjectMetadata& metadata) {
    if (identity.norad_cat_id > 0) return std::to_string(identity.norad_cat_id);
    if (metadata.catalog_number) return std::to_string(metadata.catalog_number);
    if (!identity.object_id.empty() && std::all_of(identity.object_id.begin(), identity.object_id.end(),
        [](unsigned char c) { return c >= '0' && c <= '9'; })) return identity.object_id;
    return {};
}
std::string international_designator(const std::string& id) {
    auto value = token(id);
    if (value.size() >= 9 && value.size() <= 11 && value[4] == '-' &&
        std::all_of(value.begin(), value.begin() + 4, [](char c) { return c >= '0' && c <= '9'; }) &&
        std::all_of(value.begin() + 5, value.begin() + 8, [](char c) { return c >= '0' && c <= '9'; }) &&
        std::all_of(value.begin() + 8, value.end(), [](char c) { return c >= 'A' && c <= 'Z'; })) return value;
    return "UNKNOWN";
}
std::string creation_time() {
    const auto now = std::chrono::system_clock::now();
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();
    const std::time_t seconds = static_cast<std::time_t>(ms / 1000);
    std::tm utc{};
    gmtime_r(&seconds, &utc);
    char result[40];
    std::snprintf(result, sizeof(result), "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
        utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday, utc.tm_hour,
        utc.tm_min, utc.tm_sec, static_cast<int>(ms % 1000));
    return result;
}
std::unique_ptr<CDMObjectT> object(const ObjectIdentity& identity, const StateVector& state,
    bool has_covariance, const std::array<double, 21>& rtn, const CdmObjectMetadata& metadata,
    const std::string& frame, const std::string& probability_comment) {
    auto out = std::make_unique<CDMObjectT>();
    out->OBJECT = std::make_unique<CATT>();
    out->OBJECT->OBJECT_NAME = !identity.name.empty() ? identity.name :
        !metadata.catalog_object_name.empty() ? metadata.catalog_object_name : identity.object_id;
    out->OBJECT->OBJECT_ID = international_designator(metadata.international_designator);
    if (out->OBJECT->OBJECT_ID == "UNKNOWN") out->OBJECT->OBJECT_ID = international_designator(identity.object_id);
    out->OBJECT->NORAD_CAT_ID = identity.norad_cat_id > 0 ? identity.norad_cat_id : metadata.catalog_number;
    if (metadata.object_type <= static_cast<uint8_t>(spaceObjectClass::UNKNOWN))
        out->OBJECT->OBJECT_TYPE = static_cast<spaceObjectClass>(metadata.object_type);
    out->OBJECT_DESIGNATOR = designator(identity, metadata);
    if (!out->OBJECT_DESIGNATOR.empty()) out->CATALOG_NAME = "SATCAT";
    out->EPHEMERIS_NAME = metadata.ephemeris_name;
    out->MANEUVERABLE = metadata.maneuverable_known
        ? (metadata.maneuverable ? cdmManeuverable::YES : cdmManeuverable::NO)
        : cdmManeuverable::NOT_APPLICABLE;
    out->OBJECT->MANEUVERABLE = metadata.maneuverable_known && metadata.maneuverable;
    using Origin = CdmObjectMetadata::CovarianceOrigin;
    // CALCULATED is the schema's zero value. Always assign the real origin;
    // neither the schema default nor Pc success determines this field.
    out->COVARIANCE_METHOD = metadata.covariance_origin == Origin::SourceEphemeris ||
        metadata.covariance_origin == Origin::OrbitDetermination ||
        metadata.covariance_origin == Origin::ConjunctionMessage
        ? covarianceAlgorithm::CALCULATED : covarianceAlgorithm::DEFAULT;
    if (has_covariance) {
        out->COVARIANCE.assign(rtn.begin(), rtn.end());
        const char* basis = metadata.covariance_origin == Origin::SourceEphemeris ? "SOURCE EPHEMERIS" :
            metadata.covariance_origin == Origin::OrbitDetermination ? "ORBIT DETERMINATION" :
            metadata.covariance_origin == Origin::ConjunctionMessage ? "CONJUNCTION MESSAGE" :
            metadata.covariance_origin == Origin::EmpiricalModel ? "EMPIRICAL MODEL" : "UNSPECIFIED";
        out->COMMENT = std::string("Covariance: ") + basis + "; calibration: " +
            (metadata.calibrated ? "Calibrated" : "Uncalibrated");
        if (!metadata.calibration_reference.empty()) out->COMMENT += " (" + metadata.calibration_reference + ")";
    }
    if (!probability_comment.empty()) out->COMMENT += (out->COMMENT.empty() ? "" : "\n") + probability_comment;
    out->REFERENCE_FRAME = std::make_unique<RFMT>();
    out->REFERENCE_FRAME->NAME = frame;
    CelestialFrameWrapperT axes;
    axes.frame = frame == "GCRF" ? CelestialFrame::GCRF : CelestialFrame::EME2000;
    out->REFERENCE_FRAME->REFERENCE_FRAME.Set(std::move(axes));
    out->X = state.x; out->Y = state.y; out->Z = state.z;
    out->X_DOT = state.vx; out->Y_DOT = state.vy; out->Z_DOT = state.vz;
    out->TIME_LASTOB_START = metadata.time_lastob_start;
    out->TIME_LASTOB_END = metadata.time_lastob_end;
    out->RECOMMENDED_OD_SPAN = metadata.recommended_od_span;
    out->ACTUAL_OD_SPAN = metadata.actual_od_span;
    out->OBS_AVAILABLE = metadata.obs_available; out->OBS_USED = metadata.obs_used;
    out->TRACKS_AVAILABLE = metadata.tracks_available; out->TRACKS_USED = metadata.tracks_used;
    out->RESIDUALS_ACCEPTED = metadata.residuals_accepted; out->WEIGHTED_RMS = metadata.weighted_rms;
    return out;
}
} // namespace cdm_build_detail

std::unique_ptr<CDMT> build_conjunction_cdm(const ConjunctionEvent& event, const std::string& evaluation_frame) {
    if (evaluation_frame != "TEME" && evaluation_frame != "GCRF" && evaluation_frame != "EME2000") {
        set_error("Unsupported CDM evaluation frame");
        return nullptr;
    }
    StateVector state1 = event.state1, state2 = event.state2;
    const std::string frame = evaluation_frame == "TEME" ? "EME2000" : evaluation_frame;
    if (evaluation_frame == "TEME") {
        double jacobian[6][6];
        if (!teme_to_eme2000(event.tca_jd, jacobian)) {
            set_error("cdm-frame-transform-failed: Cannot convert TEME to EME2000 at TCA.");
            return nullptr;
        }
        for (auto* state : {&state1, &state2}) {
            EphemerisPoint point{event.tca_jd, state->x, state->y, state->z, state->vx, state->vy, state->vz};
            transform_ephemeris_point(point, jacobian);
            *state = {event.tca_jd, point.x, point.y, point.z, point.vx, point.vy, point.vz};
        }
    }
    auto out = std::make_unique<CDMT>();
    out->CCSDS_CDM_VERS = 1.0;
    out->CREATION_DATE = cdm_build_detail::creation_time();
    out->ORIGINATOR = "CONJUNCTION-ASSESSMENT";
    out->TCA = event.tca_iso.empty() ? jd_to_iso(event.tca_jd) : event.tca_iso;
    static std::atomic<uint64_t> counter{0};
    out->MESSAGE_ID = out->ORIGINATOR + "-" + cdm_build_detail::token(cdm_build_detail::designator(event.obj1, event.cdm_metadata1)) +
        "-" + cdm_build_detail::token(cdm_build_detail::designator(event.obj2, event.cdm_metadata2)) + "-" +
        cdm_build_detail::token(out->TCA) + "-" + cdm_build_detail::token(out->CREATION_DATE) + "-" +
        std::to_string(counter.fetch_add(1, std::memory_order_relaxed));
    auto probability_comment = covariance_failure_reason(event.has_covariance1, event.has_covariance2,
        covariance_is_positive_semidefinite(event.cov6_rtn1.data(), event.cov6_rtn1.size()),
        covariance_is_positive_semidefinite(event.cov6_rtn2.data(), event.cov6_rtn2.size()));
    if (probability_comment.empty()) probability_comment = event.probability_failure;
    const bool has_pc = event.has_covariance && probability_comment.empty() && !event.probability_method.empty() &&
        event.probability_method != "ALFANO-MAXPROB" && event.probability_method != "ALFANO-SPHERICAL-SMALL-HBR-MAX";
    if (!event.probability_note.empty()) probability_comment += (probability_comment.empty() ? "" : " ") + event.probability_note;
    out->OBJECT1 = cdm_build_detail::object(event.obj1, state1, event.has_covariance1, event.cov6_rtn1,
        event.cdm_metadata1, frame, probability_comment);
    out->OBJECT2 = cdm_build_detail::object(event.obj2, state2, event.has_covariance2, event.cov6_rtn2,
        event.cdm_metadata2, frame, probability_comment);
    out->MISS_DISTANCE = event.min_range_km;
    out->RELATIVE_SPEED = event.rel_speed_kms;
    out->RELATIVE_POSITION_R = event.rel_pos_r; out->RELATIVE_POSITION_T = event.rel_pos_t; out->RELATIVE_POSITION_N = event.rel_pos_n;
    out->RELATIVE_VELOCITY_R = event.rel_vel_r; out->RELATIVE_VELOCITY_T = event.rel_vel_t; out->RELATIVE_VELOCITY_N = event.rel_vel_n;
    if (has_pc) {
        out->COLLISION_PROBABILITY = event.covariance_probability;
        out->COLLISION_PROBABILITY_METHOD = cdm_probability_method_name(event.probability_method);
    }
    return out;
}

int32_t conjunction_to_cdm(const ConjunctionEvent& event, uint8_t* output, uint32_t output_capacity,
    const std::string& reference_frame) {
    if (!output || !output_capacity) return -2;
    const auto message = build_conjunction_cdm(event, reference_frame);
    if (!message) return -1;
    flatbuffers::FlatBufferBuilder builder(4096);
    const auto root = CDM::Pack(builder, message.get());
    builder.Finish(root, "$CDM");
    if (builder.GetSize() > output_capacity) return -2;
    std::memcpy(output, builder.GetBufferPointer(), builder.GetSize());
    return static_cast<int32_t>(builder.GetSize());
}

// ── Batch: multiple conjunctions to CDM collection ──

int32_t conjunctions_to_cdm_batch(
    const std::vector<ConjunctionEvent>& events,
    uint8_t* output, uint32_t output_capacity) {

    // For a collection, we serialize each CDM individually and pack them
    // sequentially with size prefixes (standard FlatBuffers size-prefixed format)
    uint32_t offset = 0;

    for (const auto& event : events) {
        if (offset + 4 >= output_capacity) return -2;

        // Reserve space for size prefix
        uint32_t remaining = output_capacity - offset - 4;
        int32_t written = conjunction_to_cdm(event, output + offset + 4, remaining);

        if (written < 0) return written;  // propagate error

        // Write size prefix (little-endian)
        uint32_t size = static_cast<uint32_t>(written);
        std::memcpy(output + offset, &size, 4);
        offset += 4 + size;
    }

    return static_cast<int32_t>(offset);
}



} // namespace conjunction
