/**
 * CDM FlatBuffers Output — Serialize ConjunctionEvent to CCSDS CDM
 *
 * Uses spacedatastandards.org CDM schema with $CDM file identifier.
 * Output is canonical variable-size FlatBuffers binary for SDS transport.
 */

#include "conjunction/conjunction_assessment.h"
#include "conjunction/cdm_builder.h"
#include "conjunction/conjunction_engine.h"
#include "conjunction/encounter_geometry.h"
#ifdef SING
#undef SING
#endif
#ifdef DOMAIN
#undef DOMAIN
#endif
#include "CDM_generated.h"
#include "conjunction/error_status.h"
#include "flatbuffers/flatbuffers.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstring>
#include <sstream>
#include <iomanip>
#include <ctime>
#include <cmath>
#include <memory>
#include <stdexcept>

#include "conjunction/cdm_fields.h"

namespace conjunction {
namespace cdm_parse_detail {

struct ParsedCdmObject {
    std::string label;
    std::string comment;
    std::string object_designator;
    std::string catalog_name;
    CDMObjectT extra;
    std::string object_name;
    std::string object_id;
    std::string ephemeris_name;
    std::string ref_frame;
    spaceObjectClass object_type = spaceObjectClass::UNKNOWN;
    covarianceAlgorithm covariance_method = covarianceAlgorithm::CALCULATED;
    bool has_covariance_method = false;
    cdmManeuverable maneuverable = cdmManeuverable::UNSPECIFIED;
    double x = 0.0;
    double y = 0.0;
    double z = 0.0;
    double x_dot = 0.0;
    double y_dot = 0.0;
    double z_dot = 0.0;
    std::vector<double> covariance;
    std::array<bool, 45> covariance_present{};
};

struct ParsedCdm {
    double version = 0.0;
    std::string creation_date;
    std::string originator;
    std::string message_for;
    std::string message_id;
    std::string tca;
    double miss_distance_km = 0.0;
    double relative_speed_kms = 0.0;
    double rel_pos_r_km = 0.0;
    double rel_pos_t_km = 0.0;
    double rel_pos_n_km = 0.0;
    double rel_vel_r_kms = 0.0;
    double rel_vel_t_kms = 0.0;
    double rel_vel_n_kms = 0.0;
    std::string collision_probability_method;
    double collision_probability = 0.0;
    ParsedCdmObject objects[2];
    bool has_object[2] = {false, false};
    bool has_relative_speed = false;
    bool has_relative_position = false;
    bool has_relative_velocity = false;
};

struct KvnValue {
    std::string key;
    std::string value;
    std::string unit;
};

struct XmlValue {
    std::string value;
    std::string unit;
};

static std::string trim(std::string value) {
    const auto first = std::find_if_not(value.begin(), value.end(), [](unsigned char c) {
        return std::isspace(c) != 0;
    });
    const auto last = std::find_if_not(value.rbegin(), value.rend(), [](unsigned char c) {
        return std::isspace(c) != 0;
    }).base();
    if (first >= last) {
        return std::string();
    }
    return std::string(first, last);
}

static std::string upper(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::toupper(c));
    });
    return value;
}

static bool parse_kvn_line(const std::string& line, KvnValue* out) {
    const auto without_cr = line.empty() || line.back() != '\r'
        ? line
        : line.substr(0, line.size() - 1u);
    const auto trimmed = trim(without_cr);
    if (trimmed.empty()) {
        return false;
    }
    if (trimmed.rfind("COMMENT", 0) == 0 && (trimmed.size() == 7 || std::isspace(static_cast<unsigned char>(trimmed[7])))) {
        if (out) *out = {"COMMENT", trim(trimmed.substr(7)), ""};
        return true;
    }
    const auto equals = trimmed.find('=');
    if (equals == std::string::npos) {
        return false;
    }

    KvnValue parsed{};
    parsed.key = upper(trim(trimmed.substr(0, equals)));
    std::string raw_value = trim(trimmed.substr(equals + 1u));
    const auto unit_start = raw_value.find('[');
    const auto unit_end = raw_value.find(']', unit_start == std::string::npos ? 0u : unit_start);
    if (unit_start != std::string::npos && unit_end != std::string::npos && unit_end > unit_start) {
        parsed.unit = trim(raw_value.substr(unit_start + 1u, unit_end - unit_start - 1u));
        raw_value = trim(raw_value.substr(0, unit_start));
    }
    parsed.value = raw_value;
    if (out) {
        *out = std::move(parsed);
    }
    return true;
}

