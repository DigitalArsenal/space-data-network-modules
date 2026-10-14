#ifndef OD_PLUGIN_RUNTIME_H
#define OD_PLUGIN_RUNTIME_H

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "od/sgp4_fitter.h"

namespace od {

/// The fit's node CONFIG (ModuleConfig via plugin.getConfig), as plain values. Every field is optional; the empty
/// value leaves the fit exactly as the default. The keys are the ones the old JSON options object carried:
/// dataSource, objectName, objectId, noradCatId (labels); maxIterations / max_iterations (clamped 1..300);
/// inputFormat ("meme" | "oem", else sniffed) for the text file; emitTle (the two-line set as a $FIL); and the
/// reference element set refEpoch + refMeanMotion (+ refEccentricity, refInclination, refRaan, refArgPericenter,
/// refMeanAnomaly, refBstar, refMeanMotionDot, refMeanMotionDdot), scored over the same fit points.
struct FitOptions {
    std::string data_source;
    std::string object_name;
    std::string object_id;
    int norad_cat_id = 0;          // > 0 overrides
    int max_iterations = 0;        // > 0 overrides (clamped 1..300)
    std::string input_format;      // text path only; lower-cased "meme" | "oem", empty = sniff
    bool emit_tle = false;
    bool has_reference = false;    // refEpoch set and refMeanMotion > 0
    SGP4Elements reference{};      // epoch_iso + the ref* numbers; epoch_jd filled by the fit
};

/// The records of one fit. No JSON: each is a size-prefixed SDS FlatBuffer ready to push as an ALIGNED_BINARY
/// output frame. The scalar echoes (rms/converged/mean_motion) are for host telemetry, not a data hop.
struct PluginFitFBResult {
    bool ok = false;
    std::vector<uint8_t> omm;            // $OMM mean elements
    std::vector<uint8_t> obd;            // $OBD the OD run (WRMS, iterations, method, fit span)
    std::vector<uint8_t> reference_obd;  // $OBD the reference element set scored on the same points (when given)
    std::vector<uint8_t> ocm;            // $OCM epoch STATE + 6x6 COVARIANCE (or UNAVAILABLE) + OD summary
    std::string tle;                     // the two-line set "line1\nline2" (emit_tle only)
    std::string tle_name;                // "<NORAD>.tle"
    std::string error_code;
    std::string error_message;
    double rms_km = 0.0;
    bool converged = false;
    double mean_motion = 0.0;
};

/// FLATBUFFER input path (the flow-node data hop): read an SDS `$OEM` FlatBuffer and fit it.
PluginFitFBResult fit_ephemeris_fb(
    const uint8_t* oem_buf,
    std::size_t oem_len,
    const FitOptions& options = {});

/// TEXT input path: SpaceX MEME text or CCSDS OEM KVN (the content of a $FIL), fitted by the SAME core and emitting
/// the same records as the FlatBuffer path (byte-for-byte for the same state vectors).
PluginFitFBResult fit_ephemeris_text(
    std::string_view ephemeris_content,
    const FitOptions& options = {});

}  // namespace od

#endif  // OD_PLUGIN_RUNTIME_H
