#pragma once
// common/oem_fb_builder.hpp — shared SDS $OEM FlatBuffer builder for the SDN
// OD-flow provider sources. Generalizes oem-source-iss::build_iss_oem to arbitrary
// (identity, frame, states): the INVERSE of analysis/od's oem_fb_reader, emitting a
// NON-size-prefixed SDS $OEM (root table + "$OEM" file id) that od.fit accepts.
// Providers fetch+parse (per-provider format), then call this to emit ONE $OEM per
// object into the OD flow — ephemeris in memory only, no store, no JSON.
//
// REQUIRES the generated SDS $OEM types in scope BEFORE this header:
//   OEM(+Builder), ephemerisDataBlock(+Builder), ephemerisDataLine(+Create),
//   CAT(+Builder), RFM(+Builder)/RFMUnionTraits, CelestialFrame, timingStandard,
//   CreateCelestialFrameWrapper, FinishOEMBuffer, and flatbuffers::FlatBufferBuilder.
// Works against BOTH SDS header variants: the lib/cpp headers (UNSCOPED/prefixed
// enums, CelestialFrame_EME2000 — oem-source-iss inlines these) AND the
// licensing/core headers (SCOPED enums, CelestialFrame::EME2000 — the em++
// provider modules include these via CORE_SDS_GENERATED_DIR). The only builder-
// internal union discriminator is taken variant-agnostically via
// RFMUnionTraits<CelestialFrameWrapper>::enum_value (flatc emits the traits in
// both); the frame/time_system ENUM MEMBER names live only in each CALLER's file.
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
    rfmb.add_REFERENCE_FRAME_type(RFMUnionTraits<CelestialFrameWrapper>::enum_value);
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

// Build a NON-size-prefixed SDS $OEM FlatBuffer in the COMPACT form: a flat
// EPHEMERIS_DATA vector (stride 6: x,y,z,vx,vy,vz km/km-s) + START_TIME + STEP_SIZE
// (seconds), from which analysis/od's oem_fb_reader reconstructs epoch[i] =
// START_TIME + i*STEP_SIZE. This is the shape uniform-cadence providers carry
// (e.g. SpaceX MEME: parse yields a flat state array + start/stop/step, per-line
// epochs dropped), so they build $OEM without materializing an ISO string per
// state. `ephemeris_data` length must be a multiple of 6.
inline std::vector<uint8_t> build_oem_flatbuffer_compact(
    const Identity& id, CelestialFrame frame, const char* center_name,
    timingStandard time_system, const char* start_iso, const char* stop_iso,
    double step_seconds, const double* ephemeris_data, int num_doubles) {
    flatbuffers::FlatBufferBuilder fbb(1 << 16);

    std::vector<double> data(
        ephemeris_data, ephemeris_data + (num_doubles < 0 ? 0 : num_doubles));
    auto data_vec = fbb.CreateVector(data);

    auto obj_name = fbb.CreateString(id.object_name);
    auto obj_id = fbb.CreateString(id.object_id);
    CATBuilder catb(fbb);
    catb.add_OBJECT_NAME(obj_name);
    catb.add_OBJECT_ID(obj_id);
    catb.add_NORAD_CAT_ID(id.norad_cat_id);
    auto cat = catb.Finish();

    auto cfw = CreateCelestialFrameWrapper(fbb, frame);
    RFMBuilder rfmb(fbb);
    rfmb.add_REFERENCE_FRAME_type(RFMUnionTraits<CelestialFrameWrapper>::enum_value);
    rfmb.add_REFERENCE_FRAME(cfw.Union());
    auto rfm = rfmb.Finish();

    auto center = fbb.CreateString(center_name);
    auto start = fbb.CreateString(start_iso);
    const bool has_stop = stop_iso != nullptr && stop_iso[0] != '\0';
    auto stop = has_stop ? fbb.CreateString(stop_iso)
                         : flatbuffers::Offset<flatbuffers::String>();

    ephemerisDataBlockBuilder blk(fbb);
    blk.add_OBJECT(cat);
    blk.add_CENTER_NAME(center);
    blk.add_REFERENCE_FRAME(rfm);
    blk.add_TIME_SYSTEM(time_system);
    blk.add_START_TIME(start);
    if (has_stop) blk.add_STOP_TIME(stop);
    blk.add_STEP_SIZE(step_seconds);
    blk.add_STATE_VECTOR_SIZE(6);
    blk.add_EPHEMERIS_DATA(data_vec);
    auto block = blk.Finish();

    std::vector<flatbuffers::Offset<ephemerisDataBlock>> blocks{block};
    auto blocks_vec = fbb.CreateVector(blocks);

    OEMBuilder oemb(fbb);
    oemb.add_EPHEMERIS_DATA_BLOCK(blocks_vec);
    auto oem = oemb.Finish();
    FinishOEMBuffer(fbb, oem);

    const uint8_t* p = fbb.GetBufferPointer();
    return std::vector<uint8_t>(p, p + fbb.GetSize());
}

