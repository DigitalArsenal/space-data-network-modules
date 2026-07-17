/**
 * SACRED parity gate (SDN OD-Flow Phase 1a):
 *
 *   Fitting an SDS $OEM FlatBuffer (built from the checked-in ISS ephemeris
 *   fixture) MUST match the KVN text path bit-for-bit — the same TEME state
 *   series, the same RMS, and every mean element identical.
 *
 * This exercises the new $OEM FlatBuffer reader (od::read_oem_flatbuffer) feeding
 * the SAME fit core (od::fit_sgp4_series) the KVN parser feeds. Because the reader
 * mirrors parse_oem sample-for-sample (frame classification, time-system->UTC,
 * TEME rotation) and FlatBuffers stores/returns IEEE-754 doubles exactly, the two
 * state series are byte-identical and the fit is therefore byte-identical.
 *
 * It also exercises the full FlatBuffer entry (od::fit_ephemeris_fb): $OEM in ->
 * fit -> $OMM out, verifying the emitted $OMM FlatBuffer (ORIGINATOR="SDN-OD").
 *
 * Exit 0 on parity; non-zero (with a diagnostic) on any mismatch.
 */

#include "od/oem_fb_reader.h"
#include "od/oem_parser.h"
#include "od/omm_fb_builder.h"
#include "od/plugin_runtime.h"
#include "od/sgp4_fitter.h"
#include "od/state_series.h"

#include <cstdint>
#include <cstdio>
#include <cstring>
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
#include "OMM_generated.h"

