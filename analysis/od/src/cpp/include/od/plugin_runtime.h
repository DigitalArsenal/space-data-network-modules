#ifndef OD_PLUGIN_RUNTIME_H
#define OD_PLUGIN_RUNTIME_H

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace od {

struct PluginFitResult {
    bool ok = false;
    std::string json;
    std::string error_code;
    std::string error_message;
};

/// Fit SupGP/OMM elements from an ephemeris payload. Format is selected by the
/// `inputFormat` option ("meme" | "oem"), or auto-detected from the content.
/// `data_source`, `objectName` and `objectId` may be supplied via the options
/// JSON to label the output (the module never hardcodes an operator). Keeps the
/// module ABI unchanged: format selection is data-level, not a new method/port.
///
/// TEXT input path (command back-compat: SpaceX MEME text or CCSDS OEM KVN). The
/// aligned-binary flow path is fit_ephemeris_fb below.
PluginFitResult fit_ephemeris_payload(
    std::string_view ephemeris_content,
    std::string_view options_json = {});

/// Result of the aligned-binary $OEM -> fit -> $OMM path. No JSON: `omm` is a
/// size-prefixed SDS `$OMM` FlatBuffer ready to push as an ALIGNED_BINARY output
/// frame. The scalar echoes (rms/converged/mean_motion) are for host telemetry,
/// not a data hop.
struct PluginFitFBResult {
    bool ok = false;
    std::vector<uint8_t> omm;  // size-prefixed $OMM FlatBuffer (mean elements)
    std::vector<uint8_t> obd;  // size-prefixed $OBD FlatBuffer (OD run result: WRMS,
                               // iterations, method) — same fit, emitted alongside $OMM
    std::vector<uint8_t> ocm;  // size-prefixed $OCM FlatBuffer (epoch STATE + 6x6
                               // COVARIANCE + OD residual summary) — same fit. Empty
                               // when covariance was not requested/available.
    std::string error_code;
    std::string error_message;
    double rms_km = 0.0;
    bool converged = false;
    double mean_motion = 0.0;
};

/// FLATBUFFER input path (the flow-node data hop): read an SDS `$OEM` FlatBuffer,
/// fit the SAME core the KVN path fits (byte-for-byte parity for the same state
/// vectors), and build an SDS `$OMM` FlatBuffer from the result. `options_json`
/// carries only labeling/scoring/fit-config overrides (moved to node CONFIG in
/// the flow) — NEVER the ephemeris. No JSON at the data hop.
PluginFitFBResult fit_ephemeris_fb(
    const uint8_t* oem_buf,
    std::size_t oem_len,
    std::string_view options_json = {});

/// Complete-arc flow path: parse one full SDS $OEM once, fit deterministic
/// overlapping local windows that cover its first through terminal state, and
/// return one epoch-specific $OMM/$OCM/$OBD record set per window.
std::vector<PluginFitFBResult> fit_ephemeris_epochs_fb(
    const uint8_t* oem_buf,
    std::size_t oem_len,
    std::string_view options_json = {});

}  // namespace od

#endif  // OD_PLUGIN_RUNTIME_H
