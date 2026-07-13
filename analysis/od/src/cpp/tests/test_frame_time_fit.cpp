/**
 * A2.4-prereq OD extensions — native tests.
 *
 *   1. ECEF (ITRF/IGS20) -> TEME transform: GMST cross-check vs the published
 *      J2000 constant, det=1 / orthonormality, and a round-trip reference pair
 *      generated from the VALIDATED EME2000->TEME (A2.2a) path.
 *   2. GPS/TAI -> UTC time-system conversion incl. fail-closed past the
 *      leap-second horizon and before the table.
 *   3. Position-only SGP4 fit on the real IAC GLONASS SP3 arc (IGS20 ECEF, GPS
 *      time, no velocities) -> credible GLONASS elements.
 */
#include "od/frame_transform.h"
#include "od/time_systems.h"
#include "od/state_series.h"
#include "od/sgp4_fitter.h"
#include "od/meme_parser.h"  // jd_to_iso_supgp (labels only)

#include <array>
#include <cmath>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using namespace od;

static int tests_passed = 0;
static int tests_failed = 0;
#define CHECK(cond, msg) do { \
    if (cond) { tests_passed++; std::cout << "  ✓ " << msg << std::endl; } \
    else { tests_failed++; std::cout << "  ✗ " << msg << std::endl; } \
} while(0)

static std::array<double,3> matvec(const Mat3& m, const std::array<double,3>& v) {
    return {{ m[0][0]*v[0]+m[0][1]*v[1]+m[0][2]*v[2],
              m[1][0]*v[0]+m[1][1]*v[1]+m[1][2]*v[2],
              m[2][0]*v[0]+m[2][1]*v[1]+m[2][2]*v[2] }};
}
static double det3(const Mat3& m) {
    return m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])
         - m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])
         + m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
}
static double vmag(const std::array<double,3>& a){return std::sqrt(a[0]*a[0]+a[1]*a[1]+a[2]*a[2]);}

// ── 1. ECEF <-> TEME transform ───────────────────────────────────────────────

void test_frame_classification() {
    std::cout << "\n--- Test: REFERENCE_FRAME classification (all providers) ---" << std::endl;
    // The provider frames this pass unblocks must classify as Earth-fixed:
    //   GLONASS SP3 = IGS20, CPF = ITRF, Intelsat = ECEF/ECF.
    CHECK(classify_frame("IGS20") == FrameKind::Ecef, "IGS20 (GLONASS) -> Ecef");
    CHECK(classify_frame("ITRF") == FrameKind::Ecef, "ITRF (CPF) -> Ecef");
    CHECK(classify_frame("ITRF2020") == FrameKind::Ecef, "ITRF2020 realization -> Ecef");
    CHECK(classify_frame("ITRF2014") == FrameKind::Ecef, "ITRF2014 realization -> Ecef");
    CHECK(classify_frame("ECEF") == FrameKind::Ecef, "ECEF (Intelsat ECF adapter) -> Ecef");
    CHECK(classify_frame("ECF") == FrameKind::Ecef, "ECF -> Ecef");
    CHECK(classify_frame("IGS14") == FrameKind::Ecef, "IGS14 realization -> Ecef");
    // Inertial frames keep their existing classification.
    CHECK(classify_frame("TEME") == FrameKind::Teme, "TEME -> Teme");
    CHECK(classify_frame("EME2000") == FrameKind::EciJ2000, "EME2000 -> EciJ2000");
    CHECK(classify_frame("J2000") == FrameKind::EciJ2000, "J2000 -> EciJ2000");
    CHECK(classify_frame("GCRF") == FrameKind::EciJ2000, "GCRF -> EciJ2000");
    // Genuinely unsupported -> fail-closed (never silently mistreated).
    CHECK(classify_frame("PZ-90.11") == FrameKind::Unsupported,
          "PZ-90.11 (GLONASS broadcast) stays fail-closed (no PZ-90->ITRF transform)");
    CHECK(classify_frame("RSW") == FrameKind::Unsupported, "RSW (local-orbit) fail-closed");
    CHECK(classify_frame("UNKNOWN") == FrameKind::Unsupported, "UNKNOWN fail-closed");
    CHECK(classify_frame("") == FrameKind::Unsupported, "empty frame fail-closed");
}

