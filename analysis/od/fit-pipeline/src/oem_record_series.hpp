/*
 * oem_record_series.hpp — canonical stored SDS OEM JSON record -> od::StateSeries.
 *
 * A2.3 OD-fit pipeline consumption seam. The provider data-source adapters
 * (spacex-starlink-source, iss-source, ...) store canonical CCSDS **OEM** records
 * as schema-exact JSON via storage.write. Two representations are first-class in
 * the SDS OEM schema and both appear in the wild:
 *
 *   1. COMPACT (uniform cadence): EPHEMERIS_DATA = flat row-major
 *      [x0,y0,z0,vx0,vy0,vz0, x1,...] (km, km/s) + START_TIME + STEP_SIZE(>0).
 *      Epoch of sample i is START_TIME + i*STEP_SIZE seconds. (Starlink adapter.)
 *   2. VERBOSE (explicit epoch, possibly non-uniform): EPHEMERIS_DATA_LINES =
 *      [{EPOCH,X,Y,Z,X_DOT,Y_DOT,Z_DOT}, ...] with STEP_SIZE = 0. (ISS adapter.)
 *
 * This converter is the JSON-record analogue of od::parse_oem (which consumes
 * CCSDS OEM **KVN text**). It reuses the exact A2.2a frame/time machinery — it
 * does NOT re-implement it:
 *   - od::iso_to_jd            (ISO 8601 -> UTC Julian Date)
 *   - od::eci_j2000_to_teme    (EME2000/J2000/GCRF -> TEME, IAU-76/FK5)
 *   - od::EphemerisPoint / od::StateSeries (the fitter's input types)
 *
 * FAIL-CLOSED (A2.2a policy): TEME native; EME2000/J2000/GCRF rotated to TEME;
 * UTC only; EARTH only. Anything else (PZ-90/ITRF ECEF, TAI/GPS time, non-Earth
 * center, UNKNOWN/undecodable shells, too few samples) is NOT fitted — the
 * converter returns false with a stable skip token so the pipeline records an
 * honest skip reason instead of emitting a wrong fit.
 */
#ifndef ODPIPE_OEM_RECORD_SERIES_HPP
#define ODPIPE_OEM_RECORD_SERIES_HPP

#include <cstdlib>
#include <string>
#include <vector>

#include "od/frame_transform.h"
#include "od/meme_parser.h"     // od::iso_to_jd, od::EphemerisPoint
#include "od/state_series.h"