static bool xml_name_boundary(char c) {
    return c == '>' || c == '/' || std::isspace(static_cast<unsigned char>(c)) != 0;
}

static std::string extract_xml_attribute(const std::string& text, const std::string& name) {
    const auto attr = text.find(name);
    if (attr == std::string::npos) {
        return std::string();
    }
    auto cursor = attr + name.size();
    while (cursor < text.size() && std::isspace(static_cast<unsigned char>(text[cursor])) != 0) {
        cursor += 1u;
    }
    if (cursor >= text.size() || text[cursor] != '=') {
        return std::string();
    }
    cursor += 1u;
    while (cursor < text.size() && std::isspace(static_cast<unsigned char>(text[cursor])) != 0) {
        cursor += 1u;
    }
    if (cursor >= text.size() || (text[cursor] != '"' && text[cursor] != '\'')) {
        return std::string();
    }
    const char quote = text[cursor];
    cursor += 1u;
    const auto end = text.find(quote, cursor);
    if (end == std::string::npos) {
        return std::string();
    }
    return text.substr(cursor, end - cursor);
}

static bool find_xml_element(
    const std::string& text,
    const std::string& tag,
    size_t start,
    size_t limit,
    XmlValue* out,
    size_t* after_end = nullptr) {

    const std::string open_needle = "<" + tag;
    const std::string close_needle = "</" + tag + ">";
    if (limit == std::string::npos || limit > text.size()) {
        limit = text.size();
    }

    size_t open_start = start;
    while (true) {
        open_start = text.find(open_needle, open_start);
        if (open_start == std::string::npos || open_start >= limit) {
            return false;
        }
        const size_t boundary = open_start + open_needle.size();
        if (boundary < text.size() && xml_name_boundary(text[boundary])) {
            break;
        }
        open_start = boundary;
    }

    const auto open_end = text.find('>', open_start);
    if (open_end == std::string::npos || open_end >= limit) {
        return false;
    }
    const auto close_start = text.find(close_needle, open_end + 1u);
    if (close_start == std::string::npos || close_start > limit) {
        return false;
    }

    if (out) {
        const auto attrs_start = open_start + open_needle.size();
        const auto attrs = text.substr(attrs_start, open_end - attrs_start);
        out->value = trim(text.substr(open_end + 1u, close_start - open_end - 1u));
        out->unit = trim(extract_xml_attribute(attrs, "units"));
    }
    if (after_end) {
        *after_end = close_start + close_needle.size();
    }
    return true;
}

static std::string xml_unescape(std::string s) {
    // Decode leaves only; container markup must remain intact for traversal.
    std::string out;
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] != '&') { out += s[i]; continue; }
        const auto end = s.find(';', i + 1);
        if (end == std::string::npos) { out += s[i]; continue; }
        const auto entity = s.substr(i + 1, end - i - 1);
        if (entity == "amp") out += '&';
        else if (entity == "lt") out += '<';
        else if (entity == "gt") out += '>';
        else if (entity == "quot") out += '"';
        else if (entity == "apos") out += '\'';
        else { out += s.substr(i, end - i + 1); }
        i = end;
    }
    return out;
}
static bool find_xml_value(const std::string& text, const std::string& tag, XmlValue* out) {
    if (!find_xml_element(text, tag, 0u, text.size(), out)) return false;
    if (out) out->value = xml_unescape(out->value);
    return true;
}

static double parse_double_value(const std::string& value, const std::string& key) {
    char* end = nullptr;
    const double parsed = std::strtod(value.c_str(), &end);
    if (end == value.c_str() || *end != '\0' || !std::isfinite(parsed)) {
        set_error("Unable to parse numeric CDM field: " + key);
        return 0.0;
    }
    return parsed;
}

static double distance_to_km(double value, const std::string& unit) {
    const auto normalized = upper(unit);
    if (normalized == "M" || normalized == "METER" || normalized == "METERS") {
        return value / 1000.0;
    }
    return value;
}

static double speed_to_kms(double value, const std::string& unit) {
    const auto normalized = upper(unit);
    if (normalized == "M/S" || normalized == "M/SEC") {
        return value / 1000.0;
    }
    return value;
}

