/*
 * make_containers.cpp — writes the four-container fixture set.
 *
 * ONE trajectory, four files, all describing the same states: a CCSDS OEM in
 * keyword-value notation, an SPK type-13 kernel, a Code-500 binary ephemeris and
 * an STK .e. That set is the fixture the acceptance needs and no published
 * corpus provides — see fixtures/PROVENANCE.md for why synthetic is the right
 * answer here rather than a compromise.
 *
 * It VERIFIES what it wrote before it exits. A generator that emits four files
 * and does not read them back is a generator that can ship a fixture nothing can
 * load, and the suite that finds out is the one that was supposed to be
 * measuring something else.
 *
 * Build and run:
 *   clang++ -std=c++17 -O2 -I ../../files/orbit-products/src \
 *       tests/make_containers.cpp -o /tmp/make_containers
 *   /tmp/make_containers fixtures
 */

#include "fixture_arc.hpp"

#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

namespace {

int failures = 0;

bool write_file(const std::string& path, const void* bytes, size_t len) {
    std::ofstream out(path.c_str(), std::ios::binary | std::ios::trunc);
    if (!out) return false;
    out.write(static_cast<const char*>(bytes), static_cast<std::streamsize>(len));
    return static_cast<bool>(out);
}

bool read_file(const std::string& path, std::string* out) {
    std::ifstream in(path.c_str(), std::ios::binary);
    if (!in) return false;
    out->assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
    return true;
}

/* Reads the file back through the SAME door the module uses, with the format
 * left AUTO. An explicit discriminator would prove only that our writer and our
 * reader agree; AUTO also proves the container identifies itself, which is what
 * a consumer that fetched a file without a MIME type actually has. */
void verify(const std::string& path, const char* label, size_t expect_rows) {
    std::string bytes;
    if (!read_file(path, &bytes)) {
        std::printf("FAIL %-10s could not be read back from %s\n", label, path.c_str());
        ++failures;
        return;
    }
    std::vector<ephem::Series> series;
    const ephem::Status st = ephem::load_container(
        reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size(), ephem::Format::Auto,
        &series);
    if (st != ephem::Status::Ok) {
        std::printf("FAIL %-10s AUTO load returned %s\n", label, ephem::status_name(st));
        ++failures;
        return;
    }
    if (series.size() != 1 || series[0].rows.size() != expect_rows) {
        std::printf("FAIL %-10s loaded %zu series / %zu rows, wanted 1 / %zu\n", label,
                    series.size(), series.empty() ? 0u : series[0].rows.size(), expect_rows);
        ++failures;
        return;
    }
    std::printf("OK   %-10s %8zu bytes  %3zu rows  frame=%-6s centre=%-6s scale=%-4s\n", label,
                bytes.size(), series[0].rows.size(),
                series[0].frame_name.empty() ? "-" : series[0].frame_name.c_str(),
                series[0].center_name.empty() ? "-" : series[0].center_name.c_str(),
                series[0].time_system.empty() ? "-" : series[0].time_system.c_str());
}

}  // namespace

int main(int argc, char** argv) {
    const std::string dir = argc > 1 ? argv[1] : ".";

    /* The arc epoch is asserted against the calendar rather than trusted: a
     * transcribed constant that is one day out moves every epoch in all four
     * files by the same amount, which no differential check can see. */
    const double epoch_from_calendar = code500::seconds_past_j2000(2026, 1, 1, 0.0);
    if (epoch_from_calendar != arc::kEpochSecPastJ2000) {
        std::printf("FAIL arc epoch constant is %.1f, calendar says %.1f\n",
                    arc::kEpochSecPastJ2000, epoch_from_calendar);
        return 1;
    }

    const ephem::Series master = arc::master_series();
    std::printf("arc: a=%.1f km e=%.4f i=%.2f deg  mu=%.7f km^3/s^2  T=%.3f s\n",
                arc::kSemiMajorAxisKm, arc::kEccentricity, arc::kInclinationDeg,
                arc::kMuEarthKm3S2, arc::period_sec());
    std::printf("     %zu nodes at %.1f s from %s (%.1f s past J2000), span %.1f s = %.3f rev\n\n",
                master.rows.size(), arc::kStepSec, arc::kEpochIso, arc::kEpochSecPastJ2000,
                master.rows.back().epoch - master.rows.front().epoch,
                (master.rows.back().epoch - master.rows.front().epoch) / arc::period_sec());

    /* --- CCSDS OEM ------------------------------------------------------ */
    const std::string oem = arc::emit_oem(master);
    if (oem.empty()) {
        std::printf("FAIL the OEM document did not serialize\n");
        return 1;
    }
    if (!write_file(dir + "/ephemeris.oem", oem.data(), oem.size())) return 1;

    /* --- SPK type 13 ---------------------------------------------------- */
    std::vector<uint8_t> bsp;
    if (arc::emit_spk(master, &bsp) != ephem::Status::Ok) {
        std::printf("FAIL the SPK writer refused the arc\n");
        return 1;
    }
    if (!write_file(dir + "/ephemeris.bsp", bsp.data(), bsp.size())) return 1;

    /* --- Code-500 ------------------------------------------------------- */
    std::vector<uint8_t> c500;
    const ephem::Series c500_series = arc::shifted(master, arc::code500_origin_sec());
    if (arc::emit_code500(c500_series, &c500) != ephem::Status::Ok) {
        std::printf("FAIL the Code-500 writer refused the arc\n");
        return 1;
    }
    if (!write_file(dir + "/ephemeris.code500", c500.data(), c500.size())) return 1;

    /* --- STK .e --------------------------------------------------------- */
    ephem::Series stk_series = arc::shifted(master, arc::stk_origin_sec());
    stk_series.epoch_zero_iso = arc::kEpochIso;
    std::string stk;
    if (arc::emit_stk(stk_series, &stk) != ephem::Status::Ok) {
        std::printf("FAIL the STK writer refused the arc\n");
        return 1;
    }
    if (!write_file(dir + "/ephemeris.e", stk.data(), stk.size())) return 1;

    verify(dir + "/ephemeris.oem", "oem", arc::kNodeCount);
    verify(dir + "/ephemeris.bsp", "spk", arc::kNodeCount);
    verify(dir + "/ephemeris.code500", "code500", arc::kNodeCount);
    verify(dir + "/ephemeris.e", "stk", arc::kNodeCount);

    std::printf("\n%d write-back failures\n", failures);
    return failures == 0 ? 0 : 1;
}
