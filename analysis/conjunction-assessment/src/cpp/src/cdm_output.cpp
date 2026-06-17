/**
 * CDM FlatBuffers Output — Serialize ConjunctionEvent to CCSDS CDM
 *
 * Uses spacedatastandards.org CDM schema with $CDM file identifier.
 * Output is aligned FlatBuffers binary suitable for SDN wire format.
 */

#include "conjunction/conjunction_assessment.h"
#include "conjunction/conjunction_engine.h"
#ifdef SING
#undef SING
#endif
#include "conjunction/standards/CDM/main_generated.h"
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

namespace conjunction {

// jd_to_iso() is declared in sgp4_propagator.h and defined in conjunction_assessment.cpp

namespace {

struct ParsedCdmObject {
    std::string label;
    std::string object_designator;
    std::string object_name;
    std::string object_id;
    std::string ephemeris_name;
    std::string ref_frame;
    objectType object_type = objectType::UNKNOWN;
    covarianceMethod covariance_method = covarianceMethod::CALCULATED;
    bool maneuverable = false;
    double x = 0.0;
    double y = 0.0;
    double z = 0.0;
    double x_dot = 0.0;
    double y_dot = 0.0;
    double z_dot = 0.0;
    std::vector<double> covariance = std::vector<double>(45, 0.0);
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

struct CovarianceField {
    const char* key;
    size_t index;
};

static const std::array<CovarianceField, 21> kCovarianceFields = {{
    {"CR_R", 0},
    {"CT_R", 1},
    {"CT_T", 2},
    {"CN_R", 3},
    {"CN_T", 4},
    {"CN_N", 5},
    {"CRDOT_R", 6},
    {"CRDOT_T", 7},
    {"CRDOT_N", 8},
    {"CRDOT_RDOT", 9},
    {"CTDOT_R", 10},
    {"CTDOT_T", 11},
    {"CTDOT_N", 12},
    {"CTDOT_RDOT", 13},
    {"CTDOT_TDOT", 14},
    {"CNDOT_R", 15},
    {"CNDOT_T", 16},
    {"CNDOT_N", 17},
    {"CNDOT_RDOT", 18},
    {"CNDOT_TDOT", 19},
    {"CNDOT_NDOT", 20},
}};

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

static bool find_xml_value(const std::string& text, const std::string& tag, XmlValue* out) {
    return find_xml_element(text, tag, 0u, text.size(), out);
}

static double parse_double_value(const std::string& value, const std::string& key) {
    char* end = nullptr;
    const double parsed = std::strtod(value.c_str(), &end);
    if (end == value.c_str()) {
        throw std::invalid_argument("Unable to parse numeric CDM KVN field: " + key);
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

static double covariance_to_km_units(double value, const std::string& unit) {
    const auto normalized = upper(unit);
    if (normalized.rfind("M**2", 0u) == 0 || normalized.rfind("M^2", 0u) == 0) {
        return value / 1000000.0;
    }
    return value;
}

static bool parse_yes(const std::string& value) {
    const auto normalized = upper(trim(value));
    return normalized == "YES" || normalized == "Y" || normalized == "TRUE";
}

static objectType parse_object_type(const std::string& value) {
    const auto normalized = upper(trim(value));
    if (normalized == "PAYLOAD") {
        return objectType::PAYLOAD;
    }
    if (normalized == "ROCKET_BODY" || normalized == "ROCKET BODY") {
        return objectType::ROCKET_BODY;
    }
    if (normalized == "DEBRIS") {
        return objectType::DEBRIS;
    }
    return objectType::UNKNOWN;
}

static uint32_t parse_designator_as_norad(const std::string& designator) {
    if (designator.empty() ||
        !std::all_of(designator.begin(), designator.end(), [](unsigned char c) {
            return std::isdigit(c) != 0;
        })) {
        return 0u;
    }
    return static_cast<uint32_t>(std::strtoul(designator.c_str(), nullptr, 10));
}

static int covariance_index_for_key(const std::string& key) {
    for (const auto& field : kCovarianceFields) {
        if (key == field.key) {
            return static_cast<int>(field.index);
        }
    }
    return -1;
}

static void parse_xml_object_field(ParsedCdmObject* object, const std::string& key, const XmlValue& entry) {
    if (!object) {
        return;
    }
    if (key == "OBJECT") {
        object->label = upper(entry.value);
    } else if (key == "OBJECT_DESIGNATOR") {
        object->object_designator = entry.value;
    } else if (key == "OBJECT_NAME") {
        object->object_name = entry.value;
    } else if (key == "INTERNATIONAL_DESIGNATOR") {
        object->object_id = entry.value;
    } else if (key == "OBJECT_TYPE") {
        object->object_type = parse_object_type(entry.value);
    } else if (key == "EPHEMERIS_NAME") {
        object->ephemeris_name = entry.value;
    } else if (key == "COVARIANCE_METHOD") {
        object->covariance_method = covarianceMethod::CALCULATED;
    } else if (key == "MANEUVERABLE") {
        object->maneuverable = parse_yes(entry.value);
    } else if (key == "REF_FRAME") {
        object->ref_frame = entry.value;
    } else if (key == "X") {
        object->x = distance_to_km(parse_double_value(entry.value, key), entry.unit);
    } else if (key == "Y") {
        object->y = distance_to_km(parse_double_value(entry.value, key), entry.unit);
    } else if (key == "Z") {
        object->z = distance_to_km(parse_double_value(entry.value, key), entry.unit);
    } else if (key == "X_DOT") {
        object->x_dot = speed_to_kms(parse_double_value(entry.value, key), entry.unit);
    } else if (key == "Y_DOT") {
        object->y_dot = speed_to_kms(parse_double_value(entry.value, key), entry.unit);
    } else if (key == "Z_DOT") {
        object->z_dot = speed_to_kms(parse_double_value(entry.value, key), entry.unit);
    } else {
        const int covariance_index = covariance_index_for_key(key);
        if (covariance_index >= 0) {
            object->covariance[static_cast<size_t>(covariance_index)] =
                covariance_to_km_units(parse_double_value(entry.value, key), entry.unit);
        }
    }
}

static void derive_relative_state(ParsedCdm* parsed) {
    if (!parsed || !parsed->has_object[0] || !parsed->has_object[1]) {
        return;
    }

    const auto& object1 = parsed->objects[0];
    const auto& object2 = parsed->objects[1];
    if (!parsed->has_relative_position) {
        parsed->rel_pos_r_km = object1.x - object2.x;
        parsed->rel_pos_t_km = object1.y - object2.y;
        parsed->rel_pos_n_km = object1.z - object2.z;
    }
    if (!parsed->has_relative_velocity) {
        parsed->rel_vel_r_kms = object1.x_dot - object2.x_dot;
        parsed->rel_vel_t_kms = object1.y_dot - object2.y_dot;
        parsed->rel_vel_n_kms = object1.z_dot - object2.z_dot;
    }
    if (!parsed->has_relative_speed) {
        parsed->relative_speed_kms = std::sqrt(
            parsed->rel_vel_r_kms * parsed->rel_vel_r_kms +
            parsed->rel_vel_t_kms * parsed->rel_vel_t_kms +
            parsed->rel_vel_n_kms * parsed->rel_vel_n_kms);
    }
}

static ParsedCdm parse_cdm_kvn(const char* kvn_text, uint32_t kvn_text_size) {
    if (!kvn_text || kvn_text_size == 0u) {
        throw std::invalid_argument("CDM KVN input is empty.");
    }

    ParsedCdm parsed{};
    ParsedCdmObject* current_object = nullptr;
    std::istringstream stream(std::string(kvn_text, kvn_text + kvn_text_size));
    std::string line;
    while (std::getline(stream, line)) {
        KvnValue entry{};
        if (!parse_kvn_line(line, &entry)) {
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
            }
            continue;
        }

        if (current_object) {
            if (entry.key == "OBJECT_DESIGNATOR") {
                current_object->object_designator = entry.value;
            } else if (entry.key == "OBJECT_NAME") {
                current_object->object_name = entry.value;
            } else if (entry.key == "INTERNATIONAL_DESIGNATOR") {
                current_object->object_id = entry.value;
            } else if (entry.key == "OBJECT_TYPE") {
                current_object->object_type = parse_object_type(entry.value);
            } else if (entry.key == "EPHEMERIS_NAME") {
                current_object->ephemeris_name = entry.value;
            } else if (entry.key == "COVARIANCE_METHOD") {
                current_object->covariance_method = covarianceMethod::CALCULATED;
            } else if (entry.key == "MANEUVERABLE") {
                current_object->maneuverable = parse_yes(entry.value);
            } else if (entry.key == "REF_FRAME") {
                current_object->ref_frame = entry.value;
            } else if (entry.key == "X") {
                current_object->x = distance_to_km(parse_double_value(entry.value, entry.key), entry.unit);
            } else if (entry.key == "Y") {
                current_object->y = distance_to_km(parse_double_value(entry.value, entry.key), entry.unit);
            } else if (entry.key == "Z") {
                current_object->z = distance_to_km(parse_double_value(entry.value, entry.key), entry.unit);
            } else if (entry.key == "X_DOT") {
                current_object->x_dot = speed_to_kms(parse_double_value(entry.value, entry.key), entry.unit);
            } else if (entry.key == "Y_DOT") {
                current_object->y_dot = speed_to_kms(parse_double_value(entry.value, entry.key), entry.unit);
            } else if (entry.key == "Z_DOT") {
                current_object->z_dot = speed_to_kms(parse_double_value(entry.value, entry.key), entry.unit);
            } else {
                const int covariance_index = covariance_index_for_key(entry.key);
                if (covariance_index >= 0) {
                    current_object->covariance[static_cast<size_t>(covariance_index)] =
                        covariance_to_km_units(parse_double_value(entry.value, entry.key), entry.unit);
                }
            }
            continue;
        }

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
        throw std::invalid_argument("CDM KVN requires OBJECT1 and OBJECT2 blocks.");
    }
    derive_relative_state(&parsed);
    return parsed;
}

static ParsedCdm parse_cdm_xml(const char* xml_text, uint32_t xml_text_size) {
    if (!xml_text || xml_text_size == 0u) {
        throw std::invalid_argument("CDM XML input is empty.");
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

    const std::array<const char*, 15> object_fields = {{
        "OBJECT",
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
        "Z_DOT"
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
        throw std::invalid_argument("CDM XML requires OBJECT1 and OBJECT2 segments.");
    }
    derive_relative_state(&parsed);
    return parsed;
}

static std::unique_ptr<CDMObjectT> to_native_cdm_object(const ParsedCdmObject& parsed) {
    auto object = std::make_unique<CDMObjectT>();
    object->COMMENT = parsed.label.empty() ? std::string("CCSDS CDM object") : parsed.label;
    object->OBJECT = std::make_unique<CATT>();
    object->OBJECT->OBJECT_NAME = parsed.object_name;
    object->OBJECT->OBJECT_ID = parsed.object_id;
    object->OBJECT->NORAD_CAT_ID = parse_designator_as_norad(parsed.object_designator);
    object->OBJECT->OBJECT_TYPE = parsed.object_type;
    object->OBJECT->MANEUVERABLE = parsed.maneuverable;
    object->EPHEMERIS_NAME = parsed.ephemeris_name;
    object->COVARIANCE_METHOD = parsed.covariance_method;
    if (!parsed.ref_frame.empty()) {
        object->REFERENCE_FRAME = std::make_unique<RFMT>();
        object->REFERENCE_FRAME->NAME = parsed.ref_frame;
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
    cdm.CREATION_DATE = parsed.creation_date;
    cdm.ORIGINATOR = parsed.originator;
    cdm.MESSAGE_FOR = parsed.message_for;
    cdm.MESSAGE_ID = parsed.message_id;
    cdm.TCA = parsed.tca;
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
    const auto root = CDM::Pack(builder, &cdm);
    builder.Finish(root, "$CDM");
    return std::vector<uint8_t>(
        builder.GetBufferPointer(),
        builder.GetBufferPointer() + builder.GetSize());
}

static std::string flatbuffer_string(const flatbuffers::String* value) {
    return value ? value->str() : std::string();
}

static std::string format_decimal(double value, int precision) {
    std::ostringstream out;
    out << std::fixed << std::setprecision(precision) << value;
    std::string text = out.str();
    while (text.size() > 1u && text.back() == '0') {
        text.pop_back();
    }
    if (!text.empty() && text.back() == '.') {
        text.pop_back();
    }
    if (text == "-0") {
        text = "0";
    }
    return text;
}

static std::string format_scientific(double value) {
    std::ostringstream out;
    out << std::uppercase << std::scientific << std::setprecision(3) << value;
    return out.str();
}

static void append_kvn_line(
    std::ostringstream& out,
    const std::string& key,
    const std::string& value,
    const std::string& unit = std::string()) {
    out << std::left << std::setw(30) << key << "= " << value;
    if (!unit.empty()) {
        out << " [" << unit << "]";
    }
    out << '\n';
}

static void append_kvn_object(std::ostringstream& out, const CDMObject* object, const char* label) {
    append_kvn_line(out, "OBJECT", label ? label : "");
    if (!object) {
        return;
    }
    const CAT* cat = object->OBJECT();
    if (cat) {
        const uint32_t norad = cat->NORAD_CAT_ID();
        if (norad != 0u) {
            append_kvn_line(out, "OBJECT_DESIGNATOR", std::to_string(norad));
        }
        const auto object_name = flatbuffer_string(cat->OBJECT_NAME());
        if (!object_name.empty()) {
            append_kvn_line(out, "OBJECT_NAME", object_name);
        }
        const auto object_id = flatbuffer_string(cat->OBJECT_ID());
        if (!object_id.empty()) {
            append_kvn_line(out, "INTERNATIONAL_DESIGNATOR", object_id);
        }
        append_kvn_line(out, "MANEUVERABLE", cat->MANEUVERABLE() ? "YES" : "NO");
    }
    const auto ephemeris_name = flatbuffer_string(object->EPHEMERIS_NAME());
    if (!ephemeris_name.empty()) {
        append_kvn_line(out, "EPHEMERIS_NAME", ephemeris_name);
    }
    append_kvn_line(out, "COVARIANCE_METHOD", "CALCULATED");
    append_kvn_line(out, "X", format_decimal(object->X(), 6), "km");
    append_kvn_line(out, "Y", format_decimal(object->Y(), 6), "km");
    append_kvn_line(out, "Z", format_decimal(object->Z(), 6), "km");
    append_kvn_line(out, "X_DOT", format_decimal(object->X_DOT(), 9), "km/s");
    append_kvn_line(out, "Y_DOT", format_decimal(object->Y_DOT(), 9), "km/s");
    append_kvn_line(out, "Z_DOT", format_decimal(object->Z_DOT(), 9), "km/s");

    const auto* covariance = object->COVARIANCE();
    if (!covariance) {
        return;
    }
    for (const auto& field : kCovarianceFields) {
        if (covariance->size() <= field.index) {
            continue;
        }
        append_kvn_line(
            out,
            field.key,
            format_scientific(covariance->Get(static_cast<flatbuffers::uoffset_t>(field.index)) * 1000000.0),
            field.index < 6u ? "m**2" : (field.index < 10u ? "m**2/s" : "m**2/s**2"));
    }
}

static std::string xml_escape(const std::string& value) {
    std::string escaped;
    escaped.reserve(value.size());
    for (char c : value) {
        switch (c) {
            case '&':
                escaped += "&amp;";
                break;
            case '<':
                escaped += "&lt;";
                break;
            case '>':
                escaped += "&gt;";
                break;
            case '"':
                escaped += "&quot;";
                break;
            default:
                escaped.push_back(c);
                break;
        }
    }
    return escaped;
}

static void append_xml_indent(std::ostringstream& out, int indent) {
    for (int index = 0; index < indent; index += 1) {
        out << "  ";
    }
}

static void append_xml_element(
    std::ostringstream& out,
    int indent,
    const std::string& key,
    const std::string& value,
    const std::string& unit = std::string()) {

    append_xml_indent(out, indent);
    out << '<' << key;
    if (!unit.empty()) {
        out << " units=\"" << xml_escape(unit) << '"';
    }
    out << '>' << xml_escape(value) << "</" << key << ">\n";
}

static std::string object_type_to_xml(objectType type) {
    switch (type) {
        case objectType::PAYLOAD:
            return "PAYLOAD";
        case objectType::ROCKET_BODY:
            return "ROCKET_BODY";
        case objectType::DEBRIS:
            return "DEBRIS";
        default:
            return std::string();
    }
}

static std::string covariance_xml_unit(size_t index) {
    if (index < 6u) {
        return "m**2";
    }
    if (index == 6u || index == 7u || index == 8u ||
        index == 10u || index == 11u || index == 12u ||
        index == 15u || index == 16u || index == 17u) {
        return "m**2/s";
    }
    return "m**2/s**2";
}

static void append_xml_object(std::ostringstream& out, const CDMObject* object, const char* label) {
    append_xml_indent(out, 2);
    out << "<segment>\n";
    append_xml_indent(out, 3);
    out << "<metadata>\n";
    append_xml_element(out, 4, "OBJECT", label ? label : "");
    if (object) {
        const CAT* cat = object->OBJECT();
        if (cat) {
            const uint32_t norad = cat->NORAD_CAT_ID();
            if (norad != 0u) {
                append_xml_element(out, 4, "OBJECT_DESIGNATOR", std::to_string(norad));
            }
            const auto object_name = flatbuffer_string(cat->OBJECT_NAME());
            if (!object_name.empty()) {
                append_xml_element(out, 4, "OBJECT_NAME", object_name);
            }
            const auto object_id = flatbuffer_string(cat->OBJECT_ID());
            if (!object_id.empty()) {
                append_xml_element(out, 4, "INTERNATIONAL_DESIGNATOR", object_id);
            }
            const auto object_type = object_type_to_xml(cat->OBJECT_TYPE());
            if (!object_type.empty()) {
                append_xml_element(out, 4, "OBJECT_TYPE", object_type);
            }
        }
        const auto ephemeris_name = flatbuffer_string(object->EPHEMERIS_NAME());
        if (!ephemeris_name.empty()) {
            append_xml_element(out, 4, "EPHEMERIS_NAME", ephemeris_name);
        }
        append_xml_element(out, 4, "COVARIANCE_METHOD", "CALCULATED");
        if (cat) {
            append_xml_element(out, 4, "MANEUVERABLE", cat->MANEUVERABLE() ? "YES" : "NO");
        }
    }
    append_xml_indent(out, 3);
    out << "</metadata>\n";

    append_xml_indent(out, 3);
    out << "<data>\n";
    append_xml_indent(out, 4);
    out << "<stateVector>\n";
    if (object) {
        append_xml_element(out, 5, "X", format_decimal(object->X(), 6), "km");
        append_xml_element(out, 5, "Y", format_decimal(object->Y(), 6), "km");
        append_xml_element(out, 5, "Z", format_decimal(object->Z(), 6), "km");
        append_xml_element(out, 5, "X_DOT", format_decimal(object->X_DOT(), 9), "km/s");
        append_xml_element(out, 5, "Y_DOT", format_decimal(object->Y_DOT(), 9), "km/s");
        append_xml_element(out, 5, "Z_DOT", format_decimal(object->Z_DOT(), 9), "km/s");
    }
    append_xml_indent(out, 4);
    out << "</stateVector>\n";

    append_xml_indent(out, 4);
    out << "<covarianceMatrix>\n";
    if (object && object->COVARIANCE()) {
        const auto* covariance = object->COVARIANCE();
        for (const auto& field : kCovarianceFields) {
            if (covariance->size() <= field.index) {
                continue;
            }
            append_xml_element(
                out,
                5,
                field.key,
                format_scientific(covariance->Get(static_cast<flatbuffers::uoffset_t>(field.index)) * 1000000.0),
                covariance_xml_unit(field.index));
        }
    }
    append_xml_indent(out, 4);
    out << "</covarianceMatrix>\n";
    append_xml_indent(out, 3);
    out << "</data>\n";
    append_xml_indent(out, 2);
    out << "</segment>\n";
}

} // namespace

static std::string now_iso() {
    time_t now = time(nullptr);
    struct tm* gmt = gmtime(&now);
    char buf[64];
    snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02dZ",
             gmt->tm_year + 1900, gmt->tm_mon + 1, gmt->tm_mday,
             gmt->tm_hour, gmt->tm_min, gmt->tm_sec);
    return buf;
}

static Covariance3x3 covariance_from_cdm_object(const CDMObject* object) {
    if (!object || !object->COVARIANCE() || object->COVARIANCE()->size() < 6) {
        throw std::invalid_argument("CDM object covariance must contain at least the 3x3 position block.");
    }

    const auto* covariance = object->COVARIANCE();
    Covariance3x3 result{};
    result.data[0] = covariance->Get(0);  // CR_R
    result.data[1] = covariance->Get(1);  // CT_R
    result.data[3] = covariance->Get(1);
    result.data[4] = covariance->Get(2);  // CT_T
    result.data[2] = covariance->Get(3);  // CN_R
    result.data[6] = covariance->Get(3);
    result.data[5] = covariance->Get(4);  // CN_T
    result.data[7] = covariance->Get(4);
    result.data[8] = covariance->Get(5);  // CN_N
    return result;
}

static bool cdm_object_has_cartesian_state(const CDMObject* object) {
    if (!object) {
        return false;
    }
    return object->X() != 0.0 || object->Y() != 0.0 || object->Z() != 0.0 ||
           object->X_DOT() != 0.0 || object->Y_DOT() != 0.0 || object->Z_DOT() != 0.0;
}

static StateVector state_from_cdm_object(const CDMObject* object) {
    if (!object) {
        return StateVector{};
    }
    return StateVector{
        0.0,
        object->X(),
        object->Y(),
        object->Z(),
        object->X_DOT(),
        object->Y_DOT(),
        object->Z_DOT()
    };
}

static std::string cdm_object_reference_frame_name(const CDMObject* object) {
    if (!object || !object->REFERENCE_FRAME() || !object->REFERENCE_FRAME()->NAME()) {
        return std::string();
    }
    return object->REFERENCE_FRAME()->NAME()->str();
}

static bool cdm_object_uses_earth_fixed_frame(const CDMObject* object) {
    const auto frame = upper(cdm_object_reference_frame_name(object));
    return frame.find("ITRF") != std::string::npos ||
           frame.find("EFG") != std::string::npos ||
           frame.find("FIXED") != std::string::npos ||
           frame.find("WGS84") != std::string::npos;
}

static void apply_earth_fixed_velocity_correction(StateVector* state) {
    if (!state) {
        return;
    }
    constexpr double earth_rotation_rad_per_sec = 7.2921150e-5;
    const double correction_x = -earth_rotation_rad_per_sec * state->y;
    const double correction_y = earth_rotation_rad_per_sec * state->x;
    state->vx += correction_x;
    state->vy += correction_y;
}

// ── Build CDMObject for one conjunction participant ──

static flatbuffers::Offset<CDMObject> build_cdm_object(
    flatbuffers::FlatBufferBuilder& builder,
    const TLE& tle,
    const StateVector& state,
    const ConjunctionEvent& event,
    int obj_num,
    double cov_r, double cov_t, double cov_n) {

    // RTN position/velocity relative to TCA
    double pos_r, pos_t, pos_n, vel_r, vel_t, vel_n;
    if (obj_num == 1) {
        pos_r = event.rel_pos_r; pos_t = event.rel_pos_t; pos_n = event.rel_pos_n;
        vel_r = event.rel_vel_r; vel_t = event.rel_vel_t; vel_n = event.rel_vel_n;
    } else {
        pos_r = 0; pos_t = 0; pos_n = 0;  // Object 2 is at origin in relative frame
        vel_r = 0; vel_t = 0; vel_n = 0;
    }

    // Build CAT (catalog) object
    auto obj_name = builder.CreateString(tle.name);
    auto obj_id = builder.CreateString(
        std::to_string(tle.norad_cat_id > 0 ? tle.norad_cat_id : 0));

    CATBuilder cat_builder(builder);
    cat_builder.add_OBJECT_NAME(obj_name);
    cat_builder.add_NORAD_CAT_ID(tle.norad_cat_id);
    auto cat = cat_builder.Finish();

    // Build covariance array (6×6 lower triangular = 21 elements for pos+vel)
    // CDM uses 9×9 (45 elements) but we only fill the 6×6 block
    std::vector<double> cov_data(45, 0.0);
    // CR_R (index 0)
    cov_data[0] = cov_r * cov_r / 1e6;  // m² → km²
    // CT_T (index 2)
    cov_data[2] = cov_t * cov_t / 1e6;
    // CN_N (index 5)
    cov_data[5] = cov_n * cov_n / 1e6;

    auto cov_vec = builder.CreateVector(cov_data);

    auto comment = builder.CreateString("SGP4 propagation");
    auto gravity = builder.CreateString("SGP4/SDP4");
    auto atm = builder.CreateString("None");

    CDMObjectBuilder obj_builder(builder);
    obj_builder.add_COMMENT(comment);
    obj_builder.add_OBJECT(cat);
    obj_builder.add_GRAVITY_MODEL(gravity);
    obj_builder.add_ATMOSPHERIC_MODEL(atm);
    obj_builder.add_X(pos_r);
    obj_builder.add_Y(pos_t);
    obj_builder.add_Z(pos_n);
    obj_builder.add_X_DOT(vel_r);
    obj_builder.add_Y_DOT(vel_t);
    obj_builder.add_Z_DOT(vel_n);
    obj_builder.add_COVARIANCE(cov_vec);

    return obj_builder.Finish();
}

// ── Public API: Serialize conjunction event to CDM FlatBuffers ──

int32_t conjunction_to_cdm(
    const ConjunctionEvent& event,
    uint8_t* output, uint32_t output_capacity) {

    flatbuffers::FlatBufferBuilder builder(4096);

    // Header strings
    auto creation_date = builder.CreateString(now_iso());
    auto originator = builder.CreateString("LOBSTERNAUT-CA");
    auto message_id = builder.CreateString(
        "CDM-" + std::to_string(event.obj1.norad_cat_id) + "-" +
        std::to_string(event.obj2.norad_cat_id));
    auto tca_str = builder.CreateString(
        event.tca_iso.empty() ? jd_to_iso(event.tca_jd) : event.tca_iso);
    auto prob_method = builder.CreateString(event.probability_method);

    // Screen period
    auto screen_start = builder.CreateString(jd_to_iso(event.tca_jd - 3.5));
    auto screen_stop = builder.CreateString(jd_to_iso(event.tca_jd + 3.5));

    // Build object entries
    auto obj1 = build_cdm_object(builder, event.obj1, event.state1, event,
                                  1, event.cov_r1, event.cov_t1, event.cov_n1);
    auto obj2 = build_cdm_object(builder, event.obj2, event.state2, event,
                                  2, event.cov_r2, event.cov_t2, event.cov_n2);

    // Build CDM
    CDMBuilder cdm_builder(builder);
    cdm_builder.add_CCSDS_CDM_VERS(1.0);
    cdm_builder.add_CREATION_DATE(creation_date);
    cdm_builder.add_ORIGINATOR(originator);
    cdm_builder.add_MESSAGE_ID(message_id);
    cdm_builder.add_TCA(tca_str);
    cdm_builder.add_MISS_DISTANCE(event.min_range_km);
    cdm_builder.add_RELATIVE_SPEED(event.rel_speed_kms);
    cdm_builder.add_RELATIVE_POSITION_R(event.rel_pos_r);
    cdm_builder.add_RELATIVE_POSITION_T(event.rel_pos_t);
    cdm_builder.add_RELATIVE_POSITION_N(event.rel_pos_n);
    cdm_builder.add_RELATIVE_VELOCITY_R(event.rel_vel_r);
    cdm_builder.add_RELATIVE_VELOCITY_T(event.rel_vel_t);
    cdm_builder.add_RELATIVE_VELOCITY_N(event.rel_vel_n);
    cdm_builder.add_START_SCREEN_PERIOD(screen_start);
    cdm_builder.add_STOP_SCREEN_PERIOD(screen_stop);
    cdm_builder.add_SCREEN_VOLUME_SHAPE(screeningVolumeShape::ELLIPSOID);
    cdm_builder.add_SCREEN_VOLUME_X(DEFAULT_THRESHOLD_KM);
    cdm_builder.add_SCREEN_VOLUME_Y(DEFAULT_THRESHOLD_KM);
    cdm_builder.add_SCREEN_VOLUME_Z(DEFAULT_THRESHOLD_KM);
    cdm_builder.add_COLLISION_PROBABILITY(event.max_probability);
    cdm_builder.add_COLLISION_PROBABILITY_METHOD(prob_method);
    cdm_builder.add_OBJECT1(obj1);
    cdm_builder.add_OBJECT2(obj2);

    auto cdm = cdm_builder.Finish();
    builder.Finish(cdm, "$CDM");

    // Copy to output
    auto buf = builder.GetBufferPointer();
    auto size = builder.GetSize();

    if (size > output_capacity) return -2;  // buffer too small
    std::memcpy(output, buf, size);
    return static_cast<int32_t>(size);
}

// ── Batch: multiple conjunctions to CDM collection ──

int32_t conjunctions_to_cdm_batch(
    const std::vector<ConjunctionEvent>& events,
    uint8_t* output, uint32_t output_capacity) {

    // For a collection, we serialize each CDM individually and pack them
    // sequentially with size prefixes (standard FlatBuffers size-prefixed format)
    uint32_t offset = 0;

    for (const auto& event : events) {
        if (offset + 4 >= output_capacity) return -2;

        // Reserve space for size prefix
        uint32_t remaining = output_capacity - offset - 4;
        int32_t written = conjunction_to_cdm(event, output + offset + 4, remaining);

        if (written < 0) return written;  // propagate error

        // Write size prefix (little-endian)
        uint32_t size = static_cast<uint32_t>(written);
        std::memcpy(output + offset, &size, 4);
        offset += 4 + size;
    }

    return static_cast<int32_t>(offset);
}

int32_t cdm_kvn_to_sds(
    const char* kvn_text, uint32_t kvn_text_size,
    uint8_t* output, uint32_t output_capacity) {

    try {
        if (!output || output_capacity == 0u) {
            return -2;
        }
        const auto parsed = parse_cdm_kvn(kvn_text, kvn_text_size);
        const auto bytes = build_cdm_flatbuffer_from_parsed(parsed);
        if (bytes.size() > output_capacity) {
            return -2;
        }
        std::memcpy(output, bytes.data(), bytes.size());
        return static_cast<int32_t>(bytes.size());
    } catch (...) {
        return -1;
    }
}

int32_t cdm_xml_to_sds(
    const char* xml_text, uint32_t xml_text_size,
    uint8_t* output, uint32_t output_capacity) {

    try {
        if (!output || output_capacity == 0u) {
            return -2;
        }
        const auto parsed = parse_cdm_xml(xml_text, xml_text_size);
        const auto bytes = build_cdm_flatbuffer_from_parsed(parsed);
        if (bytes.size() > output_capacity) {
            return -2;
        }
        std::memcpy(output, bytes.data(), bytes.size());
        return static_cast<int32_t>(bytes.size());
    } catch (...) {
        return -1;
    }
}

int32_t cdm_sds_to_kvn(
    const uint8_t* cdm_buffer, uint32_t cdm_buffer_size,
    char* output, uint32_t output_capacity) {

    try {
        if (!output || output_capacity == 0u) {
            return -2;
        }
        if (!cdm_buffer || cdm_buffer_size == 0u) {
            return -1;
        }

        flatbuffers::Verifier verifier(cdm_buffer, cdm_buffer_size);
        if (!VerifyCDMBuffer(verifier)) {
            return -1;
        }
        const CDM* cdm = GetCDM(cdm_buffer);
        if (!cdm) {
            return -1;
        }

        std::ostringstream kvn;
        kvn << std::left;
        append_kvn_line(kvn, "CCSDS_CDM_VERS", format_decimal(cdm->CCSDS_CDM_VERS(), 1));
        const auto creation_date = flatbuffer_string(cdm->CREATION_DATE());
        if (!creation_date.empty()) {
            append_kvn_line(kvn, "CREATION_DATE", creation_date);
        }
        const auto originator = flatbuffer_string(cdm->ORIGINATOR());
        if (!originator.empty()) {
            append_kvn_line(kvn, "ORIGINATOR", originator);
        }
        const auto message_for = flatbuffer_string(cdm->MESSAGE_FOR());
        if (!message_for.empty()) {
            append_kvn_line(kvn, "MESSAGE_FOR", message_for);
        }
        const auto message_id = flatbuffer_string(cdm->MESSAGE_ID());
        if (!message_id.empty()) {
            append_kvn_line(kvn, "MESSAGE_ID", message_id);
        }
        const auto tca = flatbuffer_string(cdm->TCA());
        if (!tca.empty()) {
            append_kvn_line(kvn, "TCA", tca);
        }
        append_kvn_line(kvn, "MISS_DISTANCE", format_decimal(cdm->MISS_DISTANCE() * 1000.0, 6), "m");
        if (cdm->RELATIVE_SPEED() != 0.0) {
            append_kvn_line(kvn, "RELATIVE_SPEED", format_decimal(cdm->RELATIVE_SPEED() * 1000.0, 6), "m/s");
        }
        if (cdm->RELATIVE_POSITION_R() != 0.0 ||
            cdm->RELATIVE_POSITION_T() != 0.0 ||
            cdm->RELATIVE_POSITION_N() != 0.0) {
            append_kvn_line(kvn, "RELATIVE_POSITION_R", format_decimal(cdm->RELATIVE_POSITION_R() * 1000.0, 6), "m");
            append_kvn_line(kvn, "RELATIVE_POSITION_T", format_decimal(cdm->RELATIVE_POSITION_T() * 1000.0, 6), "m");
            append_kvn_line(kvn, "RELATIVE_POSITION_N", format_decimal(cdm->RELATIVE_POSITION_N() * 1000.0, 6), "m");
        }
        if (cdm->RELATIVE_VELOCITY_R() != 0.0 ||
            cdm->RELATIVE_VELOCITY_T() != 0.0 ||
            cdm->RELATIVE_VELOCITY_N() != 0.0) {
            append_kvn_line(kvn, "RELATIVE_VELOCITY_R", format_decimal(cdm->RELATIVE_VELOCITY_R() * 1000.0, 6), "m/s");
            append_kvn_line(kvn, "RELATIVE_VELOCITY_T", format_decimal(cdm->RELATIVE_VELOCITY_T() * 1000.0, 6), "m/s");
            append_kvn_line(kvn, "RELATIVE_VELOCITY_N", format_decimal(cdm->RELATIVE_VELOCITY_N() * 1000.0, 6), "m/s");
        }
        if (cdm->COLLISION_PROBABILITY() != 0.0) {
            append_kvn_line(kvn, "COLLISION_PROBABILITY", format_scientific(cdm->COLLISION_PROBABILITY()));
        }
        const auto pc_method = flatbuffer_string(cdm->COLLISION_PROBABILITY_METHOD());
        if (!pc_method.empty()) {
            append_kvn_line(kvn, "COLLISION_PROBABILITY_METHOD", pc_method);
        }
        append_kvn_object(kvn, cdm->OBJECT1(), "OBJECT1");
        append_kvn_object(kvn, cdm->OBJECT2(), "OBJECT2");

        const auto text = kvn.str();
        if (text.size() > output_capacity) {
            return -2;
        }
        std::memcpy(output, text.data(), text.size());
        return static_cast<int32_t>(text.size());
    } catch (...) {
        return -1;
    }
}

int32_t cdm_sds_to_xml(
    const uint8_t* cdm_buffer, uint32_t cdm_buffer_size,
    char* output, uint32_t output_capacity) {

    try {
        if (!output || output_capacity == 0u) {
            return -2;
        }
        if (!cdm_buffer || cdm_buffer_size == 0u) {
            return -1;
        }

        flatbuffers::Verifier verifier(cdm_buffer, cdm_buffer_size);
        if (!VerifyCDMBuffer(verifier)) {
            return -1;
        }
        const CDM* cdm = GetCDM(cdm_buffer);
        if (!cdm) {
            return -1;
        }

        std::ostringstream xml;
        xml << "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";
        xml << "<cdm id=\"CCSDS_CDM_VERS\" version=\""
            << xml_escape(format_decimal(cdm->CCSDS_CDM_VERS(), 1))
            << "\">\n";
        append_xml_indent(xml, 1);
        xml << "<header>\n";
        const auto creation_date = flatbuffer_string(cdm->CREATION_DATE());
        if (!creation_date.empty()) {
            append_xml_element(xml, 2, "CREATION_DATE", creation_date);
        }
        const auto originator = flatbuffer_string(cdm->ORIGINATOR());
        if (!originator.empty()) {
            append_xml_element(xml, 2, "ORIGINATOR", originator);
        }
        const auto message_for = flatbuffer_string(cdm->MESSAGE_FOR());
        if (!message_for.empty()) {
            append_xml_element(xml, 2, "MESSAGE_FOR", message_for);
        }
        const auto message_id = flatbuffer_string(cdm->MESSAGE_ID());
        if (!message_id.empty()) {
            append_xml_element(xml, 2, "MESSAGE_ID", message_id);
        }
        append_xml_indent(xml, 1);
        xml << "</header>\n";

        append_xml_indent(xml, 1);
        xml << "<body>\n";
        append_xml_indent(xml, 2);
        xml << "<relativeMetadataData>\n";
        const auto tca = flatbuffer_string(cdm->TCA());
        if (!tca.empty()) {
            append_xml_element(xml, 3, "TCA", tca);
        }
        append_xml_element(xml, 3, "MISS_DISTANCE", format_decimal(cdm->MISS_DISTANCE() * 1000.0, 6), "m");
        if (cdm->RELATIVE_SPEED() != 0.0) {
            append_xml_element(xml, 3, "RELATIVE_SPEED", format_decimal(cdm->RELATIVE_SPEED() * 1000.0, 6), "m/s");
        }
        if (cdm->RELATIVE_POSITION_R() != 0.0 ||
            cdm->RELATIVE_POSITION_T() != 0.0 ||
            cdm->RELATIVE_POSITION_N() != 0.0 ||
            cdm->RELATIVE_VELOCITY_R() != 0.0 ||
            cdm->RELATIVE_VELOCITY_T() != 0.0 ||
            cdm->RELATIVE_VELOCITY_N() != 0.0) {
            append_xml_indent(xml, 3);
            xml << "<relativeStateVector>\n";
            append_xml_element(xml, 4, "RELATIVE_POSITION_R", format_decimal(cdm->RELATIVE_POSITION_R() * 1000.0, 6), "m");
            append_xml_element(xml, 4, "RELATIVE_POSITION_T", format_decimal(cdm->RELATIVE_POSITION_T() * 1000.0, 6), "m");
            append_xml_element(xml, 4, "RELATIVE_POSITION_N", format_decimal(cdm->RELATIVE_POSITION_N() * 1000.0, 6), "m");
            append_xml_element(xml, 4, "RELATIVE_VELOCITY_R", format_decimal(cdm->RELATIVE_VELOCITY_R() * 1000.0, 6), "m/s");
            append_xml_element(xml, 4, "RELATIVE_VELOCITY_T", format_decimal(cdm->RELATIVE_VELOCITY_T() * 1000.0, 6), "m/s");
            append_xml_element(xml, 4, "RELATIVE_VELOCITY_N", format_decimal(cdm->RELATIVE_VELOCITY_N() * 1000.0, 6), "m/s");
            append_xml_indent(xml, 3);
            xml << "</relativeStateVector>\n";
        }
        if (cdm->COLLISION_PROBABILITY() != 0.0) {
            append_xml_element(xml, 3, "COLLISION_PROBABILITY", format_scientific(cdm->COLLISION_PROBABILITY()));
        }
        const auto pc_method = flatbuffer_string(cdm->COLLISION_PROBABILITY_METHOD());
        if (!pc_method.empty()) {
            append_xml_element(xml, 3, "COLLISION_PROBABILITY_METHOD", pc_method);
        }
        append_xml_indent(xml, 2);
        xml << "</relativeMetadataData>\n";

        append_xml_object(xml, cdm->OBJECT1(), "OBJECT1");
        append_xml_object(xml, cdm->OBJECT2(), "OBJECT2");
        append_xml_indent(xml, 1);
        xml << "</body>\n";
        xml << "</cdm>\n";

        const auto text = xml.str();
        if (text.size() > output_capacity) {
            return -2;
        }
        std::memcpy(output, text.data(), text.size());
        return static_cast<int32_t>(text.size());
    } catch (...) {
        return -1;
    }
}

PcResult compute_pc_from_cdm(
    const uint8_t* cdm_buffer, uint32_t cdm_buffer_size,
    const std::string& method_override,
    double combined_radius_km) {

    if (!cdm_buffer || cdm_buffer_size == 0) {
        throw std::invalid_argument("CDM input buffer is empty.");
    }

    flatbuffers::Verifier verifier(cdm_buffer, cdm_buffer_size);
    if (!VerifyCDMBuffer(verifier)) {
        throw std::invalid_argument("CDM FlatBuffer verification failed.");
    }

    const CDM* cdm = GetCDM(cdm_buffer);
    if (!cdm) {
        throw std::invalid_argument("CDM root is missing.");
    }
    if (!cdm->OBJECT1() || !cdm->OBJECT2()) {
        throw std::invalid_argument("CDM input requires both object blocks.");
    }

    StateVector state1{};
    StateVector state2{};
    Covariance3x3 cov1 = covariance_from_cdm_object(cdm->OBJECT1());
    Covariance3x3 cov2 = covariance_from_cdm_object(cdm->OBJECT2());
    if (cdm_object_has_cartesian_state(cdm->OBJECT1()) &&
        cdm_object_has_cartesian_state(cdm->OBJECT2())) {
        state1 = state_from_cdm_object(cdm->OBJECT1());
        state2 = state_from_cdm_object(cdm->OBJECT2());
        if (cdm_object_uses_earth_fixed_frame(cdm->OBJECT1())) {
            apply_earth_fixed_velocity_correction(&state1);
        }
        if (cdm_object_uses_earth_fixed_frame(cdm->OBJECT2())) {
            apply_earth_fixed_velocity_correction(&state2);
        }
        cov1 = covariance_rtn_to_inertial(cov1, state1);
        cov2 = covariance_rtn_to_inertial(cov2, state2);
    } else {
        state1 = StateVector{
            0.0,
            cdm->RELATIVE_POSITION_R(),
            cdm->RELATIVE_POSITION_T(),
            cdm->RELATIVE_POSITION_N(),
            cdm->RELATIVE_VELOCITY_R(),
            cdm->RELATIVE_VELOCITY_T(),
            cdm->RELATIVE_VELOCITY_N()
        };
        state2 = StateVector{0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
    }

    std::string method = method_override;
    if (method.empty() && cdm->COLLISION_PROBABILITY_METHOD()) {
        method = cdm->COLLISION_PROBABILITY_METHOD()->str();
    }
    if (method.empty()) {
        method = "FOSTER-2D";
    }

    ConjunctionEngine engine;
    engine.set_pc_method(method);
    return engine.compute_pc(state1, state2, cov1, cov2, combined_radius_km).pc;
}

} // namespace conjunction