static double covariance_to_km_units(double value, const std::string& unit, size_t index) {
    const auto normalized = upper(unit);
    const auto& field = kCovarianceFields[index];
    if (normalized.empty() || normalized == upper(field.unit)) return value / field.text_scale;
    if (index < 21 && normalized == "K" + upper(field.unit)) return value;
    set_error("Unsupported covariance unit for " + std::string(field.key) + ": " + unit);
    return 0.0;
}

static bool parse_yes(const std::string& value) {
    const auto normalized = upper(trim(value));
    return normalized == "YES" || normalized == "Y" || normalized == "TRUE";
}

static spaceObjectClass parse_object_type(const std::string& value) {
    const auto normalized = upper(trim(value));
    if (normalized == "PAYLOAD") {
        return spaceObjectClass::PAYLOAD;
    }
    if (normalized == "ROCKET_BODY" || normalized == "ROCKET BODY") {
        return spaceObjectClass::ROCKET_BODY;
    }
    if (normalized == "DEBRIS") {
        return spaceObjectClass::DEBRIS;
    }
    return spaceObjectClass::UNKNOWN;
}

static uint32_t parse_designator_as_norad(const std::string& designator) {
    if (designator.empty() ||
        !std::all_of(designator.begin(), designator.end(), [](unsigned char c) {
            return std::isdigit(c) != 0;
        })) {
        return 0u;
    }
    uint32_t value = 0;
    for (const char c : designator) {
        const uint32_t digit = static_cast<uint32_t>(c - '0');
        if (value > (UINT32_MAX - digit) / 10u) return 0;
        value = value * 10u + digit;
    }
    return value;
}

static int covariance_index_for_key(const std::string& key) {
    for (const auto& field : kCovarianceFields) {
        if (key == field.key) {
            return static_cast<int>(field.index);
        }
    }
    return -1;
}

