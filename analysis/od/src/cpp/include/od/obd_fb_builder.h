#ifndef OD_OBD_FB_BUILDER_H
#define OD_OBD_FB_BUILDER_H

/**
 * SDS $OBD (Orbit Determination Results) FlatBuffer builder — the OD-run-result-
 * with-RMS record (SDN OD-Flow). Mirrors omm_fb_builder exactly (fit result in,
 * size-prefixed bytes out) — this is the "$OBD is a NEW builder TU + NEW output
 * port off the SAME fit result" the omm_fb_builder.h extensibility note describes.
 *
 * Captures the fit TELEMETRY alongside the $OMM mean elements on the SAME fit:
 * weighted RMS of residuals (WRMS = the position-residual RMS, km — the fit is
 * position-residual only), iterations to converge, and the OD method
 * (DIFFERENTIAL_CORRECTION: the SGP4 supplemental-GP fit is an iterative
 * differential correction / Gauss-Newton least squares over the ephemeris points).
 * ORIGINATOR/provenance rides in METHOD_SOURCE ("SDN-OD"). NO JSON.
 *
 * Output byte-shape: size-prefixed ([u32le len][OBD]) via FinishSizePrefixedOBDBuffer
 * — the aligned-binary payload the $PIV ABI emits via plugin_push_output_ex.
 */

#include <cstdint>
#include <string>
#include <vector>

#include "od/sgp4_fitter.h"  // SGP4Elements

namespace od {

/// Build a size-prefixed SDS `$OBD` from a fit's SGP4Elements. `fit_span_days` is
/// the ephemeris span the fit covered (0 to omit); `method_source` marks
/// provenance (default "SDN-OD"). WRMS is the position-residual RMS (km).
std::vector<uint8_t> build_obd_flatbuffer(const SGP4Elements& el,
                                          double fit_span_days,
                                          const std::string& method_source = "SDN-OD");

}  // namespace od

#endif  // OD_OBD_FB_BUILDER_H