namespace odpipe {

// ── minimal, nesting-safe JSON slicing ──────────────────────────────────────
// The canonical OEM record is a flat-ish object with one EPHEMERIS_DATA_BLOCK.
// These helpers are bracket/quote-aware so a nested block or a data array is
// isolated before flat key lookups run (avoids the "EPHEMERIS_DATA" vs
// "EPHEMERIS_DATA_BLOCK"/"_LINES" prefix trap — the closing quote in the needle
// already disambiguates, and slicing the block first makes it robust).

inline bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

// Return the region right after `"key":` (whitespace skipped), or npos region.
inline size_t value_pos(const std::string& j, const std::string& key, size_t from = 0) {
    const std::string needle = "\"" + key + "\"";
    size_t k = j.find(needle, from);
    if (k == std::string::npos) return std::string::npos;
    size_t colon = j.find(':', k + needle.size());
    if (colon == std::string::npos) return std::string::npos;
    size_t i = colon + 1;
    while (i < j.size() && is_ws(j[i])) i++;
    return i;
}

// Slice a "{...}" or "[...]" block for `key` (inclusive of the delimiters).
inline std::string block_slice(const std::string& j, const std::string& key,
                               char open, char close, size_t from = 0) {
    size_t i = value_pos(j, key, from);
    if (i == std::string::npos || i >= j.size() || j[i] != open) return std::string();
    int depth = 0;
    bool in_str = false;
    for (size_t p = i; p < j.size(); ++p) {
        char c = j[p];
        if (in_str) {
            if (c == '\\') { ++p; continue; }
            if (c == '"') in_str = false;
            continue;
        }
        if (c == '"') in_str = true;
        else if (c == open) depth++;
        else if (c == close) { depth--; if (depth == 0) return j.substr(i, p - i + 1); }
    }
    return std::string();
}

// First "{...}" object inside the array value of `key` (e.g. EPHEMERIS_DATA_BLOCK[0]).
inline std::string first_array_object(const std::string& j, const std::string& key) {
    std::string arr = block_slice(j, key, '[', ']');
    if (arr.size() < 2) return std::string();
    // arr == "[ ... ]"; find the first object within.
    int depth = 0;
    bool in_str = false;
    size_t start = std::string::npos;
    for (size_t p = 0; p < arr.size(); ++p) {
        char c = arr[p];
        if (in_str) {
            if (c == '\\') { ++p; continue; }
            if (c == '"') in_str = false;
            continue;
        }
        if (c == '"') in_str = true;
        else if (c == '{') { if (depth == 0) start = p; depth++; }
        else if (c == '}') { depth--; if (depth == 0 && start != std::string::npos) return arr.substr(start, p - start + 1); }
    }
    return std::string();
}

inline bool str_field(const std::string& j, const std::string& key, std::string* out) {
    size_t i = value_pos(j, key);
    if (i == std::string::npos || i >= j.size() || j[i] != '"') return false;
    ++i;
    std::string v;
    while (i < j.size() && j[i] != '"') {
        if (j[i] == '\\' && i + 1 < j.size()) {
            char n = j[i + 1];
            if (n == 'n') v.push_back('\n');
            else if (n == 't') v.push_back('\t');
            else if (n == 'r') v.push_back('\r');
            else v.push_back(n);
            i += 2;
        } else { v.push_back(j[i]); ++i; }
    }
    *out = v;
    return true;
}

inline bool num_field(const std::string& j, const std::string& key, double* out) {
    size_t i = value_pos(j, key);
    if (i == std::string::npos || i >= j.size()) return false;
    char c = j[i];
    if (c != '-' && c != '+' && (c < '0' || c > '9')) return false;
    char* end = nullptr;
    double v = std::strtod(j.c_str() + i, &end);
    if (end == j.c_str() + i) return false;
    *out = v;
    return true;
}

// Parse the comma-separated doubles inside a "[...]" array body.
inline std::vector<double> parse_double_array(const std::string& arr_incl) {
    std::vector<double> out;
    if (arr_incl.size() < 2) return out;
    const char* p = arr_incl.c_str() + 1;              // skip '['
    const char* end = arr_incl.c_str() + arr_incl.size();
    while (p < end) {
        while (p < end && (is_ws(*p) || *p == ',')) ++p;
        if (p >= end || *p == ']') break;
        char* np = nullptr;
        double v = std::strtod(p, &np);
        if (np == p) break;
        out.push_back(v);
        p = np;
    }
    return out;
}

// Iterate the "{...}" objects inside a "[...]" array body, returning each.
inline std::vector<std::string> split_array_objects(const std::string& arr_incl) {
    std::vector<std::string> out;
    int depth = 0;
    bool in_str = false;
    size_t start = std::string::npos;
    for (size_t p = 0; p < arr_incl.size(); ++p) {
        char c = arr_incl[p];
        if (in_str) {
            if (c == '\\') { ++p; continue; }
            if (c == '"') in_str = false;
            continue;
        }
        if (c == '"') in_str = true;
        else if (c == '{') { if (depth == 0) start = p; depth++; }
        else if (c == '}') { depth--; if (depth == 0 && start != std::string::npos) { out.push_back(arr_incl.substr(start, p - start + 1)); start = std::string::npos; } }
    }
    return out;
}

inline std::string upper(std::string s) {
    for (char& c : s) if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
    return s;
}

// ── the converter ────────────────────────────────────────────────────────────

struct OemSeriesMeta {
    int norad_cat_id = 0;
    std::string object_name;
    std::string object_id;
    std::string source_frame;   // as declared in the record (TEME / EME2000 / ...)
};

// Convert a canonical stored SDS OEM JSON record into a TEME od::StateSeries.
// Returns true with `out` populated on success; false with `*skip_reason` set to
// a stable token on any fail-closed condition. `data_source` labels the series
// (flows to the fitted OMM DATA_SOURCE) — it is the caller's per-provider token.
inline bool oem_record_to_series(const std::string& record_json,
                                 const std::string& data_source,
                                 od::StateSeries* out,
                                 std::string* skip_reason,
                                 OemSeriesMeta* meta_out = nullptr) {
    std::string block = first_array_object(record_json, "EPHEMERIS_DATA_BLOCK");
    if (block.empty()) block = record_json;  // tolerate an inlined single block

    std::string center, frame, timesys, start_time, object_name, object_id;
    str_field(block, "CENTER_NAME", &center);
    str_field(block, "REFERENCE_FRAME", &frame);
    str_field(block, "TIME_SYSTEM", &timesys);
    str_field(block, "START_TIME", &start_time);
    str_field(block, "OBJECT_NAME", &object_name);
    str_field(block, "OBJECT_ID", &object_id);
    double norad_d = 0.0, step_d = 0.0;
    num_field(block, "NORAD_CAT_ID", &norad_d);
    num_field(block, "STEP_SIZE", &step_d);

    const std::string center_u = upper(center);
    const std::string frame_u = upper(frame);
    const std::string time_u = upper(timesys);

    // Fail-closed gates (A2.2a policy) — honest skip, never a wrong fit.
    if (!center.empty() && center_u != "EARTH") { *skip_reason = "unsupported-center:" + center; return false; }
    if (!timesys.empty() && time_u != "UTC") { *skip_reason = "unsupported-time-system:" + timesys; return false; }
    bool frame_teme = (frame_u == "TEME");
    bool frame_j2000 = (frame_u == "EME2000" || frame_u == "J2000" || frame_u == "GCRF");
    if (frame.empty()) { *skip_reason = "missing-frame"; return false; }
    if (!frame_teme && !frame_j2000) { *skip_reason = "unsupported-frame:" + frame; return false; }

    std::vector<od::EphemerisPoint> pts;

    // VERBOSE: explicit-epoch lines take precedence when present.
    std::string lines = block_slice(block, "EPHEMERIS_DATA_LINES", '[', ']');
    if (!lines.empty() && lines.size() > 2) {
        for (const std::string& obj : split_array_objects(lines)) {
            std::string epoch;
            double x, y, z, vx, vy, vz;
            if (!str_field(obj, "EPOCH", &epoch)) continue;
            if (!num_field(obj, "X", &x) || !num_field(obj, "Y", &y) || !num_field(obj, "Z", &z) ||
                !num_field(obj, "X_DOT", &vx) || !num_field(obj, "Y_DOT", &vy) || !num_field(obj, "Z_DOT", &vz))
                continue;
            double jd = od::iso_to_jd(epoch);
            if (jd == 0.0) continue;
            od::EphemerisPoint p;
            p.epoch_jd = jd;
            p.timestamp_str = epoch;
            if (frame_j2000) {
                double r_in[3] = {x, y, z}, v_in[3] = {vx, vy, vz}, r_o[3], v_o[3];
                od::eci_j2000_to_teme(jd, r_in, v_in, r_o, v_o);
                p.x = r_o[0]; p.y = r_o[1]; p.z = r_o[2];
                p.vx = v_o[0]; p.vy = v_o[1]; p.vz = v_o[2];
            } else {
                p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz;
            }
            pts.push_back(p);
        }
    } else {
        // COMPACT: flat row-major array + START_TIME + STEP_SIZE (uniform).
        std::string data = block_slice(block, "EPHEMERIS_DATA", '[', ']');
        std::vector<double> flat = parse_double_array(data);
        if (flat.empty()) { *skip_reason = "empty-ephemeris"; return false; }
        if (flat.size() % 6 != 0) { *skip_reason = "ragged-ephemeris"; return false; }
        double jd0 = start_time.empty() ? 0.0 : od::iso_to_jd(start_time);
        if (jd0 == 0.0) { *skip_reason = "unparseable-start-time"; return false; }
        if (step_d <= 0.0) { *skip_reason = "compact-without-step"; return false; }
        const size_t n = flat.size() / 6;
        for (size_t i = 0; i < n; ++i) {
            double jd = jd0 + static_cast<double>(i) * step_d / 86400.0;
            double x = flat[6 * i], y = flat[6 * i + 1], z = flat[6 * i + 2];
            double vx = flat[6 * i + 3], vy = flat[6 * i + 4], vz = flat[6 * i + 5];
            od::EphemerisPoint p;
            p.epoch_jd = jd;
            if (frame_j2000) {
                double r_in[3] = {x, y, z}, v_in[3] = {vx, vy, vz}, r_o[3], v_o[3];
                od::eci_j2000_to_teme(jd, r_in, v_in, r_o, v_o);
                p.x = r_o[0]; p.y = r_o[1]; p.z = r_o[2];
                p.vx = v_o[0]; p.vy = v_o[1]; p.vz = v_o[2];
            } else {
                p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz;
            }
            pts.push_back(p);
        }
    }

    if (pts.size() < 8) { *skip_reason = "too-few-samples:" + std::to_string(pts.size()); return false; }

    out->samples = std::move(pts);
    out->meta.norad_cat_id = static_cast<int>(norad_d);
    out->meta.object_name = object_name;
    out->meta.object_id = object_id;
    out->meta.data_source = data_source;
    out->meta.center_name = "EARTH";
    out->meta.ref_frame = "TEME";
    out->meta.source_frame = frame;
    out->meta.time_system = "UTC";
    out->meta.segment_count = 1;

    if (meta_out) {
        meta_out->norad_cat_id = static_cast<int>(norad_d);
        meta_out->object_name = object_name;
        meta_out->object_id = object_id;
        meta_out->source_frame = frame;
    }
    return true;
}

}  // namespace odpipe

#endif  // ODPIPE_OEM_RECORD_SERIES_HPP