void test_ecef_teme_transform() {
    std::cout << "\n--- Test: ECEF (IGS20/ITRF) -> TEME transform ---" << std::endl;

    // Independent GMST cross-check: GMST at J2000.0 is the canonical
    // 280.46061837 deg (Vallado / IERS). This anchors the Earth-rotation angle
    // without any orbit assumption.
    double gmst_j2000_deg = gmst_1982(2451545.0) * 180.0 / M_PI;
    std::cout << "    GMST(J2000) = " << std::fixed << gmst_j2000_deg
              << " deg (published 280.46061837)" << std::endl;
    CHECK(std::abs(gmst_j2000_deg - 280.46061837) < 1e-4,
          "GMST(J2000) matches the published constant");

    // det = 1 and orthonormality (a pure rotation) across several epochs.
    bool det_ok = true, orth_ok = true;
    for (double jd = 2461000.0; jd < 2461400.0; jd += 37.3) {
        Mat3 m = ecef_to_teme_matrix(jd);
        if (std::abs(det3(m) - 1.0) > 1e-12) det_ok = false;
        // M * M^T == I
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j) {
                double d = m[i][0]*m[j][0] + m[i][1]*m[j][1] + m[i][2]*m[j][2];
                double expect = (i == j) ? 1.0 : 0.0;
                if (std::abs(d - expect) > 1e-12) orth_ok = false;
            }
    }
    CHECK(det_ok, "det(ECEF->TEME) == 1 across epochs");
    CHECK(orth_ok, "ECEF->TEME is orthonormal across epochs");

    // Reference pair generated from the VALIDATED EME2000->TEME path (A2.2a):
    // r_TEME = eci_j2000_to_teme(EME2000). Rotate TEME->ECEF (transpose of the
    // ECEF->TEME matrix), then ECEF->TEME must recover r_TEME exactly.
    double jd = 2461232.5;  // 2026-07-11 00:00 UTC
    double r_eme[3] = {4123.4, -5678.9, 2345.6};
    double v_eme[3] = {5.123, 3.456, -4.321};
    double r_teme[3], v_teme[3];
    eci_j2000_to_teme(jd, r_eme, v_eme, r_teme, v_teme);

    Mat3 e2t = ecef_to_teme_matrix(jd);          // rot_z(-gmst)
    Mat3 t2e;                                    // transpose = rot_z(+gmst)
    for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) t2e[i][j] = e2t[j][i];
    std::array<double,3> r_ecef = matvec(t2e, {{r_teme[0], r_teme[1], r_teme[2]}});

    double r_back[3];
    ecef_to_teme_pos(jd, r_ecef.data(), r_back);
    double rt = std::sqrt(std::pow(r_back[0]-r_teme[0],2)+std::pow(r_back[1]-r_teme[1],2)+std::pow(r_back[2]-r_teme[2],2));
    std::cout << "    round-trip TEME->ECEF->TEME residual = " << std::scientific << rt << " km" << std::endl;
    CHECK(rt < 1e-9, "TEME->ECEF->TEME round-trip < 1e-9 km");

    // Rotation preserves magnitude.
    double m_teme = std::sqrt(r_teme[0]*r_teme[0]+r_teme[1]*r_teme[1]+r_teme[2]*r_teme[2]);
    CHECK(std::abs(vmag(r_ecef) - m_teme) < 1e-9, "ECEF/TEME magnitudes equal (rotation)");

    // Full-state ECEF round-trip incl. Earth-rotation transport term: a state
    // built as ECEF from a TEME state must transform back to that TEME state.
    // TEME->ECEF velocity: v_ecef = R(t2e) v_teme - omega x r_ecef ... we simply
    // check ecef_to_teme( TEME->ECEF(state) ) == state via a numeric construction.
    // Construct an ECEF velocity consistent with r_teme,v_teme:
    //   v_teme = R3(-g) v_ecef + omega x r_teme  =>  v_ecef = R3(g)(v_teme - omega x r_teme)
    const double w = 7.29211514668855e-5;
    std::array<double,3> wxr = {{ -w*r_teme[1], w*r_teme[0], 0.0 }};
    std::array<double,3> v_minus = {{ v_teme[0]-wxr[0], v_teme[1]-wxr[1], v_teme[2]-wxr[2] }};
    std::array<double,3> v_ecef = matvec(t2e, v_minus);
    double r_o[3], v_o[3];
    ecef_to_teme(jd, r_ecef.data(), v_ecef.data(), r_o, v_o);
    double vrt = std::sqrt(std::pow(v_o[0]-v_teme[0],2)+std::pow(v_o[1]-v_teme[1],2)+std::pow(v_o[2]-v_teme[2],2));
    std::cout << "    full-state velocity round-trip residual = " << std::scientific << vrt << " km/s" << std::endl;
    CHECK(vrt < 1e-9, "full-state ECEF<->TEME velocity round-trip < 1e-9 km/s");
}

