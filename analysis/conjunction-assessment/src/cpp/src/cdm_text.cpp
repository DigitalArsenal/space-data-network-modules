/** CCSDS CDM text serialization. Both syntaxes consume the same ordered fields. */
#include "conjunction/conjunction_assessment.h"
#include "conjunction/cdm_fields.h"
#include "conjunction/cdm_text.h"
#include "conjunction/error_status.h"
#include "CDM_generated.h"
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstring>
#include <cstdlib>
#include <iomanip>
#include <limits>
#include <sstream>

// ERFA is supplied by the module's existing frames/time amalgamation.
extern "C" int eraDtf2d(const char*, int, int, int, int, int, double, double*, double*);

namespace conjunction {
std::string cdm_probability_method_name(const std::string& method) {
    if (method == "FOSTER-2D" || method == "FOSTER") return "FOSTER-1992";
    if (method == "ALFANO-MAXPROB" || method == "ALFANO-SPHERICAL-SMALL-HBR-MAX" || method == "ALFANO_MAXIMUM")
        return "ALFANO-MAX-PROBABILITY";
    if (method == "CHAN" || method == "CHAN-2008") return "CHAN-1997";
    if (method == "ALFANO_2005") return "ALFANO-2005";
    // The legacy implementation integrates the disk by polar midpoint
    // quadrature, not Patera's published contour method.
    if (method == "PATERA-2001" || method == "PATERA") return "PATERA-LEGACY-POLAR";
    return method;
}

std::string cdm_internal_probability_method_name(const std::string& method) {
    if (method == "ALFANO-MAX-PROBABILITY") return "ALFANO-MAXPROB";
    if (method == "FOSTER-1992") return "FOSTER-2D";
    if (method == "PATERA-LEGACY-POLAR") return "PATERA-2001";
    return method;
}

namespace cdm_text_detail {
struct Field { std::string key, value, unit; };
using Fields = std::vector<Field>;
struct ObjectFields { Fields metadata, od, additional, state, covariance; };
struct Document { Fields header, relative; ObjectFields objects[2]; };

static std::string text(const flatbuffers::String* s) { return s ? s->str() : std::string(); }
static std::string uppercase(std::string s) {
    for (auto& c : s) if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
    return s;
}
static bool fail(const char* code, const std::string& message) {
    set_error(std::string(code) + ": " + message);
    return false;
}
static bool token(const std::string& s) {
    return !s.empty() && std::all_of(s.begin(), s.end(), [](unsigned char c) {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') || c == '_' || c == '-';
    });
}
static bool digits(const std::string& s) {
    return !s.empty() && std::all_of(s.begin(), s.end(), [](char c) { return c >= '0' && c <= '9'; });
}
static bool international_designator(const std::string& s) {
    return s == "UNKNOWN" || (s.size() >= 9 && s.size() <= 11 && s[4] == '-' &&
        digits(s.substr(0, 4)) && digits(s.substr(5, 3)) &&
        std::all_of(s.begin() + 8, s.end(), [](char c) { return c >= 'A' && c <= 'Z'; }));
}
static bool epoch(const std::string& s) {
    // Calendar and day-of-year forms, in UTC, optionally with a trailing Z.
    const size_t t = s.find('T');
    if (t != 10 && t != 8) return false;
    if (!digits(s.substr(0, 4)) || s[4] != '-') return false;
    if (t == 10 ? (s[7] != '-' || !digits(s.substr(5, 2)) || !digits(s.substr(8, 2))) : !digits(s.substr(5, 3))) return false;
    if (s.size() < t + 9 || s[t + 3] != ':' || s[t + 6] != ':' ||
        !digits(s.substr(t + 1, 2)) || !digits(s.substr(t + 4, 2)) || !digits(s.substr(t + 7, 2))) return false;
    const int year = std::atoi(s.substr(0, 4).c_str());
    if (year < 1) return false;
    const bool leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    const int days[] = {31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    int month = 1, day = 1;
    if (t == 10) {
        month = std::atoi(s.substr(5, 2).c_str()); day = std::atoi(s.substr(8, 2).c_str());
        if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return false;
    } else {
        day = std::atoi(s.substr(5, 3).c_str());
        if (day < 1 || day > (leap ? 366 : 365)) return false;
        while (day > days[month - 1]) { day -= days[month - 1]; ++month; }
    }
    const int hour = std::atoi(s.substr(t + 1, 2).c_str()), minute = std::atoi(s.substr(t + 4, 2).c_str());
    size_t end = s.size();
    if (s.back() == 'Z') --end;
    if (!(end == t + 9 || (end > t + 10 && s[t + 9] == '.' && digits(s.substr(t + 10, end - t - 10))))) return false;
    const double second = std::strtod(s.substr(t + 7, end - t - 7).c_str(), nullptr);
    double utc1 = 0, utc2 = 0;
    const int status = eraDtf2d("UTC", year, month, day, hour, minute, second, &utc1, &utc2);
    // Accept ERFA's dubious-year warning, but not a time after the day's
    // actual UTC end (status 2/3), including a spurious leap second.
    return status == 0 || status == 1;
}
static std::string utc_text(std::string s) {
    if (!s.empty() && s.back() == 'Z') s.pop_back();
    return s;
}
static std::string number(double value) {
    if (!std::isfinite(value)) { fail("cdm-numeric-invalid", "Every numeric value must be finite."); return {}; }
    // CCSDS 6.3.2.2-3: at most 16 mantissa digits, including the integer digit.
    std::ostringstream out;
    out << std::uppercase << std::scientific << std::setprecision(15) << (value == 0 ? 0.0 : value);
    return out.str();
}
static std::string escaped(const std::string& value) {
    std::string result;
    for (char c : value) {
        if (c == '&') result += "&amp;";
        else if (c == '<') result += "&lt;";
        else if (c == '>') result += "&gt;";
        else if (c == '"') result += "&quot;";
        else result += c;
    }
    return result;
}
static void add(Fields& fields, const char* key, std::string value, const char* unit = "") {
    if (std::any_of(value.begin(), value.end(), [](unsigned char c) { return c < 32 || c > 126; }))
        fail("cdm-character-invalid", std::string(key) + " requires printable ASCII without line breaks.");
    fields.push_back({key, uppercase(std::move(value)), unit});
}
static void optional(Fields& fields, const char* key, const flatbuffers::String* value) {
    if (value && !value->str().empty()) add(fields, key, value->str());
}
static void nonzero(Fields& fields, const char* key, double value, const char* unit = "") {
    if (value != 0.0) add(fields, key, number(value), unit);
}
static void count(Fields& fields, const char* key, uint32_t value) {
    if (value > 2147483647u) fail("cdm-numeric-invalid", std::string(key) + " exceeds the CCSDS signed integer range.");
    if (value) add(fields, key, std::to_string(value));
}
static void comments(Fields& fields, const std::string& value) {
    // Share wrapping between KVN and XML, retaining case and all comment text.
    // The escaped content budget leaves room for XML tags and indentation.
    std::istringstream lines(value);
    std::string line;
    while (std::getline(lines, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        while (!line.empty()) {
            size_t end = 0, width = 0;
            while (end < line.size()) {
                const size_t next = escaped(line.substr(end, 1)).size();
                if (width + next > 200) break;
                width += next; ++end;
            }
            fields.push_back({"COMMENT", line.substr(0, end), ""});
            line.erase(0, end);
        }
    }
}
static bool registered_method(const std::string& method) {
    // SANA cdm_cpm snapshot supplied with the conformance fixtures, 2026-10-16.
    static const char* values[] = {"AKELLAALFRIEND-2000", "ALFANO-2005", "ALFANO-MAX-PROBABILITY",
        "ALFANO-PARAL-2007", "ALFANO-TUBES-2007", "ALFANO-VOXELS-2006", "ALFRIEND-1999",
        "CHAN-1997", "CHAN-2003", "COPPOLA-2012", "FOSTER-1992", "MCKINLEY-2006",
        "PATERA-2001", "PATERA-2003", "PATERA-2005"};
    return std::any_of(std::begin(values), std::end(values), [&](const char* v) { return method == v; });
}
static bool registered_catalog(const std::string& catalog) {
    static const char* values[] = {"ALMANAC", "COMSPOC", "ESA_ESAC", "ISON", "LEOLABS", "NASA_DSN", "RUSSIA", "SATCAT", "UNOOSA"};
    return std::any_of(std::begin(values), std::end(values), [&](const char* v) { return catalog == v; });
}
static std::string reference_frame(const CDMObject* object) {
    const auto* frame = object->REFERENCE_FRAME();
    if (!frame) return {};
    if (frame->NAME() && !frame->NAME()->str().empty()) return uppercase(frame->NAME()->str());
    const auto* celestial = frame->REFERENCE_FRAME_as_CelestialFrameWrapper();
    if (celestial) {
        if (celestial->frame() == CelestialFrame::EME2000) return "EME2000";
        if (celestial->frame() == CelestialFrame::GCRF) return "GCRF";
        if (celestial->frame() == CelestialFrame::ITRF2000 || celestial->frame() == CelestialFrame::ITRF93 || celestial->frame() == CelestialFrame::ITRF97) return "ITRF";
    }
    return {};
}
static bool object_fields(const CDMObject* object, const char* label, ObjectFields& out) {
    if (!object || !object->OBJECT()) return fail("cdm-object-required", std::string(label) + " metadata is required.");
    const auto* cov = object->COVARIANCE();
    if (!cov || cov->size() < 21) return fail("cdm-covariance-required", std::string(label) + " requires the complete 21-cell RTN covariance.");
    if (!cdm_complete_covariance_rows(cov->size())) return fail("cdm-covariance-incomplete", std::string(label) + " covariance must contain 21, 28, 36 or 45 cells (complete rows).");
    const CAT* cat = object->OBJECT();
    std::string designator = text(object->OBJECT_DESIGNATOR()), catalog = uppercase(text(object->CATALOG_NAME()));
    if (cat->NORAD_CAT_ID()) {
        if (designator.empty()) designator = std::to_string(cat->NORAD_CAT_ID());
        if (catalog.empty()) catalog = "SATCAT";
    } else if (digits(text(cat->OBJECT_ID()))) {
        if (designator.empty()) designator = text(cat->OBJECT_ID());
        if (catalog.empty()) catalog = "SATCAT";
    }
    if (designator.empty() || catalog.empty()) return fail("cdm-object-uncatalogued", std::string(label) + " has no honest catalog designator and catalog name.");
    if (!token(designator) || !registered_catalog(catalog)) return fail("cdm-object-uncatalogued", std::string(label) + " has an invalid designator or unregistered catalog.");
    const auto name = text(cat->OBJECT_NAME());
    if (name.empty()) return fail("cdm-object-name-required", std::string(label) + " requires OBJECT_NAME.");
    auto object_id = uppercase(text(cat->OBJECT_ID()));
    if (!international_designator(object_id)) object_id = "UNKNOWN";
    auto ephemeris_name = text(object->EPHEMERIS_NAME());
    if (ephemeris_name.empty()) return fail("cdm-ephemeris-required", std::string(label) + " requires its source EPHEMERIS_NAME (NONE only for OD output).");
    const auto frame = reference_frame(object);
    if (frame != "EME2000" && frame != "GCRF" && frame != "ITRF") return fail("cdm-frame-invalid", std::string(label) + " requires EME2000, GCRF or ITRF states.");
    comments(out.metadata, text(object->COMMENT()));
    // Table 3-3. This is the sole metadata keyword/order representation.
    add(out.metadata, "OBJECT", label);
    add(out.metadata, "OBJECT_DESIGNATOR", designator);
    add(out.metadata, "CATALOG_NAME", catalog);
    add(out.metadata, "OBJECT_NAME", name);
    add(out.metadata, "INTERNATIONAL_DESIGNATOR", object_id);
    const char* type = cat->OBJECT_TYPE() == spaceObjectClass::PAYLOAD ? "PAYLOAD" :
        cat->OBJECT_TYPE() == spaceObjectClass::ROCKET_BODY ? "ROCKET BODY" :
        cat->OBJECT_TYPE() == spaceObjectClass::DEBRIS ? "DEBRIS" : nullptr;
    if (type) add(out.metadata, "OBJECT_TYPE", type);
    optional(out.metadata, "OPERATOR_CONTACT_POSITION", object->OPERATOR_CONTACT_POSITION());
    optional(out.metadata, "OPERATOR_ORGANIZATION", object->OPERATOR_ORGANIZATION());
    add(out.metadata, "EPHEMERIS_NAME", ephemeris_name);
    if (object->COVARIANCE_METHOD() != covarianceAlgorithm::CALCULATED && object->COVARIANCE_METHOD() != covarianceAlgorithm::DEFAULT)
        return fail("cdm-covariance-method-invalid", "COVARIANCE_METHOD must be CALCULATED or DEFAULT.");
    add(out.metadata, "COVARIANCE_METHOD", EnumNamecovarianceAlgorithm(object->COVARIANCE_METHOD()));
    if (object->MANEUVERABLE() < cdmManeuverable::UNSPECIFIED || object->MANEUVERABLE() > cdmManeuverable::NOT_APPLICABLE)
        return fail("cdm-maneuverable-invalid", "MANEUVERABLE must be YES, NO, N/A or unspecified.");
    add(out.metadata, "MANEUVERABLE", object->MANEUVERABLE() == cdmManeuverable::YES ? "YES" : object->MANEUVERABLE() == cdmManeuverable::NO ? "NO" : "N/A");
    add(out.metadata, "REF_FRAME", frame);
    optional(out.metadata, "GRAVITY_MODEL", object->GRAVITY_MODEL());
    optional(out.metadata, "ATMOSPHERIC_MODEL", object->ATMOSPHERIC_MODEL());
    optional(out.metadata, "N_BODY_PERTURBATIONS", object->N_BODY_PERTURBATIONS());
    if (object->SOLAR_RAD_PRESSURE()) add(out.metadata, "SOLAR_RAD_PRESSURE", "YES");
    if (object->EARTH_TIDES()) add(out.metadata, "EARTH_TIDES", "YES");
    if (object->INTRACK_THRUST()) add(out.metadata, "INTRACK_THRUST", "YES");
    // Table 3-4: OD, additional parameters, state and covariance, in order.
    for (const auto& item : {std::make_pair("TIME_LASTOB_START", object->TIME_LASTOB_START()), std::make_pair("TIME_LASTOB_END", object->TIME_LASTOB_END())}) {
        if (item.second && !item.second->str().empty()) {
            if (!epoch(item.second->str())) return fail("cdm-epoch-invalid", item.first);
            add(out.od, item.first, utc_text(item.second->str()));
        }
    }
    if (object->RECOMMENDED_OD_SPAN() < 0 || object->ACTUAL_OD_SPAN() < 0 || object->WEIGHTED_RMS() < 0 || object->RESIDUALS_ACCEPTED() < 0 || object->RESIDUALS_ACCEPTED() > 100)
        return fail("cdm-od-quality-invalid", "OD spans and RMS must be nonnegative; RESIDUALS_ACCEPTED must be 0..100 percent.");
    nonzero(out.od, "RECOMMENDED_OD_SPAN", object->RECOMMENDED_OD_SPAN(), "d");
    nonzero(out.od, "ACTUAL_OD_SPAN", object->ACTUAL_OD_SPAN(), "d");
    count(out.od, "OBS_AVAILABLE", object->OBS_AVAILABLE()); count(out.od, "OBS_USED", object->OBS_USED());
    count(out.od, "TRACKS_AVAILABLE", object->TRACKS_AVAILABLE()); count(out.od, "TRACKS_USED", object->TRACKS_USED());
    nonzero(out.od, "RESIDUALS_ACCEPTED", object->RESIDUALS_ACCEPTED(), "%");
    nonzero(out.od, "WEIGHTED_RMS", object->WEIGHTED_RMS());
    nonzero(out.additional, "AREA_PC", object->AREA_PC(), "m**2");
    nonzero(out.additional, "AREA_DRG", object->AREA_DRG(), "m**2");
    nonzero(out.additional, "AREA_SRP", object->AREA_SRP(), "m**2");
    nonzero(out.additional, "MASS", cat->MASS(), "kg");
    nonzero(out.additional, "CD_AREA_OVER_MASS", object->CD_AREA_OVER_MASS(), "m**2/kg");
    nonzero(out.additional, "CR_AREA_OVER_MASS", object->CR_AREA_OVER_MASS(), "m**2/kg");
    nonzero(out.additional, "THRUST_ACCELERATION", object->THRUST_ACCELERATION(), "m/s**2");
    nonzero(out.additional, "SEDR", object->SEDR(), "W/kg");
    add(out.state, "X", number(object->X()), "km"); add(out.state, "Y", number(object->Y()), "km"); add(out.state, "Z", number(object->Z()), "km");
    add(out.state, "X_DOT", number(object->X_DOT()), "km/s"); add(out.state, "Y_DOT", number(object->Y_DOT()), "km/s"); add(out.state, "Z_DOT", number(object->Z_DOT()), "km/s");
    for (const size_t diagonal : {0u, 2u, 5u, 9u, 14u, 20u, 27u, 35u, 44u})
        if (diagonal < cov->size() && cov->Get(diagonal) < 0) return fail("cdm-covariance-invalid", "A covariance diagonal cannot be negative.");
    for (const auto& field : kCovarianceFields) {
        if (field.index >= cov->size()) break;
        add(out.covariance, field.key, number(cov->Get(field.index) * field.text_scale), field.unit);
    }
    return !has_error();
}
static bool document(const CDM* cdm, Document& out) {
    if (cdm->CCSDS_CDM_VERS() != 1.0) return fail("cdm-version-invalid", "CCSDS_CDM_VERS must be 1.0.");
    if (!epoch(text(cdm->CREATION_DATE())) || !epoch(text(cdm->TCA()))) return fail("cdm-epoch-invalid", "CREATION_DATE and TCA must be UTC epochs.");
    if (!token(text(cdm->ORIGINATOR())) || !token(text(cdm->MESSAGE_ID()))) return fail("cdm-header-invalid", "ORIGINATOR and MESSAGE_ID require nonempty CCSDS tokens.");
    if (cdm->MISS_DISTANCE() < 0 || cdm->RELATIVE_SPEED() < 0) return fail("cdm-numeric-invalid", "Miss distance and relative speed must be nonnegative.");
    add(out.header, "CCSDS_CDM_VERS", "1.0");
    add(out.header, "CREATION_DATE", utc_text(text(cdm->CREATION_DATE())));
    add(out.header, "ORIGINATOR", text(cdm->ORIGINATOR()));
    optional(out.header, "MESSAGE_FOR", cdm->MESSAGE_FOR());
    add(out.header, "MESSAGE_ID", text(cdm->MESSAGE_ID()));
    const auto method = uppercase(text(cdm->COLLISION_PROBABILITY_METHOD()));
    if (!method.empty() && !registered_method(method)) comments(out.relative, "Collision probability method " + method + " is unregistered in the SANA cdm_cpm registry.");
    add(out.relative, "TCA", utc_text(text(cdm->TCA())));
    add(out.relative, "MISS_DISTANCE", number(cdm->MISS_DISTANCE() * 1000.0), "m");
    nonzero(out.relative, "RELATIVE_SPEED", cdm->RELATIVE_SPEED() * 1000.0, "m/s");
    if (cdm->RELATIVE_POSITION_R() != 0 || cdm->RELATIVE_POSITION_T() != 0 || cdm->RELATIVE_POSITION_N() != 0 ||
        cdm->RELATIVE_VELOCITY_R() != 0 || cdm->RELATIVE_VELOCITY_T() != 0 || cdm->RELATIVE_VELOCITY_N() != 0) {
        add(out.relative, "RELATIVE_POSITION_R", number(cdm->RELATIVE_POSITION_R() * 1000.0), "m");
        add(out.relative, "RELATIVE_POSITION_T", number(cdm->RELATIVE_POSITION_T() * 1000.0), "m");
        add(out.relative, "RELATIVE_POSITION_N", number(cdm->RELATIVE_POSITION_N() * 1000.0), "m");
        add(out.relative, "RELATIVE_VELOCITY_R", number(cdm->RELATIVE_VELOCITY_R() * 1000.0), "m/s");
        add(out.relative, "RELATIVE_VELOCITY_T", number(cdm->RELATIVE_VELOCITY_T() * 1000.0), "m/s");
        add(out.relative, "RELATIVE_VELOCITY_N", number(cdm->RELATIVE_VELOCITY_N() * 1000.0), "m/s");
    }
    // A received CDM's probability belongs to its originator. Do not
    // recompute or suppress it based on rounded, serialized covariance.
    // The event builder decides whether a newly calculated Pc is available.
    if (!method.empty()) {
        if (cdm->COLLISION_PROBABILITY() < 0 || cdm->COLLISION_PROBABILITY() > 1) return fail("cdm-probability-invalid", "Collision probability must be in [0,1].");
        add(out.relative, "COLLISION_PROBABILITY", number(cdm->COLLISION_PROBABILITY()));
        add(out.relative, "COLLISION_PROBABILITY_METHOD", method);
    }
    if (!object_fields(cdm->OBJECT1(), "OBJECT1", out.objects[0]) || !object_fields(cdm->OBJECT2(), "OBJECT2", out.objects[1])) return false;
    if (reference_frame(cdm->OBJECT1()) != reference_frame(cdm->OBJECT2())) return fail("cdm-frame-invalid", "Both CDM objects must use the same frame.");
    return !has_error();
}
static void kvn_fields(std::ostringstream& out, const Fields& fields) {
    for (const auto& f : fields) {
        if (f.key == "COMMENT") out << "COMMENT " << f.value << '\n';
        else {
            out << std::left << std::setw(30) << f.key << "= " << f.value;
            if (!f.unit.empty()) out << " [" << f.unit << ']';
            out << '\n';
        }
    }
}
static void xml_field(std::ostringstream& out, const Field& f, int depth) {
    out << std::string(depth * 2, ' ') << '<' << f.key;
    if (!f.unit.empty()) out << " units=\"" << escaped(f.unit) << '"';
    out << '>' << escaped(f.value) << "</" << f.key << ">\n";
}
static void xml_fields(std::ostringstream& out, const Fields& fields, const char* section, int depth) {
    if (fields.empty()) return;
    out << std::string(depth * 2, ' ') << '<' << section << ">\n";
    for (const auto& f : fields) xml_field(out, f, depth + 1);
    out << std::string(depth * 2, ' ') << "</" << section << ">\n";
}
static bool valid_lines(const std::string& output) {
    size_t column = 0;
    for (const unsigned char c : output) {
        if (c == '\n') { column = 0; continue; }
        if (c < 32 || c > 126) return fail("cdm-character-invalid", "CDM text requires printable ASCII characters.");
        if (++column > 254) return fail("cdm-line-too-long", "CDM lines cannot exceed 254 ASCII characters.");
    }
    return true;
}
static int32_t write(const uint8_t* buffer, uint32_t size, char* output, uint32_t capacity, bool xml) {
    clear_error();
    if (!output || !capacity) return -2;
    if (!buffer || !size) { fail("cdm-input-invalid", "CDM input is empty."); return -1; }
    flatbuffers::Verifier verifier(buffer, size);
    if (!VerifyCDMBuffer(verifier)) { fail("cdm-input-invalid", "CDM FlatBuffer verification failed."); return -1; }
    Document fields;
    if (!document(GetCDM(buffer), fields)) return -1;
    std::ostringstream out;
    if (!xml) {
        kvn_fields(out, fields.header); kvn_fields(out, fields.relative);
        for (const auto& object : fields.objects) {
            kvn_fields(out, object.metadata); kvn_fields(out, object.od); kvn_fields(out, object.additional);
            kvn_fields(out, object.state); kvn_fields(out, object.covariance);
        }
    } else {
        out << "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<cdm id=\"CCSDS_CDM_VERS\" version=\"1.0\"\n     xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">\n  <header>\n";
        for (const auto& f : fields.header) if (f.key != "CCSDS_CDM_VERS") xml_field(out, f, 2);
        out << "  </header>\n  <body>\n    <relativeMetadataData>\n";
        bool relative_state = false;
        for (const auto& f : fields.relative) {
            const bool is_state = f.key.rfind("RELATIVE_POSITION_", 0) == 0 || f.key.rfind("RELATIVE_VELOCITY_", 0) == 0;
            if (is_state && !relative_state) { out << "      <relativeStateVector>\n"; relative_state = true; }
            if (!is_state && relative_state) { out << "      </relativeStateVector>\n"; relative_state = false; }
            xml_field(out, f, is_state ? 4 : 3);
        }
        if (relative_state) out << "      </relativeStateVector>\n";
        out << "    </relativeMetadataData>\n";
        for (const auto& object : fields.objects) {
            out << "    <segment>\n";
            xml_fields(out, object.metadata, "metadata", 3);
            out << "      <data>\n";
            xml_fields(out, object.od, "odParameters", 4); xml_fields(out, object.additional, "additionalParameters", 4);
            xml_fields(out, object.state, "stateVector", 4); xml_fields(out, object.covariance, "covarianceMatrix", 4);
            out << "      </data>\n    </segment>\n";
        }
        out << "  </body>\n</cdm>\n";
    }
    const auto result = out.str();
    if (!valid_lines(result)) return -1;
    if (result.size() > capacity) return -2;
    std::memcpy(output, result.data(), result.size());
    return static_cast<int32_t>(result.size());
}
} // namespace cdm_text_detail

int32_t cdm_sds_to_kvn(const uint8_t* buffer, uint32_t size, char* output, uint32_t capacity) {
    return cdm_text_detail::write(buffer, size, output, capacity, false);
}
int32_t cdm_sds_to_xml(const uint8_t* buffer, uint32_t size, char* output, uint32_t capacity) {
    return cdm_text_detail::write(buffer, size, output, capacity, true);
}
} // namespace conjunction
