// oem_fb_builder_test.cpp — native unit test for the shared $OEM builder
// (oem_fb_builder.hpp) against the licensing/core SDS headers the em++ provider
// modules use. Verifies BOTH the CelestialFrame (EME2000) and CustomFrame (TEME,
// for SpaceX MEME) compact overloads produce a valid $OEM whose frame token reads
// back correctly (TEME -> classify_frame FrameKind::Teme in analysis/od).
//
// Compile (from repo root main-packages/):
//   clang++ -std=c++17 -Iflatbuffers/include \
//     -Ispace-data-network-modules/data-source/common \
//     -Ispace-data-network-modules/licensing/core/src/cpp/generated/sds \
//     space-data-network-modules/data-source/common/tests/oem_fb_builder_test.cpp -o /tmp/oemfb && /tmp/oemfb

// Native macOS: undef the SVID math.h macros that collide with generated enum ids
// (this hazard is native-only; the emscripten/WASI sysroot has none).
#include <cmath>
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
#include "OEM_generated.h"
#include "oem_fb_builder.hpp"
#include <cstdio>
#include <cstring>

int main() {
    const double states[12] = {7000,0,0, 0,7.5,0, 7001,0,0, 0,7.5,0};
    oem_fb::Identity id{"STARLINK-X", "", 67851u};
    auto teme = oem_fb::build_oem_flatbuffer_compact(
        id, CustomFrame::TEME, "EARTH", timingStandard::UTC,
        "2026-05-14T00:00:00.000", "2026-05-14T00:04:00.000", 240.0, states, 12);
    auto eme = oem_fb::build_oem_flatbuffer_compact(
        id, CelestialFrame::EME2000, "EARTH", timingStandard::UTC,
        "2026-05-14T00:00:00.000", "", 240.0, states, 12);
    // Verify the TEME buffer is a valid $OEM and reads back frame token "TEME".
    ::flatbuffers::Verifier v(teme.data(), teme.size());
    bool ok = VerifyOEMBuffer(v) && OEMBufferHasIdentifier(teme.data());
    const OEM* rec = GetOEM(teme.data());
    const char* frame = "?";
    if (rec && rec->EPHEMERIS_DATA_BLOCK() && rec->EPHEMERIS_DATA_BLOCK()->size() > 0) {
        auto blk = rec->EPHEMERIS_DATA_BLOCK()->Get(0);
        if (blk->REFERENCE_FRAME() && blk->REFERENCE_FRAME()->REFERENCE_FRAME_as_CustomFrameWrapper())
            frame = EnumNameCustomFrame(blk->REFERENCE_FRAME()->REFERENCE_FRAME_as_CustomFrameWrapper()->frame());
    }
    std::printf("teme=%zu eme=%zu valid=%d frame=%s\n", teme.size(), eme.size(), ok?1:0, frame);
    return (ok && std::strcmp(frame,"TEME")==0) ? 0 : 1;
}
