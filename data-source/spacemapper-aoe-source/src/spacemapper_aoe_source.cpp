// data-source/spacemapper-aoe-source: SpaceMapper's AOE element sets as SDS records.
//
//   parse_aoe   AOE catalog records (JSON lines or a JSON array of the objects the site's pages embed) -> $OMM, the id crosswalk
//
// SpaceMapper (Beijing Kaiyun United Information Technology) publishes the AOE catalog on public pages
// (spacemapper.cn, channel KY among others). Fetching and decoding a page is the host flow's: this module reads the
// records the host extracted, as JSON. It states no licence for the data, so the records are computed on and cited,
// never republished.
//
// The element set is the record's two-line set. Its fixed columns are decoded into the OMM fields SGP4 takes, without
// computing anything: eccentricity and B* are written with an implied decimal point, the epoch as a year and a day of
// year. Every decoded set is checked against the same record's other fields (the ISO epoch, the NORAD number, and the
// rounded elements AOE also gives); a record that disagrees is dropped and counted (orbit-accuracy-experiments E15's
// rule, which read the same records). AOE writes a zero checksum on most lines, so a checksum that does not match is
// counted, not a reason to drop a set.
//
// Identity: the NORAD number AOE gives is the set's NORAD_CAT_ID; where it gives none the object is named
// `aoe:<catId>` (USER_DEFINED_OBJECT_DESIGNATOR) and no NORAD number is invented. AOE's own ids ride in
// USER_DEFINED_PARAMETERS. Names and bare numbers never join: the crosswalk lists what AOE states, as candidates.

#include <algorithm>
#include <cctype>
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

constexpr size_t kMaxBytes = 128u * 1024 * 1024;
constexpr size_t kMaxExamples = 20;

int fail(const char* code, const std::string& message) {
  plugin_set_error(code, message.c_str());
  return 1;
}

std::string trim(const std::string& text) {
  const auto first = text.find_first_not_of(" \t\r\n");
  return first == std::string::npos ? std::string() : text.substr(first, text.find_last_not_of(" \t\r\n") - first + 1);
}

std::string cell(const std::string& line, size_t first, size_t last) { return trim(line.substr(first, last - first)); }

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

bool digits(const std::string& text) { return !text.empty() && sdn_alpha5::is_digits(text, 0, text.size()); }

// TLE checksum: the digits of columns 1 to 68 plus one for each minus sign, modulo 10.
bool checksum_ok(const std::string& line) {
  unsigned sum = 0;
  for (size_t i = 0; i < 68; ++i) {
    if (line[i] >= '0' && line[i] <= '9') sum += static_cast<unsigned>(line[i] - '0');
    else if (line[i] == '-') ++sum;
  }
  return line[68] >= '0' && line[68] <= '9' && sum % 10 == static_cast<unsigned>(line[68] - '0');
}

// "SMMMMMSE": a sign, five digits of the mantissa read after a decimal point, and a signed one-digit exponent (" 31466-3" is
// 0.31466e-3). A blank mantissa is no value.
bool implied_exponent(const std::string& field, double* out) {
  if (field.size() != 8) return false;
  const std::string mantissa = trim(field.substr(1, 5));
  const std::string exponent = trim(field.substr(6, 2));
  if (!digits(mantissa) || exponent.empty()) return false;
  const std::string tail = (exponent[0] == '+' || exponent[0] == '-') ? exponent : "+" + exponent;
  if (tail.size() != 2 || tail[1] < '0' || tail[1] > '9') return false;
  return number(std::string(field[0] == '-' ? "-" : "") + "0." + mantissa + "e" + tail, out);
}

struct Tle {
  uint32_t norad = 0;
  bool alpha5 = false, checksums = true;
  std::string classification, designator;
  int64_t epoch_micro = 0;  // since 1970-01-01T00:00:00 UTC
  double ndot = 0, nddot = 0, bstar = 0, inc = 0, raan = 0, ecc = 0, argp = 0, ma = 0, mean_motion = 0;
  uint32_t element_set = 0, rev = 0;
  char ephemeris_type = '0';
};

