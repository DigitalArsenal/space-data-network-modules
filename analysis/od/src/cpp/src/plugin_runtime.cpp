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

std::string json_escape(std::string_view value) {
    std::string escaped;
    escaped.reserve(value.size());
    for (char ch : value) {
        switch (ch) {
            case '\\':
                escaped += "\\\\";
                break;
            case '"':
                escaped += "\\\"";
                break;
            case '\n':
                escaped += "\\n";
                break;
            case '\r':
                escaped += "\\r";
                break;
            case '\t':
                escaped += "\\t";
                break;
            default:
                escaped.push_back(ch);
                break;
        }
    }
    return escaped;
}

}  // namespace

int parse_positive_int_option(std::string_view json, std::string_view key) {
    if (json.empty()) {
        return 0;
    }
    const std::string quoted_key = std::string("\"") + std::string(key) + "\"";
    const auto key_pos = json.find(quoted_key);
    if (key_pos == std::string_view::npos) {
        return 0;
    }
    const auto colon_pos = json.find(':', key_pos + quoted_key.size());
    if (colon_pos == std::string_view::npos) {
        return 0;
    }
    size_t cursor = colon_pos + 1;
    while (cursor < json.size() &&
           std::isspace(static_cast<unsigned char>(json[cursor]))) {
        cursor += 1;
    }
    int value = 0;
    bool saw_digit = false;
    while (cursor < json.size() &&
           std::isdigit(static_cast<unsigned char>(json[cursor]))) {
        saw_digit = true;
        const int digit = json[cursor] - '0';
        if (value > (std::numeric_limits<int>::max() - digit) / 10) {
            value = std::numeric_limits<int>::max();
            break;
        }
        value = value * 10 + digit;
        cursor += 1;
    }
    return saw_digit ? value : 0;
}

// Extract a JSON string value for `key` from a flat options object. Mirrors the
// colon-anchored needle convention used by parse_positive_int_option. Returns
// empty when the key is absent or is not a string.
std::string parse_string_option(std::string_view json, std::string_view key) {
    if (json.empty()) {
        return std::string();
    }
    const std::string quoted_key = std::string("\"") + std::string(key) + "\"";
    const auto key_pos = json.find(quoted_key);
    if (key_pos == std::string_view::npos) {
        return std::string();
    }
    const auto colon_pos = json.find(':', key_pos + quoted_key.size());
    if (colon_pos == std::string_view::npos) {
        return std::string();
    }
    size_t cursor = colon_pos + 1;
    while (cursor < json.size() &&
           std::isspace(static_cast<unsigned char>(json[cursor]))) {
        cursor += 1;
    }
    if (cursor >= json.size() || json[cursor] != '"') {
        return std::string();  // not a string value
    }
    cursor += 1;
    std::string value;
    while (cursor < json.size()) {
        const char ch = json[cursor];
        if (ch == '\\' && cursor + 1 < json.size()) {
            const char next = json[cursor + 1];
            switch (next) {
                case '"': value.push_back('"'); break;
                case '\\': value.push_back('\\'); break;
                case '/': value.push_back('/'); break;
                case 'n': value.push_back('\n'); break;
                case 't': value.push_back('\t'); break;
                case 'r': value.push_back('\r'); break;
                default: value.push_back(next); break;
            }
            cursor += 2;
            continue;
        }
        if (ch == '"') {
            break;
        }
        value.push_back(ch);
        cursor += 1;
    }
    return value;
}

