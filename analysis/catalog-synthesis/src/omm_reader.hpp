/*
 * omm_reader.hpp — encoding-agnostic reader for stored OMM records (App 2, A2.7).
 *
 * A `storage.query(schema="OMM")` on a real SDN node returns OMM records from
 * BOTH lanes, intermixed and in TWO different on-the-wire encodings — because the
 * FlatSQL store persists each writer's bytes VERBATIM (internal/storage/
 * flatsql.go storeOne → appendFlatSQLStreamRecord: no re-encode):
 *
 *   1. Our OD-fitted supplemental OMMs — written by analysis/od/fit-pipeline via
 *      `storage.write` — are raw **JSON** (od::elements_to_json + fit-pipeline
 *      provenance: COMMENT[] + USER_DEFINED_SDN_SOURCE_NAME / _SOURCE_CID /
 *      _SOURCE_SHA256 / _ID_STATUS). Currently UNTAGGED (storage.write sets no
 *      SourceTags) — see the fit-pipeline tag-migration dependency in README.
 *
 *   2. Space-Track GP records — written by the Go current-gp lane
 *      (sdn-server/internal/ingest/spacetrack_supplemental.go → shared
 *      ingestGPRows → sds.NewOMMBuilder → store.StoreWithSourceTags) — are
 *      **$OMM FlatBuffer** bytes, TAGGED SourceName="spacetrack-gp",
 *      ProviderID="space-track", ORIGINATOR "18 SPCS".
 *
 * This reader detects the encoding per record and normalizes BOTH into one
 * CanonOmm (schema-exact GP element keys), classifying each record's source with
 * a TAG-FIRST, USER_DEFINED-FALLBACK policy (the packet's documented rule):
 *   - if SourceTags.SourceName is present -> use it (a Space-Track source name =>
 *     spacetrack-gp; anything else => our fit, provider = the tag);
 *   - else (untagged) fall back to the record's USER_DEFINED_SDN_SOURCE_NAME
 *     (=> our fit); a bare OMM with neither is treated as an authoritative
 *     catalog input (spacetrack-gp kind).
 *
 * Nothing here fabricates data: an unreadable/unknown record is skipped with a
 * reason, and a record with no NORAD is surfaced for quarantine (never keyed 0).
 */
#ifndef SDN_CATALOG_SYNTHESIS_OMM_READER_HPP
#define SDN_CATALOG_SYNTHESIS_OMM_READER_HPP

#include <stdint.h>
#include <string.h>
#include <string>
#include <vector>

#include "provider_source.hpp"        // ps::json_string_field, base64, sha256, json_escape, double_to_json
#include "sds/OMM_generated.h"        // SDS OMM FlatBuffer reader (GetOMM / OMMIdentifier "$OMM")

namespace catsyn {

namespace ps = provider_source;

// ── source classification ────────────────────────────────────────────────────

enum class SourceKind { OursFit, SpacetrackGp };

// ── canonical, decision-ready view of one stored OMM record ──────────────────

struct CanonOmm {
    bool valid = false;
    std::string skip_reason;        // set when !valid

    SourceKind kind = SourceKind::SpacetrackGp;
    std::string provider;           // registry token (our fit) or ST source name
    std::string cid;                // storage.query record CID (== stored content id)

    long norad = 0;                 // NORAD_CAT_ID; 0 => unmapped / absent
    std::string object_name;
    std::string epoch_iso;          // raw EPOCH string (sourced timestamp)
    std::string epoch_key;          // normalized comparable key (chronological lexical)
    std::string id_status;          // our fit: USER_DEFINED_SDN_ID_STATUS; ST: "source"

    // Complete schema-exact OMM JSON object (ends with '}'). For our fits this is
    // the stored JSON verbatim (already schema-exact + carries fit lineage); for
    // Space-Track it is re-serialized from the $OMM FlatBuffer. The synthesis
    // step appends catalog provenance before the closing brace.
    std::string omm_json;

