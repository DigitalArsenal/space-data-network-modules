/*
 * ephemeris_propagator_native.cpp — the ephemeris-source propagator's acceptance,
 * measured on the headers it is compiled from.
 *
 * Five families of number, each with a named authority:
 *
 *   sources.agree            four containers of ONE trajectory against each
 *                            other at the record nodes. Self-authoritative and
 *                            the strongest statement available about a format
 *                            seam: the arc is identical by construction, so any
 *                            disagreement is a reader or a writer, never physics.
 *   epoch.map / propagate    the Julian-date -> container-epoch map, which is
 *                            the one piece of arithmetic the propagator ABI adds
 *                            on top of reading a file.
 *   interp.order             Hermite against Lagrange at the same node count,
 *                            both against the CLOSED-FORM two-body state at an
 *                            interior epoch. Analytic truth is what makes this a
 *                            measurement rather than two interpolants agreeing.
 *   interp.degree            the same truth, walking Lagrange degree.
 *   roundtrip                writer -> reader for each container, against the
 *                            arc the writer was handed.
 *
 * Build and run:
 *   clang++ -std=c++17 -O2 -I ../../files/orbit-products/src \
 *       tests/ephemeris_propagator_native.cpp -o /tmp/ephem_accept
 *   /tmp/ephem_accept fixtures
 */

#include "fixture_arc.hpp"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace {

int checks = 0;
int failures = 0;

/// One acceptance line: `value` is measured, `bound` is the limit it must not
/// exceed. Both are printed so a regression moves a number rather than flipping
/// a word.
void report(const char* name, double value, double bound) {
    ++checks;
    const bool ok = std::isfinite(value) && value <= bound;
    if (!ok) ++failures;
    std::printf("RESULT %-44s %14.6e %12.4e %s\n", name, value, bound, ok ? "PASS" : "FAIL");
}

void report_count(const char* name, long value, long bound) {
    ++checks;
    const bool ok = value <= bound;
    if (!ok) ++failures;
    std::printf("RESULT %-44s %14ld %12ld %s\n", name, value, bound, ok ? "PASS" : "FAIL");
}

/// A measured quantity that is REPORTED rather than bounded — the two
/// interpolation errors whose ORDERING is the assertion, and the per-degree
/// error curve. Printed on its own line shape so nothing reads as an
/// unenforced RESULT.
void value_line(const char* name, double value) {
    std::printf("VALUE  %-44s %14.6e\n", name, value);
}

void note(const char* name, const char* text) {
    std::printf("NOTE   %-44s %s\n", name, text);
}

double rel_vec(const double a[3], const double b[3]) {
    double num = 0.0, den = 0.0;
    for (int c = 0; c < 3; ++c) {
        const double d = a[c] - b[c];
        num += d * d;
        den += b[c] * b[c];
    }
    num = std::sqrt(num);
    den = std::sqrt(den);
    return den > 0.0 ? num / den : num;
}

double norm_diff(const double a[3], const double b[3]) {
    double num = 0.0;
    for (int c = 0; c < 3; ++c) {
        const double d = a[c] - b[c];
        num += d * d;
    }
    return std::sqrt(num);
}

bool read_file(const std::string& path, std::string* out) {
    std::ifstream in(path.c_str(), std::ios::binary);
    if (!in) return false;
    out->assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
    return true;
}

/*
 * The module's Julian-date -> container-epoch map and its inverse, transcribed
 * from src/ephemeris_propagator_module.cpp. It is one line in an anonymous
 * namespace inside a translation unit that only the WASM toolchain can compile,
 * so it cannot be included here — but it is not invented either: the formula is
 * the one Series::epoch_zero_offset_sec's own doc comment fixes normatively, and
 * tests/module_abi.test.mjs measures the REAL export against these same fixtures
 * so the transcription cannot drift silently.
 */
double container_epoch(const ephem::Series& s, double julian_date) {
    return (julian_date - 2451545.0) * 86400.0 - s.epoch_zero_offset_sec;
}

double julian_from_container(const ephem::Series& s, double t) {
    return 2451545.0 + (t + s.epoch_zero_offset_sec) / 86400.0;
}