// Extract a JSON number value for `key` from a flat options object. Mirrors the
// colon-anchored needle convention used by the int/string parsers, but accepts
// signed, fractional, and E-notation values via strtod (BSTAR/ndot come in as
// e.g. 9.2967e-4). Returns false when the key is absent or is not a number; the
// quoted needle (with trailing ") disambiguates prefix keys like refMeanMotion
// vs refMeanMotionDot vs refMeanMotionDdot.
bool parse_double_option(std::string_view json, std::string_view key, double* out) {
    if (json.empty() || !out) {
        return false;
    }
    const std::string quoted_key = std::string("\"") + std::string(key) + "\"";
    const auto key_pos = json.find(quoted_key);
    if (key_pos == std::string_view::npos) {
        return false;
    }
    const auto colon_pos = json.find(':', key_pos + quoted_key.size());
    if (colon_pos == std::string_view::npos) {
        return false;
    }
    size_t cursor = colon_pos + 1;
    while (cursor < json.size() &&
           std::isspace(static_cast<unsigned char>(json[cursor]))) {
        cursor += 1;
    }
    if (cursor >= json.size()) {
        return false;
    }
    // strtod needs a NUL-terminated buffer; it stops at the first non-numeric
    // char (',', '}', whitespace), so the trailing JSON is ignored.
    const std::string tail(json.substr(cursor));
    const char* start = tail.c_str();
    char* end = nullptr;
    const double value = std::strtod(start, &end);
    if (end == start) {
        return false;  // no number parsed (e.g. a string or null value)
    }
    *out = value;
    return true;
}

// Caller/manifest labeling overrides shared by the text and FlatBuffer paths.
// data_source is never hardcoded; OBJECT_NAME/OBJECT_ID/NORAD may be supplied
// when the payload omits them (or, for the FB path, moved to node CONFIG).
void apply_series_labels(StateSeries* series, std::string_view options_json) {
    const std::string data_source = parse_string_option(options_json, "dataSource");
    if (!data_source.empty()) series->meta.data_source = data_source;
    const std::string object_name = parse_string_option(options_json, "objectName");
    if (!object_name.empty()) series->meta.object_name = object_name;
    const std::string object_id = parse_string_option(options_json, "objectId");
    if (!object_id.empty()) series->meta.object_id = object_id;
    const int norad = parse_positive_int_option(options_json, "noradCatId");
    if (norad > 0) series->meta.norad_cat_id = norad;
}

FitterConfig parse_fit_options(std::string_view options_json) {
    FitterConfig config;
    const int camel_case_limit =
        parse_positive_int_option(options_json, "maxIterations");
    const int snake_case_limit =
        parse_positive_int_option(options_json, "max_iterations");
    const int requested_limit =
        camel_case_limit > 0 ? camel_case_limit : snake_case_limit;
    if (requested_limit > 0) {
        config.max_iterations = std::clamp(requested_limit, 1, 300);
    }

    // A2.4d same-ephemeris reference scoring (OWNER RULING 2026-07-13 "same
    // ephemeris"). A caller may supply a reference GP element set (a captured
    // CelesTrak SupGP OMM row) as flat ref* options; the fitter then scores those
    // elements via the SAME SGP4 over the SAME fit points and reports
    // REFERENCE_RMS (the beatsCelestrakSameEphemeris gate). Reusable by any
    // provider manifest. Requires at least a valid epoch + mean motion; otherwise
    // the option is ignored and the fit is byte-for-byte unchanged.
    const std::string ref_epoch = parse_string_option(options_json, "refEpoch");
    double ref_mm = 0.0;
    if (!ref_epoch.empty() &&
        parse_double_option(options_json, "refMeanMotion", &ref_mm) && ref_mm > 0.0) {
        SGP4Elements ref{};
        ref.epoch_iso = ref_epoch;
        ref.epoch_jd = iso_to_jd(ref_epoch);  // same UTC-JD base as the fit points
        ref.mean_motion = ref_mm;
        parse_double_option(options_json, "refEccentricity", &ref.eccentricity);
        parse_double_option(options_json, "refInclination", &ref.inclination);
        parse_double_option(options_json, "refRaan", &ref.ra_of_asc_node);
        parse_double_option(options_json, "refArgPericenter", &ref.arg_of_pericenter);
        parse_double_option(options_json, "refMeanAnomaly", &ref.mean_anomaly);
        parse_double_option(options_json, "refBstar", &ref.bstar);
        parse_double_option(options_json, "refMeanMotionDot", &ref.mean_motion_dot);
        parse_double_option(options_json, "refMeanMotionDdot", &ref.mean_motion_ddot);
        if (ref.epoch_jd > 0.0) {
            config.has_reference = true;
            config.reference_elements = ref;
        }
    }
    return config;
}

namespace {

std::string lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return s;
}