    // Our-fit lineage passthrough (empty for Space-Track records).
    std::string fit_source_cid;
    std::string fit_source_sha256;
    std::string fit_rms;
    bool fit_converged = false;
};

// ── small JSON helpers (number-or-string tolerant) ───────────────────────────

// Reads an integer field whose value may be a bare number (5) or a quoted string
// ("5") — Space-Track GP JSON quotes everything, our fitted JSON does not.
inline bool json_long_field(const std::string& json, const std::string& key, long* out) {
    std::string needle = "\"" + key + "\"";
    size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
    while (i < json.size() && (json[i] == ' ' || json[i] == '\t' || json[i] == '\n' || json[i] == '\r')) i++;
    if (i < json.size() && json[i] == '"') i++;  // tolerate quoted number
    char* end = nullptr;
    long v = strtol(json.c_str() + i, &end, 10);
    if (end == json.c_str() + i) return false;
    *out = v;
    return true;
}

inline bool json_has_key(const std::string& json, const std::string& key) {
    return json.find("\"" + key + "\"") != std::string::npos;
}

// ── epoch normalization → chronological, lexically-comparable key ────────────
// "YYYY-MM-DD[ T]HH:MM:SS[.ffffff][Z]" (or date-only) -> "YYYYMMDDHHMMSS.ffffff".
// Robust to the 'T'/' ' separator, a trailing 'Z', and a variable fractional
// length. Fixed-width fields make plain string comparison chronological. On a
// parse miss it returns the raw string (still deterministic).
inline std::string normalize_epoch(const std::string& iso) {
    int y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0;
    int n = sscanf(iso.c_str(), "%d-%d-%d%*[ T]%d:%d:%d", &y, &mo, &d, &h, &mi, &s);
    if (n < 3) return iso;  // not a recognizable ISO date — deterministic fallback
    std::string frac;
    size_t dot = iso.find('.');
    if (dot != std::string::npos) {
        for (size_t i = dot + 1; i < iso.size() && frac.size() < 6; ++i) {
            char c = iso[i];
            if (c < '0' || c > '9') break;
            frac.push_back(c);
        }
    }
    while (frac.size() < 6) frac.push_back('0');
    char buf[40];
    snprintf(buf, sizeof(buf), "%04d%02d%02d%02d%02d%02d.%s", y, mo, d, h, mi, s, frac.c_str());
    return std::string(buf);
}

// ── encoding detection ───────────────────────────────────────────────────────

enum class Encoding { Unknown, Json, FlatbufferOmm };

inline Encoding detect_encoding(const std::vector<uint8_t>& data) {
    size_t i = 0;
    while (i < data.size() && (data[i] == ' ' || data[i] == '\t' || data[i] == '\n' || data[i] == '\r')) i++;
    if (i < data.size() && data[i] == '{') return Encoding::Json;
    // FlatBuffer file identifier "$OMM" sits at byte offset 4 (standard finish)
    // or 8 (size-prefixed). Match either so both host framings decode.
    if (data.size() >= 8 && memcmp(data.data() + 4, "$OMM", 4) == 0) return Encoding::FlatbufferOmm;
    if (data.size() >= 12 && memcmp(data.data() + 8, "$OMM", 4) == 0) return Encoding::FlatbufferOmm;
    return Encoding::Unknown;
}

// ── classification (tag-first, USER_DEFINED fallback) ────────────────────────

inline bool is_spacetrack_source(const std::string& name, const std::vector<std::string>& st_names) {
    for (const std::string& n : st_names)
        if (n == name) return true;
    return false;
}

// ── FlatBuffer $OMM -> schema-exact OMM JSON ─────────────────────────────────

inline std::string fb_string(const flatbuffers::String* s) { return s ? s->str() : std::string(); }

// Re-serialize a Space-Track $OMM FlatBuffer into schema-exact OMM JSON. Only the
// fields the Go ingestGPRows builder actually populates are emitted; TEME/UTC/
// SGP4/EARTH are the invariant frame/time/theory/center of 18 SPCS GP records and
// are emitted as documented constants (not fabricated — that IS what a Space-Track
// GP record is; the fixture gp JSON confirms REF_FRAME/TIME_SYSTEM/theory).
inline std::string flatbuffer_omm_to_json(const OMM* o) {
    std::string j = "{";
    j += "\"CCSDS_OMM_VERS\":\"3.0\",";
    if (o->COMMENT()) j += "\"COMMENT\":[\"" + ps::json_escape(o->COMMENT()->str()) + "\"],";
    if (o->ORIGINATOR()) j += "\"ORIGINATOR\":\"" + ps::json_escape(o->ORIGINATOR()->str()) + "\",";
    j += "\"OBJECT_NAME\":\"" + ps::json_escape(fb_string(o->OBJECT_NAME())) + "\",";
    j += "\"OBJECT_ID\":\"" + ps::json_escape(fb_string(o->OBJECT_ID())) + "\",";
    j += "\"CENTER_NAME\":\"" + ps::json_escape(o->CENTER_NAME() ? o->CENTER_NAME()->str() : std::string("EARTH")) + "\",";
    j += "\"REF_FRAME\":\"TEME\",";
    j += "\"TIME_SYSTEM\":\"UTC\",";
    j += "\"MEAN_ELEMENT_THEORY\":\"SGP4\",";
    j += "\"EPOCH\":\"" + ps::json_escape(fb_string(o->EPOCH())) + "\",";
    j += "\"MEAN_MOTION\":" + ps::double_to_json(o->MEAN_MOTION()) + ",";
    j += "\"ECCENTRICITY\":" + ps::double_to_json(o->ECCENTRICITY()) + ",";
    j += "\"INCLINATION\":" + ps::double_to_json(o->INCLINATION()) + ",";
    j += "\"RA_OF_ASC_NODE\":" + ps::double_to_json(o->RA_OF_ASC_NODE()) + ",";
    j += "\"ARG_OF_PERICENTER\":" + ps::double_to_json(o->ARG_OF_PERICENTER()) + ",";
    j += "\"MEAN_ANOMALY\":" + ps::double_to_json(o->MEAN_ANOMALY()) + ",";
    j += "\"EPHEMERIS_TYPE\":0,";
    if (o->CLASSIFICATION_TYPE())
        j += "\"CLASSIFICATION_TYPE\":\"" + ps::json_escape(o->CLASSIFICATION_TYPE()->str()) + "\",";
    j += "\"NORAD_CAT_ID\":" + std::to_string(o->NORAD_CAT_ID()) + ",";
    j += "\"ELEMENT_SET_NO\":" + std::to_string(o->ELEMENT_SET_NO()) + ",";
    j += "\"REV_AT_EPOCH\":" + std::to_string(static_cast<long long>(o->REV_AT_EPOCH())) + ",";
    j += "\"BSTAR\":" + ps::double_to_json(o->BSTAR()) + ",";
    j += "\"MEAN_MOTION_DOT\":" + ps::double_to_json(o->MEAN_MOTION_DOT()) + ",";
    j += "\"MEAN_MOTION_DDOT\":" + ps::double_to_json(o->MEAN_MOTION_DDOT());
    j += "}";
    return j;
}

// ── the reader ───────────────────────────────────────────────────────────────
// Fills `out`. Returns false with out->skip_reason set for records that cannot
// be turned into a catalog candidate (unknown encoding, malformed FlatBuffer,
// missing EPOCH). A record with no NORAD is returned valid=true with norad==0 so
// the caller can quarantine it (never key it as NORAD 0).

inline bool read_stored_omm(const std::string& cid,
                            const std::string& tag_source_name,
                            const std::vector<uint8_t>& data,
                            const std::vector<std::string>& st_names,
                            CanonOmm* out) {
    out->cid = cid;
    Encoding enc = detect_encoding(data);

    if (enc == Encoding::Json) {
        std::string json(data.begin(), data.end());
        // trim trailing whitespace so provenance can be appended before '}'
        size_t end = json.find_last_not_of(" \t\r\n");
        if (end == std::string::npos || json[end] != '}') {
            out->skip_reason = "malformed-json-omm";
            return false;
        }
        json.erase(end + 1);

        std::string ud_source, ud_status;
        ps::json_string_field(json, "USER_DEFINED_SDN_SOURCE_NAME", &ud_source);
        ps::json_string_field(json, "USER_DEFINED_SDN_ID_STATUS", &ud_status);

        // classification: tags first, then USER_DEFINED fallback.
        if (!tag_source_name.empty()) {
            if (is_spacetrack_source(tag_source_name, st_names)) {
                out->kind = SourceKind::SpacetrackGp;
                out->provider = tag_source_name;
            } else {
                out->kind = SourceKind::OursFit;
                out->provider = tag_source_name;
            }
        } else if (!ud_source.empty()) {
            out->kind = SourceKind::OursFit;
            out->provider = ud_source;
        } else {
            out->kind = SourceKind::SpacetrackGp;
            out->provider = st_names.empty() ? std::string("spacetrack-gp") : st_names[0];
        }

        long norad = 0;
        json_long_field(json, "NORAD_CAT_ID", &norad);
        out->norad = norad;
        ps::json_string_field(json, "OBJECT_NAME", &out->object_name);
        if (!ps::json_string_field(json, "EPOCH", &out->epoch_iso) || out->epoch_iso.empty()) {
            out->skip_reason = "missing-epoch";
            return false;
        }
        out->epoch_key = normalize_epoch(out->epoch_iso);
        out->id_status = ud_status.empty() ? std::string("source") : ud_status;
        if (out->kind == SourceKind::OursFit) {
            ps::json_string_field(json, "USER_DEFINED_SDN_SOURCE_CID", &out->fit_source_cid);
            ps::json_string_field(json, "USER_DEFINED_SDN_SOURCE_SHA256", &out->fit_source_sha256);
            ps::json_string_field(json, "RMS", &out->fit_rms);
            out->fit_converged = json.find("\"CONVERGED\":true") != std::string::npos;
        }
        out->omm_json = json;
        out->valid = true;
        return true;
    }

    if (enc == Encoding::FlatbufferOmm) {
        // Verify before reading — fail closed on a malformed buffer.
        const uint8_t* buf = data.data();
        size_t len = data.size();
        bool size_prefixed = (len >= 12 && memcmp(buf + 8, "$OMM", 4) == 0 &&
                              !(len >= 8 && memcmp(buf + 4, "$OMM", 4) == 0));
        flatbuffers::Verifier verifier(buf, len);
        const OMM* o = nullptr;
        if (size_prefixed) {
            if (!VerifySizePrefixedOMMBuffer(verifier)) { out->skip_reason = "malformed-flatbuffer-omm"; return false; }
            o = GetSizePrefixedOMM(buf);
        } else {
            if (!VerifyOMMBuffer(verifier)) { out->skip_reason = "malformed-flatbuffer-omm"; return false; }
            o = GetOMM(buf);
        }
        if (o == nullptr) { out->skip_reason = "malformed-flatbuffer-omm"; return false; }

        // classification: FlatBuffer OMM carries no SDN fit lineage, so tags decide
        // (Space-Track lane tags it spacetrack-gp). An untagged bare $OMM is an
        // authoritative catalog input (spacetrack-gp kind).
        if (!tag_source_name.empty() && !is_spacetrack_source(tag_source_name, st_names)) {
            // A non-Space-Track tag on a FlatBuffer OMM: attribute to that provider.
            out->kind = SourceKind::OursFit;
            out->provider = tag_source_name;
        } else {
            out->kind = SourceKind::SpacetrackGp;
            out->provider = tag_source_name.empty()
                                ? (st_names.empty() ? std::string("spacetrack-gp") : st_names[0])
                                : tag_source_name;
        }

        out->norad = static_cast<long>(o->NORAD_CAT_ID());
        out->object_name = fb_string(o->OBJECT_NAME());
        out->epoch_iso = fb_string(o->EPOCH());
        if (out->epoch_iso.empty()) { out->skip_reason = "missing-epoch"; return false; }
        out->epoch_key = normalize_epoch(out->epoch_iso);
        out->id_status = "source";
        out->omm_json = flatbuffer_omm_to_json(o);
        out->valid = true;
        return true;
    }

    out->skip_reason = "unknown-encoding";
    return false;
}

}  // namespace catsyn

#endif  // SDN_CATALOG_SYNTHESIS_OMM_READER_HPP