// ── 2. GPS / TAI -> UTC ──────────────────────────────────────────────────────

void test_time_systems() {
    std::cout << "\n--- Test: GPS/TAI -> UTC time systems ---" << std::endl;

    // 2026: TAI-UTC = 37 s => GPS-UTC = 18 s. A GPS instant maps to UTC 18 s earlier.
    // (The recovered offset is checked to 1 ms: subtracting two ~2.46e6 JDs floors
    // at the double ULP ~5e-10 JD ≈ 47 µs — far below any orbit-epoch tolerance.)
    double jd_gps = jd_from_ymd(2026, 7, 11) + 12.0 / 24.0;  // 2026-07-11 12:00 GPS
    TimeConv g = gps_jd_to_utc(jd_gps);
    CHECK(g.ok, "GPS->UTC succeeds for a 2026 epoch");
    double off_sec = (jd_gps - g.jd_utc) * 86400.0;
    std::cout << "    GPS-UTC offset (2026) = " << std::fixed << off_sec << " s (expected 18)" << std::endl;
    CHECK(std::abs(off_sec - 18.0) < 1e-3, "GPS-UTC = 18 s in 2026");

    // TAI->UTC = 37 s in 2026.
    TimeConv ta = tai_jd_to_utc(jd_from_ymd(2026, 7, 11) + 0.25);
    double tai_off = (jd_from_ymd(2026, 7, 11) + 0.25 - ta.jd_utc) * 86400.0;
    CHECK(ta.ok && std::abs(tai_off - 37.0) < 1e-3, "TAI-UTC = 37 s in 2026");

    // A historic GPS instant just after the 2015-07-01 leap (TAI-UTC 36 => GPS-UTC 17).
    TimeConv g2015 = gps_jd_to_utc(jd_from_ymd(2015, 8, 1) + 0.5);
    double off2015 = (jd_from_ymd(2015, 8, 1) + 0.5 - g2015.jd_utc) * 86400.0;
    CHECK(g2015.ok && std::abs(off2015 - 17.0) < 1e-3, "GPS-UTC = 17 s in Aug-2015");

    // Fail-closed PAST the documented leap-second horizon: never extrapolate.
    double past = leap_valid_through_jd() + 5.0;  // 5 days past horizon
    TimeConv gp = gps_jd_to_utc(past);
    std::cout << "    past-horizon error_code = '" << gp.error_code << "'" << std::endl;
    CHECK(!gp.ok && gp.error_code == "time-past-leap-horizon",
          "GPS->UTC FAILS CLOSED past the leap horizon (no extrapolation)");

    // Fail-closed BEFORE the UTC leap table (pre-1972 / pre-GPS).
    TimeConv gb = gps_jd_to_utc(jd_from_ymd(1970, 1, 1));
    CHECK(!gb.ok && gb.error_code == "time-before-utc-table",
          "GPS->UTC FAILS CLOSED before the UTC table");

    // Dispatch: UTC passes through unchanged; unknown scale fails closed.
    TimeConv u = time_system_to_utc("UTC", jd_gps);
    CHECK(u.ok && u.jd_utc == jd_gps, "UTC passthrough is identity");
    TimeConv bad = time_system_to_utc("TDB", jd_gps);
    CHECK(!bad.ok && bad.error_code == "unsupported-time-system", "unknown time system fails closed");
}

// ── 3. GLONASS position-only fit from the real SP3 arc ───────────────────────

// Minimal SP3 reader: collect the (epoch, x, y, z) of one satellite id ("PR03").
static bool read_sp3_sat(const std::string& sat_id,
                         std::vector<std::array<double,4>>* out /* jd_gps, x,y,z */) {
    const char* paths[] = {
        "tests/data/glonass/iac_glonass.sp3.glo",
        "../tests/data/glonass/iac_glonass.sp3.glo",
        "../../tests/data/glonass/iac_glonass.sp3.glo",
        "../../../tests/data/glonass/iac_glonass.sp3.glo",       // src/cpp/build-native -> analysis/od
        "analysis/od/tests/data/glonass/iac_glonass.sp3.glo",
    };
    std::ifstream f;
    for (const char* p : paths) { f.open(p); if (f.is_open()) break; }
    if (!f.is_open()) return false;
    std::string line;
    double cur_jd = 0.0;
    while (std::getline(f, line)) {
        if (line.size() >= 2 && line[0] == '*' && line[1] == ' ') {
            std::istringstream ss(line.substr(1));
            int y, mo, d, h, mi; double s;
            if (ss >> y >> mo >> d >> h >> mi >> s)
                cur_jd = jd_from_ymd(y, mo, d) + (h*3600.0 + mi*60.0 + s) / 86400.0;  // GPS
        } else if (line.rfind(sat_id, 0) == 0 && cur_jd != 0.0) {
            std::istringstream ss(line.substr(sat_id.size()));
            double x, y, z;
            if (ss >> x >> y >> z) out->push_back({{cur_jd, x, y, z}});
        }
    }
    return !out->empty();
}

