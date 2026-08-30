/*
 * data-source/spk-source/tests — the arc the four fixtures carry, and the four
 * emissions of it.
 *
 * ONE GENERATOR, TWO CONSUMERS. make_containers.cpp writes the fixtures with
 * it; ephemeris_propagator_native.cpp measures against it. A second copy of the
 * Kepler solve would let the files and the truth they are graded on drift while
 * every printed line still said PASS — which is the failure mode a synthetic
 * fixture exists to rule out, not to introduce.
 *
 * WHY TWO-BODY AND NOT A FORCE MODEL. The acceptance asks two questions a
 * numerical trajectory cannot answer: whether an interpolant's error at an
 * INTERIOR epoch shrinks with degree, and whether Hermite beats Lagrange there.
 * Both need the value between the nodes to be known independently of the
 * interpolant, which means known in closed form. A propagated arc only knows
 * its own samples, so measuring an interpolant against it measures the
 * integrator's dense output — a different question with a different answer.
 *
 * TIME. Epochs are seconds past the J2000 epoch on the container's own declared
 * scale, and nothing here converts between scales — see the spine's rule in
 * ephemeris_series.hpp. The four containers therefore tabulate ONE epoch axis,
 * labelled UTC by the three that carry a TIME_SYSTEM and ET/TDB by the SPK
 * because a DAF fixes that label. No leap second is applied, assumed, or needed:
 * every acceptance number below is differential.
 */

#ifndef SPK_SOURCE_TESTS_FIXTURE_ARC_HPP
#define SPK_SOURCE_TESTS_FIXTURE_ARC_HPP

#include <cmath>
#include <cstddef>
#include <cstdio>
#include <string>
#include <vector>

#include "code500.hpp"
#include "containers.hpp"
#include "ephemeris_series.hpp"
#include "oem_projection.hpp"
#include "spk_write.hpp"
#include "stk_ephemeris.hpp"

#include "../../../files/ccsds-messages/src/kvn.hpp"

