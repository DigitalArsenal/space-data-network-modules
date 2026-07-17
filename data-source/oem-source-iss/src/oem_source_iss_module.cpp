/*
 * data-source/oem-source-iss (SDN OD-Flow Phase 1b).
 *
 * A single-source flow node: on a timer "tick" it emits the ISS operator
 * ephemeris as an SDS $OEM FlatBuffer (aligned-binary, typed $OEM) on the "oem"
 * output port. The $OEM is built in-module from the checked-in NASA ISS OEM
 * fixture (EME2000, TIME_SYSTEM UTC, CENTER Earth) — the INVERSE of analysis/od's
 * oem_fb_reader, and the SAME state series the sacred RMS-parity gate uses. It
 * mirrors build_oem_fb() from analysis/od/tests test_oem_fb_parity.cpp exactly.
 *
 * IT STORES NOTHING: the ephemeris exists only as the emitted frame, held in
 * memory for the duration of the downstream OD fit. No node wires $OEM to a
 * store (in-memory-only by construction — the OD-flow invariant).
 *
 * build.mjs prepends, ahead of this TU:
 *   - the SDS generated headers (RFM/TIM/IDM/PLD/LCC/CAT/PPE/OEM), so the
 *     generated types (OEM, ephemerisDataBlock, ephemerisDataLine, CAT, RFM,
 *     CelestialFrame, timingStandard, ...) are in scope; and
 *   - iss_oem_fixture.inc: kIssStates[]/kIssStateCount + kOem* identity/frame
 *     constants, generated FROM the fixture (fixture stays the source of truth).
 */

#include <cstdint>
#include <vector>

#include "space_data_module_invoke.h"

namespace {

// Build a NON-size-prefixed SDS $OEM FlatBuffer for the ISS fixture by delegating
// to the shared oem_fb::build_oem_flatbuffer (common/oem_fb_builder.hpp, inlined by
// build.mjs). EME2000/UTC/Earth is the honest source frame (the OD reader rotates
// EME2000 -> TEME for the fit). OemFixtureState exposes exactly the fields the
// builder template needs (.epoch/.x/.y/.z/.vx/.vy/.vz), so kIssStates passes
// straight through — byte-for-byte the $OEM the RMS-parity gate exercises.
std::vector<uint8_t> build_iss_oem() {
    const oem_fb::Identity id{kOemObjectName, kOemObjectId, kOemNoradCatId};
    return oem_fb::build_oem_flatbuffer(id, CelestialFrame_EME2000, kOemCenterName,
                                        timingStandard_UTC, kIssStates,
                                        kIssStateCount);
}

}  // namespace

extern "C" {

// emit: timer tick -> one ISS $OEM ephemeris frame on the "oem" port as
// ALIGNED_BINARY (align 8). Nothing is stored.
int emit(void) {
    plugin_reset_output_state();
    std::vector<uint8_t> oem = build_iss_oem();
    if (oem.empty()) {
        plugin_set_error("oem-build-failed", "ISS $OEM FlatBuffer build produced no bytes");
        return 500;
    }
    const int32_t rc = plugin_push_output_ex(
        "oem", "OEM.fbs", "$OEM",
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "OEM",
        /*fixed_string_length=*/0, /*required_alignment=*/8,
        oem.data(), static_cast<uint32_t>(oem.size()));
    return rc < 0 ? 500 : 0;
}

}  // extern "C"