// Build a common StateSeries from a MEME payload (already-TEME state vectors).
bool build_meme_series(std::string_view content, StateSeries* out,
                       std::string* error_code, std::string* error_message) {
    MEMEFile meme = parse_meme(std::string(content));
    if (meme.points.empty()) {
        *error_code = "parse-failed";
        *error_message = "MEME payload did not contain any ephemeris points.";
        return false;
    }
    out->samples = meme.points;
    out->meta.norad_cat_id = meme.header.norad_cat_id;
    out->meta.object_name = meme.header.object_name;
    out->meta.ref_frame = "TEME";
    out->meta.source_frame =
        meme.header.reference_frame.empty() ? "TEME" : meme.header.reference_frame;
    out->meta.time_system = "UTC";
    out->meta.segment_count = 1;
    return true;
}

PluginFitFBResult build_fit_record_set(const FitResult& fit,
                                       const FitterConfig& config,
                                       double fit_span_days) {
    PluginFitFBResult result{};
    result.omm = build_omm_flatbuffer(fit.elements);
    result.obd = build_obd_flatbuffer(fit.elements, fit_span_days);

    OCMInputs ocm{};
    ocm.el = &fit.elements;
    ocm.has_state = fit.has_state_covariance;
    ocm.has_covariance = fit.has_state_covariance;
    if (fit.has_state_covariance) {
        for (int i = 0; i < 6; i++) ocm.state_teme[i] = fit.state_teme[i];
        for (int i = 0; i < 21; i++) ocm.covariance[i] = fit.state_covariance[i];
    }
    ocm.rms_km = fit.elements.rms_km;
    ocm.num_observations = fit.cov_num_observations;
    ocm.iterations = fit.elements.iterations;
    ocm.converged = fit.elements.converged;
    ocm.convergence_tol = config.convergence_tol;
    result.ocm = build_ocm_flatbuffer(ocm, "SDN-OD", fit.elements.epoch_iso);

    result.rms_km = fit.elements.rms_km;
    result.converged = fit.elements.converged;
    result.mean_motion = fit.elements.mean_motion;
    result.ok = true;
    return result;
}

}  // namespace

PluginFitResult fit_ephemeris_payload(
    std::string_view ephemeris_content,
    std::string_view options_json) {
    PluginFitResult result{};

    try {
        // Format selection is data-level (keeps the module ABI unchanged): an
        // explicit `inputFormat` option wins, otherwise sniff the content.
        std::string format = lower(parse_string_option(options_json, "inputFormat"));
        if (format.empty()) {
            format = looks_like_oem(std::string(ephemeris_content)) ? "oem" : "meme";
        }

        StateSeries series;
        if (format == "oem") {
            OEMParseResult parsed = parse_oem(std::string(ephemeris_content));
            if (!parsed.ok) {
                result.error_code = parsed.error_code;
                result.error_message = parsed.error_message;
                result.json = std::string("{\"error\":\"") +
                              json_escape(result.error_message) + "\"}";
                return result;
            }
            series = std::move(parsed.series);
        } else if (format == "meme") {
            if (!build_meme_series(ephemeris_content, &series, &result.error_code,
                                   &result.error_message)) {
                result.json = std::string("{\"error\":\"") +
                              json_escape(result.error_message) + "\"}";
                return result;
            }
        } else {
            result.error_code = "unsupported-input-format";
            result.error_message =
                "Unsupported inputFormat '" + format + "' (expected 'meme' or 'oem').";
            result.json = std::string("{\"error\":\"") +
                          json_escape(result.error_message) + "\"}";
            return result;
        }

        apply_series_labels(&series, options_json);

        FitterConfig config = parse_fit_options(options_json);
        auto fit = fit_sgp4_series(series, config);
        result.ok = true;
        result.json = elements_to_json(fit.elements);
        return result;
    } catch (const std::exception& ex) {
        result.error_code = "fit-failed";
        result.error_message = ex.what();
    } catch (...) {
        result.error_code = "fit-failed";
        result.error_message = "Unknown plugin error.";
    }

    result.json =
        std::string("{\"error\":\"") + json_escape(result.error_message) + "\"}";
    return result;
}