struct ObjectDoubleField { const char* key; double CDMObjectT::*member; };
static constexpr ObjectDoubleField kObjectDoubleFields[] = {
    {"RECOMMENDED_OD_SPAN", &CDMObjectT::RECOMMENDED_OD_SPAN}, {"ACTUAL_OD_SPAN", &CDMObjectT::ACTUAL_OD_SPAN},
    {"RESIDUALS_ACCEPTED", &CDMObjectT::RESIDUALS_ACCEPTED}, {"WEIGHTED_RMS", &CDMObjectT::WEIGHTED_RMS},
    {"AREA_PC", &CDMObjectT::AREA_PC}, {"AREA_DRG", &CDMObjectT::AREA_DRG}, {"AREA_SRP", &CDMObjectT::AREA_SRP},
    {"CD_AREA_OVER_MASS", &CDMObjectT::CD_AREA_OVER_MASS}, {"CR_AREA_OVER_MASS", &CDMObjectT::CR_AREA_OVER_MASS},
    {"THRUST_ACCELERATION", &CDMObjectT::THRUST_ACCELERATION}, {"SEDR", &CDMObjectT::SEDR}
};
struct ObjectCountField { const char* key; uint32_t CDMObjectT::*member; };
static constexpr ObjectCountField kObjectCountFields[] = {
    {"OBS_AVAILABLE", &CDMObjectT::OBS_AVAILABLE}, {"OBS_USED", &CDMObjectT::OBS_USED},
    {"TRACKS_AVAILABLE", &CDMObjectT::TRACKS_AVAILABLE}, {"TRACKS_USED", &CDMObjectT::TRACKS_USED}
};
struct ObjectStringField { const char* key; std::string CDMObjectT::*member; };
static constexpr ObjectStringField kObjectStringFields[] = {
    {"TIME_LASTOB_START", &CDMObjectT::TIME_LASTOB_START}, {"TIME_LASTOB_END", &CDMObjectT::TIME_LASTOB_END},
    {"OPERATOR_CONTACT_POSITION", &CDMObjectT::OPERATOR_CONTACT_POSITION}, {"OPERATOR_ORGANIZATION", &CDMObjectT::OPERATOR_ORGANIZATION},
    {"GRAVITY_MODEL", &CDMObjectT::GRAVITY_MODEL}, {"ATMOSPHERIC_MODEL", &CDMObjectT::ATMOSPHERIC_MODEL},
    {"N_BODY_PERTURBATIONS", &CDMObjectT::N_BODY_PERTURBATIONS}
};
static void parse_xml_object_field(ParsedCdmObject* object, const std::string& key, const XmlValue& entry) {
    if (!object) return;
    for (const auto& field : kObjectStringFields) if (key == field.key) { object->extra.*field.member = entry.value; return; }
    for (const auto& field : kObjectDoubleFields) if (key == field.key) {
        object->extra.*field.member = parse_double_value(entry.value, key); return;
    }
    for (const auto& field : kObjectCountFields) if (key == field.key) {
        const double value = parse_double_value(entry.value, key);
        if (value < 0 || value > 2147483647.0 || std::floor(value) != value) { set_error("Invalid CDM count: " + key); return; }
        object->extra.*field.member = static_cast<uint32_t>(value); return;
    }
    if (key == "COMMENT") object->comment += (object->comment.empty() ? "" : "\n") + entry.value;
    else if (key == "OBJECT") object->label = upper(entry.value);
    else if (key == "OBJECT_DESIGNATOR") object->object_designator = entry.value;
    else if (key == "CATALOG_NAME") object->catalog_name = entry.value;
    else if (key == "OBJECT_NAME") object->object_name = entry.value;
    else if (key == "INTERNATIONAL_DESIGNATOR") object->object_id = entry.value;
    else if (key == "OBJECT_TYPE") object->object_type = parse_object_type(entry.value);
    else if (key == "EPHEMERIS_NAME") object->ephemeris_name = entry.value;
    else if (key == "COVARIANCE_METHOD") {
        object->has_covariance_method = true;
        if (upper(entry.value) == "CALCULATED") object->covariance_method = covarianceAlgorithm::CALCULATED;
        else if (upper(entry.value) == "DEFAULT") object->covariance_method = covarianceAlgorithm::DEFAULT;
        else set_error("Invalid CDM COVARIANCE_METHOD: " + entry.value);
    } else if (key == "MANEUVERABLE") {
        const auto value = upper(entry.value);
        if (value == "YES") object->maneuverable = cdmManeuverable::YES;
        else if (value == "NO") object->maneuverable = cdmManeuverable::NO;
        else if (value == "N/A") object->maneuverable = cdmManeuverable::NOT_APPLICABLE;
        else set_error("Invalid CDM MANEUVERABLE: " + entry.value);
    } else if (key == "REF_FRAME") object->ref_frame = upper(entry.value);
    else if (key == "SOLAR_RAD_PRESSURE") object->extra.SOLAR_RAD_PRESSURE = parse_yes(entry.value);
    else if (key == "EARTH_TIDES") object->extra.EARTH_TIDES = parse_yes(entry.value);
    else if (key == "INTRACK_THRUST") object->extra.INTRACK_THRUST = parse_yes(entry.value);
    else if (key == "MASS") {
        if (!object->extra.OBJECT) object->extra.OBJECT = std::make_unique<CATT>();
        object->extra.OBJECT->MASS = parse_double_value(entry.value, key);
    } else if (key == "X") object->x = distance_to_km(parse_double_value(entry.value, key), entry.unit);
    else if (key == "Y") object->y = distance_to_km(parse_double_value(entry.value, key), entry.unit);
    else if (key == "Z") object->z = distance_to_km(parse_double_value(entry.value, key), entry.unit);
    else if (key == "X_DOT") object->x_dot = speed_to_kms(parse_double_value(entry.value, key), entry.unit);
    else if (key == "Y_DOT") object->y_dot = speed_to_kms(parse_double_value(entry.value, key), entry.unit);
    else if (key == "Z_DOT") object->z_dot = speed_to_kms(parse_double_value(entry.value, key), entry.unit);
    else {
        const int index = covariance_index_for_key(key);
        if (index >= 0) {
            object->covariance.resize(std::max(object->covariance.size(), static_cast<size_t>(index + 1)));
            object->covariance_present[static_cast<size_t>(index)] = true;
            object->covariance[static_cast<size_t>(index)] = covariance_to_km_units(parse_double_value(entry.value, key), entry.unit, index);
        }
    }
}

static void validate_parsed_covariance(const ParsedCdm& parsed) {
    for (const auto& object : parsed.objects) {
        if (object.covariance.empty()) continue;
        if (!object.has_covariance_method) {
            set_error("cdm-covariance-method-required: Received covariance must state CALCULATED or DEFAULT; its origin cannot be inferred.");
            return;
        }
        if (!cdm_complete_covariance_rows(object.covariance.size()) ||
            !std::all_of(object.covariance_present.begin(), object.covariance_present.begin() + object.covariance.size(), [](bool present) { return present; })) {
            set_error("CDM covariance requires all 21, 28, 36 or 45 cells; partial rows are not allowed.");
            return;
        }
    }
}