namespace {

std::string trim(const std::string& s) {
    auto a = s.find_first_not_of(" \t\r\n");
    auto b = s.find_last_not_of(" \t\r\n");
    return (a == std::string::npos) ? std::string() : s.substr(a, b - a + 1);
}

struct RawLine {
    std::string epoch;
    double x, y, z, vx, vy, vz;
};

// Tokenise the KVN fixture into its RAW (pre-TEME) EME2000 states + META, so the
// $OEM FlatBuffer we build carries EXACTLY the numbers the KVN text carried.
struct RawOEM {
    std::string object_name, object_id, center_name, ref_frame, time_system;
    std::vector<RawLine> lines;
};

bool load_raw(const std::string& path, RawOEM* out) {
    std::ifstream f(path);
    if (!f) return false;
    std::stringstream ss;
    ss << f.rdbuf();
    std::string content = ss.str();

    std::istringstream stream(content);
    std::string line;
    bool in_meta = false, in_data = false;
    while (std::getline(stream, line)) {
        std::string t = trim(line);
        if (t.empty() || t.rfind("COMMENT", 0) == 0) continue;
        if (t == "META_START") { in_meta = true; in_data = false; continue; }
        if (t == "META_STOP") { in_meta = false; in_data = true; continue; }
        if (in_meta) {
            auto eq = t.find('=');
            if (eq == std::string::npos) continue;
            std::string k = trim(t.substr(0, eq));
            std::string v = trim(t.substr(eq + 1));
            if (k == "OBJECT_NAME") out->object_name = v;
            else if (k == "OBJECT_ID") out->object_id = v;
            else if (k == "CENTER_NAME") out->center_name = v;
            else if (k == "REF_FRAME") out->ref_frame = v;
            else if (k == "TIME_SYSTEM") out->time_system = v;
            continue;
        }
        if (in_data) {
            if (t.find('=') != std::string::npos) continue;
            std::istringstream ls(t);
            RawLine rl{};
            if (!(ls >> rl.epoch >> rl.x >> rl.y >> rl.z >> rl.vx >> rl.vy >> rl.vz))
                continue;  // not a full 7-token state line
            out->lines.push_back(rl);
        }
    }
    return !out->lines.empty();
}

// Build an SDS $OEM FlatBuffer (verbose, EME2000, explicit epoch per line) from
// the raw tokenised states. NOT size-prefixed (root table as GetOEM expects).
std::vector<uint8_t> build_oem_fb(const RawOEM& raw) {
    flatbuffers::FlatBufferBuilder fbb(1 << 16);

    std::vector<flatbuffers::Offset<ephemerisDataLine>> lines;
    lines.reserve(raw.lines.size());
    for (const auto& rl : raw.lines) {
        auto epoch = fbb.CreateString(rl.epoch);
        lines.push_back(CreateephemerisDataLine(fbb, epoch, rl.x, rl.y, rl.z,
                                                rl.vx, rl.vy, rl.vz));
    }
    auto lines_vec = fbb.CreateVector(lines);

    // Identity (CAT). NORAD is not in the fixture META; the runtime labels it via
    // options — leave 0 here (identity does not affect the numerical fit).
    auto obj_name = fbb.CreateString(raw.object_name);
    auto obj_id = fbb.CreateString(raw.object_id);
    CATBuilder catb(fbb);
    catb.add_OBJECT_NAME(obj_name);
    catb.add_OBJECT_ID(obj_id);
    catb.add_NORAD_CAT_ID(0);
    auto cat = catb.Finish();

    // REFERENCE_FRAME = RFM{ CelestialFrameWrapper{ EME2000 } }.
    auto cfw = CreateCelestialFrameWrapper(fbb, CelestialFrame::EME2000);
    RFMBuilder rfmb(fbb);
    rfmb.add_REFERENCE_FRAME_type(RFMUnion::CelestialFrameWrapper);
    rfmb.add_REFERENCE_FRAME(cfw.Union());
    auto rfm = rfmb.Finish();

    auto center = fbb.CreateString(raw.center_name);

    ephemerisDataBlockBuilder blk(fbb);
    blk.add_OBJECT(cat);
    blk.add_CENTER_NAME(center);
    blk.add_REFERENCE_FRAME(rfm);
    blk.add_TIME_SYSTEM(timingStandard::UTC);
    blk.add_STEP_SIZE(0.0);  // verbose form
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

bool bits_equal(double a, double b) {
    static_assert(sizeof(double) == sizeof(uint64_t), "double is 64-bit");
    uint64_t ua, ub;
    std::memcpy(&ua, &a, 8);
    std::memcpy(&ub, &b, 8);
    return ua == ub;
}

int fail(const char* msg) {
    std::fprintf(stderr, "PARITY FAIL: %s\n", msg);
    return 1;
}

}  // namespace

int main(int argc, char** argv) {
    const std::string fixture = (argc > 1) ? argv[1] : std::string(OD_ISS_FIXTURE);

    // ── Path A: KVN text parser -> fit ──────────────────────────────────────────
    std::ifstream f(fixture);
    if (!f) { std::fprintf(stderr, "cannot open fixture: %s\n", fixture.c_str()); return 2; }
    std::stringstream ss; ss << f.rdbuf();
    const std::string kvn = ss.str();

    od::OEMParseResult pa = od::parse_oem(kvn);
    if (!pa.ok) return fail(("KVN parse failed: " + pa.error_message).c_str());
    od::FitResult fitA = od::fit_sgp4_series(pa.series, {});

    // ── Path B: $OEM FlatBuffer reader -> fit ───────────────────────────────────
    RawOEM raw;
    if (!load_raw(fixture, &raw)) return fail("could not tokenise fixture");
    std::vector<uint8_t> oem_fb = build_oem_fb(raw);

    od::OEMParseResult pb = od::read_oem_flatbuffer(oem_fb.data(), oem_fb.size());
    if (!pb.ok) return fail(("$OEM FB read failed: " + pb.error_message).c_str());
    od::FitResult fitB = od::fit_sgp4_series(pb.series, {});

    // ── (1) State series must be byte-identical ─────────────────────────────────
    if (pa.series.samples.size() != pb.series.samples.size())
        return fail("sample count differs (KVN vs $OEM FB)");
    for (size_t i = 0; i < pa.series.samples.size(); ++i) {
        const auto& sa = pa.series.samples[i];
        const auto& sb = pb.series.samples[i];
        if (!bits_equal(sa.epoch_jd, sb.epoch_jd) ||
            !bits_equal(sa.x, sb.x) || !bits_equal(sa.y, sb.y) || !bits_equal(sa.z, sb.z) ||
            !bits_equal(sa.vx, sb.vx) || !bits_equal(sa.vy, sb.vy) || !bits_equal(sa.vz, sb.vz)) {
            std::fprintf(stderr, "sample %zu differs\n", i);
            return fail("TEME state series not bit-identical");
        }
    }

    // ── (2) Fit result must be byte-identical (the sacred gate) ─────────────────
    const auto& A = fitA.elements;
    const auto& B = fitB.elements;
    bool ok =
        bits_equal(A.rms_km, B.rms_km) &&
        bits_equal(A.mean_motion, B.mean_motion) &&
        bits_equal(A.eccentricity, B.eccentricity) &&
        bits_equal(A.inclination, B.inclination) &&
        bits_equal(A.ra_of_asc_node, B.ra_of_asc_node) &&
        bits_equal(A.arg_of_pericenter, B.arg_of_pericenter) &&
        bits_equal(A.mean_anomaly, B.mean_anomaly) &&
        bits_equal(A.bstar, B.bstar) &&
        bits_equal(A.mean_motion_dot, B.mean_motion_dot) &&
        bits_equal(A.mean_motion_ddot, B.mean_motion_ddot) &&
        (A.converged == B.converged) && (A.iterations == B.iterations);

    std::printf("KVN  path : RMS=%.9f km  n=%.9f  e=%.9f  i=%.6f  converged=%d iters=%d\n",
                A.rms_km, A.mean_motion, A.eccentricity, A.inclination, A.converged, A.iterations);
    std::printf("$OEM FB   : RMS=%.9f km  n=%.9f  e=%.9f  i=%.6f  converged=%d iters=%d\n",
                B.rms_km, B.mean_motion, B.eccentricity, B.inclination, B.converged, B.iterations);

    if (!ok) return fail("fit result not bit-identical between KVN and $OEM FB paths");

    // ── (3) Full FlatBuffer entry: $OEM in -> fit -> $OMM out ───────────────────
    const std::string opts =
        "{\"dataSource\":\"ISS-E\",\"objectName\":\"ISS\",\"objectId\":\"1998-067-A\",\"noradCatId\":25544}";
    od::PluginFitFBResult fb = od::fit_ephemeris_fb(oem_fb.data(), oem_fb.size(), opts);
    if (!fb.ok) return fail(("fit_ephemeris_fb failed: " + fb.error_message).c_str());
    if (!bits_equal(fb.rms_km, B.rms_km))
        return fail("fit_ephemeris_fb RMS != direct fit RMS");

    // Verify the emitted $OMM FlatBuffer (size-prefixed).
    if (!SizePrefixedOMMBufferHasIdentifier(fb.omm.data()))
        return fail("emitted $OMM missing file identifier");
    flatbuffers::Verifier ver(fb.omm.data(), fb.omm.size());
    if (!VerifySizePrefixedOMMBuffer(ver))
        return fail("emitted $OMM failed verification");
    const OMM* omm = GetSizePrefixedOMM(fb.omm.data());
    if (omm == nullptr) return fail("GetSizePrefixedOMM returned null");
    if (omm->ORIGINATOR() == nullptr || omm->ORIGINATOR()->str() != "SDN-OD")
        return fail("emitted $OMM ORIGINATOR != SDN-OD");
    if (omm->NORAD_CAT_ID() != 25544u)
        return fail("emitted $OMM NORAD_CAT_ID != 25544 (options labeling not applied)");
    if (!bits_equal(omm->MEAN_MOTION(), B.mean_motion))
        return fail("emitted $OMM MEAN_MOTION != fitted mean motion");

    std::printf("$OMM emit : %zu bytes, ORIGINATOR=%s NORAD=%u MEAN_MOTION=%.9f (VerifyOMMBuffer OK)\n",
                fb.omm.size(), omm->ORIGINATOR()->c_str(), omm->NORAD_CAT_ID(), omm->MEAN_MOTION());
    std::printf("PARITY PASS: KVN and $OEM-FlatBuffer fits are bit-for-bit identical.\n");
    return 0;
}
