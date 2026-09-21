#ifndef OD_OCM_FB_BUILDER_H
#define OD_OCM_FB_BUILDER_H

/**
 * SDS $OCM (Orbit Comprehensive Message) FlatBuffer builder — the aligned-binary
 * flow-node output path for the OD fit's STATE + COVARIANCE + OD_RESIDUALS
 * (SDN OD-Flow Phase 1, additive to omm_fb_builder).
 *
 * Isolated TU (mirrors omm_fb_builder.cpp): the ONLY OD source that includes the
 * generated SDS $OCM header, so its flatc symbols/guards never collide with the
 * $OMM/$OBD/$OEM headers used in the sibling builder TUs. Exposes only a
 * plain-C++ surface (od::build_ocm_flatbuffer); no FlatBuffers types leak.
 *
 * Byte-shape: a size-prefixed FlatBuffer ([u32le len][OCM]) as produced by
 * FinishSizePrefixedOCMBuffer — the exact aligned-binary payload the $PIV ABI
 * emits via plugin_push_output_ex(..., ALIGNED_BINARY, ...), same as $OMM.
 *
 * Covariance is optional. Only finite, positive-definite full matrices from
 * converged, observable fits are published, with frame/units/epoch metadata.
 * These are formal unweighted fit covariances, not calibrated prediction
 * uncertainties. Missing/invalid estimates remain absent; RMS is not a fallback.
 */

#include <cstdint>
#include <string>
#include <vector>

#include "od/sgp4_fitter.h"  // SGP4Elements

namespace od {

/// Plain-C++ inputs for the $OCM builder. `el` carries identity + epoch; the
/// rest are the fit's real state/quality outputs (no FlatBuffers types).
struct OCMInputs {
    const SGP4Elements* el = nullptr;  // fitted mean elements (identity + epoch)

    // Cartesian TEME state at the fit epoch: x,y,z (km), vx,vy,vz (km/s).
    double state_teme[6] = {0, 0, 0, 0, 0, 0};
    bool has_state = false;

    // 6x6 lower-triangular covariance (21 doubles, row-major). When
    // has_covariance is false, or validation fails, the output vector is absent.
    double covariance[21] = {0};
    bool has_covariance = false;

    // Fit quality (real outputs from the SGP4 differential-correction fit).
    double rms_km = 0.0;
    int num_observations = 0;
    int iterations = 0;
    bool converged = false;
    double convergence_tol = 0.0;
};

/// Build a size-prefixed SDS `$OCM` FlatBuffer from a fit's state + covariance +
/// residual summary. `originator` marks provenance (default "SDN-OD");
/// `creation_date` is the ISO-8601 UTC creation stamp (empty to omit). Returns
/// the size-prefixed FlatBuffer payload bytes.
std::vector<uint8_t> build_ocm_flatbuffer(const OCMInputs& in,
                                          const std::string& originator = "SDN-OD",
                                          const std::string& creation_date = std::string());

}  // namespace od

#endif  // OD_OCM_FB_BUILDER_H
