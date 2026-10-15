#include "od/plugin_runtime.h"

#include "plugin_manifest_bytes.h"
#include "space_data_module_invoke.h"

#include <cstdint>
#include <limits>
#include <string>
#include <string_view>
#include <vector>

#include "FIL_generated.h"
#include "typedHostcall.hpp"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

namespace {

const plugin_input_frame_t* find_input_frame(const char* port_id) {
    const auto count = plugin_get_input_count();
    for (uint32_t index = 0; index < count; ++index) {
        const auto* frame = plugin_get_input_frame(index);
        if (frame && frame->port_id && std::string(frame->port_id) == port_id) {
            return frame;
        }
    }
    return nullptr;
}

// One size-prefixed SDS record as an ALIGNED_BINARY frame (align 8).
bool push_record(const char* port, const char* schema, const char* file_id, const char* root,
                 const std::vector<uint8_t>& bytes) {
    if (bytes.empty() || plugin_push_output_ex(port, schema, file_id, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, root,
                                               /*fixed_string_length=*/0, /*required_alignment=*/8, bytes.data(),
                                               static_cast<uint32_t>(bytes.size())) < 0) {
        plugin_set_error("emit-failed", (std::string("Failed to emit the ") + file_id + " frame.").c_str());
        return false;
    }
    return true;
}

int positive_int(const sdm_piv::Config& config, std::string_view key) {
    const double value = config.number(key, 0);
    if (!(value >= 1)) return 0;
    return value >= static_cast<double>(std::numeric_limits<int>::max()) ? std::numeric_limits<int>::max()
                                                                         : static_cast<int>(value);
}

// The fit's node CONFIG (plugin.getConfig: one ModuleConfig, read in place).
bool read_fit_options(od::FitOptions* out) {
    const sdm_piv::Config config = sdm_piv::get_config();
    if (!config.ok()) {
        plugin_set_error("config-unavailable", ("plugin.getConfig: " + config.error_message()).c_str());
        return false;
    }
    out->data_source = std::string(config.string("dataSource"));
    out->object_name = std::string(config.string("objectName"));
    out->object_id = std::string(config.string("objectId"));
    out->norad_cat_id = positive_int(config, "noradCatId");
    const int camel = positive_int(config, "maxIterations");
    out->max_iterations = camel > 0 ? camel : positive_int(config, "max_iterations");
    out->input_format = std::string(config.string("inputFormat"));
    out->emit_tle = config.boolean("emitTle");
    const std::string_view ref_epoch = config.string("refEpoch");
    const double ref_mm = config.number("refMeanMotion", 0);
    if (!ref_epoch.empty() && ref_mm > 0.0) {
        od::SGP4Elements& ref = out->reference;
        ref.epoch_iso = std::string(ref_epoch);
        ref.mean_motion = ref_mm;
        ref.eccentricity = config.number("refEccentricity", ref.eccentricity);
        ref.inclination = config.number("refInclination", ref.inclination);
        ref.ra_of_asc_node = config.number("refRaan", ref.ra_of_asc_node);
        ref.arg_of_pericenter = config.number("refArgPericenter", ref.arg_of_pericenter);
        ref.mean_anomaly = config.number("refMeanAnomaly", ref.mean_anomaly);
        ref.bstar = config.number("refBstar", ref.bstar);
        ref.mean_motion_dot = config.number("refMeanMotionDot", ref.mean_motion_dot);
        ref.mean_motion_ddot = config.number("refMeanMotionDdot", ref.mean_motion_ddot);
        out->has_reference = true;
    }
    return true;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
const uint8_t* plugin_get_manifest_flatbuffer(void) {
    return od_plugin_manifest_bytes;
}

EMSCRIPTEN_KEEPALIVE
uint32_t plugin_get_manifest_flatbuffer_size(void) {
    return od_plugin_manifest_bytes_len;
}

EMSCRIPTEN_KEEPALIVE
int fit(void) {
    plugin_reset_output_state();

    od::FitOptions options;
    if (!read_fit_options(&options)) return 1;

    // Exactly one ephemeris: an SDS $OEM FlatBuffer on "oem", or a text ephemeris file (SpaceX MEME or CCSDS OEM
    // KVN) as an SDS $FIL on "meme". Both fit the SAME core and emit the same records.
    od::PluginFitFBResult fb;
    const auto* oem_frame = find_input_frame("oem");
    if (oem_frame && oem_frame->payload && oem_frame->payload_length > 0) {
        fb = od::fit_ephemeris_fb(oem_frame->payload, oem_frame->payload_length, options);
    } else {
        const auto* frame = find_input_frame("meme");
        if (!frame || !frame->payload) {
            plugin_set_error("missing-input",
                             "Input port \"oem\" ($OEM) or \"meme\" ($FIL text ephemeris) is required.");
            return 1;
        }
        flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
        if (!VerifyFILBuffer(verifier)) {
            plugin_set_error("invalid-input", "The \"meme\" frame is not an SDS $FIL FlatBuffer.");
            return 1;
        }
        const FIL* file = GetFIL(frame->payload);
        const auto* content = file->CONTENT();
        fb = od::fit_ephemeris_text(
            content ? std::string_view(reinterpret_cast<const char*>(content->data()), content->size())
                    : std::string_view{},
            options);
    }
    if (!fb.ok) {
        plugin_set_error(fb.error_code.c_str(), fb.error_message.c_str());
        return 1;
    }

    if (!push_record("omm", "OMM.fbs", "$OMM", "OMM", fb.omm) ||
        !push_record("ocm", "OCM.fbs", "$OCM", "OCM", fb.ocm) ||
        !push_record("obd", "OBD.fbs", "$OBD", "OBD", fb.obd) ||
        (!fb.reference_obd.empty() && !push_record("obd", "OBD.fbs", "$OBD", "OBD", fb.reference_obd))) {
        return 1;
    }
    if (options.emit_tle) {
        // The legacy two-line set as a text file record: NAME "<NORAD>.tle", text/plain, "line1\nline2".
        flatbuffers::FlatBufferBuilder b(512);
        const auto name = b.CreateString(fb.tle_name);
        const auto media = b.CreateString("text/plain");
        const auto bytes = b.CreateVector(reinterpret_cast<const uint8_t*>(fb.tle.data()), fb.tle.size());
        FILBuilder fil(b);
        fil.add_NAME(name);
        fil.add_KIND(filEntryKind_File);
        fil.add_MEDIA_TYPE(media);
        fil.add_SIZE(fb.tle.size());
        fil.add_CONTENT(bytes);
        FinishFILBuffer(b, fil.Finish());
        if (plugin_push_output_ex("tle", "FIL.fbs", "$FIL", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "FIL", 0, 0,
                                  b.GetBufferPointer(), b.GetSize()) < 0) {
            plugin_set_error("emit-failed", "Failed to emit the $FIL two-line set.");
            return 1;
        }
    }
    return 0;
}

}  // extern "C"