void test_glonass_position_only_fit() {
    std::cout << "\n--- Test: GLONASS position-only fit (IGS20 ECEF, GPS time) ---" << std::endl;

    std::vector<std::array<double,4>> raw;  // (jd_gps, x, y, z) km
    if (!read_sp3_sat("PR03", &raw)) {
        std::cout << "  ⚠ GLONASS SP3 fixture not found (tests/data/glonass/iac_glonass.sp3.glo)" << std::endl;
        tests_failed++;  // this fixture is checked in; missing = a real failure
        return;
    }
    std::cout << "    parsed " << raw.size() << " R03 ECEF epochs" << std::endl;
    CHECK(raw.size() >= 3, "at least 3 R03 epochs in the SP3 arc");

    // Build the TEME/UTC position-only series exactly as the converter would:
    // GPS->UTC, then ECEF(IGS20)->TEME per point, velocities left zero.
    StateSeries series;
    series.meta.data_source = "GLONASS-RE";
    series.meta.object_name = "R03";
    series.meta.center_name = "EARTH";
    series.meta.ref_frame = "TEME";
    series.meta.source_frame = "IGS20";
    series.meta.time_system = "GPS";
    series.meta.position_only = true;
    for (const auto& p : raw) {
        TimeConv tc = gps_jd_to_utc(p[0]);
        CHECK(tc.ok, "GPS->UTC ok for R03 epoch");
        double r_ecef[3] = {p[1], p[2], p[3]};
        double r_teme[3];
        ecef_to_teme_pos(tc.jd_utc, r_ecef, r_teme);
        EphemerisPoint pt{};
        pt.epoch_jd = tc.jd_utc;
        pt.x = r_teme[0]; pt.y = r_teme[1]; pt.z = r_teme[2];
        pt.vx = pt.vy = pt.vz = 0.0;
        series.samples.push_back(pt);
    }
    double rmag = std::sqrt(series.samples[0].x*series.samples[0].x +
                            series.samples[0].y*series.samples[0].y +
                            series.samples[0].z*series.samples[0].z);
    std::cout << "    |r0|(TEME) = " << std::fixed << rmag << " km" << std::endl;
    CHECK(rmag > 25000 && rmag < 26000, "R03 radius is GLONASS MEO (~25510 km)");

    FitterConfig cfg;  // defaults; 3-point arc fits within the 192-min window
    FitResult fit = fit_sgp4_series(series, cfg);

    double a_km = std::cbrt(398600.8 / std::pow(fit.elements.mean_motion * 2.0*M_PI / 86400.0, 2.0));
    double period_h = 24.0 / fit.elements.mean_motion;
    std::cout << "    RMS=" << std::fixed << fit.rms_km << " km  converged=" << (fit.converged?"yes":"no")
              << "  iters=" << fit.iterations << std::endl;
    std::cout << "    n=" << fit.elements.mean_motion << " rev/day  a=" << a_km
              << " km  e=" << fit.elements.eccentricity << "  i=" << fit.elements.inclination
              << " deg  period=" << period_h << " h" << std::endl;

    CHECK(fit.elements.mean_motion > 2.0 && fit.elements.mean_motion < 2.3,
          "mean motion ~2.13 rev/day (GLONASS)");
    CHECK(period_h > 11.0 && period_h < 11.5, "period ~11.26 h (GLONASS)");
    CHECK(a_km > 25000 && a_km < 26000, "semi-major axis ~25510 km");
    CHECK(fit.elements.eccentricity < 0.02, "near-circular (e < 0.02)");
    CHECK(fit.elements.inclination > 63.0 && fit.elements.inclination < 67.0,
          "inclination ~64.8 deg (GLONASS)");
    CHECK(fit.rms_km < 5.0, "position RMS is small (< 5 km) over the fit arc");
}

int main() {
    std::cout << "=== A2.4-prereq: frame / time / position-only OD tests ===" << std::endl;
    test_frame_classification();
    test_ecef_teme_transform();
    test_time_systems();
    test_glonass_position_only_fit();
    std::cout << "\n=== Summary: " << tests_passed << " passed, " << tests_failed << " failed ===" << std::endl;
    return tests_failed > 0 ? 1 : 0;
}
