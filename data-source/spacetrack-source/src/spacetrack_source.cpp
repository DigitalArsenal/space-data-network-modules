// data-source/spacetrack-source: Space-Track's GP, GP history and SATCAT as SDS records.
//
//   parse_gp      Space-Track `gp` or `gp_history` JSON (omm-gp-json, the REST API's output) -> $OMM
//   parse_satcat  Space-Track `satcat` JSON                                                  -> $CAT
//
// Typed contracts 1.0 (FlatBuffers only): the input is the HttpResponse (HRSP) hostcap/http-request answers,
// its BODY the Space-Track JSON verbatim; the records leave as one size-prefixed SDS stream and the report as
// one FlowNotice (FNTC, KIND Info: COUNT the records emitted, ITEMS the counters as "name=value"). HTTP 304
// gives one FlowNotice (Unchanged) on "report" and no records; any other status but 200, or a transport ERROR,
// is refused. No hostcalls: the login, the polite request rate, the schedule and the archive belong to the
// SDN host flow. One record that cannot be read is dropped and counted in the report; an input that is
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

#include <HttpResponse_generated.h>
#include <FlowNotice_generated.h>

namespace R = sdn::runtime;

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
  std::vector<std::string> examples;
  void reject(size_t index, const std::string& why) {
    ++rejected;
    ++reasons[why];
    if (examples.size() < kMaxExamples) examples.push_back("rejectionExample." + std::to_string(index) + "=" + why);
  }
};

// The report's ITEMS: one "name=value" counter each; a map's entries as "name.key=value".
struct Items {
  std::vector<std::string> items;
  void add(const std::string& name, size_t value) { items.push_back(name + "=" + std::to_string(value)); }
  void add(const std::string& name, const std::string& value) { items.push_back(name + "=" + value); }
  void add(const std::string& name, const std::map<std::string, size_t>& values) {
    for (const auto& entry : values) add(name + "." + entry.first, entry.second);
  }
};

int push_notice(R::flowNoticeKind kind, const char* schema, const char* reason, uint64_t count, std::vector<std::string> items) {
  R::FlowNoticeT notice;
  notice.KIND = kind;
  notice.SCHEMA = schema;
  notice.SOURCE_NAME = "space-track";
  notice.REASON = reason;
  notice.COUNT = count;
  notice.ITEMS = std::move(items);
  flatbuffers::FlatBufferBuilder b(1024);
  R::FinishFlowNoticeBuffer(b, R::FlowNotice::Pack(b, &notice));
  return plugin_push_output_ex("report", "FlowNotice.fbs", R::FlowNoticeIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "FlowNotice", 0, 0,
                               b.GetBufferPointer(), b.GetSize());
}

// The one input: the HttpResponse. Returns the body (verbatim JSON) or nullptr with the error set; *unchanged on 304.
const R::HttpResponse* response_frame(bool* unchanged) {
  *unchanged = false;
  if (plugin_get_input_count() != 1) return fail("invalid-spacetrack-source", "One HttpResponse frame is expected."), nullptr;
  const auto* input = plugin_get_input_frame(0);
  if (!input || !input->port_id || std::strcmp(input->port_id, "response") || !input->payload || !input->payload_length) {
    return fail("missing-response-frame", "The parser requires the HttpResponse frame on 'response'."), nullptr;
  }
  flatbuffers::Verifier verifier(input->payload, input->payload_length, 64, 1000000, false);
  if (!R::VerifyHttpResponseBuffer(verifier)) return fail("invalid-response-frame", "The response frame is not an HttpResponse (HRSP)."), nullptr;
  const R::HttpResponse* r = R::GetHttpResponse(input->payload);
  if (r->ERROR() && r->ERROR()->size()) return fail("fetch-failed", "The Space-Track request failed: " + r->ERROR()->str()), nullptr;
  if (r->STATUS() == 304) {
    *unchanged = true;
    return r;
  }
  if (r->STATUS() != 200) return fail("fetch-failed", "Space-Track returned HTTP status " + std::to_string(r->STATUS()) + "."), nullptr;
  if (!r->BODY() || r->BODY()->size() == 0 || r->BODY()->size() > kMaxBytes) {
    return fail("invalid-spacetrack-source", "The source must be one bounded Space-Track JSON array (1 byte to 256 MiB)."), nullptr;
  }
  return r;
}

