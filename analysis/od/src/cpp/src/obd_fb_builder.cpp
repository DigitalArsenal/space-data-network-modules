/**
 * SDS $OBD (Orbit Determination Results) FlatBuffer builder — the OD-run-result-
 * with-RMS record. Port-parallel to omm_fb_builder.cpp.
 *
 * Isolated TU: the ONLY OD source that includes the generated SDS $OBD header, so
 * its flatc symbols/guards never collide with the OMM/OEM/PIV/TAB headers used
 * elsewhere. Exposes only a plain-C++ surface (od::build_obd_flatbuffer); no
 * FlatBuffers types leak into the rest of the module. Uses the SDS $OBD schema
 * types AS GENERATED (odMethod::DIFFERENTIAL_CORRECTION, OBDBuilder.add_*).
 */

#include "od/obd_fb_builder.h"

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

// The generated SDS $OBD header (flat licensing/core layout). All types are in
// the global namespace (OBD, OBDBuilder, odMethod).
#include "OBD_generated.h"

namespace od {

std::vector<uint8_t> build_obd_flatbuffer(const SGP4Elements& el,
                                          double fit_span_days,
                                          const std::string& method_source) {
    flatbuffers::FlatBufferBuilder fbb(512);

    // Strings must be created before the table starts.
    const auto object_id = fbb.CreateString(el.object_id);
    const auto effective_from = fbb.CreateString(el.epoch_iso);
    const auto method_src = fbb.CreateString(method_source);

    OBDBuilder b(fbb);
    b.add_SAT_NO(static_cast<uint32_t>(el.norad_cat_id));
    b.add_ORIG_OBJECT_ID(object_id);
    // The SGP4 supplemental-GP fit is an iterative differential correction
    // (Gauss-Newton least squares) over the ephemeris points.
    b.add_METHOD(odMethod::DIFFERENTIAL_CORRECTION);
    b.add_METHOD_SOURCE(method_src);
    b.add_INITIAL_OD(false);
    if (!el.epoch_iso.empty()) b.add_EFFECTIVE_FROM(effective_from);
    if (fit_span_days > 0.0) b.add_FIT_SPAN(fit_span_days);

    // The fit is position-residual only (no per-sensor weighting — this is an
    // ephemeris fit), so WRMS == the position RMS (km) and the first/best pass
    // mirror it.
    b.add_WRMS(el.rms_km);
    b.add_FIRST_PASS_WRMS(el.rms_km);
    b.add_BEST_PASS_WRMS(el.rms_km);
    b.add_NUM_ITERATIONS(static_cast<uint16_t>(el.iterations < 0 ? 0 : el.iterations));

    const auto obd = b.Finish();
    FinishSizePrefixedOBDBuffer(fbb, obd);

    const uint8_t* p = fbb.GetBufferPointer();
    return std::vector<uint8_t>(p, p + fbb.GetSize());
}

}  // namespace od
