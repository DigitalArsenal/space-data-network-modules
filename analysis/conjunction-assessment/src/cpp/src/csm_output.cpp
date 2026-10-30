#include "conjunction/conjunction_assessment.h"

#ifdef SING
#undef SING
#endif
#include "CSM_generated.h"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <exception>
#include <string>

namespace conjunction {
namespace {

constexpr double kUnixEpochJd = 2440587.5;
constexpr double kSecondsPerDay = 86400.0;

uint32_t nonnegative_norad_id(int norad_cat_id) {
    return static_cast<uint32_t>(std::max(0, norad_cat_id));
}

std::string fallback_object_id(const ObjectIdentity& tle) {
    if (!tle.object_id.empty()) {
        return tle.object_id;
    }
    if (tle.norad_cat_id > 0) {
        return std::to_string(tle.norad_cat_id);
    }
    return {};
}

flatbuffers::Offset<CAT> build_csm_cat(
    flatbuffers::FlatBufferBuilder& builder,
    const ObjectIdentity& tle)
{
    const std::string object_id = fallback_object_id(tle);
    return CreateCATDirect(
        builder,
        tle.name.empty() ? nullptr : tle.name.c_str(),
        object_id.empty() ? nullptr : object_id.c_str(),
        nonnegative_norad_id(tle.norad_cat_id));
}

} // namespace

int32_t conjunction_to_csm(
    const ConjunctionEvent& event,
    uint8_t* output,
    uint32_t output_capacity)
{
    if (!output || output_capacity == 0u) return -2;
    // A CSM's MAX_PROB is the covariance-free Alfano maximum and DILUTION its
    // dilution threshold, from the miss distance and the combined hard-body
    // radius, whatever the sources carry; a covariance Pc is the CDM's
    // (emit_cdm). An event without covariance already holds this maximum,
    // from the same function of the same values.
    const auto maximum = alfano_max_probability(event.min_range_km,
                                                (event.radius1_m + event.radius2_m) / 1000.0);
    flatbuffers::FlatBufferBuilder builder(1024);

    const auto object_1 = build_csm_cat(builder, event.obj1);
    const auto object_2 = build_csm_cat(builder, event.obj2);
    const double tca_unix_seconds = (event.tca_jd - kUnixEpochJd) * kSecondsPerDay;

    const auto csm = CreateCSM(
        builder,
        object_1,
        event.dse1,
        object_2,
        event.dse2,
        tca_unix_seconds,
        event.min_range_km,
        event.rel_speed_kms,
        maximum.max_probability,
        maximum.dilution_threshold_km);

    FinishCSMBuffer(builder, csm);
    const uint8_t* buffer = builder.GetBufferPointer();
    const uint32_t size = builder.GetSize();
    if (size > output_capacity) {
        return -2;
    }
    std::memcpy(output, buffer, size);
    return static_cast<int32_t>(size);
}

} // namespace conjunction
