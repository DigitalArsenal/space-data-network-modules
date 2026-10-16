#pragma once
#include <cstdint>
#include <string>

namespace conjunction {
// Source evidence carried with an encounter. This is independent of the SDS
// encoding so serialization never has to infer where a covariance came from.
struct CdmObjectMetadata {
    enum class CovarianceOrigin { Unspecified, SourceEphemeris, OrbitDetermination, ConjunctionMessage, EmpiricalModel };
    CovarianceOrigin covariance_origin = CovarianceOrigin::Unspecified;
    bool calibrated = false;
    std::string calibration_reference;
    std::string ephemeris_name;
    std::string catalog_object_name, international_designator;
    uint32_t catalog_number = 0;
    uint8_t object_type = 255; // Unavailable; source catalog enum values are 0..3.
    bool maneuverable_known = false;
    bool maneuverable = false;
    std::string time_lastob_start, time_lastob_end;
    double recommended_od_span = 0, actual_od_span = 0;
    uint32_t obs_available = 0, obs_used = 0, tracks_available = 0, tracks_used = 0;
    double residuals_accepted = 0, weighted_rms = 0;
};
} // namespace conjunction
