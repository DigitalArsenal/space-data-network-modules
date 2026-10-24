/*
 * files/orbit-products — Sentinel Earth Explorer orbit files (EOF).
 *
 * The ESA Copernicus POD service publishes the precise (AUX_POEORB), restituted
 * (AUX_RESORB) and predicted (AUX_PREORB) orbits of Sentinel-1/2/3 as an XML
 * "Earth Explorer File": a Fixed_Header naming the file, the mission and its
 * validity, a Variable_Header naming the reference frame and the time
 * reference, and a Data_Block holding a List_of_OSVs, one orbit state vector
 * (OSV) per epoch. Positions are metres and velocities metres per second in
 * the file's own Earth-fixed frame.
 *
 * THIS IS A READER FOR THE FORMAT AS ESA PUBLISHES IT, AND IT IS STRICT.
 * Nothing is completed with a guess: an element the reader does not know is
 * refused by name (a new element may mean a new unit or a new frame, and a
 * silently ignored one would be read as the old meaning); a unit other than
 * `m` and `m/s` is refused; a `Time_Reference` the OSVs carry no stamp for is
 * refused; an OSV count that disagrees with the `count` attribute is refused
 * (a truncated download is the usual cause). Epochs stay as the text the file
 * wrote, on the time reference it named: there is no time-scale conversion
 * here, per the spine's rule.
 *
 * WHAT THE RECORD DOES NOT CARRY. `$OEM` has a column for none of the
 * per-OSV TAI and UT1 stamps (the epoch is the one stamp on the file's
 * Time_Reference), the absolute orbit number or the Quality flag. The reader
 * counts the flags it saw and the orbit-number range, and the module states
 * both in the block COMMENT, so the loss is declared rather than silent.
 */

#ifndef ORBIT_PRODUCTS_SENTINEL_EOF_HPP
#define ORBIT_PRODUCTS_SENTINEL_EOF_HPP

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "pugixml.hpp"

