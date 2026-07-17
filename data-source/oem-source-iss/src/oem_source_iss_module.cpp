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

// Build a NON-size-prefixed SDS $OEM FlatBuffer (root table + "$OEM" file id, as
// analysis/od::read_oem_flatbuffer / GetOEM expect). Verbose form: one explicit
// EPHEMERIS_DATA_LINE per state (EME2000, per-line EPOCH). This is byte-for-byte
// the build_oem_fb() the parity gate exercises, driven by the embedded fixture.
std::vector<uint8_t> build_iss_oem() {
    flatbuffers::FlatBufferBuilder fbb(1 << 16);

    std::vector<flatbuffers::Offset<ephemerisDataLine>> lines;
    lines.reserve(static_cast<size_t>(kIssStateCount));
    for (int i = 0; i < kIssStateCount; ++i) {
        const OemFixtureState& s = kIssStates[i];
        auto epoch = fbb.CreateString(s.epoch);
        lines.push_back(CreateephemerisDataLine(fbb, epoch, s.x, s.y, s.z,
                                                s.vx, s.vy, s.vz));
    }
    auto lines_vec = fbb.CreateVector(lines);

    // Identity (CAT). NORAD is not in the CCSDS fixture META; the node carries
    // the ISS catalog id so the downstream $OMM is labeled without options.
    auto obj_name = fbb.CreateString(kOemObjectName);
    auto obj_id = fbb.CreateString(kOemObjectId);
    CATBuilder catb(fbb);
    catb.add_OBJECT_NAME(obj_name);
    catb.add_OBJECT_ID(obj_id);
    catb.add_NORAD_CAT_ID(kOemNoradCatId);
    auto cat = catb.Finish();

    // REFERENCE_FRAME = RFM{ CelestialFrameWrapper{ EME2000 } } — honest source
    // frame (the OD reader rotates EME2000 -> TEME for the fit). The SDS lib/cpp
    // headers use unscoped (prefixed) enum members; the enum VALUES are identical
    // to the flat scoped headers, so the emitted bytes are byte-identical.
    auto cfw = CreateCelestialFrameWrapper(fbb, CelestialFrame_EME2000);
    RFMBuilder rfmb(fbb);
    rfmb.add_REFERENCE_FRAME_type(RFMUnion_CelestialFrameWrapper);
    rfmb.add_REFERENCE_FRAME(cfw.Union());
    auto rfm = rfmb.Finish();

    auto center = fbb.CreateString(kOemCenterName);

    ephemerisDataBlockBuilder blk(fbb);
    blk.add_OBJECT(cat);
    blk.add_CENTER_NAME(center);
    blk.add_REFERENCE_FRAME(rfm);
    blk.add_TIME_SYSTEM(timingStandard_UTC);
    blk.add_STEP_SIZE(0.0);  // verbose form (explicit epoch per line)
    blk.add_EPHEMERIS_DATA_LINES(lines_vec);
    auto block = blk.Finish();

    std::vector<flatbuffers::Offset<ephemerisDataBlock>> blocks{block};
    auto blocks_vec = fbb.CreateVector(blocks);

    OEMBuilder oemb(fbb);
    oemb.add_EPHEMERIS_DATA_BLOCK(blocks_vec);
    auto oem = oemb.Finish();
    FinishOEMBuffer(fbb, oem);  // stamps the "$OEM" file identifier

    const uint8_t* p = fbb.GetBufferPointer();
    return std::vector<uint8_t>(p, p + fbb.GetSize());
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