/*
 * One ulp of a Julian date at this arc's epoch, expressed in seconds. JD 2461041
 * lies in [2^21, 2^22), so a double resolves it to 2^-31 days — 40 microseconds.
 * That is a property of carrying an absolute epoch as ONE double, not of this
 * module, and it is the honest bound on any round trip through a Julian date
 * whose target is not already on that grid.
 */
constexpr double kJulianDateUlpSec = 86400.0 / 2147483648.0;

/*
 * Round-off floor for an interpolated ordinate: unit round-off on a 7000 km
 * position, times the widest window the degree sweep assembles (10 nodes), times
 * four for the accumulation. Stated BEFORE the measurement, because a floor
 * fitted to the numbers afterwards is not a floor.
 */
constexpr double kInterpRoundoffFloorKm = 4.0 * 2.220446049250313e-16 * 7000.0 * 10.0;

struct Loaded {
    const char* label;
    const char* file;
    ephem::Format format;
    ephem::Series series;
};

}  // namespace

int main(int argc, char** argv) {
    const std::string dir = argc > 1 ? argv[1] : "fixtures";

    Loaded loaded[4] = {
        {"oem", "ephemeris.oem", ephem::Format::CcsdsOemKvn, {}},
        {"spk", "ephemeris.bsp", ephem::Format::SpkDaf, {}},
        {"code500", "ephemeris.code500", ephem::Format::Code500, {}},
        {"stk", "ephemeris.e", ephem::Format::StkEphemeris, {}},
    };

    for (Loaded& l : loaded) {
        std::string bytes;
        if (!read_file(dir + "/" + l.file, &bytes)) {
            std::printf("PROVISION missing fixture %s/%s\n", dir.c_str(), l.file);
            return 2;
        }
        std::vector<ephem::Series> series;
        const ephem::Status st =
            ephem::load_container(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size(),
                                  l.format, &series);
        if (st != ephem::Status::Ok || series.size() != 1) {
            std::printf("PROVISION %s did not load: %s (%zu series)\n", l.file,
                        ephem::status_name(st), series.size());
            return 2;
        }
        l.series = series[0];
    }

    const ephem::Series master = arc::master_series();

    /* -------------------------------------------------------------------- */
    /* 1. Four containers, one trajectory                                    */
    /* -------------------------------------------------------------------- */

    {
        long shape = 0;
        for (const Loaded& l : loaded) {
            if (l.series.rows.size() != arc::kNodeCount) ++shape;
        }
        report_count("sources.agree.node-count", shape, 0);

        double worst = 0.0;
        std::string worst_pair = "none";
        for (int a = 0; a < 4; ++a) {
            for (int b = a + 1; b < 4; ++b) {
                const std::vector<ephem::StateRow>& ra = loaded[a].series.rows;
                const std::vector<ephem::StateRow>& rb = loaded[b].series.rows;
                const size_t n = ra.size() < rb.size() ? ra.size() : rb.size();
                double pair_worst = 0.0;
                for (size_t i = 0; i < n; ++i) {
                    const double d = norm_diff(ra[i].pos, rb[i].pos);
                    if (d > pair_worst) pair_worst = d;
                }
                if (pair_worst > worst) {
                    worst = pair_worst;
                    worst_pair = std::string(loaded[a].label) + "/" + loaded[b].label;
                }
            }
        }
        /* Kilometres, not relative: the acceptance is that four descriptions of
         * one trajectory land on the same point, and a metre is a metre whether
         * the object is at 7000 km or at the Moon. */
        report("sources.agree.nodes", worst, 1e-9);
        note("sources.agree.nodes.worst-pair", worst_pair.c_str());

        /*
         * And the same nodes must be at the same INSTANT. Comparing states row
         * by row cannot see a container whose epoch axis is displaced — every
         * position still matches, and the file is still wrong. This check is
         * here because that is exactly what happened: the $OEM projection's
         * date formatter renders every epoch 305 days early, which four
         * agreeing state vectors hid completely.
         *
         * The bound is the Code-500 container's own resolution: it stores each
         * 50-state record's base time in DUT (hundredths of a day), so a 60 s
         * grid is not exactly representable across a record boundary and the
         * read-back epochs wobble by a fraction of a microsecond. Every other
         * container is exact.
         */
        double epoch_worst = 0.0;
        std::string epoch_pair = "none";
        for (int a = 0; a < 4; ++a) {
            for (int b = a + 1; b < 4; ++b) {
                const ephem::Series& sa = loaded[a].series;
                const ephem::Series& sb = loaded[b].series;
                const size_t n = sa.rows.size() < sb.rows.size() ? sa.rows.size() : sb.rows.size();
                for (size_t i = 0; i < n; ++i) {
                    const double ta = sa.rows[i].epoch + sa.epoch_zero_offset_sec;
                    const double tb = sb.rows[i].epoch + sb.epoch_zero_offset_sec;
                    const double d = std::fabs(ta - tb);
                    if (d > epoch_worst) {
                        epoch_worst = d;
                        epoch_pair = std::string(loaded[a].label) + "/" + loaded[b].label;
                    }
                }
            }
        }
        report("sources.agree.epochs.sec", epoch_worst, 1e-6);
        note("sources.agree.epochs.worst-pair", epoch_pair.c_str());

        /* The absolute epoch, not just a consensus: all four could agree on a
         * displaced axis. Measured against the arc the generator declares. */
        double absolute = 0.0;
        for (const Loaded& l : loaded) {
            for (size_t i = 0; i < l.series.rows.size() && i < master.rows.size(); ++i) {
                const double d = std::fabs(l.series.rows[i].epoch + l.series.epoch_zero_offset_sec -
                                           master.rows[i].epoch);
                if (d > absolute) absolute = d;
            }
        }
        report("sources.agree.epochs.absolute.sec", absolute, 1e-6);
    }

    /* -------------------------------------------------------------------- */
    /* 2. The Julian-date -> container-epoch map                             */
    /* -------------------------------------------------------------------- */

    /*
     * The sample epochs are multiples of 1/1024 day past the arc epoch, which is
     * on the grid a double Julian date resolves EXACTLY at this epoch. That is
     * the only set on which "the map loses nothing" is a statement about the map
     * rather than about the width of a double, and it is chosen for that reason
     * — the cost of the choice is measured immediately afterwards, at the record
     * nodes, which are NOT on that grid.
     */
    {
        double quantum = 0.0;
        for (const Loaded& l : loaded) {
            double worst_epoch = 0.0;
            double worst_state = 0.0;
            for (int k = 0; k <= 85; ++k) {
                const double t_j2000 =
                    arc::kEpochSecPastJ2000 + static_cast<double>(k) * (86400.0 / 1024.0);
                const double t = t_j2000 - l.series.epoch_zero_offset_sec;

                const double jd = julian_from_container(l.series, t);
                const double t_back = container_epoch(l.series, jd);
                const double dt = std::fabs(t_back - t);
                if (dt > worst_epoch) worst_epoch = dt;

                ephem::StateRow direct, through_jd;
                if (ephem::evaluate(l.series, t, &direct) != ephem::Status::Ok) continue;
                if (ephem::evaluate(l.series, t_back, &through_jd) != ephem::Status::Ok) continue;
                const double e = rel_vec(through_jd.pos, direct.pos) >
                                         rel_vec(through_jd.vel, direct.vel)
                                     ? rel_vec(through_jd.pos, direct.pos)
                                     : rel_vec(through_jd.vel, direct.vel);
                if (e > worst_state) worst_state = e;
            }
            std::string a = std::string("epoch.map.exact.") + l.label;
            std::string b = std::string("propagate.vs.interpolate.") + l.label;
            report(a.c_str(), worst_epoch, 0.0);
            report(b.c_str(), worst_state, 1e-12);

            /* The same map at the RECORD nodes, which sit on a 60 s grid and so
             * are not representable as a Julian date. Reported rather than
             * hidden: this is the resolution floor every consumer of this ABI
             * inherits, and the assertion is that the module adds nothing to it. */
            for (const ephem::StateRow& r : l.series.rows) {
                const double back = container_epoch(l.series, julian_from_container(l.series, r.epoch));
                const double dt = std::fabs(back - r.epoch);
                if (dt > quantum) quantum = dt;
            }
        }
        report("epoch.map.jd.quantum.sec", quantum, kJulianDateUlpSec);
    }

    /* -------------------------------------------------------------------- */
    /* 3 & 4. Interpolation against the closed-form arc                      */
    /* -------------------------------------------------------------------- */

    /*
     * Measured on the OEM-loaded series because its epochs are absolute on the
     * same axis the analytic generator uses, so the truth is evaluated at the
     * epoch the interpolant was asked for with no shift in between.
     *
     * Interior epochs only, midway between nodes: at a node every scheme returns
     * the stored state and the comparison measures nothing. Indices 6..113 keep a
     * 10-node window inside the array, so the degree sweep below compares the
     * same epochs at every degree instead of drifting toward the ends where an
     * equispaced Lagrange window misbehaves for reasons that are not the degree.
     */
    const ephem::Series& base = loaded[0].series;
    ephem::Series lagrange = base;
    lagrange.interp = ephem::Interp::Lagrange;
    ephem::Series hermite = base;
    hermite.interp = ephem::Interp::Hermite;

    {
        double lag_worst = 0.0, her_worst = 0.0;
        for (size_t i = 6; i + 8 < base.rows.size(); ++i) {
            const double t = 0.5 * (base.rows[i].epoch + base.rows[i + 1].epoch);
            double truth_pos[3], truth_vel[3];
            arc::state_at(t - arc::kEpochSecPastJ2000, truth_pos, truth_vel);

            /* Same NODE COUNT on both sides: Lagrange over 4 nodes is degree 3,
             * Hermite over 4 nodes reaches degree 7 because it also consumes the
             * velocities. That is the comparison the claim is about — the same
             * data, one scheme using more of it. */
            ephem::StateRow l_row, h_row;
            if (ephem::evaluate(lagrange, t, &l_row, 3) != ephem::Status::Ok) continue;
            if (ephem::evaluate(hermite, t, &h_row, 7) != ephem::Status::Ok) continue;

            const double le = norm_diff(l_row.pos, truth_pos);
            const double he = norm_diff(h_row.pos, truth_pos);
            if (le > lag_worst) lag_worst = le;
            if (he > her_worst) her_worst = he;
        }
        value_line("interp.order.lagrange.deg3.nodes4.err.km", lag_worst);
        value_line("interp.order.hermite.deg7.nodes4.err.km", her_worst);
        /* Below 1 means Hermite wins, which is the predicted direction. A value
         * at or above 1 is a real result and is printed as a FAIL, not tuned
         * away. */
        report("interp.order.ordering", lag_worst > 0.0 ? her_worst / lag_worst : her_worst, 1.0);
    }

    {
        const int degrees[5] = {1, 3, 5, 7, 9};
        double err[5] = {0.0, 0.0, 0.0, 0.0, 0.0};
        for (int d = 0; d < 5; ++d) {
            double worst = 0.0;
            for (size_t i = 6; i + 8 < base.rows.size(); ++i) {
                const double t = 0.5 * (base.rows[i].epoch + base.rows[i + 1].epoch);
                double truth_pos[3], truth_vel[3];
                arc::state_at(t - arc::kEpochSecPastJ2000, truth_pos, truth_vel);
                ephem::StateRow row;
                if (ephem::evaluate(lagrange, t, &row, degrees[d]) != ephem::Status::Ok) continue;
                const double e = norm_diff(row.pos, truth_pos);
                if (e > worst) worst = e;
            }
            err[d] = worst;
            char name[64];
            std::snprintf(name, sizeof(name), "interp.degree.lagrange.d%d.err.km", degrees[d]);
            value_line(name, worst);
        }
        /* "Reduces, up to the point where it stops": a step counts as improving
         * if the error fell, OR if it has already reached the round-off floor
         * declared above, where there is nothing left to improve. */
        long stalled = 0;
        int stops_at = 0;
        for (int d = 1; d < 5; ++d) {
            const bool improved = err[d] < err[d - 1];
            const bool at_floor = err[d] <= kInterpRoundoffFloorKm;
            if (!improved && !at_floor) ++stalled;
            if (!improved && stops_at == 0) stops_at = degrees[d];
        }
        report_count("interp.degree.monotone", stalled, 0);
        char text[96];
        if (stops_at == 0) {
            std::snprintf(text, sizeof(text),
                          "still improving at degree 9; round-off floor %.2e km",
                          kInterpRoundoffFloorKm);
        } else {
            std::snprintf(text, sizeof(text), "improvement stops at degree %d; floor %.2e km",
                          stops_at, kInterpRoundoffFloorKm);
        }
        note("interp.degree.stop", text);
    }

    /* -------------------------------------------------------------------- */
    /* 5. Writer -> reader round trips                                       */
    /* -------------------------------------------------------------------- */

    /*
     * Each writer is handed the analytic arc, and the bytes it produces are read
     * back and compared with that arc — not with the committed fixture, so a
     * stale fixture cannot mask a broken writer. Whether the bytes ARE the
     * committed fixture is asked separately, immediately after.
     */
    {
        struct Trip {
            const char* label;
            std::string bytes;
            ephem::Format format;
            const char* file;
        };
        std::vector<Trip> trips;

        trips.push_back({"oem", arc::emit_oem(master), ephem::Format::CcsdsOemKvn,
                         "ephemeris.oem"});

        std::vector<uint8_t> bsp;
        if (arc::emit_spk(master, &bsp) != ephem::Status::Ok) {
            std::printf("PROVISION the SPK writer refused the arc\n");
            return 2;
        }
        trips.push_back({"spk", std::string(bsp.begin(), bsp.end()), ephem::Format::SpkDaf,
                         "ephemeris.bsp"});

        std::vector<uint8_t> c500;
        if (arc::emit_code500(arc::shifted(master, arc::code500_origin_sec()), &c500) !=
            ephem::Status::Ok) {
            std::printf("PROVISION the Code-500 writer refused the arc\n");
            return 2;
        }
        trips.push_back({"code500", std::string(c500.begin(), c500.end()), ephem::Format::Code500,
                         "ephemeris.code500"});

        ephem::Series stk_series = arc::shifted(master, arc::stk_origin_sec());
        stk_series.epoch_zero_iso = arc::kEpochIso;
        std::string stk;
        if (arc::emit_stk(stk_series, &stk) != ephem::Status::Ok) {
            std::printf("PROVISION the STK writer refused the arc\n");
            return 2;
        }
        trips.push_back({"stk", stk, ephem::Format::StkEphemeris, "ephemeris.e"});

        for (const Trip& t : trips) {
            std::vector<ephem::Series> back;
            const ephem::Status st = ephem::load_container(
                reinterpret_cast<const uint8_t*>(t.bytes.data()), t.bytes.size(), t.format, &back);
            std::string name = std::string("roundtrip.") + t.label;
            if (st != ephem::Status::Ok || back.size() != 1 ||
                back[0].rows.size() != master.rows.size()) {
                report(name.c_str(), 1.0, 1e-9);
                continue;
            }
            double worst = 0.0;
            for (size_t i = 0; i < master.rows.size(); ++i) {
                const double p = rel_vec(back[0].rows[i].pos, master.rows[i].pos);
                const double v = rel_vec(back[0].rows[i].vel, master.rows[i].vel);
                if (p > worst) worst = p;
                if (v > worst) worst = v;
            }
            report(name.c_str(), worst, 1e-9);

            /* The committed fixture must be exactly what this generator emits.
             * Otherwise every number above describes a file nobody can
             * regenerate, which is the state a PROVENANCE file exists to
             * prevent. */
            std::string committed;
            std::string reproducible = std::string("fixtures.reproducible.") + t.label;
            if (!read_file(dir + "/" + t.file, &committed)) {
                report_count(reproducible.c_str(), 1, 0);
            } else {
                report_count(reproducible.c_str(), committed == t.bytes ? 0 : 1, 0);
            }
        }
    }

    std::printf("\n%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