static ParsedCdm parse_cdm_kvn(const char* kvn_text, uint32_t kvn_text_size) {
    if (!kvn_text || kvn_text_size == 0u) {
        set_error("CDM KVN input is empty.");
        return {};
    }

    ParsedCdm parsed{};
    ParsedCdmObject* current_object = nullptr;
    std::istringstream stream(std::string(kvn_text, kvn_text + kvn_text_size));
    std::string line, pending_comments;
    while (std::getline(stream, line)) {
        KvnValue entry{};
        if (!parse_kvn_line(line, &entry)) {
            continue;
        }

        if (entry.key == "COMMENT") {
            pending_comments += (pending_comments.empty() ? "" : "\n") + entry.value;
            continue;
        }
        if (entry.key == "OBJECT") {
            const auto label = upper(entry.value);
            if (label == "OBJECT1") {
                current_object = &parsed.objects[0];
                parsed.has_object[0] = true;
            } else if (label == "OBJECT2") {
                current_object = &parsed.objects[1];
                parsed.has_object[1] = true;
            } else {
                current_object = nullptr;
            }
            if (current_object) {
                current_object->label = label;
                current_object->comment = pending_comments;
            }
            pending_comments.clear();
            continue;
        }

        // A run immediately preceding OBJECT is metadata for that object;
        // other comments within an object remain attached to that object.
        if (current_object) {
            if (!pending_comments.empty()) parse_xml_object_field(current_object, "COMMENT", {pending_comments, ""});
            pending_comments.clear();
            parse_xml_object_field(current_object, entry.key, {entry.value, entry.unit});
            continue;
        }
        pending_comments.clear();

        if (entry.key == "CCSDS_CDM_VERS") {
            parsed.version = parse_double_value(entry.value, entry.key);
        } else if (entry.key == "CREATION_DATE") {
            parsed.creation_date = entry.value;
        } else if (entry.key == "ORIGINATOR") {
            parsed.originator = entry.value;
        } else if (entry.key == "MESSAGE_FOR") {
            parsed.message_for = entry.value;
        } else if (entry.key == "MESSAGE_ID") {
            parsed.message_id = entry.value;
        } else if (entry.key == "TCA") {
            parsed.tca = entry.value;
        } else if (entry.key == "MISS_DISTANCE") {
            parsed.miss_distance_km = distance_to_km(parse_double_value(entry.value, entry.key), entry.unit);
        } else if (entry.key == "RELATIVE_SPEED") {
            parsed.relative_speed_kms = speed_to_kms(parse_double_value(entry.value, entry.key), entry.unit);
            parsed.has_relative_speed = true;
        } else if (entry.key == "RELATIVE_POSITION_R") {
            parsed.rel_pos_r_km = distance_to_km(parse_double_value(entry.value, entry.key), entry.unit);
            parsed.has_relative_position = true;
        } else if (entry.key == "RELATIVE_POSITION_T") {
            parsed.rel_pos_t_km = distance_to_km(parse_double_value(entry.value, entry.key), entry.unit);
            parsed.has_relative_position = true;
        } else if (entry.key == "RELATIVE_POSITION_N") {
            parsed.rel_pos_n_km = distance_to_km(parse_double_value(entry.value, entry.key), entry.unit);
            parsed.has_relative_position = true;
        } else if (entry.key == "RELATIVE_VELOCITY_R") {
            parsed.rel_vel_r_kms = speed_to_kms(parse_double_value(entry.value, entry.key), entry.unit);
            parsed.has_relative_velocity = true;
        } else if (entry.key == "RELATIVE_VELOCITY_T") {
            parsed.rel_vel_t_kms = speed_to_kms(parse_double_value(entry.value, entry.key), entry.unit);
            parsed.has_relative_velocity = true;
        } else if (entry.key == "RELATIVE_VELOCITY_N") {
            parsed.rel_vel_n_kms = speed_to_kms(parse_double_value(entry.value, entry.key), entry.unit);
            parsed.has_relative_velocity = true;
        } else if (entry.key == "COLLISION_PROBABILITY") {
            parsed.collision_probability = parse_double_value(entry.value, entry.key);
        } else if (entry.key == "COLLISION_PROBABILITY_METHOD") {
            parsed.collision_probability_method = entry.value;
        }
    }

    if (!parsed.has_object[0] || !parsed.has_object[1]) {
        set_error("CDM KVN requires OBJECT1 and OBJECT2 blocks.");
        return {};
    }
    validate_parsed_covariance(parsed);
    return parsed;
}

