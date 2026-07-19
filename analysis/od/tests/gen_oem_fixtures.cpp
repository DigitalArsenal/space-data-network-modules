// gen_oem_fixtures — native tool that emits a multi-object $OEM FlatBuffer batch
// for the wasi-threads module's thread/RMS-parity gate. Object 0 is the SACRED
// ISS OEM (EME2000, KVN-tokenised so its fit matches the reference WRMS
// 0.070907542 km bit-for-bit); the rest are distinct SpaceX Starlink objects
// (parsed from MEME, TEMEOFDATE frame). Each $OEM is the exact aligned-binary
// shape od::fit_ephemeris_fb reads. Usage:
//   gen_oem_fixtures <out_dir> <iss_oem_kvn> [starlink_meme ...]
#include "od/meme_parser.h"

#include <cstdint>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

// macOS <math.h> SVID matherr macros collide with generated enum identifiers.
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

namespace {

std::string trim(const std::string& s) {
    auto a = s.find_first_not_of(" \t\r\n");
    auto b = s.find_last_not_of(" \t\r\n");
    return (a == std::string::npos) ? std::string() : s.substr(a, b - a + 1);
}

struct Line { std::string epoch; double x, y, z, vx, vy, vz; };

// frame_teme=false -> CelestialFrameWrapper{EME2000} (ISS). frame_teme=true ->
// CustomFrameWrapper{CustomFrame::TEME} — the reader's classify_frame maps the
// "TEME" token to FrameKind::Teme (no rotation; MEME is physically TEME).
std::vector<uint8_t> build_oem(const std::string& object_name, const std::string& object_id,
                               uint32_t norad, bool frame_teme, const std::string& center,
                               const std::vector<Line>& rows) {
    flatbuffers::FlatBufferBuilder fbb(1 << 18);
    std::vector<flatbuffers::Offset<ephemerisDataLine>> lines;
    lines.reserve(rows.size());
    for (const auto& r : rows) {
        auto epoch = fbb.CreateString(r.epoch);
        lines.push_back(CreateephemerisDataLine(fbb, epoch, r.x, r.y, r.z, r.vx, r.vy, r.vz));
    }
    auto lines_vec = fbb.CreateVector(lines);
    auto obj_name = fbb.CreateString(object_name);
    auto obj_id = fbb.CreateString(object_id);
    CATBuilder catb(fbb);
    catb.add_OBJECT_NAME(obj_name);
    catb.add_OBJECT_ID(obj_id);
    catb.add_NORAD_CAT_ID(norad);
    auto cat = catb.Finish();
    // Build the frame wrapper table BEFORE opening RFMBuilder (no nested tables).
    flatbuffers::Offset<void> frame_union;
    RFMUnion frame_union_type;
    if (frame_teme) {
        frame_union = CreateCustomFrameWrapper(fbb, CustomFrame::TEME).Union();
        frame_union_type = RFMUnion::CustomFrameWrapper;
    } else {
        frame_union = CreateCelestialFrameWrapper(fbb, CelestialFrame::EME2000).Union();
        frame_union_type = RFMUnion::CelestialFrameWrapper;
    }
    RFMBuilder rfmb(fbb);
    rfmb.add_REFERENCE_FRAME_type(frame_union_type);
    rfmb.add_REFERENCE_FRAME(frame_union);
    auto rfm = rfmb.Finish();
    auto center_s = fbb.CreateString(center);
    ephemerisDataBlockBuilder blk(fbb);
    blk.add_OBJECT(cat);
    blk.add_CENTER_NAME(center_s);
    blk.add_REFERENCE_FRAME(rfm);
    blk.add_TIME_SYSTEM(timingStandard::UTC);
    blk.add_STEP_SIZE(0.0);
    blk.add_EPHEMERIS_DATA_LINES(lines_vec);
    auto block = blk.Finish();
    std::vector<flatbuffers::Offset<ephemerisDataBlock>> blocks{block};
    auto blocks_vec = fbb.CreateVector(blocks);
    OEMBuilder oemb(fbb);
    oemb.add_EPHEMERIS_DATA_BLOCK(blocks_vec);
    FinishOEMBuffer(fbb, oemb.Finish());
    const uint8_t* p = fbb.GetBufferPointer();
    return std::vector<uint8_t>(p, p + fbb.GetSize());
}

// Tokenise an ISS-style OEM KVN into EME2000 rows (epoch as the original string).
bool load_kvn(const std::string& path, std::vector<Line>* rows, std::string* name, std::string* id) {
    std::ifstream f(path);
    if (!f) return false;
    std::string line; bool in_data = false;
    while (std::getline(f, line)) {
        std::string t = trim(line);
        if (t.empty() || t.rfind("COMMENT", 0) == 0) continue;
        if (t == "META_START") { in_data = false; continue; }
        if (t == "META_STOP") { in_data = true; continue; }
        if (!in_data) {
            auto eq = t.find('=');
            if (eq != std::string::npos) {
                std::string k = trim(t.substr(0, eq)), v = trim(t.substr(eq + 1));
                if (k == "OBJECT_NAME") *name = v; else if (k == "OBJECT_ID") *id = v;
            }
            continue;
        }
        if (t.find('=') != std::string::npos) continue;
        std::istringstream ls(t); Line rl{};
        if (ls >> rl.epoch >> rl.x >> rl.y >> rl.z >> rl.vx >> rl.vy >> rl.vz) rows->push_back(rl);
    }
    return !rows->empty();
}

bool write_file(const std::string& path, const std::vector<uint8_t>& b) {
    std::ofstream f(path, std::ios::binary);
    if (!f) return false;
    f.write(reinterpret_cast<const char*>(b.data()), static_cast<std::streamsize>(b.size()));
    return true;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 3) { std::fprintf(stderr, "usage: %s <out_dir> <iss_oem_kvn> [starlink_meme ...]\n", argv[0]); return 2; }
    std::string out = argv[1];
    int idx = 0;

