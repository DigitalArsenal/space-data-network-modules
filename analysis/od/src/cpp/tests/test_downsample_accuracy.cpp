// test_downsample_accuracy.cpp
//
// Empirical answer to: "how much accuracy do we lose by downsampling the
// operator ephemeris before the SGP4 differential-correction fit?"
//
// Method: parse a real Starlink MEME ephemeris, take a fixed 2-orbit fit window,
// then fit at decreasing point densities (stride 1,2,4,8,16,32). For each fit we
// report the mean elements + its own RMS + convergence + wall-time, AND — the
// honest part — we re-evaluate every downsampled OMM against the FULL-density
// window (via the fitter's has_reference path, which propagates a supplied
// element set over the dense fit points and reports its RMS). So the accuracy
// metric is always computed over the same dense reference, decoupled from how
// many points the fit itself consumed.
//
// Usage: test_downsample_accuracy <path-to-meme-file>

#include "od/meme_parser.h"
#include "od/sgp4_fitter.h"
#include <chrono>
#include <cstdio>
#include <string>
#include <vector>

using namespace od;
using clk = std::chrono::steady_clock;

static double ms_since(clk::time_point t0) {
    return std::chrono::duration<double, std::milli>(clk::now() - t0).count();
}

// RMS of `omm` propagated over `dense` points, via the fitter's has_reference path.
static double rms_over_dense(const std::vector<EphemerisPoint>& dense,
                             const SGP4Elements& omm) {
    FitterConfig cfg;
    cfg.fit_window_sec = 1e12;      // use every dense point (no windowing)
    cfg.has_reference = true;
    cfg.reference_elements = omm;   // score THESE elements over the dense points
    FitResult r = fit_sgp4(dense, cfg);
    return r.elements.has_reference_rms ? r.elements.reference_rms_km : -1.0;
}

int main(int argc, char** argv) {
    if (argc < 2) { std::fprintf(stderr, "usage: %s <meme-file>\n", argv[0]); return 2; }
    MEMEFile meme = parse_meme_file(argv[1]);
    const auto& all = meme.points;
    std::printf("MEME: %s\n", argv[1]);
    std::printf("parsed state vectors: %zu  (object=%s norad=%d)\n\n",
                all.size(), meme.header.object_name.c_str(), meme.header.norad_cat_id);
    if (all.size() < 50) { std::fprintf(stderr, "too few points\n"); return 1; }

    // Fixed 2-orbit fit window (~192 min) from the first epoch.
    const double WINDOW_DAYS = 11520.0 / 86400.0;
    const double t0 = all.front().epoch_jd;
    std::vector<EphemerisPoint> win;
    for (const auto& p : all) { if (p.epoch_jd - t0 <= WINDOW_DAYS) win.push_back(p); }
    std::printf("dense 2-orbit window: %zu points (%.0f s cadence)\n",
                win.size(),
                win.size() > 1 ? (win[1].epoch_jd - win[0].epoch_jd) * 86400.0 : 0.0);

    // Reference "best" fit = full density over the window.
    FitterConfig full; full.fit_window_sec = 1e12;
    auto tref = clk::now();
    FitResult ref = fit_sgp4(win, full);
    double ref_ms = ms_since(tref);
    const SGP4Elements& R = ref.elements;
    std::printf("reference (dense) fit: %zu pts  rms=%.6f km  iters=%d  conv=%d  %.1f ms\n\n",
                win.size(), ref.rms_km, ref.iterations, (int)ref.converged, ref_ms);

    std::printf("%-6s %-8s %-12s %-12s %-11s %-11s %-11s %-11s %-11s %-8s\n",
                "stride", "npts", "rms_own(km)", "rms_dense", "d_meanmot", "d_incl", "d_raan",
                "d_argp", "d_ecc", "fit_ms");
    std::printf("%s\n", std::string(118, '-').c_str());

    for (int stride : {1, 2, 4, 8, 16, 32}) {
        std::vector<EphemerisPoint> ds;
        for (size_t i = 0; i < win.size(); i += (size_t)stride) ds.push_back(win[i]);
        if (ds.size() < 6) break;
        FitterConfig cfg; cfg.fit_window_sec = 1e12;
        auto t = clk::now();
        FitResult r = fit_sgp4(ds, cfg);
        double fit_ms = ms_since(t);
        const SGP4Elements& E = r.elements;
        double rms_dense = rms_over_dense(win, E);
        std::printf("%-6d %-8zu %-12.6f %-12.6f %-11.2e %-11.2e %-11.2e %-11.2e %-11.2e %-8.1f\n",
                    stride, ds.size(), r.rms_km, rms_dense,
                    E.mean_motion - R.mean_motion,
                    E.inclination - R.inclination,
                    E.ra_of_asc_node - R.ra_of_asc_node,
                    E.arg_of_pericenter - R.arg_of_pericenter,
                    E.eccentricity - R.eccentricity,
                    fit_ms);
    }

    // Contrast: fit the FULL 3-day ephemeris (all points) — shows a longer arc is
    // NOT "more accurate" for a current-epoch mean-element set (SGP4 cannot
    // represent 3 days of dynamics; the fit compromises).
    FitterConfig longc; longc.fit_window_sec = 1e12;
    auto tl = clk::now();
    FitResult lr = fit_sgp4(all, longc);
    double long_ms = ms_since(tl);
    double long_over_dense = rms_over_dense(win, lr.elements);
    std::printf("\nfull 3-day arc: %zu pts  rms_own=%.6f km  rms_over_2orbit_window=%.6f km  %.1f ms\n",
                all.size(), lr.rms_km, long_over_dense, long_ms);
    std::printf("d_meanmot=%.2e d_incl=%.2e d_ecc=%.2e vs dense-window fit\n",
                lr.elements.mean_motion - R.mean_motion,
                lr.elements.inclination - R.inclination,
                lr.elements.eccentricity - R.eccentricity);
    return 0;
}