int push_unchanged(const R::HttpResponse& r, const char* schema) {
  return push_notice(R::flowNoticeKind_Unchanged, schema, "not-modified", 1, {r.URL() ? r.URL()->str() : std::string()}) < 0 ? 1 : 0;
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
  bool unchanged = false;
  const R::HttpResponse* response = response_frame(&unchanged);
  if (!response) return 1;
  if (unchanged) return push_unchanged(*response, "OMM");
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
  if (!flatjson::for_each_record(reinterpret_cast<const char*>(response->BODY()->data()), response->BODY()->size(), on_record, &error)) {
    return fail("invalid-spacetrack-source", oversize ? "The $OMM output exceeds its byte budget." : error);
  }
  if (counters.emitted == 0) return fail("invalid-spacetrack-source", "No Space-Track element set could be read" + (counters.rejected ? std::string(" (") + std::to_string(counters.rejected) + " rejected)" : std::string()) + ".");
  Items report;
  report.add("records", counters.read);
  report.add("emitted", counters.emitted);
  report.add("duplicateGpIds", counters.duplicates);
  report.add("rejected", counters.rejected);
  report.add("rejections", counters.reasons);
  report.items.insert(report.items.end(), counters.examples.begin(), counters.examples.end());
  report.add("alpha5CatalogNumbers", counters.alpha5);
  report.add("meanElementTheories", theories);
  report.add("epochRange", first_epoch + "/" + last_epoch);
  report.add("creationDateRange", first_creation + "/" + last_creation);
  if (push_notice(R::flowNoticeKind_Info, "OMM", "gp", counters.emitted, std::move(report.items)) < 0) return 1;
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
  bool unchanged = false;
  const R::HttpResponse* response = response_frame(&unchanged);
  if (!response) return 1;
  if (unchanged) return push_unchanged(*response, "CAT");
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
  if (!flatjson::for_each_record(reinterpret_cast<const char*>(response->BODY()->data()), response->BODY()->size(), on_record, &error)) {
    return fail("invalid-spacetrack-source", oversize ? "The $CAT output exceeds its byte budget." : error);
  }
  if (counters.emitted == 0) return fail("invalid-spacetrack-source", "No Space-Track SATCAT entry could be read.");
  // A country code the standard's legacyCountryCode enum does not list is written as UNK and counted by code, not guessed.
  size_t unrepresented_countries = 0;
  for (const auto& entry : unknown_countries) unrepresented_countries += entry.second;
  Items report;
  report.add("records", counters.read);
  report.add("emitted", counters.emitted);
  report.add("supersededEntries", superseded);
  report.add("duplicateCatalogNumbers", counters.duplicates);
  report.add("rejected", counters.rejected);
  report.add("rejections", counters.reasons);
  report.items.insert(report.items.end(), counters.examples.begin(), counters.examples.end());
  report.add("unrepresentedDesignators", unnumbered_designators);
  report.add("unrepresentedCountries", unrepresented_countries);
  report.add("unrepresentedCountryCodes", unknown_countries);
  report.add("decayed", decayed);
  if (push_notice(R::flowNoticeKind_Info, "CAT", "satcat", counters.emitted, std::move(report.items)) < 0) return 1;
  return plugin_push_output_ex("catalog", "CAT.fbs", "$CAT", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "CAT", 0, 0, output.data(), static_cast<uint32_t>(output.size())) < 0 ? 1 : 0;
}
