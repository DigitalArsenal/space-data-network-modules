/*
 * id_registry.hpp — data-driven object-ID cross-reference seam (A2.4-prereq #4).
 *
 * Position-only precise-ephemeris feeds identify objects by a provider-natural
 * key, NOT by NORAD/COSPAR: GLONASS SP3 by orbit slot (e.g. "R03"), Intelsat ECF
 * by satellite name (e.g. "IS-21"), GPS almanac by PRN. The fitted OMM/SupGP
 * record needs NORAD_CAT_ID / OBJECT_ID, but those MUST NEVER be fabricated in
 * the parser. This is the seam: an OWNER-SUPPLIED JSON registry, consumed from
 * the fit-pipeline config, that maps the record's OBJECT_NAME -> {NORAD, COSPAR}.
 *
 * Policy (honest by construction):
 *   - The registry is EMPTY by default. With no registry, every position-only
 *     record keeps its honest-empty IDs and is still fitted, tagged
 *     "unmapped-object-id".
 *   - A registry hit fills NORAD_CAT_ID / OBJECT_ID from owner-verified data.
 *   - A registry MISS (name not present) leaves the IDs empty and tags the fit
 *     "unmapped-object-id" — fitted, never fabricated.
 *   - Records whose source already carried a real NORAD (e.g. CPF via ILRS ID)
 *     do not consult the registry at all.
 *
 * Config JSON shape (keyed by the record's OBJECT_NAME):
 *   "idRegistry": {
 *     "R03":   { "NORAD_CAT_ID": 32275, "OBJECT_ID": "2007-052A" },
 *     "IS-21": { "NORAD_CAT_ID": 38749, "OBJECT_ID": "2012-043A" }
 *   }
 */
#ifndef ODPIPE_ID_REGISTRY_HPP
#define ODPIPE_ID_REGISTRY_HPP

#include <string>
#include <vector>

#include "oem_record_series.hpp"  // odpipe:: JSON slicing helpers (str_field/num_field/is_ws)

namespace odpipe {

struct IdRegistryEntry {
    std::string key;         // record OBJECT_NAME (slot / name / PRN)
    int norad = 0;
    std::string object_id;   // international designator (COSPAR)
};

// Parse a registry object "{ \"key\": { ... }, ... }" (inclusive of braces) into
// entries. Malformed or non-object values are skipped (never throws). An empty or
// absent registry yields an empty vector (the honest default).
inline std::vector<IdRegistryEntry> parse_id_registry(const std::string& reg_incl) {
    std::vector<IdRegistryEntry> out;
    if (reg_incl.size() < 2 || reg_incl.front() != '{') return out;
    size_t p = 1;  // just inside the opening '{'
    while (p < reg_incl.size()) {
        // Find the next key string.
        while (p < reg_incl.size() && (is_ws(reg_incl[p]) || reg_incl[p] == ',')) ++p;
        if (p >= reg_incl.size() || reg_incl[p] == '}') break;
        if (reg_incl[p] != '"') { ++p; continue; }
        // Read the key (honoring escapes).
        std::string key;
        ++p;
        while (p < reg_incl.size() && reg_incl[p] != '"') {
            if (reg_incl[p] == '\\' && p + 1 < reg_incl.size()) { key.push_back(reg_incl[p + 1]); p += 2; }
            else { key.push_back(reg_incl[p]); ++p; }
        }
        if (p >= reg_incl.size()) break;
        ++p;  // past closing quote
        while (p < reg_incl.size() && is_ws(reg_incl[p])) ++p;
        if (p >= reg_incl.size() || reg_incl[p] != ':') continue;
        ++p;
        while (p < reg_incl.size() && is_ws(reg_incl[p])) ++p;
        if (p >= reg_incl.size() || reg_incl[p] != '{') continue;
        // Capture the balanced value object.
        int depth = 0;
        bool in_str = false;
        size_t start = p;
        for (; p < reg_incl.size(); ++p) {
            char c = reg_incl[p];
            if (in_str) {
                if (c == '\\') { ++p; continue; }
                if (c == '"') in_str = false;
                continue;
            }
            if (c == '"') in_str = true;
            else if (c == '{') depth++;
            else if (c == '}') { depth--; if (depth == 0) { ++p; break; } }
        }
        std::string value = reg_incl.substr(start, p - start);
        IdRegistryEntry e;
        e.key = key;
        double norad_d = 0.0;
        if (num_field(value, "NORAD_CAT_ID", &norad_d)) e.norad = static_cast<int>(norad_d);
        str_field(value, "OBJECT_ID", &e.object_id);
        if (!e.key.empty() && (e.norad != 0 || !e.object_id.empty())) out.push_back(e);
    }
    return out;
}

// Exact-match lookup by OBJECT_NAME key. Returns true + fills *out on a hit.
inline bool id_registry_lookup(const std::vector<IdRegistryEntry>& reg,
                               const std::string& key, IdRegistryEntry* out) {
    if (key.empty()) return false;
    for (const IdRegistryEntry& e : reg) {
        if (e.key == key) { if (out) *out = e; return true; }
    }
    return false;
}

}  // namespace odpipe

#endif  // ODPIPE_ID_REGISTRY_HPP
