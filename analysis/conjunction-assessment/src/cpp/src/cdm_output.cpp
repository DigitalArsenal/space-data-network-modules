/**
 * CDM FlatBuffers Output — Serialize ConjunctionEvent to CCSDS CDM
 *
 * Uses spacedatastandards.org CDM schema with $CDM file identifier.
 * Output is canonical variable-size FlatBuffers binary for SDS transport.
 */

#include "conjunction/conjunction_assessment.h"
#include "conjunction/cdm_builder.h"
#include "conjunction/cdm_text.h"
#include "conjunction/conjunction_engine.h"
#include "conjunction/encounter_geometry.h"
#ifdef SING
#undef SING
#endif
#ifdef DOMAIN
#undef DOMAIN
#endif
#include "CDM_generated.h"
#include "conjunction/error_status.h"
#include "flatbuffers/flatbuffers.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstring>
#include <sstream>
#include <iomanip>
#include <ctime>
#include <cmath>
#include <memory>
#include <stdexcept>

namespace conjunction {

static std::string cdm_pc_upper(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::toupper(c));
    });
    return value;
}

static bool cdm_pc_object_has_covariance(const CDMObject* object) {
    return object && object->COVARIANCE() && object->COVARIANCE()->size() >= 6;
}


static Covariance3x3 covariance_from_cdm_object(const CDMObject* object) {
    if (!object || !object->COVARIANCE() || object->COVARIANCE()->size() < 6) {
        set_error("CDM object covariance must contain at least the 3x3 position block.");
        return {};
    }

    const auto* covariance = object->COVARIANCE();
    Covariance3x3 result{};
    result.data[0] = covariance->Get(0);  // CR_R
    result.data[1] = covariance->Get(1);  // CT_R
    result.data[3] = covariance->Get(1);
    result.data[4] = covariance->Get(2);  // CT_T
    result.data[2] = covariance->Get(3);  // CN_R
    result.data[6] = covariance->Get(3);
    result.data[5] = covariance->Get(4);  // CN_T
    result.data[7] = covariance->Get(4);
    result.data[8] = covariance->Get(5);  // CN_N
    return result;
}

static bool cdm_object_has_cartesian_state(const CDMObject* object) {
    if (!object) {
        return false;
    }
    return object->X() != 0.0 || object->Y() != 0.0 || object->Z() != 0.0 ||
           object->X_DOT() != 0.0 || object->Y_DOT() != 0.0 || object->Z_DOT() != 0.0;
}

static StateVector state_from_cdm_object(const CDMObject* object) {
    if (!object) {
        return StateVector{};
    }
    return StateVector{
        0.0,
        object->X(),
        object->Y(),
        object->Z(),
        object->X_DOT(),
        object->Y_DOT(),
        object->Z_DOT()
    };
}

static std::string cdm_object_reference_frame_name(const CDMObject* object) {
    if (!object || !object->REFERENCE_FRAME()) return {};
    const auto* frame = object->REFERENCE_FRAME();
    if (frame->NAME() && !frame->NAME()->str().empty()) return cdm_pc_upper(frame->NAME()->str());
    const auto* celestial = frame->REFERENCE_FRAME_as_CelestialFrameWrapper();
    if (celestial) {
        if (celestial->frame() == CelestialFrame::GCRF) return "GCRF";
        if (celestial->frame() == CelestialFrame::EME2000) return "EME2000";
        if (celestial->frame() == CelestialFrame::TEMEOFDATE) return "TEME";
    }
    return {};
}

static bool cdm_objects_have_covariance(const CDM* cdm) {
    if (cdm_pc_object_has_covariance(cdm->OBJECT1()) && cdm_pc_object_has_covariance(cdm->OBJECT2())) return true;
    set_error("Collision probability requires covariance for both OBJECT1 and OBJECT2.");
    return false;
}

bool cdm_has_covariance(const uint8_t* cdm_buffer, uint32_t cdm_buffer_size) {
    if (!cdm_buffer || cdm_buffer_size == 0u) return false;
    flatbuffers::Verifier verifier(cdm_buffer, cdm_buffer_size);
    if (!VerifyCDMBuffer(verifier)) return false;
    const CDM* cdm = GetCDM(cdm_buffer);
    return cdm && cdm_objects_have_covariance(cdm);
}

