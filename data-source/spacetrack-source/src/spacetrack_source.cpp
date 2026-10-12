// data-source/spacetrack-source: Space-Track's GP, GP history and SATCAT as SDS records.
//
//   parse_gp      Space-Track `gp` or `gp_history` JSON (omm-gp-json, the REST API's output) -> $OMM
//   parse_satcat  Space-Track `satcat` JSON                                                  -> $CAT
//
// Pure bytes in, pure bytes out: the login, the polite request rate, the schedule and the archive belong to
// the SDN host flow. One record that cannot be read is dropped and counted in the report; an input that is
// not a JSON array of objects is refused whole. Errors are flags (a return code and a message), never
// exceptions.
//
// Space-Track writes every value as text, so a number is parsed from its text with the whole text consumed.
// A catalog number is read as decimal text or as Alpha-5 (a letter and four digits, common/alpha5.hpp), and
// when the record also carries its two-line set the number there must agree.

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

using Json = nlohmann::json;

namespace {

// A day of the GP history is up to 162 MB as the REST API serves it (the archive's largest, 2026-08-15).
constexpr size_t kMaxBytes = 256u * 1024 * 1024;
constexpr size_t kMaxExamples = 20;

int fail(const char* code, const std::string& message) {
  plugin_set_error(code, message.c_str());
  return 1;
}

bool number(const std::string& text, double* out) {
  if (text.empty() || text.size() > 64) return false;
  for (char c : text) {
    if (!((c >= '0' && c <= '9') || c == '+' || c == '-' || c == '.' || c == 'e' || c == 'E')) return false;
  }
  char* end = nullptr;
  errno = 0;
  const double value = std::strtod(text.c_str(), &end);
  if (errno == ERANGE || end != text.c_str() + text.size() || !std::isfinite(value)) return false;
  *out = value;
  return true;
}

bool unsigned_number(const std::string& text, uint32_t* out) {
  if (text.empty() || text.size() > 10) return false;
  for (char c : text) {
    if (c < '0' || c > '9') return false;
  }
  const unsigned long long value = std::strtoull(text.c_str(), nullptr, 10);
  if (value > 0xFFFFFFFFull) return false;
  *out = static_cast<uint32_t>(value);
  return true;
}

std::string trim(const std::string& text) {
  const auto first = text.find_first_not_of(" \t\r\n");
  return first == std::string::npos ? std::string() : text.substr(first, text.find_last_not_of(" \t\r\n") - first + 1);
}

bool iso_utc(const std::string& text) {
  double seconds = 0;
  bool zone = false;
  // Space-Track writes UTC without a zone suffix; a text that names another zone is not Space-Track's.
  return sdn_time::parse_iso(text, &seconds, &zone) && (!zone || text.back() == 'Z');
}

bool iso_date(const std::string& text) {
  if (text.size() != 10 || text[4] != '-' || text[7] != '-') return false;
  if (!sdn_alpha5::is_digits(text, 0, 4) || !sdn_alpha5::is_digits(text, 5, 2) || !sdn_alpha5::is_digits(text, 8, 2)) return false;
  return sdn_time::valid_date(std::atoi(text.substr(0, 4).c_str()), std::atoi(text.substr(5, 2).c_str()), std::atoi(text.substr(8, 2).c_str()));
}

// International designator, YYYY-NNNAAA.
bool cospar(const std::string& value) {
  if (value.size() < 9 || value.size() > 11 || value[4] != '-') return false;
  for (size_t i = 0; i < value.size(); ++i) {
    if (i == 4) continue;
    if (i < 8 ? (value[i] < '0' || value[i] > '9') : (value[i] < 'A' || value[i] > 'Z')) return false;
  }
  return true;
}

// The catalog number of a record: its NORAD_CAT_ID text, and the number in its first two-line-set line when
// that is present too. False (with the reason) when neither reads or the two disagree.
bool catalog_number(const flatjson::Record& r, const char* field, uint32_t* out, bool* alpha5, std::string* why) {
  *alpha5 = false;
  uint32_t declared = 0, tle = 0;
  bool has_declared = false, has_tle = false;
  const std::string text = trim(r.text(field));
  if (!text.empty()) {
    if (!sdn_alpha5::decode(text, &declared)) {
      *why = std::string(field) + " is not a catalog number";
      return false;
    }
    has_declared = true;
    *alpha5 = !(text[0] >= '0' && text[0] <= '9');
  }
  const std::string line1 = r.text("TLE_LINE1");
  if (line1.size() >= 7 && line1[0] == '1') {
    const std::string cell = trim(line1.substr(2, 5));
    if (!sdn_alpha5::decode(cell, &tle)) {
      *why = "TLE_LINE1 does not begin with a catalog number";
      return false;
    }
    has_tle = true;
    if (!(cell[0] >= '0' && cell[0] <= '9')) *alpha5 = true;
  }
  if (!has_declared && !has_tle) {
    *why = std::string(field) + " is missing";
    return false;
  }
  if (has_declared && has_tle && declared != tle) {
    *why = "the catalog number disagrees with TLE_LINE1";
    return false;
  }
  *out = has_declared ? declared : tle;
  return true;
}

struct Counters {
  size_t read = 0, emitted = 0, duplicates = 0, rejected = 0, alpha5 = 0, unrepresented = 0;
  std::map<std::string, size_t> reasons;
  Json examples = Json::array();
  void reject(size_t index, const std::string& why) {
    ++rejected;
    ++reasons[why];
    if (examples.size() < kMaxExamples) examples.push_back({{"record", index}, {"reason", why}});
  }
};

Json reasons_json(const Counters& c) {
  Json out = Json::object();
  for (const auto& entry : c.reasons) out[entry.first] = entry.second;
  return out;
}

int push_report(const Json& report) {
  const std::string text = report.dump();
  return plugin_push_output_ex("report", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                               reinterpret_cast<const uint8_t*>(text.data()), static_cast<uint32_t>(text.size()));
}

const plugin_input_frame_t* source_frame() {
  if (plugin_get_input_count() != 1) return nullptr;
  const auto* input = plugin_get_input_frame(0);
  if (!input || !input->port_id || std::strcmp(input->port_id, "source") || !input->payload || !input->payload_length || input->payload_length > kMaxBytes) return nullptr;
  return input;
}

// ── omm-gp-json -> $OMM ────────────────────────────────────────────────────────────────────────────────

bool required_number(const flatjson::Record& r, const char* field, double* out, std::string* why) {
  if (!number(trim(r.text(field)), out)) {
    *why = std::string(field) + " is missing or not a number";
    return false;
  }
  return true;
}

// EPHEMERIS_TYPE as the other OMM builders of this repository map it (data-source/celestrak-parser), so one set
// from either source carries the same value.
bool ephemeris_type(const std::string& text, ephemerisFormat* out) {
  if (text == "0" || text == "SGP") *out = ephemerisFormat::SGP;
  else if (text == "1" || text == "SGP4") *out = ephemerisFormat::SGP4;
  else if (text == "2" || text == "SDP4") *out = ephemerisFormat::SDP4;
  else if (text == "3" || text == "SGP8") *out = ephemerisFormat::SGP8;
  else if (text == "4" || text == "SDP8") *out = ephemerisFormat::SDP8;
  else return false;
  return true;
}

void add_param(OMMT* omm, const std::string& name, const std::string& value) {
  auto p = std::make_unique<OMMUserDefinedParameterT>();
  p->PARAM_NAME = name;
  p->PARAM_VALUE = value;
  omm->USER_DEFINED_PARAMETERS.push_back(std::move(p));
}

bool build_omm(const flatjson::Record& r, OMMT* omm, bool* alpha5, std::string* why) {
  uint32_t norad = 0;
  if (!catalog_number(r, "NORAD_CAT_ID", &norad, alpha5, why)) return false;
  omm->NORAD_CAT_ID = norad;
  double v = 0;
  const std::string epoch = trim(r.text("EPOCH"));
  if (!iso_utc(epoch)) {
    *why = "EPOCH is missing or not an ISO 8601 UTC time";
    return false;
  }
  omm->EPOCH = epoch;
  if (!required_number(r, "MEAN_MOTION", &omm->MEAN_MOTION, why) || !required_number(r, "ECCENTRICITY", &omm->ECCENTRICITY, why) ||
      !required_number(r, "INCLINATION", &omm->INCLINATION, why) || !required_number(r, "RA_OF_ASC_NODE", &omm->RA_OF_ASC_NODE, why) ||
      !required_number(r, "ARG_OF_PERICENTER", &omm->ARG_OF_PERICENTER, why) || !required_number(r, "MEAN_ANOMALY", &omm->MEAN_ANOMALY, why)) {
    return false;
  }
  if (!(omm->MEAN_MOTION > 0 && omm->MEAN_MOTION < 30) || !(omm->ECCENTRICITY >= 0 && omm->ECCENTRICITY < 1) || !(omm->INCLINATION >= 0 && omm->INCLINATION <= 180) ||
      !(omm->RA_OF_ASC_NODE >= 0 && omm->RA_OF_ASC_NODE <= 360) || !(omm->ARG_OF_PERICENTER >= 0 && omm->ARG_OF_PERICENTER <= 360) ||
      !(omm->MEAN_ANOMALY >= 0 && omm->MEAN_ANOMALY <= 360)) {
    *why = "an element is outside its range";
    return false;
  }
  // The terms SGP4 propagates with. A set that omits one is not a set SGP4 can use, so none is invented.
  if (!required_number(r, "BSTAR", &omm->BSTAR, why) || !required_number(r, "MEAN_MOTION_DOT", &omm->MEAN_MOTION_DOT, why) ||
      !required_number(r, "MEAN_MOTION_DDOT", &omm->MEAN_MOTION_DDOT, why)) {
    return false;
  }
  const std::string theory = trim(r.text("MEAN_ELEMENT_THEORY"));
  if (theory.empty() || theory == "SGP4") omm->MEAN_ELEMENT_THEORY = meanElementSource::SGP4;
  else if (theory == "SGP4-XP" || theory == "SGP4XP") omm->MEAN_ELEMENT_THEORY = meanElementSource::SGP4XP;
  else {
    *why = "MEAN_ELEMENT_THEORY " + theory + " is not SGP4 or SGP4-XP";
    return false;
  }
  const std::string eph = trim(r.text("EPHEMERIS_TYPE"));
  if (!eph.empty() && !ephemeris_type(eph, &omm->EPHEMERIS_TYPE)) {
    *why = "EPHEMERIS_TYPE " + eph + " is not 0 to 4";
    return false;
  }
  // The frame and time system are the SGP4 contract's; a record that names another is not read as one.
  const std::string frame = trim(r.text("REF_FRAME"));
  if (!frame.empty() && frame != "TEME" && frame != "TEMEOFDATE") {
    *why = "REF_FRAME " + frame + " is not TEME";
    return false;
  }
  const std::string time_system = trim(r.text("TIME_SYSTEM"));
  if (!time_system.empty() && time_system != "UTC") {
    *why = "TIME_SYSTEM " + time_system + " is not UTC";
    return false;
  }
  omm->REFERENCE_FRAME = std::make_unique<RFMT>();
  CelestialFrameWrapperT wrapper;
  wrapper.frame = CelestialFrame::TEMEOFDATE;
  omm->REFERENCE_FRAME->REFERENCE_FRAME.Set(std::move(wrapper));
  omm->TIME_SYSTEM = timingStandard::UTC;
  const std::string center = trim(r.text("CENTER_NAME"));
  omm->CENTER_NAME = center.empty() ? "EARTH" : center;
  if (number(trim(r.text("CCSDS_OMM_VERS")), &v)) omm->CCSDS_OMM_VERS = v;
  omm->CREATION_DATE = trim(r.text("CREATION_DATE"));
  if (!omm->CREATION_DATE.empty() && !iso_utc(omm->CREATION_DATE)) {
    *why = "CREATION_DATE is not an ISO 8601 UTC time";
    return false;
  }
  omm->ORIGINATOR = r.text("ORIGINATOR");
  omm->COMMENT = r.text("COMMENT");
  omm->OBJECT_NAME = r.text("OBJECT_NAME");
  if (omm->OBJECT_NAME.empty() && r.text("TLE_LINE0").size() > 2) omm->OBJECT_NAME = trim(r.text("TLE_LINE0").substr(r.text("TLE_LINE0").rfind("0 ", 0) == 0 ? 2 : 0));
  omm->OBJECT_ID = r.text("OBJECT_ID");
  const std::string classification = trim(r.text("CLASSIFICATION_TYPE"));
  omm->CLASSIFICATION_TYPE = classification.empty() ? "U" : classification;
  uint32_t u = 0;
  if (unsigned_number(trim(r.text("ELEMENT_SET_NO")), &u)) omm->ELEMENT_SET_NO = u;
  if (number(trim(r.text("REV_AT_EPOCH")), &v)) omm->REV_AT_EPOCH = v;
  const std::string gp_id = trim(r.text("GP_ID"));
  if (!gp_id.empty()) add_param(omm, "GP_ID", gp_id);
  return true;
}

}  // namespace