PluginFitFBResult fit_ephemeris_fb(
    const uint8_t* oem_buf,
    std::size_t oem_len,
    std::string_view options_json) {
    PluginFitFBResult result{};

    try {
        // Aligned-binary $OEM in. The reader mirrors the KVN parser sample-for-
        // sample (frame classification, time-system->UTC, TEME rotation), so the
        // fit below is byte-for-byte identical to the text path for the same
        // states — the sacred parity gate. No JSON at this hop.
        OEMParseResult parsed = read_oem_flatbuffer(oem_buf, oem_len);
        if (!parsed.ok) {
            result.error_code = parsed.error_code;
            result.error_message = parsed.error_message;
            return result;
        }
        StateSeries series = std::move(parsed.series);

        apply_series_labels(&series, options_json);

        FitterConfig config = parse_fit_options(options_json);
        // SDN OD-Flow: request the post-fit $OCM covariance (opt-in; does not
        // change the fit numerics — the $OMM/$OBD bytes stay identical).
        config.compute_covariance = true;
        auto fit = fit_sgp4_series(series, config);

        // Aligned-binary $OMM out (ORIGINATOR="SDN-OD").
        result.omm = build_omm_flatbuffer(fit.elements);
        // Aligned-binary $OBD out (OD run result: WRMS, iterations, method) — the
        // SAME fit, telemetry captured as a typed record. Fit span = the ephemeris
        // time window the fit covered (JD is in days).
        double fit_span_days = 0.0;
        if (series.samples.size() >= 2) {
            fit_span_days =
                series.samples.back().epoch_jd - series.samples.front().epoch_jd;
        }
        result.obd = build_obd_flatbuffer(fit.elements, fit_span_days);

        // Aligned-binary $OCM out (epoch STATE + 6x6 COVARIANCE + OD residual
        // summary) — the SAME fit. Covariance is the real normal-equations fit
        // covariance when the solve was well-conditioned; otherwise the builder
        // emits its documented RMS-seeded formal placeholder. $OEM is never
        // persisted here; only these fitted result records leave the fit.
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
    } catch (const std::exception& ex) {
        result.error_code = "fit-failed";
        result.error_message = ex.what();
    } catch (...) {
        result.error_code = "fit-failed";
        result.error_message = "Unknown plugin error.";
    }
    return result;
}

std::vector<PluginFitFBResult> fit_ephemeris_epochs_fb(
    const uint8_t* oem_buf,
    std::size_t oem_len,
    std::string_view options_json) {
    std::vector<PluginFitFBResult> results;
    try {
        OEMParseResult parsed = read_oem_flatbuffer(oem_buf, oem_len);
        if (!parsed.ok) {
            PluginFitFBResult error{};
            error.error_code = parsed.error_code;
            error.error_message = parsed.error_message;
            results.push_back(std::move(error));
            return results;
        }
        StateSeries series = std::move(parsed.series);
        apply_series_labels(&series, options_json);

        FitterConfig config = parse_fit_options(options_json);
        config.compute_covariance = true;
        std::vector<FitResult> fits = fit_sgp4_epoch_series(series, config);
        if (fits.empty()) {
            PluginFitFBResult error{};
            error.error_code = "insufficient-ephemeris";
            error.error_message = "At least three complete ephemeris states are required.";
            results.push_back(std::move(error));
            return results;
        }

        results.reserve(fits.size());
        const double last_jd = series.samples.back().epoch_jd;
        const double max_span_days = config.fit_window_sec / 86400.0;
        for (const FitResult& fit : fits) {
            const double available_days =
                std::max(0.0, last_jd - fit.elements.epoch_jd);
            const double fit_span_days =
                std::min(max_span_days, available_days);
            results.push_back(build_fit_record_set(fit, config, fit_span_days));
        }
        return results;
    } catch (const std::exception& ex) {
        PluginFitFBResult error{};
        error.error_code = "fit-failed";
        error.error_message = ex.what();
        results.push_back(std::move(error));
    } catch (...) {
        PluginFitFBResult error{};
        error.error_code = "fit-failed";
        error.error_message = "Unknown plugin error.";
        results.push_back(std::move(error));
    }
    return results;
}

}  // namespace od