bool decode_tle(const std::string& l1, const std::string& l2, Tle* t, std::string* why) {
  if (l1.size() < 69 || l2.size() < 69 || l1[0] != '1' || l2[0] != '2') {
    *why = "the two-line set is not two lines of 69 columns";
    return false;
  }
  const std::string c1 = cell(l1, 2, 7), c2 = cell(l2, 2, 7);
  uint32_t n1 = 0, n2 = 0;
  if (!sdn_alpha5::decode(c1, &n1) || !sdn_alpha5::decode(c2, &n2) || n1 != n2) {
    *why = "the catalog numbers of the two lines disagree or are unreadable";
    return false;
  }
  t->norad = n1;
  t->alpha5 = !(c1[0] >= '0' && c1[0] <= '9');
  t->checksums = checksum_ok(l1) && checksum_ok(l2);
  t->classification = l1[7] == ' ' ? "U" : std::string(1, l1[7]);
  t->designator = cell(l1, 9, 17);
  const std::string yy = cell(l1, 18, 20), day = cell(l1, 20, 32);
  const auto dot = day.find('.');
  if (!digits(yy) || dot != 3 || !digits(day.substr(0, 3)) || day.size() < 5 || !digits(day.substr(4))) {
    *why = "the epoch is unreadable";
    return false;
  }
  const int year = std::atoi(yy.c_str()) < 57 ? 2000 + std::atoi(yy.c_str()) : 1900 + std::atoi(yy.c_str());
  const int whole = std::atoi(day.substr(0, 3).c_str());
  if (whole < 1 || whole > (sdn_time::leap_year(year) ? 366 : 365)) {
    *why = "the epoch day is outside the year";
    return false;
  }
  double fraction = 0;
  number("0." + day.substr(4), &fraction);
  t->epoch_micro = (sdn_time::days_from_civil(year, 1, 1) + (whole - 1)) * 86400000000LL + std::llround(fraction * 86400000000.0);
  if (!number(cell(l1, 33, 43), &t->ndot) || !implied_exponent(l1.substr(44, 8), &t->nddot) || !implied_exponent(l1.substr(53, 8), &t->bstar)) {
    *why = "a drag term is unreadable";
    return false;
  }
  t->ephemeris_type = l1[62];
  const std::string elset = cell(l1, 64, 68), rev = cell(l2, 63, 68);
  t->element_set = digits(elset) ? static_cast<uint32_t>(std::atoi(elset.c_str())) : 0;
  t->rev = digits(rev) ? static_cast<uint32_t>(std::atoi(rev.c_str())) : 0;
  if (!number(cell(l2, 8, 16), &t->inc) || !number(cell(l2, 17, 25), &t->raan) || !digits(cell(l2, 26, 33)) || !number("0." + cell(l2, 26, 33), &t->ecc) ||
      !number(cell(l2, 34, 42), &t->argp) || !number(cell(l2, 43, 51), &t->ma) || !number(cell(l2, 52, 63), &t->mean_motion)) {
    *why = "an element is unreadable";
    return false;
  }
  if (!(t->mean_motion > 0 && t->mean_motion < 30) || !(t->ecc >= 0 && t->ecc < 1) || !(t->inc >= 0 && t->inc <= 180) || !(t->raan >= 0 && t->raan <= 360) ||
      !(t->argp >= 0 && t->argp <= 360) || !(t->ma >= 0 && t->ma <= 360)) {
    *why = "an element is outside its range";
    return false;
  }
  return true;
}

