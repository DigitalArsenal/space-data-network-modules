// SDS $OCM (Orbit Comprehensive Message) FlatBuffer builder — the aligned-binary
// flow-node output path for the OD fit's STATE + COVARIANCE + OD_RESIDUALS. It describes the fit
// and hands the description to the shared builder (common/ocm_fb_builder.hpp), which analysis/vcm-adapter
// also writes its OCMs with.
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
// The shared $OCM builder (common/ocm_fb_builder.hpp), after the generated types it requires.
#include "ocm_fb_builder.hpp"

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

    ocm_fb::Record r;
    r.creationDate = creation_date;
    r.originator = originator.empty() ? std::string("SDN-OD") : originator;
    if (el) {
        r.objectName = el->object_name;
        r.internationalDesignator = el->object_id;
        if (el->norad_cat_id > 0) r.catalogName = std::to_string(el->norad_cat_id);
        // STATE_DATA index zero is defined by METADATA.START_TIME in SDS OCM.
        // Reuse the fit epoch for its single epoch state.
        r.epoch = el->epoch_iso;
    }
    r.timeSystem = "UTC";
    if (state_available) r.state.assign(in.state_teme, in.state_teme + 6);
    if (covariance_available) r.covariance.assign(in.covariance, in.covariance + 21);

    r.od.present = true;
    r.od.method = "DIFFERENTIAL_CORRECTION";
    r.od.algorithm = "SGP4-LM-EQUINOCTIAL";
    r.od.epoch = r.epoch;
    r.od.observationsUsed = in.num_observations;
    r.od.covReduction = covariance_available ? "FORMAL_UNWEIGHTED_NORMAL_EQUATIONS" : "UNAVAILABLE";
    char convbuf[64];
    std::snprintf(convbuf, sizeof(convbuf), "sigma_rel<%.3g;converged=%d", in.convergence_tol, in.converged ? 1 : 0);
    r.od.convergenceCriteria = convbuf;
    char resbuf[80];
    std::snprintf(resbuf, sizeof(resbuf), "WRMS=%.9g km", in.rms_km);
    r.od.residuals = resbuf;

    r.user = {{"STATE_REFERENCE_FRAME", "TEME"},
              {"STATE_UNITS", "km,km,km,km/s,km/s,km/s"},
              {"COVARIANCE_LAYOUT", "6x6 lower triangular, row-major; products of state units"},
              {"COVARIANCE_INTERPRETATION", "Formal fit uncertainty only; not calibrated prediction uncertainty"}};
    return ocm_fb::build(r);
}

}  // namespace od
