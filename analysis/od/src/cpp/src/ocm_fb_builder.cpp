// SDS $OCM (Orbit Comprehensive Message) FlatBuffer builder — the aligned-binary
// flow-node output path for the OD fit's STATE + COVARIANCE + OD_RESIDUALS.
//
// Isolated TU (mirrors omm_fb_builder.cpp / obd_fb_builder.cpp): the ONLY OD
// source that includes the generated SDS $OCM header, so its flatc symbols/guards
// never collide with the $OMM/$OBD/$OEM headers used in the sibling builder TUs.
// Exposes only the plain-C++ surface od::build_ocm_flatbuffer (no FlatBuffers
// types leak). Byte-shape: a size-prefixed FlatBuffer ([u32le len][OCM]) via
// FinishSizePrefixedOCMBuffer — the exact aligned-binary payload the $PIV ABI
// emits via plugin_push_output_ex(..., ALIGNED_BINARY, ...), same as $OMM/$OBD.

#include "od/ocm_fb_builder.h"
#include "od/covariance_validation.h"

#include <cstdio>
#include <string>
#include <vector>

// macOS <math.h> defines the legacy SVID matherr macros (DOMAIN/SING/OVERFLOW/
// …) which collide with generated enum identifiers reachable through the $OCM
// header's transitive includes (e.g. legacyCountryCode). Undef before the
// generated header. Native-build hazard only; the WASI/emscripten sysroot has no
// such macros.
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

// The generated SDS $OCM header (Header, Metadata, OrbitDetermination, OCM,
// trajectoryType). All types are in the global namespace; keep this the ONLY TU
// that includes it. flatbuffers add_*() skip null (offset 0) fields, so the
// optional strings below are default-constructed and only created when present.
#include "OCM_generated.h"