    // Object 0: sacred ISS (EME2000).
    {
        std::vector<Line> rows; std::string name = "ISS", id = "1998-067-A";
        if (!load_kvn(argv[2], &rows, &name, &id)) { std::fprintf(stderr, "cannot load ISS KVN %s\n", argv[2]); return 1; }
        auto oem = build_oem(name, id, 25544, false, "EARTH", rows);
        std::string p = out + "/obj" + std::to_string(idx) + ".oem";
        if (!write_file(p, oem)) { std::fprintf(stderr, "write failed %s\n", p.c_str()); return 1; }
        std::printf("obj%d ISS EME2000 rows=%zu bytes=%zu -> %s\n", idx, rows.size(), oem.size(), p.c_str());
        idx++;
    }

    // Objects 1..: Starlink (TEMEOFDATE), from MEME.
    for (int i = 3; i < argc; ++i) {
        od::MEMEFile meme = od::parse_meme_file(argv[i]);
        std::fprintf(stderr, "MEME %s -> %zu points\n", argv[i], meme.points.size()); if (meme.points.empty()) { continue; }
        std::vector<Line> rows; rows.reserve(meme.points.size());
        for (const auto& pt : meme.points) {
            Line rl;
            rl.epoch = od::jd_to_iso_supgp(pt.epoch_jd);
            rl.x = pt.x; rl.y = pt.y; rl.z = pt.z; rl.vx = pt.vx; rl.vy = pt.vy; rl.vz = pt.vz;
            rows.push_back(rl);
        }
        std::string name = meme.header.object_name.empty() ? ("STARLINK-" + std::to_string(meme.header.norad_cat_id)) : meme.header.object_name;
        auto oem = build_oem(name, meme.header.cospar_id, static_cast<uint32_t>(meme.header.norad_cat_id),
                             true, "EARTH", rows);
        std::string p = out + "/obj" + std::to_string(idx) + ".oem";
        if (!write_file(p, oem)) { std::fprintf(stderr, "write failed %s\n", p.c_str()); return 1; }
        std::printf("obj%d %s TEMEOFDATE rows=%zu bytes=%zu -> %s\n", idx, name.c_str(), rows.size(), oem.size(), p.c_str());
        idx++;
    }
    std::printf("generated %d $OEM fixtures in %s\n", idx, out.c_str());
    return 0;
}