PcResult compute_pc_from_cdm(
    const uint8_t* cdm_buffer, uint32_t cdm_buffer_size,
    const std::string& method_override,
    double combined_radius_km) {

    if (!cdm_buffer || cdm_buffer_size == 0) {
        set_error("CDM input buffer is empty.");
        return {};
    }

    flatbuffers::Verifier verifier(cdm_buffer, cdm_buffer_size);
    if (!VerifyCDMBuffer(verifier)) {
        set_error("CDM FlatBuffer verification failed.");
        return {};
    }

    const CDM* cdm = GetCDM(cdm_buffer);
    if (!cdm) {
        set_error("CDM root is missing.");
        return {};
    }
    if (!cdm->OBJECT1() || !cdm->OBJECT2()) {
        set_error("CDM input requires both object blocks.");
        return {};
    }

    StateVector state1{};
    StateVector state2{};
    Covariance3x3 cov1 = covariance_from_cdm_object(cdm->OBJECT1());
    Covariance3x3 cov2 = covariance_from_cdm_object(cdm->OBJECT2());
    if (has_error()) return {};
    if (cdm_object_has_cartesian_state(cdm->OBJECT1()) &&
        cdm_object_has_cartesian_state(cdm->OBJECT2())) {
        state1 = state_from_cdm_object(cdm->OBJECT1());
        state2 = state_from_cdm_object(cdm->OBJECT2());
        const auto frame1 = cdm_object_reference_frame_name(cdm->OBJECT1());
        const auto frame2 = cdm_object_reference_frame_name(cdm->OBJECT2());
        const bool earth_fixed = frame1 == "ITRF";
        if (frame1 != frame2 ||
            (!earth_fixed && frame1 != "TEME" && frame1 != "GCRF" && frame1 != "EME2000")) {
            set_error("CDM probability requires both objects in one of ITRF, TEME, GCRF or EME2000.");
            return {};
        }
        // Earth-fixed states: evaluate in the non-rotating frame aligned with
        // ITRF at TCA, v + w x r. The probability is invariant under a rotation
        // common to both objects, so the Earth's orientation itself (and its
        // EOP) does not enter; polar motion tilts w by about 1e-6 rad.
        if (earth_fixed) {
            constexpr double EARTH_RATE_RAD_S = 7.292115146706979e-5;  // IERS
            for (StateVector* s : {&state1, &state2}) {
                s->vx -= EARTH_RATE_RAD_S * s->y;
                s->vy += EARTH_RATE_RAD_S * s->x;
            }
        }
    } else {
        set_error("CDM probability requires both absolute object states to orient their RTN covariances.");
        return {};
    }

    if (cdm->TCA()) {
        state1.epoch_jd = state2.epoch_jd = iso_to_jd(cdm->TCA()->str());
    }
    std::string method = method_override;
    if (method.empty() && cdm->COLLISION_PROBABILITY_METHOD()) {
        method = cdm->COLLISION_PROBABILITY_METHOD()->str();
    }
    if (method.empty()) {
        method = "FOSTER-2D";
    }

    ConjunctionEngine engine;
    engine.set_pc_method(cdm_internal_probability_method_name(method));
    if (cdm->OBJECT1()->COVARIANCE()->size() >= 21 && cdm->OBJECT2()->COVARIANCE()->size() >= 21) {
        std::array<double, 21> full1{}, full2{};
        for (unsigned i=0; i<21; ++i) {
            full1[i]=cdm->OBJECT1()->COVARIANCE()->Get(i);
            full2[i]=cdm->OBJECT2()->COVARIANCE()->Get(i);
        }
        return engine.compute_pc(make_pc_encounter(state1,state2,full1,full2,combined_radius_km)).pc;
    }
    return engine.compute_pc(state1, state2, cov1, cov2, combined_radius_km).pc;
}

} // namespace conjunction