// The record's own rounded elements must agree with the decoded set; AOE prints them to 3 to 6 decimals.
bool agrees(const flatjson::Record& r, const Tle& t, std::string* why) {
  struct Check { const char* key; double decoded, tolerance; bool angle; };
  const Check checks[] = {{"inclination", t.inc, 1e-3, false}, {"raan", t.raan, 1e-3, true}, {"perigeeArgument", t.argp, 1e-3, true}, {"meanAnomaly", t.ma, 1e-3, true},
                          {"eccentricity", t.ecc, 1e-6, false}, {"meanMotion", t.mean_motion, 2e-6, false}};
  for (const Check& c : checks) {
    const flatjson::Value* v = r.find(c.key);
    if (!v || v->kind == flatjson::Value::Null) continue;
    if (v->kind != flatjson::Value::Integer && v->kind != flatjson::Value::Float) {
      *why = std::string(c.key) + " is not a number";
      return false;
    }
    double diff = std::fabs(v->number - c.decoded);
    if (c.angle) diff = std::min(diff, 360.0 - diff);
    if (!(diff <= c.tolerance)) {
      *why = std::string(c.key) + " disagrees with the two-line set";
      return false;
    }
  }
  const flatjson::Value* b = r.find("bstar");
  if (b && (b->kind == flatjson::Value::Integer || b->kind == flatjson::Value::Float) &&
      std::fabs(b->number - t.bstar) > std::max(1e-12, 1e-3 * std::fabs(t.bstar))) {
    *why = "bstar disagrees with the two-line set";
    return false;
  }
  return true;
}

bool cospar(const std::string& value) {
  if (value.size() < 9 || value.size() > 11 || value[4] != '-') return false;
  for (size_t i = 0; i < value.size(); ++i) {
    if (i == 4) continue;
    if (i < 8 ? (value[i] < '0' || value[i] > '9') : (value[i] < 'A' || value[i] > 'Z')) return false;
  }
  return true;
}

std::string upper(std::string s) {
  for (char& c : s) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
  return s;
}

void add_param(OMMT* omm, const std::string& name, const std::string& value) {
  auto p = std::make_unique<OMMUserDefinedParameterT>();
  p->PARAM_NAME = name;
  p->PARAM_VALUE = value;
  omm->USER_DEFINED_PARAMETERS.push_back(std::move(p));
}

// A positive integer the record states as a JSON number or as text; 0 for missing, null or unreadable.
uint64_t positive(const flatjson::Record& r, const char* key) {
  const flatjson::Value* v = r.find(key);
  if (!v || v->kind == flatjson::Value::Null || v->kind == flatjson::Value::Bool) return 0;
  const std::string text = trim(v->text);
  if (!digits(text) || text.size() > 12) return 0;
  return std::strtoull(text.c_str(), nullptr, 10);
}

struct Counters {
  size_t read = 0, emitted = 0, duplicates = 0, rejected = 0, checksum_mismatches = 0, alpha5 = 0, without_norad = 0;
  std::map<std::string, size_t> reasons;
  Json examples = Json::array();
  void reject(size_t index, const std::string& why) {
    ++rejected;
    ++reasons[why];
    if (examples.size() < kMaxExamples) examples.push_back({{"record", index}, {"reason", why}});
  }
};

struct Object {
  uint64_t cat_id = 0, norad = 0, sat_id = 0;
  std::string cospar, name, type, channel;
  int64_t epoch_micro = 0;
  uint64_t record_id = 0;
};

}  // namespace

