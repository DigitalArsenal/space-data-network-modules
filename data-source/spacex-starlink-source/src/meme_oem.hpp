#pragma once
// meme_oem.hpp — SpaceX MEME parsing + $OEM FlatBuffer build, factored out of the
// module so it is unit-testable against the checked-in MEME fixtures (no network).
// The parse (MemeMeta + parse_meme) is the exact logic the module uses; build_oem_fb
// maps a parsed object to a compact SDS $OEM (CelestialFrame::EME2000, the frame MEME
// states are in) via the shared oem_fb builder. Pure C++ (no host ABI), so a native test can include it.

// math.h SVID matherr macros (SING/DOMAIN/...) collide with generated enum ids on
// native builds; undef before the generated header (the em++/WASI sysroot is clean).
#include <cmath>
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

#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>

#include "OEM_generated.h"
#include "oem_fb_builder.hpp"

namespace meme_oem {

struct MemeMeta {
    long norad_cat_id = 0;
    std::string object_name;   // STARLINK-#####
    std::string status;        // Operational
    std::string created_iso;   // from `created:` header
    std::string start_iso;     // from `ephemeris_start:` header
    std::string stop_iso;      // from `ephemeris_stop:` header
    std::string ephemeris_source;  // blend
    long step_size = 0;
};

// Normalize a MEME header UTC stamp ("2026-05-14 02:02:54 UTC") to ISO 8601
// ("2026-05-14T02:02:54Z"). Idempotent for already-ISO strings.
inline std::string normalize_utc(const std::string& in) {
    std::string s;
    // trim
    size_t a = in.find_first_not_of(" \t\r\n");
    size_t b = in.find_last_not_of(" \t\r\n");
    if (a == std::string::npos) return s;
    s = in.substr(a, b - a + 1);
    // strip trailing " UTC"
    if (s.size() >= 4 && s.compare(s.size() - 4, 4, " UTC") == 0) s = s.substr(0, s.size() - 4);
    // date/time separator space -> 'T'
    size_t sp = s.find(' ');
    if (sp != std::string::npos) s[sp] = 'T';
    // ensure trailing Z
    if (!s.empty() && s.back() != 'Z') s.push_back('Z');
    return s;
}

inline std::vector<std::string> split_ws(const std::string& line) {
    std::vector<std::string> toks;
    size_t i = 0;
    while (i < line.size()) {
        while (i < line.size() && (line[i] == ' ' || line[i] == '\t' || line[i] == '\r')) i++;
        size_t j = i;
        while (j < line.size() && line[j] != ' ' && line[j] != '\t' && line[j] != '\r') j++;
        if (j > i) toks.push_back(line.substr(i, j - i));
        i = j;
    }
    return toks;
}

// A MEME state line's first token is a YYYYDDDHHMMSS.sss stamp (>=13 leading
// digits, no exponent) — distinct from the scientific-notation covariance rows.
inline bool is_state_epoch_token(const std::string& t) {
    size_t digits = 0;
    for (char c : t) {
        if (c == '.') break;
        if (c < '0' || c > '9') return false;
        digits++;
    }
    return digits >= 13;
}

// Parse the MEME filename metadata.
// MEME_{NORAD}_{NAME}_{COSPAR-internal}_{Status}_{UnixTS}_UNCLASSIFIED.txt
// The 4th field is a SpaceX-internal id, NOT an international designator, so
// OBJECT_ID is intentionally left unset (per A2.2a labeling rules).
inline void parse_meme_filename(const std::string& filename, MemeMeta* m) {
    std::vector<std::string> parts;
    size_t start = 0;
    while (start <= filename.size()) {
        size_t us = filename.find('_', start);
        parts.push_back(filename.substr(start, (us == std::string::npos ? filename.size() : us) - start));
        if (us == std::string::npos) break;
        start = us + 1;
    }
    if (parts.size() >= 6 && parts[0] == "MEME") {
        m->norad_cat_id = strtol(parts[1].c_str(), nullptr, 10);
        m->object_name = parts[2];
        m->status = parts[4];
    }
}

// Parse a raw MEME file: fills header meta and the flat row-major state array
// [x0,y0,z0,vx0,vy0,vz0, x1,...] (km, km/s). Covariance rows are skipped for
// the compact OEM (see README residuals).
inline void parse_meme(const std::string& content, MemeMeta* m, std::vector<double>* states) {
    size_t pos = 0;
    auto next_line = [&](std::string* out) -> bool {
        if (pos > content.size()) return false;
        size_t nl = content.find('\n', pos);
        *out = content.substr(pos, (nl == std::string::npos ? content.size() : nl) - pos);
        pos = (nl == std::string::npos) ? content.size() + 1 : nl + 1;
        return true;
    };
    std::string line;
    // Header lines (created / ephemeris_start+stop+step / ephemeris_source / frame).
    if (next_line(&line)) {
        size_t k = line.find("created:");
        if (k != std::string::npos) m->created_iso = normalize_utc(line.substr(k + 8));
    }
    if (next_line(&line)) {
        size_t s = line.find("ephemeris_start:");
        size_t e = line.find("ephemeris_stop:");
        size_t z = line.find("step_size:");
        if (s != std::string::npos && e != std::string::npos)
            m->start_iso = normalize_utc(line.substr(s + 16, e - s - 16));
        if (e != std::string::npos) {
            size_t end = (z != std::string::npos) ? z : line.size();
            m->stop_iso = normalize_utc(line.substr(e + 15, end - e - 15));
        }
        if (z != std::string::npos) m->step_size = strtol(line.c_str() + z + 10, nullptr, 10);
    }
    if (next_line(&line)) {
        size_t k = line.find("ephemeris_source:");
        if (k != std::string::npos) {
            std::string v = line.substr(k + 17);
            size_t a = v.find_first_not_of(" \t\r");
            size_t b = v.find_last_not_of(" \t\r");
            if (a != std::string::npos) m->ephemeris_source = v.substr(a, b - a + 1);
        }
    }
    next_line(&line);  // covariance frame label (UVW) — not the state-vector frame

    // Data blocks: each state line is followed by 3 scientific-notation
    // covariance rows. A covariance row's first token never satisfies
    // is_state_epoch_token (its integer part has < 13 digits), so selecting
    // state lines directly transparently drops the covariance rows and is
    // robust to covariance-absent (truncated) files.
    while (next_line(&line)) {
        std::vector<std::string> toks = split_ws(line);
        if (toks.size() < 7 || !is_state_epoch_token(toks[0])) continue;
        for (int c = 1; c <= 6; ++c) states->push_back(strtod(toks[c].c_str(), nullptr));
    }
}

// Build a compact SDS $OEM FlatBuffer for one parsed MEME object. MEME state
// vectors are EME2000 (the UVW header line names only the covariance frame), so
// the frame is CelestialFrame::EME2000: it reads back as the token "EME2000",
// which analysis/od rotates to TEME before the SGP4 fit. Labelled TEME, the
// states were fitted unrotated and every Starlink GP landed ~30-40 km off
// CelesTrak SupGP. OBJECT_ID is unset (the MEME COSPAR field is SpaceX-internal,
// not an intl designator). Ephemeris in-memory only; the caller emits the bytes,
// never stores them.
inline std::vector<uint8_t> build_oem_fb(const MemeMeta& m,
                                         const std::vector<double>& states) {
    const oem_fb::Identity id{m.object_name.c_str(), "",
                              static_cast<uint32_t>(m.norad_cat_id)};
    return oem_fb::build_oem_flatbuffer_compact(
        id, CelestialFrame::EME2000, "EARTH", timingStandard::UTC, m.start_iso.c_str(),
        m.stop_iso.c_str(), static_cast<double>(m.step_size), states.data(),
        static_cast<int>(states.size()));
}

}  // namespace meme_oem
