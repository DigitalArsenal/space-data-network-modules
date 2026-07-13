/**
 * CCSDS OEM (502.0-B) KVN text parser.
 *
 * Produces the common StateSeries in TEME. EME2000/J2000/GCRF segments are
 * rotated to TEME; unsupported frames / time systems / centers fail closed with
 * a precise error code (correctness over coverage).
 */

#include "od/oem_parser.h"

#include "od/frame_transform.h"
#include "od/meme_parser.h"  // iso_to_jd

#include <algorithm>
#include <cctype>
#include <sstream>
#include <string>
#include <vector>

namespace od {

namespace {

std::string trim(const std::string& s) {
    auto start = s.find_first_not_of(" \t\r\n");
    auto end = s.find_last_not_of(" \t\r\n");
    return (start == std::string::npos) ? std::string() : s.substr(start, end - start + 1);
}

std::string to_upper(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
    return s;
}

// Metadata harvested from a single META block.
struct SegmentMeta {
    std::string object_name;
    std::string object_id;
    std::string center_name;    // raw, as written
    std::string ref_frame;      // upper-cased token
    std::string time_system;    // upper-cased token
};

OEMParseResult fail(const char* code, std::string message) {
    OEMParseResult r;
    r.ok = false;
    r.error_code = code;
    r.error_message = std::move(message);
    return r;
}

}  // namespace

bool looks_like_oem(const std::string& content) {
    // KVN OEM always carries the version line and META blocks; a MEME file has
    // neither. Sniff the first ~2 KB so we do not scan large payloads.
    const std::string head = content.substr(0, std::min<size_t>(content.size(), 2048));
    return head.find("CCSDS_OEM_VERS") != std::string::npos ||
           head.find("META_START") != std::string::npos;
}

OEMParseResult parse_oem(const std::string& content) {
    OEMParseResult result;
    StateSeries& series = result.series;

    std::istringstream stream(content);
    std::string line;

    bool in_meta = false;
    bool in_data = false;
    int segment_count = 0;
    bool have_identity = false;
    SegmentMeta seg{};

    while (std::getline(stream, line)) {
        std::string t = trim(line);
        if (t.empty()) continue;
        if (t.rfind("COMMENT", 0) == 0) continue;

        if (t == "META_START") {
            in_meta = true;
            in_data = false;
            seg = SegmentMeta{};
            continue;
        }
        if (t == "META_STOP") {
            in_meta = false;
            in_data = true;
            segment_count += 1;

            // Validate this segment's frame / time system / center, fail closed.
            const std::string frame = to_upper(seg.ref_frame);
            const std::string time_sys = to_upper(seg.time_system);
            const std::string center = to_upper(seg.center_name);

            if (time_sys.empty()) {
                return fail("parse-failed",
                            "OEM segment is missing TIME_SYSTEM.");
            }
            if (time_sys != "UTC") {
                return fail("unsupported-time-system",
                            "OEM TIME_SYSTEM=" + seg.time_system +
                                " is not supported (UTC only).");
            }
            if (center.empty()) {
                return fail("parse-failed", "OEM segment is missing CENTER_NAME.");
            }
            if (center != "EARTH") {
                return fail("unsupported-center",
                            "OEM CENTER_NAME=" + seg.center_name +
                                " is not supported (EARTH only).");
            }
            if (frame.empty()) {
                return fail("parse-failed", "OEM segment is missing REF_FRAME.");
            }
            const bool is_teme = (frame == "TEME");
            const bool is_j2000 =
                (frame == "EME2000" || frame == "J2000" || frame == "GCRF");
            if (!is_teme && !is_j2000) {
                return fail("unsupported-frame",
                            "OEM REF_FRAME=" + seg.ref_frame +
                                " is not supported (TEME or EME2000/J2000/GCRF only).");
            }

            // Identity comes from the first segment; later segments must agree
            // on OBJECT_ID (maneuver-split ephemerides of one object).
            if (!have_identity) {
                series.meta.object_name = seg.object_name;
                series.meta.object_id = seg.object_id;
                series.meta.center_name = center;
                series.meta.ref_frame = "TEME";
                series.meta.source_frame = frame;
                series.meta.time_system = time_sys;
                have_identity = true;
            } else if (!seg.object_id.empty() && !series.meta.object_id.empty() &&
                       seg.object_id != series.meta.object_id) {
                return fail("inconsistent-segments",
                            "OEM segments mix OBJECT_ID " + series.meta.object_id +
                                " and " + seg.object_id + " in one file.");
            }
            continue;
        }

        if (in_meta) {
            const auto eq = t.find('=');
            if (eq == std::string::npos) continue;
            const std::string key = to_upper(trim(t.substr(0, eq)));
            const std::string value = trim(t.substr(eq + 1));
            if (key == "OBJECT_NAME") seg.object_name = value;
            else if (key == "OBJECT_ID") seg.object_id = value;
            else if (key == "CENTER_NAME") seg.center_name = value;
            else if (key == "REF_FRAME") seg.ref_frame = value;
            else if (key == "TIME_SYSTEM") seg.time_system = value;
            continue;
        }

        if (in_data) {
            // Any residual "KEY = VALUE" (e.g. covariance blocks) is not a state
            // line; state lines start with an ISO epoch token.
            if (t.find('=') != std::string::npos) continue;

            std::istringstream ls(t);
            std::string epoch_tok;
            double x, y, z, vx, vy, vz;
            if (!(ls >> epoch_tok >> x >> y >> z >> vx >> vy >> vz)) {
                continue;  // malformed / short line
            }
            const double jd = iso_to_jd(epoch_tok);
            if (jd == 0.0) continue;  // unparseable epoch

            EphemerisPoint pt{};
            pt.epoch_jd = jd;
            pt.timestamp_str = epoch_tok;
            pt.has_covariance = false;

            if (to_upper(series.meta.source_frame) == "TEME") {
                pt.x = x; pt.y = y; pt.z = z;
                pt.vx = vx; pt.vy = vy; pt.vz = vz;
            } else {
                const double r_in[3] = {x, y, z};
                const double v_in[3] = {vx, vy, vz};
                double r_out[3], v_out[3];
                eci_j2000_to_teme(jd, r_in, v_in, r_out, v_out);
                pt.x = r_out[0]; pt.y = r_out[1]; pt.z = r_out[2];
                pt.vx = v_out[0]; pt.vy = v_out[1]; pt.vz = v_out[2];
            }
            series.samples.push_back(pt);
            continue;
        }
        // Lines before the first META_START (header: CCSDS_OEM_VERS,
        // CREATION_DATE, ORIGINATOR) carry no series data; ignore.
    }

    if (in_meta) {
        return fail("parse-failed", "OEM ended inside a META block (missing META_STOP).");
    }
    if (segment_count == 0 || !have_identity) {
        return fail("parse-failed", "OEM contained no valid META/data segment.");
    }
    if (series.samples.empty()) {
        return fail("empty-ephemeris", "OEM contained no parseable state vectors.");
    }

    series.meta.segment_count = segment_count;
    result.ok = true;
    return result;
}

}  // namespace od
