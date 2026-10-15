#include "od/plugin_runtime.h"

#include "od/meme_parser.h"
#include "od/obd_fb_builder.h"
#include "od/ocm_fb_builder.h"
#include "od/oem_fb_reader.h"
#include "od/oem_parser.h"
#include "od/omm_fb_builder.h"
#include "od/sgp4_fitter.h"
#include "od/state_series.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <exception>
#include <limits>
#include <string>

namespace od {

namespace {

// Caller/node-CONFIG labeling overrides shared by the text and FlatBuffer paths. data_source is never hardcoded;
// OBJECT_NAME/OBJECT_ID/NORAD may be supplied when the payload omits them.
void apply_series_labels(StateSeries* series, const FitOptions& options) {
    if (!options.data_source.empty()) series->meta.data_source = options.data_source;
    if (!options.object_name.empty()) series->meta.object_name = options.object_name;
    if (!options.object_id.empty()) series->meta.object_id = options.object_id;
    if (options.norad_cat_id > 0) series->meta.norad_cat_id = options.norad_cat_id;
}

FitterConfig fitter_config(const FitOptions& options) {
    FitterConfig config;
    if (options.max_iterations > 0) {
        config.max_iterations = std::clamp(options.max_iterations, 1, 300);
    }
    // A2.4d same-ephemeris reference scoring (OWNER RULING 2026-07-13 "same ephemeris"): a reference GP element
    // set (a captured CelesTrak SupGP OMM row) is scored via the SAME SGP4 over the SAME fit points and reported
    // as the reference $OBD. Requires a valid epoch + mean motion; otherwise the fit is byte-for-byte unchanged.
    if (options.has_reference) {
        SGP4Elements ref = options.reference;
        ref.epoch_jd = iso_to_jd(ref.epoch_iso);  // same UTC-JD base as the fit points
        if (ref.epoch_jd > 0.0) {
            config.has_reference = true;
            config.reference_elements = ref;
        }
    }
    return config;
}

std::string lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return s;
}

// The fit and its records, shared by both input paths.
PluginFitFBResult fit_series(StateSeries series, const FitOptions& options) {
    PluginFitFBResult result{};
    apply_series_labels(&series, options);

    FitterConfig config = fitter_config(options);
    // The post-fit $OCM covariance; it does not change the fit numerics (the $OMM/$OBD bytes stay identical).
    config.compute_covariance = true;
    auto fit = fit_sgp4_series(series, config);

    // The opt-in legacy two-line set; the catalog number takes Alpha-5 from 100000.
    if (options.emit_tle) {
        result.tle = elements_to_tle(fit.elements);
        if (result.tle.empty()) {
            result.error_code = "unrepresentable-catalog-number";
            result.error_message = "emitTle needs a catalog number from 0 to 339999 (Alpha-5 above 99999); got " +
                                   std::to_string(fit.elements.norad_cat_id) + ".";
            return result;
        }
        result.tle_name = std::to_string(fit.elements.norad_cat_id) + ".tle";
    }

    // $OMM (ORIGINATOR="SDN-OD").
    result.omm = build_omm_flatbuffer(fit.elements);
    // $OBD (OD run result: WRMS, iterations, method) - the SAME fit. Fit span = the ephemeris time window the fit
    // covered (JD is in days).
    double fit_span_days = 0.0;
    if (series.samples.size() >= 2) {
        fit_span_days = series.samples.back().epoch_jd - series.samples.front().epoch_jd;
    }
    result.obd = build_obd_flatbuffer(fit.elements, fit_span_days);
    if (fit.elements.has_reference_rms) {
        result.reference_obd = build_reference_obd_flatbuffer(fit.elements, config.reference_elements, fit_span_days);
    }

    // $OCM (epoch STATE + 6x6 COVARIANCE + OD residual summary) - the SAME fit. Covariance is the real
    // normal-equations fit covariance when the solve was well-conditioned; otherwise the builder leaves it absent
    // and labels it UNAVAILABLE. $OEM is never persisted here.
    {
        OCMInputs oc{};
        oc.el = &fit.elements;
        oc.has_state = fit.has_state_covariance;
        oc.has_covariance = fit.has_state_covariance;
        if (fit.has_state_covariance) {
            for (int i = 0; i < 6; i++) oc.state_teme[i] = fit.state_teme[i];
            for (int i = 0; i < 21; i++) oc.covariance[i] = fit.state_covariance[i];
        }
        oc.rms_km = fit.elements.rms_km;
        oc.num_observations = fit.cov_num_observations;
        oc.iterations = fit.elements.iterations;
        oc.converged = fit.elements.converged;
        oc.convergence_tol = config.convergence_tol;
        result.ocm = build_ocm_flatbuffer(oc, "SDN-OD", fit.elements.epoch_iso);
    }
    result.rms_km = fit.elements.rms_km;
    result.converged = fit.elements.converged;
    result.mean_motion = fit.elements.mean_motion;
    result.ok = true;
    return result;
}

template <typename Fn>
PluginFitFBResult guarded(Fn&& fn) {
    PluginFitFBResult result{};
    try {
        return fn();
    } catch (const std::exception& ex) {
        result.error_code = "fit-failed";
        result.error_message = ex.what();
    } catch (...) {
        result.error_code = "fit-failed";
        result.error_message = "Unknown plugin error.";
    }
    return result;
}

}  // namespace

PluginFitFBResult fit_ephemeris_text(std::string_view ephemeris_content, const FitOptions& options) {
    return guarded([&]() {
        PluginFitFBResult result{};
        // Format selection is data-level: the inputFormat CONFIG wins, otherwise sniff the content.
        std::string format = lower(options.input_format);
        if (format.empty()) {
            format = looks_like_oem(std::string(ephemeris_content)) ? "oem" : "meme";
        }
        StateSeries series;
        if (format == "oem") {
            OEMParseResult parsed = parse_oem(std::string(ephemeris_content));
            if (!parsed.ok) {
                result.error_code = parsed.error_code;
                result.error_message = parsed.error_message;
                return result;
            }
            series = std::move(parsed.series);
        } else if (format == "meme") {
            // MEME: EME2000 states, rotated to TEME.
            MEMEFile meme = parse_meme(std::string(ephemeris_content));
            if (meme.points.empty()) {
                result.error_code = "parse-failed";
                result.error_message = "MEME payload did not contain any ephemeris points.";
                return result;
            }
            series = meme_state_series(meme);
        } else {
            result.error_code = "unsupported-input-format";
            result.error_message = "Unsupported inputFormat '" + format + "' (expected 'meme' or 'oem').";
            return result;
        }
        return fit_series(std::move(series), options);
    });
}

PluginFitFBResult fit_ephemeris_fb(const uint8_t* oem_buf, std::size_t oem_len, const FitOptions& options) {
    return guarded([&]() {
        // $OEM in. The reader mirrors the KVN parser sample-for-sample (frame classification, time-system->UTC,
        // TEME rotation), so the fit is byte-for-byte identical to the text path for the same states.
        OEMParseResult parsed = read_oem_flatbuffer(oem_buf, oem_len);
        if (!parsed.ok) {
            PluginFitFBResult result{};
            result.error_code = parsed.error_code;
            result.error_message = parsed.error_message;
            return result;
        }
        return fit_series(std::move(parsed.series), options);
    });
}

}  // namespace od