static ParsedCdm parse_cdm_xml(const char* xml_text, uint32_t xml_text_size) {
    if (!xml_text || xml_text_size == 0u) {
        set_error("CDM XML input is empty.");
        return {};
    }

    const std::string text(xml_text, xml_text + xml_text_size);
    ParsedCdm parsed{};
    parsed.version = 1.0;

    const auto cdm_start = text.find("<cdm");
    if (cdm_start != std::string::npos) {
        const auto cdm_open_end = text.find('>', cdm_start);
        if (cdm_open_end != std::string::npos) {
            const auto open_tag = text.substr(cdm_start, cdm_open_end - cdm_start + 1u);
            const auto version = extract_xml_attribute(open_tag, "version");
            if (!version.empty()) {
                parsed.version = parse_double_value(version, "CCSDS_CDM_VERS");
            }
        }
    }

    XmlValue entry{};
    if (find_xml_value(text, "CREATION_DATE", &entry)) {
        parsed.creation_date = entry.value;
    }
    if (find_xml_value(text, "ORIGINATOR", &entry)) {
        parsed.originator = entry.value;
    }
    if (find_xml_value(text, "MESSAGE_FOR", &entry)) {
        parsed.message_for = entry.value;
    }
    if (find_xml_value(text, "MESSAGE_ID", &entry)) {
        parsed.message_id = entry.value;
    }
    if (find_xml_value(text, "TCA", &entry)) {
        parsed.tca = entry.value;
    }
    if (find_xml_value(text, "MISS_DISTANCE", &entry)) {
        parsed.miss_distance_km = distance_to_km(parse_double_value(entry.value, "MISS_DISTANCE"), entry.unit);
    }
    if (find_xml_value(text, "RELATIVE_SPEED", &entry)) {
        parsed.relative_speed_kms = speed_to_kms(parse_double_value(entry.value, "RELATIVE_SPEED"), entry.unit);
        parsed.has_relative_speed = true;
    }
    if (find_xml_value(text, "RELATIVE_POSITION_R", &entry)) {
        parsed.rel_pos_r_km = distance_to_km(parse_double_value(entry.value, "RELATIVE_POSITION_R"), entry.unit);
        parsed.has_relative_position = true;
    }
    if (find_xml_value(text, "RELATIVE_POSITION_T", &entry)) {
        parsed.rel_pos_t_km = distance_to_km(parse_double_value(entry.value, "RELATIVE_POSITION_T"), entry.unit);
        parsed.has_relative_position = true;
    }
    if (find_xml_value(text, "RELATIVE_POSITION_N", &entry)) {
        parsed.rel_pos_n_km = distance_to_km(parse_double_value(entry.value, "RELATIVE_POSITION_N"), entry.unit);
        parsed.has_relative_position = true;
    }
    if (find_xml_value(text, "RELATIVE_VELOCITY_R", &entry)) {
        parsed.rel_vel_r_kms = speed_to_kms(parse_double_value(entry.value, "RELATIVE_VELOCITY_R"), entry.unit);
        parsed.has_relative_velocity = true;
    }
    if (find_xml_value(text, "RELATIVE_VELOCITY_T", &entry)) {
        parsed.rel_vel_t_kms = speed_to_kms(parse_double_value(entry.value, "RELATIVE_VELOCITY_T"), entry.unit);
        parsed.has_relative_velocity = true;
    }
    if (find_xml_value(text, "RELATIVE_VELOCITY_N", &entry)) {
        parsed.rel_vel_n_kms = speed_to_kms(parse_double_value(entry.value, "RELATIVE_VELOCITY_N"), entry.unit);
        parsed.has_relative_velocity = true;
    }
    if (find_xml_value(text, "COLLISION_PROBABILITY", &entry)) {
        parsed.collision_probability = parse_double_value(entry.value, "COLLISION_PROBABILITY");
    }
    if (find_xml_value(text, "COLLISION_PROBABILITY_METHOD", &entry)) {
        parsed.collision_probability_method = entry.value;
    }

    const std::array<const char*, 20> object_fields = {{
        "OBJECT",
        "CATALOG_NAME",
        "OBJECT_DESIGNATOR",
        "OBJECT_NAME",
        "INTERNATIONAL_DESIGNATOR",
        "OBJECT_TYPE",
        "EPHEMERIS_NAME",
        "COVARIANCE_METHOD",
        "MANEUVERABLE",
        "REF_FRAME",
        "X",
        "Y",
        "Z",
        "X_DOT",
        "Y_DOT",
        "Z_DOT", "SOLAR_RAD_PRESSURE", "EARTH_TIDES", "INTRACK_THRUST", "MASS"
    }};

    size_t cursor = 0u;
    size_t after_segment = 0u;
    int segment_ordinal = 0;
    XmlValue segment{};
    while (find_xml_element(text, "segment", cursor, text.size(), &segment, &after_segment)) {
        XmlValue label{};
        int object_index = segment_ordinal < 2 ? segment_ordinal : -1;
        if (find_xml_value(segment.value, "OBJECT", &label)) {
            const auto normalized = upper(label.value);
            if (normalized == "OBJECT1") {
                object_index = 0;
            } else if (normalized == "OBJECT2") {
                object_index = 1;
            }
        }

        if (object_index >= 0 && object_index < 2) {
            ParsedCdmObject* object = &parsed.objects[object_index];
            parsed.has_object[object_index] = true;
            for (const char* key : object_fields) {
                XmlValue value{};
                if (find_xml_value(segment.value, key, &value)) {
                    parse_xml_object_field(object, key, value);
                }
            }
            for (const auto& field : kObjectStringFields) { XmlValue value{}; if (find_xml_value(segment.value, field.key, &value)) parse_xml_object_field(object, field.key, value); }
            for (const auto& field : kObjectDoubleFields) { XmlValue value{}; if (find_xml_value(segment.value, field.key, &value)) parse_xml_object_field(object, field.key, value); }
            for (const auto& field : kObjectCountFields) { XmlValue value{}; if (find_xml_value(segment.value, field.key, &value)) parse_xml_object_field(object, field.key, value); }
            XmlValue metadata{};
            if (find_xml_element(segment.value, "metadata", 0, segment.value.size(), &metadata)) {
                size_t comment_cursor = 0, comment_end = 0;
                XmlValue comment{};
                while (find_xml_element(metadata.value, "COMMENT", comment_cursor, metadata.value.size(), &comment, &comment_end)) {
                    comment.value = xml_unescape(comment.value);
                    parse_xml_object_field(object, "COMMENT", comment);
                    comment_cursor = comment_end;
                }
            }
            for (const auto& field : kCovarianceFields) {
                XmlValue value{};
                if (find_xml_value(segment.value, field.key, &value)) {
                    parse_xml_object_field(object, field.key, value);
                }
            }
        }

        cursor = after_segment;
        segment_ordinal += 1;
    }

    if (!parsed.has_object[0] || !parsed.has_object[1]) {
        set_error("CDM XML requires OBJECT1 and OBJECT2 segments.");
        return {};
    }
    validate_parsed_covariance(parsed);
    return parsed;
}