extern "C" int parse_aoe(void) {
  if (plugin_get_input_count() != 1) return fail("invalid-aoe-source", "Exactly one set of AOE records is required.");
  const auto* input = plugin_get_input_frame(0);
  if (!input || !input->port_id || std::strcmp(input->port_id, "source") || !input->payload || !input->payload_length || input->payload_length > kMaxBytes) {
    return fail("invalid-aoe-source", "The source must be bounded AOE records: JSON lines or a JSON array of objects.");
  }
  Counters counters;
  std::set<uint64_t> record_ids;
  std::map<uint64_t, Object> objects;  // by AOE catalog id, the newest set of each
  std::set<uint64_t> conflicting;
  std::vector<uint8_t> output;
  std::string error;
  size_t index = 0;
  bool oversize = false;
  auto on_record = [&](const flatjson::Record& r) {
    const size_t at = index++;
    ++counters.read;
    Tle t;
    std::string why;
    if (!decode_tle(r.text("line1"), r.text("line2"), &t, &why) || !agrees(r, t, &why)) {
      counters.reject(at, why);
      return true;
    }
    // The ISO epoch of the record is on China Standard Time; it must name the two-line set's instant (to a millisecond).
    double iso = 0;
    if (!sdn_time::parse_iso(r.text("epoch"), &iso) || std::fabs(iso * 1.0e6 - static_cast<double>(t.epoch_micro)) > 1000.0) {
      counters.reject(at, "the epoch disagrees with the two-line set");
      return true;
    }
    const uint64_t norad = positive(r, "noradId"), cat_id = positive(r, "catId"), sat_id = positive(r, "satId"), record_id = positive(r, "id");
    if (norad && norad != t.norad) {
      counters.reject(at, "the NORAD number disagrees with the two-line set");
      return true;
    }
    if (!norad && !cat_id && !sat_id) {
      counters.reject(at, "the record names no object: no noradId, catId or satId");
      return true;
    }
    if (record_id && !record_ids.insert(record_id).second) {
      ++counters.duplicates;
      return true;
    }
    if (t.ephemeris_type != '0' && t.ephemeris_type != ' ') {
      counters.reject(at, "the two-line set is not an SGP4 set (ephemeris type " + std::string(1, t.ephemeris_type) + ")");
      return true;
    }
    const std::string native_id = std::to_string(cat_id ? cat_id : sat_id ? sat_id : norad);
    OMMT omm;
    omm.OBJECT_NAME = trim(r.text("name"));
    if (omm.OBJECT_NAME.empty()) omm.OBJECT_NAME = trim(r.text("line0"));
    const std::string designator = trim(r.text("objectId"));
    if (cospar(designator)) omm.OBJECT_ID = designator;
    omm.ORIGINATOR = "SpaceMapper AOE";
    omm.COMMENT = "SpaceMapper AOE element set; the two-line set decoded to OMM fields, the set's own epoch and elements.";
    const std::string created = trim(r.text("ctime"));
    double created_s = 0;
    if (sdn_time::parse_iso(created, &created_s)) omm.CREATION_DATE = sdn_time::format_iso_micro(static_cast<int64_t>(std::llround(created_s)) * 1000000LL).substr(0, 19);
    omm.CENTER_NAME = "EARTH";
    omm.REFERENCE_FRAME = std::make_unique<RFMT>();
    CelestialFrameWrapperT wrapper;
    wrapper.frame = CelestialFrame::TEMEOFDATE;
    omm.REFERENCE_FRAME->REFERENCE_FRAME.Set(std::move(wrapper));
    omm.TIME_SYSTEM = timingStandard::UTC;
    omm.MEAN_ELEMENT_THEORY = meanElementSource::SGP4;
    omm.EPOCH = sdn_time::format_iso_micro(t.epoch_micro);
    omm.MEAN_MOTION = t.mean_motion;
    omm.ECCENTRICITY = t.ecc;
    omm.INCLINATION = t.inc;
    omm.RA_OF_ASC_NODE = t.raan;
    omm.ARG_OF_PERICENTER = t.argp;
    omm.MEAN_ANOMALY = t.ma;
    omm.CLASSIFICATION_TYPE = t.classification;
    omm.BSTAR = t.bstar;
    omm.MEAN_MOTION_DOT = t.ndot;
    omm.MEAN_MOTION_DDOT = t.nddot;
    omm.ELEMENT_SET_NO = t.element_set;
    omm.REV_AT_EPOCH = t.rev;
    omm.EPHEMERIS_TYPE = ephemerisFormat::SGP;  // TLE type 0, as data-source/celestrak-parser maps it
    if (norad) omm.NORAD_CAT_ID = static_cast<uint32_t>(norad);
    else {
      omm.USER_DEFINED_OBJECT_DESIGNATOR = "aoe:" + native_id;
      ++counters.without_norad;
    }
    const std::string channel = upper(trim(r.text("channel")));
    if (!channel.empty()) add_param(&omm, "AOE_CHANNEL", channel);
    if (record_id) add_param(&omm, "AOE_RECORD_ID", std::to_string(record_id));
    if (cat_id) add_param(&omm, "AOE_CAT_ID", std::to_string(cat_id));
    if (sat_id) add_param(&omm, "AOE_SAT_ID", std::to_string(sat_id));
    if (!trim(r.text("lastUpdateId")).empty()) add_param(&omm, "AOE_LAST_UPDATE_ID", trim(r.text("lastUpdateId")));
    if (!trim(r.text("objectType")).empty()) add_param(&omm, "AOE_OBJECT_TYPE", trim(r.text("objectType")));
    flatbuffers::FlatBufferBuilder fbb(1024);
    FinishSizePrefixedOMMBuffer(fbb, CreateOMM(fbb, &omm));
    if (output.size() + fbb.GetSize() > kMaxBytes) {
      oversize = true;
      return false;
    }
    output.insert(output.end(), fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
    ++counters.emitted;
    if (t.alpha5) ++counters.alpha5;
    if (!t.checksums) ++counters.checksum_mismatches;
    // The crosswalk keeps what AOE states about each object, from its newest set; two sets that state different
    // numbers or designators for one AOE id are a conflict, listed and not resolved.
    const uint64_t key = cat_id ? cat_id : sat_id ? sat_id : norad;
    Object o{cat_id, norad, sat_id, cospar(designator) ? designator : std::string(), omm.OBJECT_NAME, trim(r.text("objectType")), channel, t.epoch_micro, record_id};
    auto found = objects.find(key);
    if (found == objects.end()) objects.emplace(key, o);
    else {
      if (found->second.norad != o.norad || found->second.cospar != o.cospar || found->second.sat_id != o.sat_id) conflicting.insert(key);
      if (o.epoch_micro >= found->second.epoch_micro) found->second = o;
    }
    return true;
  };
  if (!flatjson::for_each_record(reinterpret_cast<const char*>(input->payload), input->payload_length, on_record, &error)) {
    return fail("invalid-aoe-source", oversize ? "The $OMM output exceeds its byte budget." : error);
  }
  if (counters.emitted == 0) return fail("invalid-aoe-source", "No AOE element set could be read.");
  Json reasons = Json::object();
  for (const auto& entry : counters.reasons) reasons[entry.first] = entry.second;
  Json rows = Json::array();
  for (const auto& entry : objects) {
    const Object& o = entry.second;
    rows.push_back({"aoe:" + std::to_string(entry.first), o.cat_id ? Json(o.cat_id) : Json(nullptr), o.norad ? Json(o.norad) : Json(nullptr), o.sat_id ? Json(o.sat_id) : Json(nullptr),
                    o.cospar.empty() ? Json(nullptr) : Json(o.cospar), o.name, o.type, o.channel});
  }
  Json conflicts = Json::array();
  for (uint64_t key : conflicting) conflicts.push_back("aoe:" + std::to_string(key));
  const Json report = {{"version", 1}, {"source", "spacemapper-aoe"}, {"records", counters.read}, {"emitted", counters.emitted}, {"duplicateRecordIds", counters.duplicates},
                       {"rejected", counters.rejected}, {"rejections", reasons}, {"rejectionExamples", counters.examples}, {"alpha5CatalogNumbers", counters.alpha5},
                       {"checksumMismatches", counters.checksum_mismatches}, {"withoutNoradNumber", counters.without_norad}, {"objects", objects.size()}};
  // The ids AOE states, as candidates: an AOE id is AOE's own, and a number it gives is a claim, never a join.
  const Json crosswalk = {{"version", 1}, {"source", "spacemapper-aoe"}, {"kind", "id-crosswalk"}, {"status", "candidate"},
                          {"columns", {"native", "catId", "noradId", "satId", "cospar", "name", "objectType", "channel"}}, {"objects", rows}, {"conflicts", conflicts}};
  const std::string report_text = report.dump(), crosswalk_text = crosswalk.dump();
  if (plugin_push_output_ex("report", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1, reinterpret_cast<const uint8_t*>(report_text.data()),
                            static_cast<uint32_t>(report_text.size())) < 0 ||
      plugin_push_output_ex("crosswalk", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1, reinterpret_cast<const uint8_t*>(crosswalk_text.data()),
                            static_cast<uint32_t>(crosswalk_text.size())) < 0) {
    return 1;
  }
  return plugin_push_output_ex("omm", "OMM.fbs", "$OMM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "OMM", 0, 0, output.data(), static_cast<uint32_t>(output.size())) < 0 ? 1 : 0;
}
