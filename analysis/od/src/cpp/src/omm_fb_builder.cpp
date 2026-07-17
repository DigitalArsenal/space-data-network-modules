/**
 * SDS $OMM FlatBuffer builder — port of Go buildOMM (runner.go:439).
 *
 * Isolated TU: the ONLY OD source that includes the generated SDS $OMM header, so
 * its flatc symbols/guards never collide with the PIV/TAB headers used elsewhere.
 * Exposes only a plain-C++ surface (od::build_omm_flatbuffer); no FlatBuffers
 * types leak into the rest of the module.
 */

#include "od/omm_fb_builder.h"

#include <string>

// macOS <math.h> SVID matherr macros (DOMAIN/SING/OVERFLOW/…) collide with
// generated enum identifiers; undef before the generated header. Native-build
// hazard only (the emscripten/WASI sysroot has no such macros).
#ifdef SING
#undef SING
#endif
#ifdef DOMAIN
#undef DOMAIN
#endif
#ifdef OVERFLOW
#undef OVERFLOW
#endif
#ifdef UNDERFLOW
#undef UNDERFLOW
#endif
#ifdef TLOSS
#undef TLOSS
#endif
#ifdef PLOSS
#undef PLOSS
#endif

// The generated SDS $OMM header (flat licensing/core layout). Pulls RFM, TIM,
// MET. All types are in the global namespace.
#include "OMM_generated.h"

namespace od {

namespace {

// JD (UTC) -> Unix seconds, matching the USER_DEFINED_EPOCH_TIMESTAMP convention
// (the Go path stored ts.Unix()). 2440587.5 = JD at the Unix epoch 1970-01-01T0.
double jd_utc_to_unix(double jd_utc) {
    return (jd_utc - 2440587.5) * 86400.0;
}

}  // namespace

std::vector<uint8_t> build_omm_flatbuffer(const SGP4Elements& el,
                                          const std::string& originator,
                                          const std::string& creation_date) {
    flatbuffers::FlatBufferBuilder fbb(1024);

    // Strings must be created before the table starts.
    const auto object_name = fbb.CreateString(el.object_name);
    const auto object_id = fbb.CreateString(el.object_id);
    const auto epoch = fbb.CreateString(el.epoch_iso);
    const auto classification = fbb.CreateString(std::string(1, el.classification));
    const auto originator_off = fbb.CreateString(originator);
    const auto creation_off =
        creation_date.empty() ? flatbuffers::Offset<flatbuffers::String>()
                              : fbb.CreateString(creation_date);

    OMMBuilder b(fbb);
    // Provenance / identity.
    b.add_ORIGINATOR(originator_off);
    if (!creation_date.empty()) b.add_CREATION_DATE(creation_off);
    b.add_OBJECT_NAME(object_name);
    b.add_OBJECT_ID(object_id);
    // MEAN_ELEMENT_THEORY, EPHEMERIS_TYPE, TIME_SYSTEM keep their SGP4/UTC schema
    // defaults — the supplemental-GP form.

    // Mean Keplerian elements (the fit result).
    b.add_EPOCH(epoch);
    b.add_MEAN_MOTION(el.mean_motion);
    b.add_ECCENTRICITY(el.eccentricity);
    b.add_INCLINATION(el.inclination);
    b.add_RA_OF_ASC_NODE(el.ra_of_asc_node);
    b.add_ARG_OF_PERICENTER(el.arg_of_pericenter);
    b.add_MEAN_ANOMALY(el.mean_anomaly);

    // SGP4/TLE-related parameters.
    b.add_CLASSIFICATION_TYPE(classification);
    b.add_NORAD_CAT_ID(static_cast<uint32_t>(el.norad_cat_id));
    b.add_ELEMENT_SET_NO(static_cast<uint32_t>(el.element_set_no));
    b.add_REV_AT_EPOCH(static_cast<double>(el.rev_at_epoch));
    b.add_BSTAR(el.bstar);
    b.add_MEAN_MOTION_DOT(el.mean_motion_dot);
    b.add_MEAN_MOTION_DDOT(el.mean_motion_ddot);

    // USER_DEFINED epoch timestamp (Unix seconds), mirroring buildOMM's
    // WithEpochTimestamp(ts.Unix()).
    if (el.epoch_jd > 0.0) {
        b.add_USER_DEFINED_EPOCH_TIMESTAMP(jd_utc_to_unix(el.epoch_jd));
    }

    const auto omm = b.Finish();
    FinishSizePrefixedOMMBuffer(fbb, omm);

    const uint8_t* p = fbb.GetBufferPointer();
    return std::vector<uint8_t>(p, p + fbb.GetSize());
}

}  // namespace od