namespace arc {

/* ------------------------------------------------------------------------ */
/* The trajectory                                                            */
/* ------------------------------------------------------------------------ */

constexpr double kPi = 3.14159265358979323846;

/*
 * WGS-84 / EGM-96 Earth gravitational parameter, km^3 s^-2. Stated rather than
 * rounded: the interior truth this header computes is exact only for the mu the
 * nodes were generated with, so a reader who wants to reproduce a fixture needs
 * this number and not "GM for Earth".
 */
constexpr double kMuEarthKm3S2 = 398600.4418;

constexpr double kSemiMajorAxisKm = 7000.0;
constexpr double kEccentricity = 0.001;
constexpr double kInclinationDeg = 51.6;
constexpr double kRaanDeg = 40.0;
constexpr double kArgPerigeeDeg = 30.0;
constexpr double kMeanAnomalyAtEpochDeg = 0.0;

/* 60 s over 7200 s is 121 nodes across 1.235 revolutions: uniform, so the
 * compact Code-500 and SPK type-13 layouts are legal, and long enough that a
 * 7th-degree window sits well inside the array at every interior epoch the
 * acceptance samples. */
constexpr double kStepSec = 60.0;
constexpr size_t kNodeCount = 121;

/* 2026-01-01T00:00:00 as seconds past the J2000 epoch. Asserted against the
 * calendar in make_containers rather than trusted. */
constexpr double kEpochSecPastJ2000 = 820497600.0;
constexpr const char* kEpochIso = "2026-01-01T00:00:00";

/* SPK is a binary container with no room for a name, so identity travels as
 * NAIF integers. -999999 is outside every assigned spacecraft range: a fixture
 * must not claim a real object's id. */
constexpr int32_t kNaifTarget = -999999;
constexpr int32_t kNaifCenter = 399;
constexpr int32_t kNaifFrameJ2000 = 1;

/* The rule the containers DECLARE, and the one every reader must resolve back
 * to: Hermite over a 4-node window, which is polynomial degree 7. SPK type 13
 * stores window-1, an OEM and an STK file store the degree, and Code-500 stores
 * nothing at all and falls back to the spine's rule for a series that carries
 * velocities — which is this same one. */
constexpr int kInterpDegree = 7;

inline double period_sec() {
    const double a = kSemiMajorAxisKm;
    return 2.0 * kPi * std::sqrt(a * a * a / kMuEarthKm3S2);
}

/*
 * Newton on Kepler's equation, run to a residual rather than to an iteration
 * count so the truth sits at the double's floor and not at a budget. At
 * e = 0.001 this converges in three passes; the cap only bounds a caller that
 * changes the elements.
 */
inline double eccentric_anomaly(double mean_anomaly, double e) {
    double E = mean_anomaly;
    for (int i = 0; i < 64; ++i) {
        const double step = (E - e * std::sin(E) - mean_anomaly) / (1.0 - e * std::cos(E));
        E -= step;
        if (step < 1e-16 && step > -1e-16) break;
    }
    return E;
}

/*
 * The closed-form two-body state `dt_sec` after the arc epoch, in km and km/s
 * in the J2000 frame. Perifocal position and velocity in the eccentric anomaly,
 * then the standard 3-1-3 rotation — no series, no table, nothing that has to
 * agree with a second implementation.
 */
inline void state_at(double dt_sec, double pos[3], double vel[3]) {
    const double a = kSemiMajorAxisKm;
    const double e = kEccentricity;
    const double n = std::sqrt(kMuEarthKm3S2 / (a * a * a));
    const double M = kMeanAnomalyAtEpochDeg * kPi / 180.0 + n * dt_sec;
    const double E = eccentric_anomaly(M, e);

    const double cosE = std::cos(E);
    const double sinE = std::sin(E);
    const double root = std::sqrt(1.0 - e * e);
    const double r = a * (1.0 - e * cosE);

    const double xp = a * (cosE - e);
    const double yp = a * root * sinE;
    const double sqrt_mu_a = std::sqrt(kMuEarthKm3S2 * a);
    const double vxp = -sqrt_mu_a * sinE / r;
    const double vyp = sqrt_mu_a * root * cosE / r;

    const double inc = kInclinationDeg * kPi / 180.0;
    const double raan = kRaanDeg * kPi / 180.0;
    const double argp = kArgPerigeeDeg * kPi / 180.0;
    const double co = std::cos(raan), so = std::sin(raan);
    const double cw = std::cos(argp), sw = std::sin(argp);
    const double ci = std::cos(inc), si = std::sin(inc);

    const double r11 = co * cw - so * sw * ci;
    const double r12 = -co * sw - so * cw * ci;
    const double r21 = so * cw + co * sw * ci;
    const double r22 = -so * sw + co * cw * ci;
    const double r31 = sw * si;
    const double r32 = cw * si;

    pos[0] = r11 * xp + r12 * yp;
    pos[1] = r21 * xp + r22 * yp;
    pos[2] = r31 * xp + r32 * yp;
    vel[0] = r11 * vxp + r12 * vyp;
    vel[1] = r21 * vxp + r22 * vyp;
    vel[2] = r31 * vxp + r32 * vyp;
}

/*
 * The arc as the spine holds it: absolute epochs on the container axis SPK and
 * $OEM both use, so nothing is shifted for them. The two containers that count
 * from their own origin get `shifted()` below.
 */
inline ephem::Series master_series() {
    ephem::Series s;
    s.object_name = "SDN-EPHEM-FIXTURE";
    s.object_id = "9999-001A";
    s.center_name = "EARTH";
    s.frame_name = "J2000";
    s.time_system = "UTC";
    s.interp = ephem::Interp::Hermite;
    s.interp_degree = kInterpDegree;
    s.has_naif_ids = true;
    s.naif_target = kNaifTarget;
    s.naif_center = kNaifCenter;
    s.rows.reserve(kNodeCount);
    for (size_t i = 0; i < kNodeCount; ++i) {
        ephem::StateRow r;
        const double dt = static_cast<double>(i) * kStepSec;
        r.epoch = kEpochSecPastJ2000 + dt;
        state_at(dt, r.pos, r.vel);
        r.has_vel = true;
        s.rows.push_back(r);
    }
    return s;
}

/* The same states on a container's own epoch axis. An STK file counts from its
 * ScenarioEpoch and a Code-500 file from its DUT origin: the shift belongs to
 * the container, never to the trajectory. */
inline ephem::Series shifted(const ephem::Series& s, double origin_sec_past_j2000) {
    ephem::Series out = s;
    out.epoch_zero_offset_sec = origin_sec_past_j2000;
    for (ephem::StateRow& r : out.rows) r.epoch -= origin_sec_past_j2000;
    return out;
}

/* ------------------------------------------------------------------------ */
/* Container origins                                                         */
/* ------------------------------------------------------------------------ */

/*
 * Code-500 packs its DUT origin as a two-digit year, so the field cannot hold a
 * 21st-century date at all — 1999-12-31 is the latest origin the container can
 * express, and it is chosen deliberately close to the arc so the DUT round trip
 * (seconds -> hundredths of a day -> seconds) costs a fraction of a microsecond
 * rather than the tens of microseconds a 1957 origin would.
 */
constexpr double kCode500DutYymmdd = 991231.0;

inline double code500_origin_sec() {
    return code500::seconds_past_j2000(1999, 12, 31, 0.0);
}

/* An STK ScenarioEpoch is free, so it is the arc epoch: the container then
 * tabulates 0, 60, 120 ... which is what an .e file actually looks like. */
inline double stk_origin_sec() { return kEpochSecPastJ2000; }

/* ------------------------------------------------------------------------ */
/* Emission                                                                  */
/* ------------------------------------------------------------------------ */

/*
 * Seventeen significant digits, everywhere a number becomes text. Sixteen is
 * what STK itself prints and what a human reads, but it does not round-trip
 * every double — and a fixture that loses a bit on the way out makes the
 * four-container agreement measure the printf, not the containers.
 */
inline std::string digits17(double v) {
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%.17g", v);
    return std::string(buf);
}

/*
 * Seconds past J2000 as a CCSDS ISO-8601 instant, on the container's own scale.
 *
 * NOT `ephem::oem::iso_from_seconds`, which is where this belongs and where it
 * will go once the defect below is fixed. That function shifts to the
 * 0000-03-01 era with the constant 730120 where the day count it is handed needs
 * 730425 (Hinnant's 719468 plus the 10957 days from 1970-01-01 to 2000-01-01),
 * so it renders EVERY epoch exactly 305 days early: it prints this arc's start,
 * 820497600 s past J2000, as 2025-03-02T00:00:00 instead of 2026-01-01T00:00:00.
 * The fix is one constant in files/orbit-products/src/oem_projection.hpp, which
 * this package does not own. Until it lands, a fixture built on that function
 * would carry an epoch axis 305 days away from the three containers that compute
 * their own dates — which the `sources.agree.epochs` assertion now measures.
 *
 * The calendar arithmetic below is `code500::civil_from_days`, an implementation
 * that is already in the tree and already measured, rather than a third copy.
 */
inline std::string iso_from_j2000_seconds(double seconds_past_j2000) {
    /* J2000 is noon, not midnight, so the day count is taken from the shifted
     * instant and the remainder is the time of day. */
    const double shifted = seconds_past_j2000 + 43200.0;
    double day = shifted / 86400.0;
    int64_t whole = static_cast<int64_t>(day);
    if (static_cast<double>(whole) > day) --whole;
    double rem = shifted - static_cast<double>(whole) * 86400.0;

    int y = 0, m = 0, d = 0;
    code500::civil_from_days(whole + code500::kDaysToJ2000, &y, &m, &d);

    const int hh = static_cast<int>(rem / 3600.0);
    rem -= hh * 3600.0;
    const int mi = static_cast<int>(rem / 60.0);
    const double ss = rem - mi * 60.0;

    char buf[64];
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%09.6f", y, m, d, hh, mi, ss);
    return std::string(buf);
}

/*
 * CCSDS OEM in keyword-value notation, built through the kvn document model
 * rather than by string concatenation, so the file this writes is a file that
 * model can read back — the round trip is over the model, not over our idea of
 * the syntax.
 */
inline std::string emit_oem(const ephem::Series& s) {
    kvn::Document doc;
    auto header = [&](const char* key, const std::string& value) {
        kvn::Entry e;
        e.key = key;
        e.value = value;
        doc.header.push_back(e);
    };
    header("CCSDS_OEM_VERS", "3.0");
    /* A fixed creation date, never "now": a fixture whose bytes change every
     * time it is regenerated cannot be asserted byte-identical. */
    header("CREATION_DATE", "2026-01-01T00:00:00.000000");
    header("ORIGINATOR", "SPACE-DATA-NETWORK-MODULES");

    kvn::Segment seg;
    auto meta = [&](const char* key, const std::string& value) {
        kvn::Entry e;
        e.key = key;
        e.value = value;
        seg.metadata.push_back(e);
    };
    meta("OBJECT_NAME", s.object_name);
    meta("OBJECT_ID", s.object_id);
    meta("CENTER_NAME", s.center_name);
    meta("REF_FRAME", s.frame_name);
    meta("TIME_SYSTEM", s.time_system);
    meta("START_TIME", iso_from_j2000_seconds(s.rows.front().epoch));
    meta("STOP_TIME", iso_from_j2000_seconds(s.rows.back().epoch));
    meta("INTERPOLATION", ephem::interp_name(s.interp));
    meta("INTERPOLATION_DEGREE", std::to_string(s.interp_degree));

    seg.has_data_block = true;
    for (const ephem::StateRow& r : s.rows) {
        kvn::DataLine d;
        d.epoch = iso_from_j2000_seconds(r.epoch);
        for (int c = 0; c < 3; ++c) d.tokens.push_back(digits17(r.pos[c]));
        for (int c = 0; c < 3; ++c) d.tokens.push_back(digits17(r.vel[c]));
        seg.data.push_back(d);
    }
    doc.segments.push_back(seg);

    std::string text;
    if (kvn::serialize(doc, &text) != kvn::Status::Ok) return std::string();
    return text;
}

/* SPK type 13 — Hermite on unequally spaced states, which is the type whose
 * own rule is the rule this arc declares. Degree 7 is a 4-state window; NAIF
 * requires the degree to be odd and the writer refuses an even one. */
inline ephem::Status emit_spk(const ephem::Series& s, std::vector<uint8_t>* out) {
    return spk::write_type13(s, kNaifTarget, kNaifCenter, kNaifFrameJ2000, kInterpDegree,
                             "SDN EPHEMERIS FIXTURE ARC", "SDN ephemeris propagator fixture",
                             std::string(), out);
}

/*
 * The Code-500 header this fixture declares. Every field here is a claim the
 * reader will read back, so they are set rather than left at zero: a header
 * whose time system is 0 is not a Code-500 file at all — the reader detects
 * byte order by that field and would refuse the buffer.
 */
inline code500::Header code500_header() {
    code500::Header h;
    h.big_endian = false;
    h.year_format = 1; /* YYYMMDD, the year offset from 1900 — 126 for 2026 */
    h.product_id = "EPHEM   ";
    h.sat_id = 999999.0;
    h.time_system_indicator = 2.0; /* UTC */
    h.tape_id = "SDNFIX  ";
    h.source_id = "SDNMOD  ";
    h.header_title = "SDN EPHEMERIS PROPAGATOR FIXTURE - SYNTHETIC TWO-BODY";
    h.central_body_indicator = 1.0;      /* Earth, on the integration scale */
    h.coordinate_center_indicator = 0.0; /* Earth, on the output scale      */
    h.ref_time_for_dut_yymmdd = kCode500DutYymmdd;
    /* The format's own four-character J2000 tag. It is "2000" and not "J2000"
     * because the field is four characters wide. */
    h.coord_system_indicator_1 = "2000";
    h.coord_system_indicator_2 = 4;
    h.orbit_theory = "TWOBODY ";
    h.precession_nutation_indicator = 0.0;
    h.leap_second_indicator = 1; /* none occurs in the span */
    return h;
}

inline ephem::Status emit_code500(const ephem::Series& s, std::vector<uint8_t>* out) {
    code500::Header h = code500_header();
    const ephem::Status st = code500::derive_header(s, &h);
    if (st != ephem::Status::Ok) return st;
    return code500::write(s, h, out);
}

inline ephem::Status emit_stk(const ephem::Series& s, std::string* out) {
    stk_ephem::WriteOptions opt;
    opt.meters = false;
    opt.precision = 17;
    opt.interpolation_method = "Hermite";
    opt.interpolation_samples_m1 = kInterpDegree;
    opt.version = "stk.v.11.0";
    opt.written_by = "space-data-network-modules data-source/spk-source";
    return stk_ephem::write(s, opt, out);
}

}  // namespace arc

#endif  // SPK_SOURCE_TESTS_FIXTURE_ARC_HPP