namespace od {

std::vector<uint8_t> build_ocm_flatbuffer(const OCMInputs& in,
                                          const std::string& originator,
                                          const std::string& creation_date) {
    const SGP4Elements* el = in.el;

    // Never turn fit residual RMS into observational uncertainty or invent a
    // zero epoch state. An unavailable covariance is an absent vector.
    bool state_available = in.has_state && el && !el->epoch_iso.empty();
    for (double value : in.state_teme)
        state_available = state_available && finite_covariance_value(value);
    const bool covariance_available = state_available && in.converged &&
        in.has_covariance && publishable_covariance(in.covariance);
    const char* cov_reduction = covariance_available
        ? "FORMAL_UNWEIGHTED_NORMAL_EQUATIONS" : "UNAVAILABLE";

    flatbuffers::FlatBufferBuilder fbb(2048);
    using ::flatbuffers::Offset;
    using ::flatbuffers::String;

    // Header — all strings created before the table builder opens.
    Offset<String> vers_s = fbb.CreateString("3.0");
    Offset<String> creation_s;
    if (!creation_date.empty()) creation_s = fbb.CreateString(creation_date);
    Offset<String> originator_s =
        fbb.CreateString(originator.empty() ? std::string("SDN-OD") : originator);
    HeaderBuilder hb(fbb);
    hb.add_CCSDS_OCM_VERS(vers_s);
    hb.add_CREATION_DATE(creation_s);
    hb.add_ORIGINATOR(originator_s);
    auto header = hb.Finish();

    // Metadata — identity + time system.
    Offset<String> objname_s, intl_s, catname_s;
    if (el && !el->object_name.empty()) objname_s = fbb.CreateString(el->object_name);
    if (el && !el->object_id.empty()) intl_s = fbb.CreateString(el->object_id);
    if (el && el->norad_cat_id > 0) catname_s = fbb.CreateString(std::to_string(el->norad_cat_id));
    Offset<String> ts_s = fbb.CreateString("UTC");
    Offset<String> epoch_s;
    if (el && !el->epoch_iso.empty()) epoch_s = fbb.CreateString(el->epoch_iso);
    MetadataBuilder mb(fbb);
    mb.add_OBJECT_NAME(objname_s);
    mb.add_INTERNATIONAL_DESIGNATOR(intl_s);
    mb.add_CATALOG_NAME(catname_s);
    mb.add_TIME_SYSTEM(ts_s);
    // STATE_DATA index zero is defined by METADATA.START_TIME in SDS OCM.
    // Reuse the fit epoch for its single epoch state.
    mb.add_START_TIME(epoch_s);
    mb.add_STOP_TIME(epoch_s);
    mb.add_EPOCH_TZERO(epoch_s);
    auto metadata = mb.Finish();

    // OrbitDetermination — method, epoch, obs count, residual summary, cov flag.
    Offset<String> od_method_s = fbb.CreateString("DIFFERENTIAL_CORRECTION");
    Offset<String> od_algo_s = fbb.CreateString("SGP4-LM-EQUINOCTIAL");
    Offset<String> od_epoch_s;
    if (el && !el->epoch_iso.empty()) od_epoch_s = fbb.CreateString(el->epoch_iso);
    char resbuf[80];
    std::snprintf(resbuf, sizeof(resbuf), "WRMS=%.9g km", in.rms_km);
    Offset<String> od_res_s = fbb.CreateString(resbuf);
    Offset<String> od_covred_s = fbb.CreateString(cov_reduction);
    char convbuf[64];
    std::snprintf(convbuf, sizeof(convbuf), "sigma_rel<%.3g;converged=%d",
                  in.convergence_tol, in.converged ? 1 : 0);
    Offset<String> od_conv_s = fbb.CreateString(convbuf);
    OrbitDeterminationBuilder ob(fbb);
    ob.add_OD_ALGORITHM(od_algo_s);
    ob.add_OD_METHOD(od_method_s);
    ob.add_OD_EPOCH(od_epoch_s);
    ob.add_OD_OBSERVATIONS_USED(in.num_observations);
    ob.add_OD_COV_REDUCTION(od_covred_s);
    ob.add_OD_CONVERGENCE_CRITERIA(od_conv_s);
    ob.add_OD_RESIDUALS(od_res_s);
    auto od = ob.Finish();

    Offset<::flatbuffers::Vector<double>> state_vec, cov_vec;
    if (state_available) state_vec = fbb.CreateVector(in.state_teme, 6);
    if (covariance_available) cov_vec = fbb.CreateVector(in.covariance, 21);
    std::vector<Offset<UserDefinedParameters>> annotations;
    annotations.push_back(CreateUserDefinedParametersDirect(fbb, "STATE_REFERENCE_FRAME", "TEME"));
    annotations.push_back(CreateUserDefinedParametersDirect(fbb, "STATE_UNITS", "km,km,km,km/s,km/s,km/s"));
    annotations.push_back(CreateUserDefinedParametersDirect(fbb, "COVARIANCE_LAYOUT", "6x6 lower triangular, row-major; products of state units"));
    annotations.push_back(CreateUserDefinedParametersDirect(fbb, "COVARIANCE_INTERPRETATION", "Formal fit uncertainty only; not calibrated prediction uncertainty"));
    auto annotation_vec = fbb.CreateVector(annotations);

    OCMBuilder ocb(fbb);
    ocb.add_HEADER(header);
    ocb.add_METADATA(metadata);
    ocb.add_TRAJ_TYPE(trajectoryType::CARTESIAN_PV);
    ocb.add_STATE_VECTOR_SIZE(static_cast<uint8_t>(6));
    ocb.add_STATE_DATA(state_vec);
    ocb.add_COVARIANCE_DATA(cov_vec);
    ocb.add_ORBIT_DETERMINATION(od);
    ocb.add_USER_DEFINED_PARAMETERS(annotation_vec);
    auto ocm = ocb.Finish();

    FinishSizePrefixedOCMBuffer(fbb, ocm);
    const uint8_t* p = fbb.GetBufferPointer();
    return std::vector<uint8_t>(p, p + fbb.GetSize());
}

}  // namespace od
