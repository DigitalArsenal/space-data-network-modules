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
 * CCSDS OEM **KVN text**). It reuses the exact frame/time machinery — it does NOT
 * re-implement it:
 *   - od::iso_to_jd            (ISO 8601 -> Julian Date in the declared scale)
 *   - od::time_system_to_utc   (UTC passthrough; GPS/TAI -> UTC via leap table)
 *   - od::classify_frame       (TEME / EME2000 / ITRF-IGS20-ECEF classification)
 *   - od::eci_j2000_to_teme    (EME2000/J2000/GCRF -> TEME, IAU-76/FK5, A2.2a)
 *   - od::ecef_to_teme[_pos]   (ITRF/IGS20/ECEF -> TEME, GMST, A2.4-prereq)
 *   - od::EphemerisPoint / od::StateSeries (the fitter's input types)
 *
 * FAIL-CLOSED: EARTH center only; TIME_SYSTEM UTC/GPS/TAI (else skip; past the
 * leap-second horizon also skips); REFERENCE_FRAME TEME / EME2000-J2000-GCRF /
 * ITRF-IGS20-ECEF (else skip). Position-only sources (STATE_VECTOR_SIZE 3, or
 * verbose lines with no *_DOT) are fitted position-only (velocity seeded from the
 * positions, not fabricated). Undecodable shells / too few samples still skip
 * with a stable token so the pipeline records an honest reason, never a wrong fit.
 */
#ifndef ODPIPE_OEM_RECORD_SERIES_HPP
#define ODPIPE_OEM_RECORD_SERIES_HPP

#include <cstdlib>
#include <string>
#include <vector>

#include "od/frame_transform.h"
#include "od/meme_parser.h"     // od::iso_to_jd, od::EphemerisPoint
#include "od/state_series.h"
#include "od/time_systems.h"    // od::time_system_to_utc (UTC/GPS/TAI -> UTC JD)

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
    std::string source_frame;   // as declared in the record (TEME / EME2000 / IGS20 / ...)
};