static std::string utc_epoch(std::string value) {
    // CCSDS text time tags without a suffix are UTC, never host local time.
    if (!value.empty() && value.back() != 'Z') value += 'Z';
    return value;
}

static std::unique_ptr<CDMObjectT> to_native_cdm_object(const ParsedCdmObject& parsed) {
    auto object = std::make_unique<CDMObjectT>(parsed.extra);
    object->COMMENT = parsed.comment;
    object->TIME_LASTOB_START = utc_epoch(object->TIME_LASTOB_START);
    object->TIME_LASTOB_END = utc_epoch(object->TIME_LASTOB_END);
    if (!object->OBJECT) object->OBJECT = std::make_unique<CATT>();
    object->OBJECT->OBJECT_NAME = parsed.object_name;
    object->OBJECT->OBJECT_ID = parsed.object_id;
    object->OBJECT->NORAD_CAT_ID = upper(parsed.catalog_name) == "SATCAT" ? parse_designator_as_norad(parsed.object_designator) : 0;
    object->OBJECT_DESIGNATOR = parsed.object_designator;
    object->CATALOG_NAME = parsed.catalog_name;
    object->MANEUVERABLE = parsed.maneuverable;
    object->OBJECT->OBJECT_TYPE = parsed.object_type;
    object->OBJECT->MANEUVERABLE = parsed.maneuverable == cdmManeuverable::YES;
    object->EPHEMERIS_NAME = parsed.ephemeris_name;
    object->COVARIANCE_METHOD = parsed.covariance_method;
    if (!parsed.ref_frame.empty()) {
        object->REFERENCE_FRAME = std::make_unique<RFMT>();
        object->REFERENCE_FRAME->NAME = parsed.ref_frame;
        if (parsed.ref_frame == "EME2000" || parsed.ref_frame == "GCRF" || parsed.ref_frame == "ITRF" || parsed.ref_frame == "TEME") {
            CelestialFrameWrapperT axes;
            axes.frame = parsed.ref_frame == "EME2000" ? CelestialFrame::EME2000 : parsed.ref_frame == "GCRF" ? CelestialFrame::GCRF : parsed.ref_frame == "ITRF" ? CelestialFrame::ITRF2000 : CelestialFrame::TEMEOFDATE;
            object->REFERENCE_FRAME->REFERENCE_FRAME.Set(std::move(axes));
        }
    }
    object->X = parsed.x;
    object->Y = parsed.y;
    object->Z = parsed.z;
    object->X_DOT = parsed.x_dot;
    object->Y_DOT = parsed.y_dot;
    object->Z_DOT = parsed.z_dot;
    object->COVARIANCE = parsed.covariance;
    return object;
}

