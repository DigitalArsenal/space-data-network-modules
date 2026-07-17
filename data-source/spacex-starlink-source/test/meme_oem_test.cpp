// meme_oem_test.cpp — native test: real SpaceX MEME fixture -> parse_meme ->
// build_oem_fb -> assert a valid SDS $OEM with frame token "TEME", matching NORAD,
// START_TIME + STEP_SIZE. Proves the in-memory MEME->$OEM path (no network, no store).
//
// Compile + run (from repo root main-packages/):
//   clang++ -std=c++17 -Iflatbuffers/include -Ispace-data-network-modules/common \
//     -Ispace-data-network-modules/licensing/core/src/cpp/generated/sds \
//     -Ispace-data-network-modules/data-source/spacex-starlink-source/src \
//     space-data-network-modules/data-source/spacex-starlink-source/test/meme_oem_test.cpp -o /tmp/meme && \
//   for f in space-data-network-modules/data-source/spacex-starlink-source/test/fixtures/meme/*.txt; do /tmp/meme "$f"; done

#include "meme_oem.hpp"
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
int main(int argc, char** argv) {
    if (argc < 2) { std::printf("usage: %s <MEME file>\n", argv[0]); return 2; }
    std::string path = argv[1];
    std::ifstream f(path);
    std::stringstream ss; ss << f.rdbuf();
    std::string content = ss.str();
    std::string base = path.substr(path.find_last_of('/') + 1);
    meme_oem::MemeMeta m;
    meme_oem::parse_meme_filename(base, &m);
    std::vector<double> states;
    meme_oem::parse_meme(content, &m, &states);
    if (states.empty() || states.size() % 6 != 0) { std::printf("bad states: %zu\n", states.size()); return 1; }
    auto oem = meme_oem::build_oem_fb(m, states);
    ::flatbuffers::Verifier v(oem.data(), oem.size());
    bool ok = VerifyOEMBuffer(v) && OEMBufferHasIdentifier(oem.data());
    const OEM* rec = GetOEM(oem.data());
    const char* frame = "?"; const char* start = "?"; double step = -1; long nrd = -1;
    if (rec && rec->EPHEMERIS_DATA_BLOCK() && rec->EPHEMERIS_DATA_BLOCK()->size() > 0) {
        auto blk = rec->EPHEMERIS_DATA_BLOCK()->Get(0);
        if (blk->REFERENCE_FRAME() && blk->REFERENCE_FRAME()->REFERENCE_FRAME_as_CustomFrameWrapper())
            frame = EnumNameCustomFrame(blk->REFERENCE_FRAME()->REFERENCE_FRAME_as_CustomFrameWrapper()->frame());
        if (blk->START_TIME()) start = blk->START_TIME()->c_str();
        step = blk->STEP_SIZE();
        if (blk->OBJECT()) nrd = blk->OBJECT()->NORAD_CAT_ID();
    }
    std::printf("NORAD=%ld name=%s states=%zu oem=%zuB valid=%d frame=%s start=%s step=%.0f\n",
                m.norad_cat_id, m.object_name.c_str(), states.size()/6, oem.size(), ok?1:0, frame, start, step);
    return (ok && std::strcmp(frame,"TEME")==0 && nrd==m.norad_cat_id && m.norad_cat_id>0 && states.size()>=6*10) ? 0 : 1;
}