// Transform one raw sample into a TEME od::EphemerisPoint. `time_u` is the
// upper-cased TIME_SYSTEM. Returns: 0 = ok, 1 = skip this line (bad epoch),
// 2 = fail the whole record (past-horizon time; *fail_reason set).
inline int sample_to_teme(od::FrameKind fk, const std::string& time_u,
                          const std::string& epoch_iso,
                          double x, double y, double z,
                          bool has_vel, double vx, double vy, double vz,
                          od::EphemerisPoint* p, std::string* fail_reason) {
    double jd_decl = od::iso_to_jd(epoch_iso);
    if (jd_decl == 0.0) return 1;
    od::TimeConv tc = od::time_system_to_utc(time_u, jd_decl);
    if (!tc.ok) { *fail_reason = tc.error_code; return 2; }
    const double jd = tc.jd_utc;
    p->epoch_jd = jd;
    p->timestamp_str = epoch_iso;
    p->has_covariance = false;
    double r_in[3] = {x, y, z}, v_in[3] = {vx, vy, vz}, r_o[3], v_o[3];
    switch (fk) {
        case od::FrameKind::Teme:
            p->x = x; p->y = y; p->z = z; p->vx = vx; p->vy = vy; p->vz = vz;
            break;
        case od::FrameKind::EciJ2000:
            od::eci_j2000_to_teme(jd, r_in, v_in, r_o, v_o);
            p->x = r_o[0]; p->y = r_o[1]; p->z = r_o[2];
            p->vx = v_o[0]; p->vy = v_o[1]; p->vz = v_o[2];
            break;
        case od::FrameKind::Ecef:
            if (has_vel) {
                od::ecef_to_teme(jd, r_in, v_in, r_o, v_o);
                p->vx = v_o[0]; p->vy = v_o[1]; p->vz = v_o[2];
            } else {
                od::ecef_to_teme_pos(jd, r_in, r_o);
                p->vx = 0.0; p->vy = 0.0; p->vz = 0.0;
            }
            p->x = r_o[0]; p->y = r_o[1]; p->z = r_o[2];
            break;
        case od::FrameKind::Unsupported:
            return 1;  // unreachable (frame validated before the loop)
    }
    return 0;
}

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
    double norad_d = 0.0, step_d = 0.0, svs_d = 0.0;
    num_field(block, "NORAD_CAT_ID", &norad_d);
    num_field(block, "STEP_SIZE", &step_d);
    num_field(block, "STATE_VECTOR_SIZE", &svs_d);
    const int state_vector_size = static_cast<int>(svs_d);  // 0 = unspecified

    const std::string center_u = upper(center);
    const std::string time_u = upper(timesys);

    // Fail-closed gates — honest skip, never a wrong fit.
    if (!center.empty() && center_u != "EARTH") { *skip_reason = "unsupported-center:" + center; return false; }
    if (!timesys.empty() && time_u != "UTC" && time_u != "GPS" && time_u != "TAI") {
        *skip_reason = "unsupported-time-system:" + timesys; return false;
    }
    if (frame.empty()) { *skip_reason = "missing-frame"; return false; }
    const od::FrameKind fk = od::classify_frame(frame);
    if (fk == od::FrameKind::Unsupported) { *skip_reason = "unsupported-frame:" + frame; return false; }

    std::vector<od::EphemerisPoint> pts;
    bool any_velocity = false;

    // VERBOSE: explicit-epoch lines take precedence when present.
    std::string lines = block_slice(block, "EPHEMERIS_DATA_LINES", '[', ']');
    if (!lines.empty() && lines.size() > 2) {
        for (const std::string& obj : split_array_objects(lines)) {
            std::string epoch;
            double x, y, z, vx = 0.0, vy = 0.0, vz = 0.0;
            if (!str_field(obj, "EPOCH", &epoch)) continue;
            if (!num_field(obj, "X", &x) || !num_field(obj, "Y", &y) || !num_field(obj, "Z", &z)) continue;
            // Velocity is optional (position-only sources omit *_DOT). A declared
            // STATE_VECTOR_SIZE of 3 forces position-only even if dots are present.
            bool has_vel = state_vector_size != 3 &&
                           num_field(obj, "X_DOT", &vx) && num_field(obj, "Y_DOT", &vy) &&
                           num_field(obj, "Z_DOT", &vz);
            od::EphemerisPoint p;
            std::string fail_reason;
            int rc = sample_to_teme(fk, time_u, epoch, x, y, z, has_vel, vx, vy, vz, &p, &fail_reason);
            if (rc == 2) { *skip_reason = fail_reason; return false; }
            if (rc == 1) continue;
            if (has_vel) any_velocity = true;
            pts.push_back(p);
        }
    } else {
        // COMPACT: flat row-major array + START_TIME + STEP_SIZE (uniform). Stride
        // is 3 (position-only) when STATE_VECTOR_SIZE=3, else 6.
        std::string data = block_slice(block, "EPHEMERIS_DATA", '[', ']');
        std::vector<double> flat = parse_double_array(data);
        if (flat.empty()) { *skip_reason = "empty-ephemeris"; return false; }
        const int stride = (state_vector_size == 3) ? 3 : 6;
        if (flat.size() % static_cast<size_t>(stride) != 0) { *skip_reason = "ragged-ephemeris"; return false; }
        if (start_time.empty()) { *skip_reason = "unparseable-start-time"; return false; }
        // Convert the compact START_TIME to UTC once; add elapsed step seconds
        // (no leap second occurs within an ephemeris span, so this is exact).
        od::TimeConv tc0 = od::time_system_to_utc(time_u, od::iso_to_jd(start_time));
        if (od::iso_to_jd(start_time) == 0.0) { *skip_reason = "unparseable-start-time"; return false; }
        if (!tc0.ok) { *skip_reason = tc0.error_code; return false; }
        if (step_d <= 0.0) { *skip_reason = "compact-without-step"; return false; }
        const double jd0 = tc0.jd_utc;
        const bool has_vel = (stride == 6);
        if (has_vel) any_velocity = true;
        const size_t n = flat.size() / static_cast<size_t>(stride);
        for (size_t i = 0; i < n; ++i) {
            double jd = jd0 + static_cast<double>(i) * step_d / 86400.0;
            double x = flat[stride * i], y = flat[stride * i + 1], z = flat[stride * i + 2];
            double vx = has_vel ? flat[stride * i + 3] : 0.0;
            double vy = has_vel ? flat[stride * i + 4] : 0.0;
            double vz = has_vel ? flat[stride * i + 5] : 0.0;
            od::EphemerisPoint p;
            p.epoch_jd = jd;
            p.has_covariance = false;
            double r_in[3] = {x, y, z}, v_in[3] = {vx, vy, vz}, r_o[3], v_o[3];
            switch (fk) {
                case od::FrameKind::Teme:
                    p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz; break;
                case od::FrameKind::EciJ2000:
                    od::eci_j2000_to_teme(jd, r_in, v_in, r_o, v_o);
                    p.x = r_o[0]; p.y = r_o[1]; p.z = r_o[2]; p.vx = v_o[0]; p.vy = v_o[1]; p.vz = v_o[2]; break;
                case od::FrameKind::Ecef:
                    if (has_vel) { od::ecef_to_teme(jd, r_in, v_in, r_o, v_o); p.vx = v_o[0]; p.vy = v_o[1]; p.vz = v_o[2]; }
                    else { od::ecef_to_teme_pos(jd, r_in, r_o); p.vx = 0.0; p.vy = 0.0; p.vz = 0.0; }
                    p.x = r_o[0]; p.y = r_o[1]; p.z = r_o[2]; break;
                case od::FrameKind::Unsupported: break;
            }
            pts.push_back(p);
        }
    }

    if (pts.size() < 8) { *skip_reason = "too-few-samples:" + std::to_string(pts.size()); return false; }
    const bool position_only = !any_velocity;

    out->samples = std::move(pts);
    out->meta.norad_cat_id = static_cast<int>(norad_d);
    out->meta.object_name = object_name;
    out->meta.object_id = object_id;
    out->meta.data_source = data_source;
    out->meta.center_name = "EARTH";
    out->meta.ref_frame = "TEME";
    out->meta.source_frame = frame;
    out->meta.time_system = time_u.empty() ? "UTC" : time_u;  // as-declared; epoch_jd is UTC
    out->meta.position_only = position_only;
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
