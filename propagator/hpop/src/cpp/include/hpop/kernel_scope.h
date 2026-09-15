#pragma once

#include "ephemeris.h"
#include "space_data_module_invoke.h"
#include "../../../../../../files/orbit-products/src/kernel_frame.hpp"
#include <cstring>

namespace hpop {

// The invoke bridge owns input bytes. The SPK view lives for this invocation
// only, including all integrator substeps; its destructor detaches the view
// before the bridge can release the frame. No filesystem or coefficient copy.
class KernelScope {
    ephem::KernelFrame frame_;
public:
    bool ok = true;
    KernelScope() {
        using namespace astro::Ephemeris;
        clearEphemerisBuffer();
        bool found = false;
        for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
            const auto* input = plugin_get_input_frame(i);
            if (!input || !input->port_id || std::strcmp(input->port_id, "kernel")) continue;
            const char* error = nullptr;
            if (found || !ephem::decode_kernel_frame(input->payload, input->payload_length, &frame_, &error)) {
                plugin_set_error("invalid-kernel", found ? "Only one kernel input is supported." : error);
                ok = false;
                return;
            }
            found = true;
            if (!loadEphemerisBuffer(frame_.body, frame_.body_length)) {
                plugin_set_error("invalid-kernel", ephemerisError().c_str());
                ok = false;
                return;
            }
        }
    }
    ~KernelScope() {
        astro::Ephemeris::clearEphemerisBuffer();
    }
};

} // namespace hpop