namespace eof {

/* A refusal is a stable code plus the sentence that names what was wrong, the
 * same shape files/ccsds-messages uses. */
struct Refusal {
    std::string code;
    std::string message;
};

struct Osv {
    std::string epoch;       /* the stamp on the Time_Reference, prefix removed */
    double pos_km[3] = {0.0, 0.0, 0.0};
    double vel_kms[3] = {0.0, 0.0, 0.0};
    std::string quality;
    bool has_orbit = false;
    long long absolute_orbit = 0;
};

struct File {
    std::string file_name, file_description, notes, mission, file_class, file_type;
    std::string validity_start, validity_stop, file_version;
    std::string system, creator, creator_version, creation_date;
    std::string ref_frame, time_reference;
    size_t declared_count = 0;
    std::vector<Osv> osvs;
};

namespace detail {

inline std::string local_name(const char* qualified) {
    const char* colon = std::strrchr(qualified, ':');
    return colon ? std::string(colon + 1) : std::string(qualified);
}

inline std::string trim(const std::string& s) {
    size_t a = 0, b = s.size();
    while (a < b && (s[a] == ' ' || s[a] == '\t' || s[a] == '\r' || s[a] == '\n')) ++a;
    while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t' || s[b - 1] == '\r' || s[b - 1] == '\n')) --b;
    return s.substr(a, b - a);
}

inline std::string text_of(const pugi::xml_node& el) {
    std::string out;
    for (pugi::xml_node c = el.first_child(); c; c = c.next_sibling()) {
        if (c.type() == pugi::node_pcdata || c.type() == pugi::node_cdata) out += c.value();
    }
    return trim(out);
}

inline bool has_element_child(const pugi::xml_node& el) {
    for (pugi::xml_node c = el.first_child(); c; c = c.next_sibling()) {
        if (c.type() == pugi::node_element) return true;
    }
    return false;
}

inline bool fail(Refusal* r, const char* code, const std::string& message) {
    if (r) {
        r->code = code;
        r->message = message;
    }
    return false;
}

/* Strict number: the whole text, finite, no trailing characters. */
inline bool to_double(const std::string& text, double* out) {
    if (text.empty()) return false;
    char* end = nullptr;
    const double v = std::strtod(text.c_str(), &end);
    if (end == text.c_str() || *end != '\0' || !std::isfinite(v)) return false;
    *out = v;
    return true;
}

inline bool to_integer(const std::string& text, long long* out) {
    if (text.empty()) return false;
    char* end = nullptr;
    const long long v = std::strtoll(text.c_str(), &end, 10);
    if (end == text.c_str() || *end != '\0') return false;
    *out = v;
    return true;
}

/* A stamp is `<REFERENCE>=<ISO-8601 text>`. The reference must be the one the
 * Variable_Header named, so a file whose stamps disagree with its own header is
 * refused instead of read as whichever one was convenient. */
inline bool strip_stamp(const std::string& text, const std::string& reference,
                        std::string* out) {
    const std::string prefix = reference + "=";
    if (text.size() <= prefix.size() || text.compare(0, prefix.size(), prefix) != 0) return false;
    *out = text.substr(prefix.size());
    return true;
}

/* The Fixed_Header elements that are text, in the order the schema lists them. */
struct TextSlot {
    const char* name;
    std::string File::*member;
};

}  // namespace detail

/* Seconds are not needed here: the module compares epoch text through the
 * calendar arithmetic of the OEM reader. This reads the whole document. */
inline bool parse(const char* bytes, size_t length, File* out, Refusal* refusal) {
    using namespace detail;
    *out = File{};
    if (!bytes || length == 0) return fail(refusal, "bad-xml", "The file is empty.");

    /* UTF-8 text only: a control character other than white space is not XML. */
    for (size_t i = 0; i < length; ++i) {
        const unsigned char c = static_cast<unsigned char>(bytes[i]);
        if (c < 0x20 && c != '\t' && c != '\n' && c != '\r') {
            return fail(refusal, "bad-encoding",
                        "The file holds a control character; an Earth Explorer File is UTF-8 text.");
        }
    }

    pugi::xml_document doc;
    const pugi::xml_parse_result parsed = doc.load_buffer(bytes, length, pugi::parse_default);
    if (!parsed) {
        char message[256];
        std::snprintf(message, sizeof(message), "The XML does not parse: %s at byte %lld.",
                      parsed.description(), static_cast<long long>(parsed.offset));
        return fail(refusal, "bad-xml", message);
    }

    pugi::xml_node root;
    for (pugi::xml_node c = doc.first_child(); c; c = c.next_sibling()) {
        if (c.type() != pugi::node_element) continue;
        if (root) return fail(refusal, "bad-xml", "The document has more than one root element.");
        root = c;
    }
    if (!root || local_name(root.name()) != "Earth_Explorer_File") {
        return fail(refusal, "wrong-file-type",
                    "The root element is not Earth_Explorer_File; this is not an ESA Earth Explorer "
                    "orbit file.");
    }

    pugi::xml_node header, block;
    for (pugi::xml_node c = root.first_child(); c; c = c.next_sibling()) {
        if (c.type() != pugi::node_element) continue;
        const std::string name = local_name(c.name());
        if (name == "Earth_Explorer_Header" && !header) header = c;
        else if (name == "Data_Block" && !block) block = c;
        else {
            return fail(refusal, "unknown-element",
                        "Earth_Explorer_File holds <" + name + ">, which this reader does not know; "
                        "it is refused rather than ignored.");
        }
    }
    if (!header) return fail(refusal, "missing-element", "Earth_Explorer_Header is missing.");
    if (!block) return fail(refusal, "missing-element", "Data_Block is missing.");

    /* ---- Fixed_Header -------------------------------------------------- */
    pugi::xml_node fixed, variable;
    for (pugi::xml_node c = header.first_child(); c; c = c.next_sibling()) {
        if (c.type() != pugi::node_element) continue;
        const std::string name = local_name(c.name());
        if (name == "Fixed_Header" && !fixed) fixed = c;
        else if (name == "Variable_Header" && !variable) variable = c;
        else {
            return fail(refusal, "unknown-element",
                        "Earth_Explorer_Header holds <" + name + ">, which this reader does not know.");
        }
    }
    if (!fixed) return fail(refusal, "missing-element", "Fixed_Header is missing.");
    if (!variable) return fail(refusal, "missing-element", "Variable_Header is missing.");

    static const TextSlot kFixed[] = {
        {"File_Name", &File::file_name},       {"File_Description", &File::file_description},
        {"Notes", &File::notes},               {"Mission", &File::mission},
        {"File_Class", &File::file_class},     {"File_Type", &File::file_type},
        {"File_Version", &File::file_version},
    };
    static const TextSlot kSource[] = {
        {"System", &File::system},
        {"Creator", &File::creator},
        {"Creator_Version", &File::creator_version},
        {"Creation_Date", &File::creation_date},
    };
    for (pugi::xml_node c = fixed.first_child(); c; c = c.next_sibling()) {
        if (c.type() != pugi::node_element) continue;
        const std::string name = local_name(c.name());
        bool known = false;
        for (const TextSlot& slot : kFixed) {
            if (name == slot.name) {
                out->*(slot.member) = text_of(c);
                known = true;
                break;
            }
        }
        if (known) continue;
        if (name == "Validity_Period") {
            for (pugi::xml_node v = c.first_child(); v; v = v.next_sibling()) {
                if (v.type() != pugi::node_element) continue;
                const std::string vn = local_name(v.name());
                if (vn == "Validity_Start") out->validity_start = text_of(v);
                else if (vn == "Validity_Stop") out->validity_stop = text_of(v);
                else {
                    return fail(refusal, "unknown-element",
                                "Validity_Period holds <" + vn + ">, which this reader does not know.");
                }
            }
            continue;
        }
        if (name == "Source") {
            for (pugi::xml_node v = c.first_child(); v; v = v.next_sibling()) {
                if (v.type() != pugi::node_element) continue;
                const std::string vn = local_name(v.name());
                bool source_known = false;
                for (const TextSlot& slot : kSource) {
                    if (vn == slot.name) {
                        out->*(slot.member) = text_of(v);
                        source_known = true;
                        break;
                    }
                }
                if (!source_known) {
                    return fail(refusal, "unknown-element",
                                "Source holds <" + vn + ">, which this reader does not know.");
                }
            }
            continue;
        }
        return fail(refusal, "unknown-element",
                    "Fixed_Header holds <" + name + ">, which this reader does not know.");
    }
    if (out->file_type.empty()) return fail(refusal, "missing-element", "File_Type is missing.");

    /* ---- Variable_Header ------------------------------------------------ */
    for (pugi::xml_node c = variable.first_child(); c; c = c.next_sibling()) {
        if (c.type() != pugi::node_element) continue;
        const std::string name = local_name(c.name());
        if (name == "Ref_Frame") out->ref_frame = text_of(c);
        else if (name == "Time_Reference") out->time_reference = text_of(c);
        else {
            return fail(refusal, "unknown-element",
                        "Variable_Header holds <" + name + ">, which this reader does not know.");
        }
    }
    if (out->ref_frame.empty()) return fail(refusal, "missing-element", "Ref_Frame is missing.");
    if (out->time_reference.empty()) {
        return fail(refusal, "missing-element", "Time_Reference is missing.");
    }
    if (out->time_reference != "UTC" && out->time_reference != "TAI" &&
        out->time_reference != "UT1") {
        return fail(refusal, "unsupported-time-reference",
                    "Time_Reference \"" + out->time_reference + "\" has no stamp on the OSVs; an OSV "
                    "carries TAI, UTC and UT1 and nothing else, and no scale is converted here.");
    }

    /* ---- Data_Block ------------------------------------------------------ */
    pugi::xml_node list;
    for (pugi::xml_node c = block.first_child(); c; c = c.next_sibling()) {
        if (c.type() != pugi::node_element) continue;
        const std::string name = local_name(c.name());
        if (name == "List_of_OSVs" && !list) list = c;
        else {
            return fail(refusal, "unknown-element",
                        "Data_Block holds <" + name + ">, which this reader does not know; this "
                        "reader reads the OSV list only.");
        }
    }
    if (!list) return fail(refusal, "missing-element", "List_of_OSVs is missing.");
    {
        const pugi::xml_attribute count = list.attribute("count");
        if (!count) return fail(refusal, "missing-element", "List_of_OSVs has no count attribute.");
        long long declared = 0;
        if (!to_integer(count.value(), &declared) || declared < 0) {
            return fail(refusal, "bad-value",
                        std::string("List_of_OSVs count \"") + count.value() + "\" is not a count.");
        }
        out->declared_count = static_cast<size_t>(declared);
    }

    static const char* const kCoord[] = {"X", "Y", "Z"};
    static const char* const kVel[] = {"VX", "VY", "VZ"};
    size_t index = 0;
    for (pugi::xml_node osv = list.first_child(); osv; osv = osv.next_sibling()) {
        if (osv.type() != pugi::node_element) continue;
        const std::string osv_name = local_name(osv.name());
        char where[48];
        std::snprintf(where, sizeof(where), "OSV %zu", index + 1);
        if (osv_name != "OSV") {
            return fail(refusal, "unknown-element",
                        "List_of_OSVs holds <" + osv_name + ">, which is not an OSV.");
        }
        Osv state;
        bool have_stamp = false, have[6] = {false, false, false, false, false, false};
        for (pugi::xml_node c = osv.first_child(); c; c = c.next_sibling()) {
            if (c.type() != pugi::node_element) continue;
            const std::string name = local_name(c.name());
            const std::string text = text_of(c);
            if (name == "TAI" || name == "UTC" || name == "UT1") {
                /* Every stamp must carry the reference it names; only the one on
                 * the file's Time_Reference becomes the epoch. */
                std::string stamp;
                if (!strip_stamp(text, name, &stamp)) {
                    return fail(refusal, "bad-value", std::string(where) + ": <" + name + "> \"" + text +
                                "\" is not \"" + name + "=<ISO 8601 time>\".");
                }
                if (name == out->time_reference) {
                    state.epoch = stamp;
                    have_stamp = true;
                }
                continue;
            }
            if (name == "Absolute_Orbit") {
                long long orbit = 0;
                if (!to_integer(text, &orbit)) {
                    return fail(refusal, "bad-value", std::string(where) +
                                ": Absolute_Orbit \"" + text + "\" is not an integer.");
                }
                state.has_orbit = true;
                state.absolute_orbit = orbit;
                continue;
            }
            if (name == "Quality") {
                state.quality = text;
                continue;
            }
            int slot = -1;
            bool is_velocity = false;
            for (int k = 0; k < 3; ++k) {
                if (name == kCoord[k]) { slot = k; }
                if (name == kVel[k]) { slot = k; is_velocity = true; }
            }
            if (slot < 0) {
                return fail(refusal, "unknown-element",
                            std::string(where) + ": <" + name + "> is not an OSV element this reader knows.");
            }
            if (has_element_child(c)) {
                return fail(refusal, "bad-value", std::string(where) + ": <" + name + "> holds elements.");
            }
            const pugi::xml_attribute unit = c.attribute("unit");
            const char* expected = is_velocity ? "m/s" : "m";
            if (!unit || std::strcmp(unit.value(), expected) != 0) {
                return fail(refusal, "unsupported-unit", std::string(where) + ": <" + name + "> unit \"" +
                            (unit ? unit.value() : "") + "\" is not \"" + expected + "\".");
            }
            double v = 0.0;
            if (!to_double(text, &v)) {
                return fail(refusal, "bad-value", std::string(where) + ": <" + name + "> \"" + text +
                            "\" is not a number.");
            }
            const int cell = (is_velocity ? 3 : 0) + slot;
            if (have[cell]) {
                return fail(refusal, "duplicate-element", std::string(where) + ": <" + name + "> is stated twice.");
            }
            have[cell] = true;
            /* Metres to the series' kilometres: one division, the same operation
             * the independent reference performs, so the doubles agree bit for bit. */
            if (is_velocity) state.vel_kms[slot] = v / 1000.0;
            else state.pos_km[slot] = v / 1000.0;
        }
        if (!have_stamp) {
            return fail(refusal, "missing-element", std::string(where) + ": no <" + out->time_reference +
                        "> stamp, which is the file's Time_Reference.");
        }
        for (int k = 0; k < 6; ++k) {
            if (!have[k]) {
                return fail(refusal, "missing-element", std::string(where) + ": <" +
                            (k < 3 ? kCoord[k] : kVel[k - 3]) + "> is missing.");
            }
        }
        out->osvs.push_back(state);
        ++index;
    }

    if (out->osvs.empty()) {
        return fail(refusal, "missing-element", "List_of_OSVs holds no OSV; there is no orbit to read.");
    }
    if (out->osvs.size() != out->declared_count) {
        char message[200];
        std::snprintf(message, sizeof(message),
                      "List_of_OSVs declares count=%zu and holds %zu OSVs; the file is not whole.",
                      out->declared_count, out->osvs.size());
        return fail(refusal, "inconsistent-message", message);
    }
    return true;
}

}  // namespace eof

#endif  // ORBIT_PRODUCTS_SENTINEL_EOF_HPP