// COMPACT-form $OEM with a CUSTOM frame (RFM{ CustomFrameWrapper{ frame } }) instead
// of a celestial frame. This is what SpaceX MEME and other TEME providers need:
// `frame = CustomFrame_TEME` reads back as the token "TEME" (the SDS CustomFrame
// TEME arm is documented "same as TEMEOFDATE: Dynamic frame for SGP4"), which the
// OD reader's classify_frame accepts as FrameKind::Teme — whereas CelestialFrame's
// TEMEOFDATE would read back as "TEMEOFDATE", which it does NOT accept. Same shape
// as the celestial compact builder otherwise; overloaded on the frame enum type.
inline std::vector<uint8_t> build_oem_flatbuffer_compact(
    const Identity& id, CustomFrame frame, const char* center_name,
    timingStandard time_system, const char* start_iso, const char* stop_iso,
    double step_seconds, const double* ephemeris_data, int num_doubles) {
    flatbuffers::FlatBufferBuilder fbb(1 << 16);

    std::vector<double> data(
        ephemeris_data, ephemeris_data + (num_doubles < 0 ? 0 : num_doubles));
    auto data_vec = fbb.CreateVector(data);

    auto obj_name = fbb.CreateString(id.object_name);
    auto obj_id = fbb.CreateString(id.object_id);
    CATBuilder catb(fbb);
    catb.add_OBJECT_NAME(obj_name);
    catb.add_OBJECT_ID(obj_id);
    catb.add_NORAD_CAT_ID(id.norad_cat_id);
    auto cat = catb.Finish();

    auto cfw = CreateCustomFrameWrapper(fbb, frame);
    RFMBuilder rfmb(fbb);
    rfmb.add_REFERENCE_FRAME_type(RFMUnionTraits<CustomFrameWrapper>::enum_value);
    rfmb.add_REFERENCE_FRAME(cfw.Union());
    auto rfm = rfmb.Finish();

    auto center = fbb.CreateString(center_name);
    auto start = fbb.CreateString(start_iso);
    const bool has_stop = stop_iso != nullptr && stop_iso[0] != '\0';
    auto stop = has_stop ? fbb.CreateString(stop_iso)
                         : flatbuffers::Offset<flatbuffers::String>();

    ephemerisDataBlockBuilder blk(fbb);
    blk.add_OBJECT(cat);
    blk.add_CENTER_NAME(center);
    blk.add_REFERENCE_FRAME(rfm);
    blk.add_TIME_SYSTEM(time_system);
    blk.add_START_TIME(start);
    if (has_stop) blk.add_STOP_TIME(stop);
    blk.add_STEP_SIZE(step_seconds);
    blk.add_STATE_VECTOR_SIZE(6);
    blk.add_EPHEMERIS_DATA(data_vec);
    auto block = blk.Finish();

    std::vector<flatbuffers::Offset<ephemerisDataBlock>> blocks{block};
    auto blocks_vec = fbb.CreateVector(blocks);

    OEMBuilder oemb(fbb);
    oemb.add_EPHEMERIS_DATA_BLOCK(blocks_vec);
    auto oem = oemb.Finish();
    FinishOEMBuffer(fbb, oem);

    const uint8_t* p = fbb.GetBufferPointer();
    return std::vector<uint8_t>(p, p + fbb.GetSize());
}

}  // namespace oem_fb