extern "C" int parse_gp(void) {
  const auto* input = source_frame();
  if (!input) return fail("invalid-spacetrack-source", "The source must be one bounded Space-Track gp or gp_history JSON array.");
  Counters counters;
  std::set<std::string> gp_ids;
  std::map<std::string, size_t> theories;
  std::string first_epoch, last_epoch, first_creation, last_creation;
  std::vector<uint8_t> output;
  std::string error;
  size_t index = 0;
  bool oversize = false;
  auto on_record = [&](const flatjson::Record& r) {
    const size_t at = index++;
    ++counters.read;
    OMMT omm;
    bool alpha5 = false;
    std::string why;
    if (!build_omm(r, &omm, &alpha5, &why)) {
      counters.reject(at, why);
      return true;
    }
    const std::string gp_id = trim(r.text("GP_ID"));
    if (!gp_id.empty() && !gp_ids.insert(gp_id).second) {
      ++counters.duplicates;
      return true;
    }
    flatbuffers::FlatBufferBuilder fbb(1024);
    FinishSizePrefixedOMMBuffer(fbb, CreateOMM(fbb, &omm));
    if (output.size() + fbb.GetSize() > kMaxBytes) {
      oversize = true;
      return false;
    }
    output.insert(output.end(), fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
    ++counters.emitted;
    if (alpha5) ++counters.alpha5;
    ++theories[EnumNamemeanElementSource(omm.MEAN_ELEMENT_THEORY)];
    if (first_epoch.empty() || omm.EPOCH < first_epoch) first_epoch = omm.EPOCH;
    if (last_epoch.empty() || omm.EPOCH > last_epoch) last_epoch = omm.EPOCH;
    if (!omm.CREATION_DATE.empty()) {
      if (first_creation.empty() || omm.CREATION_DATE < first_creation) first_creation = omm.CREATION_DATE;
      if (last_creation.empty() || omm.CREATION_DATE > last_creation) last_creation = omm.CREATION_DATE;
    }
    return true;
  };
  if (!flatjson::for_each_record(reinterpret_cast<const char*>(input->payload), input->payload_length, on_record, &error)) {
    return fail("invalid-spacetrack-source", oversize ? "The $OMM output exceeds its byte budget." : error);
  }
  if (counters.emitted == 0) return fail("invalid-spacetrack-source", "No Space-Track element set could be read" + (counters.rejected ? std::string(" (") + std::to_string(counters.rejected) + " rejected)" : std::string()) + ".");
  Json theory_counts = Json::object();
  for (const auto& entry : theories) theory_counts[entry.first] = entry.second;
  const Json report = {{"version", 1}, {"source", "space-track"}, {"class", "gp"}, {"records", counters.read}, {"emitted", counters.emitted},
                       {"duplicateGpIds", counters.duplicates}, {"rejected", counters.rejected}, {"rejections", reasons_json(counters)},
                       {"rejectionExamples", counters.examples}, {"alpha5CatalogNumbers", counters.alpha5}, {"meanElementTheories", theory_counts},
                       {"epochRange", {first_epoch, last_epoch}}, {"creationDateRange", {first_creation, last_creation}}};
  if (push_report(report) < 0) return 1;
  return plugin_push_output_ex("omm", "OMM.fbs", "$OMM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "OMM", 0, 0, output.data(), static_cast<uint32_t>(output.size())) < 0 ? 1 : 0;
}

// ── satcat JSON -> $CAT ────────────────────────────────────────────────────────────────────────────────

namespace {

bool country(const std::string& text, legacyCountryCode* out) {
  for (legacyCountryCode code : EnumValueslegacyCountryCode()) {
    if (text == EnumNamelegacyCountryCode(code)) {
      *out = code;
      return true;
    }
  }
  return false;
}

}  // namespace

extern "C" int parse_satcat(void) {
  const auto* input = source_frame();
  if (!input) return fail("invalid-spacetrack-source", "The source must be one bounded Space-Track satcat JSON array.");
  Counters counters;
  size_t superseded = 0, unnumbered_designators = 0, decayed = 0;
  std::map<std::string, size_t> unknown_countries;
  std::set<uint32_t> seen;
  std::vector<uint8_t> output;
  std::string error;
  size_t index = 0;
  bool oversize = false;
  auto on_record = [&](const flatjson::Record& r) {
    const size_t at = index++;
    ++counters.read;
    // CURRENT = N marks a superseded entry of a catalog number that was reassigned.
    if (trim(r.text("CURRENT")) == "N") {
      ++superseded;
      return true;
    }
    uint32_t norad = 0;
    bool alpha5 = false;
    std::string why;
    // OBJECT_NUMBER is the number SATCAT writes beside it; TLE lines are not part of this class.
    const char* field = r.find("NORAD_CAT_ID") ? "NORAD_CAT_ID" : "OBJECT_NUMBER";
    if (!catalog_number(r, field, &norad, &alpha5, &why)) {
      counters.reject(at, why);
      return true;
    }
    if (!seen.insert(norad).second) {
      ++counters.duplicates;
      return true;
    }
    CATT cat;
    cat.NORAD_CAT_ID = norad;
    cat.OBJECT_NAME = r.find("OBJECT_NAME") ? r.text("OBJECT_NAME") : r.text("SATNAME");
    const std::string designator = trim(r.find("OBJECT_ID") ? r.text("OBJECT_ID") : r.text("INTLDES"));
    if (cospar(designator)) cat.OBJECT_ID = designator;
    else if (!designator.empty()) ++unnumbered_designators;
    const std::string type = trim(r.text("OBJECT_TYPE"));
    cat.OBJECT_TYPE = type == "PAYLOAD" ? spaceObjectClass::PAYLOAD : type == "ROCKET BODY" ? spaceObjectClass::ROCKET_BODY : type == "DEBRIS" ? spaceObjectClass::DEBRIS : spaceObjectClass::UNKNOWN;
    // OWNER is always written: an unset field reads back as its first value (AB), a real owner. A code the
    // enum does not list, or none, is UNK.
    const std::string owner = trim(r.text("COUNTRY"));
    legacyCountryCode code = legacyCountryCode::UNK;
    if (!owner.empty() && !country(owner, &code)) {
      code = legacyCountryCode::UNK;
      ++unknown_countries[owner];
    }
    cat.OWNER = code;
    const std::string launch = trim(r.text("LAUNCH")), decay = trim(r.text("DECAY"));
    if (iso_date(launch)) cat.LAUNCH_DATE = launch;
    if (iso_date(decay)) {
      cat.DECAY_DATE = decay;
      cat.OPS_STATUS_CODE = operationalState::DECAYED;
      ++decayed;
    }
    cat.LAUNCH_SITE = trim(r.text("SITE"));
    double v = 0;
    if (number(trim(r.text("PERIOD")), &v)) cat.PERIOD = v;
    if (number(trim(r.text("INCLINATION")), &v)) cat.INCLINATION = v;
    if (number(trim(r.text("APOGEE")), &v)) cat.APOGEE = v;
    if (number(trim(r.text("PERIGEE")), &v)) cat.PERIGEE = v;
    // RCSVALUE is 0 unless the account may read it: a zero is no cross-section, so it is not stated.
    if (number(trim(r.text("RCSVALUE")), &v) && v > 0) cat.RCS = v;
    flatbuffers::FlatBufferBuilder fbb(512);
    FinishSizePrefixedCATBuffer(fbb, CreateCAT(fbb, &cat));
    if (output.size() + fbb.GetSize() > kMaxBytes) {
      oversize = true;
      return false;
    }
    output.insert(output.end(), fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
    ++counters.emitted;
    return true;
  };
  if (!flatjson::for_each_record(reinterpret_cast<const char*>(input->payload), input->payload_length, on_record, &error)) {
    return fail("invalid-spacetrack-source", oversize ? "The $CAT output exceeds its byte budget." : error);
  }
  if (counters.emitted == 0) return fail("invalid-spacetrack-source", "No Space-Track SATCAT entry could be read.");
  // A country code the standard's legacyCountryCode enum does not list is written as UNK and counted by code, not guessed.
  Json countries = Json::object();
  size_t unrepresented_countries = 0;
  for (const auto& entry : unknown_countries) {
    countries[entry.first] = entry.second;
    unrepresented_countries += entry.second;
  }
  const Json report = {{"version", 1}, {"source", "space-track"}, {"class", "satcat"}, {"records", counters.read}, {"emitted", counters.emitted},
                       {"supersededEntries", superseded}, {"duplicateCatalogNumbers", counters.duplicates}, {"rejected", counters.rejected},
                       {"rejections", reasons_json(counters)}, {"rejectionExamples", counters.examples},
                       {"unrepresentedDesignators", unnumbered_designators}, {"unrepresentedCountries", unrepresented_countries},
                       {"unrepresentedCountryCodes", countries}, {"decayed", decayed}};
  if (push_report(report) < 0) return 1;
  return plugin_push_output_ex("catalog", "CAT.fbs", "$CAT", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "CAT", 0, 0, output.data(), static_cast<uint32_t>(output.size())) < 0 ? 1 : 0;
}
