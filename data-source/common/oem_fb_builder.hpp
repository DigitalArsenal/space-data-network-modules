#pragma once
// common/oem_fb_builder.hpp — shared SDS $OEM FlatBuffer builder for the SDN
// OD-flow provider sources. Generalizes oem-source-iss::build_iss_oem to arbitrary
// (identity, frame, states): the INVERSE of analysis/od's oem_fb_reader, emitting a
// NON-size-prefixed SDS $OEM (root table + "$OEM" file id) that od.fit accepts.
// Providers fetch+parse (per-provider format), then call this to emit ONE $OEM per
// object into the OD flow — ephemeris in memory only, no store, no JSON.
//
// REQUIRES the generated SDS $OEM lib/cpp types in scope BEFORE this header:
//   OEM(+Builder), ephemerisDataBlock(+Builder), ephemerisDataLine(+Create),
//   CAT(+Builder), RFM(+Builder), CelestialFrame, timingStandard,
//   RFMUnion_CelestialFrameWrapper, CreateCelestialFrameWrapper, FinishOEMBuffer,
//   and flatbuffers::FlatBufferBuilder.
// oem-source-iss inlines lib/cpp/{RFM,TIM,IDM,PLD,LCC,CAT,PPE,OEM}/main_generated.h
// ahead of this header (build.mjs); provider modules include them in the same
// topological order before including this. The lib/cpp headers use UNSCOPED
// (prefixed) enum members (CelestialFrame_EME2000, timingStandard_UTC, ...).
#include <cstdint>
#include <vector>

namespace oem_fb {

// Identity carried on the $OEM's OBJECT (CAT). object_id may be "" (e.g. SpaceX
// MEME has no intl designator); norad labels the downstream $OMM without options.
struct Identity {
    const char* object_name;
    const char* object_id;
    uint32_t norad_cat_id;
};

// Build a NON-size-prefixed SDS $OEM FlatBuffer from one object's states. StateT
// must expose `.epoch` (CreateString-able, ISO-8601 UTC) and doubles
// `.x/.y/.z/.vx/.vy/.vz` (km, km/s). `frame` is a CelestialFrame arm — e.g.
// CelestialFrame_EME2000 (ISS OEM), CelestialFrame_TEMEOFDATE (SpaceX MEME, which
// is effectively TEME); the OD reader rotates the honest source frame to TEME for
// the fit. `time_system` is a timingStandard arm (e.g. timingStandard_UTC).
//
// Construction ORDER mirrors build_iss_oem EXACTLY, so identical inputs yield
// byte-identical output — preserving the sacred RMS-parity gate.
template <typename StateT>
inline std::vector<uint8_t> build_oem_flatbuffer(
    const Identity& id, CelestialFrame frame, const char* center_name,
    timingStandard time_system, const StateT* states, int state_count) {
    flatbuffers::FlatBufferBuilder fbb(1 << 16);

    std::vector<flatbuffers::Offset<ephemerisDataLine>> lines;
    lines.reserve(state_count < 0 ? 0 : static_cast<std::size_t>(state_count));
    for (int i = 0; i < state_count; ++i) {
        const StateT& s = states[i];
        auto epoch = fbb.CreateString(s.epoch);
        lines.push_back(
            CreateephemerisDataLine(fbb, epoch, s.x, s.y, s.z, s.vx, s.vy, s.vz));
    }
    auto lines_vec = fbb.CreateVector(lines);

    auto obj_name = fbb.CreateString(id.object_name);
    auto obj_id = fbb.CreateString(id.object_id);
    CATBuilder catb(fbb);
    catb.add_OBJECT_NAME(obj_name);
    catb.add_OBJECT_ID(obj_id);
    catb.add_NORAD_CAT_ID(id.norad_cat_id);
    auto cat = catb.Finish();

    // REFERENCE_FRAME = RFM{ CelestialFrameWrapper{ frame } } — honest source frame.
    auto cfw = CreateCelestialFrameWrapper(fbb, frame);
    RFMBuilder rfmb(fbb);
    rfmb.add_REFERENCE_FRAME_type(RFMUnion_CelestialFrameWrapper);
    rfmb.add_REFERENCE_FRAME(cfw.Union());
    auto rfm = rfmb.Finish();

    auto center = fbb.CreateString(center_name);

    ephemerisDataBlockBuilder blk(fbb);
    blk.add_OBJECT(cat);
    blk.add_CENTER_NAME(center);
    blk.add_REFERENCE_FRAME(rfm);
    blk.add_TIME_SYSTEM(time_system);
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

}  // namespace oem_fb