static std::vector<uint8_t> build_cdm_flatbuffer_from_parsed(const ParsedCdm& parsed) {
    CDMT cdm{};
    cdm.CCSDS_CDM_VERS = parsed.version;
    cdm.CREATION_DATE = utc_epoch(parsed.creation_date);
    cdm.ORIGINATOR = parsed.originator;
    cdm.MESSAGE_FOR = parsed.message_for;
    cdm.MESSAGE_ID = parsed.message_id;
    cdm.TCA = utc_epoch(parsed.tca);
    cdm.MISS_DISTANCE = parsed.miss_distance_km;
    cdm.RELATIVE_SPEED = parsed.relative_speed_kms;
    cdm.RELATIVE_POSITION_R = parsed.rel_pos_r_km;
    cdm.RELATIVE_POSITION_T = parsed.rel_pos_t_km;
    cdm.RELATIVE_POSITION_N = parsed.rel_pos_n_km;
    cdm.RELATIVE_VELOCITY_R = parsed.rel_vel_r_kms;
    cdm.RELATIVE_VELOCITY_T = parsed.rel_vel_t_kms;
    cdm.RELATIVE_VELOCITY_N = parsed.rel_vel_n_kms;
    cdm.COLLISION_PROBABILITY = parsed.collision_probability;
    cdm.COLLISION_PROBABILITY_METHOD = parsed.collision_probability_method;
    cdm.OBJECT1 = to_native_cdm_object(parsed.objects[0]);
    cdm.OBJECT2 = to_native_cdm_object(parsed.objects[1]);

    flatbuffers::FlatBufferBuilder builder(4096);
    builder.ForceDefaults(true);
    const auto root = CDM::Pack(builder, &cdm);
    builder.Finish(root, "$CDM");
    return std::vector<uint8_t>(
        builder.GetBufferPointer(),
        builder.GetBufferPointer() + builder.GetSize());
}

} // namespace

int32_t cdm_kvn_to_sds(
    const char* kvn_text, uint32_t kvn_text_size,
    uint8_t* output, uint32_t output_capacity) {
    clear_error();

        if (!output || output_capacity == 0u) {
            return -2;
        }
        const auto parsed = cdm_parse_detail::parse_cdm_kvn(kvn_text, kvn_text_size);
        if (has_error()) return -1;
        const auto bytes = cdm_parse_detail::build_cdm_flatbuffer_from_parsed(parsed);
        if (bytes.size() > output_capacity) {
            return -2;
        }
        std::memcpy(output, bytes.data(), bytes.size());
        return static_cast<int32_t>(bytes.size());
}

int32_t cdm_xml_to_sds(
    const char* xml_text, uint32_t xml_text_size,
    uint8_t* output, uint32_t output_capacity) {
    clear_error();

        if (!output || output_capacity == 0u) {
            return -2;
        }
        const auto parsed = cdm_parse_detail::parse_cdm_xml(xml_text, xml_text_size);
        if (has_error()) return -1;
        const auto bytes = cdm_parse_detail::build_cdm_flatbuffer_from_parsed(parsed);
        if (bytes.size() > output_capacity) {
            return -2;
        }
        std::memcpy(output, bytes.data(), bytes.size());
        return static_cast<int32_t>(bytes.size());
}


} // namespace conjunction
